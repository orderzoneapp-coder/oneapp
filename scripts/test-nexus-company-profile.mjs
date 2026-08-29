import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const transportSource = await readFile('nexus/company-transport.js', 'utf8');
const homeSource = await readFile('nexus/nexus.js', 'utf8');
const homeHtml = await readFile('nexus/index.html', 'utf8');
const companySource = await readFile('nexus/company.js', 'utf8');
const companyHtml = await readFile('nexus/company.html', 'utf8');

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
assert.match(homeSource, /company\.public_profile_read/, 'home must use the read-only public projection operation');
assert.match(homeSource, /knownRevision: Number\(cached\?\.snapshot\?\.revision \|\| 0\)/, 'home must verify the cached revision in background');
assert.match(homeSource, /if \(cached\)[\s\S]*setCompanyState\('STALE'/, 'a server failure must preserve the last normal Snapshot');
assert.match(homeSource, /companyEditLink\.hidden = !isCompanyAdministrator\(session\)/, 'only a company administrator may see the edit entry');
assert.doesNotMatch(homeSource, /localStorage/, 'the company Snapshot must not be persisted in localStorage');

assert.match(companyHtml, /nexus-ui-theme-init\.js\?v=1\.3\.1/, 'company management must consume the current common UI contract');
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

console.log('NEXUS company profile contracts passed (25 checks).');
