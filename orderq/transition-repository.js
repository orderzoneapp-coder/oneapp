import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { calculateInventoryShadowProjection } from './inventory-ledger.js?v=0.10.0';
import {
  compareShadowFacts,
  normalizeDataOpsShadowRows,
  normalizeLegacyShadowRows,
  normalizeOrderQShadowRows
} from './shadow-comparison.js?v=0.10.1';

const LEGACY_RECOVERY_DB = 'ONEAPPShippingRecoveryDB';
const LEGACY_RECOVERY_STORE = 'recoveryRecords';
const LEGACY_WORKSPACE_DB = 'ONEAPPShippingManagementDB';
const LEGACY_WORKSPACE_STORE = 'workspaces';
const DATAOPS_WORK_DB = 'oneapp_dataops_work_v1';
const DATAOPS_WORK_STORE = 'workspaces';
const DATAOPS_WORK_KEY = 'current';
const RECOVERY_V2_SCHEMA = 'shipping-local-recovery/v2';
const RECOVERY_PAYLOAD_V2_SCHEMA = 'shipping-local-recovery-payload/v2';
const RECOVERY_V1_SCHEMA = 'shipping-local-recovery/v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function validTimestamp(value) {
  return Boolean(text(value)) && Number.isFinite(Date.parse(value));
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error('ORDERQ_SHADOW_SHA256_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function invalidCandidate(sourceType, row, reason) {
  return {
    valid: false,
    sourceType,
    recordId: text(row?.recordId || row?.sourceFingerprint),
    updatedAt: text(row?.updatedAt || row?.payload?.updatedAt),
    reason
  };
}

async function validateRecoveryV2(row, engine) {
  const sourceType = 'RECOVERY_V2';
  try {
    if (!row || row.schemaVersion !== RECOVERY_V2_SCHEMA) throw new Error('V2_SCHEMA_INVALID');
    if (!text(row.recordId)) throw new Error('V2_RECORD_ID_MISSING');
    if (row.hashAlgorithm !== 'SHA-256') throw new Error('V2_HASH_ALGORITHM_INVALID');
    if (!SHA256_PATTERN.test(text(row.sourceFingerprint))) throw new Error('V2_SOURCE_FINGERPRINT_INVALID');
    if (!SHA256_PATTERN.test(text(row.payloadSha256))) throw new Error('V2_PAYLOAD_HASH_INVALID');
    if (row.payload?.schemaVersion !== RECOVERY_PAYLOAD_V2_SCHEMA) throw new Error('V2_PAYLOAD_SCHEMA_INVALID');
    if (row.payload?.workspace?.schemaVersion !== engine.WORKSPACE_SCHEMA_VERSION) throw new Error('V2_WORKSPACE_SCHEMA_INVALID');
    if (text(row.payload.sourceFingerprint) !== text(row.sourceFingerprint)
      || text(row.payload.workspace.sourceFingerprint) !== text(row.sourceFingerprint)) {
      throw new Error('V2_SOURCE_FINGERPRINT_MISMATCH');
    }
    if (!validTimestamp(row.updatedAt) || text(row.payload.updatedAt) !== text(row.updatedAt)) {
      throw new Error('V2_UPDATED_AT_MISMATCH');
    }
    if (engine.containsCloudTokenKey(row)) throw new Error('V2_TOKEN_KEY_FORBIDDEN');
    const actualHash = await sha256Hex(engine.canonicalStringify(row.payload));
    if (actualHash !== text(row.payloadSha256)) throw new Error('V2_PAYLOAD_HASH_MISMATCH');
    return {
      valid: true,
      sourceType,
      recordId: text(row.recordId),
      sourceFingerprint: text(row.sourceFingerprint),
      updatedAt: text(row.updatedAt),
      workspace: row.payload.workspace,
      reason: ''
    };
  } catch (error) {
    return invalidCandidate(sourceType, row, text(error.message || error));
  }
}

async function validateRecoveryV1(row, engine) {
  const sourceType = 'RECOVERY_V1';
  try {
    if (!row || row.schemaVersion !== RECOVERY_V1_SCHEMA) throw new Error('V1_SCHEMA_INVALID');
    if (!SHA256_PATTERN.test(text(row.sourceFingerprint))) throw new Error('V1_SOURCE_FINGERPRINT_INVALID');
    if (row.workspace?.schemaVersion !== engine.WORKSPACE_SCHEMA_VERSION) throw new Error('V1_WORKSPACE_SCHEMA_INVALID');
    if (text(row.workspace.sourceFingerprint) !== text(row.sourceFingerprint)) {
      throw new Error('V1_SOURCE_FINGERPRINT_MISMATCH');
    }
    if (!validTimestamp(row.updatedAt)) throw new Error('V1_UPDATED_AT_INVALID');
    if (text(row.workspaceSchemaVersion) && text(row.workspaceSchemaVersion) !== text(row.workspace.schemaVersion)) {
      throw new Error('V1_WORKSPACE_SCHEMA_LINK_MISMATCH');
    }
    if (engine.containsCloudTokenKey(row)) throw new Error('V1_TOKEN_KEY_FORBIDDEN');
    if (row.payload !== undefined || row.payloadSha256 !== undefined) {
      if (row.hashAlgorithm !== 'SHA-256' || !SHA256_PATTERN.test(text(row.payloadSha256))) {
        throw new Error('V1_PAYLOAD_HASH_INVALID');
      }
      if (row.payload?.workspace?.schemaVersion !== engine.WORKSPACE_SCHEMA_VERSION
        || text(row.payload.sourceFingerprint) !== text(row.sourceFingerprint)
        || text(row.payload.workspace.sourceFingerprint) !== text(row.sourceFingerprint)
        || text(row.payload.updatedAt) !== text(row.updatedAt)) {
        throw new Error('V1_PAYLOAD_LINK_MISMATCH');
      }
      const actualHash = await sha256Hex(engine.canonicalStringify(row.payload));
      if (actualHash !== text(row.payloadSha256)) throw new Error('V1_PAYLOAD_HASH_MISMATCH');
    }
    return {
      valid: true,
      sourceType,
      recordId: text(row.recordId || row.sourceFingerprint),
      sourceFingerprint: text(row.sourceFingerprint),
      updatedAt: text(row.updatedAt),
      workspace: row.workspace,
      reason: ''
    };
  } catch (error) {
    return invalidCandidate(sourceType, row, text(error.message || error));
  }
}

