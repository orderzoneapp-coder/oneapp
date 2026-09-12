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
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-estimate-card-drag-'));
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
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
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
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method });
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
const estimateCardDragMime = 'application/x-oneapp-smartinput-estimate-card+json';
const card = estimateId => `.estimate-card[data-estimate-id=${JSON.stringify(estimateId)}]`;
const cardButton = estimateId => `${card(estimateId)} [data-select-estimate-card]`;
const cardHandle = estimateId => `${card(estimateId)} [data-estimate-drag-handle]`;
const selectedEstimateId = client => evaluate(client, `document.querySelector('.estimate-card [data-select-estimate-card][aria-pressed="true"]')?.closest('.estimate-card')?.dataset.estimateId||''`);
const individualDomOrder = client => evaluate(client, `[...document.querySelectorAll('#catalogPickerList .estimate-card[data-estimate-id]')].map(item=>item.dataset.estimateId)`);
const dirtyEstimateDragCount = client => evaluate(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length`);

const pointFor = (client, selector) => evaluate(client, `(() => {
  const element=document.querySelector(${JSON.stringify(selector)});
  if(!element)throw new Error('Missing element: ${selector.replaceAll("'", "\\'")}');
  element.scrollIntoView({block:'nearest',inline:'nearest'});
  const rect=element.getBoundingClientRect();
  const x=rect.left+rect.width/2;
  const y=rect.top+rect.height/2;
  const hit=document.elementFromPoint(x,y);
  if(!(hit===element||element.contains(hit)))throw new Error('Element is not hit-testable: ${selector.replaceAll("'", "\\'")}');
  return {x,y};
})()`);

async function pointerClick(client, selector) {
  const point = await pointFor(client, selector);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function keyboardActivate(client, selector, key) {
  await client.send('Page.bringToFront');
  const focused = await evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing keyboard target');element.focus({preventScroll:true});return document.activeElement===element;})()`);
  assert.equal(focused, true, `${selector} must receive keyboard focus`);
  const details = key === 'Enter'
    ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    : { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  const text = key === 'Enter' ? '\r' : ' ';
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...details, text, unmodifiedText: text });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...details });
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
const mutateEstimateForPreimageConflict = (client, estimateId) => evaluate(client, `new Promise((resolve,reject)=>{
  const request=indexedDB.open('oneapp-smartinput',5);
  request.onerror=()=>reject(request.error);
  request.onsuccess=()=>{
    const db=request.result;
    const tx=db.transaction('estimates','readwrite');
    const store=tx.objectStore('estimates');
    const get=store.get(${JSON.stringify(estimateId)});
    get.onerror=()=>reject(get.error);
    get.onsuccess=()=>{
      if(!get.result){reject(new Error('Missing preimage-conflict fixture estimate'));return;}
      store.put({...get.result,conflictFixture:'EXTERNAL-CONCURRENT-CHANGE'});
    };
    tx.onerror=()=>reject(tx.error);
    tx.oncomplete=()=>{db.close();resolve(true);};
  };
})`);
const canonicalEstimates = records => JSON.stringify([...records]
  .sort((left, right) => String(left.estimateId).localeCompare(String(right.estimateId))));

const beginEstimateWriteAudit = (client, { failNextPut = false } = {}) => evaluate(client, `(() => {
  if(window.__estimateDragWriteAudit)throw new Error('Estimate drag write audit is already active');
  const audit={transactions:[],puts:[],failNextPut:${failNextPut},injectedFailureObserved:false};
  const originalPut=IDBObjectStore.prototype.put;
  const originalTransaction=IDBDatabase.prototype.transaction;
  const clone=value=>{try{return JSON.parse(JSON.stringify(value));}catch(_){return null;}};
  IDBObjectStore.prototype.put=function(value,...args){
    if(this.name==='estimates'){
      audit.puts.push(clone(value));
      if(audit.failNextPut){
        audit.failNextPut=false;
        audit.injectedFailureObserved=true;
        throw new DOMException('Injected estimate-card reorder write failure','AbortError');
      }
    }
    return originalPut.call(this,value,...args);
  };
  IDBDatabase.prototype.transaction=function(storeNames,mode,...args){
    const stores=typeof storeNames==='string'?[storeNames]:Array.from(storeNames||[]);
    if(mode==='readwrite'&&stores.includes('estimates'))audit.transactions.push({stores,mode});
    return originalTransaction.call(this,storeNames,mode,...args);
  };
  window.__estimateDragWriteAudit={audit,originalPut,originalTransaction};
  return true;
})()`);
const endEstimateWriteAudit = client => evaluate(client, `(() => {
  const current=window.__estimateDragWriteAudit;
  if(!current)return null;
  IDBObjectStore.prototype.put=current.originalPut;
  IDBDatabase.prototype.transaction=current.originalTransaction;
  delete window.__estimateDragWriteAudit;
  return current.audit;
})()`);

