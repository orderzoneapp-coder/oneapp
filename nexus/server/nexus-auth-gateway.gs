/**
 * ONEAPP NEXUS authentication and business-token gateway.
 *
 * Deploy this file as a standalone Apps Script Web App that executes as the
 * owner. It intentionally lives outside the bound ONEAPP business project:
 * browser sessions reach this gateway, and only the gateway reaches the
 * retained business Web App with server-held credentials.
 */

var NEXUS_AUTH_VERSION = 'NEXUS_AUTH_V2';
var NEXUS_AUTH_LEGACY_VERSION = 'LEGACY_V1';
var NEXUS_AUTH_APP_CONTEXT_VERSION = 'NEXUS_APP_CONTEXT_V1';
var NEXUS_AUTH_SESSION_CONTEXT_VERSION = 'NEXUS_SESSION_CONTEXT_V1';
var NEXUS_AUTH_DEFAULT_UPSTREAM_URL = 'https://script.google.com/macros/s/AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw/exec';
var NEXUS_AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
var NEXUS_AUTH_CLIENT_CONTEXT_TTL_MS = 5 * 60 * 1000;
var NEXUS_AUTH_INVITE_TTL_MS = 72 * 60 * 60 * 1000;
var NEXUS_AUTH_RECOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var NEXUS_AUTH_LOGIN_WINDOW_MS = 10 * 60 * 1000;
var NEXUS_AUTH_LOGIN_LIMIT = 8;
var NEXUS_AUTH_ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000;
var NEXUS_AUTH_VISIBLE_APP_IDS = Object.freeze([
  'master-lookup', 'customer-master', 'merchops', 'smart-input', 'orderops', 'dataops',
  'smart-parser', 'export-center', 'settings', 'item-manager', 'history-viewer', 'orderq-vnext'
]);
var NEXUS_AUTH_PROPERTIES = Object.freeze({
  DB_ID: 'NEXUS_AUTH_DB_ID',
  PEPPER: 'NEXUS_AUTH_PEPPER',
  BOOTSTRAP_DIGEST: 'NEXUS_AUTH_BOOTSTRAP_DIGEST',
  BOOTSTRAP_EXPIRES_AT: 'NEXUS_AUTH_BOOTSTRAP_EXPIRES_AT',
  LAST_DATA_BACKUP_AT: 'NEXUS_AUTH_LAST_DATA_BACKUP_AT',
  LAST_DATA_BACKUP_DIGEST: 'NEXUS_AUTH_LAST_DATA_BACKUP_DIGEST',
  UPSTREAM_URL: 'NEXUS_AUTH_UPSTREAM_URL',
  FOUNDATION_READ: 'NEXUS_AUTH_SECRET_FOUNDATION_READ',
  FOUNDATION_WRITE: 'NEXUS_AUTH_SECRET_FOUNDATION_WRITE',
  DATAOPS_READ: 'NEXUS_AUTH_SECRET_DATAOPS_READ',
  DATAOPS_WRITE: 'NEXUS_AUTH_SECRET_DATAOPS_WRITE',
  ORDERQ_READ: 'NEXUS_AUTH_SECRET_ORDERQ_READ',
  ORDERQ_WRITE: 'NEXUS_AUTH_SECRET_ORDERQ_WRITE',
  SHIPPING_READ: 'NEXUS_AUTH_SECRET_SHIPPING_READ',
  SHIPPING_WRITE: 'NEXUS_AUTH_SECRET_SHIPPING_WRITE',
  LEGACY_DATAOPS_PUBLISH: 'NEXUS_AUTH_SECRET_DATAOPS_PUBLISH',
  LEGACY_ORDERQ: 'NEXUS_AUTH_SECRET_ORDERQ',
  LEGACY_SHIPPING: 'NEXUS_AUTH_SECRET_SHIPPING'
});
var NEXUS_AUTH_SHEETS = Object.freeze({
  USERS: 'Users',
  SESSIONS: 'Sessions',
  AUDIT: 'Audit',
  RATE: 'RateLimits'
});
var NEXUS_AUTH_USERS_LEGACY_HEADERS = Object.freeze([
  'userId', 'loginId', 'displayName', 'role', 'permissionsJson', 'passwordSalt', 'passwordHash', 'status',
  'createdAt', 'createdBy', 'updatedAt', 'deletedAt', 'recoverUntil', 'inviteDigest', 'inviteExpiresAt', 'version'
]);
var NEXUS_AUTH_HEADERS = Object.freeze({
  Users: NEXUS_AUTH_USERS_LEGACY_HEADERS.concat(['visibleAppIdsJson']),
  Sessions: ['sessionDigest', 'userId', 'issuedAt', 'expiresAt', 'lastSeenAt', 'revokedAt', 'device'],
  Audit: ['auditId', 'at', 'actorUserId', 'action', 'targetUserId', 'result', 'detailJson'],
  RateLimits: ['key', 'windowStart', 'count', 'blockedUntil']
});
var NEXUS_AUTH_ALL_PERMISSIONS = Object.freeze([
  'foundation.read', 'foundation.write', 'foundation.replace',
  'customer.read', 'customer.write', 'shipping.read', 'shipping.write',
  'merchops.read', 'merchops.write',
  'dataops.read', 'dataops.write', 'dataops.publish', 'dataops.close',
  'orderq.read', 'orderq.write', 'orderq.admin',
  'smartinput.use', 'admin.users', 'admin.services', 'admin.audit', 'admin.company'
]);
var NEXUS_AUTH_BUSINESS_PERMISSIONS = Object.freeze(NEXUS_AUTH_ALL_PERMISSIONS.filter(function (permission) {
  return permission.indexOf('admin.') !== 0;
}));
var NEXUS_AUTH_PROFILE_PERMISSIONS = Object.freeze({
  FULL_ACCESS: NEXUS_AUTH_BUSINESS_PERMISSIONS,
  VIEWER: ['foundation.read', 'customer.read', 'merchops.read', 'dataops.read', 'orderq.read', 'shipping.read', 'smartinput.use'],
  CUSTOM: []
});

function doPost(e) {
  try {
    var payload = nexusAuthParseBody_(e);
    var action = nexusAuthText_(payload.action);
    if (!action) throw new Error('NEXUS_AUTH_ACTION_REQUIRED');
    if (action === 'nexus_gateway') return nexusAuthGateway_(payload);
    if (action === 'nexus_proxy') return nexusAuthProxy_(payload);
    var data = nexusAuthDispatch_(action, payload);
    return nexusAuthJson_({ status: 'success', action: action, data: data });
  } catch (error) {
    var response = { status: 'error', message: nexusAuthPublicError_(error) };
    if (Number.isFinite(Number(error && error.latestRevision))) response.latestRevision = Number(error.latestRevision);
    return nexusAuthJson_(response);
  }
}

function doGet() {
  return nexusAuthJson_({
    status: 'success',
    action: 'nexus_auth_health',
    data: { contractVersion: NEXUS_AUTH_VERSION, ready: nexusAuthIsInitialized_() }
  });
}

/**
 * Run once from the Apps Script editor after deployment source is installed.
 * The returned one-time bootstrap code must be kept private and entered only
 * on the NEXUS first-master screen. Running this again rotates the code but
 * never removes users, sessions, service secrets, or audit records.
 */
function nexusAuthPrepareBootstrap() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var properties = PropertiesService.getScriptProperties();
    if (!properties.getProperty(NEXUS_AUTH_PROPERTIES.PEPPER)) {
      properties.setProperty(NEXUS_AUTH_PROPERTIES.PEPPER, nexusAuthRandomToken_(64));
    }
    if (!properties.getProperty(NEXUS_AUTH_PROPERTIES.DB_ID)) {
      var database = SpreadsheetApp.create('ONEAPP NEXUS Auth DB');
      properties.setProperty(NEXUS_AUTH_PROPERTIES.DB_ID, database.getId());
      nexusAuthEnsureSheets_(database);
    } else {
      nexusAuthEnsureSheets_(nexusAuthDb_());
    }
    if (!properties.getProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL)) {
      properties.setProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL, NEXUS_AUTH_DEFAULT_UPSTREAM_URL);
    }
    var bootstrapCode = 'NX-' + nexusAuthRandomToken_(24);
    properties.setProperty(NEXUS_AUTH_PROPERTIES.BOOTSTRAP_DIGEST, nexusAuthSha256_(bootstrapCode));
    properties.setProperty(NEXUS_AUTH_PROPERTIES.BOOTSTRAP_EXPIRES_AT, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    return bootstrapCode;
  } finally {
    lock.releaseLock();
  }
}

function nexusAuthDispatch_(action, payload) {
  if (action === 'nexus_auth_status') return nexusAuthStatus_();
  if (action === 'nexus_auth_challenge') return nexusAuthChallenge_(payload);
  if (action === 'nexus_auth_bootstrap') return nexusAuthBootstrap_(payload);
  if (action === 'nexus_auth_activate') return nexusAuthActivate_(payload);
  if (action === 'nexus_auth_login') return nexusAuthLogin_(payload);
  if (action === 'nexus_auth_session') return nexusAuthIssueClientBundle_(nexusAuthRequireSession_(payload.sessionToken));
  if (action === 'nexus_auth_logout') return nexusAuthLogout_(payload);

  var session = nexusAuthRequireSession_(payload.sessionToken);
  if (action === 'nexus_auth_app_context') return nexusAuthIssueAppContext_(session, payload);
  if (action === 'nexus_admin_users') return nexusAuthAdminUsers_(session);
  if (action === 'nexus_admin_user_create') return nexusAuthAdminUserCreate_(session, payload);
  if (action === 'nexus_admin_user_update') return nexusAuthAdminUserUpdate_(session, payload);
  if (action === 'nexus_admin_user_suspend') return nexusAuthAdminUserSuspend_(session, payload);
  if (action === 'nexus_admin_user_restore') return nexusAuthAdminUserRestore_(session, payload);
  if (action === 'nexus_admin_activation_reissue') return nexusAuthAdminActivationReissue_(session, payload);
  if (action === 'nexus_admin_invite') return nexusAuthAdminInviteAlias_(session, payload);
  if (action === 'nexus_admin_permissions' || action === 'nexus_admin_delete_user') return nexusAuthAdminDeprecated_(session);
  if (action === 'nexus_admin_recover_user') return nexusAuthAdminUserRestore_(session, payload);
  if (action === 'nexus_admin_service_status') return nexusAuthServiceStatus_(session);
  if (action === 'nexus_admin_audit') return nexusAuthAdminAudit_(session, payload);
  throw new Error('NEXUS_AUTH_ACTION_UNSUPPORTED');
}

function nexusAuthStatus_() {
  var initialized = nexusAuthIsInitialized_();
  var hasMaster = false;
  if (initialized) {
    hasMaster = nexusAuthUsers_().some(function (user) { return user.role === 'OWNER_MASTER' && user.status === 'ACTIVE'; });
  }
  return {
    contractVersion: NEXUS_AUTH_VERSION,
    initialized: initialized,
    requiresBootstrap: initialized && !hasMaster,
    passwordKdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, outputBytes: 32 }
  };
}

