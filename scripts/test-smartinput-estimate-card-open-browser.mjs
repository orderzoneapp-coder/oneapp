#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEstimateCardOpenScenario } from './fixtures/smartinput-estimate-card-open-browser-scenario.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-estimate-card-open-'));
const scenario = createEstimateCardOpenScenario();
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};
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
const waitFor = async (check, label, timeout = 25_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
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
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
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

  once(method, timeout = 25_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener));
        resolveEvent(params);
      };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }

  close() {
    this.socket?.close();
  }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const cardButton = estimateId => `[data-estimate-id=${JSON.stringify(estimateId)}] [data-select-estimate-card]`;
const pointFor = (client, selector) => evaluate(client, `(() => {
  const element=document.querySelector(${JSON.stringify(selector)});
  if(!element)throw new Error('Missing element: ${selector.replaceAll("'", "\\'")}');
  element.scrollIntoView({block:'nearest',inline:'nearest'});
  const rect=element.getBoundingClientRect();
  const x=rect.left+rect.width/2;
  const y=rect.top+rect.height/2;
  const hit=document.elementFromPoint(x,y);
  if(!(hit===element||element.contains(hit)))throw new Error('Element is not hit-testable: ${selector.replaceAll("'", "\\'")} hit='+(hit?.id||hit?.className||hit?.tagName||'none')+' rect='+JSON.stringify({left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}));
  return {x,y};
})()`);

async function pointerClick(client, selector) {
  const point = await pointFor(client, selector);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function rapidPointerClicks(client, selectors) {
  const points = [];
  for (const selector of selectors) points.push(await pointFor(client, selector));
  const commands = [];
  points.forEach(point => {
    commands.push(client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' }));
    commands.push(client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }));
    commands.push(client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }));
  });
  await Promise.all(commands);
}

const readStore = (client, storeName) => evaluate(client, `new Promise((resolve,reject)=>{
  const request=indexedDB.open('oneapp-smartinput',5);
  request.onerror=()=>reject(request.error);
  request.onsuccess=()=>{
    const db=request.result;
    const tx=db.transaction(${JSON.stringify(storeName)},'readonly');
    const get=tx.objectStore(${JSON.stringify(storeName)}).getAll();
    get.onerror=()=>reject(get.error);
    get.onsuccess=()=>{resolve(get.result);db.close();};
  };
})`);
const canonicalEstimates = records => JSON.stringify([...records]
  .sort((left, right) => String(left.estimateId).localeCompare(String(right.estimateId))));
const autosaveEstimateId = records => records.find(record => record?.key === 'current')?.draft?.modes?.estimate?.catalogRecordId || '';
const individualDomOrder = client => evaluate(client, `[...document.querySelectorAll('#catalogPickerList .estimate-card[data-estimate-id]')].map(card=>card.dataset.estimateId)`);

const beginWriteAudit = (client, { failNextEstimatePut = false } = {}) => evaluate(client, `(() => {
  if(window.__estimateCardWriteAudit)throw new Error('Write audit already active');
  const audit={localDrafts:[],autosaves:[],estimatePuts:[],transactions:[],failNextEstimatePut:${failNextEstimatePut}};
  const storageSetItem=Storage.prototype.setItem;
  const objectStorePut=IDBObjectStore.prototype.put;
  const databaseTransaction=IDBDatabase.prototype.transaction;
  const clone=value=>{try{return JSON.parse(JSON.stringify(value));}catch(_){return null;}};
  Storage.prototype.setItem=function(key,value){
    if(key==='oneapp.smartinput.draft.v1')audit.localDrafts.push(clone(JSON.parse(String(value))));
    return storageSetItem.call(this,key,value);
  };
  IDBObjectStore.prototype.put=function(value,...args){
    if(this.name==='autosave')audit.autosaves.push(clone(value));
    if(this.name==='estimates'){
      audit.estimatePuts.push(clone(value));
      if(audit.failNextEstimatePut){
        audit.failNextEstimatePut=false;
        audit.injectedFailureObserved=true;
        throw new DOMException('Injected estimate-card reorder write failure','AbortError');
      }
    }
    return objectStorePut.call(this,value,...args);
  };
  IDBDatabase.prototype.transaction=function(storeNames,mode,...args){
    const names=typeof storeNames==='string'?[storeNames]:Array.from(storeNames||[]);
    if(mode==='readwrite')audit.transactions.push({stores:names,mode});
    return databaseTransaction.call(this,storeNames,mode,...args);
  };
  window.__estimateCardWriteAudit={audit,storageSetItem,objectStorePut,databaseTransaction};
  return true;
})()`);
const endWriteAudit = client => evaluate(client, `(() => {
  const current=window.__estimateCardWriteAudit;
  if(!current)return null;
  Storage.prototype.setItem=current.storageSetItem;
  IDBObjectStore.prototype.put=current.objectStorePut;
  IDBDatabase.prototype.transaction=current.databaseTransaction;
  delete window.__estimateCardWriteAudit;
  return current.audit;
})()`);

