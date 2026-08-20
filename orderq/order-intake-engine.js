import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso,
  normalizeText
} from './orderq-db.js?v=0.8.0';
import { resolveWarehouseInTransaction, warehouseSnapshot } from './warehouse-master.js?v=0.8.0';
import {
  ORDER_STATUS, ADMIN_STATUS, OPS_STATUS, INPUT_CHANNEL,
  normalizeOrderStatus, normalizeAdminStatus, normalizeOpsStatus, inferInputChannel,
  initialAdminStatus,
  orderDateKey, formatOrderNo, orderSequenceFromNo, assigneeIdentity, externalOrderSnapshot,
  normalizedOrderView, documentFieldChanges, orderItemChanges,
  orderIntakeProvenanceSnapshot, orderItemIdentitySnapshot
} from './order-document-model.js?v=0.8.0';
import { deriveOrderLifecycle, TRANSFER_EVENT_TYPE } from './order-fulfillment-lifecycle.js?v=0.8.0';
import { INTAKE_CONTRACT_VERSION, PRODUCT_IDENTITY_STATUS } from './orderq-v8-contracts.js?v=0.11.0';
import {
  buildOrderSourceDocumentCanonicalProjection,
  canonicalStringify
} from './intake-identity.js?v=0.11.0';

export { ORDER_STATUS, ADMIN_STATUS, OPS_STATUS, INPUT_CHANNEL };

export const MATCH_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  MATCH_FAILED: 'MATCH_FAILED',
  EXCLUDED: 'EXCLUDED',
  CANCELLED: 'CANCELLED'
});

export const MATCHING_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  PARTIAL: 'PARTIAL',
  MATCH_FAILED: 'MATCH_FAILED',
  CANCELLED: 'CANCELLED'
});

export class OrderRevisionConflictError extends Error {
  constructor(latestOrder) {
    super('이 주문은 다른 곳에서 이미 수정되었습니다. 최신 내용을 확인한 후 다시 저장해 주세요.');
    this.name = 'OrderRevisionConflictError';
    this.code = 'ORDER_REVISION_CONFLICT';
    this.latestOrder = latestOrder;
  }
}

export class DuplicateSourceMessageError extends Error {
  constructor(existingOrder) {
    super('이미 처리한 원문입니다. 기존 주문을 확인해 주세요.');
    this.name = 'DuplicateSourceMessageError';
    this.code = 'ORDER_SOURCE_MESSAGE_DUPLICATE';
    this.existingOrder = existingOrder;
  }
}

export class IntakeDocumentIdempotencyConflictError extends Error {
  constructor(existingOrder) {
    super('같은 원본 전표키에 서로 다른 주문내용이 요청되었습니다.');
    this.name = 'IntakeDocumentIdempotencyConflictError';
    this.code = 'ORDERQ_INTAKE_DOCUMENT_IDEMPOTENCY_CONFLICT';
    this.existingOrder = existingOrder;
  }
}

const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('oneapp-orderq-orders') : null;

function broadcast(type, order) {
  try { channel?.postMessage({ type, orderId: order.orderId, revision: order.revision, updatedAt: order.updatedAt }); } catch (_) {}
}

function summarizeStatus(items) {
  const active = items.filter(item => item.matchStatus !== MATCH_STATUS.CANCELLED && item.matchStatus !== MATCH_STATUS.EXCLUDED);
  if (!active.length) return MATCHING_STATUS.MATCH_FAILED;
  const matched = active.filter(item => item.matchStatus === MATCH_STATUS.MATCHED).length;
  const failed = active.filter(item => item.matchStatus === MATCH_STATUS.MATCH_FAILED).length;
  if (matched && failed) return MATCHING_STATUS.PARTIAL;
  if (failed && !matched) return MATCHING_STATUS.MATCH_FAILED;
  return MATCHING_STATUS.CONFIRMED;
}

function asNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeItem(input, orderId, previous = null) {
  const itemCode = String(input.itemCode ?? '').trim();
  const itemName = String(input.itemName ?? '').trim();
  const quantity = asNumberOrNull(input.quantity);
  const rawUnit = String(input.rawUnit ?? '').trim();
  const finalUnit = String(input.finalUnit ?? rawUnit).trim();
  const requestedProductId = String(input.productId ?? '').trim();
  const productId = requestedProductId && !requestedProductId.startsWith('CODE:') ? requestedProductId : null;
  const hasProductIdentity = Boolean(productId && itemCode && itemName);
  const requestedStatus = input.matchStatus;
  const matchStatus = requestedStatus === MATCH_STATUS.EXCLUDED
    ? MATCH_STATUS.EXCLUDED
    : (hasProductIdentity ? MATCH_STATUS.MATCHED : MATCH_STATUS.MATCH_FAILED);
  const identity = orderItemIdentitySnapshot(input, hasProductIdentity);
  if (identity.productIdentityStatus === PRODUCT_IDENTITY_STATUS.TEMPORARY_CONFIRMED) {
    if (!itemName) throw new Error('ORDERQ_INTAKE_TEMPORARY_NAME_REQUIRED');
    if (productId || itemCode) throw new Error('ORDERQ_INTAKE_TEMPORARY_MASTER_IDENTITY_FORBIDDEN');
    if (identity.reviewStatus !== 'CONFIRMED') throw new Error('ORDERQ_INTAKE_TEMPORARY_REVIEW_REQUIRED');
  }

  return {
    orderItemId: previous?.orderItemId || input.orderItemId || newId('OI'),
    orderId,
    lineNo: Number(input.lineNo) || 0,
    productId,
    itemCode,
    itemName,
    specification: String(input.specification ?? '').trim(),
    rawText: String(input.rawText ?? '').trim(),
    rawQuantity: asNumberOrNull(input.rawQuantity ?? quantity),
    rawUnit,
    finalQuantity: asNumberOrNull(input.finalQuantity ?? quantity),
    finalUnit,
    boxQuantity: asNumberOrNull(input.boxQuantity),
    price: asNumberOrNull(input.price),
    priceType: String(input.priceType ?? '').trim(),
    supplyAmount: asNumberOrNull(input.supplyAmount),
    vatAmount: asNumberOrNull(input.vatAmount),
    memo: String(input.memo ?? '').trim(),
    description: String(input.description ?? '').trim(),
    noticePrice: asNumberOrNull(input.noticePrice),
    matchStatus,
    ...identity,
    matchSource: input.matchSource || (hasProductIdentity ? 'MASTER_SELECTED' : 'UNRESOLVED'),
    updatedAt: nowIso(),
    createdAt: previous?.createdAt || nowIso()
  };
}

function enqueue(tx, entityType, entityId, operation, revision, payload, baseRevision = 0) {
  tx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: newId('SQ'),
    entityType,
    entityId,
    operation,
    revision,
    baseRevision,
    payload,
    status: 'PENDING',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
}

async function resolveCustomerInTransaction(tx, customerInput) {
  const customerName = String(customerInput.customerName ?? '').trim();
  if (!customerName) throw new Error('거래처를 입력하세요.');

  const customerStore = tx.objectStore(STORE.CUSTOMERS);
  const aliasStore = tx.objectStore(STORE.CUSTOMER_ALIASES);
  const normalizedName = normalizeText(customerName);

  if (customerInput.customerId) {
    let existing = await requestToPromise(customerStore.get(customerInput.customerId));
    if (existing?.qualityStatus === 'SUPERSEDED') {
      existing = await requestToPromise(customerStore.get(existing.canonicalCustomerId || existing.supersededByCustomerId));
    }
    if (existing?.status === 'ACTIVE') return existing;
  }

  const byName = customerStore.index('byName');
  let sameName = await requestToPromise(byName.get(normalizedName));
  if (sameName?.qualityStatus === 'SUPERSEDED') {
    sameName = await requestToPromise(customerStore.get(sameName.canonicalCustomerId || sameName.supersededByCustomerId));
  }
  if (sameName?.status === 'ACTIVE') return sameName;
  throw new Error('미등록 거래처입니다. 거래처 찾기 / 간편등록으로 등록 후 계속해 주세요.');
}

