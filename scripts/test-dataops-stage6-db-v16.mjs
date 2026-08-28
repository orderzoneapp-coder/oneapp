import assert from 'node:assert/strict';
import { ORDERQ_DB_VERSION, V16_STORE_DEFINITIONS, V16_META_DEFAULTS } from '../orderq/orderq-v16-contracts.js';
import { ORDERQ_DB_VERSION as CURRENT_DB_VERSION } from '../orderq/orderq-v17-contracts.js';
import { upgradeOrderQDbSchema } from '../orderq/orderq-db.js';

assert.equal(ORDERQ_DB_VERSION, 16);
assert.ok(V16_STORE_DEFINITIONS.length >= 13);
assert.equal(V16_META_DEFAULTS.closeContractVersion, 'DATAOPS_CLOSE_V1');
const releaseIdentity={ deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw', deploymentVersion:'31', gitCommit:'48a52ec34fa938cd60fe965b795083539460627f' };
assert.deepEqual(V16_META_DEFAULTS.expectedDataOpsDeployment, releaseIdentity);
assert.deepEqual(V16_META_DEFAULTS.expectedOrderQDeployment, releaseIdentity);

class Names {
  constructor(source=[]){ this.values=[...source]; }
  contains(name){ return this.values.includes(name); }
  add(name){ if(!this.contains(name)) this.values.push(name); }
  remove(name){ this.values=this.values.filter(value=>value!==name); }
  [Symbol.iterator](){ return this.values[Symbol.iterator](); }
}
class Store {
  constructor(name,{keyPath},records=[]){ this.name=name;this.keyPath=keyPath;this.records=records;this.indexNames=new Names();this.indexes=new Map(); }
  createIndex(name,keyPath,options={}){ const index={name,keyPath,unique:Boolean(options.unique),multiEntry:Boolean(options.multiEntry)};this.indexes.set(name,index);this.indexNames.add(name);return index; }
  deleteIndex(name){ this.indexes.delete(name);this.indexNames.remove(name); }
  index(name){ return this.indexes.get(name); }
  put(value){ const key=value[this.keyPath];const at=this.records.findIndex(row=>row[this.keyPath]===key);if(at<0)this.records.push(structuredClone(value));else this.records[at]=structuredClone(value); }
  getAll(){ return {result:structuredClone(this.records),onsuccess:null,onerror:null}; }
  openCursor(){ return {result:null,onsuccess:null,onerror:null}; }
}
function migrate(oldVersion,{wrongIndex=false}={}){
  const stores=new Map();
  const db={objectStoreNames:new Names(),createObjectStore(name,options){const store=new Store(name,options);stores.set(name,store);this.objectStoreNames.add(name);return store;}};
  const tx={objectStore:name=>stores.get(name)};
  upgradeOrderQDbSchema(db,tx,0);
  if(oldVersion>0){
    stores.get('situationAnalyses').put({analysisId:`PRESERVED-${oldVersion}`,combinedDigest:'D',businessDate:'2026-08-25',windowKey:'D',algorithmVersion:'ORDERQ_SITUATION_V1'});
    if(wrongIndex){const close=stores.get('closeSeries');close.deleteIndex('byHeadRevision');close.createIndex('byHeadRevision','seriesHeadRevision',{unique:false});}
    upgradeOrderQDbSchema(db,tx,oldVersion);
  }
  return stores;
}
for(const version of [0,7,8,9,10,11,12,13,14,15]){
  const stores=migrate(version,{wrongIndex:version===15});
  for(const definition of V16_STORE_DEFINITIONS){
    const actual=stores.get(definition.name);assert.ok(actual,`missing ${definition.name}`);assert.equal(actual.keyPath,definition.keyPath);
    for(const expected of definition.indexes){const index=actual.index(expected.name);assert.ok(index,`${definition.name}.${expected.name}`);assert.deepEqual(index.keyPath,expected.keyPath);assert.equal(index.unique,Boolean(expected.options.unique));}
  }
  if(version>0)assert.equal(stores.get('situationAnalyses').records.some(row=>row.analysisId===`PRESERVED-${version}`),true);
  const meta=stores.get('meta').records;
  assert.equal(meta.find(row=>row.key==='schemaVersion')?.value,CURRENT_DB_VERSION);
  assert.equal(meta.find(row=>row.key==='closeContractVersion')?.value,'DATAOPS_CLOSE_V1');
}
console.log('PASS stage6 DB v16 fresh/v7-v15 metadata and preservation');

