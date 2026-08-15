import {
  CONVERSION_TYPE,
  CUSTOMER_NOTICE_STATUS,
  DISPATCH_PRICE_SOURCE,
  FULFILLMENT_TYPE,
  MEASUREMENT_STATUS,
  quantityFromUnits,
  quantityUnits
} from './dispatch-workbench.js?v=0.8.0';

export const DISPATCH_APPROVAL_TYPE = Object.freeze({
  SUBSTITUTE: 'SUBSTITUTE',
  OVER_DISPATCH: 'OVER_DISPATCH',
  SUBSTITUTE_DECISION_REVERSAL: 'SUBSTITUTE_DECISION_REVERSAL'
});

export const DISPATCH_APPROVAL_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REVERSED: 'REVERSED'
});

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

export function dispatchPriceFingerprint(line = {}) {
  const actualProductReferenceUnitPriceWon = Number(line.actualProductReferenceUnitPriceWon ?? line.actualProductUnitPriceWon ?? 0);
  const priceChangedFromOrder = Boolean(line.priceChangedFromOrder ?? line.priceChanged);
  return JSON.stringify(stableValue({
    priceSource: text(line.priceSource).toUpperCase() || DISPATCH_PRICE_SOURCE.ORDER_AGREED,
    orderAgreedUnitPriceWon: Number(line.orderAgreedUnitPriceWon ?? 0),
    actualProductReferenceUnitPriceWon,
    manualUnitPriceWon: Number(line.manualUnitPriceWon ?? 0),
    appliedUnitPriceWon: Number(line.appliedUnitPriceWon ?? 0),
    priceChangedFromOrder,
    priceChangeReason: text(line.priceChangeReason)
  }));
}

export function dispatchActualFingerprint(line = {}) {
  return JSON.stringify(stableValue({
    dispatchLineId: text(line.dispatchLineId),
    requestedProductId: text(line.requestedProductId),
    actualProductId: text(line.actualProductId),
    actualQuantity: Number(line.actualQuantity ?? 0),
    actualBaseQuantity: Number(line.actualBaseQuantity ?? 0),
    recognizedOrderQuantity: Number(line.recognizedOrderQuantity ?? 0),
    actualRevision: Number(line.actualRevision ?? 0),
    conversionRuleId: text(line.conversionRuleId),
    conversionRuleVersion: text(line.conversionRuleVersion),
    conversionRuleSnapshot: line.conversionRuleSnapshot || null,
    priceFingerprint: dispatchPriceFingerprint(line)
  }));
}

export function dispatchActualSetFingerprint(lines = []) {
  return JSON.stringify((Array.isArray(lines) ? lines : [])
    .map(line => ({ dispatchLineId: text(line.dispatchLineId), fingerprint: dispatchActualFingerprint(line) }))
    .sort((left, right) => left.dispatchLineId.localeCompare(right.dispatchLineId)));
}

export function isDispatchApprovalEffectivelyActive(approval = {}, approvals = []) {
  if (text(approval.status).toUpperCase() !== DISPATCH_APPROVAL_STATUS.ACTIVE) return false;
  return !(Array.isArray(approvals) ? approvals : []).some(row =>
    text(row.status).toUpperCase() === DISPATCH_APPROVAL_STATUS.REVERSED
    && (Array.isArray(row.reversalOfApprovalIds) ? row.reversalOfApprovalIds : []).includes(approval.approvalId));
}

