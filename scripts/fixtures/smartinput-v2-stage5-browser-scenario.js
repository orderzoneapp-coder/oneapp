import * as repository from '../../orderq/official-voucher-repository.js?v=stage5-browser';
import { createOfficialCommandGateway } from '../../orderq/official-command-gateway.js?v=stage5-browser';
import { OFFICIAL_VOUCHER_IDENTITY_VERSION_V2 } from '../../orderq/official-voucher-v2-contract.js?v=stage5-browser';
import {
  OFFICIAL_STOCKTAKE_DECISION,
  officialStocktakeConflictKeyV2
} from '../../orderq/stocktake-conflict-v2.js?v=stage5-browser';
import { openOrderQDb, transactionDone } from '../../orderq/orderq-db.js?v=stage5-browser';
import { createPurchaseFinalizeService } from '../../smartinput/purchase-finalize-service.js?v=stage5-browser';
import { createSaleFinalizeService } from '../../smartinput/sale-finalize-service.js?v=stage5-browser';
import { buildPurchasePostDraft } from '../../smartinput/purchase-official-stage3.js?v=stage5-browser';
import { buildSalePostDraft } from '../../smartinput/sale-official-stage4.js?v=stage5-browser';
import { resolveOfficialVoucherReferencesV2 } from '../../smartinput/official-voucher-reference-resolver.js?v=stage5-browser';

const companyId = 'V2-STAGE5-COMPANY';
const actor = 'STAGE5-BROWSER';
const text = value => String(value ?? '').trim();
const errorText = error => `${error?.name || 'Error'}:${error?.message || String(error)}`;
const products = [
  { companyId, productId: 'V2-STAGE5-P-0007', itemCode: '0007', itemName: '실사 충돌 상품', status: 'ACTIVE', revision: 4 },
  { companyId, productId: 'V2-STAGE5-P-0008', itemCode: '0008', itemName: '혼합결정 상품', status: 'ACTIVE', revision: 2 }
];
const customers = [
  { companyId, customerId: 'V2-STAGE5-C-0003', customerCode: '0003', customerName: '실사 거래처', status: 'ACTIVE', revision: 5 }
];
const warehouses = [
  { warehouseId: 'V2-STAGE5-WH', warehouseCode: 'S5', warehouseName: '단계5창고', status: 'ACTIVE', revision: 1 }
];

function row(rowId, quantity = 10, productCode = '0007') {
  const product = products.find(item => item.itemCode === productCode);
  return {
    rowId,
    sourceLineKey: rowId,
    itemCode: product.itemCode,
    itemName: product.itemName,
    unit: 'BOX',
    warehouseId: 'V2-STAGE5-WH',
    warehouseCode: 'S5',
    warehouseName: '단계5창고',
    quantity,
    unitPrice: 100,
    actualToBaseFactor: 1,
    actualToRecognizedFactor: 0,
    sourceType: 'DIRECT'
  };
}

function group(kind, suffix, quantity = 10) {
  const purchase = kind === 'PURCHASE';
  return {
    companyId,
    voucherGroupKey: `${kind}|STAGE5|${suffix}`,
    voucherDate: '2026-08-05',
    warehouseId: 'V2-STAGE5-WH',
    warehouseCode: 'S5',
    warehouseName: '단계5창고',
    sourceDocumentKey: `V2-STAGE5-${kind}-${suffix}`,
    originSystem: 'SMARTINPUT_STAGE5_BROWSER',
    originTransactionId: `V2-STAGE5-${kind}-${suffix}`,
    sourceVoucherIndex: 1,
    ...(purchase ? {
      supplierCustomerCode: '0003', supplierCustomerName: '실사 거래처'
    } : {
      salesCustomerCode: '0003', salesCustomerName: '실사 거래처',
      deliveryCustomerCode: '', billingCustomerCode: ''
    }),
    rows: [row(`${kind}-${suffix}`, quantity)]
  };
}

