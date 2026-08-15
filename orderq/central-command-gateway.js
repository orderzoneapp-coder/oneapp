import {
  STORE,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import {
  abortCentralOfficialCommand,
  commitCentralOfficialCommand,
  getCloudUrl,
  migrateCentralDraftEntities,
  prepareCentralOfficialCommand,
  pullCentralOfficialChanges
} from './orderq-cloud-adapter.js?v=0.9.0';
import { getDeviceId } from './orderq-sync-engine.js?v=0.8.0';
import { withOfficialCommandAuthority } from './official-command-policy.js?v=0.9.0';

export const CENTRAL_CURSOR_META_KEY = 'm9CentralCursor';
export const CENTRAL_LEDGER_META_KEY = 'inventoryLedgerSequence';

const ENTITY_STORES = Object.freeze({
  ORDER: [STORE.ORDERS, 'orderId'],
  ORDER_ITEM: [STORE.ORDER_ITEMS, 'orderItemId'],
  PRODUCT: [STORE.PRODUCTS, 'productId'],
  WAREHOUSE: [STORE.WAREHOUSES, 'warehouseId'],
  INVENTORY_SNAPSHOT: [STORE.INVENTORY_SNAPSHOTS, 'inventorySnapshotId'],
  INVENTORY_LINE: [STORE.INVENTORY_LINES, 'inventoryLineId'],
  DISPATCH_DECISION: [STORE.DISPATCH_DECISIONS, 'dispatchId'],
  DISPATCH_LINE: [STORE.DISPATCH_LINES, 'dispatchLineId'],
  DISPATCH_STOCK_ALLOCATION: [STORE.DISPATCH_STOCK_ALLOCATIONS, 'allocationId'],
  DISPATCH_APPROVAL: [STORE.DISPATCH_APPROVALS, 'approvalId'],
  INVENTORY_RESERVATION: [STORE.INVENTORY_RESERVATIONS, 'reservationId'],
  INVENTORY_MOVEMENT: [STORE.INVENTORY_MOVEMENTS, 'movementId'],
  DISPATCH_RECONCILIATION: [STORE.DISPATCH_RECONCILIATIONS, 'reconciliationId'],
  SALES_DOCUMENT: [STORE.SALES_DOCUMENTS, 'salesDocumentId'],
  SALES_LINE: [STORE.SALES_LINES, 'salesLineId'],
  PURCHASE_DOCUMENT: [STORE.PURCHASE_DOCUMENTS, 'purchaseDocumentId'],
  PURCHASE_LINE: [STORE.PURCHASE_LINES, 'purchaseLineId'],
  ORDER_EVENT: [STORE.ORDER_EVENTS, 'eventId']
});

const STORE_TO_ENTITY = new Map(Object.entries(ENTITY_STORES).map(([entityType, [storeName, idField]]) => [storeName, { entityType, idField }]));
const OFFICIAL_STORE_NAMES = [...new Set([...STORE_TO_ENTITY.keys(), STORE.META, STORE.SYNC_QUEUE])];

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function readStores(storeNames) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readonly');
  const result = {};
  await Promise.all(storeNames.map(async storeName => {
    result[storeName] = await requestToPromise(tx.objectStore(storeName).getAll());
  }));
  await transactionDone(tx);
  return result;
}

async function restoreStores(snapshot) {
  const storeNames = Object.keys(snapshot);
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readwrite');
  for (const storeName of storeNames) {
    const store = tx.objectStore(storeName);
    store.clear();
    (snapshot[storeName] || []).forEach(row => store.put(clone(row)));
  }
  await transactionDone(tx);
}

function changedEntities(before, after) {
  const mutations = [];
  for (const [storeName, contract] of STORE_TO_ENTITY) {
    const prior = new Map((before[storeName] || []).map(row => [text(row[contract.idField]), row]));
    for (const row of after[storeName] || []) {
      const entityId = text(row[contract.idField]);
      if (!entityId || same(prior.get(entityId), row)) continue;
      mutations.push({
        entityType: contract.entityType,
        entityId,
        revision: Number(row.revision || row.dispatchRevision || 0),
        payload: clone(row)
      });
    }
  }
  return mutations;
}

