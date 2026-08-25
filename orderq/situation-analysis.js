import { canonicalSha256 } from './situation-read-token.js?v=0.1.0';
import { SITUATION_ALGORITHM_VERSION } from './orderq-v15-contracts.js?v=0.1.0';

const SEP='\u001f';
const finite=(value,code='SITUATION_QUANTITY_INVALID')=>{const number=Number(value);if(!Number.isFinite(number))throw new Error(code);return Object.is(number,-0)?0:number;};
export const inventoryKey=(productId,warehouseId,baseUnit)=>[productId,warehouseId,baseUnit].map(value=>String(value??'')).join(SEP);
const active=row=>row && row.status!=='TOMBSTONED' && row.active!==false && !row.disabledAt;
function exactMasters(row, masters) {
  const product=masters.products.get(row.productId), warehouse=masters.warehouses.get(row.warehouseId);
  if (!product || !warehouse || product.status==='INACTIVE' || warehouse.status==='INACTIVE') return 'REVIEW_REQUIRED_MASTER_INACTIVE';
  if (Number(product.revision)!==Number(row.productMasterRevision) || Number(warehouse.revision)!==Number(row.warehouseMasterRevision)) return 'REVIEW_REQUIRED_MASTER_REVISION';
  if (String(product.baseUnit)!==String(row.baseUnit) || String(product.baseUnitRuleVersion)!==String(row.baseUnitRuleVersion)) return 'REVIEW_REQUIRED_BASE_UNIT';
  return '';
}
export function validateMovementManifest(manifest, movements) {
  const declared=new Set(manifest.movementIds||[]), ids=new Map(), effects=new Map(); let duplicates=0;
  for(const row of movements){
    if(!declared.has(row.movementId)) throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
    const canonical=JSON.stringify(row);
    if(ids.has(row.movementId)){if(ids.get(row.movementId)!==canonical)throw new Error('SITUATION_MOVEMENT_IDEMPOTENCY_CONFLICT');duplicates+=1;continue;}
    if(row.effectKey && effects.has(row.effectKey) && effects.get(row.effectKey)!==row.movementId)throw new Error('SITUATION_MOVEMENT_IDEMPOTENCY_CONFLICT');
    ids.set(row.movementId,canonical);if(row.effectKey)effects.set(row.effectKey,row.movementId);
  }
  if(ids.size!==Number(manifest.movementCount||0)||[...declared].some(id=>!ids.has(id)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  if(Array.isArray(manifest.effectKeys)&&([...effects.keys()].sort().join(SEP)!==[...manifest.effectKeys].map(String).sort().join(SEP)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  const tombstones=new Set((manifest.tombstoneIds||[]).map(String));
  if(movements.some(row=>tombstones.has(String(row.movementId))&&active(row)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  return {rows:[...ids.keys()].map(id=>movements.find(row=>row.movementId===id)),transportDuplicateCount:duplicates};
}
export function calculateAlreadyPurchased({documents=[],movements=[],window,ledgerUpperBound}) {
  const from=String(window?.from||''),to=String(window?.to||'');
  if(!from||!to||from>to)throw new Error('SITUATION_OPERATION_WINDOW_INVALID');
  const cohort=new Set(documents.filter(document=>document.commandContract==='VOUCHER_CORE_V1'&&String(document.businessDate||document.purchaseDate||'')>=from&&String(document.businessDate||document.purchaseDate||'')<=to).map(document=>document.documentId||document.purchaseDocumentId));
  const totals=new Map();
  for(const effect of movements){
    if(!cohort.has(effect.documentId)||!active(effect)||finite(effect.ledgerSequence)>finite(ledgerUpperBound))continue;
    const key=effect.inventoryKey||inventoryKey(effect.productId,effect.warehouseId,effect.baseUnit);
    const row=totals.get(key)||{key,productId:effect.productId,warehouseId:effect.warehouseId,baseUnit:effect.baseUnit,orderQPurchasedBaseQuantity:0,directPurchasedBaseQuantity:0,legacyMigratedPurchasedBaseQuantity:0,alreadyPurchasedBaseQuantity:0,evidence:[],issues:[]};
    const quantity=finite(effect.signedBaseQuantity),source=String(effect.sourceType||effect.originType||String(effect.sourceDocumentType||'').replace(/_PURCHASE$/i,'')||'').toUpperCase();
    if(source==='DIRECT'){row.directPurchasedBaseQuantity+=quantity;if(!effect.reasonCode&&!effect.reasonText)row.issues.push('DIRECT_PURCHASE_REASON_REVIEW');}
    else if(source==='LEGACY_MIGRATED')row.legacyMigratedPurchasedBaseQuantity+=quantity;
    else row.orderQPurchasedBaseQuantity+=quantity;
    row.alreadyPurchasedBaseQuantity+=quantity;
    row.evidence.push({documentId:effect.documentId,documentRevision:effect.documentRevision,movementId:effect.movementId,effectKey:effect.effectKey,sourceType:source,reasonCode:effect.reasonCode||'',reasonText:effect.reasonText||'',externalDocumentNo:effect.externalDocumentNo||''});
    totals.set(key,row);
  }
  return [...totals.values()];
}
export async function analyzeSituation(input) {
  const dataRows=input.dataOps.rows||[], movementResult=validateMovementManifest(input.orderQ.movementManifest,input.orderQ.movements||[]);
  const upper=finite(input.orderQ.ledgerUpperBound); const masters={products:new Map((input.orderQ.products||[]).map(row=>[row.productId,row])),warehouses:new Map((input.orderQ.warehouses||[]).map(row=>[row.warehouseId,row]))};
  const stock=new Map(),issues=[];
  for(const row of dataRows){if(!active(row))continue;const key=inventoryKey(row.productId,row.warehouseId,row.baseUnit);if(stock.has(key))throw new Error('SITUATION_DATAOPS_DUPLICATE_KEY');if(finite(row.includedOrderQLedgerSequence)>upper)throw new Error('SITUATION_DATAOPS_FUTURE_WATERMARK');const issue=exactMasters(row,masters);stock.set(key,{key,row,currentStock:finite(row.signedBaseQuantity),cutoff:finite(row.includedOrderQLedgerSequence),issue});if(issue)issues.push({code:issue,key});}
  for(const movement of movementResult.rows){if(!active(movement))continue;const key=movement.inventoryKey||inventoryKey(movement.productId,movement.warehouseId,movement.baseUnit);const target=stock.get(key);if(!target)continue;const seq=finite(movement.ledgerSequence);if(seq>target.cutoff&&seq<=upper)target.currentStock+=finite(movement.signedBaseQuantity);}
  const demands=new Map();
  for(const line of input.orderQ.orderLines||[]){const remaining=finite(line.remainingRecognizedQuantity??line.remainingQty);if(remaining<=0)continue;const warehouseId=line.warehouseId||null;const key=inventoryKey(line.productId,warehouseId||'UNASSIGNED',line.baseUnit);const current=demands.get(key)||{key,productId:line.productId,warehouseId,baseUnit:line.baseUnit,remainingRecognizedQuantity:0,sourceLines:[]};current.remainingRecognizedQuantity+=remaining;current.sourceLines.push(line);demands.set(key,current);}
  const rows=[];
  for(const demand of demands.values()){
    if(!demand.warehouseId){issues.push({code:'REVIEW_REQUIRED_WAREHOUSE_ASSIGNMENT',key:demand.key});rows.push({...demand,status:'REVIEW_REQUIRED_WAREHOUSE_ASSIGNMENT',currentStockBaseQuantity:0,inventoryRecoveryRequiredBaseQuantity:0,orderFulfillmentRequiredBaseQuantity:0,additionalPurchaseRequiredBaseQuantity:0,dispatchNowRecognizedQuantity:0});continue;}
    const state=stock.get(demand.key);if(!state){issues.push({code:'DATAOPS_INVENTORY_KEY_MISSING',key:demand.key});rows.push({...demand,status:'DATAOPS_INVENTORY_KEY_MISSING',additionalPurchaseRequiredBaseQuantity:0,dispatchNowRecognizedQuantity:0});continue;}
    if(state.issue){rows.push({...demand,status:state.issue,currentStockBaseQuantity:state.currentStock,additionalPurchaseRequiredBaseQuantity:0,dispatchNowRecognizedQuantity:0});continue;}
    const factorSource=demand.sourceLines[0]||{};const factorIdentity=line=>[line.actualToBaseFactor,line.actualToRecognizedFactor,line.conversionSource,line.conversionRuleId,line.conversionRuleVersion,line.actualUnit,line.baseUnit,line.recognizedUnit].map(value=>String(value??'')).join(SEP);const mixedFactors=demand.sourceLines.some(line=>factorIdentity(line)!==factorIdentity(factorSource));const actualToBase=Number(factorSource.actualToBaseFactor);const actualToRecognized=Number(factorSource.actualToRecognizedFactor);if(mixedFactors||!Number.isFinite(actualToBase)||!Number.isFinite(actualToRecognized)||actualToBase<=0||actualToRecognized<=0||!factorSource.conversionSource||!factorSource.conversionRuleVersion||!factorSource.conversionRuleId||!factorSource.actualUnit||!factorSource.recognizedUnit||!factorSource.sourceLineId||!factorSource.sourceLineRevision){issues.push({code:'REVIEW_REQUIRED_BASE_UNIT',key:demand.key});rows.push({...demand,status:'REVIEW_REQUIRED_BASE_UNIT',additionalPurchaseRequiredBaseQuantity:0,dispatchNowRecognizedQuantity:0});continue;}
    const recognizedToBase=actualToBase/actualToRecognized;const neededBase=demand.remainingRecognizedQuantity*recognizedToBase;const recovery=Math.max(0,-state.currentStock);const fulfillment=Math.max(0,neededBase-Math.max(0,state.currentStock));const purchase=recovery+fulfillment;const dispatchActual=Math.max(0,Math.floor(Math.min(demand.remainingRecognizedQuantity/actualToRecognized,Math.max(0,state.currentStock)/actualToBase)));const dispatchRecognized=dispatchActual*actualToRecognized;
    rows.push({...demand,status:'READY',currentStockBaseQuantity:state.currentStock,inventoryRecoveryRequiredBaseQuantity:recovery,orderFulfillmentRequiredBaseQuantity:fulfillment,additionalPurchaseRequiredBaseQuantity:purchase,dispatchNowActualQuantity:dispatchActual,dispatchNowBaseQuantity:dispatchActual*actualToBase,dispatchNowRecognizedQuantity:dispatchRecognized,packagingRemainderRecognizedQuantity:demand.remainingRecognizedQuantity-dispatchRecognized});
  }
  const purchased=calculateAlreadyPurchased({documents:input.orderQ.purchaseDocuments||[],movements:input.orderQ.purchaseMovements||[],window:input.operationWindow||{from:input.businessDate,to:input.businessDate},ledgerUpperBound:upper});
  const purchasedByKey=new Map(purchased.map(row=>[row.key,row]));
  rows.forEach(row=>Object.assign(row,purchasedByKey.get(row.key)||{orderQPurchasedBaseQuantity:0,directPurchasedBaseQuantity:0,legacyMigratedPurchasedBaseQuantity:0,alreadyPurchasedBaseQuantity:0}));
  const normalizedInputs={businessDate:input.businessDate,windowKey:input.windowKey,dataOpsTokenDigest:input.dataOps.session.tokenDigest,orderQTokenDigest:input.orderQ.session.tokenDigest};
  const combinedDigest=await canonicalSha256(normalizedInputs);const analysisContentDigest=await canonicalSha256({combinedDigest,algorithmVersion:SITUATION_ALGORITHM_VERSION,rows,issues,movementManifestDigest:input.orderQ.movementManifest.manifestDigest});
  return {analysisId:await canonicalSha256([combinedDigest,input.businessDate,input.windowKey,SITUATION_ALGORITHM_VERSION]),combinedDigest,businessDate:input.businessDate,windowKey:input.windowKey,algorithmVersion:SITUATION_ALGORITHM_VERSION,analysisContentDigest,status:'COMPLETED',completedAt:new Date().toISOString(),rows,alreadyPurchased:purchased,issues,transportDuplicateCount:movementResult.transportDuplicateCount};
}
