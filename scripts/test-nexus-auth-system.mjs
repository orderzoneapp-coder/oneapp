#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const gatewaySource = read('nexus/server/nexus-auth-gateway.gs');
const clientSource = read('nexus/common/nexus-auth.js');
const configSource = read('nexus/common/nexus-auth-config.js');
const oneappSource = read('code.gs');

const context = vm.createContext({});
new vm.Script(gatewaySource, { filename: 'nexus-auth-gateway.gs' }).runInContext(context);
const registry = context.nexusAuthGatewayRegistry_();
const requiredOperations = [
  'foundation.full_read', 'foundation.master_read', 'foundation.config_read', 'foundation.config_write',
  'foundation.history_read', 'foundation.replace_all', 'dataops.snapshot.get', 'dataops.snapshot.commit',
  'dataops.situation.publish', 'dataops.close.commit', 'orderq.sync.pull', 'orderq.sync.push',
  'orderq.customer.reset_execute', 'orderq.central.prepare', 'orderq.central.commit',
  'shipping.plan.list', 'shipping.plan.get', 'shipping.plan.save'
];
for (const operationId of requiredOperations) {
  const operation = registry[operationId];
  assert(operation, `${operationId} registry`);
  assert.equal(operation.operationId, operationId);
  assert(Array.isArray(operation.allowedApps) && operation.allowedApps.length > 0);
  assert(Array.isArray(operation.requiredAppAccess) && operation.requiredAppAccess.length > 0);
  assert(Array.isArray(operation.requiredUserPermissions));
  assert(Array.isArray(operation.requiredPurposePermissions));
  assert(['BUSINESS_DATA', 'SYSTEM_ADMIN', 'READ_ONLY_DERIVED'].includes(operation.operationClass));
  assert(/^[A-Z]+$/.test(operation.securityBoundary));
  assert.equal(operation.serviceBoundary, operation.securityBoundary);
  assert(['READ', 'WRITE'].includes(operation.access));
  assert.equal(operation.serviceCredentialMode, operation.access);
  assert(Array.isArray(operation.allowedFields));
  assert(Array.isArray(operation.writableFields));
  assert(Array.isArray(operation.serverComputedFields));
  assert(Array.isArray(operation.systemFields));
  assert(Array.isArray(operation.preconditionFields));
  assert(operation.responseSanitizer && operation.auditCategory);
}
assert.equal(registry['dataops.situation.publish'].access, 'WRITE', 'PUBLISH must use DataOps WRITE');
assert.deepEqual(Array.from(registry['dataops.situation.publish'].requiredUserPermissions), []);
assert.deepEqual(Array.from(registry['dataops.situation.publish'].requiredPurposePermissions), []);
assert.deepEqual(Array.from(registry['dataops.close.commit'].requiredUserPermissions), []);
assert.deepEqual(Array.from(registry['dataops.close.commit'].requiredPurposePermissions), []);
assert.deepEqual(Array.from(registry['dataops.snapshot.commit'].requiredUserPermissions), []);
assert.deepEqual(Array.from(registry['dataops.snapshot.commit'].requiredPurposePermissions), []);
assert.deepEqual(Array.from(registry['dataops.snapshot.commit'].writableFields), ['기초', '주문', '입고', '출고', '실사', '단가']);
assert(registry['dataops.snapshot.commit'].serverComputedFields.includes('전산잔량'));
assert(registry['dataops.snapshot.commit'].serverComputedFields.includes('예상잔량'));
assert(registry['dataops.snapshot.commit'].serverComputedFields.includes('로스'));
assert.deepEqual(Array.from(registry['foundation.replace_all'].requiredUserPermissions), ['foundation.write', 'foundation.replace']);
assert.equal(registry['shipping.plan.get'].securityBoundary, 'SHIPPING');
assert.equal(registry['orderq.sync.pull'].securityBoundary, 'ORDERQ');
assert.equal(registry.arbitrary_remote_action, undefined);

