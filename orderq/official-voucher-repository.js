import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { canonicalSha256, planOfficialVoucherCommand } from './official-voucher-core.js?v=0.21.0';
import { createInventoryCheckpoint, planPendingInventoryResolution } from './inventory-rematch-core.js?v=0.1.0';
import {
  assertOfficialCommandV2,
  isOfficialVoucherIdentityV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
} from './official-voucher-v2-contract.js?v=0.2.0';

const text = value => String(value ?? '').trim();
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function assertSupportedIdentityVersion(source = {}) {
  const command = source.intent || source.commandEnvelope || source.commandSource || source;
  const identityVersion = text(command?.identityVersion);
  if (identityVersion && identityVersion !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2) {
    throw new Error('ORDERQ_OFFICIAL_V2_IDENTITY_VERSION_INVALID');
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function kindContract(kind) {
  const normalized = text(kind).toUpperCase();
  if (!['PURCHASE', 'SALE'].includes(normalized)) throw new Error(`ORDERQ_OFFICIAL_KIND_INVALID:${normalized}`);
  return normalized === 'PURCHASE'
    ? {
      kind: normalized,
      mode: 'purchase',
      documentStore: STORE.PURCHASE_DOCUMENTS,
      lineStore: STORE.PURCHASE_LINES,
      documentId: 'purchaseDocumentId',
      lineId: 'purchaseLineId',
      partnerEntryStore: STORE.PAYABLE_ENTRIES
    }
    : {
      kind: normalized,
      mode: 'sale',
      documentStore: STORE.SALES_DOCUMENTS,
      lineStore: STORE.SALES_LINES,
      documentId: 'salesDocumentId',
      lineId: 'salesLineId',
      partnerEntryStore: STORE.RECEIVABLE_ENTRIES
    };
}

function inferKind(source = {}) {
  const explicit = text(source.kind).toUpperCase();
  if (explicit) return kindContract(explicit);
  const commandType = text(source.commandType || source.intent?.commandType).toUpperCase();
  return kindContract(commandType.endsWith('PURCHASE') || source.purchaseDocumentId ? 'PURCHASE' : 'SALE');
}

function documentIdOf(contract, source = {}) {
  const id = text(source[contract.documentId] || source.document?.[contract.documentId]);
  if (!id) throw new Error(`ORDERQ_OFFICIAL_${contract.kind}_DOCUMENT_ID_REQUIRED`);
  return id;
}

function frozenIntent(source = {}) {
  const commandEnvelope = clone(source.commandSource || source.commandEnvelope || source);
  if (!commandEnvelope || typeof commandEnvelope !== 'object') throw new Error('ORDERQ_OFFICIAL_COMMAND_REQUIRED');
  const draftIntentDigest = canonicalSha256(commandEnvelope);
  return { commandEnvelope: deepFreeze(commandEnvelope), draftIntentDigest };
}

export function buildFrozenPurchaseIntent(source = {}) {
  return frozenIntent(source);
}

export function buildFrozenSaleIntent(source = {}) {
  return frozenIntent(source);
}

function draftDocument(source, contract, actor) {
  const commandEnvelope = clone(source.commandEnvelope || source.commandSource);
  if (!commandEnvelope) throw new Error('ORDERQ_OFFICIAL_COMMAND_REQUIRED');
  if (isOfficialVoucherIdentityV2(commandEnvelope)) assertOfficialCommandV2(commandEnvelope);
  const document = clone(source.document || commandEnvelope.document || {});
  const documentId = documentIdOf(contract, { ...source, document });
  const companyId = text(source.companyId || document.companyId || commandEnvelope.companyId);
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  if (isOfficialVoucherIdentityV2(commandEnvelope)) {
    if (text(document.companyId) !== companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_MISMATCH');
    if (text(document.voucherGroupKey) !== text(commandEnvelope.voucherGroupKey)) {
      throw new Error('ORDERQ_OFFICIAL_V2_GROUP_MISMATCH');
    }
  }
  const timestamp = nowIso();
  return {
    ...document,
    [contract.documentId]: documentId,
    companyId,
    status: 'DRAFT',
    businessStatus: 'DRAFT',
    revision: 1,
    documentContract: 'VOUCHER_CORE_V1',
    commandEnvelope,
    draftIntentDigest: text(source.draftIntentDigest) || canonicalSha256(commandEnvelope),
    createdAt: text(document.createdAt) || timestamp,
    createdBy: text(document.createdBy) || text(actor),
    updatedAt: timestamp,
    updatedBy: text(actor)
  };
}

function draftLines(source, contract, document) {
  const rows = clone(source.lines || source.commandEnvelope?.lines || source.commandSource?.lines || []);
  if (!Array.isArray(rows) || !rows.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  return rows.map((row, index) => {
    if (isOfficialVoucherIdentityV2(document)
      && text(row.companyId) && text(row.companyId) !== text(document.companyId)) {
      throw new Error('ORDERQ_OFFICIAL_LINE_COMPANY_MISMATCH');
    }
    if (isOfficialVoucherIdentityV2(document)
      && text(row.voucherGroupKey) !== text(document.voucherGroupKey)) {
      throw new Error('ORDERQ_OFFICIAL_V2_GROUP_MISMATCH');
    }
    const lineId = text(row[contract.lineId]) || `${document[contract.documentId]}:L${index + 1}`;
    return {
      ...row,
      [contract.lineId]: lineId,
      [contract.documentId]: document[contract.documentId],
      companyId: document.companyId,
      lineSequence: Number(row.lineSequence || index + 1),
      status: 'DRAFT',
      lineStatus: 'ACTIVE',
      revision: 1,
      createdAt: text(row.createdAt) || document.createdAt,
      createdBy: text(row.createdBy) || document.createdBy,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy
    };
  });
}

export async function saveOfficialVoucherDraft(source = {}, actor = '') {
  assertSupportedIdentityVersion(source);
  const contract = inferKind(source);
  const commandEnvelope = source.commandEnvelope || source.commandSource;
  const checkedV2 = isOfficialVoucherIdentityV2(commandEnvelope) ? assertOfficialCommandV2(commandEnvelope) : null;
  if (checkedV2 && checkedV2.kind !== contract.kind) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_KIND_MISMATCH');
  const document = draftDocument(source, contract, actor);
  const lines = draftLines(source, contract, document);
  const db = await openOrderQDb();
  const tx = db.transaction([contract.documentStore, contract.lineStore], 'readwrite');
  const documentStore = tx.objectStore(contract.documentStore);
  const existing = await requestToPromise(documentStore.get(document[contract.documentId]));
  if (existing) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error(`ORDERQ_OFFICIAL_DRAFT_EXISTS:${document[contract.documentId]}`);
  }
  documentStore.add(document);
  const lineStore = tx.objectStore(contract.lineStore);
  lines.forEach(line => lineStore.add(line));
  await transactionDone(tx);
  return { document, lines };
}

async function findBySource(kind, identity = {}) {
  const contract = kindContract(kind);
  const db = await openOrderQDb();
  const tx = db.transaction(contract.documentStore, 'readonly');
  const store = tx.objectStore(contract.documentStore);
  let candidates = [];
  const companyId = text(identity.companyId);
  const sourceDocumentKey = text(identity.sourceDocumentKey);
  if (companyId && sourceDocumentKey && store.indexNames.contains('byCompanySource')) {
    candidates = await requestToPromise(store.index('byCompanySource').getAll([companyId, sourceDocumentKey]));
  } else {
    candidates = await requestToPromise(store.getAll());
  }
  await transactionDone(tx);
  const fields = ['companyId', 'contractKind', 'sourceDocumentKey', 'originSystem', 'originTransactionId',
    'purchasePlanId', 'externalDocumentNo', 'sourceVoucherIndex', 'identityVersion', 'voucherGroupKey'];
  return candidates.find(row => fields.every(field => {
    const wanted = identity[field];
    return wanted === undefined || wanted === null || text(wanted) === '' || text(row[field]) === text(wanted);
  })) || null;
}

export const findOfficialPurchaseBySource = identity => findBySource('PURCHASE', identity);
export const findOfficialSaleBySource = identity => findBySource('SALE', identity);

async function rowsByIndex(store, indexName, query) {
  return requestToPromise(store.index(indexName).getAll(query));
}

async function loadAggregate(kind, id) {
  const contract = kindContract(kind);
  const db = await openOrderQDb();
  const stores = [contract.documentStore, contract.lineStore, STORE.VOUCHER_REVISIONS,
    STORE.INVENTORY_MOVEMENTS, contract.partnerEntryStore, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.UNRESOLVED_PRODUCTS, STORE.OFFICIAL_COMMANDS];
  const tx = db.transaction(stores, 'readonly');
  const document = await requestToPromise(tx.objectStore(contract.documentStore).get(id));
  if (!document) {
    await transactionDone(tx);
    return null;
  }
  const [lines, revisions, inventoryMovements, ledgerEntries, pendingInventoryEffects, unresolvedProducts, commands] = await Promise.all([
    rowsByIndex(tx.objectStore(contract.lineStore), 'byDocumentId', id),
    rowsByIndex(tx.objectStore(STORE.VOUCHER_REVISIONS), 'byDocumentRevision', IDBKeyRange.bound([contract.mode, id, 0], [contract.mode, id, Number.MAX_SAFE_INTEGER])),
    rowsByIndex(tx.objectStore(STORE.INVENTORY_MOVEMENTS), 'byDocument', [contract.mode, id]),
    rowsByIndex(tx.objectStore(contract.partnerEntryStore), 'byDocument', id),
    rowsByIndex(tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS), 'byDocument', [contract.mode, id]),
    requestToPromise(tx.objectStore(STORE.UNRESOLVED_PRODUCTS).getAll()),
    rowsByIndex(tx.objectStore(STORE.OFFICIAL_COMMANDS), 'byDocument', [contract.mode, id])
  ]);
  await transactionDone(tx);
  return {
    document,
    lines,
    revisions,
    inventoryMovements,
    ledgerEntries,
    pendingInventoryEffects,
    unresolvedProducts: unresolvedProducts.filter(row => text(row.sourceDocumentId) === id
      || row.reviewLinks?.some(link => text(link.sourceDocumentId) === id)),
    commands
  };
}

export const loadOfficialPurchaseAggregate = id => loadAggregate('PURCHASE', id);
export const loadOfficialSaleAggregate = id => loadAggregate('SALE', id);

function commandReceipt(plan, result, status = 'COMMITTED') {
  return {
    commandId: plan.command.commandId,
    idempotencyKey: plan.command.idempotencyKey,
    companyId: plan.command.companyId,
    voucherMode: plan.kind.toLowerCase(),
    documentId: plan.document[plan.kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId'],
    commandType: plan.command.commandType,
    status,
    requestedAt: plan.command.occurredAt,
    committedAt: status === 'COMMITTED' ? nowIso() : '',
    result,
    ...(isOfficialVoucherIdentityV2(plan.command) ? { payloadDigest: text(plan.command.commandPayloadDigest) } : {})
  };
}

function queueRow(plan) {
  const documentId = plan.document[plan.kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId'];
  return {
    queueId: newId('SQ'),
    entityType: 'OFFICIAL_VOUCHER_COMMAND',
    entityId: plan.command.commandId,
    operation: 'UPSERT',
    revision: plan.document.revision,
    payload: {
      schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_PAYLOAD_V1',
      companyId: plan.command.companyId,
      voucherMode: plan.kind.toLowerCase(),
      documentId,
      command: plan.command,
      projectionDigest: canonicalSha256(plan.voucherRevision)
    },
    status: 'WAITING_SERVER_CONTRACT',
    attemptCount: 0,
    createdAt: nowIso(),
    lastError: ''
  };
}

function mergeUnresolvedReviewRecord(existing, effect) {
  const reviewLink = {
    pendingEffectId: effect.pendingEffectId,
    voucherMode: effect.voucherMode,
    sourceDocumentId: effect.sourceDocumentId,
    sourceLineId: effect.sourceLineId,
    sourceDocumentRevision: effect.sourceDocumentRevision,
    voucherRevisionId: effect.voucherRevisionId,
    commandId: effect.commandId,
    warehouseId: effect.warehouseId,
    businessDate: effect.effectiveAt,
    quantity: effect.quantity,
    signedQuantity: effect.signedQuantity,
    unitPrice: effect.unitPrice,
    totalAmount: effect.totalAmount,
    inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
    officialInventoryApplied: false,
    productSnapshot: clone(effect.productSnapshot)
  };
  const priorLinks = Array.isArray(existing?.reviewLinks) ? clone(existing.reviewLinks) : [];
  const reviewLinks = [
    ...priorLinks.filter(row => text(row.pendingEffectId) !== text(reviewLink.pendingEffectId)),
    reviewLink
  ];
  return {
    ...clone(existing || {}),
    unresolvedProductId: effect.unresolvedProductId,
    unresolvedKey: effect.unresolvedProductId,
    companyId: effect.companyId,
    productId: '',
    status: 'UNRESOLVED_PRODUCT',
    inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
    officialInventoryApplied: false,
    productCode: effect.productCode,
    productName: effect.productName,
    originalProductCode: effect.originalProductCode,
    originalProductName: effect.originalProductName,
    specification: effect.specification,
    unit: effect.unit,
    productResolution: clone(effect.productResolution),
    sourceDocumentId: effect.sourceDocumentId,
    sourceLineId: effect.sourceLineId,
    sourceDocumentRevision: effect.sourceDocumentRevision,
    voucherRevisionId: effect.voucherRevisionId,
    reviewLinks,
    createdAt: text(existing?.createdAt) || effect.createdAt,
    updatedAt: effect.createdAt
  };
}

function resolveKnownProductIdentity(line = {}, resolutions = new Map()) {
  const unresolvedProductId = text(line.unresolvedProductId);
  const resolution = unresolvedProductId ? resolutions.get(unresolvedProductId) : null;
  if (!resolution) return line;
  const resolved = clone(line);
  resolved.productId = resolution.productId;
  resolved.unresolvedProductId = '';
  resolved.productIdentityStatus = 'MATCHED';
  resolved.productResolutionId = resolution.resolutionId;
  return resolved;
}

export async function runCentralOfficialVoucherCommand(source = {}) {
  assertSupportedIdentityVersion(source);
  const commandSource = clone(source.intent || source);
  const checkedV2 = isOfficialVoucherIdentityV2(commandSource) ? assertOfficialCommandV2(commandSource) : null;
  const contract = inferKind(commandSource);
  const id = documentIdOf(contract, commandSource);
  const db = await openOrderQDb();
  const storeNames = [contract.documentStore, contract.lineStore, STORE.OFFICIAL_COMMANDS,
    STORE.VOUCHER_REVISIONS, STORE.INVENTORY_MOVEMENTS, contract.partnerEntryStore,
    STORE.PENDING_INVENTORY_EFFECTS, STORE.UNRESOLVED_PRODUCTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(storeNames, 'readwrite');
  const commandStore = tx.objectStore(STORE.OFFICIAL_COMMANDS);
  const commandId = text(commandSource.commandId);
  const existingCommand = await requestToPromise(commandStore.get(commandId));
  if (existingCommand?.status === 'COMMITTED') {
    if (checkedV2 && text(existingCommand.payloadDigest) !== checkedV2.payloadDigest) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_PAYLOAD_CONFLICT');
    }
    if (checkedV2 && (text(existingCommand.companyId) !== checkedV2.companyId
      || text(existingCommand.documentId) !== checkedV2.documentId
      || text(existingCommand.voucherMode) !== checkedV2.kind.toLowerCase())) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_SCOPE_CONFLICT');
    }
    await transactionDone(tx);
    return { ...clone(existingCommand.result), duplicate: true };
  }
  const document = await requestToPromise(tx.objectStore(contract.documentStore).get(id));
  const lines = await rowsByIndex(tx.objectStore(contract.lineStore), 'byDocumentId', id);
  if (checkedV2) {
    if (!document || text(document.companyId) !== checkedV2.companyId
      || text(document.voucherGroupKey) !== checkedV2.voucherGroupKey) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_V2_DOCUMENT_SCOPE_CONFLICT');
    }
    const wrongLine = lines.find(row => text(row.companyId) !== checkedV2.companyId
      || text(row.voucherGroupKey) !== checkedV2.voucherGroupKey
      || text(row[contract.documentId]) !== checkedV2.documentId);
    if (wrongLine) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_V2_LINE_SCOPE_MISMATCH');
    }
  }
  const unresolvedIds = [...new Set([
    ...(Array.isArray(commandSource.lines) ? commandSource.lines : []),
    ...lines
  ].map(row => text(row.unresolvedProductId)).filter(Boolean))];
  const unresolvedStore = tx.objectStore(STORE.UNRESOLVED_PRODUCTS);
  const unresolvedRows = await Promise.all(unresolvedIds.map(unresolvedProductId => requestToPromise(unresolvedStore.get(unresolvedProductId))));
  const wrongCompany = unresolvedRows.find(row => row && text(row.companyId) !== text(commandSource.companyId));
  if (wrongCompany) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error('ORDERQ_OFFICIAL_UNRESOLVED_PRODUCT_COMPANY_MISMATCH');
  }
  const existingUnresolved = new Map(unresolvedRows.filter(Boolean).map(row => [row.unresolvedProductId, row]));
  const resolvedStateConflict = checkedV2 && unresolvedRows.find(row => row?.status === 'MATCHED' && text(row.productId));
  if (resolvedStateConflict) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error('ORDERQ_OFFICIAL_PRODUCT_STATE_CONFLICT');
  }
  const resolutions = new Map(unresolvedRows
    .filter(row => row?.status === 'MATCHED' && text(row.productId))
    .map(row => [row.unresolvedProductId, row]));
  // Product rematch is a later V2 gate. A confirmed V2 intent must keep the
  // exact product identity and Snapshot that passed preflight at confirmation.
  const resolvedCommand = checkedV2 ? commandSource : {
    ...commandSource,
    lines: (Array.isArray(commandSource.lines) ? commandSource.lines : []).map(row => resolveKnownProductIdentity(row, resolutions))
  };
  const resolvedLines = checkedV2 ? lines : lines.map(row => resolveKnownProductIdentity(row, resolutions));
  const plan = planOfficialVoucherCommand({ command: resolvedCommand, document, lines: resolvedLines });
  if (checkedV2) {
    if (text(plan.command.companyId) !== checkedV2.companyId
      || text(plan.document.companyId) !== checkedV2.companyId
      || text(plan.document.voucherGroupKey) !== checkedV2.voucherGroupKey
      || text(plan.voucherRevision.companyId) !== checkedV2.companyId
      || text(plan.voucherRevision.voucherGroupKey) !== checkedV2.voucherGroupKey) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_V2_PROJECTION_SCOPE_MISMATCH');
    }
    const projectedScopeMismatch = plan.lines.some(row => text(row.companyId) !== checkedV2.companyId
      || text(row.voucherGroupKey) !== checkedV2.voucherGroupKey
      || text(row[contract.documentId]) !== checkedV2.documentId);
    if (projectedScopeMismatch) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_V2_LINE_SCOPE_MISMATCH');
    }
  }
  const documentStore = tx.objectStore(contract.documentStore);
  const lineStore = tx.objectStore(contract.lineStore);
  documentStore.put(plan.document);
  [...plan.lines, ...plan.removedLines].forEach(line => lineStore.put({ ...line, companyId: plan.command.companyId }));
  plan.inventoryMovements.forEach(row => tx.objectStore(STORE.INVENTORY_MOVEMENTS).put(row));
  plan.pendingInventoryEffects.forEach(row => tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).put(row));
  plan.pendingInventoryEffects.forEach(row => {
    const existing = existingUnresolved.get(row.unresolvedProductId);
    const record = isOfficialVoucherIdentityV2(plan.command)
      ? mergeUnresolvedReviewRecord(existing, row)
      : existing || {
        unresolvedProductId: row.unresolvedProductId,
        unresolvedKey: row.unresolvedProductId,
        companyId: row.companyId,
        productId: '',
        status: 'UNRESOLVED',
        sourceDocumentId: row.sourceDocumentId,
        createdAt: row.createdAt,
        updatedAt: row.createdAt
      };
    unresolvedStore.put(record);
    existingUnresolved.set(row.unresolvedProductId, record);
  });
  plan.ledgerEntries.forEach(row => tx.objectStore(contract.partnerEntryStore).put(row));
  tx.objectStore(STORE.VOUCHER_REVISIONS).put(plan.voucherRevision);
  const result = {
    authority: 'LOCAL_PILOT',
    document: plan.document,
    lines: plan.lines,
    inventoryMovements: plan.inventoryMovements,
    pendingInventoryEffects: plan.pendingInventoryEffects,
    ledgerEntries: plan.ledgerEntries,
    voucherRevision: plan.voucherRevision,
    duplicate: false
  };
  commandStore.put(commandReceipt(plan, result));
  tx.objectStore(STORE.SYNC_QUEUE).add(queueRow(plan));
  await transactionDone(tx);
  return result;
}

