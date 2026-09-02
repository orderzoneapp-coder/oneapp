#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blockedMutations = [];
globalThis.fetch = async (url, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) blockedMutations.push({ url: String(url), method });
  throw new Error('STAGE4_TEST_NETWORK_DISABLED');
};

const resolverModule = await import('../smartinput/official-voucher-reference-resolver.js');
const purchaseModule = await import('../smartinput/purchase-official-stage3.js');
const saleModule = await import('../smartinput/sale-official-stage4.js');
const core = await import('../orderq/official-voucher-core.js');
const contract = await import('../orderq/official-voucher-v2-contract.js');
const gateway = await import('../orderq/official-command-gateway.js');

const { resolveOfficialVoucherReferencesV2 } = resolverModule;
const { buildPurchasePostDraft } = purchaseModule;
const { buildSalePostDraft } = saleModule;
const {
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  assertOfficialCommandV2,
  assertOfficialLedgerProjectionV2
} = contract;

const companyId = 'COMPANY-A';
const context = {
  companyId,
  identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  originSystem: 'SMARTINPUT_STAGE4_TEST',
  manualSessionId: 'STAGE4-TEST',
  actor: 'STAGE4-TEST',
  occurredAt: '2026-09-02T10:00:00.000Z'
};
const products = [
  { companyId, productId: 'PRODUCT-0007-A', itemCode: '0007', itemName: '동일명 상품', status: 'ACTIVE', revision: 4 },
  { companyId, productId: 'PRODUCT-7-A', itemCode: '7', itemName: '동일명 상품', status: 'ACTIVE', revision: 2 },
  { companyId: 'COMPANY-B', productId: 'PRODUCT-0007-B', itemCode: '0007', itemName: '동일명 상품', status: 'ACTIVE', revision: 8 }
];
const customers = [
  { companyId, customerId: 'CUSTOMER-0003-A', customerCode: '0003', customerName: '동일명 거래처', status: 'ACTIVE', revision: 5 },
  { companyId, customerId: 'CUSTOMER-3-A', customerCode: '3', customerName: '동일명 거래처', status: 'ACTIVE', revision: 2 },
  { companyId: 'COMPANY-B', customerId: 'CUSTOMER-0003-B', customerCode: '0003', customerName: '동일명 거래처', status: 'ACTIVE', revision: 7 }
];

function row(rowId, overrides = {}) {
  return {
    rowId,
    itemCode: '0007',
    itemName: '확정 당시 상품명',
    specification: '10kg',
    unit: 'BOX',
    productId: 'STALE-TECHNICAL-ID',
    warehouseId: 'WAREHOUSE-A',
    quantity: 10,
    unitPrice: 1250,
    conversionFactor: 12,
    actualToBaseFactor: 12,
    sourceLineKey: rowId,
    ...overrides
  };
}

function group(kind, suffix, overrides = {}) {
  const purchase = kind === 'PURCHASE';
  return {
    companyId,
    voucherGroupKey: `${kind}|STAGE4|${suffix}`,
    voucherDate: '2026-08-05',
    warehouseId: 'WAREHOUSE-A',
    warehouseCode: 'WH-A',
    sourceDocumentKey: `${kind}|STAGE4|${suffix}`,
    originSystem: 'SMARTINPUT_STAGE4_TEST',
    originTransactionId: `${kind}|STAGE4|${suffix}`,
    sourceVoucherIndex: 1,
    ...(purchase ? {
      supplierCustomerId: 'STALE-CUSTOMER-ID',
      supplierCustomerCode: '0003',
      supplierCustomerName: '확정 당시 거래처명'
    } : {
      salesCustomerId: 'STALE-CUSTOMER-ID',
      salesCustomerCode: '0003',
      salesCustomerName: '확정 당시 거래처명',
      deliveryCustomerId: '',
      deliveryCustomerCode: '',
      deliveryCustomerName: '',
      billingCustomerId: '',
      billingCustomerCode: '',
      billingCustomerName: ''
    }),
    rows: [row(`${suffix}-1`)],
    ...overrides
  };
}

