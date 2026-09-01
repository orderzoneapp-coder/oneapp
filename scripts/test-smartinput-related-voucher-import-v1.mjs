#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  applyRelatedVoucherImportPlan,
  createRelatedVoucherImportPlan,
  relatedImportConflicts
} from '../smartinput/related-voucher-import.js';

const source = {
  id: 'PUR-1',
  companyId: 'C1',
  voucherNo: 'P-20260901-1',
  date: '2026-09-01',
  customerId: 'C-SUPPLIER',
  customerCode: 'SUP-01',
  customerName: '공급사',
  warehouseId: 'W1',
  warehouseCode: '01',
  warehouseName: '1창고',
  items: [
    { lineId: 'L1', productId: 'P1', code: '00125', name: '상품A', specification: '원본규격', quantity: 2, quantityDisplay: '2.00', unit: 'EA', unitPrice: 1000, unitPriceDisplay: '1,000' },
    { lineId: 'L2', code: 'TEMP', name: '미등록상품', quantity: 1, unit: 'BOX', unitPrice: 0, unitPriceDisplay: '0' }
  ]
};

const plan = createRelatedVoucherImportPlan({
  companyId: 'C1',
  sourceVoucherMode: 'purchase',
  targetVoucherMode: 'sale',
  sourceVoucher: source
});
assert.equal(plan.rows.length, 2);
assert.equal(plan.rows[0].quantity, 2);
assert.equal(plan.rows[0].fieldValues['voucher.sale.line.quantity'].currentDisplayValue, '2.00');
assert.equal(plan.rows[0].fieldValues['voucher.sale.line.unitPrice'].currentDisplayValue, '1,000');
assert.equal(plan.rows[0].relatedSource.sourceVoucherMode, 'purchase');
assert.equal(plan.rows[1].matchStatus, 'UNRESOLVED', 'unmatched products must remain usable draft rows');

for (const sourceVoucherMode of ['estimate', 'order', 'purchase', 'sale']) {
  for (const targetVoucherMode of ['estimate', 'order', 'purchase', 'sale']) {
    const directional = createRelatedVoucherImportPlan({ companyId: 'C1', sourceVoucherMode, targetVoucherMode, sourceVoucher: source });
    assert.ok(directional.rows[0].fieldValues[`voucher.${targetVoucherMode}.line.quantity`], `${sourceVoucherMode} → ${targetVoucherMode} 수량 연결`);
    assert.ok(directional.rows[0].fieldValues[`voucher.${targetVoucherMode}.line.unitPrice`], `${sourceVoucherMode} → ${targetVoucherMode} 단가 연결`);
  }
}

const target = {
  header: { customerId: 'OTHER', customerName: '다른 거래처', warehouseId: 'W2', warehouseName: '2창고' },
  rows: []
};
assert.deepEqual(relatedImportConflicts(plan, target.header).map(item => item.kind), ['CUSTOMER', 'WAREHOUSE']);
assert.throws(() => applyRelatedVoucherImportPlan(plan, target), error => error.message === 'RELATED_IMPORT_CONFIRMATION_REQUIRED' && error.conflicts.length === 2);
const applied = applyRelatedVoucherImportPlan(plan, target, { acceptConflicts: true });
assert.equal(applied.header.customerId, 'OTHER', 'confirmed conflicts must preserve the current header instead of silently overwriting it');
assert.equal(applied.rows[0].rowCustomerId, 'C-SUPPLIER', 'source row identity must remain available for safe voucher grouping');
assert.equal(applied.relatedImportHistory[0].rowCount, 2);

const repeated = applyRelatedVoucherImportPlan(plan, applied, { acceptConflicts: true });
assert.equal(repeated.rows.length, 2, 'the same source voucher lines must be idempotent in one draft');

assert.throws(() => createRelatedVoucherImportPlan({
  companyId: 'C2', sourceVoucherMode: 'purchase', targetVoucherMode: 'sale', sourceVoucher: source
}), /RELATED_IMPORT_COMPANY_MISMATCH/);

console.log('SmartInput related-voucher import plan, target semantics, conflict confirmation, and idempotency passed.');
