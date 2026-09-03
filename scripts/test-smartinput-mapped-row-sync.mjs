#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyMappedFieldUpdates,
  mappedRowMutationPlan,
  projectedRowValue
} from '../smartinput/mapped-row-sync.js';
import { synchronizeWorkingRow } from '../smartinput/input-template-mapper.js';

const targets = [
  { id: 'memo', projectionFieldId: 'memo', scope: 'voucher' },
  { id: 'unitPrice', projectionFieldId: 'unitPrice', scope: 'voucher', valueType: 'NUMBER' },
  { id: 'itemCode', projectionFieldId: 'itemCode', scope: 'voucher' },
  { id: 'supplyAmount', projectionFieldId: 'supplyAmount', scope: 'voucher', valueType: 'NUMBER' },
  { id: 'itemName', projectionFieldId: 'itemName', scope: 'voucher' },
  { id: 'specification', projectionFieldId: 'specification', scope: 'voucher' },
  { id: 'unit', projectionFieldId: 'unit', scope: 'voucher' },
  { id: 'quantity', projectionFieldId: 'quantity', scope: 'voucher', valueType: 'NUMBER' },
  { id: 'unmapped', projectionFieldId: 'unmapped', scope: 'voucher' }
];
const mappings = targets.map((target, columnIndex) => ({
  columnIndex,
  state: target.id === 'unmapped' ? 'UNMAPPED' : (target.id === 'specification' ? 'RECOMMENDED' : 'MAPPED'),
  targetFieldId: target.id
}));
const sourceMatrix = [
  ['원본 메모', '원본 단가', '원본 코드', '원본 공급가', '원본 품명', '원본 규격', '원본 단위', '원본 수량', '미매핑'],
  ['', '100', 'OLD', '200', '과거 상품', '과거 규격', 'EA', '2', '증적 보존']
];
const sourceCellMatrix = sourceMatrix.map((row, rowIndex) => row.map((displayValue, columnIndex) => ({
  address: `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`,
  displayValue,
  rawValue: displayValue
})));
const session = {
  headers: [...sourceMatrix[0]],
  sourceMatrix: structuredClone(sourceMatrix),
  sourceCellMatrix: structuredClone(sourceCellMatrix),
  signature: 'ONEAPP|order|원본 메모\u001f원본 단가\u001f원본 코드\u001f원본 공급가\u001f원본 품명\u001f원본 규격\u001f원본 단위\u001f원본 수량\u001f미매핑',
  headerSignature: '원본 메모\u001f원본 단가\u001f원본 코드\u001f원본 공급가\u001f원본 품명\u001f원본 규격\u001f원본 단위\u001f원본 수량\u001f미매핑',
  headerRowIndex: 0,
  mappings,
  editJournal: {},
  manualRows: [],
  deletedSourceRows: [],
  workingRows: [{
    rowId: 'source-1',
    sourceRowIndex: 1,
    cells: [...sourceMatrix[1]],
    sourceCells: structuredClone(sourceCellMatrix[1]),
    manual: false
  }],
  updatedAt: '2026-09-03T00:00:00.000Z'
};

const before = {
  rowId: 'source-1', itemCode: 'OLD', itemName: '과거 상품', specification: '과거 규격', unit: 'EA',
  quantity: 2, unitPrice: 100, memo: '', unmapped: 'row projection에 없음',
  fieldValues: Object.fromEntries(targets.slice(0, 8).map(target => [target.id, {
    fieldId: target.id,
    sourceDisplayValue: sourceMatrix[1][targets.indexOf(target)],
    currentDisplayValue: sourceMatrix[1][targets.indexOf(target)],
    parsedValue: null,
    edited: false,
    evidence: structuredClone(sourceCellMatrix[1][targets.indexOf(target)])
  }]))
};
const after = {
  ...before,
  itemCode: 'NEW-001',
  itemName: '새 상품',
  specification: '10kg',
  unit: 'BOX',
  quantity: -2,
  unitPrice: 350,
  unmapped: '바뀌어도 저장 금지'
};

assert.equal(projectedRowValue({ quantity: 0, unitPrice: -15 }, targets[3]), 0,
  'derived supply amount must preserve a real zero');
assert.equal(projectedRowValue({ quantity: -2, unitPrice: 350 }, targets[3]), -700,
  'derived supply amount must preserve negative arithmetic');
assert.equal(projectedRowValue({ quantity: '', unitPrice: 350 }, targets[3]), '',
  'derived supply amount must preserve a blank operand as blank');

const plan = mappedRowMutationPlan({
  beforeRow: before,
  afterRow: after,
  targetDefinitions: targets,
  mappings
});
assert.deepEqual(plan.map(update => update.projectionFieldId), [
  'unitPrice', 'itemCode', 'supplyAmount', 'itemName', 'specification', 'unit', 'quantity'
], 'one post-mutation plan must include every mapped/recommended product field and derived supply amount');
assert.equal(plan.find(update => update.projectionFieldId === 'supplyAmount').displayValue, '-700');
assert.equal(plan.some(update => update.projectionFieldId === 'unmapped'), false,
  'unmapped source values must never be copied into row projection storage');

