#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'code.gs'), 'utf8');
const properties = new Map();
const digestBytes = value => [...crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest()];
const context = vm.createContext({
  console: { info() {}, warn() {}, error() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, String(value)) }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, value) => digestBytes(value), getUuid: () => '12345678-1234-1234-1234-123456789abc'
  }
});
new vm.Script(source, { filename: 'code.gs' }).runInContext(context);

const tokenDigest = raw => crypto.createHash('sha256').update(raw).digest('hex');
const ephemeral = { read: crypto.randomBytes(32).toString('hex'), write: crypto.randomBytes(32).toString('hex'), retired: crypto.randomBytes(32).toString('hex'), wrong: crypto.randomBytes(32).toString('hex') };
const binding = ({ raw = ephemeral.read, status = 'ACTIVE', roles = ['FOUNDATION_READ'], id = 'FOUNDATION-READ-1', retiredAt } = {}) => ({
  credentialId: id, version: 'V2', tokenDigest: tokenDigest(raw), actorId: 'NEXUS_GATEWAY', roleIds: roles,
  allowedScope: { companyId: 'ONEAPP' }, status, createdAt: '2026-08-01T00:00:00.000Z',
  activatedAt: '2026-08-01T00:00:00.000Z', retiredAt: retiredAt ?? (status === 'RETIRED' ? '2026-08-20T00:00:00.000Z' : '')
});
const request = raw => ({
  action: 'nexus_gateway_foundation_master_get', token: raw, actorId: 'NEXUS_GATEWAY', scope: { companyId: 'ONEAPP' },
  nexusRequest: { contractVersion: 'NEXUS_AUTH_V2', requestId: 'REQ-1', subjectUserId: 'USR-1', subjectLoginId: 'tester', appId: 'master', operationId: 'foundation.master_read' }
});

properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([binding()]));
assert.equal(context.oneappNexusGatewayRequire(request(ephemeral.read), 'FOUNDATION', 'READ').credentialId, 'FOUNDATION-READ-1');
assert.throws(() => context.oneappNexusGatewayRequire(request(ephemeral.wrong), 'FOUNDATION', 'READ'), /ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED/);
properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([{ ...binding(), tokenDigest: 'abc' }]));
assert.throws(() => context.oneappNexusGatewayRequire(request(ephemeral.read), 'FOUNDATION', 'READ'), /ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED/, 'non-64-character digest must be rejected before comparison');
properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([binding()]));
assert.throws(() => context.oneappNexusGatewayRequire({ ...request(ephemeral.read), actorId: 'FORGED' }, 'FOUNDATION', 'READ'), /ONEAPP_NEXUS_GATEWAY_ACTOR_DENIED/);
assert.throws(() => context.oneappNexusGatewayRequire(request(ephemeral.read), 'FOUNDATION', 'WRITE'), /ONEAPP_NEXUS_GATEWAY_ROLE_DENIED/);

for (const boundary of ['FOUNDATION', 'DATAOPS', 'ORDERQ', 'SHIPPING']) {
  properties.set(`ONEAPP_NEXUS_GATEWAY_${boundary}_BINDINGS_JSON`, JSON.stringify([
    binding({ raw: ephemeral.read, roles: [`${boundary}_READ`], id: `${boundary}-READ-ONLY` })
  ]));
  assert.throws(() => context.oneappNexusGatewayRequire(request(ephemeral.read), boundary, 'WRITE'), /ONEAPP_NEXUS_GATEWAY_ROLE_DENIED/,
    `${boundary} READ credential must not authorize WRITE`);
}

properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([
  binding({ raw: ephemeral.write, roles: ['FOUNDATION_WRITE', 'FOUNDATION_REPLACE'], id: 'FOUNDATION-WRITE-1' })
]));
assert.equal(context.oneappNexusGatewayRequire(request(ephemeral.write), 'FOUNDATION', 'WRITE').credentialId, 'FOUNDATION-WRITE-1');
assert.equal(context.oneappNexusGatewayRequire(request(ephemeral.write), 'FOUNDATION', 'READ').credentialId, 'FOUNDATION-WRITE-1', 'WRITE service permission includes READ');
properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([
  binding({ raw: ephemeral.retired, status: 'RETIRED', roles: ['FOUNDATION_READ'], id: 'FOUNDATION-RETIRED-1' })
]));
assert.throws(() => context.oneappNexusGatewayRequire(request(ephemeral.retired), 'FOUNDATION', 'READ'), /ONEAPP_NEXUS_GATEWAY_BINDING_RETIRED/,
  'RETIRED binding must never authenticate');
properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([
  binding({ raw: ephemeral.retired, status: 'RETIRING', roles: ['FOUNDATION_READ'], id: 'FOUNDATION-RETIRING-1', retiredAt: '2099-08-20T00:00:00.000Z' })
]));
assert.equal(context.oneappNexusGatewayRequire(request(ephemeral.retired), 'FOUNDATION', 'READ').credentialId, 'FOUNDATION-RETIRING-1',
  'RETIRING binding remains valid until its retirement deadline');
properties.set('ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON', JSON.stringify([
  binding({ raw: ephemeral.retired, status: 'RETIRING', roles: ['FOUNDATION_READ'], id: 'FOUNDATION-RETIRING-EXPIRED', retiredAt: '2026-08-20T00:00:00.000Z' })
]));
assert.throws(() => context.oneappNexusGatewayRequire(request(ephemeral.retired), 'FOUNDATION', 'READ'), /ONEAPP_NEXUS_GATEWAY_BINDING_RETIRED/,
  'expired RETIRING binding must be rejected');

class MockRange {
  constructor(sheet, row, column, rows = 1, columns = 1) { Object.assign(this, { sheet, row, column, rows, columns }); }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) => Array.from({ length: this.columns }, (_, c) => this.sheet.values[this.row - 1 + r]?.[this.column - 1 + c] ?? ''));
  }
  setValues(values) {
    if (this.sheet.failNextWrite) { this.sheet.failNextWrite = false; throw new Error('MOCK_MID_CHUNK_FAILURE'); }
    values.forEach((sourceRow, r) => sourceRow.forEach((value, c) => {
      const targetRow = this.row - 1 + r;
      while (this.sheet.values.length <= targetRow) this.sheet.values.push([]);
      this.sheet.values[targetRow][this.column - 1 + c] = value;
    }));
    return this;
  }
  getValue() { return this.getValues()[0][0]; }
  setValue(value) { return this.setValues([[value]]); }
}
class MockSheet {
  constructor(name, values = []) { this.name = name; this.values = values.map(row => [...row]); this.failNextWrite = false; }
  getLastRow() { return this.values.reduce((last, row, index) => row.some(value => value !== '') ? index + 1 : last, 0); }
  getLastColumn() { return this.values.reduce((last, row) => Math.max(last, row.length), 0); }
  getRange(row, column, rows, columns) {
    if (typeof row === 'string') {
      const match = /^([A-Z]+)(\d+)$/.exec(row); if (!match) throw new Error('MOCK_RANGE_INVALID');
      return new MockRange(this, Number(match[2]), match[1].charCodeAt(0) - 64, 1, 1);
    }
    return new MockRange(this, row, column, rows, columns);
  }
  clearContents() { this.values = []; return this; }
}
class MockSpreadsheet {
  constructor(seed) { this.sheets = new Map(Object.entries(seed).map(([name, values]) => [name, new MockSheet(name, values)])); this.failSheetName = ''; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new MockSheet(name); sheet.failNextWrite = name === this.failSheetName; this.sheets.set(name, sheet); return sheet; }
}
const snapshot = spreadsheet => Object.fromEntries([...spreadsheet.sheets].map(([name, sheet]) => [name, sheet.values.map(row => [...row])]));
const initial = {
  MasterDB: [['OLD-1', JSON.stringify({ 코드: 'OLD-1', 품목명: '기존' })]],
  HistoryLogs: [[JSON.stringify({ id: 'OLD-HISTORY' })]],
  AppConfig: [['legacy', JSON.stringify({ keep: true })]]
};

