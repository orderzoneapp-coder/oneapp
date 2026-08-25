import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { makeAuthority,configureAuthority,snapshotEnvelope,baseEntities } from './dataops-situation-v2-test-harness.mjs';

const entities=baseEntities(),authority=makeAuthority({entities,ledgerSequence:9}),credential=configureAuthority(authority),envelope=snapshotEnvelope(authority.context);
const publishAuth=authority.context.dataOpsSituationRequireAuth(credential,'DATAOPS_SITUATION_PUBLISH',authority.properties);
authority.context.dataOpsSituationPublish(authority.ss,envelope,publishAuth,authority.properties);
const readAuth=authority.context.dataOpsSituationRequireAuth(credential,'DATAOPS_SITUATION_READ',authority.properties),d1=authority.context.dataOpsSituationBegin(authority.ss,{},readAuth,authority.properties);
entities.push({entityType:'INVENTORY_MOVEMENT',entityId:'M3',revision:9,status:'CONFIRMED',payload:{movementId:'M3',productId:'P1',warehouseId:'W1',baseUnit:'EA',signedBaseQuantity:2,ledgerSequence:9,effectKey:'E3'}},{entityType:'INVENTORY_MOVEMENT',entityId:'M4',revision:8,status:'TOMBSTONED',payload:{movementId:'M4',productId:'P1',warehouseId:'W1',baseUnit:'EA',signedBaseQuantity:1,ledgerSequence:8,effectKey:'E4'}});
const cache=new Map();authority.context.CacheService={getScriptCache:()=>({get:key=>cache.get(key)||null,put:(key,value)=>cache.set(key,value)})};
authority.values.set('ONEAPP_ORDERQ_STAGE5_DEPLOYMENT_ID','DEP-STAGE5');authority.values.set('ONEAPP_ORDERQ_STAGE5_DEPLOYMENT_VERSION','1');authority.values.set('ONEAPP_ORDERQ_STAGE5_GIT_COMMIT','stage5-head');
vm.runInContext(readFileSync(new URL('../orderq-cloud.gs',import.meta.url),'utf8'),authority.context);
// The production Cloud module owns the entity reader. Bind that reader to this
// fixture's authoritative central rows after loading the module.
authority.context.orderQM9ReadAllEntities=()=>structuredClone(entities);
authority.context.orderQM9MetaNumber=(_ss,key)=>key==='ledgerSequence'?9:key==='syncSequence'?22:0;
const request={schemaVersion:'ONEAPP_ORDERQ_CENTRAL_V1',dataOpsReadSessionId:d1.readSessionId,dataOpsTokenDigest:d1.tokenDigest,actorId:credential.actorId,device:credential.deviceId,environment:credential.environment,scope:credential.scope};
const before=cache.size,o1=authority.context.orderQM9SituationBegin(authority.ss,request);
assert.equal(o1.entityManifest.movementManifest.movementCount,2);assert.deepEqual([...o1.entityManifest.movementManifest.tombstoneIds],['M4']);
assert.equal(o1.dataOpsReadSessionId,d1.readSessionId);assert.ok(cache.size>before);
const page=authority.context.orderQM9SituationPage(authority.ss,{...request,readSessionId:o1.readSessionId,tokenDigest:o1.tokenDigest,pageIndex:0});assert.equal(page.movements.length,2);
const head=authority.context.orderQM9SituationHead(authority.ss,{...request,readSessionId:o1.readSessionId,tokenDigest:o1.tokenDigest});assert.equal(head.currentHeadRevision,9);
assert.throws(()=>authority.context.orderQM9SituationPage(authority.ss,{...request,readSessionId:o1.readSessionId,tokenDigest:o1.tokenDigest,pageIndex:0}),/SITUATION_READ_TOKEN_INVALID/);
const size=cache.size;assert.throws(()=>authority.context.orderQM9SituationBegin(authority.ss,{...request,dataOpsTokenDigest:'f'.repeat(64)}),/SITUATION_READ_TOKEN_INVALID/);assert.equal(cache.size,size);
console.log('PASS stage5 Cloud D1/O1 authenticated frozen E2E');
