#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  buildChangeHistorySnapshot,
  getChangeHistorySnapshotResult,
  mergeChangeHistorySnapshots,
} from '../reference-data/change-history-read-adapter.js';
import {
  SETTINGS_OWNER_KEYS,
  SMARTPARSER_OPAQUE_RECOVERY_KEYS,
  buildSettingsRestorePlan,
  mergeSettingsCloudRoundTrip,
  restoreSettingsBundle,
} from '../reference-data/settings-config-owner-adapter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

class MemoryStorage {
  constructor(initial = {}, options = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
    this.options = options;
    this.getCalls = [];
    this.setCalls = [];
    this.removeCalls = [];
    this.setAttempt = 0;
    this.failedSet = false;
    this.corruptedReadDone = false;
  }

  getItem(key) {
    this.getCalls.push(key);
    if (this.options.throwOnGet === key) throw new Error('TEST_GET_FAILED');
    if (this.options.corruptReadAfterWrite === key
      && this.setCalls.some(([writtenKey]) => writtenKey === key)
      && !this.corruptedReadDone) {
      this.corruptedReadDone = true;
      return 'CORRUPTED_POST_WRITE_VALUE';
    }
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.setAttempt += 1;
    if (this.options.failSetAt === this.setAttempt && !this.failedSet) {
      this.failedSet = true;
      throw new Error('TEST_SET_FAILED');
    }
    const raw = String(value);
    this.values.set(key, raw);
    this.setCalls.push([key, raw]);
  }

  removeItem(key) {
    this.values.delete(key);
    this.removeCalls.push(key);
  }
}

function compileClassicInlineScripts(relativePath) {
  const html = read(relativePath);
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  scripts.forEach((source, index) => new vm.Script(source, { filename: `${relativePath}#${index}` }));
  return scripts.length;
}

function compileHistoryModule() {
  const html = read('history_viewer.html');
  const match = html.match(/<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, 'History Viewer module script must exist');
  const withoutImports = match[1]
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .replace(/import\s+[^;]+;/g, '');
  new vm.Script(withoutImports, { filename: 'history_viewer.html#module-without-imports' });
}

// Change History Snapshot adapter states, immutability, deterministic revision, and memory merge.
const historyInput = [{ id: 'H-1', timestamp: '2026-08-31T01:00:00.000Z', code: '1001', field: '입고가', oldVal: 10, newVal: 20 }];
const readyStorage = new MemoryStorage({ merchHistory_v870: JSON.stringify(historyInput) });
const ready = await getChangeHistorySnapshotResult({ storage: readyStorage, now: '2026-08-31T02:00:00.000Z' });
assert.equal(ready.status, 'READY');
assert.equal(ready.snapshot.count, 1);
assert.equal(readyStorage.setCalls.length, 0, 'History read must perform zero writes');
assert.ok(Object.isFrozen(ready.snapshot));
assert.ok(Object.isFrozen(ready.snapshot.data));
assert.ok(Object.isFrozen(ready.snapshot.data.history));
assert.ok(Object.isFrozen(ready.snapshot.data.history[0]));
historyInput[0].newVal = 999;
assert.equal(ready.snapshot.data.history[0].newVal, 20, 'Snapshot must be a clone');

const deterministicA = await buildChangeHistorySnapshot([{ code: 'A', value: 1 }], { now: '2026-08-31T00:00:00.000Z' });
const deterministicB = await buildChangeHistorySnapshot([{ code: 'A', value: 1 }], { now: '2027-01-01T00:00:00.000Z' });
assert.equal(deterministicA.revision, deterministicB.revision);
assert.equal(deterministicA.contentHash, deterministicB.contentHash);

const empty = await getChangeHistorySnapshotResult({ storage: new MemoryStorage({ merchHistory_v870: '[]' }) });
assert.equal(empty.status, 'EMPTY');
const notAvailable = await getChangeHistorySnapshotResult({ storage: new MemoryStorage() });
assert.equal(notAvailable.status, 'NOT_AVAILABLE');
const parseError = await getChangeHistorySnapshotResult({ storage: new MemoryStorage({ merchHistory_v870: '{broken' }) });
assert.equal(parseError.status, 'ERROR');
const readError = await getChangeHistorySnapshotResult({ storage: new MemoryStorage({}, { throwOnGet: 'merchHistory_v870' }) });
assert.equal(readError.status, 'ERROR');

const localSnapshot = await buildChangeHistorySnapshot([
  { id: 'DUP', timestamp: '2026-08-30T00:00:00.000Z' },
  { id: 'LOCAL', timestamp: '2026-08-29T00:00:00.000Z' },
], { source: 'LOCAL' });
const cloudSnapshot = await buildChangeHistorySnapshot([
  { id: 'DUP', timestamp: '2026-08-30T00:00:00.000Z' },
  { id: 'CLOUD', timestamp: '2026-08-31T00:00:00.000Z' },
], { source: 'CLOUD' });
const merged = await mergeChangeHistorySnapshots([localSnapshot, cloudSnapshot]);
assert.deepEqual(merged.data.history.map((row) => row.id), ['CLOUD', 'DUP', 'LOCAL']);

