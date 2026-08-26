/**
 * ONEAPP NEXUS authentication and business-token gateway.
 *
 * Deploy this file as a standalone Apps Script Web App that executes as the
 * owner. It intentionally lives outside the bound ONEAPP business project:
 * browser sessions reach this gateway, and only the gateway reaches the
 * retained business Web App with server-held credentials.
 */

var NEXUS_AUTH_VERSION = 'NEXUS_AUTH_V1';
var NEXUS_AUTH_DEFAULT_UPSTREAM_URL = 'https://script.google.com/macros/s/AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw/exec';
var NEXUS_AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
var NEXUS_AUTH_INVITE_TTL_MS = 72 * 60 * 60 * 1000;
var NEXUS_AUTH_RECOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var NEXUS_AUTH_LOGIN_WINDOW_MS = 10 * 60 * 1000;
var NEXUS_AUTH_LOGIN_LIMIT = 8;
var NEXUS_AUTH_PROPERTIES = Object.freeze({
  DB_ID: 'NEXUS_AUTH_DB_ID',
  PEPPER: 'NEXUS_AUTH_PEPPER',
  BOOTSTRAP_DIGEST: 'NEXUS_AUTH_BOOTSTRAP_DIGEST',
  BOOTSTRAP_EXPIRES_AT: 'NEXUS_AUTH_BOOTSTRAP_EXPIRES_AT',
  UPSTREAM_URL: 'NEXUS_AUTH_UPSTREAM_URL',
  DATAOPS_READ: 'NEXUS_AUTH_SECRET_DATAOPS_READ',
  DATAOPS_WRITE: 'NEXUS_AUTH_SECRET_DATAOPS_WRITE',
  DATAOPS_PUBLISH: 'NEXUS_AUTH_SECRET_DATAOPS_PUBLISH',
  ORDERQ: 'NEXUS_AUTH_SECRET_ORDERQ',
  SHIPPING: 'NEXUS_AUTH_SECRET_SHIPPING'
});
var NEXUS_AUTH_SHEETS = Object.freeze({
  USERS: 'Users',
  SESSIONS: 'Sessions',
  AUDIT: 'Audit',
  RATE: 'RateLimits'
});
var NEXUS_AUTH_HEADERS = Object.freeze({
  Users: ['userId', 'loginId', 'displayName', 'role', 'permissionsJson', 'passwordSalt', 'passwordHash', 'status', 'createdAt', 'createdBy', 'updatedAt', 'deletedAt', 'recoverUntil', 'inviteDigest', 'inviteExpiresAt', 'version'],
  Sessions: ['sessionDigest', 'userId', 'issuedAt', 'expiresAt', 'lastSeenAt', 'revokedAt', 'device'],
  Audit: ['auditId', 'at', 'actorUserId', 'action', 'targetUserId', 'result', 'detailJson'],
  RateLimits: ['key', 'windowStart', 'count', 'blockedUntil']
});
var NEXUS_AUTH_ALL_PERMISSIONS = Object.freeze([
  'foundation.read', 'foundation.write',
  'merchops.read', 'merchops.write',
  'dataops.read', 'dataops.write', 'dataops.publish', 'dataops.close',
  'orderq.read', 'orderq.write', 'orderq.admin',
  'smartinput.use', 'admin.users', 'admin.services', 'admin.audit'
]);
var NEXUS_AUTH_BUSINESS_PERMISSIONS = Object.freeze(NEXUS_AUTH_ALL_PERMISSIONS.filter(function (permission) {
  return permission.indexOf('admin.') !== 0;
}));
var NEXUS_AUTH_PROFILE_PERMISSIONS = Object.freeze({
  FULL_ACCESS: NEXUS_AUTH_BUSINESS_PERMISSIONS,
  VIEWER: ['foundation.read', 'merchops.read', 'dataops.read', 'orderq.read', 'smartinput.use'],
  CUSTOM: []
});

