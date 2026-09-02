import * as repository from '../../orderq/official-voucher-repository.js?v=stage4-browser';
import { createOfficialCommandGateway } from '../../orderq/official-command-gateway.js?v=stage4-browser';
import { OFFICIAL_VOUCHER_IDENTITY_VERSION_V2 } from '../../orderq/official-voucher-v2-contract.js?v=stage4-browser';
import { openOrderQDb, transactionDone } from '../../orderq/orderq-db.js?v=stage4-browser';
import { createPurchaseFinalizeService } from '../../smartinput/purchase-finalize-service.js?v=stage4-browser';
import { createSaleFinalizeService } from '../../smartinput/sale-finalize-service.js?v=stage4-browser';
import { buildPurchasePostDraft } from '../../smartinput/purchase-official-stage3.js?v=stage4-browser';
import { buildSalePostDraft } from '../../smartinput/sale-official-stage4.js?v=stage4-browser';

const text = value => String(value ?? '').trim();
const errorText = error => `${error?.name || 'Error'}:${error?.message || String(error)}`;

const products = [
  { companyId: 'V2-STAGE4-COMPANY', productId: 'V2-STAGE4-P-0007', itemCode: '0007', itemName: '같은 이름', status: 'ACTIVE', revision: 4 },
  { companyId: 'V2-STAGE4-COMPANY', productId: 'V2-STAGE4-P-7', itemCode: '7', itemName: '같은 이름', status: 'ACTIVE', revision: 2 },
  { companyId: 'OTHER-COMPANY', productId: 'V2-STAGE4-P-OTHER', itemCode: '0007', itemName: '같은 이름', status: 'ACTIVE', revision: 9 }
];
const customers = [
  { companyId: 'V2-STAGE4-COMPANY', customerId: 'V2-STAGE4-C-0003', customerCode: '0003', customerName: '같은 거래처명', status: 'ACTIVE', revision: 5 },
  { companyId: 'OTHER-COMPANY', customerId: 'V2-STAGE4-C-OTHER', customerCode: '0003', customerName: '같은 거래처명', status: 'ACTIVE', revision: 7 }
];
const warehouses = [{ warehouseId: 'V2-STAGE4-WH', warehouseCode: 'S4', status: 'ACTIVE', revision: 1 }];

function row(rowId, overrides = {}) {
  return {
    rowId,
    sourceLineKey: rowId,
    itemCode: '0007',
    itemName: '확정 당시 상품명',
    specification: '10kg',
    unit: 'BOX',
    productId: 'STALE-PRODUCT-ID',
    warehouseId: 'V2-STAGE4-WH',
    quantity: 10,
    unitPrice: 100,
    conversionFactor: 12,
    actualToBaseFactor: 12,
    ...overrides
  };
}

function purchaseGroup(suffix, overrides = {}) {
  return {
    companyId: 'V2-STAGE4-COMPANY',
    voucherGroupKey: `PURCHASE|STAGE4|${suffix}`,
    supplierCustomerId: 'STALE-CUSTOMER-ID',
    supplierCustomerCode: '0003',
    supplierCustomerName: '확정 당시 거래처명',
    voucherDate: '2026-09-02',
    warehouseId: 'V2-STAGE4-WH',
    warehouseCode: 'S4',
    sourceDocumentKey: `V2-STAGE4-PURCHASE-${suffix}`,
    originSystem: 'SMARTINPUT_STAGE4_BROWSER',
    originTransactionId: `V2-STAGE4-PURCHASE-${suffix}`,
    sourceVoucherIndex: 1,
    rows: [row(`P-${suffix}`)],
    ...overrides
  };
}

function saleGroup(suffix, overrides = {}) {
  return {
    companyId: 'V2-STAGE4-COMPANY',
    voucherGroupKey: `SALE|STAGE4|${suffix}`,
    salesCustomerId: 'STALE-CUSTOMER-ID',
    salesCustomerCode: '0099',
    salesCustomerName: '미매칭 거래처명',
    deliveryCustomerId: '',
    deliveryCustomerCode: '',
    deliveryCustomerName: '',
    billingCustomerId: '',
    billingCustomerCode: '',
    billingCustomerName: '',
    voucherDate: '2026-09-02',
    warehouseId: 'V2-STAGE4-WH',
    warehouseCode: 'S4',
    sourceDocumentKey: `V2-STAGE4-SALE-${suffix}`,
    originSystem: 'SMARTINPUT_STAGE4_BROWSER',
    originTransactionId: `V2-STAGE4-SALE-${suffix}`,
    sourceVoucherIndex: 1,
    rows: [row(`S-${suffix}`, { quantity: 4 })],
    ...overrides
  };
}

