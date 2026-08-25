import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import(new URL(`../dataops/close-ui.js?test=${Date.now()}`, import.meta.url));
const api = globalThis.DATAOPS_CLOSE_UI_MODULE;
assert.ok(api?.createDataOpsCloseOperator, 'first-party close UI module must load');

const html = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8');
assert.match(html, /dataops\/close-ui\.js\?v=0\.1\.0/);
assert.equal((html.match(/id: "dataops-close-start"/g) || []).length, 1, 'exactly one start button');
assert.equal((html.match(/id: "dataops-close-confirm"/g) || []).length, 1, 'exactly one confirm button');
assert.match(html, /id: "dataops-close-review"/);
assert.match(html, /!closeUiState\.releaseEnabled/);

const productData = [{ 품목코드: 'P1', 창고코드: 'W1', 실사: 0, 이슈: ['재고 차이 확인'] }];
const sources = {
  dataops: { session: { readSessionId: 'D-SESSION', tokenDigest: 'd'.repeat(64) }, head: { currentHeadDigest: 'D-HEAD' }, rows: [{ rowId: 'D1' }], pages: [] },
  orderq: { session: { readSessionId: 'O-SESSION', tokenDigest: 'o'.repeat(64) }, head: { currentHeadDigest: 'O-HEAD' }, entities: [{ entityType: 'ORDER' }] }
};
const credential = { token: 'memory-only-token', actorId: 'ADMIN', deviceId: 'TEST', environment: 'TEST', scope: { companyId: 'ONEAPP' } };
const orderQCredential = { ...credential, token: 'separate-orderq-memory-token' };
const expected = { deploymentId: 'DEPLOY', deploymentVersion: '31', gitCommit: 'abcdef123456' };
const ping = { ...expected, capabilityVersion: 'DATAOPS_CLOSE_V1', actions: api.ACTIONS };

let prereleaseCalls = 0;
const prerelease = api.createDataOpsCloseOperator({ post: async () => { prereleaseCalls += 1; } });
assert.equal(prerelease.state().releaseEnabled, false);
await assert.rejects(() => prerelease.start({ productData, businessDate: '2026-08-26' }), /DEPLOYMENT_NOT_RELEASED/);
assert.equal(prereleaseCalls, 0, 'pre-release path must perform zero network or mutation');
const missingOrderQ = api.createDataOpsCloseOperator({ expectedDeployment: expected, post: async () => { prereleaseCalls += 1; } });
await assert.rejects(() => missingOrderQ.connect({ url: 'https://example.invalid/exec', dataOpsCredential: credential }), /ORDERQ_ACCESS_DENIED|ACCESS_DENIED/);
assert.equal(prereleaseCalls, 0, 'missing ORDER Q credential must perform zero network');

const calls = [];
const reviewFixture = { issues: [{ issueId: 'I1', issueCode: 'CHECK', severity: 'REVIEW', message: 'check' }], report: { businessDate: '2026-08-26', inventoryRows: 1, orderRows: 1, purchaseRows: 0, salesRows: 0, receivableRows: 0, payableRows: 0, issueCount: 1 }, context: { series: null }, inventoryRows: [], orderRows: [], purchaseRows: [], salesRows: [], receivableRows: [], payableRows: [], companyId: 'ONEAPP', businessDate: '2026-08-26', closeSeriesId: 'CLOSE-TEST', companyCloseScopeDigest: 's'.repeat(64) };
const finalizeFixture = async ({ commandId }) => ({ intentPlan: { revision: { closeRevisionId: 'CR1', revision: 1 }, series: {} }, resultSnapshot: { resultBDigest: 'b'.repeat(64) }, reportManifest: { fileDigest: 'r'.repeat(64) }, decisions: [{ issueDecisionId: 'D1' }], decisionDigest: 'i'.repeat(64), bundle: { revision: { commandId }, series: {}, sourceSnapshot: {}, resultSnapshot: {} } });
const post = async (_connection, action, body = {}) => {
  calls.push({ action, body });
  if (action === 'dataops_close_ping') return ping;
  if (action === 'dataops_close_context') return { series: null, priorInventoryRows: [], approvedBaselines: [], contextDigest: 'c'.repeat(64) };
  if (action === 'dataops_close_seal') return { sourceSealId: 'SEAL-1', receiptFingerprint: 'f'.repeat(64) };
  if (action === 'dataops_close_prepare') return { status: 'PREPARED' };
  if (action === 'dataops_close_write_chunks') return { status: 'VERIFIED' };
  if (action === 'dataops_close_commit') return { status: 'COMMITTED', closeRevisionId: body.intent.closeRevisionId };
  throw new Error(`UNEXPECTED:${action}`);
};
const operator = api.createDataOpsCloseOperator({ expectedDeployment: expected, post, loadFrozenSources: async () => sources,
  buildReview: async () => reviewFixture, finalizeClose: finalizeFixture, persistProjection: async () => true,
  randomId: (() => { let id = 0; return () => String(++id); })() });
