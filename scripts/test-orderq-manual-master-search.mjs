import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  mergeProductCatalog,
  normalizeMasterProduct,
  searchProductCatalog
} from '../orderq/product-master-search.js';

const common = [
  normalizeMasterProduct({
    품목코드: '101020114',
    품목명: '대파_단',
    규격: 'EA',
    단위: '단',
    제2품명: '대파 한단',
    검색어등록: '파 채소'
  }, '', 'COMMON_MASTER'),
  normalizeMasterProduct({ 품목코드: '101010111', 품목명: '햇무우(특/10입)', 규격: 'BOX', 단위: 'BOX' }, '', 'COMMON_MASTER')
];
const history = [normalizeMasterProduct({ itemCode: '101020114', itemName: '이력 대파', unit: 'EA' }, '', 'ORDERQ_HISTORY')];
const catalog = mergeProductCatalog(common, history);

assert.equal(catalog.length, 2, '공통 마스터가 동일 코드의 이력 상품보다 우선해야 한다.');
assert.equal(searchProductCatalog('101020114', catalog)[0].itemName, '대파_단', '품목코드 정확일치 검색');
assert.equal(searchProductCatalog('대파', catalog)[0].itemCode, '101020114', '품목명 부분검색');
assert.equal(searchProductCatalog('한단', catalog)[0].itemCode, '101020114', '제2품명·약칭 검색');
assert.equal(searchProductCatalog('채소', catalog)[0].itemCode, '101020114', '검색창정보 검색');
assert.equal(searchProductCatalog('무우', catalog)[0].itemCode, '101010111', '유사 품명 검색');

const input = await readFile(new URL('../orderq/input.html', import.meta.url), 'utf8');
assert.match(input, /loadProductCatalog/);
assert.match(input, /searchProductCatalog/);
assert.match(input, /row\.dataset\.productId \? MATCH_STATUS\.MATCHED : MATCH_STATUS\.MATCH_FAILED/);
assert.match(input, /productId:\s*row\.dataset\.productId \|\| null/);
assert.match(input, /vNext 0\.4\.2/);

const intake = await readFile(new URL('../orderq/order-intake-engine.js', import.meta.url), 'utf8');
assert.match(intake, /requestedProductId && !requestedProductId\.startsWith\('CODE:'\)/);
assert.doesNotMatch(intake, /`CODE:\$\{itemCode\}`/, '직접 입력 코드를 가짜 productId로 만들면 안 된다.');

console.log('PASS: ORDER Q 수기입력 공통 마스터 검색·선택·미매칭 저장 계약');
