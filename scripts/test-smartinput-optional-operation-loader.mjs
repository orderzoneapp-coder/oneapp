#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  OPTIONAL_OPERATION_ERROR_CODE,
  createHydrationWriteGate,
  createOptionalOperationLoader,
  createWriteResultTracker,
  mergeHydratedSnapshotPreservingLiveChanges
} from '../smartinput/optional-operation-loader.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

{
  const baseline = {
    columns: ['item', 'quantity'],
    widths: { order: { item: 100 } },
    untouched: 'default'
  };
  const live = {
    columns: ['item', 'quantity'],
    widths: { order: { item: 160 } },
    untouched: 'default'
  };
  const loaded = {
    columns: ['quantity', 'item'],
    widths: { order: { item: 120, quantity: 80 }, estimate: { item: 140 } },
    untouched: 'persisted'
  };
  assert.deepEqual(mergeHydratedSnapshotPreservingLiveChanges(baseline, live, loaded), {
    columns: ['quantity', 'item'],
    widths: { order: { item: 160, quantity: 80 }, estimate: { item: 140 } },
    untouched: 'persisted'
  }, 'late hydration must preserve only the live leaves changed since the read began');
}

{
  const baseline = {
    columns: ['item', 'quantity', 'memo'],
    customFields: [{ id: 'dispatch', label: '출고지시', enabled: true }],
    holidayDates: []
  };
  const live = {
    columns: ['quantity', 'item', 'memo'],
    customFields: [{ id: 'dispatch', label: '출고 요청', enabled: true }],
    holidayDates: ['2026-09-15']
  };
  const loaded = {
    columns: ['custom-price', 'item', 'quantity'],
    customFields: [
      { id: 'dispatch', label: '출고지시', enabled: false },
      { id: 'persisted-only', label: '기존 사용자 필드', enabled: true }
    ],
    holidayDates: ['2026-09-20']
  };
  assert.deepEqual(mergeHydratedSnapshotPreservingLiveChanges(baseline, live, loaded), {
    columns: ['quantity', 'custom-price', 'item'],
    customFields: [
      { id: 'dispatch', label: '출고 요청', enabled: false },
      { id: 'persisted-only', label: '기존 사용자 필드', enabled: true }
    ],
    holidayDates: ['2026-09-15', '2026-09-20']
  }, 'array changes made before hydration must preserve loaded-only fields and values');
}

{
  const baseline = { columns: ['item', 'quantity', 'memo'] };
  const live = { columns: ['quantity', 'item', 'memo'] };
  const loaded = { columns: ['quantity', 'memo'] };
  assert.deepEqual(mergeHydratedSnapshotPreservingLiveChanges(baseline, live, loaded), {
    columns: ['quantity', 'memo']
  }, 'an unrelated live reorder must not resurrect a baseline item already absent from persisted settings');
}

{
  const writes = [];
  let live = { columns: ['quantity', 'item'], customFields: [{ id: 'live', label: '현재' }] };
  const gate = createHydrationWriteGate({
    write: async snapshot => { writes.push(snapshot); },
    normalize: snapshot => snapshot
  });
  const pending = gate.persist(() => live);
  await Promise.resolve();
  assert.equal(writes.length, 0, 'a full settings snapshot must not write before initial hydration settles');
  live = {
    columns: ['quantity', 'persisted-only', 'item'],
    customFields: [{ id: 'live', label: '현재' }, { id: 'persisted-only', label: '기존' }]
  };
  gate.settleReady();
  assert.deepEqual(await pending, live);
  assert.deepEqual(writes, [live], 'the deferred write must capture the merged current settings, not its pre-hydration argument');

  const failedWrites = [];
  const failedGate = createHydrationWriteGate({ write: async snapshot => { failedWrites.push(snapshot); } });
  const rejected = failedGate.persist(() => ({ unsafe: true }));
  failedGate.settleError(new Error('fixture load failed'));
  await assert.rejects(rejected, /기존 자료를 불러오지 못해 변경 내용을 저장하지 않았습니다/);
  assert.equal(failedWrites.length, 0, 'a failed initial read must fail closed instead of overwriting unknown persisted settings');
  assert.equal(failedGate.beginRetry(), 'LOADING');
  const retryPersist = failedGate.persist(() => ({ recovered: true }));
  await Promise.resolve();
  assert.equal(failedWrites.length, 0, 'a retry cycle must still block writes until its own hydration succeeds');
  failedGate.settleReady();
  assert.deepEqual(await retryPersist, { recovered: true });
  assert.deepEqual(failedWrites, [{ recovered: true }], 'a successful retry cycle must restore guarded settings writes');
}

