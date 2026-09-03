import assert from 'node:assert/strict';
import { commitEstimateBundle, loadSmartInputData } from '../smartinput/smartinput-data-store.js';

const values = new Map();
let failNextWrite = false;
globalThis.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('INJECTED_ESTIMATE_BUNDLE_WRITE_FAILURE');
    }
    values.set(key, String(value));
  }
};

const originalA = { estimateId: 'A', estimateKind: 'INDIVIDUAL', updatedAt: '1', draft: { rows: [{ rowId: 'A1', quantity: 1 }] } };
const originalB = { estimateId: 'B', estimateKind: 'INDIVIDUAL', updatedAt: '1', draft: { rows: [{ rowId: 'B1', quantity: 2 }] } };
await commitEstimateBundle({ upserts: [originalA, originalB] });
const before = values.get('oneapp.smartinput.relationships.v1');

await assert.rejects(() => commitEstimateBundle({
  upserts: [{ ...originalA, updatedAt: '2' }],
  expectedPreimages: [{ ...originalA, updatedAt: 'stale' }]
}), /SMARTINPUT_ESTIMATE_BUNDLE_STALE/);
assert.equal(values.get('oneapp.smartinput.relationships.v1'), before, '내용이 다른 expected pre-image이면 쓰기 전 전체를 거절해야 한다.');

failNextWrite = true;
await assert.rejects(() => commitEstimateBundle({
  upserts: [
    { ...originalA, updatedAt: '2', draft: { rows: [{ rowId: 'A1', quantity: 10 }] } },
    { ...originalB, updatedAt: '2', draft: { rows: [{ rowId: 'B1', quantity: 20 }] } }
  ],
  expectedPreimages: [originalA, originalB]
}), /INJECTED_ESTIMATE_BUNDLE_WRITE_FAILURE/);
assert.equal(values.get('oneapp.smartinput.relationships.v1'), before, '중간 저장 실패 시 일부 원본만 변경되면 안 된다.');

const loaded = await loadSmartInputData();
assert.deepEqual(loaded.estimates.map(record => [record.estimateId, record.draft.rows[0].quantity]), [['A', 1], ['B', 2]]);

console.log('SmartInput estimate bundle optimistic pre-image validation and fallback rollback passed.');
