import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readInputMatchingSnapshot } from '../orderq/input-matching-read-adapter.js';
import { loadLocalInputMatchingSnapshot, refreshInputMatchingSnapshot, validateInputMatchingSnapshot, inputContextFromMatchingSnapshot, inputMatchingAnalysisRevision, canReuseInputAnalysis } from '../smartinput/reference-refresh-controller.js';
import { generateInputProductCandidates, analyzeSingleOrderDocument } from '../smartinput/input.js';
import { matchParsedLine } from '../orderq/smartparser/matching-engine.js';
import { createProductMatchIndex, classifyProductMatch } from '../smartinput/reference-refresh-controller.js';

const scope = { companyId: 'ONEAPP', actorId: 'A1' };
const records = {
  products: [{ productId: 'P1', itemCode: '001', itemName: '수입바나나', specification: '13kg', unit: 'BOX' },
    { companyId: 'OTHER', productId: 'P2', itemCode: '002', itemName: '타회사품목' }],
  productMappings: [
    { mappingId: 'M1', customerId: 'C1', rawText: '노란거', productId: 'P1' },
    { mappingId: 'M2', sourceId: 'SMART_INPUT', rawText: '원본별', productId: 'P1' },
    { mappingId: 'M3', rawText: '공통별칭', productId: 'P1' },
    { mappingId: 'M4', rawText: '제외별칭', productId: 'P1', status: 'INACTIVE' },
    { mappingId: 'M5', companyId: 'OTHER', rawText: '타회사', productId: 'P2' }
  ],
  orders: [{ orderId: 'O1', customerId: 'C1', orderStatus: 'FULL_CANCEL' }, { orderId: 'O2', companyId: 'OTHER', customerId: 'C1' }],
  orderItems: [{ orderItemId: 'I1', orderId: 'O1', productId: 'P1', itemCode: '001', itemName: '지난바나나', finalUnit: 'BOX', quantity: 999, price: 123, rawText: 'private message' },
    { orderItemId: 'I2', orderId: 'O2', productId: 'P2', itemName: '다른회사' },
    { orderItemId: 'I3', orderId: 'O1', companyId: 'OTHER', productId: 'P2', itemName: '잘못된회사행' }]
};
const owner = () => readInputMatchingSnapshot(scope, { readRecords: async () => ({ records, sourceVersion: 7 }) });
const response = await owner();
assert.equal(response.status, 'READY');
const snapshot = await validateInputMatchingSnapshot(response.snapshot, scope);
assert.deepEqual(snapshot.counts, { products: 1, mappings: 4, history: 1 });
assert.equal(snapshot.history[0].customerId, 'C1');
assert.equal(snapshot.history[0].orderItemId, 'I1', 'the existing scorer did not filter cancelled order history');
assert.equal(snapshot.history[0].quantity, undefined);
assert.equal(snapshot.history[0].rawText, undefined, 'matching snapshot excludes message text, quantities and prices');
assert.equal(Object.isFrozen(snapshot.mappings[0]), true);
const other = await readInputMatchingSnapshot({ companyId: 'OTHER', actorId: 'A1' }, { readRecords: async () => ({ records, sourceVersion: 7 }) });
assert.deepEqual(other.snapshot.counts, { products: 1, mappings: 1, history: 1 });
assert.equal(other.snapshot.history[0].orderId, 'O2');
assert.ok(!other.snapshot.mappings.some(row => row.mappingId === 'M1'), 'legacy unscoped mappings belong only to ONEAPP');
const empty = await readInputMatchingSnapshot({ companyId: 'ABSENT', actorId: 'A1' }, { readRecords: async () => ({ records, sourceVersion: 7 }) });
assert.equal(empty.status, 'EMPTY');
for (const broken of [
  copy => { copy.actorId = 'OTHER'; }, copy => { copy.companyId = 'OTHER'; },
  copy => { copy.mappings[0].rawText = 'corrupt'; }, copy => { copy.history.pop(); }
]) {
  const copy = structuredClone(snapshot); broken(copy);
  await assert.rejects(validateInputMatchingSnapshot(copy, scope));
}

