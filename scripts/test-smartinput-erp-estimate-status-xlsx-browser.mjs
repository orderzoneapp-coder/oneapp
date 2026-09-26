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
assert.equal(existsSync(fixture), true, '합성 견적서현황.xlsx fixture가 있어야 한다.');
const fixtureBytes = readFileSync(fixture);
assert.match(fixtureBytes.toString('utf8'), /합성|synthetic|운영자료 아님|SYN-CUST/i,
  '브라우저 fixture도 운영 원본이 아닌 합성 자료여야 한다.');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-erp-xlsx-e2e-'));
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
window.__erpXlsxTest={
  ready:()=>Boolean(state.smartDataReady),
  mode:()=>state.draft.activeMode,
  busy:()=>state.busy,
  meta:()=>document.querySelector('#sourceSheetMeta')?.textContent||'',
  summary:()=>modeDraft()?.inputMapping?.estimateErpSummary||null,
  upload:async(base64)=>{
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    await handleFile(new File([bytes],'견적서현황.xlsx'));
    return true;
  }
};`);
    return;
  }
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
  await waitFor(() => evaluate(client, 'Boolean(window.__erpXlsxTest?.ready())'), 'SmartInput ready', 60_000);
  await evaluate(client, `document.querySelector('.mode-tab[data-mode="estimate"]').click()`);
  await waitFor(() => evaluate(client, 'window.__erpXlsxTest.mode()==="estimate" && !window.__erpXlsxTest.busy()'), 'estimate mode', 60_000);
  await evaluate(client, `window.__erpXlsxTest.upload(${JSON.stringify(fixtureBytes.toString('base64'))})`);
  const summary = await waitFor(() => evaluate(client, `(()=>{const summary=window.__erpXlsxTest.summary();return summary?.recognized && summary.itemCount===275 && summary.customerCount===10 ? summary : null;})()`), 'real xlsx recognition', 60_000);
  assert.equal(summary.sheetName, '견적서현황내역');
  assert.equal(summary.itemCount, 275);
  assert.equal(summary.customerCount, 10);
  assert.match(await evaluate(client, 'window.__erpXlsxTest.meta()'), /견적서현황내역 · 거래처 10곳 · 품목 275개/);
  console.log('SmartInput browser handleFile recognized synthetic ERP 견적서현황.xlsx as 10 customers / 275 items.');
} finally {
  client?.socket?.close();
  if (browser?.pid) try { process.kill(browser.pid); } catch {}
  server.close();
  await wait(250);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
}
