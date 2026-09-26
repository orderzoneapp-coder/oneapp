#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildCatalogPriceSnapshot as buildCoreSnapshot,
  priceSnapshotsEqual as coreSnapshotsEqual
} from '../smartinput/estimate-price-snapshot.js';
import {
  buildCatalogPriceSnapshot as buildReportSnapshot,
  priceSnapshotsEqual as reportSnapshotsEqual
} from '../smartinput/report.js';

const appSource = fs.readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const themeSource = fs.readFileSync(new URL('../nexus/common/nexus-ui-theme-init.js', import.meta.url), 'utf8');
const smartInputHtml = fs.readFileSync(new URL('../smartinput/index.html', import.meta.url), 'utf8');
const staticImports = [...appSource.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"];$/gm)].map(match => match[1]);
const deferredModules = [
  'report.js',
  'report.js',
  'ocr-document-parser.js',
  'official-voucher-feature.js',
  'official-voucher-feature.js',
  'official-voucher-feature.js',
  'xlsx-source-reader.js',
  'estimate-migration.js',
  'estimate-bulk-update.js'
];

for (const moduleName of deferredModules) {
  assert.equal(staticImports.some(specifier => specifier.includes(moduleName)), false,
    `${moduleName} must stay outside the initial SmartInput module graph`);
}
for (const featureName of ['fileIntake', 'ocr', 'estimateReport', 'voucherOutput', 'officialVoucher', 'estimateBulk']) {
  assert.match(appSource, new RegExp(`loadOptionalFeature\\('${featureName}'`), `${featureName} must load at its action boundary`);
}
assert.match(appSource, /runCancelableStage5Compute\(reportFeature\.runStage5Compute/,
  'estimate report Worker calls must be connected to the active cancellation boundary');
assert.match(appSource, /runCancelableStage5Compute\(voucherOutputFeature\.runStage5Compute/,
  'purchase/sales report Worker calls must be connected to the active cancellation boundary');
assert.match(appSource, /Promise\.all\(\[\s*ensureXlsx\(operationToken\),\s*loadOptionalFeature\('fileIntake'/,
  'file intake must prepare the XLSX runtime and internal feature from the same click');
assert.match(appSource, /Promise\.all\(\[\s*ensureTesseract\(operationToken\),\s*loadOptionalFeature\('ocr'/,
  'OCR must prepare Tesseract and the parser from the same click');
assert.doesNotMatch(themeSource, /source-preparation-ui-v2\.js/,
  'the common theme initializer must not load a SmartInput-only feature');
assert.match(smartInputHtml, /<script defer src="\.\/source-preparation-ui-v2\.js\?v=[A-Za-z0-9._-]+"/,
  'SmartInput must load its source preparation UI directly without a fixed delay');

const rows = [
  { rowId: 'R1', masterProductId: 'M1', itemCode: 'A', noticePrice: '1,200' },
  { rowId: 'R2', itemCode: 'B', noticePrice: '' }
];
assert.deepEqual(buildCoreSnapshot(rows), buildReportSnapshot(rows));
assert.equal(coreSnapshotsEqual(buildCoreSnapshot(rows), buildCoreSnapshot(rows)), true);
assert.equal(reportSnapshotsEqual(buildReportSnapshot(rows), buildReportSnapshot(rows)), true);

const [fileFeature, ocrFeature, reportFeature, voucherFeature, officialFeature, estimateBulkFeature] = await Promise.all([
  import('../smartinput/xlsx-source-reader.js'),
  import('../smartinput/ocr-document-parser.js'),
  import('../smartinput/report.js'),
  import('../smartinput/report.js'),
  import('../smartinput/official-voucher-feature.js'),
  import('../smartinput/estimate-bulk-update.js')
]);
assert.equal(typeof fileFeature.readWorksheetSource, 'function');
assert.equal(typeof ocrFeature.recognizeOcrDocument, 'function');
assert.equal(typeof reportFeature.buildEstimateF8Data, 'function');
assert.equal(typeof reportFeature.runStage5Compute, 'function');
assert.equal(typeof voucherFeature.buildPurchaseSalesUploadData, 'function');
assert.equal(typeof officialFeature.PurchaseFinalizeService.finalize, 'function');
assert.equal(typeof officialFeature.SaleFinalizeService.finalize, 'function');
assert.equal(typeof estimateBulkFeature.classifyEstimateBulkRows, 'function');

console.log('SmartInput Stage5 optional feature boundaries and implementation exports passed.');
