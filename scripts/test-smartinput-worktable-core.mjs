#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  calculateColumnHide,
  contiguousRange,
  createSelection,
  firstSelectedIndex,
  insertRowsAbove,
  moveRangeEnd,
  removeRowsById,
  restoreColumnLeft,
  selectRange,
  trimSelection
} from '../smartinput/worktable-core.js';

const rowOrder = ['r1', 'r2', 'r3', 'r4'];
assert.deepEqual(contiguousRange(rowOrder, 'r1', 'r3'), ['r1', 'r2', 'r3']);
assert.deepEqual(contiguousRange(rowOrder, 'r4', 'r2'), ['r2', 'r3', 'r4']);
assert.deepEqual(contiguousRange(rowOrder, 'missing', 'r3'), ['r3']);

let selection = selectRange(createSelection('order'), {
  mode: 'order', type: 'ROW', orderedKeys: rowOrder, endKey: 'r2', anchorKey: 'r2'
});
selection = selectRange(selection, { mode: 'order', type: 'ROW', orderedKeys: rowOrder, endKey: 'r4' });
assert.deepEqual(selection.selectedRowIds, ['r2', 'r3', 'r4']);
assert.equal(selection.anchorRowId, 'r2');
assert.equal(firstSelectedIndex(rowOrder, selection.selectedRowIds), 1);
assert.equal(moveRangeEnd(rowOrder, 'r3', -1), 'r2');
assert.equal(moveRangeEnd(rowOrder, 'r4', 1), 'r4');

selection = trimSelection(selection, {
  mode: 'order', visibleRowIds: ['r2', 'r4'], visibleColumnKeys: []
});
assert.deepEqual(selection.selectedRowIds, ['r2', 'r4']);
assert.deepEqual(trimSelection(selection, { mode: 'sale', visibleRowIds: rowOrder }), createSelection('sale'));

const rows = rowOrder.map(rowId => ({ rowId, value: rowId }));
const additions = [{ rowId: 'n1' }, { rowId: 'n2' }];
const inserted = insertRowsAbove(rows, ['r2', 'r3'], additions);
assert.deepEqual(inserted.map(row => row.rowId), ['r1', 'n1', 'n2', 'r2', 'r3', 'r4']);
assert.deepEqual(rows.map(row => row.rowId), rowOrder, 'row insertion must not mutate the source array');
assert.deepEqual(insertRowsAbove(rows, [], additions).map(row => row.rowId), [...rowOrder, 'n1', 'n2']);
const removed = removeRowsById(rows, ['r2', 'r4']);
assert.deepEqual(removed.map(row => row.rowId), ['r1', 'r3']);
assert.deepEqual(rows.map(row => row.rowId), rowOrder, 'row removal must not mutate the source array');

const hidden = calculateColumnHide({
  visibleOrder: ['itemCode', 'itemName', 'quantity', 'memo'],
  selectedColumnKeys: ['itemCode', 'itemName', 'quantity'],
  protectedColumnKeys: ['itemCode'],
  editableColumnKeys: ['itemCode', 'itemName', 'quantity', 'memo'],
  minimumEditableColumns: 1
});
assert.deepEqual(hidden.visibleOrder, ['itemCode', 'memo']);
assert.deepEqual(hidden.hiddenKeys, ['itemName', 'quantity']);
assert.deepEqual(hidden.protectedSelectedKeys, ['itemCode']);

const minimum = calculateColumnHide({
  visibleOrder: ['amount', 'memo'],
  selectedColumnKeys: ['amount', 'memo'],
  protectedColumnKeys: [],
  editableColumnKeys: ['memo'],
  minimumEditableColumns: 1
});
assert.deepEqual(minimum.hiddenKeys, ['amount']);
assert.deepEqual(minimum.retainedForMinimum, ['memo']);
assert.deepEqual(minimum.visibleOrder, ['memo']);

assert.deepEqual(
  restoreColumnLeft({ visibleOrder: ['itemCode', 'quantity', 'memo'], columnKey: 'itemName', selectedColumnKeys: ['quantity', 'memo'] }),
  ['itemCode', 'itemName', 'quantity', 'memo']
);
assert.deepEqual(
  restoreColumnLeft({ visibleOrder: ['itemCode', 'quantity'], columnKey: 'memo', selectedColumnKeys: ['missing'] }),
  ['memo', 'itemCode', 'quantity']
);

console.log('SmartInput WorkTable Core range, selection, insertion, removal, visibility, restore, and keyboard tests passed.');
