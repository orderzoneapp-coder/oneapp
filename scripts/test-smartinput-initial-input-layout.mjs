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
  ],
  sale: [
    ['itemCode', '품목코드'], ['itemName', '품목명'], ['specification', '규격'],
    ['quantity', '수량'], ['unitPrice', '단가'], ['supplyAmount', '공급가액'],
    ['memo', '적요'], ['erp.sale.current.line.unmapped_3396a63d', '출고지시'], ['saleAmount1', '공지'],
    ['saleMemo3', '구매처'], ['custom.text.01', '날짜'], ['saleAmount2', '구매']
  ]
};

const fresh = contract.normalizeSettings();
const fieldForMode = (id, mode) => contract.fieldDefinitionForMode(
  fresh.customFields.find(field => field.id === id) || id, mode);
for (const [mode, fields] of Object.entries(expected)) {
  const ids = fields.map(([id]) => id);
  assert.deepEqual(plain(fresh.voucherColumnsByMode[mode]), ids, `${mode}: first use must show the approved column sequence`);
  assert.deepEqual(plain(contract.DEFAULT_SETTINGS.voucherColumnsByMode[mode]), ids);
  assert.deepEqual(fields.map(([id]) => [id, fieldForMode(id, mode).label]), fields);
  assert.equal(contract.INITIAL_INPUT_PRESETS[mode].version, '20260909-v1');
  let editableOrder = 0;
  for (const id of ids) {
    const field = fieldForMode(id, mode);
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
for (const mode of ['unknown', '__proto__', 'toString']) {
  assert.equal(contract.getInitialInputLayout(mode), null);
  assert.throws(() => contract.restoreInitialInputSettings(fresh, mode), /초기 입력 구성이 아직 확정되지/);
}

const legacyColumns = ['quantity', 'itemCode', 'memo'];
const legacy = contract.normalizeSettings({ voucherColumns: legacyColumns });
assert.deepEqual(plain(legacy.customFields), [], 'legacy saved settings never allocate a new custom date field silently');
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
  const initial = contract.getInitialInputLayout(mode, settings);
  if (initial.customFields) {
    expectedRestored.customFields = plain(initial.customFields);
    for (const field of initial.customFields.filter(field => !settings.customFields.some(existing => existing.id === field.id))) {
      for (const inputOrder of Object.values(expectedRestored.inputOrderByMode)) inputOrder[field.id] = 0;
    }
  }
  expectedRestored.voucherColumnsByMode[mode] = expected[mode].map(([id]) => id);
  expectedRestored.inputOrderByMode[mode] = Object.fromEntries(Object.keys(expectedRestored.inputOrderByMode[mode]).map(id => [id, 0]));
  Object.assign(expectedRestored.inputOrderByMode[mode], plain(initial.inputOrder));
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
assert.equal(contract.fieldDefinitionForMode('memo', 'sale').label, '적요');
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

assert.equal(contract.fieldDefinitionForMode('supplier', 'sale').label, '구매처(상품정보)');
assert.equal(contract.fieldDefinitionForMode('supplier', 'sale').inputAliases.includes('구매처'), false,
  'the confirmed sale 구매처 column belongs to saleMemo3, never the product supplier');
for (const [id, canonical, valueType] of [
  ['saleAmount1', '금액1(판매)', 'NUMBER'], ['saleAmount2', '금액2(판매)', 'NUMBER'],
  ['saleMemo3', '적요3(판매)', 'TEXT']
]) {
  const field = contract.fieldDefinitionForMode(id, 'sale');
  assert.equal(field.valueType, valueType);
  assert.equal(field.inputAliases.includes(canonical), true);
  assert.deepEqual(plain(field.voucherModes), ['sale']);
  assert.equal(contract.ROW_FIELDS.includes(id), true);
  assert.equal(contract.VOUCHER_COLUMN_DEFINITIONS.some(field => field.id === id), false);
}
const saleRow = contract.normalizeRow({ itemCode: '001', saleAmount1: 0, saleAmount2: '', saleMemo3: '001 구매처',
  customValues: { 'custom.text.01': '001234', 'erp.sale.current.line.unmapped_3396a63d': '선출고' } });
const saleLoaded = contract.normalizeRow(plain(saleRow));
assert.equal(saleLoaded.saleAmount1, 0);
assert.equal(saleLoaded.saleAmount2, null);
assert.equal(saleLoaded.saleMemo3, '001 구매처');
assert.equal(saleLoaded.customValues['erp.sale.current.line.unmapped_3396a63d'], '선출고');
assert.equal(saleLoaded.customValues['custom.text.01'], '001234', 'date is user text; leading zeroes must survive');
assert.equal(contract.normalizeRow({ saleAmount1: -1200.5 }).saleAmount1, -1200.5);
assert.equal(contract.markUserEdit(saleRow, 'saleMemo3', '새 구매처').saleMemo3, '새 구매처');
assert.equal(contract.markUserEdit(saleRow, 'saleAmount2', 0).saleAmount2, 0);
for (const fieldId of ['saleAmount1', 'saleAmount2']) {
  for (const [input, expectedValue] of [['-27.5', -27.5], ['0', 0], ['', null]]) {
    const editedSale = contract.markProductEdit(saleRow, fieldId, input);
    assert.equal(editedSale[fieldId], expectedValue, `${fieldId}: typed input must use numeric values and retain blanks separately from zero`);
    assert.equal(editedSale.editedFields[fieldId], true);
    assert.equal(contract.normalizeRow(plain(editedSale))[fieldId], expectedValue,
      `${fieldId}: edited numeric values and blanks must survive draft persistence`);
  }
}

const occupiedSettings = contract.normalizeSettings({ ...plain(settings), customFields: [
  { id: 'custom.text.01', label: '고객 보존 문자', scope: 'voucher', category: 'CUSTOM', valueType: 'TEXT' }
] });
const occupiedBefore = plain(occupiedSettings);
const occupiedLayout = contract.getInitialInputLayout('sale', occupiedSettings);
assert.equal(occupiedLayout.voucherColumns[10], 'custom.text.02', 'an occupied custom text slot must never be reused as date');
assert.deepEqual(plain(occupiedLayout.customFields[0]), occupiedBefore.customFields[0]);
assert.equal(contract.fieldDefinitionForMode(occupiedSettings.customFields[0], 'sale').label, '고객 보존 문자',
  'custom.text.01 has no fixed date identity');
const occupiedRestored = contract.restoreInitialInputSettings(occupiedSettings, 'sale');
assert.equal(occupiedRestored.customFields.length, 3);
assert.equal(occupiedRestored.customFields[2].initialInputRole, 'sale.date');
assert.equal(occupiedRestored.customFields[2].valueType, 'TEXT');
assert.deepEqual(plain(occupiedSettings), occupiedBefore, 'allocation must not mutate any existing settings');
assert.deepEqual(plain(contract.restoreInitialInputSettings(occupiedRestored, 'sale')), plain(occupiedRestored),
  'repeated restoration must reuse the same persisted date slot');
assert.deepEqual(plain(contract.normalizeSettings(occupiedRestored)), plain(occupiedRestored), 'date role survives settings persistence');
const renamedDate = plain(occupiedRestored);
renamedDate.customFields[2].label = '사용자가 바꾼 날짜명';
assert.equal(contract.getInitialInputLayout('sale', renamedDate).voucherColumns[10], 'custom.text.02',
  'persisted role is reused even after the user changes its name');

const existingDate = { id: 'custom.text.07', label: '날짜', scope: 'voucher', category: 'CUSTOM', valueType: 'TEXT' };
const reusedDate = contract.getInitialInputLayout('sale', { customFields: [existingDate] });
assert.equal(reusedDate.voucherColumns[10], 'custom.text.07');
assert.equal(reusedDate.customFields.length, 2);
assert.equal(existingDate.initialInputRole, undefined, 'reusing a date field never mutates the caller definition');
const fullFields = Array.from({ length: 10 }, (_, index) => ({ id: `custom.text.${String(index + 1).padStart(2, '0')}`,
  label: `보존 문자 ${index + 1}`, scope: 'voucher', category: 'CUSTOM', valueType: 'TEXT' }));
const fullSettings = contract.normalizeSettings({ ...plain(settings), customFields: fullFields });
const fullBefore = plain(fullSettings);
assert.throws(() => contract.restoreInitialInputSettings(fullSettings, 'sale'), /문자 항목 10개/);
assert.deepEqual(plain(fullSettings), fullBefore, 'no-slot restore failure must preserve the entire previous configuration');
const fullFirstUse = contract.normalizeSettings({ customFields: fullFields });
assert.equal(fullFirstUse.customFields.length, 10);
assert.deepEqual(plain(fullFirstUse.voucherColumnsByMode.sale), expected.purchase.map(([id]) => id),
  'a missing sale layout with exhausted custom capacity remains usable with the legacy baseline');
assert.throws(() => contract.getInitialInputLayout('sale', { customFields: [existingDate, { ...existingDate, id: 'custom.text.08' }] }),
  /여러 개/, 'duplicate named date fields require an explicit choice instead of silently picking one');
const markedDate = { ...existingDate, initialInputRole: 'sale.date' };
assert.equal(contract.getInitialInputLayout('sale', { customFields: [markedDate, { ...existingDate, id: 'custom.text.08' }] }).voucherColumns[10],
  markedDate.id, 'a previously selected role takes priority over an unrelated duplicate label');

console.log('SmartInput four approved initial layouts, labels, restore isolation, Enter order, sale mapping and custom text date preservation PASS');
