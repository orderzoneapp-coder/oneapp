import { DB_NAME, sha256Hex } from './core.js';
import { STORE, count, initializeDb, openDb, readStores, requestResult, transactionDone } from './db.js';
import { SNAPSHOT_STORES, canonicalSnapshotData, snapshotFromData } from './backup.js';

export const LEGACY_DB_NAME = 'oneapp-orderq-vnext';
export const LEGACY_EXPECTED_VERSION = 17;

const LEGACY_STORE_MAP = Object.freeze({
  [STORE.CUSTOMERS]: 'customers',
  [STORE.ALIASES]: 'customerAliases',
  [STORE.EVENTS]: 'customerEvents',
  [STORE.SOURCE_LINKS]: 'customerSourceLinks',
  [STORE.SOURCE_LINK_EVENTS]: 'customerSourceLinkEvents',
  [STORE.HEADER_MAPPINGS]: 'customerHeaderMappings',
  [STORE.USER_FIELDS]: 'customerUserFieldDefinitions',
  [STORE.IMPORT_BATCHES]: 'importBatches',
  [STORE.SOURCE_RECORDS]: 'sourceRecords',
});

async function databaseDescriptor() {
  if (typeof indexedDB.databases !== 'function') return null;
  const databases = await indexedDB.databases();
  return databases.find((entry) => entry.name === LEGACY_DB_NAME) || null;
}

function openLegacyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME);
    let missing = false;
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => missing ? resolve(null) : reject(request.error || new Error('LEGACY_DB_OPEN_FAILED'));
  });
}

async function transactionFinished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('LEGACY_DB_READ_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('LEGACY_DB_READ_ABORTED'));
  });
}

export async function inspectLegacyCustomerData() {
  const descriptor = await databaseDescriptor();
  if (!descriptor) return { found: false, database: LEGACY_DB_NAME };
  const db = await openLegacyDb();
  if (!db) return { found: false, database: LEGACY_DB_NAME };
  const version = Number(db.version || descriptor.version || 0);
  const availableStores = Object.values(LEGACY_STORE_MAP).filter((name) => db.objectStoreNames.contains(name));
  if (!availableStores.includes('customers')) {
    db.close();
    return { found: true, compatible: false, version, reason: '거래처 Store가 없습니다.' };
  }
  const tx = db.transaction(availableStores, 'readonly');
  const rawValues = Object.fromEntries(await Promise.all(availableStores.map(async (name) => [name, await requestResult(tx.objectStore(name).getAll())])));
  await transactionFinished(tx);
  db.close();
  const customerBatchIds = new Set((rawValues.importBatches || [])
    .filter((row) => /CUSTOMER/i.test(String(row.sourceType || '')))
    .map((row) => row.importBatchId));
  const data = Object.fromEntries(SNAPSHOT_STORES.map((newName) => {
    const legacyName = LEGACY_STORE_MAP[newName];
    let rows = rawValues[legacyName] || [];
    if (newName === STORE.IMPORT_BATCHES) rows = rows.filter((row) => customerBatchIds.has(row.importBatchId));
    if (newName === STORE.SOURCE_RECORDS) rows = rows.filter((row) => customerBatchIds.has(row.importBatchId) || /CUSTOMER/i.test(String(row.sourceType || '')));
    return [newName, rows];
  }));
  const canonical = canonicalSnapshotData(data);
  const contentHash = await sha256Hex(canonical);
  return {
    found: true,
    compatible: version === LEGACY_EXPECTED_VERSION,
    database: LEGACY_DB_NAME,
    version,
    destinationDatabase: DB_NAME,
    data: canonical,
    counts: Object.fromEntries(SNAPSHOT_STORES.map((name) => [name, canonical[name].length])),
    contentHash,
    inspectedAt: new Date().toISOString(),
  };
}

export async function migrateLegacyCustomerData(inspection) {
  if (!inspection?.found || !inspection.compatible || !inspection.data) throw new Error('이전 가능한 v17 거래처 데이터가 아닙니다.');
  if (await count(STORE.CUSTOMERS)) throw new Error('새 거래처관리 DB에 데이터가 있어 자동 이전할 수 없습니다. Snapshot으로 보존한 뒤 별도 병합해야 합니다.');
  const destinationBefore = await readStores(SNAPSHOT_STORES);
  const nonDefaultDestinationRows = SNAPSHOT_STORES.flatMap((name) => {
    if (name !== STORE.USER_FIELDS) return destinationBefore[name];
    return destinationBefore[name].filter((row) => row.enabled || row.displayName || Number(row.revision || 1) !== 1);
  });
  if (nonDefaultDestinationRows.length) throw new Error('새 거래처관리 DB에 기존 작업 데이터가 있어 자동 이전할 수 없습니다. Snapshot으로 보존한 뒤 별도 병합해야 합니다.');
  const safetySnapshot = await snapshotFromData(inspection.data, 'LEGACY_V17_READ_ONLY_SOURCE');
  const db = await openDb();
  const tx = db.transaction([...SNAPSHOT_STORES, STORE.MIGRATION_SNAPSHOTS, STORE.META], 'readwrite');
  SNAPSHOT_STORES.forEach((name) => {
    const store = tx.objectStore(name);
    store.clear();
    inspection.data[name].forEach((row) => store.put(row));
  });
  tx.objectStore(STORE.MIGRATION_SNAPSHOTS).put({
    snapshotId: safetySnapshot.snapshotId,
    kind: 'LEGACY_V17_READ_ONLY_SOURCE',
    createdAt: safetySnapshot.snapshotCreatedAt,
    contentHash: safetySnapshot.contentHash,
    sourceDatabase: LEGACY_DB_NAME,
    sourceVersion: inspection.version,
    snapshot: safetySnapshot,
  });
  tx.objectStore(STORE.META).put({
    key: 'legacyMigration.v17',
    value: { sourceDatabase: LEGACY_DB_NAME, sourceVersion: inspection.version, contentHash: inspection.contentHash, counts: inspection.counts, migratedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
  await transactionDone(tx);
  const verificationData = Object.fromEntries(await Promise.all(SNAPSHOT_STORES.map(async (name) => {
    const verifyDb = await openDb();
    const verifyTx = verifyDb.transaction(name, 'readonly');
    const rows = await requestResult(verifyTx.objectStore(name).getAll());
    await transactionDone(verifyTx);
    return [name, rows];
  })));
  const verificationHash = await sha256Hex(canonicalSnapshotData(verificationData));
  if (verificationHash !== inspection.contentHash) throw new Error('v17 이전 후 데이터 동등성 검증에 실패했습니다.');
  await initializeDb();
  return { migrated: true, counts: inspection.counts, sourceHash: inspection.contentHash, destinationHash: verificationHash, snapshotId: safetySnapshot.snapshotId };
}
