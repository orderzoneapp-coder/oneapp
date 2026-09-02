import * as repository from '../../orderq/official-voucher-repository.js?v=stage3-browser';
import { createOfficialCommandGateway } from '../../orderq/official-command-gateway.js?v=stage3-browser';
import {
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  withOfficialCommandIdentityV2
} from '../../orderq/official-voucher-v2-contract.js?v=stage3-browser';
import { openOrderQDb, transactionDone } from '../../orderq/orderq-db.js?v=stage3-browser';
import { buildPurchasePostDraft } from '../../smartinput/purchase-official-stage3.js?v=stage3-browser';
import { buildSalePostDraft } from '../../smartinput/sale-official-stage4.js?v=stage3-browser';

const clone = value => structuredClone(value);
const errorText = error => `${error?.name || 'Error'}:${error?.message || String(error)}`;

function row(rowId, overrides = {}) {
  return {
    rowId,
    itemCode: `CODE-${rowId}`,
    itemName: `확정 상품 ${rowId}`,
    specification: '10kg',
    unit: 'BOX',
    productId: `PRODUCT-${rowId}`,
    productMasterRevision: 1,
    referenceSnapshotId: `PRODUCT-SNAPSHOT-${rowId}`,
    matchStatus: 'MATCHED',
    matchSource: 'EXACT_COMPANY_PRODUCT_CODE',
    warehouseId: 'WH-V2',
    warehouseMasterRevision: 1,
    quantity: 2,
    unitPrice: 1250,
    conversionFactor: 1,
    actualToBaseFactor: 1,
    ...overrides
  };
}

function context(companyId) {
  return {
    companyId,
    identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
    originSystem: 'SMARTINPUT_E2E',
    manualSessionId: 'STAGE3-BROWSER',
    actor: 'STAGE3-BROWSER',
    occurredAt: '2026-09-02T09:00:00.000Z'
  };
}

function purchaseGroup(suffix, overrides = {}) {
  return {
    companyId: 'V2-COMPANY',
    voucherGroupKey: `PURCHASE|STAGE3|${suffix}`,
    supplierCustomerId: 'V2-SUPPLIER',
    supplierCustomerCode: 'V2-SUPPLIER',
    supplierCustomerName: 'V2 구매처',
    voucherDate: '2026-09-',
    warehouseId: 'WH-V2',
    warehouseCode: 'WH-V2',
    sourceDocumentKey: `V2-PURCHASE-${suffix}`,
    sourceVoucherIndex: 1,
    rows: [row(`P-${suffix}`)],
    ...overrides
  };
}

function saleGroup(suffix, overrides = {}) {
  return {
    companyId: 'V2-COMPANY',
    voucherGroupKey: `SALE|STAGE3|${suffix}`,
    originSystem: 'SMARTINPUT_E2E',
    originTransactionId: `V2-SALE-${suffix}`,
    sourceDocumentKey: `V2-SALE-${suffix}`,
    salesCustomerId: 'V2-CUSTOMER',
    salesCustomerName: 'V2 판매처',
    salesCustomerRevision: 1,
    deliveryCustomerId: 'V2-CUSTOMER',
    deliveryCustomerRevision: 1,
    billingCustomerId: 'V2-CUSTOMER',
    billingCustomerRevision: 1,
    voucherDate: '2026-09-02',
    warehouseId: 'WH-V2',
    warehouseCode: 'WH-V2',
    sourceVoucherIndex: 1,
    rows: [row(`S-${suffix}`)],
    ...overrides
  };
}

async function rejection(action) {
  try {
    await action();
    return '';
  } catch (error) {
    return errorText(error);
  }
}

