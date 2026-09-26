#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-stage3-native-'));
const screenshotDir = resolve(process.env.SMARTINPUT_ESTIMATE_BULK_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-estimate-bulk-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  if (process.env.STAGE3_DEBUG) console.error('REQUEST', request.url);
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/__stage3_native_fixture.html') return response.writeHead(200, {'Content-Type':'text/html'}).end('<!doctype html><title>isolated native fixture</title>');
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  response.end(readFileSync(target));
});

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};
const commandPath = command => {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || '' : '';
};
const browserExecutable = () => [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge')
].filter(Boolean).find(existsSync) || '';

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.events = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      }
      (this.events.get(message.method) || []).forEach(listener => listener(message.params));
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout = 60_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const select = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const escape = async client => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
};
const readEstimates = client => evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('estimates','readonly').objectStore('estimates').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result);db.close();};};})`);
const readAliasMappings = client => evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('customerAliasMappings','readonly').objectStore('customerAliasMappings').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result);db.close();};};})`);

let browser;
let client;
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    try { return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] || null; } catch (_) { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  const exceptions = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(`${event.exceptionDetails?.url || ''}:${Number(event.exceptionDetails?.lineNumber || 0) + 1}:${Number(event.exceptionDetails?.columnNumber || 0) + 1} ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'}`));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });


  const loaded = client.once('Page.loadEventFired');
  const destination = `http://127.0.0.1:${address.port}/__stage3_native_fixture.html`;
  const probe = await fetch(destination);
  if (process.env.STAGE3_DEBUG) console.error('HTTP', probe.status, await probe.text());
  const navigation = await client.send('Page.navigate', {url:destination});
  if (process.env.STAGE3_DEBUG) console.error('NAVIGATION', navigation);
  await loaded;
  const result = await evaluate(client, String.raw`(async () => {
    const store = await import('/smartinput/smartinput-data-store.js?v=0.18.0');
    const pure = await import('/smartinput/independent-estimate.js?v=0.2.0');
    const passed = [], failed = [];
    const check = (condition, label) => { if (!condition) throw new Error(label); };
    const test = async (name, run) => { try { await run(); passed.push(name); } catch (error) { failed.push({ name, error: error.stack }); } };
    const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    const id = code => ({productId:'',productCode:code,customerId:'CUST',customerCode:'0001',unit:'box',pack:'',specification:'spec',priceConditionKey:''});
    const row = code => ({rowId:code,ownedRowId:code,itemCode:code,itemName:code,quantity:1,purchasePriceB:10,matchIdentity:id(code)});
    const record = name => ({estimateId:name,companyId:'C1',dataRevision:1,schemaVersion:pure.INDEPENDENT_ESTIMATE_SCHEMA,estimateKind:'INDIVIDUAL',
      catalogName:name,createdAt:'FIRST',updatedAt:'OLD',ownedRows:['A','B','C'].map(row),displayGroups:['A','B','C'].map(rowId=>({rowId,ownedRowIds:[rowId],visible:true})),
      draft:{documentId:'DOC-'+name,catalogRecordId:name,rows:['A','B','C'].map(row)}});
    const A=record('EST-A'), B=record('EST-B');
    await store.saveEstimate(A); await store.saveEstimate(B);
    const val = n => ({kind:'VALUE',reviewed:true,parsedValue:n,rawValue:String(n),displayValue:String(n),cellType:'n'});
    const input = (code,n) => ({identity:id(code),sourceRef:'S!'+code,values:{purchasePriceB:val(n)}});
    const make = async (operationId, records, inputs, selectedEstimateIds=['EST-A']) => pure.createSelectedEstimateUpdatePlan({operationId,companyId:'C1',actor:{actorId:'A1'},
      selectedEstimateIds,estimates:records,sourceIndex:pure.createEstimateSourceIndex({companyId:'C1',rows:inputs}),templateId:'T1',templateSignature:'SIG',templateRevision:1,mappingRevision:1,
      fileGeneration:operationId,fileFingerprint:'F-'+operationId,sourceDocumentId:'UP1',sourceRevision:1,allowedFieldIds:['purchasePriceB'],confirmedMappings:(await store.loadSmartInputData()).aliasMappings});
    const logs=[], nativePut=IDBObjectStore.prototype.put;
    let failLatest=false, failWorkDocument=false, failWorkDocumentId='WORK-ABORT';
    IDBObjectStore.prototype.put=function(value,...args){
      if (failLatest && this.name==='settings' && value.key?.includes(':latestExcelResult:')) throw new DOMException('INJECTED_LATEST_ABORT','AbortError');
      if (failWorkDocument && this.name==='draftVouchersV2' && value.draftId===failWorkDocumentId) throw new DOMException('INJECTED_WORK_DOCUMENT_ABORT','AbortError');
      logs.push({store:this.name,id:value.estimateId||value.aliasMappingId||value.key}); return nativePut.call(this,value,...args);
    };
    const latest = async estimateId => (await store.loadLastEstimateExcelResult({companyId:'C1',estimateId})).result;
    const get = async estimateId => (await store.loadEstimateForUpdate({companyId:'C1',estimateId})).record;
    let p1, receipt1;
    await test('0 selection has zero writes', async()=>{
      logs.length=0; const p=await make('EMPTY',[A,B],[input('A',20)],[]);
      const result=await store.persistSelectedEstimateUpdatePlan(p); await store.commitSelectedEstimateUpdate({plan:p});
      check(!result.durable && logs.length===0,'zero selection wrote data');
    });
    await test('A changed / B UNCHANGED / C absent computes E={C}',async()=>{
      p1=await make('R1',[A,B],[input('A',20),input('B',10)]);
      await store.persistSelectedEstimateUpdatePlan(p1); logs.length=0;
      receipt1=await store.commitSelectedEstimateUpdate({plan:p1,target:p1.targets[0]});
      check(receipt1.status==='SAVED','not saved');
      check(equal(receipt1.lastExcelResult.excludedTargetRows.map(x=>x.ownedRowId),['C']),'difference not C');
      check(receipt1.lastExcelResult.processedTargetRowKeys.length===2,'UNCHANGED row not processed');
      check(equal(await get('EST-B'),B),'unselected changed');
      check(logs.filter(x=>x.store==='estimates').every(x=>x.id==='EST-A'),'outside write');
    });
    await test('native abort of result write rolls back estimate and receipt',async()=>{
      const before=await get('EST-A'), beforeLatest=await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-A'});
      const p=await make('ABORT',[before],[input('C',42)]); await store.persistSelectedEstimateUpdatePlan(p);
      failLatest=true; let error; try {await store.commitSelectedEstimateUpdate({plan:p,target:p.targets[0]});}catch(e){error=e;}finally{failLatest=false;}
      check(error?.name==='AbortError','injected failure missing'); check(equal(await get('EST-A'),before),'estimate committed despite abort');
      check(equal(await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-A'}),beforeLatest),'latest changed after abort');
      check((await store.getEstimateUpdateResult({companyId:'C1',estimateId:'EST-A',operationId:'ABORT',payloadHash:p.payloadHash})).status==='CONFIRMED_NOT_APPLIED','receipt survived abort');
      await store.commitSelectedEstimateUpdate({plan:p,target:p.targets[0]});
      check((await get('EST-A')).ownedRows.find(x=>x.ownedRowId==='C').purchasePriceB===42,'explicit retry failed');
    });
    await test('all UNCHANGED creates next E={A,B} without estimate write',async()=>{
      const before=await get('EST-A'), p=await make('R2',[before],[input('C',42)]); await store.persistSelectedEstimateUpdatePlan(p); logs.length=0;
      const receipt=await store.commitSelectedEstimateUpdate({plan:p,target:p.targets[0]});
      check(receipt.status==='UNCHANGED','not unchanged');
      check(equal(receipt.lastExcelResult.excludedTargetRows.map(x=>x.ownedRowId),['A','B']),'accumulated exclusions');
      check(logs.filter(x=>x.store==='estimates').length===0 && equal(await get('EST-A'),before),'UNCHANGED wrote estimate');
    });
    await test('old successful replay preserves newer latest / zero business writes',async()=>{
      const previous=await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-A'}); logs.length=0;
      const result=await store.commitSelectedEstimateUpdate({plan:p1,target:p1.targets[0]});
      check(equal(result,receipt1),'wrong old receipt'); check(logs.length===0,'receipt replay wrote');
      check(equal(await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-A'}),previous),'latest rolled back');
    });
    await test('native concurrent submissions have one estimate commit',async()=>{
      const p=await make('CONCURRENT',[await get('EST-A')],[input('A',30)]); await store.persistSelectedEstimateUpdatePlan(p); logs.length=0;
      const results=await Promise.all([store.commitSelectedEstimateUpdate({plan:p,target:p.targets[0]}),store.commitSelectedEstimateUpdate({plan:p,target:p.targets[0]})]);
      check(equal(results[0],results[1]),'different duplicate results'); check(logs.filter(x=>x.store==='estimates').length===1,'duplicate business commit');
    });
    await test('new payload under same operation ID rejected',async()=>{
      const p=await make('R1',[await get('EST-A')],[input('A',99)]); let error;
      try{await store.persistSelectedEstimateUpdatePlan(p);}catch(e){error=e;}
      check(error?.code==='ESTIMATE_OPERATION_PAYLOAD_CONFLICT','different payload reused ID');
    });
    await test('manual edit preserves latest result and unselected data',async()=>{
      const previous=await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-A'}), before=await get('EST-A');
      const candidate=structuredClone(before); candidate.ownedRows[0].memo='manual'; candidate.dataRevision++; candidate.draft=pure.projectIndependentEstimateDraft(candidate);
      await store.commitIndependentEstimateEdit({companyId:'C1',actor:{actorId:'A1'},estimateId:'EST-A',operationId:'MANUAL',expectedPreimage:before,candidate});
      check(equal(await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-A'}),previous),'manual rewrote latest'); check(equal(await get('EST-B'),B),'manual wrote other');
    });
    await test('fresh estimate result is NO_RECORD not all excluded',async()=>{
      const result=await store.loadLastEstimateExcelResult({companyId:'C1',estimateId:'EST-B'}); check(result.status==='NO_RECORD','absent result misclassified');
    });
    await test('settings startup reads only existing UI keys',async()=>{
      await store.saveSettingValue('smartinput:estimate:v1:large-fixture',{large:'technical'});
      const reads=[], original=IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll=function(...args){reads.push(this.name);return original.apply(this,args);};
      try {await store.loadSmartInputData();} finally {IDBObjectStore.prototype.getAll=original;}
      check(!reads.includes('settings'),'startup scans technical settings');
    });
    await test('purchase work documents commit atomically, isolate by company/mode, and revise same ID',async()=>{
      const payload={documentId:'SESSION-1',mode:'purchase',header:{customerName:'거래처 A'},inputMapping:{headers:['품명','숨은 원본'],sourceMatrix:[['사과','근거']],workingRows:[{rowId:'ROW-1',cells:['사과','근거']}]},rows:[{rowId:'ROW-1',quantity:'0',unitPrice:''}]};
      const start=logs.length;
      const first=await store.commitSmartInputWorkDocument({companyId:'C1',voucherMode:'purchase',documentId:'WORK-1',expectedRevision:0,operationId:'WORK-OP-1',title:'구매 A',actorId:'A1',summary:{rowCount:1,totalAmount:0},payload});
      check(first.record.revision===1 && first.record.schemaVersion==='ONEAPP_SMARTINPUT_SAVED_WORK_DOCUMENT_V1','first local revision missing');
      check(first.record.idempotencyKey==='WORK-OP-1','saved work must expose the existing idempotency index key');
      check(logs.slice(start).filter(row=>row.store==='draftVouchersV2').length===1 && logs.slice(start).every(row=>row.store==='draftVouchersV2'),'own save wrote outside SmartInput Store');
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;resolve({version:db.version,hasStore:db.objectStoreNames.contains('draftVouchersV2')});db.close();};});
      check(db.version===5 && db.hasStore,'local document storage must reuse DB v5 draftVouchersV2');
      const opened=await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-1'});
      check(opened.status==='READY' && equal(opened.record.payload,payload),'native indexedDB failed to preserve full input evidence');
      check((await store.loadSmartInputWorkDocument({companyId:'C2',documentId:'WORK-1'})).status==='COMPANY_MISMATCH','company mismatch was not isolated');
      const list=await store.listSmartInputWorkDocuments({companyId:'C1',voucherMode:'purchase'});
      check(list.length===1 && !Object.hasOwn(list[0],'payload') && list[0].summary.totalAmount===0,'list must be a payload-free scoped summary');
      check((await store.listSmartInputWorkDocuments({companyId:'C1',voucherMode:'sale'})).length===0,'purchase leaked into sale list');
      const changed=structuredClone(payload); changed.rows[0].quantity='5';
      const beforeUpdates=logs.length;
      const updated=await Promise.all([1,2].map(()=>store.commitSmartInputWorkDocument({companyId:'C1',voucherMode:'purchase',documentId:'WORK-1',expectedRevision:1,operationId:'WORK-OP-2',title:'구매 A',actorId:'A1',summary:{rowCount:1,totalAmount:0},payload:changed})));
      check(updated.every(result=>result.record.revision===2 && equal(result.record.payload,changed)),'same-operation concurrent retry must return the same committed document');
      check(logs.slice(beforeUpdates).filter(row=>row.store==='draftVouchersV2').length===1,'same operation wrote more than one revision');
      let operationConflict; try{await store.commitSmartInputWorkDocument({companyId:'C1',voucherMode:'purchase',documentId:'WORK-1',expectedRevision:1,operationId:'WORK-OP-2',title:'구매 A',actorId:'A1',summary:{rowCount:1,totalAmount:0},payload:{...changed,rows:[{...changed.rows[0],quantity:'999'}]}});}catch(error){operationConflict=error;}
      check(operationConflict?.code==='SMARTINPUT_WORK_DOCUMENT_OPERATION_CONFLICT' && (await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-1'})).record.revision===2,'same operation ID with a different payload must not reuse a false success receipt');
      let stale; try{await store.commitSmartInputWorkDocument({companyId:'C1',voucherMode:'purchase',documentId:'WORK-1',expectedRevision:1,operationId:'WORK-STALE',title:'stale',actorId:'A1',summary:{},payload});}catch(error){stale=error;}
      check(stale?.code==='SMARTINPUT_WORK_DOCUMENT_REVISION_CONFLICT' && (await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-1'})).record.revision===2,'stale preimage overwrote the latest revision');
      failWorkDocument=true; let aborted; try{await store.commitSmartInputWorkDocument({companyId:'C1',voucherMode:'purchase',documentId:'WORK-ABORT',expectedRevision:0,operationId:'WORK-ABORT-OP',title:'abort',actorId:'A1',summary:{},payload});}catch(error){aborted=error;}finally{failWorkDocument=false;}
      check(aborted?.name==='AbortError' && (await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-ABORT'})).status==='MISSING','aborted write left a partial saved document');
    });
    await test('saved work photo survives source clear and failed photo revision',async()=>{
      const payload={documentId:'SESSION-PHOTO',mode:'purchase',activeMethod:'photo',rows:[{rowId:'PHOTO-ROW',itemName:'사진 상품',quantity:1}]};
      const photo={sourceImageId:'IMAGE-1',fileName:'proof.png',mimeType:'image/png',byteLength:3,contentHash:'photo-1',dataUrl:'data:image/png;base64,YWJj',binaryBase64:'YWJj'};
      await store.saveSourceImage({...photo,documentId:'SESSION-PHOTO',companyId:'C1',mode:'purchase'});
      const request={companyId:'C1',voucherMode:'purchase',documentId:'WORK-PHOTO',expectedRevision:0,operationId:'PHOTO-OP-1',title:'사진 구매',actorId:'A1',summary:{rowCount:1},payload,sourceImage:photo};
      const first=await store.commitSmartInputWorkDocument(request);
      check(first.record.revision===1 && first.record.sourceImageId==='IMAGE-1' && Boolean(first.record.sourceImageFingerprint),'photo identity was not bound to work revision');
      await store.deleteSourceImage('SESSION-PHOTO');
      const opened=await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO'});
      check(opened.status==='READY' && opened.sourceImage?.dataUrl===photo.dataUrl && opened.sourceImage.documentId==='WORK-PHOTO','saved photo depended on cleared working source');
      check(!Object.hasOwn(opened.sourceImage,'binaryBase64') && !Object.hasOwn(opened.record,'sourceImage'),'photo bytes were duplicated in saved work');
      const replay=await store.commitSmartInputWorkDocument(request);
      check(replay.idempotent && replay.record.revision===1,'same photo retry did not reuse committed operation');
      let imageConflict; try {await store.commitSmartInputWorkDocument({...request,sourceImage:{...photo,dataUrl:'data:image/png;base64,ZGVm'}});} catch(error) {imageConflict=error;}
      check(imageConflict?.code==='SMARTINPUT_WORK_DOCUMENT_OPERATION_CONFLICT','changed photo reused same operation ID');
      await store.commitSmartInputWorkDocument({...request,documentId:'WORK-PHOTO-COPY',operationId:'PHOTO-OP-COPY'});
      const copy=await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO-COPY'});
      check(copy.status==='READY' && copy.sourceImage?.dataUrl===photo.dataUrl,'save as new did not get independent photo');
      const changedPhoto={...photo,sourceImageId:'IMAGE-2',contentHash:'photo-2',dataUrl:'data:image/png;base64,ZGVm'};
      failWorkDocumentId='WORK-PHOTO'; failWorkDocument=true;
      let aborted; try {await store.commitSmartInputWorkDocument({...request,expectedRevision:1,operationId:'PHOTO-OP-2',sourceImage:changedPhoto});} catch(error) {aborted=error;} finally {failWorkDocument=false;}
      const unchanged=await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO'});
      check(aborted?.name==='AbortError' && unchanged.status==='READY' && unchanged.record.revision===1 && unchanged.sourceImage?.dataUrl===photo.dataUrl,'failed revision changed saved photo or work record');
      const revised=await store.commitSmartInputWorkDocument({...request,expectedRevision:1,operationId:'PHOTO-OP-2',sourceImage:changedPhoto});
      const reopened=await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO'});
      check(revised.record.revision===2 && reopened.sourceImage?.sourceImageId==='IMAGE-2' && reopened.sourceImage.dataUrl===changedPhoto.dataUrl,'successful revision did not replace photo with work record');
      check((await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO-COPY'})).sourceImage?.dataUrl===photo.dataUrl,'revising original mutated save-as-new photo');
      let missing; try {await store.commitSmartInputWorkDocument({...request,documentId:'WORK-PHOTO-MISSING',operationId:'PHOTO-OP-MISSING',sourceImage:null});} catch(error) {missing=error;}
      check(missing?.code==='SMARTINPUT_WORK_DOCUMENT_SOURCE_IMAGE_MISSING','photo mode saved without source evidence');
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});
      await new Promise((resolve,reject)=>{const transaction=db.transaction('sourceImages','readwrite');transaction.objectStore('sourceImages').delete('WORK-PHOTO-COPY');transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);}); db.close();
      check((await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO-COPY'})).status==='INVALID','missing saved photo was silently accepted');
      const corruptDb=await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});
      await new Promise((resolve,reject)=>{const transaction=corruptDb.transaction('sourceImages','readwrite');const images=transaction.objectStore('sourceImages');const request=images.get('WORK-PHOTO');request.onsuccess=()=>images.put({...request.result,dataUrl:'data:image/png;base64,Y29ycnVwdA=='});transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error);}); corruptDb.close();
      check((await store.loadSmartInputWorkDocument({companyId:'C1',documentId:'WORK-PHOTO'})).status==='INVALID','changed saved photo content bypassed integrity check');
    });
    IDBObjectStore.prototype.put=nativePut;
    return {passed,failed};
  })()`);

  assert.equal(result.failed.length, 0, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('SmartInput stage3 native IndexedDB contracts PASS');
} finally {
  client?.close(); browser?.kill(); await new Promise(done => server.close(done));
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
