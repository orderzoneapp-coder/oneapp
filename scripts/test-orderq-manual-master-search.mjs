import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  mergeProductCatalog,
  normalizeManualPriceOptions,
  normalizeMasterProduct,
  productCategoryCode,
  searchProductCatalog
} from '../orderq/product-master-search.js';
import {
  calculateLineTotal,
  calculateVatAmount,
  compareManualRows,
  cycleManualPriceOption,
  manualPriceTypeLabel,
  numberOrNull
} from '../orderq/manual-order-grid.js';

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
const priceOptions = normalizeManualPriceOptions({
  출고가: 28100,
  도매A: 27000,
  도매B: 26000,
  상장가: '',
  시중가: 30000,
  행사가: 0
});
assert.deepEqual(priceOptions.map(option => [option.key, option.label, option.value]), [
  ['outPrice', '출고가', 28100],
  ['wholesaleA', '도매A', 27000],
  ['wholesaleB', '도매B', 26000],
  ['marketPrice', '시중가', 30000],
  ['promoPrice', '행사가', 0]
], '공란 단가는 제외하고 명시적 0을 포함한 판매단가 후보를 순서대로 정규화해야 한다.');
assert.equal(cycleManualPriceOption(priceOptions, 'outPrice', 1).key, 'wholesaleA', '위 화살표는 다음 단가로 이동해야 한다.');
assert.equal(cycleManualPriceOption(priceOptions, 'outPrice', -1).key, 'promoPrice', '아래 화살표는 이전 단가로 순환해야 한다.');
assert.equal(cycleManualPriceOption(priceOptions, 'MANUAL', 1).key, 'outPrice', '직접입력에서 위 화살표를 누르면 첫 마스터 단가를 선택해야 한다.');
assert.equal(manualPriceTypeLabel('wholesaleA', priceOptions, true), '도매A', '선택 단가의 항목명을 표시해야 한다.');
assert.equal(manualPriceTypeLabel('MANUAL', priceOptions, true), '직접입력', '직접 수정한 단가는 직접입력으로 표시해야 한다.');
const packedMaster = normalizeMasterProduct({ 품목코드: 'BOX-20', 품목명: '박스상품', 원단위: '20', 단위: 'EA' });
assert.equal(packedMaster.boxQuantity, 20, '공통 마스터 원단위는 수기주문의 박스당수량으로 읽는다.');
assert.equal(packedMaster.finalUnit, 'EA', '공통 마스터 단위는 수기주문의 단위로 읽는다.');

assert.equal(numberOrNull('1,900'), 1900, '쉼표가 있는 금액도 숫자로 읽어야 한다.');
assert.equal(calculateLineTotal(3, 28100), 84300, '합계 기본값은 수량×단가다.');
assert.equal(calculateVatAmount(84300), 8430, '부가세 제안값은 합계의 10%다.');
assert.equal(calculateVatAmount(15), 2, '부가세 제안값은 원 단위로 반올림한다.');
const sortableRows = [
  { itemCode: '20', itemName: '나', finalUnit: 'BOX', inputSequence: 1 },
  { itemCode: '3', itemName: '가', finalUnit: 'EA', inputSequence: 2 },
  { empty: true, inputSequence: 3 }
];
assert.deepEqual([...sortableRows].sort((a, b) => compareManualRows(a, b, 'code')).map(row => row.itemCode || ''), ['3', '20', ''],
  '코드순은 숫자 자연순이며 빈 행은 마지막이어야 한다.');
assert.deepEqual([...sortableRows].sort((a, b) => compareManualRows(a, b, 'name')).map(row => row.itemName || ''), ['가', '나', ''],
  '품명 가나다순 정렬과 빈 행 후순위를 지켜야 한다.');

