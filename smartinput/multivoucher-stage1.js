// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.
import * as canonicalHashCompatDependency0 from "./canonical-hash-compat.js?v=0.1.0";

// ============================================================================
// order-document-number.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const orderDocumentNumberSection = (() => {


const ORDER_DOCUMENT_NUMBER_HEADER = '\uC77C\uC790-No.';

const text = value => String(value ?? '');

function dateResult(value) {
  const match = /^(\d{4})([./-])(\d{2})\2(\d{2})$/.exec(value);
  if (!match) return { valid: false, code: 'ORDER_DOCUMENT_NO_DATE_FORMAT_INVALID' };
  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) {
    return { valid: false, code: 'ORDER_DOCUMENT_NO_DATE_INVALID' };
  }
  return {
    valid: true,
    date: `${match[1]}-${match[3]}-${match[4]}`
  };
}

function parseOrderDocumentNumber(value) {
  const originalValue = text(value);
  const boundary = originalValue.lastIndexOf('-');
  if (boundary < 0) {
    return {
      valid: false,
      originalValue,
      code: 'ORDER_DOCUMENT_NO_FORMAT_INVALID',
      message: '\uC77C\uC790-No.\uB294 YYYY/MM/DD-N, YYYY.MM.DD-N, YYYY-MM-DD-N \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.'
    };
  }
  const datePart = originalValue.slice(0, boundary);
  const numberPart = originalValue.slice(boundary + 1);
  if (!numberPart) {
    return {
      valid: false,
      originalValue,
      code: 'ORDER_DOCUMENT_NO_NUMBER_REQUIRED',
      message: '\uC77C\uC790-No. \uB05D\uC758 \uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694.'
    };
  }
  if (!/^\d+$/.test(numberPart)) {
    return {
      valid: false,
      originalValue,
      code: 'ORDER_DOCUMENT_NO_NUMBER_INVALID',
      message: '\uC77C\uC790-No. \uB05D\uC758 \uBC88\uD638\uB294 \uC22B\uC790\uB85C\uB9CC \uC785\uB825\uD558\uC138\uC694.'
    };
  }
  const parsedDate = dateResult(datePart);
  if (!parsedDate.valid) {
    return {
      valid: false,
      originalValue,
      code: parsedDate.code,
      message: parsedDate.code === 'ORDER_DOCUMENT_NO_DATE_INVALID'
        ? '\uC77C\uC790-No.\uC758 \uB0A0\uC9DC\uAC00 \uC2E4\uC81C \uB2EC\uB825\uC5D0 \uC5C6\uB294 \uB0A0\uC9DC\uC785\uB2C8\uB2E4.'
        : '\uC77C\uC790-No.\uB294 YYYY/MM/DD-N, YYYY.MM.DD-N, YYYY-MM-DD-N \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.'
    };
  }
  return {
    valid: true,
    originalValue,
    date: parsedDate.date
  };
}

function projectionField(target) {
  return text(target?.projectionFieldId || target?.id);
}

function activeMapping(session, targetDefinitions, projectionFieldId) {
  const targets = new Map((targetDefinitions || []).map(target => [target.id, target]));
  return (session?.mappings || []).find(mapping => {
    if (!['MAPPED', 'RECOMMENDED'].includes(mapping?.state)) return false;
    const target = targets.get(mapping.targetFieldId);
    return projectionField(target) === projectionFieldId;
  });
}

function normalizeSeparateDate(value) {
  const originalValue = text(value);
  if (!originalValue) return { valid: true, empty: true, date: '' };
  const parsed = dateResult(originalValue);
  if (!parsed.valid) return { valid: false, originalValue, code: parsed.code };
  return { valid: true, empty: false, originalValue, date: parsed.date };
}

function derivedFieldValue(fieldId, date, sourceFieldValue) {
  const sourceEvidence = sourceFieldValue?.evidence;
  return {
    fieldId,
    sourceDisplayValue: text(sourceFieldValue?.sourceDisplayValue),
    currentDisplayValue: date,
    parsedValue: date,
    edited: false,
    evidence: {
      ...(sourceEvidence || {}),
      derivation: 'ORDER_DOCUMENT_NUMBER_DATE',
      sourceHeader: ORDER_DOCUMENT_NUMBER_HEADER,
      sourceFieldId: text(sourceFieldValue?.fieldId)
    }
  };
}

function separateDateError(label, parsed, derivedDate) {
  if (!parsed.valid) return `${label}\uC758 \uB0A0\uC9DC \uD615\uC2DD\uC744 \uD655\uC778\uD558\uC138\uC694.`;
  if (!parsed.empty && parsed.date !== derivedDate) {
    return `\uBCC4\uB3C4 ${label} ${parsed.originalValue}\uC774(\uAC00) \uC77C\uC790-No.\uC5D0\uC11C \uD30C\uC0DD\uD55C ${derivedDate}\uC640 \uB2E4\uB985\uB2C8\uB2E4.`;
  }
  return '';
}

function applyOrderDocumentNumberDerivation({
  rows = [],
  session,
  targetDefinitions = []
} = {}) {
  if (text(session?.voucherMode).toLowerCase() !== 'order') return rows;
  const documentMapping = activeMapping(session, targetDefinitions, 'rowVoucherNo');
  if (!documentMapping || documentMapping.sourceHeader !== ORDER_DOCUMENT_NUMBER_HEADER) return rows;

  const dateTargets = ['rowVoucherDate', 'rowDeliveryDate'].map(projectionFieldId => ({
    projectionFieldId,
    target: (targetDefinitions || []).find(target => projectionField(target) === projectionFieldId),
    mapping: activeMapping(session, targetDefinitions, projectionFieldId)
  }));

  return (rows || []).map(row => {
    const sourceFieldValue = row?.fieldValues?.[documentMapping.targetFieldId];
    const parsed = parseOrderDocumentNumber(sourceFieldValue?.currentDisplayValue ?? row?.rowVoucherNo);
    const next = {
      ...row,
      rowVoucherNo: parsed.originalValue,
      fieldValues: { ...(row?.fieldValues || {}) }
    };
    delete next.orderDocumentNoError;
    delete next.orderDocumentNoErrorCode;

    if (!parsed.valid) {
      next.orderDocumentNoError = parsed.message;
      next.orderDocumentNoErrorCode = parsed.code;
      return next;
    }

    for (const { projectionFieldId, target, mapping } of dateTargets) {
      const label = projectionFieldId === 'rowVoucherDate' ? '\uC8FC\uBB38\uC77C\uC790' : '\uB0A9\uAE30\uC77C\uC790';
      const separateValue = mapping
        ? (next.fieldValues?.[mapping.targetFieldId]?.currentDisplayValue ?? next[projectionFieldId])
        : next[projectionFieldId];
      const separateDate = normalizeSeparateDate(separateValue);
      const error = separateDateError(label, separateDate, parsed.date);
      if (error) {
        next.orderDocumentNoError = error;
        next.orderDocumentNoErrorCode = separateDate.valid
          ? 'ORDER_DOCUMENT_NO_DATE_CONFLICT'
          : 'ORDER_DOCUMENT_NO_SEPARATE_DATE_INVALID';
        return next;
      }
      next[projectionFieldId] = parsed.date;
      if (!mapping && target?.id) {
        next.fieldValues[target.id] = derivedFieldValue(target.id, parsed.date, sourceFieldValue);
      } else if (mapping?.targetFieldId) {
        const fieldValue = next.fieldValues[mapping.targetFieldId];
        next.fieldValues[mapping.targetFieldId] = {
          ...fieldValue,
          parsedValue: parsed.date
        };
      }
    }
    return next;
  });
}

