#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-mapping-e2e-'));
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
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
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
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  await expr(client, `Boolean(document.querySelector('#inputRows tr'))`, 'SmartInput shell');
  await evaluate(client, `(() => {window.__sourceFilePickerOpened=false;document.querySelector('#fileInput').click=()=>{window.__sourceFilePickerOpened=true;};return true;})()`);
  await click(client, '#sourceFileButton');
  assert.equal(await evaluate(client, `window.__sourceFilePickerOpened`), true, 'the visible Excel file button must open the existing safe file input');
  await wait(500);
  await evaluate(client, String.raw`(async()=>{const mapper=await import('/smartinput/input-template-mapper.js');const draft=window.SMART_INPUT_CONTRACT.createDraft({activeMode:'order'});const matrix=[['2026 행사 발주','','',''],['품목코드','품목명','수량','원본 메모'],['001','취나물','0',''],['002','시금치','-1.5','확인']];const targetDefinitions=[{id:'voucher.order.line.productCode',label:'품목코드',scope:'voucher',projectionFieldId:'itemCode',valueType:'TEXT'},{id:'voucher.order.line.productName',label:'품목명',scope:'voucher',projectionFieldId:'itemName',valueType:'TEXT'},{id:'voucher.order.line.quantity',label:'주문수량',aliases:['수량'],scope:'voucher',projectionFieldId:'quantity',valueType:'NUMBER'},{id:'voucher.order.line.memo',label:'적요',aliases:['메모'],scope:'voucher',projectionFieldId:'memo',valueType:'TEXT'}];const session=mapper.createMappingSession({matrix,headerRowIndex:1,targetDefinitions,fileName:'행사발주.xlsx',sheetName:'원본',companyId:'ONEAPP',voucherMode:'order'});session.batchId='SIBATCH-MAPPING-E2E';draft.modes.order.inputMapping=session;draft.modes.order.rows=mapper.projectMappedRows(session,targetDefinitions).map(row=>window.SMART_INPUT_CONTRACT.normalizeRow({...row,batchId:session.batchId},session.batchId));draft.modes.order.activeMethod='excel';draft.modes.order.sourceText=matrix.map(row=>row.join('\t')).join('\n');localStorage.setItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY,JSON.stringify(draft));return true;})()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expr(client, `!document.querySelector('#mappingWorktable').hidden&&!document.querySelector('#sourceSheetView').hidden`, 'mapping source and worktable');
  const initial = await evaluate(client, `(() => ({sourceRows:document.querySelectorAll('#sourceSheetRows tr').length,sourceHeader:[...document.querySelectorAll('#sourceSheetRows tr.is-header-row td')].map(cell=>cell.textContent),workingRows:document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length,headers:[...document.querySelectorAll('#mappingTableHeaders [data-open-field-mapping] strong')].map(node=>node.textContent),states:[...document.querySelectorAll('#mappingTableHeaders [data-mapping-state]')].map(node=>node.dataset.mappingState),saveDisabled:document.querySelector('#completeButton').disabled,saveTitle:document.querySelector('#completeButton').title,sourceBlank:document.querySelectorAll('#sourceSheetRows tr')[2].querySelectorAll('td')[3].textContent}))()`);
  assert.equal(initial.sourceRows, 4);
  assert.deepEqual(initial.sourceHeader, ['품목코드', '품목명', '수량', '원본 메모']);
  assert.deepEqual(initial.headers, ['품목코드', '품목명', '수량', '원본 메모']);
  assert.deepEqual(initial.states, ['RECOMMENDED', 'RECOMMENDED', 'RECOMMENDED', 'UNDECIDED']);
  assert.equal(initial.sourceBlank, '', 'blank source cells must remain visibly blank');
  assert.equal(initial.saveDisabled, true);
  assert.match(initial.saveTitle, /입력 양식/);
  const initialDraftBytes = await evaluate(client, `localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)`);
  const positionalSignature = await evaluate(client, `JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.inputMapping.signature`);
  assert.deepEqual(await evaluate(client, `(() => ({hidden:document.querySelector('#tableViewSwitch').hidden,sourcePressed:document.querySelector('[data-table-view="source"]').getAttribute('aria-pressed'),inputPressed:document.querySelector('[data-table-view="input"]').getAttribute('aria-pressed'),hint:document.querySelector('#tableViewHint').textContent}))()`), {
    hidden: false,
    sourcePressed: 'true',
    inputPressed: 'false',
    hint: '원본 열 배치 · 작업본 편집(증적 유지)'
  }, 'new source intake must default to the explicit source-column view');
  await click(client, '[data-table-view="input"]');
  await expr(client, `!document.querySelector('#voucherInputTable').hidden&&document.querySelector('#mappingWorktable').hidden`, 'configured input-column view');
  const inputColumnView = await evaluate(client, `(() => ({headers:[...document.querySelectorAll('#voucherInputTable thead th[data-column]:not(.is-column-hidden)')].map(node=>node.textContent.trim()),rows:[...document.querySelectorAll('#inputRows tr:not([data-default-row])')].map(row=>({id:row.dataset.rowId,quantity:row.querySelector('[data-field="quantity"]')?.value}))}))()`);
  assert.ok(inputColumnView.headers.indexOf('규격') < inputColumnView.headers.indexOf('수량'),
    'input view must use configured SmartInput order even when the source puts quantity before specification');
  assert.deepEqual(inputColumnView.rows.map(row => row.quantity), ['0', '-1.5'], 'input view must retain zero and negative values');
  await evaluate(client, `(() => {const button=document.querySelector('[data-table-view="input"]');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));return true;})()`);
  await expr(client, `!document.querySelector('#mappingWorktable').hidden&&document.activeElement===document.querySelector('[data-table-view="source"]')`, 'keyboard source-view selection');
  await evaluate(client, `(() => {const button=document.querySelector('[data-table-view="source"]');button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  await expr(client, `!document.querySelector('#voucherInputTable').hidden&&document.activeElement===document.querySelector('[data-table-view="input"]')`, 'keyboard input-view selection');
  await click(client, '[data-table-view="source"]');
  assert.equal(await evaluate(client, `localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)`), initialDraftBytes,
    'source/input round-trip must be byte-neutral for the persisted draft payload');
  assert.equal(await evaluate(client, `JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.inputMapping.signature`), positionalSignature,
    'table view switching must not recalculate the positional signature');

  for (const [column, fieldId] of [[0, 'voucher.order.line.productCode'], [1, 'voucher.order.line.productName'], [2, 'voucher.order.line.quantity']]) {
    await click(client, `[data-open-field-mapping="${column}"]`);
    await expr(client, `Boolean(document.querySelector('.field-mapping-dialog[open] [data-mapping-target="${fieldId}"]'))`, `review mapping column ${column + 1}`);
    await click(client, `.field-mapping-dialog [data-mapping-target="${fieldId}"]`);
  }

  await click(client, '[data-open-field-mapping="3"]');
  await expr(client, `Boolean(document.querySelector('.field-mapping-dialog[open] [data-unmap]'))`, 'field mapping modal');
  await click(client, '.field-mapping-dialog [data-unmap]');
  await expr(client, `document.querySelector('[data-mapping-column="3"]').dataset.mappingState==='UNMAPPED'`, 'explicit unmapped decision');
  const reviewedMappings = await evaluate(client, `JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.inputMapping.mappings.map(({state,targetFieldId,reviewed})=>({state,targetFieldId,reviewed}))`);
  assert.deepEqual(reviewedMappings.map(mapping => [mapping.state, mapping.reviewed]), [
    ['MAPPED', true], ['MAPPED', true], ['MAPPED', true], ['UNMAPPED', true]
  ], 'every source column must be explicitly reviewed before template save');
  assert.equal(await evaluate(client, `document.querySelector('#inputMappingStatus').dataset.status`), 'NEW_TEMPLATE');
  assert.doesNotMatch(await evaluate(client, `document.querySelector('#inputMappingStatusSummary').textContent`), /조회 오류/);
  await expr(client, `['READY','EMPTY'].includes(document.querySelector('#inputMappingStatus').dataset.templateStoreStatus)`, 'input-template store readiness');
  await click(client, '#inputTemplateSaveButton');
  await wait(250);
  assert.equal(await evaluate(client, `document.querySelector('#toast').hidden?document.querySelector('#toast').textContent:''`), '', 'template save must not be blocked after every column was reviewed');
  const saveDialogDiagnostic = await evaluate(client, `({open:Boolean(document.querySelector('dialog[open] input[name="templateName"]')),dialogs:[...document.querySelectorAll('dialog')].map(dialog=>({open:dialog.open,text:dialog.textContent.slice(0,80)})),buttonHidden:document.querySelector('#inputTemplateSaveButton').hidden,buttonDisabled:document.querySelector('#inputTemplateSaveButton').disabled})`);
  assert.deepEqual(exceptions, [], `runtime exceptions before template save: ${exceptions.join('\n')}`);
  assert.equal(saveDialogDiagnostic.open, true, `input-template save dialog diagnostic: ${JSON.stringify(saveDialogDiagnostic)}`);
  await input(client, 'dialog[open] input[name="templateName"]', '행사발주 공식 양식');
  await click(client, 'dialog[open] [data-save]');
  await expr(client, `document.querySelector('#inputMappingStatus').dataset.status==='TEMPLATE_APPLIED'&&!document.querySelector('#completeButton').disabled`, 'saved template application');
  const persistedTemplate = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('inputTemplatesV2','readonly');const get=tx.objectStore('inputTemplatesV2').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result?.[0]||null);db.close();};};})`);
  assert.equal(persistedTemplate.templateName, '행사발주 공식 양식');
  assert.deepEqual(persistedTemplate.headers, ['품목코드', '품목명', '수량', '원본 메모']);
  assert.deepEqual(persistedTemplate.mappings.map(mapping => mapping.state), ['MAPPED', 'MAPPED', 'MAPPED', 'UNMAPPED']);

  await input(client, '[data-mapping-row-id="source-2"] [data-mapping-column="2"] input', '-2.5');
  await wait(900);
  assert.equal(await evaluate(client, `document.querySelectorAll('#sourceSheetRows tr')[2].querySelectorAll('td')[2].textContent`), '0', 'worktable editing must not mutate source display');
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-row-id="source-2"] [data-mapping-column="2"] input').value`), '-2.5');

  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expr(client, `document.querySelector('#inputMappingStatus').dataset.status==='TEMPLATE_APPLIED'&&document.querySelector('[data-mapping-row-id="source-2"] [data-mapping-column="2"] input')?.value==='-2.5'`, 'mapping edit reload preservation', 30_000);
  assert.equal(await evaluate(client, `document.querySelectorAll('#sourceSheetRows tr')[2].querySelectorAll('td')[2].textContent`), '0');
  await click(client, '[data-table-view="input"]');
  await expr(client, `document.querySelector('[data-row-id="source-2"] [data-field="quantity"]')?.value==='-2.5'`, 'mapped edit in configured input view');
  await input(client, '[data-row-id="source-2"] [data-field="quantity"]', '-3.25');
  await click(client, '[data-table-view="source"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-row-id="source-2"] [data-mapping-column="2"] input').value`), '-3.25',
    'editing the configured input view must update the same mapped working cell');
  assert.equal(await evaluate(client, `document.querySelectorAll('#sourceSheetRows tr')[2].querySelectorAll('td')[2].textContent`), '0',
    'input-view editing must keep the immutable source evidence unchanged');
  await click(client, '[data-table-view="input"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-row-id="source-2"] [data-field="quantity"]')?.value`), '-3.25',
    'the explicit view choice and edit must survive ordinary rerenders');
  await click(client, '[data-table-view="source"]');
  assert.equal(await evaluate(client, `JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.inputMapping.signature`), positionalSignature,
    'editing and round-trip rendering must retain the positional signature');

  await click(client, '#settingsButton');
  await expr(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-open-input-template-manager]'))`, 'settings mapping manager path');
  await click(client, '.smart-settings-dialog [data-open-input-template-manager]');
  await expr(client, `document.querySelector('.field-mapping-dialog[open]')?.textContent.includes('행사발주 공식 양식')`, 'template manager list');
  await click(client, '.field-mapping-dialog [data-close]');

  const existingRowBeforePaste = await evaluate(client, `(() => {const row=document.querySelector('[data-mapping-row-id="source-2"]');return [...row.querySelectorAll('input[data-mapping-cell]')].map(input=>input.value);})()`);
  const overwritePasteText = '품목코드\t품목명\t수량\t원본 메모\n009\t\t0\t';
  await evaluate(client, `(() => {const target=document.querySelector('[data-mapping-row-id="source-2"] [data-mapping-column="0"] input');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?${JSON.stringify(overwritePasteText)}:''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelector('[data-mapping-row-id="source-2"] [data-mapping-column="0"] input').value==='009'`, 'existing mapping-row paste');
  assert.deepEqual(await evaluate(client, `(() => {const row=document.querySelector('[data-mapping-row-id="source-2"]');return [...row.querySelectorAll('input[data-mapping-cell]')].map(input=>input.value);})()`),
    ['009', '', '0', ''], 'mapping-worktable paste must retain its existing whole-range overwrite contract, including blank cells');
  await click(client, '#undoGridPasteButton');
  assert.deepEqual(await evaluate(client, `(() => {const row=document.querySelector('[data-mapping-row-id="source-2"]');return [...row.querySelectorAll('input[data-mapping-cell]')].map(input=>input.value);})()`),
    existingRowBeforePaste, 'mapping-worktable paste undo must restore the overwritten row');

  const beforeExactPaste = await evaluate(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length`);
  const exactPasteText = [
    '품목코드\t품목명\t수량\t원본 메모',
    '003\t미나리\t0\t',
    '\t\t\t',
    ' \t\u00a0\t\u200b\t',
    '004\t\t-3\t추가',
    '\t\t\t',
    '',
    ''
  ].join('\n');
  await evaluate(client, `(() => {const target=document.querySelector('[data-mapping-default-row] [data-mapping-column="0"] input');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?${JSON.stringify(exactPasteText)}:''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length===${beforeExactPaste + 2}`, 'exact mapping paste without fake blank rows');
  assert.deepEqual(await evaluate(client, `(() => [...document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])')].slice(-2).map(row=>[...row.querySelectorAll('input[data-mapping-cell]')].map(input=>input.value)))()`), [
    ['003', '미나리', '0', ''],
    ['004', '', '-3', '추가']
  ], 'mapping paste must preserve blank-cell positions, explicit zero, negative values, and trailing blank-row filtering');
  const beforeMismatch = await evaluate(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length`);
  await evaluate(client, String.raw`(() => {const target=document.querySelector('[data-mapping-default-row] [data-mapping-column="0"] input');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'품목코드\t품목명\t수량 오타\t원본 메모\n004\t부추\t2\t':''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  assert.equal(await evaluate(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length`), beforeMismatch, 'mismatched paste must preserve current work rows');
  assert.equal(await evaluate(client, `!document.querySelector('#pendingPasteToSourceButton').hidden`), true);

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const wideSourceShot = await capture(client, 'smartinput-table-toggle-source-1920-light.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const desktopShot = await capture(client, 'smartinput-input-template-mapping-light.png');
  await click(client, '[data-table-view="input"]');
  const desktopInputShot = await capture(client, 'smartinput-table-toggle-input-1440-light.png');
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'mapping dark theme');
  const darkShot = await capture(client, 'smartinput-table-toggle-input-1440-dark.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(client, `document.querySelector('#relatedPanelCloseButton')?.click()`);
  await wait(200);
  const mobileInput = await evaluate(client, `(() => {const scroll=document.querySelector('#tableScroll');const max=Math.max(0,scroll.scrollWidth-scroll.clientWidth);scroll.scrollLeft=Math.min(160,max);return {pageWidth:document.documentElement.scrollWidth,viewportWidth:document.documentElement.clientWidth,voucherVisible:!document.querySelector('#voucherInputTable').hidden,switchWidth:document.querySelector('#tableViewSwitch').getBoundingClientRect().width,maxScrollLeft:max,scrollLeft:scroll.scrollLeft};})()`);
  assert.ok(mobileInput.pageWidth <= mobileInput.viewportWidth && mobileInput.voucherVisible && mobileInput.switchWidth <= 390
    && mobileInput.maxScrollLeft > 0 && mobileInput.scrollLeft > 0,
  'mobile input view must keep the compact switch in bounds and horizontal scrolling inside the table');
  const mobileInputShot = await capture(client, 'smartinput-table-toggle-input-390-dark-scrolled.png');
  await click(client, '[data-table-view="source"]');
  const mobile = await evaluate(client, `(() => ({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,sourceWidth:document.querySelector('#sourceInputPanel').getBoundingClientRect().width,tableWidth:document.querySelector('.grid-card').getBoundingClientRect().width,sourceVisible:!document.querySelector('#sourceSheetView').hidden,mappingVisible:!document.querySelector('#mappingWorktable').hidden,panelClosed:!document.querySelector('#smartInputWorkspace').classList.contains('related-panel-open')}))()`);
  assert.ok(mobile.sourceWidth <= 390 && mobile.tableWidth <= 390 && mobile.sourceVisible && mobile.mappingVisible && mobile.panelClosed,
    'mobile must keep source and mapping table in the stacked workflow after the right panel is closed');
  const mobileShot = await capture(client, 'smartinput-input-template-mapping-mobile.png');

  await evaluate(client, String.raw`(() => {window.__clipboardImagePathUsed=false;const target=document.querySelector('#sourceTextInput');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'품목코드\t품목명\t수량\t원본 메모\n009\t근대\t3\t표 우선\n\t\t\t\n011\t상추\t0\t':'',items:[{kind:'file',type:'image/png',getAsFile:()=>{window.__clipboardImagePathUsed=true;return new File(['image'], 'excel-range.png',{type:'image/png'});}}]}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelector('#inputMappingStatus').dataset.status==='TEMPLATE_APPLIED'`, 'saved official template auto application from clipboard');
  assert.equal(await evaluate(client, `window.__clipboardImagePathUsed`), false, 'tabular clipboard text must take priority over the simultaneous Excel image representation');
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-row-id="source-1"] [data-mapping-column="1"] input')?.value`), '근대');
  assert.deepEqual(await evaluate(client, `({sourceRows:document.querySelectorAll('#sourceSheetRows tr').length,workingRows:document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length,secondValue:document.querySelector('[data-mapping-row-id="source-3"] [data-mapping-column="1"] input')?.value})`),
    { sourceRows: 4, workingRows: 2, secondValue: '상추' },
    'raw source rows must remain intact while completely blank rows do not become working or saved rows');

  await evaluate(client, String.raw`(() => {const target=document.querySelector('#sourceTextInput');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'품목코드\t신규 원본열\n010\t보존값':'',items:[]}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelector('#inputMappingStatus').dataset.status==='NEW_TEMPLATE'`, 'unregistered clipboard structure source mapping fallback');
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-row-id="source-1"] [data-mapping-column="1"] input')?.value`), '보존값', 'unknown columns must remain intact in the new source mapping table');

  await evaluate(client, String.raw`(async()=>{const mapper=await import('/smartinput/input-template-mapper.js');const store=await import('/smartinput/smartinput-data-store.js');const contract=window.SMART_INPUT_CONTRACT;const draft=contract.createDraft({activeMode:'estimate'}).modes.estimate;const matrix=[['원본 메모','수량','품목코드','품목명'],['재열기','0','E-001','저장 배추'],['','-4','E-002','저장 무']];const targets=[{id:'voucher.estimate.line.memo',label:'적요',aliases:['메모'],scope:'voucher',projectionFieldId:'memo',valueType:'TEXT'},{id:'voucher.estimate.line.quantity',label:'견적수량',aliases:['수량'],scope:'voucher',projectionFieldId:'quantity',valueType:'NUMBER'},{id:'voucher.estimate.line.productCode',label:'품목코드',scope:'voucher',projectionFieldId:'itemCode',valueType:'TEXT'},{id:'voucher.estimate.line.productName',label:'품목명',scope:'voucher',projectionFieldId:'itemName',valueType:'TEXT'}];const session=mapper.createMappingSession({matrix,headerRowIndex:0,targetDefinitions:targets,fileName:'저장견적.xlsx',sheetName:'원본',companyId:'ONEAPP',voucherMode:'estimate'});session.batchId='SIBATCH-SAVED-ESTIMATE-E2E';draft.inputMapping=session;draft.rows=mapper.projectMappedRows(session,targets).map(row=>contract.normalizeRow({...row,batchId:session.batchId},session.batchId));draft.activeMethod='excel';draft.sourceText=matrix.map(row=>row.join('\t')).join('\n');const now='2026-09-03T00:00:00.000Z';await store.saveEstimate({estimateId:'SIEST-SOURCE-REOPEN-E2E',catalogName:'저장 원본형 견적',estimateKind:'INDIVIDUAL',customerId:'',customerName:'',rowCount:2,amount:0,previousPrices:{},sortOrder:1,createdAt:now,updatedAt:now,draft});return true;})()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await click(client, '[data-mode="estimate"]');
  await expr(client, `Boolean(document.querySelector('[data-estimate-id="SIEST-SOURCE-REOPEN-E2E"]'))`, 'saved source-backed estimate card');
  const savedEstimateBytes = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('estimates','readonly').objectStore('estimates').get('SIEST-SOURCE-REOPEN-E2E');get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(JSON.stringify(get.result));db.close();};};})`);
  await click(client, '[data-estimate-id="SIEST-SOURCE-REOPEN-E2E"] [data-select-estimate-card]');
  await expr(client, `!document.querySelector('#mappingWorktable').hidden`, 'saved estimate source view default');
  assert.deepEqual(await evaluate(client, `(() => ({headers:[...document.querySelectorAll('#mappingTableHeaders strong')].map(node=>node.textContent),values:[...document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])')].map(row=>[...row.querySelectorAll('[data-mapping-cell]')].map(input=>input.value))}))()`), {
    headers: ['원본 메모', '수량', '품목코드', '품목명'],
    values: [['재열기', '0', 'E-001', '저장 배추'], ['', '-4', 'E-002', '저장 무']]
  }, 'saved estimate reopening must retain exact source order, blank positions, zero, and negative values');
  await click(client, '[data-table-view="input"]');
  await expr(client, `!document.querySelector('#voucherInputTable').hidden`, 'saved estimate configured input view');
  await click(client, '[data-estimate-id="SIEST-SOURCE-REOPEN-E2E"] [data-select-estimate-card]');
  await expr(client, `!document.querySelector('#mappingWorktable').hidden&&document.querySelector('[data-table-view="source"]').getAttribute('aria-pressed')==='true'`, 'saved estimate reopen resets source view');
  assert.equal(await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('estimates','readonly').objectStore('estimates').get('SIEST-SOURCE-REOPEN-E2E');get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(JSON.stringify(get.result));db.close();};};})`), savedEstimateBytes,
    'view switching and saved-estimate reopening must not rewrite the saved estimate payload');
  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ screenshots: [wideSourceShot, desktopShot, desktopInputShot, darkShot, mobileInputShot, mobileShot], persistedTemplateId: persistedTemplate.templateId }, null, 2));
  console.log('SmartInput input-template mapping browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
