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
assert.equal(normalizedRowFingerprint('SALES_HISTORY', base), normalizedRowFingerprint('SALES_HISTORY', { ...base, quantity: 2, unitPrice: 1500 }), 'numeric formatting differences must normalize to one transaction identity');
assert.notEqual(normalizedRowFingerprint('SALES_HISTORY', base), normalizedRowFingerprint('SALES_HISTORY', { ...base, quantity: 3 }), 'business quantity changes must change the fingerprint');

const contractSource = await readFile(new URL('../orderq/history-collector/collector-contracts.js', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../orderq/collector-ui.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../orderq/collector.html', import.meta.url), 'utf8');
const photoOcrSource = await readFile(new URL('../orderq/photo-ocr.js', import.meta.url), 'utf8');
const photoBulkSource = await readFile(new URL('../orderq/photo-bulk-actions.js', import.meta.url), 'utf8');
const parserReviewSource = await readFile(new URL('../orderq/collector-smartparser-review.js', import.meta.url), 'utf8');
const candidateSource = await readFile(new URL('../orderq/smartparser/candidate-generator.js', import.meta.url), 'utf8');

assert.doesNotMatch(contractSource.slice(contractSource.indexOf('export function normalizedRowFingerprint'), contractSource.indexOf('function queueRow')), /rowNo/, 'row number must not participate in v2 transaction identity');
assert.match(contractSource, /fingerprintVersion:\s*FINGERPRINT_VERSION/);
assert.match(contractSource, /rollbackWithoutMatching/);
assert.match(contractSource, /invalidateMatchingDerived\('MATCHING_NOT_READY'\)/);
assert.match(uiSource, /commitPreparedImportV2/);
assert.match(uiSource, /rollbackImportBatchByContract/);
assert.match(uiSource, /status!==['"]EXCLUDED['"]/);
for (const tab of ['order','sales','purchase','inventory','ledger','matching','history']) assert.match(htmlSource, new RegExp(`data-work-tab="${tab}"`));
assert.match(htmlSource, /tesseract\.js@6/);
assert.match(htmlSource, /photo-ocr\.js\?v=0\.8\.7/);
assert.match(htmlSource, /photo-bulk-actions\.js\?v=0\.8\.7/);
assert.match(htmlSource, /collector-smartparser-review\.css\?v=0\.8\.7/);
assert.match(htmlSource, />파서 실행</);
assert.match(htmlSource, /전체 비우기/);
assert.match(photoOcrSource, /Tesseract\?\.recognize/);
assert.match(photoOcrSource, /'kor\+eng'/);
assert.match(photoOcrSource, /input\.addEventListener\('change',[\s\S]*?\}, true\);/);
assert.match(photoBulkSource, /collector-smartparser-review\.js\?v=0\.8\.7/);
assert.match(photoBulkSource, /이 사진 비우기/);
assert.match(parserReviewSource, /1 원문/);
assert.match(parserReviewSource, /2 상품 매칭/);
assert.match(parserReviewSource, /3 주문 후보/);
assert.match(parserReviewSource, /4 수집/);
assert.match(parserReviewSource, /자동매칭은 그대로 통과/);
assert.match(parserReviewSource, /recordProductMapping/);
assert.match(parserReviewSource, /status!=='AUTO'/);
assert.match(parserReviewSource, /commitPreparedImportV2/);
assert.match(parserReviewSource, /rebuildWhenReady/);
assert.match(candidateSource, /CUSTOMER_MAPPING_FUZZY/);
assert.match(candidateSource, /SOURCE_MAPPING_FUZZY/);
assert.match(candidateSource, /COMMON_MAPPING_FUZZY/);
assert.match(candidateSource, /mapping\.useCount/);
assert.match(candidateSource, /product\.secondName/);
assert.match(candidateSource, /product\.alias/);

console.log('PASS: ORDER Q collector tabs, photo OCR, SmartParser four-step review, cumulative fuzzy mappings and final collection contracts');