const dispatchExternalDrag = (client, estimateId, kind) => evaluate(client, `(() => {
  const target=document.querySelector(${JSON.stringify(cardButton(estimateId))});
  if(!target)throw new Error('Missing external-drag target');
  const transfer=new DataTransfer();
  if(${JSON.stringify(kind)}==='file')transfer.items.add(new File(['external fixture'],'external.txt',{type:'text/plain'}));
  else if(${JSON.stringify(kind)}==='invalid-json')transfer.setData(${JSON.stringify(estimateCardDragMime)},'{invalid-json');
  else transfer.setData('text/plain','external fixture text');
  const dispatched={};
  for(const type of ['dragenter','dragover','drop']){
    const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer});
    dispatched[type]=target.dispatchEvent(event);
  }
  return {
    dispatched,
    types:[...transfer.types],
    dirtyCards:document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length
  };
})()`);

const dispatchCancelledPointerDrag = (client, estimateId) => evaluate(client, `(() => {
  const source=document.querySelector(${JSON.stringify(card(estimateId))});
  const handle=source?.querySelector('[data-estimate-drag-handle]');
  if(!source||!handle)throw new Error('Missing cancelled-drag source');
  const transfer=new DataTransfer();
  const started=handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  const active={
    started,
    types:[...transfer.types],
    dragging:source.classList.contains('is-dragging'),
    grabbed:source.getAttribute('aria-grabbed'),
    session:source.dataset.estimateDragSession||''
  };
  handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:false,dataTransfer:transfer}));
  const cleaned={
    dirtyCards:document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length
  };
  return {active,cleaned};
})()`);

const dispatchSyntheticPointerClick = (client, estimateId) => evaluate(client, `(() => {
  const button=document.querySelector(${JSON.stringify(cardButton(estimateId))});
  if(!button)throw new Error('Missing synthetic-click target');
  return button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,buttons:0,detail:1}));
})()`);

const beginPointerDrag = (client, estimateId) => evaluate(client, `(() => {
  const source=document.querySelector(${JSON.stringify(card(estimateId))});
  const handle=source?.querySelector('[data-estimate-drag-handle]');
  if(!source||!handle)throw new Error('Missing pointer-drag source');
  const transfer=new DataTransfer();
  handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  return {
    types:[...transfer.types],
    dragging:source.classList.contains('is-dragging'),
    grabbed:source.getAttribute('aria-grabbed'),
    session:source.dataset.estimateDragSession||''
  };
})()`);

const exerciseLatePointerDragEnd = client => evaluate(client, `(() => {
  const firstCard=document.querySelector(${JSON.stringify(card('EST-A'))});
  const secondCard=document.querySelector(${JSON.stringify(card('EST-B'))});
  const firstHandle=firstCard?.querySelector('[data-estimate-drag-handle]');
  const secondHandle=secondCard?.querySelector('[data-estimate-drag-handle]');
  if(!firstCard||!secondCard||!firstHandle||!secondHandle)throw new Error('Missing rapid pointer restart handles');
  const firstTransfer=new DataTransfer();
  const secondTransfer=new DataTransfer();
  firstHandle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:firstTransfer}));
  const firstSession=firstCard.dataset.estimateDragSession||'';
  secondHandle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:secondTransfer}));
  const secondSession=secondCard.dataset.estimateDragSession||'';
  firstHandle.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:false,dataTransfer:firstTransfer}));
  const afterLateDragEnd={
    firstDirty:firstCard.classList.contains('is-dragging')||firstCard.hasAttribute('aria-grabbed')||Boolean(firstCard.dataset.estimateDragSession),
    secondSession:secondCard.dataset.estimateDragSession||'',
    secondDragging:secondCard.classList.contains('is-dragging'),
    secondGrabbed:secondCard.getAttribute('aria-grabbed')||''
  };
  secondHandle.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:false,dataTransfer:secondTransfer}));
  return {
    firstSession,
    secondSession,
    afterLateDragEnd,
    dirtyAfterCurrentDragEnd:document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length
  };
})()`);

