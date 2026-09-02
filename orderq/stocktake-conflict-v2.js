import './canonical-hash.js?v=0.2.0';

const sharedCanonicalHash = globalThis.ORDERQ_CANONICAL_HASH;
if (!sharedCanonicalHash) throw new Error('ORDERQ_CANONICAL_HASH_NOT_LOADED');

const canonicalSha256 = sharedCanonicalHash.canonicalSha256;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const text = value => String(value ?? '').normalize('NFKC').trim();
const snapshotText = value => String(value ?? '').trim();

const SCHEMA_VERSION = 'ONEAPP_ORDERQ_OFFICIAL_VOUCHER_V2';
const IDENTITY_VERSION = 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2';

export const OFFICIAL_STOCKTAKE_DECISION = Object.freeze({
  INCLUDED: 'INCLUDED_IN_CHECKPOINT',
  NOT_INCLUDED: 'NOT_INCLUDED_IN_CHECKPOINT'
});

export const OFFICIAL_STOCKTAKE_EFFECT_STATUS = Object.freeze({
  ABSORBED: 'ABSORBED_BY_CHECKPOINT',
  LATE_ADJUSTMENT: 'APPLIED_AS_LATE_ADJUSTMENT'
});

const ALLOWED_DECISIONS = new Set(Object.values(OFFICIAL_STOCKTAKE_DECISION));