// Exercise the actual owner opener: existing schema, exactly one readonly
// transaction, four reads, no version upgrade, and no database on a missing profile.
const previousIDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const previousFetch = globalThis.fetch;
const calls = []; let closed = false;
globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
  open(...args) {
    calls.push(['open', ...args]);
    const request = {};
    queueMicrotask(() => {
      request.result = {
        version: 7, objectStoreNames: { contains: name => Object.hasOwn(records, name) },
        close: () => { closed = true; },
        transaction(stores, mode) {
          calls.push(['transaction', [...stores], mode]); let completed = 0;
          const tx = { objectStore(name) { return { getAll() {
            calls.push(['read', name]); const get = {};
            queueMicrotask(() => { get.result = structuredClone(records[name]); get.onsuccess(); if (++completed === stores.length) tx.oncomplete(); });
            return get;
          } }; } };
          return tx;
        }
      };
      request.onsuccess();
    });
    return request;
  }
} });
assert.equal((await readInputMatchingSnapshot(scope)).status, 'READY');
assert.deepEqual(calls[0], ['open', 'oneapp-orderq-pre-m1-v6']);
assert.deepEqual(calls[1], ['transaction', ['products', 'productMappings', 'orders', 'orderItems'], 'readonly']);
assert.equal(calls.filter(call => call[0] === 'read').length, 4); assert.equal(closed, true);
let aborted = false;
globalThis.indexedDB.open = () => {
  const request = { error: { name: 'AbortError' }, transaction: { abort() { aborted = true; queueMicrotask(() => request.onerror()); } } };
  queueMicrotask(() => request.onupgradeneeded()); return request;
};
const absent = await readInputMatchingSnapshot(scope);
assert.equal(absent.status, 'EMPTY'); assert.equal(aborted, true); assert.equal(absent.snapshot.sourceVersion, null);
globalThis.indexedDB.open = () => { throw new Error('DENIED'); };
assert.equal((await readInputMatchingSnapshot(scope)).status, 'ERROR', 'read failure must not become EMPTY');

let cachedValue = null, writes = 0;
const loadValue = async () => cachedValue;
const saveValue = async (_key, value) => { writes++; cachedValue = structuredClone(value); };
assert.equal((await loadLocalInputMatchingSnapshot(scope, { loadValue })).status, 'NOT_PREPARED');
assert.equal(writes, 0, 'first entry never fabricates a snapshot or consults owner data');
const refreshed = await refreshInputMatchingSnapshot(scope, { readOwner: owner, saveValue });
assert.equal(refreshed.status, 'READY'); assert.equal(writes, 1);
assert.equal((await loadLocalInputMatchingSnapshot(scope, { loadValue })).snapshot.contentHash, snapshot.contentHash);
const retained = structuredClone(cachedValue);
assert.equal((await refreshInputMatchingSnapshot(scope, { readOwner: async () => ({ status: 'ERROR', error: { message: 'owner down' } }), saveValue })).status, 'ERROR');
assert.deepEqual(cachedValue, retained);
assert.equal((await refreshInputMatchingSnapshot(scope, { readOwner: owner, saveValue: async () => { throw new Error('QUOTA'); } })).status, 'ERROR');
assert.deepEqual(cachedValue, retained);
assert.equal((await loadLocalInputMatchingSnapshot({ ...scope, actorId: 'A2' }, { loadValue })).status, 'ERROR');
let current = true;
assert.equal((await refreshInputMatchingSnapshot(scope, { readOwner: async () => { current = false; return response; }, saveValue, isCurrent: () => current })).status, 'STALE');
assert.equal(writes, 1, 'company/actor changes prevent persistence');
let releaseOld;
const old = refreshInputMatchingSnapshot(scope, { readOwner: () => new Promise(resolve => { releaseOld = resolve; }), saveValue });
const latest = await refreshInputMatchingSnapshot(scope, { readOwner: owner, saveValue });
releaseOld(response);
assert.equal(latest.status, 'READY'); assert.equal((await old).status, 'STALE'); assert.equal(writes, 2);

