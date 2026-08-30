const DB_NAME = 'oneapp-smartinput';
const DB_VERSION = 3;
const FALLBACK_KEY = 'oneapp.smartinput.relationships.v1';

export const DATA_STORES = Object.freeze({
  SETTINGS: 'settings',
  LINK_GROUPS: 'customerLinkGroups',
  TEMPORARY_CUSTOMERS: 'temporaryCustomers',
  ALIAS_MAPPINGS: 'customerAliasMappings',
  ESTIMATES: 'estimates',
  SOURCE_IMAGES: 'sourceImages'
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('스마트입력 저장소 요청에 실패했습니다.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('스마트입력 저장이 취소되었습니다.'));
    transaction.onerror = () => reject(transaction.error || new Error('스마트입력 저장에 실패했습니다.'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DATA_STORES.SETTINGS)) db.createObjectStore(DATA_STORES.SETTINGS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(DATA_STORES.LINK_GROUPS)) {
        const store = db.createObjectStore(DATA_STORES.LINK_GROUPS, { keyPath: 'linkGroupId' });
        store.createIndex('byTaxCustomerId', 'taxCustomerId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.TEMPORARY_CUSTOMERS)) {
        const store = db.createObjectStore(DATA_STORES.TEMPORARY_CUSTOMERS, { keyPath: 'customerId' });
        store.createIndex('byLinkGroupId', 'linkGroupId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.ALIAS_MAPPINGS)) {
        const store = db.createObjectStore(DATA_STORES.ALIAS_MAPPINGS, { keyPath: 'aliasMappingId' });
        store.createIndex('byNormalizedName', 'normalizedName', { unique: false });
        store.createIndex('byContextKey', 'contextKey', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.ESTIMATES)) {
        const store = db.createObjectStore(DATA_STORES.ESTIMATES, { keyPath: 'estimateId' });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        store.createIndex('byCustomerName', 'customerName', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.SOURCE_IMAGES)) {
        const store = db.createObjectStore(DATA_STORES.SOURCE_IMAGES, { keyPath: 'documentId' });
        store.createIndex('byMode', 'mode', { unique: false });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('스마트입력 저장소를 열지 못했습니다.'));
  });
}

function readFallback() {
  try {
    const value = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function writeFallback(value) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(value));
}

async function getAll(storeName) {
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[storeName] || {});
  const transaction = db.transaction(storeName, 'readonly');
  const rows = await requestResult(transaction.objectStore(storeName).getAll());
  db.close();
  return rows;
}

async function put(storeName, record, keyField) {
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[storeName] ||= {};
    value[storeName][record[keyField]] = record;
    writeFallback(value);
    return record;
  }
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(record);
  await transactionDone(transaction);
  db.close();
  return record;
}

async function remove(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    if (value[storeName]) delete value[storeName][key];
    writeFallback(value);
    return;
  }
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
  db.close();
}

export function normalizeAliasName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,:;·_()[\]{}<>]/g, '');
}

export function createRecordId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function loadSmartInputData() {
  const [settingsRows, linkGroups, temporaryCustomers, aliasMappings, estimates, sourceImages] = await Promise.all([
    getAll(DATA_STORES.SETTINGS),
    getAll(DATA_STORES.LINK_GROUPS),
    getAll(DATA_STORES.TEMPORARY_CUSTOMERS),
    getAll(DATA_STORES.ALIAS_MAPPINGS),
    getAll(DATA_STORES.ESTIMATES),
    getAll(DATA_STORES.SOURCE_IMAGES)
  ]);
  return {
    settings: settingsRows.find(row => row.key === 'app')?.value || null,
    referenceCache: {
      product: settingsRows.find(row => row.key === 'reference:product')?.value || null,
      customer: settingsRows.find(row => row.key === 'reference:customer')?.value || null
    },
    linkGroups,
    temporaryCustomers,
    aliasMappings,
    estimates: estimates.sort((left, right) => {
      const leftOrder = Number(left.sortOrder);
      const rightOrder = Number(right.sortOrder);
      if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (Number.isFinite(leftOrder) !== Number.isFinite(rightOrder)) return Number.isFinite(leftOrder) ? -1 : 1;
      return String(left.createdAt || left.updatedAt || '').localeCompare(String(right.createdAt || right.updatedAt || ''));
    }),
    sourceImages
  };
}

export function saveSettings(value) {
  return put(DATA_STORES.SETTINGS, { key: 'app', value, updatedAt: new Date().toISOString() }, 'key');
}

export function saveReferenceCache(domain, value) {
  if (!['product', 'customer'].includes(domain)) return Promise.reject(new Error('REFERENCE_DOMAIN_INVALID'));
  return put(DATA_STORES.SETTINGS, {
    key: `reference:${domain}`,
    value,
    updatedAt: new Date().toISOString()
  }, 'key');
}

export function saveLinkGroup(group) {
  return put(DATA_STORES.LINK_GROUPS, group, 'linkGroupId');
}

export function deleteLinkGroup(linkGroupId) {
  return remove(DATA_STORES.LINK_GROUPS, linkGroupId);
}

export function saveTemporaryCustomer(customer) {
  return put(DATA_STORES.TEMPORARY_CUSTOMERS, customer, 'customerId');
}

export function saveAliasMapping(mapping) {
  return put(DATA_STORES.ALIAS_MAPPINGS, mapping, 'aliasMappingId');
}

export function deleteAliasMapping(aliasMappingId) {
  return remove(DATA_STORES.ALIAS_MAPPINGS, aliasMappingId);
}

export function saveEstimate(estimate) {
  return put(DATA_STORES.ESTIMATES, estimate, 'estimateId');
}

export function deleteEstimate(estimateId) {
  return remove(DATA_STORES.ESTIMATES, estimateId);
}

export function saveSourceImage(sourceImage) {
  return put(DATA_STORES.SOURCE_IMAGES, sourceImage, 'documentId');
}

export function deleteSourceImage(documentId) {
  return remove(DATA_STORES.SOURCE_IMAGES, documentId);
}
