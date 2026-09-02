#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const externalMutations = [];
globalThis.fetch = async (url, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) externalMutations.push({ url: String(url), method });
  throw new Error('STAGE5_TEST_NETWORK_DISABLED');
};

const { resolveOfficialVoucherReferencesV2 } = await import('../smartinput/official-voucher-reference-resolver.js');
const { buildPurchasePostDraft } = await import('../smartinput/purchase-official-stage3.js');
const { buildSalePostDraft } = await import('../smartinput/sale-official-stage4.js');
const { createPurchaseFinalizeService } = await import('../smartinput/purchase-finalize-service.js');
const { createSaleFinalizeService } = await import('../smartinput/sale-finalize-service.js');
const { createOfficialCommandGateway } = await import('../orderq/official-command-gateway.js');
const { planOfficialVoucherCommand } = await import('../orderq/official-voucher-core.js');
const {
  assertOfficialCommandV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
} = await import('../orderq/official-voucher-v2-contract.js');
const {
  OFFICIAL_STOCKTAKE_DECISION,
  assertOfficialStocktakeProjectionV2,
  createOfficialStocktakeDecisionsV2,
  evaluateStocktakeCheckpointConflictV2,
  inspectOfficialStocktakeConflictsV2,
  officialStocktakeConflictKeyV2
} = await import('../orderq/stocktake-conflict-v2.js');

const companyId = 'COMPANY-A';
const product = { companyId, productId: 'PRODUCT-0007-A', itemCode: '0007', itemName: '확정 상품명', status: 'ACTIVE', revision: 7 };
const secondProduct = { companyId, productId: 'PRODUCT-0008-A', itemCode: '0008', itemName: '두 번째 상품', status: 'ACTIVE', revision: 3 };
const customer = { companyId, customerId: 'CUSTOMER-0003-A', customerCode: '0003', customerName: '확정 거래처', status: 'ACTIVE', revision: 5 };
const context = {
  companyId,
  identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  originSystem: 'SMARTINPUT_STAGE5_TEST',
  manualSessionId: 'STAGE5-TEST',
  actor: 'STAGE5-ACTOR',
  occurredAt: '2026-09-02T10:00:00.000Z'
};

function sourceGroup(kind, suffix, quantity = 10, overrides = {}) {
  const purchase = kind === 'PURCHASE';
  return {
    companyId,
    voucherGroupKey: `${kind}|STAGE5|${suffix}`,
    voucherDate: '2026-08-05',
    warehouseId: 'WAREHOUSE-A',
    warehouseCode: 'WH-A',
    warehouseName: '본사창고',
    sourceDocumentKey: `${kind}|STAGE5|${suffix}`,
    originSystem: 'SMARTINPUT_STAGE5_TEST',
    originTransactionId: `${kind}|STAGE5|${suffix}`,
    sourceVoucherIndex: 1,
    ...(purchase ? {
      supplierCustomerCode: '0003',
      supplierCustomerName: '확정 거래처'
    } : {
      salesCustomerCode: '0003',
      salesCustomerName: '확정 거래처',
      deliveryCustomerCode: '',
      billingCustomerCode: ''
    }),
    rows: [{
      rowId: `${suffix}-ROW-1`,
      sourceLineKey: `${suffix}-ROW-1`,
      itemCode: '0007',
      itemName: '확정 상품명',
      specification: '10kg',
      unit: 'BOX',
      warehouseId: 'WAREHOUSE-A',
      warehouseCode: 'WH-A',
      warehouseName: '본사창고',
      quantity,
      unitPrice: 1000,
      actualToBaseFactor: 1,
      actualToRecognizedFactor: 0,
      sourceType: 'DIRECT'
    }],
    ...overrides
  };
}

function resolvedGroup(kind, suffix, quantity = 10, overrides = {}) {
  const group = sourceGroup(kind, suffix, quantity, overrides);
  return resolveOfficialVoucherReferencesV2({
    kind,
    companyId,
    group,
    products: [product, secondProduct],
    customers: [customer],
    productReferenceSnapshotId: 'PRODUCT-SNAPSHOT-STAGE5',
    customerReferenceSnapshotId: 'CUSTOMER-SNAPSHOT-STAGE5'
  });
}

