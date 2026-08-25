import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildCanonicalOfficialCommand } from '../orderq/central-command-gateway.js';
import { buildSalePostDraft } from '../smartinput/sale-official-stage4.js';
import { buildOfficialSaleEditCommand, officialSaleEvidence } from '../orderq/sale-official-editor.js';
import { connectSaleStage4Workspace } from '../orderq/sale-stage4-source-adapter.js';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';

const directGroup={sourceType:'DIRECT',originSystem:'SMARTINPUT_MANUAL',originTransactionId:'MANUAL-1',sourceVoucherIndex:1,
  salesCustomerId:'S1',salesCustomerRevision:2,deliveryCustomerId:'D1',deliveryCustomerRevision:3,billingCustomerId:'B1',billingCustomerRevision:4,
  saleDate:'2026-08-25',rows:[{sourceRowKey:'R1',sourceOccurrence:1,productId:'P1',productMasterRevision:5,warehouseId:'W1',warehouseMasterRevision:6,
    quantity:0,unit:'EA',unitPrice:100,actualToBaseFactor:1,actualToRecognizedFactor:0,conversionSource:'DIRECT_SAME_UNIT',conversionRuleId:'DIRECT_1_TO_1',conversionRuleVersion:'DIRECT_1_TO_1_V1',orderLinkMode:'DIRECT'}]};
const draft=buildSalePostDraft(directGroup,{actor:'A',occurredAt:'2026-08-25T00:00:00Z'});
const postSource={...draft.commandEnvelope,intent:draft.commandEnvelope,deviceId:'PC'};
const canonicalPost=buildCanonicalOfficialCommand(postSource,'PC');
for(const field of ['contractKind','normalizedOriginVersion','sourceDocumentKey','originSystem','originTransactionId','sourceVoucherIndex','externalDocumentNo','sourceClaimKeys']) {
  assert.deepEqual(canonicalPost.intent[field],draft.commandEnvelope[field],`canonical ${field}`);
}
assert.throws(()=>buildCanonicalOfficialCommand({...postSource,sourceDocumentKey:'WRONG'},'PC'),/INTENT_MISMATCH:sourceDocumentKey/);
assert.throws(()=>buildCanonicalOfficialCommand({...postSource,document:{...draft.commandEnvelope.document,originSystem:'WRONG'}},'PC'),/INTENT_MISMATCH:originSystem/);
assert.throws(()=>buildCanonicalOfficialCommand({...postSource,intent:{...draft.commandEnvelope,sourceClaimKeys:[]},sourceClaimKeys:[]},'PC'),/ORIGIN_IDENTITY_REQUIRED/);

const cloudSource=readFileSync(new URL('../orderq-cloud.gs',import.meta.url),'utf8');
function declaration(name){const start=cloudSource.indexOf(`function ${name}(`);assert.ok(start>=0,name);const brace=cloudSource.indexOf('{',start);let depth=0;for(let i=brace;i<cloudSource.length;i++){if(cloudSource[i]==='{')depth++;else if(cloudSource[i]==='}'&&--depth===0)return cloudSource.slice(start,i+1);}throw new Error(name);}
const cloud={};vm.createContext(cloud);vm.runInContext(['orderQM9Text','orderQM9CanonicalText','orderQM9CodePointCompare','orderQM9Stable','orderQM9StableJson','orderQM9SaleSourceClaimKeys','orderQM9ValidateSaleCanonicalIntent'].map(declaration).join('\n'),cloud);
assert.deepEqual([...cloud.orderQM9SaleSourceClaimKeys(canonicalPost)],canonicalPost.intent.sourceClaimKeys);
assert.doesNotThrow(()=>cloud.orderQM9ValidateSaleCanonicalIntent(canonicalPost));
assert.throws(()=>cloud.orderQM9ValidateSaleCanonicalIntent({...canonicalPost,sourceDocumentKey:'WRONG'}),/INTENT_MISMATCH:sourceDocumentKey/);
assert.throws(()=>cloud.orderQM9ValidateSaleCanonicalIntent({...canonicalPost,intent:{...canonicalPost.intent,sourceClaimKeys:[]}}),/ORIGIN_IDENTITY_REQUIRED/);
assert.throws(()=>cloud.orderQM9ValidateSaleCanonicalIntent({commandType:'POST_SALE',contractKind:'SALE_STAGE4_V1',intent:{}}),/ORIGIN_IDENTITY_REQUIRED/);

const postDocument={...draft.commandSource.document,...draft.commandEnvelope.document,documentContract:'VOUCHER_CORE_V1',contractKind:'SALE_STAGE4_V1',sourceType:'DIRECT',
  sourceDocumentKey:draft.sourceDocumentKey,originSystem:'SMARTINPUT_MANUAL',originTransactionId:'MANUAL-1',sourceVoucherIndex:1,status:'DRAFT',businessStatus:'DRAFT',revision:1};