return { ORDER_DOCUMENT_NUMBER_HEADER, parseOrderDocumentNumber, applyOrderDocumentNumberDerivation };
})();

// ============================================================================
// purchase-stage3.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const purchaseStage3Section = (() => {


const PURCHASE_META_SCHEMA = 'ORDERQ_PURCHASE_META_V2';
const PURCHASE_META_SHEET = '_NEXUS_META';
const PURCHASE_UNIT_RULE = 'PURCHASE_UNIT_RULE_V1';
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

function purchaseMetaDigestPairs(meta = {}) {
  return [
    ['schemaVersion', text(meta.schemaVersion)], ['ruleVersion', text(meta.ruleVersion)],
    ['originSystem', upper(meta.originSystem)], ['originTransactionId', text(meta.originTransactionId)],
    ['planId', text(meta.planId)], ['sourceShortageKey', text(meta.sourceShortageKey)], ['sourceFingerprint', text(meta.sourceFingerprint)],
    ['basisDate', text(meta.basisDate)], ['sourceRowKey', text(meta.sourceRowKey)],
    ['sourceVoucherIndex', integer(meta.sourceVoucherIndex)], ['documentSuffix', text(meta.documentSuffix)],
    ['documentOrdinal', integer(meta.documentOrdinal)], ['purchasePlanId', text(meta.purchasePlanId)],
    ['sourceDocumentKey', text(meta.sourceDocumentKey)], ['sourceLineKey', text(meta.sourceLineKey)],
    ['visibleSheetName', text(meta.visibleSheetName)], ['visibleRowNo', integer(meta.visibleRowNo)],
    ['supplierCustomerId', text(meta.supplierCustomerId)], ['supplierCustomerCode', upper(meta.supplierCustomerCode)],
    ['productId', text(meta.productId)], ['productCode', upper(meta.productCode)],
    ['warehouseId', text(meta.warehouseId)], ['warehouseCode', upper(meta.warehouseCode)],
    ['productMasterRevision', number(meta.productMasterRevision)], ['warehouseMasterRevision', number(meta.warehouseMasterRevision)],
    ['suggestedQuantity', number(meta.suggestedQuantity)], ['suggestedUnit', upper(meta.suggestedUnit)],
    ['suggestedBaseQuantity', number(meta.suggestedBaseQuantity)], ['suggestedBaseUnit', upper(meta.suggestedBaseUnit)],
    ['unit', upper(meta.unit)], ['baseUnit', upper(meta.baseUnit)],
    ['conversionFactor', number(meta.conversionFactor)], ['conversionSource', upper(meta.conversionSource)],
    ['conversionRuleVersion', text(meta.conversionRuleVersion)],
  ];
}

function purchaseMetaRowDigest(meta) {
  if (!hashApi?.canonicalSha256) throw new Error('ORDERQ_CANONICAL_HASH_NOT_LOADED');
  return hashApi.canonicalSha256(purchaseMetaDigestPairs(meta));
}

function isPurchaseMetaSheet(sheetName, matrix = []) {
  if (text(sheetName) === PURCHASE_META_SHEET) return true;
  const headers = new Set((matrix[0] || []).map(text));
  const schemaIndex = (matrix[0] || []).findIndex(value => text(value) === 'schemaVersion');
  return headers.has('rowDigest') && schemaIndex >= 0
    && matrix.slice(1, 6).some(row => text(row?.[schemaIndex]) === PURCHASE_META_SCHEMA);
}

function readPurchaseMeta(matrix = []) {
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
    return { ...record, sourceVoucherIndex: Number(record.sourceVoucherIndex), documentOrdinal: Number(record.documentOrdinal), visibleRowNo: Number(record.visibleRowNo), productMasterRevision: Number(record.productMasterRevision), warehouseMasterRevision: Number(record.warehouseMasterRevision), suggestedQuantity: Number(record.suggestedQuantity), suggestedBaseQuantity: Number(record.suggestedBaseQuantity), conversionFactor: Number(record.conversionFactor) };
  });
}

function joinPurchaseMeta({ visibleSheetName, visibleRows = [], metaRows = [] } = {}) {
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
    const visibleUnit = upper(row.unit);
    if (visibleUnit && visibleUnit !== upper(meta.unit)) throw new Error(`ORDERQ_PURCHASE_META_MUTATED:${key}:UNIT`);
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

function stableDirectRunIdentity(kind, digestOrSession) {
  const type = upper(kind);
  if (!['SMARTINPUT_FILE', 'SMARTINPUT_CLIPBOARD', 'SMARTINPUT_MANUAL'].includes(type)) throw new Error('ORDERQ_PURCHASE_ORIGIN_SYSTEM_INVALID');
  return `RUN:${type}:${text(digestOrSession)}`;
}

function stableDirectDocumentKey({ originSystem, originTransactionId, externalDocumentNo = '', sourceVoucherIndex = 1 } = {}) {
  const system = upper(originSystem);
  if (!['SMARTINPUT_FILE', 'SMARTINPUT_CLIPBOARD', 'SMARTINPUT_MANUAL'].includes(system)) throw new Error('ORDERQ_PURCHASE_ORIGIN_SYSTEM_INVALID');
  if (!text(originTransactionId)) throw new Error('ORDERQ_PURCHASE_ORIGIN_TRANSACTION_REQUIRED');
  return `PURCHASE:${hashApi.canonicalSha256({
    contractKind: 'PURCHASE_STAGE3_V1', originSystem: system, originTransactionId: text(originTransactionId),
    externalDocumentNo: text(externalDocumentNo), sourceVoucherIndex: Number(sourceVoucherIndex || 1)
  })}`;
}

function detachOrderQPurchaseLink(row = {}, { originSystem = 'SMARTINPUT_FILE', originTransactionId } = {}) {
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
    sourceShortageKey: '', sourceRowKey: '', documentSuffix: '', documentOrdinal: null,
    metaProductId: '', metaProductCode: '', metaStatus: 'DIRECT_DETACHED',
    directOriginSystem: system, directOriginTransactionId: transactionId
  };
}

return { PURCHASE_META_SCHEMA, PURCHASE_META_SHEET, PURCHASE_UNIT_RULE, purchaseMetaDigestPairs, purchaseMetaRowDigest, isPurchaseMetaSheet, readPurchaseMeta, joinPurchaseMeta, stableDirectRunIdentity, stableDirectDocumentKey, detachOrderQPurchaseLink };
})();

// ============================================================================
// sale-stage4.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const saleStage4Section = (() => {


const SALES_META_SCHEMA = 'ORDERQ_SALES_META_V1';
const SALES_META_SHEET = '_NEXUS_SALES_META';
const SALES_QUANTITY_RULE = 'SALE_QUANTITY_RULE_V1';
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

function isSalesMetaSheet(sheetName, matrix = []) {
  if (text(sheetName) === SALES_META_SHEET) return true;
  const headers = (matrix[0] || []).map(text); const schema = headers.indexOf('schemaVersion');
  return schema >= 0 && headers.includes('rowDigest') && matrix.slice(1, 6).some(row => text(row?.[schema]) === SALES_META_SCHEMA);
}

function salesMetaDigestPairs(meta = {}) {
  return digestHeaders.map(key => [key, numericHeaders.has(key) && meta[key] !== '' ? finite(meta[key]) : text(meta[key])]);
}

function salesMetaRowDigest(meta = {}) { return hashApi.canonicalSha256(salesMetaDigestPairs(meta)); }

