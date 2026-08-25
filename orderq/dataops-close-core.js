import { canonicalJson, canonicalSha256 } from './situation-read-token.js?v=0.1.0';
import { CLOSE_ALGORITHM_VERSION, CLOSE_CONTRACT_VERSION } from './orderq-v16-contracts.js?v=0.1.0';

export const CLOSE_LIMITS=Object.freeze({chunkMaxChars:45000,chunkMaxCount:512,canonicalMaxBytes:20*1024*1024,maxResultRows:100000,maxIssues:100000,maxReportSheets:32,sourceReadTtlSeconds:120,orphanRetentionDays:7});
export const CLOSE_ACTION=Object.freeze({POST:'POST_CLOSE',CORRECT:'CORRECT_CLOSE',REVERSE:'REVERSE_CLOSE',DRY_RUN:'DRY_RUN',REPORT_ONLY:'REPORT_ONLY'});
export const CLOSE_ROLE=Object.freeze({READ:'DATAOPS_CLOSE_READ',RECONCILE:'DATAOPS_CLOSE_RECONCILE',COMMIT:'DATAOPS_CLOSE_COMMIT',CORRECT:'DATAOPS_CLOSE_CORRECT',REVERSE:'DATAOPS_CLOSE_REVERSE'});
const ENTRY_TYPES=new Set(['PAYABLE_POST','PAYABLE_CORRECTION','PAYABLE_REVERSAL','PAYABLE_PARTNER_RELEASE','PAYABLE_PARTNER_ASSIGN','RECEIVABLE_POST','RECEIVABLE_CORRECTION','RECEIVABLE_REVERSAL','RECEIVABLE_PARTNER_RELEASE','RECEIVABLE_PARTNER_ASSIGN']);
const text=value=>String(value??'').trim();
const finite=(value,code='DATAOPS_CLOSE_NUMBER_INVALID')=>{if(value===''||value===null||value===undefined)throw new Error(code);const n=Number(value);if(!Number.isFinite(n))throw new Error(code);return Object.is(n,-0)?0:n;};
const date=value=>{const v=text(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(v))throw new Error('DATAOPS_CLOSE_BUSINESS_DATE_INVALID');return v;};
const compare=(a,b)=>String(a).localeCompare(String(b),'en',{numeric:true});
const utf8=value=>new TextEncoder().encode(value).length;
const keyOf=row=>text(row.inventoryKey)||[row.productId,row.warehouseId||'UNASSIGNED',row.baseUnit].map(text).join('\u001f');

export async function stableCloseId(...parts){return (await canonicalSha256(parts)).slice(0,40);}
export async function closeSeriesIdentity(companyId,closeBusinessDate,currency='KRW',companyWideScopeIdentity=''){
  if(!text(companyId)||text(currency)!=='KRW'||!text(companyWideScopeIdentity))throw new Error('CLOSE_SCOPE_INVALID');
  return `CLOSE-${await stableCloseId('CLOSE_SERIES',text(companyId),date(closeBusinessDate),'KRW',text(companyWideScopeIdentity))}`;
}

export function validateApprovedBaseline(row, masters={products:new Map(),warehouses:new Map()}){
  if(!row||row.status!=='APPROVED'||!text(row.baselineId)||!text(row.companyId)||!text(row.inventoryKey)||!text(row.sourceSnapshotId)||!text(row.sourceRevision)||!text(row.sourceDigest)||!text(row.sourceReceiptFingerprint)||!text(row.approvedBy)||!text(row.approvedAt)||!text(row.approvalReason))throw new Error('CLOSE_OPENING_BASE_REQUIRED');
  finite(row.signedBaseQuantity,'CLOSE_OPENING_BASE_INVALID');date(row.businessDateBefore);
  if(finite(row.orderqLedgerUpperBound,'CLOSE_OPENING_BASE_INVALID')<0)throw new Error('CLOSE_OPENING_BASE_INVALID');
  const product=masters.products.get(row.productId),warehouse=masters.warehouses.get(row.warehouseId);
  if(product&&Number(product.revision)!==Number(row.productMasterRevision))throw new Error('CLOSE_OPENING_BASE_MASTER_MISMATCH');
  if(warehouse&&Number(warehouse.revision)!==Number(row.warehouseMasterRevision))throw new Error('CLOSE_OPENING_BASE_MASTER_MISMATCH');
  if(product&&text(product.baseUnit)!==text(row.baseUnit))throw new Error('CLOSE_OPENING_BASE_MASTER_MISMATCH');
  return row;
}

