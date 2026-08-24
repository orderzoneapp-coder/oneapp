import '../orderq/canonical-hash.js?v=0.1.0';

export const PURCHASE_META_SCHEMA = 'ORDERQ_PURCHASE_META_V2';
export const PURCHASE_META_SHEET = '_NEXUS_META';
export const PURCHASE_UNIT_RULE = 'PURCHASE_UNIT_RULE_V1';
const hashApi = globalThis.ORDERQ_CANONICAL_HASH;

function text(value) { return String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim(); }
function upper(value) { return text(value).toUpperCase(); }
function number(value, code = 'ORDERQ_PURCHASE_META_NUMBER_INVALID') {
  if (value === '' || value === null || value === undefined) throw new Error(code);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(code);
  return Object.is(result, -0) ? 0 : result;
}
function integer(value) {
  const result = number(value);
  if (!Number.isSafeInteger(result)) throw new Error('ORDERQ_PURCHASE_META_INTEGER_INVALID');
  return String(result);
}

export function purchaseMetaDigestPairs(meta = {}) {
  return [
    ['schemaVersion', text(meta.schemaVersion)], ['ruleVersion', text(meta.ruleVersion)],
    ['originSystem', upper(meta.originSystem)], ['originTransactionId', text(meta.originTransactionId)],
    ['planId', text(meta.planId)], ['sourceFingerprint', text(meta.sourceFingerprint)],
    ['basisDate', text(meta.basisDate)], ['sourceRowKey', text(meta.sourceRowKey)],
    ['sourceVoucherIndex', integer(meta.sourceVoucherIndex)], ['documentSuffix', text(meta.documentSuffix)],
    ['documentOrdinal', integer(meta.documentOrdinal)], ['purchasePlanId', text(meta.purchasePlanId)],
    ['sourceDocumentKey', text(meta.sourceDocumentKey)], ['sourceLineKey', text(meta.sourceLineKey)],
    ['visibleSheetName', text(meta.visibleSheetName)], ['visibleRowNo', integer(meta.visibleRowNo)],
    ['supplierCustomerId', text(meta.supplierCustomerId)], ['supplierCustomerCode', upper(meta.supplierCustomerCode)],
    ['productId', text(meta.productId)], ['productCode', upper(meta.productCode)],
    ['warehouseId', text(meta.warehouseId)], ['warehouseCode', upper(meta.warehouseCode)],
    ['suggestedQuantity', number(meta.suggestedQuantity)], ['suggestedUnit', upper(meta.suggestedUnit)],
    ['suggestedBaseQuantity', number(meta.suggestedBaseQuantity)], ['suggestedBaseUnit', upper(meta.suggestedBaseUnit)],
    ['unit', upper(meta.unit)], ['baseUnit', upper(meta.baseUnit)],
    ['conversionFactor', number(meta.conversionFactor)], ['conversionSource', upper(meta.conversionSource)],
    ['conversionRuleVersion', text(meta.conversionRuleVersion)],
  ];
}

export function purchaseMetaRowDigest(meta) {
  if (!hashApi?.canonicalSha256) throw new Error('ORDERQ_CANONICAL_HASH_NOT_LOADED');
  return hashApi.canonicalSha256(purchaseMetaDigestPairs(meta));
}

export function isPurchaseMetaSheet(sheetName, matrix = []) {
  if (text(sheetName) === PURCHASE_META_SHEET) return true;
  const headers = new Set((matrix[0] || []).map(text));
  const schemaIndex = (matrix[0] || []).findIndex(value => text(value) === 'schemaVersion');
  return headers.has('rowDigest') && schemaIndex >= 0
    && matrix.slice(1, 6).some(row => text(row?.[schemaIndex]) === PURCHASE_META_SCHEMA);
}

export function readPurchaseMeta(matrix = []) {
  const headers = (matrix[0] || []).map(text);
  const index = new Map(headers.map((header, column) => [header, column]));
  if (!index.has('schemaVersion') || !index.has('rowDigest')) throw new Error('ORDERQ_PURCHASE_META_JOIN_INVALID');
  return matrix.slice(1).filter(row => (row || []).some(cell => text(cell))).map((row, offset) => {
    const record = Object.fromEntries(headers.map((header, column) => [header, row?.[column] ?? '']));
    if (text(record.schemaVersion) !== PURCHASE_META_SCHEMA || text(record.ruleVersion) !== PURCHASE_UNIT_RULE) {
      throw new Error(`ORDERQ_PURCHASE_META_SCHEMA_INVALID:${offset + 2}`);
    }
    if (!(number(record.conversionFactor) > 0)) throw new Error(`ORDERQ_PURCHASE_META_CONVERSION_INVALID:${offset + 2}`);
    const digest = purchaseMetaRowDigest(record);
    if (digest !== text(record.rowDigest).toLowerCase()) throw new Error(`ORDERQ_PURCHASE_META_MUTATED:${offset + 2}`);
    return { ...record, sourceVoucherIndex: Number(record.sourceVoucherIndex), documentOrdinal: Number(record.documentOrdinal), visibleRowNo: Number(record.visibleRowNo), suggestedQuantity: Number(record.suggestedQuantity), suggestedBaseQuantity: Number(record.suggestedBaseQuantity), conversionFactor: Number(record.conversionFactor) };
  });
}