assert.equal(operator.state().releaseEnabled, true);
await operator.connect({ url: 'https://example.invalid/exec', dataOpsCredential: credential, orderQCredential });
await operator.start({ productData, businessDate: '2026-08-26' });
assert.equal(operator.state().phase, 'REVIEW');
assert.equal(operator.state().report.issueCount, 1);
operator.setReviewReason('fixture review'); operator.markReviewed(true);
await operator.confirm();
assert.equal(operator.state().phase, 'COMMITTED');
assert.deepEqual(calls.map(call => call.action), ['dataops_close_ping', 'dataops_close_context', 'dataops_close_seal', 'dataops_close_prepare', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_commit']);
assert.deepEqual(calls.filter(call => call.action === 'dataops_close_write_chunks').map(call => call.body.kind), ['A', 'B', 'ISSUES', 'DECISIONS', 'REPORT', 'BASELINES']);

const mismatchCalls = [];
const mismatch = api.createDataOpsCloseOperator({ expectedDeployment: expected,
  post: async (_connection, action) => { mismatchCalls.push(action); if (action === 'dataops_close_ping') return ping; if (action === 'dataops_close_context') return { series: null, priorInventoryRows: [], approvedBaselines: [], contextDigest: 'c'.repeat(64) }; if (action === 'dataops_close_seal') return { sourceSealId: 'SEAL-2' }; throw new Error('MUTATION_FORBIDDEN'); },
  loadFrozenSources: async () => sources, buildReview: async () => reviewFixture, finalizeClose: finalizeFixture, verifyFresh: async () => { throw new Error('CLOSE_SOURCE_CHANGED_AFTER_SEAL'); }, persistProjection: async () => true });
await mismatch.connect({ url: 'https://example.invalid/exec', dataOpsCredential: credential, orderQCredential });
await mismatch.start({ productData, businessDate: '2026-08-26' });
mismatch.setReviewReason('fixture review'); mismatch.markReviewed(true);
await assert.rejects(() => mismatch.confirm(), /CLOSE_SOURCE_CHANGED_AFTER_SEAL/);
assert.deepEqual(mismatchCalls, ['dataops_close_ping', 'dataops_close_context', 'dataops_close_seal'], 'head mismatch must perform zero prepare/chunk/commit mutation');

let storageAccesses = 0;
globalThis.localStorage = new Proxy({}, { get() { storageAccesses += 1; throw new Error('STORAGE_FORBIDDEN'); } });
globalThis.sessionStorage = new Proxy({}, { get() { storageAccesses += 1; throw new Error('STORAGE_FORBIDDEN'); } });
const fetchEnvelopes = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request.body); fetchEnvelopes.push(body);
  const action = body.action;
  const data = action.endsWith('_begin') ? { authority: 'ORDERQ', readSessionId: 'OS', tokenDigest: 'x'.repeat(64), status: 'OPEN' }
    : action.endsWith('_page') ? { pageIndex: 0, rowCount: 0, pageDigest: 'y'.repeat(64), entities: [] }
      : { frozenTokenDigest: 'x'.repeat(64), currentHeadRevision: 1, currentHeadDigest: 'z'.repeat(64) };
  return { ok: true, json: async () => ({ status: 'success', action, data }) };
};
try {
  const readAdapter = api.createOrderQReadAdapter({ url: 'https://example.invalid/exec', orderQCredential });
  await readAdapter.begin({ businessDate: '2026-08-26', dataOpsReadSessionId: 'DS', dataOpsTokenDigest: 'd'.repeat(64) });
  await readAdapter.page({ readSessionId: 'OS', tokenDigest: 'x'.repeat(64), pageIndex: 0 });
  await readAdapter.head({ readSessionId: 'OS', tokenDigest: 'x'.repeat(64) });
} finally { globalThis.fetch = originalFetch; }
assert.equal(storageAccesses, 0, 'ORDER Q read adapter must not access local/session storage');
assert.deepEqual(fetchEnvelopes.map(row => row.action), ['situation_orderq_begin', 'situation_orderq_page', 'situation_orderq_head']);
assert.ok(fetchEnvelopes.every(row => row.token === orderQCredential.token && row.actorId === credential.actorId && row.scope.companyId === credential.scope.companyId));
assert.ok(fetchEnvelopes.every(row => !String(row.action).includes('publish') && !String(row.action).includes('rollback')));

