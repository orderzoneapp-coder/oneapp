export const REFERENCE_DOMAIN_STATUS = Object.freeze({
  LOADING: 'LOADING',
  READY: 'READY',
  EMPTY: 'EMPTY',
  ERROR: 'ERROR',
  STALE: 'STALE'
});

export const REFERENCE_CACHE_SCHEMA = 'ONEAPP_SMARTINPUT_REFERENCE_CACHE_V1';

const PRODUCT_OWNER_APP_ID = 'master-lookup';
const CUSTOMER_OWNER_APP_ID = 'customer-master';
const PRODUCT_SNAPSHOT_SCHEMA = 'ONEAPP_PRODUCT_SNAPSHOT_V1';
const CUSTOMER_SNAPSHOT_SCHEMA = 'ONEAPP_CUSTOMER_SNAPSHOT_V1';
const CHANGE_REQUEST_SCHEMA = 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1';
const PRODUCT_DB_NAME = 'MerchOpsDB';
const PRODUCT_RECORD_STORE = 'master_products';
const PRODUCT_KV_STORE = 'store';
const PRODUCT_SNAPSHOT_KEY = 'merchMaster_v870';
const PRODUCT_REVISION_KEY = 'merchMaster_revision_v870';
const CUSTOMER_DB_NAME = 'oneapp-customermaster-v1';

const clean = value => String(value ?? '').trim();
const cloneJson = value => {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function sha256Hex(value) {
  const source = typeof value === 'string' ? value : stableStringify(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeReferenceSearchText(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/[\s()[\]{}<>,.:;·_-]+/g, '');
}

function firstValue(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && clean(value) !== '') return clean(value);
  }
  return clean(fallback);
}

function numberOrNull(source, keys) {
  const raw = firstValue(source, keys);
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function splitAliases(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(entry => String(entry ?? '').split(/[,;|\n]+/))
    .map(clean).filter(Boolean);
}

function stableProductId(itemCode, itemName, specification) {
  if (itemCode) return `PRD-${itemCode}`;
  let hash = 2166136261;
  for (const character of `${normalizeReferenceSearchText(itemName)}|${normalizeReferenceSearchText(specification)}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `PRD-MASTER-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizePriceOptions(raw = {}) {
  const fields = [
    ['outPrice', '출고가', ['outPrice', '출고가']],
    ['wholesaleA', '도매A', ['wholesaleA', '도매A', '도매가', 'A판매', 'A판매가']],
    ['wholesaleB', '도매B', ['wholesaleB', '도매B', 'B판매', 'B판매가', 'B도매', 'B도매가']],
    ['listingPrice', '상장가', ['listingPrice', '상장가']],
    ['marketPrice', '시중가', ['marketPrice', '시중가', '시중가격']],
    ['promoPrice', '행사가', ['promoPrice', '행사가', '특가']]
  ];
  const outPrice = numberOrNull(raw, fields[0][2]);
  const promoPrice = numberOrNull(raw, fields[5][2]);
  const salePrice = promoPrice !== null && promoPrice > 0 ? promoPrice : outPrice;
  const options = salePrice === null ? [] : [{ key: 'salePrice', label: '판매가', value: salePrice }];
  fields.forEach(([key, label, aliases]) => {
    const value = numberOrNull(raw, aliases);
    if (value !== null) options.push({ key, label, value });
  });
  return options;
}

export function normalizeProductReferenceRow(raw = {}, fallbackCode = '') {
  const itemCode = firstValue(raw, ['itemCode', 'productCode', '코드', '품목코드', '상품코드'], fallbackCode);
  const itemName = firstValue(raw, ['itemName', 'productName', '품목명', '상품명', '제품명', '품명']);
  if (!itemCode && !itemName) return null;
  const specification = firstValue(raw, ['specification', 'spec', '규격', '규격명']);
  const secondaryName = firstValue(raw, ['secondaryName', 'secondName', '제2품명', '제2상품명', '약칭']);
  const searchInfo = firstValue(raw, ['searchInfo', 'searchKeywords', '검색창정보', '검색어등록', '검색어', '간단설명']);
  const approvedAliases = [...new Set([
    secondaryName,
    ...splitAliases(searchInfo),
    ...splitAliases(raw.approvedAliases),
    ...splitAliases(raw['승인별칭']),
    ...splitAliases(raw['별칭'])
  ].filter(Boolean))];
  const productId = firstValue(raw, ['productId', 'masterProductId']) || stableProductId(itemCode, itemName, specification);
  return {
    productId,
    masterProductId: firstValue(raw, ['masterProductId']) || productId,
    itemCode,
    itemName,
    secondaryName,
    searchInfo,
    approvedAliases,
    specification,
    finalUnit: firstValue(raw, ['finalUnit', 'unit', '업무단위', '단위']),
    boxQuantity: numberOrNull(raw, ['boxQuantity', 'unitsPerBox', '박스당수량', '박스당 수량', '원단위', '입수', '기본']),
    outPrice: numberOrNull(raw, ['outPrice', '출고가']),
    priceOptions: normalizePriceOptions(raw),
    status: firstValue(raw, ['status', '상태'], 'ACTIVE'),
    active: raw.active !== false,
    source: 'PRODUCT_MASTER_SNAPSHOT',
    revision: Number(raw.revision || 0),
    raw: cloneJson(raw)
  };
}

function collectionRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value).map(([key, row]) => ({ key, row }));
  return [];
}

function normalizeProductCollection(value) {
  if (Array.isArray(value)) return value.map(row => normalizeProductReferenceRow(row)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, row]) => normalizeProductReferenceRow(row, key)).filter(Boolean);
  }
  return [];
}