// Settings allowlist, validation, atomic rollback, post-verification, and external-field preservation.
assert.ok(SETTINGS_OWNER_KEYS.includes('merchMappings_v870'));
assert.deepEqual(SMARTPARSER_OPAQUE_RECOVERY_KEYS, ['parserDict_v870', 'parserCatalogWarehouseMap_v1']);
assert.throws(
  () => buildSettingsRestorePlan({ settingsKeys: { unauthorizedKey: 'x' } }, { source: 'json' }),
  (error) => error.code === 'SETTINGS_KEY_NOT_OWNED',
);

const settingsPayload = {
  settingsKeys: {
    merchMappings_v870: JSON.stringify({ estimate: { 품목명: '상품명' } }),
    merchTableShortcuts_v870: JSON.stringify([{ id: 'S-1' }]),
    parserDict_v870: JSON.stringify({ 공급사: { 상품: '1001' } }),
  },
};
const settingsStorage = new MemoryStorage({
  merchMappings_v870: JSON.stringify({ old: true }),
  merchTableShortcuts_v870: '[]',
  parserDict_v870: '{}',
  merchMaster_v870: 'MASTER_ORIGINAL',
  merchHistory_v870: 'HISTORY_ORIGINAL',
  merchProductStatusRecords_v1: 'STATUS_ORIGINAL',
  pendingShopStatus: 'PENDING_ORIGINAL',
});
const restored = restoreSettingsBundle(settingsPayload, { storage: settingsStorage, source: 'json' });
assert.equal(restored.verified, true);
assert.equal(settingsStorage.getItem('merchMaster_v870'), 'MASTER_ORIGINAL');
assert.equal(settingsStorage.getItem('merchHistory_v870'), 'HISTORY_ORIGINAL');
assert.equal(settingsStorage.getItem('merchProductStatusRecords_v1'), 'STATUS_ORIGINAL');
assert.equal(settingsStorage.getItem('pendingShopStatus'), 'PENDING_ORIGINAL');

const beforeFailure = {
  merchMappings_v870: JSON.stringify({ before: 1 }),
  merchTableShortcuts_v870: JSON.stringify([{ before: 2 }]),
  parserDict_v870: JSON.stringify({ before: 3 }),
};
const midFailureStorage = new MemoryStorage(beforeFailure, { failSetAt: 2 });
assert.throws(
  () => restoreSettingsBundle(settingsPayload, { storage: midFailureStorage, source: 'json' }),
  (error) => error.code === 'SETTINGS_RESTORE_ROLLED_BACK',
);
for (const [key, value] of Object.entries(beforeFailure)) assert.equal(midFailureStorage.getItem(key), value);

const postVerifyStorage = new MemoryStorage(beforeFailure, { corruptReadAfterWrite: 'merchMappings_v870' });
assert.throws(
  () => restoreSettingsBundle(settingsPayload, { storage: postVerifyStorage, source: 'json' }),
  (error) => error.code === 'SETTINGS_RESTORE_ROLLED_BACK',
);
for (const [key, value] of Object.entries(beforeFailure)) assert.equal(postVerifyStorage.getItem(key), value);

const existingCloud = {
  schemaVersion: 'LEGACY_CONFIG',
  externalTopLevel: { keep: true },
  pendingShopStatus: [{ code: 'P-1' }],
  appConfig: { externalFeature: { enabled: true }, mappings: { old: true } },
  settingsKeys: { externalOwnerKey: 'KEEP', merchMappings_v870: JSON.stringify({ old: true }) },
};
const ownedCloud = {
  schemaVersion: 'ONEAPP_SETTINGS_CONFIG_BUNDLE_V1',
  appConfig: { mappings: { next: true } },
  settingsKeys: { merchMappings_v870: JSON.stringify({ next: true }) },
};
const mergedCloud = mergeSettingsCloudRoundTrip(existingCloud, ownedCloud);
assert.deepEqual(mergedCloud.externalTopLevel, { keep: true });
assert.deepEqual(mergedCloud.pendingShopStatus, [{ code: 'P-1' }]);
assert.deepEqual(mergedCloud.appConfig.externalFeature, { enabled: true });
assert.equal(mergedCloud.settingsKeys.externalOwnerKey, 'KEEP');
assert.throws(
  () => mergeSettingsCloudRoundTrip({ appConfig: 'broken' }, ownedCloud),
  (error) => error.code === 'SETTINGS_CLOUD_EXISTING_APP_CONFIG_INVALID',
);

