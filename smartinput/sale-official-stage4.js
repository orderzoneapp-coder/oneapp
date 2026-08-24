import { pingCentralAuthority } from '../orderq/orderq-cloud-adapter.js?v=0.10.0';
import {
  buildFrozenSaleIntent,
  findOfficialSaleBySource,
  loadOfficialSaleAggregate,
  runCentralOfficialVoucherCommand,
  saveOfficialVoucherDraft
} from '../orderq/official-voucher-repository.js?v=0.19.0';
import { canonicalSha256 } from '../orderq/official-voucher-core.js?v=0.19.0';
import { pullCentralOfficialState } from '../orderq/central-command-gateway.js?v=0.18.0';

export const SALE_STAGE4_CAPABILITY = Object.freeze({
  officialPurchaseStage3: 'V1', officialSaleStage4: 'V1', normalizedSaleOriginVersion: 'SALE_V2',
  commandContract: 'VOUCHER_CORE_V1', salesMetaSchema: 'ORDERQ_SALES_META_V1', dbSchemaVersion: '14',
  cutoverMode: 'VNEXT_PRIMARY'
});
// Immutable deployment evidence is intentionally blank until the Cloud-first
// release commit. Production sale writes therefore remain disabled.
export const SALE_STAGE4_EXPECTED_DEPLOYMENT = Object.freeze({ deploymentId: '', deploymentVersion: '', gitCommit: '' });
export const SMARTINPUT_SALE_ACTOR_ID = 'SMART_INPUT_ADMIN';

