#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-f8-recovery-e2e-'));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
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
const listen = () => new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});
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
  once(method, timeout = 20_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const readEstimates = client => evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readonly');const get=tx.objectStore('estimates').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result);db.close();};};})`);

let browser;
let client;
try {
  const address = await listen();
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    try { return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] || null; } catch { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  const runtimeErrors = [];
  client.events.set('Runtime.exceptionThrown', [params => runtimeErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'runtime error')]);
  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/index.html` });
  await loaded;
  await expr(client, `Boolean(document.querySelector('#estimateLibraryLinkedButton'))`, 'SmartInput shell');

  await evaluate(client, `(async()=>{
    const timestamp='2026-09-10T00:00:00.000Z';
    const row=(rowId,itemCode,itemName,estimateId='')=>({rowId,itemCode,itemName,specification:'',quantity:1,unit:'EA',unitPrice:1000,sourceUnitPrice:'1000',outPrice:1200,matchStatus:'MATCHED',reviewStatus:'CONFIRMED',productIdentityStatus:'MASTER_LINKED',inputOwnership:estimateId?'SOURCE':'USER',editedFields:{},linkedSourceEstimateId:estimateId,linkedSourceEstimateName:estimateId,linkedSourceRowId:estimateId?'ROW-1':'',linkedSourceEstimateIds:estimateId?[estimateId]:[],linkedSourceRefs:estimateId?[{estimateId,rowId:'ROW-1'}]:[]});
    const sourceDraft={catalogRecordId:'SOURCE-A',estimateKind:'INDIVIDUAL',linkedEstimateSources:[],header:{},rows:[row('ROW-1','SRC-A','정상 원본 품목')],updatedAt:timestamp};
    const source={estimateId:'SOURCE-A',catalogName:'정상 원본',estimateKind:'INDIVIDUAL',linkedEstimateSources:[],rowCount:1,amount:1000,sortOrder:1,createdAt:timestamp,updatedAt:timestamp,draft:sourceDraft};
    const partialSources=[{estimateId:'SOURCE-A',catalogName:'정상 원본'},{estimateId:'SOURCE-GONE',catalogName:'삭제 원본'}];
    const partialRows=[row('LINKED:SOURCE-A:ROW-1','SRC-A','정상 원본 품목','SOURCE-A'),row('LINKED:SOURCE-GONE:ROW-1','GONE-1','제거될 품목','SOURCE-GONE'),row('MANUAL-1','MANUAL-1','보존 수기 품목')];
    const partial={estimateId:'LINKED-PARTIAL',catalogName:'일부 누락 연동',estimateKind:'LINKED_GROUP',linkedEstimateSources:partialSources,rowCount:3,amount:3000,sortOrder:2,createdAt:timestamp,updatedAt:timestamp,draft:{catalogRecordId:'LINKED-PARTIAL',estimateKind:'LINKED_GROUP',linkedEstimateSources:partialSources,header:{},rows:partialRows,updatedAt:timestamp}};
    const partialFail=structuredClone(partial);partialFail.estimateId='LINKED-FAIL';partialFail.catalogName='저장 실패 연동';partialFail.sortOrder=3;partialFail.draft.catalogRecordId='LINKED-FAIL';
    const partialSame=structuredClone(partial);partialSame.estimateId='LINKED-SAME';partialSame.catalogName='동일 영향 재시도 연동';partialSame.sortOrder=4;partialSame.draft.catalogRecordId='LINKED-SAME';
    const partialChange=structuredClone(partial);partialChange.estimateId='LINKED-CHANGE';partialChange.catalogName='영향 변경 재확인 연동';partialChange.sortOrder=5;partialChange.draft.catalogRecordId='LINKED-CHANGE';
    const partialStale=structuredClone(partial);partialStale.estimateId='LINKED-STALE';partialStale.catalogName='복구 중 편집 연동';partialStale.sortOrder=6;partialStale.draft.catalogRecordId='LINKED-STALE';
    const allSources=[{estimateId:'GONE-A',catalogName:'삭제 A'},{estimateId:'GONE-B',catalogName:'삭제 B'}];
    const allRows=[row('LINKED:GONE-A:ROW-1','SNAP-A','Snapshot 품목 A','GONE-A'),row('LINKED:GONE-B:ROW-1','SNAP-B','Snapshot 품목 B','GONE-B')];
    const allMissing={estimateId:'LINKED-ALL',catalogName:'전체 누락 연동',estimateKind:'LINKED_GROUP',linkedEstimateSources:allSources,rowCount:2,amount:2000,sortOrder:7,createdAt:timestamp,updatedAt:timestamp,draft:{catalogRecordId:'LINKED-ALL',estimateKind:'LINKED_GROUP',linkedEstimateSources:allSources,header:{},rows:allRows,updatedAt:timestamp}};
    const retrySources=[{estimateId:'GONE-C',catalogName:'삭제 C'},{estimateId:'GONE-D',catalogName:'삭제 D'}];
    const retryRows=[row('LINKED:GONE-C:ROW-1','SNAP-C','Snapshot 품목 C','GONE-C'),row('LINKED:GONE-D:ROW-1','SNAP-D','Snapshot 품목 D','GONE-D')];
    const outputRetry={estimateId:'LINKED-OUTPUT-RETRY',catalogName:'출력 재시도 연동',estimateKind:'LINKED_GROUP',linkedEstimateSources:retrySources,rowCount:2,amount:2000,sortOrder:8,createdAt:timestamp,updatedAt:timestamp,draft:{catalogRecordId:'LINKED-OUTPUT-RETRY',estimateKind:'LINKED_GROUP',linkedEstimateSources:retrySources,header:{},rows:retryRows,updatedAt:timestamp}};
    await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');const store=tx.objectStore('estimates');store.clear();[source,partial,partialFail,partialSame,partialChange,partialStale,allMissing,outputRetry].forEach(record=>store.put(record));tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{db.close();resolve();};};});
    return true;
  })()`);
  let reload = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await reload;
  await click(client, '[data-mode="estimate"]');
  await expr(client, `document.querySelectorAll('.linked-estimate-integrity-badge').length===7`, 'missing-source badges');
  assert.equal(await evaluate(client, `document.querySelector('[data-estimate-id="LINKED-PARTIAL"]')?.dataset.integrityStatus`), 'PARTIAL_MISSING');
  assert.equal(await evaluate(client, `document.querySelector('[data-estimate-id="LINKED-ALL"]')?.dataset.integrityStatus`), 'ALL_MISSING');

  await click(client, '#estimateLibraryLinkedButton');
  await click(client, '[data-estimate-id="LINKED-PARTIAL"] [data-select-estimate-card]');
  await expr(client, `document.querySelector('#customerHint')?.textContent.includes('보고서 출력 전에 영향 확인')`, 'non-blocking integrity notice');
  await evaluate(client, `window.__f8Writes=0;window.XLSX={utils:{book_new:()=>({sheets:[]}),aoa_to_sheet:data=>data,book_append_sheet:(book,sheet,name)=>book.sheets.push(name)},writeFile:()=>{window.__f8Writes+=1;}};true`);
  const beforeCancel = await readEstimates(client);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'partial recovery dialog');
  assert.match(await evaluate(client, `document.querySelector('.estimate-f8-recovery-dialog')?.innerText`), /SOURCE-GONE/);
  for (const width of [1440, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
    for (const theme of ['light', 'dark']) {
      await evaluate(client, `window.ONEAPP_NEXUS_UI_THEME.apply(${JSON.stringify(theme)},{persist:false});true`);
      await wait(60);
      const geometry = await evaluate(client, `(()=>{const dialog=document.querySelector('.estimate-f8-recovery-dialog');const rect=dialog.getBoundingClientRect();const body=dialog.querySelector('[data-recovery-issue]');const footer=dialog.querySelector('footer').getBoundingClientRect();return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollWidth:document.documentElement.scrollWidth,bodyOverflow:getComputedStyle(body).overflowY,footerTop:footer.top,footerBottom:footer.bottom,buttons:[...dialog.querySelectorAll('footer button')].map(button=>{const bounds=button.getBoundingClientRect();return {width:bounds.width,height:bounds.height,left:bounds.left,right:bounds.right};})};})()`);
      assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight,
        `${width}px ${theme} F8 recovery dialog must fit the viewport`);
      assert.ok(geometry.scrollWidth <= geometry.viewportWidth, `${width}px ${theme} F8 recovery dialog must not overflow the document`);
      assert.ok(geometry.footerTop < geometry.footerBottom && geometry.footerBottom <= geometry.bottom + 1);
      assert.ok(geometry.buttons.every(button => button.width > 0 && button.height >= (width === 390 ? 44 : 30)
        && button.left >= 0 && button.right <= geometry.viewportWidth));
    }
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click(client, '.estimate-f8-recovery-dialog footer [data-close]');
  await expr(client, `!document.querySelector('.estimate-f8-recovery-dialog')`, 'partial recovery cancel');
  assert.deepEqual(await readEstimates(client), beforeCancel, 'F8 recovery cancel must perform zero estimate writes');
  assert.equal(await evaluate(client, `window.__f8Writes`), 0, 'cancel must not create Excel');

  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'partial recovery confirmation');
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `window.__f8Writes===1`, 'automatic F8 continuation after partial cleanup');
  const afterPartial = await readEstimates(client);
  const partial = afterPartial.find(record => record.estimateId === 'LINKED-PARTIAL');
  assert.deepEqual(partial.linkedEstimateSources.map(source => source.estimateId), ['SOURCE-A']);
  assert.equal(partial.draft.rows.some(row => row.itemCode === 'MANUAL-1'), true, 'manual linked row must survive cleanup');
  assert.equal(partial.estimateAutomationHistory.at(-1).action, 'REMOVE_MISSING_LINKS_AND_REBUILD');

  await click(client, '[data-estimate-id="LINKED-STALE"] [data-select-estimate-card]');
  const sourceBeforeConcurrentRecovery = (await readEstimates(client)).find(record => record.estimateId === 'SOURCE-A');
  await evaluate(client, `window.__f8Writes=0;true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'concurrent-edit recovery dialog');
  await evaluate(client, `(()=>{window.__f8TransactionOriginal=IDBDatabase.prototype.transaction;window.__f8ConcurrentEditInjected=false;IDBDatabase.prototype.transaction=function(storeNames,mode,...rest){const transaction=window.__f8TransactionOriginal.call(this,storeNames,mode,...rest);const names=Array.isArray(storeNames)?storeNames:[storeNames];if(!window.__f8ConcurrentEditInjected&&mode==='readwrite'&&names.includes('estimates')){window.__f8ConcurrentEditInjected=true;queueMicrotask(()=>{const input=document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]');input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));});}return transaction;};document.querySelector('.estimate-f8-recovery-dialog [data-recovery-confirm]').click();return true;})()`);
  await expr(client, `document.querySelector('#appStatus')?.textContent.includes('F8 연결 복구 저장 완료')`, 'recovery completion with concurrent edit');
  await evaluate(client, `IDBDatabase.prototype.transaction=window.__f8TransactionOriginal;delete window.__f8TransactionOriginal;true`);
  assert.equal(await evaluate(client, `document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]')?.value`), '7', 'an edit made while F8 commits must remain in the active worktable');
  assert.equal(await evaluate(client, `window.__f8Writes`), 0, 'a stale F8 continuation must not create Excel');
  const afterConcurrentRecovery = await readEstimates(client);
  const concurrentRecovered = afterConcurrentRecovery.find(record => record.estimateId === 'LINKED-STALE');
  assert.deepEqual(concurrentRecovered.linkedEstimateSources.map(source => source.estimateId), ['SOURCE-A']);
  assert.deepEqual(afterConcurrentRecovery.find(record => record.estimateId === 'SOURCE-A'), sourceBeforeConcurrentRecovery, 'F8 recovery must not rewrite an unselected estimate');

  await click(client, '[data-estimate-id="LINKED-ALL"] [data-select-estimate-card]');
  await evaluate(client, `window.__f8Writes=0;true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'all-missing recovery dialog');
  assert.match(await evaluate(client, `document.querySelector('.estimate-f8-recovery-dialog')?.innerText`), /중복 품목은 저장 당시 대표값만 남아/);
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `window.__f8Writes===1`, 'automatic F8 continuation from independent copy');
  const afterIndependent = await readEstimates(client);
  const original = afterIndependent.find(record => record.estimateId === 'LINKED-ALL');
  const recovered = afterIndependent.find(record => record.recoveryOrigin?.sourceLinkedEstimateId === 'LINKED-ALL');
  assert.equal(original.estimateKind, 'LINKED_GROUP', 'all-missing source linked record must remain unchanged');
  assert.equal(recovered?.estimateKind, 'INDIVIDUAL');
  assert.match(recovered?.catalogName || '', /독립 복구 사본/);
  assert.equal(recovered?.draft?.rows.every(row => !('linkedSourceRefs' in row) && !('linkedSourceEstimateId' in row)), true);
  assert.equal(recovered?.estimateAutomationHistory.at(-1).operationId, recovered?.recoveryOrigin.operationId);

  await click(client, '[data-estimate-id="LINKED-OUTPUT-RETRY"] [data-select-estimate-card]');
  await evaluate(client, `window.__f8OutputAttempts=0;window.XLSX.writeFile=()=>{window.__f8OutputAttempts+=1;if(window.__f8OutputAttempts===1)throw new Error('Injected Excel output failure');window.__f8Writes+=1;};window.__f8Writes=0;true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'independent copy output failure dialog');
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `document.querySelector('#appStatus')?.textContent.includes('Excel 생성 실패')`, 'independent copy output failure status');
  const afterOutputFailure = await readEstimates(client);
  assert.equal(afterOutputFailure.filter(record => record.recoveryOrigin?.sourceLinkedEstimateId === 'LINKED-OUTPUT-RETRY').length, 1,
    '첫 Excel 실패 전 독립 복구 사본은 한 건만 저장해야 한다.');
  await click(client, '#estimateExcelButton');
  await expr(client, `window.__f8OutputAttempts===2&&window.__f8Writes===1&&!document.querySelector('.estimate-f8-recovery-dialog')`, 'confirmed independent copy automatic Excel retry');
  const afterOutputRetry = await readEstimates(client);
  assert.equal(afterOutputRetry.filter(record => record.recoveryOrigin?.sourceLinkedEstimateId === 'LINKED-OUTPUT-RETRY').length, 1,
    'Excel 재시도는 영향 지문이 같은 기존 독립 사본을 재사용해야 한다.');

  await click(client, '[data-estimate-id="LINKED-FAIL"] [data-select-estimate-card]');
  await evaluate(client, `window.__f8Writes=0;window.__f8PutOriginal=IDBObjectStore.prototype.put;window.__f8PutFailed=false;IDBObjectStore.prototype.put=function(...args){if(this.name==='estimates'&&!window.__f8PutFailed){window.__f8PutFailed=true;throw new DOMException('Injected F8 recovery write failure','AbortError');}return window.__f8PutOriginal.apply(this,args);};true`);
  const beforeFailure = await readEstimates(client);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'failure injection recovery dialog');
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `!document.querySelector('.estimate-f8-recovery-dialog')&&document.querySelector('#appStatus')?.textContent.includes('출력 보류')`, 'failed recovery status');
  await evaluate(client, `IDBObjectStore.prototype.put=window.__f8PutOriginal;delete window.__f8PutOriginal;true`);
  assert.deepEqual(await readEstimates(client), beforeFailure, 'one recovery put failure must roll back the whole estimate transaction');
  assert.equal(await evaluate(client, `window.__f8Writes`), 0, 'failed recovery must not create Excel');

  await click(client, '[data-estimate-id="LINKED-SAME"] [data-select-estimate-card]');
  await evaluate(client, `window.__f8Writes=0;true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'same-impact retry dialog');
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');const store=tx.objectStore('estimates');const get=store.get('LINKED-SAME');get.onsuccess=()=>{store.put({...get.result,updatedAt:'2026-09-10T05:00:00.000Z'});};tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{db.close();resolve(true);};};})`);
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `window.__f8Writes===1&&!document.querySelector('.estimate-f8-recovery-dialog')`, 'same-impact automatic retry');
  assert.deepEqual((await readEstimates(client)).find(record => record.estimateId === 'LINKED-SAME').linkedEstimateSources.map(source => source.estimateId), ['SOURCE-A']);

  await click(client, '[data-estimate-id="LINKED-CHANGE"] [data-select-estimate-card]');
  await evaluate(client, `window.__f8Writes=0;true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'changed-impact first dialog');
  await evaluate(client, `window.__firstF8RecoveryDialog=document.querySelector('.estimate-f8-recovery-dialog');true`);
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');const store=tx.objectStore('estimates');const get=store.get('SOURCE-A');get.onsuccess=()=>{const source=structuredClone(get.result);source.draft.rows[0].itemName='관리자 확인 중 변경된 최신 품목';source.updatedAt='2026-09-10T06:00:00.000Z';store.put(source);};tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{db.close();resolve(true);};};})`);
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))&&document.querySelector('.estimate-f8-recovery-dialog')!==window.__firstF8RecoveryDialog`, 'changed-impact second confirmation');
  assert.equal(await evaluate(client, `window.__f8Writes`), 0, 'changed impact must invalidate the first confirmation before Excel');
  await click(client, '.estimate-f8-recovery-dialog [data-recovery-confirm]');
  await expr(client, `window.__f8Writes===1`, 'changed-impact confirmed F8 continuation');
  const changedRecovered = (await readEstimates(client)).find(record => record.estimateId === 'LINKED-CHANGE');
  assert.equal(changedRecovered.draft.rows.some(row => row.itemName === '관리자 확인 중 변경된 최신 품목'), true);

  assert.deepEqual(runtimeErrors, [], `runtime exceptions: ${runtimeErrors.join('\n')}`);

  console.log('SmartInput estimate F8 recovery browser tests passed.');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  await wait(150);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
