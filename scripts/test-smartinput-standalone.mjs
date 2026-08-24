#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeMasterProduct, searchProductCatalog } from '../orderq/product-master-search.js';
import { buildOrderSourceDocumentCanonicalProjection } from '../orderq/intake-identity.js';
import {
  buildCatalogPriceSnapshot,
  buildKakaoNoticeRows,
  buildEstimateF8Data,
  validateEstimateRows,
  renderKakaoNoticeCanvases,
  paginateKakaoNoticeRows,
  splitKakaoNoticeColumns,
  KAKAO_NOTICE_ROWS_PER_PAGE
} from '../smartinput/estimate-output.js';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const contractSource = read('smartinput/smartinput-contract.js');
const appSource = read('smartinput/smartinput.js');
const dataStoreSource = read('smartinput/smartinput-data-store.js');
const orderIntakeSource = read('orderq/order-intake-engine.js');
const html = read('smartinput/index.html');
const css = read('smartinput/smartinput.css');
const readme = read('smartinput/README.md');
const architecture = read('APP_ARCHITECTURE.md');
const manifest = JSON.parse(read('app-manifest.json'));

const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

assert.equal(contract.APP_ID, 'smart-input');
assert.equal(contract.SCHEMA_VERSION, 'ONEAPP_SMART_INPUT_DRAFT_V1');
assert.equal(contract.DRAFT_STORAGE_KEY, 'oneapp.smartinput.draft.v1');
assert.equal(contract.DRAFT_LIST_STORAGE_KEY, 'oneapp.smartinput.drafts.v1');
assert.equal(contract.DELIVERY_HISTORY_KEY, 'oneapp.smartinput.delivery-history.v1');
assert.equal(contract.SETTINGS_STORAGE_KEY, 'oneapp.smartinput.settings.v1');
assert.deepEqual(Array.from(contract.INPUT_METHODS, item => item.id), ['direct', 'excel', 'text', 'paste', 'photo', 'voice']);
assert.deepEqual(Object.keys(contract.MODES), ['order', 'purchase', 'sale', 'estimate']);
assert.deepEqual(Array.from(contract.STAGES), ['capture', 'extract', 'match', 'review', 'complete']);
assert.deepEqual(Array.from(contract.PRODUCT_FIELD_GROUPS, group => group.label), ['품목정보', '수량', '단가', '원가', '부가정보']);
const productDefinitions = Array.from(contract.PRODUCT_FIELD_DEFINITIONS);
const productFieldIds = productDefinitions.map(field => field.id);
assert.equal(new Set(productFieldIds).size, productFieldIds.length, 'product field ids must be unique');
assert.ok(productDefinitions.length >= 90, 'the complete product master field library must be preserved');
const groupIndexes = productDefinitions.map(field => ['ITEM', 'QUANTITY', 'PRICE', 'COST', 'ADDITIONAL'].indexOf(field.group));
assert.ok(groupIndexes.every((groupIndex, index) => index === 0 || groupIndex >= groupIndexes[index - 1]), 'product fields must follow the five canonical group order');
for (const productField of [
  'itemCode', 'itemName', 'productType', 'inventoryQuantityManagement', 'salesVatRate', 'purchaseVatRate',
  'qualityInspectionType', 'quantityPerQuantity2', 'cPortalMinOrderQuantityCheck', 'minimumPurchaseUnit',
  'inboundPrice', 'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI',
  'outsourcingUnitPrice', 'materialStandardCost', 'laborStandardCost', 'brand', 'orderCutoffTime',
  'serialLotNo', 'productionSlipTarget', 'qualityInspectionRequestTarget', 'discontinued'
]) assert.ok(productFieldIds.includes(productField), `${productField} must be available in the product field library`);
assert.deepEqual(productDefinitions.filter(field => field.required).map(field => field.id), ['itemCode']);
assert.ok(contract.ROW_FIELDS.includes('materialStandardCost'));
assert.ok(!contract.ROW_FIELDS.includes('supplyAmount'), 'computed supply amount must not be directly editable');
assert.ok(Array.from(contract.DEFAULT_SETTINGS.headerFields).includes('customer'));
assert.ok(Array.from(contract.DEFAULT_SETTINGS.voucherColumns).includes('itemName'));
assert.deepEqual(Array.from(contract.DEFAULT_SETTINGS.estimateNoticePriceFields), ['noticePrice']);
assert.deepEqual(Array.from(contract.normalizeSettings({
  estimateNoticePriceFields: ['wholesaleA', 'unitPrice', 'wholesaleB', 'unknown']
}).estimateNoticePriceFields), ['wholesaleA', 'unitPrice'], 'Kakao notice price settings must keep at most two supported fields');
const minimalLayout = contract.normalizeSettings({ headerFields: [], voucherColumns: [] });
assert.deepEqual(Array.from(minimalLayout.headerFields), ['customer', 'deliveryDate', 'warehouse']);
assert.deepEqual(Array.from(minimalLayout.voucherColumns), ['itemCode']);
for (const mode of Object.keys(contract.MODES)) {
  assert.deepEqual(Array.from(minimalLayout.headerFieldsByMode[mode]), ['customer', 'deliveryDate', 'warehouse']);
  assert.deepEqual(Array.from(minimalLayout.voucherColumnsByMode[mode]), ['itemCode']);
}
const perVoucherLayout = contract.normalizeSettings({
  headerFieldsByMode: {
    order: ['customer', 'deliveryDate', 'warehouse', 'transactionType'],
    purchase: ['customer', 'deliveryDate', 'warehouse'],
    sale: ['customer', 'deliveryDate', 'warehouse', 'transactionType'],
    estimate: ['customer', 'deliveryDate', 'warehouse']
  },
  voucherColumnsByMode: {
    order: ['itemName', 'quantity', 'unitPrice'],
    purchase: ['itemName', 'quantity', 'supplyAmount'],
    sale: ['itemName', 'quantity', 'noticePrice'],
    estimate: ['itemName', 'quantity', 'memo']
  }
});
const reorderedVoucherLayout = contract.normalizeSettings({
  voucherColumnsByMode: { order: ['quantity', 'itemName', 'purchasePriceB', 'unitPrice'] }
});
assert.deepEqual(Array.from(reorderedVoucherLayout.voucherColumnsByMode.order), ['quantity', 'itemName', 'purchasePriceB', 'unitPrice', 'itemCode']);
assert.ok(Array.from(perVoucherLayout.headerFieldsByMode.order).includes('transactionType'));
assert.ok(!Array.from(perVoucherLayout.headerFieldsByMode.purchase).includes('transactionType'));
assert.ok(Array.from(perVoucherLayout.voucherColumnsByMode.purchase).includes('supplyAmount'));
assert.ok(!Array.from(perVoucherLayout.voucherColumnsByMode.purchase).includes('unitPrice'));
assert.ok(Array.from(perVoucherLayout.voucherColumnsByMode.sale).includes('noticePrice'));
assert.ok(Array.from(perVoucherLayout.voucherColumnsByMode.estimate).includes('memo'));
const customLayout = contract.normalizeSettings({
  customFields: [
    { id: 'custom-header-request', label: '배송 요청사항', scope: 'header', category: 'CUSTOM' },
    { id: 'custom-voucher-lot', label: 'LOT 메모', scope: 'voucher', category: 'CUSTOM' }
  ],
  headerFields: ['customer', 'deliveryDate', 'warehouse', 'custom-header-request'],
  voucherColumns: ['itemName', 'quantity', 'custom-voucher-lot']
});
assert.equal(customLayout.customFields.length, 2);
assert.ok(Array.from(customLayout.headerFields).includes('custom-header-request'));
assert.ok(Array.from(customLayout.voucherColumns).includes('custom-voucher-lot'));
const typedCustomLayout = contract.normalizeSettings({
  customFields: [
    ...Array.from({ length: 11 }, (_, index) => ({ id: `text-${index}`, label: `문자 ${index}`, scope: 'voucher', category: 'CUSTOM', valueType: 'TEXT' })),
    ...Array.from({ length: 11 }, (_, index) => ({ id: `number-${index}`, label: `숫자 ${index}`, scope: 'voucher', category: 'CUSTOM', valueType: 'NUMBER' }))
  ],
  voucherColumns: ['itemName', 'quantity', 'secondaryName', 'number-0'],
  columnWidths: { productSearch: 260, itemName: 233, secondaryName: 150, unknown: 999, quantity: 12 },
  columnWidthsByMode: { purchase: { productSearch: 336, itemName: 312, unknown: 90 } },
  inputOrderByMode: { order: { itemCode: 2, itemName: 0, quantity: 1, supplyAmount: 9 } }
});
assert.equal(typedCustomLayout.customFields.filter(field => field.valueType === 'TEXT').length, 10);
assert.equal(typedCustomLayout.customFields.filter(field => field.valueType === 'NUMBER').length, 10);
assert.ok(Array.from(typedCustomLayout.voucherColumns).includes('secondaryName'));
assert.equal(typedCustomLayout.columnWidths.productSearch, 260);
assert.equal(typedCustomLayout.columnWidths.itemName, 233);
assert.equal(typedCustomLayout.columnWidths.quantity, 56);
assert.equal(typedCustomLayout.columnWidths.unknown, undefined);
assert.equal(typedCustomLayout.columnWidthsByMode.purchase.productSearch, 336);
assert.equal(typedCustomLayout.columnWidthsByMode.purchase.itemName, 312);
assert.equal(typedCustomLayout.columnWidthsByMode.purchase.unknown, undefined);
assert.equal(typedCustomLayout.inputOrderByMode.order.quantity, 1);
assert.equal(typedCustomLayout.inputOrderByMode.order.itemCode, 2);
assert.equal(typedCustomLayout.inputOrderByMode.order.itemName, 0, 'input order zero must skip the field during Enter navigation');
assert.equal(typedCustomLayout.inputOrderByMode.order.supplyAmount, 0, 'computed fields cannot enter the keyboard input sequence');
const displayRow = contract.normalizeRow({ memo: '메모', description: '직원 적요', noticePrice: 1200 });
assert.equal(displayRow.memo, '메모');
assert.equal(displayRow.description, '직원 적요');
assert.equal(displayRow.noticePrice, 1200);
const extendedProductRow = contract.normalizeRow({ materialStandardCost: '1,250', brand: 'ORDERZ' });
assert.equal(extendedProductRow.materialStandardCost, 1250);
assert.equal(extendedProductRow.brand, 'ORDERZ');
assert.equal(contract.normalizeRow({ unitPrice: 3800, unitPriceReviewStatus: 'PENDING' }).unitPriceReviewStatus, 'PENDING');
assert.equal(contract.normalizeRow({ unitPrice: 3800 }).unitPriceReviewStatus, 'CONFIRMED');
const estimateDraftWithPrices = contract.normalizeModeDraft('estimate', {
  catalogRecordId: 'CAT-1',
  catalogBaselinePrices: { 'MASTER:M-1': 12000 },
  catalogPreviousPrices: { 'MASTER:M-1': 10000 }
});
assert.equal(estimateDraftWithPrices.catalogRecordId, 'CAT-1');
assert.equal(estimateDraftWithPrices.catalogBaselinePrices['MASTER:M-1'], 12000);
assert.equal(estimateDraftWithPrices.catalogPreviousPrices['MASTER:M-1'], 10000);
const estimateOutputRows = [{
  productId: 'P-1', masterProductId: 'M-1', itemCode: '1001', itemName: '열무', specification: '4kg',
  unitPrice: 3800, wholesaleA: 4500, noticePrice: 4200, memo: '주말 단가', unitPriceReviewStatus: 'PENDING'
}];
const priceSnapshot = buildCatalogPriceSnapshot(estimateOutputRows);
assert.equal(priceSnapshot['MASTER:M-1'], 4200);
const noticeRows = buildKakaoNoticeRows(estimateOutputRows, { 'MASTER:M-1': 4000 });
assert.equal(noticeRows[0].nameSpec, '열무 · 4kg');
assert.equal(noticeRows[0].change, 200);
assert.equal(noticeRows[0].note, '주말 단가');
const dualPriceNoticeRows = buildKakaoNoticeRows(estimateOutputRows, {}, [
  { id: 'wholesaleA', label: '도매A' },
  { id: 'unitPrice', label: '단가' }
]);
assert.deepEqual(dualPriceNoticeRows[0].prices, [
  { fieldId: 'wholesaleA', label: '도매A', value: 4500 },
  { fieldId: 'unitPrice', label: '단가', value: 3800 }
]);
assert.equal(KAKAO_NOTICE_ROWS_PER_PAGE, 40);
const noticeFixtures = Array.from({ length: 41 }, (_, index) => ({ ...dualPriceNoticeRows[0], key: `ROW:${index}` }));
assert.deepEqual(paginateKakaoNoticeRows(noticeFixtures).map(page => page.length), [40, 1]);
assert.deepEqual(splitKakaoNoticeColumns(noticeFixtures.slice(0, 20)).map(column => column.length), [20]);
assert.deepEqual(splitKakaoNoticeColumns(noticeFixtures.slice(0, 21)).map(column => column.length), [20, 1]);
assert.deepEqual(splitKakaoNoticeColumns(noticeFixtures.slice(0, 40)).map(column => column.length), [20, 20]);
const originalDocument = globalThis.document;
try {
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      const drawnText = [];
      const context = {
        fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        measureText(value) { return { width: String(value).length * 10 }; },
        fillText(value) { drawnText.push(String(value)); },
        fillStyle: '', strokeStyle: '', font: '', textAlign: 'left'
      };
      return { width: 0, height: 0, drawnText, getContext: () => context };
    }
  };
  const singleColumnCanvases = renderKakaoNoticeCanvases(noticeFixtures.slice(0, 20));
  assert.equal(singleColumnCanvases[0].width, 960, 'up to 20 products must use one notice column');
  const dualColumnCanvases = renderKakaoNoticeCanvases(noticeFixtures);
  assert.deepEqual(dualColumnCanvases.map(canvas => canvas.width), [1440, 960], '21-40 products must use two columns and the next 40-product page must restart independently');
  assert.ok(dualColumnCanvases[0].drawnText.includes('도매A'));
  assert.ok(dualColumnCanvases[0].drawnText.includes('단가'));
  assert.ok(!dualColumnCanvases[0].drawnText.includes('변동액'));
  assert.ok(!dualColumnCanvases[0].drawnText.includes('적요'));
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
assert.equal(validateEstimateRows(estimateOutputRows).ok, true);
assert.equal(validateEstimateRows([{ ...estimateOutputRows[0], itemCode: '' }]).ok, false);
assert.equal(validateEstimateRows([estimateOutputRows[0], { ...estimateOutputRows[0], masterProductId: 'M-2' }]).errors.some(error => error.code === 'DUPLICATE_ITEM_CODE'), true);
const estimateF8 = buildEstimateF8Data(estimateOutputRows);
assert.equal(estimateF8.ok, true);
assert.deepEqual(estimateF8.shopData[0].slice(0, 6), ['상품코드\n코드', '상품명', '규격', '출고가', '도매A', '시중가']);
assert.deepEqual(estimateF8.shopData[1].slice(0, 6), ['1001', '열무', '4kg', '', 3800, 4200]);
assert.deepEqual(estimateF8.erpData[1], ['1001', '', '0', '', '0', '', 'n', 3800, 'n', '', 'n']);
assert.equal(estimateF8.confirmData.length, 2);
assert.deepEqual(estimateF8.confirmData[0], ['확인구분', '상품코드', '상품명', '규격', '기준입고항목', '기준입고가', '도매항목', '도매가', '차이', '확인요청']);
assert.equal(estimateF8.confirmData[1][7], 3800);
assert.equal(validateEstimateRows([{}, { ...estimateOutputRows[0], itemCode: '' }]).errors[0].rowIndex, 1);
assert.deepEqual(JSON.parse(JSON.stringify(contract.normalizeRow({
  sourceRegion: { left: .1, top: .2, width: .3, height: .4 }
}).sourceRegion)), { left: .1, top: .2, width: .3, height: .4 });
assert.deepEqual(JSON.parse(JSON.stringify(contract.normalizeRow({ customValues: { 'custom-voucher-lot': 'A-01' } }).customValues)), { 'custom-voucher-lot': 'A-01' });
const commonOnlyProduct = normalizeMasterProduct(
  { 코드: 'COMMON-ONLY-1', 품목명: '공통 마스터 전용상품', 규격: 'EA', 입고B: '1200', 단가D: '1300', 최종입고: '1400', 단가H: '1500', 단가I: '1600' },
  'COMMON-ONLY-1',
  'COMMON_MASTER',
  'COMMON-ONLY-1'
);
assert.deepEqual(
  commonOnlyProduct.priceOptions.filter(option => ['purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI'].includes(option.key)).map(option => [option.key, option.value]),
  [['purchasePriceB', 1200], ['priceD', 1300], ['lastPurchasePrice', 1400], ['priceH', 1500], ['priceI', 1600]]
);
const selectedCommonProduct = searchProductCatalog('공통 마스터 전용상품', [commonOnlyProduct], 5)[0];
const linkedCommonRow = contract.normalizeRow({
  productId: selectedCommonProduct.productId,
  masterProductId: selectedCommonProduct.masterProductId,
  itemCode: selectedCommonProduct.itemCode,
  itemName: selectedCommonProduct.itemName,
  quantity: 1
});
assert.equal(linkedCommonRow.masterProductId, 'COMMON-ONLY-1');
assert.equal(linkedCommonRow.productIdentityStatus, 'MASTER_LINKED');
assert.equal(buildOrderSourceDocumentCanonicalProjection({ order: {}, items: [linkedCommonRow] }).items[0].masterProductId, 'COMMON-ONLY-1',
  '공통 마스터 전용상품의 실제 ID가 검색·선택·ORDER Q 원문 계약까지 유지되어야 한다.');