export function joinPurchaseMeta({ visibleSheetName, visibleRows = [], metaRows = [] } = {}) {
  const metaByKey = new Map();
  metaRows.forEach(meta => {
    const key = `${text(meta.visibleSheetName)}\u001f${Number(meta.visibleRowNo)}`;
    if (metaByKey.has(key)) throw new Error(`ORDERQ_PURCHASE_META_JOIN_INVALID:${key}`);
    metaByKey.set(key, meta);
  });
  const joined = visibleRows.map(row => {
    const sourceRowNo = Number(row.sourceRowNo || row.sourceLineNo || 0);
    const key = `${text(visibleSheetName)}\u001f${sourceRowNo}`;
    const meta = metaByKey.get(key);
    if (!meta) throw new Error(`ORDERQ_PURCHASE_META_JOIN_INVALID:${key}`);
    metaByKey.delete(key);
    const visibleCode = upper(row.itemCode || row.productCode);
    if (visibleCode && visibleCode !== upper(meta.productCode)) throw new Error(`ORDERQ_PURCHASE_META_MUTATED:${key}:PRODUCT`);
    return {
      ...row, ...meta,
      // Keep the immutable workbook link beside the mutable/current master
      // selection.  The official adapter must prove that an ORDER Q line was
      // not silently rebound to another product after export.
      metaProductId: text(meta.productId),
      metaProductCode: upper(meta.productCode),
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      unit: text(row.unit || meta.unit || meta.suggestedUnit),
      rawQuantity: row.quantity,
      rawUnit: text(row.unit || meta.suggestedUnit),
      baseQuantity: number(row.quantity, 'ORDERQ_PURCHASE_QUANTITY_REQUIRED') * number(meta.conversionFactor),
      baseUnit: text(meta.baseUnit),
      unitConversionFactor: number(meta.conversionFactor),
      unitConversionSource: text(meta.conversionSource),
      unitConversionStatus: 'CONFIRMED',
      sourceType: 'ORDER_Q',
      contractKind: 'PURCHASE_STAGE3_V1',
      metaStatus: 'VERIFIED'
    };
  });
  if (metaByKey.size) throw new Error(`ORDERQ_PURCHASE_META_JOIN_INVALID:ORPHAN:${metaByKey.size}`);
  return joined;
}

export function stableDirectRunIdentity(kind, digestOrSession) {
  const type = upper(kind);
  if (!['SMARTINPUT_FILE', 'SMARTINPUT_CLIPBOARD', 'SMARTINPUT_MANUAL'].includes(type)) throw new Error('ORDERQ_PURCHASE_ORIGIN_SYSTEM_INVALID');
  return `RUN:${type}:${text(digestOrSession)}`;
}

export function stableDirectDocumentKey({ originSystem, originTransactionId, externalDocumentNo = '', sourceVoucherIndex = 1 } = {}) {
  const system = upper(originSystem);
  if (!['SMARTINPUT_FILE', 'SMARTINPUT_CLIPBOARD', 'SMARTINPUT_MANUAL'].includes(system)) throw new Error('ORDERQ_PURCHASE_ORIGIN_SYSTEM_INVALID');
  if (!text(originTransactionId)) throw new Error('ORDERQ_PURCHASE_ORIGIN_TRANSACTION_REQUIRED');
  return `PURCHASE:${hashApi.canonicalSha256({
    contractKind: 'PURCHASE_STAGE3_V1', originSystem: system, originTransactionId: text(originTransactionId),
    externalDocumentNo: text(externalDocumentNo), sourceVoucherIndex: Number(sourceVoucherIndex || 1)
  })}`;
}

export function detachOrderQPurchaseLink(row = {}, { originSystem = 'SMARTINPUT_FILE', originTransactionId } = {}) {
  const system = upper(originSystem);
  const transactionId = text(originTransactionId || row.directOriginTransactionId);
  if (upper(row.sourceType) !== 'ORDER_Q') throw new Error('ORDERQ_PURCHASE_LINK_NOT_ATTACHED');
  if (!['SMARTINPUT_FILE', 'SMARTINPUT_CLIPBOARD', 'SMARTINPUT_MANUAL'].includes(system) || !transactionId) {
    throw new Error('ORDERQ_PURCHASE_DIRECT_IDENTITY_REQUIRED');
  }
  return {
    ...row,
    sourceType: 'DIRECT', contractKind: 'PURCHASE_STAGE3_V1', originSystem: system,
    originTransactionId: transactionId, sourceFingerprint: transactionId,
    sourceDocumentKey: '', sourceLineKey: '', purchasePlanId: '', planId: '',
    sourceRowKey: '', documentSuffix: '', documentOrdinal: null,
    metaProductId: '', metaProductCode: '', metaStatus: 'DIRECT_DETACHED',
    directOriginSystem: system, directOriginTransactionId: transactionId
  };
}
