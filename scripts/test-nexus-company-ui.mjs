#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const companyHtml = read('nexus/company.html');
const companyJs = read('nexus/company.js');
const companyCss = read('nexus/company.css');
const certificateJs = read('nexus/company-certificate.js');
const homeHtml = read('nexus/home/index.html');
const homeJs = read('nexus/home/home.js');
const adminHtml = read('nexus/admin/index.html');
const adminJs = read('nexus/admin/admin.js');
const topJs = read('nexus/common/nexus-top.js');
const authJs = read('nexus/common/nexus-auth.js');
const footerJs = read('nexus/common/nexus-company-footer.js');
const gatewaySource = read('nexus/server/nexus-auth-gateway.gs');
const upstreamSource = read('code.gs');

assert.match(companyHtml, /data-nexus-app-id="company"/);
assert.match(companyHtml, /nexus-auth\.js\?v=2\.1\.3/);
assert(companyHtml.indexOf('nexus-auth.js') < companyHtml.search(/<body\b/i), 'auth guard loads before company body');
assert.match(companyHtml, /id="companyAdminRoot"[^>]*hidden/);
assert.doesNotMatch(companyHtml, /<form|사업자등록증 인식|회계기수 등록|data-address-search/,
  'protected management DOM must not exist before OWNER_MASTER verification');
assert.doesNotMatch(companyHtml, /postcode\.v2\.js|tesseract\.js@6/,
  'administrator-only external tools must not load before role verification');

