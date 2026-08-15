import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { CAPABILITY, ERP_POSTING_STATUS, requireCapability } from './orderq-v7-contracts.js?v=0.8.0';
import { inheritedAssigneeSnapshot, normalizedOrderView } from './order-document-model.js?v=0.8.0';
import {
  TRANSFER_EVENT_TYPE,
  createAllocationEvent,
  createReversalEvent,
  deriveOrderLifecycle,
  effectiveOrderQuantity,
  effectiveTransferredQuantity
} from './order-fulfillment-lifecycle.js?v=0.8.0';
import { INVENTORY_MOVEMENT_TYPE, calculateInventoryShadowProjection } from './inventory-ledger.js?v=0.8.0';
import { appendInventoryMovementsInTransaction } from './inventory-ledger-repository.js?v=0.8.0';
import {
  DISPATCH_CONFIRMATION_STEP,
  confirmationCheckpoint,
  dispatchConfirmationFingerprint,
  dispatchReversalFingerprint,
  normalizeDispatchConfirmationCommand,
  normalizeDispatchReversalCommand,
  resolveNormalDispatchActuals
} from './dispatch-confirmation.js?v=0.8.0';

const CONFIRMATION_STORES = Object.freeze([
  STORE.CUSTOMERS,
  STORE.PRODUCTS,
  STORE.WAREHOUSES,
  STORE.ORDERS,
  STORE.ORDER_ITEMS,
  STORE.ORDER_EVENTS,
  STORE.DISPATCH_DECISIONS,
  STORE.DISPATCH_LINES,
  STORE.DISPATCH_STOCK_ALLOCATIONS,
  STORE.INVENTORY_RESERVATIONS,
  STORE.INVENTORY_SNAPSHOTS,
  STORE.INVENTORY_LINES,
  STORE.INVENTORY_MOVEMENTS,
  STORE.DISPATCH_RECONCILIATIONS,
  STORE.SALES_DOCUMENTS,
  STORE.SALES_LINES,
  STORE.META,
  STORE.SYNC_QUEUE
]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function inventoryKey(productId, warehouseId) {
  return `${text(productId)}\u001f${text(warehouseId)}`;
}

async function allFrom(tx, storeName, indexName = '', query = undefined) {
  const store = tx.objectStore(storeName);
  return requestToPromise((indexName ? store.index(indexName) : store).getAll(query));
}

function queueLocalEntity(tx, { entityType, entityId, payload, revision = 1, baseRevision = 0, idempotencyKey }) {
  const timestamp = nowIso();
  const row = {
    queueId: newId('SQ'), entityType, entityId, operation: 'UPSERT',
    revision: Number(revision || 0), baseRevision: Number(baseRevision || 0),
    payload: clone(payload), status: 'LOCAL_ONLY', localOnly: true,
    confirmationIdempotencyKey: idempotencyKey,
    createdAt: timestamp, updatedAt: timestamp
  };
  tx.objectStore(STORE.SYNC_QUEUE).add(row);
  return row;
}

function historyEvent(eventType, actorId, detail, timestamp) {
  return { eventId: newId('DH'), eventType, actorId, detail: clone(detail), createdAt: timestamp };
}

function activeReference(row) {
  return Boolean(row) && row.active !== false && !row.disabledAt && text(row.status).toUpperCase() !== 'INACTIVE';
}

async function loadConfirmationResult(tx, salesDocument, duplicate) {
  const decision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(salesDocument.dispatchId));
  const [salesLines, movements, reservations, reconciliations, outbox] = await Promise.all([
    allFrom(tx, STORE.SALES_LINES, 'byDocumentId', salesDocument.salesDocumentId),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'byDispatchId', salesDocument.dispatchId),
    allFrom(tx, STORE.INVENTORY_RESERVATIONS, 'byDispatchId', salesDocument.dispatchId),
    allFrom(tx, STORE.DISPATCH_RECONCILIATIONS, 'byDispatchId', salesDocument.dispatchId),
    allFrom(tx, STORE.SYNC_QUEUE)
  ]);
  const orderEvents = [];
  for (const orderId of decision?.sourceOrderIds || []) {
    const rows = await allFrom(tx, STORE.ORDER_EVENTS, 'byOrderId', orderId);
    orderEvents.push(...rows.filter(row => row.detail?.salesDocumentId === salesDocument.salesDocumentId || row.detail?.dispatchId === decision.dispatchId));
  }
  return {
    duplicate,
    decision,
    salesDocument,
    salesLines,
    movements,
    reservations,
    orderEvents,
    reconciliations,
    outbox: outbox.filter(row => row.confirmationIdempotencyKey === salesDocument.idempotencyKey)
  };
}

