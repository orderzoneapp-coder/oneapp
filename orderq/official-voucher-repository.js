import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { canonicalSha256, planOfficialVoucherCommand, voucherStableId } from './official-voucher-core.js?v=0.24.0';
import {
  assertInventoryRematchCommandV2,
  createInventoryCheckpoint,
  INVENTORY_REMATCH_AUDIT_SCHEMA_V2,
  planInventoryRematchCommandV2
} from './inventory-rematch-core.js?v=0.3.0';
import {
  assertOfficialCommandV2,
  assertOfficialLedgerProjectionV2,
  assertOfficialPartnerResolutionV2,
  assertOfficialProductResolutionV2,
  isOfficialVoucherIdentityV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
} from './official-voucher-v2-contract.js?v=0.5.0';
import {
  assertOfficialStocktakeDecisionEnvelopeV2,
  assertOfficialStocktakeProjectionV2,
  inspectOfficialStocktakeConflictsV2
} from './stocktake-conflict-v2.js?v=0.2.0';
import { previewUnresolvedRematchImpact } from './unresolved-review-read-model.js?v=0.3.0';
import {
  getProductSnapshot,
  PRODUCT_SNAPSHOT_SCHEMA_VERSION
} from '../reference-data/product-master-read-adapter.js?v=1.0.0';
import { getCustomerSnapshot } from '../customer-master/read-adapter.js?v=1.0.0';
import { sha256Hex } from '../reference-data/change-request-contract.js?v=1.0.0';
import {
  assertOfficialRevisionTargetV2,
  assertOfficialVoucherRevisionCommandV2,
  OFFICIAL_REVISION_TARGET_SCHEMA_V2,
  planOfficialVoucherRevisionCommandV2,
  withOfficialRevisionTargetDigestV2
} from './official-voucher-revision-core.js?v=0.1.0';

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
      documentEntity: 'PURCHASE_DOCUMENT',
      lineEntity: 'PURCHASE_LINE',
      revisionEntity: 'PURCHASE_REVISION',
      partnerEntryStore: STORE.PAYABLE_ENTRIES
    }
    : {
      kind: normalized,
      mode: 'sale',
      documentStore: STORE.SALES_DOCUMENTS,
      lineStore: STORE.SALES_LINES,
      documentId: 'salesDocumentId',
      lineId: 'salesLineId',
      documentEntity: 'SALE_DOCUMENT',
      lineEntity: 'SALE_LINE',
      revisionEntity: 'SALE_REVISION',
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
  const draftStores = [contract.documentStore, contract.lineStore];
  if (checkedV2) draftStores.push(STORE.INVENTORY_CHECKPOINTS);
  const tx = db.transaction(draftStores, 'readwrite');
  const documentStore = tx.objectStore(contract.documentStore);
  const [existing, checkpoints] = await Promise.all([
    requestToPromise(documentStore.get(document[contract.documentId])),
    checkedV2
      ? checkpointRowsForCommand(tx.objectStore(STORE.INVENTORY_CHECKPOINTS), commandEnvelope)
      : Promise.resolve([])
  ]);
  if (existing) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw new Error(`ORDERQ_OFFICIAL_DRAFT_EXISTS:${document[contract.documentId]}`);
  }
  if (checkedV2) {
    try {
      assertOfficialStocktakeDecisionEnvelopeV2(commandEnvelope, checkpoints);
    } catch (error) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw error;
    }
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

async function checkpointRowsForCommand(store, command = {}) {
  const companyId = text(command.companyId || command.document?.companyId);
  const warehouseIds = [...new Set((command.lines || [])
    .map(row => text(row.warehouseId || command.document?.warehouseId))
    .filter(Boolean))];
  const keyRange = globalThis.IDBKeyRange;
  if (!companyId || !warehouseIds.length || !keyRange
    || !store.indexNames.contains('byCompanyWarehouseEffectiveAt')) {
    return requestToPromise(store.getAll());
  }
  const index = store.index('byCompanyWarehouseEffectiveAt');
  const batches = await Promise.all(warehouseIds.map(warehouseId => requestToPromise(index.getAll(
    keyRange.bound([companyId, warehouseId, ''], [companyId, warehouseId, '\uffff'])
  ))));
  return batches.flat();
}

export async function inspectOfficialStocktakeConflicts(source = {}) {
  assertSupportedIdentityVersion(source);
  const command = clone(source.intent || source.commandEnvelope || source.commandSource || source);
  const checked = isOfficialVoucherIdentityV2(command) ? assertOfficialCommandV2(command) : null;
  if (!checked) return deepFreeze({ conflicts: [], identityVersion: '' });
  const contract = inferKind(command);
  if (checked.kind !== contract.kind) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_KIND_MISMATCH');
  const id = documentIdOf(contract, command);
  const db = await openOrderQDb();
  const tx = db.transaction([contract.documentStore, STORE.INVENTORY_CHECKPOINTS], 'readonly');
  const [existingDocument, checkpoints] = await Promise.all([
    requestToPromise(tx.objectStore(contract.documentStore).get(id)),
    checkpointRowsForCommand(tx.objectStore(STORE.INVENTORY_CHECKPOINTS), command)
  ]);
  await transactionDone(tx);
  if (existingDocument) {
    if (text(existingDocument.companyId) !== checked.companyId
      || text(existingDocument.voucherGroupKey) !== checked.voucherGroupKey) {
      throw new Error('ORDERQ_OFFICIAL_V2_DOCUMENT_SCOPE_CONFLICT');
    }
    return deepFreeze({
      schemaVersion: command.schemaVersion,
      identityVersion: command.identityVersion,
      companyId: checked.companyId,
      voucherMode: checked.kind.toLowerCase(),
      documentId: checked.documentId,
      conflicts: [],
      existingDocument: true
    });
  }
  const assessment = inspectOfficialStocktakeConflictsV2({ command, inventoryCheckpoints: checkpoints });
  if (Array.isArray(command.stocktakeDecisions) && command.stocktakeDecisions.length) {
    assertOfficialStocktakeDecisionEnvelopeV2(command, checkpoints);
  }
  return assessment;
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

function revisionLineSnapshot(revision = {}) {
  return Array.isArray(revision.afterSnapshot?.lines) ? revision.afterSnapshot.lines : [];
}

function revisionDocumentSnapshot(revision = {}) {
  return revision.afterSnapshot?.document || revision.afterSnapshot || null;
}

function confirmedStatus(value) {
  return text(value).toUpperCase() === 'CONFIRMED';
}

function partnerIdFor(contract, document) {
  return contract.kind === 'PURCHASE' ? text(document.supplierCustomerId)
    : text(document.billingCustomerId || document.salesCustomerId);
}

function initialRevisionDocumentProjection(contract, document) {
  return {
    companyId: text(document.companyId),
    voucherMode: contract.mode,
    documentId: text(document[contract.documentId]),
    revision: Number(document.revision),
    status: text(document.status).toUpperCase(),
    partnerId: partnerIdFor(contract, document),
    warehouseId: text(document.warehouseId),
    supplyAmount: Number(document.supplyAmount),
    vatAmount: document.vatAmount ?? null,
    totalAmount: Number(document.totalAmount),
    schemaVersion: text(document.schemaVersion),
    identityVersion: text(document.identityVersion),
    entityType: contract.revisionEntity,
    voucherGroupKey: text(document.voucherGroupKey),
    officialPartnerResolution: clone(document.officialPartnerResolution)
  };
}

function initialRevisionLineProjection(contract, line) {
  return {
    lineId: text(line[contract.lineId]),
    lineIdentityId: text(line.lineIdentityId),
    productId: text(line.productId),
    unresolvedProductId: text(line.unresolvedProductId),
    warehouseId: text(line.warehouseId),
    quantity: Number(line.actualQuantity),
    baseQuantity: Number(line.baseQuantity),
    unitPrice: Number(line.unitPrice),
    supplyAmount: Number(line.supplyAmount),
    vatAmount: line.vatAmount ?? null,
    totalAmount: Number(line.totalAmount),
    schemaVersion: text(line.schemaVersion),
    identityVersion: text(line.identityVersion),
    entityType: text(line.entityType),
    companyId: text(line.companyId),
    voucherGroupKey: text(line.voucherGroupKey),
    productCode: text(line.productCode),
    productName: text(line.productName),
    specification: text(line.specification),
    unit: text(line.unit || line.actualUnit),
    originalProductCode: text(line.originalProductCode),
    originalProductName: text(line.originalProductName),
    productSnapshot: clone(line.productSnapshot)
  };
}

function assertCurrentRevisionProjection(contract, document, lines, revision) {
  if (!revision || canonicalSha256(revision.beforeSnapshot) !== text(revision.beforeDigest)
    || canonicalSha256(revision.afterSnapshot) !== text(revision.afterDigest)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_HASH_INVALID');
  }
  if (!confirmedStatus(document.status) || !confirmedStatus(document.businessStatus)
    || !confirmedStatus(revision.status)
    || text(document.commandId) !== text(revision.commandId)
    || text(document.lastVoucherRevisionId) !== text(revision.voucherRevisionId)
    || text(document.companyId) !== text(revision.companyId)
    || text(document[contract.documentId]) !== text(revision.documentId)
    || Number(document.revision) !== Number(revision.revision)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_LINK_INVALID');
  }
  const snapshotDocument = revisionDocumentSnapshot(revision);
  const snapshotLines = revisionLineSnapshot(revision);
  if (!snapshotDocument || snapshotLines.length !== lines.length) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_PROJECTION_INVALID');
  }
  const fullSnapshot = text(revision.afterSnapshot?.schemaVersion) === OFFICIAL_REVISION_TARGET_SCHEMA_V2
    && revision.afterSnapshot?.document;
  if (fullSnapshot) {
    const currentLines = [...lines].sort((left, right) => text(left[contract.lineId]).localeCompare(text(right[contract.lineId])));
    const storedLines = [...snapshotLines].sort((left, right) => text(left[contract.lineId]).localeCompare(text(right[contract.lineId])));
    if (canonicalSha256(document) !== canonicalSha256(snapshotDocument)
      || canonicalSha256(currentLines) !== canonicalSha256(storedLines)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_FULL_SNAPSHOT_MISMATCH');
    }
    return;
  }
  const snapshotDocumentProjection = { ...clone(snapshotDocument) };
  delete snapshotDocumentProjection.lines;
  if (canonicalSha256(initialRevisionDocumentProjection(contract, document))
    !== canonicalSha256(snapshotDocumentProjection)
    || text(revision.businessDate) !== text(document.businessDate)
    || text(document[contract.kind === 'PURCHASE' ? 'purchaseDate' : 'saleDate']) !== text(document.businessDate)
    || text(revision.voucherGroupKey) !== text(document.voucherGroupKey)
    || text(revision.entityType) !== contract.revisionEntity) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_BUSINESS_SNAPSHOT_MISMATCH');
  }
  assertOfficialPartnerResolutionV2(document, document.companyId);
  const lineById = new Map(lines.map(line => [text(line[contract.lineId]), line]));
  snapshotLines.forEach(snapshot => {
    const current = lineById.get(text(snapshot.lineId || snapshot[contract.lineId]));
    if (!current || text(current.companyId) !== text(document.companyId)
      || Number(current.revision) !== Number(document.revision)
      || text(current.lineStatus).toUpperCase() !== 'ACTIVE'
      || text(current.status).toUpperCase() !== 'CONFIRMED'
      || text(current.commandId) !== text(revision.commandId)
      || text(current.entityType) !== contract.lineEntity
      || text(current[contract.documentId]) !== text(document[contract.documentId])
      || canonicalSha256(initialRevisionLineProjection(contract, current)) !== canonicalSha256(snapshot)
      || (text(current.businessDate) && text(current.businessDate) !== text(document.businessDate))
      || (text(current.businessOccurredAt) && !text(current.businessOccurredAt).startsWith(`${text(document.businessDate)}T`))) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_LINE_MISMATCH');
    }
    const resolution = assertOfficialProductResolutionV2(current, document.companyId);
    if (canonicalSha256(resolution) !== canonicalSha256(current.productSnapshot?.matchEvidence?.officialProductResolution)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_PRODUCT_RESOLUTION_MISMATCH');
    }
  });
}

