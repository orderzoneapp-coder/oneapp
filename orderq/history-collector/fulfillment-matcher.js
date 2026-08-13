import { normalizeText } from '../orderq-db.js';

export const LINK_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  STRONG: 'STRONG',
  PROBABLE: 'PROBABLE',
  AMBIGUOUS: 'AMBIGUOUS',
  UNLINKED: 'UNLINKED',
  EXCLUDED: 'EXCLUDED'
});

const ACCEPTED_STATUS = new Set([LINK_STATUS.CONFIRMED, LINK_STATUS.STRONG, LINK_STATUS.PROBABLE]);

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
  if (orderCode && salesCode && orderCode !== salesCode) return { score: 0, method: 'PRODUCT_CODE_CONFLICT' };
  const orderName = normalizedProductName(orderLine.productName || orderLine.rawExpression);
  const salesName = normalizedProductName(salesLine.productName);
  if (orderName && salesName && orderName === salesName) return { score: 48, method: 'EXACT_NORMALIZED_NAME' };
  if (orderName && salesName && (orderName.includes(salesName) || salesName.includes(orderName))) return { score: 32, method: 'PARTIAL_NORMALIZED_NAME' };
  return { score: 0, method: 'NO_PRODUCT_MATCH' };
}

function salesProductMatches(left, right) {
  const leftCode = String(left?.productCode || '').trim();
  const rightCode = String(right?.productCode || '').trim();
  if (leftCode && rightCode) return leftCode === rightCode;
  const leftName = normalizedProductName(left?.productName);
  const rightName = normalizedProductName(right?.productName);
  return Boolean(leftName && rightName && leftName === rightName);
}

function customerKey(row) {
  return String(row?.customerId || '').trim() || normalizeText(row?.customerName || row?.normalizedCustomerName);
}

function unitKey(row) {
  return normalizeText(row?.unit || row?.rawUnit || row?.finalUnit);
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
  if (score >= 92 && productMethod === 'EXACT_PRODUCT_CODE') return LINK_STATUS.STRONG;
  if (score >= 78 && productMethod === 'EXACT_PRODUCT_CODE') return LINK_STATUS.STRONG;
  if (score >= 62) return LINK_STATUS.PROBABLE;
  return LINK_STATUS.UNLINKED;
}

export function isEffectiveFulfillmentLink(link = {}) {
  return ACCEPTED_STATUS.has(link.status) && link.requiresReview !== true && Number(link.allocatedQuantity || 0) !== 0;
}

function createLink(candidate, salesLine, allocatedQuantity, status, extra = {}) {
  return {
    fulfillmentLinkId: extra.fulfillmentLinkId || stableId([
      candidate.orderLine.historicalOrderLineId,
      salesLine.salesLineId,
      String(allocatedQuantity),
      extra.method || candidate.product?.method || ''
    ]),
    historicalOrderGroupId: candidate.group.historicalOrderGroupId,
    historicalOrderLineId: candidate.orderLine.historicalOrderLineId,
    salesDocumentId: salesLine.salesDocumentId,
    salesLineId: salesLine.salesLineId,
    allocatedQuantity,
    status,
    method: extra.method || candidate.product?.method || '',
    confidence: Math.max(0, Math.min(100, Number(extra.confidence ?? candidate.score ?? 0))),
    evidence: extra.evidence || [
      candidate.date?.relation || 'ADMIN',
      `BASKET_OVERLAP_${Math.round(Number(candidate.basket || 0) * 100)}`,
      candidate.product?.method || 'ADMIN_CONFIRMED',
      `TIME_${candidate.date?.timeEvidence || 'ADMIN'}`
    ],
    orderDate: candidate.group.orderDate,
    salesDate: extra.salesDate || '',
    customerId: candidate.group.customerId || extra.customerId || '',
    customerName: candidate.group.customerName || extra.customerName || '',
    productCode: salesLine.productCode || candidate.orderLine.productCode || '',
    productName: salesLine.productName || candidate.orderLine.productName || '',
    requiresReview: extra.requiresReview === true,
    manualAction: extra.manualAction || '',
    manualReason: extra.manualReason || '',
    confirmedAt: extra.confirmedAt || '',
    confirmedBy: extra.confirmedBy || ''
  };
}

