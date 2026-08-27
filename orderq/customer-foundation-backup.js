import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso
} from './orderq-db.js?v=0.21.0';

export const FOUNDATION_CUSTOMER_META_KEY = 'foundationCustomerState';
export const FOUNDATION_LEGACY_QUARANTINE_META_KEY = 'foundationLegacyQuarantineCompleted';
export const CUSTOMER_BACKUP_ENTITY_TYPES = new Set([
  'CUSTOMER', 'CUSTOMER_ALIAS', 'CUSTOMER_SOURCE_LINK', 'CUSTOMER_SOURCE_LINK_EVENT',
  'CUSTOMER_HEADER_MAPPING', 'CUSTOMER_USER_FIELD_DEFINITION'
]);

function api() {
  const value = globalThis.NEXUS_FOUNDATION_BACKUP;
  if (!value) throw new Error('FOUNDATION_BACKUP_CLIENT_UNAVAILABLE');
  return value;
}

function metaValue(row, fallback) {
  return row && row.value && typeof row.value === 'object' ? row.value : fallback;
}

export async function prepareCustomerFoundationEvent(tx, event) {
  if (!tx || !event?.eventId || !event?.customerId) throw new Error('FOUNDATION_CUSTOMER_EVENT_INVALID');
  const metaStore = tx.objectStore(STORE.META);
  const outboxStore = tx.objectStore(STORE.FOUNDATION_BACKUP_OUTBOX);
  const currentRow = await requestToPromise(metaStore.get(FOUNDATION_CUSTOMER_META_KEY));
  const current = metaValue(currentRow, {});
  const localRevision = Math.max(0, Number(current.localRevision || 0)) + 1;
  const entityRevision = Math.max(1, Number(event.entityRevision || event.payload?.after?.revision || event.payload?.customer?.revision || 1));
  const previousEntityRevision = Math.max(0, Number(event.previousEntityRevision ?? (entityRevision - 1)));
  const enriched = {
    ...event,
    entityRevision,
    previousEntityRevision,
    localRevision,
    deviceId: api().getDeviceId()
  };
  const timestamp = event.occurredAt || nowIso();
  outboxStore.put({
    backupId: `EVT-${event.eventId}`,
    domainType: 'CUSTOMER',
    backupKind: 'CUSTOMER_EVENT',
    entityType: 'CUSTOMER',
    entityId: event.customerId,
    entityRevision,
    previousEntityRevision,
    localRevision,
    event: enriched,
    status: 'PENDING',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  metaStore.put({
    key: FOUNDATION_CUSTOMER_META_KEY,
    value: {
      ...current,
      schemaVersion: api().SCHEMA_VERSION,
      domainType: 'CUSTOMER',
      deviceId: api().getDeviceId(),
      localRevision,
      baseServerRevision: Math.max(0, Number(current.baseServerRevision || 0)),
      primaryEpoch: Math.max(0, Number(current.primaryEpoch || 0)),
      status: 'LOCAL_OK_BACKUP_PENDING',
      updatedAt: timestamp
    },
    updatedAt: timestamp
  });
  return enriched;
}

export async function prepareCustomerFoundationSnapshotMutation(tx, reason = 'RELATED_DATA_CHANGED') {
  if (!tx) throw new Error('FOUNDATION_CUSTOMER_TRANSACTION_REQUIRED');
  const metaStore = tx.objectStore(STORE.META);
  const currentRow = await requestToPromise(metaStore.get(FOUNDATION_CUSTOMER_META_KEY));
  const current = metaValue(currentRow, {});
  const timestamp = nowIso();
  metaStore.put({
    key: FOUNDATION_CUSTOMER_META_KEY,
    value: {
      ...current,
      schemaVersion: api().SCHEMA_VERSION,
      domainType: 'CUSTOMER',
      deviceId: api().getDeviceId(),
      localRevision: Math.max(0, Number(current.localRevision || 0)) + 1,
      baseServerRevision: Math.max(0, Number(current.baseServerRevision || 0)),
      primaryEpoch: Math.max(0, Number(current.primaryEpoch || 0)),
      snapshotDirty: true,
      snapshotDirtyReason: String(reason || 'RELATED_DATA_CHANGED'),
      status: 'LOCAL_OK_BACKUP_PENDING',
      updatedAt: timestamp
    },
    updatedAt: timestamp
  });
}

export function notifyCustomerFoundationMutation() {
  try { globalThis.dispatchEvent(new CustomEvent('ONEAPP_FOUNDATION_CUSTOMER_COMMITTED')); } catch (_) {}
}

export async function quarantineLegacyCustomerQueue() {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.SYNC_QUEUE, STORE.FOUNDATION_LEGACY_QUARANTINE, STORE.META], 'readwrite');
  const metaStore = tx.objectStore(STORE.META);
  const completed = await requestToPromise(metaStore.get(FOUNDATION_LEGACY_QUARANTINE_META_KEY));
  if (completed?.value === true) {
    await transactionDone(tx);
    return { completed: true, quarantined: 0, alreadyCompleted: true };
  }
  const queueStore = tx.objectStore(STORE.SYNC_QUEUE);
  const quarantineStore = tx.objectStore(STORE.FOUNDATION_LEGACY_QUARANTINE);
  const rows = await requestToPromise(queueStore.getAll());
  const timestamp = nowIso();
  let count = 0;
  rows.filter(row => CUSTOMER_BACKUP_ENTITY_TYPES.has(row.entityType) && row.localOnly !== true).forEach(row => {
    count += 1;
    quarantineStore.put({
      quarantineId: `LEGACY-${row.queueId}`,
      originalQueueId: row.queueId,
      entityType: row.entityType,
      entityId: row.entityId,
      originalStatus: row.status,
      status: 'QUARANTINED_LEGACY_SYNC',
      lastError: row.lastError || '',
      original: row,
      quarantinedAt: timestamp
    });
    queueStore.put({ ...row, localOnly: true, status: 'QUARANTINED_LEGACY_SYNC', quarantinedAt: timestamp, updatedAt: timestamp });
  });
  metaStore.put({ key: FOUNDATION_LEGACY_QUARANTINE_META_KEY, value: true, updatedAt: timestamp });
  await transactionDone(tx);
  return { completed: true, quarantined: count, alreadyCompleted: false };
}