const evidenceBefore = JSON.stringify({
  sourceMatrix: session.sourceMatrix,
  sourceCellMatrix: session.sourceCellMatrix,
  headers: session.headers,
  signature: session.signature,
  headerSignature: session.headerSignature
});
const synchronized = synchronizeWorkingRow(session, after.rowId, plan);
assert.deepEqual(synchronized.workingRows[0].cells, [
  '', '350', 'NEW-001', '-700', '새 상품', '10kg', 'BOX', '-2', '증적 보존'
], 'the source-order working row must immediately match the post-mutation input projection');
assert.equal(JSON.stringify({
  sourceMatrix: synchronized.sourceMatrix,
  sourceCellMatrix: synchronized.sourceCellMatrix,
  headers: synchronized.headers,
  signature: synchronized.signature,
  headerSignature: synchronized.headerSignature
}), evidenceBefore, 'working-row synchronization must not alter immutable source evidence or positional signatures');
assert.equal(synchronized.workingRows[0].rowId, 'source-1');
assert.equal(synchronized.workingRows.length, 1, 'synchronization must not duplicate an existing source row');

const rowWithUpdatedFieldValues = applyMappedFieldUpdates(after, plan);
assert.equal(rowWithUpdatedFieldValues.fieldValues.itemCode.currentDisplayValue, 'NEW-001');
assert.equal(rowWithUpdatedFieldValues.fieldValues.itemCode.edited, true);
assert.deepEqual(rowWithUpdatedFieldValues.fieldValues.itemCode.evidence, before.fieldValues.itemCode.evidence,
  'mapped projection updates must retain original cell evidence');
assert.equal(rowWithUpdatedFieldValues.fieldValues.itemCode.sourceDisplayValue, 'OLD',
  'mapped projection updates must retain the original display value separately');
assert.equal(rowWithUpdatedFieldValues.fieldValues.supplyAmount.currentDisplayValue, '-700');

const formattedOverridePlan = mappedRowMutationPlan({
  beforeRow: after,
  afterRow: { ...after, unitPrice: 1200, quantity: 0 },
  targetDefinitions: targets,
  mappings,
  forceFieldIds: ['unitPrice', 'quantity'],
  displayValues: { unitPrice: '1,200', quantity: '0' }
});
assert.equal(formattedOverridePlan.find(update => update.projectionFieldId === 'unitPrice').displayValue, '1,200',
  'direct and bulk edits must retain the explicit entered display value');
assert.equal(formattedOverridePlan.find(update => update.projectionFieldId === 'quantity').displayValue, '0');
assert.equal(formattedOverridePlan.find(update => update.projectionFieldId === 'supplyAmount').displayValue, '0');

const manualPlan = mappedRowMutationPlan({
  beforeRow: null,
  afterRow: { rowId: 'manual-fixed', itemCode: 'NEW-001', itemName: '새 상품', quantity: -2, unitPrice: 350 },
  targetDefinitions: targets,
  mappings,
  forceFieldIds: ['itemCode']
});
const withManual = synchronizeWorkingRow(session, 'manual-fixed', manualPlan);
const withManualAgain = synchronizeWorkingRow(withManual, 'manual-fixed', manualPlan);
assert.equal(withManualAgain.workingRows.filter(row => row.rowId === 'manual-fixed').length, 1,
  'a missing manual row must be upserted once with its stable rowId');
assert.equal(withManualAgain.manualRows.filter(row => row.rowId === 'manual-fixed').length, 1,
  'manual-row storage must not accumulate duplicate rowIds');
assert.equal(withManualAgain.workingRows.find(row => row.rowId === 'manual-fixed').cells[2], 'NEW-001');
assert.equal(withManualAgain.workingRows.find(row => row.rowId === 'manual-fixed').cells[3], '-700');

const clearedSource = {
  ...session,
  editJournal: Object.fromEntries(session.headers.map((_, columnIndex) => [`1:${columnIndex}`, ''])),
  workingRows: []
};
const restoredSource = synchronizeWorkingRow(clearedSource, 'source-1', [{ columnIndex: 2, displayValue: 'RESTORED' }]);
assert.equal(restoredSource.workingRows.find(row => row.rowId === 'source-1').cells[2], 'RESTORED',
  'a source row edited completely blank and then re-entered must recover its source rowId');
assert.equal(restoredSource.manualRows.length, 0,
  'recovering a filtered source row must not create a duplicate manual row');

const appSource = readFileSync(fileURLToPath(new URL('../smartinput/smartinput.js', import.meta.url)), 'utf8');
assert.match(appSource, /function syncMappedWorkingRowAfterMutation\(/,
  'SmartInput must expose one row-level post-mutation synchronization boundary');
assert.doesNotMatch(appSource, /function syncInputViewCellToMapping\(/,
  'the former one-cell-only synchronization boundary must be removed');
assert.match(appSource, /syncMappedWorkingRowAfterMutation\([\s\S]*displayValues/,
  'direct input, paste, and bulk operations must pass explicit display-value overrides through the row boundary');
assert.match(appSource, /function applyProduct[\s\S]*syncMappedWorkingRowAfterMutation/,
  'product application paths must reach the centralized row synchronization boundary');

console.log('SmartInput mapped-row mutation synchronization tests passed.');
