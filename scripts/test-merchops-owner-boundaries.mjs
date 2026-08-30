import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProductSnapshot } from '../reference-data/product-master-read-adapter.js';
import {
  createProductMasterCommandAdapter,
  MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION,
  PRODUCT_MASTER_COMMAND_ADAPTER_VERSION,
} from '../reference-data/product-master-command-adapter.js';
import { getMerchOpsSettingsSnapshotResult } from '../reference-data/merchops-settings-read-adapter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = (value) => structuredClone(value);

function createHarness(options = {}) {
  let products = {
    A001: { 코드: 'A001', 품목명: '사과', 규격: '1kg', 입고가: 1000, 출고가: 1500, 판매여부: 1 },
    B002: { 코드: 'B002', 품목명: '배', 규격: '1kg', 입고가: 2000, 출고가: 2800, 판매여부: 1 },
  };
  let revisionNumber = 1;
  let revision = 'rev-1';
  let historyRaw = options.historyRaw ?? '[]';
  let linkedReads = 0;
  let snapshotReads = 0;

  const readSnapshotResult = async () => {
    snapshotReads += 1;
    if (options.failFinalVerify && snapshotReads === 4) {
      return { status: 'ERROR', snapshot: null, error: { code: 'FORCED_FINAL_VERIFY_FAILURE' } };
    }
    const snapshot = await buildProductSnapshot({ recordRows: Object.values(products), revision }, { now: '2026-08-30T00:00:00.000Z' });
    return { status: snapshot.status, snapshot, error: null };
  };
  const commitMasterState = async (nextProducts, commitOptions = {}) => {
    if (String(commitOptions.expectedRevision) !== revision) {
      return { ok: false, conflict: true, revision, error: 'REVISION_CONFLICT', rollbackOk: false };
    }
    const previous = clone(products);
    const previousRevision = revision;
    products = clone(nextProducts);
    revisionNumber += 1;
    revision = `rev-${revisionNumber}`;
    try {
      await commitOptions.afterVerified?.();
      return { ok: true, revision, rollbackOk: false };
    } catch (error) {
      products = previous;
      revision = previousRevision;
      return { ok: false, revision, error: String(error?.message || error), rollbackOk: true };
    }
  };
  const dependencies = {
    readSnapshotResult,
    commitMasterState,
    readHistoryRaw: () => historyRaw,
    appendHistory: async (logs) => {
      if (options.failHistory) throw new Error('HISTORY_WRITE_FAILED');
      historyRaw = JSON.stringify([...JSON.parse(historyRaw || '[]'), ...clone(logs)]);
      return true;
    },
    restoreHistoryRaw: async (raw) => {
      historyRaw = raw;
      return true;
    },
    readLinkedState: async () => {
      linkedReads += 1;
      if (options.changeLinkedState && linkedReads > 1) return { stop: 'changed' };
      return { stop: 'same' };
    },
    publishNotification: () => true,
    now: () => '2026-08-30T00:00:01.000Z',
  };
  return {
    adapter: createProductMasterCommandAdapter(dependencies),
    readSnapshotResult,
    products: () => clone(products),
    history: () => JSON.parse(historyRaw || '[]'),
  };
}

async function commandFor(harness, overrides = {}) {
  const base = (await harness.readSnapshotResult()).snapshot;
  const patch = overrides.patch || {
    code: 'A001',
    field: '출고가',
    beforeValue: 1500,
    afterValue: 1600,
    history: {
      code: 'A001', field: '출고가', beforeValue: 1500, afterValue: 1600,
      entry: { actionType: 'F7 검토 작업 적용', source: 'MerchOps estimate source' },
    },
  };
  return {
    schemaVersion: MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION,
    operationId: overrides.operationId || 'op-1',
    ownerAppId: 'master-lookup',
    sourceAppId: 'merchops',
    expectedRevision: overrides.expectedRevision || base.snapshotVersion,
    baseSnapshotId: overrides.baseSnapshotId || base.snapshotId,
    baseContentHash: overrides.baseContentHash || base.contentHash,
    reason: overrides.reason || 'F7 검토 작업 반영',
    actor: { actorId: 'tester', actorState: 'UNVERIFIED_LOCAL' },
    patches: [patch],
  };
}

{
  const harness = createHarness();
  const command = await commandFor(harness);
  const applied = await harness.adapter.commitReviewedMerchOpsWork(command);
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.adapterVersion, PRODUCT_MASTER_COMMAND_ADAPTER_VERSION);
  assert.equal(applied.rowCount, 2, 'reviewed patch must preserve row count');
  assert.equal(harness.products().A001.출고가, 1600);
  assert.equal(harness.products().B002.출고가, 2800, 'unpatched product must remain byte-for-byte equivalent');
  assert.equal(harness.history().length, 1);

  const duplicate = await harness.adapter.commitReviewedMerchOpsWork(command);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(harness.history().length, 1, 'idempotent retry must not duplicate history');

  const stale = await commandFor(harness, {
    operationId: 'op-stale',
    expectedRevision: 'rev-1',
    baseSnapshotId: command.baseSnapshotId,
    baseContentHash: command.baseContentHash,
    patch: { ...command.patches[0], beforeValue: 1500, afterValue: 1700,
      history: { ...command.patches[0].history, beforeValue: 1500, afterValue: 1700 } },
  });
  const conflict = await harness.adapter.commitReviewedMerchOpsWork(stale);
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(harness.products().A001.출고가, 1600);
}

