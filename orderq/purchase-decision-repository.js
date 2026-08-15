import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import {
  CAPABILITY,
  ERP_POSTING_STATUS,
  normalizeExternalIdentity,
  requireCapability
} from './orderq-v7-contracts.js?v=0.8.0';
import { INVENTORY_MOVEMENT_TYPE } from './inventory-ledger.js?v=0.8.0';
import { appendInventoryMovementsInTransaction } from './inventory-ledger-repository.js?v=0.8.0';
import {
  PURCHASE_CONFIRMATION_STEP,
  PURCHASE_STATUS,
  allocatePurchaseReversalAmount,
  allocatePurchaseReversalDimension,
  exactPurchaseExternalMatch,
  normalizePurchaseConfirmationCommand,
  normalizePurchaseDraft,
  normalizePurchaseReversalCommand,
  purchaseCheckpoint,
  purchaseConfirmationFingerprint,
  purchaseExternalReconciliationFingerprint,
  purchaseReversalFingerprint,
  stablePurchaseId,
  validatePurchaseReady
} from './purchase-decision.js?v=0.8.0';

const PURCHASE_TRANSACTION_STORES = Object.freeze([
  STORE.PRODUCTS,
  STORE.WAREHOUSES,
  STORE.ORDER_ITEMS,
  STORE.DISPATCH_LINES,
  STORE.PURCHASE_DOCUMENTS,
  STORE.PURCHASE_LINES,
  STORE.INVENTORY_MOVEMENTS,
  STORE.DISPATCH_RECONCILIATIONS,
  STORE.META,
  STORE.SYNC_QUEUE
]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function allFrom(tx, storeName, indexName = '', query = undefined) {
  const store = tx.objectStore(storeName);
  return requestToPromise((indexName ? store.index(indexName) : store).getAll(query));
}

function activeReference(row) {
  return Boolean(row) && row.active !== false && !row.disabledAt && text(row.status).toUpperCase() !== 'INACTIVE';
}

function historyEvent(eventType, actorId, detail, timestamp) {
  return { eventId: newId('PH'), eventType, actorId, detail: clone(detail), createdAt: timestamp };
}

function queueLocalEntity(tx, { entityType, entityId, payload, revision = 1, baseRevision = 0, idempotencyKey = '', operation = 'UPSERT' }) {
  const timestamp = nowIso();
  const row = {
    queueId: newId('SQ'), entityType, entityId, operation,
    revision: Number(revision || 0), baseRevision: Number(baseRevision || 0),
    payload: clone(payload), status: 'LOCAL_ONLY', localOnly: true,
    confirmationIdempotencyKey: idempotencyKey,
    createdAt: timestamp, updatedAt: timestamp
  };
  tx.objectStore(STORE.SYNC_QUEUE).add(row);
  return row;
}

function purchaseResult(tx, document, duplicate) {
  return Promise.all([
    allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', document.purchaseDocumentId),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'bySourceDocument', ['PURCHASE', document.purchaseDocumentId]),
    allFrom(tx, STORE.SYNC_QUEUE)
  ]).then(([lines, movements, outbox]) => ({
    duplicate,
    document,
    lines,
    movements,
    outbox: outbox.filter(row => row.confirmationIdempotencyKey === document.idempotencyKey)
  }));
}

export async function listPurchases({ status = '', search = '' } = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES], 'readonly');
  const [documents, lines] = await Promise.all([
    allFrom(tx, STORE.PURCHASE_DOCUMENTS),
    allFrom(tx, STORE.PURCHASE_LINES)
  ]);
  await transactionDone(tx);
  const lineByDocument = new Map();
  for (const line of lines) {
    if (!lineByDocument.has(line.purchaseDocumentId)) lineByDocument.set(line.purchaseDocumentId, []);
    lineByDocument.get(line.purchaseDocumentId).push(line);
  }
  const normalizedStatus = text(status).toUpperCase();
  const query = text(search).toLowerCase();
  return documents
    .filter(row => [PURCHASE_STATUS.DRAFT, PURCHASE_STATUS.CONFIRMED, PURCHASE_STATUS.REVERSED, PURCHASE_STATUS.CANCELED].includes(text(row.status).toUpperCase()))
    .filter(row => !normalizedStatus || text(row.status).toUpperCase() === normalizedStatus)
    .filter(row => !query || [row.purchaseDocumentId, row.supplierName, row.sourceShortageKey, ...(lineByDocument.get(row.purchaseDocumentId) || []).flatMap(line => [line.productCode, line.productName])]
      .some(value => text(value).toLowerCase().includes(query)))
    .map(row => ({ ...row, lineCount: (lineByDocument.get(row.purchaseDocumentId) || []).length }))
    .sort((left, right) => text(right.updatedAt || right.createdAt).localeCompare(text(left.updatedAt || left.createdAt)));
}

