export const INVENTORY_MOVEMENT_TYPE = Object.freeze({
  PURCHASE_RECEIPT: 'PURCHASE_RECEIPT',
  SALE_ISSUE: 'SALE_ISSUE',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  ADJUSTMENT: 'ADJUSTMENT',
  REVERSAL: 'REVERSAL'
});

export const INVENTORY_LEDGER_SEQUENCE_META_KEY = 'inventoryLedgerSequence';

const MOVEMENT_TYPES = Object.freeze(Object.values(INVENTORY_MOVEMENT_TYPE));

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function finiteNumber(value, errorCode) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(errorCode);
  return number;
}

function nonNegativeSequence(value, errorCode) {
  const number = finiteNumber(value ?? 0, errorCode);
  if (!Number.isInteger(number) || number < 0) throw new Error(errorCode);
  return number;
}

function active(row) {
  return Boolean(row) && row.active !== false && !row.disabledAt && !row.rolledBackAt && row.status !== 'ROLLED_BACK';
}

function productIdentity(row = {}) {
  const productId = text(row.productId);
  const productCode = text(row.productCode);
  const productKey = productId || (productCode ? `CODE:${productCode}` : '');
  return { productId, productCode, productKey };
}

function warehouseIdentity(row = {}) {
  return text(row.warehouseId) || (text(row.warehouseCode) ? `CODE:${text(row.warehouseCode)}` : '');
}

function inventoryKey(productKey, warehouseId) {
  return `${productKey}\u001f${warehouseId}`;
}

function compareSnapshot(left, right) {
  const date = text(right.basisDate).localeCompare(text(left.basisDate));
  if (date) return date;
  const updated = text(right.updatedAt || right.createdAt).localeCompare(text(left.updatedAt || left.createdAt));
  if (updated) return updated;
  return text(right.inventorySnapshotId).localeCompare(text(left.inventorySnapshotId));
}

export function buildMovementIdempotencyKey(source = {}) {
  const sourceDocumentType = text(source.sourceDocumentType).toUpperCase();
  const sourceDocumentId = text(source.sourceDocumentId);
  const sourceLineId = text(source.sourceLineId);
  const movementType = text(source.movementType).toUpperCase();
  const reversalOf = text(source.reversalOf);
  if (!sourceDocumentType || !sourceDocumentId || !movementType) {
    throw new Error('ORDERQ_MOVEMENT_IDEMPOTENCY_SOURCE_REQUIRED');
  }
  return [sourceDocumentType, sourceDocumentId, sourceLineId, movementType, reversalOf].join(':');
}

export function normalizeInventoryMovementDraft(source = {}) {
  const movementType = text(source.movementType).toUpperCase();
  if (!MOVEMENT_TYPES.includes(movementType)) throw new Error(`ORDERQ_MOVEMENT_TYPE_INVALID:${movementType}`);
  const productId = text(source.productId);
  const warehouseId = text(source.warehouseId);
  if (!productId) throw new Error('ORDERQ_MOVEMENT_PRODUCT_REQUIRED');
  if (!warehouseId) throw new Error('ORDERQ_MOVEMENT_WAREHOUSE_REQUIRED');
  const signedBaseQuantity = finiteNumber(source.signedBaseQuantity, 'ORDERQ_MOVEMENT_QUANTITY_INVALID');
  if (movementType === INVENTORY_MOVEMENT_TYPE.PURCHASE_RECEIPT && signedBaseQuantity < 0) {
    throw new Error('ORDERQ_PURCHASE_MOVEMENT_MUST_BE_POSITIVE');
  }
  if ([INVENTORY_MOVEMENT_TYPE.SALE_ISSUE, INVENTORY_MOVEMENT_TYPE.TRANSFER_OUT].includes(movementType) && signedBaseQuantity > 0) {
    throw new Error(`ORDERQ_OUTBOUND_MOVEMENT_MUST_BE_NEGATIVE:${movementType}`);
  }
  if (movementType === INVENTORY_MOVEMENT_TYPE.TRANSFER_IN && signedBaseQuantity < 0) {
    throw new Error('ORDERQ_TRANSFER_IN_MOVEMENT_MUST_BE_POSITIVE');
  }
  const reversalOf = text(source.reversalOf);
  if (movementType === INVENTORY_MOVEMENT_TYPE.REVERSAL && !reversalOf) {
    throw new Error('ORDERQ_MOVEMENT_REVERSAL_SOURCE_REQUIRED');
  }
  if (movementType !== INVENTORY_MOVEMENT_TYPE.REVERSAL && reversalOf) {
    throw new Error('ORDERQ_MOVEMENT_REVERSAL_TYPE_REQUIRED');
  }
  const normalized = {
    movementId: text(source.movementId),
    productId,
    productCode: text(source.productCode),
    warehouseId,
    signedBaseQuantity,
    baseUnit: source.baseUnit === undefined || source.baseUnit === null ? '' : String(source.baseUnit),
    movementType,
    sourceDocumentType: text(source.sourceDocumentType).toUpperCase(),
    sourceDocumentId: text(source.sourceDocumentId),
    sourceLineId: text(source.sourceLineId),
    dispatchId: text(source.dispatchId),
    dispatchLineId: text(source.dispatchLineId),
    transferId: text(source.transferId),
    occurredAt: text(source.occurredAt),
    reason: source.reason === undefined || source.reason === null ? '' : String(source.reason),
    reversalOf
  };
  normalized.idempotencyKey = text(source.idempotencyKey) || buildMovementIdempotencyKey(normalized);
  return normalized;
}