const postLine={...draft.lines[0],salesLineId:'SL1',lineIdentityId:'LI1',sourceLineKey:'L1',actualQuantity:0,baseQuantity:0,recognizedOrderQuantity:0,supplyAmount:0,totalAmount:0};
const postCommand={...canonicalPost.intent,document:postDocument,lines:[postLine],actor:'A'};
const posted=planOfficialVoucherCommand({document:postDocument,lines:[postLine],command:postCommand});
const changedLine={...posted.lines[0],productId:'P2',productMasterRevision:7,warehouseId:'W2',warehouseMasterRevision:8,actualQuantity:-2,baseQuantity:-2,recognizedOrderQuantity:0,unitPrice:150,supplyAmount:-300,totalAmount:-300};
const changedDocument={...posted.document,billingCustomerId:'B2',billingCustomerRevision:9};
const correctionSource=buildOfficialSaleEditCommand({action:'correct',document:changedDocument,lines:[changedLine],reason:'거래처 상품 창고 정정',actor:'A',occurredAt:'2026-08-25T01:00:00Z'});
const lineageEdit=buildOfficialSaleEditCommand({action:'correct',document:{...changedDocument,commandEnvelope:draft.commandEnvelope},lines:[changedLine],reason:'계보 보존',actor:'A',occurredAt:'2026-08-25T01:00:00Z'});
const canonicalLineageEdit=buildCanonicalOfficialCommand({...lineageEdit,intent:lineageEdit},'PC');
assert.equal(canonicalLineageEdit.intent.normalizedOriginVersion,'SALE_V2');
assert.deepEqual(canonicalLineageEdit.intent.sourceClaimKeys,draft.commandEnvelope.sourceClaimKeys);
const correctionEnvelope={...draft.commandEnvelope,...correctionSource,normalizedOriginVersion:'SALE_V2',sourceClaimKeys:draft.commandEnvelope.sourceClaimKeys,intent:undefined};
const canonicalCorrection=buildCanonicalOfficialCommand({...correctionEnvelope,intent:correctionEnvelope},'PC');
const corrected=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,
  command:{...canonicalCorrection.intent,document:changedDocument,lines:[changedLine],actor:'A'}});
assert.deepEqual(corrected.movements.map(row=>row.effectKind),['REVERSE_OLD','APPLY_NEW']);
assert.equal(corrected.movements[0].signedBaseQuantity,0); assert.equal(corrected.movements[1].signedBaseQuantity,2);
assert.deepEqual(corrected.entries.map(row=>[row.partnerId,row.entryType,Number(row.supplyAmount)||0]),[['B1','RECEIVABLE_PARTNER_RELEASE',0],['B2','RECEIVABLE_PARTNER_ASSIGN',-300]]);
const reverseSource=buildOfficialSaleEditCommand({action:'reverse',document:corrected.document,lines:corrected.lines,reason:'전체 취소',actor:'A',occurredAt:'2026-08-25T02:00:00Z'});
const reverseEnvelope={...draft.commandEnvelope,...reverseSource,normalizedOriginVersion:'SALE_V2',sourceClaimKeys:draft.commandEnvelope.sourceClaimKeys,intent:undefined};
const canonicalReverse=buildCanonicalOfficialCommand({...reverseEnvelope,intent:reverseEnvelope},'PC');
assert.deepEqual([...cloud.orderQM9SaleSourceClaimKeys(canonicalCorrection)],draft.commandEnvelope.sourceClaimKeys);
assert.deepEqual([...cloud.orderQM9SaleSourceClaimKeys(canonicalReverse)],draft.commandEnvelope.sourceClaimKeys);
const reversed=planOfficialVoucherCommand({document:corrected.document,lines:corrected.lines,movements:[...posted.movements,...corrected.movements],entries:[...posted.entries,...corrected.entries],
  command:{...canonicalReverse.intent,document:corrected.document,lines:corrected.lines,actor:'A'}});
assert.equal(reversed.document.status,'REVERSED'); assert.equal(reversed.entries.reduce((sum,row)=>sum+row.supplyAmount,0),300);

const aggregate=(plan,projectionStatus='LOCAL_PROJECTED',tombstones=[])=>({document:{...plan.document,documentContract:'VOUCHER_CORE_V1',contractKind:'SALE_STAGE4_V1',commandId:plan.voucherEvent.commandId,
  centralTransactionId:'TX',resultDigest:'RD',projectionStatus,projectionPending:projectionStatus==='PROJECTION_PENDING'},activeLines:plan.lines,tombstones,
  movements:plan.movements,receivableEntries:plan.entries,orderEvents:plan.orderEvents,voucherEvents:[plan.voucherEvent]});
