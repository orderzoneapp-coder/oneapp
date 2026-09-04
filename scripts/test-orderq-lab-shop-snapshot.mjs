#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const XLSX = require(path.join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'));
const html = fs.readFileSync(path.join(root, 'archive', 'OrderQ_Lab.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((source) => source.includes('OrderQLabTestPort'));
assert.ok(script, 'inline OrderQ Lab application script is required');

class FakeClassList { toggle() {} add() {} remove() {} contains() { return false; } }
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
    this.title = '';
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
const localStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
const document = {
  documentElement: { dataset: {} },
  querySelector: getElement,
  querySelectorAll: () => [],
  addEventListener() {},
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
  XLSX,
};
context.window = context;
vm.runInNewContext(script, context, { filename: 'OrderQ_Lab.inline.js' });
const port = context.OrderQLabTestPort;
const plain = (value) => JSON.parse(JSON.stringify(value));

const HEADERS = [
  '배송일자', '거래처명', '그룹', '주문상태', '전하실말씀', '상점메모', '상품코드', '상품명', '규격',
  '수량', '단가', '금액', '복사원코드', '주소', '전화2', '원코드', '유통그룹관리코드',
];
const shopRow = ({ date = '2026-09-04', customer, status, code, name = code, quantity = 1, group = '', message = '', memo = '', price = 1000, address = '경남 창원시', phone = '010-0000-0000' }) => [
  date, customer, group, status, message, memo, code, name, 'EA', quantity, price, Number(quantity || 0) * price,
  code, address, phone, String(code).slice(0, 6), `G-${customer}`,
];
const matrix = (rows) => [HEADERS, ...rows];
const parse = (rows, name = 'shop.xls') => port.parseShopMatrix(matrix(rows), name, 'Worksheet');
const date = '2026-09-04';

port.resetShopState();
const firstImport = parse([
  shopRow({ customer: '기준선A', status: '준비', code: 'A1' }),
  shopRow({ customer: '기준선A', status: '준비', code: 'A2', quantity: 2 }),
  shopRow({ customer: '신규B', status: '입금', code: 'B1' }),
  shopRow({ customer: '신규C', status: '주문', code: 'C1' }),
  shopRow({ customer: '초기취소', status: '취소', code: 'X1' }),
], '1차.xls');
let analysis = port.analyzeShopDate(firstImport, date);
assert.equal(analysis.round, 1);
assert.equal(analysis.baselineBlocks.length, 1, 'first prepared/completed block must be baseline-only');
assert.equal(analysis.newBlocks.length, 2, 'first order/payment blocks must be counted as new input');
assert.equal(analysis.newCancelledBlocks.length, 1, 'first-upload cancellation must remain evidence without becoming active work');
assert.equal(analysis.reviewIssues.length, 0);
port.commitShopAnalysis(analysis);
let working = port.getShopWorkingOrders();
assert.equal(working.length, 3);
assert.equal(working.filter((entry) => entry.baselineOnly).length, 1);
assert.equal(port.getShopOrderRows().length, 4);
assert.ok(port.getShopOrderRows().every((row) => row.documentNo === ''), 'a missing order number must stay blank');
assert.equal(port.snapshot().shopSnapshots[date].rows[0].sourceValues.address, '경남 창원시');
assert.equal(port.snapshot().shopSnapshots[date].rows[0].sourceRowNumber, 2);
assert.equal(port.snapshot().shopEvents[0].cancellationCount, 1);
assert.equal(port.snapshot().shopEvents[0].cancelledCandidates[0].customer, '초기취소');
assert.equal(port.snapshot().shopEvents[0].cancelledCandidates[0].workingOrderId, '');

const identicalImport = parse(firstImport.rows.map((row) => row.sourceCells), '완전동일2차.xls');
analysis = port.analyzeShopDate(identicalImport, date);
assert.equal(analysis.round, 2);
assert.equal(analysis.noChange, true, 'all normalized date rows including status must be equal for no-change');
assert.match(port.formatShopSummary(analysis), /변경 없음/);
port.commitShopAnalysis(analysis);
assert.throws(() => port.commitShopAnalysis(analysis), /SHOP_ANALYSIS_STALE/, 'the same analyzed turn cannot be committed twice');

const thirdRows = firstImport.rows.map((row) => row.sourceCells);
thirdRows.push(shopRow({ customer: '추가D', status: '입금', code: 'D1' }));
analysis = port.analyzeShopDate(parse(thirdRows, '신규추가3차.xls'), date);
assert.equal(analysis.round, 3);
assert.equal(analysis.newBlocks.length, 1);
assert.equal(analysis.newBlocks[0].customer, '추가D');
port.commitShopAnalysis(analysis);
assert.equal(port.getShopWorkingOrders().length, 4, 'new block must be entered once');

const statusRows = thirdRows.map((row) => [...row]);
statusRows[2][3] = '준비';
analysis = port.analyzeShopDate(parse(statusRows, '같은행수상태변경.xls'), date);
assert.equal(analysis.newBlocks.length, 0);
assert.equal(analysis.statusChanges.length, 1);
port.commitShopAnalysis(analysis);

const cancelledRows = statusRows.map((row) => [...row]);
cancelledRows[2][3] = '취소';
analysis = port.analyzeShopDate(parse(cancelledRows, '활성취소.xls'), date);
assert.equal(analysis.cancelledBlocks.length, 1);
port.commitShopAnalysis(analysis);
assert.equal(port.getShopWorkingOrders().find((entry) => entry.customer === '신규B').status, 'CANCELLED');

const reorderedRows = cancelledRows.map((row) => [...row]);
reorderedRows.push(shopRow({ customer: '신규B', status: '주문', code: 'B1' }));
analysis = port.analyzeShopDate(parse(reorderedRows, '취소재주문.xls'), date);
assert.equal(analysis.newBlocks.length, 1, 'active block after the cancelled occurrence must be a new reorder');
assert.equal(analysis.newBlocks[0].customer, '신규B');
port.commitShopAnalysis(analysis);
working = port.getShopWorkingOrders().filter((entry) => entry.customer === '신규B');
assert.equal(working.length, 2);
assert.deepEqual(working.map((entry) => entry.status).sort(), ['ACTIVE', 'CANCELLED']);

const separated = port.analyzeShopDate(parse([
  shopRow({ customer: '같은거래처', status: '주문', code: 'S1' }),
  shopRow({ customer: '사이거래처', status: '주문', code: 'M1' }),
  shopRow({ customer: '같은거래처', status: '주문', code: 'S2' }),
], '비연속.xls'), '2026-09-04', null);
assert.equal(separated.currentSnapshot.blocks.length, 3);
assert.equal(separated.currentSnapshot.blocks.filter((block) => block.customer === '같은거래처').length, 2, 'separated same-date/customer runs must not merge');

const beforeReview = plain(port.snapshot());
const changedRows = reorderedRows.map((row) => [...row]);
changedRows[0][9] = 9;
analysis = port.analyzeShopDate(parse(changedRows, '핵심값변경.xls'), date);
assert.ok(analysis.reviewIssues.some((issue) => issue.code === 'BLOCK_CONTENT_CHANGED'));
assert.throws(() => port.commitShopAnalysis(analysis), /SHOP_REVIEW_REQUIRED/);
assert.deepEqual(plain(port.snapshot()), beforeReview, 'review-required content change must not mutate state');

const missingRows = reorderedRows.filter((_, index) => index !== 3);
analysis = port.analyzeShopDate(parse(missingRows, '이전행소실.xls'), date);
assert.ok(analysis.reviewIssues.some((issue) => issue.code === 'PREVIOUS_BLOCK_MISSING'));
assert.throws(() => port.commitShopAnalysis(analysis), /SHOP_REVIEW_REQUIRED/);

const zeroRows = [...reorderedRows, shopRow({ customer: '0수량', status: '주문', code: 'Z1', quantity: 0 })];
analysis = port.analyzeShopDate(parse(zeroRows, '0수량.xls'), date);
assert.ok(analysis.reviewIssues.some((issue) => issue.code === 'ZERO_QUANTITY'));
assert.throws(() => port.commitShopAnalysis(analysis), /SHOP_REVIEW_REQUIRED/);

const validRows = [...reorderedRows, shopRow({ customer: '저장실패', status: '주문', code: 'R1' })];
analysis = port.analyzeShopDate(parse(validRows, '저장실패.xls'), date);
const beforeFailure = plain(port.snapshot());
const previousPayload = JSON.stringify({ ...beforeFailure, selectedKeys: [] });
const failingStorage = {
  value: previousPayload,
  failNext: true,
  getItem() { return this.value; },
  setItem(_key, value) { if (this.failNext) { this.failNext = false; throw new Error('QUOTA'); } this.value = String(value); },
  removeItem() { this.value = null; },
};
assert.throws(() => port.commitShopAnalysis(analysis, failingStorage), /SHOP_SNAPSHOT_COMMIT_FAILED/);
assert.equal(failingStorage.value, previousPayload, 'failed commit must restore the prior serialized workspace');
assert.deepEqual(plain(port.snapshot()), beforeFailure, 'failed commit must preserve the in-memory snapshot and working orders');

const actualPaths = [
  process.env.ORDERQ_LAB_SHOP_SMALL || path.join(process.env.USERPROFILE || '', 'Desktop', 'orderlist-260904.xls'),
  process.env.ORDERQ_LAB_SHOP_CUMULATIVE || path.join(process.env.USERPROFILE || '', 'Desktop', 'orderlist-260904 (분석).xls'),
];
if (actualPaths.every((file) => file && fs.existsSync(file))) {
  const readActual = (file) => {
    const workbook = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: false, cellText: true, cellNF: true });
    assert.ok(workbook.SheetNames.includes('Worksheet'));
    const sourceMatrix = XLSX.utils.sheet_to_json(workbook.Sheets.Worksheet, { header: 1, raw: false, defval: '', blankrows: true });
    const started = performance.now();
    const parsed = port.parseShopMatrix(sourceMatrix, path.basename(file), 'Worksheet');
    return { parsed, elapsedMs: performance.now() - started };
  };
  port.resetShopState();
  const small = readActual(actualPaths[0]);
  const cumulative = readActual(actualPaths[1]);
  assert.equal(small.parsed.sourceRowCount, 14);
  assert.equal(cumulative.parsed.sourceRowCount, 12301);
  const firstActual = port.analyzeShopDate(small.parsed, date);
  assert.equal(firstActual.currentSnapshot.selectedRowCount, 14);
  assert.equal(firstActual.currentSnapshot.blocks.length, 5);
  assert.equal(firstActual.newBlocks.length, 3);
  assert.equal(firstActual.baselineBlocks.length, 2);
  port.commitShopAnalysis(firstActual);
  const secondActual = port.analyzeShopDate(cumulative.parsed, date);
  assert.equal(secondActual.currentSnapshot.selectedRowCount, 14);
  assert.equal(secondActual.noChange, true, 'daily and cumulative files must compare by normalized date rows, not absolute row numbers');
  assert.ok(cumulative.elapsedMs < 5000, `12,301-row parse took ${cumulative.elapsedMs.toFixed(1)}ms`);
  console.log(`Actual shopping files PASS: 14 rows / 12,301 rows / cumulative parse ${cumulative.elapsedMs.toFixed(1)}ms`);
} else {
  console.log('Actual shopping files SKIP: set ORDERQ_LAB_SHOP_SMALL and ORDERQ_LAB_SHOP_CUMULATIVE to verify local XLS files');
}

console.log('OrderQ Lab shopping snapshot, diff, atomic rollback, and no-order-number contract PASS');
