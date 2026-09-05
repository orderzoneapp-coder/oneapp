import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const importRepo = (path) => import(`${pathToFileURL(join(root, path)).href}?test=${Date.now()}-${Math.random()}`);
const contract = await importRepo('reference-data/change-request-contract.js');
const product = await importRepo('reference-data/product-master-read-adapter.js');

const baseRequest = () => ({
  schemaVersion: 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1',
  requestId: 'REQ-001',
  idempotencyKey: 'IDEM-001',
  domain: 'PRODUCT',
  ownerAppId: 'master-lookup',
  entityId: 'P-001',
  operation: 'UPDATE',
  baseSnapshotId: 'PRODUCT-7-abc',
  baseRevision: 7,
  changes: [{ field: '품목명', beforeValue: '이전', proposedValue: '변경' }],
  reason: '관리자 검토 요청',
  source: { appId: 'test-consumer', workId: 'WORK-1', sourceSnapshotId: 'PRODUCT-7-abc' },
  actor: { actorId: null, actorName: '테스트', actorState: 'UNVERIFIED_LOCAL' },
  requestedAt: '2026-08-30T00:00:00.000Z',
});

assert.equal(contract.referenceChangeRequestContract.schemaVersion, 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1');
assert.equal(contract.validateReferenceChangeRequest(baseRequest()).valid, true);

const missing = baseRequest();
delete missing.requestId;
assert.ok(contract.validateReferenceChangeRequest(missing).errors.some((error) => error.path === 'requestId'));

const ownerMismatch = { ...baseRequest(), ownerAppId: 'customer-master' };
assert.ok(contract.validateReferenceChangeRequest(ownerMismatch).errors.some((error) => error.code === 'DOMAIN_OWNER_MISMATCH'));

for (const operation of ['UPDATE', 'STATUS_CHANGE', 'MAPPING_CHANGE']) {
  const noBase = { ...baseRequest(), operation, baseSnapshotId: '', baseRevision: '' };
  const errors = contract.validateReferenceChangeRequest(noBase).errors.map((error) => error.code);
  assert.ok(errors.includes('BASE_SNAPSHOT_REQUIRED'), `${operation} requires baseSnapshotId`);
  assert.ok(errors.includes('BASE_REVISION_REQUIRED'), `${operation} requires baseRevision`);
}

assert.ok(contract.validateReferenceChangeRequest({ ...baseRequest(), changes: [] }).errors.some((error) => error.code === 'CHANGES_REQUIRED'));
assert.ok(contract.validateReferenceChangeRequest({
  ...baseRequest(),
  changes: [
    { field: '품목명', beforeValue: '', proposedValue: 'A' },
    { field: '품목명', beforeValue: 'A', proposedValue: 'B' },
  ],
}).errors.some((error) => error.code === 'DUPLICATE_CHANGE_FIELD'));

for (const sensitive of [
  { changes: [{ field: 'password', beforeValue: null, proposedValue: 'secret' }] },
  { source: { appId: 'test-consumer', accessToken: 'secret' } },
  { reason: '주민번호 900101-1234567 포함' },
  { reason: '-----BEGIN PRIVATE KEY-----' },
]) {
  const candidate = { ...baseRequest(), ...sensitive };
  assert.equal(contract.validateReferenceChangeRequest(candidate).valid, false, 'sensitive content must be rejected');
}
assert.equal(contract.validateReferenceChangeRequest({ ...baseRequest(), requestedAt: 'August 30, 2026' }).valid, false, 'non-ISO timestamp must fail');

const recordProduct = { 코드: 'P-002', 품목명: 'Store 우선', 규격: '', 재고: 0, unknownField: '보존' };
const snapshotA = await product.buildProductSnapshot({
  recordRows: [recordProduct],
  storeSnapshot: { 'P-001': { 코드: 'P-001', 품목명: 'Snapshot fallback' } },
  localSnapshot: { 'P-003': { 코드: 'P-003', 품목명: 'Local fallback' } },
  revision: 17,
}, { now: '2026-08-30T01:00:00.000Z' });
const snapshotB = await product.buildProductSnapshot({
  recordRows: [recordProduct],
  storeSnapshot: null,
  localSnapshot: null,
  revision: 17,
}, { now: '2026-08-30T02:00:00.000Z' });

assert.equal(snapshotA.status, 'READY');
assert.equal(snapshotA.source, 'INDEXEDDB_RECORD_STORE');
assert.equal(snapshotA.schemaVersion, 'ONEAPP_PRODUCT_SNAPSHOT_V1');
assert.equal(snapshotA.adapterVersion, 'ONEAPP_PRODUCT_READ_ADAPTER_V1');
assert.equal(snapshotA.ownerAppId, 'master-lookup');
assert.equal(snapshotA.contentHash, snapshotB.contentHash, 'same revision/data must have a deterministic hash');
assert.equal(snapshotA.snapshotId, snapshotB.snapshotId, 'same revision/data must have a deterministic snapshot id');
assert.equal(snapshotA.data.products[0].규격, '', 'blank values must be preserved');
assert.equal(snapshotA.data.products[0].재고, 0, 'numeric zero must be preserved');
assert.equal(snapshotA.data.products[0].unknownField, '보존', 'unknown source fields must be preserved');
assert.ok(Object.isFrozen(snapshotA) && Object.isFrozen(snapshotA.data) && Object.isFrozen(snapshotA.data.products) && Object.isFrozen(snapshotA.data.products[0]));
assert.throws(() => { snapshotA.data.products[0].품목명 = '변조'; }, TypeError);

const fallbackOne = await product.buildProductSnapshot({
  recordRows: [],
  storeSnapshot: { B: { 코드: 'B', 품목명: 'B' }, A: { 코드: 'A', 품목명: 'A' } },
  localSnapshot: { C: { 코드: 'C', 품목명: 'C' } },
  revision: 'rev-1',
});
const fallbackTwo = await product.buildProductSnapshot({
  recordRows: [],
  storeSnapshot: { A: { 품목명: 'A', 코드: 'A' }, B: { 품목명: 'B', 코드: 'B' } },
  revision: 'rev-1',
});
assert.equal(fallbackOne.source, 'INDEXEDDB_SNAPSHOT_KEY');
assert.equal(fallbackOne.contentHash, fallbackTwo.contentHash, 'object insertion order must not change the hash');
assert.deepEqual(fallbackOne.data.products.map((row) => row.코드), ['A', 'B']);

const localFallback = await product.buildProductSnapshot({ recordRows: [], storeSnapshot: {}, localSnapshot: [{ 코드: 'L', 품목명: 'Local' }] });
assert.equal(localFallback.source, 'LOCAL_STORAGE_SNAPSHOT_KEY');
const empty = await product.buildProductSnapshot({ recordRows: [], storeSnapshot: {}, localSnapshot: null });
assert.equal(empty.status, 'EMPTY');
assert.equal(empty.data.products.length, 0);

const matches = product.searchProductSnapshot(snapshotA, 'P-002');
assert.equal(matches.length, 1);
assert.equal(matches[0].품목명, 'Store 우선');
assert.ok(Object.isFrozen(matches) && Object.isFrozen(matches[0]));
assert.throws(() => product.searchProductSnapshot(null, 'P-002'), /PRODUCT_SNAPSHOT_REQUIRED/);

const manifest = JSON.parse(await readFile(join(root, 'app-manifest.json'), 'utf8'));
const productContract = manifest.sharedDataContracts.find((entry) => entry.id === 'product-master');
const customerContract = manifest.sharedDataContracts.find((entry) => entry.id === 'customer-master');
const productRequestContract = manifest.sharedDataContracts.find((entry) => entry.id === 'product-reference-change-request');
const customerRequestContract = manifest.sharedDataContracts.find((entry) => entry.id === 'customer-reference-change-request');
assert.equal(productContract.owner, 'master-lookup');
assert.equal(productContract.schemaVersion, 'ONEAPP_PRODUCT_SNAPSHOT_V1');
assert.equal(productContract.readAdapter, 'ONEAPP_PRODUCT_MASTER_READ_ADAPTER');
assert.equal(customerContract.owner, 'customer-master');
assert.equal(customerContract.schemaVersion, 'ONEAPP_CUSTOMER_SNAPSHOT_V1');
assert.equal(productRequestContract.schemaVersion, 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1');
assert.equal(customerRequestContract.schemaVersion, 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1');
assert.equal(productRequestContract.resources.inboxKey, 'oneappProductReferenceChangeRequests_v1');
assert.equal(customerRequestContract.resources.inboxKey, 'referenceChangeRequestsV1');

const allowedWriterFiles = new Set(productContract.legacyWriterAllowlist);
assert.deepEqual([...allowedWriterFiles].sort(), [
  'Master.html', 'coreEngine.js',
  'masterAddUpdate.js',
].sort());
assert.equal(productContract.stopCommandException.asset, 'smartparser/stop-management-command-adapter.js');
assert.equal(productContract.readAdapterVersion, 'ONEAPP_PRODUCT_MASTER_READ_ADAPTER_V1');
assert.equal(productContract.commandAdapter, 'ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1');
assert.equal(productContract.commandSchemaVersion, 'MERCHOPS_REVIEWED_WORK_APPLY_V1');
assert.equal(productContract.registrationCommandSchemaVersion, 'MERCHOPS_PRODUCT_REGISTRATION_V1');
assert.deepEqual(productContract.registrationAllowedFields, [
  '코드', '품목코드', '품목명', '규격', '단위', '입고가', '구매처', '창고', '기본', '과세',
]);
assert.equal(productRequestContract.consumers.includes('merchops'), false,
  'MerchOps explicit product registration must not be modeled as a PENDING inbox request');
assert.equal(productContract.resources.commandAdapterAsset, 'reference-data/product-master-command-adapter.js');

async function sourceFiles(directory = root) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'archive', 'scripts', 'work', 'outputs'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await sourceFiles(path));
    else if (['.js', '.html'].includes(extname(entry.name))) rows.push(path);
  }
  return rows;
}

