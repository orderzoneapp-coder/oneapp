import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseEntities, configureAuthority, loadBrowserModule, makeAuthority, snapshotInput } from './dataops-situation-v2-test-harness.mjs';

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
assert.throws(() => browser.DATAOPS_SITUATION_V2_MODULE.setRuntimeCredential({ token: 'x', actorId: 'A' }), /DATAOPS_SITUATION_ACCESS_DENIED/);
const expected = { deploymentId: 'DEPLOY-V2', deploymentVersion: '1', gitCommit: 'commit-v2' };
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability(ping, expected).ready, true);
for (const field of ['deploymentId', 'deploymentVersion', 'gitCommit', 'capabilityVersion', 'schemaVersion', 'readSessionTtlSeconds', 'canonicalHash', 'publishMode']) {
  assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability({ ...ping, [field]: 'wrong' }, expected).ready, false, `${field} mismatch blocks`);
}
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability({ ...ping, actions: [...ping.actions].reverse() }, expected).ready, false, 'actions mutation blocks');
const releaseBrowser = loadBrowserModule();
const releaseExpected = releaseBrowser.DATAOPS_SITUATION_V2_MODULE.EXPECTED_DEPLOYMENT;
const releasePing = { ...ping, ...releaseExpected };
assert.equal(releaseBrowser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability(releasePing).ready, true, 'exact release ping enables capability');
for (const field of ['deploymentId', 'deploymentVersion', 'gitCommit']) {
  assert.equal(releaseBrowser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability({ ...releasePing, [field]: '' }).ready, false, `${field} blank blocks release`);
}

