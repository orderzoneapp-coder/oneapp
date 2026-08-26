import assert from 'node:assert/strict';
import {
  estimateContentDigest,
  estimateRevision,
  normalizeEstimateNameKey,
  planEstimateCreate,
  planEstimateUpdate
} from '../smartinput/estimate-save-contract.js';

const clone = value => JSON.parse(JSON.stringify(value));
const row = (itemCode, itemName, quantity, unitPrice) => ({ itemCode, itemName, quantity, unitPrice });
const originalA = {
  estimateId: 'SIEST-A',
  catalogName: '기존 견적서 A',
  sortOrder: 1,
  revision: 4,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  draft: { rows: [row('P-1', '사과', 1, 1000)], header: { customerName: 'A 거래처' } }
};
originalA.contentDigest = estimateContentDigest(originalA.draft);

const library = [clone(originalA)];
const originalBytes = JSON.stringify(library[0]);
const editedDraft = { rows: [row('P-1', '사과', 7, 1250)], header: { customerName: 'A 거래처' } };
const copyCandidate = {
  estimateId: 'SIEST-B',
  catalogName: '새 양식 B',
  sortOrder: 2,
  createdAt: '2026-08-26T01:00:00.000Z',
  updatedAt: '2026-08-26T01:00:00.000Z',
  draft: editedDraft
};

const copied = planEstimateCreate(library, copyCandidate, { saveAttemptId: 'SAVE-COPY-1' });
assert.equal(copied.recovered, false);
assert.equal(copied.records.length, 2);
assert.equal(copied.record.estimateId, 'SIEST-B');
assert.equal(copied.record.revision, 1);
assert.equal(copied.record.contentDigest, estimateContentDigest(editedDraft));
assert.equal(JSON.stringify(copied.records.find(record => record.estimateId === 'SIEST-A')), originalBytes,
  'copying A to B must preserve A byte-for-byte');

const copiedRetry = planEstimateCreate(copied.records, copyCandidate, { saveAttemptId: 'SAVE-COPY-1' });
assert.equal(copiedRetry.recovered, true);
assert.equal(copiedRetry.records.length, 2, 'the same save attempt must not create a duplicate');
assert.equal(copiedRetry.record.estimateId, 'SIEST-B');

assert.throws(
  () => planEstimateCreate(copied.records, { ...copyCandidate, draft: { ...editedDraft, rows: [row('P-1', '사과', 9, 1250)] } }, { saveAttemptId: 'SAVE-COPY-1' }),
  error => error.code === 'ESTIMATE_ID_CONFLICT'
);
assert.throws(
  () => planEstimateCreate(copied.records, { ...copyCandidate, estimateId: 'SIEST-C', catalogName: '  새   양식 b ' }, { saveAttemptId: 'SAVE-COPY-2' }),
  error => error.code === 'ESTIMATE_NAME_CONFLICT'
);
assert.equal(normalizeEstimateNameKey('  새   양식 B '), normalizeEstimateNameKey('새 양식 b'));

const updateCandidate = {
  ...clone(originalA),
  updatedAt: '2026-08-26T02:00:00.000Z',
  draft: editedDraft
};
const updated = planEstimateUpdate(library, 'SIEST-A', 4, updateCandidate, { saveAttemptId: 'SAVE-UPDATE-1' });
assert.equal(updated.record.estimateId, 'SIEST-A');
assert.equal(updated.record.revision, 5);
assert.equal(updated.record.createdAt, originalA.createdAt);
assert.equal(updated.record.sortOrder, originalA.sortOrder);
assert.equal(updated.record.contentDigest, estimateContentDigest(editedDraft));

const updatedRetry = planEstimateUpdate(updated.records, 'SIEST-A', 4, updateCandidate, { saveAttemptId: 'SAVE-UPDATE-1' });
assert.equal(updatedRetry.recovered, true);
assert.equal(updatedRetry.record.revision, 5, 'a retried update must not increment the revision twice');

const conflictInput = clone(updated.records);
const conflictBytes = JSON.stringify(conflictInput);
assert.throws(
  () => planEstimateUpdate(conflictInput, 'SIEST-A', 4, { ...updateCandidate, draft: { rows: [row('P-2', '배', 1, 800)] } }, { saveAttemptId: 'SAVE-UPDATE-2' }),
  error => error.code === 'ESTIMATE_REVISION_CONFLICT'
);
assert.equal(JSON.stringify(conflictInput), conflictBytes, 'a revision conflict must not partially mutate the library');

const legacy = { ...clone(originalA) };
delete legacy.revision;
assert.equal(estimateRevision(legacy), 0);
const legacyUpdated = planEstimateUpdate([legacy], legacy.estimateId, 0, { ...legacy, draft: editedDraft }, { saveAttemptId: 'SAVE-LEGACY-1' });
assert.equal(legacyUpdated.record.revision, 1);

const fallbackValues = new Map();
globalThis.localStorage = {
  getItem: key => fallbackValues.get(key) ?? null,
  setItem: (key, value) => fallbackValues.set(key, String(value))
};
const {
  createEstimateAtomically,
  updateEstimateAtomically
} = await import('../smartinput/smartinput-data-store.js');

const storedA = await createEstimateAtomically({ ...clone(originalA), revision: undefined }, 'STORE-CREATE-A');
assert.equal(storedA.record.revision, 1);
const storedAUpdated = await updateEstimateAtomically('SIEST-A', 1, { ...clone(originalA), draft: editedDraft }, 'STORE-UPDATE-A');
assert.equal(storedAUpdated.record.estimateId, 'SIEST-A');
assert.equal(storedAUpdated.record.revision, 2);
const storedB = await createEstimateAtomically(copyCandidate, 'STORE-CREATE-B');
assert.equal(storedB.record.estimateId, 'SIEST-B');
assert.equal(storedB.records.length, 2);
const storedBRetry = await createEstimateAtomically(copyCandidate, 'STORE-CREATE-B');
assert.equal(storedBRetry.recovered, true);
assert.equal(storedBRetry.records.length, 2);
const beforeStoreConflict = fallbackValues.values().next().value;
await assert.rejects(
  updateEstimateAtomically('SIEST-A', 1, { ...clone(originalA), draft: { rows: [row('P-9', '감', 2, 900)] } }, 'STORE-STALE-A'),
  error => error.code === 'ESTIMATE_REVISION_CONFLICT'
);
assert.equal(fallbackValues.values().next().value, beforeStoreConflict,
  'the product data-store path must not write partial state after a conflict');

console.log('SmartInput estimate save contract fixtures passed.');
