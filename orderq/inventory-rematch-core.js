import { canonicalSha256, voucherStableId } from './official-voucher-core.js?v=0.24.0';
import {
  OFFICIAL_STOCKTAKE_DECISION,
  OFFICIAL_STOCKTAKE_EFFECT_STATUS
} from './stocktake-conflict-v2.js?v=0.2.0';

export const INVENTORY_REMATCH_COMMAND_SCHEMA_V2 = 'ONEAPP_ORDERQ_INVENTORY_REMATCH_COMMAND_V2';
export const INVENTORY_REMATCH_IDENTITY_VERSION_V2 = 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2';
export const INVENTORY_REMATCH_COMMAND_TYPE_V2 = 'RESOLVE_INVENTORY_REMATCH';
export const INVENTORY_REMATCH_SELECTION_MODE_V2 = 'EXPLICIT_USER_SELECTION';
export const INVENTORY_REMATCH_AUDIT_SCHEMA_V2 = 'ONEAPP_ORDERQ_INVENTORY_REMATCH_AUDIT_V2';

const text = value => String(value ?? '').trim();
const clone = value => JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function required(value, code) {
  const result = text(value);
  if (!result) throw new Error(code);
  return result;
}

function calendarDate(value, code, allowTimestamp = false) {
  const source = required(value, code);
  const expression = allowTimestamp
    ? /^(\d{4})-(\d{2})-(\d{2})(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/
    : /^(\d{4})-(\d{2})-(\d{2})$/;
  const matched = source.match(expression);
  if (!matched) throw new Error(code);
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(code);
  }
  if (source.length > 10 && !Number.isFinite(Date.parse(source))) throw new Error(code);
  return source;
}

function strictTimestamp(value, code) {
  const timestamp = required(value, code);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) throw new Error(code);
  calendarDate(timestamp, code, true);
  return timestamp;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(code);
  return number;
}

function productIdentity(source = {}) {
  return {
    productId: required(source.productId || source.masterProductId, 'ORDERQ_REMATCH_V2_PRODUCT_ID_REQUIRED'),
    companyId: required(source.companyId, 'ORDERQ_REMATCH_V2_PRODUCT_COMPANY_REQUIRED'),
    productCode: required(source.productCode || source.itemCode || source['코드'] || source['품목코드'],
      'ORDERQ_REMATCH_V2_PRODUCT_CODE_REQUIRED'),
    productName: text(source.productName || source.itemName || source['품목명'] || source.name),
    specification: text(source.specification || source['규격']),
    unit: text(source.unit || source.finalUnit || source.actualUnit || source['단위'])
  };
}

function snapshotIdentity(source = {}) {
  return {
    schemaVersion: required(source.schemaVersion, 'ORDERQ_REMATCH_V2_PRODUCT_SNAPSHOT_SCHEMA_REQUIRED'),
    snapshotId: required(source.snapshotId, 'ORDERQ_REMATCH_V2_PRODUCT_SNAPSHOT_ID_REQUIRED'),
    revision: source.revision === null || source.revision === undefined ? null : text(source.revision),
    contentHash: required(source.contentHash, 'ORDERQ_REMATCH_V2_PRODUCT_SNAPSHOT_HASH_REQUIRED')
  };
}

function expectedDocument(source = {}) {
  const voucherMode = required(source.voucherMode, 'ORDERQ_REMATCH_V2_EXPECTED_DOCUMENT_MODE_REQUIRED').toLowerCase();
  if (!['purchase', 'sale'].includes(voucherMode)) throw new Error('ORDERQ_REMATCH_V2_EXPECTED_DOCUMENT_MODE_INVALID');
  return {
    voucherMode,
    documentId: required(source.documentId || source.sourceDocumentId,
      'ORDERQ_REMATCH_V2_EXPECTED_DOCUMENT_ID_REQUIRED'),
    revision: positiveInteger(source.revision ?? source.documentRevision,
      'ORDERQ_REMATCH_V2_EXPECTED_DOCUMENT_REVISION_INVALID'),
    voucherRevisionId: required(source.voucherRevisionId || source.revisionId,
      'ORDERQ_REMATCH_V2_EXPECTED_VOUCHER_REVISION_ID_REQUIRED')
  };
}

function expectedEffect(source = {}) {
  const document = expectedDocument({
    voucherMode: source.voucherMode,
    documentId: source.documentId || source.sourceDocumentId,
    revision: source.documentRevision ?? source.sourceDocumentRevision,
    voucherRevisionId: source.voucherRevisionId
  });
  return {
    pendingEffectId: required(source.pendingEffectId, 'ORDERQ_REMATCH_V2_EXPECTED_EFFECT_ID_REQUIRED'),
    voucherMode: document.voucherMode,
    documentId: document.documentId,
    lineId: required(source.lineId || source.sourceLineId, 'ORDERQ_REMATCH_V2_EXPECTED_LINE_ID_REQUIRED'),
    documentRevision: document.revision,
    voucherRevisionId: document.voucherRevisionId
  };
}