const editableMatchedRow = contract.normalizeRow({
  ...linkedCommonRow,
  specification: '10kg', quantity: 2, unit: 'BOX', unitPrice: 15000, memo: '유지 메모'
});
const identityEditedRow = contract.markProductEdit(editableMatchedRow, 'itemName', '사용자 수정 상품명');
assert.equal(identityEditedRow.productId, '');
assert.equal(identityEditedRow.masterProductId, '');
assert.equal(identityEditedRow.matchStatus, 'SIMILAR');
assert.equal(identityEditedRow.productIdentityStatus, 'UNRESOLVED');
assert.equal(identityEditedRow.itemName, '사용자 수정 상품명');
assert.equal(identityEditedRow.specification, '10kg');
assert.equal(identityEditedRow.quantity, 2);
assert.equal(identityEditedRow.unit, 'BOX');
assert.equal(identityEditedRow.unitPrice, 15000);
assert.equal(identityEditedRow.memo, '유지 메모');
for (const [field, value] of [['itemCode', 'NEW-1'], ['itemName', '새 상품'], ['specification', '20kg'], ['quantity', 3], ['unit', 'EA'], ['unitPrice', 17000]]) {
  assert.equal(contract.markProductEdit(editableMatchedRow, field, value)[field], value, `${field} must remain editable for matched rows`);
}

