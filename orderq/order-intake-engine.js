import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso,
  normalizeText
} from './orderq-db.js';

export const MATCH_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  MATCH_FAILED: 'MATCH_FAILED',
  EXCLUDED: 'EXCLUDED',
  CANCELLED: 'CANCELLED'
});

export const ORDER_STATUS = Object.freeze({
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

const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('oneapp-orderq-orders') : null;

function broadcast(type, order) {
  try { channel?.postMessage({ type, orderId: order.orderId, revision: order.revision, updatedAt: order.updatedAt }); } catch (_) {}
}

function summarizeStatus(items) {
  const active = items.filter(item => item.matchStatus !== MATCH_STATUS.CANCELLED && item.matchStatus !== MATCH_STATUS.EXCLUDED);
  if (!active.length) return ORDER_STATUS.MATCH_FAILED;
  const matched = active.filter(item => item.matchStatus === MATCH_STATUS.MATCHED).length;
  const failed = active.filter(item => item.matchStatus === MATCH_STATUS.MATCH_FAILED).length;
  if (matched && failed) return ORDER_STATUS.PARTIAL;
  if (failed && !matched) return ORDER_STATUS.MATCH_FAILED;
  return ORDER_STATUS.CONFIRMED;
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
  const hasProductIdentity = Boolean(itemCode && itemName);
  const requestedStatus = input.matchStatus;
  const matchStatus = requestedStatus === MATCH_STATUS.EXCLUDED
    ? MATCH_STATUS.EXCLUDED
    : (hasProductIdentity ? MATCH_STATUS.MATCHED : MATCH_STATUS.MATCH_FAILED);

  return {
    orderItemId: previous?.orderItemId || input.orderItemId || newId('OI'),
    orderId,
    lineNo: Number(input.lineNo) || 0,
    productId: input.productId || (itemCode ? `CODE:${itemCode}` : null),
    itemCode,
    itemName,
    specification: String(input.specification ?? '').trim(),
    rawText: String(input.rawText ?? '').trim(),
    rawQuantity: asNumberOrNull(input.rawQuantity ?? quantity),
    rawUnit,
    finalQuantity: asNumberOrNull(input.finalQuantity ?? quantity),
    finalUnit,
    price: asNumberOrNull(input.price),
    supplyAmount: asNumberOrNull(input.supplyAmount),
    memo: String(input.memo ?? '').trim(),
    description: String(input.description ?? '').trim(),
    noticePrice: asNumberOrNull(input.noticePrice),
    matchStatus,
    matchSource: input.matchSource || (hasProductIdentity ? 'MANUAL' : 'UNRESOLVED'),
    updatedAt: nowIso(),
    createdAt: previous?.createdAt || nowIso()
  };
}

async function resolveCustomerInTransaction(tx, customerInput) {
  const customerName = String(customerInput.customerName ?? '').trim();
  if (!customerName) throw new Error('거래처를 입력하세요.');

  const customerStore = tx.objectStore(STORE.CUSTOMERS);
  const aliasStore = tx.objectStore(STORE.CUSTOMER_ALIASES);
  const normalizedName = normalizeText(customerName);

  if (customerInput.customerId) {
    const existing = await requestToPromise(customerStore.get(customerInput.customerId));
    if (existing && existing.normalizedName === normalizedName) return existing;
  }

  const byName = customerStore.index('byName');
  const sameName = await requestToPromise(byName.get(normalizedName));
  if (sameName) return sameName;

  const customerId = newId('CUS');
  const timestamp = nowIso();
  const customer = {
    customerId,
    customerName,
    normalizedName,
    erpCustomerCode: String(customerInput.erpCustomerCode ?? '').trim(),
    status: 'ACTIVE',
    source: 'MANUAL',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  customerStore.add(customer);
  aliasStore.add({
    mappingId: newId('CAM'),
    rawText: customerName,
    normalizedText: normalizedName,
    customerId,
    sourceType: 'MANUAL',
    sourceId: '',
    confirmed: true,
    useCount: 1,
    lastUsedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return customer;
}

function enqueue(tx, entityType, entityId, operation, revision, payload) {
  tx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: newId('SQ'),
    entityType,
    entityId,
    operation,
    revision,
    payload,
    status: 'PENDING',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
}

function appendEvent(tx, order, eventType, detail = {}) {
  tx.objectStore(STORE.ORDER_EVENTS).add({
    eventId: newId('OE'),
    orderId: order.orderId,
    revision: order.revision,
    eventType,
    actor: 'LOCAL_USER',
    detail,
    createdAt: nowIso()
  });
}

export async function createOrder(payload) {
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.ORDERS, STORE.ORDER_ITEMS,
    STORE.ORDER_EVENTS, STORE.SYNC_QUEUE
  ], 'readwrite');

  try {
    const customer = await resolveCustomerInTransaction(tx, payload);
    const orderId = newId('ORD');
    const items = (payload.items || [])
      .filter(item => item.itemCode || item.itemName || item.quantity || item.rawText)
      .map((item, index) => normalizeItem({ ...item, lineNo: index + 1 }, orderId));

    if (!items.length) throw new Error('주문상품을 1개 이상 입력하세요.');

    const timestamp = nowIso();
    const order = {
      orderId,
      revision: 1,
      orderDate: payload.orderDate,
      customerId: customer.customerId,
      customerName: customer.customerName,
      warehouse: String(payload.warehouse ?? '').trim(),
      orderMessage: String(payload.orderMessage ?? '').trim(),
      transactionType: String(payload.transactionType ?? '').trim(),
      sourceType: payload.sourceType || 'MANUAL',
      sourceId: payload.sourceId || '',
      status: summarizeStatus(items),
      matchedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCHED).length,
      matchFailedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCH_FAILED).length,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    tx.objectStore(STORE.ORDERS).add(order);
    const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
    items.forEach(item => itemStore.add(item));
    appendEvent(tx, order, 'ORDER_CREATED', { sourceType: order.sourceType, itemCount: items.length });
    enqueue(tx, 'ORDER', orderId, 'UPSERT', order.revision, { order, items });

    await transactionDone(tx);
    broadcast('ORDER_CREATED', order);
    return { order, items, customer };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export async function updateOrder(orderId, expectedRevision, payload) {
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.ORDERS, STORE.ORDER_ITEMS,
    STORE.ORDER_EVENTS, STORE.SYNC_QUEUE
  ], 'readwrite');

  try {
    const orderStore = tx.objectStore(STORE.ORDERS);
    const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
    const existing = await requestToPromise(orderStore.get(orderId));
    if (!existing) throw new Error('주문을 찾을 수 없습니다.');
    if (existing.revision !== expectedRevision) throw new OrderRevisionConflictError(existing);
    if (existing.status === ORDER_STATUS.CANCELLED) throw new Error('취소된 주문은 수정할 수 없습니다.');

    const customer = await resolveCustomerInTransaction(tx, payload);
    const oldItems = await requestToPromise(itemStore.index('byOrderId').getAll(orderId));
    const oldById = new Map(oldItems.map(item => [item.orderItemId, item]));
    const items = (payload.items || [])
      .filter(item => item.itemCode || item.itemName || item.quantity || item.rawText)
      .map((item, index) => normalizeItem({ ...item, lineNo: index + 1 }, orderId, oldById.get(item.orderItemId)));
    if (!items.length) throw new Error('주문상품을 1개 이상 입력하세요.');

    oldItems.forEach(item => itemStore.delete(item.orderItemId));
    items.forEach(item => itemStore.put(item));

    const next = {
      ...existing,
      revision: existing.revision + 1,
      orderDate: payload.orderDate,
      customerId: customer.customerId,
      customerName: customer.customerName,
      warehouse: String(payload.warehouse ?? '').trim(),
      orderMessage: String(payload.orderMessage ?? '').trim(),
      transactionType: String(payload.transactionType ?? '').trim(),
      status: summarizeStatus(items),
      matchedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCHED).length,
      matchFailedCount: items.filter(item => item.matchStatus === MATCH_STATUS.MATCH_FAILED).length,
      updatedAt: nowIso()
    };
    orderStore.put(next);
    appendEvent(tx, next, 'ORDER_UPDATED', { fromRevision: expectedRevision, itemCount: items.length });
    enqueue(tx, 'ORDER', orderId, 'UPSERT', next.revision, { order: next, items });

    await transactionDone(tx);
    broadcast('ORDER_UPDATED', next);
    return { order: next, items, customer };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export async function cancelOrder(orderId, expectedRevision) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  try {
    const orderStore = tx.objectStore(STORE.ORDERS);
    const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
    const existing = await requestToPromise(orderStore.get(orderId));
    if (!existing) throw new Error('주문을 찾을 수 없습니다.');
    if (existing.revision !== expectedRevision) throw new OrderRevisionConflictError(existing);
    if (existing.status === ORDER_STATUS.CANCELLED) return { order: existing, items: [] };

    const items = await requestToPromise(itemStore.index('byOrderId').getAll(orderId));
    const timestamp = nowIso();
    const cancelledItems = items.map(item => ({ ...item, matchStatus: MATCH_STATUS.CANCELLED, updatedAt: timestamp }));
    cancelledItems.forEach(item => itemStore.put(item));

    const next = { ...existing, revision: existing.revision + 1, status: ORDER_STATUS.CANCELLED, updatedAt: timestamp };
    orderStore.put(next);
    appendEvent(tx, next, 'ORDER_CANCELLED', { fromRevision: expectedRevision });
    enqueue(tx, 'ORDER', orderId, 'UPSERT', next.revision, { order: next, items: cancelledItems });
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
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS], 'readonly');
  const order = await requestToPromise(tx.objectStore(STORE.ORDERS).get(orderId));
  if (!order) {
    await transactionDone(tx);
    return null;
  }
  const items = await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).index('byOrderId').getAll(orderId));
  await transactionDone(tx);
  items.sort((a, b) => (a.lineNo || 0) - (b.lineNo || 0));
  return { order, items };
}

export async function listOrders() {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.ORDERS, 'readonly');
  const orders = await requestToPromise(tx.objectStore(STORE.ORDERS).getAll());
  await transactionDone(tx);
  return orders.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function subscribeOrderChanges(listener) {
  if (!channel) return () => {};
  const handler = event => listener(event.data);
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}
