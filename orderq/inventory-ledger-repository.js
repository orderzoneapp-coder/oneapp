import {
  STORE,
  getAll,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { requireActor } from './orderq-v7-contracts.js?v=0.8.0';
import {
  INVENTORY_LEDGER_SEQUENCE_META_KEY,
  INVENTORY_MOVEMENT_TYPE,
  calculateInventoryShadowProjection,
  normalizeInventoryMovementDraft,
  sameMovementBusinessContent,
  validateInventoryReversal,
  validateInventoryTransferDrafts
} from './inventory-ledger.js?v=0.8.0';

async function latestStoredSequence(movementStore) {
  const cursor = await requestToPromise(movementStore.index('byLedgerSequence').openCursor(null, 'prev'));
  return validStoredSequence(cursor?.value?.ledgerSequence);
}

function validStoredSequence(value) {
  const sequence = Number(value);
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : 0;
}

export async function appendInventoryMovementsInTransaction({ tx, actor, drafts }) {
  const movementStore = tx.objectStore(STORE.INVENTORY_MOVEMENTS);
  const metaStore = tx.objectStore(STORE.META);
  const meta = await requestToPromise(metaStore.get(INVENTORY_LEDGER_SEQUENCE_META_KEY));
  let sequence = Math.max(validStoredSequence(meta?.value), await latestStoredSequence(movementStore));
  const results = [];

  for (const input of drafts) {
    const draft = normalizeInventoryMovementDraft(input);
    const existing = await requestToPromise(movementStore.index('byIdempotencyKey').get(draft.idempotencyKey));
    if (existing) {
      if (!sameMovementBusinessContent(existing, draft)) throw new Error(`ORDERQ_MOVEMENT_IDEMPOTENCY_CONFLICT:${draft.idempotencyKey}`);
      results.push({ duplicate: true, movement: existing });
      continue;
    }
    if (draft.movementType === INVENTORY_MOVEMENT_TYPE.REVERSAL) {
      const original = await requestToPromise(movementStore.get(draft.reversalOf));
      validateInventoryReversal(original, draft);
      const allRows = await requestToPromise(movementStore.getAll());
      const reversedQuantity = allRows
        .filter(row => row.movementType === INVENTORY_MOVEMENT_TYPE.REVERSAL && row.reversalOf === draft.reversalOf)
        .reduce((sum, row) => sum + Number(row.signedBaseQuantity || 0), 0);
      const targetQuantity = -Number(original.signedBaseQuantity || 0);
      const cumulativeQuantity = reversedQuantity + draft.signedBaseQuantity;
      const exceedsOriginal = targetQuantity > 0
        ? cumulativeQuantity > targetQuantity + 1e-9
        : cumulativeQuantity < targetQuantity - 1e-9;
      if (exceedsOriginal) {
        throw new Error(`ORDERQ_MOVEMENT_REVERSAL_EXCEEDS_ORIGINAL:${draft.reversalOf}`);
      }
    }
    sequence += 1;
    const timestamp = nowIso();
    const movement = {
      ...draft,
      movementId: draft.movementId || newId('IM'),
      ledgerSequence: sequence,
      occurredAt: draft.occurredAt || timestamp,
      postedAt: timestamp,
      createdAt: timestamp,
      createdBy: actor.actorId
    };
    movementStore.add(movement);
    results.push({ duplicate: false, movement });
  }

  metaStore.put({
    key: INVENTORY_LEDGER_SEQUENCE_META_KEY,
    value: sequence,
    updatedAt: nowIso(),
    updatedBy: actor.actorId
  });
  return results;
}

export async function appendInventoryMovements(drafts, actor = 'ADMIN') {
  const context = requireActor(actor);
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('ORDERQ_MOVEMENT_DRAFT_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INVENTORY_MOVEMENTS, STORE.META], 'readwrite');
  try {
    const results = await appendInventoryMovementsInTransaction({ tx, actor: context, drafts });
    await transactionDone(tx);
    return results;
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function appendInventoryMovement(draft, actor = 'ADMIN') {
  const [result] = await appendInventoryMovements([draft], actor);
  return result;
}

export async function appendInventoryTransfer({
  transferId,
  productId,
  productCode = '',
  fromWarehouseId,
  toWarehouseId,
  baseQuantity,
  baseUnit = '',
  sourceDocumentType = 'WAREHOUSE_TRANSFER',
  sourceDocumentId,
  occurredAt = '',
  reason = ''
} = {}, actor = 'ADMIN') {
  const quantity = Number(baseQuantity);
  const rows = validateInventoryTransferDrafts([
    {
      productId, productCode, warehouseId: fromWarehouseId, signedBaseQuantity: -quantity, baseUnit,
      movementType: INVENTORY_MOVEMENT_TYPE.TRANSFER_OUT, transferId, sourceDocumentType,
      sourceDocumentId: sourceDocumentId || transferId, sourceLineId: 'OUT', occurredAt, reason
    },
    {
      productId, productCode, warehouseId: toWarehouseId, signedBaseQuantity: quantity, baseUnit,
      movementType: INVENTORY_MOVEMENT_TYPE.TRANSFER_IN, transferId, sourceDocumentType,
      sourceDocumentId: sourceDocumentId || transferId, sourceLineId: 'IN', occurredAt, reason
    }
  ]);
  return appendInventoryMovements(rows, actor);
}

export async function reverseInventoryMovement(originalMovementId, source = {}, actor = 'ADMIN') {
  const originalId = String(originalMovementId ?? '').trim();
  if (!originalId) throw new Error('ORDERQ_REVERSAL_ORIGINAL_REQUIRED');
  const db = await openOrderQDb();
  const readTx = db.transaction(STORE.INVENTORY_MOVEMENTS, 'readonly');
  const original = await requestToPromise(readTx.objectStore(STORE.INVENTORY_MOVEMENTS).get(originalId));
  await transactionDone(readTx);
  if (!original) throw new Error('ORDERQ_REVERSAL_ORIGINAL_NOT_FOUND');
  return appendInventoryMovement({
    productId: original.productId,
    productCode: original.productCode || '',
    warehouseId: original.warehouseId,
    signedBaseQuantity: -Number(original.signedBaseQuantity),
    baseUnit: original.baseUnit || '',
    movementType: INVENTORY_MOVEMENT_TYPE.REVERSAL,
    sourceDocumentType: source.sourceDocumentType || 'INVENTORY_REVERSAL',
    sourceDocumentId: source.sourceDocumentId || originalId,
    sourceLineId: source.sourceLineId || original.sourceLineId || '',
    dispatchId: source.dispatchId || original.dispatchId || '',
    dispatchLineId: source.dispatchLineId || original.dispatchLineId || '',
    occurredAt: source.occurredAt || '',
    reason: source.reason || '',
    reversalOf: originalId,
    idempotencyKey: source.idempotencyKey || ''
  }, actor);
}

export async function getInventoryLedgerSequence() {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INVENTORY_MOVEMENTS, STORE.META], 'readonly');
  const [meta, storedSequence] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.META).get(INVENTORY_LEDGER_SEQUENCE_META_KEY)),
    latestStoredSequence(tx.objectStore(STORE.INVENTORY_MOVEMENTS))
  ]);
  await transactionDone(tx);
  return Math.max(validStoredSequence(meta?.value), storedSequence);
}

export async function getInventoryShadowProjection() {
  const [snapshots, inventoryLines, movements, reservations, warehouses] = await Promise.all([
    getAll(STORE.INVENTORY_SNAPSHOTS),
    getAll(STORE.INVENTORY_LINES),
    getAll(STORE.INVENTORY_MOVEMENTS),
    getAll(STORE.INVENTORY_RESERVATIONS),
    getAll(STORE.WAREHOUSES)
  ]);
  return calculateInventoryShadowProjection({ snapshots, inventoryLines, movements, reservations, warehouses });
}
