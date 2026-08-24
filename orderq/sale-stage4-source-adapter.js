import { canonicalSha256 } from './official-voucher-core.js?v=0.17.0';
import { openOrderQDb, requestToPromise, transactionDone, STORE } from './orderq-db.js?v=0.9.0';
import { pullCentralOfficialState } from './central-command-gateway.js?v=0.19.0';

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

function masterByIdentity(source, type, id, code) {
  const rows = source[type] || [];
  const idFields = { customers:'customerId', products:'productId', warehouses:'warehouseId' };
  const codeFields = { customers:['customerCode','erpCustomerCode','customerName','name'], products:['itemCode','productCode'], warehouses:['warehouseCode'] };
  return rows.find(row => text(row[idFields[type]]) === text(id))
    || rows.find(row => (codeFields[type] || []).some(field => text(row[field]).toUpperCase() === text(code).toUpperCase()));
}

function conversionSnapshot(allocation = {}, item = {}, direct = false) {
  const actualUnit = text(allocation.actualUnit || allocation.unit || allocation.sourceUnit).toUpperCase();
  const baseUnit = text(allocation.baseUnit || item.baseUnit || actualUnit).toUpperCase();
  const actualToBaseFactor = number(allocation.actualToBaseFactor ?? allocation.conversionFactor ?? item.actualToBaseFactor);
  const actualToRecognizedFactor = direct ? 0 : number(allocation.actualToRecognizedFactor ?? item.actualToRecognizedFactor);
  const conversionSource = text(allocation.conversionSource || item.conversionSource || (direct ? 'DIRECT_SAME_UNIT' : '')).toUpperCase();
  const conversionRuleId = text(allocation.conversionRuleId || item.conversionRuleId || (direct ? 'DIRECT_1_TO_1' : ''));
  const conversionRuleVersion = text(allocation.conversionRuleVersion || item.conversionRuleVersion || (direct ? 'DIRECT_1_TO_1_V1' : ''));
  if (!actualUnit || !baseUnit || !(actualToBaseFactor > 0) || (!direct && !(actualToRecognizedFactor > 0))
    || !conversionSource || !conversionRuleVersion) return null;
  if (direct && (actualUnit !== baseUnit || actualToBaseFactor !== 1 || conversionSource !== 'DIRECT_SAME_UNIT')) return null;
  return { actualUnit, baseUnit, recognizedUnit:text(allocation.recognizedUnit || item.recognizedUnit || actualUnit).toUpperCase(),
    actualToBaseFactor, actualToRecognizedFactor, conversionSource, conversionRuleId, conversionRuleVersion };
}

export function classifySaleAllocation(allocation = {}, source = {}, review = {}) {
  if (review.unlinkDirect === true) {
    const salesCustomer = masterByIdentity(source, 'customers', review.salesCustomerId || allocation.salesCustomerId, allocation.salesCustomerCode || allocation.customerCode || allocation.customer);
    const deliveryCustomer = masterByIdentity(source, 'customers', review.deliveryCustomerId || allocation.deliveryCustomerId || salesCustomer?.customerId, allocation.deliveryCustomerCode || allocation.deliveryCustomerName);
    const billingCustomer = masterByIdentity(source, 'customers', review.billingCustomerId || allocation.billingCustomerId || salesCustomer?.customerId, allocation.billingCustomerCode || allocation.billingCustomerName);
    const product = masterByIdentity(source, 'products', review.productId || allocation.productId, allocation.productCode);
    const warehouse = masterByIdentity(source, 'warehouses', review.warehouseId || allocation.warehouseId, allocation.warehouseCode || allocation.warehouse);
    const conversion = conversionSnapshot(allocation, {}, true);
    if (![salesCustomer, deliveryCustomer, billingCustomer, product, warehouse].every(row => active(row) && revision(row)) || !conversion) {
      return { linkStatus:'REVIEW_REQUIRED_DIRECT_MASTER_OR_CONVERSION', mode:'REVIEW', candidates:[] };
    }
    return { linkStatus:'DIRECT_UNLINKED', mode:'DIRECT', allocation, salesCustomer, deliveryCustomer, billingCustomer, product, warehouse, conversion };
  }
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
  const conversion = conversionSnapshot(allocation, match.item, false);
  if (!conversion) return { linkStatus:'REVIEW_REQUIRED_CONVERSION_PROVENANCE', mode:'REVIEW', candidates:matches };
  return { linkStatus:'ORDER_Q_LINKED', mode:'ORDER_Q', order:match.order, item:match.item, customer,
    salesCustomer, deliveryCustomer, billingCustomer, product, warehouse, dispatch, dispatchLine, conversion };
}

