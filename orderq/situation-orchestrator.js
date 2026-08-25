import { beginDataOpsFrozenRead,readDataOpsFrozenPages,confirmDataOpsFrozenHead } from './dataops-situation-read-adapter.js?v=0.1.0';
import { analyzeSituation } from './situation-analysis.js?v=0.1.0';
import { saveSituationAnalysis } from './situation-repository.js?v=0.1.0';
import { withSituationReadRetries,crossAuthorityHandshakeDigest,validateFrozenSession,validatePageManifest } from './situation-read-token.js?v=0.1.0';
import { effectiveOrderQuantity,effectiveTransferredQuantity } from './order-fulfillment-lifecycle.js?v=0.8.0';

async function beginOrderQFrozenRead({adapter,dataOps,businessDate,windowKey,closeContext=null,closeSeriesId='',now=Date.now()}) {
  if (!adapter?.begin || !adapter?.page || !adapter?.head) throw new Error('ORDERQ_SITUATION_READ_CAPABILITY_REQUIRED');
  return validateFrozenSession(await adapter.begin({businessDate,windowKey,dataOpsReadSessionId:dataOps.readSessionId,dataOpsTokenDigest:dataOps.tokenDigest,...(closeContext?{readPurpose:'DATAOPS_CLOSE',closeSeriesId,closeContextDigest:closeContext.contextDigest}: {})}),'ORDERQ',now);
}
async function readOrderQFrozenPages(adapter,begin) {
  const pages=[];for(const item of begin.pageManifest?.pages||begin.pageManifest||[])pages.push(await adapter.page({readSessionId:begin.readSessionId,tokenDigest:begin.tokenDigest,pageIndex:item.pageIndex}));
  await validatePageManifest(begin,pages);return pages;
}
async function confirmOrderQFrozenHead(adapter,begin) {
  const head=await adapter.head({readSessionId:begin.readSessionId,tokenDigest:begin.tokenDigest});
  if(head.frozenTokenDigest!==begin.tokenDigest||head.currentHeadRevision!==begin.headRevision||head.currentHeadDigest!==begin.headDigest)throw new Error('SITUATION_HEAD_CHANGED');
  return head;
}
function assembleOrderQSnapshot(begin,pages,head) {
  const entities=pages.flatMap(page=>page.entities||[]),byType=type=>entities.filter(row=>String(row.entityType||'').toUpperCase()===type).map(row=>({...row.payload,revision:row.revision,status:row.status}));
  const orders=byType('ORDER'),items=byType('ORDER_ITEM'),events=byType('ORDER_EVENT'),orderById=new Map(orders.map(row=>[row.orderId,row]));
  const orderLines=items.map(item=>{const order=orderById.get(item.orderId)||{},effective=effectiveOrderQuantity(order,item),transferred=effectiveTransferredQuantity(item.orderItemId,events);return {...item,orderNo:order.orderNo,customerId:order.customerId,warehouseId:item.warehouseId||order.warehouseId||null,effectiveOrderQuantity:effective,transferredRecognizedQuantity:transferred,overDispatchQuantity:Math.max(0,transferred-effective),remainingRecognizedQuantity:Math.max(0,effective-transferred)};});
  const inventoryMovements=byType('INVENTORY_MOVEMENT'),purchaseDocuments=byType('PURCHASE_DOCUMENT'),purchaseIds=new Set(purchaseDocuments.map(row=>row.purchaseDocumentId||row.documentId));
  return {session:begin,head,pages,...(begin.entityManifest||{}),ledgerUpperBound:begin.ledgerUpperBound,entities,movements:inventoryMovements,products:byType('PRODUCT'),warehouses:byType('WAREHOUSE'),orderLines,purchaseDocuments,purchaseMovements:inventoryMovements.filter(row=>purchaseIds.has(row.sourceDocumentId||row.purchaseDocumentId))};
}
export async function readOrderQFrozenSnapshot({adapter,dataOps,businessDate,windowKey,closeContext=null,closeSeriesId='',now=Date.now()}) {
  const session=dataOps.session||dataOps,begin=await beginOrderQFrozenRead({adapter,dataOps:session,businessDate,windowKey,closeContext,closeSeriesId,now}),pages=await readOrderQFrozenPages(adapter,begin),head=await confirmOrderQFrozenHead(adapter,begin);
  return assembleOrderQSnapshot(begin,pages,head);
}
export async function runCurrentSituation(options) {
  return withSituationReadRetries(async attempt=>{
    const dataOpsBegin=await (options.beginDataOps||beginDataOpsFrozenRead)({...options.dataOps,businessDate:options.businessDate});
    const orderQBegin=await beginOrderQFrozenRead({adapter:options.orderQAdapter,dataOps:dataOpsBegin,businessDate:options.businessDate,windowKey:options.windowKey});
    const dataOpsPages=await (options.readDataOpsPages||readDataOpsFrozenPages)(options.dataOps,dataOpsBegin);
    const orderQPages=await readOrderQFrozenPages(options.orderQAdapter,orderQBegin);
    const orderQHead=await confirmOrderQFrozenHead(options.orderQAdapter,orderQBegin);
    const dataOpsHead=await (options.confirmDataOpsHead||confirmDataOpsFrozenHead)(options.dataOps,dataOpsBegin);
    const dataOps={session:dataOpsBegin,head:dataOpsHead,manifest:dataOpsBegin.entityManifest?.manifest||dataOpsBegin.manifest,rows:dataOpsPages.flatMap(page=>page.rows||[]),pages:dataOpsPages};
    const orderQ=assembleOrderQSnapshot(orderQBegin,orderQPages,orderQHead);
    const handshake=await crossAuthorityHandshakeDigest(dataOps.session,orderQ.session);
    if(orderQ.session.crossAuthorityHandshakeDigest!==handshake)throw new Error('SITUATION_HEAD_CHANGED');
    const analysis=await analyzeSituation({businessDate:options.businessDate,windowKey:options.windowKey,operationWindow:options.operationWindow,dataOps,orderQ});
    analysis.attempt=attempt;return (options.save||saveSituationAnalysis)(analysis);
  },options.onRetry);
}
