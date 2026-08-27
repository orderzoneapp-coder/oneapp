import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { closeWriteEnabled, evaluateDataOpsCloseCapability, DATAOPS_CLOSE_ACTIONS, DATAOPS_CLOSE_EXPECTED_DEPLOYMENT } from '../orderq/dataops-close-cloud-adapter.js';

const releaseIdentity = { deploymentId: 'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw', deploymentVersion: '31', gitCommit: '48a52ec34fa938cd60fe965b795083539460627f' };
assert.deepEqual(DATAOPS_CLOSE_EXPECTED_DEPLOYMENT, releaseIdentity);
const closePing = { ...releaseIdentity, capabilityVersion: 'DATAOPS_CLOSE_V1', actions: DATAOPS_CLOSE_ACTIONS };
assert.equal(closeWriteEnabled(closePing), true);
for (const key of ['deploymentId', 'deploymentVersion', 'gitCommit', 'capabilityVersion']) {
  assert.equal(evaluateDataOpsCloseCapability({ ...closePing, [key]: 'MUTATED' }).ready, false);
}
assert.deepEqual(DATAOPS_CLOSE_ACTIONS, ['dataops_close_ping', 'dataops_close_context', 'dataops_close_seal', 'dataops_close_prepare', 'dataops_close_write_chunks', 'dataops_close_commit', 'dataops_close_abort']);

const code = fs.readFileSync(new URL('../code.gs', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../dataops-close-stage6.gs', import.meta.url), 'utf8');
assert.match(code, /dataops_snapshot_commit/);
assert.match(code, /ONEAPP_DATAOPS_SNAPSHOT_V1/);
assert.match(code, /dataOpsV1PreflightAction\(action,payload/);
assert.match(code, /const DATAOPS_SNAPSHOT_COLUMNS = \['단위', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '기본', '적요', '행사가'\]/);
assert.match(code, /ONEAPP_DATAOPS_CURRENT_SLOT/);
assert.match(code, /oneappNexusGatewayRequire\(payload, 'DATAOPS'/);

const context = { Object, String, Array, JSON, dataOpsSituationRequireAuth(payload, role) {
  if (!(payload.roles || []).includes(role)) throw new Error('DATAOPS_SITUATION_ROLE_FORBIDDEN');
  return { actorId: 'A', roleIds: payload.roles };
} };
vm.createContext(context);
vm.runInContext(`${cloud}\nglobalThis.security={mode:dataOpsV1SecurityMode,capability:dataOpsV1SecurityCapability,require:dataOpsV1RequireAccess};`, context);
const legacyProps = { getProperty: () => '' };
assert.equal(context.security.require({}, 'WRITE', legacyProps).legacyCompatible, true, 'LEGACY_V1 remains supported');
const cutoverProps = { getProperty: key => key === 'ONEAPP_DATAOPS_V1_SECURITY_MODE' ? 'SERVER_FIRST_V1' : '' };
assert.throws(() => context.security.require({ roles: ['DATAOPS_SNAPSHOT_V1_READ'] }, 'WRITE', cutoverProps), /ROLE_FORBIDDEN/);

const gatewayCalls = [];
const securityPing = { ...releaseIdentity, capabilityVersion: 'DATAOPS_SNAPSHOT_V1_SECURITY_V1', mode: 'SERVER_FIRST_V1', readAuthRequired: true,
  writeAuthRequired: true, roles: ['DATAOPS_SNAPSHOT_V1_READ', 'DATAOPS_SNAPSHOT_V1_WRITE'], actions: ['dataops_snapshot_get', 'dataops_snapshot_commit'] };
const snapshot = { schemaVersion: 'ONEAPP_DATAOPS_SNAPSHOT_V1', revision: 1 };
globalThis.ONEAPP_AUTH = Object.freeze({
  ready: Promise.resolve(),
  gateway: async (operationId, payload = {}) => {
    gatewayCalls.push({ operationId, payload: structuredClone(payload) });
    if (operationId === 'dataops.security_ping') return securityPing;
    if (operationId === 'dataops.snapshot.get') return snapshot;
    if (operationId === 'dataops.snapshot.commit') return { revision: 2, hash: payload.snapshot.hash };
    throw new Error(`UNEXPECTED_OPERATION:${operationId}`);
  }
});
await import(new URL(`../dataops/v1-security-client.js?test=${Date.now()}`, import.meta.url));
const v1 = globalThis.DATAOPS_V1_SECURITY_CLIENT;
assert.equal(v1.evaluate(securityPing), true);

const readClient = v1.createReadClient();
assert.deepEqual(await readClient.getSnapshot({ url: 'NEXUS_GATEWAY' }), snapshot);
const legacyModule = { buildSnapshot: async () => ({ hash: 'a'.repeat(64), canonicalJson: '{}', rowCount: 0, cellCount: 0 }) };
const client = v1.createClient();
const committed = await client.commitSnapshot({ legacyModule, productData: [], targetDateStr: '2026-08-26', url: 'NEXUS_GATEWAY' });
assert.equal(committed.saved.revision, 2);
assert.deepEqual(gatewayCalls.map(row => row.operationId), [
  'dataops.security_ping', 'dataops.snapshot.get', 'dataops.security_ping', 'dataops.snapshot.commit'
]);
assert.ok(gatewayCalls.every(row => !Object.hasOwn(row.payload, 'token') && !Object.hasOwn(row.payload, 'actorId')));
assert.deepEqual(client.envelope('READ'), {});

const clientSource = fs.readFileSync(new URL('../dataops/v1-security-client.js', import.meta.url), 'utf8');
assert.match(clientSource, /ONEAPP_AUTH\.gateway/);
assert.doesNotMatch(clientSource, /localStorage|sessionStorage|businessCredential|token\s*:/);
const merch = fs.readFileSync(new URL('../MerchOps.html', import.meta.url), 'utf8');
const sourceAdapter = fs.readFileSync(new URL('../orderops/orderops-source-adapter.js', import.meta.url), 'utf8');
const orders = fs.readFileSync(new URL('../orders.html', import.meta.url), 'utf8');
const ordersMirror = fs.readFileSync(new URL('../orderops_list.html', import.meta.url), 'utf8');
assert.match(merch, /dataops\/v1-security-client\.js\?v=0\.1\.2/);
assert.match(sourceAdapter, /DATAOPS_V1_SECURITY_CLIENT\?\.readClient/);
assert.equal(ordersMirror, orders, 'the root ORDER Q mirror must stay byte-identical');
console.log('PASS stage6 V2 Gateway cutover, V1 business compatibility, and role isolation');
