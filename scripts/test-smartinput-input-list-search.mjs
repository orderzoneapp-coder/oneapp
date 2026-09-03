#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INPUT_LIST_SEARCH_ACTION,
  constrainInputListSelection,
  createInputListSearchState,
  filterInputListRows,
  inputListSelectionScopeRowIds,
  reduceInputListSearchState
} from '../smartinput/input-list-search.js';

const rows = [
  { rowId: 'CODE', itemCode: 'A125', itemName: '사과', specification: 'BOX', quantity: 0, memo: '' },
  { rowId: 'MEMO', itemCode: 'A126', itemName: '배', specification: 'EA', quantity: -2, memo: '반품 확인' },
  { rowId: 'DESCRIPTION', itemCode: 'A127', itemName: '감', specification: 'PACK', description: '직원 전달 메모' },
  { rowId: 'EMPTY', itemCode: '', itemName: '', specification: '', quantity: '', memo: '', description: '' },
  { rowId: 'NORMALIZED_EMPTY', itemCode: '', itemName: '', specification: '', quantity: null, unitPrice: null, noticePrice: 0, memo: '', description: '' }
];

assert.deepEqual(filterInputListRows(rows, '직원').map(row => row.rowId), ['DESCRIPTION'],
  'input-list search must include the employee description field');
assert.deepEqual(filterInputListRows(rows, '').map(row => row.rowId), ['CODE', 'MEMO', 'DESCRIPTION'],
  'input-list search must exclude raw and contract-normalized blank rows while preserving actual zero and negative rows');
assert.deepEqual(filterInputListRows(rows, '0').map(row => row.rowId), ['CODE'],
  'an explicitly entered numeric zero must remain searchable');
assert.deepEqual(filterInputListRows(rows, '-2').map(row => row.rowId), ['MEMO'],
  'an explicitly entered negative value must remain searchable');

const sourceRows = [
  { rowId: 'CODE', cells: ['A125', '사과', 'BOX', '0', ''] },
  { rowId: 'MEMO', cells: ['A126', '배', 'EA', '-2', '반품 확인'] },
  { rowId: 'DESCRIPTION', cells: ['A127', '감', 'PACK', '', '직원 전달 메모'] },
  { rowId: 'EMPTY', cells: ['', '', '', '', ''] }
];
for (const query of ['', 'A125', '직원', '0', '-2']) {
  const inputIds = filterInputListRows(rows, query, { sourceRows }).map(row => row.rowId);
  const sourceIds = sourceRows.filter(row => inputIds.includes(row.rowId)).map(row => row.rowId);
  assert.deepEqual(sourceIds, inputIds,
    `source and input table views must resolve the same row set for query ${query || '(blank)'}`);
}

const selectedBeforeSearch = new Set(['CODE', 'MEMO']);
const appleResults = filterInputListRows(rows, '사과', { sourceRows });
const searchScope = inputListSelectionScopeRowIds(rows, appleResults, { searchOpen: true });
assert.deepEqual(searchScope, ['CODE'],
  'search selection scope must contain only currently visible result row IDs');
assert.deepEqual(constrainInputListSelection(selectedBeforeSearch, searchScope), ['CODE'],
  'a query change must remove a previously selected row when that row becomes hidden');
assert.deepEqual(constrainInputListSelection(new Set(['CODE', 'MEMO']), searchScope), ['CODE'],
  'delete, price, and future bulk actions must resolve only the visible selected intersection');
assert.deepEqual(inputListSelectionScopeRowIds(rows, appleResults, { searchOpen: false }), rows.map(row => row.rowId),
  'closing search must preserve the existing whole-row selection scope without reviving pruned IDs');
assert.deepEqual(constrainInputListSelection(['CODE'], rows.map(row => row.rowId)), ['CODE'],
  'closing search must not revive a hidden selection that was already pruned');

const dataBefore = JSON.stringify({ rows, sourceRows, sourceMatrix: [['품목코드', '품명', '규격', '수량', '메모'], ...sourceRows.map(row => row.cells)], signature: 'POSITIONAL' });
let searchState = createInputListSearchState();
searchState = reduceInputListSearchState(searchState, { type: INPUT_LIST_SEARCH_ACTION.OPEN });
searchState = reduceInputListSearchState(searchState, { type: INPUT_LIST_SEARCH_ACTION.QUERY, query: '사과' });
assert.deepEqual(searchState, { open: true, query: '사과' });
searchState = reduceInputListSearchState(searchState, { type: INPUT_LIST_SEARCH_ACTION.CLOSE });
assert.deepEqual(searchState, { open: false, query: '' },
  'explicit close must atomically clear and hide the list filter');
searchState = reduceInputListSearchState({ open: true, query: '반품' }, { type: INPUT_LIST_SEARCH_ACTION.CONTEXT_CHANGE });
assert.deepEqual(searchState, { open: false, query: '' },
  'table-view and voucher-mode transitions must leave no hidden filter');
assert.equal(JSON.stringify({ rows, sourceRows, sourceMatrix: [['품목코드', '품명', '규격', '수량', '메모'], ...sourceRows.map(row => row.cells)], signature: 'POSITIONAL' }), dataBefore,
  'search state and filtering must not mutate rows, working rows, source evidence, or the positional signature');

const html = readFileSync(fileURLToPath(new URL('../smartinput/index.html', import.meta.url)), 'utf8');
const source = readFileSync(fileURLToPath(new URL('../smartinput/smartinput.js', import.meta.url)), 'utf8');

assert.match(html, /id="inputListSearchButton"[^>]*>입력목록 검색\(F3\)<\/button>/,
  'the table toolbar must expose the approved compact input-list search control');
assert.match(html, /id="inputListSearchPanel"[^>]*hidden/,
  'the input-list search field must be hidden during ordinary work');
assert.doesNotMatch(html, /<span class="field-name-cell">상품 검색<\/span>/,
  'the list filter must not be mislabeled as product master search');
assert.match(source, /event\.key === 'F3'/,
  'SmartInput must own F3 instead of leaving it to the browser');
assert.match(source, /function handleInputListSearchShortcut[\s\S]*event\.preventDefault\(\)/,
  'the F3 handler must suppress the browser shortcut');
assert.match(source, /field === 'itemCode'[\s\S]*trySearchProductRow\(row, input\.value/,
  'item-code Enter must continue to invoke product master search');
assert.match(source, /function selectedRowIdsForBulkAction\(\)[\s\S]*constrainInputListSelection/,
  'bulk actions must share the visible-selection intersection guard');
assert.match(source, /function applySelectedRowsUnitPrice\(\)[\s\S]*selectedRowIdsForBulkAction\(\)/,
  'bulk unit-price application must recheck the visible selection immediately before mutation');
assert.match(source, /function deleteSelectedMappingRows\(\)[\s\S]*selectedRowIdsForBulkAction\(\)/,
  'source and configured-input deletion must recheck the visible selection immediately before mutation');
assert.match(source, /id !== 'mappingSelectAllRows'[\s\S]*selectAllRowsInScope\(event\.target\.checked\)/,
  'source select-all must use the shared selection scope');
assert.match(source, /\$\('selectAllRows'\)\.addEventListener\('change'[\s\S]*selectAllRowsInScope\(event\.target\.checked\)/,
  'configured-input select-all must use the shared selection scope');

console.log('SmartInput F3 input-list search tests passed.');