// Local input continues with supplied snapshots while both owner DB and network
// are unavailable; candidate scores/order and final displayed rows retain rules.
const context = inputContextFromMatchingSnapshot(snapshot, { ...scope, products: [] });
const baselineCode = fs.readFileSync(new URL('../orderq/smartparser/candidate-generator.js', import.meta.url), 'utf8').replace(/^import[^\n]*\r?\n/, '');
const baselineData = { products: records.products.filter(row => !row.companyId), mappings: records.productMappings.filter(row => !row.companyId),
  orders: records.orders.filter(row => !row.companyId), items: records.orderItems.filter(row => !row.companyId && row.orderId === 'O1') };
const prelude = `const data=${JSON.stringify(baselineData)};const STORE={PRODUCTS:'products',PRODUCT_MAPPINGS:'mappings',ORDERS:'orders',ORDER_ITEMS:'items'};const getAll=async key=>data[key];const normalizeText=value=>String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\\s+/g,'').replace(/[\\u200b-\\u200d\\ufeff]/g,'');`;
const baseline = await import('data:text/javascript;base64,' + Buffer.from(prelude + baselineCode).toString('base64'));
for (const productText of ['노란거', '원본별', '공통별칭', '제외별칭', '지난바나나', '수입바나나']) {
  const query = { productText, customerId: 'C1', sourceId: 'SMART_INPUT' };
  assert.deepEqual(generateInputProductCandidates(query, context), await baseline.generateProductCandidates(query));
}
const analyzed = await analyzeSingleOrderDocument({ rawText: '[테스트] [오전 9:00] 노란거 2개', session: { sourceType: 'KAKAO_TEXT' },
  customerOverride: { customerId: 'C1', customerName: '테스트' }, matchingContext: context });
const baselineMatched = matchParsedLine({ productText: '노란거', quantity: 2, rawUnit: '개' },
  await baseline.generateProductCandidates({ productText: '노란거', customerId: 'C1', sourceId: 'SMART_INPUT' }));
for (const key of ['itemCode', 'itemName', 'productId', 'specification', 'finalUnit']) assert.equal(analyzed.lines[0][key], baselineMatched[key]);
assert.equal(analyzed.lines[0].quantity, 2); assert.equal(analyzed.lines[0].unit, '개');
const mainSource = fs.readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const functionSource = name => mainSource.match(new RegExp(`(?:^|\\n)function ${name}\\([^\\n]*\\)[\\s\\S]*?\\n}`, 'm'))?.[0];
const fallback = { ...scope, products: [], revision: 'PRODUCT-R1' };
const unpreparedRevision = inputMatchingAnalysisRevision(null, fallback);
const preparedRevision = inputMatchingAnalysisRevision(snapshot, fallback);
assert.notEqual(preparedRevision, unpreparedRevision);
assert.equal(inputMatchingAnalysisRevision({ ...snapshot, readAt: new Date().toISOString() }, fallback), preparedRevision,
  'a repeated refresh with unchanged content must not trigger reanalysis');
assert.equal(inputMatchingAnalysisRevision(snapshot, { ...fallback, actorId: 'OTHER' }),
  inputMatchingAnalysisRevision(null, { ...fallback, actorId: 'OTHER' }), 'another actor snapshot must not become a prepared revision');
const contractScope = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8'), contractScope);
const contract = contractScope.SMART_INPUT_CONTRACT;
const beforePreparation = contract.createBatch({ rawText: '노란거 2개', contentHash: 'UNCHANGED-SOURCE',
  sourceRole: 'LIVE_SOURCE', inputMatchingRevision: unpreparedRevision });
