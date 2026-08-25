import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ORDERQ_SITUATION_EXPECTED_DEPLOYMENT,evaluateOrderQSituationCapability } from '../orderq/orderq-situation-cloud-adapter.js';

assert.deepEqual(ORDERQ_SITUATION_EXPECTED_DEPLOYMENT,{deploymentId:'',deploymentVersion:'',gitCommit:''});
assert.equal(evaluateOrderQSituationCapability({situationSchemaVersion:'ORDERQ_SITUATION_READ_V1',situationCapabilityVersion:'ORDERQ_SITUATION_V1',situationActions:['situation_orderq_begin','situation_orderq_page','situation_orderq_head']}),false,'Cloud-first release gate remains closed before immutable deployment');
const code=await readFile(new URL('../code.gs',import.meta.url),'utf8'),cloud=await readFile(new URL('../orderq-cloud.gs',import.meta.url),'utf8');
for(const action of ['situation_orderq_begin','situation_orderq_page','situation_orderq_head']){assert.match(code,new RegExp(`action === '${action}'`));assert.match(cloud,new RegExp(action));}
assert.match(cloud,/ORDERQ_SITUATION_SESSION_TTL_SECONDS = 120/);
assert.match(cloud,/CacheService\.getScriptCache/);
assert.match(cloud,/ORDERQ_SITUATION_ACCESS_DENIED/);
assert.match(cloud,/scopeDigest/);
assert.match(cloud,/ORDERQ_SITUATION_BEGIN/);
assert.match(cloud,/situationDbSchemaVersion: '15'/);
console.log('PASS stage5 ORDER Q Cloud frozen read contract');
