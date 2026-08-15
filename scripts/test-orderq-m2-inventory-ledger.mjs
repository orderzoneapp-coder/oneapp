#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  INVENTORY_LEDGER_SEQUENCE_META_KEY,
  INVENTORY_MOVEMENT_TYPE,
  buildMovementIdempotencyKey,
  calculateInventoryShadowProjection,
  normalizeInventoryMovementDraft,
  sameMovementBusinessContent,
  selectInventorySnapshotBasis,
  validateInventoryReversal,
  validateInventoryTransferDrafts
} from '../orderq/inventory-ledger.js';

assert.equal(INVENTORY_LEDGER_SEQUENCE_META_KEY, 'inventoryLedgerSequence');
assert.equal(buildMovementIdempotencyKey({
  sourceDocumentType: 'purchase', sourceDocumentId: 0, sourceLineId: '0', movementType: 'purchase_receipt'
}), 'PURCHASE:0:0:PURCHASE_RECEIPT:');

const purchase = normalizeInventoryMovementDraft({
  productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: 8,
  movementType: 'PURCHASE_RECEIPT', sourceDocumentType: 'PURCHASE', sourceDocumentId: 'PD-1', sourceLineId: 'PL-1'
});
const sale = normalizeInventoryMovementDraft({
  productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: -3,
  movementType: 'SALE_ISSUE', sourceDocumentType: 'SALES', sourceDocumentId: 'SD-1', sourceLineId: 'SL-1'
});
assert.equal(purchase.signedBaseQuantity, 8);
assert.equal(sale.signedBaseQuantity, -3);
assert.throws(() => normalizeInventoryMovementDraft({
  ...sale, signedBaseQuantity: 3
}), /ORDERQ_OUTBOUND_MOVEMENT_MUST_BE_NEGATIVE/);

const transfer = validateInventoryTransferDrafts([
  {
    productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: -4, movementType: 'TRANSFER_OUT', transferId: 'T-1',
    sourceDocumentType: 'WAREHOUSE_TRANSFER', sourceDocumentId: 'T-1', sourceLineId: 'OUT'
  },
  {
    productId: 'P-1', warehouseId: 'W-2', signedBaseQuantity: 4, movementType: 'TRANSFER_IN', transferId: 'T-1',
    sourceDocumentType: 'WAREHOUSE_TRANSFER', sourceDocumentId: 'T-1', sourceLineId: 'IN'
  }
]);
assert.equal(transfer.reduce((sum, row) => sum + row.signedBaseQuantity, 0), 0);
assert.throws(() => validateInventoryTransferDrafts([
  transfer[0], { ...transfer[1], signedBaseQuantity: 3 }
]), /ORDERQ_TRANSFER_QUANTITY_MUST_NET_ZERO/);

const original = {
  movementId: 'IM-ORIGINAL', productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: -3
};
const reversal = validateInventoryReversal(original, {
  productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: 3, movementType: 'REVERSAL', reversalOf: 'IM-ORIGINAL',
  sourceDocumentType: 'INVENTORY_REVERSAL', sourceDocumentId: 'RV-1', sourceLineId: 'SL-1'
});
assert.equal(reversal.signedBaseQuantity, -original.signedBaseQuantity);
assert.throws(() => validateInventoryReversal(original, { ...reversal, signedBaseQuantity: 2 }), /ORDERQ_REVERSAL_QUANTITY_MUST_BE_OPPOSITE/);

const retryPersisted = { ...purchase, movementId: 'IM-1', ledgerSequence: 3, occurredAt: '2026-08-15T09:00:00.000Z', postedAt: '2026-08-15T09:00:01.000Z' };
assert.equal(sameMovementBusinessContent(retryPersisted, purchase), true, 'generated occurredAt must not break an otherwise identical retry');
assert.equal(sameMovementBusinessContent(retryPersisted, { ...purchase, signedBaseQuantity: 9 }), false);

