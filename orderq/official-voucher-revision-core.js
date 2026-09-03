import './canonical-hash.js?v=0.2.0';
import {
  assertOfficialPartnerResolutionV2,
  assertOfficialProductResolutionV2,
  normalizeOfficialBusinessDate,
  preflightOfficialVoucherV2,
  officialVoucherStableIdV2,
  officialVoucherRevisionIdV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
  OFFICIAL_VOUCHER_V2_ENTITY
} from './official-voucher-v2-contract.js?v=0.5.0';
import { calculateOfficialDocumentAmount, unresolvedProductStableId } from './official-voucher-core.js?v=0.24.0';
import { evaluateStocktakeCheckpointConflictV2 } from './stocktake-conflict-v2.js?v=0.2.0';

const sharedCanonicalHash = globalThis.ORDERQ_CANONICAL_HASH;
if (!sharedCanonicalHash) throw new Error('ORDERQ_CANONICAL_HASH_NOT_LOADED');

const canonicalSha256 = sharedCanonicalHash.canonicalSha256;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const text = value => String(value ?? '').trim();
const snapshotText = value => String(value ?? '').trim();

export const OFFICIAL_REVISION_COMMAND_SCHEMA_V2 = 'ONEAPP_ORDERQ_OFFICIAL_REVISION_COMMAND_V2';
export const OFFICIAL_REVISION_TARGET_SCHEMA_V2 = 'ONEAPP_ORDERQ_OFFICIAL_REVISION_TARGET_V2';
export const OFFICIAL_REVISION_PLAN_SCHEMA_V2 = 'ONEAPP_ORDERQ_OFFICIAL_REVISION_PLAN_V2';
export const OFFICIAL_REVISION_REFERENCE_EVIDENCE_SCHEMA_V2 = 'ONEAPP_ORDERQ_OFFICIAL_REVISION_REFERENCE_EVIDENCE_V2';

export const OFFICIAL_REVISION_ACTION = Object.freeze({
  CORRECT: 'CORRECT',
  CANCEL: 'CANCEL'
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function required(value, code) {
  const normalized = text(value);
  if (!normalized) throw new Error(code);
  return normalized;
}

function finite(value, code) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) throw new Error(code);
  const number = Number(typeof value === 'string' ? value.replace(/,/g, '').trim() : value);
  if (!Number.isFinite(number)) throw new Error(code);
  return Object.is(number, -0) ? 0 : number;
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isInteger(year) && year >= 1 && year <= 9999
    && Number.isInteger(month) && month >= 1 && month <= 12
    && Number.isInteger(day) && day >= 1 && day <= 31
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function calendarDate(value, code) {
  const normalized = snapshotText(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) throw new Error(code);
  return normalized;
}

function zonedTimestamp(value, code) {
  const normalized = snapshotText(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || (match[8] !== 'Z' && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4, 6)) > 59))
    || !Number.isFinite(Date.parse(normalized))) throw new Error(code);
  return normalized;
}

function kindContract(value) {
  const kind = text(value).toUpperCase();
  if (!['PURCHASE', 'SALE'].includes(kind)) throw new Error('ORDERQ_OFFICIAL_REVISION_KIND_INVALID');
  return kind === 'PURCHASE'
    ? { kind, mode: 'purchase', documentId: 'purchaseDocumentId', lineId: 'purchaseLineId',
      documentPrefix: 'PD', linePrefix: 'PL', documentEntity: OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_DOCUMENT,
      lineEntity: OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_LINE, sign: 1 }
    : { kind, mode: 'sale', documentId: 'salesDocumentId', lineId: 'salesLineId',
      documentPrefix: 'SD', linePrefix: 'SL', documentEntity: OFFICIAL_VOUCHER_V2_ENTITY.SALE_DOCUMENT,
      lineEntity: OFFICIAL_VOUCHER_V2_ENTITY.SALE_LINE, sign: -1 };
}

function actionOf(value) {
  const action = text(value).toUpperCase();
  if (!Object.values(OFFICIAL_REVISION_ACTION).includes(action)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ACTION_INVALID');
  }
  return action;
}

function sortById(rows, field) {
  return clone(rows || []).sort((left, right) => text(left?.[field]).localeCompare(text(right?.[field])));
}

function targetDigestPayload(source = {}) {
  const contract = kindContract(source.kind || source.voucherMode);
  return {
    schemaVersion: OFFICIAL_REVISION_TARGET_SCHEMA_V2,
    companyId: text(source.companyId),
    kind: contract.kind,
    voucherMode: contract.mode,
    documentId: text(source.documentId),
    currentRevision: Number(source.currentRevision),
    currentRevisionId: text(source.currentRevisionId),
    currentDocument: clone(source.currentDocument),
    currentLines: sortById(source.currentLines, contract.lineId),
    currentVoucherRevision: clone(source.currentVoucherRevision),
    effectiveLineStates: sortById(source.effectiveLineStates, 'lineId'),
    unresolvedProductEvidence: sortById(source.unresolvedProductEvidence, 'unresolvedProductId'),
    partnerEntryIds: [...(source.partnerEntryIds || [])].map(text).sort(),
    currentCommandReceiptDigest: text(source.currentCommandReceiptDigest)
  };
}

export function withOfficialRevisionTargetDigestV2(source = {}) {
  const target = targetDigestPayload(source);
  return deepFreeze({ ...target, targetDigest: canonicalSha256(target) });
}

