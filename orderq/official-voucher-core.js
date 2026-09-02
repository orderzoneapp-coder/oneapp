import './canonical-hash.js?v=0.2.0';
import {
  assertOfficialCommandV2,
  isOfficialVoucherIdentityV2,
  officialVoucherRevisionIdV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
  OFFICIAL_VOUCHER_V2_ENTITY
} from './official-voucher-v2-contract.js?v=0.5.0';
import {
  applyOfficialStocktakeDecisionsV2,
  assertOfficialStocktakeProjectionV2
} from './stocktake-conflict-v2.js?v=0.2.0';

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

export const OFFICIAL_CURRENCY = 'KRW';
export const OFFICIAL_TAX_TYPE = 'SOURCE_VALUE';

const COMMANDS = new Set(Object.values(OFFICIAL_VOUCHER_COMMAND));

const text = value => String(value ?? '').trim();
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function requiredText(value, code) {
  const result = text(value);
  if (!result) throw new Error(code);
  return result;
}

function finite(value, code) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) throw new Error(code);
  const number = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(number)) throw new Error(code);
  return Object.is(number, -0) ? 0 : number;
}

function optionalFinite(value, code) {
  return value === '' || value === null || value === undefined ? null : finite(value, code);
}

export function roundWon(value) {
  const number = finite(value, 'ORDERQ_OFFICIAL_AMOUNT_INVALID');
  return Math.sign(number) * Math.floor(Math.abs(number) + 0.5);
}

export const canonicalSha256 = sharedCanonicalHash.canonicalSha256;

export function voucherStableId(prefix, ...parts) {
  return `${prefix}-${canonicalSha256(parts).slice(0, 32)}`;
}

