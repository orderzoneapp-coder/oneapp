import * as repository from '../../orderq/official-voucher-repository.js?v=stage7a-browser';
import { createOfficialCommandGateway } from '../../orderq/official-command-gateway.js?v=stage7a-browser';
import { OFFICIAL_VOUCHER_IDENTITY_VERSION_V2 } from '../../orderq/official-voucher-v2-contract.js?v=stage7a-browser';
import { openOrderQDb, transactionDone } from '../../orderq/orderq-db.js?v=stage7a-browser';
import { buildPurchasePostDraft } from '../../smartinput/purchase-official-stage3.js?v=stage7a-browser';
import { buildSalePostDraft } from '../../smartinput/sale-official-stage4.js?v=stage7a-browser';
import { resolveOfficialVoucherReferencesV2 } from '../../smartinput/official-voucher-reference-resolver.js?v=stage7a-browser';
import { canonicalSha256, unresolvedProductStableId, voucherStableId } from '../../orderq/official-voucher-core.js?v=stage7a-browser';
import { getProductSnapshot } from '../../reference-data/product-master-read-adapter.js?v=stage7a-browser';
import { sha256Hex } from '../../reference-data/change-request-contract.js?v=stage7a-browser';
import { unresolvedReviewReadAdapter } from '../../orderq/unresolved-review-read-adapter.js?v=stage7a-browser';

const text = value => String(value ?? '').trim();
const errorText = error => `${error?.name || 'Error'}:${error?.message || String(error)}`;
const companies = ['V2-STAGE7A-A', 'V2-STAGE7A-B'];
const products = companies.flatMap(companyId => [
  { companyId, productId: `${companyId}-P1`, itemCode: '0001', itemName: '상품 1', specification: '10kg', unit: 'BOX', status: 'ACTIVE', revision: 1 },
  { companyId, productId: `${companyId}-P2`, itemCode: '0002', itemName: '상품 2', specification: '20kg', unit: 'EA', status: 'ACTIVE', revision: 1 }
]);
const warehouses = [
  { warehouseId: 'STAGE7A-W1', warehouseCode: 'W1', warehouseName: '창고 1', status: 'ACTIVE', revision: 1 },
  { warehouseId: 'STAGE7A-W2', warehouseCode: 'W2', warehouseName: '창고 2', status: 'ACTIVE', revision: 1 },
  { warehouseId: 'STAGE7A-WM', warehouseCode: 'WM', warehouseName: '혼합 창고', status: 'ACTIVE', revision: 1 }
];
let ownerProductSnapshot;
let ownerCustomerSnapshot;

function row(rowId, { code = '0001', name = '상품 1', quantity = 5, unitPrice = 100, warehouseId = 'STAGE7A-W1' } = {}) {
  return {
    rowId, sourceLineKey: rowId, itemCode: code, itemName: name, specification: code === '0002' ? '20kg' : '10kg',
    unit: code === '0002' ? 'EA' : 'BOX', warehouseId,
    warehouseCode: warehouseId === 'STAGE7A-W2' ? 'W2' : warehouseId === 'STAGE7A-WM' ? 'WM' : 'W1',
    warehouseName: warehouseId === 'STAGE7A-W2' ? '창고 2' : warehouseId === 'STAGE7A-WM' ? '혼합 창고' : '창고 1',
    quantity, unitPrice, actualToBaseFactor: 1, sourceType: 'DIRECT'
  };
}

function group(kind, companyId, suffix, rows, businessDate = '2026-09-03', customerCode = '') {
  const purchase = kind === 'PURCHASE';
  return {
    companyId, voucherGroupKey: `${kind}|STAGE7A|${suffix}`, voucherDate: businessDate,
    warehouseId: rows[0].warehouseId, warehouseCode: rows[0].warehouseCode, warehouseName: rows[0].warehouseName,
    sourceDocumentKey: `V2-STAGE7A-${companyId}-${kind}-${suffix}`,
    originSystem: 'SMARTINPUT_STAGE7A_BROWSER', originTransactionId: `STAGE7A-${companyId}-${kind}-${suffix}`,
    sourceVoucherIndex: 1, rows,
    ...(purchase ? { supplierCustomerCode: customerCode, supplierCustomerName: customerCode ? '거래처 1' : '' }
      : { salesCustomerCode: customerCode, salesCustomerName: customerCode ? '거래처 1' : '',
        deliveryCustomerCode: '', billingCustomerCode: '' })
  };
}

function requestContext(companyId, suffix) {
  return {
    companyId, identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2, actor: 'USER-7A',
    originSystem: 'SMARTINPUT_STAGE7A_BROWSER', manualSessionId: `STAGE7A-${suffix}`,
    occurredAt: '2026-09-05T09:00:00+09:00'
  };
}

async function post(gateway, kind, companyId, suffix, rows, businessDate = '2026-09-03', customers = []) {
  const source = group(kind, companyId, suffix, rows, businessDate, customers[0]?.customerCode || '');
  const resolved = resolveOfficialVoucherReferencesV2({
    kind, companyId, group: source, products, customers, warehouses,
    productReferenceSnapshotId: `PRODUCT-SNAPSHOT-${companyId}`,
    customerReferenceSnapshotId: `CUSTOMER-SNAPSHOT-${companyId}`
  });
  const build = kind === 'PURCHASE' ? buildPurchasePostDraft : buildSalePostDraft;
  const draft = build(resolved, requestContext(companyId, suffix));
  await gateway.saveDraft({ kind, ...draft }, 'USER-7A');
  const result = await gateway.execute(draft.commandSource);
  return { draft, result };
}

async function all(storeName) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = await new Promise((resolve, reject) => {
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  await transactionDone(tx);
  return rows;
}

async function mutateRecord(storeName, key, mutate) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const current = await new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!current) throw new Error(`missing ${storeName}:${key}`);
  store.put(mutate(structuredClone(current)));
  await transactionDone(tx);
}

