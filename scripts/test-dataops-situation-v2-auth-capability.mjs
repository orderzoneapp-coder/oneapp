import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseEntities, configureAuthority, loadBrowserModule, makeAuthority } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const read = authority.context.dataOpsSituationRequireAuth(credentials, 'DATAOPS_SITUATION_READ', authority.properties);
assert.equal(read.actorId, 'ADMIN-1');
assert.throws(() => authority.context.dataOpsSituationRequireAuth({ ...credentials, actorId: 'OTHER' }, 'DATAOPS_SITUATION_READ', authority.properties), /DATAOPS_SITUATION_ACCESS_DENIED/);
assert.throws(() => authority.context.dataOpsSituationRequireAuth({ ...credentials, token: 'wrong' }, 'DATAOPS_SITUATION_READ', authority.properties), /DATAOPS_SITUATION_ACCESS_DENIED/);
assert.throws(() => authority.context.dataOpsSituationRequireAuth({ ...credentials, scope: { companyId: 'OTHER-COMPANY' } },
  'DATAOPS_SITUATION_READ', authority.properties), /DATAOPS_SITUATION_SCOPE_NOT_ALLOWED/);
assert.throws(() => authority.context.dataOpsSituationRequireAuth({ ...credentials, scope: { companyId: 'ONEAPP', warehouseId: 'W1' } },
  'DATAOPS_SITUATION_READ', authority.properties), /DATAOPS_SITUATION_SCOPE_NOT_ALLOWED/, 'request cannot expand server binding scope');

const publishOnly = makeAuthority({ entities: baseEntities() });
const publishCredential = configureAuthority(publishOnly, ['DATAOPS_SITUATION_PUBLISH']);
assert.throws(() => publishOnly.context.dataOpsSituationHandleAction(publishOnly.ss, 'situation_dataops_publish', publishCredential), /DATAOPS_SITUATION_ROLE_REQUIRED/,
  'publisher binding must explicitly include READ and PUBLISH');

const ping = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_ping', credentials);
assert.equal(ping.capabilityVersion, 'DATAOPS_SITUATION_V2');
assert.deepEqual([...ping.actions], ['situation_dataops_begin', 'situation_dataops_page', 'situation_dataops_head']);
const browser = loadBrowserModule();
const expected = { deploymentId: 'DEPLOY-V2', deploymentVersion: '1', gitCommit: 'commit-v2' };
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability(ping, expected).ready, true);
for (const field of ['deploymentId', 'deploymentVersion', 'gitCommit', 'capabilityVersion', 'schemaVersion', 'readSessionTtlSeconds']) {
  assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability({ ...ping, [field]: 'wrong' }, expected).ready, false, `${field} mismatch blocks`);
}

const browserSource = readFileSync(new URL('../DataOps_situation_v2.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../dataops-situation-v2.gs', import.meta.url), 'utf8');
assert.doesNotMatch(browserSource, /localStorage|sessionStorage/);
assert.doesNotMatch(serverSource, /appendRow\([^\n]*(token\b|payload\.token)/i);
assert.doesNotMatch(serverSource, /JSON\.stringify\([^\n]*payload\)/);
console.log('DataOps Situation V2 auth and capability tests passed');