export function assertOfficialRevisionTargetV2(source = {}) {
  const target = clone(source);
  const contract = kindContract(target.kind || target.voucherMode);
  if (text(target.schemaVersion) !== OFFICIAL_REVISION_TARGET_SCHEMA_V2) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_SCHEMA_INVALID');
  }
  const companyId = required(target.companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const documentId = required(target.documentId, `ORDERQ_OFFICIAL_${contract.kind}_DOCUMENT_ID_REQUIRED`);
  const currentRevision = Number(target.currentRevision);
  if (!Number.isInteger(currentRevision) || currentRevision < 1) throw new Error('ORDERQ_OFFICIAL_REVISION_REQUIRED');
  const currentDocument = target.currentDocument;
  if (!currentDocument || text(currentDocument.companyId) !== companyId
    || text(currentDocument.entityType) !== contract.documentEntity
    || text(currentDocument[contract.documentId]) !== documentId
    || officialVoucherStableIdV2(contract.documentPrefix, contract.documentEntity, companyId,
      currentDocument.identitySeed || {}) !== documentId
    || Number(currentDocument.revision) !== currentRevision
    || text(currentDocument.status).toUpperCase() !== 'CONFIRMED'
    || text(currentDocument.businessStatus).toUpperCase() !== 'CONFIRMED') {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_HEAD_INVALID');
  }
  const currentLines = Array.isArray(target.currentLines) ? target.currentLines : [];
  if (!currentLines.length || currentLines.some(line => text(line.companyId) !== companyId
    || text(line.entityType) !== contract.lineEntity
    || text(line[contract.documentId]) !== documentId
    || officialVoucherStableIdV2(contract.linePrefix, contract.lineEntity, companyId,
      line.identitySeed || {}) !== text(line[contract.lineId])
    || Number(line.revision) !== currentRevision
    || text(line.lineStatus).toUpperCase() !== 'ACTIVE'
    || text(line.status).toUpperCase() !== 'CONFIRMED')) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_LINES_INVALID');
  }
  const currentVoucherRevision = target.currentVoucherRevision;
  if (!currentVoucherRevision || text(currentVoucherRevision.companyId) !== companyId
    || text(currentVoucherRevision.voucherMode).toLowerCase() !== contract.mode
    || text(currentVoucherRevision.documentId) !== documentId
    || Number(currentVoucherRevision.revision) !== currentRevision
    || text(currentVoucherRevision.voucherRevisionId) !== text(target.currentRevisionId)
    || canonicalSha256(currentVoucherRevision.beforeSnapshot) !== text(currentVoucherRevision.beforeDigest)
    || canonicalSha256(currentVoucherRevision.afterSnapshot) !== text(currentVoucherRevision.afterDigest)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_HASH_INVALID');
  }
  const states = Array.isArray(target.effectiveLineStates) ? target.effectiveLineStates : [];
  if (states.length !== currentLines.length || states.some(state => !['MATCHED', 'UNRESOLVED_PRODUCT'].includes(text(state.status)))) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_EFFECTS_INVALID');
  }
  const evidence = Array.isArray(target.unresolvedProductEvidence) ? target.unresolvedProductEvidence : [];
  const requiredUnresolvedIds = [...new Set(states.map(state => text(state.activePendingEffect?.unresolvedProductId
    || state.rematchedFromUnresolvedProductId)).filter(Boolean))].sort();
  const evidenceIds = evidence.map(row => text(row.unresolvedProductId)).sort();
  if (canonicalSha256(evidenceIds) !== canonicalSha256(requiredUnresolvedIds)
    || evidence.some(row => text(row.companyId) !== companyId)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_UNRESOLVED_EVIDENCE_INVALID');
  }
  const expectedDigest = canonicalSha256(targetDigestPayload(target));
  if (expectedDigest !== text(target.targetDigest)) throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_DIGEST_INVALID');
  return deepFreeze({ target, contract, companyId, documentId, currentRevision, targetDigest: expectedDigest });
}

function lineBusinessDate(document, line) {
  return calendarDate(line.businessDate || document.businessDate || document.purchaseDate || document.saleDate,
    'ORDERQ_OFFICIAL_REVISION_BUSINESS_DATE_INVALID');
}

function lineBusinessTimestamp(document, line, businessDate) {
  const value = snapshotText(line.businessOccurredAt || document.businessOccurredAt || document.businessEffectiveAt);
  if (!value) return '';
  const checked = zonedTimestamp(value, 'ORDERQ_OFFICIAL_REVISION_BUSINESS_TIME_INVALID');
  if (checked.slice(0, 10) !== businessDate) throw new Error('ORDERQ_OFFICIAL_REVISION_BUSINESS_TIME_INVALID');
  return checked;
}

function afterState(source, checkedTarget, action) {
  if (action === OFFICIAL_REVISION_ACTION.CANCEL) return null;
  const replacement = clone(source.replacement || source.after || source.afterState);
  if (!replacement?.document || !Array.isArray(replacement.lines) || !replacement.lines.length) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_REQUIRED');
  }
  const { contract, companyId, documentId, currentRevision } = checkedTarget;
  const document = replacement.document;
  if (text(document.schemaVersion) !== OFFICIAL_VOUCHER_SCHEMA_VERSION_V2
    || text(document.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
    || text(document.entityType) !== contract.documentEntity
    || text(document.companyId) !== companyId
    || text(document[contract.documentId]) !== documentId
    || officialVoucherStableIdV2(contract.documentPrefix, contract.documentEntity, companyId,
      document.identitySeed || {}) !== documentId
    || text(document.voucherGroupKey) !== text(checkedTarget.target.currentDocument.voucherGroupKey)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_DOCUMENT_INVALID');
  }
  assertOfficialPartnerResolutionV2(document, companyId);
  const businessDate = normalizeOfficialBusinessDate(document).businessDate;
  const seen = new Set();
  const lines = replacement.lines.map(sourceLine => {
    const line = clone(sourceLine);
    const lineId = required(line[contract.lineId], `ORDERQ_OFFICIAL_${contract.kind}_LINE_ID_REQUIRED`);
    if (seen.has(lineId)) throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_LINE_DUPLICATE');
    seen.add(lineId);
    if (text(line.schemaVersion) !== OFFICIAL_VOUCHER_SCHEMA_VERSION_V2
      || text(line.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
      || text(line.entityType) !== contract.lineEntity
      || text(line.companyId) !== companyId || text(line[contract.documentId]) !== documentId
      || officialVoucherStableIdV2(contract.linePrefix, contract.lineEntity, companyId,
        line.identitySeed || {}) !== lineId
      || text(line.voucherGroupKey) !== text(document.voucherGroupKey)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_LINE_SCOPE_INVALID');
    }
    const quantity = finite(line.actualQuantity ?? line.quantity, 'ORDERQ_OFFICIAL_QUANTITY_REQUIRED');
    finite(line.unitPrice, 'ORDERQ_OFFICIAL_UNIT_PRICE_REQUIRED');
    finite(line.totalAmount, 'ORDERQ_OFFICIAL_TOTAL_AMOUNT_INVALID');
    if (finite(line.baseQuantity, 'ORDERQ_OFFICIAL_BASE_QUANTITY_REQUIRED') !== quantity
      || Number(line.inventoryEffectFactor) !== 1) throw new Error('ORDERQ_OFFICIAL_V2_INVENTORY_FACTOR_INVALID');
    assertOfficialProductResolutionV2(line, companyId);
    return line;
  });
  const preflight = preflightOfficialVoucherV2({
    kind: contract.kind,
    companyId,
    voucherGroupKey: document.voucherGroupKey,
    businessDate,
    warehouseId: document.warehouseId,
    rows: lines
  });
  if (preflight.rows.length !== lines.length) throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_LINES_INVALID');
  lines.forEach((line, index) => {
    const expectedSnapshot = preflight.rows[index]?.productSnapshot;
    if (!expectedSnapshot || canonicalSha256(expectedSnapshot) !== canonicalSha256(line.productSnapshot)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_LINE_SNAPSHOT_MISMATCH');
    }
    const snapshot = line.productSnapshot;
    if (Number(line.actualQuantity ?? line.quantity) !== Number(snapshot.quantity)
      || Number(line.unitPrice) !== Number(snapshot.unitPrice)
      || Number(line.totalAmount) !== Number(snapshot.amount)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_LINE_AMOUNT_MISMATCH');
    }
  });
  const amounts = calculateOfficialDocumentAmount(lines);
  const documentVat = document.vatAmount === null || document.vatAmount === undefined
    ? null : finite(document.vatAmount, 'ORDERQ_OFFICIAL_REVISION_DOCUMENT_VAT_INVALID');
  if (finite(document.supplyAmount, 'ORDERQ_OFFICIAL_REVISION_DOCUMENT_SUPPLY_INVALID') !== amounts.supplyAmount
    || documentVat !== amounts.vatAmount
    || finite(document.totalAmount, 'ORDERQ_OFFICIAL_REVISION_DOCUMENT_TOTAL_INVALID') !== amounts.totalAmount
    || (Object.prototype.hasOwnProperty.call(document, 'calculatedSupplyAmount')
      && finite(document.calculatedSupplyAmount, 'ORDERQ_OFFICIAL_REVISION_DOCUMENT_CALCULATED_INVALID') !== amounts.calculatedSupplyAmount)
    || (Object.prototype.hasOwnProperty.call(document, 'amountDifference')
      && finite(document.amountDifference, 'ORDERQ_OFFICIAL_REVISION_DOCUMENT_DIFFERENCE_INVALID') !== amounts.amountDifference)
    || (text(document.currency) && text(document.currency) !== text(amounts.currency))) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REPLACEMENT_DOCUMENT_AMOUNT_MISMATCH');
  }
  return deepFreeze({ document: clone(document), lines: sortById(lines, contract.lineId), businessDate,
    revision: currentRevision + 1 });
}

