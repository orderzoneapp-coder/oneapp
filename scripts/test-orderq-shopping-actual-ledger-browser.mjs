#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-shopping-ledger-browser-'));
const requests = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  requests.push({ method: request.method, pathname });
  if (pathname === '/' || pathname === '/fixture.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end('<!doctype html><meta charset="utf-8"><title>ORDER Q shopping ledger fixture</title>');
  }
  const target = normalize(resolve(root, pathname.replace(/^\/+/, '')));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('Not found');
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
    } catch (error) { lastError = error; }
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
  close() { this.socket?.close(); }
}

let browser;
let client;
const exceptions = [];
const networkRequests = [];
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const origin = `http://127.0.0.1:${address.port}`;
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
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  client.on('Runtime.exceptionThrown', event => exceptions.push(
    event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Network.requestWillBeSent', event => networkRequests.push({ method: event.request?.method || '', url: event.request?.url || '' }));
  const loaded = new Promise(resolveLoad => client.on('Page.loadEventFired', resolveLoad));
  await client.send('Page.navigate', { url: `${origin}/fixture.html` });
  await loaded;
  const response = await client.send('Runtime.evaluate', {
    expression: `(async()=>{const fixture=await import('/scripts/fixtures/orderq-shopping-actual-ledger-browser-scenario.js?run=1');return fixture.runOrderQShoppingActualLedgerScenario();})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  const evidence = response.result.value;

  assert.equal(evidence.capability.ready, true);
  assert.equal(evidence.capability.localActualLedgerOnly, true);
  assert.equal(evidence.capability.multiDeviceGlobalDedupe, false);
  assert.equal(evidence.evidence.commit.createdCount, 1);
  assert.deepEqual(evidence.evidence.counts, { orders: 1, orderItems: 1, orderEvents: 1, syncQueue: 2, meta: 1 });
  assert.equal(evidence.evidence.sourceStatus, '입금');
  assert.equal(evidence.evidence.sourceMessage, '원본 전달사항');
  assert.equal(evidence.evidence.sourceAddress, '원본 주소');
  assert.equal(evidence.evidence.sourceRowNumber, 2);
  assert.equal(evidence.evidence.externalOrderNo, '');
  assert.match(evidence.evidence.internalOrderNo, /^20260904-\d{3}$/);
  assert.match(evidence.evidence.signature, /^[a-f0-9]{64}$/);

  assert.equal(evidence.duplicateZeroWrite.result.isDuplicate, true);
  assert.equal(evidence.duplicateZeroWrite.result.writes, 0);
  assert.equal(evidence.duplicateZeroWrite.unchanged, true);

  assert.equal(evidence.race.finalOrders, 2, 'existing 1 + source 2 must end at exactly two orders across concurrent commits');
  assert.equal(evidence.race.created, 1);
  assert.equal(evidence.race.duplicates, 3);
  assert.equal(evidence.race.sourceKeys.length, 1);
  assert.equal(new Set(evidence.race.sourceKeys).size, evidence.race.sourceKeys.length);

  assert.equal(evidence.stale.plannedDuplicate, false);
  assert.equal(evidence.stale.committed.isDuplicate, true, 'same transaction must recheck actual count');
  assert.equal(evidence.stale.committed.writes, 0);
  assert.equal(evidence.stale.finalOrders, 2);

  for (const [name, result] of Object.entries(evidence.rollback)) {
    assert.equal(result.injected, true, `${name}: failure was not injected`);
    assert.equal(result.result.summary.failedCount, 1);
    assert.deepEqual(result.after, result.before, `${name}: transaction did not roll back completely`);
  }

  const isolated = evidence.candidateIsolation.injectedFailure;
  assert.equal(isolated.injected, true);
  assert.deepEqual(isolated.result.results.map(result => result.status), ['FAILED', 'CREATED']);
  assert.equal(isolated.after.orders.length, 1, 'a failed candidate must not block a different normal candidate');
  assert.equal(isolated.after.orders[0].customerName, '정상후보');
  assert.deepEqual(evidence.candidateIsolation.reviewResult.results.map(result => result.status), ['REVIEW_REQUIRED', 'CREATED']);
  assert.equal(evidence.candidateIsolation.reviewOrderCount, 1);

  const atomicTransactions = evidence.readwriteTransactions.filter(stores => {
    const names = new Set(stores);
    return names.size === 5 && names.has('orders') && names.has('orderItems')
      && names.has('orderEvents') && names.has('syncQueue') && names.has('meta');
  });
  assert.ok(atomicTransactions.length >= 8);
  atomicTransactions.forEach(stores => assert.deepEqual(new Set(stores), new Set(['orders', 'orderItems', 'orderEvents', 'syncQueue', 'meta'])));

  const externalMutatingRequests = networkRequests.filter(row => !row.url.startsWith(origin)
    && !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  const localMutatingRequests = requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  assert.equal(externalMutatingRequests.length, 0);
  assert.equal(localMutatingRequests.length, 0);
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({
    taskId: 'NEXUS-ORDERQ-SHOP-ACTUAL-LEDGER-20260904-01',
    status: 'PASS',
    evidence,
    isolation: { externalMutatingRequests: 0, localMutatingRequests: 0, browserExceptions: 0 }
  }, null, 2));
} finally {
  client?.close();
  browser?.kill();
  await new Promise(resolveClose => server.close(resolveClose));
  await wait(300);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