function movementIsCurrent(row, reversedIds) {
  return !reversedIds.has(text(row.movementId));
}

function lineSignedQuantity(contract, line) {
  const quantity = Number(line.actualQuantity ?? line.quantity);
  if (!Number.isFinite(quantity) || Number(line.baseQuantity) !== quantity || Number(line.inventoryEffectFactor) !== 1) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_SOURCE_FACTOR_INVALID');
  }
  const signed = (contract.kind === 'PURCHASE' ? 1 : -1) * quantity;
  return Object.is(signed, -0) ? 0 : signed;
}

function movementBusinessDate(row) {
  return text(row.businessDate || row.effectiveAt);
}

function movementDatesMatch(row, expectedBusinessDate) {
  const businessDate = text(row.businessDate);
  const effectiveAt = text(row.effectiveAt);
  return Boolean(businessDate || effectiveAt)
    && (!businessDate || businessDate === expectedBusinessDate)
    && (!effectiveAt || effectiveAt === expectedBusinessDate);
}

function sourceRevisionForMovement(contract, document, revisions, row) {
  const revision = revisions.find(item => text(item.companyId) === text(document.companyId)
    && text(item.voucherMode).toLowerCase() === contract.mode
    && text(item.documentId) === text(document[contract.documentId])
    && Number(item.revision) === Number(row.sourceDocumentRevision));
  if (!revision || canonicalSha256(revision.beforeSnapshot) !== text(revision.beforeDigest)
    || canonicalSha256(revision.afterSnapshot) !== text(revision.afterDigest)) return null;
  return revision;
}

function effectMember(revision, row) {
  const members = (revision?.effects || []).filter(effect => text(effect.id) === text(row.movementId));
  if (members.length !== 1) throw new Error('ORDERQ_OFFICIAL_REVISION_EFFECT_MEMBERSHIP_INVALID');
  const effect = members[0];
  const rematch = text(revision?.voucherMode).toLowerCase() === 'inventory-rematch';
  const revisionAfter = revision?.afterSnapshot?.schemaVersion === OFFICIAL_REVISION_TARGET_SCHEMA_V2;
  const initialV2 = revision?.afterSnapshot?.schemaVersion === 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2';
  const required = rematch
    ? ['type', 'pendingEffectId', 'status', 'stocktakeEffectStatus', 'officialInventoryApplied',
      'signedQuantity', 'originalSignedQuantity']
    : revisionAfter
      ? ['type', 'status', 'reversalStatus', 'stocktakeEffectStatus', 'officialInventoryApplied', 'effectRole',
        'signedQuantity', 'originalSignedQuantity']
      : initialV2
        ? ['type', 'status', 'stocktakeEffectStatus', 'officialInventoryApplied', 'effectRole']
        : ['type'];
  if (required.some(key => !Object.prototype.hasOwnProperty.call(effect, key))
    || (rematch
      ? !['INVENTORY', 'INVENTORY_CHECKPOINT_ABSORPTION'].includes(text(effect.type))
        || !text(effect.pendingEffectId)
      : text(effect.type) !== 'INVENTORY')
    || (required.includes('status') && !text(effect.status))
    || (required.includes('effectRole') && !text(effect.effectRole))
    || (required.includes('officialInventoryApplied') && typeof effect.officialInventoryApplied !== 'boolean')
    || (required.includes('signedQuantity') && !Number.isFinite(Number(effect.signedQuantity)))
    || (required.includes('originalSignedQuantity') && !Number.isFinite(Number(effect.originalSignedQuantity)))) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_EFFECT_MEMBERSHIP_INVALID');
  }
  const comparisons = [
    ['status', 'effectStatus'], ['reversalStatus', 'reversalStatus'],
    ['stocktakeEffectStatus', 'stocktakeEffectStatus'],
    ['officialInventoryApplied', 'officialInventoryApplied'], ['effectRole', 'effectRole'],
    ['pendingEffectId', 'pendingEffectId'], ['signedQuantity', 'signedQuantity'],
    ['originalSignedQuantity', 'originalSignedQuantity']
  ];
  comparisons.forEach(([effectKey, rowKey]) => {
    if (!Object.prototype.hasOwnProperty.call(effect, effectKey)) return;
    const numeric = ['signedQuantity', 'originalSignedQuantity'].includes(effectKey);
    const boolean = effectKey === 'officialInventoryApplied';
    const equal = numeric ? Number(effect[effectKey]) === Number(row[rowKey])
      : boolean ? effect[effectKey] === row[rowKey] : text(effect[effectKey]) === text(row[rowKey]);
    if (!equal) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_EFFECT_MEMBERSHIP_MISMATCH');
    }
  });
  return effect;
}

function assertMovementLineage(contract, document, movements, revisions) {
  const byId = new Map(movements.map(row => [text(row.movementId), row]));
  const reversalCounts = new Map();
  movements.forEach(row => {
    if (!Number.isInteger(Number(row.sourceDocumentRevision))
      || Number(row.sourceDocumentRevision) > Number(document.revision)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_LINEAGE_INVALID');
    }
    let revision;
    if (text(row.pendingEffectId)) {
      revision = revisions.find(item => text(item.companyId) === text(document.companyId)
        && text(item.voucherMode).toLowerCase() === 'inventory-rematch'
        && text(item.commandId) === text(row.commandId));
    } else {
      revision = sourceRevisionForMovement(contract, document, revisions, row);
      if (revision && text(revision.commandId) !== text(row.commandId)) revision = null;
    }
    if (!revision) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_LINEAGE_INVALID');
    effectMember(revision, row);
    const reversalOf = text(row.reversalOfMovementId);
    if ((text(row.effectRole) === 'REVISION_REVERSAL') !== Boolean(reversalOf)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REVERSAL_LINEAGE_INVALID');
    }
    if (!reversalOf) return;
    reversalCounts.set(reversalOf, (reversalCounts.get(reversalOf) || 0) + 1);
    const source = byId.get(reversalOf);
    if (!source || text(source.effectRole) === 'REVISION_REVERSAL'
      || text(source.companyId) !== text(row.companyId)
      || text(source.voucherMode).toLowerCase() !== text(row.voucherMode).toLowerCase()
      || text(source.sourceDocumentId) !== text(row.sourceDocumentId)
      || text(source.sourceLineId) !== text(row.sourceLineId)
      || text(source.productId) !== text(row.productId)
      || text(source.productCode) !== text(row.productCode)
      || text(source.warehouseId) !== text(row.warehouseId)
      || movementBusinessDate(source) !== movementBusinessDate(row)
      || text(source.businessOccurredAt) !== text(row.businessOccurredAt)
      || Number(row.sourceDocumentRevision) <= Number(source.sourceDocumentRevision)
      || Number(row.reversesOriginalSignedQuantity) !== Number(source.originalSignedQuantity ?? source.signedQuantity)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REVERSAL_LINEAGE_INVALID');
    }
  });
  if ([...reversalCounts.values()].some(count => count !== 1)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REVERSAL_LINEAGE_INVALID');
  }
}

function activeMovementRows(movements, lineId) {
  const reversedIds = new Set(movements.map(row => text(row.reversalOfMovementId)).filter(Boolean));
  return movements.filter(row => text(row.sourceLineId) === text(lineId)
    && text(row.effectRole) !== 'REVISION_REVERSAL' && movementIsCurrent(row, reversedIds));
}

function sameEffectIds(left, right) {
  const ids = rows => rows.map(row => text(row.movementId)).sort();
  return canonicalSha256(ids(left)) === canonicalSha256(ids(right));
}

function assertDocumentActiveSetCoverage(movements, pendingEffects, effectiveLineStates) {
  const reversedIds = new Set(movements.map(row => text(row.reversalOfMovementId)).filter(Boolean));
  const actualMovementIds = movements.filter(row => text(row.effectRole) !== 'REVISION_REVERSAL'
    && movementIsCurrent(row, reversedIds)).map(row => text(row.movementId)).sort();
  const expectedMovementIds = effectiveLineStates.flatMap(state =>
    (state.activeInventoryEffects || []).map(row => text(row.movementId))).sort();
  if (actualMovementIds.some(id => !id) || expectedMovementIds.some(id => !id)
    || canonicalSha256(actualMovementIds) !== canonicalSha256(expectedMovementIds)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_COVERAGE_MISMATCH');
  }
  const actualPendingIds = pendingEffects.filter(row => text(row.status) === 'PENDING_PRODUCT_MATCH')
    .map(row => text(row.pendingEffectId)).sort();
  const expectedPendingIds = effectiveLineStates.flatMap(state => state.activePendingEffect
    ? [text(state.activePendingEffect.pendingEffectId)] : []).sort();
  if (actualPendingIds.some(id => !id) || expectedPendingIds.some(id => !id)
    || canonicalSha256(actualPendingIds) !== canonicalSha256(expectedPendingIds)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_PENDING_COVERAGE_MISMATCH');
  }
}

function assertAppliedEffectState(row, expectedSignedQuantity, { revisionAfter = false } = {}) {
  const applied = row.officialInventoryApplied === true;
  const signed = Number(row.signedQuantity);
  const original = row.originalSignedQuantity === undefined ? signed : Number(row.originalSignedQuantity);
  const stocktake = text(row.stocktakeEffectStatus);
  if (![signed, original].every(Number.isFinite) || original !== expectedSignedQuantity) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_QUANTITY_MISMATCH');
  }
  if (!stocktake) {
    if (!applied || signed !== expectedSignedQuantity
      || text(row.effectStatus) !== (expectedSignedQuantity === 0 ? 'ZERO_EFFECT' : 'APPLIED_NORMAL')) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_STATUS_INVALID');
    }
    return;
  }
  if (stocktake === 'ABSORBED_BY_CHECKPOINT') {
    if (applied || signed !== 0 || text(row.effectRole) === 'LATE_ADJUSTMENT'
      || (expectedSignedQuantity === 0 ? text(row.effectStatus) !== 'ZERO_EFFECT'
        : revisionAfter ? text(row.effectStatus) !== 'APPLIED_NORMAL'
          : text(row.effectStatus) !== 'ABSORBED_BY_CHECKPOINT')) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_ABSORPTION_INVALID');
    }
    return;
  }
  if (stocktake === 'APPLIED_AS_LATE_ADJUSTMENT') {
    const source = text(row.effectRole) === 'SOURCE_VOUCHER_EFFECT';
    const expectedStatus = expectedSignedQuantity === 0 ? 'ZERO_EFFECT'
      : revisionAfter ? 'APPLIED_NORMAL' : 'APPLIED_AS_LATE_ADJUSTMENT';
    if ((source ? (applied || signed !== 0) : (!applied || signed !== expectedSignedQuantity))
      || text(row.effectStatus) !== expectedStatus) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_LATE_INVALID');
    }
    return;
  }
  throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_STOCKTAKE_STATUS_INVALID');
}

