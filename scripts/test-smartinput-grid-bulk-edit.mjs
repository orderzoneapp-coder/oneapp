#!/usr/bin/env node

import assert from 'node:assert/strict';
import { applyBulkUnitPrice, parseBulkUnitPrice } from '../smartinput/grid-bulk-edit.js';

assert.equal(parseBulkUnitPrice('1,300원'), 1300);
assert.equal(parseBulkUnitPrice('0'), 0);
assert.throws(() => parseBulkUnitPrice(''), /SMARTINPUT_BULK_PRICE_REQUIRED/);
assert.throws(() => parseBulkUnitPrice('임의'), /SMARTINPUT_BULK_PRICE_INVALID/);

const sourceRows = [
  { rowId: 'R1', unitPrice: 1000, editedFields: {}, fieldValues: { 'voucher.sale.line.unitPrice': { sourceDisplayValue: '1,000', currentDisplayValue: '1,000', parsedValue: 1000, edited: false } } },
  { rowId: 'R2', unitPrice: 1100, editedFields: {} },
  { rowId: 'R3', unitPrice: 1200, editedFields: {} }
];
const result = applyBulkUnitPrice(sourceRows, ['R1', 'R3'], '1,300', {
  targetFieldId: 'voucher.sale.line.unitPrice', actor: 'TESTER', occurredAt: '2026-09-01T12:00:00.000Z'
});
assert.equal(result.affectedCount, 2);
assert.deepEqual(result.rows.map(row => row.unitPrice), [1300, 1100, 1300]);
assert.equal(result.rows[0].sourceUnitPrice, '1,300');
assert.equal(result.rows[0].fieldValues['voucher.sale.line.unitPrice'].sourceDisplayValue, '1,000', '원본 표시값은 바꾸면 안 된다.');
assert.equal(result.rows[0].fieldValues['voucher.sale.line.unitPrice'].currentDisplayValue, '1,300');
assert.equal(result.rows[0].fieldValues['voucher.sale.line.unitPrice'].edited, true);
assert.equal(result.rows[0].bulkEditHistory[0].before, 1000);
assert.equal(result.rows[1], sourceRows[1], '선택하지 않은 행은 변경하면 안 된다.');

console.log('SmartInput selected-row bulk unit-price application and source-value preservation passed.');
