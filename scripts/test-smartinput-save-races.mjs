#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTOSAVE_JOURNAL_SCHEMA,
  createAutosaveDocumentKey,
  createDraftSaveCoordinator
} from '../smartinput/draft-save-coordinator.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const context = { companyId: 'SAVE-RACE-TEST', mode: 'order', documentId: 'DOC-A' };
const snapshot = quantity => ({ rows: [{ rowId: 'ROW-A', quantity }] });
const tests = [];

// Keep every commit under explicit control; no sleeps or timing thresholds.
tests.push(['flush waits for the successor commit', async () => {
  const first = deferred();
  const second = deferred();
  const coordinator = createDraftSaveCoordinator({ commit: payload => (
    payload.head.durableVersion === 1 ? first.promise : second.promise
  ) });
  const a = coordinator.queue({ ...context, snapshot: snapshot(1) });
  const b = coordinator.queue({ ...context, snapshot: snapshot(2) });
  let result = 'pending';
  const flushed = coordinator.flushWorkspace().then(
    value => { result = 'saved'; return value; },
    error => { result = error.message; }
  );
  try {
    first.resolve();
    await nextTurn();
    assert.equal(result, 'pending', 'a healthy successor write is not a flush failure');
    assert.equal(coordinator.status(a.docKey).durableVersion, 1);
    assert.equal(coordinator.status(a.docKey).inFlight, true);
    second.resolve();
    await flushed;
    assert.equal(result, 'saved');
    assert.equal(coordinator.status(a.docKey).durableVersion, 2);
    assert.deepEqual(coordinator.recoveredSnapshot(a.docKey), snapshot(2));
  } finally {
    first.resolve(); second.resolve();
    await Promise.all([a.promise, b.promise, flushed]);
  }
}]);

tests.push(['flush captures its target instead of chasing later edits', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const coordinator = createDraftSaveCoordinator({ commit: payload => gates[payload.head.durableVersion - 1].promise });
  const a = coordinator.queue({ ...context, snapshot: snapshot(1) });
  const b = coordinator.queue({ ...context, snapshot: snapshot(2) });
  const flushed = coordinator.flushDocument(a.docKey).then(value => ({ value }), error => ({ error }));
  let c;
  try {
    gates[0].resolve();
    await nextTurn();
    c = coordinator.queue({ ...context, snapshot: snapshot(3) });
    gates[1].resolve();
    const result = await flushed;
    assert.equal(result.error, undefined);
    assert.equal(result.value.durableVersion, 2);
    assert.equal(coordinator.status(a.docKey).inFlight, true, 'newer work remains independently in flight');
  } finally {
    gates.forEach(gate => gate.resolve());
    await Promise.all([a.promise, b.promise, c?.promise, flushed]);
  }
}]);

tests.push(['failed successor remains pending and explicitly retries', async () => {
  const first = deferred();
  let fail = true;
  const coordinator = createDraftSaveCoordinator({ commit: async payload => {
    if (payload.head.durableVersion === 1) await first.promise;
    else if (fail) throw new Error('CONTROLLED_COMMIT_ABORT');
  } });
  const a = coordinator.queue({ ...context, snapshot: snapshot(1) });
  const b = coordinator.queue({ ...context, snapshot: snapshot(2) });
  const failedTicket = b.promise.then(() => null, error => error);
  const flushed = coordinator.flushDocument(a.docKey).then(() => null, error => error);
  first.resolve();
  assert.equal((await flushed)?.message, 'CONTROLLED_COMMIT_ABORT');
  assert.equal((await failedTicket)?.message, 'CONTROLLED_COMMIT_ABORT');
  assert.equal(coordinator.status(a.docKey).pending, true);
  assert.equal(coordinator.status(a.docKey).durableVersion, 1);
  fail = false;
  await coordinator.flushDocument(a.docKey);
  await a.promise;
  assert.equal(coordinator.status(a.docKey).durableVersion, 2);
  assert.deepEqual(coordinator.recoveredSnapshot(a.docKey), snapshot(2));
}]);