assert.deepEqual(JSON.parse(JSON.stringify(context.nexusAuthGatewayValidatePayload_(registry['shipping.plan.get'], { planId: 'P', revision: 'R' }))), { planId: 'P', revision: 'R' });
for (const field of ['action', 'operationId', 'sessionToken', 'targetUrl', 'upstreamUrl', 'token', 'actorId', 'userId', 'loginId', 'appId', 'requestId', 'credential']) {
  assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['shipping.plan.get'], { [field]: 'forged' }), /NEXUS_GATEWAY_SCHEMA_DENIED/);
}
assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['shipping.plan.get'], { extra: true }), /NEXUS_GATEWAY_SCHEMA_DENIED/);
assert.doesNotThrow(() => context.nexusAuthGatewayValidatePayload_(registry['dataops.snapshot.commit'], { snapshot: { hash: 'a'.repeat(64) } }));
assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['dataops.snapshot.commit'], { snapshot: { savedAt: new Date().toISOString() } }), /IMMUTABLE_FIELD/);
assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['dataops.snapshot.commit'], { snapshot: { rows: [{ 로스: 1 }] } }), /IMMUTABLE_FIELD/);
assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['dataops.snapshot.commit'], { snapshot: { rows: [{ 예상잔량: 1 }] } }), /IMMUTABLE_FIELD/);

const secretValues = Object.fromEntries([
  'FOUNDATION_READ', 'FOUNDATION_WRITE', 'DATAOPS_READ', 'DATAOPS_WRITE',
  'ORDERQ_READ', 'ORDERQ_WRITE', 'SHIPPING_READ', 'SHIPPING_WRITE'
].map(name => [`NEXUS_AUTH_SECRET_${name}`, crypto.randomBytes(32).toString('hex')]));
context.PropertiesService = { getScriptProperties: () => ({ getProperty: key => secretValues[key] || '' }) };
for (const boundary of ['FOUNDATION', 'DATAOPS', 'ORDERQ', 'SHIPPING']) {
  const readCredential = context.nexusAuthGatewayCredential_(boundary, 'READ');
  const writeCredential = context.nexusAuthGatewayCredential_(boundary, 'WRITE');
  assert.notEqual(readCredential.token, writeCredential.token, `${boundary} READ/WRITE separation`);
  assert.equal(readCredential.credentialId, `NEXUS_AUTH_SECRET_${boundary}_READ`);
  assert.equal(writeCredential.credentialId, `NEXUS_AUTH_SECRET_${boundary}_WRITE`);
}
assert.equal(new Set(Object.values(secretValues)).size, 8, 'all eight boundary/access credentials must remain distinct');

context.Utilities = { getUuid: () => '12345678-1234-1234-1234-123456789abc' };
const ephemeralEnvelopeSecret = crypto.randomBytes(32).toString('hex');
const envelope = context.nexusAuthGatewayEnvelope_({ ...registry['foundation.replace_all'], verifiedAppId: 'master' }, { master: [] }, { token: ephemeralEnvelopeSecret, credentialId: 'id' }, { user: { userId: 'USR-1', loginId: 'person' } }, 'REQ-1');
assert.equal(envelope.actorId, 'NEXUS_GATEWAY');
assert.equal(envelope.token, ephemeralEnvelopeSecret);
assert.equal(envelope.action, 'nexus_gateway_foundation_replace_all');
assert.equal(envelope.requestId, 'REQ-1');
assert.equal(envelope.nexusRequest.subjectUserId, 'USR-1');
assert.equal(envelope.nexusRequest.appId, 'master');
assert.match(envelope.transactionId, /^NXTX-/);
assert(envelope.roleIds.includes('FOUNDATION_WRITE') && envelope.roleIds.includes('FOUNDATION_READ') && envelope.roleIds.includes('FOUNDATION_REPLACE'));