function assertRematchMovement(contract, document, line, row, signedQuantity, pendingEffects, unresolvedRows) {
  const pending = pendingEffects.find(item => text(item.pendingEffectId) === text(row.pendingEffectId));
  const unresolved = unresolvedRows.find(item => text(item.unresolvedProductId) === text(pending?.unresolvedProductId));
  if (!pending || !unresolved || text(pending.companyId) !== text(document.companyId)
    || !/^RESOLVED/.test(text(pending.status))
    || text(pending.sourceDocumentId) !== text(document[contract.documentId])
    || text(pending.sourceLineId) !== text(line[contract.lineId])
    || Number(pending.sourceDocumentRevision) !== Number(row.sourceDocumentRevision)
    || text(pending.voucherRevisionId) !== text(row.sourceVoucherRevisionId)
    || text(pending.warehouseId) !== text(row.warehouseId)
    || text(pending.effectiveAt) !== movementBusinessDate(row)
    || Number(pending.signedQuantity) !== signedQuantity
    || text(pending.productId) !== text(row.productId)
    || text(pending.productCode) !== text(row.productCode)
    || text(pending.resolutionCommandId) !== text(row.commandId)
    || text(pending.resolutionId) !== text(row.resolutionId)
    || text(unresolved.companyId) !== text(document.companyId)
    || text(unresolved.status) !== 'MATCHED'
    || text(unresolved.productId) !== text(row.productId)
    || text(unresolved.resolutionCommandId) !== text(row.commandId)
    || text(unresolved.resolutionId) !== text(row.resolutionId)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REMATCH_EFFECT_INVALID');
  }
  const type = text(row.movementType);
  const stocktake = text(row.stocktakeEffectStatus);
  const expectedType = stocktake === 'ABSORBED_BY_CHECKPOINT' ? 'STOCKTAKE_CHECKPOINT_ABSORPTION'
    : stocktake === 'APPLIED_AS_LATE_ADJUSTMENT' ? 'STOCKTAKE_LATE_ADJUSTMENT'
      : 'PENDING_PRODUCT_MATCH_RESOLVED';
  if (type !== expectedType || text(row.effectRole)
    || Number(row.inventoryEffectFactor) !== 1) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_REMATCH_EFFECT_TYPE_INVALID');
  }
  assertAppliedEffectState(row, signedQuantity);
}

function assertPendingReviewLink(pending, unresolved) {
  const links = (unresolved?.reviewLinks || []).filter(link =>
    text(link.pendingEffectId) === text(pending?.pendingEffectId));
  if (!pending || !unresolved || links.length !== 1) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_PENDING_REVIEW_LINK_INVALID');
  }
  const link = links[0];
  const expected = {
    companyId: text(pending.companyId), voucherMode: text(pending.voucherMode).toLowerCase(),
    sourceDocumentId: text(pending.sourceDocumentId), sourceLineId: text(pending.sourceLineId),
    sourceDocumentRevision: Number(pending.sourceDocumentRevision),
    voucherRevisionId: text(pending.voucherRevisionId), commandId: text(pending.commandId),
    warehouseId: text(pending.warehouseId), businessDate: text(pending.effectiveAt),
    businessOccurredAt: text(pending.businessOccurredAt), quantity: Number(pending.quantity),
    signedQuantity: Number(pending.signedQuantity), unitPrice: Number(pending.unitPrice),
    totalAmount: Number(pending.totalAmount), productSnapshot: pending.productSnapshot,
    productResolution: pending.productResolution
  };
  const actual = {
    companyId: text(link.companyId), voucherMode: text(link.voucherMode).toLowerCase(),
    sourceDocumentId: text(link.sourceDocumentId), sourceLineId: text(link.sourceLineId),
    sourceDocumentRevision: Number(link.sourceDocumentRevision),
    voucherRevisionId: text(link.voucherRevisionId), commandId: text(link.commandId),
    warehouseId: text(link.warehouseId), businessDate: text(link.businessDate),
    businessOccurredAt: text(link.businessOccurredAt), quantity: Number(link.quantity),
    signedQuantity: Number(link.signedQuantity), unitPrice: Number(link.unitPrice),
    totalAmount: Number(link.totalAmount), productSnapshot: link.productSnapshot,
    productResolution: link.productResolution
  };
  if (canonicalSha256(actual) !== canonicalSha256(expected)
    || text(unresolved.unresolvedProductId) !== text(pending.unresolvedProductId)
    || text(unresolved.companyId) !== text(pending.companyId)
    || text(unresolved.status) !== 'UNRESOLVED_PRODUCT'
    || text(unresolved.inventoryEffectStatus) !== 'UNRESOLVED_PRODUCT'
    || unresolved.officialInventoryApplied !== false
    || text(link.inventoryEffectStatus) !== 'UNRESOLVED_PRODUCT'
    || link.officialInventoryApplied !== false) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_PENDING_REVIEW_LINK_MISMATCH');
  }
  return link;
}

function assertActivePending(contract, document, line, pending, revision, unresolvedRows) {
  const unresolved = unresolvedRows.find(row => text(row.unresolvedProductId) === text(pending?.unresolvedProductId));
  assertPendingReviewLink(pending, unresolved);
  const expectedDate = text(line.businessDate || document.businessDate || document.purchaseDate || document.saleDate);
  const expectedOccurredAt = text(line.businessOccurredAt || document.businessOccurredAt || document.businessEffectiveAt);
  if (text(pending.status) !== 'PENDING_PRODUCT_MATCH'
    || text(pending.inventoryEffectStatus) !== 'UNRESOLVED_PRODUCT'
    || pending.officialInventoryApplied !== false
    || text(pending.companyId) !== text(document.companyId)
    || text(pending.voucherMode).toLowerCase() !== contract.mode
    || text(pending.sourceDocumentId) !== text(document[contract.documentId])
    || text(pending.sourceLineId) !== text(line[contract.lineId])
    || Number(pending.sourceDocumentRevision) !== Number(document.revision)
    || text(pending.voucherRevisionId) !== text(revision.voucherRevisionId)
    || text(pending.commandId) !== text(revision.commandId)
    || text(pending.warehouseId) !== text(line.warehouseId)
    || text(pending.effectiveAt) !== expectedDate
    || text(pending.businessOccurredAt) !== expectedOccurredAt
    || Number(pending.quantity) !== Number(line.actualQuantity ?? line.quantity)
    || Number(pending.signedQuantity) !== lineSignedQuantity(contract, line)
    || Number(pending.unitPrice) !== Number(line.unitPrice)
    || Number(pending.totalAmount) !== Number(line.totalAmount)
    || canonicalSha256(pending.productSnapshot) !== canonicalSha256(line.productSnapshot)
    || canonicalSha256(pending.productResolution) !== canonicalSha256(line.officialProductResolution)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_PENDING_INVALID');
  }
}

function assertCurrentMovementGroup(contract, document, line, movements, signedQuantity,
  { revisions = [], pendingEffects = [], unresolvedRows = [], state = null } = {}) {
  if (!movements.length) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_REQUIRED');
  const expectedProductId = text(state?.productId || line.productId);
  const expectedProductCode = text(state?.productCode || line.productSnapshot?.productCode || line.productCode);
  const expectedWarehouseId = text(state?.warehouseId || line.warehouseId);
  const expectedBusinessDate = text(state?.businessDate || line.businessDate || document.businessDate
    || document.purchaseDate || document.saleDate);
  const expectedBusinessOccurredAt = text(state?.businessOccurredAt || line.businessOccurredAt
    || document.businessOccurredAt || document.businessEffectiveAt);
  const invalid = movements.find(row => text(row.companyId) !== text(document.companyId)
    || text(row.voucherMode).toLowerCase() !== contract.mode
    || text(row.sourceDocumentId) !== text(document[contract.documentId])
    || text(row.sourceLineId) !== text(line[contract.lineId])
    || text(row.productId) !== expectedProductId
    || text(row.productCode) !== expectedProductCode
    || text(row.warehouseId) !== expectedWarehouseId
    || !movementDatesMatch(row, expectedBusinessDate)
    || text(row.businessOccurredAt) !== expectedBusinessOccurredAt
    || Number(row.inventoryEffectFactor ?? 1) !== 1
    || !Number.isInteger(Number(row.sourceDocumentRevision))
    || Number(row.sourceDocumentRevision) > Number(document.revision)
    || text(row.reversalStatus) || text(row.reversalOfMovementId));
  if (invalid) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_INVALID');
  const rematchRows = movements.filter(row => text(row.pendingEffectId));
  if (rematchRows.length) {
    if (rematchRows.length !== movements.length || rematchRows.length !== 1) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REMATCH_EFFECT_INVALID');
    }
    assertRematchMovement(contract, document, line, rematchRows[0], signedQuantity, pendingEffects, unresolvedRows);
  } else {
    movements.forEach(row => {
      const sourceRevision = sourceRevisionForMovement(contract, document, revisions, row);
      const role = text(row.effectRole);
      const revisionAfter = role === 'REVISION_AFTER_EFFECT';
      const sourceVoucher = !role || role === 'SOURCE_VOUCHER_EFFECT' || role === 'LATE_ADJUSTMENT';
      if (!sourceRevision || text(sourceRevision.commandId) !== text(row.commandId)
        || (text(row.sourceVoucherRevisionId) && text(row.sourceVoucherRevisionId) !== text(sourceRevision.voucherRevisionId))
        || (revisionAfter && text(row.movementType) !== 'OFFICIAL_REVISION_APPLICATION')
        || (sourceVoucher && ![`${contract.kind}_POST`, 'STOCKTAKE_LATE_ADJUSTMENT'].includes(text(row.movementType)))
        || (!revisionAfter && !sourceVoucher)) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_LINEAGE_INVALID');
      }
      if (role === 'LATE_ADJUSTMENT') {
        const source = movements.find(item => text(item.movementId) === text(row.sourceMovementId)
          && text(item.effectRole) === 'SOURCE_VOUCHER_EFFECT');
        if (!source) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_LATE_SOURCE_INVALID');
      }
      assertAppliedEffectState(row, signedQuantity, { revisionAfter });
    });
  }
  const applied = movements.filter(row => row.officialInventoryApplied === true)
    .reduce((sum, row) => sum + Number(row.signedQuantity), 0);
  if (!Number.isFinite(applied) || (applied !== signedQuantity && applied !== 0)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_QUANTITY_MISMATCH');
  }
}

function normalizeStoredEffectiveStates(contract, document, lines, revision, movements, pendingEffects,
  revisions, unresolvedRows) {
  const stored = revision.afterSnapshot?.schemaVersion === OFFICIAL_REVISION_TARGET_SCHEMA_V2
    ? revision.afterSnapshot.effectiveLineStates : null;
  if (!Array.isArray(stored) || stored.length !== lines.length) return null;
  const movementById = new Map(movements.map(row => [text(row.movementId), row]));
  const pendingById = new Map(pendingEffects.map(row => [text(row.pendingEffectId), row]));
  const lineById = new Map(lines.map(line => [text(line[contract.lineId]), line]));
  return stored.map(source => {
    const state = clone(source);
    const line = lineById.get(text(state.lineId));
    if (!line) throw new Error('ORDERQ_OFFICIAL_REVISION_EFFECT_LINE_MISMATCH');
    if (state.status === 'MATCHED') {
      const activeInventoryEffects = (state.activeInventoryEffects || []).map(effect => {
        const current = movementById.get(text(effect.movementId));
        if (!current || canonicalSha256(current) !== canonicalSha256(effect)) {
          throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_STALE');
        }
        return current;
      });
      const actualActive = activeMovementRows(movements, line[contract.lineId]);
      if (!sameEffectIds(activeInventoryEffects, actualActive)) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_SET_MISMATCH');
      }
      assertCurrentMovementGroup(contract, document, line, activeInventoryEffects, lineSignedQuantity(contract, line),
        { revisions, pendingEffects, unresolvedRows, state });
      return { ...state, activeInventoryEffects: clone(activeInventoryEffects) };
    }
    const pending = pendingById.get(text(state.activePendingEffect?.pendingEffectId));
    if (!pending || canonicalSha256(pending) !== canonicalSha256(state.activePendingEffect)
      || text(pending.status) !== 'PENDING_PRODUCT_MATCH') {
      throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_PENDING_STALE');
    }
    if (activeMovementRows(movements, line[contract.lineId]).length) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_SET_MISMATCH');
    }
    assertActivePending(contract, document, line, pending, revision, unresolvedRows);
    return { ...state, activePendingEffect: clone(pending) };
  });
}