function doPost(e) {
  try {
    var payload = nexusAuthParseBody_(e);
    var action = nexusAuthText_(payload.action);
    if (!action) throw new Error('NEXUS_AUTH_ACTION_REQUIRED');
    if (action === 'nexus_proxy') return nexusAuthProxy_(payload);
    var data = nexusAuthDispatch_(action, payload);
    return nexusAuthJson_({ status: 'success', action: action, data: data });
  } catch (error) {
    return nexusAuthJson_({ status: 'error', message: nexusAuthPublicError_(error) });
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
  if (action === 'nexus_auth_session') return nexusAuthSessionView_(nexusAuthRequireSession_(payload.sessionToken));
  if (action === 'nexus_auth_logout') return nexusAuthLogout_(payload);

  var session = nexusAuthRequireSession_(payload.sessionToken);
  if (action === 'nexus_admin_users') return nexusAuthAdminUsers_(session);
  if (action === 'nexus_admin_invite') return nexusAuthAdminInvite_(session, payload);
  if (action === 'nexus_admin_permissions') return nexusAuthAdminPermissions_(session, payload);
  if (action === 'nexus_admin_delete_user') return nexusAuthAdminDelete_(session, payload);
  if (action === 'nexus_admin_recover_user') return nexusAuthAdminRecover_(session, payload);
  if (action === 'nexus_admin_service_status') return nexusAuthServiceStatus_(session);
  if (action === 'nexus_admin_configure_services') return nexusAuthConfigureServices_(session, payload);
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
      inviteDigest: '', inviteExpiresAt: '', version: 1
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
  if (!user || user.status !== 'INVITED') throw new Error('NEXUS_AUTH_ACTIVATION_DENIED');
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
  nexusAuthAudit_('ACTIVATE', user.userId, user.userId, 'SUCCESS', {});
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
    nexusAuthAudit_('LOGIN', '', user ? user.userId : '', 'DENIED', { loginIdDigest: nexusAuthSha256_(loginId) });
    throw new Error('NEXUS_AUTH_LOGIN_DENIED');
  }
  nexusAuthRateClear_(loginId);
  nexusAuthAudit_('LOGIN', user.userId, user.userId, 'SUCCESS', {});
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
  return { sessionToken: rawToken, session: nexusAuthSessionView_({ user: user, session: session }) };
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

function nexusAuthSessionView_(context) {
  var user = context.user;
  return {
    user: {
      userId: user.userId, loginId: user.loginId, displayName: user.displayName,
      role: user.role, permissions: nexusAuthPermissions_(user), status: user.status
    },
    expiresAt: context.session.expiresAt,
    serviceConnections: nexusAuthServiceBooleans_()
  };
}

function nexusAuthAdminUsers_(context) {
  nexusAuthRequirePermission_(context.user, 'admin.users');
  nexusAuthPurgeExpiredUsers_();
  return nexusAuthUsers_().filter(function (user) { return user.status !== 'PURGED'; }).map(nexusAuthPublicUser_);
}

function nexusAuthAdminInvite_(context, payload) {
  nexusAuthRequirePermission_(context.user, 'admin.users');
  var loginId = nexusAuthNormalizeLoginId_(payload.loginId);
  if (nexusAuthFindUserByLogin_(loginId)) throw new Error('NEXUS_AUTH_LOGIN_ID_EXISTS');
  var role = nexusAuthValidateRole_(payload.role);
  if (role === 'OWNER_MASTER') throw new Error('NEXUS_AUTH_MASTER_UNIQUE');
  var permissions = nexusAuthValidatePermissions_(payload.permissions, role);
  var inviteCode = 'INV-' + nexusAuthRandomToken_(24);
  var now = new Date();
  var user = {
    userId: 'USR-' + Utilities.getUuid(), loginId: loginId, displayName: nexusAuthDisplayName_(payload.displayName),
    role: role, permissionsJson: JSON.stringify(permissions), passwordSalt: '', passwordHash: '', status: 'INVITED',
    createdAt: now.toISOString(), createdBy: context.user.userId, updatedAt: now.toISOString(), deletedAt: '', recoverUntil: '',
    inviteDigest: nexusAuthSha256_(inviteCode), inviteExpiresAt: new Date(now.getTime() + NEXUS_AUTH_INVITE_TTL_MS).toISOString(), version: 1
  };
  nexusAuthAppend_(NEXUS_AUTH_SHEETS.USERS, user);
  nexusAuthAudit_('INVITE', context.user.userId, user.userId, 'SUCCESS', { role: role, permissions: permissions });
  return { user: nexusAuthPublicUser_(user), inviteCode: inviteCode };
}

function nexusAuthAdminPermissions_(context, payload) {
  nexusAuthRequirePermission_(context.user, 'admin.users');
  var user = nexusAuthFindUserById_(nexusAuthText_(payload.userId));
  if (!user || user.status === 'PURGED') throw new Error('NEXUS_AUTH_USER_NOT_FOUND');
  if (user.role === 'OWNER_MASTER') throw new Error('NEXUS_AUTH_MASTER_IMMUTABLE');
  var role = nexusAuthValidateRole_(payload.role);
  if (role === 'OWNER_MASTER') throw new Error('NEXUS_AUTH_MASTER_UNIQUE');
  user.role = role;
  user.permissionsJson = JSON.stringify(nexusAuthValidatePermissions_(payload.permissions, role));
  user.updatedAt = new Date().toISOString();
  user.version = Number(user.version || 0) + 1;
  nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
  nexusAuthRevokeUserSessions_(user.userId);
  nexusAuthAudit_('PERMISSIONS', context.user.userId, user.userId, 'SUCCESS', { role: role, permissions: nexusAuthPermissions_(user) });
  return nexusAuthPublicUser_(user);
}

function nexusAuthAdminDelete_(context, payload) {
  nexusAuthRequirePermission_(context.user, 'admin.users');
  var user = nexusAuthFindUserById_(nexusAuthText_(payload.userId));
  if (!user || user.status === 'PURGED') throw new Error('NEXUS_AUTH_USER_NOT_FOUND');
  if (user.role === 'OWNER_MASTER' || user.userId === context.user.userId) throw new Error('NEXUS_AUTH_MASTER_DELETE_DENIED');
  var now = new Date();
  user.status = 'DELETED';
  user.deletedAt = now.toISOString();
  user.recoverUntil = new Date(now.getTime() + NEXUS_AUTH_RECOVERY_TTL_MS).toISOString();
  user.updatedAt = now.toISOString();
  user.version = Number(user.version || 0) + 1;
  nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
  nexusAuthRevokeUserSessions_(user.userId);
  nexusAuthAudit_('DELETE', context.user.userId, user.userId, 'SUCCESS', { recoverUntil: user.recoverUntil });
  return nexusAuthPublicUser_(user);
}

function nexusAuthAdminRecover_(context, payload) {
  nexusAuthRequirePermission_(context.user, 'admin.users');
  var user = nexusAuthFindUserById_(nexusAuthText_(payload.userId));
  if (!user || user.status !== 'DELETED') throw new Error('NEXUS_AUTH_USER_NOT_RECOVERABLE');
  if (Date.parse(user.recoverUntil || '') <= Date.now()) throw new Error('NEXUS_AUTH_RECOVERY_EXPIRED');
  user.status = user.passwordHash ? 'ACTIVE' : 'INVITED';
  user.deletedAt = '';
  user.recoverUntil = '';
  user.updatedAt = new Date().toISOString();
  user.version = Number(user.version || 0) + 1;
  nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
  nexusAuthAudit_('RECOVER', context.user.userId, user.userId, 'SUCCESS', {});
  return nexusAuthPublicUser_(user);
}

function nexusAuthServiceStatus_(context) {
  nexusAuthRequirePermission_(context.user, 'admin.services');
  return nexusAuthServiceBooleans_();
}

function nexusAuthConfigureServices_(context, payload) {
  nexusAuthRequirePermission_(context.user, 'admin.services');
  var properties = PropertiesService.getScriptProperties();
  var allowed = {
    upstreamUrl: NEXUS_AUTH_PROPERTIES.UPSTREAM_URL,
    dataOpsRead: NEXUS_AUTH_PROPERTIES.DATAOPS_READ,
    dataOpsWrite: NEXUS_AUTH_PROPERTIES.DATAOPS_WRITE,
    dataOpsPublish: NEXUS_AUTH_PROPERTIES.DATAOPS_PUBLISH,
    orderQ: NEXUS_AUTH_PROPERTIES.ORDERQ,
    shipping: NEXUS_AUTH_PROPERTIES.SHIPPING
  };
  var changed = [];
  Object.keys(allowed).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(payload.services || {}, key)) return;
    var value = nexusAuthText_(payload.services[key]);
    if (!value) return;
    if (key === 'upstreamUrl' && !/^https:\/\/script\.google\.com\/macros\/s\//i.test(value)) throw new Error('NEXUS_AUTH_UPSTREAM_URL_INVALID');
    properties.setProperty(allowed[key], value);
    changed.push(key);
  });
  nexusAuthAudit_('SERVICE_CONFIG', context.user.userId, '', 'SUCCESS', { changed: changed });
  return nexusAuthServiceBooleans_();
}

