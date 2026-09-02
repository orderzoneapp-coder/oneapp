#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOrderGroupPayload,
  groupVoucherRows,
  normalizeStage1Row
} from '../smartinput/multivoucher-stage1.js';
import {
  buildPurchasePostDraft,
  derivePurchaseDraftIdentity,
  validatePurchaseGroup as validatePurchaseGroupAgainstMasters
} from '../smartinput/purchase-official-stage3.js';
import {
  buildSalePostDraft,
  deriveSaleDraftIdentity,
  validateSaleGroup
} from '../smartinput/sale-official-stage4.js';
import { validatePurchaseGroup as validatePurchaseGroupFromSmartInput } from '../smartinput/legacy-integration-adapter.js';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';
import { createInventoryCheckpoint, planPendingInventoryResolution } from '../orderq/inventory-rematch-core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixedAt = '2026-09-02T09:00:00.000Z';
const fixedDate = '2026-09-02';

function purchaseGroup(overrides = {}) {
  const base = {
    companyId: 'COMPANY-A',
    supplierCustomerId: 'CUSTOMER-A',
    supplierCustomerCode: 'C-A',
    supplierCustomerName: '기준 구매처',
    voucherDate: fixedDate,
    warehouseId: 'WAREHOUSE-A',
    warehouseCode: 'W-A',
    sourceVoucherIndex: 1,
    rows: [{
      itemCode: 'ITEM-A', itemName: '기준 상품', productId: 'PRODUCT-A',
      warehouseId: 'WAREHOUSE-A', quantity: 2, unit: 'EA', unitPrice: 1000,
      conversionFactor: 1, productMasterRevision: 1, warehouseMasterRevision: 1
    }]
  };
  return { ...base, ...overrides, rows: overrides.rows || base.rows };
}

function saleGroup(overrides = {}) {
  const base = {
    companyId: 'COMPANY-A',
    originSystem: 'SMARTINPUT_MANUAL',
    originTransactionId: 'SALE-SESSION-A',
    salesCustomerId: 'CUSTOMER-A',
    salesCustomerName: '기준 판매처',
    deliveryCustomerId: 'CUSTOMER-A',
    deliveryCustomerName: '기준 판매처',
    billingCustomerId: 'CUSTOMER-A',
    billingCustomerName: '기준 판매처',
    salesCustomerRevision: 1,
    deliveryCustomerRevision: 1,
    billingCustomerRevision: 1,
    voucherDate: fixedDate,
    warehouseId: 'WAREHOUSE-A',
    warehouseCode: 'W-A',
    sourceVoucherIndex: 1,
    rows: [{
      itemCode: 'ITEM-A', itemName: '기준 상품', productId: 'PRODUCT-A',
      warehouseId: 'WAREHOUSE-A', quantity: 3, unit: 'EA', unitPrice: 1200,
      orderLinkMode: 'DIRECT', actualToBaseFactor: 1,
      productMasterRevision: 1, warehouseMasterRevision: 1
    }]
  };
  return { ...base, ...overrides, rows: overrides.rows || base.rows };
}