export const applyOfficialVoucherCommand = runCentralOfficialVoucherCommand;

function remoteDraftDocument(command, contract) {
  const document = clone(command.document || {});
  const id = documentIdOf(contract, { ...command, document });
  return {
    ...document,
    [contract.documentId]: id,
    companyId: command.companyId,
    status: 'DRAFT',
    businessStatus: 'DRAFT',
    revision: Number(command.expectedRevision || 0),
    documentContract: 'VOUCHER_CORE_V1',
    createdAt: text(document.createdAt) || text(command.occurredAt),
    createdBy: text(document.createdBy) || text(command.actor),
    updatedAt: text(command.occurredAt),
    updatedBy: text(command.actor)
  };
}

function officialResult(plan, authority) {
  return {
    authority,
    document: plan.document,
    lines: plan.lines,
    inventoryMovements: plan.inventoryMovements,
    pendingInventoryEffects: plan.pendingInventoryEffects,
    ledgerEntries: plan.ledgerEntries,
    voucherRevision: plan.voucherRevision,
    duplicate: false
  };
}

export async function applyRemoteOfficialVoucherCommandPayload(payload = {}) {
  if (text(payload.schemaVersion) !== 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_PAYLOAD_V1') {
    throw new Error('ORDERQ_OFFICIAL_REMOTE_SCHEMA_INVALID');
  }
  const command = clone(payload.command);
  const contract = inferKind(command || {});
  const id = documentIdOf(contract, command || {});
  if (text(payload.companyId) !== text(command.companyId) || text(payload.documentId) !== id
    || text(payload.voucherMode) !== contract.mode) throw new Error('ORDERQ_OFFICIAL_REMOTE_IDENTITY_INVALID');
  const commandId = text(command.commandId);
  const db = await openOrderQDb();
  const storeNames = [contract.documentStore, contract.lineStore, STORE.OFFICIAL_COMMANDS,
    STORE.VOUCHER_REVISIONS, STORE.INVENTORY_MOVEMENTS, contract.partnerEntryStore,
    STORE.PENDING_INVENTORY_EFFECTS, STORE.UNRESOLVED_PRODUCTS];
  const tx = db.transaction(storeNames, 'readwrite');
  const commandStore = tx.objectStore(STORE.OFFICIAL_COMMANDS);
  const existingCommand = await requestToPromise(commandStore.get(commandId));
  if (existingCommand?.status === 'COMMITTED') {
    const digest = canonicalSha256(existingCommand.result?.voucherRevision || {});
    if (digest !== text(payload.projectionDigest)) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_REMOTE_COMMAND_IMMUTABLE');
    }
    await transactionDone(tx);
    return { ...clone(existingCommand.result), duplicate: true };
  }

  let document = await requestToPromise(tx.objectStore(contract.documentStore).get(id));
  let lines = document ? await rowsByIndex(tx.objectStore(contract.lineStore), 'byDocumentId', id) : [];
  const action = text(command.commandType).replace(/_(PURCHASE|SALE)$/, '');
  if (!document) {
    if (action !== 'POST' || Number(command.expectedRevision || 0) !== 1) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_REMOTE_SEQUENCE_GAP');
    }
    document = remoteDraftDocument(command, contract);
    lines = clone(command.lines || []);
  }
  const plan = planOfficialVoucherCommand({ command, document, lines });
  if (canonicalSha256(plan.voucherRevision) !== text(payload.projectionDigest)) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error('ORDERQ_OFFICIAL_REMOTE_PROJECTION_DIGEST_INVALID');
  }

  const unresolvedIds = [...new Set(plan.pendingInventoryEffects.map(row => text(row.unresolvedProductId)).filter(Boolean))];
  const unresolvedStore = tx.objectStore(STORE.UNRESOLVED_PRODUCTS);
  const unresolvedRows = await Promise.all(unresolvedIds.map(unresolvedProductId => requestToPromise(unresolvedStore.get(unresolvedProductId))));
  const conflict = unresolvedRows.find(row => row && (text(row.companyId) !== text(command.companyId)
    || (row.status === 'MATCHED' && text(row.productId))));
  if (conflict) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error('ORDERQ_OFFICIAL_REMOTE_PRODUCT_STATE_CONFLICT');
  }

  tx.objectStore(contract.documentStore).put(plan.document);
  [...plan.lines, ...plan.removedLines].forEach(line => tx.objectStore(contract.lineStore).put({ ...line, companyId: plan.command.companyId }));
  plan.inventoryMovements.forEach(row => tx.objectStore(STORE.INVENTORY_MOVEMENTS).put(row));
  plan.pendingInventoryEffects.forEach(row => tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).put(row));
  const unresolvedById = new Map(unresolvedRows.filter(Boolean).map(row => [row.unresolvedProductId, row]));
  plan.pendingInventoryEffects.forEach(row => {
    const existing = unresolvedById.get(row.unresolvedProductId);
    const record = isOfficialVoucherIdentityV2(plan.command)
      ? mergeUnresolvedReviewRecord(existing, row)
      : existing || { unresolvedProductId: row.unresolvedProductId, unresolvedKey: row.unresolvedProductId,
        companyId: row.companyId, productId: '', status: 'UNRESOLVED', sourceDocumentId: row.sourceDocumentId,
        createdAt: row.createdAt, updatedAt: row.createdAt };
    unresolvedStore.put(record);
    unresolvedById.set(row.unresolvedProductId, record);
  });
  plan.ledgerEntries.forEach(row => tx.objectStore(contract.partnerEntryStore).put(row));
  tx.objectStore(STORE.VOUCHER_REVISIONS).put(plan.voucherRevision);
  const result = officialResult(plan, 'CLOUD_REPLICA');
  commandStore.put(commandReceipt(plan, result));
  await transactionDone(tx);
  return result;
}

