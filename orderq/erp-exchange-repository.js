import { STORE, newId, nowIso, openOrderQDb, requestToPromise, transactionDone } from './orderq-db.js?v=0.8.0';
import { assertOfficialCommandAuthority } from './official-command-policy.js?v=0.9.0';
import { buildErpExportRows, evaluateErpDocumentMatches, reconcileErpImportRows, transitionErpPostingStatus } from './erp-exchange.js?v=0.9.0';

async function readAll(tx, storeName) {
  return requestToPromise(tx.objectStore(storeName).getAll());
}

export async function loadErpExchangeWorkspace() {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.SALES_DOCUMENTS, STORE.SALES_LINES, STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES], 'readonly');
  const [salesDocuments, salesLines, purchaseDocuments, purchaseLines] = await Promise.all([
    readAll(tx, STORE.SALES_DOCUMENTS), readAll(tx, STORE.SALES_LINES),
    readAll(tx, STORE.PURCHASE_DOCUMENTS), readAll(tx, STORE.PURCHASE_LINES)
  ]);
  await transactionDone(tx);
  return {
    salesDocuments, salesLines, purchaseDocuments, purchaseLines,
    rows: buildErpExportRows({ salesDocuments, salesLines, purchaseDocuments, purchaseLines }),
    candidateRows: buildErpExportRows(
      { salesDocuments, salesLines, purchaseDocuments, purchaseLines },
      ['EXPORTED', 'POSTED']
    )
  };
}

export async function markErpDocumentsExported(source = {}, actorId = 'ADMIN') {
  assertOfficialCommandAuthority('ERP_TRANSITION');
  const documentIds = new Set(Array.isArray(source.documentIds) ? source.documentIds.map(String) : []);
  const batchId = String(source.erpExportBatchId || newId('ERP-EXPORT'));
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const stores = [STORE.SALES_DOCUMENTS, STORE.PURCHASE_DOCUMENTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(stores, 'readwrite');
  const changed = [];
  for (const storeName of [STORE.SALES_DOCUMENTS, STORE.PURCHASE_DOCUMENTS]) {
    const store = tx.objectStore(storeName);
    const rows = await requestToPromise(store.getAll());
    for (const document of rows.filter(row => documentIds.has(String(row.salesDocumentId || row.purchaseDocumentId)))) {
      const next = transitionErpPostingStatus(document, 'EXPORTED', {
        erpExportBatchId:batchId, at:timestamp, actorId
      });
      next.revision = Number(document.revision || 0) + 1;
      next.baseRevision = Number(document.revision || 0);
      next.updatedAt = timestamp;
      next.updatedBy = actorId;
      store.put(next);
      changed.push(next);
    }
  }
  await transactionDone(tx);
  return { erpExportBatchId:batchId, documents:changed };
}

export async function transitionErpDocuments(source = {}, actorId = 'ADMIN') {
  assertOfficialCommandAuthority('ERP_TRANSITION');
  const transitions = Array.isArray(source.transitions) ? source.transitions : [];
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.SALES_DOCUMENTS, STORE.PURCHASE_DOCUMENTS], 'readwrite');
  const changed = [];
  for (const input of transitions) {
    const type = String(input.documentType || '').toUpperCase();
    const storeName = type === 'SALES' ? STORE.SALES_DOCUMENTS : type === 'PURCHASE' ? STORE.PURCHASE_DOCUMENTS : '';
    const id = String(input.documentId || '');
    if (!storeName || !id) throw new Error('ORDERQ_ERP_TRANSITION_DOCUMENT_INVALID');
    const store = tx.objectStore(storeName);
    const document = await requestToPromise(store.get(id));
    if (!document) throw new Error(`ORDERQ_ERP_DOCUMENT_NOT_FOUND:${id}`);
    const next = transitionErpPostingStatus(document, input.nextStatus, {
      ...input, at:timestamp, actorId
    });
    next.revision = Number(document.revision || 0) + 1;
    next.baseRevision = Number(document.revision || 0);
    next.updatedAt = timestamp;
    next.updatedBy = actorId;
    store.put(next);
    changed.push(next);
  }
  await transactionDone(tx);
  return { documents:changed };
}

export async function reconcileErpRows(importRows = []) {
  const workspace = await loadErpExchangeWorkspace();
  const candidates = [...workspace.candidateRows.sales, ...workspace.candidateRows.purchases];
  const rows = reconcileErpImportRows(importRows, candidates);
  return { rows, documents:evaluateErpDocumentMatches(rows, candidates) };
}
