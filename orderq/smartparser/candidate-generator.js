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
  return (mapping.status || 'ACTIVE') === 'ACTIVE';
}

function fuzzyMappingScore(kind, similarityScore, useCount = 0) {
  const usageBonus = Math.min(10, Number(useCount || 0)) * 0.002;
  if (kind === 'CUSTOMER') return Math.min(0.97, 0.80 + similarityScore * 0.18 + usageBonus);
  if (kind === 'SOURCE') return Math.min(0.93, 0.74 + similarityScore * 0.18 + usageBonus);
  return Math.min(0.90, 0.70 + similarityScore * 0.18 + usageBonus);
}

export async function loadCandidateContext() {
  const [mappings, products, orders, items] = await Promise.all([
    getAll(STORE.PRODUCT_MAPPINGS),
    getAll(STORE.PRODUCTS),
    getAll(STORE.ORDERS),
    getAll(STORE.ORDER_ITEMS)
  ]);
  return {
    mappings,
    products,
    orders,
    items,
    productById: new Map(products.map(product => [product.productId, product]))
  };
}

export async function generateProductCandidates({ productText, customerId = '', sourceId = '', itemCodeHint = '', context = null } = {}) {
  const normalized = normalizeText(productText);
  const normalizedCodeHint = normalizeText(itemCodeHint);
  if (!normalized && !normalizedCodeHint) return [];
  const loaded = context || await loadCandidateContext();
  const mappings = loaded.mappings || [];
  const products = loaded.products || [];
  const orders = loaded.orders || [];
  const items = loaded.items || [];
  const productById = loaded.productById || new Map(products.map(product => [product.productId, product]));
  const candidates = [];
  const add = (shape, score, source, evidenceText = '') => {
    if (!shape.productId && !shape.itemCode && !shape.itemName) return;
    candidates.push({ ...shape, score, source, evidenceText });
  };

  if (normalizedCodeHint) {
    const exactCodeProduct = products.find(product => normalizeText(product.itemCode || product.productCode || product.productId) === normalizedCodeHint);
    if (exactCodeProduct) add(productShape(exactCodeProduct), 1.02, 'MASTER_CODE', itemCodeHint);
  }

  mappings.filter(mappingIsActive).forEach(mapping => {
    const mappingText = mapping.normalizedText || mapping.rawText || '';
    const mappedNormalized = normalizeText(mappingText);
    if (!mappedNormalized || !normalized) return;
    const product = productById.get(mapping.productId) || {};
    const exact = mappedNormalized === normalized;
    const similarityScore = exact ? 1 : productTextSimilarity(productText, mappingText);

    if (exact) {
      if (customerId && mapping.customerId === customerId) add(productShape(product, mapping), 1, 'CUSTOMER_MAPPING', mapping.rawText);
      else if (sourceId && mapping.sourceId === sourceId) add(productShape(product, mapping), 0.98, 'SOURCE_MAPPING', mapping.rawText);
      else if (!mapping.customerId && !mapping.sourceId) add(productShape(product, mapping), 0.96, 'COMMON_MAPPING', mapping.rawText);
      return;
    }

    if (similarityScore < 0.68) return;
    if (customerId && mapping.customerId === customerId) {
      add(productShape(product, mapping), fuzzyMappingScore('CUSTOMER', similarityScore, mapping.useCount), 'CUSTOMER_MAPPING_FUZZY', mapping.rawText);
    } else if (sourceId && mapping.sourceId === sourceId) {
      add(productShape(product, mapping), fuzzyMappingScore('SOURCE', similarityScore, mapping.useCount), 'SOURCE_MAPPING_FUZZY', mapping.rawText);
    } else if (!mapping.customerId && !mapping.sourceId) {
      add(productShape(product, mapping), fuzzyMappingScore('COMMON', similarityScore, mapping.useCount), 'COMMON_MAPPING_FUZZY', mapping.rawText);
    }
  });

  if (customerId && normalized) {
    const customerOrderIds = new Set(orders.filter(order => order.customerId === customerId).map(order => order.orderId));
    items.filter(item => customerOrderIds.has(item.orderId)).forEach(item => {
      const score = productTextSimilarity(productText, item.itemName);
      if (score >= 0.72) add(productShape(item, item), Math.min(0.94, 0.78 + score * 0.16), 'CUSTOMER_HISTORY', item.rawText || item.itemName || '');
    });
  }

  if (normalized) {
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
  }

  const byIdentity = new Map();
  candidates.forEach(candidate => {
    const key = candidate.productId || candidate.itemCode || normalizeText(candidate.itemName);
    const previous = byIdentity.get(key);
    if (!previous || candidate.score > previous.score) byIdentity.set(key, candidate);
  });
  return [...byIdentity.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}