const dispatchPointerDrop = (client, fromId, toId, payloadMode = 'valid') => evaluate(client, `(() => {
  const source=document.querySelector(${JSON.stringify(card(fromId))});
  const target=document.querySelector(${JSON.stringify(card(toId))});
  const handle=source?.querySelector('[data-estimate-drag-handle]');
  if(!source||!target||!handle)throw new Error('Missing internal-drag card');
  const transfer=new DataTransfer();
  handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  if(${JSON.stringify(payloadMode)}==='invalid-json')transfer.setData(${JSON.stringify(estimateCardDragMime)},'{invalid-json');
  if(${JSON.stringify(payloadMode)}==='mismatched-key'){
    const original=JSON.parse(transfer.getData(${JSON.stringify(estimateCardDragMime)}));
    transfer.setData(${JSON.stringify(estimateCardDragMime)},JSON.stringify({...original,estimateId:'EST-NOT-THE-SOURCE'}));
  }
  target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  const marked=target.classList.contains('is-drop-target');
  target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  return {types:[...transfer.types],marked};
})()`);

const dispatchInternalDrop = (client, fromId, toId) => dispatchPointerDrop(client, fromId, toId, 'valid');

async function assertNoEstimateMutation(client, label, action) {
  const persistedBefore = canonicalEstimates(await readStore(client, 'estimates'));
  const domBefore = await individualDomOrder(client);
  await beginEstimateWriteAudit(client);
  let result;
  let audit;
  try {
    result = await action();
    await wait(180);
  } finally {
    audit = await endEstimateWriteAudit(client);
  }
  assert.equal(audit.transactions.length, 0, `${label} must not start an estimates transaction`);
  assert.equal(audit.puts.length, 0, `${label} must not put estimate records`);
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), persistedBefore, `${label} must preserve IndexedDB bytes`);
  assert.deepEqual(await individualDomOrder(client), domBefore, `${label} must preserve rendered order`);
  assert.equal(await dirtyEstimateDragCount(client), 0, `${label} must clean all temporary drag state`);
  return result;
}

async function touchDrag(client, fromId, toId) {
  const source = await pointFor(client, cardHandle(fromId));
  const target = await pointFor(client, card(toId));
  await client.send('Page.bringToFront');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: source.x, y: source.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
  });
  await wait(330);
  const active = await evaluate(client, `(() => {
    const source=document.querySelector(${JSON.stringify(card(fromId))});
    return {dragging:source?.classList.contains('is-dragging'),grabbed:source?.getAttribute('aria-grabbed')};
  })()`);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: target.x, y: target.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
  });
  await wait(40);
  const marked = await evaluate(client, `document.querySelector(${JSON.stringify(card(toId))})?.classList.contains('is-drop-target')`);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return { active, marked };
}

async function touchBodyLongScroll(client, fromId) {
  const source = await pointFor(client, cardButton(fromId));
  await client.send('Page.bringToFront');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const before = await evaluate(client, `(() => {
    const list=document.querySelector('#catalogPickerList');
    list.scrollTop=0;
    return {scrollTop:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight};
  })()`);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: source.x, y: source.y, id: 2, radiusX: 1, radiusY: 1, force: 1 }]
  });
  await wait(330);
  const dirtyAfterHold = await dirtyEstimateDragCount(client);
  for (const offset of [30, 70, 110]) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: source.x, y: source.y - offset, id: 2, radiusX: 1, radiusY: 1, force: 1 }]
    });
    await wait(45);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(150);
  const afterScrollTop = await evaluate(client, `document.querySelector('#catalogPickerList')?.scrollTop||0`);
  return { dirtyAfterHold, before, afterScrollTop };
}

