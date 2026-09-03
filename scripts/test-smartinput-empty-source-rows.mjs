#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  buildGridPastePlan,
  parseClipboardMatrix
} from '../smartinput/grid-clipboard.js';
import {
  DECISION,
  createMappingSession,
  createTemplateRecord,
  projectMappedRows,
  setColumnDecision
} from '../smartinput/input-template-mapper.js';
import { parseStructuredSheet } from '../smartinput/structured-sheet-parser.js';
import { readWorksheetSource } from '../smartinput/xlsx-source-reader.js';
import '../smartinput/smartinput-contract.js';

const contract = globalThis.SMART_INPUT_CONTRACT;

const targets = [
  { id: 'itemCode', label: '품목코드', scope: 'voucher', valueType: 'TEXT' },
  { id: 'itemName', label: '품목명', scope: 'voucher', valueType: 'TEXT' },
  { id: 'quantity', label: '수량', scope: 'voucher', valueType: 'NUMBER' },
  { id: 'memo', label: '메모', scope: 'voucher', valueType: 'TEXT' }
];

const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
};

function confirmRecommendations(session) {
  return session.mappings.reduce((current, mapping) => mapping.state === DECISION.RECOMMENDED
    ? setColumnDecision(current, mapping.columnIndex, DECISION.MAPPED, mapping.targetFieldId, targets)
    : current, session);
}

const clipboardText = [
  '품목코드\t품목명\t수량\t메모',
  '001\t사과\t0\t',
  '\t\t\t',
  ' \t\u00a0\t\u200b\t',
  '\t\t-2\t검증 유지',
  '002\t\t\t빈 수량',
  '003\t제로폭 수량\t\u200b\t확인',
  '\t\t\t',
  '',
  ''
].join('\r\n');

const clipboardMatrix = parseClipboardMatrix(clipboardText);
const clipboardPlan = buildGridPastePlan(clipboardText, {
  fieldDefinitions: targets,
  visibleFieldIds: targets.map(field => field.id),
  startFieldId: 'itemCode',
  numberParser: numberOrNull,
  requireHeaders: true
});

assert.equal(clipboardPlan.valid, true,
  'short physical widths in completely blank trailing rows must not invalidate an otherwise exact header paste');
assert.equal(clipboardPlan.rows.length, 4,
  'clipboard import must omit only completely blank and invisible-whitespace-only source rows');
assert.deepEqual(clipboardPlan.rows.map(row => row.cells.map(cell => cell.value)), [
  ['001', '사과', 0, ''],
  ['', '', -2, '검증 유지'],
  ['002', '', null, '빈 수량'],
  ['003', '제로폭 수량', null, '확인']
], 'meaningful rows must preserve blank-cell positions, explicit zero, negative values, and blank numeric values');

const draftSession = createMappingSession({ matrix: clipboardMatrix, targetDefinitions: targets });
const template = createTemplateRecord(confirmRecommendations(draftSession), '빈 행 회귀 양식', targets);
const mappedSession = createMappingSession({ matrix: clipboardMatrix, templates: [template], targetDefinitions: targets });
const mappedRows = projectMappedRows(mappedSession, targets);

assert.deepEqual(mappedSession.sourceMatrix, clipboardMatrix,
  'filtering working rows must not rewrite the immutable source matrix or its positional signature');
assert.equal(mappedSession.workingRows.length, 4,
  'mapping worktable must not materialize whitespace-only source rows');
assert.deepEqual(mappedSession.workingRows.map(row => row.cells), [
  ['001', '사과', '0', ''],
  ['', '', '-2', '검증 유지'],
  ['002', '', '', '빈 수량'],
  ['003', '제로폭 수량', '\u200b', '확인']
], 'mapping worktable cells must stay in their original columns');
assert.deepEqual(mappedRows.map(row => row.quantity), [0, -2, null, null],
  'projection must distinguish explicit zero, negative values, and blank numeric cells');
assert.equal(mappedRows[1].itemCode, '');
assert.equal(mappedRows[1].itemName, '');
assert.equal(mappedRows[1].memo, '검증 유지',
  'a meaningful identity-missing row must survive for the existing voucher validator');
const validationErrors = contract.validateOrderDraft({
  header: { customerId: 'CUSTOMER-1', customerName: '테스트 거래처', orderDate: '2026-09-03', warehouseName: '기본창고' },
  rows: mappedRows
});
assert.equal(validationErrors.some(error => error.field === 'row:1:item'), true,
  'existing required-item validation must still report a meaningful row whose code and name are blank');

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const xlsx = {
  utils: {
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 7, c: 3 } }),
    encode_cell: ({ r, c }) => `${letters[c]}${r + 1}`,
    format_cell: cell => String(cell.w ?? cell.v ?? '')
  }
};
const worksheet = {
  '!ref': 'A1:D8',
  A1: { t: 's', v: '품목코드' }, B1: { t: 's', v: '품목명' }, C1: { t: 's', v: '수량' }, D1: { t: 's', v: '메모' },
  A2: { t: 's', v: '001' }, B2: { t: 's', v: '사과' }, C2: { t: 'n', v: 0, w: '0' },
  A4: { t: 's', v: ' ' }, B4: { t: 's', v: '\u00a0' }, C4: { t: 's', v: '\u200b' }, D4: { t: 's', v: '\t\n' },
  C5: { t: 'n', v: -2, w: '-2' }, D5: { t: 's', v: '검증 유지' },
  A6: { t: 's', v: '002' }, D6: { t: 's', v: '빈 수량' }
};
const worksheetSource = readWorksheetSource(xlsx, worksheet);
const workbookSession = createMappingSession({
  matrix: worksheetSource.displayMatrix,
  sourceCellMatrix: worksheetSource.sourceCellMatrix,
  templates: [template],
  targetDefinitions: targets
});
const workbookRows = projectMappedRows(workbookSession, targets);

assert.equal(worksheetSource.displayMatrix.length, 8,
  'Excel reader must preserve the original used-range rows as evidence');
assert.equal(worksheetSource.displayMatrix[1][3], '',
  'Excel reader must preserve an internal blank cell at its original column');
assert.equal(worksheetSource.displayMatrix[1][2], '0',
  'Excel reader must preserve an explicitly entered numeric zero');
assert.equal(workbookSession.workingRows.length, 3,
  'Excel used-range blank, whitespace-only, and trailing rows must not create working rows');
assert.deepEqual(workbookRows.map(row => row.quantity), [0, -2, null]);

const structured = parseStructuredSheet(clipboardMatrix, {
  fieldDefinitions: targets,
  numberParser: numberOrNull,
  sheetName: '견적서'
});
assert.equal(structured.structured, true);
assert.equal(structured.rows.length, 4,
  'structured intake must ignore blank rows but retain meaningful rows that require item validation');
assert.deepEqual(structured.rows.map(row => [row.itemCode, row.itemName, row.quantity, row.memo]), [
  ['001', '사과', 0, ''],
  ['', '', -2, '검증 유지'],
  ['002', '', null, '빈 수량'],
  ['003', '제로폭 수량', null, '확인']
]);

console.log('SmartInput empty source-row regression tests passed.');
