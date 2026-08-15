import { calculateInventoryShadowProjection } from './inventory-ledger.js?v=0.8.0';

export const CENTRAL_SCHEMA = 'ONEAPP_ORDERQ_CENTRAL_V1';

export const OFFICIAL_COMMAND_TYPE = Object.freeze({
  RELEASE_DISPATCH: 'RELEASE_DISPATCH',
  UPDATE_DISPATCH: 'UPDATE_DISPATCH',
  RECALL_DISPATCH: 'RECALL_DISPATCH',
  CONFIRM_DISPATCH: 'CONFIRM_DISPATCH',
  REVERSE_DISPATCH: 'REVERSE_DISPATCH',
  ADJUST_DISPATCH: 'ADJUST_DISPATCH',
  CONFIRM_PURCHASE: 'CONFIRM_PURCHASE',
  REVERSE_PURCHASE: 'REVERSE_PURCHASE',
  RECONCILE_PURCHASE_EXTERNAL: 'RECONCILE_PURCHASE_EXTERNAL',
  ERP_TRANSITION: 'ERP_TRANSITION'
});

const COMMAND_TYPES = new Set(Object.values(OFFICIAL_COMMAND_TYPE));
const MIGRATION_TYPES = new Set([
  'ORDER', 'ORDER_ITEM', 'PRODUCT', 'WAREHOUSE', 'INVENTORY_SNAPSHOT', 'INVENTORY_LINE',
  'DISPATCH_DECISION', 'DISPATCH_LINE', 'DISPATCH_STOCK_ALLOCATION',
  'PURCHASE_DOCUMENT', 'PURCHASE_LINE'
]);
const OFFICIAL_TYPES = new Set([
  ...MIGRATION_TYPES,
  'DISPATCH_APPROVAL', 'INVENTORY_RESERVATION', 'INVENTORY_MOVEMENT', 'DISPATCH_RECONCILIATION',
  'SALES_DOCUMENT', 'SALES_LINE', 'ORDER_EVENT'
]);
const EPSILON = 1e-9;
export const CENTRAL_LEASE_DURATION_MS = 5 * 60 * 1000;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function entityKey(entityType, entityId) {
  return `${text(entityType).toUpperCase()}\u001f${text(entityId)}`;
}

function sameNumber(left, right) {
  return Math.abs(finite(left) - finite(right)) <= EPSILON;
}

function commandError(code, detail = '') {
  throw new Error(`${code}${detail ? `:${detail}` : ''}`);
}

function nowMillis(value) {
  const parsed = Date.parse(text(value || new Date().toISOString()));
  if (!Number.isFinite(parsed)) commandError('ORDERQ_CENTRAL_SERVER_TIME_INVALID');
  return parsed;
}

function leaseExpired(command, atMillis) {
  const expiresAt = Date.parse(text(command?.leaseExpiresAt));
  return !Number.isFinite(expiresAt) || expiresAt <= atMillis;
}

export function createCentralAuthorityState(source = {}) {
  return {
    schema: CENTRAL_SCHEMA,
    entities: clone(source.entities || {}),
    commands: clone(source.commands || {}),
    syncSequence: Math.max(0, Number(source.syncSequence || 0)),
    ledgerSequence: Math.max(0, Number(source.ledgerSequence || 0)),
    changes: clone(source.changes || [])
  };
}