function context() {
  return {
    companyId: 'V2-STAGE4-COMPANY',
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    actor: 'STAGE4-BROWSER',
    originSystem: 'SMARTINPUT_STAGE4_BROWSER',
    manualSessionId: 'STAGE4-BROWSER',
    occurredAt: '2026-09-02T10:00:00.000Z'
  };
}

async function reject(action) {
  try {
    await action();
    return '';
  } catch (error) {
    return errorText(error);
  }
}

async function rowsFromStore(storeName) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const request = tx.objectStore(storeName).getAll();
  const rows = await new Promise((resolve, rejectRequest) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => rejectRequest(request.error);
  });
  await transactionDone(tx);
  return rows;
}

export async function runSmartInputV2Stage4BrowserScenario() {
  const gateway = createOfficialCommandGateway(repository, { featureGates: { PURCHASE: true, SALE: true } });
  let purchaseDraft;
  const purchaseFinalize = createPurchaseFinalizeService({
    now: () => context().occurredAt,
    submitGroup: async (resolved, buildContext) => {
      purchaseDraft = buildPurchasePostDraft(resolved, buildContext);
      await gateway.saveDraft({ kind: 'PURCHASE', ...purchaseDraft }, buildContext.actor);
      return gateway.execute(purchaseDraft.commandSource);
    }
  });
  const purchaseResult = await purchaseFinalize.finalize({
    groups: [purchaseGroup('SUCCESS', {
      rows: [
        row('P-MATCHED', { quantity: 10, finalAmount: 1111 }),
        row('P-ZERO', { quantity: 0, unitPrice: 0 }),
        row('P-UNRESOLVED', { itemCode: '0099', itemName: '미등록 상품', quantity: 5, unitPrice: 200 }),
        row('P-UNRESOLVED-SECOND', { itemCode: '0099', itemName: '미등록 상품 별칭', quantity: -1, unitPrice: 50 }),
        row('P-NAME-ONLY', { itemCode: '', itemName: '같은 이름', quantity: 2, unitPrice: 300 })
      ]
    })],
    companyId: 'V2-STAGE4-COMPANY',
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    masters: { products, customers, warehouses },
    productReferenceSnapshotId: 'V2-STAGE4-PRODUCT-SNAPSHOT',
    customerReferenceSnapshotId: 'V2-STAGE4-CUSTOMER-SNAPSHOT',
    actor: 'STAGE4-BROWSER',
    manualSessionId: 'STAGE4-BROWSER'
  });
  if (!purchaseResult[0]?.ok) throw purchaseResult[0]?.error;
  const postedPurchase = purchaseResult[0].result;
  const duplicatePurchase = await gateway.execute(purchaseDraft.commandSource);
  const purchaseAggregate = await repository.loadOfficialPurchaseAggregate(purchaseDraft.purchaseDocumentId);
  const purchaseQueue = (await rowsFromStore('syncQueue'))
    .filter(entry => text(entry.entityId) === text(purchaseDraft.commandSource.commandId));

  let saleDraft;
  const saleFinalize = createSaleFinalizeService({
    now: () => context().occurredAt,
    submitGroup: async (resolved, buildContext) => {
      saleDraft = buildSalePostDraft(resolved, buildContext);
      await gateway.saveDraft({ kind: 'SALE', ...saleDraft }, buildContext.actor);
      return gateway.execute(saleDraft.commandSource);
    }
  });
  const saleResult = await saleFinalize.finalize({
    groups: [saleGroup('UNMATCHED-CUSTOMER')],
    companyId: 'V2-STAGE4-COMPANY',
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    products,
    customers,
    warehouses,
    productReferenceSnapshotId: 'V2-STAGE4-PRODUCT-SNAPSHOT',
    customerReferenceSnapshotId: 'V2-STAGE4-CUSTOMER-SNAPSHOT',
    actor: 'STAGE4-BROWSER',
    manualSessionId: 'STAGE4-BROWSER'
  });
  if (!saleResult[0]?.ok) throw saleResult[0]?.error;
  const postedSale = saleResult[0].result;
  const saleAggregate = await repository.loadOfficialSaleAggregate(saleDraft.salesDocumentId);

  let rollbackDraft;
  const rollbackFinalize = createPurchaseFinalizeService({
    now: () => context().occurredAt,
    submitGroup: async (resolved, buildContext) => {
      rollbackDraft = buildPurchasePostDraft(resolved, buildContext);
      await gateway.saveDraft({ kind: 'PURCHASE', ...rollbackDraft }, buildContext.actor);
      const db = await openOrderQDb();
      const blocker = db.transaction('officialCommands', 'readwrite');
      blocker.objectStore('officialCommands').add({
        commandId: 'V2-STAGE4-ROLLBACK-BLOCKER',
        idempotencyKey: rollbackDraft.commandSource.commandId,
        companyId: 'V2-STAGE4-COMPANY',
        voucherMode: 'purchase',
        documentId: 'V2-STAGE4-ROLLBACK-BLOCKER-DOCUMENT',
        commandType: 'POST_PURCHASE',
        status: 'TEST_BLOCKER',
        requestedAt: '2026-09-02T09:00:00.000Z'
      });
      await transactionDone(blocker);
      return gateway.execute(rollbackDraft.commandSource);
    }
  });
  const rollbackResult = await rollbackFinalize.finalize({
    groups: [purchaseGroup('ROLLBACK', {
      rows: [
        row('P-ROLLBACK-ZERO', { quantity: 0 }),
        row('P-ROLLBACK-UNRESOLVED', { itemCode: 'ROLLBACK-UNRESOLVED', itemName: '롤백 미등록' })
      ]
    })],
    companyId: 'V2-STAGE4-COMPANY',
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    masters: { products, customers, warehouses },
    actor: 'STAGE4-BROWSER',
    manualSessionId: 'STAGE4-BROWSER'
  });
  const rollbackAggregate = await repository.loadOfficialPurchaseAggregate(rollbackDraft.purchaseDocumentId);
  const rollbackQueue = (await rowsFromStore('syncQueue'))
    .filter(entry => text(entry.entityId) === text(rollbackDraft.commandSource.commandId));

  return {
    featureGates: gateway.featureGates,
    purchase: {
      matchedEffects: postedPurchase.inventoryMovements
        .map(effect => ({ quantity: effect.signedQuantity, status: effect.effectStatus }))
        .sort((left, right) => right.quantity - left.quantity),
      unresolvedOfficialInventory: postedPurchase.inventoryMovements.filter(effect => ['0099', ''].includes(effect.productCode)).length,
      pending: postedPurchase.pendingInventoryEffects
        .map(effect => ({
          code: effect.productCode,
          name: effect.productName,
          status: effect.inventoryEffectStatus,
          applied: effect.officialInventoryApplied,
          documentLinked: effect.sourceDocumentId === purchaseDraft.purchaseDocumentId,
          revisionLinked: effect.voucherRevisionId === postedPurchase.voucherRevision.voucherRevisionId
        }))
        .sort((left, right) => Number(Boolean(right.code)) - Number(Boolean(left.code))
          || left.name.localeCompare(right.name, 'ko')),
      unresolvedReviewRecords: purchaseAggregate.unresolvedProducts.map(record => ({
        status: record.status,
        linkCount: record.reviewLinks?.length || 0,
        documentLinked: record.reviewLinks?.every(link => link.sourceDocumentId === purchaseDraft.purchaseDocumentId),
        lineLinked: record.reviewLinks?.every(link => Boolean(link.sourceLineId)),
        revisionLinked: record.reviewLinks?.every(link => link.voucherRevisionId === postedPurchase.voucherRevision.voucherRevisionId),
        applied: record.officialInventoryApplied
      })),
      payable: postedPurchase.ledgerEntries.map(entry => ({ partnerId: entry.partnerId, amount: entry.totalAmount })),
      ledgerDecision: postedPurchase.voucherRevision.partnerEffectDecision,
      duplicate: duplicatePurchase.duplicate,
      aggregateCounts: {
        lines: purchaseAggregate.lines.length,
        inventory: purchaseAggregate.inventoryMovements.length,
        pending: purchaseAggregate.pendingInventoryEffects.length,
        unresolved: purchaseAggregate.unresolvedProducts.length,
        ledger: purchaseAggregate.ledgerEntries.length,
        revisions: purchaseAggregate.revisions.length,
        commands: purchaseAggregate.commands.length,
        queue: purchaseQueue.length
      },
      factorOne: purchaseAggregate.lines.every(line => line.inventoryEffectFactor === 1 && line.baseQuantity === line.actualQuantity),
      leadingZeroProductId: purchaseAggregate.lines.find(line => line.productCode === '0007')?.productId
    },
    sale: {
      inventory: postedSale.inventoryMovements[0]?.signedQuantity,
      receivables: postedSale.ledgerEntries.length,
      ledgerDecision: postedSale.voucherRevision.partnerEffectDecision,
      partnerId: saleAggregate.document.billingCustomerId || saleAggregate.document.salesCustomerId
    },
    rollback: {
      error: rollbackResult[0]?.ok ? '' : errorText(rollbackResult[0]?.error),
      status: rollbackAggregate.document.status,
      revision: rollbackAggregate.document.revision,
      lineStatuses: rollbackAggregate.lines.map(line => line.status),
      revisions: rollbackAggregate.revisions.length,
      inventory: rollbackAggregate.inventoryMovements.length,
      pending: rollbackAggregate.pendingInventoryEffects.length,
      unresolved: rollbackAggregate.unresolvedProducts.length,
      ledger: rollbackAggregate.ledgerEntries.length,
      commands: rollbackAggregate.commands.length,
      queue: rollbackQueue.length
    }
  };
}