const snapshots = [
  { inventorySnapshotId: 'IS-OLD', importBatchId: 'B-OLD', basisDate: '2026-08-14', snapshotLastSequence: 1, status: 'ACTIVE' },
  { inventorySnapshotId: 'IS-W1', importBatchId: 'B-NEW', basisDate: '2026-08-15', snapshotLastSequence: 2, warehouseId: 'W-1', status: 'ACTIVE' },
  { inventorySnapshotId: 'IS-W2', importBatchId: 'B-NEW', basisDate: '2026-08-15', snapshotLastSequence: 2, warehouseId: 'W-2', status: 'ACTIVE' }
];
assert.deepEqual(selectInventorySnapshotBasis(snapshots).snapshotIds, new Set(['IS-W1', 'IS-W2']));

const inventoryLines = [
  { inventoryLineId: 'IL-OLD', inventorySnapshotId: 'IS-OLD', productId: 'P-1', warehouseId: 'W-1', inventoryQuantity: 999, status: 'ACTIVE' },
  { inventoryLineId: 'IL-1', inventorySnapshotId: 'IS-W1', productId: 'P-1', productCode: '10', warehouseId: 'W-1', inventoryQuantity: 5, status: 'ACTIVE' },
  { inventoryLineId: 'IL-2', inventorySnapshotId: 'IS-W2', productId: 'P-1', productCode: '10', warehouseId: 'W-2', inventoryQuantity: 1, status: 'ACTIVE' },
  { inventoryLineId: 'IL-3', inventorySnapshotId: 'IS-W1', productId: 'P-2', productCode: '20', warehouseId: 'W-1', inventoryQuantity: 1, status: 'ACTIVE' }
];
const movements = [
  {
    movementId: 'IM-BEFORE-WATERMARK', ledgerSequence: 2, productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: 100,
    movementType: 'PURCHASE_RECEIPT', sourceDocumentType: 'PURCHASE', sourceDocumentId: 'PD-OLD', sourceLineId: 'PL-OLD'
  },
  {
    movementId: 'IM-BACKDATED-PURCHASE', ledgerSequence: 3, productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: 2,
    movementType: 'PURCHASE_RECEIPT', sourceDocumentType: 'PURCHASE', sourceDocumentId: 'PD-BACK', sourceLineId: 'PL-BACK',
    occurredAt: '2026-08-14T09:00:00.000Z', postedAt: '2026-08-15T09:00:00.000Z'
  },
  {
    movementId: 'IM-SALE', ledgerSequence: 4, productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: -3,
    movementType: 'SALE_ISSUE', sourceDocumentType: 'SALES', sourceDocumentId: 'SD-1', sourceLineId: 'SL-1'
  },
  {
    movementId: 'IM-TRANSFER-OUT', ledgerSequence: 5, productId: 'P-1', warehouseId: 'W-1', signedBaseQuantity: -4,
    movementType: 'TRANSFER_OUT', sourceDocumentType: 'WAREHOUSE_TRANSFER', sourceDocumentId: 'T-1', sourceLineId: 'OUT', transferId: 'T-1'
  },
  {
    movementId: 'IM-TRANSFER-IN', ledgerSequence: 6, productId: 'P-1', warehouseId: 'W-2', signedBaseQuantity: 4,
    movementType: 'TRANSFER_IN', sourceDocumentType: 'WAREHOUSE_TRANSFER', sourceDocumentId: 'T-1', sourceLineId: 'IN', transferId: 'T-1'
  },
  {
    movementId: 'IM-P2-SALE', ledgerSequence: 7, productId: 'P-2', warehouseId: 'W-1', signedBaseQuantity: -3,
    movementType: 'SALE_ISSUE', sourceDocumentType: 'SALES', sourceDocumentId: 'SD-2', sourceLineId: 'SL-2'
  },
  {
    movementId: 'IM-P2-REVERSAL', ledgerSequence: 8, productId: 'P-2', warehouseId: 'W-1', signedBaseQuantity: 1,
    movementType: 'REVERSAL', sourceDocumentType: 'INVENTORY_REVERSAL', sourceDocumentId: 'RV-2', sourceLineId: 'SL-2', reversalOf: 'IM-P2-SALE'
  }
];
const projection = calculateInventoryShadowProjection({
  snapshots,
  inventoryLines,
  movements,
  reservations: [{ reservationId: 'R-1', productId: 'P-1', warehouseId: 'W-2', reservedBaseQuantity: 2, status: 'ACTIVE' }],
  warehouses: [
    { warehouseId: 'W-1', warehouseCode: '01', warehouseName: '첫째', countsInOnHand: true, countsInAvailable: true },
    { warehouseId: 'W-2', warehouseCode: '02', warehouseName: '둘째', countsInOnHand: true, countsInAvailable: true }
  ]
});
const p1w1 = projection.rows.find(row => row.productId === 'P-1' && row.warehouseId === 'W-1');
const p1w2 = projection.rows.find(row => row.productId === 'P-1' && row.warehouseId === 'W-2');
const p2w1 = projection.rows.find(row => row.productId === 'P-2' && row.warehouseId === 'W-1');
assert.equal(p1w1.snapshotQuantity, 5);
assert.equal(p1w1.movementQuantity, -5, 'watermark must exclude sequence 2 and include sequences 3+');
assert.equal(p1w1.onHandQuantity, 0);
assert.equal(p1w2.onHandQuantity, 5);
assert.equal(p1w2.availableQuantity, 3);
assert.equal(p2w1.onHandQuantity, -1, 'negative stock must remain negative after a partial reversal');
assert.equal(p2w1.negativeOnHand, true);
assert.equal(projection.warnings.find(row => row.productId === 'P-2').onHandQuantity, -1);
assert.equal(projection.backdatedMovementIds.includes('IM-BACKDATED-PURCHASE'), true);
assert.equal(p1w1.movementEvidence.some(row => row.movementId === 'IM-BEFORE-WATERMARK'), false);
assert.deepEqual(p1w1.movementEvidence.map(row => row.movementId), ['IM-BACKDATED-PURCHASE', 'IM-SALE', 'IM-TRANSFER-OUT']);
assert.equal(p1w1.differenceQuantity, -5);
assert.equal(projection.totals.snapshotQuantity, 7);
assert.equal(projection.totals.movementQuantity, -3);
assert.equal(projection.totals.onHandQuantity, 4);
assert.equal(projection.totals.negativeOnHandCount, 1);

