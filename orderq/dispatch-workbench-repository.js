import {
  STORE,
  getAll,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { CAPABILITY, requireCapability } from './orderq-v7-contracts.js?v=0.8.0';
import { calculateInventoryShadowProjection } from './inventory-ledger.js?v=0.8.0';
import {
  DISPATCH_STATUS,
  NEEDS_ACTION_CODE,
  RESERVATION_STATUS,
  buildWorkerPickViews,
  normalizeWorkerFact,
  proposeNormalDispatchDrafts,
  quantityFromUnits,
  quantityUnits,
  validateDispatchDraftPlan
} from './dispatch-workbench.js?v=0.8.0';

const DISPATCH_SEQUENCE_PREFIX = 'dispatchNoSequence:';
const DEFAULT_RESERVATION_MINUTES = 480;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + Number(minutes || 0) * 60_000).toISOString();
}

function historyEvent(eventType, actor, detail = {}) {
  return { eventId: newId('DH'), eventType, actorId: actor.actorId, detail: clone(detail), createdAt: nowIso() };
}

function withHistory(decision, event) {
  return { ...decision, history: [...(Array.isArray(decision.history) ? decision.history : []), event] };
}

function queueEntity(tx, entityType, entityId, payload, revision, baseRevision, operation = 'UPSERT') {
  const timestamp = nowIso();
  tx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: newId('SQ'), entityType, entityId, operation,
    revision: Number(revision || 0), baseRevision: Number(baseRevision || 0),
    payload: clone(payload), status: 'LOCAL_ONLY', localOnly: true,
    createdAt: timestamp, updatedAt: timestamp
  });
}

async function getAllFrom(tx, storeName, indexName = '', query = undefined) {
  const store = tx.objectStore(storeName);
  const source = indexName ? store.index(indexName) : store;
  return requestToPromise(source.getAll(query));
}

async function projectionFromTransaction(tx) {
  const [snapshots, inventoryLines, movements, reservations, warehouses] = await Promise.all([
    getAllFrom(tx, STORE.INVENTORY_SNAPSHOTS),
    getAllFrom(tx, STORE.INVENTORY_LINES),
    getAllFrom(tx, STORE.INVENTORY_MOVEMENTS),
    getAllFrom(tx, STORE.INVENTORY_RESERVATIONS),
    getAllFrom(tx, STORE.WAREHOUSES)
  ]);
  return calculateInventoryShadowProjection({ snapshots, inventoryLines, movements, reservations, warehouses });
}

async function nextDispatchNo(tx, businessDate) {
  const dateKey = text(businessDate).replace(/\D/g, '').slice(0, 8) || nowIso().slice(0, 10).replace(/-/g, '');
  const key = `${DISPATCH_SEQUENCE_PREFIX}${dateKey}`;
  const metaStore = tx.objectStore(STORE.META);
  const current = await requestToPromise(metaStore.get(key));
  const sequence = Number(current?.value || 0) + 1;
  metaStore.put({ key, value: sequence, updatedAt: nowIso() });
  return `${dateKey}-D${String(sequence).padStart(3, '0')}`;
}

async function assertReferences(tx, lines, allocations, strict) {
  const orderIds = [...new Set(lines.map(row => row.orderId))];
  const itemIds = [...new Set(lines.map(row => row.orderItemId))];
  const productIds = [...new Set(lines.flatMap(row => [row.requestedProductId, row.actualProductId]).filter(Boolean))];
  const warehouseIds = [...new Set(allocations.map(row => row.warehouseId).filter(Boolean))];
  const [orders, items, products, warehouses] = await Promise.all([
    Promise.all(orderIds.map(id => requestToPromise(tx.objectStore(STORE.ORDERS).get(id)))),
    Promise.all(itemIds.map(id => requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).get(id)))),
    Promise.all(productIds.map(id => requestToPromise(tx.objectStore(STORE.PRODUCTS).get(id)))),
    Promise.all(warehouseIds.map(id => requestToPromise(tx.objectStore(STORE.WAREHOUSES).get(id))))
  ]);
  if (orders.some(row => !row)) throw new Error('ORDERQ_DISPATCH_ORDER_NOT_FOUND');
  if (items.some(row => !row)) throw new Error('ORDERQ_DISPATCH_ORDER_ITEM_NOT_FOUND');
  if (strict && products.some(row => !row)) throw new Error('ORDERQ_DISPATCH_PRODUCT_NOT_FOUND');
  if (strict && warehouses.some(row => !row || row.active === false || text(row.status).toUpperCase() === 'INACTIVE')) {
    throw new Error('ORDERQ_DISPATCH_WAREHOUSE_NOT_WORKABLE');
  }
  lines.forEach(line => {
    const item = items.find(row => row?.orderItemId === line.orderItemId);
    if (item?.orderId !== line.orderId) throw new Error(`ORDERQ_DISPATCH_ORDER_ITEM_MISMATCH:${line.dispatchLineId}`);
  });
}