function normalizedIdentityPart(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

export function unresolvedProductStableId(companyId, source = {}) {
  const company = requiredText(companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const v2Resolution = source.officialProductResolution
    || source.productSnapshot?.matchEvidence?.officialProductResolution;
  const code = v2Resolution
    ? text(v2Resolution.inputProductCode ?? source.originalProductCode ?? source.productCode ?? source.itemCode)
    : normalizedIdentityPart(source.productCode || source.itemCode);
  const name = normalizedIdentityPart(source.productName || source.itemName || source.unregisteredProductQuery);
  const specification = normalizedIdentityPart(source.specification);
  const unit = normalizedIdentityPart(source.unit || source.actualUnit || source.baseUnit);
  if (!code && !name) throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_REQUIRED');
  return voucherStableId('UP', company, code ? `CODE:${code}` : `NAME:${name}`, specification, unit);
}

export function resolveOfficialLineAmounts(source = {}) {
  const quantity = finite(source.actualQuantity ?? source.quantity, 'ORDERQ_OFFICIAL_QUANTITY_REQUIRED');
  const unitPrice = finite(source.unitPrice, 'ORDERQ_OFFICIAL_UNIT_PRICE_REQUIRED');
  const explicitSupply = optionalFinite(source.supplyAmount ?? source.supplyAmountWon, 'ORDERQ_OFFICIAL_SUPPLY_AMOUNT_INVALID');
  const explicitVat = optionalFinite(source.vatAmount ?? source.vatAmountWon, 'ORDERQ_OFFICIAL_VAT_AMOUNT_INVALID');
  const explicitTotal = optionalFinite(source.totalAmount ?? source.totalAmountWon ?? source.amountWon, 'ORDERQ_OFFICIAL_TOTAL_AMOUNT_INVALID');
  const derivedSupply = roundWon(quantity * unitPrice);
  const supplyAmount = explicitSupply === null ? derivedSupply : explicitSupply;
  const vatAmount = explicitVat;
  const totalAmount = explicitTotal === null ? supplyAmount : explicitTotal;
  return {
    quantity,
    unitPrice,
    supplyAmount,
    vatAmount,
    totalAmount,
    calculatedSupplyAmount: derivedSupply,
    amountDifference: supplyAmount - derivedSupply,
    valueOrigin: explicitSupply === null ? 'DERIVED_AT_SAVE' : 'SOURCE_OR_USER',
    taxType: text(source.taxType) || OFFICIAL_TAX_TYPE,
    currency: text(source.currency) || OFFICIAL_CURRENCY
  };
}

export function calculateOfficialLineAmount(quantity, unitPrice) {
  return resolveOfficialLineAmounts({ quantity, unitPrice });
}

export function calculateOfficialDocumentAmount(lines = []) {
  const normalized = lines.map(line => ({ ...line, ...resolveOfficialLineAmounts(line) }));
  return {
    lines: normalized,
    supplyAmount: normalized.reduce((sum, line) => sum + line.supplyAmount, 0),
    vatAmount: normalized.every(line => line.vatAmount === null)
      ? null
      : normalized.reduce((sum, line) => sum + Number(line.vatAmount || 0), 0),
    totalAmount: normalized.reduce((sum, line) => sum + line.totalAmount, 0),
    calculatedSupplyAmount: normalized.reduce((sum, line) => sum + line.calculatedSupplyAmount, 0),
    amountDifference: normalized.reduce((sum, line) => sum + line.amountDifference, 0),
    currency: normalized[0]?.currency || OFFICIAL_CURRENCY
  };
}

function commandKind(commandType) {
  return commandType.endsWith('PURCHASE') ? 'PURCHASE' : 'SALE';
}

function commandAction(commandType) {
  return commandType.split('_')[0];
}

function documentId(kind, source = {}) {
  return requiredText(kind === 'PURCHASE' ? source.purchaseDocumentId : source.salesDocumentId,
    `ORDERQ_OFFICIAL_${kind}_DOCUMENT_ID_REQUIRED`);
}

function lineId(kind, source = {}) {
  return requiredText(kind === 'PURCHASE' ? source.purchaseLineId : source.salesLineId,
    `ORDERQ_OFFICIAL_${kind}_LINE_ID_REQUIRED`);
}

function partnerId(kind, source = {}) {
  return text(kind === 'PURCHASE'
    ? source.supplierCustomerId
    : source.billingCustomerId || source.salesCustomerId);
}

function requiredPartnerId(kind, source = {}) {
  return requiredText(partnerId(kind, source), `ORDERQ_OFFICIAL_${kind}_PARTNER_REQUIRED`);
}

function normalizeCommand(source = {}) {
  if (isOfficialVoucherIdentityV2(source)) assertOfficialCommandV2(source);
  const commandType = text(source.commandType).toUpperCase();
  if (!COMMANDS.has(commandType)) throw new Error(`ORDERQ_OFFICIAL_COMMAND_TYPE_INVALID:${commandType}`);
  const expectedRevision = Number(source.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_OFFICIAL_REVISION_REQUIRED');
  const commandId = requiredText(source.commandId, 'ORDERQ_OFFICIAL_COMMAND_ID_REQUIRED');
  const idempotencyKey = requiredText(source.idempotencyKey, 'ORDERQ_OFFICIAL_IDEMPOTENCY_KEY_REQUIRED');
  if (commandId !== idempotencyKey) throw new Error('ORDERQ_OFFICIAL_COMMAND_IDEMPOTENCY_MISMATCH');
  const action = commandAction(commandType);
  if (action !== 'POST' && !text(source.reason)) throw new Error('ORDERQ_OFFICIAL_REASON_REQUIRED');
  return {
    ...clone(source),
    commandType,
    commandId,
    idempotencyKey,
    expectedRevision,
    commandContract: 'VOUCHER_CORE_V1',
    companyId: requiredText(source.companyId || source.document?.companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED'),
    actor: requiredText(source.actor || source.actorId, 'ORDERQ_OFFICIAL_ACTOR_REQUIRED'),
    occurredAt: requiredText(source.occurredAt, 'ORDERQ_OFFICIAL_OCCURRED_AT_REQUIRED'),
    reason: text(source.reason)
  };
}

function productIdentity(source = {}) {
  const productId = text(source.productId);
  const unresolvedProductId = text(source.unresolvedProductId);
  if (!productId && !unresolvedProductId) throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_REQUIRED');
  if (productId && unresolvedProductId) throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_CONFLICT');
  return {
    productId,
    unresolvedProductId,
    productIdentityStatus: productId ? 'MATCHED' : 'UNRESOLVED'
  };
}

function normalizeLine(kind, source, document, revision) {
  const identityV2 = isOfficialVoucherIdentityV2(document);
  if (identityV2
    && text(source.companyId) && text(source.companyId) !== text(document.companyId)) {
    throw new Error('ORDERQ_OFFICIAL_LINE_COMPANY_MISMATCH');
  }
  if (identityV2
    && text(source.voucherGroupKey) !== text(document.voucherGroupKey)) {
    throw new Error('ORDERQ_OFFICIAL_V2_GROUP_MISMATCH');
  }
  const id = lineId(kind, source);
  const amounts = resolveOfficialLineAmounts(source);
  const baseQuantity = identityV2
    ? amounts.quantity
    : optionalFinite(source.baseQuantity, 'ORDERQ_OFFICIAL_BASE_QUANTITY_INVALID') ?? amounts.quantity;
  const identity = productIdentity(source);
  const common = {
    ...clone(source),
    ...identity,
    ...amounts,
    warehouseId: requiredText(source.warehouseId || document.warehouseId, 'ORDERQ_OFFICIAL_WAREHOUSE_REQUIRED'),
    baseQuantity,
    actualQuantity: amounts.quantity,
    ...(identityV2 ? {
      inventoryEffectFactor: 1,
      productIdentityStatus: identity.productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT'
    } : {}),
    lineIdentityId: text(source.lineIdentityId) || voucherStableId('LI', documentId(kind, document), id),
    sourceLineKey: text(source.sourceLineKey) || id,
    status: OFFICIAL_VOUCHER_STATUS.CONFIRMED,
    lineStatus: 'ACTIVE',
    revision,
    commandId: document.commandId,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy
  };
  return kind === 'PURCHASE'
    ? { ...common, purchaseLineId: id, purchaseDocumentId: document.purchaseDocumentId }
    : { ...common, salesLineId: id, salesDocumentId: document.salesDocumentId };
}

function lineInventoryQuantity(kind, line) {
  const base = finite(line.baseQuantity ?? line.actualQuantity ?? line.quantity, 'ORDERQ_OFFICIAL_BASE_QUANTITY_REQUIRED');
  return kind === 'PURCHASE' ? base : -base;
}

function inventoryEffect(kind, command, document, previous, next, ordinal) {
  const identityV2 = isOfficialVoucherIdentityV2(command);
  const beforeQuantity = previous?.productId ? lineInventoryQuantity(kind, previous) : 0;
  const afterQuantity = next?.productId ? lineInventoryQuantity(kind, next) : 0;
  const quantityDifference = afterQuantity - beforeQuantity;
  const signedQuantity = Object.is(quantityDifference, -0) ? 0 : quantityDifference;
  const reference = next || previous;
  if (!reference?.productId || (!identityV2 && signedQuantity === 0)) return null;
  return {
    movementId: voucherStableId('IM', command.commandId, reference.lineIdentityId || lineId(kind, reference), ordinal),
    companyId: command.companyId,
    warehouseId: reference.warehouseId,
    productId: reference.productId,
    sourceDocumentId: documentId(kind, document),
    sourceLineId: lineId(kind, reference),
    sourceDocumentRevision: document.revision,
    voucherMode: kind.toLowerCase(),
    movementType: `${kind}_${commandAction(command.commandType)}`,
    signedQuantity,
    ...(identityV2 ? {
      productCode: text(reference.productSnapshot?.productCode || reference.productCode),
      inventoryEffectFactor: 1,
      effectRole: 'SOURCE_VOUCHER_EFFECT',
      effectStatus: signedQuantity === 0 ? 'ZERO_EFFECT' : 'APPLIED_NORMAL',
      officialInventoryApplied: true,
      effectiveAt: text(document.businessDate || document.purchaseDate || document.saleDate || document.voucherDate),
      businessDate: text(document.businessDate || document.purchaseDate || document.saleDate || document.voucherDate),
      businessOccurredAt: text(reference.businessOccurredAt || document.businessOccurredAt || document.businessEffectiveAt),
      originalSignedQuantity: signedQuantity
    } : {}),
    commandId: command.commandId,
    occurredAt: command.occurredAt,
    actor: command.actor
  };
}

function pendingInventoryEffect(kind, command, document, previous, next, ordinal) {
  const identityV2 = isOfficialVoucherIdentityV2(command);
  const reference = next || previous;
  if (!reference?.unresolvedProductId) return null;
  const before = previous?.unresolvedProductId ? lineInventoryQuantity(kind, previous) : 0;
  const after = next?.unresolvedProductId ? lineInventoryQuantity(kind, next) : 0;
  const quantityDifference = after - before;
  const signedQuantity = Object.is(quantityDifference, -0) ? 0 : quantityDifference;
  if (!identityV2 && signedQuantity === 0) return null;
  return {
    pendingEffectId: voucherStableId('PIE', command.commandId, reference.lineIdentityId || lineId(kind, reference), ordinal),
    companyId: command.companyId,
    warehouseId: reference.warehouseId,
    unresolvedProductId: reference.unresolvedProductId,
    sourceDocumentId: documentId(kind, document),
    sourceLineId: lineId(kind, reference),
    sourceDocumentRevision: document.revision,
    voucherMode: kind.toLowerCase(),
    effectiveAt: text(document.businessDate || document.purchaseDate || document.saleDate || document.salesDate || document.voucherDate),
    businessOccurredAt: text(reference.businessOccurredAt || document.businessOccurredAt || document.businessEffectiveAt),
    signedQuantity,
    status: 'PENDING_PRODUCT_MATCH',
    ...(identityV2 ? {
      inventoryEffectStatus: 'UNRESOLVED_PRODUCT',
      officialInventoryApplied: false,
      productCode: text(reference.productSnapshot?.productCode || reference.productCode),
      productName: text(reference.productSnapshot?.productName || reference.productName),
      originalProductCode: text(reference.productSnapshot?.originalProductCode ?? reference.originalProductCode),
      originalProductName: text(reference.productSnapshot?.originalProductName ?? reference.originalProductName),
      specification: text(reference.productSnapshot?.specification || reference.specification),
      unit: text(reference.productSnapshot?.unit || reference.unit || reference.actualUnit),
      quantity: Number(reference.actualQuantity ?? reference.quantity),
      unitPrice: Number(reference.unitPrice),
      totalAmount: Number(reference.totalAmount),
      productSnapshot: clone(reference.productSnapshot),
      productResolution: clone(reference.officialProductResolution),
      voucherRevisionId: officialVoucherRevisionIdV2(kind, command.companyId, documentId(kind, document), document.revision)
    } : {}),
    commandId: command.commandId,
    createdAt: command.occurredAt
  };
}

function ledgerEntry(kind, command, document, partner, totalAmount, entryType, ordinal, reversalOf = '') {
  return {
    entryId: voucherStableId(kind === 'PURCHASE' ? 'PE' : 'RE', command.commandId, entryType, ordinal),
    companyId: command.companyId,
    partnerId: partner,
    voucherMode: kind.toLowerCase(),
    documentId: documentId(kind, document),
    purchaseDocumentId: kind === 'PURCHASE' ? document.purchaseDocumentId : '',
    salesDocumentId: kind === 'SALE' ? document.salesDocumentId : '',
    sourceDocumentRevision: document.revision,
    entryType,
    totalAmount,
    currency: document.currency || OFFICIAL_CURRENCY,
    reversalOf,
    commandId: command.commandId,
    ...(isOfficialVoucherIdentityV2(command) ? {
      effectiveAt: text(document.businessDate)
    } : {}),
    occurredAt: command.occurredAt,
    actor: command.actor
  };
}

function businessSnapshot(kind, document, lines, command) {
  const identityV2 = isOfficialVoucherIdentityV2(command);
  return {
    companyId: document.companyId,
    voucherMode: kind.toLowerCase(),
    documentId: documentId(kind, document),
    revision: document.revision,
    status: document.status,
    partnerId: identityV2 ? partnerId(kind, document) : requiredPartnerId(kind, document),
    warehouseId: document.warehouseId,
    supplyAmount: document.supplyAmount,
    vatAmount: document.vatAmount,
    totalAmount: document.totalAmount,
    ...(identityV2 ? {
      schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
      identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
      entityType: kind === 'PURCHASE'
        ? OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_REVISION
        : OFFICIAL_VOUCHER_V2_ENTITY.SALE_REVISION,
      voucherGroupKey: text(document.voucherGroupKey),
      officialPartnerResolution: clone(document.officialPartnerResolution)
    } : {}),
    lines: lines.map(line => ({
      lineId: lineId(kind, line),
      lineIdentityId: line.lineIdentityId,
      productId: line.productId,
      unresolvedProductId: line.unresolvedProductId,
      warehouseId: line.warehouseId,
      quantity: line.actualQuantity,
      baseQuantity: line.baseQuantity,
      unitPrice: line.unitPrice,
      supplyAmount: line.supplyAmount,
      vatAmount: line.vatAmount,
      totalAmount: line.totalAmount,
      ...(identityV2 ? {
        schemaVersion: line.schemaVersion,
        identityVersion: line.identityVersion,
        entityType: line.entityType,
        companyId: line.companyId,
        voucherGroupKey: line.voucherGroupKey,
        productCode: line.productCode,
        productName: line.productName,
        specification: line.specification,
        unit: line.unit || line.actualUnit,
        originalProductCode: line.originalProductCode,
        originalProductName: line.originalProductName,
        productSnapshot: clone(line.productSnapshot)
      } : {})
    }))
  };
}

export function planOfficialVoucherCommand(input = {}) {
  const command = normalizeCommand(input.command || input);
  const kind = commandKind(command.commandType);
  const action = commandAction(command.commandType);
  const identityV2 = isOfficialVoucherIdentityV2(command);
  const previousDocument = clone(input.document);
  const previousLines = clone(Array.isArray(input.lines) ? input.lines : []);
  if (!previousDocument) throw new Error('ORDERQ_OFFICIAL_DOCUMENT_REQUIRED');
  if (text(previousDocument.companyId) && text(previousDocument.companyId) !== command.companyId) {
    throw new Error('ORDERQ_OFFICIAL_COMPANY_MISMATCH');
  }
  if (isOfficialVoucherIdentityV2(command)) {
    if (text(previousDocument.companyId) !== command.companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_MISMATCH');
    if (text(previousDocument.voucherGroupKey) !== text(command.voucherGroupKey)) {
      throw new Error('ORDERQ_OFFICIAL_V2_GROUP_MISMATCH');
    }
  }
  if (Number(previousDocument.revision || 0) !== command.expectedRevision) {
    throw new Error(`ORDERQ_OFFICIAL_REVISION_CONFLICT:${previousDocument.revision || 0}`);
  }
  const expectedStatus = action === 'POST' ? OFFICIAL_VOUCHER_STATUS.DRAFT : OFFICIAL_VOUCHER_STATUS.CONFIRMED;
  if (text(previousDocument.status || previousDocument.businessStatus).toUpperCase() !== expectedStatus) {
    throw new Error(`ORDERQ_OFFICIAL_STATUS_CONFLICT:${previousDocument.status || previousDocument.businessStatus || ''}`);
  }

  const revision = command.expectedRevision + 1;
  const nextDocument = {
    ...previousDocument,
    ...clone(command.document || {}),
    companyId: command.companyId,
    revision,
    status: action === 'REVERSE' ? OFFICIAL_VOUCHER_STATUS.REVERSED : OFFICIAL_VOUCHER_STATUS.CONFIRMED,
    businessStatus: action === 'REVERSE' ? OFFICIAL_VOUCHER_STATUS.REVERSED : OFFICIAL_VOUCHER_STATUS.CONFIRMED,
    documentContract: 'VOUCHER_CORE_V1',
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    updatedAt: command.occurredAt,
    updatedBy: command.actor
  };
  documentId(kind, nextDocument);
  if (!isOfficialVoucherIdentityV2(command)) requiredPartnerId(kind, nextDocument);
  requiredText(nextDocument.warehouseId, 'ORDERQ_OFFICIAL_WAREHOUSE_REQUIRED');

  const requestedLines = action === 'REVERSE' ? [] : clone(Array.isArray(command.lines) ? command.lines : previousLines);
  if (action !== 'REVERSE' && !requestedLines.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  if (requestedLines.length > 10000) throw new Error('ORDERQ_VOUCHER_PAYLOAD_TOO_LARGE');
  const nextLines = requestedLines.map(line => normalizeLine(kind, line, nextDocument, revision));
  const amount = calculateOfficialDocumentAmount(nextLines);
  Object.assign(nextDocument, {
    supplyAmount: amount.supplyAmount,
    vatAmount: amount.vatAmount,
    totalAmount: amount.totalAmount,
    calculatedSupplyAmount: amount.calculatedSupplyAmount,
    amountDifference: amount.amountDifference,
    currency: amount.currency
  });

  const previousById = new Map(previousLines.map(line => [lineId(kind, line), line]));
  const nextById = new Map(nextLines.map(line => [lineId(kind, line), line]));
  const allLineIds = [...new Set([...previousById.keys(), ...nextById.keys()])];
  const inventoryMovements = [];
  const pendingInventoryEffects = [];
  allLineIds.forEach((id, index) => {
    const previous = action === 'POST' ? null : previousById.get(id);
    const next = nextById.get(id);
    const movement = inventoryEffect(kind, command, nextDocument, previous, next, index + 1);
    if (movement) inventoryMovements.push(movement);
    const pending = pendingInventoryEffect(kind, command, nextDocument, previous, next, index + 1);
    if (pending) pendingInventoryEffects.push(pending);
  });

  const stocktakeProjection = identityV2 ? applyOfficialStocktakeDecisionsV2({
    command,
    inventoryMovements,
    inventoryCheckpoints: Array.isArray(input.inventoryCheckpoints) ? input.inventoryCheckpoints : []
  }) : { inventoryMovements, stocktakeDecisions: [] };
  inventoryMovements.splice(0, inventoryMovements.length, ...stocktakeProjection.inventoryMovements);

  const previousTotal = Number(previousDocument.totalAmount || 0);
  const oldPartner = identityV2 ? partnerId(kind, previousDocument) : requiredPartnerId(kind, previousDocument);
  const newPartner = partnerId(kind, nextDocument);
  const ledgerEntries = [];
  const partnerResolution = identityV2 ? clone(nextDocument.officialPartnerResolution) : null;
  const createPartnerEffect = !identityV2 || text(partnerResolution?.status).toUpperCase() === 'MATCHED';
  if (action === 'POST' && createPartnerEffect) {
    ledgerEntries.push(ledgerEntry(kind, command, nextDocument, newPartner, nextDocument.totalAmount, `${kind}_POST`, 1));
  } else if (action === 'REVERSE' && createPartnerEffect) {
    ledgerEntries.push(ledgerEntry(kind, command, nextDocument, oldPartner, -previousTotal, `${kind}_REVERSAL`, 1,
      text(previousDocument.lastLedgerEntryId)));
  } else if (action === 'CORRECT' && createPartnerEffect && oldPartner !== newPartner) {
    ledgerEntries.push(ledgerEntry(kind, command, nextDocument, oldPartner, -previousTotal, `${kind}_PARTNER_RELEASE`, 1,
      text(previousDocument.lastLedgerEntryId)));
    ledgerEntries.push(ledgerEntry(kind, command, nextDocument, newPartner, nextDocument.totalAmount, `${kind}_PARTNER_ASSIGN`, 2));
  } else if (action === 'CORRECT' && createPartnerEffect) {
    ledgerEntries.push(ledgerEntry(kind, command, nextDocument, newPartner, nextDocument.totalAmount - previousTotal,
      `${kind}_CORRECTION`, 1));
  }
  nextDocument.lastLedgerEntryId = ledgerEntries.at(-1)?.entryId || '';
  const partnerEffectDecision = identityV2 ? {
    status: createPartnerEffect ? 'CREATED' : 'NOT_CREATED',
    reason: text(partnerResolution?.reason),
    partnerResolutionStatus: text(partnerResolution?.status),
    partnerId: createPartnerEffect ? newPartner : '',
    finalAmount: nextDocument.totalAmount,
    effectiveAt: text(nextDocument.businessDate),
    occurredAt: command.occurredAt,
    entryIds: ledgerEntries.map(row => row.entryId)
  } : null;

  const beforeSnapshot = businessSnapshot(kind, previousDocument, previousLines, command);
  const afterSnapshot = businessSnapshot(kind, nextDocument, nextLines, command);
  const revisionId = isOfficialVoucherIdentityV2(command)
    ? officialVoucherRevisionIdV2(kind, command.companyId, documentId(kind, nextDocument), revision)
    : `${documentId(kind, nextDocument)}:R${revision}`;
  const voucherRevision = {
    voucherRevisionId: revisionId,
    companyId: command.companyId,
    voucherMode: kind.toLowerCase(),
    documentId: documentId(kind, nextDocument),
    revision,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    action,
    status: nextDocument.status,
    beforeSnapshot,
    afterSnapshot,
    beforeDigest: canonicalSha256(beforeSnapshot),
    afterDigest: canonicalSha256(afterSnapshot),
    effects: [
      ...inventoryMovements.map(row => ({
        type: 'INVENTORY',
        id: row.movementId,
        ...(identityV2 ? {
          status: row.effectStatus,
          officialInventoryApplied: row.officialInventoryApplied,
          effectRole: row.effectRole || 'SOURCE_VOUCHER_EFFECT',
          stocktakeEffectStatus: row.stocktakeEffectStatus || '',
          stocktakeDecisionId: row.stocktakeDecisionId || '',
          checkpointId: row.checkpointId || ''
        } : {})
      })),
      ...pendingInventoryEffects.map(row => ({
        type: identityV2 ? 'UNRESOLVED_PRODUCT_REVIEW' : 'PENDING_INVENTORY',
        id: row.pendingEffectId,
        ...(identityV2 ? { status: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false } : {})
      })),
      ...ledgerEntries.map(row => ({ type: kind === 'PURCHASE' ? 'PAYABLE' : 'RECEIVABLE', id: row.entryId }))
    ],
    reason: command.reason,
    actor: command.actor,
    occurredAt: command.occurredAt,
    ...(isOfficialVoucherIdentityV2(command) ? {
      schemaVersion: OFFICIAL_VOUCHER_SCHEMA_VERSION_V2,
      identityVersion: OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
      entityType: kind === 'PURCHASE'
        ? OFFICIAL_VOUCHER_V2_ENTITY.PURCHASE_REVISION
        : OFFICIAL_VOUCHER_V2_ENTITY.SALE_REVISION,
      voucherGroupKey: text(command.voucherGroupKey),
      businessDate: text(nextDocument.businessDate),
      partnerEffectDecision,
      stocktakeDecisions: clone(stocktakeProjection.stocktakeDecisions)
    } : {})
  };
  nextDocument.lastVoucherRevisionId = voucherRevision.voucherRevisionId;
  const result = {
    command,
    kind,
    document: nextDocument,
    lines: nextLines,
    removedLines: previousLines.filter(line => !nextById.has(lineId(kind, line))).map(line => ({
      ...line,
      lineStatus: 'DELETED',
      status: 'DELETED',
      revision,
      commandId: command.commandId,
      updatedAt: command.occurredAt,
      updatedBy: command.actor
    })),
    inventoryMovements,
    pendingInventoryEffects,
    ledgerEntries,
    voucherRevision
  };
  if (identityV2) assertOfficialStocktakeProjectionV2(result, command);
  return result;
}
