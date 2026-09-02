#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  assertInventoryRematchCommandV2,
  buildInventoryRematchCommandV2,
  planInventoryRematchCommandV2
} from '../orderq/inventory-rematch-core.js';
import { createOfficialCommandGateway } from '../orderq/official-command-gateway.js';
import { previewUnresolvedRematchImpact } from '../orderq/unresolved-review-read-model.js';

const companyId = 'COMPANY-A';
const unresolvedProductId = 'UP-6C-MIXED';
const selectedProduct = {
  productId: 'PRODUCT-SELECTED', companyId, productCode: '0007', productName: '동일 이름', specification: '10kg', unit: 'BOX'
};
const productSnapshot = {
  schemaVersion: 'ONEAPP_PRODUCT_SNAPSHOT_V1', snapshotId: 'PRODUCT-REV-77-abcdef123456', revision: '77',
  contentHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
};

const linkSpecs = [
  { id: 'P-AFTER', mode: 'purchase', date: '2026-09-03', quantity: 5, signedQuantity: 5, warehouseId: 'W1' },
  { id: 'P-AFTER-ZERO', mode: 'purchase', date: '2026-09-04', quantity: 0, signedQuantity: 0, warehouseId: 'W1' },
  { id: 'S-AFTER', mode: 'sale', date: '2026-09-04', quantity: 2, signedQuantity: -2, warehouseId: 'W1' },
  { id: 'P-BEFORE-ZERO', mode: 'purchase', date: '2026-09-01', quantity: 0, signedQuantity: 0, warehouseId: 'W1' },
  { id: 'S-BEFORE-NEGATIVE', mode: 'sale', date: '2026-09-01', quantity: -3, signedQuantity: 3, warehouseId: 'W1' },
  { id: 'S-BEFORE-ZERO', mode: 'sale', date: '2026-09-01', quantity: 0, signedQuantity: 0, warehouseId: 'W1' },
  { id: 'S-SAME-DAY', mode: 'sale', date: '2026-09-02', quantity: 4, signedQuantity: -4, warehouseId: 'W1' },
  { id: 'P-NO-CHECKPOINT', mode: 'purchase', date: '2026-08-01', quantity: -6, signedQuantity: -6, warehouseId: 'W2' }
];