function resolve(kind, source, referenceProducts = products, referenceCustomers = customers) {
  return resolveOfficialVoucherReferencesV2({
    kind,
    companyId: source.companyId,
    group: source,
    products: referenceProducts,
    customers: referenceCustomers,
    productReferenceSnapshotId: 'PRODUCT-SNAPSHOT-4',
    customerReferenceSnapshotId: 'CUSTOMER-SNAPSHOT-5'
  });
}

function draftAndPlan(kind, suffix, overrides = {}, referenceProducts = products, referenceCustomers = customers) {
  const resolved = resolve(kind, group(kind, suffix, overrides), referenceProducts, referenceCustomers);
  const draft = kind === 'PURCHASE'
    ? buildPurchasePostDraft(resolved, context)
    : buildSalePostDraft(resolved, context);
  const document = { ...draft.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
  const plan = core.planOfficialVoucherCommand({ command: draft.commandSource, document, lines: draft.lines });
  return { resolved, draft, plan };
}

const purchasePositive = draftAndPlan('PURCHASE', 'POSITIVE');
assert.equal(purchasePositive.resolved.rows[0].productId, 'PRODUCT-0007-A', 'stale productId must be replaced by exact company+code resolution');
assert.equal(purchasePositive.plan.inventoryMovements[0].signedQuantity, 10);
assert.equal(purchasePositive.plan.inventoryMovements[0].effectStatus, 'APPLIED_NORMAL');
assert.equal(purchasePositive.plan.inventoryMovements[0].inventoryEffectFactor, 1);
assert.equal(purchasePositive.plan.lines[0].baseQuantity, 10, 'V2 must ignore a legacy factor of 12');
assert.equal(purchasePositive.plan.ledgerEntries[0].partnerId, 'CUSTOMER-0003-A');
assert.equal(purchasePositive.plan.ledgerEntries[0].effectiveAt, '2026-08-05');
assert.equal(purchasePositive.plan.ledgerEntries[0].occurredAt, context.occurredAt);
assert.doesNotThrow(() => assertOfficialLedgerProjectionV2(purchasePositive.plan, purchasePositive.draft.commandSource));

const salePositive = draftAndPlan('SALE', 'POSITIVE');
assert.equal(salePositive.plan.inventoryMovements[0].signedQuantity, -10);
assert.equal(salePositive.plan.inventoryMovements[0].effectStatus, 'APPLIED_NORMAL');
assert.equal(salePositive.plan.ledgerEntries[0].partnerId, 'CUSTOMER-0003-A');
assert.equal(salePositive.plan.ledgerEntries[0].effectiveAt, '2026-08-05');
assert.equal(salePositive.plan.ledgerEntries[0].occurredAt, context.occurredAt);
assert.doesNotThrow(() => assertOfficialLedgerProjectionV2(salePositive.plan, salePositive.draft.commandSource));

for (const kind of ['PURCHASE', 'SALE']) {
  const negative = draftAndPlan(kind, 'NEGATIVE', { rows: [row(`${kind}-NEGATIVE`, { quantity: -10 })] });
  assert.equal(negative.plan.inventoryMovements[0].signedQuantity, kind === 'PURCHASE' ? -10 : 10);
  const zero = draftAndPlan(kind, 'ZERO', { rows: [row(`${kind}-ZERO`, { quantity: 0, unitPrice: 0 })] });
  assert.equal(zero.plan.inventoryMovements.length, 1, 'matched quantity zero must persist one auditable effect');
  assert.equal(zero.plan.inventoryMovements[0].signedQuantity, 0);
  assert.equal(zero.plan.inventoryMovements[0].effectStatus, 'ZERO_EFFECT');
}

const explicitAmount = draftAndPlan('PURCHASE', 'EXPLICIT-AMOUNT', {
  rows: [row('EXPLICIT-AMOUNT', { quantity: 2, unitPrice: 1000, finalAmount: -77 })]
});
assert.equal(explicitAmount.plan.document.totalAmount, -77);
assert.equal(explicitAmount.plan.ledgerEntries[0].totalAmount, -77, 'basic AP must use the confirmed final amount');

const nameOnly = draftAndPlan('PURCHASE', 'NAME-ONLY', {
  rows: [row('NAME-ONLY', { itemCode: '', itemName: '동일명 상품', productId: 'STALE-NAME-MATCH' })]
});
assert.equal(nameOnly.resolved.rows[0].officialProductResolution.status, 'UNRESOLVED_PRODUCT');
assert.equal(nameOnly.resolved.rows[0].officialProductResolution.reason, 'PRODUCT_CODE_NOT_PROVIDED');
assert.equal(nameOnly.plan.inventoryMovements.length, 0, 'name-only rows must not create official inventory');
assert.equal(nameOnly.plan.pendingInventoryEffects.length, 1);
assert.equal(nameOnly.plan.pendingInventoryEffects[0].inventoryEffectStatus, 'UNRESOLVED_PRODUCT');
assert.equal(nameOnly.plan.pendingInventoryEffects[0].officialInventoryApplied, false);
assert.equal(nameOnly.plan.pendingInventoryEffects[0].productName, '동일명 상품');
assert.equal(nameOnly.plan.pendingInventoryEffects[0].sourceDocumentId, nameOnly.plan.document.purchaseDocumentId);
assert.equal(nameOnly.plan.pendingInventoryEffects[0].sourceLineId, nameOnly.plan.lines[0].purchaseLineId);
assert.equal(nameOnly.plan.pendingInventoryEffects[0].voucherRevisionId, nameOnly.plan.voucherRevision.voucherRevisionId);

const unmatchedCode = draftAndPlan('SALE', 'UNMATCHED-CODE', {
  rows: [row('UNMATCHED-CODE', { itemCode: '0099', itemName: '미등록 상품', productId: 'STALE-ID', quantity: 0 })]
});
assert.equal(unmatchedCode.plan.inventoryMovements.length, 0, 'unmatched zero is not an official zero-stock effect');
assert.equal(unmatchedCode.plan.pendingInventoryEffects.length, 1, 'unmatched zero still needs a reviewable record');
assert.equal(unmatchedCode.plan.pendingInventoryEffects[0].signedQuantity, 0);
assert.equal(unmatchedCode.plan.pendingInventoryEffects[0].originalProductCode, '0099');

const leadingZero = resolve('PURCHASE', group('PURCHASE', 'LEADING-ZERO', {
  rows: [row('LEADING-ZERO', { itemCode: '0007' })]
}));
assert.equal(leadingZero.rows[0].officialProductResolution.matchedProductId, 'PRODUCT-0007-A');
assert.equal(leadingZero.rows[0].officialProductResolution.inputProductCode, '0007');
assert.notEqual(leadingZero.rows[0].officialProductResolution.matchedProductId, 'PRODUCT-7-A');

for (const [label, inputCode, masterCode] of [
  ['CASE', 'ABC', 'abc'],
  ['WIDTH', '０００７', '0007'],
  ['INNER-SPACE', 'A  B', 'A B']
]) {
  const separated = draftAndPlan('PURCHASE', `PRODUCT-CODE-${label}`, {
    rows: [row(`PRODUCT-CODE-${label}`, { itemCode: inputCode })]
  }, [{ companyId, productId: `PRODUCT-${label}`, itemCode: masterCode, status: 'ACTIVE' }]);
  assert.equal(separated.resolved.rows[0].officialProductResolution.status, 'UNRESOLVED_PRODUCT');
  assert.equal(separated.resolved.rows[0].officialProductResolution.reason, 'PRODUCT_CODE_UNMATCHED');
  assert.equal(separated.resolved.rows[0].officialProductResolution.inputProductCode, inputCode,
    'product matching must preserve and compare the owner product-code string after outer trim only');
  const counterpart = draftAndPlan('PURCHASE', `PRODUCT-CODE-${label}-COUNTERPART`, {
    rows: [row(`PRODUCT-CODE-${label}-COUNTERPART`, { itemCode: masterCode })]
  }, []);
  assert.notEqual(separated.plan.lines[0].unresolvedProductId, counterpart.plan.lines[0].unresolvedProductId,
    'distinct owner product-code strings must not collapse to one unresolved identity');
}
const outerTrimMatch = resolve('PURCHASE', group('PURCHASE', 'PRODUCT-CODE-OUTER-TRIM', {
  rows: [row('PRODUCT-CODE-OUTER-TRIM', { itemCode: '  ABC  ' })]
}), [{ companyId, productId: 'PRODUCT-ABC', itemCode: 'ABC', status: 'ACTIVE' }]);
assert.equal(outerTrimMatch.rows[0].productId, 'PRODUCT-ABC');

const normalizedCustomerMatch = resolve('PURCHASE', group('PURCHASE', 'CUSTOMER-NORMALIZED', {
  supplierCustomerCode: ' ＡＣＭＥ　 ０１ ',
  supplierCustomerName: '고객 정규화'
}), products, [{ companyId, customerId: 'CUSTOMER-ACME', customerCode: 'acme 01', status: 'ACTIVE' }]);
assert.equal(normalizedCustomerMatch.supplierCustomerId, 'CUSTOMER-ACME',
  'customer matching must retain the customer-master normalizedCustomerCode rule');

const otherCompany = resolve('PURCHASE', {
  ...group('PURCHASE', 'OTHER-COMPANY'),
  companyId: 'COMPANY-B',
  rows: [row('OTHER-COMPANY')]
});
assert.equal(otherCompany.rows[0].productId, 'PRODUCT-0007-B');
assert.equal(otherCompany.supplierCustomerId, 'CUSTOMER-0003-B');

const ambiguous = resolve('PURCHASE', group('PURCHASE', 'AMBIGUOUS'), [
  products[0],
  { ...products[0], productId: 'PRODUCT-0007-A-DUPLICATE' }
]);
assert.equal(ambiguous.rows[0].officialProductResolution.reason, 'PRODUCT_CODE_AMBIGUOUS');
assert.equal(ambiguous.rows[0].productId, '');

for (const kind of ['PURCHASE', 'SALE']) {
  const noCustomer = draftAndPlan(kind, 'NO-CUSTOMER', {
    ...(kind === 'PURCHASE'
      ? { supplierCustomerId: 'STALE-ID', supplierCustomerCode: '', supplierCustomerName: '동일명 거래처' }
      : { salesCustomerId: 'STALE-ID', salesCustomerCode: '', salesCustomerName: '동일명 거래처' })
  });
  assert.equal(noCustomer.plan.ledgerEntries.length, 0, 'customer name must never auto-create AP/AR');
  assert.deepEqual(noCustomer.plan.voucherRevision.partnerEffectDecision, {
    status: 'NOT_CREATED', reason: 'CUSTOMER_CODE_NOT_PROVIDED',
    partnerResolutionStatus: 'CUSTOMER_NOT_PROVIDED', partnerId: '',
    finalAmount: 12500, effectiveAt: '2026-08-05', occurredAt: context.occurredAt, entryIds: []
  });

  const unmatchedCustomer = draftAndPlan(kind, 'UNMATCHED-CUSTOMER', {
    ...(kind === 'PURCHASE'
      ? { supplierCustomerCode: '0099', supplierCustomerName: '미등록 거래처' }
      : { salesCustomerCode: '0099', salesCustomerName: '미등록 거래처' })
  });
  assert.equal(unmatchedCustomer.plan.ledgerEntries.length, 0);
  assert.equal(unmatchedCustomer.plan.voucherRevision.partnerEffectDecision.reason, 'CUSTOMER_CODE_UNMATCHED');
}

const forgedFactor = structuredClone(purchasePositive.draft.commandSource);
forgedFactor.lines[0].inventoryEffectFactor = 12;
assert.throws(() => assertOfficialCommandV2(forgedFactor), /INVENTORY_FACTOR_INVALID/);
const forgedProductCaseMatch = structuredClone(purchasePositive.draft.commandSource);
forgedProductCaseMatch.lines[0].productSnapshot.productCode = 'ABC';
forgedProductCaseMatch.lines[0].productSnapshot.originalProductCode = 'ABC';
forgedProductCaseMatch.lines[0].officialProductResolution.inputProductCode = 'ABC';
forgedProductCaseMatch.lines[0].officialProductResolution.matchedProductCode = 'abc';
forgedProductCaseMatch.lines[0].productSnapshot.matchEvidence.officialProductResolution =
  structuredClone(forgedProductCaseMatch.lines[0].officialProductResolution);
assert.throws(() => assertOfficialCommandV2(forgedProductCaseMatch), /PRODUCT_EXACT_MATCH_INVALID/,
  'owner validation must reject a forged case-normalized product match even if both evidence copies agree');
const forgedPartner = structuredClone(purchasePositive.draft.commandSource);
forgedPartner.document.supplierCustomerId = 'STALE-CUSTOMER-ID';
assert.throws(() => assertOfficialCommandV2(forgedPartner), /PARTNER_EXACT_MATCH_INVALID|COMMAND_PAYLOAD_CONFLICT/);
const forgedLedgerDate = structuredClone(purchasePositive.plan);
forgedLedgerDate.ledgerEntries[0].effectiveAt = '2026-09-02';
assert.throws(
  () => assertOfficialLedgerProjectionV2(forgedLedgerDate, purchasePositive.draft.commandSource),
  /LEDGER_PROJECTION_MISMATCH/
);
const forgedDecisionDate = structuredClone(purchasePositive.plan);
forgedDecisionDate.voucherRevision.partnerEffectDecision.effectiveAt = '2026-09-02';
assert.throws(
  () => assertOfficialLedgerProjectionV2(forgedDecisionDate, purchasePositive.draft.commandSource),
  /LEDGER_DECISION_MISMATCH/
);
const forgedProjectionGateway = gateway.createOfficialCommandGateway({
  runCentralOfficialVoucherCommand: async () => forgedLedgerDate
}, { featureGates: { PURCHASE: true, SALE: true } });
await assert.rejects(
  () => forgedProjectionGateway.execute(purchasePositive.draft.commandSource),
  /LEDGER_PROJECTION_MISMATCH/,
  'Gateway must reject a repository projection whose V2 ledger date differs from the voucher business date'
);

assert.deepEqual(gateway.OFFICIAL_VOUCHER_V2_FEATURE_GATES, { PURCHASE: false, SALE: false });
const resolverSource = readFileSync(new URL('../smartinput/official-voucher-reference-resolver.js', import.meta.url), 'utf8');
assert.doesNotMatch(resolverSource, /indexedDB|\.put\s*\(|\.add\s*\(|saveProduct|saveCustomer|commitMasterState/,
  'SmartInput resolver must remain a read-only consumer of reference snapshots');
const repositorySource = readFileSync(new URL('../orderq/official-voucher-repository.js', import.meta.url), 'utf8');
assert.match(repositorySource, /STORE\.VOUCHER_REVISIONS, STORE\.INVENTORY_MOVEMENTS, contract\.partnerEntryStore,[\s\S]*STORE\.PENDING_INVENTORY_EFFECTS, STORE\.UNRESOLVED_PRODUCTS, STORE\.SYNC_QUEUE/,
  'ORDER Q must keep official projections and the sync queue in one write transaction');
assert.match(repositorySource, /assertOfficialLedgerProjectionV2\(plan, checkedV2\)/,
  'Repository must revalidate the V2 ledger effective date before writing the projection transaction');
assert.deepEqual(blockedMutations, [], 'pure Stage 4 verification must emit no external mutation');

console.log(JSON.stringify({
  stage: 'NEXUS-SI-V2-04',
  gates: { purchase: 'independent/default-off', sale: 'independent/default-off' },
  inventory: { purchase: '+quantity', sale: '-quantity', zero: 'ZERO_EFFECT', factor: 1 },
  unmatched: { state: 'UNRESOLVED_PRODUCT', officialInventoryMovements: 0, reviewLink: 'document+line+revision' },
  matching: { productCodeKey: 'outer-trim/exact-string', customerCodeKey: 'normalizedCustomerCode' },
  ledger: {
    exactCodeOnly: true,
    noCustomerReasonPreserved: true,
    finalAmountPreserved: true,
    effectiveAt: '2026-08-05',
    occurredAt: context.occurredAt,
    gatewayAndRepositoryValidated: true
  },
  safety: { ownerWrites: 0, externalMutations: 0 }
}, null, 2));
console.log('SmartInput V2 Stage 4 inventory, unresolved-product, and basic ledger contracts PASS');
