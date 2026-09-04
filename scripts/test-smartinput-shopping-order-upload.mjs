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
  planShoppingOrderDuplicates,
  validateShoppingOrderHeaders
} from '../orderq/shopping-order-dedupe-core.js';
import {
  buildShoppingOrderUploadRequest,
  createShoppingOrderUpload,
  inspectShoppingOrderUpload,
  isExactShoppingOrderMatrix,
  selectShoppingCustomer,
  selectShoppingProduct,
  shoppingUploadTotals
} from '../smartinput/shopping-order-upload.js';
import { readWorksheetSource } from '../smartinput/xlsx-source-reader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const XLSX = require(path.join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'));
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

const fakeAdapter = {
  isExactSource: headers => validateShoppingOrderHeaders(headers).length === 0,
  capability: () => ({ schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA }),
  createCandidates: asyncNever => asyncNever,
  inspect: async () => { throw new Error('FAKE_INSPECT_NOT_CONFIGURED'); },
  commit: async () => { throw new Error('FAKE_COMMIT_NOT_CONFIGURED'); }
};

function resolvedUpload(upload, adapter) {
  const customerIndex = upload.headers.indexOf('거래처명');
  const productCodeIndex = upload.headers.indexOf('상품코드');
  const productNameIndex = upload.headers.indexOf('상품명');
  upload.sourceRows.forEach(row => {
    const customerName = row.sourceCells[customerIndex];
    const itemCode = row.sourceCells[productCodeIndex];
    const itemName = row.sourceCells[productNameIndex];
    selectShoppingCustomer(upload, customerName, {
      customerId: `CUS:${customerName}`, customerCode: `C-${customerName}`, customerName
    });
    selectShoppingProduct(upload, row.sourceRowNumber, {
      productId: `PRODUCT:${itemCode}`, itemCode, itemName
    });
  });
  return buildShoppingOrderUploadRequest(upload, {
    companyId: 'ONEAPP',
    warehouse: { warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '본사창고' }
  }, adapter);
}

function workbookSource(file) {
  const started = performance.now();
  const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: false, cellText: true, cellNF: true });
  assert.ok(workbook.SheetNames.includes('Worksheet'));
  const read = readWorksheetSource(XLSX, workbook.Sheets.Worksheet);
  return { ...read, elapsedMs: performance.now() - started };
}

function bundle(candidate, orderId) {
  return {
    order: {
      orderId,
      orderNo: `20260904-${orderId.slice(-3)}`,
      companyId: candidate.companyId,
      customerId: candidate.customerId,
      customerCode: candidate.customerCode,
      customerName: candidate.customerName,
      deliveryExpectedDate: candidate.deliveryDate,
      warehouseId: candidate.warehouseId,
      warehouseCode: candidate.warehouseCode,
      warehouseName: candidate.warehouseName,
      sourceType: 'MANUAL',
      createdAt: `2026-09-04T00:00:${orderId.slice(-2)}.000Z`
    },
    items: candidate.items.map((item, index) => ({
      orderItemId: `${orderId}:${index + 1}`,
      orderId,
      lineNo: index + 1,
      productId: item.productId,
      itemCode: item.itemCode,
      itemName: item.itemName,
      specification: item.specification,
      finalUnit: item.unit,
      finalQuantity: item.quantity,
      price: item.unitPrice,
      supplyAmount: item.amount
    }))
  };
}

assert.equal(isExactShoppingOrderMatrix([SHOPPING_ORDER_HEADERS], fakeAdapter), true);
assert.equal(isExactShoppingOrderMatrix([[...SHOPPING_ORDER_HEADERS].reverse()], fakeAdapter), false);

const actualPaths = [
  process.env.ORDERQ_SHOP_SMALL || path.join(process.env.USERPROFILE || '', 'Desktop', 'orderlist-260904.xls'),
  process.env.ORDERQ_SHOP_CUMULATIVE || path.join(process.env.USERPROFILE || '', 'Desktop', 'orderlist-260904 (분석).xls')
];

