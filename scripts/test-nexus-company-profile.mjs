import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const transportSource = await readFile('nexus/company-transport.js', 'utf8');
const homeSource = await readFile('nexus/nexus.js', 'utf8');
const homeHtml = await readFile('nexus/index.html', 'utf8');
const companySource = await readFile('nexus/company.js', 'utf8');
const companyHtml = await readFile('nexus/company.html', 'utf8');
const commonUiSource = await readFile('nexus/common/nexus-ui.js', 'utf8');
const cloudSource = await readFile('code.gs', 'utf8');
const serverSource = await readFile('company-profile.gs', 'utf8');

const storage = new Map();
globalThis.sessionStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const expiresAt = new Date(Date.now() + 60_000).toISOString();
const adminSession = { user: { role: 'OWNER_MASTER', permissions: ['admin.company'] }, expiresAt };
storage.set('oneapp.nexus.home.session.v1', JSON.stringify({ token: 'SESSION_TOKEN', session: adminSession }));

const requests = [];
const responses = [
  { status: 'success', data: { appId: 'company', appContextToken: 'APP_CONTEXT', expiresAt } },
  { status: 'success', contractVersion: 'NEXUS_AUTH_V2', operationId: 'company.profile_read', data: { profile: { revision: 1 } } },
];
globalThis.fetch = async (_url, options) => {
  requests.push(JSON.parse(options.body));
  return { ok: true, json: async () => responses.shift() };
};

const transport = await import(`../nexus/company-transport.js?test=${Date.now()}`);
assert.equal(transport.readSessionBundle().token, 'SESSION_TOKEN', 'transport must read the current-tab NEXUS Session');
assert.equal(transport.isCompanyAdministrator(adminSession), true, 'OWNER_MASTER with admin.company is an administrator');
assert.equal(transport.isCompanyAdministrator({ user: { role: 'OWNER_MASTER', permissions: [] } }), false, 'role alone must not grant company writes');
assert.equal(transport.isCompanyAdministrator({ user: { role: 'DELEGATED', permissions: ['admin.company'] } }), false, 'permission alone must not grant company writes');

const readResult = await transport.callCompanyGateway({
  appId: 'company', operationId: 'company.profile_read', sessionToken: 'SESSION_TOKEN', payload: {},
});
assert.equal(readResult.profile.revision, 1, 'Gateway response must be returned after contract validation');
assert.deepEqual(requests[0], {
  action: 'nexus_auth_app_context', sessionToken: 'SESSION_TOKEN', appId: 'company',
}, 'transport must request a scoped app context');
assert.deepEqual(requests[1], {
  action: 'nexus_gateway', sessionToken: 'SESSION_TOKEN', appContextToken: 'APP_CONTEXT',
  operationId: 'company.profile_read', payload: {},
}, 'transport must use the deployed Gateway envelope');

await assert.rejects(
  transport.callCompanyGateway({ appId: 'company', operationId: 'company.profile_write', sessionToken: '', payload: {} }),
  /NEXUS_AUTH_SESSION_REQUIRED/,
  'an unauthenticated write must not reach the Gateway',
);

