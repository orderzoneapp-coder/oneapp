#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DISPATCH_CONFIRMATION_STEP,
  buildDispatchConfirmationKey,
  buildDispatchReversalKey,
  confirmationCheckpoint,
  dispatchConfirmationFingerprint,
  dispatchReversalFingerprint,
  normalizeDispatchConfirmationCommand,
  normalizeDispatchReversalCommand,
  resolveNormalDispatchActuals
} from '../orderq/dispatch-confirmation.js';
import { DISPATCH_STATUS } from '../orderq/dispatch-workbench.js';

const lines = [{
  dispatchLineId: 'DL-1', orderId: 'O-1', orderItemId: 'OI-1',
  requestedProductId: 'P-1', actualProductId: 'P-1', actualProductCode: '10',
  fulfillmentType: 'NORMAL', plannedActualQuantity: 10, plannedBaseQuantity: 10,
  actualUnit: 'EA', workerReportedQuantity: 8
}];
const allocations = [
  { allocationId: 'DA-1', dispatchLineId: 'DL-1', warehouseId: 'W-1', plannedBaseQuantity: 4, reservationId: 'IR-1' },
  { allocationId: 'DA-2', dispatchLineId: 'DL-1', warehouseId: 'W-2', plannedBaseQuantity: 6, reservationId: 'IR-2' }
];

assert.equal(buildDispatchConfirmationKey('D-1', 2), 'DISPATCH_CONFIRM:D-1:2');
assert.throws(() => normalizeDispatchConfirmationCommand({ dispatchId: 'D-1', expectedRevision: 2 }), /IDEMPOTENCY_KEY_REQUIRED/);
const normalized = normalizeDispatchConfirmationCommand({
  dispatchId: 'D-1', expectedRevision: 2, idempotencyKey: 'K-1',
  lines: [{ dispatchLineId: 'DL-1', actualQuantity: 8, recognizedOrderQuantity: 8, allocations: [
    { allocationId: 'DA-2', actualBaseQuantity: 5 }, { allocationId: 'DA-1', actualBaseQuantity: 3 }
  ] }]
});
assert.deepEqual(normalized.lines[0].allocations.map(row => row.allocationId), ['DA-1', 'DA-2']);
assert.equal(
  dispatchConfirmationFingerprint(normalized),
  dispatchConfirmationFingerprint({ ...normalized, lines: [{ ...normalized.lines[0], allocations: [...normalized.lines[0].allocations].reverse() }] }),
  'confirmation fingerprint must ignore input ordering'
);