async function applyCentralChanges(changes = [], ledgerSequence = null, cursor = null) {
  const storeNames = [...new Set(changes.map(row => ENTITY_STORES[row.entityType]?.[0]).filter(Boolean))];
  const stores = [...new Set([...storeNames, STORE.META, STORE.SYNC_QUEUE])];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  const centralKeys = new Set();
  for (const change of changes) {
    const contract = ENTITY_STORES[change.entityType];
    if (!contract) continue;
    const [storeName, idField] = contract;
    const payload = { ...clone(change.payload), [idField]: change.entityId, localOnly: false, centralRevision: Number(change.revision || 0) };
    tx.objectStore(storeName).put(payload);
    centralKeys.add(`${change.entityType}:${change.entityId}`);
  }
  if (ledgerSequence !== null && ledgerSequence !== undefined) {
    tx.objectStore(STORE.META).put({ key: CENTRAL_LEDGER_META_KEY, value: Number(ledgerSequence || 0), updatedAt: nowIso(), source: 'CENTRAL' });
  }
  if (cursor !== null && cursor !== undefined) {
    tx.objectStore(STORE.META).put({ key: CENTRAL_CURSOR_META_KEY, value: Number(cursor || 0), updatedAt: nowIso(), source: 'CENTRAL' });
  }
  const queueStore = tx.objectStore(STORE.SYNC_QUEUE);
  const queueRows = await requestToPromise(queueStore.getAll());
  queueRows.forEach(row => {
    if (centralKeys.has(`${text(row.entityType).toUpperCase()}:${text(row.entityId)}`)) {
      queueStore.put({
        ...row,
        status: 'ACKED_CENTRAL',
        localOnly: false,
        ackedAt: nowIso(),
        updatedAt: nowIso()
      });
    }
  });
  await transactionDone(tx);
}

async function migrationEntities(commandType, aggregateId) {
  const dispatchCommand = text(commandType).includes('DISPATCH');
  const purchaseCommand = text(commandType).includes('PURCHASE');
  const source = await readStores([
    STORE.ORDERS, STORE.ORDER_ITEMS, STORE.PRODUCTS, STORE.WAREHOUSES,
    STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES,
    STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_STOCK_ALLOCATIONS,
    STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES
  ]);
  const result = [];
  const add = (entityType, row, idField) => {
    // Rows already accepted by the central authority never re-enter the
    // one-time LOCAL_ONLY migration path.
    if (row?.localOnly === false || Number(row?.centralRevision || 0) > 0) return;
    result.push({
      entityType, entityId: text(row[idField]), revision: Number(row.revision || 0), payload: clone(row)
    });
  };
  source[STORE.ORDERS].forEach(row => add('ORDER', row, 'orderId'));
  source[STORE.ORDER_ITEMS].forEach(row => add('ORDER_ITEM', row, 'orderItemId'));
  source[STORE.PRODUCTS].forEach(row => add('PRODUCT', row, 'productId'));
  source[STORE.WAREHOUSES].forEach(row => add('WAREHOUSE', row, 'warehouseId'));
  source[STORE.INVENTORY_SNAPSHOTS].forEach(row => add('INVENTORY_SNAPSHOT', row, 'inventorySnapshotId'));
  source[STORE.INVENTORY_LINES].forEach(row => add('INVENTORY_LINE', row, 'inventoryLineId'));
  if (dispatchCommand) {
    const decision = source[STORE.DISPATCH_DECISIONS].find(row => row.dispatchId === aggregateId);
    if (decision?.status === 'DRAFT') {
      add('DISPATCH_DECISION', decision, 'dispatchId');
      source[STORE.DISPATCH_LINES].filter(row => row.dispatchId === aggregateId).forEach(row => add('DISPATCH_LINE', row, 'dispatchLineId'));
      source[STORE.DISPATCH_STOCK_ALLOCATIONS].filter(row => row.dispatchId === aggregateId).forEach(row => add('DISPATCH_STOCK_ALLOCATION', row, 'allocationId'));
    }
  }
  if (purchaseCommand) {
    const document = source[STORE.PURCHASE_DOCUMENTS].find(row => row.purchaseDocumentId === aggregateId);
    if (document?.status === 'DRAFT') {
      add('PURCHASE_DOCUMENT', document, 'purchaseDocumentId');
      source[STORE.PURCHASE_LINES].filter(row => row.purchaseDocumentId === aggregateId).forEach(row => add('PURCHASE_LINE', row, 'purchaseLineId'));
    }
  }
  return result.filter(row => row.entityId);
}