function nexusAuthChallenge_(payload) {
  nexusAuthRequireInitialized_();
  var loginId = nexusAuthNormalizeLoginId_(payload.loginId);
  var user = nexusAuthFindUserByLogin_(loginId);
  var pepper = nexusAuthPepper_();
  var fakeSalt = nexusAuthBase64UrlBytes_(Utilities.computeHmacSha256Signature(loginId, pepper, Utilities.Charset.UTF_8)).slice(0, 22);
  return {
    salt: user && user.status !== 'PURGED' && user.passwordSalt ? user.passwordSalt : fakeSalt,
    passwordKdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, outputBytes: 32 }
  };
}

function nexusAuthBootstrap_(payload) {
  nexusAuthRequireInitialized_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (nexusAuthUsers_().some(function (user) { return user.role === 'OWNER_MASTER' && user.status === 'ACTIVE'; })) {
      throw new Error('NEXUS_AUTH_BOOTSTRAP_CLOSED');
    }
    var properties = PropertiesService.getScriptProperties();
    var expectedDigest = nexusAuthText_(properties.getProperty(NEXUS_AUTH_PROPERTIES.BOOTSTRAP_DIGEST));
    var expiresAt = Date.parse(properties.getProperty(NEXUS_AUTH_PROPERTIES.BOOTSTRAP_EXPIRES_AT) || '');
    if (!expectedDigest || !expiresAt || expiresAt <= Date.now()) throw new Error('NEXUS_AUTH_BOOTSTRAP_EXPIRED');
    if (!nexusAuthConstantTime_(expectedDigest, nexusAuthSha256_(payload.bootstrapCode))) throw new Error('NEXUS_AUTH_BOOTSTRAP_DENIED');

    var loginId = nexusAuthNormalizeLoginId_(payload.loginId);
    var displayName = nexusAuthDisplayName_(payload.displayName);
    var salt = nexusAuthValidateSalt_(payload.passwordSalt);
    var verifier = nexusAuthValidateVerifier_(payload.passwordVerifier);
    if (nexusAuthFindUserByLogin_(loginId)) throw new Error('NEXUS_AUTH_LOGIN_ID_EXISTS');
    var now = new Date().toISOString();
    var user = {
      userId: 'USR-' + Utilities.getUuid(), loginId: loginId, displayName: displayName,
      role: 'OWNER_MASTER', permissionsJson: JSON.stringify(NEXUS_AUTH_ALL_PERMISSIONS),
      passwordSalt: salt, passwordHash: nexusAuthPasswordHash_(verifier), status: 'ACTIVE',
      createdAt: now, createdBy: 'BOOTSTRAP', updatedAt: now, deletedAt: '', recoverUntil: '',
      inviteDigest: '', inviteExpiresAt: '', version: 1, visibleAppIdsJson: ''
    };
    nexusAuthAppend_(NEXUS_AUTH_SHEETS.USERS, user);
    properties.deleteProperty(NEXUS_AUTH_PROPERTIES.BOOTSTRAP_DIGEST);
    properties.deleteProperty(NEXUS_AUTH_PROPERTIES.BOOTSTRAP_EXPIRES_AT);
    nexusAuthAudit_('BOOTSTRAP', user.userId, user.userId, 'SUCCESS', { role: user.role });
    return nexusAuthIssueSession_(user, payload.device);
  } finally {
    lock.releaseLock();
  }
}

function nexusAuthActivate_(payload) {
  nexusAuthRequireInitialized_();
  var loginId = nexusAuthNormalizeLoginId_(payload.loginId);
  var user = nexusAuthFindUserByLogin_(loginId);
  if (!user || ['INVITED', 'SUSPENDED'].indexOf(user.status) < 0 || !user.inviteDigest) throw new Error('NEXUS_AUTH_ACTIVATION_DENIED');
  if (Date.parse(user.inviteExpiresAt || '') <= Date.now()) throw new Error('NEXUS_AUTH_INVITE_EXPIRED');
  if (!nexusAuthConstantTime_(user.inviteDigest, nexusAuthSha256_(payload.inviteCode))) throw new Error('NEXUS_AUTH_ACTIVATION_DENIED');
  user.passwordSalt = nexusAuthValidateSalt_(payload.passwordSalt);
  user.passwordHash = nexusAuthPasswordHash_(nexusAuthValidateVerifier_(payload.passwordVerifier));
  user.status = 'ACTIVE';
  user.inviteDigest = '';
  user.inviteExpiresAt = '';
  user.updatedAt = new Date().toISOString();
  user.version = Number(user.version || 0) + 1;
  nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
  nexusAuthAudit_('LOGIN_SUCCESS', user.userId, user.userId, 'SUCCESS', { activation: true });
  return nexusAuthIssueSession_(user, payload.device);
}

function nexusAuthLogin_(payload) {
  nexusAuthRequireInitialized_();
  var loginId = nexusAuthNormalizeLoginId_(payload.loginId);
  nexusAuthRateCheck_(loginId);
  var user = nexusAuthFindUserByLogin_(loginId);
  var suppliedHash = nexusAuthPasswordHash_(nexusAuthValidateVerifier_(payload.passwordVerifier));
  if (!user || user.status !== 'ACTIVE' || !nexusAuthConstantTime_(user.passwordHash, suppliedHash)) {
    nexusAuthRateFail_(loginId);
    nexusAuthAudit_('LOGIN_FAILURE', '', user ? user.userId : '', 'DENIED', { loginIdDigest: nexusAuthSha256_(loginId) });
    throw new Error('NEXUS_AUTH_LOGIN_DENIED');
  }
  nexusAuthRateClear_(loginId);
  nexusAuthAudit_('LOGIN_SUCCESS', user.userId, user.userId, 'SUCCESS', {});
  return nexusAuthIssueSession_(user, payload.device);
}

function nexusAuthLogout_(payload) {
  var token = nexusAuthText_(payload.sessionToken);
  if (!token) return { loggedOut: true };
  var digest = nexusAuthSha256_(token);
  var row = nexusAuthRows_(NEXUS_AUTH_SHEETS.SESSIONS).find(function (item) { return item.sessionDigest === digest; });
  if (row && !row.revokedAt) {
    row.revokedAt = new Date().toISOString();
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.SESSIONS, row._row, row);
    nexusAuthAudit_('LOGOUT', row.userId, row.userId, 'SUCCESS', {});
  }
  return { loggedOut: true };
}

function nexusAuthIssueSession_(user, device) {
  var rawToken = nexusAuthRandomToken_(48);
  var now = new Date();
  var session = {
    sessionDigest: nexusAuthSha256_(rawToken), userId: user.userId,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + NEXUS_AUTH_SESSION_TTL_MS).toISOString(),
    lastSeenAt: now.toISOString(), revokedAt: '', device: nexusAuthText_(device).slice(0, 240)
  };
  nexusAuthAppend_(NEXUS_AUTH_SHEETS.SESSIONS, session);
  return Object.assign({ sessionToken: rawToken }, nexusAuthIssueClientBundle_({ user: user, session: session }));
}

function nexusAuthRequireSession_(rawToken) {
  nexusAuthRequireInitialized_();
  var token = nexusAuthText_(rawToken);
  if (!token) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
  var digest = nexusAuthSha256_(token);
  var session = nexusAuthRows_(NEXUS_AUTH_SHEETS.SESSIONS).find(function (item) { return item.sessionDigest === digest; });
  if (!session || session.revokedAt || Date.parse(session.expiresAt || '') <= Date.now()) throw new Error('NEXUS_AUTH_SESSION_EXPIRED');
  var user = nexusAuthFindUserById_(session.userId);
  if (!user || user.status !== 'ACTIVE') throw new Error('NEXUS_AUTH_SESSION_REVOKED');
  if (Date.now() - Date.parse(session.lastSeenAt || session.issuedAt || '') > 15 * 60 * 1000) {
    session.lastSeenAt = new Date().toISOString();
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.SESSIONS, session._row, session);
  }
  return { user: user, session: session };
}

function nexusAuthAppPermissions_() {
  return {
    'nexus-home': ['foundation.read'],
    company: ['foundation.read'],
    master: ['foundation.read'],
    'item-manager': ['foundation.write'],
    'customer-manager': ['customer.read'],
    merchops: ['merchops.read'],
    'smart-parser': ['merchops.read'],
    dataops: ['dataops.read'],
    orderq: ['orderq.read'],
    orderops: ['orderq.read', 'shipping.read'],
    orderin: ['orderq.write'],
    'smart-input': ['smartinput.use'],
    settings: ['foundation.read'],
    history: ['foundation.read'],
    'export-center': ['foundation.read']
  };
}

