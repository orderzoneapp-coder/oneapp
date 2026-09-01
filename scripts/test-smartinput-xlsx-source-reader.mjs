#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readWorksheetSource } from '../smartinput/xlsx-source-reader.js';

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const xlsx = {
  utils: {
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 1, c: 2 } }),
    encode_cell: ({ r, c }) => `${letters[c]}${r + 1}`,
    format_cell: cell => String(cell.v ?? '')
  }
};
const sheet = {
  '!ref': 'A1:C2',
  A1: { t: 's', v: '상품코드', w: '상품코드' },
  B1: { t: 's', v: '수량', w: '수량' },
  C1: { t: 's', v: '단가', w: '단가' },
  A2: { t: 'n', v: 125, w: '00125', z: '00000' },
  B2: { t: 'n', v: 0, w: '0', z: '0' },
  C2: { t: 'n', v: 1200, w: '1,200', z: '#,##0', f: '600*2' }
};
const source = readWorksheetSource(xlsx, sheet);
assert.deepEqual(source.displayMatrix[1], ['00125', '0', '1,200']);
assert.equal(source.sourceCellMatrix[1][0].rawValue, 125);
assert.equal(source.sourceCellMatrix[1][0].numberFormat, '00000');
assert.equal(source.sourceCellMatrix[1][2].formula, '600*2');
assert.equal(source.sourceCellMatrix[1][2].displayValue, '1,200');
assert.equal(Object.isFrozen(source.displayMatrix), true);
assert.equal(Object.isFrozen(source.sourceCellMatrix[1][2]), true);

console.log('SmartInput XLSX display/raw/formula/format source preservation passed.');
