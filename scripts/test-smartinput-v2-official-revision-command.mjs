#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  assertOfficialVoucherRevisionCommandV2,
  buildOfficialVoucherRevisionCommandV2,
  planOfficialVoucherRevisionCommandV2,
  previewOfficialVoucherRevisionV2,
  withOfficialRevisionTargetDigestV2
} from '../orderq/official-voucher-revision-core.js';
import { canonicalSha256, unresolvedProductStableId } from '../orderq/official-voucher-core.js';
import { createOfficialCommandGateway } from '../orderq/official-command-gateway.js';
import { officialVoucherStableIdV2 } from '../orderq/official-voucher-v2-contract.js';

const COMPANY = 'COMPANY-A';
const PRODUCT_SNAPSHOT_ID = 'PRODUCT-OWNER-REVISION-7A';
const productOwnerSnapshot = {
  schemaVersion: 'ONEAPP_PRODUCT_SNAPSHOT_V1', status: 'READY', snapshotId: PRODUCT_SNAPSHOT_ID,
  revision: 'REV-7A', snapshotVersion: 'REV-7A', contentHash: 'PRODUCT-HASH-7A',
  data: { products: [
    { companyId: COMPANY, productId: 'PRODUCT-1', itemCode: '0001', itemName: '상품 A', specification: '10kg', unit: 'BOX', status: 'ACTIVE', revision: 1 },
    { companyId: COMPANY, productId: 'PRODUCT-2', itemCode: '0002', itemName: '상품 B', specification: '10kg', unit: 'BOX', status: 'ACTIVE', revision: 1 },
    { companyId: COMPANY, productId: 'PRODUCT-3', itemCode: '0003', itemName: '상품 A', specification: '10kg', unit: 'BOX', status: 'ACTIVE', revision: 1 }
  ] }
};

function fixtureIdentity(kind) {
  const purchase = kind === 'PURCHASE';
  const voucherGroupKey = purchase ? '' : 'GROUP-A';
  const documentEntity = purchase ? 'PURCHASE_DOCUMENT' : 'SALE_DOCUMENT';
  const lineEntity = purchase ? 'PURCHASE_LINE' : 'SALE_LINE';
  const documentSeed = { source: 'REVISION-TEST', voucherGroupKey };
  const documentId = officialVoucherStableIdV2(purchase ? 'PD' : 'SD', documentEntity, COMPANY, documentSeed);
  const lineSeed = { documentId, voucherGroupKey, sourceLineKey: 'ROW-1' };
  const lineId = officialVoucherStableIdV2(purchase ? 'PL' : 'SL', lineEntity, COMPANY, lineSeed);
  return { voucherGroupKey, documentEntity, lineEntity, documentSeed, documentId, lineSeed, lineId };
}

function productResolution(productId, productCode, status = 'MATCHED') {
  if (status !== 'MATCHED') return {
    companyId: COMPANY, status: 'UNRESOLVED_PRODUCT', reason: 'PRODUCT_CODE_UNMATCHED',
    inputProductCode: productCode, matchedProductCode: '', matchedProductId: ''
  };
  return {
    companyId: COMPANY, status: 'MATCHED', reason: 'EXACT_COMPANY_PRODUCT_CODE',
    inputProductCode: productCode, matchedProductCode: productCode, matchedProductId: productId,
    productMasterRevision: 1, referenceSnapshotId: PRODUCT_SNAPSHOT_ID
  };
}