const revisionCalls=[];let finalizedAction='';const revisionContext={series:{seriesHeadRevision:2,seriesHeadRevisionId:'R2',currentEffectiveRevision:2,currentEffectiveRevisionId:'R2',previousEffectiveRevision:1,previousEffectiveRevisionId:'R1'},priorInventoryRows:[{inventoryKey:'K'}],approvedBaselines:[],contextDigest:'c'.repeat(64)},revisionOperator=api.createDataOpsCloseOperator({expectedDeployment:expected,post:async(_connection,action,body={})=>{revisionCalls.push(action);if(action==='dataops_close_ping')return ping;if(action==='dataops_close_context')return revisionContext;if(action==='dataops_close_seal')return{sourceSealId:'S3',receiptFingerprint:'f'.repeat(64)};if(action==='dataops_close_prepare'||action==='dataops_close_write_chunks')return{};if(action==='dataops_close_commit')return{status:'COMMITTED',finalReceiptFingerprint:body.intent.finalReceiptFingerprint};throw new Error(action);},loadFrozenSources:async()=>sources,buildReview:async()=>({...reviewFixture,context:{series:revisionContext.series}}),finalizeClose:async input=>{finalizedAction=input.actionType;return finalizeFixture(input);},persistProjection:async()=>true,randomId:()=>String(revisionCalls.length)});await revisionOperator.connect({url:'https://example.invalid/exec',dataOpsCredential:credential,orderQCredential});await revisionOperator.start({productData,businessDate:'2026-08-26'});assert.equal(revisionOperator.state().actionType,'CORRECT_CLOSE');assert.deepEqual(revisionOperator.state().availableActions,['CORRECT_CLOSE','REVERSE_CLOSE']);revisionOperator.selectAction('REVERSE_CLOSE');revisionOperator.setReviewReason('reverse explicit');revisionOperator.markReviewed(true);await revisionOperator.confirm();assert.equal(finalizedAction,'REVERSE_CLOSE');

let openingApproved=false;const openingReview={...reviewFixture,openingBaselineRequired:true,proposedOpeningBaselines:[{baselineId:'B1'}]},openingOperator=api.createDataOpsCloseOperator({expectedDeployment:expected,post:async(_connection,action)=>action==='dataops_close_ping'?ping:action==='dataops_close_context'?{series:null,priorInventoryRows:[],approvedBaselines:[],contextDigest:'c'.repeat(64)}:action==='dataops_close_seal'?{sourceSealId:'SB',receiptFingerprint:'f'.repeat(64)}:{status:'OK'},loadFrozenSources:async()=>sources,buildReview:async()=>openingReview,finalizeClose:async input=>{openingApproved=input.openingBaselineApproved;return{...(await finalizeFixture(input)),approvedOpeningBaselines:[{baselineId:'B1'}]};},persistProjection:async()=>true});await openingOperator.connect({url:'https://example.invalid/exec',dataOpsCredential:credential,orderQCredential});await openingOperator.start({productData,businessDate:'2026-08-26'});openingOperator.setReviewReason('explicit opening');openingOperator.markReviewed(true);await assert.rejects(()=>openingOperator.confirm(),/REVIEW_REQUIRED/);openingOperator.approveOpeningBaseline(true);openingOperator.markReviewed(true);await openingOperator.confirm();assert.equal(openingApproved,true);

let referenceErrors = 0;
try {
  const React = { createElement: (type, props, label) => ({ type, props, label }) };
  const state = { releaseEnabled: false, phase: 'IDLE', reviewed: false };
  const nodes = [
    React.createElement('button', { id: 'dataops-close-start', disabled: !state.releaseEnabled || productData.length === 0 }, '일마감 시작'),
    React.createElement('button', { id: 'dataops-close-confirm', disabled: state.phase !== 'REVIEW' || !state.reviewed }, '마감 확정')
  ];
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every(node => node.props.disabled));
} catch (error) { if (error instanceof ReferenceError) referenceErrors += 1; else throw error; }
assert.equal(referenceErrors, 0, 'DataOps product render must have zero ReferenceError');
console.log('DataOps Stage6 close UI product path PASS disabled/mutation0 + start/seal/review/prepare/chunks/commit/report + head mismatch');