export function movementFlowCategory(row={}){
  const movement=text(row.movementType).toUpperCase(),source=text(row.sourceDocumentType).toUpperCase(),effect=text(row.effectKind).toUpperCase();
  if(effect==='REVERSE_OLD'||effect==='REVERSAL'||text(row.reversalOf))return finite(row.signedBaseQuantity)>=0?'reversalIncreaseBase':'reversalDecreaseBase';
  if(/PURCHASE/.test(source)||/PURCHASE|RECEIPT/.test(movement))return finite(row.signedBaseQuantity)>=0?'purchaseReceiptBase':'purchaseReturnBase';
  if(/SALE/.test(source)||/SALE|ISSUE/.test(movement))return finite(row.signedBaseQuantity)>=0?'saleReturnRestoreBase':'saleIssueBase';
  if(/TRANSFER/.test(movement))return finite(row.signedBaseQuantity)>=0?'transferInBase':'transferOutBase';
  if(/ADJUST/.test(movement))return finite(row.signedBaseQuantity)>=0?'adjustmentIncreaseBase':'adjustmentDecreaseBase';
  if(row.otherApproved===true)return 'otherApprovedBase';
  throw new Error(`CLOSE_MOVEMENT_ROUTE_UNKNOWN:${text(row.movementId)}`);
}

const FLOW_KEYS=['purchaseReceiptBase','purchaseReturnBase','saleIssueBase','saleReturnRestoreBase','transferInBase','transferOutBase','adjustmentIncreaseBase','adjustmentDecreaseBase','reversalIncreaseBase','reversalDecreaseBase','otherApprovedBase'];
export function calculateInventoryClose({businessDate,priorCloseBusinessDate='',priorRows=[],baselines=[],movements=[],dataOpsRows=[],bridgeLowerExclusive=0,bridgeUpperInclusive,closeRevisionId=''}){
  date(businessDate);const upper=finite(bridgeUpperInclusive,'CLOSE_LEDGER_UPPER_BOUND_REQUIRED'),lower=finite(bridgeLowerExclusive,'CLOSE_LEDGER_WATERMARK_INVALID');if(upper<lower)throw new Error('CLOSE_LEDGER_WATERMARK_REGRESSION');
  if(!priorRows.length&&!baselines.length)throw new Error('CLOSE_OPENING_BASE_REQUIRED');
  const priorByKey=new Map(priorRows.map(row=>[keyOf(row),row])),baselineByKey=new Map(baselines.map(row=>[keyOf(row),row])),reportedByKey=new Map(dataOpsRows.map(row=>[keyOf(row),row]));
  const keys=new Set([...priorByKey.keys(),...baselineByKey.keys(),...reportedByKey.keys(),...movements.map(keyOf)]),issues=[],result=[];
  for(const inventoryKey of [...keys].sort(compare)){
    const prior=priorByKey.get(inventoryKey),baseline=baselineByKey.get(inventoryKey),reported=reportedByKey.get(inventoryKey);if(!prior&&!baseline)throw new Error(`CLOSE_OPENING_BASE_REQUIRED:${inventoryKey}`);if(baseline)validateApprovedBaseline(baseline);const keyLower=prior?lower:finite(baseline.orderqLedgerUpperBound,'CLOSE_OPENING_BASE_INVALID');if(upper<keyLower)throw new Error('CLOSE_LEDGER_WATERMARK_REGRESSION');
    const opening=finite(prior?prior.ledgerCalculatedClosingBase:baseline.signedBaseQuantity,'CLOSE_OPENING_BASE_INVALID'),flows=Object.fromEntries(FLOW_KEYS.map(key=>[key,0]));
    const bridge=movements.filter(row=>keyOf(row)===inventoryKey&&finite(row.ledgerSequence)>keyLower&&finite(row.ledgerSequence)<=upper).sort((a,b)=>finite(a.ledgerSequence)-finite(b.ledgerSequence)||compare(a.movementId,b.movementId));
    for(const movement of bridge){const category=movementFlowCategory(movement);flows[category]+=finite(movement.signedBaseQuantity);if(priorCloseBusinessDate&&text(movement.businessDate)<=priorCloseBusinessDate){issues.push({issueCode:'BACKDATED_EFFECT_AFTER_CLOSE',severity:'REVIEW',inventoryKey,movementId:movement.movementId,effectKey:movement.effectKey,ledgerSequence:movement.ledgerSequence,sourceDocumentType:movement.sourceDocumentType,sourceDocumentId:movement.sourceDocumentId,sourceDocumentRevision:movement.sourceDocumentRevision,voucherEventId:movement.voucherEventId,commandId:movement.commandId,businessDate:movement.businessDate,occurredAt:movement.occurredAt,createdAt:movement.createdAt,priorCloseSeriesId:prior?.closeSeriesId||'',priorCloseRevision:prior?.revision||0,priorLedgerUpperBound:lower});}}
    const bridgeNetBase=Object.values(flows).reduce((sum,value)=>sum+value,0),calculated=opening+bridgeNetBase;
    const cutoff=reported?finite(reported.includedOrderQLedgerSequence):upper;const postCutoff=movements.filter(row=>keyOf(row)===inventoryKey&&finite(row.ledgerSequence)>cutoff&&finite(row.ledgerSequence)<=upper).reduce((sum,row)=>sum+finite(row.signedBaseQuantity),0);
    const reportedClosing=reported?finite(reported.signedBaseQuantity)+postCutoff:calculated;
    result.push({closeInventoryRowId:`CIR-${closeRevisionId||'DRY'}-${awaitlessHash(inventoryKey)}`,closeRevisionId,inventoryKey,productId:(reported||prior||baseline)?.productId||'',warehouseId:(reported||prior||baseline)?.warehouseId||'',baseUnit:(reported||prior||baseline)?.baseUnit||'',ledgerOpeningBase:opening,...flows,bridgeNetBase,ledgerCalculatedClosingBase:calculated,dataOpsReportedClosingBase:reportedClosing,inventoryDifferenceBase:reportedClosing-calculated,bridgeLowerExclusive:keyLower,bridgeUpperInclusive:upper,sourceOpeningType:prior?'PRIOR_CLOSE':'APPROVED_BASELINE'});
  }
  return {rows:result,issues};
}
function awaitlessHash(value){let hash=2166136261;for(const char of String(value)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16).padStart(8,'0');}

