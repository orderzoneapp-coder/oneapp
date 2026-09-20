#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  extractOrderProductLines,
  rematchExtractedLinesForCustomer,
  createInputMatchingContext,
  generateInputProductCandidates,
  hasEnteredValue,
  rowHasMeaningfulInput,
  rowHasLinkedSource,
  compactRowBlankValues,
  pruneEmptyWorkRows,
  manualLinkedRows
} from '../smartinput/input.js';
import { extractOrderProductLines as baselineExtract } from '../orderq/smartparser/order-text-extractor.js?v=0.8.1';

const fixtures = [
  { sourceType: 'GENERAL_TEXT', sourceId: 'LOCAL', rawText: '사과 0개\n배 -2.5박스\n감자 3kg' },
  { sourceType: 'KAKAO_TEXT', sourceId: 'LOCAL', rawText: '[거래처] [오후 1:00] 사과 좋은 거 2박스\n2번 감자 3개\n[거래처] [오후 1:01] 주문 취소\n[거래처] [오후 1:02] 단가 3000원' },
  { sourceType: 'KAKAO_TEXT', sourceId: 'LOCAL', rawText: '[거래처] [오전 9:00] 1. 청경채 10개입 2봉\n감자 -1.25kg\n[거래처] [오전 9:01] 네\n[거래처] [오전 9:02] 3시까지 주문 부탁드립니다' },
  { sourceType: 'GENERAL_TEXT', sourceId: 'LOCAL', rawText: '\u200b사과 ２개\r\n\r\n배 1BOX\n감사합니다' },
  { sourceType: 'KAKAO_TEXT', sourceId: 'LOCAL', rawText: '[테스트] [오후 2:00] 사과 수량 변경 3개\n[테스트] [오후 2:01] 2번' }
];
for (const fixture of fixtures) {
  assert.deepEqual(extractOrderProductLines(fixture), baselineExtract(fixture),
    'owned parser must preserve message keys, grouping, cancellation, context, attributes, units and quantities');
}

const products = [
  { productId: 'P1', itemCode: '001', itemName: '사과', specification: '10kg', finalUnit: 'BOX' },
  { productId: 'P2', itemCode: '002', itemName: '배', specification: '5kg', finalUnit: 'EA' },
  { productId: 'P3', itemCode: '003', itemName: '감자', specification: '1kg', finalUnit: 'kg' },
  { productId: 'P4', itemCode: '004', itemName: '사과', specification: '5kg', finalUnit: 'EA' }
];
const mappings = [
  { productId: 'P1', rawText: '고객별 사과', customerId: 'C1', finalUnit: 'BOX' },
  { productId: 'P2', rawText: '원본별 배', sourceId: 'LOCAL' },
  { productId: 'P3', rawText: '공통 감자' },
  { productId: 'P2', rawText: '고객별 사과', status: 'INACTIVE' }
];
const history = [
  { orderId: 'O1', customerId: 'C1', productId: 'P3', itemCode: '003', itemName: '지난 감자', finalUnit: 'kg' }
];
const snapshot = { products, mappings, history, companyId: 'COMPANY-A', revision: 'TEST-1' };
const prepared = createInputMatchingContext(snapshot);

