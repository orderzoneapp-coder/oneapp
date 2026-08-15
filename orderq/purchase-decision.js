import { normalizeExternalIdentity } from './orderq-v7-contracts.js?v=0.8.0';
import { quantityFromUnits, quantityUnits } from './dispatch-workbench.js?v=0.8.0';

export const PURCHASE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  CONFIRMED: 'CONFIRMED',
  REVERSED: 'REVERSED',
  CANCELED: 'CANCELED'
});

export const PURCHASE_CONFIRMATION_STEP = Object.freeze({
  DOCUMENT_WRITTEN: 'DOCUMENT_WRITTEN',
  MOVEMENTS_WRITTEN: 'MOVEMENTS_WRITTEN',
  OUTBOX_WRITTEN: 'OUTBOX_WRITTEN',
  BEFORE_COMMIT: 'BEFORE_COMMIT'
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('ORDERQ_PURCHASE_NUMBER_INVALID');
  return number;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

export function normalizePurchaseLineDraft(source = {}) {
  const quantity = quantityFromUnits(quantityUnits(source.quantity ?? source.plannedQuantity ?? 0));
  const baseQuantity = quantityFromUnits(quantityUnits(source.baseQuantity ?? quantity));
  if (quantity < 0 || baseQuantity < 0) throw new Error('ORDERQ_PURCHASE_DRAFT_QUANTITY_NEGATIVE');
  const unitCostWon = optionalNumber(source.unitCostWon ?? source.unitCost ?? 0);
  if (unitCostWon !== null && unitCostWon < 0) throw new Error('ORDERQ_PURCHASE_DRAFT_COST_NEGATIVE');
  const identity = normalizeExternalIdentity(source);
  return {
    ...source,
    purchaseLineId: text(source.purchaseLineId),
    purchaseDocumentId: text(source.purchaseDocumentId),
    productId: text(source.productId),
    productCode: text(source.productCode),
    productName: text(source.productName),
    warehouseId: text(source.warehouseId),
    warehouseCode: text(source.warehouseCode),
    warehouseName: text(source.warehouseName),
    quantity,
    unit: source.unit === undefined || source.unit === null ? '' : String(source.unit),
    baseQuantity,
    baseUnit: text(source.baseUnit || source.unit),
    unitCostWon: unitCostWon ?? 0,
    amountWon: Math.round(quantity * (unitCostWon ?? 0)),
    sourceOrderItemId: text(source.sourceOrderItemId),
    sourceDispatchId: text(source.sourceDispatchId),
    sourceDispatchLineId: text(source.sourceDispatchLineId),
    externalLineNo: identity.externalLineNo,
    sourceLineFingerprint: identity.sourceLineFingerprint,
    status: PURCHASE_STATUS.DRAFT
  };
}

export function normalizePurchaseDraft(source = {}) {
  const document = source.document || source;
  const lines = (Array.isArray(source.lines) ? source.lines : [])
    .map(normalizePurchaseLineDraft)
    .sort((left, right) => left.purchaseLineId.localeCompare(right.purchaseLineId));
  const expectedRevision = Number(source.expectedRevision ?? document.expectedRevision ?? 0);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('ORDERQ_PURCHASE_DRAFT_REVISION_REQUIRED');
  return {
    document: {
      ...document,
      purchaseDocumentId: text(document.purchaseDocumentId),
      sourceShortageKey: text(document.sourceShortageKey),
      sourceShortageQuantity: quantityFromUnits(quantityUnits(document.sourceShortageQuantity ?? 0)),
      supplierId: text(document.supplierId),
      supplierName: text(document.supplierName),
      businessDate: text(document.businessDate || document.purchaseDate),
      purchaseDate: text(document.purchaseDate || document.businessDate),
      actualTransactionAt: text(document.actualTransactionAt),
      backdateReason: text(document.backdateReason),
      memo: document.memo === undefined || document.memo === null ? '' : String(document.memo),
      status: PURCHASE_STATUS.DRAFT
    },
    lines,
    expectedRevision
  };
}

export function validatePurchaseReady(document = {}, lines = []) {
  if (!text(document.supplierId || document.supplierName)) throw new Error('ORDERQ_PURCHASE_SUPPLIER_REQUIRED');
  if (!text(document.businessDate || document.purchaseDate) || !text(document.actualTransactionAt || document.businessDate || document.purchaseDate)) {
    throw new Error('ORDERQ_PURCHASE_TRANSACTION_DATE_REQUIRED');
  }
  if (!Array.isArray(lines) || !lines.length) throw new Error('ORDERQ_PURCHASE_LINE_REQUIRED');
  for (const line of lines) {
    if (!text(line.productId)) throw new Error(`ORDERQ_PURCHASE_PRODUCT_REQUIRED:${line.purchaseLineId}`);
    if (!text(line.warehouseId)) throw new Error(`ORDERQ_PURCHASE_WAREHOUSE_REQUIRED:${line.purchaseLineId}`);
    if (!(quantityUnits(line.quantity) > 0) || !(quantityUnits(line.baseQuantity) > 0)) {
      throw new Error(`ORDERQ_PURCHASE_QUANTITY_REQUIRED:${line.purchaseLineId}`);
    }
    if (!Number.isFinite(Number(line.unitCostWon)) || Number(line.unitCostWon) < 0) {
      throw new Error(`ORDERQ_PURCHASE_COST_INVALID:${line.purchaseLineId}`);
    }
  }
}

export function normalizePurchaseConfirmationCommand(source = {}) {
  const purchaseDocumentId = text(source.purchaseDocumentId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  if (!purchaseDocumentId) throw new Error('ORDERQ_PURCHASE_CONFIRM_DOCUMENT_REQUIRED');
  if (!idempotencyKey) throw new Error('ORDERQ_PURCHASE_CONFIRM_IDEMPOTENCY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_PURCHASE_CONFIRM_REVISION_REQUIRED');
  return { purchaseDocumentId, idempotencyKey, expectedRevision };
}

export function purchaseConfirmationFingerprint(source = {}) {
  const command = normalizePurchaseConfirmationCommand(source);
  return JSON.stringify(stableValue({
    purchaseDocumentId: command.purchaseDocumentId,
    expectedRevision: command.expectedRevision
  }));
}

export function buildPurchaseConfirmationKey(purchaseDocumentId, revision) {
  return `PURCHASE_CONFIRM:${text(purchaseDocumentId)}:${Number(revision)}`;
}

export function normalizePurchaseReversalCommand(source = {}) {
  const purchaseDocumentId = text(source.purchaseDocumentId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  const reason = text(source.reason);
  if (!purchaseDocumentId || !idempotencyKey || !reason) throw new Error('ORDERQ_PURCHASE_REVERSE_SOURCE_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_PURCHASE_REVERSE_REVISION_REQUIRED');
  const lines = (Array.isArray(source.lines) ? source.lines : []).map(row => ({
    purchaseLineId: text(row.purchaseLineId),
    quantity: quantityFromUnits(quantityUnits(row.quantity))
  })).sort((left, right) => left.purchaseLineId.localeCompare(right.purchaseLineId));
  if (lines.some(row => !row.purchaseLineId || row.quantity <= 0)) throw new Error('ORDERQ_PURCHASE_REVERSE_LINE_INVALID');
  return { purchaseDocumentId, idempotencyKey, expectedRevision, reason, lines };
}

export function purchaseReversalFingerprint(source = {}) {
  const command = normalizePurchaseReversalCommand(source);
  return JSON.stringify(stableValue(command));
}

export function buildPurchaseReversalKey(purchaseDocumentId, revision, suffix = 'FULL') {
  return `PURCHASE_REVERSE:${text(purchaseDocumentId)}:${Number(revision)}:${text(suffix) || 'FULL'}`;
}

export function allocatePurchaseReversalDimension(source = {}) {
  const originalQuantityUnits = quantityUnits(source.originalQuantity);
  const reversedQuantityUnits = quantityUnits(source.reversedQuantity || 0);
  const reversalQuantityUnits = quantityUnits(source.reversalQuantity);
  const originalDimensionUnits = quantityUnits(source.originalDimension);
  const reversedDimensionUnits = quantityUnits(source.reversedDimension || 0);
  if (originalQuantityUnits <= 0 || reversedQuantityUnits < 0 || reversalQuantityUnits <= 0
    || reversedQuantityUnits + reversalQuantityUnits > originalQuantityUnits
    || originalDimensionUnits < 0 || reversedDimensionUnits < 0 || reversedDimensionUnits > originalDimensionUnits) {
    throw new Error('ORDERQ_PURCHASE_REVERSE_DIMENSION_INVALID');
  }
  const cumulativeQuantityUnits = reversedQuantityUnits + reversalQuantityUnits;
  const finalRemainder = cumulativeQuantityUnits === originalQuantityUnits;
  const targetUnits = finalRemainder
    ? originalDimensionUnits
    : Math.round(originalDimensionUnits * cumulativeQuantityUnits / originalQuantityUnits);
  const allocatedUnits = Math.max(0, Math.min(originalDimensionUnits - reversedDimensionUnits, targetUnits - reversedDimensionUnits));
  if (finalRemainder && reversedDimensionUnits + allocatedUnits !== originalDimensionUnits) {
    throw new Error('ORDERQ_PURCHASE_REVERSE_FINAL_DIMENSION_MISMATCH');
  }
  return quantityFromUnits(allocatedUnits);
}

export function allocatePurchaseReversalAmount(source = {}) {
  const originalQuantity = Number(source.originalQuantity);
  const reversedQuantity = Number(source.reversedQuantity || 0);
  const reversalQuantity = Number(source.reversalQuantity);
  const originalAmountWon = Math.abs(Math.round(Number(source.originalAmountWon || 0)));
  const reversedAmountWon = Math.abs(Math.round(Number(source.reversedAmountWon || 0)));
  if (!(originalQuantity > 0) || reversedQuantity < 0 || !(reversalQuantity > 0)
    || reversedQuantity + reversalQuantity > originalQuantity + 1e-9
    || reversedAmountWon > originalAmountWon) throw new Error('ORDERQ_PURCHASE_REVERSE_AMOUNT_INVALID');
  const cumulativeQuantity = reversedQuantity + reversalQuantity;
  const finalRemainder = Math.abs(cumulativeQuantity - originalQuantity) <= 1e-9;
  const amountWon = finalRemainder
    ? originalAmountWon - reversedAmountWon
    : Math.max(0, Math.min(originalAmountWon - reversedAmountWon,
      Math.round(originalAmountWon * cumulativeQuantity / originalQuantity) - reversedAmountWon));
  return { amountWon, finalRemainder };
}

export function purchaseExternalReconciliationFingerprint(source = {}) {
  const identity = normalizeExternalIdentity(source);
  const lines = (Array.isArray(source.lines) ? source.lines : []).map(row => ({
    purchaseLineId: text(row.purchaseLineId || row.originPurchaseLineId),
    externalLineNo: text(row.externalLineNo),
    sourceLineFingerprint: text(row.sourceLineFingerprint),
    productId: text(row.productId),
    warehouseId: text(row.warehouseId),
    quantity: quantityFromUnits(quantityUnits(row.quantity)),
    baseQuantity: quantityFromUnits(quantityUnits(row.baseQuantity ?? row.quantity)),
    unitCostWon: Number(row.unitCostWon ?? 0)
  })).sort((left, right) => left.purchaseLineId.localeCompare(right.purchaseLineId));
  return JSON.stringify(stableValue({ identity, lines }));
}

export function exactPurchaseExternalMatch(storedLines = [], externalLines = []) {
  if (!storedLines.length || storedLines.length !== externalLines.length) return false;
  const externalById = new Map(externalLines.map(row => [text(row.purchaseLineId || row.originPurchaseLineId), row]));
  return storedLines.every(line => {
    const external = externalById.get(text(line.purchaseLineId));
    return external
      && text(external.productId) === text(line.productId)
      && text(external.warehouseId) === text(line.warehouseId)
      && quantityUnits(external.quantity) === quantityUnits(line.quantity)
      && quantityUnits(external.baseQuantity ?? external.quantity) === quantityUnits(line.baseQuantity)
      && Number(external.unitCostWon ?? 0) === Number(line.unitCostWon ?? 0);
  });
}

export function purchaseCheckpoint(options = {}, step) {
  if (typeof options.onStep === 'function') options.onStep(step);
  if (text(options.failureAt).toUpperCase() === step) throw new Error(`ORDERQ_PURCHASE_FAILURE_INJECTED:${step}`);
}

export function stablePurchaseId(prefix, value) {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
