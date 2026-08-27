#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const gatewaySource = read('nexus/server/nexus-auth-gateway.gs');
const clientSource = read('nexus/common/nexus-auth.js');
const configSource = read('nexus/common/nexus-auth-config.js');
const loginHtml = read('nexus/index.html');
const adminHtml = read('nexus/admin/index.html');
const homeHtml = read('nexus/home/index.html');

// Apps Script source must remain parseable and its pure authorization helpers
// must be testable independently of Google-hosted services.
const context = vm.createContext({});
new vm.Script(gatewaySource, { filename: 'nexus-auth-gateway.gs' }).runInContext(context);

const permissionCases = [
  ['full', 'GET', 'foundation.read'],
  ['config', 'POST', 'foundation.write'],
  ['dataops_snapshot_get', 'POST', 'dataops.read'],
  ['dataops_snapshot_commit', 'POST', 'dataops.write'],
  ['situation_dataops_publish', 'POST', 'dataops.publish'],
  ['dataops_close_commit', 'POST', 'dataops.close'],
  ['orderq_sync_pull', 'POST', 'orderq.read'],
  ['orderq_sync_push', 'POST', 'orderq.write'],
  ['orderq_customer_reset_execute', 'POST', 'orderq.admin'],
  ['shipping_plan_list', 'POST', 'orderq.read'],
  ['shipping_plan_save', 'POST', 'orderq.write']
];
for (const [action, method, expected] of permissionCases) {
  assert.equal(context.nexusAuthPermissionForAction_(action, method), expected, `${action} permission`);
}
assert.throws(() => context.nexusAuthPermissionForAction_('arbitrary_remote_action', 'POST'), /NEXUS_PROXY_ACTION_DENIED/);
assert.throws(() => context.nexusAuthPermissionForAction_('full', 'DELETE'), /NEXUS_PROXY_ACTION_DENIED/);

assert.equal(context.nexusAuthSecretPropertyForAction_('dataops_snapshot_get'), 'NEXUS_AUTH_SECRET_DATAOPS_READ');
assert.equal(context.nexusAuthSecretPropertyForAction_('dataops_snapshot_commit'), 'NEXUS_AUTH_SECRET_DATAOPS_WRITE');
assert.equal(context.nexusAuthSecretPropertyForAction_('situation_dataops_publish'), 'NEXUS_AUTH_SECRET_DATAOPS_PUBLISH');
assert.equal(context.nexusAuthSecretPropertyForAction_('orderq_sync_pull'), 'NEXUS_AUTH_SECRET_ORDERQ');
assert.equal(context.nexusAuthSecretPropertyForAction_('shipping_plan_save'), 'NEXUS_AUTH_SECRET_SHIPPING');

const ownerPermissions = Array.from(context.nexusAuthPermissions_({ role: 'OWNER_MASTER' }));
const fullAccessPermissions = Array.from(context.nexusAuthPermissions_({ role: 'FULL_ACCESS' }));
assert(ownerPermissions.includes('admin.users') && ownerPermissions.includes('admin.services') && ownerPermissions.includes('admin.audit'));
assert(fullAccessPermissions.includes('dataops.close') && fullAccessPermissions.includes('orderq.admin'));
assert(!fullAccessPermissions.some(permission => permission.startsWith('admin.')), 'FULL_ACCESS must exclude NEXUS administration');
assert.deepEqual(
  Array.from(context.nexusAuthValidatePermissions_(['foundation.read', 'admin.users'], 'CUSTOM')),
  ['foundation.read'],
  'CUSTOM must strip administrator permissions'
);

assert.match(gatewaySource, /role === 'OWNER_MASTER'.*NEXUS_AUTH_MASTER_IMMUTABLE/s);
assert.match(gatewaySource, /NEXUS_AUTH_MASTER_DELETE_DENIED/);
assert.match(gatewaySource, /NEXUS_AUTH_RECOVERY_TTL_MS = 30 \* 24/);
assert.match(gatewaySource, /nexusAuthRevokeUserSessions_\(user\.userId\)/);
assert.match(gatewaySource, /PBKDF2.*SHA-256.*310000/s);
assert.match(gatewaySource, /PropertiesService\.getScriptProperties\(\)/);
assert.match(gatewaySource, /delete forwarded\.sessionToken/);
assert.match(gatewaySource, /forwarded\.token = secret/);
assert.match(gatewaySource, /NEXUS_AUTH_DEFAULT_UPSTREAM_URL/);
assert.doesNotMatch(gatewaySource, /request\.targetUrl|payload\.targetUrl/, 'clients must not select an arbitrary upstream URL');