function nexusAuthIssueAppContext_(context, payload) {
  var appId = nexusAuthText_(payload.appId).toLowerCase();
  var required = nexusAuthAppPermissions_()[appId];
  if (!required) throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED');
  required.forEach(function (permission) { nexusAuthRequirePermission_(context.user, permission); });
  var now = Date.now();
  var expiresAt = Math.min(Date.parse(context.session.expiresAt || ''), now + NEXUS_AUTH_CLIENT_CONTEXT_TTL_MS);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('NEXUS_AUTH_SESSION_EXPIRED');
  var claims = {
    version: NEXUS_AUTH_APP_CONTEXT_VERSION,
    appId: appId,
    userId: context.user.userId,
    sessionDigest: context.session.sessionDigest,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  var encoded = encodeURIComponent(JSON.stringify(claims));
  return { appId: appId, appContextToken: encoded + '.' + nexusAuthHmac_(encoded), expiresAt: claims.expiresAt };
}

function nexusAuthCanUseApp_(user, appId) {
  var required = nexusAuthAppPermissions_()[appId];
  if (!required) return false;
  try {
    required.forEach(function (permission) { nexusAuthRequirePermission_(user, permission); });
    return true;
  } catch (error) {
    return false;
  }
}

function nexusAuthIssueClientBundle_(context) {
  var now = Date.now();
  var expiresAt = Math.min(Date.parse(context.session.expiresAt || ''), now + NEXUS_AUTH_CLIENT_CONTEXT_TTL_MS);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('NEXUS_AUTH_SESSION_EXPIRED');
  var appContexts = Object.keys(nexusAuthAppPermissions_()).reduce(function (result, appId) {
    if (nexusAuthCanUseApp_(context.user, appId)) result[appId] = nexusAuthIssueAppContext_(context, { appId: appId });
    return result;
  }, {});
  var claims = {
    version: NEXUS_AUTH_SESSION_CONTEXT_VERSION,
    userId: context.user.userId,
    userVersion: Number(context.user.version || 0),
    sessionDigest: context.session.sessionDigest,
    permissionsDigest: nexusAuthSha256_(JSON.stringify(nexusAuthPermissions_(context.user).slice().sort())),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  var encoded = encodeURIComponent(JSON.stringify(claims));
  return {
    session: nexusAuthSessionView_(context),
    sessionContextToken: encoded + '.' + nexusAuthHmac_(encoded),
    contextExpiresAt: claims.expiresAt,
    appContexts: appContexts
  };
}

function nexusAuthRequireAppContext_(rawToken, context, definition) {
  var token = nexusAuthText_(rawToken);
  var separator = token.lastIndexOf('.');
  if (separator < 1) throw new Error('NEXUS_AUTH_APP_CONTEXT_REQUIRED');
  var encoded = token.slice(0, separator);
  var suppliedSignature = token.slice(separator + 1);
  var expectedSignature = nexusAuthHmac_(encoded);
  if (!/^[a-f0-9]{64}$/.test(suppliedSignature) || !nexusAuthConstantTime_(suppliedSignature, expectedSignature)) throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED');
  var claims;
  try { claims = JSON.parse(decodeURIComponent(encoded)); }
  catch (error) { throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED'); }
  if (!claims || claims.version !== NEXUS_AUTH_APP_CONTEXT_VERSION || claims.userId !== context.user.userId
      || claims.sessionDigest !== context.session.sessionDigest || Date.parse(claims.expiresAt || '') <= Date.now()) {
    throw new Error('NEXUS_AUTH_APP_CONTEXT_EXPIRED');
  }
  if (!definition || !Array.isArray(definition.allowedApps) || definition.allowedApps.indexOf(claims.appId) < 0) throw new Error('NEXUS_AUTH_APP_OPERATION_DENIED');
  return claims;
}

function nexusAuthSessionView_(context) {
  var user = context.user;
  var visibility = nexusAuthVisibleApps_(user);
  return {
    user: {
      userId: user.userId, loginId: user.loginId, displayName: user.displayName,
      role: user.role, accountType: user.role === 'OWNER_MASTER' ? 'OWNER_MASTER' : 'DELEGATED_USER',
      permissions: nexusAuthPermissions_(user), status: user.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
      visibleAppsConfigured: visibility.configured, visibleAppIds: visibility.visibleAppIds,
      version: Number(user.version || 0)
    },
    expiresAt: context.session.expiresAt,
    serviceConnections: nexusAuthServiceBooleans_()
  };
}

function nexusAuthAdminUsers_(context) {
  nexusAuthRequireOwnerMaster_(context.user);
  return nexusAuthUsers_().filter(function (user) { return user.status !== 'PURGED'; }).map(nexusAuthAdminUserView_);
}

/**
 * Creates a complete spreadsheet copy without changing the source database.
 * The return value contains schema/count metadata and only digests of file IDs.
 */
function nexusAuthCreatePredeployBackup() {
  nexusAuthRequireInitialized_();
  return nexusAuthWithScriptLock_(function () {
    var database = nexusAuthDb_();
    var inspection = nexusAuthInspectAuthSchema_(database);
    var capturedAt = new Date().toISOString();
    var backupName = 'ONEAPP NEXUS Auth DB backup ' + capturedAt.replace(/[:.]/g, '-');
    var backup = database.copy(backupName);
    var backupDigest = nexusAuthSha256_(backup.getId());
    var properties = PropertiesService.getScriptProperties();
    properties.setProperty(NEXUS_AUTH_PROPERTIES.LAST_DATA_BACKUP_AT, capturedAt);
    properties.setProperty(NEXUS_AUTH_PROPERTIES.LAST_DATA_BACKUP_DIGEST, backupDigest);
    return {
      backupCreated: true,
      backupName: backupName,
      backupFileIdDigest: backupDigest,
      sourceFileIdDigest: nexusAuthSha256_(database.getId()),
      capturedAt: capturedAt,
      schema: inspection
    };
  });
}

/** Adds only the trailing Users.visibleAppIdsJson header; existing rows are untouched. */
function nexusAuthMigrateVisibleApps() {
  nexusAuthRequireInitialized_();
  return nexusAuthWithScriptLock_(function () {
    var properties = PropertiesService.getScriptProperties();
    if (!properties.getProperty(NEXUS_AUTH_PROPERTIES.LAST_DATA_BACKUP_AT)
        || !properties.getProperty(NEXUS_AUTH_PROPERTIES.LAST_DATA_BACKUP_DIGEST)) {
      throw new Error('NEXUS_AUTH_BACKUP_REQUIRED');
    }
    var database = nexusAuthDb_();
    var inspection = nexusAuthInspectAuthSchema_(database);
    if (inspection.Users.schemaVersion === 'VISIBLE_APPS_V1') {
      return { migrated: false, idempotent: true, schema: inspection };
    }
    if (inspection.Users.schemaVersion !== 'LEGACY_V24') throw new Error('NEXUS_AUTH_USERS_SCHEMA_CONFLICT');
    var sheet = database.getSheetByName(NEXUS_AUTH_SHEETS.USERS);
    sheet.getRange(1, NEXUS_AUTH_HEADERS.Users.length).setValue('visibleAppIdsJson');
    SpreadsheetApp.flush();
    var migrated = nexusAuthInspectAuthSchema_(database);
    if (migrated.Users.schemaVersion !== 'VISIBLE_APPS_V1') throw new Error('NEXUS_AUTH_USERS_SCHEMA_CONFLICT');
    return { migrated: true, idempotent: false, schema: migrated };
  });
}

function nexusAuthInspectAuthSchema_(database) {
  var result = {};
  Object.keys(NEXUS_AUTH_HEADERS).forEach(function (sheetName) {
    var sheet = database.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 1) throw new Error('NEXUS_AUTH_SCHEMA_CONFLICT');
    var lastColumn = sheet.getLastColumn();
    var headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(nexusAuthText_) : [];
    var expected = NEXUS_AUTH_HEADERS[sheetName];
    var schemaVersion = 'CURRENT';
    if (sheetName === NEXUS_AUTH_SHEETS.USERS) {
      if (nexusAuthArrayEquals_(headers, NEXUS_AUTH_USERS_LEGACY_HEADERS)) schemaVersion = 'LEGACY_V24';
      else if (nexusAuthArrayEquals_(headers, expected)) schemaVersion = 'VISIBLE_APPS_V1';
      else throw new Error('NEXUS_AUTH_USERS_SCHEMA_CONFLICT');
    } else if (!nexusAuthArrayEquals_(headers, expected)) {
      throw new Error('NEXUS_AUTH_SCHEMA_CONFLICT');
    }
    result[sheetName] = {
      schemaVersion: schemaVersion,
      headers: headers,
      rowCount: Math.max(0, sheet.getLastRow() - 1),
      metadataDigest: nexusAuthSha256_(JSON.stringify({ headers: headers, rowCount: Math.max(0, sheet.getLastRow() - 1) }))
    };
  });
  return result;
}

function nexusAuthArrayEquals_(left, right) {
  return left.length === right.length && left.every(function (value, index) { return value === right[index]; });
}

function nexusAuthRequireCurrentUsersSchema_() {
  var inspection = nexusAuthInspectAuthSchema_(nexusAuthDb_());
  if (inspection.Users.schemaVersion !== 'VISIBLE_APPS_V1') throw new Error('NEXUS_AUTH_USERS_MIGRATION_REQUIRED');
  return true;
}

function nexusAuthAdminUserCreate_(context, payload) {
  nexusAuthRequireOwnerMaster_(context.user);
  nexusAuthAssertPayloadFields_(payload, ['action', 'sessionToken', 'loginId', 'displayName', 'visibleAppIds']);
  var loginId = nexusAuthNormalizeLoginId_(payload.loginId);
  var displayName = nexusAuthDisplayName_(payload.displayName);
  var configured = Object.prototype.hasOwnProperty.call(payload, 'visibleAppIds');
  var visibleAppIds = configured ? nexusAuthValidateVisibleAppIds_(payload.visibleAppIds) : [];
  return nexusAuthWithScriptLock_(function () {
    if (nexusAuthFindUserByLogin_(loginId)) throw new Error('NEXUS_AUTH_LOGIN_ID_EXISTS');
    var activationCode = 'ACT-' + nexusAuthRandomToken_(24);
    var now = new Date();
    var user = {
      userId: 'USR-' + Utilities.getUuid(), loginId: loginId, displayName: displayName,
      role: 'VIEWER', permissionsJson: JSON.stringify(NEXUS_AUTH_PROFILE_PERMISSIONS.VIEWER),
      passwordSalt: '', passwordHash: '', status: 'SUSPENDED', createdAt: now.toISOString(),
      createdBy: context.user.userId, updatedAt: now.toISOString(), deletedAt: '', recoverUntil: '',
      inviteDigest: nexusAuthSha256_(activationCode),
      inviteExpiresAt: new Date(now.getTime() + NEXUS_AUTH_ACTIVATION_TTL_MS).toISOString(),
      version: 1, visibleAppIdsJson: configured ? JSON.stringify(visibleAppIds) : ''
    };
    nexusAuthAppend_(NEXUS_AUTH_SHEETS.USERS, user);
    nexusAuthAudit_('USER_CREATE', context.user.userId, user.userId, 'SUCCESS', {
      changedFields: ['displayName', 'visibleAppIds', 'status'], newVersion: 1, visibleAppIds: visibleAppIds
    });
    return { user: nexusAuthAdminUserView_(user), activationCode: activationCode };
  });
}

function nexusAuthAdminInviteAlias_(context, payload) {
  var forwarded = {
    action: 'nexus_admin_user_create', sessionToken: payload.sessionToken, loginId: payload.loginId,
    displayName: payload.displayName
  };
  if (Object.prototype.hasOwnProperty.call(payload, 'visibleAppIds')) forwarded.visibleAppIds = payload.visibleAppIds;
  var result = nexusAuthAdminUserCreate_(context, forwarded);
  return { user: result.user, inviteCode: result.activationCode, activationCode: result.activationCode };
}

function nexusAuthAdminUserUpdate_(context, payload) {
  nexusAuthRequireOwnerMaster_(context.user);
  nexusAuthAssertPayloadFields_(payload, ['action', 'sessionToken', 'userId', 'expectedVersion', 'displayName', 'visibleAppIds']);
  var hasDisplayName = Object.prototype.hasOwnProperty.call(payload, 'displayName');
  var hasVisibleAppIds = Object.prototype.hasOwnProperty.call(payload, 'visibleAppIds');
  if (!hasDisplayName && !hasVisibleAppIds) throw new Error('NEXUS_AUTH_UPDATE_REQUIRED');
  var displayName = hasDisplayName ? nexusAuthDisplayName_(payload.displayName) : '';
  var visibleAppIds = hasVisibleAppIds ? nexusAuthValidateVisibleAppIds_(payload.visibleAppIds) : [];
  return nexusAuthWithScriptLock_(function () {
    var user = nexusAuthMutableDelegatedUser_(payload.userId);
    var previousVersion = nexusAuthRequireExpectedVersion_(user, payload.expectedVersion);
    var changedFields = [];
    var previousVisibility = nexusAuthVisibleApps_(user);
    if (hasDisplayName && user.displayName !== displayName) {
      user.displayName = displayName;
      changedFields.push('displayName');
    }
    if (hasVisibleAppIds) {
      var canonical = JSON.stringify(visibleAppIds);
      if (user.visibleAppIdsJson !== canonical) {
        user.visibleAppIdsJson = canonical;
        changedFields.push('visibleAppIds');
      }
    }
    if (!changedFields.length) return nexusAuthAdminUserView_(user);
    user.updatedAt = new Date().toISOString();
    user.version = previousVersion + 1;
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
    if (changedFields.indexOf('displayName') >= 0) {
      nexusAuthAudit_('USER_DISPLAY_NAME_CHANGE', context.user.userId, user.userId, 'SUCCESS', {
        changedFields: ['displayName'], previousVersion: previousVersion, newVersion: user.version
      });
    }
    if (changedFields.indexOf('visibleAppIds') >= 0) {
      nexusAuthAudit_('USER_VISIBLE_APPS_CHANGE', context.user.userId, user.userId, 'SUCCESS', {
        changedFields: ['visibleAppIds'], previousVersion: previousVersion, newVersion: user.version,
        previousVisibleAppIds: previousVisibility.visibleAppIds, visibleAppIds: visibleAppIds
      });
    }
    return nexusAuthAdminUserView_(user);
  });
}

function nexusAuthAdminUserSuspend_(context, payload) {
  nexusAuthRequireOwnerMaster_(context.user);
  nexusAuthAssertPayloadFields_(payload, ['action', 'sessionToken', 'userId', 'expectedVersion']);
  return nexusAuthWithScriptLock_(function () {
    var user = nexusAuthMutableDelegatedUser_(payload.userId);
    var previousVersion = nexusAuthRequireExpectedVersion_(user, payload.expectedVersion);
    nexusAuthRevokeUserSessions_(user.userId);
    if (user.status === 'SUSPENDED') return nexusAuthAdminUserView_(user);
    user.status = 'SUSPENDED';
    user.updatedAt = new Date().toISOString();
    user.version = previousVersion + 1;
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
    nexusAuthAudit_('USER_SUSPEND', context.user.userId, user.userId, 'SUCCESS', {
      changedFields: ['status'], previousVersion: previousVersion, newVersion: user.version
    });
    return nexusAuthAdminUserView_(user);
  });
}

function nexusAuthAdminUserRestore_(context, payload) {
  nexusAuthRequireOwnerMaster_(context.user);
  nexusAuthAssertPayloadFields_(payload, ['action', 'sessionToken', 'userId', 'expectedVersion']);
  return nexusAuthWithScriptLock_(function () {
    var user = nexusAuthMutableDelegatedUser_(payload.userId);
    var previousVersion = nexusAuthRequireExpectedVersion_(user, payload.expectedVersion);
    if (!user.passwordHash) throw new Error('NEXUS_AUTH_ACTIVATION_REQUIRED');
    if (user.status === 'ACTIVE') return nexusAuthAdminUserView_(user);
    user.status = 'ACTIVE';
    user.deletedAt = '';
    user.recoverUntil = '';
    user.updatedAt = new Date().toISOString();
    user.version = previousVersion + 1;
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
    nexusAuthAudit_('USER_RESTORE', context.user.userId, user.userId, 'SUCCESS', {
      changedFields: ['status'], previousVersion: previousVersion, newVersion: user.version
    });
    return nexusAuthAdminUserView_(user);
  });
}

function nexusAuthAdminActivationReissue_(context, payload) {
  nexusAuthRequireOwnerMaster_(context.user);
  nexusAuthAssertPayloadFields_(payload, ['action', 'sessionToken', 'userId', 'expectedVersion']);
  return nexusAuthWithScriptLock_(function () {
    var user = nexusAuthMutableDelegatedUser_(payload.userId);
    var previousVersion = nexusAuthRequireExpectedVersion_(user, payload.expectedVersion);
    if (user.status === 'ACTIVE') throw new Error('NEXUS_AUTH_USER_ALREADY_ACTIVE');
    var activationCode = 'ACT-' + nexusAuthRandomToken_(24);
    var now = new Date();
    user.status = 'SUSPENDED';
    user.deletedAt = '';
    user.recoverUntil = '';
    user.inviteDigest = nexusAuthSha256_(activationCode);
    user.inviteExpiresAt = new Date(now.getTime() + NEXUS_AUTH_ACTIVATION_TTL_MS).toISOString();
    user.updatedAt = now.toISOString();
    user.version = previousVersion + 1;
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
    nexusAuthAudit_('USER_ACTIVATION_REISSUE', context.user.userId, user.userId, 'SUCCESS', {
      changedFields: ['activation'], previousVersion: previousVersion, newVersion: user.version
    });
    return { user: nexusAuthAdminUserView_(user), activationCode: activationCode };
  });
}

function nexusAuthAdminDeprecated_(context) {
  nexusAuthRequireOwnerMaster_(context.user);
  throw new Error('NEXUS_AUTH_ACTION_DEPRECATED');
}

function nexusAuthServiceStatus_(context) {
  nexusAuthRequirePermission_(context.user, 'admin.services');
  return nexusAuthServiceBooleans_();
}

function nexusAuthAdminAudit_(context, payload) {
  nexusAuthRequireOwnerMaster_(context.user);
  nexusAuthAssertPayloadFields_(payload, ['action', 'sessionToken', 'limit']);
  var limit = Math.max(1, Math.min(200, Number(payload.limit || 100)));
  var allowed = ['LOGIN', 'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'LOGOUT', 'USER_CREATE', 'USER_DISPLAY_NAME_CHANGE',
    'USER_VISIBLE_APPS_CHANGE', 'USER_SUSPEND', 'USER_RESTORE', 'USER_ACTIVATION_REISSUE'];
  return nexusAuthRows_(NEXUS_AUTH_SHEETS.AUDIT).filter(function (row) {
    return allowed.indexOf(row.action) >= 0;
  }).slice(-limit).reverse().map(function (row) {
    var action = row.action === 'LOGIN' ? (row.result === 'SUCCESS' ? 'LOGIN_SUCCESS' : 'LOGIN_FAILURE') : row.action;
    return { auditId: row.auditId, at: row.at, actorUserId: row.actorUserId, action: action, targetUserId: row.targetUserId, result: row.result, detail: nexusAuthParseJson_(row.detailJson, {}) };
  });
}

function nexusAuthGatewayRegistry_() {
  var foundationApps = ['nexus-home', 'company', 'master', 'item-manager', 'customer-manager', 'merchops', 'smart-parser', 'dataops', 'settings', 'history', 'export-center'];
  var orderApps = ['orderq', 'orderops', 'orderin', 'smart-input', 'dataops'];
  var companyFooterApps = foundationApps.concat(orderApps.filter(function (appId) { return foundationApps.indexOf(appId) < 0; }));
  var definitions = [
    ['foundation.full_read', foundationApps, ['foundation.read'], 'nexus_gateway_foundation_full_get', 'FOUNDATION', 'READ', [], 'foundation', 'master'],
    ['foundation.master_read', foundationApps, ['foundation.read'], 'nexus_gateway_foundation_master_get', 'FOUNDATION', 'READ', [], 'foundation', 'master'],
    ['foundation.config_read', foundationApps, ['foundation.read'], 'nexus_gateway_foundation_config_get', 'FOUNDATION', 'READ', [], 'foundation', 'config'],
    ['foundation.config_write', ['settings', 'master', 'merchops'], ['foundation.write'], 'nexus_gateway_foundation_config_write', 'FOUNDATION', 'WRITE', ['data'], 'foundation', 'config'],
    ['foundation.history_read', ['history', 'master', 'item-manager', 'merchops'], ['foundation.read'], 'nexus_gateway_foundation_history_get', 'FOUNDATION', 'READ', ['limit', 'days', 'code', 'field'], 'foundation', 'history'],
    ['foundation.metadata_read', ['master', 'item-manager', 'customer-manager'], ['foundation.read'], 'nexus_gateway_foundation_metadata_get', 'FOUNDATION', 'READ', ['schemaVersion', 'entityType', 'includeDisabled'], 'foundation', 'generic'],
    ['foundation.metadata_write', ['master', 'item-manager', 'customer-manager'], ['foundation.write'], 'nexus_gateway_foundation_metadata_write', 'FOUNDATION', 'WRITE', ['schemaVersion', 'expectedRevision', 'changes'], 'foundation', 'generic'],
    ['foundation.backup.head_read', foundationApps, ['foundation.read'], 'nexus_gateway_foundation_backup_head_read', 'FOUNDATION', 'READ', ['schemaVersion', 'domainType'], 'foundation', 'generic'],
    ['foundation.backup.product_write', foundationApps, ['foundation.write'], 'nexus_gateway_foundation_backup_product_write', 'FOUNDATION', 'WRITE', ['schemaVersion', 'domainType', 'backupKind', 'backupId', 'deviceId', 'baseServerRevision', 'localRevision', 'primaryEpoch', 'recordCount', 'contentHash', 'snapshot'], 'foundation', 'generic'],
    ['foundation.backup.customer_events_write', ['customer-manager'], ['customer.write'], 'nexus_gateway_foundation_backup_customer_events_write', 'FOUNDATION', 'WRITE', ['schemaVersion', 'domainType', 'backupKind', 'backupId', 'deviceId', 'baseServerRevision', 'localRevision', 'primaryEpoch', 'recordCount', 'contentHash', 'events'], 'foundation', 'generic'],
    ['foundation.backup.customer_snapshot_write', ['customer-manager'], ['customer.write'], 'nexus_gateway_foundation_backup_customer_snapshot_write', 'FOUNDATION', 'WRITE', ['schemaVersion', 'domainType', 'backupKind', 'backupId', 'deviceId', 'baseServerRevision', 'localRevision', 'primaryEpoch', 'recordCount', 'contentHash', 'snapshot'], 'foundation', 'generic'],
    ['foundation.backup.version_list', ['master', 'item-manager', 'customer-manager'], ['foundation.read'], 'nexus_gateway_foundation_backup_version_list', 'FOUNDATION', 'READ', ['schemaVersion', 'domainType', 'limit'], 'foundation', 'generic'],
    ['foundation.backup.version_read', ['master', 'item-manager', 'customer-manager'], ['foundation.read'], 'nexus_gateway_foundation_backup_version_read', 'FOUNDATION', 'READ', ['schemaVersion', 'domainType', 'serverRevision'], 'foundation', 'generic'],
    ['foundation.backup.restore_audit_write', ['master', 'item-manager', 'customer-manager'], ['foundation.write'], 'nexus_gateway_foundation_backup_restore_audit_write', 'FOUNDATION', 'WRITE', ['schemaVersion', 'restoreId', 'domainType', 'serverRevision', 'deviceId', 'result', 'localHashBefore', 'localHashAfter', 'recordCountBefore', 'recordCountAfter'], 'foundation', 'generic'],
    ['foundation.device.status_read', foundationApps, ['foundation.read'], 'nexus_gateway_foundation_device_status_read', 'FOUNDATION', 'READ', ['schemaVersion', 'deviceId'], 'foundation', 'generic'],
    ['foundation.device.register', foundationApps, ['foundation.write'], 'nexus_gateway_foundation_device_register', 'FOUNDATION', 'WRITE', ['schemaVersion', 'deviceId', 'displayName'], 'foundation', 'generic'],
    ['foundation.device.promote', ['master', 'item-manager', 'customer-manager'], ['admin.company'], 'nexus_gateway_foundation_device_promote', 'FOUNDATION', 'WRITE', ['schemaVersion', 'deviceId', 'expectedPrimaryEpoch', 'reason'], 'foundation', 'generic'],
    ['foundation.replace_all', ['master', 'item-manager', 'merchops'], ['foundation.write', 'foundation.replace'], 'nexus_gateway_foundation_replace_all', 'FOUNDATION', 'WRITE', ['master', 'history', 'config', 'sourceRevision'], 'foundation', 'replace'],
    ['company.public_profile_read', companyFooterApps, [], 'nexus_gateway_company_public_profile_get', 'FOUNDATION', 'READ', ['knownRevision'], 'company', 'public-profile'],
    ['company.profile_read', ['company', 'nexus-home'], ['admin.company'], 'nexus_gateway_company_profile_get', 'FOUNDATION', 'READ', [], 'company', 'profile'],
    ['company.profile_write', ['company'], ['admin.company'], 'nexus_gateway_company_profile_write', 'FOUNDATION', 'WRITE', ['expectedRevision', 'changes'], 'company', 'profile'],
    ['company.accounting_period_read', ['company'], ['admin.company'], 'nexus_gateway_company_accounting_period_get', 'FOUNDATION', 'READ', [], 'company', 'accounting'],
    ['company.accounting_period_write', ['company'], ['admin.company'], 'nexus_gateway_company_accounting_period_write', 'FOUNDATION', 'WRITE', ['expectedRevision', 'operation', 'period'], 'company', 'accounting'],
    ['company.certificate_extract', ['company'], ['admin.company'], 'nexus_gateway_company_certificate_extract', 'FOUNDATION', 'READ', ['extraction'], 'company', 'certificate'],
    ['company.backup_create', ['company'], ['admin.company'], 'nexus_gateway_company_backup_create', 'FOUNDATION', 'WRITE', [], 'company', 'backup'],
    ['company.migrate_oneapp', ['company'], ['admin.company'], 'nexus_gateway_company_migrate_oneapp', 'FOUNDATION', 'WRITE', ['taskId', 'deploymentCommit'], 'company', 'migration'],
    ['dataops.security_ping', ['dataops', 'merchops', 'orderops'], ['dataops.read'], 'dataops_v1_security_ping', 'DATAOPS', 'READ', [], 'dataops', 'generic'],
    ['dataops.snapshot.get', ['dataops', 'merchops', 'orderops'], ['dataops.read'], 'dataops_snapshot_get', 'DATAOPS', 'READ', [], 'dataops', 'generic'],
    ['dataops.snapshot.commit', ['dataops'], [], 'dataops_snapshot_commit', 'DATAOPS', 'WRITE', ['snapshot'], 'dataops', 'generic'],
    ['dataops.situation.ping', ['dataops', 'orderq', 'orderops'], ['dataops.read'], 'situation_dataops_ping', 'DATAOPS', 'READ', [], 'dataops', 'generic'],
    ['dataops.situation.begin', ['dataops', 'orderq', 'orderops'], ['dataops.read'], 'situation_dataops_begin', 'DATAOPS', 'READ', ['businessDate'], 'dataops', 'generic'],
    ['dataops.situation.page', ['dataops', 'orderq', 'orderops'], ['dataops.read'], 'situation_dataops_page', 'DATAOPS', 'READ', ['readSessionId', 'tokenDigest', 'dataOpsTokenDigest', 'pageIndex'], 'dataops', 'generic'],
    ['dataops.situation.head', ['dataops', 'orderq', 'orderops'], ['dataops.read'], 'situation_dataops_head', 'DATAOPS', 'READ', ['readSessionId', 'tokenDigest', 'dataOpsTokenDigest'], 'dataops', 'generic'],
    ['dataops.situation.publish', ['dataops'], [], 'situation_dataops_publish', 'DATAOPS', 'WRITE', ['snapshot', 'producerEvidence', 'prepareOperationalRequest', 'rollbackRequest'], 'dataops', 'generic'],
    ['dataops.close.ping', ['dataops'], ['dataops.read'], 'dataops_close_ping', 'DATAOPS', 'READ', [], 'dataops', 'generic'],
    ['dataops.close.context', ['dataops'], [], 'dataops_close_context', 'DATAOPS', 'READ', ['closeSeriesId', 'companyId', 'closeBusinessDate'], 'dataops', 'generic'],
    ['dataops.close.seal', ['dataops'], [], 'dataops_close_seal', 'DATAOPS', 'READ', ['closeSeriesId', 'closeSnapshotA', 'sourceADigest', 'capabilityDigest', 'orderqReadRequest', 'dataopsReadTokenDigest'], 'dataops', 'generic'],
    ['dataops.close.prepare', ['dataops'], [], 'dataops_close_prepare', 'DATAOPS', 'WRITE', ['intent'], 'dataops', 'generic'],
    ['dataops.close.write_chunks', ['dataops'], [], 'dataops_close_write_chunks', 'DATAOPS', 'WRITE', ['stageId', 'commandId', 'kind', 'chunks'], 'dataops', 'generic'],
    ['dataops.close.commit', ['dataops'], [], 'dataops_close_commit', 'DATAOPS', 'WRITE', ['intent'], 'dataops', 'generic'],
    ['dataops.close.abort', ['dataops'], [], 'dataops_close_abort', 'DATAOPS', 'WRITE', ['closeSeriesId', 'commandId'], 'dataops', 'generic'],
    ['orderq.sync.pull', orderApps, ['orderq.read'], 'orderq_sync_pull', 'ORDERQ', 'READ', ['schemaVersion', 'afterSequence', 'limit'], 'orderq', 'generic'],
    ['orderq.sync.push', ['orderq', 'orderin', 'smart-input'], ['orderq.write'], 'orderq_sync_push', 'ORDERQ', 'WRITE', ['schemaVersion', 'deviceId', 'changes', 'customerResetGeneration'], 'orderq', 'generic'],
    ['customer.master.pull', ['customer-manager'], ['customer.read'], 'orderq_customer_master_pull', 'ORDERQ', 'READ', ['schemaVersion', 'afterSequence', 'limit'], 'customer', 'generic'],
    ['customer.master.push', ['customer-manager'], ['customer.write'], 'orderq_customer_master_push', 'ORDERQ', 'WRITE', ['schemaVersion', 'deviceId', 'changes', 'customerResetGeneration'], 'customer', 'generic'],
    ['orderq.customer.reset_preview', ['orderq'], ['orderq.admin', 'customer.read'], 'orderq_customer_reset_preview', 'ORDERQ', 'READ', [], 'orderq', 'generic'],
    ['orderq.customer.reset_execute', ['orderq'], ['orderq.admin', 'customer.write'], 'orderq_customer_reset_execute', 'ORDERQ', 'WRITE', ['confirmation'], 'orderq', 'generic'],
    ['orderq.order.head', orderApps, ['orderq.read'], 'orderq_order_head', 'ORDERQ', 'READ', ['schemaVersion', 'orderId'], 'orderq', 'generic'],
    ['orderq.central.ping', orderApps, ['orderq.read'], 'orderq_m9_ping', 'ORDERQ', 'READ', ['schemaVersion'], 'orderq', 'generic'],
    ['orderq.central.migrate', ['orderq'], ['orderq.write'], 'orderq_m9_migrate', 'ORDERQ', 'WRITE', ['schemaVersion', 'deviceId', 'idempotencyKey', 'entities'], 'orderq', 'generic'],
    ['orderq.central.prepare', ['orderq', 'orderin', 'smart-input'], ['orderq.write'], 'orderq_m9_command_prepare', 'ORDERQ', 'WRITE', ['schemaVersion', 'commandId', 'idempotencyKey', 'commandType', 'aggregateId', 'expectedRevision', 'deviceId', 'intent'], 'orderq', 'generic'],
    ['orderq.central.commit', ['orderq', 'orderin', 'smart-input'], ['orderq.write'], 'orderq_m9_command_commit', 'ORDERQ', 'WRITE', ['schemaVersion', 'idempotencyKey', 'leaseToken', 'fingerprint', 'mutations'], 'orderq', 'generic'],
    ['orderq.central.abort', ['orderq', 'orderin', 'smart-input'], ['orderq.write'], 'orderq_m9_command_abort', 'ORDERQ', 'WRITE', ['schemaVersion', 'idempotencyKey', 'leaseToken', 'reason'], 'orderq', 'generic'],
    ['orderq.central.pull', orderApps, ['orderq.read'], 'orderq_m9_pull', 'ORDERQ', 'READ', ['schemaVersion', 'afterSequence', 'limit'], 'orderq', 'generic'],
    ['orderq.situation.begin', orderApps, ['orderq.read'], 'situation_orderq_begin', 'ORDERQ', 'READ', ['schemaVersion', 'businessDate', 'windowKey', 'operationWindow', 'dataOps'], 'orderq', 'generic'],
    ['orderq.situation.page', orderApps, ['orderq.read'], 'situation_orderq_page', 'ORDERQ', 'READ', ['schemaVersion', 'readSessionId', 'tokenDigest', 'pageIndex'], 'orderq', 'generic'],
    ['orderq.situation.head', orderApps, ['orderq.read'], 'situation_orderq_head', 'ORDERQ', 'READ', ['schemaVersion', 'readSessionId', 'tokenDigest'], 'orderq', 'generic'],
    ['shipping.plan.list', ['orderops'], ['shipping.read'], 'shipping_plan_list', 'SHIPPING', 'READ', ['limit'], 'shipping', 'generic'],
    ['shipping.plan.get', ['orderops'], ['shipping.read'], 'shipping_plan_get', 'SHIPPING', 'READ', ['planId', 'revision'], 'shipping', 'generic'],
    ['shipping.plan.save', ['orderops'], ['shipping.write'], 'shipping_plan_save', 'SHIPPING', 'WRITE', ['snapshot'], 'shipping', 'generic']
  ];
  return definitions.reduce(function (registry, definition) {
    var operationId = definition[0];
    var allowedApps = definition[1];
    var requiredUserPermissions = definition[2].slice();
    var upstreamAction = definition[3];
    var serviceBoundary = definition[4];
    var serviceCredentialMode = definition[5];
    var allowedFields = definition[6].slice();
    var requiredPurposePermissions = [];
    var operationClass = serviceCredentialMode === 'READ' ? 'READ_ONLY_DERIVED' : 'BUSINESS_DATA';
    var writableFields = serviceCredentialMode === 'WRITE' ? allowedFields.slice() : [];
    var serverComputedFields = [];
    var preconditionFields = allowedFields.filter(function (field) {
      return /(revision|hash|digest|sequence|fingerprint|version)$/i.test(field);
    });
    var systemFields = ['action', 'actorId', 'appId', 'credentialMode', 'credential', 'token', 'requestId', 'nexusRequest', 'roleIds', 'scope'];
    var enforceImmutableFields = false;

    if (/^foundation\.(config_write|replace_all|device\.promote)$/.test(operationId) || /^orderq\.customer\.reset_/.test(operationId)) {
      operationClass = 'SYSTEM_ADMIN';
    }
    if (/^company\.(profile_write|accounting_period_write|certificate_extract|backup_create|migrate_oneapp)$/.test(operationId)) {
      operationClass = 'SYSTEM_ADMIN';
    }
    if (operationId === 'dataops.snapshot.commit') {
      // DataOps 앱 사용 권한을 가진 비-VIEWER 사용자의 기존 작업 저장은 별도 dataops.write 사용자 권한을 요구하지 않는다.
      requiredUserPermissions = [];
      writableFields = ['기초', '주문', '입고', '출고', '실사', '단가'];
      serverComputedFields = ['전산잔량', '예상잔량', '로스', 'savedAt', 'revision'];
      preconditionFields = ['hash'];
      enforceImmutableFields = true;
    }
    if (operationId === 'dataops.situation.publish') {
      requiredUserPermissions = [];
      // 발행은 DataOps 앱 사용 권한과 WRITE 서비스 경계로 통제한다. 기존 일반 사용자의 업무 흐름을 축소하지 않는다.
      requiredPurposePermissions = [];
      writableFields = [];
    }
    if (/^dataops\.close\.(context|seal|prepare|write_chunks|commit|abort)$/.test(operationId)) {
      requiredUserPermissions = [];
      // 마감도 별도 사용자 목적 권한을 추가하지 않으며, VIEWER의 WRITE 요청은 공통 정책에서 차단한다.
      requiredPurposePermissions = [];
      writableFields = [];
    }

    registry[operationId] = {
      operationId: operationId,
      allowedApps: allowedApps,
      requiredAppAccess: allowedApps.slice(),
      requiredUserPermissions: requiredUserPermissions,
      requiredPurposePermissions: requiredPurposePermissions,
      operationClass: operationClass,
      upstreamAction: upstreamAction,
      securityBoundary: serviceBoundary,
      serviceBoundary: serviceBoundary,
      access: serviceCredentialMode,
      serviceCredentialMode: serviceCredentialMode,
      allowedFields: allowedFields,
      writableFields: writableFields,
      serverComputedFields: serverComputedFields,
      systemFields: systemFields,
      preconditionFields: preconditionFields,
      enforceImmutableFields: enforceImmutableFields,
      auditCategory: definition[7],
      responseSanitizer: definition[8]
    };
    return registry;
  }, {});
}

function nexusAuthGateway_(payload) {
  var started = Date.now();
  var requestId = 'REQ-' + Utilities.getUuid();
  var operationId = nexusAuthText_(payload.operationId);
  var definition = nexusAuthGatewayRegistry_()[operationId];
  var context = null;
  var credentialId = '';
  try {
    if (!definition) throw new Error('NEXUS_GATEWAY_OPERATION_DENIED');
    context = nexusAuthRequireSession_(payload.sessionToken);
    var appContext = nexusAuthRequireAppContext_(payload.appContextToken, context, definition);
    definition = Object.assign({}, definition, { verifiedAppId: appContext.appId });
    nexusAuthRequireOperationAccess_(context, definition);
    var body = nexusAuthGatewayValidatePayload_(definition, payload.payload);
    var credential = nexusAuthGatewayCredential_(definition.securityBoundary, definition.access);
    credentialId = credential.credentialId;
    var forwarded = nexusAuthGatewayEnvelope_(definition, body, credential, context, requestId);
    var parsed = nexusAuthGatewayFetch_(forwarded);
    if (!parsed || parsed.status !== 'success') {
      var upstreamError = new Error(nexusAuthGatewayUpstreamError_(parsed));
      if (Number.isFinite(Number(parsed && parsed.latestRevision))) upstreamError.latestRevision = Number(parsed.latestRevision);
      throw upstreamError;
    }
    var data = nexusAuthGatewaySanitize_(parsed.data === undefined ? parsed : parsed.data);
    nexusAuthGatewayAudit_(requestId, context, definition, credentialId, started, 'SUCCESS', '', parsed && parsed.correlationId);
    return nexusAuthJson_({ status: 'success', contractVersion: NEXUS_AUTH_VERSION, operationId: operationId, data: data });
  } catch (error) {
    var safeError = nexusAuthPublicError_(error);
    nexusAuthGatewayAudit_(requestId, context, definition || { operationId: operationId, securityBoundary: '', access: '', auditCategory: 'gateway' }, credentialId, started, nexusAuthGatewayFailureResult_(safeError), safeError, '');
    throw error;
  }
}

function nexusAuthGatewayFailureResult_(safeError) {
  var code = nexusAuthText_(safeError);
  if (code === 'IMMUTABLE_FIELD' || /_(DENIED|REQUIRED|EXPIRED|REVOKED|READ_ONLY)$/.test(code)) return 'DENIED';
  return 'FAILURE';
}

function nexusAuthRequireOperationAccess_(context, definition) {
  var user = context && context.user;
  if (!user) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
  if (user.role === 'VIEWER' && definition.serviceCredentialMode === 'WRITE') throw new Error('NEXUS_AUTH_VIEWER_READ_ONLY');
  (definition.requiredUserPermissions || []).forEach(function (permission) { nexusAuthRequirePermission_(user, permission); });
  (definition.requiredPurposePermissions || []).forEach(function (permission) { nexusAuthRequirePermission_(user, permission); });
  return true;
}

function nexusAuthGatewayValidatePayload_(definition, value) {
  var payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  var reserved = ['action', 'operationId', 'sessionToken', 'targetUrl', 'upstreamUrl', 'token', 'actorId', 'userId', 'loginId', 'appId', 'requestId', 'credential'];
  Object.keys(payload).forEach(function (key) {
    if (reserved.indexOf(key) >= 0 || definition.allowedFields.indexOf(key) < 0) throw new Error('NEXUS_GATEWAY_SCHEMA_DENIED');
  });
  if (definition.enforceImmutableFields) {
    nexusAuthRejectImmutableFields_(payload, (definition.serverComputedFields || []).concat(definition.systemFields || []));
  }
  if (/^foundation\.metadata_(read|write)$/.test(definition.operationId)) nexusAuthRejectFoundationMetadataReserved_(payload);
  return JSON.parse(JSON.stringify(payload));
}

function nexusAuthRejectFoundationMetadataReserved_(value) {
  var reserved = {
    actorId: true, userId: true, loginId: true, requestId: true, credential: true, credentialId: true,
    token: true, scope: true, companyId: true, nexusRequest: true, metadataRevision: true,
    recordRevision: true, updatedAt: true, audit: true, idempotency: true, snapshotId: true,
    targetUrl: true, upstreamUrl: true
  };
  function inspect(current) {
    if (Array.isArray(current)) return current.forEach(inspect);
    if (!current || typeof current !== 'object') return;
    Object.keys(current).forEach(function (key) {
      if (reserved[key]) throw new Error('NEXUS_GATEWAY_SCHEMA_DENIED');
      inspect(current[key]);
    });
  }
  inspect(value);
  return true;
}

function nexusAuthRejectImmutableFields_(value, immutableFields) {
  var denied = {};
  (immutableFields || []).forEach(function (field) { denied[String(field)] = true; });
  function inspect(current) {
    if (Array.isArray(current)) {
      current.forEach(inspect);
      return;
    }
    if (!current || typeof current !== 'object') return;
    Object.keys(current).forEach(function (key) {
      if (denied[key]) throw new Error('IMMUTABLE_FIELD');
      inspect(current[key]);
    });
  }
  inspect(value);
  return true;
}

function nexusAuthGatewayCredential_(boundary, access) {
  var key = String(boundary || '').toUpperCase() + '_' + String(access || '').toUpperCase();
  var propertyName = NEXUS_AUTH_PROPERTIES[key];
  if (!propertyName) throw new Error('NEXUS_GATEWAY_CREDENTIAL_ROUTE_DENIED');
  var rawToken = nexusAuthText_(PropertiesService.getScriptProperties().getProperty(propertyName));
  if (!rawToken) throw new Error('NEXUS_AUTH_SERVICE_NOT_CONNECTED');
  return { token: rawToken, credentialId: propertyName, version: 'V2' };
}

function nexusAuthGatewayEnvelope_(definition, body, credential, context, requestId) {
  var forwarded = JSON.parse(JSON.stringify(body));
  forwarded.action = definition.upstreamAction;
  forwarded.token = credential.token;
  forwarded.actorId = 'NEXUS_GATEWAY';
  forwarded.roleIds = [definition.securityBoundary + '_READ'];
  if (definition.access === 'WRITE') forwarded.roleIds.push(definition.securityBoundary + '_WRITE');
  if (definition.operationId === 'foundation.replace_all') forwarded.roleIds.push('FOUNDATION_REPLACE');
  if (/^company\.(profile_read|profile_write|accounting_period_read|accounting_period_write|certificate_extract|backup_create|migrate_oneapp)$/.test(definition.operationId)) forwarded.roleIds.push('COMPANY_ADMIN');
  forwarded.deviceId = 'NEXUS_GATEWAY';
  forwarded.device = 'NEXUS_GATEWAY';
  forwarded.environment = 'PRODUCTION';
  forwarded.scope = { companyId: 'ONEAPP' };
  forwarded.requestId = requestId;
  if (definition.operationId === 'foundation.replace_all') forwarded.transactionId = 'NXTX-' + Utilities.getUuid();
  forwarded.nexusRequest = {
    requestId: requestId, subjectUserId: context.user.userId, subjectLoginId: context.user.loginId,
    appId: definition.verifiedAppId, operationId: definition.operationId, contractVersion: NEXUS_AUTH_VERSION
  };
  return forwarded;
}

function nexusAuthGatewayFetch_(forwarded) {
  var properties = PropertiesService.getScriptProperties();
  var upstreamUrl = nexusAuthText_(properties.getProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL) || NEXUS_AUTH_DEFAULT_UPSTREAM_URL);
  if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(upstreamUrl)) throw new Error('NEXUS_AUTH_UPSTREAM_URL_INVALID');
  var response = UrlFetchApp.fetch(upstreamUrl, {
    method: 'post', contentType: 'text/plain;charset=utf-8', payload: JSON.stringify(forwarded), muteHttpExceptions: true, followRedirects: true
  });
  try { return JSON.parse(response.getContentText()); }
  catch (error) { throw new Error('NEXUS_GATEWAY_RESPONSE_INVALID'); }
}

