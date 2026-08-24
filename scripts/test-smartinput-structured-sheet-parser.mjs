#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  normalizeStructuredFieldName,
  parseStructuredSheet
} from '../smartinput/structured-sheet-parser.js';
import { buildEstimateF8Data } from '../smartinput/estimate-output.js';
import { decorateStructuredRows } from '../smartinput/multivoucher-stage1.js';

const contractSource = fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

assert.equal(normalizeStructuredFieldName('품목코드코드'), '품목코드');
assert.equal(normalizeStructuredFieldName('상품코드\n코드'), '상품코드');

const estimateMatrix = [
  ['견적서', '', '', '', '', ''],
  ['전표번호 : 2026/08/03 -5', '', '', '', '', ''],
  ['수신-거래처 : 남경', '', '', '', '', ''],
  ['출고창고 : 2전송', '', '', '', '', ''],
  ['견적금액합계 : 0', '', '', '', '', ''],
  ['품목코드코드', '품목명', 'A판매', 'B판매', '단가', '지시사항'],
  ['105016120', '한재미나리(200g)', '', '', '', ''],
  ['105032110', '취나물 (4kg)', '18,000', '', '15,000', ''],
  ['105032116', '부지겡이/취나물 (4kg)', '', '', '', ''],
  ['105032128', '곰취_2kg', '', '', '', ''],
  ['105034110', '곤달비', '', '', '', ''],
  ['105036110', '머위잎 (4kg)', '', '', '', ''],
  ['105038110', '비름_4kg', '30,000', '', '27,000', '가격 확인'],
  ['105040110', '방풍 (2kg)', '', '', '', ''],
  ['105040114', '갯방풍 (1kg)', '', '', '', ''],
  ['105046124', '고구마순/4키로', '', '', '', ''],
  ['105050110', '고추잎_2kg', '21,000', '', '18,000', ''],
  ['105054114', '달래(단) 1봉지', '', '', '', ''],
  ['105054120', '달래_바라_4kg', '', '', '', ''],
  ['105062110', '땅두릅_2kg', '', '', '', ''],
  ['105070110', '세발나물_4kg', '', '', '', ''],
  ['105078114', '완두콩_4kg', '', '', '', ''],
  ['105080110', '호박잎_150g단', '', '', '', ''],
  ['105080112', '호박잎_2kg', '', '', '', ''],
  ['2026/08/24 (월) 오전 9:25:08', '', '', '', '', '']
];

const parsedEstimate = parseStructuredSheet(estimateMatrix, {
  fieldDefinitions: Array.from(contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});

assert.equal(parsedEstimate.structured, true);
assert.equal(parsedEstimate.headerRowNumber, 6);
assert.deepEqual(parsedEstimate.mappings.map(mapping => mapping.fieldId), [
  'itemCode', 'itemName', 'wholesaleA', 'wholesaleB', 'unitPrice', 'memo'
]);
assert.equal(parsedEstimate.rows.length, 18, '출력시간은 상품행에서 제외해야 한다.');
assert.equal(parsedEstimate.rows[0].itemCode, '105016120');
assert.equal(parsedEstimate.rows[0].unitPrice, null, '원본 공란은 공란으로 유지해야 한다.');
assert.equal(parsedEstimate.rows[0].wholesaleB, null, '매칭된 가격 열의 공란을 마스터값으로 보정하면 안 된다.');
assert.equal(parsedEstimate.rows[0].editedFields.wholesaleB, true, '원본 공란도 해당 열의 명시값으로 보호해야 한다.');
assert.equal(parsedEstimate.rows[1].wholesaleA, 18000);
assert.equal(parsedEstimate.rows[1].unitPrice, 15000);
assert.equal(parsedEstimate.rows[6].memo, '가격 확인');
assert.equal(parsedEstimate.rows[6].editedFields.wholesaleA, true, '원본 가격은 마스터 보강으로 덮어쓰지 않아야 한다.');
assert.equal(parsedEstimate.invalidCells.length, 0);

const orderMatrix = [
  ['주문 메모', '', '', '', ''],
  ['거래처', '남경', '', '', ''],
  ['수량', '상품명', '상품코드', '메모', '단가'],
  ['2', '취나물 (4kg)', '105032110', '오전 배송', '15,000'],
  ['1', '비름_4kg', '105038110', '', '0']
];

const parsedOrder = parseStructuredSheet(orderMatrix, {
  fieldDefinitions: Array.from(contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.equal(parsedOrder.headerRowNumber, 3);
assert.equal(parsedOrder.rows.length, 2);
assert.equal(parsedOrder.rows[0].quantity, 2);
assert.equal(parsedOrder.rows[0].itemCode, '105032110');
assert.equal(parsedOrder.rows[0].memo, '오전 배송');
assert.equal(parsedOrder.rows[1].unitPrice, 0, '숫자 0은 공란으로 바꾸면 안 된다.');

const pricePreservationMatrix = [
  ['품목코드', '품목명', '단가'],
  ['BLANK', '공백 단가', ''],
  ['ZERO', '0 단가', '0'],
  ['NUMBER', '숫자 단가', '1,500'],
  ['TEXT', '문자 단가', '가격 확인']
];
const parsedPricePreservation = parseStructuredSheet(pricePreservationMatrix, {
  fieldDefinitions: Array.from(contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.deepEqual(parsedPricePreservation.rows.map(row => row.unitPrice), [null, 0, 1500, null]);
assert.deepEqual(parsedPricePreservation.rows.map(row => row.sourceUnitPrice), ['', '0', '1,500', '가격 확인']);
assert.equal(parsedPricePreservation.invalidCells.length, 1);
assert.equal(parsedPricePreservation.invalidCells[0].value, '가격 확인');
const priceBatch = contract.createBatch({ batchId: 'PRICE-BATCH', sequence: 1, method: 'excel', sourceType: 'STRUCTURED_FILE' });
const normalizedPriceRows = contract.applyParserResults([], priceBatch, decorateStructuredRows(
  parsedPricePreservation.rows.map((row, index) => ({ ...row, productId: `P-${index}`, masterProductId: `M-${index}` })),
  { sourceBatchId: priceBatch.batchId, sourceSheetName: '견적' }
));
assert.deepEqual(Array.from(normalizedPriceRows, row => row.unitPrice), [null, 0, 1500, null],
  '업무 단가는 기존 숫자/null 계약을 유지해야 한다.');
assert.deepEqual(Array.from(normalizedPriceRows, row => row.sourceUnitPrice), ['', '0', '1,500', '가격 확인'],
  'Excel 파서에서 견적 행 생성까지 단가 원본을 별도로 유지해야 한다.');
const priceOutput = buildEstimateF8Data(normalizedPriceRows);
assert.equal(priceOutput.ok, true);
assert.deepEqual(priceOutput.shopData.slice(1).map(row => row[4]), ['', 0, 1500, '가격 확인']);
assert.deepEqual(priceOutput.erpData.slice(1).map(row => row[7]), ['', '', '', '']);
assert.ok(priceOutput.errorData.some(row => row[0] === 1 && row[2] === '단가' && row[3] === ''));
assert.ok(priceOutput.errorData.some(row => row[0] === 4 && row[2] === '단가' && row[3] === '가격 확인'));

const notStructured = parseStructuredSheet([
  ['오늘 주문합니다'],
  ['취나물 2박스']
], {
  fieldDefinitions: Array.from(contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.equal(notStructured.structured, false, '필드 헤더가 없는 일반 텍스트는 기존 파서로 넘겨야 한다.');

console.log('SmartInput structured sheet parser tests passed.');
