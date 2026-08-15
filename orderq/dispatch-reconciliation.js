export const DISPATCH_RECONCILIATION_STATUS = Object.freeze({
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  RESOLVED_NO_CHANGE: 'RESOLVED_NO_CHANGE',
  CORRECTION_DRAFT_CREATED: 'CORRECTION_DRAFT_CREATED',
  CORRECTED: 'CORRECTED'
});

export const DISPATCH_RECONCILIATION_ISSUE_TYPE = Object.freeze({
  SHIPMENT_FACT_MISMATCH: 'SHIPMENT_FACT_MISMATCH'
});

export const DISPATCH_ADJUSTMENT_STEP = Object.freeze({
  REVERSAL_WRITTEN: 'REVERSAL_WRITTEN',
  CORRECTION_DRAFT_WRITTEN: 'CORRECTION_DRAFT_WRITTEN',
  ISSUE_UPDATED: 'ISSUE_UPDATED',
  BEFORE_COMMIT: 'BEFORE_COMMIT'
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function exactNumber(value, errorCode) {
  if (value === '' || value === null || value === undefined) throw new Error(errorCode);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(errorCode);
  return number;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function normalizeVerifiedAllocation(source = {}) {
  const allocationId = text(source.allocationId);
  if (!allocationId) throw new Error('ORDERQ_RECONCILIATION_ALLOCATION_ID_REQUIRED');
  return {
    allocationId,
    actualBaseQuantity: exactNumber(
      source.actualBaseQuantity ?? source.verifiedBaseQuantity,
      `ORDERQ_RECONCILIATION_ALLOCATION_QUANTITY_INVALID:${allocationId}`
    )
  };
}

function normalizeVerifiedLine(source = {}) {
  const dispatchLineId = text(source.dispatchLineId);
  if (!dispatchLineId) throw new Error('ORDERQ_RECONCILIATION_LINE_ID_REQUIRED');
  const allocations = (Array.isArray(source.allocations) ? source.allocations : [])
    .map(normalizeVerifiedAllocation)
    .sort((left, right) => left.allocationId.localeCompare(right.allocationId));
  if (new Set(allocations.map(row => row.allocationId)).size !== allocations.length) {
    throw new Error(`ORDERQ_RECONCILIATION_ALLOCATION_DUPLICATE:${dispatchLineId}`);
  }
  return {
    dispatchLineId,
    actualQuantity: exactNumber(
      source.actualQuantity ?? source.verifiedActualQuantity,
      `ORDERQ_RECONCILIATION_ACTUAL_QUANTITY_INVALID:${dispatchLineId}`
    ),
    actualBaseQuantity: exactNumber(
      source.actualBaseQuantity ?? source.verifiedBaseQuantity,
      `ORDERQ_RECONCILIATION_BASE_QUANTITY_INVALID:${dispatchLineId}`
    ),
    recognizedOrderQuantity: exactNumber(
      source.recognizedOrderQuantity ?? source.verifiedRecognizedOrderQuantity,
      `ORDERQ_RECONCILIATION_RECOGNIZED_QUANTITY_INVALID:${dispatchLineId}`
    ),
    allocations
  };
}

export function normalizeReconciliationIssueCommand(source = {}) {
  const dispatchId = text(source.dispatchId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  const reasonCode = text(source.reasonCode).toUpperCase();
  const reasonNote = text(source.reasonNote);
  if (!dispatchId) throw new Error('ORDERQ_RECONCILIATION_DISPATCH_ID_REQUIRED');
  if (!idempotencyKey) throw new Error('ORDERQ_RECONCILIATION_IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_RECONCILIATION_REVISION_REQUIRED');
  if (!reasonCode) throw new Error('ORDERQ_RECONCILIATION_REASON_CODE_REQUIRED');
  if (!reasonNote) throw new Error('ORDERQ_RECONCILIATION_REASON_NOTE_REQUIRED');
  const lines = (Array.isArray(source.lines) ? source.lines : [])
    .map(normalizeVerifiedLine)
    .sort((left, right) => left.dispatchLineId.localeCompare(right.dispatchLineId));
  if (!lines.length) throw new Error('ORDERQ_RECONCILIATION_LINE_REQUIRED');
  if (new Set(lines.map(row => row.dispatchLineId)).size !== lines.length) {
    throw new Error('ORDERQ_RECONCILIATION_LINE_DUPLICATE');
  }
  return {
    dispatchId,
    idempotencyKey,
    expectedRevision,
    issueType: DISPATCH_RECONCILIATION_ISSUE_TYPE.SHIPMENT_FACT_MISMATCH,
    reasonCode,
    reasonNote,
    lines
  };
}

export function reconciliationIssueFingerprint(source = {}) {
  const command = normalizeReconciliationIssueCommand(source);
  return JSON.stringify(stableValue({
    dispatchId: command.dispatchId,
    expectedRevision: command.expectedRevision,
    issueType: command.issueType,
    reasonCode: command.reasonCode,
    reasonNote: command.reasonNote,
    lines: command.lines
  }));
}

export function normalizeDispatchAdjustmentCommand(source = {}) {
  const reconciliationId = text(source.reconciliationId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  const reason = text(source.reason);
  if (!reconciliationId) throw new Error('ORDERQ_ADJUST_RECONCILIATION_ID_REQUIRED');
  if (!idempotencyKey) throw new Error('ORDERQ_ADJUST_IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_ADJUST_REVISION_REQUIRED');
  if (!reason) throw new Error('ORDERQ_ADJUST_REASON_REQUIRED');
  return { reconciliationId, idempotencyKey, expectedRevision, reason };
}

export function dispatchAdjustmentFingerprint(source = {}) {
  const command = normalizeDispatchAdjustmentCommand(source);
  return JSON.stringify(stableValue({
    reconciliationId: command.reconciliationId,
    expectedRevision: command.expectedRevision,
    reason: command.reason
  }));
}

export function normalizeReconciliationCompletionCommand(source = {}) {
  const reconciliationId = text(source.reconciliationId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  if (!reconciliationId) throw new Error('ORDERQ_RECONCILIATION_COMPLETE_ID_REQUIRED');
  if (!idempotencyKey) throw new Error('ORDERQ_RECONCILIATION_COMPLETE_IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('ORDERQ_RECONCILIATION_COMPLETE_REVISION_REQUIRED');
  }
  return {
    reconciliationId,
    idempotencyKey,
    expectedRevision,
    correctionDispatchId: text(source.correctionDispatchId),
    correctionSalesDocumentId: text(source.correctionSalesDocumentId),
    correctionConfirmationFingerprint: text(source.correctionConfirmationFingerprint)
  };
}

export function reconciliationCompletionFingerprint(source = {}, confirmedEvidence = {}) {
  const command = normalizeReconciliationCompletionCommand(source);
  return JSON.stringify(stableValue({
    reconciliationId: command.reconciliationId,
    expectedRevision: command.expectedRevision,
    correctionDispatchId: command.correctionDispatchId || text(confirmedEvidence.correctionDispatchId),
    correctionSalesDocumentId: command.correctionSalesDocumentId || text(confirmedEvidence.correctionSalesDocumentId),
    correctionConfirmationFingerprint: command.correctionConfirmationFingerprint
      || text(confirmedEvidence.correctionConfirmationFingerprint)
  }));
}

export function reconciliationCheckpoint(options = {}, step) {
  if (typeof options.onStep === 'function') options.onStep(step);
  if (text(options.failureAt).toUpperCase() === step) {
    throw new Error(`ORDERQ_RECONCILIATION_FAILURE_INJECTED:${step}`);
  }
}

export function quantityDifference(expected, actual) {
  const expectedNumber = Number(expected);
  const actualNumber = Number(actual);
  if (!Number.isFinite(expectedNumber) || !Number.isFinite(actualNumber)) {
    throw new Error('ORDERQ_RECONCILIATION_DIFFERENCE_INVALID');
  }
  return actualNumber - expectedNumber;
}
