import { pingCentralAuthority } from '../orderq/orderq-cloud-adapter.js?v=0.10.0';
import {
  buildFrozenPurchaseIntent,
  findOfficialPurchaseBySource,
  loadOfficialPurchaseAggregate,
  runCentralOfficialVoucherCommand,
  saveOfficialVoucherDraft
} from '../orderq/official-voucher-repository.js?v=0.18.0';
import { canonicalSha256 } from '../orderq/official-voucher-core.js?v=0.18.0';
import { pullCentralOfficialState } from '../orderq/central-command-gateway.js?v=0.18.0';
import { findLegacyPurchaseOriginConflict } from '../orderq/purchase-decision-repository.js?v=0.10.0';

export const PURCHASE_STAGE3_CAPABILITY = Object.freeze({
  officialPurchaseStage3: 'V1',
  normalizedOriginVersion: 'PURCHASE_V2',
  commandContract: 'VOUCHER_CORE_V1',
  metaSchema: 'ORDERQ_PURCHASE_META_V2',
  cutoverMode: 'VNEXT_PRIMARY'
});
// Filled only by the immutable Apps Script deployment release commit. Empty
// values intentionally keep production writes disabled.
export const PURCHASE_STAGE3_EXPECTED_DEPLOYMENT = Object.freeze({
  deploymentId: '', deploymentVersion: '', gitCommit: ''
});

// SmartInput currently has no authenticated actor/session provider. Keep the
// established application actor explicit until that shared provider exists.
export const SMARTINPUT_PURCHASE_ACTOR_ID = 'SMART_INPUT_ADMIN';