function timerHarness() {
  let sequence = 0;
  const timers = new Map();
  const cancelled = [];
  return {
    schedule(callback) {
      const id = ++sequence;
      timers.set(id, callback);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      timers.delete(id);
    },
    fire(id = [...timers.keys()][0]) {
      const callback = timers.get(id);
      timers.delete(id);
      callback?.();
    },
    get ids() { return [...timers.keys()]; },
    get cancelled() { return [...cancelled]; }
  };
}

function scriptHarness() {
  const scripts = [];
  const documentRef = {
    createElement(tagName) {
      assert.equal(tagName, 'script');
      return {
        dataset: {},
        removed: false,
        remove() { this.removed = true; }
      };
    },
    head: {
      append(script) { scripts.push(script); }
    }
  };
  return { documentRef, scripts };
}

{
  const timers = timerHarness();
  const dom = scriptHarness();
  const globalScope = {};
  const loader = createOptionalOperationLoader({
    globalScope,
    documentRef: dom.documentRef,
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  const spec = { feature: 'xlsx', assetVersion: '1.2.0', url: 'https://cdn.test/xlsx.js', globalName: 'XLSX' };
  const first = loader.loadScript(spec);
  const shared = loader.loadScript(spec);
  assert.equal(first, shared, 'same feature and asset version must share one in-flight script promise');
  assert.equal(dom.scripts.length, 1);
  globalScope.XLSX = { version: '1.2.0' };
  dom.scripts[0].onload();
  assert.equal(await first, globalScope.XLSX);
  assert.equal(timers.ids.length, 0, 'success must clean its timeout');
  assert.equal(await loader.loadScript(spec), globalScope.XLSX, 'loaded global must be reused');
}

{
  const timers = timerHarness();
  const dom = scriptHarness();
  const globalScope = {};
  const loader = createOptionalOperationLoader({
    globalScope,
    documentRef: dom.documentRef,
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  const spec = { feature: 'ocr', assetVersion: '6', url: 'https://cdn.test/ocr.js', globalName: 'Tesseract', unavailableMessage: 'OCR unavailable' };
  const timedOut = loader.loadScript(spec);
  const oldOnload = dom.scripts[0].onload;
  timers.fire();
  await assert.rejects(timedOut, error => error.code === OPTIONAL_OPERATION_ERROR_CODE.TIMEOUT);
  assert.equal(dom.scripts[0].removed, true);
  assert.equal(dom.scripts[0].onload, null, 'timeout must clean the old listener');

  const retry = loader.loadScript(spec);
  assert.equal(dom.scripts.length, 2, 'timeout must evict only its own failed attempt');
  oldOnload();
  assert.equal(dom.scripts.length, 2, 'late completion from attempt A must not replace attempt B');
  globalScope.Tesseract = { ready: true };
  dom.scripts[1].onload();
  assert.equal(await retry, globalScope.Tesseract);
}

{
  const timers = timerHarness();
  const dom = scriptHarness();
  const globalScope = {};
  const loader = createOptionalOperationLoader({
    globalScope,
    documentRef: dom.documentRef,
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  const spec = { feature: 'xlsx', assetVersion: '1.2.0', url: 'https://cdn.test/xlsx.js', globalName: 'XLSX' };
  const missing = loader.loadScript(spec);
  dom.scripts[0].onload();
  await assert.rejects(missing, error => error.code === OPTIONAL_OPERATION_ERROR_CODE.GLOBAL_MISSING);
  const retry = loader.loadScript(spec);
  assert.equal(dom.scripts.length, 2);
  globalScope.XLSX = { recovered: true };
  dom.scripts[1].onload();
  assert.equal(await retry, globalScope.XLSX, 'same verified asset must resume after the missing-global failure');
}

{
  const timers = timerHarness();
  let appendAttempts = 0;
  const loader = createOptionalOperationLoader({
    globalScope: {},
    documentRef: {
      createElement: () => ({ dataset: {}, remove() {} }),
      head: {
        append() {
          appendAttempts += 1;
          throw new Error('document rejected script');
        }
      }
    },
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  const spec = { feature: 'xlsx', assetVersion: '1.2.0', url: 'https://cdn.test/xlsx.js', globalName: 'XLSX' };
  await assert.rejects(loader.loadScript(spec), error => error.code === OPTIONAL_OPERATION_ERROR_CODE.NETWORK);
  await assert.rejects(loader.loadScript(spec), error => error.code === OPTIONAL_OPERATION_ERROR_CODE.NETWORK);
  assert.equal(appendAttempts, 2, 'a synchronous script insertion failure must not poison the retry cache');
  assert.equal(timers.ids.length, 0, 'a synchronous script insertion failure must clean its timeout');
}

{
  const timers = timerHarness();
  const imports = [];
  const failures = [
    Object.assign(new TypeError('Failed to fetch dynamically imported module'), { name: 'TypeError' }),
    Object.assign(new TypeError('module top-level execution failed'), { name: 'TypeError' })
  ];
  const loader = createOptionalOperationLoader({
    documentRef: null,
    schedule: timers.schedule,
    cancel: timers.cancel,
    importModule: async specifier => {
      imports.push(specifier);
      const error = failures.shift();
      if (error) throw error;
      return { ready: true };
    }
  });
  await assert.rejects(
    loader.loadModule({ feature: 'legacy', assetVersion: 'v1', specifier: './same.js' }),
    error => error.code === OPTIONAL_OPERATION_ERROR_CODE.NETWORK
  );
  await assert.rejects(
    loader.loadModule({ feature: 'legacy', assetVersion: 'v1', specifier: './same.js' }),
    error => error.code === OPTIONAL_OPERATION_ERROR_CODE.EVALUATION && error.retryable === false
  );
  assert.deepEqual(imports, ['./same.js', './same.js'], 'retry must keep the verified specifier and never add a random cache buster');
  assert.deepEqual(await loader.loadModule({ feature: 'legacy', assetVersion: 'v1', specifier: './same.js' }), { ready: true });
  assert.equal(imports.length, 3);
}

{
  const timers = timerHarness();
  const imports = new Map();
  const loader = createOptionalOperationLoader({
    documentRef: null,
    schedule: timers.schedule,
    cancel: timers.cancel,
    importModule: specifier => {
      const pending = deferred();
      imports.set(specifier, pending);
      return pending.promise;
    }
  });
  const versionOne = loader.loadModule({ feature: 'feature', assetVersion: 'v1', specifier: './module.js?v=1' });
  const versionTwo = loader.loadModule({ feature: 'feature', assetVersion: 'v2', specifier: './module.js?v=2' });
  await Promise.resolve();
  assert.equal(imports.size, 2, 'different asset versions must not share cache entries');
  imports.get('./module.js?v=1').resolve({ version: 1 });
  imports.get('./module.js?v=2').resolve({ version: 2 });
  assert.equal((await versionOne).version, 1);
  assert.equal((await versionTwo).version, 2);
}

{
  const loader = createOptionalOperationLoader({ documentRef: null });
  const oldToken = loader.beginOperation({ feature: 'file-intake', assetVersion: 'xlsx-1.2.0', workspaceEpoch: 3, inputGeneration: 7 });
  assert.equal(loader.isCurrent(oldToken, { workspaceEpoch: 3, inputGeneration: 7 }), true);
  const newToken = loader.beginOperation({ feature: 'file-intake', assetVersion: 'xlsx-1.2.0', workspaceEpoch: 3, inputGeneration: 8 });
  assert.equal(loader.isCurrent(oldToken, { workspaceEpoch: 3, inputGeneration: 8 }), false);
  assert.throws(
    () => loader.assertCurrent(oldToken, { workspaceEpoch: 3, inputGeneration: 8 }),
    error => error.code === OPTIONAL_OPERATION_ERROR_CODE.STALE
  );
  assert.equal(loader.assertCurrent(newToken, { workspaceEpoch: 3, inputGeneration: 8 }), newToken);
  loader.invalidateOperation('file-intake', { workspaceEpoch: 4, inputGeneration: 9 });
  assert.equal(loader.isCurrent(newToken, { workspaceEpoch: 4, inputGeneration: 9 }), false);
}

{
  const timers = timerHarness();
  const write = deferred();
  let executions = 0;
  let lookups = 0;
  const tracker = createWriteResultTracker({ schedule: timers.schedule, cancel: timers.cancel });
  const first = tracker.submit({
    feature: 'master-apply',
    commandId: 'CMD-1',
    timeoutMs: 10,
    execute: () => {
      executions += 1;
      return write.promise;
    }
  });
  timers.fire();
  await assert.rejects(first, error => error.code === OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN && error.commandId === 'CMD-1');
  await assert.rejects(
    tracker.submit({ feature: 'master-apply', commandId: 'CMD-1', timeoutMs: 10, execute: () => { executions += 1; } }),
    error => error.code === OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN
  );
  assert.equal(executions, 1, 'an unknown write must never be submitted again by a generic retry');
  await assert.rejects(
    tracker.resolveUnknown({
      feature: 'master-apply',
      commandId: 'CMD-1',
      lookup: async () => {
        lookups += 1;
        return { known: false };
      }
    }),
    error => error.code === OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN
  );
  assert.equal(lookups, 1);
  assert.deepEqual(await tracker.resolveUnknown({
    feature: 'master-apply',
    commandId: 'CMD-1',
    lookup: async () => ({ known: true, result: { committed: true } })
  }), { committed: true });
  assert.equal(executions, 1);
  write.resolve({ committed: true });
}

{
  const timers = timerHarness();
  const write = deferred();
  const lookup = deferred();
  const tracker = createWriteResultTracker({ schedule: timers.schedule, cancel: timers.cancel });
  const submitted = tracker.submit({
    feature: 'master-apply',
    commandId: 'CMD-RACE',
    timeoutMs: 10,
    execute: () => write.promise
  });
  timers.fire();
  await assert.rejects(submitted, error => error.code === OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN);
  const resolving = tracker.resolveUnknown({
    feature: 'master-apply',
    commandId: 'CMD-RACE',
    lookup: () => lookup.promise
  });
  write.resolve({ committed: 'late-response' });
  await write.promise;
  await Promise.resolve();
  lookup.resolve({ known: false });
  assert.deepEqual(await resolving, { committed: 'late-response' }, 'a late original success must win over an inconclusive receipt lookup');
  assert.equal(tracker.status({ feature: 'master-apply', commandId: 'CMD-RACE' }), 'COMMITTED');
}

{
  const timers = timerHarness();
  const firstWrite = deferred();
  let executions = 0;
  const tracker = createWriteResultTracker({ schedule: timers.schedule, cancel: timers.cancel });
  const first = tracker.submit({
    feature: 'official-voucher',
    commandId: 'CMD-SAME-ID',
    timeoutMs: 10,
    execute: () => {
      executions += 1;
      return firstWrite.promise;
    }
  });
  timers.fire();
  await assert.rejects(first, error => error.code === OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN);
  assert.equal(await tracker.resolveUnknown({
    feature: 'official-voucher',
    commandId: 'CMD-SAME-ID',
    lookup: async () => ({ known: false, safeToRetry: true })
  }), undefined, 'a successful receipt lookup may authorize only the same command ID for retry');
  const retried = tracker.submit({
    feature: 'official-voucher',
    commandId: 'CMD-SAME-ID',
    timeoutMs: 10,
    execute: async ({ commandId }) => {
      executions += 1;
      return { commandId, committed: true };
    }
  });
  assert.deepEqual(await retried, { commandId: 'CMD-SAME-ID', committed: true });
  assert.equal(executions, 2, 'the retry must reuse the immutable original command identity');
  firstWrite.resolve({ commandId: 'CMD-SAME-ID', committed: true, late: true });
}

console.log('SmartInput optional-operation timeout, retry, stale-result, and unknown-write contracts passed.');
