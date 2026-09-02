import {
  beginSaleCommand,
  commitSaleCommand,
  findSaleCommandContext,
  freezeSaleCommandIntent,
  inspectOfficialStocktakeConflicts
} from '../orderq/official-command-adapter.js?v=0.5.0';
import { canonicalSha256, unresolvedProductStableId } from '../orderq/official-voucher-core.js?v=0.24.0';
import {
  createOfficialDocumentIdentityV2,
  createOfficialLineIdentityV2,
  normalizeOfficialBusinessDate,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  preflightOfficialVoucherV2,
  withOfficialCommandIdentityV2
} from '../orderq/official-voucher-v2-contract.js?v=0.5.0';

export const SALE_STAGE4_CAPABILITY = Object.freeze({
  officialPurchaseStage3: 'V1', officialSaleStage4: 'V1', normalizedSaleOriginVersion: 'SALE_V2',
  commandContract: 'VOUCHER_CORE_V1', officialSyncContract: 'ONEAPP_ORDERQ_OFFICIAL_SYNC_V1',
  salesMetaSchema: 'ORDERQ_SALES_META_V1', dbSchemaVersion: '7',
  cutoverMode: 'LOCAL_FIRST_BACKGROUND_SYNC', localRepositoryReady: 'YES'
});
// Cloud-first immutable deployment evidence required before production sale writes.
export const SALE_STAGE4_EXPECTED_DEPLOYMENT = Object.freeze({
  deploymentId: 'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',
  deploymentVersion: '27',
  gitCommit: 'ae120131a3890438ef5fadfa14f3c3905f872e69'
});
export const SMARTINPUT_SALE_ACTOR_ID = 'SMART_INPUT_ADMIN';