function lineFixture(kind, options = {}) {
  const purchase = kind === 'PURCHASE';
  const identity = fixtureIdentity(kind);
  const { documentId, lineId } = identity;
  const productId = options.productId === undefined ? 'PRODUCT-1' : options.productId;
  const productCode = options.productCode || (productId ? '0001' : 'UNMATCHED-1');
  const resolution = productResolution(productId, productCode, productId ? 'MATCHED' : 'UNRESOLVED');
  const quantity = options.quantity ?? 5;
  const line = {
    schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2',
    identityVersion: 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2',
    entityType: identity.lineEntity,
    companyId: COMPANY, voucherGroupKey: identity.voucherGroupKey,
    [purchase ? 'purchaseDocumentId' : 'salesDocumentId']: documentId,
    [purchase ? 'purchaseLineId' : 'salesLineId']: lineId,
    identitySeed: identity.lineSeed,
    lineIdentityId: 'LINE-IDENTITY-A', sourceLineKey: 'ROW-1',
    productId, unresolvedProductId: '',
    productCode, productName: options.productName || '상품 A', originalProductCode: productCode,
    originalProductName: options.productName || '상품 A', specification: '10kg', unit: 'BOX', actualUnit: 'BOX',
    warehouseId: options.warehouseId || 'W1', quantity, actualQuantity: quantity, baseQuantity: quantity,
    inventoryEffectFactor: 1, unitPrice: options.unitPrice ?? 1000,
    supplyAmount: quantity * (options.unitPrice ?? 1000), vatAmount: null,
    totalAmount: options.totalAmount ?? quantity * (options.unitPrice ?? 1000),
    officialProductResolution: resolution,
    productMasterRevision: productId ? 1 : 0,
    referenceSnapshotId: productId ? PRODUCT_SNAPSHOT_ID : '',
    matchStatus: productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT',
    productIdentityStatus: productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT',
    matchSource: productId ? 'EXACT_COMPANY_PRODUCT_CODE' : 'PRODUCT_CODE_UNMATCHED',
    productSnapshot: {
      schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2', entityType: identity.lineEntity,
      productCode, productName: options.productName || '상품 A',
      originalProductCode: productCode, originalProductName: options.productName || '상품 A',
      specification: '10kg', unit: 'BOX', quantity, unitPrice: options.unitPrice ?? 1000,
      amount: options.totalAmount ?? quantity * (options.unitPrice ?? 1000),
      amountOrigin: options.totalAmount === undefined ? 'DERIVED_AT_CONFIRM' : 'SOURCE_OR_USER',
      amountSourceField: options.totalAmount === undefined ? '' : 'totalAmount',
      matchEvidence: {
        status: productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT',
        source: productId ? 'EXACT_COMPANY_PRODUCT_CODE' : 'PRODUCT_CODE_UNMATCHED',
        productId, unresolvedProductId: '', productMasterRevision: productId ? 1 : 0,
        referenceSnapshotId: productId ? PRODUCT_SNAPSHOT_ID : '',
        officialProductResolution: resolution
      }
    },
    status: 'CONFIRMED', lineStatus: 'ACTIVE', revision: 1, commandId: 'POST-COMMAND-A'
  };
  if (!productId) {
    line.unresolvedProductId = unresolvedProductStableId(COMPANY, line);
    line.productSnapshot.matchEvidence.unresolvedProductId = line.unresolvedProductId;
  }
  return line;
}

function documentFixture(kind, options = {}) {
  const purchase = kind === 'PURCHASE';
  const identity = fixtureIdentity(kind);
  const { documentId } = identity;
  const date = options.businessDate || '2026-09-03';
  return {
    schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2',
    identityVersion: 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2',
    entityType: identity.documentEntity,
    companyId: COMPANY, voucherGroupKey: identity.voucherGroupKey,
    [purchase ? 'purchaseDocumentId' : 'salesDocumentId']: documentId,
    identitySeed: identity.documentSeed,
    businessDate: date, [purchase ? 'purchaseDate' : 'saleDate']: date,
    businessOccurredAt: `${date}T10:00:00+09:00`, warehouseId: options.warehouseId || 'W1',
    officialPartnerResolution: {
      companyId: COMPANY, partnerRole: purchase ? 'SUPPLIER' : 'SALES',
      status: 'CUSTOMER_NOT_PROVIDED', reason: 'CUSTOMER_CODE_NOT_PROVIDED',
      inputCustomerCode: '', matchedCustomerCode: '', matchedCustomerId: ''
    },
    supplierCustomerCode: '', supplierCustomerId: '', salesCustomerCode: '', salesCustomerId: '',
    supplyAmount: 5000, vatAmount: null, totalAmount: 5000,
    calculatedSupplyAmount: 5000, amountDifference: 0, currency: 'KRW',
    status: 'CONFIRMED', businessStatus: 'CONFIRMED', revision: 1,
    commandId: 'POST-COMMAND-A', lastVoucherRevisionId: purchase ? 'VR-P-A' : 'VR-S-A'
  };
}

