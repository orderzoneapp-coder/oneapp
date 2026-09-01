import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso
} from './orderq-db.js?v=0.8.0';
import { resolveWarehouseInTransaction, warehouseSnapshot } from './warehouse-master.js?v=0.7.1';
import { normalizedOrderView, orderDateKey, formatOrderNo, orderSequenceFromNo } from './order-document-model.js?v=0.7.1';
import {
  getCloudUrl,
  pushCloudChanges,
  pullCloudChanges,
  getCloudOrderHead
} from './orderq-cloud-adapter.js?v=0.7.1';

const DEVICE_KEY = 'oneapp.orderq.device-id.v1';
const META_CURSOR = 'cloudCursor';
const META_BOOTSTRAP = 'phase2BootstrapQueued';

export class CloudOrderConflictError extends Error {
  constructor(orderId, localRevision, serverRevision, serverPayload = null) {
    super('이 주문은 다른 곳에서 이미 수정되었습니다. 최신 내용을 확인한 후 다시 저장해 주세요.');
    this.name = 'CloudOrderConflictError';
    this.code = 'ORDER_CLOUD_REVISION_CONFLICT';
    this.orderId = orderId;
    this.localRevision = Number(localRevision || 0);
    this.serverRevision = Number(serverRevision || 0);
    this.serverPayload = serverPayload;
  }
}

