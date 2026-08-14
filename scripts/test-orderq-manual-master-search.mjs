import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  mergeProductCatalog,
  normalizeMasterProduct,
  productCategoryCode,
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
assert.equal(productCategoryCode('101010111'), '101010', '품목코드 앞 6자리는 상품 카테고리다.');

const categoryCatalog = [
  normalizeMasterProduct({ 품목코드: '101010118', 품목명: '무우 소분', 출고가: '1,900' }),
  normalizeMasterProduct({ 품목코드: '101010110', 품목명: '월동무우(특)', 출고가: 16000 }),
  normalizeMasterProduct({ 품목코드: '101010111', 품목명: '햇무우(특/10입)', 출고가: 0 }),
  normalizeMasterProduct({ 품목코드: '101016110', 품목명: '무우 다른분류', 출고가: '' })
];
assert.deepEqual(
  searchProductCatalog('무우', categoryCatalog).map(product => product.itemCode),
  ['101010110', '101010111', '101010118', '101016110'],
  '가장 관련 높은 상품의 6자리 카테고리를 먼저 묶고 그 안에서는 코드 오름차순이어야 한다.'
);
assert.equal(categoryCatalog[0].outPrice, 1900, '공통 마스터 출고가 문자열을 주문 단가 숫자로 정규화한다.');
assert.equal(categoryCatalog[2].outPrice, 0, '출고가 0도 공란과 구분해 보존한다.');
assert.equal(categoryCatalog[3].outPrice, null, '출고가 공란은 임의로 0으로 바꾸지 않는다.');
assert.equal(normalizeMasterProduct({ itemCode: 'H1', itemName: '이력상품', 출고가: 9999 }, '', 'ORDERQ_HISTORY').outPrice, null,
  'ORDER Q 주문이력의 가격을 공통 마스터 출고가로 오인하지 않는다.');

const input = await readFile(new URL('../orderq/input.html', import.meta.url), 'utf8');
assert.match(input, /loadProductCatalog/);
assert.match(input, /searchProductCatalog/);
assert.match(input, /row\.dataset\.productId \? MATCH_STATUS\.MATCHED : MATCH_STATUS\.MATCH_FAILED/);
assert.match(input, /productId:\s*row\.dataset\.productId \|\| null/);
assert.match(input, /vNext 0\.4\.5/);
for (const contract of [
  "const MANUAL_DEFAULTS_KEY = 'oneapp.orderq.manual-defaults.v1'",
  "customerNameInput.addEventListener('keydown'",
  "warehouseInput.focus()",
  "warehouseInput.addEventListener('change', saveManualDefaults)",
  "transactionTypeInput.addEventListener('change', saveManualDefaults)",
  "orderDateInput.setSelectionRange(8, 10)",
  "orderDatePicker.showPicker()",
  "if (product.outPrice != null) row.querySelector('[data-field=\"price\"]').value = product.outPrice",
  '전표 메모',
  '상품별 메모(적요)',
  'class="top-system"',
  'id="orderMeta"',
  'badge.hidden = !hasProductInput',
  'attemptedRows.length - matched'
]) assert.ok(input.includes(contract), `수기주문 입력 계약 누락: ${contract}`);
assert.doesNotMatch(input, /class="row-status failed">매칭실패</,
  '빈 상품행은 매칭실패 배지를 먼저 표시하면 안 된다.');
assert.match(input, /data-role="matchStatus" class="row-status" hidden/,
  '빈 상품행의 마스터 매칭 상태는 숨김으로 시작해야 한다.');
assert.match(input, /<body class="manual-order-page">/,
  '수기주문 전용 가로 폭을 다른 ORDER Q 화면과 분리해야 한다.');
assert.match(input, /<col class="col-select">/,
  '선택 체크박스 열을 포함한 수기주문 고정 열 배분이 있어야 한다.');
for (const informationGroup of [
  '<th class="group-product" colspan="3">상품 정보</th>',
  '<th class="group-order" colspan="4">주문 입력</th>',
  '<th class="group-check" colspan="2">확인</th>'
]) assert.ok(input.includes(informationGroup), `수기주문 정보 묶음 누락: ${informationGroup}`);

const orderqCss = await readFile(new URL('../orderq/orderq.css', import.meta.url), 'utf8');
for (const compactWidthContract of [
  '.manual-order-page .shell { width: min(1100px, calc(100% - 28px)); }',
  '.manual-order-page #orderTable { table-layout: fixed; min-width: 1000px; }',
  '.manual-order-page #orderTable .col-select { width: 32px; }',
  '.manual-order-page #orderTable .table-groups .group-product',
  '.manual-order-page #orderTable .table-groups .group-order',
  '.manual-order-page #orderTable input[data-role="select"] { width: 16px; min-height: 16px; height: 16px;'
]) assert.ok(orderqCss.includes(compactWidthContract), `수기주문 가로 축소 계약 누락: ${compactWidthContract}`);

const intake = await readFile(new URL('../orderq/order-intake-engine.js', import.meta.url), 'utf8');
assert.match(intake, /requestedProductId && !requestedProductId\.startsWith\('CODE:'\)/);
assert.doesNotMatch(intake, /`CODE:\$\{itemCode\}`/, '직접 입력 코드를 가짜 productId로 만들면 안 된다.');

console.log('PASS: ORDER Q 수기입력 공통 마스터 검색·선택·미매칭 저장 계약');