function stateByLineId(target) {
  return new Map((target.effectiveLineStates || []).map(state => [text(state.lineId), state]));
}

function afterLineState(contract, document, line) {
  const productResolution = assertOfficialProductResolutionV2(line, document.companyId);
  const businessDate = lineBusinessDate(document, line);
  const quantity = finite(line.actualQuantity ?? line.quantity, 'ORDERQ_OFFICIAL_QUANTITY_REQUIRED');
  const signedQuantity = Object.is(contract.sign * quantity, -0) ? 0 : contract.sign * quantity;
  if (text(productResolution.status) === 'MATCHED') {
    return {
      status: 'MATCHED', lineId: text(line[contract.lineId]), productId: text(line.productId),
      productCode: snapshotText(line.productSnapshot?.productCode || line.productCode), warehouseId: text(line.warehouseId),
      businessDate, businessOccurredAt: lineBusinessTimestamp(document, line, businessDate), signedQuantity
    };
  }
  return {
    status: 'UNRESOLVED_PRODUCT', lineId: text(line[contract.lineId]), unresolvedProductId: text(line.unresolvedProductId),
    productCode: snapshotText(line.productSnapshot?.originalProductCode || line.originalProductCode || line.productCode),
    warehouseId: text(line.warehouseId), businessDate,
    businessOccurredAt: lineBusinessTimestamp(document, line, businessDate), signedQuantity
  };
}

function comparableState(state = {}) {
  return {
    status: text(state.status), productId: text(state.productId), unresolvedProductId: text(state.unresolvedProductId),
    productCode: snapshotText(state.productCode), warehouseId: text(state.warehouseId),
    businessDate: snapshotText(state.businessDate), businessOccurredAt: snapshotText(state.businessOccurredAt),
    signedQuantity: Number(state.signedQuantity)
  };
}

function statesEqual(left, right) {
  return canonicalSha256(comparableState(left)) === canonicalSha256(comparableState(right));
}

function productReferenceProjection(line = {}) {
  const resolution = line.officialProductResolution
    || line.productSnapshot?.matchEvidence?.officialProductResolution || {};
  return {
    productId: text(line.productId),
    unresolvedProductId: text(line.unresolvedProductId),
    productCode: snapshotText(line.productSnapshot?.productCode || line.productCode),
    productName: snapshotText(line.productSnapshot?.productName || line.productName),
    specification: snapshotText(line.productSnapshot?.specification || line.specification),
    unit: snapshotText(line.productSnapshot?.unit || line.unit || line.actualUnit),
    originalProductCode: snapshotText(line.productSnapshot?.originalProductCode || line.originalProductCode),
    originalProductName: snapshotText(line.productSnapshot?.originalProductName || line.originalProductName),
    matchStatus: text(line.matchStatus || line.productIdentityStatus).toUpperCase(),
    matchSource: text(line.matchSource),
    officialProductResolution: {
      companyId: text(resolution.companyId), status: text(resolution.status).toUpperCase(), reason: text(resolution.reason),
      inputProductCode: snapshotText(resolution.inputProductCode), matchedProductCode: snapshotText(resolution.matchedProductCode),
      matchedProductId: text(resolution.matchedProductId), productMasterRevision: Number(resolution.productMasterRevision || 0),
      referenceSnapshotId: text(resolution.referenceSnapshotId)
    }
  };
}

function partnerReferenceProjection(document = {}) {
  return {
    officialPartnerResolution: clone(document.officialPartnerResolution),
    supplierCustomerId: text(document.supplierCustomerId),
    supplierCustomerCode: snapshotText(document.supplierCustomerCode),
    supplierCustomerName: snapshotText(document.supplierCustomerName),
    supplierCustomerRevision: Number(document.supplierCustomerRevision || 0),
    salesCustomerId: text(document.salesCustomerId),
    salesCustomerCode: snapshotText(document.salesCustomerCode),
    salesCustomerName: snapshotText(document.salesCustomerName),
    salesCustomerRevision: Number(document.salesCustomerRevision || 0),
    billingCustomerId: text(document.billingCustomerId),
    billingCustomerCode: snapshotText(document.billingCustomerCode),
    billingCustomerName: snapshotText(document.billingCustomerName),
    billingCustomerRevision: Number(document.billingCustomerRevision || 0)
  };
}

function revisionReferenceRequirements(target, after) {
  if (!after) return deepFreeze({ products: [], partner: null });
  const contract = kindContract(target.kind);
  const currentById = new Map(target.currentLines.map(line => [text(line[contract.lineId]), line]));
  const products = after.lines.flatMap(line => {
    const resolution = assertOfficialProductResolutionV2(line, target.companyId);
    const current = currentById.get(text(line[contract.lineId]));
    if (current && canonicalSha256(productReferenceProjection(current))
      === canonicalSha256(productReferenceProjection(line))) return [];
    const status = text(resolution.status).toUpperCase();
    const unresolvedProductId = text(line.unresolvedProductId);
    if (status === 'UNRESOLVED_PRODUCT'
      && unresolvedProductId !== unresolvedProductStableId(target.companyId, line)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_UNRESOLVED_PRODUCT_ID_INVALID');
    }
    return [{
      lineId: text(line[contract.lineId]),
      status,
      reason: text(resolution.reason),
      inputProductCode: snapshotText(resolution.inputProductCode),
      inputProductName: snapshotText(line.productSnapshot?.productName || line.productName),
      productId: text(line.productId),
      unresolvedProductId,
      productCode: snapshotText(line.productSnapshot?.productCode || line.productCode),
      productName: snapshotText(line.productSnapshot?.productName || line.productName),
      specification: snapshotText(line.productSnapshot?.specification || line.specification),
      unit: snapshotText(line.productSnapshot?.unit || line.unit || line.actualUnit),
      productMasterRevision: Number(resolution.productMasterRevision || 0),
      referenceSnapshotId: text(resolution.referenceSnapshotId)
    }];
  }).sort((left, right) => left.lineId.localeCompare(right.lineId));
  const beforePartner = partnerReferenceProjection(target.currentDocument);
  const afterPartner = partnerReferenceProjection(after.document);
  const partnerChanged = canonicalSha256(beforePartner) !== canonicalSha256(afterPartner);
  const resolution = after.document.officialPartnerResolution || {};
  const partner = partnerChanged ? {
    status: text(resolution.status).toUpperCase(),
    reason: text(resolution.reason),
    partnerRole: text(resolution.partnerRole).toUpperCase(),
    inputCustomerCode: snapshotText(resolution.inputCustomerCode),
    inputCustomerName: snapshotText(resolution.inputCustomerName),
    matchedCustomerId: text(resolution.matchedCustomerId),
    matchedCustomerCode: snapshotText(resolution.matchedCustomerCode),
    matchedCustomerName: snapshotText(resolution.matchedCustomerName),
    customerMasterRevision: Number(resolution.customerMasterRevision || 0),
    referenceSnapshotId: text(resolution.referenceSnapshotId)
  } : null;
  return deepFreeze({ products, partner });
}

