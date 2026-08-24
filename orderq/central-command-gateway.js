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
import { assertLocalOfficialWriteEnabled } from './cutover-control.js?v=0.10.0';

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
  ORDER_EVENT: [STORE.ORDER_EVENTS, 'eventId'],
  VOUCHER_EVENT: [STORE.VOUCHER_EVENTS, 'eventId'],
  RECEIVABLE_ENTRY: [STORE.RECEIVABLE_ENTRIES, 'entryId'],
  PAYABLE_ENTRY: [STORE.PAYABLE_ENTRIES, 'entryId']
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

async function applyCentralChanges(changes = [], ledgerSequence = null, cursor = null, projectionEvidence = null) {
  const storeNames = [...new Set(changes.map(row => ENTITY_STORES[row.entityType]?.[0]).filter(Boolean))];
  const stores = [...new Set([...storeNames, STORE.META, STORE.SYNC_QUEUE])];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  const centralKeys = new Set();
  for (const change of changes) {
    const contract = ENTITY_STORES[change.entityType];
    if (!contract) continue;
    const [storeName, idField] = contract;
    const payload = {
      ...clone(change.payload),
      [idField]: change.entityId,
      localOnly: false,
      centralRevision: Number(change.revision || 0),
      ...(['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].includes(change.entityType) && change.payload?.documentContract === 'VOUCHER_CORE_V1'
        ? { projectionStatus: 'LOCAL_PROJECTED' } : {})
    };
    tx.objectStore(storeName).put(payload);
    centralKeys.add(`${change.entityType}:${change.entityId}`);
  }
  if (projectionEvidence) {
    const commandId = text(projectionEvidence.commandId);
    if (!commandId || !text(projectionEvidence.fingerprint) || !text(projectionEvidence.transactionId) || !text(projectionEvidence.resultDigest)) {
      throw new Error('ORDERQ_CENTRAL_PROJECTION_RECEIPT_EVIDENCE_REQUIRED');
    }
    tx.objectStore(STORE.META).put({
      key: `centralProjection:${commandId}`,
      value: { commandId, fingerprint: text(projectionEvidence.fingerprint), centralTransactionId: text(projectionEvidence.transactionId),
        resultDigest: text(projectionEvidence.resultDigest), projectionStatus: 'LOCAL_PROJECTED', projectedAt: nowIso() },
      updatedAt: nowIso(), source: 'CENTRAL'
    });
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

function utf8Bytes(value) {
  const encoded = JSON.stringify(value);
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(encoded).byteLength : unescape(encodeURIComponent(encoded)).length;
}

async function writeProjectionReceipt(command, central, projectionError = '') {
  const fingerprint = text(central?.fingerprint);
  const transactionId = text(central?.transactionId);
  const resultDigest = text(central?.resultDigest);
  if (!fingerprint || !transactionId || !resultDigest) throw new Error('ORDERQ_CENTRAL_PROJECTION_RECEIPT_EVIDENCE_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.META, 'readwrite');
  tx.objectStore(STORE.META).put({
    key: `centralProjection:${text(command.intent?.commandId || command.idempotencyKey)}`,
    value: {
      commandId: text(command.intent?.commandId || command.idempotencyKey),
      fingerprint,
      centralTransactionId: transactionId,
      centralCursor: Number(central?.cursor || 0),
      centralLedgerSequence: Number(central?.ledgerSequence || 0),
      resultDigest,
      command: clone(command),
      projectionStatus: 'PROJECTION_PENDING',
      projectionError: text(projectionError),
      updatedAt: nowIso()
    },
    updatedAt: nowIso(),
    source: 'CENTRAL'
  });
  await transactionDone(tx);
}

async function migrationEntities(commandType, aggregateId) {
  const dispatchCommand = text(commandType).includes('DISPATCH');
  const purchaseCommand = text(commandType).includes('PURCHASE');
  const saleCommand = text(commandType).includes('SALE');
  const source = await readStores([
    STORE.ORDERS, STORE.ORDER_ITEMS, STORE.PRODUCTS, STORE.WAREHOUSES,
    STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES,
    STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_STOCK_ALLOCATIONS,
    STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES,
    STORE.SALES_DOCUMENTS, STORE.SALES_LINES
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
  const purchaseDocument = purchaseCommand
    ? source[STORE.PURCHASE_DOCUMENTS].find(row => row.purchaseDocumentId === aggregateId)
    : null;
  const purchaseLines = purchaseCommand
    ? source[STORE.PURCHASE_LINES].filter(row => row.purchaseDocumentId === aggregateId)
    : [];
  const requiredProductIds = new Set(purchaseLines.map(row => text(row.productId)).filter(Boolean));
  const requiredWarehouseIds = new Set([
    text(purchaseDocument?.warehouseId),
    ...purchaseLines.map(row => text(row.warehouseId))
  ].filter(Boolean));
  source[STORE.PRODUCTS].filter(row => !purchaseCommand || requiredProductIds.has(text(row.productId)))
    .forEach(row => add('PRODUCT', row, 'productId'));
  source[STORE.WAREHOUSES].filter(row => !purchaseCommand || requiredWarehouseIds.has(text(row.warehouseId)))
    .forEach(row => add('WAREHOUSE', row, 'warehouseId'));
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
    const document = purchaseDocument;
    if (document?.status === 'DRAFT') {
      add('PURCHASE_DOCUMENT', document, 'purchaseDocumentId');
      purchaseLines.forEach(row => add('PURCHASE_LINE', row, 'purchaseLineId'));
    }
  }
  if (saleCommand) {
    const document = source[STORE.SALES_DOCUMENTS].find(row => row.salesDocumentId === aggregateId);
    if (document?.status === 'DRAFT') {
      add('SALES_DOCUMENT', document, 'salesDocumentId');
      source[STORE.SALES_LINES].filter(row => row.salesDocumentId === aggregateId).forEach(row => add('SALES_LINE', row, 'salesLineId'));
    }
  }
  return result.filter(row => row.entityId);
}

async function ensureDraftMigrated(command) {
  if (!['RELEASE_DISPATCH', 'CONFIRM_PURCHASE', 'POST_PURCHASE', 'POST_SALE'].includes(command.commandType)) return null;
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
    intent: clone({
      ...(source.intent || {}),
      commandId: text(source.commandId),
      actor: text(source.actor),
      occurredAt: text(source.occurredAt),
      reason: text(source.reason),
      commandContract: text(source.commandContract),
      sourceType: text(source.sourceType || source.document?.sourceType).toUpperCase(),
      document: clone(source.document || null),
      lines: clone(source.lines || null)
    })
  };
  if (utf8Bytes(command.intent) > 512 * 1024) throw new Error('ORDERQ_VOUCHER_PAYLOAD_TOO_LARGE');
  // The browser profile is the first half of the two-key cutover boundary.
  // This check is deliberately before draft migration and before the local
  // transaction so SHADOW/rollback mode cannot pre-write either side.
  assertLocalOfficialWriteEnabled(commandType);
  await ensureDraftMigrated(command);
  // Always refresh the local cache before asking the server for a lease. The
  // local calculation therefore starts from the same authoritative inventory,
  // reservation and revision state that the server will guard until commit.
  await pullCentralOfficialState();
  const prepared = await prepareCentralOfficialCommand(command);
  if (prepared.committed && prepared.result) {
    try {
      await applyCentralChanges(prepared.result.changes, prepared.result.ledgerSequence, prepared.result.cursor, {
        ...prepared.result, fingerprint: prepared.fingerprint, commandId: text(command.intent?.commandId || command.idempotencyKey)
      });
      return { duplicate: true, central: prepared.result, status: 'LOCAL_PROJECTED', projectionPending: false };
    } catch (projectionError) {
      await writeProjectionReceipt(command, { ...prepared.result, fingerprint: prepared.fingerprint }, projectionError?.message || projectionError);
      return {
        duplicate: true,
        central: prepared.result,
        status: 'CENTRAL_COMMITTED',
        code: 'CENTRAL_COMMITTED_PROJECTION_PENDING',
        projectionPending: true,
        projectionError: text(projectionError?.message || projectionError)
      };
    }
  }
  const before = await readStores(OFFICIAL_STORE_NAMES);
  let localStarted = false;
  let centralCommitted = null;
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
    centralCommitted = committed;
    try {
      await applyCentralChanges(committed.changes, committed.ledgerSequence, committed.cursor, {
        ...committed, fingerprint: prepared.fingerprint, commandId: text(command.intent?.commandId || command.idempotencyKey)
      });
      return {
        ...localResult,
        duplicate: Boolean(committed.duplicate),
        central: committed,
        status: 'LOCAL_PROJECTED',
        projectionPending: false
      };
    } catch (projectionError) {
      let restoreError = '';
      try { await restoreStores(before); } catch (error) { restoreError = text(error?.message || error); }
      await writeProjectionReceipt(command, { ...committed, fingerprint: prepared.fingerprint }, [text(projectionError?.message || projectionError), restoreError].filter(Boolean).join('|'));
      return {
        duplicate: Boolean(committed.duplicate),
        central: committed,
        status: 'CENTRAL_COMMITTED',
        code: 'CENTRAL_COMMITTED_PROJECTION_PENDING',
        projectionPending: true,
        projectionError: text(projectionError?.message || projectionError)
      };
    }
  } catch (error) {
    if (centralCommitted) throw error;
    if (localStarted) await restoreStores(before);
    try {
      await abortCentralOfficialCommand({
        idempotencyKey, leaseToken: prepared.leaseToken, reason: text(error?.message || error)
      });
    } catch {}
    throw error;
  }
}

export async function replayPendingProjectionReceipts(receipts = [], dependencies = {}) {
  const prepare = dependencies.prepare || prepareCentralOfficialCommand;
  const apply = dependencies.apply || applyCentralChanges;
  let projected = 0;
  for (const row of receipts) {
    const receipt = row?.value || row || {};
    if (text(receipt.projectionStatus) !== 'PROJECTION_PENDING') continue;
    const prepared = await prepare(receipt.command || {});
    const result = prepared.committed && prepared.result;
    if (!result || text(prepared.fingerprint) !== text(receipt.fingerprint)
      || text(result.transactionId) !== text(receipt.centralTransactionId)
      || text(result.resultDigest) !== text(receipt.resultDigest)) {
      throw new Error(`ORDERQ_CENTRAL_PROJECTION_RECEIPT_MISMATCH:${text(receipt.commandId)}`);
    }
    await apply(result.changes, result.ledgerSequence, result.cursor, {
      ...result, fingerprint: prepared.fingerprint, commandId: receipt.commandId
    });
    projected += 1;
  }
  return projected;
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
  const receiptDb = await openOrderQDb();
  const receiptTx = receiptDb.transaction(STORE.META, 'readonly');
  const pendingReceipts = (await requestToPromise(receiptTx.objectStore(STORE.META).getAll()))
    .filter(row => text(row.key).startsWith('centralProjection:') && text(row.value?.projectionStatus) === 'PROJECTION_PENDING');
  await transactionDone(receiptTx);
  await replayPendingProjectionReceipts(pendingReceipts);
  return { online: true, applied, cursor };
}
