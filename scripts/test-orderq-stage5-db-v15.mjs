import assert from 'node:assert/strict';
import { ORDERQ_DB_VERSION,SITUATION_ALGORITHM_VERSION,V15_STORE_DEFINITIONS } from '../orderq/orderq-v15-contracts.js';

assert.equal(ORDERQ_DB_VERSION,15);
assert.equal(SITUATION_ALGORITHM_VERSION,'ORDERQ_SITUATION_V1');
const analyses=V15_STORE_DEFINITIONS.find(store=>store.name==='situationAnalyses');
const identity=analyses.indexes.find(index=>index.name==='byCombinedDigestAlgorithm');
assert.deepEqual([...identity.keyPath],['combinedDigest','businessDate','windowKey','algorithmVersion']);
assert.equal(identity.options.unique,true);
const dbSource=await (await import('node:fs/promises')).readFile(new URL('../orderq/orderq-db.js',import.meta.url),'utf8');
assert.match(dbSource,/oldVersion < 15/);
assert.match(dbSource,/V15_STORE_DEFINITIONS/);
console.log('PASS stage5 DB v15');
