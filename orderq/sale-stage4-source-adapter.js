import { canonicalSha256 } from './official-voucher-core.js?v=0.17.0';

export const SALE_SIDECAR_SCHEMA = 'ORDERQ_SALE_SIDECAR_V1';
export const SALE_META_SCHEMA = 'ORDERQ_SALES_META_V1';

const text = value => String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
const number = value => {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const parsed = Number(value);
  return Object.is(parsed, -0) ? 0 : parsed;
};
const active = row => row && row.active !== false && !['CANCELLED', 'SUPERSEDED', 'REVERSED'].includes(text(row.status || row.businessStatus || row.matchStatus).toUpperCase());
const revision = row => {
  const value = number(row?.revision ?? row?.centralRevision);
  return value !== null && value > 0 ? value : null;
};
const productKey = row => text(row?.productId || row?.productCode || row?.itemCode).toUpperCase();

export function stableSaleGroupKey(input = {}) {
  return canonicalSha256({
    planId:text(input.planId), sourceFingerprint:text(input.sourceFingerprint), basisDate:text(input.basisDate),
    salesCustomerId:text(input.salesCustomerId), deliveryCustomerId:text(input.deliveryCustomerId), billingCustomerId:text(input.billingCustomerId),
    warehouseId:text(input.warehouseId), externalDocumentNo:text(input.externalDocumentNo),
    sourceOrderIdGroup:text(input.sourceOrderIdGroup || input.orderId), sourceDispatchId:text(input.sourceDispatchId || input.dispatchId)
  });
}

export function assignStableVoucherOrdinals(groupKeys = [], previous = {}) {
  const result = { ...(previous || {}) };
  let ordinal = Math.max(0, ...Object.values(result).map(value => Number(value) || 0));
  [...new Set(groupKeys.map(text).filter(Boolean))].sort().forEach(key => {
    if (!Number.isInteger(Number(result[key])) || Number(result[key]) < 1) result[key] = ++ordinal;
  });
  return result;
}

function exactOrderCandidates(allocation, source) {
  const orderNumber = text(allocation.orderNumber);
  const orders = (source.orders || []).filter(order => active(order) && (
    text(order.orderNo) === orderNumber ||
    (text(order.sourceType) && text(order.externalOrderNo) && `${text(order.sourceType)}:${text(order.externalOrderNo)}` === orderNumber)
  ));
  return orders.flatMap(order => (source.orderItems || []).filter(item => active(item)
    && text(item.orderId) === text(order.orderId)
    && productKey(item) === productKey(allocation)
    && number(item.sourceRowNumber ?? item.sourceOccurrence) !== null
    && Number(item.sourceRowNumber ?? item.sourceOccurrence) === Number(allocation.sourceRowNumber)
  ).map(item => ({ order, item })));
}

function record(source, type, id) {
  const rows = source[type] || [];
  const idFields = { customers:'customerId', products:'productId', warehouses:'warehouseId', dispatches:'dispatchId', dispatchLines:'dispatchLineId' };
  return rows.find(row => text(row[idFields[type]]) === text(id));
}

export function classifySaleAllocation(allocation = {}, source = {}, review = {}) {
  if (review.unlinkDirect === true) return { linkStatus:'DIRECT_UNLINKED', mode:'DIRECT', allocation };
  const explicitOrderId = text(review.orderId || allocation.orderId);
  const explicitItemId = text(review.orderItemId || allocation.orderItemId);
  let matches = exactOrderCandidates(allocation, source);
  if (explicitOrderId || explicitItemId) matches = matches.filter(match => (!explicitOrderId || text(match.order.orderId) === explicitOrderId)
    && (!explicitItemId || text(match.item.orderItemId) === explicitItemId));
  if (matches.length !== 1) return { linkStatus:matches.length ? 'REVIEW_REQUIRED_AMBIGUOUS' : 'REVIEW_REQUIRED_MISSING', mode:'REVIEW', candidates:matches };
  const match = matches[0];
  const orderRevision = revision(match.order);
  const itemRevision = revision(match.item);
  if (!orderRevision || !itemRevision) return { linkStatus:'REVIEW_REQUIRED_SOURCE_REVISION_MISSING', mode:'REVIEW', candidates:matches };
  const customer = record(source, 'customers', match.order.customerId);
  const salesCustomer = record(source, 'customers', review.salesCustomerId || allocation.salesCustomerId || match.order.customerId);
  const deliveryCustomer = record(source, 'customers', review.deliveryCustomerId || allocation.deliveryCustomerId || match.order.customerId);
  const billingCustomer = record(source, 'customers', review.billingCustomerId || allocation.billingCustomerId || allocation.salesCustomerId || match.order.customerId);
  const product = record(source, 'products', match.item.productId);
  const warehouse = record(source, 'warehouses', review.warehouseId || allocation.warehouseId || match.order.warehouseId);
  if (![customer, salesCustomer, deliveryCustomer, billingCustomer, product, warehouse].every(row => active(row) && revision(row))) return { linkStatus:'REVIEW_REQUIRED_MASTER_REVISION_MISSING', mode:'REVIEW', candidates:matches };
  const dispatchId = text(review.dispatchId || allocation.dispatchId);
  const dispatchLineId = text(review.dispatchLineId || allocation.dispatchLineId);
  if (Boolean(dispatchId) !== Boolean(dispatchLineId)) return { linkStatus:'REVIEW_REQUIRED_DISPATCH_PAIR', mode:'REVIEW', candidates:matches };
  const dispatch = dispatchId ? record(source, 'dispatches', dispatchId) : null;
  const dispatchLine = dispatchLineId ? record(source, 'dispatchLines', dispatchLineId) : null;
  if (dispatchId && (!dispatch || !dispatchLine || !revision(dispatch) || !revision(dispatchLine)
    || text(dispatchLine.dispatchId) !== dispatchId || text(dispatchLine.orderItemId) !== text(match.item.orderItemId))) {
    return { linkStatus:'REVIEW_REQUIRED_DISPATCH_INVALID', mode:'REVIEW', candidates:matches };
  }
  return { linkStatus:'ORDER_Q_LINKED', mode:'ORDER_Q', order:match.order, item:match.item, customer,
    salesCustomer, deliveryCustomer, billingCustomer, product, warehouse, dispatch, dispatchLine };
}

