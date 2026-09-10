#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildProductSnapshot } from '../reference-data/product-master-read-adapter.js';
import { createSmartParserAnalysisResult } from '../smartparser/analysis-result-contract.js';
import {
  commitSmartParserCatalogApply,
  createSmartParserCatalogApplyCommand,
} from '../smartparser/catalog-apply-command-adapter.js';

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
  let revisionCounter = Number(String(initial.revision).replace(/\D/g, '')) || 1;
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

async function analysisFor(state, { id, catalog = 'CAT', rows, workflow = 'ANALYSIS_REVIEW' }) {
  const snapshot = await buildProductSnapshot({ recordRows: state.items, storeSnapshot: state.snapshot, revision: state.revision });
  return createSmartParserAnalysisResult({
    analysisId: `AN-${id}`,
    idempotencyKey: `IDEM-${id}`,
    createdAt: '2026-09-10T01:00:00.000Z',
    sourceMetadata: { catalog, documentDisplayName: catalog, catalogWarehouse: '01', updateTextData: true, workflow },
    baseProductSnapshot: snapshot,
    rows,
  });
}

const initialMaster = {
  A: { 코드: 'A', 품목명: '기존 A', 규격: '1kg', 단위: 'BOX', 입고가: 1000, 카탈로그: 'KEEP, CAT', 판매여부: 1 },
  B: { 코드: 'B', 품목명: '기존 B', 규격: '2kg', 단위: 'EA', 입고가: 2000, 카탈로그: 'CAT, OTHER', 판매여부: 1 },
};
const initialState = {
  items: Object.values(initialMaster),
  snapshot: initialMaster,
  revision: 'rev-1',
  extraStoreEntries: { merchStoppedProducts_v2: {}, pending_shop_status: [] },
};
const initialLocal = {
  merchHistory_v870: '[]',
  merchStoppedProducts_v2: '{}',
  pendingShopStatus: '[]',
};

const storage = atomicStorage(initialState);
const local = localStore(initialLocal);
globalThis.localStorage = local.api;

const updateAnalysis = await analysisFor(storage.state, {
  id: 'APPLY',
  catalog: 'CAT',
  rows: [
    {
      rowId: 'existing-a',
      match: { status: '🟢 일치', productCode: 'A', normalizedProductCode: 'A', isNewProduct: false, candidates: [] },
      proposedChanges: [
        { field: '품목명', beforeValue: '기존 A', proposedValue: '검토 A', reason: '관리자 검토 상품명' },
        { field: '입고가', beforeValue: 1000, proposedValue: 1200, reason: '검토 단가' },
      ],
      decision: { selected: true, excluded: false, blocked: false },
    },
    {
      rowId: 'new-c',
      match: { status: '🟢 신규등록 예정', productCode: 'C-1', normalizedProductCode: 'C1', isNewProduct: true, candidates: [] },
      proposedChanges: [
        { field: '코드', beforeValue: '', proposedValue: 'C-1', reason: '검토 신규 코드' },
        { field: '품목명', beforeValue: '', proposedValue: '신규 C', reason: '검토 신규 상품명' },
        { field: '카탈로그', beforeValue: '', proposedValue: 'CAT', reason: '카탈로그 연결' },
      ],
      decision: { selected: true, excluded: false, blocked: false },
    },
  ],
});
const updateCommand = createSmartParserCatalogApplyCommand(updateAnalysis, {
  action: 'APPLY_ANALYSIS',
  operationId: 'SP-APPLY-1',
  requestedAt: '2026-09-10T02:00:00.000Z',
  actor: { actorState: 'UNVERIFIED_LOCAL' },
});
const applied = await commitSmartParserCatalogApply(updateCommand, { storage });
assert.equal(applied.status, 'APPLIED');
assert.equal(storage.state.items.find((item) => item.코드 === 'A').품목명, '검토 A');
assert.equal(storage.state.items.find((item) => item.코드 === 'A').입고가, 1200);
assert.equal(storage.state.items.find((item) => item.코드 === 'C-1').품목명, '신규 C');
assert.equal(JSON.parse(local.api.getItem('merchHistory_v870')).length, 5);
assert.ok(JSON.parse(local.api.getItem('merchHistory_v870')).every((entry) => entry.actionType === 'smartparser_catalog_apply'));
assert.equal(local.api.getItem('merchMaster_sync_trigger'), updateCommand.requestedAt);

const duplicate = await commitSmartParserCatalogApply(updateCommand, { storage });
assert.equal(duplicate.status, 'DUPLICATE');
assert.equal(JSON.parse(local.api.getItem('merchHistory_v870')).length, 5, 'idempotent retry must not append history');
const operationConflict = await commitSmartParserCatalogApply({ ...updateCommand, catalog: 'OTHER' }, { storage });
assert.equal(operationConflict.status, 'CONFLICT');
assert.equal(operationConflict.error.code, 'OPERATION_ID_CONFLICT');

