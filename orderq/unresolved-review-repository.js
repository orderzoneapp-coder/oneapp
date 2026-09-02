import {
  DB_NAME,
  STORE,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';

const exactText = value => String(value ?? '').trim();
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function requiredCompanyId(value) {
  const companyId = exactText(value);
  if (!companyId) throw new Error('ORDERQ_UNRESOLVED_REVIEW_COMPANY_REQUIRED');
  return companyId;
}

async function ownerDatabaseExists() {
  if (!globalThis.indexedDB) throw new Error('ORDERQ_UNRESOLVED_REVIEW_INDEXEDDB_UNAVAILABLE');
  if (typeof globalThis.indexedDB.databases !== 'function') return null;
  const databases = await globalThis.indexedDB.databases();
  return databases.some(entry => entry?.name === DB_NAME);
}

function openExistingOwnerDatabase() {
  return new Promise((resolve, reject) => {
    let creationBlocked = false;
    let settled = false;
    const complete = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const request = globalThis.indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      creationBlocked = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      if (creationBlocked) {
        request.result?.close();
        complete(reject, new Error('ORDERQ_UNRESOLVED_REVIEW_DB_UNEXPECTED_CREATION_BLOCKED'));
        return;
      }
      complete(resolve, request.result);
    };
    request.onerror = () => {
      if (creationBlocked && request.error?.name === 'AbortError') {
        complete(reject, new Error('ORDERQ_UNRESOLVED_REVIEW_DB_UNEXPECTED_CREATION_BLOCKED'));
        return;
      }
      complete(reject, request.error || new Error('ORDERQ_UNRESOLVED_REVIEW_DB_OPEN_FAILED'));
    };
    request.onblocked = () => complete(reject, new Error('ORDERQ_UNRESOLVED_REVIEW_DB_OPEN_BLOCKED'));
  });
}

function requireStore(db, name) {
  if (!db.objectStoreNames.contains(name)) throw new Error(`ORDERQ_UNRESOLVED_REVIEW_STORE_MISSING:${name}`);
}

function requireIndex(store, name) {
  if (!store.indexNames.contains(name)) throw new Error(`ORDERQ_UNRESOLVED_REVIEW_INDEX_MISSING:${store.name}:${name}`);
  return store.index(name);
}

function companyRange(companyId) {
  if (!globalThis.IDBKeyRange) throw new Error('ORDERQ_UNRESOLVED_REVIEW_KEY_RANGE_UNAVAILABLE');
  return globalThis.IDBKeyRange.bound([companyId, '', ''], [companyId, '\uffff', '\uffff']);
}

function companyWarehouseRange(companyId, warehouseId) {
  if (!globalThis.IDBKeyRange) throw new Error('ORDERQ_UNRESOLVED_REVIEW_KEY_RANGE_UNAVAILABLE');
  return globalThis.IDBKeyRange.bound([companyId, warehouseId, ''], [companyId, warehouseId, '\uffff']);
}

function uniqueRows(rows, idOf) {
  const byId = new Map();
  rows.filter(Boolean).forEach(row => byId.set(exactText(idOf(row)), row));
  byId.delete('');
  return [...byId.values()];
}

function referenceIds(unresolvedRows, pendingRows) {
  const reviewLinks = unresolvedRows.flatMap(row => Array.isArray(row.reviewLinks) ? row.reviewLinks : []);
  const combined = [...pendingRows, ...reviewLinks];
  const documents = { purchase: new Set(), sale: new Set() };
  const lines = { purchase: new Set(), sale: new Set() };
  const revisions = new Set();
  combined.forEach(row => {
    const mode = exactText(row.voucherMode).toLowerCase();
    if (!['purchase', 'sale'].includes(mode)) return;
    const documentId = exactText(row.sourceDocumentId || row.documentId);
    const lineId = exactText(row.sourceLineId || row.lineId);
    if (documentId) documents[mode].add(documentId);
    if (lineId) lines[mode].add(lineId);
    const revisionId = exactText(row.voucherRevisionId);
    if (revisionId) revisions.add(revisionId);
  });
  return { documents, lines, revisions, reviewLinks };
}

async function pointReads(store, ids) {
  return Promise.all([...ids].map(id => requestToPromise(store.get(id))));
}