const postEvidence=officialSaleEvidence(aggregate(posted));
assert.equal(postEvidence.lines[0].actualQuantity,0); assert.equal(postEvidence.movements[0].signedBaseQuantity,0); assert.equal(postEvidence.receivableEntries[0].supplyAmount,0);
const correctedEvidence=officialSaleEvidence(aggregate(corrected,'PROJECTION_PENDING'));
assert.equal(correctedEvidence.command.projectionPending,true); assert.equal(correctedEvidence.lines[0].actualQuantity,-2);
assert.deepEqual(correctedEvidence.movements.map(row=>row.effectKind),['REVERSE_OLD','APPLY_NEW']);
const reversedTombstone={...corrected.lines[0],status:'REVERSED',lineStatus:'ACTIVE'};
const reverseEvidence=officialSaleEvidence(aggregate(reversed,'LOCAL_PROJECTED',[reversedTombstone]));
assert.equal(reverseEvidence.tombstones[0].actualQuantity,-2); assert.ok(reverseEvidence.voucherEvents[0].beforeSnapshot); assert.ok(reverseEvidence.voucherEvents[0].afterSnapshot);
assert.throws(()=>officialSaleEvidence({...aggregate(corrected),movements:[{...corrected.movements[0],signedBaseQuantity:undefined}]}),/EVIDENCE_UNDEFINED:MOVEMENT_QUANTITY/);
assert.equal(officialSaleEvidence({document:{documentContract:'LEGACY'},lines:[]}).legacyFallback,true);

const calls=[];
const customer=id=>({customerId:id,revision:2,status:'ACTIVE'});
const source={customers:[customer('S'),customer('D'),customer('B')],products:[{productId:'P',productCode:'P',revision:3,status:'ACTIVE'}],warehouses:[{warehouseId:'W',warehouseCode:'01',revision:4,status:'ACTIVE'}],
  orders:[{orderId:'O',orderNo:'N',customerId:'D',revision:5,status:'OPEN'}],orderItems:[
    {orderItemId:'OI1',orderId:'O',productId:'P',sourceRowNumber:2,revision:6,status:'OPEN',baseUnit:'EA',recognizedUnit:'EA',actualToBaseFactor:1,actualToRecognizedFactor:1,conversionSource:'ORDER_Q',conversionRuleVersion:'1'},
    {orderItemId:'OI2',orderId:'O',productId:'P',sourceRowNumber:2,revision:7,status:'OPEN',baseUnit:'EA',recognizedUnit:'EA',actualToBaseFactor:1,actualToRecognizedFactor:1,conversionSource:'ORDER_Q',conversionRuleVersion:'1'}],dispatches:[],dispatchLines:[]};
const workspace={planId:'PLAN',sourceFingerprint:'FP',basisDate:'2026-08-25',allocations:[{sourceRowNumber:2,sourceOccurrence:1,sourceRowKey:'ROW:2:1',orderNumber:'N',productId:'P',productCode:'P',warehouseId:'W',quantity:1,unit:'EA',unitPrice:1,salesCustomerId:'S',deliveryCustomerId:'D',billingCustomerId:'B',actualUnit:'EA',baseUnit:'EA',recognizedUnit:'EA',actualToBaseFactor:1,actualToRecognizedFactor:1,conversionSource:'DIRECT_SAME_UNIT',conversionRuleId:'DIRECT_1_TO_1',conversionRuleVersion:'DIRECT_1_TO_1_V1'}]};
const options={pull:async()=>{calls.push('pull');},loadSource:async()=>{calls.push('load');return source;},reviews:{'2:1':{orderItemId:'OI2'}}};
const connected=await connectSaleStage4Workspace(workspace,options);assert.deepEqual(calls,['pull','load']);assert.equal(connected.saleStage4Sidecar.rows[0].orderItemId,'OI2');
const ordinal=connected.saleStage4Sidecar.rows[0].sourceVoucherIndex;const reexport=await connectSaleStage4Workspace(connected,{...options,pull:async()=>{},loadSource:async()=>source});
assert.equal(reexport.saleStage4Sidecar.rows[0].sourceRowKey,'ROW:2:1');assert.equal(reexport.saleStage4Sidecar.rows[0].sourceVoucherIndex,ordinal);
const direct=await connectSaleStage4Workspace(workspace,{...options,pull:async()=>{},loadSource:async()=>source,reviews:{'2:1':{unlinkDirect:true}}});
assert.equal(direct.saleStage4Sidecar.rows[0].linkStatus,'DIRECT_UNLINKED');assert.equal(direct.saleStage4Sidecar.rows[0].productMasterRevision,3);assert.equal(direct.saleStage4Sidecar.rows[0].actualToBaseFactor,1);
for(const failure of [async()=>{throw new Error('PULL_FAIL');},async()=>{calls.push('pull');}]){const original=JSON.stringify(workspace);const failedOptions=failure.toString().includes('PULL_FAIL')?{pull:failure,loadSource:async()=>source}:{pull:failure,loadSource:async()=>{throw new Error('STALE_SOURCE');}};await assert.rejects(connectSaleStage4Workspace(workspace,failedOptions));assert.equal(JSON.stringify(workspace),original);}

console.log('ORDER Q stage4 blocker-resolution gateway, evidence and pull-order tests passed');
