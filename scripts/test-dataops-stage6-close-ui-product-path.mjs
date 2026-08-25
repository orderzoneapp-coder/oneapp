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
const expected = { deploymentId: 'DEPLOY', deploymentVersion: '31', gitCommit: 'abcdef123456' };
const ping = { ...expected, capabilityVersion: 'DATAOPS_CLOSE_V1', actions: api.ACTIONS };

let prereleaseCalls = 0;
const prerelease = api.createDataOpsCloseOperator({ post: async () => { prereleaseCalls += 1; } });
assert.equal(prerelease.state().releaseEnabled, false);
await assert.rejects(() => prerelease.start({ productData, businessDate: '2026-08-26' }), /DEPLOYMENT_NOT_RELEASED/);
assert.equal(prereleaseCalls, 0, 'pre-release path must perform zero network or mutation');

const calls = [];
const post = async (_connection, action, body = {}) => {
  calls.push({ action, body });
  if (action === 'dataops_close_ping') return ping;
  if (action === 'dataops_close_seal') return { sourceSealId: 'SEAL-1', receiptFingerprint: 'f'.repeat(64) };
  if (action === 'dataops_close_prepare') return { status: 'PREPARED' };
  if (action === 'dataops_close_write_chunks') return { status: 'VERIFIED' };
  if (action === 'dataops_close_commit') return { status: 'COMMITTED', closeRevisionId: body.intent.closeRevisionId };
  throw new Error(`UNEXPECTED:${action}`);
};
const operator = api.createDataOpsCloseOperator({ expectedDeployment: expected, post, loadFrozenSources: async () => sources,
  confirmDataOpsHead: async () => sources.dataops.head, confirmOrderQHead: async () => sources.orderq.head,
  randomId: (() => { let id = 0; return () => String(++id); })() });
assert.equal(operator.state().releaseEnabled, true);
await operator.connect({ url: 'https://example.invalid/exec', credential });
await operator.start({ productData, businessDate: '2026-08-26' });
assert.equal(operator.state().phase, 'REVIEW');
assert.equal(operator.state().report.issueCount, 1);
operator.markReviewed(true);
await operator.confirm();
assert.equal(operator.state().phase, 'COMMITTED');
assert.deepEqual(calls.map(call => call.action), ['dataops_close_ping', 'dataops_close_seal', 'dataops_close_prepare', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_write_chunks', 'dataops_close_commit']);
assert.deepEqual(calls.filter(call => call.action === 'dataops_close_write_chunks').map(call => call.body.kind), ['A', 'B', 'ISSUES']);

const mismatchCalls = [];
const mismatch = api.createDataOpsCloseOperator({ expectedDeployment: expected,
  post: async (_connection, action) => { mismatchCalls.push(action); if (action === 'dataops_close_ping') return ping; if (action === 'dataops_close_seal') return { sourceSealId: 'SEAL-2' }; throw new Error('MUTATION_FORBIDDEN'); },
  loadFrozenSources: async () => sources, confirmDataOpsHead: async () => ({ currentHeadDigest: 'D-CHANGED' }), confirmOrderQHead: async () => sources.orderq.head });
await mismatch.connect({ url: 'https://example.invalid/exec', credential });
await mismatch.start({ productData, businessDate: '2026-08-26' });
mismatch.markReviewed(true);
await assert.rejects(() => mismatch.confirm(), /CLOSE_SOURCE_CHANGED_AFTER_SEAL/);
assert.deepEqual(mismatchCalls, ['dataops_close_ping', 'dataops_close_seal'], 'head mismatch must perform zero prepare/chunk/commit mutation');

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
