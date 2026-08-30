#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const importRepo = path => import(`${pathToFileURL(join(root, path)).href}?test=${Date.now()}-${Math.random()}`);
const controller = await importRepo('smartinput/reference-data-controller.js');
const changeContract = await importRepo('reference-data/change-request-contract.js');

const products = [
  { productId: 'P-001', masterProductId: 'P-001', itemCode: 'A-001', itemName: '청사과', secondaryName: '풋사과', approvedAliases: ['그린애플'], specification: '10kg', status: 'ACTIVE' },
  { productId: 'P-002', masterProductId: 'P-002', itemCode: 'A-002', itemName: '청사과 주스', secondaryName: '', approvedAliases: ['애플주스'], specification: '1L', status: 'ACTIVE' },
  { productId: 'P-003', masterProductId: 'P-003', itemCode: 'B-001', itemName: '홍사과', secondaryName: '빨간사과', approvedAliases: ['레드애플'], specification: '5kg', status: 'ACTIVE' },
];
const index = controller.createProductMatchIndex(products);

assert.deepEqual(controller.classifyProductMatch(index, 'A-001'), {
  kind: 'EXACT_CODE', autoConfirm: true, candidates: [products[0]], product: products[0],
}, 'exact code must auto-confirm');
assert.equal(controller.classifyProductMatch(index, '풋사과').kind, 'UNIQUE_EXACT_TEXT');
assert.equal(controller.classifyProductMatch(index, '그린애플').autoConfirm, true, 'unique approved alias must auto-confirm');
const singleFuzzy = controller.classifyProductMatch(index, '홍사');
assert.equal(singleFuzzy.kind, 'FUZZY');
assert.equal(singleFuzzy.candidates.length, 1);
assert.equal(singleFuzzy.autoConfirm, false, 'a single fuzzy result must never auto-confirm');
assert.ok(controller.classifyProductMatch(index, '사과').candidates.length > 1, 'multiple fuzzy matches must expose selection candidates');
assert.deepEqual(controller.classifyProductMatch(index, '존재하지않는상품'), { kind: 'MISSING', autoConfirm: false, candidates: [] });

const snapshot = ({ domain = 'product', rows = [], revision = 1, status = rows.length ? 'READY' : 'EMPTY' } = {}) => ({
  schemaVersion: domain === 'product' ? 'ONEAPP_PRODUCT_SNAPSHOT_V1' : 'ONEAPP_CUSTOMER_SNAPSHOT_V1',
  adapterVersion: 'TEST_ADAPTER_V1',
  status,
  snapshotId: `${domain.toUpperCase()}-${revision}`,
  snapshotVersion: revision,
  snapshotCreatedAt: '2026-08-30T00:00:00.000Z',
  contentHash: `HASH-${revision}`,
  source: 'TEST_OWNER_SNAPSHOT',
  data: domain === 'product' ? { products: rows } : { customers: rows },
});
const adapterLoader = result => async domain => ({
  [domain === 'product' ? 'productMasterReadAdapter' : 'customerReadAdapter']: {
    getSnapshotResult: async () => result,
  },
});

const empty = await controller.loadReferenceDomain('product', {
  adapterLoader: adapterLoader({ status: 'EMPTY', snapshot: snapshot({ rows: [], status: 'EMPTY' }) }),
  allowFallback: false,
  now: '2026-08-30T01:00:00.000Z',
});
assert.equal(empty.status, 'EMPTY');
assert.equal(empty.count, 0, 'confirmed EMPTY must remain distinct from failure');

const error = await controller.loadReferenceDomain('product', {
  adapterLoader: async () => { throw new Error('ADAPTER_DOWN'); },
  fallbackLoader: async () => { throw new Error('FALLBACK_DOWN'); },
  now: '2026-08-30T01:00:00.000Z',
});
assert.equal(error.status, 'ERROR');
assert.equal(error.count, null, 'load failure must not masquerade as zero rows');

const fallbackReference = {
  ...empty,
  status: 'READY',
  rows: products,
  count: products.length,
  fallback: true,
  source: 'FALLBACK_DIRECT:INDEXEDDB_RECORD_STORE',
};
const fallback = await controller.loadReferenceDomain('product', {
  adapterLoader: async () => { throw new Error('ADAPTER_DOWN'); },
  fallbackLoader: async () => fallbackReference,
});
assert.equal(fallback.status, 'READY');
assert.equal(fallback.fallback, true);
assert.match(controller.referenceSourceLabel(fallback), /직접 읽기 fallback/);
assert.equal(fallback.adapterError.code, 'ADAPTER_DOWN');

const current = { ...fallbackReference, snapshotId: 'PRODUCT-1', revision: 1, rows: products.slice(0, 2), count: 2 };
const next = { ...fallbackReference, snapshotId: 'PRODUCT-2', revision: 2, rows: [products[0], { ...products[1], itemName: '청사과 착즙주스' }, products[2]], count: 3 };
assert.equal(controller.sameReferenceRevision(current, next), false);
assert.deepEqual(controller.diffReferenceSnapshots('product', current, next), {
  domain: 'product', fromRevision: 1, toRevision: 2, fromCount: 2, toCount: 3, added: 1, removed: 0, changed: 1,
}, 'stale revision diff must report added/removed/changed rows');

