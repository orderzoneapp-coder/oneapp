import './canonical-hash-compat.js?v=0.1.0';

export const SALES_META_SCHEMA = 'ORDERQ_SALES_META_V1';
export const SALES_META_SHEET = '_NEXUS_SALES_META';
export const SALES_QUANTITY_RULE = 'SALE_QUANTITY_RULE_V1';
const hashApi = globalThis.ORDERQ_CANONICAL_HASH;
const text = value => String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
const upper = value => text(value).toUpperCase();
const finite = (value, code = 'ORDERQ_SALE_NUMBER_INVALID') => {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  const result = Number(value); return Object.is(result, -0) ? 0 : result;
};
const numericHeaders = new Set(['sourceRowNumber','sourceOccurrence','visibleRowNo','sourceVoucherIndex','salesCustomerRevision','deliveryCustomerRevision','billingCustomerRevision',
  'productMasterRevision','warehouseMasterRevision','sourceOrderRevision','sourceOrderItemRevision','sourceDispatchRevision','sourceDispatchLineRevision',
  'suggestedActualQuantity','suggestedBaseQuantity','suggestedRecognizedOrderQuantity','suggestedActualToBaseFactor','suggestedActualToRecognizedFactor']);
const digestHeaders = ['schemaVersion','ruleVersion','planId','sourceFingerprint','basisDate','sourceRowKey','sourceRowNumber','sourceOccurrence','visibleSheetName','visibleRowNo','sourceVoucherIndex',
  'originSystem','originTransactionId','sourceDocumentKey','sourceLineKey','stableGroupKey','salesCustomerId','salesCustomerRevision','deliveryCustomerId','deliveryCustomerRevision',
  'billingCustomerId','billingCustomerRevision','productId','productCode','productMasterRevision','warehouseId','warehouseCode','warehouseMasterRevision','sourceOrderId','sourceOrderRevision',
  'sourceOrderItemId','sourceOrderItemRevision','sourceDispatchId','sourceDispatchRevision','sourceDispatchLineId','sourceDispatchLineRevision','suggestedActualQuantity','suggestedActualUnit',
  'suggestedBaseQuantity','suggestedBaseUnit','suggestedRecognizedOrderQuantity','suggestedRecognizedUnit','suggestedActualToBaseFactor','suggestedActualToRecognizedFactor','conversionSource',
  'conversionRuleId','conversionRuleVersion','priorAllocationRefs'];

export function isSalesMetaSheet(sheetName, matrix = []) {
  if (text(sheetName) === SALES_META_SHEET) return true;
  const headers = (matrix[0] || []).map(text); const schema = headers.indexOf('schemaVersion');
  return schema >= 0 && headers.includes('rowDigest') && matrix.slice(1, 6).some(row => text(row?.[schema]) === SALES_META_SCHEMA);
}

export function salesMetaDigestPairs(meta = {}) {
  return digestHeaders.map(key => [key, numericHeaders.has(key) && meta[key] !== '' ? finite(meta[key]) : text(meta[key])]);
}

export function salesMetaRowDigest(meta = {}) { return hashApi.canonicalSha256(salesMetaDigestPairs(meta)); }

export function readSalesMeta(matrix = []) {
  const headers = (matrix[0] || []).map(text);
  if (!headers.includes('schemaVersion') || !headers.includes('rowDigest')) throw new Error('ORDERQ_SALE_META_INVALID');
  const occurrences = new Set(); const sourceKeys = new Set();
  return matrix.slice(1).filter(row => (row || []).some(cell => text(cell))).map((row, offset) => {
    const meta = Object.fromEntries(headers.map((header, index) => [header, row?.[index] ?? '']));
    if (text(meta.schemaVersion) !== SALES_META_SCHEMA || text(meta.ruleVersion) !== SALES_QUANTITY_RULE) throw new Error(`ORDERQ_SALE_META_SCHEMA_INVALID:${offset + 2}`);
    if (salesMetaRowDigest(meta) !== text(meta.rowDigest).toLowerCase()) throw new Error(`ORDERQ_SALE_META_MUTATED:${offset + 2}`);
    numericHeaders.forEach(key => { if (meta[key] !== '') meta[key] = finite(meta[key]); });
    const occurrenceKey = `${Number(meta.sourceRowNumber)}:${Number(meta.sourceOccurrence)}`;
    if (!Number.isInteger(Number(meta.sourceRowNumber)) || Number(meta.sourceRowNumber) < 1
      || !Number.isInteger(Number(meta.sourceOccurrence)) || Number(meta.sourceOccurrence) < 1 || !text(meta.sourceRowKey)) {
      throw new Error(`ORDERQ_SALE_META_IDENTITY_REQUIRED:${offset + 2}`);
    }
    if (occurrences.has(occurrenceKey) || sourceKeys.has(text(meta.sourceRowKey))) throw new Error(`ORDERQ_SALE_META_IDENTITY_DUPLICATE:${offset + 2}`);
    occurrences.add(occurrenceKey); sourceKeys.add(text(meta.sourceRowKey));
    if (!(Number(meta.suggestedActualToBaseFactor) > 0) || Number(meta.suggestedActualToRecognizedFactor) < 0
      || !text(meta.conversionSource) || !text(meta.conversionRuleVersion)) throw new Error(`ORDERQ_SALE_META_CONVERSION_INVALID:${offset + 2}`);
    try { meta.priorAllocationRefs = JSON.parse(text(meta.priorAllocationRefs) || '[]'); } catch { throw new Error(`ORDERQ_SALE_META_INVALID:${offset + 2}:ALLOCATIONS`); }
    return meta;
  });
}

