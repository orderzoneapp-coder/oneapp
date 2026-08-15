import {
  DB_NAME,
  DB_VERSION,
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  nowIso
} from './orderq-db.js?v=0.8.0';
import { requireActor } from './orderq-v7-contracts.js?v=0.8.0';

export const ORDERQ_BACKUP_FORMAT = 'ONEAPP_ORDERQ_BACKUP';
export const ORDERQ_BACKUP_FORMAT_VERSION = 1;

const STORE_NAMES = Object.freeze([...new Set(Object.values(STORE))]);

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function assertKnownStoreNames(storeNames) {
  const requested = [...new Set(storeNames || [])];
  const unknown = requested.filter(name => !STORE_NAMES.includes(name));
  if (unknown.length) throw new Error(`ORDERQ_BACKUP_UNKNOWN_STORE:${unknown.join(',')}`);
  return requested;
}

export function actorAuditFields(actor, timestamp = nowIso()) {
  const context = requireActor(actor);
  return {
    actorId: context.actorId,
    createdBy: context.actorId,
    createdAt: timestamp,
    updatedBy: context.actorId,
    updatedAt: timestamp
  };
}

export function actorUpdateFields(actor, timestamp = nowIso()) {
  const context = requireActor(actor);
  return { actorId: context.actorId, updatedBy: context.actorId, updatedAt: timestamp };
}

export async function runOrderQTransaction(storeNames, actor, callback) {
  const context = requireActor(actor);
  const requested = assertKnownStoreNames(storeNames);
  if (!requested.length) throw new Error('ORDERQ_TRANSACTION_STORE_REQUIRED');
  if (typeof callback !== 'function') throw new Error('ORDERQ_TRANSACTION_CALLBACK_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction(requested, 'readwrite');
  const stores = Object.fromEntries(requested.map(name => [name, tx.objectStore(name)]));
  try {
    const result = await callback({ tx, stores, actor: context });
    await transactionDone(tx);
    return result;
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function exportOrderQBackup(actor, storeNames = STORE_NAMES) {
  const context = requireActor(actor);
  const requested = assertKnownStoreNames(storeNames);
  const db = await openOrderQDb();
  const tx = db.transaction(requested, 'readonly');
  const stores = {};
  await Promise.all(requested.map(async name => {
    stores[name] = cloneValue(await requestToPromise(tx.objectStore(name).getAll()));
  }));
  await transactionDone(tx);
  return {
    format: ORDERQ_BACKUP_FORMAT,
    formatVersion: ORDERQ_BACKUP_FORMAT_VERSION,
    databaseName: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: nowIso(),
    exportedBy: context.actorId,
    stores,
    counts: Object.fromEntries(requested.map(name => [name, stores[name].length]))
  };
}

export function parseOrderQBackupJson(jsonText) {
  try {
    return JSON.parse(String(jsonText));
  } catch (error) {
    throw new Error(`ORDERQ_BACKUP_JSON_INVALID:${error.message}`);
  }
}

export function validateOrderQBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('ORDERQ_BACKUP_INVALID');
  if (backup.format !== ORDERQ_BACKUP_FORMAT) throw new Error('ORDERQ_BACKUP_FORMAT_INVALID');
  if (Number(backup.formatVersion) !== ORDERQ_BACKUP_FORMAT_VERSION) throw new Error('ORDERQ_BACKUP_FORMAT_VERSION_UNSUPPORTED');
  const schemaVersion = Number(backup.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > DB_VERSION) {
    throw new Error(`ORDERQ_BACKUP_SCHEMA_UNSUPPORTED:${backup.schemaVersion}`);
  }
  if (!backup.stores || typeof backup.stores !== 'object' || Array.isArray(backup.stores)) {
    throw new Error('ORDERQ_BACKUP_STORES_INVALID');
  }
  const storeNames = assertKnownStoreNames(Object.keys(backup.stores));
  if (!storeNames.length) throw new Error('ORDERQ_BACKUP_STORES_EMPTY');
  for (const name of storeNames) {
    if (!Array.isArray(backup.stores[name])) throw new Error(`ORDERQ_BACKUP_STORE_ROWS_INVALID:${name}`);
  }
  return { schemaVersion, storeNames, counts: Object.fromEntries(storeNames.map(name => [name, backup.stores[name].length])) };
}

export async function restoreOrderQBackup(backup, actor) {
  const context = requireActor(actor);
  const validation = validateOrderQBackup(backup);
  const db = await openOrderQDb();
  const tx = db.transaction(validation.storeNames, 'readwrite');
  try {
    for (const name of validation.storeNames) {
      const store = tx.objectStore(name);
      store.clear();
      for (const row of backup.stores[name]) store.put(cloneValue(row));
    }
    await transactionDone(tx);
  } catch (error) {
    try { tx.abort(); } catch {}
    throw new Error(`ORDERQ_BACKUP_RESTORE_FAILED:${error.message}`, { cause: error });
  }
  return {
    restoredAt: nowIso(),
    restoredBy: context.actorId,
    schemaVersion: validation.schemaVersion,
    counts: validation.counts
  };
}

export function orderQBackupStoreNames() {
  return [...STORE_NAMES];
}
