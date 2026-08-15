export const ORDERQ_DB_VERSION = 7;

export const DISPATCH_STAGE = Object.freeze({
  FIRST_WHOLESALE: 'FIRST_WHOLESALE',
  SECOND_FULFILLMENT: 'SECOND_FULFILLMENT',
  UNSPECIFIED: 'UNSPECIFIED'
});

export const DISPATCH_STAGE_POLICY = Object.freeze({
  defaultCode: DISPATCH_STAGE.UNSPECIFIED,
  codes: Object.freeze(Object.values(DISPATCH_STAGE))
});

export const ERP_POSTING_STATUS = Object.freeze({
  NOT_READY: 'NOT_READY',
  READY: 'READY',
  EXPORTED: 'EXPORTED',
  POSTED: 'POSTED',
  RECONCILED: 'RECONCILED',
  CORRECTION_REQUIRED: 'CORRECTION_REQUIRED'
});

export const MVP_ACTOR_ID = 'ADMIN';

export const CAPABILITY = Object.freeze({
  DISPATCH_EDIT: 'DISPATCH_EDIT',
  DISPATCH_RELEASE: 'DISPATCH_RELEASE',
  DISPATCH_CONFIRM: 'DISPATCH_CONFIRM',
  DISPATCH_REVERSE: 'DISPATCH_REVERSE',
  SUBSTITUTE_APPROVE: 'SUBSTITUTE_APPROVE',
  OVER_DISPATCH_APPROVE: 'OVER_DISPATCH_APPROVE',
  PURCHASE_CONFIRM: 'PURCHASE_CONFIRM',
  BACKDATE_POST: 'BACKDATE_POST',
  MASTER_LINK: 'MASTER_LINK'
});

export const V7_STORE = Object.freeze({
  DISPATCH_DECISIONS: 'dispatchDecisions',
  DISPATCH_LINES: 'dispatchLines',
  DISPATCH_STOCK_ALLOCATIONS: 'dispatchStockAllocations',
  DISPATCH_APPROVALS: 'dispatchApprovals',
  INVENTORY_RESERVATIONS: 'inventoryReservations',
  INVENTORY_MOVEMENTS: 'inventoryMovements',
  DISPATCH_RECONCILIATIONS: 'dispatchReconciliations'
});

const index = (name, keyPath, options = {}) => Object.freeze({ name, keyPath, options: Object.freeze({ ...options }) });

export const V7_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: V7_STORE.DISPATCH_DECISIONS,
    keyPath: 'dispatchId',
    indexes: Object.freeze([
      index('byStatusUpdatedAt', ['status', 'updatedAt']),
      index('byCustomerDate', ['customerId', 'businessDate']),
      index('byStageDate', ['dispatchStageCode', 'businessDate']),
      index('byDispatchNo', 'dispatchNo', { unique: true }),
      index('byConfirmedAt', 'confirmedAt')
    ])
  }),
  Object.freeze({
    name: V7_STORE.DISPATCH_LINES,
    keyPath: 'dispatchLineId',
    indexes: Object.freeze([
      index('byDispatchId', 'dispatchId'),
      index('byOrderItemId', 'orderItemId'),
      index('byActualProductId', 'actualProductId'),
      index('byExecutionStatus', 'executionStatus')
    ])
  }),
  Object.freeze({
    name: V7_STORE.DISPATCH_STOCK_ALLOCATIONS,
    keyPath: 'allocationId',
    indexes: Object.freeze([
      index('byDispatchId', 'dispatchId'),
      index('byDispatchLineId', 'dispatchLineId'),
      index('byWarehouseId', 'warehouseId'),
      index('byReservationId', 'reservationId')
    ])
  }),
  Object.freeze({
    name: V7_STORE.DISPATCH_APPROVALS,
    keyPath: 'approvalId',
    indexes: Object.freeze([
      index('byDispatchId', 'dispatchId'),
      index('byDispatchLineId', 'dispatchLineId'),
      index('byOrderItemId', 'orderItemId'),
      index('byTypeStatus', ['approvalType', 'status'])
    ])
  }),
  Object.freeze({
    name: V7_STORE.INVENTORY_RESERVATIONS,
    keyPath: 'reservationId',
    indexes: Object.freeze([
      index('byDispatchId', 'dispatchId'),
      index('byDispatchLineId', 'dispatchLineId'),
      index('byAllocationId', 'allocationId'),
      index('byProductWarehouseStatus', ['productId', 'warehouseId', 'status']),
      index('byExpiresAt', 'expiresAt')
    ])
  }),
  Object.freeze({
    name: V7_STORE.INVENTORY_MOVEMENTS,
    keyPath: 'movementId',
    indexes: Object.freeze([
      index('byLedgerSequence', 'ledgerSequence', { unique: true }),
      index('byProductWarehouse', ['productId', 'warehouseId']),
      index('bySourceDocument', ['sourceDocumentType', 'sourceDocumentId']),
      index('byDispatchId', 'dispatchId'),
      index('byOccurredAt', 'occurredAt'),
      index('byPostedAt', 'postedAt'),
      index('byTransferId', 'transferId'),
      index('byIdempotencyKey', 'idempotencyKey', { unique: true })
    ])
  }),
  Object.freeze({
    name: V7_STORE.DISPATCH_RECONCILIATIONS,
    keyPath: 'reconciliationId',
    indexes: Object.freeze([
      index('byDispatchId', 'dispatchId'),
      index('byDispatchLineId', 'dispatchLineId'),
      index('byStatus', 'status'),
      index('byIssueType', 'issueType')
    ])
  })
]);