function stocktakeDecision(source = {}) {
  const decisionType = required(source.decisionType, 'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_TYPE_REQUIRED').toUpperCase();
  if (![OFFICIAL_STOCKTAKE_DECISION.INCLUDED, OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED].includes(decisionType)) {
    throw new Error('ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_TYPE_INVALID');
  }
  const checkpointEffectiveAt = calendarDate(source.checkpointEffectiveAt,
    'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_CHECKPOINT_DATE_REQUIRED', true);
  const targetBusinessDate = calendarDate(source.targetBusinessDate,
    'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_TARGET_DATE_REQUIRED');
  return {
    pendingEffectId: required(source.pendingEffectId, 'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_EFFECT_REQUIRED'),
    decisionType,
    checkpointId: required(source.checkpointId, 'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_CHECKPOINT_REQUIRED'),
    checkpointEffectiveAt,
    targetBusinessDate,
    actor: required(source.actor, 'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_ACTOR_REQUIRED'),
    judgedAt: strictTimestamp(source.judgedAt, 'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_JUDGED_AT_INVALID')
  };
}

function compareDocument(left, right) {
  return left.voucherMode.localeCompare(right.voucherMode)
    || left.documentId.localeCompare(right.documentId)
    || left.revision - right.revision
    || left.voucherRevisionId.localeCompare(right.voucherRevisionId);
}

function compareEffect(left, right) {
  return left.pendingEffectId.localeCompare(right.pendingEffectId);
}

function uniqueRows(rows, key, code) {
  const seen = new Set();
  rows.forEach(row => {
    const value = key(row);
    if (seen.has(value)) throw new Error(code);
    seen.add(value);
  });
  return rows;
}

function canonicalCommandPayload(command = {}) {
  const payload = clone(command);
  delete payload.commandId;
  delete payload.idempotencyKey;
  delete payload.commandPayloadDigest;
  return payload;
}

export function inventoryRematchCommandDigestV2(command = {}) {
  return canonicalSha256(canonicalCommandPayload(command));
}