export async function loadPurchaseAggregate(purchaseDocumentId) {
  const id = text(purchaseDocumentId);
  if (!id) throw new Error('ORDERQ_PURCHASE_DOCUMENT_ID_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.INVENTORY_MOVEMENTS, STORE.DISPATCH_RECONCILIATIONS], 'readonly');
  const document = await requestToPromise(tx.objectStore(STORE.PURCHASE_DOCUMENTS).get(id));
  if (!document) throw new Error('ORDERQ_PURCHASE_DOCUMENT_NOT_FOUND');
  const [lines, movements, reconciliations] = await Promise.all([
    allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', id),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'bySourceDocument', ['PURCHASE', id]),
    allFrom(tx, STORE.DISPATCH_RECONCILIATIONS)
  ]);
  await transactionDone(tx);
  return {
    document,
    lines: lines.sort((left, right) => text(left.purchaseLineId).localeCompare(text(right.purchaseLineId))),
    movements,
    reconciliations: reconciliations.filter(row => row.purchaseDocumentId === id || row.sourcePurchaseDocumentId === id)
  };
}

export async function savePurchaseDraft(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.PURCHASE_CONFIRM);
  const draftId = text(source.document?.purchaseDocumentId || source.purchaseDocumentId) || newId('PD');
  const preparedSource = {
    ...source,
    document: { ...(source.document || source), purchaseDocumentId: draftId },
    lines: (Array.isArray(source.lines) ? source.lines : []).map(row => ({
      ...row,
      purchaseDocumentId: draftId,
      purchaseLineId: text(row.purchaseLineId) || newId('PL')
    }))
  };
  const normalized = normalizePurchaseDraft(preparedSource);
  if (!normalized.lines.length) throw new Error('ORDERQ_PURCHASE_DRAFT_LINE_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction(PURCHASE_TRANSACTION_STORES, 'readwrite');
  try {
    const documentStore = tx.objectStore(STORE.PURCHASE_DOCUMENTS);
    const lineStore = tx.objectStore(STORE.PURCHASE_LINES);
    const existing = await requestToPromise(documentStore.get(draftId));
    if (existing && text(existing.status).toUpperCase() !== PURCHASE_STATUS.DRAFT) throw new Error('ORDERQ_PURCHASE_DRAFT_STATE_INVALID');
    const currentRevision = Number(existing?.revision || 0);
    if (currentRevision !== normalized.expectedRevision) throw new Error(`ORDERQ_PURCHASE_REVISION_CONFLICT:${currentRevision}`);

    if (normalized.document.sourceShortageKey) {
      const sameShortage = (await allFrom(tx, STORE.PURCHASE_DOCUMENTS)).find(row => row.purchaseDocumentId !== draftId
        && row.sourceShortageKey === normalized.document.sourceShortageKey
        && ![PURCHASE_STATUS.REVERSED, PURCHASE_STATUS.CANCELED].includes(text(row.status).toUpperCase()));
      if (sameShortage) throw new Error(`ORDERQ_PURCHASE_SHORTAGE_ALREADY_LINKED:${sameShortage.purchaseDocumentId}`);
    }

    for (const line of normalized.lines) {
      if (line.sourceDispatchLineId) {
        const dispatchLine = await requestToPromise(tx.objectStore(STORE.DISPATCH_LINES).get(line.sourceDispatchLineId));
        if (!dispatchLine || (line.sourceOrderItemId && dispatchLine.orderItemId !== line.sourceOrderItemId)) {
          throw new Error(`ORDERQ_PURCHASE_SHORTAGE_DISPATCH_LINE_INVALID:${line.purchaseLineId}`);
        }
      }
      if (line.sourceOrderItemId) {
        const item = await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).get(line.sourceOrderItemId));
        if (!item) throw new Error(`ORDERQ_PURCHASE_SHORTAGE_ORDER_ITEM_INVALID:${line.purchaseLineId}`);
      }
    }

    const timestamp = nowIso();
    const nextRevision = currentRevision + 1;
    const external = normalizeExternalIdentity(normalized.document);
    const { idempotencyKey: _ignoredIdempotencyKey, ...documentSource } = normalized.document;
    const document = {
      ...documentSource,
      purchaseDocumentId: draftId,
      originSystem: external.originSystem || 'ORDER_Q',
      originTransactionId: external.originTransactionId || draftId,
      externalDocumentNo: external.externalDocumentNo,
      importBatchId: external.importBatchId,
      sourceFingerprint: external.sourceFingerprint,
      status: PURCHASE_STATUS.DRAFT,
      erpPostingStatus: ERP_POSTING_STATUS.NOT_READY,
      syncStatus: 'LOCAL_ONLY',
      revision: nextRevision,
      baseRevision: currentRevision,
      amountWon: normalized.lines.reduce((sum, row) => sum + finite(row.amountWon), 0),
      updatedAt: timestamp,
      updatedBy: context.actorId,
      createdAt: existing?.createdAt || timestamp,
      createdBy: existing?.createdBy || context.actorId,
      history: [...(Array.isArray(existing?.history) ? existing.history : []), historyEvent('PURCHASE_DRAFT_SAVED', context.actorId, {
        sourceShortageKey: normalized.document.sourceShortageKey,
        lineCount: normalized.lines.length
      }, timestamp)],
      localOnly: true
    };
    documentStore.put(document);

    const priorLines = existing ? await allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', draftId) : [];
    const nextIds = new Set(normalized.lines.map(row => row.purchaseLineId));
    for (const prior of priorLines) {
      if (!nextIds.has(prior.purchaseLineId)) {
        lineStore.delete(prior.purchaseLineId);
        queueLocalEntity(tx, { entityType: 'PURCHASE_LINE', entityId: prior.purchaseLineId, payload: { purchaseLineId: prior.purchaseLineId }, revision: nextRevision, baseRevision: currentRevision, operation: 'DELETE' });
      }
    }
    const lines = normalized.lines.map(row => {
      const line = {
        ...row,
        purchaseDocumentId: draftId,
        status: PURCHASE_STATUS.DRAFT,
        revision: nextRevision,
        updatedAt: timestamp,
        updatedBy: context.actorId,
        createdAt: priorLines.find(item => item.purchaseLineId === row.purchaseLineId)?.createdAt || timestamp,
        createdBy: priorLines.find(item => item.purchaseLineId === row.purchaseLineId)?.createdBy || context.actorId,
        localOnly: true
      };
      lineStore.put(line);
      return line;
    });
    queueLocalEntity(tx, { entityType: 'PURCHASE_DOCUMENT', entityId: draftId, payload: document, revision: nextRevision, baseRevision: currentRevision });
    lines.forEach(line => queueLocalEntity(tx, { entityType: 'PURCHASE_LINE', entityId: line.purchaseLineId, payload: line, revision: nextRevision, baseRevision: currentRevision }));
    await transactionDone(tx);
    return { document, lines };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function createPurchaseDraftFromShortage(source = {}, actor = 'ADMIN') {
  const shortageQuantity = finite(source.shortageQuantity ?? source.sourceShortageQuantity);
  const sourceShortageKey = text(source.sourceShortageKey)
    || [text(source.sourceDispatchLineId), text(source.sourceOrderItemId), shortageQuantity].filter(Boolean).join(':');
  if (!sourceShortageKey || !(shortageQuantity > 0)) throw new Error('ORDERQ_PURCHASE_SHORTAGE_EVIDENCE_REQUIRED');
  return savePurchaseDraft({
    document: {
      purchaseDocumentId: text(source.purchaseDocumentId),
      sourceShortageKey,
      sourceShortageQuantity: shortageQuantity,
      supplierId: text(source.supplierId),
      supplierName: text(source.supplierName),
      businessDate: text(source.businessDate),
      actualTransactionAt: text(source.actualTransactionAt),
      backdateReason: text(source.backdateReason),
      memo: source.memo || '출고 부족근거 구매 DRAFT'
    },
    lines: [{
      productId: text(source.productId),
      productCode: text(source.productCode),
      productName: text(source.productName),
      warehouseId: text(source.warehouseId),
      warehouseCode: text(source.warehouseCode),
      warehouseName: text(source.warehouseName),
      quantity: source.quantity ?? shortageQuantity,
      unit: source.unit || '',
      baseQuantity: source.baseQuantity ?? source.quantity ?? shortageQuantity,
      baseUnit: source.baseUnit || source.unit || '',
      unitCostWon: source.unitCostWon ?? 0,
      sourceOrderItemId: text(source.sourceOrderItemId),
      sourceDispatchId: text(source.sourceDispatchId),
      sourceDispatchLineId: text(source.sourceDispatchLineId)
    }],
    expectedRevision: Number(source.expectedRevision || 0)
  }, actor);
}

export async function confirmPurchase(source = {}, actor = 'ADMIN', options = {}) {
  const context = requireCapability(actor, CAPABILITY.PURCHASE_CONFIRM);
  const command = normalizePurchaseConfirmationCommand(source);
  const fingerprint = purchaseConfirmationFingerprint(command);
  const db = await openOrderQDb();
  const tx = db.transaction(PURCHASE_TRANSACTION_STORES, 'readwrite');
  try {
    const documentStore = tx.objectStore(STORE.PURCHASE_DOCUMENTS);
    const existing = await requestToPromise(documentStore.index('byIdempotencyKey').get(command.idempotencyKey));
    if (existing) {
      if (existing.purchaseDocumentId !== command.purchaseDocumentId || existing.confirmationRequestFingerprint !== fingerprint) {
        throw new Error(`ORDERQ_PURCHASE_CONFIRM_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
      }
      const result = await purchaseResult(tx, existing, true);
      await transactionDone(tx);
      return result;
    }
    const document = await requestToPromise(documentStore.get(command.purchaseDocumentId));
    if (!document || text(document.status).toUpperCase() !== PURCHASE_STATUS.DRAFT) throw new Error('ORDERQ_PURCHASE_CONFIRM_DRAFT_REQUIRED');
    if (Number(document.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_PURCHASE_REVISION_CONFLICT:${document.revision}`);
    const lines = await allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', command.purchaseDocumentId);
    validatePurchaseReady(document, lines);

    const occurredAt = text(document.actualTransactionAt || document.businessDate || document.purchaseDate);
    if (occurredAt.slice(0, 10) < nowIso().slice(0, 10)) {
      requireCapability(actor, CAPABILITY.BACKDATE_POST);
      if (!text(document.backdateReason)) throw new Error('ORDERQ_PURCHASE_BACKDATE_REASON_REQUIRED');
    }
    for (const line of lines) {
      const [product, warehouse] = await Promise.all([
        requestToPromise(tx.objectStore(STORE.PRODUCTS).get(line.productId)),
        requestToPromise(tx.objectStore(STORE.WAREHOUSES).get(line.warehouseId))
      ]);
      if (!activeReference(product)) throw new Error(`ORDERQ_PURCHASE_PRODUCT_NOT_ACTIVE:${line.purchaseLineId}`);
      if (!activeReference(warehouse)) throw new Error(`ORDERQ_PURCHASE_WAREHOUSE_NOT_ACTIVE:${line.purchaseLineId}`);
    }

    const timestamp = nowIso();
    const nextRevision = Number(document.revision || 0) + 1;
    const confirmedLines = lines.map(line => ({
      ...line,
      amountWon: Math.round(finite(line.quantity) * finite(line.unitCostWon)),
      status: PURCHASE_STATUS.CONFIRMED,
      revision: nextRevision,
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId
    }));
    const confirmedDocument = {
      ...document,
      status: PURCHASE_STATUS.CONFIRMED,
      erpPostingStatus: ERP_POSTING_STATUS.READY,
      idempotencyKey: command.idempotencyKey,
      confirmationRequestFingerprint: fingerprint,
      amountWon: confirmedLines.reduce((sum, row) => sum + finite(row.amountWon), 0),
      revision: nextRevision,
      baseRevision: Number(document.revision || 0),
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      postedAt: timestamp,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [...(Array.isArray(document.history) ? document.history : []), historyEvent('PURCHASE_CONFIRMED', context.actorId, {
        lineCount: confirmedLines.length,
        actualTransactionAt: occurredAt,
        backdated: occurredAt.slice(0, 10) < timestamp.slice(0, 10)
      }, timestamp)]
    };
    documentStore.put(confirmedDocument);
    confirmedLines.forEach(line => tx.objectStore(STORE.PURCHASE_LINES).put(line));
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.DOCUMENT_WRITTEN);

    const movementResults = await appendInventoryMovementsInTransaction({
      tx,
      actor: context,
      drafts: confirmedLines.map(line => ({
        productId: line.productId,
        productCode: line.productCode,
        warehouseId: line.warehouseId,
        signedBaseQuantity: finite(line.baseQuantity),
        baseUnit: line.baseUnit || line.unit,
        movementType: INVENTORY_MOVEMENT_TYPE.PURCHASE_RECEIPT,
        sourceDocumentType: 'PURCHASE',
        sourceDocumentId: confirmedDocument.purchaseDocumentId,
        sourceLineId: line.purchaseLineId,
        occurredAt,
        reason: confirmedDocument.backdateReason || confirmedDocument.memo || '구매확정 입고',
        idempotencyKey: `${command.idempotencyKey}:${line.purchaseLineId}`
      }))
    });
    if (movementResults.some(row => row.duplicate)) throw new Error('ORDERQ_PURCHASE_CONFIRM_PARTIAL_MOVEMENT_STATE');
    movementResults.forEach((result, index) => {
      confirmedLines[index].movementId = result.movement.movementId;
      tx.objectStore(STORE.PURCHASE_LINES).put(confirmedLines[index]);
    });
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.MOVEMENTS_WRITTEN);

    const enqueue = entry => queueLocalEntity(tx, { ...entry, idempotencyKey: command.idempotencyKey, revision: nextRevision, baseRevision: document.revision });
    enqueue({ entityType: 'PURCHASE_DOCUMENT', entityId: confirmedDocument.purchaseDocumentId, payload: confirmedDocument });
    confirmedLines.forEach(line => enqueue({ entityType: 'PURCHASE_LINE', entityId: line.purchaseLineId, payload: line }));
    movementResults.forEach(result => enqueue({ entityType: 'INVENTORY_MOVEMENT', entityId: result.movement.movementId, payload: result.movement }));
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.OUTBOX_WRITTEN);
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.BEFORE_COMMIT);
    await transactionDone(tx);
    return {
      duplicate: false,
      document: confirmedDocument,
      lines: confirmedLines,
      movements: movementResults.map(row => row.movement)
    };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

function buildPurchaseReversalPlan(command, originalDocument, originalLines, allLines, allDocuments, allMovements) {
  const inputByLine = new Map(command.lines.map(row => [row.purchaseLineId, row]));
  const documentById = new Map(allDocuments.map(row => [row.purchaseDocumentId, row]));
  const movementById = new Map(allMovements.map(row => [row.movementId, row]));
  for (const input of command.lines) {
    if (!originalLines.some(row => row.purchaseLineId === input.purchaseLineId)) throw new Error(`ORDERQ_PURCHASE_REVERSE_LINE_UNKNOWN:${input.purchaseLineId}`);
  }
  const plan = [];
  let allRemaining = 0;
  for (const line of originalLines) {
    const prior = allLines.filter(row => {
      if (row.reversalOf !== line.purchaseLineId || text(row.status).toUpperCase() !== PURCHASE_STATUS.REVERSED) return false;
      if (!(finite(row.quantity) < 0) || !(finite(row.baseQuantity) < 0) || finite(row.amountWon) > 0) return false;
      const reversalDocument = documentById.get(row.purchaseDocumentId);
      if (!reversalDocument
        || text(reversalDocument.status).toUpperCase() !== PURCHASE_STATUS.REVERSED
        || reversalDocument.reversalOf !== originalDocument.purchaseDocumentId) return false;
      const movement = movementById.get(row.movementId);
      return Boolean(movement)
        && movement.sourceDocumentType === 'PURCHASE_REVERSAL'
        && movement.sourceDocumentId === row.purchaseDocumentId
        && movement.sourceLineId === row.purchaseLineId
        && movement.reversalOf === line.movementId
        && finite(movement.signedBaseQuantity) < 0;
    });
    const reversedQuantity = prior.reduce((sum, row) => sum + Math.abs(finite(row.quantity)), 0);
    const reversedBaseQuantity = prior.reduce((sum, row) => sum + Math.abs(finite(row.baseQuantity)), 0);
    const reversedAmountWon = prior.reduce((sum, row) => sum + Math.abs(finite(row.amountWon)), 0);
    const remaining = finite(line.quantity) - reversedQuantity;
    allRemaining += Math.max(0, remaining);
    const input = inputByLine.get(line.purchaseLineId);
    if (command.lines.length && !input) continue;
    const quantity = input ? finite(input.quantity) : remaining;
    if (!(quantity > 0)) {
      if (input) throw new Error(`ORDERQ_PURCHASE_REVERSE_QUANTITY_INVALID:${line.purchaseLineId}`);
      continue;
    }
    if (quantity > remaining + 1e-9) throw new Error(`ORDERQ_PURCHASE_REVERSE_EXCEEDS_ORIGINAL:${line.purchaseLineId}`);
    const baseQuantity = allocatePurchaseReversalDimension({
      originalQuantity: line.quantity,
      reversedQuantity,
      reversalQuantity: quantity,
      originalDimension: line.baseQuantity,
      reversedDimension: reversedBaseQuantity
    });
    const amounts = allocatePurchaseReversalAmount({
      originalQuantity: line.quantity,
      reversedQuantity,
      reversalQuantity: quantity,
      originalAmountWon: line.amountWon,
      reversedAmountWon
    });
    plan.push({ line, quantity, baseQuantity, amountWon: amounts.amountWon });
  }
  if (!plan.length) throw new Error('ORDERQ_PURCHASE_REVERSE_NOTHING_REMAINING');
  return { plan, full: Math.abs(plan.reduce((sum, row) => sum + row.quantity, 0) - allRemaining) <= 1e-9 };
}

export async function reversePurchase(source = {}, actor = 'ADMIN', options = {}) {
  const context = requireCapability(actor, CAPABILITY.PURCHASE_CONFIRM);
  const command = normalizePurchaseReversalCommand(source);
  const fingerprint = purchaseReversalFingerprint(command);
  const db = await openOrderQDb();
  const tx = db.transaction(PURCHASE_TRANSACTION_STORES, 'readwrite');
  try {
    const documentStore = tx.objectStore(STORE.PURCHASE_DOCUMENTS);
    const existing = await requestToPromise(documentStore.index('byIdempotencyKey').get(command.idempotencyKey));
    if (existing) {
      if (existing.reversalOf !== command.purchaseDocumentId || existing.reversalRequestFingerprint !== fingerprint) {
        throw new Error(`ORDERQ_PURCHASE_REVERSE_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
      }
      const movements = await allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'bySourceDocument', ['PURCHASE_REVERSAL', existing.purchaseDocumentId]);
      const lines = await allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', existing.purchaseDocumentId);
      await transactionDone(tx);
      return { duplicate: true, document: existing, lines, movements };
    }
    const original = await requestToPromise(documentStore.get(command.purchaseDocumentId));
    if (!original || text(original.status).toUpperCase() !== PURCHASE_STATUS.CONFIRMED) throw new Error('ORDERQ_PURCHASE_REVERSE_CONFIRMED_REQUIRED');
    if (Number(original.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_PURCHASE_REVISION_CONFLICT:${original.revision}`);
    if (![ERP_POSTING_STATUS.READY, ERP_POSTING_STATUS.NOT_READY].includes(original.erpPostingStatus)) {
      throw new Error('ORDERQ_PURCHASE_REVERSE_ERP_CORRECTION_REQUIRES_M8');
    }
    const [originalLines, allLines, allDocuments, allMovements] = await Promise.all([
      allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', command.purchaseDocumentId),
      allFrom(tx, STORE.PURCHASE_LINES),
      allFrom(tx, STORE.PURCHASE_DOCUMENTS),
      allFrom(tx, STORE.INVENTORY_MOVEMENTS)
    ]);
    const reversal = buildPurchaseReversalPlan(command, original, originalLines, allLines, allDocuments, allMovements);
    const timestamp = nowIso();
    const reversalDocumentId = newId('PD-REV');
    const reversalLines = reversal.plan.map(row => ({
      ...row.line,
      purchaseLineId: newId('PL-REV'),
      purchaseDocumentId: reversalDocumentId,
      quantity: -row.quantity,
      baseQuantity: -row.baseQuantity,
      amountWon: -row.amountWon,
      status: PURCHASE_STATUS.REVERSED,
      reversalOf: row.line.purchaseLineId,
      movementId: '',
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId
    }));
    const reversalDocument = {
      ...original,
      purchaseDocumentId: reversalDocumentId,
      originSystem: 'ORDER_Q',
      originTransactionId: reversalDocumentId,
      externalDocumentNo: '',
      importBatchId: '',
      sourceFingerprint: '',
      status: PURCHASE_STATUS.REVERSED,
      reversalOf: original.purchaseDocumentId,
      idempotencyKey: command.idempotencyKey,
      reversalRequestFingerprint: fingerprint,
      erpPostingStatus: ERP_POSTING_STATUS.READY,
      erpDocumentNo: '',
      erpReconciliationId: '',
      externalReconciliationStatus: '',
      amountWon: reversalLines.reduce((sum, row) => sum + finite(row.amountWon), 0),
      revision: 1,
      baseRevision: 0,
      reason: command.reason,
      confirmedAt: timestamp,
      confirmedBy: context.actorId,
      reversedAt: timestamp,
      reversedBy: context.actorId,
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [historyEvent('PURCHASE_REVERSED', context.actorId, {
        sourcePurchaseDocumentId: original.purchaseDocumentId,
        full: reversal.full,
        reason: command.reason
      }, timestamp)]
    };
    documentStore.add(reversalDocument);
    reversalLines.forEach(line => tx.objectStore(STORE.PURCHASE_LINES).add(line));
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.DOCUMENT_WRITTEN);

    const movementResults = await appendInventoryMovementsInTransaction({
      tx,
      actor: context,
      drafts: reversal.plan.map((row, index) => ({
        productId: row.line.productId,
        productCode: row.line.productCode,
        warehouseId: row.line.warehouseId,
        signedBaseQuantity: -row.baseQuantity,
        baseUnit: row.line.baseUnit || row.line.unit,
        movementType: INVENTORY_MOVEMENT_TYPE.REVERSAL,
        sourceDocumentType: 'PURCHASE_REVERSAL',
        sourceDocumentId: reversalDocumentId,
        sourceLineId: reversalLines[index].purchaseLineId,
        occurredAt: timestamp,
        reason: command.reason,
        reversalOf: row.line.movementId,
        idempotencyKey: `${command.idempotencyKey}:${row.line.movementId}`
      }))
    });
    if (movementResults.some(row => row.duplicate)) throw new Error('ORDERQ_PURCHASE_REVERSE_PARTIAL_MOVEMENT_STATE');
    movementResults.forEach((result, index) => {
      reversalLines[index].movementId = result.movement.movementId;
      tx.objectStore(STORE.PURCHASE_LINES).put(reversalLines[index]);
    });
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.MOVEMENTS_WRITTEN);

    const enqueue = entry => queueLocalEntity(tx, { ...entry, idempotencyKey: command.idempotencyKey });
    enqueue({ entityType: 'PURCHASE_DOCUMENT', entityId: reversalDocumentId, payload: reversalDocument });
    reversalLines.forEach(line => enqueue({ entityType: 'PURCHASE_LINE', entityId: line.purchaseLineId, payload: line }));
    movementResults.forEach(result => enqueue({ entityType: 'INVENTORY_MOVEMENT', entityId: result.movement.movementId, payload: result.movement }));
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.OUTBOX_WRITTEN);
    purchaseCheckpoint(options, PURCHASE_CONFIRMATION_STEP.BEFORE_COMMIT);
    await transactionDone(tx);
    return { duplicate: false, document: reversalDocument, lines: reversalLines, movements: movementResults.map(row => row.movement) };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function reconcilePurchaseExternal(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.PURCHASE_CONFIRM);
  const idempotencyKey = text(source.idempotencyKey);
  if (!idempotencyKey) throw new Error('ORDERQ_PURCHASE_RECONCILIATION_IDEMPOTENCY_REQUIRED');
  const identity = normalizeExternalIdentity(source);
  if (!identity.originSystem || (!identity.originTransactionId && !identity.externalDocumentNo)) {
    throw new Error('ORDERQ_PURCHASE_RECONCILIATION_EXTERNAL_ID_REQUIRED');
  }
  const requestFingerprint = purchaseExternalReconciliationFingerprint(source);
  const reconciliationId = stablePurchaseId('PRC', idempotencyKey);
  const db = await openOrderQDb();
  const tx = db.transaction(PURCHASE_TRANSACTION_STORES, 'readwrite');
  try {
    const reconciliationStore = tx.objectStore(STORE.DISPATCH_RECONCILIATIONS);
    const existing = await requestToPromise(reconciliationStore.get(reconciliationId));
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new Error(`ORDERQ_PURCHASE_RECONCILIATION_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
      await transactionDone(tx);
      return { duplicate: true, reconciliation: existing, matched: existing.status === 'MATCHED' };
    }
    const documentStore = tx.objectStore(STORE.PURCHASE_DOCUMENTS);
    let candidates = [];
    if (identity.originTransactionId) {
      candidates = await requestToPromise(documentStore.index('byOriginTransaction').getAll([identity.originSystem, identity.originTransactionId]));
    }
    if (!candidates.length && identity.externalDocumentNo) {
      candidates = await requestToPromise(documentStore.index('byExternalDocumentNo').getAll([identity.originSystem, identity.externalDocumentNo]));
    }
    candidates = candidates.filter(row => text(row.status).toUpperCase() === PURCHASE_STATUS.CONFIRMED);
    const candidate = candidates.length === 1 ? candidates[0] : null;
    const storedLines = candidate ? await allFrom(tx, STORE.PURCHASE_LINES, 'byDocumentId', candidate.purchaseDocumentId) : [];
    const exact = Boolean(candidate) && exactPurchaseExternalMatch(storedLines, source.lines || []);
    const timestamp = nowIso();
    const reconciliation = {
      reconciliationId,
      entityType: 'PURCHASE_DOCUMENT',
      purchaseDocumentId: candidate?.purchaseDocumentId || '',
      sourcePurchaseDocumentId: candidate?.purchaseDocumentId || '',
      issueType: exact ? 'ERP_PURCHASE_EXACT_MATCH' : 'ERP_PURCHASE_REVIEW_REQUIRED',
      status: exact ? 'MATCHED' : 'REVIEW_REQUIRED',
      idempotencyKey,
      requestFingerprint,
      originSystem: identity.originSystem,
      originTransactionId: identity.originTransactionId,
      externalDocumentNo: identity.externalDocumentNo,
      importBatchId: identity.importBatchId,
      sourceFingerprint: identity.sourceFingerprint,
      candidatePurchaseDocumentIds: candidates.map(row => row.purchaseDocumentId),
      details: { exactBusinessValues: exact, lineCount: (source.lines || []).length },
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      localOnly: true
    };
    reconciliationStore.add(reconciliation);
    let document = candidate;
    let lines = storedLines;
    if (exact) {
      const externalById = new Map((source.lines || []).map(row => [text(row.purchaseLineId || row.originPurchaseLineId), row]));
      lines = storedLines.map(line => {
        const external = externalById.get(line.purchaseLineId) || {};
        const next = {
          ...line,
          externalLineNo: text(external.externalLineNo),
          sourceLineFingerprint: text(external.sourceLineFingerprint),
          externalReconciliationId: reconciliationId,
          updatedAt: timestamp,
          updatedBy: context.actorId
        };
        tx.objectStore(STORE.PURCHASE_LINES).put(next);
        return next;
      });
      document = {
        ...candidate,
        externalDocumentNo: identity.externalDocumentNo,
        importBatchId: identity.importBatchId,
        sourceFingerprint: identity.sourceFingerprint,
        erpDocumentNo: identity.externalDocumentNo,
        erpReconciliationId: reconciliationId,
        erpReconciledAt: timestamp,
        erpReconciledBy: context.actorId,
        externalReconciliationStatus: 'MATCHED',
        revision: Number(candidate.revision || 0) + 1,
        baseRevision: Number(candidate.revision || 0),
        updatedAt: timestamp,
        updatedBy: context.actorId,
        history: [...(Array.isArray(candidate.history) ? candidate.history : []), historyEvent('ERP_PURCHASE_EXACT_MATCHED', context.actorId, {
          reconciliationId,
          externalDocumentNo: identity.externalDocumentNo
        }, timestamp)]
      };
      documentStore.put(document);
      queueLocalEntity(tx, { entityType: 'PURCHASE_DOCUMENT', entityId: document.purchaseDocumentId, payload: document, revision: document.revision, baseRevision: candidate.revision, idempotencyKey });
      lines.forEach(line => queueLocalEntity(tx, { entityType: 'PURCHASE_LINE', entityId: line.purchaseLineId, payload: line, revision: document.revision, baseRevision: candidate.revision, idempotencyKey }));
    }
    queueLocalEntity(tx, { entityType: 'DISPATCH_RECONCILIATION', entityId: reconciliationId, payload: reconciliation, idempotencyKey });
    await transactionDone(tx);
    return { duplicate: false, matched: exact, reconciliation, document, lines };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}