export async function applyRemotePendingInventoryResolutionPayload(payload = {}) {
  const resolutionDigest = text(payload.resolutionDigest);
  const plan = clone(payload);
  delete plan.resolutionDigest;
  if (!resolutionDigest || canonicalSha256(plan) !== resolutionDigest) throw new Error('ORDERQ_REMOTE_RESOLUTION_DIGEST_INVALID');
  const companyId = text(plan.companyId);
  const unresolvedProductId = text(plan.unresolvedProductId);
  const productId = text(plan.productId);
  if (!companyId || !unresolvedProductId || !productId
    || text(plan.productResolution?.companyId) !== companyId
    || text(plan.productResolution?.unresolvedProductId) !== unresolvedProductId
    || text(plan.productResolution?.productId) !== productId) {
    throw new Error('ORDERQ_REMOTE_RESOLUTION_IDENTITY_INVALID');
  }
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS, STORE.INVENTORY_MOVEMENTS], 'readwrite');
  const unresolvedStore = tx.objectStore(STORE.UNRESOLVED_PRODUCTS);
  const unresolved = await requestToPromise(unresolvedStore.get(unresolvedProductId));
  if (!unresolved || text(unresolved.companyId) !== companyId) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error('ORDERQ_REMOTE_RESOLUTION_SEQUENCE_GAP');
  }
  if (unresolved.status === 'MATCHED') {
    if (text(unresolved.productId) !== productId) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_REMOTE_RESOLUTION_CONFLICT');
    }
    await transactionDone(tx);
    return { ...plan, duplicate: true };
  }
  unresolvedStore.put({ ...unresolved, ...plan.productResolution, updatedAt: plan.occurredAt });
  (plan.resolvedEffects || []).forEach(row => tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).put(row));
  (plan.inventoryMovements || []).forEach(row => tx.objectStore(STORE.INVENTORY_MOVEMENTS).put(row));
  await transactionDone(tx);
  return { ...plan, duplicate: false };
}