function deriveEffectiveStates(contract, document, lines, movements, pendingEffects, revisions, unresolvedRows) {
  const reversedIds = new Set(movements.map(row => text(row.reversalOfMovementId)).filter(Boolean));
  return lines.map(line => {
    const lineId = text(line[contract.lineId]);
    const signedQuantity = lineSignedQuantity(contract, line);
    const businessDate = text(line.businessDate || document.businessDate || document.purchaseDate || document.saleDate);
    const businessOccurredAt = text(line.businessOccurredAt || document.businessOccurredAt || document.businessEffectiveAt);
    const direct = activeMovementRows(movements, lineId);
    if (text(line.productId)) {
      assertCurrentMovementGroup(contract, document, line, direct, signedQuantity,
        { revisions, pendingEffects, unresolvedRows });
      return {
        lineId, status: 'MATCHED', productId: text(line.productId),
        productCode: text(line.productSnapshot?.productCode || line.productCode),
        warehouseId: text(line.warehouseId), businessDate, businessOccurredAt, signedQuantity,
        activeInventoryEffects: clone(direct)
      };
    }
    const linkedPending = pendingEffects.filter(row => text(row.sourceLineId) === lineId
      && Number(row.sourceDocumentRevision) === Number(document.revision));
    const active = linkedPending.filter(row => text(row.status) === 'PENDING_PRODUCT_MATCH');
    if (active.length === 1) {
      const pending = active[0];
      if (text(pending.companyId) !== text(document.companyId)
        || text(pending.sourceDocumentId) !== text(document[contract.documentId])
        || Number(pending.signedQuantity) !== signedQuantity
        || text(pending.warehouseId) !== text(line.warehouseId)
        || text(pending.effectiveAt) !== businessDate) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_PENDING_INVALID');
      }
      const revision = revisions.find(row => text(row.companyId) === text(document.companyId)
        && text(row.voucherMode).toLowerCase() === contract.mode
        && text(row.documentId) === text(document[contract.documentId])
        && Number(row.revision) === Number(document.revision));
      assertActivePending(contract, document, line, pending, revision, unresolvedRows);
      if (direct.length) throw new Error('ORDERQ_OFFICIAL_REVISION_ACTIVE_EFFECT_SET_MISMATCH');
      return { lineId, status: 'UNRESOLVED_PRODUCT', unresolvedProductId: text(line.unresolvedProductId),
        productCode: text(line.productSnapshot?.originalProductCode || line.originalProductCode || line.productCode),
        warehouseId: text(line.warehouseId), businessDate, businessOccurredAt, signedQuantity,
        activePendingEffect: clone(pending) };
    }
    const resolved = linkedPending.filter(row => text(row.productId)
      && /^RESOLVED/.test(text(row.status))).flatMap(pending => movements.filter(row =>
      text(row.pendingEffectId) === text(pending.pendingEffectId) && movementIsCurrent(row, reversedIds)));
    if (!resolved.length) throw new Error('ORDERQ_OFFICIAL_REVISION_UNRESOLVED_STATE_INVALID');
    assertCurrentMovementGroup(contract, document, line, resolved, signedQuantity,
      { revisions, pendingEffects, unresolvedRows, state: { productId: resolved[0]?.productId,
        productCode: resolved[0]?.productCode, warehouseId: resolved[0]?.warehouseId,
        businessDate: movementBusinessDate(resolved[0]) } });
    const identity = resolved[0];
    if (resolved.some(row => text(row.productId) !== text(identity.productId)
      || text(row.warehouseId) !== text(identity.warehouseId))) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REMATCH_EFFECT_INVALID');
    }
    return { lineId, status: 'MATCHED', productId: text(identity.productId), productCode: text(identity.productCode),
      warehouseId: text(identity.warehouseId), businessDate, businessOccurredAt, signedQuantity,
      rematchedFromUnresolvedProductId: text(line.unresolvedProductId), activeInventoryEffects: clone(resolved) };
  });
}

function unresolvedEvidenceForStates(companyId, states, unresolvedRows) {
  const byId = new Map(unresolvedRows.map(row => [text(row.unresolvedProductId), row]));
  return states.map(state => {
    const unresolvedProductId = text(state.activePendingEffect?.unresolvedProductId
      || state.rematchedFromUnresolvedProductId);
    if (!unresolvedProductId) return null;
    const unresolved = byId.get(unresolvedProductId);
    if (!unresolved || text(unresolved.companyId) !== companyId) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_UNRESOLVED_RECORD_STALE');
    }
    if (state.status === 'UNRESOLVED_PRODUCT' && text(unresolved.status) === 'MATCHED') {
      throw new Error('ORDERQ_OFFICIAL_REVISION_UNRESOLVED_RECORD_STALE');
    }
    if (state.status === 'MATCHED' && (text(unresolved.status) !== 'MATCHED'
      || text(unresolved.productId) !== text(state.productId))) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_REMATCH_RECORD_STALE');
    }
    return clone(unresolved);
  }).filter(Boolean).sort((left, right) => text(left.unresolvedProductId).localeCompare(text(right.unresolvedProductId)));
}

async function readOfficialRevisionTargetFromTransaction(tx, identity = {}, contract = inferKind(identity)) {
  const companyId = text(identity.companyId);
  const documentId = documentIdOf(contract, identity);
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const document = await requestToPromise(tx.objectStore(contract.documentStore).get(documentId));
  if (!document || text(document.companyId) !== companyId) throw new Error('ORDERQ_OFFICIAL_REVISION_DOCUMENT_NOT_FOUND');
  if (!confirmedStatus(document.status) || !confirmedStatus(document.businessStatus)) {
    throw new Error([document.status, document.businessStatus].some(value => text(value).toUpperCase() === 'CANCELLED')
      ? 'ORDERQ_OFFICIAL_REVISION_ALREADY_CANCELLED' : 'ORDERQ_OFFICIAL_REVISION_DOCUMENT_NOT_CONFIRMED');
  }
  const [allLines, revisions, movements, pendingEffects, partnerEntries, unresolvedRows, checkpoints, commandReceipt] = await Promise.all([
    rowsByIndex(tx.objectStore(contract.lineStore), 'byDocumentId', documentId),
    requestToPromise(tx.objectStore(STORE.VOUCHER_REVISIONS).getAll()),
    rowsByIndex(tx.objectStore(STORE.INVENTORY_MOVEMENTS), 'byDocument', [contract.mode, documentId]),
    rowsByIndex(tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS), 'byDocument', [contract.mode, documentId]),
    rowsByIndex(tx.objectStore(contract.partnerEntryStore), 'byDocument', documentId),
    requestToPromise(tx.objectStore(STORE.UNRESOLVED_PRODUCTS).getAll()),
    requestToPromise(tx.objectStore(STORE.INVENTORY_CHECKPOINTS).getAll()),
    requestToPromise(tx.objectStore(STORE.OFFICIAL_COMMANDS).get(text(document.commandId)))
  ]);
  const lines = allLines.filter(line => Number(line.revision) === Number(document.revision)
    && text(line.lineStatus).toUpperCase() === 'ACTIVE' && text(line.status).toUpperCase() === 'CONFIRMED');
  const revision = revisions.find(row => text(row.companyId) === companyId
    && text(row.voucherMode).toLowerCase() === contract.mode && text(row.documentId) === documentId
    && Number(row.revision) === Number(document.revision));
  if (!lines.length || !revision || text(document.lastVoucherRevisionId) !== text(revision.voucherRevisionId)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_HEAD_INVALID');
  }
  if (!commandReceipt || text(commandReceipt.status) !== 'COMMITTED'
    || text(commandReceipt.companyId) !== companyId
    || text(commandReceipt.voucherMode).toLowerCase() !== contract.mode
    || text(commandReceipt.documentId) !== documentId) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_RECEIPT_INVALID');
  }
  assertCurrentRevisionProjection(contract, document, lines, revision);
  assertMovementLineage(contract, document, movements, revisions);
  const storedStates = normalizeStoredEffectiveStates(contract, document, lines, revision, movements, pendingEffects,
    revisions, unresolvedRows);
  const effectiveLineStates = storedStates || deriveEffectiveStates(contract, document, lines, movements, pendingEffects,
    revisions, unresolvedRows);
  assertDocumentActiveSetCoverage(movements, pendingEffects, effectiveLineStates);
  const unresolvedProductEvidence = unresolvedEvidenceForStates(companyId, effectiveLineStates, unresolvedRows);
  const target = withOfficialRevisionTargetDigestV2({
    schemaVersion: OFFICIAL_REVISION_TARGET_SCHEMA_V2,
    companyId, kind: contract.kind, voucherMode: contract.mode, documentId,
    currentRevision: Number(document.revision), currentRevisionId: revision.voucherRevisionId,
    currentDocument: clone(document), currentLines: clone(lines), currentVoucherRevision: clone(revision),
    effectiveLineStates, unresolvedProductEvidence, partnerEntryIds: partnerEntries.map(row => text(row.entryId)),
    currentCommandReceiptDigest: canonicalSha256(commandReceipt)
  });
  assertOfficialRevisionTargetV2(target);
  return deepFreeze({ target, inventoryCheckpoints: clone(checkpoints.filter(row => text(row.companyId) === companyId)) });
}

export async function inspectOfficialVoucherRevisionTarget(identity = {}) {
  const contract = inferKind(identity);
  const db = await openOrderQDb();
  const stores = [contract.documentStore, contract.lineStore, STORE.OFFICIAL_COMMANDS,
    STORE.VOUCHER_REVISIONS, STORE.INVENTORY_MOVEMENTS, contract.partnerEntryStore,
    STORE.PENDING_INVENTORY_EFFECTS, STORE.INVENTORY_CHECKPOINTS, STORE.UNRESOLVED_PRODUCTS];
  const tx = db.transaction(stores, 'readonly');
  const result = await readOfficialRevisionTargetFromTransaction(tx, identity, contract);
  await transactionDone(tx);
  return result;
}

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
    companyId: effect.companyId,
    voucherMode: effect.voucherMode,
    sourceDocumentId: effect.sourceDocumentId,
    sourceLineId: effect.sourceLineId,
    sourceDocumentRevision: effect.sourceDocumentRevision,
    voucherRevisionId: effect.voucherRevisionId,
    commandId: effect.commandId,
    warehouseId: effect.warehouseId,
    businessDate: effect.effectiveAt,
    businessOccurredAt: text(effect.businessOccurredAt),
    quantity: effect.quantity,
    signedQuantity: effect.signedQuantity,
    unitPrice: effect.unitPrice,
    totalAmount: effect.totalAmount,
    inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
    officialInventoryApplied: false,
    productSnapshot: clone(effect.productSnapshot),
    productResolution: clone(effect.productResolution)
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
  if (checkedV2) storeNames.push(STORE.INVENTORY_CHECKPOINTS);
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
    if (checkedV2) {
      try {
        assertOfficialLedgerProjectionV2(existingCommand.result, checkedV2);
        assertOfficialStocktakeProjectionV2(existingCommand.result, checkedV2.command);
      } catch (error) {
        tx.abort();
        try { await transactionDone(tx); } catch {}
        throw error;
      }
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
  const checkpoints = checkedV2
    ? await checkpointRowsForCommand(tx.objectStore(STORE.INVENTORY_CHECKPOINTS), resolvedCommand)
    : [];
  let plan;
  try {
    plan = planOfficialVoucherCommand({
      command: resolvedCommand,
      document,
      lines: resolvedLines,
      inventoryCheckpoints: checkpoints
    });
  } catch (error) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw error;
  }
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
    try {
      assertOfficialLedgerProjectionV2(plan, checkedV2);
      assertOfficialStocktakeProjectionV2(plan, checkedV2.command);
    } catch (error) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw error;
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

