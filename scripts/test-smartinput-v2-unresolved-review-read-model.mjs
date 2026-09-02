#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const externalMutations = [];
globalThis.fetch = async (url, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) externalMutations.push({ url: String(url), method });
  throw new Error('PHASE6A_TEST_NETWORK_DISABLED');
};

const {
  buildUnresolvedReviewReadModel,
  previewUnresolvedRematchImpact,
  UNRESOLVED_REMATCH_IMPACT_STATUS,
  UNRESOLVED_REVIEW_INTEGRITY
} = await import('../orderq/unresolved-review-read-model.js');
const { createUnresolvedReviewReadAdapter } = await import('../orderq/unresolved-review-read-adapter.js');

const companyId = 'COMPANY-A';
const otherCompanyId = 'COMPANY-B';
const unresolvedProductId = 'UP-COMPANY-A-0007';
const generatedAt = '2026-09-03T09:00:00.000Z';

function effect({
  id,
  unresolvedId = unresolvedProductId,
  company = companyId,
  mode = 'purchase',
  documentId,
  lineId,
  revisionId,
  revision = 1,
  businessDate,
  businessOccurredAt = '',
  quantity,
  signedQuantity,
  code = '0007',
  name = '동일 상품',
  specification = '10kg',
  unit = 'BOX',
  warehouseId = 'WAREHOUSE-A'
}) {
  return {
    pendingEffectId: id,
    companyId: company,
    unresolvedProductId: unresolvedId,
    status: 'PENDING_PRODUCT_MATCH',
    inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
    officialInventoryApplied: false,
    voucherMode: mode,
    sourceDocumentId: documentId,
    sourceLineId: lineId,
    sourceDocumentRevision: revision,
    voucherRevisionId: revisionId,
    commandId: `COMMAND-${id}`,
    warehouseId,
    effectiveAt: businessDate,
    businessOccurredAt,
    quantity,
    signedQuantity,
    unitPrice: 1000,
    totalAmount: quantity * 1000,
    productCode: code,
    productName: name,
    originalProductCode: code,
    originalProductName: name,
    specification,
    unit,
    productSnapshot: {
      productCode: code,
      productName: name,
      originalProductCode: code,
      originalProductName: name,
      specification,
      unit
    },
    createdAt: `${businessDate}T12:00:00.000Z`
  };
}

function reviewLink(row) {
  return {
    pendingEffectId: row.pendingEffectId,
    voucherMode: row.voucherMode,
    sourceDocumentId: row.sourceDocumentId,
    sourceLineId: row.sourceLineId,
    sourceDocumentRevision: row.sourceDocumentRevision,
    voucherRevisionId: row.voucherRevisionId,
    commandId: row.commandId,
    warehouseId: row.warehouseId,
    businessDate: row.effectiveAt,
    businessOccurredAt: row.businessOccurredAt,
    quantity: row.quantity,
    signedQuantity: row.signedQuantity,
    inventoryEffectStatus: row.inventoryEffectStatus,
    officialInventoryApplied: row.officialInventoryApplied,
    productSnapshot: row.productSnapshot
  };
}

function document(row) {
  const key = row.voucherMode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId';
  return {
    [key]: row.sourceDocumentId,
    companyId: row.companyId,
    warehouseId: row.warehouseId,
    businessDate: row.effectiveAt,
    revision: row.sourceDocumentRevision,
    status: 'CONFIRMED'
  };
}

function line(row) {
  const documentKey = row.voucherMode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId';
  const lineKey = row.voucherMode === 'purchase' ? 'purchaseLineId' : 'salesLineId';
  return {
    [documentKey]: row.sourceDocumentId,
    [lineKey]: row.sourceLineId,
    companyId: row.companyId,
    warehouseId: row.warehouseId,
    originalProductCode: row.originalProductCode,
    originalProductName: row.originalProductName,
    specification: row.specification,
    unit: row.unit,
    actualQuantity: row.quantity,
    productSnapshot: row.productSnapshot
  };
}

function revision(row) {
  return {
    voucherRevisionId: row.voucherRevisionId,
    documentId: row.sourceDocumentId,
    companyId: row.companyId,
    revision: row.sourceDocumentRevision,
    status: 'CONFIRMED'
  };
}