export const V7_EXISTING_STORE_INDEXES = Object.freeze({
  salesDocuments: Object.freeze([
    index('byIdempotencyKey', 'idempotencyKey', { unique: true }),
    index('byOriginTransaction', ['originSystem', 'originTransactionId']),
    index('byExternalDocumentNo', ['originSystem', 'externalDocumentNo']),
    index('bySourceFingerprint', 'sourceFingerprint'),
    index('byErpPostingStatus', ['erpPostingStatus', 'businessDate']),
    index('byErpDocumentNo', 'erpDocumentNo')
  ]),
  salesLines: Object.freeze([
    index('byDispatchLineId', 'dispatchLineId'),
    index('byExternalLineNo', ['salesDocumentId', 'externalLineNo']),
    index('bySourceLineFingerprint', 'sourceLineFingerprint')
  ]),
  purchaseDocuments: Object.freeze([
    index('byIdempotencyKey', 'idempotencyKey', { unique: true }),
    index('byOriginTransaction', ['originSystem', 'originTransactionId']),
    index('byExternalDocumentNo', ['originSystem', 'externalDocumentNo']),
    index('bySourceFingerprint', 'sourceFingerprint'),
    index('byErpPostingStatus', ['erpPostingStatus', 'businessDate']),
    index('byErpDocumentNo', 'erpDocumentNo')
  ]),
  purchaseLines: Object.freeze([
    index('byExternalLineNo', ['purchaseDocumentId', 'externalLineNo']),
    index('bySourceLineFingerprint', 'sourceLineFingerprint')
  ])
});

export const V7_SYNC_ENTITY_CONTRACT = Object.freeze({
  DISPATCH_DECISION: Object.freeze({ storeName: V7_STORE.DISPATCH_DECISIONS, idField: 'dispatchId' }),
  DISPATCH_LINE: Object.freeze({ storeName: V7_STORE.DISPATCH_LINES, idField: 'dispatchLineId' }),
  DISPATCH_STOCK_ALLOCATION: Object.freeze({ storeName: V7_STORE.DISPATCH_STOCK_ALLOCATIONS, idField: 'allocationId' }),
  DISPATCH_APPROVAL: Object.freeze({ storeName: V7_STORE.DISPATCH_APPROVALS, idField: 'approvalId' }),
  INVENTORY_RESERVATION: Object.freeze({ storeName: V7_STORE.INVENTORY_RESERVATIONS, idField: 'reservationId' }),
  INVENTORY_MOVEMENT: Object.freeze({ storeName: V7_STORE.INVENTORY_MOVEMENTS, idField: 'movementId' }),
  DISPATCH_RECONCILIATION: Object.freeze({ storeName: V7_STORE.DISPATCH_RECONCILIATIONS, idField: 'reconciliationId' })
});

export function normalizeDispatchStageCode(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return DISPATCH_STAGE_POLICY.codes.includes(normalized) ? normalized : DISPATCH_STAGE_POLICY.defaultCode;
}

function preserveString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function normalizeExternalIdentity(source = {}) {
  return {
    idempotencyKey: preserveString(source.idempotencyKey),
    originSystem: preserveString(source.originSystem),
    originTransactionId: preserveString(source.originTransactionId),
    externalDocumentNo: preserveString(source.externalDocumentNo),
    externalLineNo: preserveString(source.externalLineNo),
    importBatchId: preserveString(source.importBatchId),
    sourceFingerprint: preserveString(source.sourceFingerprint),
    sourceLineFingerprint: preserveString(source.sourceLineFingerprint)
  };
}

export function buildExternalIdentityKey(source = {}) {
  const identity = normalizeExternalIdentity(source);
  if (identity.idempotencyKey) return identity.idempotencyKey;
  if (identity.originSystem && identity.originTransactionId) {
    return `TX:${identity.originSystem}:${identity.originTransactionId}`;
  }
  if (identity.originSystem && identity.externalDocumentNo) {
    const line = identity.externalLineNo ? `:${identity.externalLineNo}` : '';
    return `DOC:${identity.originSystem}:${identity.externalDocumentNo}${line}`;
  }
  if (identity.sourceLineFingerprint) return `LINE:${identity.sourceLineFingerprint}`;
  if (identity.sourceFingerprint) return `SOURCE:${identity.sourceFingerprint}`;
  return '';
}

