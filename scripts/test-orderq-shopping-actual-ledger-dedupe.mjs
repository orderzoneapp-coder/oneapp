#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  SHOPPING_ORDER_DEDUPE_SCHEMA,
  SHOPPING_ORDER_HEADERS,
  buildShoppingOrderCandidates,
  canonicalShoppingOrderBasis,
  canonicalShoppingOrderSignature,
  planShoppingOrderDuplicates,
  validateShoppingOrderHeaders
} from '../orderq/shopping-order-dedupe-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const XLSX = require(path.join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'));
const readSource = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const sourceRow = ({
  date = '2026-09-04', customer = '거래처A', group = '', status = '주문', code = '000101', name = '상품A',
  specification = 'BOX', quantity = 1, unitPrice = 1000, amount = Number(quantity) * Number(unitPrice),
  sourceBoundaryKey = '', sourceRowNumber = 2
} = {}) => ({
  sourceCells: [
    date, customer, group, status, '전하실 말씀 원본', '상점 메모 원본', code, name, specification,
    quantity, unitPrice, amount, code, '원본 주소', '010-0000-0000', code.slice(0, 6), '원본 유통그룹'
  ],
  sourceBoundaryKey,
  sourceRowNumber
});

const build = (rows, options = {}) => buildShoppingOrderCandidates(rows, {
  headers: SHOPPING_ORDER_HEADERS,
  companyId: 'ONEAPP',
  warehouseId: 'WH-01',
  warehouseCode: '01',
  warehouseName: '본사창고',
  resolveCustomer: raw => ({ customerId: `CUS:${String(raw['거래처명']).trim()}`, customerName: raw['거래처명'] }),
  resolveProduct: raw => ({
    productId: `PRODUCT:${String(raw['상품코드']).trim()}`,
    itemCode: String(raw['상품코드']).trim(),
    itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격']
  }),
  fileName: 'source.xls',
  sheetName: 'Worksheet',
  uploadedAt: '2026-09-04T08:00:00+09:00',
  ...options
});

function cloneCandidate(candidate, candidateId) {
  return JSON.parse(JSON.stringify({ ...candidate, candidateId }));
}

function bundle(candidate, orderId, overrides = {}) {
  return {
    order: {
      orderId,
      companyId: candidate.companyId,
      customerId: candidate.customerId,
      customerName: candidate.customerName,
      deliveryExpectedDate: candidate.deliveryDate,
      warehouseId: candidate.warehouseId,
      warehouseCode: candidate.warehouseCode,
      warehouseName: candidate.warehouseName,
      sourceType: overrides.sourceType || 'MANUAL',
      orderStatus: overrides.orderStatus || 'ORDER',
      createdAt: overrides.createdAt || `2026-09-04T00:00:0${orderId.slice(-1)}.000Z`
    },
    items: candidate.items.map((item, index) => ({
      orderItemId: `${orderId}:ITEM:${index + 1}`,
      orderId,
      lineNo: index + 1,
      productId: item.productId,
      itemCode: item.itemCode,
      itemName: item.itemName,
      specification: item.specification,
      finalUnit: item.unit,
      finalQuantity: item.quantity,
      price: item.unitPrice,
      supplyAmount: item.amount,
      matchStatus: overrides.matchStatus || 'MATCHED'
    }))
  };
}

assert.deepEqual(validateShoppingOrderHeaders(SHOPPING_ORDER_HEADERS), []);
assert.ok(validateShoppingOrderHeaders([...SHOPPING_ORDER_HEADERS].reverse()).length > 0);