const before = effect({
  id: 'E-PURCHASE-BEFORE', documentId: 'PD-BEFORE', lineId: 'PL-BEFORE', revisionId: 'VR-BEFORE',
  businessDate: '2026-08-05', quantity: 10, signedQuantity: 10
});
const after = effect({
  id: 'E-SALE-AFTER', mode: 'sale', documentId: 'SD-AFTER', lineId: 'SL-AFTER', revisionId: 'VR-AFTER',
  businessDate: '2026-09-02', quantity: 4, signedQuantity: -4
});
const sameDay = effect({
  id: 'E-PURCHASE-SAME', documentId: 'PD-SAME', lineId: 'PL-SAME', revisionId: 'VR-SAME',
  businessDate: '2026-09-01', quantity: 0, signedQuantity: 0
});
const codeOnly = effect({
  id: 'E-CODE-ONLY', unresolvedId: 'UP-CODE-ONLY', documentId: 'PD-CODE', lineId: 'PL-CODE',
  revisionId: 'VR-CODE', businessDate: '2026-09-03', quantity: -3, signedQuantity: -3,
  code: 'ABC', name: '', specification: '', unit: 'EA'
});
const nameOnly = effect({
  id: 'E-NAME-ONLY', unresolvedId: 'UP-NAME-ONLY', mode: 'sale', documentId: 'SD-NAME', lineId: 'SL-NAME',
  revisionId: 'VR-NAME', businessDate: '2026-09-03', quantity: 2, signedQuantity: -2,
  code: '', name: '이름만 상품', specification: '낱개', unit: 'EA'
});
const orphan = effect({
  id: 'E-ORPHAN', unresolvedId: 'UP-ORPHAN', documentId: 'PD-ORPHAN', lineId: 'PL-ORPHAN',
  revisionId: 'VR-ORPHAN', businessDate: '2026-09-03', quantity: 1, signedQuantity: 1,
  code: 'A BC', name: '공백 상품'
});
const missingUnresolvedId = effect({
  id: 'E-MISSING-UNRESOLVED-ID', unresolvedId: '', documentId: 'PD-MISSING-UP', lineId: 'PL-MISSING-UP',
  revisionId: 'VR-MISSING-UP', businessDate: '2026-09-03', quantity: 8, signedQuantity: 8,
  code: '7', name: 'ID 손상 상품'
});
const companyB = effect({
  id: 'E-COMPANY-B', unresolvedId: 'UP-COMPANY-B-0007', company: otherCompanyId,
  documentId: 'PD-COMPANY-B', lineId: 'PL-COMPANY-B', revisionId: 'VR-COMPANY-B',
  businessDate: '2026-09-03', quantity: 99, signedQuantity: 99
});

const validEffects = [before, after, sameDay, codeOnly, nameOnly, orphan, missingUnresolvedId, companyB];
const source = {
  ownerDatabaseState: 'READY',
  unresolvedProducts: [
    {
      unresolvedProductId,
      companyId,
      status: 'UNRESOLVED_PRODUCT',
      originalProductCode: '0007',
      originalProductName: '동일 상품',
      specification: '10kg',
      unit: 'BOX',
      reviewLinks: [reviewLink(before), reviewLink(after), reviewLink(sameDay)],
      createdAt: '2026-08-05T12:00:00.000Z',
      updatedAt: '2026-09-02T12:00:00.000Z'
    },
    {
      unresolvedProductId: 'UP-CODE-ONLY', companyId, status: 'UNRESOLVED_PRODUCT',
      originalProductCode: 'ABC', originalProductName: '', reviewLinks: [reviewLink(codeOnly)]
    },
    {
      unresolvedProductId: 'UP-NAME-ONLY', companyId, status: 'UNRESOLVED_PRODUCT',
      originalProductCode: '', originalProductName: '이름만 상품', reviewLinks: [reviewLink(nameOnly)]
    },
    {
      unresolvedProductId: 'UP-CORRUPT', companyId, status: 'UNRESOLVED_PRODUCT',
      originalProductCode: 'ＡＢＣ', originalProductName: '손상 링크',
      reviewLinks: [{
        pendingEffectId: 'E-MISSING', voucherMode: 'sale', sourceDocumentId: 'SD-MISSING',
        sourceLineId: 'SL-MISSING', sourceDocumentRevision: 7, voucherRevisionId: 'VR-MISSING',
        warehouseId: 'WAREHOUSE-A', businessDate: '2026-09-03', quantity: 5, signedQuantity: -5,
        inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
        productSnapshot: { originalProductCode: 'ＡＢＣ', originalProductName: '손상 링크', unit: 'EA' }
      }]
    },
    {
      unresolvedProductId: 'UP-NO-LINK', companyId, status: 'UNRESOLVED_PRODUCT',
      originalProductCode: 'abc', originalProductName: '링크 없음', reviewLinks: []
    },
    {
      unresolvedProductId: 'UP-COMPANY-B-0007', companyId: otherCompanyId, status: 'UNRESOLVED_PRODUCT',
      originalProductCode: '0007', originalProductName: '동일 상품', reviewLinks: [reviewLink(companyB)]
    }
  ],
  pendingInventoryEffects: validEffects,
  purchaseDocuments: validEffects.filter(row => row.voucherMode === 'purchase').map(document),
  salesDocuments: validEffects.filter(row => row.voucherMode === 'sale').map(document),
  purchaseLines: validEffects.filter(row => row.voucherMode === 'purchase').map(line),
  salesLines: validEffects.filter(row => row.voucherMode === 'sale').map(line),
  voucherRevisions: validEffects.map(revision),
  inventoryCheckpoints: [{
    checkpointId: 'CP-2026-09-01',
    sessionId: 'SESSION-CP-2026-09-01',
    companyId,
    warehouseId: 'WAREHOUSE-A',
    effectiveAt: '2026-09-01',
    status: 'CONFIRMED',
    coversAllProducts: false,
    counts: [{ productCode: '0007', productId: 'PRODUCT-0007-A', quantity: 100 }],
    confirmedAt: '2026-09-01T18:00:00.000Z'
  }]
};