function sourceFixture() {
  const source = {
    unresolvedProducts: [], pendingInventoryEffects: [], inventoryCheckpoints: [{
      checkpointId: 'CHECKPOINT-W1', companyId, warehouseId: 'W1', effectiveAt: '2026-09-02', status: 'CONFIRMED',
      counts: [{ productId: selectedProduct.productId, productCode: selectedProduct.productCode, quantity: 100 }]
    }],
    purchaseDocuments: [], purchaseLines: [], salesDocuments: [], salesLines: [], voucherRevisions: []
  };
  const reviewLinks = [];
  linkSpecs.forEach((spec, index) => {
    const documentId = `${spec.mode === 'purchase' ? 'PD' : 'SD'}-${spec.id}`;
    const lineId = `${spec.mode === 'purchase' ? 'PL' : 'SL'}-${spec.id}`;
    const voucherRevisionId = `VR-${spec.id}`;
    const originalCommandId = `ORIGINAL-${spec.id}`;
    const document = {
      companyId, status: 'CONFIRMED', revision: 1, businessDate: spec.date,
      [spec.mode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId']: documentId,
      [spec.mode === 'purchase' ? 'purchaseDate' : 'saleDate']: spec.date
    };
    const line = {
      companyId, revision: 1, unresolvedProductId, productId: '', warehouseId: spec.warehouseId,
      actualQuantity: spec.quantity, productSnapshot: { originalProductCode: '0007', originalProductName: '동일 이름' },
      [spec.mode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId']: documentId,
      [spec.mode === 'purchase' ? 'purchaseLineId' : 'salesLineId']: lineId
    };
    source[spec.mode === 'purchase' ? 'purchaseDocuments' : 'salesDocuments'].push(document);
    source[spec.mode === 'purchase' ? 'purchaseLines' : 'salesLines'].push(line);
    source.voucherRevisions.push({
      voucherRevisionId, companyId, voucherMode: spec.mode, documentId, revision: 1,
      commandId: originalCommandId, status: 'CONFIRMED'
    });
    const effect = {
      pendingEffectId: `PE-${spec.id}`, companyId, unresolvedProductId, voucherMode: spec.mode,
      sourceDocumentId: documentId, sourceLineId: lineId, sourceDocumentRevision: 1,
      voucherRevisionId, commandId: originalCommandId, warehouseId: spec.warehouseId,
      effectiveAt: spec.date, quantity: spec.quantity, signedQuantity: spec.signedQuantity,
      unitPrice: 1000, totalAmount: spec.quantity * 1000, status: 'PENDING_PRODUCT_MATCH',
      inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
      originalProductCode: '0007', originalProductName: '동일 이름', specification: '10kg', unit: 'BOX',
      productSnapshot: { originalProductCode: '0007', originalProductName: '동일 이름', specification: '10kg', unit: 'BOX' }
    };
    source.pendingInventoryEffects.push(effect);
    reviewLinks.push({
      pendingEffectId: effect.pendingEffectId, voucherMode: spec.mode, sourceDocumentId: documentId,
      sourceLineId: lineId, sourceDocumentRevision: 1, voucherRevisionId, commandId: originalCommandId,
      warehouseId: spec.warehouseId, businessDate: spec.date, quantity: spec.quantity,
      signedQuantity: spec.signedQuantity, unitPrice: 1000, totalAmount: spec.quantity * 1000,
      inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
      productSnapshot: effect.productSnapshot
    });
  });
  source.unresolvedProducts.push({
    unresolvedProductId, unresolvedKey: unresolvedProductId, companyId, status: 'UNRESOLVED_PRODUCT', productId: '',
    originalProductCode: '0007', originalProductName: '동일 이름', specification: '10kg', unit: 'BOX', reviewLinks
  });
  return source;
}

const source = sourceFixture();
const preview = previewUnresolvedRematchImpact({ companyId, unresolvedProductId, selectedProduct, source,
  generatedAt: '2026-09-03T10:00:00+09:00' });
assert.equal(preview.summary.affectedDocumentCount, 8, 'multiple purchase/sale voucher links must remain explicit');
assert.equal(preview.summary.decisionRequiredCount, 4, 'before and same-day-unproven rows require decisions');
assert.equal(preview.summary.applyReadyCount, 4, 'after-checkpoint and no-checkpoint rows apply normally');

const expectedEffects = preview.impacts.map(impact => ({
  pendingEffectId: impact.pendingEffectId,
  voucherMode: impact.sourceVoucher.voucherMode,
  documentId: impact.sourceVoucher.documentId,
  lineId: impact.sourceVoucher.lineId,
  documentRevision: impact.sourceVoucher.documentRevision,
  voucherRevisionId: impact.sourceVoucher.revisionId
}));
const expectedDocuments = [...new Map(preview.impacts.map(impact => {
  const row = {
    voucherMode: impact.sourceVoucher.voucherMode, documentId: impact.sourceVoucher.documentId,
    revision: impact.sourceVoucher.documentRevision, voucherRevisionId: impact.sourceVoucher.revisionId
  };
  return [`${row.voucherMode}:${row.documentId}`, row];
})).values()];
const required = preview.impacts.filter(impact => impact.status === 'DECISION_REQUIRED');
const stocktakeDecisions = required.map(impact => ({
  pendingEffectId: impact.pendingEffectId,
  decisionType: ['PE-P-BEFORE-ZERO', 'PE-S-SAME-DAY'].includes(impact.pendingEffectId)
    ? 'INCLUDED_IN_CHECKPOINT' : 'NOT_INCLUDED_IN_CHECKPOINT',
  checkpointId: impact.checkpoint.checkpointId,
  checkpointEffectiveAt: impact.checkpoint.effectiveAt,
  targetBusinessDate: impact.businessDate,
  actor: 'USER-6C', judgedAt: '2026-09-03T10:00:00+09:00'
}));
const command = buildInventoryRematchCommandV2({
  companyId, unresolvedProductId, selectedProduct, productSnapshot,
  selectionEvidence: {
    selectionMode: 'EXPLICIT_USER_SELECTION', automaticConfirmation: false,
    selectedBy: 'USER-6C', selectedAt: '2026-09-03T10:00:00+09:00', productSnapshot
  },
  expectedDocuments, expectedEffects, stocktakeDecisions,
  actor: 'USER-6C', occurredAt: '2026-09-03T10:01:00+09:00', judgedAt: '2026-09-03T10:00:00+09:00'
});
assertInventoryRematchCommandV2(command);
assert.equal(command.commandId, command.idempotencyKey);
assert.equal(command.selectionEvidence.automaticConfirmation, false);

const plan = planInventoryRematchCommandV2({ command, preview });
assert.equal(plan.inventoryMovements.length, linkSpecs.length, 'each linked pending effect gets one deterministic audit effect');
assert.deepEqual(plan.inventoryMovements.map(row => row.originalSignedQuantity).sort((a, b) => a - b), [-6, -4, -2, 0, 0, 0, 3, 5],
  'zero, positive, negative and purchase/sale signs must survive deterministic sorting');
const normalZero = plan.inventoryMovements.find(row => row.pendingEffectId === 'PE-P-AFTER-ZERO');
const includedZero = plan.inventoryMovements.find(row => row.pendingEffectId === 'PE-P-BEFORE-ZERO');
const lateZero = plan.inventoryMovements.find(row => row.pendingEffectId === 'PE-S-BEFORE-ZERO');
assert.deepEqual([normalZero.effectStatus, normalZero.stocktakeEffectStatus, normalZero.officialInventoryApplied],
  ['ZERO_EFFECT', '', true]);
assert.deepEqual([includedZero.effectStatus, includedZero.stocktakeEffectStatus, includedZero.officialInventoryApplied],
  ['ZERO_EFFECT', 'ABSORBED_BY_CHECKPOINT', false]);
assert.deepEqual([lateZero.effectStatus, lateZero.stocktakeEffectStatus, lateZero.officialInventoryApplied],
  ['ZERO_EFFECT', 'APPLIED_AS_LATE_ADJUSTMENT', true]);
assert.equal(plan.inventoryMovements.filter(row => row.stocktakeEffectStatus === 'ABSORBED_BY_CHECKPOINT')
  .every(row => row.signedQuantity === 0 && row.officialInventoryApplied === false), true);
assert.equal(plan.inventoryMovements.filter(row => row.stocktakeEffectStatus === 'APPLIED_AS_LATE_ADJUSTMENT').length, 2);
assert.equal(plan.inventoryMovements.some(row => row.effectStatus === 'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE'), false);
assert.equal(new Set(plan.inventoryMovements.map(row => row.movementId)).size, linkSpecs.length);

assert.throws(() => planInventoryRematchCommandV2({
  command: buildInventoryRematchCommandV2({ ...command, commandId: '', idempotencyKey: '',
    commandPayloadDigest: '', stocktakeDecisions: stocktakeDecisions.slice(0, 2) }), preview
}), /ORDERQ_REMATCH_V2_STOCKTAKE_DECISIONS_INCOMPLETE/);
assert.throws(() => buildInventoryRematchCommandV2({ ...command, commandId: '', idempotencyKey: '', commandPayloadDigest: '',
  selectionEvidence: { ...command.selectionEvidence, automaticConfirmation: true } }),
/ORDERQ_REMATCH_V2_EXPLICIT_SELECTION_REQUIRED/);
assert.throws(() => buildInventoryRematchCommandV2({ ...command, commandId: '', idempotencyKey: '', commandPayloadDigest: '',
  selectedProduct: { ...selectedProduct, companyId: 'COMPANY-B' } }), /ORDERQ_REMATCH_V2_PRODUCT_COMPANY_MISMATCH/);
for (const invalid of [
  { occurredAt: '2026-02-30T10:01:00+09:00' },
  { judgedAt: '2026-02-30T10:00:00+09:00' },
  { selectionEvidence: { ...command.selectionEvidence, selectedAt: '2026-02-30T10:00:00+09:00' } }
]) {
  assert.throws(() => buildInventoryRematchCommandV2({ ...command, commandId: '', idempotencyKey: '',
    commandPayloadDigest: '', ...invalid }), /_INVALID/);
}
assert.throws(() => buildInventoryRematchCommandV2({ ...command, commandId: '', idempotencyKey: '', commandPayloadDigest: '',
  stocktakeDecisions: command.stocktakeDecisions.map((row, index) => index ? row : { ...row, targetBusinessDate: '2026-02-30' })
}), /CHECKPOINT_DATE_REQUIRED|TARGET_DATE_REQUIRED/);
assert.throws(() => assertInventoryRematchCommandV2({ ...command, selectedProduct: { ...selectedProduct, productId: 'SAME-NAME-OTHER' } }),
/ORDERQ_REMATCH_V2_COMMAND_ID_INVALID|ORDERQ_REMATCH_V2_COMMAND_PAYLOAD/);
assert.throws(() => planInventoryRematchCommandV2({ command, preview: {
  ...preview,
  impacts: preview.impacts.map((impact, index) => index ? impact : { ...impact, status: 'REVIEW_REQUIRED' })
} }), /ORDERQ_REMATCH_V2_LINK_INTEGRITY_REQUIRED/);
assert.throws(() => planInventoryRematchCommandV2({ command: buildInventoryRematchCommandV2({
  ...command, commandId: '', idempotencyKey: '', commandPayloadDigest: '',
  stocktakeDecisions: stocktakeDecisions.map((row, index) => index ? row : { ...row, checkpointId: 'STALE' })
}), preview }), /ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_STALE/);

let repositoryWrites = 0;
const gateway = createOfficialCommandGateway({
  runOfficialInventoryRematchCommand: async checkedCommand => {
    repositoryWrites += 1;
    return { ...plan, command: checkedCommand, duplicate: false };
  }
}, { featureGates: { INVENTORY_REMATCH: true } });
assert.equal((await gateway.executeInventoryRematch({ cancelled: true })).officialWrites, 0);
assert.equal(repositoryWrites, 0, 'cancel must not enter the Repository writer');
const gatewayResult = await gateway.executeInventoryRematch(command);
assert.equal(gatewayResult.inventoryMovements.length, linkSpecs.length);
assert.equal(repositoryWrites, 1, 'a committed request crosses exactly one Gateway writer port');
assert.throws(() => createOfficialCommandGateway({}, { featureGates: {} }).executeInventoryRematch(command),
  /ORDERQ_REMATCH_V2_FEATURE_DISABLED/);

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-06C', status: 'PASS', purchaseSaleLinks: linkSpecs.length,
  signedQuantities: plan.inventoryMovements.map(row => row.originalSignedQuantity),
  normal: plan.inventoryMovements.filter(row => row.effectStatus === 'APPLIED_NORMAL').length,
  zeroEffect: plan.inventoryMovements.filter(row => row.effectStatus === 'ZERO_EFFECT').length,
  absorbed: plan.inventoryMovements.filter(row => row.stocktakeEffectStatus === 'ABSORBED_BY_CHECKPOINT').length,
  lateAdjustments: plan.inventoryMovements.filter(row => row.stocktakeEffectStatus === 'APPLIED_AS_LATE_ADJUSTMENT').length,
  cancelWrites: 0, automaticSelection: false, forbiddenLegacyOmissions: 0
}, null, 2));
