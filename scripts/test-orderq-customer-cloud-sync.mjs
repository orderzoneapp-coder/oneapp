#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [service, engine, ui, html, backup, db, contract] = await Promise.all([
  read('orderq/customer-master.js'),
  read('orderq/orderq-sync-engine.js'),
  read('orderq/customer-master-ui.js'),
  read('partner_db.html'),
  read('orderq/customer-foundation-backup.js'),
  read('orderq/orderq-db.js'),
  import('../orderq/orderq-v17-contracts.js')
]);

assert.doesNotMatch(service, /pullRemote/, 'Customer Master service must not import or invoke automatic server Pull');
assert.doesNotMatch(service, /syncPromise = synchronizeCustomerMaster/, 'populated local cache must not start background Pull');
assert.doesNotMatch(service, /const sync = await synchronizeCustomerMaster/, 'empty local cache must not use server data automatically');
assert.match(service, /source: 'RESTORE_REQUIRED'/, 'empty local cache must require explicit administrator restore');
assert.match(service, /source: 'LOCAL_PRIMARY'/, 'local Customer Master must remain the operational source');
assert.match(service, /backupCustomerEventsNow/, 'manual synchronization entry must mean one-way backup only');

assert.match(backup, /QUARANTINED_LEGACY_SYNC/, 'legacy Customer synchronization rows must be quarantined');
assert.match(backup, /localOnly: true/, 'quarantined legacy rows must never be replayed by the old push engine');
assert.match(backup, /prepareCustomerFoundationEvent/, 'Customer mutation and B+ Outbox preparation must share one transaction');
assert.match(backup, /CUSTOMER_EVENTS/);
assert.match(backup, /CUSTOMER_SNAPSHOT/);
assert.match(backup, /previewCustomerRestore/);
assert.match(backup, /CUSTOMER_RESTORE_ADMIN_APPROVAL_REQUIRED/);
assert.match(backup, /QUARANTINED_PRE_RESTORE/, 'unsynced local changes must be preserved during an approved restore');
assert.match(backup, /backupCustomerSnapshotNow\(true\)/, 'a new server lineage must start from a verified Customer Snapshot');

assert.match(engine, /if \(await entityHasUnsyncedChange\(change\.entityType, change\.entityId\)\) return false/, 'non-Customer legacy pulls must still preserve unsynced entities');
assert.equal(contract.ORDERQ_DB_VERSION, 17);
for (const name of ['foundationBackupOutbox', 'foundationRecoverySnapshots', 'foundationRecoveryAudit', 'foundationLegacyQuarantine']) {
  assert.ok(contract.V17_STORE_DEFINITIONS.some(row => row.name === name), `missing v17 store ${name}`);
}
assert.match(db, /\.\.\.V17_STORE/);

assert.match(ui, /startCustomerFoundationWorker/);
assert.match(ui, /서버에 더 최신 버전 있음 · 관리자 확인 필요/);
assert.match(ui, /서버 또는 계보 이상 · 별도 복구 필요/);
assert.match(ui, /previewCustomerRestore/);
assert.match(ui, /applyCustomerRestore/);
assert.match(html, /customerBackupNow/);
assert.match(html, /customerRestoreFromServer/);
assert.match(html, /customerPromoteDevice/);
assert.doesNotMatch(html, /Cloud 연결됨/);

console.log('ORDER Q Customer B+ local-primary backup and administrator restore: PASS');