const productSnapshot = {
  status: 'READY',
  snapshotId: 'PRODUCT-SNAPSHOT-PHASE6A',
  revision: 9,
  data: {
    products: [
      { companyId, productId: 'PRODUCT-0007-A', itemCode: '0007', itemName: '동일 상품', status: 'ACTIVE' },
      { companyId, productId: 'PRODUCT-7-A', itemCode: '7', itemName: '동일 상품', status: 'ACTIVE' },
      { companyId, productId: 'PRODUCT-ABC-UPPER-A', itemCode: 'ABC', itemName: '코드 상품', status: 'ACTIVE' },
      { companyId, productId: 'PRODUCT-ABC-LOWER-A', itemCode: 'abc', itemName: '코드 상품', status: 'ACTIVE' },
      { companyId, productId: 'PRODUCT-ABC-FULLWIDTH-A', itemCode: 'ＡＢＣ', itemName: '코드 상품', status: 'ACTIVE' },
      { companyId, productId: 'PRODUCT-A-SPACE-BC-A', itemCode: 'A BC', itemName: '공백 상품', status: 'ACTIVE' },
      { companyId, productId: 'PRODUCT-NAME-A', itemCode: 'NAME-01', itemName: '이름만 상품', status: 'ACTIVE' },
      { companyId: otherCompanyId, productId: 'PRODUCT-0007-B', itemCode: '0007', itemName: '동일 상품', status: 'ACTIVE' }
    ]
  }
};

assert.throws(() => buildUnresolvedReviewReadModel({ source }), /COMPANY_REQUIRED/, 'company scope must be mandatory');
const model = buildUnresolvedReviewReadModel({
  companyId,
  source,
  productSnapshot,
  generatedAt,
  query: { limit: 20, sort: { field: 'unresolvedProductId', direction: 'asc' } }
});
assert.equal(model.status, 'READY');
assert.equal(model.companyId, companyId);
assert.equal(model.page.totalItems, 7, 'other-company unresolved rows must remain isolated and damaged IDs must remain visible');
assert.equal(model.items.some(item => item.companyId === otherCompanyId), false);

const multi = model.items.find(item => item.unresolvedProductId === unresolvedProductId);
assert.ok(multi);
assert.equal(multi.aggregate.linkCount, 3, 'review link and owner effect must reconcile without duplication');
assert.equal(multi.aggregate.documentCount, 3);
assert.equal(multi.aggregate.lineCount, 3);
assert.equal(multi.aggregate.revisionCount, 3);
assert.equal(multi.aggregate.inputQuantityTotal, 14);
assert.equal(multi.aggregate.signedQuantityTotal, 6, 'purchase and sale signs must reconcile separately');
assert.deepEqual(multi.aggregate.businessDates, ['2026-08-05', '2026-09-01', '2026-09-02']);
assert.deepEqual(multi.links.map(link => link.inputQuantity), [10, 0, 4]);
assert.deepEqual(multi.links.map(link => link.signedQuantity), [10, 0, -4]);
assert.equal(multi.officialInventory.status, 'NOT_APPLIED');
assert.equal(multi.officialInventory.label, '미반영');
assert.equal(multi.officialInventory.officialQuantity, null, 'official inventory must never masquerade as zero');
assert.equal(multi.officialInventory.unappliedSignedQuantity, 6);
multi.links.forEach(link => {
  assert.equal(link.officialInventory.officialQuantity, null);
  assert.equal(link.officialInventory.unappliedSignedQuantity, link.signedQuantity);
  assert.ok(link.sourceVoucher.documentId);
  assert.ok(link.sourceVoucher.lineId);
  assert.ok(link.sourceVoucher.revisionId);
  assert.match(link.sourceVoucher.detailHref, /voucher-query\.html/);
  assert.equal(link.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.READY);
});