export function normalizeCustomerReferenceRow(raw = {}) {
  const customerId = clean(raw.customerId);
  if (!customerId || !clean(raw.customerName || raw.name)) return null;
  return {
    ...cloneJson(raw),
    customerId,
    customerCode: clean(raw.customerCode || raw.erpCustomerCode),
    customerName: clean(raw.customerName || raw.name),
    status: clean(raw.status || 'ACTIVE'),
    qualityStatus: clean(raw.qualityStatus || 'CANONICAL'),
    revision: Number(raw.revision || 0),
    updatedAt: clean(raw.updatedAt)
  };
}

function normalizeReferenceEnvelope(domain, snapshot, { source, fallback = false, checkedAt = new Date().toISOString(), adapterError = null } = {}) {
  const isProduct = domain === 'product';
  const expectedSchema = isProduct ? PRODUCT_SNAPSHOT_SCHEMA : CUSTOMER_SNAPSHOT_SCHEMA;
  if (!snapshot || snapshot.schemaVersion !== expectedSchema) throw new Error(`${domain.toUpperCase()}_SNAPSHOT_SCHEMA_INVALID`);
  const rawRows = isProduct ? snapshot.data?.products : snapshot.data?.customers;
  if (!Array.isArray(rawRows)) throw new Error(`${domain.toUpperCase()}_SNAPSHOT_ROWS_INVALID`);
  const rows = isProduct
    ? rawRows.map(row => normalizeProductReferenceRow(row)).filter(Boolean)
    : rawRows.map(row => normalizeCustomerReferenceRow(row)).filter(Boolean);
  const status = snapshot.status === REFERENCE_DOMAIN_STATUS.EMPTY || rows.length === 0
    ? REFERENCE_DOMAIN_STATUS.EMPTY
    : REFERENCE_DOMAIN_STATUS.READY;
  return {
    cacheSchemaVersion: REFERENCE_CACHE_SCHEMA,
    domain,
    ownerAppId: isProduct ? PRODUCT_OWNER_APP_ID : CUSTOMER_OWNER_APP_ID,
    schemaVersion: expectedSchema,
    adapterVersion: clean(snapshot.adapterVersion),
    status,
    source: clean(source || snapshot.source || 'ADAPTER_SNAPSHOT'),
    fallback,
    count: rows.length,
    revision: snapshot.snapshotVersion ?? snapshot.revision ?? '',
    snapshotId: clean(snapshot.snapshotId) || `${domain.toUpperCase()}-${clean(snapshot.contentHash).slice(0, 12)}`,
    contentHash: clean(snapshot.contentHash),
    snapshotCreatedAt: clean(snapshot.snapshotCreatedAt) || checkedAt,
    checkedAt,
    rows,
    adapterError: adapterError ? formatReferenceError(adapterError, domain) : null,
    error: null
  };
}

