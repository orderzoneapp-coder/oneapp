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

console.log('PASS: ORDER Q collector tab isolation, matching readiness, duplicate v2 and rollback contracts');