async function getMetaState() {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readonly');
  const row = await requestToPromise(tx.objectStore(STORE.META).get(FOUNDATION_CUSTOMER_META_KEY));
  await transactionDone(tx);
  return metaValue(row, {
    schemaVersion: api().SCHEMA_VERSION,
    domainType: 'CUSTOMER', localRevision: 0, baseServerRevision: 0, primaryEpoch: 0,
    status: 'RESTORE_REQUIRED'
  });
}

export async function ensureCustomerFoundationState() {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.CUSTOMERS, STORE.META], 'readwrite');
  const metaStore = tx.objectStore(STORE.META);
  const [count, stateRow] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.CUSTOMERS).count()),
    requestToPromise(metaStore.get(FOUNDATION_CUSTOMER_META_KEY))
  ]);
  const current = metaValue(stateRow, {});
  const timestamp = nowIso();
  let next = current;
  if (count > 0 && Math.max(0, Number(current.localRevision || 0)) === 0) {
    next = {
      ...current,
      schemaVersion: api().SCHEMA_VERSION,
      domainType: 'CUSTOMER',
      deviceId: api().getDeviceId(),
      localRevision: 1,
      baseServerRevision: 0,
      primaryEpoch: 0,
      snapshotDirty: true,
      snapshotDirtyReason: 'LEGACY_LOCAL_BASELINE',
      status: 'LOCAL_OK_BACKUP_PENDING',
      updatedAt: timestamp
    };
    metaStore.put({ key: FOUNDATION_CUSTOMER_META_KEY, value: next, updatedAt: timestamp });
  } else if (count === 0 && current.status !== 'RESTORE_REQUIRED') {
    next = { ...current, status: 'RESTORE_REQUIRED', updatedAt: timestamp };
    metaStore.put({ key: FOUNDATION_CUSTOMER_META_KEY, value: next, updatedAt: timestamp });
  }
  await transactionDone(tx);
  return { ...next, customerCount: count };
}

async function pendingEvents() {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.FOUNDATION_BACKUP_OUTBOX, 'readonly');
  const rows = await requestToPromise(tx.objectStore(STORE.FOUNDATION_BACKUP_OUTBOX).getAll());
  await transactionDone(tx);
  return rows.filter(row => row.domainType === 'CUSTOMER' && ['PENDING', 'RETRY', 'BACKUP_IN_PROGRESS'].includes(row.status))
    .sort((left, right) => Number(left.localRevision) - Number(right.localRevision) || String(left.createdAt).localeCompare(String(right.createdAt)));
}