export async function validateAndSelectLegacyWorkspaceRows({ recoveryRows = [], legacyRows = [], engine }) {
  if (!engine?.WORKSPACE_SCHEMA_VERSION || typeof engine.canonicalStringify !== 'function'
    || typeof engine.containsCloudTokenKey !== 'function') {
    throw new Error('ORDERQ_SHADOW_LEGACY_ENGINE_UNAVAILABLE');
  }
  const candidates = await Promise.all([
    ...recoveryRows.map(row => validateRecoveryV2(row, engine)),
    ...legacyRows.map(row => validateRecoveryV1(row, engine))
  ]);
  const valid = candidates.filter(candidate => candidate.valid)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const corruptions = candidates.filter(candidate => !candidate.valid).map(candidate => ({
    sourceType: candidate.sourceType,
    recordId: candidate.recordId,
    updatedAt: candidate.updatedAt,
    reason: candidate.reason
  }));
  return {
    selected: valid[0] || null,
    validation: {
      candidateCount: candidates.length,
      validCount: valid.length,
      corruptionCount: corruptions.length,
      corruptions
    }
  };
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

async function readOptionalRecord(databaseName, storeName, key) {
  if (!(await knownDatabase(databaseName))) return null;
  const db = await request(indexedDB.open(databaseName));
  if (!db.objectStoreNames.contains(storeName)) {
    db.close();
    return null;
  }
  const tx = db.transaction(storeName, 'readonly');
  const row = await request(tx.objectStore(storeName).get(key));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('ORDERQ_LEGACY_IDB_TRANSACTION_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('ORDERQ_LEGACY_IDB_TRANSACTION_ABORTED'));
  });
  db.close();
  return row || null;
}

async function loadDataOpsAdjustmentSnapshot(engine) {
  const snapshot = await readOptionalRecord(DATAOPS_WORK_DB, DATAOPS_WORK_STORE, DATAOPS_WORK_KEY);
  if (!snapshot) return { available:false, reasonCode:'DATAOPS_WORK_STATE_NOT_FOUND', rows:[] };
  if (Number(snapshot.version) !== 1 || !Array.isArray(snapshot.productData) || !validTimestamp(snapshot.savedAt)) {
    return { available:false, reasonCode:'DATAOPS_WORK_STATE_INVALID', rows:[] };
  }
  if (engine.containsCloudTokenKey(snapshot)) {
    return { available:false, reasonCode:'DATAOPS_WORK_STATE_TOKEN_FORBIDDEN', rows:[] };
  }
  const sourceFingerprint = await sha256Hex(engine.canonicalStringify({
    version:snapshot.version,
    savedAt:snapshot.savedAt,
    productData:snapshot.productData,
    substHistory:Array.isArray(snapshot.substHistory) ? snapshot.substHistory : []
  }));
  return {
    available:true,
    reasonCode:'',
    savedAt:text(snapshot.savedAt),
    sourceFingerprint,
    rowCount:snapshot.productData.length,
    rows:normalizeDataOpsShadowRows(snapshot.productData, {
      savedAt:snapshot.savedAt,
      sourceFingerprint,
      substHistory:snapshot.substHistory
    })
  };
}

export async function loadLatestLegacyWorkspace(engine = globalThis.ShippingManagementEngine) {
  const recoveryRows = await readLegacyStore(LEGACY_RECOVERY_DB, LEGACY_RECOVERY_STORE);
  const legacyRows = await readLegacyStore(LEGACY_WORKSPACE_DB, LEGACY_WORKSPACE_STORE);
  const selection = await validateAndSelectLegacyWorkspaceRows({ recoveryRows, legacyRows, engine });
  if (!selection.selected) {
    const reasons = [...new Set(selection.validation.corruptions.map(row => row.reason))].join(',') || 'NO_CANDIDATE';
    throw new Error(`ORDERQ_SHADOW_LEGACY_WORKSPACE_NOT_FOUND:${selection.validation.corruptionCount}:${reasons}`);
  }
  return { ...selection.selected, recoveryValidation: selection.validation };
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
  const legacy = await loadLatestLegacyWorkspace(engine);
  const ledger = engine.getStockLedgerView(legacy.workspace);
  const dataops = await loadDataOpsAdjustmentSnapshot(engine);
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
      rowCount: legacyRows.length,
      recoveryValidation: legacy.recoveryValidation
    },
    orderq: {
      basis: projection.basis,
      rowCount: orderQRows.length,
      warningCount: projection.warnings.length
    },
    dataops: {
      available:dataops.available,
      reasonCode:dataops.reasonCode,
      savedAt:dataops.savedAt || '',
      sourceFingerprint:dataops.sourceFingerprint || '',
      rowCount:dataops.rowCount || 0
    },
    report: compareShadowFacts({
      legacyRows,
      orderQRows,
      dataOpsRows:dataops.rows,
      requireDataOpsEvidence:true
    })
  };
}