export function movementBusinessContent(source = {}) {
  const movement = normalizeInventoryMovementDraft(source);
  return {
    productId: movement.productId,
    productCode: movement.productCode,
    warehouseId: movement.warehouseId,
    signedBaseQuantity: movement.signedBaseQuantity,
    baseUnit: movement.baseUnit,
    movementType: movement.movementType,
    sourceDocumentType: movement.sourceDocumentType,
    sourceDocumentId: movement.sourceDocumentId,
    sourceLineId: movement.sourceLineId,
    dispatchId: movement.dispatchId,
    dispatchLineId: movement.dispatchLineId,
    transferId: movement.transferId,
    occurredAt: movement.occurredAt,
    reason: movement.reason,
    reversalOf: movement.reversalOf,
    idempotencyKey: movement.idempotencyKey
  };
}

export function sameMovementBusinessContent(left, right) {
  const leftContent = movementBusinessContent(left);
  const rightContent = movementBusinessContent(right);
  if (!leftContent.occurredAt || !rightContent.occurredAt) {
    delete leftContent.occurredAt;
    delete rightContent.occurredAt;
  }
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

export function validateInventoryTransferDrafts(rows = []) {
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error('ORDERQ_TRANSFER_REQUIRES_TWO_MOVEMENTS');
  const normalized = rows.map(normalizeInventoryMovementDraft);
  const outgoing = normalized.find(row => row.movementType === INVENTORY_MOVEMENT_TYPE.TRANSFER_OUT);
  const incoming = normalized.find(row => row.movementType === INVENTORY_MOVEMENT_TYPE.TRANSFER_IN);
  if (!outgoing || !incoming) throw new Error('ORDERQ_TRANSFER_DIRECTION_PAIR_REQUIRED');
  if (!outgoing.transferId || outgoing.transferId !== incoming.transferId) throw new Error('ORDERQ_TRANSFER_ID_MISMATCH');
  if (outgoing.productId !== incoming.productId) throw new Error('ORDERQ_TRANSFER_PRODUCT_MISMATCH');
  if (outgoing.warehouseId === incoming.warehouseId) throw new Error('ORDERQ_TRANSFER_WAREHOUSE_MUST_DIFFER');
  if (outgoing.signedBaseQuantity + incoming.signedBaseQuantity !== 0) throw new Error('ORDERQ_TRANSFER_QUANTITY_MUST_NET_ZERO');
  return normalized;
}

export function validateInventoryReversal(original, reversal) {
  if (!original) throw new Error('ORDERQ_REVERSAL_ORIGINAL_NOT_FOUND');
  const normalized = normalizeInventoryMovementDraft(reversal);
  if (normalized.movementType !== INVENTORY_MOVEMENT_TYPE.REVERSAL) throw new Error('ORDERQ_REVERSAL_TYPE_REQUIRED');
  if (normalized.reversalOf !== text(original.movementId)) throw new Error('ORDERQ_REVERSAL_SOURCE_MISMATCH');
  if (normalized.productId !== text(original.productId) || normalized.warehouseId !== text(original.warehouseId)) {
    throw new Error('ORDERQ_REVERSAL_INVENTORY_KEY_MISMATCH');
  }
  const originalQuantity = Number(original.signedBaseQuantity);
  const reversalQuantity = Number(normalized.signedBaseQuantity);
  if (!originalQuantity || !reversalQuantity || Math.sign(reversalQuantity) === Math.sign(originalQuantity)) {
    throw new Error('ORDERQ_REVERSAL_QUANTITY_MUST_BE_OPPOSITE');
  }
  if (Math.abs(reversalQuantity) > Math.abs(originalQuantity) + 1e-9) {
    throw new Error('ORDERQ_REVERSAL_QUANTITY_EXCEEDS_ORIGINAL');
  }
  return normalized;
}

export function selectInventorySnapshotBasis(snapshots = []) {
  const activeSnapshots = snapshots.filter(active).sort(compareSnapshot);
  if (!activeSnapshots.length) return { snapshots: [], snapshotIds: new Set(), batchId: '', basisDate: '', snapshotLastSequence: 0 };
  const latest = activeSnapshots[0];
  const batchId = text(latest.importBatchId);
  const basisDate = text(latest.basisDate);
  const selected = activeSnapshots.filter(row => batchId ? text(row.importBatchId) === batchId : text(row.basisDate) === basisDate);
  const watermarks = selected.map(row => nonNegativeSequence(row.snapshotLastSequence ?? 0, 'ORDERQ_SNAPSHOT_WATERMARK_INVALID'));
  return {
    snapshots: selected,
    snapshotIds: new Set(selected.map(row => text(row.inventorySnapshotId))),
    batchId,
    basisDate,
    snapshotLastSequence: watermarks.length ? Math.max(...watermarks) : 0
  };
}

export function calculateInventoryShadowProjection({
  snapshots = [],
  inventoryLines = [],
  movements = [],
  reservations = [],
  warehouses = []
} = {}) {
  const basis = selectInventorySnapshotBasis(snapshots);
  const snapshotById = new Map(basis.snapshots.map(row => [text(row.inventorySnapshotId), row]));
  const warehouseById = new Map(warehouses.map(row => [text(row.warehouseId), row]));
  const rows = new Map();

  const ensureRow = ({ productId = '', productCode = '', productKey, warehouseId }) => {
    const key = inventoryKey(productKey, warehouseId);
    if (!rows.has(key)) {
      const warehouse = warehouseById.get(warehouseId) || {};
      rows.set(key, {
        key,
        productId,
        productCode,
        productKey,
        warehouseId,
        warehouseCode: text(warehouse.warehouseCode),
        warehouseName: text(warehouse.warehouseName || warehouse.warehouse),
        countsInOnHand: warehouse.countsInOnHand !== false,
        countsInAvailable: warehouse.countsInAvailable !== false,
        snapshotQuantity: 0,
        snapshotLastSequence: basis.snapshotLastSequence,
        movementQuantity: 0,
        reservedQuantity: 0,
        reservationEvidence: [],
        movementEvidence: [],
        snapshotEvidence: []
      });
    }
    return rows.get(key);
  };

  for (const line of inventoryLines.filter(active)) {
    const snapshot = snapshotById.get(text(line.inventorySnapshotId));
    if (!snapshot) continue;
    const product = productIdentity(line);
    const warehouseId = warehouseIdentity(line) || warehouseIdentity(snapshot);
    if (!product.productKey || !warehouseId) continue;
    const row = ensureRow({ ...product, warehouseId });
    const quantity = finiteNumber(line.inventoryQuantity ?? 0, 'ORDERQ_SNAPSHOT_QUANTITY_INVALID');
    row.snapshotQuantity += quantity;
    row.snapshotLastSequence = nonNegativeSequence(snapshot.snapshotLastSequence ?? basis.snapshotLastSequence, 'ORDERQ_SNAPSHOT_WATERMARK_INVALID');
    row.snapshotEvidence.push({
      inventorySnapshotId: text(snapshot.inventorySnapshotId),
      inventoryLineId: text(line.inventoryLineId),
      quantity,
      snapshotLastSequence: row.snapshotLastSequence
    });
  }

  const orderedMovements = movements.filter(active).map(row => ({
    ...row,
    ledgerSequence: nonNegativeSequence(row.ledgerSequence, 'ORDERQ_MOVEMENT_SEQUENCE_INVALID'),
    signedBaseQuantity: finiteNumber(row.signedBaseQuantity, 'ORDERQ_MOVEMENT_QUANTITY_INVALID')
  })).sort((left, right) => left.ledgerSequence - right.ledgerSequence);
  const backdatedMovementIds = [];
  for (const movement of orderedMovements) {
    const product = productIdentity(movement);
    const warehouseId = warehouseIdentity(movement);
    if (!product.productKey || !warehouseId) continue;
    const row = ensureRow({ ...product, warehouseId });
    if (movement.ledgerSequence <= row.snapshotLastSequence) continue;
    row.movementQuantity += movement.signedBaseQuantity;
    const backdated = Boolean(text(movement.occurredAt) && text(movement.postedAt) && text(movement.occurredAt) < text(movement.postedAt));
    if (backdated) backdatedMovementIds.push(text(movement.movementId));
    row.movementEvidence.push({
      movementId: text(movement.movementId),
      ledgerSequence: movement.ledgerSequence,
      movementType: text(movement.movementType),
      signedBaseQuantity: movement.signedBaseQuantity,
      sourceDocumentType: text(movement.sourceDocumentType),
      sourceDocumentId: text(movement.sourceDocumentId),
      sourceLineId: text(movement.sourceLineId),
      reversalOf: text(movement.reversalOf),
      occurredAt: text(movement.occurredAt),
      postedAt: text(movement.postedAt),
      backdated
    });
  }

  for (const reservation of reservations.filter(active)) {
    if (text(reservation.status).toUpperCase() !== 'ACTIVE') continue;
    const product = productIdentity(reservation);
    const warehouseId = warehouseIdentity(reservation);
    if (!product.productKey || !warehouseId) continue;
    const row = ensureRow({ ...product, warehouseId });
    const reservedBaseQuantity = finiteNumber(reservation.reservedBaseQuantity ?? 0, 'ORDERQ_RESERVATION_QUANTITY_INVALID');
    row.reservedQuantity += reservedBaseQuantity;
    row.reservationEvidence.push({
      reservationId: text(reservation.reservationId),
      allocationId: text(reservation.allocationId),
      dispatchId: text(reservation.dispatchId),
      dispatchLineId: text(reservation.dispatchLineId),
      reservedBaseQuantity
    });
  }

  const projectedRows = [...rows.values()].map(row => {
    const onHandQuantity = row.snapshotQuantity + row.movementQuantity;
    const availableQuantity = row.countsInAvailable ? onHandQuantity - row.reservedQuantity : 0;
    return {
      ...row,
      onHandQuantity,
      availableQuantity,
      differenceQuantity: row.movementQuantity,
      negativeOnHand: onHandQuantity < 0,
      negativeAvailable: availableQuantity < 0
    };
  }).sort((left, right) => (
    left.productKey.localeCompare(right.productKey, 'ko', { numeric: true })
    || left.warehouseId.localeCompare(right.warehouseId, 'ko', { numeric: true })
  ));
  const warnings = projectedRows.filter(row => row.negativeOnHand || row.negativeAvailable).map(row => ({
    warningType: row.negativeOnHand ? 'NEGATIVE_ON_HAND' : 'NEGATIVE_AVAILABLE',
    productId: row.productId,
    productCode: row.productCode,
    warehouseId: row.warehouseId,
    onHandQuantity: row.onHandQuantity,
    availableQuantity: row.availableQuantity,
    movementEvidence: row.movementEvidence
  }));
  const totalOnHandQuantity = projectedRows.reduce((sum, row) => sum + (row.countsInOnHand ? row.onHandQuantity : 0), 0);
  const totalAvailableQuantity = projectedRows.reduce((sum, row) => sum + (row.countsInAvailable ? row.availableQuantity : 0), 0);
  return {
    basis: {
      importBatchId: basis.batchId,
      basisDate: basis.basisDate,
      snapshotLastSequence: basis.snapshotLastSequence,
      inventorySnapshotIds: [...basis.snapshotIds]
    },
    rows: projectedRows,
    warnings,
    totals: {
      snapshotQuantity: projectedRows.reduce((sum, row) => sum + (row.countsInOnHand ? row.snapshotQuantity : 0), 0),
      movementQuantity: projectedRows.reduce((sum, row) => sum + (row.countsInOnHand ? row.movementQuantity : 0), 0),
      onHandQuantity: totalOnHandQuantity,
      availableQuantity: totalAvailableQuantity,
      negativeOnHandCount: projectedRows.filter(row => row.negativeOnHand).length,
      negativeAvailableCount: projectedRows.filter(row => row.negativeAvailable).length
    },
    backdatedMovementIds: [...new Set(backdatedMovementIds)]
  };
}
