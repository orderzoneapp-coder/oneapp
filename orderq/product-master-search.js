import { STORE, getAll, normalizeText } from './orderq-db.js?v=0.17.0';

const COMMON_MASTER_DB = 'MerchOpsDB';
const COMMON_MASTER_STORE = 'master_products';
const COMMON_MASTER_SNAPSHOT_KEYS = ['merchMaster_v870', 'master_products'];

export const MANUAL_PRICE_FIELDS = Object.freeze([
  { key: 'salePrice', label: '판매가', aliases: [] },
  { key: 'outPrice', label: '출고가', aliases: ['outPrice', '출고가'] },
  { key: 'wholesaleA', label: '도매A', aliases: ['wholesaleA', '도매A', '도매가', 'A판매', 'A판매가'] },
  { key: 'wholesaleB', label: '도매B', aliases: ['wholesaleB', '도매B', 'B판매', 'B판매가', 'B도매', 'B도매가'] },
  { key: 'listingPrice', label: '상장가', aliases: ['listingPrice', '상장가'] },
  { key: 'marketPrice', label: '시중가', aliases: ['marketPrice', '시중가', '시중가격'] },
  { key: 'promoPrice', label: '행사가', aliases: ['promoPrice', '행사가', '특가'] },
  { key: 'purchasePriceB', label: '입고B', aliases: ['purchasePriceB', '입고B'] },
  { key: 'priceD', label: '단가D', aliases: ['priceD', '단가D'] },
  { key: 'lastPurchasePrice', label: '최종입고', aliases: ['lastPurchasePrice', '최종입고'] },
  { key: 'priceH', label: '단가H', aliases: ['priceH', '단가H'] },
  { key: 'priceI', label: '단가I', aliases: ['priceI', '단가I'] }
]);

function firstValue(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return String(fallback || '').trim();
}

