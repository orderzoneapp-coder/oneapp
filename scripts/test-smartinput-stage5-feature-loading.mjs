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
} from '../smartinput/estimate-output.js';

const appSource = fs.readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const themeSource = fs.readFileSync(new URL('../nexus/common/nexus-ui-theme-init.js', import.meta.url), 'utf8');
const staticImports = [...appSource.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"];$/gm)].map(match => match[1]);
const deferredModules = [
  'estimate-output.js',
  'purchase-sales-output.js',
  'ocr-document-parser.js',
  'purchase-finalize-service.js',
  'sale-finalize-service.js',
  'stocktake-conflict-dialog.js',
  'xlsx-source-reader.js',
  'estimate-migration.js'
];

for (const moduleName of deferredModules) {
  assert.equal(staticImports.some(specifier => specifier.includes(moduleName)), false,
    `${moduleName} must stay outside the initial SmartInput module graph`);
}
for (const featureName of ['fileIntake', 'ocr', 'estimateReport', 'voucherOutput', 'officialVoucher']) {
  assert.match(appSource, new RegExp(`loadOptionalFeature\\('${featureName}'`), `${featureName} must load at its action boundary`);
}
assert.match(appSource, /Promise\.all\(\[\s*ensureXlsx\(operationToken\),\s*loadOptionalFeature\('fileIntake'/,
  'file intake must prepare the XLSX runtime and internal feature from the same click');
assert.match(appSource, /Promise\.all\(\[\s*ensureTesseract\(operationToken\),\s*loadOptionalFeature\('ocr'/,
  'OCR must prepare Tesseract and the parser from the same click');
assert.match(themeSource, /source-preparation-ui-v2\.js\?v=0\.1\.1/,
  'the current source preparation UI must remain the delayed default asset');
assert.match(themeSource, /setTimeout\([\s\S]*1200\)/,
  'the source preparation UI delay must be preserved');

const rows = [
  { rowId: 'R1', masterProductId: 'M1', itemCode: 'A', noticePrice: '1,200' },
  { rowId: 'R2', itemCode: 'B', noticePrice: '' }
];
assert.deepEqual(buildCoreSnapshot(rows), buildReportSnapshot(rows));
assert.equal(coreSnapshotsEqual(buildCoreSnapshot(rows), buildCoreSnapshot(rows)), true);
assert.equal(reportSnapshotsEqual(buildReportSnapshot(rows), buildReportSnapshot(rows)), true);

const [fileFeature, ocrFeature, reportFeature, voucherFeature, officialFeature] = await Promise.all([
  import('../smartinput/file-intake-feature.js'),
  import('../smartinput/ocr-feature.js'),
  import('../smartinput/estimate-report-feature.js'),
  import('../smartinput/voucher-output-feature.js'),
  import('../smartinput/official-voucher-feature.js')
]);
assert.equal(typeof fileFeature.readWorksheetSource, 'function');
assert.equal(typeof ocrFeature.recognizeOcrDocument, 'function');
assert.equal(typeof reportFeature.buildEstimateF8Data, 'function');
assert.equal(typeof reportFeature.runStage5Compute, 'function');
assert.equal(typeof voucherFeature.buildPurchaseSalesUploadData, 'function');
assert.equal(typeof officialFeature.PurchaseFinalizeService.finalize, 'function');
assert.equal(typeof officialFeature.SaleFinalizeService.finalize, 'function');

console.log('SmartInput Stage5 optional feature boundaries and facade exports passed.');
