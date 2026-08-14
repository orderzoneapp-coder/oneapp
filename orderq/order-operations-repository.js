import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso
} from './orderq-db.js?v=0.7.1';
import { normalizedOrderView, inheritedAssigneeSnapshot } from './order-document-model.js?v=0.7.1';
import {
  TRANSFER_EVENT_TYPE,
  createAllocationEvent,
  createReversalEvent,
  deriveOrderLifecycle,
  filterOrderBundles,
  aggregateOperationsByProduct
} from './order-fulfillment-lifecycle.js?v=0.7.1';

const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('oneapp-orderq-orders') : null;

function queueEvent(tx, event) {
  const timestamp = nowIso();
  tx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: newId('SQ'),
    entityType: 'ORDER_EVENT',
    entityId: event.eventId,
    operation: 'UPSERT',
    revision: Number(event.revision || 0),
    baseRevision: 0,
    payload: event,
    status: 'PENDING',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function queueSalesDocument(tx, salesDocument) {
  const timestamp = nowIso();
  tx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: newId('SQ'),
    entityType: 'SALES_DOCUMENT',
    entityId: salesDocument.salesDocumentId,
    operation: 'UPSERT',
    revision: 1,
    baseRevision: 0,
    payload: salesDocument,
    status: 'PENDING',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function lifecycleTransitionEvent(order, beforeStatus, afterStatus, causeEvent, actor) {
  if (beforeStatus === afterStatus) return null;
  const closed = afterStatus === 'CLOSED';
  return {
    eventId: newId('OE'),
    orderId: order.orderId,
    revision: Number(order.revision || 0),
    eventType: closed ? TRANSFER_EVENT_TYPE.CLOSED : TRANSFER_EVENT_TYPE.REOPENED,
    actor: String(actor || 'LOCAL_USER'),
    detail: {
      reason: closed ? '모든 유효 주문상품 이관 완료' : '이관 취소·수정 또는 보류로 미출고 재발생',
      causeEventId: causeEvent.eventId,
      beforeStatus,
      afterStatus
    },
    createdAt: nowIso()
  };
}

function eventContent(event) {
  return JSON.stringify({
    orderId: event.orderId,
    eventType: event.eventType,
    detail: event.detail
  });
}

async function mutateTransfer(input, createEvent) {
  const event = createEvent(input);
  if (!event.orderId) throw new Error('주문 식별정보가 필요합니다.');
  const db = await openOrderQDb();
  const storeNames = [STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.SALES_DOCUMENTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(storeNames, 'readwrite');
  try {
    const order = await requestToPromise(tx.objectStore(STORE.ORDERS).get(event.orderId));
    if (!order) throw new Error('이관할 주문을 찾을 수 없습니다.');
    const item = await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).get(event.detail.orderItemId));
    if (!item || item.orderId !== order.orderId) throw new Error('이관할 주문상품을 찾을 수 없습니다.');
    const eventStore = tx.objectStore(STORE.ORDER_EVENTS);
    const existingSameId = await requestToPromise(eventStore.get(event.eventId));
    if (existingSameId) {
      if (eventContent(existingSameId) !== eventContent(event)) throw new Error('같은 이관 식별키의 이력은 수정할 수 없습니다.');
      await transactionDone(tx);
      return { duplicate: true, event: existingSameId };
    }
    const [items, existingEvents] = await Promise.all([
      requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).index('byOrderId').getAll(order.orderId)),
      requestToPromise(eventStore.index('byOrderId').getAll(order.orderId))
    ]);
    if (event.eventType === TRANSFER_EVENT_TYPE.REVERSED) {
      const allocation = existingEvents.find(row => row.eventId === event.detail.allocationEventId && row.eventType === TRANSFER_EVENT_TYPE.ALLOCATED);
      if (!allocation) throw new Error('취소할 원 이관이력을 찾을 수 없습니다.');
      const reversed = existingEvents
        .filter(row => row.eventType === TRANSFER_EVENT_TYPE.REVERSED && row.detail?.allocationEventId === allocation.eventId)
        .reduce((sum, row) => sum + Number(row.detail?.transferredQty || 0), 0);
      if (reversed + Number(event.detail.transferredQty || 0) > Number(allocation.detail?.transferredQty || 0) + 1e-9) {
        throw new Error('원 이관수량보다 많이 취소할 수 없습니다.');
      }
    }
    const normalizedOrder = normalizedOrderView(order);
    const before = deriveOrderLifecycle(normalizedOrder, items, existingEvents);
    eventStore.add(event);
    queueEvent(tx, event);
    const after = deriveOrderLifecycle(normalizedOrder, items, [...existingEvents, event]);
    const transition = lifecycleTransitionEvent(normalizedOrder, before.operationStatus, after.operationStatus, event, input.actor);
    if (transition) {
      eventStore.add(transition);
      queueEvent(tx, transition);
    }
    if (event.eventType === TRANSFER_EVENT_TYPE.ALLOCATED && event.detail.salesDocumentId) {
      const salesStore = tx.objectStore(STORE.SALES_DOCUMENTS);
      const salesDocument = await requestToPromise(salesStore.get(event.detail.salesDocumentId));
      if (salesDocument) {
        const inherited = inheritedAssigneeSnapshot(normalizedOrder);
        const nextSales = { ...salesDocument, ...inherited, updatedAt: nowIso() };
        salesStore.put(nextSales);
        queueSalesDocument(tx, nextSales);
      }
    }
    await transactionDone(tx);
    try { channel?.postMessage({ type: event.eventType, orderId: order.orderId, updatedAt: event.createdAt }); } catch (_) {}
    return { duplicate: false, event, transition, lifecycle: after };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export function recordSalesTransfer(input) {
  return mutateTransfer(input, createAllocationEvent);
}

export function reverseSalesTransfer(input) {
  return mutateTransfer(input, createReversalEvent);
}

function activeRows(rows) {
  return rows.filter(row => !row.disabledAt && row.active !== false && row.status !== 'ROLLED_BACK');
}

function inventoryMap(snapshots, lines) {
  const activeSnapshots = activeRows(snapshots);
  if (!activeSnapshots.length) return new Map();
  const latest = [...activeSnapshots].sort((a, b) => {
    const date = String(b.basisDate || '').localeCompare(String(a.basisDate || ''));
    return date || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  })[0];
  const batchId = latest.importBatchId;
  const snapshotIds = new Set(activeSnapshots
    .filter(row => batchId ? row.importBatchId === batchId : row.basisDate === latest.basisDate)
    .map(row => row.inventorySnapshotId));
  const result = new Map();
  activeRows(lines).forEach(line => {
    if (!snapshotIds.has(line.inventorySnapshotId)) return;
    const code = String(line.productCode || line.productId || '').trim();
    if (!code) return;
    result.set(code, Number(result.get(code) || 0) + Number(line.inventoryQuantity || 0));
  });
  return result;
}

export async function getOperationsSnapshot(filters = {}) {
  const db = await openOrderQDb();
  const stores = [STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES];
  const tx = db.transaction(stores, 'readonly');
  const [orders, items, events, snapshots, inventoryLines] = await Promise.all(stores.map(storeName => requestToPromise(tx.objectStore(storeName).getAll())));
  await transactionDone(tx);
  const itemsByOrder = new Map();
  const eventsByOrder = new Map();
  items.forEach(item => {
    const list = itemsByOrder.get(item.orderId) || [];
    list.push(item);
    itemsByOrder.set(item.orderId, list);
  });
  events.forEach(event => {
    const list = eventsByOrder.get(event.orderId) || [];
    list.push(event);
    eventsByOrder.set(event.orderId, list);
  });
  const bundles = orders.map(source => {
    const order = normalizedOrderView(source);
    const orderItems = itemsByOrder.get(order.orderId) || [];
    const orderEvents = eventsByOrder.get(order.orderId) || [];
    return { order, items: orderItems, events: orderEvents, lifecycle: deriveOrderLifecycle(order, orderItems, orderEvents) };
  });
  const filteredBundles = filterOrderBundles(bundles, filters);
  const inventoryByProduct = inventoryMap(snapshots, inventoryLines);
  return {
    bundles,
    filteredBundles,
    rows: aggregateOperationsByProduct(filteredBundles, inventoryByProduct),
    inventoryByProduct
  };
}
