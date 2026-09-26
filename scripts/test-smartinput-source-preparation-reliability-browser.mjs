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
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-source-prep-'));
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

assert.doesNotMatch(
  ['index.html', 'smartinput.js', 'source-preparation-ui-v2.js', 'smartinput.css']
    .map(name => readFileSync(join(root, 'smartinput', name), 'utf8')).join('\n'),
  /준비한 자료 적용|매핑 완료 후 중앙 작업표에 한 번에 반영/
);

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  if (target === join(root, 'smartinput', 'smartinput.js')) {
    response.end(`${readFileSync(target, 'utf8')}
window.__sourcePrepTest={
  ready:()=>Boolean(state.smartDataReady),
  mode:()=>state.draft.activeMode,
  busy:()=>state.busy,
  snapshot:()=>window.SMARTINPUT_SOURCE_PREPARATION.snapshot(),
  apply:(key,decisions)=>window.SMARTINPUT_SOURCE_PREPARATION.apply(key,decisions),
  rows:()=>modeDraft().rows.filter(row=>String(row.itemCode||row.itemName||'').trim()),
  documentId:()=>modeDraft().documentId,
  rowFingerprint:()=>JSON.stringify(modeDraft().rows),
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

const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 30_000) => {
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
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};

let browser;
let client;
try {
  assert.equal(existsSync(fixture), true, 'ERP fixture required');
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  browser = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
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
  await waitFor(() => evaluate(client, 'Boolean(window.__sourcePrepTest?.ready())'), 'SmartInput ready', 60_000);

  const buildInfo = await evaluate(client, '({info:window.ONEAPP_SMARTINPUT_BUILD_INFO,meta:document.querySelector(\'meta[name="oneapp-smartinput-build"]\')?.content,dataset:document.documentElement.dataset.smartinputBuild})');
  assert.equal(buildInfo.info?.assetSchema, 'ONEAPP_SMARTINPUT_ASSET_SET_V1');
  assert.equal(buildInfo.info?.buildId, buildInfo.meta);
  assert.equal(buildInfo.info?.buildId, buildInfo.dataset);

  await evaluate(client, `document.querySelector('.mode-tab[data-mode="estimate"]').click()`);
  await waitFor(() => evaluate(client, 'window.__sourcePrepTest.mode()==="estimate" && !window.__sourcePrepTest.busy()'), 'estimate mode', 60_000);
  await evaluate(client, `window.__sourcePrepTest.upload(${JSON.stringify(readFileSync(fixture).toString('base64'))})`);
  await waitFor(() => evaluate(client, `(()=>{const snap=window.__sourcePrepTest.snapshot();return snap?.sessionStatus==='TEMPLATE_APPLIED' && snap.autoProjected && window.__sourcePrepTest.rows().length>=275;})()`), 'ERP auto projection', 60_000);

  const afterUpload = await evaluate(client, `(()=>({
    applyHidden:document.querySelector('#sourcePreparationApply')?.hidden===true,
    applyText:document.querySelector('#sourcePreparationApply')?.innerText||'',
    status:document.querySelector('#sourcePreparationStatus')?.textContent||'',
    toast:document.querySelector('#toast')?.textContent||'',
    rowCount:window.__sourcePrepTest.rows().length,
    mapped:window.__sourcePrepTest.snapshot().mappingSummary.mapped,
    complete:document.querySelector('#completeButton')?.textContent?.trim()||''
  }))()`);
  assert.equal(afterUpload.applyHidden, true, 'T03 exact template must hide apply');
  assert.doesNotMatch(afterUpload.applyText, /준비한 자료 적용/);
  assert.match(afterUpload.status, /자동 반영 완료/);
  assert.match(afterUpload.toast, /입력 양식을 자동 적용했습니다/);
  assert.equal(afterUpload.rowCount >= 275, true);
  assert.equal(afterUpload.complete, '견적서 업데이트');

  await evaluate(client, `(()=>{const select=document.querySelectorAll('#sourcePreparationList select')[0];const current=select.value;const options=[...select.options].map(o=>o.value).filter(v=>v&&v!==current);select.value=options.includes('__UNMAPPED__')?'__UNMAPPED__':(options[0]||'__UNMAPPED__');select.dispatchEvent(new Event('change',{bubbles:true}));return select.value;})()`);
  await waitFor(() => evaluate(client, `document.querySelector('#sourcePreparationApply')?.hidden===false && document.querySelector('#sourcePreparationApply strong')?.textContent==='매핑 변경 반영'`), 'changed mapping shows apply');
  const beforeMapping = await evaluate(client, `JSON.stringify(window.__sourcePrepTest.snapshot().mappings)`);
  await evaluate(client, `document.querySelector('#sourcePreparationApply').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('#sourcePreparationApply')?.hidden===true && (document.querySelector('#sourcePreparationStatus')?.textContent||'').includes('매핑 변경 반영 완료')`), 'apply hides again');
  const afterChange = await evaluate(client, `({hidden:document.querySelector('#sourcePreparationApply')?.hidden===true,mappings:JSON.stringify(window.__sourcePrepTest.snapshot().mappings),doc:window.__sourcePrepTest.documentId()})`);
  assert.equal(afterChange.hidden, true);
  assert.notEqual(afterChange.mappings, beforeMapping);

  const noop = await evaluate(client, `(()=>{const snap=window.__sourcePrepTest.snapshot();const decisions=snap.mappings.map(m=>({columnIndex:m.columnIndex,state:m.state==='UNMAPPED'?'UNMAPPED':'MAPPED',targetFieldId:m.state==='UNMAPPED'?'':String(m.targetFieldId||'')}));const before=window.__sourcePrepTest.rowFingerprint();const result=window.__sourcePrepTest.apply(snap.key,decisions);return {result,unchanged:window.__sourcePrepTest.rowFingerprint()===before,doc:window.__sourcePrepTest.documentId()};})()`);
  assert.deepEqual(noop.result, { applied: true, changed: false });
  assert.equal(noop.unchanged, true);
  assert.equal(noop.doc, afterChange.doc);

  console.log('SmartInput source preparation reliability browser PASS');
} finally {
  try { client?.socket?.close(); } catch {}
  if (browser?.pid) try { process.kill(browser.pid); } catch {}
  try { server.close(); } catch {}
  await wait(250);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }); } catch {}
}