const delayNextAutosaveCompletion = (client, delayMs = 700) => evaluate(client, `(() => {
  if(window.__estimateAutosaveDelay)throw new Error('Autosave delay already active');
  const originalTransaction=IDBDatabase.prototype.transaction;
  const evidence={started:false,delayMs:${delayMs}};
  IDBDatabase.prototype.transaction=function(storeNames,mode,...args){
    const transaction=originalTransaction.call(this,storeNames,mode,...args);
    const names=typeof storeNames==='string'?[storeNames]:Array.from(storeNames||[]);
    if(evidence.started||mode!=='readwrite'||!names.includes('autosave'))return transaction;
    evidence.started=true;
    return new Proxy(transaction,{
      get(target,property){
        const value=Reflect.get(target,property,target);
        return typeof value==='function'?value.bind(target):value;
      },
      set(target,property,value){
        if(property==='oncomplete'&&typeof value==='function'){
          return Reflect.set(target,property,event=>window.setTimeout(()=>value.call(target,event),evidence.delayMs),target);
        }
        return Reflect.set(target,property,value,target);
      }
    });
  };
  window.__estimateAutosaveDelay={originalTransaction,evidence};
  return true;
})()`);

const restoreDelayedAutosaveCompletion = client => evaluate(client, `(() => {
  const current=window.__estimateAutosaveDelay;
  if(!current)return null;
  IDBDatabase.prototype.transaction=current.originalTransaction;
  delete window.__estimateAutosaveDelay;
  return current.evidence;
})()`);

const dispatchExternalDrop = (client, selector, kind) => evaluate(client, `(() => {
  const target=document.querySelector(${JSON.stringify(selector)});
  if(!target)throw new Error('Missing external-drop target');
  const transfer=new DataTransfer();
  if(${JSON.stringify(kind)}==='file')transfer.items.add(new File(['external fixture'],'outside.txt',{type:'text/plain'}));
  else transfer.setData('text/plain','external fixture text');
  const results={};
  for(const type of ['dragenter','dragover','drop']){
    const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer});
    results[type]=target.dispatchEvent(event);
  }
  return {results,types:[...transfer.types],dragging:document.querySelectorAll('.estimate-card.is-dragging').length};
})()`);

const dispatchInternalDrop = (client, fromId, toId) => evaluate(client, `(() => {
  const source=document.querySelector('[data-estimate-id=${JSON.stringify(fromId)}]');
  const target=document.querySelector('[data-estimate-id=${JSON.stringify(toId)}]');
  const handle=source?.querySelector('[data-estimate-drag-handle]');
  if(!source||!target||!handle)throw new Error('Missing internal-drag fixture card');
  const transfer=new DataTransfer();
  handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  return {types:[...transfer.types],sourceDragging:source.classList.contains('is-dragging')};
})()`);

const installOneShotRenderFailure = client => evaluate(client, `(() => {
  const rows=document.querySelector('#inputRows');
  const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  if(!rows||!descriptor?.get||!descriptor?.set)throw new Error('Unable to install render failure');
  window.__estimateCardRenderFailureCount=0;
  Object.defineProperty(rows,'innerHTML',{
    configurable:true,
    get(){return descriptor.get.call(this);},
    set(_value){
      delete this.innerHTML;
      window.__estimateCardRenderFailureCount+=1;
      throw new Error('INJECTED_ESTIMATE_CARD_TRIAL_RENDER_FAILURE');
    }
  });
  return true;
})()`);