const text = value => String(value ?? '').trim();
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function finite(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function won(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }
function revision(value) { return Number(value?.revision ?? value?.masterRevision ?? value?.raw?.revision ?? 0); }
function usesIdentityV2(context = {}) { return text(context.identityVersion) === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2; }

export function evaluateSaleStage4Capability(ping = SALE_STAGE4_CAPABILITY) {
  const mismatch = Object.entries(SALE_STAGE4_CAPABILITY).find(([key, expectedValue]) => text(ping[key]) !== expectedValue);
  return mismatch
    ? { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: mismatch[0] }
    : { ready: true, code: '', authority: 'LOCAL_FIRST' };
}

export async function loadSaleStage4Capability() {
  return evaluateSaleStage4Capability();
}

export function validateSaleGroup(group = {}, masters = {}) {
  const customers = new Map((masters.customers || []).map(row => [text(row.customerId), row]));
  ['salesCustomerId', 'deliveryCustomerId', 'billingCustomerId'].forEach(field => {
    const id = text(group[field]); const customer = customers.get(id);
    if (!customer || text(customer.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || text(customer.qualityStatus).toUpperCase() === 'SUPERSEDED') {
      throw new Error(`ORDERQ_SALE_CUSTOMER_MASTER_INVALID:${id}`);
    }
    if (!(Number(group[field.replace('Id', 'Revision')]) >= revision(customer))) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
  });
  if (!text(group.voucherDate || group.saleDate)) throw new Error('ORDERQ_SALE_DATE_REQUIRED');
  const products = new Map((masters.products || []).map(row => [text(row.productId), row]));
  const warehouses = new Map((masters.warehouses || []).map(row => [text(row.warehouseId), row]));
  const orders = new Map((masters.orders || []).map(row => [text(row.orderId), row]));
  const orderItems = new Map((masters.orderItems || []).map(row => [text(row.orderItemId), row]));
  for (const row of group.rows || []) {
    const productId = text(row.productId);
    const unresolvedProductId = text(row.unresolvedProductId);
    const product = products.get(productId);
    const warehouse = warehouses.get(text(row.warehouseId || group.warehouseId));
    if (!productId && !unresolvedProductId && !text(row.productCode || row.itemCode || row.productName || row.itemName || row.unregisteredProductQuery)) {
      throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_REQUIRED');
    }
    if (productId && unresolvedProductId) throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_CONFLICT');
    if (productId && (!product || product.active === false || text(product.status || 'ACTIVE').toUpperCase() !== 'ACTIVE')) throw new Error('ORDERQ_SALE_PRODUCT_MASTER_INVALID');
    if (!warehouse || warehouse.active === false || text(warehouse.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new Error('ORDERQ_SALE_WAREHOUSE_MASTER_INVALID');
    if ((product && !(Number(row.productMasterRevision) >= revision(product))) || !(Number(row.warehouseMasterRevision) >= revision(warehouse))) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
    const actual = finite(row.actualQuantity ?? row.quantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
    finite(row.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
    const baseFactor = finite(row.actualToBaseFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const mode = text(row.orderLinkMode || group.orderLinkMode || 'DIRECT').toUpperCase();
    const recognizedFactor = mode === 'DIRECT' ? 0 : finite(row.actualToRecognizedFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    if (!(baseFactor > 0) || (mode !== 'DIRECT' && !(recognizedFactor > 0))) throw new Error('ORDERQ_SALE_CONVERSION_REQUIRED');
    if (mode === 'DIRECT') {
      if (text(row.sourceOrderId || row.sourceOrderItemId || row.sourceDispatchId || row.sourceDispatchLineId) || actual * recognizedFactor !== 0) {
        throw new Error('ORDERQ_SALE_DIRECT_ORDER_LINK_FORBIDDEN');
      }
      const actualUnit = text(row.actualUnit || row.unit).toUpperCase();
      if (baseFactor !== 1 || text(row.baseUnit || actualUnit).toUpperCase() !== actualUnit
        || text(row.conversionSource).toUpperCase() !== 'DIRECT_SAME_UNIT'
        || !text(row.conversionRuleVersion)) throw new Error('ORDERQ_SALE_DIRECT_CONVERSION_PROVENANCE_REQUIRED');
    } else {
      const order = orders.get(text(row.sourceOrderId)); const item = orderItems.get(text(row.sourceOrderItemId));
      if (!order || !item || text(item.orderId) !== text(order.orderId) || text(item.productId || item.productCode) !== text(row.productId || row.productCode)) {
        throw new Error('ORDERQ_SALE_ORDER_LINK_INVALID');
      }
      if (text(order.customerId) !== text(group.deliveryCustomerId)) throw new Error('ORDERQ_SALE_DELIVERY_ORDER_CUSTOMER_MISMATCH');
      if (Number(row.sourceOrderRevision) !== revision(order) || Number(row.sourceOrderItemRevision) !== revision(item)) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
      if (!!text(row.sourceDispatchId) !== !!text(row.sourceDispatchLineId)) throw new Error('ORDERQ_SALE_DISPATCH_LINK_INVALID');
    }
  }
  return true;
}

export function deriveSaleDraftIdentity(group = {}, context = {}) {
  const identityV2 = usesIdentityV2(context);
  const sourceType = text(group.sourceType || group.rows?.[0]?.sourceType || 'DIRECT').toUpperCase();
  const originSystem = text(group.originSystem || group.rows?.[0]?.originSystem || context.originSystem).toUpperCase();
  const originTransactionId = text(group.originTransactionId || group.rows?.[0]?.originTransactionId || context.manualSessionId);
  const sourceVoucherIndex = Number(group.sourceVoucherIndex || group.rows?.[0]?.sourceVoucherIndex || 1);
  if (!originSystem || !originTransactionId || !Number.isInteger(sourceVoucherIndex) || sourceVoucherIndex < 1) throw new Error('ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED');
  const saleDate = identityV2 ? normalizeOfficialBusinessDate(group).businessDate : text(group.voucherDate || group.saleDate);
  const sourceDocumentKey = text(group.sourceDocumentKey || group.rows?.[0]?.sourceDocumentKey)
    || `SALE:${canonicalSha256({ contractKind: 'SALE_STAGE4_V1', originSystem, originTransactionId, sourceVoucherIndex,
      billingCustomerId: text(group.billingCustomerId), saleDate, externalDocumentNo: text(group.externalVoucherNo) })}`;
  const voucherGroupKey = text(group.voucherGroupKey);
  const v2Identity = identityV2 ? createOfficialDocumentIdentityV2({
    kind: 'SALE',
    companyId: text(context.companyId || group.companyId),
    voucherGroupKey,
    stableInput: {
      sourceType,
      sourceDocumentKey,
      originSystem,
      originTransactionId,
      externalDocumentNo: text(group.externalVoucherNo),
      sourceVoucherIndex
    }
  }) : null;
  const salesDocumentId = v2Identity?.salesDocumentId
    || `SD-${canonicalSha256(['VOUCHER_CORE_V1', sourceType, sourceDocumentKey]).slice(0, 32)}`;
  return { sourceType, originSystem, originTransactionId, sourceVoucherIndex, sourceDocumentKey,
    externalDocumentNo: text(group.externalVoucherNo), salesDocumentId,
    ...(identityV2 ? { saleDate, voucherGroupKey, ...v2Identity } : {}), contractKind: 'SALE_STAGE4_V1' };
}

export function buildSalePostDraft(group = {}, context = {}) {
  const identityV2 = usesIdentityV2(context);
  const identity = deriveSaleDraftIdentity(group, context);
  const occurredAt = text(context.occurredAt || new Date().toISOString());
  const companyId = text(context.companyId || group.companyId);
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const preflight = identityV2 ? preflightOfficialVoucherV2({
    ...group,
    kind: 'SALE',
    companyId,
    voucherGroupKey: identity.voucherGroupKey,
    warehouseId: group.warehouseId,
    rows: group.rows
  }) : null;
  const sourceRows = preflight?.rows || group.rows || [];
  const lines = sourceRows.map((row, index) => {
    const actualQuantity = finite(row.actualQuantity ?? row.quantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
    const unitPrice = finite(row.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
    const orderLinkMode = text(row.orderLinkMode || group.orderLinkMode || 'DIRECT').toUpperCase();
    const direct = orderLinkMode === 'DIRECT';
    const actualToBaseFactor = identityV2
      ? 1
      : finite(row.actualToBaseFactor ?? (direct ? 1 : undefined), 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const actualToRecognizedFactor = orderLinkMode === 'DIRECT' ? 0 : finite(row.actualToRecognizedFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const actualUnit = text(row.actualUnit || row.unit).toUpperCase();
    const conversionSource = text(row.conversionSource || (direct ? 'DIRECT_SAME_UNIT' : '')).toUpperCase();
    const conversionRuleId = text(row.conversionRuleId || (direct ? 'DIRECT_1_TO_1' : ''));
    const conversionRuleVersion = text(row.conversionRuleVersion || (direct ? 'DIRECT_1_TO_1_V1' : ''));
    if (!identityV2 && direct && (actualToBaseFactor !== 1 || text(row.baseUnit || actualUnit).toUpperCase() !== actualUnit
      || conversionSource !== 'DIRECT_SAME_UNIT' || !conversionRuleVersion)) {
      throw new Error('ORDERQ_SALE_DIRECT_CONVERSION_PROVENANCE_REQUIRED');
    }
    const stableRowKey = text(row.sourceLineKey || row.rowId || row.sourceRowKey || row.sourceFingerprint);
    const sourceLineKey = identityV2
      ? (stableRowKey
        ? `${identity.sourceDocumentKey}:LINE:${stableRowKey}`
        : `${identity.sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey: text(row.sourceRowKey || row.sourceRowNo || index + 1),
          sourceOccurrence: Number(row.sourceOccurrence || 1), productId: text(row.productId || row.productCode), warehouseId: text(row.warehouseId || group.warehouseId),
          sourceOrderId: text(row.sourceOrderId), sourceOrderItemId: text(row.sourceOrderItemId), sourceDispatchId: text(row.sourceDispatchId), sourceDispatchLineId: text(row.sourceDispatchLineId),
          productSnapshot: row.productSnapshot })}`)
      : text(row.sourceLineKey) || `${identity.sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey: text(row.sourceRowKey || index + 1),
        sourceOccurrence: Number(row.sourceOccurrence || 1), productId: text(row.productId || row.productCode), warehouseId: text(row.warehouseId || group.warehouseId),
        sourceOrderId: text(row.sourceOrderId), sourceOrderItemId: text(row.sourceOrderItemId), sourceDispatchId: text(row.sourceDispatchId), sourceDispatchLineId: text(row.sourceDispatchLineId) })}`;
    const calculatedSupplyAmount = won(actualQuantity * unitPrice);
    const supplyAmount = row.supplyAmount ?? row.supplyAmountWon ?? calculatedSupplyAmount;
    const vatAmount = row.vatAmount ?? row.vatAmountWon ?? null;
    const totalAmount = row.totalAmount ?? row.totalAmountWon ?? row.amountWon ?? supplyAmount;
    const officialProductResolution = identityV2 ? row.officialProductResolution : null;
    if (identityV2 && !officialProductResolution) throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_REQUIRED');
    const productId = identityV2
      ? (text(officialProductResolution.status) === 'MATCHED' ? text(officialProductResolution.matchedProductId) : '')
      : text(row.productId);
    const unresolvedProductId = text(row.unresolvedProductId)
      || (!productId ? unresolvedProductStableId(companyId, row) : '');
    const productSnapshot = identityV2 ? {
      ...row.productSnapshot,
      matchEvidence: {
        ...row.productSnapshot.matchEvidence,
        status: text(row.matchStatus || row.productIdentityStatus || (productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT')).toUpperCase(),
        source: text(row.matchSource || row.referenceResolution),
        productId,
        unresolvedProductId,
        productMasterRevision: Number(row.productMasterRevision || 0),
        referenceSnapshotId: text(row.referenceSnapshotId || row.productSnapshotId),
        officialProductResolution
      }
    } : null;
    const lineIdentity = identityV2 ? createOfficialLineIdentityV2({
      kind: 'SALE', companyId, documentId: identity.salesDocumentId,
      voucherGroupKey: identity.voucherGroupKey, sourceLineKey
    }) : null;
    const salesLineId = lineIdentity?.salesLineId
      || text(row.salesLineId) || `SL-${canonicalSha256([identity.salesDocumentId, sourceLineKey]).slice(0, 32)}`;
    return { ...row, ...(identityV2 ? { ...lineIdentity, salesDocumentId: identity.salesDocumentId,
      companyId, voucherGroupKey: identity.voucherGroupKey } : {}), salesLineId,
      sourceLineKey, lineIdentityId: identityV2 ? salesLineId : text(row.lineIdentityId) || `LI-${canonicalSha256([identity.salesDocumentId, sourceLineKey]).slice(0, 32)}`,
      lineSequence: index + 1, actualQuantity, actualUnit,
      ...(identityV2 ? { unit: productSnapshot.unit } : {}),
      actualToBaseFactor,
      baseQuantity: identityV2 ? actualQuantity : actualQuantity * actualToBaseFactor,
      baseUnit: text(row.baseUnit || row.unit).toUpperCase(),
      actualToRecognizedFactor, recognizedOrderQuantity: orderLinkMode === 'DIRECT' ? 0 : actualQuantity * actualToRecognizedFactor,
      recognizedUnit: text(row.recognizedUnit || row.unit).toUpperCase(), unitPrice,
      productId, unresolvedProductId,
      ...(identityV2 ? {
        productCode: productSnapshot.productCode,
        productName: productSnapshot.productName,
        originalProductCode: productSnapshot.originalProductCode,
        originalProductName: productSnapshot.originalProductName,
        matchStatus: text(row.matchStatus || row.productIdentityStatus || (productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT')).toUpperCase(),
        matchSource: text(row.matchSource || row.referenceResolution),
        officialProductResolution,
        inventoryEffectFactor: 1,
        productSnapshot
      } : {}),
      supplyAmount, vatAmount, totalAmount: identityV2 ? productSnapshot.amount : totalAmount,
      taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', orderLinkMode, conversionSource, conversionRuleId, conversionRuleVersion };
  });
  const commandId = `POST_SALE:${canonicalSha256({ salesDocumentId: identity.salesDocumentId, sourceDocumentKey: identity.sourceDocumentKey, lines: lines.map(row => row.sourceLineKey) })}`;
  const document = { companyId, ...identity, salesCustomerId: text(group.salesCustomerId), salesCustomerCode: text(group.salesCustomerCode),
    salesCustomerName: text(group.salesCustomerName),
    salesCustomerRevision: identityV2 ? Number(group.salesCustomerRevision || 0) : finite(group.salesCustomerRevision ?? group.rows?.[0]?.salesCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'),
    deliveryCustomerId: text(group.deliveryCustomerId), deliveryCustomerCode: text(group.deliveryCustomerCode),
    deliveryCustomerName: text(group.deliveryCustomerName),
    deliveryCustomerRevision: identityV2 ? Number(group.deliveryCustomerRevision || 0) : finite(group.deliveryCustomerRevision ?? group.rows?.[0]?.deliveryCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'),
    billingCustomerId: text(group.billingCustomerId), billingCustomerCode: text(group.billingCustomerCode),
    billingCustomerName: text(group.billingCustomerName),
    billingCustomerRevision: identityV2 ? Number(group.billingCustomerRevision || 0) : finite(group.billingCustomerRevision ?? group.rows?.[0]?.billingCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'),
    saleDate: identityV2 ? preflight.businessDate : text(group.voucherDate || group.saleDate),
    warehouseId: text(group.warehouseId), warehouseCode: text(group.warehouseCode), taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW',
    normalizedOriginVersion: 'SALE_V2',
    ...(identityV2 ? {
      businessDate: preflight.businessDate,
      businessDateDayDefaulted: preflight.dayDefaulted,
      ...(text(group.businessOccurredAt) ? { businessOccurredAt: text(group.businessOccurredAt) } : {}),
      officialPartnerResolution: group.officialPartnerResolution
    } : {}) };
  const commandBase = { ...document, document, lines, commandType: 'POST_SALE', aggregateId: identity.salesDocumentId,
    expectedRevision: 1, commandId, idempotencyKey: commandId, actor: text(context.actor || SMARTINPUT_SALE_ACTOR_ID),
    actorId: text(context.actor || SMARTINPUT_SALE_ACTOR_ID), reason: 'SALE_POST', occurredAt,
    ...(identityV2 && Array.isArray(context.stocktakeDecisions) && context.stocktakeDecisions.length
      ? { stocktakeDecisions: copy(context.stocktakeDecisions) }
      : {}) };
  const commandSource = identityV2 ? withOfficialCommandIdentityV2(commandBase) : commandBase;
  return { ...document, ...freezeSaleCommandIntent(commandSource), lines, commandSource };
}

export async function inspectSaleGroupStocktake(group = {}, context = {}) {
  const draft = buildSalePostDraft(group, context);
  return inspectOfficialStocktakeConflicts({ kind: 'SALE', ...draft });
}

export async function postSaleGroup(group, context = {}) {
  if (context.masters) validateSaleGroup(group, context.masters);
  const identity = deriveSaleDraftIdentity(group, context);
  const commandContext = await findSaleCommandContext({ ...identity, companyId: text(context.companyId || group.companyId),
    ...(identity.identityVersion ? { identityVersion: identity.identityVersion, voucherGroupKey: identity.voucherGroupKey } : {}) });
  let aggregate = commandContext.aggregate;
  const storedEnvelope = aggregate?.document?.commandEnvelope || null;
  const draft = buildSalePostDraft(group, storedEnvelope ? {
    ...context,
    occurredAt: storedEnvelope.occurredAt,
    actor: storedEnvelope.actorId,
    stocktakeDecisions: storedEnvelope.stocktakeDecisions
  } : context);
  if (aggregate && storedEnvelope && text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) throw new Error('ORDERQ_SALE_DRAFT_IDENTITY_CONFLICT');
  if (!aggregate) aggregate = await beginSaleCommand(draft, context.actor || SMARTINPUT_SALE_ACTOR_ID);
  const envelope = aggregate.document?.commandEnvelope || draft.commandEnvelope;
  const result = await commitSaleCommand({ ...envelope, intent: envelope, actor: envelope.actorId,
    salesDocumentId: draft.salesDocumentId, document: envelope.document, lines: envelope.lines, commandContract: 'VOUCHER_CORE_V1' });
  return { ...result, salesDocumentId: draft.salesDocumentId, commandId: envelope.commandId };
}
