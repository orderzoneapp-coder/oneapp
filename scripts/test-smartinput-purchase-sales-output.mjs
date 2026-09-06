#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  buildPurchaseSalesUploadData,
  PURCHASE_SALES_UPLOAD_HEADERS
} from '../smartinput/purchase-sales-output.js';

const row = (customer, detailCustomer, code, quantity, extra = {}) => ({
  거래처: customer,
  거래처명: detailCustomer,
  코드: code,
  '품목명(규격)': `상품-${code || '없음'}`,
  수량: quantity,
  입고가: 3200,
  구매처: '기타구매',
  일자: '2026-09-05',
  적요: '정상',
  출고지시: '오전',
  전달사항: '전달',
  ...extra
});

const sourceRows = [
  row('1마산', '마산실거래', 'FRUIT-1', 2, { 청과: 5000, 도매A: 4500, 구매처: '우리농산' }),
  row('4연산', '연산실거래', 'FOOD-1', 1, { 식자재: 6000, 도매A: 5800 }),
  row('9부산', '부산실거래', 'WARE-1', 1, { '출고(외노)': 7000 }),
  row('3우리', '내부상세', 'INNER-1', -1, { 입고가: 3200, 구매처: '우리' }),
  row('미등록', '미등록상세', 'UNKNOWN-1', 1),
  row('4연산', '연산수량확인', 'ZERO-1', '', { 식자재: 6000 }),
  row('4연산', '연산형식오류', 'INVALID-1', '두개', { 식자재: 6000 }),
  row('', '', 'NO-CUSTOMER', 1, { 식자재: 6000 }),
  row('4연산', '연산코드없음', '', 1, { 식자재: 6000 }),
  { 거래처: '합계', 거래처명: '', 코드: '', '품목명(규격)': '합계', 수량: 99 },
  row('4연산', '역마진거래', 'REVERSE-1', 1, { 입고가: 5000, 식자재: 4000 }),
  row('9부산', '과대입력거래', 'OVER-1', 1, { 입고가: 1000, 도매A: 5000 })
];

const output = buildPurchaseSalesUploadData(sourceRows, { now: new Date('2026-09-07T12:00:00+09:00') });
assert.deepEqual(output.sheetNames, ['확인요청', '판매입력', '전송출고', '전송구매', '거래처별', '단가설정', '구매 업로드']);
assert.equal(output.fileName, '2전송_판매업로드_생성_20260907.xlsx');
assert.deepEqual(output.stats, { outputRows: 8, fatalErrors: 3, warnings: 4 });

for (const [sheetName, key] of [
  ['확인요청', 'check'], ['판매입력', 'sales'], ['전송출고', 'outbound'],
  ['전송구매', 'purchase'], ['거래처별', 'preview'], ['단가설정', 'settings'], ['구매 업로드', 'upload']
]) {
  assert.deepEqual(output.matrices[sheetName][0], PURCHASE_SALES_UPLOAD_HEADERS[key], `${sheetName} 열 계약이 달라졌습니다.`);
}

const salesRows = output.matrices['판매입력'].slice(1);
const salesByCode = Object.fromEntries(salesRows.map(values => [values[8], values]));
assert.equal(salesByCode['FRUIT-1'][12], 5000, '청과 고정가는 도매A/0.91보다 우선해야 합니다.');
assert.equal(salesByCode['FOOD-1'][12], 6000, '식자재 고정가를 우선 적용해야 합니다.');
assert.equal(salesByCode['WARE-1'][12], 7000, '창고출고는 도매A가 없을 때 출고(외노)를 적용해야 합니다.');
assert.equal(salesByCode['INNER-1'][3], '3우리');
assert.equal(salesByCode['INNER-1'][12], 3200);
assert.equal(salesByCode['INNER-1'][14], -3200, '음수 수량의 공급가액은 음수여야 합니다.');
assert.equal(salesByCode['UNKNOWN-1'][12], '', '단가그룹이 없으면 구매가를 판매가로 추정하면 안 됩니다.');
assert.deepEqual([salesByCode['ZERO-1'][11], salesByCode['ZERO-1'][12], salesByCode['ZERO-1'][14]], [0, 0, 0]);
assert.equal(salesByCode['INVALID-1'], undefined, '잘못된 수량 형식은 판매입력에서 제외해야 합니다.');