function nexusAuthGatewayUpstreamError_(parsed) {
  var code = nexusAuthText_(parsed && parsed.message);
  if (/^[A-Z0-9_]{3,100}$/.test(code)) return code;
  // 행번호·업무키가 붙은 오류는 상세값을 버리고 안전한 대문자 코드만 전달한다.
  var structured = code.match(/^([A-Z0-9_]{3,100})(?::[^\s:]{1,120})+$/);
  if (structured) return structured[1];
  return 'NEXUS_GATEWAY_UPSTREAM_DENIED';
}

function nexusAuthGatewaySanitize_(value) {
  if (Array.isArray(value)) return value.map(nexusAuthGatewaySanitize_);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).reduce(function (result, key) {
    if (/(token|password|secret|credential|rawbody|actorid)/i.test(key)) return result;
    result[key] = nexusAuthGatewaySanitize_(value[key]);
    return result;
  }, {});
}

function nexusAuthGatewayAudit_(requestId, context, definition, credentialId, started, result, safeError, correlationId) {
  if (!nexusAuthIsInitialized_()) return;
  try {
    var ended = Date.now();
    nexusAuthAudit_('GATEWAY', context && context.user ? context.user.userId : '', '', result, {
      requestId: requestId, userId: context && context.user ? context.user.userId : '', loginId: context && context.user ? context.user.loginId : '',
      appId: definition.verifiedAppId || '', operationId: definition.operationId || '', upstreamAction: definition.upstreamAction || '',
      requiredUserPermissions: definition.requiredUserPermissions || [], requiredPurposePermissions: definition.requiredPurposePermissions || [],
      operationClass: definition.operationClass || '', securityBoundary: definition.securityBoundary || '', access: definition.access || '',
      credentialId: credentialId || '', protocol: NEXUS_AUTH_VERSION, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(),
      durationMs: ended - started, result: result, safeError: safeError || '', correlationId: nexusAuthText_(correlationId)
    });
  } catch (ignored) {}
}

