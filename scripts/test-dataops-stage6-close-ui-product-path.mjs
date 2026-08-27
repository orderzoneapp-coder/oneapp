import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gatewayCalls = [];
globalThis.ONEAPP_AUTH = Object.freeze({
  ready: Promise.resolve(),
  gateway: async (operationId, payload = {}) => {
    gatewayCalls.push({ operationId, payload: structuredClone(payload) });
    if (operationId === 'orderq.situation.begin') return { authority: 'ORDERQ', readSessionId: 'OS', tokenDigest: 'x'.repeat(64), status: 'OPEN' };
    if (operationId === 'orderq.situation.page') return { pageIndex: 0, rowCount: 0, pageDigest: 'y'.repeat(64), entities: [] };
    if (operationId === 'orderq.situation.head') return { frozenTokenDigest: 'x'.repeat(64), currentHeadRevision: 1, currentHeadDigest: 'z'.repeat(64) };
    throw new Error(`UNEXPECTED_GATEWAY_OPERATION:${operationId}`);
  }
});
await import(new URL(`../dataops/close-ui.js?test=${Date.now()}`, import.meta.url));
const api = globalThis.DATAOPS_CLOSE_UI_MODULE;
assert.ok(api?.createDataOpsCloseOperator, 'first-party close UI module must load');

const html = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../dataops/close-ui.js', import.meta.url), 'utf8');
assert.match(html, /dataops\/close-ui\.js\?v=0\.1\.2/);
assert.equal((html.match(/id: "dataops-close-start"/g) || []).length, 1);
assert.equal((html.match(/id: "dataops-close-confirm"/g) || []).length, 1);
assert.match(source, /ONEAPP_AUTH\.gateway/);
assert.doesNotMatch(source, /businessCredential|localStorage|sessionStorage|\.token\b|token\s*:/, 'browser close path must not handle a raw service credential');

const productionExpected = { deploymentId: 'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw' };
assert.deepEqual(api.EXPECTED_DEPLOYMENT, productionExpected);
const productionPing = { ...productionExpected, deploymentVersion: 'production-version', gitCommit: 'production-commit', capabilityVersion: 'DATAOPS_CLOSE_V1', actions: api.ACTIONS };
assert.equal(api.evaluateCapability(productionPing), true);

const orderq = api.createOrderQReadAdapter({ url: 'NEXUS_GATEWAY' });
await orderq.begin({ businessDate: '2026-08-26' });
await orderq.page({ readSessionId: 'OS', tokenDigest: 'x'.repeat(64), pageIndex: 0 });
await orderq.head({ readSessionId: 'OS', tokenDigest: 'x'.repeat(64) });
assert.deepEqual(gatewayCalls.map(row => row.operationId), ['orderq.situation.begin', 'orderq.situation.page', 'orderq.situation.head']);
assert.ok(gatewayCalls.every(row => !Object.hasOwn(row.payload, 'token') && !Object.hasOwn(row.payload, 'actorId')));

const expected = { deploymentId: 'DEPLOY', deploymentVersion: '31', gitCommit: 'abcdef123456' };
const ping = { ...expected, capabilityVersion: 'DATAOPS_CLOSE_V1', actions: api.ACTIONS };
const productData = [{ 품목코드: 'P1', 창고코드: 'W1', 실사: 0, 이슈: ['재고 차이 확인'] }];
const sources = {
  dataops: { session: { readSessionId: 'D-SESSION', tokenDigest: 'd'.repeat(64) }, head: { currentHeadDigest: 'D-HEAD' }, rows: [{ rowId: 'D1' }], pages: [] },
  orderq: { session: { readSessionId: 'O-SESSION', tokenDigest: 'o'.repeat(64) }, head: { currentHeadDigest: 'O-HEAD' }, entities: [{ entityType: 'ORDER' }] }
};
const reviewFixture = {
  issues: [{ issueId: 'I1', issueCode: 'CHECK', severity: 'REVIEW', message: 'check' }],
  report: { businessDate: '2026-08-26', inventoryRows: 1, orderRows: 1, purchaseRows: 0, salesRows: 0, receivableRows: 0, payableRows: 0, issueCount: 1 },
  context: { series: null }, inventoryRows: [], orderRows: [], purchaseRows: [], salesRows: [], receivableRows: [], payableRows: [],
  companyId: 'ONEAPP', businessDate: '2026-08-26', closeSeriesId: 'CLOSE-TEST', companyCloseScopeDigest: 's'.repeat(64)
};
const finalizeFixture = async ({ commandId }) => ({
  intentPlan: { revision: { closeRevisionId: 'CR1', revision: 1 }, series: {} },
  resultSnapshot: { resultBDigest: 'b'.repeat(64), auditEvents: [] },
  reportManifest: { fileDigest: 'r'.repeat(64) }, decisions: [{ issueDecisionId: 'D1' }], decisionDigest: 'i'.repeat(64),
  bundle: { revision: { commandId }, series: {}, sourceSnapshot: {}, resultSnapshot: {} }
});
const calls = [];
const post = async (_connection, action, body = {}) => {
  calls.push({ action, body: structuredClone(body) });
  if (action === 'dataops_close_ping') return ping;
  if (action === 'dataops_close_context') return { series: null, priorInventoryRows: [], approvedBaselines: [], contextDigest: 'c'.repeat(64) };
  if (action === 'dataops_close_seal') return { sourceSealId: 'SEAL-1', receiptFingerprint: 'f'.repeat(64), orderqHeadDigestAtSeal: 'o'.repeat(64), dataopsHeadDigestAtSeal: 'd'.repeat(64) };
  if (action === 'dataops_close_prepare') return { status: 'PREPARED' };
  if (action === 'dataops_close_write_chunks') return { status: 'VERIFIED' };
  if (action === 'dataops_close_commit') return { status: 'COMMITTED', closeRevisionId: body.intent.closeRevisionId };
  throw new Error(`UNEXPECTED:${action}`);
};
const operator = api.createDataOpsCloseOperator({
  expectedDeployment: expected, post, loadFrozenSources: async () => sources, buildReview: async () => reviewFixture,
  finalizeClose: finalizeFixture, persistProjection: async () => true, randomId: (() => { let id = 0; return () => String(++id); })()
});
await operator.connect({ url: 'NEXUS_GATEWAY' });
await operator.start({ productData, businessDate: '2026-08-26' });
assert.equal(operator.state().phase, 'REVIEW');
operator.setReviewReason('fixture review');
operator.markReviewed(true);
await operator.confirm();
assert.equal(operator.state().phase, 'COMMITTED');
assert.deepEqual(calls.map(call => call.action), [
  'dataops_close_ping', 'dataops_close_context', 'dataops_close_seal', 'dataops_close_prepare',
  'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks',
  'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_commit'
]);
assert.deepEqual(calls.filter(call => call.action === 'dataops_close_write_chunks').map(call => call.body.kind), ['A', 'B', 'ISSUES', 'DECISIONS', 'AUDIT', 'REPORT', 'BASELINES']);

const prerelease = api.createDataOpsCloseOperator({ expectedDeployment: { deploymentId: '', deploymentVersion: '', gitCommit: '' }, post: async () => { throw new Error('NETWORK_FORBIDDEN'); } });
await assert.rejects(() => prerelease.start({ productData, businessDate: '2026-08-26' }), /DEPLOYMENT_NOT_RELEASED/);
console.log('DataOps close V2 Gateway product-path tests passed');