export function recomputeSaleLine(row = {}, meta = {}) {
  const actualQuantity = finite(row.quantity ?? row.actualQuantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
  const unitPrice = finite(row.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
  const actualToBaseFactor = finite(meta.suggestedActualToBaseFactor ?? row.actualToBaseFactor, 'ORDERQ_SALE_BASE_FACTOR_REQUIRED');
  const direct = upper(row.sourceType || meta.sourceType) === 'DIRECT';
  const actualToRecognizedFactor = direct ? 0 : finite(meta.suggestedActualToRecognizedFactor ?? row.actualToRecognizedFactor, 'ORDERQ_SALE_RECOGNIZED_FACTOR_REQUIRED');
  if (!(actualToBaseFactor > 0) || !(actualToRecognizedFactor >= 0)) throw new Error('ORDERQ_SALE_CONVERSION_INVALID');
  const baseQuantity = actualQuantity * actualToBaseFactor;
  const recognizedOrderQuantity = direct ? 0 : actualQuantity * actualToRecognizedFactor;
  const rawAmount = actualQuantity * unitPrice;
  const supplyAmount = Math.sign(rawAmount) * Math.floor(Math.abs(rawAmount) + 0.5);
  return { ...row, actualQuantity, quantity:actualQuantity, unitPrice, actualToBaseFactor, actualToRecognizedFactor, baseQuantity,
    recognizedOrderQuantity, supplyAmount, totalAmount:supplyAmount, vatAmount:null, taxType:'VAT_INCLUDED_IN_SUPPLY', currency:'KRW' };
}

export function joinSalesMeta({ visibleSheetName, visibleRows = [], metaRows = [] } = {}) {
  const lookup = new Map();
  metaRows.forEach(meta => {
    const key = `${text(meta.visibleSheetName)}\u001f${Number(meta.visibleRowNo)}`;
    if (lookup.has(key)) throw new Error(`ORDERQ_SALE_META_INVALID:DUPLICATE:${key}`);
    lookup.set(key, meta);
  });
  const joined = visibleRows.map(row => {
    const key = `${text(visibleSheetName)}\u001f${Number(row.sourceRowNo || row.sourceLineNo)}`;
    const meta = lookup.get(key); if (!meta) throw new Error(`ORDERQ_SALE_META_INVALID:MISSING:${key}`); lookup.delete(key);
    if (upper(row.itemCode || row.productCode) !== upper(meta.productCode)) throw new Error(`ORDERQ_SALE_META_MUTATED:${key}:PRODUCT`);
    if (upper(row.unit || row.actualUnit) !== upper(meta.suggestedActualUnit)) throw new Error(`ORDERQ_SALE_META_MUTATED:${key}:UNIT`);
    const merged = { ...row, ...meta, quantity:row.quantity, unitPrice:row.unitPrice, sourceType:meta.sourceOrderId ? 'ORDER_Q' : 'DIRECT',
      contractKind:'SALE_STAGE4_V1', orderLinkMode:meta.sourceOrderId ? 'ORDER_Q' : 'DIRECT', metaStatus:'VERIFIED' };
    return recomputeSaleLine(merged, meta);
  });
  if (lookup.size) throw new Error(`ORDERQ_SALE_META_INVALID:ORPHAN:${lookup.size}`);
  return joined;
}

export function detachOrderQSaleLink(row = {}, { originSystem = 'SMARTINPUT_FILE', originTransactionId } = {}) {
  const system = upper(originSystem); const tx = text(originTransactionId || row.directOriginTransactionId);
  if (!tx) throw new Error('ORDERQ_SALE_DIRECT_IDENTITY_REQUIRED');
  const sourceDocumentKey = `SALE:${hashApi.canonicalSha256({ contractKind:'SALE_STAGE4_V1', originSystem:system, originTransactionId:tx,
    externalDocumentNo:text(row.externalDocumentNo), sourceVoucherIndex:Number(row.sourceVoucherIndex || 1) })}`;
  return recomputeSaleLine({ ...row, sourceType:'DIRECT', orderLinkMode:'DIRECT', originSystem:system, originTransactionId:tx,
    sourceDocumentKey, sourceOrderId:'', sourceOrderItemId:'', sourceDispatchId:'', sourceDispatchLineId:'', priorAllocationRefs:[],
    sourceOrderRevision:'', sourceOrderItemRevision:'', sourceDispatchRevision:'', sourceDispatchLineRevision:'',
    reversalSourceAllocations:[], restorationSourceReversals:[], recognizedOrderQuantity:0, actualToRecognizedFactor:0,
    actualToBaseFactor:1, baseUnit:text(row.actualUnit || row.unit).toUpperCase(),
    conversionSource:'DIRECT_SAME_UNIT', conversionRuleId:'DIRECT_1_TO_1', conversionRuleVersion:'DIRECT_1_TO_1_V1', metaStatus:'DIRECT_DETACHED' },
  { suggestedActualToBaseFactor:1, suggestedActualToRecognizedFactor:0 });
}