function nexusAuthProxy_(payload) {
  var context = nexusAuthRequireSession_(payload.sessionToken);
  var request = payload.request || {};
  var method = nexusAuthText_(request.method || 'POST').toUpperCase();
  var body = request.body && typeof request.body === 'object' ? request.body : {};
  var action = nexusAuthText_(request.action || body.action);
  if (!action) throw new Error('NEXUS_PROXY_ACTION_REQUIRED');
  var permission = nexusAuthPermissionForAction_(action, method);
  nexusAuthRequirePermission_(context.user, permission);
  if (/^(initSync|chunk_master|chunk_history)$/.test(action)) nexusAuthRequirePermission_(context.user, 'foundation.replace');

  var properties = PropertiesService.getScriptProperties();
  var upstreamUrl = nexusAuthText_(properties.getProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL) || NEXUS_AUTH_DEFAULT_UPSTREAM_URL);
  if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(upstreamUrl)) throw new Error('NEXUS_AUTH_UPSTREAM_URL_INVALID');
  if (method !== 'GET' && method !== 'POST') throw new Error('NEXUS_PROXY_METHOD_DENIED');
  var forwarded = JSON.parse(JSON.stringify(body));
  forwarded.action = action;
  delete forwarded.sessionToken;
  var secretProperty = nexusAuthSecretPropertyForAction_(action);
  if (secretProperty) {
    var secret = nexusAuthText_(properties.getProperty(secretProperty));
    if (!secret) throw new Error('NEXUS_AUTH_SERVICE_NOT_CONNECTED');
    forwarded.token = secret;
  } else {
    delete forwarded.token;
  }
  var legacyFoundationRead = /^(full|master_only|config_only)$/.test(action);
  var legacyFoundationWrite = /^(initSync|chunk_master|chunk_history|config)$/.test(action);
  forwarded.actorId = legacyFoundationRead || legacyFoundationWrite ? 'NEXUS_GATEWAY' : context.user.loginId;
  if (legacyFoundationRead) forwarded.roleIds = ['FOUNDATION_READ'];
  if (legacyFoundationWrite) forwarded.roleIds = ['FOUNDATION_READ', 'FOUNDATION_WRITE'].concat(action === 'config' ? [] : ['FOUNDATION_REPLACE']);
  forwarded.deviceId = nexusAuthText_(forwarded.deviceId || 'NEXUS_GATEWAY');
  forwarded.device = nexusAuthText_(forwarded.device || forwarded.deviceId);
  forwarded.environment = 'PRODUCTION';
  forwarded.scope = { companyId: 'ONEAPP' };
  forwarded.nexusRequest = { requestId: 'REQ-' + Utilities.getUuid(), subjectUserId: context.user.userId, subjectLoginId: context.user.loginId, protocol: NEXUS_AUTH_LEGACY_VERSION };
  var options = {
    method: 'post', contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify(forwarded), muteHttpExceptions: true, followRedirects: true
  };
  var response = UrlFetchApp.fetch(upstreamUrl, options);
  var parsed;
  try { parsed = JSON.parse(response.getContentText()); }
  catch (error) { throw new Error('NEXUS_PROXY_RESPONSE_INVALID'); }
  nexusAuthAudit_('PROXY', context.user.userId, '', parsed && parsed.status === 'success' ? 'SUCCESS' : 'FAILURE', { action: action, permission: permission, protocol: NEXUS_AUTH_LEGACY_VERSION });
  return nexusAuthJson_(parsed);
}