function draft(kind, suffix, quantity = 10, overrides = {}, contextOverrides = {}) {
  const group = resolvedGroup(kind, suffix, quantity, overrides);
  return kind === 'PURCHASE'
    ? buildPurchasePostDraft(group, { ...context, ...contextOverrides })
    : buildSalePostDraft(group, { ...context, ...contextOverrides });
}

function checkpoint(checkpointId, effectiveAt, overrides = {}) {
  return {
    checkpointId,
    sessionId: `SESSION-${checkpointId}`,
    companyId,
    warehouseId: 'WAREHOUSE-A',
    effectiveAt,
    status: 'CONFIRMED',
    coversAllProducts: false,
    counts: [{ productCode: '0007', productId: 'PRODUCT-0007-A', quantity: 100 }],
    actor: 'STOCKTAKE-ACTOR',
    confirmedAt: '2026-09-01T18:00:00.000Z',
    ...overrides
  };
}

function selection(conflict, decisionType, judgedAt = '2026-09-02T10:01:00.000Z') {
  return { conflictKey: officialStocktakeConflictKeyV2(conflict), decisionType, judgedAt };
}

function planWith(kind, suffix, decisionType, quantity = 10, checkpointRows = [checkpoint('CP-SEP-01', '2026-09-01')]) {
  const initial = draft(kind, `${suffix}-INITIAL`, quantity);
  const assessment = inspectOfficialStocktakeConflictsV2({ command: initial.commandSource, inventoryCheckpoints: checkpointRows });
  assert.equal(assessment.conflicts.length, 1);
  const decisions = createOfficialStocktakeDecisionsV2({
    conflicts: assessment.conflicts,
    selections: assessment.conflicts.map(conflict => selection(conflict, decisionType)),
    actor: context.actor
  });
  const decided = draft(kind, `${suffix}-INITIAL`, quantity, {}, { stocktakeDecisions: decisions });
  const document = { ...decided.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 };
  const plan = planOfficialVoucherCommand({
    command: decided.commandSource,
    document,
    lines: decided.lines,
    inventoryCheckpoints: checkpointRows
  });
  return { initial, assessment, decisions, decided, plan };
}

const oldCheckpoint = checkpoint('CP-AUG-01', '2026-08-01');
const newCheckpoint = checkpoint('CP-SEP-01', '2026-09-01');
const purchaseBefore = draft('PURCHASE', 'BEFORE');
assert.equal(inspectOfficialStocktakeConflictsV2({
  command: purchaseBefore.commandSource,
  inventoryCheckpoints: [oldCheckpoint, newCheckpoint]
}).conflicts[0].checkpointId, 'CP-SEP-01', 'latest confirmed product checkpoint must win');

assert.equal(inspectOfficialStocktakeConflictsV2({
  command: draft('PURCHASE', 'AFTER', 10, { voucherDate: '2026-09-02' }).commandSource,
  inventoryCheckpoints: [newCheckpoint]
}).conflicts.length, 0, 'businessDate after stocktake must stay on the normal path');

assert.equal(inspectOfficialStocktakeConflictsV2({
  command: draft('PURCHASE', 'SAME-DAY', 10, { voucherDate: '2026-09-01' }).commandSource,
  inventoryCheckpoints: [newCheckpoint]
}).conflicts.length, 1, 'same-day date-only evidence must require a decision');

const sameDayInputs = {
  companyId,
  productId: product.productId,
  productCode: '0007',
  warehouseId: 'WAREHOUSE-A',
  businessDate: '2026-09-01',
  inventoryCheckpoints: [checkpoint('CP-TIMED', '2026-09-01T09:00:00.000Z')]
};
assert.equal(evaluateStocktakeCheckpointConflictV2({
  ...sameDayInputs,
  businessOccurredAt: '2026-09-01T10:00:00.000Z'
}).requiresDecision, false, 'two trusted zoned business timestamps may prove the voucher is later');
assert.equal(evaluateStocktakeCheckpointConflictV2({
  ...sameDayInputs,
  businessOccurredAt: '2026-09-01T08:00:00.000Z'
}).requiresDecision, true);
assert.equal(evaluateStocktakeCheckpointConflictV2({
  ...sameDayInputs,
  businessOccurredAt: ''
}).reason, 'SAME_DAY_ORDER_UNPROVEN');

