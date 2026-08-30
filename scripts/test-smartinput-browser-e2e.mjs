#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const logo of ['logo-light.png', 'logo-dark.png']) {
  const bytes = readFileSync(join(root, 'nexus', 'assets', 'brand', 'apps', 'smart-input', logo));
  assert.equal(bytes[25], 6, `${logo} must keep an RGBA alpha channel`);
}
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-0a-e2e-'));
const screenshotDir = resolve(process.env.SMARTINPUT_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-0a-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
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
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
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
const click = (client, selector) => evaluate(client, `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
};

let browser;
let client;
try {
  const address = await listen();
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), 'browser debugging port');
  const [debugPort] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  const exceptions = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/fixture.html` });
  await loaded;
  await evaluate(client, `localStorage.setItem('merchMaster_v870', JSON.stringify([{productId:'P-MASTER-1',itemCode:'MASTER-1',itemName:'마스터 사과',specification:'10kg',finalUnit:'BOX',outPrice:3200,status:'ACTIVE'}]));true`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  try {
    await expr(client, `Boolean(document.querySelector('.nexus-ui-header'))&&Boolean(document.querySelector('#inputRows tr'))`, 'restored SmartInput shell');
  } catch (error) {
    const diagnostic = await evaluate(client, `({title:document.title,body:document.body?.innerText?.slice(0,800),rows:document.querySelectorAll('#inputRows tr').length,header:Boolean(document.querySelector('.nexus-ui-header')),scripts:[...document.scripts].map(script=>script.src),html:document.documentElement.outerHTML.slice(0,500)})`);
    throw new Error(`${error.message} · ${JSON.stringify(diagnostic)} · ${exceptions.join(' | ')}`);
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const metrics = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {title:document.title,global:q('.nexus-ui-header'),app:q('.app-bar'),parser:q('.parser-card'),resizer:q('#photoResizer'),workbench:q('.workbench'),related:q('.related-panel'),columns:getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns};})()`);
  console.log('SmartInput desktop metrics', metrics);
  assert.equal(metrics.title, '스마트입력 - NEXUS');
  assert.ok(metrics.parser.width >= 330 && metrics.workbench.width > metrics.parser.width, 'three-panel workspace must preserve parser and larger workbench');
  assert.ok(metrics.resizer.width > 0 && metrics.related.width >= 220, 'parser resizer and right connected-app panel must be visible');
  assert.ok(metrics.app.height >= 55 && metrics.app.height <= 58, 'desktop app header must follow the 56px common AppHeader contract');
  const visualZones = await evaluate(client, `(() => {const search=document.querySelector('#inputRows .product-search-cell');const excel=search?.nextElementSibling;const logo=document.querySelector('.brand__logo--light');const brand=document.querySelector('.brand').getBoundingClientRect();const appInner=document.querySelector('.app-bar__inner').getBoundingClientRect();return {removeCell:Boolean(document.querySelector('#inputRows [data-remove-row]')),searchBackground:getComputedStyle(search).backgroundColor,excelBackground:getComputedStyle(excel).backgroundColor,searchDivider:getComputedStyle(search).borderRightWidth,logoComplete:logo?.complete,logoWidth:logo?.naturalWidth,brandHeight:brand.height,brandLeftGap:Math.abs(appInner.left-brand.left),headerHasReferenceCounts:/상품\s[\d,]+건\s*·\s*거래처\s[\d,]+건/.test(document.querySelector('.app-bar').innerText),coachmark:document.querySelector('.reference-overview__coachmark')?.textContent.trim(),referenceBeforeSettings:document.querySelector('#referenceOverview')?.nextElementSibling?.id==='settingsButton',legacyButtons:[...document.querySelectorAll('#draftListButton,#saveDraftButton,#catalogSaveButton')].length,completeText:document.querySelector('#completeButton')?.textContent.trim(),completeInFooter:Boolean(document.querySelector('.voucher-footer-actions>#completeButton'))};})()`);
  assert.equal(visualZones.removeCell, false, 'Excel rows must not render an in-cell × delete control');
  assert.notEqual(visualZones.searchBackground, visualZones.excelBackground, 'product lookup and Excel entry cells must be visually distinct');
  assert.equal(visualZones.searchDivider, '2px', 'product lookup must have an explicit boundary before the Excel grid');
  assert.equal(visualZones.logoComplete, true, 'transparent Smart X Input logo must load');
  assert.ok(visualZones.logoWidth >= 2000 && visualZones.brandHeight <= 40, 'header logo must use the supplied high-resolution asset inside the compact app identity slot');
  assert.ok(visualZones.brandLeftGap <= 1, 'SmartInput logo must occupy the far-left edge of the app header');
  assert.equal(visualZones.headerHasReferenceCounts, false, 'product and customer counts must not remain as an app-header annotation');
  assert.match(visualZones.coachmark, /상품·거래처 기준정보/, 'reference counts must move into the reference coachmark panel');
  assert.equal(visualZones.referenceBeforeSettings, true, 'reference status must sit immediately before settings');
  assert.equal(visualZones.legacyButtons, 0, 'manual draft-list and duplicate save controls must be removed');
  assert.equal(visualZones.completeText, '완료');
  assert.equal(visualZones.completeInFooter, true, 'the all-voucher completion action must be in the table footer');
  const lightShot = await capture(client, 'smartinput-0a-1920-light.png');
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'dark theme');
  const darkShot = await capture(client, 'smartinput-0a-1920-dark.png');

  const beforeResize = await evaluate(client, `document.querySelector('.parser-card').getBoundingClientRect().width`);
  await evaluate(client, `(() => {const h=document.querySelector('#photoResizer');h.focus();for(let index=0;index<7;index+=1)h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  const afterResize = await expr(client, `Math.abs(document.querySelector('.parser-card').getBoundingClientRect().width-${beforeResize})>20&&document.querySelector('.parser-card').getBoundingClientRect().width`, 'parser resize');
  assert.ok(afterResize > beforeResize, 'dragging the parser resizer must expand the source pane');
  await click(client, '#relatedCollapseButton');
  assert.equal(await evaluate(client, `document.querySelector('.related-panel').classList.contains('is-open')`), true, 'right panel must expand and collapse');

  await input(client, '#sourceTextInput', '테스트 거래처\n사과 2박스\n배 3개');
  await click(client, '#analyzeButton');
  await expr(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length===2`, 'pure text parsing rows');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('#inputRows [data-field="quantity"]')].map(input=>Number(input.value))`), [2, 3]);
  assert.match(await evaluate(client, `document.querySelector('#sourceTextInput').value`), /사과 2박스/, 'source text must remain visible during analysis');

  const firstQuantity = '#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]';
  await evaluate(client, `(() => {const target=document.querySelector(${JSON.stringify(firstQuantity)});const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?${JSON.stringify('수량\t단위\t단가\n7\tEA\t1500')}:''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelector(${JSON.stringify(firstQuantity)}).value==='7'&&!document.querySelector('#undoGridPasteButton').disabled`, 'grid paste');
  await click(client, '#undoGridPasteButton');
  assert.equal(await evaluate(client, `document.querySelector(${JSON.stringify(firstQuantity)}).value`), '2', 'grid paste undo must restore the prior row');
  await click(client, '#inputRows [data-select-row]');
  assert.equal(await evaluate(client, `!document.querySelector('#deleteSelectedRows').disabled`), true, 'row selection must enable bulk delete');
  await evaluate(client, `(() => {const current=document.querySelector(${JSON.stringify(firstQuantity)});current.focus();current.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `document.activeElement?.dataset?.field`), 'unit', 'keyboard navigation must move to the adjacent cell');
  const handleWidthBefore = await evaluate(client, `document.querySelector('col[data-column="itemName"]').getBoundingClientRect().width`);
  await evaluate(client, `(() => {const handle=document.querySelector('.column-resize-handle[data-resize-column="itemName"]');handle.focus();handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  const handleWidthAfter = await expr(client, `document.querySelector('col[data-column="itemName"]').getBoundingClientRect().width>${handleWidthBefore}&&document.querySelector('col[data-column="itemName"]').getBoundingClientRect().width`, 'keyboard column resize');
  assert.ok(handleWidthAfter > handleWidthBefore);

  await expr(client, `!document.querySelector('#restoreAutosaveButton').disabled`, 'latest autosave ready');
  const autosave = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',4);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('autosave','readonly');const get=tx.objectStore('autosave').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result.map(record=>({key:record.key,schemaVersion:record.schemaVersion,sourceText:record.draft?.modes?.order?.sourceText})));db.close();};};})`);
  assert.equal(autosave.length, 1, 'autosave DB must overwrite one current record instead of building a list');
  assert.equal(autosave[0].key, 'current');
  assert.equal(autosave[0].schemaVersion, 'ONEAPP_SMART_INPUT_AUTOSAVE_V1');
  assert.match(autosave[0].sourceText, /사과 2박스/);
  await evaluate(client, `(() => {window.confirm=()=>true;document.querySelector('#sourceTextInput').value='화면에서만 바뀐 값';return true;})()`);
  await click(client, '#restoreAutosaveButton');
  await expr(client, `document.querySelector('#sourceTextInput').value.includes('사과 2박스')`, 'explicit latest autosave restore');

  await click(client, '#resetDraftButton');
  await expr(client, `document.querySelector('#inputRows tr[data-default-row="true"]')`, 'reset before recovery');
  await click(client, '#restoreAutosaveButton');
  await expr(client, `document.querySelector('#sourceTextInput').value.includes('사과 2박스')`, 'reset round-trip recovery');
  await evaluate(client, `window.confirm=()=>true;document.querySelector('#resetDraftButton').click();true`);
  await expr(client, `document.querySelector('#inputRows tr[data-default-row="true"]')`, 'empty default row');
  await input(client, '#inputRows tr[data-default-row="true"] [data-product-search]', '마스터 사과');
  await evaluate(client, `document.querySelector('#inputRows [data-product-search]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await expr(client, `document.querySelector('#inputRows [data-field="itemCode"]')?.value==='MASTER-1'`, 'public master product selection');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="specification"]').value`), '10kg');
  assert.equal(await evaluate(client, `document.querySelector('#productReferenceStatus').textContent`), 'READY', 'product Snapshot must expose READY independently');
  assert.equal(await evaluate(client, `document.querySelector('#productReferenceCount').textContent`), '1건');
  assert.match(await evaluate(client, `document.querySelector('#productReferenceSource').textContent`), /상품관리 Snapshot Adapter/);
  await click(client, '#customerSearchButton');
  await expr(client, `document.querySelector('.smart-customer-dialog .smart-dialog__empty')?.textContent.includes('등록 거래처 0건')`, 'confirmed empty customer state');
  await input(client, '.smart-customer-dialog input[type="search"]', '조회없는거래처');
  await expr(client, `document.querySelector('.smart-customer-dialog .smart-dialog__empty')?.textContent.includes('검색 결과 0건')`, 'zero customer search result');
  assert.equal(await evaluate(client, `document.querySelector('#customerReferenceStatus').textContent`), 'EMPTY', 'customer EMPTY must remain distinct from ERROR');
  await click(client, '.smart-customer-dialog [data-close]');

  await input(client, '#inputRows [data-field="specification"]', '관리자 규격');
  await click(client, '#inputRows [data-select-row]');
  await evaluate(client, `window.__referenceRowMutations=0;window.__referenceRowObserver=new MutationObserver(records=>window.__referenceRowMutations+=records.length);window.__referenceRowObserver.observe(document.querySelector('#inputRows'),{childList:true,subtree:true});localStorage.setItem('merchMaster_v870',JSON.stringify([{productId:'P-MASTER-1',itemCode:'MASTER-1',itemName:'마스터 청사과',specification:'20kg',finalUnit:'BOX',outPrice:3300,status:'ACTIVE'}]));localStorage.setItem('merchMaster_revision_v870','2');true`);
  await click(client, '#productReferenceReload');
  await expr(client, `document.querySelector('#productReferenceStatus').textContent==='STALE'&&!document.querySelector('#referencePendingApply').hidden`, 'new product revision pending');
  assert.equal(await evaluate(client, `window.__referenceRowMutations`), 0, 'scoped product reload must not rerender the work table');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="itemName"]').value`), '마스터 사과', 'pending revision must not change the current work');
  await evaluate(client, `window.__referenceConfirm='';window.confirm=message=>{window.__referenceConfirm=message;return true};true`);
  await click(client, '#referencePendingApply');
  await expr(client, `document.querySelector('#productReferenceStatus').textContent==='READY'&&document.querySelector('#inputRows [data-field="itemName"]').value==='마스터 청사과'`, 'explicit current-work reference apply');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="specification"]').value`), '관리자 규격', 'explicit reference apply must preserve admin-edited fields');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-select-row]').checked`), true, 'explicit reference apply must preserve row selection');
  assert.match(await evaluate(client, `window.__referenceConfirm`), /변경 1/);

  await evaluate(client, `localStorage.setItem('merchMaster_v870',JSON.stringify([{productId:'P-MASTER-1',itemCode:'MASTER-1',itemName:'마스터 최신 사과',secondaryName:'최신사과',approvedAliases:['새별칭'],specification:'30kg',finalUnit:'BOX',outPrice:3400,status:'ACTIVE'}]));localStorage.setItem('merchMaster_revision_v870','3');true`);
  await click(client, '#productReferenceReload');
  await expr(client, `document.querySelector('#productReferenceStatus').textContent==='STALE'&&!document.querySelector('#referencePendingApply').hidden`, 'next-work product revision pending');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="itemName"]').value`), '마스터 청사과', 'next-work default must preserve current values');
  await click(client, '#resetDraftButton');
  await expr(client, `document.querySelector('#productReferenceRevision').textContent==='3'&&document.querySelector('#inputRows tr[data-default-row="true"]')`, 'pending revision promoted for next work');
  await input(client, '#inputRows tr[data-default-row="true"] [data-product-search]', '등록되지않은상품XYZ');
  await evaluate(client, `document.querySelector('#inputRows [data-product-search]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await expr(client, `document.querySelector('#inputRows .row-owner-register')?.textContent==='상품관리에서 등록'`, 'missing product owner path');
  const missingBefore = await evaluate(client, `({rows:document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length,query:document.querySelector('#inputRows [data-product-search]').value,master:localStorage.getItem('merchMaster_v870'),href:document.querySelector('#inputRows .row-owner-register').getAttribute('href')})`);
  assert.equal(missingBefore.query, '등록되지않은상품XYZ');
  assert.equal(missingBefore.href, '../Master.html');
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('MerchOpsDB',2);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('store'))db.createObjectStore('store');if(!db.objectStoreNames.contains('master_products'))db.createObjectStore('master_products',{keyPath:'코드'});};request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve(true);};})`);
  await evaluate(client, `(() => {const link=document.querySelector('#inputRows .row-owner-register');link.addEventListener('click',event=>event.preventDefault(),{capture:true,once:true});link.click();return true;})()`);
  const requestStatus = await expr(client, `document.querySelector('#inputRows .row-owner-register')?.dataset.requestStatus`, 'product registration request result');
  assert.equal(requestStatus, 'PENDING', `product change request status: ${requestStatus}`);
  await expr(client, `(async()=>{const module=await import('/reference-data/product-change-request-adapter.js');const result=await module.productMasterChangeRequestAdapter.listChangeRequests();return result.requests.some(entry=>entry.request?.operation==='CREATE'&&entry.request?.source?.appId==='smart-input')})()`, 'product registration change request');
  await evaluate(client, `window.open(document.querySelector('#inputRows .row-owner-register').href,'_blank','noopener');true`);
  assert.equal(await evaluate(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length`), missingBefore.rows, 'owner-app round trip must preserve the current row');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-product-search]').value`), missingBefore.query, 'owner-app round trip must preserve the missing input');
  assert.equal(await evaluate(client, `localStorage.getItem('merchMaster_v870')`), missingBefore.master, 'SmartInput must not directly write the product master');

  const orderResult = await evaluate(client, `(async()=>{const adapter=await import('/smartinput/legacy-integration-adapter.js');const saved=await adapter.createOrder({orderDate:'2026-08-29',deliveryExpectedDate:'2026-08-30',customerId:'E2E-CUSTOMER',customerName:'격리 검증 거래처',warehouseCode:'88',warehouseName:'격리 검증 창고',sourceType:'SMART_INPUT_E2E',sourceId:'ISOLATED_PROFILE',sourceMessageKey:'SMARTINPUT-E2E-ONE',items:[{itemCode:'MASTER-1',itemName:'마스터 사과',rawText:'마스터 사과 1BOX',rawQuantity:1,rawUnit:'BOX',finalQuantity:1,finalUnit:'BOX',price:3200,matchStatus:'MATCHED'}]});const intake=await import('/orderq/order-intake-engine.js');const operations=await import('/orderq/order-operations-repository.js');const orders=await intake.listOrders();const snapshot=await operations.getOperationsSnapshot();const warehouses=await adapter.loadWarehouseCatalog();return {orderId:saved.order.orderId,listed:orders.some(order=>order.orderId===saved.order.orderId),operational:snapshot.bundles.some(bundle=>bundle.order.orderId===saved.order.orderId),warehouse:warehouses.warehouses.some(row=>row.warehouseCode==='88')};})()`);
  assert.equal(orderResult.listed, true, 'current ORDER Q listOrders must read the SmartInput-created order');
  assert.equal(orderResult.operational, true, 'current operations snapshot must read the SmartInput-created order');
  assert.equal(orderResult.warehouse, true, 'current warehouse catalog must expose the writer-resolved warehouse');

  const documentId = await evaluate(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.order.documentId`);
  await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js');await store.saveSourceImage({documentId:${JSON.stringify(documentId)},mode:'order',sourceImageId:'E2E-SOURCE-IMAGE',fileName:'원본.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',notice:'저장 원본'});const draft=JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1'));draft.modes.order.activeMethod='photo';draft.futureRoot='KEEP-UNKNOWN';draft.modes.order.futureMode='KEEP-MODE';localStorage.setItem('oneapp.smartinput.draft.v1',JSON.stringify(draft));return true;})()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: false });
  await loaded;
  await expr(client, `document.querySelector('#photoPreview')?.dataset.sourceImageId==='E2E-SOURCE-IMAGE'&&!document.querySelector('#photoViewer').hidden`, 'source image reload');
  assert.equal(await evaluate(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).futureRoot`), 'KEEP-UNKNOWN', 'unknown draft fields must survive reload');
  const photoShot = await capture(client, 'smartinput-0a-photo-reload.png');

  for (const mode of ['purchase', 'sale']) {
    await click(client, `[data-mode="${mode}"]`);
    await click(client, '#addRowButton');
    await input(client, '#inputRows [data-field="itemName"]', `${mode} 초안 상품`);
    const rowsBefore = await evaluate(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length`);
    await click(client, '#completeButton');
    await expr(client, `!document.querySelector('#toast').hidden`, `${mode} unavailable feedback`);
    const feedback = await evaluate(client, `document.querySelector('#toast').textContent`);
    assert.match(feedback, mode === 'purchase' ? /구매 원장 연결/ : /판매 원장 연결/);
    assert.equal(await evaluate(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length`), rowsBefore, `${mode} unavailable must preserve draft rows`);
  }

  await click(client, '[data-mode="estimate"]');
  await click(client, '#addRowButton');
  await input(client, '#inputRows [data-field="itemCode"]', 'EST-1');
  await input(client, '#inputRows [data-field="itemName"]', '견적 상품');
  await input(client, '#inputRows [data-field="quantity"]', '2');
  await input(client, '#inputRows [data-field="unitPrice"]', '1500');
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent.trim()`), '완료');
  await click(client, '#completeButton');
  await expr(client, `Boolean(document.querySelector('[data-estimate-name]'))`, 'estimate save dialog');
  await input(client, '[data-estimate-name]', '격리 견적');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelector('#catalogPickerButton').textContent.includes('격리 견적')`, 'estimate persisted');
  await click(client, '#completeButton');
  assert.equal(await evaluate(client, `Boolean(document.querySelector('[data-estimate-name]'))`), false, 'a named estimate must complete without reopening the name dialog');
  await evaluate(client, `window.XLSX={utils:{book_new:()=>({}),aoa_to_sheet:data=>data,book_append_sheet:()=>{}},writeFile:(book,name)=>window.__estimateExportName=name};true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(window.__estimateExportName)`, 'estimate export');
  assert.match(await evaluate(client, `window.__estimateExportName`), /견적F8/);
  await click(client, '#catalogPickerButton');
  await expr(client, `Boolean(document.querySelector('[data-output-estimate]'))`, 'estimate picker');
  await evaluate(client, `(() => {const checkbox=document.querySelector('[data-output-estimate]');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `!document.querySelector('#catalogComposeButton').disabled`), true, 'saved estimates must be selectable for compose');
  await click(client, '#catalogComposeButton');
  await expr(client, `document.querySelector('#inputRows [data-field="itemCode"]')?.value==='EST-1'`, 'estimate compose');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(200);
  const mobile = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};const tabs=[...document.querySelectorAll('.mode-tab')].map(tab=>q('.mode-tab[data-mode="'+tab.dataset.mode+'"]'));return {scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,header:q('.nexus-ui-header'),app:q('.app-bar'),appInner:q('.app-bar__inner'),brand:q('.brand'),tabs,actions:q('.app-bar__actions'),parser:q('.parser-card'),workbench:q('.workbench')};})()`);
  assert.ok(mobile.header.height >= 100 && mobile.parser.width <= 390 && mobile.workbench.width <= 390, 'mobile header and stacked workspace must fit viewport');
  assert.ok(mobile.app.height <= 170 && mobile.brand.height <= 36, 'mobile app header and logo must remain compact');
  assert.ok(Math.abs(mobile.appInner.x - mobile.brand.x) <= 1, 'mobile SmartInput logo must remain at the app-header far left');
  assert.equal(new Set(mobile.tabs.map(tab => Math.round(tab.y))).size, 1, 'all four voucher tabs must remain on one mobile row');
  await evaluate(client, `document.querySelector('#referenceOverview > summary').focus();true`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const mobileReference = await expr(client, `(() => {const overview=document.querySelector('#referenceOverview');const panel=document.querySelector('.reference-overview__panel').getBoundingClientRect();const globalHeader=document.querySelector('.nexus-ui-header').getBoundingClientRect();return overview.open&&overview.querySelector('summary').getAttribute('aria-expanded')==='true'&&panel.top>=globalHeader.bottom&&panel.right<=innerWidth&&panel.bottom<=innerHeight;})()`, 'mobile reference keyboard panel');
  assert.equal(mobileReference, true, 'mobile reference panel must open by keyboard below the common header');
  const mobileReferenceShot = await capture(client, 'smartinput-reference-mobile.png');
  await evaluate(client, `document.querySelector('#referenceOverview > summary').focus();true`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate(client, `!document.querySelector('#referenceOverview').open&&document.activeElement===document.querySelector('#referenceOverview > summary')`), true, 'Enter must close the reference panel without losing focus');
  const mobileShot = await capture(client, 'smartinput-0a-mobile.png');

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ orderId: orderResult.orderId, screenshots: [lightShot, darkShot, photoShot, mobileReferenceShot, mobileShot], metrics: { parserWidth: metrics.parser.width, workbenchWidth: metrics.workbench.width, resizedParserWidth: afterResize, mobileHeaderHeight: mobile.header.height } }, null, 2));
  console.log('SmartInput 0a browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