const draft = contract.createDraft({ now: Date.parse('2026-08-23T01:00:00.000Z'), random: 0.1 });
assert.equal(draft.activeMode, 'order');
assert.equal(draft.modes.order.header.orderDate, '2026-08-23');
assert.equal(draft.modes.order.header.recordedAt, '2026-08-23T01:00:00.000Z');
assert.equal(draft.modes.order.header.submittedAt, '');
assert.ok(draft.modes.order.documentId);
const storedDraft = JSON.parse(JSON.stringify(draft));
storedDraft.modes.order.header.orderDate = '1999-01-01';
assert.equal(contract.normalizeDraft(storedDraft).modes.order.header.orderDate, '2026-08-23', 'stored editable order dates must be replaced by the recorded current-time date');
assert.notEqual(draft.modes.order, draft.modes.purchase);
draft.modes.order.sourceText = '주문 원문';
assert.equal(draft.modes.purchase.sourceText, '');

const rawText = '  행복상회\n계란  2판\n';
const firstBatch = contract.createBatch({ batchId: 'B1', sequence: 1, method: 'text', sourceType: 'GENERAL_TEXT', rawText, now: 1 });
assert.equal(firstBatch.rawText, rawText, 'source whitespace and line breaks must be preserved');
const imageBatch = contract.createBatch({ sourceImageId: 'IMG-1', sourceImageHash: 'HASH-1' });
assert.equal(imageBatch.sourceImageId, 'IMG-1');
assert.equal(imageBatch.sourceImageHash, 'HASH-1');
const liveBatch = contract.createBatch({ batchId: 'LIVE', sourceRole: 'LIVE_SOURCE', automatic: true });
assert.equal(liveBatch.sourceRole, 'LIVE_SOURCE');
assert.equal(liveBatch.automatic, true);
let rows = contract.applyParserResults([], firstBatch, [{
  sourceLineKey: 'L1', intakeLineId: 'IL1', rawText: '계란  2판', productId: 'P1', masterProductId: 'MASTER-A001', itemCode: 'A001', itemName: '계란', quantity: 2, unit: '판'
}]);
assert.equal(rows.length, 1);
assert.equal(rows[0].matchStatus, 'MATCHED');
assert.equal(rows[0].masterProductId, 'MASTER-A001');
const syntheticOnlyRow = contract.normalizeRow({ productId: 'PRD-A002', itemCode: 'A002', itemName: '가짜 연결' });
assert.equal(syntheticOnlyRow.matchStatus, 'UNRESOLVED', '합성 productId만으로 실제 마스터 연결 처리하면 안 된다.');
assert.equal(syntheticOnlyRow.productIdentityStatus, 'UNRESOLVED');
rows[0] = contract.markUserEdit(rows[0], 'itemName', '관리자 확정 계란');
rows = contract.applyParserResults(rows, firstBatch, [{
  sourceLineKey: 'L1', intakeLineId: 'IL1', rawText: '계란  2판', productId: 'P1', masterProductId: 'MASTER-A001', itemCode: 'A001', itemName: '파서 덮어쓰기', quantity: 3, unit: '판'
}]);
assert.equal(rows.length, 1, 're-analysis of the same source line must update, not append');
assert.equal(rows[0].itemName, '관리자 확정 계란', 'administrator edits must survive re-analysis');
assert.equal(rows[0].quantity, 3, 'parser-owned fields may refresh');

const secondBatch = contract.createBatch({ batchId: 'B2', sequence: 2, method: 'paste', sourceType: 'CLIPBOARD', rawText: '계란 1판', now: 2 });
rows = contract.applyParserResults(rows, secondBatch, [{
  sourceLineKey: 'L2', rawText: '계란 1판', productId: 'P1', masterProductId: 'MASTER-A001', itemCode: 'A001', itemName: '계란', quantity: 1, unit: '판'
}]);
assert.equal(rows.length, 2, 'later batches must append below existing rows');
assert.equal(rows.filter(row => row.duplicatePossible).length, 2, 'duplicate products must be marked, not summed');

const orderDraft = draft.modes.order;
orderDraft.header = {
  ...orderDraft.header,
  customerId: 'C1', customerName: '행복상회', orderDate: '2026-08-23', warehouseName: '본사'
};
orderDraft.rows = rows;
assert.deepEqual(Array.from(contract.validateOrderDraft(orderDraft)), []);
const signedQuantityOrderDraft = {
  ...orderDraft,
  rows: rows.map((row, index) => ({ ...row, quantity: index === 0 ? 0 : -2 }))
};
assert.deepEqual(Array.from(contract.validateOrderDraft(signedQuantityOrderDraft)), [],
  'order quantity zero and negative values must remain valid');
const blankQuantityOrderDraft = {
  ...orderDraft,
  rows: rows.map((row, index) => ({ ...row, quantity: index === 0 ? '' : row.quantity }))
};
const blankQuantityError = contract.validateOrderDraft(blankQuantityOrderDraft).find(error => error.field === 'row:0:quantity');
assert.ok(blankQuantityError, 'blank order quantity must remain invalid');
assert.match(blankQuantityError.message, /0과 음수는 사용할 수 있습니다/);
orderDraft.header.customerId = '';
assert.equal(contract.validateOrderDraft(orderDraft)[0].field, 'customer');

const cutoffSettings = contract.normalizeSettings({
  orderCutoffTime: '12:00',
  allowSameDayDelivery: true,
  defaultDeliveryWeekdays: [0],
  timezone: 'Asia/Seoul'
});
assert.equal(contract.validateDeliveryDate({
  orderDate: '2026-08-23', deliveryDate: '2026-08-23', settings: cutoffSettings,
  now: new Date('2026-08-23T01:00:00.000Z')
}).valid, true, 'same-day delivery must remain available before cutoff');
assert.equal(contract.validateDeliveryDate({
  orderDate: '2026-08-23', deliveryDate: '2026-08-23', settings: cutoffSettings,
  now: new Date('2026-08-23T04:00:00.000Z')
}).code, 'CUTOFF_PASSED', 'same-day delivery must be blocked after cutoff');

const scheduleSettings = contract.normalizeSettings({
  defaultDeliveryWeekdays: [1, 3],
  deliveryCustomerWeekdays: { C1: [2] },
  holidayDates: ['2026-08-24'],
  timezone: 'Asia/Seoul'
});
const scheduleNow = new Date('2026-08-23T01:00:00.000Z');
assert.equal(contract.nextDeliveryDate({ orderDate: '2026-08-23', settings: scheduleSettings, now: scheduleNow }).date, '2026-08-26');
assert.equal(contract.nextDeliveryDate({ orderDate: '2026-08-23', customerId: 'C1', settings: scheduleSettings, now: scheduleNow }).date, '2026-08-25');
assert.equal(contract.validateDeliveryDate({ orderDate: '2026-08-23', deliveryDate: '2026-08-22', settings: scheduleSettings, now: scheduleNow }).code, 'PAST_DATE');

for (const mode of ['order', 'purchase', 'sale', 'estimate']) assert.match(html, new RegExp(`data-mode="${mode}"`));
assert.match(html, /data-method="voice"/);
for (const method of ['direct', 'excel', 'text', 'paste', 'photo']) assert.doesNotMatch(html, new RegExp(`data-method="${method}"`));
assert.match(html, /class="parser-toolbar"[^>]*>[\s\S]*data-method="voice"[\s\S]*class="legend"[\s\S]*id="clearParserButton"/,
  'the parser toolbar must contain only voice, match-status chips and clear controls in that order');
assert.match(html, /placeholder="텍스트·이미지·Excel 파일을&#10;붙여넣거나 끌어다 놓으세요\.&#10;입력 내용을 자동으로 분석합니다\."/);
assert.match(html, /Alt\+1/);
assert.match(html, /Alt\+2/);
assert.match(html, /Alt\+3/);
assert.match(html, /Alt\+4/);
assert.match(html, /href="\.\.\/orderq\/index\.html" target="_blank" rel="noopener"/);
assert.match(html, /href="\.\.\/orders\.html" target="_blank" rel="noopener"/);
assert.match(html, /<nexus-top app-id="smart-input">/);
assert.match(html, /nexus\/common\/apps-config\.js/);
assert.match(html, /nexus\/common\/nexus-top\.js/);
assert.match(html, /id="draftListButton"/);
assert.match(html, /id="saveState"[^>]*aria-live="polite"[^>]*><\/span>/);
assert.match(html, /id="settingsButton"/);
assert.match(html, /id="taxCustomerInput"/);
assert.match(html, /id="taxCustomerInput" type="hidden"/);
assert.doesNotMatch(html, /data-header-field="taxCustomer"/);
assert.doesNotMatch(html, /id="orderDateInput"/);
assert.doesNotMatch(html, /class="stage-rail"/);
assert.match(html, /id="activityTrail"[^>]*aria-live="polite"[^>]*hidden/);
assert.match(html, /id="activityItems" aria-label="누적 입력현황"/);
assert.match(html, /id="clearParserButton"[^>]*>[^<]*<span[^>]*>↻<\/span> 지우기<\/button>/,
  'the parser must expose an explicit clear control beside its activity history');