function revisionCommandReceipt(plan, result) {
  return {
    commandId: plan.command.commandId,
    idempotencyKey: plan.command.idempotencyKey,
    companyId: plan.command.companyId,
    voucherMode: plan.command.voucherMode,
    documentId: plan.command.documentId,
    commandType: `${plan.action}_${plan.kind}`,
    action: plan.action,
    status: 'COMMITTED',
    payloadDigest: plan.command.commandPayloadDigest,
    requestedAt: plan.command.occurredAt,
    committedAt: nowIso(),
    result
  };
}

function revisionQueueRow(plan) {
  return {
    queueId: voucherStableId('SQR', plan.command.commandId),
    entityType: 'OFFICIAL_VOUCHER_REVISION_COMMAND',
    entityId: plan.command.commandId,
    operation: plan.action,
    revision: plan.document.revision,
    payload: {
      schemaVersion: 'ONEAPP_ORDERQ_OFFICIAL_REVISION_QUEUE_V2',
      companyId: plan.command.companyId,
      voucherMode: plan.command.voucherMode,
      documentId: plan.command.documentId,
      command: plan.command,
      projectionDigest: canonicalSha256(plan.voucherRevision)
    },
    status: 'WAITING_SERVER_CONTRACT',
    attemptCount: 0,
    createdAt: nowIso(),
    lastError: ''
  };
}

async function committedRevisionCommand(command) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.OFFICIAL_COMMANDS, 'readonly');
  const receipt = await requestToPromise(tx.objectStore(STORE.OFFICIAL_COMMANDS).get(command.commandId));
  await transactionDone(tx);
  if (!receipt) return null;
  if (text(receipt.status) !== 'COMMITTED'
    || text(receipt.payloadDigest) !== text(command.commandPayloadDigest)
    || text(receipt.companyId) !== text(command.companyId)
    || text(receipt.voucherMode).toLowerCase() !== text(command.voucherMode).toLowerCase()
    || text(receipt.documentId) !== text(command.documentId)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_PAYLOAD_CONFLICT');
  }
  return { ...clone(receipt.result), duplicate: true };
}

async function updateUnresolvedForPendingSupersession(tx, row, command, action) {
  const pendingStore = tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS);
  const unresolvedStore = tx.objectStore(STORE.UNRESOLVED_PRODUCTS);
  const pending = await requestToPromise(pendingStore.get(row.sourceEffectId));
  if (!pending || text(pending.companyId) !== text(command.companyId)
    || text(pending.unresolvedProductId) !== text(row.unresolvedProductId)
    || text(pending.status) !== 'PENDING_PRODUCT_MATCH') {
    throw new Error('ORDERQ_OFFICIAL_REVISION_PENDING_EFFECT_STALE');
  }
  const status = action === 'CANCEL' ? 'CANCELLED_BY_REVISION' : 'SUPERSEDED_BY_REVISION';
  pendingStore.put({ ...pending, status, inventoryEffectStatus: status,
    supersededByCommandId: command.commandId, supersededAt: command.occurredAt, supersededBy: command.actor });
  const unresolved = await requestToPromise(unresolvedStore.get(pending.unresolvedProductId));
  if (!unresolved || text(unresolved.companyId) !== text(command.companyId)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_UNRESOLVED_RECORD_STALE');
  }
  assertPendingReviewLink(pending, unresolved);
  const reviewLinks = (unresolved.reviewLinks || []).map(link => text(link.pendingEffectId) === text(pending.pendingEffectId)
    ? { ...clone(link), inventoryEffectStatus: status, status,
      supersededByCommandId: command.commandId, supersededAt: command.occurredAt }
    : clone(link));
  const matchedIdentity = text(unresolved.status) === 'MATCHED' && text(unresolved.productId);
  const activeLinks = reviewLinks.filter(link => ['PENDING_PRODUCT_MATCH', 'UNRESOLVED_PRODUCT']
    .includes(text(link.status || link.inventoryEffectStatus).toUpperCase()));
  unresolvedStore.put({
    ...unresolved,
    reviewLinks,
    ...(matchedIdentity ? {} : activeLinks.length ? {
      status: 'UNRESOLVED_PRODUCT', inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false
    } : {
      status: 'NO_ACTIVE_REVIEW', inventoryEffectStatus: status, officialInventoryApplied: false,
      reviewClosedAt: command.occurredAt, reviewClosedByCommandId: command.commandId
    }),
    updatedAt: command.occurredAt
  });
}

function revisionSnapshotEvidence(snapshot = {}) {
  return {
    schemaVersion: text(snapshot.schemaVersion),
    snapshotId: text(snapshot.snapshotId),
    revision: snapshot.revision === null || snapshot.revision === undefined ? null : snapshot.revision,
    snapshotVersion: snapshot.snapshotVersion === null || snapshot.snapshotVersion === undefined ? null : snapshot.snapshotVersion,
    contentHash: text(snapshot.contentHash)
  };
}

function revisionCustomerCodeKey(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
}

function revisionCustomerActive(row = {}) {
  return row.active !== false
    && !['INACTIVE', 'DELETED'].includes(text(row.status || 'ACTIVE').toUpperCase())
    && text(row.qualityStatus).toUpperCase() !== 'SUPERSEDED';
}

async function validateCurrentRevisionReferenceSnapshots(command, options = {}) {
  const requirements = command.referenceRequirements || { products: [], partner: null };
  const evidence = command.referenceEvidence || {};
  const ownerProductRequirements = (requirements.products || []).filter(expected => text(expected.inputProductCode));
  if (ownerProductRequirements.length) {
    const snapshot = await (options.productSnapshotProvider || getProductSnapshot)();
    if (!snapshot || text(snapshot.status) !== 'READY'
      || text(snapshot.schemaVersion) !== PRODUCT_SNAPSHOT_SCHEMA_VERSION
      || !Array.isArray(snapshot.data?.products)
      || await sha256Hex(snapshot.data) !== text(snapshot.contentHash)
      || canonicalSha256(revisionSnapshotEvidence(snapshot)) !== canonicalSha256(evidence.productSnapshot)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_PRODUCT_SNAPSHOT_STALE');
    }
    ownerProductRequirements.forEach(expected => {
      const matches = snapshot.data.products.filter(row => rematchProductActive(row)
        && text(row.companyId) === command.companyId
        && rematchProductCode(row) === text(expected.inputProductCode));
      const current = matches.length === 1 ? matches[0] : null;
      const currentId = rematchProductId(current || {});
      const actualStatus = matches.length > 1 || (current && !currentId) ? 'UNRESOLVED_PRODUCT'
        : current ? 'MATCHED' : 'UNRESOLVED_PRODUCT';
      const actualReason = matches.length > 1 ? 'PRODUCT_CODE_AMBIGUOUS'
        : current && !currentId ? 'MATCHED_PRODUCT_TECHNICAL_ID_MISSING'
          : current ? 'EXACT_COMPANY_PRODUCT_CODE' : 'PRODUCT_CODE_UNMATCHED';
      if (text(expected.status) !== actualStatus || text(expected.reason) !== actualReason
        || (actualStatus === 'MATCHED' && (currentId !== text(expected.productId)
          || rematchProductCode(current) !== text(expected.productCode)
          || rematchProductName(current) !== text(expected.productName)
          || rematchProductSpecification(current) !== text(expected.specification)
          || rematchProductUnit(current) !== text(expected.unit)
          || Number(current.revision || current.masterRevision || current.raw?.revision || 0)
            !== Number(expected.productMasterRevision || 0)))) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_PRODUCT_REFERENCE_MISMATCH');
      }
    });
  }
  if (requirements.partner) {
    const snapshot = await (options.customerSnapshotProvider || (() => getCustomerSnapshot({ includeInactive: true })))();
    if (!snapshot || !['READY', 'EMPTY'].includes(text(snapshot.status))
      || text(snapshot.schemaVersion) !== 'ONEAPP_CUSTOMER_SNAPSHOT_V1'
      || !Array.isArray(snapshot.data?.customers)
      || await sha256Hex(snapshot.data) !== text(snapshot.contentHash)
      || canonicalSha256(revisionSnapshotEvidence(snapshot)) !== canonicalSha256(evidence.customerSnapshot)) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_SNAPSHOT_STALE');
    }
    const expected = requirements.partner;
    const inputKey = revisionCustomerCodeKey(expected.inputCustomerCode);
    const matches = inputKey ? snapshot.data.customers.filter(row => revisionCustomerActive(row)
      && text(row.companyId) === command.companyId
      && revisionCustomerCodeKey(row.customerCode || row.erpCustomerCode) === inputKey) : [];
    const current = matches.length === 1 ? matches[0] : null;
    if (expected.status === 'MATCHED') {
      if (!current || text(current.customerId) !== text(expected.matchedCustomerId)
        || text(current.customerCode || current.erpCustomerCode) !== text(expected.matchedCustomerCode)
        || text(current.customerName || current.name) !== text(expected.matchedCustomerName)
        || Number(current.revision || 0) !== Number(expected.customerMasterRevision || 0)) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
      }
    } else if (expected.status === 'UNRESOLVED_CUSTOMER') {
      const reason = matches.length > 1 ? 'CUSTOMER_CODE_AMBIGUOUS'
        : current && !text(current.customerId) ? 'MATCHED_CUSTOMER_ID_MISSING'
          : current ? 'EXACT_COMPANY_CUSTOMER_CODE' : 'CUSTOMER_CODE_UNMATCHED';
      if (!inputKey || reason !== text(expected.reason) || current && text(current.customerId)) {
        throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
      }
    } else if (expected.status !== 'CUSTOMER_NOT_PROVIDED' || inputKey || matches.length) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_CUSTOMER_REFERENCE_MISMATCH');
    }
  }
}

async function insertRevisionPendingEffect(tx, row, voucherRevisionId) {
  const pending = { ...clone(row), voucherRevisionId };
  const unresolvedStore = tx.objectStore(STORE.UNRESOLVED_PRODUCTS);
  const existing = await requestToPromise(unresolvedStore.get(pending.unresolvedProductId));
  if (existing && text(existing.companyId) !== text(pending.companyId)) {
    throw new Error('ORDERQ_OFFICIAL_UNRESOLVED_PRODUCT_COMPANY_MISMATCH');
  }
  if (existing && text(existing.status) === 'MATCHED' && text(existing.productId)) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_MATCHED_UNRESOLVED_ID_REUSE');
  }
  tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).add(pending);
  unresolvedStore.put(mergeUnresolvedReviewRecord(existing, pending));
}

