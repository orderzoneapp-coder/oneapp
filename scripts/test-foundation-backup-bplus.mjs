#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ORDERQ_DB_VERSION, V17_STORE_DEFINITIONS } from '../orderq/orderq-v17-contracts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.failAppend = false; }
  getLastRow() { return this.rows.length; }
  getRange(row, column, rowCount, columnCount) {
    return {
      getValues: () => Array.from({ length: rowCount }, (_, rowIndex) => Array.from({ length: columnCount }, (_, columnIndex) => this.rows[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? '')),
      setValues: values => values.forEach((source, rowIndex) => {
        const targetIndex = row - 1 + rowIndex;
        this.rows[targetIndex] ||= [];
        source.forEach((value, columnIndex) => { this.rows[targetIndex][column - 1 + columnIndex] = value; });
      })
    };
  }
  appendRow(row) {
    if (this.failAppend) throw new Error('INJECTED_APPEND_FAILURE');
    this.rows.push(row.slice());
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new FakeSheet(name); this.sheets.set(name, sheet); return sheet; }
}

let uuid = 0;
const context = {
  console, Date, JSON, Set, Map, Object, Array, String, Number, Boolean, Math, RegExp, Error,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(value).digest()).map(byte => byte > 127 ? byte - 256 : byte),
    getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
  },
  splitTextBySize: (value, size) => Array.from({ length: Math.ceil(value.length / size) || 1 }, (_, index) => value.slice(index * size, (index + 1) * size)),
  getOrCreateSheet: (spreadsheet, name) => spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name)
};
vm.createContext(context);
vm.runInContext(read('foundation-backup.gs'), context, { filename: 'foundation-backup.gs' });

const auth = companyId => ({
  allowedScope: { companyId }, roleIds: ['FOUNDATION_READ', 'FOUNDATION_WRITE'],
  nexusRequest: { subjectUserId: 'USR-ADMIN', subjectLoginId: 'admin@example.test' }
});
const schemaVersion = 'FOUNDATION_BACKUP_V1';
const deviceId = 'DEV-00000000-0000-4000-8000-000000000001';

