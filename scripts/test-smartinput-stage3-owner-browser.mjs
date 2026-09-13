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

  const result=await evaluate(client,String.raw`(async()=>{
    const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');
    const pure=await import('/smartinput/independent-estimate.js?v=0.2.0');
    const {createEstimateWorkspace}=await import('/smartinput/estimate-workspace.js');
    const adapter=await import('/reference-data/product-master-command-adapter.js?v=0.3.0');
    const {getProductSnapshot}=await import('/reference-data/product-master-read-adapter.js');
    const passed=[],check=(value,message)=>{if(!value)throw new Error(message);};
    check(adapter.readSmartInputEstimateContext().status==='CONTEXT_REQUIRED','anonymous owner context accepted');
    const user={userId:'FIXTURE-ACTOR',loginId:'fixture',role:'OWNER_MASTER',status:'ACTIVE',permissions:['foundation.write','smartinput.use','admin.company']};
    const session={token:'ISOLATED-FIXTURE-SESSION',session:{user,expiresAt:new Date(Date.now()+600000).toISOString()}};
    sessionStorage.setItem('oneapp.nexus.home.session.v1',JSON.stringify(session));
    check(adapter.readSmartInputEstimateContext().status==='CONTEXT_REQUIRED','missing company scope was guessed');
    const originalFetch=window.fetch, requests=[];
    window.fetch=async(url,options)=>{
      if(!String(url).includes('script.google.com'))return originalFetch(url,options);
      const body=JSON.parse(options.body);requests.push(body.action);
      if(body.action==='nexus_auth_app_context')return new Response(JSON.stringify({status:'success',data:{appId:'company',appContextToken:'FIXTURE-CONTEXT',expiresAt:session.session.expiresAt}}));
      check(body.operationId==='company.profile_read','unexpected owner context operation');
      return new Response(JSON.stringify({status:'success',contractVersion:'NEXUS_AUTH_V2',operationId:'company.profile_read',data:{profile:{schemaVersion:'NEXUS_COMPANY_PROFILE_V1',companyId:'ONEAPP',revision:1}}}));
    };
    let context;
    try{context=await adapter.prepareSmartInputEstimateContext();}finally{window.fetch=originalFetch;}
    check(context.status==='READY'&&context.companyId==='ONEAPP','authenticated company evidence not resolved');
    check(requests.length===2,'company evidence did not use existing authenticated gateway');
    passed.push('owner scope comes from authenticated company read, never editor defaults');
    await import('/coreEngine.js?v=smartinput-stage3-v1');
    const storage=window.ONEAPP.STORAGE;
    const seeded=await storage.commitMasterState({'0001':{productId:'PRODUCT1','코드':'0001','품목명':'상품','입고B':10}});
    check(seeded.ok===true,'fixture master seed failed: '+JSON.stringify(seeded));
    const row={rowId:'ROW1',ownedRowId:'ROW1',itemCode:'0001',itemName:'상품',productId:'PRODUCT1',masterProductId:'PRODUCT1',quantity:1,purchasePriceB:30};
    const estimate={estimateId:'EST-A',companyId:'ONEAPP',schemaVersion:pure.INDEPENDENT_ESTIMATE_SCHEMA,estimateKind:'INDIVIDUAL',dataRevision:1,
      catalogName:'선택 견적',createdAt:'2026-09-01',updatedAt:'2026-09-01',ownedRows:[row],displayGroups:[{rowId:'ROW1',ownedRowIds:['ROW1'],visible:true}],
      draft:{documentId:'DOCUMENT-A',header:{},rows:[row]}};
    estimate.draft=pure.projectIndependentEstimateDraft(estimate);await store.saveEstimate(estimate);
    const actualOwner=adapter.createProductMasterCommandAdapter();
    let commits=0,loseResponse=true;
    const owner={...actualOwner,commitReviewedSmartInputEstimate:async input=>{
      commits++;const response=await actualOwner.commitReviewedSmartInputEstimate(input);
      if(loseResponse&&response.status==='APPLIED'){loseResponse=false;throw new Error('FIXTURE_LOST_RESPONSE_AFTER_COMMIT');}return response;
    }};
    const workspace=createEstimateWorkspace({store,readContext:()=>context,readMasterContext:()=>adapter.readSmartInputEstimateContext(),readProducts:getProductSnapshot,owner});
    workspace.setCompany('ONEAPP');workspace.select(['EST-A']);
    const before=JSON.stringify((await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-A'})).record);
    const first=await workspace.applyMaster({fields:['purchasePriceB']});
    check(first.status==='RESULT_UNKNOWN','lost response must remain unknown: '+JSON.stringify({first,snapshot:await getProductSnapshot(),estimate}));
    const committed=await getProductSnapshot();check(committed.data.products[0]['입고B']===30,'owner write missing');
    const pending=await store.loadPendingEstimateOperations({companyId:'ONEAPP'});check(pending.some(entry=>entry.kind==='master'),'durable intent missing');
    const retried=await workspace.resumePending('master');
    check(retried.outcomes[0].status==='APPLIED','retry did not return original receipt: '+JSON.stringify(retried));
    check(commits===1,'retry reissued product commit after confirmed success');
    check((await getProductSnapshot()).revision===committed.revision,'retry increased master revision');
    check(JSON.stringify((await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-A'})).record)===before,'master wrote source estimate');
    passed.push('durable master intent and lost response retry return receipt without a second product commit');
    const equal=await workspace.applyMaster({fields:['purchasePriceB']});
    check(equal.status==='UNCHANGED','equal values not unchanged: '+JSON.stringify(equal));
    check((await getProductSnapshot()).revision===committed.revision,'unchanged command increased revision');
    passed.push('unchanged owner command keeps product revision and source estimate unchanged');
    sessionStorage.setItem('oneapp.nexus.home.session.v1',JSON.stringify({...session,token:'DIFFERENT-FIXTURE-SESSION'}));
    check(adapter.readSmartInputEstimateContext().status==='CONTEXT_REQUIRED','company proof leaked to another session');
    passed.push('verified company scope is isolated to the current authenticated session');
    return {passed};
  })()`);
  console.log(JSON.stringify(result,null,2));
} finally {
  client?.close();browser?.kill();await new Promise(done=>server.close(done));
  try{rmSync(profile,{recursive:true,force:true});}catch(_){}
}
