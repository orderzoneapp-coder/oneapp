import { APP_ID, SNAPSHOT_SCHEMA_VERSION, newId, sha256Hex } from './core.js';
import { STORE, getAll, openDb, requestResult, transactionDone } from './db.js';

export const SNAPSHOT_STORES = Object.freeze([
  STORE.CUSTOMERS,
  STORE.ALIASES,
  STORE.EVENTS,
  STORE.SOURCE_LINKS,
  STORE.SOURCE_LINK_EVENTS,
  STORE.HEADER_MAPPINGS,
  STORE.USER_FIELDS,
  STORE.IMPORT_BATCHES,
  STORE.SOURCE_RECORDS,
]);

const PRIMARY_KEYS = Object.freeze({
  [STORE.CUSTOMERS]: 'customerId',
  [STORE.ALIASES]: 'mappingId',
  [STORE.EVENTS]: 'eventId',
  [STORE.SOURCE_LINKS]: 'linkId',
  [STORE.SOURCE_LINK_EVENTS]: 'eventId',
  [STORE.HEADER_MAPPINGS]: 'mappingId',
  [STORE.USER_FIELDS]: 'fieldKey',
  [STORE.IMPORT_BATCHES]: 'importBatchId',
  [STORE.SOURCE_RECORDS]: 'sourceRecordId',
});

export function canonicalSnapshotData(data) {
  return Object.fromEntries(SNAPSHOT_STORES.map((storeName) => {
    const key = PRIMARY_KEYS[storeName];
    const rows = Array.isArray(data?.[storeName]) ? data[storeName] : [];
    return [storeName, rows.slice().sort((left, right) => String(left?.[key] || '').localeCompare(String(right?.[key] || '')))];
  }));
}

export async function snapshotFromData(data, reason = 'MANUAL_EXPORT') {
  const createdAt = new Date().toISOString();
  const canonicalData = canonicalSnapshotData(data);
  const payload = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ownerAppId: APP_ID,
    snapshotId: newId('CMS'),
    snapshotVersion: 1,
    snapshotCreatedAt: createdAt,
    reason,
    counts: Object.fromEntries(SNAPSHOT_STORES.map((name) => [name, canonicalData[name].length])),
    data: canonicalData,
  };
  return { ...payload, contentHash: await sha256Hex(payload) };
}

export async function createSnapshot(reason = 'MANUAL_EXPORT') {
  const values = await Promise.all(SNAPSHOT_STORES.map((name) => getAll(name)));
  return snapshotFromData(Object.fromEntries(SNAPSHOT_STORES.map((name, index) => [name, values[index]])), reason);
}

export async function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || snapshot?.ownerAppId !== APP_ID) {
    throw new Error('거래처관리 Snapshot 형식이 아닙니다.');
  }
  const contentHash = snapshot.contentHash;
  const unsigned = { ...snapshot };
  delete unsigned.contentHash;
  const computedHash = await sha256Hex(unsigned);
  if (contentHash !== computedHash) throw new Error('Snapshot 해시가 일치하지 않습니다. 파일이 변경되었거나 손상되었습니다.');
  SNAPSHOT_STORES.forEach((name) => {
    if (!Array.isArray(snapshot.data?.[name])) throw new Error(`Snapshot Store가 없습니다: ${name}`);
    if (Number(snapshot.counts?.[name]) !== snapshot.data[name].length) throw new Error(`Snapshot 건수가 일치하지 않습니다: ${name}`);
    const key = PRIMARY_KEYS[name];
    const keys = snapshot.data[name].map((row) => String(row?.[key] || ''));
    if (keys.some((value) => !value) || new Set(keys).size !== keys.length) throw new Error(`Snapshot 식별값이 유효하지 않습니다: ${name}`);
  });
  return { valid: true, computedHash };
}

export function downloadSnapshot(snapshot, filename = '') {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename || `customer-master-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

export async function restoreSnapshot(snapshot) {
  await validateSnapshot(snapshot);
  const before = await createSnapshot('PRE_RESTORE_AUTOMATIC');
  const db = await openDb();
  const tx = db.transaction([...SNAPSHOT_STORES, STORE.MIGRATION_SNAPSHOTS, STORE.META], 'readwrite');
  for (const name of SNAPSHOT_STORES) {
    const store = tx.objectStore(name);
    store.clear();
    snapshot.data[name].forEach((row) => store.put(row));
  }
  tx.objectStore(STORE.MIGRATION_SNAPSHOTS).put({
    snapshotId: before.snapshotId,
    kind: 'PRE_RESTORE_AUTOMATIC',
    createdAt: before.snapshotCreatedAt,
    contentHash: before.contentHash,
    snapshot: before,
  });
  const latestRevision = snapshot.data[STORE.EVENTS].reduce((max, row) => Math.max(max, Number(row.headRevision || 0)), 0);
  tx.objectStore(STORE.META).put({ key: 'headRevision', value: latestRevision, updatedAt: new Date().toISOString() });
  tx.objectStore(STORE.META).put({ key: 'lastRestore', value: { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash }, updatedAt: new Date().toISOString() });
  await transactionDone(tx);
  const verification = await createSnapshot('RESTORE_VERIFICATION');
  if (verification.contentHash === snapshot.contentHash) return { restored: true, backupSnapshotId: before.snapshotId, verificationHash: verification.contentHash };
  const sourceDataHash = await sha256Hex(canonicalSnapshotData(snapshot.data));
  const restoredDataHash = await sha256Hex(canonicalSnapshotData(verification.data));
  if (sourceDataHash !== restoredDataHash) throw new Error('복원 후 데이터 동등성 검증에 실패했습니다.');
  return { restored: true, backupSnapshotId: before.snapshotId, verificationHash: restoredDataHash };
}

export async function readSnapshotFile(file) {
  const snapshot = JSON.parse(await file.text());
  await validateSnapshot(snapshot);
  return snapshot;
}

export async function listSafetySnapshots() {
  return (await getAll(STORE.MIGRATION_SNAPSHOTS)).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}