{
  const harness = createHarness({ failHistory: true });
  const result = await harness.adapter.commitReviewedMerchOpsWork(await commandFor(harness));
  assert.equal(result.ok, false);
  assert.equal(result.rollback.master, true, 'history failure must roll back master');
  assert.equal(result.rollback.history, true, 'history raw value must be restored');
  assert.equal(harness.products().A001.출고가, 1500);
  assert.deepEqual(harness.history(), []);
}

{
  const harness = createHarness({ changeLinkedState: true });
  const result = await harness.adapter.commitReviewedMerchOpsWork(await commandFor(harness));
  assert.equal(result.ok, false);
  assert.equal(result.rollback.master, true, 'linked-state mutation must roll back master');
  assert.equal(result.rollback.linkedState, false);
  assert.equal(harness.products().A001.출고가, 1500);
}

{
  const harness = createHarness({ failFinalVerify: true });
  const result = await harness.adapter.commitReviewedMerchOpsWork(await commandFor(harness));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FINAL_PRODUCT_MASTER_VERIFY_FAILED');
  assert.equal(result.rollback.master, true, 'final verification failure must CAS-roll back master');
  assert.equal(result.rollback.history, true, 'final verification failure must restore history');
  assert.equal(harness.products().A001.출고가, 1500);
  assert.deepEqual(harness.history(), []);
}

{
  const harness = createHarness();
  const sale = await commandFor(harness, {
    operationId: 'op-sale-rejected',
    patch: {
      code: 'A001', field: '판매여부', beforeValue: 1, afterValue: 0,
      history: { code: 'A001', field: '판매여부', beforeValue: 1, afterValue: 0,
        entry: { actionType: '엑셀 판매여부 반영', source: 'MerchOps info' } },
    },
  });
  const rejectedSale = await harness.adapter.commitReviewedMerchOpsWork(sale);
  assert.equal(rejectedSale.status, 'REJECTED');
  assert.equal(rejectedSale.error.code, 'PATCH_SALE_POLICY_NOT_ALLOWED');

  const noInbound = await commandFor(harness, {
    operationId: 'op-no-inbound',
    patch: {
      code: 'A001', field: '판매여부', beforeValue: 1, afterValue: 0,
      history: { code: 'A001', field: '판매여부', beforeValue: 1, afterValue: 0,
        entry: { actionType: '입고가없음 판매정지', source: 'MerchOps no-inbound queue' } },
    },
  });
  const appliedSale = await harness.adapter.commitReviewedMerchOpsWork(noInbound);
  assert.equal(appliedSale.status, 'APPLIED');
  assert.equal(harness.products().A001.판매여부, 0);
}

{
  let writes = 0;
  const storage = {
    getItem(key) {
      const values = {
        oneapp_cloud_sync_url_v1: 'https://example.invalid/owned-by-settings',
        merchMarginRules_v878: '[]', merchMappings_v870: '{}', merchMasterLinks_v870: '{}',
        merchTableViewPresets_v1: '{}', merchActiveTableTarget_v1: 'estimate', merchActiveTableViewId_v1: 'view-1',
      };
      return values[key] ?? null;
    },
    setItem() { writes += 1; },
    removeItem() { writes += 1; },
  };
  const settings = getMerchOpsSettingsSnapshotResult(storage);
  assert.equal(settings.status, 'READY');
  assert.equal(settings.snapshot.ownerAppId, 'settings');
  assert.equal(writes, 0, 'settings adapter must be read-only');
}

const html = fs.readFileSync(path.join(ROOT, 'MerchOps.html'), 'utf8');
const business = html.slice(html.indexOf('const useMerchConfig ='));
assert.doesNotMatch(business, /data\.setMasterProducts|commitMerchMasterState|commitMasterStateOrThrow/);
for (const key of [
  'oneapp_cloud_sync_url_v1', 'merchMarginRules_v878', 'merchMappings_v870', 'merchMasterLinks_v870',
  'merchTableViewPresets_v1', 'merchActiveTableTarget_v1', 'merchActiveTableViewId_v1', 'parserDict_v870',
]) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(business, new RegExp(`localStorage\\.(?:setItem|removeItem)\\(['\"]${escaped}`), `${key} must remain read-only`);
}
assert.match(business, /data\.commitReviewedWork\(newMaster, localLogs/);
assert.match(business, /data\.commitReviewedWork\(nextMaster, history/);
assert.match(business, /status: 'OWNER_ROUTED', ownerAppId: 'settings'/);
assert.match(business, /status: 'OWNER_ROUTED', ownerAppId: 'master-lookup'/);
assert.match(business, /'PENDING', 'DUPLICATE'/);
assert.match(html, /MERCHOPS_WORK_VIEW_STATE_KEY = 'merchops_work_view_state_v1'/);

const f8 = business.slice(business.indexOf('const handleQuickExcelExport ='), business.indexOf('const handleCommitEstimate ='));
assert.doesNotMatch(f8, /commitReviewedWork|setMasterProducts|commitMerchMasterState/);
const f9 = business.slice(business.indexOf('const handleOpenExportCenter ='), business.indexOf('const handleRegisterUnregisteredItems ='));
assert.match(f9, /ONEAPP\.EXPORT\.buildWorkingPayload/);
assert.doesNotMatch(f9, /commitReviewedWork|setMasterProducts|commitMerchMasterState/);

console.log('MerchOps owner-boundary, reviewed-command, rollback, settings-read, F8/F9 contracts passed.');