const isolated = inspectOfficialStocktakeConflictsV2({
  command: purchaseBefore.commandSource,
  inventoryCheckpoints: [
    checkpoint('WRONG-COMPANY', '2026-09-02', { companyId: 'COMPANY-B' }),
    checkpoint('WRONG-WAREHOUSE', '2026-09-02', { warehouseId: 'WAREHOUSE-B' }),
    checkpoint('WRONG-PRODUCT', '2026-09-02', {
      counts: [{ productCode: '0008', productId: product.productId, quantity: 1 }]
    })
  ]
});
assert.equal(isolated.conflicts.length, 0, 'company, exact productCode, and warehouse scopes must all match');
const productIdCompatibility = checkpoint('PRODUCT-ID-COMPAT', '2026-09-01', {
  counts: [{ productId: product.productId, quantity: 100 }]
});
assert.equal(inspectOfficialStocktakeConflictsV2({
  command: purchaseBefore.commandSource,
  inventoryCheckpoints: [productIdCompatibility]
}).conflicts.length, 1, 'legacy productId checkpoints remain compatible');

const multiRow = draft('PURCHASE', 'MULTI-ROW', 10, {
  rows: [
    sourceGroup('PURCHASE', 'MULTI-ROW').rows[0],
    { ...sourceGroup('PURCHASE', 'MULTI-ROW-2').rows[0], rowId: 'MULTI-ROW-2', sourceLineKey: 'MULTI-ROW-2', itemCode: '0008', itemName: '두 번째 상품', quantity: -2 }
  ]
});
const multiConflicts = inspectOfficialStocktakeConflictsV2({
  command: multiRow.commandSource,
  inventoryCheckpoints: [
    checkpoint('CP-MULTI-0007', '2026-09-01', { counts: [{ productCode: '0007', quantity: 100 }] }),
    checkpoint('CP-MULTI-0008', '2026-08-30', { counts: [{ productCode: '0008', quantity: 50 }] })
  ]
}).conflicts;
assert.deepEqual(multiConflicts.map(conflict => [conflict.productCode, conflict.checkpointId, conflict.signedQuantity]).sort(), [
  ['0007', 'CP-MULTI-0007', 10],
  ['0008', 'CP-MULTI-0008', -2]
], 'every matched line must resolve its own latest product checkpoint and signed quantity');
const mixedDecisions = createOfficialStocktakeDecisionsV2({
  conflicts: multiConflicts,
  selections: multiConflicts.map(conflict => selection(conflict, conflict.productCode === '0007'
    ? OFFICIAL_STOCKTAKE_DECISION.INCLUDED
    : OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED)),
  actor: context.actor
});
assert.deepEqual(mixedDecisions.map(decision => [decision.target.productCode, decision.decisionType]).sort(), [
  ['0007', OFFICIAL_STOCKTAKE_DECISION.INCLUDED],
  ['0008', OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED]
], 'one voucher must preserve a separate decision for every conflicting row');
assert.throws(() => createOfficialStocktakeDecisionsV2({
  conflicts: multiConflicts,
  selections: [selection(multiConflicts[0], OFFICIAL_STOCKTAKE_DECISION.INCLUDED)],
  actor: context.actor
}), /STOCKTAKE_DECISION_TARGET_COUNT_MISMATCH/,
'an incomplete row-selection set must fail before command creation');