let actualEvidence = null;
if (actualPaths.every(file => file && fs.existsSync(file))) {
  const smallSource = workbookSource(actualPaths[0]);
  const cumulativeSource = workbookSource(actualPaths[1]);
  const coreAdapter = await import('../orderq/shopping-order-command-adapter.js');
  const small = createShoppingOrderUpload({
    matrix: smallSource.displayMatrix,
    sourceCellMatrix: smallSource.sourceCellMatrix,
    fileName: path.basename(actualPaths[0]),
    sheetName: 'Worksheet',
    fileFingerprint: 'small',
    uploadedAt: '2026-09-04T09:00:00+09:00'
  }, coreAdapter.ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER);
  const cumulative = createShoppingOrderUpload({
    matrix: cumulativeSource.displayMatrix,
    sourceCellMatrix: cumulativeSource.sourceCellMatrix,
    fileName: path.basename(actualPaths[1]),
    sheetName: 'Worksheet',
    fileFingerprint: 'cumulative',
    uploadedAt: '2026-09-04T18:00:00+09:00'
  }, coreAdapter.ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER);
  assert.equal(small.fullDataRowCount, 14);
  assert.equal(cumulative.fullDataRowCount, 12301);
  assert.equal(small.sourceRows.length, 14);
  assert.equal(cumulative.sourceRows.length, 14);
  assert.equal(small.selectedDeliveryDate, '2026-09-04');
  assert.equal(cumulative.selectedDeliveryDate, '2026-09-04');
  assert.equal(small.sourceRows[0].sourceRowNumber, 2);
  assert.equal(cumulative.sourceRows[0].sourceRowNumber, 12289);
  assert.deepEqual(small.sourceRows.map(row => row.sourceCells), cumulative.sourceRows.map(row => row.sourceCells));
  assert.deepEqual(small.sourceRows[0].sourceCellEvidence, smallSource.sourceCellMatrix[1]);
  assert.notEqual(small.sourceRows[0].sourceCellEvidence[0].address, cumulative.sourceRows[0].sourceCellEvidence[0].address,
    'absolute spreadsheet cell addresses remain evidence but not identity');
  assert.deepEqual(shoppingUploadTotals(small), { rowCount: 14, quantity: 24, amount: 288400 });
  const preparedSmall = resolvedUpload(small, coreAdapter.ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER);
  const preparedCumulative = resolvedUpload(cumulative, coreAdapter.ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER);
  assert.equal(preparedSmall.built.issues.length, 0);
  assert.equal(preparedSmall.built.candidates.length, 5);
  assert.equal(preparedSmall.built.candidates.flatMap(candidate => candidate.issues).length, 0);
  const smallPlan = planShoppingOrderDuplicates(preparedSmall.built.candidates, []);
  const cumulativePlan = planShoppingOrderDuplicates(preparedCumulative.built.candidates, []);
  assert.deepEqual(smallPlan.results.map(result => result.canonicalSignature), cumulativePlan.results.map(result => result.canonicalSignature));
  assert.deepEqual(preparedSmall.built.candidates[0].sourceRows[0].sourceCellEvidence, small.sourceRows[0].sourceCellEvidence,
    'source cell evidence must remain deep-equal through SmartInput and the owner core');
  assert.ok(cumulativeSource.elapsedMs < 5000, `cumulative workbook parse took ${cumulativeSource.elapsedMs.toFixed(1)}ms`);
  actualEvidence = {
    smallRows: small.sourceRows.length,
    cumulativeRows: cumulative.sourceRows.length,
    candidates: preparedSmall.built.candidates.length,
    totals: shoppingUploadTotals(small),
    cumulativeParseMs: Number(cumulativeSource.elapsedMs.toFixed(1))
  };
}

const row = ({ customer = '거래처A', code = 'P-001', name = '상품A', quantity = 1, unitPrice = 1000,
  amount = quantity * unitPrice, sourceRowNumber = 2 } = {}) => ({
  sourceCells: ['2026-09-04', customer, '', '입금', '말씀', '메모', code, name, 'BOX', quantity, unitPrice, amount, code, '주소', '전화', code, '그룹'],
  sourceRowNumber,
  sourceCellEvidence: SHOPPING_ORDER_HEADERS.map((header, columnIndex) => ({ address: `${columnIndex}:${sourceRowNumber}`, displayValue: header }))
});
const core = await import('../orderq/shopping-order-command-adapter.js');
const coreAdapter = core.ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER;
const synthetic = createShoppingOrderUpload({
  matrix: [SHOPPING_ORDER_HEADERS, row().sourceCells],
  sourceCellMatrix: [[], row().sourceCellEvidence],
  fileName: 'synthetic.xls', sheetName: 'Worksheet', fileFingerprint: 'fixture'
}, coreAdapter);
const prepared = resolvedUpload(synthetic, coreAdapter);
const base = prepared.built.candidates[0];
assert.equal(base.issues.length, 0);
const source2 = [clone(base), clone(base)].map((candidate, index) => ({ ...candidate, candidateId: `SOURCE-${index + 1}` }));
assert.equal(planShoppingOrderDuplicates(source2, [bundle(base, '001')]).summary.newCount, 1);
assert.equal(planShoppingOrderDuplicates(source2, [bundle(base, '001'), bundle(base, '002')]).summary.newCount, 0);
const source3 = [...source2, { ...clone(base), candidateId: 'SOURCE-3' }];
assert.equal(planShoppingOrderDuplicates(source3, [bundle(base, '001')]).summary.newCount, 2);