function stableProductId(code, name, specification) {
  if (code) return `PRD-${code}`;
  let hash = 2166136261;
  for (const char of `${normalizeText(name)}|${normalizeText(specification)}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `PRD-MASTER-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function numberOrNull(source, keys) {
  const raw = firstValue(source, keys);
  if (raw === '') return null;
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function normalizeManualPriceOptions(raw = {}, source = 'COMMON_MASTER') {
  if (source !== 'COMMON_MASTER') return [];
  const outPriceField = MANUAL_PRICE_FIELDS.find(field => field.key === 'outPrice');
  const promoPriceField = MANUAL_PRICE_FIELDS.find(field => field.key === 'promoPrice');
  const outPrice = numberOrNull(raw, outPriceField.aliases);
  const promoPrice = numberOrNull(raw, promoPriceField.aliases);
  return MANUAL_PRICE_FIELDS.map(field => {
    const value = field.key === 'salePrice'
      ? (promoPrice !== null && promoPrice > 0 ? promoPrice : outPrice)
      : numberOrNull(raw, field.aliases);
    return value === null ? null : { key: field.key, label: field.label, value };
  }).filter(Boolean);
}

export function productCategoryCode(itemCode) {
  return String(itemCode || '').trim().slice(0, 6);
}

export function isSelectableMasterProduct(product = {}) {
  return String(product.source || '').trim() === 'COMMON_MASTER'
    && String(product.masterProductId || '').trim() !== ''
    && String(product.productId || '').trim() !== ''
    && String(product.itemCode || '').trim() !== ''
    && String(product.itemName || '').trim() !== ''
    && String(product.status || 'ACTIVE').trim().toUpperCase() !== 'INACTIVE';
}

export function normalizeMasterProduct(raw = {}, fallbackCode = '', source = 'COMMON_MASTER', primaryKey = '') {
  const itemCode = firstValue(raw, ['itemCode', 'productCode', '코드', '품목코드', '상품코드'], fallbackCode);
  const itemName = firstValue(raw, ['itemName', 'productName', '품목명', '상품명', '제품명', '품명']);
  const specification = firstValue(raw, ['specification', 'spec', '규격', '규격명']);
  const finalUnit = firstValue(raw, ['finalUnit', 'unit', '업무단위', '단위']);
  const boxQuantity = numberOrNull(raw, ['boxQuantity', 'unitsPerBox', '박스당수량', '박스당 수량', '원단위', '입수', '기본']);
  const secondaryName = firstValue(raw, ['secondaryName', 'secondName', '제2품명', '제2상품명', '약칭', '별칭']);
  const searchInfo = firstValue(raw, ['searchInfo', 'searchKeywords', '검색창정보', '검색어등록', '검색어', '간단설명']);
  const priceOptions = normalizeManualPriceOptions(raw, source);
  const outPrice = priceOptions.find(option => option.key === 'outPrice')?.value ?? null;
  const masterProductId = source === 'COMMON_MASTER'
    ? (String(primaryKey ?? '').trim() || firstValue(raw, ['코드', 'itemCode', 'productCode', '품목코드', '상품코드'], fallbackCode))
    : firstValue(raw, ['masterProductId']);
  if (!itemCode && !itemName) return null;
  return {
    productId: firstValue(raw, ['productId']) || stableProductId(itemCode, itemName, specification),
    itemCode,
    itemName,
    secondaryName,
    searchInfo,
    specification,
    finalUnit,
    boxQuantity,
    outPrice,
    priceOptions,
    status: firstValue(raw, ['status', '상태'], 'ACTIVE'),
    productIdentityType: firstValue(raw, ['productIdentityType']),
    registrationStatus: firstValue(raw, ['registrationStatus']),
    masterProductId,
    source,
    raw
  };
}

function normalizeCollection(value, source) {
  if (Array.isArray(value)) return value.map(item => normalizeMasterProduct(item, '', source)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => normalizeMasterProduct(item, key, source)).filter(Boolean);
  }
  return [];
}

export function mergeProductCatalog(commonProducts = [], orderQProducts = []) {
  const catalog = new Map();
  const add = product => {
    if (!product || String(product.status || 'ACTIVE').toUpperCase() === 'INACTIVE') return;
    if (product.productIdentityType === 'TEMPORARY' && product.registrationStatus === 'LINKED') return;
    const key = normalizeText(product.itemCode) || `${normalizeText(product.itemName)}|${normalizeText(product.specification)}`;
    if (!key || catalog.has(key)) return;
    catalog.set(key, product);
  };
  commonProducts.forEach(add);
  orderQProducts.forEach(add);
  return [...catalog.values()];
}

function diceSimilarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.7 : 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index++) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index++) {
    const pair = b.slice(index, index + 2);
    const count = pairs.get(pair) || 0;
    if (!count) continue;
    overlap += 1;
    pairs.set(pair, count - 1);
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

function productScore(query, product) {
  const normalized = normalizeText(query);
  if (!normalized) return 0;
  const code = normalizeText(product.itemCode);
  const name = normalizeText(product.itemName);
  const secondary = normalizeText(product.secondaryName);
  const info = normalizeText(product.searchInfo);
  const specification = normalizeText(product.specification);
  if (code === normalized) return 1000;
  if (name === normalized) return 960;
  if (secondary === normalized || info === normalized) return 930;
  if (code.startsWith(normalized)) return 880 - Math.min(100, code.length - normalized.length);
  if (name.startsWith(normalized)) return 840 - Math.min(100, name.length - normalized.length);
  if (code.includes(normalized)) return 800;
  if (name.includes(normalized)) return 760;
  if (secondary.includes(normalized) || info.includes(normalized)) return 720;
  if (specification.includes(normalized)) return 620;
  const similarity = Math.max(
    diceSimilarity(normalized, name),
    diceSimilarity(normalized, secondary),
    diceSimilarity(normalized, info)
  );
  return similarity >= 0.38 ? Math.round(300 + similarity * 300) : 0;
}

export function searchProductCatalog(query, catalog = [], limit = 8) {
  const matches = catalog
    .map(product => ({ product, score: productScore(query, product) }))
    .filter(row => row.score > 0);
  const anchor = [...matches].sort((left, right) => right.score - left.score
    || String(left.product.itemCode).localeCompare(String(right.product.itemCode), 'ko', { numeric: true }))[0];
  const anchorCategory = productCategoryCode(anchor?.product?.itemCode);
  return matches
    .sort((left, right) => {
      const leftCategory = productCategoryCode(left.product.itemCode);
      const rightCategory = productCategoryCode(right.product.itemCode);
      const leftIsAnchorCategory = Boolean(anchorCategory && leftCategory === anchorCategory);
      const rightIsAnchorCategory = Boolean(anchorCategory && rightCategory === anchorCategory);
      if (leftIsAnchorCategory !== rightIsAnchorCategory) return leftIsAnchorCategory ? -1 : 1;
      if (leftIsAnchorCategory && rightIsAnchorCategory) {
        return String(left.product.itemCode).localeCompare(String(right.product.itemCode), 'ko', { numeric: true });
      }
      return right.score - left.score
        || String(left.product.itemCode).localeCompare(String(right.product.itemCode), 'ko', { numeric: true });
    })
    .slice(0, limit)
    .map(row => ({ ...row.product, score: row.score }));
}

async function readCommonMasterIndexedDb() {
  if (!globalThis.indexedDB) return [];
  return new Promise((resolve, reject) => {
    let createdDuringOpen = false;
    const request = indexedDB.open(COMMON_MASTER_DB);
    request.onupgradeneeded = event => {
      createdDuringOpen = true;
      try { event.target.transaction.abort(); } catch (_) {}
    };
    request.onerror = () => {
      if (createdDuringOpen || request.error?.name === 'AbortError') resolve([]);
      else reject(request.error || new Error('공통 상품 마스터를 열지 못했습니다.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COMMON_MASTER_STORE)) {
        db.close();
        resolve([]);
        return;
      }
      const transaction = db.transaction(COMMON_MASTER_STORE, 'readonly');
      const products = [];
      const read = transaction.objectStore(COMMON_MASTER_STORE).openCursor();
      read.onsuccess = () => {
        const cursor = read.result;
        if (cursor) {
          const product = normalizeMasterProduct(cursor.value, String(cursor.primaryKey ?? ''), 'COMMON_MASTER', cursor.primaryKey);
          if (product) products.push(product);
          cursor.continue();
          return;
        }
        db.close();
        resolve(products);
      };
      read.onerror = () => {
        db.close();
        reject(read.error || transaction.error || new Error('공통 상품 마스터 조회에 실패했습니다.'));
      };
    };
  });
}

function readCommonMasterLocalStorage() {
  if (!globalThis.localStorage) return [];
  for (const key of COMMON_MASTER_SNAPSHOT_KEYS) {
    try {
      const products = normalizeCollection(JSON.parse(localStorage.getItem(key) || 'null'), 'COMMON_MASTER');
      if (products.length) return products;
    } catch (_) {}
  }
  return [];
}

export async function loadProductCatalog({ diagnostics = null, referencePhase = null } = {}) {
  const errors = [];
  let commonProducts = [];
  const commonSpan = diagnostics?.start?.(referencePhase?.COMMON_PRODUCT || 'COMMON_PRODUCT', 'MERCHOPS_DB_OR_SNAPSHOT');
  try {
    commonProducts = await readCommonMasterIndexedDb();
    if (!commonProducts.length) commonProducts = readCommonMasterLocalStorage();
    commonSpan?.end(commonProducts.length);
  } catch (error) {
    commonSpan?.fail(error);
    errors.push(error.message || String(error));
  }

  let orderQProducts = [];
  const orderQSpan = diagnostics?.start?.(referencePhase?.ORDERQ_PRODUCT || 'ORDERQ_PRODUCT', 'ORDERQ_DB');
  try {
    orderQProducts = (await getAll(STORE.PRODUCTS))
      .map(product => normalizeMasterProduct(product, product.itemCode, 'ORDERQ_HISTORY'))
      .filter(Boolean);
    orderQSpan?.end(orderQProducts.length);
  } catch (error) {
    orderQSpan?.fail(error);
    errors.push(error.message || String(error));
  }
  return {
    products: mergeProductCatalog(commonProducts, orderQProducts),
    commonCount: commonProducts.length,
    orderQCount: orderQProducts.length,
    errors
  };
}
