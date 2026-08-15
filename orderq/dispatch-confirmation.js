import { FULFILLMENT_TYPE, quantityFromUnits, quantityUnits } from './dispatch-workbench.js?v=0.8.0';

export const DISPATCH_CONFIRMATION_STEP = Object.freeze({
  SALES_WRITTEN: 'SALES_WRITTEN',
  MOVEMENTS_WRITTEN: 'MOVEMENTS_WRITTEN',
  FULFILLMENT_WRITTEN: 'FULFILLMENT_WRITTEN',
  RESERVATIONS_CONSUMED: 'RESERVATIONS_CONSUMED',
  BEFORE_COMMIT: 'BEFORE_COMMIT'
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function normalizeDispatchConfirmationCommand(source = {}) {
  const dispatchId = text(source.dispatchId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  if (!dispatchId) throw new Error('ORDERQ_CONFIRM_DISPATCH_ID_REQUIRED');
  if (!idempotencyKey) throw new Error('ORDERQ_CONFIRM_IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_CONFIRM_REVISION_REQUIRED');
  const lineInputs = Array.isArray(source.lines) ? source.lines.map(row => ({
    dispatchLineId: text(row.dispatchLineId),
    ...(hasOwn(row, 'actualQuantity') ? { actualQuantity: quantityFromUnits(quantityUnits(row.actualQuantity)) } : {}),
    ...(hasOwn(row, 'recognizedOrderQuantity') ? { recognizedOrderQuantity: quantityFromUnits(quantityUnits(row.recognizedOrderQuantity)) } : {}),
    allocations: (Array.isArray(row.allocations) ? row.allocations : []).map(allocation => ({
      allocationId: text(allocation.allocationId),
      actualBaseQuantity: quantityFromUnits(quantityUnits(allocation.actualBaseQuantity))
    })).sort((left, right) => left.allocationId.localeCompare(right.allocationId))
  })).sort((left, right) => left.dispatchLineId.localeCompare(right.dispatchLineId)) : [];
  if (lineInputs.some(row => !row.dispatchLineId)) throw new Error('ORDERQ_CONFIRM_LINE_ID_REQUIRED');
  return { dispatchId, expectedRevision, idempotencyKey, lines: lineInputs };
}

export function dispatchConfirmationFingerprint(command = {}) {
  const normalized = normalizeDispatchConfirmationCommand(command);
  return JSON.stringify(stableValue({
    dispatchId: normalized.dispatchId,
    expectedRevision: normalized.expectedRevision,
    lines: normalized.lines
  }));
}

export function resolveNormalDispatchActuals({ lines = [], allocations = [], command = {} } = {}) {
  const normalizedCommand = normalizeDispatchConfirmationCommand(command);
  const inputByLine = new Map(normalizedCommand.lines.map(row => [row.dispatchLineId, row]));
  const allocationIds = new Set(allocations.map(row => text(row.allocationId)));
  for (const input of normalizedCommand.lines) {
    if (!lines.some(line => text(line.dispatchLineId) === input.dispatchLineId)) {
      throw new Error(`ORDERQ_CONFIRM_LINE_UNKNOWN:${input.dispatchLineId}`);
    }
    for (const allocation of input.allocations) {
      if (!allocationIds.has(allocation.allocationId)) throw new Error(`ORDERQ_CONFIRM_ALLOCATION_UNKNOWN:${allocation.allocationId}`);
    }
  }

  return lines.map(line => {
    const dispatchLineId = text(line.dispatchLineId);
    const input = inputByLine.get(dispatchLineId) || {};
    if (text(line.fulfillmentType).toUpperCase() !== FULFILLMENT_TYPE.NORMAL) {
      throw new Error(`ORDERQ_CONFIRM_M4_NORMAL_ONLY:${dispatchLineId}`);
    }
    if (!text(line.actualProductId) || text(line.actualProductId) !== text(line.requestedProductId)) {
      throw new Error(`ORDERQ_CONFIRM_M4_PRODUCT_MISMATCH:${dispatchLineId}`);
    }
    if (text(line.workerReportedProductId) && text(line.workerReportedProductId) !== text(line.actualProductId)) {
      throw new Error(`ORDERQ_CONFIRM_M5_WORKER_PRODUCT_MISMATCH:${dispatchLineId}`);
    }
    if (line.measurementRequired) throw new Error(`ORDERQ_CONFIRM_M5_MEASUREMENT_REQUIRED:${dispatchLineId}`);

    const actualQuantity = hasOwn(input, 'actualQuantity')
      ? input.actualQuantity
      : (line.workerReportedQuantity ?? line.plannedActualQuantity ?? line.plannedBaseQuantity);
    const actualUnits = quantityUnits(actualQuantity);
    const plannedUnits = quantityUnits(line.plannedBaseQuantity ?? line.plannedActualQuantity);
    if (actualUnits <= 0) throw new Error(`ORDERQ_CONFIRM_ACTUAL_QUANTITY_REQUIRED:${dispatchLineId}`);
    if (actualUnits > plannedUnits) throw new Error(`ORDERQ_CONFIRM_OVER_DISPATCH_REQUIRES_M5:${dispatchLineId}`);

    const recognizedOrderQuantity = hasOwn(input, 'recognizedOrderQuantity') ? input.recognizedOrderQuantity : actualQuantity;
    if (quantityUnits(recognizedOrderQuantity) !== actualUnits) {
      throw new Error(`ORDERQ_CONFIRM_M4_RECOGNIZED_QUANTITY_MISMATCH:${dispatchLineId}`);
    }

    const lineAllocations = allocations.filter(row => text(row.dispatchLineId) === dispatchLineId)
      .sort((left, right) => text(left.allocationId).localeCompare(text(right.allocationId)));
    if (!lineAllocations.length) throw new Error(`ORDERQ_CONFIRM_ALLOCATION_REQUIRED:${dispatchLineId}`);
    const inputAllocations = new Map((input.allocations || []).map(row => [row.allocationId, row.actualBaseQuantity]));
    let actualAllocations;
    if (inputAllocations.size) {
      if (inputAllocations.size !== lineAllocations.length) throw new Error(`ORDERQ_CONFIRM_ALLOCATION_ACTUAL_INCOMPLETE:${dispatchLineId}`);
      actualAllocations = lineAllocations.map(allocation => ({
        ...allocation,
        actualBaseQuantity: inputAllocations.get(text(allocation.allocationId))
      }));
    } else if (actualUnits === plannedUnits) {
      actualAllocations = lineAllocations.map(allocation => ({ ...allocation, actualBaseQuantity: allocation.plannedBaseQuantity }));
    } else if (lineAllocations.length === 1) {
      actualAllocations = [{ ...lineAllocations[0], actualBaseQuantity: actualQuantity }];
    } else {
      throw new Error(`ORDERQ_CONFIRM_ALLOCATION_ACTUAL_REQUIRED:${dispatchLineId}`);
    }

    const allocationUnits = actualAllocations.reduce((sum, allocation) => {
      const units = quantityUnits(allocation.actualBaseQuantity);
      if (units < 0 || units > quantityUnits(allocation.plannedBaseQuantity)) {
        throw new Error(`ORDERQ_CONFIRM_ALLOCATION_ACTUAL_INVALID:${allocation.allocationId}`);
      }
      return sum + units;
    }, 0);
    if (allocationUnits !== actualUnits) throw new Error(`ORDERQ_CONFIRM_ALLOCATION_SUM_MISMATCH:${dispatchLineId}`);

    return {
      line,
      actualQuantity: quantityFromUnits(actualUnits),
      actualBaseQuantity: quantityFromUnits(allocationUnits),
      recognizedOrderQuantity: quantityFromUnits(actualUnits),
      allocations: actualAllocations.map(allocation => ({
        allocation,
        actualBaseQuantity: quantityFromUnits(quantityUnits(allocation.actualBaseQuantity))
      }))
    };
  });
}

export function confirmationCheckpoint(options = {}, step) {
  if (typeof options.onStep === 'function') options.onStep(step);
  if (text(options.failureAt).toUpperCase() === step) {
    throw new Error(`ORDERQ_CONFIRMATION_FAILURE_INJECTED:${step}`);
  }
}

export function buildDispatchConfirmationKey(dispatchId, revision) {
  const id = text(dispatchId);
  const normalizedRevision = Number(revision);
  if (!id || !Number.isInteger(normalizedRevision) || normalizedRevision < 1) throw new Error('ORDERQ_CONFIRMATION_KEY_SOURCE_REQUIRED');
  return `DISPATCH_CONFIRM:${id}:${normalizedRevision}`;
}
