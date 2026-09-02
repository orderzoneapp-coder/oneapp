import './canonical-hash.js?v=0.2.0';
import { assertOfficialStocktakeDecisionEnvelopeV2 } from './stocktake-conflict-v2.js?v=0.1.0';

const sharedCanonicalHash = globalThis.ORDERQ_CANONICAL_HASH;
if (!sharedCanonicalHash) throw new Error('ORDERQ_CANONICAL_HASH_NOT_LOADED');

export const OFFICIAL_VOUCHER_SCHEMA_VERSION_V2 = 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2';
export const OFFICIAL_VOUCHER_IDENTITY_VERSION_V2 = 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2';

export const OFFICIAL_VOUCHER_V2_ENTITY = Object.freeze({
  PURCHASE_DOCUMENT: 'PURCHASE_DOCUMENT',
  SALE_DOCUMENT: 'SALE_DOCUMENT',
  PURCHASE_LINE: 'PURCHASE_LINE',
  SALE_LINE: 'SALE_LINE',
  PURCHASE_COMMAND: 'PURCHASE_COMMAND',
  SALE_COMMAND: 'SALE_COMMAND',
  PURCHASE_REVISION: 'PURCHASE_REVISION',
  SALE_REVISION: 'SALE_REVISION'
});

const canonicalSha256 = sharedCanonicalHash.canonicalSha256;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// Identity, matching, and contract metadata use compatibility normalization.
// Confirmed display/source Snapshot values must retain their original glyphs.
const text = value => String(value ?? '').normalize('NFKC').trim();
const snapshotText = value => String(value ?? '').trim();
const productCodeKey = value => snapshotText(value);
const customerCodeKey = value => snapshotText(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');

export class OfficialVoucherV2PreflightError extends Error {
  constructor(issues = []) {
    const first = issues[0] || { code: 'ORDERQ_OFFICIAL_V2_PREFLIGHT_INVALID', message: '전표 입력을 확인하십시오.' };
    super(`${first.code}:${first.message}`);
    this.name = 'OfficialVoucherV2PreflightError';
    this.code = 'ORDERQ_OFFICIAL_V2_PREFLIGHT_FAILED';
    this.issues = clone(issues);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function requiredText(value, code) {
  const result = text(value);
  if (!result) throw new Error(code);
  return result;
}

export function isOfficialVoucherBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function firstOwnValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return { key, value: source[key] };
  }
  return { key: '', value: undefined };
}

function firstDefinedOwnValue(source, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source || {}, key) || source[key] === undefined) continue;
    return { key, value: source[key] };
  }
  return { key: '', value: undefined };
}

function firstNonblankValue(source, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source || {}, key)) continue;
    if (!isOfficialVoucherBlank(source[key])) return { key, value: source[key] };
  }
  return { key: '', value: undefined };
}

function finiteNumber(value, code) {
  if (isOfficialVoucherBlank(value)) throw new Error(code);
  if (!['number', 'string'].includes(typeof value)) throw new Error(code);
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  if (normalized === '') throw new Error(code);
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(code);
  return Object.is(number, -0) ? 0 : number;
}

function validCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeOfficialBusinessDate(source = {}) {
  const rawEntry = firstNonblankValue(source, ['businessDate', 'voucherDate', 'purchaseDate', 'saleDate', 'orderDate']);
  const raw = text(rawEntry.value);
  let year;
  let month;
  let day;
  let dayDefaulted = false;

  if (raw) {
    const matched = raw.match(/^(\d{4})-(\d{1,2})(?:-(\d{0,2}))?$/);
    if (!matched) throw new Error('ORDERQ_OFFICIAL_V2_DATE_INVALID');
    year = Number(matched[1]);
    month = Number(matched[2]);
    dayDefaulted = matched[3] === undefined || matched[3] === '';
    day = dayDefaulted ? 1 : Number(matched[3]);
  } else {
    const parts = source.businessDateParts || source.voucherDateParts || source.dateParts || {};
    const dateParts = { ...source, ...parts };
    const yearValue = firstDefinedOwnValue(dateParts, ['year', 'voucherYear', 'businessYear']);
    const monthValue = firstDefinedOwnValue(dateParts, ['month', 'voucherMonth', 'businessMonth']);
    const dayValue = firstDefinedOwnValue(dateParts, ['day', 'voucherDay', 'businessDay']);
    if (isOfficialVoucherBlank(yearValue.value) && isOfficialVoucherBlank(monthValue.value)
      && isOfficialVoucherBlank(dayValue.value)) throw new Error('ORDERQ_OFFICIAL_V2_DATE_REQUIRED');
    if (isOfficialVoucherBlank(yearValue.value) || isOfficialVoucherBlank(monthValue.value)) {
      throw new Error('ORDERQ_OFFICIAL_V2_DATE_INVALID');
    }
    year = Number(yearValue.value);
    month = Number(monthValue.value);
    dayDefaulted = isOfficialVoucherBlank(dayValue.value);
    day = dayDefaulted ? 1 : Number(dayValue.value);
  }

  if (!validCalendarDate(year, month, day)) throw new Error('ORDERQ_OFFICIAL_V2_DATE_INVALID');
  return Object.freeze({ businessDate: formatDate(year, month, day), dayDefaulted });
}

