#!/usr/bin/env node

import assert from 'node:assert/strict';

const blockedPosts = [];
globalThis.fetch = async (url, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    blockedPosts.push({ url: String(url), method });
    throw new Error(`TEST_EXTERNAL_MUTATION_BLOCKED:${method}`);
  }
  throw new Error('TEST_NETWORK_DISABLED');
};

const contract = await import('../orderq/official-voucher-v2-contract.js');
const core = await import('../orderq/official-voucher-core.js');
const purchaseModule = await import('../smartinput/purchase-official-stage3.js');
const saleModule = await import('../smartinput/sale-official-stage4.js');
const purchaseFinalizeModule = await import('../smartinput/purchase-finalize-service.js');
const gatewayModule = await import('../orderq/official-command-gateway.js');

const {
  assertOfficialCommandV2,
  isOfficialVoucherActiveRow,
  isOfficialVoucherBlank,
  normalizeOfficialBusinessDate,
  officialVoucherRevisionIdV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
  preflightOfficialVoucherV2
} = contract;
const { buildPurchasePostDraft, derivePurchaseDraftIdentity } = purchaseModule;
const { buildSalePostDraft, deriveSaleDraftIdentity } = saleModule;
const { createPurchaseFinalizeService } = purchaseFinalizeModule;
const { createOfficialCommandGateway } = gatewayModule;

const fixedAt = '2026-09-02T09:00:00.000Z';

function baseRow(overrides = {}) {
  return {
    rowId: 'ROW-1', itemCode: '0007', itemName: '확정 사과', specification: '10kg',
    productId: 'PRODUCT-7', matchStatus: 'MATCHED', matchSource: 'EXACT_COMPANY_PRODUCT_CODE',
    productMasterRevision: 7, referenceSnapshotId: 'PRODUCT-SNAPSHOT-7',
    warehouseId: 'WAREHOUSE-A', quantity: 2, unit: 'BOX', unitPrice: 1500,
    conversionFactor: 1, productMasterRevision: 7, warehouseMasterRevision: 3,
    ...overrides
  };
}

function purchaseGroup(overrides = {}) {
  const rows = overrides.rows || [baseRow()];
  return {
    companyId: 'COMPANY-A', voucherGroupKey: 'PURCHASE|SOURCE-A|GROUP-A',
    supplierCustomerId: 'CUSTOMER-A', supplierCustomerCode: 'C-A', supplierCustomerName: '구매처 A',
    voucherDate: '2026-09-02', warehouseId: 'WAREHOUSE-A', warehouseCode: 'WH-A',
    sourceDocumentKey: 'SOURCE-A', sourceVoucherIndex: 1, rows, ...overrides, rows
  };
}

function saleGroup(overrides = {}) {
  const rows = overrides.rows || [baseRow({ actualToBaseFactor: 1 })];
  return {
    companyId: 'COMPANY-A', voucherGroupKey: 'SALE|SOURCE-A|GROUP-A',
    originSystem: 'SMARTINPUT_FILE', originTransactionId: 'SALE-SOURCE-A', sourceDocumentKey: 'SOURCE-A',
    salesCustomerId: 'CUSTOMER-A', salesCustomerName: '판매처 A', salesCustomerRevision: 1,
    deliveryCustomerId: 'CUSTOMER-A', deliveryCustomerName: '판매처 A', deliveryCustomerRevision: 1,
    billingCustomerId: 'CUSTOMER-A', billingCustomerName: '판매처 A', billingCustomerRevision: 1,
    voucherDate: '2026-09-02', warehouseId: 'WAREHOUSE-A', warehouseCode: 'WH-A',
    sourceVoucherIndex: 1, rows, ...overrides, rows
  };
}

function v2Context(companyId = 'COMPANY-A') {
  return {
    companyId,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    originSystem: 'SMARTINPUT_FILE', manualSessionId: 'SOURCE-A', actor: 'STAGE3-TEST', occurredAt: fixedAt
  };
}

function issueCodes(action) {
  try {
    action();
    assert.fail('expected preflight failure');
  } catch (error) {
    assert.equal(error.code, 'ORDERQ_OFFICIAL_V2_PREFLIGHT_FAILED');
    return error.issues.map(issue => issue.code);
  }
}