function planPurchase(group, context = {}) {
  const draft = buildPurchasePostDraft(group, {
    companyId: context.companyId || group.companyId,
    originSystem: context.originSystem || 'SMARTINPUT_MANUAL',
    manualSessionId: context.manualSessionId || 'PURCHASE-SESSION-A',
    actor: 'BASELINE-TEST',
    occurredAt: fixedAt
  });
  const document = { ...draft.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
  return { draft, plan: planOfficialVoucherCommand({ command: draft.commandSource, document, lines: draft.lines }) };
}

function planSale(group, context = {}) {
  const draft = buildSalePostDraft(group, {
    companyId: context.companyId || group.companyId,
    originSystem: context.originSystem || 'SMARTINPUT_MANUAL',
    manualSessionId: context.manualSessionId || group.originTransactionId || 'SALE-SESSION-A',
    actor: 'BASELINE-TEST',
    occurredAt: fixedAt
  });
  const document = { ...draft.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
  return { draft, plan: planOfficialVoucherCommand({ command: draft.commandSource, document, lines: draft.lines }) };
}

// Normal current behavior: exact product/partner IDs create signed inventory and AP/AR effects.
const exactPurchase = planPurchase(purchaseGroup());
assert.equal(exactPurchase.plan.inventoryMovements[0].signedQuantity, 2);
assert.equal(exactPurchase.plan.ledgerEntries[0].totalAmount, 2000);
assert.equal(exactPurchase.plan.ledgerEntries[0].partnerId, 'CUSTOMER-A');

const exactSale = planSale(saleGroup());
assert.equal(exactSale.plan.inventoryMovements[0].signedQuantity, -3);
assert.equal(exactSale.plan.ledgerEntries[0].totalAmount, 3600);
assert.equal(exactSale.plan.ledgerEntries[0].partnerId, 'CUSTOMER-A');

const zeroPurchase = planPurchase(purchaseGroup({
  rows: [{ ...purchaseGroup().rows[0], quantity: 0 }]
}));
assert.equal(zeroPurchase.plan.inventoryMovements.length, 0, 'current zero quantity is represented by no inventory movement');
assert.equal(zeroPurchase.plan.ledgerEntries[0].totalAmount, 0);

const negativePurchase = planPurchase(purchaseGroup({
  rows: [{ ...purchaseGroup().rows[0], quantity: -2 }]
}));
assert.equal(negativePurchase.plan.inventoryMovements[0].signedQuantity, -2);

const negativeSale = planSale(saleGroup({
  rows: [{ ...saleGroup().rows[0], quantity: -3 }]
}));
assert.equal(negativeSale.plan.inventoryMovements[0].signedQuantity, 3);

// Confirmed intent is frozen and the planned Revision is a detached Snapshot.
const snapshotSource = purchaseGroup();
const snapshot = planPurchase(snapshotSource);
snapshotSource.supplierCustomerName = '나중에 바뀐 구매처';
snapshotSource.rows[0].itemName = '나중에 바뀐 상품';
assert.equal(Object.isFrozen(snapshot.draft.commandEnvelope), true);
assert.equal(snapshot.draft.commandEnvelope.document.supplierCustomerName, '기준 구매처');
assert.equal(snapshot.plan.voucherRevision.afterSnapshot.partnerId, 'CUSTOMER-A');
assert.equal(snapshot.plan.voucherRevision.afterSnapshot.lines[0].productId, 'PRODUCT-A');

// CURRENT_BASELINE_GAP: companyId is not part of either official document ID.
const purchaseCompanyA = derivePurchaseDraftIdentity(purchaseGroup({ companyId: 'COMPANY-A' }), {
  companyId: 'COMPANY-A', manualSessionId: 'SAME-PURCHASE-SOURCE'
});
const purchaseCompanyB = derivePurchaseDraftIdentity(purchaseGroup({ companyId: 'COMPANY-B' }), {
  companyId: 'COMPANY-B', manualSessionId: 'SAME-PURCHASE-SOURCE'
});
assert.equal(purchaseCompanyA.purchaseDocumentId, purchaseCompanyB.purchaseDocumentId,
  'characterization: the same purchase source currently collides across companies');

const saleCompanyA = deriveSaleDraftIdentity(saleGroup({ companyId: 'COMPANY-A' }), { companyId: 'COMPANY-A' });
const saleCompanyB = deriveSaleDraftIdentity(saleGroup({ companyId: 'COMPANY-B' }), { companyId: 'COMPANY-B' });
assert.equal(saleCompanyA.salesDocumentId, saleCompanyB.salesDocumentId,
  'characterization: the same sale source currently collides across companies');

// CURRENT_BASELINE_GAP: an imported sheet key is copied to every role-based sale group.
const groupedSales = groupVoucherRows('sale', [
  {
    sourceBatchId: 'BATCH-A', sourceDocumentKey: 'sales.xlsx:Sheet1', sourceVoucherIndex: 1,
    rowCustomerId: 'CUSTOMER-A', rowCustomerName: '판매처 A', rowVoucherDate: fixedDate,
    rowWarehouseId: 'WAREHOUSE-A', rowWarehouseCode: 'W-A', itemCode: 'ITEM-A', itemName: '상품 A',
    productId: 'PRODUCT-A', quantity: 1, unit: 'EA', unitPrice: 1000
  },
  {
    sourceBatchId: 'BATCH-A', sourceDocumentKey: 'sales.xlsx:Sheet1', sourceVoucherIndex: 1,
    rowCustomerId: 'CUSTOMER-B', rowCustomerName: '판매처 B', rowVoucherDate: fixedDate,
    rowWarehouseId: 'WAREHOUSE-A', rowWarehouseCode: 'W-A', itemCode: 'ITEM-B', itemName: '상품 B',
    productId: 'PRODUCT-B', quantity: 1, unit: 'EA', unitPrice: 2000
  }
], {});
assert.equal(groupedSales.length, 2);
assert.notEqual(groupedSales[0].voucherGroupKey, groupedSales[1].voucherGroupKey);
assert.notEqual(groupedSales[0].idempotencyKey, groupedSales[1].idempotencyKey);
const groupedSaleIds = groupedSales.map(group => deriveSaleDraftIdentity(group, {
  companyId: 'COMPANY-A', originSystem: 'SMARTINPUT_FILE', manualSessionId: 'BATCH-A'
}).salesDocumentId);
assert.equal(new Set(groupedSaleIds).size, 1,
  'characterization: distinct SmartInput sale groups currently collapse to one official salesDocumentId');

// CURRENT_BASELINE_GAP: SmartInput imports a weak purchase validator and omits sale master validation.
const bogusPurchase = purchaseGroup({ supplierCustomerId: 'NOT-IN-MASTER' });
assert.throws(() => validatePurchaseGroupAgainstMasters(bogusPurchase, {
  customers: [], products: [], warehouses: []
}), /ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID/);
assert.doesNotThrow(() => validatePurchaseGroupFromSmartInput(bogusPurchase));
const bogusPurchasePlan = planPurchase(bogusPurchase).plan;
assert.equal(bogusPurchasePlan.ledgerEntries[0].partnerId, 'NOT-IN-MASTER');

const bogusSale = saleGroup({
  salesCustomerId: 'NOT-IN-MASTER', deliveryCustomerId: 'NOT-IN-MASTER', billingCustomerId: 'NOT-IN-MASTER'
});
assert.throws(() => validateSaleGroup(bogusSale, { customers: [], products: [], warehouses: [] }),
  /ORDERQ_SALE_CUSTOMER_MASTER_INVALID/);
const bogusSalePlan = planSale(bogusSale).plan;
assert.equal(bogusSalePlan.ledgerEntries[0].partnerId, 'NOT-IN-MASTER');

const blankDateSale = saleGroup({
  voucherDate: '', saleDate: '',
  rows: [{
    ...saleGroup().rows[0], actualUnit: 'EA', baseUnit: 'EA',
    conversionSource: 'DIRECT_SAME_UNIT', conversionRuleVersion: 'DIRECT_1_TO_1_V1'
  }]
});
assert.throws(() => validateSaleGroup(blankDateSale, {
  customers: [{ customerId: 'CUSTOMER-A', status: 'ACTIVE', qualityStatus: 'VERIFIED', revision: 1 }],
  products: [{ productId: 'PRODUCT-A', status: 'ACTIVE', revision: 1 }],
  warehouses: [{ warehouseId: 'WAREHOUSE-A', status: 'ACTIVE', revision: 1 }],
  orders: [], orderItems: []
}), /ORDERQ_SALE_DATE_REQUIRED/);
assert.equal(planSale(blankDateSale).plan.document.saleDate, '',
  'characterization: bypassing the unused sale master validator also permits an empty sale date');
assert.throws(() => planSale(saleGroup({
  warehouseId: '', rows: [{ ...saleGroup().rows[0], warehouseId: '' }]
})), /ORDERQ_OFFICIAL_WAREHOUSE_REQUIRED/);

const smartInputSource = readFileSync(resolve(root, 'smartinput', 'smartinput.js'), 'utf8');
const saleHandler = smartInputSource.slice(
  smartInputSource.indexOf('async function completeSaleOfficial()'),
  smartInputSource.indexOf('async function completePurchaseOfficial()')
);
assert.doesNotMatch(saleHandler, /validateSaleGroup\s*\(/,
  'characterization: current sale save handler does not invoke the available master validator');
assert.doesNotMatch(saleHandler, /postSaleGroup\([^;]*masters\s*:/s,
  'characterization: current sale save handler does not pass masters to postSaleGroup');

// Blank numeric input stays null in the grid, but current compatibility helpers can coerce it to zero.
const blankStageRow = normalizeStage1Row({ itemName: '공란 숫자 상품', quantity: '', unitPrice: '' });
assert.equal(blankStageRow.quantity, null);
assert.equal(blankStageRow.unitPrice, '');
assert.doesNotThrow(() => validatePurchaseGroupFromSmartInput({
  supplierCustomerName: '이름만 있는 구매처', voucherDate: fixedDate,
  rows: [{ itemName: '공란 숫자 상품', quantity: null, unitPrice: null }]
}), 'legacy preflight currently treats Number(null) as finite');
const legacyPayload = buildOrderGroupPayload({
  idempotencyKey: 'LEGACY-BLANK', rows: [{ itemName: '공란 숫자 상품', quantity: null, unitPrice: null }]
});
assert.equal(legacyPayload.items[0].supplyAmount, 0,
  'characterization: the legacy order payload helper coerces missing quantity and unit price to zero');
assert.throws(() => buildPurchasePostDraft(purchaseGroup({
  rows: [{ ...purchaseGroup().rows[0], quantity: null }]
}), { companyId: 'COMPANY-A', manualSessionId: 'BLANK-QTY', occurredAt: fixedAt }),
  /ORDERQ_PURCHASE_QUANTITY_REQUIRED/);
assert.throws(() => buildPurchasePostDraft(purchaseGroup({
  rows: [{ ...purchaseGroup().rows[0], unitPrice: null }]
}), { companyId: 'COMPANY-A', manualSessionId: 'BLANK-PRICE', occurredAt: fixedAt }),
  /ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED/);
assert.throws(() => buildSalePostDraft(saleGroup({
  rows: [{ ...saleGroup().rows[0], quantity: null }]
}), { companyId: 'COMPANY-A', occurredAt: fixedAt }), /ORDERQ_SALE_QUANTITY_REQUIRED/);
assert.throws(() => buildSalePostDraft(saleGroup({
  rows: [{ ...saleGroup().rows[0], unitPrice: null }]
}), { companyId: 'COMPANY-A', occurredAt: fixedAt }), /ORDERQ_SALE_UNIT_PRICE_REQUIRED/);

// Current official core blocks a missing partner; a non-empty unverified ID creates AP/AR.
assert.throws(() => planPurchase(purchaseGroup({ supplierCustomerId: '' })),
  /ORDERQ_OFFICIAL_PURCHASE_PARTNER_REQUIRED/);
assert.throws(() => planSale(saleGroup({
  salesCustomerId: '', deliveryCustomerId: '', billingCustomerId: ''
})), /ORDERQ_OFFICIAL_SALE_PARTNER_REQUIRED/);
assert.equal(bogusPurchasePlan.ledgerEntries.length, 1);
assert.equal(bogusSalePlan.ledgerEntries.length, 1);

// CURRENT_BASELINE_GAP: delayed matches before or on a date-only stocktake are auto-suppressed.
const checkpoint = createInventoryCheckpoint({
  companyId: 'COMPANY-A', warehouseId: 'WAREHOUSE-A', sessionId: 'COUNT-A',
  effectiveAt: '2026-09-10', coversAllProducts: true,
  counts: [{ productId: 'PRODUCT-A', quantity: 10 }], actor: 'BASELINE-TEST', confirmedAt: fixedAt
});
const pendingEffect = (pendingEffectId, effectiveAt) => ({
  pendingEffectId, companyId: 'COMPANY-A', warehouseId: 'WAREHOUSE-A',
  unresolvedProductId: 'UNRESOLVED-A', sourceDocumentId: 'PD-A', sourceLineId: `PL-${pendingEffectId}`,
  sourceDocumentRevision: 2, voucherMode: 'purchase', effectiveAt, signedQuantity: 2,
  status: 'PENDING_PRODUCT_MATCH', commandId: `CMD-${pendingEffectId}`, createdAt: fixedAt
});
const rematch = planPendingInventoryResolution({
  companyId: 'COMPANY-A', unresolvedProductId: 'UNRESOLVED-A', productId: 'PRODUCT-A',
  pendingEffects: [
    pendingEffect('BEFORE', '2026-09-09'),
    pendingEffect('SAME-DATE-UNKNOWN-TIME', '2026-09-10'),
    pendingEffect('AFTER', '2026-09-11')
  ],
  inventoryCheckpoints: [checkpoint], actor: 'BASELINE-TEST', occurredAt: '2026-09-12T09:00:00.000Z'
});
assert.deepEqual(rematch.resolvedEffects.map(row => row.status), [
  'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE',
  'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE',
  'RESOLVED_TO_INVENTORY'
]);
assert.deepEqual(rematch.inventoryMovements.map(row => row.pendingEffectId), ['AFTER']);

// CURRENT_BASELINE_GAP: current builders apply conversion factors before inventory projection.
const convertedPurchase = planPurchase(purchaseGroup({
  rows: [{ ...purchaseGroup().rows[0], quantity: 2, unit: 'BOX', baseUnit: 'EA', conversionFactor: 12 }]
}));
assert.equal(convertedPurchase.plan.inventoryMovements[0].signedQuantity, 24);

const convertedSaleGroup = saleGroup({
  sourceType: 'ORDER_Q', sourceDocumentKey: 'ORDER-Q-SALE-CONVERSION',
  rows: [{
    ...saleGroup().rows[0], sourceType: 'ORDER_Q', sourceDocumentKey: 'ORDER-Q-SALE-CONVERSION',
    orderLinkMode: 'ORDER_Q', quantity: 2, actualUnit: 'BOX', baseUnit: 'EA',
    actualToBaseFactor: 12, actualToRecognizedFactor: 1,
    conversionSource: 'ORDER_LINE_SNAPSHOT', conversionRuleId: 'RULE-A', conversionRuleVersion: '1'
  }]
});
const convertedSale = planSale(convertedSaleGroup);
assert.equal(convertedSale.plan.inventoryMovements[0].signedQuantity, -24);

console.log(JSON.stringify({
  baseline: 'NEXUS-SI-V2-01',
  normal: {
    purchaseInventory: 2,
    saleInventory: -3,
    zeroInventoryMovementCount: 0,
    negativeQuantitiesAccepted: true,
    frozenRevisionSnapshot: true
  },
  currentGaps: {
    crossCompanyPurchaseIdCollision: true,
    crossCompanySaleIdCollision: true,
    multiGroupSaleIdCollision: true,
    masterValidationBypassWithNonemptyId: true,
    saleDateValidationBypass: true,
    legacyBlankAmountCoercion: true,
    officialBlankCommitBlocked: true,
    missingPartnerCommitBlocked: true,
    unmatchedNonemptyPartnerCreatesLedger: true,
    stocktakeBeforeAndSameDateAutoSuppressed: true,
    currentConversionAffectsInventory: true
  },
  targetExpectationsRecordedOnly: {
    companyAndSaleGroupScopedIds: true,
    blankBeforeNumberConversion: true,
    optionalPartnerWithoutLedger: true,
    stocktakeUserChoice: ['INCLUDED', 'NOT_INCLUDED', 'CANCEL'],
    noBusinessUnitConversion: true
  }
}, null, 2));
console.log('SmartInput official voucher V2 phase-1 characterization baseline PASS');