function formatReferenceError(error, domain) {
  return {
    code: clean(error?.code || error?.message) || `${domain.toUpperCase()}_REFERENCE_LOAD_FAILED`,
    message: clean(error?.message) || `${domain === 'product' ? '상품' : '거래처'} 기준정보를 불러오지 못했습니다.`,
    retryable: error?.retryable !== false
  };
}

function errorReference(domain, error, checkedAt = new Date().toISOString()) {
  return {
    cacheSchemaVersion: REFERENCE_CACHE_SCHEMA,
    domain,
    ownerAppId: domain === 'product' ? PRODUCT_OWNER_APP_ID : CUSTOMER_OWNER_APP_ID,
    schemaVersion: domain === 'product' ? PRODUCT_SNAPSHOT_SCHEMA : CUSTOMER_SNAPSHOT_SCHEMA,
    adapterVersion: '',
    status: REFERENCE_DOMAIN_STATUS.ERROR,
    source: 'UNAVAILABLE',
    fallback: false,
    count: null,
    revision: '',
    snapshotId: '',
    contentHash: '',
    snapshotCreatedAt: '',
    checkedAt,
    rows: [],
    adapterError: null,
    error: formatReferenceError(error, domain)
  };
}

function requestResult(request, code) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Object.assign(new Error(code), { cause: request.error }));
  });
}

function transactionDone(transaction, code) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(Object.assign(new Error(code), { cause: transaction.error }));
    transaction.onabort = () => reject(Object.assign(new Error(`${code}_ABORTED`), { cause: transaction.error }));
  });
}

async function databaseExists(name) {
  if (!globalThis.indexedDB) throw new Error('INDEXEDDB_NOT_AVAILABLE');
  if (typeof globalThis.indexedDB.databases !== 'function') return null;
  const databases = await globalThis.indexedDB.databases();
  return databases.some(entry => entry?.name === name);
}

function openExistingDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(name);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error(`${name}_UNEXPECTED_CREATION_BLOCKED`));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`${name}_OPEN_FAILED`));
    request.onblocked = () => reject(new Error(`${name}_OPEN_BLOCKED`));
  });
}

function localProductSnapshot() {
  const raw = globalThis.localStorage?.getItem(PRODUCT_SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error('PRODUCT_FALLBACK_LOCAL_INVALID'), { cause: error });
  }
}

async function loadProductDirectFallback({ now = new Date().toISOString() } = {}) {
  const exists = await databaseExists(PRODUCT_DB_NAME);
  let recordRows = [];
  let storedSnapshot = null;
  let revision = globalThis.localStorage?.getItem(PRODUCT_REVISION_KEY) || '';
  let source = 'LOCAL_STORAGE_SNAPSHOT_KEY';
  let db;
  if (exists !== false) {
    try {
      db = await openExistingDatabase(PRODUCT_DB_NAME);
      const stores = [PRODUCT_RECORD_STORE, PRODUCT_KV_STORE].filter(name => db.objectStoreNames.contains(name));
      if (stores.length) {
        const transaction = db.transaction(stores, 'readonly');
        const done = transactionDone(transaction, 'PRODUCT_FALLBACK_READ_FAILED');
        if (stores.includes(PRODUCT_RECORD_STORE)) recordRows = await requestResult(transaction.objectStore(PRODUCT_RECORD_STORE).getAll(), 'PRODUCT_FALLBACK_RECORD_READ_FAILED');
        if (stores.includes(PRODUCT_KV_STORE)) {
          [storedSnapshot, revision] = await Promise.all([
            requestResult(transaction.objectStore(PRODUCT_KV_STORE).get(PRODUCT_SNAPSHOT_KEY), 'PRODUCT_FALLBACK_SNAPSHOT_READ_FAILED'),
            requestResult(transaction.objectStore(PRODUCT_KV_STORE).get(PRODUCT_REVISION_KEY), 'PRODUCT_FALLBACK_REVISION_READ_FAILED')
          ]);
        }
        await done;
      }
    } catch (error) {
      if (!/_UNEXPECTED_CREATION_BLOCKED$/.test(clean(error?.message))) throw error;
    } finally {
      db?.close();
    }
  }
  let rawRows = recordRows;
  if (rawRows.length) source = 'INDEXEDDB_RECORD_STORE';
  else if (collectionRows(storedSnapshot).length) {
    rawRows = storedSnapshot;
    source = 'INDEXEDDB_SNAPSHOT_KEY';
  } else rawRows = localProductSnapshot();
  const products = normalizeProductCollection(rawRows);
  const data = { products: products.map(product => product.raw) };
  const contentHash = await sha256Hex(data);
  const snapshotVersion = clean(revision) || `HASH-${contentHash}`;
  return normalizeReferenceEnvelope('product', {
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA,
    adapterVersion: 'SMARTINPUT_PRODUCT_DIRECT_FALLBACK_V1',
    status: products.length ? 'READY' : 'EMPTY',
    snapshotId: `PRODUCT-${snapshotVersion}-${contentHash.slice(0, 12)}`,
    snapshotVersion,
    snapshotCreatedAt: now,
    contentHash,
    source,
    data
  }, { source: `FALLBACK_DIRECT:${source}`, fallback: true, checkedAt: now });
}

