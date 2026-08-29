import { DB_NAME, DB_VERSION } from './core.js';

export const STORE = Object.freeze({
  CUSTOMERS: 'customers',
  ALIASES: 'customerAliases',
  EVENTS: 'customerEvents',
  SOURCE_LINKS: 'customerSourceLinks',
  SOURCE_LINK_EVENTS: 'customerSourceLinkEvents',
  HEADER_MAPPINGS: 'customerHeaderMappings',
  USER_FIELDS: 'customerUserFieldDefinitions',
  IMPORT_BATCHES: 'importBatches',
  SOURCE_RECORDS: 'sourceRecords',
  MIGRATION_SNAPSHOTS: 'migrationSnapshots',
  META: 'appMeta',
});

const testName = (() => {
  try {
    const value = new URLSearchParams(location.search).get('customerMasterTestDb') || '';
    return /^[a-z0-9._-]{1,100}$/i.test(value) ? value : '';
  } catch { return ''; }
})();

export const ACTIVE_DB_NAME = testName || DB_NAME;
let dbPromise = null;

const ensureIndex = (store, name, keyPath, options = {}) => {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
};

function upgrade(db) {
  let store = db.createObjectStore(STORE.CUSTOMERS, { keyPath: 'customerId' });
  ensureIndex(store, 'byNormalizedCustomerCode', 'normalizedCustomerCode');
  ensureIndex(store, 'byNormalizedName', 'normalizedName');
  ensureIndex(store, 'byStatusQuality', ['status', 'qualityStatus']);
  ensureIndex(store, 'byUpdatedAt', 'updatedAt');

  store = db.createObjectStore(STORE.ALIASES, { keyPath: 'mappingId' });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'byNormalizedText', 'normalizedText');

  store = db.createObjectStore(STORE.EVENTS, { keyPath: 'eventId' });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'byOccurredAt', 'occurredAt');
  ensureIndex(store, 'byOperationId', 'operationId', { unique: true });

  store = db.createObjectStore(STORE.SOURCE_LINKS, { keyPath: 'linkId' });
  ensureIndex(store, 'bySourceLinkKey', 'sourceLinkKey', { unique: true });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'bySourceSystem', 'sourceSystem');

  store = db.createObjectStore(STORE.SOURCE_LINK_EVENTS, { keyPath: 'eventId' });
  ensureIndex(store, 'byLinkId', 'linkId');
  ensureIndex(store, 'byOccurredAt', 'occurredAt');

  store = db.createObjectStore(STORE.HEADER_MAPPINGS, { keyPath: 'mappingId' });
  ensureIndex(store, 'bySourceHeader', ['sourceSystem', 'normalizedHeader'], { unique: true });

  store = db.createObjectStore(STORE.USER_FIELDS, { keyPath: 'fieldKey' });
  ensureIndex(store, 'byTypeOrder', ['fieldType', 'displayOrder']);

  store = db.createObjectStore(STORE.IMPORT_BATCHES, { keyPath: 'importBatchId' });
  ensureIndex(store, 'byFileHash', 'fileHash');
  ensureIndex(store, 'byStatusUpdatedAt', ['status', 'updatedAt']);

  store = db.createObjectStore(STORE.SOURCE_RECORDS, { keyPath: 'sourceRecordId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');

  db.createObjectStore(STORE.MIGRATION_SNAPSHOTS, { keyPath: 'snapshotId' });
  db.createObjectStore(STORE.META, { keyPath: 'key' });
}

export function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('INDEXEDDB_REQUEST_FAILED'));
  });
}

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('INDEXEDDB_TRANSACTION_FAILED'));
    transaction.onabort = () => reject(transaction.error || new Error('INDEXEDDB_TRANSACTION_ABORTED'));
  });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) upgrade(request.result);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('CUSTOMER_DB_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('CUSTOMER_DB_UPGRADE_BLOCKED'));
  });
  return dbPromise;
}

export async function getAll(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = await requestResult(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return rows;
}

export async function getByKey(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const row = await requestResult(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return row;
}

export async function count(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const value = await requestResult(tx.objectStore(storeName).count());
  await transactionDone(tx);
  return value;
}

export async function initializeDb() {
  const db = await openDb();
  const tx = db.transaction([STORE.USER_FIELDS, STORE.META, STORE.IMPORT_BATCHES], 'readwrite');
  const userStore = tx.objectStore(STORE.USER_FIELDS);
  const metaStore = tx.objectStore(STORE.META);
  const batchStore = tx.objectStore(STORE.IMPORT_BATCHES);
  const [definitions, schemaRow, batches] = await Promise.all([
    requestResult(userStore.getAll()),
    requestResult(metaStore.get('schema')),
    requestResult(batchStore.getAll()),
  ]);
  const existing = new Set(definitions.map((row) => row.fieldKey));
  const timestamp = new Date().toISOString();
  [...Array.from({ length: 10 }, (_, index) => ({ fieldKey: `userText${String(index + 1).padStart(2, '0')}`, fieldType: 'TEXT', displayOrder: index + 1 })),
    ...Array.from({ length: 10 }, (_, index) => ({ fieldKey: `userNumber${String(index + 1).padStart(2, '0')}`, fieldType: 'NUMBER', displayOrder: index + 1 }))]
    .filter((row) => !existing.has(row.fieldKey))
    .forEach((row) => userStore.put({ ...row, displayName: '', headerAliases: [], enabled: false, revision: 1, createdAt: timestamp, updatedAt: timestamp }));
  if (!schemaRow) metaStore.put({ key: 'schema', value: { database: ACTIVE_DB_NAME, version: DB_VERSION }, updatedAt: timestamp });
  batches.filter((row) => row.status === 'APPLYING').forEach((row) => batchStore.put({ ...row, status: 'PARTIAL', updatedAt: timestamp }));
  await transactionDone(tx);
}

export async function readStores(storeNames) {
  const db = await openDb();
  const tx = db.transaction(storeNames, 'readonly');
  const values = await Promise.all(storeNames.map((name) => requestResult(tx.objectStore(name).getAll())));
  await transactionDone(tx);
  return Object.fromEntries(storeNames.map((name, index) => [name, values[index]]));
}
