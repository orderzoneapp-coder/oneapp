import { canonicalSha256 } from './official-voucher-core.js?v=0.19.0';

const text = value => String(value ?? '').trim();
function finite(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function won(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }

export function normalizeOfficialSaleEditLines(lines = []) {
  if (!lines.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  return lines.map((source, index) => {
    const actualQuantity = finite(source.actualQuantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
    const unitPrice = finite(source.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
    const actualToBaseFactor = finite(source.actualToBaseFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const actualToRecognizedFactor = finite(source.actualToRecognizedFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    if (!(actualToBaseFactor > 0) || !(actualToRecognizedFactor > 0)) throw new Error('ORDERQ_SALE_CONVERSION_REQUIRED');
    const orderLinkMode = text(source.orderLinkMode || 'DIRECT').toUpperCase();
    const baseQuantity = actualQuantity * actualToBaseFactor;
    const recognizedOrderQuantity = orderLinkMode === 'DIRECT' ? 0 : actualQuantity * actualToRecognizedFactor;
    const supplyAmount = won(actualQuantity * unitPrice);
    return { ...source, lineSequence: Number(source.lineSequence || index + 1), actualQuantity, actualToBaseFactor,
      baseQuantity, actualToRecognizedFactor, recognizedOrderQuantity, unitPrice, supplyAmount, totalAmount: supplyAmount };
  });
}

export function buildOfficialSaleEditCommand({ action, document, lines, reason, occurredAt, actor = 'SMART_INPUT_ADMIN' } = {}) {
  const reverse = action === 'reverse';
  const commandType = reverse ? 'REVERSE_SALE' : 'CORRECT_SALE';
  const normalizedLines = normalizeOfficialSaleEditLines(lines);
  const revision = Number(document?.revision || 0);
  const editReason = text(reason);
  if (!editReason) throw new Error('ORDERQ_SALE_CORRECTION_REASON_REQUIRED');
  const commandId = `${commandType}:${text(document?.salesDocumentId)}:${revision + 1}:${canonicalSha256({ document, lines: normalizedLines, reason: editReason })}`;
  return { commandType, commandId, idempotencyKey: commandId, aggregateId: text(document?.salesDocumentId),
    salesDocumentId: text(document?.salesDocumentId), expectedRevision: revision, actor, reason: editReason,
    occurredAt: text(occurredAt || new Date().toISOString()), sourceType: text(document?.sourceType),
    contractKind: 'SALE_STAGE4_V1', commandContract: 'VOUCHER_CORE_V1', document: { ...document }, lines: normalizedLines };
}

export function mergeOfficialSaleConflictEdits(edited = {}, fresh = {}) {
  const freshLines = new Map((fresh.activeLines || []).map(line => [text(line.lineIdentityId || line.sourceLineKey), line]));
  return { ...fresh, document: { ...fresh.document,
    salesCustomerId: edited.document?.salesCustomerId ?? fresh.document?.salesCustomerId,
    deliveryCustomerId: edited.document?.deliveryCustomerId ?? fresh.document?.deliveryCustomerId,
    billingCustomerId: edited.document?.billingCustomerId ?? fresh.document?.billingCustomerId,
    saleDate: edited.document?.saleDate ?? fresh.document?.saleDate,
    correctionReason: edited.document?.correctionReason ?? '' },
    activeLines: (edited.lines || []).map(line => ({ ...(freshLines.get(text(line.lineIdentityId || line.sourceLineKey)) || {}), ...line })) };
}

export function officialSaleEvidence(aggregate = {}) {
  return {
    lines: (aggregate.activeLines || []).map(line => ({ lineIdentityId: line.lineIdentityId,
      suggestedActualQuantity: line.suggestedActualQuantity ?? null, actualQuantity: line.actualQuantity,
      baseQuantity: line.baseQuantity, recognizedOrderQuantity: line.recognizedOrderQuantity })),
    movements: (aggregate.movements || []).map(row => ({ movementId: row.movementId, movementType: row.movementType, quantity: row.quantity, reversalOf: row.reversalOf })),
    receivableEntries: (aggregate.receivableEntries || []).map(row => ({ entryId: row.entryId, entryType: row.entryType, amount: row.amount, reversalOf: row.reversalOf })),
    orderEvents: (aggregate.orderEvents || []).map(row => ({ eventId: row.eventId, eventType: row.eventType,
      quantity: row.quantity, allocationEventId: row.detail?.allocationEventId, restoresReversalEventId: row.detail?.restoresReversalEventId })),
    voucherEvents: (aggregate.voucherEvents || []).map(row => ({ eventId: row.eventId, eventType: row.eventType, revision: row.revision })),
    command: { commandId: aggregate.document?.commandId, centralTransactionId: aggregate.document?.centralTransactionId,
      resultDigest: aggregate.document?.resultDigest, projectionStatus: aggregate.document?.projectionStatus }
  };
}
