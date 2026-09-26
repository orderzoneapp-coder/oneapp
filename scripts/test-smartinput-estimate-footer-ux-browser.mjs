#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'scripts/fixtures/smartinput-erp-estimate-status.xlsx');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-footer-ux-'));
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  if (target === join(root, 'smartinput', 'smartinput.js')) {
    response.end(`${readFileSync(target, 'utf8')}
window.__footerUx={
  ready:()=>Boolean(state.smartDataReady),
  snapshot:()=>({
    mode:state.draft.activeMode,
    topForbidden:[...document.querySelectorAll('#estimateExcludedToggle,#addRowButton,#undoGridPasteButton,.work-action-bar #tableViewSwitch')].map(el=>el.id||el.className),
    tableViewCount:document.querySelectorAll('#tableViewSwitch').length,
    tableViewInFooter:Boolean(document.querySelector('.voucher-footer-actions #tableViewSwitch')),
    complete:document.querySelector('#completeButton')?.textContent?.trim()||'',
    saveMenuHidden:Boolean(document.querySelector('#estimateSaveMenu')?.hidden),
    saveAsLabel:document.querySelector('#saveEstimateAsButton')?.textContent?.trim()||'',
    sourceDisabled:document.querySelector('#tableViewSwitch [data-table-view="source"]')?.disabled===true,
    hasMapping:Boolean(modeDraft()?.inputMapping),
    erp:Boolean(modeDraft()?.inputMapping?.estimateErpSummary?.recognized)
  }),
  uploadErp:async(base64)=>{
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    await handleFile(new File([bytes],'견적서현황.xlsx'));
    return true;
  }
};`);
    return;
  }
  response.end(readFileSync(target));
});

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
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
    await new Promise((resolveConnect, rejectConnect) => {
      this.socket.addEventListener('open', resolveConnect, { once: true });
      this.socket.addEventListener('error', rejectConnect, { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => this.pending.set(id, { resolve: resolveSend, reject: rejectSend }));
  }
  on(method, listener) {
    const list = this.events.get(method) || [];
    list.push(listener);
    this.events.set(method, list);
  }
  close() { this.socket?.close(); }
}

const evaluate = (client, expression) => client.send('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true
}).then(result => {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result.value;
});

const click = async (client, selector) => {
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)}).click()`);
};
const input = async (client, selector, value) => {
  await evaluate(client, `(() => {const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return el.value;})()`);
};

let browser;
let client;
try {
  assert.equal(existsSync(fixture), true, 'ERP fixture required for screen D');
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  browser = spawn(executable, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const debugPort = await waitFor(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)[0] || null; } catch { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await waitFor(() => evaluate(client, `window.__footerUx?.ready?.()`), 'smart data ready', 60_000);

  await click(client, '[data-mode="estimate"]');
  await waitFor(() => evaluate(client, `window.__footerUx.snapshot().mode==='estimate'`), 'estimate mode');
  const screenA = await evaluate(client, `window.__footerUx.snapshot()`);
  assert.deepEqual(screenA.topForbidden, [], 'T01 top forbidden controls must be gone');
  assert.equal(screenA.tableViewCount, 1);
  assert.equal(screenA.tableViewInFooter, true);
  assert.equal(screenA.complete, '견적서 저장');
  assert.equal(screenA.saveMenuHidden, true);
  assert.equal(screenA.sourceDisabled, true);

  await input(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', 'UX-1');
  await input(client, '#inputRows [data-field="itemName"]', '푸터 UX 상품');
  await input(client, '#inputRows [data-field="quantity"]', '1');
  await input(client, '#inputRows [data-field="unitPrice"]', '1000');
  await click(client, '#completeButton');
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-estimate-name]'))`), 'save dialog');
  await input(client, '[data-estimate-name]', '푸터 UX 견적');
  await click(client, '[data-confirm-save]');
  await waitFor(() => evaluate(client, `document.querySelector('#catalogPickerList [data-select-estimate-card]')?.textContent.includes('푸터 UX 견적')`), 'estimate saved');
  const screenB = await evaluate(client, `window.__footerUx.snapshot()`);
  assert.equal(screenB.complete, '견적서 저장');
  assert.equal(screenB.saveMenuHidden, false);
  assert.equal(screenB.saveAsLabel, '복사본으로 저장');

  await click(client, '#estimateSaveMenu > summary');
  await click(client, '#saveEstimateAsButton');
  await waitFor(() => evaluate(client, `document.querySelector('.estimate-save-dialog h2')?.textContent==='복사본으로 저장'`), 'copy dialog');
  await input(client, '[data-estimate-name]', '푸터 UX 견적 복사본');
  const originalId = await evaluate(client, `document.querySelector('#catalogPickerList [data-estimate-id]')?.dataset.estimateId`);
  await click(client, '[data-confirm-save]');
  await waitFor(() => evaluate(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===2`), 'copy saved');
  const ids = await evaluate(client, `[...document.querySelectorAll('#catalogPickerList [data-estimate-id]')].map(card=>card.dataset.estimateId)`);
  assert.ok(ids.includes(originalId));
  assert.equal(ids.length, 2);

  const screenC = await evaluate(client, `(() => {const data=new DataTransfer();data.items.add(new File(['\\ufeff품목코드,품목명,수량,단가\\r\\nA1,사과,2,1500'],'원본형.csv',{type:'text/csv'}));const input=document.querySelector('#fileInput');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  assert.equal(screenC, true);
  await waitFor(() => evaluate(client, `window.__footerUx.snapshot().hasMapping===true`), 'mapping session');
  const afterExcel = await evaluate(client, `window.__footerUx.snapshot()`);
  assert.equal(afterExcel.sourceDisabled, false, 'source view enabled when mapping exists');
  assert.equal(afterExcel.tableViewInFooter, true);

  await click(client, '#resetDraftButton');
  await waitFor(() => evaluate(client, `window.__footerUx.snapshot().hasMapping===false`), 'mapping cleared');
  const erpBase64 = readFileSync(fixture).toString('base64');
  await evaluate(client, `window.__footerUx.uploadErp(${JSON.stringify(erpBase64)})`);
  await waitFor(() => evaluate(client, `window.__footerUx.snapshot().erp===true`), 'ERP summary recognized', 60_000);
  const screenD = await evaluate(client, `window.__footerUx.snapshot()`);
  assert.equal(screenD.complete, '견적서 업데이트');
  assert.equal(screenD.saveMenuHidden, true);
  assert.equal(screenD.tableViewInFooter, true);

  console.log('SmartInput estimate footer UX browser states A-D PASS');
} finally {
  try { client?.socket?.close(); } catch {}
  if (browser?.pid) try { process.kill(browser.pid); } catch {}
  try { server.close(); } catch {}
  await wait(250);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
}