let browser;
let client;
try {
  const address = await listen();
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
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
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const runtimeErrors = [];
  client.events.set('Runtime.exceptionThrown', [params => runtimeErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'runtime error')]);

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/index.html` });
  await loaded;
  await expr(client, `Boolean(document.querySelector('#estimateLibraryIndividualButton'))`, 'SmartInput shell');
  await evaluate(client, `(async()=>{
    const records=${JSON.stringify(scenario.estimates)};
    await new Promise((resolve,reject)=>{
      const request=indexedDB.open('oneapp-smartinput',5);
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result;
        const tx=db.transaction(['estimates','autosave'],'readwrite');
        const estimates=tx.objectStore('estimates');
        estimates.clear();
        tx.objectStore('autosave').clear();
        records.forEach(record=>estimates.put(record));
        tx.onerror=()=>reject(tx.error);
        tx.oncomplete=()=>{db.close();resolve();};
      };
    });
    localStorage.removeItem('oneapp.smartinput.draft.v1');
    return true;
  })()`);

  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await pointerClick(client, '[data-mode="estimate"]');
  await expr(client, `document.querySelectorAll('#catalogPickerList .estimate-card').length===8&&document.querySelectorAll('#linkedEstimateList .estimate-card').length===2`, 'isolated estimate fixtures');
  await pointerClick(client, '#estimateLibraryIndividualButton');

  // PR #587 cross-regression: an outside card pointer closes the popup but must keep the card click.
  await pointerClick(client, '#referenceOverview > summary');
  await expr(client, `!document.querySelector('#referenceOverviewPopup').hidden`, 'reference popup open');
  await evaluate(client, `(() => {
    const button=document.querySelector(${JSON.stringify(cardButton('EST-A'))});
    button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse',button:0,buttons:1}));
    button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1}));
    button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0,buttons:0}));
    button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,buttons:0}));
    return true;
  })()`);
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-A-ROW-"]').length===12&&document.querySelector('#referenceOverviewPopup').hidden`, 'popup outside click continues into estimate A');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-A', 'estimate A initial autosave');

  // External data must never create an internal drag session or leave click suppression behind.
  const estimatesBeforeExternal = canonicalEstimates(await readStore(client, 'estimates'));
  await dispatchExternalDrop(client, cardButton('EST-B'), 'text');
  await pointerClick(client, cardButton('EST-B'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-B-ROW-"]').length===3`, 'external text drop followed by estimate B click');
  await dispatchExternalDrop(client, cardButton('EST-A'), 'file');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-A-ROW-"]').length===12`, 'external file drop followed by estimate A click');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-A', 'estimate A autosave after external drag');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeExternal, 'external drag and card opening must not write saved estimates');
  assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target').length`), 0, 'external drag must leave no internal drag classes');

  // Keep an unsaved A edit in memory, then fail after B is applied but before its trial render succeeds.
  await pointerClick(client, '#inputListSearchButton');
  await evaluate(client, `(() => {
    const search=document.querySelector('#gridSearchInput');
    search.value='A-CODE';
    search.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'A-CODE'}));
    return true;
  })()`);
  await expr(client, `document.querySelectorAll('#inputRows tr[data-row-id^="EST-A-ROW-"]').length===12`, 'estimate A filtered rows');
  await evaluate(client, `(() => {
    const input=document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]');
    const originalSetTimeout=window.setTimeout;
    let pendingSaveTimer=0;
    window.setTimeout=function(callback,delay,...args){
      const timer=originalSetTimeout.call(this,callback,delay,...args);
      if(delay===160)pendingSaveTimer=timer;
      return timer;
    };
    input.value='37';
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'37'}));
    const customer=document.querySelector('#customerInput');
    customer.value='세션 편집 거래처';
    customer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'세션 편집 거래처'}));
    window.setTimeout=originalSetTimeout;
    if(pendingSaveTimer)window.clearTimeout(pendingSaveTimer);
    input.focus({preventScroll:true});
    return true;
  })()`);
  await wait(200);
  const recoveryBefore = await evaluate(client, `(() => {
    const input=document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]');
    input.setSelectionRange(1,1);
    const scroll=document.querySelector('#tableScroll');
    scroll.scrollTop=Math.min(96,Math.max(0,scroll.scrollHeight-scroll.clientHeight));
    return {scrollTop:scroll.scrollTop,selection:[input.selectionStart,input.selectionEnd]};
  })()`);
  await evaluate(client, `(() => {
    const selector='[data-row-id="EST-A-ROW-5"] [data-field="quantity"]';
    const trace=[];
    const snapshot=(type,input,extra={})=>trace.push({
      type,
      time:Math.round(performance.now()*10)/10,
      connected:Boolean(input?.isConnected),
      active:document.activeElement===input,
      selection:[input?.selectionStart,input?.selectionEnd],
      ...extra
    });
    const nativeSelect=HTMLInputElement.prototype.select;
    HTMLInputElement.prototype.select=function(...args){
      const tracked=this.matches(selector);
      if(tracked)snapshot('select-before',this,{stack:String(new Error().stack||'')});
      const result=Reflect.apply(nativeSelect,this,args);
      if(tracked)snapshot('select-after',this);
      return result;
    };
    document.addEventListener('pointerdown',event=>{
      if(event.target.closest('[data-estimate-id="EST-B"]'))snapshot('pointerdown',document.querySelector(selector));
    },{capture:true,once:true});
    document.addEventListener('focusin',event=>{
      if(event.target.matches?.(selector))snapshot('focusin',event.target);
    },true);
    document.addEventListener('focusout',event=>{
      if(event.target.matches?.(selector))snapshot('focusout',event.target);
    },true);
    document.addEventListener('selectionchange',()=>{
      const input=document.querySelector(selector);
      if(input&&document.activeElement===input)snapshot('selectionchange',input);
    });
    snapshot('trace-start',document.querySelector(selector));
    window.__estimateSelectionTrace={trace,nativeSelect};
    return true;
  })()`);
  const estimatesBeforeFailure = canonicalEstimates(await readStore(client, 'estimates'));
  await beginWriteAudit(client);
  await installOneShotRenderFailure(client);
  await pointerClick(client, cardButton('EST-B'));
  await expr(client, `(() => {
    const a=document.querySelector(${JSON.stringify(cardButton('EST-A'))});
    const b=document.querySelector('[data-estimate-id="EST-B"]');
    const input=document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]');
    const message=(b?.innerText||'')+' '+(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#appStatus')?.innerText||'');
    return a?.getAttribute('aria-pressed')==='true'&&input?.value==='37'&&/불러오지 못|표시 실패|다시 선택/.test(message);
  })()`, 'failed B render restores estimate A');
  await expr(client, `document.activeElement?.matches('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]')`, 'failed B render restores focused A edit');
  await waitFor(async () => {
    const current = (await readStore(client, 'autosave')).find(record => record?.key === 'current');
    return current?.draft?.modes?.estimate?.catalogRecordId === 'EST-A'
      && current.draft.modes.estimate.rows?.find(row => row.rowId === 'EST-A-ROW-5')?.quantity === 37;
  }, 'restored A edit automatic autosave without further input');
  const failureAudit = await endWriteAudit(client);
  const recoveryAfter = await evaluate(client, `(() => {
    const input=document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]');
    return {
      quantity:input?.value,
      search:document.querySelector('#gridSearchInput')?.value,
      searchHidden:document.querySelector('#inputListSearchPanel')?.hidden,
      selection:[input?.selectionStart,input?.selectionEnd],
      scrollTop:document.querySelector('#tableScroll')?.scrollTop,
      renderFailures:window.__estimateCardRenderFailureCount,
      selectionTrace:window.__estimateSelectionTrace?.trace||[]
    };
  })()`);
  await evaluate(client, `(() => {
    if(window.__estimateSelectionTrace?.nativeSelect)HTMLInputElement.prototype.select=window.__estimateSelectionTrace.nativeSelect;
    return true;
  })()`);
  assert.equal(recoveryAfter.quantity, '37', 'trial-render failure must restore the previous unsaved cell edit');
  assert.equal(await evaluate(client, `document.querySelector('#customerInput')?.value`), '세션 편집 거래처',
    'trial-render failure must restore the previous unsaved customer edit');
  assert.equal(recoveryAfter.search, 'A-CODE', 'trial-render failure must restore the previous estimate search');
  assert.equal(recoveryAfter.searchHidden, false, 'trial-render failure must restore the open search panel');
  assert.deepEqual(recoveryAfter.selection, recoveryBefore.selection,
    `trial-render failure must restore the cell selection; trace=${JSON.stringify(recoveryAfter.selectionTrace)}`);
  assert.equal(recoveryAfter.scrollTop, recoveryBefore.scrollTop, 'trial-render failure must restore table scroll');
  assert.equal(recoveryAfter.renderFailures, 1, 'the injected failure must occur in the candidate trial render exactly once');
  assert.equal(failureAudit.localDrafts.filter(draft => draft?.modes?.estimate?.catalogRecordId === 'EST-B').length, 0,
    'a failed candidate must not enter compatibility draft storage');
  assert.equal(failureAudit.autosaves.filter(record => record?.draft?.modes?.estimate?.catalogRecordId === 'EST-B').length, 0,
    'a failed candidate must not enter latest autosave');
  assert.equal(failureAudit.localDrafts.length, 1, 'the restored previous edit must write the compatibility draft once without another input');
  assert.equal(failureAudit.autosaves.length, 1, 'the restored previous edit must write latest autosave once without another input');
  assert.equal(failureAudit.estimatePuts.length, 0, 'a failed candidate must not write saved estimates');
  const restoredCompatibilityDraft = JSON.parse(await evaluate(client, `localStorage.getItem('oneapp.smartinput.draft.v1')`));
  assert.equal(restoredCompatibilityDraft.modes.estimate.catalogRecordId, 'EST-A');
  assert.equal(restoredCompatibilityDraft.modes.estimate.rows.find(row => row.rowId === 'EST-A-ROW-5').quantity, 37);
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeFailure, 'failed candidate must leave saved estimates unchanged');

  // If the prior autosave is already in flight, failure re-arms A so its stale callback cannot strand the save UI.
  await delayNextAutosaveCompletion(client);
  await beginWriteAudit(client);
  await evaluate(client, `(() => {
    const input=document.querySelector('[data-row-id="EST-A-ROW-6"] [data-field="quantity"]');
    input.value='29';
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'29'}));
    return true;
  })()`);
  await expr(client, `window.__estimateAutosaveDelay?.evidence?.started===true&&document.querySelector('#saveState')?.dataset.state==='saving'`, 'previous A autosave in flight');
  await installOneShotRenderFailure(client);
  await pointerClick(client, cardButton('EST-B'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelector('[data-row-id="EST-A-ROW-6"] [data-field="quantity"]')?.value==='29'&&/불러오기 실패|다시 선택/.test(document.querySelector('#estimateSelectionSummary')?.innerText||'')`, 'in-flight autosave failure restores A');
  await waitFor(async () => {
    const current = (await readStore(client, 'autosave')).find(record => record?.key === 'current');
    return current?.draft?.modes?.estimate?.catalogRecordId === 'EST-A'
      && current.draft.modes.estimate.rows?.find(row => row.rowId === 'EST-A-ROW-6')?.quantity === 29
      && await evaluate(client, `document.querySelector('#saveState')?.dataset.state==='saved'`);
  }, 're-armed A autosave after stale in-flight completion');
  const inFlightAudit = await endWriteAudit(client);
  const delayEvidence = await restoreDelayedAutosaveCompletion(client);
  assert.equal(delayEvidence.started, true);
  assert.equal(inFlightAudit.localDrafts.length, 2, 'the initial and re-armed A saves must each update compatibility storage');
  assert.equal(inFlightAudit.autosaves.length, 2, 'the in-flight and re-armed A snapshots must complete in queue order');
  assert.ok(inFlightAudit.autosaves.every(record => record?.draft?.modes?.estimate?.catalogRecordId === 'EST-A'),
    'neither autosave snapshot may contain failed estimate B');
  assert.equal(inFlightAudit.estimatePuts.length, 0, 'in-flight recovery must not write saved estimates');

  // A successful retry must persist B without requiring another input event.
  await beginWriteAudit(client);
  await pointerClick(client, cardButton('EST-B'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-B-ROW-"]').length===3&&document.querySelector('#gridSearchInput')?.value===''&&document.querySelector('#inputListSearchPanel')?.hidden`, 'successful B retry and search reset');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-B', 'automatic B autosave without further input');
  await expr(client, `document.querySelector('#saveState')?.dataset.state==='saved'`, 'B autosave completion state');
  const successAudit = await endWriteAudit(client);
  assert.equal(successAudit.localDrafts.length, 1, 'successful card opening must write the compatibility draft exactly once');
  assert.equal(successAudit.localDrafts[0]?.modes?.estimate?.catalogRecordId, 'EST-B');
  assert.equal(successAudit.autosaves.length, 1, 'successful card opening must queue latest autosave exactly once');
  assert.equal(successAudit.autosaves[0]?.draft?.modes?.estimate?.catalogRecordId, 'EST-B');
  assert.equal(successAudit.estimatePuts.length, 0, 'successful card opening must not write saved estimate records');

  // A stale derived workingRows array is rebuilt from the preserved mapping source without changing its schema or saved estimate.
  const estimatesBeforeMappedOpen = canonicalEstimates(await readStore(client, 'estimates'));
  await pointerClick(client, cardButton('EST-MAPPED'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-MAPPED'))})?.getAttribute('aria-pressed')==='true'&&[...document.querySelectorAll('#inputRows tr[data-row-id]')].filter(row=>row.dataset.defaultRow!=='true').map(row=>row.dataset.rowId).join(',')==='source-1,source-2'`, 'stale mapping repaired in input view');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-MAPPED', 'repaired mapped estimate autosave');
  const mappedAutosave = (await readStore(client, 'autosave')).find(record => record?.key === 'current')?.draft?.modes?.estimate;
  assert.deepEqual(mappedAutosave.inputMapping.headers, ['품목코드', '품목명', '수량'], 'mapping headers must remain unchanged');
  assert.deepEqual(mappedAutosave.inputMapping.sourceMatrix, [
    ['품목코드', '품목명', '수량'],
    ['MAP-01', '매핑 품목 1', '2'],
    ['MAP-02', '매핑 품목 2', '4']
  ], 'mapping source matrix must remain unchanged');
  assert.equal(mappedAutosave.inputMapping.signature, JSON.stringify({
    companyId: 'ONEAPP',
    voucherMode: 'estimate',
    headers: ['품목코드', '품목명', '수량']
  }), 'mapping signature must remain unchanged');
  assert.deepEqual(mappedAutosave.inputMapping.hiddenColumns, [2], 'mapping user column settings must remain unchanged');
  assert.deepEqual(mappedAutosave.inputMapping.workingRows.map(row => row.rowId), ['source-1', 'source-2'], 'stale working rows must be minimally rebuilt');
  assert.deepEqual(mappedAutosave.inputMapping.workingRows.map(row => row.cells), [
    ['MAP-01', '매핑 품목 1', '2'],
    ['MAP-02', '매핑 품목 2', '4']
  ], 'stale mapped cell values must be rebuilt from the preserved source');
  await pointerClick(client, '#tableViewSwitch [data-table-view="source"]');
  await expr(client, `[...document.querySelectorAll('#mappingInputRows tr[data-mapping-row-id]')].filter(row=>row.dataset.mappingDefaultRow!=='true').map(row=>row.dataset.mappingRowId).join(',')==='source-1,source-2'`, 'repaired mapping source view');
  await pointerClick(client, '#tableViewSwitch [data-table-view="input"]');
  await expr(client, `[...document.querySelectorAll('#inputRows tr[data-row-id]')].filter(row=>row.dataset.defaultRow!=='true').map(row=>row.dataset.rowId).join(',')==='source-1,source-2'`, 'repaired mapping input view after toggle');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeMappedOpen, 'mapping repair during open must not mutate the saved estimate');

  // The unsaved A working copy is a same-session guarantee only.
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]')?.value==='37'&&document.querySelector('#customerInput')?.value==='세션 편집 거래처'`, 'same-session estimate A row and customer working-copy restoration');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-A', 'restored estimate A autosave');
  const restoredA = (await readStore(client, 'autosave')).find(record => record?.key === 'current')?.draft?.modes?.estimate;
  assert.equal(restoredA?.header?.customerName, '세션 편집 거래처', 'same-session autosave must retain the unsaved A customer header');
  assert.equal(restoredA?.header?.customerId, '', 'free-form same-session customer edits must remain unlinked');
  assert.equal(restoredA?.header?.customerMappingSource, '', 'same-session customer edit provenance must not be reset to the saved catalog');

  // A stale card whose record disappears before the queued lookup restores the prior focus and scroll.
  await evaluate(client, `document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]')?.focus({preventScroll:true})`);
  await wait(50);
  const staleCardBefore = await evaluate(client, `(() => {
    const input=document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]');
    const scroll=document.querySelector('#tableScroll');
    input.setSelectionRange(1,1);
    scroll.scrollTop=Math.min(112,Math.max(0,scroll.scrollHeight-scroll.clientHeight));
    document.querySelector('[data-estimate-id="EST-B"]').dataset.estimateId='EST-GONE';
    return {scrollTop:scroll.scrollTop,selection:[input.selectionStart,input.selectionEnd]};
  })()`);
  await beginWriteAudit(client);
  await pointerClick(client, cardButton('EST-GONE'));
  await wait(50);
  await expr(client, `(() => {
    const input=document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]');
    const message=(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#appStatus')?.innerText||'');
    return document.activeElement===input&&input?.selectionStart===1&&input?.selectionEnd===1
      &&document.querySelector('#tableScroll')?.scrollTop===${staleCardBefore.scrollTop}
      &&/EST-GONE|현재 목록|다시 선택/.test(message);
  })()`, 'queued missing record restores A focus and scroll');
  const staleCardAudit = await endWriteAudit(client);
  assert.deepEqual(staleCardBefore.selection, [1, 1]);
  assert.equal(staleCardAudit.localDrafts.length, 0, 'a stale missing card must not write the compatibility draft');
  assert.equal(staleCardAudit.autosaves.length, 0, 'a stale missing card must not write latest autosave');
  assert.equal(staleCardAudit.estimatePuts.length, 0, 'a stale missing card must not write saved estimates');

  // An applied template that references a removed target fails closed instead of dropping the mapping.
  await beginWriteAudit(client);
  await pointerClick(client, cardButton('EST-MAPPING-INVALID'));
  await expr(client, `(() => {
    const active=document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true';
    const message=(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#appStatus')?.innerText||'');
    return active&&/사용할 수 없는 연결 대상|불러오기 실패|다시 선택/.test(message);
  })()`, 'removed mapping target fails closed');
  await wait(250);
  const invalidMappingAudit = await endWriteAudit(client);
  assert.equal(invalidMappingAudit.localDrafts.length, 0, 'an invalid mapping target must not write the compatibility draft');
  assert.equal(invalidMappingAudit.autosaves.length, 0, 'an invalid mapping target must not write latest autosave');
  assert.equal(invalidMappingAudit.estimatePuts.length, 0, 'an invalid mapping target must not write saved estimates');

  // Header-scope mapped values participate in input/source consistency and fail closed when stale.
  await beginWriteAudit(client);
  await pointerClick(client, cardButton('EST-HEADER-MAPPING-STALE'));
  await expr(client, `(() => {
    const active=document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true';
    const message=(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#appStatus')?.innerText||'');
    return active&&/입력형과 원본형|입력 양식|불러오기 실패|다시 선택/.test(message);
  })()`, 'stale header mapping fails closed');
  await wait(250);
  const staleHeaderMappingAudit = await endWriteAudit(client);
  assert.equal(staleHeaderMappingAudit.localDrafts.length, 0, 'a stale header mapping must not write the compatibility draft');
  assert.equal(staleHeaderMappingAudit.autosaves.length, 0, 'a stale header mapping must not write latest autosave');
  assert.equal(staleHeaderMappingAudit.estimatePuts.length, 0, 'a stale header mapping must not write saved estimates');

  // Missing source row identity is rejected before normalization can invent a replacement ID.
  await beginWriteAudit(client);
  await pointerClick(client, cardButton('EST-ROW-ID-INVALID'));
  await expr(client, `(() => {
    const active=document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true';
    const message=(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#appStatus')?.innerText||'');
    return active&&/행 식별자|불러오기 실패|다시 선택/.test(message);
  })()`, 'missing source row identity fails before normalization');
  await wait(250);
  const invalidRowIdAudit = await endWriteAudit(client);
  assert.equal(invalidRowIdAudit.localDrafts.length, 0, 'an invalid source row identity must not write the compatibility draft');
  assert.equal(invalidRowIdAudit.autosaves.length, 0, 'an invalid source row identity must not write latest autosave');
  assert.equal(invalidRowIdAudit.estimatePuts.length, 0, 'an invalid source row identity must not write saved estimates');

  // A target record with no draft fails explicitly and leaves A intact with zero candidate writes.
  await beginWriteAudit(client);
  await pointerClick(client, cardButton('EST-NO-DRAFT'));
  await expr(client, `(() => {
    const active=document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true';
    const card=document.querySelector('[data-estimate-id="EST-NO-DRAFT"]');
    const message=(card?.innerText||'')+' '+(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#appStatus')?.innerText||'');
    return active&&/불러오지 못|작업 데이터|다시 선택/.test(message);
  })()`, 'missing-draft card failure');
  await wait(250);
  const missingDraftAudit = await endWriteAudit(client);
  assert.equal(missingDraftAudit.localDrafts.length, 0);
  assert.equal(missingDraftAudit.autosaves.length, 0);
  assert.equal(missingDraftAudit.estimatePuts.length, 0);
  assert.equal(await evaluate(client, `document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]')?.value`), '37');

  // A failed queue item must finish focus restoration before the following valid card succeeds.
  await rapidPointerClicks(client, [cardButton('EST-MAPPING-INVALID'), cardButton('EST-B')]);
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-B-ROW-"]').length===3`, 'failed then valid queued selection');
  await evaluate(client, `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const focusAfterFailedThenValid = await evaluate(client, `({
    id:document.activeElement?.id||'',
    estimateId:document.activeElement?.closest?.('.estimate-card')?.dataset.estimateId||''
  })`);
  assert.notEqual(focusAfterFailedThenValid.id, 'inputListSearchButton', 'a failed item must not steal focus after the next card succeeds');
  assert.notEqual(focusAfterFailedThenValid.estimateId, 'EST-MAPPING-INVALID', 'stale failure focus must not return to the invalid card');

  // Rapid A -> B input stays serialized; the final table and latest autosave belong wholly to B.
  await rapidPointerClicks(client, [cardButton('EST-A'), cardButton('EST-B')]);
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-B-ROW-"]').length===3`, 'rapid A to B final selection');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-B', 'rapid A to B final autosave');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('#inputRows tr[data-row-id]')].filter(row=>row.dataset.defaultRow!=='true').map(row=>row.dataset.rowId)`),
    ['EST-B-ROW-1', 'EST-B-ROW-2', 'EST-B-ROW-3'], 'rapid selection must not mix rows from A and B');

  // Internal reorder uses one optimistic transaction and mutates memory/DOM only after success.
  await wait(250);
  await beginWriteAudit(client);
  await dispatchInternalDrop(client, 'EST-B', 'EST-A');
  await waitFor(async () => {
    const order = await individualDomOrder(client);
    return order.indexOf('EST-B') < order.indexOf('EST-A')
      && await evaluate(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target').length===0`);
  }, 'successful internal reorder');
  const reorderSuccessAudit = await endWriteAudit(client);
  const successEstimateTransactions = reorderSuccessAudit.transactions.filter(transaction => transaction.stores.includes('estimates'));
  assert.equal(successEstimateTransactions.length, 1, 'successful reorder must use one estimates transaction');
  assert.ok(reorderSuccessAudit.estimatePuts.length >= 2, 'successful reorder must persist its complete next order in the transaction');
  const afterReorderSuccess = await readStore(client, 'estimates');
  assert.ok(afterReorderSuccess.find(record => record.estimateId === 'EST-B').sortOrder < afterReorderSuccess.find(record => record.estimateId === 'EST-A').sortOrder);

  const bAutosaveBeforeClick = (await readStore(client, 'autosave')).find(record => record.key === 'current')?.updatedAt || '';
  await pointerClick(client, cardButton('EST-B'));
  await waitFor(async () => {
    const current = (await readStore(client, 'autosave')).find(record => record.key === 'current');
    return current?.draft?.modes?.estimate?.catalogRecordId === 'EST-B' && current.updatedAt !== bAutosaveBeforeClick;
  }, 'card click after successful reorder');

  // Injected transaction failure must preserve both persisted bytes and rendered order, then allow an immediate source-card click.
  const estimatesBeforeReorderFailure = canonicalEstimates(await readStore(client, 'estimates'));
  const domBeforeReorderFailure = await individualDomOrder(client);
  await beginWriteAudit(client, { failNextEstimatePut: true });
  await dispatchInternalDrop(client, 'EST-A', 'EST-B');
  await expr(client, `window.__estimateCardWriteAudit?.audit?.injectedFailureObserved===true&&document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target').length===0`, 'failed internal reorder cleanup');
  await wait(150);
  const reorderFailureAudit = await endWriteAudit(client);
  const failureEstimateTransactions = reorderFailureAudit.transactions.filter(transaction => transaction.stores.includes('estimates'));
  assert.equal(failureEstimateTransactions.length, 1, 'failed reorder must attempt only one estimates transaction');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeReorderFailure, 'failed reorder must leave estimates byte-identical');
  assert.deepEqual(await individualDomOrder(client), domBeforeReorderFailure, 'failed reorder must leave DOM order unchanged');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelector('[data-row-id="EST-A-ROW-5"] [data-field="quantity"]')?.value==='37'`, 'card click after failed internal reorder');

  // PARTIAL_MISSING re-identifies a shared product whose representative source disappeared, while preserving mapping source data.
  await pointerClick(client, '#estimateLibraryLinkedButton');
  const estimatesBeforePartialMissing = canonicalEstimates(await readStore(client, 'estimates'));
  await pointerClick(client, cardButton('EST-LINKED-PARTIAL-SHARED'));
  const partialRowId = 'LINKED:EST-PARTIAL-SOURCE-B:EST-PARTIAL-SOURCE-B-ROW-1';
  await expr(client, `(() => {
    const button=document.querySelector(${JSON.stringify(cardButton('EST-LINKED-PARTIAL-SHARED'))});
    const message=(button?.closest('.estimate-card')?.innerText||'')+' '+(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#customerHint')?.innerText||'');
    return button?.getAttribute('aria-pressed')==='true'
      &&document.querySelector('[data-mapping-row-id="${partialRowId}"]')
      &&/F8|복구|연결 확인|일부|누락/.test(message);
  })()`, 'PARTIAL_MISSING shared-product recovery-required open');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-LINKED-PARTIAL-SHARED', 'PARTIAL_MISSING active-work autosave');
  const partialAutosave = (await readStore(client, 'autosave')).find(record => record?.key === 'current')?.draft?.modes?.estimate;
  const partialFixture = scenario.estimates.find(record => record.estimateId === 'EST-LINKED-PARTIAL-SHARED');
  assert.deepEqual(partialAutosave.inputMapping.sourceMatrix, partialFixture.draft.inputMapping.sourceMatrix,
    'PARTIAL_MISSING representative repair must preserve the original source matrix');
  assert.equal(partialAutosave.inputMapping.signature, partialFixture.draft.inputMapping.signature,
    'PARTIAL_MISSING representative repair must preserve the mapping signature');
  assert.deepEqual(partialAutosave.inputMapping.hiddenColumns, partialFixture.draft.inputMapping.hiddenColumns,
    'PARTIAL_MISSING representative repair must preserve hidden columns');
  assert.equal(partialAutosave.inputMapping.editJournal['1:0'], partialFixture.draft.inputMapping.editJournal['1:0'],
    'PARTIAL_MISSING representative repair must preserve unrelated edit-journal evidence');
  assert.equal(partialAutosave.inputMapping.editJournal['1:2'], '1',
    'PARTIAL_MISSING representative repair must synchronize the surviving source quantity without rewriting sourceMatrix');
  assert.deepEqual(partialAutosave.inputMapping.workingRows.map(row => row.rowId), [partialRowId],
    'PARTIAL_MISSING must re-identify the working row to the remaining representative source');
  assert.equal(partialAutosave.inputMapping.workingRows[0]?.cells?.[2], '1',
    'the re-identified mapped row must render the surviving source value');
  assert.deepEqual(partialAutosave.inputMapping.deletedSourceRows, [],
    'the retained shared-product source row must remain active');
  assert.deepEqual(partialAutosave.rows.map(row => row.rowId), [partialRowId],
    'the input table and source mapping must share the re-identified row');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforePartialMissing,
    'opening PARTIAL_MISSING must not mutate saved estimates');
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119 });
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'PARTIAL_MISSING F8 recovery dialog');
  await pointerClick(client, '.estimate-f8-recovery-dialog [data-close]');
  await expr(client, `!document.querySelector('.estimate-f8-recovery-dialog')`, 'PARTIAL_MISSING F8 dialog close');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforePartialMissing,
    'opening and cancelling PARTIAL_MISSING F8 must perform zero estimate writes');

  // ALL_MISSING remains an opened recovery-required card and can enter the existing F8 independent-copy flow.
  const estimatesBeforeAllMissing = canonicalEstimates(await readStore(client, 'estimates'));
  await pointerClick(client, cardButton('EST-LINKED-ALL'));
  await expr(client, `(() => {
    const button=document.querySelector(${JSON.stringify(cardButton('EST-LINKED-ALL'))});
    const card=button?.closest('.estimate-card');
    const message=(card?.innerText||'')+' '+(document.querySelector('#estimateSelectionSummary')?.innerText||'')+' '+(document.querySelector('#customerHint')?.innerText||'');
    return button?.getAttribute('aria-pressed')==='true'&&/F8|복구|연결 확인|전체 원본/.test(message);
  })()`, 'ALL_MISSING recovery-required open');
  await waitFor(async () => autosaveEstimateId(await readStore(client, 'autosave')) === 'EST-LINKED-ALL', 'ALL_MISSING active-work autosave');
  const allMissingAutosave = (await readStore(client, 'autosave')).find(record => record?.key === 'current')?.draft?.modes?.estimate;
  const allMissingFixture = scenario.estimates.find(record => record.estimateId === 'EST-LINKED-ALL');
  assert.deepEqual(allMissingAutosave.inputMapping.sourceMatrix, allMissingFixture.draft.inputMapping.sourceMatrix,
    'mapped ALL_MISSING recovery must preserve its original source matrix');
  assert.deepEqual(allMissingAutosave.inputMapping.hiddenColumns, [2],
    'mapped ALL_MISSING recovery must preserve user column settings');
  assert.deepEqual(allMissingAutosave.inputMapping.workingRows, [],
    'mapped ALL_MISSING recovery must align source-view work rows with its recoverable empty table');
  assert.deepEqual(allMissingAutosave.inputMapping.deletedSourceRows, [1, 2],
    'mapped ALL_MISSING recovery must retain excluded source-row identity without deleting source data');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeAllMissing, 'opening ALL_MISSING must not mutate its saved linked record');
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F8', code: 'F8', windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 119 });
  await expr(client, `Boolean(document.querySelector('.estimate-f8-recovery-dialog[open]'))`, 'ALL_MISSING F8 independent recovery dialog');
  assert.match(await evaluate(client, `document.querySelector('.estimate-f8-recovery-dialog')?.innerText||''`), /독립|전체|원본/);
  await pointerClick(client, '.estimate-f8-recovery-dialog [data-close]');
  await expr(client, `!document.querySelector('.estimate-f8-recovery-dialog')`, 'ALL_MISSING F8 dialog close');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeAllMissing, 'opening and cancelling F8 must perform zero estimate writes');

  assert.deepEqual(runtimeErrors, [], `unexpected runtime exceptions: ${runtimeErrors.join('\n')}`);
  console.log('SmartInput estimate card open, recovery, drag, and autosave PASS');
} finally {
  if (client) {
    try { await endWriteAudit(client); } catch (_) {}
    try { await restoreDelayedAutosaveCompletion(client); } catch (_) {}
    await Promise.race([client.send('Browser.close').catch(() => {}), wait(2_000)]);
    client.close();
  }
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolveExit => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  server.closeAllConnections?.();
  await Promise.race([new Promise(resolveClose => server.close(resolveClose)), wait(2_000)]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== 'EPERM' || attempt === 9) {
        if (error.code === 'EPERM') console.warn(`Deferred locked browser profile cleanup: ${profile}`);
        else throw error;
      }
      await wait(250);
    }
  }
}
