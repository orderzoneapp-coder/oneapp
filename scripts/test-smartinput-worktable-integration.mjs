#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  calculateColumnHide,
  createSelection,
  insertRowsAbove,
  removeRowsById,
  restoreColumnLeft,
  selectRange
} from '../smartinput/worktable-core.js';

const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('smartinput/index.html');
const app = read('smartinput/smartinput.js');
const css = read('smartinput/smartinput.css');
const contractSource = read('smartinput/smartinput-contract.js');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

const sliceFunction = (source, name, nextName) => {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source block missing`);
  return source.slice(start, end);
};

assert.match(html, /id="worktableSelectionBar"[\s\S]*id="insertSelectedRows"[\s\S]*id="deleteSelectedRows"[\s\S]*id="addHiddenColumnButton"[\s\S]*id="hideSelectedColumns"/);
assert.match(html, /id="selectAllRows"[^>]*type="button"[^>]*aria-label="현재 작업행 전체 선택"/);
assert.match(app, /from '\.\/worktable-core\.js\?v=0\.1\.0'/);
assert.match(app, /worktableSelection: createSelection\(initialDraft\.activeMode\)/);
assert.match(app, /className = 'column-drag-handle'[\s\S]*dragHandle\.draggable = true/);
assert.match(app, /className = 'column-resize-handle'/);
assert.match(app, /className = 'column-select-target'/);
assert.match(app, /inputRows\.addEventListener\('pointermove', extendWorktableRowSelection\)/);
assert.match(app, /document\.addEventListener\('pointermove', extendWorktableColumnSelection\)/);
assert.match(app, /document\.elementFromPoint\?\.\(event\.clientX, event\.clientY\)/,
  'drag selection must follow the row or column header currently under the pointer');
assert.match(app, /header\?\.querySelector\('\.column-select-target\[data-select-column\]'\)/,
  'column drag selection must cross reorder and resize handles without losing the header range');
assert.match(css, /\.worktable-selection-bar/);
assert.match(css, /\.worktable-selection-bar\[hidden\] \{ display: grid; visibility: hidden; pointer-events: none; \}/,
  'showing the selection toolbar must not shift the table during a pointer drag');
assert.match(css, /\.is-worktable-column-selected/);
assert.match(css, /\.is-worktable-row-selected/);
assert.doesNotMatch(app, /SmartParser\.html|SMART_PARSER_WORKTABLE/,
  'SmartInput WorkTable must not depend on the misplaced SmartParser implementation');

const rowSelectionSource = sliceFunction(app, 'selectWorktableRow', 'selectWorktableColumn');
const columnSelectionSource = sliceFunction(app, 'selectWorktableColumn', 'beginWorktableRowSelection');
assert.doesNotMatch(rowSelectionSource + columnSelectionSource, /activeMethod|sourceType|SmartParser/,
  'row and column selection must be input-method and parser agnostic');
const insertSource = sliceFunction(app, 'insertSelectedGridRows', 'persistVoucherColumnsForCurrentMode');
assert.match(insertSource, /method: 'direct'[\s\S]*sourceType: 'MANUAL'[\s\S]*insertRowsAbove/);
assert.doesNotMatch(insertSource, /updateMethod\(|analyzeSource\(/,
  'inserting manual rows must not switch the active source method or launch analysis');
const deleteSource = sliceFunction(app, 'deleteSelectedGridRows', 'selectedManualGroupContext');
assert.match(deleteSource, /window\.confirm\(`현재 작업테이블에서/);
assert.match(deleteSource, /removeRowsById[\s\S]*saveDraftNow\(\)/);
assert.doesNotMatch(deleteSource, /createOrder|postPurchaseGroup|postSaleGroup|updateEstimateAtomically/,
  'draft row deletion must not call an official ledger writer');
const hideSource = sliceFunction(app, 'hideSelectedWorktableColumns', 'restoreHiddenWorktableColumn');
assert.match(hideSource, /calculateColumnHide[\s\S]*persistVoucherColumnsForCurrentMode/);
assert.doesNotMatch(hideSource, /modeDraft\(\)\.rows\s*=/,
  'column hiding must not mutate SmartInput row objects');
assert.match(app, /voucherColumnsByMode[\s\S]*await saveSettings\(state\.settings\)/,
  'the adapter must persist current-mode column visibility through the existing settings contract');

