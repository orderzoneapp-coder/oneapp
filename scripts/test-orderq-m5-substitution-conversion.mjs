#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CAPABILITY,
  requireCapability
} from '../orderq/orderq-v7-contracts.js';
import {
  CONVERSION_TYPE,
  CUSTOMER_NOTICE_STATUS,
  DISPATCH_PRICE_SOURCE,
  FULFILLMENT_TYPE,
  MEASUREMENT_STATUS,
  validateDispatchDraftPlan
} from '../orderq/dispatch-workbench.js';
import {
  DISPATCH_APPROVAL_TYPE,
  allocateReversalQuantityDimension,
  dispatchActualFingerprint,
  dispatchActualSetFingerprint,
  dispatchPriceFingerprint,
  isDispatchApprovalEffectivelyActive,
  resolveDispatchActuals,
  resolveDispatchPrice,
  validateCustomerNotice
} from '../orderq/dispatch-confirmation.js';

const conversionRuleSnapshot = {
  conversionRuleId: 'CR-CUT-1',
  conversionRuleVersion: 'v1',
  actualToBaseFactor: 0.5,
  actualToRecognizedFactor: 5
};
const substituteLine = {
  dispatchLineId: 'DL-SUB', dispatchId: 'D-SUB', orderId: 'O-1', orderItemId: 'OI-A',
  requestedProductId: 'P-A', requestedProductCode: 'A', requestedProductName: '요청 A',
  actualProductId: 'P-B', actualProductCode: 'B', actualProductName: '대체 B',
  fulfillmentType: FULFILLMENT_TYPE.SUBSTITUTE,
  plannedActualQuantity: 2, plannedBaseQuantity: 1, plannedRecognizedOrderQuantity: 10,
  actualUnit: 'PACK', baseUnit: 'KG', conversionType: CONVERSION_TYPE.CUT,
  conversionRuleId: 'CR-CUT-1', conversionRuleVersion: 'v1', conversionRuleSnapshot,
  measurementRequired: false, measurementStatus: MEASUREMENT_STATUS.NOT_REQUIRED,
  priceSource: DISPATCH_PRICE_SOURCE.ORDER_AGREED,
  customerNoticeRequired: false, customerNoticeStatus: CUSTOMER_NOTICE_STATUS.NOT_REQUIRED
};
const allocation = {
  allocationId: 'DA-SUB', dispatchId: 'D-SUB', dispatchLineId: 'DL-SUB',
  warehouseId: 'W-1', plannedBaseQuantity: 1, actualBaseQuantity: 1, reservationId: 'IR-SUB'
};

const draft = validateDispatchDraftPlan({ lines: [substituteLine], allocations: [allocation], strict: true });
assert.equal(draft.lines[0].requestedProductId, 'P-A');
assert.equal(draft.lines[0].actualProductId, 'P-B');
assert.equal(draft.lines[0].plannedActualQuantity, 2);
assert.equal(draft.lines[0].plannedBaseQuantity, 1);
assert.equal(draft.lines[0].plannedRecognizedOrderQuantity, 10);
assert.equal(draft.lines[0].conversionRuleSnapshot.conversionRuleId, conversionRuleSnapshot.conversionRuleId);
assert.equal(draft.lines[0].conversionRuleSnapshot.conversionRuleVersion, conversionRuleSnapshot.conversionRuleVersion);
assert.equal(draft.lines[0].conversionRuleSnapshot.actualToBaseFactor, conversionRuleSnapshot.actualToBaseFactor);
assert.equal(draft.lines[0].conversionRuleSnapshot.actualToRecognizedFactor, conversionRuleSnapshot.actualToRecognizedFactor);
const noticeInjection = validateDispatchDraftPlan({
  lines: [{ ...substituteLine, customerNoticeRequired: true, customerNoticeStatus: 'NOTIFIED', customerNoticeActorId: 'FORGED', customerNoticeAt: '2026-08-15T00:00:00.000Z', customerNoticeMemo: 'forged', customerNoticePriceFingerprint: 'forged', actualRevision: 99 }],
  allocations: [allocation]
});
assert.equal(noticeInjection.lines[0].customerNoticeStatus, CUSTOMER_NOTICE_STATUS.PENDING);
assert.equal(noticeInjection.lines[0].customerNoticeActorId, '');
assert.equal('actualRevision' in noticeInjection.lines[0], false, 'DRAFT must not accept an injected actual approval revision');