function targetFixture(kind = 'PURCHASE', options = {}) {
  const document = documentFixture(kind, options);
  const line = lineFixture(kind, options);
  const purchase = kind === 'PURCHASE';
  const mode = purchase ? 'purchase' : 'sale';
  const documentId = document[purchase ? 'purchaseDocumentId' : 'salesDocumentId'];
  const lineId = line[purchase ? 'purchaseLineId' : 'salesLineId'];
  const revisionId = document.lastVoucherRevisionId;
  const beforeSnapshot = { companyId: COMPANY, voucherMode: mode, documentId, revision: 0, status: 'DRAFT', lines: [] };
  const afterSnapshot = {
    companyId: COMPANY, voucherMode: mode, documentId, revision: 1, status: 'CONFIRMED',
    warehouseId: document.warehouseId, supplyAmount: document.supplyAmount, vatAmount: null,
    totalAmount: document.totalAmount,
    lines: [{ lineId, lineIdentityId: line.lineIdentityId, productId: line.productId,
      unresolvedProductId: line.unresolvedProductId, warehouseId: line.warehouseId,
      quantity: line.actualQuantity, baseQuantity: line.baseQuantity, unitPrice: line.unitPrice,
      supplyAmount: line.supplyAmount, vatAmount: line.vatAmount, totalAmount: line.totalAmount,
      productSnapshot: line.productSnapshot }]
  };
  const voucherRevision = {
    voucherRevisionId: revisionId, companyId: COMPANY, voucherMode: mode, documentId, revision: 1,
    commandId: document.commandId, status: 'CONFIRMED', beforeSnapshot, afterSnapshot,
    beforeDigest: canonicalSha256(beforeSnapshot), afterDigest: canonicalSha256(afterSnapshot)
  };
  const signed = (purchase ? 1 : -1) * line.actualQuantity;
  let effectiveLineState;
  if (line.productId) {
    const movement = {
      movementId: `${purchase ? 'P' : 'S'}-MOVEMENT-A`, companyId: COMPANY, warehouseId: line.warehouseId,
      productId: line.productId, productCode: line.productCode, sourceDocumentId: documentId,
      sourceLineId: lineId, sourceDocumentRevision: 1, voucherMode: mode,
      movementType: `${kind}_POST`, signedQuantity: signed, originalSignedQuantity: signed,
      inventoryEffectFactor: 1, effectiveAt: document.businessDate, businessDate: document.businessDate,
      effectStatus: signed === 0 ? 'ZERO_EFFECT' : 'APPLIED_NORMAL', stocktakeEffectStatus: '',
      officialInventoryApplied: true, effectRole: 'SOURCE_VOUCHER_EFFECT', commandId: document.commandId
    };
    effectiveLineState = { lineId, status: 'MATCHED', productId: line.productId, productCode: line.productCode,
      warehouseId: line.warehouseId, businessDate: document.businessDate,
      businessOccurredAt: document.businessOccurredAt, signedQuantity: signed, activeInventoryEffects: [movement] };
  } else {
    const pending = {
      pendingEffectId: 'PENDING-A', companyId: COMPANY, unresolvedProductId: line.unresolvedProductId,
      sourceDocumentId: documentId, sourceLineId: lineId, sourceDocumentRevision: 1, voucherMode: mode,
      warehouseId: line.warehouseId, effectiveAt: document.businessDate, quantity: line.actualQuantity,
      signedQuantity: signed, status: 'PENDING_PRODUCT_MATCH', commandId: document.commandId
    };
    effectiveLineState = { lineId, status: 'UNRESOLVED_PRODUCT', unresolvedProductId: line.unresolvedProductId,
      productCode: line.productCode, warehouseId: line.warehouseId, businessDate: document.businessDate,
      businessOccurredAt: document.businessOccurredAt, signedQuantity: signed, activePendingEffect: pending };
  }
  return withOfficialRevisionTargetDigestV2({
    schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_REVISION_TARGET_V2', companyId: COMPANY, kind, voucherMode: mode,
    documentId, currentRevision: 1, currentRevisionId: revisionId, currentDocument: document,
    currentLines: [line], currentVoucherRevision: voucherRevision, effectiveLineStates: [effectiveLineState],
    unresolvedProductEvidence: line.productId ? [] : [{ unresolvedProductId: line.unresolvedProductId,
      companyId: COMPANY, status: 'UNRESOLVED_PRODUCT', productId: '' }],
    partnerEntryIds: options.partnerEntryIds || [], currentCommandReceiptDigest: 'RECEIPT-DIGEST-A'
  });
}

