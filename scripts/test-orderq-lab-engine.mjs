#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WorkbookXLSX = require(path.join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'));
const html = fs.readFileSync(path.join(root, 'archive', 'OrderQ_Lab.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((source) => source.includes('OrderQLabTestPort'));
assert.ok(script, 'inline OrderQ Lab application script is required');

class FakeClassList {
  toggle() {}
  add() {}
  remove() {}
  contains() { return false; }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.returnValue = '';
    this.disabled = false;
    this.innerHTML = '';
    this.textContent = '';
  }
  addEventListener() {}
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  showModal() {}
  close(value = '') { this.returnValue = value; }
  focus() {}
}

const elements = new Map();
const getElement = (selector) => {
  if (!elements.has(selector)) elements.set(selector, new FakeElement());
  return elements.get(selector);
};
const document = {
  querySelector: getElement,
  querySelectorAll: () => [],
  addEventListener() {},
};
const localStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
const context = {
  console,
  document,
  localStorage,
  confirm: () => true,
  setTimeout: (callback) => { if (typeof callback === 'function') callback(); return 1; },
  clearTimeout() {},
  Intl,
  Date,
  Map,
  Set,
  JSON,
  Math,
  Number,
  String,
  Object,
  Array,
  RegExp,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  Blob,
  XLSX: WorkbookXLSX,
};
context.window = context;
vm.runInNewContext(script, context, { filename: 'OrderQ_Lab.inline.js' });
const port = context.OrderQLabTestPort;
assert.equal(port.version, '1.0.0');

const opening = port.parseMatrix([
  ['회사명 : 원앱 / 1창고 / 2026/09/02 / 재고현황'],
  ['단위', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '기본', '적요'],
  ['BOX', '001a A', '테스트상품', '10kg', 7, '09/02', '거래처', 1000, '1', ''],
], 'opening', '0902재고.xlsx', '재고현황');
assert.equal(opening.rows[0].code, '001a A', 'product code identity must preserve leading zero, case, and internal spaces');
assert.equal(opening.rows[0].quantity, 7);
assert.equal(opening.rows[0].warehouse, '01', 'warehouse title metadata should normalize to an exact warehouse code');

port.injectSources({});
assert.equal(port.applySource('opening', opening), true);
assert.equal(port.applySource('opening', opening), false, 'the same source fingerprint must be idempotent');
const replacementOpening = port.parseMatrix([
  ['회사명 : 원앱 / 1창고 / 2026/09/02 / 재고현황'],
  ['단위', '품목코드', '품명', '규격', '재고'],
  ['BOX', '001a A', '테스트상품', '10kg', 8],
], 'opening', '0902재고_수정.xlsx', '재고현황');
assert.equal(port.applySource('opening', replacementOpening), true);
const sourceReplacementSnapshot = port.snapshot();
assert.equal(sourceReplacementSnapshot.sourceArchive.length, 1, 'replaced source must remain in immutable source history');
assert.equal(sourceReplacementSnapshot.sourceArchive[0].rows[0].quantity, 7, 'archived source rows must remain unchanged');
assert.equal(sourceReplacementSnapshot.sources.opening.rows[0].quantity, 8);

const purchase = port.parseMatrix([
  ['회사명 : 원앱 / 2026/09/03'],
  ['일자', '일자-No.', '거래처코드', '거래처명', '창고코드', '코드', '품명', '규격', '수량', '단가', '합계', '적요', '구매처'],
  ['2026/09/03', 'P-1', 'S1', '공급처', '99', '001a A', '테스트상품', '10kg', 5, 1000, 5000, '', ''],
], 'purchases', '0903구매.xlsx', '구매현황내역');
assert.equal(purchase.rows[0].warehouse, '99');
assert.equal(purchase.rows[0].quantity, 5, '창고코드는 수량으로 사용하면 안 된다');

const stocktake = port.parseMatrix([
  ['단위', '적재위치', '구분(기본)', '구매처', '품목코드', '품목명', '규격', '재고', '전재고', '입고', '출고', '잔량', '입고가'],
  ['BOX', '', '1', '공급처', '001a A', '테스트상품', '10kg', 49, 50, '', 4, 46, 1000],
], 'stocktake', '0903재고.xlsx', '재고변동표');
assert.equal(stocktake.rows[0].quantity, 49, '실사재고는 정확한 재고 헤더를 사용하고 계산 잔량과 합치지 않는다');
assert.equal(stocktake.rows[0].balance, 46);

const salesWithoutPeriodTotal = port.parseMatrix([
  ['일자', '창고코드', '거래처명', '품목코드', '품명', '수량'],
  ['2026/09/03', '02', '고객A', 'P1', '상품1', 8],
  ['2026/09 계', '', '', 2107, '', 16566340]
], 'sales', '0903판매.xlsx', '판매현황내역');
assert.equal(salesWithoutPeriodTotal.rowCount, 1, 'ERP period total row must not be parsed as a product');
assert.equal(salesWithoutPeriodTotal.rows[0].quantity, 8);

const defaultRealSalesPath = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Desktop', '0903판매.xlsx')
  : '';
const realSalesPath = process.env.ORDERQ_LAB_REAL_SALES || defaultRealSalesPath;
if (realSalesPath && fs.existsSync(realSalesPath)) {
  const workbook = WorkbookXLSX.read(fs.readFileSync(realSalesPath), {
    type: 'buffer', cellDates: false, cellNF: true, cellText: true,
  });
  const sheetName = '판매현황내역';
  assert.ok(workbook.SheetNames.includes(sheetName), 'real sales workbook sheet must exist');
  const sheet = workbook.Sheets[sheetName];
  const rawMatrix = WorkbookXLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  const displayMatrix = WorkbookXLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
  const headers = displayMatrix[1];
  assert.deepEqual(
    [headers[8], headers[9], headers[10], headers[16]],
    ['수량', '단가', '공급가', '구매합계'],
    'real sales positional headers changed',
  );
  const parsedRealSales = port.parseMatrix(displayMatrix, 'sales', path.basename(realSalesPath), sheetName);
  const parsedActualSources = { sales: parsedRealSales };
  assert.equal(parsedRealSales.headerRowNumber, 2);
  assert.equal(parsedRealSales.columnMap.quantity, 8, 'quantity must map only to column I');
  assert.equal(parsedRealSales.columnMap.unitPrice, 9, 'unit price must map only to column J');
  assert.equal(parsedRealSales.columnMap.amount, 10, 'supply amount must map only to column K');
  assert.equal(parsedRealSales.columnMap.purchasePrice, 15, 'purchase price must map only to column P');
  assert.equal(Object.values(parsedRealSales.columnMap).includes(16), false, 'purchase total must remain outside the OrderQ quantity contract');
  assert.equal(new Set(Object.values(parsedRealSales.columnMap)).size, Object.values(parsedRealSales.columnMap).length, 'canonical fields must not reuse one source column');
  assert.equal(parsedRealSales.rowCount, 337, 'period total and print timestamp rows must be excluded');

  const parsedBySourceRow = new Map(parsedRealSales.rows.map((row) => [row.sourceRowNumber, row]));
  for (const sourceRowNumber of [3, 73, 339]) {
    const parsedRow = parsedBySourceRow.get(sourceRowNumber);
    assert.ok(parsedRow, `representative source row ${sourceRowNumber} must survive parsing`);
    assert.equal(parsedRow.quantity, Number(rawMatrix[sourceRowNumber - 1][8]), `raw quantity mismatch at source row ${sourceRowNumber}`);
    assert.equal(parsedRow.quantity, Number(displayMatrix[sourceRowNumber - 1][8]), `display quantity mismatch at source row ${sourceRowNumber}`);
    assert.equal(parsedRow.sourceCells[8], displayMatrix[sourceRowNumber - 1][8], `immutable display evidence mismatch at source row ${sourceRowNumber}`);
  }
  const parsedSourceRows = new Set(parsedRealSales.rows.map((row) => row.sourceRowNumber));
  const rawQuantityTotal = rawMatrix.reduce((sum, row, index) => parsedSourceRows.has(index + 1) ? sum + Number(row[8] || 0) : sum, 0);
  const displayQuantityTotal = displayMatrix.reduce((sum, row, index) => parsedSourceRows.has(index + 1) ? sum + Number(String(row[8] || '0').replace(/,/g, '')) : sum, 0);
  const parsedQuantityTotal = parsedRealSales.rows.reduce((sum, row) => sum + row.quantity, 0);
  assert.equal(rawQuantityTotal, 2107, 'real sales raw quantity total changed');
  assert.equal(displayQuantityTotal, 2107, 'real sales display quantity total changed');
  assert.equal(parsedQuantityTotal, 2107, 'parser must reconcile exactly to the real sales quantity total');
  assert.equal(parsedRealSales.rows.some((row) => row.sourceRowNumber === 340), false, 'period total source row must be excluded');

  const realWorkbookCases = [
    {
      role: 'opening', env: 'ORDERQ_LAB_REAL_OPENING', defaultName: '0902재고.xlsx', sheetName: '재고현황',
      expectedRows: 267, quantityIndex: 4, assertions(source) {
        assert.equal(source.columnMap.quantity, 4);
        assert.equal(source.columnMap.code, 1);
        assert.equal(source.rows.find((row) => row.code === '101018110')?.quantity, 50);
        assert.equal(source.rows.find((row) => row.code === '101018110')?.warehouse, '01');
      },
    },
    {
      role: 'purchases', env: 'ORDERQ_LAB_REAL_PURCHASES', defaultName: '0903구매.xlsx', sheetName: '구매현황내역',
      expectedRows: 249, quantityIndex: 8, assertions(source) {
        assert.equal(source.columnMap.warehouse, 4);
        assert.equal(source.columnMap.quantity, 8);
        assert.notEqual(source.columnMap.warehouse, source.columnMap.quantity);
        assert.equal(source.rows.reduce((sum, row) => sum + row.quantity, 0), 2276);
      },
    },
    {
      role: 'stocktake', env: 'ORDERQ_LAB_REAL_STOCKTAKE', defaultName: '0903재고.xlsx', sheetName: '재고변동표',
      expectedRows: 265, quantityIndex: 7, assertions(source) {
        assert.equal(source.columnMap.quantity, 7);
        assert.equal(source.columnMap.balance, 11);
        assert.notEqual(source.columnMap.quantity, source.columnMap.balance);
        const onion = source.rows.find((row) => row.code === '101018110');
        assert.equal(onion?.quantity, 49, 'real stocktake quantity must use 재고');
        assert.equal(onion?.balance, 46, 'real stocktake 잔량 stays comparison evidence only');
      },
    },
  ];
  for (const testCase of realWorkbookCases) {
    const filePath = process.env[testCase.env]
      || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop', testCase.defaultName) : '');
    if (!filePath || !fs.existsSync(filePath)) continue;
    const book = WorkbookXLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false, cellNF: true, cellText: true });
    assert.ok(book.SheetNames.includes(testCase.sheetName), `${testCase.sheetName} must exist`);
    const matrix = WorkbookXLSX.utils.sheet_to_json(book.Sheets[testCase.sheetName], { header: 1, raw: false, defval: '', blankrows: true });
    const source = port.parseMatrix(matrix, testCase.role, path.basename(filePath), testCase.sheetName);
    assert.equal(source.rowCount, testCase.expectedRows, `${testCase.role} real row count changed`);
    assert.equal(source.columnMap.quantity, testCase.quantityIndex, `${testCase.role} exact quantity column changed`);
    testCase.assertions(source);
    parsedActualSources[testCase.role] = source;
  }
  if (['opening', 'purchases', 'stocktake'].every((role) => parsedActualSources[role])) {
    const firstSale = parsedRealSales.rows[0];
    const actualOrder = {
      ...firstSale,
      rowId: 'orders:actual-output:1', sourceRole: 'orders', sourceFile: 'repository-order-fixture.xlsx',
      sourceSheet: '미판매현황', sourceRowNumber: 3, quantity: firstSale.quantity,
      quantityState: firstSale.quantity === 0 ? 'ZERO' : 'VALUE', rawQuantity: firstSale.quantity,
    };
    port.injectSources({
      orders: { fileName: 'repository-order-fixture.xlsx', sheetName: '미판매현황', rows: [actualOrder] },
      opening: parsedActualSources.opening,
      purchases: parsedActualSources.purchases,
      sales: parsedActualSources.sales,
      stocktake: parsedActualSources.stocktake,
    });
    const actualValidation = port.validate();
    assert.equal(actualValidation.ok, true, JSON.stringify(actualValidation.issues));
    const actualOutputs = port.getOutputRows();
    assert.equal(actualOutputs.outbound.length, 337);
    assert.equal(actualOutputs.ledger.length, 853, 'ledger must contain every actual opening, purchase, and sales source row');
    const actualWorkbook = port.createWorkbook();
    assert.deepEqual(actualWorkbook.SheetNames, ['출고현황', '발주현황', '재고수불부', '창고별재고', '대체소분이력', '상품관계']);
    const actualBytes = WorkbookXLSX.write(actualWorkbook, { type: 'buffer', bookType: 'xlsx', compression: true });
    const actualReopened = WorkbookXLSX.read(actualBytes, { type: 'buffer', cellNF: true, cellStyles: true });
    assert.deepEqual(actualReopened.SheetNames, actualWorkbook.SheetNames);
    if (process.env.ORDERQ_LAB_QA_OUTPUT) fs.writeFileSync(process.env.ORDERQ_LAB_QA_OUTPUT, actualBytes);
  }
}

