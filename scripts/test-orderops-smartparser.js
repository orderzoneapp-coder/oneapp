'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../orderops/orderops-smartparser-core.js');

function testSmartParserEntryAndAssets() {
  const orderOpsDir = path.join(__dirname, '..', 'orderops');
  const entry = fs.readFileSync(path.join(orderOpsDir, 'smartparser.html'), 'utf8');
  const input = fs.readFileSync(path.join(orderOpsDir, 'input.html'), 'utf8');

  assert.match(entry, /^<!DOCTYPE html>/i);
  assert.doesNotMatch(entry, /FILE START:|전체 소스코드/);
  assert.match(entry, /window\.location\.replace\('\.\/input\.html'\)/);
  assert.match(input, /id="btnSmartParser"/);
  assert.match(input, /\.\/orderops-smartparser\.css/);
  assert.match(input, /\.\/orderops-smartparser-core\.js/);
  assert.match(input, /\.\/orderops-smartparser\.js/);
}

function testKoreanPriceAndMultiItemParsing() {
  const document = Core.parseText(
    '거래처: 중앙167\n케일 2키로 10박스 9천원 고수 한단 2개 만오천원',
    { sourceName: '중앙167', sourceRole: '주문처' }
  );
  assert.strictEqual(document.items.length, 2);
  assert.deepStrictEqual(
    document.items.map(item => [item.parsed.itemName, item.parsed.quantity, item.parsed.price]),
    [['케일', 10, 9000], ['고수', 2, 15000]]
  );
}

function testExactMatchingAndPayload() {
  const master = [
    { 코드: 'P001', 품목명: '케일', 규격: '2kg', 단위: 'kg' },
    { 코드: 'P002', 품목명: '고수', 규격: '한단', 단위: '단' }
  ];
  let document = Core.parseText(
    '케일 2키로 10박스 9000원\n고수 한단 2개 15000원',
    { sourceName: '중앙167', sourceRole: '주문처' }
  );
  document = Core.matchDocument(document, master, {});
  assert.strictEqual(document.items[0].mappingStatus, Core.STATUS.CONFIRMED);
  assert.strictEqual(document.items[0].work.itemCode, 'P001');
  assert.strictEqual(document.items[1].mappingStatus, Core.STATUS.CONFIRMED);
  assert.strictEqual(document.items[1].work.itemCode, 'P002');
  const payload = Core.buildOrderOpsPayload(document);
  assert.strictEqual(payload.items.length, 2);
  assert.strictEqual(payload.items[0].quantity, 10);
  assert.strictEqual(payload.items[0].price, 9000);
}

function testSourceMappingReuse() {
  const master = [{ 코드: 'P100', 품목명: '적치커리', 규격: '2kg', 단위: 'kg' }];
  let document = Core.parseText('적치2K 3박스 12000원', {
    sourceName: '중앙167',
    sourceRole: '주문처'
  });
  const key = Core.buildSourceMappingKey(document, document.items[0].sourceItemText);
  document = Core.matchDocument(document, master, {
    [key]: { masterItemCode: 'P100' }
  });
  assert.strictEqual(document.items[0].mappingStatus, Core.STATUS.CONFIRMED);
  assert.strictEqual(document.items[0].mappingOrigin, 'source-mapping');
  assert.strictEqual(document.items[0].work.itemCode, 'P100');
}

function testUserMappingPersistenceAndBlocking() {
  const master = [
    { 코드: 'A1', 품목명: '적치커리', 규격: '2kg', 단위: 'kg' },
    { 코드: 'A2', 품목명: '적치커리', 규격: '4kg', 단위: 'kg' }
  ];
  let document = Core.parseText('적치커리 1박스 10000원', {
    sourceName: 'A농산', sourceRole: '공급처'
  });
  document = Core.matchDocument(document, master, {});
  assert.strictEqual(document.items[0].mappingStatus, Core.STATUS.CANDIDATE);
  assert.strictEqual(Core.validateDocument(document).valid, false);
  document = Core.chooseMaster(document, document.items[0].rowId, 'A1', master);
  assert.strictEqual(Core.validateDocument(document).valid, true);
  const mappings = Core.collectSourceMappings(document, {}, 'tester');
  assert.strictEqual(Object.keys(mappings).length, 1);
  assert.strictEqual(Object.values(mappings)[0].masterItemCode, 'A1');
}


function testAmountValidationAndLabeledFields() {
  const source = '케일 2키로 10박스 단가 9000원 공급가액 90000원 공지단가 9500원 | 메모: 오전배송 | 적요: 직원확인';
  const parsedDocument = Core.parseText(source, { sourceName: '중앙167' });
  assert.strictEqual(parsedDocument.items.length, 1);
  const valid = parsedDocument.items[0];
  assert.strictEqual(valid.parsed.itemName, '케일');
  assert.strictEqual(valid.parsed.quantity, 10);
  assert.strictEqual(valid.parsed.price, 9000);
  assert.strictEqual(valid.parsed.sourceAmount, 90000);
  assert.strictEqual(valid.parsed.calculatedAmount, 90000);
  assert.strictEqual(valid.work.noticePrice, 9500);
  assert.strictEqual(valid.work.memo, '오전배송');
  assert.strictEqual(valid.work.description, '직원확인');
  assert.strictEqual(valid.validationMessages.length, 0);

  const invalid = Core.parseItemSegment('케일 2키로 10박스 단가 9000원 공급가액 80000원');
  assert.ok(invalid.validationMessages.includes('원본 금액과 수량×단가 계산값이 일치하지 않습니다.'));
  assert.strictEqual(invalid.mappingStatus, Core.STATUS.ERROR);
}

function testInvalidQuantityRecovery() {
  const master = [{ 코드: 'B1', 품목명: '케일', 규격: '2kg', 단위: 'kg' }];
  let document = Core.parseText('케일 2키로 9000원', { sourceName: '중앙167' });
  document = Core.matchDocument(document, master, {});
  assert.strictEqual(document.items[0].mappingStatus, Core.STATUS.ERROR);
  document = Core.updateItemWork(document, document.items[0].rowId, { quantity: 3 });
  assert.strictEqual(document.items[0].mappingStatus, Core.STATUS.UNMAPPED);
  document = Core.chooseMaster(document, document.items[0].rowId, 'B1', master);
  assert.strictEqual(Core.validateDocument(document).valid, true);
}

[
  testSmartParserEntryAndAssets,
  testKoreanPriceAndMultiItemParsing,
  testExactMatchingAndPayload,
  testSourceMappingReuse,
  testUserMappingPersistenceAndBlocking,
  testAmountValidationAndLabeledFields,
  testInvalidQuantityRecovery
].forEach(test => test());

console.log('OrderOps SmartParser core tests: PASS');