const text = value => String(value ?? '').trim();
function finite(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function won(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }
function revision(value) { return Number(value?.revision ?? value?.masterRevision ?? value?.raw?.revision ?? 0); }

export function evaluateSaleStage4Capability(ping = {}, expected = SALE_STAGE4_EXPECTED_DEPLOYMENT) {
  const mismatch = Object.entries(SALE_STAGE4_CAPABILITY).find(([key, expectedValue]) => text(ping[key]) !== expectedValue);
  const deploymentReady = ['deploymentId', 'deploymentVersion', 'gitCommit'].every(key => text(expected[key]) && text(ping[key]) === text(expected[key]));
  return mismatch || !deploymentReady
    ? { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: mismatch?.[0] || 'deploymentEvidence' }
    : { ready: true, code: '', deploymentId: text(ping.deploymentId), deploymentVersion: text(ping.deploymentVersion), gitCommit: text(ping.gitCommit) };
}

export async function loadSaleStage4Capability() {
  try { return evaluateSaleStage4Capability(await pingCentralAuthority()); }
  catch (error) { return { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: text(error?.message || error) }; }
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
    const product = products.get(text(row.productId));
    const warehouse = warehouses.get(text(row.warehouseId || group.warehouseId));
    if (!product || product.active === false || text(product.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new Error('ORDERQ_SALE_PRODUCT_MASTER_INVALID');
    if (!warehouse || warehouse.active === false || text(warehouse.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new Error('ORDERQ_SALE_WAREHOUSE_MASTER_INVALID');
    if (!(Number(row.productMasterRevision) >= revision(product)) || !(Number(row.warehouseMasterRevision) >= revision(warehouse))) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
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
  const sourceType = text(group.sourceType || group.rows?.[0]?.sourceType || 'DIRECT').toUpperCase();
  const originSystem = text(group.originSystem || group.rows?.[0]?.originSystem || context.originSystem || 'SMARTINPUT_MANUAL').toUpperCase();
  const originTransactionId = text(group.originTransactionId || group.rows?.[0]?.originTransactionId || context.manualSessionId);
  const sourceVoucherIndex = Number(group.sourceVoucherIndex || group.rows?.[0]?.sourceVoucherIndex || 1);
  const sourceDocumentKey = text(group.sourceDocumentKey || group.rows?.[0]?.sourceDocumentKey)
    || `SALE:${canonicalSha256({ contractKind: 'SALE_STAGE4_V1', originSystem, originTransactionId, sourceVoucherIndex,
      billingCustomerId: text(group.billingCustomerId), saleDate: text(group.voucherDate || group.saleDate), externalDocumentNo: text(group.externalVoucherNo) })}`;
  const salesDocumentId = `SD-${canonicalSha256(['VOUCHER_CORE_V1', sourceType, sourceDocumentKey]).slice(0, 32)}`;
  return { sourceType, originSystem, originTransactionId, sourceVoucherIndex, sourceDocumentKey,
    externalDocumentNo: text(group.externalVoucherNo), salesDocumentId, contractKind: 'SALE_STAGE4_V1' };
}

export function buildSalePostDraft(group = {}, context = {}) {
  const identity = deriveSaleDraftIdentity(group, context);
  const occurredAt = text(context.occurredAt || new Date().toISOString());
  const lines = (group.rows || []).map((row, index) => {
    const actualQuantity = finite(row.actualQuantity ?? row.quantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
    const unitPrice = finite(row.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
    const actualToBaseFactor = finite(row.actualToBaseFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const orderLinkMode = text(row.orderLinkMode || group.orderLinkMode || 'DIRECT').toUpperCase();
    const actualToRecognizedFactor = orderLinkMode === 'DIRECT' ? 0 : finite(row.actualToRecognizedFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const sourceLineKey = text(row.sourceLineKey) || `${identity.sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey: text(row.sourceRowKey || index + 1),
      sourceOccurrence: Number(row.sourceOccurrence || 1), productId: text(row.productId || row.productCode), warehouseId: text(row.warehouseId || group.warehouseId),
      sourceOrderId: text(row.sourceOrderId), sourceOrderItemId: text(row.sourceOrderItemId), sourceDispatchId: text(row.sourceDispatchId), sourceDispatchLineId: text(row.sourceDispatchLineId) })}`;
    const supplyAmount = won(actualQuantity * unitPrice);
    return { ...row, sourceLineKey, lineIdentityId: text(row.lineIdentityId) || `LI-${canonicalSha256([identity.salesDocumentId, sourceLineKey]).slice(0, 32)}`,
      lineSequence: index + 1, actualQuantity, actualUnit: text(row.actualUnit || row.unit).toUpperCase(), actualToBaseFactor,
      baseQuantity: actualQuantity * actualToBaseFactor, baseUnit: text(row.baseUnit || row.unit).toUpperCase(),
      actualToRecognizedFactor, recognizedOrderQuantity: orderLinkMode === 'DIRECT' ? 0 : actualQuantity * actualToRecognizedFactor,
      recognizedUnit: text(row.recognizedUnit || row.unit).toUpperCase(), unitPrice, supplyAmount, totalAmount: supplyAmount,
      taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', orderLinkMode };
  });
  const commandId = `POST_SALE:${canonicalSha256({ salesDocumentId: identity.salesDocumentId, sourceDocumentKey: identity.sourceDocumentKey, lines: lines.map(row => row.sourceLineKey) })}`;
  const document = { ...identity, salesCustomerId: text(group.salesCustomerId), salesCustomerName: text(group.salesCustomerName),
    salesCustomerRevision: finite(group.salesCustomerRevision ?? group.rows?.[0]?.salesCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'), deliveryCustomerId: text(group.deliveryCustomerId),
    deliveryCustomerRevision: finite(group.deliveryCustomerRevision ?? group.rows?.[0]?.deliveryCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'), billingCustomerId: text(group.billingCustomerId),
    billingCustomerRevision: finite(group.billingCustomerRevision ?? group.rows?.[0]?.billingCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'), saleDate: text(group.voucherDate || group.saleDate),
    warehouseId: text(group.warehouseId), warehouseCode: text(group.warehouseCode), taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW',
    normalizedOriginVersion: 'SALE_V2' };
  const commandSource = { ...document, document, lines, commandType: 'POST_SALE', aggregateId: identity.salesDocumentId,
    expectedRevision: 1, commandId, idempotencyKey: commandId, actor: text(context.actor || SMARTINPUT_SALE_ACTOR_ID),
    actorId: text(context.actor || SMARTINPUT_SALE_ACTOR_ID), reason: 'SALE_POST', occurredAt };
  return { ...document, ...buildFrozenSaleIntent(commandSource), lines, commandSource };
}

export async function postSaleGroup(group, context = {}) {
  await pullCentralOfficialState();
  const identity = deriveSaleDraftIdentity(group, context);
  const existing = await findOfficialSaleBySource(identity);
  let aggregate = existing ? await loadOfficialSaleAggregate(existing.salesDocumentId) : null;
  const storedEnvelope = aggregate?.document?.commandEnvelope || null;
  const draft = buildSalePostDraft(group, storedEnvelope ? { ...context, occurredAt: storedEnvelope.occurredAt, actor: storedEnvelope.actorId } : context);
  if (aggregate && storedEnvelope && text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) throw new Error('ORDERQ_SALE_DRAFT_IDENTITY_CONFLICT');
  if (!aggregate) aggregate = await saveOfficialVoucherDraft({ kind: 'SALE', ...draft, salesDocumentId: draft.salesDocumentId }, context.actor || SMARTINPUT_SALE_ACTOR_ID);
  const envelope = aggregate.document?.commandEnvelope || draft.commandEnvelope;
  const result = await runCentralOfficialVoucherCommand({ ...envelope, intent: envelope, actor: envelope.actorId,
    salesDocumentId: draft.salesDocumentId, document: envelope.document, lines: envelope.lines, commandContract: 'VOUCHER_CORE_V1' });
  return { ...result, salesDocumentId: draft.salesDocumentId, commandId: envelope.commandId };
}
