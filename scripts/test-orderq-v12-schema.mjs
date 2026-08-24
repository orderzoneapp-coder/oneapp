import assert from 'node:assert/strict';
import { ORDERQ_DB_VERSION, V12_STORE_DEFINITIONS } from '../orderq/orderq-v12-contracts.js';
import { STORE, upgradeOrderQDbSchema } from '../orderq/orderq-db.js';
import { readFileSync } from 'node:fs';
assert.equal(ORDERQ_DB_VERSION, 12);
assert.deepEqual(V12_STORE_DEFINITIONS.map(row => row.name), ['voucherEvents','receivableEntries','payableEntries']);
for (const row of V12_STORE_DEFINITIONS) assert.ok(row.options.keyPath && row.indexes.some(index => index.name === 'byLedgerSequence' && index.options.unique));
const dbSource = readFileSync(new URL('../orderq/orderq-db.js', import.meta.url), 'utf8');
for (const token of ['oldVersion < 12','byDocumentContractSourceKey','byLineIdentity','byCommandRevision']) assert.ok(dbSource.includes(token));

function schemaHarness(oldVersion) {
  const stores=new Map();
  const meta=[];
  const names={contains:name=>stores.has(name)};
  const makeStore=(name,keyPath='id')=>{
    const indexes=new Map();
    const store={name,keyPath,indexNames:{contains:key=>indexes.has(key)},createIndex:(key,path,options={})=>{indexes.set(key,{path,options});},deleteIndex:key=>indexes.delete(key),
      put:value=>{if(name===STORE.META) meta.push(value);return {};},add:()=>({}),getAll:()=>({}),get:()=>({}),openCursor:()=>({}),index:key=>({openCursor:()=>({}),getAll:()=>({}),get:()=>({})})};
    stores.set(name,store); return store;
  };
  if(oldVersion>0) Object.values(STORE).forEach(name=>makeStore(name));
  const db={objectStoreNames:names,createObjectStore:(name,options={})=>makeStore(name,options.keyPath)};
  const transaction={objectStore:name=>{if(!stores.has(name)) throw new Error(`MISSING_STORE:${name}`);return stores.get(name);}};
  upgradeOrderQDbSchema(db,transaction,oldVersion);
  return {stores,meta};
}
for(const oldVersion of [0,7,8,9,10,11]) {
  const result=schemaHarness(oldVersion);
  assert.ok(result.stores.has(STORE.INVENTORY_MOVEMENTS),`v${oldVersion} inventory store`);
  for(const definition of V12_STORE_DEFINITIONS) assert.ok(result.stores.has(definition.name),`v${oldVersion} ${definition.name}`);
  assert.equal(result.meta.filter(row=>row.key==='schemaVersion').at(-1)?.value,12,`v${oldVersion} metadata`);
}
console.log('ORDER Q v12 schema contract tests passed');