assert.deepEqual(
  JSON.parse(JSON.stringify(context.nexusAuthGatewaySanitize_({ ok: 1, token: 'x', nested: { passwordHash: 'x', value: 2 }, rows: [{ credentialId: 'x', keep: true }] }))),
  { ok: 1, nested: { value: 2 }, rows: [{ keep: true }] }
);

const ownerPermissions = Array.from(context.nexusAuthPermissions_({ role: 'OWNER_MASTER' }));
const fullPermissions = Array.from(context.nexusAuthPermissions_({ role: 'FULL_ACCESS' }));
for (const permission of ['foundation.replace', 'customer.read', 'customer.write', 'shipping.read', 'shipping.write', 'admin.services', 'admin.audit']) assert(ownerPermissions.includes(permission));
assert(fullPermissions.includes('foundation.replace') && fullPermissions.includes('shipping.write'));
assert(!fullPermissions.some(permission => permission.startsWith('admin.')));
assert.doesNotThrow(() => context.nexusAuthRequirePermission_({ role: 'CUSTOM', permissionsJson: '["shipping.write"]' }, 'shipping.read'), 'WRITE implies READ');
assert.throws(() => context.nexusAuthRequirePermission_({ role: 'CUSTOM', permissionsJson: '["shipping.read"]' }, 'shipping.write'), /NEXUS_AUTH_PERMISSION_DENIED/);
assert.equal(context.nexusAuthPermissionForAction_('shipping_plan_list', 'POST'), 'shipping.read', 'legacy Shipping read remains in the Shipping user boundary');
assert.equal(context.nexusAuthPermissionForAction_('shipping_plan_save', 'POST'), 'shipping.write', 'legacy Shipping write remains in the Shipping user boundary');

