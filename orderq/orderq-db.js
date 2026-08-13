const DB_NAME = 'oneapp-orderq-vnext';
const DB_VERSION = 2;

export const STORE = Object.freeze({
  CUSTOMERS: 'customers',
  PRODUCTS: 'products',
  CUSTOMER_ALIASES: 'customerAliases',
  PRODUCT_MAPPINGS: 'productMappings',
  UNIT_MAPPINGS: 'unitMappings',
  RAW_INPUTS: 'rawInputs',
  PARSE_RESULTS: 'parseResults',
  MAPPING_EVENTS: 'mappingEvents',
  ORDERS: 'orders',
  ORDER_ITEMS: 'orderItems',
  ORDER_EVENTS: 'orderEvents',
  SYNC_QUEUE: 'syncQueue',
  META: 'meta'
});

let dbPromise = null;

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function upgrade(db, transaction) {
  const ensureStore = (name, options) => {
    if (!db.objectStoreNames.contains(name)) return db.createObjectStore(name, options);
    return transaction.objectStore(name);
  };

  let store = ensureStore(STORE.CUSTOMERS, { keyPath: 'customerId' });
  ensureIndex(store, 'byName', 'normalizedName');
  ensureIndex(store, 'byErpCode', 'erpCustomerCode');
  ensureIndex(store, 'byUpdatedAt', 'updatedAt');

  store = ensureStore(STORE.PRODUCTS, { keyPath: 'productId' });
  ensureIndex(store, 'byCode', 'itemCode', { unique: false });
  ensureIndex(store, 'byName', 'normalizedName');

  store = ensureStore(STORE.CUSTOMER_ALIASES, { keyPath: 'mappingId' });
  ensureIndex(store, 'byNormalizedText', 'normalizedText');
  ensureIndex(store, 'byCustomerText', ['customerId', 'normalizedText']);
  ensureIndex(store, 'bySourceText', ['sourceId', 'normalizedText']);
  ensureIndex(store, 'byCustomerId', 'customerId');

  store = ensureStore(STORE.PRODUCT_MAPPINGS, { keyPath: 'mappingId' });
  ensureIndex(store, 'byCustomerText', ['customerId', 'normalizedText']);
  ensureIndex(store, 'bySourceText', ['sourceId', 'normalizedText']);
  ensureIndex(store, 'byNormalizedText', 'normalizedText');
  ensureIndex(store, 'byProductId', 'productId');

  store = ensureStore(STORE.UNIT_MAPPINGS, { keyPath: 'mappingId' });
  ensureIndex(store, 'byProductRawUnit', ['productId', 'rawUnit']);
  ensureIndex(store, 'byGroupRawUnit', ['productGroup', 'rawUnit']);

  store = ensureStore(STORE.RAW_INPUTS, { keyPath: 'rawInputId' });
  ensureIndex(store, 'bySource', ['sourceType', 'sourceId']);
  ensureIndex(store, 'byFingerprint', 'fingerprint', { unique: true });
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.PARSE_RESULTS, { keyPath: 'parseResultId' });
  ensureIndex(store, 'byRawInputId', 'rawInputId');
  ensureIndex(store, 'bySourceMessageKey', 'sourceMessageKey', { unique: true });
  ensureIndex(store, 'byOrderId', 'orderId');
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.MAPPING_EVENTS, { keyPath: 'eventId' });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'byProductId', 'productId');
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.ORDERS, { keyPath: 'orderId' });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'bySourceMessageKey', 'sourceMessageKey', { unique: true });
  ensureIndex(store, 'byOrderDate', 'orderDate');
  ensureIndex(store, 'byUpdatedAt', 'updatedAt');
  ensureIndex(store, 'byStatus', 'status');

  store = ensureStore(STORE.ORDER_ITEMS, { keyPath: 'orderItemId' });
  ensureIndex(store, 'byOrderId', 'orderId');
  ensureIndex(store, 'byOrderStatus', ['orderId', 'matchStatus']);
  ensureIndex(store, 'byProductId', 'productId');

  store = ensureStore(STORE.ORDER_EVENTS, { keyPath: 'eventId' });
  ensureIndex(store, 'byOrderId', 'orderId');
  ensureIndex(store, 'byOrderRevision', ['orderId', 'revision']);
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.SYNC_QUEUE, { keyPath: 'queueId' });
  ensureIndex(store, 'byStatusCreatedAt', ['status', 'createdAt']);
  ensureIndex(store, 'byEntity', ['entityType', 'entityId']);

  ensureStore(STORE.META, { keyPath: 'key' });
}

export function openOrderQDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => upgrade(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('ORDER Q DB 업그레이드가 다른 탭에 의해 차단되었습니다. 다른 ORDER Q 탭을 닫고 다시 시도하세요.'));
  });
  return dbPromise;
}

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${token}`;
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
}

export async function getAll(storeName, indexName = null, query = null) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
  const result = await requestToPromise(source.getAll(query));
  await transactionDone(tx);
  return result;
}

export async function getByKey(storeName, key) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return result;
}