function replacementFor(target, options = {}) {
  const kind = target.kind;
  const document = { ...structuredClone(target.currentDocument),
    businessDate: options.businessDate || target.currentDocument.businessDate,
    [kind === 'PURCHASE' ? 'purchaseDate' : 'saleDate']: options.businessDate || target.currentDocument.businessDate,
    businessOccurredAt: `${options.businessDate || target.currentDocument.businessDate}T11:00:00+09:00`,
    warehouseId: options.warehouseId || target.currentDocument.warehouseId };
  const line = lineFixture(kind, {
    quantity: options.quantity ?? target.currentLines[0].actualQuantity,
    unitPrice: options.unitPrice ?? target.currentLines[0].unitPrice,
    totalAmount: options.totalAmount,
    productId: options.productId === undefined ? target.currentLines[0].productId : options.productId,
    productCode: options.productCode || target.currentLines[0].productCode,
    productName: options.productName || target.currentLines[0].productName,
    warehouseId: options.warehouseId || target.currentLines[0].warehouseId
  });
  document.supplyAmount = line.supplyAmount;
  document.totalAmount = line.totalAmount;
  document.calculatedSupplyAmount = line.actualQuantity * line.unitPrice;
  document.amountDifference = document.supplyAmount - document.calculatedSupplyAmount;
  return { document, lines: [line] };
}

const purchaseTarget = targetFixture('PURCHASE');
const changed = replacementFor(purchaseTarget, {
  productId: 'PRODUCT-2', productCode: '0002', productName: '상품 B', warehouseId: 'W2',
  businessDate: '2026-09-04', quantity: -3, unitPrice: -200, totalAmount: 600
});
const preview = previewOfficialVoucherRevisionV2({ target: purchaseTarget, action: 'CORRECT', replacement: changed });
assert.equal(preview.deltaRows.length, 2, 'product/warehouse/date change must reverse and re-apply as separate rows');
assert.deepEqual(preview.deltaRows.map(row => [row.role, row.proposedSignedQuantity]), [
  ['REVERSE_CURRENT_EFFECT', -5], ['APPLY_REVISED_EFFECT', -3]
]);
const correctCommand = buildOfficialVoucherRevisionCommandV2({
  target: purchaseTarget, action: 'CORRECT', replacement: changed, stocktakeDecisions: [],
  productOwnerSnapshot,
  actor: 'USER-7A', occurredAt: '2026-09-05T09:00:00+09:00', reason: '상품과 수량 정정'
});
assertOfficialVoucherRevisionCommandV2(correctCommand);
assert.equal(correctCommand.commandId, correctCommand.idempotencyKey);
const correctPlan = planOfficialVoucherRevisionCommandV2({ command: correctCommand, target: purchaseTarget });
assert.equal(correctPlan.voucherRevision.revision, 2);
assert.equal(correctPlan.voucherRevision.action, 'CORRECT');
assert.equal(correctPlan.inventoryMovements.length, 2);
assert.equal(correctPlan.inventoryMovements[0].effectStatus, 'REVERSED');
assert.equal(correctPlan.inventoryMovements[1].effectStatus, 'APPLIED_NORMAL');
assert.equal(correctPlan.voucherRevision.effects.some(row => ['PAYABLE', 'RECEIVABLE'].includes(row.type)), false);
assert.equal(correctPlan.document.status, 'CONFIRMED');
assert.equal(correctPlan.lines[0].inventoryEffectFactor, 1);