export async function readOfficialUnresolvedReviewSources({
  companyId: requestedCompanyId,
  unresolvedProductId: requestedUnresolvedProductId = '',
  includeCheckpoints = false,
  readAt
} = {}) {
  const companyId = requiredCompanyId(requestedCompanyId);
  const unresolvedProductId = exactText(requestedUnresolvedProductId);
  const exists = await ownerDatabaseExists();
  if (exists === false) {
    return {
      ownerDatabaseState: 'ABSENT',
      companyId,
      readAt: exactText(readAt) || new Date().toISOString(),
      unresolvedProducts: [],
      pendingInventoryEffects: [],
      purchaseDocuments: [],
      purchaseLines: [],
      salesDocuments: [],
      salesLines: [],
      voucherRevisions: [],
      inventoryCheckpoints: []
    };
  }

  let db;
  try {
    db = await openExistingOwnerDatabase();
  } catch (error) {
    if (exactText(error?.message) === 'ORDERQ_UNRESOLVED_REVIEW_DB_UNEXPECTED_CREATION_BLOCKED') {
      return {
        ownerDatabaseState: 'ABSENT',
        companyId,
        readAt: exactText(readAt) || new Date().toISOString(),
        unresolvedProducts: [],
        pendingInventoryEffects: [],
        purchaseDocuments: [],
        purchaseLines: [],
        salesDocuments: [],
        salesLines: [],
        voucherRevisions: [],
        inventoryCheckpoints: []
      };
    }
    throw error;
  }

  try {
    const storeNames = [
      STORE.UNRESOLVED_PRODUCTS,
      STORE.PENDING_INVENTORY_EFFECTS,
      STORE.PURCHASE_DOCUMENTS,
      STORE.PURCHASE_LINES,
      STORE.SALES_DOCUMENTS,
      STORE.SALES_LINES,
      STORE.VOUCHER_REVISIONS
    ];
    if (includeCheckpoints) storeNames.push(STORE.INVENTORY_CHECKPOINTS);
    storeNames.forEach(name => requireStore(db, name));
    const tx = db.transaction(storeNames, 'readonly');
    const done = transactionDone(tx);
    const unresolvedStore = tx.objectStore(STORE.UNRESOLVED_PRODUCTS);
    const pendingStore = tx.objectStore(STORE.PENDING_INVENTORY_EFFECTS);
    const unresolvedIndex = requireIndex(unresolvedStore, 'byCompanyStatus');
    const pendingIndex = requireIndex(pendingStore, 'byCompanyWarehouseStatus');
    const [unresolvedV2Rows, unresolvedCompatibilityRows, companyPendingRows] = await Promise.all([
      requestToPromise(unresolvedIndex.getAll([companyId, 'UNRESOLVED_PRODUCT'])),
      requestToPromise(unresolvedIndex.getAll([companyId, 'UNRESOLVED'])),
      requestToPromise(pendingIndex.getAll(companyRange(companyId)))
    ]);
    const unresolvedRows = uniqueRows([...unresolvedV2Rows, ...unresolvedCompatibilityRows]
      .filter(row => exactText(row.companyId) === companyId)
      .filter(row => !unresolvedProductId || exactText(row.unresolvedProductId) === unresolvedProductId),
    row => row.unresolvedProductId);
    const pendingRows = uniqueRows(companyPendingRows
      .filter(row => exactText(row.companyId) === companyId
        && exactText(row.status).toUpperCase() === 'PENDING_PRODUCT_MATCH')
      .filter(row => !unresolvedProductId || exactText(row.unresolvedProductId) === unresolvedProductId),
    row => row.pendingEffectId);
    const ids = referenceIds(unresolvedRows, pendingRows);

    const [purchaseDocuments, purchaseLines, salesDocuments, salesLines, voucherRevisions] = await Promise.all([
      pointReads(tx.objectStore(STORE.PURCHASE_DOCUMENTS), ids.documents.purchase),
      pointReads(tx.objectStore(STORE.PURCHASE_LINES), ids.lines.purchase),
      pointReads(tx.objectStore(STORE.SALES_DOCUMENTS), ids.documents.sale),
      pointReads(tx.objectStore(STORE.SALES_LINES), ids.lines.sale),
      pointReads(tx.objectStore(STORE.VOUCHER_REVISIONS), ids.revisions)
    ]);

    let inventoryCheckpoints = [];
    if (includeCheckpoints) {
      const warehouseIds = [...new Set([...pendingRows, ...ids.reviewLinks]
        .map(row => exactText(row.warehouseId)).filter(Boolean))];
      const checkpointStore = tx.objectStore(STORE.INVENTORY_CHECKPOINTS);
      const checkpointIndex = requireIndex(checkpointStore, 'byCompanyWarehouseEffectiveAt');
      const checkpointBatches = await Promise.all(warehouseIds.map(warehouseId => requestToPromise(
        checkpointIndex.getAll(companyWarehouseRange(companyId, warehouseId))
      )));
      inventoryCheckpoints = checkpointBatches.flat().filter(row => exactText(row.companyId) === companyId);
    }

    await done;
    return clone({
      ownerDatabaseState: 'READY',
      companyId,
      readAt: exactText(readAt) || new Date().toISOString(),
      unresolvedProducts: unresolvedRows,
      pendingInventoryEffects: pendingRows,
      purchaseDocuments: purchaseDocuments.filter(Boolean),
      purchaseLines: purchaseLines.filter(Boolean),
      salesDocuments: salesDocuments.filter(Boolean),
      salesLines: salesLines.filter(Boolean),
      voucherRevisions: voucherRevisions.filter(Boolean),
      inventoryCheckpoints
    });
  } finally {
    db?.close();
  }
}