export function buildSaleStage4Sidecar(workspace = {}, source = {}, reviews = {}, actor = 'ADMIN') {
  const allocations = Array.isArray(workspace.allocations) ? workspace.allocations : [];
  const occurrence = new Map();
  const classified = allocations.map((allocation, index) => {
    const sourceRowNumber = Number(allocation.sourceRowNumber || index + 2);
    const basis = canonicalSha256({ planId:text(workspace.planId), sourceFingerprint:text(workspace.sourceFingerprint), sourceRowNumber,
      orderNumber:text(allocation.orderNumber), productCode:text(allocation.productCode), customer:text(allocation.customer) });
    const sourceOccurrence = (occurrence.get(basis) || 0) + 1;
    occurrence.set(basis, sourceOccurrence);
    return { allocation, sourceRowNumber, sourceOccurrence, sourceRowKey:canonicalSha256({ basis, sourceOccurrence }),
      result:classifySaleAllocation(allocation, source, reviews[`${sourceRowNumber}:${sourceOccurrence}`] || reviews[sourceRowNumber] || {}) };
  });
  const groupKeys = classified.filter(row => row.result.mode !== 'REVIEW').map(row => {
    const linked = row.result.mode === 'ORDER_Q' ? row.result : {};
    const customerId = text(linked.salesCustomer?.customerId || row.allocation.salesCustomerId);
    return stableSaleGroupKey({ ...workspace, ...row.allocation, salesCustomerId:customerId,
      deliveryCustomerId:text(row.allocation.deliveryCustomerId || customerId), billingCustomerId:text(row.allocation.billingCustomerId || customerId),
      warehouseId:text(linked.warehouse?.warehouseId || row.allocation.warehouseId), orderId:text(linked.order?.orderId), dispatchId:text(linked.dispatch?.dispatchId) });
  });
  const ordinals = assignStableVoucherOrdinals(groupKeys, workspace.saleStage4Sidecar?.voucherOrdinalByGroupKey);
  let groupCursor = 0;
  const rows = classified.map(row => {
    const linked = row.result.mode === 'ORDER_Q' ? row.result : {};
    const customerId = text(linked.salesCustomer?.customerId || row.allocation.salesCustomerId);
    const groupKey = row.result.mode === 'REVIEW' ? '' : groupKeys[groupCursor++];
    return {
      sourceRowKey:row.sourceRowKey, sourceRowNumber:row.sourceRowNumber, sourceOccurrence:row.sourceOccurrence,
      stableGroupKey:groupKey, sourceVoucherIndex:groupKey ? Number(ordinals[groupKey]) : 0,
      orderId:text(linked.order?.orderId), orderRevision:revision(linked.order) || '',
      orderItemId:text(linked.item?.orderItemId), orderItemRevision:revision(linked.item) || '',
      salesCustomerId:customerId, salesCustomerRevision:revision(linked.salesCustomer) || '',
      deliveryCustomerId:text(linked.deliveryCustomer?.customerId || row.allocation.deliveryCustomerId || customerId), deliveryCustomerRevision:revision(linked.deliveryCustomer) || '',
      billingCustomerId:text(linked.billingCustomer?.customerId || row.allocation.billingCustomerId || customerId), billingCustomerRevision:revision(linked.billingCustomer) || '',
      dispatchId:text(linked.dispatch?.dispatchId), dispatchRevision:revision(linked.dispatch) || '',
      dispatchLineId:text(linked.dispatchLine?.dispatchLineId), dispatchLineRevision:revision(linked.dispatchLine) || '',
      productId:text(linked.product?.productId), productMasterRevision:revision(linked.product) || '',
      warehouseId:text(linked.warehouse?.warehouseId), warehouseMasterRevision:revision(linked.warehouse) || '',
      linkStatus:row.result.linkStatus, linkedAt:new Date().toISOString(), linkedBy:text(actor)
    };
  });
  return { schemaVersion:SALE_SIDECAR_SCHEMA, planId:text(workspace.planId), sourceFingerprint:text(workspace.sourceFingerprint),
    basisDate:text(workspace.basisDate), voucherOrdinalByGroupKey:ordinals, rows };
}

export function attachSaleSidecar(workspace = {}, sidecar = {}) {
  return { ...workspace, saleStage4Sidecar:JSON.parse(JSON.stringify(sidecar)) };
}
