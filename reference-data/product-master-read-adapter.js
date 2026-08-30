import { cloneJson, deepFreeze, sha256Hex, stableStringify } from './change-request-contract.js';

export const PRODUCT_SNAPSHOT_SCHEMA_VERSION = 'ONEAPP_PRODUCT_SNAPSHOT_V1';
export const PRODUCT_READ_ADAPTER_VERSION = 'ONEAPP_PRODUCT_READ_ADAPTER_V1';
export const PRODUCT_OWNER_APP_ID = 'master-lookup';

const PRODUCT_DB_NAME = 'MerchOpsDB';
const PRODUCT_STORE_NAME = 'master_products';
const KV_STORE_NAME = 'store';
const SNAPSHOT_KEY = 'merchMaster_v870';
const REVISION_KEY = 'merchMaster_revision_v870';

const clean = (value) => String(value ?? '').trim();

function snapshotRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function selectProductSource({ recordRows = [], storeSnapshot = null, localSnapshot = null } = {}) {
  if (Array.isArray(recordRows) && recordRows.length > 0) return { rows: recordRows, source: 'INDEXEDDB_RECORD_STORE' };
  const storedRows = snapshotRows(storeSnapshot);
  if (storedRows.length > 0) return { rows: storedRows, source: 'INDEXEDDB_SNAPSHOT_KEY' };
  const localRows = snapshotRows(localSnapshot);
  if (localRows.length > 0) return { rows: localRows, source: 'LOCAL_STORAGE_SNAPSHOT_KEY' };
  return { rows: [], source: 'EMPTY' };
}

export async function buildProductSnapshot(sources = {}, options = {}) {
  const selected = selectProductSource(sources);
  const products = cloneJson(selected.rows).sort((left, right) => {
    const leftCode = clean(left?.['코드'] ?? left?.['품목코드']);
    const rightCode = clean(right?.['코드'] ?? right?.['품목코드']);
    return leftCode.localeCompare(rightCode, 'ko') || stableStringify(left).localeCompare(stableStringify(right), 'ko');
  });
  const data = { products };
  const contentHash = await sha256Hex(data);
  const explicitRevision = sources.revision === undefined || sources.revision === null ? '' : clean(sources.revision);
  const snapshotVersion = explicitRevision || `HASH-${contentHash}`;
  const status = data.products.length > 0 ? 'READY' : 'EMPTY';
  return deepFreeze({
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
    adapterVersion: PRODUCT_READ_ADAPTER_VERSION,
    ownerAppId: PRODUCT_OWNER_APP_ID,
    status,
    snapshotId: `PRODUCT-${snapshotVersion}-${contentHash.slice(0, 12)}`,
    snapshotVersion,
    snapshotCreatedAt: options.now || new Date().toISOString(),
    contentHash,
    source: selected.source,
    data,
  });
}

function requestResult(request, code) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Object.assign(new Error(code), { cause: request.error }));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(Object.assign(new Error('PRODUCT_DB_READ_FAILED'), { cause: transaction.error }));
    transaction.onabort = () => reject(Object.assign(new Error('PRODUCT_DB_READ_ABORTED'), { cause: transaction.error }));
  });
}

async function productDatabaseExists() {
  if (!globalThis.indexedDB) return false;
  if (typeof globalThis.indexedDB.databases !== 'function') return null;
  const databases = await globalThis.indexedDB.databases();
  return databases.some((entry) => entry?.name === PRODUCT_DB_NAME);
}

function openExistingProductDatabase() {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(PRODUCT_DB_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('PRODUCT_DB_UNEXPECTED_CREATION_BLOCKED'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('PRODUCT_DB_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('PRODUCT_DB_OPEN_BLOCKED'));
  });
}

function readLocalSnapshot() {
  if (!globalThis.localStorage) return null;
  const raw = globalThis.localStorage.getItem(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error('PRODUCT_LOCAL_SNAPSHOT_INVALID'), { cause: error });
  }
}

function readLocalRevision() {
  if (!globalThis.localStorage) return null;
  const value = globalThis.localStorage.getItem(REVISION_KEY);
  return value === null || value === '' ? null : value;
}

