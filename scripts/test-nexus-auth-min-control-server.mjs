import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile('nexus/server/nexus-auth-gateway.gs', 'utf8');

class FakeRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    Object.assign(this, { sheet, row, column, rowCount, columnCount });
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => Array.from(
      { length: this.columnCount },
      (_, columnOffset) => this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? '',
    ));
  }

  setValues(values) {
    values.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
      const targetRow = this.row - 1 + rowOffset;
      this.sheet.rows[targetRow] ||= [];
      this.sheet.rows[targetRow][this.column - 1 + columnOffset] = value;
    }));
    return this;
  }

  setValue(value) {
    return this.setValues([[value]]);
  }
}

class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = structuredClone(rows);
  }

  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map((row) => row.length)); }
  getRange(row, column, rowCount, columnCount) { return new FakeRange(this, row, column, rowCount, columnCount); }
  appendRow(row) { this.rows.push(structuredClone(row)); }
}

class FakeDatabase {
  constructor(id, sheetRows) {
    this.id = id;
    this.sheets = new Map(Object.entries(sheetRows).map(([name, rows]) => [name, new FakeSheet(name, rows)]));
    this.copies = [];
  }

  getId() { return this.id; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  getSheets() { return [...this.sheets.values()]; }
  insertSheet(name) { const sheet = new FakeSheet(name); this.sheets.set(name, sheet); return sheet; }
  deleteSheet(sheet) { this.sheets.delete(sheet.getName()); }
  copy(name) {
    const copy = new FakeDatabase(`backup-${this.copies.length + 1}`, Object.fromEntries(
      [...this.sheets].map(([sheetName, sheet]) => [sheetName, sheet.rows]),
    ));
    copy.name = name;
    this.copies.push(copy);
    return copy;
  }
}

const legacyUsersHeaders = [
  'userId', 'loginId', 'displayName', 'role', 'permissionsJson', 'passwordSalt', 'passwordHash', 'status',
  'createdAt', 'createdBy', 'updatedAt', 'deletedAt', 'recoverUntil', 'inviteDigest', 'inviteExpiresAt', 'version',
];
const usersHeaders = [...legacyUsersHeaders, 'visibleAppIdsJson'];
const sessionsHeaders = ['sessionDigest', 'userId', 'issuedAt', 'expiresAt', 'lastSeenAt', 'revokedAt', 'device'];
const auditHeaders = ['auditId', 'at', 'actorUserId', 'action', 'targetUserId', 'result', 'detailJson'];
const rateHeaders = ['key', 'windowStart', 'count', 'blockedUntil'];
const now = new Date().toISOString();

const userRow = (value) => usersHeaders.map((header) => value[header] ?? '');
const database = new FakeDatabase('auth-db', {
  Users: [
    usersHeaders,
    userRow({ userId: 'USR-OWNER', loginId: 'owner', displayName: 'Owner', role: 'OWNER_MASTER', permissionsJson: '[]', passwordSalt: 'owner-salt-123456', passwordHash: 'owner-hash', status: 'ACTIVE', createdAt: now, createdBy: 'BOOTSTRAP', updatedAt: now, version: 1, visibleAppIdsJson: '' }),
    userRow({ userId: 'USR-ACTIVE', loginId: 'worker', displayName: 'Worker', role: 'VIEWER', permissionsJson: '[]', passwordSalt: 'worker-salt-12345', passwordHash: 'worker-hash', status: 'ACTIVE', createdAt: now, createdBy: 'USR-OWNER', updatedAt: now, version: 3, visibleAppIdsJson: '["customer-master","smart-input"]' }),
  ],
  Sessions: [sessionsHeaders],
  Audit: [auditHeaders],
  RateLimits: [rateHeaders],
});

const properties = new Map([
  ['NEXUS_AUTH_DB_ID', database.id],
  ['NEXUS_AUTH_PEPPER', 'test-pepper-not-production'],
]);
const state = { database, uuid: 0 };
const signedBytes = (buffer) => [...buffer].map((value) => value > 127 ? value - 256 : value);
const digest = (value) => signedBytes(crypto.createHash('sha256').update(String(value)).digest());
const hmac = (value, key) => signedBytes(crypto.createHmac('sha256', String(key)).update(String(value)).digest());

const context = vm.createContext({
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  Array,
  String,
  Boolean,
  RegExp,
  encodeURIComponent,
  decodeURIComponent,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) || null,
      setProperty: (key, value) => { properties.set(key, String(value)); },
      deleteProperty: (key) => { properties.delete(key); },
    }),
  },
  SpreadsheetApp: {
    openById: () => state.database,
    create: () => state.database,
    flush: () => {},
  },
  LockService: {
    getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
  },
  Utilities: {
    Charset: { UTF_8: 'UTF_8' },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: () => `uuid-${++state.uuid}`,
    computeDigest: (_algorithm, value) => digest(value),
    computeHmacSha256Signature: (value, key) => hmac(value, key),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((value) => value < 0 ? value + 256 : value)).toString('base64url'),
  },
  ContentService: {
    MimeType: { JSON: 'JSON' },
    createTextOutput: (value) => ({ value, setMimeType() { return this; } }),
  },
  UrlFetchApp: { fetch: () => { throw new Error('network forbidden in isolated test'); } },
});
vm.runInContext(source, context, { filename: 'nexus-auth-gateway.gs' });

