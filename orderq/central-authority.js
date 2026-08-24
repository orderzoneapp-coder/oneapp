import { calculateInventoryShadowProjection } from './inventory-ledger.js?v=0.8.0';
import { canonicalSha256, planOfficialVoucherCommand } from './official-voucher-core.js?v=0.17.0';

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
  POST_PURCHASE: 'POST_PURCHASE',
  CORRECT_PURCHASE: 'CORRECT_PURCHASE',
  POST_SALE: 'POST_SALE',
  CORRECT_SALE: 'CORRECT_SALE',
  REVERSE_SALE: 'REVERSE_SALE',
  ERP_TRANSITION: 'ERP_TRANSITION'
});

const COMMAND_TYPES = new Set(Object.values(OFFICIAL_COMMAND_TYPE));
const MIGRATION_TYPES = new Set([
  'ORDER', 'ORDER_ITEM', 'PRODUCT', 'WAREHOUSE', 'INVENTORY_SNAPSHOT', 'INVENTORY_LINE',
  'DISPATCH_DECISION', 'DISPATCH_LINE', 'DISPATCH_STOCK_ALLOCATION',
  'PURCHASE_DOCUMENT', 'PURCHASE_LINE', 'SALES_DOCUMENT', 'SALES_LINE'
]);
const OFFICIAL_TYPES = new Set([
  ...MIGRATION_TYPES,
  'DISPATCH_APPROVAL', 'INVENTORY_RESERVATION', 'INVENTORY_MOVEMENT', 'DISPATCH_RECONCILIATION',
  'SALES_DOCUMENT', 'SALES_LINE', 'ORDER_EVENT',
  'VOUCHER_EVENT', 'RECEIVABLE_ENTRY', 'PAYABLE_ENTRY'
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
    transactions: clone(source.transactions || {}),
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
  const voucherCommands = ['POST_PURCHASE', 'CORRECT_PURCHASE', 'POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'];
  if (voucherCommands.includes(commandType) && text(source.intent?.commandContract).toUpperCase() !== 'VOUCHER_CORE_V1') {
    commandError('ORDERQ_CENTRAL_COMMAND_CONTRACT_REQUIRED', commandType);
  }
  if (text(source.intent?.commandContract).toUpperCase() === 'VOUCHER_CORE_V1'
    && text(source.intent?.commandId) !== idempotencyKey) commandError('ORDERQ_CENTRAL_COMMAND_IDEMPOTENCY_MISMATCH');
  return canonicalSha256({
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
  if (commandType.includes('PURCHASE')) return 'PURCHASE_DOCUMENT';
  if (commandType.includes('SALE')) return 'SALES_DOCUMENT';
  return commandType === OFFICIAL_COMMAND_TYPE.ERP_TRANSITION ? '' : 'DISPATCH_DECISION';
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
    POST_PURCHASE: ['DRAFT'],
    CORRECT_PURCHASE: ['CONFIRMED'],
    POST_SALE: ['DRAFT'],
    CORRECT_SALE: ['CONFIRMED'],
    REVERSE_SALE: ['CONFIRMED'],
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

function migrationEntityDigest(rowsSource) {
  return stableJson((rowsSource || []).map(row => ({
    entityKey: entityKey(row.entityType, row.entityId),
    entityType: text(row.entityType).toUpperCase(),
    entityId: text(row.entityId),
    revision: Number(row.revision || 0),
    status: text(row.status).toUpperCase(),
    payload: row.payload || {}
  })).sort((left, right) => left.entityKey.localeCompare(right.entityKey)));
}

function migrationChangeDigest(rowsSource) {
  return stableJson((rowsSource || []).map(row => ({
    sequence: Number(row.sequence || 0),
    deviceId: text(row.deviceId),
    commandId: text(row.commandId),
    entityType: text(row.entityType).toUpperCase(),
    entityId: text(row.entityId),
    revision: Number(row.revision || 0),
    payload: row.payload || {}
  })).sort((left, right) => left.sequence - right.sequence));
}

function centralMigrationComplete(state, transaction) {
  const summary = transaction?.next || {};
  const targetKeys = Array.isArray(summary.targetEntityKeys) ? summary.targetEntityKeys : [];
  const rows = targetKeys.map(key => state.entities[key]).filter(Boolean);
  if (rows.length !== Number(summary.targetEntityCount || 0)) return false;
  if (migrationEntityDigest(rows) !== summary.targetEntityDigest) return false;
  const changes = state.changes.filter(row => row.commandId === transaction.idempotencyKey);
  if (changes.length !== Number(summary.changeCount || 0)) return false;
  if (migrationChangeDigest(changes) !== summary.changeDigest) return false;
  if (state.syncSequence < Number(summary.endCursor || 0)) return false;
  const command = state.commands[transaction.idempotencyKey];
  return Boolean(command
    && command.status === 'COMMITTED'
    && command.fingerprint === summary.fingerprint
    && command.result?.transactionId === transaction.transactionId
    && command.result?.targetEntityDigest === summary.targetEntityDigest
    && command.result?.changeDigest === summary.changeDigest);
}

export function recoverPreparedCentralMigrations(stateSource) {
  const state = stateSource;
  const incomplete = Object.values(state?.transactions || {})
    .filter(row => ['PREPARED', 'RECOVERY_REQUIRED'].includes(text(row.status).toUpperCase()));
  const outcomes = [];
  for (const transaction of incomplete) {
    if (centralMigrationComplete(state, transaction)) {
      transaction.status = 'COMMITTED';
      transaction.error = '';
      outcomes.push({ transactionId:transaction.transactionId, status:'COMMITTED' });
      continue;
    }
    for (const key of transaction.previous?.pendingEntityKeys || []) delete state.entities[key];
    state.changes = state.changes.filter(row => row.commandId !== transaction.idempotencyKey);
    state.syncSequence = Number(transaction.previous?.previousSyncSequence || 0);
    delete state.commands[transaction.idempotencyKey];
    transaction.status = 'ROLLED_BACK';
    transaction.error = transaction.error || 'RECOVERED_INCOMPLETE_MIGRATION';
    outcomes.push({ transactionId:transaction.transactionId, status:'ROLLED_BACK' });
  }
  return outcomes;
}

function enforceCentralMigrationBoundary(state) {
  const incomplete = Object.values(state?.transactions || {})
    .filter(row => ['PREPARED', 'RECOVERY_REQUIRED'].includes(text(row.status).toUpperCase()));
  if (!incomplete.length) return;
  const outcomes = recoverPreparedCentralMigrations(state);
  commandError('ORDERQ_CENTRAL_MIGRATION_RECOVERY_COMPLETED_RETRY', outcomes.map(row => `${row.transactionId}:${row.status}`).join(','));
}

export function migrateCentralDrafts(stateSource, source = {}, options = {}) {
  const state = stateSource;
  if (!state || state.schema !== CENTRAL_SCHEMA) commandError('ORDERQ_CENTRAL_STATE_INVALID');
  enforceCentralMigrationBoundary(state);
  const idempotencyKey = text(source.idempotencyKey);
  if (!idempotencyKey) commandError('ORDERQ_CENTRAL_MIGRATION_KEY_REQUIRED');
  const entities = Array.isArray(source.entities) ? source.entities : [];
  const normalizedByKey = new Map();
  for (const input of entities) {
    const type = text(input.entityType).toUpperCase();
    const id = text(input.entityId);
    const payload = clone(input.payload);
    if (!MIGRATION_TYPES.has(type) || !id || !payload) commandError('ORDERQ_CENTRAL_MIGRATION_ENTITY_INVALID', `${type}:${id}`);
    if (type === 'DISPATCH_DECISION' && entityStatus(payload) !== 'DRAFT') commandError('ORDERQ_CENTRAL_MIGRATION_DISPATCH_DRAFT_ONLY', id);
    if (type === 'PURCHASE_DOCUMENT' && entityStatus(payload) !== 'DRAFT') commandError('ORDERQ_CENTRAL_MIGRATION_PURCHASE_DRAFT_ONLY', id);
    if (type === 'SALES_DOCUMENT' && entityStatus(payload) !== 'DRAFT') commandError('ORDERQ_CENTRAL_MIGRATION_SALE_DRAFT_ONLY', id);
    if (payload.localOnly === false || payload.centralRevision || payload.ledgerSequence) {
      commandError('ORDERQ_CENTRAL_MIGRATION_EVIDENCE_INVALID', `${type}:${id}`);
    }
    const row = rowFromEntity(type, id, payload, input.revision);
    row.payload.localOnly = false;
    row.payload.centralRevision = row.revision;
    const key = entityKey(type, id);
    const duplicate = normalizedByKey.get(key);
    if (duplicate && stableJson(duplicate) !== stableJson(row)) commandError('ORDERQ_CENTRAL_MIGRATION_CONFLICT', `${type}:${id}`);
    normalizedByKey.set(key, row);
  }
  const normalized = [...normalizedByKey.values()]
    .sort((left, right) => entityKey(left.entityType, left.entityId).localeCompare(entityKey(right.entityType, right.entityId)));
  const migrationRows = new Map(Object.values(state.entities || {}).map(row => [entityKey(row.entityType, row.entityId), row]));
  normalized.forEach(row => migrationRows.set(entityKey(row.entityType, row.entityId), row));
  assertNoNormalizedOriginDuplicate([...migrationRows.values()]);
  const fingerprint = stableJson(normalized.map(row => ({
    entityType:row.entityType, entityId:row.entityId, revision:row.revision, payload:row.payload
  })));
  const prior = state.commands[idempotencyKey];
  if (prior) {
    if (prior.fingerprint !== fingerprint) commandError('ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_CONFLICT', idempotencyKey);
    const transaction = state.transactions?.[prior.result?.transactionId];
    if (!transaction || transaction.status !== 'COMMITTED' || !centralMigrationComplete(state, transaction)) {
      commandError('ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_STATE_MISMATCH', idempotencyKey);
    }
    return {
      duplicate: true,
      changes: clone(state.changes.filter(row => row.commandId === idempotencyKey)),
      cursor: state.syncSequence
    };
  }
  const working = createCentralAuthorityState(state);
  const changes = [];
  const pendingEntityKeys = [];
  const previousSyncSequence = working.syncSequence;
  for (const row of normalized) {
    const key = entityKey(row.entityType, row.entityId);
    const existing = working.entities[key];
    if (existing && stableJson(existing.payload) !== stableJson(row.payload)) {
      commandError('ORDERQ_CENTRAL_MIGRATION_CONFLICT', `${row.entityType}:${row.entityId}`);
    }
    if (!existing) {
      working.entities[key] = row;
      pendingEntityKeys.push(key);
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
  const transactionId = text(source.transactionId) || `${idempotencyKey}:MIGRATION`;
  const commandChanges = working.changes.filter(row => row.commandId === idempotencyKey);
  const summary = {
    transactionId,
    fingerprint,
    targetEntityCount: normalized.length,
    targetEntityKeys: normalized.map(row => entityKey(row.entityType, row.entityId)),
    targetEntityDigest: migrationEntityDigest(normalized),
    changeCount: commandChanges.length,
    changeDigest: migrationChangeDigest(commandChanges),
    startCursor: previousSyncSequence,
    endCursor: working.syncSequence
  };
  working.transactions[transactionId] = {
    transactionId,
    idempotencyKey,
    status: 'PREPARED',
    previous: { previousSyncSequence, pendingEntityKeys },
    next: clone(summary),
    error: ''
  };
  working.commands[idempotencyKey] = {
    type: 'MIGRATION', commandType:'MIGRATION', fingerprint, status: 'COMMITTED',
    result: clone(summary)
  };
  if (text(options.failureAt).toUpperCase() === 'COMMAND_WRITTEN') {
    commandError('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED', 'COMMAND_WRITTEN');
  }
  working.transactions[transactionId].status = 'COMMITTED';
  if (!centralMigrationComplete(working, working.transactions[transactionId])) {
    commandError('ORDERQ_CENTRAL_MIGRATION_COMPLETENESS_FAILED', idempotencyKey);
  }
  Object.assign(state, working);
  return { duplicate: false, changes, cursor: state.syncSequence };
}

export function prepareCentralCommand(state, source = {}) {
  if (!state || state.schema !== CENTRAL_SCHEMA) commandError('ORDERQ_CENTRAL_STATE_INVALID');
  enforceCentralMigrationBoundary(state);
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
    if (prior.status === 'COMMITTED') return { duplicate: true, committed: true, fingerprint, result: clone(prior.result) };
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
  if (target && text(source.intent?.commandContract).toUpperCase() === 'VOUCHER_CORE_V1'
    && text(target.payload?.documentContract).toUpperCase() !== 'VOUCHER_CORE_V1') {
    commandError('ORDERQ_CENTRAL_COMMAND_CONTRACT_MISMATCH', aggregateId);
  }
  if (target && commandType.startsWith('POST_') && text(source.intent?.commandContract).toUpperCase() === 'VOUCHER_CORE_V1') {
    const allRows = Object.values(state.entities || {});
    const duplicateKey = normalizedOriginKeys(target, allRows).find(key => allRows.some(row => row.entityId !== aggregateId
      && ['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].includes(row.entityType)
      && normalizedOriginKeys(row, allRows).includes(key)));
    if (duplicateKey) commandError('ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED', duplicateKey);
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
    intent: clone(source.intent || null),
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

function validateMutationEntityKeys(mutations) {
  const keys = new Set();
  for (const row of mutations) {
    const key = entityKey(row.entityType, row.entityId);
    if (!text(row.entityType) || !text(row.entityId)) commandError('ORDERQ_CENTRAL_MUTATION_INVALID', `${row.entityType}:${row.entityId}`);
    if (keys.has(key)) commandError('ORDERQ_CENTRAL_MUTATION_ENTITY_DUPLICATE', `${row.entityType}:${row.entityId}`);
    keys.add(key);
  }
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

function normalizedOriginKeys(documentRow, allRows = []) {
  if (!documentRow || !['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].includes(documentRow.entityType)) return [];
  const payload = documentRow.payload || {};
  const kind = documentRow.entityType === 'PURCHASE_DOCUMENT' ? 'PURCHASE' : 'SALE';
  const documentIdField = kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const lineType = kind === 'PURCHASE' ? 'PURCHASE_LINE' : 'SALES_LINE';
  const lines = allRows.filter(row => row.entityType === lineType && text(row.payload?.[documentIdField]) === documentRow.entityId);
  const keys = new Set();
  if (kind === 'SALE') {
    const pairs = lines.map(row => [text(row.payload?.sourceDispatchId || row.payload?.dispatchId), text(row.payload?.sourceDispatchLineId || row.payload?.dispatchLineId)])
      .filter(pair => pair[0] || pair[1]);
    if (!pairs.length && text(payload.dispatchId || payload.sourceDispatchId)) pairs.push([text(payload.dispatchId || payload.sourceDispatchId), text(payload.dispatchLineId || payload.sourceDispatchLineId)]);
    pairs.forEach(pair => keys.add(`SALE:DISPATCH:${pair[0]}:${pair[1]}`));
    const salesOrigin = text(payload.salesOriginId || payload.sourceSalesDocumentId || payload.sourceSalesId);
    if (salesOrigin) keys.add(`SALE:ORIGIN:${salesOrigin}`);
  } else {
    const purchaseOrigin = text(payload.shortageId || payload.purchaseOriginId || payload.sourcePurchaseId || payload.purchasePlanId);
    if (purchaseOrigin) keys.add(`PURCHASE:ORIGIN:${purchaseOrigin}`);
  }
  const sourceKey = text(payload.sourceDocumentKey);
  if (sourceKey) keys.add(`${kind}:SOURCE:${sourceKey}`);
  return [...keys].sort();
}

function assertNoNormalizedOriginDuplicate(rows) {
  const owner = new Map();
  rows.filter(row => ['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].includes(row.entityType)).forEach(document => {
    normalizedOriginKeys(document, rows).forEach(key => {
      const prior = owner.get(key);
      if (prior && prior !== document.entityId) commandError('ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED', key);
      owner.set(key, document.entityId);
    });
  });
}

function roundOfficialWon(value) {
  const number = finite(value);
  return Math.sign(number) * Math.floor(Math.abs(number) + 0.5);
}

function validateOfficialVoucherLedger(state, command, mutations) {
  const purchase = command.commandType.endsWith('PURCHASE');
  const reverse = command.commandType.startsWith('REVERSE_');
  const documentType = purchase ? 'PURCHASE_DOCUMENT' : 'SALES_DOCUMENT';
  const lineType = purchase ? 'PURCHASE_LINE' : 'SALES_LINE';
  const entryType = purchase ? 'PAYABLE_ENTRY' : 'RECEIVABLE_ENTRY';
  const documentIdField = purchase ? 'purchaseDocumentId' : 'salesDocumentId';
  const lineIdField = purchase ? 'purchaseLineId' : 'salesLineId';
  const rows = type => mutations.filter(row => row.entityType === type);
  const documentRow = rows(documentType).find(row => row.entityId === command.aggregateId);
  const document = documentRow?.payload;
  const previousDocument = state.entities[entityKey(documentType, command.aggregateId)]?.payload || {};
  const projectionLines = rows(lineType).filter(row => text(row.payload[documentIdField]) === command.aggregateId);
  const lines = projectionLines.filter(row => text(row.payload.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED' && entityStatus(row) === 'CONFIRMED');
  const movements = rows('INVENTORY_MOVEMENT');
  const events = rows('VOUCHER_EVENT');
  const entries = rows(entryType);
  const orderEvents = rows('ORDER_EVENT');
  const existingCurrentLines = Object.values(state.entities || {}).filter(row => row.entityType === lineType
    && text(row.payload?.[documentIdField]) === command.aggregateId && entityStatus(row) !== 'REVERSED');
  const existingProjectionLines = existingCurrentLines.filter(row => row.entityType === lineType
    && text(row.payload?.[documentIdField]) === command.aggregateId
    && text(row.payload?.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED');
  if (!document || entityStatus(documentRow) !== (reverse ? 'REVERSED' : 'CONFIRMED')
    || Number(documentRow.revision || 0) !== command.expectedRevision + 1
    || events.length !== 1 || !entries.length) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_VOUCHER_RESULT_INVALID', command.aggregateId);
  }
  const allowedTypes = new Set([documentType, lineType, 'INVENTORY_MOVEMENT', 'VOUCHER_EVENT', entryType]);
  if (!purchase) allowedTypes.add('ORDER_EVENT');
  if (mutations.some(row => !allowedTypes.has(row.entityType))) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_MUTATION_SCOPE_INVALID', command.aggregateId);
  }
  if (rows(documentType).length !== 1 || events.length !== 1) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_CARDINALITY_INVALID', command.aggregateId);
  }
  const existingIdentities = (reverse ? existingCurrentLines : existingProjectionLines).map(row => text(row.payload?.lineIdentityId));
  const intendedIdentities = Array.isArray(command.intent?.lines) ? command.intent.lines.map(row => text(row.lineIdentityId)) : [];
  const expectedIdentities = new Set(reverse ? existingIdentities
    : command.commandType.startsWith('POST_') ? intendedIdentities.length ? intendedIdentities : existingIdentities
      : [...existingIdentities, ...intendedIdentities]);
  const projectedIdentities = projectionLines.map(row => text(row.payload?.lineIdentityId));
  if ([...expectedIdentities].some(identity => !identity) || projectedIdentities.some(identity => !identity)
    || new Set(projectedIdentities).size !== projectedIdentities.length
    || projectionLines.length !== expectedIdentities.size || projectedIdentities.some(identity => !expectedIdentities.has(identity))) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_LINE_CARDINALITY_INVALID', command.aggregateId);
  }
  if (reverse && projectionLines.some(row => entityStatus(row) !== 'REVERSED')) commandError('ORDERQ_CENTRAL_OFFICIAL_REVERSE_TOMBSTONE_INVALID', command.aggregateId);
  if (command.commandType.startsWith('POST_') && movements.length !== lines.length) commandError('ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_CARDINALITY_INVALID', command.aggregateId);
  if (command.commandType.startsWith('CORRECT_')) {
    const beforeByIdentity = new Map(existingProjectionLines.map(row => [text(row.payload?.lineIdentityId), row.payload]));
    const afterActive = projectionLines.filter(row => text(row.payload?.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED');
    const afterByIdentity = new Map(afterActive.map(row => [text(row.payload?.lineIdentityId), row.payload]));
    const expectedEffects = [];
    for (const identity of new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])) {
      const beforeLine = beforeByIdentity.get(identity); const afterLine = afterByIdentity.get(identity);
      const sameInventory = beforeLine && afterLine && text(beforeLine.productId) === text(afterLine.productId) && text(beforeLine.warehouseId) === text(afterLine.warehouseId);
      if (sameInventory) expectedEffects.push({ identity, effectKind:'DELTA', reversalOf:'' });
      else {
        if (beforeLine) {
          const residuals = residualOfficialMovements(state, command.aggregateId, identity);
          const reversalTargets = residuals.length ? residuals.map(row => row.entityId) : [text(beforeLine.movementId)];
          reversalTargets.forEach(reversalOf => expectedEffects.push({ identity, effectKind:'REVERSE_OLD', reversalOf }));
        }
        if (afterLine) expectedEffects.push({ identity, effectKind:'APPLY_NEW', reversalOf:'' });
      }
    }
    const actualEffects = movements.map(row => ({ identity:text(row.payload?.lineIdentityId), effectKind:text(row.payload?.effectKind), reversalOf:text(row.payload?.reversalOf) }));
    const effectKey = row => `${row.identity}\u001f${row.effectKind}\u001f${row.reversalOf}`;
    requireExactIds(actualEffects.map(effectKey), expectedEffects.map(effectKey), 'ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_CARDINALITY_INVALID');
    for (const [identity] of beforeByIdentity) if (!afterByIdentity.has(identity)
      && !projectionLines.some(row => text(row.payload?.lineIdentityId) === identity && text(row.payload?.lineStatus).toUpperCase() === 'DELETED')) {
      commandError('ORDERQ_CENTRAL_OFFICIAL_LINE_TOMBSTONE_REQUIRED', identity);
    }
  }
  if (reverse) {
    const expectedReversalIds = existingCurrentLines.flatMap(row => residualOfficialMovements(state, command.aggregateId, text(row.payload?.lineIdentityId)).map(effect => effect.entityId));
    if (movements.some(row => text(row.payload?.effectKind) !== 'REVERSE_OLD')) commandError('ORDERQ_CENTRAL_OFFICIAL_REVERSE_MOVEMENT_CARDINALITY_INVALID', command.aggregateId);
    requireExactIds(movements.map(row => row.payload?.reversalOf), expectedReversalIds, 'ORDERQ_CENTRAL_OFFICIAL_REVERSE_MOVEMENT_CARDINALITY_INVALID');
  }
  const intent = command.intent || {};
  if (!text(intent.commandId) || !text(intent.actor) || !text(intent.occurredAt)
    || (!command.commandType.startsWith('POST_') && !text(intent.reason))) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_COMMAND_AUDIT_REQUIRED', command.aggregateId);
  }
  validateExactOfficialEffects(state, command, mutations, { purchase, documentType, lineType, entryType, document, projectionLines, movements, entries, orderEvents });
  const event = events[0].payload;
  const expectedEventType = `${purchase ? 'PURCHASE' : 'SALE'}_${command.commandType.startsWith('POST_') ? 'POSTED' : command.commandType.startsWith('CORRECT_') ? 'CORRECTED' : 'REVERSED'}`;
  if (text(event.documentId) !== command.aggregateId || text(event.eventType).toUpperCase() !== expectedEventType
    || text(event.commandId) !== text(intent.commandId) || Number(event.sourceDocumentRevision || 0) !== command.expectedRevision + 1) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_VOUCHER_EVENT_INVALID', command.aggregateId);
  }
  const declaredEffects = new Set((event.lineEffects || []).map(row => `${text(row.entityType).toUpperCase()}:${text(row.entityId)}`));
  const actualEffects = [
    ...movements.map(row => `INVENTORY_MOVEMENT:${row.entityId}`),
    ...orderEvents.map(row => `ORDER_EVENT:${row.entityId}`),
    ...entries.map(row => `${entryType}:${row.entityId}`)
  ];
  if (declaredEffects.size !== actualEffects.length || actualEffects.some(key => !declaredEffects.has(key))) {
    commandError('ORDERQ_CENTRAL_OFFICIAL_EFFECT_CARDINALITY_INVALID', command.aggregateId);
  }
  if (reverse) {
    const expectedReversalType = `${text(document.sourceType).toUpperCase()}_${purchase ? 'PURCHASE' : 'SALE'}_REVERSAL`;
    if (movements.some(row => text(row.payload.movementType).toUpperCase() !== expectedReversalType)) {
      commandError('ORDERQ_CENTRAL_OFFICIAL_REVERSAL_MOVEMENT_INVALID', command.aggregateId);
    }
  } else {
    if (!lines.length || !movements.length) commandError('ORDERQ_CENTRAL_OFFICIAL_LINES_REQUIRED', command.aggregateId);
    const operationType = command.commandType.startsWith('POST_') ? 'POST' : 'CORRECTION';
    const expectedMovementType = `${text(document.sourceType).toUpperCase()}_${purchase ? 'PURCHASE' : 'SALE'}_${operationType}`;
    const reversalType = `${text(document.sourceType).toUpperCase()}_${purchase ? 'PURCHASE' : 'SALE'}_REVERSAL`;
    if (movements.some(row => ![expectedMovementType, reversalType].includes(text(row.payload.movementType).toUpperCase()))) {
      commandError('ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_TYPE_INVALID', command.aggregateId);
    }
    for (const lineRow of lines) {
      const line = lineRow.payload;
      const supply = roundOfficialWon(finite(line.quantity) * finite(line.unitPrice));
      if (!sameNumber(line.supplyAmount, supply) || !sameNumber(line.totalAmount, supply)
        || line.vatAmount !== null || text(line.taxType) !== 'VAT_INCLUDED_IN_SUPPLY') {
        commandError('ORDERQ_CENTRAL_OFFICIAL_LINE_AMOUNT_INVALID', text(line[lineIdField]));
      }
    }
    const supply = lines.reduce((sum, row) => sum + finite(row.payload.supplyAmount), 0);
    if (!sameNumber(document.supplyAmount, supply) || !sameNumber(document.totalAmount, supply)
      || document.vatAmount !== null || text(document.taxType) !== 'VAT_INCLUDED_IN_SUPPLY') {
      commandError('ORDERQ_CENTRAL_OFFICIAL_DOCUMENT_AMOUNT_INVALID', command.aggregateId);
    }
  }
  for (const movement of movements) {
    if (text(movement.payload.commandId) !== text(intent.commandId)
      || movement.payload.officialCommandProofRequired !== true
      || text(movement.payload.sourceDocumentId) !== command.aggregateId) {
      commandError('ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_PROOF_INVALID', movement.entityId);
    }
    if (text(movement.payload.reversalOf)) {
      const original = state.entities[entityKey('INVENTORY_MOVEMENT', text(movement.payload.reversalOf))]?.payload;
      if (!original || original.officialCommandProofRequired !== true
        || !text(original.commandId) || text(original.sourceDocumentId) !== command.aggregateId
        || !/^(DIRECT|ORDER_Q)_(PURCHASE|SALE)$/.test(text(original.sourceDocumentType).toUpperCase())) {
        commandError('ORDERQ_CENTRAL_OFFICIAL_REVERSAL_PROOF_INVALID', movement.entityId);
      }
    }
  }
  if (!purchase) {
    if (text(document.sourceType).toUpperCase() === 'DIRECT' && orderEvents.length) {
      commandError('ORDERQ_CENTRAL_DIRECT_ORDER_EVENT_FORBIDDEN', command.aggregateId);
    }
    if (text(document.sourceType).toUpperCase() === 'DIRECT' && projectionLines.some(row => text(row.payload?.orderLinkMode).toUpperCase() === 'ORDER_Q'
      || text(row.payload?.sourceOrderId) || text(row.payload?.sourceOrderItemId) || text(row.payload?.sourceDispatchId)
      || text(row.payload?.sourceDispatchLineId) || text(row.payload?.allocationEventId)
      || (Array.isArray(row.payload?.allocationEventIds) && row.payload.allocationEventIds.some(text)))) {
      commandError('ORDERQ_CENTRAL_DIRECT_ORDER_LINK_FORBIDDEN', command.aggregateId);
    }
    if (text(document.sourceType).toUpperCase() === 'ORDER_Q') {
      for (const eventRow of orderEvents) {
        const itemId = text(eventRow.payload?.detail?.orderItemId);
        const orderId = text(eventRow.payload?.orderId);
        const item = state.entities[entityKey('ORDER_ITEM', itemId)];
        const eventType = text(eventRow.payload?.eventType).toUpperCase();
        const dispatchId = text(eventRow.payload?.detail?.sourceDispatchId);
        const dispatchLineId = text(eventRow.payload?.detail?.sourceDispatchLineId);
        const hasDispatch = Boolean(dispatchId);
        const dispatchLine = hasDispatch ? state.entities[entityKey('DISPATCH_LINE', dispatchLineId)] : null;
        const eventLine = projectionLines.find(row => text(row.payload?.salesLineId) === text(eventRow.payload?.detail?.salesLineId));
        const allocatedLineInvalid = eventType === 'SALES_TRANSFER_ALLOCATED' && (text(eventLine?.payload?.sourceOrderId) !== orderId
          || text(eventLine?.payload?.sourceOrderItemId) !== itemId || text(eventLine?.payload?.sourceDispatchId) !== dispatchId
          || text(eventLine?.payload?.sourceDispatchLineId) !== dispatchLineId);
        if (!item || !state.entities[entityKey('ORDER', orderId)] || text(item.payload?.orderId) !== orderId
          || hasDispatch !== Boolean(dispatchLineId)
          || (hasDispatch && (!dispatchLine || text(dispatchLine.payload?.dispatchId) !== dispatchId || text(dispatchLine.payload?.orderItemId) !== itemId))
          || !eventLine || text(eventRow.payload?.detail?.salesDocumentId) !== command.aggregateId
          || allocatedLineInvalid
          || !['SALES_TRANSFER_ALLOCATED', 'SALES_TRANSFER_REVERSED'].includes(eventType)) {
          commandError('ORDERQ_CENTRAL_ORDER_EVENT_LINK_INVALID', eventRow.entityId);
        }
        if (eventType === 'SALES_TRANSFER_REVERSED') {
          const allocationId = text(eventRow.payload?.detail?.allocationEventId);
          const allocation = state.entities[entityKey('ORDER_EVENT', allocationId)];
          const priorReversed = Object.values(state.entities || {}).filter(candidate => candidate.entityType === 'ORDER_EVENT'
            && text(candidate.payload?.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED'
            && text(candidate.payload?.detail?.allocationEventId) === allocationId)
            .reduce((sum, candidate) => sum + finite(candidate.payload?.detail?.transferredQty), 0);
          const negativePost = command.commandType === 'POST_SALE';
          const allocationLinkInvalid = negativePost
            ? text(allocation?.payload?.detail?.productId) !== text(eventLine.payload?.productId)
              || text(allocation?.payload?.detail?.lineIdentityId) !== text(eventLine.payload?.lineIdentityId)
              || (text(allocation?.payload?.detail?.warehouseId) && text(allocation?.payload?.detail?.warehouseId) !== text(eventLine.payload?.warehouseId))
            : text(allocation?.payload?.detail?.salesDocumentId) !== command.aggregateId
              || text(allocation?.payload?.detail?.salesLineId) !== text(eventRow.payload?.detail?.salesLineId);
          if (!allocation || text(allocation.payload?.eventType).toUpperCase() !== 'SALES_TRANSFER_ALLOCATED'
            || text(allocation.payload?.orderId) !== orderId || text(allocation.payload?.detail?.orderItemId) !== itemId
            || allocationLinkInvalid
            || priorReversed + finite(eventRow.payload?.detail?.transferredQty) > finite(allocation.payload?.detail?.transferredQty) + EPSILON) {
            commandError('ORDERQ_CENTRAL_ORDER_ALLOCATION_REVERSAL_INVALID', eventRow.entityId);
          }
        }
      }
      for (const itemId of new Set(orderEvents.map(row => text(row.payload?.detail?.orderItemId)))) {
        const item = state.entities[entityKey('ORDER_ITEM', itemId)];
        const existingAllocated = Object.values(state.entities || {}).filter(candidate => candidate.entityType === 'ORDER_EVENT'
          && text(candidate.payload?.detail?.orderItemId) === itemId
          && ['SALES_TRANSFER_ALLOCATED', 'SALES_TRANSFER_REVERSED'].includes(text(candidate.payload?.eventType).toUpperCase())).reduce((sum, candidate) => sum
            + (text(candidate.payload?.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED' ? -1 : 1) * finite(candidate.payload?.detail?.transferredQty), 0);
        const commandAllocated = orderEvents.filter(candidate => text(candidate.payload?.detail?.orderItemId) === itemId).reduce((sum, candidate) => sum
          + (text(candidate.payload?.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED' ? -1 : 1) * finite(candidate.payload?.detail?.transferredQty), 0);
        const ordered = Math.abs(finite(item?.payload?.finalQuantity ?? item?.payload?.rawQuantity ?? item?.payload?.quantity));
        if (existingAllocated + commandAllocated > ordered + EPSILON || existingAllocated + commandAllocated < -EPSILON) {
          commandError('ORDERQ_CENTRAL_ORDER_ALLOCATION_LIMIT', itemId);
        }
      }
      for (const row of projectionLines) {
        const line = row.payload;
        const order = state.entities[entityKey('ORDER', text(line.sourceOrderId))];
        const item = state.entities[entityKey('ORDER_ITEM', text(line.sourceOrderItemId))];
        const dispatchId = text(line.sourceDispatchId); const dispatchLineId = text(line.sourceDispatchLineId);
        const hasDispatch = Boolean(dispatchId);
        const dispatchLine = hasDispatch ? state.entities[entityKey('DISPATCH_LINE', dispatchLineId)] : null;
        if (text(line.orderLinkMode).toUpperCase() !== 'ORDER_Q'
          || !order || !item || text(item.payload?.orderId) !== order.entityId
          || hasDispatch !== Boolean(dispatchLineId)
          || (hasDispatch && (!dispatchLine || text(dispatchLine.payload?.dispatchId) !== dispatchId
            || text(dispatchLine.payload?.orderItemId) !== item.entityId
            || text(dispatchLine.payload?.actualProductId || dispatchLine.payload?.productId || dispatchLine.payload?.requestedProductId) !== text(line.productId)
            || text(dispatchLine.payload?.warehouseId) !== text(line.warehouseId)))) {
          commandError('ORDERQ_CENTRAL_ORDER_LINK_INVALID', row.entityId);
        }
      }
    }
  }
  for (const entryRow of entries) {
    const entry = entryRow.payload;
    if (text(entry[documentIdField]) !== command.aggregateId
      || Number(entry.sourceDocumentRevision || 0) !== command.expectedRevision + 1
      || entry.vatAmount !== null || text(entry.taxType) !== 'VAT_INCLUDED_IN_SUPPLY'
      || !sameNumber(entry.supplyAmount, entry.totalAmount)
      || text(entry.commandId) !== text(intent.commandId)) {
      commandError('ORDERQ_CENTRAL_OFFICIAL_LEDGER_ENTRY_INVALID', entryRow.entityId);
    }
  }
  const previousTotal = command.commandType.startsWith('POST_')
    ? 0
    : finite(previousDocument.totalAmount ?? previousDocument.totalAmountWon ?? previousDocument.amountWon);
  const nextTotal = reverse ? 0 : finite(document.totalAmount);
  requireSameNumber(entries.reduce((sum, row) => sum + finite(row.payload.totalAmount), 0), nextTotal - previousTotal,
    'ORDERQ_CENTRAL_OFFICIAL_ENTRY_DELTA_INVALID', command.aggregateId);
  const partnerField = purchase ? 'supplierCustomerId' : 'billingCustomerId';
  const oldPartner = text(previousDocument[partnerField]);
  const nextPartner = text(document[partnerField]);
  const existingEntries = Object.values(state.entities || {}).filter(row => row.entityType === entryType
    && text(row.payload?.[documentIdField]) === command.aggregateId);
  const oldBalance = existingEntries.filter(row => text(row.payload?.partnerId) === oldPartner)
    .reduce((sum, row) => sum + finite(row.payload?.totalAmount), 0);
  if (reverse) {
    if (entries.some(row => text(row.payload.partnerId) !== oldPartner)) commandError('ORDERQ_CENTRAL_OFFICIAL_REVERSE_PARTNER_INVALID');
    requireSameNumber(entries.reduce((sum, row) => sum + finite(row.payload.totalAmount), 0), -oldBalance,
      'ORDERQ_CENTRAL_OFFICIAL_REVERSE_BALANCE_INVALID', command.aggregateId);
  } else if (!command.commandType.startsWith('POST_') && oldPartner !== nextPartner) {
    requireSameNumber(entries.filter(row => text(row.payload.partnerId) === oldPartner).reduce((sum, row) => sum + finite(row.payload.totalAmount), 0), -oldBalance,
      'ORDERQ_CENTRAL_OFFICIAL_PARTNER_RELEASE_INVALID', command.aggregateId);
    requireSameNumber(entries.filter(row => text(row.payload.partnerId) === nextPartner).reduce((sum, row) => sum + finite(row.payload.totalAmount), 0), nextTotal,
      'ORDERQ_CENTRAL_OFFICIAL_PARTNER_ASSIGN_INVALID', command.aggregateId);
  }
}

function residualOfficialMovements(state, documentId, lineIdentityId) {
  const rows = Object.values(state.entities || {}).filter(row => row.entityType === 'INVENTORY_MOVEMENT'
    && text(row.payload?.sourceDocumentId) === documentId && text(row.payload?.lineIdentityId) === lineIdentityId);
  const reversals = new Map();
  const reversedIds = new Set();
  rows.filter(row => text(row.payload?.effectKind) === 'REVERSE_OLD' || text(row.payload?.movementType).endsWith('_REVERSAL')).forEach(row => {
    const target = text(row.payload?.reversalOf);
    reversedIds.add(target);
    reversals.set(target, finite(reversals.get(target)) + finite(row.payload?.signedBaseQuantity));
  });
  return rows.filter(row => text(row.payload?.effectKind) !== 'REVERSE_OLD' && !text(row.payload?.movementType).endsWith('_REVERSAL')).map(row => ({
    entityId: row.entityId,
    signedBaseQuantity: finite(row.payload?.signedBaseQuantity),
    remaining: finite(row.payload?.signedBaseQuantity) + finite(reversals.get(row.entityId))
  })).filter(row => Math.abs(row.remaining) > EPSILON || (row.signedBaseQuantity === 0 && !reversedIds.has(row.entityId)));
}

function strictOfficialNumber(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) commandError(code);
  return Number(value);
}

function validateExactOfficialEffects(state, command, mutations, context) {
  const { purchase, documentType, lineType, entryType, document, projectionLines, movements, entries, orderEvents } = context;
  (Array.isArray(command.intent?.lines) ? command.intent.lines : []).filter(row => text(row?.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED').forEach(row => {
    strictOfficialNumber(row.quantity ?? row.actualQuantity, 'ORDERQ_CENTRAL_OFFICIAL_QUANTITY_REQUIRED');
    strictOfficialNumber(row.unitPrice, 'ORDERQ_CENTRAL_OFFICIAL_UNIT_PRICE_REQUIRED');
    strictOfficialNumber(row.baseQuantity, 'ORDERQ_CENTRAL_OFFICIAL_BASE_QUANTITY_REQUIRED');
  });
  const currentLines = Object.values(state.entities || {}).filter(row => row.entityType === lineType
    && text(row.payload?.[purchase ? 'purchaseDocumentId' : 'salesDocumentId']) === command.aggregateId
    && text(row.payload?.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED' && entityStatus(row) !== 'REVERSED').map(row => row.payload);
  const snapshotLines = Object.values(state.entities || {}).filter(row => row.entityType === lineType
    && text(row.payload?.[purchase ? 'purchaseDocumentId' : 'salesDocumentId']) === command.aggregateId && entityStatus(row) !== 'REVERSED').map(row => row.payload);
  const expected = planOfficialVoucherCommand({
    document: state.entities[entityKey(documentType, command.aggregateId)]?.payload,
    lines: currentLines,
    snapshotLines,
    movements: Object.values(state.entities || {}).filter(row => row.entityType === 'INVENTORY_MOVEMENT' && text(row.payload?.sourceDocumentId) === command.aggregateId).map(row => row.payload),
    entries: Object.values(state.entities || {}).filter(row => row.entityType === entryType).map(row => row.payload),
    orderEvents: Object.values(state.entities || {}).filter(row => row.entityType === 'ORDER_EVENT').map(row => row.payload),
    command: {
      commandType: command.commandType, commandContract:'VOUCHER_CORE_V1', commandId:command.idempotencyKey, idempotencyKey:command.idempotencyKey,
      expectedRevision:command.expectedRevision, actor:text(command.intent?.actor), occurredAt:text(command.intent?.occurredAt), reason:text(command.intent?.reason),
      document: command.intent?.document || document, lines: Array.isArray(command.intent?.lines) ? command.intent.lines : projectionLines.map(row => row.payload)
    }
  });
  const exactSet = (actual, planned, code) => {
    const actualKeys = actual.map(row => stableJson(row)); const expectedKeys = planned.map(row => stableJson(row));
    if (new Set(actualKeys).size !== actualKeys.length || new Set(expectedKeys).size !== expectedKeys.length
      || actualKeys.length !== expectedKeys.length || actualKeys.some(key => !expectedKeys.includes(key))) commandError(code, command.aggregateId);
  };
  projectionLines.forEach(row => {
    if (text(row.payload?.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED') {
      strictOfficialNumber(row.payload?.quantity, 'ORDERQ_CENTRAL_OFFICIAL_QUANTITY_REQUIRED');
      strictOfficialNumber(row.payload?.unitPrice, 'ORDERQ_CENTRAL_OFFICIAL_UNIT_PRICE_REQUIRED');
      strictOfficialNumber(row.payload?.baseQuantity, 'ORDERQ_CENTRAL_OFFICIAL_BASE_QUANTITY_REQUIRED');
    }
  });
  exactSet(movements.map(row => ({ lineIdentityId:text(row.payload?.lineIdentityId), movementType:text(row.payload?.movementType), signedBaseQuantity:strictOfficialNumber(row.payload?.signedBaseQuantity,'ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_QUANTITY_REQUIRED'), effectKind:text(row.payload?.effectKind), effectOrdinal:Number(row.payload?.effectOrdinal || 0), reversalOf:text(row.payload?.reversalOf), productId:text(row.payload?.productId), warehouseId:text(row.payload?.warehouseId) })),
    expected.movements.map(row => ({ lineIdentityId:text(row.lineIdentityId), movementType:text(row.movementType), signedBaseQuantity:Number(row.signedBaseQuantity), effectKind:text(row.effectKind), effectOrdinal:Number(row.effectOrdinal || 0), reversalOf:text(row.reversalOf), productId:text(row.productId), warehouseId:text(row.warehouseId) })), 'ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_EFFECT_MISMATCH');
  exactSet(entries.map(row => ({ entryType:text(row.payload?.entryType), partnerId:text(row.payload?.partnerId), supplyAmount:strictOfficialNumber(row.payload?.supplyAmount,'ORDERQ_CENTRAL_OFFICIAL_ENTRY_AMOUNT_REQUIRED'), totalAmount:strictOfficialNumber(row.payload?.totalAmount,'ORDERQ_CENTRAL_OFFICIAL_ENTRY_AMOUNT_REQUIRED'), effectOrdinal:Number(row.payload?.effectOrdinal || 0), reversalOf:text(row.payload?.reversalOf) })),
    expected.entries.map(row => ({ entryType:text(row.entryType), partnerId:text(row.partnerId), supplyAmount:Number(row.supplyAmount), totalAmount:Number(row.totalAmount), effectOrdinal:Number(row.effectOrdinal || 0), reversalOf:text(row.reversalOf) })), 'ORDERQ_CENTRAL_OFFICIAL_ENTRY_EFFECT_MISMATCH');
  exactSet(orderEvents.map(row => ({ eventType:text(row.payload?.eventType), orderId:text(row.payload?.orderId), orderItemId:text(row.payload?.detail?.orderItemId), salesLineId:text(row.payload?.detail?.salesLineId), transferredQty:strictOfficialNumber(row.payload?.detail?.transferredQty,'ORDERQ_CENTRAL_ORDER_EVENT_QUANTITY_REQUIRED'), allocationEventId:text(row.payload?.detail?.allocationEventId), effectOrdinal:Number(row.payload?.effectOrdinal || 0) })),
    expected.orderEvents.map(row => ({ eventType:text(row.eventType), orderId:text(row.orderId), orderItemId:text(row.detail?.orderItemId), salesLineId:text(row.detail?.salesLineId), transferredQty:Number(row.detail?.transferredQty), allocationEventId:text(row.detail?.allocationEventId), effectOrdinal:Number(row.effectOrdinal || 0) })), 'ORDERQ_CENTRAL_ORDER_EVENT_EFFECT_MISMATCH');
}

function validateCommandMutations(state, command, mutations) {
  const byType = type => mutations.filter(row => row.entityType === type);
  const decision = byType('DISPATCH_DECISION').find(row => row.entityId === command.aggregateId);
  const purchase = byType('PURCHASE_DOCUMENT').find(row => row.entityId === command.aggregateId);
  const officialVoucherCommand = text(command.intent?.commandContract).toUpperCase() === 'VOUCHER_CORE_V1';
  if (officialVoucherCommand && ['POST_PURCHASE', 'CORRECT_PURCHASE', 'REVERSE_PURCHASE', 'POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'].includes(command.commandType)) {
    validateOfficialVoucherLedger(state, command, mutations);
    return;
  }
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
  enforceCentralMigrationBoundary(state);
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
  validateMutationEntityKeys(mutations);
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
    row.payload.centralRevision = row.revision;
    row.payload.localOnly = false;
    if (['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].includes(row.entityType) && row.payload.documentContract === 'VOUCHER_CORE_V1') {
      row.payload.projectionStatus = 'CENTRAL_COMMITTED';
    }
    working.entities[key] = clone(row);
  }
  const voucherCore = text(command.intent?.commandContract).toUpperCase() === 'VOUCHER_CORE_V1';
  const ledgerRank = voucherCore
    ? { VOUCHER_EVENT: 1, INVENTORY_MOVEMENT: 2, ORDER_EVENT: 3, PAYABLE_ENTRY: 4, RECEIVABLE_ENTRY: 4 }
    : { INVENTORY_MOVEMENT: 2 };
  const effectRank = { REVERSE_OLD: 1, DELTA: 2, APPLY_NEW: 3 };
  const eventRank = { SALES_TRANSFER_REVERSED: 1, SALES_TRANSFER_ALLOCATED: 2 };
  const compareLedger = (left, right) => {
    const typeRank = ledgerRank[left.entityType] - ledgerRank[right.entityType];
    if (typeRank) return typeRank;
    if (left.entityType === 'INVENTORY_MOVEMENT') return text(left.payload.lineIdentityId).localeCompare(text(right.payload.lineIdentityId))
      || (effectRank[text(left.payload.effectKind).toUpperCase()] || 9) - (effectRank[text(right.payload.effectKind).toUpperCase()] || 9)
      || Number(left.payload.effectOrdinal || 0) - Number(right.payload.effectOrdinal || 0)
      || left.entityId.localeCompare(right.entityId);
    if (left.entityType === 'ORDER_EVENT') return text(left.payload.orderId).localeCompare(text(right.payload.orderId))
      || text(left.payload.detail?.orderItemId).localeCompare(text(right.payload.detail?.orderItemId))
      || text(left.payload.detail?.salesLineId).localeCompare(text(right.payload.detail?.salesLineId))
      || (eventRank[text(left.payload.eventType).toUpperCase()] || 9) - (eventRank[text(right.payload.eventType).toUpperCase()] || 9)
      || Number(left.payload.effectOrdinal || 0) - Number(right.payload.effectOrdinal || 0)
      || left.entityId.localeCompare(right.entityId);
    if (['PAYABLE_ENTRY', 'RECEIVABLE_ENTRY'].includes(left.entityType)) return text(left.payload.partnerId).localeCompare(text(right.payload.partnerId))
      || text(left.payload.entryType).localeCompare(text(right.payload.entryType))
      || text(left.payload.reversalOf).localeCompare(text(right.payload.reversalOf))
      || Number(left.payload.effectOrdinal || 0) - Number(right.payload.effectOrdinal || 0)
      || left.entityId.localeCompare(right.entityId);
    return left.entityId.localeCompare(right.entityId);
  };
  mutations.filter(row => ledgerRank[row.entityType]).sort(compareLedger).forEach(row => {
    delete row.payload.ledgerSequence;
    working.ledgerSequence += 1;
    row.payload.ledgerSequence = working.ledgerSequence;
    if (row.entityType === 'INVENTORY_MOVEMENT') row.revision = Math.max(row.revision, working.ledgerSequence);
    const key = entityKey(row.entityType, row.entityId);
    working.entities[key] = clone(row);
  });
  if (text(options.failureAt).toUpperCase() === 'ENTITIES_WRITTEN') {
    commandError('ORDERQ_CENTRAL_FAILURE_INJECTED', 'ENTITIES_WRITTEN');
  }
  mutations.forEach(row => appendChange(working, row, command.deviceId, idempotencyKey));
  const result = {
    transactionId: `${idempotencyKey}:OFFICIAL`,
    changes: clone(mutations),
    cursor: working.syncSequence,
    ledgerSequence: working.ledgerSequence,
    serverRevision: Math.max(...mutations.map(row => row.entityId === command.aggregateId ? row.revision : 0), command.expectedRevision)
  };
  result.resultDigest = canonicalSha256({ changes: result.changes, cursor: result.cursor, ledgerSequence: result.ledgerSequence, serverRevision: result.serverRevision });
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
  enforceCentralMigrationBoundary(state);
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
  enforceCentralMigrationBoundary(state);
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