async function touchMoveBeforeThreshold(client, fromId, toId) {
  const source = await pointFor(client, cardHandle(fromId));
  const target = await pointFor(client, card(toId));
  await client.send('Page.bringToFront');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: source.x, y: source.y, id: 3, radiusX: 1, radiusY: 1, force: 1 }]
  });
  await wait(45);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: target.x, y: target.y, id: 3, radiusX: 1, radiusY: 1, force: 1 }]
  });
  await wait(330);
  const dirtyAfterOldTimerDeadline = await dirtyEstimateDragCount(client);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return { dirtyAfterOldTimerDeadline };
}

async function touchCancelActiveDrag(client, estimateId) {
  const source = await pointFor(client, cardHandle(estimateId));
  await client.send('Page.bringToFront');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: source.x, y: source.y, id: 4, radiusX: 1, radiusY: 1, force: 1 }]
  });
  await wait(330);
  const active = await evaluate(client, `document.querySelector(${JSON.stringify(card(estimateId))})?.classList.contains('is-dragging')`);
  await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  return { active };
}

const exerciseStaleTouchTimer = client => evaluate(client, `(() => {
  const firstHandle=document.querySelector(${JSON.stringify(cardHandle('EST-A'))});
  const secondHandle=document.querySelector(${JSON.stringify(cardHandle('EST-B'))});
  if(!firstHandle||!secondHandle)throw new Error('Missing rapid touch restart handles');
  const originalSetTimeout=window.setTimeout;
  const originalClearTimeout=window.clearTimeout;
  const captured=[];
  let timerSequence=900000;
  const createTouch=(handle,identifier)=>{
    const rect=handle.getBoundingClientRect();
    return new Touch({
      identifier,target:handle,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,
      screenX:rect.left+rect.width/2,screenY:rect.top+rect.height/2,pageX:rect.left+rect.width/2,pageY:rect.top+rect.height/2,
      radiusX:1,radiusY:1,rotationAngle:0,force:1
    });
  };
  const dispatch=(handle,type,touch)=>handle.dispatchEvent(new TouchEvent(type,{
    bubbles:true,cancelable:true,composed:true,
    touches:type==='touchstart'?[touch]:[],targetTouches:type==='touchstart'?[touch]:[],changedTouches:[touch]
  }));
  window.setTimeout=function(callback,delay,...args){
    if(delay===260){
      const entry={id:++timerSequence,callback:()=>callback(...args),cancelled:false};
      captured.push(entry);
      return entry.id;
    }
    return originalSetTimeout.call(this,callback,delay,...args);
  };
  window.clearTimeout=function(timerId){
    const entry=captured.find(item=>item.id===timerId);
    if(entry){entry.cancelled=true;return;}
    return originalClearTimeout.call(this,timerId);
  };
  let result;
  try {
    const firstTouch=createTouch(firstHandle,51);
    dispatch(firstHandle,'touchstart',firstTouch);
    const firstSession=firstHandle.closest('.estimate-card')?.dataset.estimateDragSession||'';
    dispatch(firstHandle,'touchcancel',firstTouch);
    const secondTouch=createTouch(secondHandle,52);
    dispatch(secondHandle,'touchstart',secondTouch);
    const secondCard=secondHandle.closest('.estimate-card');
    const secondSession=secondCard?.dataset.estimateDragSession||'';
    captured[0]?.callback();
    const afterOldTimer={
      session:secondCard?.dataset.estimateDragSession||'',
      dragging:secondCard?.classList.contains('is-dragging')||false,
      dirty:document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"]').length
    };
    captured[1]?.callback();
    const afterCurrentTimer={
      session:secondCard?.dataset.estimateDragSession||'',
      dragging:secondCard?.classList.contains('is-dragging')||false,
      grabbed:secondCard?.getAttribute('aria-grabbed')||''
    };
    result={
      timerCount:captured.length,
      firstSession,
      secondSession,
      firstTimerCancelled:captured[0]?.cancelled||false,
      afterOldTimer,
      afterCurrentTimer,
      secondTouch
    };
  } finally {
    window.setTimeout=originalSetTimeout;
    window.clearTimeout=originalClearTimeout;
  }
  if(result?.secondTouch)dispatch(secondHandle,'touchcancel',result.secondTouch);
  if(result)delete result.secondTouch;
  return {...result,dirtyAfterCancel:document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length};
})()`);

