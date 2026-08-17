import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizedRowFingerprint, FINGERPRINT_VERSION } from '../orderq/history-collector/collector-contracts.js';

assert.equal(FINGERPRINT_VERSION, 2);

const base = {
  salesDate: '2026-08-17',
  documentNo: 'S-100',
  customerName: '거래처 A',
  productCode: 'P-1',
  productName: '대파',
  warehouseCode: '01',
  quantity: '2.0',
  unitPrice: '1,500',
  amount: 3000
};
assert.equal(
  normalizedRowFingerprint('SALES_HISTORY', base),
  normalizedRowFingerprint('SALES_HISTORY', { ...base, quantity: 2, unitPrice: 1500 }),
  'numeric formatting differences must normalize to one transaction identity'
);
assert.notEqual(
  normalizedRowFingerprint('SALES_HISTORY', base),
  normalizedRowFingerprint('SALES_HISTORY', { ...base, quantity: 3 }),
  'business quantity changes must change the fingerprint'
);

const contractSource = await readFile(new URL('../orderq/history-collector/collector-contracts.js', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../orderq/collector-ui.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../orderq/collector.html', import.meta.url), 'utf8');
const photoOcrSource = await readFile(new URL('../orderq/photo-ocr.js', import.meta.url), 'utf8');

assert.doesNotMatch(
  contractSource.slice(contractSource.indexOf('export function normalizedRowFingerprint'), contractSource.indexOf('function queueRow')),
  /rowNo/,
  'row number must not participate in v2 transaction identity'
);
assert.match(contractSource, /fingerprintVersion:\s*FINGERPRINT_VERSION/);
assert.match(contractSource, /const result = await rollbackWithoutMatching\(importBatchId, rolledBackBy\)/);
assert.match(contractSource, /if \(!MATCHING_SOURCES\.has\(batch\.sourceType\)\) return result/);
assert.match(contractSource, /if \(!snapshot\.orderLines\.length \|\| !snapshot\.salesLines\.length\)/);
assert.match(contractSource, /invalidateMatchingDerived\('MATCHING_NOT_READY'\)/);
assert.match(contractSource, /status:'REVIEW_REQUIRED'/);
assert.match(uiSource, /commitPreparedImportV2/);
assert.match(uiSource, /rollbackImportBatchByContract/);
assert.match(uiSource, /sourceRecords\.filter\(r=>r\.sourceType===COLLECTOR_SOURCE\.CUSTOMER_LEDGER\)/);
assert.match(uiSource, /status!==['"]EXCLUDED['"]/);
assert.match(htmlSource, /data-work-tab="order"/);
assert.match(htmlSource, /data-work-tab="sales"/);
assert.match(htmlSource, /data-work-tab="purchase"/);
assert.match(htmlSource, /data-work-tab="inventory"/);
assert.match(htmlSource, /data-work-tab="ledger"/);
assert.match(htmlSource, /data-work-tab="matching"/);
assert.match(htmlSource, /data-work-tab="history"/);
assert.match(htmlSource, /tesseract\.js@6/);
assert.match(htmlSource, /photo-ocr\.js\?v=0\.8\.4/);
assert.match(htmlSource, /추가 즉시 OCR/);
assert.match(htmlSource, /Ctrl\+V/);
assert.match(photoOcrSource, /Tesseract\?\.recognize/);
assert.match(photoOcrSource, /'kor\+eng'/);
assert.match(photoOcrSource, /recognizeAdded\(startIndex, images\.length\)/);
assert.match(photoOcrSource, /사진 문자 자동 추출 중/);
assert.match(photoOcrSource, /addEventListener\('paste'/);
assert.match(photoOcrSource, /clipboardData\?\.items/);
assert.match(photoOcrSource, /new DataTransfer\(\)/);
assert.match(photoOcrSource, /input\.dispatchEvent\(new Event\('change'/);
assert.match(photoOcrSource, /dispatchEvent\(new Event\('input'/);

console.log('PASS: ORDER Q collector tabs, matching readiness, duplicate v2, rollback, photo auto OCR and clipboard paste contracts');