assert.throws(() => planOfficialVoucherCommand({
  command: purchaseBefore.commandSource,
  document: { ...purchaseBefore.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 },
  lines: purchaseBefore.lines,
  inventoryCheckpoints: [newCheckpoint]
}), error => error?.code === 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_REQUIRED');

for (const kind of ['PURCHASE', 'SALE']) {
  const included = planWith(kind, `${kind}-INCLUDED`, OFFICIAL_STOCKTAKE_DECISION.INCLUDED);
  assert.equal(included.plan.inventoryMovements.length, 1);
  assert.equal(included.plan.inventoryMovements[0].signedQuantity, 0);
  assert.equal(included.plan.inventoryMovements[0].originalSignedQuantity, kind === 'PURCHASE' ? 10 : -10);
  assert.equal(included.plan.inventoryMovements[0].effectStatus, 'ABSORBED_BY_CHECKPOINT');
  assert.equal(included.plan.inventoryMovements[0].checkpointId, 'CP-SEP-01');
  assert.equal(included.plan.inventoryMovements[0].officialInventoryApplied, false);
  assert.equal(included.plan.voucherRevision.stocktakeDecisions.length, 1);
  assert.doesNotThrow(() => assertOfficialStocktakeProjectionV2(included.plan, included.decided.commandSource));

  const notIncluded = planWith(kind, `${kind}-NOT-INCLUDED`, OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED);
  assert.equal(notIncluded.plan.inventoryMovements.length, 2);
  assert.equal(notIncluded.plan.inventoryMovements.filter(row => row.effectRole === 'LATE_ADJUSTMENT').length, 1);
  assert.equal(notIncluded.plan.inventoryMovements.reduce((sum, row) => sum + row.signedQuantity, 0), kind === 'PURCHASE' ? 10 : -10);
  assert.equal(notIncluded.plan.inventoryMovements[1].effectStatus, 'APPLIED_AS_LATE_ADJUSTMENT');
  assert.equal(notIncluded.plan.inventoryMovements[1].sourceMovementId, notIncluded.plan.inventoryMovements[0].movementId);
  assert.equal(notIncluded.plan.inventoryMovements[1].checkpointId, 'CP-SEP-01');
  const retry = planOfficialVoucherCommand({
    command: notIncluded.decided.commandSource,
    document: { ...notIncluded.decided.commandSource.document, status: 'DRAFT', businessStatus: 'DRAFT', revision: 1 },
    lines: notIncluded.decided.lines,
    inventoryCheckpoints: [newCheckpoint]
  });
  assert.equal(retry.inventoryMovements[1].movementId, notIncluded.plan.inventoryMovements[1].movementId,
    'late adjustment identity must be deterministic for retries');
  assert.doesNotThrow(() => assertOfficialStocktakeProjectionV2(notIncluded.plan, notIncluded.decided.commandSource));
}

const includedIdentity = planWith('PURCHASE', 'IDENTITY', OFFICIAL_STOCKTAKE_DECISION.INCLUDED);
const notIncludedIdentity = planWith('PURCHASE', 'IDENTITY', OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED);
assert.notEqual(includedIdentity.decided.commandSource.commandPayloadDigest, notIncludedIdentity.decided.commandSource.commandPayloadDigest);
assert.notEqual(includedIdentity.decided.commandSource.commandId, notIncludedIdentity.decided.commandSource.commandId);
const changedDecisionWithSameCommandId = structuredClone(notIncludedIdentity.decided.commandSource);
changedDecisionWithSameCommandId.commandId = includedIdentity.decided.commandSource.commandId;
changedDecisionWithSameCommandId.idempotencyKey = includedIdentity.decided.commandSource.idempotencyKey;
changedDecisionWithSameCommandId.commandPayloadDigest = includedIdentity.decided.commandSource.commandPayloadDigest;
assert.throws(() => assertOfficialCommandV2(changedDecisionWithSameCommandId), /COMMAND_PAYLOAD_CONFLICT/,
  'the same commandId may not change an included decision into a not-included decision');
const tampered = structuredClone(includedIdentity.decided.commandSource);
tampered.stocktakeDecisions[0].decisionType = OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED;
assert.throws(() => assertOfficialCommandV2(tampered), /STOCKTAKE_DECISION_EFFECT_INVALID|COMMAND_PAYLOAD_CONFLICT/);
const dateOnlyAudit = structuredClone(includedIdentity.decided.commandSource);
dateOnlyAudit.stocktakeDecisions[0].judgedAt = '2026-09-02';
assert.throws(() => assertOfficialCommandV2(dateOnlyAudit), /STOCKTAKE_JUDGED_AT_INVALID/,
  'Gateway and Repository command validation must reject date-only judgment audit values');
const forgedProjection = structuredClone(includedIdentity.plan);
forgedProjection.inventoryMovements[0].signedQuantity = 10;
assert.throws(() => assertOfficialStocktakeProjectionV2(forgedProjection, includedIdentity.decided.commandSource),
  /STOCKTAKE_SOURCE_PROJECTION_MISMATCH/);
assert.throws(() => createOfficialStocktakeDecisionsV2({
  conflicts: includedIdentity.assessment.conflicts,
  selections: includedIdentity.assessment.conflicts.map(conflict => selection(conflict, 'CANCEL')),
  actor: context.actor
}), /STOCKTAKE_DECISION_INVALID/, 'cancel is a UI-only zero-write outcome, never a persisted command decision');
assert.throws(() => createOfficialStocktakeDecisionsV2({
  conflicts: includedIdentity.assessment.conflicts,
  selections: includedIdentity.assessment.conflicts.map(conflict => selection(
    conflict, OFFICIAL_STOCKTAKE_DECISION.INCLUDED, '2026-09-02'
  )),
  actor: context.actor
}), /STOCKTAKE_JUDGED_AT_INVALID/, 'date-only audit values must fail closed');
assert.doesNotThrow(() => createOfficialStocktakeDecisionsV2({
  conflicts: includedIdentity.assessment.conflicts,
  selections: includedIdentity.assessment.conflicts.map(conflict => selection(
    conflict, OFFICIAL_STOCKTAKE_DECISION.INCLUDED, '2026-09-02T19:01:00+09:00'
  )),
  actor: context.actor
}), 'a complete ISO timestamp with an explicit offset must be accepted');

const zero = planWith('PURCHASE', 'ZERO', OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED, 0);
assert.equal(zero.plan.inventoryMovements.length, 2, 'zero conflict still keeps one source effect and one approved linked adjustment');
assert.ok(zero.plan.inventoryMovements.every(row => row.effectStatus === 'ZERO_EFFECT'));
assert.ok(zero.plan.inventoryMovements.every(row => row.stocktakeEffectStatus === 'APPLIED_AS_LATE_ADJUSTMENT'));
const negative = planWith('PURCHASE', 'NEGATIVE', OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED, -4);
assert.equal(negative.plan.inventoryMovements[1].signedQuantity, -4);

const unresolved = draft('PURCHASE', 'UNRESOLVED', 5, {
  rows: [{ ...sourceGroup('PURCHASE', 'UNRESOLVED').rows[0], itemCode: '0099', itemName: '미등록 상품' }]
});
assert.equal(inspectOfficialStocktakeConflictsV2({ command: unresolved.commandSource, inventoryCheckpoints: [newCheckpoint] }).conflicts.length, 0,
  'unmatched rows defer the same pure decision rule until a later rematch');

for (const createService of [createPurchaseFinalizeService, createSaleFinalizeService]) {
  const submitted = [];
  const inspected = [];
  const service = createService({
    validateGroup: () => true,
    now: () => '2026-09-02T10:00:00.000Z',
    inspectGroup: async (group, serviceContext) => {
      inspected.push({ group, serviceContext });
      const inspectedDraft = createService === createPurchaseFinalizeService
        ? buildPurchasePostDraft(group, serviceContext)
        : buildSalePostDraft(group, serviceContext);
      return inspectOfficialStocktakeConflictsV2({
        command: inspectedDraft.commandSource,
        inventoryCheckpoints: [newCheckpoint]
      });
    },
    submitGroup: async (group, serviceContext) => {
      submitted.push({ group, serviceContext });
      return { commandId: `COMMAND-${submitted.length}` };
    }
  });
  const groups = createService === createPurchaseFinalizeService
    ? [resolvedGroup('PURCHASE', 'FINALIZE-1'), resolvedGroup('PURCHASE', 'FINALIZE-2')]
    : [resolvedGroup('SALE', 'FINALIZE-1'), resolvedGroup('SALE', 'FINALIZE-2')];
  const request = {
    groups,
    companyId,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    masters: { products: [product], customers: [customer], warehouses: [] },
    products: [product],
    customers: [customer],
    warehouses: []
  };
  const preview = await service.finalize(request);
  assert.equal(preview.every(row => !row.ok && row.error.code === 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_REQUIRED'), true);
  assert.equal(submitted.length, 0, 'all group inspections must finish before any official submit');
  const conflicts = preview[0].error.conflicts;
  assert.equal(conflicts.length, 2);
  const confirmed = await service.finalize({
    ...request,
    stocktakeDecisions: conflicts.map((conflict, index) => selection(conflict,
      index === 0 ? OFFICIAL_STOCKTAKE_DECISION.INCLUDED : OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED))
  });
  assert.equal(confirmed.every(row => row.ok), true);
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every(row => row.serviceContext.stocktakeDecisions.length === 1));
  assert.deepEqual(submitted.map(row => row.serviceContext.stocktakeDecisions[0].decisionType).sort(), [
    OFFICIAL_STOCKTAKE_DECISION.INCLUDED,
    OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED
  ].sort(), 'multiple groups must retain independent row decisions before the first submit');
  assert.ok(inspected.length >= 6, 'preview and decision recheck must inspect every group');

  let missingInspectorSubmits = 0;
  const missingInspector = createService({
    validateGroup: () => true,
    submitGroup: async () => { missingInspectorSubmits += 1; }
  });
  const blocked = await missingInspector.finalize(request);
  assert.equal(blocked.every(row => row.error?.code === 'ORDERQ_OFFICIAL_V2_STOCKTAKE_INSPECTION_UNAVAILABLE'), true);
  assert.equal(missingInspectorSubmits, 0, 'a V2 custom submit port without an inspector must fail before submit');
}

let missingGatewayDraftWrites = 0;
const missingInspectionGateway = createOfficialCommandGateway({
  saveOfficialVoucherDraft: async () => { missingGatewayDraftWrites += 1; },
  runCentralOfficialVoucherCommand: async () => ({})
}, { featureGates: { PURCHASE: true, SALE: true } });
assert.throws(() => missingInspectionGateway.inspectStocktakeConflicts({ kind: 'PURCHASE', ...purchaseBefore }),
  /STOCKTAKE_INSPECTION_UNAVAILABLE/);
assert.throws(() => missingInspectionGateway.saveDraft({ kind: 'PURCHASE', ...purchaseBefore }, context.actor),
  /STOCKTAKE_INSPECTION_UNAVAILABLE/);
assert.equal(missingGatewayDraftWrites, 0, 'Gateway V2 saveDraft must not call an incomplete Repository port');

const dialogSource = readFileSync(new URL('../smartinput/stocktake-conflict-dialog.js', import.meta.url), 'utf8');
for (const phrase of [
  '이 전표는 최근 재고실사 이전의 거래입니다.',
  '이 수량이 실사 결과에 이미 포함되어 있습니까?',
  '실사수량에 포함됨',
  '실사수량에 포함되지 않음',
  '확정 취소'
]) assert.match(dialogSource, new RegExp(phrase));
assert.doesNotMatch(dialogSource, /localStorage|indexedDB|fetch\s*\(/);
assert.deepEqual(externalMutations, []);

console.log(JSON.stringify({
  task: 'NEXUS-SI-V2-05',
  package: 'SI-V2-STOCKTAKE-CONFLICT',
  checkpointScope: 'companyId+productCode(productId compatibility)+warehouseId',
  sameDayUnknown: 'DECISION_REQUIRED',
  included: 'ABSORBED_BY_CHECKPOINT',
  notIncluded: 'APPLIED_AS_LATE_ADJUSTMENT exactly once',
  mixedDecisions: 'PER_CONFLICT_ROW',
  missingInspectionPort: 'FAIL_CLOSED',
  judgedAt: 'Z_OR_EXPLICIT_OFFSET',
  cancelBeforeSubmit: true,
  purchaseSale: 'PASS',
  zeroNegative: 'PASS',
  externalMutations: externalMutations.length
}, null, 2));
console.log('SmartInput V2 Stage 5 stocktake conflict contracts PASS');
