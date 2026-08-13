import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso
} from './orderq-db.js';
import {
  getCloudUrl,
  pushCloudChanges,
  pullCloudChanges,
  getCloudOrderHead
} from './orderq-cloud-adapter.js';

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
  if (!getCloudUrl()) return { online: false, applied: 0, conflicts: 0, errors: 0 };
  await bootstrapPhase1References();
  const rows = await pendingRows(entityId);
  let applied = 0;
  let conflicts = 0;
  let errors = 0;
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
      } else {
        errors++;
        await setQueueResult(row.queueId, { lastError: result.message || '클라우드 저장 오류' });
      }
    }
  }
  return { online: true, applied, conflicts, errors };
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
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS], 'readwrite');
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
  orderStore.put(bundle.order);
  await transactionDone(tx);
  return true;
}

async function applySimple(entityType, payload) {
  if (!payload) return false;
  const mapping = {
    CUSTOMER: [STORE.CUSTOMERS, 'customerId'],
    CUSTOMER_ALIAS: [STORE.CUSTOMER_ALIASES, 'mappingId'],
    PRODUCT_MAPPING: [STORE.PRODUCT_MAPPINGS, 'mappingId'],
    UNIT_MAPPING: [STORE.UNIT_MAPPINGS, 'mappingId'],
    MAPPING_EVENT: [STORE.MAPPING_EVENTS, 'eventId'],
    ORDER_EVENT: [STORE.ORDER_EVENTS, 'eventId']
  }[entityType];
  if (!mapping || !payload[mapping[1]]) return false;
  const db = await openOrderQDb();
  const tx = db.transaction(mapping[0], 'readwrite');
  tx.objectStore(mapping[0]).put(payload);
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
  const push = await pushPending(orderId);
  const rows = await all(STORE.SYNC_QUEUE);
  const conflict = rows.find(row => row.entityType === 'ORDER' && row.entityId === orderId && row.status === 'CONFLICT');
  if (conflict) throw new CloudOrderConflictError(orderId, conflict.revision, conflict.serverRevision, conflict.remotePayload || null);
  const pull = await pullRemote();
  return { online: true, push, pull };
}

export async function acceptRemoteOrder(orderId) {
  const rows = await all(STORE.SYNC_QUEUE);
  const conflicts = rows.filter(row => row.entityType === 'ORDER' && row.entityId === orderId && row.status === 'CONFLICT');
  const remote = conflicts.map(row => row.remotePayload).find(payload => payload?.order);
  if (!remote) throw new Error('적용할 클라우드 최신본이 없습니다.');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.SYNC_QUEUE], 'readwrite');
  const orderStore = tx.objectStore(STORE.ORDERS);
  const itemStore = tx.objectStore(STORE.ORDER_ITEMS);
  const queueStore = tx.objectStore(STORE.SYNC_QUEUE);
  const oldItems = await requestToPromise(itemStore.index('byOrderId').getAll(orderId));
  oldItems.forEach(item => itemStore.delete(item.orderItemId));
  (remote.items || []).forEach(item => itemStore.put(item));
  orderStore.put(remote.order);
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
