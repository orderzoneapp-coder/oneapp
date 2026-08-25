import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCloseStagingEngine, chunkCanonicalPayload, CLOSE_LIMITS } from '../orderq/dataops-close-core.js';

const payload=chunkCanonicalPayload({data:'x'.repeat(45001)});assert.equal(payload.chunks.length,2);
assert.equal(chunkCanonicalPayload({data:'x'.repeat(44980)}).chunks.length,1);
const engine=createCloseStagingEngine(),stage=await engine.prepare({stageId:'S1',idempotencyKey:'I1',fingerprint:'F1'});
for(const kind of['A','B','ISSUES']){const digest=await engine.write(stage.stageId,kind,0,kind);await engine.verify(stage.stageId,kind,0,digest);}
await assert.rejects(engine.commit('S1',{fresh:true,indexRow:{readBackVerified:false}}),/INDEX_READBACK/);
const receipt={fingerprint:'F1',status:'COMMITTED'},saved=await engine.commit('S1',{fresh:true,indexRow:{readBackVerified:true},pointer:{head:'R1'},receipt});assert.equal(saved,receipt);assert.equal(engine.retry('I1','F1'),receipt);assert.throws(()=>engine.retry('I1','OTHER'),/IDEMPOTENCY/);
assert.throws(()=>chunkCanonicalPayload({data:'x'.repeat(CLOSE_LIMITS.canonicalMaxBytes+1)}),/PAYLOAD_TOO_LARGE/);

class Range{constructor(sheet,row,col,rows=1,cols=1){Object.assign(this,{sheet,row,col,rows,cols});}getValues(){return Array.from({length:this.rows},(_,r)=>Array.from({length:this.cols},(_,c)=>this.sheet.cells[this.row-1+r]?.[this.col-1+c]??''));}setValues(values){values.forEach((line,r)=>line.forEach((value,c)=>this.sheet.set(this.row+r,this.col+c,value)));}setValue(value){this.sheet.set(this.row,this.col,value);}}
class Sheet{constructor(name){this.name=name;this.cells=[];}set(row,col,value){while(this.cells.length<row)this.cells.push([]);this.cells[row-1][col-1]=value;}getLastRow(){return this.cells.length;}getLastColumn(){return Math.max(0,...this.cells.map(row=>row.length));}appendRow(row){this.cells.push([...row]);}getRange(...args){return new Range(this,...args);}}
class Spreadsheet{constructor(){this.sheets=new Map();}getSheetByName(name){return this.sheets.get(name)||null;}insertSheet(name){const sheet=new Sheet(name);this.sheets.set(name,sheet);return sheet;}}
class Props{constructor(){this.values={};}getProperty(key){return this.values[key]||'';}setProperty(key,value){this.values[key]=String(value);}}
const source=fs.readFileSync(new URL('../dataops-close-stage6.gs',import.meta.url),'utf8');
assert.match(source,/projected\.size>512/);assert.match(source,/totalBytes>20\*1024\*1024/);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),dataSession={readSessionId:'D1',tokenDigest:'DT',status:'OPEN',expiresAt:'2099-01-01T00:00:00Z',actorId:'ADMIN',scopeDigest:'SCOPE',headDigest:'D',deploymentId:'DD',deploymentVersion:'1',gitCommit:'dg'},orderSession={readSessionId:'O1',tokenDigest:'OT',status:'OPEN',expiresAt:'2099-01-01T00:00:00Z',dataOpsReadSessionId:'D1',headDigest:'O',deploymentId:'OD',deploymentVersion:'1',gitCommit:'og',crossAuthorityHandshakeDigest:'H'};
let runtimeProps=null;const context={console,Date,JSON,Utilities:{getUuid:()=>crypto.randomUUID()},PropertiesService:{getScriptProperties:()=>runtimeProps},dataOpsSituationUtf8Bytes:value=>new TextEncoder().encode(value).length,dataOpsSituationDigest:digest,orderQM9SituationReadCached:()=>orderSession,orderQM9SituationRequireIdentity:()=>true,dataOpsSituationReadSessions:()=>({rows:[{readSessionId:'D1',status:'OPEN',payload:dataSession}]}),dataOpsSituationSessionToken:session=>session.tokenDigest,dataOpsSituationConstantTime:(a,b)=>a===b,dataOpsSituationRequireDeployment:()=>({deploymentId:'DD',deploymentVersion:'1',gitCommit:'dg'})};
vm.createContext(context);vm.runInContext(`${source}\nglobalThis.stage6={seal:dataOpsCloseSeal,prepare:dataOpsClosePrepare,write:dataOpsCloseWriteChunks,commit:dataOpsCloseCommit};`,context);
const ss=new Spreadsheet(),props=new Props(),auth={actorId:'ADMIN',roleIds:['DATAOPS_CLOSE_COMMIT'],scopeDigest:'SCOPE'},sealed={orderqHeadDigest:'O',dataopsHeadDigest:'D',capabilityDigest:'C',issueDecisionDigest:'I',resultBDigest:'R'};
runtimeProps=props;const closeSnapshotA={rows:[{inventoryKey:'K',signedBaseQuantity:0}]};const sealReceipt=context.stage6.seal(ss,{closeSeriesId:'SERIES',orderqReadRequest:{readSessionId:'O1',tokenDigest:'OT'},dataopsReadTokenDigest:'DT',closeSnapshotA,sourceADigest:digest(closeSnapshotA),capabilityDigest:'C'},auth);assert.equal(sealReceipt.receiptFingerprint.length,64);assert.equal(ss.getSheetByName('DataOpsClose_Seals').getLastRow(),2);
const intent={closeSeriesId:'SERIES',commandId:'COMMAND',idempotencyKey:'IDEMP',fingerprint:'a'.repeat(64),stageId:'STAGE',actionType:'POST_CLOSE',sealedVerification:sealed,expectedSeriesHeadRevision:0,closeRevisionId:'REV1',revision:1,sourceADigest:'S',resultBDigest:'R',issueDecisionDigest:'I',finalReceiptFingerprint:'f'.repeat(64)};
context.stage6.prepare(ss,{intent},auth);
for(const kind of['A','B','ISSUES']){const content=kind,digest=context.dataOpsSituationDigest(content);context.stage6.write(ss,{stageId:'STAGE',kind,chunks:[{chunkIndex:0,chunkDigest:digest,content}]},auth);}
assert.throws(()=>context.stage6.commit(ss,{intent,freshVerification:{...sealed,orderqHeadDigest:'CHANGED'}},auth,props),/CLOSE_SOURCE_CHANGED/);assert.equal(props.getProperty('ONEAPP_DATAOPS_CLOSE_POINTERS_JSON'),'');
const cloudReceipt=context.stage6.commit(ss,{intent,freshVerification:sealed},auth,props);assert.equal(cloudReceipt.status,'COMMITTED');assert.equal(JSON.parse(props.getProperty('ONEAPP_DATAOPS_CLOSE_POINTERS_JSON')).SERIES.seriesHeadRevisionId,'REV1');
console.log('PASS stage6 Sheets staging and Cloud pointer-last rollback');