async function loadCustomerDirectFallback({ now = new Date().toISOString() } = {}) {
  const exists = await databaseExists(CUSTOMER_DB_NAME);
  if (exists === false) {
    const contentHash = await sha256Hex({ customers: [] });
    return normalizeReferenceEnvelope('customer', {
      schemaVersion: CUSTOMER_SNAPSHOT_SCHEMA,
      adapterVersion: 'SMARTINPUT_CUSTOMER_DIRECT_FALLBACK_V1',
      status: 'EMPTY',
      snapshotId: `CUSTOMER-0-${contentHash.slice(0, 12)}`,
      snapshotVersion: 0,
      snapshotCreatedAt: now,
      contentHash,
      data: { customers: [] }
    }, { source: 'FALLBACK_DIRECT:INDEXEDDB_CONFIRMED_EMPTY', fallback: true, checkedAt: now });
  }
  let db;
  try {
    db = await openExistingDatabase(CUSTOMER_DB_NAME);
    if (!db.objectStoreNames.contains('customers')) throw new Error('CUSTOMER_FALLBACK_STORE_MISSING');
    const stores = ['customers', 'appMeta'].filter(name => db.objectStoreNames.contains(name));
    const transaction = db.transaction(stores, 'readonly');
    const done = transactionDone(transaction, 'CUSTOMER_FALLBACK_READ_FAILED');
    const customers = await requestResult(transaction.objectStore('customers').getAll(), 'CUSTOMER_FALLBACK_CUSTOMER_READ_FAILED');
    const head = stores.includes('appMeta')
      ? await requestResult(transaction.objectStore('appMeta').get('headRevision'), 'CUSTOMER_FALLBACK_REVISION_READ_FAILED')
      : null;
    await done;
    const selected = customers.filter(customer => customer.status !== 'DELETED' && customer.qualityStatus !== 'SUPERSEDED');
    const data = { customers: selected };
    const contentHash = await sha256Hex(data);
    const revision = Number(head?.value || 0);
    return normalizeReferenceEnvelope('customer', {
      schemaVersion: CUSTOMER_SNAPSHOT_SCHEMA,
      adapterVersion: 'SMARTINPUT_CUSTOMER_DIRECT_FALLBACK_V1',
      status: selected.length ? 'READY' : 'EMPTY',
      snapshotId: `CUSTOMER-${revision}-${contentHash.slice(0, 12)}`,
      snapshotVersion: revision,
      snapshotCreatedAt: now,
      contentHash,
      data
    }, { source: 'FALLBACK_DIRECT:INDEXEDDB_CUSTOMERS', fallback: true, checkedAt: now });
  } finally {
    db?.close();
  }
}

function adapterFromModule(module, domain) {
  return domain === 'product'
    ? (module.productMasterReadAdapter || module.default || globalThis.ONEAPP_PRODUCT_MASTER_READ_ADAPTER)
    : (module.customerReadAdapter || module.default || globalThis.ONEAPP_CUSTOMER_MASTER_READ_ADAPTER);
}