assert.match(clientSource, /const CONTRACT_VERSION = 'NEXUS_AUTH_V2'/);
assert.match(clientSource, /async function gateway\(operationId, payload/);
assert.match(clientSource, /action: 'nexus_gateway'/);
assert.match(clientSource, /NEXUS_AUTH_MIXED_CACHE_DENIED/);
assert.match(clientSource, /const CONTEXT_REFRESH_LEAD_MS = 90 \* 1000/);
assert.match(clientSource, /const CONTEXT_REFRESH_RETRY_MS = 15 \* 1000/);
assert.match(clientSource, /function scheduleSessionRefresh\(\)/);
assert.match(clientSource, /function refreshIfNeeded\(/);
assert.match(clientSource, /contextRefreshTimer = window\.setTimeout\([\s\S]{0,180}CONTEXT_REFRESH_RETRY_MS/,
  'a transient proactive refresh failure must retain a bounded retry');
assert.match(clientSource, /window\.addEventListener\('pageshow', refreshOnActive\)/);
assert.match(clientSource, /document\.addEventListener\('visibilitychange', refreshOnActive\)/);
assert.match(clientSource, /event\.data\?\.type === 'refresh'[\s\S]{0,160}refreshIfNeeded/,
  'another tab refresh signal must validate this tab with its own session token');
assert.doesNotMatch(clientSource, /event\.data\?\.type === 'refresh'[\s\S]{0,240}currentBundle = readStoredBundle/,
  'BroadcastChannel must not pretend that tab-scoped sessionStorage contains another tab bundle');
assert.match(clientSource, /async function gateway[\s\S]*?await ready;/,
  'privileged gateway calls must continue to await full server verification');
assert.doesNotMatch(clientSource, /shellReady|nexusAuthShellReady/,
  'expired authorization must never expose a cached Master data shell');
assert.match(clientSource, /replace\(\/\\\.read\$\/, '\.write'\)/, 'client navigation mirrors server WRITE-implies-READ behavior');
assert.doesNotMatch(clientSource, /window\.fetch\s*=|businessCredential|nexus_proxy/);
assert.match(configSource, /contractVersion: 'NEXUS_AUTH_V2'/);

const revokedStorage = new Map();
const signedFixture = value => `${value}.${'a'.repeat(64)}`;
revokedStorage.set('oneapp.nexus.auth.bundle.v2', JSON.stringify({
  version: 2,
  sessionToken: 'SESSION-REVOKED',
  session: {
    user: { userId: 'USR-REVOKED', role: 'CUSTOM', permissions: ['foundation.read'] },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  },
  sessionContextToken: signedFixture('session-context'),
  contextExpiresAt: new Date(Date.now() - 1000).toISOString(),
  appContexts: {
    master: {
      appId: 'master', appContextToken: signedFixture('master-context'),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    }
  }
}));
let revokedRedirect = '';
const revokedEvents = [];
const revokedSandbox = {
  console,
  Date,
  JSON,
  Math,
  Promise,
  Map,
  Set,
  Object,
  Array,
  String,
  Number,
  RegExp,
  Error,
  URLSearchParams,
  TextEncoder,
  Uint8Array,
  sessionStorage: {
    getItem: key => revokedStorage.get(key) ?? null,
    setItem: (key, value) => revokedStorage.set(key, String(value)),
    removeItem: key => revokedStorage.delete(key)
  },
  location: {
    pathname: '/Master.html', search: '?view=products&mode=list', hash: '',
    replace: value => { revokedRedirect = String(value); },
    assign: () => {}
  },
  document: {
    visibilityState: 'visible',
    documentElement: { dataset: { nexusAppId: 'master' }, appendChild: () => {} },
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    querySelector: () => null,
    addEventListener: () => {}
  },
  CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  BroadcastChannel: class BroadcastChannel {
    addEventListener() {}
    postMessage() {}
  },
  setTimeout: () => 1,
  clearTimeout: () => {},
  addEventListener: () => {},
  dispatchEvent: event => { revokedEvents.push(event.type); return true; },
  fetch: async () => ({
    ok: true,
    json: async () => ({ status: 'error', message: 'NEXUS_AUTH_SESSION_REVOKED' })
  }),
  NEXUS_AUTH_CONFIG: {
    contractVersion: 'NEXUS_AUTH_V2', endpoint: 'https://auth.invalid/exec', loginUrl: '/nexus/'
  }
};
revokedSandbox.window = revokedSandbox;
new vm.Script(clientSource, { filename: 'nexus-auth.js' }).runInContext(vm.createContext(revokedSandbox));
assert.equal(await revokedSandbox.ONEAPP_AUTH.ready, null, 'revoked session must not become ready');
assert.match(revokedRedirect, /^\/nexus\/\?return=/, 'revoked session must return to login');
assert.equal(revokedSandbox.document.documentElement.dataset.nexusAuthReady, undefined,
  'revoked session must not release the authenticated screen gate');
assert.equal(revokedStorage.has('oneapp.nexus.auth.bundle.v2'), false,
  'revoked session must clear the cached bundle');
assert.equal(revokedEvents.includes('nexus-auth-ready'), false,
  'revoked session must not emit a cached authorization event');

const freshStorage = new Map();
const freshSession = {
  user: { userId: 'USR-ACTIVE', role: 'CUSTOM', permissions: ['foundation.read'] },
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
};
const freshContextExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
const freshBundle = {
  version: 2,
  sessionToken: 'SESSION-ACTIVE',
  session: freshSession,
  sessionContextToken: signedFixture('fresh-session-context'),
  contextExpiresAt: freshContextExpiresAt,
  appContexts: {
    master: {
      appId: 'master', appContextToken: signedFixture('fresh-master-context'),
      expiresAt: freshContextExpiresAt
    }
  }
};
freshStorage.set('oneapp.nexus.auth.bundle.v2', JSON.stringify(freshBundle));
const scheduledRefreshDelays = [];
let activeFetchCount = 0;
const freshDocument = {
  visibilityState: 'visible',
  documentElement: { dataset: { nexusAppId: 'master' }, appendChild: () => {} },
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  querySelector: () => null,
  addEventListener: () => {}
};
const freshSandbox = {
  ...revokedSandbox,
  document: freshDocument,
  sessionStorage: {
    getItem: key => freshStorage.get(key) ?? null,
    setItem: (key, value) => freshStorage.set(key, String(value)),
    removeItem: key => freshStorage.delete(key)
  },
  setTimeout: (_handler, delay = 0) => {
    scheduledRefreshDelays.push(Number(delay));
    return scheduledRefreshDelays.length;
  },
  clearTimeout: () => {},
  dispatchEvent: () => true,
  fetch: async () => {
    activeFetchCount += 1;
    const refreshedExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    return {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          session: freshSession,
          sessionContextToken: signedFixture('refreshed-session-context'),
          contextExpiresAt: refreshedExpiresAt,
          appContexts: {
            master: {
              appId: 'master', appContextToken: signedFixture('refreshed-master-context'),
              expiresAt: refreshedExpiresAt
            }
          }
        }
      })
    };
  }
};
freshSandbox.window = freshSandbox;
new vm.Script(clientSource, { filename: 'nexus-auth.js' }).runInContext(vm.createContext(freshSandbox));
assert.equal((await freshSandbox.ONEAPP_AUTH.ready)?.user?.userId, 'USR-ACTIVE');
assert.equal(freshDocument.documentElement.dataset.nexusAuthReady, 'true');
assert.equal(activeFetchCount, 0, 'fresh cached authorization must avoid an initial network refresh');
assert(scheduledRefreshDelays.some(delay => delay >= 200000 && delay <= 215000),
  'five-minute client context must schedule refresh about 90 seconds before expiry');
