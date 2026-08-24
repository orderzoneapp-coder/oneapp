import assert from 'node:assert/strict';
import { buildPurchasePostDraft, evaluatePurchaseStage3Capability, validatePurchaseGroup } from '../smartinput/purchase-official-stage3.js';
import { createCentralAuthorityState, migrateCentralDrafts, prepareCentralCommand } from '../orderq/central-authority.js';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import '../orderq/canonical-hash.js';

const ready={officialPurchaseStage3:'V1',normalizedOriginVersion:'PURCHASE_V2',commandContract:'VOUCHER_CORE_V1',metaSchema:'ORDERQ_PURCHASE_META_V2',cutoverMode:'VNEXT_PRIMARY',deploymentId:'DEP1',deploymentVersion:'3',gitCommit:'abc'};
assert.equal(evaluatePurchaseStage3Capability(ready).ready,false,'unfrozen/garbage deployment evidence stays disabled');
assert.equal(evaluatePurchaseStage3Capability(ready,{deploymentId:'DEP1',deploymentVersion:'3',gitCommit:'abc'}).ready,true);
assert.equal(evaluatePurchaseStage3Capability({...ready,gitCommit:'wrong'},{deploymentId:'DEP1',deploymentVersion:'3',gitCommit:'abc'}).ready,false);
assert.equal(evaluatePurchaseStage3Capability({...ready,deploymentVersion:''}).code,'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE');
const group={supplierCustomerId:'C1',voucherDate:'2026-08-25',warehouseId:'W1',rows:[{productId:'P1',warehouseId:'W1',quantity:0,unit:'EA',unitPrice:0,productMasterRevision:2,warehouseMasterRevision:1}]};
assert.equal(validatePurchaseGroup(group,{customers:[{customerId:'C1',status:'ACTIVE'}],products:[{productId:'P1',status:'ACTIVE',revision:2}],warehouses:[{warehouseId:'W1',status:'ACTIVE',revision:1}]}),true);
assert.throws(()=>validatePurchaseGroup(group,{customers:[],products:[],warehouses:[]}),/ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID/);
const linked={...group,rows:[{...group.rows[0],sourceType:'ORDER_Q',sourceLineKey:'LINE1',metaProductId:'P2',metaProductCode:'B'}]};
assert.throws(()=>validatePurchaseGroup(linked,{customers:[{customerId:'C1',status:'ACTIVE'}],products:[{productId:'P1',productCode:'A',status:'ACTIVE'}],warehouses:[{warehouseId:'W1',status:'ACTIVE'}]}),/ORDERQ_PURCHASE_PRODUCT_LINK_MISMATCH/);
let state=createCentralAuthorityState({customerMasters:{C1:{customerId:'C1',status:'ACTIVE'}},entities:{}});
migrateCentralDrafts(state,{deviceId:'D1',idempotencyKey:'MIG1',entities:[
  {entityType:'PRODUCT',entityId:'P1',revision:2,payload:{productId:'P1',status:'ACTIVE'}},{entityType:'WAREHOUSE',entityId:'W1',revision:1,payload:{warehouseId:'W1',status:'ACTIVE'}},
  {entityType:'PURCHASE_DOCUMENT',entityId:'PD1',revision:1,payload:{purchaseDocumentId:'PD1',status:'DRAFT',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',normalizedOriginVersion:'PURCHASE_V2',sourceDocumentKey:'DOC1'}},
  {entityType:'PURCHASE_LINE',entityId:'PL1',revision:1,payload:{purchaseLineId:'PL1',purchaseDocumentId:'PD1',status:'DRAFT'}}]});
const command={commandType:'POST_PURCHASE',aggregateId:'PD1',expectedRevision:1,idempotencyKey:'CMD1',intent:{commandId:'CMD1',commandContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',normalizedOriginVersion:'PURCHASE_V2',document:{supplierCustomerId:'C1'},lines:[{sourceLineKey:'L1',productId:'P1',warehouseId:'W1',productMasterRevision:2,warehouseMasterRevision:1}]},now:'2026-08-25T00:00:00.000Z'};
assert.equal(prepareCentralCommand(state,command).committed,false);
assert.throws(()=>prepareCentralCommand(createCentralAuthorityState({...state,customerMasters:{}}),{...command,idempotencyKey:'CMD2',intent:{...command.intent,commandId:'CMD2'}}),/ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID/);
const cloud=readFileSync(new URL('../orderq-cloud.gs',import.meta.url),'utf8');
function declaration(name){const start=cloud.indexOf(`function ${name}(`);const brace=cloud.indexOf('{',start);let depth=0;for(let i=brace;i<cloud.length;i+=1){if(cloud[i]==='{')depth+=1;else if(cloud[i]==='}'&&--depth===0)return cloud.slice(start,i+1);}throw new Error(name);}
const cloudMasters={CUSTOMER:{C1:{customerId:'C1',status:'ACTIVE'}},PRODUCT:{P1:{entityId:'P1',revision:2,status:'ACTIVE',payload:{productId:'P1',status:'ACTIVE'}}},WAREHOUSE:{W1:{entityId:'W1',revision:1,status:'ACTIVE',payload:{warehouseId:'W1',status:'ACTIVE'}}}};
const context={orderQEnsureSheet:(_ss,key)=>key,orderQReadPayloadById:(sheet,id)=>cloudMasters[sheet]?.[id]||null,orderQM9ReadEntity:(_ss,type,id)=>cloudMasters[type]?.[id]||null};
vm.createContext(context);vm.runInContext([declaration('orderQM9Text'),declaration('orderQM9ValidatePurchaseMasters')].join('\n'),context);
assert.doesNotThrow(()=>context.orderQM9ValidatePurchaseMasters({},command));
const missingSupplier=structuredClone(command);missingSupplier.intent.document.supplierCustomerId='MISS';
assert.throws(()=>context.orderQM9ValidatePurchaseMasters({},missingSupplier),/ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID/);
const missingRevision=structuredClone(command); delete missingRevision.intent.lines[0].productMasterRevision;
assert.throws(()=>prepareCentralCommand(state,{...missingRevision,idempotencyKey:'CMD-MISSING',intent:{...missingRevision.intent,commandId:'CMD-MISSING'}}),/ORDERQ_PURCHASE_MASTER_REVISION_STALE/);
assert.throws(()=>context.orderQM9ValidatePurchaseMasters({},missingRevision),/ORDERQ_PURCHASE_MASTER_REVISION_STALE/);
const staleRevision=structuredClone(command); staleRevision.intent.lines[0].productMasterRevision=1;
assert.throws(()=>prepareCentralCommand(state,{...staleRevision,idempotencyKey:'CMD-STALE',intent:{...staleRevision.intent,commandId:'CMD-STALE'}}),/ORDERQ_PURCHASE_MASTER_REVISION_STALE/);
assert.throws(()=>context.orderQM9ValidatePurchaseMasters({},staleRevision),/ORDERQ_PURCHASE_MASTER_REVISION_STALE/);

const frozenGroup={sourceType:'ORDER_Q',sourceDocumentKey:'FROZEN-SOURCE',sourceVoucherIndex:1,purchasePlanId:'PLAN-F',sourceShortageKey:'SHORT-F',supplierCustomerId:'C1',supplierCustomerName:'남경',voucherDate:'2026-08-25',warehouseId:'W1',warehouseCode:'01',rows:[{sourceType:'ORDER_Q',sourceLineKey:'FROZEN-L1',productId:'P1',itemCode:'A',itemName:'상품A',warehouseId:'W1',warehouseCode:'01',quantity:2,unit:'BOX',conversionFactor:10,baseQuantity:20,baseUnit:'EA',unitPrice:100,productMasterRevision:2,warehouseMasterRevision:1}]};
const frozenDraft=buildPurchasePostDraft(frozenGroup,{actor:'SMART_INPUT_ADMIN',occurredAt:'2026-08-25T00:00:00.000Z'});
assert.equal(frozenDraft.commandEnvelope.lines[0].productMasterRevision,2); assert.equal(frozenDraft.commandEnvelope.lines[0].warehouseMasterRevision,1);
const frozenState=createCentralAuthorityState({customerMasters:{C1:{customerId:'C1',status:'ACTIVE'}},entities:{}});
migrateCentralDrafts(frozenState,{deviceId:'D2',idempotencyKey:'FROZEN-MIG',entities:[
  {entityType:'PRODUCT',entityId:'P1',revision:2,payload:{productId:'P1',status:'ACTIVE'}},{entityType:'WAREHOUSE',entityId:'W1',revision:1,payload:{warehouseId:'W1',status:'ACTIVE'}},
  {entityType:'PURCHASE_DOCUMENT',entityId:frozenDraft.purchaseDocumentId,revision:1,payload:{...frozenDraft,status:'DRAFT',documentContract:'VOUCHER_CORE_V1'}},
  {entityType:'PURCHASE_LINE',entityId:'FROZEN-PL1',revision:1,payload:{...frozenDraft.lines[0],purchaseLineId:'FROZEN-PL1',purchaseDocumentId:frozenDraft.purchaseDocumentId,status:'DRAFT'}}]});
const frozenPrepare={...frozenDraft.commandEnvelope,aggregateId:frozenDraft.purchaseDocumentId,intent:{...frozenDraft.commandEnvelope,actor:frozenDraft.commandEnvelope.actorId}};
assert.equal(prepareCentralCommand(frozenState,frozenPrepare).committed,false);
assert.doesNotThrow(()=>context.orderQM9ValidatePurchaseMasters({},frozenPrepare));

const hashContext={sha256Hex:value=>createHash('sha256').update(String(value),'utf8').digest('hex')};
vm.createContext(hashContext);vm.runInContext(['orderQM9CanonicalText','orderQM9CodePointCompare','orderQM9Stable','orderQM9StableJson','orderQM9Digest'].map(declaration).join('\n'),hashContext);
const nfd='남경\r\n';
const intent={actor:'  '+nfd,quantity:-0,nested:{z:' 값 ',a:'A'}};
assert.equal(hashContext.orderQM9StableJson(intent),globalThis.ORDERQ_CANONICAL_HASH.canonicalJson(intent));
assert.equal(hashContext.orderQM9Digest(intent),globalThis.ORDERQ_CANONICAL_HASH.canonicalSha256(intent));
console.log('ORDER Q stage3 purchase master/capability tests passed');