function productRowProjection(row = {}) {
  return {
    productId: text(row.productId || row.masterProductId),
    productCode: snapshotText(row.itemCode || row.productCode || row['코드'] || row['품목코드'] || row.raw?.['코드'] || row.raw?.['품목코드']),
    productName: snapshotText(row.itemName || row.productName || row['품목명'] || row.name || row.raw?.['품목명']),
    specification: snapshotText(row.specification || row['규격'] || row.raw?.['규격']),
    unit: snapshotText(row.unit || row.finalUnit || row.actualUnit || row['단위'] || row.raw?.['단위']),
    revision: Number(row.revision || row.masterRevision || row.raw?.revision || 0)
  };
}

function activeReferenceRow(row = {}) {
  return row.active !== false
    && !['INACTIVE', 'DELETED'].includes(text(row.status || 'ACTIVE').toUpperCase())
    && text(row.productIdentityType).toUpperCase() !== 'TEMPORARY'
    && text(row.qualityStatus).toUpperCase() !== 'SUPERSEDED';
}

function companyReferenceRow(row, companyId) {
  return text(row?.companyId) === companyId;
}

function customerCodeKey(value) {
  return snapshotText(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
}

function referenceEvidence(snapshot, domain) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`ORDERQ_OFFICIAL_REVISION_${domain}_SNAPSHOT_REQUIRED`);
  return {
    schemaVersion: text(snapshot.schemaVersion),
    snapshotId: required(snapshot.snapshotId, `ORDERQ_OFFICIAL_REVISION_${domain}_SNAPSHOT_ID_REQUIRED`),
    revision: snapshot.revision === null || snapshot.revision === undefined ? null : snapshot.revision,
    snapshotVersion: snapshot.snapshotVersion === null || snapshot.snapshotVersion === undefined ? null : snapshot.snapshotVersion,
    contentHash: required(snapshot.contentHash, `ORDERQ_OFFICIAL_REVISION_${domain}_SNAPSHOT_HASH_REQUIRED`)
  };
}

function validateBuildReferenceSnapshots(requirements, source) {
  const productSnapshot = source.productOwnerSnapshot || source.productReferenceSnapshot;
  const customerSnapshot = source.customerOwnerSnapshot || source.customerReferenceSnapshot;
  let productEvidence = null;
  let customerEvidence = null;
  const ownerProductRequirements = requirements.products.filter(expected => expected.inputProductCode);
  requirements.products.filter(expected => !expected.inputProductCode).forEach(expected => {
    if (expected.status !== 'UNRESOLVED_PRODUCT' || expected.reason !== 'PRODUCT_CODE_NOT_PROVIDED'
      || !expected.inputProductName || !expected.unresolvedProductId) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_PRODUCT_REFERENCE_MISMATCH');
    }
  });
  if (ownerProductRequirements.length) {
    productEvidence = referenceEvidence(productSnapshot, 'PRODUCT');
    if (productEvidence.schemaVersion !== 'ONEAPP_PRODUCT_SNAPSHOT_V1'
      || text(productSnapshot.status) !== 'READY' || !Array.isArray(productSnapshot.data?.products)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_PRODUCT_SNAPSHOT_INVALID');
    }
    ownerProductRequirements.forEach(expected => {
      const matches = productSnapshot.data.products.filter(row => companyReferenceRow(row, source.companyId || source.target?.companyId
        || source.preflight?.target?.companyId) && activeReferenceRow(row)
        && productRowProjection(row).productCode === expected.inputProductCode);
      const actual = matches.length === 1 ? productRowProjection(matches[0]) : null;
      const actualStatus = matches.length > 1 || (actual && !actual.productId) ? 'UNRESOLVED_PRODUCT'
        : actual ? 'MATCHED' : 'UNRESOLVED_PRODUCT';
      const actualReason = matches.length > 1 ? 'PRODUCT_CODE_AMBIGUOUS'
        : actual && !actual.productId ? 'MATCHED_PRODUCT_TECHNICAL_ID_MISSING'
          : actual ? 'EXACT_COMPANY_PRODUCT_CODE' : 'PRODUCT_CODE_UNMATCHED';
      if (expected.status !== actualStatus || expected.reason !== actualReason
        || expected.referenceSnapshotId !== productEvidence.snapshotId
        || (actualStatus === 'MATCHED' && canonicalSha256(actual) !== canonicalSha256({
          productId: expected.productId, productCode: expected.productCode, productName: expected.productName,
          specification: expected.specification, unit: expected.unit, revision: expected.productMasterRevision
        }))) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_PRODUCT_REFERENCE_MISMATCH');
      }
    });
  }
  if (requirements.partner) {
    customerEvidence = referenceEvidence(customerSnapshot, 'CUSTOMER');
    if (customerEvidence.schemaVersion !== 'ONEAPP_CUSTOMER_SNAPSHOT_V1'
      || !['READY', 'EMPTY'].includes(text(customerSnapshot.status))
      || !Array.isArray(customerSnapshot.data?.customers)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_SNAPSHOT_INVALID');
    }
    const expected = requirements.partner;
    const inputKey = customerCodeKey(expected.inputCustomerCode);
    const matches = inputKey ? customerSnapshot.data.customers.filter(row => companyReferenceRow(row, source.companyId || source.target?.companyId
      || source.preflight?.target?.companyId) && activeReferenceRow(row)
      && customerCodeKey(row.customerCode || row.erpCustomerCode) === inputKey) : [];
    const actual = matches.length === 1 ? matches[0] : null;
    if (expected.referenceSnapshotId !== customerEvidence.snapshotId) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
    }
    if (expected.status === 'MATCHED') {
      if (!actual || !text(actual.customerId)
        || text(actual.customerId) !== expected.matchedCustomerId
        || snapshotText(actual.customerCode || actual.erpCustomerCode) !== expected.matchedCustomerCode
        || snapshotText(actual.customerName || actual.name) !== expected.matchedCustomerName
        || Number(actual.revision || 0) !== expected.customerMasterRevision) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
      }
    } else if (expected.status === 'UNRESOLVED_CUSTOMER') {
      const reason = matches.length > 1 ? 'CUSTOMER_CODE_AMBIGUOUS'
        : actual && !text(actual.customerId) ? 'MATCHED_CUSTOMER_ID_MISSING'
          : actual ? 'EXACT_COMPANY_CUSTOMER_CODE' : 'CUSTOMER_CODE_UNMATCHED';
      if (!expected.inputCustomerCode || reason !== expected.reason || actual && text(actual.customerId)) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
      }
    } else if (expected.status !== 'CUSTOMER_NOT_PROVIDED' || expected.inputCustomerCode || matches.length) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
    }
  }
  return deepFreeze({ schemaVersion: OFFICIAL_REVISION_REFERENCE_EVIDENCE_SCHEMA_V2,
    productSnapshot: productEvidence, customerSnapshot: customerEvidence });
}

