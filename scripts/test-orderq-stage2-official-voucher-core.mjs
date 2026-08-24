import assert from 'node:assert/strict';
import {
  calculateOfficialDocumentAmount,
  planOfficialVoucherCommand,
  roundWon
} from '../orderq/official-voucher-core.js';
import {
  OFFICIAL_COMMAND_TYPE,
  commitCentralCommand,
  createCentralAuthorityState,
  migrateCentralDrafts,
  prepareCentralCommand
} from '../orderq/central-authority.js';

assert.equal(roundWon(1.5), 2);
assert.equal(roundWon(-1.5), -2);
assert.equal(roundWon(-1.49), -1);

const amounts = calculateOfficialDocumentAmount([
  { quantity: 1.5, unitPrice: 101 },
  { quantity: -1.5, unitPrice: 101 },
  { quantity: 0, unitPrice: 999 }
]);
assert.deepEqual(amounts.lines.map(row => row.supplyAmount), [152, -152, 0]);
assert.equal(amounts.supplyAmount, 0);
assert.equal(amounts.totalAmount, 0);
assert.equal(amounts.vatAmount, null);

const purchaseDraft = {
  purchaseDocumentId: 'PD-1', supplierCustomerId: 'SUP-1', warehouseId: 'W-1',
  status: 'DRAFT', businessStatus: 'DRAFT', documentContract:'VOUCHER_CORE_V1', sourceDocumentKey:'SRC-P-1', revision: 1, sourceType: 'DIRECT', supplyAmount: 0, totalAmount: 0
};
const purchaseLines = [
  { purchaseLineId: 'PL-1', lineIdentityId:'LI-P-1', sourceLineKey:'1', productId: 'P-1', warehouseId: 'W-1', quantity: -2, baseQuantity: -2, unitPrice: 1500 },
  { purchaseLineId: 'PL-2', lineIdentityId:'LI-P-2', sourceLineKey:'2', productId: 'P-2', warehouseId: 'W-1', quantity: 0, baseQuantity: 0, unitPrice: 500 }
];
const purchasePost = planOfficialVoucherCommand({
  command: {
    commandType: 'POST_PURCHASE', commandContract:'VOUCHER_CORE_V1', commandId: 'IDEM-P-1', idempotencyKey: 'IDEM-P-1',
    expectedRevision: 1, actor: 'ADMIN', occurredAt: '2026-08-25T01:00:00.000Z',
    document: purchaseDraft, lines: purchaseLines
  },
  document: purchaseDraft,
  lines: purchaseLines.map(row => ({ ...row, purchaseDocumentId: 'PD-1', status: 'DRAFT' }))
});
assert.equal(purchasePost.document.status, 'CONFIRMED');
assert.equal(purchasePost.document.revision, 2);
assert.equal(purchasePost.document.totalAmount, -3000);
assert.deepEqual(purchasePost.movements.map(row => row.signedBaseQuantity), [-2, 0]);
assert.ok(purchasePost.movements.every(row => row.movementType === 'DIRECT_PURCHASE_POST'));
assert.equal(purchasePost.entries[0].totalAmount, -3000);
assert.equal(purchasePost.entries[0].vatAmount, null);

const saleDraft = {
  salesDocumentId: 'SD-1', salesCustomerId: 'SALE-1', deliveryCustomerId: 'DEL-1', billingCustomerId: 'BILL-1',
  warehouseId: 'W-1', status: 'DRAFT', businessStatus:'DRAFT', documentContract:'VOUCHER_CORE_V1', sourceDocumentKey:'SRC-S-1', revision: 1, sourceType: 'DIRECT', supplyAmount: 0, totalAmount: 0
};
const saleLine = { salesLineId: 'SL-1', lineIdentityId:'LI-S-1', sourceLineKey:'1', productId: 'P-1', warehouseId: 'W-1', quantity: -3, baseQuantity: -3, recognizedOrderQuantity:0, unitPrice: 2000 };
const salePost = planOfficialVoucherCommand({
  command: {
    commandType: 'POST_SALE', commandContract:'VOUCHER_CORE_V1', commandId: 'IDEM-S-1', idempotencyKey: 'IDEM-S-1',
    expectedRevision: 1, actor: 'ADMIN', occurredAt: '2026-08-25T01:00:00.000Z',
    document: saleDraft, lines: [saleLine]
  },
  document: saleDraft,
  lines: [{ ...saleLine, salesDocumentId: 'SD-1', status: 'DRAFT' }]
});
assert.equal(salePost.movements[0].movementType, 'DIRECT_SALE_POST');
assert.equal(salePost.movements[0].signedBaseQuantity, 3);
assert.equal(salePost.document.totalAmount, -6000);

