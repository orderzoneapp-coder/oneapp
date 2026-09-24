#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-preset-e2e-'));
const screenshotDir = resolve(process.env.SMARTINPUT_MAPPING_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-mapping-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  if (target === join(root,'smartinput','smartinput.js')) {
    response.end(readFileSync(target,'utf8') + '\nwindow.__presetTest={snapshot:()=>({mode:state.draft.activeMode,ready:state.smartDataReady,busy:state.busy,templatesStatus:state.inputTemplatesStatus,draft:structuredClone(modeDraft()),templates:structuredClone(state.inputTemplates)}),upload:async(matrix)=>{const x=await ensureXlsx();const w=x.utils.book_new();x.utils.book_append_sheet(w,x.utils.aoa_to_sheet(matrix),"견적서현황내역");await handleFile(new File([x.write(w,{type:"array",bookType:"xlsx"})],"견적서현황(테스트).xlsx"));},saveTemplate:()=>saveAppliedInputTemplateChanges(),manager:()=>openInputTemplateManager()};');
  } else response.end(readFileSync(target));
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
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  once(method, timeout = 60_000) {
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
const pointerClick = async (client, x, y) => {
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const touchTap = async (client, x, y) => {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const typeWithoutBlur = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return element.value;})()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
};


let browser;
let client;
try {
  const address=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address())));
  const executable=browserExecutable(); assert.ok(executable,'Chrome is required');
  browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  const debugPort=await waitFor(()=>{try{return readFileSync(join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/)[0];}catch{return null;}},'Chrome');
  const pages=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  client=new CdpClient(pages.find(p=>p.type==='page').webSocketDebuggerUrl); await client.connect();
  await Promise.all([client.send('Page.enable'),client.send('Runtime.enable'),client.send('Network.enable')]);
  const exceptions=[]; const writes=[];
  client.on('Runtime.exceptionThrown',e=>exceptions.push(e.exceptionDetails?.exception?.description||e.exceptionDetails?.text));
  client.on('Network.requestWillBeSent',e=>{if(['POST','PUT','DELETE','PATCH'].includes(e.request.method))writes.push(e.request.url);});
  await client.send('Page.navigate',{url:'http://127.0.0.1:'+address.port+'/smartinput/'});
  await expr(client,'Boolean(window.__presetTest?.snapshot().ready)','SmartInput ready',60000);
  await click(client,'.mode-tab[data-mode="estimate"]');
  await expr(client,'window.__presetTest.snapshot().mode==="estimate" && !window.__presetTest.snapshot().busy && ["READY","EMPTY"].includes(window.__presetTest.snapshot().templatesStatus)','estimate templates ready',60000);
  assert.equal(await evaluate(client,'(()=>{const c=document.querySelector("#tableViewSwitch");return !c.hidden && getComputedStyle(c).display!=="none" && c.getBoundingClientRect().height>0;})()'),true,'input/source view switch must be visible');
  assert.equal(await evaluate(client,'document.querySelector("[data-table-view=source]").disabled'),true,'no original source means source view is unavailable');
  const { ESTIMATE_REPORT_HEADERS:H }=await import('../smartinput/input.js');
  const source={일자:'2026/09/02',창고:'01',거래처명:'테스트 거래처',품목명:'테스트 상품',규격:'EA',품목코드:'001234',입고가:2800,출고가:3800,입고B:'',도매A:3300,도매B:0,행사가:'21500',적요2:'0012',간단설명:'참조',단위:'소분','1종연산':'8.5',외주비:200,경비:100,노무비:200,재료비:0,'1종규격':'','1종코드':'','1입고':'','1출고':200};
  const data=Array.from({length:273},(_,i)=>H.map(h=>h==='품목코드'?'00'+String(i).padStart(5,'0'):source[h]));
  const matrix=[['회사명 / 테스트 출력'],[...H],...data,['2026/09/21 (월) 오후 12:22:12']];
  await evaluate(client,'window.__presetTest.upload('+JSON.stringify(matrix)+')');
  await expr(client,'window.__presetTest.snapshot().draft.rows.length===273','273 uploaded rows',60000);
  await expr(client,'document.querySelectorAll("#sourcePreparationList select").length===24 && !document.querySelector("#sourcePreparationApply").disabled','24 exact mappings enabled',60000);
  let snapshot=await evaluate(client,'window.__presetTest.snapshot()');
  assert.equal(snapshot.draft.inputMapping.templateName,'견적서현황');
  assert.equal(snapshot.draft.inputMapping.mappings.filter(m=>m.state==='MAPPED').length,24);
  assert.equal(snapshot.draft.inputMapping.workingRows.length,273);
  assert.equal(snapshot.draft.rows[0].unitPrice,2800); assert.equal(snapshot.draft.rows[0].outPrice,3800);
  assert.equal(snapshot.draft.rows[0].rowWarehouseCode,'01'); assert.equal(snapshot.draft.rows[0].itemCode,'0000000');
  assert.equal(snapshot.draft.rows[0].quantity,null); assert.equal(snapshot.draft.rows[0].purchasePriceB,null); assert.equal(snapshot.draft.rows[0].wholesaleB,0);
  assert.equal(snapshot.draft.rows[0].type1OutPrice,200); assert.equal(snapshot.draft.rows[0].type1Code,'');
  // A view switch must change presentation, not remap or rebuild business data.
  const visibleClick=async selector=>{
    const point=await evaluate(client,'(()=>{const el=document.querySelector('+JSON.stringify(selector)+');el.scrollIntoView({block:"nearest",inline:"nearest"});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,visible:!el.disabled&&r.width>0&&r.height>0&&getComputedStyle(el).display!=="none"};})()');
    assert.equal(point.visible,true,'view button must be reachable');
    await pointerClick(client,point.x,point.y);
  };
  const dataSnapshot=()=>evaluate(client,'(()=>{const d=window.__presetTest.snapshot().draft;return JSON.stringify({rows:d.rows,source:d.inputMapping.sourceMatrix,mappings:d.inputMapping.mappings,journal:d.inputMapping.editJournal});})()');
  const beforeView=await dataSnapshot();
  await visibleClick('[data-table-view="source"]');
  await expr(client,'document.querySelector("#tableScroll").dataset.tableView==="source" && !document.querySelector("#mappingWorktable").hidden && getComputedStyle(document.querySelector("#mappingWorktable")).display!=="none"','source view actually visible');
  assert.equal(await evaluate(client,'document.querySelector("#voucherInputTable").hidden'),true);
  assert.deepEqual(await evaluate(client,'[...document.querySelectorAll("#mappingTableHeaders th[data-mapping-column]")].map(th=>th.querySelector("strong").textContent.trim())'),H,'all 24 original labels and column order');
  assert.equal(await dataSnapshot(),beforeView,'source switch preserves rows, source, mappings, edits');
  await visibleClick('[data-table-view="input"]');
  await expr(client,'!document.querySelector("#voucherInputTable").hidden && document.querySelector("#mappingWorktable").hidden','input view restored');
  assert.equal(await dataSnapshot(),beforeView,'round trip is presentation-only');
  const firstRowId=snapshot.draft.rows[0].rowId;
  const inputPrice='[data-row-id="'+firstRowId+'"] input[data-field="unitPrice"]';
  await input(client,inputPrice,'3100');
  await expr(client,'window.__presetTest.snapshot().draft.rows[0].unitPrice===3100','input price edited');
  const afterInputEdit=await dataSnapshot();
  await visibleClick('[data-table-view="source"]');
  await expr(client,'!document.querySelector("#mappingWorktable").hidden','source after input edit');
  assert.equal(await dataSnapshot(),afterInputEdit,'switch must not revert an input edit');
  const sourcePrice='[data-mapping-row-id="'+firstRowId+'"] [data-mapping-column="7"] input';
  await input(client,sourcePrice,'4200');
  await expr(client,'window.__presetTest.snapshot().draft.rows[0].outPrice===4200','source work-copy price edited');
  const afterSourceEdit=await dataSnapshot();
  await visibleClick('[data-table-view="input"]');
  await expr(client,'!document.querySelector("#voucherInputTable").hidden','input after source edit');
  assert.equal(await dataSnapshot(),afterSourceEdit,'switch must not revert a source work-copy edit');
  assert.equal(await evaluate(client,'window.__presetTest.snapshot().draft.rows[0].unitPrice'),3100);
  assert.equal(await evaluate(client,'JSON.stringify(window.__presetTest.snapshot().draft.inputMapping.sourceMatrix)'),JSON.stringify(snapshot.draft.inputMapping.sourceMatrix),'original evidence remains immutable');
  await visibleClick('[data-table-view="source"]');
  await click(client,'#sourcePreparationApply');
  assert.equal(await evaluate(client,'document.querySelector("#tableScroll").dataset.tableView'),'source','mapping apply does not change selected view');
  await click(client,'#inputTemplateReloadButton');
  await expr(client,'["READY","EMPTY"].includes(window.__presetTest.snapshot().templatesStatus)','template reload completed',60000);
  assert.equal(await evaluate(client,'document.querySelector("#tableScroll").dataset.tableView'),'source','template reload preserves selected source view');
  assert.equal(await evaluate(client,'window.__presetTest.snapshot().draft.rows[0].unitPrice'),3100,'template reload retains work-copy edits');
  assert.equal(await evaluate(client,'window.__presetTest.snapshot().draft.rows[0].outPrice'),4200);
  await visibleClick('[data-table-view="input"]');
  await expr(client,'!document.querySelector("#voucherInputTable").hidden','return to input for preset regression');

  await click(client,'#sourcePreparationApply');
  await expr(client,'!document.querySelector("#sourcePreparationApply").disabled','apply unchanged preset');
  const priorSource=JSON.stringify(snapshot.draft.inputMapping.sourceMatrix);
  await evaluate(client,'window.__presetTest.manager()');
  await expr(client,'Boolean(document.querySelector("[data-builtin-template]"))','built-in in template manager');
  await click(client,'.field-mapping-dialog[open] [data-close]');
  // Customize one reference column; saving creates a user override, never edits the built-in.
  await evaluate(client,'(()=>{const s=document.querySelectorAll("#sourcePreparationList select")[7];s.value="__UNMAPPED__";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await click(client,'#sourcePreparationApply');
  await expr(client,'window.__presetTest.snapshot().draft.inputMapping.mappings[7].state==="UNMAPPED"','explicit exclusion',60000);
  await evaluate(client,'window.__presetTest.saveTemplate()');
  await expr(client,'window.__presetTest.snapshot().templates.length===1','custom override saved',60000);
  snapshot=await evaluate(client,'window.__presetTest.snapshot()');
  assert.notEqual(snapshot.templates[0].templateId,'SMARTINPUT_ESTIMATE_REPORT_V1');
  assert.equal(JSON.stringify(snapshot.draft.inputMapping.sourceMatrix),priorSource);
  await evaluate(client,'window.__presetTest.upload('+JSON.stringify(matrix)+')');
  await expr(client,'window.__presetTest.snapshot().draft.inputMapping.mappings[7].state==="UNMAPPED"','saved override wins',60000);
  assert.equal((await evaluate(client,'window.__presetTest.snapshot().draft.rows.length')),273);
  assert.deepEqual(exceptions,[]); assert.deepEqual(writes,[],'No production or master writes');
  console.log('PASS browser: actual XLSX 273 rows/24 columns, visible source-input round trips, bidirectional edits preserved, original evidence immutable, template reload and mapping apply keep selected view, custom template save/reupload, no HTTP writes.');
} catch(error) {
  console.error('BROWSER FAILURE',error.stack);
  if(client) console.error('BROWSER DIAGNOSTIC',JSON.stringify(await evaluate(client,'(()=>{const s=window.__presetTest?.snapshot();return {ready:s?.ready,mode:s?.mode,rowCount:s?.draft.rows.length,firstRow:s?.draft.rows[0],mappings:s?.draft.inputMapping?.mappings,preparation:document.querySelector("#sourcePreparationMapping")?.innerText,headers:document.querySelectorAll("#mappingTableHeaders th").length};})()').catch(()=>null)));
  throw error;
} finally { client?.close(); browser?.kill(); server.close(); rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