async function defaultAdapterLoader(domain) {
  return domain === 'product'
    ? import('../reference-data/product-master-read-adapter.js')
    : import('../customer-master/read-adapter.js');
}

async function defaultFallbackLoader(domain, options) {
  return domain === 'product' ? loadProductDirectFallback(options) : loadCustomerDirectFallback(options);
}

export async function loadReferenceDomain(domain, options = {}) {
  if (!['product', 'customer'].includes(domain)) throw new Error('REFERENCE_DOMAIN_INVALID');
  const checkedAt = options.now || new Date().toISOString();
  let adapterError = null;
  try {
    const module = await (options.adapterLoader || defaultAdapterLoader)(domain);
    const adapter = adapterFromModule(module, domain);
    if (!adapter?.getSnapshotResult) throw new Error(`${domain.toUpperCase()}_READ_ADAPTER_NOT_AVAILABLE`);
    const result = await adapter.getSnapshotResult(domain === 'customer' ? { includeInactive: false } : {});
    if (result?.status === REFERENCE_DOMAIN_STATUS.ERROR || !result?.snapshot) {
      const error = new Error(result?.error?.message || `${domain.toUpperCase()}_SNAPSHOT_READ_FAILED`);
      error.code = result?.error?.code || error.message;
      error.retryable = result?.error?.retryable !== false;
      throw error;
    }
    return normalizeReferenceEnvelope(domain, result.snapshot, { source: `ADAPTER:${clean(result.snapshot.source || 'OWNER_SNAPSHOT')}`, checkedAt });
  } catch (error) {
    adapterError = error;
  }
  if (options.allowFallback === false) return errorReference(domain, adapterError, checkedAt);
  try {
    const fallback = await (options.fallbackLoader || defaultFallbackLoader)(domain, { now: checkedAt });
    return { ...fallback, adapterError: formatReferenceError(adapterError, domain) };
  } catch (fallbackError) {
    const combined = new Error(clean(fallbackError?.message) || `${domain.toUpperCase()}_REFERENCE_LOAD_FAILED`);
    combined.code = combined.message;
    combined.adapterError = formatReferenceError(adapterError, domain);
    return errorReference(domain, combined, checkedAt);
  }
}

export function normalizeCachedReference(value, domain) {
  if (!value || value.cacheSchemaVersion !== REFERENCE_CACHE_SCHEMA || value.domain !== domain || !Array.isArray(value.rows)) return null;
  if (![REFERENCE_DOMAIN_STATUS.READY, REFERENCE_DOMAIN_STATUS.EMPTY].includes(value.status)) return null;
  return cloneJson(value);
}

export function sameReferenceRevision(left, right) {
  if (!left || !right) return false;
  if (left.snapshotId && right.snapshotId) return left.snapshotId === right.snapshotId;
  if (left.contentHash && right.contentHash) return left.contentHash === right.contentHash;
  return String(left.revision) === String(right.revision) && Number(left.count) === Number(right.count);
}

function referenceKey(domain, row) {
  return domain === 'product'
    ? clean(row.itemCode || row.productId || row.masterProductId)
    : clean(row.customerId || row.customerCode);
}

export function diffReferenceSnapshots(domain, current, next) {
  const before = new Map((current?.rows || []).map(row => [referenceKey(domain, row), row]).filter(([key]) => key));
  const after = new Map((next?.rows || []).map(row => [referenceKey(domain, row), row]).filter(([key]) => key));
  let added = 0;
  let removed = 0;
  let changed = 0;
  after.forEach((row, key) => {
    if (!before.has(key)) added += 1;
    else if (stableStringify(before.get(key)) !== stableStringify(row)) changed += 1;
  });
  before.forEach((_, key) => { if (!after.has(key)) removed += 1; });
  return {
    domain,
    fromRevision: current?.revision ?? '',
    toRevision: next?.revision ?? '',
    fromCount: Number(current?.count || 0),
    toCount: Number(next?.count || 0),
    added,
    removed,
    changed
  };
}