assert.throws(() => port.parseMatrix([
  ['거래처명', '품목코드', '품명', '수량', '판매수량'],
  ['고객', 'P1', '상품', 1, 1],
], 'sales', '중복헤더.xlsx', '판매현황'), /헤더가 중복/);

const makeRow = (role, rowId, code, name, quantity, extra = {}) => ({
  rowId,
  sourceRole: role,
  sourceFile: `${role}.xlsx`,
  sourceSheet: role,
  sourceRowNumber: Number(rowId.replace(/\D/g, '')) || 2,
  code,
  name,
  spec: extra.spec || 'EA',
  unit: extra.unit || 'EA',
  quantity,
  date: extra.date || '2026/09/03',
  customer: extra.customer || '',
  customerCode: extra.customerCode || '',
  warehouse: extra.warehouse || '01',
  ...extra,
});

port.injectSources({
  orders: { rows: [
    makeRow('orders', 'OD1', 'PD', '일자상품', 5, { customer: '고객D', customerCode: 'CD', date: '2026/09/02' }),
    makeRow('orders', 'OD2', 'PD', '일자상품', 5, { customer: '고객D', customerCode: 'CD', date: '2026/09/04' }),
  ] },
  sales: { rows: [
    makeRow('sales', 'SD1', 'PD', '일자상품', 4, { customer: '고객D', customerCode: 'CD', date: '2026/09/03' }),
    makeRow('sales', 'SD2', 'PD', '일자상품', -1, { customer: '고객D', customerCode: 'CD', date: '2026/09/03' }),
  ] },
});
const datedFulfillment = port.getFulfillment();
assert.equal(datedFulfillment.balances.find((row) => row.orderRowId === 'OD1').matchedQuantity, 3, 'negative sales must reverse a prior exact shipment');
assert.equal(datedFulfillment.balances.find((row) => row.orderRowId === 'OD2').matchedQuantity, 0, 'a sale must not fulfill a later order');
assert.equal(datedFulfillment.links.some((row) => row.method === 'NEGATIVE_SALES_REVERSAL' && row.allocatedQuantity === -1), true);
assert.equal(datedFulfillment.unmatchedSales.length, 0);