function deltaId(seed) {
  return `RID-${canonicalSha256({ schemaVersion: OFFICIAL_REVISION_PLAN_SCHEMA_V2, ...seed }).slice(0, 32)}`;
}

function rawDeltaRows(checkedTarget, action, after) {
  const { target, contract, documentId } = checkedTarget;
  const beforeStates = stateByLineId(target);
  const afterLines = new Map((after?.lines || []).map(line => [text(line[contract.lineId]), line]));
  const allLineIds = [...new Set([...beforeStates.keys(), ...afterLines.keys()])].sort();
  const rows = [];
  allLineIds.forEach(lineId => {
    const before = beforeStates.get(lineId);
    const afterLine = afterLines.get(lineId);
    const next = afterLine ? afterLineState(contract, after.document, afterLine) : null;
    if (action === OFFICIAL_REVISION_ACTION.CORRECT && before && next && statesEqual(before, next)) return;
    if (before?.status === 'MATCHED') {
      const effects = Array.isArray(before.activeInventoryEffects) ? before.activeInventoryEffects : [];
      if (!effects.length) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_REQUIRED');
      effects.forEach((effect, index) => {
        const sourceApplied = effect.officialInventoryApplied === true;
        const sourceSigned = finite(effect.signedQuantity, 'ORDERQ_OFFICIAL_REVISION_SOURCE_EFFECT_INVALID');
        const proposed = sourceApplied ? -sourceSigned : 0;
        rows.push({
          deltaId: deltaId({ action, role: 'REVERSE_CURRENT_EFFECT', documentId, lineId,
            sourceEffectId: text(effect.movementId), ordinal: index + 1 }),
          role: 'REVERSE_CURRENT_EFFECT', sourceEffectId: text(effect.movementId), sourceApplied,
          companyId: target.companyId, voucherMode: contract.mode, documentId, lineId,
          productId: text(effect.productId), productCode: snapshotText(effect.productCode || before.productCode),
          warehouseId: text(effect.warehouseId), businessDate: calendarDate(effect.businessDate || effect.effectiveAt,
            'ORDERQ_OFFICIAL_REVISION_SOURCE_EFFECT_DATE_INVALID'),
          businessOccurredAt: snapshotText(effect.businessOccurredAt || before.businessOccurredAt),
          proposedSignedQuantity: Object.is(proposed, -0) ? 0 : proposed,
          reversesOriginalSignedQuantity: Number(effect.originalSignedQuantity ?? sourceSigned)
        });
      });
    }
    if (before?.status === 'UNRESOLVED_PRODUCT') {
      const pending = before.activePendingEffect;
      if (!pending) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_PENDING_REQUIRED');
      rows.push({
        deltaId: deltaId({ action, role: 'SUPERSEDE_PENDING_EFFECT', documentId, lineId,
          sourceEffectId: text(pending.pendingEffectId) }),
        role: 'SUPERSEDE_PENDING_EFFECT', sourceEffectId: text(pending.pendingEffectId), companyId: target.companyId,
        voucherMode: contract.mode, documentId, lineId, unresolvedProductId: text(pending.unresolvedProductId),
        warehouseId: text(pending.warehouseId), businessDate: calendarDate(pending.effectiveAt,
          'ORDERQ_OFFICIAL_REVISION_SOURCE_EFFECT_DATE_INVALID'), proposedSignedQuantity: 0
      });
    }
    if (next?.status === 'MATCHED') {
      rows.push({
        deltaId: deltaId({ action, role: 'APPLY_REVISED_EFFECT', documentId, lineId, productId: next.productId,
          warehouseId: next.warehouseId, businessDate: next.businessDate, signedQuantity: next.signedQuantity }),
        role: 'APPLY_REVISED_EFFECT', companyId: target.companyId, voucherMode: contract.mode, documentId, lineId,
        productId: next.productId, productCode: next.productCode, warehouseId: next.warehouseId,
        businessDate: next.businessDate, businessOccurredAt: next.businessOccurredAt,
        proposedSignedQuantity: next.signedQuantity
      });
    } else if (next?.status === 'UNRESOLVED_PRODUCT') {
      rows.push({
        deltaId: deltaId({ action, role: 'CREATE_REVISED_PENDING_EFFECT', documentId, lineId,
          unresolvedProductId: next.unresolvedProductId, warehouseId: next.warehouseId,
          businessDate: next.businessDate, signedQuantity: next.signedQuantity }),
        role: 'CREATE_REVISED_PENDING_EFFECT', companyId: target.companyId, voucherMode: contract.mode,
        documentId, lineId, unresolvedProductId: next.unresolvedProductId, productCode: next.productCode,
        warehouseId: next.warehouseId, businessDate: next.businessDate,
        businessOccurredAt: next.businessOccurredAt, proposedSignedQuantity: next.signedQuantity
      });
    }
  });
  return rows;
}

function classifyRows(rows, checkpoints) {
  return rows.map(row => {
    if (!row.productId) return { ...row, requiresDecision: false, checkpoint: null, classification: 'PENDING_REVIEW' };
    const classification = evaluateStocktakeCheckpointConflictV2({
      companyId: row.companyId, productId: row.productId, productCode: row.productCode,
      warehouseId: row.warehouseId, businessDate: row.businessDate,
      businessOccurredAt: row.businessOccurredAt, inventoryCheckpoints: checkpoints
    });
    return { ...row, requiresDecision: classification.requiresDecision,
      classification: classification.reason, checkpoint: clone(classification.checkpoint) };
  });
}