function nexusAuthPermissionForAction_(action, method) {
  if (method === 'GET') {
    if (/^(full|master_only|config_only)$/.test(action)) return 'foundation.read';
    throw new Error('NEXUS_PROXY_ACTION_DENIED');
  }
  if (/^(initSync|chunk_master|chunk_history|config)$/.test(action)) return 'foundation.write';
  if (/^dataops_snapshot_get$/.test(action) || /^situation_dataops_(ping|begin|page|head)$/.test(action)) return 'dataops.read';
  if (/^dataops_snapshot_commit$/.test(action)) return 'dataops.write';
  if (/^situation_dataops_publish$/.test(action)) return 'dataops.publish';
  if (/^dataops_(v1_security_ping|close_ping)$/.test(action)) return 'dataops.read';
  if (/^dataops_close_(context|seal)$/.test(action)) return 'dataops.close';
  if (/^dataops_close_(prepare|write_chunks|commit|abort)$/.test(action)) return 'dataops.close';
  if (/^(orderq_sync_pull|orderq_order_head|orderq_m9_ping|orderq_m9_pull|situation_orderq_(begin|page|head))$/.test(action)) return 'orderq.read';
  if (/^(orderq_sync_push|orderq_m9_migrate|orderq_m9_command_(prepare|commit|abort))$/.test(action)) return 'orderq.write';
  if (/^orderq_customer_reset_(preview|execute)$/.test(action)) return 'orderq.admin';
  if (/^shipping_plan_(list|get)$/.test(action)) return 'shipping.read';
  if (/^shipping_plan_save$/.test(action)) return 'shipping.write';
  throw new Error('NEXUS_PROXY_ACTION_DENIED');
}