const detectedWriters = [];
for (const path of await sourceFiles()) {
  const source = await readFile(path, 'utf8');
  if (/commitMasterStateOrThrow|replaceMasterState\s*=|master_products[^\n]{0,160}readwrite/.test(source)) {
    detectedWriters.push(relative(root, path).replaceAll('\\', '/'));
  }
}
for (const path of detectedWriters) {
  if (path === productContract.stopCommandException.asset) {
    const stopSource = await readFile(join(root, path), 'utf8');
    assert.match(stopSource, /ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_V1/);
    assert.match(stopSource, /commitMasterStateOrThrow/);
    continue;
  }
  if (path === 'MerchOps.html') {
    const merchOpsSource = await readFile(join(root, path), 'utf8');
    const businessSource = merchOpsSource.slice(merchOpsSource.indexOf('const useMerchConfig ='));
    assert.doesNotMatch(
      businessSource,
      /commitMasterStateOrThrow|replaceMasterState\s*=|master_products[^\n]{0,160}readwrite/,
      'MerchOps business workflows must not retain a direct product writer',
    );
    continue;
  }
  if (path === 'settings.html') {
    const settingsSource = await readFile(join(root, path), 'utf8');
    assert.match(settingsSource, /OWNER_ROUTED: 상품 원본 작업은 상품관리에서 실행하세요/);
    assert.doesNotMatch(
      settingsSource.slice(settingsSource.indexOf('const getSettingsOwnerAdapter')),
      /\.commitMasterStateOrThrow\s*\(|\.replaceMasterState\s*\(|master_products[^\n]{0,160}readwrite/,
      'Settings business workflows must not retain a direct product writer',
    );
    continue;
  }
  assert.ok(allowedWriterFiles.has(path), `new cross-app product writer is not allowlisted: ${path}`);
}
assert.equal(detectedWriters.some((path) => path.startsWith('smartinput/')), false, 'SmartInput consumer/UI must remain outside this change');
assert.equal(detectedWriters.includes('SmartParser.html'), false, 'SmartParser page must not retain a raw product writer');

console.log('PASS NEXUS product/customer reference-data contract');
