import { canonicalJson,canonicalSha256 } from './situation-read-token.js?v=0.1.0';
import { SITUATION_ALGORITHM_VERSION } from './orderq-v15-contracts.js?v=0.1.0';

const SEP='\u001f';
const finite=(value,code='SITUATION_QUANTITY_INVALID')=>{const number=Number(value);if(!Number.isFinite(number))throw new Error(code);return Object.is(number,-0)?0:number;};
const gcd=(left,right)=>{let a=left<0n?-left:left,b=right<0n?-right:right;while(b){const next=a%b;a=b;b=next;}return a||1n;};
const rational=(numerator,denominator=1n)=>{if(!denominator)throw new Error('REVIEW_REQUIRED_BASE_UNIT');const sign=denominator<0n?-1n:1n,n=numerator*sign,d=denominator*sign,divisor=gcd(n,d);return{n:n/divisor,d:d/divisor};};
const decimalRational=value=>{const source=String(value??'').trim();if(!/^[+-]?\d+(?:\.\d+)?$/.test(source))throw new Error('REVIEW_REQUIRED_BASE_UNIT');const negative=source.startsWith('-'),unsigned=source.replace(/^[+-]/,''),[whole,fraction='']=unsigned.split('.');if(fraction.length>12)throw new Error('REVIEW_REQUIRED_BASE_UNIT');return rational(BigInt(`${whole}${fraction}`)*(negative?-1n:1n),10n**BigInt(fraction.length));};
const add=(a,b)=>rational(a.n*b.d+b.n*a.d,a.d*b.d),mul=(a,b)=>rational(a.n*b.n,a.d*b.d),div=(a,b)=>rational(a.n*b.d,a.d*b.n),sub=(a,b)=>rational(a.n*b.d-b.n*a.d,a.d*b.d),compare=(a,b)=>a.n*b.d-b.n*a.d,toNumber=value=>Number(value.n)/Number(value.d),maxZero=value=>compare(value,rational(0n))>0?value:rational(0n),floorRational=value=>value.n>=0n?value.n/value.d:-((-value.n+value.d-1n)/value.d);
export const inventoryKey=(productId,warehouseId,baseUnit)=>[productId,warehouseId,baseUnit].map(value=>String(value??'')).join(SEP);
const active=row=>row && !['TOMBSTONED','DELETED','INACTIVE'].includes(String(row.status||'').toUpperCase()) && row.active!==false && !row.disabledAt;
function exactMasters(row, masters) {
  const product=masters.products.get(row.productId), warehouse=masters.warehouses.get(row.warehouseId);
  if (!product || !warehouse || product.status==='INACTIVE' || warehouse.status==='INACTIVE') return 'REVIEW_REQUIRED_MASTER_INACTIVE';
  if (Number(product.revision)!==Number(row.productMasterRevision) || Number(warehouse.revision)!==Number(row.warehouseMasterRevision)) return 'REVIEW_REQUIRED_MASTER_REVISION';
  if (String(product.baseUnit)!==String(row.baseUnit) || String(product.baseUnitRuleVersion)!==String(row.baseUnitRuleVersion)) return 'REVIEW_REQUIRED_BASE_UNIT';
  return '';
}
export async function validateMovementManifest(manifest, movements, pages=[]) {
  const declared=new Set(manifest.movementIds||[]), ids=new Map(), effects=new Map(); let duplicates=0;
  for(const row of movements){
    if(!declared.has(row.movementId)) throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
    const canonical=canonicalJson(row);
    if(ids.has(row.movementId)){if(ids.get(row.movementId)!==canonical)throw new Error('SITUATION_MOVEMENT_IDEMPOTENCY_CONFLICT');duplicates+=1;continue;}
    if(row.effectKey && effects.has(row.effectKey) && effects.get(row.effectKey)!==row.movementId)throw new Error('SITUATION_MOVEMENT_IDEMPOTENCY_CONFLICT');
    ids.set(row.movementId,canonical);if(row.effectKey)effects.set(row.effectKey,row.movementId);
  }
  if(ids.size!==Number(manifest.movementCount||0)||[...declared].some(id=>!ids.has(id)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  if(Array.isArray(manifest.effectKeys)&&([...effects.keys()].sort().join(SEP)!==[...manifest.effectKeys].map(String).sort().join(SEP)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  const tombstones=new Set((manifest.tombstoneIds||[]).map(String));
  if(movements.some(row=>tombstones.has(String(row.movementId))&&active(row)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  const inventoryKeys=[...new Set(movements.map(row=>row.inventoryKey||inventoryKey(row.productId,row.warehouseId,row.baseUnit)))].sort();
  if(Array.isArray(manifest.inventoryKeys)&&canonicalJson(inventoryKeys)!==canonicalJson([...manifest.inventoryKeys].sort()))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  const sequences=movements.map(row=>Number(row.ledgerSequence)).filter(Number.isFinite);
  if((manifest.minLedgerSequence!==undefined&&Number(manifest.minLedgerSequence)!==(sequences.length?Math.min(...sequences):0))||(manifest.maxLedgerSequence!==undefined&&Number(manifest.maxLedgerSequence)!==(sequences.length?Math.max(...sequences):0)))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  const activeRows=movements.filter(active),tombstoneRows=movements.filter(row=>tombstones.has(String(row.movementId)));
  if(manifest.activeDigest&&await canonicalSha256(activeRows)!==manifest.activeDigest)throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  if(manifest.tombstoneDigest&&await canonicalSha256(tombstoneRows)!==manifest.tombstoneDigest)throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  if(pages.length){for(let index=0;index<pages.length;index+=1){const expected=manifest.pages?.[index],rows=pages[index].movements||[];if(!expected||Number(expected.pageIndex)!==index||Number(expected.rowCount)!==rows.length||await canonicalSha256(rows)!==expected.pageDigest||pages[index].movementPageDigest!==expected.pageDigest)throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');}}
  if(manifest.manifestDigest){const source={...manifest};delete source.manifestDigest;if(await canonicalSha256(source)!==manifest.manifestDigest)throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');}
  return {rows:[...ids.keys()].map(id=>movements.find(row=>row.movementId===id)),transportDuplicateCount:duplicates};
}
export function calculateAlreadyPurchased({documents=[],movements=[],window,ledgerUpperBound}) {
  const from=String(window?.from||''),to=String(window?.to||'');
  if(!from||!to||from>to)throw new Error('SITUATION_OPERATION_WINDOW_INVALID');
  const candidates=documents.filter(document=>(document.commandContract||document.documentContract)==='VOUCHER_CORE_V1'&&String(document.businessDate||document.purchaseDate||'')>=from&&String(document.businessDate||document.purchaseDate||'')<=to),byOrigin=new Map();
  for(const document of candidates){const identity=String(document.normalizedOriginKey||document.sourceShortageKey||[document.normalizedOriginVersion,document.originSystem,document.originTransactionId,document.sourceVoucherIndex,document.sourceDocumentKey].map(value=>String(value??'')).join(SEP));const previous=byOrigin.get(identity),legacy=String(document.sourceType||'').toUpperCase()==='LEGACY_MIGRATED';if(!previous||String(previous.sourceType||'').toUpperCase()==='LEGACY_MIGRATED'&&!legacy)byOrigin.set(identity,document);}
  const selected=[...byOrigin.values()],cohort=new Set(selected.map(document=>document.documentId||document.purchaseDocumentId)),documentById=new Map(selected.map(document=>[document.documentId||document.purchaseDocumentId,document]));
  const totals=new Map();
  for(const effect of movements){
    const effectDocumentId=effect.documentId||effect.sourceDocumentId||effect.purchaseDocumentId;if(!cohort.has(effectDocumentId)||!active(effect)||finite(effect.ledgerSequence)>finite(ledgerUpperBound))continue;
    const key=effect.inventoryKey||inventoryKey(effect.productId,effect.warehouseId,effect.baseUnit);
    const row=totals.get(key)||{key,productId:effect.productId,warehouseId:effect.warehouseId,baseUnit:effect.baseUnit,orderQPurchasedBaseQuantity:0,directPurchasedBaseQuantity:0,legacyMigratedPurchasedBaseQuantity:0,alreadyPurchasedBaseQuantity:0,evidence:[],issues:[]};
    const document=documentById.get(effectDocumentId)||{},quantity=finite(effect.signedBaseQuantity),source=String(effect.sourceType||effect.originType||document.sourceType||String(effect.sourceDocumentType||'').replace(/_PURCHASE$/i,'')||'').toUpperCase(),reasonCode=effect.reasonCode||document.reasonCode||'',reasonText=effect.reasonText||document.reasonText||document.reason||'';
    if(source==='DIRECT'){row.directPurchasedBaseQuantity+=quantity;if(!reasonCode&&!reasonText)row.issues.push('DIRECT_PURCHASE_REASON_REVIEW');}
    else if(source==='LEGACY_MIGRATED')row.legacyMigratedPurchasedBaseQuantity+=quantity;
    else row.orderQPurchasedBaseQuantity+=quantity;
    row.alreadyPurchasedBaseQuantity+=quantity;
    row.evidence.push({documentId:effectDocumentId,documentRevision:effect.documentRevision||effect.sourceDocumentRevision,movementId:effect.movementId,effectKey:effect.effectKey,reversalOf:effect.reversalOf||'',sourceType:source,reasonCode,reasonText,externalDocumentNo:effect.externalDocumentNo||document.externalDocumentNo||''});
    totals.set(key,row);
  }
  return [...totals.values()];
}
export async function analyzeSituation(input) {
  const dataRows=input.dataOps.rows||[], movementResult=await validateMovementManifest(input.orderQ.movementManifest,input.orderQ.movements||[],input.orderQ.pages||[]);
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
    const factorSource=demand.sourceLines[0]||{};const factorIdentity=line=>[line.actualToBaseFactor,line.actualToRecognizedFactor,line.conversionSource,line.conversionRuleId,line.conversionRuleVersion,line.actualUnit,line.baseUnit,line.recognizedUnit].map(value=>String(value??'')).join(SEP);const mixedFactors=demand.sourceLines.some(line=>factorIdentity(line)!==factorIdentity(factorSource));let actualToBase,actualToRecognized,demandRational,stockRational;try{actualToBase=decimalRational(factorSource.actualToBaseFactor);actualToRecognized=decimalRational(factorSource.actualToRecognizedFactor);demandRational=demand.sourceLines.reduce((sum,line)=>add(sum,decimalRational(line.remainingRecognizedQuantity??line.remainingQty)),rational(0n));stockRational=decimalRational(state.currentStock);}catch(_){actualToBase=null;}if(mixedFactors||!actualToBase||compare(actualToBase,rational(0n))<=0||compare(actualToRecognized,rational(0n))<=0||!factorSource.conversionSource||!factorSource.conversionRuleVersion||!factorSource.conversionRuleId||!factorSource.actualUnit||!factorSource.recognizedUnit||!factorSource.sourceLineId||!factorSource.sourceLineRevision){issues.push({code:'REVIEW_REQUIRED_BASE_UNIT',key:demand.key});rows.push({...demand,status:'REVIEW_REQUIRED_BASE_UNIT',additionalPurchaseRequiredBaseQuantity:0,dispatchNowRecognizedQuantity:0});continue;}
    const recognizedToBase=div(actualToBase,actualToRecognized),neededBase=mul(demandRational,recognizedToBase),recovery=maxZero(rational(-stockRational.n,stockRational.d)),fulfillment=maxZero(sub(neededBase,maxZero(stockRational))),purchase=rational(recovery.n*fulfillment.d+fulfillment.n*recovery.d,recovery.d*fulfillment.d),byDemand=div(demandRational,actualToRecognized),byStock=div(maxZero(stockRational),actualToBase),dispatchActual=Number(floorRational(compare(byDemand,byStock)<=0?byDemand:byStock)),dispatchBase=mul(rational(BigInt(dispatchActual)),actualToBase),dispatchRecognized=mul(rational(BigInt(dispatchActual)),actualToRecognized),remainder=sub(demandRational,dispatchRecognized);
    rows.push({...demand,status:'READY',currentStockBaseQuantity:state.currentStock,recognizedToBaseFactorExact:`${recognizedToBase.n}/${recognizedToBase.d}`,inventoryRecoveryRequiredBaseQuantity:toNumber(recovery),orderFulfillmentRequiredBaseQuantity:toNumber(fulfillment),additionalPurchaseRequiredBaseQuantity:toNumber(purchase),dispatchNowActualQuantity:dispatchActual,dispatchNowBaseQuantity:toNumber(dispatchBase),dispatchNowRecognizedQuantity:toNumber(dispatchRecognized),packagingRemainderRecognizedQuantity:toNumber(remainder)});
  }
  const purchased=calculateAlreadyPurchased({documents:input.orderQ.purchaseDocuments||[],movements:input.orderQ.purchaseMovements||[],window:input.operationWindow||{from:input.businessDate,to:input.businessDate},ledgerUpperBound:upper});
  const purchasedByKey=new Map(purchased.map(row=>[row.key,row]));
  rows.forEach(row=>Object.assign(row,purchasedByKey.get(row.key)||{orderQPurchasedBaseQuantity:0,directPurchasedBaseQuantity:0,legacyMigratedPurchasedBaseQuantity:0,alreadyPurchasedBaseQuantity:0}));
  const productWarehouseRows=rows.map(row=>({...row,unshippedAfterDispatchRecognizedQuantity:Number(row.remainingRecognizedQuantity||0)-Number(row.dispatchNowRecognizedQuantity||0),evidence:{sourceLineIds:(row.sourceLines||[]).map(line=>line.sourceLineId||line.orderItemId).filter(Boolean).sort(),movementManifestDigest:input.orderQ.movementManifest.manifestDigest,alreadyPurchasedEvidence:(purchasedByKey.get(row.key)?.evidence||[])}})).sort((a,b)=>a.key.localeCompare(b.key));
  const dispatchByKey=new Map(productWarehouseRows.map(row=>[row.key,Number(row.dispatchNowRecognizedQuantity||0)])),orderRows=[];
  [...(input.orderQ.orderLines||[])].sort((a,b)=>String(a.orderId||'').localeCompare(String(b.orderId||''))||String(a.orderItemId||a.sourceLineId||'').localeCompare(String(b.orderItemId||b.sourceLineId||''))).forEach(line=>{const key=inventoryKey(line.productId,line.warehouseId||'UNASSIGNED',line.baseUnit),available=dispatchByKey.get(key)||0,remaining=Math.max(0,finite(line.remainingRecognizedQuantity??line.remainingQty)),dispatch=Math.min(available,remaining);dispatchByKey.set(key,available-dispatch);const issueCodes=[];if(!line.warehouseId)issueCodes.push('REVIEW_REQUIRED_WAREHOUSE_ASSIGNMENT');if(Number(line.overDispatchQuantity||0)>0)issueCodes.push('OVER_DISPATCH_REVIEW');orderRows.push({orderId:line.orderId||'',orderItemId:line.orderItemId||line.sourceLineId||'',orderNo:line.orderNo||'',customerId:line.customerId||'',productId:line.productId,warehouseId:line.warehouseId||null,baseUnit:line.baseUnit,effectiveOrderQuantity:Number(line.effectiveOrderQuantity??remaining),transferredRecognizedQuantity:Number(line.transferredRecognizedQuantity||0),remainingRecognizedQuantity:remaining,dispatchNowRecognizedQuantity:dispatch,unshippedAfterDispatchRecognizedQuantity:remaining-dispatch,overDispatchQuantity:Number(line.overDispatchQuantity||0),status:issueCodes[0]||'READY',issueCodes,evidence:{sourceLineId:line.sourceLineId||'',sourceLineRevision:line.sourceLineRevision||line.revision||0,conversionRuleId:line.conversionRuleId||'',conversionRuleVersion:line.conversionRuleVersion||''}});});
  orderRows.forEach(row=>row.issueCodes.forEach(code=>issues.push({code,key:`${row.orderId}${SEP}${row.orderItemId}`,orderId:row.orderId,orderItemId:row.orderItemId})));
  productWarehouseRows.forEach(row=>{if(Number(row.packagingRemainderRecognizedQuantity||0)>0)issues.push({code:'PACKAGING_REMAINDER',key:row.key,quantity:row.packagingRemainderRecognizedQuantity});});
  const issueRows=[...issues].sort((a,b)=>String(a.code).localeCompare(String(b.code))||String(a.key).localeCompare(String(b.key)));
  const normalizedInputs={businessDate:input.businessDate,windowKey:input.windowKey,dataOpsTokenDigest:input.dataOps.session.tokenDigest,dataOpsManifestDigest:await canonicalSha256(input.dataOps.manifest||{}),orderQTokenDigest:input.orderQ.session.tokenDigest,movementManifestDigest:input.orderQ.movementManifest.manifestDigest,algorithmVersion:SITUATION_ALGORITHM_VERSION};
  const combinedDigest=await canonicalSha256(normalizedInputs);const analysisContentDigest=await canonicalSha256({combinedDigest,algorithmVersion:SITUATION_ALGORITHM_VERSION,productWarehouseRows,orderRows,issueRows,alreadyPurchased:purchased});
  return {analysisId:await canonicalSha256([combinedDigest,input.businessDate,input.windowKey,SITUATION_ALGORITHM_VERSION]),combinedDigest,businessDate:input.businessDate,windowKey:input.windowKey,algorithmVersion:SITUATION_ALGORITHM_VERSION,analysisContentDigest,status:'COMPLETED',completedAt:new Date().toISOString(),rows:productWarehouseRows,productWarehouseRows,orderRows,issueRows,alreadyPurchased:purchased,issues:issueRows,transportDuplicateCount:movementResult.transportDuplicateCount};
}
