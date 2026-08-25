import assert from 'node:assert/strict';
import { ORDERQ_DB_VERSION,SITUATION_ALGORITHM_VERSION,V15_STORE_DEFINITIONS } from '../orderq/orderq-v15-contracts.js';
import { upgradeOrderQDbSchema } from '../orderq/orderq-db.js';

assert.equal(ORDERQ_DB_VERSION,15);
assert.equal(SITUATION_ALGORITHM_VERSION,'ORDERQ_SITUATION_V1');
const analyses=V15_STORE_DEFINITIONS.find(store=>store.name==='situationAnalyses');
const identity=analyses.indexes.find(index=>index.name==='byCombinedDigestAlgorithm');
assert.deepEqual([...identity.keyPath],['combinedDigest','businessDate','windowKey','algorithmVersion']);
assert.equal(identity.options.unique,true);
const dbSource=await (await import('node:fs/promises')).readFile(new URL('../orderq/orderq-db.js',import.meta.url),'utf8');
assert.match(dbSource,/oldVersion < 15/);
assert.match(dbSource,/V15_STORE_DEFINITIONS/);
assert.match(dbSource,/ensureExactIndex/);

class Names { constructor(source=[]){this.values=[...source];} contains(name){return this.values.includes(name);} add(name){if(!this.contains(name))this.values.push(name);} remove(name){this.values=this.values.filter(value=>value!==name);} [Symbol.iterator](){return this.values[Symbol.iterator]();} }
class Store {
  constructor(name,{keyPath},records=[]){this.name=name;this.keyPath=keyPath;this.records=records;this.indexNames=new Names();this.indexes=new Map();}
  createIndex(name,keyPath,options={}){const index={name,keyPath,unique:Boolean(options.unique),multiEntry:Boolean(options.multiEntry)};this.indexes.set(name,index);this.indexNames.add(name);return index;}
  deleteIndex(name){this.indexes.delete(name);this.indexNames.remove(name);}
  index(name){return this.indexes.get(name);}
  put(value){const position=this.records.findIndex(row=>row[this.keyPath]===value[this.keyPath]);if(position<0)this.records.push(structuredClone(value));else this.records[position]=structuredClone(value);}
  openCursor(){return {result:null,onsuccess:null,onerror:null};}
  getAll(){return {result:structuredClone(this.records),onsuccess:null,onerror:null};}
}
function migrate(oldVersion,{draftWrongIndex=false}={}){
  const stores=new Map();
  const db={objectStoreNames:new Names(),createObjectStore(name,options){const store=new Store(name,options);stores.set(name,store);this.objectStoreNames.add(name);return store;}};
  const transaction={objectStore:name=>stores.get(name)};
  // The complete historical schemas are created by the production upgrader.
  upgradeOrderQDbSchema(db,transaction,0);
  if(oldVersion>=7&&oldVersion<=14){
    const analysis=stores.get('situationAnalyses');
    if(draftWrongIndex){analysis.deleteIndex('byCombinedDigestAlgorithm');analysis.createIndex('byCombinedDigestAlgorithm','combinedDigest',{unique:false});}
    analysis.records.push({analysisId:'PRESERVED',combinedDigest:'D',businessDate:'2026-08-25',windowKey:'D',algorithmVersion:SITUATION_ALGORITHM_VERSION});
    upgradeOrderQDbSchema(db,transaction,oldVersion);
  }
  return stores;
}
for(const version of [0,7,8,9,10,11,12,13,14]){
  const stores=migrate(version,{draftWrongIndex:version===14});
  for(const definition of V15_STORE_DEFINITIONS){const store=stores.get(definition.name);assert.equal(store.keyPath,definition.keyPath);for(const expected of definition.indexes){const actual=store.index(expected.name);assert.deepEqual(actual.keyPath,expected.keyPath);assert.equal(actual.unique,Boolean(expected.options.unique));}}
  if(version>0)assert.equal(stores.get('situationAnalyses').records.some(row=>row.analysisId==='PRESERVED'),true);
}
console.log('PASS stage5 DB v15');