export async function runOfficialVoucherRevisionCommand(source = {}, options = {}) {
  if (source?.cancelled === true) return deepFreeze({ cancelled: true, duplicate: false, officialWrites: 0 });
  const checked = assertOfficialVoucherRevisionCommandV2(source);
  const duplicate = await committedRevisionCommand(checked.command);
  if (duplicate) return duplicate;

  await validateCurrentRevisionReferenceSnapshots(checked.command, options);
  if (checked.command.referenceRequirements?.partner?.status === 'MATCHED') {
    throw new Error('ORDERQ_OFFICIAL_REVISION_ARAP_NEW_MATCHED_PARTNER_UNSUPPORTED');
  }

  const readonlyPreflight = await inspectOfficialVoucherRevisionTarget({
    kind: checked.contract.kind,
    companyId: checked.command.companyId,
    [checked.contract.documentId]: checked.command.documentId
  });
  if (readonlyPreflight.target.targetDigest !== checked.command.targetDigest) {
    throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_STALE');
  }
  await validateCurrentRevisionReferenceSnapshots(checked.command, options);

  const db = await openOrderQDb();
  const contract = kindContract(checked.contract.kind);
  const storeNames = [contract.documentStore, contract.lineStore, STORE.OFFICIAL_COMMANDS,
    STORE.VOUCHER_REVISIONS, STORE.INVENTORY_MOVEMENTS, contract.partnerEntryStore,
    STORE.PENDING_INVENTORY_EFFECTS, STORE.INVENTORY_CHECKPOINTS, STORE.UNRESOLVED_PRODUCTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(storeNames, 'readwrite');
  const commandStore = tx.objectStore(STORE.OFFICIAL_COMMANDS);
  const existing = await requestToPromise(commandStore.get(checked.command.commandId));
  if (existing) {
    if (text(existing.status) !== 'COMMITTED'
      || text(existing.payloadDigest) !== checked.payloadDigest
      || text(existing.companyId) !== checked.command.companyId
      || text(existing.voucherMode).toLowerCase() !== checked.command.voucherMode
      || text(existing.documentId) !== checked.command.documentId) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw new Error('ORDERQ_OFFICIAL_REVISION_COMMAND_PAYLOAD_CONFLICT');
    }
    await transactionDone(tx);
    return { ...clone(existing.result), duplicate: true };
  }

  let current;
  let plan;
  try {
    current = await readOfficialRevisionTargetFromTransaction(tx, checked.command, contract);
    if (current.target.targetDigest !== checked.command.targetDigest) {
      throw new Error('ORDERQ_OFFICIAL_REVISION_TARGET_STALE');
    }
    if (current.target.partnerEntryIds.length) throw new Error('ORDERQ_OFFICIAL_REVISION_ARAP_EFFECT_UNSUPPORTED');
    plan = planOfficialVoucherRevisionCommandV2({
      command: checked.command,
      target: current.target,
      inventoryCheckpoints: current.inventoryCheckpoints
    });
  } catch (error) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw error;
  }

  try {
    const documentStore = tx.objectStore(contract.documentStore);
    const lineStore = tx.objectStore(contract.lineStore);
    documentStore.put(plan.document);
    [...plan.lines, ...plan.removedLines].forEach(line => lineStore.put(line));
    plan.inventoryMovements.forEach(row => tx.objectStore(STORE.INVENTORY_MOVEMENTS).add(row));
    for (const row of plan.pendingSupersessions) {
      await updateUnresolvedForPendingSupersession(tx, row, checked.command, plan.action);
    }
    for (const row of plan.pendingCreations) {
      await insertRevisionPendingEffect(tx, row, plan.voucherRevision.voucherRevisionId);
    }
    tx.objectStore(STORE.VOUCHER_REVISIONS).add(plan.voucherRevision);
    const result = {
      authority: 'LOCAL_PILOT',
      document: plan.document,
      lines: plan.lines,
      inventoryMovements: plan.inventoryMovements,
      pendingInventoryEffects: plan.pendingCreations,
      supersededPendingEffectIds: plan.pendingSupersessions.map(row => row.sourceEffectId),
      ledgerEntries: [],
      voucherRevision: plan.voucherRevision,
      duplicate: false
    };
    commandStore.add(revisionCommandReceipt(plan, result));
    tx.objectStore(STORE.SYNC_QUEUE).add(revisionQueueRow(plan));
    await transactionDone(tx);
    return result;
  } catch (error) {
    try { tx.abort(); } catch {}
    try { await transactionDone(tx); } catch {}
    throw error;
  }
}

function rematchProductId(row = {}) {
  return text(row.productId || row.masterProductId);
}

function rematchProductCode(row = {}) {
  return text(row.itemCode || row.productCode || row['코드'] || row['품목코드']
    || row.raw?.['코드'] || row.raw?.['품목코드']);
}

function rematchProductName(row = {}) {
  return text(row.itemName || row.productName || row['품목명'] || row.name || row.raw?.['품목명']);
}

function rematchProductSpecification(row = {}) {
  return text(row.specification || row['규격'] || row.raw?.['규격']);
}

function rematchProductUnit(row = {}) {
  return text(row.unit || row.finalUnit || row.actualUnit || row['단위'] || row.raw?.['단위']);
}

function rematchProductActive(row = {}) {
  return row.active !== false
    && !['INACTIVE', 'DELETED'].includes(text(row.status || 'ACTIVE').toUpperCase())
    && text(row.productIdentityType).toUpperCase() !== 'TEMPORARY';
}

async function validateCurrentProductSnapshot(command, snapshotProvider) {
  const snapshot = await snapshotProvider();
  if (!snapshot || snapshot.status !== 'READY' || snapshot.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION
    || !Array.isArray(snapshot.data?.products)) {
    throw new Error('ORDERQ_REMATCH_V2_PRODUCT_SNAPSHOT_NOT_READY');
  }
  if (await sha256Hex(snapshot.data) !== text(snapshot.contentHash)) {
    throw new Error('ORDERQ_REMATCH_V2_PRODUCT_SNAPSHOT_HASH_INVALID');
  }
  const expected = command.selectionEvidence.productSnapshot;
  if (text(snapshot.schemaVersion) !== text(expected.schemaVersion)
    || text(snapshot.snapshotId) !== text(expected.snapshotId)
    || text(snapshot.revision) !== text(expected.revision)
    || text(snapshot.contentHash) !== text(expected.contentHash)) {
    throw new Error('ORDERQ_REMATCH_V2_PRODUCT_SNAPSHOT_STALE');
  }
  const matches = snapshot.data.products.filter(row => rematchProductActive(row)
    && (!text(row.companyId) || text(row.companyId) === command.companyId)
    && rematchProductId(row) === command.selectedProduct.productId);
  if (matches.length !== 1) throw new Error('ORDERQ_REMATCH_V2_SELECTED_PRODUCT_NOT_UNIQUE');
  const current = matches[0];
  if (rematchProductCode(current) !== command.selectedProduct.productCode
    || rematchProductName(current) !== command.selectedProduct.productName
    || rematchProductSpecification(current) !== command.selectedProduct.specification
    || rematchProductUnit(current) !== command.selectedProduct.unit) {
    throw new Error('ORDERQ_REMATCH_V2_SELECTED_PRODUCT_STALE');
  }
  return snapshot;
}

function abortWith(tx, error) {
  try { tx.abort(); } catch {}
  return transactionDone(tx).catch(() => {}).then(() => { throw error; });
}

function rematchExpectedEffects(impacts = []) {
  return impacts.map(impact => ({
    pendingEffectId: text(impact.pendingEffectId),
    voucherMode: text(impact.sourceVoucher?.voucherMode).toLowerCase(),
    documentId: text(impact.sourceVoucher?.documentId),
    lineId: text(impact.sourceVoucher?.lineId),
    documentRevision: Number(impact.sourceVoucher?.documentRevision),
    voucherRevisionId: text(impact.sourceVoucher?.revisionId)
  })).sort((left, right) => left.pendingEffectId.localeCompare(right.pendingEffectId));
}

function rematchExpectedDocuments(impacts = []) {
  const rows = new Map();
  impacts.forEach(impact => {
    const row = {
      voucherMode: text(impact.sourceVoucher?.voucherMode).toLowerCase(),
      documentId: text(impact.sourceVoucher?.documentId),
      revision: Number(impact.sourceVoucher?.documentRevision),
      voucherRevisionId: text(impact.sourceVoucher?.revisionId)
    };
    rows.set(`${row.voucherMode}:${row.documentId}`, row);
  });
  return [...rows.values()].sort((left, right) => left.voucherMode.localeCompare(right.voucherMode)
    || left.documentId.localeCompare(right.documentId)
    || left.revision - right.revision
    || left.voucherRevisionId.localeCompare(right.voucherRevisionId));
}

function rematchFinite(value, code) {
  if (value === '' || value === null || value === undefined) throw new Error(code);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  return Object.is(number, -0) ? 0 : number;
}

function rematchCalendarDate(value, code) {
  const source = text(value);
  const matched = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) throw new Error(code);
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(code);
  }
  return source;
}

function rematchBusinessTimestamp(value, businessDate, code) {
  const source = text(value);
  if (!source) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(source)
    || !Number.isFinite(Date.parse(source))) throw new Error(code);
  if (rematchCalendarDate(source.slice(0, 10), code) !== businessDate) throw new Error(code);
  return source;
}

function rematchDocumentBusinessDate(voucherMode, document) {
  const code = 'ORDERQ_REMATCH_V2_SOURCE_BUSINESS_DATE_INVALID';
  const businessDate = rematchCalendarDate(document?.businessDate, code);
  const modeField = voucherMode === 'purchase' ? 'purchaseDate' : 'saleDate';
  if (Object.prototype.hasOwnProperty.call(document || {}, modeField)
    && rematchCalendarDate(document[modeField], code) !== businessDate) throw new Error(code);
  return businessDate;
}

function rematchSourceLineId(voucherMode, source = {}) {
  return text(voucherMode === 'purchase'
    ? source.purchaseLineId || source.lineId
    : source.salesLineId || source.lineId);
}

function rematchSourceDocumentId(voucherMode, source = {}) {
  return text(voucherMode === 'purchase'
    ? source.purchaseDocumentId || source.documentId
    : source.salesDocumentId || source.documentId);
}

function assertRematchRevisionSnapshot({ command, link, document, line, revision, businessDate, actualQuantity }) {
  const afterSnapshot = revision?.afterSnapshot;
  if (!afterSnapshot || typeof afterSnapshot !== 'object'
    || text(revision.afterDigest) !== canonicalSha256(afterSnapshot)) {
    throw new Error('ORDERQ_REMATCH_V2_REVISION_SNAPSHOT_INVALID');
  }
  const snapshotDocument = afterSnapshot.document && typeof afterSnapshot.document === 'object'
    ? afterSnapshot.document : afterSnapshot;
  const snapshotLines = Array.isArray(afterSnapshot.lines)
    ? afterSnapshot.lines : Array.isArray(snapshotDocument.lines) ? snapshotDocument.lines : [];
  const snapshotLineMatches = snapshotLines.filter(row => rematchSourceLineId(link.voucherMode, row) === link.lineId);
  if (rematchSourceDocumentId(link.voucherMode, snapshotDocument) !== link.documentId
    || text(snapshotDocument.companyId) !== command.companyId
    || Number(snapshotDocument.revision) !== link.documentRevision
    || text(snapshotDocument.status).toUpperCase() !== 'CONFIRMED'
    || text(snapshotDocument.warehouseId) !== text(document.warehouseId)
    || rematchCalendarDate(revision.businessDate, 'ORDERQ_REMATCH_V2_REVISION_BUSINESS_DATE_INVALID') !== businessDate
    || snapshotLineMatches.length !== 1) {
    throw new Error('ORDERQ_REMATCH_V2_REVISION_SNAPSHOT_INVALID');
  }
  const snapshotLine = snapshotLineMatches[0];
  if (text(snapshotLine.companyId) !== command.companyId
    || text(snapshotLine.unresolvedProductId) !== command.unresolvedProductId
    || text(snapshotLine.productId)
    || text(snapshotLine.warehouseId) !== text(line.warehouseId)
    || rematchFinite(snapshotLine.quantity ?? snapshotLine.actualQuantity,
      'ORDERQ_REMATCH_V2_REVISION_QUANTITY_INVALID') !== actualQuantity
    || rematchFinite(snapshotLine.baseQuantity ?? snapshotLine.quantity ?? snapshotLine.actualQuantity,
      'ORDERQ_REMATCH_V2_REVISION_QUANTITY_INVALID') !== actualQuantity
    || canonicalSha256(snapshotLine.productSnapshot || {}) !== canonicalSha256(line.productSnapshot || {})) {
    throw new Error('ORDERQ_REMATCH_V2_REVISION_SNAPSHOT_INVALID');
  }
}