assert.doesNotMatch(html, /class="parser-card__header"/);
assert.doesNotMatch(html, /<th>원문<\/th>|class="col-source"/);
assert.doesNotMatch(html, /<th>차수<\/th>|<th>상태<\/th>/);
for (const heading of ['품목코드', '품목명', '규격', '수량', '단위', '단가', '공급가액', '메모', '적요(직원)', '공지단가']) {
  assert.match(html, new RegExp(`<th data-column="[^"]+">${heading.replace(/[()]/g, '\\$&')}<\\/th>`));
}
assert.match(html, /id="sourceHighlight"/);
assert.match(html, /id="photoViewer"[^>]*hidden/);
assert.match(html, /id="photoPreview"/);
assert.match(html, /id="photoZoomOut"/);
assert.match(html, /id="photoZoomIn"/);
assert.match(html, /id="photoRotateLeft"/);
assert.match(html, /id="photoRotateRight"/);
assert.match(html, /id="photoOcrToggle"/);
assert.match(html, /id="photoOcrPanel"[^>]*hidden/);
assert.match(html, /id="photoResizer"[^>]*aria-label="파서 입력창과 입력표 폭 조절"/);
assert.doesNotMatch(html, /id="photoResizer"[^>]*hidden/,
  'the parser/workbench horizontal resizer must remain available on desktop');