export function buildInventoryRematchCommandV2(source = {}) {
  const companyId = required(source.companyId, 'ORDERQ_REMATCH_V2_COMPANY_REQUIRED');
  const actor = required(source.actor, 'ORDERQ_REMATCH_V2_ACTOR_REQUIRED');
  const occurredAt = strictTimestamp(source.occurredAt, 'ORDERQ_REMATCH_V2_OCCURRED_AT_INVALID');
  const judgedAt = strictTimestamp(source.judgedAt, 'ORDERQ_REMATCH_V2_JUDGED_AT_INVALID');
  const selectedProduct = productIdentity(source.selectedProduct || {});
  if (selectedProduct.companyId !== companyId) throw new Error('ORDERQ_REMATCH_V2_PRODUCT_COMPANY_MISMATCH');
  const evidenceSource = source.selectionEvidence || {};
  const selectionEvidence = {
    selectionMode: text(evidenceSource.selectionMode || INVENTORY_REMATCH_SELECTION_MODE_V2),
    automaticConfirmation: evidenceSource.automaticConfirmation,
    selectedBy: required(evidenceSource.selectedBy || actor, 'ORDERQ_REMATCH_V2_SELECTED_BY_REQUIRED'),
    selectedAt: strictTimestamp(evidenceSource.selectedAt || judgedAt, 'ORDERQ_REMATCH_V2_SELECTED_AT_INVALID'),
    productSnapshot: snapshotIdentity(evidenceSource.productSnapshot || source.productSnapshot || {})
  };
  if (selectionEvidence.selectionMode !== INVENTORY_REMATCH_SELECTION_MODE_V2
    || selectionEvidence.automaticConfirmation !== false) {
    throw new Error('ORDERQ_REMATCH_V2_EXPLICIT_SELECTION_REQUIRED');
  }
  if (selectionEvidence.selectedBy !== actor) throw new Error('ORDERQ_REMATCH_V2_SELECTION_ACTOR_MISMATCH');

  const expectedDocuments = uniqueRows((source.expectedDocuments || []).map(expectedDocument).sort(compareDocument),
    row => `${row.voucherMode}:${row.documentId}`, 'ORDERQ_REMATCH_V2_EXPECTED_DOCUMENT_DUPLICATE');
  const expectedEffects = uniqueRows((source.expectedEffects || []).map(expectedEffect).sort(compareEffect),
    row => row.pendingEffectId, 'ORDERQ_REMATCH_V2_EXPECTED_EFFECT_DUPLICATE');
  if (!expectedDocuments.length) throw new Error('ORDERQ_REMATCH_V2_EXPECTED_DOCUMENTS_REQUIRED');
  if (!expectedEffects.length) throw new Error('ORDERQ_REMATCH_V2_EXPECTED_EFFECTS_REQUIRED');
  const stocktakeDecisions = uniqueRows((source.stocktakeDecisions || []).map(stocktakeDecision).sort(compareEffect),
    row => row.pendingEffectId, 'ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_DUPLICATE');
  stocktakeDecisions.forEach(decision => {
    if (decision.actor !== actor || decision.judgedAt !== judgedAt) {
      throw new Error('ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_AUDIT_MISMATCH');
    }
  });

  const command = {
    schemaVersion: INVENTORY_REMATCH_COMMAND_SCHEMA_V2,
    identityVersion: INVENTORY_REMATCH_IDENTITY_VERSION_V2,
    entityType: 'INVENTORY_REMATCH_COMMAND',
    commandType: INVENTORY_REMATCH_COMMAND_TYPE_V2,
    companyId,
    unresolvedProductId: required(source.unresolvedProductId, 'ORDERQ_REMATCH_V2_UNRESOLVED_PRODUCT_REQUIRED'),
    selectedProduct,
    selectionEvidence,
    expectedDocuments,
    expectedEffects,
    stocktakeDecisions,
    actor,
    occurredAt,
    judgedAt
  };
  const commandPayloadDigest = inventoryRematchCommandDigestV2(command);
  const deterministicCommandId = voucherStableId('IRC', companyId, command.unresolvedProductId, commandPayloadDigest);
  command.commandId = text(source.commandId) || deterministicCommandId;
  command.idempotencyKey = text(source.idempotencyKey) || command.commandId;
  command.commandPayloadDigest = commandPayloadDigest;
  if (command.commandId !== deterministicCommandId || command.idempotencyKey !== command.commandId) {
    throw new Error('ORDERQ_REMATCH_V2_COMMAND_ID_INVALID');
  }
  return deepFreeze(command);
}

export function assertInventoryRematchCommandV2(source = {}) {
  const command = clone(source.intent || source.command || source);
  if (text(command.schemaVersion) !== INVENTORY_REMATCH_COMMAND_SCHEMA_V2
    || text(command.identityVersion) !== INVENTORY_REMATCH_IDENTITY_VERSION_V2
    || text(command.entityType) !== 'INVENTORY_REMATCH_COMMAND'
    || text(command.commandType) !== INVENTORY_REMATCH_COMMAND_TYPE_V2) {
    throw new Error('ORDERQ_REMATCH_V2_COMMAND_SCHEMA_INVALID');
  }
  const rebuilt = buildInventoryRematchCommandV2(command);
  if (rebuilt.commandPayloadDigest !== text(command.commandPayloadDigest)) {
    throw new Error('ORDERQ_REMATCH_V2_COMMAND_PAYLOAD_DIGEST_INVALID');
  }
  return deepFreeze({ command: rebuilt, payloadDigest: rebuilt.commandPayloadDigest });
}

function impactDecisionEvidence(impact = {}) {
  return {
    checkpointId: text(impact.checkpoint?.checkpointId),
    checkpointEffectiveAt: text(impact.checkpoint?.effectiveAt || impact.checkpoint?.businessDate),
    targetBusinessDate: text(impact.businessDate)
  };
}

