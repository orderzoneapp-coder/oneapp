import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { buildProductSnapshot } from '../reference-data/product-master-read-adapter.js';
import {
  createProductMasterCommandAdapter,
  MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION,
  MERCHOPS_PRODUCT_REGISTRATION_FIELDS,
  MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION,
  PRODUCT_MASTER_COMMAND_ADAPTER_VERSION,
} from '../reference-data/product-master-command-adapter.js';
import { getMerchOpsSettingsSnapshotResult } from '../reference-data/merchops-settings-read-adapter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = (value) => structuredClone(value);

function createHarness(options = {}) {
  let products = options.products === undefined ? {
    A001: { 코드: 'A001', 품목명: '사과', 규격: '1kg', 입고가: 1000, 출고가: 1500, 판매여부: 1 },
    B002: { 코드: 'B002', 품목명: '배', 규격: '1kg', 입고가: 2000, 출고가: 2800, 판매여부: 1 },
  } : clone(options.products);
  let revisionNumber = 1;
  let revision = options.rawRevision ?? 'rev-1';
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
    if (commitOptions.expectedRevision !== revision) {
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
    readMasterState: async () => ({ revision }),
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

async function registrationCommandFor(harness, overrides = {}) {
  const base = (await harness.readSnapshotResult()).snapshot;
  return {
    schemaVersion: MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION,
    operationId: overrides.operationId || 'register-op-1',
    ownerAppId: 'master-lookup',
    sourceAppId: 'merchops',
    expectedRevision: overrides.expectedRevision || base.snapshotVersion,
    baseSnapshotId: overrides.baseSnapshotId || base.snapshotId,
    baseContentHash: overrides.baseContentHash || base.contentHash,
    reason: overrides.reason || 'MerchOps 미등록 상품 관리자 확인 등록',
    actor: { actorId: 'tester', actorState: 'UNVERIFIED_LOCAL' },
    products: overrides.products || [{
      코드: 'C003', 품목코드: 'C003', 품목명: '감', 규격: '3kg', 단위: 'BOX',
      입고가: 3000, 구매처: '테스트 공급사', 창고: '01', 기본: '1', 과세: 0,
    }],
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
  const harness = createHarness();
  const command = await registrationCommandFor(harness);
  const applied = await harness.adapter.registerMerchOpsProducts(command);
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.commandSchemaVersion, MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION);
  assert.equal(applied.createdCount, 1);
  assert.equal(harness.products().C003.품목명, '감');
  assert.equal(harness.products().C003.입고가, 3000);
  assert.equal('수량' in harness.products().C003, false, 'operational quantity must not enter product master');
  assert.equal('기준일자' in harness.products().C003, false, 'business date must remain in the worktable');
  assert.ok(harness.history().some(row => row.actionType === 'merchops_product_registration_job'));
  assert.ok(harness.history().some(row => row.actionType === 'master_create' && row.code === 'C003' && row.field === '코드'));

  const duplicate = await harness.adapter.registerMerchOpsProducts(command);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(harness.history().filter(row => row.operationId === command.operationId).length, applied.historyCount,
    'idempotent registration retry must not duplicate history');
}

{
  const harness = createHarness({ rawRevision: 41 });
  const command = await registrationCommandFor(harness, { operationId: 'register-legacy-numeric-revision' });
  assert.equal(command.expectedRevision, '41', 'public snapshots normalize legacy numeric revisions to strings');
  const applied = await harness.adapter.registerMerchOpsProducts(command);
  assert.equal(applied.status, 'APPLIED', 'owner adapter must preserve the raw revision type at the commit boundary');
  assert.equal(harness.products().C003.품목명, '감');
}

{
  const harness = createHarness({ rawRevision: 41 });
  const command = await commandFor(harness, { operationId: 'reviewed-work-legacy-numeric-revision' });
  const applied = await harness.adapter.commitReviewedMerchOpsWork(command);
  assert.equal(applied.status, 'APPLIED', 'existing reviewed work must also preserve legacy raw revision types');
  assert.equal(harness.products().A001.출고가, 1600);
}

{
  const harness = createHarness({ products: {} });
  const result = await harness.adapter.registerMerchOpsProducts(await registrationCommandFor(harness, {
    operationId: 'register-empty-master-batch',
    products: [
      { 코드: 'FIRST-1', 품목명: '첫 상품', 규격: '1kg', 단위: 'BOX' },
      { 코드: 'FIRST-2', 품목명: '둘째 상품', 규격: '2kg', 단위: 'EA', 입고가: 0 },
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.createdCount, 2);
  assert.deepEqual(Object.keys(harness.products()).sort(), ['FIRST-1', 'FIRST-2']);
  assert.equal(harness.products()['FIRST-2'].입고가, 0);
}

{
  const harness = createHarness();
  const before = harness.products();
  const duplicateCodeBatch = await registrationCommandFor(harness, {
    operationId: 'register-duplicate-batch',
    products: [
      { 코드: 'C003', 품목명: '감', 규격: '3kg', 단위: 'BOX' },
      { 품목코드: 'C003', 품목명: '감2', 규격: '4kg', 단위: 'EA' },
    ],
  });
  const duplicateResult = await harness.adapter.registerMerchOpsProducts(duplicateCodeBatch);
  assert.equal(duplicateResult.status, 'REJECTED');
  assert.equal(duplicateResult.error.code, 'DUPLICATE_REGISTRATION_PRODUCT_CODE');
  assert.deepEqual(harness.products(), before, 'invalid registration batch must not partially write products');

  const existingCodeBatch = await registrationCommandFor(harness, {
    operationId: 'register-existing-batch',
    products: [
      { 코드: 'C003', 품목명: '감', 규격: '3kg', 단위: 'BOX' },
      { 코드: 'A001', 품목명: '중복 사과', 규격: '1kg', 단위: 'BOX' },
    ],
  });
  const existingResult = await harness.adapter.registerMerchOpsProducts(existingCodeBatch);
  assert.equal(existingResult.status, 'CONFLICT');
  assert.equal(existingResult.error.code, 'REGISTRATION_PRODUCT_ALREADY_EXISTS');
  assert.equal(harness.products().C003, undefined, 'existing-code conflict must reject the complete selected batch');

  const operationalField = await registrationCommandFor(harness, {
    operationId: 'register-operational-field',
    products: [{ 코드: 'C004', 품목명: '감', 규격: '3kg', 단위: 'BOX', 수량: 7 }],
  });
  const operationalResult = await harness.adapter.registerMerchOpsProducts(operationalField);
  assert.equal(operationalResult.status, 'REJECTED');
  assert.equal(operationalResult.error.code, 'REGISTRATION_FIELD_NOT_ALLOWED');
  assert.equal(MERCHOPS_PRODUCT_REGISTRATION_FIELDS.includes('수량'), false);
  assert.equal(MERCHOPS_PRODUCT_REGISTRATION_FIELDS.includes('기준일자'), false);
}

{
  const harness = createHarness();
  const staleCommand = await registrationCommandFor(harness, { operationId: 'register-stale' });
  staleCommand.expectedRevision = 'rev-stale';
  const stale = await harness.adapter.registerMerchOpsProducts(staleCommand);
  assert.equal(stale.status, 'CONFLICT');
  assert.equal(stale.error.code, 'PRODUCT_SNAPSHOT_CONFLICT');
  assert.equal(harness.products().C003, undefined);
}

{
  const harness = createHarness({ failHistory: true });
  const result = await harness.adapter.registerMerchOpsProducts(await registrationCommandFor(harness, { operationId: 'register-history-fail' }));
  assert.equal(result.ok, false);
  assert.equal(result.rollback.master, true, 'registration history failure must roll back master');
  assert.equal(result.rollback.history, true);
  assert.equal(harness.products().C003, undefined);
  assert.deepEqual(harness.history(), []);
}

{
  const harness = createHarness({ failFinalVerify: true });
  const result = await harness.adapter.registerMerchOpsProducts(await registrationCommandFor(harness, { operationId: 'register-final-fail' }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FINAL_PRODUCT_REGISTRATION_VERIFY_FAILED');
  assert.equal(result.rollback.master, true);
  assert.equal(result.rollback.history, true);
  assert.equal(harness.products().C003, undefined);
  assert.deepEqual(harness.history(), []);
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
const ownerReadOnlyKeys = [
  'oneapp_cloud_sync_url_v1', 'merchMarginRules_v878', 'merchMappings_v870', 'merchMasterLinks_v870',
  'merchTableViewPresets_v1', 'merchActiveTableTarget_v1', 'merchActiveTableViewId_v1',
  'merchTableTemplateManualOverride_v870', 'merchActiveTableTemplateKey_v870', 'merchTableShortcuts_v870',
  'merchVisUpload_v870', 'merchVisMaster_v870', 'merchUploadColumnMeta_v870', 'merchSharedColumnWidths_v1',
  'parserDict_v870', 'merchCloudUrl_v870', 'parserCatalogWarehouseMap_v1',
  'merchStoppedProducts_v2', 'pendingShopStatus', 'merchProductStatusRecords_v1',
];
for (const key of ownerReadOnlyKeys) {
  assert.doesNotMatch(
    html,
    new RegExp('(?:global\\.|window\\.)?localStorage\\.(?:setItem|removeItem)\\([\'\"]' + key + '[\'\"]'),
    key + ' must remain read-only across the complete MerchOps file',
  );
}
assert.doesNotMatch(html, /localStorage\.(?:setItem|removeItem)\((?:ONEAPP_CLOUD_URL_KEY|window\.ONEAPP_CLOUD_URL_KEY|window\.MERCH_LEGACY_CLOUD_URL_KEY)/);
assert.doesNotMatch(html, /localStorage\.(?:setItem|removeItem)\(window\.(?:MERCH_PRODUCT_STATUS_KEY|MERCH_SHARED_COLUMN_WIDTHS_KEY)/);
assert.doesNotMatch(html, /(?:setIDB|STORAGE\.setIDB)\(['"](?:pending_shop_status|merchStoppedProducts_v2)['"]/);
assert.doesNotMatch(html, /Object\.entries\(settingsKeys\)[\s\S]{0,600}localStorage\.setItem/);
assert.doesNotMatch(html, /configKeyMap[\s\S]{0,1200}localStorage\.setItem/);

const sliceBetween = (start, end) => {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, 'missing section: ' + start);
  return html.slice(startIndex, endIndex);
};
const cloudUrlWriter = sliceBetween('CLOUD.setCloudSyncUrl =', 'CLOUD.buildMasterOnlyUrl');
assert.match(cloudUrlWriter, /OWNER_ROUTED|createMerchOpsOwnerRoute/);
assert.doesNotMatch(cloudUrlWriter, /setItem|removeItem/);
const cloudMasterImport = sliceBetween('CLOUD.pullMerchMasterForDataOps =', 'CLOUD.getCachedMerchMasterForDataOps');
assert.match(cloudMasterImport, /createMerchOpsOwnerRoute/);
assert.doesNotMatch(cloudMasterImport, /commitMasterState|setItem|setIDB/);
const cloudRestore = sliceBetween('CLOUD.restoreCloudData =', 'CLOUD.pullCloudBackup =');
assert.match(cloudRestore, /createMerchOpsOwnerRoute/);
assert.doesNotMatch(cloudRestore, /commitMasterState|setItem|setIDB|HISTORY_KEY/);
const cloudPull = sliceBetween('CLOUD.pullCloudBackup =', 'MASTER EXCEL UPLOAD ENGINE');
assert.match(cloudPull, /createMerchOpsOwnerRoute/);
assert.doesNotMatch(cloudPull, /fetchJson|restoreCloudData|setItem|commitMasterState/);
const masterRestore = sliceBetween('MASTER.restoreMasterBackup =', '// Info workgroup helper aliases.');
assert.match(masterRestore, /product-master-backup-restore/);
assert.match(masterRestore, /product-master-excel-apply/);
assert.doesNotMatch(masterRestore, /commitMasterState|setItem|restoreLocalValue/);
const startupCloudCompatibility = sliceBetween('window.setOneAppCloudSyncUrl =', 'window.appendOneAppCloudAction =');
assert.match(startupCloudCompatibility, /cloud-url-write/);
assert.doesNotMatch(startupCloudCompatibility, /setItem|removeItem/);
assert.match(html, /Startup compatibility is read-only/);
const stopWriterCompatibility = sliceBetween('window.saveMerchProductStatusRecords =', 'window.resolveMerchStatusRecordFields =');
assert.match(stopWriterCompatibility, /smart-parser/);
assert.match(stopWriterCompatibility, /stop-management-write/);
assert.doesNotMatch(stopWriterCompatibility, /setItem|setIDB/);
const sharedWidthWriterCompatibility = sliceBetween('window.saveMerchSharedColumnWidths =', 'window.getMerchColumnWidthValue =');
assert.match(sharedWidthWriterCompatibility, /shared-table-view-write/);
assert.match(sharedWidthWriterCompatibility, /shared-table-view-reset/);
assert.doesNotMatch(sharedWidthWriterCompatibility, /setItem|removeItem/);
const historyAppender = sliceBetween('window.persistMerchHistoryLogs =', 'window.getAllIDB =');
assert.match(historyAppender, /localStorage\.setItem\('merchHistory_v870'/);
assert.doesNotMatch(html.replace(historyAppender, ''), /localStorage\.setItem\('merchHistory_v870'/);

const boundarySource = sliceBetween('const installMerchOpsOwnerBoundary =', 'const getMerchOpsOwnerAdapters =');
let legacyWrites = 0;
const legacyWriter = () => { legacyWrites += 1; return { ok: true }; };
const route = (ownerAppId, action, ownerPath) => Object.freeze({ ok: false, status: 'OWNER_ROUTED', ownerAppId, action, ownerPath });
const boundaryWindow = {
  createMerchOpsOwnerRoute: route,
  getOneAppCloudSyncUrl: () => 'https://example.invalid/read-only',
  ONEAPP_DEFAULT_CLOUD_SYNC_URL: 'https://example.invalid/default',
  ONEAPP_MERCHOPS_ADAPTERS_READY: Promise.resolve({ ok: true }),
  ONEAPP: {
    STORAGE: { commitMasterState: legacyWriter, commitMasterStateOrThrow: legacyWriter, replaceMasterState: legacyWriter },
    CLOUD: {
      getCloudSyncUrl: () => 'https://example.invalid/read-only',
      setCloudSyncUrl: legacyWriter, ensureDefaultCloudSyncUrl: legacyWriter,
      pullMerchMasterForDataOps: legacyWriter, pushCloudBackup: legacyWriter,
      restoreCloudData: legacyWriter, pullCloudBackup: legacyWriter,
      pushConfigBackup: legacyWriter, chunkUpload: legacyWriter,
    },
    CONFIG: { writeParserCatalogWarehouseMap: legacyWriter, setParserCatalogWarehouse: legacyWriter },
    MASTER: { createMasterBackup: legacyWriter, restoreMasterBackup: legacyWriter, applyMasterExcelUpload: legacyWriter },
  },
};
vm.runInNewContext(boundarySource, { window: boundaryWindow, Promise, Object });
await boundaryWindow.ONEAPP_MERCHOPS_ADAPTERS_READY;
await new Promise(resolve => setTimeout(resolve, 0));
for (const [call, ownerAppId] of [
  [() => boundaryWindow.setOneAppCloudSyncUrl('https://write.invalid'), 'settings'],
  [() => boundaryWindow.pullCloudBackup({}), 'settings'],
  [() => boundaryWindow.pushCloudBackup({}), 'settings'],
  [() => boundaryWindow.ONEAPP.CLOUD.restoreCloudData({}), 'settings'],
  [() => boundaryWindow.applyMasterExcelUpload({}), 'master-lookup'],
  [() => boundaryWindow.restoreMasterBackup('backup'), 'master-lookup'],
  [() => boundaryWindow.ONEAPP.STORAGE.commitMasterState({}), 'master-lookup'],
  [() => boundaryWindow.commitMerchMasterState({}), 'master-lookup'],
  [() => boundaryWindow.writeParserCatalogWarehouseMap({}), 'settings'],
]) {
  const result = await call();
  assert.equal(result.status, 'OWNER_ROUTED');
  assert.equal(result.ownerAppId, ownerAppId);
}
assert.equal(boundaryWindow.ensureOneAppCloudSyncUrl(), 'https://example.invalid/read-only');
assert.equal(legacyWrites, 0, 'legacy global writers must be replaced before they can mutate owner data');
assert.match(business, /data\.commitReviewedWork\(newMaster, localLogs/);
assert.match(business, /data\.commitReviewedWork\(nextMaster, history/);
assert.match(business, /status: 'OWNER_ROUTED', ownerAppId: 'settings'/);
assert.match(business, /status: 'OWNER_ROUTED', ownerAppId: 'master-lookup'/);
assert.match(business, /data\.registerProducts\(products/);
assert.match(business, /schemaVersion: 'MERCHOPS_PRODUCT_REGISTRATION_V1'/);
assert.doesNotMatch(business, /productChangeRequest|ONEAPP_REFERENCE_CHANGE_REQUEST_V1/);
assert.match(html, /data-merch-registration-apply[^\n]+owner-command[\s\S]*?"선택 상품 등록"/);
assert.match(html, /작업표 유지: 수량·기준일자/);
assert.match(html, /MERCHOPS_WORK_VIEW_STATE_KEY = 'merchops_work_view_state_v1'/);

const f8 = business.slice(business.indexOf('const handleQuickExcelExport ='), business.indexOf('const handleCommitEstimate ='));
assert.doesNotMatch(f8, /commitReviewedWork|setMasterProducts|commitMerchMasterState/);
const f9 = business.slice(business.indexOf('const handleOpenExportCenter ='), business.indexOf('const handleRegisterUnregisteredItems ='));
assert.match(f9, /ONEAPP\.EXPORT\.buildWorkingPayload/);
assert.doesNotMatch(f9, /commitReviewedWork|setMasterProducts|commitMerchMasterState/);

console.log('MerchOps complete-file owner-boundary, reviewed-command, rollback, settings-read, F8/F9 contracts passed.');
