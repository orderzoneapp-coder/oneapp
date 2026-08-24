#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStructuredSheet } from '../smartinput/structured-sheet-parser.js';
import {
  buildMinimumUploadMatrix,
  buildOrderGroupPayload,
  decorateStructuredRows,
  filterVoucherRows,
  groupVoucherRows,
  normalizeStage1Row,
  structuredFieldsForMode,
  summarizeVoucherGroups
} from '../smartinput/multivoucher-stage1.js';

const contractSource = fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

const matrix = [
  ['구매처명', '구매일자', '입고창고코드', '구매전표번호', '품목코드', '품목명', '수량', '단위', '입고가', '메모'],
  ['남경', '2026-08-24', '01', 'P-1', '105032110', '취나물', '0', 'BOX', '15000', '영수증'],
  ['남경', '2026-08-24', '01', 'P-1', '105038110', '비름', '-2', 'BOX', '27000', ''],
  [],
  ['남경', '2026-08-24', '01', 'P-2', '105040110', '방풍', '3', 'EA', '1000', '']
];

const parsed = parseStructuredSheet(matrix, {
  fieldDefinitions: structuredFieldsForMode('purchase', contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.equal(parsed.structured, true);
assert.equal(parsed.rows.length, 3);
assert.equal(parsed.rows[0].rowCustomerName, '남경');
assert.equal(parsed.rows[0].rowVoucherDate, '2026-08-24');
assert.equal(parsed.rows[0].rowWarehouseCode, '01');
assert.equal(parsed.rows[0].rowVoucherNo, 'P-1');
assert.equal(parsed.rows[0].unitPrice, 15000);
assert.equal(parsed.rows[0].quantity, 0, '숫자 0은 공란과 구분해야 한다.');
assert.equal(parsed.rows[1].quantity, -2, '음수 수량의 부호를 보존해야 한다.');
assert.equal(parsed.rows[2].sourceVoucherIndex, 2, '빈 행 경계 후의 전표는 별도 순번을 가져야 한다.');

const rows = decorateStructuredRows(parsed.rows, {
  sourceBatchId: 'BATCH-1',
  sourceSheetName: '구매',
  sourceFingerprint: 'HASH-1'
});
assert.equal(rows[0].rawQuantity, 0);
assert.equal(rows[0].baseQuantity, 0);
assert.equal(rows[1].rawQuantity, -2);
assert.equal(rows[1].baseQuantity, -2);
assert.equal(rows[1].unitConversionSource, 'SAME_UNIT');
assert.equal(rows[2].sourceDocumentKey, '구매:2');

const groups = groupVoucherRows('purchase', rows, {});
assert.equal(groups.length, 2, '원본 전표 순번과 외부전표번호가 다르면 분리해야 한다.');
assert.equal(groups[0].supplierCustomerName, '남경');
assert.equal(groups[0].rows.length, 2);
assert.equal(groups[0].validationStatus, 'READY');
assert.match(groups[0].idempotencyKey, /HASH-1/);
assert.match(groups[0].idempotencyKey, /BATCH-1/);
assert.match(groups[0].idempotencyKey, /PURCHASE/);

const manualGroups = groupVoucherRows('purchase', [
  { ...rows[0], manualSplitKey: 'A', rowVoucherNo: '' },
  { ...rows[0], rowId: 'ROW-2', manualSplitKey: 'B', rowVoucherNo: '' }
]);
assert.equal(manualGroups.length, 2, '수동 분리키는 같은 일자·거래처도 별도 전표로 분리해야 한다.');

const unresolvedUnit = normalizeStage1Row({ quantity: 1, unit: 'BOX', baseUnit: 'EA' });
assert.equal(unresolvedUnit.baseQuantity, null);
assert.equal(unresolvedUnit.unitConversionStatus, 'REVIEW_REQUIRED');
const converted = normalizeStage1Row({ quantity: -2, unit: 'BOX', baseUnit: 'EA', unitConversionFactor: 10 });
assert.equal(converted.baseQuantity, -20);

const summary = summarizeVoucherGroups(groups);
assert.deepEqual(
  { customerCount: summary.customerCount, voucherCount: summary.voucherCount, rowCount: summary.rowCount },
  { customerCount: 1, voucherCount: 2, rowCount: 3 }
);
assert.equal(filterVoucherRows(rows, '남경 비름').length, 1);
assert.equal(filterVoucherRows(rows, '105040110').length, 1);
assert.equal(filterVoucherRows(rows, 'P-1').length, 2);
assert.equal(filterVoucherRows(rows, '').length, 3);

assert.deepEqual(buildMinimumUploadMatrix('order')[0], [
  '거래처명', '배송일자', '품목코드', '품목명', '규격', '수량', '단위', '단가', '메모'
]);
assert.deepEqual(buildMinimumUploadMatrix('purchase')[0], [
  '구매처명', '구매일자', '품목코드', '품목명', '규격', '수량', '단위', '입고가', '메모'
]);
assert.deepEqual(buildMinimumUploadMatrix('sale')[0], [
  '판매처명', '판매일자', '품목코드', '품목명', '규격', '수량', '단위', '판매가', '메모'
]);

const orderRows = decorateStructuredRows([
  { rowCustomerName: '남경', rowVoucherDate: '2026-08-24', rowDeliveryDate: '2026-08-25', rowWarehouseCode: '02', itemCode: 'A', itemName: '상품A', quantity: -1, unit: 'EA', unitPrice: 2000, sourceVoucherIndex: 1 }
], { sourceBatchId: 'B', sourceDocumentKey: 'DOC', sourceFingerprint: 'ORDER-HASH' });
const orderGroup = groupVoucherRows('order', orderRows)[0];
const payload = buildOrderGroupPayload(orderGroup, { orderDate: '2026-08-24' });
assert.equal(payload.sourceDocumentKey, orderGroup.idempotencyKey);
assert.equal(payload.items[0].rawQuantity, -1);
assert.equal(payload.items[0].finalQuantity, -1);
assert.equal(payload.items[0].supplyAmount, -2000);

console.log('SmartInput multi-voucher stage 1 PASS');