const saleZeroTarget = targetFixture('SALE', { quantity: 0, unitPrice: 0 });
const cancelCommand = buildOfficialVoucherRevisionCommandV2({
  target: saleZeroTarget, action: 'CANCEL', stocktakeDecisions: [], actor: 'USER-7A',
  occurredAt: '2026-09-05T10:00:00+09:00', reason: '판매 취소'
});
const cancelPlan = planOfficialVoucherRevisionCommandV2({ command: cancelCommand, target: saleZeroTarget });
assert.equal(cancelPlan.document.status, 'CANCELLED');
assert.equal(cancelPlan.lines[0].lineStatus, 'CANCELLED');
assert.equal(cancelPlan.inventoryMovements[0].effectStatus, 'ZERO_EFFECT');
assert.equal(cancelPlan.inventoryMovements[0].reversalStatus, 'REVERSED');
assert.equal(cancelPlan.inventoryMovements[0].signedQuantity, 0);

const unresolvedTarget = targetFixture('PURCHASE', { productId: '', productCode: 'UNMATCHED-1', quantity: -4 });
const resolved = replacementFor(unresolvedTarget, { productId: 'PRODUCT-3', productCode: '0003', quantity: -4 });
const unresolvedCommand = buildOfficialVoucherRevisionCommandV2({
  target: unresolvedTarget, action: 'CORRECT', replacement: resolved, stocktakeDecisions: [],
  productOwnerSnapshot,
  actor: 'USER-7A', occurredAt: '2026-09-05T11:00:00+09:00', reason: '미매칭 정정'
});
const unresolvedPlan = planOfficialVoucherRevisionCommandV2({ command: unresolvedCommand, target: unresolvedTarget });
assert.equal(unresolvedPlan.pendingSupersessions.length, 1);
assert.equal(unresolvedPlan.pendingCreations.length, 0);
assert.equal(unresolvedPlan.inventoryMovements[0].signedQuantity, -4);

const checkpoint = {
  checkpointId: 'CHECKPOINT-W1', companyId: COMPANY, warehouseId: 'W1', effectiveAt: '2026-09-04',
  businessDate: '2026-09-04', status: 'CONFIRMED', coversAllProducts: true,
  counts: [{ productId: 'PRODUCT-1', productCode: '0001', quantity: 100 }]
};
const conflictPreview = previewOfficialVoucherRevisionV2({
  target: purchaseTarget, action: 'CANCEL', inventoryCheckpoints: [checkpoint]
});
assert.equal(conflictPreview.conflicts.length, 1);
assert.throws(() => buildOfficialVoucherRevisionCommandV2({
  target: purchaseTarget, action: 'CANCEL', inventoryCheckpoints: [checkpoint], stocktakeDecisions: [],
  actor: 'USER-7A', occurredAt: '2026-09-05T12:00:00+09:00', reason: '취소'
}), /STOCKTAKE_DECISIONS_INCOMPLETE/);
const conflict = conflictPreview.conflicts[0];
const sameDayCheckpoint = { ...checkpoint, checkpointId: 'CHECKPOINT-W1-SAME-DAY',
  effectiveAt: '2026-09-03', businessDate: '2026-09-03' };