function diceSimilarity(left, right) {
  const a = normalizeReferenceSearchText(left);
  const b = normalizeReferenceSearchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.7 : 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = pairs.get(pair) || 0;
    if (!count) continue;
    overlap += 1;
    pairs.set(pair, count - 1);
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

function productEntry(product, index) {
  const aliases = [...new Set([
    product.secondaryName,
    ...(Array.isArray(product.approvedAliases) ? product.approvedAliases : []),
    ...splitAliases(product.searchInfo)
  ].map(normalizeReferenceSearchText).filter(Boolean))];
  return {
    product,
    index,
    code: normalizeReferenceSearchText(product.itemCode),
    name: normalizeReferenceSearchText(product.itemName),
    secondary: normalizeReferenceSearchText(product.secondaryName),
    aliases,
    specification: normalizeReferenceSearchText(product.specification)
  };
}

function addIndex(map, key, index) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(index);
}

function grams(value) {
  if (!value) return [];
  if (value.length < 2) return [value];
  const result = new Set();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return [...result];
}

export function createProductMatchIndex(products = []) {
  const entries = products.filter(product => clean(product?.status || 'ACTIVE').toUpperCase() !== 'INACTIVE' && product?.active !== false)
    .map(productEntry);
  const exactCodes = new Map();
  const exactTexts = new Map();
  const gramIndex = new Map();
  entries.forEach((entry, index) => {
    addIndex(exactCodes, entry.code, index);
    [entry.name, entry.secondary, ...entry.aliases].forEach(value => addIndex(exactTexts, value, index));
    [entry.code, entry.name, entry.secondary, entry.specification, ...entry.aliases]
      .forEach(value => grams(value).forEach(gram => addIndex(gramIndex, gram, index)));
  });
  return { entries, exactCodes, exactTexts, gramIndex };
}

function indexedProducts(index, positions = []) {
  return [...new Set(positions)].map(position => index.entries[position]?.product).filter(Boolean);
}

function productSearchScore(query, entry) {
  if (entry.code.startsWith(query)) return 880 - Math.min(100, entry.code.length - query.length);
  if (entry.name.startsWith(query)) return 840 - Math.min(100, entry.name.length - query.length);
  if (entry.code.includes(query)) return 800;
  if (entry.name.includes(query)) return 760;
  if (entry.aliases.some(alias => alias.includes(query)) || entry.secondary.includes(query)) return 720;
  if (entry.specification.includes(query)) return 620;
  const similarity = Math.max(
    diceSimilarity(query, entry.name),
    diceSimilarity(query, entry.secondary),
    ...entry.aliases.map(alias => diceSimilarity(query, alias))
  );
  return similarity >= 0.38 ? Math.round(300 + similarity * 300) : 0;
}

export function searchProductMatchIndex(index, query, limit = 12) {
  const normalized = normalizeReferenceSearchText(query);
  if (!normalized || !index?.entries) return [];
  const positions = new Set();
  if (normalized.length < 2) index.entries.forEach((_, position) => positions.add(position));
  else grams(normalized).forEach(gram => (index.gramIndex.get(gram) || []).forEach(position => positions.add(position)));
  const candidates = [...positions].map(position => ({ position, score: productSearchScore(normalized, index.entries[position]) }))
    .filter(candidate => candidate.score > 0);
  return candidates.sort((left, right) => right.score - left.score
    || clean(index.entries[left.position].product.itemCode).localeCompare(clean(index.entries[right.position].product.itemCode), 'ko', { numeric: true }))
    .slice(0, Math.max(0, limit))
    .map(candidate => ({ ...index.entries[candidate.position].product, score: candidate.score }));
}

export function classifyProductMatch(index, query, { limit = 12 } = {}) {
  const normalized = normalizeReferenceSearchText(query);
  if (!normalized) return { kind: 'MISSING', autoConfirm: false, candidates: [] };
  const codeMatches = indexedProducts(index, index.exactCodes.get(normalized) || []);
  if (codeMatches.length === 1) return { kind: 'EXACT_CODE', autoConfirm: true, candidates: codeMatches, product: codeMatches[0] };
  if (codeMatches.length > 1) return { kind: 'AMBIGUOUS_EXACT_CODE', autoConfirm: false, candidates: codeMatches };
  const textMatches = indexedProducts(index, index.exactTexts.get(normalized) || []);
  if (textMatches.length === 1) return { kind: 'UNIQUE_EXACT_TEXT', autoConfirm: true, candidates: textMatches, product: textMatches[0] };
  if (textMatches.length > 1) return { kind: 'AMBIGUOUS_EXACT_TEXT', autoConfirm: false, candidates: textMatches };
  const candidates = searchProductMatchIndex(index, normalized, limit);
  return candidates.length
    ? { kind: 'FUZZY', autoConfirm: false, candidates }
    : { kind: 'MISSING', autoConfirm: false, candidates: [] };
}

