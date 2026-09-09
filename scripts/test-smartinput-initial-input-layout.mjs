#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8'), context);
const contract = context.window.SMART_INPUT_CONTRACT;
const plain = value => JSON.parse(JSON.stringify(value));
const expected = {
  estimate: [
    ['itemCode', '품목코드'], ['itemName', '품목명'], ['specification', '규격'],
    ['quantity', '수량'], ['unitPrice', '단가'], ['purchasePriceB', 'B단가'],
    ['wholesaleA', 'A판매'], ['wholesaleB', 'B판매'], ['memo', '적요'],
    ['promoPrice', '행사가'], ['memo2', '적요2']
  ],
  order: [
    ['itemCode', '품목코드'], ['itemName', '품목명'], ['specification', '규격'],
    ['quantity', '수량'], ['unitPrice', '단가'], ['supplyAmount', '공급가액'],
    ['memo', '메모'], ['description', '적요(직원)'], ['noticePrice', '공지단가']
  ],
  purchase: [
    ['itemCode', '코드'], ['itemName', '품명'], ['specification', '규격(기본)'],
    ['quantity', '수량'], ['unitPrice', '단가'], ['supplyAmount', '공급가'],
    ['productDescription', '간단설명(품위)'], ['memo', '지시사항'],
    ['noticePrice', '출고가 (공지)'], ['rowVoucherNo', '판매no.']
  ]
};

const fresh = contract.normalizeSettings();
for (const [mode, fields] of Object.entries(expected)) {
  const ids = fields.map(([id]) => id);
  assert.deepEqual(plain(fresh.voucherColumnsByMode[mode]), ids, `${mode}: first use must show the approved column sequence`);
  assert.deepEqual(plain(contract.DEFAULT_SETTINGS.voucherColumnsByMode[mode]), ids);
  assert.deepEqual(fields.map(([id]) => [id, contract.fieldDefinitionForMode(id, mode).label]), fields);
  assert.equal(contract.INITIAL_INPUT_PRESETS[mode].version, '20260909-v1');
  let editableOrder = 0;
  for (const id of ids) {
    const field = contract.fieldDefinitionForMode(id, mode);
    assert.equal(fresh.inputOrderByMode[mode][id], field.editable === false ? 0 : ++editableOrder,
      `${mode}: Enter order skips computed amounts and stays compact`);
  }
  assert.equal(Object.isFrozen(contract.INITIAL_INPUT_PRESETS[mode]), true);
  assert.equal(Object.isFrozen(contract.INITIAL_INPUT_PRESETS[mode].columns), true);
  assert.equal(Object.isFrozen(contract.INITIAL_INPUT_PRESETS[mode].labels), true);
  assert.throws(() => { contract.INITIAL_INPUT_PRESETS[mode].labels.itemCode = 'changed'; }, TypeError);
  const mutable = contract.getInitialInputLayout(mode);
  mutable.voucherColumns.reverse();
  mutable.inputOrder.itemCode = 99;
  assert.deepEqual(plain(contract.getInitialInputLayout(mode).voucherColumns), ids);
  assert.equal(contract.getInitialInputLayout(mode).inputOrder.itemCode, 1,
    'working settings must never mutate the restore baseline');
}
assert.equal(Object.isFrozen(contract.INITIAL_INPUT_PRESETS), true);
assert.deepEqual(plain(fresh.voucherColumnsByMode.sale), expected.purchase.map(([id]) => id),
  'unconfirmed sale meanings must retain the previous ten-column default');
for (const mode of ['sale', 'unknown', '__proto__', 'toString']) {
  assert.equal(contract.getInitialInputLayout(mode), null);
  assert.throws(() => contract.restoreInitialInputSettings(fresh, mode), /초기 입력 구성이 아직 확정되지/);
}

const legacyColumns = ['quantity', 'itemCode', 'memo'];
const legacy = contract.normalizeSettings({ voucherColumns: legacyColumns });
for (const mode of Object.keys(contract.MODES)) {
  assert.deepEqual(plain(legacy.voucherColumnsByMode[mode]), legacyColumns,
    'saved legacy common layouts must migrate without silently replacing their columns');
}
const oldCommonDefaults = contract.normalizeSettings({ voucherColumns: expected.purchase.map(([id]) => id) });
assert.deepEqual(plain(oldCommonDefaults.voucherColumnsByMode.estimate), expected.purchase.map(([id]) => id),
  'an explicitly saved old default is still a saved layout');