await freshSandbox.ONEAPP_AUTH.refreshIfNeeded({ minValidityMs: 6 * 60 * 1000 });
assert.equal(activeFetchCount, 1, 'freshness demand beyond the current lease must use this tab session for one refresh');

const protectedEntries = [
  'DataOps.html', 'MerchOps.html', 'SmartParser.html', 'Master.html', 'Item_manager.html',
  'settings.html', 'export_center.html', 'history_viewer.html', 'partner_db.html', 'orders.html', 'orderops_list.html',
  'orderops/input.html', 'orderops/list.html', 'orderops/list1.html', 'orderops/smartparser.html',
  'orderq/index.html', 'orderq/input.html', 'orderq/parser.html', 'orderq/collector.html',
  'orderq/cloud.html', 'orderq/dispatch.html', 'orderq/erp.html', 'orderq/operations.html',
  'orderq/products.html', 'orderq/purchase.html', 'orderq/reconciliation.html', 'orderq/sale.html',
  'orderq/transition.html', 'orderq/admin-test.html', 'orderq/admin-test-guide.html',
  'smartinput/index.html', 'nexus/home/index.html', 'nexus/admin/index.html'
];
for (const relativePath of protectedEntries) {
  const html = read(relativePath);
  assert.match(html, /nexus-auth-config\.js\?v=2\.0\.1/, `${relativePath} V2 config`);
  assert.match(html, /nexus-auth\.js\?v=2\.1\.2/, `${relativePath} V2 guard`);
  assert(html.indexOf('nexus-auth.js') < html.search(/<body\b/i), `${relativePath} guard before body`);
}

