#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  createInventoryCheckpoint,
  planPendingInventoryResolution
} from '../orderq/inventory-rematch-core.js';

const checkpoint = createInventoryCheckpoint({
  companyId: 'C1',
  warehouseId: 'W1',
  sessionId: 'STOCKTAKE-20260825',
  effectiveAt: '2026-08-25',
  coversAllProducts: true,
  counts: [{ productId: 'P1', quantity: 100 }],
  actor: 'user-1',
  confirmedAt: '2026-08-25T12:00:00.000Z'
});

const baseEffect = {
  companyId: 'C1',
  warehouseId: 'W1',
  unresolvedProductId: 'U1',
  sourceDocumentId: 'S1',
  sourceLineId: 'SL1',
  sourceDocumentRevision: 2,
  voucherMode: 'sale',
  signedQuantity: -2,
  status: 'PENDING_PRODUCT_MATCH'
};

const resolution = planPendingInventoryResolution({
  companyId: 'C1',
  unresolvedProductId: 'U1',
  productId: 'P1',
  actor: 'user-1',
  occurredAt: '2026-09-01T09:00:00.000Z',
  pendingEffects: [
    { ...baseEffect, pendingEffectId: 'PE-24', effectiveAt: '2026-08-24' },
    { ...baseEffect, pendingEffectId: 'PE-26', effectiveAt: '2026-08-26', sourceLineId: 'SL2' }
  ],
  inventoryCheckpoints: [checkpoint]
});

assert.equal(resolution.resolvedEffects[0].status, 'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE',
  'a sale dated before the latest stocktake must not reduce inventory when matched later');
assert.equal(resolution.resolvedEffects[0].checkpointId, checkpoint.checkpointId);
assert.equal(resolution.resolvedEffects[1].status, 'RESOLVED_TO_INVENTORY');
assert.equal(resolution.inventoryMovements.length, 1);
assert.equal(resolution.inventoryMovements[0].pendingEffectId, 'PE-26');
assert.equal(resolution.inventoryMovements[0].signedQuantity, -2);
assert.equal(resolution.productResolution.status, 'MATCHED');

const otherWarehouse = planPendingInventoryResolution({
  companyId: 'C1', unresolvedProductId: 'U2', productId: 'P1', actor: 'user-1', occurredAt: '2026-09-01T09:00:00.000Z',
  pendingEffects: [{ ...baseEffect, unresolvedProductId: 'U2', pendingEffectId: 'PE-W2', warehouseId: 'W2', effectiveAt: '2026-08-24' }],
  inventoryCheckpoints: [checkpoint]
});
assert.equal(otherWarehouse.inventoryMovements.length, 1, 'a stocktake boundary must apply only to its warehouse');

console.log('Inventory stocktake boundary and delayed unmatched-product resolution passed.');