async function touchTap(client, selector) {
  const point = await pointFor(client, selector);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await client.send('Page.bringToFront');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const timestamp = Date.now() / 1000;
  await client.send('Input.emulateTouchFromMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, timestamp
  });
  await wait(50);
  await client.send('Input.emulateTouchFromMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1, timestamp: timestamp + 0.05
  });
}

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
  await expr(client, `document.querySelectorAll('#catalogPickerList .estimate-card').length===8`, 'isolated individual estimate cards');
  await pointerClick(client, '#estimateLibraryIndividualButton');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-A-ROW-"]').length===12&&document.querySelector('#saveState')?.dataset.state==='saved'`, 'initial estimate A selection');

  // External text/file drags are not owned card drags and must not poison the following click.
  const estimatesBeforeExternal = canonicalEstimates(await readStore(client, 'estimates'));
  const externalText = await dispatchExternalDrag(client, 'EST-B', 'text');
  assert.ok(externalText.types.includes('text/plain'));
  assert.equal(externalText.dirtyCards, 0, 'external text drag must not create an internal card session');
  await pointerClick(client, cardButton('EST-B'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-B-ROW-"]').length===3&&document.querySelector('#saveState')?.dataset.state==='saved'`, 'B click after external text drag');
  const externalFile = await dispatchExternalDrag(client, 'EST-A', 'file');
  assert.ok(externalFile.types.includes('Files'));
  assert.equal(externalFile.dirtyCards, 0, 'external file drag must not create an internal card session');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#inputRows tr[data-row-id^="EST-A-ROW-"]').length===12&&document.querySelector('#saveState')?.dataset.state==='saved'`, 'A click after external file drag');
  const externalInvalidJson = await dispatchExternalDrag(client, 'EST-B', 'invalid-json');
  assert.ok(externalInvalidJson.types.some(type => type.includes('oneapp-smartinput-estimate-card')));
  assert.equal(externalInvalidJson.dirtyCards, 0, 'external malformed card payload must not create an internal card session');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), estimatesBeforeExternal, 'external drag and card opening must not mutate saved estimates');

  // Native button keyboard activation remains available for both Enter and Space.
  await keyboardActivate(client, cardButton('EST-B'), 'Enter');
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'`, 'Enter opens estimate B');
  await keyboardActivate(client, cardButton('EST-A'), 'Space');
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'`, 'Space opens estimate A');

  // A cancelled pointer drag consumes only its browser-generated click, then normal input recovers immediately.
  const cancelled = await dispatchCancelledPointerDrag(client, 'EST-B');
  assert.equal(cancelled.active.dragging, true, 'owned pointer drag must visibly activate');
  assert.equal(cancelled.active.grabbed, 'true', 'owned pointer drag must expose aria-grabbed');
  assert.ok(cancelled.active.session, 'owned pointer drag must mark its session');
  assert.ok(cancelled.active.types.some(type => type.includes('oneapp-smartinput-estimate-card')), 'owned pointer drag must carry its private MIME type');
  assert.equal(cancelled.cleaned.dirtyCards, 0, 'dragend must always clear owned drag state');
  await dispatchSyntheticPointerClick(client, 'EST-B');
  await wait(120);
  assert.equal(await selectedEstimateId(client), 'EST-A', 'the first synthetic pointer click after dragend must be suppressed');
  await pointerClick(client, cardButton('EST-B'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'`, 'normal pointer click after one suppression');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'`, 'restore A before reorder checks');
  await dispatchCancelledPointerDrag(client, 'EST-B');
  await keyboardActivate(client, cardButton('EST-B'), 'Enter');
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'`, 'keyboard activation while pointer-click suppression is armed');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'`, 'restore A after suppression keyboard check');

  // A late dragend from the replaced session must not release or suppress the new pointer session.
  const rapidPointerRestart = await exerciseLatePointerDragEnd(client);
  assert.ok(rapidPointerRestart.firstSession && rapidPointerRestart.secondSession && rapidPointerRestart.firstSession !== rapidPointerRestart.secondSession);
  assert.equal(rapidPointerRestart.afterLateDragEnd.firstDirty, false, 'starting B must first clean the replaced A session');
  assert.equal(rapidPointerRestart.afterLateDragEnd.secondSession, rapidPointerRestart.secondSession, 'late A dragend must retain B session ownership');
  assert.equal(rapidPointerRestart.afterLateDragEnd.secondDragging, true, 'late A dragend must not clear B drag styling');
  assert.equal(rapidPointerRestart.afterLateDragEnd.secondGrabbed, 'true', 'late A dragend must not clear B aria-grabbed');
  assert.equal(rapidPointerRestart.dirtyAfterCurrentDragEnd, 0, 'B dragend must clean its own session');

  // Escape and window blur must clear an abandoned owned session without arming click suppression.
  const escapeDrag = await beginPointerDrag(client, 'EST-B');
  assert.equal(escapeDrag.dragging, true);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await expr(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length===0`, 'Escape card-drag cleanup');
  await dispatchSyntheticPointerClick(client, 'EST-B');
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'`, 'card click after Escape cleanup');
  await pointerClick(client, cardButton('EST-A'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-A'))})?.getAttribute('aria-pressed')==='true'`, 'restore A after Escape cleanup');
  const blurDrag = await beginPointerDrag(client, 'EST-B');
  assert.equal(blurDrag.dragging, true);
  await evaluate(client, `window.dispatchEvent(new Event('blur'));true`);
  await expr(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length===0`, 'window blur card-drag cleanup');

  // Same-card, cross-kind, and malformed owned drops are no-op paths with common cleanup.
  const sameCardDrop = await assertNoEstimateMutation(client, 'same-card drop', () => dispatchPointerDrop(client, 'EST-A', 'EST-A'));
  assert.equal(sameCardDrop.marked, false, 'same-card dragover must not mark its source as a target');
  const crossKindDrop = await assertNoEstimateMutation(client, 'cross-kind drop', () => dispatchPointerDrop(client, 'EST-A', 'EST-LINKED-ALL'));
  assert.equal(crossKindDrop.marked, false, 'cross-kind dragover must not mark a linked target');
  const invalidPayloadDrop = await assertNoEstimateMutation(client, 'invalid-payload drop', () => dispatchPointerDrop(client, 'EST-A', 'EST-B', 'invalid-json'));
  assert.equal(invalidPayloadDrop.marked, true, 'a same-kind hover may be marked before its payload is rejected at drop');
  await assertNoEstimateMutation(client, 'mismatched-card-key drop', () => dispatchPointerDrop(client, 'EST-A', 'EST-B', 'mismatched-key'));

  // Successful pointer reorder commits the complete next order in one estimates transaction.
  await wait(250);
  await beginEstimateWriteAudit(client);
  const successfulDrop = await dispatchInternalDrop(client, 'EST-B', 'EST-A');
  assert.ok(successfulDrop.types.some(type => type.includes('oneapp-smartinput-estimate-card')));
  assert.equal(successfulDrop.marked, true, 'valid internal dragover must mark its target');
  await waitFor(async () => (await individualDomOrder(client)).slice(0, 2).join(',') === 'EST-B,EST-A', 'successful pointer card reorder');
  const successfulAudit = await endEstimateWriteAudit(client);
  assert.equal(successfulAudit.transactions.length, 1, 'successful reorder must use one estimates transaction');
  assert.equal(successfulAudit.puts.length, scenario.estimates.length, 'successful reorder must put the complete estimate bundle');
  const estimatesAfterSuccess = await readStore(client, 'estimates');
  assert.ok(estimatesAfterSuccess.find(record => record.estimateId === 'EST-B').sortOrder < estimatesAfterSuccess.find(record => record.estimateId === 'EST-A').sortOrder);
  assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length`), 0);

  // An injected transactional write failure preserves both IndexedDB bytes and rendered order.
  const persistedBeforeFailure = canonicalEstimates(await readStore(client, 'estimates'));
  const domBeforeFailure = await individualDomOrder(client);
  await beginEstimateWriteAudit(client, { failNextPut: true });
  await dispatchInternalDrop(client, 'EST-A', 'EST-B');
  await expr(client, `window.__estimateDragWriteAudit?.audit?.injectedFailureObserved===true&&document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length===0`, 'failed pointer reorder cleanup');
  await wait(160);
  const failedAudit = await endEstimateWriteAudit(client);
  assert.equal(failedAudit.transactions.length, 1, 'failed reorder must attempt one estimates transaction');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), persistedBeforeFailure, 'failed reorder must leave IndexedDB byte-equivalent');
  assert.deepEqual(await individualDomOrder(client), domBeforeFailure, 'failed reorder must leave the rendered order unchanged');

  // At 390px, card-body scrolling, pre-threshold handle movement, cancellation, and stale timers are all no-op reorder paths.
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(220);
  if (!await evaluate(client, `document.querySelector('#estimateLibraryView')?.classList.contains('is-open')`)) {
    await pointerClick(client, '#relatedPanelToggle');
  }
  await expr(client, `document.querySelector('#estimateLibraryView')?.classList.contains('is-open')&&!document.querySelector('#catalogPickerList')?.hidden`, '390px individual estimate drawer');
  await evaluate(client, `(() => {
    const list=document.querySelector('#catalogPickerList');
    list.style.height='180px';
    list.style.maxHeight='180px';
    list.style.flex='0 0 180px';
    return true;
  })()`);
  const mobileCardTarget = await evaluate(client, `(() => {
    const card=document.querySelector(${JSON.stringify(card('EST-A'))});
    const button=card?.querySelector('[data-select-estimate-card]');
    const handle=card?.querySelector('[data-estimate-drag-handle]');
    const cardRect=card?.getBoundingClientRect();
    const buttonRect=button?.getBoundingClientRect();
    const handleRect=handle?.getBoundingClientRect();
    return {
      cardHeight:cardRect?.height||0,
      buttonWidth:buttonRect?.width||0,
      buttonHeight:buttonRect?.height||0,
      handleWidth:handleRect?.width||0,
      handleHeight:handleRect?.height||0,
      buttonTabIndex:button?.tabIndex??-1,
      handleLabel:handle?.getAttribute('aria-label')||''
    };
  })()`);
  assert.ok(mobileCardTarget.cardHeight >= 44, '390px estimate cards must retain a 44px touch target');
  assert.ok(mobileCardTarget.buttonWidth >= 44 && mobileCardTarget.buttonHeight >= 44, '390px card open buttons must expose an actual 44px target');
  assert.ok(mobileCardTarget.handleWidth >= 44 && mobileCardTarget.handleHeight >= 44, '390px card drag handles must expose an actual 44px target');
  assert.equal(mobileCardTarget.buttonTabIndex, 0, '390px estimate cards must retain native keyboard/touch activation');
  assert.match(mobileCardTarget.handleLabel, /순서 이동/, 'the 44px drag target must retain a separate accessible name');

  const bodyScroll = await assertNoEstimateMutation(client, 'card-body long-press scroll', () => touchBodyLongScroll(client, 'EST-B'));
  assert.equal(bodyScroll.dirtyAfterHold, 0, 'long-pressing the card body must not create a reorder session');
  assert.ok(bodyScroll.before.scrollHeight > bodyScroll.before.clientHeight, 'the 390px scroll fixture must actually overflow');
  assert.ok(bodyScroll.afterScrollTop > bodyScroll.before.scrollTop, 'the long-press movement must actually scroll the card list');
  const preThresholdMove = await assertNoEstimateMutation(client, 'pre-threshold touch scroll', () => touchMoveBeforeThreshold(client, 'EST-B', 'EST-A'));
  assert.equal(preThresholdMove.dirtyAfterOldTimerDeadline, 0, 'movement before the long-press threshold must cancel the old timer and stay a scroll');
  const cancelledTouch = await assertNoEstimateMutation(client, 'touchcancel', () => touchCancelActiveDrag(client, 'EST-B'));
  assert.equal(cancelledTouch.active, true, 'touchcancel fixture must first activate a valid long-press drag');
  const rapidTouchRestart = await assertNoEstimateMutation(client, 'rapid touch restart', () => exerciseStaleTouchTimer(client));
  assert.equal(rapidTouchRestart.timerCount, 2, 'rapid restart must create one timer per owned session');
  assert.ok(rapidTouchRestart.firstSession && rapidTouchRestart.secondSession && rapidTouchRestart.firstSession !== rapidTouchRestart.secondSession);
  assert.equal(rapidTouchRestart.firstTimerCancelled, true, 'starting over must cancel the previous timer');
  assert.equal(rapidTouchRestart.afterOldTimer.session, rapidTouchRestart.secondSession, 'a stale callback must not release the new session');
  assert.equal(rapidTouchRestart.afterOldTimer.dragging, false, 'a stale callback must not activate the new card');
  assert.equal(rapidTouchRestart.afterOldTimer.dirty, 0, 'a stale callback must not leak visual state');
  assert.equal(rapidTouchRestart.afterCurrentTimer.session, rapidTouchRestart.secondSession);
  assert.equal(rapidTouchRestart.afterCurrentTimer.dragging, true, 'only the current timer may activate its session');
  assert.equal(rapidTouchRestart.afterCurrentTimer.grabbed, 'true');
  assert.equal(rapidTouchRestart.dirtyAfterCancel, 0, 'rapid restart cleanup must remove the current session');

  // Touch long-press uses the same atomic reorder path and leaves touch card activation usable.
  await evaluate(client, `(() => {
    window.__estimateCardTouchEvidence=[];
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      const button=event.target.closest?.('[data-select-estimate-card]');
      if(button)window.__estimateCardTouchEvidence.push({type,pointerType:event.pointerType||'',detail:event.detail});
    },true);
    return true;
  })()`);
  await beginEstimateWriteAudit(client);
  const touchResult = await touchDrag(client, 'EST-B', 'EST-A');
  assert.equal(touchResult.active.dragging, true, 'touch long-press must activate card dragging');
  assert.equal(touchResult.active.grabbed, 'true', 'touch long-press must expose aria-grabbed');
  assert.equal(touchResult.marked, true, 'touch move must mark the same-kind target');
  await waitFor(async () => (await individualDomOrder(client)).slice(0, 2).join(',') === 'EST-A,EST-B', 'touch card reorder');
  const touchAudit = await endEstimateWriteAudit(client);
  assert.equal(touchAudit.transactions.length, 1, 'touch reorder must use one estimates transaction');
  assert.equal(touchAudit.puts.length, scenario.estimates.length, 'touch reorder must put the complete estimate bundle');
  assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length`), 0, 'touch reorder must clean all drag state');

  await touchTap(client, cardButton('EST-B'));
  await expr(client, `document.querySelector(${JSON.stringify(cardButton('EST-B'))})?.getAttribute('aria-pressed')==='true'`, 'touch tap opens estimate B after touch reorder');
  const touchEvidence = await evaluate(client, `window.__estimateCardTouchEvidence`);
  assert.ok(touchEvidence.some(event => event.type === 'pointerdown' && event.pointerType === 'touch'), 'card touch tap must emit a touch pointerdown');
  assert.ok(touchEvidence.some(event => event.type === 'pointerup' && event.pointerType === 'touch'), 'card touch tap must emit a touch pointerup');
  assert.ok(touchEvidence.some(event => event.type === 'click' && event.pointerType === 'touch'), 'card touch tap must synthesize an accessible click');

  // A concurrent external estimate change must trigger the optimistic preimage rollback path without UI mutation.
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await mutateEstimateForPreimageConflict(client, 'EST-MAPPED');
  const persistedBeforeConflict = canonicalEstimates(await readStore(client, 'estimates'));
  const domBeforeConflict = await individualDomOrder(client);
  await beginEstimateWriteAudit(client);
  await dispatchInternalDrop(client, 'EST-B', 'EST-A');
  await expr(client, `window.__estimateDragWriteAudit?.audit?.transactions?.length===1
    &&document.querySelectorAll('.estimate-card.is-dragging,.estimate-card.is-drop-target,[aria-grabbed="true"],[data-estimate-drag-session]').length===0
    &&/다른 화면에서 변경/.test(document.querySelector('#appStatusMessage')?.textContent||'')`, 'preimage conflict rollback and cleanup');
  const conflictAudit = await endEstimateWriteAudit(client);
  assert.equal(conflictAudit.transactions.length, 1, 'preimage conflict must attempt one atomic estimates transaction');
  assert.equal(conflictAudit.puts.length, 0, 'preimage conflict must abort before any estimate put');
  assert.equal(canonicalEstimates(await readStore(client, 'estimates')), persistedBeforeConflict, 'preimage conflict must preserve the externally changed IndexedDB bytes');
  assert.deepEqual(await individualDomOrder(client), domBeforeConflict, 'preimage conflict must preserve the rendered in-memory order');

  assert.deepEqual(runtimeErrors, [], `unexpected runtime exceptions: ${runtimeErrors.join('\n')}`);
  console.log('SmartInput estimate card drag, keyboard, and touch regression PASS');
} finally {
  if (client) {
    try { await endEstimateWriteAudit(client); } catch (_) {}
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
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
