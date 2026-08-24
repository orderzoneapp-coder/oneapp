#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ORDERQ_DB_VERSION,
  DISPATCH_STAGE,
  ERP_POSTING_STATUS,
  V7_EXISTING_STORE_INDEXES,
  V7_STORE_DEFINITIONS,
  V7_SYNC_ENTITY_CONTRACT,
  adaptLegacyInventoryLine,
  buildExternalIdentityKey,
  createActorContext,
  legacyInventoryEffect,
  normalizeDispatchStageCode,
  normalizeErpPostingFields,
  normalizeExternalIdentity,
  requireActor,
  requireCapability
} from '../orderq/orderq-v7-contracts.js';
import { ORDERQ_DB_VERSION as CURRENT_ORDERQ_DB_VERSION } from '../orderq/orderq-v14-contracts.js';
import {
  ORDERQ_BACKUP_FORMAT,
  ORDERQ_BACKUP_FORMAT_VERSION,
  actorAuditFields,
  validateOrderQBackup
} from '../orderq/orderq-v7-repository.js';

assert.equal(ORDERQ_DB_VERSION, 7);
assert.equal(V7_STORE_DEFINITIONS.length, 7);
assert.equal(Object.keys(V7_SYNC_ENTITY_CONTRACT).length, 7);
for (const storeName of ['salesDocuments', 'purchaseDocuments']) {
  const indexes = V7_EXISTING_STORE_INDEXES[storeName];
  const erpStatusIndex = indexes.find(entry => entry.name === 'byErpPostingStatus');
  assert.ok(erpStatusIndex, `${storeName}.byErpPostingStatus is required`);
  assert.deepEqual(erpStatusIndex.keyPath, ['erpPostingStatus', 'businessDate']);
  assert.equal(erpStatusIndex.options.unique, undefined);
  assert.equal(indexes.some(entry => entry.name === 'byErpPostingStatusDate'), false);
}
assert.equal(normalizeDispatchStageCode('first_wholesale'), DISPATCH_STAGE.FIRST_WHOLESALE);
assert.equal(normalizeDispatchStageCode('legacy-unknown'), DISPATCH_STAGE.UNSPECIFIED);

const identity = normalizeExternalIdentity({
  originSystem: ' ERP ',
  originTransactionId: 0,
  externalDocumentNo: '0',
  externalLineNo: '',
  importBatchId: ' B-1 ',
  sourceFingerprint: '',
  sourceLineFingerprint: 0
});
assert.deepEqual(identity, {
  idempotencyKey: '',
  originSystem: 'ERP',
  originTransactionId: '0',
  externalDocumentNo: '0',
  externalLineNo: '',
  importBatchId: 'B-1',
  sourceFingerprint: '',
  sourceLineFingerprint: '0'
});
assert.equal(buildExternalIdentityKey(identity), 'TX:ERP:0');
assert.equal(buildExternalIdentityKey({ originSystem: 'ERP', externalDocumentNo: 'D-1', externalLineNo: 0 }), 'DOC:ERP:D-1:0');

assert.deepEqual(normalizeErpPostingFields({ status: 'CONFIRMED', erpDocumentNo: 0 }), {
  erpPostingStatus: ERP_POSTING_STATUS.READY,
  erpDocumentNo: '0',
  erpPostedAt: '',
  erpPostedBy: '',
  erpReconciledAt: '',
  erpReconciliationId: '',
  erpCorrectionReason: ''
});
assert.equal(normalizeErpPostingFields({ status: 'DRAFT' }).erpPostingStatus, ERP_POSTING_STATUS.NOT_READY);

assert.deepEqual(createActorContext(), { actorId: 'ADMIN', capabilities: [] });
assert.throws(() => requireActor(''), /ORDERQ_ACTOR_REQUIRED/);
assert.throws(
  () => requireCapability({ actorId: 'WORKER', capabilities: [] }, 'DISPATCH_CONFIRM'),
  /ORDERQ_CAPABILITY_REQUIRED:DISPATCH_CONFIRM/
);
assert.equal(actorAuditFields('ADMIN', '2026-08-15T00:00:00.000Z').createdBy, 'ADMIN');