async function updateBatch(rows, statePatch, rowPatch) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.FOUNDATION_BACKUP_OUTBOX, STORE.META], 'readwrite');
  const outbox = tx.objectStore(STORE.FOUNDATION_BACKUP_OUTBOX);
  const meta = tx.objectStore(STORE.META);
  const stateRow = await requestToPromise(meta.get(FOUNDATION_CUSTOMER_META_KEY));
  const timestamp = nowIso();
  rows.forEach(row => outbox.put({ ...row, ...rowPatch, updatedAt: timestamp }));
  meta.put({ key: FOUNDATION_CUSTOMER_META_KEY, value: { ...metaValue(stateRow, {}), ...statePatch, updatedAt: timestamp }, updatedAt: timestamp });
  await transactionDone(tx);
}

function classifyResponse(result) {
  if (result?.status === 'ACKED') return 'LOCAL_OK_BACKUP_OK';
  if (result?.status === 'DIVERGED') return 'DIVERGED';
  if (result?.status === 'REVISION_AHEAD_INVALID') return 'REVISION_AHEAD_INVALID';
  return 'BACKUP_FAILED';
}

let flight = null;
export function backupCustomerEventsNow() {
  if (flight) return flight;
  flight = (async () => {
    await quarantineLegacyCustomerQueue();
    if (!api().readFlags().BPLUS_BACKUP_ENABLED) return { status: 'LOCAL_OK_BACKUP_PENDING', disabled: true };
    const rows = (await pendingEvents()).slice(0, 50);
    if (!rows.length) return { status: (await getMetaState()).status, skipped: true };
    const state = await getMetaState();
    await api().registerDevice();
    const device = await api().deviceStatus();
    if (!device?.isPrimary) {
      await updateBatch([], { status: 'NON_PRIMARY', primaryEpoch: Number(device?.primary?.primaryEpoch || 0), lastError: 'PRIMARY_DEVICE_REQUIRED' }, {});
      return { status: 'NON_PRIMARY', device };
    }
    const headResult = await api().readHead('CUSTOMER');
    const customerHead = (headResult?.heads || []).find(row => row.domainType === 'CUSTOMER');
    if (!Number(customerHead?.serverRevision || 0)) {
      return backupCustomerSnapshotNow(true);
    }
    const events = rows.map(row => row.event);
    const activeBatch = state.activeBatch && Array.isArray(state.activeBatch.eventIds)
      && state.activeBatch.eventIds.join('|') === rows.map(row => row.event.eventId).join('|')
      ? state.activeBatch
      : { backupId: api().uuid('BKP-CUSTOMER-EVENTS'), eventIds: rows.map(row => row.event.eventId) };
    const contentHash = await api().sha256({ events });
    const request = {
      schemaVersion: api().SCHEMA_VERSION,
      domainType: 'CUSTOMER',
      backupKind: 'CUSTOMER_EVENTS',
      backupId: activeBatch.backupId,
      deviceId: api().getDeviceId(),
      baseServerRevision: Math.max(0, Number(state.baseServerRevision || 0)),
      localRevision: Math.max(...rows.map(row => Number(row.localRevision || 0))),
      primaryEpoch: Number(device.primary.primaryEpoch),
      recordCount: events.length,
      contentHash,
      events
    };
    await updateBatch(rows, { status: 'BACKUP_IN_PROGRESS', primaryEpoch: request.primaryEpoch, activeBatch, lastAttemptAt: nowIso() }, { status: 'BACKUP_IN_PROGRESS' });
    try {
      const result = await api().gateway('foundation.backup.customer_events_write', request);
      const status = classifyResponse(result);
      if (result?.status === 'ACKED') {
        await updateBatch(rows, {
          status: 'LOCAL_OK_BACKUP_OK', baseServerRevision: Number(result.serverRevision), activeBatch: null,
          lastAckAt: result.ackedAt || nowIso(), lastError: ''
        }, { status: 'ACKED', ackedAt: result.ackedAt || nowIso(), serverRevision: Number(result.serverRevision), lastError: '' });
      } else {
        await updateBatch(rows, { status, activeBatch, lastError: result?.code || status }, { status, lastError: result?.code || status });
      }
      notifyState(await getCustomerFoundationState());
      return result;
    } catch (error) {
      await updateBatch(rows, { status: 'BACKUP_FAILED', activeBatch, lastError: String(error?.message || error) }, {
        status: 'RETRY', attempts: Math.max(...rows.map(row => Number(row.attempts || 0))) + 1, lastError: String(error?.message || error)
      });
      notifyState(await getCustomerFoundationState());
      throw error;
    }
  })().finally(() => { flight = null; });
  return flight;
}