const saleCorrect = planOfficialVoucherCommand({
  command: {
    commandType: 'CORRECT_SALE', commandContract:'VOUCHER_CORE_V1', commandId: 'IDEM-S-2', idempotencyKey: 'IDEM-S-2',
    expectedRevision: 2, actor: 'ADMIN', occurredAt: '2026-08-25T02:00:00.000Z', reason: '실수량 정정',
    document: salePost.document,
    lines: [{ ...salePost.lines[0], quantity: 0, actualQuantity: 0, baseQuantity: 0, unitPrice: 2000 }]
  },
  document: salePost.document,
  lines: salePost.lines
});
assert.equal(saleCorrect.document.revision, 3);
assert.equal(saleCorrect.document.totalAmount, 0);
assert.equal(saleCorrect.movements[0].signedBaseQuantity, -3);
assert.equal(saleCorrect.entries[0].totalAmount, 6000);

const central = createCentralAuthorityState();
migrateCentralDrafts(central, {
  deviceId: 'PC-1', idempotencyKey: 'MIGRATE-PD-1',
  entities: [
    { entityType: 'PURCHASE_DOCUMENT', entityId: 'PD-1', revision: 1, payload: { ...purchaseDraft, localOnly: true } },
    ...purchaseLines.map(line => ({
      entityType: 'PURCHASE_LINE', entityId: line.purchaseLineId, revision: 1,
      payload: { ...line, purchaseDocumentId: 'PD-1', status: 'DRAFT', revision: 1, localOnly: true }
    })),
    { entityType: 'PURCHASE_DOCUMENT', entityId: 'PD-2', revision: 1, payload: { ...purchaseDraft, purchaseDocumentId: 'PD-2', localOnly: true } },
    ...purchaseLines.map((line, index) => ({
      entityType: 'PURCHASE_LINE', entityId: `PD2-L${index + 1}`, revision: 1,
      payload: { ...line, purchaseLineId: `PD2-L${index + 1}`, lineIdentityId: `PD2-I${index + 1}`, sourceLineKey: `PD2-S${index + 1}`, purchaseDocumentId: 'PD-2', status: 'DRAFT', revision: 1, localOnly: true }
    }))
  ]
});
const centralSource = {
  commandType: OFFICIAL_COMMAND_TYPE.POST_PURCHASE,
  aggregateId: 'PD-1', expectedRevision: 1, idempotencyKey: 'IDEM-P-1', deviceId: 'PC-1',
  intent: {
    commandContract: 'VOUCHER_CORE_V1', commandId: 'IDEM-P-1', actor: 'ADMIN',
    occurredAt: '2026-08-25T01:00:00.000Z', reason: ''
  }
};
const lease = prepareCentralCommand(central, centralSource);
const centralMutations = [
  { entityType: 'PURCHASE_DOCUMENT', entityId: 'PD-1', revision: 2, payload: purchasePost.document },
  ...purchasePost.lines.map(line => ({ entityType: 'PURCHASE_LINE', entityId: line.purchaseLineId, revision: 2, payload: line })),
  ...purchasePost.movements.map(movement => ({ entityType: 'INVENTORY_MOVEMENT', entityId: movement.movementId, revision: 2, payload: movement })),
  { entityType: 'VOUCHER_EVENT', entityId: purchasePost.voucherEvent.eventId, revision: 2, payload: purchasePost.voucherEvent },
  ...purchasePost.entries.map(entry => ({ entityType: 'PAYABLE_ENTRY', entityId: entry.entryId, revision: 2, payload: entry }))
];
const committed = commitCentralCommand(central, {
  idempotencyKey: centralSource.idempotencyKey,
  leaseToken: lease.leaseToken,
  fingerprint: lease.fingerprint,
  mutations: centralMutations
});
assert.equal(committed.duplicate, false);
assert.ok(committed.transactionId); assert.match(committed.resultDigest,/^[0-9a-f]{64}$/);
assert.equal(committed.changes.filter(row => row.entityType === 'PAYABLE_ENTRY').length, 1);
assert.equal(committed.changes.filter(row => row.entityType === 'INVENTORY_MOVEMENT').length, 2);
assert.throws(() => prepareCentralCommand(central, {
  commandType: OFFICIAL_COMMAND_TYPE.POST_PURCHASE,
  aggregateId: 'PD-2', expectedRevision: 1, idempotencyKey: 'IDEM-P-DUPLICATE-SOURCE', deviceId: 'PC-1',
  intent: { commandContract: 'VOUCHER_CORE_V1', commandId: 'IDEM-P-DUPLICATE-SOURCE', actor: 'ADMIN', occurredAt: '2026-08-25T01:30:00.000Z' }
}), /ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED/);
const committedRetry=commitCentralCommand(central,{idempotencyKey:centralSource.idempotencyKey,leaseToken:lease.leaseToken,fingerprint:lease.fingerprint,mutations:centralMutations});
assert.equal(committedRetry.duplicate,true); assert.equal(committedRetry.resultDigest,committed.resultDigest);
const preparedRetry = prepareCentralCommand(central, centralSource);
assert.equal(preparedRetry.committed, true); assert.equal(preparedRetry.fingerprint, lease.fingerprint); assert.equal(preparedRetry.result.resultDigest, committed.resultDigest);

console.log('ORDER Q stage2 official voucher core tests passed');
