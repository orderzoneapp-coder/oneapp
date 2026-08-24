import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.17.0';
import { requireActor } from './orderq-v7-contracts.js?v=0.8.0';
import { appendInventoryMovementsInTransaction } from './inventory-ledger-repository.js?v=0.17.0';
import { assertOfficialCommandAuthority } from './official-command-policy.js?v=0.17.0';
import { runCentralOfficialCommand } from './central-command-gateway.js?v=0.17.0';
import { calculateOfficialDocumentAmount, canonicalSha256, planOfficialVoucherCommand, voucherStableId } from './official-voucher-core.js?v=0.17.0';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function storesFor(kind) {
  return kind === 'PURCHASE'
    ? { document: STORE.PURCHASE_DOCUMENTS, lines: STORE.PURCHASE_LINES, idField: 'purchaseDocumentId', entry: STORE.PAYABLE_ENTRIES }
    : { document: STORE.SALES_DOCUMENTS, lines: STORE.SALES_LINES, idField: 'salesDocumentId', entry: STORE.RECEIVABLE_ENTRIES };
}

async function allByIndex(store, indexName, key) {
  return requestToPromise(store.index(indexName).getAll(key));
}

export async function saveOfficialVoucherDraft(source = {}, actor = 'ADMIN') {
  const context = requireActor(actor);
  const kind = text(source.kind).toUpperCase();
  if (!['PURCHASE', 'SALE'].includes(kind)) throw new Error('ORDERQ_OFFICIAL_DRAFT_KIND_INVALID');
  const contract = storesFor(kind);
  const timestamp = nowIso();
  const sourceType = text(source.sourceType).toUpperCase() || 'IMPORT';
  const sourceDocumentKey = text(source.sourceDocumentKey);
  if (!sourceDocumentKey) throw new Error('ORDERQ_OFFICIAL_SOURCE_DOCUMENT_KEY_REQUIRED');
  const id = text(source[contract.idField]) || voucherStableId(kind === 'PURCHASE' ? 'PD' : 'SD', 'VOUCHER_CORE_V1', sourceType, sourceDocumentKey);
  const draftDocument = {
    ...source,
    [contract.idField]: id,
    status: 'DRAFT',
    businessStatus: 'DRAFT',
    projectionStatus: 'LOCAL_PROJECTED',
    documentContract: 'VOUCHER_CORE_V1',
    sourceDocumentKey,
    revision: 1,
    sourceType,
    contractKind: text(source.contractKind) || (kind === 'PURCHASE' ? 'PURCHASE_STAGE3_V1' : ''),
    draftIntentDigest: text(source.draftIntentDigest),
    commandEnvelope: source.commandEnvelope ? JSON.parse(JSON.stringify(source.commandEnvelope)) : null,
    commandFingerprint: text(source.commandFingerprint),
    commandId: text(source.commandId),
    commandState: text(source.commandState) || (source.commandEnvelope ? 'COMMAND_FROZEN' : 'DRAFT_SAVED'),
    lastErrorCode: '',
    centralTransactionId: '',
    resultDigest: '',
    projectionPending: false,
    localOnly: true,
    createdAt: source.createdAt || timestamp,
    createdBy: source.createdBy || context.actorId,
    updatedAt: timestamp,
    updatedBy: context.actorId
  };
  const rawLines = Array.isArray(source.lines) ? source.lines : [];
  if (!rawLines.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  const amount = calculateOfficialDocumentAmount(rawLines);
  draftDocument.supplyAmount = amount.supplyAmount;
  draftDocument.totalAmount = amount.totalAmount;
  draftDocument.vatAmount = null;
  draftDocument.taxType = 'VAT_INCLUDED_IN_SUPPLY';
  draftDocument.currency = 'KRW';
  const lineIdField = kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId';
  const lines = amount.lines.map((line, index) => {
    const sourceLineKey = text(line.sourceLineKey) || String(index + 1);
    const lineIdentityId = text(line.lineIdentityId) || voucherStableId('LI', id, sourceLineKey);
    return ({
    ...line,
    actualQuantity: Number(line.actualQuantity ?? line.quantity),
    sourceLineKey,
    lineIdentityId,
    [lineIdField]: text(line[lineIdField]) || voucherStableId(kind === 'PURCHASE' ? 'PL' : 'SL', id, lineIdentityId),
    [contract.idField]: id,
    status: 'DRAFT',
    revision: 1,
    lineSequence: Number(line.lineSequence || index + 1),
    localOnly: true,
    createdAt: line.createdAt || timestamp,
    createdBy: line.createdBy || context.actorId,
    updatedAt: timestamp,
    updatedBy: context.actorId
  }); });
  const db = await openOrderQDb();
  const tx = db.transaction([contract.document, contract.lines], 'readwrite');
  try {
    const documentStore = tx.objectStore(contract.document);
    if (await requestToPromise(documentStore.get(id))) throw new Error(`ORDERQ_OFFICIAL_DRAFT_EXISTS:${id}`);
    documentStore.add(draftDocument);
    lines.forEach(line => tx.objectStore(contract.lines).add(line));
    await transactionDone(tx);
    return { document: draftDocument, lines };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

function purchaseSearchText(document, lines) {
  return [document.purchaseDocumentId, document.supplierCustomerId, document.supplierCustomerCode,
    document.supplierCustomerName, document.externalDocumentNo, document.purchasePlanId,
    ...lines.flatMap(line => [line.productId, line.productCode, line.productName])]
    .map(value => text(value).toLowerCase()).join('|');
}

export function officialPurchaseReviewCandidate(rows = [], identity = {}) {
  const contractKind = text(identity.contractKind);
  const sourceDocumentKey = text(identity.sourceDocumentKey);
  const purchasePlanId = text(identity.purchasePlanId);
  const externalDocumentNo = text(identity.externalDocumentNo);
  const sourceVoucherIndex = Number(identity.sourceVoucherIndex || 0);
  return rows.find(row => text(row.contractKind) === contractKind
    && text(row.documentContract) === 'VOUCHER_CORE_V1'
    && text(row.sourceDocumentKey) !== sourceDocumentKey
    && ((externalDocumentNo && text(row.externalDocumentNo) === externalDocumentNo)
      || (purchasePlanId && text(row.purchasePlanId) === purchasePlanId
        && sourceVoucherIndex > 0 && Number(row.sourceVoucherIndex || 0) === sourceVoucherIndex))) || null;
}

export async function listOfficialPurchases(filters = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES], 'readonly');
  const documents = await requestToPromise(tx.objectStore(STORE.PURCHASE_DOCUMENTS).getAll());
  const lines = await requestToPromise(tx.objectStore(STORE.PURCHASE_LINES).getAll());
  await transactionDone(tx);
  const byDocument = new Map();
  lines.forEach(line => {
    const key = text(line.purchaseDocumentId);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key).push(line);
  });
  const query = text(filters.search).toLowerCase();
  return documents.filter(document => text(document.documentContract) === 'VOUCHER_CORE_V1'
      && text(document.contractKind) === 'PURCHASE_STAGE3_V1')
    .filter(document => !filters.status || text(document.businessStatus || document.status) === text(filters.status).toUpperCase())
    .filter(document => !filters.sourceType || text(document.sourceType) === text(filters.sourceType).toUpperCase())
    .filter(document => !filters.projectionStatus || text(document.projectionStatus) === text(filters.projectionStatus).toUpperCase())
    .filter(document => !filters.from || text(document.purchaseDate) >= text(filters.from))
    .filter(document => !filters.to || text(document.purchaseDate) <= text(filters.to))
    .filter(document => !query || purchaseSearchText(document, byDocument.get(document.purchaseDocumentId) || []).includes(query))
    .sort((left, right) => text(right.purchaseDate).localeCompare(text(left.purchaseDate))
      || text(right.createdAt).localeCompare(text(left.createdAt))
      || text(left.purchaseDocumentId).localeCompare(text(right.purchaseDocumentId)))
    .map(document => ({ ...document, lineCount: (byDocument.get(document.purchaseDocumentId) || []).filter(line => text(line.lineStatus || 'ACTIVE') !== 'DELETED').length }));
}