const failing = new MockSpreadsheet(initial);
const beforeFailure = snapshot(failing);
failing.failSheetName = 'HistoryLogs_NEXUS_B';
properties.set('ONEAPP_NEXUS_FOUNDATION_ACTIVE_SLOT', 'A');
assert.throws(() => context.oneappNexusFoundationReplaceAll(failing, {
  transactionId: 'NXTX-12345678-1234-1234-1234-123456789abc',
  master: [{ 코드: 'NEW-1', 품목명: '신규' }], history: [{ id: 'NEW-HISTORY' }], config: { changed: true }
}), /ONEAPP_NEXUS_REPLACE_STAGING_FAILED/);
assert.equal(properties.get('ONEAPP_NEXUS_FOUNDATION_ACTIVE_SLOT'), 'A', 'failed staging must not change the active pointer');
assert.deepEqual(snapshot(failing).MasterDB, beforeFailure.MasterDB, 'failed staging must not mutate active master data');
assert.deepEqual(snapshot(failing).HistoryLogs, beforeFailure.HistoryLogs, 'failed staging must not mutate active history data');
assert.deepEqual(snapshot(failing).AppConfig, beforeFailure.AppConfig, 'failed staging must not mutate active config data');
assert.equal(context.readMasterData(failing)['OLD-1'].품목명, '기존', 'active reads must continue to serve the previous data');

const successful = new MockSpreadsheet(initial);
properties.set('ONEAPP_NEXUS_FOUNDATION_ACTIVE_SLOT', 'A');
const receipt = context.oneappNexusFoundationReplaceAll(successful, {
  transactionId: 'NXTX-12345678-1234-1234-1234-123456789abc',
  master: [{ 코드: 'NEW-1', 품목명: '신규' }, { 코드: 'NEW-2', 품목명: '신규2' }],
  history: [{ id: 'NEW-HISTORY' }], config: { changed: true }
});
assert.equal(receipt.status, 'ACTIVATED');
assert.equal(properties.get('ONEAPP_NEXUS_FOUNDATION_ACTIVE_SLOT'), 'B');
assert.equal(receipt.masterCount, 2);
assert.equal(context.readMasterData(successful)['OLD-1'], undefined);
assert.equal(context.readMasterData(successful)['NEW-2'].품목명, '신규2');
assert.throws(() => context.oneappNexusFoundationReplaceAll(new MockSpreadsheet(initial), { transactionId: 'FORGED', master: [], history: [] }), /ONEAPP_NEXUS_TRANSACTION_ID_INVALID/);
assert.throws(() => context.oneappNexusFoundationReplaceAll(new MockSpreadsheet(initial), {
  transactionId: 'NXTX-12345678-1234-1234-1234-123456789abc', master: [{ 코드: 'DUP' }, { 코드: 'DUP' }], history: []
}), /ONEAPP_NEXUS_MASTER_DUPLICATE_CODE/);

const gatewaySource = fs.readFileSync(path.join(process.cwd(), 'nexus/server/nexus-auth-gateway.gs'), 'utf8');
const gatewayContext = vm.createContext({});
new vm.Script(gatewaySource).runInContext(gatewayContext);
const registry = gatewayContext.nexusAuthGatewayRegistry_();
assert.equal(registry['foundation.replace_begin'], undefined);
assert.equal(registry['foundation.replace_chunk'], undefined);
assert.equal(registry['foundation.replace_commit'], undefined);
assert(!registry['foundation.replace_all'].allowedFields.includes('transactionId'), 'browser cannot forge transaction order/id');

console.log('NEXUS_AUTH_V2 mock integration passed (binding rotation, READ/WRITE isolation, inactive-slot staging, activation, forgery denial).');