const sameDayPreview = previewOfficialVoucherRevisionV2({
  target: purchaseTarget, action: 'CANCEL', inventoryCheckpoints: [sameDayCheckpoint]
});
assert.equal(sameDayPreview.deltaRows[0].classification, 'SAME_DAY_ORDER_UNPROVEN');
assert.equal(sameDayPreview.deltaRows[0].requiresDecision, true);
const stocktakeCommand = buildOfficialVoucherRevisionCommandV2({
  target: purchaseTarget, action: 'CANCEL', inventoryCheckpoints: [checkpoint],
  stocktakeDecisions: [{ deltaId: conflict.deltaId, decisionType: 'INCLUDED_IN_CHECKPOINT',
    checkpointId: conflict.checkpointId, checkpointEffectiveAt: conflict.checkpointEffectiveAt,
    targetBusinessDate: conflict.businessDate, actor: 'USER-7A', judgedAt: '2026-09-05T12:00:00+09:00' }],
  actor: 'USER-7A', occurredAt: '2026-09-05T12:01:00+09:00', reason: '실사 포함 취소'
});
const stocktakePlan = planOfficialVoucherRevisionCommandV2({
  command: stocktakeCommand, target: purchaseTarget, inventoryCheckpoints: [checkpoint]
});
assert.deepEqual([
  stocktakePlan.inventoryMovements[0].effectStatus,
  stocktakePlan.inventoryMovements[0].stocktakeEffectStatus,
  stocktakePlan.inventoryMovements[0].officialInventoryApplied,
  stocktakePlan.inventoryMovements[0].signedQuantity
], ['REVERSED', 'ABSORBED_BY_CHECKPOINT', false, 0]);

assert.throws(() => previewOfficialVoucherRevisionV2({
  target: targetFixture('PURCHASE', { partnerEntryIds: ['PAYABLE-A'] }), action: 'CANCEL'
}), /ARAP_EFFECT_UNSUPPORTED/);
assert.throws(() => assertOfficialVoucherRevisionCommandV2({ ...correctCommand, expectedRevision: 99 }),
  /COMMAND_SCOPE_INVALID|COMMAND_PAYLOAD/);
assert.throws(() => assertOfficialVoucherRevisionCommandV2({ ...correctCommand,
  replacement: { ...correctCommand.replacement, lines: correctCommand.replacement.lines.map(line => ({ ...line, quantity: 77 })) } }),
  /DELTA_DIGEST|COMMAND_PAYLOAD|QUANTITY/);
assert.throws(() => buildOfficialVoucherRevisionCommandV2({
  target: purchaseTarget, action: 'CANCEL', stocktakeDecisions: [], actor: 'USER-7A',
  occurredAt: '2026-02-30T12:00:00+09:00', reason: 'invalid date'
}), /OCCURRED_AT_INVALID/);

let writes = 0;
const gateway = createOfficialCommandGateway({
  runOfficialVoucherRevisionCommand: async command => {
    writes += 1;
    const plan = planOfficialVoucherRevisionCommandV2({ command, target: purchaseTarget });
    return { document: plan.document, voucherRevision: plan.voucherRevision, ledgerEntries: [], duplicate: false };
  }
}, { revisionFeatureGates: { CORRECT_PURCHASE: true } });
assert.deepEqual(await gateway.executeRevision({ cancelled: true }), { cancelled: true, duplicate: false, officialWrites: 0 });
assert.equal(writes, 0);
await gateway.executeRevision(correctCommand);
assert.equal(writes, 1);
assert.throws(() => createOfficialCommandGateway({}, {}).executeRevision(correctCommand), /FEATURE_DISABLED/);

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-07A', status: 'PASS',
  purchaseCorrectionMovements: correctPlan.inventoryMovements.length,
  saleCancelZeroEffect: cancelPlan.inventoryMovements[0].effectStatus,
  unresolvedToMatched: unresolvedPlan.inventoryMovements.length,
  stocktakeStatuses: stocktakePlan.inventoryMovements.map(row => [row.effectStatus, row.stocktakeEffectStatus]),
  arApMutationCount: 0, cancelBeforeGatewayWrites: 0
}, null, 2));
