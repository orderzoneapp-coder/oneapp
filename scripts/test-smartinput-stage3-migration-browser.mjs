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
    const migration=await import('/smartinput/estimate-migration.js');
    const {buildEstimateF8DraftPlan}=await import('/smartinput/estimate-f8-source-plan.js?v=0.1.1');
    const {buildEstimateF8RowsFromPlan,buildEstimateF8Data}=await import('/smartinput/estimate-output.js?v=0.2.6');
    const passed=[], check=(value,message)=>{if(!value)throw new Error(message);};
    const row={rowId:'SOURCE-ROW',itemCode:'0001',itemName:'상품',rowCustomerCode:'C1',unit:'개',quantity:0,unitPrice:100,purchasePriceB:100,memo:'수기 메모'};
    const source={estimateId:'SOURCE',companyId:'ONEAPP',estimateKind:'INDIVIDUAL',catalogName:'원본',createdAt:'CREATED',updatedAt:'UPDATED',sortOrder:1,
      draft:{documentId:'DOC-SOURCE',catalogRecordId:'SOURCE',estimateKind:'INDIVIDUAL',header:{customerCode:'C1'},rows:[row]}};
    const refs=[{estimateId:'SOURCE',rowId:'SOURCE-ROW'}];
    const linked={estimateId:'OLD-LINKED',estimateKind:'LINKED_GROUP',catalogName:'기존 연동',createdAt:'LINKED-CREATED',updatedAt:'LINKED-UPDATED',sortOrder:2,
      linkedEstimateSources:[{estimateId:'SOURCE'}],draft:{documentId:'DOC-LINKED',catalogRecordId:'OLD-LINKED',estimateKind:'LINKED_GROUP',header:{},
        linkedEstimateSources:[{estimateId:'SOURCE'}],rows:[{...row,rowId:'VISIBLE',linkedSourceEstimateId:'SOURCE',linkedSourceRowId:'SOURCE-ROW',linkedSourceEstimateIds:['SOURCE'],linkedSourceRefs:refs},
          {...row,rowId:'MANUAL',itemCode:'MANUAL',itemName:'수기 추가',memo:'독립 수기값'}]}};
    await store.saveEstimate(source);await store.saveEstimate(linked);
    const untouched={...structuredClone(source),estimateId:'UNSELECTED',catalogName:'미선택'};await store.saveEstimate(untouched);
    await store.saveLatestAutosave({draftId:'UNSAVED',activeMode:'estimate',modes:{estimate:{...source.draft,rows:[{...row,quantity:99}]}}});
    const actor={actorId:'FIXTURE',actorState:'LOCAL_EDITOR'};
    const backup=await migration.prepareEstimateMigration({store,companyId:'ONEAPP',actor,loadId:'OLD-LOAD',outputOptions:{}});
    check(backup.snapshot.estimates.length===3,'backup did not preserve complete estimate set');
    check(backup.snapshot.autosave.length>0,'backup lost unsaved work');
    let unsafe=false;
    try{await migration.convertPreservedEstimates({store,backup,companyId:'ONEAPP',actor,currentLoadId:'OLD-LOAD',oldTabsConfirmedClosed:true,backupExported:true,selectedEstimateIds:['SOURCE']});}catch(error){unsafe=error.code==='ESTIMATE_MIGRATION_SAFETY_REQUIRED';}
    check(unsafe,'same-load migration was permitted');passed.push('fixed full backup includes drafts; same-load conversion rejected');
    const converted=await migration.convertPreservedEstimates({store,backup,companyId:'ONEAPP',actor,currentLoadId:'NEW-LOAD',oldTabsConfirmedClosed:true,backupExported:true,
      selectedEstimateIds:['SOURCE','OLD-LINKED'],confirmedCompanyEstimateIds:['OLD-LINKED']});
    check(converted.every(item=>item.status==='COMMITTED'),'conversion failed: '+JSON.stringify(converted));
    const owned=(await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'OLD-LINKED'})).record;
    check(owned.estimateId===linked.estimateId&&owned.updatedAt===linked.updatedAt&&owned.createdAt===linked.createdAt,'business metadata changed');
    check(owned.ownedRows.length===2&&owned.ownedRows.some(row=>row.rowId==='MANUAL'&&row.memo==='독립 수기값'),'manual row missing');
    const plan=buildEstimateF8DraftPlan({selectedRecords:[linked],allRecords:[source,linked],individualRecords:[source]});
    const before=buildEstimateF8Data(buildEstimateF8RowsFromPlan(plan),{}),after=buildEstimateF8Data(owned.ownedRows,{});
    for(const key of ['shopData','erpData','estimateUploadData','confirmData','errors'])check(pure.estimateValuesEqual(before[key],after[key]),key+' output changed');
    check(pure.estimateValuesEqual((await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'UNSELECTED'})).record,untouched),'unselected record changed');
    passed.push('linked conversion preserves estimate ID, dates, manual rows and F8 arrays; leaves unselected records unchanged');
    const edited=structuredClone(owned);edited.ownedRows[0].memo='전환 후 새 편집';edited.dataRevision++;edited.draft=pure.projectIndependentEstimateDraft(edited);
    await store.commitIndependentEstimateEdit({companyId:'ONEAPP',actor,operationId:'AFTER-CONVERSION',estimateId:owned.estimateId,expectedPreimage:owned,candidate:edited});
    const replay=await migration.convertPreservedEstimates({store,backup,companyId:'ONEAPP',actor,currentLoadId:'RELOAD-AGAIN',oldTabsConfirmedClosed:true,backupExported:true,
      selectedEstimateIds:['OLD-LINKED'],confirmedCompanyEstimateIds:['OLD-LINKED']});
    check(replay[0].status==='ALREADY_INDEPENDENT','completed migration replayed');
    check((await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'OLD-LINKED'})).record.ownedRows[0].memo==='전환 후 새 편집','retry restored old backup over new edits');
    passed.push('restart skips completed conversion and preserves post-conversion edits');
    return {passed};
  })()`);
  console.log(JSON.stringify(result,null,2));
}finally{client?.close();browser?.kill();await new Promise(done=>server.close(done));try{rmSync(profile,{recursive:true,force:true});}catch(_){}}