function productRequest(baseServerRevision, suffix, products = [{ productId: 'PROD-1', 코드: 'P1', 품목코드: 'P1', 품목명: '상품1' }]) {
  const snapshot = { products };
  return {
    schemaVersion, domainType: 'PRODUCT', backupKind: 'PRODUCT_SNAPSHOT',
    backupId: `BKP-PRODUCT-00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    deviceId, baseServerRevision, localRevision: suffix, primaryEpoch: 1,
    recordCount: products.length, contentHash: context.foundationBackupHash(snapshot), snapshot
  };
}

const ss = new FakeSpreadsheet();
context.foundationBackupDeviceRegister(ss, { schemaVersion, deviceId, displayName: 'Office PC' }, auth('COMPANY-A'));
const promoted = context.foundationBackupDevicePromote(ss, { schemaVersion, deviceId, expectedPrimaryEpoch: 0, reason: 'initial' }, auth('COMPANY-A'));
assert.equal(promoted.primaryEpoch, 1);

const firstRequest = productRequest(0, 1);
const first = context.foundationBackupWrite(ss, firstRequest, auth('COMPANY-A'), 'PRODUCT_SNAPSHOT');
assert.equal(first.status, 'ACKED');
assert.equal(first.serverRevision, 1);
const replay = context.foundationBackupWrite(ss, firstRequest, auth('COMPANY-A'), 'PRODUCT_SNAPSHOT');
assert.equal(replay.replayed, true);
assert.equal(replay.serverRevision, 1, 'idempotent replay must not consume a revision');

const sameHash = context.foundationBackupWrite(ss, productRequest(1, 2), auth('COMPANY-A'), 'PRODUCT_SNAPSHOT');
assert.equal(sameHash.duplicateContent, true);
assert.equal(sameHash.serverRevision, 1, 'same Head hash must not create an immutable duplicate');

const second = context.foundationBackupWrite(ss, productRequest(1, 3, [{ productId: 'PROD-1', 코드: 'P1', 품목코드: 'P1', 품목명: '상품1 변경' }]), auth('COMPANY-A'), 'PRODUCT_SNAPSHOT');
assert.equal(second.serverRevision, 2);
const stale = context.foundationBackupWrite(ss, productRequest(1, 4, [{ productId: 'PROD-2', 코드: 'P2', 품목코드: 'P2' }]), auth('COMPANY-A'), 'PRODUCT_SNAPSHOT');
assert.deepEqual(JSON.parse(JSON.stringify(stale)), {
  status: 'DIVERGED', code: 'BACKUP_BASE_REVISION_STALE', backupId: stale.backupId,
  domainType: 'PRODUCT', headRevision: 2
});
const ahead = context.foundationBackupWrite(ss, productRequest(3, 5, [{ productId: 'PROD-3', 코드: 'P3', 품목코드: 'P3' }]), auth('COMPANY-A'), 'PRODUCT_SNAPSHOT');
assert.equal(ahead.status, 'REVISION_AHEAD_INVALID');
assert.equal(ahead.code, 'BACKUP_BASE_REVISION_AHEAD');
assert.equal(context.foundationBackupLatestHead(ss, 'COMPANY-A', 'PRODUCT').serverRevision, 2, 'rejected writes must not advance Head');

const repairSs = new FakeSpreadsheet();
context.foundationBackupDeviceRegister(repairSs, { schemaVersion, deviceId, displayName: 'Repair PC' }, auth('COMPANY-REPAIR'));
context.foundationBackupDevicePromote(repairSs, { schemaVersion, deviceId, expectedPrimaryEpoch: 0, reason: 'repair test' }, auth('COMPANY-REPAIR'));
const repairHeadSheet = repairSs.insertSheet('FoundationBackupHead');
repairHeadSheet.failAppend = true;
const repairRequest = productRequest(0, 31, [{ productId: 'PROD-R', 코드: 'PR', 품목코드: 'PR', 품목명: '복구상품' }]);
assert.throws(() => context.foundationBackupWrite(repairSs, repairRequest, auth('COMPANY-REPAIR'), 'PRODUCT_SNAPSHOT'), /INJECTED_APPEND_FAILURE/);
assert.equal(context.foundationBackupLatestHead(repairSs, 'COMPANY-REPAIR', 'PRODUCT'), null, 'failed Head append must not expose a partial Head');
repairHeadSheet.failAppend = false;
const repaired = context.foundationBackupWrite(repairSs, repairRequest, auth('COMPANY-REPAIR'), 'PRODUCT_SNAPSHOT');
assert.equal(repaired.status, 'ACKED');
assert.equal(repaired.replayed, true);
assert.equal(context.foundationBackupLatestHead(repairSs, 'COMPANY-REPAIR', 'PRODUCT').serverRevision, 1, 'retry must repair a verified immutable Version before ACK');

const wrongHash = productRequest(2, 6);
wrongHash.contentHash = '0'.repeat(64);
assert.throws(() => context.foundationBackupWrite(ss, wrongHash, auth('COMPANY-A'), 'PRODUCT_SNAPSHOT'), /BACKUP_HASH_MISMATCH/);
assert.throws(() => context.foundationBackupWrite(ss, { ...productRequest(2, 7), primaryEpoch: 2 }, auth('COMPANY-A'), 'PRODUCT_SNAPSHOT'), /PRIMARY_EPOCH_STALE/);
assert.throws(() => context.foundationBackupWrite(ss, productRequest(0, 8), auth('COMPANY-B'), 'PRODUCT_SNAPSHOT'), /PRIMARY_DEVICE_REQUIRED/);

const customerSnapshot = {
  customers: [{ customerId: 'CU-1', customerCode: 'C1', customerName: '거래처1', revision: 1 }],
  aliases: [{ mappingId: 'CA-1', customerId: 'CU-1', alias: '거래처1' }],
  sourceLinks: [], headerMappings: [], userFieldDefinitions: [], events: []
};
const customerSnapshotRequest = {
  schemaVersion, domainType: 'CUSTOMER', backupKind: 'CUSTOMER_SNAPSHOT',
  backupId: 'BKP-CUSTOMER-SNAPSHOT-00000000-0000-4000-8000-000000000001',
  deviceId, baseServerRevision: 0, localRevision: 1, primaryEpoch: 1,
  recordCount: 1, contentHash: context.foundationBackupHash(customerSnapshot), snapshot: customerSnapshot
};
const customerSeed = context.foundationBackupWrite(ss, customerSnapshotRequest, auth('COMPANY-A'), 'CUSTOMER_SNAPSHOT');
assert.equal(customerSeed.serverRevision, 1);
const events = [{ eventId: 'CE-1', customerId: 'CU-1', eventType: 'UPDATED', entityRevision: 2, previousEntityRevision: 1, localRevision: 2, occurredAt: '2026-08-28T00:00:00.000Z', payload: { after: { customerId: 'CU-1', revision: 2 } } }];
const customerEventRequest = {
  schemaVersion, domainType: 'CUSTOMER', backupKind: 'CUSTOMER_EVENTS',
  backupId: 'BKP-CUSTOMER-EVENTS-00000000-0000-4000-8000-000000000001',
  deviceId, baseServerRevision: 1, localRevision: 2, primaryEpoch: 1,
  recordCount: 1, contentHash: context.foundationBackupHash({ events }), events
};
const eventAck = context.foundationBackupWrite(ss, customerEventRequest, auth('COMPANY-A'), 'CUSTOMER_EVENTS');
assert.equal(eventAck.serverRevision, 2);
assert.throws(() => context.foundationBackupWrite(ss, {
  ...customerEventRequest,
  backupId: 'BKP-CUSTOMER-EVENTS-00000000-0000-4000-8000-000000000002',
  baseServerRevision: 2,
  events: [{ ...events[0], eventId: 'CE-2', entityRevision: 4, previousEntityRevision: 3 }],
  contentHash: context.foundationBackupHash({ events: [{ ...events[0], eventId: 'CE-2', entityRevision: 4, previousEntityRevision: 3 }] })
}, auth('COMPANY-A'), 'CUSTOMER_EVENTS'), /CUSTOMER_EVENT_SEQUENCE_CONFLICT/);

const listed = context.foundationBackupVersionList(ss, { schemaVersion, domainType: 'CUSTOMER', limit: 10 }, auth('COMPANY-A'));
assert.deepEqual(Array.from(listed, row => row.serverRevision), [2, 1]);
const restored = context.foundationBackupVersionRead(ss, { schemaVersion, domainType: 'CUSTOMER', serverRevision: 1 }, auth('COMPANY-A'));
assert.equal(restored.contentHash, customerSnapshotRequest.contentHash);
assert.equal(restored.payload.customers[0].customerId, 'CU-1');

assert.equal(context.foundationBackupRevisionDecision(4, 3).status, 'DIVERGED');
assert.equal(context.foundationBackupRevisionDecision(4, 4).status, 'ACCEPT');
assert.equal(context.foundationBackupRevisionDecision(4, 5).status, 'REVISION_AHEAD_INVALID');

assert.equal(ORDERQ_DB_VERSION, 17);
assert.deepEqual(V17_STORE_DEFINITIONS.map(row => row.name), [
  'foundationBackupOutbox', 'foundationRecoverySnapshots', 'foundationRecoveryAudit', 'foundationLegacyQuarantine'
]);

const [gateway, code, customerMaster, customerBackup, core, productClient, partner] = [
  'nexus/server/nexus-auth-gateway.gs', 'code.gs', 'orderq/customer-master.js',
  'orderq/customer-foundation-backup.js', 'coreEngine.js', 'nexus/foundation/foundation-backup.js', 'partner_db.html'
].map(read);
for (const operation of [
  'foundation.backup.head_read', 'foundation.backup.product_write', 'foundation.backup.customer_events_write',
  'foundation.backup.customer_snapshot_write', 'foundation.backup.version_list', 'foundation.backup.version_read',
  'foundation.backup.restore_audit_write', 'foundation.device.status_read', 'foundation.device.register', 'foundation.device.promote'
]) assert.match(gateway, new RegExp(operation.replaceAll('.', '\\.')));
assert.match(code, /foundationBackupWrite\(ss, payload, foundationAuth, 'PRODUCT_SNAPSHOT'\)/);
assert.match(code, /foundationBackupWrite\(ss, payload, foundationAuth, 'CUSTOMER_EVENTS'\)/);
assert.doesNotMatch(customerMaster, /const sync = await synchronizeCustomerMaster\(\)/, 'empty local customer DB must not auto-pull');
assert.doesNotMatch(customerMaster, /syncPromise = synchronizeCustomerMaster\(\)/, 'populated local customer DB must not auto-pull');
assert.match(customerMaster, /source: 'RESTORE_REQUIRED'/);
assert.match(customerBackup, /QUARANTINED_LEGACY_SYNC/);
assert.match(customerBackup, /prepareCustomerFoundationEvent/);
assert.match(customerBackup, /activeSnapshot/, 'Customer Snapshot retries must retain one idempotent backupId');
assert.match(customerBackup, /hasNewerLocal/, 'an older Snapshot ACK must not clear newer local backup work');
assert.match(customerBackup, /ensureCustomerFoundationState/, 'an existing local Customer DB must become the legacy local baseline without an automatic pull');
assert.match(core, /prepareProductCommit/);
assert.match(productClient, /BPLUS_AUTO_PULL_DISABLED: true/);
assert.match(partner, /서버에서 복구/);
assert.match(partner, /현재 장치를 Primary로/);

console.log('ONEAPP NEXUS Foundation B+ backup, lineage, device, quarantine and restore contracts: PASS');