const consumerFiles = [
  'coreEngine.js', 'DataOps_situation_v2.js', 'DataOps.html', 'dataops/close-ui.js', 'dataops/v1-security-client.js',
  'history_viewer.html', 'Item_manager.js', 'Master.html', 'nexus/master/master-app.jsx', 'nexus/master/master-app.js', 'MerchOps.html', 'orders.html', 'orderops_list.html',
  'orderops/list.html', 'orderops/list1.html', 'orderops/orderops-source-adapter.js',
  'orderq/dataops-situation-read-adapter.js', 'orderq/orderq-cloud-adapter.js', 'orderq/situation-runtime.js',
  'settings.html'
];
const consumers = consumerFiles.map(relativePath => `\n/* ${relativePath} */\n${read(relativePath)}`).join('');
assert.doesNotMatch(consumers, /\bfetch\s*\(/, 'direct business fetches must be zero');
assert.doesNotMatch(consumers, /script\.google\.com\/macros\/s/i, 'business upstream URLs must be zero');
assert.doesNotMatch(consumers, /businessCredential\s*\(/, 'browser credentials must be zero');
assert.doesNotMatch(consumers, /id=["'][^"']*token[^"']*["'][^>]*type=["']hidden["']|type=["']hidden["'][^>]*id=["'][^"']*token/i, 'hidden token inputs must be zero');

assert.match(oneappSource, /ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON/);
assert.match(oneappSource, /ONEAPP_NEXUS_GATEWAY_DATAOPS_BINDINGS_JSON/);
assert.match(oneappSource, /ONEAPP_NEXUS_GATEWAY_ORDERQ_BINDINGS_JSON/);
assert.match(oneappSource, /ONEAPP_NEXUS_GATEWAY_SHIPPING_BINDINGS_JSON/);
assert.match(oneappSource, /requiredFields = \['credentialId', 'version', 'tokenDigest', 'actorId', 'roleIds', 'allowedScope', 'status', 'createdAt', 'activatedAt', 'retiredAt'\]/);
assert.match(oneappSource, /\['ACTIVE', 'RETIRING', 'RETIRED'\]\.includes\(status\)/);
assert.match(oneappSource, /status === 'RETIRED'/);
assert.match(oneappSource, /ONEAPP_NEXUS_GATEWAY_BINDING_RETIRED/);
assert.match(oneappSource, /String\(binding\.version \|\| ''\) !== 'V2'/);
assert.match(oneappSource, /\^\[a-f0-9\]\{64\}\$/);
assert.match(oneappSource, /constantTimeTextEquals\(String\(row\.tokenDigest\), suppliedDigest\)/);
assert.match(oneappSource, /ONEAPP_NEXUS_GATEWAY_ACTOR = 'NEXUS_GATEWAY'/);
assert.match(oneappSource, /oneappNexusFoundationInactiveSlot/);
assert.match(oneappSource, /oneappNexusFoundationActivate\(stagingSlot\)/);
assert.match(oneappSource, /ONEAPP_NEXUS_REPLACE_VERIFY_FAILED/);
assert.match(oneappSource, /status: 'ACTIVATED'/);
assert.match(oneappSource, /function doGet\(\) \{\s*return jsonResponse\(\{ status: 'error', message: 'ONEAPP_NEXUS_GATEWAY_ACCESS_REQUIRED'/s);
assert.doesNotMatch(read('nexus/admin/index.html'), /type=["']password["']/i, 'admin screen must not accept raw service credentials');

const manifest = JSON.parse(read('app-manifest.json'));
const authContract = manifest.sharedDataContracts.find(contract => contract.id === 'nexus-auth');
assert.equal(authContract.schemaVersion, 'NEXUS_AUTH_V2');
assert.equal(authContract.resources.deployedContractVersion, 'NEXUS_AUTH_V2');
assert.equal(authContract.resources.sourceContractVersion, 'NEXUS_AUTH_V2');
assert.equal(authContract.resources.cacheVersion, '2.1.2');
assert.equal(authContract.resources.contextRefreshLeadSeconds, 90);
assert.equal(authContract.resources.contextRefreshRetrySeconds, 15);
assert.match(authContract.resources.contextRefreshMode, /full server verification remains mandatory/);
assert.equal(authContract.resources.deployedVersion, 21);
assert.equal(authContract.resources.rollbackVersion, 19);
assert.equal(authContract.resources.businessCredentials.length, 8);
assert.equal(authContract.resources.oneappBindings.length, 4);
assert.match(authContract.resources.legacyCompatibility, /LEGACY_V1/);

console.log(`NEXUS_AUTH_V2 static and authorization contract passed (${Object.keys(registry).length} operations, ${protectedEntries.length} protected entries).`);
