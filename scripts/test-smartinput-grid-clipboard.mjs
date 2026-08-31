#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildGridPastePlan,
  parseClipboardMatrix
} from '../smartinput/grid-clipboard.js';
import '../smartinput/smartinput-contract.js';

const contract = globalThis.SMART_INPUT_CONTRACT;
const fields = contract.PRODUCT_FIELD_DEFINITIONS;
const visible = ['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'memo'];

assert.deepEqual(
  parseClipboardMatrix('001\t"취나물\t4kg"\r\n002\t"메모 ""확인"""\r\n'),
  [['001', '취나물\t4kg'], ['002', '메모 "확인"']],
  'Excel TSV quoting and final CRLF must parse without creating an extra row'
);

const positional = buildGridPastePlan('001\t취나물\t4kg\t2\tBOX\t15,000\r\n002\t비름\t\t0\tBOX\t27,000', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'itemCode',
  numberParser: contract.numberOrNull
});
assert.equal(positional.kind, 'POSITIONAL');
assert.equal(positional.rows.length, 2);
assert.deepEqual(positional.rows[0].cells.map(cell => cell.value), ['001', '취나물', '4kg', 2, 'BOX', 15000]);
assert.equal(positional.rows[1].cells[2].value, '', 'blank text cells must remain blank');
assert.equal(positional.rows[1].cells[3].value, 0, 'numeric zero must remain zero');

const offset = buildGridPastePlan('3\t18,000\r\n4\t21,000', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'quantity',
  numberParser: contract.numberOrNull
});
assert.deepEqual(offset.rows[0].cells, [
  { fieldId: 'quantity', value: 3 },
  { fieldId: 'unit', value: '18,000' }
]);

const header = buildGridPastePlan('품목명\t단가\t품목코드코드\t지시사항\r\n취나물\t15,000\t001\t오전 출고', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'quantity',
  numberParser: contract.numberOrNull,
  requireHeaders: true
});
assert.equal(header.kind, 'HEADER');
assert.equal(header.valid, true);
assert.equal(header.rows.length, 1, 'the field-name row must validate mappings but never become an input row');
assert.deepEqual(header.fieldIds, ['itemName', 'unitPrice', 'itemCode', 'memo']);
assert.deepEqual(Object.fromEntries(header.rows[0].cells.map(cell => [cell.fieldId, cell.value])), {
  itemName: '취나물',
  unitPrice: 15000,
  itemCode: '001',
  memo: '오전 출고'
});

const providedEstimate = buildGridPastePlan(
  '품목코드코드\t품목명\tA판매\tB판매\t단가\t지시사항\r\n105032110\t취나물 (4kg)\t18,000\t\t15,000\t오전 출고',
  {
    fieldDefinitions: fields,
    visibleFieldIds: visible,
    startFieldId: 'itemCode',
    numberParser: contract.numberOrNull,
    requireHeaders: true
  }
);
assert.equal(providedEstimate.valid, true, 'the provided estimate headers must map through shared field aliases');
assert.equal(providedEstimate.rows.length, 1, 'the provided field-name row must not become product data');
assert.deepEqual(Object.fromEntries(providedEstimate.rows[0].cells.map(cell => [cell.fieldId, cell.value])), {
  itemCode: '105032110',
  itemName: '취나물 (4kg)',
  wholesaleA: 18000,
  wholesaleB: null,
  unitPrice: 15000,
  memo: '오전 출고'
});