export async function loadOfficialPurchaseAggregate(purchaseDocumentId) {
  const id = text(purchaseDocumentId);
  if (!id) throw new Error('ORDERQ_OFFICIAL_PURCHASE_ID_REQUIRED');
  const db = await openOrderQDb();
  const stores = [STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.INVENTORY_MOVEMENTS,
    STORE.VOUCHER_EVENTS, STORE.PAYABLE_ENTRIES, STORE.META];
  const tx = db.transaction(stores, 'readonly');
  const document = await requestToPromise(tx.objectStore(STORE.PURCHASE_DOCUMENTS).get(id));
  if (!document || text(document.documentContract) !== 'VOUCHER_CORE_V1') {
    await transactionDone(tx);
    return null;
  }
  const lines = await allByIndex(tx.objectStore(STORE.PURCHASE_LINES), 'byDocumentId', id);
  const movements = (await requestToPromise(tx.objectStore(STORE.INVENTORY_MOVEMENTS).getAll())).filter(row => text(row.sourceDocumentId) === id);
  const voucherEvents = (await requestToPromise(tx.objectStore(STORE.VOUCHER_EVENTS).getAll())).filter(row => text(row.documentType) === 'PURCHASE' && text(row.documentId) === id);
  const payableEntries = (await requestToPromise(tx.objectStore(STORE.PAYABLE_ENTRIES).getAll())).filter(row => text(row.purchaseDocumentId) === id);
  const commandId = text(document.commandId);
  const projectionReceipt = commandId ? await requestToPromise(tx.objectStore(STORE.META).get(`centralProjection:${commandId}`)) : null;
  await transactionDone(tx);
  const activeLines = lines.filter(line => text(line.lineStatus || 'ACTIVE') !== 'DELETED' && text(line.status) !== 'REVERSED');
  const tombstones = lines.filter(line => !activeLines.includes(line));
  const receipt = projectionReceipt?.value || projectionReceipt || null;
  const overlay = receipt ? {
    projectionStatus: text(receipt.projectionStatus) || document.projectionStatus,
    projectionPending: text(receipt.projectionStatus) === 'PROJECTION_PENDING',
    centralTransactionId: text(receipt.centralTransactionId) || document.centralTransactionId,
    resultDigest: text(receipt.resultDigest) || document.resultDigest,
    commandState: text(receipt.projectionStatus) === 'LOCAL_PROJECTED' ? 'LOCAL_PROJECTED' : 'PROJECTION_PENDING'
  } : {};
  return { document: { ...document, ...overlay }, activeLines, tombstones, movements, voucherEvents, payableEntries, projectionReceipt: receipt };
}