export async function recordInventoryCheckpoint(source = {}) {
  const checkpoint = createInventoryCheckpoint(source);
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.INVENTORY_CHECKPOINTS, 'readwrite');
  tx.objectStore(STORE.INVENTORY_CHECKPOINTS).put(checkpoint);
  await transactionDone(tx);
  return checkpoint;
}

export async function resolveUnresolvedProductInventory(source = {}) {
  const companyId = text(source.companyId);
  const unresolvedProductId = text(source.unresolvedProductId);
  const db = await openOrderQDb();
  const storeNames = [STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_CHECKPOINTS, STORE.INVENTORY_MOVEMENTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(storeNames, 'readwrite');
  const unresolved = await requestToPromise(tx.objectStore(STORE.UNRESOLVED_PRODUCTS).get(unresolvedProductId));
  if (!unresolved || unresolved.companyId !== companyId) throw new Error('ORDERQ_REMATCH_UNRESOLVED_PRODUCT_NOT_FOUND');
  if (unresolved.status === 'MATCHED') {
    await transactionDone(tx);
    return { duplicate: true, productResolution: unresolved, resolvedEffects: [], inventoryMovements: [] };
  }
  const pendingEffects = await requestToPromise(tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS)
    .index('byUnresolvedStatus').getAll([unresolvedProductId, 'PENDING_PRODUCT_MATCH']));
  const inventoryCheckpoints = await requestToPromise(tx.objectStore(STORE.INVENTORY_CHECKPOINTS).getAll());
  const plan = planPendingInventoryResolution({ ...source, pendingEffects, inventoryCheckpoints });
  tx.objectStore(STORE.UNRESOLVED_PRODUCTS).put({ ...unresolved, ...plan.productResolution, updatedAt: plan.occurredAt });
  plan.resolvedEffects.forEach(row => tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).put(row));
  plan.inventoryMovements.forEach(row => tx.objectStore(STORE.INVENTORY_MOVEMENTS).put(row));
  tx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: newId('SQ'),
    entityType: 'PENDING_INVENTORY_RESOLUTION',
    entityId: plan.resolutionId,
    operation: 'UPSERT',
    revision: 1,
    payload: { ...plan, resolutionDigest: canonicalSha256(plan) },
    status: 'WAITING_SERVER_CONTRACT',
    attemptCount: 0,
    createdAt: nowIso(),
    lastError: ''
  });
  await transactionDone(tx);
  return { ...plan, duplicate: false };
}