export function resolveDispatchActuals({ lines = [], allocations = [], command = {}, allowMeasurementCapture = false } = {}) {
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
    const fulfillmentType = text(line.fulfillmentType).toUpperCase() || FULFILLMENT_TYPE.NORMAL;
    if (![FULFILLMENT_TYPE.NORMAL, FULFILLMENT_TYPE.SUBSTITUTE].includes(fulfillmentType)) {
      throw new Error(`ORDERQ_CONFIRM_FULFILLMENT_UNSUPPORTED:${dispatchLineId}`);
    }
    if (!text(line.actualProductId)) throw new Error(`ORDERQ_CONFIRM_ACTUAL_PRODUCT_REQUIRED:${dispatchLineId}`);
    if (fulfillmentType === FULFILLMENT_TYPE.SUBSTITUTE && text(line.actualProductId) === text(line.requestedProductId)) {
      throw new Error(`ORDERQ_CONFIRM_SUBSTITUTE_PRODUCT_REQUIRED:${dispatchLineId}`);
    }
    if (fulfillmentType !== FULFILLMENT_TYPE.SUBSTITUTE && text(line.actualProductId) !== text(line.requestedProductId)) {
      throw new Error(`ORDERQ_CONFIRM_SUBSTITUTE_TYPE_REQUIRED:${dispatchLineId}`);
    }
    if (text(line.workerReportedProductId) && text(line.workerReportedProductId) !== text(line.actualProductId)) {
      throw new Error(`ORDERQ_CONFIRM_M5_WORKER_PRODUCT_MISMATCH:${dispatchLineId}`);
    }
    const conversionType = text(line.conversionType).toUpperCase() || CONVERSION_TYPE.NONE;
    const snapshot = line.conversionRuleSnapshot;
    const converted = conversionType !== CONVERSION_TYPE.NONE;
    if (converted && (!text(line.conversionRuleId) || !text(line.conversionRuleVersion) || !snapshot
      || !(Number(snapshot.actualToBaseFactor) > 0) || !(Number(snapshot.actualToRecognizedFactor) > 0))) {
      throw new Error(`ORDERQ_CONFIRM_CONVERSION_SNAPSHOT_REQUIRED:${dispatchLineId}`);
    }
    if (line.measurementRequired && !allowMeasurementCapture
      && (text(line.measurementStatus).toUpperCase() !== MEASUREMENT_STATUS.MEASURED || !text(line.measuredAt) || !text(line.measuredBy))) {
      throw new Error(`ORDERQ_CONFIRM_MEASURE_PENDING:${dispatchLineId}`);
    }

    const actualQuantity = hasOwn(input, 'actualQuantity') ? input.actualQuantity : line.actualQuantity;
    if (actualQuantity === '' || actualQuantity === null || actualQuantity === undefined) {
      throw new Error(`ORDERQ_CONFIRM_ACTUAL_QUANTITY_REQUIRED:${dispatchLineId}`);
    }
    const actualUnits = quantityUnits(actualQuantity);
    if (actualUnits <= 0) throw new Error(`ORDERQ_CONFIRM_ACTUAL_QUANTITY_REQUIRED:${dispatchLineId}`);

    const recognizedOrderQuantity = hasOwn(input, 'recognizedOrderQuantity')
      ? input.recognizedOrderQuantity
      : line.recognizedOrderQuantity;
    if (recognizedOrderQuantity === '' || recognizedOrderQuantity === null || recognizedOrderQuantity === undefined) {
      throw new Error(`ORDERQ_CONFIRM_RECOGNIZED_QUANTITY_REQUIRED:${dispatchLineId}`);
    }
    const expectedBaseUnits = quantityUnits(quantityFromUnits(actualUnits) * (converted ? Number(snapshot.actualToBaseFactor) : 1));
    const expectedRecognizedUnits = quantityUnits(quantityFromUnits(actualUnits) * (converted ? Number(snapshot.actualToRecognizedFactor) : 1));
    if (quantityUnits(recognizedOrderQuantity) !== expectedRecognizedUnits) {
      throw new Error(`ORDERQ_CONFIRM_RECOGNIZED_QUANTITY_MISMATCH:${dispatchLineId}`);
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
    } else if (lineAllocations.every(allocation => allocation.actualBaseQuantity !== '' && allocation.actualBaseQuantity !== null && allocation.actualBaseQuantity !== undefined)) {
      actualAllocations = lineAllocations.map(allocation => ({ ...allocation, actualBaseQuantity: allocation.actualBaseQuantity }));
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
    if (allocationUnits !== expectedBaseUnits) throw new Error(`ORDERQ_CONFIRM_ALLOCATION_SUM_MISMATCH:${dispatchLineId}`);

    return {
      line,
      actualQuantity: quantityFromUnits(actualUnits),
      actualBaseQuantity: quantityFromUnits(expectedBaseUnits),
      recognizedOrderQuantity: quantityFromUnits(expectedRecognizedUnits),
      allocations: actualAllocations.map(allocation => ({
        allocation,
        actualBaseQuantity: quantityFromUnits(quantityUnits(allocation.actualBaseQuantity))
      }))
    };
  });
}