const reorderedEstimate = buildGridPastePlan(
  '품목코드\t품목명\tA판매\tB판매\t메모\t단가\t입고B\t행사가\r\n104526112\t케일_2kg\t21,500\t19,500\t\t18,500\t16,500.00\t',
  {
    fieldDefinitions: fields,
    visibleFieldIds: ['itemCode', 'itemName', 'unitPrice', 'purchasePriceB', 'wholesaleA', 'wholesaleB', 'memo', 'promoPrice'],
    startFieldId: 'itemCode',
    numberParser: contract.numberOrNull,
    requireHeaders: true
  }
);
assert.equal(reorderedEstimate.valid, true, 'display-order changes must still map by the restored field-name and alias contract');
assert.deepEqual(reorderedEstimate.fieldIds, ['itemCode', 'itemName', 'wholesaleA', 'wholesaleB', 'memo', 'unitPrice', 'purchasePriceB', 'promoPrice']);
assert.deepEqual(Object.fromEntries(reorderedEstimate.rows[0].cells.map(cell => [cell.fieldId, cell.value])), {
  itemCode: '104526112',
  itemName: '케일_2kg',
  wholesaleA: 21500,
  wholesaleB: 19500,
  memo: '',
  unitPrice: 18500,
  purchasePriceB: 16500,
  promoPrice: null
});

const invalid = buildGridPastePlan('품목코드\t품목명\t단가\r\n001\t취나물\t확인', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'itemCode',
  numberParser: contract.numberOrNull,
  requireHeaders: true
});
assert.equal(invalid.invalidCells.length, 1);
assert.equal(invalid.invalidCells[0].fieldId, 'unitPrice');

const missingHeaders = buildGridPastePlan('001\t취나물\t15,000', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'itemCode',
  numberParser: contract.numberOrNull,
  requireHeaders: true
});
assert.equal(missingHeaders.valid, false, 'value-only clipboard ranges must be rejected');
assert.equal(missingHeaders.rows.length, 0);

const mismatchedHeaders = buildGridPastePlan('품목코드\t상품이름오타\t단가\r\n001\t취나물\t15,000', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'itemCode',
  numberParser: contract.numberOrNull,
  requireHeaders: true
});
assert.equal(mismatchedHeaders.valid, false);
assert.equal(mismatchedHeaders.headerErrors[0].reason, 'UNKNOWN_HEADER');

const duplicateHeaders = buildGridPastePlan('품목코드\t상품코드\r\n001\t002', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'itemCode',
  numberParser: contract.numberOrNull,
  requireHeaders: true
});
assert.equal(duplicateHeaders.valid, false);
assert.equal(duplicateHeaders.headerErrors[0].reason, 'DUPLICATE_FIELD');

const unevenRows = buildGridPastePlan('품목코드\t품목명\t단가\r\n001\t취나물', {
  fieldDefinitions: fields,
  visibleFieldIds: visible,
  startFieldId: 'itemCode',
  numberParser: contract.numberOrNull,
  requireHeaders: true
});
assert.equal(unevenRows.valid, false);
assert.equal(unevenRows.rowErrors[0].reason, 'COLUMN_COUNT_MISMATCH');

const html = fs.readFileSync('smartinput/index.html', 'utf8');
const app = fs.readFileSync('smartinput/smartinput.js', 'utf8');
for (const label of ['품목코드', '품목명', '규격', '수량', '단위', '단가', '메모']) assert.match(html, new RegExp(label));
assert.match(html, /id="inputRows"/);
assert.match(html, /id="sourceFileButton"[^>]*data-method="excel"[^>]*>[^<]*<span[^>]*>＋<\/span> Excel 파일<\/button>/,
  'the source input view must expose the existing file input through a visible Excel file button');
assert.match(app, /function applyGridPaste\(rawText, startRowId, startFieldId\)/);
assert.doesNotMatch(app, /mappingHeadersMatch\(incomingMatrix, expectedHeaders\)/,
  'direct worktable paste must not reject a valid field-name mapping only because the display order differs');
assert.match(app, /return useClipboardTableAsSource\(rawText, \{ sourceName: '작업테이블 붙여넣기' \}\)/,
  'unknown or invalid worktable headers must preserve the raw matrix in the source mapping workflow');
assert.match(app, /parserCard\.contains\(event\.target\) && clipboardTableMatrix\(pastedText\)/,
  'a structured clipboard text representation must take priority over a simultaneous image representation');
assert.match(app, /inputRows\.addEventListener\('paste'/);
assert.match(app, /contract\.markProductEdit\(row, cell\.fieldId, cell\.value\)/,
  'grid paste must use the same restored work-row edit contract as direct cell edits');

console.log('SmartInput Excel grid clipboard tests passed.');