tests.push(['workspace flush preserves independent documents and coalesced pending edits', async () => {
  const gate = deferred();
  const coordinator = createDraftSaveCoordinator({ commit: async payload => {
    if (payload.head.docKey.includes('DOC-A') && payload.head.durableVersion === 1) await gate.promise;
  } });
  const tickets = [1, 2, 3].map(quantity => coordinator.queue({ ...context, snapshot: snapshot(quantity) }));
  const other = coordinator.queue({ ...context, mode: 'sale', documentId: 'DOC-B', snapshot: snapshot(7) });
  await other.promise;
  let completed = false;
  const flushed = coordinator.flushWorkspace().then(() => { completed = true; }, error => { throw error; });
  // Attach the rejection handler immediately even on a regressed implementation.
  const outcome = flushed.then(() => null, error => error);
  assert.equal(completed, false);
  gate.resolve();
  assert.equal(await outcome, null);
  await Promise.all(tickets.map(ticket => ticket.promise));
  assert.deepEqual(coordinator.recoveredSnapshot(tickets[0].docKey), snapshot(3));
  assert.deepEqual(coordinator.recoveredSnapshot(other.docKey), snapshot(7));
}]);

// Extract the actual production functions, not a copied implementation.
const appSource = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const start = appSource.indexOf('function autosaveDocumentKey(');
const end = appSource.indexOf('\nfunction writeCompatibilityDraft(', start);
assert.ok(start >= 0 && end > start, 'production checkpoint functions must be locatable');
const checkpointFunctions = appSource.slice(start, end);
function appHarness() {
  const commits = [];
  const coordinator = createDraftSaveCoordinator({ commit: () => {
    const gate = deferred(); commits.push(gate); return gate.promise;
  } });
  const state = {
    companyId: context.companyId, autosaveClientId: 'test-client', autosaveLoading: false,
    pendingAutosaveModes: new Set(), latestQueuedDocumentVersions: new Map(),
    draftMutationVersion: 1, draftDirty: true,
    draft: { draftId: 'TEST-WORKSPACE', activeMode: 'order', ui: {},
      modes: { order: { documentId: context.documentId, ...snapshot(1) } } }
  };
  let label = { message: '자동저장 중…', stateName: 'saving' };
  const queue = new Function('state', 'draftSaveCoordinator', 'setSaveState', 'updateAutosaveButton',
    'setAppStatus', 'createAutosaveDocumentKey', 'AUTOSAVE_JOURNAL_SCHEMA',
    `${checkpointFunctions}\nreturn queueDocumentCheckpoint;`)(
    state, coordinator, (message, stateName) => { label = { message, stateName }; },
    () => {}, () => {}, createAutosaveDocumentKey, AUTOSAVE_JOURNAL_SCHEMA);
  return { state, coordinator, commits, queue, label: () => label };
}

tests.push(['old ACK never reports an unqueued edit as saved', async () => {
  const app = appHarness();
  const first = app.queue();
  app.state.draft.modes.order.rows[0].quantity = 2;
  app.state.draftMutationVersion += 1;
  app.commits[0].resolve();
  await first.promise;
  await nextTurn();
  assert.equal(app.state.draftDirty, true);
  assert.equal(app.coordinator.recoveredSnapshot(first.docKey).rows[0].quantity, 1);
  assert.equal(app.label().stateName, 'saving', 'old ACK must preserve the newer saving state');
  const latest = app.queue();
  app.commits[1].resolve();
  await latest.promise;
  await nextTurn();
  assert.equal(app.state.draftDirty, false);
  assert.deepEqual(app.label(), { message: '자동저장됨', stateName: 'saved' });
  assert.equal(app.coordinator.recoveredSnapshot(first.docKey).rows[0].quantity, 2);
}]);

tests.push(['queued newer edit is not cleared by an old ACK', async () => {
  const app = appHarness();
  const first = app.queue();
  app.state.draft.modes.order.rows[0].quantity = 3;
  app.state.draftMutationVersion += 1;
  const latest = app.queue();
  app.commits[0].resolve();
  await first.promise;
  await nextTurn();
  try {
    assert.equal(app.state.draftDirty, true);
    assert.equal(app.label().stateName, 'saving');
  } finally { app.commits[1].resolve(); }
  await latest.promise;
  await nextTurn();
  assert.equal(app.state.draftDirty, false);
  assert.equal(app.label().stateName, 'saved');
  assert.equal(app.coordinator.recoveredSnapshot(latest.docKey).rows[0].quantity, 3);
}]);

let failures = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`PASS: ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL: ${name}\n${error.stack}`); }
}
assert.equal(failures, 0, `${failures} SmartInput save race regression(s)`);
console.log(`SmartInput save race regressions passed (${tests.length}/${tests.length}).`);
