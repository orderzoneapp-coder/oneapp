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