async function readCustomerSnapshot() {
  const stores = [
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.CUSTOMER_SOURCE_LINKS,
    STORE.CUSTOMER_HEADER_MAPPINGS, STORE.CUSTOMER_USER_FIELD_DEFINITIONS, STORE.CUSTOMER_EVENTS
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readonly');
  const values = await Promise.all(stores.map(name => requestToPromise(tx.objectStore(name).getAll())));
  await transactionDone(tx);
  const sortBy = key => rows => rows.slice().sort((left, right) => String(left?.[key] || '').localeCompare(String(right?.[key] || '')));
  return {
    customers: sortBy('customerId')(values[0]),
    aliases: sortBy('mappingId')(values[1]),
    sourceLinks: sortBy('linkId')(values[2]),
    headerMappings: sortBy('mappingId')(values[3]),
    userFieldDefinitions: sortBy('fieldKey')(values[4]),
    events: sortBy('eventId')(values[5])
  };
}

async function readCustomerSnapshotContext() {
  const stores = [
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.CUSTOMER_SOURCE_LINKS,
    STORE.CUSTOMER_HEADER_MAPPINGS, STORE.CUSTOMER_USER_FIELD_DEFINITIONS, STORE.CUSTOMER_EVENTS,
    STORE.FOUNDATION_BACKUP_OUTBOX, STORE.META
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readonly');
  const values = await Promise.all(stores.slice(0, 7).map(name => requestToPromise(tx.objectStore(name).getAll())));
  const stateRow = await requestToPromise(tx.objectStore(STORE.META).get(FOUNDATION_CUSTOMER_META_KEY));
  await transactionDone(tx);
  const sortBy = key => rows => rows.slice().sort((left, right) => String(left?.[key] || '').localeCompare(String(right?.[key] || '')));
  const state = metaValue(stateRow, {});
  const localRevision = Math.max(1, Number(state.localRevision || 0));
  return {
    state,
    localRevision,
    snapshot: {
      customers: sortBy('customerId')(values[0]), aliases: sortBy('mappingId')(values[1]),
      sourceLinks: sortBy('linkId')(values[2]), headerMappings: sortBy('mappingId')(values[3]),
      userFieldDefinitions: sortBy('fieldKey')(values[4]), events: sortBy('eventId')(values[5])
    },
    covered: values[6].filter(row => row.domainType === 'CUSTOMER'
      && ['PENDING', 'RETRY', 'BACKUP_IN_PROGRESS'].includes(row.status)
      && Number(row.localRevision || 0) <= localRevision)
  };
}

async function finalizeCustomerSnapshotAck(context, request, result) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.FOUNDATION_BACKUP_OUTBOX, STORE.META], 'readwrite');
  const outbox = tx.objectStore(STORE.FOUNDATION_BACKUP_OUTBOX);
  const meta = tx.objectStore(STORE.META);
  const stateRow = await requestToPromise(meta.get(FOUNDATION_CUSTOMER_META_KEY));
  const current = metaValue(stateRow, {});
  const timestamp = result.ackedAt || nowIso();
  context.covered.forEach(row => outbox.put({
    ...row, status: 'ACKED_BY_SNAPSHOT', ackedAt: timestamp,
    serverRevision: Number(result.serverRevision), lastError: '', updatedAt: timestamp
  }));
  const hasNewerLocal = Number(current.localRevision || 0) > Number(request.localRevision);
  meta.put({
    key: FOUNDATION_CUSTOMER_META_KEY,
    value: {
      ...current,
      status: hasNewerLocal ? 'LOCAL_OK_BACKUP_PENDING' : 'LOCAL_OK_BACKUP_OK',
      baseServerRevision: Number(result.serverRevision),
      activeBatch: null,
      activeSnapshot: current.activeSnapshot?.backupId === request.backupId ? null : current.activeSnapshot,
      snapshotDirty: hasNewerLocal ? Boolean(current.snapshotDirty) : false,
      snapshotDirtyReason: hasNewerLocal ? String(current.snapshotDirtyReason || '') : '',
      lastSnapshotLocalRevision: Number(request.localRevision),
      lastSnapshotAt: timestamp,
      lastAckAt: timestamp,
      lastError: '',
      updatedAt: timestamp
    },
    updatedAt: timestamp
  });
  await transactionDone(tx);
}