export function buildSaleStage4Sidecar(workspace = {}, source = {}, reviews = {}, actor = 'ADMIN') {
  const allocations = Array.isArray(workspace.allocations) ? workspace.allocations : [];
  const identityKeys = new Set(); const sourceRowKeys = new Set();
  const classified = allocations.map(allocation => {
    const sourceRowNumber = Number(allocation.sourceRowNumber);
    const sourceOccurrence = Number(allocation.sourceOccurrence);
    const sourceRowKey = text(allocation.sourceRowKey);
    const compound = `${sourceRowNumber}:${sourceOccurrence}`;
    if (!Number.isInteger(sourceRowNumber) || sourceRowNumber < 1 || !Number.isInteger(sourceOccurrence) || sourceOccurrence < 1 || !sourceRowKey) {
      throw new Error('ORDERQ_SALE_SOURCE_OCCURRENCE_REQUIRED');
    }
    if (identityKeys.has(compound) || sourceRowKeys.has(sourceRowKey)) throw new Error(`ORDERQ_SALE_SOURCE_OCCURRENCE_DUPLICATE:${compound}`);
    identityKeys.add(compound); sourceRowKeys.add(sourceRowKey);
    return { allocation, sourceRowNumber, sourceOccurrence, sourceRowKey,
      result:classifySaleAllocation(allocation, source, reviews[`${sourceRowNumber}:${sourceOccurrence}`] || reviews[sourceRowNumber] || {}) };
  });
  const groupKeys = classified.filter(row => row.result.mode !== 'REVIEW').map(row => {
    const linked = row.result.mode !== 'REVIEW' ? row.result : {};
    const customerId = text(linked.salesCustomer?.customerId);
    return stableSaleGroupKey({ ...workspace, ...row.allocation, salesCustomerId:customerId,
      deliveryCustomerId:text(linked.deliveryCustomer?.customerId), billingCustomerId:text(linked.billingCustomer?.customerId),
      warehouseId:text(linked.warehouse?.warehouseId || row.allocation.warehouseId), orderId:text(linked.order?.orderId), dispatchId:text(linked.dispatch?.dispatchId) });
  });
  const ordinals = assignStableVoucherOrdinals(groupKeys, workspace.saleStage4Sidecar?.voucherOrdinalByGroupKey);
  let groupCursor = 0;
  const rows = classified.map(row => {
    const linked = row.result.mode !== 'REVIEW' ? row.result : {};
    const customerId = text(linked.salesCustomer?.customerId);
    const groupKey = row.result.mode === 'REVIEW' ? '' : groupKeys[groupCursor++];
    return {
      sourceRowKey:row.sourceRowKey, sourceRowNumber:row.sourceRowNumber, sourceOccurrence:row.sourceOccurrence,
      stableGroupKey:groupKey, sourceVoucherIndex:groupKey ? Number(ordinals[groupKey]) : 0,
      orderId:text(linked.order?.orderId), orderRevision:revision(linked.order) || '',
      orderItemId:text(linked.item?.orderItemId), orderItemRevision:revision(linked.item) || '',
      salesCustomerId:customerId, salesCustomerRevision:revision(linked.salesCustomer) || '',
      deliveryCustomerId:text(linked.deliveryCustomer?.customerId), deliveryCustomerRevision:revision(linked.deliveryCustomer) || '',
      billingCustomerId:text(linked.billingCustomer?.customerId), billingCustomerRevision:revision(linked.billingCustomer) || '',
      dispatchId:text(linked.dispatch?.dispatchId), dispatchRevision:revision(linked.dispatch) || '',
      dispatchLineId:text(linked.dispatchLine?.dispatchLineId), dispatchLineRevision:revision(linked.dispatchLine) || '',
      productId:text(linked.product?.productId), productMasterRevision:revision(linked.product) || '',
      warehouseId:text(linked.warehouse?.warehouseId), warehouseMasterRevision:revision(linked.warehouse) || '',
      actualUnit:text(linked.conversion?.actualUnit), baseUnit:text(linked.conversion?.baseUnit), recognizedUnit:text(linked.conversion?.recognizedUnit),
      actualToBaseFactor:linked.conversion?.actualToBaseFactor ?? '', actualToRecognizedFactor:linked.conversion?.actualToRecognizedFactor ?? '',
      conversionSource:text(linked.conversion?.conversionSource), conversionRuleId:text(linked.conversion?.conversionRuleId), conversionRuleVersion:text(linked.conversion?.conversionRuleVersion),
      linkStatus:row.result.linkStatus, linkedAt:new Date().toISOString(), linkedBy:text(actor)
    };
  });
  return { schemaVersion:SALE_SIDECAR_SCHEMA, planId:text(workspace.planId), sourceFingerprint:text(workspace.sourceFingerprint),
    basisDate:text(workspace.basisDate), voucherOrdinalByGroupKey:ordinals, rows };
}

export async function loadSaleStage4SourceSnapshot() {
  const db = await openOrderQDb();
  const names = [STORE.ORDERS, STORE.ORDER_ITEMS, STORE.CUSTOMERS, STORE.PRODUCTS, STORE.WAREHOUSES, STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES];
  const tx = db.transaction(names, 'readonly');
  const [orders, orderItems, customers, products, warehouses, dispatches, dispatchLines] = await Promise.all(names.map(name => requestToPromise(tx.objectStore(name).getAll())));
  await transactionDone(tx);
  return { orders, orderItems, customers, products, warehouses, dispatches, dispatchLines };
}

export async function connectSaleStage4Workspace(workspace = {}, options = {}) {
  const pull = options.pull || pullCentralOfficialState;
  const loadSource = options.loadSource || loadSaleStage4SourceSnapshot;
  await pull();
  const source = options.source || await loadSource();
  const sidecar = buildSaleStage4Sidecar(workspace, source, options.reviews || {}, options.actor || 'ADMIN');
  return attachSaleSidecar(workspace, sidecar);
}

export function attachSaleSidecar(workspace = {}, sidecar = {}) {
  return { ...workspace, saleStage4Sidecar:JSON.parse(JSON.stringify(sidecar)) };
}
