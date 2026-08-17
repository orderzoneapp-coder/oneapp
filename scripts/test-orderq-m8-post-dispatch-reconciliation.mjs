import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DISPATCH_ADJUSTMENT_STEP,
  DISPATCH_RECONCILIATION_STATUS,
  dispatchAdjustmentFingerprint,
  normalizeDispatchAdjustmentCommand,
  normalizeReconciliationCompletionCommand,
  normalizeReconciliationIssueCommand,
  quantityDifference,
  reconciliationCheckpoint,
  reconciliationCompletionFingerprint,
  reconciliationIssueFingerprint
} from '../orderq/dispatch-reconciliation.js';

const command = normalizeReconciliationIssueCommand({
  dispatchId: 'DSP-1',
  expectedRevision: 3,
  idempotencyKey: 'RECON-1',
  reasonCode: 'actual_shipment_mismatch',
  reasonNote: '현장 확인값과 차이',
  lines: [{
    dispatchLineId: 'DL-1',
    actualQuantity: 2,
    actualBaseQuantity: 0,
    recognizedOrderQuantity: 10,
    allocations: [{ allocationId: 'DA-1', actualBaseQuantity: 0 }]
  }]
});
assert.equal(command.reasonCode, 'ACTUAL_SHIPMENT_MISMATCH');
assert.equal(command.lines[0].actualBaseQuantity, 0, 'numeric zero must not be treated as blank');
assert.equal(command.lines[0].allocations[0].actualBaseQuantity, 0, 'allocation zero must be preserved');
assert.equal(quantityDifference(5, 0), -5, 'negative difference must not be clamped to zero');

const reordered = {
  ...command,
  lines: [...command.lines].reverse().map(line => ({ ...line, allocations: [...line.allocations].reverse() }))
};
assert.equal(reconciliationIssueFingerprint(command), reconciliationIssueFingerprint(reordered));

const adjustment = normalizeDispatchAdjustmentCommand({
  reconciliationId: 'DR-1', expectedRevision: 1, idempotencyKey: 'ADJUST-1', reason: '실제 출고 1개 감소'
});
assert.equal(adjustment.reconciliationId, 'DR-1');
assert.equal(dispatchAdjustmentFingerprint(adjustment), dispatchAdjustmentFingerprint({ ...adjustment }));
assert.throws(
  () => dispatchAdjustmentFingerprint({ ...adjustment, reason: '' }),
  /ORDERQ_ADJUST_REASON_REQUIRED/
);

const completion = normalizeReconciliationCompletionCommand({
  reconciliationId: 'DR-1', expectedRevision: 2, idempotencyKey: 'COMPLETE-1'
});
const completionEvidence = {
  correctionDispatchId: 'DSP-COR-1',
  correctionSalesDocumentId: 'SD-DSP-COR-1',
  correctionConfirmationFingerprint: 'CONFIRM-FP-1'
};
assert.equal(completion.expectedRevision, 2);
assert.equal(
  reconciliationCompletionFingerprint(completion, completionEvidence),
  reconciliationCompletionFingerprint({ ...completion, ...completionEvidence }, completionEvidence)
);
assert.notEqual(
  reconciliationCompletionFingerprint({ ...completion, expectedRevision: 3 }, completionEvidence),
  reconciliationCompletionFingerprint(completion, completionEvidence),
  'completion revision must participate in the idempotency fingerprint'
);
assert.notEqual(
  reconciliationCompletionFingerprint({ ...completion, correctionConfirmationFingerprint: 'DIFFERENT' }, completionEvidence),
  reconciliationCompletionFingerprint(completion, completionEvidence),
  'confirmed result fingerprint must participate in the completion fingerprint'
);

assert.deepEqual(Object.values(DISPATCH_RECONCILIATION_STATUS), [
  'REVIEW_REQUIRED', 'RESOLVED_NO_CHANGE', 'CORRECTION_DRAFT_CREATED', 'CORRECTED'
]);
assert.throws(
  () => reconciliationCheckpoint({ failureAt: DISPATCH_ADJUSTMENT_STEP.CORRECTION_DRAFT_WRITTEN }, DISPATCH_ADJUSTMENT_STEP.CORRECTION_DRAFT_WRITTEN),
  /ORDERQ_RECONCILIATION_FAILURE_INJECTED:CORRECTION_DRAFT_WRITTEN/
);

const repository = fs.readFileSync(new URL('../orderq/dispatch-reconciliation-repository.js', import.meta.url), 'utf8');
const confirmationRepository = fs.readFileSync(new URL('../orderq/dispatch-confirmation-repository.js', import.meta.url), 'utf8');
const dataOps = fs.readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../DataOps_orderq_reconciliation_bridge.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../orderq/reconciliation.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../orderq/reconciliation-ui.js', import.meta.url), 'utf8');

assert.match(confirmationRepository, /export async function reverseDispatchInTransaction/);
assert.match(repository, /reverseDispatchInTransaction/);
assert.match(repository, /ERP_POSTING_STATUS\.POSTED/);
assert.match(repository, /ERP_POSTING_STATUS\.CORRECTION_REQUIRED/);
assert.match(repository, /originalErpDocumentNo/);
assert.match(repository, /erpAutoCancelRequested:\s*false/);
assert.match(repository, /erpAutoRetransmitRequested:\s*false/);
assert.match(repository, /validateDispatchDraftPlan\(\{ lines, allocations, strict: true \}\)/);
assert.match(repository, /status:\s*'LOCAL_ONLY',\s*localOnly:\s*true/);
assert.match(repository, /ORDERQ_ADJUST_SOURCE_REVISION_STALE/);
assert.match(repository, /ORDERQ_RECONCILIATION_COMPLETION_MISMATCH/);
assert.match(repository, /completionRequestFingerprint/);
assert.match(repository, /correctionOfDispatchLineId/);
assert.match(repository, /correctionOfAllocationId/);
assert.match(repository, /workerReportedQuantity[\s\S]*workerReportedProductId[\s\S]*workerExceptionCode[\s\S]*workerExceptionMemo/);
assert.match(repository, /actualRecordedAt[\s\S]*actualRecordedBy[\s\S]*reservationId/);
assert.match(repository, /reconciliationCheckpoint\(options, DISPATCH_ADJUSTMENT_STEP\.BEFORE_COMMIT\)/);
assert.doesNotMatch(repository, /tx\.objectStore\(STORE\.SALES_DOCUMENTS\)\.put\(aggregate\.salesDocument/);
assert.doesNotMatch(repository, /tx\.objectStore\(STORE\.INVENTORY_MOVEMENTS\)\.put\(/);

assert.match(dataOps, /orderQReconciliationBridge\.src = '\.\/DataOps_orderq_reconciliation_bridge\.js/);
assert.match(bridge, /orderq-reconciliation-open/);
assert.match(bridge, /\.\/orderq\/reconciliation\.html/);
assert.doesNotMatch(bridge, /indexedDB|openOrderQDb|objectStore/);
assert.match(page, /확정사실은 읽기 전용입니다/);
assert.match(page, /기존 확정 취소 → 수정 출고안 → 다시 확정/);
assert.match(ui, /createDispatchReconciliationIssue/);
assert.match(ui, /adjustDispatchAfterShipment/);
assert.match(ui, /completeDispatchReconciliation/);
assert.match(ui, /확정 원본 직접수정 금지/);

console.log('ORDER Q M8 post-dispatch reconciliation and append-only correction contract tests passed');