const settings = contract.normalizeSettings({
  voucherColumnsByMode: {
    order: ['memo', 'quantity', 'itemCode'],
    estimate: ['memo2', 'itemCode', 'custom-estimate'],
    purchase: ['unitPrice', 'itemCode'],
    sale: ['quantity', 'itemCode', 'supplier']
  },
  inputOrderByMode: {
    order: { memo: 3, quantity: 0, itemCode: 1 },
    estimate: { memo2: 0, itemCode: 7, 'custom-estimate': 2 },
    purchase: { unitPrice: 2, itemCode: 1 },
    sale: { quantity: 4, itemCode: 2, supplier: 0 }
  },
  headerFieldsByMode: { estimate: ['warehouse', 'deliveryDate', 'customer'] },
  customFields: [{ id: 'custom-estimate', label: '보존 항목', scope: 'voucher', valueType: 'TEXT' }],
  columnWidths: { itemCode: 170 },
  columnWidthsByMode: { estimate: { memo2: 240 }, sale: { supplier: 180 } },
  orderCutoffTime: '13:30',
  allowSameDayDelivery: false,
  defaultDeliveryWeekdays: [1, 3, 5],
  deliveryCustomerWeekdays: { customerA: [2, 4] },
  holidayDates: ['2026-12-25'],
  estimateNoticePriceFields: ['wholesaleA', 'promoPrice']
});
const before = plain(settings);
assert.deepEqual(plain(contract.normalizeSettings(plain(settings))), before,
  'save/load must preserve per-mode columns, configured zeroes, and the user Enter order');
for (const mode of Object.keys(expected)) {
  const restored = plain(contract.restoreInitialInputSettings(settings, mode));
  const expectedRestored = plain(settings);
  expectedRestored.voucherColumnsByMode[mode] = expected[mode].map(([id]) => id);
  expectedRestored.inputOrderByMode[mode] = Object.fromEntries(Object.keys(settings.inputOrderByMode[mode]).map(id => [id, 0]));
  Object.assign(expectedRestored.inputOrderByMode[mode], plain(contract.getInitialInputLayout(mode).inputOrder));
  if (mode === 'order') expectedRestored.voucherColumns = expectedRestored.voucherColumnsByMode.order;
  assert.deepEqual(restored, expectedRestored,
    `${mode}: restore only resets the selected columns and Enter order; widths, headers, delivery, custom field definitions and other modes survive`);
  assert.deepEqual(plain(settings), before, 'restore must not mutate its input settings');
  assert.deepEqual(plain(contract.normalizeSettings(restored)), restored, 'restored settings survive save/load');
}

const estimateB = contract.fieldDefinitionForMode('purchasePriceB', 'estimate');
assert.equal(estimateB.initialLabel, 'B단가');
assert.equal(estimateB.masterAliases.includes('입고B'), true, 'confirmed mapping keeps the original master field alias');
assert.equal(estimateB.inputAliases.includes('입고B'), true);
assert.equal(contract.fieldDefinitionForMode('memo', 'estimate').inputAliases.includes('메모'), true);
assert.equal(contract.fieldDefinitionForMode('memo', 'estimate').inputAliases.includes('지시사항'), false,
  'estimate 지시사항 belongs to the separately available description field');
assert.equal(contract.fieldDefinitionForMode('description', 'estimate').label, '지시사항');
assert.equal(contract.fieldDefinitionForMode('description', 'estimate').inputAliases.includes('적요'), false,
  'estimate 적요 belongs to memo and must not also select description');
assert.equal(contract.PRODUCT_FIELD_DEFINITIONS.find(field => field.id === 'description').inputAliases.includes('적요'), true,
  'mode-specific aliases must never mutate the shared field registry');
assert.equal(contract.fieldDefinitionForMode('memo', 'purchase').label, '지시사항');
assert.equal(contract.fieldDefinitionForMode('memo', 'sale').label, '지시사항');
assert.equal(contract.fieldDefinitionForMode('nonexistent', 'estimate'), null);

const row = contract.normalizeRow({ itemCode: '001', memo: '첫 적요', memo2: '두 번째 적요', quantity: 0, unitPrice: 0 });
assert.equal(contract.ROW_FIELDS.includes('memo2'), true);
assert.equal(contract.VOUCHER_COLUMN_DEFINITIONS.some(field => field.id === 'memo2'), false,
  'memo2 must use dynamic product-column rendering because it has no static HTML cell');
assert.equal(contract.fieldDefinitionForMode('memo2', 'estimate').valueType, 'TEXT');
const edited = contract.markUserEdit(row, 'memo2', '보존할 적요2');
const loaded = contract.normalizeRow(plain(edited));
assert.equal(loaded.memo, '첫 적요');
assert.equal(loaded.memo2, '보존할 적요2');
assert.equal(loaded.editedFields.memo2, true);
assert.equal(loaded.quantity, 0);
assert.equal(loaded.unitPrice, 0);
assert.equal(contract.normalizeRow({ memo2: '' }).memo2, '');

console.log('SmartInput approved initial layouts, labels, preservation, restore isolation, Enter order and memo2 roundtrip PASS');
