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
  normalizeDispatchConfirmationCommand,
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
    if (text(decision.status).toUpperCase() !== 'RELEASED') throw new Error('ORDERQ_CONFIRM_STATE_INVALID');
    if (Number(decision.revision || 0) !== command.expectedRevision) {
      throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    }

    const [lines, allocations, reservations, projection] = await Promise.all([
      allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', command.dispatchId),
      allFrom(tx, STORE.INVENTORY_RESERVATIONS, 'byDispatchId', command.dispatchId),
      inventoryProjectionInTransaction(tx)
    ]);
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