const modes = Object.keys(contract.MODES);
const methods = Array.from(contract.INPUT_METHODS, method => method.id);
assert.deepEqual(modes, ['order', 'purchase', 'sale', 'estimate']);
assert.deepEqual(methods, ['direct', 'excel', 'text', 'paste', 'photo', 'voice']);

const matrix = [];
for (const mode of modes) {
  for (const method of contract.INPUT_METHODS) {
    const batch = contract.createBatch({
      batchId: `${mode}-${method.id}-batch`,
      sequence: 1,
      method: method.id,
      sourceType: method.sourceType,
      sourceName: method.label
    });
    const original = contract.applyParserResults([], batch, [1, 2, 3].map(index => ({
      sourceLineKey: `${batch.batchId}:${index}`,
      sourceDocumentKey: `${mode}-document`,
      sourceVoucherIndex: 7,
      manualSplitKey: `${mode}-group`,
      rawText: `${method.id}-${index}`,
      itemCode: `ITEM-${index}`,
      itemName: `${method.label}-${index}`,
      quantity: index,
      inputOwnership: 'SOURCE'
    })));
    const originalSnapshot = JSON.stringify(original);
    const selection = selectRange(createSelection(mode), {
      mode,
      type: 'ROW',
      orderedKeys: original.map(row => row.rowId),
      endKey: original[2].rowId,
      anchorKey: original[0].rowId
    });
    assert.equal(selection.selectedRowIds.length, 3, `${mode}/${method.id} three-row selection`);
    const manualRows = [1, 2, 3].map(index => contract.normalizeRow({
      rowId: `${mode}-${method.id}-manual-${index}`,
      batchId: `${mode}-${method.id}-manual-batch`,
      sourceBatchId: batch.batchId,
      sourceDocumentKey: original[0].sourceDocumentKey,
      sourceVoucherIndex: original[0].sourceVoucherIndex,
      manualSplitKey: original[0].manualSplitKey,
      sourceType: 'MANUAL',
      inputOwnership: 'USER'
    }));
    const inserted = insertRowsAbove(original, selection.selectedRowIds, manualRows);
    assert.deepEqual(inserted.slice(0, 3).map(row => row.rowId), manualRows.map(row => row.rowId));
    assert.equal(inserted[0].sourceDocumentKey, original[0].sourceDocumentKey);
    assert.equal(inserted[0].manualSplitKey, original[0].manualSplitKey);
    const afterDelete = removeRowsById(inserted, manualRows.map(row => row.rowId));
    assert.equal(JSON.stringify(afterDelete), originalSnapshot, `${mode}/${method.id} deletion preserves other rows`);

    const rowSnapshotBeforeColumns = JSON.stringify(original);
    const columnResult = calculateColumnHide({
      visibleOrder: ['itemCode', 'itemName', 'quantity', 'memo'],
      selectedColumnKeys: ['itemName', 'quantity', 'memo'],
      protectedColumnKeys: ['itemCode'],
      editableColumnKeys: ['itemCode', 'itemName', 'quantity', 'memo'],
      minimumEditableColumns: 1
    });
    assert.deepEqual(columnResult.visibleOrder, ['itemCode']);
    assert.equal(JSON.stringify(original), rowSnapshotBeforeColumns, `${mode}/${method.id} column hiding preserves row payload`);
    const restored = restoreColumnLeft({
      visibleOrder: columnResult.visibleOrder,
      columnKey: 'itemName',
      selectedColumnKeys: ['itemCode']
    });
    assert.deepEqual(restored, ['itemName', 'itemCode']);
    assert.equal(original[0].itemName, `${method.label}-1`, `${mode}/${method.id} restored value remains`);
    matrix.push(`${mode}/${method.id}`);
  }
}
assert.equal(matrix.length, 24);

const baseSettings = contract.normalizeSettings();
for (const mode of modes) {
  const nextByMode = Object.fromEntries(modes.map(candidate => [candidate, [...baseSettings.voucherColumnsByMode[candidate]]]));
  nextByMode[mode] = nextByMode[mode].filter(column => column !== 'memo');
  const next = contract.normalizeSettings({ ...baseSettings, voucherColumnsByMode: nextByMode });
  for (const otherMode of modes.filter(candidate => candidate !== mode)) {
    assert.equal(JSON.stringify(next.voucherColumnsByMode[otherMode]), JSON.stringify(baseSettings.voucherColumnsByMode[otherMode]), `${mode} must not change ${otherMode} columns`);
  }
}

console.log(`SmartInput WorkTable integration PASS: ${modes.length} modes × ${methods.length} input methods = ${matrix.length} shared-adapter cases.`);