async function mutateDocumentAndLine(identity, mutateDocument, mutateLine) {
  const purchase = identity.kind === 'PURCHASE';
  const documentStore = purchase ? 'purchaseDocuments' : 'salesDocuments';
  const lineStore = purchase ? 'purchaseLines' : 'salesLines';
  const documentId = identity[purchase ? 'purchaseDocumentId' : 'salesDocumentId'];
  const db = await openOrderQDb();
  const tx = db.transaction([documentStore, lineStore], 'readwrite');
  const document = await new Promise((resolve, reject) => {
    const request = tx.objectStore(documentStore).get(documentId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const lines = await new Promise((resolve, reject) => {
    const request = tx.objectStore(lineStore).index('byDocumentId').getAll(documentId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  tx.objectStore(documentStore).put(mutateDocument(structuredClone(document)));
  lines.forEach(line => tx.objectStore(lineStore).put(mutateLine(structuredClone(line))));
  await transactionDone(tx);
}

async function counts(companyId) {
  const stores = ['purchaseDocuments', 'purchaseLines', 'salesDocuments', 'salesLines', 'officialCommands',
    'voucherRevisions', 'inventoryMovements', 'payableEntries', 'receivableEntries',
    'pendingInventoryEffects', 'unresolvedProducts', 'syncQueue'];
  return Object.fromEntries(await Promise.all(stores.map(async store => [store,
    (await all(store)).filter(item => text(item.companyId || item.payload?.companyId) === companyId).length])));
}

function refreshLineSnapshot(line) {
  const priorSnapshot = line.productSnapshot || {};
  line.productSnapshot = {
    schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2', entityType: line.entityType,
    productCode: line.productCode, productName: line.productName,
    specification: line.specification, unit: line.unit || line.actualUnit,
    quantity: line.actualQuantity, unitPrice: line.unitPrice, amount: line.totalAmount,
    amountOrigin: text(priorSnapshot.amountOrigin) || 'DERIVED_AT_CONFIRM',
    amountSourceField: text(priorSnapshot.amountSourceField),
    originalProductCode: line.originalProductCode, originalProductName: line.originalProductName,
    matchEvidence: {
      status: text(line.matchStatus || line.productIdentityStatus).toUpperCase(), source: text(line.matchSource),
      productId: text(line.productId), unresolvedProductId: text(line.unresolvedProductId),
      productMasterRevision: Number(line.productMasterRevision || 0),
      referenceSnapshotId: text(line.referenceSnapshotId || line.productSnapshotId),
      officialProductResolution: structuredClone(line.officialProductResolution)
    }
  };
  return line;
}

async function addRecord(storeName, row) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).add(structuredClone(row));
  await transactionDone(tx);
}

async function deleteRecord(storeName, key) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}

function correctionReplacement(preflight, changes = {}) {
  const target = preflight.target;
  const kind = target.kind;
  const document = structuredClone(target.currentDocument);
  const line = structuredClone(target.currentLines[0]);
  const companyId = target.companyId;
  if (changes.businessDate) {
    document.businessDate = changes.businessDate;
    document[kind === 'PURCHASE' ? 'purchaseDate' : 'saleDate'] = changes.businessDate;
    document.businessOccurredAt = `${changes.businessDate}T10:00:00+09:00`;
  }
  if (changes.warehouseId) {
    document.warehouseId = changes.warehouseId;
    line.warehouseId = changes.warehouseId;
    line.warehouseCode = changes.warehouseId === 'STAGE7A-W2' ? 'W2' : 'W1';
  }
  if (changes.quantity !== undefined) {
    line.quantity = changes.quantity;
    line.actualQuantity = changes.quantity;
    line.baseQuantity = changes.quantity;
  }
  if (changes.unitPrice !== undefined) line.unitPrice = changes.unitPrice;
  const supply = Number(line.actualQuantity) * Number(line.unitPrice);
  line.supplyAmount = changes.totalAmount ?? supply;
  line.totalAmount = changes.totalAmount ?? supply;
  line.calculatedSupplyAmount = supply;
  line.amountDifference = line.totalAmount - supply;
  document.supplyAmount = line.supplyAmount;
  document.totalAmount = line.totalAmount;
  document.calculatedSupplyAmount = line.calculatedSupplyAmount;
  document.amountDifference = line.amountDifference;
  if (changes.productCode === 'UNMATCHED-NEW') {
    const resolution = {
      companyId, status: 'UNRESOLVED_PRODUCT', reason: 'PRODUCT_CODE_UNMATCHED', inputProductCode: 'UNMATCHED-NEW',
      matchedProductCode: '', matchedProductId: '', referenceSnapshotId: ownerProductSnapshot?.snapshotId || ''
    };
    line.productId = '';
    line.unresolvedProductId = '';
    line.productCode = 'UNMATCHED-NEW';
    line.productName = '신규 미매칭';
    line.originalProductCode = 'UNMATCHED-NEW';
    line.originalProductName = '신규 미매칭';
    line.matchStatus = 'UNRESOLVED_PRODUCT';
    line.productIdentityStatus = 'UNRESOLVED_PRODUCT';
    line.matchSource = 'PRODUCT_CODE_UNMATCHED';
    line.officialProductResolution = resolution;
    line.productMasterRevision = 0;
    line.referenceSnapshotId = ownerProductSnapshot?.snapshotId || '';
    line.specification = '미확정';
    line.unit = 'EA';
    line.actualUnit = 'EA';
  } else if (changes.productCode) {
    const product = products.find(item => item.companyId === companyId && item.itemCode === changes.productCode);
    const resolution = {
      companyId, status: 'MATCHED', reason: 'EXACT_COMPANY_PRODUCT_CODE', inputProductCode: product.itemCode,
      matchedProductCode: product.itemCode, matchedProductId: product.productId,
      productMasterRevision: Number(product.revision || 0), referenceSnapshotId: ownerProductSnapshot?.snapshotId || ''
    };
    line.productId = product.productId;
    line.unresolvedProductId = '';
    line.productCode = product.itemCode;
    line.productName = product.itemName;
    line.originalProductCode = product.itemCode;
    line.originalProductName = product.itemName;
    line.specification = product.specification;
    line.unit = product.unit;
    line.actualUnit = product.unit;
    line.matchStatus = 'MATCHED';
    line.productIdentityStatus = 'MATCHED';
    line.matchSource = 'EXACT_COMPANY_PRODUCT_CODE';
    line.officialProductResolution = resolution;
    line.productMasterRevision = Number(product.revision || 0);
    line.referenceSnapshotId = ownerProductSnapshot?.snapshotId || '';
  }
  refreshLineSnapshot(line);
  if (!line.productId) {
    line.unresolvedProductId = unresolvedProductStableId(companyId, line);
    line.productSnapshot.matchEvidence.unresolvedProductId = line.unresolvedProductId;
  }
  return { document, lines: [line] };
}

function purchasePartnerReplacement(preflight, resolution, fields = {}) {
  const replacement = correctionReplacement(preflight, {});
  Object.assign(replacement.document, {
    officialPartnerResolution: resolution,
    supplierCustomerId: fields.customerId || '',
    supplierCustomerCode: fields.customerCode || resolution.inputCustomerCode || '',
    supplierCustomerName: fields.customerName || resolution.inputCustomerName || '',
    supplierCustomerRevision: Number(fields.revision || 0)
  });
  return replacement;
}

function decisionsFor(preview, actor = 'USER-7A') {
  return preview.conflicts.map((conflict, index) => ({
    deltaId: conflict.deltaId,
    decisionType: index % 2 ? 'INCLUDED_IN_CHECKPOINT' : 'NOT_INCLUDED_IN_CHECKPOINT',
    checkpointId: conflict.checkpointId,
    checkpointEffectiveAt: conflict.checkpointEffectiveAt,
    targetBusinessDate: conflict.businessDate,
    actor,
    judgedAt: `2026-09-05T10:0${index}:00+09:00`
  }));
}

async function buildRevision(gateway, identity, action, replacement, occurredAt, reason) {
  const preflight = await gateway.inspectRevisionTarget(identity);
  const preview = gateway.previewRevision({ preflight, action, replacement });
  const command = gateway.buildRevisionCommand({
    preflight, action, replacement, stocktakeDecisions: decisionsFor(preview), actor: 'USER-7A', occurredAt, reason,
    productOwnerSnapshot: ownerProductSnapshot, customerOwnerSnapshot: ownerCustomerSnapshot
  });
  return { preflight, preview, command };
}

async function rejectedInspectAndExecute(gateway, identity, command) {
  const before = await counts(identity.companyId);
  let inspectError = '';
  let executeError = '';
  try { await gateway.inspectRevisionTarget(identity); } catch (error) { inspectError = errorText(error); }
  try { await gateway.executeRevision(command); } catch (error) { executeError = errorText(error); }
  const after = await counts(identity.companyId);
  return { inspectError, executeError, writesZero: JSON.stringify(before) === JSON.stringify(after) };
}

async function forceRematchedState(posted) {
  const document = posted.result.document;
  const line = posted.result.lines[0];
  const pending = posted.result.pendingInventoryEffects[0];
  const product = products.find(item => item.companyId === document.companyId && item.itemCode === '0002');
  const movement = {
    movementId: `REMATCH-${pending.pendingEffectId}`, companyId: document.companyId,
    warehouseId: pending.warehouseId, productId: product.productId, productCode: product.itemCode,
    sourceDocumentId: pending.sourceDocumentId, sourceLineId: pending.sourceLineId,
    sourceDocumentRevision: pending.sourceDocumentRevision, sourceVoucherRevisionId: pending.voucherRevisionId,
    voucherMode: pending.voucherMode, movementType: 'PENDING_PRODUCT_MATCH_RESOLVED',
    signedQuantity: pending.signedQuantity, originalSignedQuantity: pending.signedQuantity,
    inventoryEffectFactor: 1, effectiveAt: pending.effectiveAt, businessDate: pending.effectiveAt,
    businessOccurredAt: pending.businessOccurredAt || '',
    effectStatus: pending.signedQuantity === 0 ? 'ZERO_EFFECT' : 'APPLIED_NORMAL', stocktakeEffectStatus: '',
    officialInventoryApplied: true, commandId: 'SYNTHETIC-6C-COMMAND', pendingEffectId: pending.pendingEffectId,
    resolutionId: 'SYNTHETIC-6C-RESOLUTION'
  };
  const beforeSnapshot = { pendingEffect: structuredClone(pending) };
  const afterSnapshot = { movement: structuredClone(movement) };
  const rematchRevision = {
    voucherRevisionId: `SYNTHETIC-6C-REVISION-${pending.pendingEffectId}`,
    companyId: document.companyId, voucherMode: 'inventory-rematch', documentId: pending.unresolvedProductId,
    revision: 1, commandId: movement.commandId, action: 'REMATCH', status: 'CONFIRMED',
    beforeSnapshot, afterSnapshot, beforeDigest: canonicalSha256(beforeSnapshot), afterDigest: canonicalSha256(afterSnapshot),
    effects: [{ type: 'INVENTORY', id: movement.movementId, pendingEffectId: pending.pendingEffectId,
      status: movement.effectStatus, stocktakeEffectStatus: '', officialInventoryApplied: true,
      signedQuantity: movement.signedQuantity, originalSignedQuantity: movement.originalSignedQuantity }]
  };
  const db = await openOrderQDb();
  const tx = db.transaction(['pendingInventoryEffects', 'inventoryMovements', 'unresolvedProducts', 'voucherRevisions'], 'readwrite');
  tx.objectStore('pendingInventoryEffects').put({ ...pending, productId: product.productId,
    productCode: product.itemCode, status: 'RESOLVED_TO_INVENTORY', inventoryEffectStatus: movement.effectStatus,
    resolutionId: 'SYNTHETIC-6C-RESOLUTION', resolutionCommandId: 'SYNTHETIC-6C-COMMAND' });
  tx.objectStore('inventoryMovements').add(movement);
  tx.objectStore('voucherRevisions').add(rematchRevision);
  const unresolvedStore = tx.objectStore('unresolvedProducts');
  const unresolved = await new Promise((resolve, reject) => {
    const request = unresolvedStore.get(pending.unresolvedProductId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  unresolvedStore.put({ ...unresolved, status: 'MATCHED', productId: product.productId,
    productCode: product.itemCode, resolutionId: 'SYNTHETIC-6C-RESOLUTION',
    resolutionCommandId: 'SYNTHETIC-6C-COMMAND' });
  await transactionDone(tx);
  return { document, line, pending, movement, product };
}

async function runInjectedRollbackCase(postGateway, revisionGateway, spec, index) {
  const suffix = `ROLLBACK-${String(index + 1).padStart(2, '0')}-${spec.label}`;
  const source = await post(postGateway, 'PURCHASE', companies[0], suffix,
    [row(`ROW-${suffix}`, { code: spec.sourceCode || '0001', name: spec.sourceName || '상품 1', quantity: index + 2 })]);
  const identity = { kind: 'PURCHASE', companyId: companies[0], purchaseDocumentId: source.result.document.purchaseDocumentId };
  const preflight = await revisionGateway.inspectRevisionTarget(identity);
  let action = 'CANCEL';
  let replacement = null;
  if (spec.replacementCode) {
    action = 'CORRECT';
    replacement = correctionReplacement(preflight, { productCode: spec.replacementCode, quantity: index + 3 });
  }
  const prepared = await buildRevision(revisionGateway, identity, action, replacement,
    `2026-09-06T${String(8 + index).padStart(2, '0')}:00:00+09:00`, `injected ${spec.label}`);
  const beforeCounts = await counts(companies[0]);
  const beforeAggregate = await repository.loadOfficialPurchaseAggregate(identity.purchaseDocumentId);
  const originalMethod = IDBObjectStore.prototype[spec.method];
  let injected = false;
  IDBObjectStore.prototype[spec.method] = function injectedFailure(...args) {
    if (!injected && this.name === spec.store) {
      injected = true;
      throw new DOMException(`INJECTED_${spec.label}`, 'AbortError');
    }
    return originalMethod.apply(this, args);
  };
  let error = '';
  try {
    await revisionGateway.executeRevision(prepared.command);
  } catch (caught) {
    error = errorText(caught);
  } finally {
    IDBObjectStore.prototype[spec.method] = originalMethod;
  }
  const afterCounts = await counts(companies[0]);
  const afterAggregate = await repository.loadOfficialPurchaseAggregate(identity.purchaseDocumentId);
  return {
    label: spec.label,
    store: spec.store,
    method: spec.method,
    injected,
    error,
    countsUnchanged: JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
    headUnchanged: beforeAggregate.document.revision === afterAggregate.document.revision,
    revisionCountUnchanged: beforeAggregate.revisions.length === afterAggregate.revisions.length,
    commandCommitted: afterAggregate.commands.some(item => item.commandId === prepared.command.commandId)
  };
}

export async function runStage7AOfficialRevisionScenario() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('oneapp-orderq-pre-m1-v6');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('delete blocked'));
  });
  const transactionLog = [];
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function patched(stores, mode, ...rest) {
    if (mode === 'readwrite') transactionLog.push({ stores: Array.isArray(stores) ? [...stores] : [stores], mode });
    return originalTransaction.call(this, stores, mode, ...rest);
  };
  try {
    localStorage.setItem('merchMaster_v870', JSON.stringify(products));
    localStorage.setItem('merchMaster_revision_v870', 'REV-STAGE7A-OWNER');
    ownerProductSnapshot = await getProductSnapshot({ now: '2026-09-05T08:00:00+09:00' });
    const customerData = { customers: [{ companyId: companies[0], customerId: 'CUSTOMER-OWNER-1',
      customerCode: 'C-OWNER-1', customerName: '현재 거래처', status: 'ACTIVE', qualityStatus: 'VERIFIED', revision: 3 }],
    aliases: [], sourceLinks: [] };
    ownerCustomerSnapshot = {
      schemaVersion: 'ONEAPP_CUSTOMER_SNAPSHOT_V1', adapterVersion: 'ONEAPP_CUSTOMER_READ_ADAPTER_V1',
      ownerAppId: 'customer-master', status: 'READY', snapshotId: '', snapshotVersion: 3,
      snapshotCreatedAt: '2026-09-05T08:00:00+09:00', contentHash: await sha256Hex(customerData), data: customerData
    };
    ownerCustomerSnapshot.snapshotId = `CUSTOMER-3-${ownerCustomerSnapshot.contentHash.slice(0, 12)}`;
    const postGateway = createOfficialCommandGateway(repository, { featureGates: { PURCHASE: true, SALE: true } });
    const revisionRepository = { ...repository,
      runOfficialVoucherRevisionCommand: command => repository.runOfficialVoucherRevisionCommand(command, {
        productSnapshotProvider: async () => ownerProductSnapshot,
        customerSnapshotProvider: async () => ownerCustomerSnapshot
      }) };
    const revisionGateway = createOfficialCommandGateway(revisionRepository, { revisionFeatureGates: {
      CORRECT_PURCHASE: true, CANCEL_PURCHASE: true, CORRECT_SALE: true, CANCEL_SALE: true
    } });

    const purchase = await post(postGateway, 'PURCHASE', companies[0], 'PURCHASE-CORRECT',
      [row('ROW-P-CORRECT', { quantity: 5, unitPrice: 100 })]);
    const purchaseIdentity = { kind: 'PURCHASE', companyId: companies[0], purchaseDocumentId: purchase.result.document.purchaseDocumentId };
    const originalPurchaseRevision = structuredClone(purchase.result.voucherRevision);
    const replacement = correctionReplacement(await revisionGateway.inspectRevisionTarget(purchaseIdentity), {
      productCode: '0002', warehouseId: 'STAGE7A-W2', businessDate: '2026-09-04', quantity: -3,
      unitPrice: -200, totalAmount: 600
    });
    const correction = await buildRevision(revisionGateway, purchaseIdentity, 'CORRECT', replacement,
      '2026-09-05T11:00:00+09:00', '상품·창고·일자·수량 정정');
    const corrected = await revisionGateway.executeRevision(correction.command);
    const correctedCounts = await counts(companies[0]);
    const duplicateCountsBefore = await counts(companies[0]);
    const duplicate = await revisionGateway.executeRevision(correction.command);
    const duplicateCountsAfter = await counts(companies[0]);

    const replacementContractPreflight = await revisionGateway.inspectRevisionTarget(purchaseIdentity);
    const replacementContractBefore = await counts(companies[0]);
    const replacementErrors = {};
    const expectReplacementReject = (label, mutate) => {
      const candidate = correctionReplacement(replacementContractPreflight, { quantity: 1, unitPrice: 1 });
      mutate(candidate);
      try {
        revisionGateway.previewRevision({ preflight: replacementContractPreflight, action: 'CORRECT', replacement: candidate });
      } catch (error) { replacementErrors[label] = errorText(error); }
    };
    expectReplacementReject('blankQuantity', candidate => {
      Object.assign(candidate.lines[0], { quantity: '   ', actualQuantity: '   ', baseQuantity: '   ' });
      refreshLineSnapshot(candidate.lines[0]);
    });
    expectReplacementReject('blankUnitPrice', candidate => {
      candidate.lines[0].unitPrice = '   ';
      refreshLineSnapshot(candidate.lines[0]);
    });
    expectReplacementReject('blankProduct', candidate => {
      Object.assign(candidate.lines[0], { productId: '', unresolvedProductId: '', productCode: ' ', productName: ' ',
        originalProductCode: ' ', originalProductName: ' ' });
      refreshLineSnapshot(candidate.lines[0]);
    });
    expectReplacementReject('snapshotMismatch', candidate => { candidate.lines[0].productSnapshot.quantity = 999; });
    expectReplacementReject('documentTotalMismatch', candidate => { candidate.document.totalAmount += 1; });
    const zeroReplacement = correctionReplacement(replacementContractPreflight, { quantity: 0, unitPrice: 0 });
    const zeroPreview = revisionGateway.previewRevision({ preflight: replacementContractPreflight,
      action: 'CORRECT', replacement: zeroReplacement });
    const replacementContractAfter = await counts(companies[0]);

    let staleError = '';
    try {
      const staleReplacement = correctionReplacement(correction.preflight, { quantity: 99 });
      const stale = revisionGateway.buildRevisionCommand({
        preflight: correction.preflight, action: 'CORRECT', replacement: staleReplacement,
        stocktakeDecisions: [], actor: 'USER-7A', occurredAt: '2026-09-05T11:01:00+09:00', reason: 'stale'
      });
      await revisionGateway.executeRevision(stale);
    } catch (error) { staleError = errorText(error); }

    const sale = await post(postGateway, 'SALE', companies[0], 'SALE-CANCEL',
      [row('ROW-S-CANCEL', { quantity: 0, unitPrice: 0 })]);
    const saleIdentity = { kind: 'SALE', companyId: companies[0], salesDocumentId: sale.result.document.salesDocumentId };
    const saleCancel = await buildRevision(revisionGateway, saleIdentity, 'CANCEL', null,
      '2026-09-05T12:00:00+09:00', '판매 취소');
    const cancelled = await revisionGateway.executeRevision(saleCancel.command);
    let alreadyCancelled = '';
    try { await revisionGateway.inspectRevisionTarget(saleIdentity); } catch (error) { alreadyCancelled = errorText(error); }

    const mixedSale = await post(postGateway, 'SALE', companies[0], 'SALE-MIXED-STOCKTAKE', [
      row('ROW-S-MIXED-1', { code: '0001', name: '상품 1', quantity: 6, warehouseId: 'STAGE7A-WM' }),
      row('ROW-S-MIXED-2', { code: '0002', name: '상품 2', quantity: 4, warehouseId: 'STAGE7A-WM' })
    ], '2026-09-03');
    await repository.recordInventoryCheckpoint({
      checkpointId: 'STAGE7A-MIXED-CHECKPOINT', companyId: companies[0], warehouseId: 'STAGE7A-WM',
      sessionId: 'STAGE7A-MIXED-SESSION', effectiveAt: '2026-09-04', coversAllProducts: true,
      counts: [{ productId: `${companies[0]}-P1`, productCode: '0001', quantity: 100 },
        { productId: `${companies[0]}-P2`, productCode: '0002', quantity: 100 }],
      actor: 'STOCKTAKE-7A', confirmedAt: '2026-09-04T18:00:00+09:00'
    });
    const mixedIdentity = { kind: 'SALE', companyId: companies[0], salesDocumentId: mixedSale.result.document.salesDocumentId };
    const mixedPreflight = await revisionGateway.inspectRevisionTarget(mixedIdentity);
    const mixedPreview = revisionGateway.previewRevision({ preflight: mixedPreflight, action: 'CANCEL' });
    const beforeMiddleCancel = await counts(companies[0]);
    const middleCancel = await revisionGateway.executeRevision({ cancelled: true });
    const afterMiddleCancel = await counts(companies[0]);
    const mixedCommand = revisionGateway.buildRevisionCommand({
      preflight: mixedPreflight, action: 'CANCEL', stocktakeDecisions: decisionsFor(mixedPreview),
      actor: 'USER-7A', occurredAt: '2026-09-05T12:30:00+09:00', reason: '혼합 실사 판매 취소'
    });
    const mixedResult = await revisionGateway.executeRevision(mixedCommand);

    const unresolved = await post(postGateway, 'PURCHASE', companies[0], 'UNRESOLVED-TO-MATCHED',
      [row('ROW-U-M', { code: 'UNMATCHED-OLD', name: '미매칭', quantity: -4 })]);
    const unresolvedIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: unresolved.result.document.purchaseDocumentId };
    const unresolvedPreflight = await revisionGateway.inspectRevisionTarget(unresolvedIdentity);
    const resolvedReplacement = correctionReplacement(unresolvedPreflight, { productCode: '0002', quantity: -4 });
    const unresolvedCorrection = await buildRevision(revisionGateway, unresolvedIdentity, 'CORRECT', resolvedReplacement,
      '2026-09-05T13:00:00+09:00', '미매칭을 정확상품으로 정정');
    const unresolvedResult = await revisionGateway.executeRevision(unresolvedCorrection.command);

    const matched = await post(postGateway, 'PURCHASE', companies[0], 'MATCHED-TO-UNRESOLVED',
      [row('ROW-M-U', { quantity: 2 })]);
    const matchedIdentity = { kind: 'PURCHASE', companyId: companies[0], purchaseDocumentId: matched.result.document.purchaseDocumentId };
    const matchedPreflight = await revisionGateway.inspectRevisionTarget(matchedIdentity);
    const unmatchedReplacement = correctionReplacement(matchedPreflight, { productCode: 'UNMATCHED-NEW', quantity: 2 });
    const matchedCorrection = await buildRevision(revisionGateway, matchedIdentity, 'CORRECT', unmatchedReplacement,
      '2026-09-05T14:00:00+09:00', '정확상품을 미매칭으로 정정');
    const matchedResult = await revisionGateway.executeRevision(matchedCorrection.command);
    const matchedUnresolvedReinspection = await revisionGateway.inspectRevisionTarget(matchedIdentity);

    const rematchSource = await post(postGateway, 'PURCHASE', companies[0], 'REMATCHED-CORRECT',
      [row('ROW-REMATCH', { code: 'UNMATCHED-REMATCH', name: '재매칭 원문', quantity: 7 })]);
    await forceRematchedState(rematchSource);
    const rematchIdentity = { kind: 'PURCHASE', companyId: companies[0], purchaseDocumentId: rematchSource.result.document.purchaseDocumentId };
    const rematchPreflight = await revisionGateway.inspectRevisionTarget(rematchIdentity);
    const rematchReplacement = correctionReplacement(rematchPreflight, { productCode: '0002', quantity: 3 });
    const rematchCorrection = await buildRevision(revisionGateway, rematchIdentity, 'CORRECT', rematchReplacement,
      '2026-09-05T15:00:00+09:00', '재매칭 완료 행 수량 정정');
    const rematchResult = await revisionGateway.executeRevision(rematchCorrection.command);

    const chainedSource = await post(postGateway, 'PURCHASE', companies[0], 'CHAINED-REVISION',
      [row('ROW-CHAINED', { quantity: 4, unitPrice: 25 })]);
    const chainedIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: chainedSource.result.document.purchaseDocumentId };
    const chainedFirstPreflight = await revisionGateway.inspectRevisionTarget(chainedIdentity);
    const chainedFirst = await buildRevision(revisionGateway, chainedIdentity, 'CORRECT',
      correctionReplacement(chainedFirstPreflight, { quantity: 5, unitPrice: 25 }),
      '2026-09-05T15:10:00+09:00', '연속 정정 1');
    await revisionGateway.executeRevision(chainedFirst.command);
    const afterFirstAggregate = await repository.loadOfficialPurchaseAggregate(chainedIdentity.purchaseDocumentId);
    const firstRevisionSnapshot = structuredClone(afterFirstAggregate.revisions.find(item => item.revision === 3));
    const chainedSecondPreflight = await revisionGateway.inspectRevisionTarget(chainedIdentity);
    const chainedSecond = await buildRevision(revisionGateway, chainedIdentity, 'CORRECT',
      correctionReplacement(chainedSecondPreflight, { quantity: 5, unitPrice: -1, totalAmount: -5 }),
      '2026-09-05T15:20:00+09:00', '연속 가격 정정');
    const chainedSecondResult = await revisionGateway.executeRevision(chainedSecond.command);
    const afterSecondAggregate = await repository.loadOfficialPurchaseAggregate(chainedIdentity.purchaseDocumentId);

    const fakeProductSource = await post(postGateway, 'PURCHASE', companies[0], 'FAKE-PRODUCT-REFERENCE',
      [row('ROW-FAKE-PRODUCT', { quantity: 2 })]);
    const fakeProductIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: fakeProductSource.result.document.purchaseDocumentId };
    const fakeProductPreflight = await revisionGateway.inspectRevisionTarget(fakeProductIdentity);
    const fakeProductReplacement = correctionReplacement(fakeProductPreflight, { productCode: '0002', quantity: 2 });
    const fakeProductData = { products: [{ companyId: companies[0], productId: 'PRODUCT-FABRICATED',
      itemCode: '0002', itemName: '조작 상품', specification: '조작 규격', unit: 'FAKE', status: 'ACTIVE', revision: 99 }] };
    const fakeProductSnapshot = { schemaVersion: 'ONEAPP_PRODUCT_SNAPSHOT_V1', status: 'READY',
      snapshotId: '', revision: 'FAKE-99', snapshotVersion: 'FAKE-99',
      contentHash: await sha256Hex(fakeProductData), data: fakeProductData };
    fakeProductSnapshot.snapshotId = `PRODUCT-FAKE-${fakeProductSnapshot.contentHash.slice(0, 12)}`;
    const fabricatedResolution = { companyId: companies[0], status: 'MATCHED', reason: 'EXACT_COMPANY_PRODUCT_CODE',
      inputProductCode: '0002', matchedProductCode: '0002', matchedProductId: 'PRODUCT-FABRICATED',
      productMasterRevision: 99, referenceSnapshotId: fakeProductSnapshot.snapshotId };
    Object.assign(fakeProductReplacement.lines[0], {
      productId: 'PRODUCT-FABRICATED', productName: '조작 상품', specification: '조작 규격',
      unit: 'FAKE', actualUnit: 'FAKE', officialProductResolution: fabricatedResolution,
      productMasterRevision: 99, referenceSnapshotId: fakeProductSnapshot.snapshotId
    });
    refreshLineSnapshot(fakeProductReplacement.lines[0]);
    const fakeProductPreview = revisionGateway.previewRevision({ preflight: fakeProductPreflight,
      action: 'CORRECT', replacement: fakeProductReplacement });
    const fakeProductCommand = revisionGateway.buildRevisionCommand({ preflight: fakeProductPreflight,
      action: 'CORRECT', replacement: fakeProductReplacement, stocktakeDecisions: decisionsFor(fakeProductPreview),
      actor: 'USER-7A', occurredAt: '2026-09-05T15:25:00+09:00', reason: '조작 상품 증거',
      productOwnerSnapshot: fakeProductSnapshot, customerOwnerSnapshot: ownerCustomerSnapshot });
    const fakeProductBefore = await counts(companies[0]);
    let fakeProductError = '';
    try { await revisionGateway.executeRevision(fakeProductCommand); } catch (error) { fakeProductError = errorText(error); }
    const fakeProductAfter = await counts(companies[0]);

    const falseUnresolvedProductReplacement = correctionReplacement(fakeProductPreflight, { productCode: '0002', quantity: 2 });
    const falseUnresolvedProductResolution = {
      companyId: companies[0], status: 'UNRESOLVED_PRODUCT', reason: 'PRODUCT_CODE_UNMATCHED',
      inputProductCode: '0002', matchedProductCode: '', matchedProductId: '', productMasterRevision: 0,
      referenceSnapshotId: ownerProductSnapshot.snapshotId
    };
    Object.assign(falseUnresolvedProductReplacement.lines[0], { productId: '', unresolvedProductId: '',
      matchStatus: 'UNRESOLVED_PRODUCT', productIdentityStatus: 'UNRESOLVED_PRODUCT',
      matchSource: 'PRODUCT_CODE_UNMATCHED', productMasterRevision: 0,
      officialProductResolution: falseUnresolvedProductResolution });
    falseUnresolvedProductReplacement.lines[0].unresolvedProductId = unresolvedProductStableId(companies[0],
      falseUnresolvedProductReplacement.lines[0]);
    refreshLineSnapshot(falseUnresolvedProductReplacement.lines[0]);
    let falseUnresolvedProductError = '';
    const falseUnresolvedProductBefore = await counts(companies[0]);
    try {
      const preview = revisionGateway.previewRevision({ preflight: fakeProductPreflight, action: 'CORRECT',
        replacement: falseUnresolvedProductReplacement });
      revisionGateway.buildRevisionCommand({ preflight: fakeProductPreflight, action: 'CORRECT',
        replacement: falseUnresolvedProductReplacement, stocktakeDecisions: decisionsFor(preview), actor: 'USER-7A',
        occurredAt: '2026-09-05T15:25:30+09:00', reason: '상품 거짓 미매칭',
        productOwnerSnapshot: ownerProductSnapshot, customerOwnerSnapshot: ownerCustomerSnapshot });
    } catch (error) { falseUnresolvedProductError = errorText(error); }
    const arbitraryNameReplacement = correctionReplacement(fakeProductPreflight, { productCode: 'UNMATCHED-NEW', quantity: 2 });
    const nameOnlyResolution = { ...arbitraryNameReplacement.lines[0].officialProductResolution,
      reason: 'PRODUCT_CODE_NOT_PROVIDED', inputProductCode: '', referenceSnapshotId: '' };
    Object.assign(arbitraryNameReplacement.lines[0], { productCode: '', originalProductCode: '',
      productName: '품명 전용 상품', originalProductName: '품명 전용 상품',
      unresolvedProductId: 'UP-ARBITRARY-COLLISION', officialProductResolution: nameOnlyResolution,
      referenceSnapshotId: '' });
    refreshLineSnapshot(arbitraryNameReplacement.lines[0]);
    let arbitraryUnresolvedIdError = '';
    try { revisionGateway.previewRevision({ preflight: fakeProductPreflight, action: 'CORRECT',
      replacement: arbitraryNameReplacement }); } catch (error) { arbitraryUnresolvedIdError = errorText(error); }
    const falseUnresolvedProductAfter = await counts(companies[0]);

    const unchangedSource = await post(postGateway, 'PURCHASE', companies[0], 'UNCHANGED-DELETED-MASTER',
      [row('ROW-UNCHANGED-MASTER', { quantity: 2 })]);
    const unchangedIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: unchangedSource.result.document.purchaseDocumentId };
    const unchangedPreflight = await revisionGateway.inspectRevisionTarget(unchangedIdentity);
    const unchangedPrepared = await buildRevision(revisionGateway, unchangedIdentity, 'CORRECT',
      correctionReplacement(unchangedPreflight, { quantity: 3 }),
      '2026-09-05T15:26:00+09:00', '기존 identity 수량만 정정');
    let deletedMasterProviderCalls = 0;
    const unchangedRepository = { ...repository,
      runOfficialVoucherRevisionCommand: command => repository.runOfficialVoucherRevisionCommand(command, {
        productSnapshotProvider: async () => { deletedMasterProviderCalls += 1; throw new Error('MASTER_DELETED'); },
        customerSnapshotProvider: async () => { throw new Error('CUSTOMER_MASTER_DELETED'); }
      }) };
    const unchangedGateway = createOfficialCommandGateway(unchangedRepository, { revisionFeatureGates: { CORRECT_PURCHASE: true } });
    const unchangedResult = await unchangedGateway.executeRevision(unchangedPrepared.command);

    const partnerSource = await post(postGateway, 'PURCHASE', companies[0], 'PARTNER-REFERENCE',
      [row('ROW-PARTNER-REFERENCE', { quantity: 1 })]);
    const partnerIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: partnerSource.result.document.purchaseDocumentId };
    const partnerPreflight = await revisionGateway.inspectRevisionTarget(partnerIdentity);
    const matchedPartnerResolution = { status: 'MATCHED', reason: 'EXACT_COMPANY_CUSTOMER_CODE',
      companyId: companies[0], partnerRole: 'SUPPLIER', inputCustomerCode: 'C-OWNER-1',
      inputCustomerName: '현재 거래처', matchedCustomerCode: 'C-OWNER-1', matchedCustomerName: '현재 거래처',
      matchedCustomerId: 'CUSTOMER-OWNER-1', customerMasterRevision: 3,
      referenceSnapshotId: ownerCustomerSnapshot.snapshotId };
    const matchedPartnerReplacement = purchasePartnerReplacement(partnerPreflight, matchedPartnerResolution,
      { customerId: 'CUSTOMER-OWNER-1', customerCode: 'C-OWNER-1', customerName: '현재 거래처', revision: 3 });
    const matchedPartnerBefore = await counts(companies[0]);
    let matchedPartnerUnsupported = '';
    try {
      const partnerPreview = revisionGateway.previewRevision({ preflight: partnerPreflight, action: 'CORRECT',
        replacement: matchedPartnerReplacement });
      const matchedPartnerCommand = revisionGateway.buildRevisionCommand({ preflight: partnerPreflight, action: 'CORRECT',
        replacement: matchedPartnerReplacement, stocktakeDecisions: decisionsFor(partnerPreview), actor: 'USER-7A',
        occurredAt: '2026-09-05T15:27:00+09:00', reason: '새 매칭 거래처 차단',
        productOwnerSnapshot: ownerProductSnapshot, customerOwnerSnapshot: ownerCustomerSnapshot });
      await revisionGateway.executeRevision(matchedPartnerCommand);
    } catch (error) { matchedPartnerUnsupported = errorText(error); }
    const matchedPartnerAfter = await counts(companies[0]);
    const fakeCustomerData = { customers: [], aliases: [], sourceLinks: [] };
    const fakeCustomerSnapshot = { schemaVersion: 'ONEAPP_CUSTOMER_SNAPSHOT_V1', status: 'EMPTY',
      snapshotId: '', snapshotVersion: 0, contentHash: await sha256Hex(fakeCustomerData), data: fakeCustomerData };
    fakeCustomerSnapshot.snapshotId = `CUSTOMER-FAKE-${fakeCustomerSnapshot.contentHash.slice(0, 12)}`;
    const falseUnresolvedResolution = { status: 'UNRESOLVED_CUSTOMER', reason: 'CUSTOMER_CODE_UNMATCHED',
      companyId: companies[0], partnerRole: 'SUPPLIER', inputCustomerCode: 'C-OWNER-1', inputCustomerName: '현재 거래처',
      matchedCustomerCode: '', matchedCustomerName: '', matchedCustomerId: '', customerMasterRevision: 0,
      referenceSnapshotId: fakeCustomerSnapshot.snapshotId };
    const falseUnresolvedReplacement = purchasePartnerReplacement(partnerPreflight, falseUnresolvedResolution,
      { customerCode: 'C-OWNER-1', customerName: '현재 거래처' });
    const falseUnresolvedPreview = revisionGateway.previewRevision({ preflight: partnerPreflight, action: 'CORRECT',
      replacement: falseUnresolvedReplacement });
    const falseUnresolvedCommand = revisionGateway.buildRevisionCommand({ preflight: partnerPreflight,
      action: 'CORRECT', replacement: falseUnresolvedReplacement, stocktakeDecisions: decisionsFor(falseUnresolvedPreview),
      actor: 'USER-7A', occurredAt: '2026-09-05T15:28:00+09:00', reason: '거래처 거짓 미매칭',
      productOwnerSnapshot: ownerProductSnapshot, customerOwnerSnapshot: fakeCustomerSnapshot });
    const falsePartnerBefore = await counts(companies[0]);
    let falseUnresolvedError = '';
    try { await revisionGateway.executeRevision(falseUnresolvedCommand); } catch (error) { falseUnresolvedError = errorText(error); }
    const falsePartnerAfter = await counts(companies[0]);
    const actualOwnerFalseResolution = { ...falseUnresolvedResolution,
      referenceSnapshotId: ownerCustomerSnapshot.snapshotId };
    const actualOwnerFalseReplacement = purchasePartnerReplacement(partnerPreflight, actualOwnerFalseResolution,
      { customerCode: 'C-OWNER-1', customerName: '현재 거래처' });
    let actualOwnerFalseUnresolvedError = '';
    const actualOwnerFalseBefore = await counts(companies[0]);
    try {
      const preview = revisionGateway.previewRevision({ preflight: partnerPreflight, action: 'CORRECT',
        replacement: actualOwnerFalseReplacement });
      revisionGateway.buildRevisionCommand({ preflight: partnerPreflight, action: 'CORRECT',
        replacement: actualOwnerFalseReplacement, stocktakeDecisions: decisionsFor(preview), actor: 'USER-7A',
        occurredAt: '2026-09-05T15:28:30+09:00', reason: '실제 owner 거래처 거짓 미매칭',
        productOwnerSnapshot: ownerProductSnapshot, customerOwnerSnapshot: ownerCustomerSnapshot });
    } catch (error) { actualOwnerFalseUnresolvedError = errorText(error); }
    const actualOwnerFalseAfter = await counts(companies[0]);

    const companyB = await post(postGateway, 'PURCHASE', companies[1], 'COMPANY-B',
      [row('ROW-B', { quantity: 8 })]);
    let crossCompany = '';
    try {
      await revisionGateway.inspectRevisionTarget({ kind: 'PURCHASE', companyId: companies[0],
        purchaseDocumentId: companyB.result.document.purchaseDocumentId });
    } catch (error) { crossCompany = errorText(error); }

    const headStatusSource = await post(postGateway, 'PURCHASE', companies[0], 'HEAD-STATUS-CONTRADICTION',
      [row('ROW-HEAD-STATUS', { quantity: 2 })]);
    const headStatusIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: headStatusSource.result.document.purchaseDocumentId };
    await mutateRecord('purchaseDocuments', headStatusIdentity.purchaseDocumentId,
      document => ({ ...document, businessStatus: 'CANCELLED' }));
    const headStatusBefore = await counts(companies[0]);
    let headStatusError = '';
    try { await revisionGateway.inspectRevisionTarget(headStatusIdentity); } catch (error) { headStatusError = errorText(error); }
    const headStatusAfter = await counts(companies[0]);

    const headMultiSource = await post(postGateway, 'PURCHASE', companies[0], 'HEAD-MULTI-TAMPER',
      [row('ROW-HEAD-MULTI', { quantity: 3 })]);
    const headMultiIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: headMultiSource.result.document.purchaseDocumentId };
    await mutateDocumentAndLine(headMultiIdentity,
      document => ({ ...document, businessDate: '2026-09-02', purchaseDate: '2026-09-02',
        warehouseId: 'STAGE7A-W2', totalAmount: Number(document.totalAmount) + 1,
        supplierCustomerCode: 'TAMPERED' }),
      line => ({ ...line, productName: '조작 품명',
        productSnapshot: { ...line.productSnapshot, productName: '조작 품명' } }));
    const headMultiBefore = await counts(companies[0]);
    let headMultiError = '';
    try { await revisionGateway.inspectRevisionTarget(headMultiIdentity); } catch (error) { headMultiError = errorText(error); }
    const headMultiAfter = await counts(companies[0]);

    await mutateRecord('purchaseLines', unchangedResult.lines[0].purchaseLineId,
      line => ({ ...line, productName: 'FULL-SNAPSHOT-TAMPER', commandId: 'FULL-SNAPSHOT-TAMPER' }));
    const fullHeadBefore = await counts(companies[0]);
    let fullHeadError = '';
    try { await revisionGateway.inspectRevisionTarget(unchangedIdentity); } catch (error) { fullHeadError = errorText(error); }
    const fullHeadAfter = await counts(companies[0]);

    const sourceEffectSource = await post(postGateway, 'PURCHASE', companies[0], 'SOURCE-EFFECT-TAMPER',
      [row('ROW-SOURCE-EFFECT', { quantity: 5 })]);
    const sourceEffectIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: sourceEffectSource.result.document.purchaseDocumentId };
    const sourceMovement = (await all('inventoryMovements')).find(item => item.sourceDocumentId === sourceEffectIdentity.purchaseDocumentId);
    await mutateRecord('inventoryMovements', sourceMovement.movementId, movement => ({
      ...movement, productId: `${companies[0]}-P2`, productCode: '0002', warehouseId: 'STAGE7A-W2',
      effectiveAt: '2026-09-02', businessDate: '2026-09-02', sourceDocumentRevision: 999,
      commandId: 'TAMPERED-EFFECT-COMMAND', effectStatus: 'APPLIED_AS_LATE_ADJUSTMENT',
      signedQuantity: 5, originalSignedQuantity: 4
    }));
    const sourceEffectBefore = await counts(companies[0]);
    let sourceEffectError = '';
    try { await revisionGateway.inspectRevisionTarget(sourceEffectIdentity); } catch (error) { sourceEffectError = errorText(error); }
    const sourceEffectAfter = await counts(companies[0]);
    await mutateRecord('inventoryMovements', sourceMovement.movementId,
      movement => ({ ...movement, commandId: sourceMovement.commandId }));
    let sourceEffectIdentityError = '';
    try { await revisionGateway.inspectRevisionTarget(sourceEffectIdentity); } catch (error) {
      sourceEffectIdentityError = errorText(error);
    }

    const movementAttackResults = {};
    for (const attack of ['businessOccurredAt', 'hiddenReversal', 'extraActive', 'revisionMembership']) {
      const source = await post(postGateway, 'PURCHASE', companies[0], `MOVEMENT-${attack}`,
        [row(`ROW-MOVEMENT-${attack}`, { quantity: 5 })]);
      const identity = { kind: 'PURCHASE', companyId: companies[0],
        purchaseDocumentId: source.result.document.purchaseDocumentId };
      const movement = source.result.inventoryMovements[0];
      const revision = source.result.voucherRevision;
      if (attack === 'businessOccurredAt') {
        await mutateRecord('inventoryMovements', movement.movementId,
          current => ({ ...current, businessOccurredAt: '2026-09-03T23:59:59+09:00' }));
      } else if (attack === 'revisionMembership') {
        await mutateRecord('voucherRevisions', revision.voucherRevisionId,
          current => ({ ...current, effects: current.effects.filter(effect => effect.id !== movement.movementId) }));
      } else {
        const added = attack === 'extraActive'
          ? { ...structuredClone(movement), movementId: `${movement.movementId}-EXTRA` }
          : { ...structuredClone(movement), movementId: `${movement.movementId}-HIDDEN-REVERSAL`,
            movementType: 'OFFICIAL_REVISION_REVERSAL', effectRole: 'REVISION_REVERSAL',
            reversalOfMovementId: movement.movementId, signedQuantity: -movement.signedQuantity,
            originalSignedQuantity: -movement.originalSignedQuantity,
            reversesOriginalSignedQuantity: movement.originalSignedQuantity,
            effectStatus: 'REVERSED', reversalStatus: 'REVERSED' };
        await addRecord('inventoryMovements', added);
        await mutateRecord('voucherRevisions', revision.voucherRevisionId, current => ({ ...current,
          effects: [...current.effects, { type: 'INVENTORY', id: added.movementId, status: added.effectStatus,
            reversalStatus: added.reversalStatus || '', stocktakeEffectStatus: added.stocktakeEffectStatus || '',
            officialInventoryApplied: added.officialInventoryApplied, effectRole: added.effectRole,
            signedQuantity: added.signedQuantity, originalSignedQuantity: added.originalSignedQuantity }] }));
      }
      const before = await counts(companies[0]);
      let error = '';
      try { await revisionGateway.inspectRevisionTarget(identity); } catch (caught) { error = errorText(caught); }
      const after = await counts(companies[0]);
      movementAttackResults[attack] = { error, writesZero: JSON.stringify(before) === JSON.stringify(after) };
    }

    const pendingLinkAttackResults = {};
    for (const attack of ['missing', 'duplicate', 'tampered']) {
      const source = await post(postGateway, 'PURCHASE', companies[0], `PENDING-LINK-${attack}`,
        [row(`ROW-PENDING-LINK-${attack}`, { code: `UNMATCHED-LINK-${attack}`, name: `링크 ${attack}`, quantity: 2 })]);
      const identity = { kind: 'PURCHASE', companyId: companies[0],
        purchaseDocumentId: source.result.document.purchaseDocumentId };
      const pending = source.result.pendingInventoryEffects[0];
      await mutateRecord('unresolvedProducts', pending.unresolvedProductId, current => {
        const links = structuredClone(current.reviewLinks || []);
        const index = links.findIndex(link => link.pendingEffectId === pending.pendingEffectId);
        if (attack === 'missing') links.splice(index, 1);
        if (attack === 'duplicate') links.push(structuredClone(links[index]));
        if (attack === 'tampered') links[index] = { ...links[index], warehouseId: 'STAGE7A-W2',
          businessOccurredAt: '2026-09-03T23:59:59+09:00', signedQuantity: 999 };
        return { ...current, reviewLinks: links };
      });
      const before = await counts(companies[0]);
      let error = '';
      try { await revisionGateway.inspectRevisionTarget(identity); } catch (caught) { error = errorText(caught); }
      const after = await counts(companies[0]);
      pendingLinkAttackResults[attack] = { error, writesZero: JSON.stringify(before) === JSON.stringify(after) };
    }

    const activeSetCoverage = {};
    const removedMovementSource = await post(postGateway, 'PURCHASE', companies[0], 'COVERAGE-REMOVED-MOVEMENT', [
      row('ROW-COVERAGE-MOVEMENT-KEEP', { quantity: 2 }),
      row('ROW-COVERAGE-MOVEMENT-REMOVE', { quantity: 4 })
    ]);
    const removedMovementIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: removedMovementSource.result.document.purchaseDocumentId };
    const removedMovementPreflight = await revisionGateway.inspectRevisionTarget(removedMovementIdentity);
    const removedMovementCorrection = await buildRevision(revisionGateway, removedMovementIdentity, 'CORRECT',
      correctionReplacement(removedMovementPreflight, { quantity: 2 }),
      '2026-09-05T15:20:00+09:00', '과거 matched 행 정상 제거');
    const removedMovementResult = await revisionGateway.executeRevision(removedMovementCorrection.command);
    const removedMovementNext = await buildRevision(revisionGateway, removedMovementIdentity, 'CANCEL', null,
      '2026-09-05T15:21:00+09:00', '고아 movement 거부 검사');
    const removedMovementLineId = removedMovementSource.result.lines[1].purchaseLineId;
    const removedMovementAggregate = await repository.loadOfficialPurchaseAggregate(removedMovementIdentity.purchaseDocumentId);
    const removedMovementReversal = removedMovementAggregate.inventoryMovements.find(item =>
      item.effectRole === 'REVISION_REVERSAL' && item.sourceLineId === removedMovementLineId);
    if (!removedMovementReversal) throw new Error('removed movement reversal missing before attack');
    await deleteRecord('inventoryMovements', removedMovementReversal.movementId);
    activeSetCoverage.removedMovementReversal = {
      normalRevision: removedMovementResult.document.revision,
      ...(await rejectedInspectAndExecute(revisionGateway, removedMovementIdentity, removedMovementNext.command))
    };

    const removedPendingSource = await post(postGateway, 'PURCHASE', companies[0], 'COVERAGE-REMOVED-PENDING', [
      row('ROW-COVERAGE-PENDING-KEEP', { quantity: 2 }),
      row('ROW-COVERAGE-PENDING-REMOVE', { code: 'UNMATCHED-COVERAGE-REMOVE', name: '제거 미매칭', quantity: 4 })
    ]);
    const removedPendingIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: removedPendingSource.result.document.purchaseDocumentId };
    const removedPendingPreflight = await revisionGateway.inspectRevisionTarget(removedPendingIdentity);
    const removedPendingCorrection = await buildRevision(revisionGateway, removedPendingIdentity, 'CORRECT',
      correctionReplacement(removedPendingPreflight, { quantity: 2 }),
      '2026-09-05T15:22:00+09:00', '과거 pending 행 정상 제거');
    const removedPendingResult = await revisionGateway.executeRevision(removedPendingCorrection.command);
    const removedPendingNext = await buildRevision(revisionGateway, removedPendingIdentity, 'CANCEL', null,
      '2026-09-05T15:23:00+09:00', '고아 pending 거부 검사');
    const removedPendingLineId = removedPendingSource.result.lines[1].purchaseLineId;
    const removedPendingAggregate = await repository.loadOfficialPurchaseAggregate(removedPendingIdentity.purchaseDocumentId);
    const removedPending = removedPendingAggregate.pendingInventoryEffects.find(item =>
      item.sourceLineId === removedPendingLineId && item.status !== 'PENDING_PRODUCT_MATCH');
    if (!removedPending) throw new Error('removed pending supersession missing before attack');
    await mutateRecord('pendingInventoryEffects', removedPending.pendingEffectId,
      current => ({ ...current, status: 'PENDING_PRODUCT_MATCH' }));
    activeSetCoverage.removedPending = {
      normalRevision: removedPendingResult.document.revision,
      ...(await rejectedInspectAndExecute(revisionGateway, removedPendingIdentity, removedPendingNext.command))
    };

    const extraMovementSource = await post(postGateway, 'PURCHASE', companies[0], 'COVERAGE-EXTRA-MOVEMENT',
      [row('ROW-COVERAGE-EXTRA-MOVEMENT', { quantity: 5 })]);
    const extraMovementIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: extraMovementSource.result.document.purchaseDocumentId };
    const extraMovementNext = await buildRevision(revisionGateway, extraMovementIdentity, 'CANCEL', null,
      '2026-09-05T15:24:00+09:00', '추가 active movement 거부 검사');
    const extraMovement = { ...structuredClone(extraMovementSource.result.inventoryMovements[0]),
      movementId: `${extraMovementSource.result.inventoryMovements[0].movementId}-ORPHAN`,
      sourceLineId: 'ORPHAN-LINE-NOT-IN-HEAD' };
    await addRecord('inventoryMovements', extraMovement);
    await mutateRecord('voucherRevisions', extraMovementSource.result.voucherRevision.voucherRevisionId,
      current => ({ ...current, effects: [...current.effects, {
        type: 'INVENTORY', id: extraMovement.movementId, status: extraMovement.effectStatus,
        officialInventoryApplied: extraMovement.officialInventoryApplied, effectRole: extraMovement.effectRole,
        stocktakeEffectStatus: extraMovement.stocktakeEffectStatus || ''
      }] }));
    activeSetCoverage.extraMovement = await rejectedInspectAndExecute(
      revisionGateway, extraMovementIdentity, extraMovementNext.command);

    const extraPendingSource = await post(postGateway, 'PURCHASE', companies[0], 'COVERAGE-EXTRA-PENDING',
      [row('ROW-COVERAGE-EXTRA-PENDING', { quantity: 5 })]);
    const extraPendingIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: extraPendingSource.result.document.purchaseDocumentId };
    const extraPendingNext = await buildRevision(revisionGateway, extraPendingIdentity, 'CANCEL', null,
      '2026-09-05T15:25:00+09:00', '추가 active pending 거부 검사');
    await addRecord('pendingInventoryEffects', {
      pendingEffectId: `ORPHAN-PENDING-${extraPendingIdentity.purchaseDocumentId}`,
      companyId: companies[0], voucherMode: 'purchase',
      sourceDocumentId: extraPendingIdentity.purchaseDocumentId, sourceLineId: 'ORPHAN-LINE-NOT-IN-HEAD',
      sourceDocumentRevision: 2, status: 'PENDING_PRODUCT_MATCH', inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
      officialInventoryApplied: false
    });
    activeSetCoverage.extraPending = await rejectedInspectAndExecute(
      revisionGateway, extraPendingIdentity, extraPendingNext.command);

    const abbreviatedMemberSource = await post(postGateway, 'PURCHASE', companies[0], 'ABBREVIATED-EFFECT-MEMBER',
      [row('ROW-ABBREVIATED-EFFECT-MEMBER', { quantity: 5 })]);
    const abbreviatedMemberIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: abbreviatedMemberSource.result.document.purchaseDocumentId };
    const abbreviatedMemberNext = await buildRevision(revisionGateway, abbreviatedMemberIdentity, 'CANCEL', null,
      '2026-09-05T15:26:00+09:00', '축약 membership 거부 검사');
    const abbreviatedMovementId = abbreviatedMemberSource.result.inventoryMovements[0].movementId;
    await mutateRecord('voucherRevisions', abbreviatedMemberSource.result.voucherRevision.voucherRevisionId,
      current => ({ ...current, effects: current.effects.map(effect => effect.id === abbreviatedMovementId
        ? { id: effect.id } : effect) }));
    activeSetCoverage.abbreviatedMembership = await rejectedInspectAndExecute(
      revisionGateway, abbreviatedMemberIdentity, abbreviatedMemberNext.command);

    const multiUnresolvedA = await post(postGateway, 'PURCHASE', companies[0], 'MULTI-UNRESOLVED-A',
      [row('ROW-MULTI-A', { code: 'UNMATCHED-MULTI', name: '다중 미매칭', quantity: 2 })]);
    const multiUnresolvedB = await post(postGateway, 'PURCHASE', companies[0], 'MULTI-UNRESOLVED-B',
      [row('ROW-MULTI-B', { code: 'UNMATCHED-MULTI', name: '다중 미매칭', quantity: 3 })]);
    const multiId = multiUnresolvedA.result.lines[0].unresolvedProductId;
    if (multiId !== multiUnresolvedB.result.lines[0].unresolvedProductId) throw new Error('multi unresolved identity mismatch');
    const multiIdentityA = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: multiUnresolvedA.result.document.purchaseDocumentId };
    const multiPreflightA = await revisionGateway.inspectRevisionTarget(multiIdentityA);
    const multiCorrection = await buildRevision(revisionGateway, multiIdentityA, 'CORRECT',
      correctionReplacement(multiPreflightA, { productCode: '0002', quantity: 2 }),
      '2026-09-05T15:40:00+09:00', '다중 링크 일부 해소');
    await revisionGateway.executeRevision(multiCorrection.command);
    const multiTopAfterOne = (await all('unresolvedProducts')).find(item => item.unresolvedProductId === multiId);
    const multiReviewAfterOne = await unresolvedReviewReadAdapter.getReviewResult({ companyId: companies[0],
      generatedAt: '2026-09-05T15:41:00+09:00' });
    const multiIdentityB = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: multiUnresolvedB.result.document.purchaseDocumentId };
    const multiCancel = await buildRevision(revisionGateway, multiIdentityB, 'CANCEL', null,
      '2026-09-05T15:42:00+09:00', '다중 링크 마지막 취소');
    await revisionGateway.executeRevision(multiCancel.command);
    const multiTopAfterAll = (await all('unresolvedProducts')).find(item => item.unresolvedProductId === multiId);
    const multiReviewAfterAll = await unresolvedReviewReadAdapter.getReviewResult({ companyId: companies[0],
      generatedAt: '2026-09-05T15:43:00+09:00' });

    const soleUnresolved = await post(postGateway, 'PURCHASE', companies[0], 'SOLE-UNRESOLVED-CANCEL',
      [row('ROW-SOLE-UNRESOLVED', { code: 'UNMATCHED-SOLE', name: '단일 미매칭', quantity: 4 })]);
    const soleId = soleUnresolved.result.lines[0].unresolvedProductId;
    const soleIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: soleUnresolved.result.document.purchaseDocumentId };
    const soleCancel = await buildRevision(revisionGateway, soleIdentity, 'CANCEL', null,
      '2026-09-05T15:44:00+09:00', '단일 링크 취소');
    await revisionGateway.executeRevision(soleCancel.command);
    const soleTop = (await all('unresolvedProducts')).find(item => item.unresolvedProductId === soleId);
    const soleReview = await unresolvedReviewReadAdapter.getReviewResult({ companyId: companies[0],
      generatedAt: '2026-09-05T15:45:00+09:00' });

    const reuseSource = await post(postGateway, 'PURCHASE', companies[0], 'MATCHED-ID-REUSE',
      [row('ROW-MATCHED-ID-REUSE', { quantity: 2 })]);
    const reuseIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: reuseSource.result.document.purchaseDocumentId };
    const reusePreflight = await revisionGateway.inspectRevisionTarget(reuseIdentity);
    const reuseReplacement = correctionReplacement(reusePreflight, { productCode: 'UNMATCHED-NEW', quantity: 2 });
    const matchedUnresolvedId = rematchSource.result.pendingInventoryEffects[0].unresolvedProductId;
    const reuseResolution = { ...reuseReplacement.lines[0].officialProductResolution,
      inputProductCode: 'UNMATCHED-REMATCH', referenceSnapshotId: ownerProductSnapshot.snapshotId };
    Object.assign(reuseReplacement.lines[0], { unresolvedProductId: matchedUnresolvedId,
      productCode: 'UNMATCHED-REMATCH', originalProductCode: 'UNMATCHED-REMATCH',
      specification: '10kg', unit: 'BOX', actualUnit: 'BOX', officialProductResolution: reuseResolution });
    refreshLineSnapshot(reuseReplacement.lines[0]);
    const reusePreview = revisionGateway.previewRevision({ preflight: reusePreflight, action: 'CORRECT',
      replacement: reuseReplacement });
    const reuseCommand = revisionGateway.buildRevisionCommand({ preflight: reusePreflight, action: 'CORRECT',
      replacement: reuseReplacement, stocktakeDecisions: decisionsFor(reusePreview), actor: 'USER-7A',
      occurredAt: '2026-09-05T15:46:00+09:00', reason: 'MATCHED unresolved identity 재사용 차단',
      productOwnerSnapshot: ownerProductSnapshot, customerOwnerSnapshot: ownerCustomerSnapshot });
    const reuseBefore = await counts(companies[0]);
    let matchedReuseError = '';
    try { await revisionGateway.executeRevision(reuseCommand); } catch (error) { matchedReuseError = errorText(error); }
    const reuseAfter = await counts(companies[0]);
    const matchedTopAfterReuse = (await all('unresolvedProducts')).find(item => item.unresolvedProductId === matchedUnresolvedId);

    const arCustomer = [{ companyId: companies[0], customerId: 'CUSTOMER-1', customerCode: 'C001',
      customerName: '거래처 1', status: 'ACTIVE', revision: 1 }];
    const arDocument = await post(postGateway, 'PURCHASE', companies[0], 'ARAP-BLOCK',
      [row('ROW-ARAP', { quantity: 1 })], '2026-09-03', arCustomer);
    let arApUnsupported = '';
    try {
      const arPreflight = await revisionGateway.inspectRevisionTarget({ kind: 'PURCHASE', companyId: companies[0],
        purchaseDocumentId: arDocument.result.document.purchaseDocumentId });
      revisionGateway.previewRevision({ preflight: arPreflight, action: 'CANCEL' });
    } catch (error) { arApUnsupported = errorText(error); }

    const collisionSource = await post(postGateway, 'PURCHASE', companies[0], 'PAYLOAD-COLLISION',
      [row('ROW-PAYLOAD-COLLISION', { quantity: 3 })]);
    const collisionIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: collisionSource.result.document.purchaseDocumentId };
    const collisionRevision = await buildRevision(revisionGateway, collisionIdentity, 'CANCEL', null,
      '2026-09-05T15:30:00+09:00', 'payload collision test');
    const collisionDb = await openOrderQDb();
    const collisionTx = collisionDb.transaction('officialCommands', 'readwrite');
    collisionTx.objectStore('officialCommands').add({
      commandId: collisionRevision.command.commandId,
      idempotencyKey: collisionRevision.command.commandId,
      companyId: companies[0], voucherMode: 'purchase',
      documentId: collisionIdentity.purchaseDocumentId,
      commandType: 'CANCEL_PURCHASE', action: 'CANCEL', status: 'COMMITTED',
      payloadDigest: 'DIFFERENT-PAYLOAD-DIGEST', requestedAt: '2026-09-05T15:29:00+09:00', result: {}
    });
    await transactionDone(collisionTx);
    let payloadConflict = '';
    try { await revisionGateway.executeRevision(collisionRevision.command); } catch (error) { payloadConflict = errorText(error); }
    const collisionAggregate = await repository.loadOfficialPurchaseAggregate(collisionIdentity.purchaseDocumentId);

    const rollbackSource = await post(postGateway, 'PURCHASE', companies[0], 'ROLLBACK',
      [row('ROW-ROLLBACK', { quantity: 6 })]);
    const rollbackIdentity = { kind: 'PURCHASE', companyId: companies[0],
      purchaseDocumentId: rollbackSource.result.document.purchaseDocumentId };
    const rollbackRevision = await buildRevision(revisionGateway, rollbackIdentity, 'CANCEL', null,
      '2026-09-05T16:00:00+09:00', 'rollback test');
    const rollbackBefore = await counts(companies[0]);
    const db = await openOrderQDb();
    const blockerTx = db.transaction('syncQueue', 'readwrite');
    blockerTx.objectStore('syncQueue').add({
      queueId: voucherStableId('SQR', rollbackRevision.command.commandId), entityType: 'TEST_BLOCKER',
      entityId: 'TEST', status: 'WAITING_SERVER_CONTRACT', createdAt: '2026-09-05T15:59:00+09:00',
      payload: { companyId: companies[0] }
    });
    await transactionDone(blockerTx);
    const rollbackBaseline = await counts(companies[0]);
    let rollbackError = '';
    try { await revisionGateway.executeRevision(rollbackRevision.command); } catch (error) { rollbackError = errorText(error); }
    const rollbackAfter = await counts(companies[0]);
    const rollbackAggregate = await repository.loadOfficialPurchaseAggregate(rollbackIdentity.purchaseDocumentId);

    const injectedRollbackSpecs = [
      { label: 'DOCUMENT_PROJECTION', store: 'purchaseDocuments', method: 'put' },
      { label: 'LINE_PROJECTION', store: 'purchaseLines', method: 'put' },
      { label: 'INVENTORY_MOVEMENT', store: 'inventoryMovements', method: 'add' },
      { label: 'PENDING_SUPERSESSION', store: 'pendingInventoryEffects', method: 'put', sourceCode: 'UNMATCHED-SUPERSEDE' },
      { label: 'UNRESOLVED_PROJECTION', store: 'unresolvedProducts', method: 'put', sourceCode: 'UNMATCHED-UNRESOLVED' },
      { label: 'PENDING_CREATION', store: 'pendingInventoryEffects', method: 'add', replacementCode: 'UNMATCHED-NEW' },
      { label: 'IMMUTABLE_REVISION', store: 'voucherRevisions', method: 'add' },
      { label: 'COMMAND_RECEIPT', store: 'officialCommands', method: 'add' },
      { label: 'SYNC_QUEUE', store: 'syncQueue', method: 'add' }
    ];
    const injectedRollbacks = [];
    for (let index = 0; index < injectedRollbackSpecs.length; index += 1) {
      injectedRollbacks.push(await runInjectedRollbackCase(postGateway, revisionGateway, injectedRollbackSpecs[index], index));
    }

    const dbInfo = await openOrderQDb();
    return {
      db: { name: dbInfo.name, version: dbInfo.version, stores: [...dbInfo.objectStoreNames] },
      correction: {
        revision: corrected.document.revision, action: corrected.voucherRevision.action,
        movementRoles: corrected.inventoryMovements.map(item => item.effectRole),
        movementQuantities: corrected.inventoryMovements.map(item => item.signedQuantity),
        originalRevisionUnchanged: JSON.stringify(originalPurchaseRevision) === JSON.stringify(purchase.result.voucherRevision),
        ledgerEntries: corrected.ledgerEntries.length, queueStatus: (await all('syncQueue')).find(item => item.entityId === correction.command.commandId)?.status,
        queueType: (await all('syncQueue')).find(item => item.entityId === correction.command.commandId)?.entityType,
        counts: correctedCounts
      },
      retry: { duplicate: duplicate.duplicate, countsUnchanged: JSON.stringify(duplicateCountsBefore) === JSON.stringify(duplicateCountsAfter) },
      replacementContract: { errors: replacementErrors,
        writesZero: JSON.stringify(replacementContractBefore) === JSON.stringify(replacementContractAfter),
        zeroAccepted: zeroPreview.after.lines[0].actualQuantity === 0,
        negativeSnapshotPreserved: corrected.lines[0].productSnapshot.quantity === -3
          && corrected.lines[0].productSnapshot.unitPrice === -200
          && corrected.lines[0].productSnapshot.amount === 600 },
      saleCancel: { status: cancelled.document.status, lineStatus: cancelled.lines[0].lineStatus,
        effectStatus: cancelled.inventoryMovements[0].effectStatus, signedQuantity: cancelled.inventoryMovements[0].signedQuantity,
        alreadyCancelled },
      mixedStocktake: {
        conflicts: mixedPreview.conflicts.length,
        statuses: mixedResult.inventoryMovements.map(item => item.stocktakeEffectStatus).sort(),
        applied: mixedResult.inventoryMovements.map(item => item.officialInventoryApplied).sort(),
        middleCancel,
        middleCancelWritesZero: JSON.stringify(beforeMiddleCancel) === JSON.stringify(afterMiddleCancel)
      },
      transitions: {
        unresolvedToMatched: { movements: unresolvedResult.inventoryMovements.length,
          superseded: unresolvedResult.supersededPendingEffectIds.length, pendingCreated: unresolvedResult.pendingInventoryEffects.length },
        matchedToUnresolved: { movements: matchedResult.inventoryMovements.length,
          pendingCreated: matchedResult.pendingInventoryEffects.length,
          reinspectedRevision: matchedUnresolvedReinspection.target.currentRevision,
          reinspectedStatus: matchedUnresolvedReinspection.target.effectiveLineStates[0].status },
        rematchedCorrection: { beforeStatus: rematchPreflight.target.effectiveLineStates[0].status,
          movements: rematchResult.inventoryMovements.map(item => item.signedQuantity) },
        chainedRevision: { revision: chainedSecondResult.document.revision,
          secondMovementCount: chainedSecondResult.inventoryMovements.length,
          revisionCount: afterSecondAggregate.revisions.length,
          firstRevisionUnchanged: JSON.stringify(firstRevisionSnapshot)
            === JSON.stringify(afterSecondAggregate.revisions.find(item => item.revision === 3)) }
      },
      referenceIntegrity: {
        fabricatedProductError: fakeProductError,
        fabricatedProductWritesZero: JSON.stringify(fakeProductBefore) === JSON.stringify(fakeProductAfter),
        falseUnresolvedProductError,
        arbitraryUnresolvedIdError,
        falseUnresolvedProductWritesZero: JSON.stringify(falseUnresolvedProductBefore)
          === JSON.stringify(falseUnresolvedProductAfter),
        unchangedIdentityRevision: unchangedResult.document.revision,
        deletedMasterProviderCalls,
        matchedPartnerUnsupported,
        matchedPartnerWritesZero: JSON.stringify(matchedPartnerBefore) === JSON.stringify(matchedPartnerAfter),
        falseUnresolvedPartnerError: falseUnresolvedError,
        falseUnresolvedPartnerWritesZero: JSON.stringify(falsePartnerBefore) === JSON.stringify(falsePartnerAfter),
        actualOwnerFalseUnresolvedError,
        actualOwnerFalseUnresolvedWritesZero: JSON.stringify(actualOwnerFalseBefore) === JSON.stringify(actualOwnerFalseAfter)
      },
      headProjectionIntegrity: {
        contradictoryStatusError: headStatusError,
        contradictoryStatusWritesZero: JSON.stringify(headStatusBefore) === JSON.stringify(headStatusAfter),
        initialSnapshotTamperError: headMultiError,
        initialSnapshotTamperWritesZero: JSON.stringify(headMultiBefore) === JSON.stringify(headMultiAfter),
        fullSnapshotTamperError: fullHeadError,
        fullSnapshotTamperWritesZero: JSON.stringify(fullHeadBefore) === JSON.stringify(fullHeadAfter)
      },
      sourceEffectIntegrity: {
        error: sourceEffectError,
        identityError: sourceEffectIdentityError,
        writesZero: JSON.stringify(sourceEffectBefore) === JSON.stringify(sourceEffectAfter),
        attacks: movementAttackResults
      },
      pendingLinkIntegrity: pendingLinkAttackResults,
      activeSetCoverage,
      unresolvedLifecycle: {
        multiAfterOneStatus: multiTopAfterOne?.status,
        multiAfterOneActiveLinks: (multiTopAfterOne?.reviewLinks || []).filter(link => ['PENDING_PRODUCT_MATCH', 'UNRESOLVED_PRODUCT']
          .includes(text(link.status || link.inventoryEffectStatus).toUpperCase())).length,
        multiVisibleAfterOne: multiReviewAfterOne.items.some(item => item.unresolvedProductId === multiId),
        multiAfterAllStatus: multiTopAfterAll?.status,
        multiVisibleAfterAll: multiReviewAfterAll.items.some(item => item.unresolvedProductId === multiId),
        soleStatus: soleTop?.status,
        soleVisible: soleReview.items.some(item => item.unresolvedProductId === soleId),
        matchedReuseError,
        matchedReuseWritesZero: JSON.stringify(reuseBefore) === JSON.stringify(reuseAfter),
        matchedIdentityStatusAfterReuse: matchedTopAfterReuse?.status,
        matchedIdentityProductAfterReuse: matchedTopAfterReuse?.productId
      },
      rejects: { staleError, crossCompany, arApUnsupported, payloadConflict,
        payloadConflictHeadRevision: collisionAggregate.document.revision,
        payloadConflictRevisionCount: collisionAggregate.revisions.length },
      rollback: {
        error: rollbackError,
        beforeInitial: rollbackBefore,
        baselineWithBlocker: rollbackBaseline,
        after: rollbackAfter,
        headRevision: rollbackAggregate.document.revision,
        revisionCount: rollbackAggregate.revisions.length,
        commandCommitted: rollbackAggregate.commands.some(item => item.commandId === rollbackRevision.command.commandId),
        injectedPoints: injectedRollbacks
      },
      transactions: transactionLog
    };
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
}
