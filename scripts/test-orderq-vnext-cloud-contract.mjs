import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [codeGs, cloudGs, adapter, syncEngine, intake, indexHtml, inputHtml, cloudHtml] = await Promise.all([
  read('code.gs'),
  read('orderq-cloud.gs'),
  read('orderq/orderq-cloud-adapter.js'),
  read('orderq/orderq-sync-engine.js'),
  read('orderq/order-intake-engine.js'),
  read('orderq/index.html'),
  read('orderq/input.html'),
  read('orderq/cloud.html')
]);

// Parse Apps Script files as JavaScript without executing Google globals.
new vm.Script(codeGs, { filename: 'code.gs' });
new vm.Script(cloudGs, { filename: 'orderq-cloud.gs' });

for (const action of ['orderq_sync_push', 'orderq_sync_pull', 'orderq_order_head']) {
  assert.match(codeGs, new RegExp(`action === ['\"]${action}['\"]`), `code.gs must route ${action}`);
}
assert.match(codeGs, /orderQSyncPush\(ss, payload\)/);
assert.match(codeGs, /orderQSyncPull\(ss, payload\)/);
assert.match(codeGs, /orderQOrderHead\(ss, payload\)/);

assert.match(cloudGs, /ONEAPP_ORDERQ_SYNC_V1/);
for (const sheet of [
  'ORDER', 'ORDER_ITEM', 'ORDER_EVENT', 'CUSTOMER_MASTER', 'CUSTOMER_ALIAS_MAPPING',
  'PRODUCT_MAPPING', 'UNIT_MAPPING', 'MAPPING_EVENT', 'SYNC_META'
]) {
  assert.ok(cloudGs.includes(`'${sheet}'`), `purpose sheet missing: ${sheet}`);
}
assert.match(cloudGs, /existing\.order\.revision[\s\S]*baseRevision/, 'server must compare current revision with baseRevision');
assert.match(cloudGs, /orderQMetaByQueueId\(ss, queueId\)/, 'queueId idempotency check is required');
assert.match(cloudGs, /status:\s*'conflict'/, 'server conflict result is required');
assert.match(cloudGs, /sequence[\s\S]*queueId[\s\S]*baseRevision/, 'SYNC_META contract must retain sequence, queueId and baseRevision');

assert.match(adapter, /oneapp_cloud_sync_url_v1/, 'shared cloud URL key must remain the primary URL source');
assert.match(adapter, /merchCloudUrl_v870/, 'legacy cloud URL fallback must remain compatible');
for (const action of ['orderq_sync_push', 'orderq_sync_pull', 'orderq_order_head']) {
  assert.ok(adapter.includes(`'${action}'`), `client adapter missing ${action}`);
}
assert.match(adapter, /Content-Type': 'text\/plain;charset=utf-8'/, 'Apps Script POST should avoid unnecessary CORS preflight');

assert.match(intake, /baseRevision/, 'sync queue must retain baseRevision');
assert.match(intake, /enqueue\(tx, 'CUSTOMER'/, 'new customer must enter sync queue');
assert.match(intake, /enqueue\(tx, 'CUSTOMER_ALIAS'/, 'new customer alias must enter sync queue');
assert.match(intake, /enqueue\(tx, 'ORDER_EVENT'/, 'order events must enter sync queue');
assert.match(intake, /enqueue\(tx, 'ORDER',[\s\S]*expectedRevision\)/, 'order update must queue expected revision as base revision');

assert.match(syncEngine, /class CloudOrderConflictError/);
assert.match(syncEngine, /getCloudOrderHead\(orderId\)/, 'save preflight must query cloud order head');
assert.match(syncEngine, /serverRevision > localRevision/, 'cloud newer revision must block local stale save');
assert.match(syncEngine, /const push = await pushPending\(\);/, 'post-save sync must push related Customer\/Alias\/Event queues too');
assert.match(syncEngine, /status:\s*'DISCARDED'/, 'accepting remote latest must explicitly discard conflicting local queue records');
assert.match(syncEngine, /if \(!getCloudUrl\(\)\) return \{ online: false/, 'local-first operation must remain possible without cloud URL');
assert.match(syncEngine, /row\.status === 'PENDING' && row\.localOnly !== true/, 'local-only M3 queue rows must never be pushed to the existing Cloud contract');
assert.match(syncEngine, /pending: rows\.filter\(row => row\.status === 'PENDING' && row\.localOnly !== true\)\.length/, 'local-only M3 queue rows must not inflate the pending count');

assert.match(indexHtml, /클라우드 동기화/);
assert.match(indexHtml, /syncNow/);
assert.match(cloudHtml, /CUSTOMER_ALIAS_MAPPING/);
assert.match(cloudHtml, /최신본 적용/);
assert.match(inputHtml, /syncBeforeOrderMutation/);
assert.match(inputHtml, /현재 입력내용은 유지됩니다/);
assert.match(inputHtml, /최신본을 적용한 후 주문서를 다시 열어 입력·저장/);

console.log('ORDER Q vNext cloud sync contract tests passed.');