export function centralCommandFingerprint(source = {}) {
  const commandType = text(source.commandType).toUpperCase();
  const aggregateId = text(source.aggregateId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  if (!COMMAND_TYPES.has(commandType)) commandError('ORDERQ_CENTRAL_COMMAND_TYPE_INVALID', commandType);
  if (!aggregateId) commandError('ORDERQ_CENTRAL_AGGREGATE_ID_REQUIRED');
  if (!idempotencyKey) commandError('ORDERQ_CENTRAL_IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) commandError('ORDERQ_CENTRAL_REVISION_REQUIRED');
  return stableJson({
    commandType,
    aggregateId,
    expectedRevision,
    intent: source.intent || null
  });
}

function entityRevision(entity) {
  return Number(entity?.revision ?? entity?.dispatchRevision ?? entity?.payload?.revision ?? 0);
}

function entityStatus(entity) {
  return text(entity?.status || entity?.payload?.status).toUpperCase();
}

function targetType(commandType) {
  return commandType.includes('PURCHASE') ? 'PURCHASE_DOCUMENT' : commandType === OFFICIAL_COMMAND_TYPE.ERP_TRANSITION
    ? '' : 'DISPATCH_DECISION';
}

function targetStatusAllowed(commandType, status) {
  const allowed = {
    RELEASE_DISPATCH: ['DRAFT'],
    UPDATE_DISPATCH: ['RELEASED', 'READY_TO_CONFIRM'],
    RECALL_DISPATCH: ['RELEASED', 'READY_TO_CONFIRM'],
    CONFIRM_DISPATCH: ['READY_TO_CONFIRM'],
    REVERSE_DISPATCH: ['CONFIRMED'],
    ADJUST_DISPATCH: ['CONFIRMED'],
    CONFIRM_PURCHASE: ['DRAFT'],
    REVERSE_PURCHASE: ['CONFIRMED'],
    RECONCILE_PURCHASE_EXTERNAL: ['CONFIRMED'],
    ERP_TRANSITION: ['READY', 'EXPORTED', 'POSTED', 'RECONCILED', 'CORRECTION_REQUIRED']
  }[commandType] || [];
  return allowed.includes(status);
}

function erpTransitionAllowed(current, next) {
  const allowed = {
    READY: ['EXPORTED', 'CORRECTION_REQUIRED'],
    EXPORTED: ['POSTED', 'CORRECTION_REQUIRED'],
    POSTED: ['RECONCILED', 'CORRECTION_REQUIRED'],
    RECONCILED: ['CORRECTION_REQUIRED'],
    CORRECTION_REQUIRED: ['EXPORTED']
  };
  return (allowed[text(current).toUpperCase()] || []).includes(text(next).toUpperCase());
}

function inventoryResourceFingerprint(state) {
  const rows = Object.values(state?.entities || {})
    .filter(row => ['INVENTORY_LINE', 'INVENTORY_MOVEMENT', 'INVENTORY_RESERVATION'].includes(row.entityType))
    .map(row => ({
      entityType: row.entityType,
      entityId: row.entityId,
      revision: entityRevision(row),
      status: entityStatus(row),
      productId: text(row.payload?.productId),
      warehouseId: text(row.payload?.warehouseId),
      inventoryQuantity: row.payload?.inventoryQuantity,
      signedBaseQuantity: row.payload?.signedBaseQuantity,
      reservedBaseQuantity: row.payload?.reservedBaseQuantity
    }))
    .sort((left, right) => entityKey(left.entityType, left.entityId).localeCompare(entityKey(right.entityType, right.entityId)));
  return stableJson(rows);
}

function rowFromEntity(entityType, entityId, payload, revision = 0) {
  return {
    entityType: text(entityType).toUpperCase(),
    entityId: text(entityId),
    revision: Number(revision || payload?.revision || 0),
    status: text(payload?.status || payload?.erpPostingStatus).toUpperCase(),
    payload: clone(payload)
  };
}

function appendChange(state, row, deviceId, commandId) {
  state.syncSequence += 1;
  state.changes.push({
    sequence: state.syncSequence,
    deviceId: text(deviceId),
    commandId: text(commandId),
    entityType: row.entityType,
    entityId: row.entityId,
    revision: row.revision,
    payload: clone(row.payload)
  });
}

export function migrateCentralDrafts(stateSource, source = {}, options = {}) {
  const state = stateSource;
  if (!state || state.schema !== CENTRAL_SCHEMA) commandError('ORDERQ_CENTRAL_STATE_INVALID');
  const idempotencyKey = text(source.idempotencyKey);
  if (!idempotencyKey) commandError('ORDERQ_CENTRAL_MIGRATION_KEY_REQUIRED');
  const entities = Array.isArray(source.entities) ? source.entities : [];
  const fingerprint = stableJson(entities.map(row => ({
    entityType: text(row.entityType).toUpperCase(), entityId: text(row.entityId), payload: row.payload
  })).sort((left, right) => entityKey(left.entityType, left.entityId).localeCompare(entityKey(right.entityType, right.entityId))));
  const prior = state.commands[idempotencyKey];
  if (prior) {
    if (prior.fingerprint !== fingerprint) commandError('ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_CONFLICT', idempotencyKey);
    return { duplicate: true, changes: clone(prior.result?.changes || []), cursor: state.syncSequence };
  }
  const working = createCentralAuthorityState(state);
  const changes = [];
  for (const input of entities) {
    const type = text(input.entityType).toUpperCase();
    const id = text(input.entityId);
    const payload = clone(input.payload);
    if (!MIGRATION_TYPES.has(type) || !id || !payload) commandError('ORDERQ_CENTRAL_MIGRATION_ENTITY_INVALID', `${type}:${id}`);
    if (type === 'DISPATCH_DECISION' && entityStatus(payload) !== 'DRAFT') commandError('ORDERQ_CENTRAL_MIGRATION_DISPATCH_DRAFT_ONLY', id);
    if (type === 'PURCHASE_DOCUMENT' && entityStatus(payload) !== 'DRAFT') commandError('ORDERQ_CENTRAL_MIGRATION_PURCHASE_DRAFT_ONLY', id);
    if (payload.localOnly === false || payload.centralRevision || payload.ledgerSequence) {
      commandError('ORDERQ_CENTRAL_MIGRATION_EVIDENCE_INVALID', `${type}:${id}`);
    }
    const key = entityKey(type, id);
    const row = rowFromEntity(type, id, payload, input.revision);
    row.payload.localOnly = false;
    row.payload.centralRevision = row.revision;
    const existing = working.entities[key];
    if (existing && stableJson(existing.payload) !== stableJson(row.payload)) {
      commandError('ORDERQ_CENTRAL_MIGRATION_CONFLICT', `${type}:${id}`);
    }
    if (!existing) {
      working.entities[key] = row;
      if (text(options.failureAt).toUpperCase() === 'ENTITIES_WRITTEN') {
        commandError('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED', 'ENTITIES_WRITTEN');
      }
      appendChange(working, row, source.deviceId, idempotencyKey);
      if (text(options.failureAt).toUpperCase() === 'CHANGES_WRITTEN') {
        commandError('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED', 'CHANGES_WRITTEN');
      }
      changes.push(clone(row));
    }
  }
  working.commands[idempotencyKey] = { type: 'MIGRATION', fingerprint, status: 'COMMITTED', result: { changes: clone(changes) } };
  if (text(options.failureAt).toUpperCase() === 'COMMAND_WRITTEN') {
    commandError('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED', 'COMMAND_WRITTEN');
  }
  Object.assign(state, working);
  return { duplicate: false, changes, cursor: state.syncSequence };
}

export function prepareCentralCommand(state, source = {}) {
  if (!state || state.schema !== CENTRAL_SCHEMA) commandError('ORDERQ_CENTRAL_STATE_INVALID');
  const commandType = text(source.commandType).toUpperCase();
  const aggregateId = text(source.aggregateId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  const fingerprint = centralCommandFingerprint(source);
  const preparedAtMillis = nowMillis(source.now);
  for (const row of Object.values(state.commands)) {
    if (row.status === 'PREPARED' && leaseExpired(row, preparedAtMillis)) {
      row.status = 'EXPIRED';
      row.expiredAt = new Date(preparedAtMillis).toISOString();
    }
  }
  const prior = state.commands[idempotencyKey];
  if (prior) {
    if (prior.fingerprint !== fingerprint) commandError('ORDERQ_CENTRAL_IDEMPOTENCY_CONFLICT', idempotencyKey);
    if (prior.status === 'COMMITTED') return { duplicate: true, committed: true, result: clone(prior.result) };
    if (prior.status !== 'PREPARED') commandError('ORDERQ_CENTRAL_COMMAND_TERMINAL', `${idempotencyKey}:${prior.status}`);
    return { duplicate: true, committed: false, leaseToken: prior.leaseToken, leaseExpiresAt:prior.leaseExpiresAt, fingerprint };
  }
  const type = targetType(commandType);
  const target = type ? state.entities[entityKey(type, aggregateId)] : null;
  if (type && !target) commandError('ORDERQ_CENTRAL_TARGET_NOT_FOUND', `${type}:${aggregateId}`);
  if (target && entityRevision(target) !== expectedRevision) {
    commandError('ORDERQ_CENTRAL_REVISION_CONFLICT', String(entityRevision(target)));
  }
  if (target && !targetStatusAllowed(commandType, entityStatus(target))) {
    commandError('ORDERQ_CENTRAL_STATE_CONFLICT', entityStatus(target));
  }
  const conflictingLease = Object.values(state.commands).find(row => row.status === 'PREPARED'
    && row.aggregateId === aggregateId && row.idempotencyKey !== idempotencyKey);
  if (conflictingLease) commandError('ORDERQ_CENTRAL_AGGREGATE_LOCKED', aggregateId);
  const leaseToken = `LEASE-${idempotencyKey}-${preparedAtMillis}`;
  const preparedAt = new Date(preparedAtMillis).toISOString();
  const leaseExpiresAt = new Date(preparedAtMillis + CENTRAL_LEASE_DURATION_MS).toISOString();
  state.commands[idempotencyKey] = {
    idempotencyKey, commandType, aggregateId, expectedRevision, fingerprint,
    leaseToken, status: 'PREPARED', deviceId: text(source.deviceId), preparedAt, leaseExpiresAt,
    inventoryResourceFingerprint: inventoryResourceFingerprint(state)
  };
  return { duplicate: false, committed: false, leaseToken, leaseExpiresAt, fingerprint, serverRevision: expectedRevision };
}

function rowsWithMutations(state, mutations, entityType) {
  const rows = new Map(Object.values(state.entities || {})
    .filter(row => row.entityType === entityType)
    .map(row => [row.entityId, row]));
  mutations.filter(row => row.entityType === entityType).forEach(row => rows.set(row.entityId, row));
  return [...rows.values()];
}

function requireSameNumber(left, right, code, detail = '') {
  if (!sameNumber(left, right)) commandError(code, detail);
}

function requireExactIds(actualValues, expectedValues, code) {
  const actual = actualValues.map(text);
  const expected = expectedValues.map(text);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actual.some(value => !value) || expected.some(value => !value)
    || actualSet.size !== actual.length || expectedSet.size !== expected.length
    || actualSet.size !== expectedSet.size || [...expectedSet].some(value => !actualSet.has(value))) {
    commandError(code);
  }
}

function validateDispatchConfirmationLedger(state, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const all = type => rowsWithMutations(state, mutations, type);
  const documents = rows('SALES_DOCUMENT');
  const salesLines = rows('SALES_LINE');
  const movements = rows('INVENTORY_MOVEMENT');
  const events = rows('ORDER_EVENT').filter(row => text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_ALLOCATED');
  const reservations = rows('INVENTORY_RESERVATION');
  const existingDispatchLines = Object.values(state.entities || {}).filter(row => row.entityType === 'DISPATCH_LINE'
    && text(row.payload.dispatchId) === command.aggregateId);
  const targetLineIds = existingDispatchLines.map(row => row.entityId);
  const targetLineIdSet = new Set(targetLineIds);
  const existingAllocations = Object.values(state.entities || {}).filter(row => row.entityType === 'DISPATCH_STOCK_ALLOCATION'
    && (text(row.payload.dispatchId) === command.aggregateId || targetLineIdSet.has(text(row.payload.dispatchLineId))));
  const targetAllocationIds = existingAllocations.map(row => row.entityId);
  const targetAllocationIdSet = new Set(targetAllocationIds);
  const changedDispatchLines = rows('DISPATCH_LINE').filter(row => text(row.payload.dispatchId) === command.aggregateId);
  const changedAllocations = rows('DISPATCH_STOCK_ALLOCATION').filter(row => text(row.payload.dispatchId) === command.aggregateId
    || targetAllocationIdSet.has(row.entityId));
  if (documents.length !== 1 || !salesLines.length || !movements.length || !events.length || !reservations.length) {
    commandError('ORDERQ_CENTRAL_CONFIRM_RESULT_INCOMPLETE');
  }
  if (!targetLineIds.length || !targetAllocationIds.length) commandError('ORDERQ_CENTRAL_CONFIRM_TARGET_INCOMPLETE');
  requireExactIds(salesLines.map(row => row.payload.dispatchLineId), targetLineIds, 'ORDERQ_CENTRAL_CONFIRM_LINE_SET_MISMATCH');
  requireExactIds(changedDispatchLines.map(row => row.entityId), targetLineIds, 'ORDERQ_CENTRAL_CONFIRM_LINE_STATE_SET_MISMATCH');
  requireExactIds(movements.map(row => row.payload.sourceLineId), targetAllocationIds, 'ORDERQ_CENTRAL_CONFIRM_ALLOCATION_MOVEMENT_SET_MISMATCH');
  requireExactIds(changedAllocations.map(row => row.entityId), targetAllocationIds, 'ORDERQ_CENTRAL_CONFIRM_ALLOCATION_STATE_SET_MISMATCH');
  requireExactIds(reservations.map(row => row.payload.allocationId), targetAllocationIds, 'ORDERQ_CENTRAL_CONFIRM_RESERVATION_SET_MISMATCH');
  requireExactIds(events.map(row => row.payload.detail?.salesLineId), salesLines.map(row => row.entityId), 'ORDERQ_CENTRAL_CONFIRM_FULFILLMENT_SET_MISMATCH');
  if (changedDispatchLines.some(row => entityStatus(row) !== 'CONFIRMED')
    || changedAllocations.some(row => entityStatus(row) !== 'CONFIRMED')) {
    commandError('ORDERQ_CENTRAL_CONFIRM_TARGET_STATE_INVALID');
  }
  const document = documents[0].payload;
  if (text(document.dispatchId) !== command.aggregateId || text(document.erpPostingStatus).toUpperCase() !== 'READY') {
    commandError('ORDERQ_CENTRAL_CONFIRM_RESULT_INVALID');
  }
  const dispatchLineById = new Map(all('DISPATCH_LINE').map(row => [row.entityId, row.payload]));
  const allocationById = new Map(all('DISPATCH_STOCK_ALLOCATION').map(row => [row.entityId, row.payload]));
  const reservationByAllocation = new Map(reservations.map(row => [text(row.payload.allocationId), row.payload]));
  const salesLineIds = new Set(salesLines.map(row => row.entityId));
  for (const salesRow of salesLines) {
    const line = salesRow.payload;
    const dispatchLine = dispatchLineById.get(text(line.dispatchLineId));
    if (!dispatchLine || text(line.salesDocumentId) !== text(document.salesDocumentId)
      || text(dispatchLine.dispatchId) !== command.aggregateId
      || text(line.productId || line.actualProductId) !== text(dispatchLine.actualProductId || dispatchLine.productId)) {
      commandError('ORDERQ_CENTRAL_CONFIRM_SALES_LINK_INVALID', salesRow.entityId);
    }
    requireSameNumber(line.actualQuantity ?? line.quantity, dispatchLine.actualQuantity, 'ORDERQ_CENTRAL_CONFIRM_ACTUAL_QUANTITY_MISMATCH', salesRow.entityId);
    requireSameNumber(line.actualBaseQuantity, dispatchLine.actualBaseQuantity, 'ORDERQ_CENTRAL_CONFIRM_BASE_QUANTITY_MISMATCH', salesRow.entityId);
    requireSameNumber(line.recognizedOrderQuantity, dispatchLine.recognizedOrderQuantity, 'ORDERQ_CENTRAL_CONFIRM_RECOGNIZED_QUANTITY_MISMATCH', salesRow.entityId);
    const lineMovements = movements.filter(row => text(row.payload.dispatchLineId) === text(line.dispatchLineId));
    if (!lineMovements.length) commandError('ORDERQ_CENTRAL_CONFIRM_MOVEMENT_LINK_REQUIRED', salesRow.entityId);
    requireSameNumber(lineMovements.reduce((sum, row) => sum + finite(row.payload.signedBaseQuantity), 0), -finite(line.actualBaseQuantity), 'ORDERQ_CENTRAL_CONFIRM_MOVEMENT_QUANTITY_MISMATCH', salesRow.entityId);
    for (const movementRow of lineMovements) {
      const movement = movementRow.payload;
      const allocation = allocationById.get(text(movement.sourceLineId));
      const reservation = reservationByAllocation.get(text(movement.sourceLineId));
      if (text(movement.movementType).toUpperCase() !== 'SALE_ISSUE' || !(finite(movement.signedBaseQuantity) < 0)
        || text(movement.dispatchId) !== command.aggregateId
        || text(movement.productId) !== text(line.productId || line.actualProductId)
        || !allocation || text(allocation.dispatchLineId) !== text(line.dispatchLineId)
        || text(allocation.warehouseId) !== text(movement.warehouseId)
        || !reservation || entityStatus(reservation) !== 'CONSUMED'
        || text(reservation.reservationId) !== text(allocation.reservationId || reservation.reservationId)) {
        commandError('ORDERQ_CENTRAL_CONFIRM_MOVEMENT_LINK_INVALID', movementRow.entityId);
      }
      requireSameNumber(Math.abs(finite(movement.signedBaseQuantity)), allocation.actualBaseQuantity, 'ORDERQ_CENTRAL_CONFIRM_ALLOCATION_QUANTITY_MISMATCH', movementRow.entityId);
      requireSameNumber(Math.abs(finite(movement.signedBaseQuantity)), reservation.consumedBaseQuantity ?? reservation.reservedBaseQuantity, 'ORDERQ_CENTRAL_CONFIRM_RESERVATION_QUANTITY_MISMATCH', movementRow.entityId);
    }
    const allocationEvent = events.find(row => text(row.payload.detail?.salesLineId) === salesRow.entityId);
    if (!allocationEvent || text(allocationEvent.payload.eventType).toUpperCase() !== 'SALES_TRANSFER_ALLOCATED'
      || text(allocationEvent.payload.detail?.orderItemId) !== text(line.orderItemId || dispatchLine.orderItemId)) {
      commandError('ORDERQ_CENTRAL_CONFIRM_FULFILLMENT_LINK_INVALID', salesRow.entityId);
    }
    requireSameNumber(allocationEvent.payload.detail?.transferredQty, line.recognizedOrderQuantity, 'ORDERQ_CENTRAL_CONFIRM_FULFILLMENT_QUANTITY_MISMATCH', salesRow.entityId);
  }
  if (movements.some(row => !salesLines.some(line => text(line.payload.dispatchLineId) === text(row.payload.dispatchLineId)))
    || events.some(row => !salesLineIds.has(text(row.payload.detail?.salesLineId)))) {
    commandError('ORDERQ_CENTRAL_CONFIRM_ORPHAN_RESULT');
  }
  const postDispatchLines = all('DISPATCH_LINE').filter(row => targetLineIdSet.has(row.entityId));
  const postAllocations = all('DISPATCH_STOCK_ALLOCATION').filter(row => targetAllocationIdSet.has(row.entityId));
  const postReservations = all('INVENTORY_RESERVATION').filter(row => text(row.payload.dispatchId) === command.aggregateId
    || targetAllocationIdSet.has(text(row.payload.allocationId)));
  if (postDispatchLines.length !== targetLineIds.length || postDispatchLines.some(row => entityStatus(row) !== 'CONFIRMED')
    || postAllocations.length !== targetAllocationIds.length || postAllocations.some(row => entityStatus(row) !== 'CONFIRMED')
    || postReservations.some(row => entityStatus(row) === 'ACTIVE')) {
    commandError('ORDERQ_CENTRAL_CONFIRM_POST_STATE_INCOMPLETE');
  }
  requireSameNumber(document.supplyAmountWon, salesLines.reduce((sum, row) => sum + finite(row.payload.supplyAmountWon), 0), 'ORDERQ_CENTRAL_CONFIRM_SUPPLY_AMOUNT_MISMATCH');
  requireSameNumber(document.vatAmountWon, salesLines.reduce((sum, row) => sum + finite(row.payload.vatAmountWon), 0), 'ORDERQ_CENTRAL_CONFIRM_VAT_AMOUNT_MISMATCH');
  requireSameNumber(document.totalAmountWon, salesLines.reduce((sum, row) => sum + finite(row.payload.totalAmountWon), 0), 'ORDERQ_CENTRAL_CONFIRM_TOTAL_AMOUNT_MISMATCH');
}

function validatePurchaseConfirmationLedger(state, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const all = type => rowsWithMutations(state, mutations, type);
  const purchase = rows('PURCHASE_DOCUMENT').find(row => row.entityId === command.aggregateId);
  const lines = rows('PURCHASE_LINE').filter(row => text(row.payload.purchaseDocumentId) === command.aggregateId);
  const movements = rows('INVENTORY_MOVEMENT');
  const existingLines = Object.values(state.entities || {}).filter(row => row.entityType === 'PURCHASE_LINE'
    && text(row.payload.purchaseDocumentId) === command.aggregateId);
  const targetLineIds = existingLines.map(row => row.entityId);
  if (!purchase || entityStatus(purchase) !== 'CONFIRMED' || text(purchase.payload.erpPostingStatus).toUpperCase() !== 'READY'
    || !lines.length || movements.length !== lines.length) commandError('ORDERQ_CENTRAL_PURCHASE_RESULT_INVALID');
  if (!targetLineIds.length) commandError('ORDERQ_CENTRAL_PURCHASE_TARGET_INCOMPLETE');
  requireExactIds(lines.map(row => row.entityId), targetLineIds, 'ORDERQ_CENTRAL_PURCHASE_LINE_SET_MISMATCH');
  requireExactIds(movements.map(row => row.payload.sourceLineId), targetLineIds, 'ORDERQ_CENTRAL_PURCHASE_MOVEMENT_SET_MISMATCH');
  if (lines.some(row => entityStatus(row) !== 'CONFIRMED')) commandError('ORDERQ_CENTRAL_PURCHASE_LINE_STATE_INVALID');
  const movementByLine = new Map(movements.map(row => [text(row.payload.sourceLineId), row]));
  for (const lineRow of lines) {
    const line = lineRow.payload;
    const movementRow = movementByLine.get(lineRow.entityId);
    const movement = movementRow?.payload;
    if (!movement || text(movement.movementType).toUpperCase() !== 'PURCHASE_RECEIPT'
      || text(movement.sourceDocumentId) !== command.aggregateId
      || text(movement.productId) !== text(line.productId)
      || text(movement.warehouseId) !== text(line.warehouseId)
      || text(line.movementId) !== movementRow.entityId
      || !(finite(movement.signedBaseQuantity) > 0)) {
      commandError('ORDERQ_CENTRAL_PURCHASE_LINE_LINK_INVALID', lineRow.entityId);
    }
    requireSameNumber(movement.signedBaseQuantity, line.baseQuantity, 'ORDERQ_CENTRAL_PURCHASE_QUANTITY_MISMATCH', lineRow.entityId);
  }
  const targetLineIdSet = new Set(targetLineIds);
  const postLines = all('PURCHASE_LINE').filter(row => targetLineIdSet.has(row.entityId));
  if (postLines.length !== targetLineIds.length || postLines.some(row => entityStatus(row) !== 'CONFIRMED')) {
    commandError('ORDERQ_CENTRAL_PURCHASE_POST_STATE_INCOMPLETE');
  }
  requireSameNumber(purchase.payload.amountWon, lines.reduce((sum, row) => sum + finite(row.payload.amountWon), 0), 'ORDERQ_CENTRAL_PURCHASE_AMOUNT_MISMATCH');
}

function validateDispatchReversalLedger(state, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const originalDocuments = Object.values(state.entities).filter(row => row.entityType === 'SALES_DOCUMENT' && text(row.payload.dispatchId) === command.aggregateId);
  const originalLines = Object.values(state.entities).filter(row => row.entityType === 'SALES_LINE' && originalDocuments.some(document => text(row.payload.salesDocumentId) === document.entityId));
  const allExistingLines = Object.values(state.entities).filter(row => row.entityType === 'SALES_LINE');
  const originalMovements = Object.values(state.entities).filter(row => row.entityType === 'INVENTORY_MOVEMENT'
    && text(row.payload.dispatchId) === command.aggregateId && text(row.payload.movementType).toUpperCase() === 'SALE_ISSUE');
  const allExistingMovements = Object.values(state.entities).filter(row => row.entityType === 'INVENTORY_MOVEMENT');
  const reversalLines = rows('SALES_LINE');
  const reversalMovements = rows('INVENTORY_MOVEMENT');
  const events = rows('ORDER_EVENT').filter(row => text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED');
  if (!reversalLines.length || !reversalMovements.length || !events.length) commandError('ORDERQ_CENTRAL_DISPATCH_REVERSAL_RESULT_INVALID');
  for (const row of reversalLines) {
    const original = originalLines.find(candidate => candidate.entityId === text(row.payload.reversalOf));
    if (!original || finite(row.payload.actualQuantity) >= 0 || finite(row.payload.actualBaseQuantity) >= 0 || finite(row.payload.recognizedOrderQuantity) >= 0) {
      commandError('ORDERQ_CENTRAL_DISPATCH_REVERSAL_LINE_INVALID', row.entityId);
    }
    for (const field of ['actualQuantity','actualBaseQuantity','recognizedOrderQuantity','supplyAmountWon','vatAmountWon','totalAmountWon']) {
      const previous = allExistingLines.filter(candidate => text(candidate.payload.reversalOf) === original.entityId)
        .reduce((sum, candidate) => sum + Math.abs(finite(candidate.payload[field])), 0);
      if (previous + Math.abs(finite(row.payload[field])) > Math.abs(finite(original.payload[field])) + EPSILON) {
        commandError('ORDERQ_CENTRAL_DISPATCH_REVERSAL_EXCEEDS_ORIGINAL', `${row.entityId}:${field}`);
      }
    }
    const lineMovementTotal = reversalMovements.filter(candidate => text(candidate.payload.dispatchLineId) === text(row.payload.dispatchLineId))
      .reduce((sum, candidate) => sum + finite(candidate.payload.signedBaseQuantity), 0);
    requireSameNumber(lineMovementTotal, Math.abs(finite(row.payload.actualBaseQuantity)), 'ORDERQ_CENTRAL_DISPATCH_REVERSAL_MOVEMENT_MISMATCH', row.entityId);
    const event = events.find(candidate => text(candidate.payload.detail?.salesLineId) === row.entityId);
    if (!event) commandError('ORDERQ_CENTRAL_DISPATCH_REVERSAL_EVENT_REQUIRED', row.entityId);
    requireSameNumber(event.payload.detail?.transferredQty, Math.abs(finite(row.payload.recognizedOrderQuantity)), 'ORDERQ_CENTRAL_DISPATCH_REVERSAL_EVENT_MISMATCH', row.entityId);
  }
  for (const row of reversalMovements) {
    const original = originalMovements.find(candidate => candidate.entityId === text(row.payload.reversalOf));
    const previous = allExistingMovements.filter(candidate => text(candidate.payload.reversalOf) === text(row.payload.reversalOf))
      .reduce((sum, candidate) => sum + Math.abs(finite(candidate.payload.signedBaseQuantity)), 0);
    if (!original || text(row.payload.movementType).toUpperCase() !== 'REVERSAL' || !(finite(row.payload.signedBaseQuantity) > 0)
      || text(row.payload.productId) !== text(original.payload.productId)
      || text(row.payload.warehouseId) !== text(original.payload.warehouseId)
      || previous + finite(row.payload.signedBaseQuantity) > Math.abs(finite(original.payload.signedBaseQuantity)) + EPSILON) {
      commandError('ORDERQ_CENTRAL_DISPATCH_REVERSAL_MOVEMENT_INVALID', row.entityId);
    }
  }
}

function validatePurchaseReversalLedger(state, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const originalLines = Object.values(state.entities).filter(row => row.entityType === 'PURCHASE_LINE'
    && text(row.payload.purchaseDocumentId) === command.aggregateId);
  const allExistingLines = Object.values(state.entities).filter(row => row.entityType === 'PURCHASE_LINE');
  const allExistingMovements = Object.values(state.entities).filter(row => row.entityType === 'INVENTORY_MOVEMENT');
  const reversalLines = rows('PURCHASE_LINE');
  const reversalMovements = rows('INVENTORY_MOVEMENT');
  if (!reversalLines.length || reversalMovements.length !== reversalLines.length) commandError('ORDERQ_CENTRAL_PURCHASE_REVERSAL_RESULT_INVALID');
  const movementByLine = new Map(reversalMovements.map(row => [text(row.payload.sourceLineId), row]));
  for (const row of reversalLines) {
    const original = originalLines.find(candidate => candidate.entityId === text(row.payload.reversalOf));
    const movementRow = movementByLine.get(row.entityId);
    const movement = movementRow?.payload;
    if (!original || finite(row.payload.quantity) >= 0 || finite(row.payload.baseQuantity) >= 0 || finite(row.payload.amountWon) > 0
      || !movement || text(row.payload.movementId) !== movementRow.entityId
      || text(movement.reversalOf) !== text(original.payload.movementId)
      || text(movement.movementType).toUpperCase() !== 'REVERSAL' || !(finite(movement.signedBaseQuantity) < 0)
      || text(movement.productId) !== text(original.payload.productId)
      || text(movement.warehouseId) !== text(original.payload.warehouseId)) {
      commandError('ORDERQ_CENTRAL_PURCHASE_REVERSAL_LINE_INVALID', row.entityId);
    }
    requireSameNumber(movement.signedBaseQuantity, row.payload.baseQuantity, 'ORDERQ_CENTRAL_PURCHASE_REVERSAL_MOVEMENT_MISMATCH', row.entityId);
    for (const field of ['quantity','baseQuantity','amountWon']) {
      const previous = allExistingLines.filter(candidate => text(candidate.payload.reversalOf) === original.entityId)
        .reduce((sum, candidate) => sum + Math.abs(finite(candidate.payload[field])), 0);
      if (previous + Math.abs(finite(row.payload[field])) > Math.abs(finite(original.payload[field])) + EPSILON) {
        commandError('ORDERQ_CENTRAL_PURCHASE_REVERSAL_EXCEEDS_ORIGINAL', `${row.entityId}:${field}`);
      }
    }
    const originalMovement = allExistingMovements.find(candidate => candidate.entityId === text(original.payload.movementId));
    const previousMovement = allExistingMovements.filter(candidate => text(candidate.payload.reversalOf) === text(original.payload.movementId))
      .reduce((sum, candidate) => sum + Math.abs(finite(candidate.payload.signedBaseQuantity)), 0);
    if (!originalMovement || previousMovement + Math.abs(finite(movement.signedBaseQuantity)) > Math.abs(finite(originalMovement.payload.signedBaseQuantity)) + EPSILON) {
      commandError('ORDERQ_CENTRAL_PURCHASE_REVERSAL_MOVEMENT_EXCEEDS_ORIGINAL', row.entityId);
    }
  }
}

function validateCommandMutations(state, command, mutations) {
  const byType = type => mutations.filter(row => row.entityType === type);
  const decision = byType('DISPATCH_DECISION').find(row => row.entityId === command.aggregateId);
  const purchase = byType('PURCHASE_DOCUMENT').find(row => row.entityId === command.aggregateId);
  if (command.commandType === OFFICIAL_COMMAND_TYPE.RELEASE_DISPATCH) {
    if (!decision || entityStatus(decision) !== 'RELEASED' || !byType('INVENTORY_RESERVATION').length) {
      commandError('ORDERQ_CENTRAL_RELEASE_RESULT_INVALID');
    }
    if (byType('INVENTORY_MOVEMENT').length || byType('SALES_DOCUMENT').length || byType('ORDER_EVENT').length) {
      commandError('ORDERQ_CENTRAL_RELEASE_SIDE_EFFECT_FORBIDDEN');
    }
  }
  if (command.commandType === OFFICIAL_COMMAND_TYPE.CONFIRM_DISPATCH) {
    const salesDocuments = byType('SALES_DOCUMENT');
    const movements = byType('INVENTORY_MOVEMENT');
    const events = byType('ORDER_EVENT').filter(row => text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_ALLOCATED');
    if (!decision || entityStatus(decision) !== 'CONFIRMED' || salesDocuments.length !== 1 || !movements.length || !events.length) {
      commandError('ORDERQ_CENTRAL_CONFIRM_RESULT_INCOMPLETE');
    }
    if (salesDocuments[0].payload.erpPostingStatus !== 'READY'
      || movements.some(row => row.payload.movementType !== 'SALE_ISSUE' || !(finite(row.payload.signedBaseQuantity) <= 0))
      || byType('INVENTORY_RESERVATION').some(row => entityStatus(row) !== 'CONSUMED')) {
      commandError('ORDERQ_CENTRAL_CONFIRM_RESULT_INVALID');
    }
    validateDispatchConfirmationLedger(state, command, mutations);
  }
  if (command.commandType === OFFICIAL_COMMAND_TYPE.CONFIRM_PURCHASE) {
    const movements = byType('INVENTORY_MOVEMENT');
    if (!purchase || entityStatus(purchase) !== 'CONFIRMED' || purchase.payload.erpPostingStatus !== 'READY'
      || !movements.length || movements.some(row => row.payload.movementType !== 'PURCHASE_RECEIPT'
        || finite(row.payload.signedBaseQuantity) < 0)) {
      commandError('ORDERQ_CENTRAL_PURCHASE_RESULT_INVALID');
    }
    validatePurchaseConfirmationLedger(state, command, mutations);
  }
  if (command.commandType === OFFICIAL_COMMAND_TYPE.REVERSE_DISPATCH) {
    const reversalDecision = byType('DISPATCH_DECISION').find(row => row.payload.reversalOf === command.aggregateId);
    const salesDocument = byType('SALES_DOCUMENT').find(row => row.payload.reversalOf);
    const movements = byType('INVENTORY_MOVEMENT');
    const events = byType('ORDER_EVENT').filter(row => row.payload.eventType === 'SALES_TRANSFER_REVERSED');
    if (!reversalDecision || entityStatus(reversalDecision) !== 'CONFIRMED'
      || !salesDocument || entityStatus(salesDocument) !== 'REVERSED'
      || !movements.length || movements.some(row => row.payload.movementType !== 'REVERSAL')
      || !events.length) {
      commandError('ORDERQ_CENTRAL_DISPATCH_REVERSAL_RESULT_INVALID');
    }
    validateDispatchReversalLedger(state, command, mutations);
  }
  if (command.commandType === OFFICIAL_COMMAND_TYPE.REVERSE_PURCHASE) {
    const reversalDocument = byType('PURCHASE_DOCUMENT').find(row => row.payload.reversalOf === command.aggregateId);
    const movements = byType('INVENTORY_MOVEMENT');
    if (!reversalDocument || entityStatus(reversalDocument) !== 'REVERSED'
      || !movements.length || movements.some(row => row.payload.movementType !== 'REVERSAL'
        || finite(row.payload.signedBaseQuantity) > 0)) {
      commandError('ORDERQ_CENTRAL_PURCHASE_REVERSAL_RESULT_INVALID');
    }
    validatePurchaseReversalLedger(state, command, mutations);
  }
  if (command.commandType === OFFICIAL_COMMAND_TYPE.ADJUST_DISPATCH) {
    if (!byType('DISPATCH_RECONCILIATION').length
      || byType('INVENTORY_MOVEMENT').some(row => row.payload.movementType !== 'REVERSAL')
      || byType('DISPATCH_DECISION').some(row => row.entityId === command.aggregateId)) {
      commandError('ORDERQ_CENTRAL_DISPATCH_ADJUSTMENT_RESULT_INVALID');
    }
  }
  if ([OFFICIAL_COMMAND_TYPE.UPDATE_DISPATCH, OFFICIAL_COMMAND_TYPE.RECALL_DISPATCH].includes(command.commandType)
    && (byType('INVENTORY_MOVEMENT').length || byType('SALES_DOCUMENT').length
      || byType('PURCHASE_DOCUMENT').length || byType('ORDER_EVENT').length)) {
    commandError('ORDERQ_CENTRAL_UPDATE_MOVEMENT_FORBIDDEN');
  }
  if (command.commandType === OFFICIAL_COMMAND_TYPE.RECONCILE_PURCHASE_EXTERNAL
    && byType('INVENTORY_MOVEMENT').length) {
    commandError('ORDERQ_CENTRAL_PURCHASE_RECONCILIATION_MOVEMENT_FORBIDDEN');
  }
}

export function commitCentralCommand(state, source = {}, options = {}) {
  if (!state || state.schema !== CENTRAL_SCHEMA) commandError('ORDERQ_CENTRAL_STATE_INVALID');
  const idempotencyKey = text(source.idempotencyKey);
  const command = state.commands[idempotencyKey];
  if (!command) commandError('ORDERQ_CENTRAL_COMMAND_NOT_PREPARED', idempotencyKey);
  if (command.leaseToken !== text(source.leaseToken)) commandError('ORDERQ_CENTRAL_LEASE_INVALID', idempotencyKey);
  if (command.fingerprint !== text(source.fingerprint)) commandError('ORDERQ_CENTRAL_IDEMPOTENCY_CONFLICT', idempotencyKey);
  const commitAtMillis = nowMillis(source.now);
  const mutations = (Array.isArray(source.mutations) ? source.mutations : []).map(input => {
    const entityType = text(input.entityType).toUpperCase();
    const entityId = text(input.entityId);
    if (!OFFICIAL_TYPES.has(entityType) || !entityId || !input.payload) {
      commandError('ORDERQ_CENTRAL_MUTATION_INVALID', `${entityType}:${entityId}`);
    }
    return rowFromEntity(entityType, entityId, input.payload, input.revision);
  });
  const mutationFingerprint = stableJson(mutations.map(row => ({
    entityType:row.entityType, entityId:row.entityId, revision:row.revision, payload:row.payload
  })).sort((left, right) => entityKey(left.entityType, left.entityId).localeCompare(entityKey(right.entityType, right.entityId))));
  if (command.status === 'COMMITTED') {
    if (command.mutationFingerprint !== mutationFingerprint) {
      commandError('ORDERQ_CENTRAL_MUTATION_IDEMPOTENCY_CONFLICT', idempotencyKey);
    }
    return { duplicate: true, ...clone(command.result) };
  }
  if (command.status !== 'PREPARED') commandError('ORDERQ_CENTRAL_COMMAND_TERMINAL', `${idempotencyKey}:${command.status}`);
  if (leaseExpired(command, commitAtMillis)) {
    command.status = 'EXPIRED';
    command.expiredAt = new Date(commitAtMillis).toISOString();
    commandError('ORDERQ_CENTRAL_LEASE_EXPIRED', idempotencyKey);
  }
  if (command.inventoryResourceFingerprint !== inventoryResourceFingerprint(state)) {
    commandError('ORDERQ_CENTRAL_INVENTORY_REVISION_CONFLICT', command.aggregateId);
  }
  validateCommandMutations(state, command, mutations);
  const target = targetType(command.commandType)
    ? state.entities[entityKey(targetType(command.commandType), command.aggregateId)]
    : null;
  if (target && entityRevision(target) !== command.expectedRevision) {
    commandError('ORDERQ_CENTRAL_REVISION_CONFLICT', String(entityRevision(target)));
  }
  const working = createCentralAuthorityState(state);
  const workingCommand = working.commands[idempotencyKey];
  for (const row of mutations) {
    const key = entityKey(row.entityType, row.entityId);
    const prior = working.entities[key];
    if (row.entityType === targetType(command.commandType) && row.entityId === command.aggregateId
      && prior && entityRevision(prior) !== command.expectedRevision) {
      commandError('ORDERQ_CENTRAL_REVISION_CONFLICT', String(entityRevision(prior)));
    }
    if (command.commandType === OFFICIAL_COMMAND_TYPE.ERP_TRANSITION) {
      if (!prior || !['SALES_DOCUMENT', 'PURCHASE_DOCUMENT'].includes(row.entityType)
        || row.payload.baseRevision === undefined
        || Number(row.payload.baseRevision) !== entityRevision(prior)
        || !erpTransitionAllowed(prior.payload.erpPostingStatus, row.payload.erpPostingStatus)) {
        commandError('ORDERQ_CENTRAL_ERP_TRANSITION_INVALID', `${row.entityType}:${row.entityId}:${entityRevision(prior)}`);
      }
    }
    if (row.entityType === 'INVENTORY_MOVEMENT') {
      if (row.payload.ledgerSequence !== undefined && row.payload.ledgerSequence !== null) {
        delete row.payload.ledgerSequence;
      }
      working.ledgerSequence += 1;
      row.payload.ledgerSequence = working.ledgerSequence;
      row.revision = Math.max(row.revision, working.ledgerSequence);
    }
    row.payload.centralRevision = row.revision;
    row.payload.localOnly = false;
    working.entities[key] = clone(row);
  }
  if (text(options.failureAt).toUpperCase() === 'ENTITIES_WRITTEN') {
    commandError('ORDERQ_CENTRAL_FAILURE_INJECTED', 'ENTITIES_WRITTEN');
  }
  mutations.forEach(row => appendChange(working, row, command.deviceId, idempotencyKey));
  const result = {
    changes: clone(mutations),
    cursor: working.syncSequence,
    ledgerSequence: working.ledgerSequence,
    serverRevision: Math.max(...mutations.map(row => row.entityId === command.aggregateId ? row.revision : 0), command.expectedRevision)
  };
  workingCommand.status = 'COMMITTED';
  workingCommand.mutationFingerprint = mutationFingerprint;
  workingCommand.committedAt = new Date(commitAtMillis).toISOString();
  workingCommand.result = clone(result);
  if (text(options.failureAt).toUpperCase() === 'BEFORE_COMMIT') {
    commandError('ORDERQ_CENTRAL_FAILURE_INJECTED', 'BEFORE_COMMIT');
  }
  Object.assign(state, working);
  return { duplicate: false, ...result };
}

export function abortCentralCommand(state, source = {}) {
  const command = state?.commands?.[text(source.idempotencyKey)];
  if (!command || command.status === 'COMMITTED') return false;
  if (command.leaseToken !== text(source.leaseToken)) commandError('ORDERQ_CENTRAL_LEASE_INVALID');
  if (command.status !== 'PREPARED') return false;
  const abortAtMillis = nowMillis(source.now);
  if (leaseExpired(command, abortAtMillis)) {
    command.status = 'EXPIRED';
    command.expiredAt = new Date(abortAtMillis).toISOString();
    return false;
  }
  command.status = 'ABORTED';
  command.abortedAt = new Date(abortAtMillis).toISOString();
  command.abortReason = text(source.reason);
  return true;
}

export function pullCentralChanges(state, afterSequence = 0, limit = 500) {
  const after = Math.max(0, Number(afterSequence || 0));
  const selected = (state?.changes || []).filter(row => Number(row.sequence || 0) > after).slice(0, limit);
  return {
    changes: clone(selected),
    nextCursor: selected.length ? selected[selected.length - 1].sequence : after,
    hasMore: (state?.changes || []).some(row => Number(row.sequence || 0) > (selected.at(-1)?.sequence || after)),
    ledgerSequence: Number(state?.ledgerSequence || 0)
  };
}

export function centralInventoryProjection(state) {
  const rows = Object.values(state?.entities || {});
  return calculateInventoryShadowProjection({
    snapshots: rows.filter(row => row.entityType === 'INVENTORY_SNAPSHOT').map(row => row.payload),
    inventoryLines: rows.filter(row => row.entityType === 'INVENTORY_LINE').map(row => row.payload),
    movements: rows.filter(row => row.entityType === 'INVENTORY_MOVEMENT').map(row => row.payload),
    reservations: rows.filter(row => row.entityType === 'INVENTORY_RESERVATION').map(row => row.payload),
    warehouses: rows.filter(row => row.entityType === 'WAREHOUSE').map(row => row.payload)
  }).rows;
}