export function previewOfficialVoucherRevisionV2(source = {}) {
  const checkedTarget = assertOfficialRevisionTargetV2(source.target || source.expectedHead || source.preflight?.target);
  if ((checkedTarget.target.partnerEntryIds || []).length) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ARAP_EFFECT_UNSUPPORTED');
  }
  const action = actionOf(source.action);
  const after = afterState(source, checkedTarget, action);
  const checkpoints = clone(source.inventoryCheckpoints || source.preflight?.inventoryCheckpoints || []);
  const rows = classifyRows(rawDeltaRows(checkedTarget, action, after), checkpoints);
  const referenceRequirements = revisionReferenceRequirements(checkedTarget.target, after);
  const conflicts = rows.filter(row => row.requiresDecision).map(row => ({
    deltaId: row.deltaId, role: row.role, lineId: row.lineId, productId: row.productId,
    productCode: row.productCode, warehouseId: row.warehouseId, signedQuantity: row.proposedSignedQuantity,
    businessDate: row.businessDate, checkpointId: text(row.checkpoint?.checkpointId),
    checkpointEffectiveAt: snapshotText(row.checkpoint?.effectiveAt || row.checkpoint?.businessDate)
  }));
  const deltaDigest = canonicalSha256(rows.map(row => ({ ...row, checkpoint: clone(row.checkpoint) })));
  return deepFreeze({ schemaVersion: OFFICIAL_REVISION_PLAN_SCHEMA_V2, action, companyId: checkedTarget.companyId,
    kind: checkedTarget.contract.kind, voucherMode: checkedTarget.contract.mode, documentId: checkedTarget.documentId,
    expectedRevision: checkedTarget.currentRevision, targetDigest: checkedTarget.targetDigest,
    after: clone(after), deltaRows: rows, conflicts, deltaDigest, referenceRequirements });
}

function normalizeDecisions(source, preview, actor) {
  const provided = Array.isArray(source.stocktakeDecisions) ? source.stocktakeDecisions : [];
  if (provided.length !== preview.conflicts.length) throw new Error('ORDERQ_OFFICIAL_REVISION_STOCKTAKE_DECISIONS_INCOMPLETE');
  const byId = new Map();
  provided.forEach(decision => {
    const deltaIdValue = required(decision.deltaId, 'ORDERQ_OFFICIAL_REVISION_STOCKTAKE_DECISION_TARGET_REQUIRED');
    if (byId.has(deltaIdValue)) throw new Error('ORDERQ_OFFICIAL_REVISION_STOCKTAKE_DECISION_DUPLICATE');
    const decisionType = text(decision.decisionType).toUpperCase();
    if (!['INCLUDED_IN_CHECKPOINT', 'NOT_INCLUDED_IN_CHECKPOINT'].includes(decisionType)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_STOCKTAKE_DECISION_INVALID');
    }
    byId.set(deltaIdValue, {
      deltaId: deltaIdValue, decisionType,
      checkpointId: required(decision.checkpointId, 'ORDERQ_OFFICIAL_REVISION_STOCKTAKE_CHECKPOINT_REQUIRED'),
      checkpointEffectiveAt: calendarDate(snapshotText(decision.checkpointEffectiveAt).slice(0, 10),
        'ORDERQ_OFFICIAL_REVISION_STOCKTAKE_DATE_INVALID'),
      targetBusinessDate: calendarDate(decision.targetBusinessDate, 'ORDERQ_OFFICIAL_REVISION_TARGET_DATE_INVALID'),
      actor: required(decision.actor, 'ORDERQ_OFFICIAL_ACTOR_REQUIRED'),
      judgedAt: zonedTimestamp(decision.judgedAt, 'ORDERQ_OFFICIAL_REVISION_STOCKTAKE_JUDGED_AT_INVALID')
    });
  });
  return preview.conflicts.map(conflict => {
    const decision = byId.get(conflict.deltaId);
    if (!decision || decision.actor !== actor || decision.checkpointId !== conflict.checkpointId
      || decision.checkpointEffectiveAt !== snapshotText(conflict.checkpointEffectiveAt).slice(0, 10)
      || decision.targetBusinessDate !== conflict.businessDate) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_STOCKTAKE_DECISION_STALE');
    }
    return decision;
  });
}

function canonicalCommandPayload(source = {}) {
  const command = clone(source.command || source);
  delete command.commandId;
  delete command.idempotencyKey;
  delete command.commandPayloadDigest;
  return command;
}

export function buildOfficialVoucherRevisionCommandV2(source = {}) {
  if (source.cancelled === true) return deepFreeze({ cancelled: true });
  const preview = previewOfficialVoucherRevisionV2(source);
  const actor = required(source.actor, 'ORDERQ_OFFICIAL_ACTOR_REQUIRED');
  const occurredAt = zonedTimestamp(source.occurredAt, 'ORDERQ_OFFICIAL_REVISION_OCCURRED_AT_INVALID');
  const reason = required(source.reason, 'ORDERQ_OFFICIAL_REVISION_REASON_REQUIRED');
  const stocktakeDecisions = normalizeDecisions(source, preview, actor);
  const referenceEvidenceValue = validateBuildReferenceSnapshots(preview.referenceRequirements, source);
  const contract = kindContract(preview.kind);
  const command = {
    schemaVersion: OFFICIAL_REVISION_COMMAND_SCHEMA_V2,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    entityType: `${preview.kind}_${preview.action}_REVISION_COMMAND`,
    action: preview.action,
    kind: preview.kind,
    voucherMode: preview.voucherMode,
    companyId: preview.companyId,
    documentId: preview.documentId,
    [contract.documentId]: preview.documentId,
    expectedRevision: preview.expectedRevision,
    expectedHead: clone(source.target || source.expectedHead || source.preflight?.target),
    targetDigest: preview.targetDigest,
    replacement: preview.action === OFFICIAL_REVISION_ACTION.CORRECT ? clone(preview.after) : null,
    expectedDeltaDigest: preview.deltaDigest,
    inventoryCheckpoints: [...new Map(preview.deltaRows.filter(row => row.checkpoint)
      .map(row => [text(row.checkpoint.checkpointId), clone(row.checkpoint)])).values()],
    referenceRequirements: clone(preview.referenceRequirements),
    referenceEvidence: clone(referenceEvidenceValue),
    stocktakeDecisions,
    actor,
    occurredAt,
    reason
  };
  command.commandPayloadDigest = canonicalSha256(canonicalCommandPayload(command));
  command.commandId = `ORC-${canonicalSha256({
    schemaVersion: OFFICIAL_REVISION_COMMAND_SCHEMA_V2,
    companyId: command.companyId,
    voucherMode: command.voucherMode,
    documentId: command.documentId,
    expectedRevision: command.expectedRevision,
    action: command.action,
    payloadDigest: command.commandPayloadDigest
  }).slice(0, 32)}`;
  command.idempotencyKey = command.commandId;
  return assertOfficialVoucherRevisionCommandV2(command).command;
}

