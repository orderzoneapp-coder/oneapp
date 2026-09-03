#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TABLE_VIEW_MODE,
  createTableViewPreferences,
  inputViewColumns,
  resetTableViewForSource,
  selectTableView,
  sourceViewColumns,
  tableViewFor
} from '../smartinput/table-view-state.js';

const modes = ['order', 'purchase', 'sale', 'estimate'];
const preferences = createTableViewPreferences(modes);
assert.equal(tableViewFor(preferences, 'order', true), TABLE_VIEW_MODE.SOURCE,
  'a source-backed work session must open in source-column view');
assert.equal(tableViewFor(preferences, 'order', false), TABLE_VIEW_MODE.INPUT,
  'a work session without source evidence must keep the normal input table');

const sourceSession = {
  headers: ['원본 메모', '품목코드', '수량', '미매핑 원문'],
  mappings: [
    { columnIndex: 0, state: 'MAPPED', targetFieldId: 'memo' },
    { columnIndex: 1, state: 'MAPPED', targetFieldId: 'itemCode' },
    { columnIndex: 2, state: 'MAPPED', targetFieldId: 'quantity' },
    { columnIndex: 3, state: 'UNMAPPED', targetFieldId: '' }
  ],
  sourceMatrix: [
    ['원본 메모', '품목코드', '수량', '미매핑 원문'],
    ['', '00125', '0', '증적 보존'],
    ['반품', '00126', '-2', '']
  ],
  sourceCellMatrix: [[{}, {}, {}, {}], [{}, {}, {}, {}], [{}, {}, {}, {}]],
  signature: 'POSITIONAL-SIGNATURE',
  workingRows: [
    { rowId: 'source-1', cells: ['', '00125', '0', '증적 보존'] },
    { rowId: 'source-2', cells: ['반품', '00126', '-2', ''] }
  ]
};
const voucherRows = [
  { rowId: 'source-1', itemCode: '00125', quantity: 0, memo: '' },
  { rowId: 'source-2', itemCode: '00126', quantity: -2, memo: '반품' }
];
const savePayload = JSON.stringify({ rows: voucherRows, inputMapping: sourceSession });
const dataBefore = JSON.stringify({ sourceSession, voucherRows, savePayload });

const sourceColumns = sourceViewColumns(sourceSession);
assert.deepEqual(sourceColumns.map(column => column.label), sourceSession.headers,
  'source view must retain the exact original header strings and order');
assert.deepEqual(sourceColumns.map(column => column.mappingState), ['MAPPED', 'MAPPED', 'MAPPED', 'UNMAPPED'],
  'source view must distinguish mapped and unmapped columns without relocating values');

const inputDefinitions = [
  { id: 'itemCode', label: '품목코드' },
  { id: 'quantity', label: '수량' },
  { id: 'memo', label: '메모' }
];
assert.deepEqual(
  inputViewColumns(['itemCode', 'quantity', 'memo'], inputDefinitions).map(column => column.label),
  ['품목코드', '수량', '메모'],
  'input view must follow the configured SmartInput field order instead of source order'
);

const inputSelected = selectTableView(preferences, 'order', TABLE_VIEW_MODE.INPUT, { hasSource: true });
assert.equal(tableViewFor(inputSelected, 'order', true), TABLE_VIEW_MODE.INPUT,
  'an explicit input-view selection must survive ordinary rerenders in the session');
assert.equal(JSON.stringify({ sourceSession, voucherRows, savePayload }), dataBefore,
  'view selection must not mutate working rows, mappings, source evidence, signature, or save payload');

const sourceSelectedAgain = selectTableView(inputSelected, 'order', TABLE_VIEW_MODE.SOURCE, { hasSource: true });
assert.equal(tableViewFor(sourceSelectedAgain, 'order', true), TABLE_VIEW_MODE.SOURCE);
assert.equal(JSON.stringify({ sourceSession, voucherRows, savePayload }), dataBefore,
  'round-trip table switching must be data-neutral');

const resetForNewSource = resetTableViewForSource(inputSelected, 'order');
assert.equal(tableViewFor(resetForNewSource, 'order', true), TABLE_VIEW_MODE.SOURCE,
  'a newly analyzed or reopened source must explicitly reset to source view');
assert.equal(tableViewFor(inputSelected, 'purchase', true), TABLE_VIEW_MODE.SOURCE,
  'view choices must remain isolated per voucher mode');

assert.equal(sourceSession.sourceMatrix[1][0], '', 'an intermediate blank cell must remain present');
assert.equal(sourceSession.workingRows[0].cells[2], '0', 'numeric zero must remain present');
assert.equal(sourceSession.workingRows[1].cells[2], '-2', 'negative values must remain present');

const html = readFileSync(fileURLToPath(new URL('../smartinput/index.html', import.meta.url)), 'utf8');
const source = readFileSync(fileURLToPath(new URL('../smartinput/smartinput.js', import.meta.url)), 'utf8');
assert.match(html, /id="tableViewSwitch"/,
  'the existing table toolbar must expose one compact source/input switch');
assert.match(html, /data-table-view="source"[\s\S]*data-table-view="input"/,
  'source and input choices must be explicit keyboard-focusable controls');
assert.match(source, /tableViewFor\(/,
  'SmartInput rendering must resolve the explicit session table-view choice');
assert.match(source, /resetTableViewForSource\(/,
  'new source intake and saved-estimate reopening must use the explicit source-view reset');

console.log('SmartInput source/input table-view toggle tests passed.');