assert.match(homeHtml, /id="companyStatus"[\s\S]*READY|data-status="STALE"/, 'home must expose company status semantics');
assert.match(homeSource, /appId: 'nexus-home',[\s\S]*operationId: 'company\.profile_read',[\s\S]*payload: \{\}/, 'home must use the active v21 authenticated profile read contract');
assert.match(homeSource, /const cachedRevision = Number\(cached\?\.snapshot\?\.revision \|\| 0\)/, 'home must compare the cached revision in background');
assert.match(homeSource, /snapshot\.revision < cachedRevision[\s\S]*setCompanyState\('STALE'/, 'a lower server revision must preserve the last normal Snapshot');
assert.match(homeSource, /snapshot\.revision === cachedRevision[\s\S]*setCompanyState\('READY'/, 'an equal server revision must become READY without rewriting the cache');
assert.match(homeSource, /businessAddress: \[cleanText\(profile\.address1\), cleanText\(profile\.address2\)\]\.filter\(Boolean\)\.join\(' '\)/, 'home must project only non-empty address values');
for (const forbidden of ['homePhone', 'mobile', 'taxInvoiceEmail', "profile.email"]) {
  assert.doesNotMatch(homeSource.slice(homeSource.indexOf('const publicCompanyProjection'), homeSource.indexOf('const validCompanySnapshot')), new RegExp(forbidden.replace('.', '\\.')), `${forbidden} must not enter the cached projection`);
}
assert.match(homeSource, /if \(cached\)[\s\S]*setCompanyState\('STALE'/, 'a server failure must preserve the last normal Snapshot');
assert.match(homeSource, /companyEditLink\.hidden = !isCompanyAdministrator\(session\)/, 'only a company administrator may see the edit entry');
assert.doesNotMatch(homeSource, /localStorage/, 'the company Snapshot must not be persisted in localStorage');

assert.match(companyHtml, /nexus-ui-theme-init\.js\?v=1\.3\.1/, 'company management must consume the current common UI contract');
assert.match(companyHtml, /company\.js\?v=1\.0\.1/, 'company management must cache-bust the app-local header correction');
assert.match(companySource, /window\.addEventListener\('nexus-ui:ready', applyCompanyCurrentLabel, \{ once: true \}\)/, 'company management must apply its label after the common UI is ready');
assert.match(companySource, /dataset\.nexusUiReady === 'true'[\s\S]*applyCompanyCurrentLabel\(\)/, 'company management must also correct an already-mounted common header');
assert.match(companySource, /current\.textContent = COMPANY_APP_LABEL;[\s\S]*current\.title = COMPANY_APP_LABEL;/, 'the app-local correction must set the current label text and title');
assert.doesNotMatch(commonUiSource, /\{\s*id:\s*['"]company['"]/, 'company management must not become a global app navigation tab');
assert.match(companySource, /company\.profile_read/, 'company management must read the protected full profile');
assert.match(companySource, /company\.profile_write/, 'company management must use the protected write operation');
assert.match(companySource, /expectedRevision: Number\(profile\.revision\)/, 'writes must include the current expectedRevision');
assert.match(companySource, /await loadCompany\(\);/, 'a successful write must be followed by a server reread');
assert.match(companySource, /Object\.keys\(changes\)\.length/, 'unchanged profiles must not be written again');
assert.match(companySource, /COMPANY_REVISION_CONFLICT/, 'revision conflicts must be handled explicitly');
assert.match(companySource, /data-address-search/, 'the management screen must provide current address search entry points');
assert.match(companySource, /jointBusinessEnabled[\s\S]*unitTaxationEnabled/, 'nullable joint-business and boolean unit-taxation fields must remain distinct');
assert.doesNotMatch(companySource, /FileReader|base64|birth|생년월일|localStorage/i, 'certificate originals, birth dates, and local browser defaults must not be stored');
assert.doesNotMatch(transportSource, /window\.fetch\s*=/, 'the company transport must not replace the global fetch runtime');

const upstreamRoutes = [
  ['profile_get', 'FOUNDATION', 'READ'],
  ['profile_write', 'FOUNDATION', 'WRITE'],
  ['accounting_period_get', 'FOUNDATION', 'READ'],
  ['accounting_period_write', 'FOUNDATION', 'WRITE'],
  ['certificate_extract', 'FOUNDATION', 'READ'],
  ['backup_create', 'FOUNDATION', 'WRITE'],
  ['migrate_oneapp', 'FOUNDATION', 'WRITE'],
];
for (const [route, boundary, access] of upstreamRoutes) {
  assert.match(
    cloudSource,
    new RegExp(`action === 'nexus_gateway_company_${route}'[\\s\\S]*?oneappNexusGatewayRequire\\(payload, '${boundary}', '${access}'\\)[\\s\\S]*?ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED`),
    `${route} must require the deployed Gateway binding instead of accepting a legacy direct request`,
  );
}
assert.match(cloudSource, /ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON/, 'the upstream must reuse the active Foundation binding property');
assert.match(cloudSource, /constantTimeTextEquals\(String\(row\.tokenDigest\), suppliedDigest\)/, 'the upstream must verify the Gateway credential digest in constant time');
assert.doesNotMatch(cloudSource, new RegExp(['nexus_gateway_company', 'public_profile_get'].join('_')), 'the upstream restore must not activate the out-of-scope public Footer route');
assert.match(serverSource, /const COMPANY_PROFILE_TASK_ID = 'NEXUS-COMPANY-20260827-01'/, 'the restored module must retain the approved migration identity');
assert.match(serverSource, /if \(ledger\) return \{ status: 'ALREADY_APPLIED'/, 'the migration must remain idempotent after the server restore');
assert.match(serverSource, /businessTypes: \['도매 및 소매업'\]/, 'business types must remain an array');
assert.match(serverSource, /businessItems: \['전자상거래 소매업', '상품 중개업'\]/, 'business items must remain an array');
assert.match(serverSource, /jointBusinessEnabled: null[\s\S]*unitTaxationEnabled: false[\s\S]*taxInvoiceEmail: null/, 'unmarked values and unit taxation must preserve null/null/false semantics');
assert.match(serverSource, /companyProfileAtomic_\(ss, \['PROFILE', 'AUDIT', 'MIGRATIONS'\]/, 'migration must retain atomic rollback coverage');
assert.match(serverSource, /\(image\|file\|blob\|base64\|rawtext\|ocrtext\|birth\|생년월일\|주민등록\)[\s\S]*COMPANY_CERTIFICATE_SENSITIVE_DATA_DENIED/, 'the server must reject certificate originals, raw OCR text, and representative birth data');
assert.doesNotMatch(serverSource, /FileReader|localStorage/i, 'the server module must not use browser file or storage APIs');

console.log('NEXUS company profile contracts passed (55 checks).');