export async function findOfficialPurchaseBySource(identity = {}) {
  const contractKind = text(identity.contractKind);
  if (!contractKind) throw new Error('ORDERQ_PURCHASE_CONTRACT_KIND_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.PURCHASE_DOCUMENTS, 'readonly');
  const store = tx.objectStore(STORE.PURCHASE_DOCUMENTS);
  let document = null;
  const sourceDocumentKey = text(identity.sourceDocumentKey);
  const originSystem = text(identity.originSystem).toUpperCase();
  const originTransactionId = text(identity.originTransactionId);
  const purchasePlanId = text(identity.purchasePlanId);
  const externalDocumentNo = text(identity.externalDocumentNo);
  const sourceVoucherIndex = Number(identity.sourceVoucherIndex || 0);
  if (originSystem && originTransactionId && sourceDocumentKey && store.indexNames.contains('byOriginRunDocument')) {
    document = await requestToPromise(store.index('byOriginRunDocument').get([originSystem, originTransactionId, sourceDocumentKey]));
  }
  if (sourceDocumentKey) {
    document ||= await requestToPromise(store.index('byDocumentContractSourceKey').get(['VOUCHER_CORE_V1', sourceDocumentKey]));
  }
  if (!document && originSystem && originTransactionId) {
    const rows = await requestToPromise(store.getAll());
    document = rows.find(row => text(row.originSystem).toUpperCase() === originSystem
      && text(row.originTransactionId) === originTransactionId
      && (!sourceDocumentKey || text(row.sourceDocumentKey) === sourceDocumentKey)) || null;
  }
  if (!document) {
    const rows = await requestToPromise(store.getAll());
    const reviewCandidate = officialPurchaseReviewCandidate(rows, identity);
    if (reviewCandidate) throw new Error(`ORDERQ_PURCHASE_SOURCE_REVIEW_REQUIRED:${reviewCandidate.purchaseDocumentId}`);
  }
  await transactionDone(tx);
  return document && text(document.contractKind) === contractKind ? document : null;
}

export function buildFrozenPurchaseIntent(source = {}) {
  const lineFields = ['sourceLineKey', 'lineIdentityId', 'lineSequence', 'productId', 'productCode', 'productName', 'specification',
    'warehouseId', 'warehouseCode', 'suggestedQuantity', 'suggestedBaseQuantity', 'actualQuantity', 'unit', 'conversionFactor', 'baseQuantity', 'baseUnit', 'unitPrice',
    'supplyAmount', 'totalAmount', 'taxType', 'currency', 'productMasterRevision', 'warehouseMasterRevision'];
  const documentFields = ['supplierCustomerId', 'supplierCustomerCode', 'supplierCustomerName', 'purchaseDate', 'warehouseId',
    'warehouseCode', 'warehouseName', 'taxType', 'currency', 'sourceShortageKey'];
  const pick = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, value[field]]));
  const sortedLines = [...(source.lines || [])].sort((left, right) => Number(left.lineSequence || 0) - Number(right.lineSequence || 0)
    || text(left.sourceLineKey).localeCompare(text(right.sourceLineKey)));
  const commandId = text(source.commandId || source.idempotencyKey);
  const intent = {
    commandContract: 'VOUCHER_CORE_V1',
    commandId,
    idempotencyKey: commandId,
    commandType: text(source.commandType).toUpperCase(),
    aggregateId: text(source.aggregateId),
    expectedRevision: Number(source.expectedRevision),
    sourceType: text(source.sourceType).toUpperCase(),
    contractKind: text(source.contractKind),
    sourceDocumentKey: text(source.sourceDocumentKey),
    normalizedOriginVersion: 'PURCHASE_V2',
    originSystem: text(source.originSystem),
    originTransactionId: text(source.originTransactionId),
    externalDocumentNo: text(source.externalDocumentNo),
    purchasePlanId: text(source.purchasePlanId),
    sourceShortageKey: text(source.sourceShortageKey),
    actorId: text(source.actorId || source.actor),
    reason: text(source.reason),
    occurredAt: text(source.occurredAt),
    document: pick(source.document || source, documentFields),
    lines: sortedLines.map(line => pick(line, lineFields))
  };
  const draftIntentDigest = canonicalSha256(intent);
  const stableCommandId = commandId || `PURCHASE:${draftIntentDigest}`;
  const commandEnvelope = { ...intent, commandId: stableCommandId, idempotencyKey: stableCommandId };
  const centralIntent = { ...commandEnvelope, actor: commandEnvelope.actorId };
  const commandFingerprint = canonicalSha256({
    commandType: commandEnvelope.commandType,
    aggregateId: commandEnvelope.aggregateId,
    expectedRevision: commandEnvelope.expectedRevision,
    intent: centralIntent
  });
  return { draftIntentDigest: canonicalSha256(commandEnvelope), commandId: stableCommandId, commandEnvelope, commandFingerprint, commandState: 'COMMAND_FROZEN' };
}

