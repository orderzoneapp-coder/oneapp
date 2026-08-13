import { normalizeText } from '../orderq-db.js';

export const LINK_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  STRONG: 'STRONG',
  PROBABLE: 'PROBABLE',
  AMBIGUOUS: 'AMBIGUOUS',
  UNLINKED: 'UNLINKED',
  EXCLUDED: 'EXCLUDED'
});

function isoDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function toDate(value) {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addBusinessDays(value, days, holidays = []) {
  const date = toDate(value);
  if (!date) return '';
  const holidaySet = new Set((holidays || []).map(isoDate).filter(Boolean));
  let remaining = Math.abs(Number(days || 0));
  const direction = Number(days || 0) < 0 ? -1 : 1;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(formatDate(date))) remaining -= 1;
  }
  return formatDate(date);
}

function normalizedProductName(value) {
  return normalizeText(value)
    .replace(/\[(box|ea|kg|g|소분|단|봉|팩|판)\]$/gi, '')
    .replace(/_(box|ea|kg|g|소분)$/gi, '');
}

function productScore(orderLine, salesLine) {
  const orderCode = String(orderLine.productCode || '').trim();
  const salesCode = String(salesLine.productCode || '').trim();
  if (orderCode && salesCode && orderCode === salesCode) return { score: 60, method: 'EXACT_PRODUCT_CODE' };
  const orderName = normalizedProductName(orderLine.productName || orderLine.rawExpression);
  const salesName = normalizedProductName(salesLine.productName);
  if (orderName && salesName && orderName === salesName) return { score: 48, method: 'EXACT_NORMALIZED_NAME' };
  if (orderName && salesName && (orderName.includes(salesName) || salesName.includes(orderName))) return { score: 32, method: 'PARTIAL_NORMALIZED_NAME' };
  return { score: 0, method: 'NO_PRODUCT_MATCH' };
}

function customerKey(row) {
  return String(row.customerId || '').trim() || normalizeText(row.customerName || row.normalizedCustomerName);
}

function timeBeforeCutoff(orderTime, cutoffHour, cutoffMinute) {
  const match = String(orderTime || '').match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= Number(cutoffHour || 12) * 60 + Number(cutoffMinute || 0);
}

function dateScore(group, salesDate, settings) {
  const orderDate = isoDate(group.orderDate);
  if (!orderDate || !salesDate) return { score: 0, relation: 'DATE_UNKNOWN', timeEvidence: 'NONE' };
  const holidays = settings.holidays || [];
  const expected = addBusinessDays(orderDate, 1, holidays);
  if (salesDate === expected) return { score: 36, relation: 'NEXT_BUSINESS_DAY', timeEvidence: 'NOT_REQUIRED' };
  if (salesDate === orderDate) {
    const before = timeBeforeCutoff(group.orderTime || group.createdAt, settings.cutoffHour, settings.cutoffMinute);
    if (before === true) return { score: 34, relation: 'SAME_DAY_BEFORE_CUTOFF', timeEvidence: 'CONFIRMED' };
    if (before === null) return { score: 20, relation: 'SAME_DAY_TIME_UNKNOWN', timeEvidence: 'MISSING' };
    return { score: 4, relation: 'SAME_DAY_AFTER_CUTOFF', timeEvidence: 'AFTER_CUTOFF' };
  }
  if (salesDate === addBusinessDays(orderDate, 2, holidays)) return { score: 18, relation: 'PLUS_2_BUSINESS_DAYS', timeEvidence: 'DELAYED' };
  if (salesDate === addBusinessDays(orderDate, 3, holidays)) return { score: 10, relation: 'PLUS_3_BUSINESS_DAYS', timeEvidence: 'DELAYED' };
  return { score: 0, relation: 'OUTSIDE_WINDOW', timeEvidence: 'NONE' };
}

function basketOverlap(groupLines, salesLines) {
  const orderCodes = new Set(groupLines.map(row => String(row.productCode || '')).filter(Boolean));
  const salesCodes = new Set(salesLines.map(row => String(row.productCode || '')).filter(Boolean));
  if (!orderCodes.size || !salesCodes.size) return 0;
  let overlap = 0;
  orderCodes.forEach(code => { if (salesCodes.has(code)) overlap += 1; });
  return overlap / Math.max(orderCodes.size, salesCodes.size);
}