const exactCandidates = multi.candidates.filter(candidate => candidate.exactCandidate);
assert.deepEqual(exactCandidates.map(candidate => candidate.productId), ['PRODUCT-0007-A']);
assert.equal(multi.candidates.some(candidate => candidate.productId === 'PRODUCT-7-A' && candidate.exactCandidate), false,
  'leading-zero variants must remain distinct');
assert.equal(multi.candidates.some(candidate => candidate.productId === 'PRODUCT-7-A'
  && candidate.matchBasis === 'EXACT_PRODUCT_NAME_REFERENCE_ONLY'), true,
  'same-name rows may be shown only as nonautomatic reference candidates');
assert.equal(multi.candidates.some(candidate => candidate.productId === 'PRODUCT-0007-B'), false,
  'same code in another company must remain isolated');
assert.equal(multi.candidates.every(candidate => candidate.automaticConfirmation === false), true);
assert.equal(multi.candidates.every(candidate => candidate.reason.includes('자동확정 아님')), true);

const codeOnlyItem = model.items.find(item => item.unresolvedProductId === 'UP-CODE-ONLY');
assert.equal(codeOnlyItem.originalProductName, '');
assert.deepEqual(codeOnlyItem.candidates.filter(candidate => candidate.exactCandidate).map(candidate => candidate.productId),
  ['PRODUCT-ABC-UPPER-A']);
assert.equal(codeOnlyItem.candidates.some(candidate => candidate.productId === 'PRODUCT-ABC-LOWER-A'), false,
  'case variants must not become exact code candidates');
assert.equal(codeOnlyItem.candidates.some(candidate => candidate.productId === 'PRODUCT-ABC-FULLWIDTH-A'), false,
  'fullwidth variants must not become exact code candidates');

const nameOnlyItem = model.items.find(item => item.unresolvedProductId === 'UP-NAME-ONLY');
assert.equal(nameOnlyItem.originalProductCode, '');
assert.equal(nameOnlyItem.originalProductName, '이름만 상품', 'name-only unresolved rows must not disappear');
assert.equal(nameOnlyItem.candidates.length, 1);
assert.equal(nameOnlyItem.candidates[0].matchBasis, 'EXACT_PRODUCT_NAME_REFERENCE_ONLY');
assert.equal(nameOnlyItem.candidates[0].exactCandidate, false);
assert.equal(nameOnlyItem.candidates[0].automaticConfirmation, false);