assert.equal(controller.ownerAppHref('product'), '../Master.html');
assert.equal(controller.ownerAppHref('customer'), '../customer-master/index.html');
const productRequest = controller.buildRegistrationChangeRequest('product', {
  itemCode: 'NEW-1', itemName: '미등록 상품', specification: '2kg', unit: 'BOX',
}, { documentId: 'DOC-1', rowId: 'ROW-1', requestedAt: '2026-08-30T02:00:00.000Z' });
assert.equal(changeContract.validateReferenceChangeRequest(productRequest).valid, true, 'owner-app round-trip request must satisfy the public contract');
let submittedRequest = null;
const receipt = await controller.submitRegistrationChangeRequest('product', productRequest, {
  adapterLoader: async () => ({ productMasterChangeRequestAdapter: { submitChangeRequest: async request => { submittedRequest = request; return { accepted: true, status: 'PENDING' }; } } }),
});
assert.equal(receipt.status, 'PENDING');
assert.equal(submittedRequest.ownerAppId, 'master-lookup');
const customerRequest = controller.buildRegistrationChangeRequest('customer', {
  customerCode: 'NEW-C', customerName: '미등록 거래처', address: '서울', phone: '02-0000-0000',
}, { documentId: 'DOC-1', requestedAt: '2026-08-30T02:00:00.000Z' });
assert.equal(changeContract.validateReferenceChangeRequest(customerRequest).valid, true);
assert.equal(customerRequest.ownerAppId, 'customer-master');
const customerReceipt = await controller.submitRegistrationChangeRequest('customer', customerRequest, {
  adapterLoader: async () => ({ customerMasterChangeRequestAdapter: { submitChangeRequest: async () => ({ accepted: true, status: 'PENDING' }) } }),
});
assert.equal(customerReceipt.status, 'PENDING');

const largeProducts = Array.from({ length: 25_000 }, (_, position) => ({
  productId: `L-${position}`, masterProductId: `L-${position}`, itemCode: `L${String(position).padStart(6, '0')}`,
  itemName: `대량상품${String(position).padStart(6, '0')}`, secondaryName: `별칭${position}`, status: 'ACTIVE',
}));
const performanceStarted = performance.now();
const largeIndex = controller.createProductMatchIndex(largeProducts);
for (let position = 0; position < 120; position += 1) {
  const result = controller.classifyProductMatch(largeIndex, `L${String(position * 137).padStart(6, '0')}`);
  assert.equal(result.autoConfirm, true);
}
const performanceElapsed = performance.now() - performanceStarted;
assert.ok(performanceElapsed < 2500, `25k snapshot indexing + 120 exact searches took ${performanceElapsed.toFixed(1)}ms`);

const [smartInputSource, dataStoreSource, controllerSource, html] = await Promise.all([
  readFile(join(root, 'smartinput/smartinput.js'), 'utf8'),
  readFile(join(root, 'smartinput/smartinput-data-store.js'), 'utf8'),
  readFile(join(root, 'smartinput/reference-data-controller.js'), 'utf8'),
  readFile(join(root, 'smartinput/index.html'), 'utf8'),
]);
assert.doesNotMatch(smartInputSource, /orderq\/product-master-search|loadProductCatalog|searchProductCatalog/, 'SmartInput must not treat ORDER Q history as the product master');
assert.match(controllerSource, /transaction\(stores, 'readonly'\)/);
assert.doesNotMatch(controllerSource, /transaction\([^\n]+['"]readwrite['"]/, 'direct fallback may only read owner stores');
assert.match(dataStoreSource, /const DB_VERSION\s*=\s*3/, 'SmartInput DB v3 must remain unchanged');
assert.match(dataStoreSource, /reference:product/);
assert.match(dataStoreSource, /reference:customer/);
assert.doesNotMatch(smartInputSource, /Alt\+1|altKey[^\n]+Digit[1-4]/i);
assert.match(smartInputSource, /editedFields/);
assert.match(smartInputSource, /state\.selectedRowIds/);
assert.match(smartInputSource, /diffReferenceSnapshots/);
assert.match(smartInputSource, /FUZZY_CONFIRMATION_REQUIRED/);
assert.match(smartInputSource, /referenceResolution = state\.references\.product\.active \? 'MISSING' : 'REFERENCE_ERROR'/);
const scopedReload = smartInputSource.slice(smartInputSource.indexOf('async function reloadReferenceDomain'), smartInputSource.indexOf('function appendDeliveryHistory'));
assert.doesNotMatch(scopedReload, /renderMode\(/, 'scoped reload must not trigger a full workspace render');
assert.match(html, /id="productReferenceReload"/);
assert.match(html, /id="customerReferenceReload"/);
assert.match(html, /id="referencePendingApply"/);
assert.match(html, /거래처관리에서 등록/);
assert.doesNotMatch(html, /ItemMaster\.html/, 'deprecated compatibility page must not be presented as the product owner');
assert.equal((smartInputSource.match(/productReferenceReload'\)\.addEventListener/g) || []).length, 1, 'product scoped reload event must bind once');
assert.equal((smartInputSource.match(/customerReferenceReload'\)\.addEventListener/g) || []).length, 1, 'customer scoped reload event must bind once');

console.log(`SmartInput reference-data UX contract PASS · large snapshot ${performanceElapsed.toFixed(1)}ms`);