function nexusAuthAdminAudit_(context, payload) {
  nexusAuthRequirePermission_(context.user, 'admin.audit');
  var limit = Math.max(1, Math.min(200, Number(payload.limit || 100)));
  return nexusAuthRows_(NEXUS_AUTH_SHEETS.AUDIT).slice(-limit).reverse().map(function (row) {
    return { auditId: row.auditId, at: row.at, actorUserId: row.actorUserId, action: row.action, targetUserId: row.targetUserId, result: row.result, detail: nexusAuthParseJson_(row.detailJson, {}) };
  });
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

  var properties = PropertiesService.getScriptProperties();
  var upstreamUrl = nexusAuthText_(properties.getProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL) || NEXUS_AUTH_DEFAULT_UPSTREAM_URL);
  if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(upstreamUrl)) throw new Error('NEXUS_AUTH_UPSTREAM_URL_INVALID');
  var options;
  if (method === 'GET') {
    var query = '?action=' + encodeURIComponent(action);
    options = { method: 'get', muteHttpExceptions: true, followRedirects: true };
    upstreamUrl += query;
  } else if (method === 'POST') {
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
    forwarded.actorId = context.user.loginId;
    forwarded.deviceId = nexusAuthText_(forwarded.deviceId || 'NEXUS_GATEWAY');
    forwarded.device = nexusAuthText_(forwarded.device || forwarded.deviceId);
    forwarded.environment = 'PRODUCTION';
    forwarded.scope = { companyId: 'ONEAPP' };
    options = {
      method: 'post', contentType: 'text/plain;charset=utf-8',
      payload: JSON.stringify(forwarded), muteHttpExceptions: true, followRedirects: true
    };
  } else {
    throw new Error('NEXUS_PROXY_METHOD_DENIED');
  }
  var response = UrlFetchApp.fetch(upstreamUrl, options);
  var parsed;
  try { parsed = JSON.parse(response.getContentText()); }
  catch (error) { throw new Error('NEXUS_PROXY_RESPONSE_INVALID'); }
  nexusAuthAudit_('PROXY', context.user.userId, '', parsed && parsed.status === 'success' ? 'SUCCESS' : 'FAILURE', { action: action, permission: permission });
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
  if (/^shipping_plan_(list|get)$/.test(action)) return 'orderq.read';
  if (/^shipping_plan_save$/.test(action)) return 'orderq.write';
  throw new Error('NEXUS_PROXY_ACTION_DENIED');
}

