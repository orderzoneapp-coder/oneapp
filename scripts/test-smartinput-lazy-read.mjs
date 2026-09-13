import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimateReadCache, estimateReadKey, estimateSummaryKey, projectEstimateSummary,
  ESTIMATE_SUMMARY_SCHEMA } from '../smartinput/estimate-read-cache.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const request = (id = '0007', revision = 0, companyId = 'C1', kind = 'body') => ({ kind, companyId, id, revision });
const ready = (r, value = { quantity: 0, text: '', rows: [{ rowId: '0001', price: -1 }] }) => ({ status: 'READY', revision: r.revision, value });
const cacheFor = (t, options) => { const cache = createEstimateReadCache(options); t.after(() => cache.dispose()); return cache; };

// Pure reader contracts, NOT IndexedDB transactions or production UI tests.
test('summary whitelist preserves existing metadata and omits all body/receipt/photo data', () => {
  const record = { estimateId: '0007', companyId: 'C1', catalogName: ' 견적 A ', createdAt: '2026-01-01',
    updatedAt: '2026-01-02', sortOrder: 0, dataRevision: 0, ownedRows: [{ secret: 1 }], photos: ['big'],
    latestExcelResult: { excluded: ['x'] }, draft: { header: { customerId: '001', customerCode: '0002', customerName: '고객' }, rows: [1] } };
  const before = structuredClone(record), summary = projectEstimateSummary(record);
  assert.equal(summary.summarySchemaVersion, ESTIMATE_SUMMARY_SCHEMA);
  assert.equal(summary.title, '견적 A'); assert.equal(summary.customerCode, '0002');
  assert.equal(summary.sourceRevision, 0); assert.equal(summary.sortOrder, 0);
  for (const key of ['ownedRows', 'draft', 'photos', 'latestExcelResult']) assert.ok(!(key in summary));
  assert.deepEqual(record, before); assert.ok(Object.isFrozen(summary));
});
test('unknown company/revision stays unknown, without assignment from current company', () => {
  const summary = projectEstimateSummary({ estimateId: 'x', draft: { header: { customerName: '거래처' } } });
  assert.equal(summary.companyId, null); assert.equal(summary.sourceRevision, null); assert.equal(summary.title, '거래처');
  assert.equal(projectEstimateSummary({ estimateId: 'x' }).title, '견적서명 미지정');
});
test('summary escaping isolates unresolved scope and reserved-looking real IDs', () => {
  const keys = [estimateSummaryKey(null, 'x'), estimateSummaryKey('null', 'x'), estimateSummaryKey('C:1', '%:x'),
    estimateSummaryKey('C', '1:%:x'), estimateSummaryKey('C:1', '%25:x')];
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => estimateSummaryKey(undefined, 'x')); assert.throws(() => estimateSummaryKey('C1', ''));
});
test('typed read keys isolate leading zero, string/number revision, company and photo tokens', () => {
  const inputs = [request(), request('0007', -0), request('7'), request('0007', '0'), request('0007', 0, 'C2'),
    request('0007', 0, 'C1', 'image'), request('0007', 'new-photo', 'C1', 'image')];
  assert.equal(new Set(inputs.map(estimateReadKey)).size, inputs.length);
  assert.throws(() => estimateReadKey(request('', 1))); assert.throws(() => estimateReadKey(request('x', Infinity)));
});
test('NOT_LOADED to LOADING to READY deduplicates the same in-flight read', async t => {
  let calls = 0; const gate = deferred();
  const cache = cacheFor(t, { read: async r => { calls++; await gate.promise; return ready(r); } });
  assert.equal(cache.peek(request()).status, 'NOT_LOADED');
  const a = cache.load(request()), b = cache.load(request()); assert.equal(a, b);
  assert.equal(cache.peek(request()).status, 'LOADING'); await tick(); assert.equal(calls, 1);
  gate.resolve(); assert.equal((await a).status, 'READY'); assert.equal(await cache.load(request()), await a);
  assert.equal(calls, 1);
});
test('cached bodies are isolated from input mutations and shared as read-only values', async t => {
  const value = { quantity: 0, memo: '', rows: [{ rowId: '0001', price: -2 }] };
  const cache = cacheFor(t, { read: async r => ready(r, value) });
  const output = await cache.load(request()); value.rows[0].price = 99;
  assert.equal(output.value.rows[0].price, -2); assert.equal(output.value.quantity, 0); assert.equal(output.value.memo, '');
  assert.throws(() => { output.value.rows[0].price = 100; });
});
test('only explicit successful absence is NOT_FOUND and can be invalidated after creation', async t => {
  let calls = 0, found = false;
  const cache = cacheFor(t, { read: async r => { calls++; return found ? ready(r) : { status: 'NOT_FOUND' }; } });
  assert.equal((await cache.load(request())).status, 'NOT_FOUND'); await cache.load(request()); assert.equal(calls, 1);
  found = true; cache.invalidate(r => r.id === '0007'); assert.equal((await cache.load(request())).status, 'READY');
});
test('undefined/null/EMPTY/invalid READY are errors rather than empty estimates', async t => {
  for (const response of [undefined, null, { status: 'EMPTY' }, { status: 'READY', value: null }]) {
    const cache = cacheFor(t, { read: async () => response });
    assert.equal((await cache.load(request())).status, 'ERROR');
  }
});
test('read rejection is retryable and a failed promise is not reused forever', async t => {
  let calls = 0;
  const cache = cacheFor(t, { read: async r => { if (++calls === 1) throw new Error('quota/read error'); return ready(r); } });
  const failed = await cache.load(request()); assert.equal(failed.status, 'ERROR');
  assert.equal((await cache.load(request())).status, 'READY'); assert.equal(calls, 2);
});
test('wrong actual revision is STALE without exposing its body', async t => {
  const cache = cacheFor(t, { read: async () => ({ status: 'READY', revision: '0', value: { price: 10 } }) });
  const output = await cache.load(request()); assert.equal(output.status, 'STALE'); assert.ok(!('value' in output));
});
test('invalidate prevents a late old read from overwriting a new entry with the same key', async t => {
  const old = deferred(); let calls = 0;
  const cache = cacheFor(t, { read: async r => ++calls === 1 ? old.promise : ready(r, { version: 'new' }) });
  const pending = cache.load(request()); await tick(); cache.invalidate();
  assert.equal((await pending).status, 'STALE');
  assert.equal((await cache.load(request())).value.version, 'new');
  old.resolve(ready(request(), { version: 'old' })); await tick();
  assert.equal(cache.peek(request()).value.version, 'new');
});
test('cancelled physical reads retain concurrency permits until they really settle', async t => {
  const old = deferred(); let calls = 0;
  const cache = cacheFor(t, { maxConcurrent: 1, read: async r => { calls++; return calls === 1 ? old.promise : ready(r); } });
  const first = cache.load(request('A')); await tick(); cache.invalidate(r => r.id === 'A');
  const second = cache.load(request('B')); await tick();
  assert.equal((await first).status, 'STALE'); assert.equal(calls, 1); assert.equal(cache.stats().activeReads, 1);
  old.resolve(ready(request('A'))); assert.equal((await second).status, 'READY'); assert.equal(calls, 2);
});
test('timeout is ERROR, not NOT_FOUND, and a late response is never republished', async t => {
  const gate = deferred();
  const cache = cacheFor(t, { timeoutMs: 20, read: () => gate.promise });
  const output = await cache.load(request()); assert.equal(output.status, 'ERROR'); assert.equal(output.error.code, 'READ_TIMEOUT');
  gate.resolve(ready(request())); await tick(); assert.equal(cache.peek(request()).status, 'ERROR');
});
test('bounded full selection reads all selected IDs in order, not just a rendered subset', async t => {
  let active = 0, maximum = 0, calls = 0;
  const selected = new Set(Array.from({ length: 20 }, (_, i) => `E${i}`));
  const cache = cacheFor(t, { maxConcurrent: 4, read: async r => { calls++; active++; maximum = Math.max(maximum, active);
    await tick(); active--; return ready(r, { id: r.id }); } });
  const output = await cache.prepareSelectedEstimateBodies({ companyId: 'C1', selectedIds: selected });
  assert.equal(calls, 20); assert.equal(maximum, 4); assert.deepEqual(output.selectedIds, [...selected]);
  assert.deepEqual(output.results.map(r => r.estimateId), [...selected]); assert.ok(output.results.every(r => r.status === 'READY'));
});
test('empty selection causes zero reads and duplicate selected IDs are not extra targets', async t => {
  let calls = 0; const cache = cacheFor(t, { read: async r => { calls++; return ready(r); } });
  assert.deepEqual((await cache.prepareSelectedEstimateBodies({ companyId: 'C1', selectedIds: [] })).results, []); assert.equal(calls, 0);
  const output = await cache.prepareSelectedEstimateBodies({ companyId: 'C1', selectedIds: ['A', 'A', 'B'] });
  assert.deepEqual(output.selectedIds, ['A', 'B']); assert.equal(calls, 2);
});
test('selection/revision inputs are captured before await; invalidation never clears the caller Set', async t => {
  const gate = deferred(), selected = new Set(['A', 'B']), revisions = new Map([['A', 0], ['B', 1]]), seen = [];
  const cache = cacheFor(t, { read: async r => { seen.push(r); await gate.promise; return ready(r); } });
  const outputPromise = cache.prepareSelectedEstimateBodies({ companyId: 'C1', selectedIds: selected, revisions });
  selected.add('C'); revisions.set('A', 99); await tick(); gate.resolve();
  const output = await outputPromise; assert.deepEqual(output.selectedIds, ['A', 'B']); assert.equal(seen[0].revision, 0);
  cache.invalidate(); assert.deepEqual([...selected], ['A', 'B', 'C']);
});
test('caller generation change masks all late bodies, preserving caller-owned dirty work', async t => {
  const gate = deferred(); let current = true; const work = { memo: '새 한글 입력', dirty: true };
  const cache = cacheFor(t, { read: async r => { await gate.promise; return ready(r); } });
  const pending = cache.prepareSelectedEstimateBodies({ companyId: 'C1', selectedIds: ['A'], isCurrent: () => current });
  current = false; gate.resolve(); const output = await pending;
  assert.equal(output.results[0].status, 'STALE'); assert.ok(!('value' in output.results[0]));
  assert.deepEqual(work, { memo: '새 한글 입력', dirty: true });
});
test('photo intent invalidation and a new photo token reject the old photo result', async t => {
  const gate = deferred(); const old = request('DOC', 'old', 'C1', 'image'), next = request('DOC', 'new', 'C1', 'image');
  const cache = cacheFor(t, { read: async r => r.revision === 'old' ? gate.promise : ready(r, { dataUrl: 'data:new' }) });
  const pending = cache.load(old); await tick(); cache.invalidate(r => r.kind === 'image' && r.id === 'DOC');
  const output = await cache.load(next); gate.resolve(ready(old, { dataUrl: 'data:old' })); await tick();
  assert.equal((await pending).status, 'STALE'); assert.equal(output.value.dataUrl, 'data:new'); assert.equal(cache.peek(old).status, 'NOT_LOADED');
});
test('LRU eviction respects protected data, with honest over-budget statistics', async t => {
  const cache = cacheFor(t, { maxEntries: 1, maxBytes: 1, isProtected: r => r.id === 'active', read: async r => ready(r, { data: r.id.repeat(8) }) });
  await cache.load(request('active')); await tick(); await cache.load(request('inactive')); await tick();
  assert.equal(cache.peek(request('active')).status, 'READY'); assert.equal(cache.peek(request('inactive')).status, 'NOT_LOADED');
  assert.equal(cache.stats().protectedEntries, 1); assert.ok(cache.stats().estimatedPayloadBytes > 1);
});
test('Blob byte accounting and count eviction do not re-encode the photo', async t => {
  const cache = cacheFor(t, { maxEntries: 1, read: async r => ready(r, new Blob(['abcd'])) });
  const output = await cache.load(request('a', 0, 'C1', 'image')); await tick();
  assert.equal(await output.value.text(), 'abcd'); assert.equal(cache.stats().estimatedPayloadBytes, 4);
  await cache.load(request('b', 0, 'C1', 'image')); await tick();
  assert.equal(cache.stats().entries, 1); assert.equal(cache.stats().estimatedPayloadBytes, 4);
});
test('dispose settles queued callers, prevents new reads, and does not leak old results', async t => {
  const gate = deferred(); let calls = 0;
  const cache = cacheFor(t, { maxConcurrent: 1, read: async r => { calls++; await gate.promise; return ready(r); } });
  const a = cache.load(request('a')), b = cache.load(request('b')); await tick(); cache.dispose();
  assert.equal((await a).status, 'STALE'); assert.equal((await b).status, 'STALE');
  assert.equal((await cache.load(request('c'))).status, 'STALE'); gate.resolve(); await tick();
  assert.equal(calls, 1); assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().activeReads, 0);
});
test('invalid cache limits and unsupported kinds fail before touching the reader', () => {
  assert.throws(() => createEstimateReadCache({ read: () => {}, maxConcurrent: 0 }));
  assert.throws(() => createEstimateReadCache({ read: () => {}, timeoutMs: Infinity }));
  assert.throws(() => estimateReadKey({ ...request(), kind: 'master-write' }));
});

test('nested metadata cannot accidentally smuggle the body into its summary', () => {
  assert.throws(() => projectEstimateSummary({ estimateId: 'x', sortOrder: { draft: { rows: [1] } } }), /must be scalar/);
});