export function getDeviceId() {
  let id = String(localStorage.getItem(DEVICE_KEY) || '');
  if (!id) {
    id = `DEV-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function metaGet(key) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readonly');
  const value = await requestToPromise(tx.objectStore(STORE.META).get(key));
  await transactionDone(tx);
  return value?.value;
}

async function metaSet(key, value) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readwrite');
  tx.objectStore(STORE.META).put({ key, value, updatedAt: nowIso() });
  await transactionDone(tx);
}

async function all(storeName) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = await requestToPromise(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return rows;
}

function makeQueue(entityType, entityId, revision, payload, baseRevision = 0) {
  const timestamp = nowIso();
  return {
    queueId: newId('SQ'),
    entityType,
    entityId,
    operation: 'UPSERT',
    revision: Number(revision || 0),
    baseRevision: Number(baseRevision || 0),
    payload,
    status: 'PENDING',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function ensureOrderNoInTransaction(tx, order) {
  const dateKey = orderDateKey(order.orderDate, new Date(order.createdAt || Date.now()));
  const providedSequence = orderSequenceFromNo(order.orderNo, dateKey);
  const metaStore = tx.objectStore(STORE.META);
  const counterKey = `orderNoSequence:${dateKey}`;
  const counter = await requestToPromise(metaStore.get(counterKey));
  let sequence = Math.max(Number(counter?.value) || 0, providedSequence);
  let orderNo = String(order.orderNo || '').trim();
  if (!orderNo) {
    const existing = await requestToPromise(tx.objectStore(STORE.ORDERS).index('byOrderNo').getAll());
    sequence = Math.max(sequence, ...existing.map(row => orderSequenceFromNo(row.orderNo, dateKey))) + 1;
    orderNo = formatOrderNo(dateKey, sequence);
  }
  metaStore.put({ key: counterKey, value: sequence, updatedAt: nowIso() });
  return { ...order, orderNo };
}

async function bootstrapPhase1References() {
  if (await metaGet(META_BOOTSTRAP)) return;
  const [customers, aliases, events, productMappings, unitMappings, mappingEvents, queue] = await Promise.all([
    all(STORE.CUSTOMERS), all(STORE.CUSTOMER_ALIASES), all(STORE.ORDER_EVENTS),
    all(STORE.PRODUCT_MAPPINGS), all(STORE.UNIT_MAPPINGS), all(STORE.MAPPING_EVENTS), all(STORE.SYNC_QUEUE)
  ]);
  const existing = new Set(queue.map(row => `${row.entityType}:${row.entityId}`));
  const additions = [];
  customers.forEach(row => { if (!existing.has(`CUSTOMER:${row.customerId}`)) additions.push(makeQueue('CUSTOMER', row.customerId, 1, row)); });
  aliases.forEach(row => { if (!existing.has(`CUSTOMER_ALIAS:${row.mappingId}`)) additions.push(makeQueue('CUSTOMER_ALIAS', row.mappingId, 1, row)); });
  events.forEach(row => { if (!existing.has(`ORDER_EVENT:${row.eventId}`)) additions.push(makeQueue('ORDER_EVENT', row.eventId, row.revision || 0, row)); });
  productMappings.forEach(row => { if (!existing.has(`PRODUCT_MAPPING:${row.mappingId}`)) additions.push(makeQueue('PRODUCT_MAPPING', row.mappingId, 1, row)); });
  unitMappings.forEach(row => { if (!existing.has(`UNIT_MAPPING:${row.mappingId}`)) additions.push(makeQueue('UNIT_MAPPING', row.mappingId, 1, row)); });
  mappingEvents.forEach(row => { if (!existing.has(`MAPPING_EVENT:${row.eventId}`)) additions.push(makeQueue('MAPPING_EVENT', row.eventId, 1, row)); });

  if (additions.length) {
    const db = await openOrderQDb();
    const tx = db.transaction(STORE.SYNC_QUEUE, 'readwrite');
    additions.forEach(row => tx.objectStore(STORE.SYNC_QUEUE).add(row));
    await transactionDone(tx);
  }
  await metaSet(META_BOOTSTRAP, true);
}

async function setQueueResult(queueId, patch) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SYNC_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE.SYNC_QUEUE);
  const row = await requestToPromise(store.get(queueId));
  if (row) store.put({ ...row, ...patch, updatedAt: nowIso() });
  await transactionDone(tx);
}

async function discardLocalSourceDuplicate(localOrderId, remotePayload) {
  if (!remotePayload?.order || !localOrderId) return '';
  const canonicalOrderId = remotePayload.order.orderId;
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.PARSE_RESULTS, STORE.SYNC_QUEUE, STORE.META
  ], 'readwrite');
  const orderStore = tx.objectStore(STORE.ORDERS);
  const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
  const eventStore = tx.objectStore(STORE.ORDER_EVENTS);
  const parseStore = tx.objectStore(STORE.PARSE_RESULTS);
  const queueStore = tx.objectStore(STORE.SYNC_QUEUE);
  const [localItems, localEvents, parseResults, queueRows] = await Promise.all([
    requestToPromise(itemStore.index('byOrderId').getAll(localOrderId)),
    requestToPromise(eventStore.index('byOrderId').getAll(localOrderId)),
    requestToPromise(parseStore.index('byOrderId').getAll(localOrderId)),
    requestToPromise(queueStore.getAll())
  ]);
  localItems.forEach(item => itemStore.delete(item.orderItemId));
  localEvents.forEach(event => eventStore.delete(event.eventId));
  orderStore.delete(localOrderId);
  (remotePayload.items || []).forEach(item => itemStore.put(item));
  orderStore.put(normalizedOrderView(await ensureOrderNoInTransaction(tx, remotePayload.order)));
  parseResults.forEach(result => parseStore.put({ ...result, orderId: canonicalOrderId, duplicateOrderId: localOrderId, updatedAt: nowIso() }));
  queueRows.filter(row => row.status === 'PENDING' && (
    (row.entityType === 'ORDER' && row.entityId === localOrderId)
    || (row.entityType === 'ORDER_EVENT' && row.payload?.orderId === localOrderId)
  )).forEach(row => queueStore.put({
    ...row,
    status: 'DISCARDED_DUPLICATE',
    canonicalOrderId,
    resolvedAt: nowIso(),
    updatedAt: nowIso(),
    lastError: '같은 원문으로 먼저 등록된 클라우드 주문을 적용했습니다.'
  }));
  await transactionDone(tx);
  return canonicalOrderId;
}

async function pendingRows(entityId = '') {
  const rows = await all(STORE.SYNC_QUEUE);
  return rows
    .filter(row => row.status === 'PENDING' && (!entityId || row.entityId === entityId))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function toCloudChange(row) {
  const revision = Number(row.revision || 0);
  return {
    queueId: row.queueId,
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation || 'UPSERT',
    revision,
    baseRevision: row.baseRevision !== undefined ? Number(row.baseRevision || 0) : (row.entityType === 'ORDER' ? Math.max(0, revision - 1) : 0),
    payload: row.payload
  };
}

export async function pushPending(entityId = '') {
  if (!getCloudUrl()) return { online: false, applied: 0, conflicts: 0, errors: 0, sourceDuplicates: [] };
  await bootstrapPhase1References();
  const rows = await pendingRows(entityId);
  let applied = 0;
  let conflicts = 0;
  let errors = 0;
  const sourceDuplicates = [];
  for (let start = 0; start < rows.length; start += 50) {
    const batch = rows.slice(start, start + 50);
    const response = await pushCloudChanges(getDeviceId(), batch.map(toCloudChange));
    const byId = new Map((response?.results || []).map(result => [result.queueId, result]));
    for (const row of batch) {
      const result = byId.get(row.queueId);
      if (!result) {
        errors++;
        await setQueueResult(row.queueId, { lastError: '클라우드 응답에서 처리결과를 찾지 못했습니다.' });
        continue;
      }
      if (result.status === 'applied' || result.status === 'duplicate') {
        applied++;
        await setQueueResult(row.queueId, { status: 'ACKED', ackedAt: nowIso(), serverSequence: result.sequence || null, lastError: '' });
      } else if (result.status === 'conflict') {
        conflicts++;
        await setQueueResult(row.queueId, {
          status: 'CONFLICT',
          conflictAt: nowIso(),
          serverRevision: result.serverRevision || 0,
          remotePayload: result.serverPayload || null,
          lastError: '다른 기기에서 먼저 저장된 변경이 있습니다.'
        });
      } else if (result.status === 'source_duplicate' && row.entityType === 'ORDER' && result.serverPayload?.order) {
        const canonicalOrderId = await discardLocalSourceDuplicate(row.entityId, result.serverPayload);
        sourceDuplicates.push({ localOrderId: row.entityId, canonicalOrderId });
      } else if (result.status === 'source_duplicate_event' && row.entityType === 'ORDER_EVENT') {
        await setQueueResult(row.queueId, {
          status: 'DISCARDED_DUPLICATE',
          canonicalOrderId: result.serverOrderId || '',
          resolvedAt: nowIso(),
          lastError: ''
        });
      } else {
        errors++;
        await setQueueResult(row.queueId, { lastError: result.message || '클라우드 저장 오류' });
      }
    }
  }
  return { online: true, applied, conflicts, errors, sourceDuplicates };
}

async function orderHasUnsyncedChange(orderId) {
  const rows = await all(STORE.SYNC_QUEUE);
  return rows.some(row => row.entityType === 'ORDER' && row.entityId === orderId && (row.status === 'PENDING' || row.status === 'CONFLICT'));
}

async function rememberRemoteConflict(orderId, remotePayload, serverRevision) {
  const rows = await all(STORE.SYNC_QUEUE);
  const targets = rows.filter(row => row.entityType === 'ORDER' && row.entityId === orderId && (row.status === 'PENDING' || row.status === 'CONFLICT'));
  for (const row of targets) {
    await setQueueResult(row.queueId, {
      status: 'CONFLICT',
      conflictAt: row.conflictAt || nowIso(),
      serverRevision,
      remotePayload,
      lastError: '다른 기기에서 먼저 저장된 변경이 있습니다.'
    });
  }
}

async function applyRemoteOrder(bundle) {
  if (!bundle?.order) return false;
  const orderId = bundle.order.orderId;
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.WAREHOUSES, STORE.WAREHOUSE_ALIASES, STORE.ORDERS, STORE.ORDER_ITEMS, STORE.META], 'readwrite');
  const orderStore = tx.objectStore(STORE.ORDERS);
  const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
  const current = await requestToPromise(orderStore.get(orderId));
  if (current && Number(current.revision || 0) >= Number(bundle.order.revision || 0)) {
    await transactionDone(tx);
    return false;
  }
  const oldItems = await requestToPromise(itemStore.index('byOrderId').getAll(orderId));
  oldItems.forEach(item => itemStore.delete(item.orderItemId));
  (bundle.items || []).forEach(item => itemStore.put(item));
  const warehouse = await resolveWarehouseInTransaction(tx, bundle.order, { sourceType: 'ORDER_SYNC', sourceId: orderId });
  const remoteOrder = warehouse ? { ...bundle.order, ...warehouseSnapshot(bundle.order, warehouse) } : bundle.order;
  orderStore.put(normalizedOrderView(await ensureOrderNoInTransaction(tx, remoteOrder)));
  await transactionDone(tx);
  return true;
}

async function applySimple(entityType, payload) {
  if (!payload) return false;
  const mapping = {
    CUSTOMER: [STORE.CUSTOMERS, 'customerId'],
    PRODUCT: [STORE.PRODUCTS, 'productId'],
    CUSTOMER_ALIAS: [STORE.CUSTOMER_ALIASES, 'mappingId'],
    PRODUCT_MAPPING: [STORE.PRODUCT_MAPPINGS, 'mappingId'],
    UNIT_MAPPING: [STORE.UNIT_MAPPINGS, 'mappingId'],
    MAPPING_EVENT: [STORE.MAPPING_EVENTS, 'eventId'],
    ORDER_EVENT: [STORE.ORDER_EVENTS, 'eventId'],
    IMPORT_BATCH: [STORE.IMPORT_BATCHES, 'importBatchId'],
    SOURCE_RECORD: [STORE.SOURCE_RECORDS, 'sourceRecordId'],
    SALES_DOCUMENT: [STORE.SALES_DOCUMENTS, 'salesDocumentId'],
    SALES_LINE: [STORE.SALES_LINES, 'salesLineId'],
    PURCHASE_DOCUMENT: [STORE.PURCHASE_DOCUMENTS, 'purchaseDocumentId'],
    PURCHASE_LINE: [STORE.PURCHASE_LINES, 'purchaseLineId'],
    LEDGER_DOCUMENT: [STORE.LEDGER_DOCUMENTS, 'ledgerDocumentId'],
    LEDGER_LINE: [STORE.LEDGER_LINES, 'ledgerLineId'],
    INVENTORY_SNAPSHOT: [STORE.INVENTORY_SNAPSHOTS, 'inventorySnapshotId'],
    INVENTORY_LINE: [STORE.INVENTORY_LINES, 'inventoryLineId'],
    HISTORICAL_ORDER_GROUP: [STORE.HISTORICAL_ORDER_GROUPS, 'historicalOrderGroupId'],
    HISTORICAL_ORDER_LINE: [STORE.HISTORICAL_ORDER_LINES, 'historicalOrderLineId'],
    FULFILLMENT_LINK: [STORE.FULFILLMENT_LINKS, 'fulfillmentLinkId'],
    FULFILLMENT_BALANCE: [STORE.FULFILLMENT_BALANCES, 'fulfillmentBalanceId'],
    PARSER_EVIDENCE: [STORE.PARSER_EVIDENCE, 'parserEvidenceId'],
    COLLECTOR_SETTING: [STORE.COLLECTOR_SETTINGS, 'key']
  }[entityType];
  if (!mapping || !payload[mapping[1]]) return false;
  const hasWarehouse = Boolean(payload.warehouseId || payload.warehouseCode || payload.warehouseName || payload.warehouse);
  const db = await openOrderQDb();
  const stores = hasWarehouse ? [mapping[0], STORE.WAREHOUSES, STORE.WAREHOUSE_ALIASES] : [mapping[0]];
  const tx = db.transaction(stores, 'readwrite');
  const warehouse = hasWarehouse
    ? await resolveWarehouseInTransaction(tx, payload, { sourceType: `${entityType}_SYNC`, sourceId: payload[mapping[1]] })
    : null;
  tx.objectStore(mapping[0]).put(warehouse ? { ...payload, ...warehouseSnapshot(payload, warehouse) } : payload);
  await transactionDone(tx);
  return true;
}

async function applyCloudChange(change) {
  if (!change?.payload) return false;
  if (change.entityType === 'ORDER') {
    const orderId = change.entityId;
    if (await orderHasUnsyncedChange(orderId)) {
      await rememberRemoteConflict(orderId, change.payload, change.payload?.order?.revision || change.revision || 0);
      return false;
    }
    return applyRemoteOrder(change.payload);
  }
  return applySimple(change.entityType, change.payload);
}

export async function pullRemote() {
  if (!getCloudUrl()) return { online: false, applied: 0, cursor: Number(await metaGet(META_CURSOR) || 0), conflicts: 0 };
  let cursor = Number(await metaGet(META_CURSOR) || 0);
  let applied = 0;
  let conflicts = 0;
  for (let page = 0; page < 20; page++) {
    const result = await pullCloudChanges(cursor, 200);
    for (const change of result?.changes || []) {
      if (change.entityType === 'ORDER' && await orderHasUnsyncedChange(change.entityId)) conflicts++;
      if (await applyCloudChange(change)) applied++;
    }
    cursor = Number(result?.nextCursor || cursor);
    await metaSet(META_CURSOR, cursor);
    if (!result?.hasMore) break;
  }
  return { online: true, applied, cursor, conflicts };
}

export async function syncNow() {
  if (!getCloudUrl()) return { online: false, push: null, pull: null };
  await bootstrapPhase1References();
  const push = await pushPending();
  const pull = await pullRemote();
  return { online: true, push, pull };
}

export async function syncBeforeOrderMutation(orderId, expectedRevision) {
  if (!getCloudUrl() || !orderId) return { online: false };
  try {
    const head = await getCloudOrderHead(orderId);
    const serverRevision = Number(head?.revision || 0);
    const localRevision = Number(expectedRevision || 0);
    if (serverRevision > localRevision) {
      if (!await orderHasUnsyncedChange(orderId) && head?.payload) await applyRemoteOrder(head.payload);
      throw new CloudOrderConflictError(orderId, localRevision, serverRevision, head?.payload || null);
    }
    return { online: true, serverRevision };
  } catch (error) {
    if (error instanceof CloudOrderConflictError) throw error;
    return { online: false, error };
  }
}

export async function syncAfterLocalMutation(orderId = '') {
  if (!getCloudUrl()) return { online: false };
  // 주문과 함께 생성되는 Customer/Alias/Event 큐도 같은 저장 단위에서 바로 전송한다.
  const push = await pushPending();
  const rows = await all(STORE.SYNC_QUEUE);
  const conflict = rows.find(row => row.entityType === 'ORDER' && row.entityId === orderId && row.status === 'CONFLICT');
  if (conflict) throw new CloudOrderConflictError(orderId, conflict.revision, conflict.serverRevision, conflict.remotePayload || null);
  const pull = await pullRemote();
  const sourceDuplicate = (push.sourceDuplicates || []).find(row => row.localOrderId === orderId) || null;
  return { online: true, push, pull, sourceDuplicate, canonicalOrderId: sourceDuplicate?.canonicalOrderId || orderId };
}

export async function acceptRemoteOrder(orderId) {
  const rows = await all(STORE.SYNC_QUEUE);
  const conflicts = rows.filter(row => row.entityType === 'ORDER' && row.entityId === orderId && row.status === 'CONFLICT');
  const remote = conflicts.map(row => row.remotePayload).find(payload => payload?.order);
  if (!remote) throw new Error('적용할 클라우드 최신본이 없습니다.');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.SYNC_QUEUE, STORE.META], 'readwrite');
  const orderStore = tx.objectStore(STORE.ORDERS);
  const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
  const queueStore = tx.objectStore(STORE.SYNC_QUEUE);
  const oldItems = await requestToPromise(itemStore.index('byOrderId').getAll(orderId));
  oldItems.forEach(item => itemStore.delete(item.orderItemId));
  (remote.items || []).forEach(item => itemStore.put(item));
  orderStore.put(normalizedOrderView(await ensureOrderNoInTransaction(tx, remote.order)));
  conflicts.forEach(row => queueStore.put({ ...row, status: 'DISCARDED', resolvedAt: nowIso(), updatedAt: nowIso() }));
  await transactionDone(tx);
  return remote;
}

export async function getSyncState() {
  const rows = await all(STORE.SYNC_QUEUE);
  return {
    cloudUrl: getCloudUrl(),
    deviceId: getDeviceId(),
    cursor: Number(await metaGet(META_CURSOR) || 0),
    pending: rows.filter(row => row.status === 'PENDING').length,
    conflicts: rows.filter(row => row.status === 'CONFLICT'),
    acked: rows.filter(row => row.status === 'ACKED').length
  };
}