const legacyCases = [
  { documentType: 'PURCHASE', status: 'ACTIVE', quantity: 8, inventoryEffect: 8 },
  { documentType: 'PURCHASE', status: 'REVERSAL', quantity: -8, inventoryEffect: -8 },
  { documentType: 'SALES', status: 'ACTIVE', quantity: 8, inventoryEffect: -8 },
  { documentType: 'SALES', status: 'REVERSAL', quantity: -8, inventoryEffect: 8 }
];
for (const testCase of legacyCases) {
  const result = legacyInventoryEffect(testCase);
  assert.equal(result.rawQuantity, testCase.quantity);
  assert.equal(result.inventoryEffect, testCase.inventoryEffect);
  assert.equal(result.included, true);
}
const zeroEffect = legacyInventoryEffect({ documentType: 'SALES', status: 'ACTIVE', quantity: 0 });
assert.equal(zeroEffect.rawQuantity, 0);
assert.equal(zeroEffect.inventoryEffect, 0);
assert.equal(legacyInventoryEffect({ documentType: 'SALES', quantity: 3, rolledBackAt: '2026-08-15' }).included, false);
assert.deepEqual(adaptLegacyInventoryLine({
  documentType: 'PURCHASE',
  document: { purchaseDocumentId: 'PD-0', warehouseId: 'W-0', status: 'ACTIVE' },
  line: { purchaseLineId: 'PL-0', purchaseDocumentId: 'PD-0', productCode: '0', quantity: 0, unit: '' }
}), {
  included: true,
  documentType: 'PURCHASE',
  status: 'ACTIVE',
  rawQuantity: 0,
  inventoryEffect: 0,
  sourceDocumentId: 'PD-0',
  sourceLineId: 'PL-0',
  productId: '',
  productCode: '0',
  warehouseId: 'W-0',
  rawUnit: '',
  rawValue: 0
});

const backup = {
  format: ORDERQ_BACKUP_FORMAT,
  formatVersion: ORDERQ_BACKUP_FORMAT_VERSION,
  schemaVersion: 6,
  stores: { orders: [{ orderId: 'O-0', memo: '', amount: 0 }] }
};
assert.deepEqual(validateOrderQBackup(backup), {
  schemaVersion: 6,
  storeNames: ['orders'],
  counts: { orders: 1 }
});
assert.doesNotThrow(() => validateOrderQBackup({ ...backup, schemaVersion: CURRENT_ORDERQ_DB_VERSION }));
assert.throws(() => validateOrderQBackup({ ...backup, schemaVersion: CURRENT_ORDERQ_DB_VERSION + 1 }), /ORDERQ_BACKUP_SCHEMA_UNSUPPORTED/);
assert.throws(() => validateOrderQBackup({ ...backup, stores: { unknownStore: [] } }), /ORDERQ_BACKUP_UNKNOWN_STORE/);

const dbSource = await readFile(new URL('../orderq/orderq-db.js', import.meta.url), 'utf8');
assert.match(dbSource, /export const DB_VERSION = ORDERQ_DB_VERSION/);
assert.match(dbSource, /oldVersion < 7/);
assert.match(dbSource, /upgradeOrderQDbSchema/);
assert.match(dbSource, /dbPromise = null/);
assert.doesNotMatch(dbSource, /Math\.abs/);

console.log('ORDER Q M1 foundation contract tests passed');
console.log(JSON.stringify({
  schemaVersion: ORDERQ_DB_VERSION,
  v7Stores: V7_STORE_DEFINITIONS.map(row => row.name),
  legacyCases,
  blankAndZeroIdentity: identity,
  actorBoundary: 'ADMIN default; explicit blank rejected',
  backupSchemasAccepted: '1..8 (v7 contract remains readable)'
}, null, 2));
