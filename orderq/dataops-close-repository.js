import { STORE, openOrderQDb, requestToPromise, transactionDone } from './orderq-db.js?v=0.18.0';

const rowStores=Object.freeze({
  inventoryRows:STORE.CLOSE_INVENTORY_ROWS,orderRows:STORE.CLOSE_ORDER_ROWS,purchaseRows:STORE.CLOSE_PURCHASE_ROWS,
  salesRows:STORE.CLOSE_SALES_ROWS,receivableRows:STORE.CLOSE_RECEIVABLE_ROWS,payableRows:STORE.CLOSE_PAYABLE_ROWS,
  issues:STORE.CLOSE_ISSUES,issueDecisions:STORE.CLOSE_ISSUE_DECISIONS,auditEvents:STORE.CLOSE_AUDIT_EVENTS,
  reportManifests:STORE.CLOSE_REPORT_MANIFESTS
});

export async function saveApprovedCloseBaseline(row){
  if(!row||row.status!=='APPROVED'||!String(row.baselineId||'').trim())throw new Error('CLOSE_BASELINE_APPROVAL_REQUIRED');
  const db=await openOrderQDb(),tx=db.transaction(STORE.APPROVED_CLOSE_BASELINES,'readwrite');tx.objectStore(STORE.APPROVED_CLOSE_BASELINES).add(row);await transactionDone(tx);return row;
}

export async function saveCloseProjection(bundle={}){
  const db=await openOrderQDb(),names=[STORE.CLOSE_SERIES,STORE.CLOSE_REVISIONS,STORE.CLOSE_SOURCE_SNAPSHOTS,STORE.CLOSE_RESULT_SNAPSHOTS,STORE.META,...Object.values(rowStores)],tx=db.transaction(names,'readwrite');
  const existing=await requestToPromise(tx.objectStore(STORE.CLOSE_REVISIONS).index('byIdempotencyKey').get(bundle.revision.idempotencyKey));
  if(existing){if(existing.finalReceiptFingerprint!==bundle.revision.finalReceiptFingerprint)throw new Error('CLOSE_IDEMPOTENCY_CONFLICT');await transactionDone(tx);return existing;}
  tx.objectStore(STORE.CLOSE_SOURCE_SNAPSHOTS).put(bundle.sourceSnapshot);tx.objectStore(STORE.CLOSE_RESULT_SNAPSHOTS).put(bundle.resultSnapshot);tx.objectStore(STORE.CLOSE_REVISIONS).put(bundle.revision);tx.objectStore(STORE.CLOSE_SERIES).put(bundle.series);
  for(const [field,storeName] of Object.entries(rowStores))for(const row of bundle[field]||[])tx.objectStore(storeName).put(row);
  const meta=tx.objectStore(STORE.META),pointer=(await requestToPromise(meta.get('currentClosePointers')))?.value||{};pointer[bundle.series.closeSeriesId]={seriesHeadRevisionId:bundle.series.seriesHeadRevisionId,currentEffectiveRevisionId:bundle.series.currentEffectiveRevisionId};meta.put({key:'currentClosePointers',value:pointer,updatedAt:new Date().toISOString()});
  await transactionDone(tx);return bundle.revision;
}

export async function loadCloseSeries(closeSeriesId){const db=await openOrderQDb();return requestToPromise(db.transaction(STORE.CLOSE_SERIES).objectStore(STORE.CLOSE_SERIES).get(closeSeriesId));}
export async function listCloseRevisions(closeSeriesId){const db=await openOrderQDb(),rows=await requestToPromise(db.transaction(STORE.CLOSE_REVISIONS).objectStore(STORE.CLOSE_REVISIONS).index('bySeriesStatus').getAll(IDBKeyRange.bound([closeSeriesId,''],[closeSeriesId,'\uffff'])));return rows.sort((a,b)=>a.revision-b.revision);}