const owner = () => context.nexusAuthFindUserById_('USR-OWNER');
const ownerContext = () => ({ user: owner(), session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });
const expectCode = (fn, code) => assert.throws(fn, (error) => error?.message === code, code);
const sheetSnapshot = (name) => structuredClone(state.database.getSheetByName(name).rows);

assert.equal(context.NEXUS_AUTH_VERSION, 'NEXUS_AUTH_V2');
assert.equal(context.nexusAuthSessionView_(ownerContext()).user.visibleAppsConfigured, false);
assert.equal(context.nexusAuthSessionView_(ownerContext()).user.visibleAppIds.length, 12);
expectCode(() => context.nexusAuthAdminUsers_({ user: { role: 'VIEWER', status: 'ACTIVE' } }), 'NEXUS_AUTH_ADMIN_DENIED');

const created = context.nexusAuthAdminUserCreate_(ownerContext(), {
  action: 'nexus_admin_user_create',
  sessionToken: 'opaque',
  loginId: 'new.user',
  displayName: '새 사용자',
  visibleAppIds: ['customer-master', 'smart-input'],
});
assert.equal(created.user.accountType, 'DELEGATED_USER');
assert.equal(created.user.status, 'SUSPENDED');
assert.equal(created.user.visibleAppsConfigured, true);
assert.deepEqual(Array.from(created.user.visibleAppIds), ['customer-master', 'smart-input']);
assert.match(created.activationCode, /^ACT-/);
assert.doesNotMatch(JSON.stringify(sheetSnapshot('Users')), new RegExp(created.activationCode));
assert.doesNotMatch(JSON.stringify(sheetSnapshot('Audit')), new RegExp(created.activationCode));

const beforeInvalidCreate = sheetSnapshot('Users');
expectCode(() => context.nexusAuthAdminUserCreate_(ownerContext(), {
  action: 'nexus_admin_user_create', sessionToken: 'opaque', loginId: 'invalid.apps', displayName: 'Invalid',
  visibleAppIds: ['smart-input', 'smart-input'],
}), 'NEXUS_AUTH_VISIBLE_APPS_INVALID');
assert.deepEqual(sheetSnapshot('Users'), beforeInvalidCreate);

const beforeConflict = sheetSnapshot('Users');
expectCode(() => context.nexusAuthAdminUserUpdate_(ownerContext(), {
  action: 'nexus_admin_user_update', sessionToken: 'opaque', userId: 'USR-ACTIVE', expectedVersion: 2,
  displayName: 'Conflict', visibleAppIds: [],
}), 'NEXUS_AUTH_VERSION_CONFLICT');
assert.deepEqual(sheetSnapshot('Users'), beforeConflict);

const updated = context.nexusAuthAdminUserUpdate_(ownerContext(), {
  action: 'nexus_admin_user_update', sessionToken: 'opaque', userId: 'USR-ACTIVE', expectedVersion: 3,
  displayName: 'Worker Updated', visibleAppIds: [],
});
assert.equal(updated.version, 4);
assert.equal(updated.visibleAppsConfigured, true);
assert.deepEqual(Array.from(updated.visibleAppIds), []);

const activeSession = ['session-digest', 'USR-ACTIVE', now, new Date(Date.now() + 60_000).toISOString(), now, '', 'test'];
state.database.getSheetByName('Sessions').appendRow(activeSession);
const suspended = context.nexusAuthAdminUserSuspend_(ownerContext(), {
  action: 'nexus_admin_user_suspend', sessionToken: 'opaque', userId: 'USR-ACTIVE', expectedVersion: 4,
});
assert.equal(suspended.status, 'SUSPENDED');
assert.ok(state.database.getSheetByName('Sessions').rows[1][5], 'suspend must revoke the existing session');
expectCode(() => context.nexusAuthAdminUserSuspend_(ownerContext(), {
  action: 'nexus_admin_user_suspend', sessionToken: 'opaque', userId: 'USR-OWNER', expectedVersion: 1,
}), 'NEXUS_AUTH_MASTER_IMMUTABLE');