function saleSearchText(document, lines) {
  return [document.salesDocumentId, document.salesCustomerId, document.salesCustomerName,
    document.deliveryCustomerId, document.billingCustomerId, document.externalDocumentNo,
    ...lines.flatMap(line => [line.productId, line.productCode, line.productName, line.sourceOrderId, line.sourceOrderItemId])]
    .map(value => text(value).toLowerCase()).join('|');
}

export async function listOfficialSales(filters = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.SALES_DOCUMENTS, STORE.SALES_LINES], 'readonly');
  const documents = await requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).getAll());
  const lines = await requestToPromise(tx.objectStore(STORE.SALES_LINES).getAll());
  await transactionDone(tx);
  const byDocument = new Map();
  lines.forEach(line => {
    const key = text(line.salesDocumentId);
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key).push(line);
  });
  const query = text(filters.search).toLowerCase();
  return documents.filter(document => text(document.documentContract) === 'VOUCHER_CORE_V1'
      && text(document.contractKind) === 'SALE_STAGE4_V1')
    .filter(document => !filters.status || text(document.businessStatus || document.status) === text(filters.status).toUpperCase())
    .filter(document => !filters.sourceType || text(document.sourceType) === text(filters.sourceType).toUpperCase())
    .filter(document => !filters.from || text(document.saleDate) >= text(filters.from))
    .filter(document => !filters.to || text(document.saleDate) <= text(filters.to))
    .filter(document => !query || saleSearchText(document, byDocument.get(document.salesDocumentId) || []).includes(query))
    .sort((left, right) => text(right.saleDate).localeCompare(text(left.saleDate))
      || text(right.createdAt).localeCompare(text(left.createdAt))
      || text(left.salesDocumentId).localeCompare(text(right.salesDocumentId)))
    .map(document => ({ ...document, lineCount: (byDocument.get(document.salesDocumentId) || [])
      .filter(line => text(line.lineStatus || 'ACTIVE') !== 'DELETED').length }));
}