export function validateBusinessDateCohorts({documents=[],events=[],upperLedgerSequence,closedDates=new Set()}){
  const upper=finite(upperLedgerSequence),issues=[];const byDocument=new Map();
  for(const document of documents){const id=text(document.purchaseDocumentId||document.salesDocumentId||document.documentId),kind=document.purchaseDocumentId?'PURCHASE':'SALE',businessDate=text(document.purchaseDate||document.saleDate||document.businessDate);if(!businessDate)throw new Error(`${kind}_DATE_MISSING`);byDocument.set(id,{...document,documentId:id,businessDate});}
  for(const event of [...events].sort((a,b)=>finite(a.ledgerSequence)-finite(b.ledgerSequence))){if(finite(event.ledgerSequence)>upper)continue;const before=text(event.before?.businessDate||event.before?.purchaseDate||event.before?.saleDate),after=text(event.after?.businessDate||event.after?.purchaseDate||event.after?.saleDate);if(before&&after&&before!==after){issues.push({issueCode:'BUSINESS_DATE_MOVED',documentId:event.documentId,oldBusinessDate:before,newBusinessDate:after,requiresCloseCorrection:[before,after].filter(value=>closedDates.has(value))});}}
  return {documents:[...byDocument.values()],issues};
}

export async function createCloseReadToken({companyId,closeBusinessDate,orderqRead,dataopsRead,issuedAt},now=Date.now()){
  const sources=[orderqRead,dataopsRead];if(!text(companyId)||sources.some(row=>!row||!text(row.readSessionDigest)||!text(row.manifestDigest)||!text(row.headDigest)||!text(row.expiresAt)))throw new Error('CLOSE_READ_TOKEN_INVALID');
  const issued=issuedAt||new Date(now).toISOString(),expiresAt=new Date(Math.min(...sources.map(row=>Date.parse(row.expiresAt)))).toISOString();if(!Number.isFinite(Date.parse(expiresAt))||now>=Date.parse(expiresAt))throw new Error('CLOSE_READ_TOKEN_EXPIRED');
  const token={contractVersion:CLOSE_CONTRACT_VERSION,companyId:text(companyId),closeBusinessDate:date(closeBusinessDate),issuedAt:issued,expiresAt,orderq:{readSessionDigest:orderqRead.readSessionDigest,manifestDigest:orderqRead.manifestDigest,headDigest:orderqRead.headDigest,deployment:orderqRead.deployment},dataops:{readSessionDigest:dataopsRead.readSessionDigest,manifestDigest:dataopsRead.manifestDigest,headDigest:dataopsRead.headDigest,deployment:dataopsRead.deployment}};token.closeReadTokenDigest=await canonicalSha256(token);return token;
}

export async function createSourceSealReceipt(input,now=new Date().toISOString()){
  const required=['sourceSealId','closeSeriesId','sourceADigest','closeReadTokenDigest','orderqHeadDigestAtSeal','dataopsHeadDigestAtSeal','orderqDeployment','dataopsDeployment','capabilityDigest','sealedBy'];for(const key of required)if(!input?.[key]||(typeof input[key]==='object'&&!Object.values(input[key]).every(text)))throw new Error('CLOSE_SOURCE_SEAL_INVALID');
  const receipt={...input,sealedAt:input.sealedAt||now};receipt.receiptFingerprint=await canonicalSha256(receipt);return receipt;
}
export async function issueDecisionDigest(decisions=[]){const latest=new Map();for(const row of decisions){if(!text(row.issueId)||!text(row.issueDecisionId)||!text(row.decisionDigest))throw new Error('CLOSE_ISSUE_DECISION_INVALID');const previous=latest.get(row.issueId);if(!previous||compare(previous.decidedAt,row.decidedAt)<0)latest.set(row.issueId,row);}return canonicalSha256([...latest.values()].map(row=>({issueId:row.issueId,latestDecisionId:row.issueDecisionId,decisionDigest:row.decisionDigest})).sort((a,b)=>compare(a.issueId,b.issueId)));}