const partial = resolveNormalDispatchActuals({ lines, allocations, command: normalized });
assert.equal(partial[0].actualQuantity, 8);
assert.equal(partial[0].recognizedOrderQuantity, 8);
assert.deepEqual(partial[0].allocations.map(row => row.actualBaseQuantity), [3, 5]);
assert.throws(() => resolveNormalDispatchActuals({
  lines, allocations, command: { dispatchId: 'D-1', expectedRevision: 2, idempotencyKey: 'K-2' }
}), /ACTUAL_QUANTITY_REQUIRED/, 'planned and worker quantities must not become actuals implicitly');
const exact = resolveNormalDispatchActuals({
  lines: [{ ...lines[0], actualQuantity: 10, recognizedOrderQuantity: 10 }],
  allocations: allocations.map(row => ({ ...row, actualBaseQuantity: row.plannedBaseQuantity })),
  command: { dispatchId: 'D-1', expectedRevision: 2, idempotencyKey: 'K-3' }
});
assert.deepEqual(exact[0].allocations.map(row => row.actualBaseQuantity), [4, 6]);
assert.throws(() => resolveNormalDispatchActuals({
  lines, allocations, command: { dispatchId: 'D-1', expectedRevision: 2, idempotencyKey: 'K-4', lines: [{
    dispatchLineId: 'DL-1', actualQuantity: 11, recognizedOrderQuantity: 11,
    allocations: [{ allocationId: 'DA-1', actualBaseQuantity: 4 }, { allocationId: 'DA-2', actualBaseQuantity: 7 }]
  }] }
}), /OVER_DISPATCH_REQUIRES_M5/);
assert.throws(() => resolveNormalDispatchActuals({
  lines: [{ ...lines[0], fulfillmentType: 'SUBSTITUTE' }], allocations,
  command: { dispatchId: 'D-1', expectedRevision: 2, idempotencyKey: 'K-5' }
}), /M4_NORMAL_ONLY/);
assert.throws(() => resolveNormalDispatchActuals({
  lines: [{ ...lines[0], workerReportedProductId: 'P-OTHER' }], allocations,
  command: normalized
}), /M5_WORKER_PRODUCT_MISMATCH/);
assert.throws(() => confirmationCheckpoint({ failureAt: DISPATCH_CONFIRMATION_STEP.MOVEMENTS_WRITTEN }, DISPATCH_CONFIRMATION_STEP.MOVEMENTS_WRITTEN), /FAILURE_INJECTED/);
assert.equal(DISPATCH_STATUS.READY_TO_CONFIRM, 'READY_TO_CONFIRM');
assert.equal(DISPATCH_STATUS.CONFIRMED, 'CONFIRMED');
assert.equal(buildDispatchReversalKey('D-1', 3, 'PART-1'), 'DISPATCH_REVERSE:D-1:3:PART-1');
const reversal = normalizeDispatchReversalCommand({
  dispatchId: 'D-1', expectedRevision: 3, idempotencyKey: 'RK-1', reason: '부분 정정',
  lines: [{ dispatchLineId: 'DL-1', quantity: 3, allocations: [
    { allocationId: 'DA-2', quantity: 2 }, { allocationId: 'DA-1', quantity: 1 }
  ] }]
});
assert.deepEqual(reversal.lines[0].allocations.map(row => row.allocationId), ['DA-1', 'DA-2']);
assert.equal(dispatchReversalFingerprint(reversal), dispatchReversalFingerprint({ ...reversal, lines: [{ ...reversal.lines[0], allocations: [...reversal.lines[0].allocations].reverse() }] }));
assert.throws(() => normalizeDispatchReversalCommand({ dispatchId: 'D-1', expectedRevision: 3, idempotencyKey: 'RK-2' }), /REASON_REQUIRED/);

const repositorySource = await readFile(new URL('../orderq/dispatch-confirmation-repository.js', import.meta.url), 'utf8');
assert.match(repositorySource, /db\.transaction\(CONFIRMATION_STORES, 'readwrite'\)/);
for (const store of ['SALES_DOCUMENTS', 'SALES_LINES', 'INVENTORY_MOVEMENTS', 'ORDER_EVENTS', 'INVENTORY_RESERVATIONS', 'SYNC_QUEUE']) {
  assert.match(repositorySource, new RegExp(`STORE\\.${store}`));
}
assert.match(repositorySource, /ERP_POSTING_STATUS\.READY/);
assert.doesNotMatch(repositorySource, /ERP_POSTING_STATUS\.(POSTED|RECONCILED)/);
assert.match(repositorySource, /status: 'LOCAL_ONLY'/);
assert.match(repositorySource, /confirmDispatchBatch/);
assert.match(repositorySource, /recordDispatchActual/);
assert.match(repositorySource, /READY_TO_CONFIRM/);
assert.match(repositorySource, /reverseDispatch/);
assert.match(repositorySource, /createReversalEvent/);

console.log('ORDER Q M4 dispatch confirmation contract tests passed');
console.log(JSON.stringify({
  exactAllocationActuals: exact[0].allocations.map(row => row.actualBaseQuantity),
  partialAllocationActuals: partial[0].allocations.map(row => row.actualBaseQuantity),
  reversalAllocations: reversal.lines[0].allocations,
  normalOnly: true,
  failureInjectionSteps: Object.values(DISPATCH_CONFIRMATION_STEP)
}, null, 2));