export async function listLegacySales(filters = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.SALES_DOCUMENTS, STORE.SALES_LINES], 'readonly');
  const documents = await requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).getAll());
  const lines = await requestToPromise(tx.objectStore(STORE.SALES_LINES).getAll());
  await transactionDone(tx);
  const query = text(filters.search).toLowerCase();
  return documents.filter(document => text(document.documentContract) !== 'VOUCHER_CORE_V1')
    .filter(document => !filters.status || text(document.businessStatus || document.status).toUpperCase() === text(filters.status).toUpperCase())
    .filter(document => !query || saleSearchText(document, lines.filter(line => text(line.salesDocumentId) === text(document.salesDocumentId))).includes(query))
    .map(document => ({ ...document, contractKind:'LEGACY_SALE_V1' }))
    .sort((a,b) => text(b.updatedAt || b.saleDate).localeCompare(text(a.updatedAt || a.saleDate)) || text(a.salesDocumentId).localeCompare(text(b.salesDocumentId)));
}

export async function loadLegacySaleAggregate(salesDocumentId) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.SALES_DOCUMENTS, STORE.SALES_LINES, STORE.INVENTORY_MOVEMENTS], 'readonly');
  const document = await requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).get(text(salesDocumentId)));
  if (!document || text(document.documentContract) === 'VOUCHER_CORE_V1') { await transactionDone(tx); return null; }
  const lines = await allByIndex(tx.objectStore(STORE.SALES_LINES), 'byDocumentId', text(salesDocumentId));
  const movements = (await requestToPromise(tx.objectStore(STORE.INVENTORY_MOVEMENTS).getAll()))
    .filter(row => text(row.sourceDocumentId) === text(salesDocumentId));
  await transactionDone(tx);
  return { document:{ ...document, contractKind:'LEGACY_SALE_V1' }, lines, activeLines:lines, movements,
    receivableEntries:[], orderEvents:[], voucherEvents:[] };
}

export async function loadOfficialSaleAggregate(salesDocumentId) {
  const id = text(salesDocumentId);
  if (!id) throw new Error('ORDERQ_OFFICIAL_SALE_ID_REQUIRED');
  const db = await openOrderQDb();
  const stores = [STORE.SALES_DOCUMENTS, STORE.SALES_LINES, STORE.INVENTORY_MOVEMENTS,
    STORE.VOUCHER_EVENTS, STORE.RECEIVABLE_ENTRIES, STORE.ORDER_EVENTS, STORE.ORDERS,
    STORE.ORDER_ITEMS, STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.META];
  const available = stores.filter(name => db.objectStoreNames.contains(name));
  const tx = db.transaction(available, 'readonly');
  const document = await requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).get(id));
  if (!document || text(document.documentContract) !== 'VOUCHER_CORE_V1') {
    await transactionDone(tx); return null;
  }
  const lines = await allByIndex(tx.objectStore(STORE.SALES_LINES), 'byDocumentId', id);
  const movements = (await requestToPromise(tx.objectStore(STORE.INVENTORY_MOVEMENTS).getAll())).filter(row => text(row.sourceDocumentId) === id);
  const voucherEvents = (await requestToPromise(tx.objectStore(STORE.VOUCHER_EVENTS).getAll())).filter(row => text(row.documentType) === 'SALE' && text(row.documentId) === id);
  const receivableEntries = (await requestToPromise(tx.objectStore(STORE.RECEIVABLE_ENTRIES).getAll())).filter(row => text(row.salesDocumentId) === id);
  const orderEvents = (await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).getAll())).filter(row => text(row.detail?.salesDocumentId) === id || text(row.detail?.reversalSalesDocumentId) === id);
  const readAll = async storeName => available.includes(storeName) ? requestToPromise(tx.objectStore(storeName).getAll()) : [];
  const orders = await readAll(STORE.ORDERS);
  const orderItems = await readAll(STORE.ORDER_ITEMS);
  const dispatches = await readAll(STORE.DISPATCH_DECISIONS);
  const dispatchLines = await readAll(STORE.DISPATCH_LINES);
  const commandId = text(document.commandId);
  const projectionReceipt = commandId ? await requestToPromise(tx.objectStore(STORE.META).get(`centralProjection:${commandId}`)) : null;
  await transactionDone(tx);
  const activeLines = lines.filter(line => text(line.lineStatus || 'ACTIVE') !== 'DELETED' && text(line.status) !== 'REVERSED');
  const receipt = projectionReceipt?.value || projectionReceipt || null;
  const sourceOrderIds = new Set(lines.map(line => text(line.sourceOrderId)).filter(Boolean));
  const sourceOrderItemIds = new Set(lines.map(line => text(line.sourceOrderItemId)).filter(Boolean));
  const sourceDispatchIds = new Set(lines.map(line => text(line.sourceDispatchId)).filter(Boolean));
  const sourceDispatchLineIds = new Set(lines.map(line => text(line.sourceDispatchLineId)).filter(Boolean));
  return {
    document: { ...document, ...(receipt ? { projectionStatus: text(receipt.projectionStatus) || document.projectionStatus,
      projectionPending: text(receipt.projectionStatus) === 'PROJECTION_PENDING',
      centralTransactionId: text(receipt.centralTransactionId) || document.centralTransactionId,
      resultDigest: text(receipt.resultDigest) || document.resultDigest } : {}) },
    activeLines, tombstones: lines.filter(line => !activeLines.includes(line)), movements, voucherEvents,
    receivableEntries, orderEvents,
    sourceOrders: orders.filter(row => sourceOrderIds.has(text(row.orderId))),
    sourceOrderItems: orderItems.filter(row => sourceOrderItemIds.has(text(row.orderItemId))),
    sourceDispatches: dispatches.filter(row => sourceDispatchIds.has(text(row.dispatchId || row.dispatchDecisionId))),
    sourceDispatchLines: dispatchLines.filter(row => sourceDispatchLineIds.has(text(row.dispatchLineId))),
    projectionReceipt: receipt
  };
}

