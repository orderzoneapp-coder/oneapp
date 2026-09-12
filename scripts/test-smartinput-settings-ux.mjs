#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  compactSettingsInputOrder,
  parseSettingsInputOrder,
  reorderSettingsInputOrder,
  settingsFieldGroupId,
  settingsInputOrderPreview,
  sortSettingsFields
} from '../smartinput/settings-input-order.js';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

assert.deepEqual(
  sortSettingsFields([
    { id: 'memo', group: 'ADDITIONAL' },
    { id: 'unitPrice', group: 'PRICE' },
    { id: 'itemName', group: 'ITEM' },
    { id: 'quantity', group: 'QUANTITY' },
    { id: 'cost', group: 'COST' },
    { id: 'itemCode', group: 'ITEM' }
  ]).map(field => field.id),
  ['itemName', 'itemCode', 'unitPrice', 'quantity', 'cost', 'memo'],
  'settings display order must use the fixed business groups while remaining stable inside each group'
);
assert.equal(settingsFieldGroupId({ group: 'ITEM' }), 'ITEM');
assert.equal(settingsFieldGroupId({ group: 'QUANTITY' }), 'AMOUNT');
assert.equal(settingsFieldGroupId({ group: 'PRICE' }), 'AMOUNT');
assert.equal(settingsFieldGroupId({ group: 'COST' }), 'AMOUNT');
assert.equal(settingsFieldGroupId({ group: 'ADDITIONAL' }), 'OTHER');
assert.equal(settingsFieldGroupId({ group: 'FUTURE' }), 'OTHER');

assert.deepEqual(parseSettingsInputOrder('0'), { valid: true, code: '', value: 0 });
assert.deepEqual(parseSettingsInputOrder('27'), { valid: true, code: '', value: 27 });
assert.equal(parseSettingsInputOrder('').code, 'INPUT_ORDER_REQUIRED');
assert.equal(parseSettingsInputOrder('   ').code, 'INPUT_ORDER_REQUIRED');
assert.equal(parseSettingsInputOrder('-1').code, 'INPUT_ORDER_NON_NEGATIVE_INTEGER_REQUIRED');
assert.equal(parseSettingsInputOrder('1.5').code, 'INPUT_ORDER_NON_NEGATIVE_INTEGER_REQUIRED');
assert.equal(parseSettingsInputOrder('1e2').code, 'INPUT_ORDER_NON_NEGATIVE_INTEGER_REQUIRED');
assert.equal(parseSettingsInputOrder('1000').code, 'INPUT_ORDER_OUT_OF_RANGE');

const selected = ['itemCode', 'itemName', 'specification', 'quantity'];
const initial = { itemCode: 1, itemName: 2, specification: 3, quantity: 4, memo: 0 };
const insertAtDuplicate = reorderSettingsInputOrder({
  inputOrder: initial,
  selectedFieldIds: selected,
  fieldId: 'quantity',
  requestedOrder: '2'
});
assert.equal(insertAtDuplicate.valid, true);
assert.deepEqual(
  pick(insertAtDuplicate.inputOrder, selected),
  { itemCode: 1, itemName: 3, specification: 4, quantity: 2 },
  'the last-edited field must be inserted at the requested duplicate position'
);
assert.deepEqual(insertAtDuplicate.sequence, ['itemCode', 'quantity', 'itemName', 'specification']);

const moveBack = reorderSettingsInputOrder({
  inputOrder: initial,
  selectedFieldIds: selected,
  fieldId: 'itemCode',
  requestedOrder: 4
});
assert.deepEqual(pick(moveBack.inputOrder, selected), { itemCode: 4, itemName: 1, specification: 2, quantity: 3 });

const excludeFromEnter = reorderSettingsInputOrder({
  inputOrder: initial,
  selectedFieldIds: selected,
  fieldId: 'itemName',
  requestedOrder: 0
});
assert.deepEqual(pick(excludeFromEnter.inputOrder, selected), { itemCode: 1, itemName: 0, specification: 2, quantity: 3 });
assert.deepEqual(excludeFromEnter.sequence, ['itemCode', 'specification', 'quantity']);

