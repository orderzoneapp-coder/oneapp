import { evaluateStocktakeCheckpointConflictV2 } from './stocktake-conflict-v2.js?v=0.2.0';

export const UNRESOLVED_REVIEW_READ_MODEL_SCHEMA = 'ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_MODEL_V1';
export const UNRESOLVED_REMATCH_IMPACT_SCHEMA = 'ONEAPP_ORDERQ_UNRESOLVED_REMATCH_IMPACT_PREVIEW_V1';

export const UNRESOLVED_REVIEW_STATUS = Object.freeze({
  READY: 'READY',
  EMPTY: 'EMPTY',
  ERROR: 'ERROR'
});

export const UNRESOLVED_REVIEW_INTEGRITY = Object.freeze({
  READY: 'READY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

export const UNRESOLVED_REMATCH_IMPACT_STATUS = Object.freeze({
  APPLY_READY: 'APPLY_READY',
  DECISION_REQUIRED: 'DECISION_REQUIRED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ALLOWED_SORT_FIELDS = new Set([
  'businessDate',
  'updatedAt',
  'productCode',
  'productName',
  'signedQuantity',
  'linkCount',
  'unresolvedProductId'
]);

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const exactText = value => String(value ?? '').trim();
const normalizedReviewText = value => exactText(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function requiredCompanyId(value) {
  const companyId = exactText(value);
  if (!companyId) throw new Error('ORDERQ_UNRESOLVED_REVIEW_COMPANY_REQUIRED');
  return companyId;
}

function finiteOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(typeof value === 'string' ? value.replace(/,/g, '').trim() : value);
  return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : null;
}

function productIdOf(row = {}) {
  return exactText(row.productId || row.masterProductId);
}

function productCodeOf(row = {}) {
  return exactText(row.itemCode || row.productCode || row['코드'] || row['품목코드']
    || row.raw?.['코드'] || row.raw?.['품목코드']);
}

function productNameOf(row = {}) {
  return exactText(row.itemName || row.productName || row['품목명'] || row.name
    || row.raw?.['품목명']);
}

function productSpecificationOf(row = {}) {
  return exactText(row.specification || row['규격'] || row.raw?.['규격']);
}

function productUnitOf(row = {}) {
  return exactText(row.unit || row.finalUnit || row.actualUnit || row['단위'] || row.raw?.['단위']);
}

function activeProduct(row = {}) {
  return row.active !== false
    && !['INACTIVE', 'DELETED'].includes(exactText(row.status || 'ACTIVE').toUpperCase())
    && exactText(row.productIdentityType).toUpperCase() !== 'TEMPORARY';
}

function productInCompanyScope(row = {}, companyId) {
  const rowCompanyId = exactText(row.companyId);
  return !rowCompanyId || rowCompanyId === companyId;
}

function compareText(left, right) {
  const a = exactText(left);
  const b = exactText(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function documentIdOf(mode, row = {}) {
  return exactText(row.sourceDocumentId || row.documentId
    || (mode === 'purchase' ? row.purchaseDocumentId : row.salesDocumentId));
}

function lineIdOf(mode, row = {}) {
  return exactText(row.sourceLineId || row.lineId
    || (mode === 'purchase' ? row.purchaseLineId : row.salesLineId));
}

function documentBusinessDate(document = {}) {
  const source = document || {};
  return exactText(source.businessDate || source.purchaseDate || source.saleDate || source.salesDate
    || source.voucherDate);
}

function traceHref(mode, businessDate, documentId) {
  if (!['purchase', 'sale'].includes(mode) || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !documentId) return '';
  return `../orderq/voucher-query.html?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(businessDate)}&focus=${encodeURIComponent(documentId)}`;
}

function buildSourceMaps(source = {}) {
  return {
    purchaseDocuments: new Map((source.purchaseDocuments || []).map(row => [exactText(row.purchaseDocumentId), row])),
    saleDocuments: new Map((source.salesDocuments || []).map(row => [exactText(row.salesDocumentId), row])),
    purchaseLines: new Map((source.purchaseLines || []).map(row => [exactText(row.purchaseLineId), row])),
    saleLines: new Map((source.salesLines || []).map(row => [exactText(row.salesLineId), row])),
    revisions: new Map((source.voucherRevisions || []).map(row => [exactText(row.voucherRevisionId), row]))
  };
}

function addIssue(issues, code, detail = '') {
  if (!issues.some(issue => issue.code === code && issue.detail === detail)) issues.push({ code, detail });
}

const hasOwn = (source, key) => Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);

function firstOwnEvidence(...pairs) {
  for (const [source, key] of pairs) {
    if (hasOwn(source, key)) return { present: true, value: source[key] };
  }
  return { present: false, value: undefined };
}

function comparableValue(value, type) {
  if (type === 'number') return finiteOrNull(value);
  if (type === 'boolean') return value === true ? 'true' : value === false ? 'false' : exactText(value).toLowerCase();
  if (type === 'mode') return exactText(value).toLowerCase();
  return exactText(value);
}

function linkEvidenceMismatchFields({ unresolvedRecord, reviewLink, pendingEffect }) {
  if (!reviewLink || !pendingEffect) return [];
  const reviewSnapshot = reviewLink.productSnapshot || {};
  const pendingSnapshot = pendingEffect.productSnapshot || {};
  const fields = [
    ['companyId', 'text', firstOwnEvidence([reviewLink, 'companyId'], [unresolvedRecord, 'companyId']),
      firstOwnEvidence([pendingEffect, 'companyId'])],
    ['unresolvedProductId', 'text', firstOwnEvidence([reviewLink, 'unresolvedProductId'], [unresolvedRecord, 'unresolvedProductId']),
      firstOwnEvidence([pendingEffect, 'unresolvedProductId'])],
    ['voucherMode', 'mode', firstOwnEvidence([reviewLink, 'voucherMode']), firstOwnEvidence([pendingEffect, 'voucherMode'])],
    ['sourceDocumentId', 'text', firstOwnEvidence([reviewLink, 'sourceDocumentId'], [reviewLink, 'documentId']),
      firstOwnEvidence([pendingEffect, 'sourceDocumentId'], [pendingEffect, 'documentId'])],
    ['sourceLineId', 'text', firstOwnEvidence([reviewLink, 'sourceLineId'], [reviewLink, 'lineId']),
      firstOwnEvidence([pendingEffect, 'sourceLineId'], [pendingEffect, 'lineId'])],
    ['sourceDocumentRevision', 'number', firstOwnEvidence([reviewLink, 'sourceDocumentRevision']),
      firstOwnEvidence([pendingEffect, 'sourceDocumentRevision'])],
    ['voucherRevisionId', 'text', firstOwnEvidence([reviewLink, 'voucherRevisionId']),
      firstOwnEvidence([pendingEffect, 'voucherRevisionId'])],
    ['commandId', 'text', firstOwnEvidence([reviewLink, 'commandId']), firstOwnEvidence([pendingEffect, 'commandId'])],
    ['warehouseId', 'text', firstOwnEvidence([reviewLink, 'warehouseId']), firstOwnEvidence([pendingEffect, 'warehouseId'])],
    ['businessDate', 'text', firstOwnEvidence([reviewLink, 'businessDate'], [reviewLink, 'effectiveAt']),
      firstOwnEvidence([pendingEffect, 'effectiveAt'], [pendingEffect, 'businessDate'])],
    ['businessOccurredAt', 'text', firstOwnEvidence([reviewLink, 'businessOccurredAt']),
      firstOwnEvidence([pendingEffect, 'businessOccurredAt'])],
    ['quantity', 'number', firstOwnEvidence([reviewLink, 'quantity']), firstOwnEvidence([pendingEffect, 'quantity'])],
    ['signedQuantity', 'number', firstOwnEvidence([reviewLink, 'signedQuantity']),
      firstOwnEvidence([pendingEffect, 'signedQuantity'])],
    ['unitPrice', 'number', firstOwnEvidence([reviewLink, 'unitPrice']), firstOwnEvidence([pendingEffect, 'unitPrice'])],
    ['totalAmount', 'number', firstOwnEvidence([reviewLink, 'totalAmount']), firstOwnEvidence([pendingEffect, 'totalAmount'])],
    ['inventoryEffectStatus', 'text', firstOwnEvidence([reviewLink, 'inventoryEffectStatus']),
      firstOwnEvidence([pendingEffect, 'inventoryEffectStatus'])],
    ['officialInventoryApplied', 'boolean', firstOwnEvidence([reviewLink, 'officialInventoryApplied']),
      firstOwnEvidence([pendingEffect, 'officialInventoryApplied'])],
    ['originalProductCode', 'text', firstOwnEvidence([reviewLink, 'originalProductCode'], [reviewSnapshot, 'originalProductCode'],
      [reviewLink, 'productCode'], [reviewSnapshot, 'productCode']),
    firstOwnEvidence([pendingEffect, 'originalProductCode'], [pendingSnapshot, 'originalProductCode'],
      [pendingEffect, 'productCode'], [pendingSnapshot, 'productCode'])],
    ['originalProductName', 'text', firstOwnEvidence([reviewLink, 'originalProductName'], [reviewSnapshot, 'originalProductName'],
      [reviewLink, 'productName'], [reviewSnapshot, 'productName']),
    firstOwnEvidence([pendingEffect, 'originalProductName'], [pendingSnapshot, 'originalProductName'],
      [pendingEffect, 'productName'], [pendingSnapshot, 'productName'])],
    ['specification', 'text', firstOwnEvidence([reviewLink, 'specification'], [reviewSnapshot, 'specification']),
      firstOwnEvidence([pendingEffect, 'specification'], [pendingSnapshot, 'specification'])],
    ['unit', 'text', firstOwnEvidence([reviewLink, 'unit'], [reviewSnapshot, 'unit']),
      firstOwnEvidence([pendingEffect, 'unit'], [pendingSnapshot, 'unit'])]
  ];
  return fields.filter(([, type, review, pending]) => review.present && pending.present
    && comparableValue(review.value, type) !== comparableValue(pending.value, type))
    .map(([field]) => field);
}

function linkedRecord({ companyId, unresolvedProductId, unresolvedRecord, pendingEffect, reviewLink, maps }) {
  const issues = [];
  if (!unresolvedRecord) addIssue(issues, 'UNRESOLVED_RECORD_MISSING');
  if (!pendingEffect) addIssue(issues, 'PENDING_EFFECT_MISSING');
  if (unresolvedRecord && !exactText(unresolvedRecord.unresolvedProductId)) {
    addIssue(issues, 'UNRESOLVED_PRODUCT_ID_MISSING');
  }
  if (pendingEffect && !exactText(pendingEffect.unresolvedProductId)) {
    addIssue(issues, 'PENDING_EFFECT_UNRESOLVED_ID_MISSING');
  }

  const reviewLinkCompanyId = firstOwnEvidence([reviewLink, 'companyId']);
  const reviewLinkUnresolvedId = firstOwnEvidence([reviewLink, 'unresolvedProductId']);
  const reviewLinkCompanyMismatch = reviewLinkCompanyId.present && exactText(reviewLinkCompanyId.value) !== companyId;
  const reviewLinkUnresolvedMismatch = reviewLinkUnresolvedId.present
    && exactText(reviewLinkUnresolvedId.value) !== unresolvedProductId;
  if (reviewLinkCompanyMismatch) addIssue(issues, 'REVIEW_LINK_COMPANY_MISMATCH');
  if (reviewLinkUnresolvedMismatch) addIssue(issues, 'REVIEW_LINK_UNRESOLVED_ID_MISMATCH');
  linkEvidenceMismatchFields({ unresolvedRecord, reviewLink, pendingEffect }).forEach(field => {
    addIssue(issues, 'REVIEW_LINK_PENDING_EFFECT_FIELD_MISMATCH', field);
  });

  const safeReviewLink = reviewLinkCompanyMismatch || reviewLinkUnresolvedMismatch
    ? {
      pendingEffectId: reviewLink?.pendingEffectId,
      voucherMode: reviewLink?.voucherMode,
      sourceDocumentId: reviewLink?.sourceDocumentId,
      sourceLineId: reviewLink?.sourceLineId,
      sourceDocumentRevision: reviewLink?.sourceDocumentRevision,
      voucherRevisionId: reviewLink?.voucherRevisionId
    }
    : reviewLink;
  const combined = { ...clone(safeReviewLink || {}), ...clone(pendingEffect || {}) };
  const pendingEffectId = exactText(combined.pendingEffectId);
  if (!pendingEffectId) addIssue(issues, 'PENDING_EFFECT_ID_MISSING');
  if (pendingEffect && exactText(pendingEffect.companyId) !== companyId) addIssue(issues, 'PENDING_EFFECT_COMPANY_MISMATCH');
  if (pendingEffect && exactText(pendingEffect.unresolvedProductId) !== unresolvedProductId) {
    addIssue(issues, 'PENDING_EFFECT_UNRESOLVED_ID_MISMATCH');
  }
  if (pendingEffect && exactText(pendingEffect.status).toUpperCase() !== 'PENDING_PRODUCT_MATCH') {
    addIssue(issues, 'PENDING_EFFECT_STATUS_INVALID', exactText(pendingEffect.status));
  }
  if (pendingEffect && (pendingEffect.officialInventoryApplied !== false
    || exactText(pendingEffect.inventoryEffectStatus).toUpperCase() !== 'UNRESOLVED_PRODUCT')) {
    addIssue(issues, 'OFFICIAL_INVENTORY_STATE_INVALID');
  }

  const voucherMode = exactText(combined.voucherMode).toLowerCase();
  if (!['purchase', 'sale'].includes(voucherMode)) addIssue(issues, 'VOUCHER_MODE_INVALID', voucherMode);
  const documentId = documentIdOf(voucherMode, combined);
  const sourceLineId = lineIdOf(voucherMode, combined);
  const voucherRevisionId = exactText(combined.voucherRevisionId);
  if (!documentId) addIssue(issues, 'SOURCE_DOCUMENT_ID_MISSING');
  if (!sourceLineId) addIssue(issues, 'SOURCE_LINE_ID_MISSING');
  if (!voucherRevisionId) addIssue(issues, 'VOUCHER_REVISION_ID_MISSING');

  const rawDocument = voucherMode === 'purchase'
    ? maps.purchaseDocuments.get(documentId)
    : maps.saleDocuments.get(documentId);
  const rawLine = voucherMode === 'purchase'
    ? maps.purchaseLines.get(sourceLineId)
    : maps.saleLines.get(sourceLineId);
  const rawRevision = maps.revisions.get(voucherRevisionId);

  const documentCompanyMismatch = Boolean(rawDocument) && exactText(rawDocument.companyId) !== companyId;
  const documentNotConfirmed = Boolean(rawDocument) && !documentCompanyMismatch
    && exactText(rawDocument.status).toUpperCase() !== 'CONFIRMED';
  if (documentId && !rawDocument) addIssue(issues, 'SOURCE_DOCUMENT_MISSING', documentId);
  if (documentCompanyMismatch) {
    addIssue(issues, 'SOURCE_DOCUMENT_COMPANY_MISMATCH', documentId);
  }
  if (documentNotConfirmed) {
    addIssue(issues, 'SOURCE_DOCUMENT_NOT_CONFIRMED', exactText(rawDocument.status));
  }
  const document = rawDocument && !documentCompanyMismatch && !documentNotConfirmed ? rawDocument : null;

  const lineCompanyMismatch = Boolean(rawLine) && exactText(rawLine.companyId) !== companyId;
  const lineDocumentMismatch = Boolean(rawLine) && !lineCompanyMismatch
    && documentIdOf(voucherMode, rawLine) !== documentId;
  if (sourceLineId && !rawLine) addIssue(issues, 'SOURCE_LINE_MISSING', sourceLineId);
  if (lineCompanyMismatch) addIssue(issues, 'SOURCE_LINE_COMPANY_MISMATCH', sourceLineId);
  if (lineDocumentMismatch) addIssue(issues, 'SOURCE_LINE_DOCUMENT_MISMATCH', sourceLineId);
  const line = rawLine && !lineCompanyMismatch && !lineDocumentMismatch ? rawLine : null;

  const revisionCompanyMismatch = Boolean(rawRevision) && exactText(rawRevision.companyId) !== companyId;
  const revisionDocumentMismatch = Boolean(rawRevision) && !revisionCompanyMismatch
    && exactText(rawRevision.documentId) !== documentId;
  const revisionNotConfirmed = Boolean(rawRevision) && !revisionCompanyMismatch
    && exactText(rawRevision.status).toUpperCase() !== 'CONFIRMED';
  if (voucherRevisionId && !rawRevision) addIssue(issues, 'VOUCHER_REVISION_MISSING', voucherRevisionId);
  if (revisionCompanyMismatch) {
    addIssue(issues, 'VOUCHER_REVISION_COMPANY_MISMATCH', voucherRevisionId);
  }
  if (revisionDocumentMismatch) {
    addIssue(issues, 'VOUCHER_REVISION_DOCUMENT_MISMATCH', voucherRevisionId);
  }
  if (revisionNotConfirmed) {
    addIssue(issues, 'VOUCHER_REVISION_NOT_CONFIRMED', exactText(rawRevision.status));
  }
  const revision = rawRevision && !revisionCompanyMismatch && !revisionDocumentMismatch && !revisionNotConfirmed
    ? rawRevision : null;
  const sourceDocumentRevision = finiteOrNull(combined.sourceDocumentRevision);
  if (sourceDocumentRevision === null) addIssue(issues, 'SOURCE_DOCUMENT_REVISION_MISSING');
  if (document && sourceDocumentRevision !== null
    && finiteOrNull(document.revision) !== sourceDocumentRevision) {
    addIssue(issues, 'SOURCE_DOCUMENT_REVISION_MISMATCH', documentId);
  }
  if (revision && finiteOrNull(combined.sourceDocumentRevision) !== null
    && finiteOrNull(revision.revision) !== finiteOrNull(combined.sourceDocumentRevision)) {
    addIssue(issues, 'VOUCHER_REVISION_NUMBER_MISMATCH', voucherRevisionId);
  }

  const productSnapshot = clone(combined.productSnapshot || line?.productSnapshot || {});
  const originalProductCode = exactText(combined.originalProductCode ?? productSnapshot.originalProductCode
    ?? line?.originalProductCode ?? combined.productCode ?? productSnapshot.productCode ?? line?.productCode);
  const originalProductName = exactText(combined.originalProductName ?? productSnapshot.originalProductName
    ?? line?.originalProductName ?? combined.productName ?? productSnapshot.productName ?? line?.productName);
  const specification = exactText(combined.specification || productSnapshot.specification || line?.specification);
  const unit = exactText(combined.unit || productSnapshot.unit || line?.unit || line?.actualUnit);
  const warehouseId = exactText(combined.warehouseId || line?.warehouseId || document?.warehouseId);
  const businessDate = exactText(combined.effectiveAt || combined.businessDate || documentBusinessDate(document));
  const businessOccurredAt = exactText(combined.businessOccurredAt || line?.businessOccurredAt
    || document?.businessOccurredAt || document?.businessEffectiveAt);
  const inputQuantity = finiteOrNull(combined.quantity ?? line?.actualQuantity ?? line?.quantity);
  const signedQuantity = finiteOrNull(combined.signedQuantity);
  if (inputQuantity === null) addIssue(issues, 'INPUT_QUANTITY_INVALID');
  if (signedQuantity === null) addIssue(issues, 'SIGNED_QUANTITY_INVALID');
  if (!warehouseId) addIssue(issues, 'WAREHOUSE_ID_MISSING');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) addIssue(issues, 'BUSINESS_DATE_INVALID', businessDate);

  const integrityStatus = issues.length
    ? UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED
    : UNRESOLVED_REVIEW_INTEGRITY.READY;

  return {
    pendingEffectId,
    unresolvedProductId,
    companyId,
    originalProductCode,
    originalProductName,
    specification,
    unit,
    warehouseId,
    businessDate,
    businessOccurredAt,
    inputQuantity,
    signedQuantity,
    unitPrice: finiteOrNull(combined.unitPrice),
    totalAmount: finiteOrNull(combined.totalAmount),
    officialInventory: {
      status: 'NOT_APPLIED',
      label: '미반영',
      officialQuantity: null,
      unappliedSignedQuantity: signedQuantity
    },
    sourceVoucher: {
      voucherMode,
      documentId,
      lineId: sourceLineId,
      documentRevision: sourceDocumentRevision,
      revisionId: voucherRevisionId,
      commandId: exactText(combined.commandId),
      detailHref: traceHref(voucherMode, businessDate, documentId)
    },
    productSnapshot,
    integrity: { status: integrityStatus, issues }
  };
}

function sourceLinkEntries(unresolvedRecord, pendingEffects) {
  const entries = new Map();
  (unresolvedRecord?.reviewLinks || []).forEach((reviewLink, index) => {
    const pendingEffectId = exactText(reviewLink?.pendingEffectId);
    const key = pendingEffectId || `REVIEW_LINK_WITHOUT_ID:${index}`;
    entries.set(key, { reviewLink, pendingEffect: null });
  });
  pendingEffects.forEach((pendingEffect, index) => {
    const pendingEffectId = exactText(pendingEffect?.pendingEffectId);
    const key = pendingEffectId || `PENDING_EFFECT_WITHOUT_ID:${index}`;
    const prior = entries.get(key) || {};
    entries.set(key, { ...prior, pendingEffect });
  });
  return [...entries.values()];
}

function aggregateItem({ companyId, unresolvedProductId, unresolvedRecord, pendingEffects, maps }) {
  const links = sourceLinkEntries(unresolvedRecord, pendingEffects)
    .map(entry => linkedRecord({ companyId, unresolvedProductId, unresolvedRecord, maps, ...entry }))
    .sort((left, right) => compareText(left.businessDate, right.businessDate)
      || compareText(left.sourceVoucher.voucherMode, right.sourceVoucher.voucherMode)
      || compareText(left.sourceVoucher.documentId, right.sourceVoucher.documentId)
      || compareText(left.sourceVoucher.lineId, right.sourceVoucher.lineId)
      || compareText(left.pendingEffectId, right.pendingEffectId));
  const first = links[0] || {};
  const originalProductCode = exactText(unresolvedRecord?.originalProductCode ?? unresolvedRecord?.productCode
    ?? first.originalProductCode);
  const originalProductName = exactText(unresolvedRecord?.originalProductName ?? unresolvedRecord?.productName
    ?? first.originalProductName);
  const specification = exactText(unresolvedRecord?.specification || first.specification);
  const unit = exactText(unresolvedRecord?.unit || first.unit);
  const inputQuantities = links.map(link => link.inputQuantity).filter(value => value !== null);
  const signedQuantities = links.map(link => link.signedQuantity).filter(value => value !== null);
  const issueRows = links.flatMap(link => link.integrity.issues.map(issue => ({ ...issue, pendingEffectId: link.pendingEffectId })));
  if (!links.length) issueRows.push({ code: 'REVIEW_LINK_MISSING', detail: '', pendingEffectId: '' });
  if (unresolvedRecord && !exactText(unresolvedRecord.unresolvedProductId)) {
    issueRows.push({ code: 'UNRESOLVED_PRODUCT_ID_MISSING', detail: '', pendingEffectId: '' });
  }
  const integrityStatus = issueRows.length
    ? UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED
    : UNRESOLVED_REVIEW_INTEGRITY.READY;
  const unique = field => new Set(links.map(link => exactText(field(link))).filter(Boolean)).size;
  const businessDates = links.map(link => link.businessDate).filter(Boolean).sort(compareText);
  return {
    unresolvedProductId,
    companyId,
    status: 'UNRESOLVED_PRODUCT',
    originalProductCode,
    originalProductName,
    specification,
    unit,
    officialInventory: {
      status: 'NOT_APPLIED',
      label: '미반영',
      officialQuantity: null,
      unappliedSignedQuantity: signedQuantities.reduce((sum, value) => sum + value, 0)
    },
    aggregate: {
      linkCount: links.length,
      documentCount: unique(link => link.sourceVoucher.documentId
        ? `${link.sourceVoucher.voucherMode}:${link.sourceVoucher.documentId}` : ''),
      lineCount: unique(link => link.sourceVoucher.lineId
        ? `${link.sourceVoucher.voucherMode}:${link.sourceVoucher.lineId}` : ''),
      revisionCount: unique(link => link.sourceVoucher.revisionId),
      inputQuantityTotal: inputQuantities.reduce((sum, value) => sum + value, 0),
      signedQuantityTotal: signedQuantities.reduce((sum, value) => sum + value, 0),
      warehouseIds: [...new Set(links.map(link => link.warehouseId).filter(Boolean))].sort(compareText),
      businessDates: [...new Set(businessDates)]
    },
    links,
    candidates: [],
    candidateNotice: '검수 참고용이며 자동확정 아님',
    integrity: { status: integrityStatus, issues: issueRows },
    createdAt: exactText(unresolvedRecord?.createdAt || pendingEffects[0]?.createdAt),
    updatedAt: exactText(unresolvedRecord?.updatedAt || pendingEffects.at(-1)?.createdAt),
    firstBusinessDate: businessDates[0] || ''
  };
}

function productCandidates(item, productSnapshot, { includeNameCandidates = true, candidateLimit = 20 } = {}) {
  const rows = productSnapshot?.status === 'READY' && Array.isArray(productSnapshot.data?.products)
    ? productSnapshot.data.products : [];
  const companyRows = rows.filter(row => productInCompanyScope(row, item.companyId) && activeProduct(row));
  const code = exactText(item.originalProductCode);
  const exactCodeRows = code ? companyRows.filter(row => productCodeOf(row) === code) : [];
  const candidates = exactCodeRows.map(row => ({
    productId: productIdOf(row),
    companyId: exactText(row.companyId) || item.companyId,
    productCode: productCodeOf(row),
    productName: productNameOf(row),
    specification: productSpecificationOf(row),
    unit: productUnitOf(row),
    matchBasis: exactCodeRows.length === 1 && productIdOf(row)
      ? 'EXACT_COMPANY_PRODUCT_CODE'
      : 'EXACT_COMPANY_PRODUCT_CODE_AMBIGUOUS',
    exactCandidate: exactCodeRows.length === 1 && Boolean(productIdOf(row)),
    selectable: Boolean(productIdOf(row)),
    automaticConfirmation: false,
    reason: '검수 참고용이며 자동확정 아님'
  }));

  if (includeNameCandidates) {
    const name = normalizedReviewText(item.originalProductName);
    if (name) {
      companyRows.filter(row => normalizedReviewText(productNameOf(row)) === name)
        .filter(row => !candidates.some(candidate => candidate.productId === productIdOf(row)))
        .forEach(row => candidates.push({
          productId: productIdOf(row),
          companyId: exactText(row.companyId) || item.companyId,
          productCode: productCodeOf(row),
          productName: productNameOf(row),
          specification: productSpecificationOf(row),
          unit: productUnitOf(row),
          matchBasis: 'EXACT_PRODUCT_NAME_REFERENCE_ONLY',
          exactCandidate: false,
          selectable: Boolean(productIdOf(row)),
          automaticConfirmation: false,
          reason: '품명 후보는 읽기 전용 검수 참고이며 자동확정 아님'
        }));
    }
  }

  return candidates.sort((left, right) => Number(right.exactCandidate) - Number(left.exactCandidate)
    || compareText(left.productCode, right.productCode)
    || compareText(left.productId, right.productId))
    .slice(0, Math.max(0, Math.min(MAX_LIMIT, Number(candidateLimit) || 0)));
}

function normalizeQuery(query = {}) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(page) || page < 1) throw new Error('ORDERQ_UNRESOLVED_REVIEW_PAGE_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('ORDERQ_UNRESOLVED_REVIEW_LIMIT_INVALID');
  const sort = typeof query.sort === 'string'
    ? { field: query.sort, direction: query.direction }
    : { ...(query.sort || {}) };
  const field = exactText(sort.field || 'businessDate');
  const direction = exactText(sort.direction || 'asc').toLowerCase();
  if (!ALLOWED_SORT_FIELDS.has(field)) throw new Error('ORDERQ_UNRESOLVED_REVIEW_SORT_INVALID');
  if (!['asc', 'desc'].includes(direction)) throw new Error('ORDERQ_UNRESOLVED_REVIEW_SORT_DIRECTION_INVALID');
  return {
    page,
    limit,
    sort: { field, direction },
    filters: clone(query.filters || {}),
    includeNameCandidates: query.includeNameCandidates !== false,
    candidateLimit: Math.max(0, Math.min(MAX_LIMIT, Number(query.candidateLimit ?? 20) || 0))
  };
}

function itemMatchesFilters(item, filters = {}) {
  const unresolvedProductId = exactText(filters.unresolvedProductId);
  if (unresolvedProductId && item.unresolvedProductId !== unresolvedProductId) return false;
  const productCode = exactText(filters.productCode);
  if (productCode && item.originalProductCode !== productCode) return false;
  const productName = normalizedReviewText(filters.productName);
  if (productName && !normalizedReviewText(item.originalProductName).includes(productName)) return false;
  const warehouseId = exactText(filters.warehouseId);
  if (warehouseId && !item.aggregate.warehouseIds.includes(warehouseId)) return false;
  const voucherMode = exactText(filters.voucherMode).toLowerCase();
  if (voucherMode && !item.links.some(link => link.sourceVoucher.voucherMode === voucherMode)) return false;
  const integrityStatus = exactText(filters.integrityStatus).toUpperCase();
  if (integrityStatus && item.integrity.status !== integrityStatus) return false;
  const from = exactText(filters.businessDateFrom);
  const to = exactText(filters.businessDateTo);
  if ((from || to) && !item.aggregate.businessDates.some(date => (!from || date >= from) && (!to || date <= to))) {
    return false;
  }
  return true;
}

function sortValue(item, field) {
  if (field === 'businessDate') return item.firstBusinessDate;
  if (field === 'updatedAt') return item.updatedAt;
  if (field === 'productCode') return item.originalProductCode;
  if (field === 'productName') return item.originalProductName;
  if (field === 'signedQuantity') return item.aggregate.signedQuantityTotal;
  if (field === 'linkCount') return item.aggregate.linkCount;
  return item.unresolvedProductId;
}

function compareItems(left, right, sort) {
  const a = sortValue(left, sort.field);
  const b = sortValue(right, sort.field);
  const ordered = typeof a === 'number' && typeof b === 'number' ? a - b : compareText(a, b);
  return (sort.direction === 'desc' ? -ordered : ordered)
    || compareText(left.unresolvedProductId, right.unresolvedProductId);
}

function buildAllItems({ companyId, source = {} }) {
  const maps = buildSourceMaps(source);
  const unresolvedRows = (source.unresolvedProducts || []).filter(row => exactText(row.companyId) === companyId
    && ['UNRESOLVED_PRODUCT', 'UNRESOLVED'].includes(exactText(row.status).toUpperCase()));
  const pendingRows = (source.pendingInventoryEffects || []).filter(row => exactText(row.companyId) === companyId
    && exactText(row.status).toUpperCase() === 'PENDING_PRODUCT_MATCH');
  const missingId = (row, index, sourceType) => {
    const pendingEffectId = exactText(row.pendingEffectId || row.reviewLinks?.[0]?.pendingEffectId);
    const trace = pendingEffectId || [sourceType, documentIdOf(exactText(row.voucherMode).toLowerCase(), row),
      lineIdOf(exactText(row.voucherMode).toLowerCase(), row), index].filter(value => value !== '').join(':');
    return `MISSING_UNRESOLVED_PRODUCT_ID:${trace}`;
  };
  const unresolvedById = new Map(unresolvedRows.map((row, index) => [
    exactText(row.unresolvedProductId) || missingId(row, index, 'UNRESOLVED_RECORD'), row
  ]));
  const pendingByUnresolved = new Map();
  pendingRows.forEach((row, index) => {
    const id = exactText(row.unresolvedProductId) || missingId(row, index, 'PENDING_EFFECT');
    if (!pendingByUnresolved.has(id)) pendingByUnresolved.set(id, []);
    pendingByUnresolved.get(id).push(row);
  });
  const ids = [...new Set([...unresolvedById.keys(), ...pendingByUnresolved.keys()].filter(Boolean))].sort(compareText);
  return ids.map(unresolvedProductId => aggregateItem({
    companyId,
    unresolvedProductId,
    unresolvedRecord: unresolvedById.get(unresolvedProductId),
    pendingEffects: pendingByUnresolved.get(unresolvedProductId) || [],
    maps
  }));
}

export function buildUnresolvedReviewReadModel({ companyId: requestedCompanyId, source = {}, productSnapshot = null, query = {}, generatedAt } = {}) {
  const companyId = requiredCompanyId(requestedCompanyId);
  const normalized = normalizeQuery(query);
  const allItems = buildAllItems({ companyId, source });
  const filtered = allItems.filter(item => itemMatchesFilters(item, normalized.filters))
    .sort((left, right) => compareItems(left, right, normalized.sort));
  const offset = (normalized.page - 1) * normalized.limit;
  const items = filtered.slice(offset, offset + normalized.limit).map(item => ({
    ...item,
    candidates: productCandidates(item, productSnapshot, normalized)
  }));
  const totalPages = filtered.length ? Math.ceil(filtered.length / normalized.limit) : 0;
  return deepFreeze({
    schemaVersion: UNRESOLVED_REVIEW_READ_MODEL_SCHEMA,
    ownerAppId: 'orderq-vnext',
    companyId,
    status: filtered.length ? UNRESOLVED_REVIEW_STATUS.READY : UNRESOLVED_REVIEW_STATUS.EMPTY,
    emptyReason: filtered.length ? null : allItems.length ? 'NO_MATCHING_FILTER' : 'NO_UNRESOLVED_RECORDS',
    generatedAt: exactText(generatedAt) || new Date().toISOString(),
    officialInventoryPresentation: {
      status: 'NOT_APPLIED',
      label: '미반영',
      officialQuantityValue: null,
      separateFromUnappliedQuantity: true
    },
    query: normalized,
    page: {
      number: normalized.page,
      limit: normalized.limit,
      totalItems: filtered.length,
      totalPages,
      returnedItems: items.length,
      hasPrevious: normalized.page > 1,
      hasNext: normalized.page < totalPages
    },
    integrity: {
      reviewRequiredItems: filtered.filter(item => item.integrity.status === UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED).length
    },
    items
  });
}

function selectedProductSnapshot(selectedProduct = {}, companyId) {
  const productId = productIdOf(selectedProduct);
  const productCode = productCodeOf(selectedProduct);
  if (!productId) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_ID_REQUIRED');
  if (!productCode) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_CODE_REQUIRED');
  const selectedCompanyId = exactText(selectedProduct.companyId);
  if (selectedCompanyId && selectedCompanyId !== companyId) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_PRODUCT_COMPANY_MISMATCH');
  return {
    productId,
    productCode,
    productName: productNameOf(selectedProduct),
    specification: productSpecificationOf(selectedProduct),
    unit: productUnitOf(selectedProduct),
    companyId
  };
}

export function previewUnresolvedRematchImpact({
  companyId: requestedCompanyId,
  unresolvedProductId: requestedUnresolvedProductId,
  selectedProduct = {},
  source = {},
  generatedAt
} = {}) {
  const companyId = requiredCompanyId(requestedCompanyId);
  const unresolvedProductId = exactText(requestedUnresolvedProductId);
  if (!unresolvedProductId) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_ID_REQUIRED');
  const target = selectedProductSnapshot(selectedProduct, companyId);
  const item = buildAllItems({ companyId, source }).find(row => row.unresolvedProductId === unresolvedProductId);
  if (!item) throw new Error('ORDERQ_UNRESOLVED_PREVIEW_NOT_FOUND');
  const checkpoints = Array.isArray(source.inventoryCheckpoints) ? source.inventoryCheckpoints : [];
  const impacts = item.links.map(link => {
    if (link.integrity.status === UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED) {
      return {
        pendingEffectId: link.pendingEffectId,
        status: UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED,
        reason: 'SOURCE_LINK_REVIEW_REQUIRED',
        sourceVoucher: link.sourceVoucher,
        warehouseId: link.warehouseId,
        businessDate: link.businessDate,
        inputQuantity: link.inputQuantity,
        signedQuantity: link.signedQuantity,
        checkpoint: null,
        integrity: link.integrity
      };
    }
    let assessment;
    try {
      assessment = evaluateStocktakeCheckpointConflictV2({
        companyId,
        productId: target.productId,
        productCode: target.productCode,
        warehouseId: link.warehouseId,
        businessDate: link.businessDate,
        businessOccurredAt: link.businessOccurredAt,
        inventoryCheckpoints: checkpoints
      });
    } catch (error) {
      return {
        pendingEffectId: link.pendingEffectId,
        status: UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED,
        reason: exactText(error?.message) || 'STOCKTAKE_PREVIEW_FAILED',
        sourceVoucher: link.sourceVoucher,
        warehouseId: link.warehouseId,
        businessDate: link.businessDate,
        inputQuantity: link.inputQuantity,
        signedQuantity: link.signedQuantity,
        checkpoint: null,
        integrity: { status: UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED, issues: [{ code: 'STOCKTAKE_PREVIEW_FAILED', detail: exactText(error?.message) }] }
      };
    }
    return {
      pendingEffectId: link.pendingEffectId,
      status: assessment.requiresDecision
        ? UNRESOLVED_REMATCH_IMPACT_STATUS.DECISION_REQUIRED
        : UNRESOLVED_REMATCH_IMPACT_STATUS.APPLY_READY,
      reason: assessment.reason,
      sourceVoucher: link.sourceVoucher,
      warehouseId: link.warehouseId,
      businessDate: link.businessDate,
      inputQuantity: link.inputQuantity,
      signedQuantity: link.signedQuantity,
      checkpoint: assessment.checkpoint,
      integrity: link.integrity
    };
  });
  const overallStatus = !impacts.length
    ? UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED
    : impacts.some(impact => impact.status === UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED)
    ? UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED
    : impacts.some(impact => impact.status === UNRESOLVED_REMATCH_IMPACT_STATUS.DECISION_REQUIRED)
      ? UNRESOLVED_REMATCH_IMPACT_STATUS.DECISION_REQUIRED
      : UNRESOLVED_REMATCH_IMPACT_STATUS.APPLY_READY;
  const uniqueCount = field => new Set(impacts.map(field).filter(Boolean)).size;
  return deepFreeze({
    schemaVersion: UNRESOLVED_REMATCH_IMPACT_SCHEMA,
    ownerAppId: 'orderq-vnext',
    companyId,
    unresolvedProductId,
    status: overallStatus,
    generatedAt: exactText(generatedAt) || new Date().toISOString(),
    readOnly: true,
    automaticConfirmation: false,
    userConfirmationRequired: true,
    targetProduct: target,
    summary: {
      affectedDocumentCount: uniqueCount(impact => impact.sourceVoucher.documentId
        ? `${impact.sourceVoucher.voucherMode}:${impact.sourceVoucher.documentId}` : ''),
      affectedLineCount: uniqueCount(impact => impact.sourceVoucher.lineId
        ? `${impact.sourceVoucher.voucherMode}:${impact.sourceVoucher.lineId}` : ''),
      affectedEffectCount: impacts.length,
      inputQuantityTotal: impacts.reduce((sum, impact) => sum + (impact.inputQuantity ?? 0), 0),
      signedQuantityTotal: impacts.reduce((sum, impact) => sum + (impact.signedQuantity ?? 0), 0),
      warehouseIds: [...new Set(impacts.map(impact => impact.warehouseId).filter(Boolean))].sort(compareText),
      businessDates: [...new Set(impacts.map(impact => impact.businessDate).filter(Boolean))].sort(compareText),
      decisionRequiredCount: impacts.filter(impact => impact.status === UNRESOLVED_REMATCH_IMPACT_STATUS.DECISION_REQUIRED).length,
      reviewRequiredCount: impacts.filter(impact => impact.status === UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED).length,
      applyReadyCount: impacts.filter(impact => impact.status === UNRESOLVED_REMATCH_IMPACT_STATUS.APPLY_READY).length
    },
    officialWritePlan: {
      commands: 0,
      inventoryWrites: 0,
      referenceDataWrites: 0,
      note: '적용 전 영향 미리보기이며 실제 재매칭·재고·기준정보 쓰기를 수행하지 않음'
    },
    impacts
  });
}