const input = await readFile(new URL('../orderq/input.html', import.meta.url), 'utf8');
assert.match(input, /loadProductCatalog/);
assert.match(input, /searchProductCatalog/);
assert.match(input, /row\.dataset\.productId \? MATCH_STATUS\.MATCHED : MATCH_STATUS\.MATCH_FAILED/);
assert.match(input, /productId:\s*row\.dataset\.productId \|\| null/);
assert.match(input, /vNext 0\.4\.7/);
for (const contract of [
  "const MANUAL_DEFAULTS_KEY = 'oneapp.orderq.manual-defaults.v1'",
  "customerNameInput.addEventListener('keydown'",
  "warehouseInput.focus()",
  "warehouseInput.addEventListener('change', saveManualDefaults)",
  "transactionTypeInput.addEventListener('change', saveManualDefaults)",
  "orderDateInput.setSelectionRange(8, 10)",
  "orderDatePicker.showPicker()",
  "const defaultPrice = product.priceOptions?.find(option => option.key === 'outPrice')",
  "row.querySelector('[data-field=\"boxQuantity\"]').value = product.boxQuantity ?? ''",
  '전표 메모',
  '상품별 메모(적요)',
  '박스당수량',
  '부가세',
  '합계',
  '품목코드 입력 후 마스터 매칭 결과를 표시합니다.',
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
  '<th class="group-product" id="productGroupHeader" colspan="5">상품 정보</th>',
  '<th class="group-order" id="orderGroupHeader" colspan="3">주문 입력</th>',
  '<th class="group-check" colspan="2">확인</th>'
]) assert.ok(input.includes(informationGroup), `수기주문 정보 묶음 누락: ${informationGroup}`);
for (const manualEntryContract of [
  'data-column-toggle="vat"',
  'data-sort="code"',
  'data-sort="name"',
  'data-sort="unit"',
  "if (field === 'itemCode')",
  "searchProductCatalog(event.target.value.trim(), productCatalog, 8)",
  "focusRowField(row, 'quantity')",
  "focusRowField(row, 'price')",
  "focusRowField(row, 'memo')",
  "cycleRowPrice(row, event.key === 'ArrowUp' ? 1 : -1)",
  'data-price-step="1"',
  'data-price-step="-1"',
  "row.dataset.priceType = event.target.value.trim() ? 'MANUAL' : ''",
  'const nextRow = row.nextElementSibling || addRow()',
  "row.dataset.totalManual = event.target.value.trim() ? 'true' : ''",
  'supplyAmount: get(\'supplyAmount\')',
  'vatAmount: get(\'vatAmount\')',
  'boxQuantity: get(\'boxQuantity\')',
  "priceType: row.dataset.priceType || (price !== '' ? 'MANUAL' : '')"
]) assert.ok(input.includes(manualEntryContract), `수기주문 입력동선 계약 누락: ${manualEntryContract}`);
assert.doesNotMatch(input, /id="addRowBtn"|id="addRowBottomBtn"/, '수기주문 행추가 버튼은 노출하지 않아야 한다.');
assert.doesNotMatch(input, /matches\('\[data-field="itemCode"\], \[data-field="itemName"\]'\)/,
  '품목명 입력에서 상품검색을 실행하면 안 된다.');
assert.doesNotMatch(input, /품목코드·품목명 입력 후 마스터 매칭/,
  '품목명에서도 검색된다고 오인할 수 있는 안내 문구를 표시하면 안 된다.');
assert.doesNotMatch(input, /addRow\(\); addRow\(\)/, '초기 수기주문 행을 3개 고정 생성하면 안 된다.');

const orderqCss = await readFile(new URL('../orderq/orderq.css', import.meta.url), 'utf8');
for (const compactWidthContract of [
  '.manual-order-page .shell { width: min(1100px, calc(100% - 28px)); }',
  '.manual-order-page #orderTable { table-layout: fixed; min-width: 1000px; }',
  '.manual-order-page #orderTable .col-select { width: 30px; }',
  '.manual-order-page #orderTable .col-price { width: 102px; }',
  '.manual-order-page #orderTable .col-total { width: 88px; }',
  '.manual-order-page #orderTable .col-vat { width: 74px; }',
  '.manual-order-page #orderTable .table-groups .group-product',
  '.manual-order-page #orderTable .table-groups .group-order',
  '.manual-order-page #orderTable input[data-role="select"] { width: 16px; min-height: 16px; height: 16px;'
]) assert.ok(orderqCss.includes(compactWidthContract), `수기주문 가로 축소 계약 누락: ${compactWidthContract}`);

const intake = await readFile(new URL('../orderq/order-intake-engine.js', import.meta.url), 'utf8');
assert.match(intake, /requestedProductId && !requestedProductId\.startsWith\('CODE:'\)/);
assert.doesNotMatch(intake, /`CODE:\$\{itemCode\}`/, '직접 입력 코드를 가짜 productId로 만들면 안 된다.');
assert.match(intake, /boxQuantity: asNumberOrNull\(input\.boxQuantity\)/,
  '박스당수량은 ORDER_ITEM의 별도 숫자 필드로 저장해야 한다.');
assert.match(intake, /vatAmount: asNumberOrNull\(input\.vatAmount\)/,
  '부가세 수정값은 ORDER_ITEM에 보존해야 한다.');
assert.match(intake, /priceType: String\(input\.priceType \?\? ''\)\.trim\(\)/,
  '선택한 단가 항목명은 ORDER_ITEM에 보존해야 한다.');

console.log('PASS: ORDER Q 수기입력 공통 마스터 검색·선택·미매칭 저장 계약');
