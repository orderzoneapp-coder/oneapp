import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { calculateInventoryShadowProjection } from './inventory-ledger.js?v=0.10.0';
import {
  compareShadowFacts,
  normalizeLegacyShadowRows,
  normalizeOrderQShadowRows
} from './shadow-comparison.js?v=0.10.0';

const LEGACY_RECOVERY_DB = 'ONEAPPShippingRecoveryDB';
const LEGACY_RECOVERY_STORE = 'recoveryRecords';
const LEGACY_WORKSPACE_DB = 'ONEAPPShippingManagementDB';
const LEGACY_WORKSPACE_STORE = 'workspaces';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function request(requestValue) {
  return new Promise((resolve, reject) => {
    requestValue.onsuccess = () => resolve(requestValue.result);
    requestValue.onerror = () => reject(requestValue.error || new Error('ORDERQ_LEGACY_IDB_REQUEST_FAILED'));
  });
}

async function knownDatabase(name) {
  if (typeof indexedDB.databases !== 'function') return true;
  const databases = await indexedDB.databases();
  return databases.some(row => row.name === name);
}

async function readLegacyStore(databaseName, storeName) {
  if (!(await knownDatabase(databaseName))) return [];
  const db = await request(indexedDB.open(databaseName));
  if (!db.objectStoreNames.contains(storeName)) {
    db.close();
    return [];
  }
  const tx = db.transaction(storeName, 'readonly');
  const rows = await request(tx.objectStore(storeName).getAll());
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('ORDERQ_LEGACY_IDB_TRANSACTION_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('ORDERQ_LEGACY_IDB_TRANSACTION_ABORTED'));
  });
  db.close();
  return rows;
}

export async function loadLatestLegacyWorkspace() {
  const recoveryRows = await readLegacyStore(LEGACY_RECOVERY_DB, LEGACY_RECOVERY_STORE);
  const recoveryCandidates = recoveryRows.map(row => ({
    recordId: text(row.recordId),
    sourceFingerprint: text(row.sourceFingerprint || row.payload?.sourceFingerprint),
    updatedAt: text(row.updatedAt || row.payload?.updatedAt),
    workspace: row.payload?.workspace
  })).filter(row => row.workspace);
  const legacyRows = await readLegacyStore(LEGACY_WORKSPACE_DB, LEGACY_WORKSPACE_STORE);
  const legacyCandidates = legacyRows.map(row => ({
    recordId: text(row.recordId || row.sourceFingerprint),
    sourceFingerprint: text(row.sourceFingerprint),
    updatedAt: text(row.updatedAt),
    workspace: row.workspace
  })).filter(row => row.workspace);
  const candidates = [...recoveryCandidates, ...legacyCandidates]
    .sort((left, right) => text(right.updatedAt).localeCompare(text(left.updatedAt)));
  return candidates[0] || null;
}

async function readOrderQStores(storeNames) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readonly');
  const result = {};
  await Promise.all(storeNames.map(async name => {
    result[name] = await requestToPromise(tx.objectStore(name).getAll());
  }));
  await transactionDone(tx);
  return result;
}

export async function buildCurrentShadowReport(engine = globalThis.ShippingManagementEngine) {
  if (!engine || typeof engine.getStockLedgerView !== 'function') {
    throw new Error('ORDERQ_SHADOW_LEGACY_ENGINE_UNAVAILABLE');
  }
  const legacy = await loadLatestLegacyWorkspace();
  if (!legacy?.workspace) throw new Error('ORDERQ_SHADOW_LEGACY_WORKSPACE_NOT_FOUND');
  const ledger = engine.getStockLedgerView(legacy.workspace);
  const source = await readOrderQStores([
    STORE.PRODUCTS,
    STORE.WAREHOUSES,
    STORE.INVENTORY_SNAPSHOTS,
    STORE.INVENTORY_LINES,
    STORE.INVENTORY_MOVEMENTS,
    STORE.INVENTORY_RESERVATIONS
  ]);
  const projection = calculateInventoryShadowProjection({
    snapshots: source[STORE.INVENTORY_SNAPSHOTS],
    inventoryLines: source[STORE.INVENTORY_LINES],
    movements: source[STORE.INVENTORY_MOVEMENTS],
    reservations: source[STORE.INVENTORY_RESERVATIONS],
    warehouses: source[STORE.WAREHOUSES]
  });
  const productNames = Object.fromEntries(source[STORE.PRODUCTS].map(row => [
    text(row.productId), text(row.itemName || row.productName)
  ]));
  const legacyRows = normalizeLegacyShadowRows(ledger.rows, {
    basisDate: legacy.workspace.basisDate,
    sourceFingerprint: legacy.sourceFingerprint
  });
  const orderQRows = normalizeOrderQShadowRows(projection, { productNames });
  return {
    legacy: {
      recordId: legacy.recordId,
      sourceFingerprint: legacy.sourceFingerprint,
      updatedAt: legacy.updatedAt,
      basisDate: text(legacy.workspace.basisDate),
      rowCount: legacyRows.length
    },
    orderq: {
      basis: projection.basis,
      rowCount: orderQRows.length,
      warningCount: projection.warnings.length
    },
    report: compareShadowFacts({ legacyRows, orderQRows })
  };
}