// Page source boundaries and syntax.
assert.equal(compileClassicInlineScripts('settings.html'), 1);
assert.equal(compileClassicInlineScripts('export_center.html'), 1);
compileHistoryModule();

const historySource = read('history_viewer.html');
assert.match(historySource, /change-history-read-adapter\.js/);
assert.match(historySource, /MEMORY_LOCAL_CLOUD_VIEW/);
assert.match(historySource, /filteredRows\.map\(row=>row\.raw\)/);
assert.doesNotMatch(historySource, /localStorage\.setItem\s*\(\s*['"]merchHistory_v870/);
assert.doesNotMatch(historySource, /localStorage\.removeItem\s*\(\s*['"]merchHistory_v870/);

const settingsSource = read('settings.html');
assert.match(settingsSource, /settings-config-owner-adapter\.js/);
assert.match(settingsSource, /Master\.html/);
assert.match(settingsSource, /SmartParser\.html/);
assert.match(settingsSource, /데이터 소유 앱에서 관리/);
assert.doesNotMatch(settingsSource, /\.commitMasterStateOrThrow\s*\(/);
assert.doesNotMatch(settingsSource, /merchProductStatusRecords_v1/);
assert.doesNotMatch(settingsSource, /pendingShopStatus/);
assert.doesNotMatch(settingsSource, /merchHistory_v870/);
assert.doesNotMatch(settingsSource, /createObjectStore\s*\(/);
assert.doesNotMatch(settingsSource, /제외\/정지 관리/);

const exportSource = read('export_center.html');
assert.doesNotMatch(exportSource, /<script\s+src="coreEngine\.js"/);
assert.doesNotMatch(exportSource, /commitMasterState/);
assert.doesNotMatch(exportSource, /merchMaster_sync_trigger/);
assert.doesNotMatch(exportSource, /merchHistory_v870/);
assert.doesNotMatch(exportSource, /createObjectStore\s*\(/);
assert.doesNotMatch(exportSource, /indexedDB\.open\s*\(\s*['"]MerchOpsDB['"]\s*,/);
assert.doesNotMatch(exportSource, /handleExportExcelWithoutMaster/);
assert.match(exportSource, /onClick: handleExportExcel/);
assert.match(exportSource, /if \(e\.key === 'F9'\)[\s\S]*?handleExportExcel\(\)/);
assert.match(exportSource, /상품 Snapshot 버전 차이/);
assert.match(exportSource, /상품 마스터·변경이력·revision을 수정하지 않습니다/);
assert.match(exportSource, /writeExportTempValue\('ONEAPP_IMAGE_DATA_TEMP'/);
const loadDataSource = exportSource.slice(exportSource.indexOf('const loadData = async () =>'), exportSource.indexOf('// [E-FLOW-02]'));
assert.ok(loadDataSource.indexOf("readExportStoreValue('merch_export_draft')") < loadDataSource.indexOf('getProductReadAdapter()'));

const merchOpsSource = read('MerchOps.html');
assert.match(merchOpsSource, /await window\.setIDB\('merch_export_draft', exportDraft\)/);
assert.match(merchOpsSource, /ONEAPP_MERCH_EXPORT_DRAFT_META_V1/);
assert.match(merchOpsSource, /productSnapshotVersion: String\(data\.productSnapshotRevision/);

// Manifest and architecture must describe the same owner/writer boundaries.
const manifest = JSON.parse(read('app-manifest.json'));
const app = (id) => manifest.applications.find((item) => item.id === id);
const contract = (id) => manifest.sharedDataContracts.find((item) => item.id === id);
assert.equal(manifest.schemaVersion, '1.3.7');
assert.equal(contract('change-history').owner, 'master-lookup');
assert.equal(contract('change-history').readAdapter, 'ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1');
assert.ok(!app('merchops').ownedContracts.includes('change-history'));
assert.ok(app('merchops').consumedContracts.includes('change-history'));
assert.ok(app('master-lookup').ownedContracts.includes('change-history'));
assert.ok(!contract('product-master').legacyWriterAllowlist.includes('settings.html'));
assert.ok(!contract('product-master').legacyWriterAllowlist.includes('export_center.html'));
assert.ok(app('settings').ownedContracts.includes('settings-config'));
assert.ok(app('export-center').consumedContracts.includes('merch-export-draft'));
assert.match(app('export-center').purpose, /without changing product master/);
assert.equal(contract('settings-config').ownerAdapter, 'ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1');
assert.equal(contract('merch-export-draft').resources.metaSchemaVersion, 'ONEAPP_MERCH_EXPORT_DRAFT_META_V1');

const architecture = read('APP_ARCHITECTURE.md');
assert.match(architecture, /ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1/);
assert.match(architecture, /ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1/);
assert.match(architecture, /F9와 화면 버튼 모두 output-only/);
assert.match(architecture, /`settings\.html`, `export_center\.html`을 제거/);

console.log('History · Settings · Export owner-boundary contracts passed.');