export function normalizeErpPostingFields(source = {}) {
  const values = Object.values(ERP_POSTING_STATUS);
  const requested = preserveString(source.erpPostingStatus).toUpperCase();
  const businessStatus = preserveString(source.status).toUpperCase();
  const erpPostingStatus = values.includes(requested)
    ? requested
    : (businessStatus === 'CONFIRMED' ? ERP_POSTING_STATUS.READY : ERP_POSTING_STATUS.NOT_READY);
  return {
    erpPostingStatus,
    erpDocumentNo: preserveString(source.erpDocumentNo),
    erpPostedAt: preserveString(source.erpPostedAt),
    erpPostedBy: preserveString(source.erpPostedBy),
    erpReconciledAt: preserveString(source.erpReconciledAt),
    erpReconciliationId: preserveString(source.erpReconciliationId),
    erpCorrectionReason: preserveString(source.erpCorrectionReason)
  };
}

export function createActorContext(actor) {
  const source = actor === undefined ? MVP_ACTOR_ID : actor;
  if (typeof source === 'string') return { actorId: preserveString(source), capabilities: [] };
  const actorId = preserveString(source?.actorId);
  const capabilities = Array.isArray(actor?.capabilities)
    ? [...new Set(actor.capabilities.map(value => preserveString(value)).filter(Boolean))]
    : [];
  return { actorId, capabilities };
}

export function actorHasCapability(actor, capability) {
  const context = createActorContext(actor);
  return context.actorId === MVP_ACTOR_ID || !capability || context.capabilities.includes(capability);
}

export function requireActor(actor) {
  const context = createActorContext(actor);
  if (!context.actorId) throw new Error('ORDERQ_ACTOR_REQUIRED');
  return context;
}

export function requireCapability(actor, capability) {
  const context = requireActor(actor);
  if (!actorHasCapability(context, capability)) throw new Error(`ORDERQ_CAPABILITY_REQUIRED:${capability}`);
  return context;
}

export function legacyInventoryEffect({ documentType, quantity, status = 'ACTIVE', disabledAt = '', rolledBackAt = '' } = {}) {
  const normalizedType = preserveString(documentType).toUpperCase();
  const normalizedStatus = preserveString(status).toUpperCase() || 'ACTIVE';
  const rawQuantity = Number(quantity);
  if (!Number.isFinite(rawQuantity)) throw new Error('ORDERQ_LEGACY_QUANTITY_INVALID');
  const excluded = Boolean(disabledAt || rolledBackAt || normalizedStatus === 'ROLLED_BACK' || normalizedStatus === 'INACTIVE');
  if (excluded) return { included: false, documentType: normalizedType, status: normalizedStatus, rawQuantity, inventoryEffect: 0 };
  if (!['ACTIVE', 'REVERSAL'].includes(normalizedStatus)) throw new Error(`ORDERQ_LEGACY_STATUS_UNSUPPORTED:${normalizedStatus}`);
  if (!['PURCHASE', 'SALES'].includes(normalizedType)) throw new Error(`ORDERQ_LEGACY_DOCUMENT_UNSUPPORTED:${normalizedType}`);
  return {
    included: true,
    documentType: normalizedType,
    status: normalizedStatus,
    rawQuantity,
    inventoryEffect: rawQuantity === 0 ? 0 : (normalizedType === 'PURCHASE' ? rawQuantity : -rawQuantity)
  };
}

export function adaptLegacyInventoryLine({ documentType, document = {}, line = {} } = {}) {
  const normalizedType = preserveString(documentType).toUpperCase();
  const documentIdField = normalizedType === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const lineIdField = normalizedType === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId';
  const effect = legacyInventoryEffect({
    documentType: normalizedType,
    quantity: line.quantity,
    status: line.status || document.status || 'ACTIVE',
    disabledAt: line.disabledAt || document.disabledAt || '',
    rolledBackAt: line.rolledBackAt || document.rolledBackAt || ''
  });
  return {
    ...effect,
    sourceDocumentId: preserveString(document[documentIdField] || line[documentIdField]),
    sourceLineId: preserveString(line[lineIdField]),
    productId: preserveString(line.productId),
    productCode: preserveString(line.productCode),
    warehouseId: preserveString(line.warehouseId || document.warehouseId),
    rawUnit: line.unit === undefined || line.unit === null ? '' : String(line.unit),
    rawValue: line.quantity
  };
}

export function validateV7Definitions() {
  const storeNames = new Set();
  for (const definition of V7_STORE_DEFINITIONS) {
    if (storeNames.has(definition.name)) throw new Error(`ORDERQ_V7_DUPLICATE_STORE:${definition.name}`);
    storeNames.add(definition.name);
    const indexNames = new Set();
    for (const entry of definition.indexes) {
      if (indexNames.has(entry.name)) throw new Error(`ORDERQ_V7_DUPLICATE_INDEX:${definition.name}:${entry.name}`);
      indexNames.add(entry.name);
    }
  }
  return true;
}

validateV7Definitions();
