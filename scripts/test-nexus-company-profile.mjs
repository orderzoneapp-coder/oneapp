#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'company-profile.gs'), 'utf8');
let uuidSequence = 0;
class MockRange {
  constructor(sheet, row, column, rows = 1, columns = 1) { Object.assign(this, { sheet, row, column, rows, columns }); }
  getValues() { return Array.from({ length: this.rows }, (_, r) => Array.from({ length: this.columns }, (_, c) => this.sheet.values[this.row - 1 + r]?.[this.column - 1 + c] ?? '')); }
  setValues(values) {
    if (this.sheet.failNextSet) { this.sheet.failNextSet = false; throw new Error('MOCK_SET_FAILURE'); }
    values.forEach((valuesRow, r) => valuesRow.forEach((value, c) => {
      const target = this.row - 1 + r;
      while (this.sheet.values.length <= target) this.sheet.values.push([]);
      this.sheet.values[target][this.column - 1 + c] = value;
    }));
    return this;
  }
}
class MockSheet {
  constructor(name) { this.name = name; this.values = []; this.failNextAppend = false; this.failNextSet = false; }
  getName() { return this.name; }
  getLastRow() { return this.values.reduce((last, row, index) => row.some(value => value !== '') ? index + 1 : last, 0); }
  getLastColumn() { return this.values.reduce((last, row) => Math.max(last, row.length), 0); }
  getRange(row, column, rows = 1, columns = 1) { return new MockRange(this, row, column, rows, columns); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { if (this.failNextAppend) { this.failNextAppend = false; throw new Error('MOCK_APPEND_FAILURE'); } this.values.push(row.slice()); return this; }
  clearContents() { this.values = []; return this; }
  deleteRow(row) { this.values.splice(row - 1, 1); }
}
class MockSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new MockSheet(name); this.sheets.set(name, sheet); return sheet; }
}

