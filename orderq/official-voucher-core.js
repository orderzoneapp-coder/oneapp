import './canonical-hash.js?v=0.1.0';

const sharedCanonicalHash = globalThis.ORDERQ_CANONICAL_HASH;
if (!sharedCanonicalHash) throw new Error('ORDERQ_CANONICAL_HASH_NOT_LOADED');

export const OFFICIAL_VOUCHER_COMMAND = Object.freeze({
  POST_PURCHASE: 'POST_PURCHASE',
  CORRECT_PURCHASE: 'CORRECT_PURCHASE',
  REVERSE_PURCHASE: 'REVERSE_PURCHASE',
  POST_SALE: 'POST_SALE',
  CORRECT_SALE: 'CORRECT_SALE',
  REVERSE_SALE: 'REVERSE_SALE'
});

export const OFFICIAL_VOUCHER_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  CONFIRMED: 'CONFIRMED',
  REVERSED: 'REVERSED'
});

export const OFFICIAL_TAX_TYPE = 'VAT_INCLUDED_IN_SUPPLY';
export const OFFICIAL_CURRENCY = 'KRW';

const COMMANDS = new Set(Object.values(OFFICIAL_VOUCHER_COMMAND));

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function requiredText(value, code) {
  const result = text(value);
  if (!result) throw new Error(code);
  return result;
}

function finite(value, code) {
  if (value === '' || value === null || value === undefined) throw new Error(code);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(code);
  return number;
}

export function roundWon(value) {
  const number = finite(value, 'ORDERQ_OFFICIAL_AMOUNT_INVALID');
  return Math.sign(number) * Math.floor(Math.abs(number) + 0.5);
}

export function calculateOfficialLineAmount(quantity, unitPrice) {
  const normalizedQuantity = finite(quantity, 'ORDERQ_OFFICIAL_QUANTITY_REQUIRED');
  const normalizedUnitPrice = finite(unitPrice, 'ORDERQ_OFFICIAL_UNIT_PRICE_REQUIRED');
  const supplyAmount = roundWon(normalizedQuantity * normalizedUnitPrice);
  return {
    quantity: normalizedQuantity,
    unitPrice: normalizedUnitPrice,
    supplyAmount,
    totalAmount: supplyAmount,
    vatAmount: null,
    taxType: OFFICIAL_TAX_TYPE,
    currency: OFFICIAL_CURRENCY
  };
}

export function calculateOfficialDocumentAmount(lines = []) {
  const normalized = lines.map(line => ({ ...line, ...calculateOfficialLineAmount(line.actualQuantity ?? line.quantity, line.unitPrice) }));
  const supplyAmount = normalized.reduce((sum, line) => sum + line.supplyAmount, 0);
  return {
    lines: normalized,
    supplyAmount,
    totalAmount: supplyAmount,
    vatAmount: null,
    taxType: OFFICIAL_TAX_TYPE,
    currency: OFFICIAL_CURRENCY
  };
}

function stableId(prefix, ...parts) {
  const source = parts.map(value => text(value)).join('|');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
    return result;
  }, {});
  return value;
}

function utf8Bytes(value) {
  const encoded = JSON.stringify(value);
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(encoded).byteLength : unescape(encodeURIComponent(encoded)).length;
}

function legacyCanonicalSha256(value) {
  const input = unescape(encodeURIComponent(JSON.stringify(canonicalValue(value))));
  const words = [];
  const bitLength = input.length * 8;
  for (let index = 0; index < input.length; index += 1) words[index >> 2] = (words[index >> 2] || 0) | input.charCodeAt(index) << (24 - (index % 4) * 8);
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | 0x80 << (24 - bitLength % 32);
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;
  const rotr = (value32, bits) => value32 >>> bits | value32 << (32 - bits);
  const primes = [];
  for (let candidate = 2; primes.length < 64; candidate += 1) {
    if (primes.every(prime => candidate % prime)) primes.push(candidate);
  }
  const constants = primes.map(prime => Math.floor((Math.pow(prime, 1 / 3) % 1) * 0x100000000));
  let hash = primes.slice(0, 8).map(prime => Math.floor((Math.sqrt(prime) % 1) * 0x100000000));
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = Array.from({ length: 16 }, (_, index) => words[offset + index] || 0);
    const previous = hash.slice();
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15] || 0;
      const b = schedule[index - 2] || 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ a >>> 3;
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ b >>> 10;
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) | 0;
    }
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(hash[4], 6) ^ rotr(hash[4], 11) ^ rotr(hash[4], 25);
      const choose = hash[4] & hash[5] ^ ~hash[4] & hash[6];
      const temp1 = (hash[7] + s1 + choose + constants[index] + schedule[index]) | 0;
      const s0 = rotr(hash[0], 2) ^ rotr(hash[0], 13) ^ rotr(hash[0], 22);
      const majority = hash[0] & hash[1] ^ hash[0] & hash[2] ^ hash[1] & hash[2];
      const temp2 = (s0 + majority) | 0;
      hash = [(temp1 + temp2) | 0, hash[0], hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
    }
    hash = hash.map((value32, index) => (value32 + previous[index]) | 0);
  }
  return hash.map(value32 => (value32 >>> 0).toString(16).padStart(8, '0')).join('');
}

