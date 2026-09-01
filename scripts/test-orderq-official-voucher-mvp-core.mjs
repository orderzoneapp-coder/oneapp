#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  calculateOfficialDocumentAmount,
  planOfficialVoucherCommand,
  resolveOfficialLineAmounts,
  unresolvedProductStableId
} from '../orderq/official-voucher-core.js';
import { buildPurchasePostDraft } from '../smartinput/purchase-official-stage3.js';
import { buildSalePostDraft } from '../smartinput/sale-official-stage4.js';

const at = '2026-09-01T09:00:00.000Z';

const unresolvedIdentity = unresolvedProductStableId('COMPANY-1', {
  itemName: ' 미매칭 사과 ', specification: '10KG', unit: 'BOX'
});
assert.equal(unresolvedIdentity, unresolvedProductStableId('COMPANY-1', {
  itemName: '미매칭  사과', specification: '10kg', unit: 'box'
}), '같은 회사의 같은 미매칭 상품 표기는 하나의 안정적인 시스템 ID를 가져야 한다.');

const unresolvedPurchaseDraft = buildPurchasePostDraft({
  companyId: 'COMPANY-1', supplierCustomerId: 'CUSTOMER-1', supplierCustomerName: '거래처',
  voucherDate: '2026-09-01', warehouseId: 'WAREHOUSE-1', sourceVoucherIndex: 1,
  rows: [{ itemName: '미매칭 사과', specification: '10kg', unit: 'BOX', quantity: 1, unitPrice: 1000,
    warehouseId: 'WAREHOUSE-1', conversionFactor: 1 }]
}, { companyId: 'COMPANY-1', occurredAt: at, manualSessionId: 'PURCHASE-UNRESOLVED' });
const unresolvedSaleDraft = buildSalePostDraft({
  companyId: 'COMPANY-1', originSystem: 'SMARTINPUT_MANUAL', originTransactionId: 'SALE-UNRESOLVED',
  salesCustomerId: 'CUSTOMER-1', deliveryCustomerId: 'CUSTOMER-1', billingCustomerId: 'CUSTOMER-1',
  salesCustomerRevision: 1, deliveryCustomerRevision: 1, billingCustomerRevision: 1,
  voucherDate: '2026-09-01', warehouseId: 'WAREHOUSE-1', sourceVoucherIndex: 1,
  rows: [{ itemName: '미매칭 사과', specification: '10kg', unit: 'BOX', actualUnit: 'BOX',
    quantity: 1, unitPrice: 1300, warehouseId: 'WAREHOUSE-1', orderLinkMode: 'DIRECT', actualToBaseFactor: 1 }]
}, { companyId: 'COMPANY-1', occurredAt: at });
assert.equal(unresolvedPurchaseDraft.lines[0].unresolvedProductId, unresolvedIdentity);
assert.equal(unresolvedSaleDraft.lines[0].unresolvedProductId, unresolvedIdentity,
  '구매와 판매의 같은 미매칭 상품은 동일 시스템 ID로 채권·채무 연결이 가능해야 한다.');

function purchaseDraft(overrides = {}) {
  return {
    companyId: 'COMPANY-1',
    purchaseDocumentId: 'PD-1',
    supplierCustomerId: 'CUSTOMER-1',
    warehouseId: 'WAREHOUSE-1',
    purchaseDate: '2026-09-01',
    status: 'DRAFT',
    businessStatus: 'DRAFT',
    revision: 1,
    ...overrides
  };
}

function purchaseLine(overrides = {}) {
  return {
    purchaseLineId: 'PL-1',
    purchaseDocumentId: 'PD-1',
    lineIdentityId: 'LI-1',
    productId: 'PRODUCT-1',
    warehouseId: 'WAREHOUSE-1',
    actualQuantity: 10,
    baseQuantity: 10,
    unitPrice: 1000,
    ...overrides
  };
}

function command(commandType, expectedRevision, overrides = {}) {
  const commandId = `${commandType}-COMMAND-${expectedRevision}`;
  return {
    commandType,
    commandId,
    idempotencyKey: commandId,
    companyId: 'COMPANY-1',
    expectedRevision,
    actor: 'TESTER',
    occurredAt: at,
    reason: commandType.startsWith('POST_') ? '' : 'TEST',
    ...overrides
  };
}

const sourceAmount = resolveOfficialLineAmounts({
  quantity: 10,
  unitPrice: 1000,
  supplyAmount: '10,001',
  vatAmount: 1000,
  totalAmount: 11001
});
assert.equal(sourceAmount.supplyAmount, 10001, '엑셀/사용자 공급가액을 계산값으로 덮어쓰면 안 된다.');
assert.equal(sourceAmount.calculatedSupplyAmount, 10000);
assert.equal(sourceAmount.amountDifference, 1);
assert.equal(sourceAmount.valueOrigin, 'SOURCE_OR_USER');

