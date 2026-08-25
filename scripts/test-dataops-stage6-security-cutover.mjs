import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { closeWriteEnabled, evaluateDataOpsCloseCapability, DATAOPS_CLOSE_EXPECTED_DEPLOYMENT } from '../orderq/dataops-close-cloud-adapter.js';

assert.equal(closeWriteEnabled({}),false);assert.equal(DATAOPS_CLOSE_EXPECTED_DEPLOYMENT.deploymentId,'');assert.equal(evaluateDataOpsCloseCapability({deploymentId:'FAKE'}).ready,false);
const code=fs.readFileSync(new URL('../code.gs',import.meta.url),'utf8'),cloud=fs.readFileSync(new URL('../dataops-close-stage6.gs',import.meta.url),'utf8');
assert.match(code,/dataops_snapshot_commit/);assert.match(code,/ONEAPP_DATAOPS_SNAPSHOT_V1/);assert.match(code,/dataOpsV1PreflightAction\(action,payload/);
const legacyCommitBody=code.match(/if \(action === 'dataops_snapshot_commit'\)([\s\S]*?)if \(action === 'dataops_snapshot_get'/)?.[1]||'';assert.match(legacyCommitBody,/commitDataOpsSnapshot\(ss, payload\.snapshot\)/);assert.doesNotMatch(legacyCommitBody,/columns\s*=|ONEAPP_DATAOPS_SNAPSHOT_V2/);
const context={Object,String,Array,JSON,dataOpsSituationRequireAuth(payload,role){if(!(payload.roles||[]).includes(role))throw new Error('DATAOPS_SITUATION_ROLE_FORBIDDEN');return{actorId:'A',roleIds:payload.roles};}};
vm.createContext(context);vm.runInContext(`${cloud}\nglobalThis.security={mode:dataOpsV1SecurityMode,capability:dataOpsV1SecurityCapability,require:dataOpsV1RequireAccess};`,context);
const legacyProps={getProperty:()=>''};assert.equal(context.security.require({},'WRITE',legacyProps).legacyCompatible,true);assert.equal(context.security.capability(legacyProps).writeAuthRequired,false);
const cutoverProps={getProperty:key=>key==='ONEAPP_DATAOPS_V1_SECURITY_MODE'?'SERVER_FIRST_V1':''};assert.throws(()=>context.security.require({roles:['DATAOPS_SNAPSHOT_V1_READ']},'WRITE',cutoverProps),/ROLE_FORBIDDEN/);assert.throws(()=>context.security.require({roles:['DATAOPS_SITUATION_PUBLISH']},'READ',cutoverProps),/ROLE_FORBIDDEN/);assert.equal(context.security.require({roles:['DATAOPS_SNAPSHOT_V1_WRITE']},'WRITE',cutoverProps).actorId,'A');assert.equal(context.security.require({roles:['DATAOPS_SNAPSHOT_V1_READ']},'READ',cutoverProps).actorId,'A');
const client=fs.readFileSync(new URL('../orderq/dataops-close-cloud-adapter.js',import.meta.url),'utf8');assert.doesNotMatch(client,/localStorage|accessToken|secret/i);
console.log('PASS stage6 V1 legacy/cutover role isolation and close gate');