function nexusAuthSecretPropertyForAction_(action) {
  if (action === 'dataops_snapshot_get' || /^situation_dataops_(ping|begin|page|head)$/.test(action) || /^dataops_close_(context|seal)$/.test(action)) return NEXUS_AUTH_PROPERTIES.DATAOPS_READ;
  if (action === 'dataops_snapshot_commit' || /^dataops_close_(prepare|write_chunks|commit|abort)$/.test(action)) return NEXUS_AUTH_PROPERTIES.DATAOPS_WRITE;
  if (action === 'situation_dataops_publish') return NEXUS_AUTH_PROPERTIES.DATAOPS_PUBLISH;
  if (/^orderq_/.test(action) || /^situation_orderq_/.test(action)) return NEXUS_AUTH_PROPERTIES.ORDERQ;
  if (/^shipping_plan_/.test(action)) return NEXUS_AUTH_PROPERTIES.SHIPPING;
  return '';
}

function nexusAuthRequirePermission_(user, permission) {
  if (user.role === 'OWNER_MASTER') return true;
  if (nexusAuthPermissions_(user).indexOf(permission) < 0) throw new Error('NEXUS_AUTH_PERMISSION_DENIED');
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

function nexusAuthServiceBooleans_() {
  var properties = PropertiesService.getScriptProperties();
  return {
    upstream: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.UPSTREAM_URL) || NEXUS_AUTH_DEFAULT_UPSTREAM_URL),
    dataOpsRead: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.DATAOPS_READ)),
    dataOpsWrite: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.DATAOPS_WRITE)),
    dataOpsPublish: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.DATAOPS_PUBLISH)),
    orderQ: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.ORDERQ)),
    shipping: Boolean(properties.getProperty(NEXUS_AUTH_PROPERTIES.SHIPPING))
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
  nexusAuthUsers_().forEach(function (user) {
    if (user.status !== 'DELETED' || Date.parse(user.recoverUntil || '') > Date.now()) return;
    user.loginId = 'purged-' + nexusAuthSha256_(user.userId).slice(0, 16);
    user.displayName = '삭제된 사용자';
    user.permissionsJson = '[]';
    user.passwordSalt = '';
    user.passwordHash = '';
    user.inviteDigest = '';
    user.inviteExpiresAt = '';
    user.status = 'PURGED';
    user.updatedAt = new Date().toISOString();
    user.version = Number(user.version || 0) + 1;
    nexusAuthWriteRow_(NEXUS_AUTH_SHEETS.USERS, user._row, user);
    nexusAuthAudit_('PURGE', 'SYSTEM', user.userId, 'SUCCESS', {});
  });
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
  var sheet = nexusAuthDb_().getSheetByName(sheetName);
  var headers = NEXUS_AUTH_HEADERS[sheetName];
  sheet.appendRow(headers.map(function (header) { return value[header] === undefined ? '' : value[header]; }));
}

function nexusAuthWriteRow_(sheetName, rowNumber, value) {
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
  if (/^(NEXUS_AUTH|NEXUS_PROXY)_/.test(code)) return code;
  return 'NEXUS_AUTH_REQUEST_FAILED';
}
