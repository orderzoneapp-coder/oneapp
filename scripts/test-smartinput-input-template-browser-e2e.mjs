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
  await evaluate(client, String.raw`(async()=>{const mapper=await import('/smartinput/input-template-mapper.js');const draft=window.SMART_INPUT_CONTRACT.createDraft({activeMode:'order'});const matrix=[['2026 행사 발주','','',''],['품목코드','품목명','수량','원본 메모'],['001','취나물','0',''],['002','시금치','-1.5','확인']];const targetDefinitions=[{id:'itemCode',label:'품목코드',scope:'voucher',valueType:'TEXT'},{id:'itemName',label:'품목명',scope:'voucher',valueType:'TEXT'},{id:'quantity',label:'수량',scope:'voucher',valueType:'NUMBER'},{id:'memo',label:'메모',scope:'voucher',valueType:'TEXT'}];const session=mapper.createMappingSession({matrix,headerRowIndex:1,targetDefinitions,fileName:'행사발주.xlsx',sheetName:'원본'});session.batchId='SIBATCH-MAPPING-E2E';draft.modes.order.inputMapping=session;draft.modes.order.activeMethod='excel';draft.modes.order.sourceText=matrix.map(row=>row.join('\t')).join('\n');localStorage.setItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY,JSON.stringify(draft));return true;})()`);
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

  await click(client, '[data-open-field-mapping="3"]');
  await expr(client, `Boolean(document.querySelector('.field-mapping-dialog[open] [data-unmap]'))`, 'field mapping modal');
  await click(client, '.field-mapping-dialog [data-unmap]');
  await expr(client, `document.querySelector('[data-mapping-column="3"]').dataset.mappingState==='UNMAPPED'`, 'explicit unmapped decision');
  await click(client, '#inputTemplateSaveButton');
  await expr(client, `Boolean(document.querySelector('dialog[open] input[name="templateName"]'))`, 'input-template save dialog');
  await input(client, 'dialog[open] input[name="templateName"]', '행사발주 공식 양식');
  await click(client, 'dialog[open] [data-save]');
  await expr(client, `document.querySelector('#inputMappingStatus').dataset.status==='TEMPLATE_APPLIED'&&!document.querySelector('#completeButton').disabled`, 'saved template application');
  const persistedTemplate = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',4);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('settings','readonly');const get=tx.objectStore('settings').get('inputTemplates');get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result?.value?.[0]||null);db.close();};};})`);
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

  await click(client, '#settingsButton');
  await expr(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-open-input-template-manager]'))`, 'settings mapping manager path');
  await click(client, '.smart-settings-dialog [data-open-input-template-manager]');
  await expr(client, `document.querySelector('.field-mapping-dialog[open]')?.textContent.includes('행사발주 공식 양식')`, 'template manager list');
  await click(client, '.field-mapping-dialog [data-close]');

  const beforeExactPaste = await evaluate(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length`);
  await evaluate(client, String.raw`(() => {const target=document.querySelector('[data-mapping-default-row] [data-mapping-column="0"] input');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'품목코드\t품목명\t수량\t원본 메모\n003\t미나리\t4\t추가':''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length===${beforeExactPaste + 1}`, 'exact mapping paste');
  assert.equal(await evaluate(client, `[...document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])')].at(-1).querySelector('[data-mapping-column="3"] input').value`), '추가', 'unmapped cells must remain editable and visible');
  const beforeMismatch = await evaluate(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length`);
  await evaluate(client, String.raw`(() => {const target=document.querySelector('[data-mapping-default-row] [data-mapping-column="0"] input');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'품목코드\t품목명\t수량 오타\t원본 메모\n004\t부추\t2\t':''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  assert.equal(await evaluate(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length`), beforeMismatch, 'mismatched paste must preserve current work rows');
  assert.equal(await evaluate(client, `!document.querySelector('#pendingPasteToSourceButton').hidden`), true);

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const desktopShot = await capture(client, 'smartinput-input-template-mapping-light.png');
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'mapping dark theme');
  const darkShot = await capture(client, 'smartinput-input-template-mapping-dark.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(client, `document.querySelector('#relatedPanelCloseButton')?.click()`);
  await wait(200);
  const mobile = await evaluate(client, `(() => ({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,sourceWidth:document.querySelector('#sourceInputPanel').getBoundingClientRect().width,tableWidth:document.querySelector('.grid-card').getBoundingClientRect().width,sourceVisible:!document.querySelector('#sourceSheetView').hidden,mappingVisible:!document.querySelector('#mappingWorktable').hidden,panelClosed:!document.querySelector('#smartInputWorkspace').classList.contains('related-panel-open')}))()`);
  assert.ok(mobile.sourceWidth <= 390 && mobile.tableWidth <= 390 && mobile.sourceVisible && mobile.mappingVisible && mobile.panelClosed,
    'mobile must keep source and mapping table in the stacked workflow after the right panel is closed');
  const mobileShot = await capture(client, 'smartinput-input-template-mapping-mobile.png');
  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ screenshots: [desktopShot, darkShot, mobileShot], persistedTemplateId: persistedTemplate.templateId }, null, 2));
  console.log('SmartInput input-template mapping browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
