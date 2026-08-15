#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DISPATCH_STATUS,
  DISPATCH_WORKSPACE_STORAGE_KEY,
  FULFILLMENT_TYPE,
  NEEDS_ACTION_CODE,
  buildWorkerPickViews,
  deriveNeedsActionCodes,
  normalizeWorkerFact,
  normalizeWorkspaceState,
  proposeNormalDispatchDrafts,
  validateDispatchDraftPlan
} from '../orderq/dispatch-workbench.js';

assert.equal(DISPATCH_WORKSPACE_STORAGE_KEY, 'oneapp.orderq.dispatch-workbench.v1');

const baseLine = {
  dispatchLineId: 'DL-1', orderId: 'O-1', orderItemId: 'OI-1',
  requestedProductId: 'P-1', actualProductId: 'P-1', fulfillmentType: FULFILLMENT_TYPE.NORMAL,
  plannedActualQuantity: 10, plannedBaseQuantity: 10, actualUnit: 'EA'
};
const draftIncomplete = validateDispatchDraftPlan({
  lines: [{ ...baseLine, actualProductId: '', plannedBaseQuantity: 0 }], allocations: []
});
assert.equal(draftIncomplete.lines[0].actualProductId, '', 'DRAFT must preserve an unresolved actual product');
assert.throws(() => validateDispatchDraftPlan({
  lines: [{ ...baseLine, actualProductId: '', plannedBaseQuantity: 0 }], allocations: [], strict: true
}), /ACTUAL_PRODUCT_REQUIRED/);

const multiAllocation = validateDispatchDraftPlan({
  lines: [baseLine],
  allocations: [
    { allocationId: 'A-1', dispatchLineId: 'DL-1', warehouseId: 'W-1', plannedBaseQuantity: 4 },
    { allocationId: 'A-2', dispatchLineId: 'DL-1', warehouseId: 'W-2', plannedBaseQuantity: 6 }
  ],
  strict: true
});
assert.deepEqual(multiAllocation.allocations.map(row => row.plannedBaseQuantity), [4, 6]);
assert.throws(() => validateDispatchDraftPlan({
  lines: [baseLine],
  allocations: [{ allocationId: 'A-1', dispatchLineId: 'DL-1', warehouseId: 'W-1', plannedBaseQuantity: 9 }],
  strict: true
}), /ALLOCATION_SUM_MISMATCH/);

const inventoryProjection = {
  rows: [
    { productId: 'P-1', productCode: '10', warehouseId: 'W-1', availableQuantity: 4, countsInAvailable: true },
    { productId: 'P-1', productCode: '10', warehouseId: 'W-2', availableQuantity: 8, countsInAvailable: true }
  ]
};
const proposals = proposeNormalDispatchDrafts({
  orders: [{ orderId: 'O-1', customerId: 'C-1', customerName: '테스트 고객', orderDate: '2026-08-15' }],
  orderItems: [{ orderItemId: 'OI-1', orderId: 'O-1', productId: 'P-1', itemCode: '10', itemName: '테스트 상품', finalQuantity: 10, finalUnit: 'EA' }],
  inventoryProjection,
  businessDate: '2026-08-15'
});
assert.equal(proposals.length, 1);
assert.equal(proposals[0].proposalOnly, true);
assert.equal(proposals[0].decision.status, DISPATCH_STATUS.DRAFT, 'normal proposal must never auto-release or confirm');
assert.deepEqual(proposals[0].allocations.map(row => row.plannedBaseQuantity), [8, 2]);
assert.deepEqual(proposals[0].lines[0].needsActionCodes, [NEEDS_ACTION_CODE.READY]);

const shortageCodes = deriveNeedsActionCodes({
  line: baseLine,
  allocations: [{ dispatchLineId: 'DL-1', warehouseId: 'W-1', plannedBaseQuantity: 10 }],
  availableByWarehouse: new Map([['W-1', 2]])
});
assert(shortageCodes.includes(NEEDS_ACTION_CODE.SHORTAGE));

const workerViews = buildWorkerPickViews([{
  decision: { dispatchId: 'D-1', dispatchNo: '20260815-D001', status: DISPATCH_STATUS.RELEASED, customerId: 'C-1', customerName: '테스트 고객' },
  lines: [baseLine],
  allocations: multiAllocation.allocations
}], [
  { warehouseId: 'W-1', warehouseCode: '01', warehouseName: '제1창고' },
  { warehouseId: 'W-2', warehouseCode: '02', warehouseName: '제2창고' }
]);
assert.equal(workerViews.byOrder.length, 1);
assert.equal(workerViews.byLocationProduct.length, 2);
assert.equal(workerViews.byLocationProduct[0].sources[0].dispatchLineId, 'DL-1');
assert.equal(workerViews.byLocationProduct[0].sources[0].allocationId, 'A-1');
assert.equal(workerViews.byLocationProduct.reduce((sum, row) => sum + row.plannedBaseQuantity, 0), 10);

const restoredWorkspace = normalizeWorkspaceState({
  mode: 'worker', filters: { customer: ' 갑 ', status: 'released' },
  selectedDispatchIds: ['D-1', 'D-1', ''], expandedDispatchIds: ['D-1'],
  focusedDispatchLineId: ' DL-1 ', scrollTop: 128
});
assert.deepEqual(restoredWorkspace, {
  mode: 'WORKER', filters: { customer: '갑', status: 'released' },
  selectedDispatchIds: ['D-1'], expandedDispatchIds: ['D-1'],
  focusedDispatchLineId: 'DL-1', scrollTop: 128
});

const workFact = normalizeWorkerFact({
  dispatchLineId: 'DL-1', workerReportedProductId: 'P-1', workerReportedQuantity: 9,
  workerExceptionCode: 'QUANTITY_SHORT', workerExceptionMemo: '1개 부족'
});
assert.equal(workFact.workStatus, 'EXCEPTION');
assert.equal(workFact.workerReportedQuantity, 9);
assert.equal('actualBaseQuantity' in workFact, false, 'worker facts must not become confirmed quantities in M3');

const repositorySource = await readFile(new URL('../orderq/dispatch-workbench-repository.js', import.meta.url), 'utf8');
assert.match(repositorySource, /status: DISPATCH_STATUS\.DRAFT/);
assert.match(repositorySource, /status: DISPATCH_STATUS\.RELEASED/);
assert.match(repositorySource, /localOnly: true/);
assert.match(repositorySource, /RESERVATION_STATUS\.RELEASED/);
assert.match(repositorySource, /RESERVATION_STATUS\.EXPIRED/);
assert.doesNotMatch(repositorySource, /CONFIRMED/);
assert.doesNotMatch(repositorySource, /SALES_DOCUMENTS|SALES_LINES|FULFILLMENT_LINKS|FULFILLMENT_BALANCES/);
assert.doesNotMatch(repositorySource, /appendInventoryMovement|SALE_ISSUE/);

console.log('ORDER Q M3 dispatch workbench contract tests passed');
console.log(JSON.stringify({
  draftAllowsUnresolvedFacts: true,
  strictReleaseValidation: true,
  multiAllocation: multiAllocation.allocations,
  proposal: { status: proposals[0].decision.status, proposalOnly: proposals[0].proposalOnly },
  aggregateTrace: workerViews.byLocationProduct,
  workspaceRestore: restoredWorkspace,
  workFact
}, null, 2));