const beforeExcludeA = storage.state;
const excludeAAnalysis = await analysisFor(beforeExcludeA, {
  id: 'EXCLUDE-A',
  catalog: 'CAT',
  workflow: 'CATALOG_SUPPLY_STOP_REVIEW',
  rows: [{
    rowId: 'exclude-a',
    match: { status: '🟢 카탈로그 연결', productCode: 'A', normalizedProductCode: 'A', isNewProduct: false, candidates: [] },
    proposedChanges: [{ field: '카탈로그', beforeValue: 'KEEP, CAT', proposedValue: 'KEEP', reason: 'CAT 제외' }],
    decision: { selected: true, excluded: false, blocked: false },
  }],
});
const excludeACommand = createSmartParserCatalogApplyCommand(excludeAAnalysis, {
  action: 'EXCLUDE_CATALOG', operationId: 'SP-EXCLUDE-A', requestedAt: '2026-09-10T03:00:00.000Z',
});
const excludedWithoutStop = await commitSmartParserCatalogApply(excludeACommand, { storage });
assert.equal(excludedWithoutStop.status, 'APPLIED');
const excludedA = storage.state.items.find((item) => item.코드 === 'A');
assert.equal(excludedA.카탈로그, 'KEEP', 'only the selected catalog tag is removed');
assert.equal(excludedA.판매여부, 1, 'sale status stays unchanged when the checkbox is off');
assert.deepEqual(storage.state.extraStoreEntries.merchStoppedProducts_v2, {});

const beforeExcludeB = storage.state;
const excludeBAnalysis = await analysisFor(beforeExcludeB, {
  id: 'EXCLUDE-B',
  catalog: 'CAT',
  workflow: 'CATALOG_SUPPLY_STOP_REVIEW',
  rows: [{
    rowId: 'exclude-b',
    match: { status: '🟢 카탈로그 연결', productCode: 'B', normalizedProductCode: 'B', isNewProduct: false, candidates: [] },
    proposedChanges: [{ field: '카탈로그', beforeValue: 'CAT, OTHER', proposedValue: 'OTHER', reason: 'CAT 제외' }],
    decision: { selected: true, excluded: false, blocked: false },
  }],
});
const excludeBCommand = createSmartParserCatalogApplyCommand(excludeBAnalysis, {
  action: 'EXCLUDE_CATALOG', operationId: 'SP-EXCLUDE-B', requestedAt: '2026-09-10T04:00:00.000Z', applyStop: true, stopReason: '판매종료',
});
const excludedWithStop = await commitSmartParserCatalogApply(excludeBCommand, { storage });
assert.equal(excludedWithStop.status, 'APPLIED');
const excludedB = storage.state.items.find((item) => item.코드 === 'B');
assert.equal(excludedB.카탈로그, 'OTHER');
assert.equal(excludedB.판매여부, 0);
assert.equal(storage.state.extraStoreEntries.merchStoppedProducts_v2.B.reason, '판매종료');
assert.equal(storage.state.extraStoreEntries.pending_shop_status.find((entry) => entry.code === 'B').type, 'stop');
assert.equal(JSON.parse(local.api.getItem('pendingShopStatus')).find((entry) => entry.code === 'B').reason, '판매종료');
assert.ok(JSON.parse(local.api.getItem('merchHistory_v870')).some((entry) => entry.actionType === 'smartparser_catalog_exclude_stop' && entry.newVal === 0));
assert.equal(local.api.getItem('merchStopManager_sync_trigger'), excludeBCommand.requestedAt);

const invalidReason = await commitSmartParserCatalogApply({ ...excludeBCommand, operationId: 'INVALID-REASON', stop: { enabled: true, reason: '임의사유' } }, { storage });
assert.equal(invalidReason.status, 'REJECTED');
assert.ok(invalidReason.validation.errors.some((error) => error.code === 'STOP_REASON_INVALID'));
const invalidRemoval = await commitSmartParserCatalogApply({
  ...excludeBCommand,
  operationId: 'INVALID-SCOPE',
  items: [{ ...excludeBCommand.items[0], changes: [{ field: '카탈로그', beforeValue: 'CAT, OTHER', afterValue: '', reason: '다른 카탈로그까지 삭제' }] }],
}, { storage });
assert.equal(invalidRemoval.status, 'REJECTED');
assert.ok(invalidRemoval.validation.errors.some((error) => error.code === 'CATALOG_REMOVAL_SCOPE_INVALID'));

const staleStorage = atomicStorage(initialState);
globalThis.localStorage = localStore(initialLocal).api;
const staleCommand = { ...updateCommand, operationId: 'STALE', expectedSnapshotId: 'PRODUCT-stale-deadbeef0000' };
const stale = await commitSmartParserCatalogApply(staleCommand, { storage: staleStorage });
assert.equal(stale.status, 'CONFLICT');
assert.equal(stale.error.code, 'PRODUCT_SNAPSHOT_CONFLICT');

const failureStorage = atomicStorage(initialState);
const failureLocal = localStore({
  ...initialLocal,
  merchHistory_v870: '[{"id":"before"}]',
  merchMaster_sync_trigger: 'before-sync',
}, 'merchMaster_sync_trigger');
globalThis.localStorage = failureLocal.api;
const beforeFailureState = failureStorage.state;
const beforeFailureLocal = Object.fromEntries(failureLocal.values);
const failed = await commitSmartParserCatalogApply(updateCommand, { storage: failureStorage });
assert.equal(failed.status, 'ERROR');
assert.equal(failed.rollback.restored, true);
assert.deepEqual(failureStorage.state, beforeFailureState, 'linked mirror failure must roll back product state');
assert.deepEqual(Object.fromEntries(failureLocal.values), beforeFailureLocal, 'linked mirror failure must restore history and notifications');

console.log('PASS test-smartparser-catalog-apply-command-adapter');
