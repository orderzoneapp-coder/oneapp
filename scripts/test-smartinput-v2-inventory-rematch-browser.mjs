#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-stage6c-rematch-browser-'));
const evidenceFile = process.env.SMARTINPUT_STAGE6C_BROWSER_EVIDENCE_FILE
  ? resolve(process.env.SMARTINPUT_STAGE6C_BROWSER_EVIDENCE_FILE) : '';
const requests = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  requests.push({ method: request.method, pathname });
  if (pathname === '/' || pathname === '/fixture.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end('<!doctype html><meta charset="utf-8"><title>Stage 6C fixture</title>');
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
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};
const commandPath = command => {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command],
    { encoding: 'utf8', windowsHide: true });
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
const networkRequests = [];
const exceptions = [];
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
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
  client.on('Network.requestWillBeSent', event => networkRequests.push({
    method: event.request?.method || '', url: event.request?.url || '', type: event.type || ''
  }));
  const loaded = new Promise(resolveLoad => client.on('Page.loadEventFired', resolveLoad));
  await client.send('Page.navigate', { url: `${origin}/fixture.html` });
  await loaded;
  const response = await client.send('Runtime.evaluate', {
    expression: `(async()=>{const fixture=await import('/scripts/fixtures/smartinput-v2-stage6c-browser-scenario.js?run=1');return fixture.runStage6CInventoryRematchScenario();})()`,
    awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  const evidence = response.result.value;
  assert.equal(evidence.db.name, 'oneapp-orderq-pre-m1-v6');
  assert.equal(evidence.db.version, 7);
  assert.equal(evidence.db.newStores, 0);
  assert.equal(evidence.primary.selectedProductId, 'PRODUCT-CODE');
  assert.equal(evidence.primary.candidateSameNameCount, 2, 'same-name candidates must not auto-select');
  assert.equal(evidence.primary.automaticConfirmation, false);
  assert.equal(evidence.primary.movements.length, 4);
  assert.deepEqual(evidence.primary.movements.map(row => row.originalSignedQuantity).sort((a, b) => a - b), [-3, 0, 2, 5]);
  assert.equal(evidence.primary.movements.filter(row => row.status === 'ZERO_EFFECT'
    && row.stocktakeEffectStatus === 'ABSORBED_BY_CHECKPOINT').length, 1);
  assert.equal(evidence.primary.movements.filter(row => row.status === 'APPLIED_AS_LATE_ADJUSTMENT').length, 1);
  assert.equal(evidence.primary.movements.filter(row => row.status === 'APPLIED_NORMAL').length, 2);
  assert.equal(evidence.primary.movements.some(row => row.status === 'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE'), false);
  assert.equal(evidence.primary.auditRevisions, 1);
  assert.equal(evidence.primary.receipts, 1);
  assert.equal(evidence.primary.queues, 1);
  assert.equal(evidence.primary.readwriteTransactions.length, 1, 'all 6C official writes must use one transaction');
  assert.deepEqual(new Set(evidence.primary.readwriteTransactions[0].stores), new Set([
    'purchaseDocuments', 'purchaseLines', 'salesDocuments', 'salesLines', 'officialCommands', 'voucherRevisions',
    'inventoryMovements', 'pendingInventoryEffects', 'inventoryCheckpoints', 'unresolvedProducts', 'syncQueue'
  ]));
  assert.deepEqual(evidence.primary.queueState,
    [{ entityType: 'OFFICIAL_INVENTORY_REMATCH_COMMAND', status: 'WAITING_SERVER_CONTRACT' }]);
  assert.equal(evidence.primary.originalLinesAndSnapshotsUnchanged, true);
  assert.equal(evidence.primary.documentsUnchanged, true);
  assert.deepEqual(evidence.nameOnly, { productId: 'PRODUCT-NAME', movements: 1 });
  assert.deepEqual(evidence.zero.movements, [
    { businessDate: '2026-09-01', effectStatus: 'ZERO_EFFECT', stocktakeEffectStatus: 'APPLIED_AS_LATE_ADJUSTMENT',
      signedQuantity: 0, originalSignedQuantity: 0, officialInventoryApplied: true },
    { businessDate: '2026-09-02', effectStatus: 'ZERO_EFFECT', stocktakeEffectStatus: 'ABSORBED_BY_CHECKPOINT',
      signedQuantity: 0, originalSignedQuantity: 0, officialInventoryApplied: false },
    { businessDate: '2026-09-04', effectStatus: 'ZERO_EFFECT', stocktakeEffectStatus: '',
      signedQuantity: 0, originalSignedQuantity: 0, officialInventoryApplied: true }
  ]);
  assert.deepEqual(evidence.zero.resolvedEffects.map(row => [row.inventoryEffectStatus, row.stocktakeEffectStatus]), [
    ['ZERO_EFFECT', ''], ['ZERO_EFFECT', 'ABSORBED_BY_CHECKPOINT'], ['ZERO_EFFECT', 'APPLIED_AS_LATE_ADJUSTMENT']
  ]);
  assert.deepEqual(evidence.zero.auditEffects.map(row => [row.status, row.stocktakeEffectStatus]), [
    ['ZERO_EFFECT', 'APPLIED_AS_LATE_ADJUSTMENT'], ['ZERO_EFFECT', 'ABSORBED_BY_CHECKPOINT'], ['ZERO_EFFECT', '']
  ]);
  assert.deepEqual(evidence.retry, { duplicate: true, countsUnchanged: true, afterSnapshotChange: true });
  assert.match(evidence.rejects.payloadConflict, /COMMAND_ID_INVALID|COMMAND_PAYLOAD/);
  assert.match(evidence.rejects.idempotencyCollision, /COMMAND_PAYLOAD_CONFLICT/);
  assert.match(evidence.rejects.staleRevision, /EXPECTED_DOCUMENTS_STALE|EXPECTED_EFFECTS_STALE|DOCUMENT_LINK_INVALID/);
  assert.match(evidence.rejects.staleProductSnapshot, /PRODUCT_SNAPSHOT_STALE/);
  assert.match(evidence.rejects.brokenLink, /LINK_INTEGRITY|LINK_INVALID/);
  assert.match(evidence.rejects.crossCompanyLink, /LINK_INTEGRITY|LINK_INVALID/);
  assert.match(evidence.rejects.damagedOriginalSnapshot, /LINE_LINK_INVALID/);
  assert.match(evidence.rejects.partialLinks, /EXPECTED_EFFECTS_STALE|LINK_INVALID/);
  assert.match(evidence.rejects.crossCompanyAccess, /UNRESOLVED_STATE_INVALID/);
  assert.match(evidence.rejects.incompleteDecision, /STOCKTAKE_DECISIONS_INCOMPLETE/);
  assert.equal(evidence.rejects.rawBypass, 'ORDERQ_REMATCH_OWNER_GATEWAY_REQUIRED');
  for (const key of ['wrongSign', 'wrongQuantity', 'wrongWarehouse', 'laterDate',
    'fabricatedSameDayBusinessOccurredAt', 'inactiveLine', 'cancelledLine', 'documentCommandMismatch',
    'lineCommandMismatch', 'revisionCommandMismatch', 'pendingCommandMismatch', 'invalidBusinessDate']) {
    assert.match(evidence.rejects[key], /ORDERQ_REMATCH_V2_/, `${key} must fail closed`);
  }
  for (const key of ['occurredAt', 'judgedAt', 'selectedAt']) {
    assert.match(evidence.rejects.invalidTimestamps[key], /_INVALID/, `${key} must reject impossible calendar dates`);
  }
  assert.equal(evidence.sourceIntegrityReadwriteTransactions, 0,
    'invalid source/date evidence must fail during readonly preflight before a write transaction');
  assert.deepEqual(evidence.cancel, { cancelled: true, duplicate: false, officialWrites: 0 });
  assert.equal(evidence.rejectedAndCancelWritesZero, true);
  assert.ok(evidence.rollback.error, 'forced transaction failure must surface');
  assert.equal(Object.values(evidence.rollback).filter(value => value === false).length, 0,
    `all official stores must rollback: ${JSON.stringify(evidence.rollback)}`);
  const externalMutatingRequests = networkRequests.filter(row => !row.url.startsWith(origin)
    && !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  const localMutatingRequests = requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  assert.equal(externalMutatingRequests.length, 0);
  assert.equal(localMutatingRequests.length, 0);
  assert.deepEqual(exceptions, []);
  const report = {
    taskId: 'NEXUS-SI-V2-06C', status: 'PASS', ...evidence,
    isolation: { externalMutatingRequests: externalMutatingRequests.length, localMutatingRequests: localMutatingRequests.length,
      browserExceptions: exceptions.length }
  };
  if (evidenceFile) writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close();
  browser?.kill();
  await new Promise(resolveClose => server.close(resolveClose));
  await wait(300);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