export function assertOfficialVoucherRevisionCommandV2(source = {}) {
  const command = clone(source.command || source);
  if (text(command.schemaVersion) !== OFFICIAL_REVISION_COMMAND_SCHEMA_V2
    || text(command.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_SCHEMA_INVALID');
  }
  const contract = kindContract(command.kind || command.voucherMode);
  const action = actionOf(command.action);
  if (text(command.entityType) !== `${contract.kind}_${action}_REVISION_COMMAND`) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_ENTITY_INVALID');
  }
  const checkedTarget = assertOfficialRevisionTargetV2(command.expectedHead);
  if (checkedTarget.contract.kind !== contract.kind || text(command.companyId) !== checkedTarget.companyId
    || text(command.documentId) !== checkedTarget.documentId
    || text(command[contract.documentId]) !== checkedTarget.documentId
    || Number(command.expectedRevision) !== checkedTarget.currentRevision
    || text(command.targetDigest) !== checkedTarget.targetDigest) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_SCOPE_INVALID');
  }
  const actor = required(command.actor, 'ORDERQ_OFFICIAL_ACTOR_REQUIRED');
  zonedTimestamp(command.occurredAt, 'ORDERQ_OFFICIAL_REVISION_OCCURRED_AT_INVALID');
  required(command.reason, 'ORDERQ_OFFICIAL_REVISION_REASON_REQUIRED');
  if (required(command.commandId, 'ORDERQ_OFFICIAL_COMMAND_ID_REQUIRED')
    !== required(command.idempotencyKey, 'ORDERQ_OFFICIAL_IDEMPOTENCY_KEY_REQUIRED')) {
    throw new Error('ORDERQ_OFFICIAL_COMMAND_IDEMPOTENCY_MISMATCH');
  }
  const preview = previewOfficialVoucherRevisionV2({
    target: checkedTarget.target, action, replacement: command.replacement,
    inventoryCheckpoints: command.inventoryCheckpoints || [], stocktakeDecisions: command.stocktakeDecisions
  });
  if (canonicalSha256(command.referenceRequirements) !== canonicalSha256(preview.referenceRequirements)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REFERENCE_REQUIREMENTS_INVALID');
  }
  const evidence = command.referenceEvidence;
  if (!evidence || text(evidence.schemaVersion) !== OFFICIAL_REVISION_REFERENCE_EVIDENCE_SCHEMA_V2
    || (preview.referenceRequirements.products.some(expected => expected.inputProductCode)
      && !text(evidence.productSnapshot?.contentHash))
    || (preview.referenceRequirements.partner && !text(evidence.customerSnapshot?.contentHash))) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REFERENCE_EVIDENCE_INVALID');
  }
  if (preview.deltaDigest !== text(command.expectedDeltaDigest)) throw new Error('ORDERQ_OFFICIAL_REVISION_DELTA_DIGEST_INVALID');
  normalizeDecisions(command, preview, actor);
  const payloadDigest = canonicalSha256(canonicalCommandPayload(command));
  if (payloadDigest !== text(command.commandPayloadDigest)) throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_PAYLOAD_CONFLICT');
  const expectedId = `ORC-${canonicalSha256({
    schemaVersion: OFFICIAL_REVISION_COMMAND_SCHEMA_V2, companyId: command.companyId,
    voucherMode: command.voucherMode, documentId: command.documentId,
    expectedRevision: Number(command.expectedRevision), action, payloadDigest
  }).slice(0, 32)}`;
  if (expectedId !== command.commandId) throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_ID_INVALID');
  return deepFreeze({ command, contract, action, checkedTarget, preview, payloadDigest });
}

function projectedMovement(command, row, decision) {
  const included = decision?.decisionType === 'INCLUDED_IN_CHECKPOINT';
  const late = decision?.decisionType === 'NOT_INCLUDED_IN_CHECKPOINT';
  const proposed = finite(row.proposedSignedQuantity, 'ORDERQ_OFFICIAL_REVISION_DELTA_QUANTITY_INVALID');
  const reversal = row.role === 'REVERSE_CURRENT_EFFECT';
  const zero = proposed === 0;
  return {
    movementId: `IRM-${canonicalSha256({ commandId: command.commandId, deltaId: row.deltaId }).slice(0, 32)}`,
    deltaId: row.deltaId,
    companyId: row.companyId,
    warehouseId: row.warehouseId,
    productId: row.productId,
    productCode: row.productCode,
    sourceDocumentId: row.documentId,
    sourceLineId: row.lineId,
    sourceDocumentRevision: command.expectedRevision + 1,
    voucherMode: row.voucherMode,
    movementType: reversal ? 'OFFICIAL_REVISION_REVERSAL' : 'OFFICIAL_REVISION_APPLICATION',
    effectRole: reversal ? 'REVISION_REVERSAL' : 'REVISION_AFTER_EFFECT',
    reversalOfMovementId: row.sourceEffectId || '',
    signedQuantity: included ? 0 : proposed,
    originalSignedQuantity: proposed,
    reversesOriginalSignedQuantity: Number(row.reversesOriginalSignedQuantity || 0),
    inventoryEffectFactor: 1,
    effectiveAt: row.businessDate,
    businessDate: row.businessDate,
    businessOccurredAt: row.businessOccurredAt || '',
    effectStatus: zero ? 'ZERO_EFFECT' : reversal ? 'REVERSED' : 'APPLIED_NORMAL',
    reversalStatus: reversal ? 'REVERSED' : '',
    stocktakeEffectStatus: included ? 'ABSORBED_BY_CHECKPOINT' : late ? 'APPLIED_AS_LATE_ADJUSTMENT' : '',
    stocktakeDecisionType: decision?.decisionType || '',
    stocktakeDecisionId: decision ? `RSD-${canonicalSha256(decision).slice(0, 32)}` : '',
    checkpointId: decision?.checkpointId || '',
    stocktakeJudgedAt: decision?.judgedAt || '',
    stocktakeDecisionActor: decision?.actor || '',
    officialInventoryApplied: !included && row.sourceApplied !== false,
    commandId: command.commandId,
    occurredAt: command.occurredAt,
    actor: command.actor
  };
}