function text(value) { return String(value ?? '').trim(); }
function finiteRequired(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function roundWon(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }
function masterRevision(row) { return Number(row?.revision ?? row?.masterRevision ?? row?.raw?.revision ?? row?.raw?.masterRevision ?? 0); }

export function evaluatePurchaseStage3Capability(ping = {}, expectedDeployment = PURCHASE_STAGE3_EXPECTED_DEPLOYMENT) {
  const mismatch = Object.entries(PURCHASE_STAGE3_CAPABILITY).find(([key, expected]) => text(ping[key]) !== expected);
  const deploymentReady = ['deploymentId', 'deploymentVersion', 'gitCommit'].every(key =>
    text(expectedDeployment[key]) && text(ping[key]) === text(expectedDeployment[key]));
  return mismatch || !deploymentReady
    ? { ready: false, code: 'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE', detail: mismatch?.[0] || 'deploymentEvidence' }
    : { ready: true, code: '', deploymentId: text(ping.deploymentId), deploymentVersion: text(ping.deploymentVersion), gitCommit: text(ping.gitCommit) };
}

export async function loadPurchaseStage3Capability() {
  try { return evaluatePurchaseStage3Capability(await pingCentralAuthority()); }
  catch (error) { return { ready: false, code: 'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE', detail: text(error?.message || error) }; }
}

export function validatePurchaseGroup(group = {}, masters = {}) {
  const supplierId = text(group.supplierCustomerId);
  const supplier = (masters.customers || []).find(row => text(row.customerId) === supplierId);
  if (!supplier || text(supplier.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || text(supplier.qualityStatus).toUpperCase() === 'SUPERSEDED') {
    throw new Error(`ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID:${supplierId}`);
  }
  if (!text(group.voucherDate)) throw new Error('ORDERQ_PURCHASE_DATE_REQUIRED');
  const productById = new Map((masters.products || []).map(row => [text(row.productId), row]));
  const warehouseById = new Map((masters.warehouses || []).map(row => [text(row.warehouseId), row]));
  if (!(group.rows || []).length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  for (const row of group.rows) {
    const product = productById.get(text(row.productId));
    if (!product || text(product.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || product.active === false || text(product.productIdentityType).toUpperCase() === 'TEMPORARY') {
      throw new Error(`ORDERQ_PURCHASE_PRODUCT_MASTER_INVALID:${text(row.productId)}`);
    }
    if (text(row.sourceType).toUpperCase() === 'ORDER_Q') {
      const linkedId = text(row.metaProductId);
      const linkedCode = text(row.metaProductCode).toUpperCase();
      const currentCode = text(product.productCode || row.itemCode || row.productCode).toUpperCase();
      if ((linkedId && linkedId !== text(product.productId)) || (linkedCode && linkedCode !== currentCode)) {
        throw new Error(`ORDERQ_PURCHASE_PRODUCT_LINK_MISMATCH:${text(row.sourceLineKey)}`);
      }
    }
    const warehouseId = text(row.warehouseId || group.warehouseId);
    const warehouse = warehouseById.get(warehouseId);
    if (!warehouse || text(warehouse.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || warehouse.active === false) {
      throw new Error(`ORDERQ_PURCHASE_WAREHOUSE_MASTER_INVALID:${warehouseId}`);
    }
    const productRevision = Number(row.productMasterRevision || 0);
    const warehouseRevision = Number(row.warehouseMasterRevision || 0);
    if (!Number.isSafeInteger(productRevision) || productRevision <= 0
      || !Number.isSafeInteger(warehouseRevision) || warehouseRevision <= 0
      || productRevision < masterRevision(product) || warehouseRevision < masterRevision(warehouse)) {
      throw new Error(`ORDERQ_PURCHASE_MASTER_REVISION_STALE:${text(row.sourceLineKey)}`);
    }
    finiteRequired(row.actualQuantity ?? row.quantity, 'ORDERQ_PURCHASE_QUANTITY_REQUIRED');
    finiteRequired(row.unitPrice, 'ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED');
    if (!text(row.unit)) throw new Error('ORDERQ_PURCHASE_UNIT_REQUIRED');
    if (row.metaStatus === 'MUTATED' || row.unitConversionStatus === 'REVIEW_REQUIRED') throw new Error('ORDERQ_PURCHASE_META_REVIEW_REQUIRED');
  }
  return true;
}

export function derivePurchaseDraftIdentity(group = {}, context = {}) {
  const sourceType = text(group.sourceType || group.rows?.[0]?.sourceType || 'DIRECT').toUpperCase();
  const originSystem = text(group.originSystem || group.rows?.[0]?.originSystem || context.originSystem || 'SMARTINPUT_MANUAL').toUpperCase();
  const originTransactionId = text(group.originTransactionId || group.rows?.[0]?.originTransactionId || context.manualSessionId);
  const externalDocumentNo = text(group.externalVoucherNo);
  const sourceVoucherIndex = Number(group.sourceVoucherIndex || group.rows?.[0]?.sourceVoucherIndex || 1);
  const sourceRunKey = text(group.sourceRunKey || group.rows?.[0]?.sourceRunKey)
    || `RUN:${originSystem}:${originTransactionId}`;
  const roleSupplierKey = text(group.supplierCustomerId || group.supplierCustomerCode)
    || `NAME:${text(group.supplierCustomerName).normalize('NFKC').toLowerCase().replace(/\s+/g, '')}`;
  const documentSuffix = externalDocumentNo ? `NO:${externalDocumentNo}` : `VOUCHER:${sourceVoucherIndex}`;
  const sourceDocumentKey = sourceType === 'ORDER_Q'
    ? text(group.sourceDocumentKey || group.rows?.[0]?.sourceDocumentKey)
    : `PURCHASE:${canonicalSha256({ contractKind: 'PURCHASE_STAGE3_V1', sourceRunKey, documentSuffix, roleSupplierKey, purchaseDate: text(group.voucherDate), externalDocumentNo })}`;
  if (!sourceDocumentKey) throw new Error('ORDERQ_OFFICIAL_SOURCE_DOCUMENT_KEY_REQUIRED');
  const purchaseDocumentId = `PD-${canonicalSha256(['VOUCHER_CORE_V1', sourceType, sourceDocumentKey]).slice(0, 32)}`;
  return { sourceType, originSystem, originTransactionId, externalDocumentNo, sourceVoucherIndex,
    sourceRunKey, roleSupplierKey, documentSuffix, sourceDocumentKey, purchaseDocumentId,
    contractKind: 'PURCHASE_STAGE3_V1', purchasePlanId: text(group.purchasePlanId || group.rows?.[0]?.purchasePlanId) };
}

export function buildPurchasePostDraft(group = {}, context = {}) {
  const identity = derivePurchaseDraftIdentity(group, context);
  const { sourceType, originSystem, originTransactionId, externalDocumentNo, sourceVoucherIndex,
    sourceRunKey, documentSuffix, sourceDocumentKey, purchaseDocumentId } = identity;
  const occurredAt = text(context.occurredAt || new Date().toISOString());
  const lines = (group.rows || []).map((row, index) => {
    const actualQuantity = finiteRequired(row.actualQuantity ?? row.quantity, 'ORDERQ_PURCHASE_QUANTITY_REQUIRED');
    const unitPrice = finiteRequired(row.unitPrice, 'ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED');
    const conversionFactor = finiteRequired(row.conversionFactor ?? 1, 'ORDERQ_PURCHASE_CONVERSION_REQUIRED');
    const sourceRowKey = canonicalSha256({ sourceSheetName: text(row.sourceSheetName), sourceRowNo: Number(row.sourceRowNo || index + 1), sourceVoucherIndex });
    const sourceLineKey = sourceType === 'ORDER_Q' && text(row.sourceLineKey)
      ? text(row.sourceLineKey)
      : `${sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey, productIdentity: text(row.productId || row.itemCode), warehouseIdentity: text(row.warehouseId || group.warehouseId || row.warehouseCode || group.warehouseCode), sourceOccurrence: index + 1 })}`;
    const supplyAmount = roundWon(actualQuantity * unitPrice);
    return {
      sourceLineKey,
      lineIdentityId: `LI-${canonicalSha256([purchaseDocumentId, sourceLineKey]).slice(0, 32)}`,
      lineSequence: index + 1,
      productId: text(row.productId), productCode: text(row.itemCode || row.productCode), productName: text(row.itemName || row.productName),
      specification: text(row.specification), warehouseId: text(row.warehouseId || group.warehouseId),
      warehouseCode: text(row.warehouseCode || group.warehouseCode), actualQuantity, unit: text(row.unit).toUpperCase(),
      conversionFactor, baseQuantity: finiteRequired(row.baseQuantity ?? actualQuantity * conversionFactor, 'ORDERQ_PURCHASE_BASE_QUANTITY_REQUIRED'),
      baseUnit: text(row.baseUnit || row.unit).toUpperCase(), unitPrice, supplyAmount, totalAmount: supplyAmount,
      taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', productMasterRevision: Number(row.productMasterRevision || 0),
      warehouseMasterRevision: Number(row.warehouseMasterRevision || 0)
    };
  });
  const commandSeed = canonicalSha256({ purchaseDocumentId, sourceDocumentKey, originSystem, originTransactionId, lines: lines.map(row => row.sourceLineKey) });
  const commandId = `POST_PURCHASE:${commandSeed}`;
  const document = {
    purchaseDocumentId, supplierCustomerId: text(group.supplierCustomerId), supplierCustomerCode: text(group.supplierCustomerCode),
    supplierCustomerName: text(group.supplierCustomerName), purchaseDate: text(group.voucherDate),
    warehouseId: text(group.warehouseId), warehouseCode: text(group.warehouseCode), warehouseName: text(group.warehouseName || group.warehouseCode),
    taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', sourceType, contractKind: 'PURCHASE_STAGE3_V1', sourceDocumentKey,
    normalizedOriginVersion: 'PURCHASE_V2', originSystem, originTransactionId, externalDocumentNo,
    purchasePlanId: text(group.purchasePlanId || group.rows?.[0]?.purchasePlanId), sourceRunKey, sourceVoucherIndex, documentSuffix
  };
  const commandSource = {
    commandType: 'POST_PURCHASE', aggregateId: purchaseDocumentId, expectedRevision: 1, commandId, idempotencyKey: commandId,
    actor: text(context.actor || SMARTINPUT_PURCHASE_ACTOR_ID), actorId: text(context.actor || SMARTINPUT_PURCHASE_ACTOR_ID), reason: 'PURCHASE_POST', occurredAt,
    commandContract: 'VOUCHER_CORE_V1', ...document, document, lines
  };
  return { ...document, ...buildFrozenPurchaseIntent(commandSource), lines, commandSource };
}

export function resolvePersistedPurchaseRetry(group = {}, context = {}, aggregate = null) {
  const storedEnvelope = aggregate?.document?.commandEnvelope || null;
  const draft = buildPurchasePostDraft(group, storedEnvelope
    ? { ...context, actor: storedEnvelope.actorId, occurredAt: storedEnvelope.occurredAt }
    : context);
  if (aggregate && storedEnvelope
    && text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) {
    throw new Error('ORDERQ_PURCHASE_DRAFT_IDENTITY_CONFLICT');
  }
  return { draft, envelope: storedEnvelope || draft.commandEnvelope };
}

export async function postPurchaseGroup(group, context = {}) {
  await pullCentralOfficialState();
  const source = derivePurchaseDraftIdentity(group, context);
  const identity = {
    contractKind: source.contractKind, sourceDocumentKey: source.sourceDocumentKey,
    originSystem: source.originSystem, originTransactionId: source.originTransactionId,
    purchasePlanId: source.purchasePlanId, externalDocumentNo: source.externalDocumentNo,
    sourceVoucherIndex: source.sourceVoucherIndex
  };
  const legacyConflict = await findLegacyPurchaseOriginConflict({ purchasePlanId: source.purchasePlanId, legacySourceShortageKey: source.legacySourceShortageKey });
  if (legacyConflict) throw new Error(`ORDERQ_PURCHASE_ORIGIN_DUPLICATE:PURCHASE:LEGACY:${legacyConflict.legacyPurchaseDocumentId}`);
  const existing = await findOfficialPurchaseBySource(identity);
  if (existing && text(existing.purchaseDocumentId) !== text(source.purchaseDocumentId)) throw new Error(`ORDERQ_PURCHASE_ORIGIN_DUPLICATE:${source.sourceDocumentKey}`);
  let aggregate = existing ? await loadOfficialPurchaseAggregate(existing.purchaseDocumentId) : null;
  const retry = resolvePersistedPurchaseRetry(group, context, aggregate);
  const draft = retry.draft;
  if (!aggregate) {
    try { aggregate = await saveOfficialVoucherDraft({ kind: 'PURCHASE', ...draft, purchaseDocumentId: draft.purchaseDocumentId }, context.actor || SMARTINPUT_PURCHASE_ACTOR_ID); }
    catch (error) {
      if (!text(error?.message).startsWith('ORDERQ_OFFICIAL_DRAFT_EXISTS:')) throw error;
      aggregate = await loadOfficialPurchaseAggregate(draft.purchaseDocumentId);
      if (!aggregate || text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) throw new Error('ORDERQ_PURCHASE_DRAFT_IDENTITY_CONFLICT');
    }
  }
  // Retrying a lost response must resend the byte-identical persisted command;
  // wall-clock time and current UI state can never replace this envelope.
  const envelope = aggregate.document?.commandEnvelope || retry.envelope;
  const result = await runCentralOfficialVoucherCommand({
    ...envelope,
    intent: envelope,
    actor: envelope.actorId,
    purchaseDocumentId: draft.purchaseDocumentId,
    document: envelope.document,
    lines: envelope.lines,
    sourceType: envelope.sourceType,
    commandContract: 'VOUCHER_CORE_V1'
  });
  return { ...result, purchaseDocumentId: draft.purchaseDocumentId, commandId: envelope.commandId };
}