function validateIdempotentResult(existing, command, fingerprint) {
  if (text(existing.dispatchId) !== command.dispatchId || text(existing.confirmationRequestFingerprint) !== fingerprint) {
    throw new Error(`ORDERQ_CONFIRM_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
  }
}

function salesAmount(item, line, actualQuantity) {
  const unitPriceWon = finite(line.unitPriceWon ?? line.orderAgreedUnitPriceWon ?? item.price ?? item.unitPriceWon, 0);
  const supplyAmountWon = Math.round(unitPriceWon * actualQuantity);
  const orderedQuantity = finite(item.finalQuantity ?? item.rawQuantity ?? item.quantity, 0);
  const vatAmountWon = orderedQuantity > 0
    ? Math.round(finite(item.vatAmount, 0) * actualQuantity / orderedQuantity)
    : 0;
  return { unitPriceWon, supplyAmountWon, vatAmountWon };
}

function confirmationEvent(order, before, after, causeEvent, dispatchId, actorId, timestamp) {
  if (before.operationStatus === after.operationStatus) return null;
  const closed = after.operationStatus === 'CLOSED';
  return {
    eventId: `OE-${closed ? 'CLOSE' : 'REOPEN'}-${dispatchId}-${order.orderId}`,
    orderId: order.orderId,
    revision: Number(order.revision || 0),
    eventType: closed ? TRANSFER_EVENT_TYPE.CLOSED : TRANSFER_EVENT_TYPE.REOPENED,
    actor: actorId,
    detail: {
      dispatchId,
      reason: closed ? '출고확정으로 모든 유효 주문상품 이행 완료' : '출고확정 후 미출고 재발생',
      causeEventId: causeEvent?.eventId || '',
      beforeStatus: before.operationStatus,
      afterStatus: after.operationStatus
    },
    createdAt: timestamp
  };
}

async function validateBusinessReferences(tx, decision, actuals) {
  const orderIds = [...new Set(actuals.map(row => text(row.line.orderId)))];
  const itemIds = [...new Set(actuals.map(row => text(row.line.orderItemId)))];
  const productIds = [...new Set(actuals.map(row => text(row.line.actualProductId)))];
  const warehouseIds = [...new Set(actuals.flatMap(row => row.allocations.map(entry => text(entry.allocation.warehouseId))))];
  const [orders, items, products, warehouses, customer] = await Promise.all([
    Promise.all(orderIds.map(id => requestToPromise(tx.objectStore(STORE.ORDERS).get(id)))),
    Promise.all(itemIds.map(id => requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).get(id)))),
    Promise.all(productIds.map(id => requestToPromise(tx.objectStore(STORE.PRODUCTS).get(id)))),
    Promise.all(warehouseIds.map(id => requestToPromise(tx.objectStore(STORE.WAREHOUSES).get(id)))),
    text(decision.customerId) ? requestToPromise(tx.objectStore(STORE.CUSTOMERS).get(decision.customerId)) : Promise.resolve(null)
  ]);
  if (orders.some(row => !row)) throw new Error('ORDERQ_CONFIRM_ORDER_NOT_FOUND');
  if (items.some(row => !row)) throw new Error('ORDERQ_CONFIRM_ORDER_ITEM_NOT_FOUND');
  if (products.some(row => !activeReference(row))) throw new Error('ORDERQ_CONFIRM_PRODUCT_NOT_ACTIVE');
  if (warehouses.some(row => !activeReference(row))) throw new Error('ORDERQ_CONFIRM_WAREHOUSE_NOT_ACTIVE');
  if (decision.customerId && !activeReference(customer)) throw new Error('ORDERQ_CONFIRM_CUSTOMER_NOT_ACTIVE');
  if (orders.some(row => text(row.adminStatus).toUpperCase() === 'HOLD')) throw new Error('ORDERQ_CONFIRM_ORDER_HOLD');

  const orderMap = new Map(orders.map(row => [row.orderId, normalizedOrderView(row)]));
  const itemMap = new Map(items.map(row => [row.orderItemId, row]));
  for (const actual of actuals) {
    const item = itemMap.get(actual.line.orderItemId);
    if (item?.orderId !== actual.line.orderId) throw new Error(`ORDERQ_CONFIRM_ORDER_ITEM_MISMATCH:${actual.line.dispatchLineId}`);
  }
  const eventsByOrder = new Map();
  for (const orderId of orderIds) eventsByOrder.set(orderId, await allFrom(tx, STORE.ORDER_EVENTS, 'byOrderId', orderId));
  const recognizedByItem = new Map();
  for (const actual of actuals) {
    recognizedByItem.set(actual.line.orderItemId, finite(recognizedByItem.get(actual.line.orderItemId)) + actual.recognizedOrderQuantity);
  }
  for (const [orderItemId, recognized] of recognizedByItem) {
    const item = itemMap.get(orderItemId);
    const order = orderMap.get(item.orderId);
    const remaining = effectiveOrderQuantity(order, item) - effectiveTransferredQuantity(orderItemId, eventsByOrder.get(item.orderId));
    if (recognized > remaining + 1e-9) throw new Error(`ORDERQ_CONFIRM_OVER_ORDER_REQUIRES_M5:${orderItemId}`);
  }
  return { orderMap, itemMap, eventsByOrder };
}

async function inventoryProjectionInTransaction(tx) {
  const [snapshots, inventoryLines, movements, reservations, warehouses] = await Promise.all([
    allFrom(tx, STORE.INVENTORY_SNAPSHOTS),
    allFrom(tx, STORE.INVENTORY_LINES),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS),
    allFrom(tx, STORE.INVENTORY_RESERVATIONS),
    allFrom(tx, STORE.WAREHOUSES)
  ]);
  return calculateInventoryShadowProjection({ snapshots, inventoryLines, movements, reservations, warehouses });
}

export async function recordDispatchActual(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_CONFIRM);
  const command = normalizeDispatchConfirmationCommand({ ...source, idempotencyKey: source.idempotencyKey || `ACTUAL_RECORD:${text(source.dispatchId)}:${Number(source.expectedRevision || 0)}` });
  if (!command.lines.length) throw new Error('ORDERQ_ACTUAL_LINE_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction(CONFIRMATION_STORES, 'readwrite');
  try {
    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const decision = await requestToPromise(decisionStore.get(command.dispatchId));
    if (!decision) throw new Error('ORDERQ_ACTUAL_DISPATCH_NOT_FOUND');
    if (!['RELEASED', 'READY_TO_CONFIRM'].includes(text(decision.status).toUpperCase())) throw new Error('ORDERQ_ACTUAL_STATE_INVALID');
    if (Number(decision.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const [lines, allocations, reservations] = await Promise.all([
      allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.INVENTORY_RESERVATIONS, 'byDispatchId', command.dispatchId)
    ]);
    const actuals = resolveNormalDispatchActuals({ lines, allocations, command });
    await validateBusinessReferences(tx, decision, actuals);
    const timestamp = nowIso();
    const activeReservations = new Map(reservations.filter(row => row.status === 'ACTIVE').map(row => [row.reservationId, row]));
    for (const actual of actuals) {
      for (const entry of actual.allocations) {
        const reservation = activeReservations.get(entry.allocation.reservationId);
        if (!reservation || reservation.allocationId !== entry.allocation.allocationId) throw new Error(`ORDERQ_ACTUAL_ACTIVE_RESERVATION_REQUIRED:${entry.allocation.allocationId}`);
        if (text(reservation.expiresAt) && text(reservation.expiresAt) <= timestamp) throw new Error(`ORDERQ_ACTUAL_RESERVATION_EXPIRED:${reservation.reservationId}`);
        if (entry.actualBaseQuantity > finite(reservation.reservedBaseQuantity) + 1e-9) throw new Error(`ORDERQ_ACTUAL_RESERVATION_QUANTITY_EXCEEDED:${reservation.reservationId}`);
      }
    }
    const baseRevision = Number(decision.revision || 0);
    const nextRevision = baseRevision + 1;
    const nextLines = actuals.map(actual => {
      const next = {
        ...actual.line,
        actualQuantity: actual.actualQuantity,
        actualBaseQuantity: actual.actualBaseQuantity,
        recognizedOrderQuantity: actual.recognizedOrderQuantity,
        executionStatus: 'READY_TO_CONFIRM',
        actualRecordedAt: timestamp,
        actualRecordedBy: context.actorId,
        updatedAt: timestamp,
        updatedBy: context.actorId
      };
      tx.objectStore(STORE.DISPATCH_LINES).put(next);
      return next;
    });
    const nextAllocations = actuals.flatMap(actual => actual.allocations.map(entry => {
      const next = {
        ...entry.allocation,
        actualBaseQuantity: entry.actualBaseQuantity,
        status: 'READY_TO_CONFIRM',
        actualRecordedAt: timestamp,
        actualRecordedBy: context.actorId,
        updatedAt: timestamp,
        updatedBy: context.actorId
      };
      tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS).put(next);
      return next;
    }));
    const event = historyEvent('ACTUAL_RECORDED', context.actorId, {
      lines: actuals.map(actual => ({
        dispatchLineId: actual.line.dispatchLineId,
        actualQuantity: actual.actualQuantity,
        recognizedOrderQuantity: actual.recognizedOrderQuantity,
        allocations: actual.allocations.map(entry => ({ allocationId: entry.allocation.allocationId, actualBaseQuantity: entry.actualBaseQuantity }))
      }))
    }, timestamp);
    const nextDecision = {
      ...decision,
      status: 'READY_TO_CONFIRM',
      revision: nextRevision,
      baseRevision,
      readyAt: timestamp,
      actualRecordedAt: timestamp,
      actualRecordedBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [...(Array.isArray(decision.history) ? decision.history : []), event],
      localOnly: true
    };
    decisionStore.put(nextDecision);
    const enqueue = entry => queueLocalEntity(tx, { ...entry, idempotencyKey: command.idempotencyKey });
    nextLines.forEach(row => enqueue({ entityType: 'DISPATCH_LINE', entityId: row.dispatchLineId, payload: row, revision: nextRevision, baseRevision }));
    nextAllocations.forEach(row => enqueue({ entityType: 'DISPATCH_STOCK_ALLOCATION', entityId: row.allocationId, payload: row, revision: nextRevision, baseRevision }));
    enqueue({ entityType: 'DISPATCH_DECISION', entityId: nextDecision.dispatchId, payload: nextDecision, revision: nextRevision, baseRevision });
    await transactionDone(tx);
    return { decision: nextDecision, lines: nextLines, allocations: nextAllocations };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function confirmDispatch(source = {}, actor = 'ADMIN', options = {}) {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_CONFIRM);
  const command = normalizeDispatchConfirmationCommand(source);
  const fingerprint = dispatchConfirmationFingerprint(command);
  const db = await openOrderQDb();
  const tx = db.transaction(CONFIRMATION_STORES, 'readwrite');
  try {
    const salesDocumentStore = tx.objectStore(STORE.SALES_DOCUMENTS);
    const existing = await requestToPromise(salesDocumentStore.index('byIdempotencyKey').get(command.idempotencyKey));
    if (existing) {
      validateIdempotentResult(existing, command, fingerprint);
      const result = await loadConfirmationResult(tx, existing, true);
      await transactionDone(tx);
      return result;
    }

    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const decision = await requestToPromise(decisionStore.get(command.dispatchId));
    if (!decision) throw new Error('ORDERQ_CONFIRM_DISPATCH_NOT_FOUND');
    if (text(decision.status).toUpperCase() !== 'READY_TO_CONFIRM') throw new Error('ORDERQ_CONFIRM_STATE_INVALID');
    if (Number(decision.revision || 0) !== command.expectedRevision) {
      throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    }

    const [lines, allocations, reservations, projection] = await Promise.all([
      allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.INVENTORY_RESERVATIONS, 'byDispatchId', command.dispatchId),
      inventoryProjectionInTransaction(tx)
    ]);
    if (command.lines.length) throw new Error('ORDERQ_CONFIRM_STORED_ACTUALS_ONLY');
    const actuals = resolveNormalDispatchActuals({ lines, allocations, command });
    const { orderMap, itemMap, eventsByOrder } = await validateBusinessReferences(tx, decision, actuals);
    const timestamp = nowIso();
    const activeReservations = new Map(reservations.filter(row => row.status === 'ACTIVE').map(row => [row.reservationId, row]));
    for (const actual of actuals) {
      for (const entry of actual.allocations) {
        const allocation = entry.allocation;
        const reservation = activeReservations.get(allocation.reservationId);
        if (!reservation || reservation.allocationId !== allocation.allocationId) {
          throw new Error(`ORDERQ_CONFIRM_ACTIVE_RESERVATION_REQUIRED:${allocation.allocationId}`);
        }
        if (text(reservation.expiresAt) && text(reservation.expiresAt) <= timestamp) {
          throw new Error(`ORDERQ_CONFIRM_RESERVATION_EXPIRED:${reservation.reservationId}`);
        }
        if (text(reservation.productId) !== text(actual.line.actualProductId) || text(reservation.warehouseId) !== text(allocation.warehouseId)) {
          throw new Error(`ORDERQ_CONFIRM_RESERVATION_SOURCE_MISMATCH:${reservation.reservationId}`);
        }
        if (entry.actualBaseQuantity > finite(reservation.reservedBaseQuantity) + 1e-9) {
          throw new Error(`ORDERQ_CONFIRM_RESERVATION_QUANTITY_EXCEEDED:${reservation.reservationId}`);
        }
      }
    }

    const salesDocumentId = `SD-${command.dispatchId}`;
    const salesLines = [];
    let supplyAmountWon = 0;
    let vatAmountWon = 0;
    for (const actual of actuals) {
      const item = itemMap.get(actual.line.orderItemId);
      const amount = salesAmount(item, actual.line, actual.actualQuantity);
      const allocationWarehouses = [...new Set(actual.allocations.map(entry => entry.allocation.warehouseId))];
      const salesLine = {
        salesLineId: `SL-${actual.line.dispatchLineId}`,
        salesDocumentId,
        dispatchId: command.dispatchId,
        dispatchLineId: actual.line.dispatchLineId,
        orderId: actual.line.orderId,
        orderItemId: actual.line.orderItemId,
        productId: actual.line.actualProductId,
        actualProductId: actual.line.actualProductId,
        productCode: actual.line.actualProductCode || item.itemCode || '',
        productName: actual.line.actualProductName || item.itemName || '',
        warehouseId: allocationWarehouses.length === 1 ? allocationWarehouses[0] : '',
        quantity: actual.actualQuantity,
        actualQuantity: actual.actualQuantity,
        unit: actual.line.actualUnit || item.finalUnit || item.rawUnit || '',
        actualUnit: actual.line.actualUnit || item.finalUnit || item.rawUnit || '',
        actualBaseQuantity: actual.actualBaseQuantity,
        recognizedOrderQuantity: actual.recognizedOrderQuantity,
        priceSource: 'ORDER_AGREED',
        ...amount,
        status: 'CONFIRMED',
        createdAt: timestamp,
        createdBy: context.actorId,
        updatedAt: timestamp,
        updatedBy: context.actorId
      };
      supplyAmountWon += amount.supplyAmountWon;
      vatAmountWon += amount.vatAmountWon;
      salesLines.push(salesLine);
    }
    const firstOrder = orderMap.get(actuals[0].line.orderId) || {};
    const assignee = inheritedAssigneeSnapshot(firstOrder);
    const documentWarehouses = [...new Set(actuals.flatMap(row => row.allocations.map(entry => entry.allocation.warehouseId)))];
    const salesDocument = {
      salesDocumentId,
      dispatchId: command.dispatchId,
      customerId: decision.customerId || firstOrder.customerId || '',
      customerName: decision.customerName || firstOrder.customerName || '',
      normalizedCustomerName: text(decision.customerName || firstOrder.customerName).replace(/\s+/g, '').toLowerCase(),
      warehouseId: documentWarehouses.length === 1 ? documentWarehouses[0] : '',
      businessDate: decision.businessDate || timestamp.slice(0, 10),
      salesDate: decision.businessDate || timestamp.slice(0, 10),
      originSystem: 'ORDER_Q',
      originTransactionId: command.dispatchId,
      idempotencyKey: command.idempotencyKey,
      confirmationRequestFingerprint: fingerprint,
      status: 'CONFIRMED',
      erpPostingStatus: ERP_POSTING_STATUS.READY,
      syncStatus: 'LOCAL_ONLY',
      supplyAmountWon,
      vatAmountWon,
      totalAmountWon: supplyAmountWon + vatAmountWon,
      ...assignee,
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId
    };
    salesDocumentStore.add(salesDocument);
    salesLines.forEach(row => tx.objectStore(STORE.SALES_LINES).add(row));
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.SALES_WRITTEN);

    const movementDrafts = actuals.flatMap(actual => actual.allocations.map(entry => ({
      productId: actual.line.actualProductId,
      productCode: actual.line.actualProductCode || '',
      warehouseId: entry.allocation.warehouseId,
      signedBaseQuantity: -entry.actualBaseQuantity,
      baseUnit: actual.line.actualUnit || '',
      movementType: INVENTORY_MOVEMENT_TYPE.SALE_ISSUE,
      sourceDocumentType: 'SALES_DOCUMENT',
      sourceDocumentId: salesDocumentId,
      sourceLineId: entry.allocation.allocationId,
      dispatchId: command.dispatchId,
      dispatchLineId: actual.line.dispatchLineId,
      occurredAt: timestamp,
      reason: '출고확정'
    })));
    const movementResults = await appendInventoryMovementsInTransaction({ tx, actor: context, drafts: movementDrafts });
    if (movementResults.some(row => row.duplicate)) throw new Error('ORDERQ_CONFIRM_PARTIAL_MOVEMENT_STATE');
    const movementByAllocation = new Map(movementResults.map(row => [row.movement.sourceLineId, row.movement]));
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.MOVEMENTS_WRITTEN);

    const newEvents = [];
    for (const actual of actuals) {
      const order = orderMap.get(actual.line.orderId);
      const salesLine = salesLines.find(row => row.dispatchLineId === actual.line.dispatchLineId);
      const event = createAllocationEvent({
        orderId: actual.line.orderId,
        orderItemId: actual.line.orderItemId,
        salesDocumentId,
        salesLineId: salesLine.salesLineId,
        quantity: actual.recognizedOrderQuantity,
        revision: order.revision,
        actor: context.actorId,
        inheritedAssigneeSnapshot: inheritedAssigneeSnapshot(order),
        reason: 'ORDER Q 출고확정',
        createdAt: timestamp
      });
      const existingEvent = await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).get(event.eventId));
      if (existingEvent) throw new Error(`ORDERQ_CONFIRM_FULFILLMENT_ALREADY_EXISTS:${event.eventId}`);
      tx.objectStore(STORE.ORDER_EVENTS).add(event);
      newEvents.push(event);
    }
    for (const [orderId, order] of orderMap) {
      const items = await allFrom(tx, STORE.ORDER_ITEMS, 'byOrderId', orderId);
      const existingEvents = eventsByOrder.get(orderId) || [];
      const added = newEvents.filter(row => row.orderId === orderId);
      const before = deriveOrderLifecycle(order, items, existingEvents);
      const after = deriveOrderLifecycle(order, items, [...existingEvents, ...added]);
      const transition = confirmationEvent(order, before, after, added.at(-1), command.dispatchId, context.actorId, timestamp);
      if (transition) {
        tx.objectStore(STORE.ORDER_EVENTS).add(transition);
        newEvents.push(transition);
      }
    }
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.FULFILLMENT_WRITTEN);

    const nextReservations = [];
    const nextAllocations = [];
    for (const actual of actuals) {
      for (const entry of actual.allocations) {
        const allocation = entry.allocation;
        const reservation = activeReservations.get(allocation.reservationId);
        const nextReservation = {
          ...reservation,
          status: 'CONSUMED',
          consumedBaseQuantity: entry.actualBaseQuantity,
          releasedBaseQuantity: finite(reservation.reservedBaseQuantity) - entry.actualBaseQuantity,
          consumedAt: timestamp,
          consumedBy: context.actorId,
          updatedAt: timestamp,
          updatedBy: context.actorId
        };
        const movement = movementByAllocation.get(allocation.allocationId);
        const nextAllocation = {
          ...allocation,
          actualBaseQuantity: entry.actualBaseQuantity,
          movementId: movement.movementId,
          status: 'CONFIRMED',
          confirmedAt: timestamp,
          confirmedBy: context.actorId,
          updatedAt: timestamp,
          updatedBy: context.actorId
        };
        tx.objectStore(STORE.INVENTORY_RESERVATIONS).put(nextReservation);
        tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS).put(nextAllocation);
        nextReservations.push(nextReservation);
        nextAllocations.push(nextAllocation);
      }
    }
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.RESERVATIONS_CONSUMED);

    const onHandByKey = new Map(projection.rows.map(row => [inventoryKey(row.productId, row.warehouseId), finite(row.onHandQuantity)]));
    const negativeWarnings = [];
    for (const result of movementResults) {
      const movement = result.movement;
      const key = inventoryKey(movement.productId, movement.warehouseId);
      const before = finite(onHandByKey.get(key));
      const after = before + finite(movement.signedBaseQuantity);
      onHandByKey.set(key, after);
      if (after < 0) negativeWarnings.push({
        productId: movement.productId,
        productCode: movement.productCode,
        warehouseId: movement.warehouseId,
        onHandBefore: before,
        signedBaseQuantity: movement.signedBaseQuantity,
        onHandAfter: after,
        movementId: movement.movementId,
        dispatchLineId: movement.dispatchLineId
      });
    }
    const reconciliations = negativeWarnings.map((warning, index) => ({
      reconciliationId: `DR-NEG-${command.dispatchId}-${index + 1}`,
      dispatchId: command.dispatchId,
      dispatchLineId: warning.dispatchLineId,
      issueType: 'NEGATIVE_INVENTORY',
      status: 'OPEN',
      detail: warning,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId
    }));
    reconciliations.forEach(row => tx.objectStore(STORE.DISPATCH_RECONCILIATIONS).add(row));

    const nextLines = actuals.map(actual => {
      const salesLine = salesLines.find(row => row.dispatchLineId === actual.line.dispatchLineId);
      const next = {
        ...actual.line,
        executionStatus: 'CONFIRMED',
        status: 'CONFIRMED',
        actualQuantity: actual.actualQuantity,
        actualBaseQuantity: actual.actualBaseQuantity,
        recognizedOrderQuantity: actual.recognizedOrderQuantity,
        salesLineId: salesLine.salesLineId,
        confirmedAt: timestamp,
        confirmedBy: context.actorId,
        updatedAt: timestamp,
        updatedBy: context.actorId
      };
      tx.objectStore(STORE.DISPATCH_LINES).put(next);
      return next;
    });
    const baseRevision = Number(decision.revision || 0);
    const event = historyEvent('CONFIRMED', context.actorId, {
      idempotencyKey: command.idempotencyKey,
      salesDocumentId,
      salesLineIds: salesLines.map(row => row.salesLineId),
      movementIds: movementResults.map(row => row.movement.movementId),
      orderEventIds: newEvents.map(row => row.eventId),
      negativeWarnings
    }, timestamp);
    const nextDecision = {
      ...decision,
      status: 'CONFIRMED',
      revision: baseRevision + 1,
      baseRevision,
      idempotencyKey: command.idempotencyKey,
      confirmationRequestFingerprint: fingerprint,
      salesDocumentId,
      inventoryMovementIds: movementResults.map(row => row.movement.movementId),
      fulfillmentEventIds: newEvents.map(row => row.eventId),
      reconciliationIds: reconciliations.map(row => row.reconciliationId),
      needsActionCodes: negativeWarnings.length ? ['NEGATIVE_INVENTORY'] : [],
      warningCount: negativeWarnings.length,
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [...(Array.isArray(decision.history) ? decision.history : []), event],
      localOnly: true
    };
    decisionStore.put(nextDecision);

    const queueRows = [];
    const enqueue = entry => queueRows.push(queueLocalEntity(tx, { ...entry, idempotencyKey: command.idempotencyKey }));
    enqueue({ entityType: 'SALES_DOCUMENT', entityId: salesDocumentId, payload: salesDocument });
    salesLines.forEach(row => enqueue({ entityType: 'SALES_LINE', entityId: row.salesLineId, payload: row }));
    movementResults.forEach(row => enqueue({ entityType: 'INVENTORY_MOVEMENT', entityId: row.movement.movementId, payload: row.movement }));
    newEvents.forEach(row => enqueue({ entityType: 'ORDER_EVENT', entityId: row.eventId, payload: row, revision: row.revision }));
    nextReservations.forEach(row => enqueue({ entityType: 'INVENTORY_RESERVATION', entityId: row.reservationId, payload: row, revision: nextDecision.revision, baseRevision }));
    nextAllocations.forEach(row => enqueue({ entityType: 'DISPATCH_STOCK_ALLOCATION', entityId: row.allocationId, payload: row, revision: nextDecision.revision, baseRevision }));
    nextLines.forEach(row => enqueue({ entityType: 'DISPATCH_LINE', entityId: row.dispatchLineId, payload: row, revision: nextDecision.revision, baseRevision }));
    reconciliations.forEach(row => enqueue({ entityType: 'DISPATCH_RECONCILIATION', entityId: row.reconciliationId, payload: row }));
    enqueue({ entityType: 'DISPATCH_DECISION', entityId: nextDecision.dispatchId, payload: nextDecision, revision: nextDecision.revision, baseRevision });
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.BEFORE_COMMIT);

    await transactionDone(tx);
    return {
      duplicate: false,
      decision: nextDecision,
      salesDocument,
      salesLines,
      movements: movementResults.map(row => row.movement),
      reservations: nextReservations,
      orderEvents: newEvents,
      reconciliations,
      outbox: queueRows
    };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

async function loadReversalResult(tx, salesDocument, duplicate) {
  const decision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(salesDocument.dispatchId));
  const [salesLines, movements, outbox] = await Promise.all([
    allFrom(tx, STORE.SALES_LINES, 'byDocumentId', salesDocument.salesDocumentId),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'byDispatchId', salesDocument.dispatchId),
    allFrom(tx, STORE.SYNC_QUEUE)
  ]);
  const orderEvents = [];
  for (const orderId of decision?.sourceOrderIds || []) {
    const rows = await allFrom(tx, STORE.ORDER_EVENTS, 'byOrderId', orderId);
    orderEvents.push(...rows.filter(row => row.detail?.salesDocumentId === salesDocument.salesDocumentId || row.detail?.dispatchId === decision.dispatchId));
  }
  return {
    duplicate,
    decision,
    salesDocument,
    salesLines,
    movements,
    orderEvents,
    outbox: outbox.filter(row => row.confirmationIdempotencyKey === salesDocument.idempotencyKey)
  };
}

function buildReversalPlan({ command, originalLines, originalAllocations, originalSalesLines, allSalesLines, originalMovements, allMovements }) {
  const inputByLine = new Map(command.lines.map(row => [row.dispatchLineId, row]));
  for (const input of command.lines) {
    if (!originalLines.some(row => row.dispatchLineId === input.dispatchLineId)) throw new Error(`ORDERQ_REVERSE_LINE_UNKNOWN:${input.dispatchLineId}`);
  }
  const movementById = new Map(originalMovements.map(row => [row.movementId, row]));
  const salesLineByDispatchLine = new Map(originalSalesLines.map(row => [row.dispatchLineId, row]));
  const plan = [];
  let allRemainingQuantity = 0;
  for (const line of originalLines) {
    const originalSalesLine = salesLineByDispatchLine.get(line.dispatchLineId);
    if (!originalSalesLine) throw new Error(`ORDERQ_REVERSE_ORIGINAL_SALES_LINE_REQUIRED:${line.dispatchLineId}`);
    const alreadyReversed = allSalesLines
      .filter(row => row.reversalOf === originalSalesLine.salesLineId)
      .reduce((sum, row) => sum + Math.abs(finite(row.actualQuantity ?? row.quantity)), 0);
    const remainingQuantity = finite(originalSalesLine.actualQuantity ?? originalSalesLine.quantity) - alreadyReversed;
    allRemainingQuantity += Math.max(0, remainingQuantity);
    const input = inputByLine.get(line.dispatchLineId);
    if (command.lines.length && !input) continue;
    const quantity = input ? finite(input.quantity) : remainingQuantity;
    if (!(quantity > 0)) {
      if (input) throw new Error(`ORDERQ_REVERSE_QUANTITY_INVALID:${line.dispatchLineId}`);
      continue;
    }
    if (quantity > remainingQuantity + 1e-9) throw new Error(`ORDERQ_REVERSE_EXCEEDS_ORIGINAL:${line.dispatchLineId}`);
    const allocations = originalAllocations.filter(row => row.dispatchLineId === line.dispatchLineId);
    const allocationRemaining = allocations.map(allocation => {
      const originalMovement = movementById.get(allocation.movementId);
      if (!originalMovement) throw new Error(`ORDERQ_REVERSE_ORIGINAL_MOVEMENT_REQUIRED:${allocation.allocationId}`);
      const reversed = allMovements
        .filter(row => row.movementType === INVENTORY_MOVEMENT_TYPE.REVERSAL && row.reversalOf === originalMovement.movementId)
        .reduce((sum, row) => sum + Math.abs(finite(row.signedBaseQuantity)), 0);
      return { allocation, originalMovement, remaining: Math.abs(finite(originalMovement.signedBaseQuantity)) - reversed };
    });
    let reversalAllocations;
    if (input) {
      if (!input.allocations.length) throw new Error(`ORDERQ_REVERSE_ALLOCATION_REQUIRED:${line.dispatchLineId}`);
      const allocationInput = new Map(input.allocations.map(row => [row.allocationId, row.quantity]));
      reversalAllocations = allocationRemaining.filter(row => allocationInput.has(row.allocation.allocationId)).map(row => ({
        ...row,
        quantity: finite(allocationInput.get(row.allocation.allocationId))
      }));
      if (reversalAllocations.length !== allocationInput.size) throw new Error(`ORDERQ_REVERSE_ALLOCATION_UNKNOWN:${line.dispatchLineId}`);
    } else {
      reversalAllocations = allocationRemaining.filter(row => row.remaining > 1e-9).map(row => ({ ...row, quantity: row.remaining }));
    }
    const allocationTotal = reversalAllocations.reduce((sum, row) => {
      if (!(row.quantity > 0) || row.quantity > row.remaining + 1e-9) throw new Error(`ORDERQ_REVERSE_ALLOCATION_EXCEEDS_ORIGINAL:${row.allocation.allocationId}`);
      return sum + row.quantity;
    }, 0);
    if (Math.abs(allocationTotal - quantity) > 1e-9) throw new Error(`ORDERQ_REVERSE_ALLOCATION_SUM_MISMATCH:${line.dispatchLineId}`);
    plan.push({ line, originalSalesLine, quantity, allocations: reversalAllocations });
  }
  if (!plan.length) throw new Error('ORDERQ_REVERSE_NOTHING_REMAINING');
  const requestedTotal = plan.reduce((sum, row) => sum + row.quantity, 0);
  return { plan, full: Math.abs(requestedTotal - allRemainingQuantity) <= 1e-9 };
}

export async function reverseDispatch(source = {}, actor = 'ADMIN', options = {}) {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_REVERSE);
  const command = normalizeDispatchReversalCommand(source);
  const fingerprint = dispatchReversalFingerprint(command);
  const db = await openOrderQDb();
  const tx = db.transaction(CONFIRMATION_STORES, 'readwrite');
  try {
    const salesDocumentStore = tx.objectStore(STORE.SALES_DOCUMENTS);
    const existing = await requestToPromise(salesDocumentStore.index('byIdempotencyKey').get(command.idempotencyKey));
    if (existing) {
      if (existing.sourceDispatchId !== command.dispatchId || existing.reversalRequestFingerprint !== fingerprint) {
        throw new Error(`ORDERQ_REVERSE_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
      }
      const result = await loadReversalResult(tx, existing, true);
      await transactionDone(tx);
      return result;
    }
    const originalDecision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(command.dispatchId));
    if (!originalDecision || originalDecision.status !== 'CONFIRMED') throw new Error('ORDERQ_REVERSE_ORIGINAL_NOT_CONFIRMED');
    if (Number(originalDecision.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${originalDecision.revision}`);
    const originalSalesDocument = await requestToPromise(salesDocumentStore.get(originalDecision.salesDocumentId));
    if (!originalSalesDocument || originalSalesDocument.status !== 'CONFIRMED') throw new Error('ORDERQ_REVERSE_ORIGINAL_SALES_DOCUMENT_REQUIRED');
    if (![ERP_POSTING_STATUS.READY, ERP_POSTING_STATUS.NOT_READY].includes(originalSalesDocument.erpPostingStatus)) {
      throw new Error('ORDERQ_REVERSE_ERP_CORRECTION_REQUIRES_M8');
    }
    const [originalLines, originalAllocations, originalSalesLines, allSalesLines, originalMovements, allMovements] = await Promise.all([
      allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.SALES_LINES, 'byDocumentId', originalSalesDocument.salesDocumentId),
      allFrom(tx, STORE.SALES_LINES),
      allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.INVENTORY_MOVEMENTS)
    ]);
    const reversal = buildReversalPlan({ command, originalLines, originalAllocations, originalSalesLines, allSalesLines, originalMovements, allMovements });
    const timestamp = nowIso();
    const reversalDispatchId = newId('DSP-REV');
    const reversalSalesDocumentId = newId('SD-REV');
    const reversalSalesLines = reversal.plan.map(row => ({
      ...row.originalSalesLine,
      salesLineId: newId('SL-REV'),
      salesDocumentId: reversalSalesDocumentId,
      dispatchId: reversalDispatchId,
      dispatchLineId: newId('DL-REV'),
      quantity: -row.quantity,
      actualQuantity: -row.quantity,
      actualBaseQuantity: -row.quantity,
      recognizedOrderQuantity: -row.quantity,
      supplyAmountWon: -Math.round(finite(row.originalSalesLine.unitPriceWon) * row.quantity),
      vatAmountWon: -Math.round(Math.abs(finite(row.originalSalesLine.vatAmountWon)) * row.quantity / Math.max(finite(row.originalSalesLine.actualQuantity), 1)),
      status: 'REVERSED',
      reversalOf: row.originalSalesLine.salesLineId,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId
    }));
    const reversalSalesDocument = {
      salesDocumentId: reversalSalesDocumentId,
      dispatchId: reversalDispatchId,
      sourceDispatchId: command.dispatchId,
      customerId: originalSalesDocument.customerId,
      customerName: originalSalesDocument.customerName,
      normalizedCustomerName: originalSalesDocument.normalizedCustomerName,
      businessDate: originalSalesDocument.businessDate,
      salesDate: originalSalesDocument.salesDate,
      originSystem: 'ORDER_Q',
      originTransactionId: reversalDispatchId,
      idempotencyKey: command.idempotencyKey,
      reversalRequestFingerprint: fingerprint,
      status: 'REVERSED',
      reversalOf: originalSalesDocument.salesDocumentId,
      erpPostingStatus: ERP_POSTING_STATUS.READY,
      syncStatus: 'LOCAL_ONLY',
      supplyAmountWon: reversalSalesLines.reduce((sum, row) => sum + finite(row.supplyAmountWon), 0),
      vatAmountWon: reversalSalesLines.reduce((sum, row) => sum + finite(row.vatAmountWon), 0),
      reason: command.reason,
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId
    };
    reversalSalesDocument.totalAmountWon = reversalSalesDocument.supplyAmountWon + reversalSalesDocument.vatAmountWon;
    salesDocumentStore.add(reversalSalesDocument);
    reversalSalesLines.forEach(row => tx.objectStore(STORE.SALES_LINES).add(row));
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.SALES_WRITTEN);

    const reversalLineByOriginal = new Map(reversal.plan.map((row, index) => [row.line.dispatchLineId, reversalSalesLines[index]]));
    const movementDrafts = reversal.plan.flatMap(row => row.allocations.map(entry => {
      const reversalLine = reversalLineByOriginal.get(row.line.dispatchLineId);
      return {
        productId: entry.originalMovement.productId,
        productCode: entry.originalMovement.productCode,
        warehouseId: entry.originalMovement.warehouseId,
        signedBaseQuantity: entry.quantity,
        baseUnit: entry.originalMovement.baseUnit,
        movementType: INVENTORY_MOVEMENT_TYPE.REVERSAL,
        sourceDocumentType: 'DISPATCH_REVERSAL',
        sourceDocumentId: reversalSalesDocumentId,
        sourceLineId: entry.allocation.allocationId,
        dispatchId: reversalDispatchId,
        dispatchLineId: reversalLine.dispatchLineId,
        occurredAt: timestamp,
        reason: command.reason,
        reversalOf: entry.originalMovement.movementId,
        idempotencyKey: `${command.idempotencyKey}:${entry.originalMovement.movementId}`
      };
    }));
    const movementResults = await appendInventoryMovementsInTransaction({ tx, actor: context, drafts: movementDrafts });
    if (movementResults.some(row => row.duplicate)) throw new Error('ORDERQ_REVERSE_PARTIAL_MOVEMENT_STATE');
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.MOVEMENTS_WRITTEN);

    const newEvents = [];
    const eventsByOrder = new Map();
    for (const orderId of originalDecision.sourceOrderIds || []) eventsByOrder.set(orderId, await allFrom(tx, STORE.ORDER_EVENTS, 'byOrderId', orderId));
    for (const row of reversal.plan) {
      const reversalLine = reversalLineByOriginal.get(row.line.dispatchLineId);
      const existingEvents = eventsByOrder.get(row.line.orderId) || [];
      const allocationEvent = existingEvents.find(event => event.eventType === TRANSFER_EVENT_TYPE.ALLOCATED && event.detail?.salesLineId === row.originalSalesLine.salesLineId);
      if (!allocationEvent) throw new Error(`ORDERQ_REVERSE_ORIGINAL_FULFILLMENT_REQUIRED:${row.line.dispatchLineId}`);
      const event = createReversalEvent({
        allocationEventId: allocationEvent.eventId,
        idempotencyKey: `${command.idempotencyKey}:${row.line.dispatchLineId}`,
        orderId: row.line.orderId,
        orderItemId: row.line.orderItemId,
        salesDocumentId: reversalSalesDocumentId,
        salesLineId: reversalLine.salesLineId,
        quantity: row.quantity,
        revision: allocationEvent.revision,
        actor: context.actorId,
        reason: command.reason,
        createdAt: timestamp
      });
      tx.objectStore(STORE.ORDER_EVENTS).add(event);
      newEvents.push(event);
    }
    for (const orderId of originalDecision.sourceOrderIds || []) {
      const order = normalizedOrderView(await requestToPromise(tx.objectStore(STORE.ORDERS).get(orderId)));
      const items = await allFrom(tx, STORE.ORDER_ITEMS, 'byOrderId', orderId);
      const existingEvents = eventsByOrder.get(orderId) || [];
      const added = newEvents.filter(row => row.orderId === orderId);
      const before = deriveOrderLifecycle(order, items, existingEvents);
      const after = deriveOrderLifecycle(order, items, [...existingEvents, ...added]);
      const transition = confirmationEvent(order, before, after, added.at(-1), reversalDispatchId, context.actorId, timestamp);
      if (transition) {
        tx.objectStore(STORE.ORDER_EVENTS).add(transition);
        newEvents.push(transition);
      }
    }
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.FULFILLMENT_WRITTEN);

    const reversalDecisionLines = reversal.plan.map((row, index) => {
      const salesLine = reversalSalesLines[index];
      const next = {
        ...row.line,
        dispatchLineId: salesLine.dispatchLineId,
        dispatchId: reversalDispatchId,
        actualQuantity: -row.quantity,
        actualBaseQuantity: -row.quantity,
        recognizedOrderQuantity: -row.quantity,
        executionStatus: 'REVERSED',
        status: 'REVERSED',
        salesLineId: salesLine.salesLineId,
        reversalOf: row.line.dispatchLineId,
        confirmedAt: timestamp,
        confirmedBy: context.actorId,
        createdAt: timestamp,
        createdBy: context.actorId,
        updatedAt: timestamp,
        updatedBy: context.actorId
      };
      tx.objectStore(STORE.DISPATCH_LINES).add(next);
      return next;
    });
    const reversalAllocations = [];
    let movementIndex = 0;
    for (const row of reversal.plan) {
      const reversalLine = reversalLineByOriginal.get(row.line.dispatchLineId);
      for (const entry of row.allocations) {
        const movement = movementResults[movementIndex++].movement;
        const next = {
          allocationId: newId('DA-REV'),
          dispatchId: reversalDispatchId,
          dispatchLineId: reversalLine.dispatchLineId,
          warehouseId: entry.allocation.warehouseId,
          plannedBaseQuantity: -entry.quantity,
          actualBaseQuantity: -entry.quantity,
          movementId: movement.movementId,
          status: 'REVERSED',
          reversalOf: entry.allocation.allocationId,
          createdAt: timestamp,
          createdBy: context.actorId,
          updatedAt: timestamp,
          updatedBy: context.actorId
        };
        tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS).add(next);
        reversalAllocations.push(next);
      }
    }
    const event = historyEvent('DISPATCH_REVERSED', context.actorId, {
      sourceDispatchId: command.dispatchId,
      reversalType: reversal.full ? 'FULL' : 'PARTIAL',
      reason: command.reason,
      salesDocumentId: reversalSalesDocumentId,
      movementIds: movementResults.map(row => row.movement.movementId),
      orderEventIds: newEvents.map(row => row.eventId)
    }, timestamp);
    const reversalDecision = {
      dispatchId: reversalDispatchId,
      dispatchNo: `${originalDecision.dispatchNo}-R-${reversalDispatchId.slice(-6)}`,
      customerId: originalDecision.customerId,
      customerName: originalDecision.customerName,
      sourceOrderIds: originalDecision.sourceOrderIds,
      dispatchStageCode: originalDecision.dispatchStageCode,
      status: 'CONFIRMED',
      revision: 1,
      baseRevision: 0,
      businessDate: originalDecision.businessDate,
      reversalOf: command.dispatchId,
      reversalType: reversal.full ? 'FULL' : 'PARTIAL',
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      salesDocumentId: reversalSalesDocumentId,
      inventoryMovementIds: movementResults.map(row => row.movement.movementId),
      fulfillmentEventIds: newEvents.map(row => row.eventId),
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [event],
      localOnly: true
    };
    tx.objectStore(STORE.DISPATCH_DECISIONS).add(reversalDecision);
    const queueRows = [];
    const enqueue = entry => queueRows.push(queueLocalEntity(tx, { ...entry, idempotencyKey: command.idempotencyKey }));
    enqueue({ entityType: 'SALES_DOCUMENT', entityId: reversalSalesDocumentId, payload: reversalSalesDocument });
    reversalSalesLines.forEach(row => enqueue({ entityType: 'SALES_LINE', entityId: row.salesLineId, payload: row }));
    movementResults.forEach(row => enqueue({ entityType: 'INVENTORY_MOVEMENT', entityId: row.movement.movementId, payload: row.movement }));
    newEvents.forEach(row => enqueue({ entityType: 'ORDER_EVENT', entityId: row.eventId, payload: row, revision: row.revision }));
    reversalDecisionLines.forEach(row => enqueue({ entityType: 'DISPATCH_LINE', entityId: row.dispatchLineId, payload: row }));
    reversalAllocations.forEach(row => enqueue({ entityType: 'DISPATCH_STOCK_ALLOCATION', entityId: row.allocationId, payload: row }));
    enqueue({ entityType: 'DISPATCH_DECISION', entityId: reversalDispatchId, payload: reversalDecision });
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.BEFORE_COMMIT);
    await transactionDone(tx);
    return {
      duplicate: false,
      decision: reversalDecision,
      salesDocument: reversalSalesDocument,
      salesLines: reversalSalesLines,
      movements: movementResults.map(row => row.movement),
      orderEvents: newEvents,
      outbox: queueRows
    };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function confirmDispatchBatch(commands = [], actor = 'ADMIN', options = {}) {
  if (!Array.isArray(commands) || !commands.length) throw new Error('ORDERQ_CONFIRM_BATCH_REQUIRED');
  const results = [];
  for (const command of commands) {
    try {
      const result = await confirmDispatch(command, actor, options);
      results.push({ dispatchId: command.dispatchId, ok: true, duplicate: result.duplicate, result });
    } catch (error) {
      results.push({ dispatchId: command?.dispatchId || '', ok: false, error: error?.message || String(error) });
    }
  }
  return {
    total: results.length,
    succeeded: results.filter(row => row.ok).length,
    failed: results.filter(row => !row.ok).length,
    results
  };
}