for (const label of ['기본정보', '회계기수', '연락처', '주소', '사업자등록증 세부정보', '사업자등록증 인식', '다시 촬영', '확인하고 등록']) {
  assert(companyJs.includes(label), `missing owner management UI label: ${label}`);
}
assert.match(companyJs, /if \(!isAdmin\(\)\) \{\s*location\.replace\('\/nexus\/home\/'\)/);
assert(companyJs.indexOf("session = currentSession") < companyJs.indexOf('root.innerHTML = ADMIN_MARKUP'),
  'owner session verification must precede management DOM installation');
assert.match(companyJs, /session\?\.user\?\.role === 'OWNER_MASTER'.*hasPermission\('admin\.company'\)/);
assert.match(companyJs, /company\.profile_read/);
assert.match(companyJs, /company\.profile_write/);
assert.match(companyJs, /company\.accounting_period_write/);
assert.match(companyJs, /company\.certificate_extract/);
assert.match(companyJs, /ONEAPP_COMPANY_PUBLIC\?\.acceptGatewayResult\(result, 'admin-save'\)/);
assert.match(companyJs, /COMPANY_REVISION_CONFLICT/);
assert.match(companyJs, /기존 회계기수와 기간이 겹칩니다/);
assert.match(companyJs, /beforeunload/);
assert.match(companyJs, /nexus:before-navigate/);
assert.match(companyJs, /data-address-search/);
assert.match(companyJs, /address1/);
assert.match(companyJs, /address2/);
assert.match(companyJs, /postcode\.v2\.js/);
assert.match(companyJs, /tesseract\.js@6/);
assert.match(companyJs, /accept="image\/jpeg,image\/png,application\/pdf"/);
assert.match(companyJs, /capture="environment"/);
assert.match(companyJs, /window\.confirm\('사업자등록번호를 변경하시겠습니까/);
assert.doesNotMatch(companyJs, /localStorage|sessionStorage/);
assert.doesNotMatch(companyJs, /script\.google\.com|fetch\s*\(/);
assert.match(companyCss, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(companyCss, /\.company-content\[hidden\][^}]*display:none!important/);
assert.match(companyCss, /@media\(max-width:720px\)/);

assert.match(certificateJs, /file\.arrayBuffer\(\)/);
assert.match(certificateJs, /detectCertificateFileType/);
assert.match(certificateJs, /CERTIFICATE_OCR_TIMEOUT/);
assert.match(certificateJs, /rawText|생년월일|주민등록번호/);
assert.doesNotMatch(certificateJs, /localStorage|sessionStorage|indexedDB|fetch\s*\(/);

assert.match(homeHtml, /data-nexus-app-id="nexus-home"/);
assert.match(homeHtml, /id="companyCard"[^>]*data-state="STATIC"/);
assert.match(homeJs, /ONEAPP_COMPANY_PUBLIC\?\.snapshot/);
assert.match(homeJs, /nexus-company-public-ready/);
assert.match(homeJs, /nexus-company-public-change/);
assert.doesNotMatch(homeJs, /company\.profile_read|ONEAPP_AUTH\.gateway/);
assert.doesNotMatch(homeJs, /localStorage|sessionStorage/);

assert.match(adminHtml, /data-nexus-app-id="company"/);
assert.doesNotMatch(adminHtml, /href="\/nexus\/company\.html/,
  'the owner-only company route must not be present in static management DOM');
assert.match(adminJs, /session\?\.user\?\.role !== 'OWNER_MASTER'/);
assert.match(adminJs, /companyLink\.href = '\/nexus\/company\.html\?mode=edit'/);
assert.match(adminJs, /companyLink\.textContent = '회사정보 수정'/);

assert.match(topJs, /data-open="user"/);
assert.match(topJs, /업무 홈/);
assert.doesNotMatch(topJs, /내 회사정보|회사정보 읽기 전용/);
assert.match(authJs, /nexus-company-footer\.js/);
assert.match(footerJs, /nexus_public_company_snapshot/);

const context = vm.createContext({});
new vm.Script(gatewaySource, { filename: 'nexus-auth-gateway.gs' }).runInContext(context);
const registry = context.nexusAuthGatewayRegistry_();
const protectedOperations = [
  'company.profile_read', 'company.profile_write', 'company.accounting_period_read',
  'company.accounting_period_write', 'company.certificate_extract', 'company.backup_create', 'company.migrate_oneapp'
];
for (const id of ['company.public_profile_read', ...protectedOperations]) assert(registry[id], `missing gateway operation ${id}`);
assert.deepEqual(Array.from(registry['company.profile_read'].allowedApps), ['company']);
assert.deepEqual(Array.from(registry['company.accounting_period_read'].allowedApps), ['company']);
assert.deepEqual(Array.from(registry['company.public_profile_read'].requiredUserPermissions), []);
assert.deepEqual(Array.from(registry['company.public_profile_read'].allowedFields), ['knownRevision']);
assert.equal(registry['company.public_profile_read'].upstreamAction, 'nexus_gateway_company_public_profile_get');
assert.deepEqual(JSON.parse(JSON.stringify(context.nexusAuthGatewayValidatePayload_(registry['company.public_profile_read'], { knownRevision: 7 }))), { knownRevision: 7 });
assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['company.public_profile_read'], { snapshot: {} }), /NEXUS_GATEWAY_SCHEMA_DENIED/);
for (const id of protectedOperations) {
  assert.deepEqual(Array.from(registry[id].requiredUserPermissions), ['admin.company'], `${id} must recheck admin.company`);
}
for (const id of ['company.profile_write', 'company.accounting_period_write', 'company.certificate_extract', 'company.backup_create', 'company.migrate_oneapp']) {
  assert.equal(registry[id].operationClass, 'SYSTEM_ADMIN');
}
assert.equal(registry['company.profile_read'].access, 'READ');
assert.equal(registry['company.profile_write'].access, 'WRITE');
const ownerPermissions = Array.from(context.nexusAuthPermissions_({ role: 'OWNER_MASTER' }));
const fullPermissions = Array.from(context.nexusAuthPermissions_({ role: 'FULL_ACCESS' }));
assert(ownerPermissions.includes('admin.company'));
assert(!fullPermissions.includes('admin.company'));
for (const id of protectedOperations) {
  const error = registry[id].access === 'WRITE' && id !== 'company.certificate_extract'
    ? /NEXUS_AUTH_PERMISSION_DENIED|NEXUS_AUTH_VIEWER_READ_ONLY/
    : /NEXUS_AUTH_PERMISSION_DENIED/;
  assert.throws(() => context.nexusAuthRequireOperationAccess_({ user: { role: 'FULL_ACCESS', permissions: ['foundation.read', 'foundation.write'] } }, registry[id]), error);
}
assert.doesNotThrow(() => context.nexusAuthRequireOperationAccess_({ user: { role: 'VIEWER', permissions: [] } }, registry['company.public_profile_read']));

assert.match(upstreamSource, /action === 'nexus_gateway_company_public_profile_get'/);
assert.match(upstreamSource, /companyProfilePublicGet\(ss, payload\)/);
assert.match(upstreamSource, /companyProfileGet\(ss, payload, companyAuth\)/);
assert.match(upstreamSource, /companyProfileAccountingRead\(ss, payload, companyAuth\)/);

console.log('NEXUS company UI and gateway contract passed (public Footer, zero-blocking home, OWNER-only DOM/route, admin.company server rechecks).');