function summarizeAmounts(items) {
  const supplyAmountTotal = items.reduce((sum, item) => {
    const amount = asNumberOrNull(item.supplyAmount);
    return sum + (amount ?? (Number(item.finalQuantity || item.rawQuantity || 0) * Number(item.price || 0)));
  }, 0);
  const vatAmountTotal = items.reduce((sum, item) => sum + Number(item.vatAmount || 0), 0);
  return { supplyAmountTotal, vatAmountTotal, orderAmount: supplyAmountTotal + vatAmountTotal };
}

function summarizeDocumentItems(items = []) {
  const visibleItems = items
    .filter(item => item.matchStatus !== MATCH_STATUS.EXCLUDED)
    .sort((left, right) => Number(left.lineNo || 0) - Number(right.lineNo || 0));
  return {
    itemCount: visibleItems.length,
    representativeItemName: String(visibleItems[0]?.itemName || visibleItems[0]?.itemCode || '').trim(),
    totalQuantity: visibleItems.reduce((sum, item) => sum + Number(item.finalQuantity ?? item.rawQuantity ?? 0), 0)
  };
}

async function allocateOrderNoInTransaction(tx, orderDate, requestedOrderNo = '') {
  const requested = String(requestedOrderNo || '').trim();
  if (requested) return requested;
  const dateKey = orderDateKey(orderDate);
  const metaStore = tx.objectStore(STORE.META);
  const orderStore = tx.objectStore(STORE.ORDERS);
  const counterKey = `orderNoSequence:${dateKey}`;
  const counter = await requestToPromise(metaStore.get(counterKey));
  const existing = await requestToPromise(orderStore.index('byOrderNo').getAll());
  const highestExisting = existing.reduce((highest, order) => Math.max(highest, orderSequenceFromNo(order.orderNo, dateKey)), 0);
  const sequence = Math.max(Number(counter?.value) || 0, highestExisting) + 1;
  metaStore.put({ key: counterKey, value: sequence, updatedAt: nowIso() });
  return formatOrderNo(dateKey, sequence);
}

function orderWorkflowSnapshot(payload, previous = null) {
  const sourceType = String(payload.sourceType || previous?.sourceType || 'MANUAL').trim();
  const inputChannel = inferInputChannel(sourceType, payload.inputChannel || previous?.inputChannel);
  const assignee = assigneeIdentity(payload.assigneeName, payload.assigneeId, previous);
  return {
    ...assignee,
    orderStatus: normalizeOrderStatus(payload.orderStatus, previous?.orderStatus || previous?.status),
    adminStatus: normalizeAdminStatus(payload.adminStatus || previous?.adminStatus || initialAdminStatus(sourceType, inputChannel)),
    opsStatus: normalizeOpsStatus(payload.opsStatus || previous?.opsStatus),
    inputChannel,
    deliveryExpectedDate: Object.prototype.hasOwnProperty.call(payload, 'deliveryExpectedDate')
      ? String(payload.deliveryExpectedDate || '').trim()
      : String(previous?.deliveryExpectedDate || '').trim(),
    ...externalOrderSnapshot(payload, previous || {})
  };
}

function appendEvent(tx, order, eventType, detail = {}) {
  const event = {
    eventId: newId('OE'),
    orderId: order.orderId,
    revision: order.revision,
    eventType,
    actor: String(detail.actor || 'LOCAL_USER'),
    detail,
    createdAt: nowIso()
  };
  tx.objectStore(STORE.ORDER_EVENTS).add(event);
  return event;
}

function appendLifecycleTransition(tx, beforeOrder, beforeItems, afterOrder, afterItems, existingEvents, causeEvent, actor) {
  const beforeStatus = deriveOrderLifecycle(beforeOrder, beforeItems, existingEvents).operationStatus;
  const afterStatus = deriveOrderLifecycle(afterOrder, afterItems, existingEvents).operationStatus;
  if (beforeStatus === afterStatus) return null;
  const closed = afterStatus === OPS_STATUS.CLOSED;
  return appendEvent(tx, afterOrder, closed ? TRANSFER_EVENT_TYPE.CLOSED : TRANSFER_EVENT_TYPE.REOPENED, {
    actor,
    reason: closed ? '모든 유효 주문상품 이관 완료' : '주문·보류·취소 변경으로 미출고 재발생',
    causeEventId: causeEvent?.eventId || '',
    beforeStatus,
    afterStatus
  });
}