const ACTIVE_ROW_FIELDS = Object.freeze([
  'productId', 'unresolvedProductId', 'productCode', 'itemCode', 'productName', 'itemName',
  'unregisteredProductQuery', 'specification', 'unit', 'actualUnit', 'quantity', 'actualQuantity',
  'rawQuantity', 'sourceQuantity', 'unitPrice', 'sourceUnitPrice', 'finalAmount', 'totalAmount',
  'totalAmountWon', 'amountWon', 'supplyAmount', 'supplyAmountWon',
  'memo', 'description', 'rowCustomerCode', 'rowCustomerName'
]);

export function isOfficialVoucherActiveRow(row = {}) {
  if (ACTIVE_ROW_FIELDS.some(field => !isOfficialVoucherBlank(row[field]))) return true;
  return Object.values(row.customValues || {}).some(value => !isOfficialVoucherBlank(value));
}

function rawQuantityOf(row) {
  const display = row.fieldValues?.quantity?.currentDisplayValue
    ?? row.fieldValues?.['voucher.purchase.line.quantity']?.currentDisplayValue
    ?? row.fieldValues?.['voucher.sale.line.quantity']?.currentDisplayValue;
  if (display !== undefined) return display;
  return firstOwnValue(row, ['sourceQuantity', 'actualQuantity', 'quantity', 'rawQuantity']).value;
}

function rawUnitPriceOf(row) {
  const display = row.fieldValues?.unitPrice?.currentDisplayValue
    ?? row.fieldValues?.['voucher.purchase.line.unitPrice']?.currentDisplayValue
    ?? row.fieldValues?.['voucher.sale.line.unitPrice']?.currentDisplayValue;
  if (display !== undefined) return display;
  return firstOwnValue(row, ['sourceUnitPrice', 'unitPrice']).value;
}

function matchEvidence(row = {}) {
  return {
    status: text(row.matchStatus || row.productIdentityStatus
      || (!isOfficialVoucherBlank(row.productId) ? 'MATCHED' : 'UNRESOLVED')).toUpperCase(),
    source: text(row.matchSource || row.referenceResolution),
    productId: text(row.productId),
    unresolvedProductId: text(row.unresolvedProductId),
    productMasterRevision: Number(row.productMasterRevision || 0),
    referenceSnapshotId: text(row.referenceSnapshotId || row.productSnapshotId),
    officialProductResolution: clone(row.officialProductResolution
      || row.productSnapshot?.matchEvidence?.officialProductResolution)
  };
}

