import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, loadBrowserModule, makeAuthority } from './dataops-situation-v2-test-harness.mjs';

const expected = { deploymentId: 'DEPLOY-V2', deploymentVersion: '1', gitCommit: 'commit-v2' };
const productData = [{ 품목코드: 'P1', 창고코드: 'W1', 전산잔량: -7, 실사: 0 }];
const context = { productData, targetDateStr: '2026-08-25' };
function bridge(authority, calls = []) {
  return async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(structuredClone(payload));
    try {
      const data = authority.context.dataOpsSituationHandleAction(authority.ss, payload.action, payload);
      return { ok: true, status: 200, json: async () => ({ status: 'success', data }) };
    } catch (error) {
      return { ok: false, status: 400, json: async () => ({ status: 'error', message: error.message }) };
    }
  };
}

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const calls = [];
const browser = loadBrowserModule({ fetch: bridge(authority, calls), expected });
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.hasRuntimeCredential(), false, 'reload starts without credential');
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.operationalSourceReady(context), true);
await assert.rejects(() => browser.DATAOPS_SITUATION_V2_MODULE.publishProductState('mock://dataops', context), /DATAOPS_V2_CAPABILITY_REQUIRED/);
assert.equal(authority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false);

const connection = browser.DATAOPS_SITUATION_V2_MODULE.createDefaultOperatorConnection({ url: 'mock://dataops', credential: credentials });
assert.equal((await connection.capability()).ready, true);
assert.equal(connection.operationalSourceReady(context), true);
const published = await connection.publish(context);
assert.equal(published.manifest.status, 'PUBLISHED');
assert.equal(published.rows[0].signedBaseQuantity, 0, 'explicit actual count zero wins over calculated balance');
assert.equal(published.rows[0].productMasterRevision, 3);
assert.equal(published.rows[0].warehouseMasterRevision, 2);
assert.equal(published.rows[0].includedOrderQLedgerSequence, 7);
assert.deepEqual(calls.map(row => row.action), ['situation_dataops_ping', 'situation_dataops_ping', 'situation_dataops_publish', 'situation_dataops_publish']);
assert.ok(calls[2].prepareOperationalRequest, 'first party path asks Cloud to prepare authoritative source');
assert.ok(calls[3].snapshot && calls[3].producerEvidence, 'prepared envelope is then atomically published');

const reloaded = loadBrowserModule({ fetch: bridge(authority), expected });
assert.equal(reloaded.DATAOPS_SITUATION_V2_MODULE.hasRuntimeCredential(), false, 'credential is not persisted across reload');
await assert.rejects(() => reloaded.DATAOPS_SITUATION_V2_MODULE.publishProductState('mock://dataops', context), /DATAOPS_V2_CAPABILITY_REQUIRED/);
reloaded.DATAOPS_SITUATION_V2_MODULE.createDefaultOperatorConnection({ url: 'mock://dataops', credential: credentials });
assert.equal(reloaded.DATAOPS_SITUATION_V2_MODULE.hasRuntimeCredential(), true, 'operator explicitly reconfigures ephemeral credential');

for (const badProductData of [
  [{ 품목코드: 'UNKNOWN', 창고코드: 'W1', 실사: 1 }],
  [{ 품목코드: 'P1', 창고코드: '', 실사: 1 }],
  [{ 품목코드: 'P1', 창고코드: 'W1', 실사: '' , 전산잔량: '' }]
]) {
  const invalid = makeAuthority({ entities: baseEntities() });
  const invalidCredentials = configureAuthority(invalid);
  const invalidBrowser = loadBrowserModule({ fetch: bridge(invalid), expected });
  const invalidConnection = invalidBrowser.DATAOPS_SITUATION_V2_MODULE.createDefaultOperatorConnection({ url: 'mock://dataops', credential: invalidCredentials });
  await assert.rejects(() => invalidConnection.publish({ productData: badProductData, targetDateStr: '2026-08-25' }));
  assert.equal(invalid.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false, 'missing product/warehouse/quantity has publish mutation0');
}

const tamperAuthority = makeAuthority({ entities: baseEntities() });
const tamperCredentials = configureAuthority(tamperAuthority);
const prepareRequest = { operationId: 'TAMPER', occurredAt: '2026-08-25T00:00:00.000Z', basisDate: '2026-08-25',
  rows: [{ productCode: 'P1', warehouseCode: 'W1', signedBaseQuantity: 1, status: 'ACTIVE' }] };
const prepared = tamperAuthority.context.dataOpsSituationHandleAction(tamperAuthority.ss, 'situation_dataops_publish', {
  ...tamperCredentials, prepareOperationalRequest: prepareRequest
});
for (const mutate of [
  value => { value.snapshot.rows[0].productMasterRevision = 0; },
  value => { value.snapshot.rows[0].includedOrderQLedgerSequence = 0; },
  value => { value.producerEvidence.rows[0].sourceEvidence = []; }
]) {
  const value = structuredClone(prepared); mutate(value);
  assert.throws(() => tamperAuthority.context.dataOpsSituationHandleAction(tamperAuthority.ss, 'situation_dataops_publish', {
    ...tamperCredentials, ...value
  }));
  assert.equal(tamperAuthority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false, 'missing revision/cutoff/evidence has mutation0');
}
console.log('DataOps Situation V2 first-party product path tests passed');