port.injectSources({
  orders: { rows: [
    makeRow('orders', 'O1', 'P1', '상품1', 5, { customer: '고객A', customerCode: 'C1', spec: '10kg' }),
    makeRow('orders', 'O2', 'P1', '상품1', 4, { customer: '고객B', customerCode: 'C2', spec: '10kg' }),
    makeRow('orders', 'O3', 'P3', '부족상품', 10, { customer: '고객C', customerCode: 'C3' }),
  ] },
  opening: { rows: [
    makeRow('opening', 'I1', 'P1', '상품1', 10, { spec: '10kg' }),
    makeRow('opening', 'I2', 'P2', '대체상품', 10, { spec: '1kg' }),
    makeRow('opening', 'I3', '=FORMULA', '수식문자상품', 1),
    makeRow('opening', 'I4', 'P3', '부족상품', 2),
  ] },
  purchases: { rows: [makeRow('purchases', 'P1', 'P1', '상품1', 2)] },
  sales: { rows: [
    makeRow('sales', 'S1', 'P1', '상품1', 3, { customer: '고객A', customerCode: 'C1' }),
    makeRow('sales', 'S2', 'P1', '상품1', 2, { customer: '고객X', customerCode: 'CX' }),
  ] },
  stocktake: { rows: [
    makeRow('stocktake', 'T1', 'P1', '상품1', 10),
    makeRow('stocktake', 'T2', 'P2', '대체상품', 0),
  ] },
});

