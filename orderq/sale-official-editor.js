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
    const orderLinkMode = text(source.orderLinkMode || 'DIRECT').toUpperCase();
    if (!(actualToBaseFactor > 0) || (orderLinkMode === 'DIRECT' ? actualToRecognizedFactor !== 0 : !(actualToRecognizedFactor > 0))) {
      throw new Error('ORDERQ_SALE_CONVERSION_REQUIRED');
    }
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
  const frozen = document?.commandEnvelope || {};
  const sourceClaimKeys = Array.isArray(document?.sourceClaimKeys) ? document.sourceClaimKeys
    : Array.isArray(frozen.sourceClaimKeys) ? frozen.sourceClaimKeys : [];
  const commandId = `${commandType}:${text(document?.salesDocumentId)}:${revision + 1}:${canonicalSha256({ document, lines: normalizedLines, reason: editReason })}`;
  return { commandType, commandId, idempotencyKey: commandId, aggregateId: text(document?.salesDocumentId),
    salesDocumentId: text(document?.salesDocumentId), expectedRevision: revision, actor, reason: editReason,
    occurredAt: text(occurredAt || new Date().toISOString()), sourceType: text(document?.sourceType || frozen.sourceType),
    sourceDocumentKey:text(document?.sourceDocumentKey || frozen.sourceDocumentKey),
    normalizedOriginVersion:text(document?.normalizedOriginVersion || frozen.normalizedOriginVersion),
    originSystem:text(document?.originSystem || frozen.originSystem),
    originTransactionId:text(document?.originTransactionId || frozen.originTransactionId),
    sourceVoucherIndex:Number(document?.sourceVoucherIndex || frozen.sourceVoucherIndex || 0),
    externalDocumentNo:text(document?.externalDocumentNo || frozen.externalDocumentNo), sourceClaimKeys:[...sourceClaimKeys],
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
  const document = aggregate.document || {};
  const official = text(document.documentContract) === 'VOUCHER_CORE_V1' && text(document.contractKind) === 'SALE_STAGE4_V1';
  if (!official) return { schemaVersion:'ORDERQ_SALE_EVIDENCE_LEGACY_FALLBACK_V1', legacyFallback:true,
    lines:aggregate.lines || aggregate.activeLines || [], movements:aggregate.movements || [] };
  const defined = (value, code) => {
    if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`ORDERQ_SALE_EVIDENCE_UNDEFINED:${code}`);
    return value;
  };
  return {
    schemaVersion:'ORDERQ_SALE_EVIDENCE_V1', legacyFallback:false,
    axisLabels:{ actualQuantity:'실제 판매수량', baseQuantity:'재고 기준수량', recognizedOrderQuantity:'주문 이행수량', signedBaseQuantity:'재고 증감수량' },
    lines: (aggregate.activeLines || []).map(line => ({ lineIdentityId: defined(line.lineIdentityId, 'LINE_ID'), lineStatus:text(line.lineStatus || line.status || 'ACTIVE'),
      suggestedActualQuantity: line.suggestedActualQuantity ?? null, actualQuantity: defined(line.actualQuantity, 'ACTUAL_QUANTITY'),
      baseQuantity: defined(line.baseQuantity, 'BASE_QUANTITY'), recognizedOrderQuantity: defined(line.recognizedOrderQuantity, 'RECOGNIZED_QUANTITY'),
      supplyAmount:defined(line.supplyAmount, 'LINE_SUPPLY'), totalAmount:defined(line.totalAmount, 'LINE_TOTAL') })),
    tombstones:(aggregate.tombstones || []).map(line => ({ lineIdentityId:defined(line.lineIdentityId, 'TOMBSTONE_ID'), lineStatus:text(line.lineStatus || line.status),
      actualQuantity:defined(line.actualQuantity, 'TOMBSTONE_ACTUAL'), baseQuantity:defined(line.baseQuantity, 'TOMBSTONE_BASE'), recognizedOrderQuantity:defined(line.recognizedOrderQuantity, 'TOMBSTONE_RECOGNIZED') })),
    movements: (aggregate.movements || []).map(row => ({ movementId:defined(row.movementId, 'MOVEMENT_ID'), movementType:defined(row.movementType, 'MOVEMENT_TYPE'),
      productId:defined(row.productId, 'MOVEMENT_PRODUCT'), warehouseId:defined(row.warehouseId, 'MOVEMENT_WAREHOUSE'),
      signedBaseQuantity:defined(row.signedBaseQuantity, 'MOVEMENT_QUANTITY'), effectKind:defined(row.effectKind, 'MOVEMENT_EFFECT'),
      reversalOf:text(row.reversalOf), sequence:Number(row.ledgerSequence ?? row.effectOrdinal ?? 0) })),
    receivableEntries: (aggregate.receivableEntries || []).map(row => ({ entryId:defined(row.entryId, 'RECEIVABLE_ID'), entryType:defined(row.entryType, 'RECEIVABLE_TYPE'),
      partnerId:defined(row.partnerId, 'RECEIVABLE_PARTNER'), supplyAmount:defined(row.supplyAmount, 'RECEIVABLE_SUPPLY'),
      totalAmount:defined(row.totalAmount, 'RECEIVABLE_TOTAL'), reversalOf:text(row.reversalOf), sequence:Number(row.ledgerSequence ?? row.effectOrdinal ?? 0) })),
    orderEvents: (aggregate.orderEvents || []).map(row => ({ eventId:defined(row.eventId, 'ORDER_EVENT_ID'), eventType:defined(row.eventType, 'ORDER_EVENT_TYPE'),
      orderId:defined(row.orderId, 'ORDER_ID'), orderItemId:defined(row.detail?.orderItemId, 'ORDER_ITEM_ID'),
      transferredQty:defined(row.detail?.transferredQty, 'TRANSFERRED_QUANTITY'), allocationEventId:text(row.detail?.allocationEventId),
      restoresReversalEventId:text(row.detail?.restoresReversalEventId), sequence:Number(row.eventSequence ?? row.effectOrdinal ?? 0) })),
    voucherEvents: (aggregate.voucherEvents || []).map(row => ({ eventId:defined(row.eventId, 'VOUCHER_EVENT_ID'), eventType:defined(row.eventType, 'VOUCHER_EVENT_TYPE'),
      sourceDocumentRevision:defined(row.sourceDocumentRevision, 'VOUCHER_REVISION'), beforeSnapshot:defined(row.beforeSnapshot, 'VOUCHER_BEFORE'),
      afterSnapshot:defined(row.afterSnapshot, 'VOUCHER_AFTER'), commandId:defined(row.commandId, 'VOUCHER_COMMAND') })),
    command: { commandId:defined(document.commandId, 'COMMAND_ID'), centralTransactionId:text(document.centralTransactionId),
      resultDigest:text(document.resultDigest), projectionStatus:defined(document.projectionStatus, 'PROJECTION_STATUS'),
      projectionPending:Boolean(document.projectionPending), commandState:text(document.commandState) }
  };
}
