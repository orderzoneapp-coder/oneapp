#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(join(ROOT, name), 'utf8');
const [smart, analysis, catalogApplyAdapter, stopAdapter, manifestText] = await Promise.all([
  read('SmartParser.html'),
  read('smartparser/analysis-result-contract.js'),
  read('smartparser/catalog-apply-command-adapter.js'),
  read('smartparser/stop-management-command-adapter.js'),
  read('app-manifest.json'),
]);
const manifest = JSON.parse(manifestText);

for (const forbidden of [
  /commitSmartParserMaster/,
  /buildSmartParserApplyPlan/,
  /\bmaster_products\b/,
  /\bmerchMaster_v870\b/,
  /\bmerchMaster_revision_v870\b/,
  /ONEAPP\.STORAGE\.commitMasterStateOrThrow/,
  /localStorage\.(?:setItem|removeItem)\(['"]merchHistory_v870/,
  /localStorage\.(?:setItem|removeItem)\(['"]merchMaster_sync_trigger/,
]) assert.doesNotMatch(smart, forbidden, `SmartParser page must not retain raw product/history writer: ${forbidden}`);

assert.match(smart, /getProductSnapshotResult\(\)/);
assert.match(smart, /ONEAPP_PRODUCT_SNAPSHOT_V1/);
assert.match(smart, /ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1/);
assert.match(smart, /createSmartParserCatalogApplyCommand/);
assert.match(smart, /commitSmartParserCatalogApply\(command\)/);
assert.match(smart, /new Set\(command\.items\.map\(item => String\(item\.rowId\)\)\)/);
assert.match(smart, /document\.addEventListener\('keydown', handleReviewShortcut, true\)/);
assert.match(smart, /onConfirm\(updateText\)/);
assert.doesNotMatch(smart, /submitProductChangeRequest|PENDING 변경요청/);
assert.match(smart, /Promise\.allSettled/);
assert.match(smart, /PRODUCT_READ_ADAPTER_NOT_AVAILABLE/);
assert.match(smart, /setProductSnapshotStale\(true\)/);
assert.match(smart, /indexedDB\.open\('MerchOpsDB'\)/);
assert.doesNotMatch(smart, /indexedDB\.open\('MerchOpsDB',\s*\d/);
assert.doesNotMatch(smart, /createObjectStore\(['"]master_products/);
assert.match(smart, /schemaVersion:\s*'smartparser-session\/v2'/);
assert.match(smart, /parserDict_v870/);
assert.match(smart, /smartParserExcludeDict_v3012/);
assert.match(smart, /parserCatalogWarehouseMap_v1/);

assert.doesNotMatch(analysis, /indexedDB|localStorage|submitProductChangeRequest|commitMasterState/);
assert.match(analysis, /deepFreeze/);
assert.match(catalogApplyAdapter, /commitMasterStateOrThrow/);
assert.match(catalogApplyAdapter, /EXCLUDE_CATALOG/);
assert.match(catalogApplyAdapter, /SMARTPARSER_CATALOG_STOP_REASONS/);
assert.match(catalogApplyAdapter, /afterVerified/);
assert.match(catalogApplyAdapter, /CATALOG_REMOVAL_SCOPE_INVALID/);
assert.match(stopAdapter, /commitMasterStateOrThrow/);
assert.match(stopAdapter, /expectedSnapshotId/);
assert.match(stopAdapter, /PRODUCT_SNAPSHOT_CONFLICT/);
assert.match(stopAdapter, /afterVerified/);

const product = manifest.sharedDataContracts.find((entry) => entry.id === 'product-master');
const request = manifest.sharedDataContracts.find((entry) => entry.id === 'product-reference-change-request');
const result = manifest.sharedDataContracts.find((entry) => entry.id === 'smartparser-analysis-result');
const catalogApply = manifest.sharedDataContracts.find((entry) => entry.id === 'smartparser-catalog-apply');
const stop = manifest.sharedDataContracts.find((entry) => entry.id === 'stop-management');
const app = manifest.applications.find((entry) => entry.id === 'smart-parser');
assert.equal(product.legacyWriterAllowlist.includes('SmartParser.html'), false);
assert.equal(product.catalogApplyCommandException.asset, 'smartparser/catalog-apply-command-adapter.js');
assert.deepEqual(product.catalogApplyCommandException.allowedStopReasons, ['품절', '공급중단', '판매종료']);
assert.equal(product.stopCommandException.asset, 'smartparser/stop-management-command-adapter.js');
assert.equal(request.consumers.includes('smart-parser'), false);
assert.equal(result.owner, 'smart-parser');
assert.equal(result.schemaVersion, 'ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1');
assert.equal(result.resources.contractAsset, 'smartparser/analysis-result-contract.js');
assert.equal(catalogApply.owner, 'master-lookup');
assert.equal(catalogApply.resources.adapterAsset, 'smartparser/catalog-apply-command-adapter.js');
assert.equal(catalogApply.adapterVersion, 'ONEAPP_SMARTPARSER_CATALOG_APPLY_COMMAND_ADAPTER_V1');
assert.equal(stop.resources.adapterAsset, 'smartparser/stop-management-command-adapter.js');
assert.equal(stop.adapterVersion, 'ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER_V1');
assert.ok(app.sharedContracts.includes('smartparser-analysis-result'));
assert.ok(app.sharedContracts.includes('smartparser-catalog-apply'));
assert.equal(app.sharedContracts.includes('product-reference-change-request'), false);

assert.match(smart, /판매정지 함께 적용/);
assert.match(smart, /"품절"[\s\S]*"공급중단"[\s\S]*"판매종료"/);
assert.match(smart, /data-parser-link-scroll/);
assert.match(smart, /현재 탭·검색조건을 유지합니다/);
assert.doesNotMatch(smart, /setParserBuffer\(nextRows\);[\s\S]{0,240}setActiveTab\('matched'\)/);
assert.doesNotMatch(smart, /setParserBuffer\(nextRows\);[\s\S]{0,240}setGlobalSearch\(''\)/);
assert.match(smart, /if \(completed\) onClose\(\)/);

console.log('PASS test-smartparser-owner-boundaries');
