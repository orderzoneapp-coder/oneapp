#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildProductSnapshot } from '../reference-data/product-master-read-adapter.js';
import {
  SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION,
  commitSmartParserStopManagement,
} from '../smartparser/stop-management-command-adapter.js';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function localStore(initial = {}, failKey = '') {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  let failed = false;
  return {
    values,
    api: {
      getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
      setItem(key, value) {
        if (!failed && failKey && String(key) === failKey) {
          failed = true;
          throw new Error(`FORCED_LOCAL_FAILURE:${key}`);
        }
        values.set(String(key), String(value));
      },
      removeItem(key) { values.delete(String(key)); },
    },
  };
}

function atomicStorage(initial) {
  let state = clone(initial);
  let revisionCounter = 1;
  return {
    get state() { return clone(state); },
    async readMasterState(extraKeys = []) {
      const extraStoreEntries = {};
      extraKeys.forEach((key) => { extraStoreEntries[key] = clone(state.extraStoreEntries?.[key]); });
      return { items: clone(state.items), snapshot: clone(state.snapshot), revision: state.revision, extraStoreEntries };
    },
    async commitMasterStateOrThrow(master, options) {
      const before = clone(state);
      if (state.revision !== options.expectedRevision) {
        const error = new Error('revision conflict');
        error.code = 'MERCH_MASTER_REVISION_CONFLICT';
        error.result = { rollbackOk: true, staleRollbackSkipped: false };
        throw error;
      }
      const nextRevision = `rev-${++revisionCounter}`;
      state = {
        items: clone(Object.values(master)),
        snapshot: clone(master),
        revision: nextRevision,
        extraStoreEntries: { ...clone(state.extraStoreEntries || {}), ...clone(options.extraStoreEntries || {}) },
      };
      try {
        if (options.afterVerified) await options.afterVerified();
      } catch (error) {
        state = before;
        const wrapped = new Error(error.message);
        wrapped.code = 'MERCH_MASTER_COMMIT_FAILURE';
        wrapped.result = { rollbackOk: true, staleRollbackSkipped: false };
        throw wrapped;
      }
      return { revision: nextRevision };
    },
  };
}

const initialMaster = {
  A: { 코드: 'A', 품목명: '상품 A', 규격: '1kg', 단위: 'BOX', 판매여부: 1 },
  B: { 코드: 'B', 품목명: '상품 B', 규격: '2kg', 단위: 'EA', 판매여부: 1 },
};
const initialState = {
  items: Object.values(initialMaster),
  snapshot: initialMaster,
  revision: 'rev-1',
  extraStoreEntries: { merchStoppedProducts_v2: {}, pending_shop_status: [] },
};
const storage = atomicStorage(initialState);
const local = localStore({
  merchHistory_v870: '[]',
  merchStoppedProducts_v2: '{}',
  pendingShopStatus: '[]',
});
globalThis.localStorage = local.api;

const initialSnapshot = await buildProductSnapshot({ recordRows: initialState.items, revision: initialState.revision });
const command = {
  schemaVersion: SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION,
  operationId: 'STOP-OP-1',
  action: 'STOP',
  expectedSnapshotId: initialSnapshot.snapshotId,
  expectedRevision: initialState.revision,
  requestedAt: '2026-08-30T01:00:00.000Z',
  actor: { actorState: 'UNVERIFIED_LOCAL' },
  reason: '관리자 정지',
  memo: '검토 완료',
  targets: [{ code: ' A ', beforeSaleStatus: 1, afterSaleStatus: 0, reason: '공급중단', memo: '메모' }],
};

const stopped = await commitSmartParserStopManagement(command, { storage });
assert.equal(stopped.status, 'APPLIED');
assert.equal(stopped.processedCodes[0], 'A');
assert.equal(storage.state.items.find((item) => item.코드 === 'A').판매여부, 0);
assert.equal(storage.state.extraStoreEntries.merchStoppedProducts_v2.A.status, 'stopped');
assert.equal(storage.state.extraStoreEntries.pending_shop_status.find((entry) => entry.code === 'A').type, 'stop');
assert.equal(JSON.parse(local.api.getItem('merchHistory_v870'))[0].newVal, 0);
assert.equal(JSON.parse(local.api.getItem('pendingShopStatus')).find((entry) => entry.code === 'A').type, 'stop');
assert.ok(local.api.getItem('merchMaster_sync_trigger'));
assert.ok(local.api.getItem('merchStopManager_sync_trigger'));
assert.ok(stopped.snapshotId && stopped.revision === 'rev-2');

const duplicate = await commitSmartParserStopManagement(command, { storage });
assert.equal(duplicate.status, 'DUPLICATE');
assert.equal(duplicate.snapshotId, stopped.snapshotId);
assert.equal(JSON.parse(local.api.getItem('merchHistory_v870')).length, 1);

const operationConflict = await commitSmartParserStopManagement({ ...command, reason: '다른 payload' }, { storage });
assert.equal(operationConflict.status, 'CONFLICT');
assert.equal(operationConflict.error.code, 'OPERATION_ID_CONFLICT');