export class OfficialStocktakeConflictRequiredError extends Error {
  constructor(conflicts = []) {
    super('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_REQUIRED');
    this.name = 'OfficialStocktakeConflictRequiredError';
    this.code = 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_REQUIRED';
    this.conflicts = clone(conflicts);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function requiredText(value, code) {
  const normalized = text(value);
  if (!normalized) throw new Error(code);
  return normalized;
}

function finite(value, code) {
  if (value === '' || value === null || value === undefined) throw new Error(code);
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(code);
  return Object.is(number, -0) ? 0 : number;
}

function isoDate(value, code) {
  const normalized = snapshotText(value);
  const matched = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!matched) throw new Error(code);
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(code);
  }
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

function trustedBusinessInstant(value, businessDate) {
  const normalized = snapshotText(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  if (isoDate(normalized, 'ORDERQ_OFFICIAL_V2_BUSINESS_TIMESTAMP_INVALID') !== businessDate) return null;
  const instant = Date.parse(normalized);
  return Number.isFinite(instant) ? instant : null;
}

function commandOf(source = {}) {
  return clone(source.intent || source.commandEnvelope || source.commandSource || source);
}

function fieldsFor(command = {}) {
  const commandType = text(command.commandType).toUpperCase();
  if (commandType.endsWith('PURCHASE')) {
    return { kind: 'PURCHASE', documentId: 'purchaseDocumentId', lineId: 'purchaseLineId', sign: 1 };
  }
  if (commandType.endsWith('SALE')) {
    return { kind: 'SALE', documentId: 'salesDocumentId', lineId: 'salesLineId', sign: -1 };
  }
  throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_COMMAND_KIND_INVALID');
}

function matchedLine(line = {}) {
  const status = text(line.officialProductResolution?.status
    || line.productSnapshot?.matchEvidence?.officialProductResolution?.status
    || line.matchStatus
    || line.productIdentityStatus).toUpperCase();
  return status === 'MATCHED' && Boolean(text(line.productId));
}

function productCodeOf(line = {}) {
  return snapshotText(line.productSnapshot?.productCode || line.productCode || line.itemCode);
}

function checkpointCoversLine(checkpoint = {}, line = {}) {
  const productId = text(line.productId);
  const productCode = productCodeOf(line);
  if (!productId || !productCode) return false;
  const rows = [
    ...(Array.isArray(checkpoint.counts) ? checkpoint.counts : []),
    ...(Array.isArray(checkpoint.lines) ? checkpoint.lines : []),
    ...(Array.isArray(checkpoint.products) ? checkpoint.products : [])
  ];
  if (checkpoint.coversAllProducts === true) return true;
  if (!rows.length) return false;
  return rows.some(row => {
    const checkpointCode = snapshotText(row.productCode || row.itemCode);
    if (checkpointCode) return checkpointCode === productCode;
    // Compatibility for checkpoints created before productCode was persisted.
    return text(row.productId) === productId;
  });
}

function checkpointRank(checkpoint = {}) {
  const businessDate = isoDate(checkpoint.effectiveAt || checkpoint.businessDate,
    'ORDERQ_OFFICIAL_V2_STOCKTAKE_DATE_INVALID');
  const exact = trustedBusinessInstant(checkpoint.businessOccurredAt || checkpoint.effectiveAt, businessDate);
  return {
    businessDate,
    exact: exact ?? Number.NEGATIVE_INFINITY,
    checkpointId: text(checkpoint.checkpointId)
  };
}

export function latestConfirmedCheckpointForOfficialLineV2({ command = {}, line = {}, inventoryCheckpoints = [] } = {}) {
  const companyId = requiredText(command.companyId || command.document?.companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const warehouseId = requiredText(line.warehouseId || command.document?.warehouseId, 'ORDERQ_OFFICIAL_WAREHOUSE_REQUIRED');
  const candidates = inventoryCheckpoints.filter(checkpoint => text(checkpoint.status).toUpperCase() === 'CONFIRMED'
    && text(checkpoint.companyId) === companyId
    && text(checkpoint.warehouseId) === warehouseId
    && checkpointCoversLine(checkpoint, line));
  candidates.sort((left, right) => {
    const a = checkpointRank(left);
    const b = checkpointRank(right);
    return b.businessDate.localeCompare(a.businessDate) || b.exact - a.exact || b.checkpointId.localeCompare(a.checkpointId);
  });
  return candidates.length ? deepFreeze(clone(candidates[0])) : null;
}

// This boundary intentionally accepts the same productId compatibility key
// carried by pending effects, so a later rematch flow can reuse the decision
// rule without inheriting any write or UI behavior from this stage.
export function evaluateStocktakeCheckpointConflictV2(source = {}) {
  const command = {
    companyId: source.companyId,
    document: {
      companyId: source.companyId,
      warehouseId: source.warehouseId,
      businessDate: source.businessDate,
      businessOccurredAt: source.businessOccurredAt
    }
  };
  const line = {
    productId: source.productId,
    productCode: source.productCode,
    warehouseId: source.warehouseId,
    businessOccurredAt: source.businessOccurredAt
  };
  const checkpoint = latestConfirmedCheckpointForOfficialLineV2({
    command,
    line,
    inventoryCheckpoints: source.inventoryCheckpoints || []
  });
  if (!checkpoint) return deepFreeze({ requiresDecision: false, reason: 'NO_CONFIRMED_CHECKPOINT', checkpoint: null });
  const businessDate = isoDate(source.businessDate, 'ORDERQ_OFFICIAL_V2_BUSINESS_DATE_INVALID');
  const checkpointBusinessDate = isoDate(checkpoint.effectiveAt || checkpoint.businessDate,
    'ORDERQ_OFFICIAL_V2_STOCKTAKE_DATE_INVALID');
  if (businessDate > checkpointBusinessDate) {
    return deepFreeze({ requiresDecision: false, reason: 'AFTER_CHECKPOINT', checkpoint });
  }
  if (businessDate === checkpointBusinessDate) {
    const voucherInstant = trustedBusinessInstant(source.businessOccurredAt, businessDate);
    const checkpointInstant = trustedBusinessInstant(checkpoint.businessOccurredAt || checkpoint.effectiveAt,
      checkpointBusinessDate);
    if (voucherInstant !== null && checkpointInstant !== null && voucherInstant > checkpointInstant) {
      return deepFreeze({ requiresDecision: false, reason: 'PROVEN_AFTER_CHECKPOINT', checkpoint });
    }
    return deepFreeze({ requiresDecision: true, reason: 'SAME_DAY_ORDER_UNPROVEN', checkpoint });
  }
  return deepFreeze({ requiresDecision: true, reason: 'BEFORE_CHECKPOINT', checkpoint });
}

function conflictForLine(command, line, checkpoint, fields) {
  if (!checkpoint) return null;
  const businessDate = isoDate(command.document?.businessDate
    || command.document?.purchaseDate
    || command.document?.saleDate,
  'ORDERQ_OFFICIAL_V2_BUSINESS_DATE_INVALID');
  const checkpointBusinessDate = isoDate(checkpoint.effectiveAt || checkpoint.businessDate,
    'ORDERQ_OFFICIAL_V2_STOCKTAKE_DATE_INVALID');
  if (businessDate > checkpointBusinessDate) return null;
  if (businessDate === checkpointBusinessDate) {
    const voucherInstant = trustedBusinessInstant(line.businessOccurredAt
      || command.document?.businessOccurredAt
      || command.document?.businessEffectiveAt, businessDate);
    const checkpointInstant = trustedBusinessInstant(checkpoint.businessOccurredAt || checkpoint.effectiveAt,
      checkpointBusinessDate);
    if (voucherInstant !== null && checkpointInstant !== null && voucherInstant > checkpointInstant) return null;
  }
  const documentId = requiredText(command.document?.[fields.documentId] || command[fields.documentId] || command.aggregateId,
    `ORDERQ_OFFICIAL_${fields.kind}_DOCUMENT_ID_REQUIRED`);
  const sourceLineId = requiredText(line[fields.lineId], `ORDERQ_OFFICIAL_${fields.kind}_LINE_ID_REQUIRED`);
  const signedQuantity = fields.sign * finite(line.baseQuantity ?? line.actualQuantity ?? line.quantity,
    'ORDERQ_OFFICIAL_BASE_QUANTITY_REQUIRED');
  return {
    schemaVersion: SCHEMA_VERSION,
    identityVersion: IDENTITY_VERSION,
    entityType: `${fields.kind}_STOCKTAKE_CONFLICT`,
    companyId: command.companyId,
    voucherMode: fields.kind.toLowerCase(),
    documentId,
    sourceLineId,
    productId: text(line.productId),
    productCode: productCodeOf(line),
    productName: snapshotText(line.productSnapshot?.productName || line.productName || line.itemName),
    warehouseId: text(line.warehouseId || command.document?.warehouseId),
    warehouseCode: snapshotText(line.warehouseCode || command.document?.warehouseCode),
    warehouseName: snapshotText(line.warehouseName || command.document?.warehouseName
      || line.warehouseCode || command.document?.warehouseCode || line.warehouseId || command.document?.warehouseId),
    signedQuantity,
    quantity: finite(line.actualQuantity ?? line.quantity, 'ORDERQ_OFFICIAL_QUANTITY_REQUIRED'),
    businessDate,
    checkpointId: requiredText(checkpoint.checkpointId, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_CHECKPOINT_ID_REQUIRED'),
    checkpointBusinessDate,
    checkpointEffectiveAt: snapshotText(checkpoint.effectiveAt || checkpoint.businessDate),
    checkpointConfirmedAt: snapshotText(checkpoint.confirmedAt)
  };
}

export function inspectOfficialStocktakeConflictsV2(source = {}) {
  const command = commandOf(source.command || source);
  const fields = fieldsFor(command);
  const checkpoints = Array.isArray(source.inventoryCheckpoints) ? source.inventoryCheckpoints : [];
  const conflicts = (Array.isArray(command.lines) ? command.lines : [])
    .filter(matchedLine)
    .map(line => conflictForLine(command, line,
      latestConfirmedCheckpointForOfficialLineV2({ command, line, inventoryCheckpoints: checkpoints }), fields))
    .filter(Boolean)
    .sort((left, right) => left.sourceLineId.localeCompare(right.sourceLineId));
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    identityVersion: IDENTITY_VERSION,
    companyId: text(command.companyId),
    voucherMode: fields.kind.toLowerCase(),
    documentId: text(command.document?.[fields.documentId] || command[fields.documentId] || command.aggregateId),
    conflicts
  });
}

function decisionId(conflict, decisionType) {
  return `STD-${canonicalSha256({
    schemaVersion: SCHEMA_VERSION,
    entityType: `${text(conflict.voucherMode).toUpperCase()}_STOCKTAKE_DECISION`,
    companyId: conflict.companyId,
    documentId: conflict.documentId,
    sourceLineId: conflict.sourceLineId,
    checkpointId: conflict.checkpointId,
    decisionType
  }).slice(0, 32)}`;
}

export function createOfficialStocktakeDecisionsV2({ conflicts = [], decisionType, actor, judgedAt } = {}) {
  const normalizedDecision = text(decisionType).toUpperCase();
  if (!ALLOWED_DECISIONS.has(normalizedDecision)) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_INVALID');
  const normalizedActor = requiredText(actor, 'ORDERQ_OFFICIAL_ACTOR_REQUIRED');
  const normalizedJudgedAt = requiredText(judgedAt, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_JUDGED_AT_REQUIRED');
  if (!Number.isFinite(Date.parse(normalizedJudgedAt))) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_JUDGED_AT_INVALID');
  return deepFreeze(conflicts.map(conflict => {
    const effectStatus = normalizedDecision === OFFICIAL_STOCKTAKE_DECISION.INCLUDED
      ? OFFICIAL_STOCKTAKE_EFFECT_STATUS.ABSORBED
      : OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT;
    return {
      schemaVersion: SCHEMA_VERSION,
      identityVersion: IDENTITY_VERSION,
      entityType: `${text(conflict.voucherMode).toUpperCase()}_STOCKTAKE_DECISION`,
      decisionId: decisionId(conflict, normalizedDecision),
      decisionType: normalizedDecision,
      companyId: conflict.companyId,
      voucherMode: conflict.voucherMode,
      documentId: conflict.documentId,
      target: {
        sourceLineId: conflict.sourceLineId,
        productId: conflict.productId,
        productCode: conflict.productCode,
        productName: conflict.productName,
        warehouseId: conflict.warehouseId,
        warehouseCode: conflict.warehouseCode,
        warehouseName: conflict.warehouseName
      },
      effect: {
        signedQuantity: conflict.signedQuantity,
        effectStatus
      },
      checkpoint: {
        checkpointId: conflict.checkpointId,
        businessDate: conflict.checkpointBusinessDate,
        effectiveAt: conflict.checkpointEffectiveAt,
        confirmedAt: conflict.checkpointConfirmedAt
      },
      businessDate: conflict.businessDate,
      judgedAt: normalizedJudgedAt,
      actor: normalizedActor
    };
  }));
}

function canonicalDecisionTarget(decision = {}) {
  return {
    companyId: text(decision.companyId),
    voucherMode: text(decision.voucherMode).toLowerCase(),
    documentId: text(decision.documentId),
    sourceLineId: text(decision.target?.sourceLineId),
    productId: text(decision.target?.productId),
    productCode: snapshotText(decision.target?.productCode),
    productName: snapshotText(decision.target?.productName),
    warehouseId: text(decision.target?.warehouseId),
    warehouseCode: snapshotText(decision.target?.warehouseCode),
    warehouseName: snapshotText(decision.target?.warehouseName),
    signedQuantity: Number(decision.effect?.signedQuantity),
    checkpointId: text(decision.checkpoint?.checkpointId),
    checkpointBusinessDate: snapshotText(decision.checkpoint?.businessDate),
    checkpointEffectiveAt: snapshotText(decision.checkpoint?.effectiveAt),
    checkpointConfirmedAt: snapshotText(decision.checkpoint?.confirmedAt),
    businessDate: snapshotText(decision.businessDate)
  };
}

function canonicalConflictTarget(conflict = {}) {
  return {
    companyId: text(conflict.companyId),
    voucherMode: text(conflict.voucherMode).toLowerCase(),
    documentId: text(conflict.documentId),
    sourceLineId: text(conflict.sourceLineId),
    productId: text(conflict.productId),
    productCode: snapshotText(conflict.productCode),
    productName: snapshotText(conflict.productName),
    warehouseId: text(conflict.warehouseId),
    warehouseCode: snapshotText(conflict.warehouseCode),
    warehouseName: snapshotText(conflict.warehouseName),
    signedQuantity: Number(conflict.signedQuantity),
    checkpointId: text(conflict.checkpointId),
    checkpointBusinessDate: snapshotText(conflict.checkpointBusinessDate),
    checkpointEffectiveAt: snapshotText(conflict.checkpointEffectiveAt),
    checkpointConfirmedAt: snapshotText(conflict.checkpointConfirmedAt),
    businessDate: snapshotText(conflict.businessDate)
  };
}

export function assertOfficialStocktakeDecisionEnvelopeV2(source = {}, inventoryCheckpoints = null) {
  const command = commandOf(source.command || source);
  const fields = fieldsFor(command);
  const commandCompanyId = requiredText(command.companyId || command.document?.companyId, 'ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const commandDocumentId = requiredText(command.document?.[fields.documentId] || command[fields.documentId] || command.aggregateId,
    `ORDERQ_OFFICIAL_${fields.kind}_DOCUMENT_ID_REQUIRED`);
  const commandBusinessDate = isoDate(command.document?.businessDate
    || command.document?.purchaseDate
    || command.document?.saleDate,
  'ORDERQ_OFFICIAL_V2_BUSINESS_DATE_INVALID');
  const lineById = new Map((command.lines || []).map(line => [text(line[fields.lineId]), line]));
  const decisions = Array.isArray(command.stocktakeDecisions) ? command.stocktakeDecisions : [];
  const seen = new Set();
  const seenTargets = new Set();
  decisions.forEach(decision => {
    const decisionType = text(decision.decisionType).toUpperCase();
    if (!ALLOWED_DECISIONS.has(decisionType)) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_INVALID');
    if (text(decision.schemaVersion) !== SCHEMA_VERSION || text(decision.identityVersion) !== IDENTITY_VERSION
      || text(decision.entityType) !== `${fields.kind}_STOCKTAKE_DECISION`) {
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_IDENTITY_INVALID');
    }
    if (text(decision.companyId) !== commandCompanyId) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_COMPANY_MISMATCH');
    if (text(decision.voucherMode).toUpperCase() !== fields.kind
      || text(decision.documentId) !== commandDocumentId) {
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_SCOPE_MISMATCH');
    }
    if (text(decision.actor) !== text(command.actor || command.actorId)) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_ACTOR_MISMATCH');
    if (!Number.isFinite(Date.parse(snapshotText(decision.judgedAt)))) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_JUDGED_AT_INVALID');
    finite(decision.effect?.signedQuantity, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_QUANTITY_INVALID');
    if (snapshotText(decision.businessDate) !== commandBusinessDate) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_DATE_MISMATCH');
    const sourceLineId = requiredText(decision.target?.sourceLineId, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_LINE_REQUIRED');
    const line = lineById.get(sourceLineId);
    if (!line || !matchedLine(line)) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_LINE_MISMATCH');
    const expectedSignedQuantity = fields.sign * finite(line.baseQuantity ?? line.actualQuantity ?? line.quantity,
      'ORDERQ_OFFICIAL_BASE_QUANTITY_REQUIRED');
    if (text(decision.target?.productId) !== text(line.productId)
      || snapshotText(decision.target?.productCode) !== productCodeOf(line)
      || snapshotText(decision.target?.productName) !== snapshotText(line.productSnapshot?.productName || line.productName || line.itemName)
      || text(decision.target?.warehouseId) !== text(line.warehouseId || command.document?.warehouseId)
      || Number(decision.effect?.signedQuantity) !== expectedSignedQuantity) {
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_TARGET_MISMATCH');
    }
    const checkpointId = requiredText(decision.checkpoint?.checkpointId, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_CHECKPOINT_ID_REQUIRED');
    const checkpointBusinessDate = isoDate(decision.checkpoint?.businessDate,
      'ORDERQ_OFFICIAL_V2_STOCKTAKE_DATE_INVALID');
    if (isoDate(decision.checkpoint?.effectiveAt, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DATE_INVALID') !== checkpointBusinessDate) {
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_CHECKPOINT_DATE_MISMATCH');
    }
    const expectedStatus = decisionType === OFFICIAL_STOCKTAKE_DECISION.INCLUDED
      ? OFFICIAL_STOCKTAKE_EFFECT_STATUS.ABSORBED
      : OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT;
    if (text(decision.effect?.effectStatus) !== expectedStatus) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_EFFECT_INVALID');
    const expectedId = decisionId({
      companyId: decision.companyId,
      voucherMode: decision.voucherMode,
      documentId: decision.documentId,
      sourceLineId,
      checkpointId
    }, decisionType);
    if (text(decision.decisionId) !== expectedId) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_ID_INVALID');
    if (seen.has(expectedId)) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_DUPLICATE');
    if (seenTargets.has(sourceLineId)) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_DUPLICATE');
    seen.add(expectedId);
    seenTargets.add(sourceLineId);
  });

  if (inventoryCheckpoints !== null) {
    const assessment = inspectOfficialStocktakeConflictsV2({ command, inventoryCheckpoints });
    if (assessment.conflicts.length !== decisions.length) {
      if (!decisions.length && assessment.conflicts.length) throw new OfficialStocktakeConflictRequiredError(assessment.conflicts);
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_TARGET_COUNT_MISMATCH');
    }
    const decisionByLine = new Map(decisions.map(decision => [text(decision.target?.sourceLineId), decision]));
    assessment.conflicts.forEach(conflict => {
      const decision = decisionByLine.get(conflict.sourceLineId);
      if (!decision || canonicalSha256(canonicalDecisionTarget(decision)) !== canonicalSha256(canonicalConflictTarget(conflict))) {
        throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_TARGET_MISMATCH');
      }
    });
  }
  return deepFreeze(clone(decisions));
}

export function applyOfficialStocktakeDecisionsV2({ command: commandSource = {}, inventoryMovements = [], inventoryCheckpoints = [] } = {}) {
  const command = commandOf(commandSource);
  const assessment = inspectOfficialStocktakeConflictsV2({ command, inventoryCheckpoints });
  const decisions = assertOfficialStocktakeDecisionEnvelopeV2(command, inventoryCheckpoints);
  if (!assessment.conflicts.length) return deepFreeze({ inventoryMovements: clone(inventoryMovements), stocktakeDecisions: [] });
  const decisionByLine = new Map(decisions.map(decision => [text(decision.target?.sourceLineId), decision]));
  const conflictsByLine = new Map(assessment.conflicts.map(conflict => [conflict.sourceLineId, conflict]));
  const projected = [];
  inventoryMovements.forEach(movement => {
    const conflict = conflictsByLine.get(text(movement.sourceLineId));
    if (!conflict) {
      projected.push(clone(movement));
      return;
    }
    const decision = decisionByLine.get(conflict.sourceLineId);
    const originalSignedQuantity = finite(movement.signedQuantity, 'ORDERQ_OFFICIAL_V2_STOCKTAKE_MOVEMENT_QUANTITY_INVALID');
    const commonAudit = {
      stocktakeDecisionId: decision.decisionId,
      stocktakeDecisionType: decision.decisionType,
      checkpointId: decision.checkpoint.checkpointId,
      checkpointEffectiveAt: decision.checkpoint.effectiveAt,
      checkpointBusinessDate: decision.checkpoint.businessDate,
      stocktakeJudgedAt: decision.judgedAt,
      stocktakeDecisionActor: decision.actor,
      businessDate: decision.businessDate,
      originalSignedQuantity
    };
    const sourceMovement = {
      ...clone(movement),
      signedQuantity: 0,
      effectStatus: originalSignedQuantity === 0 ? 'ZERO_EFFECT' : decision.effect.effectStatus,
      stocktakeEffectStatus: decision.effect.effectStatus,
      officialInventoryApplied: false,
      effectRole: 'SOURCE_VOUCHER_EFFECT',
      ...commonAudit
    };
    projected.push(sourceMovement);
    if (decision.decisionType === OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED) {
      projected.push({
        ...clone(movement),
        movementId: `ILA-${canonicalSha256({
          schemaVersion: SCHEMA_VERSION,
          entityType: `${text(movement.voucherMode).toUpperCase()}_LATE_INVENTORY_ADJUSTMENT`,
          companyId: movement.companyId,
          sourceMovementId: movement.movementId,
          decisionId: decision.decisionId
        }).slice(0, 32)}`,
        entityType: `${text(movement.voucherMode).toUpperCase()}_LATE_INVENTORY_ADJUSTMENT`,
        sourceMovementId: movement.movementId,
        movementType: 'STOCKTAKE_LATE_ADJUSTMENT',
        signedQuantity: originalSignedQuantity,
        effectStatus: originalSignedQuantity === 0 ? 'ZERO_EFFECT' : OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT,
        stocktakeEffectStatus: OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT,
        officialInventoryApplied: true,
        effectRole: 'LATE_ADJUSTMENT',
        ...commonAudit
      });
    }
  });
  return deepFreeze({ inventoryMovements: projected, stocktakeDecisions: decisions });
}

export function assertOfficialStocktakeProjectionV2(projection = {}, source = {}) {
  const command = commandOf(source.command || source);
  const decisions = assertOfficialStocktakeDecisionEnvelopeV2(command);
  const movements = Array.isArray(projection.inventoryMovements) ? projection.inventoryMovements : [];
  const revisionDecisions = Array.isArray(projection.voucherRevision?.stocktakeDecisions)
    ? projection.voucherRevision.stocktakeDecisions : [];
  if (canonicalSha256(revisionDecisions) !== canonicalSha256(decisions)) {
    throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_REVISION_DECISION_MISMATCH');
  }
  decisions.forEach(decision => {
    const sources = movements.filter(row => text(row.sourceLineId) === text(decision.target.sourceLineId)
      && text(row.effectRole) === 'SOURCE_VOUCHER_EFFECT');
    const adjustments = movements.filter(row => text(row.stocktakeDecisionId) === text(decision.decisionId)
      && text(row.effectRole) === 'LATE_ADJUSTMENT');
    if (sources.length !== 1 || Number(sources[0].signedQuantity) !== 0
      || Number(sources[0].originalSignedQuantity) !== Number(decision.effect.signedQuantity)
      || text(sources[0].companyId) !== text(decision.companyId)
      || text(sources[0].sourceDocumentId) !== text(decision.documentId)
      || text(sources[0].productId) !== text(decision.target.productId)
      || snapshotText(sources[0].productCode) !== snapshotText(decision.target.productCode)
      || text(sources[0].warehouseId) !== text(decision.target.warehouseId)
      || text(sources[0].checkpointId) !== text(decision.checkpoint.checkpointId)
      || snapshotText(sources[0].checkpointEffectiveAt) !== snapshotText(decision.checkpoint.effectiveAt)
      || snapshotText(sources[0].checkpointBusinessDate) !== snapshotText(decision.checkpoint.businessDate)
      || text(sources[0].stocktakeDecisionType) !== text(decision.decisionType)
      || snapshotText(sources[0].stocktakeJudgedAt) !== snapshotText(decision.judgedAt)
      || text(sources[0].stocktakeDecisionActor) !== text(decision.actor)
      || snapshotText(sources[0].businessDate) !== snapshotText(decision.businessDate)
      || text(sources[0].effectStatus) !== (Number(decision.effect.signedQuantity) === 0
        ? 'ZERO_EFFECT'
        : text(decision.effect.effectStatus))
      || text(sources[0].stocktakeEffectStatus) !== text(decision.effect.effectStatus)
      || sources[0].officialInventoryApplied !== false) {
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_SOURCE_PROJECTION_MISMATCH');
    }
    const expectedAdjustments = decision.decisionType === OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED ? 1 : 0;
    if (adjustments.length !== expectedAdjustments) throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_ADJUSTMENT_COUNT_INVALID');
    if (adjustments[0] && (Number(adjustments[0].signedQuantity) !== Number(decision.effect.signedQuantity)
      || adjustments[0].officialInventoryApplied !== true
      || text(adjustments[0].companyId) !== text(decision.companyId)
      || text(adjustments[0].sourceDocumentId) !== text(decision.documentId)
      || text(adjustments[0].sourceLineId) !== text(decision.target.sourceLineId)
      || text(adjustments[0].productId) !== text(decision.target.productId)
      || snapshotText(adjustments[0].productCode) !== snapshotText(decision.target.productCode)
      || text(adjustments[0].warehouseId) !== text(decision.target.warehouseId)
      || text(adjustments[0].effectStatus) !== (Number(decision.effect.signedQuantity) === 0
        ? 'ZERO_EFFECT'
        : OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT)
      || text(adjustments[0].stocktakeEffectStatus) !== OFFICIAL_STOCKTAKE_EFFECT_STATUS.LATE_ADJUSTMENT
      || text(adjustments[0].checkpointId) !== text(decision.checkpoint.checkpointId)
      || snapshotText(adjustments[0].stocktakeJudgedAt) !== snapshotText(decision.judgedAt)
      || text(adjustments[0].stocktakeDecisionActor) !== text(decision.actor)
      || snapshotText(adjustments[0].businessDate) !== snapshotText(decision.businessDate)
      || text(adjustments[0].sourceMovementId) !== text(sources[0].movementId))) {
      throw new Error('ORDERQ_OFFICIAL_V2_STOCKTAKE_ADJUSTMENT_PROJECTION_MISMATCH');
    }
  });
  return deepFreeze(clone({ inventoryMovements: movements, stocktakeDecisions: revisionDecisions }));
}