export async function findOfficialSaleBySource(identity = {}) {
  const contractKind = text(identity.contractKind);
  if (!contractKind) throw new Error('ORDERQ_SALE_CONTRACT_KIND_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SALES_DOCUMENTS, 'readonly');
  const store = tx.objectStore(STORE.SALES_DOCUMENTS);
  let document = null;
  const sourceDocumentKey = text(identity.sourceDocumentKey);
  const originSystem = text(identity.originSystem).toUpperCase();
  const originTransactionId = text(identity.originTransactionId);
  const sourceVoucherIndex = Number(identity.sourceVoucherIndex || 0);
  if (!sourceDocumentKey || !originSystem || !originTransactionId || !Number.isInteger(sourceVoucherIndex) || sourceVoucherIndex < 1) {
    throw new Error('ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED');
  }
  if (originSystem && originTransactionId && sourceDocumentKey && store.indexNames.contains('byOriginRunDocument')) {
    document = await requestToPromise(store.index('byOriginRunDocument').get([originSystem, originTransactionId, sourceDocumentKey]));
  }
  if (!document && sourceDocumentKey) {
    document = await requestToPromise(store.index('byDocumentContractSourceKey').get(['VOUCHER_CORE_V1', sourceDocumentKey]));
  }
  await transactionDone(tx);
  if (document && text(document.contractKind) !== contractKind) throw new Error(`ORDERQ_SALE_SOURCE_ALREADY_POSTED:${sourceDocumentKey}`);
  return document;
}

export function buildFrozenSaleIntent(source = {}) {
  const lineFields = ['sourceLineKey', 'lineIdentityId', 'lineSequence', 'productId', 'productCode', 'productName', 'specification',
    'productMasterRevision', 'warehouseId', 'warehouseCode', 'warehouseMasterRevision',
    'suggestedActualQuantity', 'suggestedBaseQuantity', 'suggestedRecognizedOrderQuantity',
    'actualQuantity', 'actualUnit', 'actualToBaseFactor', 'baseQuantity', 'baseUnit',
    'actualToRecognizedFactor', 'recognizedOrderQuantity', 'recognizedUnit', 'unitPrice', 'supplyAmount', 'totalAmount',
    'taxType', 'currency', 'orderLinkMode', 'sourceOrderId', 'sourceOrderItemId', 'sourceOrderRevision', 'sourceOrderItemRevision',
    'sourceDispatchId', 'sourceDispatchLineId', 'sourceDispatchRevision', 'sourceDispatchLineRevision',
    'salesCustomerRevision', 'deliveryCustomerRevision', 'billingCustomerRevision',
    'conversionSource', 'conversionRuleId', 'conversionRuleVersion', 'sourcePlanId', 'sourceFingerprint', 'sourceRowKey', 'sourceRowNumber', 'sourceOccurrence'];
  const documentFields = ['salesCustomerId', 'salesCustomerCode', 'salesCustomerName', 'salesCustomerRevision',
    'deliveryCustomerId', 'deliveryCustomerCode', 'deliveryCustomerName', 'deliveryCustomerRevision',
    'billingCustomerId', 'billingCustomerCode', 'billingCustomerName', 'billingCustomerRevision',
    'saleDate', 'warehouseId', 'warehouseCode', 'warehouseName', 'taxType', 'currency'];
  const pick = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, value[field]]));
  const lines = [...(source.lines || [])].sort((left, right) => Number(left.lineSequence || 0) - Number(right.lineSequence || 0)
    || text(left.sourceLineKey).localeCompare(text(right.sourceLineKey))).map(line => ({
      ...pick(line, lineFields),
      reversalSourceAllocations: [...(line.reversalSourceAllocations || [])].sort((a, b) => text(a.allocationEventId).localeCompare(text(b.allocationEventId))),
      restorationSourceReversals: [...(line.restorationSourceReversals || [])].sort((a, b) => text(a.reversalEventId).localeCompare(text(b.reversalEventId)))
    }));
  const commandId = text(source.commandId || source.idempotencyKey);
  const intent = {
    commandContract: 'VOUCHER_CORE_V1', commandId, idempotencyKey: commandId,
    commandType: text(source.commandType).toUpperCase(), aggregateId: text(source.aggregateId),
    expectedRevision: Number(source.expectedRevision), sourceType: text(source.sourceType).toUpperCase(),
    contractKind: 'SALE_STAGE4_V1', sourceDocumentKey: text(source.sourceDocumentKey), normalizedOriginVersion: 'SALE_V2',
    originSystem: text(source.originSystem), originTransactionId: text(source.originTransactionId),
    sourceVoucherIndex: Number(source.sourceVoucherIndex || 0), externalDocumentNo: text(source.externalDocumentNo),
    actorId: text(source.actorId || source.actor), reason: text(source.reason), occurredAt: text(source.occurredAt),
    document: pick(source.document || source, documentFields), lines
  };
  if (!intent.sourceDocumentKey || !intent.originSystem || !intent.originTransactionId
    || !Number.isInteger(intent.sourceVoucherIndex) || intent.sourceVoucherIndex < 1) throw new Error('ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED');
  const derivedClaims = [`SALE:SOURCE:${intent.sourceDocumentKey}`,
    `SALE:TX:${intent.originSystem.toUpperCase()}:${intent.originTransactionId}:${intent.sourceVoucherIndex}`];
  lines.forEach(line => {
    if (text(line.sourceDispatchId) && text(line.sourceDispatchLineId)) derivedClaims.push(`SALE:DISPATCH:${text(line.sourceDispatchId)}:${text(line.sourceDispatchLineId)}`);
    line.reversalSourceAllocations.forEach(ref => derivedClaims.push(`SALE:ALLOCATION:${text(ref.allocationEventId)}`));
    line.restorationSourceReversals.forEach(ref => derivedClaims.push(`SALE:REVERSAL:${text(ref.reversalEventId)}`));
  });
  intent.sourceClaimKeys = Array.from(new Set(derivedClaims)).sort();
  const stableCommandId = commandId || `SALE:${canonicalSha256(intent)}`;
  const commandEnvelope = { ...intent, commandId: stableCommandId, idempotencyKey: stableCommandId };
  const centralIntent = { ...commandEnvelope, actor: commandEnvelope.actorId };
  const commandFingerprint = canonicalSha256({ commandType: commandEnvelope.commandType,
    aggregateId: commandEnvelope.aggregateId, expectedRevision: commandEnvelope.expectedRevision, intent: centralIntent });
  return { draftIntentDigest: canonicalSha256(commandEnvelope), commandId: stableCommandId,
    commandEnvelope, commandFingerprint, commandState: 'COMMAND_FROZEN' };
}