export async function createOrder(payload) {
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.WAREHOUSES, STORE.WAREHOUSE_ALIASES, STORE.ORDERS, STORE.ORDER_ITEMS,
    STORE.ORDER_EVENTS, STORE.SYNC_QUEUE, STORE.META,
    ...(payload.intakeCommit ? [STORE.INTAKE_SESSIONS, STORE.INTAKE_DOCUMENTS, STORE.INTAKE_LINES, STORE.INTAKE_EVENTS] : [])
  ], 'readwrite');

  try {
    const customer = await resolveCustomerInTransaction(tx, payload);
    const warehouse = await resolveWarehouseInTransaction(tx, payload, { sourceType: payload.sourceType || 'MANUAL' });
    const orderStore = tx.objectStore(STORE.ORDERS);
    const sourceMessageKey = String(payload.sourceMessageKey || '').trim();
    const sourceDocumentKey = String(payload.sourceDocumentKey || '').trim();
    if (!sourceDocumentKey && sourceMessageKey) {
      const existingSourceOrder = await requestToPromise(orderStore.index('bySourceMessageKey').get(sourceMessageKey));
      if (existingSourceOrder) throw new DuplicateSourceMessageError(existingSourceOrder);
    }
    const orderId = newId('ORD');
    let items = (payload.items || [])
      .filter(item => item.itemCode || item.itemName || item.quantity || item.rawText)
      .map((item, index) => normalizeItem({ ...item, lineNo: index + 1 }, orderId));

    if (!items.length) throw new Error('주문상품을 1개 이상 입력하세요.');

    const timestamp = nowIso();
    const workflow = orderWorkflowSnapshot(payload);
    if (workflow.orderStatus === ORDER_STATUS.FULL_CANCEL) {
      items = items.map(item => ({ ...item, matchStatus: MATCH_STATUS.CANCELLED, updatedAt: timestamp }));
    }
    const matchingStatus = workflow.orderStatus === ORDER_STATUS.FULL_CANCEL ? MATCHING_STATUS.CANCELLED : summarizeStatus(items);
    let order = {
      orderId,
      orderNo: String(payload.orderNo || '').trim(),
      revision: 1,
      orderDate: payload.orderDate,
      customerId: customer.customerId,
      customerName: customer.customerName,
      ...warehouseSnapshot(payload, warehouse),
      orderMessage: String(payload.orderMessage ?? '').trim(),
      transactionType: String(payload.transactionType ?? '').trim(),
      sourceType: payload.sourceType || 'MANUAL',
      sourceId: payload.sourceId || '',
      sourceMessageKey: sourceMessageKey || undefined,
      ...orderIntakeProvenanceSnapshot({
        ...payload,
        sourceDocumentKey,
        intakeContractVersion: payload.intakeContractVersion || (sourceDocumentKey ? INTAKE_CONTRACT_VERSION : '')
      }),
      ...workflow,
      status: matchingStatus,
      matchingStatus,
      ...summarizeAmounts(items),
      matchedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCHED).length,
      matchFailedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCH_FAILED).length,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    if (sourceDocumentKey) {
      const existingSourceOrder = await requestToPromise(orderStore.index('bySourceDocumentKey').get(sourceDocumentKey));
      if (existingSourceOrder) {
        const existingItems = await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).index('byOrderId').getAll(existingSourceOrder.orderId));
        const existingCanonical = canonicalStringify(buildOrderSourceDocumentCanonicalProjection({
          order: existingSourceOrder,
          items: existingItems
        }));
        const requestedCanonical = canonicalStringify(buildOrderSourceDocumentCanonicalProjection({ order, items }));
        if (existingCanonical !== requestedCanonical) throw new IntakeDocumentIdempotencyConflictError(existingSourceOrder);
        await new Promise((resolve, reject) => {
          tx.addEventListener('abort', () => resolve(), { once: true });
          try { tx.abort(); } catch (error) { reject(error); }
        });
        return { order: existingSourceOrder, items: existingItems, customer, warehouse, duplicate: true };
      }
    }

    order.orderNo = await allocateOrderNoInTransaction(tx, payload.orderDate, payload.orderNo);
    order = { ...order, opsStatus: deriveOrderLifecycle(order, items, []).operationStatus };

    await requestToPromise(orderStore.add(order));
    const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
    for (const item of items) await requestToPromise(itemStore.add(item));
    const event = appendEvent(tx, order, 'ORDER_CREATED', {
      sourceType: order.sourceType,
      inputChannel: order.inputChannel,
      orderNo: order.orderNo,
      itemCount: items.length,
      actor: payload.actorName || 'LOCAL_USER'
    });
    const transition = appendLifecycleTransition(
      tx,
      { ...order, orderStatus: ORDER_STATUS.ORDER, adminStatus: ADMIN_STATUS.HOLD },
      [],
      order,
      items,
      [],
      event,
      payload.actorName || 'LOCAL_USER'
    );
    enqueue(tx, 'ORDER', orderId, 'UPSERT', order.revision, { order, items }, 0);
    enqueue(tx, 'ORDER_EVENT', event.eventId, 'UPSERT', event.revision, event, 0);
    if (transition) enqueue(tx, 'ORDER_EVENT', transition.eventId, 'UPSERT', transition.revision, transition, 0);

    if (payload.intakeCommit) {
      const commit = payload.intakeCommit;
      if (commit.injectFailureAt === 'ORDER_WRITTEN') throw new Error('ORDERQ_INTAKE_INJECTED_FAILURE:ORDER_WRITTEN');
      const sessions = tx.objectStore(STORE.INTAKE_SESSIONS), documents = tx.objectStore(STORE.INTAKE_DOCUMENTS);
      const session = await requestToPromise(sessions.get(commit.intakeSessionId));
      const document = await requestToPromise(documents.get(commit.intakeDocumentId));
      if (!session || !document) throw new Error('ORDERQ_INTAKE_DOCUMENT_NOT_FOUND');
      if (Number(document.revision || 0) !== Number(commit.expectedRevision || 0)) throw new Error('ORDERQ_INTAKE_REVISION_CONFLICT');
      const intakeLines = await requestToPromise(tx.objectStore(STORE.INTAKE_LINES).index('byDocument').getAll(document.intakeDocumentId));
      const active = intakeLines.filter(line => line.reviewStatus !== 'EXCLUDED' && line.matchStatus !== 'EXCLUDED');
      if (!active.length || active.some(line => line.reviewStatus !== 'CONFIRMED' || !['MASTER_LINKED','TEMPORARY_CONFIRMED'].includes(line.productIdentityStatus))) throw new Error('ORDERQ_INTAKE_REVIEW_INCOMPLETE');
      const committedAt = nowIso(), actorId = commit.actor?.actorId || 'LOCAL_USER';
      documents.put({ ...document, stage:'COMMITTED', reviewStatus:'CONFIRMED', orderId, revision:Number(document.revision||0)+1, updatedBy:actorId, updatedAt:committedAt });
      sessions.put({ ...session, stage:'COMMITTED', status:'COMMITTED', revision:Number(session.revision||0)+1, updatedBy:actorId, updatedAt:committedAt });
      tx.objectStore(STORE.INTAKE_EVENTS).add({ eventId:newId('IEV'), intakeSessionId:session.intakeSessionId, intakeDocumentId:document.intakeDocumentId, intakeLineId:'', eventType:'INTAKE_ORDER_COMMITTED', reasonCode:'SINGLE_DOCUMENT_ORDER_SAVED', before:{stage:document.stage}, after:{stage:'COMMITTED',orderId}, actorId, actorName:commit.actor?.actorName||'ORDER IN 관리자', occurredAt:committedAt, createdAt:committedAt });
    }

    await transactionDone(tx);
    broadcast('ORDER_CREATED', order);
    return { order, items, customer, warehouse, duplicate: false };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export async function updateOrder(orderId, expectedRevision, payload) {
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.WAREHOUSES, STORE.WAREHOUSE_ALIASES, STORE.ORDERS, STORE.ORDER_ITEMS,
    STORE.ORDER_EVENTS, STORE.SYNC_QUEUE
  ], 'readwrite');

  try {
    const orderStore = tx.objectStore(STORE.ORDERS);
    const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
    const existing = await requestToPromise(orderStore.get(orderId));
    if (!existing) throw new Error('주문을 찾을 수 없습니다.');
    if (existing.revision !== expectedRevision) throw new OrderRevisionConflictError(existing);
    const previousOrder = normalizedOrderView(existing);

    const customer = await resolveCustomerInTransaction(tx, payload);
    const warehouse = await resolveWarehouseInTransaction(tx, payload, { sourceType: payload.sourceType || existing.sourceType || 'MANUAL', sourceId: orderId });
    const [oldItems, existingEvents] = await Promise.all([
      requestToPromise(itemStore.index('byOrderId').getAll(orderId)),
      requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).index('byOrderId').getAll(orderId))
    ]);
    const oldById = new Map(oldItems.map(item => [item.orderItemId, item]));
    let items = (payload.items || [])
      .filter(item => item.itemCode || item.itemName || item.quantity || item.rawText)
      .map((item, index) => normalizeItem({ ...item, lineNo: index + 1 }, orderId, oldById.get(item.orderItemId)));
    if (!items.length) throw new Error('주문상품을 1개 이상 입력하세요.');

    const workflow = orderWorkflowSnapshot(payload, previousOrder);
    if (workflow.orderStatus === ORDER_STATUS.FULL_CANCEL) {
      const timestamp = nowIso();
      items = items.map(item => ({ ...item, matchStatus: MATCH_STATUS.CANCELLED, updatedAt: timestamp }));
    }

    oldItems.forEach(item => itemStore.delete(item.orderItemId));
    items.forEach(item => itemStore.put(item));

    const matchingStatus = workflow.orderStatus === ORDER_STATUS.FULL_CANCEL ? MATCHING_STATUS.CANCELLED : summarizeStatus(items);
    let next = {
      ...existing,
      revision: existing.revision + 1,
      orderDate: payload.orderDate,
      customerId: customer.customerId,
      customerName: customer.customerName,
      ...warehouseSnapshot(payload, warehouse),
      orderMessage: String(payload.orderMessage ?? '').trim(),
      transactionType: String(payload.transactionType ?? '').trim(),
      ...workflow,
      status: matchingStatus,
      matchingStatus,
      ...summarizeAmounts(items),
      matchedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCHED).length,
      matchFailedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCH_FAILED).length,
      updatedAt: nowIso()
    };
    next = { ...next, opsStatus: deriveOrderLifecycle(next, items, existingEvents).operationStatus };
    const documentChanges = documentFieldChanges(previousOrder, next);
    const itemChanges = orderItemChanges(oldItems, items);
    if (previousOrder.orderStatus === ORDER_STATUS.FULL_CANCEL) {
      const allowedCancelledFields = new Set(['assigneeName', 'adminStatus']);
      const prohibitedChanges = documentChanges.filter(change => !allowedCancelledFields.has(change.field));
      if (next.orderStatus !== ORDER_STATUS.FULL_CANCEL || prohibitedChanges.length || itemChanges.length) {
        throw new Error('전체취소된 주문은 담당자와 관리자상태만 변경할 수 있습니다.');
      }
    }
    orderStore.put(next);
    const eventType = previousOrder.orderStatus !== ORDER_STATUS.FULL_CANCEL && next.orderStatus === ORDER_STATUS.FULL_CANCEL
      ? 'ORDER_CANCELLED'
      : 'ORDER_UPDATED';
    const event = appendEvent(tx, next, eventType, {
      fromRevision: expectedRevision,
      itemCount: items.length,
      changes: [...documentChanges, ...itemChanges],
      actor: payload.actorName || 'LOCAL_USER'
    });
    const transition = appendLifecycleTransition(
      tx,
      previousOrder,
      oldItems,
      next,
      items,
      existingEvents,
      event,
      payload.actorName || 'LOCAL_USER'
    );
    enqueue(tx, 'ORDER', orderId, 'UPSERT', next.revision, { order: next, items }, expectedRevision);
    enqueue(tx, 'ORDER_EVENT', event.eventId, 'UPSERT', event.revision, event, 0);
    if (transition) enqueue(tx, 'ORDER_EVENT', transition.eventId, 'UPSERT', transition.revision, transition, 0);

    await transactionDone(tx);
    broadcast('ORDER_UPDATED', next);
    return { order: next, items, customer, warehouse };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export async function cancelOrder(orderId, expectedRevision, actorName = 'LOCAL_USER') {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  try {
    const orderStore = tx.objectStore(STORE.ORDERS);
    const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
    const existing = await requestToPromise(orderStore.get(orderId));
    if (!existing) throw new Error('주문을 찾을 수 없습니다.');
    if (existing.revision !== expectedRevision) throw new OrderRevisionConflictError(existing);
    const previousOrder = normalizedOrderView(existing);
    if (previousOrder.orderStatus === ORDER_STATUS.FULL_CANCEL) return { order: previousOrder, items: [] };

    const [items, existingEvents] = await Promise.all([
      requestToPromise(itemStore.index('byOrderId').getAll(orderId)),
      requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).index('byOrderId').getAll(orderId))
    ]);
    const timestamp = nowIso();
    const cancelledItems = items.map(item => ({ ...item, matchStatus: MATCH_STATUS.CANCELLED, updatedAt: timestamp }));
    cancelledItems.forEach(item => itemStore.put(item));

    let next = {
      ...existing,
      revision: existing.revision + 1,
      orderStatus: ORDER_STATUS.FULL_CANCEL,
      status: MATCHING_STATUS.CANCELLED,
      matchingStatus: MATCHING_STATUS.CANCELLED,
      updatedAt: timestamp
    };
    next = { ...next, opsStatus: deriveOrderLifecycle(next, cancelledItems, existingEvents).operationStatus };
    orderStore.put(next);
    const event = appendEvent(tx, next, 'ORDER_CANCELLED', {
      fromRevision: expectedRevision,
      changes: documentFieldChanges(previousOrder, next),
      actor: actorName || 'LOCAL_USER'
    });
    const transition = appendLifecycleTransition(
      tx,
      previousOrder,
      items,
      next,
      cancelledItems,
      existingEvents,
      event,
      actorName || 'LOCAL_USER'
    );
    enqueue(tx, 'ORDER', orderId, 'UPSERT', next.revision, { order: next, items: cancelledItems }, expectedRevision);
    enqueue(tx, 'ORDER_EVENT', event.eventId, 'UPSERT', event.revision, event, 0);
    if (transition) enqueue(tx, 'ORDER_EVENT', transition.eventId, 'UPSERT', transition.revision, transition, 0);
    await transactionDone(tx);
    broadcast('ORDER_CANCELLED', next);
    return { order: next, items: cancelledItems };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export async function getOrder(orderId) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS], 'readonly');
  const order = await requestToPromise(tx.objectStore(STORE.ORDERS).get(orderId));
  if (!order) {
    await transactionDone(tx);
    return null;
  }
  const items = await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).index('byOrderId').getAll(orderId));
  const events = await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).index('byOrderId').getAll(orderId));
  await transactionDone(tx);
  items.sort((a, b) => (a.lineNo || 0) - (b.lineNo || 0));
  events.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const normalized = normalizedOrderView(order);
  const lifecycle = deriveOrderLifecycle(normalized, items, events);
  return { order: { ...normalized, opsStatus: lifecycle.operationStatus }, items, events, lifecycle };
}

export async function listOrders() {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS], 'readonly');
  const [orders, items, events] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.ORDERS).getAll()),
    requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).getAll()),
    requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).getAll())
  ]);
  await transactionDone(tx);
  const itemsByOrder = new Map();
  const eventsByOrder = new Map();
  items.forEach(item => itemsByOrder.set(item.orderId, [...(itemsByOrder.get(item.orderId) || []), item]));
  events.forEach(event => eventsByOrder.set(event.orderId, [...(eventsByOrder.get(event.orderId) || []), event]));
  return orders
    .map(source => {
      const order = normalizedOrderView(source);
      const orderItems = itemsByOrder.get(order.orderId) || [];
      const lifecycle = deriveOrderLifecycle(order, orderItems, eventsByOrder.get(order.orderId) || []);
      return {
        ...order,
        ...summarizeDocumentItems(orderItems),
        opsStatus: lifecycle.operationStatus,
        transferStatus: lifecycle.transferStatus
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function subscribeOrderChanges(listener) {
  if (!channel) return () => {};
  const handler = event => listener(event.data);
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}