const derivedAmount = resolveOfficialLineAmounts({ quantity: 3, unitPrice: 333.4 });
assert.equal(derivedAmount.supplyAmount, 1000);
assert.equal(derivedAmount.valueOrigin, 'DERIVED_AT_SAVE');
const documentAmount = calculateOfficialDocumentAmount([
  { quantity: 1, unitPrice: 1000, supplyAmount: 999, totalAmount: 999 },
  { quantity: 2, unitPrice: 500, supplyAmount: 1001, totalAmount: 1001 }
]);
assert.equal(documentAmount.supplyAmount, 2000);
assert.equal(documentAmount.calculatedSupplyAmount, 2000);

const postedPurchase = planOfficialVoucherCommand({
  command: command('POST_PURCHASE', 1, { lines: [purchaseLine({ supplyAmount: 10001, totalAmount: 10001 })] }),
  document: purchaseDraft(),
  lines: [purchaseLine()]
});
assert.equal(postedPurchase.document.status, 'CONFIRMED');
assert.equal(postedPurchase.document.revision, 2);
assert.equal(postedPurchase.document.supplyAmount, 10001);
assert.equal(postedPurchase.inventoryMovements[0].signedQuantity, 10);
assert.equal(postedPurchase.ledgerEntries[0].totalAmount, 10001);

const correctedPurchase = planOfficialVoucherCommand({
  command: command('CORRECT_PURCHASE', 2, {
    lines: [purchaseLine({ actualQuantity: 12, baseQuantity: 12, supplyAmount: 12000, totalAmount: 12000 })]
  }),
  document: postedPurchase.document,
  lines: postedPurchase.lines
});
assert.equal(correctedPurchase.document.revision, 3);
assert.equal(correctedPurchase.inventoryMovements[0].signedQuantity, 2, '정정은 전체가 아니라 차이만 재고에 반영해야 한다.');
assert.equal(correctedPurchase.ledgerEntries[0].totalAmount, 1999, '정정은 채무 차이만 기록해야 한다.');

const reversedPurchase = planOfficialVoucherCommand({
  command: command('REVERSE_PURCHASE', 3),
  document: correctedPurchase.document,
  lines: correctedPurchase.lines
});
assert.equal(reversedPurchase.document.status, 'REVERSED');
assert.equal(reversedPurchase.inventoryMovements[0].signedQuantity, -12);
assert.equal(reversedPurchase.ledgerEntries[0].totalAmount, -12000);

const unresolvedSaleLine = {
  salesLineId: 'SL-U1',
  salesDocumentId: 'SD-U1',
  lineIdentityId: 'LI-U1',
  unresolvedProductId: 'UNRESOLVED-1',
  warehouseId: 'WAREHOUSE-1',
  actualQuantity: 2,
  baseQuantity: 2,
  unitPrice: 1500,
  supplyAmount: 3000,
  totalAmount: 3000
};
const unresolvedSale = planOfficialVoucherCommand({
  command: command('POST_SALE', 1, { lines: [unresolvedSaleLine] }),
  document: {
    companyId: 'COMPANY-1',
    salesDocumentId: 'SD-U1',
    billingCustomerId: 'CUSTOMER-1',
    warehouseId: 'WAREHOUSE-1',
    saleDate: '2026-09-01',
    status: 'DRAFT',
    businessStatus: 'DRAFT',
    revision: 1
  },
  lines: [unresolvedSaleLine]
});
assert.equal(unresolvedSale.inventoryMovements.length, 0, '미매칭 상품은 재고수불부에 반영하면 안 된다.');
assert.equal(unresolvedSale.pendingInventoryEffects.length, 1);
assert.equal(unresolvedSale.pendingInventoryEffects[0].signedQuantity, -2);
assert.equal(unresolvedSale.ledgerEntries[0].totalAmount, 3000, '미매칭 상품도 채권에는 반영되어야 한다.');

assert.throws(() => planOfficialVoucherCommand({
  command: command('POST_PURCHASE', 1, { companyId: '', lines: [purchaseLine()] }),
  document: purchaseDraft({ companyId: '' }),
  lines: [purchaseLine()]
}), /ORDERQ_OFFICIAL_COMPANY_REQUIRED/);

assert.throws(() => planOfficialVoucherCommand({
  command: command('CORRECT_PURCHASE', 1, { lines: [purchaseLine()] }),
  document: postedPurchase.document,
  lines: postedPurchase.lines
}), /ORDERQ_OFFICIAL_REVISION_CONFLICT/);

console.log('Official voucher MVP amount preservation, revision, inventory, AR/AP, and unresolved-product rules passed.');