export async function validateCompanyCloseScope({companyId,currency='KRW',warehouseIds=[],activeWarehouses=[],warehouseMasterHeadDigest,inventoryRows=[],mode='COMMIT'}){
  if(!text(companyId)||currency!=='KRW')throw new Error('CLOSE_SCOPE_INVALID');const active=activeWarehouses.filter(row=>row.status==='ACTIVE').map(row=>({warehouseId:text(row.warehouseId),warehouseRevision:Number(row.revision)})).sort((a,b)=>compare(a.warehouseId,b.warehouseId));const selected=[...warehouseIds].map(text).sort(compare);const all=active.map(row=>row.warehouseId);
  const official=canonicalJson(selected)===canonicalJson(all);if(!official&&!['DRY_RUN','REPORT_ONLY'].includes(mode))throw new Error('CLOSE_COMPANY_WAREHOUSE_SCOPE_REQUIRED');
  const activeIds=new Set(all),issues=[];for(const row of inventoryRows){const quantity=finite(row.signedBaseQuantity??row.ledgerCalculatedClosingBase,'CLOSE_INVENTORY_BALANCE_INVALID'),warehouseId=text(row.warehouseId);if(quantity===0)continue;if(!warehouseId||warehouseId==='UNASSIGNED')issues.push({issueCode:'CLOSE_WAREHOUSE_UNASSIGNED',severity:'REVIEW',inventoryKey:keyOf(row),signedBaseQuantity:quantity});else if(!activeIds.has(warehouseId))issues.push({issueCode:'CLOSE_INACTIVE_WAREHOUSE_BALANCE',severity:'REVIEW',inventoryKey:keyOf(row),warehouseId,signedBaseQuantity:quantity});}
  return {official,mode:official?mode:'DRY_RUN',companyCloseScopeDigest:await canonicalSha256([companyId,'KRW',active,warehouseMasterHeadDigest]),activeWarehouses:active,issues};
}

export async function planCloseRevision({series=null,actionType,expectedSeriesHeadRevision=0,expectedEffectiveRevision=0,targetRevision=null,sourceSealReceipt,sourceADigest,resultBDigest,issueDecisionDigest:decisionDigest,actorId,commandId,idempotencyKey,freshVerification={},closeCloudDeployment={},closeAlgorithmVersion=CLOSE_ALGORITHM_VERSION}){
  if(!Object.values(CLOSE_ACTION).includes(actionType)||['DRY_RUN','REPORT_ONLY'].includes(actionType))throw new Error('CLOSE_ACTION_INVALID');const currentHead=Number(series?.seriesHeadRevision||0),currentEffective=Number(series?.currentEffectiveRevision||0);if(currentHead!==Number(expectedSeriesHeadRevision)||currentEffective!==Number(expectedEffectiveRevision))throw new Error('CLOSE_REVISION_CONFLICT');
  const revision=currentHead+1,closeSeriesId=series?.closeSeriesId||text(sourceSealReceipt?.closeSeriesId);if(!closeSeriesId)throw new Error('CLOSE_SERIES_REQUIRED');if(actionType==='REVERSE_CLOSE'&&Number(targetRevision)!==currentEffective)throw new Error('CLOSE_REVERSE_TARGET_INVALID');
  const priorRevisionIdentity=text(series?.seriesHeadRevisionId||'GENESIS'),effectiveRevisionIdentity=text(series?.currentEffectiveRevisionId||'NONE');
  const closeRevisionId=`CR-${await stableCloseId(closeSeriesId,revision,actionType,priorRevisionIdentity,effectiveRevisionIdentity,sourceADigest,resultBDigest,closeAlgorithmVersion)}`;
  const fingerprint=await canonicalSha256({commandContract:CLOSE_CONTRACT_VERSION,actionType,closeSeriesId,expectedSeriesHeadRevision,expectedEffectiveRevision,priorRevisionIdentity,effectiveRevisionIdentity,targetRevision,sourceSealReceiptFingerprint:sourceSealReceipt.receiptFingerprint,sourceADigest,resultBDigest,issueDecisionDigest:decisionDigest,freshOrderQHeadDigest:freshVerification.orderqHeadDigest||sourceSealReceipt.orderqHeadDigestAtSeal,freshDataOpsHeadDigest:freshVerification.dataopsHeadDigest||sourceSealReceipt.dataopsHeadDigestAtSeal,orderqDeployment:freshVerification.orderqDeployment||sourceSealReceipt.orderqDeployment,dataopsDeployment:freshVerification.dataopsDeployment||sourceSealReceipt.dataopsDeployment,closeCloudDeployment,closeAlgorithmVersion,actorId,commandId,idempotencyKey});
  const effective=actionType==='REVERSE_CLOSE'?Number(series?.previousEffectiveRevision||0):revision;
  return {revision:{closeRevisionId,closeSeriesId,revision,actionType,status:actionType==='REVERSE_CLOSE'?'REVERSED':'COMMITTED',sourceSealId:sourceSealReceipt.sourceSealId,sourceADigest,resultBDigest,issueDecisionDigest:decisionDigest,closeAlgorithmVersion,actorId,commandId,idempotencyKey,finalReceiptFingerprint:fingerprint,targetRevision:targetRevision||null},series:{...(series||{}),closeSeriesId,seriesHeadRevision:revision,seriesHeadRevisionId:closeRevisionId,previousEffectiveRevision:actionType==='REVERSE_CLOSE'?Number(series?.previousEffectiveRevision||0):currentEffective,previousEffectiveRevisionId:actionType==='REVERSE_CLOSE'?text(series?.previousEffectiveRevisionId||''):text(series?.currentEffectiveRevisionId||''),currentEffectiveRevision:effective,currentEffectiveRevisionId:effective?(effective===revision?closeRevisionId:text(series?.previousEffectiveRevisionId||'')):'',status:effective?'CLOSED':'REVERSED'},finalReceiptFingerprint:fingerprint};
}