const fulfillment = port.getFulfillment();
assert.equal(fulfillment.balances.find((row) => row.orderRowId === 'O1').matchedQuantity, 3);
assert.equal(fulfillment.balances.find((row) => row.orderRowId === 'O1').remainingQuantity, 2);
assert.equal(fulfillment.balances.find((row) => row.orderRowId === 'O2').remainingQuantity, 4);
assert.equal(fulfillment.balances.find((row) => row.orderRowId === 'O3').remainingQuantity, 10);
assert.equal(fulfillment.unmatchedSales.reduce((sum, row) => sum + row.quantity, 0), 2);

const beforeRelation = port.getRows().map(({ key, physicalOutbound, calculated }) => ({ key, physicalOutbound, calculated }));
port.registerRelation({ relationId: 'REL-1', sourceProductKey: 'C:P1', targetProductKey: 'C:P2' });
const afterRelation = port.getRows().map(({ key, physicalOutbound, calculated }) => ({ key, physicalOutbound, calculated }));
assert.deepEqual(afterRelation, beforeRelation, '상품 관계확정은 모든 수량에 영향이 없어야 한다');

assert.throws(() => port.applyAdminSubstitution({
  operationId: 'SUB-BAD', sourceProductKey: 'C:P1', targetProductKey: 'C:P2', customer: '고객A', warehouse: '01',
  sourceSalesQuantity: 1, actualOutboundQuantity: 2, conversionAuthority: 'AUTO_INFERRED',
}), /ADMIN_CONFIRMATION_REQUIRED/);

