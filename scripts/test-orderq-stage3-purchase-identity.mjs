import assert from 'node:assert/strict';
import { buildPurchasePostDraft } from '../smartinput/purchase-official-stage3.js';
import { canonicalSha256 } from '../orderq/official-voucher-core.js';
import { STORE, upgradeOrderQDbSchema } from '../orderq/orderq-db.js';
import { V13_PURCHASE_DOCUMENT_INDEXES } from '../orderq/orderq-v13-contracts.js';
import { ORDERQ_DB_VERSION } from '../orderq/orderq-v17-contracts.js';
import { V7_STORE_DEFINITIONS } from '../orderq/orderq-v7-contracts.js';
import { V8_STORE_DEFINITIONS } from '../orderq/orderq-v8-contracts.js';
import { V9_STORE_DEFINITIONS } from '../orderq/orderq-v9-contracts.js';
import { V10_STORE_DEFINITIONS } from '../orderq/orderq-v10-contracts.js';
import { V11_STORE_DEFINITIONS } from '../orderq/orderq-v11-contracts.js';
import { V12_STORE_DEFINITIONS } from '../orderq/orderq-v12-contracts.js';
import { createCentralAuthorityState, migrateCentralDrafts } from '../orderq/central-authority.js';
import { officialPurchaseReviewCandidate } from '../orderq/official-voucher-repository.js';

const group={voucherDate:'2026-08-25',supplierCustomerId:'C1',supplierCustomerCode:'S1',supplierCustomerName:'남경',warehouseId:'W1',warehouseCode:'01',sourceDocumentKey:'PURCHASE:DOC1',sourceVoucherIndex:1,rows:[
  {sourceLineKey:'LINE:A',productId:'P1',itemCode:'A',itemName:'상품A',warehouseId:'W1',warehouseCode:'01',quantity:0,unit:'EA',baseQuantity:0,baseUnit:'EA',conversionFactor:1,unitPrice:100,productMasterRevision:2,warehouseMasterRevision:1},
  {sourceLineKey:'LINE:B',productId:'P2',itemCode:'B',itemName:'상품B',warehouseId:'W1',warehouseCode:'01',quantity:-2,unit:'BOX',baseQuantity:-20,baseUnit:'EA',conversionFactor:10,unitPrice:300,productMasterRevision:3,warehouseMasterRevision:1}
]};
const a=buildPurchasePostDraft(group,{actor:'ADMIN',manualSessionId:'M1',occurredAt:'2026-08-25T00:00:00.000Z'});
const b=buildPurchasePostDraft(JSON.parse(JSON.stringify(group)),{actor:'ADMIN',manualSessionId:'M1',occurredAt:'2026-08-25T00:00:00.000Z'});
assert.equal(a.purchaseDocumentId,b.purchaseDocumentId);
assert.deepEqual(a.lines.map(row=>row.lineIdentityId),b.lines.map(row=>row.lineIdentityId));
assert.equal(a.commandId,b.commandId);
assert.equal(a.lines[0].actualQuantity,0);
assert.equal(a.lines[1].baseQuantity,-20);
assert.equal(canonicalSha256({b:1,a:'가\r\n'}),canonicalSha256({a:'가\n',b:1}));