assert.equal(isOfficialVoucherBlank('   '), true);
assert.equal(isOfficialVoucherBlank(0), false);
assert.equal(isOfficialVoucherBlank('0'), false);
assert.equal(isOfficialVoucherActiveRow({ rowId: 'TECHNICAL-ONLY', sourceRowNo: 1 }), false);
assert.equal(isOfficialVoucherActiveRow({ rowId: 'DEFAULTED', warehouseId: 'WAREHOUSE-A', warehouseMasterRevision: 1 }), false);
assert.equal(isOfficialVoucherActiveRow({ quantity: 0 }), true);

assert.deepEqual(normalizeOfficialBusinessDate({ voucherDate: '2026-09' }), {
  businessDate: '2026-09-01', dayDefaulted: true
});
assert.deepEqual(normalizeOfficialBusinessDate({ voucherYear: 2024, voucherMonth: 2, voucherDay: '' }), {
  businessDate: '2024-02-01', dayDefaulted: true
});
assert.deepEqual(normalizeOfficialBusinessDate({ year: undefined, voucherYear: 2024, voucherMonth: 2, voucherDay: 29 }), {
  businessDate: '2024-02-29', dayDefaulted: false
});
assert.throws(() => normalizeOfficialBusinessDate({ voucherDate: '2026-02-29' }), /DATE_INVALID/);
assert.throws(() => normalizeOfficialBusinessDate({}), /DATE_REQUIRED/);

for (const kind of ['PURCHASE', 'SALE']) {
  const base = { kind, companyId: 'COMPANY-A', voucherGroupKey: `${kind}|GROUP`, voucherDate: '2026-09-02', warehouseId: 'WAREHOUSE-A' };
  const codeOnly = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ itemName: '' })] });
  assert.equal(codeOnly.rows[0].productSnapshot.productCode, '0007');
  const numericZeroCode = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ itemCode: 0, itemName: '' })] });
  assert.equal(numericZeroCode.rows[0].productSnapshot.productCode, '0');
  const nameOnly = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ itemCode: '', productId: '' })] });
  assert.equal(nameOnly.rows[0].productSnapshot.productName, '확정 사과');
  assert.ok(issueCodes(() => preflightOfficialVoucherV2({ ...base, rows: [baseRow({ itemCode: ' ', itemName: ' ', productId: '' })] }))
    .includes('ORDERQ_OFFICIAL_V2_PRODUCT_REQUIRED'));
  assert.ok(issueCodes(() => preflightOfficialVoucherV2({ ...base, rows: [baseRow({ quantity: '' })] }))
    .includes('ORDERQ_OFFICIAL_V2_QUANTITY_REQUIRED'));
  assert.ok(issueCodes(() => preflightOfficialVoucherV2({ ...base, rows: [baseRow({ unitPrice: ' ' })] }))
    .includes('ORDERQ_OFFICIAL_V2_UNIT_PRICE_REQUIRED'));
  for (const invalid of [NaN, Infinity, -Infinity, 'not-a-number', true, [], {}, ',']) {
    assert.ok(issueCodes(() => preflightOfficialVoucherV2({ ...base, rows: [baseRow({ quantity: invalid })] }))
      .includes('ORDERQ_OFFICIAL_V2_QUANTITY_INVALID'));
    assert.ok(issueCodes(() => preflightOfficialVoucherV2({ ...base, rows: [baseRow({ unitPrice: invalid })] }))
      .includes('ORDERQ_OFFICIAL_V2_UNIT_PRICE_INVALID'));
  }
  for (const accepted of [0, '0', -3, '-3']) {
    const checked = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ quantity: accepted, unitPrice: accepted })] });
    assert.equal(checked.rows[0].productSnapshot.quantity, Number(accepted));
    assert.equal(checked.rows[0].productSnapshot.unitPrice, Number(accepted));
  }
  const emptyIgnored = preflightOfficialVoucherV2({ ...base, rows: [{ rowId: 'EMPTY' }, baseRow()] });
  assert.equal(emptyIgnored.rows.length, 1);
  assert.deepEqual(emptyIgnored.ignoredRowIndexes, [0]);
  const explicitZero = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ totalAmount: 0 })] });
  assert.equal(explicitZero.rows[0].productSnapshot.amount, 0);
  assert.equal(explicitZero.rows[0].productSnapshot.amountOrigin, 'SOURCE_OR_USER');
  const explicitNegative = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ finalAmount: -77 })] });
  assert.equal(explicitNegative.rows[0].productSnapshot.amount, -77);
  const calculated = preflightOfficialVoucherV2({ ...base, rows: [baseRow({ quantity: -2, unitPrice: 1500 })] });
  assert.equal(calculated.rows[0].productSnapshot.amount, -3000);
  assert.equal(calculated.rows[0].productSnapshot.amountOrigin, 'DERIVED_AT_CONFIRM');
  assert.equal(Object.isFrozen(calculated), true);
  assert.equal(Object.isFrozen(calculated.rows[0].productSnapshot.matchEvidence), true);
}