const actuals = resolveDispatchActuals({
  lines: [substituteLine], allocations: [allocation], command: {
    dispatchId: 'D-SUB', expectedRevision: 2, idempotencyKey: 'ACTUAL-SUB',
    lines: [{ dispatchLineId: 'DL-SUB', actualQuantity: 2, recognizedOrderQuantity: 10,
      allocations: [{ allocationId: 'DA-SUB', actualBaseQuantity: 1 }] }]
  }
});
assert.equal(actuals[0].actualQuantity, 2);
assert.equal(actuals[0].actualBaseQuantity, 1);
assert.equal(actuals[0].recognizedOrderQuantity, 10);
assert.equal(actuals[0].line.requestedProductId, 'P-A');
assert.equal(actuals[0].line.actualProductId, 'P-B');
assert.throws(() => resolveDispatchActuals({
  lines: [substituteLine], allocations: [allocation], command: {
    dispatchId: 'D-SUB', expectedRevision: 2, idempotencyKey: 'BAD-RECOGNIZED',
    lines: [{ dispatchLineId: 'DL-SUB', actualQuantity: 2, recognizedOrderQuantity: 9,
      allocations: [{ allocationId: 'DA-SUB', actualBaseQuantity: 1 }] }]
  }
}), /RECOGNIZED_QUANTITY_MISMATCH/);

const measuredLine = {
  ...substituteLine,
  conversionType: CONVERSION_TYPE.MEASURED,
  measurementRequired: true,
  measurementStatus: MEASUREMENT_STATUS.MEASURE_PENDING
};
const measuredCommand = {
  dispatchId: 'D-SUB', expectedRevision: 2, idempotencyKey: 'MEASURE',
  lines: [{ dispatchLineId: 'DL-SUB', actualQuantity: 2, recognizedOrderQuantity: 10,
    allocations: [{ allocationId: 'DA-SUB', actualBaseQuantity: 1 }] }]
};
assert.throws(() => resolveDispatchActuals({ lines: [measuredLine], allocations: [allocation], command: measuredCommand }), /MEASURE_PENDING/);
assert.equal(resolveDispatchActuals({ lines: [measuredLine], allocations: [allocation], command: measuredCommand, allowMeasurementCapture: true })[0].actualBaseQuantity, 1);

const item = { price: 1000 };
const agreed = resolveDispatchPrice({ item, line: { ...substituteLine, priceSource: DISPATCH_PRICE_SOURCE.ORDER_AGREED } });
const actualPrice = resolveDispatchPrice({ item, line: { ...substituteLine, priceSource: DISPATCH_PRICE_SOURCE.ACTUAL_PRODUCT, actualProductUnitPriceWon: 1200 } });
const manual = resolveDispatchPrice({ item, line: { ...substituteLine, priceSource: DISPATCH_PRICE_SOURCE.MANUAL, manualUnitPriceWon: 900, priceChangeReason: '합의 할인' } });
assert.deepEqual([agreed.appliedUnitPriceWon, actualPrice.appliedUnitPriceWon, manual.appliedUnitPriceWon], [1000, 1200, 900]);
assert.deepEqual([agreed.priceChanged, actualPrice.priceChanged, manual.priceChanged], [false, true, true]);
assert.deepEqual([agreed.priceChangedFromOrder, actualPrice.priceChangedFromOrder, manual.priceChangedFromOrder], [false, true, true]);
assert.equal(actualPrice.actualProductReferenceUnitPriceWon, 1200);
assert.deepEqual([agreed.priceUnitBasis, actualPrice.priceUnitBasis, manual.priceUnitBasis], ['RECOGNIZED_ORDER', 'ACTUAL_PRODUCT', 'ACTUAL_PRODUCT']);
assert.throws(() => resolveDispatchPrice({ item, line: { ...substituteLine, priceSource: DISPATCH_PRICE_SOURCE.MANUAL, manualUnitPriceWon: 900 } }), /MANUAL_PRICE_REASON_REQUIRED/);

const pendingNotice = { ...substituteLine, ...actualPrice, customerNoticeRequired: true, customerNoticeStatus: CUSTOMER_NOTICE_STATUS.PENDING };
assert.throws(() => validateCustomerNotice(pendingNotice), /CUSTOMER_NOTICE_PENDING/);
const notified = {
  ...pendingNotice,
  customerNoticeStatus: CUSTOMER_NOTICE_STATUS.NOTIFIED,
  customerNoticeActorId: 'ADMIN', customerNoticeAt: '2026-08-15T00:00:00.000Z',
  customerNoticeMemo: '고객 전화 안내'
};
notified.customerNoticePriceFingerprint = dispatchPriceFingerprint(notified);
assert.doesNotThrow(() => validateCustomerNotice(notified));
assert.notEqual(dispatchActualFingerprint({ ...substituteLine, actualQuantity: 2, actualBaseQuantity: 1, recognizedOrderQuantity: 10, actualRevision: 3 }),
  dispatchActualFingerprint({ ...substituteLine, actualQuantity: 2, actualBaseQuantity: 1, recognizedOrderQuantity: 10, actualRevision: 4 }),
  'approval fingerprints must become stale after a new actual revision');