function residualQuantityScore(orderQuantity, salesQuantity) {
  const left = Math.max(0, Number(orderQuantity || 0));
  const right = Math.max(0, Number(salesQuantity || 0));
  if (!left || !right) return 0;
  if (left === right) return 22;
  const ratio = Math.min(left, right) / Math.max(left, right);
  return ratio >= 0.8 ? 16 : ratio >= 0.5 ? 10 : 4;
}

export function buildFulfillmentLinks({ orderGroups = [], orderLines = [], salesDocuments = [], salesLines = [], settings = {}, manualLinks = [] } = {}) {
  const activeGroups = orderGroups.filter(row => row.status !== 'ROLLED_BACK' && !row.disabledAt);
  const activeOrderLines = orderLines.filter(row => !row.disabledAt && Number(row.quantity || 0) > 0);
  const activeSalesLines = salesLines.filter(row => !row.disabledAt);
  const groupById = new Map(activeGroups.map(row => [row.historicalOrderGroupId, row]));
  const orderById = new Map(activeOrderLines.map(row => [row.historicalOrderLineId, row]));
  const salesById = new Map(activeSalesLines.map(row => [row.salesLineId, row]));
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
  const remainingSales = new Map(activeSalesLines.filter(row => Number(row.quantity || 0) > 0).map(row => [row.salesLineId, Number(row.quantity || 0)]));
  const links = [];
  const blockedPairs = new Set();
  const acceptedByOrder = new Map();
  const pairKey = (orderLineId, salesLineId) => `${orderLineId}|${salesLineId}`;
  const rememberAccepted = link => {
    if (!isEffectiveFulfillmentLink(link)) return;
    const list = acceptedByOrder.get(link.historicalOrderLineId) || [];
    list.push(link);
    acceptedByOrder.set(link.historicalOrderLineId, list);
  };

  manualLinks.filter(row => row.active !== false && row.manualAction === 'BLOCK').forEach(row => {
    if (!orderById.has(row.historicalOrderLineId) || !salesById.has(row.salesLineId)) return;
    blockedPairs.add(pairKey(row.historicalOrderLineId, row.salesLineId));
    links.push({ ...row, allocatedQuantity: 0, status: LINK_STATUS.UNLINKED, requiresReview: false });
  });

  manualLinks.filter(row => row.active !== false && row.manualAction === 'CONFIRM').forEach(row => {
    const orderLine = orderById.get(row.historicalOrderLineId);
    const salesLine = salesById.get(row.salesLineId);
    const group = orderLine ? groupById.get(orderLine.historicalOrderGroupId) : null;
    if (!orderLine || !salesLine || !group || Number(salesLine.quantity || 0) <= 0) return;
    const availableOrder = remainingOrder.get(orderLine.historicalOrderLineId) || 0;
    const availableSales = remainingSales.get(salesLine.salesLineId) || 0;
    const allocated = Math.min(availableOrder, availableSales, Math.max(0, Number(row.requestedQuantity || row.allocatedQuantity || availableSales)));
    if (!allocated) return;
    const candidate = { group, orderLine, score: 100, basket: 1, product: { method: 'ADMIN_CONFIRMED' }, date: { relation: 'ADMIN', timeEvidence: 'ADMIN' } };
    const link = createLink(candidate, salesLine, allocated, LINK_STATUS.CONFIRMED, {
      ...row,
      fulfillmentLinkId: row.fulfillmentLinkId,
      method: 'ADMIN_CONFIRMED',
      confidence: 100,
      manualAction: 'CONFIRM',
      requiresReview: false,
      evidence: ['ADMIN_CONFIRMED', ...(row.evidence || []).filter(value => value !== 'ADMIN_CONFIRMED')]
    });
    links.push(link);
    rememberAccepted(link);
    remainingOrder.set(orderLine.historicalOrderLineId, availableOrder - allocated);
    remainingSales.set(salesLine.salesLineId, availableSales - allocated);
  });

  const positiveSales = activeSalesLines.filter(row => Number(row.quantity || 0) > 0);
  for (const salesLine of positiveSales) {
    let availableSales = remainingSales.get(salesLine.salesLineId) || 0;
    if (availableSales <= 0) continue;
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
        if (available <= 0 || blockedPairs.has(pairKey(orderLine.historicalOrderLineId, salesLine.salesLineId))) return;
        const product = productScore(orderLine, salesLine);
        if (!product.score) return;
        const specificationBonus = normalizeText(orderLine.specification) && normalizeText(orderLine.specification) === normalizeText(salesLine.specification) ? 4 : 0;
        const score = date.score + product.score + Math.round(basket * 8) + specificationBonus;
        candidates.push({ group, orderLine, date, product, basket, score });
      });
    });
    candidates.sort((a, b) => b.score - a.score || String(a.group.orderDate).localeCompare(String(b.group.orderDate)) || String(a.orderLine.historicalOrderLineId).localeCompare(String(b.orderLine.historicalOrderLineId)));
    let cursor = 0;
    while (availableSales > 0 && cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const availableOrder = remainingOrder.get(candidate.orderLine.historicalOrderLineId) || 0;
      if (availableOrder <= 0) continue;
      const tied = candidates.filter(row => row.score === candidate.score && (remainingOrder.get(row.orderLine.historicalOrderLineId) || 0) > 0);
      const ambiguous = tied.length > 1 && tied.some(row => row.orderLine.historicalOrderLineId !== candidate.orderLine.historicalOrderLineId);
      const allocated = Math.min(availableSales, availableOrder);
      const baseStatus = statusFor(candidate.score, candidate.product.method, candidate.date.timeEvidence);
      const status = ambiguous ? LINK_STATUS.AMBIGUOUS : baseStatus;
      const link = createLink(candidate, salesLine, allocated, status, { salesDate, requiresReview: ambiguous });
      links.push(link);
      if (!ambiguous && status !== LINK_STATUS.UNLINKED) {
        rememberAccepted(link);
        remainingOrder.set(candidate.orderLine.historicalOrderLineId, availableOrder - allocated);
        availableSales -= allocated;
        remainingSales.set(salesLine.salesLineId, availableSales);
      } else {
        break;
      }
    }
  }

  // 1차 상품 매칭 뒤 남은 Basket을 거래처·운영일·수량·단위로만 후보화한다.
  // 이 연결은 반드시 관리자 확인을 거쳐야 하므로 잔량을 차감하지 않는다.
  for (const salesLine of positiveSales) {
    const availableSales = remainingSales.get(salesLine.salesLineId) || 0;
    if (availableSales <= 0) continue;
    const salesDoc = salesDocById.get(salesLine.salesDocumentId) || salesLine;
    const salesDate = isoDate(salesDoc.salesDate || salesLine.salesDate);
    const salesCustomer = customerKey(salesDoc) || customerKey(salesLine);
    const candidates = [];
    activeGroups.forEach(group => {
      if (customerKey(group) !== salesCustomer) return;
      const date = dateScore(group, salesDate, settings);
      if (!date.score) return;
      (orderLinesByGroup.get(group.historicalOrderGroupId) || []).forEach(orderLine => {
        const availableOrder = remainingOrder.get(orderLine.historicalOrderLineId) || 0;
        if (availableOrder <= 0 || blockedPairs.has(pairKey(orderLine.historicalOrderLineId, salesLine.salesLineId))) return;
        const product = productScore(orderLine, salesLine);
        if (product.score || product.method === 'PRODUCT_CODE_CONFLICT') return;
        const orderUnit = unitKey(orderLine);
        const salesUnit = unitKey(salesLine);
        if (orderUnit && salesUnit && orderUnit !== salesUnit) return;
        const quantityScore = residualQuantityScore(availableOrder, availableSales);
        if (!quantityScore) return;
        const unitScore = orderUnit && salesUnit ? 12 : 4;
        candidates.push({
          group,
          orderLine,
          date,
          product: { method: 'RESIDUAL_BASKET_CANDIDATE' },
          basket: 0,
          score: date.score + quantityScore + unitScore,
          quantityScore,
          unitScore
        });
      });
    });
    candidates.sort((a, b) => b.score - a.score || String(a.orderLine.historicalOrderLineId).localeCompare(String(b.orderLine.historicalOrderLineId)));
    if (!candidates.length) {
      links.push({
        fulfillmentLinkId: stableId(['UNLINKED', salesLine.salesLineId]),
        historicalOrderLineId: '',
        salesLineId: salesLine.salesLineId,
        allocatedQuantity: availableSales,
        status: LINK_STATUS.UNLINKED,
        method: 'NO_ORDER_CANDIDATE',
        confidence: 0,
        requiresReview: false,
        customerId: salesDoc.customerId || '',
        customerName: salesDoc.customerName || '',
        productCode: salesLine.productCode || '',
        productName: salesLine.productName || '',
        salesDate,
        evidence: ['같은 거래처·운영일의 잔여 주문후보 없음']
      });
      continue;
    }
    const topScore = candidates[0].score;
    const top = candidates.filter(row => row.score === topScore);
    top.forEach(candidate => {
      const allocated = Math.min(availableSales, remainingOrder.get(candidate.orderLine.historicalOrderLineId) || 0);
      links.push(createLink(candidate, salesLine, allocated, top.length === 1 ? LINK_STATUS.PROBABLE : LINK_STATUS.AMBIGUOUS, {
        salesDate,
        requiresReview: true,
        evidence: [
          candidate.date.relation,
          'RESIDUAL_BASKET',
          `QUANTITY_SCORE_${candidate.quantityScore}`,
          `UNIT_SCORE_${candidate.unitScore}`,
          top.length === 1 ? 'UNIQUE_REMAINDER' : `TIED_REMAINDERS_${top.length}`
        ]
      }));
    });
  }

  // 반품·취소 보정은 같은 거래처·상품의 최근 확정 출고에 역배분한다.
  const negativeSales = activeSalesLines.filter(row => Number(row.quantity || 0) < 0);
  negativeSales.forEach(salesLine => {
    const salesDoc = salesDocById.get(salesLine.salesDocumentId) || salesLine;
    const reversalDate = isoDate(salesDoc.salesDate || salesLine.salesDate);
    const salesCustomer = customerKey(salesDoc) || customerKey(salesLine);
    let reversal = Math.abs(Number(salesLine.quantity || 0));
    const candidates = links.filter(link => {
      if (!isEffectiveFulfillmentLink(link) || Number(link.allocatedQuantity || 0) <= 0) return false;
      const linkedSales = salesById.get(link.salesLineId);
      const linkedDoc = salesDocById.get(linkedSales?.salesDocumentId) || linkedSales;
      return customerKey(linkedDoc) === salesCustomer && salesProductMatches(linkedSales, salesLine)
        && (!reversalDate || !link.salesDate || link.salesDate <= reversalDate);
    }).sort((a, b) => String(b.salesDate || '').localeCompare(String(a.salesDate || '')));
    for (const sourceLink of candidates) {
      if (reversal <= 0) break;
      const orderLine = orderById.get(sourceLink.historicalOrderLineId);
      const group = orderLine ? groupById.get(orderLine.historicalOrderGroupId) : null;
      if (!orderLine || !group) continue;
      const alreadyNet = (acceptedByOrder.get(orderLine.historicalOrderLineId) || []).reduce((sum, row) => sum + Number(row.allocatedQuantity || 0), 0);
      if (alreadyNet <= 0) continue;
      const amount = Math.min(reversal, alreadyNet);
      const candidate = { group, orderLine, score: sourceLink.confidence || 90, basket: 1, product: { method: 'NEGATIVE_SALES_REVERSAL' }, date: { relation: 'REVERSAL', timeEvidence: 'CONFIRMED' } };
      const link = createLink(candidate, salesLine, -amount, sourceLink.status === LINK_STATUS.CONFIRMED ? LINK_STATUS.CONFIRMED : LINK_STATUS.STRONG, {
        salesDate: reversalDate,
        method: 'NEGATIVE_SALES_REVERSAL',
        confidence: sourceLink.confidence || 90,
        evidence: ['NEGATIVE_SALES_REVERSAL', `SOURCE_LINK_${sourceLink.fulfillmentLinkId}`]
      });
      links.push(link);
      rememberAccepted(link);
      remainingOrder.set(orderLine.historicalOrderLineId, Math.min(Number(orderLine.quantity || 0), (remainingOrder.get(orderLine.historicalOrderLineId) || 0) + amount));
      reversal -= amount;
    }
    if (reversal > 0) {
      links.push({
        fulfillmentLinkId: stableId(['EXCLUDED_REVERSAL', salesLine.salesLineId, String(reversal)]),
        historicalOrderLineId: '', salesLineId: salesLine.salesLineId, allocatedQuantity: -reversal,
        status: LINK_STATUS.EXCLUDED, method: 'UNRESOLVED_NEGATIVE_SALES_REVERSAL', confidence: 0,
        requiresReview: true, customerId: salesDoc.customerId || '', customerName: salesDoc.customerName || '',
        productCode: salesLine.productCode || '', productName: salesLine.productName || '', salesDate: reversalDate,
        evidence: ['연결할 기존 출고가 없는 반품·취소 보정']
      });
    }
  });

  const balances = activeOrderLines.map(orderLine => {
    const effective = links.filter(link => link.historicalOrderLineId === orderLine.historicalOrderLineId && isEffectiveFulfillmentLink(link));
    const grossShippedQuantity = effective.reduce((sum, link) => sum + Math.max(0, Number(link.allocatedQuantity || 0)), 0);
    const reversalQuantity = effective.reduce((sum, link) => sum + Math.abs(Math.min(0, Number(link.allocatedQuantity || 0))), 0);
    const netShippedQuantity = grossShippedQuantity - reversalQuantity;
    const orderedQuantity = Number(orderLine.quantity || 0);
    const remainingQuantity = Math.max(0, orderedQuantity - netShippedQuantity);
    return {
      fulfillmentBalanceId: `FB-${orderLine.historicalOrderLineId}`,
      historicalOrderGroupId: orderLine.historicalOrderGroupId,
      historicalOrderLineId: orderLine.historicalOrderLineId,
      customerId: orderLine.customerId || '',
      customerName: orderLine.customerName || groupById.get(orderLine.historicalOrderGroupId)?.customerName || '',
      productCode: orderLine.productCode || '',
      productName: orderLine.productName || orderLine.rawExpression || '',
      rawExpression: orderLine.rawExpression || '',
      unit: orderLine.unit || orderLine.rawUnit || '',
      orderedQuantity,
      grossShippedQuantity,
      reversalQuantity,
      netShippedQuantity,
      remainingQuantity,
      status: remainingQuantity > 0 ? 'UNFULFILLED' : 'FULFILLED'
    };
  });
  const unmatchedOrders = balances.filter(row => row.remainingQuantity > 0).map(balance => ({
    ...orderById.get(balance.historicalOrderLineId),
    ...balance,
    group: groupById.get(balance.historicalOrderGroupId) || null
  }));
  const unmatchedSales = positiveSales.filter(row => (remainingSales.get(row.salesLineId) || 0) > 0);

  return {
    links,
    balances,
    unmatchedOrders,
    unmatchedSales,
    summary: {
      orderLineCount: activeOrderLines.length,
      salesLineCount: activeSalesLines.length,
      linkedCount: links.filter(isEffectiveFulfillmentLink).length,
      ambiguousCount: links.filter(row => row.status === LINK_STATUS.AMBIGUOUS).length,
      reviewRequiredCount: links.filter(row => row.requiresReview === true).length,
      unlinkedOrderCount: unmatchedOrders.length,
      unlinkedSalesCount: links.filter(row => row.status === LINK_STATUS.UNLINKED && row.manualAction !== 'BLOCK').length,
      excludedSalesCount: links.filter(row => row.status === LINK_STATUS.EXCLUDED).length
    }
  };
}
