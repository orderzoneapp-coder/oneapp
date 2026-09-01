#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CORE_FIELD_DEFINITIONS,
  CUSTOM_FIELD_DEFINITIONS,
  coreFieldByProjection,
  defaultCompanyVoucherFieldSettings,
  effectiveFieldDefinitions,
  normalizeCompanyVoucherFieldSettings,
  validateFieldCatalog
} from '../smartinput/field-definition-contract.js';

const seed = validateFieldCatalog(JSON.parse(fs.readFileSync(new URL('../smartinput/field-catalog-seed.v2.json', import.meta.url), 'utf8')));
assert.equal(seed.occurrenceCount, 2178);
assert.equal(seed.definitions.length, 2178);
assert.equal(seed.definitions.filter(row => row.status === 'REVIEW_REQUIRED').length, 63);
assert.deepEqual(seed.modeCounts, { order: 477, estimate: 614, purchase: 468, sale: 619 });

const specifications = [
  CORE_FIELD_DEFINITIONS.find(field => field.fieldId === 'voucher.sale.line.specification'),
  CORE_FIELD_DEFINITIONS.find(field => field.fieldId === 'voucher.estimate.line.specification'),
  seed.definitions.find(field => field.ownerDomain === 'PRODUCT_MASTER' && field.displayLabel === '규격')
];
assert.equal(specifications.every(Boolean), true);
assert.equal(new Set(specifications.map(field => field.fieldId)).size, 3,
  '같은 규격이라도 판매·견적·상품원본 관계는 별도 fieldId여야 한다.');

const saleSettings = defaultCompanyVoucherFieldSettings('ONEAPP', 'sale', 'tester');
const saleEnabled = effectiveFieldDefinitions({ catalog: seed.definitions, settings: saleSettings, voucherMode: 'sale' });
assert.equal(saleEnabled.some(field => field.fieldId === 'voucher.sale.line.quantity'), true);
assert.equal(saleEnabled.some(field => field.fieldId === 'voucher.order.line.quantity'), false,
  '판매 전표에서는 주문수량이 노출되면 안 된다.');
assert.equal(coreFieldByProjection('sale', 'quantity').fieldId, 'voucher.sale.line.quantity');
assert.equal(coreFieldByProjection('purchase', 'unitPrice').fieldId, 'voucher.purchase.line.unitPrice');

const disabledRequired = saleSettings.map(row => row.fieldId === 'voucher.sale.line.quantity' ? { ...row, enabled: false, required: false } : row);
const normalized = normalizeCompanyVoucherFieldSettings('ONEAPP', 'sale', disabledRequired, 'tester');
assert.equal(normalized.find(row => row.fieldId === 'voucher.sale.line.quantity').enabled, true);
assert.equal(normalized.find(row => row.fieldId === 'voucher.sale.line.quantity').required, true,
  '시스템 필수 필드는 관리자가 끌 수 없다.');

assert.equal(CUSTOM_FIELD_DEFINITIONS.filter(field => field.valueType === 'TEXT').length, 10);
assert.equal(CUSTOM_FIELD_DEFINITIONS.filter(field => field.valueType === 'DECIMAL').length, 10);
assert.equal(CUSTOM_FIELD_DEFINITIONS.every(field => !field.effectRole), true,
  '사용자지정 필드는 재고·채권·채무 효과를 가지면 안 된다.');

const reviewFields = seed.definitions.filter(field => field.status === 'REVIEW_REQUIRED');
const reviewSettings = reviewFields.slice(0, 1).map((field, index) => ({
  companyId: 'ONEAPP', voucherMode: field.voucherModes[0], fieldId: field.fieldId,
  enabled: true, uiOrder: index + 1
}));
assert.equal(effectiveFieldDefinitions({
  catalog: reviewFields,
  settings: reviewSettings,
  voucherMode: reviewFields[0].voucherModes[0]
}).some(field => field.status === 'REVIEW_REQUIRED'), false, '검토필요 필드는 선택 목록에서 숨겨야 한다.');

console.log('SmartInput FieldDefinition V2 seed, per-voucher quantity/price, required fields, custom slots, and review quarantine passed.');