export async function applyOfficialVoucherCommand(source = {}) {
  const commandType = text(source.commandType).toUpperCase();
  assertOfficialCommandAuthority(commandType);
  const kind = commandType.endsWith('PURCHASE') ? 'PURCHASE' : 'SALE';
  const contract = storesFor(kind);
  const aggregateId = text(source.aggregateId || source[contract.idField]);
  if (!aggregateId) throw new Error('ORDERQ_OFFICIAL_AGGREGATE_ID_REQUIRED');
  const actor = requireActor(source.actor);
  const storeNames = [
    contract.document, contract.lines, contract.entry,
    STORE.VOUCHER_EVENTS, STORE.INVENTORY_MOVEMENTS, STORE.META, STORE.SYNC_QUEUE
  ];
  if (kind === 'SALE') storeNames.push(STORE.ORDER_EVENTS);
  if (kind === 'SALE' && text(source.sourceType || source.document?.sourceType || '').toUpperCase() === 'ORDER_Q') {
    storeNames.push(STORE.ORDERS, STORE.ORDER_ITEMS);
  }
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readwrite');
  try {
    const eventStore = tx.objectStore(STORE.VOUCHER_EVENTS);
    const duplicate = await requestToPromise(eventStore.index('byIdempotencyKey').get(text(source.idempotencyKey)));
    if (duplicate) {
      const document = await requestToPromise(tx.objectStore(contract.document).get(aggregateId));
      const lines = await allByIndex(tx.objectStore(contract.lines), 'byDocumentId', aggregateId);
      await transactionDone(tx);
      return { duplicate: true, document, lines, voucherEvent: duplicate };
    }
    const document = await requestToPromise(tx.objectStore(contract.document).get(aggregateId));
    if (!document) throw new Error(`ORDERQ_OFFICIAL_DOCUMENT_NOT_FOUND:${aggregateId}`);
    const storedLines = await allByIndex(tx.objectStore(contract.lines), 'byDocumentId', aggregateId);
    const storedMovements = (await requestToPromise(tx.objectStore(STORE.INVENTORY_MOVEMENTS).getAll()))
      .filter(row => text(row.sourceDocumentId) === aggregateId);
    const storedEntries = (await requestToPromise(tx.objectStore(contract.entry).getAll()))
      .filter(entry => text(entry[contract.idField]) === aggregateId);
    const storedOrderEvents = kind === 'SALE' ? await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).getAll()) : [];
    const activeLines = storedLines.filter(line => text(line.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED' && text(line.status).toUpperCase() !== 'REVERSED');
    const plan = planOfficialVoucherCommand({ command: { ...source, actor: actor.actorId }, document, lines: activeLines, snapshotLines: storedLines, movements: storedMovements, entries: storedEntries, orderEvents: storedOrderEvents });
    const documentStore = tx.objectStore(contract.document);
    const lineStore = tx.objectStore(contract.lines);
    documentStore.put(plan.document);
    const nextIds = new Set(plan.lines.map(line => text(line[kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId'])));
    storedLines.forEach(line => {
      const id = text(line[kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId']);
      const reversingCurrentLine = plan.document.status === 'REVERSED' && text(line.status).toUpperCase() !== 'REVERSED';
      const deletingActiveLine = !nextIds.has(id) && text(line.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED' && text(line.status).toUpperCase() !== 'REVERSED';
      if (reversingCurrentLine || deletingActiveLine) {
        lineStore.put({
          ...line,
          status: plan.document.status === 'REVERSED' ? 'REVERSED' : 'CONFIRMED',
          lineStatus: plan.document.status === 'REVERSED' ? line.lineStatus || 'ACTIVE' : 'DELETED',
          deletedRevision: plan.document.status === 'REVERSED' ? line.deletedRevision : plan.document.revision,
          revision: plan.document.revision,
          updatedAt: source.occurredAt,
          updatedBy: actor.actorId
        });
      }
    });
    plan.lines.forEach(line => lineStore.put(line));
    const movementResults = await appendInventoryMovementsInTransaction({ tx, actor, drafts: plan.movements, allocateLedgerSequence: false });
    movementResults.forEach(result => {
      const line = plan.lines.find(candidate => text(candidate[kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId']) === text(result.movement.sourceLineId));
      if (line) {
        line.movementId = result.movement.movementId;
        lineStore.put(line);
      }
    });
    const entryStore = tx.objectStore(contract.entry);
    plan.entries.forEach(entry => entryStore.add(entry));
    eventStore.add(plan.voucherEvent);
    if (kind === 'SALE') plan.orderEvents.forEach(event => tx.objectStore(STORE.ORDER_EVENTS).add(event));
    await transactionDone(tx);
    return { ...plan, movements: movementResults.map(result => result.movement), duplicate: false };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function runCentralOfficialVoucherCommand(source = {}) {
  const commandType = text(source.commandType).toUpperCase();
  const kind = commandType.endsWith('PURCHASE') ? 'PURCHASE' : 'SALE';
  const idField = kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const aggregateId = text(source.aggregateId || source[idField]);
  const command = {
    ...source,
    aggregateId,
    commandType,
    commandContract: 'VOUCHER_CORE_V1'
  };
  return runCentralOfficialCommand(command, () => applyOfficialVoucherCommand(command));
}