function rowSnapshot(row, index, kind) {
  const productCode = snapshotText(firstNonblankValue(row, ['productCode', 'itemCode']).value);
  const productName = snapshotText(firstNonblankValue(row, ['productName', 'itemName', 'unregisteredProductQuery']).value);
  const originalCodeEntry = firstOwnValue(row, ['originalProductCode', 'sourceProductCode', 'rawProductCode']);
  const originalNameEntry = firstOwnValue(row, ['originalProductName', 'sourceProductName', 'rawProductName']);
  const originalProductCode = snapshotText(originalCodeEntry.key ? originalCodeEntry.value : productCode);
  const originalProductName = snapshotText(originalNameEntry.key ? originalNameEntry.value : productName);
  const quantitySource = rawQuantityOf(row);
  const unitPriceSource = rawUnitPriceOf(row);
  const issues = [];
  const rowNumber = Number(row.sourceRowNo || row.sourceLineNo || row.lineSequence || index + 1);
  const add = (code, field, message) => issues.push({ code, field, rowNumber, message: `${rowNumber}행: ${message}` });

  if (!productCode && !productName) add('ORDERQ_OFFICIAL_V2_PRODUCT_REQUIRED', 'product', '상품코드 또는 상품명을 입력하십시오.');
  if (isOfficialVoucherBlank(quantitySource)) add('ORDERQ_OFFICIAL_V2_QUANTITY_REQUIRED', 'quantity', '수량이 공란입니다.');
  if (isOfficialVoucherBlank(unitPriceSource)) add('ORDERQ_OFFICIAL_V2_UNIT_PRICE_REQUIRED', 'unitPrice', '단가가 공란입니다.');

  let quantity = null;
  let unitPrice = null;
  if (!isOfficialVoucherBlank(quantitySource)) {
    try { quantity = finiteNumber(quantitySource, 'ORDERQ_OFFICIAL_V2_QUANTITY_INVALID'); }
    catch { add('ORDERQ_OFFICIAL_V2_QUANTITY_INVALID', 'quantity', '수량은 유한한 숫자여야 합니다.'); }
  }
  if (!isOfficialVoucherBlank(unitPriceSource)) {
    try { unitPrice = finiteNumber(unitPriceSource, 'ORDERQ_OFFICIAL_V2_UNIT_PRICE_INVALID'); }
    catch { add('ORDERQ_OFFICIAL_V2_UNIT_PRICE_INVALID', 'unitPrice', '단가는 유한한 숫자여야 합니다.'); }
  }

  const persistedSnapshot = row.productSnapshot?.schemaVersion === OFFICIAL_VOUCHER_SCHEMA_VERSION_V2
    ? row.productSnapshot
    : null;
  const amountEntry = persistedSnapshot
    ? {
      key: text(persistedSnapshot.amountSourceField),
      value: firstNonblankValue(row, [
        'totalAmount', 'totalAmountWon', 'amountWon', 'supplyAmount', 'supplyAmountWon'
      ]).value ?? persistedSnapshot.amount
    }
    : firstNonblankValue(row, [
      'finalAmount', 'totalAmount', 'totalAmountWon', 'amountWon', 'supplyAmount', 'supplyAmountWon'
    ]);
  let amount = null;
  if (persistedSnapshot || amountEntry.key) {
    try { amount = finiteNumber(amountEntry.value, 'ORDERQ_OFFICIAL_V2_AMOUNT_INVALID'); }
    catch { add('ORDERQ_OFFICIAL_V2_AMOUNT_INVALID', 'amount', '최종금액은 유한한 숫자여야 합니다.'); }
  } else if (quantity !== null && unitPrice !== null) {
    amount = quantity * unitPrice;
  }
  const amountOrigin = persistedSnapshot
    ? text(persistedSnapshot.amountOrigin)
    : (amountEntry.key ? 'SOURCE_OR_USER' : 'DERIVED_AT_CONFIRM');
  if (persistedSnapshot && amountOrigin === 'DERIVED_AT_CONFIRM'
    && quantity !== null && unitPrice !== null && amount !== quantity * unitPrice) {
    add('ORDERQ_OFFICIAL_V2_AMOUNT_DERIVATION_MISMATCH', 'amount', '계산 금액이 수량×단가와 일치하지 않습니다.');
  }

  const snapshot = {
    schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
    entityType: kind === 'PURCHASE' ? OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_LINE : OFFICIAL_VOUCHER_V2_ENTITY.SALE_LINE,
    productCode,
    productName,
    specification: snapshotText(row.specification),
    unit: snapshotText(firstNonblankValue(row, ['unit', 'actualUnit']).value),
    quantity,
    unitPrice,
    amount,
    amountOrigin,
    amountSourceField: persistedSnapshot ? text(persistedSnapshot.amountSourceField) : amountEntry.key,
    originalProductCode,
    originalProductName,
    matchEvidence: matchEvidence(row)
  };
  return { issues, normalized: { ...clone(row), actualQuantity: quantity, quantity, unitPrice, totalAmount: amount, productSnapshot: snapshot } };
}