function assertRematchExpectedState(command, preview) {
  if (canonicalSha256(rematchExpectedEffects(preview.impacts)) !== canonicalSha256(command.expectedEffects)) {
    throw new Error('ORDERQ_REMATCH_V2_EXPECTED_EFFECTS_STALE');
  }
  if (canonicalSha256(rematchExpectedDocuments(preview.impacts)) !== canonicalSha256(command.expectedDocuments)) {
    throw new Error('ORDERQ_REMATCH_V2_EXPECTED_DOCUMENTS_STALE');
  }
}

function assertRematchSourceLinks(command, source) {
  const documents = new Map([
    ...(source.purchaseDocuments || []).map(row => [`purchase:${text(row.purchaseDocumentId)}`, row]),
    ...(source.salesDocuments || []).map(row => [`sale:${text(row.salesDocumentId)}`, row])
  ]);
  const lines = new Map([
    ...(source.purchaseLines || []).map(row => [`purchase:${text(row.purchaseLineId)}`, row]),
    ...(source.salesLines || []).map(row => [`sale:${text(row.salesLineId)}`, row])
  ]);
  const revisions = new Map((source.voucherRevisions || []).map(row => [text(row.voucherRevisionId), row]));
  const pendingById = new Map((source.pendingInventoryEffects || []).map(row => [text(row.pendingEffectId), row]));
  const reviewLinks = Array.isArray(source.unresolvedProducts?.[0]?.reviewLinks)
    ? source.unresolvedProducts[0].reviewLinks : [];
  command.expectedEffects.forEach(expected => {
    const link = {
      voucherMode: expected.voucherMode,
      documentId: expected.documentId,
      lineId: expected.lineId,
      documentRevision: expected.documentRevision,
      revisionId: expected.voucherRevisionId
    };
    const key = `${link.voucherMode}:`;
    const document = documents.get(`${key}${link.documentId}`);
    const line = lines.get(`${key}${link.lineId}`);
    const revision = revisions.get(text(link.revisionId));
    const pending = pendingById.get(expected.pendingEffectId);
    const matchingReviewLinks = reviewLinks.filter(row => text(row.pendingEffectId) === expected.pendingEffectId);
    const reviewLink = matchingReviewLinks[0];
    const documentIdField = link.voucherMode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId';
    if (!document || text(document.companyId) !== command.companyId
      || text(document.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
      || text(document.status).toUpperCase() !== 'CONFIRMED'
      || (text(document.businessStatus) && text(document.businessStatus).toUpperCase() !== 'CONFIRMED')
      || Number(document.revision) !== Number(link.documentRevision)
      || text(document.lastVoucherRevisionId) !== text(link.revisionId)) {
      throw new Error('ORDERQ_REMATCH_V2_DOCUMENT_LINK_INVALID');
    }
    if (!line || text(line.companyId) !== command.companyId
      || text(line.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
      || text(line[documentIdField]) !== text(link.documentId)
      || Number(line.revision) !== Number(link.documentRevision)
      || text(line.status).toUpperCase() !== 'CONFIRMED'
      || text(line.lineStatus).toUpperCase() !== 'ACTIVE'
      || text(line.unresolvedProductId) !== command.unresolvedProductId
      || text(line.productId)
      || canonicalSha256(line.productSnapshot || {}) !== canonicalSha256(pending?.productSnapshot || {})
      || canonicalSha256(line.productSnapshot || {}) !== canonicalSha256(reviewLink?.productSnapshot || {})) {
      throw new Error('ORDERQ_REMATCH_V2_LINE_LINK_INVALID');
    }
    if (!revision || text(revision.companyId) !== command.companyId
      || text(revision.identityVersion) !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
      || text(revision.voucherMode) !== text(link.voucherMode)
      || text(revision.documentId) !== text(link.documentId)
      || Number(revision.revision) !== Number(link.documentRevision)
      || text(revision.status).toUpperCase() !== 'CONFIRMED'
      || text(revision.commandId) !== text(pending?.commandId)) {
      throw new Error('ORDERQ_REMATCH_V2_REVISION_LINK_INVALID');
    }
    if (!pending || text(pending.companyId) !== command.companyId
      || text(pending.unresolvedProductId) !== command.unresolvedProductId
      || text(pending.voucherMode).toLowerCase() !== link.voucherMode
      || text(pending.sourceDocumentId) !== text(link.documentId)
      || text(pending.sourceLineId) !== text(link.lineId)
      || Number(pending.sourceDocumentRevision) !== Number(link.documentRevision)
      || text(pending.voucherRevisionId) !== text(link.revisionId)
      || text(pending.status) !== 'PENDING_PRODUCT_MATCH'
      || text(pending.inventoryEffectStatus) !== 'UNRESOLVED_PRODUCT'
      || pending.officialInventoryApplied !== false
      || matchingReviewLinks.length !== 1) {
      throw new Error('ORDERQ_REMATCH_V2_PENDING_EFFECT_LINK_INVALID');
    }
    if (text(reviewLink.companyId) && text(reviewLink.companyId) !== command.companyId
      || text(reviewLink.unresolvedProductId) && text(reviewLink.unresolvedProductId) !== command.unresolvedProductId
      || text(reviewLink.voucherMode).toLowerCase() !== link.voucherMode
      || text(reviewLink.sourceDocumentId || reviewLink.documentId) !== link.documentId
      || text(reviewLink.sourceLineId || reviewLink.lineId) !== link.lineId
      || Number(reviewLink.sourceDocumentRevision) !== link.documentRevision
      || text(reviewLink.voucherRevisionId) !== text(link.revisionId)) {
      throw new Error('ORDERQ_REMATCH_V2_REVIEW_LINK_INVALID');
    }
    const sourceCommandId = text(document.commandId);
    if (!sourceCommandId || text(line.commandId) !== sourceCommandId
      || text(revision.commandId) !== sourceCommandId
      || text(pending.commandId) !== sourceCommandId
      || text(reviewLink.commandId) !== sourceCommandId) {
      throw new Error('ORDERQ_REMATCH_V2_SOURCE_COMMAND_LINK_INVALID');
    }
    const warehouseId = text(line.warehouseId);
    if (!warehouseId || text(document.warehouseId) !== warehouseId
      || text(pending.warehouseId) !== warehouseId || text(reviewLink.warehouseId) !== warehouseId) {
      throw new Error('ORDERQ_REMATCH_V2_SOURCE_WAREHOUSE_INVALID');
    }
    const actualQuantity = rematchFinite(line.actualQuantity, 'ORDERQ_REMATCH_V2_SOURCE_QUANTITY_INVALID');
    if (rematchFinite(line.baseQuantity, 'ORDERQ_REMATCH_V2_SOURCE_FACTOR_INVALID') !== actualQuantity
      || Number(line.inventoryEffectFactor) !== 1
      || rematchFinite(pending.quantity, 'ORDERQ_REMATCH_V2_SOURCE_QUANTITY_INVALID') !== actualQuantity
      || rematchFinite(reviewLink.quantity, 'ORDERQ_REMATCH_V2_SOURCE_QUANTITY_INVALID') !== actualQuantity) {
      throw new Error('ORDERQ_REMATCH_V2_SOURCE_QUANTITY_INVALID');
    }
    const expectedSignedQuantity = Object.is(actualQuantity, -0) ? 0
      : (link.voucherMode === 'purchase' ? actualQuantity : -actualQuantity);
    if (rematchFinite(pending.signedQuantity, 'ORDERQ_REMATCH_V2_SOURCE_SIGN_INVALID') !== expectedSignedQuantity
      || rematchFinite(reviewLink.signedQuantity, 'ORDERQ_REMATCH_V2_SOURCE_SIGN_INVALID') !== expectedSignedQuantity) {
      throw new Error('ORDERQ_REMATCH_V2_SOURCE_SIGN_INVALID');
    }
    const businessDate = rematchDocumentBusinessDate(link.voucherMode, document);
    if (rematchCalendarDate(pending.effectiveAt, 'ORDERQ_REMATCH_V2_PENDING_BUSINESS_DATE_INVALID') !== businessDate
      || rematchCalendarDate(reviewLink.businessDate ?? reviewLink.effectiveAt,
        'ORDERQ_REMATCH_V2_REVIEW_BUSINESS_DATE_INVALID') !== businessDate
      || (Object.prototype.hasOwnProperty.call(line, 'businessDate')
        && rematchCalendarDate(line.businessDate, 'ORDERQ_REMATCH_V2_LINE_BUSINESS_DATE_INVALID') !== businessDate)) {
      throw new Error('ORDERQ_REMATCH_V2_SOURCE_BUSINESS_DATE_MISMATCH');
    }
    const lineBusinessOccurredAt = rematchBusinessTimestamp(line.businessOccurredAt, businessDate,
      'ORDERQ_REMATCH_V2_LINE_BUSINESS_TIMESTAMP_INVALID');
    const documentBusinessOccurredAt = rematchBusinessTimestamp(document.businessOccurredAt || document.businessEffectiveAt,
      businessDate, 'ORDERQ_REMATCH_V2_DOCUMENT_BUSINESS_TIMESTAMP_INVALID');
    if (lineBusinessOccurredAt && documentBusinessOccurredAt
      && lineBusinessOccurredAt !== documentBusinessOccurredAt) {
      throw new Error('ORDERQ_REMATCH_V2_SOURCE_BUSINESS_TIMESTAMP_MISMATCH');
    }
    const trustedBusinessOccurredAt = lineBusinessOccurredAt || documentBusinessOccurredAt;
    [pending.businessOccurredAt, reviewLink.businessOccurredAt].filter(value => text(value)).forEach(value => {
      const evidence = rematchBusinessTimestamp(value, businessDate,
        'ORDERQ_REMATCH_V2_PENDING_BUSINESS_TIMESTAMP_INVALID');
      if (!trustedBusinessOccurredAt || evidence !== trustedBusinessOccurredAt) {
        throw new Error('ORDERQ_REMATCH_V2_SOURCE_BUSINESS_TIMESTAMP_MISMATCH');
      }
    });
    assertRematchRevisionSnapshot({ command, link, document, line, revision, businessDate, actualQuantity });
  });
}

function rematchAuditRevision(command, unresolved, resolvedEffects, plan) {
  const beforeSnapshot = {
    unresolvedProduct: clone(unresolved),
    pendingEffects: resolvedEffects.map(row => clone(row.before))
  };
  const afterSnapshot = {
    productResolution: clone(plan.productResolution),
    resolvedEffects: resolvedEffects.map(row => clone(row.after))
  };
  return {
    voucherRevisionId: voucherStableId('VRM', command.companyId, command.unresolvedProductId, command.commandId),
    companyId: command.companyId,
    voucherMode: 'inventory-rematch',
    documentId: command.unresolvedProductId,
    revision: 1,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    action: 'REMATCH',
    status: 'CONFIRMED',
    beforeSnapshot,
    afterSnapshot,
    beforeDigest: canonicalSha256(beforeSnapshot),
    afterDigest: canonicalSha256(afterSnapshot),
    effects: plan.inventoryMovements.map(row => ({
      type: row.stocktakeEffectStatus === 'ABSORBED_BY_CHECKPOINT'
        ? 'INVENTORY_CHECKPOINT_ABSORPTION' : 'INVENTORY',
      id: row.movementId,
      pendingEffectId: row.pendingEffectId,
      status: row.effectStatus,
      stocktakeEffectStatus: row.stocktakeEffectStatus,
      officialInventoryApplied: row.officialInventoryApplied,
      signedQuantity: row.signedQuantity,
      originalSignedQuantity: row.originalSignedQuantity,
      checkpointId: row.checkpointId
    })),
    expectedDocuments: clone(command.expectedDocuments),
    expectedEffects: clone(command.expectedEffects),
    selectionEvidence: clone(command.selectionEvidence),
    schemaVersion: INVENTORY_REMATCH_AUDIT_SCHEMA_V2,
    identityVersion: command.identityVersion,
    entityType: 'INVENTORY_REMATCH_REVISION',
    actor: command.actor,
    occurredAt: command.occurredAt,
    judgedAt: command.judgedAt
  };
}

function rematchReceipt(command, result) {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    companyId: command.companyId,
    voucherMode: 'inventory-rematch',
    documentId: command.unresolvedProductId,
    commandType: command.commandType,
    status: 'COMMITTED',
    requestedAt: command.occurredAt,
    committedAt: nowIso(),
    payloadDigest: command.commandPayloadDigest,
    result
  };
}

function rematchQueueRow(command, auditRevision) {
  return {
    queueId: voucherStableId('SQRM', command.commandId),
    entityType: 'OFFICIAL_INVENTORY_REMATCH_COMMAND',
    entityId: command.commandId,
    operation: 'UPSERT',
    revision: 1,
    payload: {
      schemaVersion: 'ONEAPP_ORDERQ_INVENTORY_REMATCH_PAYLOAD_V2',
      companyId: command.companyId,
      command,
      projectionDigest: canonicalSha256(auditRevision)
    },
    status: 'WAITING_SERVER_CONTRACT',
    attemptCount: 0,
    createdAt: nowIso(),
    lastError: ''
  };
}

const REMATCH_SOURCE_STORES = Object.freeze([
  STORE.PURCHASE_DOCUMENTS,
  STORE.PURCHASE_LINES,
  STORE.SALES_DOCUMENTS,
  STORE.SALES_LINES,
  STORE.VOUCHER_REVISIONS,
  STORE.PENDING_INVENTORY_EFFECTS,
  STORE.INVENTORY_CHECKPOINTS,
  STORE.UNRESOLVED_PRODUCTS
]);

async function loadRematchSourceRows(tx, command) {
  const [unresolved, pendingInventoryEffects, inventoryCheckpoints, purchaseDocuments, purchaseLines,
    salesDocuments, salesLines, voucherRevisions] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.UNRESOLVED_PRODUCTS).get(command.unresolvedProductId)),
    requestToPromise(tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS)
      .index('byUnresolvedStatus').getAll([command.unresolvedProductId, 'PENDING_PRODUCT_MATCH'])),
    requestToPromise(tx.objectStore(STORE.INVENTORY_CHECKPOINTS).getAll()),
    requestToPromise(tx.objectStore(STORE.PURCHASE_DOCUMENTS).getAll()),
    requestToPromise(tx.objectStore(STORE.PURCHASE_LINES).getAll()),
    requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).getAll()),
    requestToPromise(tx.objectStore(STORE.SALES_LINES).getAll()),
    requestToPromise(tx.objectStore(STORE.VOUCHER_REVISIONS).getAll())
  ]);
  return { unresolved, pendingInventoryEffects, inventoryCheckpoints, purchaseDocuments, purchaseLines,
    salesDocuments, salesLines, voucherRevisions, unresolvedProducts: unresolved ? [unresolved] : [] };
}

