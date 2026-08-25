import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ORDERQ_SITUATION_EXPECTED_DEPLOYMENT,evaluateOrderQSituationCapability } from '../orderq/orderq-situation-cloud-adapter.js';

assert.deepEqual(ORDERQ_SITUATION_EXPECTED_DEPLOYMENT,{
  deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',
  deploymentVersion:'30',
  gitCommit:'05804562f87cdb9cc952b63930cf403bb7f4e658'
});
const exactPing={
  situationSchemaVersion:'ORDERQ_SITUATION_READ_V1',
  situationCapabilityVersion:'ORDERQ_SITUATION_V1',
  situationDbSchemaVersion:'15',
  situationDeploymentId:ORDERQ_SITUATION_EXPECTED_DEPLOYMENT.deploymentId,
  situationDeploymentVersion:ORDERQ_SITUATION_EXPECTED_DEPLOYMENT.deploymentVersion,
  situationGitCommit:ORDERQ_SITUATION_EXPECTED_DEPLOYMENT.gitCommit,
  situationActions:['situation_orderq_begin','situation_orderq_page','situation_orderq_head']
};
assert.equal(evaluateOrderQSituationCapability(exactPing),true,'exact immutable Stage5 capability enables the current-situation action');
for(const [field,value] of [
  ['situationDeploymentId','wrong'],
  ['situationDeploymentVersion','29'],
  ['situationGitCommit','wrong'],
  ['situationSchemaVersion','wrong'],
  ['situationCapabilityVersion','wrong'],
  ['situationDbSchemaVersion','14'],
  ['situationActions',['situation_orderq_begin','situation_orderq_page']]
])assert.equal(evaluateOrderQSituationCapability({...exactPing,[field]:value}),false,`${field} mutation keeps Stage5 disabled`);
for(const field of ['situationDeploymentId','situationDeploymentVersion','situationGitCommit']){
  assert.equal(evaluateOrderQSituationCapability({...exactPing,[field]:''}),false,`${field} blank keeps Stage5 disabled`);
}
const code=await readFile(new URL('../code.gs',import.meta.url),'utf8'),cloud=await readFile(new URL('../orderq-cloud.gs',import.meta.url),'utf8');
for(const action of ['situation_orderq_begin','situation_orderq_page','situation_orderq_head']){assert.match(code,new RegExp(`action === '${action}'`));assert.match(cloud,new RegExp(action));}
assert.match(cloud,/ORDERQ_SITUATION_SESSION_TTL_SECONDS = 120/);
assert.match(cloud,/CacheService\.getScriptCache/);
assert.match(cloud,/ORDERQ_SITUATION_ACCESS_DENIED/);
assert.match(cloud,/scopeDigest/);
assert.match(cloud,/ORDERQ_SITUATION_BEGIN/);
assert.match(cloud,/situationDbSchemaVersion: '15'/);
console.log('PASS stage5 ORDER Q Cloud frozen read contract');
