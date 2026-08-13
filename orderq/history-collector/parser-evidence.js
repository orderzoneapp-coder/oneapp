import { normalizeText } from '../orderq-db.js';
import { LINK_STATUS } from './fulfillment-matcher.js';

function stableId(parts) {
  let hash = 2166136261;
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `PE-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildParserEvidence({ links = [], orderLines = [], salesLines = [] } = {}) {
  const orderById = new Map(orderLines.map(row => [row.historicalOrderLineId, row]));
  const salesById = new Map(salesLines.map(row => [row.salesLineId, row]));
  const groups = new Map();

  links.filter(link => Number(link.allocatedQuantity || 0) > 0
    && link.requiresReview !== true
    && [LINK_STATUS.STRONG, LINK_STATUS.PROBABLE, LINK_STATUS.CONFIRMED].includes(link.status)).forEach(link => {
    const order = orderById.get(link.historicalOrderLineId);
    const sales = salesById.get(link.salesLineId);
    const rawExpression = String(order?.rawExpression || order?.productName || '').trim();
    const normalizedExpression = normalizeText(rawExpression);
    const productCode = String(sales?.productCode || order?.productCode || '').trim();
    if (!normalizedExpression || !productCode) return;
    const customerId = String(order?.customerId || link.customerId || '').trim();
    const customerScope = customerId || normalizeText(order?.customerName || link.customerName);
    const key = `${customerScope}|${normalizedExpression}`;
    const group = groups.get(key) || {
      customerId,
      customerName: order?.customerName || link.customerName || '',
      normalizedExpression,
      rawExpressions: new Set(),
      productCodes: new Set(),
      productNames: new Set(),
      orderDates: new Set(),
      fulfillmentLinkIds: [],
      sourceTypes: new Set()
    };
    group.rawExpressions.add(rawExpression);
    group.productCodes.add(productCode);
    group.productNames.add(String(sales?.productName || order?.productName || ''));
    if (link.orderDate || order?.orderDate) group.orderDates.add(String(link.orderDate || order.orderDate).slice(0, 10));
    group.fulfillmentLinkIds.push(link.fulfillmentLinkId);
    group.sourceTypes.add(order?.sourceType || 'ORDER_HISTORY');
    groups.set(key, group);
  });

  return [...groups.values()].map(group => {
    const conflict = group.productCodes.size > 1;
    const distinctDateCount = group.orderDates.size;
    const status = conflict
      ? 'CONFLICT'
      : distinctDateCount >= 3
        ? 'READY_FOR_ADMIN_CONFIRMATION'
        : 'SALES_SUPPORTED_CANDIDATE';
    const productCode = conflict ? '' : [...group.productCodes][0];
    return {
      parserEvidenceId: stableId([group.customerId || group.customerName, group.normalizedExpression, [...group.productCodes].sort().join(',')]),
      evidenceType: conflict ? 'CONFLICT' : 'ORDER_SALES_LINK',
      status,
      scope: 'CUSTOMER',
      customerId: group.customerId,
      customerName: group.customerName,
      normalizedExpression: group.normalizedExpression,
      rawExpressions: [...group.rawExpressions],
      productCode,
      conflictingProductCodes: conflict ? [...group.productCodes].sort() : [],
      productNames: [...group.productNames].filter(Boolean),
      distinctDateCount,
      orderDates: [...group.orderDates].sort(),
      supportCount: group.fulfillmentLinkIds.length,
      fulfillmentLinkIds: group.fulfillmentLinkIds,
      sourceTypes: [...group.sourceTypes]
    };
  });
}