async function ensureDraftMigrated(command) {
  if (!['RELEASE_DISPATCH', 'CONFIRM_PURCHASE'].includes(command.commandType)) return null;
  const entities = await migrationEntities(command.commandType, command.aggregateId);
  if (!entities.length) return null;
  return migrateCentralDraftEntities(
    command.deviceId,
    `M9-MIGRATE:${command.commandType}:${command.aggregateId}:${command.expectedRevision}`,
    entities
  );
}

export async function runCentralOfficialCommand(source = {}, localOperation) {
  const commandType = text(source.commandType).toUpperCase();
  const aggregateId = text(source.aggregateId);
  const idempotencyKey = text(source.idempotencyKey);
  const expectedRevision = Number(source.expectedRevision);
  if (!getCloudUrl()) throw new Error(`ORDERQ_CENTRAL_OFFLINE_OFFICIAL_COMMAND_BLOCKED:${commandType}`);
  if (!commandType || !aggregateId || !idempotencyKey || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('ORDERQ_CENTRAL_OFFICIAL_COMMAND_INVALID');
  }
  const deviceId = getDeviceId();
  const command = {
    commandType, aggregateId, idempotencyKey, expectedRevision, deviceId,
    intent: clone(source.intent || null)
  };
  await ensureDraftMigrated(command);
  // Always refresh the local cache before asking the server for a lease. The
  // local calculation therefore starts from the same authoritative inventory,
  // reservation and revision state that the server will guard until commit.
  await pullCentralOfficialState();
  const prepared = await prepareCentralOfficialCommand(command);
  if (prepared.committed && prepared.result) {
    await applyCentralChanges(prepared.result.changes, prepared.result.ledgerSequence, prepared.result.cursor);
    return { duplicate: true, central: prepared.result };
  }
  const before = await readStores(OFFICIAL_STORE_NAMES);
  let localStarted = false;
  try {
    const localResult = await withOfficialCommandAuthority({ commandType, leaseToken: prepared.leaseToken }, async () => {
      localStarted = true;
      const value = await localOperation();
      return value;
    });
    const after = await readStores(OFFICIAL_STORE_NAMES);
    const mutations = changedEntities(before, after);
    const committed = await commitCentralOfficialCommand({
      idempotencyKey,
      leaseToken: prepared.leaseToken,
      fingerprint: prepared.fingerprint,
      mutations
    });
    await applyCentralChanges(committed.changes, committed.ledgerSequence, committed.cursor);
    return { ...localResult, duplicate: Boolean(committed.duplicate), central: committed };
  } catch (error) {
    if (localStarted) await restoreStores(before);
    try {
      await abortCentralOfficialCommand({
        idempotencyKey, leaseToken: prepared.leaseToken, reason: text(error?.message || error)
      });
    } catch {}
    throw error;
  }
}

export async function pullCentralOfficialState() {
  if (!getCloudUrl()) return { online: false, applied: 0, cursor: 0 };
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readonly');
  const cursorRow = await requestToPromise(tx.objectStore(STORE.META).get(CENTRAL_CURSOR_META_KEY));
  await transactionDone(tx);
  let cursor = Number(cursorRow?.value || 0);
  let applied = 0;
  for (let page = 0; page < 20; page++) {
    const result = await pullCentralOfficialChanges(cursor, 500);
    await applyCentralChanges(result.changes, result.ledgerSequence, result.nextCursor);
    applied += result.changes.length;
    cursor = Number(result.nextCursor || cursor);
    if (!result.hasMore) break;
  }
  return { online: true, applied, cursor };
}
