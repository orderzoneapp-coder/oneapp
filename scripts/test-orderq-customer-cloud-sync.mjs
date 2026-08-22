#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCustomerMasterSyncCoordinator, shouldPreserveLocalEntityChange } from '../orderq/customer-master-sync.js';

const localPending = { customerId: 'LOCAL-1', customerName: '진주8번' };
const cloudCustomers = Array.from({ length: 140 }, (_, index) => ({
  entityType: 'CUSTOMER', entityId: index === 0 ? 'LOCAL-1' : `CLOUD-${index}`,
  payload: { customerId: index === 0 ? 'LOCAL-1' : `CLOUD-${index}`, customerName: `Cloud ${index}` }
}));
for (const status of ['PENDING', 'RETRY', 'CONFLICT']) {
  const queue = [{ entityType: 'CUSTOMER', entityId: 'LOCAL-1', status }];
  const safelyPulled = cloudCustomers.filter(change => !shouldPreserveLocalEntityChange(queue, change)).map(change => change.payload);
  const merged = [localPending, ...safelyPulled];
  assert.equal(merged.length, 140, `local ${status} + Cloud 140 must produce the shared 140-customer list`);
  assert.equal(merged.find(row => row.customerId === 'LOCAL-1').customerName, '진주8번', `${status} local-only value must not be overwritten`);
}

const calls = [];
let releasePush;
const firstPush = new Promise(resolve => { releasePush = resolve; });
let pushCount = 0;
const coordinator = createCustomerMasterSyncCoordinator({
  isConfigured: () => true,
  push: async () => { calls.push('push'); pushCount++; if (pushCount === 1) await firstPush; return { applied: 1, errors: 0, conflicts: 0 }; },
  pull: async () => { calls.push('pull'); return { applied: 139 }; }
});
const first = coordinator.synchronize();
const second = coordinator.synchronize();
assert.equal(first, second, 'concurrent requests must share one flight');
releasePush();
await first;
assert.deepEqual(calls, ['push', 'pull', 'push', 'pull'], 'a request during a flight must receive one trailing push/pull pass');

const failureCalls = [];
const failedPush = new Error('offline push');
const failureCoordinator = createCustomerMasterSyncCoordinator({
  isConfigured: () => true,
  push: async () => { failureCalls.push('push'); throw failedPush; },
  pull: async () => { failureCalls.push('pull'); return { applied: 140 }; }
});
const failure = await failureCoordinator.synchronize();
assert.equal(failure.pushError, failedPush);
assert.equal(failure.pull.applied, 140, 'safe Cloud rows must still pull after a push failure');
assert.deepEqual(failureCalls, ['push', 'pull']);

const pullFailure = new Error('offline pull');
const pullFailureResult = await createCustomerMasterSyncCoordinator({
  isConfigured: () => true,
  push: async () => ({ applied: 1, conflicts: 1 }),
  pull: async () => { throw pullFailure; }
}).synchronize();
assert.equal(pullFailureResult.pullError, pullFailure);
assert.equal(pullFailureResult.push.conflicts, 1, 'conflict result must be preserved when pull fails');

let offlineCalled = false;
const offline = await createCustomerMasterSyncCoordinator({
  isConfigured: () => false,
  push: async () => { offlineCalled = true; },
  pull: async () => { offlineCalled = true; }
}).synchronize();
assert.equal(offline.configured, false);
assert.equal(offlineCalled, false, 'Cloud-unconfigured mode must remain local-only');

const [service, engine, ui, html] = await Promise.all([
  readFile(new URL('../orderq/customer-master.js', import.meta.url), 'utf8'),
  readFile(new URL('../orderq/orderq-sync-engine.js', import.meta.url), 'utf8'),
  readFile(new URL('../orderq/customer-master-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../partner_db.html', import.meta.url), 'utf8')
]);
assert.match(engine, /shouldPreserveLocalEntityChange/, 'pending/retry/conflict records must guard local entities');
assert.match(engine, /if \(await entityHasUnsyncedChange\(change\.entityType, change\.entityId\)\) return false/, 'pull must not overwrite an unsynced local entity');
assert.match(service, /synchronizeCustomerMaster/);
assert.match(ui, /await reload\(\);[\s\S]*ensureCustomerMasterReady/, 'local cache must render before entry synchronization');
assert.match(ui, /await syncAndReload\(\)/, 'manual and Excel applies must synchronize and reload');
assert.match(html, /customerCloudSyncState/);
assert.match(html, /대기 0 · 재시도\/실패 0 · 충돌 0/);

console.log('ORDER Q Customer Cloud synchronization: PASS');
