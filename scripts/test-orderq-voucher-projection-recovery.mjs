import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { createCentralAuthorityState, migrateCentralDrafts, prepareCentralCommand } from '../orderq/central-authority.js';
import { replayPendingProjectionReceipts } from '../orderq/central-command-gateway.js';
const source=readFileSync(new URL('../orderq/central-command-gateway.js',import.meta.url),'utf8');
for(const token of ['projectionPending: true','centralProjection:','PROJECTION_PENDING','pendingReceipts','ORDERQ_CENTRAL_PROJECTION_RECEIPT_MISMATCH','LOCAL_PROJECTED']) assert.ok(source.includes(token));
const state=createCentralAuthorityState();
migrateCentralDrafts(state,{idempotencyKey:'REC-MIG',deviceId:'PC',entities:[{entityType:'PURCHASE_DOCUMENT',entityId:'REC-P',revision:1,payload:{purchaseDocumentId:'REC-P',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'REC-SRC',status:'DRAFT',businessStatus:'DRAFT',localOnly:true}}]});
const command={commandType:'POST_PURCHASE',aggregateId:'REC-P',idempotencyKey:'REC-C',expectedRevision:1,deviceId:'PC',intent:{commandContract:'VOUCHER_CORE_V1',commandId:'REC-C',actor:'A',occurredAt:'2026-08-25T00:00:00Z'}};
const prepared=prepareCentralCommand(state,command);
assert.equal(prepared.committed,false);
const repeated=prepareCentralCommand(state,command);
assert.equal(repeated.duplicate,true); assert.equal(repeated.leaseToken,prepared.leaseToken); assert.equal(repeated.fingerprint,prepared.fingerprint);
assert.throws(()=>prepareCentralCommand(state,{...command,intent:{...command.intent,reason:'different'}}),/IDEMPOTENCY_CONFLICT/);
const duplicateState=createCentralAuthorityState({entities:{
  'PURCHASE_DOCUMENT\u001fDONE':{entityType:'PURCHASE_DOCUMENT',entityId:'DONE',revision:2,payload:{purchaseDocumentId:'DONE',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'SAME',status:'CONFIRMED',businessStatus:'CONFIRMED'}},
  'PURCHASE_DOCUMENT\u001fDRAFT':{entityType:'PURCHASE_DOCUMENT',entityId:'DRAFT',revision:1,payload:{purchaseDocumentId:'DRAFT',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'SAME',status:'DRAFT',businessStatus:'DRAFT'}}
}});
assert.throws(()=>prepareCentralCommand(duplicateState,{...command,aggregateId:'DRAFT',idempotencyKey:'DUP',intent:{...command.intent,commandId:'DUP'}}),/SOURCE_ALREADY_POSTED/);
const pendingReceipt={commandId:'REC-C',fingerprint:'FP',centralTransactionId:'TX',resultDigest:'DIGEST',projectionStatus:'PROJECTION_PENDING',command};
let projectedStatus='PROJECTION_PENDING';
const replayed=await replayPendingProjectionReceipts([{value:pendingReceipt}],{
  prepare:async received=>{assert.deepEqual(received,command);return{committed:true,fingerprint:'FP',result:{transactionId:'TX',resultDigest:'DIGEST',changes:[{entityType:'PURCHASE_DOCUMENT',entityId:'REC-P',revision:2,payload:{}}],ledgerSequence:7,cursor:9}}},
  apply:async(changes,ledgerSequence,cursor,evidence)=>{assert.equal(changes.length,1);assert.equal(ledgerSequence,7);assert.equal(cursor,9);assert.equal(evidence.commandId,'REC-C');projectedStatus='LOCAL_PROJECTED'}
});
assert.equal(replayed,1);assert.equal(projectedStatus,'LOCAL_PROJECTED');
await assert.rejects(()=>replayPendingProjectionReceipts([{value:{...pendingReceipt,resultDigest:'WRONG'}}],{
  prepare:async()=>({committed:true,fingerprint:'FP',result:{transactionId:'TX',resultDigest:'DIGEST',changes:[]}}),apply:async()=>{}
}),/PROJECTION_RECEIPT_MISMATCH/);
console.log('ORDER Q voucher projection recovery tests passed');
