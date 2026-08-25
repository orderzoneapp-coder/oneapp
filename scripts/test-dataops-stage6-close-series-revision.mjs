import assert from 'node:assert/strict';
import { buildCloseReportManifest, buildCloseResultSnapshot, closeSeriesIdentity, planCloseRevision } from '../orderq/dataops-close-core.js';
import { seal } from './dataops-stage6-test-fixtures.mjs';

const id1=await closeSeriesIdentity('ONEAPP','2026-08-25','KRW','SCOPE1');
const id2=await closeSeriesIdentity('ONEAPP','2026-08-25','KRW','SCOPE1');
assert.equal(id1,id2);assert.notEqual(id1,await closeSeriesIdentity('ONEAPP','2026-08-25','KRW','SCOPE2'));
const source={...seal,closeSeriesId:id1,receiptFingerprint:'a'.repeat(64)};
const post=await planCloseRevision({actionType:'POST_CLOSE',sourceSealReceipt:source,sourceADigest:'b'.repeat(64),resultBDigest:'c'.repeat(64),issueDecisionDigest:'d'.repeat(64),actorId:'ADMIN',commandId:'C1',idempotencyKey:'I1'});
assert.equal(post.revision.revision,1);
const correction=await planCloseRevision({series:post.series,actionType:'CORRECT_CLOSE',expectedSeriesHeadRevision:1,expectedEffectiveRevision:1,sourceSealReceipt:source,sourceADigest:'b'.repeat(64),resultBDigest:'e'.repeat(64),issueDecisionDigest:'d'.repeat(64),actorId:'ADMIN',commandId:'C2',idempotencyKey:'I2'});
assert.equal(correction.series.seriesHeadRevision,2);
const reversal=await planCloseRevision({series:correction.series,actionType:'REVERSE_CLOSE',expectedSeriesHeadRevision:2,expectedEffectiveRevision:2,targetRevision:2,sourceSealReceipt:source,sourceADigest:'b'.repeat(64),resultBDigest:'f'.repeat(64),issueDecisionDigest:'d'.repeat(64),actorId:'ADMIN',commandId:'C3',idempotencyKey:'I3'});
assert.equal(reversal.series.currentEffectiveRevision,1);
const result=await buildCloseResultSnapshot({closeRevisionId:correction.revision.closeRevisionId,closeSeriesId:id1,inventoryRows:[{inventoryKey:'P\u001fW\u001fEA'}],issues:[]});const report=await buildCloseReportManifest({closeRevisionId:correction.revision.closeRevisionId,resultSnapshot:result});assert.equal(result.resultBDigest.length,64);assert.equal(report.sheets.length,7);assert.equal(report.fileDigest.length,64);
await assert.rejects(()=>planCloseRevision({series:post.series,actionType:'CORRECT_CLOSE',expectedSeriesHeadRevision:0,expectedEffectiveRevision:1,sourceSealReceipt:source}),/CLOSE_REVISION_CONFLICT/);
console.log('PASS stage6 close revision');