let snapshotFlight = null;
export function backupCustomerSnapshotNow(force = false) {
  if (snapshotFlight) return snapshotFlight;
  snapshotFlight = backupCustomerSnapshotOnce(force).finally(() => { snapshotFlight = null; });
  return snapshotFlight;
}

async function backupCustomerSnapshotOnce(force = false) {
  const state = await getMetaState();
  const age = Date.now() - Date.parse(state.lastSnapshotAt || 0);
  const pendingCount = (await pendingEvents()).length;
  if (!force && !state.snapshotDirty && pendingCount < 50 && age < 86400000) return { skipped: true, status: state.status };
  try {
    await api().registerDevice();
    const device = await api().deviceStatus();
    if (!device?.isPrimary) {
      await updateBatch([], { status: 'NON_PRIMARY', primaryEpoch: Number(device?.primary?.primaryEpoch || 0), lastError: 'PRIMARY_DEVICE_REQUIRED' }, {});
      return { status: 'NON_PRIMARY', device };
    }
    const snapshotContext = await readCustomerSnapshotContext();
    const snapshot = snapshotContext.snapshot;
    const snapshotState = snapshotContext.state;
    const contentHash = await api().sha256(snapshot);
    const activeSnapshot = snapshotState.activeSnapshot
      && snapshotState.activeSnapshot.contentHash === contentHash
      && Number(snapshotState.activeSnapshot.baseServerRevision) === Number(snapshotState.baseServerRevision || 0)
      ? snapshotState.activeSnapshot
      : { backupId: api().uuid('BKP-CUSTOMER-SNAPSHOT'), contentHash, baseServerRevision: Number(snapshotState.baseServerRevision || 0) };
    const request = {
      schemaVersion: api().SCHEMA_VERSION, domainType: 'CUSTOMER', backupKind: 'CUSTOMER_SNAPSHOT',
      backupId: activeSnapshot.backupId, deviceId: api().getDeviceId(),
      baseServerRevision: Number(snapshotState.baseServerRevision || 0), localRevision: snapshotContext.localRevision,
      primaryEpoch: Number(device.primary.primaryEpoch), recordCount: snapshot.customers.length, contentHash, snapshot
    };
    await updateBatch([], { status: 'BACKUP_IN_PROGRESS', activeSnapshot, primaryEpoch: request.primaryEpoch, lastAttemptAt: nowIso() }, {});
    const result = await api().gateway('foundation.backup.customer_snapshot_write', request);
    const status = classifyResponse(result);
    if (result?.status === 'ACKED') {
      await finalizeCustomerSnapshotAck(snapshotContext, request, result);
    } else {
      await updateBatch([], { status, activeSnapshot, lastError: result?.code || status }, {});
    }
    notifyState(await getCustomerFoundationState());
    return result;
  } catch (error) {
    await updateBatch([], { status: 'BACKUP_FAILED', lastError: String(error?.message || error) }, {});
    notifyState(await getCustomerFoundationState());
    throw error;
  }
}

export async function getCustomerFoundationState() {
  const [state, rows] = await Promise.all([getMetaState(), pendingEvents()]);
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.FOUNDATION_LEGACY_QUARANTINE, 'readonly');
  const quarantineCount = await requestToPromise(tx.objectStore(STORE.FOUNDATION_LEGACY_QUARANTINE).count());
  await transactionDone(tx);
  const effectiveStatus = rows.length && state.status === 'LOCAL_OK_BACKUP_OK' ? 'LOCAL_OK_BACKUP_PENDING' : state.status;
  return {
    ...state,
    status: effectiveStatus,
    configured: true,
    pending: rows.filter(row => row.status === 'PENDING' || row.status === 'BACKUP_IN_PROGRESS').length,
    retry: rows.filter(row => row.status === 'RETRY').length,
    conflicts: rows.filter(row => ['DIVERGED', 'REVISION_AHEAD_INVALID', 'PRIMARY_STALE'].includes(row.status)).length,
    quarantineCount
  };
}

