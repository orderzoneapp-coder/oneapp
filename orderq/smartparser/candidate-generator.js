import { STORE, getAll, normalizeText } from '../orderq-db.js?v=0.8.0';

export function productTextSimilarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.92;
  const previous = new Array(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const upper = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = upper;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length, 1);
}

function productShape(product = {}, mapping = {}) {
  return {
    productId: mapping.productId || product.productId || '',
    itemCode: mapping.itemCode || product.itemCode || product.productCode || '',
    itemName: mapping.itemName || product.itemName || product.productName || '',
    specification: mapping.specification || product.specification || '',
    finalUnit: mapping.finalUnit || product.unit || product.finalUnit || ''
  };
}

function mappingIsActive(mapping = {}) {
  // v0.4 이전 매핑에는 status가 없으므로 최초 로드에서는 ACTIVE로 호환한다.
  return (mapping.status || 'ACTIVE') === 'ACTIVE';
}

function fuzzyMappingScore(kind, similarityScore, useCount = 0) {
  const usageBonus = Math.min(10, Number(useCount || 0)) * 0.002;
  if (kind === 'CUSTOMER') return Math.min(0.97, 0.80 + similarityScore * 0.18 + usageBonus);
  if (kind === 'SOURCE') return Math.min(0.93, 0.74 + similarityScore * 0.18 + usageBonus);
  return Math.min(0.90, 0.70 + similarityScore * 0.18 + usageBonus);
}

export async function generateProductCandidates({ productText, customerId = '', sourceId = '' } = {}) {
  const normalized = normalizeText(productText);
  if (!normalized) return [];
  const [mappings, products, orders, items] = await Promise.all([
    getAll(STORE.PRODUCT_MAPPINGS),
    getAll(STORE.PRODUCTS),
    getAll(STORE.ORDERS),
    getAll(STORE.ORDER_ITEMS)
  ]);
  const productById = new Map(products.map(product => [product.productId, product]));
  const candidates = [];
  const add = (shape, score, source, evidenceText = '') => {
    if (!shape.productId && !shape.itemCode && !shape.itemName) return;
    candidates.push({ ...shape, score, source, evidenceText });
  };

  mappings.filter(mappingIsActive).forEach(mapping => {
    const mappingText = mapping.normalizedText || mapping.rawText || '';
    const mappedNormalized = normalizeText(mappingText);
    if (!mappedNormalized) return;
    const product = productById.get(mapping.productId) || {};
    const exact = mappedNormalized === normalized;
    const similarityScore = exact ? 1 : productTextSimilarity(productText, mappingText);

    if (exact) {
      if (customerId && mapping.customerId === customerId) add(productShape(product, mapping), 1, 'CUSTOMER_MAPPING', mapping.rawText);
      else if (sourceId && mapping.sourceId === sourceId) add(productShape(product, mapping), 0.98, 'SOURCE_MAPPING', mapping.rawText);
      else if (!mapping.customerId && !mapping.sourceId) add(productShape(product, mapping), 0.96, 'COMMON_MAPPING', mapping.rawText);
      return;
    }

    // 같은 상품에 대해 관리자가 과거에 확정한 다양한 표현 자체를 다음 주문의 유사검색 자산으로 사용한다.
    if (similarityScore < 0.68) return;
    if (customerId && mapping.customerId === customerId) {
      add(productShape(product, mapping), fuzzyMappingScore('CUSTOMER', similarityScore, mapping.useCount), 'CUSTOMER_MAPPING_FUZZY', mapping.rawText);
    } else if (sourceId && mapping.sourceId === sourceId) {
      add(productShape(product, mapping), fuzzyMappingScore('SOURCE', similarityScore, mapping.useCount), 'SOURCE_MAPPING_FUZZY', mapping.rawText);
    } else if (!mapping.customerId && !mapping.sourceId) {
      add(productShape(product, mapping), fuzzyMappingScore('COMMON', similarityScore, mapping.useCount), 'COMMON_MAPPING_FUZZY', mapping.rawText);
    }
  });

  if (customerId) {
    const customerOrderIds = new Set(orders.filter(order => order.customerId === customerId).map(order => order.orderId));
    items.filter(item => customerOrderIds.has(item.orderId)).forEach(item => {
      const score = productTextSimilarity(productText, item.itemName);
      if (score >= 0.72) add(productShape(item, item), Math.min(0.94, 0.78 + score * 0.16), 'CUSTOMER_HISTORY', item.rawText || item.itemName || '');
    });
  }

  products.forEach(product => {
    const fields = [product.itemName, product.productName, product.secondName, product.alias, product.searchInfo, product.specification].filter(Boolean);
    let score = 0;
    let matchedField = '';
    fields.forEach(field => {
      const current = productTextSimilarity(productText, field);
      if (current > score) { score = current; matchedField = field; }
    });
    if (score >= 0.58) add(productShape(product), score === 1 ? 0.94 : 0.52 + score * 0.38, score === 1 ? 'MASTER_EXACT' : 'MASTER_FUZZY', matchedField);
  });

  const byIdentity = new Map();
  candidates.forEach(candidate => {
    const key = candidate.productId || candidate.itemCode || normalizeText(candidate.itemName);
    const previous = byIdentity.get(key);
    if (!previous || candidate.score > previous.score) byIdentity.set(key, candidate);
  });
  return [...byIdentity.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}