export function planOfficialVoucherRevisionCommandV2({ command: sourceCommand = {}, target, inventoryCheckpoints = [] } = {}) {
  const checked = assertOfficialVoucherRevisionCommandV2(sourceCommand);
  const current = assertOfficialRevisionTargetV2(target || checked.command.expectedHead);
  if (current.targetDigest !== checked.command.targetDigest) throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_STALE');
  const preview = previewOfficialVoucherRevisionV2({
    target: current.target, action: checked.action, replacement: checked.command.replacement, inventoryCheckpoints
  });
  if (preview.deltaDigest !== checked.command.expectedDeltaDigest) throw new Error('ORDERQ_OFFICIAL_REVISION_DELTA_STALE');
  const decisions = normalizeDecisions(checked.command, preview, checked.command.actor);
  const decisionById = new Map(decisions.map(decision => [decision.deltaId, decision]));
  const movements = preview.deltaRows.filter(row => row.productId)
    .map(row => projectedMovement(checked.command, row, decisionById.get(row.deltaId)));
  const pendingSupersessions = preview.deltaRows.filter(row => row.role === 'SUPERSEDE_PENDING_EFFECT');
  const nextRevision = checked.command.expectedRevision + 1;
  const voucherRevisionId = officialVoucherRevisionIdV2(checked.contract.kind, checked.command.companyId,
    checked.command.documentId, nextRevision);
  const document = checked.action === OFFICIAL_REVISION_ACTION.CANCEL
    ? { ...clone(current.target.currentDocument), revision: nextRevision, status: 'CANCELLED', businessStatus: 'CANCELLED' }
    : { ...clone(checked.command.replacement.document), revision: nextRevision, status: 'CONFIRMED', businessStatus: 'CONFIRMED' };
  Object.assign(document, { commandId: checked.command.commandId, idempotencyKey: checked.command.idempotencyKey,
    updatedAt: checked.command.occurredAt, updatedBy: checked.command.actor });
  const afterInput = checked.action === OFFICIAL_REVISION_ACTION.CANCEL
    ? current.target.currentLines
    : checked.command.replacement.lines;
  const lines = afterInput.map(line => ({ ...clone(line), revision: nextRevision,
    status: checked.action === OFFICIAL_REVISION_ACTION.CANCEL ? 'CANCELLED' : 'CONFIRMED',
    lineStatus: checked.action === OFFICIAL_REVISION_ACTION.CANCEL ? 'CANCELLED' : 'ACTIVE',
    commandId: checked.command.commandId, updatedAt: checked.command.occurredAt, updatedBy: checked.command.actor }));
  const nextIds = new Set(lines.map(line => text(line[checked.contract.lineId])));
  const removedLines = checked.action === OFFICIAL_REVISION_ACTION.CANCEL ? [] : current.target.currentLines
    .filter(line => !nextIds.has(text(line[checked.contract.lineId])))
    .map(line => ({ ...clone(line), revision: nextRevision, status: 'DELETED', lineStatus: 'DELETED',
      commandId: checked.command.commandId, updatedAt: checked.command.occurredAt, updatedBy: checked.command.actor }));
  const lineById = new Map(lines.map(line => [text(line[checked.contract.lineId]), line]));
  const pendingCreations = preview.deltaRows.filter(row => row.role === 'CREATE_REVISED_PENDING_EFFECT').map(row => {
    const line = lineById.get(row.lineId);
    if (!line) throw new Error('ORDERQ_OFFICIAL_REVISION_PENDING_LINE_INVALID');
    return {
      pendingEffectId: `RPE-${canonicalSha256({ commandId: checked.command.commandId, deltaId: row.deltaId }).slice(0, 32)}`,
      deltaId: row.deltaId, companyId: row.companyId, warehouseId: row.warehouseId,
      unresolvedProductId: row.unresolvedProductId, sourceDocumentId: row.documentId,
      sourceLineId: row.lineId, sourceDocumentRevision: nextRevision, voucherMode: row.voucherMode,
      voucherRevisionId,
      effectiveAt: row.businessDate, businessDate: row.businessDate,
      businessOccurredAt: row.businessOccurredAt || '',
      signedQuantity: row.proposedSignedQuantity, quantity: Number(line.actualQuantity ?? line.quantity),
      status: 'PENDING_PRODUCT_MATCH', inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
      productCode: snapshotText(line.productSnapshot?.productCode || line.productCode),
      productName: snapshotText(line.productSnapshot?.productName || line.productName),
      originalProductCode: snapshotText(line.productSnapshot?.originalProductCode || line.originalProductCode),
      originalProductName: snapshotText(line.productSnapshot?.originalProductName || line.originalProductName),
      specification: snapshotText(line.productSnapshot?.specification || line.specification),
      unit: snapshotText(line.productSnapshot?.unit || line.unit || line.actualUnit),
      unitPrice: Number(line.unitPrice), totalAmount: Number(line.totalAmount),
      productSnapshot: clone(line.productSnapshot), productResolution: clone(line.officialProductResolution),
      commandId: checked.command.commandId, createdAt: checked.command.occurredAt
    };
  });
  const beforeStateByLine = stateByLineId(current.target);
  const movementByLine = new Map();
  movements.filter(row => row.effectRole === 'REVISION_AFTER_EFFECT').forEach(row => {
    if (!movementByLine.has(row.sourceLineId)) movementByLine.set(row.sourceLineId, []);
    movementByLine.get(row.sourceLineId).push(row);
  });
  const pendingByLine = new Map(pendingCreations.map(row => [row.sourceLineId, row]));
  const afterEffectiveLineStates = checked.action === OFFICIAL_REVISION_ACTION.CANCEL ? [] : lines.map(line => {
    const lineId = text(line[checked.contract.lineId]);
    const next = afterLineState(checked.contract, document, line);
    const before = beforeStateByLine.get(lineId);
    if (before && statesEqual(before, next)) return clone(before);
    return next.status === 'MATCHED'
      ? { ...next, activeInventoryEffects: clone(movementByLine.get(lineId) || []) }
      : { ...next, activePendingEffect: clone(pendingByLine.get(lineId)) };
  });
  const beforeSnapshot = deepFreeze({
    schemaVersion: OFFICIAL_REVISION_TARGET_SCHEMA_V2,
    document: clone(current.target.currentDocument), lines: clone(current.target.currentLines),
    effectiveLineStates: clone(current.target.effectiveLineStates)
  });
  document.lastVoucherRevisionId = voucherRevisionId;
  const afterSnapshot = deepFreeze({
    schemaVersion: OFFICIAL_REVISION_TARGET_SCHEMA_V2,
    document: clone(document), lines: clone(lines), effectiveLineStates: afterEffectiveLineStates
  });
  const voucherRevision = {
    voucherRevisionId, companyId: checked.command.companyId, voucherMode: checked.contract.mode,
    documentId: checked.command.documentId, revision: nextRevision, previousRevision: checked.command.expectedRevision,
    previousRevisionId: current.target.currentRevisionId, commandId: checked.command.commandId,
    idempotencyKey: checked.command.idempotencyKey, action: checked.action,
    status: checked.action === OFFICIAL_REVISION_ACTION.CANCEL ? 'CANCELLED' : 'CONFIRMED',
    beforeSnapshot, afterSnapshot, beforeDigest: canonicalSha256(beforeSnapshot), afterDigest: canonicalSha256(afterSnapshot),
    targetDigest: checked.command.targetDigest, deltaDigest: preview.deltaDigest,
    stocktakeDecisions: clone(decisions),
    effects: [
      ...movements.map(row => ({ type: 'INVENTORY', id: row.movementId, status: row.effectStatus,
        reversalStatus: row.reversalStatus, stocktakeEffectStatus: row.stocktakeEffectStatus,
        officialInventoryApplied: row.officialInventoryApplied, effectRole: row.effectRole,
        signedQuantity: row.signedQuantity, originalSignedQuantity: row.originalSignedQuantity })),
      ...pendingSupersessions.map(row => ({ type: 'PENDING_INVENTORY', id: row.sourceEffectId,
        status: checked.action === OFFICIAL_REVISION_ACTION.CANCEL ? 'CANCELLED_BY_REVISION' : 'SUPERSEDED_BY_REVISION' })),
      ...pendingCreations.map(row => ({ type: 'UNRESOLVED_PRODUCT_REVIEW', id: row.pendingEffectId,
        status: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false }))
    ],
    partnerEffectDecision: { status: 'UNCHANGED_UNSUPPORTED_SCOPE', entryIds: [] },
    reason: checked.command.reason, actor: checked.command.actor, occurredAt: checked.command.occurredAt
  };
  return deepFreeze({ schemaVersion: OFFICIAL_REVISION_PLAN_SCHEMA_V2, command: checked.command,
    kind: checked.contract.kind, action: checked.action, document, lines, removedLines,
    inventoryMovements: movements, pendingSupersessions, pendingCreations,
    voucherRevision, deltaRows: preview.deltaRows, stocktakeDecisions: decisions });
}