export function planInventoryRematchCommandV2({ command: sourceCommand = {}, preview = {} } = {}) {
  const { command } = assertInventoryRematchCommandV2(sourceCommand);
  if (text(preview.companyId) !== command.companyId
    || text(preview.unresolvedProductId) !== command.unresolvedProductId
    || text(preview.targetProduct?.productId) !== command.selectedProduct.productId
    || text(preview.targetProduct?.productCode) !== command.selectedProduct.productCode) {
    throw new Error('ORDERQ_REMATCH_V2_PREVIEW_SCOPE_MISMATCH');
  }
  if (!Array.isArray(preview.impacts) || !preview.impacts.length
    || preview.impacts.some(impact => text(impact.status) === 'REVIEW_REQUIRED')) {
    throw new Error('ORDERQ_REMATCH_V2_LINK_INTEGRITY_REQUIRED');
  }
  const decisionByEffect = new Map(command.stocktakeDecisions.map(row => [row.pendingEffectId, row]));
  const requiredDecisionIds = preview.impacts
    .filter(impact => text(impact.status) === 'DECISION_REQUIRED')
    .map(impact => text(impact.pendingEffectId));
  if (requiredDecisionIds.length !== command.stocktakeDecisions.length
    || requiredDecisionIds.some(id => !decisionByEffect.has(id))) {
    throw new Error('ORDERQ_REMATCH_V2_STOCKTAKE_DECISIONS_INCOMPLETE');
  }

  const resolutionId = voucherStableId('IPR2', command.companyId, command.unresolvedProductId, command.commandId);
  const inventoryMovements = preview.impacts.map((impact, index) => {
    const decision = decisionByEffect.get(text(impact.pendingEffectId));
    if (decision) {
      const currentEvidence = impactDecisionEvidence(impact);
      if (decision.checkpointId !== currentEvidence.checkpointId
        || decision.checkpointEffectiveAt !== currentEvidence.checkpointEffectiveAt
        || decision.targetBusinessDate !== currentEvidence.targetBusinessDate) {
        throw new Error('ORDERQ_REMATCH_V2_STOCKTAKE_DECISION_STALE');
      }
    }
    const included = decision?.decisionType === OFFICIAL_STOCKTAKE_DECISION.INCLUDED;
    const late = decision?.decisionType === OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED;
    const inputSignedQuantity = Number(impact.signedQuantity);
    if (!Number.isFinite(inputSignedQuantity)) throw new Error('ORDERQ_REMATCH_V2_SIGNED_QUANTITY_INVALID');
    const signedQuantity = Object.is(inputSignedQuantity, -0) ? 0 : inputSignedQuantity;
    const effectStatus = included
      ? OFFICIAL_STOCKTAKE_EFFECT_STATUS.ABSORBED
      : late ? OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT : 'APPLIED_NORMAL';
    const stocktakeEffectStatus = included
      ? OFFICIAL_STOCKTAKE_EFFECT_STATUS.ABSORBED
      : late ? OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT : '';
    return {
      movementId: voucherStableId('IMR2', command.commandId, impact.pendingEffectId, index + 1),
      companyId: command.companyId,
      warehouseId: required(impact.warehouseId, 'ORDERQ_REMATCH_V2_WAREHOUSE_REQUIRED'),
      productId: command.selectedProduct.productId,
      productCode: command.selectedProduct.productCode,
      sourceDocumentId: impact.sourceVoucher.documentId,
      sourceLineId: impact.sourceVoucher.lineId,
      sourceDocumentRevision: impact.sourceVoucher.documentRevision,
      sourceVoucherRevisionId: impact.sourceVoucher.revisionId,
      voucherMode: impact.sourceVoucher.voucherMode,
      movementType: included ? 'STOCKTAKE_CHECKPOINT_ABSORPTION'
        : late ? 'STOCKTAKE_LATE_ADJUSTMENT' : 'PENDING_PRODUCT_MATCH_RESOLVED',
      signedQuantity: included ? 0 : signedQuantity,
      originalSignedQuantity: signedQuantity,
      inventoryEffectFactor: 1,
      effectiveAt: impact.businessDate,
      businessDate: impact.businessDate,
      occurredAt: command.occurredAt,
      judgedAt: command.judgedAt,
      actor: command.actor,
      commandId: command.commandId,
      resolutionId,
      pendingEffectId: impact.pendingEffectId,
      checkpointId: decision?.checkpointId || '',
      stocktakeDecisionType: decision?.decisionType || '',
      effectStatus: signedQuantity === 0 ? 'ZERO_EFFECT' : effectStatus,
      stocktakeEffectStatus,
      officialInventoryApplied: !included
    };
  });
  const productResolution = {
    unresolvedProductId: command.unresolvedProductId,
    companyId: command.companyId,
    productId: command.selectedProduct.productId,
    productCode: command.selectedProduct.productCode,
    status: 'MATCHED',
    resolutionId,
    commandId: command.commandId,
    selectionEvidence: clone(command.selectionEvidence),
    resolvedAt: command.occurredAt,
    judgedAt: command.judgedAt,
    resolvedBy: command.actor
  };
  return deepFreeze({
    schemaVersion: INVENTORY_REMATCH_AUDIT_SCHEMA_V2,
    resolutionId,
    command,
    companyId: command.companyId,
    unresolvedProductId: command.unresolvedProductId,
    selectedProduct: clone(command.selectedProduct),
    productResolution,
    inventoryMovements,
    occurredAt: command.occurredAt,
    judgedAt: command.judgedAt,
    actor: command.actor
  });
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
