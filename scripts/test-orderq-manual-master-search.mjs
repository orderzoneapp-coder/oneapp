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
  numberOrNull,
  shiftIsoDate
} from '../orderq/manual-order-grid.js';
import {
  matchWarehouseInput,
  normalizeWarehouseCode,
  warehouseIdentity,
  warehouseSnapshot
} from '../orderq/warehouse-master.js';

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

assert.equal(normalizeWarehouseCode('1'), '01', '숫자 창고코드는 선행 0을 포함한 정식 코드로 정규화해야 한다.');
assert.deepEqual(warehouseIdentity({ warehouse: '1창고' }), {
  warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '1창고', normalizedName: '1창고'
});
const warehouseMaster = [{ warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '1창고', normalizedName: '1창고' }];
assert.equal(matchWarehouseInput('01', warehouseMaster, []).warehouseId, 'WH-01', '창고코드로 마스터를 선택해야 한다.');
assert.equal(matchWarehouseInput('본창고', warehouseMaster, [{ warehouseId: 'WH-01', normalizedText: '본창고' }]).warehouseId, 'WH-01',
  '창고 별칭도 동일 핵심키로 연결해야 한다.');
assert.deepEqual(warehouseSnapshot({ warehouse: '01' }, warehouseMaster[0]), {
  warehouseId: 'WH-01', warehouseCode: '01', warehouseName: '1창고', warehouse: '1창고'
});

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
  ['salePrice', '판매가', 28100],
  ['outPrice', '출고가', 28100],
  ['wholesaleA', '도매A', 27000],
  ['wholesaleB', '도매B', 26000],
  ['marketPrice', '시중가', 30000],
  ['promoPrice', '행사가', 0]
], '판매가를 첫 순서로 두고 공란 단가는 제외하며 명시적 0을 포함한 단가 후보를 정규화해야 한다.');
assert.equal(normalizeManualPriceOptions({ 출고가: 28100, 행사가: 25900 })[0].value, 25900,
  '판매가는 유효한 행사가를 우선 적용해야 한다.');
assert.equal(normalizeManualPriceOptions({ 출고가: 28100, 행사가: '' })[0].value, 28100,
  '행사가가 공란이면 판매가는 출고가를 적용해야 한다.');
assert.equal(normalizeManualPriceOptions({ 출고가: 28100, 행사가: 0 })[0].value, 28100,
  '행사가가 0이면 판매가는 출고가를 적용해야 한다.');
assert.equal(cycleManualPriceOption(priceOptions, 'outPrice', 1).key, 'wholesaleA', '위 화살표는 다음 단가로 이동해야 한다.');
assert.equal(cycleManualPriceOption(priceOptions, 'outPrice', -1).key, 'salePrice', '아래 화살표는 이전 단가로 순환해야 한다.');
assert.equal(cycleManualPriceOption(priceOptions, 'MANUAL', 1).key, 'salePrice', '직접입력에서 위 화살표를 누르면 기본 판매가를 선택해야 한다.');
assert.equal(manualPriceTypeLabel('salePrice', priceOptions, true), '판매가', '판매가 공식 항목명을 제공해야 한다.');
assert.equal(manualPriceTypeLabel('wholesaleA', priceOptions, true), '도매A', '선택 단가의 항목명을 표시해야 한다.');
assert.equal(manualPriceTypeLabel('MANUAL', priceOptions, true), '직접입력', '직접 수정한 단가는 직접입력으로 표시해야 한다.');
const packedMaster = normalizeMasterProduct({ 품목코드: 'BOX-20', 품목명: '박스상품', 원단위: '20', 단위: 'EA' });
assert.equal(packedMaster.boxQuantity, 20, '공통 마스터 원단위는 수기주문의 박스당수량으로 읽는다.');
assert.equal(packedMaster.finalUnit, 'EA', '공통 마스터 단위는 수기주문의 단위로 읽는다.');