function readSalesMeta(matrix = []) {
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

function recomputeSaleLine(row = {}, meta = {}) {
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

function joinSalesMeta({ visibleSheetName, visibleRows = [], metaRows = [] } = {}) {
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

function detachOrderQSaleLink(row = {}, { originSystem = 'SMARTINPUT_FILE', originTransactionId } = {}) {
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

return { SALES_META_SCHEMA, SALES_META_SHEET, SALES_QUANTITY_RULE, isSalesMetaSheet, salesMetaDigestPairs, salesMetaRowDigest, readSalesMeta, recomputeSaleLine, joinSalesMeta, detachOrderQSaleLink };
})();

// ============================================================================
// related-voucher-import.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const relatedVoucherImportSection = (() => {


const text = value => String(value ?? '');
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(text(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const TARGET_FIELDS = Object.freeze({
  estimate: Object.freeze({ quantity: 'voucher.estimate.line.quantity', unitPrice: 'voucher.estimate.line.unitPrice' }),
  order: Object.freeze({ quantity: 'voucher.order.line.quantity', unitPrice: 'voucher.order.line.unitPrice' }),
  purchase: Object.freeze({ quantity: 'voucher.purchase.line.quantity', unitPrice: 'voucher.purchase.line.unitPrice' }),
  sale: Object.freeze({ quantity: 'voucher.sale.line.quantity', unitPrice: 'voucher.sale.line.unitPrice' })
});

const RELATED_VOUCHER_IMPORT_SCHEMA = 'ONEAPP_RELATED_VOUCHER_IMPORT_PLAN_V1';

function trackedValue(fieldId, displayValue, parsedValue, evidence) {
  return {
    fieldId,
    sourceDisplayValue: text(displayValue),
    currentDisplayValue: text(displayValue),
    parsedValue,
    edited: false,
    evidence: { ...evidence }
  };
}
function identity(value = {}) {
  return text(value.id || value.code || value.name);
}

function createRelatedVoucherImportPlan({
  companyId,
  targetVoucherMode,
  sourceVoucherMode,
  sourceVoucher,
  selectedLineIds = []
} = {}) {
  const targetFields = TARGET_FIELDS[targetVoucherMode];
  if (!text(companyId)) throw new Error('RELATED_IMPORT_COMPANY_REQUIRED');
  if (!targetFields) throw new Error('RELATED_IMPORT_TARGET_MODE_INVALID');
  if (!TARGET_FIELDS[sourceVoucherMode]) throw new Error('RELATED_IMPORT_SOURCE_MODE_INVALID');
  if (!sourceVoucher?.id) throw new Error('RELATED_IMPORT_SOURCE_REQUIRED');
  if (sourceVoucher.companyId && sourceVoucher.companyId !== companyId) throw new Error('RELATED_IMPORT_COMPANY_MISMATCH');
  const selected = new Set((selectedLineIds || []).map(text).filter(Boolean));
  const sourceLines = Array.isArray(sourceVoucher.items) ? sourceVoucher.items : [];
  const lines = selected.size ? sourceLines.filter(line => selected.has(text(line.lineId || line.id))) : sourceLines;
  if (!lines.length) throw new Error('RELATED_IMPORT_LINES_REQUIRED');
  const sourceKey = `RELATED:${sourceVoucherMode}:${sourceVoucher.id}`;
  const evidenceBase = {
    kind: 'RELATED_VOUCHER',
    companyId,
    sourceVoucherMode,
    sourceVoucherId: sourceVoucher.id,
    sourceVoucherNo: sourceVoucher.voucherNo || ''
  };
  const rows = lines.map((line, index) => {
    const quantityDisplay = text(line.quantityDisplay ?? line.quantity);
    const unitPriceDisplay = text(line.unitPriceDisplay ?? line.unitPrice);
    const quantity = numberOrNull(line.quantity);
    const unitPrice = numberOrNull(line.unitPrice);
    const lineId = text(line.lineId || line.id || index + 1);
    return {
      rowId: `SIROW-RELATED-${sourceVoucherMode}-${sourceVoucher.id}-${lineId}`,
      sourceType: 'RELATED_VOUCHER',
      inputOwnership: 'SOURCE',
      sourceBatchId: sourceKey,
      sourceDocumentKey: sourceKey,
      sourceRowKey: lineId,
      sourceRowNo: index + 1,
      originSystem: 'ONEAPP_OFFICIAL_VOUCHER',
      originTransactionId: sourceVoucher.id,
      relatedSource: { ...evidenceBase, sourceLineId: lineId },
      productId: text(line.productId),
      masterProductId: text(line.masterProductId || line.productId),
      itemCode: text(line.code || line.itemCode),
      itemName: text(line.name || line.itemName),
      specification: text(line.specification),
      quantity,
      rawQuantity: quantity,
      unit: text(line.unit),
      rawUnit: text(line.unit),
      unitPrice,
      sourceUnitPrice: unitPriceDisplay,
      rowCustomerId: text(sourceVoucher.customerId),
      rowCustomerCode: text(sourceVoucher.customerCode),
      rowCustomerName: text(sourceVoucher.customerName),
      rowVoucherDate: text(sourceVoucher.date),
      rowWarehouseId: text(sourceVoucher.warehouseId),
      rowWarehouseCode: text(sourceVoucher.warehouseCode),
      rowVoucherNo: text(sourceVoucher.voucherNo),
      memo: text(line.memo),
      matchStatus: line.productId ? 'MATCHED' : 'UNRESOLVED',
      fieldValues: {
        [targetFields.quantity]: trackedValue(targetFields.quantity, quantityDisplay, quantity, { ...evidenceBase, sourceLineId: lineId, sourceField: 'quantity' }),
        [targetFields.unitPrice]: trackedValue(targetFields.unitPrice, unitPriceDisplay, unitPrice, { ...evidenceBase, sourceLineId: lineId, sourceField: 'unitPrice' })
      }
    };
  });
  return {
    schemaVersion: RELATED_VOUCHER_IMPORT_SCHEMA,
    planId: `SIRVI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    companyId,
    targetVoucherMode,
    sourceVoucherMode,
    sourceVoucherId: sourceVoucher.id,
    sourceVoucherNo: text(sourceVoucher.voucherNo),
    sourceSnapshot: JSON.parse(JSON.stringify(sourceVoucher)),
    headerSuggestion: {
      customerId: text(sourceVoucher.customerId),
      customerCode: text(sourceVoucher.customerCode),
      customerName: text(sourceVoucher.customerName),
      warehouseId: text(sourceVoucher.warehouseId),
      warehouseCode: text(sourceVoucher.warehouseCode),
      warehouseName: text(sourceVoucher.warehouseName)
    },
    rows,
    createdAt: new Date().toISOString()
  };
}

function relatedImportConflicts(plan, targetHeader = {}) {
  const suggestion = plan?.headerSuggestion || {};
  const conflicts = [];
  const compare = (kind, current, incoming) => {
    if (identity(current) && identity(incoming) && identity(current) !== identity(incoming)) {
      conflicts.push({ kind, current: { ...current }, incoming: { ...incoming } });
    }
  };
  compare('CUSTOMER',
    { id: targetHeader.customerId, code: targetHeader.customerCode, name: targetHeader.customerName },
    { id: suggestion.customerId, code: suggestion.customerCode, name: suggestion.customerName });
  compare('WAREHOUSE',
    { id: targetHeader.warehouseId, code: targetHeader.warehouseCode, name: targetHeader.warehouseName },
    { id: suggestion.warehouseId, code: suggestion.warehouseCode, name: suggestion.warehouseName });
  return conflicts;
}

function applyRelatedVoucherImportPlan(plan, targetDraft = {}, { acceptConflicts = false } = {}) {
  if (plan?.schemaVersion !== RELATED_VOUCHER_IMPORT_SCHEMA) throw new Error('RELATED_IMPORT_PLAN_INVALID');
  const conflicts = relatedImportConflicts(plan, targetDraft.header || {});
  if (conflicts.length && !acceptConflicts) {
    const error = new Error('RELATED_IMPORT_CONFIRMATION_REQUIRED');
    error.conflicts = conflicts;
    throw error;
  }
  const header = { ...(targetDraft.header || {}) };
  const suggestion = plan.headerSuggestion || {};
  ['customerId', 'customerCode', 'customerName', 'warehouseId', 'warehouseCode', 'warehouseName']
    .forEach(field => { if (!header[field]) header[field] = suggestion[field] || ''; });
  const existingRowIds = new Set((targetDraft.rows || []).map(row => row.rowId));
  const imported = plan.rows.filter(row => !existingRowIds.has(row.rowId));
  return {
    ...targetDraft,
    header,
    rows: [...(targetDraft.rows || []), ...imported],
    relatedImportHistory: [...(targetDraft.relatedImportHistory || []), {
      planId: plan.planId,
      sourceVoucherMode: plan.sourceVoucherMode,
      sourceVoucherId: plan.sourceVoucherId,
      rowCount: imported.length,
      conflictsAccepted: conflicts.map(item => item.kind),
      appliedAt: new Date().toISOString()
    }]
  };
}

return { RELATED_VOUCHER_IMPORT_SCHEMA, createRelatedVoucherImportPlan, relatedImportConflicts, applyRelatedVoucherImportPlan };
})();

// ============================================================================
// multivoucher-stage1.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const multivoucherStage1Section = (() => {


const MODE_CONFIG = Object.freeze({
  order: Object.freeze({
    customerLabel: '거래처명',
    customerAliases: ['거래처', '거래처명', '배송처', '고객명'],
    customerCodeLabel: '거래처코드',
    customerCodeAliases: ['거래처코드', '고객코드'],
    voucherDateLabel: '주문일자',
    voucherDateAliases: ['주문일자', '전표일자', '일자'],
    deliveryDateLabel: '배송일자',
    deliveryDateAliases: ['배송일자', '납품일자'],
    warehouseLabel: '출하창고코드',
    warehouseAliases: ['창고', '창고코드', '출하창고', '출하창고코드'],
    voucherNoLabel: '주문번호',
    voucherNoAliases: ['전표번호', '주문번호', '외부전표번호', '일자-No.'],
    transactionTypeLabel: '거래유형',
    transactionTypeAliases: ['거래유형', '거래구분'],
    quantityLabel: '주문수량',
    quantityAliases: ['주문수량', '수량'],
    unitPriceLabel: '주문단가',
    unitPriceAliases: ['주문단가', '단가']
  }),
  estimate: Object.freeze({
    customerLabel: '거래처명',
    customerAliases: ['거래처', '거래처명', '고객명'],
    customerCodeLabel: '거래처코드',
    customerCodeAliases: ['거래처코드', '고객코드'],
    voucherDateLabel: '견적일자',
    voucherDateAliases: ['견적일자', '전표일자', '일자'],
    deliveryDateLabel: '유효기간',
    deliveryDateAliases: ['유효기간'],
    warehouseLabel: '창고코드',
    warehouseAliases: ['창고', '창고코드'],
    voucherNoLabel: '견적번호',
    voucherNoAliases: ['전표번호', '견적번호', '외부전표번호'],
    quantityLabel: '견적수량',
    quantityAliases: ['견적수량', '수량'],
    unitPriceLabel: '견적단가',
    unitPriceAliases: ['견적단가', '단가']
  }),
  purchase: Object.freeze({
    customerLabel: '구매처명',
    customerAliases: ['구매처', '구매처명', '거래처', '거래처명'],
    customerCodeLabel: '구매처코드',
    customerCodeAliases: ['구매처코드', '거래처코드'],
    voucherDateLabel: '구매일자',
    voucherDateAliases: ['구매일자', '전표일자', '일자'],
    deliveryDateLabel: '입고일자',
    deliveryDateAliases: ['입고일자', '실입고일자'],
    warehouseLabel: '입고창고코드',
    warehouseAliases: ['창고', '창고코드', '입고창고', '입고창고코드'],
    voucherNoLabel: '구매전표번호',
    voucherNoAliases: ['전표번호', '구매전표번호', '외부전표번호'],
    quantityLabel: '구매수량',
    quantityAliases: ['구매수량', '수량'],
    unitPriceLabel: '구매단가',
    unitPriceAliases: ['구매단가', '입고가', '구매가', '단가']
  }),
  sale: Object.freeze({
    customerLabel: '판매처명',
    customerAliases: ['판매처', '판매처명', '거래처', '거래처명', '고객명'],
    customerCodeLabel: '판매처코드',
    customerCodeAliases: ['판매처코드', '거래처코드', '고객코드'],
    voucherDateLabel: '판매일자',
    voucherDateAliases: ['판매일자', '전표일자', '일자'],
    deliveryDateLabel: '출고일자',
    deliveryDateAliases: ['출고일자', '실출고일자'],
    warehouseLabel: '출하창고코드',
    warehouseAliases: ['창고', '창고코드', '출하창고', '출하창고코드'],
    voucherNoLabel: '판매전표번호',
    voucherNoAliases: ['전표번호', '판매전표번호', '외부전표번호'],
    quantityLabel: '판매수량',
    quantityAliases: ['판매수량', '수량'],
    unitPriceLabel: '판매단가',
    unitPriceAliases: ['판매단가', '판매가', '단가']
  })
});

const text = value => String(value ?? '').normalize('NFKC').trim();
const keyText = value => text(value).toLowerCase().replace(/\s+/g, '');
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,\s원₩]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

function field(id, label, aliases = [], valueType = 'TEXT') {
  return Object.freeze({
    id,
    label,
    group: 'ADDITIONAL',
    required: false,
    valueType,
    editable: true,
    masterAliases: Object.freeze([]),
    inputAliases: Object.freeze(aliases)
  });
}

function roleFieldDefinitions(mode) {
  const delivery = [
    field('deliveryCustomerId', '배송처ID', ['배송처아이디', '납품처ID', '납품처아이디']),
    field('deliveryCustomerCode', '배송처코드', ['납품처코드']),
    field('deliveryCustomerName', '배송처명', ['납품처명'])
  ];
  const billing = [
    field('billingCustomerId', '세무거래처ID', ['세무거래처아이디', '청구처ID', '채권거래처ID']),
    field('billingCustomerCode', '세무거래처코드', ['청구처코드', '채권거래처코드']),
    field('billingCustomerName', '세무거래처명', ['청구처명', '채권거래처명'])
  ];
  const supplier = [
    field('supplierCustomerId', '공급처ID', ['공급처아이디', '구매공급처ID', '구매처ID']),
    field('supplierCustomerCode', '공급처코드', ['구매공급처코드']),
    field('supplierCustomerName', '공급처명', ['구매공급처명'])
  ];
  const sales = [
    field('salesCustomerId', '판매업무처ID', ['판매업무처아이디', '영업거래처ID']),
    field('salesCustomerCode', '판매업무처코드', ['영업거래처코드']),
    field('salesCustomerName', '판매업무처명', ['영업거래처명'])
  ];
  if (mode === 'purchase') return supplier;
  if (mode === 'sale') return [...sales, ...delivery, ...billing];
  return [...delivery, ...billing];
}

function modeConfig(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG.order;
}

function stage1RowFieldDefinitions(mode = 'order') {
  const config = modeConfig(mode);
  const sourcePartitionFields = mode === 'order' ? [] : [
    field('sourceDocumentKey', '원본문서키', ['원본문서키', '문서키']),
    field('sourceVoucherIndex', '원본전표순번', ['원본전표순번', '전표순번'], 'NUMBER'),
    field('manualSplitKey', '전표분리키', ['전표분리키', '수동분리키'])
  ];
  return Object.freeze([
    field('rowCustomerCode', config.customerCodeLabel, config.customerCodeAliases),
    field('rowCustomerName', config.customerLabel, config.customerAliases),
    ...(mode === 'order' ? [
      field('assigneeName', '담당자', ['담당', '담당자명', '사원']),
      field('assigneeId', '담당자ID', ['담당자아이디', '담당코드', '사원코드'])
    ] : []),
    field('rowVoucherDate', config.voucherDateLabel, config.voucherDateAliases),
    field('rowDeliveryDate', config.deliveryDateLabel, config.deliveryDateAliases),
    field('rowWarehouseCode', config.warehouseLabel, config.warehouseAliases),
    field('rowVoucherNo', config.voucherNoLabel, config.voucherNoAliases),
    ...(mode === 'order' ? [field('rowTransactionType', config.transactionTypeLabel, config.transactionTypeAliases)] : []),
    ...roleFieldDefinitions(mode),
    ...sourcePartitionFields
  ]);
}

function structuredFieldsForMode(mode, productFieldDefinitions = []) {
  const config = modeConfig(mode);
  const overrides = [
    ...stage1RowFieldDefinitions(mode),
    field('quantity', config.quantityLabel, config.quantityAliases, 'NUMBER'),
    field('unit', '단위', ['단위', '상품구성']),
    field('unitPrice', config.unitPriceLabel, config.unitPriceAliases, 'NUMBER')
  ];
  const overriddenIds = new Set(overrides.map(item => item.id));
  const orderInternalFields = new Set(['sourceDocumentKey', 'sourceVoucherIndex', 'manualSplitKey']);
  return [
    ...overrides,
    ...productFieldDefinitions.filter(item => !overriddenIds.has(item.id)
      && !(mode === 'order' && orderInternalFields.has(item.id)))
  ];
}

function normalizeStage1Row(row = {}, context = {}) {
  const rawQuantity = Object.prototype.hasOwnProperty.call(row, 'rawQuantity')
    ? numberOrNull(row.rawQuantity)
    : numberOrNull(row.quantity);
  const quantity = numberOrNull(row.quantity ?? row.finalQuantity ?? rawQuantity);
  const rawUnit = text(row.rawUnit ?? row.unit);
  const unit = text(row.unit ?? row.finalUnit ?? rawUnit);
  const requestedBaseUnit = text(row.baseUnit);
  const factor = numberOrNull(row.unitConversionFactor);
  const sameUnit = !requestedBaseUnit || !unit || keyText(requestedBaseUnit) === keyText(unit);
  const resolvedFactor = factor ?? (sameUnit ? 1 : null);
  const baseQuantity = quantity === null || resolvedFactor === null ? null : quantity * resolvedFactor;
  return {
    ...row,
    rowCustomerCode: text(row.rowCustomerCode),
    rowCustomerId: text(row.rowCustomerId),
    rowCustomerName: text(row.rowCustomerName),
    deliveryCustomerId: text(row.deliveryCustomerId),
    deliveryCustomerCode: text(row.deliveryCustomerCode),
    deliveryCustomerName: text(row.deliveryCustomerName),
    billingCustomerId: text(row.billingCustomerId),
    billingCustomerCode: text(row.billingCustomerCode),
    billingCustomerName: text(row.billingCustomerName),
    supplierCustomerId: text(row.supplierCustomerId),
    supplierCustomerCode: text(row.supplierCustomerCode),
    supplierCustomerName: text(row.supplierCustomerName),
    salesCustomerId: text(row.salesCustomerId),
    salesCustomerCode: text(row.salesCustomerCode),
    salesCustomerName: text(row.salesCustomerName),
    rowVoucherDate: text(row.rowVoucherDate),
    rowDeliveryDate: text(row.rowDeliveryDate),
    rowWarehouseId: text(row.rowWarehouseId),
    rowWarehouseCode: text(row.rowWarehouseCode),
    rowVoucherNo: text(row.rowVoucherNo),
    rowTransactionType: text(row.rowTransactionType),
    assigneeId: text(row.assigneeId),
    assigneeName: text(row.assigneeName),
    sourceBatchId: text(row.sourceBatchId || context.sourceBatchId || row.batchId),
    sourceDocumentKey: text(row.sourceDocumentKey || context.sourceDocumentKey),
    sourceVoucherIndex: numberOrNull(row.sourceVoucherIndex ?? context.sourceVoucherIndex) ?? 1,
    sourceSheetName: text(row.sourceSheetName || context.sourceSheetName),
    manualSplitKey: text(row.manualSplitKey),
    sourceRowNo: Number(row.sourceRowNo || row.sourceLineNo || 0),
    sourceFingerprint: text(row.sourceFingerprint || context.sourceFingerprint),
    rawQuantity,
    rawUnit,
    quantity,
    unit,
    baseQuantity,
    baseUnit: requestedBaseUnit || unit,
    unitConversionFactor: resolvedFactor,
    unitConversionSource: text(row.unitConversionSource) || (resolvedFactor === 1 ? 'SAME_UNIT' : (resolvedFactor === null ? 'UNRESOLVED' : 'ROW_RULE')),
    unitConversionStatus: resolvedFactor === null ? 'REVIEW_REQUIRED' : 'CONFIRMED'
  };
}

function decorateStructuredRows(rows = [], context = {}) {
  return rows.map((row, index) => normalizeStage1Row(row, {
    ...context,
    sourceVoucherIndex: row.sourceVoucherIndex ?? context.sourceVoucherIndex ?? 1,
    sourceDocumentKey: row.sourceDocumentKey || context.sourceDocumentKey
      || `${text(context.sourceSheetName) || 'SHEET'}:${row.sourceVoucherIndex ?? context.sourceVoucherIndex ?? 1}`,
    sourceRowNo: row.sourceLineNo || index + 1
  }));
}

function rowValue(row, fieldName, fallback) {
  const value = text(row?.[fieldName]);
  return value || text(fallback);
}

function groupRoleSnapshot(mode, row, header = {}) {
  const generic = {
    id: rowValue(row, 'rowCustomerId', header.customerId),
    code: rowValue(row, 'rowCustomerCode', header.customerCode),
    name: rowValue(row, 'rowCustomerName', header.customerName)
  };
  const role = (prefix, headerPrefix = prefix) => ({
    id: rowValue(row, `${prefix}CustomerId`, header[`${headerPrefix}CustomerId`]),
    code: rowValue(row, `${prefix}CustomerCode`, header[`${headerPrefix}CustomerCode`]),
    name: rowValue(row, `${prefix}CustomerName`, header[`${headerPrefix}CustomerName`])
  });
  const withDefault = value => (value.id || value.code || value.name) ? value : generic;
  if (mode === 'purchase') {
    const supplier = withDefault(role('supplier'));
    return { supplierCustomerId: supplier.id, supplierCustomerCode: supplier.code, supplierCustomerName: supplier.name };
  }
  if (mode === 'sale') {
    const sales = withDefault(role('sales'));
    const delivery = withDefault(role('delivery'));
    const billing = withDefault(role('billing', 'tax'));
    return {
      salesCustomerId: sales.id,
      salesCustomerCode: sales.code,
      salesCustomerName: sales.name,
      deliveryCustomerId: delivery.id,
      deliveryCustomerCode: delivery.code,
      deliveryCustomerName: delivery.name,
      billingCustomerId: billing.id,
      billingCustomerCode: billing.code,
      billingCustomerName: billing.name
    };
  }
  const delivery = withDefault(role('delivery'));
  const billing = withDefault(role('billing', 'tax'));
  return {
    deliveryCustomerId: delivery.id,
    deliveryCustomerCode: delivery.code,
    deliveryCustomerName: delivery.name,
    billingCustomerId: billing.id,
    billingCustomerCode: billing.code,
    billingCustomerName: billing.name
  };
}

function roleIdentity(mode, role) {
  if (mode === 'purchase') return role.supplierCustomerId || role.supplierCustomerCode || role.supplierCustomerName;
  if (mode === 'sale') return [
    role.salesCustomerId || role.salesCustomerCode || role.salesCustomerName,
    role.deliveryCustomerId || role.deliveryCustomerCode || role.deliveryCustomerName,
    role.billingCustomerId || role.billingCustomerCode || role.billingCustomerName
  ].join('>');
  return [
    role.deliveryCustomerId || role.deliveryCustomerCode || role.deliveryCustomerName,
    role.billingCustomerId || role.billingCustomerCode || role.billingCustomerName
  ].join('>');
}

function sourcePartition(row) {
  if (text(row.manualSplitKey)) return `MANUAL:${text(row.manualSplitKey)}`;
  if (text(row.sourceDocumentKey)) return `DOCUMENT:${text(row.sourceDocumentKey)}`;
  return `INDEX:${numberOrNull(row.sourceVoucherIndex) ?? 1}`;
}

function buildVoucherGroupKey(mode, row, header = {}) {
  const role = groupRoleSnapshot(mode, row, header);
  if (mode === 'order') {
    const customerBusinessKey = role.deliveryCustomerCode
      || role.deliveryCustomerId
      || role.deliveryCustomerName;
    const parts = [
      text(row.sourceBatchId || row.batchId || header.sourceBatchId),
      rowValue(row, 'rowVoucherNo', ''),
      rowValue(row, 'rowWarehouseCode', header.warehouseCode || header.warehouseName),
      customerBusinessKey,
      rowValue(row, 'rowTransactionType', header.transactionType)
    ];
    return `ORDER|${parts.map(part => encodeURIComponent(part)).join('|')}`;
  }
  const parts = [
    text(row.sourceBatchId || row.batchId || header.sourceBatchId),
    sourcePartition(row),
    roleIdentity(mode, role),
    rowValue(row, 'rowVoucherDate', header.voucherDate || header.orderDate),
    rowValue(row, 'rowDeliveryDate', header.deliveryDate),
    rowValue(row, 'rowWarehouseCode', header.warehouseCode || header.warehouseName),
    rowValue(row, 'rowVoucherNo', '')
  ];
  return `${mode.toUpperCase()}|${parts.map(part => encodeURIComponent(part)).join('|')}`;
}

function groupVoucherRows(mode, rows = [], header = {}) {
  const groups = new Map();
  rows.forEach((input, index) => {
    const row = normalizeStage1Row(input, { sourceBatchId: input.batchId, sourceRowNo: input.sourceLineNo || index + 1 });
    const rowRole = groupRoleSnapshot(mode, row, header);
    const voucherGroupKey = buildVoucherGroupKey(mode, row, header);
    if (!groups.has(voucherGroupKey)) {
      const rowAssigneeName = rowValue(row, 'assigneeName', header.assigneeName);
      const headerAssigneeName = text(header.assigneeName);
      const rowAssigneeId = rowValue(
        row,
        'assigneeId',
        !rowAssigneeName || rowAssigneeName === headerAssigneeName ? header.assigneeId : ''
      );
      const idempotencyParts = [
        mode,
        row.sourceBatchId,
        voucherGroupKey,
        row.sourceFingerprint
      ];
      groups.set(voucherGroupKey, {
        voucherGroupKey,
        idempotencyKey: `SMART_INPUT_STAGE1:${idempotencyParts.map(part => encodeURIComponent(text(part))).join('|')}`,
        voucherType: mode,
        ...rowRole,
        voucherDate: rowValue(row, 'rowVoucherDate', header.voucherDate || header.orderDate),
        deliveryDate: rowValue(row, 'rowDeliveryDate', header.deliveryDate),
        warehouseId: rowValue(row, 'rowWarehouseId', header.warehouseId),
        warehouseCode: rowValue(row, 'rowWarehouseCode', header.warehouseCode || header.warehouseName),
        transactionType: rowValue(row, 'rowTransactionType', header.transactionType),
        assigneeId: rowAssigneeId,
        assigneeName: rowAssigneeName,
        externalVoucherNo: text(row.rowVoucherNo),
        sourceBatchId: text(row.sourceBatchId),
        sourceDocumentKey: text(row.sourceDocumentKey),
        sourceVoucherIndex: row.sourceVoucherIndex,
        sourceSheetName: text(row.sourceSheetName),
        manualSplitKey: text(row.manualSplitKey),
        validationStatus: 'READY',
        validationErrors: [],
        rows: []
      });
    }
    const group = groups.get(voucherGroupKey);
    if (row.orderDocumentNoError) {
      group.validationErrors.push(`${row.sourceRowNo || index + 1}행 ${row.orderDocumentNoError}`);
    }
    if (row.quantity === null) group.validationErrors.push(`${row.sourceRowNo || index + 1}행 수량 공란`);
    if (row.unitConversionStatus === 'REVIEW_REQUIRED') group.validationErrors.push(`${row.sourceRowNo || index + 1}행 단위 환산 확인 필요`);
    if (mode === 'order') {
      [
        ['주문일자', 'voucherDate', rowValue(row, 'rowVoucherDate', header.voucherDate || header.orderDate)],
        ['배송일자', 'deliveryDate', rowValue(row, 'rowDeliveryDate', header.deliveryDate)],
        ['출하창고 ID', 'warehouseId', rowValue(row, 'rowWarehouseId', header.warehouseId)],
        ['배송처 ID', 'deliveryCustomerId', rowRole.deliveryCustomerId],
        ['배송처코드', 'deliveryCustomerCode', rowRole.deliveryCustomerCode],
        ['배송처명', 'deliveryCustomerName', rowRole.deliveryCustomerName],
        ['세무거래처 ID', 'billingCustomerId', rowRole.billingCustomerId],
        ['세무거래처코드', 'billingCustomerCode', rowRole.billingCustomerCode],
        ['세무거래처명', 'billingCustomerName', rowRole.billingCustomerName],
        ['담당자', 'assigneeName', rowValue(row, 'assigneeName', header.assigneeName)]
      ].forEach(([label, fieldName, actual]) => {
        const expected = text(group[fieldName]);
        const candidate = text(actual);
        if (!expected && candidate) {
          group[fieldName] = candidate;
        } else if (expected && candidate && expected !== candidate) {
          group.validationErrors.push(`${row.sourceRowNo || index + 1}행 ${label} 값이 같은 주문서 안에서 다름`);
        }
      });
    }
    group.rows.push({ ...row, voucherGroupKey });
  });
  return [...groups.values()].map(group => ({
    ...group,
    validationStatus: group.validationErrors.length ? 'REVIEW_REQUIRED' : 'READY',
    rowIds: group.rows.map(row => row.rowId).filter(Boolean)
  }));
}

function orderGroupValidationErrors(group = {}) {
  const errors = [...(group.validationErrors || [])];
  if (!group.deliveryCustomerName) errors.push('등록 거래처');
  if (!group.voucherDate) errors.push('주문일자');
  if (!group.deliveryDate) errors.push('배송일자');
  if (!group.warehouseId && !group.warehouseCode) errors.push('출하창고');
  if (!group.rows?.length) errors.push('상품');
  (group.rows || []).forEach((row, rowIndex) => {
    if (!row.itemCode && !row.itemName) errors.push(`${rowIndex + 1}행 상품`);
    if (row.quantity === null) errors.push(`${rowIndex + 1}행 수량`);
    if (row.unitConversionStatus === 'REVIEW_REQUIRED') errors.push(`${rowIndex + 1}행 단위 환산`);
  });
  return [...new Set(errors)];
}

function partitionOrderGroups(groups = []) {
  const readyGroups = [];
  const reviewRequiredGroups = [];
  (groups || []).forEach(group => {
    const validationErrors = orderGroupValidationErrors(group);
    const assessed = {
      ...group,
      validationErrors,
      validationStatus: validationErrors.length ? 'REVIEW_REQUIRED' : 'READY'
    };
    (validationErrors.length ? reviewRequiredGroups : readyGroups).push(assessed);
  });
  return { readyGroups, reviewRequiredGroups };
}

const ORDER_GROUP_ROW_HEADER_FIELDS = Object.freeze([
  'rowCustomerId', 'rowCustomerCode', 'rowCustomerName',
  'rowVoucherDate', 'rowDeliveryDate', 'rowWarehouseId', 'rowWarehouseCode',
  'rowVoucherNo', 'rowTransactionType',
  'assigneeId', 'assigneeName',
  'deliveryCustomerId', 'deliveryCustomerCode', 'deliveryCustomerName',
  'billingCustomerId', 'billingCustomerCode', 'billingCustomerName'
]);

function requiresOrderGroupSavePath(groups = [], rows = []) {
  return (groups || []).length > 1
    || (rows || []).some(row => ORDER_GROUP_ROW_HEADER_FIELDS.some(fieldName => text(row?.[fieldName])));
}

async function executeOrderGroupSavePlan(groupPlan = {}, saveReadyGroup) {
  if (typeof saveReadyGroup !== 'function') throw new Error('ORDER_GROUP_SAVE_HANDLER_REQUIRED');
  const readyGroups = groupPlan?.readyGroups || [];
  const reviewRequiredGroups = groupPlan?.reviewRequiredGroups || [];
  const results = reviewRequiredGroups.map(group => ({
    ok: false,
    blocked: true,
    group,
    error: new Error(group.validationErrors?.[0] || '주문서 확인 필요')
  }));
  for (const group of readyGroups) {
    try {
      const saved = await saveReadyGroup(group);
      results.push({ ...(saved || {}), ok: true, group });
    } catch (error) {
      results.push({ ok: false, group, error });
    }
  }
  return results;
}

function stableRowSnapshot(value) {
  if (Array.isArray(value)) return `[${value.map(stableRowSnapshot).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableRowSnapshot(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? '';
}

function orderRowSaveIdentity(row = {}, header = {}) {
  if (text(row.rowId)) return `ROW:${text(row.rowId)}`;
  if (text(row.sourceLineKey)) return `SOURCE_LINE:${text(row.sourceLineKey)}`;
  const sourceBatchId = text(row.sourceBatchId || row.batchId || header.sourceBatchId);
  const sourceRowNo = Number(row.sourceRowNo || row.sourceLineNo || 0);
  if (sourceBatchId && sourceRowNo > 0) return `SOURCE_ROW:${sourceBatchId}:${sourceRowNo}`;
  return `BUSINESS_KEY:${buildVoucherGroupKey('order', row, header)}`;
}

function captureOrderRowSubmission(rows = [], header = {}) {
  return (rows || []).map(row => ({
    groupKey: buildVoucherGroupKey('order', row, header),
    identity: orderRowSaveIdentity(row, header),
    snapshot: stableRowSnapshot(row)
  }));
}

function captureOrderHeaderSubmission(header = {}) {
  const { submittedAt: _submittedAt, ...businessHeader } = header || {};
  return stableRowSnapshot(businessHeader);
}

function orderHeaderChangedSinceSubmission(header = {}, submission = '') {
  return captureOrderHeaderSubmission(header) !== submission;
}

function retainUnsavedOrderRows(rows = [], submission = [], succeededGroups = [], header = {}) {
  const succeededKeys = new Set((succeededGroups || []).map(group => group?.voucherGroupKey).filter(Boolean));
  const removals = new Map();
  (submission || []).filter(row => succeededKeys.has(row?.groupKey)).forEach(row => {
    const token = `${row.identity}\n${row.snapshot}`;
    removals.set(token, (removals.get(token) || 0) + 1);
  });
  return (rows || []).filter(row => {
    const token = `${orderRowSaveIdentity(row, header)}\n${stableRowSnapshot(row)}`;
    const count = removals.get(token) || 0;
    if (!count) return true;
    if (count === 1) removals.delete(token);
    else removals.set(token, count - 1);
    return false;
  });
}

function summarizeVoucherGroups(groups = []) {
  const customerKeys = new Set();
  let rowCount = 0;
  let reviewRequired = 0;
  let reviewRequiredVoucherCount = 0;
  groups.forEach(group => {
    customerKeys.add(group.supplierCustomerId || group.supplierCustomerCode || group.supplierCustomerName
      || group.salesCustomerId || group.salesCustomerCode || group.salesCustomerName
      || group.deliveryCustomerId || group.deliveryCustomerCode || group.deliveryCustomerName || '');
    rowCount += group.rows.length;
    const reviewRows = group.rows.filter(row => row.matchStatus !== 'MATCHED'
      || row.quantity === null || row.unitConversionStatus === 'REVIEW_REQUIRED');
    const groupReviewRequired = group.validationStatus === 'REVIEW_REQUIRED'
      || Boolean(group.validationErrors?.length);
    if (groupReviewRequired || reviewRows.length) reviewRequiredVoucherCount += 1;
    reviewRequired += groupReviewRequired ? group.rows.length : reviewRows.length;
  });
  customerKeys.delete('');
  return {
    customerCount: customerKeys.size,
    voucherCount: groups.length,
    rowCount,
    reviewRequired,
    reviewRequiredVoucherCount,
    label: `거래처 ${customerKeys.size}곳 · 생성 예정 전표 ${groups.length}건 · 상품 ${rowCount}행 · 확인 필요 전표 ${reviewRequiredVoucherCount}건 · 확인 필요 ${reviewRequired}행`
  };
}

function filterVoucherRows(rows = [], query = '') {
  const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter(row => {
    const haystack = [
      row.itemCode, row.itemName, row.specification, row.secondaryName, row.searchInfo,
      row.rowCustomerCode, row.rowCustomerName,
      row.deliveryCustomerCode, row.deliveryCustomerName,
      row.billingCustomerCode, row.billingCustomerName,
      row.supplierCustomerCode, row.supplierCustomerName,
      row.salesCustomerCode, row.salesCustomerName,
      row.rowVoucherNo, row.memo
    ].map(value => text(value).toLowerCase().replace(/\s+/g, '')).join('|');
    return terms.every(term => haystack.includes(term.replace(/\s+/g, '')));
  });
}

function minimumUploadHeaders(mode = 'order') {
  if (mode === 'purchase') return ['구매처명', '구매일자', '품목코드', '품목명', '규격', '수량', '단위', '입고가', '메모'];
  if (mode === 'sale') return ['판매처명', '판매일자', '품목코드', '품목명', '규격', '수량', '단위', '판매가', '메모'];
  return ['거래처명', '배송일자', '품목코드', '품목명', '규격', '수량', '단위', '단가', '메모'];
}

function buildMinimumUploadMatrix(mode = 'order') {
  return [minimumUploadHeaders(mode), []];
}

function buildOrderGroupPayload(group, common = {}) {
  const groupAssigneeName = text(group.assigneeName);
  const commonAssigneeName = text(common.assigneeName);
  return {
    ...common,
    customerId: group.deliveryCustomerId || common.customerId || '',
    customerName: group.deliveryCustomerName || common.customerName || '',
    externalOrderNo: group.externalVoucherNo || common.externalOrderNo || '',
    orderDate: group.voucherDate || common.orderDate,
    deliveryExpectedDate: group.deliveryDate || common.deliveryExpectedDate || '',
    warehouseId: group.warehouseId || common.warehouseId || '',
    warehouseCode: group.warehouseCode || common.warehouseCode || '',
    warehouseName: group.warehouseCode || common.warehouseName || '',
    transactionType: group.transactionType || common.transactionType || '',
    assigneeId: text(group.assigneeId)
      || (groupAssigneeName && groupAssigneeName !== commonAssigneeName ? '' : text(common.assigneeId)),
    assigneeName: groupAssigneeName || commonAssigneeName,
    sourceDocumentKey: group.idempotencyKey,
    sourceMessageKey: group.idempotencyKey,
    sourceId: group.sourceBatchId,
    items: group.rows.map((row, index) => ({
      ...row,
      lineNo: index + 1,
      rawQuantity: row.rawQuantity,
      rawUnit: row.rawUnit,
      finalQuantity: row.quantity,
      finalUnit: row.unit,
      supplyAmount: Number(row.quantity || 0) * Number(row.unitPrice || 0)
    }))
  };
}

return { modeConfig, stage1RowFieldDefinitions, structuredFieldsForMode, normalizeStage1Row, decorateStructuredRows, buildVoucherGroupKey, groupVoucherRows, orderGroupValidationErrors, partitionOrderGroups, requiresOrderGroupSavePath, executeOrderGroupSavePlan, captureOrderRowSubmission, captureOrderHeaderSubmission, orderHeaderChangedSinceSubmission, retainUnsavedOrderRows, summarizeVoucherGroups, filterVoucherRows, minimumUploadHeaders, buildMinimumUploadMatrix, buildOrderGroupPayload, MODE_CONFIG };
})();

// Public API (same functions and constants; no additional command layer).
export const ORDER_DOCUMENT_NUMBER_HEADER = orderDocumentNumberSection.ORDER_DOCUMENT_NUMBER_HEADER;
export const parseOrderDocumentNumber = orderDocumentNumberSection.parseOrderDocumentNumber;
export const applyOrderDocumentNumberDerivation = orderDocumentNumberSection.applyOrderDocumentNumberDerivation;
export const PURCHASE_META_SCHEMA = purchaseStage3Section.PURCHASE_META_SCHEMA;
export const PURCHASE_META_SHEET = purchaseStage3Section.PURCHASE_META_SHEET;
export const PURCHASE_UNIT_RULE = purchaseStage3Section.PURCHASE_UNIT_RULE;
export const purchaseMetaDigestPairs = purchaseStage3Section.purchaseMetaDigestPairs;
export const purchaseMetaRowDigest = purchaseStage3Section.purchaseMetaRowDigest;
export const isPurchaseMetaSheet = purchaseStage3Section.isPurchaseMetaSheet;
export const readPurchaseMeta = purchaseStage3Section.readPurchaseMeta;
export const joinPurchaseMeta = purchaseStage3Section.joinPurchaseMeta;
export const stableDirectRunIdentity = purchaseStage3Section.stableDirectRunIdentity;
export const stableDirectDocumentKey = purchaseStage3Section.stableDirectDocumentKey;
export const detachOrderQPurchaseLink = purchaseStage3Section.detachOrderQPurchaseLink;
export const SALES_META_SCHEMA = saleStage4Section.SALES_META_SCHEMA;
export const SALES_META_SHEET = saleStage4Section.SALES_META_SHEET;
export const SALES_QUANTITY_RULE = saleStage4Section.SALES_QUANTITY_RULE;
export const isSalesMetaSheet = saleStage4Section.isSalesMetaSheet;
export const salesMetaDigestPairs = saleStage4Section.salesMetaDigestPairs;
export const salesMetaRowDigest = saleStage4Section.salesMetaRowDigest;
export const readSalesMeta = saleStage4Section.readSalesMeta;
export const recomputeSaleLine = saleStage4Section.recomputeSaleLine;
export const joinSalesMeta = saleStage4Section.joinSalesMeta;
export const detachOrderQSaleLink = saleStage4Section.detachOrderQSaleLink;
export const RELATED_VOUCHER_IMPORT_SCHEMA = relatedVoucherImportSection.RELATED_VOUCHER_IMPORT_SCHEMA;
export const createRelatedVoucherImportPlan = relatedVoucherImportSection.createRelatedVoucherImportPlan;
export const relatedImportConflicts = relatedVoucherImportSection.relatedImportConflicts;
export const applyRelatedVoucherImportPlan = relatedVoucherImportSection.applyRelatedVoucherImportPlan;
export const modeConfig = multivoucherStage1Section.modeConfig;
export const stage1RowFieldDefinitions = multivoucherStage1Section.stage1RowFieldDefinitions;
export const structuredFieldsForMode = multivoucherStage1Section.structuredFieldsForMode;
export const normalizeStage1Row = multivoucherStage1Section.normalizeStage1Row;
export const decorateStructuredRows = multivoucherStage1Section.decorateStructuredRows;
export const buildVoucherGroupKey = multivoucherStage1Section.buildVoucherGroupKey;
export const groupVoucherRows = multivoucherStage1Section.groupVoucherRows;
export const orderGroupValidationErrors = multivoucherStage1Section.orderGroupValidationErrors;
export const partitionOrderGroups = multivoucherStage1Section.partitionOrderGroups;
export const requiresOrderGroupSavePath = multivoucherStage1Section.requiresOrderGroupSavePath;
export const executeOrderGroupSavePlan = multivoucherStage1Section.executeOrderGroupSavePlan;
export const captureOrderRowSubmission = multivoucherStage1Section.captureOrderRowSubmission;
export const captureOrderHeaderSubmission = multivoucherStage1Section.captureOrderHeaderSubmission;
export const orderHeaderChangedSinceSubmission = multivoucherStage1Section.orderHeaderChangedSinceSubmission;
export const retainUnsavedOrderRows = multivoucherStage1Section.retainUnsavedOrderRows;
export const summarizeVoucherGroups = multivoucherStage1Section.summarizeVoucherGroups;
export const filterVoucherRows = multivoucherStage1Section.filterVoucherRows;
export const minimumUploadHeaders = multivoucherStage1Section.minimumUploadHeaders;
export const buildMinimumUploadMatrix = multivoucherStage1Section.buildMinimumUploadMatrix;
export const buildOrderGroupPayload = multivoucherStage1Section.buildOrderGroupPayload;
export const MODE_CONFIG = multivoucherStage1Section.MODE_CONFIG;