function mixedGroup(kind, suffix) {
  const source = group(kind, suffix);
  source.rows = [
    row(`${kind}-${suffix}-INCLUDED`, 6, '0007'),
    row(`${kind}-${suffix}-NOT-INCLUDED`, 4, '0008')
  ];
  return source;
}

function selections(conflicts, decisionTypes) {
  return conflicts.map((conflict, index) => ({
    conflictKey: officialStocktakeConflictKeyV2(conflict),
    decisionType: Array.isArray(decisionTypes) ? decisionTypes[index] : decisionTypes[conflict.productCode],
    judgedAt: `2026-09-02T10:01:0${index}.000Z`
  }));
}

function request(kind, sourceGroup, stocktakeDecisions) {
  return {
    groups: [sourceGroup],
    companyId,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    masters: { products, customers, warehouses },
    products,
    customers,
    warehouses,
    productReferenceSnapshotId: 'V2-STAGE5-PRODUCT-SNAPSHOT',
    customerReferenceSnapshotId: 'V2-STAGE5-CUSTOMER-SNAPSHOT',
    actor,
    manualSessionId: `STAGE5-${kind}`,
    ...(Array.isArray(stocktakeDecisions) ? { stocktakeDecisions } : {})
  };
}

async function all(storeName) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = await new Promise((resolve, reject) => {
    const pending = tx.objectStore(storeName).getAll();
    pending.onsuccess = () => resolve(pending.result || []);
    pending.onerror = () => reject(pending.error);
  });
  await transactionDone(tx);
  return rows;
}

function belongsToCompany(row) {
  return text(row.companyId || row.payload?.companyId) === companyId;
}

async function officialCounts() {
  const names = [
    'purchaseDocuments', 'purchaseLines', 'salesDocuments', 'salesLines', 'voucherRevisions',
    'inventoryMovements', 'payableEntries', 'receivableEntries', 'pendingInventoryEffects',
    'unresolvedProducts', 'officialCommands', 'syncQueue'
  ];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, (await all(name)).filter(belongsToCompany).length])));
}

async function seedCheckpoint(checkpointId, effectiveAt = '2026-09-01') {
  return repository.recordInventoryCheckpoint({
    checkpointId,
    companyId,
    warehouseId: 'V2-STAGE5-WH',
    sessionId: `SESSION-${checkpointId}`,
    effectiveAt,
    coversAllProducts: false,
    counts: [
      { productCode: '0007', productId: 'V2-STAGE5-P-0007', quantity: 100 },
      { productCode: '0008', productId: 'V2-STAGE5-P-0008', quantity: 50 }
    ],
    actor: 'STOCKTAKE-BROWSER',
    confirmedAt: '2026-09-01T18:00:00.000Z'
  });
}

function serviceFor(kind, gateway, hooks = {}) {
  const build = kind === 'PURCHASE' ? buildPurchasePostDraft : buildSalePostDraft;
  const create = kind === 'PURCHASE' ? createPurchaseFinalizeService : createSaleFinalizeService;
  const drafts = [];
  let submitCount = 0;
  let inspectCount = 0;
  const service = create({
    now: () => '2026-09-02T10:00:00.000Z',
    validateGroup: () => true,
    inspectGroup: async (resolved, buildContext) => {
      inspectCount += 1;
      if (hooks.beforeInspect) await hooks.beforeInspect(inspectCount, resolved, buildContext);
      const inspectedDraft = build(resolved, buildContext);
      return gateway.inspectStocktakeConflicts({ kind, ...inspectedDraft });
    },
    submitGroup: async (resolved, buildContext) => {
      submitCount += 1;
      const postedDraft = build(resolved, buildContext);
      drafts.push(postedDraft);
      await gateway.saveDraft({ kind, ...postedDraft }, buildContext.actor);
      if (hooks.beforeExecute) await hooks.beforeExecute(postedDraft);
      return gateway.execute(postedDraft.commandSource);
    }
  });
  return { service, drafts, submitCount: () => submitCount, inspectCount: () => inspectCount };
}