export function validateFreshCommit({seal,current,issueDecisionDigest:expectedDecision,resultBDigest,expectedSeriesHeadRevision,series}){
  const pairs=[['orderqHeadDigestAtSeal','orderqHeadDigest'],['dataopsHeadDigestAtSeal','dataopsHeadDigest'],['capabilityDigest','capabilityDigest']];for(const [sealed,fresh] of pairs)if(text(seal[sealed])!==text(current[fresh]))throw new Error('CLOSE_SOURCE_CHANGED_AFTER_SEAL');
  if(canonicalJson(seal.orderqDeployment)!==canonicalJson(current.orderqDeployment)||canonicalJson(seal.dataopsDeployment)!==canonicalJson(current.dataopsDeployment))throw new Error('CLOSE_DEPLOYMENT_CHANGED_AFTER_SEAL');if(text(expectedDecision)!==text(current.issueDecisionDigest)||text(resultBDigest)!==text(current.resultBDigest)||Number(series?.seriesHeadRevision||0)!==Number(expectedSeriesHeadRevision))throw new Error('CLOSE_SOURCE_CHANGED_AFTER_SEAL');return true;
}

function exactEventForEntry(entry,events,entityType){const documentId=text(entry.purchaseDocumentId||entry.salesDocumentId);const matches=events.filter(event=>text(event.commandId)===text(entry.commandId)&&Number(event.sourceDocumentRevision)===Number(entry.sourceDocumentRevision)&&text(event.documentId)===documentId&&(event.lineEffects||[]).some(effect=>effect.entityType===entityType&&text(effect.entityId)===text(entry.entryId)&&text(effect.effectKind)===text(entry.entryType)));if(matches.length!==1)throw new Error('FINANCIAL_ENTRY_VOUCHER_JOIN_INVALID');return matches[0];}
export function deriveFinancialCloseRows({entries=[],voucherEvents=[],customers=[]},kind,closeRevisionId=''){
  const payable=kind==='PAYABLE',entityType=payable?'PAYABLE_ENTRY':'RECEIVABLE_ENTRY',idField=payable?'purchaseDocumentId':'salesDocumentId',customersById=new Map(customers.map(row=>[text(row.customerId),row]));const byId=new Map(entries.map(row=>[text(row.entryId),row])),ordered=[...entries].sort((a,b)=>finite(a.ledgerSequence)-finite(b.ledgerSequence)||compare(a.entryId,b.entryId));
  const seenEntry=new Set(),seenEffect=new Set(),seenBusiness=new Set();
  for(const entry of ordered){const type=text(entry.entryType);if(!ENTRY_TYPES.has(type)||(payable?!type.startsWith('PAYABLE_'):!type.startsWith('RECEIVABLE_')))throw new Error('FINANCIAL_ENTRY_TYPE_UNKNOWN');const seq=finite(entry.ledgerSequence,'FINANCIAL_ENTRY_LEDGER_SEQUENCE_INVALID');if(seenEntry.has(text(entry.entryId))||seenEffect.has(text(entry.effectKey)))throw new Error('FINANCIAL_ENTRY_IDENTITY_DUPLICATE');seenEntry.add(text(entry.entryId));seenEffect.add(text(entry.effectKey));const business=[text(entry[idField]),Number(entry.sourceDocumentRevision),type,Number(entry.effectOrdinal),text(entry.partnerId)].join('\u001f');if(seenBusiness.has(business))throw new Error('FINANCIAL_ENTRY_BUSINESS_EFFECT_DUPLICATE');seenBusiness.add(business);if(entry.reversalOf){const prior=byId.get(text(entry.reversalOf));if(!prior||text(prior[idField])!==text(entry[idField])||text(prior.partnerId)!==text(entry.partnerId)||(finite(prior.ledgerSequence)>seq)||(finite(prior.ledgerSequence)===seq&&compare(prior.entryId,entry.entryId)>=0)||text(prior.entryId)===text(entry.entryId))throw new Error('FINANCIAL_ENTRY_REVERSAL_INVALID');}}
  const descendants=new Map();ordered.forEach(row=>{if(row.reversalOf){if(!descendants.has(row.reversalOf))descendants.set(row.reversalOf,[]);descendants.get(row.reversalOf).push(row);}});const visit=(id,path=new Set())=>{if(path.has(id))throw new Error('FINANCIAL_ENTRY_REVERSAL_CYCLE');const next=new Set(path).add(id);return (descendants.get(id)||[]).reduce((sum,row)=>sum+finite(row.totalAmount)+visit(row.entryId,next),0);};
  return ordered.map(entry=>{const event=exactEventForEntry(entry,voucherEvents,entityType),snapshot=event.afterSnapshot||event.beforeSnapshot||event.after||event.before||{},businessDate=text(snapshot.businessDate||snapshot.purchaseDate||snapshot.saleDate);if(!businessDate)throw new Error('FINANCIAL_ENTRY_BUSINESS_DATE_MISSING');const original=finite(entry.totalAmount),net=original+visit(entry.entryId);if((original>0&&net<0)||(original<0&&net>0))throw new Error('FINANCIAL_ENTRY_OVER_REVERSAL');const customer=customersById.get(text(entry.partnerId))||{};return {closeFinancialRowId:`CFR-${closeRevisionId}-${entry.entryId}`,closeRevisionId,entryId:entry.entryId,entryType:entry.entryType,partnerId:entry.partnerId,partnerCode:customer.customerCode||'',partnerName:customer.customerName||'',currency:entry.currency||'KRW',ledgerSequence:entry.ledgerSequence,totalAmount:original,netAmount:net,derivedStatus:net===0?'FULLY_REVERSED':net!==original?'PARTIALLY_ADJUSTED':'EFFECTIVE',documentType:payable?'PURCHASE':'SALE',documentId:entry[idField],voucherEventId:event.eventId,documentBusinessDate:businessDate,reversalOf:entry.reversalOf||''};});
}