const issueRows = [
  row({ customer: '거래처-정상', code: 'OK', sourceRowNumber: 2 }),
  row({ customer: '거래처-금액', code: 'AMOUNT', quantity: 2, unitPrice: 1000, amount: 1500, sourceRowNumber: 3 }),
  row({ customer: '거래처-경계', code: 'BOUNDARY', sourceRowNumber: 4 }),
  row({ customer: '거래처-경계', code: 'BOUNDARY', sourceRowNumber: 5 })
];
const issueUpload = createShoppingOrderUpload({
  matrix: [SHOPPING_ORDER_HEADERS, ...issueRows.map(item => item.sourceCells)],
  sourceCellMatrix: [[], ...issueRows.map(item => item.sourceCellEvidence)],
  fileName: 'issues.xls', sheetName: 'Worksheet'
}, coreAdapter);
resolvedUpload(issueUpload, coreAdapter);
delete issueUpload.customerSelections['거래처-금액'.normalize('NFKC').toLowerCase().replace(/\s+/g, '')];
const issuePrepared = buildShoppingOrderUploadRequest(issueUpload, {
  companyId: 'ONEAPP', warehouse: { warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '본사창고' }
}, coreAdapter);
const issuePlan = planShoppingOrderDuplicates(issuePrepared.built.candidates, []);
assert.equal(issuePlan.results[0].status, 'NEW');
assert.equal(issuePlan.results[1].status, 'REVIEW_REQUIRED');
assert.ok(issuePlan.results[1].issues.some(issue => ['SHOPPING_CUSTOMER_OWNER_ID_REQUIRED', 'SHOPPING_AMOUNT_MISMATCH'].includes(issue.code)));
assert.equal(issuePlan.results[2].status, 'REVIEW_REQUIRED');
assert.ok(issuePlan.results[2].issues.some(issue => issue.code === 'AMBIGUOUS_SOURCE_ORDER_BOUNDARY'));

const productIssueRows = [
  row({ customer: '거래처-정상-상품검사', code: 'PRODUCT-OK', sourceRowNumber: 20 }),
  row({ customer: '거래처-상품미해소', code: 'PRODUCT-UNRESOLVED', sourceRowNumber: 21 })
];
const productIssueUpload = createShoppingOrderUpload({
  matrix: [SHOPPING_ORDER_HEADERS, ...productIssueRows.map(item => item.sourceCells)],
  sourceCellMatrix: [[], ...productIssueRows.map(item => item.sourceCellEvidence)],
  fileName: 'product-issue.xls', sheetName: 'Worksheet'
}, coreAdapter);
resolvedUpload(productIssueUpload, coreAdapter);
delete productIssueUpload.productSelections[String(productIssueUpload.sourceRows[1].sourceRowNumber)];
const productIssueInspection = await inspectShoppingOrderUpload(productIssueUpload, {
  companyId: 'ONEAPP', warehouse: { warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '본사창고' }
}, {
  ...coreAdapter,
  inspect: async request => planShoppingOrderDuplicates(request.candidates, [])
});
assert.deepEqual(productIssueInspection.results.map(result => result.status), ['NEW', 'REVIEW_REQUIRED']);
assert.ok(productIssueInspection.results[1].issues.some(issue => issue.code === 'SHOPPING_PRODUCT_OWNER_ID_REQUIRED'));

const warehouseIssueInspection = await inspectShoppingOrderUpload(synthetic, {
  companyId: 'ONEAPP', warehouse: { warehouseId: '', warehouseCode: '', warehouseName: '미해소 창고' }
}, {
  ...coreAdapter,
  inspect: async request => planShoppingOrderDuplicates(request.candidates, [])
});
assert.equal(warehouseIssueInspection.results[0].status, 'REVIEW_REQUIRED');
assert.ok(warehouseIssueInspection.results[0].issues.some(issue => issue.code === 'SHOPPING_WAREHOUSE_OWNER_ID_REQUIRED'));

const inspected = await inspectShoppingOrderUpload(synthetic, {
  companyId: 'ONEAPP', warehouse: { warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '본사창고' }
}, {
  ...coreAdapter,
  inspect: async request => planShoppingOrderDuplicates(request.candidates, [bundle(base, '777')])
});
assert.equal(inspected.results[0].status, 'DUPLICATE');
assert.equal(inspected.results[0].existingOrderNo, '20260904-777');

const smartInputSource = source('smartinput/smartinput.js');
const integrationSource = source('smartinput/shopping-order-upload.js');
assert.match(smartInputSource, /from '\.\/shopping-order-upload\.js\?v=/);
assert.doesNotMatch(smartInputSource, /shopping-order-(?:dedupe-core|import-repository|command-adapter)/,
  'SmartInput UI must consume only its command-boundary integration module');
assert.match(integrationSource, /from '\.\.\/orderq\/shopping-order-command-adapter\.js\?v=/);
assert.doesNotMatch(integrationSource, /openOrderQDb|indexedDB|objectStore\s*\(|shopping-order-import-repository/);
assert.match(smartInputSource, /if \(shoppingOrderImport\(\)\) return completeShoppingOrderImport\(\)/);
assert.match(source('smartinput/index.html'), /id="shoppingOrderImport"/);

console.log(JSON.stringify({
  taskId: 'NEXUS-SMARTINPUT-SHOPPING-UPLOAD-20260904-01',
  status: 'PASS',
  actual: actualEvidence || 'SKIP_LOCAL_FILES_NOT_PRESENT',
  synthetic: {
    multiset: ['1+2=1', '2+2=0', '1+3=2'],
    reviewIsolation: ['customer+amount', 'product', 'warehouse', 'boundary'],
    duplicateOrderNo: '20260904-777'
  },
  ownership: 'SmartInput -> ORDER Q command adapter; no raw ORDER Q storage access'
}, null, 2));