function prepareInventoryRematch(command, sourceRows) {
  const unresolved = sourceRows.unresolved;
  if (!unresolved || text(unresolved.companyId) !== command.companyId
    || !['UNRESOLVED_PRODUCT', 'UNRESOLVED'].includes(text(unresolved.status).toUpperCase())) {
    throw new Error('ORDERQ_REMATCH_V2_UNRESOLVED_STATE_INVALID');
  }
  assertRematchSourceLinks(command, sourceRows);
  const preview = previewUnresolvedRematchImpact({
    companyId: command.companyId,
    unresolvedProductId: command.unresolvedProductId,
    selectedProduct: command.selectedProduct,
    source: sourceRows,
    generatedAt: command.judgedAt
  });
  assertRematchExpectedState(command, preview);
  return { preview, plan: planInventoryRematchCommandV2({ command, preview }) };
}

async function preflightInventoryRematchSource(command) {
  const db = await openOrderQDb();
  const tx = db.transaction(REMATCH_SOURCE_STORES, 'readonly');
  const done = transactionDone(tx);
  const sourceRows = await loadRematchSourceRows(tx, command);
  await done;
  prepareInventoryRematch(command, sourceRows);
}

async function existingRematchReceipt(command) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.OFFICIAL_COMMANDS, 'readonly');
  const receipt = await requestToPromise(tx.objectStore(STORE.OFFICIAL_COMMANDS).get(command.commandId));
  await transactionDone(tx);
  if (!receipt) return null;
  if (receipt.status !== 'COMMITTED'
    || text(receipt.payloadDigest) !== command.commandPayloadDigest
    || text(receipt.companyId) !== command.companyId
    || text(receipt.documentId) !== command.unresolvedProductId
    || text(receipt.voucherMode) !== 'inventory-rematch') {
    throw new Error('ORDERQ_REMATCH_V2_COMMAND_PAYLOAD_CONFLICT');
  }
  return { ...clone(receipt.result), duplicate: true };
}

export async function runOfficialInventoryRematchCommand(source = {}, options = {}) {
  const { command } = assertInventoryRematchCommandV2(source);
  const prior = await existingRematchReceipt(command);
  if (prior) return prior;
  await validateCurrentProductSnapshot(command, options.productSnapshotProvider || getProductSnapshot);
  await preflightInventoryRematchSource(command);

  const db = await openOrderQDb();
  const stores = [STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.SALES_DOCUMENTS, STORE.SALES_LINES,
    STORE.OFFICIAL_COMMANDS, STORE.VOUCHER_REVISIONS, STORE.INVENTORY_MOVEMENTS,
    STORE.PENDING_INVENTORY_EFFECTS, STORE.INVENTORY_CHECKPOINTS, STORE.UNRESOLVED_PRODUCTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(stores, 'readwrite');
  const commandStore = tx.objectStore(STORE.OFFICIAL_COMMANDS);
  const [existingCommand, existingIdempotency, sourceRows] = await Promise.all([
    requestToPromise(commandStore.get(command.commandId)),
    requestToPromise(commandStore.index('byIdempotencyKey').get(command.idempotencyKey)),
    loadRematchSourceRows(tx, command)
  ]);
  if (existingCommand || existingIdempotency) {
    if (existingCommand?.status === 'COMMITTED'
      && text(existingCommand.payloadDigest) === command.commandPayloadDigest
      && text(existingCommand.companyId) === command.companyId
      && text(existingCommand.documentId) === command.unresolvedProductId) {
      await transactionDone(tx);
      return { ...clone(existingCommand.result), duplicate: true };
    }
    return abortWith(tx, new Error('ORDERQ_REMATCH_V2_COMMAND_PAYLOAD_CONFLICT'));
  }
  const { unresolved, pendingInventoryEffects } = sourceRows;
  let preview;
  let plan;
  try {
    ({ preview, plan } = prepareInventoryRematch(command, sourceRows));
  } catch (error) {
    return abortWith(tx, error);
  }

  const movementByEffect = new Map(plan.inventoryMovements.map(row => [row.pendingEffectId, row]));
  const resolvedEffects = pendingInventoryEffects.map(before => {
    const movement = movementByEffect.get(before.pendingEffectId);
    if (!movement) throw new Error('ORDERQ_REMATCH_V2_MOVEMENT_PROJECTION_MISSING');
    const after = {
      ...clone(before),
      productId: command.selectedProduct.productId,
      productCode: command.selectedProduct.productCode,
      status: 'RESOLVED_PRODUCT_MATCH',
      inventoryEffectStatus: movement.effectStatus,
      stocktakeEffectStatus: movement.stocktakeEffectStatus,
      officialInventoryApplied: movement.officialInventoryApplied,
      checkpointId: movement.checkpointId,
      stocktakeDecisionType: movement.stocktakeDecisionType,
      resolutionId: plan.resolutionId,
      resolutionCommandId: command.commandId,
      productResolution: clone(plan.productResolution),
      resolvedAt: command.occurredAt,
      judgedAt: command.judgedAt,
      resolvedBy: command.actor
    };
    return { before, after };
  });
  const nextUnresolved = {
    ...clone(unresolved),
    productId: command.selectedProduct.productId,
    status: 'MATCHED',
    inventoryEffectStatus: 'REMATCH_RESOLVED',
    officialInventoryApplied: plan.inventoryMovements.some(row => row.officialInventoryApplied),
    productResolution: clone(plan.productResolution),
    resolutionId: plan.resolutionId,
    resolutionCommandId: command.commandId,
    resolvedAt: command.occurredAt,
    judgedAt: command.judgedAt,
    resolvedBy: command.actor,
    updatedAt: command.occurredAt
  };
  const auditRevision = rematchAuditRevision(command, unresolved, resolvedEffects, plan);
  const result = {
    authority: 'LOCAL_PILOT',
    schemaVersion: INVENTORY_REMATCH_AUDIT_SCHEMA_V2,
    command,
    productResolution: plan.productResolution,
    unresolvedProduct: nextUnresolved,
    resolvedEffects: resolvedEffects.map(row => row.after),
    inventoryMovements: plan.inventoryMovements,
    voucherRevision: auditRevision,
    duplicate: false
  };
  tx.objectStore(STORE.UNRESOLVED_PRODUCTS).put(nextUnresolved);
  resolvedEffects.forEach(row => tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).put(row.after));
  plan.inventoryMovements.forEach(row => tx.objectStore(STORE.INVENTORY_MOVEMENTS).add(row));
  tx.objectStore(STORE.VOUCHER_REVISIONS).add(auditRevision);
  commandStore.add(rematchReceipt(command, result));
  tx.objectStore(STORE.SYNC_QUEUE).add(rematchQueueRow(command, auditRevision));
  await transactionDone(tx);
  return result;
}

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
  assertSupportedIdentityVersion(command);
  const checkedV2 = isOfficialVoucherIdentityV2(command) ? assertOfficialCommandV2(command) : null;
  const contract = inferKind(command || {});
  const id = documentIdOf(contract, command || {});
  if (text(payload.companyId) !== text(command.companyId) || text(payload.documentId) !== id
    || text(payload.voucherMode) !== contract.mode) throw new Error('ORDERQ_OFFICIAL_REMOTE_IDENTITY_INVALID');
  const commandId = text(command.commandId);
  const db = await openOrderQDb();
  const storeNames = [contract.documentStore, contract.lineStore, STORE.OFFICIAL_COMMANDS,
    STORE.VOUCHER_REVISIONS, STORE.INVENTORY_MOVEMENTS, contract.partnerEntryStore,
    STORE.PENDING_INVENTORY_EFFECTS, STORE.UNRESOLVED_PRODUCTS];
  if (checkedV2) storeNames.push(STORE.INVENTORY_CHECKPOINTS);
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
    if (checkedV2) {
      try {
        assertOfficialLedgerProjectionV2(existingCommand.result, checkedV2);
        assertOfficialStocktakeProjectionV2(existingCommand.result, checkedV2.command);
      } catch (error) {
        tx.abort();
        try { await transactionDone(tx); } catch {}
        throw error;
      }
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
  const checkpoints = checkedV2
    ? await checkpointRowsForCommand(tx.objectStore(STORE.INVENTORY_CHECKPOINTS), command)
    : [];
  let plan;
  try {
    plan = planOfficialVoucherCommand({ command, document, lines, inventoryCheckpoints: checkpoints });
  } catch (error) {
    tx.abort();
    try { await transactionDone(tx); } catch {}
    throw error;
  }
  if (checkedV2) {
    try {
      assertOfficialLedgerProjectionV2(plan, checkedV2);
      assertOfficialStocktakeProjectionV2(plan, checkedV2.command);
    } catch (error) {
      tx.abort();
      try { await transactionDone(tx); } catch {}
      throw error;
    }
  }
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
  void source;
  throw new Error('ORDERQ_REMATCH_OWNER_GATEWAY_REQUIRED');
}