export function validateOfficialChain({voucherEvents=[],movements=[],orderEvents=[],entries=[]}){
  const movementIds=new Set(movements.map(row=>text(row.movementId))),orderIds=new Set(orderEvents.map(row=>text(row.eventId))),entryIds=new Set(entries.map(row=>text(row.entryId)));const expected={movement:new Set(),order:new Set(),entry:new Set()};
  for(const event of voucherEvents){for(const effect of event.lineEffects||[]){if(effect.entityType==='INVENTORY_MOVEMENT')expected.movement.add(text(effect.entityId));else if(effect.entityType==='ORDER_EVENT')expected.order.add(text(effect.entityId));else if(['PAYABLE_ENTRY','RECEIVABLE_ENTRY'].includes(effect.entityType))expected.entry.add(text(effect.entityId));}}
  const same=(a,b)=>a.size===b.size&&[...a].every(value=>b.has(value));if(!same(expected.movement,movementIds)||!same(expected.order,orderIds)||!same(expected.entry,entryIds))throw new Error('OFFICIAL_CHAIN_CARDINALITY_INVALID');return true;
}

function signedLineBase(kind,line){const quantity=finite(line.baseQuantity,'OFFICIAL_LINE_BASE_REQUIRED');return kind==='PURCHASE'?quantity:-quantity;}
function sumBy(rows,key,value){const out=new Map();for(const row of rows){const id=key(row);out.set(id,(out.get(id)||0)+value(row));}return out;}
function assertMapEqual(expected,actual,code){const keys=new Set([...expected.keys(),...actual.keys()]);for(const key of keys)if((expected.get(key)||0)!==(actual.get(key)||0))throw new Error(`${code}:${key}`);}

/**
 * Reconciles one immutable official document projection against its complete
 * voucher chain. This is deliberately independent from current-situation
 * judgment: it neither creates movements nor changes order fulfillment.
 */