export function resolveNormalDispatchActuals(args = {}) {
  for (const line of args.lines || []) {
    if (text(line.fulfillmentType).toUpperCase() !== FULFILLMENT_TYPE.NORMAL
      || (text(line.conversionType).toUpperCase() && text(line.conversionType).toUpperCase() !== CONVERSION_TYPE.NONE)
      || line.measurementRequired) {
      throw new Error(`ORDERQ_CONFIRM_M4_NORMAL_ONLY:${line.dispatchLineId}`);
    }
  }
  const normalizedCommand = normalizeDispatchConfirmationCommand(args.command || {});
  for (const input of normalizedCommand.lines) {
    const line = (args.lines || []).find(row => text(row.dispatchLineId) === input.dispatchLineId);
    if (line && input.actualQuantity !== undefined
      && quantityUnits(input.actualQuantity) > quantityUnits(line.plannedActualQuantity ?? line.plannedBaseQuantity)) {
      throw new Error(`ORDERQ_CONFIRM_OVER_DISPATCH_REQUIRES_M5:${line.dispatchLineId}`);
    }
  }
  const resolved = resolveDispatchActuals(args);
  return resolved;
}

export function resolveDispatchPrice({ item = {}, line = {} } = {}) {
  const source = text(line.priceSource).toUpperCase() || DISPATCH_PRICE_SOURCE.ORDER_AGREED;
  const orderAgreedUnitPriceWon = Number(line.orderAgreedUnitPriceWon ?? item.price ?? item.unitPriceWon ?? 0);
  const actualReferenceSource = line.actualProductReferenceUnitPriceWon ?? line.actualProductUnitPriceWon;
  const actualProductPriceProvided = actualReferenceSource !== '' && actualReferenceSource !== null && actualReferenceSource !== undefined;
  const manualPriceProvided = (line.manualUnitPriceWon !== '' && line.manualUnitPriceWon !== null && line.manualUnitPriceWon !== undefined)
    || (line.appliedUnitPriceWon !== '' && line.appliedUnitPriceWon !== null && line.appliedUnitPriceWon !== undefined);
  const actualProductReferenceUnitPriceWon = Number(actualProductPriceProvided ? actualReferenceSource : 0);
  const manualUnitPriceWon = Number(line.manualUnitPriceWon ?? line.appliedUnitPriceWon ?? 0);
  if (![orderAgreedUnitPriceWon, actualProductReferenceUnitPriceWon, manualUnitPriceWon].every(Number.isFinite)) {
    throw new Error(`ORDERQ_CONFIRM_PRICE_INVALID:${line.dispatchLineId}`);
  }
  let appliedUnitPriceWon = orderAgreedUnitPriceWon;
  if (source === DISPATCH_PRICE_SOURCE.ACTUAL_PRODUCT) {
    if (!actualProductPriceProvided) throw new Error(`ORDERQ_CONFIRM_ACTUAL_PRODUCT_PRICE_REQUIRED:${line.dispatchLineId}`);
    appliedUnitPriceWon = actualProductReferenceUnitPriceWon;
  } else if (source === DISPATCH_PRICE_SOURCE.MANUAL) {
    if (!manualPriceProvided || !text(line.priceChangeReason)) throw new Error(`ORDERQ_CONFIRM_MANUAL_PRICE_REASON_REQUIRED:${line.dispatchLineId}`);
    appliedUnitPriceWon = manualUnitPriceWon;
  } else if (source !== DISPATCH_PRICE_SOURCE.ORDER_AGREED) {
    throw new Error(`ORDERQ_CONFIRM_PRICE_SOURCE_INVALID:${line.dispatchLineId}`);
  }
  const priceChangedFromOrder = Math.abs(appliedUnitPriceWon - orderAgreedUnitPriceWon) > 1e-9;
  return {
    priceSource: source,
    priceUnitBasis: source === DISPATCH_PRICE_SOURCE.ORDER_AGREED ? 'RECOGNIZED_ORDER' : 'ACTUAL_PRODUCT',
    orderAgreedUnitPriceWon,
    actualProductReferenceUnitPriceWon,
    actualProductUnitPriceWon: actualProductReferenceUnitPriceWon,
    manualUnitPriceWon,
    appliedUnitPriceWon,
    priceChangedFromOrder,
    priceChanged: priceChangedFromOrder,
    priceChangeReason: text(line.priceChangeReason)
  };
}