function nexusAuthSecretPropertyForAction_(action) {
  if (/^(full|master_only|config_only)$/.test(action)) return NEXUS_AUTH_PROPERTIES.FOUNDATION_READ;
  if (/^(initSync|chunk_master|chunk_history|config)$/.test(action)) return NEXUS_AUTH_PROPERTIES.FOUNDATION_WRITE;
  if (action === 'dataops_snapshot_get' || /^situation_dataops_(ping|begin|page|head)$/.test(action) || /^dataops_close_(context|seal)$/.test(action)) return NEXUS_AUTH_PROPERTIES.DATAOPS_READ;
  if (action === 'dataops_snapshot_commit' || /^dataops_close_(prepare|write_chunks|commit|abort)$/.test(action)) return NEXUS_AUTH_PROPERTIES.DATAOPS_WRITE;
  if (action === 'situation_dataops_publish') return NEXUS_AUTH_PROPERTIES.LEGACY_DATAOPS_PUBLISH;
  if (/^orderq_/.test(action) || /^situation_orderq_/.test(action)) return NEXUS_AUTH_PROPERTIES.LEGACY_ORDERQ;
  if (/^shipping_plan_/.test(action)) return NEXUS_AUTH_PROPERTIES.LEGACY_SHIPPING;
  return '';
}

function nexusAuthRequirePermission_(user, permission) {
  if (user.role === 'OWNER_MASTER') return true;
  var permissions = nexusAuthPermissions_(user);
  var impliedWrite = permission.replace(/\.read$/, '.write');
  if (permissions.indexOf(permission) < 0 && (impliedWrite === permission || permissions.indexOf(impliedWrite) < 0)) throw new Error('NEXUS_AUTH_PERMISSION_DENIED');
  return true;
}

function nexusAuthPermissions_(user) {
  if (user.role === 'OWNER_MASTER') return NEXUS_AUTH_ALL_PERMISSIONS.slice();
  if (user.role === 'FULL_ACCESS') return NEXUS_AUTH_BUSINESS_PERMISSIONS.slice();
  if (user.role === 'VIEWER') return NEXUS_AUTH_PROFILE_PERMISSIONS.VIEWER.slice();
  return nexusAuthValidatePermissions_(nexusAuthParseJson_(user.permissionsJson, []), 'CUSTOM');
}

function nexusAuthValidatePermissions_(value, role) {
  if (role === 'FULL_ACCESS') return NEXUS_AUTH_BUSINESS_PERMISSIONS.slice();
  if (role === 'VIEWER') return NEXUS_AUTH_PROFILE_PERMISSIONS.VIEWER.slice();
  var list = Array.isArray(value) ? value : [];
  return NEXUS_AUTH_ALL_PERMISSIONS.filter(function (permission) { return list.indexOf(permission) >= 0 && permission.indexOf('admin.') !== 0; });
}

function nexusAuthValidateRole_(value) {
  var role = nexusAuthText_(value || 'VIEWER').toUpperCase();
  if (['OWNER_MASTER', 'FULL_ACCESS', 'VIEWER', 'CUSTOM'].indexOf(role) < 0) throw new Error('NEXUS_AUTH_ROLE_INVALID');
  return role;
}

function nexusAuthPublicUser_(user) {
  return {
    userId: user.userId, loginId: user.loginId, displayName: user.displayName,
    role: user.role, permissions: nexusAuthPermissions_(user), status: user.status,
    createdAt: user.createdAt, updatedAt: user.updatedAt, deletedAt: user.deletedAt,
    recoverUntil: user.recoverUntil, inviteExpiresAt: user.inviteExpiresAt, version: Number(user.version || 0)
  };
}

function nexusAuthAdminUserView_(user) {
  var visibility = nexusAuthVisibleApps_(user);
  return {
    userId: user.userId,
    loginId: user.loginId,
    displayName: user.displayName,
    accountType: user.role === 'OWNER_MASTER' ? 'OWNER_MASTER' : 'DELEGATED_USER',
    status: user.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
    visibleAppIds: visibility.visibleAppIds,
    visibleAppsConfigured: visibility.configured,
    activationPending: user.status !== 'ACTIVE' && Boolean(user.inviteDigest),
    activationExpiresAt: user.status !== 'ACTIVE' && user.inviteDigest ? user.inviteExpiresAt : '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    version: Number(user.version || 0)
  };
}

function nexusAuthVisibleApps_(user) {
  var raw = nexusAuthText_(user && user.visibleAppIdsJson);
  if (!raw) return { configured: false, visibleAppIds: NEXUS_AUTH_VISIBLE_APP_IDS.slice() };
  var parsed = nexusAuthParseJson_(raw, null);
  if (!Array.isArray(parsed)) throw new Error('NEXUS_AUTH_VISIBLE_APPS_STORED_INVALID');
  return { configured: true, visibleAppIds: nexusAuthValidateVisibleAppIds_(parsed) };
}

function nexusAuthValidateVisibleAppIds_(value) {
  if (!Array.isArray(value)) throw new Error('NEXUS_AUTH_VISIBLE_APPS_INVALID');
  var seen = {};
  value.forEach(function (candidate) {
    if (typeof candidate !== 'string' || candidate !== candidate.trim() || NEXUS_AUTH_VISIBLE_APP_IDS.indexOf(candidate) < 0 || seen[candidate]) {
      throw new Error('NEXUS_AUTH_VISIBLE_APPS_INVALID');
    }
    seen[candidate] = true;
  });
  return NEXUS_AUTH_VISIBLE_APP_IDS.filter(function (appId) { return Boolean(seen[appId]); });
}

function nexusAuthRequireOwnerMaster_(user) {
  if (!user || user.role !== 'OWNER_MASTER' || user.status !== 'ACTIVE') throw new Error('NEXUS_AUTH_ADMIN_DENIED');
  return true;
}