const repositorySource = await readFile(new URL('../orderq/inventory-ledger-repository.js', import.meta.url), 'utf8');
assert.match(repositorySource, /byIdempotencyKey/);
assert.match(repositorySource, /byLedgerSequence/);
assert.match(repositorySource, /db\.transaction\(\[STORE\.INVENTORY_MOVEMENTS, STORE\.META\], 'readwrite'\)/);
assert.doesNotMatch(repositorySource, /Math\.abs/);

const historyRepositorySource = await readFile(new URL('../orderq/history-collector/history-repository.js', import.meta.url), 'utf8');
assert.match(historyRepositorySource, /snapshotLastSequence/);
assert.match(historyRepositorySource, /inventoryLedgerSequence/);

console.log('ORDER Q M2 inventory ledger contract tests passed');
console.log(JSON.stringify({
  movementSigns: { purchase: purchase.signedBaseQuantity, sale: sale.signedBaseQuantity, transferNet: 0, reversal: reversal.signedBaseQuantity },
  watermark: projection.basis.snapshotLastSequence,
  backdatedMovementIds: projection.backdatedMovementIds,
  negativeRow: { productId: p2w1.productId, onHandQuantity: p2w1.onHandQuantity },
  differenceEvidence: p1w1.movementEvidence,
  totals: projection.totals
}, null, 2));
