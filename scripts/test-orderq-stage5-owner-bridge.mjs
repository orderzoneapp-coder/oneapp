import assert from 'node:assert/strict';
import { makeAuthority,configureAuthority,snapshotEnvelope,baseEntities } from './dataops-situation-v2-test-harness.mjs';

const authority=makeAuthority({entities:baseEntities()}),credential=configureAuthority(authority),envelope=snapshotEnvelope(authority.context);
authority.context.dataOpsSituationPublish(authority.ss,envelope,authority.context.dataOpsSituationRequireAuth(credential,'DATAOPS_SITUATION_PUBLISH',authority.properties),authority.properties);
const auth=authority.context.dataOpsSituationRequireAuth(credential,'DATAOPS_SITUATION_READ',authority.properties);
const d1=authority.context.dataOpsSituationBegin(authority.ss,{businessDate:'2026-08-25'},auth,authority.properties);
for(const field of ['inventoryKeyDigest','perKeyCutoffDigest','headDigest'])assert.match(d1[field],/^[a-f0-9]{64}$/);
const request={dataOpsReadSessionId:d1.readSessionId,dataOpsTokenDigest:d1.tokenDigest,actorId:credential.actorId,device:credential.deviceId,environment:credential.environment,scope:credential.scope};
const verified=authority.context.dataOpsSituationVerifyOrderQBridgeSession(authority.ss,request,authority.properties);
assert.equal(verified.inventoryKeyDigest,d1.inventoryKeyDigest);
assert.throws(()=>authority.context.dataOpsSituationVerifyOrderQBridgeSession(authority.ss,{...request,dataOpsTokenDigest:'0'.repeat(64)},authority.properties),/SITUATION_READ_TOKEN_INVALID/);
assert.throws(()=>authority.context.dataOpsSituationVerifyOrderQBridgeSession(authority.ss,{...request,scope:{companyId:'OTHER'}},authority.properties),/SITUATION_READ_SCOPE_MISMATCH/);
const stored=authority.context.dataOpsSituationReadSessions(authority.ss).rows.find(row=>row.readSessionId===d1.readSessionId);
authority.context.dataOpsSituationSaveSession(authority.ss,{...stored.payload,status:'CONSUMED'});
assert.throws(()=>authority.context.dataOpsSituationVerifyOrderQBridgeSession(authority.ss,request,authority.properties),/SITUATION_READ_TOKEN_INVALID/);
console.log('PASS stage5 DataOps owner bridge');
