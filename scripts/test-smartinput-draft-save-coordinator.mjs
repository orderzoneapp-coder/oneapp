#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyAutosavePatch,
  createAutosaveDocumentKey,
  createAutosavePatch,
  createDraftSaveCoordinator,
  recoverAutosaveDocuments
} from '../smartinput/draft-save-coordinator.js';

const storeSource = readFileSync(new URL('../smartinput/smartinput-data-store.js', import.meta.url), 'utf8');
assert.match(storeSource, /SMARTINPUT_DB_VERSION = 5/, 'stage 2 must reuse the existing autosave store without a DB version bump');
assert.match(storeSource, /commitAutosaveJournal[\s\S]*db\.transaction\(DATA_STORES\.AUTOSAVE, 'readwrite'\)[\s\S]*store\.put\(head\)/,
  'base, patch, workspace, and head must share one IndexedDB transaction');

const records = new Map();
const commits = [];
let holdFirstA;
let failNext = false;
const firstAGate = new Promise(resolve => { holdFirstA = resolve; });

const commit = async payload => {
  if (payload.head.docKey.includes('DOC-A') && payload.head.durableVersion === 1) await firstAGate;
  if (failNext) {
    failNext = false;
    throw new Error('quota');
  }
  const previous = records.get(payload.head.key);
  assert.equal(Number(previous?.durableVersion || 0), Number(payload.expectedDurableVersion || 0),
    'journal commits must compare the durable preimage');
  [payload.base, payload.patch, payload.workspace, payload.head].filter(Boolean)
    .forEach(record => records.set(record.key, structuredClone(record)));
  commits.push({ docKey: payload.head.docKey, version: payload.head.durableVersion });
};

const coordinator = createDraftSaveCoordinator({ commit, now: () => '2026-09-12T00:00:00.000Z' });
const docA = createAutosaveDocumentKey({ companyId: 'C1', mode: 'order', documentId: 'DOC-A' });
const docB = createAutosaveDocumentKey({ companyId: 'C1', mode: 'sale', documentId: 'DOC-B' });

const a1 = coordinator.queue({ companyId: 'C1', mode: 'order', documentId: 'DOC-A', snapshot: { rows: [{ rowId: 'A', quantity: 1 }] } });
const a2 = coordinator.queue({ companyId: 'C1', mode: 'order', documentId: 'DOC-A', snapshot: { rows: [{ rowId: 'A', quantity: 2 }], memo: 'latest' } });
const b1 = coordinator.queue({ companyId: 'C1', mode: 'sale', documentId: 'DOC-B', snapshot: { rows: [{ rowId: 'B', quantity: 4 }] } });
await b1.promise;
assert.equal(coordinator.status(docB).durableVersion, 1, 'another document must save while the first document is in flight');
assert.equal(coordinator.status(docA).durableVersion, 0);
holdFirstA();
await Promise.all([a1.promise, a2.promise]);
assert.deepEqual(commits.filter(item => item.docKey === docA).map(item => item.version), [1, 2],
  'one immutable in-flight snapshot and one merged pending snapshot must commit in order');

failNext = true;
const failed = coordinator.queue({ companyId: 'C1', mode: 'order', documentId: 'DOC-A', snapshot: { rows: [{ rowId: 'A', quantity: 3 }], memo: 'retry' } });
await assert.rejects(failed.promise, /quota/);
assert.equal(coordinator.status(docA).pending, true, 'a failed change must remain queued');
await coordinator.flushDocument(docA);
assert.equal(coordinator.status(docA).durableVersion, 3, 'flush must retry and durably save a failed pending change');

const recovered = recoverAutosaveDocuments([...records.values()]);
assert.deepEqual(recovered.get(docA).snapshot, { rows: [{ rowId: 'A', quantity: 3 }], memo: 'retry' });
assert.deepEqual(recovered.get(docB).snapshot, { rows: [{ rowId: 'B', quantity: 4 }] });

const incomplete = [...records.values()].filter(record => !(record.recordType === 'patch' && record.docKey === docA && record.toVersion === 3));
assert.equal(recoverAutosaveDocuments(incomplete).has(docA), false,
  'a head with an incomplete patch chain must never be treated as a valid recovery checkpoint');

const before = { header: { customer: 'A' }, rows: [{ rowId: '1', quantity: 1 }, { rowId: '2', quantity: 2 }] };
const after = { header: { customer: 'B' }, rows: [{ rowId: '1', quantity: 7 }, { rowId: '2', quantity: 2 }] };
const patch = createAutosavePatch(before, after);
assert.deepEqual(applyAutosavePatch(before, patch), after, 'a change journal must reproduce the exact document snapshot');
assert.equal(patch.some(operation => operation.path === 'header/customer'), true);
assert.equal(patch.some(operation => operation.path === 'rows'), false,
  'a stable-row cell edit must not serialize the full row collection');

const compactRecords = new Map();
const cleaned = [];
const compactCoordinator = createDraftSaveCoordinator({
  compactAfter: 1,
  commit: async payload => [payload.base, payload.patch, payload.head].filter(Boolean)
    .forEach(record => compactRecords.set(record.key, structuredClone(record))),
  cleanup: async keys => { cleaned.push(...keys); keys.forEach(key => compactRecords.delete(key)); }
});
await compactCoordinator.queue({ companyId: 'C2', mode: 'order', documentId: 'COMPACT', snapshot: { rows: [{ rowId: '1', quantity: 1 }] } }).promise;
await compactCoordinator.queue({ companyId: 'C2', mode: 'order', documentId: 'COMPACT', snapshot: { rows: [{ rowId: '1', quantity: 2 }] } }).promise;
await compactCoordinator.queue({ companyId: 'C2', mode: 'order', documentId: 'COMPACT', snapshot: { rows: [{ rowId: '1', quantity: 3 }] } }).promise;
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(cleaned.length, 2, 'compaction must clean the old base and patch only after the new base/head commit succeeds');
assert.deepEqual(recoverAutosaveDocuments([...compactRecords.values()]).values().next().value.snapshot,
  { rows: [{ rowId: '1', quantity: 3 }] });

console.log('SmartInput document journal/autosave coordinator tests passed.');

// Run delayed-commit and stale-ACK regressions in the existing required CI entry.
await import('./test-smartinput-save-races.mjs');