export function reconcileOfficialDocument({kind,document,lines=[],voucherEvents=[],movements=[],orderEvents=[],entries=[],closeRevisionId=''}){
  kind=text(kind).toUpperCase();if(!['PURCHASE','SALE'].includes(kind)||!document)throw new Error('OFFICIAL_CLOSE_DOCUMENT_INVALID');
  const documentId=text(kind==='PURCHASE'?document.purchaseDocumentId:document.salesDocumentId);if(!documentId)throw new Error('OFFICIAL_CLOSE_DOCUMENT_INVALID');
  const chain=[...voucherEvents].filter(row=>text(row.documentId)===documentId).sort((a,b)=>Number(a.sourceDocumentRevision)-Number(b.sourceDocumentRevision));
  if(!chain.length||chain.some((row,index)=>index>0&&Number(row.sourceDocumentRevision)!==Number(chain[index-1].sourceDocumentRevision)+1))throw new Error('OFFICIAL_CHAIN_REVISION_INVALID');
  const linkedMovements=movements.filter(row=>text(row.sourceDocumentId||row.purchaseDocumentId||row.salesDocumentId)===documentId);
  const linkedOrders=orderEvents.filter(row=>text(row.sourceDocumentId||row.salesDocumentId||row.detail?.salesDocumentId)===documentId||chain.some(event=>(event.lineEffects||[]).some(effect=>effect.entityType==='ORDER_EVENT'&&effect.entityId===row.eventId)));
  const linkedEntries=entries.filter(row=>text(row.purchaseDocumentId||row.salesDocumentId)===documentId);
  validateOfficialChain({voucherEvents:chain,movements:linkedMovements,orderEvents:linkedOrders,entries:linkedEntries});
  const active=String(document.status||'').toUpperCase()!=='REVERSED'?lines.filter(row=>!row.deleted&&!row.tombstone&&String(row.status||'').toUpperCase()!=='DELETED'):[];
  const expectedMovement=sumBy(active,keyOf,row=>signedLineBase(kind,row));
  const actualMovement=sumBy(linkedMovements,keyOf,row=>finite(row.signedBaseQuantity,'OFFICIAL_MOVEMENT_QUANTITY_REQUIRED'));
  assertMapEqual(expectedMovement,actualMovement,`${kind}_MOVEMENT_NET_MISMATCH`);
  const documentAmount=active.length?finite(document.totalAmount,'OFFICIAL_DOCUMENT_AMOUNT_REQUIRED'):0;
  const financialByPartner=sumBy(linkedEntries,row=>text(row.partnerId),row=>finite(row.totalAmount,'OFFICIAL_FINANCIAL_AMOUNT_REQUIRED')),currentPartner=text(kind==='PURCHASE'?document.supplierCustomerId:(document.billingCustomerId||document.salesCustomerId));if(active.length&&!currentPartner)throw new Error(`${kind}_FINANCIAL_PARTNER_REQUIRED`);const expectedFinancial=new Map(currentPartner?[[currentPartner,documentAmount]]:[]);assertMapEqual(expectedFinancial,financialByPartner,`${kind}_FINANCIAL_PARTNER_NET_MISMATCH`);
  const financialNet=[...financialByPartner.values()].reduce((sum,value)=>sum+value,0);
  if(financialNet!==documentAmount)throw new Error(`${kind}_FINANCIAL_NET_MISMATCH`);
  let recognizedNet=0;
  if(kind==='SALE'){
    const orderLinkMode=text(document.orderLinkMode||active[0]?.orderLinkMode).toUpperCase()||'DIRECT';
    const recognizedByOrderItem=sumBy(linkedOrders,row=>text(row.detail?.orderItemId||row.orderItemId),row=>finite(row.detail?.transferredQty??row.transferredQty,'OFFICIAL_ORDER_EVENT_QUANTITY_REQUIRED')),expectedRecognizedByOrderItem=orderLinkMode==='DIRECT'?new Map():sumBy(active,row=>text(row.sourceOrderItemId),row=>finite(row.recognizedOrderQuantity,'OFFICIAL_RECOGNIZED_QUANTITY_REQUIRED'));assertMapEqual(expectedRecognizedByOrderItem,recognizedByOrderItem,'SALE_ORDER_EVENT_NET_MISMATCH');recognizedNet=[...recognizedByOrderItem.values()].reduce((sum,value)=>sum+value,0);
    const expectedRecognized=[...expectedRecognizedByOrderItem.values()].reduce((sum,value)=>sum+value,0);
    if(orderLinkMode==='DIRECT'&&linkedOrders.length)throw new Error('DIRECT_SALE_ORDER_EVENT_FORBIDDEN');
    if(recognizedNet!==expectedRecognized)throw new Error('SALE_ORDER_EVENT_NET_MISMATCH');
  }
  const rowId=`${kind==='PURCHASE'?'CPR':'CSR'}-${closeRevisionId||'DRY'}-${documentId}`;
  return {closeRevisionId,[kind==='PURCHASE'?'closePurchaseRowId':'closeSalesRowId']:rowId,[kind==='PURCHASE'?'purchaseDocumentId':'salesDocumentId']:documentId,businessDate:text(document.businessDate||document.purchaseDate||document.saleDate),status:document.status,documentNetAmount:documentAmount,movementNetBaseByKey:Object.fromEntries([...actualMovement].sort((a,b)=>compare(a[0],b[0]))),recognizedNetByOrderItem:kind==='SALE'?Object.fromEntries([...sumBy(linkedOrders,row=>text(row.detail?.orderItemId||row.orderItemId),row=>finite(row.detail?.transferredQty??row.transferredQty)).entries()].sort((a,b)=>compare(a[0],b[0]))):{},recognizedNet,financialNet,financialNetByPartner:Object.fromEntries([...financialByPartner].sort((a,b)=>compare(a[0],b[0]))),sourceDocumentRevision:Number(document.revision),voucherEventIds:chain.map(row=>row.eventId)};
}

export async function buildCloseResultSnapshot({closeRevisionId,closeSeriesId,inventoryRows=[],orderRows=[],purchaseRows=[],salesRows=[],receivableRows=[],payableRows=[],issues=[],auditEvents=[]}){
  const stable=(rows,keys)=>[...rows].sort((a,b)=>keys.reduce((result,key)=>result||compare(a[key],b[key]),0));
  const result={contractVersion:CLOSE_CONTRACT_VERSION,algorithmVersion:CLOSE_ALGORITHM_VERSION,closeRevisionId,closeSeriesId,inventoryRows:stable(inventoryRows,['inventoryKey']),orderRows:stable(orderRows,['orderId','orderItemId']),purchaseRows:stable(purchaseRows,['purchaseDocumentId']),salesRows:stable(salesRows,['salesDocumentId']),receivableRows:stable(receivableRows,['ledgerSequence','entryId']),payableRows:stable(payableRows,['ledgerSequence','entryId']),issues:stable(issues,['severity','issueCode','issueId']),auditEvents:stable(auditEvents,['createdAt','auditEventId'])};
  result.resultBDigest=await canonicalSha256(result);result.resultSnapshotId=`CRS-${result.resultBDigest.slice(0,40)}`;return result;
}