function documentId(kind, draft) {
  return kind === 'PURCHASE' ? draft.purchaseDocumentId : draft.salesDocumentId;
}

export async function runSmartInputV2Stage5BrowserScenario() {
  const gateway = createOfficialCommandGateway(repository, { featureGates: { PURCHASE: true, SALE: true } });
  await seedCheckpoint('V2-STAGE5-CP-SEP01');

  const previewHarness = serviceFor('PURCHASE', gateway);
  const preview = await previewHarness.service.finalize(request('PURCHASE', group('PURCHASE', 'PREVIEW')));
  const countsBeforeDecision = await officialCounts();
  const submitCountBeforeDecision = previewHarness.submitCount();

  const included = await previewHarness.service.finalize(request('PURCHASE', group('PURCHASE', 'PREVIEW'), selections(
    preview[0].error.conflicts, [OFFICIAL_STOCKTAKE_DECISION.INCLUDED]
  )));
  if (!included[0]?.ok) throw included[0]?.error;
  const includedDraft = previewHarness.drafts[0];
  const includedAggregate = await repository.loadOfficialPurchaseAggregate(includedDraft.purchaseDocumentId);
  const includedDuplicate = await gateway.execute(includedDraft.commandSource);

  const saleHarness = serviceFor('SALE', gateway);
  const lateGroup = group('SALE', 'LATE', 4);
  const latePreview = await saleHarness.service.finalize(request('SALE', lateGroup));
  const notIncluded = await saleHarness.service.finalize(request('SALE', lateGroup, selections(
    latePreview[0].error.conflicts, [OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED]
  )));
  if (!notIncluded[0]?.ok) throw notIncluded[0]?.error;
  const saleDraft = saleHarness.drafts[0];
  const saleAggregate = await repository.loadOfficialSaleAggregate(saleDraft.salesDocumentId);
  const saleDuplicate = await gateway.execute(saleDraft.commandSource);

  const staleHarness = serviceFor('PURCHASE', gateway, {
    beforeInspect: async count => {
      if (count === 2) await seedCheckpoint('V2-STAGE5-CP-SEP02', '2026-09-02');
    }
  });
  const staleGroup = group('PURCHASE', 'STALE');
  const stalePreview = await staleHarness.service.finalize(request('PURCHASE', staleGroup));
  const stale = await staleHarness.service.finalize(request('PURCHASE', staleGroup, selections(
    stalePreview[0].error.conflicts, [OFFICIAL_STOCKTAKE_DECISION.INCLUDED]
  )));
  const staleDraft = buildPurchasePostDraft(resolveOfficialVoucherReferencesV2({
      kind: 'PURCHASE', companyId, group: group('PURCHASE', 'STALE'), products, customers,
      productReferenceSnapshotId: 'V2-STAGE5-PRODUCT-SNAPSHOT', customerReferenceSnapshotId: 'V2-STAGE5-CUSTOMER-SNAPSHOT'
    }), {
      companyId, identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2, actor,
      originSystem: 'SMARTINPUT_STAGE5_BROWSER', manualSessionId: 'STAGE5-PURCHASE',
      occurredAt: '2026-09-02T10:00:00.000Z'
    });
  const staleAggregate = await repository.loadOfficialPurchaseAggregate(staleDraft.purchaseDocumentId);

  const rollbackHarness = serviceFor('PURCHASE', gateway, {
    beforeExecute: async rollbackDraft => {
      const db = await openOrderQDb();
      const tx = db.transaction('officialCommands', 'readwrite');
      tx.objectStore('officialCommands').add({
        commandId: 'V2-STAGE5-ROLLBACK-BLOCKER',
        idempotencyKey: rollbackDraft.commandSource.commandId,
        companyId,
        voucherMode: 'purchase',
        documentId: 'V2-STAGE5-ROLLBACK-BLOCKER-DOCUMENT',
        commandType: 'POST_PURCHASE',
        status: 'TEST_BLOCKER',
        requestedAt: '2026-09-02T09:00:00.000Z'
      });
      await transactionDone(tx);
    }
  });
  const rollbackGroup = group('PURCHASE', 'ROLLBACK');
  const rollbackPreview = await rollbackHarness.service.finalize(request('PURCHASE', rollbackGroup));
  const rollback = await rollbackHarness.service.finalize(request('PURCHASE', rollbackGroup, selections(
    rollbackPreview[0].error.conflicts, [OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED]
  )));
  const rollbackDraft = rollbackHarness.drafts[0];
  const rollbackAggregate = await repository.loadOfficialPurchaseAggregate(rollbackDraft.purchaseDocumentId);
  const rollbackQueue = (await all('syncQueue')).filter(row => text(row.entityId) === text(rollbackDraft.commandSource.commandId));

  await repository.recordInventoryCheckpoint({
    checkpointId: 'V2-STAGE5-OTHER-COMPANY-CP',
    companyId: 'V2-STAGE5-OTHER',
    warehouseId: 'V2-STAGE5-ISOLATION-WH',
    sessionId: 'V2-STAGE5-OTHER-COMPANY-SESSION',
    effectiveAt: '2026-09-01',
    coversAllProducts: false,
    counts: [{ productCode: '0007', productId: 'V2-STAGE5-P-0007', quantity: 100 }],
    actor: 'STOCKTAKE-BROWSER',
    confirmedAt: '2026-09-01T18:00:00.000Z'
  });
  const isolationGroup = group('PURCHASE', 'COMPANY-ISOLATION');
  isolationGroup.warehouseId = 'V2-STAGE5-ISOLATION-WH';
  isolationGroup.warehouseCode = 'ISO';
  isolationGroup.rows = isolationGroup.rows.map(line => ({
    ...line, warehouseId: 'V2-STAGE5-ISOLATION-WH', warehouseCode: 'ISO'
  }));
  const isolationResolved = resolveOfficialVoucherReferencesV2({
    kind: 'PURCHASE', companyId, group: isolationGroup, products, customers,
    productReferenceSnapshotId: 'V2-STAGE5-PRODUCT-SNAPSHOT', customerReferenceSnapshotId: 'V2-STAGE5-CUSTOMER-SNAPSHOT'
  });
  const isolationDraft = buildPurchasePostDraft(isolationResolved, {
    companyId, identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2, actor,
    originSystem: 'SMARTINPUT_STAGE5_BROWSER', manualSessionId: 'ISOLATION', occurredAt: '2026-09-02T10:00:00.000Z'
  });
  const otherCompanyConflicts = await gateway.inspectStocktakeConflicts({ kind: 'PURCHASE', ...isolationDraft });

  const mixed = {};
  for (const kind of ['PURCHASE', 'SALE']) {
    const harness = serviceFor(kind, gateway);
    const source = mixedGroup(kind, `MIXED-${kind}`);
    const mixedPreview = await harness.service.finalize(request(kind, source));
    const decided = await harness.service.finalize(request(kind, source, selections(
      mixedPreview[0].error.conflicts,
      {
        '0007': OFFICIAL_STOCKTAKE_DECISION.INCLUDED,
        '0008': OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED
      }
    )));
    if (!decided[0]?.ok) throw decided[0]?.error;
    const draft = harness.drafts[0];
    const aggregate = kind === 'PURCHASE'
      ? await repository.loadOfficialPurchaseAggregate(draft.purchaseDocumentId)
      : await repository.loadOfficialSaleAggregate(draft.salesDocumentId);
    mixed[kind.toLowerCase()] = {
      decisions: aggregate.revisions[0].stocktakeDecisions.map(decision => ({
        productCode: decision.target.productCode,
        decisionType: decision.decisionType
      })).sort((left, right) => left.productCode.localeCompare(right.productCode)),
      movementCount: aggregate.inventoryMovements.length,
      adjustmentCount: aggregate.inventoryMovements.filter(effect => effect.effectRole === 'LATE_ADJUSTMENT').length,
      appliedQuantity: aggregate.inventoryMovements.reduce((sum, effect) => sum + Number(effect.signedQuantity), 0),
      submitCount: harness.submitCount()
    };
  }

  const cancelHarness = serviceFor('PURCHASE', gateway);
  const cancelCountsBefore = await officialCounts();
  const cancelPreview = await cancelHarness.service.finalize(request('PURCHASE', mixedGroup('PURCHASE', 'MID-CANCEL')));
  const cancelCountsAfter = await officialCounts();

  return {
    featureGates: gateway.featureGates,
    preview: {
      error: errorText(preview[0]?.error),
      conflicts: preview[0]?.error?.conflicts?.map(conflict => ({
        productCode: conflict.productCode,
        productName: conflict.productName,
        warehouse: conflict.warehouseName,
        quantity: conflict.quantity,
        checkpointId: conflict.checkpointId
      })) || [],
      submitCount: submitCountBeforeDecision,
      countsBeforeDecision
    },
    included: {
      status: includedAggregate.inventoryMovements[0]?.effectStatus,
      appliedQuantity: includedAggregate.inventoryMovements.reduce((sum, effect) => sum + Number(effect.signedQuantity), 0),
      applied: includedAggregate.inventoryMovements[0]?.officialInventoryApplied,
      checkpointId: includedAggregate.inventoryMovements[0]?.checkpointId,
      decisions: includedAggregate.revisions[0]?.stocktakeDecisions?.length,
      duplicate: includedDuplicate.duplicate,
      movements: includedAggregate.inventoryMovements.length,
      commands: includedAggregate.commands.length,
      revisions: includedAggregate.revisions.length
    },
    notIncluded: {
      sourceStatus: saleAggregate.inventoryMovements.find(effect => effect.effectRole === 'SOURCE_VOUCHER_EFFECT')?.effectStatus,
      adjustmentStatus: saleAggregate.inventoryMovements.find(effect => effect.effectRole === 'LATE_ADJUSTMENT')?.effectStatus,
      adjustmentCount: saleAggregate.inventoryMovements.filter(effect => effect.effectRole === 'LATE_ADJUSTMENT').length,
      appliedQuantity: saleAggregate.inventoryMovements.reduce((sum, effect) => sum + Number(effect.signedQuantity), 0),
      checkpointLinked: saleAggregate.inventoryMovements.every(effect => Boolean(effect.checkpointId)),
      duplicate: saleDuplicate.duplicate,
      commands: saleAggregate.commands.length,
      revisions: saleAggregate.revisions.length
    },
    staleCheckpoint: {
      error: errorText(stale[0]?.error),
      submitCount: staleHarness.submitCount(),
      officialDocument: Boolean(staleAggregate)
    },
    rollback: {
      error: errorText(rollback[0]?.error),
      documentStatus: rollbackAggregate.document.status,
      documentRevision: rollbackAggregate.document.revision,
      revisions: rollbackAggregate.revisions.length,
      inventory: rollbackAggregate.inventoryMovements.length,
      ledger: rollbackAggregate.ledgerEntries.length,
      commands: rollbackAggregate.commands.length,
      queue: rollbackQueue.length
    },
    companyIsolation: otherCompanyConflicts.conflicts.length === 0,
    mixed,
    midCancel: {
      conflictCount: cancelPreview[0]?.error?.conflicts?.length || 0,
      submitCount: cancelHarness.submitCount(),
      countsUnchanged: JSON.stringify(cancelCountsBefore) === JSON.stringify(cancelCountsAfter)
    },
    ids: {
      includedDocument: documentId('PURCHASE', includedDraft),
      saleDocument: documentId('SALE', saleDraft)
    }
  };
}