export function ownerAppHref(domain) {
  return domain === 'product' ? '../Master.html' : '../customer-master/index.html';
}

function createRequestId(domain) {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `SI-${domain.toUpperCase()}-${uuid}`;
}

export function buildRegistrationChangeRequest(domain, prefill = {}, context = {}) {
  if (!['product', 'customer'].includes(domain)) throw new Error('REFERENCE_DOMAIN_INVALID');
  const requestId = createRequestId(domain);
  const product = domain === 'product';
  const fields = product
    ? [['itemCode', prefill.itemCode], ['itemName', prefill.itemName], ['specification', prefill.specification], ['unit', prefill.unit]]
    : [['customerCode', prefill.customerCode], ['customerName', prefill.customerName], ['address', prefill.address], ['phone', prefill.phone]];
  const changes = fields.filter(([, value]) => clean(value) !== '')
    .map(([field, proposedValue]) => ({ field, beforeValue: null, proposedValue }));
  if (!changes.length) changes.push({ field: product ? 'itemName' : 'customerName', beforeValue: null, proposedValue: product ? '미등록 상품' : '미등록 거래처' });
  const entityId = clean(product ? prefill.itemCode : prefill.customerCode) || requestId;
  return {
    schemaVersion: CHANGE_REQUEST_SCHEMA,
    requestId,
    idempotencyKey: clean(context.idempotencyKey) || `${requestId}:${entityId}`,
    domain: product ? 'PRODUCT' : 'CUSTOMER',
    ownerAppId: product ? PRODUCT_OWNER_APP_ID : CUSTOMER_OWNER_APP_ID,
    entityId,
    operation: 'CREATE',
    requestedAt: context.requestedAt || new Date().toISOString(),
    changes,
    source: {
      appId: 'smart-input',
      route: 'smartinput/index.html',
      mode: clean(context.mode),
      documentId: clean(context.documentId),
      rowId: clean(context.rowId)
    },
    actor: { actorState: 'UNVERIFIED_LOCAL' }
  };
}

export async function submitRegistrationChangeRequest(domain, request, options = {}) {
  try {
    const module = await (options.adapterLoader || (async requestedDomain => requestedDomain === 'product'
      ? import('../reference-data/product-change-request-adapter.js')
      : import('../customer-master/change-request-adapter.js')))(domain);
    const adapter = domain === 'product'
      ? (module.productMasterChangeRequestAdapter || globalThis.ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER)
      : (module.customerMasterChangeRequestAdapter || globalThis.ONEAPP_CUSTOMER_MASTER_CHANGE_REQUEST_ADAPTER);
    if (!adapter?.submitChangeRequest) throw new Error(`${domain.toUpperCase()}_CHANGE_REQUEST_ADAPTER_NOT_AVAILABLE`);
    return adapter.submitChangeRequest(request);
  } catch (error) {
    return {
      schemaVersion: CHANGE_REQUEST_SCHEMA,
      accepted: false,
      status: 'NOT_AVAILABLE',
      requestId: clean(request?.requestId),
      idempotencyKey: clean(request?.idempotencyKey),
      error: formatReferenceError(error, domain)
    };
  }
}

export function referenceSourceLabel(reference) {
  if (!reference) return '아직 확인하지 않음';
  const owner = reference.domain === 'product' ? '상품관리' : '거래처관리';
  if (reference.fallback) return `${owner} 직접 읽기 fallback`;
  if (String(reference.source || '').startsWith('CACHE:')) return `SmartInput 로컬 보관 · ${owner}`;
  return `${owner} Snapshot Adapter`;
}