const adapterSource = readSource('orderq/shopping-order-command-adapter.js');
const repositorySource = readSource('orderq/shopping-order-import-repository.js');
const dbSource = readSource('orderq/orderq-db.js');
const smartInputSource = readSource('smartinput/smartinput.js');
const smartInputShoppingSource = readSource('smartinput/shopping-order-upload.js');
assert.doesNotMatch(adapterSource, /openOrderQDb|indexedDB|objectStore\s*\(/, 'consumer Adapter must not expose raw ORDER Q storage');
assert.match(repositorySource, /db\.transaction\(transactionStores\(\), 'readwrite'\)/);
assert.match(repositorySource, /STORE\.ORDERS, STORE\.ORDER_ITEMS, STORE\.ORDER_EVENTS, STORE\.SYNC_QUEUE, STORE\.META/);
assert.match(dbSource, /export const DB_VERSION = 7/);
assert.match(dbSource, /ensureIndex\(store, 'bySourceMessageKey', 'sourceMessageKey', \{ unique: true \}\)/);
assert.doesNotMatch(smartInputSource, /shopping-order-(?:dedupe-core|import-repository|command-adapter)/,
  'SmartInput product UI must not bypass its consumer integration module');
assert.match(smartInputShoppingSource, /shopping-order-command-adapter/);
assert.doesNotMatch(smartInputShoppingSource, /shopping-order-(?:dedupe-core|import-repository)/);
const manifest = JSON.parse(readSource('app-manifest.json'));
const ownerContract = manifest.sharedDataContracts.find(contract => contract.id === 'orderq-shopping-order-import');
assert.ok(ownerContract);
assert.equal(ownerContract.owner, 'orderq-vnext');
assert.deepEqual(ownerContract.consumers, ['smart-input']);
assert.equal(ownerContract.resources.databaseVersion, 7);

const base = build([sourceRow({ sourceBoundaryKey: 'DOC-1' })]).candidates[0];
assert.equal(base.issues.length, 0);
const unresolvedProduct = build([sourceRow({ sourceBoundaryKey: 'UNRESOLVED-PRODUCT' })], {
  resolveProduct: raw => ({ itemCode: raw['상품코드'], itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격'] })
}).candidates[0];
const partiallyUnresolvedProduct = build([
  sourceRow({ code: 'RESOLVED', name: '정상상품', sourceBoundaryKey: 'PARTIAL-PRODUCT', sourceRowNumber: 2 }),
  sourceRow({ code: 'UNRESOLVED', name: '미해소상품', sourceBoundaryKey: 'PARTIAL-PRODUCT', sourceRowNumber: 3 })
], {
  resolveProduct: raw => ({
    productId: raw['상품코드'] === 'UNRESOLVED' ? '' : `PRODUCT:${raw['상품코드']}`,
    itemCode: raw['상품코드'], itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격']
  })
}).candidates[0];
const unresolvedCustomer = build([sourceRow({ customer: '미해소거래처', sourceBoundaryKey: 'UNRESOLVED-CUSTOMER' })], {
  resolveCustomer: raw => ({ customerName: raw['거래처명'] })
}).candidates[0];
const unresolvedWarehouse = build([sourceRow({ sourceBoundaryKey: 'UNRESOLVED-WAREHOUSE' })], {
  warehouseId: '', warehouseCode: '', warehouseName: '미해소창고'
}).candidates[0];
[
  [unresolvedProduct, 'SHOPPING_PRODUCT_OWNER_ID_REQUIRED'],
  [partiallyUnresolvedProduct, 'SHOPPING_PRODUCT_OWNER_ID_REQUIRED'],
  [unresolvedCustomer, 'SHOPPING_CUSTOMER_OWNER_ID_REQUIRED'],
  [unresolvedWarehouse, 'SHOPPING_WAREHOUSE_OWNER_ID_REQUIRED']
].forEach(([candidate, issueCode]) => {
  assert.ok(candidate.issues.some(issue => issue.code === issueCode));
  const unresolvedPlan = planShoppingOrderDuplicates([candidate], []);
  assert.equal(unresolvedPlan.results[0].status, 'REVIEW_REQUIRED');
  assert.equal(unresolvedPlan.results[0].isDuplicate, null, `${issueCode} must not be shown as exact NEW`);
});
const missingStoredProductFields = cloneCandidate(base, 'MISSING-STORED-PRODUCT-FIELDS');
missingStoredProductFields.items[0].itemCode = '';
missingStoredProductFields.items[0].sourceProductCode = '';
missingStoredProductFields.items[0].itemName = '';
missingStoredProductFields.issues = [];
const missingStoredFieldsPlan = planShoppingOrderDuplicates([missingStoredProductFields], []);
assert.ok(missingStoredFieldsPlan.results[0].issues.some(issue => issue.code === 'SHOPPING_PRODUCT_CODE_REQUIRED'));
assert.ok(missingStoredFieldsPlan.results[0].issues.some(issue => issue.code === 'SHOPPING_PRODUCT_NAME_REQUIRED'));
assert.equal(missingStoredFieldsPlan.results[0].isDuplicate, null);
const oneExisting = [bundle(base, 'MANUAL-1')];
let candidates = [cloneCandidate(base, 'SOURCE-1'), cloneCandidate(base, 'SOURCE-2')];
let plan = planShoppingOrderDuplicates(candidates, oneExisting);
assert.deepEqual(plan.results.map(result => result.isDuplicate), [true, false], 'existing 1 + source 2 must create one surplus');
assert.deepEqual(plan.results.map(result => result.occurrenceNo), [1, 2]);
assert.equal(plan.summary.newCount, 1);

plan = planShoppingOrderDuplicates(candidates, [bundle(base, 'MANUAL-1'), bundle(base, 'MANUAL-2')]);
assert.deepEqual(plan.results.map(result => result.isDuplicate), [true, true], 'existing 2 + source 2 must create no surplus');
assert.equal(plan.summary.newCount, 0);

candidates = [cloneCandidate(base, 'SOURCE-1'), cloneCandidate(base, 'SOURCE-2'), cloneCandidate(base, 'SOURCE-3')];
plan = planShoppingOrderDuplicates(candidates, oneExisting);
assert.deepEqual(plan.results.map(result => result.isDuplicate), [true, false, false], 'existing 1 + source 3 must create two surplus');
assert.equal(plan.summary.newCount, 2);
assert.equal(plan.results[0].existingOrderIds[0], 'MANUAL-1', 'manual ORDER Q orders must count');

const invalidLedger = [{ order: { ...bundle(base, 'BROKEN-1').order }, items: [] }];
plan = planShoppingOrderDuplicates([base], invalidLedger);
assert.equal(plan.results[0].isDuplicate, null, 'an unscorable possibly matching actual-ledger bundle must fail closed');
assert.ok(plan.results[0].issues.some(issue => issue.code === 'EXISTING_LEDGER_BUNDLE_INVALID'));
const legacyCodeOnly = bundle(base, 'LEGACY-CODE-ONLY');
legacyCodeOnly.items[0].productId = null;
plan = planShoppingOrderDuplicates([base], [legacyCodeOnly]);
assert.equal(plan.results[0].isDuplicate, null, 'a possibly matching legacy code-only item must not produce false NEW');
assert.ok(plan.results[0].issues.some(issue => issue.code === 'EXISTING_LEDGER_BUNDLE_INVALID'));

const repeated = build([
  sourceRow({ sourceBoundaryKey: 'DOC-REPEAT', sourceRowNumber: 2 }),
  sourceRow({ sourceBoundaryKey: 'DOC-REPEAT', sourceRowNumber: 3 })
]);
assert.equal(repeated.candidates.length, 1);
assert.equal(repeated.candidates[0].issues.length, 0, 'explicit boundary makes repeated identical item rows unambiguous');
assert.equal(canonicalShoppingOrderBasis(repeated.candidates[0]).items.length, 2, 'multiset must preserve repeated identical lines');
assert.notEqual(canonicalShoppingOrderSignature(repeated.candidates[0]), canonicalShoppingOrderSignature(base));
const unorderedMultiset = build([
  sourceRow({ code: 'ORDER-A', name: '상품A', sourceBoundaryKey: 'DOC-ORDER', sourceRowNumber: 2 }),
  sourceRow({ code: 'ORDER-B', name: '상품B', sourceBoundaryKey: 'DOC-ORDER', sourceRowNumber: 3 })
]).candidates[0];
const reorderedMultiset = { ...unorderedMultiset, items: [...unorderedMultiset.items].reverse() };
assert.equal(canonicalShoppingOrderSignature(unorderedMultiset), canonicalShoppingOrderSignature(reorderedMultiset),
  'item row order must not change a duplicate-preserving multiset signature');

const ambiguous = build([
  sourceRow({ code: 'A', name: '상품A', sourceRowNumber: 2 }),
  sourceRow({ code: 'B', name: '상품B', sourceRowNumber: 3 }),
  sourceRow({ code: 'A', name: '상품A', sourceRowNumber: 4 }),
  sourceRow({ code: 'B', name: '상품B', sourceRowNumber: 5 })
]);
assert.equal(ambiguous.candidates.length, 1);
assert.ok(ambiguous.candidates[0].issues.some(issue => issue.code === 'AMBIGUOUS_SOURCE_ORDER_BOUNDARY'));
assert.equal(planShoppingOrderDuplicates(ambiguous.candidates, []).results[0].isDuplicate, null, 'unprovable boundary must fail closed');
const fileKeyIsNotBoundary = build([
  { ...sourceRow({ code: 'A', name: '상품A', sourceRowNumber: 2 }), sourceDocumentKey: 'FILE:SHEET' },
  { ...sourceRow({ code: 'A', name: '상품A', sourceRowNumber: 3 }), sourceDocumentKey: 'FILE:SHEET' }
]);
assert.ok(fileKeyIsNotBoundary.candidates[0].issues.some(issue => issue.code === 'AMBIGUOUS_SOURCE_ORDER_BOUNDARY'),
  'a file-level sourceDocumentKey must not be treated as an order boundary');

const separated = build([
  sourceRow({ customer: '같은거래처', code: 'A', sourceRowNumber: 2 }),
  sourceRow({ customer: '다른거래처', code: 'B', sourceRowNumber: 3 }),
  sourceRow({ customer: '같은거래처', code: 'A', sourceRowNumber: 4 })
]);
assert.equal(separated.candidates.length, 3, 'non-contiguous same customer runs are separate occurrences');
assert.equal(canonicalShoppingOrderSignature(separated.candidates[0]), canonicalShoppingOrderSignature(separated.candidates[2]));
assert.deepEqual(planShoppingOrderDuplicates(separated.candidates, []).results.map(result => result.occurrenceNo), [1, 1, 2]);

const statusA = build([sourceRow({ status: '주문', sourceBoundaryKey: 'DOC-A', sourceRowNumber: 2 })], {
  fileName: 'first.xls', uploadedAt: '2026-09-04T08:00:00+09:00'
}).candidates[0];
const statusB = build([sourceRow({ status: '준비', group: '88', sourceBoundaryKey: 'DOC-A', sourceRowNumber: 12289 })], {
  fileName: 'renamed.xls', uploadedAt: '2026-09-04T17:00:00+09:00'
}).candidates[0];
assert.equal(canonicalShoppingOrderSignature(statusA), canonicalShoppingOrderSignature(statusB),
  'status, group, filename, upload time, and absolute row offset must not change duplicate identity');
assert.equal(statusB.sourceEvidence.rows[0].sourceRowNumber, 12289, 'absolute source row remains immutable evidence');
assert.equal(statusB.sourceEvidence.rows[0].sourceValues['주문상태'], '준비');
assert.equal(statusB.sourceEvidence.rows[0].sourceValues['그룹'], '88');

const quantityChanged = build([sourceRow({ quantity: 2, amount: 2000, sourceBoundaryKey: 'DOC-A' })]).candidates[0];
const amountChanged = build([sourceRow({ quantity: 1, amount: 900, sourceBoundaryKey: 'DOC-A' })]).candidates[0];
assert.notEqual(canonicalShoppingOrderSignature(statusA), canonicalShoppingOrderSignature(quantityChanged));
assert.notEqual(canonicalShoppingOrderSignature(statusA), canonicalShoppingOrderSignature(amountChanged));
assert.ok(amountChanged.issues.some(issue => issue.code === 'SHOPPING_AMOUNT_MISMATCH'));
assert.equal(planShoppingOrderDuplicates([amountChanged], []).results[0].isDuplicate, null,
  'an original quantity x unit price mismatch must remain evidence and fail closed');

const zero = build([sourceRow({ quantity: 0, amount: 0, sourceBoundaryKey: 'DOC-ZERO' })]).candidates[0];
assert.ok(zero.issues.some(issue => issue.code === 'SHOPPING_ZERO_QUANTITY_REVIEW_REQUIRED'));
assert.equal(planShoppingOrderDuplicates([zero], []).results[0].isDuplicate, null);

function readActualWorkbook(file) {
  const started = performance.now();
  const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: false, cellText: true, cellNF: true });
  assert.ok(workbook.SheetNames.includes('Worksheet'));
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets.Worksheet, { header: 1, raw: false, defval: '', blankrows: true });
  const headers = matrix[0];
  assert.deepEqual(headers, [...SHOPPING_ORDER_HEADERS]);
  const dateIndex = headers.indexOf('배송일자');
  const latestDate = [...new Set(matrix.slice(1).map(row => String(row[dateIndex] || '').trim()).filter(Boolean))].sort().at(-1);
  const sourceRows = matrix.slice(1).map((sourceCells, index) => ({ sourceCells, sourceRowNumber: index + 2 }))
    .filter(row => String(row.sourceCells[dateIndex] || '').trim() === latestDate);
  const built = buildShoppingOrderCandidates(sourceRows, {
    headers,
    companyId: 'ONEAPP',
    warehouseId: 'WH-ACTUAL-01',
    warehouseCode: '01',
    warehouseName: '실파일 검증창고',
    resolveCustomer: raw => ({ customerId: `CUS:${String(raw['거래처명']).trim()}`, customerName: raw['거래처명'] }),
    resolveProduct: raw => ({
      productId: `PRODUCT:${String(raw['상품코드']).trim()}`,
      itemCode: String(raw['상품코드']).trim(),
      itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격']
    }),
    fileName: path.basename(file),
    sheetName: 'Worksheet',
    uploadedAt: '2026-09-04T12:00:00+09:00'
  });
  return { matrix, latestDate, sourceRows, built, elapsedMs: performance.now() - started };
}