export async function previewCustomerRestore(serverRevision = 0) {
  const versions = await api().listVersions('CUSTOMER', 100);
  const selected = serverRevision
    ? versions.find(row => Number(row.serverRevision) === Number(serverRevision) && row.backupKind === 'CUSTOMER_SNAPSHOT')
    : versions.find(row => row.backupKind === 'CUSTOMER_SNAPSHOT');
  if (!selected) throw new Error('CUSTOMER_SNAPSHOT_VERSION_NOT_FOUND');
  const remote = await api().readVersion('CUSTOMER', selected.serverRevision);
  const snapshot = remote.payload;
  const local = await readCustomerSnapshot();
  const comparison = api().compareSnapshots(local.customers, snapshot.customers, 'customerId');
  const duplicateCodes = Object.entries((snapshot.customers || []).reduce((map, row) => {
    const code = String(row.customerCode || row.erpCustomerCode || '').trim();
    if (code) (map[code] ||= []).push(row.customerId);
    return map;
  }, {})).filter(([_code, ids]) => ids.length > 1).map(([code, ids]) => ({ code, customerIds: ids }));
  const customerIds = new Set((snapshot.customers || []).map(row => row.customerId));
  const referenceErrors = [...(snapshot.aliases || []), ...(snapshot.sourceLinks || [])]
    .filter(row => !customerIds.has(row.customerId)).map(row => ({ customerId: row.customerId, row }));
  const localHash = await api().sha256(local);
  return {
    restoreId: api().uuid('RST'),
    domainType: 'CUSTOMER',
    serverRevision: Number(selected.serverRevision),
    remote,
    snapshot,
    local,
    localHash,
    comparison,
    duplicateCodes,
    referenceErrors,
    valid: duplicateCodes.length === 0 && referenceErrors.length === 0,
    approvalToken: `APPLY:${selected.serverRevision}:${remote.contentHash}`
  };
}

export async function applyCustomerRestore(preview, approvalToken) {
  if (!preview?.valid || approvalToken !== preview.approvalToken) throw new Error('CUSTOMER_RESTORE_ADMIN_APPROVAL_REQUIRED');
  const snapshot = preview.snapshot;
  const verifiedHash = await api().sha256(snapshot);
  if (verifiedHash !== preview.remote.contentHash) throw new Error('BACKUP_HASH_MISMATCH');
  const current = await readCustomerSnapshot();
  const currentHash = await api().sha256(current);
  if (currentHash !== preview.localHash) throw new Error('CUSTOMER_RESTORE_LOCAL_CHANGED');
  const db = await openOrderQDb();
  const stores = [
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.CUSTOMER_SOURCE_LINKS,
    STORE.CUSTOMER_HEADER_MAPPINGS, STORE.CUSTOMER_USER_FIELD_DEFINITIONS, STORE.CUSTOMER_EVENTS,
    STORE.FOUNDATION_BACKUP_OUTBOX, STORE.FOUNDATION_RECOVERY_SNAPSHOTS,
    STORE.FOUNDATION_RECOVERY_AUDIT, STORE.META
  ];
  const tx = db.transaction(stores, 'readwrite');
  const timestamp = nowIso();
  const stateRow = await requestToPromise(tx.objectStore(STORE.META).get(FOUNDATION_CUSTOMER_META_KEY));
  const outboxRows = await requestToPromise(tx.objectStore(STORE.FOUNDATION_BACKUP_OUTBOX).getAll());
  tx.objectStore(STORE.FOUNDATION_RECOVERY_SNAPSHOTS).put({
    snapshotId: `SAFE-${preview.restoreId}`,
    restoreId: preview.restoreId,
    domainType: 'CUSTOMER',
    contentHash: currentHash,
    recordCount: current.customers.length,
    snapshot: current,
    createdAt: timestamp
  });
  const replacements = [
    [STORE.CUSTOMERS, snapshot.customers || []],
    [STORE.CUSTOMER_ALIASES, snapshot.aliases || []],
    [STORE.CUSTOMER_SOURCE_LINKS, snapshot.sourceLinks || []],
    [STORE.CUSTOMER_HEADER_MAPPINGS, snapshot.headerMappings || []],
    [STORE.CUSTOMER_USER_FIELD_DEFINITIONS, snapshot.userFieldDefinitions || []],
    [STORE.CUSTOMER_EVENTS, snapshot.events || []]
  ];
  replacements.forEach(([name, rows]) => {
    const store = tx.objectStore(name);
    store.clear();
    rows.forEach(row => store.put(row));
  });
  const outbox = tx.objectStore(STORE.FOUNDATION_BACKUP_OUTBOX);
  outboxRows.filter(row => row.domainType === 'CUSTOMER' && row.status !== 'ACKED' && row.status !== 'ACKED_BY_SNAPSHOT').forEach(row => {
    outbox.put({ ...row, status: 'QUARANTINED_PRE_RESTORE', restoreId: preview.restoreId, updatedAt: timestamp });
  });
  const previousState = metaValue(stateRow, {});
  tx.objectStore(STORE.META).put({
    key: FOUNDATION_CUSTOMER_META_KEY,
    value: {
      ...previousState,
      localRevision: Math.max(0, Number(previousState.localRevision || 0)) + 1,
      baseServerRevision: Number(preview.serverRevision),
      status: 'LOCAL_OK_BACKUP_OK',
      activeBatch: null,
      lastRestoreId: preview.restoreId,
      lastRestoreAt: timestamp,
      lastError: ''
    },
    updatedAt: timestamp
  });
  tx.objectStore(STORE.FOUNDATION_RECOVERY_AUDIT).put({
    auditId: newId('FRA'), restoreId: preview.restoreId, domainType: 'CUSTOMER',
    serverRevision: Number(preview.serverRevision), result: 'APPLIED',
    localHashBefore: currentHash, localHashAfter: verifiedHash,
    recordCountBefore: current.customers.length, recordCountAfter: (snapshot.customers || []).length,
    createdAt: timestamp
  });
  await transactionDone(tx);
  const after = await readCustomerSnapshot();
  const afterHash = await api().sha256(after);
  if (afterHash !== verifiedHash) throw new Error('CUSTOMER_RESTORE_VERIFY_FAILED');
  await api().writeRestoreAudit({
    restoreId: preview.restoreId, domainType: 'CUSTOMER', serverRevision: Number(preview.serverRevision),
    deviceId: api().getDeviceId(), result: 'APPLIED', localHashBefore: currentHash, localHashAfter: afterHash,
    recordCountBefore: current.customers.length, recordCountAfter: after.customers.length
  });
  notifyState(await getCustomerFoundationState());
  return { status: 'APPLIED', restoreId: preview.restoreId, serverRevision: Number(preview.serverRevision), recordCount: after.customers.length, contentHash: afterHash };
}