const context = vm.createContext({
  console,
  sha256Hex: value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex'),
  getOrCreateSheet: (ss, name) => ss.getSheetByName(name) || ss.insertSheet(name),
  Utilities: { getUuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}` }
});
new vm.Script(source, { filename: 'company-profile.gs' }).runInContext(context);
const plain = value => JSON.parse(JSON.stringify(value));
const scope = { companyId: 'ONEAPP' };
const request = (overrides = {}) => ({
  scope, requestId: `REQ-${String(uuidSequence + 1).padStart(36, '0')}`,
  roleIds: ['FOUNDATION_READ', 'FOUNDATION_WRITE', 'COMPANY_ADMIN'],
  nexusRequest: { requestId: `REQ-${String(uuidSequence + 1).padStart(36, '0')}`, subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.profile_write', contractVersion: 'NEXUS_AUTH_V2' },
  ...overrides
});
const admin = { roleIds: ['FOUNDATION_READ', 'FOUNDATION_WRITE'] };
const reader = { roleIds: ['FOUNDATION_READ'] };

assert.equal(context.companyProfileValidBusinessNumber_('380-14-01523'), true);
assert.equal(context.companyProfileValidBusinessNumber_('380-14-01524'), false);
assert.throws(() => context.companyProfileNormalizeChanges_({ businessNumber: '380-14-01524' }), /COMPANY_BUSINESS_NUMBER_INVALID/);
assert.throws(() => context.companyProfileNormalizeChanges_({ closingCycle: '13' }), /COMPANY_CLOSING_CYCLE_INVALID/);
assert.throws(() => context.companyProfileNormalizeChanges_({ companyPhone: 'not-a-phone' }), /COMPANY_PHONE_INVALID/);
assert.throws(() => context.companyProfileNormalizeChanges_({ revision: 8 }), /COMPANY_FIELD_DENIED/);
assert.deepEqual(plain(context.companyProfileNormalizeChanges_({ businessTypes: [' 도매 및 소매업 ', '도매 및 소매업'], unitTaxationEnabled: false })), { businessTypes: ['도매 및 소매업'], unitTaxationEnabled: false });
const migrationValues = vm.runInContext('COMPANY_PROFILE_MIGRATION_VALUES', context);
assert.equal(migrationValues.jointBusinessEnabled, null);
assert.equal(migrationValues.unitTaxationEnabled, false);
assert.deepEqual(plain(migrationValues.businessTypes), ['도매 및 소매업']);
assert.deepEqual(plain(migrationValues.businessItems), ['전자상거래 소매업', '상품 중개업']);
assert.equal(migrationValues.postalCode1, '05699');
assert.equal(migrationValues.address1, '서울특별시 송파구 양재대로 932, 9층 19호 (가락동, 가락동 농수산물도매시장)');
assert(!Object.hasOwn(migrationValues, 'establishedDate'), 'unprovided values must not be part of the migration patch');

const ss = new MockSpreadsheet();
assert.deepEqual(plain(context.companyProfileGet(ss, request())), { schemaVersion: 'NEXUS_COMPANY_PROFILE_V1', status: 'EMPTY', profile: null, accountingPeriods: [] });
assert.throws(() => context.companyProfileWrite(ss, request({ expectedRevision: 0, changes: { companyName: '원앱' } }), reader), /COMPANY_ADMIN_REQUIRED/);

let written = context.companyProfileWrite(ss, request({ expectedRevision: 0, changes: {
  companyName: '원앱', businessNumber: '380-14-01523', representativeName: '이무철', establishedDate: '2020-02-03',
  businessTypes: ['도매 및 소매업'], businessItems: ['전자상거래 소매업', '상품 중개업'], jointBusinessEnabled: null, unitTaxationEnabled: false
} }), admin).profile;
assert.equal(written.revision, 1);
assert.equal(written.businessNumber, '3801401523');
assert.equal(written.unitTaxationEnabled, false);
assert.equal(written.jointBusinessEnabled, null);
assert.equal(context.companyProfileGet(ss, request()).status, 'READY');
assert.throws(() => context.companyProfileWrite(ss, request({ expectedRevision: 0, changes: { companyName: '충돌' } }), admin), /COMPANY_REVISION_CONFLICT/);

written = context.companyProfileWrite(ss, request({ expectedRevision: 1, changes: { companyPhone: '02-1234-5678' } }), admin).profile;
assert.equal(written.revision, 2);
assert.equal(written.establishedDate, '2020-02-03', 'partial writes preserve unprovided fields');
assert.deepEqual(plain(written.businessItems), ['전자상거래 소매업', '상품 중개업']);

let periodResult = context.companyProfileAccountingWrite(ss, request({ nexusRequest: { requestId: 'REQ-PERIOD-1', subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.accounting_period_write', contractVersion: 'NEXUS_AUTH_V2' }, expectedRevision: 2, operation: 'UPSERT', period: { periodId: '', revision: 0, periodNumber: 1, startDate: '2026-01-01', endDate: '2026-12-31', enabled: true } }), admin);
assert.equal(periodResult.profileRevision, 3);
assert.equal(periodResult.accountingPeriods.length, 1);
assert.throws(() => context.companyProfileAccountingWrite(ss, request({ nexusRequest: { requestId: 'REQ-PERIOD-2', subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.accounting_period_write', contractVersion: 'NEXUS_AUTH_V2' }, expectedRevision: 3, operation: 'UPSERT', period: { periodId: '', revision: 0, periodNumber: 2, startDate: '2026-12-01', endDate: '2027-12-31', enabled: true } }), admin), /COMPANY_PERIOD_OVERLAP/);
assert.throws(() => context.companyProfileAccountingWrite(ss, request({ nexusRequest: { requestId: 'REQ-PERIOD-3', subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.accounting_period_write', contractVersion: 'NEXUS_AUTH_V2' }, expectedRevision: 3, operation: 'UPSERT', period: { periodId: '', revision: 0, periodNumber: 2, startDate: '2027-12-31', endDate: '2027-01-01', enabled: true } }), admin), /COMPANY_PERIOD_RANGE_INVALID/);

const certificateRequest = { requestId: 'REQ-CERTIFICATE-1', subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.certificate_extract', contractVersion: 'NEXUS_AUTH_V2' };
const safeExtraction = context.companyProfileCertificateExtract(request({ nexusRequest: certificateRequest, extraction: {
  extractedFields: { companyName: '원앱', businessNumber: '380-14-01523', unitTaxationEnabled: false },
  fieldConfidence: { companyName: .91, businessNumber: .95, unitTaxationEnabled: .8 },
  sourceLabels: { companyName: '상호' }, documentSignals: ['BUSINESS_REGISTRATION_CERTIFICATE', 'BUSINESS_NUMBER']
} }), admin);
assert.equal(safeExtraction.extractedFields.businessNumber, '3801401523');
assert.equal(safeExtraction.extractedFields.unitTaxationEnabled, false);
assert.throws(() => context.companyProfileCertificateExtract(request({ nexusRequest: certificateRequest, extraction: { extractedFields: { companyName: '원앱' }, rawText: '생년월일 900101-1234567', documentSignals: ['BUSINESS_REGISTRATION_CERTIFICATE'] } }), admin), /COMPANY_CERTIFICATE_SENSITIVE_DATA_DENIED/);
assert.throws(() => context.companyProfileCertificateExtract(request({ roleIds: ['FOUNDATION_READ'], nexusRequest: certificateRequest, extraction: { extractedFields: { companyName: '원앱' }, documentSignals: ['BUSINESS_REGISTRATION_CERTIFICATE'] } }), reader), /COMPANY_ADMIN_REQUIRED/);

const backup = context.companyProfileBackupCreate(ss, request({ nexusRequest: { requestId: 'REQ-BACKUP-1', subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.backup_create', contractVersion: 'NEXUS_AUTH_V2' } }), admin);
assert.match(backup.backupId, /^CB-/);
assert.equal(backup.revision, 3);
assert.match(backup.digest, /^[a-f0-9]{64}$/);

const migrationSs = new MockSpreadsheet();
context.companyProfileWrite(migrationSs, request({ expectedRevision: 0, changes: { companyName: '기존명', businessNumber: '380-14-01523', representativeName: '기존 대표', establishedDate: '2020-02-03', companyPhone: '02-9999-0000' } }), admin);
const migrationPayload = request({ nexusRequest: { requestId: 'REQ-MIGRATE-1', subjectUserId: 'USR-OWNER', subjectLoginId: 'owner', appId: 'company', operationId: 'company.migrate_oneapp', contractVersion: 'NEXUS_AUTH_V2' }, taskId: 'NEXUS-COMPANY-20260827-01', deploymentCommit: 'a'.repeat(40) });
const firstMigration = context.companyProfileMigrateOneapp(migrationSs, migrationPayload, admin);
assert.equal(firstMigration.status, 'APPLIED');
assert.equal(firstMigration.profile.revision, 2);
assert.equal(firstMigration.profile.companyName, '원앱');
assert.equal(firstMigration.profile.establishedDate, '2020-02-03', 'migration preserves unprovided existing fields');
assert.equal(firstMigration.profile.companyPhone, '02-9999-0000');
const afterUserEdit = context.companyProfileWrite(migrationSs, request({ expectedRevision: 2, changes: { companyPhone: '02-8888-0000', companyName: '사용자 수정명' } }), admin).profile;
assert.equal(afterUserEdit.revision, 3);
const duplicateMigration = context.companyProfileMigrateOneapp(migrationSs, migrationPayload, admin);
assert.equal(duplicateMigration.status, 'ALREADY_APPLIED');
assert.equal(duplicateMigration.revision, 2, 'ledger reports the originally applied revision');
const afterDuplicate = context.companyProfileGet(migrationSs, request()).profile;
assert.equal(afterDuplicate.revision, 3, 'rerun must not increment revision');
assert.equal(afterDuplicate.companyName, '사용자 수정명', 'rerun must not overwrite later user changes');
assert.equal(afterDuplicate.companyPhone, '02-8888-0000');

const migrationFailureSs = new MockSpreadsheet();
context.companyProfileWrite(migrationFailureSs, request({ expectedRevision: 0, changes: { companyName: '마이그레이션 전', businessNumber: '380-14-01523', representativeName: '기존 대표', establishedDate: '2020-02-03' } }), admin);
const migrationSheet = context.companyProfileSheet_(migrationFailureSs, 'MIGRATIONS');
migrationSheet.failNextAppend = true;
assert.throws(() => context.companyProfileMigrateOneapp(migrationFailureSs, migrationPayload, admin), /MOCK_APPEND_FAILURE/);
const migrationFailureRestored = context.companyProfileGet(migrationFailureSs, request()).profile;
assert.equal(migrationFailureRestored.companyName, '마이그레이션 전', 'failed migration restores the previous profile');
assert.equal(migrationFailureRestored.revision, 1, 'failed migration does not advance revision');
assert.equal(migrationSheet.getLastRow(), 1, 'failed migration leaves no applied marker');

const atomicSs = new MockSpreadsheet();
context.companyProfileWrite(atomicSs, request({ expectedRevision: 0, changes: { companyName: '원본', businessNumber: '380-14-01523', representativeName: '이무철' } }), admin);
const auditSheet = atomicSs.getSheetByName('CompanyAudit_NEXUS');
auditSheet.failNextAppend = true;
assert.throws(() => context.companyProfileWrite(atomicSs, request({ expectedRevision: 1, changes: { companyName: '실패값' } }), admin), /MOCK_APPEND_FAILURE/);
const restored = context.companyProfileGet(atomicSs, request()).profile;
assert.equal(restored.companyName, '원본', 'failed write must restore the prior profile snapshot');
assert.equal(restored.revision, 1, 'failed write must not advance revision');
assert.equal(auditSheet.getLastRow(), 2, 'failed audit append must leave no partial row');

console.log('NEXUS company profile server contract passed (migration, revision, audit, atomicity, permissions, accounting and certificate validation).');