const stoppedState = storage.state;
const stoppedSnapshot = await buildProductSnapshot({ recordRows: stoppedState.items, revision: stoppedState.revision });
const resumeCommand = {
  ...command,
  operationId: 'RESUME-OP-1',
  action: 'RESUME',
  expectedSnapshotId: stoppedSnapshot.snapshotId,
  expectedRevision: stoppedState.revision,
  requestedAt: '2026-08-30T02:00:00.000Z',
  targets: [{ code: 'A', beforeSaleStatus: 0, afterSaleStatus: 1 }],
};
const resumed = await commitSmartParserStopManagement(resumeCommand, { storage });
assert.equal(resumed.status, 'APPLIED');
assert.equal(storage.state.items.find((item) => item.코드 === 'A').판매여부, 1);
assert.equal(storage.state.extraStoreEntries.merchStoppedProducts_v2.A, undefined);
assert.equal(storage.state.extraStoreEntries.pending_shop_status.find((entry) => entry.code === 'A').type, 'resume');

const beforeStopB = storage.state;
const beforeStopBSnapshot = await buildProductSnapshot({ recordRows: beforeStopB.items, revision: beforeStopB.revision });
const stopB = await commitSmartParserStopManagement({
  ...command,
  operationId: 'STOP-B',
  expectedSnapshotId: beforeStopBSnapshot.snapshotId,
  expectedRevision: beforeStopB.revision,
  requestedAt: '2026-08-30T02:30:00.000Z',
  targets: [{ code: 'B', beforeSaleStatus: 1, afterSaleStatus: 0 }],
}, { storage });
assert.equal(stopB.status, 'APPLIED');
const beforeMetadata = storage.state;
const beforeMetadataSnapshot = await buildProductSnapshot({ recordRows: beforeMetadata.items, revision: beforeMetadata.revision });
const metadata = await commitSmartParserStopManagement({
  ...command,
  operationId: 'META-B',
  action: 'UPDATE_METADATA',
  expectedSnapshotId: beforeMetadataSnapshot.snapshotId,
  expectedRevision: beforeMetadata.revision,
  requestedAt: '2026-08-30T02:40:00.000Z',
  targets: [{ code: 'B', reason: '계절종료', memo: '다음 시즌 검토' }],
}, { storage });
assert.equal(metadata.status, 'APPLIED');
assert.equal(storage.state.extraStoreEntries.merchStoppedProducts_v2.B.reason, '계절종료');
assert.equal(storage.state.extraStoreEntries.merchStoppedProducts_v2.B.memo, '다음 시즌 검토');

const stale = await commitSmartParserStopManagement({
  ...resumeCommand,
  operationId: 'STALE-OP',
  expectedSnapshotId: initialSnapshot.snapshotId,
  expectedRevision: initialState.revision,
}, { storage });
assert.equal(stale.status, 'CONFLICT');
assert.equal(stale.error.code, 'PRODUCT_SNAPSHOT_CONFLICT');

const metadataBase = storage.state;
const metadataSnapshot = await buildProductSnapshot({ recordRows: metadataBase.items, revision: metadataBase.revision });
const metadataNoTarget = await commitSmartParserStopManagement({
  ...command,
  operationId: 'META-NOT-STOPPED',
  action: 'UPDATE_METADATA',
  expectedSnapshotId: metadataSnapshot.snapshotId,
  expectedRevision: metadataBase.revision,
  requestedAt: '2026-08-30T03:00:00.000Z',
  targets: [{ code: 'A', reason: '변경' }],
}, { storage });
assert.equal(metadataNoTarget.status, 'CONFLICT');
assert.equal(metadataNoTarget.error.code, 'STOPPED_PRODUCT_NOT_FOUND:A');

const failureStorage = atomicStorage(initialState);
const failureLocal = localStore({
  merchHistory_v870: '[{"id":"before"}]',
  merchStoppedProducts_v2: '{"OLD":{"productCode":"OLD"}}',
  pendingShopStatus: '[{"code":"OLD"}]',
  merchMaster_sync_trigger: 'master-before',
  merchStopManager_sync_trigger: 'stop-before',
}, 'merchStopManager_sync_trigger');
globalThis.localStorage = failureLocal.api;
const beforeFailureState = failureStorage.state;
const beforeFailureLocal = Object.fromEntries(failureLocal.values);
const failed = await commitSmartParserStopManagement(command, { storage: failureStorage });
assert.equal(failed.status, 'ERROR');
assert.equal(failed.rollback.restored, true);
assert.deepEqual(failureStorage.state, beforeFailureState, 'failed linked local write must roll back master and indexed linked state');
assert.deepEqual(Object.fromEntries(failureLocal.values), beforeFailureLocal, 'failed linked local write must restore every compatibility mirror and notification');

const duplicateTargets = await commitSmartParserStopManagement({ ...command, operationId: 'BAD-DUP', targets: [command.targets[0], command.targets[0]] }, { storage: failureStorage });
assert.equal(duplicateTargets.status, 'REJECTED');
assert.ok(duplicateTargets.validation.errors.some((error) => error.code === 'DUPLICATE_TARGET_CODE'));

console.log('PASS test-smartparser-stop-command-adapter');
