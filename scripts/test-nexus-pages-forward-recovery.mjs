#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = file => fs.readFileSync(file, 'utf8');
const currentBusinessPages = [
  'DataOps.html', 'export_center.html', 'history_viewer.html', 'Item_manager.html',
  'Master.html', 'MerchOps.html', 'SmartParser.html', 'settings.html',
  'orderops/list.html', 'orderq/cloud.html', 'orderq/collector.html', 'orderq/index.html',
  'orderq/input.html', 'orderq/operations.html', 'orderq/parser.html',
];
const protectedPages = [
  ['nexus/index.html', './'],
  ['nexus/home/index.html', '../'],
  ['nexus/admin/index.html', '../'],
  ['nexus/company.html', './'],
];

for (const [file, base] of protectedPages) {
  const html = read(file);
  assert.ok(html.includes(`${base}common/nexus-auth-config.js?v=2.0.1`), `${file}: auth config missing`);
  assert.ok(html.includes(`${base}common/nexus-auth.js?v=2.1.3`), `${file}: auth runtime missing`);
  assert.ok(html.indexOf('nexus-auth.js?v=2.1.3') < html.indexOf('<body'), `${file}: auth guard must start before body`);
}

for (const file of currentBusinessPages) {
  const html = read(file);
  assert.ok(html.includes('nexus-ui.js?v=1.1.0'), `${file}: shared UI/Footer loader missing`);
  assert.doesNotMatch(html, /nexus-auth(?:-config)?\.js|ONEAPP_AUTH|nexus_gateway/, `${file}: auth/gateway must not be reintroduced`);
}

const adminHtml = read('nexus/admin/index.html');
const adminJs = read('nexus/admin/admin.js');
const companyHtml = read('nexus/company.html');
const companyJs = read('nexus/company.js');
const homeJs = read('nexus/home/home.js');
assert.doesNotMatch(adminHtml, /회사정보 수정|company\.html\?mode=edit/, 'company editor link must not exist in static admin DOM');
assert.match(adminJs, /session\?\.user\?\.role !== 'OWNER_MASTER'/, 'admin company link requires OWNER_MASTER');
assert.match(adminJs, /company\.html\?mode=edit/, 'OWNER_MASTER receives the company editor link');
assert.match(companyHtml, /id="companyAdminRoot"[^>]+hidden/, 'company admin root must start hidden');
assert.match(companyJs, /role === 'OWNER_MASTER' && window\.ONEAPP_AUTH\.hasPermission\('admin\.company'\)/,
  'company editor must require OWNER_MASTER and admin.company');
assert.doesNotMatch(homeJs, /smartinput|orders\.html/, 'protected home must not restore deleted pre-M1 routes');
for (const route of ['/Master.html', '/Item_manager.html', '/MerchOps.html', '/orderq/index.html', '/orderops/list.html', '/DataOps.html', '/SmartParser.html']) {
  assert.ok(homeJs.includes(`url:'${route}'`), `protected home route missing: ${route}`);
}

const gateway = read('nexus/server/nexus-auth-gateway.gs');
assert.match(gateway, /NEXUS_PUBLIC_COMPANY_ACTION = 'nexus_public_company_snapshot'/, 'fixed public action missing');
assert.match(gateway, /NEXUS_PUBLIC_COMPANY_CACHE_TTL_SECONDS = 60/, 'public ScriptCache TTL must be 60 seconds');
assert.match(gateway, /typeof knownRevision !== 'number' \|\| !Number\.isSafeInteger\(knownRevision\)/,
  'knownRevision must be a JSON number and a safe integer');
assert.match(gateway, /knownRevision > cached\.revision[\s\S]+status: 'STALE_SERVER'/,
  'a client revision ahead of warm cache must resolve without upstream access');
assert.doesNotMatch(gateway, /forwarded\.knownRevision\s*=/,
  'cache miss must fetch a full Snapshot without forwarding the client revision');
assert.match(gateway, /var revision = snapshot\.revision/,
  'Gateway must derive READY revision from the exact upstream Snapshot used by v43');
assert.match(gateway, /if \(action === NEXUS_PUBLIC_COMPANY_ACTION\) return nexusAuthPublicCompanySnapshot_\(payload\)/,
  'public read must be isolated before protected dispatch');
assert.match(gateway, /nexusAuthPublicCompanyCacheAfterGateway_\(operationId, parsed\.data === undefined \? parsed : parsed\.data\)/,
  'protected admin write result must refresh/invalidate the public cache');

const configWindow = {};
vm.runInNewContext(read('nexus/common/apps-config.js'), { window: configWindow, Object });
const configuredUrls = [
  ...configWindow.NEXUS_GROUPS.map(group => group.url),
  ...configWindow.NEXUS_APPS.map(app => app.url),
];
for (const url of configuredUrls) {
  const pathname = new URL(url).pathname.replace(/^\//, '');
  const localPath = pathname === 'nexus/home/' ? 'nexus/home/index.html' : pathname;
  assert.ok(fs.existsSync(path.normalize(localPath)), `apps-config route does not exist: ${url}`);
}
assert.doesNotMatch(read('nexus/common/apps-config.js'), /smartinput|orders\.html|customer-manager/,
  'deleted pre-M1 routes must not be restored');

for (const file of [
  'nexus/common/nexus-ui.js', 'nexus/common/nexus-company-footer.js',
  'nexus/common/nexus-auth-config.js', 'nexus/common/nexus-auth.js',
  'nexus/common/nexus-top.js', 'nexus/common/nexus-top.css',
  'nexus/home/index.html', 'nexus/admin/index.html', 'nexus/company.html',
]) assert.ok(fs.existsSync(file), `${file}: recovery asset missing`);

console.log(`NEXUS Pages forward recovery passed (${currentBusinessPages.length} auth-independent pages, ${configuredUrls.length} valid routes).`);