function notifyState(state) {
  try { globalThis.dispatchEvent(new CustomEvent('ONEAPP_FOUNDATION_BACKUP_STATE', { detail: state })); } catch (_) {}
}

let timer = null;
let firstPendingAt = 0;
let retryAttempts = 0;
let workerStarted = false;
async function schedule() {
  const count = (await pendingEvents()).length;
  const meta = await getMetaState();
  if (!count && !meta.snapshotDirty) return;
  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  if (timer) clearTimeout(timer);
  const delay = count >= 50 ? 0 : Math.max(0, Math.min(10000, 60000 - (now - firstPendingAt)));
  timer = setTimeout(async () => {
    timer = null;
    firstPendingAt = 0;
    try {
      if (count) await backupCustomerEventsNow();
      if ((await pendingEvents()).length) schedule();
      else await backupCustomerSnapshotNow(Boolean((await getMetaState()).snapshotDirty));
      retryAttempts = 0;
    } catch (error) {
      console.warn('[FoundationBackup] customer backup retained for retry', error);
      retryAttempts += 1;
      const retryDelay = Math.min(60000, 5000 * Math.pow(2, Math.min(retryAttempts - 1, 4)));
      timer = setTimeout(() => {
        timer = null;
        firstPendingAt = Date.now() - 60000;
        schedule().catch(retryError => console.warn('[FoundationBackup] customer retry scheduling failed', retryError));
      }, retryDelay);
    }
  }, delay);
}

export async function startCustomerFoundationWorker() {
  if (workerStarted) return { stop: stopCustomerFoundationWorker };
  workerStarted = true;
  await quarantineLegacyCustomerQueue();
  await ensureCustomerFoundationState();
  globalThis.addEventListener('ONEAPP_FOUNDATION_CUSTOMER_COMMITTED', schedule);
  await schedule();
  return { stop: stopCustomerFoundationWorker };
}

function stopCustomerFoundationWorker() {
  globalThis.removeEventListener('ONEAPP_FOUNDATION_CUSTOMER_COMMITTED', schedule);
  if (timer) clearTimeout(timer);
  timer = null;
  firstPendingAt = 0;
  retryAttempts = 0;
  workerStarted = false;
}