const restored = context.nexusAuthAdminUserRestore_(ownerContext(), {
  action: 'nexus_admin_user_restore', sessionToken: 'opaque', userId: 'USR-ACTIVE', expectedVersion: 5,
});
assert.equal(restored.status, 'ACTIVE');
assert.equal(restored.version, 6);

const createdSuspended = created.user;
const reissued = context.nexusAuthAdminActivationReissue_(ownerContext(), {
  action: 'nexus_admin_activation_reissue', sessionToken: 'opaque', userId: createdSuspended.userId, expectedVersion: 1,
});
assert.match(reissued.activationCode, /^ACT-/);
assert.notEqual(reissued.activationCode, created.activationCode);
assert.doesNotMatch(JSON.stringify(sheetSnapshot('Users')), new RegExp(reissued.activationCode));
expectCode(() => context.nexusAuthAdminDeprecated_(ownerContext()), 'NEXUS_AUTH_ACTION_DEPRECATED');
assert.equal(context.nexusAuthPurgeExpiredUsers_(), 0);

const actions = state.database.getSheetByName('Audit').rows.slice(1).map((row) => row[3]);
for (const required of ['USER_CREATE', 'USER_DISPLAY_NAME_CHANGE', 'USER_VISIBLE_APPS_CHANGE', 'USER_SUSPEND', 'USER_RESTORE', 'USER_ACTIVATION_REISSUE']) {
  assert.ok(actions.includes(required), `missing audit action ${required}`);
}

const legacyDataRow = legacyUsersHeaders.map((header) => ({ userId: 'LEGACY-1', loginId: 'legacy', displayName: 'Legacy', role: 'VIEWER', status: 'ACTIVE', version: 7 })[header] ?? '');
const legacyDatabase = new FakeDatabase('legacy-db', {
  Users: [legacyUsersHeaders, legacyDataRow],
  Sessions: [sessionsHeaders, ['digest', 'LEGACY-1', now, now, now, '', 'device']],
  Audit: [auditHeaders, ['AUD-1', now, 'SYSTEM', 'LOGIN_SUCCESS', 'LEGACY-1', 'SUCCESS', '{}']],
  RateLimits: [rateHeaders, ['key', now, 0, '']],
});
state.database = legacyDatabase;
properties.set('NEXUS_AUTH_DB_ID', legacyDatabase.id);
properties.delete('NEXUS_AUTH_LAST_DATA_BACKUP_AT');
properties.delete('NEXUS_AUTH_LAST_DATA_BACKUP_DIGEST');
const legacyRowsBefore = structuredClone(legacyDatabase.getSheetByName('Users').rows.slice(1));
expectCode(() => context.nexusAuthMigrateVisibleApps(), 'NEXUS_AUTH_BACKUP_REQUIRED');
const backup = context.nexusAuthCreatePredeployBackup();
assert.equal(backup.backupCreated, true);
assert.equal(backup.schema.Users.schemaVersion, 'LEGACY_V24');
assert.equal(legacyDatabase.copies.length, 1);
const migration = context.nexusAuthMigrateVisibleApps();
assert.equal(migration.migrated, true);
assert.equal(legacyDatabase.getSheetByName('Users').rows[0].at(-1), 'visibleAppIdsJson');
assert.deepEqual(legacyDatabase.getSheetByName('Users').rows.slice(1), legacyRowsBefore, 'migration must not rewrite rows');
assert.equal(context.nexusAuthMigrateVisibleApps().idempotent, true);

const conflictingDatabase = new FakeDatabase('conflict-db', {
  Users: [[...legacyUsersHeaders, 'unexpectedColumn'], legacyDataRow],
  Sessions: [sessionsHeaders], Audit: [auditHeaders], RateLimits: [rateHeaders],
});
state.database = conflictingDatabase;
properties.set('NEXUS_AUTH_DB_ID', conflictingDatabase.id);
const conflictBefore = sheetSnapshot('Users');
expectCode(() => context.nexusAuthCreatePredeployBackup(), 'NEXUS_AUTH_USERS_SCHEMA_CONFLICT');
assert.deepEqual(sheetSnapshot('Users'), conflictBefore, 'header conflict must be read-only');

console.log('NEXUS auth minimal-control isolated server contracts passed.');