// Evaluate the pre-existing scoring implementation against supplied fixtures only.
// This comparison neither opens its Repository nor makes it a production input dependency.
const baselineSource = fs.readFileSync(new URL('../orderq/smartparser/candidate-generator.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\r?\n/, '');
const baselineData = { products, mappings, orders: [{ orderId: 'O1', customerId: 'C1' }], items: history };
const baselinePrelude = 'const snapshot=' + JSON.stringify(baselineData) + ';'
  + 'const STORE={PRODUCTS:"products",PRODUCT_MAPPINGS:"mappings",ORDERS:"orders",ORDER_ITEMS:"items"};'
  + 'const getAll=async key=>snapshot[key];'
  + 'const normalizeText=value=>String(value??"").normalize("NFKC").trim().toLowerCase().replace(/\\s+/g,"").replace(/[\\u200b-\\u200d\\ufeff]/g,"");';
const baselineCandidates = await import('data:text/javascript;base64,' + Buffer.from(baselinePrelude + baselineSource).toString('base64'));
for (const productText of ['사과', '배', '감자', '사과 큰거', '고객별 사과', '원본별 배', '공통 감자', '지난 감자', '\u200b사과', '없는 상품']) {
  const query = { productText, customerId: 'C1', sourceId: 'LOCAL' };
  assert.deepEqual(generateInputProductCandidates(query, prepared), await baselineCandidates.generateProductCandidates(query),
    'local candidate scores, order, dictionary priority, history and first-candidate policy must remain equivalent');
}
assert.equal(generateInputProductCandidates({ productText: '사과' }, prepared)[0].productId, 'P1',
  'equal-score candidates retain the existing source order; this change does not introduce a new matching policy');
const cached = generateInputProductCandidates({ productText: '사과' }, prepared);
cached[0].itemName = 'caller edit';
assert.equal(generateInputProductCandidates({ productText: '사과' }, prepared)[0].itemName, '사과',
  'candidate results must not expose the cached row for caller mutation');

const rawText = '테스트 거래처\n사과 2박스\n배 -1.5개';
const captured = await captureTextIntake({ sourceType: 'GENERAL_TEXT', sourceId: 'LOCAL', rawText });
const expectedHash = createHash('sha256').update('GENERAL_TEXT|LOCAL|' + rawText).digest('hex');
assert.equal(captured.session.intakeSessionId, 'SI-LOCAL-' + expectedHash.slice(0, 24));
assert.equal(captured.sourcePart.contentHash, expectedHash);
assert.equal(captured.sourcePart.rawText, rawText);
const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const previousFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new Error('INPUT_MUST_NOT_OPEN_DATABASE'); } });
globalThis.fetch = () => { throw new Error('INPUT_MUST_NOT_FETCH'); };
try {
  const missing = await analyzeSingleOrderDocument({ session: captured.session, sourcePart: captured.sourcePart, rawText });
  assert.deepEqual(missing.lines.map(row => [row.itemName, row.quantity, row.productId, row.matchStatus]), [
    ['사과', 2, null, 'MATCH_FAILED'], ['배', -1.5, null, 'MATCH_FAILED']
  ], 'missing optional data must leave a usable parsed, unresolved local document');
  const matched = await analyzeSingleOrderDocument({ session: captured.session, sourcePart: captured.sourcePart, rawText, matchingContext: prepared });
  assert.deepEqual(matched.lines.map(row => row.productId), ['P1', 'P2']);
  assert.deepEqual(matched.lines.map(row => row.sourceLineKey), missing.lines.map(row => row.sourceLineKey));
  assert.equal(matched.document.intakeDocumentId, missing.document.intakeDocumentId);
  const unresolved = await rematchExtractedLinesForCustomer([{ productId: 'STALE', productText: '없는 상품', quantity: 0 }],
    { customerId: 'C1', customerName: '테스트' }, 'LOCAL', prepared);
  assert.equal(unresolved[0].productId, '', 'unresolved rematch must not retain an unsupported previous product identity');
  assert.equal(unresolved[0].quantity, 0);
  const staleMapping = await rematchExtractedLinesForCustomer([{ productText: '누락된 ID', rawUnit: '개', quantity: -2 }],
    { customerId: 'C1', customerName: '테스트' }, 'LOCAL', { products, mappings: [{ rawText: '누락된 ID', productId: 'MISSING', itemCode: 'X', itemName: '증거' }] });
  assert.equal(staleMapping[0].productId, '', 'a dictionary cannot manufacture a product absent from the supplied snapshot');
  assert.equal(staleMapping[0].matchStatus, 'MATCH_FAILED');
  const scoped = createInputMatchingContext({ companyId: 'COMPANY-A', products: [{ ...products[0], companyId: 'COMPANY-B' }] });
  assert.deepEqual(generateInputProductCandidates({ productText: '사과' }, scoped), [], 'another company snapshot must not match');
} finally {
  if (previousIndexedDB) Object.defineProperty(globalThis, 'indexedDB', previousIndexedDB);
  else delete globalThis.indexedDB;
  globalThis.fetch = previousFetch;
}

const inputSource = fs.readFileSync(new URL('../smartinput/input.js', import.meta.url), 'utf8');
assert.doesNotMatch(inputSource, /(?:from\s*|import\s*\()['"][^'"]*(?:orderq|reference-data|smartinput-data-store)/,
  'text intake must use caller-supplied data without importing external engines or storage');
assert.equal(hasEnteredValue('\u200b\u00a0 '), false);
assert.equal(hasEnteredValue(0), true);
assert.equal(hasEnteredValue(-1.5), true);
assert.equal(hasEnteredValue(NaN), false);
assert.equal(rowHasMeaningfulInput({ rowId: 'technical-only' }), false);
assert.equal(rowHasMeaningfulInput({ quantity: 0 }), true);
assert.equal(rowHasMeaningfulInput({ customValues: { note: '증거' } }), true);
assert.equal(rowHasLinkedSource({ linkedSourceEstimateId: 'E1', linkedSourceRowId: 'R1' }), true);
const originalRow = { rowId: 'R1', quantity: 0, customValues: { blank: '\u200b', zero: 0, negative: -1.5 } };
assert.equal(compactRowBlankValues(originalRow), originalRow, 'row cleanup retains its existing mutation contract');
assert.deepEqual(originalRow.customValues, { zero: 0, negative: -1.5 });
const work = { rows: [{ rowId: 'empty' }, originalRow, { rowId: 'linked', itemName: '상품', linkedSourceRefs: ['E1:R1'] }] };
assert.equal(pruneEmptyWorkRows(work), true);
assert.deepEqual(work.rows.map(row => row.rowId), ['R1', 'linked']);
assert.deepEqual(manualLinkedRows(work.rows).map(row => row.rowId), ['R1']);
assert.equal(pruneEmptyWorkRows(work), false, 'repeat cleanup does not lose the stable zero-valued row');
console.log('SmartInput owned text intake, parser equivalence, supplied-snapshot matching and failure isolation passed.');