const glyphSnapshotSource = baseRow({
  itemCode: ' ０００７ ',
  itemName: ' ㈜金사과 ',
  specification: ' １０㎏ ',
  unit: ' ＢＯＸ ',
  originalProductCode: ' ０A① ',
  originalProductName: ' ㈜金 원본 '
});
for (const kind of ['PURCHASE', 'SALE']) {
  const checked = preflightOfficialVoucherV2({
    kind,
    companyId: 'COMPANY-A',
    voucherGroupKey: `${kind}|GLYPH`,
    voucherDate: '2026-09-02',
    warehouseId: 'WAREHOUSE-A',
    rows: [glyphSnapshotSource]
  });
  assert.deepEqual({
    productCode: checked.rows[0].productSnapshot.productCode,
    productName: checked.rows[0].productSnapshot.productName,
    specification: checked.rows[0].productSnapshot.specification,
    unit: checked.rows[0].productSnapshot.unit,
    originalProductCode: checked.rows[0].productSnapshot.originalProductCode,
    originalProductName: checked.rows[0].productSnapshot.originalProductName
  }, {
    productCode: '０００７',
    productName: '㈜金사과',
    specification: '１０㎏',
    unit: 'ＢＯＸ',
    originalProductCode: '０A①',
    originalProductName: '㈜金 원본'
  });
}

const dayDefaultedPurchase = buildPurchasePostDraft(purchaseGroup({ voucherDate: '2026-09-' }), v2Context());
assert.equal(dayDefaultedPurchase.document?.purchaseDate || dayDefaultedPurchase.purchaseDate, '2026-09-01');
assert.equal(dayDefaultedPurchase.businessDateDayDefaulted, true);

const purchaseA = derivePurchaseDraftIdentity(purchaseGroup({ companyId: 'COMPANY-A' }), v2Context('COMPANY-A'));
const purchaseB = derivePurchaseDraftIdentity(purchaseGroup({ companyId: 'COMPANY-B' }), v2Context('COMPANY-B'));
assert.notEqual(purchaseA.purchaseDocumentId, purchaseB.purchaseDocumentId);

const saleA = deriveSaleDraftIdentity(saleGroup({ companyId: 'COMPANY-A' }), v2Context('COMPANY-A'));
const saleB = deriveSaleDraftIdentity(saleGroup({ companyId: 'COMPANY-B' }), v2Context('COMPANY-B'));
assert.notEqual(saleA.salesDocumentId, saleB.salesDocumentId);
const saleGroupB = deriveSaleDraftIdentity(saleGroup({ voucherGroupKey: 'SALE|SOURCE-A|GROUP-B' }), v2Context());
assert.notEqual(saleA.salesDocumentId, saleGroupB.salesDocumentId);
assert.throws(() => deriveSaleDraftIdentity(saleGroup({ voucherGroupKey: '' }), v2Context()), /SALE_GROUP_KEY_REQUIRED/);

const purchaseDraft = buildPurchasePostDraft(purchaseGroup({
  rows: [baseRow({ originalProductCode: '원본-0007', originalProductName: '원본 사과', totalAmount: -25 })]
}), v2Context());
const saleSource = saleGroup();
const saleDraft = buildSalePostDraft(saleSource, v2Context());
for (const draft of [purchaseDraft, saleDraft]) {
  const command = draft.commandSource;
  const checked = assertOfficialCommandV2(command);
  assert.equal(command.schemaVersion, OFFICIAL_VOUCHER_SCHEMA_VERSION_V2);
  assert.equal(command.identityVersion, OFFICIAL_VOUCHER_IDENTITY_VERSION_V2);
  assert.equal(command.commandId, command.idempotencyKey);
  assert.equal(checked.companyId, 'COMPANY-A');
  assert.equal(command.document.companyId, 'COMPANY-A');
  assert.ok(command.lines.every(line => line.companyId === 'COMPANY-A'));
}
assert.equal(purchaseDraft.lines[0].productSnapshot.originalProductCode, '원본-0007');
assert.equal(purchaseDraft.lines[0].productSnapshot.originalProductName, '원본 사과');
assert.equal(purchaseDraft.lines[0].productSnapshot.amount, -25);