export function validateCustomerNotice(line = {}) {
  if (!line.customerNoticeRequired) return;
  const status = text(line.customerNoticeStatus).toUpperCase();
  if (status === CUSTOMER_NOTICE_STATUS.PENDING || !status) throw new Error(`ORDERQ_CONFIRM_CUSTOMER_NOTICE_PENDING:${line.dispatchLineId}`);
  const notifiedBy = text(line.customerNotifiedBy || line.customerNoticeActorId);
  const notifiedAt = text(line.customerNotifiedAt || line.customerNoticeAt);
  if (![CUSTOMER_NOTICE_STATUS.NOTIFIED, CUSTOMER_NOTICE_STATUS.WAIVED].includes(status)
    || !notifiedBy || !notifiedAt
    || text(line.customerNoticePriceFingerprint) !== dispatchPriceFingerprint(line)) {
    throw new Error(`ORDERQ_CONFIRM_CUSTOMER_NOTICE_EVIDENCE_REQUIRED:${line.dispatchLineId}`);
  }
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

export function normalizeDispatchReversalCommand(source = {}) {
  const dispatchId = text(source.dispatchId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  if (!dispatchId) throw new Error('ORDERQ_REVERSE_DISPATCH_ID_REQUIRED');
  if (!idempotencyKey) throw new Error('ORDERQ_REVERSE_IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_REVERSE_REVISION_REQUIRED');
  const reason = text(source.reason);
  if (!reason) throw new Error('ORDERQ_REVERSE_REASON_REQUIRED');
  const lines = (Array.isArray(source.lines) ? source.lines : []).map(row => ({
    dispatchLineId: text(row.dispatchLineId),
    quantity: quantityFromUnits(quantityUnits(row.quantity ?? row.actualQuantity)),
    allocations: (Array.isArray(row.allocations) ? row.allocations : []).map(allocation => ({
      allocationId: text(allocation.allocationId),
      quantity: quantityFromUnits(quantityUnits(allocation.quantity ?? allocation.actualBaseQuantity))
    })).sort((left, right) => left.allocationId.localeCompare(right.allocationId))
  })).sort((left, right) => left.dispatchLineId.localeCompare(right.dispatchLineId));
  if (lines.some(row => !row.dispatchLineId || row.quantity <= 0)) throw new Error('ORDERQ_REVERSE_LINE_INVALID');
  return { dispatchId, expectedRevision, idempotencyKey, reason, lines };
}

export function dispatchReversalFingerprint(command = {}) {
  const normalized = normalizeDispatchReversalCommand(command);
  return JSON.stringify(stableValue({
    dispatchId: normalized.dispatchId,
    expectedRevision: normalized.expectedRevision,
    reason: normalized.reason,
    lines: normalized.lines
  }));
}

export function buildDispatchReversalKey(dispatchId, revision, suffix = 'FULL') {
  const id = text(dispatchId);
  const normalizedRevision = Number(revision);
  const normalizedSuffix = text(suffix) || 'FULL';
  if (!id || !Number.isInteger(normalizedRevision) || normalizedRevision < 1) throw new Error('ORDERQ_REVERSAL_KEY_SOURCE_REQUIRED');
  return `DISPATCH_REVERSE:${id}:${normalizedRevision}:${normalizedSuffix}`;
}

function wonMagnitude(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(Math.round(number)) : 0;
}

export function allocateReversalAmounts(source = {}) {
  const originalQuantity = Number(source.originalQuantity);
  const reversedQuantity = Number(source.reversedQuantity || 0);
  const reversalQuantity = Number(source.reversalQuantity);
  if (!(originalQuantity > 0) || reversedQuantity < 0 || !(reversalQuantity > 0)
    || reversedQuantity + reversalQuantity > originalQuantity + 1e-9) {
    throw new Error('ORDERQ_REVERSE_AMOUNT_QUANTITY_INVALID');
  }

  const originalSupplyAmountWon = wonMagnitude(source.originalSupplyAmountWon);
  const originalVatAmountWon = wonMagnitude(source.originalVatAmountWon);
  const originalTotalAmountWon = hasOwn(source, 'originalTotalAmountWon')
    ? wonMagnitude(source.originalTotalAmountWon)
    : originalSupplyAmountWon + originalVatAmountWon;
  const reversedSupplyAmountWon = wonMagnitude(source.reversedSupplyAmountWon);
  const reversedVatAmountWon = wonMagnitude(source.reversedVatAmountWon);
  const reversedTotalAmountWon = hasOwn(source, 'reversedTotalAmountWon')
    ? wonMagnitude(source.reversedTotalAmountWon)
    : reversedSupplyAmountWon + reversedVatAmountWon;
  if (originalTotalAmountWon !== originalSupplyAmountWon + originalVatAmountWon
    || reversedTotalAmountWon !== reversedSupplyAmountWon + reversedVatAmountWon) {
    throw new Error('ORDERQ_REVERSE_AMOUNT_COMPONENT_MISMATCH');
  }
  if (reversedSupplyAmountWon > originalSupplyAmountWon
    || reversedVatAmountWon > originalVatAmountWon
    || reversedTotalAmountWon > originalTotalAmountWon) {
    throw new Error('ORDERQ_REVERSE_AMOUNT_EXCEEDS_ORIGINAL');
  }

  const cumulativeQuantity = reversedQuantity + reversalQuantity;
  const finalRemainder = Math.abs(cumulativeQuantity - originalQuantity) <= 1e-9;
  const allocate = (originalAmount, reversedAmount) => {
    const remainingAmount = originalAmount - reversedAmount;
    if (finalRemainder) return remainingAmount;
    const cumulativeTarget = Math.round(originalAmount * cumulativeQuantity / originalQuantity);
    return Math.max(0, Math.min(remainingAmount, cumulativeTarget - reversedAmount));
  };
  const supplyAmountWon = allocate(originalSupplyAmountWon, reversedSupplyAmountWon);
  const vatAmountWon = allocate(originalVatAmountWon, reversedVatAmountWon);
  const totalAmountWon = supplyAmountWon + vatAmountWon;
  if (reversedTotalAmountWon + totalAmountWon > originalTotalAmountWon) {
    throw new Error('ORDERQ_REVERSE_TOTAL_EXCEEDS_ORIGINAL');
  }
  if (finalRemainder && reversedTotalAmountWon + totalAmountWon !== originalTotalAmountWon) {
    throw new Error('ORDERQ_REVERSE_FINAL_AMOUNT_MISMATCH');
  }
  return { supplyAmountWon, vatAmountWon, totalAmountWon, finalRemainder };
}

export function allocateReversalQuantityDimension(source = {}) {
  const originalActualUnits = quantityUnits(source.originalActualQuantity);
  const reversedActualUnits = quantityUnits(source.reversedActualQuantity || 0);
  const reversalActualUnits = quantityUnits(source.reversalActualQuantity);
  const originalDimensionUnits = quantityUnits(source.originalDimensionQuantity);
  const reversedDimensionUnits = quantityUnits(source.reversedDimensionQuantity || 0);
  if (originalActualUnits <= 0 || reversedActualUnits < 0 || reversalActualUnits <= 0
    || reversedActualUnits + reversalActualUnits > originalActualUnits
    || originalDimensionUnits < 0 || reversedDimensionUnits < 0
    || reversedDimensionUnits > originalDimensionUnits) {
    throw new Error('ORDERQ_REVERSE_DIMENSION_QUANTITY_INVALID');
  }
  const cumulativeActualUnits = reversedActualUnits + reversalActualUnits;
  const remainingDimensionUnits = originalDimensionUnits - reversedDimensionUnits;
  const finalRemainder = cumulativeActualUnits === originalActualUnits;
  const cumulativeTargetUnits = finalRemainder
    ? originalDimensionUnits
    : Math.round(originalDimensionUnits * cumulativeActualUnits / originalActualUnits);
  const allocatedUnits = Math.max(0, Math.min(remainingDimensionUnits, cumulativeTargetUnits - reversedDimensionUnits));
  if (reversedDimensionUnits + allocatedUnits > originalDimensionUnits
    || (finalRemainder && reversedDimensionUnits + allocatedUnits !== originalDimensionUnits)) {
    throw new Error('ORDERQ_REVERSE_DIMENSION_EXCEEDS_ORIGINAL');
  }
  return quantityFromUnits(allocatedUnits);
}
