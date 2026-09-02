import {
  STORE,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import {
  getCloudUrl,
  pullOfficialCloudChanges,
  pushOfficialCloudChanges
} from './orderq-cloud-adapter.js?v=0.8.0';
import {
  applyRemoteOfficialVoucherCommandPayload,
  applyRemotePendingInventoryResolutionPayload
} from './official-voucher-repository.js?v=0.24.0';

const DEVICE_KEY = 'oneapp.orderq.device-id.v1';
const OFFICIAL_ENTITY_TYPES = new Set(['OFFICIAL_VOUCHER_COMMAND', 'PENDING_INVENTORY_RESOLUTION']);
const WAITING_STATUSES = new Set(['WAITING_SERVER_CONTRACT', 'PENDING']);
const text = value => String(value ?? '').trim();

function deviceId() {
  let value = text(localStorage.getItem(DEVICE_KEY));
  if (!value) {
    value = `DEV-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}

function cursorKey(companyId) {
  return `officialCloudCursorV1:${text(companyId)}`;
}

async function all(storeName) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = await requestToPromise(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return rows;
}

async function metaGet(key) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readonly');
  const row = await requestToPromise(tx.objectStore(STORE.META).get(key));
  await transactionDone(tx);
  return row?.value;
}

async function metaSet(key, value) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readwrite');
  tx.objectStore(STORE.META).put({ key, value, updatedAt: nowIso() });
  await transactionDone(tx);
}

async function setQueueResult(queueId, patch) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SYNC_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE.SYNC_QUEUE);
  const row = await requestToPromise(store.get(queueId));
  if (row) store.put({ ...row, ...patch, updatedAt: nowIso() });
  await transactionDone(tx);
}

function companyOf(row) {
  return text(row?.payload?.companyId || row?.payload?.command?.companyId || row?.payload?.productResolution?.companyId);
}

function toCloudChange(row) {
  return {
    queueId: row.queueId,
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation || 'UPSERT',
    revision: Number(row.revision || 0),
    payload: row.payload
  };
}

export async function pushOfficialPending(companyId = '') {
  const requestedCompanyId = text(companyId);
  const rows = (await all(STORE.SYNC_QUEUE))
    .filter(row => OFFICIAL_ENTITY_TYPES.has(row.entityType) && WAITING_STATUSES.has(row.status)
      && (!requestedCompanyId || companyOf(row) === requestedCompanyId))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if (!getCloudUrl()) return { online: false, contractAvailable: false, applied: 0, conflicts: 0, errors: 0, waiting: rows.length };
  let applied = 0;
  let conflicts = 0;
  let errors = 0;
  const groups = new Map();
  rows.forEach(row => {
    const key = companyOf(row);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  try {
    for (const [targetCompanyId, companyRows] of groups.entries()) {
      for (let start = 0; start < companyRows.length; start += 10) {
        const batch = companyRows.slice(start, start + 10);
        const response = await pushOfficialCloudChanges(targetCompanyId, deviceId(), batch.map(toCloudChange));
        const byId = new Map((response?.results || []).map(result => [result.queueId, result]));
        for (const row of batch) {
          const result = byId.get(row.queueId);
          if (result?.status === 'applied' || result?.status === 'duplicate') {
            applied += 1;
            await setQueueResult(row.queueId, { status: 'ACKED', ackedAt: nowIso(), serverSequence: result.sequence || null, lastError: '' });
          } else if (result?.status === 'conflict') {
            conflicts += 1;
            await setQueueResult(row.queueId, { status: 'CONFLICT', conflictAt: nowIso(), serverRevision: result.serverRevision || 0,
              remotePayload: result.serverPayload || null, lastError: '다른 기기에서 같은 전표를 먼저 확정했습니다.' });
          } else {
            errors += 1;
            await setQueueResult(row.queueId, { lastError: result?.message || '공식 전표 서버 저장 오류' });
          }
        }
      }
    }
    return { online: true, contractAvailable: true, applied, conflicts, errors, waiting: rows.length - applied - conflicts };
  } catch (error) {
    return { online: false, contractAvailable: false, applied, conflicts, errors: errors + rows.length - applied - conflicts,
      waiting: rows.length - applied - conflicts, error };
  }
}

async function rememberRemoteConflict(companyId, change, error) {
  const queueId = `REMOTE_OFFICIAL:${companyId}:${change.sequence}`;
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SYNC_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE.SYNC_QUEUE);
  const existing = await requestToPromise(store.get(queueId));
  store.put({ ...existing, queueId, companyId, entityType: change.entityType, entityId: change.entityId,
    operation: 'REMOTE_APPLY', revision: Number(change.revision || 0), payload: change.payload,
    status: 'CONFLICT', remoteSequence: Number(change.sequence || 0), remotePayload: change.payload,
    conflictAt: existing?.conflictAt || nowIso(), createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(),
    lastError: text(error?.message || error) });
  await transactionDone(tx);
}

async function applyRemoteChange(change) {
  if (change.entityType === 'OFFICIAL_VOUCHER_COMMAND') return applyRemoteOfficialVoucherCommandPayload(change.payload);
  if (change.entityType === 'PENDING_INVENTORY_RESOLUTION') return applyRemotePendingInventoryResolutionPayload(change.payload);
  throw new Error(`ORDERQ_OFFICIAL_REMOTE_ENTITY_UNSUPPORTED:${change.entityType}`);
}

export async function pullOfficialRemote(companyId) {
  const targetCompanyId = text(companyId);
  if (!targetCompanyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  let cursor = Number(await metaGet(cursorKey(targetCompanyId)) || 0);
  if (!getCloudUrl()) return { online: false, contractAvailable: false, applied: 0, conflicts: 0, cursor };
  let applied = 0;
  let conflicts = 0;
  try {
    for (let page = 0; page < 50; page += 1) {
      const response = await pullOfficialCloudChanges(targetCompanyId, cursor, 100);
      for (const change of response?.changes || []) {
        try {
          await applyRemoteChange(change);
        } catch (error) {
          conflicts += 1;
          await rememberRemoteConflict(targetCompanyId, change, error);
          return { online: true, contractAvailable: true, applied, conflicts, cursor, error };
        }
        cursor = Number(change.sequence || cursor);
        await metaSet(cursorKey(targetCompanyId), cursor);
        applied += 1;
      }
      if (!response?.hasMore) break;
    }
    return { online: true, contractAvailable: true, applied, conflicts, cursor };
  } catch (error) {
    return { online: false, contractAvailable: false, applied, conflicts, cursor, error };
  }
}

export async function syncOfficialVouchers(companyId) {
  const targetCompanyId = text(companyId);
  const push = await pushOfficialPending(targetCompanyId);
  if (push.error && !push.contractAvailable) return { online: false, push, pulls: [] };
  const companies = targetCompanyId ? [targetCompanyId] : [...new Set((await all(STORE.SYNC_QUEUE)).map(companyOf).filter(Boolean))];
  const pulls = [];
  for (const id of companies) pulls.push(await pullOfficialRemote(id));
  return { online: Boolean(push.online || pulls.some(row => row.online)), push, pulls };
}

export async function syncOfficialAfterLocalMutation(companyId) {
  return syncOfficialVouchers(companyId);
}

export async function getOfficialSyncState(companyId = '') {
  const targetCompanyId = text(companyId);
  const rows = (await all(STORE.SYNC_QUEUE)).filter(row => OFFICIAL_ENTITY_TYPES.has(row.entityType)
    && (!targetCompanyId || companyOf(row) === targetCompanyId));
  return {
    companyId: targetCompanyId,
    cursor: targetCompanyId ? Number(await metaGet(cursorKey(targetCompanyId)) || 0) : 0,
    waiting: rows.filter(row => WAITING_STATUSES.has(row.status)).length,
    conflicts: rows.filter(row => row.status === 'CONFLICT'),
    acked: rows.filter(row => row.status === 'ACKED').length
  };
}
