import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  getAll,
  getByKey,
  newId,
  nowIso,
  normalizeText
} from '../orderq-db.js?v=0.8.0';
import { COLLECTOR_SOURCE } from './collector-schema.js?v=0.8.0';
import {
  commitPreparedImport,
  rollbackImportBatch,
  rebuildFulfillmentEvidence,
  getCollectorSnapshot
} from './history-repository.js?v=0.8.0';

export const FINGERPRINT_VERSION = 2;

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function identityText(value) {
  return normalizeText(String(value ?? '')).trim();
}

function identityNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? String(number) : String(value).trim();
}

export function normalizedRowFingerprint(sourceType, normalized = {}) {
  const primaryDate = normalized.orderDate || normalized.salesDate || normalized.purchaseDate
    || normalized.basisDate || normalized.transactionDate || '';
  const lineIdentifier = normalized.lineId || normalized.lineNo || normalized.externalLineNo || '';
  const values = [
    sourceType,
    primaryDate,
    identityText(normalized.documentNo),
    identityText(lineIdentifier),
    identityText(normalized.customerName || normalized.supplierName),
    identityText(normalized.productCode),
    identityText(normalized.productName),
    identityText(normalized.warehouseId || normalized.warehouseCode || normalized.warehouseName),
    identityNumber(normalized.quantity ?? normalized.inventoryQuantity),
    identityNumber(normalized.unitPrice ?? normalized.unitCost),
    identityNumber(normalized.amount),
    identityText(normalized.transactionType)
  ];
  return stableHash(values.join('|'));
}

function queueRow(entityType, entityId, payload, revision = 1) {
  const timestamp = nowIso();
  return {
    queueId: newId('SQ'), entityType, entityId, operation: 'UPSERT', revision,
    baseRevision: 0, payload, status: 'PENDING', createdAt: timestamp, updatedAt: timestamp
  };
}

export async function commitPreparedImportV2(prepared, importedBy = 'administrator') {
  if (!prepared?.sourceType || !Array.isArray(prepared.rows)) throw new Error('수집 확정 자료가 올바르지 않습니다.');
  const existing = (await getAll(STORE.SOURCE_RECORDS)).filter(row => !row.disabledAt && row.active !== false);
  const fingerprints = new Set(existing.map(row => (
    row.fingerprintVersion === FINGERPRINT_VERSION && row.rowFingerprint
      ? row.rowFingerprint
      : normalizedRowFingerprint(row.sourceType, row.normalizedRecord || {})
  )));

  let skippedV2 = 0;
  const rows = [];
  for (const sourceRow of prepared.rows) {
    const fingerprint = normalizedRowFingerprint(prepared.sourceType, sourceRow.normalizedRecord || {});
    if (fingerprints.has(fingerprint)) {
      skippedV2 += 1;
      continue;
    }
    fingerprints.add(fingerprint);
    rows.push(sourceRow);
  }

  if (!rows.length) {
    return { duplicate: false, importBatch: null, inserted: 0, skipped: skippedV2, fingerprintVersion: FINGERPRINT_VERSION };
  }

  const result = await commitPreparedImport({ ...prepared, rows }, importedBy);
  if (!result.importBatch?.importBatchId) {
    return { ...result, skipped: Number(result.skipped || 0) + skippedV2, fingerprintVersion: FINGERPRINT_VERSION };
  }

  const db = await openOrderQDb();
  const tx = db.transaction([STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS, STORE.SYNC_QUEUE], 'readwrite');
  const batchStore = tx.objectStore(STORE.IMPORT_BATCHES);
  const sourceStore = tx.objectStore(STORE.SOURCE_RECORDS);
  const syncStore = tx.objectStore(STORE.SYNC_QUEUE);
  const batch = await requestToPromise(batchStore.get(result.importBatch.importBatchId));
  const nextBatch = { ...batch, version: Math.max(2, Number(batch?.version || 1)), fingerprintVersion: FINGERPRINT_VERSION, updatedAt: nowIso() };
  batchStore.put(nextBatch);
  syncStore.put(queueRow('IMPORT_BATCH', nextBatch.importBatchId, nextBatch));

  const sourceRows = sourceStore.indexNames.contains('byBatchId')
    ? await requestToPromise(sourceStore.index('byBatchId').getAll(nextBatch.importBatchId))
    : (await requestToPromise(sourceStore.getAll())).filter(row => row.importBatchId === nextBatch.importBatchId);
  sourceRows.forEach(row => {
    const next = {
      ...row,
      rowFingerprint: normalizedRowFingerprint(row.sourceType, row.normalizedRecord || {}),
      fingerprintVersion: FINGERPRINT_VERSION,
      updatedAt: nowIso()
    };
    sourceStore.put(next);
    syncStore.put(queueRow('SOURCE_RECORD', next.sourceRecordId, next));
  });
  await transactionDone(tx);

  return {
    ...result,
    importBatch: nextBatch,
    skipped: Number(result.skipped || 0) + skippedV2,
    fingerprintVersion: FINGERPRINT_VERSION
  };
}