const actualSet = [
  { ...substituteLine, dispatchLineId: 'DL-A', actualQuantity: 1, actualBaseQuantity: 0.5, recognizedOrderQuantity: 5, actualRevision: 3 },
  { ...substituteLine, dispatchLineId: 'DL-B', actualQuantity: 1, actualBaseQuantity: 0.5, recognizedOrderQuantity: 5, actualRevision: 3 }
];
assert.notEqual(dispatchActualSetFingerprint(actualSet), dispatchActualSetFingerprint([{ ...actualSet[0], actualQuantity: 0.5 }, actualSet[1]]),
  'aggregate over-dispatch approval must become stale when any participating line changes');
const firstBaseReversal = allocateReversalQuantityDimension({
  originalActualQuantity: 2, reversedActualQuantity: 0, reversalActualQuantity: 1,
  originalDimensionQuantity: 1, reversedDimensionQuantity: 0
});
const finalBaseReversal = allocateReversalQuantityDimension({
  originalActualQuantity: 2, reversedActualQuantity: 1, reversalActualQuantity: 1,
  originalDimensionQuantity: 1, reversedDimensionQuantity: firstBaseReversal
});
const firstRecognizedReversal = allocateReversalQuantityDimension({
  originalActualQuantity: 2, reversedActualQuantity: 0, reversalActualQuantity: 1,
  originalDimensionQuantity: 10, reversedDimensionQuantity: 0
});
const finalRecognizedReversal = allocateReversalQuantityDimension({
  originalActualQuantity: 2, reversedActualQuantity: 1, reversalActualQuantity: 1,
  originalDimensionQuantity: 10, reversedDimensionQuantity: firstRecognizedReversal
});
assert.deepEqual([firstBaseReversal, finalBaseReversal, firstRecognizedReversal, finalRecognizedReversal], [0.5, 0.5, 5, 5]);
const substitutionApproval = { approvalId: 'DAP-SUB', approvalType: 'SUBSTITUTE', status: 'ACTIVE' };
const decisionReversalApproval = { approvalId: 'DAP-REV', status: 'REVERSED', reversalOfApprovalIds: ['DAP-SUB'] };
assert.equal(isDispatchApprovalEffectivelyActive(substitutionApproval, [substitutionApproval]), true);
assert.equal(isDispatchApprovalEffectivelyActive(substitutionApproval, [substitutionApproval, decisionReversalApproval]), false);

assert.equal(requireCapability('ADMIN', CAPABILITY.SUBSTITUTE_APPROVE).actorId, 'ADMIN');
assert.throws(() => requireCapability({ actorId: 'WORKER', capabilities: [] }, CAPABILITY.SUBSTITUTE_APPROVE), /CAPABILITY_REQUIRED/);
assert.throws(() => requireCapability({ actorId: 'WORKER', capabilities: [CAPABILITY.SUBSTITUTE_APPROVE] }, CAPABILITY.OVER_DISPATCH_APPROVE), /CAPABILITY_REQUIRED/);

const repositorySource = await readFile(new URL('../orderq/dispatch-exception-repository.js', import.meta.url), 'utf8');
for (const capability of ['SUBSTITUTE_APPROVE', 'OVER_DISPATCH_APPROVE']) assert.match(repositorySource, new RegExp(`CAPABILITY\\.${capability}`));
for (const exportedCommand of ['approveSubstitution', 'approveOverDispatch', 'recordCustomerNotice', 'reverseSubstitutionDecision']) {
  assert.match(repositorySource, new RegExp(`export async function ${exportedCommand}`));
}
assert.match(repositorySource, /SUBSTITUTE_DECISION_ONLY/);
assert.match(repositorySource, /status: 'LOCAL_ONLY'/);
assert.doesNotMatch(repositorySource, /PURCHASE_DOCUMENTS|ERP_POSTING_STATUS\.(POSTED|RECONCILED)/);
assert.equal(DISPATCH_APPROVAL_TYPE.SUBSTITUTE_DECISION_REVERSAL, 'SUBSTITUTE_DECISION_REVERSAL');

console.log('ORDER Q M5 substitution, conversion, measurement, price, notice and approval contract tests passed');
console.log(JSON.stringify({
  products: { requested: actuals[0].line.requestedProductId, actual: actuals[0].line.actualProductId },
  quantities: { actual: actuals[0].actualQuantity, base: actuals[0].actualBaseQuantity, recognized: actuals[0].recognizedOrderQuantity },
  conversionRuleSnapshot,
  prices: { agreed: agreed.appliedUnitPriceWon, actualProduct: actualPrice.appliedUnitPriceWon, manual: manual.appliedUnitPriceWon },
  measurementPendingBlocked: true,
  substituteCapabilityRequired: true,
  overDispatchCapabilityRequired: true
}, null, 2));