function nexusAuthMutableDelegatedUser_(userId) {
  var user = nexusAuthFindUserById_(nexusAuthText_(userId));
  if (!user || user.status === 'PURGED') throw new Error('NEXUS_AUTH_USER_NOT_FOUND');
  if (user.role === 'OWNER_MASTER') throw new Error('NEXUS_AUTH_MASTER_IMMUTABLE');
  return user;
}

function nexusAuthRequireExpectedVersion_(user, value) {
  var expected = Number(value);
  var current = Number(user.version || 0);
  if (!Number.isInteger(expected) || expected < 1) throw new Error('NEXUS_AUTH_EXPECTED_VERSION_REQUIRED');
  if (expected !== current) throw new Error('NEXUS_AUTH_VERSION_CONFLICT');
  return current;
}

function nexusAuthAssertPayloadFields_(payload, allowed) {
  Object.keys(payload || {}).forEach(function (key) {
    if (allowed.indexOf(key) < 0) throw new Error('NEXUS_AUTH_PAYLOAD_FIELD_DENIED');
  });
}

function nexusAuthWithScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return callback(); }
  finally { lock.releaseLock(); }
}

function nexusAuthServiceBooleans_() {
  var properties = PropertiesService.getScriptProperties();
  return {
    upstream: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL) || NEXUS_AUTH_DEFAULT_UPSTREAM_URL),
    foundationRead: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.FOUNDATION_READ)),
    foundationWrite: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.FOUNDATION_WRITE)),
    dataOpsRead: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.DATAOPS_READ)),
    dataOpsWrite: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.DATAOPS_WRITE)),
    orderQRead: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.ORDERQ_READ)),
    orderQWrite: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.ORDERQ_WRITE)),
    shippingRead: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.SHIPPING_READ)),
    shippingWrite: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.SHIPPING_WRITE))
  };
}

function nexusAuthRevokeUserSessions_(userId) {
  var now = new Date().toISOString();
  nexusAuthRows_(NEXUS_AUTH_SHEETS.SESSIONS).forEach(function (session) {
    if (session.userId === userId && !session.revokedAt) {
      session.revokedAt = now;
      nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.SESSIONS, session._row, session);
    }
  });
}

function nexusAuthPurgeExpiredUsers_() {
  // Compatibility stub. User deletion and automatic anonymization are prohibited.
  return 0;
}

function nexusAuthRateCheck_(loginId) {
  var key = nexusAuthSha256_(loginId);
  var row = nexusAuthRows_(NEXUS_AUTH_SHEETS.RATE).find(function (item) { return item.key === key; });
  if (row && Date.parse(row.blockedUntil || '') > Date.now()) throw new Error('NEXUS_AUTH_RATE_LIMITED');
}

function nexusAuthRateFail_(loginId) {
  var key = nexusAuthSha256_(loginId);
  var rows = nexusAuthRows_(NEXUS_AUTH_SHEETS.RATE);
  var row = rows.find(function (item) { return item.key === key; });
  var now = Date.now();
  if (!row) {
    nexusAuthAppend_(NEXUS_AUTH_SHEETS.RATE, { key: key, windowStart: new Date(now).toISOString(), count: 1, blockedUntil: '' });
    return;
  }
  if (now - Date.parse(row.windowStart || '') > NEXUS_AUTH_LOGIN_WINDOW_MS) {
    row.windowStart = new Date(now).toISOString();
    row.count = 1;
    row.blockedUntil = '';
  } else {
    row.count = Number(row.count || 0) + 1;
    if (row.count >= NEXUS_AUTH_LOGIN_LIMIT) row.blockedUntil = new Date(now + NEXUS_AUTH_LOGIN_WINDOW_MS).toISOString();
  }
  nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.RATE, row._row, row);
}

function nexusAuthRateClear_(loginId) {
  var key = nexusAuthSha256_(loginId);
  var row = nexusAuthRows_(NEXUS_AUTH_SHEETS.RATE).find(function (item) { return item.key === key; });
  if (!row) return;
  row.windowStart = new Date().toISOString();
  row.count = 0;
  row.blockedUntil = '';
  nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.RATE, row._row, row);
}

function nexusAuthAudit_(action, actorUserId, targetUserId, result, detail) {
  nexusAuthAppend_(NEXUS_AUTH_SHEETS.AUDIT, {
    auditId: 'AUD-' + Utilities.getUuid(), at: new Date().toISOString(), actorUserId: actorUserId || '',
    action: action, targetUserId: targetUserId || '', result: result || 'SUCCESS', detailJson: JSON.stringify(detail || {})
  });
}

function nexusAuthIsInitialized_() {
  var properties = PropertiesService.getScriptProperties();
  return Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.DB_ID) && properties.getProperty(NEXUS_AUTH_PROPERTIES.PEPPER));
}

function nexusAuthRequireInitialized_() {
  if (!nexusAuthIsInitialized_()) throw new Error('NEXUS_AUTH_NOT_INITIALIZED');
}

function nexusAuthDb_() {
  nexusAuthRequireInitialized_();
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(NEXUS_AUTH_PROPERTIES.DB_ID));
}

function nexusAuthEnsureSheets_(database) {
  Object.keys(NEXUS_AUTH_HEADERS).forEach(function (sheetName) {
    var sheet = database.getSheetByName(sheetName);
    if (!sheet) sheet = database.insertSheet(sheetName);
    var headers = NEXUS_AUTH_HEADERS[sheetName];
    if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  });
  var defaultSheet = database.getSheetByName('Sheet1');
  if (defaultSheet && database.getSheets().length > Object.keys(NEXUS_AUTH_HEADERS).length) database.deleteSheet(defaultSheet);
}

function nexusAuthRows_(sheetName) {
  var sheet = nexusAuthDb_().getSheetByName(sheetName);
  var headers = NEXUS_AUTH_HEADERS[sheetName];
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().map(function (values, index) {
    var row = { _row: index + 2 };
    headers.forEach(function (header, column) { row[header] = values[column]; });
    return row;
  });
}

function nexusAuthUsers_() { return nexusAuthRows_(NEXUS_AUTH_SHEETS.USERS); }
function nexusAuthFindUserByLogin_(loginId) { return nexusAuthUsers_().find(function (user) { return user.loginId === loginId; }) || null; }
function nexusAuthFindUserById_(userId) { return nexusAuthUsers_().find(function (user) { return user.userId === userId; }) || null; }

function nexusAuthAppend_(sheetName, value) {
  if (sheetName === NEXUS_AUTH_SHEETS.USERS) nexusAuthRequireCurrentUsersSchema_();
  var sheet = nexusAuthDb_().getSheetByName(sheetName);
  var headers = NEXUS_AUTH_HEADERS[sheetName];
  sheet.appendRow(headers.map(function (header) { return value[header] === undefined ? '' : value[header]; }));
}

function nexusAuthWriteRow_(sheetName, rowNumber, value) {
  if (sheetName === NEXUS_AUTH_SHEETS.USERS) nexusAuthRequireCurrentUsersSchema_();
  var sheet = nexusAuthDb_().getSheetByName(sheetName);
  var headers = NEXUS_AUTH_HEADERS[sheetName];
  sheet.getRange(Number(rowNumber), 1, 1, headers.length).setValues([headers.map(function (header) { return value[header] === undefined ? '' : value[header]; })]);
}

function nexusAuthParseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('NEXUS_AUTH_POST_REQUIRED');
  var parsed = JSON.parse(e.postData.contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('NEXUS_AUTH_PAYLOAD_INVALID');
  return parsed;
}

function nexusAuthJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function nexusAuthText_(value) { return String(value === undefined || value === null ? '' : value).trim(); }
function nexusAuthParseJson_(value, fallback) { try { return JSON.parse(String(value || '')); } catch (error) { return fallback; } }

function nexusAuthNormalizeLoginId_(value) {
  var loginId = nexusAuthText_(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(loginId)) throw new Error('NEXUS_AUTH_LOGIN_ID_INVALID');
  return loginId;
}

function nexusAuthDisplayName_(value) {
  var displayName = nexusAuthText_(value);
  if (displayName.length < 1 || displayName.length > 60) throw new Error('NEXUS_AUTH_DISPLAY_NAME_INVALID');
  return displayName;
}

function nexusAuthValidateSalt_(value) {
  var salt = nexusAuthText_(value);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(salt)) throw new Error('NEXUS_AUTH_PASSWORD_SALT_INVALID');
  return salt;
}

function nexusAuthValidateVerifier_(value) {
  var verifier = nexusAuthText_(value);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(verifier)) throw new Error('NEXUS_AUTH_PASSWORD_VERIFIER_INVALID');
  return verifier;
}

function nexusAuthPepper_() {
  var pepper = PropertiesService.getScriptProperties().getProperty(NEXUS_AUTH_PROPERTIES.PEPPER);
  if (!pepper) throw new Error('NEXUS_AUTH_NOT_INITIALIZED');
  return pepper;
}

function nexusAuthPasswordHash_(verifier) {
  return nexusAuthHexBytes_(Utilities.computeHmacSha256Signature(verifier, nexusAuthPepper_(), Utilities.Charset.UTF_8));
}

function nexusAuthHmac_(value) {
  return nexusAuthHexBytes_(Utilities.computeHmacSha256Signature(String(value || ''), nexusAuthPepper_(), Utilities.Charset.UTF_8));
}

function nexusAuthSha256_(value) {
  return nexusAuthHexBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, nexusAuthText_(value), Utilities.Charset.UTF_8));
}

function nexusAuthHexBytes_(bytes) {
  return bytes.map(function (value) { var byte = value < 0 ? value + 256 : value; return byte.toString(16).padStart(2, '0'); }).join('');
}

function nexusAuthBase64UrlBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function nexusAuthRandomToken_(minimumLength) {
  var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), new Date().toISOString(), Math.random()].join('|');
  var token = nexusAuthBase64UrlBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8));
  while (token.length < Number(minimumLength || 32)) token += nexusAuthBase64UrlBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token + Utilities.getUuid(), Utilities.Charset.UTF_8));
  return token.slice(0, Number(minimumLength || 32));
}

function nexusAuthConstantTime_(left, right) {
  var a = String(left || '');
  var b = String(right || '');
  var diff = a.length ^ b.length;
  var length = Math.max(a.length, b.length, 1);
  for (var index = 0; index < length; index += 1) diff |= (a.charCodeAt(index % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(index % Math.max(1, b.length)) || 0);
  return diff === 0;
}

function nexusAuthPublicError_(error) {
  var code = nexusAuthText_(error && error.message ? error.message : error);
  // Upstream business errors are already reduced to an uppercase code by nexusAuthGatewayUpstreamError_.
  // Returning that code gives operators an actionable failure without exposing a payload, token, stack, or raw response.
  if (code === 'IMMUTABLE_FIELD' || /^(NEXUS_AUTH|NEXUS_PROXY|NEXUS_GATEWAY|ONEAPP_NEXUS|DATAOPS|ORDERQ|SHIPPING|FOUNDATION|METADATA|MAPPING|FIELD|REQUIRED|CUSTOMER_LEGACY|CLOSE)_/.test(code)) return code;
  return 'NEXUS_AUTH_REQUEST_FAILED';
}