const MATCHING_SOURCES = new Set([
  COLLECTOR_SOURCE.ORDER,
  COLLECTOR_SOURCE.KAKAO,
  COLLECTOR_SOURCE.SALES
]);

async function rollbackWithoutMatching(importBatchId, rolledBackBy = 'administrator') {
  const batch = await getByKey(STORE.IMPORT_BATCHES, importBatchId);
  if (!batch || batch.status !== 'COMMITTED') throw new Error('롤백할 활성 수집 배치가 없습니다.');
  const timestamp = nowIso();
  const storeNames = [
    STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS, STORE.SALES_DOCUMENTS, STORE.SALES_LINES,
    STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.LEDGER_DOCUMENTS, STORE.LEDGER_LINES,
    STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES, STORE.HISTORICAL_ORDER_GROUPS, STORE.HISTORICAL_ORDER_LINES,
    STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readwrite');
  const nextBatch = { ...batch, status:'ROLLED_BACK', rolledBackAt:timestamp, rolledBackBy, updatedAt:timestamp };
  tx.objectStore(STORE.IMPORT_BATCHES).put(nextBatch);
  const entityByStore = {
    [STORE.SOURCE_RECORDS]: ['SOURCE_RECORD','sourceRecordId'],
    [STORE.SALES_DOCUMENTS]: ['SALES_DOCUMENT','salesDocumentId'], [STORE.SALES_LINES]: ['SALES_LINE','salesLineId'],
    [STORE.PURCHASE_DOCUMENTS]: ['PURCHASE_DOCUMENT','purchaseDocumentId'], [STORE.PURCHASE_LINES]: ['PURCHASE_LINE','purchaseLineId'],
    [STORE.LEDGER_DOCUMENTS]: ['LEDGER_DOCUMENT','ledgerDocumentId'], [STORE.LEDGER_LINES]: ['LEDGER_LINE','ledgerLineId'],
    [STORE.INVENTORY_SNAPSHOTS]: ['INVENTORY_SNAPSHOT','inventorySnapshotId'], [STORE.INVENTORY_LINES]: ['INVENTORY_LINE','inventoryLineId'],
    [STORE.HISTORICAL_ORDER_GROUPS]: ['HISTORICAL_ORDER_GROUP','historicalOrderGroupId'], [STORE.HISTORICAL_ORDER_LINES]: ['HISTORICAL_ORDER_LINE','historicalOrderLineId']
  };
  for (const storeName of storeNames.filter(name => ![STORE.IMPORT_BATCHES, STORE.SYNC_QUEUE].includes(name))) {
    const store = tx.objectStore(storeName);
    if (!store.indexNames.contains('byBatchId')) continue;
    const rows = await requestToPromise(store.index('byBatchId').getAll(importBatchId));
    rows.forEach(row => {
      const next = { ...row, disabledAt:timestamp, disabledReason:'IMPORT_BATCH_ROLLBACK', updatedAt:timestamp };
      store.put(next);
      const mapping = entityByStore[storeName];
      if (mapping) tx.objectStore(STORE.SYNC_QUEUE).put(queueRow(mapping[0], next[mapping[1]], next));
    });
  }
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('IMPORT_BATCH', importBatchId, nextBatch));
  await transactionDone(tx);
  return { importBatch:nextBatch, rebuilt:null };
}

export async function rollbackImportBatchByContract(importBatchId, rolledBackBy = 'administrator') {
  const batch = await getByKey(STORE.IMPORT_BATCHES, importBatchId);
  if (!batch || batch.status !== 'COMMITTED') throw new Error('롤백할 활성 수집 배치가 없습니다.');
  if (!MATCHING_SOURCES.has(batch.sourceType)) return rollbackWithoutMatching(importBatchId, rolledBackBy);
  return rollbackImportBatch(importBatchId, rolledBackBy);
}

export async function rebuildWhenReady() {
  const snapshot = await getCollectorSnapshot();
  if (!snapshot.orderLines.length || !snapshot.salesLines.length) return { ready:false, rebuilt:null };
  return { ready:true, rebuilt:await rebuildFulfillmentEvidence() };
}