assert.equal(output.matrices['전송출고'].length - 1, 2);
assert.ok(output.matrices['전송출고'].slice(1).every(values => values[3] === '1전송' && values[4] === '40'));
assert.equal(output.matrices['전송구매'].length - 1, 1);
assert.deepEqual(output.matrices['전송구매'][1].slice(3, 5), ['3우리', '03']);
assert.deepEqual(output.matrices['전송구매'][1].slice(11, 15), [-1, 3200, '', -3200]);

const previewByCode = Object.fromEntries(output.matrices['거래처별'].slice(1).map(values => [values[3], values]));
assert.equal(previewByCode['FRUIT-1'][16], 900, '청과상장 수수료는 공급가액의 9% 반올림값이어야 합니다.');
assert.deepEqual(previewByCode['ZERO-1'].slice(5, 8), [0, 0, 0]);
assert.deepEqual(previewByCode['ZERO-1'].slice(14, 17), [0, 0, 0]);

const checkText = output.matrices['확인요청'].slice(1).map(values => values[5]).join('\n');
for (const expected of ['수량 형식 확인', '거래처명 없음', '품목코드 없음', '거래처 단가그룹 없음', '수량 없음/0', '역마진/입고가초과', '도매A과대의심']) {
  assert.match(checkText, new RegExp(expected));
}
assert.equal(output.matrices['단가설정'].some(values => values[0] === '1마산' && values[2] === '출고가(공지) > 청과 > 도매A/0.91 > 상장가'), true);
assert.equal(output.matrices['단가설정'].some(values => values[0] === '9부산' && values[2] === '출고가(공지) > 도매A > 출고(외노)'), true);

assert.deepEqual(PURCHASE_SALES_UPLOAD_HEADERS.upload, [
  '일자', '순번', '거래처코드', '거래처명', '입고창고', '거래유형', '전잔액', '전달사항',
  '코드', '품명', '규격(기본)', '수량', '단가', '외화금액', '공급가', '간단설명(품위)',
  '지시사항', '출고가 (공지)', '판매', 'no.'
]);
assert.equal(output.matrices['구매 업로드'].length - 1, 8, '업로드 가능한 원본 구매행만 구매 업로드에 포함해야 합니다.');
const uploadByCode = Object.fromEntries(output.matrices['구매 업로드'].slice(1).map(values => [values[8], values]));
assert.deepEqual(uploadByCode['FRUIT-1'].slice(0, 5), ['2026-09-05', '', '', '마산실거래', '']);
assert.deepEqual(uploadByCode['FRUIT-1'].slice(7, 13), ['전달', 'FRUIT-1', '상품-FRUIT-1', '마산실거래', 2, 3200]);
assert.equal(uploadByCode['FRUIT-1'][14], 6400, '공급가가 없으면 수량×입고가를 사용해야 합니다.');
assert.equal(uploadByCode['ZERO-1'][14], 0, '수량 공란은 구매 업로드 공급가 0을 보존해야 합니다.');
const sortedPurchaseOutput = buildPurchaseSalesUploadData([
  row('원본그룹', '나 거래처', 'N-2', 1),
  row('원본그룹', '가 거래처', 'C-10', 1),
  row('원본그룹', '가 거래처', 'C-2', 1)
]);
assert.deepEqual(sortedPurchaseOutput.matrices['구매 업로드'].slice(1).map(values => [values[3], values[8]]), [
  ['가 거래처', 'C-2'], ['가 거래처', 'C-10'], ['나 거래처', 'N-2']
], '구매 업로드는 거래처명 다음 코드 순으로 정렬해 거래처별 전표 행을 연속 배치해야 합니다.');
assert.deepEqual(sortedPurchaseOutput.matrices['판매입력'].slice(1).map(values => values[8]), ['C-10', 'C-2', 'N-2'],
  '기존 판매입력 정렬 계약은 유지해야 합니다.');