export async function runSmartInputV2Stage3BrowserScenario() {
  const gateway = createOfficialCommandGateway(repository, {
    featureGates: { PURCHASE: true, SALE: true }
  });

  const purchaseSource = purchaseGroup('SUCCESS', { rows: [row('P-SUCCESS', {
    itemCode: '０００７',
    itemName: '㈜金 확정상품',
    originalProductCode: '０A①',
    originalProductName: '㈜金 원본상품'
  })] });
  const purchaseDraft = buildPurchasePostDraft(purchaseSource, context('V2-COMPANY'));
  await gateway.saveDraft({ kind: 'PURCHASE', ...purchaseDraft }, 'STAGE3-BROWSER');

  const wrongRevision = withOfficialCommandIdentityV2({
    ...clone(purchaseDraft.commandSource),
    expectedRevision: 2
  });
  const expectedRevisionError = await rejection(() => gateway.execute(wrongRevision));
  const postedPurchase = await gateway.execute(purchaseDraft.commandSource);
  const duplicatePurchase = await gateway.execute(purchaseDraft.commandSource);

  purchaseSource.rows[0].itemName = '변경된 기준상품명';
  purchaseSource.rows[0].itemCode = '';
  purchaseSource.rows[0].productId = '';
  const purchaseAggregate = await repository.loadOfficialPurchaseAggregate(purchaseDraft.purchaseDocumentId);

  const changedPayload = clone(purchaseDraft.commandSource);
  changedPayload.lines[0].unitPrice = 9999;
  const payloadConflictError = await rejection(() => gateway.execute(changedPayload));
  const changedNonSnapshotPayload = clone(purchaseDraft.commandSource);
  changedNonSnapshotPayload.reason = 'PURCHASE_POST_CHANGED_WITH_SAME_COMMAND_ID';
  const gatewayCommandPayloadConflictError = await rejection(() => gateway.execute(changedNonSnapshotPayload));
  const repositoryCommandPayloadConflictError = await rejection(() => repository.runCentralOfficialVoucherCommand(changedNonSnapshotPayload));

  const wrongCompany = clone(purchaseDraft.commandSource);
  wrongCompany.document.companyId = 'OTHER-COMPANY';
  const repositoryCompanyError = await rejection(() => repository.runCentralOfficialVoucherCommand(wrongCompany));
  const unsupportedIdentity = clone(purchaseDraft.commandSource);
  unsupportedIdentity.identityVersion = 'UNSUPPORTED_IDENTITY';
  const gatewayIdentityError = await rejection(() => gateway.execute(unsupportedIdentity));
  const repositoryIdentityError = await rejection(() => repository.runCentralOfficialVoucherCommand(unsupportedIdentity));

  const saleDraft = buildSalePostDraft(saleGroup('GROUP-A'), context('V2-COMPANY'));
  const otherSaleGroup = buildSalePostDraft(saleGroup('GROUP-B'), context('V2-COMPANY'));
  await gateway.saveDraft({ kind: 'SALE', ...saleDraft }, 'STAGE3-BROWSER');
  const wrongSaleRevision = withOfficialCommandIdentityV2({
    ...clone(saleDraft.commandSource),
    expectedRevision: 2
  });
  const saleExpectedRevisionError = await rejection(() => gateway.execute(wrongSaleRevision));
  const postedSale = await gateway.execute(saleDraft.commandSource);
  const duplicateSale = await gateway.execute(saleDraft.commandSource);
  const changedSalePayload = clone(saleDraft.commandSource);
  changedSalePayload.lines[0].unitPrice = 7777;
  const salePayloadConflictError = await rejection(() => gateway.execute(changedSalePayload));

  const rollbackDraft = buildPurchasePostDraft(purchaseGroup('ROLLBACK'), context('V2-COMPANY'));
  await gateway.saveDraft({ kind: 'PURCHASE', ...rollbackDraft }, 'STAGE3-BROWSER');
  const db = await openOrderQDb();
  const blocker = db.transaction('officialCommands', 'readwrite');
  blocker.objectStore('officialCommands').add({
    commandId: 'V2-STAGE3-ROLLBACK-BLOCKER',
    idempotencyKey: rollbackDraft.commandSource.commandId,
    companyId: 'V2-COMPANY',
    voucherMode: 'purchase',
    documentId: 'V2-STAGE3-ROLLBACK-BLOCKER-DOCUMENT',
    commandType: 'POST_PURCHASE',
    status: 'TEST_BLOCKER',
    requestedAt: '2026-09-02T08:00:00.000Z'
  });
  await transactionDone(blocker);
  const rollbackError = await rejection(() => gateway.execute(rollbackDraft.commandSource));
  const rollbackAggregate = await repository.loadOfficialPurchaseAggregate(rollbackDraft.purchaseDocumentId);

  const saleRollbackDraft = buildSalePostDraft(saleGroup('ROLLBACK'), context('V2-COMPANY'));
  await gateway.saveDraft({ kind: 'SALE', ...saleRollbackDraft }, 'STAGE3-BROWSER');
  const saleBlocker = db.transaction('officialCommands', 'readwrite');
  saleBlocker.objectStore('officialCommands').add({
    commandId: 'V2-STAGE3-SALE-ROLLBACK-BLOCKER',
    idempotencyKey: saleRollbackDraft.commandSource.commandId,
    companyId: 'V2-COMPANY',
    voucherMode: 'sale',
    documentId: 'V2-STAGE3-SALE-ROLLBACK-BLOCKER-DOCUMENT',
    commandType: 'POST_SALE',
    status: 'TEST_BLOCKER',
    requestedAt: '2026-09-02T08:00:00.000Z'
  });
  await transactionDone(saleBlocker);
  const saleRollbackError = await rejection(() => gateway.execute(saleRollbackDraft.commandSource));
  const saleRollbackAggregate = await repository.loadOfficialSaleAggregate(saleRollbackDraft.salesDocumentId);

  return {
    featureGates: gateway.featureGates,
    purchase: {
      date: purchaseAggregate.document.purchaseDate,
      dayDefaulted: purchaseAggregate.document.businessDateDayDefaulted,
      inventory: postedPurchase.inventoryMovements[0]?.signedQuantity,
      ledger: postedPurchase.ledgerEntries.length,
      duplicate: duplicatePurchase.duplicate,
      commands: purchaseAggregate.commands.length,
      revisions: purchaseAggregate.revisions.length,
      frozenName: purchaseAggregate.lines[0]?.productSnapshot?.productName,
      frozenCode: purchaseAggregate.lines[0]?.productSnapshot?.productCode,
      frozenOriginalName: purchaseAggregate.lines[0]?.productSnapshot?.originalProductName,
      frozenOriginalCode: purchaseAggregate.lines[0]?.productSnapshot?.originalProductCode
    },
    sale: {
      inventory: postedSale.inventoryMovements[0]?.signedQuantity,
      ledger: postedSale.ledgerEntries.length,
      duplicate: duplicateSale.duplicate,
      differentGroupDocumentId: saleDraft.salesDocumentId !== otherSaleGroup.salesDocumentId
    },
    safety: {
      expectedRevisionError,
      saleExpectedRevisionError,
      payloadConflictError,
      gatewayCommandPayloadConflictError,
      repositoryCommandPayloadConflictError,
      nonSnapshotCommandIdUnchanged: changedNonSnapshotPayload.commandId === purchaseDraft.commandSource.commandId,
      salePayloadConflictError,
      repositoryCompanyError,
      gatewayIdentityError,
      repositoryIdentityError
    },
    rollback: {
      error: rollbackError,
      status: rollbackAggregate.document.status,
      revision: rollbackAggregate.document.revision,
      lineStatuses: rollbackAggregate.lines.map(line => line.status),
      revisions: rollbackAggregate.revisions.length,
      inventory: rollbackAggregate.inventoryMovements.length,
      ledger: rollbackAggregate.ledgerEntries.length,
      pending: rollbackAggregate.pendingInventoryEffects.length,
      commands: rollbackAggregate.commands.length
    },
    saleRollback: {
      error: saleRollbackError,
      status: saleRollbackAggregate.document.status,
      revision: saleRollbackAggregate.document.revision,
      lineStatuses: saleRollbackAggregate.lines.map(line => line.status),
      revisions: saleRollbackAggregate.revisions.length,
      inventory: saleRollbackAggregate.inventoryMovements.length,
      ledger: saleRollbackAggregate.ledgerEntries.length,
      pending: saleRollbackAggregate.pendingInventoryEffects.length,
      commands: saleRollbackAggregate.commands.length
    }
  };
}