const insertFromZero = reorderSettingsInputOrder({
  inputOrder: { itemCode: 1, itemName: 0, specification: 2, quantity: 3 },
  selectedFieldIds: selected,
  fieldId: 'itemName',
  requestedOrder: 2
});
assert.deepEqual(pick(insertFromZero.inputOrder, selected), { itemCode: 1, itemName: 2, specification: 3, quantity: 4 });

const compacted = compactSettingsInputOrder({
  inputOrder: { itemCode: 4, itemName: 4, specification: 8, quantity: 0, supplyAmount: 6 },
  selectedFieldIds: [...selected, 'supplyAmount'],
  editableFieldIds: selected
});
assert.deepEqual(
  pick(compacted.inputOrder, [...selected, 'supplyAmount']),
  { itemCode: 1, itemName: 2, specification: 3, quantity: 0, supplyAmount: 0 },
  'positive orders must be compact and read-only fields must remain excluded'
);
assert.equal(reorderSettingsInputOrder({
  inputOrder: { supplyAmount: 0 },
  selectedFieldIds: ['supplyAmount'],
  editableFieldIds: [],
  fieldId: 'supplyAmount',
  requestedOrder: 1
}).code, 'INPUT_ORDER_FIELD_NOT_EDITABLE');
assert.deepEqual(settingsInputOrderPreview({
  inputOrder: insertAtDuplicate.inputOrder,
  selectedFieldIds: selected,
  labelById: { itemCode: '품목코드', itemName: '품목명', specification: '규격', quantity: '수량' }
}), [
  { fieldId: 'itemCode', order: 1, label: '품목코드' },
  { fieldId: 'quantity', order: 2, label: '수량' },
  { fieldId: 'itemName', order: 3, label: '품목명' },
  { fieldId: 'specification', order: 4, label: '규격' }
]);

const contractSource = read('smartinput/smartinput-contract.js');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;
assert.deepEqual(Object.keys(contract.MODES), ['order', 'purchase', 'sale', 'estimate']);
const requestedDefaultFields = [
  ['itemCode', '코드'],
  ['itemName', '품명'],
  ['specification', '규격(기본)'],
  ['quantity', '수량'],
  ['unitPrice', '단가'],
  ['supplyAmount', '공급가'],
  ['productDescription', '간단설명(품위)'],
  ['memo', '지시사항'],
  ['noticePrice', '출고가 (공지)'],
  ['rowVoucherNo', '판매no.']
];
assert.deepEqual(Array.from(contract.DEFAULT_SETTINGS.voucherColumns), requestedDefaultFields.map(([fieldId]) => fieldId),
  'the default SmartInput fields must use the requested ten-field composition and order');
assert.deepEqual(
  requestedDefaultFields.map(([fieldId]) => [fieldId, contract.PRODUCT_FIELD_DEFINITIONS.find(field => field.id === fieldId)?.label]),
  requestedDefaultFields,
  'the default SmartInput field labels must match the requested worker-facing names'
);
assert.deepEqual(
  Object.fromEntries(requestedDefaultFields.map(([fieldId]) => [fieldId, contract.DEFAULT_SETTINGS.inputOrderByMode.purchase[fieldId]])),
  { itemCode: 1, itemName: 2, specification: 3, quantity: 4, unitPrice: 5, supplyAmount: 0, productDescription: 6, memo: 7, noticePrice: 8, rowVoucherNo: 9 },
  'Enter order must follow the requested default field order while skipping the calculated supply amount'
);
const customWorktableOrder = ['quantity', 'itemCode', 'itemName', 'memo'];
const normalized = contract.normalizeSettings({
  voucherColumnsByMode: {
    order: customWorktableOrder,
    purchase: ['itemCode', 'unitPrice'],
    sale: ['itemCode', 'specification'],
    estimate: ['itemCode', 'noticePrice']
  }
});
assert.deepEqual(Array.from(normalized.voucherColumnsByMode.order), customWorktableOrder,
  'normalization must preserve the existing worktable column order');
