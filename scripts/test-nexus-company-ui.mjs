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
const topJs = read('nexus/common/nexus-top.js');
const gatewaySource = read('nexus/server/nexus-auth-gateway.gs');

assert.match(companyHtml, /data-nexus-app-id="company"/);
assert.match(companyHtml, /nexus-auth\.js\?v=2\.1\.0/);
assert(companyHtml.indexOf('nexus-auth.js') < companyHtml.search(/<body\b/i), 'auth guard loads before company body');
for (const label of ['기본정보','회계기수','연락처','주소','사업자등록증 세부정보','사업자등록증 인식','다시 촬영','확인하고 등록']) assert(companyHtml.includes(label), `missing UI label: ${label}`);
assert.match(companyHtml, /postcode\.v2\.js/);
assert.match(companyHtml, /tesseract\.js@6/);
assert.match(companyHtml, /accept="image\/jpeg,image\/png,application\/pdf"/);
assert.match(companyHtml, /capture="environment"/);
assert.match(companyJs, /company\.profile_read/);
assert.match(companyJs, /company\.profile_write/);
assert.match(companyJs, /company\.accounting_period_write/);
assert.match(companyJs, /company\.certificate_extract/);
assert.match(companyJs, /session\?\.user\?\.role === 'OWNER_MASTER'/);
assert.match(companyJs, /COMPANY_REVISION_CONFLICT/);
assert.match(companyJs, /기존 회계기수와 기간이 겹칩니다/);
assert.match(companyJs, /beforeunload/);
assert.match(companyJs, /nexus:before-navigate/);
assert.match(companyJs, /data-address-search/);
assert.match(companyJs, /address1/);
assert.match(companyJs, /address2/);
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
assert.match(homeHtml, /id="companyCard"[^>]*data-state="LOADING"/);
for (const state of ['LOADING','EMPTY','READY','ERROR']) assert(homeJs.includes(`'${state}'`) || homeHtml.includes(`>${state}<`) || homeHtml.includes(`data-state="${state}"`), `home state ${state}`);
assert.match(homeJs, /company\.profile_read/);
assert.match(homeJs, /profile\.companyName/);
assert.match(homeJs, /profile\.businessNumber/);
assert.match(homeJs, /profile\.representativeName/);
assert.match(homeJs, /session\.user\.role === 'OWNER_MASTER'/);
assert.doesNotMatch(homeJs, /localStorage|sessionStorage/);

assert.match(topJs, /data-open="user"/);
assert.match(topJs, /내 회사정보/);
assert.match(topJs, /업무 홈/);
assert.match(topJs, /회사정보 읽기 전용/);

const context = vm.createContext({});
new vm.Script(gatewaySource, { filename: 'nexus-auth-gateway.gs' }).runInContext(context);
const registry = context.nexusAuthGatewayRegistry_();
for (const id of ['company.profile_read','company.profile_write','company.accounting_period_read','company.accounting_period_write','company.certificate_extract','company.backup_create','company.migrate_oneapp']) assert(registry[id], `missing gateway operation ${id}`);
assert.deepEqual(Array.from(registry['company.profile_read'].allowedApps), ['nexus-home','company']);
for (const id of ['company.profile_write','company.accounting_period_write','company.certificate_extract','company.backup_create','company.migrate_oneapp']) {
  assert.deepEqual(Array.from(registry[id].requiredUserPermissions), ['admin.company']);
  assert.equal(registry[id].operationClass, 'SYSTEM_ADMIN');
}
assert.equal(registry['company.profile_read'].access, 'READ');
assert.equal(registry['company.profile_write'].access, 'WRITE');
const ownerPermissions = Array.from(context.nexusAuthPermissions_({ role: 'OWNER_MASTER' }));
const fullPermissions = Array.from(context.nexusAuthPermissions_({ role: 'FULL_ACCESS' }));
assert(ownerPermissions.includes('admin.company'));
assert(!fullPermissions.includes('admin.company'));
assert.throws(() => context.nexusAuthRequireOperationAccess_({ user: { role: 'FULL_ACCESS' } }, registry['company.profile_write']), /NEXUS_AUTH_PERMISSION_DENIED/);
assert.throws(() => context.nexusAuthRequireOperationAccess_({ user: { role: 'VIEWER' } }, registry['company.profile_write']), /NEXUS_AUTH_VIEWER_READ_ONLY/);
assert.doesNotThrow(() => context.nexusAuthRequireOperationAccess_({ user: { role: 'VIEWER' } }, registry['company.profile_read']));

console.log('NEXUS company UI and gateway contract passed (home states, routes, role UI, leave guard, address, accounting and admin-only writes).');
