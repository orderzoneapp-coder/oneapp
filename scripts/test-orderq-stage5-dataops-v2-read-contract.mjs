import assert from 'node:assert/strict';
import { READ_SESSION_TTL_SECONDS,TOTAL_SITUATION_READ_ATTEMPTS,validateFrozenSession,withSituationReadRetries } from '../orderq/situation-read-token.js';

assert.equal(READ_SESSION_TTL_SECONDS,120);
assert.equal(TOTAL_SITUATION_READ_ATTEMPTS,3);
const now=Date.now();
const session={authority:'DATAOPS',readSessionId:'D1',tokenDigest:'a'.repeat(64),status:'OPEN',issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+119000).toISOString(),deploymentId:'DEP',deploymentVersion:'28',gitCommit:'abc',capabilityVersion:'SITUATION_DATAOPS_V2'};
assert.equal(validateFrozenSession(session,'DATAOPS',now),session);
assert.throws(()=>validateFrozenSession({...session,expiresAt:new Date(now-1).toISOString()},'DATAOPS',now),/SITUATION_READ_TOKEN_EXPIRED/);
let attempts=0;
await assert.rejects(()=>withSituationReadRetries(async()=>{attempts+=1;throw new Error('SITUATION_HEAD_CHANGED');}),/SITUATION_HEAD_CHANGED/);
assert.equal(attempts,3);
console.log('PASS stage5 DataOps V2 read contract');