async function readProductSources() {
  const exists = await productDatabaseExists();
  if (exists === false) {
    return { recordRows: [], storeSnapshot: null, localSnapshot: readLocalSnapshot(), revision: readLocalRevision() };
  }

  let db;
  try {
    db = await openExistingProductDatabase();
  } catch (error) {
    if (clean(error?.message) === 'PRODUCT_DB_UNEXPECTED_CREATION_BLOCKED') {
      return { recordRows: [], storeSnapshot: null, localSnapshot: readLocalSnapshot(), revision: readLocalRevision() };
    }
    throw error;
  }
  try {
    if (!db.objectStoreNames.contains(PRODUCT_STORE_NAME) || !db.objectStoreNames.contains(KV_STORE_NAME)) {
      throw new Error('PRODUCT_DB_CONTRACT_STORE_MISSING');
    }
    const transaction = db.transaction([PRODUCT_STORE_NAME, KV_STORE_NAME], 'readonly');
    const done = transactionDone(transaction);
    const productStore = transaction.objectStore(PRODUCT_STORE_NAME);
    const kvStore = transaction.objectStore(KV_STORE_NAME);
    const [recordRows, storeSnapshot, revision] = await Promise.all([
      requestResult(productStore.getAll(), 'PRODUCT_RECORD_STORE_READ_FAILED'),
      requestResult(kvStore.get(SNAPSHOT_KEY), 'PRODUCT_SNAPSHOT_KEY_READ_FAILED'),
      requestResult(kvStore.get(REVISION_KEY), 'PRODUCT_REVISION_READ_FAILED'),
    ]);
    await done;
    const needsLocalFallback = (recordRows || []).length === 0 && snapshotRows(storeSnapshot).length === 0;
    return {
      recordRows: recordRows || [],
      storeSnapshot,
      localSnapshot: needsLocalFallback ? readLocalSnapshot() : null,
      revision: revision ?? (needsLocalFallback ? readLocalRevision() : null),
    };
  } finally {
    db.close();
  }
}

function formattedError(error) {
  return deepFreeze({
    code: clean(error?.message) || 'PRODUCT_SNAPSHOT_READ_FAILED',
    message: '상품 기준정보 Snapshot을 읽지 못했습니다.',
    retryable: true,
  });
}

export async function getProductSnapshotResult(options = {}) {
  try {
    const snapshot = await buildProductSnapshot(await readProductSources(), options);
    return deepFreeze({ status: snapshot.status, snapshot, error: null });
  } catch (error) {
    return deepFreeze({ status: 'ERROR', snapshot: null, error: formattedError(error) });
  }
}

export async function getProductSnapshot(options = {}) {
  const result = await getProductSnapshotResult(options);
  if (result.status === 'ERROR') {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    error.retryable = result.error.retryable;
    throw error;
  }
  return result.snapshot;
}

function normalizedSearchText(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
}

export function searchProductSnapshot(snapshot, query, { limit = 20 } = {}) {
  if (!snapshot || snapshot.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.data?.products)) {
    throw new Error('PRODUCT_SNAPSHOT_REQUIRED');
  }
  const needle = normalizedSearchText(query);
  if (!needle) return deepFreeze(cloneJson(snapshot.data.products.slice(0, Math.max(0, limit))));
  const ranked = snapshot.data.products.map((product, index) => {
    const code = normalizedSearchText(product?.['코드'] ?? product?.['품목코드']);
    const name = normalizedSearchText(product?.['품목명'] ?? product?.name);
    const specification = normalizedSearchText(product?.['규격'] ?? product?.specification);
    let score = 0;
    if (code === needle) score = 1000;
    else if (name === needle) score = 900;
    else if (code.startsWith(needle)) score = 800;
    else if (name.includes(needle)) score = 700;
    else if (specification.includes(needle)) score = 500;
    return { product, score, index };
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => cloneJson(entry.product));
  return deepFreeze(ranked);
}

export const productMasterReadAdapter = deepFreeze({
  version: PRODUCT_READ_ADAPTER_VERSION,
  schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
  ownerAppId: PRODUCT_OWNER_APP_ID,
  getSnapshot: getProductSnapshot,
  getSnapshotResult: getProductSnapshotResult,
  search: searchProductSnapshot,
});

globalThis.ONEAPP_PRODUCT_MASTER_READ_ADAPTER = productMasterReadAdapter;
globalThis.ONEAPP_PRODUCT_MASTER_READ_ADAPTER_V1 = productMasterReadAdapter;