function stableId(parts) {
  let hash = 2166136261;
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `FL-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function statusFor(score, productMethod, timeEvidence) {
  if (timeEvidence === 'MISSING') return score >= 62 ? LINK_STATUS.PROBABLE : LINK_STATUS.UNLINKED;
  if (score >= 92 && productMethod === 'EXACT_PRODUCT_CODE' && timeEvidence !== 'MISSING') return LINK_STATUS.STRONG;
  if (score >= 78 && productMethod === 'EXACT_PRODUCT_CODE') return LINK_STATUS.STRONG;
  if (score >= 62) return LINK_STATUS.PROBABLE;
  return LINK_STATUS.UNLINKED;
}

export function buildFulfillmentLinks({ orderGroups = [], orderLines = [], salesDocuments = [], salesLines = [], settings = {} } = {}) {
  const activeGroups = orderGroups.filter(row => row.status !== 'ROLLED_BACK' && !row.disabledAt);
  const activeOrderLines = orderLines.filter(row => !row.disabledAt && Number(row.quantity || 0) > 0);
  const activeSalesLines = salesLines.filter(row => !row.disabledAt);
  const groupById = new Map(activeGroups.map(row => [row.historicalOrderGroupId, row]));
  const orderLinesByGroup = new Map();
  activeOrderLines.forEach(line => {
    const list = orderLinesByGroup.get(line.historicalOrderGroupId) || [];
    list.push(line);
    orderLinesByGroup.set(line.historicalOrderGroupId, list);
  });
  const salesDocById = new Map(salesDocuments.filter(row => !row.disabledAt).map(row => [row.salesDocumentId, row]));
  const salesLinesByDoc = new Map();
  activeSalesLines.forEach(line => {
    const list = salesLinesByDoc.get(line.salesDocumentId) || [];
    list.push(line);
    salesLinesByDoc.set(line.salesDocumentId, list);
  });
  const remainingOrder = new Map(activeOrderLines.map(row => [row.historicalOrderLineId, Math.max(0, Number(row.quantity || 0))]));
  const links = [];
  const unmatchedSales = [];

  for (const salesLine of activeSalesLines) {
    const rawQuantity = Number(salesLine.quantity || 0);
    if (rawQuantity <= 0) {
      links.push({
        fulfillmentLinkId: stableId(['EXCLUDED', salesLine.salesLineId]),
        historicalOrderLineId: '',
        salesLineId: salesLine.salesLineId,
        allocatedQuantity: rawQuantity,
        status: LINK_STATUS.EXCLUDED,
        method: rawQuantity < 0 ? 'NEGATIVE_SALES_REVERSAL' : 'ZERO_SALES',
        confidence: 100,
        evidence: ['판매수량이 0 이하이므로 출고확정에서 제외'],
      });
      continue;
    }
    const salesDoc = salesDocById.get(salesLine.salesDocumentId) || salesLine;
    const salesDate = isoDate(salesDoc.salesDate || salesLine.salesDate);
    const salesCustomer = customerKey(salesDoc) || customerKey(salesLine);
    const candidates = [];

    activeGroups.forEach(group => {
      if (customerKey(group) !== salesCustomer) return;
      const date = dateScore(group, salesDate, settings);
      if (!date.score) return;
      const groupLines = orderLinesByGroup.get(group.historicalOrderGroupId) || [];
      const basket = basketOverlap(groupLines, salesLinesByDoc.get(salesLine.salesDocumentId) || [salesLine]);
      groupLines.forEach(orderLine => {
        const available = remainingOrder.get(orderLine.historicalOrderLineId) || 0;
        if (available <= 0) return;
        const product = productScore(orderLine, salesLine);
        if (!product.score) return;
        const specificationBonus = normalizeText(orderLine.specification) && normalizeText(orderLine.specification) === normalizeText(salesLine.specification) ? 4 : 0;
        const score = date.score + product.score + Math.round(basket * 8) + specificationBonus;
        candidates.push({ group, orderLine, date, product, basket, score, available });
      });
    });

    candidates.sort((a, b) => b.score - a.score || String(a.group.orderDate).localeCompare(String(b.group.orderDate)) || String(a.orderLine.historicalOrderLineId).localeCompare(String(b.orderLine.historicalOrderLineId)));
    if (!candidates.length) {
      unmatchedSales.push(salesLine);
      links.push({
        fulfillmentLinkId: stableId(['UNLINKED', salesLine.salesLineId]),
        historicalOrderLineId: '',
        salesLineId: salesLine.salesLineId,
        allocatedQuantity: rawQuantity,
        status: LINK_STATUS.UNLINKED,
        method: 'NO_ORDER_CANDIDATE',
        confidence: 0,
        evidence: ['같은 거래처·운영일·상품 후보 주문 없음']
      });
      continue;
    }

    let remainingSales = rawQuantity;
    let cursor = 0;
    while (remainingSales > 0 && cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const currentAvailable = remainingOrder.get(candidate.orderLine.historicalOrderLineId) || 0;
      if (currentAvailable <= 0) continue;
      const tied = candidates.filter(row => row.score === candidate.score && (remainingOrder.get(row.orderLine.historicalOrderLineId) || 0) > 0);
      const ambiguous = tied.length > 1 && tied.some(row => row.orderLine.historicalOrderLineId !== candidate.orderLine.historicalOrderLineId);
      const allocatedQuantity = Math.min(remainingSales, currentAvailable);
      const baseStatus = statusFor(candidate.score, candidate.product.method, candidate.date.timeEvidence);
      const status = ambiguous ? LINK_STATUS.AMBIGUOUS : baseStatus;
      links.push({
        fulfillmentLinkId: stableId([candidate.orderLine.historicalOrderLineId, salesLine.salesLineId, String(allocatedQuantity)]),
        historicalOrderGroupId: candidate.group.historicalOrderGroupId,
        historicalOrderLineId: candidate.orderLine.historicalOrderLineId,
        salesDocumentId: salesLine.salesDocumentId,
        salesLineId: salesLine.salesLineId,
        allocatedQuantity,
        status,
        method: candidate.product.method,
        confidence: Math.max(0, Math.min(99, candidate.score)),
        evidence: [candidate.date.relation, `BASKET_OVERLAP_${Math.round(candidate.basket * 100)}`, candidate.product.method, `TIME_${candidate.date.timeEvidence}`],
        orderDate: candidate.group.orderDate,
        salesDate,
        customerId: candidate.group.customerId || salesDoc.customerId || '',
        customerName: candidate.group.customerName || salesDoc.customerName || '',
        productCode: candidate.orderLine.productCode || salesLine.productCode || ''
      });
      if (status !== LINK_STATUS.AMBIGUOUS) {
        remainingOrder.set(candidate.orderLine.historicalOrderLineId, currentAvailable - allocatedQuantity);
        remainingSales -= allocatedQuantity;
      } else {
        remainingSales = 0;
      }
    }
    if (remainingSales > 0) {
      links.push({
        fulfillmentLinkId: stableId(['REMAINDER', salesLine.salesLineId, String(remainingSales)]),
        historicalOrderLineId: '',
        salesLineId: salesLine.salesLineId,
        allocatedQuantity: remainingSales,
        status: LINK_STATUS.UNLINKED,
        method: 'SALES_REMAINDER',
        confidence: 0,
        evidence: ['판매수량 일부에 대응하는 주문수량 없음']
      });
    }
  }

  const unmatchedOrders = activeOrderLines.map(line => ({
    ...line,
    remainingQuantity: remainingOrder.get(line.historicalOrderLineId) || 0,
    group: groupById.get(line.historicalOrderGroupId) || null
  })).filter(row => row.remainingQuantity > 0);

  return {
    links,
    unmatchedOrders,
    unmatchedSales,
    summary: {
      orderLineCount: activeOrderLines.length,
      salesLineCount: activeSalesLines.length,
      linkedCount: links.filter(row => [LINK_STATUS.STRONG, LINK_STATUS.PROBABLE, LINK_STATUS.CONFIRMED].includes(row.status)).length,
      ambiguousCount: links.filter(row => row.status === LINK_STATUS.AMBIGUOUS).length,
      unlinkedOrderCount: unmatchedOrders.length,
      unlinkedSalesCount: links.filter(row => row.status === LINK_STATUS.UNLINKED).length,
      excludedSalesCount: links.filter(row => row.status === LINK_STATUS.EXCLUDED).length
    }
  };
}