assert.match(clientSource, /sessionStorage\.getItem\(SESSION_KEY\)/);
assert.match(clientSource, /sessionStorage\.setItem\(SESSION_KEY/);
assert.doesNotMatch(clientSource, /localStorage/, 'authentication and business credentials must not use persistent browser storage');
assert.match(clientSource, /PBKDF2/);
assert.match(clientSource, /iterations = 310000/);
assert.match(clientSource, /window\.fetch = proxyFetch/);
assert.match(clientSource, /action: 'nexus_proxy'/);
assert.match(clientSource, /request: \{ method, action, body \}/);
assert.doesNotMatch(clientSource, /request: \{[^}]*url/, 'proxy request must not carry an upstream URL');
assert.match(clientSource, /location\.pathname\.startsWith\('\/nexus\/admin\/'\).*OWNER_MASTER/s);
assert.match(configSource, /contractVersion: 'NEXUS_AUTH_V1'/);
assert.match(configSource, /endpoint: 'https:\/\/script\.google\.com\/macros\/s\/AKfycb[a-zA-Z0-9_-]+\/exec'/);
assert.doesNotMatch(configSource, /endpoint:\s*''/, 'production auth endpoint must be configured');

assert.match(loginHtml, /NEXUS 로그인/);
assert.match(loginHtml, /data-auth-mode="login"/);
assert.match(loginHtml, /data-auth-mode="activate"/);
assert.match(loginHtml, /data-auth-mode="bootstrap"/);
assert.doesNotMatch(loginHtml, /<nexus-top\b/, 'the public login screen must not render the authenticated header');
assert.match(adminHtml, /마스터 관리/);
assert.match(adminHtml, /사용자 관리/);
assert.match(adminHtml, /업무 서버 연결/);
assert.match(adminHtml, /감사 기록/);
assert.match(homeHtml, /NEXUS 업무 홈/);
assert.match(homeHtml, /id="adminLink"[^>]*hidden/);

const protectedEntries = [
  'DataOps.html', 'MerchOps.html', 'SmartParser.html', 'Master.html', 'Item_manager.html',
  'settings.html', 'export_center.html', 'history_viewer.html', 'orders.html', 'orderops_list.html',
  'orderops/input.html', 'orderops/list.html', 'orderops/list1.html', 'orderops/smartparser.html',
  'orderq/index.html', 'orderq/input.html', 'orderq/parser.html', 'orderq/collector.html',
  'orderq/cloud.html', 'orderq/dispatch.html', 'orderq/erp.html', 'orderq/operations.html',
  'orderq/products.html', 'orderq/purchase.html', 'orderq/reconciliation.html', 'orderq/sale.html',
  'orderq/transition.html', 'smartinput/index.html', 'nexus/home/index.html', 'nexus/admin/index.html'
];
for (const relativePath of protectedEntries) {
  const html = read(relativePath);
  assert.match(html, /nexus-auth-config\.js\?v=1\.0\.0/, `${relativePath} auth config`);
  assert.match(html, /nexus-auth\.js\?v=1\.0\.0/, `${relativePath} auth guard`);
  assert(
    html.indexOf('nexus-auth.js') < html.search(/<body\b/i),
    `${relativePath} must load the auth guard before body content`
  );
}

for (const relativePath of ['DataOps.html', 'MerchOps.html', 'orders.html', 'orderops_list.html', 'orderops/list.html']) {
  const source = read(relativePath);
  assert.doesNotMatch(source, /prompt\([^)]*(?:V1|V2|ORDER\s*Q|Shipping)[^)]*(?:token|토큰)/is, `${relativePath} must not prompt for a business token`);
}
assert.match(read('orders.html'), /id="cloudTokenInput"[^>]*type="hidden"|type="hidden"[^>]*id="cloudTokenInput"/);
assert.match(read('orderops_list.html'), /id="cloudTokenInput"[^>]*type="hidden"|type="hidden"[^>]*id="cloudTokenInput"/);
assert.match(read('orderops/list.html'), /id="cloudTokenInput"[^>]*type="hidden"|type="hidden"[^>]*id="cloudTokenInput"/);

const manifest = JSON.parse(read('app-manifest.json'));
const authContract = manifest.sharedDataContracts.find(contract => contract.id === 'nexus-auth');
assert(authContract, 'nexus-auth manifest contract');
assert.equal(authContract.owner, 'nexus-auth-gateway');
assert.equal(authContract.schemaVersion, 'NEXUS_AUTH_V1');
assert.equal(authContract.resources.sessionStorage, 'oneapp.nexus.auth.session.v1');
assert.equal(authContract.resources.uniqueMasterRole, 'OWNER_MASTER');
assert.match(authContract.resources.productionWebApp, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
assert.equal(authContract.resources.deployedVersion, 8);

console.log(`NEXUS auth system contract passed (${protectedEntries.length} protected entries).`);
