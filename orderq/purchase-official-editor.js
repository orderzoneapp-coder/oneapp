import { canonicalSha256 } from './official-voucher-core.js?v=0.18.0';

const text = value => String(value ?? '').trim();
function finite(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function won(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }

export function normalizeOfficialPurchaseEditLines(lines = []) {
  if (!lines.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  return lines.map((source, index) => {
    const actualQuantity = finite(source.actualQuantity, 'ORDERQ_PURCHASE_QUANTITY_REQUIRED');
    const unitPrice = finite(source.unitPrice, 'ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED');
    const conversionFactor = finite(source.conversionFactor, 'ORDERQ_PURCHASE_CONVERSION_REQUIRED');
    if (!(conversionFactor > 0)) throw new Error('ORDERQ_PURCHASE_CONVERSION_REQUIRED');
    const baseQuantity = actualQuantity * conversionFactor;
    const supplyAmount = won(actualQuantity * unitPrice);
    return { ...source, lineSequence: Number(source.lineSequence || index + 1), actualQuantity,
      conversionFactor, baseQuantity, unitPrice, supplyAmount, totalAmount: supplyAmount };
  });
}

export function buildOfficialPurchaseEditCommand({ action, document, lines, reason, occurredAt, actor = 'SMART_INPUT_ADMIN' } = {}) {
  const reverse = action === 'reverse';
  const commandType = reverse ? 'REVERSE_PURCHASE' : 'CORRECT_PURCHASE';
  const normalizedLines = normalizeOfficialPurchaseEditLines(lines);
  const revision = Number(document?.revision || 0);
  const editReason = text(reason);
  if (!editReason) throw new Error('ORDERQ_PURCHASE_CORRECTION_REASON_REQUIRED');
  const commandId = `${commandType}:${text(document?.purchaseDocumentId)}:${revision + 1}:${canonicalSha256({ document, lines: normalizedLines, reason: editReason })}`;
  return { commandType, commandId, idempotencyKey: commandId, aggregateId: text(document?.purchaseDocumentId),
    purchaseDocumentId: text(document?.purchaseDocumentId), expectedRevision: revision, actor, reason: editReason,
    occurredAt: text(occurredAt || new Date().toISOString()), sourceType: text(document?.sourceType),
    commandContract: 'VOUCHER_CORE_V1', document: { ...document }, lines: normalizedLines };
}

export function mergeOfficialPurchaseConflictEdits(edited = {}, fresh = {}) {
  const freshLines = new Map((fresh.activeLines || []).map(line => [text(line.lineIdentityId || line.sourceLineKey), line]));
  return { ...fresh, document: { ...fresh.document,
    supplierCustomerId: edited.document?.supplierCustomerId ?? fresh.document?.supplierCustomerId,
    supplierCustomerCode: edited.document?.supplierCustomerCode ?? fresh.document?.supplierCustomerCode,
    supplierCustomerName: edited.document?.supplierCustomerName ?? fresh.document?.supplierCustomerName,
    purchaseDate: edited.document?.purchaseDate ?? fresh.document?.purchaseDate,
    correctionReason: edited.document?.correctionReason ?? '' },
    activeLines: (edited.lines || []).map(line => ({ ...(freshLines.get(text(line.lineIdentityId || line.sourceLineKey)) || {}), ...line })) };
}

export function officialPurchaseEvidence(aggregate = {}) {
  return {
    lines: (aggregate.activeLines || []).map(line => ({ lineIdentityId: line.lineIdentityId,
      suggestedQuantity: line.suggestedQuantity ?? null, actualQuantity: line.actualQuantity,
      baseQuantity: line.baseQuantity, baseUnit: line.baseUnit })),
    movements: (aggregate.movements || []).map(row => ({ movementId: row.movementId, movementType: row.movementType, quantity: row.quantity, reversalOf: row.reversalOf })),
    payableEntries: (aggregate.payableEntries || []).map(row => ({ entryId: row.entryId, entryType: row.entryType, amount: row.amount, reversalOf: row.reversalOf })),
    voucherEvents: (aggregate.voucherEvents || []).map(row => ({ eventId: row.eventId, eventType: row.eventType, revision: row.revision })),
    command: { commandId: aggregate.document?.commandId, centralTransactionId: aggregate.document?.centralTransactionId,
      resultDigest: aggregate.document?.resultDigest, projectionStatus: aggregate.document?.projectionStatus }
  };
}