export function preflightOfficialVoucherV2(source = {}) {
  const kind = text(source.kind || source.voucherMode).toUpperCase();
  const issues = [];
  if (!['PURCHASE', 'SALE'].includes(kind)) {
    issues.push({ code: 'ORDERQ_OFFICIAL_V2_KIND_INVALID', field: 'voucherMode', rowNumber: 0, message: '전표종류가 구매 또는 판매가 아닙니다.' });
  }
  const companyId = text(source.companyId);
  if (!companyId) issues.push({ code: 'ORDERQ_OFFICIAL_COMPANY_REQUIRED', field: 'companyId', rowNumber: 0, message: '회사 문맥이 필요합니다.' });
  const warehouseId = text(source.warehouseId || source.warehouseCode || source.warehouseName);
  if (!warehouseId) issues.push({ code: 'ORDERQ_OFFICIAL_WAREHOUSE_REQUIRED', field: 'warehouse', rowNumber: 0, message: '창고를 입력하십시오.' });

  let date = null;
  try { date = normalizeOfficialBusinessDate(source); }
  catch (error) {
    issues.push({ code: error.message, field: 'businessDate', rowNumber: 0,
      message: error.message.endsWith('_REQUIRED') ? '전표일자를 입력하십시오.' : '전표일자가 유효하지 않습니다.' });
  }

  const allRows = Array.isArray(source.rows || source.lines) ? (source.rows || source.lines) : [];
  const rows = [];
  const ignoredRowIndexes = [];
  allRows.forEach((row, index) => {
    if (!isOfficialVoucherActiveRow(row)) {
      ignoredRowIndexes.push(index);
      return;
    }
    const checked = rowSnapshot(row, index, kind);
    issues.push(...checked.issues);
    rows.push(checked.normalized);
  });
  if (!rows.length) issues.push({ code: 'ORDERQ_OFFICIAL_LINES_REQUIRED', field: 'rows', rowNumber: 0, message: '상품을 1개 이상 입력하십시오.' });
  if (issues.length) throw new OfficialVoucherV2PreflightError(issues);

  return deepFreeze({
    schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    entityType: kind === 'PURCHASE' ? OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_DOCUMENT : OFFICIAL_VOUCHER_V2_ENTITY.SALE_DOCUMENT,
    kind,
    companyId,
    businessDate: date.businessDate,
    dayDefaulted: date.dayDefaulted,
    warehouseId,
    voucherGroupKey: text(source.voucherGroupKey),
    rows,
    ignoredRowIndexes
  });
}