export async function loadDispatchAggregate(dispatchId) {
  const db = await openOrderQDb();
  const stores = [STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_STOCK_ALLOCATIONS, STORE.INVENTORY_RESERVATIONS];
  const tx = db.transaction(stores, 'readonly');
  const [decision, lines, allocations, reservations] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(dispatchId)),
    getAllFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', dispatchId),
    getAllFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', dispatchId),
    getAllFrom(tx, STORE.INVENTORY_RESERVATIONS, 'byDispatchId', dispatchId)
  ]);
  await transactionDone(tx);
  return decision ? { decision, lines, allocations, reservations } : null;
}

export async function listDispatchAggregates() {
  const [decisions, lines, allocations, reservations] = await Promise.all([
    getAll(STORE.DISPATCH_DECISIONS), getAll(STORE.DISPATCH_LINES),
    getAll(STORE.DISPATCH_STOCK_ALLOCATIONS), getAll(STORE.INVENTORY_RESERVATIONS)
  ]);
  return decisions.map(decision => ({
    decision,
    lines: lines.filter(row => row.dispatchId === decision.dispatchId),
    allocations: allocations.filter(row => row.dispatchId === decision.dispatchId),
    reservations: reservations.filter(row => row.dispatchId === decision.dispatchId)
  })).sort((left, right) => text(right.decision.updatedAt).localeCompare(text(left.decision.updatedAt)));
}

export async function getDispatchProposals({ businessDate = '', dispatchStageCode = 'UNSPECIFIED' } = {}) {
  const [orders, orderItems, orderEvents, decisions, snapshots, inventoryLines, movements, reservations, warehouses] = await Promise.all([
    getAll(STORE.ORDERS), getAll(STORE.ORDER_ITEMS), getAll(STORE.ORDER_EVENTS), getAll(STORE.DISPATCH_DECISIONS),
    getAll(STORE.INVENTORY_SNAPSHOTS),
    getAll(STORE.INVENTORY_LINES), getAll(STORE.INVENTORY_MOVEMENTS),
    getAll(STORE.INVENTORY_RESERVATIONS), getAll(STORE.WAREHOUSES)
  ]);
  const inventoryProjection = calculateInventoryShadowProjection({ snapshots, inventoryLines, movements, reservations, warehouses });
  const plannedOrderIds = new Set(decisions
    .filter(row => [DISPATCH_STATUS.DRAFT, DISPATCH_STATUS.RELEASED].includes(row.status))
    .flatMap(row => Array.isArray(row.sourceOrderIds) ? row.sourceOrderIds : []));
  return proposeNormalDispatchDrafts({
    orders: orders.filter(row => !plannedOrderIds.has(row.orderId)),
    orderItems, orderEvents, inventoryProjection, businessDate, dispatchStageCode
  });
}

export async function getDispatchWorkbenchData() {
  const [aggregates, warehouses, snapshots, inventoryLines, movements, reservations] = await Promise.all([
    listDispatchAggregates(), getAll(STORE.WAREHOUSES), getAll(STORE.INVENTORY_SNAPSHOTS),
    getAll(STORE.INVENTORY_LINES), getAll(STORE.INVENTORY_MOVEMENTS), getAll(STORE.INVENTORY_RESERVATIONS)
  ]);
  const inventoryProjection = calculateInventoryShadowProjection({ snapshots, inventoryLines, movements, reservations, warehouses });
  return { aggregates, warehouses, inventoryProjection, workerViews: buildWorkerPickViews(aggregates, warehouses) };
}

