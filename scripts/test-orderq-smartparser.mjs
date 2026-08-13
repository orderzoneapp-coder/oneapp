import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseKakaoText, parseGeneralText, createSourceMessageKey } from '../orderq/smartparser/source-parser.js';
import { EVENT_TYPE, detectOrderEvent } from '../orderq/smartparser/order-event-detector.js';
import { parseOrderLine } from '../orderq/smartparser/order-line-parser.js';

const cases = [
  ['수입양상추1', EVENT_TYPE.ORDER],
  ['꽃상추3', EVENT_TYPE.ORDER],
  ['포장양상추12수 좋은거3박스요', EVENT_TYPE.ORDER],
  ['봉지추부깻잎 1', EVENT_TYPE.ORDER],
  ['베이비순은 5시 전으로 발주 부탁드립니다', EVENT_TYPE.NOTICE],
  ['상장 1900', EVENT_TYPE.INFORMATION],
  ['/', EVENT_TYPE.ACK],
  ['.', EVENT_TYPE.ACK],
  ['8번 200단', EVENT_TYPE.ORDER]
];
for (const [input, expected] of cases) {
  assert.equal(detectOrderEvent(input).eventType, expected, `${input} event type`);
}

const packed = parseOrderLine('포장양상추12수 좋은거3박스요');
assert.equal(packed.productText, '포장양상추');
assert.equal(packed.specText, '12수');
assert.equal(packed.attributeText, '좋은거');
assert.equal(packed.quantity, 3);
assert.equal(packed.rawUnit, '박스');

for (const [input, productText, quantity] of [
  ['수입양상추1', '수입양상추', 1],
  ['꽃상추3', '꽃상추', 3],
  ['봉지추부깻잎 1', '봉지추부깻잎', 1]
]) {
  const line = parseOrderLine(input);
  assert.equal(line.productText, productText);
  assert.equal(line.quantity, quantity);
}

const context = parseOrderLine('8번 200단');
assert.equal(context.contextReference, '8번');
assert.equal(context.quantity, 200);
assert.equal(context.rawUnit, '단');
assert.equal(context.productText, '');
assert.equal(context.reason, 'CONTEXT_PRODUCT_UNRESOLVED');

const kakao = parseKakaoText(`[진주8번] [오후 6:59] 8번
봉지추부깻잎 1
베이비(소) 5
[진주170] [오전 8:31] 수입양상추1`, 'KAKAO_FIXTURE');
assert.equal(kakao.length, 2);
assert.equal(kakao[0].senderRaw, '진주8번');
assert.deepEqual(kakao[0].lines, ['8번', '봉지추부깻잎 1', '베이비(소) 5']);
assert.equal(kakao[1].senderRaw, '진주170');

const general = parseGeneralText('꽃상추3\n상장 1900', 'GENERAL_FIXTURE');
assert.equal(general.length, 2);
assert.notEqual(general[0].sourceMessageKey, general[1].sourceMessageKey);
assert.equal(
  createSourceMessageKey({ ...general[0] }),
  createSourceMessageKey({ ...general[0] }),
  'source message key must be deterministic'
);

for (const path of [
  'orderq/parser.html',
  'orderq/parser-ui.js',
  'orderq/smartparser/parser-orchestrator.js',
  'orderq/smartparser/parser-repository.js'
]) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.ok(source.length > 100, `${path} should exist`);
}

const parserUi = await readFile(new URL('../orderq/parser-ui.js', import.meta.url), 'utf8');
assert.match(parserUi, /createOrder\(/, 'SmartParser must use Order Intake createOrder');
assert.match(parserUi, /MANUAL_REVIEW_REQUIRED/, 'partial update/cancel messages must enter manual safety review');
assert.doesNotMatch(parserUi, /await\s+updateOrder\(/, 'SmartParser must not replace a whole order from a partial update message');
assert.doesNotMatch(parserUi, /await\s+cancelOrder\(/, 'SmartParser must not auto-cancel a whole order from a message');
assert.match(parserUi, /syncAfterLocalMutation\(/, 'SmartParser must use Cloud Sync');

const db = await readFile(new URL('../orderq/orderq-db.js', import.meta.url), 'utf8');
assert.match(db, /bySourceMessageKey[\s\S]*unique:\s*true/, 'sourceMessageKey must be uniquely indexed');

const cloudServer = await readFile(new URL('../orderq-cloud.gs', import.meta.url), 'utf8');
const syncEngine = await readFile(new URL('../orderq/orderq-sync-engine.js', import.meta.url), 'utf8');
assert.match(cloudServer, /orderQFindOrderBundleBySourceMessageKey/, 'cloud must detect duplicate source messages');
assert.match(cloudServer, /status:\s*'source_duplicate'/, 'cloud must return canonical source duplicate');
assert.match(syncEngine, /discardLocalSourceDuplicate/, 'client must replace a cross-device duplicate with the canonical order');

console.log('PASS: ORDER Q SmartParser fixtures and integration contract');