export function officialVoucherStableIdV2(prefix, entityType, companyId, stableInput = {}) {
  const company = requiredText(companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const entity = requiredText(entityType, 'ORDERQ_OFFICIAL_V2_ENTITY_TYPE_REQUIRED');
  return `${prefix}-${canonicalSha256({
    schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    entityType: entity,
    companyId: company,
    stableInput: clone(stableInput)
  }).slice(0, 32)}`;
}

function kindFields(kind) {
  const normalized = text(kind).toUpperCase();
  if (normalized === 'PURCHASE') return {
    kind: normalized,
    documentId: 'purchaseDocumentId',
    lineId: 'purchaseLineId',
    documentPrefix: 'PD',
    linePrefix: 'PL',
    documentEntity: OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_DOCUMENT,
    lineEntity: OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_LINE,
    commandEntity: OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_COMMAND,
    revisionEntity: OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_REVISION
  };
  if (normalized === 'SALE') return {
    kind: normalized,
    documentId: 'salesDocumentId',
    lineId: 'salesLineId',
    documentPrefix: 'SD',
    linePrefix: 'SL',
    documentEntity: OFFICIAL_VOUCHER_V2_ENTITY.SALE_DOCUMENT,
    lineEntity: OFFICIAL_VOUCHER_V2_ENTITY.SALE_LINE,
    commandEntity: OFFICIAL_VOUCHER_V2_ENTITY.SALE_COMMAND,
    revisionEntity: OFFICIAL_VOUCHER_V2_ENTITY.SALE_REVISION
  };
  throw new Error(`ORDERQ_OFFICIAL_KIND_INVALID:${normalized}`);
}

function fieldsForStage3Command(commandType) {
  const normalized = text(commandType).toUpperCase();
  if (normalized === 'POST_PURCHASE') return kindFields('PURCHASE');
  if (normalized === 'POST_SALE') return kindFields('SALE');
  throw new Error(`ORDERQ_OFFICIAL_V2_COMMAND_FORMAT_INVALID:${normalized}`);
}

export function createOfficialDocumentIdentityV2({ kind, companyId, voucherGroupKey, stableInput = {} } = {}) {
  const fields = kindFields(kind);
  const groupKey = text(voucherGroupKey);
  if (fields.kind === 'SALE' && !groupKey) throw new Error('ORDERQ_OFFICIAL_SALE_GROUP_KEY_REQUIRED');
  const identitySeed = { ...clone(stableInput), voucherGroupKey: groupKey };
  const id = officialVoucherStableIdV2(fields.documentPrefix, fields.documentEntity, companyId, identitySeed);
  return Object.freeze({
    schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    entityType: fields.documentEntity,
    companyId: text(companyId),
    voucherGroupKey: groupKey,
    identitySeed,
    [fields.documentId]: id
  });
}

export function createOfficialLineIdentityV2({ kind, companyId, documentId, voucherGroupKey, sourceLineKey } = {}) {
  const fields = kindFields(kind);
  const sourceKey = requiredText(sourceLineKey, 'ORDERQ_OFFICIAL_V2_SOURCE_LINE_KEY_REQUIRED');
  const identitySeed = {
    documentId: requiredText(documentId, `ORDERQ_OFFICIAL_${fields.kind}_DOCUMENT_ID_REQUIRED`),
    voucherGroupKey: text(voucherGroupKey),
    sourceLineKey: sourceKey
  };
  const id = officialVoucherStableIdV2(fields.linePrefix, fields.lineEntity, companyId, identitySeed);
  return Object.freeze({
    schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    entityType: fields.lineEntity,
    companyId: text(companyId),
    voucherGroupKey: text(voucherGroupKey),
    identitySeed,
    [fields.lineId]: id
  });
}

export function canonicalOfficialCommandPayloadV2(source = {}) {
  const command = clone(source.intent || source);
  delete command.commandId;
  delete command.idempotencyKey;
  delete command.commandPayloadDigest;
  delete command.intent;
  if (Array.isArray(command.lines)) {
    const fields = fieldsForStage3Command(command.commandType);
    command.lines = command.lines.slice().sort((left, right) => text(left[fields.lineId]).localeCompare(text(right[fields.lineId])));
  }
  return command;
}

export function withOfficialCommandIdentityV2(source = {}) {
  const command = clone(source.intent || source);
  const fields = fieldsForStage3Command(command.commandType);
  command.schemaVersion = OFFICIAL_VOUCHER_SCHEMA_VERSION_V2;
  command.identityVersion = OFFICIAL_VOUCHER_IDENTITY_VERSION_V2;
  command.entityType = fields.commandEntity;
  command.companyId = requiredText(command.companyId || command.document?.companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  command.voucherGroupKey = text(command.voucherGroupKey || command.document?.voucherGroupKey);
  if (fields.kind === 'SALE' && !command.voucherGroupKey) throw new Error('ORDERQ_OFFICIAL_SALE_GROUP_KEY_REQUIRED');
  command.commandPayloadDigest = canonicalSha256(canonicalOfficialCommandPayloadV2(command));
  const documentId = requiredText(command.aggregateId || command.document?.[fields.documentId] || command[fields.documentId],
    `ORDERQ_OFFICIAL_${fields.kind}_DOCUMENT_ID_REQUIRED`);
  const commandId = officialVoucherStableIdV2('OC', fields.commandEntity, command.companyId, {
    documentId,
    voucherGroupKey: command.voucherGroupKey,
    expectedRevision: Number(command.expectedRevision),
    commandType: text(command.commandType).toUpperCase(),
    commandPayloadDigest: command.commandPayloadDigest
  });
  command.commandId = commandId;
  command.idempotencyKey = commandId;
  return command;
}

export function officialVoucherRevisionIdV2(kind, companyId, documentId, revision) {
  const fields = kindFields(kind);
  return officialVoucherStableIdV2('VR', fields.revisionEntity, companyId, {
    documentId: requiredText(documentId, `ORDERQ_OFFICIAL_${fields.kind}_DOCUMENT_ID_REQUIRED`),
    revision: Number(revision)
  });
}

export function isOfficialVoucherIdentityV2(source = {}) {
  const command = source.intent || source.commandEnvelope || source.commandSource || source;
  return text(command?.identityVersion) === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
    || text(command?.schemaVersion) === OFFICIAL_VOUCHER_SCHEMA_VERSION_V2;
}

export function assertOfficialProductResolutionV2(line = {}, companyId = '') {
  const resolution = clone(line.officialProductResolution
    || line.productSnapshot?.matchEvidence?.officialProductResolution);
  if (!resolution || typeof resolution !== 'object') throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_REQUIRED');
  if (text(resolution.companyId) !== text(companyId)) throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_COMPANY_MISMATCH');
  const status = text(resolution.status).toUpperCase();
  const inputCode = productCodeKey(resolution.inputProductCode);
  const matchedCode = productCodeKey(resolution.matchedProductCode);
  const snapshotCode = productCodeKey(line.productSnapshot?.productCode);
  const originalCode = productCodeKey(line.productSnapshot?.originalProductCode);
  if (Number(line.inventoryEffectFactor) !== 1
    || Number(line.baseQuantity) !== Number(line.actualQuantity ?? line.quantity)) {
    throw new Error('ORDERQ_OFFICIAL_V2_INVENTORY_FACTOR_INVALID');
  }
  if (status === 'MATCHED') {
    if (text(resolution.reason) !== 'EXACT_COMPANY_PRODUCT_CODE'
      || !inputCode || inputCode !== matchedCode
      || !text(resolution.matchedProductId)
      || text(line.productId) !== text(resolution.matchedProductId)
      || text(line.unresolvedProductId)
      || snapshotCode !== inputCode
      || originalCode !== inputCode
      || text(line.matchStatus || line.productIdentityStatus).toUpperCase() !== 'MATCHED'
      || text(line.matchSource) !== 'EXACT_COMPANY_PRODUCT_CODE') {
      throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_EXACT_MATCH_INVALID');
    }
  } else if (status === 'UNRESOLVED_PRODUCT') {
    const allowedReasons = new Set([
      'PRODUCT_CODE_NOT_PROVIDED',
      'PRODUCT_CODE_UNMATCHED',
      'PRODUCT_CODE_AMBIGUOUS',
      'MATCHED_PRODUCT_TECHNICAL_ID_MISSING'
    ]);
    if (!allowedReasons.has(text(resolution.reason))
      || text(line.productId)
      || !text(line.unresolvedProductId)
      || originalCode !== inputCode
      || text(line.matchStatus || line.productIdentityStatus).toUpperCase() !== 'UNRESOLVED_PRODUCT'
      || (text(resolution.reason) === 'PRODUCT_CODE_NOT_PROVIDED' && inputCode)
      || (text(resolution.reason) !== 'PRODUCT_CODE_NOT_PROVIDED' && !inputCode)) {
      throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_UNRESOLVED_INVALID');
    }
  } else {
    throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_STATUS_INVALID');
  }
  return deepFreeze(resolution);
}

export function assertOfficialPartnerResolutionV2(document = {}, companyId = '') {
  const resolution = clone(document.officialPartnerResolution);
  if (!resolution || typeof resolution !== 'object') throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_RESOLUTION_REQUIRED');
  if (text(resolution.companyId) !== text(companyId)) throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_RESOLUTION_COMPANY_MISMATCH');
  const status = text(resolution.status).toUpperCase();
  const inputCode = customerCodeKey(resolution.inputCustomerCode);
  const matchedCode = customerCodeKey(resolution.matchedCustomerCode);
  const purchaseDocument = text(document.entityType) === OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_DOCUMENT;
  const partnerRole = text(resolution.partnerRole).toUpperCase();
  const validRole = purchaseDocument ? partnerRole === 'SUPPLIER' : ['SALES', 'BILLING'].includes(partnerRole);
  if (!validRole) throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_ROLE_INVALID');
  const partnerId = text(purchaseDocument
    ? document.supplierCustomerId
    : document.billingCustomerId || document.salesCustomerId);
  const documentCode = customerCodeKey(purchaseDocument
    ? document.supplierCustomerCode
    : partnerRole === 'BILLING' ? document.billingCustomerCode : document.salesCustomerCode);
  if (documentCode !== inputCode) throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_CODE_MISMATCH');
  if (status === 'MATCHED') {
    if (text(resolution.reason) !== 'EXACT_COMPANY_CUSTOMER_CODE'
      || !inputCode || inputCode !== matchedCode || !text(resolution.matchedCustomerId)
      || partnerId !== text(resolution.matchedCustomerId)) {
      throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_EXACT_MATCH_INVALID');
    }
  } else if (status === 'CUSTOMER_NOT_PROVIDED') {
    if (text(resolution.reason) !== 'CUSTOMER_CODE_NOT_PROVIDED'
      || inputCode || text(resolution.matchedCustomerId) || partnerId) {
      throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_NOT_PROVIDED_INVALID');
    }
  } else if (status === 'UNRESOLVED_CUSTOMER') {
    if (!['CUSTOMER_CODE_UNMATCHED', 'CUSTOMER_CODE_AMBIGUOUS', 'MATCHED_CUSTOMER_ID_MISSING'].includes(text(resolution.reason))
      || !inputCode || text(resolution.matchedCustomerId) || partnerId) {
      throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_UNRESOLVED_INVALID');
    }
  } else {
    throw new Error('ORDERQ_OFFICIAL_V2_PARTNER_RESOLUTION_STATUS_INVALID');
  }
  return deepFreeze(resolution);
}

export function assertOfficialCommandV2(source = {}) {
  const command = clone(source.intent || source.commandEnvelope || source.commandSource || source);
  const fields = fieldsForStage3Command(command.commandType);
  if (text(command.schemaVersion) !== OFFICIAL_VOUCHER_SCHEMA_VERSION_V2) throw new Error('ORDERQ_OFFICIAL_V2_SCHEMA_INVALID');
  if (text(command.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2) throw new Error('ORDERQ_OFFICIAL_V2_IDENTITY_VERSION_INVALID');
  if (text(command.entityType) !== fields.commandEntity) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_ENTITY_INVALID');
  const companyId = requiredText(command.companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const expectedRevision = Number(command.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_OFFICIAL_REVISION_REQUIRED');
  if (requiredText(command.commandId, 'ORDERQ_OFFICIAL_COMMAND_ID_REQUIRED')
    !== requiredText(command.idempotencyKey, 'ORDERQ_OFFICIAL_IDEMPOTENCY_KEY_REQUIRED')) {
    throw new Error('ORDERQ_OFFICIAL_COMMAND_IDEMPOTENCY_MISMATCH');
  }

  const document = command.document;
  if (!document || typeof document !== 'object') throw new Error('ORDERQ_OFFICIAL_DOCUMENT_REQUIRED');
  if (text(document.schemaVersion) !== OFFICIAL_VOUCHER_SCHEMA_VERSION_V2
    || text(document.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
    || text(document.entityType) !== fields.documentEntity) throw new Error('ORDERQ_OFFICIAL_V2_DOCUMENT_IDENTITY_INVALID');
  if (text(document.companyId) !== companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_MISMATCH');
  assertOfficialPartnerResolutionV2(document, companyId);
  const voucherGroupKey = text(command.voucherGroupKey || document.voucherGroupKey);
  if (fields.kind === 'SALE' && !voucherGroupKey) throw new Error('ORDERQ_OFFICIAL_SALE_GROUP_KEY_REQUIRED');
  if (text(document.voucherGroupKey) !== voucherGroupKey) throw new Error('ORDERQ_OFFICIAL_V2_GROUP_MISMATCH');
  const documentId = requiredText(document[fields.documentId], `ORDERQ_OFFICIAL_${fields.kind}_DOCUMENT_ID_REQUIRED`);
  const expectedDocumentId = officialVoucherStableIdV2(fields.documentPrefix, fields.documentEntity, companyId, document.identitySeed || {});
  if (documentId !== expectedDocumentId || text(command.aggregateId || documentId) !== documentId) {
    throw new Error('ORDERQ_OFFICIAL_V2_DOCUMENT_ID_INVALID');
  }

  const lines = Array.isArray(command.lines) ? command.lines : [];
  if (!lines.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  lines.forEach(line => {
    if (text(line.schemaVersion) !== OFFICIAL_VOUCHER_SCHEMA_VERSION_V2
      || text(line.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
      || text(line.entityType) !== fields.lineEntity) throw new Error('ORDERQ_OFFICIAL_V2_LINE_IDENTITY_INVALID');
    if (text(line.companyId) !== companyId || text(line.voucherGroupKey) !== voucherGroupKey
      || text(line[fields.documentId]) !== documentId) throw new Error('ORDERQ_OFFICIAL_V2_LINE_SCOPE_MISMATCH');
    const expectedLineId = officialVoucherStableIdV2(fields.linePrefix, fields.lineEntity, companyId, line.identitySeed || {});
    if (text(line[fields.lineId]) !== expectedLineId) throw new Error('ORDERQ_OFFICIAL_V2_LINE_ID_INVALID');
    if (!line.productSnapshot || text(line.productSnapshot.schemaVersion) !== OFFICIAL_VOUCHER_SCHEMA_VERSION_V2) {
      throw new Error('ORDERQ_OFFICIAL_V2_LINE_SNAPSHOT_REQUIRED');
    }
    const resolution = assertOfficialProductResolutionV2(line, companyId);
    if (canonicalSha256(resolution) !== canonicalSha256(line.productSnapshot.matchEvidence?.officialProductResolution)) {
      throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_SNAPSHOT_MISMATCH');
    }
  });

  const preflight = preflightOfficialVoucherV2({
    kind: fields.kind,
    companyId,
    voucherGroupKey,
    businessDate: document.purchaseDate || document.saleDate || document.businessDate,
    warehouseId: document.warehouseId,
    rows: lines
  });
  lines.forEach((line, index) => {
    const expected = preflight.rows[index]?.productSnapshot;
    const actual = line.productSnapshot;
    if (!expected || canonicalSha256(expected) !== canonicalSha256(actual)) throw new Error('ORDERQ_OFFICIAL_V2_LINE_SNAPSHOT_MISMATCH');
  });

  assertOfficialStocktakeDecisionEnvelopeV2(command);

  const payloadDigest = canonicalSha256(canonicalOfficialCommandPayloadV2(command));
  if (payloadDigest !== text(command.commandPayloadDigest)) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_PAYLOAD_CONFLICT');
  const expectedCommandId = officialVoucherStableIdV2('OC', fields.commandEntity, companyId, {
    documentId,
    voucherGroupKey,
    expectedRevision,
    commandType: text(command.commandType).toUpperCase(),
    commandPayloadDigest: payloadDigest
  });
  if (expectedCommandId !== command.commandId) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_ID_INVALID');
  return deepFreeze({ command, kind: fields.kind, companyId, documentId, voucherGroupKey, payloadDigest, preflight });
}

export function assertOfficialLedgerProjectionV2(projection = {}, checkedSource = {}) {
  const checked = checkedSource?.command && checkedSource?.preflight
    ? checkedSource
    : assertOfficialCommandV2(checkedSource);
  const document = projection?.document;
  const voucherRevision = projection?.voucherRevision;
  const ledgerEntries = Array.isArray(projection?.ledgerEntries) ? projection.ledgerEntries : [];
  if (!document || typeof document !== 'object') throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_DOCUMENT_REQUIRED');
  if (!voucherRevision || typeof voucherRevision !== 'object') throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_REVISION_REQUIRED');

  const businessDate = snapshotText(checked.preflight.businessDate);
  if (!businessDate || snapshotText(document.businessDate) !== businessDate) {
    throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_DOCUMENT_DATE_MISMATCH');
  }
  const partnerResolution = checked.command.document.officialPartnerResolution;
  const matched = text(partnerResolution?.status).toUpperCase() === 'MATCHED';
  if (ledgerEntries.length !== (matched ? 1 : 0)) {
    throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_EFFECT_COUNT_INVALID');
  }

  const documentIdField = checked.kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const expectedPartnerId = matched ? text(partnerResolution.matchedCustomerId) : '';
  const occurredAt = snapshotText(checked.command.occurredAt);
  const invalidEntry = ledgerEntries.find(entry => text(entry.companyId) !== checked.companyId
    || text(entry.documentId) !== checked.documentId
    || text(entry[documentIdField]) !== checked.documentId
    || text(entry.voucherMode).toUpperCase() !== checked.kind
    || text(entry.partnerId) !== expectedPartnerId
    || snapshotText(entry.effectiveAt) !== businessDate
    || snapshotText(entry.occurredAt) !== occurredAt
    || Number(entry.totalAmount) !== Number(document.totalAmount));
  if (invalidEntry) throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_PROJECTION_MISMATCH');

  const decision = voucherRevision.partnerEffectDecision;
  if (!decision || typeof decision !== 'object') throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_DECISION_REQUIRED');
  const expectedStatus = matched ? 'CREATED' : 'NOT_CREATED';
  const projectedEntryIds = ledgerEntries.map(entry => text(entry.entryId));
  if (text(decision.status).toUpperCase() !== expectedStatus
    || text(decision.reason) !== text(partnerResolution.reason)
    || text(decision.partnerResolutionStatus).toUpperCase() !== text(partnerResolution.status).toUpperCase()
    || text(decision.partnerId) !== expectedPartnerId
    || Number(decision.finalAmount) !== Number(document.totalAmount)
    || snapshotText(decision.effectiveAt) !== businessDate
    || snapshotText(decision.occurredAt) !== occurredAt
    || canonicalSha256(decision.entryIds || []) !== canonicalSha256(projectedEntryIds)) {
    throw new Error('ORDERQ_OFFICIAL_V2_LEDGER_DECISION_MISMATCH');
  }
  return deepFreeze(clone({ ledgerEntries, partnerEffectDecision: decision }));
}
