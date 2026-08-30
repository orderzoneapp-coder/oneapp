#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n');
const smartSource = read('SmartParser.html');
const merchSource = read('MerchOps.html');
const manifest = JSON.parse(read('app-manifest.json'));

const scripts = [...smartSource.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).filter((source) => source.trim());
assert.ok(scripts.length > 0);
scripts.forEach((source, index) => new vm.Script(source, { filename: `SmartParser-inline-${index + 1}.js` }));

const start = smartSource.indexOf('const PARSER_PRICE_HISTORY_FIELDS =');
const end = smartSource.indexOf('const loadSmartParserBoundaryAdapters =', start);
assert.ok(start >= 0 && end > start, 'SmartParser duplicate/supplier helper range missing');
const values = new Map();
const localStorage = {
  getItem: (key) => values.get(String(key)) ?? null,
  setItem: (key, value) => values.set(String(key), String(value)),
  removeItem: (key) => values.delete(String(key)),
};
const context = vm.createContext({
  window: {}, localStorage, console, Date, Object, Array, String, Number, Boolean, Math, JSON, Set, Map, Error,
  parseNum: (value) => Number(String(value ?? '').replaceAll(',', '')) || 0,
  safeParseJson: (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
  getNowISO: () => '2026-08-30T00:00:00.000Z',
  normalizeText: (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase(),
  makeParserExcludeKey: (catalog, name, spec) => [catalog, name, spec].map((value) => String(value ?? '').replace(/\s+/g, '').toLowerCase()).join('|'),
  PARSER_EXCLUDE_MAX_KEEP: 1000,
});
vm.runInContext(`${smartSource.slice(start, end)}\nglobalThis.helpers={createSmartParserMasterCodeResolver,reconcileSmartParserDuplicateRows,getSmartParserDuplicateSummary,normalizeSmartParserStoppedProducts,mergeSmartParserStoppedProductsWithLegacy,hasSmartParserLegacyStoppedProducts,normalizeParserExcludeDict,getParserExcludeList};`, context);
const helpers = context.helpers;

const master = {
  '20404230': { 코드: '20404230', 품목명: '회귀상품', 판매여부: 1 },
  B: { 코드: 'B', 품목명: '다른상품', 판매여부: 1 },
};
const duplicated = helpers.reconcileSmartParserDuplicateRows([
  { _id: 'supplier-1', _matchCode: '20404230', _matchStatus: '🟢 일치', _apply: true },
  { _id: 'supplier-2', _matchCode: '20 404230', _matchStatus: '🟢 일치', _apply: true },
], master);
assert.ok(duplicated.every((row) => row._duplicateType === 'applied_code' && row._apply === false));
assert.deepEqual(JSON.parse(JSON.stringify(helpers.getSmartParserDuplicateSummary(duplicated).groups)), [{ code: '20404230', count: 2 }]);

const ambiguousMaster = {
  first: { 코드: '20404230', 품목명: '마스터 후보 1' },
  second: { 코드: '20 404230', 품목명: '마스터 후보 2' },
};
assert.throws(() => helpers.createSmartParserMasterCodeResolver(ambiguousMaster).resolve('20404230'), /상품코드 중복/);
const masterDuplicate = helpers.reconcileSmartParserDuplicateRows([
  { _id: 'master-dup', _matchCode: '20404230', _matchStatus: '🟢 일치', _apply: true },
], ambiguousMaster)[0];
assert.equal(masterDuplicate._duplicateType, 'master_code');
assert.equal(masterDuplicate._apply, false);

const legacyStopped = helpers.normalizeSmartParserStoppedProducts({
  ' 20404230 ': { pendingAction: 'pendingStop', status: 'legacy', memo: '보존' },
  B: { pendingAction: '재개예정', reason: '보존 사유' },
});
assert.equal(legacyStopped['20404230'].pendingAction, 'stop');
assert.equal(legacyStopped['20404230'].memo, '보존');
assert.equal(legacyStopped.B.pendingAction, 'resume');
values.set('merchWorkArchive_v1', JSON.stringify([{ status: '정지', createdAt: '2026-01-02T03:04:05.000Z', rows: [{ 코드: 'LEGACY' }] }]));
assert.equal(helpers.mergeSmartParserStoppedProductsWithLegacy({}).LEGACY.reason, '기존 정지 보관함 변환');
assert.equal(helpers.hasSmartParserLegacyStoppedProducts(), true);

const exclusions = helpers.normalizeParserExcludeDict({
  old: { catalog: ' 공급사 A ', name: ' 상품 ', spec: '1kg', unit: 'BOX', reason: '보존', createdAt: '2026-01-01T00:00:00.000Z' },
});
assert.equal(Object.keys(exclusions).length, 1);
assert.equal(helpers.getParserExcludeList(exclusions, '공급사 A')[0].reason, '보존');

assert.match(smartSource, /smartParserExcludeDict_v3012/);
assert.match(smartSource, /smartParserExcludeDict_backup_v3015/);
assert.match(smartSource, /parserDict_v870/);
assert.match(smartSource, /smartParserTempData/);
assert.match(smartSource, /SmartParserStopManager/);
assert.match(smartSource, /stop-management-command-adapter\.js/);
assert.match(smartSource, /commitSmartParserStopManagement\(command\)/);
assert.doesNotMatch(smartSource, /buildSmartParserStopManagementPlan|commitSmartParserMaster|buildSmartParserApplyPlan/);
assert.doesNotMatch(smartSource, /localStorage\.(?:setItem|removeItem)\(['"]merchWorkArchive_v1/);

assert.doesNotMatch(merchSource, /onClick:\s*handleStopSales/);
assert.doesNotMatch(merchSource, /localStorage\.setItem\('merchStoppedProducts_v2'/);
assert.match(merchSource, /SmartParser 전용 품절\/정지 관리/);

const stopContract = manifest.sharedDataContracts.find((contract) => contract.id === 'stop-management');
const exclusionContract = manifest.sharedDataContracts.find((contract) => contract.id === 'parser-supplier-exclusions');
assert.equal(stopContract.owner, 'smart-parser');
assert.equal(stopContract.resources.adapterAsset, 'smartparser/stop-management-command-adapter.js');
assert.equal(exclusionContract.owner, 'smart-parser');
assert.deepEqual(exclusionContract.resources.localStorage, ['smartParserExcludeDict_v3012', 'smartParserExcludeDict_backup_v3015']);

console.log('PASS test-smartparser-supplier-stop-20260804-01');