export const canonicalSha256 = sharedCanonicalHash.canonicalSha256;

export function voucherStableId(prefix, ...parts) { return stableId(prefix, ...parts); }

function documentKind(commandType) {
  return commandType.endsWith('PURCHASE') ? 'PURCHASE' : 'SALE';
}

function action(commandType) {
  return commandType.split('_')[0];
}

function documentId(kind, source = {}) {
  return requiredText(kind === 'PURCHASE' ? source.purchaseDocumentId : source.salesDocumentId, `ORDERQ_OFFICIAL_${kind}_DOCUMENT_ID_REQUIRED`);
}

function lineId(kind, line = {}) {
  return requiredText(kind === 'PURCHASE' ? line.purchaseLineId : line.salesLineId, `ORDERQ_OFFICIAL_${kind}_LINE_ID_REQUIRED`);
}

function partnerId(kind, source = {}) {
  return requiredText(kind === 'PURCHASE' ? source.supplierCustomerId : source.billingCustomerId, `ORDERQ_OFFICIAL_${kind}_PARTNER_REQUIRED`);
}

function normalizeCommand(source = {}) {
  const commandType = text(source.commandType).toUpperCase();
  if (!COMMANDS.has(commandType)) throw new Error(`ORDERQ_OFFICIAL_COMMAND_TYPE_INVALID:${commandType}`);
  const expectedRevision = Number(source.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_OFFICIAL_REVISION_REQUIRED');
  const reason = text(source.reason);
  if (action(commandType) !== 'POST' && !reason) throw new Error('ORDERQ_OFFICIAL_REASON_REQUIRED');
  const commandId = requiredText(source.commandId, 'ORDERQ_OFFICIAL_COMMAND_ID_REQUIRED');
  const idempotencyKey = requiredText(source.idempotencyKey, 'ORDERQ_OFFICIAL_IDEMPOTENCY_KEY_REQUIRED');
  if (commandId !== idempotencyKey) throw new Error('ORDERQ_OFFICIAL_COMMAND_IDEMPOTENCY_MISMATCH');
  if (text(source.commandContract).toUpperCase() !== 'VOUCHER_CORE_V1') throw new Error('ORDERQ_OFFICIAL_COMMAND_CONTRACT_REQUIRED');
  return {
    ...source,
    commandType,
    commandContract: 'VOUCHER_CORE_V1',
    commandId,
    idempotencyKey,
    actor: requiredText(source.actor, 'ORDERQ_OFFICIAL_ACTOR_REQUIRED'),
    occurredAt: requiredText(source.occurredAt, 'ORDERQ_OFFICIAL_OCCURRED_AT_REQUIRED'),
    expectedRevision,
    reason
  };
}

function normalizeLine(kind, source, document, revision) {
  const id = lineId(kind, source);
  const amount = calculateOfficialLineAmount(source.actualQuantity ?? source.quantity, source.unitPrice);
  const baseQuantity = source.baseQuantity === '' || source.baseQuantity === undefined || source.baseQuantity === null
    ? amount.quantity
    : finite(source.baseQuantity, 'ORDERQ_OFFICIAL_BASE_QUANTITY_REQUIRED');
  const common = {
    ...source,
    productId: requiredText(source.productId, 'ORDERQ_OFFICIAL_PRODUCT_REQUIRED'),
    warehouseId: requiredText(source.warehouseId || document.warehouseId, 'ORDERQ_OFFICIAL_WAREHOUSE_REQUIRED'),
    quantity: amount.quantity,
    actualQuantity: amount.quantity,
    baseQuantity,
    unitPrice: amount.unitPrice,
    supplyAmount: amount.supplyAmount,
    totalAmount: amount.totalAmount,
    vatAmount: null,
    taxType: OFFICIAL_TAX_TYPE,
    currency: OFFICIAL_CURRENCY,
    lineIdentityId: requiredText(source.lineIdentityId, 'ORDERQ_OFFICIAL_LINE_IDENTITY_REQUIRED'),
    sourceLineKey: requiredText(source.sourceLineKey, 'ORDERQ_OFFICIAL_SOURCE_LINE_KEY_REQUIRED'),
    lineStatus: 'ACTIVE',
    status: OFFICIAL_VOUCHER_STATUS.CONFIRMED,
    commandId: document.commandId,
    revision,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy
  };
  return kind === 'PURCHASE'
    ? { ...common, purchaseLineId: id, purchaseDocumentId: document.purchaseDocumentId }
    : { ...common, salesLineId: id, salesDocumentId: document.salesDocumentId };
}

function movementDraft(kind, command, document, line, signedBaseQuantity, suffix, extra = {}) {
  const lineKey = lineId(kind, line);
  const ordinal = Number(extra.effectOrdinal || 1);
  const effectKey = stableId('FX', command.commandId, documentId(kind, document), document.revision, line.lineIdentityId, suffix, ordinal);
  return {
    movementId: stableId('IM', effectKey),
    productId: line.productId,
    productCode: text(line.productCode),
    warehouseId: line.warehouseId,
    signedBaseQuantity: signedBaseQuantity === 0 ? 0 : signedBaseQuantity,
    baseUnit: text(line.baseUnit || line.unit),
    movementType: `${document.sourceType}_${kind}_${extra.operation || 'POST'}`,
    sourceDocumentType: `${document.sourceType}_${kind}`,
    sourceDocumentId: documentId(kind, document),
    sourceLineId: lineKey,
    commandId: command.commandId,
    sourceDocumentRevision: document.revision,
    lineIdentityId: line.lineIdentityId,
    effectKind: suffix,
    effectOrdinal: ordinal,
    effectKey,
    officialCommandType: command.commandType,
    officialCommandProofRequired: true,
    idempotencyKey: effectKey,
    occurredAt: command.occurredAt,
    reason: command.reason,
    reversalOf: text(extra.reversalOf)
  };
}

function sameInventoryKey(left, right) {
  return text(left?.productId) === text(right?.productId) && text(left?.warehouseId) === text(right?.warehouseId);
}

function remainingMovementEffects(movements = []) {
  const reversalsById = new Map();
  const reversedIds = new Set();
  movements.filter(row => text(row.movementType).endsWith('_REVERSAL') || text(row.effectKind) === 'REVERSE_OLD').forEach(row => {
    reversedIds.add(text(row.reversalOf));
    reversalsById.set(text(row.reversalOf), (reversalsById.get(text(row.reversalOf)) || 0) + Number(row.signedBaseQuantity || 0));
  });
  return movements.filter(row => !text(row.movementType).endsWith('_REVERSAL') && text(row.effectKind) !== 'REVERSE_OLD').map(row => ({
    movement: row,
    remaining: Number(row.signedBaseQuantity || 0) + (reversalsById.get(text(row.movementId)) || 0)
  })).filter(row => Math.abs(row.remaining) > 1e-9
    || (Number(row.movement.signedBaseQuantity || 0) === 0 && !reversedIds.has(text(row.movement.movementId))));
}

function lineMovements(kind, command, document, previous, next, priorMovements = []) {
  const effect = quantity => kind === 'PURCHASE' ? Number(quantity) : -Number(quantity);
  if (!previous) return [movementDraft(kind, command, document, next, effect(next.baseQuantity), 'APPLY_NEW', { operation: 'POST' })];
  const reversalMovements = () => {
    const effects = remainingMovementEffects(priorMovements);
    const reversalOperation = action(command.commandType) === 'CORRECT' ? 'CORRECTION' : 'REVERSAL';
    if (!effects.length) return [movementDraft(kind, command, document, previous, -effect(previous.baseQuantity), 'REVERSE_OLD', { operation: reversalOperation, reversalOf: previous.movementId })];
    return effects.map((row, index) => movementDraft(kind, command, document, previous, -row.remaining, 'REVERSE_OLD', {
      operation: reversalOperation, reversalOf: row.movement.movementId, effectOrdinal: index + 1
    }));
  };
  if (!next) return reversalMovements();
  if (sameInventoryKey(previous, next)) {
    return [movementDraft(kind, command, document, next, effect(next.baseQuantity) - effect(previous.baseQuantity), 'DELTA', { operation: 'CORRECTION' })];
  }
  return [
    ...reversalMovements(),
    movementDraft(kind, command, document, next, effect(next.baseQuantity), 'APPLY_NEW', { operation: 'CORRECTION', effectOrdinal: remainingMovementEffects(priorMovements).length + 1 })
  ];
}

function ledgerEntry(kind, command, document, entryType, amounts, partner, suffix, reversalOf = '', ordinal = 1) {
  const id = documentId(kind, document);
  const effectOrdinal = Number(ordinal || 1);
  const effectKey = stableId('FX', command.commandId, id, document.revision, 'DOCUMENT', entryType, effectOrdinal);
  const entryId = stableId(kind === 'PURCHASE' ? 'PE' : 'RE', effectKey);
  return {
    entryId,
    entryType,
    effectOrdinal,
    effectKey,
    partnerId: partner,
    purchaseDocumentId: kind === 'PURCHASE' ? id : '',
    salesDocumentId: kind === 'SALE' ? id : '',
    sourceDocumentRevision: document.revision,
    supplyAmount: amounts.supplyAmount,
    vatAmount: null,
    totalAmount: amounts.totalAmount,
    taxType: OFFICIAL_TAX_TYPE,
    currency: OFFICIAL_CURRENCY,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    reversalOf,
    reason: command.reason,
    occurredAt: command.occurredAt,
    createdBy: command.actor,
    createdAt: command.occurredAt
  };
}

function orderEventsForLine(command, document, previous, next, priorEvents = []) {
  const previousMode = text(previous?.orderLinkMode).toUpperCase();
  const nextMode = text(next?.orderLinkMode).toUpperCase();
  if (previousMode !== 'ORDER_Q' && nextMode !== 'ORDER_Q') return [];
  const sameLink = previousMode === nextMode
    && text(previous?.sourceOrderId) === text(next?.sourceOrderId)
    && text(previous?.sourceOrderItemId) === text(next?.sourceOrderItemId);
  const makeEvent = (source, signedQuantity, ordinal, allocationEventId = '') => {
    if (!source || Math.abs(signedQuantity) <= 1e-9) return null;
    const orderId = requiredText(source.sourceOrderId, 'ORDERQ_OFFICIAL_SOURCE_ORDER_REQUIRED');
    const orderItemId = requiredText(source.sourceOrderItemId, 'ORDERQ_OFFICIAL_SOURCE_ORDER_ITEM_REQUIRED');
    const eventType = signedQuantity > 0 ? 'SALES_TRANSFER_ALLOCATED' : 'SALES_TRANSFER_REVERSED';
    const effectKey = stableId('FX', command.commandId, document.salesDocumentId, document.revision, source.lineIdentityId, eventType, ordinal);
    const reversalAllocationId = signedQuantity < 0 ? requiredText(allocationEventId, 'ORDERQ_OFFICIAL_ALLOCATION_EVENT_REQUIRED') : '';
    const event = {
    eventId: stableId('OE', effectKey),
    orderId,
    revision: document.revision,
    sourceDocumentRevision: document.revision,
    commandId: command.commandId,
    effectKey,
    effectOrdinal: ordinal,
    eventType,
    actor: command.actor,
    detail: {
      transferBusinessKey: [document.salesDocumentId, lineId('SALE', source), orderItemId].join('|'),
      allocationEventId: reversalAllocationId,
      orderItemId,
      productId: text(source.productId),
      warehouseId: text(source.warehouseId),
      lineIdentityId: text(source.lineIdentityId),
      sourceDispatchId: text(source.sourceDispatchId),
      sourceDispatchLineId: text(source.sourceDispatchLineId),
      salesDocumentId: document.salesDocumentId,
      salesLineId: lineId('SALE', source),
      transferredQty: Math.abs(signedQuantity),
      idempotencyKey: command.idempotencyKey,
      reason: command.reason
    },
    createdAt: command.occurredAt
    };
    if (signedQuantity > 0) source.allocationEventId = event.eventId;
    return event;
  };
  const allocationRows = priorEvents.filter(row => text(row.eventType).toUpperCase() === 'SALES_TRANSFER_ALLOCATED');
  const reversalRows = priorEvents.filter(row => text(row.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED');
  const remainingAllocations = (source, explicitOnly = false) => {
    const explicitIds = new Set([...(Array.isArray(source?.allocationEventIds) ? source.allocationEventIds : []), source?.allocationEventId].map(text).filter(Boolean));
    return allocationRows.filter(row => {
      const detail = row.detail || {};
      if (explicitOnly) return explicitIds.has(text(row.eventId));
      return text(row.orderId) === text(source?.sourceOrderId)
        && text(detail.orderItemId) === text(source?.sourceOrderItemId)
        && text(detail.salesDocumentId) === text(document.salesDocumentId)
        && text(detail.salesLineId) === text(lineId('SALE', source));
    }).map(row => ({
      event: row,
      remaining: Number(row.detail?.transferredQty || 0) - reversalRows.filter(reversal => text(reversal.detail?.allocationEventId) === text(row.eventId))
        .reduce((sum, reversal) => sum + Number(reversal.detail?.transferredQty || 0), 0)
    })).filter(row => row.remaining > 1e-9)
      .sort((left, right) => text(right.event.createdAt).localeCompare(text(left.event.createdAt)) || text(right.event.eventId).localeCompare(text(left.event.eventId)));
  };
  const reverseQuantity = (source, quantity, ordinalStart, explicitOnly = false) => {
    let remaining = Math.abs(Number(quantity || 0));
    const events = [];
    for (const allocation of remainingAllocations(source, explicitOnly)) {
      if (remaining <= 1e-9) break;
      const detail = allocation.event.detail || {};
      if (text(allocation.event.orderId) !== text(source.sourceOrderId) || text(detail.orderItemId) !== text(source.sourceOrderItemId)
        || (text(detail.productId) && text(detail.productId) !== text(source.productId))
        || (text(detail.warehouseId) && text(detail.warehouseId) !== text(source.warehouseId))
        || (text(detail.lineIdentityId) && text(detail.lineIdentityId) !== text(source.lineIdentityId))) {
        throw new Error('ORDERQ_OFFICIAL_ALLOCATION_LINK_INVALID');
      }
      const amount = Math.min(remaining, allocation.remaining);
      events.push(makeEvent(source, -amount, ordinalStart + events.length, allocation.event.eventId));
      remaining -= amount;
    }
    if (remaining > 1e-9) throw new Error('ORDERQ_OFFICIAL_ALLOCATION_BALANCE_INSUFFICIENT');
    return events;
  };
  if (!previous && nextMode === 'ORDER_Q') {
    const quantity = Number(next.recognizedOrderQuantity || 0);
    return quantity < 0 ? reverseQuantity(next, quantity, 1, true) : [makeEvent(next, quantity, 1)].filter(Boolean);
  }
  if (!sameLink) {
    const reversals = previousMode === 'ORDER_Q' ? reverseQuantity(previous, previous.recognizedOrderQuantity, 1) : [];
    if (nextMode !== 'ORDER_Q') return reversals;
    const nextQuantity = Number(next.recognizedOrderQuantity || 0);
    if (nextQuantity < 0) return [...reversals, ...reverseQuantity(next, nextQuantity, reversals.length + 1, true)];
    return [...reversals, makeEvent(next, nextQuantity, reversals.length + 1)].filter(Boolean);
  }
  const delta = Number(next?.recognizedOrderQuantity || 0) - Number(previous?.recognizedOrderQuantity || 0);
  return delta < 0 ? reverseQuantity(previous, delta, 1) : [makeEvent(next || previous, delta, 1)].filter(Boolean);
}

function snapshotLine(kind, line, deleted = false) {
  const idField = kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId';
  return {
    [idField]: text(line[idField]), lineIdentityId: text(line.lineIdentityId), sourceLineKey: text(line.sourceLineKey),
    productId: text(line.productId), warehouseId: text(line.warehouseId), actualQuantity: Number(line.actualQuantity ?? line.quantity ?? 0),
    baseQuantity: Number(line.baseQuantity ?? 0), unitPrice: Number(line.unitPrice ?? 0), supplyAmount: Number(line.supplyAmount ?? 0),
    totalAmount: Number(line.totalAmount ?? 0), partnerId: text(line.partnerId), orderLinkMode: text(line.orderLinkMode),
    sourceOrderId: text(line.sourceOrderId), sourceOrderItemId: text(line.sourceOrderItemId),
    sourceDispatchId: text(line.sourceDispatchId), sourceDispatchLineId: text(line.sourceDispatchLineId),
    allocationEventId: text(line.allocationEventId), recognizedOrderQuantity: Number(line.recognizedOrderQuantity || 0),
    lineStatus: deleted ? 'DELETED' : text(line.lineStatus || 'ACTIVE')
  };
}

function businessSnapshot(kind, document, lines, tombstones = []) {
  if (!document) return null;
  const idField = kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const partnerField = kind === 'PURCHASE' ? 'supplierCustomerId' : 'billingCustomerId';
  return {
    documentContract: text(document.documentContract), documentType: kind, [idField]: text(document[idField]),
    sourceType: text(document.sourceType), sourceDocumentKey: text(document.sourceDocumentKey), revision: Number(document.revision || 0),
    businessStatus: text(document.businessStatus || document.status), partnerId: text(document[partnerField]), warehouseId: text(document.warehouseId),
    supplyAmount: Number(document.supplyAmount ?? document.supplyAmountWon ?? 0), totalAmount: Number(document.totalAmount ?? document.totalAmountWon ?? 0),
    taxType: text(document.taxType), vatAmount: document.vatAmount ?? null, currency: text(document.currency),
    lines: [...lines.map(line => snapshotLine(kind, line)), ...tombstones.map(line => snapshotLine(kind, line, true))]
      .sort((left, right) => left.lineIdentityId.localeCompare(right.lineIdentityId))
  };
}

export function planOfficialVoucherCommand(input = {}) {
  const command = normalizeCommand(input.command || input);
  const kind = documentKind(command.commandType);
  const operation = action(command.commandType);
  const previousDocument = input.document || null;
  const previousLines = Array.isArray(input.lines) ? input.lines : [];
  const previousSnapshotLines = Array.isArray(input.snapshotLines) ? input.snapshotLines : previousLines;
  const previousMovements = Array.isArray(input.movements) ? input.movements : [];
  const previousOrderEvents = Array.isArray(input.orderEvents) ? input.orderEvents : [];
  const allPreviousEntries = Array.isArray(input.entries) ? input.entries : [];
  if (!previousDocument) throw new Error('ORDERQ_OFFICIAL_DOCUMENT_REQUIRED');
  const aggregateId = documentId(kind, previousDocument);
  const previousEntries = allPreviousEntries.filter(entry => text(kind === 'PURCHASE' ? entry.purchaseDocumentId : entry.salesDocumentId) === aggregateId);
  if (Number(previousDocument.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_OFFICIAL_REVISION_CONFLICT:${previousDocument.revision || 0}`);
  const expectedStatus = operation === 'POST' ? OFFICIAL_VOUCHER_STATUS.DRAFT : OFFICIAL_VOUCHER_STATUS.CONFIRMED;
  const previousStatus = text(previousDocument.businessStatus || previousDocument.status).toUpperCase();
  if (previousStatus !== expectedStatus) throw new Error(`ORDERQ_OFFICIAL_STATUS_CONFLICT:${previousStatus}`);
  if (text(previousDocument.documentContract).toUpperCase() !== 'VOUCHER_CORE_V1') throw new Error('ORDERQ_OFFICIAL_COMMAND_CONTRACT_MISMATCH');

  const revision = command.expectedRevision + 1;
  const nextDocument = {
    ...previousDocument,
    ...(command.document || {}),
    revision,
    businessStatus: operation === 'REVERSE' ? OFFICIAL_VOUCHER_STATUS.REVERSED : OFFICIAL_VOUCHER_STATUS.CONFIRMED,
    status: operation === 'REVERSE' ? OFFICIAL_VOUCHER_STATUS.REVERSED : OFFICIAL_VOUCHER_STATUS.CONFIRMED,
    projectionStatus: 'COMMAND_PENDING',
    documentContract: 'VOUCHER_CORE_V1',
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sourceType: text((command.document || previousDocument).sourceType).toUpperCase() || 'DIRECT',
    taxType: OFFICIAL_TAX_TYPE,
    vatAmount: null,
    currency: OFFICIAL_CURRENCY,
    updatedAt: command.occurredAt,
    updatedBy: command.actor
  };
  if (!['DIRECT', 'ORDER_Q'].includes(nextDocument.sourceType)) throw new Error('ORDERQ_OFFICIAL_SOURCE_TYPE_INVALID');
  partnerId(kind, nextDocument);

  const requestedLines = operation === 'REVERSE' ? [] : (Array.isArray(command.lines) ? command.lines : previousLines);
  if (!requestedLines.length && operation !== 'REVERSE') throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  const nextLines = requestedLines.map(line => normalizeLine(kind, line, nextDocument, revision));
  if (nextLines.length > 500) throw new Error('ORDERQ_VOUCHER_PAYLOAD_TOO_LARGE');
  if (kind === 'SALE') nextLines.forEach(line => {
    const linkMode = text(line.orderLinkMode || nextDocument.sourceType).toUpperCase();
    if (nextDocument.sourceType === 'DIRECT') {
      if (Number(line.recognizedOrderQuantity || 0) !== 0) throw new Error('ORDERQ_OFFICIAL_DIRECT_RECOGNIZED_MUST_BE_ZERO');
      line.orderLinkMode = 'DIRECT';
      line.recognizedOrderQuantity = 0;
    } else {
      if (line.recognizedOrderQuantity === '' || line.recognizedOrderQuantity === undefined || line.recognizedOrderQuantity === null) throw new Error('ORDERQ_OFFICIAL_RECOGNIZED_QUANTITY_REQUIRED');
      line.recognizedOrderQuantity = finite(line.recognizedOrderQuantity, 'ORDERQ_OFFICIAL_RECOGNIZED_QUANTITY_INVALID');
      if (linkMode !== 'ORDER_Q') throw new Error('ORDERQ_OFFICIAL_ORDER_LINK_MODE_REQUIRED');
      line.orderLinkMode = 'ORDER_Q';
      requiredText(line.sourceOrderId, 'ORDERQ_OFFICIAL_SOURCE_ORDER_REQUIRED');
      requiredText(line.sourceOrderItemId, 'ORDERQ_OFFICIAL_SOURCE_ORDER_ITEM_REQUIRED');
      const hasDispatch = Boolean(text(line.sourceDispatchId));
      const hasDispatchLine = Boolean(text(line.sourceDispatchLineId));
      if (hasDispatch !== hasDispatchLine) throw new Error('ORDERQ_OFFICIAL_SOURCE_DISPATCH_PAIR_REQUIRED');
    }
  });
  const amount = calculateOfficialDocumentAmount(nextLines);
  nextDocument.supplyAmount = amount.supplyAmount;
  nextDocument.totalAmount = amount.totalAmount;
  nextDocument.amountWon = amount.totalAmount;
  nextDocument.supplyAmountWon = amount.supplyAmount;
  nextDocument.totalAmountWon = amount.totalAmount;
  nextDocument.vatAmountWon = null;

  const previousById = new Map(previousLines.map(line => [lineId(kind, line), line]));
  const nextById = new Map(nextLines.map(line => [lineId(kind, line), line]));
  const allIds = new Set([...previousById.keys(), ...nextById.keys()]);
  const movements = [];
  const orderEvents = [];
  for (const id of allIds) {
    const previous = operation === 'POST' ? undefined : previousById.get(id);
    const next = nextById.get(id);
    const planned = lineMovements(kind, command, nextDocument, previous, next, previousMovements.filter(row => text(row.sourceLineId) === id));
    movements.push(...planned);
    if (next) next.movementId = planned[planned.length - 1].movementId;
    if (kind === 'SALE') orderEvents.push(...orderEventsForLine(command, nextDocument, previous, next, previousOrderEvents));
  }

  const previousAmount = {
    supplyAmount: Number(previousDocument.supplyAmount ?? previousDocument.supplyAmountWon ?? previousDocument.amountWon ?? 0),
    totalAmount: Number(previousDocument.totalAmount ?? previousDocument.totalAmountWon ?? previousDocument.amountWon ?? 0)
  };
  const currentPartner = partnerId(kind, nextDocument);
  const oldPartner = partnerId(kind, previousDocument);
  const entries = [];
  const ledgerPrefix = kind === 'PURCHASE' ? 'PAYABLE' : 'RECEIVABLE';
  const activeEntries = previousEntries.filter(entry => text(entry.partnerId) === oldPartner).map(entry => {
    const adjustments = previousEntries.filter(candidate => text(candidate.reversalOf) === text(entry.entryId));
    return { entry, balance: Number(entry.totalAmount || 0) + adjustments.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0) };
  }).filter(row => Math.abs(row.balance) > 1e-9 || Number(row.entry.totalAmount || 0) === 0);
  if (operation === 'POST') {
    entries.push(ledgerEntry(kind, command, nextDocument, `${ledgerPrefix}_POST`, amount, currentPartner, 'POST'));
  } else if (operation === 'REVERSE') {
    const targets = activeEntries.length ? activeEntries : [{ entry: { entryId: text(previousDocument.lastLedgerEntryId) }, balance: previousAmount.totalAmount }];
    targets.forEach((row, index) => entries.push(ledgerEntry(kind, command, nextDocument, `${ledgerPrefix}_REVERSAL`, {
      supplyAmount: -row.balance,
      totalAmount: -row.balance
    }, oldPartner, `REVERSE-${index + 1}`, text(row.entry.entryId), index + 1)));
  } else if (oldPartner !== currentPartner) {
    const targets = activeEntries.length ? activeEntries : [{ entry: { entryId: text(previousDocument.lastLedgerEntryId) }, balance: previousAmount.totalAmount }];
    targets.forEach((row, index) => entries.push(ledgerEntry(kind, command, nextDocument, `${ledgerPrefix}_PARTNER_RELEASE`, {
      supplyAmount: -row.balance,
      totalAmount: -row.balance
    }, oldPartner, `OLD-PARTNER-${index + 1}`, text(row.entry.entryId), index + 1)));
    entries.push(ledgerEntry(kind, command, nextDocument, `${ledgerPrefix}_PARTNER_ASSIGN`, amount, currentPartner, 'NEW-PARTNER', '', entries.length + 1));
  } else {
    entries.push(ledgerEntry(kind, command, nextDocument, `${ledgerPrefix}_CORRECTION`, {
      supplyAmount: amount.supplyAmount - previousAmount.supplyAmount,
      totalAmount: amount.totalAmount - previousAmount.totalAmount
    }, currentPartner, 'CORRECT'));
  }
  nextDocument.lastLedgerEntryId = entries[entries.length - 1].entryId;

  const removedLines = previousSnapshotLines.filter(line => !nextById.has(lineId(kind, line)));
  const beforeSnapshot = businessSnapshot(kind, previousDocument,
    previousSnapshotLines.filter(line => text(line.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED'),
    previousSnapshotLines.filter(line => text(line.lineStatus || 'ACTIVE').toUpperCase() === 'DELETED'));
  const afterSnapshot = businessSnapshot(kind, nextDocument, nextLines, removedLines);

  const voucherEvent = {
    eventId: stableId('VE', command.commandId, revision),
    documentId: aggregateId,
    documentType: kind,
    eventType: `${kind}_${operation === 'POST' ? 'POSTED' : operation === 'CORRECT' ? 'CORRECTED' : 'REVERSED'}`,
    documentContract: 'VOUCHER_CORE_V1',
    sourceType: nextDocument.sourceType,
    partnerId: currentPartner,
    sourceDocumentRevision: revision,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    actor: command.actor,
    reason: command.reason,
    occurredAt: command.occurredAt,
    beforeSnapshot,
    afterSnapshot,
    beforeDigest: canonicalSha256(beforeSnapshot),
    afterDigest: canonicalSha256(afterSnapshot),
    lineEffects: [
      ...movements.map(row => ({ entityType: 'INVENTORY_MOVEMENT', entityId: row.movementId, effectKind: row.effectKind })),
      ...orderEvents.map(row => ({ entityType: 'ORDER_EVENT', entityId: row.eventId, effectKind: row.eventType })),
      ...entries.map(row => ({ entityType: kind === 'PURCHASE' ? 'PAYABLE_ENTRY' : 'RECEIVABLE_ENTRY', entityId: row.entryId, effectKind: row.entryType }))
    ],
    reversalOf: operation === 'REVERSE' ? text(previousDocument.lastVoucherEventId) : '',
    createdAt: command.occurredAt
  };
  if (utf8Bytes(voucherEvent.beforeSnapshot) > 96 * 1024
    || utf8Bytes(voucherEvent.afterSnapshot) > 96 * 1024
    || utf8Bytes(voucherEvent.lineEffects) > 64 * 1024
    || utf8Bytes(voucherEvent) > 256 * 1024) throw new Error('ORDERQ_VOUCHER_PAYLOAD_TOO_LARGE');
  nextDocument.lastVoucherEventId = voucherEvent.eventId;
  nextDocument.history = [...(Array.isArray(previousDocument.history) ? previousDocument.history : []), {
    eventId: voucherEvent.eventId,
    eventType: voucherEvent.eventType,
    revision,
    actor: command.actor,
    reason: command.reason,
    occurredAt: command.occurredAt
  }];

  return { command, kind, document: nextDocument, lines: nextLines, movements, entries, voucherEvent, orderEvents };
}