export async function buildCloseReportManifest({closeRevisionId,templateVersion='DATAOPS_CLOSE_REPORT_V1',resultSnapshot}){
  const sheets=[['재고',resultSnapshot.inventoryRows],['주문',resultSnapshot.orderRows],['구매',resultSnapshot.purchaseRows],['판매',resultSnapshot.salesRows],['채권',resultSnapshot.receivableRows],['채무',resultSnapshot.payableRows],['확인사항',resultSnapshot.issues]].map(([name,rows],ordinal)=>({name,ordinal,rowCount:rows.length,digest:null,rows}));
  for(const sheet of sheets){sheet.digest=await canonicalSha256(sheet.rows);delete sheet.rows;}
  const core={closeRevisionId,templateVersion,resultBDigest:resultSnapshot.resultBDigest,sheets};const fileDigest=await canonicalSha256(core);return {reportManifestId:`CRM-${fileDigest.slice(0,40)}`,...core,fileDigest,status:'READY'};
}

export function chunkCanonicalPayload(value,limits=CLOSE_LIMITS){const json=canonicalJson(value),bytes=utf8(json);if(bytes>limits.canonicalMaxBytes)throw new Error('DATAOPS_CLOSE_PAYLOAD_TOO_LARGE');const chunks=[];let chunk='',chunkBytes=0;for(const char of json){const charBytes=utf8(char);if(chunk&&(chunk.length+char.length>limits.chunkMaxChars||chunkBytes+charBytes>limits.chunkMaxChars)){chunks.push(chunk);chunk='';chunkBytes=0;}if(char.length>limits.chunkMaxChars||charBytes>limits.chunkMaxChars)throw new Error('DATAOPS_CLOSE_PAYLOAD_TOO_LARGE');chunk+=char;chunkBytes+=charBytes;}if(chunk)chunks.push(chunk);if(chunks.length>limits.chunkMaxCount||chunks.some(part=>part.length>limits.chunkMaxChars||utf8(part)>limits.chunkMaxChars))throw new Error('DATAOPS_CLOSE_PAYLOAD_TOO_LARGE');return {json,bytes,chunks};}

export function createCloseStagingEngine({digest=value=>canonicalSha256(value)}={}){const stages=new Map(),receipts=new Map();return {stages,receipts,async prepare({stageId,idempotencyKey,fingerprint}){const prior=stages.get(stageId);if(prior&&prior.fingerprint!==fingerprint)throw new Error('CLOSE_IDEMPOTENCY_CONFLICT');const stage=prior||{stageId,idempotencyKey,fingerprint,status:'PREPARED',verified:{A:new Set(),B:new Set(),ISSUES:new Set()},chunks:{A:new Map(),B:new Map(),ISSUES:new Map()},index:null,pointer:null};stages.set(stageId,stage);return stage;},async write(stageId,kind,index,content,{fail=false,tamper=false}={}){const stage=stages.get(stageId);if(!stage||stage.status!=='PREPARED')throw new Error('CLOSE_STAGE_INVALID');if(fail)throw new Error('CLOSE_STAGE_WRITE_FAILED');const value=tamper?`${content}x`:content,d=await digest(value),prior=stage.chunks[kind].get(index);if(prior&&prior.digest!==d)throw new Error('CLOSE_STAGE_CHUNK_CONFLICT');stage.chunks[kind].set(index,{content:value,digest:d});return d;},async verify(stageId,kind,index,expectedDigest){const stage=stages.get(stageId),chunk=stage?.chunks[kind]?.get(index);if(!chunk||chunk.digest!==expectedDigest)throw new Error('CLOSE_STAGE_READBACK_MISMATCH');stage.verified[kind].add(index);},async commit(stageId,{fresh=true,indexRow,pointer,receipt}){const stage=stages.get(stageId);if(!stage||!fresh)throw new Error('CLOSE_SOURCE_CHANGED_AFTER_SEAL');for(const kind of ['A','B','ISSUES'])if(stage.verified[kind].size!==stage.chunks[kind].size)throw new Error('CLOSE_STAGE_READBACK_REQUIRED');stage.index=indexRow;if(!indexRow?.readBackVerified)throw new Error('CLOSE_INDEX_READBACK_REQUIRED');stage.pointer=pointer;stage.status='COMMITTED';receipts.set(stage.idempotencyKey,receipt);return receipt;},retry(idempotencyKey,fingerprint){const receipt=receipts.get(idempotencyKey);if(receipt&&receipt.fingerprint!==fingerprint)throw new Error('CLOSE_IDEMPOTENCY_CONFLICT');return receipt||null;},gc(now=Date.now()){const deleted=[];for(const [id,stage] of stages){if(stage.status==='ORPHANED'&&!stage.referenced&&Date.parse(stage.orphanedAt)+CLOSE_LIMITS.orphanRetentionDays*86400000<now){stages.delete(id);deleted.push(id);}}return deleted;}};}