port.applyAdminSubstitution({
  operationId: 'SUB-1', sourceProductKey: 'C:P1', targetProductKey: 'C:P2', customer: '고객A', warehouse: '01',
  sourceSalesQuantity: 1, actualOutboundQuantity: 2, conversionAuthority: 'ADMIN_CONFIRMED', note: '실작업 확인',
});
let productRows = port.getRows();
assert.equal(productRows.find((row) => row.code === 'P1').physicalOutbound, 4);
assert.equal(productRows.find((row) => row.code === 'P2').physicalOutbound, 2);
assert.notEqual(productRows.find((row) => row.code === 'P2').physicalOutbound, 10, '10kg to 1kg must not imply an automatic 10x deduction');
const duplicateResult = port.applyAdminSubstitution({
  operationId: 'SUB-1', sourceProductKey: 'C:P1', targetProductKey: 'C:P2', customer: '고객A', warehouse: '01',
  sourceSalesQuantity: 1, actualOutboundQuantity: 2,
});
assert.equal(duplicateResult.duplicate, true);
assert.equal(duplicateResult.operationId, 'SUB-1');

let validation = port.validate();
assert.equal(validation.ok, true, JSON.stringify(validation.issues));
const output = port.getOutputRows();
assert.ok(output.outbound.some((row) => row.구분 === '대체·소분' && row.확정방식 === 'ADMIN_CONFIRMED'));
assert.ok(output.outbound.some((row) => row.구분 === '대체·소분' && row.실제재고차감수량 === 2), 'only the administrator-entered actual deduction may reach output');
assert.ok(output.ledger.some((row) => row.수불유형 === '대체상품실제출고' && row.증감수량 === -2));
assert.ok(output.purchase.some((row) => row.품목코드 === 'P3' && row.발주필요수량 === 8), 'purchase need must subtract usable calculated stock from unshipped quantity');
assert.ok(output.warehouse.some((row) => row.창고 === '전체' && row.품목코드 === 'P2' && row.실사재고 === 0), 'explicit stocktake zero must stay numeric zero');
assert.ok(output.warehouse.some((row) => row.품목코드 === "'=FORMULA"), 'formula-like text must be escaped in Excel outputs');
const generatedWorkbook = port.createWorkbook();
assert.deepEqual(generatedWorkbook.SheetNames, ['출고현황', '발주현황', '재고수불부', '창고별재고', '대체소분이력', '상품관계']);
assert.ok(generatedWorkbook.Sheets['재고수불부']['!cols'][5].wch > 10, 'product name width must account for data, not only the short header');
const generatedBytes = WorkbookXLSX.write(generatedWorkbook, { type: 'buffer', bookType: 'xlsx', compression: true });
const reopenedWorkbook = WorkbookXLSX.read(generatedBytes, { type: 'buffer', cellNF: true, cellStyles: true });
assert.deepEqual(reopenedWorkbook.SheetNames, generatedWorkbook.SheetNames, 'serialized workbook must retain all separated outputs');
assert.equal(reopenedWorkbook.Sheets['출고현황']['!autofilter'].ref, generatedWorkbook.Sheets['출고현황']['!autofilter'].ref);

const historyBeforeUndo = port.snapshot().history.length;
port.undoLast();
productRows = port.getRows();
assert.equal(productRows.find((row) => row.code === 'P1').physicalOutbound, 5);
assert.equal(productRows.find((row) => row.code === 'P2').physicalOutbound, 0);
const undoSnapshot = port.snapshot();
assert.equal(undoSnapshot.substitutions.length, 1, 'undo must not delete the immutable substitution event');
assert.equal(undoSnapshot.cancellations.some((row) => row.targetActionId === 'SUB-1'), true);
assert.equal(undoSnapshot.history.length, historyBeforeUndo + 1, 'undo must append history');

port.injectSources({
  orders: { rows: [makeRow('orders', 'OZ', 'PZ', '0수량', 0, { customer: '고객' })] },
  opening: { rows: [makeRow('opening', 'IM', 'PM', '누락수량', null)] },
});
const zeroAndMissing = port.getRows();
assert.equal(zeroAndMissing.find((row) => row.code === 'PZ').orders, 0);
validation = port.validate();
assert.equal(validation.issues.some((issue) => issue.code === 'QUANTITY_MISSING' && issue.role === 'opening'), true);

console.log('OrderQ Lab parser, matching, immutable event, inventory, and output engine PASS');