const purchaseFormOutput = buildPurchaseSalesUploadData([{
  일자: '2026-09-05', '일자-No.': '2026-09-05 -10', 거래처코드: '6151876286', 거래처명: '4연산',
  창고코드: '02', 코드: 'BUY-1', 품명: '구매상품', 규격: 'BOX', 수량: 2, 단가: 1000,
  합계: 1999, 적요: '원본공급가 보존'
}]);
assert.deepEqual(purchaseFormOutput.matrices['구매 업로드'][1], [
  '2026-09-05', '10', '6151876286', '4연산', '02', '', '', '원본공급가 보존',
  'BUY-1', '구매상품', 'BOX', 2, 1000, '', 1999, '', '', '', '', ''
], '구매현황 원본의 날짜·순번·거래처·창고·상품·공급가를 20열 업로드 양식에 보존해야 합니다.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xlsxSource = fs.readFileSync(path.join(root, 'customer-master/vendor/xlsx.full.min.js'), 'utf8');
const xlsxContext = vm.createContext({
  console, Date, Math, Number, String, Object, Array, Map, Set, Uint8Array, ArrayBuffer,
  setTimeout, clearTimeout
});
xlsxContext.window = xlsxContext;
xlsxContext.self = xlsxContext;
xlsxContext.globalThis = xlsxContext;
vm.runInContext(xlsxSource, xlsxContext, { filename: 'xlsx.full.min.js' });
const XLSX = xlsxContext.XLSX;
const workbook = XLSX.utils.book_new();
output.sheetNames.forEach(sheetName => {
  const worksheet = XLSX.utils.aoa_to_sheet(output.matrices[sheetName]);
  worksheet['!cols'] = output.widths[sheetName].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
});
const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
const reopened = XLSX.read(new Uint8Array(bytes), { type: 'array' });
assert.deepEqual(Array.from(reopened.SheetNames), output.sheetNames);
for (const [sheetName, key] of [
  ['확인요청', 'check'], ['판매입력', 'sales'], ['전송출고', 'outbound'],
  ['전송구매', 'purchase'], ['거래처별', 'preview'], ['단가설정', 'settings'], ['구매 업로드', 'upload']
]) {
  const worksheet = reopened.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '', blankrows: false });
  assert.deepEqual(Array.from(matrix[0]), PURCHASE_SALES_UPLOAD_HEADERS[key]);
  assert.equal(XLSX.utils.decode_range(worksheet['!ref']).e.c, PURCHASE_SALES_UPLOAD_HEADERS[key].length - 1,
    `${sheetName} 사용범위에 내부 후행 열이 남으면 안 됩니다.`);
}

const appSource = fs.readFileSync(path.join(root, 'smartinput/smartinput.js'), 'utf8');
assert.match(appSource, /activeMode === 'purchase'\) return exportPurchaseSalesExcel\(\)/,
  '구매전표 보고서는 DataOps 판매업로드 생성기로 분기해야 합니다.');
assert.match(appSource, /session\.sourceMatrix/, '구매전표 보고서는 보존된 원본 매핑 행을 사용해야 합니다.');
assert.match(appSource, /output\.sheetNames\.forEach/, '정해진 7개 시트를 순서대로 생성해야 합니다.');

if (process.env.SMARTINPUT_PURCHASE_SOURCE) {
  const sourceWorkbook = XLSX.read(new Uint8Array(fs.readFileSync(process.env.SMARTINPUT_PURCHASE_SOURCE)), { type: 'array' });
  const sourceSheet = sourceWorkbook.Sheets[sourceWorkbook.SheetNames[0]];
  const sourceMatrix = XLSX.utils.sheet_to_json(sourceSheet, { header: 1, raw: true, defval: '', blankrows: false });
  const headerIndex = sourceMatrix.findIndex(values => values.some(value => ['코드', '품목코드'].includes(String(value).trim()))
    && values.some(value => String(value).trim() === '수량'));
  assert.ok(headerIndex >= 0, '실데이터에서 품목코드·수량 헤더를 찾아야 합니다.');
  const headers = sourceMatrix[headerIndex].map(value => String(value).trim());
  const actualRows = sourceMatrix.slice(headerIndex + 1).map(values => Object.fromEntries(headers.map((header, index) => [header || `열${index + 1}`, values[index] ?? ''])));
  const actualOutput = buildPurchaseSalesUploadData(actualRows, { now: new Date('2026-09-07T12:00:00+09:00') });
  assert.equal(actualOutput.sheetNames.at(-1), '구매 업로드');
  assert.equal(actualOutput.matrices['구매 업로드'][0].length, 20);
  assert.ok(actualOutput.matrices['구매 업로드'].length > 1, '실데이터 구매 업로드에 데이터행이 있어야 합니다.');
  console.log(JSON.stringify({
    source: process.env.SMARTINPUT_PURCHASE_SOURCE,
    sourceRows: actualRows.length,
    reportSheets: actualOutput.sheetNames,
    reportStats: actualOutput.stats,
    purchaseUploadRows: actualOutput.matrices['구매 업로드'].length - 1
  }));
}

console.log('SmartInput 구매전표 DataOps 판매업로드 7시트 및 XLSX 재열기 검증이 통과했습니다.');
