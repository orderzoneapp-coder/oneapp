#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-estimate-library-switch-'));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
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
const waitFor = async (check, label, timeout = 30_000) => {
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
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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

  close() {
    this.socket?.close();
  }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};

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
    try { return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] || null; } catch { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{if(location.hostname==='127.0.0.1')localStorage.setItem('oneapp.smartinput.draft.v1',JSON.stringify({schemaVersion:'ONEAPP_SMART_INPUT_DRAFT_V1',activeMode:'estimate',modes:{},ui:{relatedPanelLayoutVersion:1,relatedOpen:true}}));}catch(_){}`
  });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await waitFor(() => evaluate(client, `window.__ONEAPP_SMARTINPUT_EARLY_UI__?.ready===true&&Boolean(document.querySelector('#inputRows tr'))&&!document.querySelector('#estimateMultiSelectButton').disabled`), 'SmartInput estimate library');
  await wait(500);

  const ordinary = await evaluate(client, `(async()=>{
    document.querySelector('#estimateLibraryIndividualButton').click();
    await new Promise(resolve=>setTimeout(resolve,80));
    const rows=document.querySelector('#inputRows');
    const tableScroll=document.querySelector('#tableScroll');
    rows.innerHTML=Array.from({length:80},(_,index)=>'<tr data-row-id="PERF-'+index+'" style="height:32px"><td><input data-field="itemCode" value="ITEM-'+index+'"></td></tr>').join('');
    const individual=document.querySelector('#catalogPickerList');
    const linked=document.querySelector('#linkedEstimateList');
    const cards=(kind)=>Array.from({length:40},(_,index)=>'<article class="estimate-card" data-estimate-kind="'+kind+'" data-estimate-id="'+kind+'-'+index+'" style="height:32px"><button data-select-estimate-card aria-pressed="false">'+kind+' '+index+'</button></article>').join('');
    individual.innerHTML=cards('INDIVIDUAL');
    linked.innerHTML=cards('LINKED_GROUP');
    individual.style.cssText='display:block;height:160px;overflow:auto';
    linked.style.cssText='display:block;height:160px;overflow:auto';
    linked.hidden=true;
    tableScroll.style.maxHeight='160px';
    tableScroll.style.overflow='auto';
    tableScroll.scrollTop=96;
    individual.scrollTop=64;
    document.querySelector('#estimateLibraryLinkedButton').click();
    linked.scrollTop=48;
    document.querySelector('#estimateLibraryIndividualButton').click();
    const initialScrolls={table:tableScroll.scrollTop,individual:individual.scrollTop,linked:linked.scrollTop};
    const focused=rows.querySelector('[data-row-id="PERF-20"] input');
    focused.value='FOCUS-VALUE';
    focused.focus({preventScroll:true});
    focused.setSelectionRange(2,7);
    const rowNodes=[...rows.children];
    const individualNodes=[...individual.children];
    const linkedNodes=[...linked.children];
    const mutations={rows:0,individual:0,linked:0};
    const observers=[
      new MutationObserver(records=>{mutations.rows+=records.filter(record=>record.type==='childList').length}),
      new MutationObserver(records=>{mutations.individual+=records.filter(record=>record.type==='childList').length}),
      new MutationObserver(records=>{mutations.linked+=records.filter(record=>record.type==='childList').length})
    ];
    observers[0].observe(rows,{childList:true});
    observers[1].observe(individual,{childList:true,subtree:true});
    observers[2].observe(linked,{childList:true,subtree:true});
    let storageWrites=0;
    const originalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(...args){storageWrites+=1;return originalSetItem.apply(this,args)};
    const durations=[];
    for(let index=0;index<30;index+=1){
      const button=document.querySelector(index%2===0?'#estimateLibraryLinkedButton':'#estimateLibraryIndividualButton');
      const started=performance.now();
      button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));
      button.focus({preventScroll:true});
      button.click();
      durations.push(performance.now()-started);
    }
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    Storage.prototype.setItem=originalSetItem;
    observers.forEach(observer=>observer.disconnect());
    durations.sort((a,b)=>a-b);
    return {
      rowIdentity:rowNodes.every((node,index)=>rows.children[index]===node),
      individualIdentity:individualNodes.every((node,index)=>individual.children[index]===node),
      linkedIdentity:linkedNodes.every((node,index)=>linked.children[index]===node),
      mutations,
      storageWrites,
      focused:document.activeElement===focused,
      focusValue:focused.value,
      selection:[focused.selectionStart,focused.selectionEnd],
      tableScrollTop:tableScroll.scrollTop,
      individualScrollTop:individual.scrollTop,
      linkedScrollTop:linked.scrollTop,
      initialScrolls,
      p95:durations[Math.floor(durations.length*0.95)],
      maximum:durations.at(-1),
      individualVisible:!individual.hidden,
      linkedHidden:linked.hidden
    };
  })()`);

  assert.equal(ordinary.rowIdentity, true, 'ordinary switch must preserve all 80 work-row nodes');
  assert.equal(ordinary.individualIdentity, true, 'ordinary switch must preserve individual card nodes');
  assert.equal(ordinary.linkedIdentity, true, 'ordinary switch must preserve linked card nodes');
  assert.deepEqual(ordinary.mutations, { rows: 0, individual: 0, linked: 0 }, 'ordinary switch must not replace work rows or list DOM');
  assert.equal(ordinary.storageWrites, 0, 'ordinary switch must not write compatibility draft storage');
  assert.equal(ordinary.focused, true, 'ordinary pointer switch must restore the active grid input');
  assert.equal(ordinary.focusValue, 'FOCUS-VALUE');
  assert.deepEqual(ordinary.selection, [2, 7]);
  assert.equal(ordinary.tableScrollTop, ordinary.initialScrolls.table);
  assert.equal(ordinary.individualScrollTop, ordinary.initialScrolls.individual);
  assert.equal(ordinary.linkedScrollTop, ordinary.initialScrolls.linked);
  assert.equal(ordinary.individualVisible, true);
  assert.equal(ordinary.linkedHidden, true);
  assert.ok(ordinary.p95 < 50, `ordinary switch p95 must stay below 50ms: ${ordinary.p95}`);

  const preview = await evaluate(client, `(async()=>{
    document.querySelector('#estimateMultiSelectButton').click();
    await new Promise(resolve=>setTimeout(resolve,350));
    const rows=document.querySelector('#inputRows');
    let rowRenderMutations=0;
    const observer=new MutationObserver(records=>{rowRenderMutations+=records.filter(record=>record.type==='childList').length});
    observer.observe(rows,{childList:true});
    let storageWrites=0;
    const originalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(...args){storageWrites+=1;return originalSetItem.apply(this,args)};
    document.querySelector('#estimateLibraryLinkedButton').click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    Storage.prototype.setItem=originalSetItem;
    observer.disconnect();
    return {rowRenderMutations,storageWrites,multiPressed:document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed'),linkedVisible:!document.querySelector('#linkedEstimateList').hidden};
  })()`);
  assert.equal(preview.rowRenderMutations, 1, 'preview cancellation switch must rebuild the work rows exactly once');
  assert.equal(preview.storageWrites, 0, 'preview cancellation switch must not write the draft');
  assert.equal(preview.multiPressed, 'false');
  assert.equal(preview.linkedVisible, true);

  console.log('SmartInput estimate library lightweight switch PASS', { ordinary, preview });
} finally {
  if (client) {
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