const actualPaths = [
  process.env.ORDERQ_SHOP_SMALL || path.join(process.env.USERPROFILE || '', 'Desktop', 'orderlist-260904.xls'),
  process.env.ORDERQ_SHOP_CUMULATIVE || path.join(process.env.USERPROFILE || '', 'Desktop', 'orderlist-260904 (분석).xls')
];
if (actualPaths.every(file => file && fs.existsSync(file))) {
  const small = readActualWorkbook(actualPaths[0]);
  const cumulative = readActualWorkbook(actualPaths[1]);
  assert.equal(small.matrix.length, 15);
  assert.equal(cumulative.matrix.length, 12302);
  assert.equal(small.sourceRows.length, 14);
  assert.equal(cumulative.sourceRows.length, 14);
  assert.equal(small.latestDate, '2026-09-04');
  assert.equal(cumulative.latestDate, '2026-09-04');
  assert.equal(small.built.issues.length, 0);
  assert.equal(cumulative.built.issues.length, 0);
  assert.equal(small.built.candidates.length, 5);
  assert.equal(cumulative.built.candidates.length, 5);
  assert.equal(small.built.candidates.flatMap(candidate => candidate.issues).length, 0);
  assert.equal(cumulative.built.candidates.flatMap(candidate => candidate.issues).length, 0);
  assert.equal(small.built.candidates.reduce((sum, candidate) =>
    sum + candidate.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0), 24);
  assert.equal(small.built.candidates.reduce((sum, candidate) =>
    sum + candidate.items.reduce((itemSum, item) => itemSum + item.amount, 0), 0), 288400);
  assert.equal(new Set(small.built.candidates.map(canonicalShoppingOrderSignature)).size, 5);
  assert.deepEqual(
    small.built.candidates.map(canonicalShoppingOrderSignature),
    cumulative.built.candidates.map(canonicalShoppingOrderSignature),
    'daily and cumulative latest rows must match without absolute-row identity'
  );
  assert.deepEqual(small.sourceRows.map(row => row.sourceCells), cumulative.sourceRows.map(row => row.sourceCells));
  assert.ok(cumulative.elapsedMs < 5000, `12,301-row workbook parse took ${cumulative.elapsedMs.toFixed(1)}ms`);
  console.log(`Actual shopping files PASS: 14 rows / 5 candidates / qty 24 / amount 288400 / validation 0 / cumulative 12,301 rows ${cumulative.elapsedMs.toFixed(1)}ms`);
} else {
  console.log(`Actual shopping files SKIP: local read-only files not present (${actualPaths.join(', ')})`);
}

console.log(`${SHOPPING_ORDER_DEDUPE_SCHEMA} multiset, immutable evidence, boundary fail-closed, and actual-file tests PASS`);