function schemaHarness(oldVersion){
  const stores=new Map(),meta=[];
  const makeStore=(name,keyPath='id')=>{const indexes=new Map();const store={name,keyPath,indexNames:{contains:key=>indexes.has(key)},createIndex:(key,path,options={})=>indexes.set(key,{path,options}),deleteIndex:key=>indexes.delete(key),put:value=>{if(name===STORE.META)meta.push(value);return{};},add:()=>({}),getAll:()=>({}),get:()=>({}),openCursor:()=>({}),index:()=>({get:()=>({}),getAll:()=>({}),openCursor:()=>({})})};store._indexes=indexes;stores.set(name,store);return store;};
  const versioned=[V7_STORE_DEFINITIONS,V8_STORE_DEFINITIONS,V9_STORE_DEFINITIONS,V10_STORE_DEFINITIONS,V11_STORE_DEFINITIONS,V12_STORE_DEFINITIONS];
  if(oldVersion>0){const names=new Set(versioned.flat().map(row=>row.name));Object.values(STORE).filter(name=>!names.has(name)).forEach(name=>makeStore(name));versioned.slice(0,Math.max(0,oldVersion-6)).flat().forEach(row=>makeStore(row.name,row.options?.keyPath||row.keyPath));}
  const db={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore:(name,options={})=>makeStore(name,options.keyPath)};
  upgradeOrderQDbSchema(db,{objectStore:name=>stores.get(name)},oldVersion);
  return{stores,meta};
}
for(const oldVersion of [0,7,8,9,10,11,12]){
  const result=schemaHarness(oldVersion),store=result.stores.get(STORE.PURCHASE_DOCUMENTS);
  for(const index of V13_PURCHASE_DOCUMENT_INDEXES) assert.deepEqual(store._indexes.get(index.name),{path:index.keyPath,options:index.options});
  assert.ok(result.stores.has(STORE.SITUATION_ANALYSES));
  assert.ok(result.stores.has(STORE.SITUATION_READ_SESSIONS));
  assert.equal(result.meta.filter(row=>row.key==='schemaVersion').at(-1).value,ORDERQ_DB_VERSION);
}
const splitState=createCentralAuthorityState();
migrateCentralDrafts(splitState,{deviceId:'D',idempotencyKey:'SPLIT',entities:[1,2].map(index=>({entityType:'PURCHASE_DOCUMENT',entityId:`PD${index}`,revision:1,payload:{purchaseDocumentId:`PD${index}`,status:'DRAFT',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',normalizedOriginVersion:'PURCHASE_V2',originSystem:'SMARTINPUT_FILE',originTransactionId:'FILEHASH',sourceVoucherIndex:index,sourceDocumentKey:`DOC${index}`,purchasePlanId:'PLAN-SIBLING',sourceShortageKey:`SHORT-${index}`,externalDocumentNo:'REUSED'}}))});
assert.equal(Object.values(splitState.entities).filter(row=>row.entityType==='PURCHASE_DOCUMENT').length,2,'one file may contain multiple voucher indexes and reused external numbers');
assert.throws(()=>migrateCentralDrafts(splitState,{deviceId:'D',idempotencyKey:'TX-DUP',entities:[{entityType:'PURCHASE_DOCUMENT',entityId:'PD3',revision:1,payload:{purchaseDocumentId:'PD3',status:'DRAFT',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',normalizedOriginVersion:'PURCHASE_V2',originSystem:'SMARTINPUT_FILE',originTransactionId:'FILEHASH',sourceVoucherIndex:2,sourceDocumentKey:'DOC3'}}]}),/ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED/);
assert.throws(()=>migrateCentralDrafts(splitState,{deviceId:'D',idempotencyKey:'SHORT-DUP',entities:[{entityType:'PURCHASE_DOCUMENT',entityId:'PD4',revision:1,payload:{purchaseDocumentId:'PD4',status:'DRAFT',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',normalizedOriginVersion:'PURCHASE_V2',originSystem:'ORDER_Q',originTransactionId:'OTHER',sourceVoucherIndex:4,sourceDocumentKey:'DOC4',sourceShortageKey:'SHORT-1'}}]}),/ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED/);
const prior=[{purchaseDocumentId:'PD1',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',sourceDocumentKey:'DOC1',purchasePlanId:'PLAN1',sourceVoucherIndex:1,externalDocumentNo:'EXT1'}];
assert.equal(officialPurchaseReviewCandidate(prior,{contractKind:'PURCHASE_STAGE3_V1',sourceDocumentKey:'DOC2',purchasePlanId:'PLAN1',sourceVoucherIndex:1})?.purchaseDocumentId,'PD1');
assert.equal(officialPurchaseReviewCandidate(prior,{contractKind:'PURCHASE_STAGE3_V1',sourceDocumentKey:'DOC2',purchasePlanId:'PLAN1',sourceVoucherIndex:2}),null,'planned sibling voucher is not a split/merge candidate');
assert.equal(officialPurchaseReviewCandidate(prior,{contractKind:'PURCHASE_STAGE3_V1',sourceDocumentKey:'DOC2',externalDocumentNo:'EXT1'})?.purchaseDocumentId,'PD1');
console.log('ORDER Q stage3 purchase identity tests passed');