const browserSource = readFileSync(new URL('../DataOps_situation_v2.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../dataops-situation-v2.gs', import.meta.url), 'utf8');
assert.doesNotMatch(browserSource, /localStorage|sessionStorage/);
assert.doesNotMatch(serverSource, /appendRow\([^\n]*(token\b|payload\.token)/i);
assert.doesNotMatch(serverSource, /JSON\.stringify\([^\n]*payload\)/);

function bridge(authority, actionLog = []) {
  return async (_url, options) => {
    const payload = JSON.parse(options.body);
    actionLog.push({ action: payload.action, scope: structuredClone(payload.scope) });
    try {
      const data = authority.context.dataOpsSituationHandleAction(authority.ss, payload.action, payload);
      return { ok: true, status: 200, json: async () => ({ status: 'success', action: payload.action, data }) };
    } catch (error) {
      return { ok: false, status: 400, json: async () => ({ status: 'error', message: error.message }) };
    }
  };
}

const e2eAuthority = makeAuthority({ entities: baseEntities() });
const e2eCredentials = configureAuthority(e2eAuthority);
const actionLog = [];
const e2eBrowser = loadBrowserModule({ fetch: bridge(e2eAuthority, actionLog), expected, serviceCredential: e2eCredentials });
e2eBrowser.DATAOPS_SITUATION_V2_MODULE.setRuntimeCredential();
const e2eSource = snapshotInput(e2eAuthority.context);
const officialState = { authorityHead: e2eSource.authorityHead, movements: e2eSource.rows[0].sourceEvidence.map(item => ({ ...item,
  productId: 'P1', warehouseId: 'W1', baseUnit: 'EA' })) };
const published = await e2eBrowser.DATAOPS_SITUATION_V2_MODULE.publishOperationalState('mock://dataops', {
  operationalRows: e2eSource.rows, officialState, basisDate: e2eSource.basisDate, snapshotId: e2eSource.snapshotId,
  snapshotRevision: e2eSource.snapshotRevision, publishedAt: e2eSource.publishedAt, producer: e2eSource.producer, scope: e2eSource.scope
});
assert.equal(published.manifest.status, 'PUBLISHED');
assert.equal(JSON.parse(e2eAuthority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotId, e2eSource.snapshotId);
const begin = await e2eBrowser.DATAOPS_SITUATION_V2_MODULE.begin('mock://dataops');
await e2eBrowser.DATAOPS_SITUATION_V2_MODULE.page('mock://dataops', { readSessionId: begin.readSessionId, tokenDigest: begin.tokenDigest, pageIndex: 0 });
await e2eBrowser.DATAOPS_SITUATION_V2_MODULE.head('mock://dataops', { readSessionId: begin.readSessionId, tokenDigest: begin.tokenDigest });
assert.deepEqual(actionLog.map(row => row.action), ['situation_dataops_ping', 'situation_dataops_publish', 'situation_dataops_begin', 'situation_dataops_page', 'situation_dataops_head']);
assert.ok(actionLog.every(row => JSON.stringify(row.scope) === JSON.stringify({ companyId: 'ONEAPP' })), 'all browser action envelopes carry credential scope');

const stablePointer = e2eAuthority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER');
await assert.rejects(() => e2eBrowser.DATAOPS_SITUATION_V2_MODULE.publishOperationalState('mock://dataops', {
  operationalRows: e2eSource.rows, officialState, basisDate: e2eSource.basisDate, snapshotId: 'MISMATCH', snapshotRevision: 2,
  publishedAt: e2eSource.publishedAt, producer: e2eSource.producer, scope: { companyId: 'OTHER-COMPANY' }
}));
assert.equal(e2eAuthority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), stablePointer);

await e2eBrowser.DATAOPS_SITUATION_V2_MODULE.publishOperationalState('mock://dataops', {
  operationalRows: e2eSource.rows.map(row => ({ ...row, signedBaseQuantity: 0 })), officialState, basisDate: e2eSource.basisDate,
  snapshotId: 'SNAP-SECOND', snapshotRevision: 2, publishedAt: e2eSource.publishedAt, producer: e2eSource.producer, scope: e2eSource.scope
});
const secondPointer = e2eAuthority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER');
await assert.rejects(() => e2eBrowser.DATAOPS_SITUATION_V2_MODULE.rollback('mock://dataops', {
  expectedCurrentRevision: 1, reason: 'racing stale operator request'
}), /DATAOPS_V2_ROLLBACK_PRECONDITION_FAILED/);
assert.equal(e2eAuthority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), secondPointer, 'racing rollback has pointer mutation0');
const rollbackResult = await e2eBrowser.DATAOPS_SITUATION_V2_MODULE.rollback('mock://dataops', {
  expectedCurrentRevision: 2, reason: 'operator readback confirmed'
});
assert.equal(rollbackResult.snapshotRevision, 1);
assert.equal(JSON.parse(e2eAuthority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotId, e2eSource.snapshotId);
assert.match(serverSource, /action === 'situation_dataops_publish' && payload && payload\.rollbackRequest/);
assert.match(readFileSync(new URL('../code.gs', import.meta.url), 'utf8'), /situation_dataops_\(ping\|publish\|begin\|page\|head\)[\s\S]{0,200}withScriptLock/,
  'operator rollback travels through the locked publish connection');

for (const candidateExpected of [null, { deploymentId: 'WRONG', deploymentVersion: '1', gitCommit: 'commit-v2' }]) {
  const disabledAuthority = makeAuthority({ entities: baseEntities() });
  const disabledCredentials = configureAuthority(disabledAuthority);
  const disabledBrowser = loadBrowserModule({ fetch: bridge(disabledAuthority), serviceCredential: disabledCredentials, ...(candidateExpected ? { expected: candidateExpected } : {}) });
  disabledBrowser.DATAOPS_SITUATION_V2_MODULE.setRuntimeCredential();
  const disabledSource = snapshotInput(disabledAuthority.context);
  await assert.rejects(() => disabledBrowser.DATAOPS_SITUATION_V2_MODULE.publish('mock://dataops', disabledSource), /DATAOPS_V2_CAPABILITY_REQUIRED/);
  assert.equal(disabledAuthority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false, 'blank/wrong expected deployment has publish mutation0');
}

const otherAuthority = makeAuthority({ entities: baseEntities() });
const otherCredentials = configureAuthority(otherAuthority);
const otherBrowser = loadBrowserModule({ fetch: bridge(otherAuthority), expected, serviceCredential: { ...otherCredentials, scope: { companyId: 'OTHER-COMPANY' } } });
otherBrowser.DATAOPS_SITUATION_V2_MODULE.setRuntimeCredential();
await assert.rejects(() => otherBrowser.DATAOPS_SITUATION_V2_MODULE.publish('mock://dataops', {
  ...snapshotInput(otherAuthority.context), scope: { companyId: 'OTHER-COMPANY' }
}), /DATAOPS_V2_CAPABILITY_REQUIRED/);
assert.equal(otherAuthority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false);
console.log('DataOps Situation V2 auth and capability tests passed');