const glyphPurchaseDraft = buildPurchasePostDraft(purchaseGroup({ rows: [glyphSnapshotSource] }), v2Context());
const glyphPurchaseDocument = { ...glyphPurchaseDraft.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
const glyphPurchasePlan = core.planOfficialVoucherCommand({
  command: glyphPurchaseDraft.commandSource,
  document: glyphPurchaseDocument,
  lines: glyphPurchaseDraft.lines
});
assert.equal(glyphPurchasePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.productCode, '０００７');
assert.equal(glyphPurchasePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.productName, '㈜金사과');
assert.equal(glyphPurchasePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.originalProductCode, '０A①');
assert.equal(glyphPurchasePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.originalProductName, '㈜金 원본');

const purchaseDraftB = buildPurchasePostDraft(purchaseGroup({ companyId: 'COMPANY-B' }), v2Context('COMPANY-B'));
assert.notEqual(purchaseDraft.purchaseDocumentId, purchaseDraftB.purchaseDocumentId);
assert.notEqual(purchaseDraft.lines[0].purchaseLineId, purchaseDraftB.lines[0].purchaseLineId);
assert.notEqual(purchaseDraft.commandSource.commandId, purchaseDraftB.commandSource.commandId);
assert.notEqual(
  officialVoucherRevisionIdV2('PURCHASE', 'COMPANY-A', purchaseDraft.purchaseDocumentId, 2),
  officialVoucherRevisionIdV2('PURCHASE', 'COMPANY-B', purchaseDraftB.purchaseDocumentId, 2)
);

const saleDraftB = buildSalePostDraft(saleGroup({ companyId: 'COMPANY-B' }), v2Context('COMPANY-B'));
assert.notEqual(saleDraft.salesDocumentId, saleDraftB.salesDocumentId);
assert.notEqual(saleDraft.lines[0].salesLineId, saleDraftB.lines[0].salesLineId);
assert.notEqual(saleDraft.commandSource.commandId, saleDraftB.commandSource.commandId);
assert.notEqual(
  officialVoucherRevisionIdV2('SALE', 'COMPANY-A', saleDraft.salesDocumentId, 2),
  officialVoucherRevisionIdV2('SALE', 'COMPANY-B', saleDraftB.salesDocumentId, 2)
);
const otherSaleGroupDraft = buildSalePostDraft(saleGroup({ voucherGroupKey: 'SALE|SOURCE-A|GROUP-B' }), v2Context());
assert.notEqual(saleDraft.lines[0].salesLineId, otherSaleGroupDraft.lines[0].salesLineId);
assert.notEqual(saleDraft.commandSource.commandId, otherSaleGroupDraft.commandSource.commandId);

const sourceOrder = [baseRow({ rowId: 'ROW-A', itemCode: 'A' }), baseRow({ rowId: 'ROW-B', itemCode: 'B' })];
const forward = buildPurchasePostDraft(purchaseGroup({ rows: sourceOrder }), v2Context());
const reversed = buildPurchasePostDraft(purchaseGroup({ rows: [...sourceOrder].reverse() }), v2Context());
assert.equal(forward.purchaseDocumentId, reversed.purchaseDocumentId);
assert.deepEqual(new Set(forward.lines.map(line => line.purchaseLineId)), new Set(reversed.lines.map(line => line.purchaseLineId)));

const purchaseDocument = { ...purchaseDraft.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
const purchasePlan = core.planOfficialVoucherCommand({
  command: purchaseDraft.commandSource,
  document: purchaseDocument,
  lines: purchaseDraft.lines
});
assert.match(purchasePlan.voucherRevision.voucherRevisionId, /^VR-/);
assert.equal(purchasePlan.voucherRevision.companyId, 'COMPANY-A');
assert.equal(purchasePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.productName, '확정 사과');
purchaseGroup().rows[0].itemName = '기준정보 변경은 별도 객체';
assert.equal(purchasePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.productName, '확정 사과');

const saleDocument = { ...saleDraft.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
const salePlan = core.planOfficialVoucherCommand({
  command: saleDraft.commandSource,
  document: saleDocument,
  lines: saleDraft.lines
});
saleSource.rows[0].itemName = '삭제·변경된 기준상품명';
saleSource.rows[0].productId = '';
assert.equal(salePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.productName, '확정 사과');
assert.equal(salePlan.voucherRevision.afterSnapshot.lines[0].productSnapshot.matchEvidence.productId, 'PRODUCT-7');

assert.throws(() => core.planOfficialVoucherCommand({
  command: { ...purchaseDraft.commandSource, expectedRevision: 2 },
  document: purchaseDocument,
  lines: purchaseDraft.lines
}), /COMMAND_PAYLOAD_CONFLICT|COMMAND_ID_INVALID|REVISION/);

const tamperedPayload = structuredClone(purchaseDraft.commandSource);
tamperedPayload.lines[0].unitPrice = 9999;
assert.throws(() => assertOfficialCommandV2(tamperedPayload), /LINE_SNAPSHOT_MISMATCH|COMMAND_PAYLOAD_CONFLICT/);
const tamperedSalePayload = structuredClone(saleDraft.commandSource);
tamperedSalePayload.lines[0].unitPrice = 9999;
assert.throws(() => assertOfficialCommandV2(tamperedSalePayload), /AMOUNT_DERIVATION_MISMATCH|LINE_SNAPSHOT_MISMATCH|COMMAND_PAYLOAD_CONFLICT/);
const changedNonSnapshotPayload = structuredClone(purchaseDraft.commandSource);
changedNonSnapshotPayload.reason = 'PURCHASE_POST_CHANGED_WITH_SAME_COMMAND_ID';
assert.equal(changedNonSnapshotPayload.commandId, purchaseDraft.commandSource.commandId);
assert.throws(
  () => assertOfficialCommandV2(changedNonSnapshotPayload),
  error => error?.message === 'ORDERQ_OFFICIAL_V2_COMMAND_PAYLOAD_CONFLICT'
);
const idempotencyMismatch = { ...purchaseDraft.commandSource, idempotencyKey: 'DIFFERENT' };
assert.throws(() => assertOfficialCommandV2(idempotencyMismatch), /COMMAND_IDEMPOTENCY_MISMATCH/);
const invalidCommandFormat = { ...purchaseDraft.commandSource, commandType: 'CORRECT_PURCHASE' };
assert.throws(() => assertOfficialCommandV2(invalidCommandFormat), /COMMAND_FORMAT_INVALID/);

const calls = [];
const repository = {
  buildFrozenPurchaseIntent: value => value,
  buildFrozenSaleIntent: value => value,
  findOfficialPurchaseBySource: async () => null,
  findOfficialSaleBySource: async () => null,
  loadOfficialPurchaseAggregate: async () => null,
  loadOfficialSaleAggregate: async () => null,
  saveOfficialVoucherDraft: async value => { calls.push(`SAVE:${value.kind}`); return value; },
  runCentralOfficialVoucherCommand: async value => { calls.push(`EXECUTE:${value.commandType}`); return value; }
};
const saleOnlyGateway = createOfficialCommandGateway(repository, { featureGates: { PURCHASE: false, SALE: true } });
assert.throws(() => saleOnlyGateway.execute(purchaseDraft.commandSource), /PURCHASE_FEATURE_DISABLED/);
await saleOnlyGateway.execute(saleDraft.commandSource);
assert.deepEqual(calls, ['EXECUTE:POST_SALE']);
const purchaseOnlyGateway = createOfficialCommandGateway(repository, { featureGates: { PURCHASE: true, SALE: false } });
await purchaseOnlyGateway.execute(purchaseDraft.commandSource);
assert.throws(() => purchaseOnlyGateway.execute(saleDraft.commandSource), /SALE_FEATURE_DISABLED/);
assert.throws(
  () => purchaseOnlyGateway.saveDraft({ kind: 'SALE', commandSource: purchaseDraft.commandSource }),
  /COMMAND_KIND_MISMATCH/
);
assert.throws(
  () => purchaseOnlyGateway.execute({ ...purchaseDraft.commandSource, identityVersion: 'UNSUPPORTED_IDENTITY' }),
  /IDENTITY_VERSION_INVALID/
);
assert.throws(
  () => purchaseOnlyGateway.execute(changedNonSnapshotPayload),
  error => error?.message === 'ORDERQ_OFFICIAL_V2_COMMAND_PAYLOAD_CONFLICT'
);

const legacyFinalizeCalls = [];
const v2FinalizeSubmissions = [];
const v2FinalizeService = createPurchaseFinalizeService({
  validateGroup: () => {
    legacyFinalizeCalls.push('LEGACY');
    throw new Error('LEGACY_VALIDATOR_MUST_NOT_RUN_FOR_V2');
  },
  submitGroup: async (group, context) => {
    v2FinalizeSubmissions.push({ group, context });
    return { accepted: true };
  },
  now: () => fixedAt
});
const v2FinalizeGroups = [
  purchaseGroup({
    voucherGroupKey: 'PURCHASE|FINALIZE|CODE-ONLY',
    supplierCustomerId: '', supplierCustomerCode: '', supplierCustomerName: '',
    rows: [baseRow({ itemName: '', productId: '', unit: '', quantity: 0, unitPrice: -10 })]
  }),
  purchaseGroup({
    voucherGroupKey: 'PURCHASE|FINALIZE|NAME-ONLY',
    supplierCustomerId: '', supplierCustomerCode: '', supplierCustomerName: '',
    rows: [baseRow({ itemCode: '', productId: '', unit: '', quantity: -2, unitPrice: 0 })]
  })
];
const v2FinalizeResults = await v2FinalizeService.finalize({
  groups: v2FinalizeGroups,
  companyId: 'COMPANY-A',
  identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  masters: { customers: [], products: [], warehouses: [] }
});
assert.deepEqual(v2FinalizeResults.map(result => result.ok), [true, true]);
assert.deepEqual(legacyFinalizeCalls, []);
assert.equal(v2FinalizeSubmissions[0].group.rows[0].productSnapshot.productCode, '0007');
assert.equal(v2FinalizeSubmissions[0].group.rows[0].productSnapshot.productName, '');
assert.equal(v2FinalizeSubmissions[0].group.rows[0].productSnapshot.quantity, 0);
assert.equal(v2FinalizeSubmissions[0].group.rows[0].productSnapshot.unitPrice, -10);
assert.equal(v2FinalizeSubmissions[0].group.rows[0].productSnapshot.unit, '');
assert.equal(v2FinalizeSubmissions[1].group.rows[0].productSnapshot.productCode, '');
assert.equal(v2FinalizeSubmissions[1].group.rows[0].productSnapshot.productName, '확정 사과');
assert.equal(v2FinalizeSubmissions[1].group.rows[0].productSnapshot.quantity, -2);
assert.equal(v2FinalizeSubmissions[1].group.rows[0].productSnapshot.unitPrice, 0);
assert.equal(v2FinalizeSubmissions[1].group.rows[0].productSnapshot.unit, '');

const v2FinalizeMissingDate = await v2FinalizeService.finalize({
  groups: [purchaseGroup({ voucherDate: '' })],
  companyId: 'COMPANY-A',
  identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
});
assert.equal(v2FinalizeMissingDate[0].ok, false);
assert.match(v2FinalizeMissingDate[0].error.message, /ORDERQ_OFFICIAL_V2_DATE_REQUIRED/);
assert.equal(v2FinalizeSubmissions.length, 2);

let v1LegacyCalled = 0;
const v1FinalizeService = createPurchaseFinalizeService({
  validateGroup: () => { v1LegacyCalled += 1; throw new Error('V1_LEGACY_SENTINEL'); },
  submitGroup: async () => assert.fail('V1 submit must not run after legacy validation failure')
});
const v1FinalizeResult = await v1FinalizeService.finalize({ groups: [purchaseGroup()], companyId: 'COMPANY-A' });
assert.equal(v1LegacyCalled, 1);
assert.equal(v1FinalizeResult[0].ok, false);
assert.equal(v1FinalizeResult[0].error.message, 'V1_LEGACY_SENTINEL');

assert.deepEqual(blockedPosts, [], 'pure Stage 3 tests must make no external mutation request');

console.log(JSON.stringify({
  stage: 'NEXUS-SI-V2-03',
  gates: { purchase: 'independent/default-off', sale: 'independent/default-off' },
  purchase: { validation: 'PASS', snapshot: 'PASS', companyScopedId: 'PASS', revisionId: 'PASS' },
  sale: { validation: 'PASS', snapshot: 'PASS', companyScopedId: 'PASS', voucherGroupScopedId: 'PASS' },
  common: { retryIdentity: 'PASS', payloadConflict: 'PASS', nonSnapshotPayloadConflict: 'PASS', expectedRevision: 'PASS', externalMutations: 0 },
  finalize: { purchaseV1LegacyUnchanged: 'PASS', purchaseV2PreflightFirst: 'PASS' }
}, null, 2));
console.log('SmartInput V2 Stage 3 validation, Snapshot, and identity contract PASS');