export async function saveDispatchDraft({ decision = {}, lines = [], allocations = [], expectedRevision = 0 } = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_EDIT);
  const dispatchId = text(decision.dispatchId) || newId('DSP');
  const normalizedInput = validateDispatchDraftPlan({
    lines: lines.map(row => ({ ...row, dispatchId, dispatchLineId: text(row.dispatchLineId) || newId('DL') })),
    allocations: allocations.map(row => ({ ...row, dispatchId, allocationId: text(row.allocationId) || newId('DA') }))
  });
  const lineIdByOrderItem = new Map(normalizedInput.lines.map(row => [row.orderItemId, row.dispatchLineId]));
  const normalizedAllocations = normalizedInput.allocations.map(row => ({
    ...row,
    dispatchId,
    dispatchLineId: row.dispatchLineId || lineIdByOrderItem.get(row.orderItemId) || ''
  }));
  const normalized = validateDispatchDraftPlan({ lines: normalizedInput.lines, allocations: normalizedAllocations });
  const storeNames = [
    STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_STOCK_ALLOCATIONS,
    STORE.ORDERS, STORE.ORDER_ITEMS, STORE.PRODUCTS, STORE.WAREHOUSES, STORE.META, STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readwrite');
  try {
    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const current = await requestToPromise(decisionStore.get(dispatchId));
    const currentRevision = Number(current?.revision || 0);
    if (current && current.status !== DISPATCH_STATUS.DRAFT) throw new Error('ORDERQ_DISPATCH_DRAFT_LOCKED');
    if (Number(expectedRevision) !== currentRevision) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${currentRevision}`);
    await assertReferences(tx, normalized.lines, normalized.allocations, false);
    const timestamp = nowIso();
    const dispatchNo = text(current?.dispatchNo || decision.dispatchNo) || await nextDispatchNo(tx, decision.businessDate);
    const {
      confirmedAt: _confirmedAt,
      confirmedBy: _confirmedBy,
      salesDocumentId: _salesDocumentId,
      purchaseDocumentId: _purchaseDocumentId,
      inventoryMovementIds: _inventoryMovementIds,
      recognizedOrderQuantity: _recognizedOrderQuantity,
      reversedAt: _reversedAt,
      reversedBy: _reversedBy,
      ...draftDecision
    } = decision;
    const next = withHistory({
      ...(current || {}), ...draftDecision, dispatchId, dispatchNo,
      sourceOrderIds: [...new Set(normalized.lines.map(row => row.orderId))],
      status: DISPATCH_STATUS.DRAFT, revision: currentRevision + 1,
      baseRevision: currentRevision, localOnly: true,
      createdAt: current?.createdAt || timestamp, createdBy: current?.createdBy || context.actorId,
      updatedAt: timestamp, updatedBy: context.actorId
    }, historyEvent('DRAFT_SAVED', context, { revision: currentRevision + 1 }));
    decisionStore.put(next);

    const lineStore = tx.objectStore(STORE.DISPATCH_LINES);
    const allocationStore = tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS);
    const oldLines = await getAllFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', dispatchId);
    const oldAllocations = await getAllFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', dispatchId);
    const nextLineIds = new Set(normalized.lines.map(row => row.dispatchLineId));
    const nextAllocationIds = new Set(normalized.allocations.map(row => row.allocationId));
    oldLines.filter(row => !nextLineIds.has(row.dispatchLineId)).forEach(row => {
      lineStore.delete(row.dispatchLineId);
      queueEntity(tx, 'DISPATCH_LINE', row.dispatchLineId, row, next.revision, currentRevision, 'DELETE');
    });
    oldAllocations.filter(row => !nextAllocationIds.has(row.allocationId)).forEach(row => {
      allocationStore.delete(row.allocationId);
      queueEntity(tx, 'DISPATCH_STOCK_ALLOCATION', row.allocationId, row, next.revision, currentRevision, 'DELETE');
    });
    normalized.lines.forEach(row => {
      const stored = { ...row, dispatchId, revision: next.revision, updatedAt: timestamp, updatedBy: context.actorId };
      lineStore.put(stored);
      queueEntity(tx, 'DISPATCH_LINE', stored.dispatchLineId, stored, next.revision, currentRevision);
    });
    normalized.allocations.forEach(row => {
      const stored = { ...row, dispatchId, status: 'PLANNED', reservationId: '', revision: next.revision, updatedAt: timestamp, updatedBy: context.actorId };
      allocationStore.put(stored);
      queueEntity(tx, 'DISPATCH_STOCK_ALLOCATION', stored.allocationId, stored, next.revision, currentRevision);
    });
    queueEntity(tx, 'DISPATCH_DECISION', dispatchId, next, next.revision, currentRevision);
    await transactionDone(tx);
    return { decision: next, lines: normalized.lines, allocations: normalized.allocations };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function releaseDispatch(dispatchId, expectedRevision, actor = 'ADMIN', { reservationMinutes = DEFAULT_RESERVATION_MINUTES } = {}) {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_RELEASE);
  const stores = [
    STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_STOCK_ALLOCATIONS,
    STORE.INVENTORY_RESERVATIONS, STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES,
    STORE.INVENTORY_MOVEMENTS, STORE.WAREHOUSES, STORE.ORDERS, STORE.ORDER_ITEMS,
    STORE.PRODUCTS, STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  try {
    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const decision = await requestToPromise(decisionStore.get(dispatchId));
    if (!decision) throw new Error('ORDERQ_DISPATCH_NOT_FOUND');
    if (decision.status !== DISPATCH_STATUS.DRAFT) throw new Error('ORDERQ_DISPATCH_RELEASE_STATE_INVALID');
    if (Number(expectedRevision) !== Number(decision.revision || 0)) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const [lines, allocations, projection] = await Promise.all([
      getAllFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', dispatchId),
      getAllFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', dispatchId),
      projectionFromTransaction(tx)
    ]);
    const normalized = validateDispatchDraftPlan({ lines, allocations, strict: true });
    await assertReferences(tx, normalized.lines, normalized.allocations, true);
    const available = new Map(projection.rows.map(row => [`${text(row.productId || row.productCode)}\u001f${row.warehouseId}`, quantityUnits(row.availableQuantity)]));
    const reservedThisRelease = new Map();
    const reservationStore = tx.objectStore(STORE.INVENTORY_RESERVATIONS);
    const allocationStore = tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS);
    const timestamp = nowIso();
    const expiresAt = addMinutes(timestamp, reservationMinutes);
    const conflicts = [];
    for (const allocation of normalized.allocations) {
      const line = normalized.lines.find(row => row.dispatchLineId === allocation.dispatchLineId);
      const key = `${text(line.actualProductId || line.actualProductCode)}\u001f${allocation.warehouseId}`;
      const plannedUnits = quantityUnits(allocation.plannedBaseQuantity);
      const effectiveAvailable = (available.get(key) || 0) - (reservedThisRelease.get(key) || 0);
      const conflictUnits = Math.max(0, plannedUnits - Math.max(0, effectiveAvailable));
      reservedThisRelease.set(key, (reservedThisRelease.get(key) || 0) + plannedUnits);
      const reservationId = newId('IR');
      const reservation = {
        reservationId, dispatchId, dispatchLineId: line.dispatchLineId, allocationId: allocation.allocationId,
        productId: line.actualProductId, productCode: line.actualProductCode,
        warehouseId: allocation.warehouseId, reservedBaseQuantity: allocation.plannedBaseQuantity,
        baseUnit: line.actualUnit, status: RESERVATION_STATUS.ACTIVE,
        conflictBaseQuantity: quantityFromUnits(conflictUnits), expiresAt,
        createdAt: timestamp, createdBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId
      };
      reservationStore.add(reservation);
      const nextAllocation = { ...allocation, reservationId, status: 'RESERVED', updatedAt: timestamp, updatedBy: context.actorId };
      allocationStore.put(nextAllocation);
      queueEntity(tx, 'INVENTORY_RESERVATION', reservationId, reservation, decision.revision + 1, decision.revision);
      queueEntity(tx, 'DISPATCH_STOCK_ALLOCATION', allocation.allocationId, nextAllocation, decision.revision + 1, decision.revision);
      if (conflictUnits > 0) conflicts.push({ dispatchLineId: line.dispatchLineId, allocationId: allocation.allocationId, conflictBaseQuantity: quantityFromUnits(conflictUnits) });
    }
    const actionCodes = conflicts.length ? [NEEDS_ACTION_CODE.RESERVATION_CONFLICT] : [NEEDS_ACTION_CODE.READY];
    const next = withHistory({
      ...decision, status: DISPATCH_STATUS.RELEASED, revision: Number(decision.revision || 0) + 1,
      baseRevision: Number(decision.revision || 0), worklistVersion: Number(decision.worklistVersion || 0) + 1,
      needsActionCodes: actionCodes, reservationExpiresAt: expiresAt,
      releasedAt: timestamp, releasedBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId,
      localOnly: true
    }, historyEvent('RELEASED', context, { conflicts, localOnly: true }));
    decisionStore.put(next);
    queueEntity(tx, 'DISPATCH_DECISION', dispatchId, next, next.revision, decision.revision);
    await transactionDone(tx);
    return { decision: next, lines: normalized.lines, allocations: normalized.allocations, conflicts };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function recallDispatch(dispatchId, expectedRevision, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_RELEASE);
  const stores = [STORE.DISPATCH_DECISIONS, STORE.DISPATCH_STOCK_ALLOCATIONS, STORE.INVENTORY_RESERVATIONS, STORE.SYNC_QUEUE];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  try {
    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const decision = await requestToPromise(decisionStore.get(dispatchId));
    if (!decision || decision.status !== DISPATCH_STATUS.RELEASED) throw new Error('ORDERQ_DISPATCH_RECALL_STATE_INVALID');
    if (Number(expectedRevision) !== Number(decision.revision || 0)) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const [reservations, allocations] = await Promise.all([
      getAllFrom(tx, STORE.INVENTORY_RESERVATIONS, 'byDispatchId', dispatchId),
      getAllFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', dispatchId)
    ]);
    const timestamp = nowIso();
    reservations.filter(row => row.status === RESERVATION_STATUS.ACTIVE).forEach(row => {
      const nextReservation = { ...row, status: RESERVATION_STATUS.RELEASED, releasedAt: timestamp, releasedBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId };
      tx.objectStore(STORE.INVENTORY_RESERVATIONS).put(nextReservation);
      queueEntity(tx, 'INVENTORY_RESERVATION', row.reservationId, nextReservation, decision.revision + 1, decision.revision);
    });
    allocations.forEach(row => {
      const nextAllocation = { ...row, status: 'PLANNED', reservationId: '', updatedAt: timestamp, updatedBy: context.actorId };
      tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS).put(nextAllocation);
      queueEntity(tx, 'DISPATCH_STOCK_ALLOCATION', row.allocationId, nextAllocation, decision.revision + 1, decision.revision);
    });
    const next = withHistory({
      ...decision, status: DISPATCH_STATUS.DRAFT, revision: Number(decision.revision || 0) + 1,
      baseRevision: Number(decision.revision || 0), needsActionCodes: [], reservationExpiresAt: '',
      recalledAt: timestamp, recalledBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId
    }, historyEvent('RECALLED', context, { releasedReservationCount: reservations.filter(row => row.status === RESERVATION_STATUS.ACTIVE).length }));
    decisionStore.put(next);
    queueEntity(tx, 'DISPATCH_DECISION', dispatchId, next, next.revision, decision.revision);
    await transactionDone(tx);
    return next;
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function expireDispatchReservations(asOf = nowIso(), actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_RELEASE);
  const stores = [STORE.DISPATCH_DECISIONS, STORE.DISPATCH_STOCK_ALLOCATIONS, STORE.INVENTORY_RESERVATIONS, STORE.SYNC_QUEUE];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  try {
    const reservations = await getAllFrom(tx, STORE.INVENTORY_RESERVATIONS);
    const expired = reservations.filter(row => row.status === RESERVATION_STATUS.ACTIVE && text(row.expiresAt) && text(row.expiresAt) <= text(asOf));
    const byDispatch = new Map();
    expired.forEach(row => {
      const list = byDispatch.get(row.dispatchId) || [];
      list.push(row);
      byDispatch.set(row.dispatchId, list);
    });
    for (const [dispatchId, rows] of byDispatch) {
      const decision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(dispatchId));
      if (!decision || decision.status !== DISPATCH_STATUS.RELEASED) continue;
      const allocations = await getAllFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', dispatchId);
      const expiredIds = new Set(rows.map(row => row.reservationId));
      rows.forEach(row => {
        const nextReservation = { ...row, status: RESERVATION_STATUS.EXPIRED, expiredAt: asOf, expiredBy: context.actorId, updatedAt: asOf, updatedBy: context.actorId };
        tx.objectStore(STORE.INVENTORY_RESERVATIONS).put(nextReservation);
        queueEntity(tx, 'INVENTORY_RESERVATION', row.reservationId, nextReservation, decision.revision + 1, decision.revision);
      });
      allocations.filter(row => expiredIds.has(row.reservationId)).forEach(row => {
        const nextAllocation = { ...row, status: 'PLANNED', reservationId: '', updatedAt: asOf, updatedBy: context.actorId };
        tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS).put(nextAllocation);
        queueEntity(tx, 'DISPATCH_STOCK_ALLOCATION', row.allocationId, nextAllocation, decision.revision + 1, decision.revision);
      });
      const next = withHistory({
        ...decision, revision: Number(decision.revision || 0) + 1, baseRevision: Number(decision.revision || 0),
        needsActionCodes: [NEEDS_ACTION_CODE.RESERVATION_EXPIRED], reservationExpiresAt: '',
        updatedAt: asOf, updatedBy: context.actorId
      }, historyEvent('RESERVATION_EXPIRED', context, { reservationIds: [...expiredIds] }));
      tx.objectStore(STORE.DISPATCH_DECISIONS).put(next);
      queueEntity(tx, 'DISPATCH_DECISION', dispatchId, next, next.revision, decision.revision);
    }
    await transactionDone(tx);
    return { expiredCount: expired.length, dispatchIds: [...byDispatch.keys()] };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function recordDispatchWorkFact({ dispatchId, dispatchLineId, expectedRevision, ...source } = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_EDIT);
  const fact = normalizeWorkerFact({ dispatchLineId, ...source });
  const stores = [STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.SYNC_QUEUE];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  try {
    const decision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(dispatchId));
    if (!decision || decision.status !== DISPATCH_STATUS.RELEASED) throw new Error('ORDERQ_DISPATCH_WORK_STATE_INVALID');
    if (Number(expectedRevision) !== Number(decision.revision || 0)) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const line = await requestToPromise(tx.objectStore(STORE.DISPATCH_LINES).get(dispatchLineId));
    if (!line || line.dispatchId !== dispatchId) throw new Error('ORDERQ_DISPATCH_LINE_NOT_FOUND');
    const timestamp = nowIso();
    const nextLine = { ...line, ...fact, workerReportedAt: timestamp, workerReportedBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId };
    const next = withHistory({
      ...decision, revision: Number(decision.revision || 0) + 1, baseRevision: Number(decision.revision || 0),
      needsActionCodes: fact.workerExceptionCode ? [NEEDS_ACTION_CODE.WORK_EXCEPTION] : decision.needsActionCodes,
      updatedAt: timestamp, updatedBy: context.actorId
    }, historyEvent('WORK_FACT_RECORDED', context, { dispatchLineId, workStatus: fact.workStatus, workerExceptionCode: fact.workerExceptionCode }));
    tx.objectStore(STORE.DISPATCH_LINES).put(nextLine);
    tx.objectStore(STORE.DISPATCH_DECISIONS).put(next);
    queueEntity(tx, 'DISPATCH_LINE', dispatchLineId, nextLine, next.revision, decision.revision);
    queueEntity(tx, 'DISPATCH_DECISION', dispatchId, next, next.revision, decision.revision);
    await transactionDone(tx);
    return { decision: next, line: nextLine };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}