assert.deepEqual(Array.from(normalized.voucherColumnsByMode.purchase), ['itemCode', 'unitPrice']);
assert.deepEqual(Array.from(normalized.voucherColumnsByMode.sale), ['itemCode', 'specification']);
assert.deepEqual(Array.from(normalized.voucherColumnsByMode.estimate), ['itemCode', 'noticePrice']);

const html = read('smartinput/index.html');
const app = read('smartinput/smartinput.js');
const css = read('smartinput/smartinput.css');
assert.match(html, /nexus-ui\.css\?v=1\.4\.0/);
assert.match(html, /nexus-ui-app-themes\.css\?v=1\.3\.11/);
assert.match(html, /nexus-ui\.js\?v=1\.7\.0/);
assert.match(html, /smartinput\.css\?v=0\.9\.19/);
assert.match(html, /smartinput-contract\.js\?v=0\.6\.5/);
assert.match(html, /smartinput\.js\?v=0\.11\.55/);
assert.match(app, /data-toggle-voucher-explorer/);
assert.match(app, /data-voucher-field-search/);
assert.match(app, /data-voucher-field-category/);
assert.match(app, /data-voucher-explorer-count/);
assert.match(app, /data-add-voucher-field/);
assert.match(app, /사용자지정 \(전표 \$\{isHeader \? '상단' : '하단'\} 배치\)/,
  'custom fields must be creatable for either the top or bottom voucher location');
assert.match(app, /\? `\$\{contract\.MODES\[mode\]\?\.label \|\| mode\} > 사용자지정 > 상단 정보 > \$\{field\.label\}`/,
  'custom top fields must identify the custom origin above their placement');
assert.match(app, /\? `\$\{contract\.MODES\[mode\]\?\.label \|\| mode\} > 사용자지정 > \$\{sectionLabel\} > \$\{field\.label\}`/,
  'custom line fields must identify the custom origin above their placement');
assert.match(app, /const origin = target\.custom \? '사용자지정'/,
  'mapping results must visually distinguish custom fields from built-in fields');
assert.match(app, /const displayLabel = target\.custom \? `\$\{target\.label\}\(사용자\)`/,
  'the mapping result title must visibly mark a custom field');
assert.match(app, /if \(mapping\?\.state === MAPPING_DECISION\.RECOMMENDED\) return mappingTargetWorkerLabel/,
  'recommended worktable columns must show worker-facing location information instead of a recommendation suffix');
assert.match(app, /if \(target\.custom\) return `\$\{target\.scope === 'header' \? '상' : '하'\},\$\{target\.label\}\(i\)`/,
  'custom recommendations in the outer worktable must use the compact location and custom marker');
assert.doesNotMatch(app, /data-add-layout-field="voucher"/,
  'voucher field discovery must stay inline instead of opening the legacy nested modal');
assert.match(app, /workingVoucherColumnsByMode\[mode\] = \[\.\.\.workingVoucherColumnsByMode\[mode\], field\.id\]/,
  'new fields must append to the stored worktable order without sorting it by settings display order');
assert.match(app, /workingInputOrderByMode\[mode\] = \{ \.\.\.workingInputOrderByMode\[mode\], \[field\.id\]: 0 \}/,
  'new fields must start visible with Enter order 0');
assert.match(app, /settingsGrid\.prepend\(voucherSettingsGroup\);[\s\S]*voucherSettingsGroup\.open = true/,
  'the selected voucher fields must be the first open settings section');
assert.match(app, /if \(settingsDirty && !window\.confirm\('저장하지 않은 환경설정 변경을 취소하시겠습니까\?'\)\) return false/);
assert.match(app, /await saveSettings\(next\);[\s\S]*state\.settings = next;/,
  'persistent and active settings must change only inside the save action');
assert.match(css, /\.smart-settings-dialog \{ width: min\(1180px,[\s\S]*height: min\(860px/);
assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.smart-settings-dialog \{ inset: 0; width: 100vw; height: 100dvh/);
assert.match(css, /\.smart-settings-dialog button:focus-visible/);

console.log('SmartInput selected-fields settings UX contracts PASS');
