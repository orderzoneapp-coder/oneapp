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
assert.ok(html.indexOf('data-column="productSearch"') < html.indexOf('data-column="itemCode"'), 'product search must be the first editable grid column');
assert.match(html, /id="undoGridPasteButton"/);
assert.match(app, /th\.classList\.add\('column-resizable'\);[\s\S]*?const reorderable = !\['productSearch', 'status'\]\.includes\(columnKey\);[\s\S]*?if \(reorderable && !th\.querySelector\('\.column-drag-handle'\)\)/,
  'the fixed product-search column must remain resizable while reorder uses a dedicated handle only for reorderable columns');
assert.match(app, /handle\.className = 'column-resize-handle'/);
assert.match(app, /dragHandle\.className = 'column-drag-handle'/);
assert.match(app, /if \(searchInput\) \{[\s\S]*?preventDefault\(\)[\s\S]*?상품 검색 열에는 붙여넣을 수 없습니다/);
assert.match(app, /requireHeaders:\s*true/);
assert.match(app, /trySearchProductRow[\s\S]*?applyProduct\(row, candidates\[0\], \{ forceIdentityFields: true \}\)/);

console.log('SmartInput Excel grid clipboard tests passed.');
