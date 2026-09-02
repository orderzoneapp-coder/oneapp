import { canonicalSha256, voucherStableId } from './official-voucher-core.js?v=0.23.0';

const text = value => String(value ?? '').trim();
const clone = value => JSON.parse(JSON.stringify(value));

function required(value, code) {
  const result = text(value);
  if (!result) throw new Error(code);
  return result;
}

function effectiveTime(value) {
  const source = required(value, 'ORDERQ_INVENTORY_EFFECTIVE_AT_REQUIRED');
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(source) ? Date.parse(`${source}T23:59:59.999Z`) : Date.parse(source);
  if (!Number.isFinite(timestamp)) throw new Error('ORDERQ_INVENTORY_EFFECTIVE_AT_INVALID');
  return timestamp;
}

function checkpointCoversProduct(checkpoint, productId) {
  if (checkpoint.coversAllProducts === true) return true;
  return (checkpoint.counts || []).some(line => text(line.productId) === productId);
}

function latestCheckpoint(effect, productId, checkpoints) {
  return checkpoints
    .filter(checkpoint => checkpoint.status === 'CONFIRMED'
      && checkpoint.companyId === effect.companyId
      && checkpoint.warehouseId === effect.warehouseId
      && checkpointCoversProduct(checkpoint, productId))
    .sort((left, right) => effectiveTime(right.effectiveAt) - effectiveTime(left.effectiveAt))[0] || null;
}

export function createInventoryCheckpoint(source = {}) {
  const companyId = required(source.companyId, 'ORDERQ_CHECKPOINT_COMPANY_REQUIRED');
  const warehouseId = required(source.warehouseId, 'ORDERQ_CHECKPOINT_WAREHOUSE_REQUIRED');
  const sessionId = required(source.sessionId, 'ORDERQ_CHECKPOINT_SESSION_REQUIRED');
  const effectiveAt = required(source.effectiveAt, 'ORDERQ_CHECKPOINT_EFFECTIVE_AT_REQUIRED');
  effectiveTime(effectiveAt);
  const counts = (Array.isArray(source.counts) ? source.counts : []).map(line => {
    const productId = text(line.productId);
    const productCode = String(line.productCode ?? line.itemCode ?? '').trim();
    if (!productId && !productCode) throw new Error('ORDERQ_CHECKPOINT_PRODUCT_REQUIRED');
    return {
      productId,
      ...(productCode ? { productCode } : {}),
      quantity: Number(line.quantity)
    };
  });
  if (counts.some(line => !Number.isFinite(line.quantity))) throw new Error('ORDERQ_CHECKPOINT_QUANTITY_INVALID');
  return {
    checkpointId: text(source.checkpointId) || voucherStableId('ICP', companyId, warehouseId, sessionId),
    sessionId,
    companyId,
    warehouseId,
    effectiveAt,
    status: 'CONFIRMED',
    coversAllProducts: source.coversAllProducts !== false,
    counts,
    actor: required(source.actor, 'ORDERQ_CHECKPOINT_ACTOR_REQUIRED'),
    confirmedAt: required(source.confirmedAt || source.occurredAt, 'ORDERQ_CHECKPOINT_CONFIRMED_AT_REQUIRED')
  };
}

export function planPendingInventoryResolution(source = {}) {
  const companyId = required(source.companyId, 'ORDERQ_REMATCH_COMPANY_REQUIRED');
  const unresolvedProductId = required(source.unresolvedProductId, 'ORDERQ_REMATCH_UNRESOLVED_PRODUCT_REQUIRED');
  const productId = required(source.productId, 'ORDERQ_REMATCH_PRODUCT_REQUIRED');
  const actor = required(source.actor, 'ORDERQ_REMATCH_ACTOR_REQUIRED');
  const occurredAt = required(source.occurredAt, 'ORDERQ_REMATCH_OCCURRED_AT_REQUIRED');
  const resolutionId = text(source.resolutionId) || voucherStableId('IPR', companyId, unresolvedProductId, productId);
  const effects = (Array.isArray(source.pendingEffects) ? source.pendingEffects : [])
    .filter(effect => effect.companyId === companyId
      && effect.unresolvedProductId === unresolvedProductId
      && effect.status === 'PENDING_PRODUCT_MATCH');
  const checkpoints = Array.isArray(source.inventoryCheckpoints) ? source.inventoryCheckpoints : [];
  const inventoryMovements = [];
  const resolvedEffects = effects.map((effect, index) => {
    const checkpoint = latestCheckpoint(effect, productId, checkpoints);
    const beforeOrAtCheckpoint = checkpoint && effectiveTime(effect.effectiveAt) <= effectiveTime(checkpoint.effectiveAt);
    if (!beforeOrAtCheckpoint) {
      inventoryMovements.push({
        movementId: voucherStableId('IMR', resolutionId, effect.pendingEffectId, index + 1),
        companyId,
        warehouseId: effect.warehouseId,
        productId,
        sourceDocumentId: effect.sourceDocumentId,
        sourceLineId: effect.sourceLineId,
        sourceDocumentRevision: effect.sourceDocumentRevision,
        voucherMode: effect.voucherMode,
        movementType: 'PENDING_PRODUCT_MATCH_RESOLVED',
        signedQuantity: Number(effect.signedQuantity),
        effectiveAt: effect.effectiveAt,
        occurredAt,
        actor,
        resolutionId,
        pendingEffectId: effect.pendingEffectId
      });
    }
    return {
      ...clone(effect),
      productId,
      status: beforeOrAtCheckpoint ? 'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE' : 'RESOLVED_TO_INVENTORY',
      checkpointId: checkpoint?.checkpointId || '',
      resolutionId,
      resolvedAt: occurredAt,
      resolvedBy: actor
    };
  });
  const productResolution = {
    unresolvedProductId,
    companyId,
    productId,
    status: 'MATCHED',
    resolutionId,
    resolvedAt: occurredAt,
    resolvedBy: actor
  };
  const result = {
    schemaVersion: 'ONEAPP_PENDING_INVENTORY_RESOLUTION_V1',
    resolutionId,
    companyId,
    unresolvedProductId,
    productId,
    resolvedEffects,
    inventoryMovements,
    productResolution,
    occurredAt,
    actor
  };
  result.digest = canonicalSha256(result);
  return result;
}