const recoveredBatch = contract.normalizeModeDraft('order', { batches: [beforePreparation] }).batches[0];
assert.equal(recoveredBatch.inputMatchingRevision, unpreparedRevision, 'normalization/recovery retains matching metadata');
assert.equal(recoveredBatch.contentHash, 'UNCHANGED-SOURCE', 'matching metadata never replaces original content hash');
const reuseOptions = { contentHash: recoveredBatch.contentHash, matchingRevision: preparedRevision };
assert.equal(canReuseInputAnalysis(recoveredBatch, { ...reuseOptions, automatic: true }), true,
  'snapshot arrival must not automatically replace existing rows');
assert.equal(canReuseInputAnalysis(recoveredBatch, reuseOptions), false, 'same source explicitly reanalyzes after preparation');
assert.equal(canReuseInputAnalysis({ ...recoveredBatch, inputMatchingRevision: preparedRevision }, reuseOptions), true);
assert.equal(canReuseInputAnalysis(recoveredBatch, { ...reuseOptions, contentHash: 'CHANGED', automatic: true }), false);
const nodes = Object.fromEntries(['inputMatchingStatus', 'inputMatchingSummary', 'inputMatchingNotice']
  .map(id => [id, { hidden: false, textContent: '', dataset: {} }]));
const matchingUiState = { ...scope, inputMatching: { status: 'LOADING', snapshot: null },
  draft: { activeMode: 'order' }, references: { product: { active: { revision: fallback.revision } } } };
const displayedBatch = { ...recoveredBatch };
const noticeContext = vm.createContext({ state: matchingUiState, $: id => nodes[id], referenceTimeText: value => value,
  modeDraft: () => ({ batches: [displayedBatch] }), inputMatchingAnalysisRevision });
vm.runInContext(functionSource('renderInputMatchingStatus'), noticeContext);
noticeContext.renderInputMatchingStatus();
assert.equal(nodes.inputMatchingNotice.hidden, false);
matchingUiState.inputMatching = { status: 'READY', snapshot };
noticeContext.renderInputMatchingStatus();
assert.equal(nodes.inputMatchingNotice.hidden, false, 'preparation must not hide the warning for already analyzed unprepared rows');
assert.match(nodes.inputMatchingNotice.textContent, /같은 원문의 분석 버튼/);
displayedBatch.inputMatchingRevision = preparedRevision;
noticeContext.renderInputMatchingStatus();
assert.equal(nodes.inputMatchingNotice.hidden, true, 'explicit analysis clears the pending revision notice');
const referenceContext = vm.createContext({ state: { productMatchIndex: createProductMatchIndex([{
  productId: 'P1', masterProductId: 'MASTER1', itemCode: '001', itemName: '수입바나나', specification: '13kg', finalUnit: 'BOX'
}]), references: { product: { active: {} } } }, classifyProductMatch,
  applyProduct: () => { throw new Error('raw alias must not auto-confirm in the final catalog pass'); } });
vm.runInContext(functionSource('referenceQueryForRow') + functionSource('enrichRowFromUnifiedCatalog'), referenceContext);
const enriched = referenceContext.enrichRowFromUnifiedCatalog({ ...analyzed.lines[0], productText: '노란거', masterProductId: '' });
assert.deepEqual([enriched.productId, enriched.masterProductId, enriched.itemCode, enriched.itemName, enriched.specification, enriched.quantity, enriched.unit],
  ['', '', '001', '수입바나나', '13kg', 2, '개'], 'reported final-row alias regression must retain code/name/specification and source quantity/unit');
assert.match(mainSource, /loadLocalInputMatchingSnapshot\(\{ companyId, actorId \}/);
assert.match(mainSource, /refreshInputMatchingSnapshot\(\{ companyId, actorId \}/);
assert.ok(fs.readFileSync(new URL('../smartinput/index.html', import.meta.url), 'utf8').includes('id="inputMatchingNotice"'));
if (previousIDB) Object.defineProperty(globalThis, 'indexedDB', previousIDB); else delete globalThis.indexedDB;
globalThis.fetch = previousFetch;
console.log('Input matching snapshots: readonly owner publication, cache-only entry, scope/hash/error/stale guards, and preserved alias/history/final-row values passed.');