assert.equal(numberOrNull('1,900'), 1900, '쉼표가 있는 금액도 숫자로 읽어야 한다.');
assert.equal(calculateLineTotal(3, 28100), 84300, '합계 기본값은 수량×단가다.');
assert.equal(calculateVatAmount(84300), 8430, '부가세 제안값은 합계의 10%다.');
assert.equal(calculateVatAmount(15), 2, '부가세 제안값은 원 단위로 반올림한다.');
assert.equal(shiftIsoDate('2026-08-14', 1), '2026-08-15', '위 화살표는 일자를 하루 증가시켜야 한다.');
assert.equal(shiftIsoDate('2026-08-14', -1), '2026-08-13', '아래 화살표는 일자를 하루 감소시켜야 한다.');
assert.equal(shiftIsoDate('2026-08-31', 1), '2026-09-01', '일자 증감은 월 경계를 올바르게 넘어야 한다.');
assert.equal(shiftIsoDate('2026-02-29', 1), '', '유효하지 않은 일자는 증감하지 않아야 한다.');
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
assert.match(input, /vNext 0\.7\.0/);
assert.match(input, /orderq-db\.js\?v=0\.7\.0|order-intake-engine\.js\?v=0\.7\.0/,
  'IndexedDB v6 화면은 이전 캐시 모듈과 섞이지 않도록 릴리스 쿼리를 사용해야 한다.');
for (const contract of [
  "const MANUAL_DEFAULTS_KEY = 'oneapp.orderq.manual-defaults.v1'",
  "customerNameInput.addEventListener('keydown'",
  "warehouseInput.focus()",
  "warehouseInput.addEventListener('change', saveManualDefaults)",
  'list="warehouseOptions"',
  'loadWarehouseCatalog',
  'warehouseId: matchedWarehouse?.warehouseId || selectedWarehouseId',
  "if (!payload.warehouseName)",
  "transactionTypeInput.addEventListener('change', saveManualDefaults)",
  "orderDateInput.setSelectionRange(8, 10)",
  "shiftIsoDate(orderDateInput.value, event.key === 'ArrowUp' ? 1 : -1)",
  "orderDatePicker.showPicker()",
  'const defaultPrice = product.priceOptions?.find(option => option.key === selectedPriceType)',
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
assert.match(input, /<col class="col-select" data-col-key="select">/,
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
  'priceTypeSelect.addEventListener(\'change\', () => applyPriceTypeToRows(priceTypeSelect.value))',
  'applyPriceTypeToRows(option.key)',
  'updatePriceTypeHeaderFromRows()',
  "const COLUMN_WIDTHS_KEY = 'oneapp.orderq.manual-column-widths.v1'",
  'data-col-key="name"',
  'data-resize-col="name"',
  "handle.className = 'column-resize-handle'",
  'saveColumnWidthsButton.hidden = false',
  'saveColumnWidthsButton.addEventListener(\'click\', saveColumnWidths)',
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
assert.match(input, /<select id="priceTypeSelect" aria-label="단가 종류">\s*<option value="salePrice" selected>판매가<\/option>/,
  '단가 헤더는 판매가를 기본값으로 표시하는 클릭형 드롭다운이어야 한다.');
assert.doesNotMatch(input, /class="price-kind"|data-role="priceType"/,
  '단가 종류는 행마다 반복하지 않고 헤더에서 한 번만 표시해야 한다.');
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
  '.manual-order-page #orderTable .col-price { width: 86px; }',
  '.manual-order-page #orderTable .price-header select',
  '.manual-order-page #orderTable .column-resize-handle',
  '.column-width-save[hidden] { display: none; }',
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
assert.match(intake, /resolveWarehouseInTransaction/,
  '수기주문 저장은 창고 문자열을 창고 마스터 핵심키로 해결해야 한다.');
assert.match(intake, /warehouseSnapshot\(payload, warehouse\)/,
  '주문에는 창고 ID·코드·명칭 스냅샷과 기존 문자열을 함께 보존해야 한다.');

const dbSource = await readFile(new URL('../orderq/orderq-db.js', import.meta.url), 'utf8');
assert.match(dbSource, /const DB_VERSION = 6/);
assert.match(dbSource, /WAREHOUSES: 'warehouses'/);
assert.match(dbSource, /WAREHOUSE_ALIASES: 'warehouseAliases'/);
const warehouseSource = await readFile(new URL('../orderq/warehouse-master.js', import.meta.url), 'utf8');
assert.match(warehouseSource, /migrateLegacyOrderWarehouses/,
  'DB v6는 기존 주문의 warehouse 문자열을 창고 마스터 핵심키로 지연 마이그레이션해야 한다.');

console.log('PASS: ORDER Q 수기입력 공통 마스터 검색·선택·미매칭 저장 계약');