assert.match(html, /id="photoEmptyState"/);
assert.match(html, /id="photoEmptySelectButton"/);
assert.match(html, /id="photoViewerToolbar"[^>]*hidden/);
assert.match(html, /legend--matched">일치/);
assert.match(html, /legend--similar">유사/);
assert.match(html, /legend--failed">불일치/);
assert.match(html, /id="detailColumnsButton"[^>]*hidden/);
assert.match(html, /<th data-column="status">상태<\/th>/);
assert.doesNotMatch(html, /id="mobilePhotoTabs"|data-photo-pane=/);
assert.doesNotMatch(html, /id="estimateListButton"|>견적 목록</);
assert.match(html, /id="estimateOutputActions"[^>]*hidden/);
assert.match(html, /id="estimateNoticeButton"[^>]*>카톡 복사</);
assert.match(html, /id="estimateExcelButton"[^>]*>견적 Excel</);
assert.match(html, /id="catalogPickerButton"/);
assert.match(html, /id="catalogPickerMenu"[^>]*popover="auto"/);
assert.match(html, /id="catalogPickerList"/);
assert.match(html, /id="catalogSaveButton"/);
assert.match(html, /id="catalogNewButton"[^>]*>새 견적서<\/button>/);
assert.match(html, /id="catalogComposeButton"[^>]*>선택 상품 불러오기<\/button>/);
assert.doesNotMatch(html, /id="catalogSelect"|id="catalogDeleteButton"|id="catalogBatchButton"/);
assert.match(html, /견적서 선택 · 상품 조합/);
assert.match(html, /선택 항목은 상품 불러오기·카톡·Excel에 함께 사용됩니다/);
assert.match(html, /id="catalogSaveButton"[^>]*>저장<\/button>/);
assert.doesNotMatch(html, /카탈로그 · 거래처 자동 지정|카탈로그 선택|카탈로그 저장/);
assert.ok(html.indexOf('class="app-voucher-switcher"') < html.indexOf('class="app-bar__actions"'), '전표 선택은 앱 헤더의 작업 버튼 앞에 있어야 한다.');
assert.doesNotMatch(html, /class="field field--mode"/, '전표 선택은 본문 상단 정보 영역에 남아 있으면 안 된다.');
assert.match(html, /nexus-theme-init\.js/);
assert.match(html, /brand__logo--light[^>]*logo-light\.png/);
assert.match(html, /brand__logo--dark[^>]*logo-dark\.png/);
assert.match(html, /class="document-fields__left"[\s\S]*id="deliveryDateInput"[\s\S]*id="warehouseInput"[\s\S]*id="transactionTypeInput"/,
  'delivery date, warehouse, and transaction type must share the left side of the unified header');
assert.match(html, /class="document-fields__right"[\s\S]*id="customerInput"[\s\S]*id="catalogPickerButton"[\s\S]*id="estimateNoticeButton"/,
  'customer, estimate selection, and Kakao copy must share the right side of the unified header');
assert.doesNotMatch(html, /class="grid-card__header"|id="gridTitle"|>표준 입력표</,
  'the duplicate table title header must be removed to expose more rows');
assert.match(html, /id="selectAllRows"/);
assert.match(html, /id="deleteSelectedRows"/);
assert.match(html, /class="col-unit"/);
assert.match(html, /class="voucher-footer-actions"[\s\S]*id="resetDraftButton"[^>]*>[\s\S]*전표 초기화[\s\S]*id="saveDraftButton"[^>]*>저장<\/button>/,
  'voucher reset and save controls must live below the input table');
const appBarHtml = html.slice(html.indexOf('<header class="app-bar">'), html.indexOf('</header>') + 9);
assert.doesNotMatch(appBarHtml, /id="resetDraftButton"|id="saveDraftButton"/,
  'voucher reset and save controls must not remain in the top application bar');
assert.doesNotMatch(html, /작업 단계|\d+\s*\/\s*5|data-stage=/);
const parserColumnAt = html.indexOf('<section class="parser-card"');
const workbenchColumnAt = html.indexOf('<section class="workbench"');
const relatedColumnAt = html.indexOf('<aside class="related-panel"');
assert.ok(parserColumnAt >= 0 && parserColumnAt < workbenchColumnAt && workbenchColumnAt < relatedColumnAt,
  'desktop workspace must order the parser, workbench and related-app columns from left to right');

assert.match(css, /--parser-pane-width: clamp\(360px, 26vw, 760px\)/);
assert.match(css, /grid-template-columns: minmax\(330px, min\(var\(--parser-pane-width\), calc\(100% - 806px\)\)\) 8px minmax\(0, 1fr\) 230px/,
  'desktop parser width must remain adjustable while the table and related panel keep their own columns');
assert.match(css, /--app-max: 2400px/);
assert.match(css, /\.app-shell \{[^}]*calc\(100% - 32px\)/,
  'desktop SmartInput must use the viewport instead of leaving wide side margins');
assert.match(css, /\.parser-card \{[^}]*position: sticky;[^}]*padding: 14px;[^}]*border: 1px solid var\(--border\)/);
assert.match(css, /\.source-highlight, \.source-editor textarea \{[^}]*height: clamp\(360px, calc\(100vh - 340px\), 660px\);[^}]*overflow: auto;/);
assert.match(css, /font: 15px\/1\.72 ui-monospace/);
assert.match(css, /table \{[^}]*font-size: 12px/);
assert.match(css, /\.column-resize-handle \{/);
assert.match(css, /html\.smartinput-column-resizing/);
assert.match(css, /\.smart-form \[hidden\] \{ display: none; \}/,
  'inactive field-library controls must not remain visible beside product fields');
assert.match(css, /\.settings-group > summary strong \{ font-size: 13px; \}/,
  'settings groups must remain readable at the enlarged application scale');
assert.match(css, /\.source-editor textarea \{[^}]*resize: none;/);
assert.match(css, /\.source-editor\[hidden\] \{ display: none; \}/,
  '사진 모드에서는 OCR 문자 편집기가 레이아웃 공간을 차지하면 안 된다.');
assert.match(css, /\.photo-viewer__viewport \{[^}]*overflow: auto;/);
assert.match(css, /\.photo-viewer__viewport \{[^}]*background: #f8fafc;/);
assert.match(css, /\.photo-viewer\.has-image \.photo-viewer__viewport \{/);
assert.match(css, /\.photo-empty-state \{/);
assert.match(css, /\.analyze-button\[hidden\], \.parser-progress\[hidden\] \{ display: none; \}/);
assert.match(css, /\.photo-viewer__region \{/);
assert.match(css, /\.workspace\.has-photo-source \{[^}]*grid-template-columns: minmax\(370px, min\(var\(--parser-pane-width\), calc\(100% - 806px\)\)\) 8px minmax\(0, 1fr\) 230px;/,
  'photo input must share the saved parser width without overflowing its workbench');
assert.match(css, /\.document-fields \{[^}]*grid-template-columns: minmax\(330px, \.72fr\) minmax\(0, 1\.45fr\)/);
assert.match(css, /\.document-fields__left \{[^}]*grid-template-columns: repeat\(3, minmax\(110px, 1fr\)\)/);
assert.match(css, /\.document-fields__right \{[^}]*display: flex;[^}]*justify-content: flex-end/);
assert.match(css, /\.workbench \{[^}]*gap: 10px/,
  'the unified header must reduce vertical spacing above the table');
assert.match(css, /\.workspace\.has-photo-source \.parser-card, \.workspace\.has-photo-source \.workbench \{[^}]*height: calc\(100vh - var\(--nexus-top-height\) - 88px\)/);
assert.match(css, /\.photo-ocr-panel \{/);
assert.match(css, /\.photo-resizer \{/);
assert.match(css, /\.row-status \{/);
assert.match(css, /td\.is-price-review-pending::before \{/);
assert.match(css, /\.source-token--user/);
assert.match(css, /\.source-token--time/);
assert.match(css, /\.source-token--collected/);
assert.match(css, /\.source-token--unmatched/);
assert.match(css, /\.save-state \{[^}]*flex: 0 0 64px;[^}]*width: 64px;[^}]*white-space: nowrap;/);
assert.match(css, /@media \(max-width: 1480px\) \{[^}]*grid-template-columns: minmax\(330px, min\(var\(--parser-pane-width\), calc\(100% - 502px\)\)\) 8px minmax\(0, 1fr\)/,
  'related apps must yield width while the ordinary desktop parser remains resizable');
assert.match(css, /@media \(max-width: 1240px\) \{[\s\S]*?\.photo-resizer, \.workspace\.has-photo-source \.photo-resizer \{ display: none; \}/,
  'the horizontal resizer must disappear only after the workspace stacks');
assert.match(css, /@media \(min-width: 1481px\) \{[\s\S]*?html, body \{[^}]*overflow: hidden;/,
  'wide desktop SmartInput must not create a page-level vertical scrollbar');
assert.match(css, /@media \(min-width: 1481px\) \{[\s\S]*?\.workspace \{[^}]*height: 100%;[^}]*align-items: stretch;/,
  'the three wide-desktop workspace columns must share the available viewport height');
assert.match(css, /@media \(min-width: 1481px\) \{[\s\S]*?\.workbench, \.workspace\.has-photo-source \.workbench \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/,
  'the document header must remain fixed above the flexible input grid');
assert.match(css, /@media \(min-width: 1481px\) \{[\s\S]*?\.table-scroll, \.workspace\.has-photo-source \.table-scroll \{[^}]*flex: 1 1 auto;[^}]*height: auto;[^}]*overflow: auto;/,
  'only the input table body must scroll when rows exceed the available height');
assert.match(css, /@media \(max-width: 1180px\)/);
assert.match(css, /@media \(max-width: 1400px\) \{[\s\S]*?\.workspace\.has-photo-source \{ grid-template-columns: minmax\(0, 1fr\); \}/,
  'photo mode must stack before the workbench becomes too narrow around 1335px');
assert.match(css, /\.parser-card \{[^}]*overflow: hidden;/,
  'parser children must not escape the assigned parser column');
assert.match(css, /\.parser-card > \*, \.parser-input-row, \.parser-toolbar, \.photo-viewer, \.photo-viewer__toolbar, \.photo-viewer__viewport \{[^}]*width: 100%;[^}]*max-width: 100%;/,
  'parser controls and photo viewer must shrink within their parent width');
assert.match(css, /table \{[^}]*width: var\(--table-render-width, 1103px\);[^}]*min-width: 0;[^}]*max-width: none;/,
  'the input table must use the visible-column sum and leave unused space blank');
assert.match(css, /\.column-draggable \{ cursor: grab; \}/);
assert.match(css, /\.smart-dialog footer\[hidden\] \{ display: none; \}/,
  'hidden customer dialog footer must override the generic flex footer rule');
assert.match(css, /\.column-drop-before \{[^}]*inset 3px 0 0 var\(--accent\)/);
assert.match(css, /@media \(max-width: 1240px\) \{[\s\S]*?\.workspace, \.workspace\.has-photo-source \{ grid-template-columns: minmax\(0, 1fr\); \}/,
  'photo and input workspaces must stack before their minimum widths collide');
assert.match(css, /@media \(max-width: 980px\)/);
assert.match(css, /@media \(max-width: 820px\)/);
assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*?\.app-bar__actions \{[^}]*overflow-x: auto;/,
  'tablet action buttons must scroll within the app bar instead of widening the page');
assert.match(css, /@media \(max-width: 560px\) \{[\s\S]*?\.document-fields, \.workspace\.has-photo-source \.document-fields \{ grid-template-columns: 1fr;/,
  'mobile document fields must collapse to one touch-friendly column');
assert.match(css, /\.parser-card, \.related-panel, \.workbench, \.document-fields, \.grid-card, \.table-scroll \{[^}]*min-width: 0;[^}]*max-width: 100%;/,
  'nested workspace cards must be allowed to shrink inside the responsive grid');
assert.match(css, /html\[data-nexus-theme="dark"\] \.brand__logo--light \{ display: none; \}/);
assert.match(css, /html\[data-nexus-theme="dark"\] \.brand__logo--dark \{ display: block; \}/);
assert.doesNotMatch(css, /prefers-color-scheme: dark/);
assert.match(css, /prefers-reduced-motion: reduce/);

for (const required of [
  'captureTextIntake',
  'extractOrderProductLines',
  'analyzeSingleOrderDocument',
  'rematchExtractedLinesForCustomer',
  'createOrder',
  'syncAfterLocalMutation',
  'loadProductCatalog',
  'createLiveCustomer',
  'loadSmartInputData',
  'saveLinkGroup',
  'saveAliasMapping',
  'orderCutoffTime',
  'deliveryCustomerWeekdays',
  'window.Tesseract',
  'SpeechRecognition',
  'captureOccurrenceId',
  'looksLikeKakaoText',
  'appendDeliveryHistory'
]) assert.match(appSource, new RegExp(required));
assert.match(appSource, /extractOrderProductLines\(\{ sourceType: batch\.sourceType, sourceId: 'SMART_INPUT', rawText \}\)/,
  'SmartInput fallback must use the same behavioral order-line extractor as SmartParser');
assert.doesNotMatch(appSource, /split\('\\n'\)\.map\(\(raw, index\)/,
  'SmartInput fallback must not turn every non-empty source line into a product row');
assert.match(appSource, /customerInput'\)\.focus\(\)/);
assert.match(appSource, /SMART_INPUT:\$\{current\.batches\[0\]/);
assert.match(appSource, /editedFields/);
assert.match(appSource, /다음 가능일은 \$\{nextAvailable\.date\}입니다/);
assert.match(appSource, /mappingSource: 'PARSER_CONFIRMED', learnAlias: false/);
assert.match(appSource, /row\.masterProductId = String\(product\.masterProductId/);
assert.match(appSource, /masterProductId: masterLinked \? row\.masterProductId : null/);
assert.match(appSource, /commonMasterProducts\(\)/);
assert.match(appSource, /description: row\.description/);
assert.match(appSource, /noticePrice: row\.noticePrice/);
assert.match(appSource, /일치 \$\{summary\.matched\} · 확인 \$\{summary\.similar\} · 미인식 \$\{summary\.unresolved\}/);
assert.match(appSource, /function renderActivityTrail\(\)/);
assert.match(appSource, /function visibleActivityBatches\([\s\S]*batch\.sourceType !== 'MANUAL'[\s\S]*batch\.method !== 'direct'/,
  'direct-entry rows must not create visible input-activity chips');
assert.match(appSource, /sequence: visibleActivityBatches\(current\)\.length \+ 1/,
  'direct-entry rows must not inflate the displayed source-analysis sequence');
assert.match(appSource, /function scheduleAutoAnalysis\(/);
assert.match(appSource, /analyzeSource\(\{ automatic: true \}\)/);
assert.match(appSource, /current\.sourceText = rawText/);
const analyzeSourceBlock = appSource.slice(appSource.indexOf('async function analyzeSource'), appSource.indexOf('async function handleFile'));
assert.doesNotMatch(analyzeSourceBlock, /current\.sourceText = '';/, 'ordinary parser analysis must not clear the preserved source text');
assert.match(appSource, /sourceRole: 'LIVE_SOURCE'/);
assert.match(appSource, /function renderSourceAnalysis\(\)/);
assert.match(appSource, /source-token--user/);
assert.match(appSource, /source-token--time/);
assert.match(appSource, /source-token--collected/);
assert.match(appSource, /source-token--unmatched/);
assert.match(appSource, /contract\.markProductEdit\(modeDraft\(\)\.rows\[index\], field, input\.value\)/);
assert.match(appSource, /function tryMatchRow\(row, changedField = '', \{ focusTarget = null \} = \{\}\)/);
const parserEnrichmentSource = appSource.slice(appSource.indexOf('function enrichRowFromUnifiedCatalog'), appSource.indexOf('function rematchQuery'));
assert.doesNotMatch(parserEnrichmentSource, /candidates\.length === 1[\s\S]*applyProduct/,
  'parser fuzzy candidates must stay in confirmation state even when only one candidate exists');
assert.match(parserEnrichmentSource, /row\.matchStatus = 'SIMILAR'/);
assert.match(appSource, /if \(changedField === 'itemName'\) return row\.itemName \|\| row\.itemCode/);
assert.match(appSource, /applyProduct\(row, exact, \{ forceIdentityFields: true \}\)/);
assert.match(appSource, /const liveRow = modeDraft\(\)\.rows\.find\(item => item\.rowId === row\.rowId\) \|\| row;[\s\S]*if \(openCandidates\) openProductDialog\(liveRow/,
  'candidate selection must receive the current row object after duplicate detection replaces row objects');
assert.match(appSource, /applyProduct\(liveRow, product, \{ forceIdentityFields: true \}\)/,
  'candidate confirmation must update the live row instead of a stale row reference');
assert.match(appSource, /\['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'\][\s\S]*tryMatchRow\(row, field, \{ focusTarget \}\)/);
assert.match(appSource, /data-field="specification"/);
assert.match(appSource, /data-field="unit"/);
assert.doesNotMatch(appSource, /data-match-row|item-match-action|>Fn<|rowStatusLabel/);
assert.match(appSource, /first 번째 항목|첫 번째 항목/);
assert.match(appSource, /let selectedIndex = 0/);
assert.match(appSource, /state\.products\.filter\(isSelectableMasterProduct\)/,
  '상품 후보는 실제 공통 마스터의 완전한 상품으로 제한해야 한다.');
assert.match(appSource, /if \(!row \|\| !isSelectableMasterProduct\(product\)\) return false/,
  '마스터가 아닌 상품은 선택 확정 단계에서도 차단해야 한다.');
assert.match(appSource, /event\.key === 'ArrowDown'[\s\S]*updateSelection\(selectedIndex \+ 1\)/);
assert.match(appSource, /event\.key === 'ArrowUp'[\s\S]*updateSelection\(selectedIndex - 1\)/);
assert.match(appSource, /button\.scrollIntoView\(\{ block: 'nearest' \}\)/);
assert.match(appSource, /if \(foundProducts\[selectedIndex\]\) finish\(foundProducts\[selectedIndex\]\)/);
assert.match(appSource, /resetCurrentMode\(false\)/);
assert.match(appSource, /function saveAndStartNextVoucher\(\)[\s\S]*if \(!saveDraftNow\(\)\)[\s\S]*resetCurrentMode\(false, '전표를 저장하고 다음 입력을 시작합니다\.'/,
  'saving a voucher must preserve its draft snapshot before opening a fresh voucher');
assert.match(appSource, /saveDraftButton'\)\.addEventListener\('click', saveAndStartNextVoucher\)/,
  'the voucher save action must immediately prepare the next voucher entry');
assert.match(appSource, /function clearParserWorkspace\(\)/);
assert.match(appSource, /current\.batches = \(current\.batches \|\| \[\]\)\.filter\(batch => batch\.sourceType === 'MANUAL'\)/,
  'parser clear must preserve direct-entry batches while dropping parser batches');
assert.match(appSource, /state\.sourceImages\[state\.draft\.activeMode\] = null/,
  'parser clear must detach the current source photo');
assert.match(appSource, /const PARSER_ERROR_LABEL = [^;]+/);
assert.match(appSource, /if \(PARSER_ERROR_LABEL\.test\(productText\)\) return true/,
  'short bracketed parser error labels must not become product-name rows');
assert.match(appSource, /function armItemCodeEntry\(\)/);
assert.match(appSource, /if \(mappingSource === 'MANUAL'\) armItemCodeEntry\(\)/,
  'manual customer selection must move directly to the first item-code cell');
assert.match(appSource, /data-customer-use/);
assert.match(appSource, /data-tax-register/);
assert.match(appSource, /거래처 앞 체크박스/);
assert.match(appSource, /if \(!linkMode\) selected\.clear\(\)/, 'normal customer selection must keep only one checked customer');
assert.match(appSource, /memberCustomerIds: \[customerId\][\s\S]*taxCustomerId: customerId/, 'an unlinked formal customer must become a one-member tax group when registered');
assert.match(appSource, /data-link-mode>거래처 관계 설정</);
assert.match(appSource, /deliveryCustomerIds: \[customerId\]/,
  'one formal customer can hold both delivery and tax roles');
assert.match(appSource, /if \(selected\.size < 1\)[\s\S]*배송처를 1곳 이상 선택하세요/);
assert.match(appSource, /if \(!selectedTaxCustomerId\)[\s\S]*세무거래처를 정확히 1곳 지정하세요/);
assert.match(appSource, /await persistLinkGroup\(group\);\s*finish\(deliveryCustomer\);/,
  'saving a customer relationship must apply the chosen delivery customer to the active voucher');
assert.match(appSource, /deliveryCustomerIds = \[\.\.\.selected\]/);
assert.doesNotMatch(appSource, /연결할 거래처를 2개 이상/,
  'customer relationship setup must not require two or more records');
assert.match(appSource, /const isTax = hasRelationship && group\?\.taxCustomerId === customerItem\.customerId/,
  'tax badges must also appear for one-to-one relationships');
assert.match(appSource, /dialog\.showModal\(\);[\s\S]*refreshCustomers\(\{ syncIfEmpty: true \}\)/, 'customer dialog must open before background master refresh completes');
assert.match(appSource, /withTimeout\(listCustomers\(\{ includeInactive: false \}\), 5000/, 'startup customer loading must have a bounded wait');
assert.doesNotMatch(appSource, /function openEstimateListDialog\(\)/);
assert.match(appSource, /function openEstimateNoticePreview\(\)/);
assert.match(appSource, /function exportEstimateExcel\(\)/);
assert.match(appSource, /function openEstimateSaveDialog\(\)/);
assert.match(appSource, /function openEstimateManageDialog\(record\)/);
assert.match(appSource, /function normalizeEstimateOrder\(records = state\.estimates\)/);
assert.match(appSource, /async function saveEstimateDocument\(catalogName\)/);
assert.doesNotMatch(appSource, /data-settings-group="estimate-notice"/,
  'Kakao notice price filters must not remain buried in environment settings');
assert.match(appSource, /data-notice-price-primary/);
assert.match(appSource, /data-notice-price-secondary/);
assert.match(appSource, /사용 안 함/);
assert.match(appSource, /persistPriceFields/,
  'Kakao notice preview price filters must persist the latest selection');
assert.match(appSource, /data-output-estimate/);
assert.match(appSource, /data-edit-estimate/);
assert.match(appSource, /function selectedEstimateRecords\(\)[\s\S]*availableCatalogs\(\)\.filter\(record => selectedIds\.has\(record\.estimateId\)\)/,
  'estimate composition and outputs must use checked estimates in stored library order');
assert.match(appSource, /function combinedEstimateRows\(records = selectedEstimateRecords\(\)\)/);
assert.match(appSource, /function composeSelectedEstimates\(\)[\s\S]*startNewCatalog\(\)[\s\S]*current\.rows = rows/,
  'selected saved estimates must compose a new editable estimate');
assert.match(appSource, /noticeSources\.flatMap/,
  'Kakao notice preview must render selected companies in sequence');
assert.match(css, /\.catalog-picker__heading, \.catalog-picker__row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 76px 48px/,
  'the estimate picker must expose name, bulk-output checkbox, and management controls');
assert.match(css, /\.estimate-notice-filters \{[^}]*position: absolute;/,
  'Kakao notice price filters must be placed over the preview header');
const saveEstimateSource = appSource.match(/function validateEstimateDocument\(\)[\s\S]*?(?=\nasync function completeOrder\(\))/)?.[0] || '';
const validateEstimateSource = appSource.match(/function validateEstimateDocument\(\)[\s\S]*?(?=\nfunction openEstimateSaveDialog\(\))/)?.[0] || '';
assert.match(saveEstimateSource, /current\.rows\.findIndex\(row => !row\.itemCode && !row\.itemName\)/,
  'estimate saving must require a product identity');
assert.doesNotMatch(saveEstimateSource, /row\.quantity/,
  'estimate saving must allow rows without quantity');
assert.doesNotMatch(validateEstimateSource, /header\.customerId|배송 거래처를 선택하세요/,
  'estimate saving must not require a customer');
assert.match(appSource, /function applyFormLayout\(\)/);
assert.match(appSource, /function headerFieldsForMode\(/);
assert.match(appSource, /function voucherColumnsForMode\(/);
assert.match(appSource, /function applyVoucherColumnOrder\(/);
assert.match(appSource, /function beginColumnDrag\(/);
assert.match(appSource, /function finishColumnDrop\(/);
assert.match(appSource, /voucherTableHead\.addEventListener\('dragstart', beginColumnDrag\)/);
assert.match(appSource, /voucherTableHead\.addEventListener\('drop', finishColumnDrop\)/);
assert.doesNotMatch(appSource, /class="settings-group" open/,
  'environment settings must open with every accordion group closed');
assert.match(appSource, /smart-settings-grid'\)\.append\(deliverySettingsGroup\)/,
  'delivery policy must be moved to the bottom of the settings groups');
assert.match(appSource, /data-add-layout-field="header"/);
assert.match(appSource, /data-add-layout-field="voucher"/);
assert.match(appSource, /data-settings-layout-mode/);
assert.match(appSource, /headerFieldsByMode: workingHeaderFieldsByMode/);
assert.match(appSource, /voucherColumnsByMode: workingVoucherColumnsByMode/);
assert.match(appSource, /inputOrderByMode: workingInputOrderByMode/);
assert.match(appSource, /data-input-order-field/);
assert.match(appSource, /function enterGridFields\(\)/);
assert.match(appSource, /\.filter\(item => Number\.isFinite\(item\.order\) && item\.order > 0\)/,
  'input order zero must be skipped during Enter navigation');
assert.match(appSource, /scope === 'voucher' \? sourceDefinitions/,
  'voucher settings must use the canonical product-field dictionary order');
assert.match(css, /\.settings-group:not\(\[open\]\) > \.settings-group__body \{ display: none; \}/,
  'closed settings groups must not leave empty body space');
assert.match(css, /\.settings-layout-modes \{[^}]*grid-template-columns: repeat\(4,/,
  '전표별 상단 정보 열과 표시 열은 주문서·구매·판매·견적서 선택 탭을 제공해야 한다.');
assert.match(css, /\.app-voucher-switcher \.mode-tabs \{[^}]*border: 2px solid var\(--voucher-accent\);[^}]*background: transparent;/,
  '헤더의 전표 선택은 주황색 보더와 투명 배경을 유지해야 한다.');
assert.match(css, /\.app-voucher-switcher \.mode-tab\.is-active \{[^}]*background: transparent;[^}]*inset 0 -3px 0 var\(--voucher-accent\)/,
  '헤더의 선택 전표는 배경 채움 대신 라인으로만 표시해야 한다.');
assert.match(css, /\.parser-toolbar \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;/,
  '파서 상단은 음성·상태칩·지우기의 한 줄 구조여야 한다.');
assert.match(appSource, /parserCard\.addEventListener\('dragover'/);
assert.match(appSource, /parserCard\.addEventListener\('drop',[^\n]*acceptParserDrop/,
  '파서 전체가 텍스트·이미지·문서 파일 끌어놓기를 받아야 한다.');
assert.match(appSource, /isParserDocumentFile\(file\)/);
assert.match(appSource, /isImageFile\(file\)/);
assert.match(appSource, /parserCard\.contains\(event\.target\) && pastedText/,
  'plain-text paste must work anywhere inside the parser, including after photo input');
assert.match(appSource, /updateMethod\('text', \{ persist: false \}\)/,
  'clearing a photo source must return the parser to direct text input');
assert.match(css, /\.voucher-footer-actions \{[^}]*justify-content: flex-end;[^}]*border-top: 1px solid var\(--border\)/,
  '전표 작업 버튼은 입력표 하단의 독립 작업줄에 배치해야 한다.');
assert.match(appSource, /거래처정보/);
assert.match(appSource, /부가정보 · 사용자지정/);
assert.match(appSource, /function openLayoutFieldDialog\(/);
assert.match(appSource, /contract\.PRODUCT_FIELD_DEFINITIONS/,
  'the field picker must expose the complete product information library');
assert.match(appSource, /사용자지정 항목은 최대 10개/,
  'custom text and number field creation must enforce the ten-field limit');
assert.match(css, /\.smart-settings-dialog \{ height: min\(720px, calc\(100dvh - 28px\)\); \}/,
  '환경설정 바깥 창은 그룹 개폐와 무관하게 고정 높이를 유지해야 한다.');
assert.match(css, /\.smart-settings-dialog \.smart-settings-grid \{[^}]*flex: 1 1 auto;[^}]*scrollbar-gutter: stable;/,
  '환경설정 그룹은 고정 창 내부에서만 스크롤되어야 한다.');
assert.match(appSource, /data-custom-header-input/);
assert.match(appSource, /data-custom-row-field/);
assert.match(appSource, /customValues: \{ \.\.\.\(current\.header\.customValues/);
assert.match(orderIntakeSource, /customValues: input\.customValues/);
assert.match(orderIntakeSource, /formLayoutSnapshot: payload\.formLayoutSnapshot/);
assert.match(appSource, /recognizeOcrDocument/);
assert.match(appSource, /verifiedRowsToParserLines/);
assert.match(appSource, /function renderPhotoTransform\(\)/);
assert.match(appSource, /function showPhotoRegion\(region\)/);
assert.match(appSource, /function renderPhotoRegion\(\)[\s\S]*?marker\.hidden = !region;/,
  'row focus must update only the photo-region marker');
const showPhotoRegionSource = appSource.match(/function showPhotoRegion\(region\) \{[\s\S]*?\n\}/)?.[0] || '';
assert.doesNotMatch(showPhotoRegionSource, /renderSourceSurface|renderPhotoTransform|scrollIntoView/,
  'row focus must not rerender, resize, or scroll the source photo');
assert.match(appSource, /sourceImages: \{ order: null, purchase: null, sale: null, estimate: null \}/);
assert.match(appSource, /intakeSessionId: sourceBatch\?\.intakeSessionId \|\| ''/);
assert.match(appSource, /photoBasicColumns = new Set\(\['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'supplyAmount'\]/);
assert.match(appSource, /state\.photoView\.detailColumns = !state\.photoView\.detailColumns/);
assert.match(appSource, /modeUi\(\)\.detailColumns = state\.photoView\.detailColumns;[\s\S]*scheduleSave\(\);[\s\S]*applyFormLayout\(\);/,
  'the selected photo detail-column layout must persist for the active voucher mode');
assert.match(appSource, /state\.photoView\.detailColumns = Boolean\(modeUi\(\)\.detailColumns\);[\s\S]*updateMethod\(modeDraft\(\)\.activeMethod/,
  'rendering a voucher mode must restore its saved detail-column layout');
assert.match(appSource, /photoResizer\.addEventListener\('pointermove'/);
assert.match(appSource, /photoResizer\.addEventListener\('keydown'[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*applyParserPaneWidth/,
  'the parser width resizer must also support precise left/right keyboard adjustment');
assert.match(appSource, /state\.draft\.ui\.parserPaneWidth = width/,
  'the adjusted parser width must persist in the draft UI state');
assert.match(appSource, /if \(modeDraft\(\)\.activeMethod !== 'photo'\) updateMethod\('direct'\)/,
  '사진 분석 중 빈 행을 추가해도 원본 사진 작업영역을 유지해야 한다.');
assert.match(appSource, /const DEFAULT_INPUT_ROW_ID = '__SMARTINPUT_DEFAULT_ROW__'/);
assert.match(appSource, /const displayedRows = rows\.length \? rows : \[defaultRow\]/,
  'an immediately editable first row must be shown without pressing add-row');
assert.match(appSource, /function materializeDefaultRow\(tr\)/,
  'the visual default row must become persistent only after the user types');
assert.match(appSource, /function normalizedCustomerCandidates\(customers = \[\]\)/);
assert.match(appSource, /customer\.qualityStatus === 'SUPERSEDED'/,
  'superseded customer rows must not appear in SmartInput search');
assert.match(appSource, /if \(!locationKey\) return false;[\s\S]*return !identifiedLocations\.has\(locationKey\)/,
  'a code-less shadow must be removed while a distinct delivery location remains selectable');
assert.match(appSource, /'코드 미등록'/,
  'a standalone code-less customer must be labelled instead of rendering a blank identity');
assert.match(appSource, /applyProduct\(row, exact, \{ forceIdentityFields: true \}\)/,
  'confirmed product matching must replace the search text with master code and name');
assert.match(appSource, /function sequentialGridTarget\(rowId, field\)/,
  'Enter navigation must follow the complete visible cell sequence');
assert.match(appSource, /function directionalGridTarget\(rowId, field, key\)/,
  'arrow navigation must move to adjacent visible cells');
assert.match(appSource, /inputRows\.addEventListener\('focusin',[\s\S]*requestAnimationFrame\([\s\S]*document\.activeElement !== input[\s\S]*input\.select/,
  'focusing a standard-input cell must select its current value so typing replaces it');
assert.match(appSource, /const editableInput = event\.target\.closest\('\[data-product-search\], \[data-field\], \[data-custom-row-field\]'\);[\s\S]*if \(tr && !editableInput && modeDraft\(\)\.activeMethod === 'photo'\)/,
  'a grid-input click must not repeat the photo-region update already handled by focus');
assert.match(appSource, /function revealGridInput\(input\)[\s\S]*visibleBottom = scrollBounds\.bottom - footerHeight[\s\S]*scroll\.scrollTop \+= rowBounds\.bottom - visibleBottom/,
  'the active input row must scroll above the sticky totals row when it reaches the table bottom');
assert.match(appSource, /input\.select\?\.\(\);\s*revealGridInput\(input\);/,
  'mouse, touch, and keyboard focus must reveal the active standard-input cell');
assert.doesNotMatch(appSource, /activeCellId = `\$\{row\.rowId\}\|quantity`/,
  'product matching must not skip populated product-information cells');
assert.match(appSource, /data-select-row/);
assert.match(appSource, /function deleteSelectedGridRows\(\)/);
assert.match(appSource, /function beginColumnResize\(/);
assert.match(appSource, /await saveSettings\(state\.settings\)/,
  'resizing a standard-input column must persist its width directly');
assert.match(appSource, /pendingOcr\.status !== 'VERIFIED'/);
assert.doesNotMatch(appSource, /Tesseract\.recognize\(file, 'kor\+eng'/, 'raw one-pass OCR must not feed the order parser directly');
assert.match(appSource, /function hasMeaningfulDraftContent\(draft\)/);
assert.match(appSource, /rows\.filter\(hasMeaningfulDraftContent\)/);
assert.match(appSource, /state\.draftDirty = true;[\s\S]*setSaveState\('저장 중…', 'saving'\)/);
assert.match(appSource, /updateMethod\(modeDraft\(\)\.activeMethod, \{ persist: false \}\)/);
assert.match(appSource, /window\.addEventListener\('pagehide', \(\) => \{\s*if \(state\.draftDirty\) saveDraftNow\(\);\s*\}\)/);
assert.doesNotMatch(appSource, /window\.addEventListener\('pagehide', saveDraftNow\)/);
assert.match(appSource, /직접입력/);
assert.match(appSource, /텍스트/);
assert.match(appSource, /current\.header\.orderDate = contract\.businessDate\(current\.header\.recordedAt/);
assert.doesNotMatch(appSource, /orderDateInput/);
assert.doesNotMatch(appSource, /function updateStage|progressText|stageIndex/);
assert.doesNotMatch(appSource, /data-order-customer/);
assert.match(dataStoreSource, /oneapp-smartinput/);
assert.match(dataStoreSource, /customerLinkGroups/);
assert.match(dataStoreSource, /temporaryCustomers/);
assert.match(dataStoreSource, /customerAliasMappings/);
assert.match(dataStoreSource, /ESTIMATES: 'estimates'/);
assert.match(dataStoreSource, /SOURCE_IMAGES: 'sourceImages'/);
assert.match(dataStoreSource, /export function saveEstimate/);
assert.match(dataStoreSource, /export function deleteEstimate/);
assert.match(dataStoreSource, /export function saveSourceImage/);
assert.match(appSource, /function persistSourceImageForMode\(/);
assert.match(appSource, /function restoreSourceImageForMode\(/);
assert.match(appSource, /function renderCatalogControls\(/);
assert.match(appSource, /photoViewer\.classList\.toggle\('has-image', showPhoto\)/);
assert.match(appSource, /\$\('photoEmptySelectButton'\)\.addEventListener\('click'/);
assert.match(appSource, /state\.sourceImages\[state\.draft\.activeMode\] = imageEvidence;[\s\S]*renderSourceSurface\(\);[\s\S]*if \(state\.busy\)/,
  '붙여넣은 원본 사진은 진행 중인 파서보다 먼저 뷰어에 표시해야 한다.');
assert.match(appSource, /if \(event\.target === sourceTextInput && pastedText\)[\s\S]*else if \(parserCard\.contains\(event\.target\) && pastedText\)/,
  'plain-text paste may switch photo mode only when the event belongs to the parser, never a standard-input cell');
assert.match(appSource, /if \(status === 'SIMILAR'\) return '유사';[\s\S]*return '불일치';/);
assert.match(appSource, /data-field="unitPrice" type="text" inputmode="decimal"/,
  '단가 입력은 브라우저 숫자 증감 스피너를 사용하면 안 된다.');
assert.match(appSource, /function confirmUnitPriceReview\(/);
assert.match(appSource, /inputRows\.addEventListener\('focusout',[\s\S]*confirmUnitPriceReview/);
assert.match(appSource, /const rowTab = event\.key === 'Tab';/);
assert.match(appSource, /nextRowEntryTarget\(rowId, event\.shiftKey\)/,
  'Tab must move to the product-search cell of the previous or next row');
assert.match(appSource, /event\.key === 'Enter'[\s\S]*sequentialGridTarget\(rowId, field\)/,
  'Enter must follow the configured cell input order');
assert.match(appSource, /\['PRICE', 'COST'\]\.includes\(field\.group\)/,
  'every price and cost field must render without browser numeric steppers');
assert.match(appSource, /function masterFieldValue\(product, field\)/,
  'selected master products must populate fields from the complete master field dictionary');
assert.match(appSource, /function startNewCatalog\(/);
assert.match(appSource, /function availableCatalogs\(/);
assert.match(appSource, /const defaultName = loadedRecord \? estimateTitle\(loadedRecord\) : \(current\.header\.customerName \|\| '새 견적서'\)/,
  'a customer-free estimate must receive an editable new-estimate default name');
assert.match(appSource, /requestedName === estimateTitle\(loadedRecord\)/,
  'saving a loaded estimate under the same name must update that record');
assert.match(appSource, /sortOrder: updateLoadedRecord \? Number\(loadedRecord\.sortOrder/);
assert.match(appSource, /: state\.estimates\.length \+ 1/,
  'a differently named copy must append to the bottom of the estimate library');
assert.match(appSource, /state\.estimates = normalizeEstimateOrder\(updateLoadedRecord[\s\S]*: \[\.\.\.state\.estimates, record\]\)/);
assert.match(appSource, /previousPrices: priorPrices/);
assert.match(appSource, /buildCatalogPriceSnapshot\(current\.rows\)/);
assert.match(appSource, /'쇼핑몰업로드'/);
assert.match(appSource, /'ERP업데이트'/);
assert.match(appSource, /if \(output\.confirmData\.length > 1\)/);
assert.match(appSource, /const sourceRows = selectedRecords\.length \? combinedEstimateRows\(selectedRecords\) : modeDraft\(\)\.rows/,
  'Excel export must combine only the selected estimate product sets');
assert.match(appSource, /const records = availableCatalogs\(\)/);
assert.match(appSource, /견적서 선택 · 선택/);
assert.match(appSource, /현재 이름을 유지하면 같은 견적서를 수정하고/);
assert.match(appSource, /새 견적서를 목록 최하단에 저장했습니다/);
assert.doesNotMatch(appSource, /카탈로그 선택|카탈로그 저장|삭제할 카탈로그|새 카탈로그를 생성/);
assert.match(appSource, /String\(record\?\.catalogName \|\| ''\)\.trim\(\)/,
  'catalog names must use the user-editable estimate name');
assert.doesNotMatch(appSource, /\$\('catalogSelect'\)\.disabled = !current\.header\.customerId/);
assert.match(appSource, /catalogDraft\.header\.customerId = linkedCustomer\?\.customerId \|\| catalogCustomerId\(record\)/);
assert.match(appSource, /catalogDraft\.header\.customerName = customerName\(linkedCustomer\) \|\| catalogCustomerName\(record\)/);
assert.match(appSource, /customerMappingSource = 'CATALOG'/);
assert.match(appSource, /function createCatalogOnlyDraft\(source = \{\}, catalogRecordId = ''\)[\s\S]*sourceText: ''[\s\S]*activeMethod: 'direct'[\s\S]*batches: \[\]/,
  'catalog records must keep product content without parser text or input batches');
assert.match(appSource, /batchId: ''[\s\S]*sourceRegion: null[\s\S]*rawText: ''[\s\S]*candidateProducts: \[\][\s\S]*editedFields: \{\}/,
  'catalog product rows must not retain parser provenance or photo regions');
assert.match(appSource, /rawOrdererName: ''[\s\S]*aliasMappingId: ''[\s\S]*customerMappingSource: 'CATALOG'/,
  'catalog headers must not retain parser orderer matching evidence');
assert.match(appSource, /const catalogDraft = createCatalogOnlyDraft\(record\.draft, record\.estimateId\)[\s\S]*state\.sourceImages\.estimate = null[\s\S]*state\.pendingImageEvidence = null[\s\S]*state\.pendingOcrReview = null[\s\S]*resetPhotoView\(\)/,
  'loading legacy catalogs must detach any previously saved parser photo');
assert.match(appSource, /draft: JSON\.parse\(JSON\.stringify\(createCatalogOnlyDraft\(current, estimateId\)\)\)/,
  'saving a catalog must persist the catalog-only projection');
assert.match(appSource, /function isParserArtifactLine\(/);
assert.match(appSource, /lines = lines\.filter\(line => !isParserArtifactLine\(line\)\)/);

const app = manifest.applications.find(item => item.id === 'smart-input');
assert.ok(app, 'smart-input must be registered in the manifest');
assert.equal(app.path, 'smartinput/index.html');
assert.equal(app.status, 'pilot');
assert.ok(app.sharedContracts.includes('nexus-header'), 'SmartInput must display the existing NEXUS header');
assert.ok(app.sharedContracts.includes('orderq-vnext-sync'));
assert.ok(app.sharedContracts.includes('product-master'));
const orderLedger = manifest.sharedDataContracts.find(item => item.id === 'orderq-vnext-sync');
assert.ok(orderLedger.consumers.includes('smartinput/index.html'));
assert.ok(orderLedger.consumers.includes('orders.html'), 'ORDER Q shipment must be registered as a read-only ledger consumer');
const nexusHeader = manifest.sharedDataContracts.find(item => item.id === 'nexus-header');
assert.ok(nexusHeader.consumers.includes('smartinput/index.html'));

assert.match(readme, /\/smartinput\//);
assert.match(readme, /orders\.html.*검증된 읽기 전용 어댑터/);
assert.match(architecture, /### 6\.7 Standalone SmartInput intake/);
assert.match(architecture, /tapping the order-status card before analysis invokes the separately validated read-only adapter/);
assert.match(architecture, /does not create a second order store, mutate the ledger, or trigger cloud synchronization/);
assert.match(architecture, /Customer linking is relational, never canonical merging/);
assert.match(architecture, /same-day cutoff/);

console.log('SmartInput standalone contract PASS');
