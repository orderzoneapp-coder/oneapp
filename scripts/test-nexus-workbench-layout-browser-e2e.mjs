#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-workbench-layout-'));
const mime = { '.css':'text/css; charset=utf-8', '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}` || 'Master.html';
    const file = normalize(resolve(root, relative));
    if (file !== root && !file.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Cache-Control':'no-store', 'Content-Type':mime[extname(file).toLowerCase()] || 'application/octet-stream' });
    response.end(readFileSync(file));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 45_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};
const commandPath = (command) => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding:'utf8', windowsHide:true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '' : '';
};
const browserPath = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge'),
].filter(Boolean).find(existsSync) || '';

class Cdp {
  constructor(url) { this.url=url; this.socket=null; this.nextId=1; this.pending=new Map(); this.events=new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      }
      (this.events.get(message.method) || []).forEach((listener) => listener(message.params));
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once:true });
      this.socket.addEventListener('error', rejectOpen, { once:true });
    });
  }
  send(method, params={}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve:resolveSend, reject:rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout=45_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter((item) => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  close() { this.socket?.close(); }
}
const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true, userGesture:true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const click = (client, selector) => evaluate(client, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw new Error('Missing ${selector}'); node.click(); return true; })()`);

let browser;
let client;
try {
  assert.ok(browserPath, 'Chrome/Edge is required for NEXUS workbench browser E2E');
  const address = await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', () => resolveListen(server.address())); });
  browser = spawn(browserPath, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio:'ignore', windowsHide:true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 'browser debug port');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).find((item) => item.type === 'page') : null;
  }, 'browser target');
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width:1600, height:900, deviceScaleFactor:1, mobile:false });
  const origin = `http://127.0.0.1:${address.port}`;

  const navigate = async (path, appId) => {
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url:`${origin}/${path}` });
    await loaded;
    await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-nexus-workspace="${appId}"]')) && document.documentElement.dataset.nexusUiReady==='true'`), `${appId} workbench`);
    const state = await evaluate(client, `(() => {
      const workspace=document.querySelector('[data-nexus-workspace="${appId}"]');
      const panes=[...workspace.querySelectorAll(':scope > [data-nexus-pane]')];
      return {
        panes:panes.map((node)=>node.dataset.nexusPane),
        widths:panes.map((node)=>node.getBoundingClientRect().width),
        header:document.querySelector('[data-nexus-app-header="${appId}"]')?.getBoundingClientRect().height || 0,
        styleHref:document.querySelector('#nexusWorkbenchStyles')?.href || '',
        tabs:[...document.querySelectorAll('[data-nexus-ui-app-target]')].map((node)=>node.textContent.trim())
      };
    })()`);
    assert.deepEqual(state.panes, ['reference','work','result'], `${appId} must expose the three pane roles`);
    assert.ok(state.widths.every((width) => width > 0), `${appId} desktop panes must be visible: ${state.widths.join(',')}`);
    assert.ok(state.header >= 50, `${appId} app header must remain compact and visible`);
    assert.match(state.styleHref, /nexus-workbench\.css/);
    assert.deepEqual(state.tabs, ['상품관리','거래처관리','스마트파서','MerchOps','스마트입력','출고관리','DataOps']);
  };

  await navigate('Master.html', 'master-lookup');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-completion-bar="master-lookup"]'))`));
  await click(client, '[data-nexus-pane="result"] button[aria-label="선택 상품 결과 닫기"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-result-reopen="master-lookup"]'))`));
  await click(client, '[data-nexus-result-reopen="master-lookup"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-pane="result"]'))`));

  await navigate('MerchOps.html', 'merchops');
  await click(client, '[data-nexus-pane="result"] button[aria-label="MerchOps 결과 닫기"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-result-reopen="merchops"]'))`));
  await click(client, '[data-nexus-result-reopen="merchops"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-pane="result"]'))`));

  await navigate('smartinput/index.html', 'smart-input');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-completion-bar="smart-input"]'))`));
  console.log('PASS NEXUS workbench browser E2E: seven-tab header, Master/MerchOps/SmartInput app headers, three-pane roles, right-panel reopen, common Excel-grid stylesheet.');
} finally {
  client?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (browser && !browser.killed) {
    const exited = new Promise((resolveExit) => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(1500)]);
  }
  try { rmSync(profile, { recursive:true, force:true, maxRetries:5, retryDelay:100 }); } catch (error) {}
}