const orphanItem = model.items.find(item => item.unresolvedProductId === 'UP-ORPHAN');
assert.equal(orphanItem.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
assert.equal(orphanItem.integrity.issues.some(issue => issue.code === 'UNRESOLVED_RECORD_MISSING'), true);
assert.deepEqual(orphanItem.candidates.filter(candidate => candidate.exactCandidate).map(candidate => candidate.productId),
  ['PRODUCT-A-SPACE-BC-A'], 'internal-space code must match only the exact source string');

const corruptItem = model.items.find(item => item.unresolvedProductId === 'UP-CORRUPT');
assert.equal(corruptItem.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
assert.equal(corruptItem.aggregate.documentCount, 1, 'known link ids remain visible even when targets are missing');
assert.ok(corruptItem.integrity.issues.some(issue => issue.code === 'PENDING_EFFECT_MISSING'));
assert.ok(corruptItem.integrity.issues.some(issue => issue.code === 'SOURCE_DOCUMENT_MISSING'));
assert.ok(corruptItem.integrity.issues.some(issue => issue.code === 'SOURCE_LINE_MISSING'));
assert.ok(corruptItem.integrity.issues.some(issue => issue.code === 'VOUCHER_REVISION_MISSING'));
assert.deepEqual(corruptItem.candidates.filter(candidate => candidate.exactCandidate).map(candidate => candidate.productId),
  ['PRODUCT-ABC-FULLWIDTH-A'], 'fullwidth code must remain its own exact-string candidate');

const noLinkItem = model.items.find(item => item.unresolvedProductId === 'UP-NO-LINK');
assert.equal(noLinkItem.aggregate.linkCount, 0);
assert.equal(noLinkItem.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
assert.deepEqual(noLinkItem.candidates.filter(candidate => candidate.exactCandidate).map(candidate => candidate.productId),
  ['PRODUCT-ABC-LOWER-A'], 'lowercase code must remain its own exact-string candidate');

const damagedIdItem = model.items.find(item => item.unresolvedProductId === 'MISSING_UNRESOLVED_PRODUCT_ID:E-MISSING-UNRESOLVED-ID');
assert.ok(damagedIdItem, 'a pending effect with a missing unresolvedProductId must not disappear');
assert.equal(damagedIdItem.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
assert.ok(damagedIdItem.integrity.issues.some(issue => issue.code === 'PENDING_EFFECT_UNRESOLVED_ID_MISSING'));

const conflictingLinkSource = structuredClone(source);
const conflictingRecord = conflictingLinkSource.unresolvedProducts
  .find(item => item.unresolvedProductId === unresolvedProductId);
const conflictingReviewLink = conflictingRecord.reviewLinks
  .find(item => item.pendingEffectId === before.pendingEffectId);
Object.assign(conflictingReviewLink, {
  companyId: otherCompanyId,
  unresolvedProductId: 'UP-CONFLICTING-SCOPE',
  voucherMode: 'sale',
  sourceDocumentId: 'SD-CONFLICTING-LINK',
  sourceLineId: 'SL-CONFLICTING-LINK',
  sourceDocumentRevision: 99,
  voucherRevisionId: 'VR-CONFLICTING-LINK',
  commandId: 'COMMAND-CONFLICTING-LINK',
  warehouseId: 'WAREHOUSE-CONFLICTING-LINK',
  businessDate: '2026-07-01',
  businessOccurredAt: '2026-07-01T01:00:00.000Z',
  quantity: 777,
  signedQuantity: -777,
  inventoryEffectStatus: 'CORRUPT',
  officialInventoryApplied: true,
  productSnapshot: {
    originalProductCode: 'CONFLICTING-CODE',
    originalProductName: 'CONFLICTING-NAME',
    specification: 'CONFLICTING-SPEC',
    unit: 'CONFLICTING-UNIT'
  }
});
const conflictingLinkModel = buildUnresolvedReviewReadModel({
  companyId,
  source: conflictingLinkSource,
  productSnapshot,
  generatedAt,
  query: { limit: 20, filters: { unresolvedProductId } }
});
const conflictingItem = conflictingLinkModel.items[0];
const conflictingLink = conflictingItem.links.find(item => item.pendingEffectId === before.pendingEffectId);
assert.equal(conflictingItem.aggregate.linkCount, 3,
  'a conflicting duplicate pendingEffectId must stay one reconciled link');
assert.equal(conflictingLink.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED,
  'conflicting review-link evidence must never remain READY');
assert.equal(conflictingItem.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
const mismatchedFields = conflictingLink.integrity.issues
  .filter(issue => issue.code === 'REVIEW_LINK_PENDING_EFFECT_FIELD_MISMATCH')
  .map(issue => issue.detail);
assert.deepEqual(mismatchedFields, [
  'companyId', 'unresolvedProductId', 'voucherMode', 'sourceDocumentId', 'sourceLineId',
  'sourceDocumentRevision', 'voucherRevisionId', 'commandId', 'warehouseId', 'businessDate',
  'businessOccurredAt', 'quantity', 'signedQuantity', 'inventoryEffectStatus',
  'officialInventoryApplied', 'originalProductCode', 'originalProductName', 'specification', 'unit'
], 'every conflicting core field must remain explicit issue evidence');
assert.equal(conflictingLink.integrity.issues.some(issue => issue.code === 'REVIEW_LINK_COMPANY_MISMATCH'), true);
assert.equal(conflictingLink.integrity.issues.some(issue => issue.code === 'REVIEW_LINK_UNRESOLVED_ID_MISMATCH'), true);
assert.equal(conflictingLink.originalProductCode, before.originalProductCode,
  'pending owner evidence remains the displayed canonical value after reporting the conflict');
assert.equal(conflictingLink.inputQuantity, before.quantity);
assert.equal(conflictingLink.signedQuantity, before.signedQuantity);

const externalPayloadSource = {
  unresolvedProducts: [{
    unresolvedProductId: 'UP-CROSS-COMPANY-TARGET',
    companyId,
    status: 'UNRESOLVED_PRODUCT',
    originalProductCode: '',
    originalProductName: '',
    reviewLinks: [{
      pendingEffectId: 'E-CROSS-COMPANY-TARGET',
      voucherMode: 'purchase',
      sourceDocumentId: 'PD-CROSS-COMPANY-TARGET',
      sourceLineId: 'PL-CROSS-COMPANY-TARGET',
      sourceDocumentRevision: 1,
      voucherRevisionId: 'VR-CROSS-COMPANY-TARGET'
    }]
  }],
  pendingInventoryEffects: [{
    pendingEffectId: 'E-CROSS-COMPANY-TARGET',
    companyId,
    unresolvedProductId: 'UP-CROSS-COMPANY-TARGET',
    status: 'PENDING_PRODUCT_MATCH',
    inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
    officialInventoryApplied: false,
    voucherMode: 'purchase',
    sourceDocumentId: 'PD-CROSS-COMPANY-TARGET',
    sourceLineId: 'PL-CROSS-COMPANY-TARGET',
    sourceDocumentRevision: 1,
    voucherRevisionId: 'VR-CROSS-COMPANY-TARGET'
  }],
  purchaseDocuments: [{
    purchaseDocumentId: 'PD-CROSS-COMPANY-TARGET',
    companyId: otherCompanyId,
    status: 'LEAK-DOCUMENT-STATUS',
    warehouseId: 'LEAK-WAREHOUSE',
    businessDate: '2099-12-31',
    businessOccurredAt: 'LEAK-DOCUMENT-TIME',
    revision: 1
  }],
  purchaseLines: [{
    purchaseLineId: 'PL-CROSS-COMPANY-TARGET',
    purchaseDocumentId: 'PD-CROSS-COMPANY-TARGET',
    companyId: otherCompanyId,
    warehouseId: 'LEAK-LINE-WAREHOUSE',
    originalProductCode: 'LEAK-PRODUCT-CODE',
    originalProductName: 'LEAK-PRODUCT-NAME',
    specification: 'LEAK-SPECIFICATION',
    unit: 'LEAK-UNIT',
    actualQuantity: 987654321,
    businessOccurredAt: 'LEAK-LINE-TIME',
    productSnapshot: { productName: 'LEAK-SNAPSHOT-NAME' }
  }],
  salesDocuments: [],
  salesLines: [],
  voucherRevisions: [{
    voucherRevisionId: 'VR-CROSS-COMPANY-TARGET',
    documentId: 'LEAK-REVISION-DOCUMENT',
    companyId: otherCompanyId,
    status: 'LEAK-REVISION-STATUS',
    revision: 999,
    afterSnapshot: { memo: 'LEAK-REVISION-PAYLOAD' }
  }],
  inventoryCheckpoints: []
};
const externalPayloadModel = buildUnresolvedReviewReadModel({
  companyId,
  source: externalPayloadSource,
  productSnapshot: { status: 'EMPTY', data: { products: [] } },
  generatedAt,
  query: { limit: 20 }
});
const externalItem = externalPayloadModel.items[0];
const externalLink = externalItem.links[0];
assert.equal(externalLink.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
assert.equal(externalItem.integrity.status, UNRESOLVED_REVIEW_INTEGRITY.REVIEW_REQUIRED);
assert.equal(externalLink.integrity.issues.some(issue => issue.code === 'SOURCE_DOCUMENT_COMPANY_MISMATCH'), true);
assert.equal(externalLink.integrity.issues.some(issue => issue.code === 'SOURCE_LINE_COMPANY_MISMATCH'), true);
assert.equal(externalLink.integrity.issues.some(issue => issue.code === 'VOUCHER_REVISION_COMPANY_MISMATCH'), true);
assert.deepEqual({
  code: externalLink.originalProductCode,
  name: externalLink.originalProductName,
  specification: externalLink.specification,
  unit: externalLink.unit,
  warehouseId: externalLink.warehouseId,
  businessDate: externalLink.businessDate,
  businessOccurredAt: externalLink.businessOccurredAt,
  inputQuantity: externalLink.inputQuantity,
  signedQuantity: externalLink.signedQuantity,
  productSnapshot: externalLink.productSnapshot
}, {
  code: '', name: '', specification: '', unit: '', warehouseId: '', businessDate: '',
  businessOccurredAt: '', inputQuantity: null, signedQuantity: null, productSnapshot: {}
}, 'cross-company point-get targets must never supply fallback payload values');
assert.equal(JSON.stringify(externalPayloadModel).includes('LEAK-'), false,
  'no external-company document, line, revision, or product payload may reach the read model result');
const externalPayloadAdapter = createUnresolvedReviewReadAdapter({
  readOwnerSources: async () => structuredClone(externalPayloadSource),
  readProductSnapshot: async () => ({
    status: 'EMPTY', snapshot: { status: 'EMPTY', data: { products: [] } }, error: null
  })
});
const externalPayloadAdapterResult = await externalPayloadAdapter.getReviewResult({ companyId, limit: 20, generatedAt });
assert.equal(externalPayloadAdapterResult.status, 'READY');
assert.equal(JSON.stringify(externalPayloadAdapterResult).includes('LEAK-'), false,
  'Adapter output must not expose any external-company point-get payload');

const filtered = buildUnresolvedReviewReadModel({
  companyId,
  source,
  productSnapshot,
  generatedAt,
  query: { page: 1, limit: 1, sort: 'signedQuantity', direction: 'desc', filters: { warehouseId: 'WAREHOUSE-A' } }
});
assert.equal(filtered.page.limit, 1);
assert.equal(filtered.page.returnedItems, 1);
assert.equal(filtered.page.hasNext, true);
const filteredAgain = buildUnresolvedReviewReadModel({
  companyId,
  source,
  productSnapshot,
  generatedAt,
  query: { page: 1, limit: 1, sort: 'signedQuantity', direction: 'desc', filters: { warehouseId: 'WAREHOUSE-A' } }
});
assert.deepEqual(filtered, filteredAgain, 'sort/filter/page output must be deterministic for fixed inputs and time');
const emptyDateWindow = buildUnresolvedReviewReadModel({
  companyId,
  source,
  productSnapshot,
  generatedAt,
  query: { limit: 20, filters: { unresolvedProductId, businessDateFrom: '2026-08-10', businessDateTo: '2026-08-20' } }
});
assert.equal(emptyDateWindow.status, 'EMPTY', 'date range must be satisfied by one actual linked business date');
assert.throws(() => buildUnresolvedReviewReadModel({ companyId, source, query: { limit: 201 } }), /LIMIT_INVALID/);

const preview = previewUnresolvedRematchImpact({
  companyId,
  unresolvedProductId,
  selectedProduct: productSnapshot.data.products[0],
  source,
  generatedAt
});
assert.equal(preview.status, UNRESOLVED_REMATCH_IMPACT_STATUS.DECISION_REQUIRED);
assert.equal(preview.summary.affectedDocumentCount, 3);
assert.equal(preview.summary.affectedLineCount, 3);
assert.equal(preview.summary.affectedEffectCount, 3);
assert.equal(preview.summary.signedQuantityTotal, 6);
assert.deepEqual(preview.impacts.map(impact => [impact.businessDate, impact.status, impact.reason]), [
  ['2026-08-05', 'DECISION_REQUIRED', 'BEFORE_CHECKPOINT'],
  ['2026-09-01', 'DECISION_REQUIRED', 'SAME_DAY_ORDER_UNPROVEN'],
  ['2026-09-02', 'APPLY_READY', 'AFTER_CHECKPOINT']
]);
assert.deepEqual(preview.impacts.map(impact => impact.checkpoint?.checkpointId),
  ['CP-2026-09-01', 'CP-2026-09-01', 'CP-2026-09-01']);
assert.deepEqual(preview.officialWritePlan, {
  commands: 0,
  inventoryWrites: 0,
  referenceDataWrites: 0,
  note: '적용 전 영향 미리보기이며 실제 재매칭·재고·기준정보 쓰기를 수행하지 않음'
});

const noLinkPreview = previewUnresolvedRematchImpact({
  companyId,
  unresolvedProductId: 'UP-NO-LINK',
  selectedProduct: productSnapshot.data.products[3],
  source,
  generatedAt
});
assert.equal(noLinkPreview.status, UNRESOLVED_REMATCH_IMPACT_STATUS.REVIEW_REQUIRED,
  'missing links must fail closed rather than appear apply-ready');
assert.equal(noLinkPreview.summary.affectedEffectCount, 0);

const readyProductResult = { status: 'READY', snapshot: productSnapshot, error: null };
const adapter = createUnresolvedReviewReadAdapter({
  readOwnerSources: async () => structuredClone(source),
  readProductSnapshot: async () => readyProductResult
});
const adapterReview = await adapter.getReviewResult({ companyId, limit: 20, generatedAt });
assert.equal(adapterReview.status, 'READY');
assert.equal(adapterReview.count, 7);
assert.equal(adapterReview.candidateReference.status, 'READY');
const adapterPreview = await adapter.previewRematchImpactResult({
  companyId,
  unresolvedProductId,
  selectedProductId: 'PRODUCT-0007-A',
  generatedAt
});
assert.equal(adapterPreview.status, 'DECISION_REQUIRED');
assert.equal(adapterPreview.officialWritePlan.inventoryWrites, 0);

const emptyAdapter = createUnresolvedReviewReadAdapter({
  readOwnerSources: async () => ({ ownerDatabaseState: 'ABSENT', unresolvedProducts: [], pendingInventoryEffects: [] }),
  readProductSnapshot: async () => ({ status: 'EMPTY', snapshot: { status: 'EMPTY', data: { products: [] } }, error: null })
});
const empty = await emptyAdapter.getReviewResult({ companyId, generatedAt });
assert.equal(empty.status, 'EMPTY');
assert.equal(empty.count, 0);
assert.equal(empty.error, null);

const failedOwnerAdapter = createUnresolvedReviewReadAdapter({
  readOwnerSources: async () => { throw new Error('OWNER_READ_BROKEN'); },
  readProductSnapshot: async () => readyProductResult
});
const failedOwner = await failedOwnerAdapter.getReviewResult({ companyId });
assert.equal(failedOwner.status, 'ERROR');
assert.equal(failedOwner.count, null, 'owner read failure must not masquerade as zero rows');
assert.equal(failedOwner.items.length, 0);
assert.equal(failedOwner.error.code, 'OWNER_READ_BROKEN');

const failedProductAdapter = createUnresolvedReviewReadAdapter({
  readOwnerSources: async () => structuredClone(source),
  readProductSnapshot: async () => { throw new Error('PRODUCT_READ_BROKEN'); }
});
const reviewWithoutCandidates = await failedProductAdapter.getReviewResult({ companyId, limit: 20, generatedAt });
assert.equal(reviewWithoutCandidates.status, 'READY', 'candidate outage must not suppress official owner review rows');
assert.equal(reviewWithoutCandidates.count, 7);
assert.equal(reviewWithoutCandidates.candidateReference.status, 'ERROR');
assert.equal(reviewWithoutCandidates.items.every(item => item.candidates.length === 0), true);
const failedPreview = await failedProductAdapter.previewRematchImpactResult({
  companyId, unresolvedProductId, selectedProductId: 'PRODUCT-0007-A'
});
assert.equal(failedPreview.status, 'ERROR', 'preview must fail closed when selected Product snapshot cannot be verified');
assert.equal(failedPreview.count, null);
assert.equal(failedPreview.source, 'PRODUCT_MASTER_READ_ADAPTER');

const largeEffects = Array.from({ length: 10000 }, (_, index) => effect({
  id: `E-LARGE-${index}`,
  unresolvedId: `UP-LARGE-${String(index).padStart(5, '0')}`,
  documentId: `PD-LARGE-${index}`,
  lineId: `PL-LARGE-${index}`,
  revisionId: `VR-LARGE-${index}`,
  businessDate: '2026-09-03',
  quantity: index % 3,
  signedQuantity: index % 3,
  code: `L-${index}`,
  name: `대량 상품 ${index}`
}));
const largeSource = { unresolvedProducts: [], pendingInventoryEffects: largeEffects };
const startedAt = performance.now();
const largeResult = buildUnresolvedReviewReadModel({
  companyId,
  source: largeSource,
  productSnapshot: { status: 'EMPTY', data: { products: [] } },
  generatedAt,
  query: { limit: 200, sort: 'unresolvedProductId' }
});
const elapsedMs = performance.now() - startedAt;
assert.equal(largeResult.page.totalItems, 10000);
assert.equal(largeResult.page.returnedItems, 200);
assert.ok(elapsedMs < 5000, `10,000-effect read-model projection exceeded 5s: ${elapsedMs.toFixed(1)}ms`);

const repositorySource = readFileSync(new URL('../orderq/unresolved-review-repository.js', import.meta.url), 'utf8');
const adapterSource = readFileSync(new URL('../orderq/unresolved-review-read-adapter.js', import.meta.url), 'utf8');
assert.match(repositorySource, /transaction\(storeNames, 'readonly'\)/);
assert.doesNotMatch(repositorySource, /['"]readwrite['"]|\.put\(|\.clear\(/,
  'owner repository contract must contain no IndexedDB write operation');
assert.doesNotMatch(adapterSource, /indexedDB|objectStore|transaction\(/,
  'consumer-facing adapter must not expose or open the ORDER Q Store');
assert.deepEqual(externalMutations, [], 'external mutating requests must remain zero');

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-06A',
  status: 'PASS',
  items: model.page.totalItems,
  multiLinkCount: multi.aggregate.linkCount,
  preview: preview.summary,
  officialStoreWrites: 0,
  externalMutations: externalMutations.length,
  largeQuery: { effects: largeEffects.length, returned: largeResult.page.returnedItems, elapsedMs: Number(elapsedMs.toFixed(1)) }
}, null, 2));
