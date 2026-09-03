#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-stage7a-revision-browser-'));
const evidenceFile = process.env.SMARTINPUT_STAGE7A_BROWSER_EVIDENCE_FILE
  ? resolve(process.env.SMARTINPUT_STAGE7A_BROWSER_EVIDENCE_FILE) : '';
const requests = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  requests.push({ method: request.method, pathname });
  if (pathname === '/' || pathname === '/fixture.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end('<!doctype html><meta charset="utf-8"><title>Stage 7A fixture</title>');
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
    expression: `(async()=>{const fixture=await import('/scripts/fixtures/smartinput-v2-stage7a-browser-scenario.js?run=1');return fixture.runStage7AOfficialRevisionScenario();})()`,
    awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  const evidence = response.result.value;
  assert.equal(evidence.db.name, 'oneapp-orderq-pre-m1-v6');
  assert.equal(evidence.db.version, 7);
  assert.equal(evidence.correction.revision, 3);
  assert.equal(evidence.correction.action, 'CORRECT');
  assert.deepEqual(evidence.correction.movementRoles, ['REVISION_REVERSAL', 'REVISION_AFTER_EFFECT']);
  assert.deepEqual(evidence.correction.movementQuantities, [-5, -3]);
  assert.equal(evidence.correction.originalRevisionUnchanged, true);
  assert.equal(evidence.correction.ledgerEntries, 0);
  assert.equal(evidence.correction.queueStatus, 'WAITING_SERVER_CONTRACT');
  assert.equal(evidence.correction.queueType, 'OFFICIAL_VOUCHER_REVISION_COMMAND');
  assert.deepEqual(evidence.retry, { duplicate: true, countsUnchanged: true });
  assert.deepEqual(Object.keys(evidence.replacementContract.errors).sort(),
    ['blankProduct', 'blankQuantity', 'blankUnitPrice', 'documentTotalMismatch', 'snapshotMismatch'].sort());
  Object.values(evidence.replacementContract.errors).forEach(error => assert.match(error,
    /QUANTITY|UNIT_PRICE|PRODUCT_REQUIRED|PRODUCT_EXACT_MATCH_INVALID|SNAPSHOT_MISMATCH|DOCUMENT_AMOUNT_MISMATCH/));
  assert.equal(evidence.replacementContract.writesZero, true);
  assert.equal(evidence.replacementContract.zeroAccepted, true);
  assert.equal(evidence.replacementContract.negativeSnapshotPreserved, true);
  assert.equal(evidence.saleCancel.status, 'CANCELLED');
  assert.equal(evidence.saleCancel.lineStatus, 'CANCELLED');
  assert.equal(evidence.saleCancel.effectStatus, 'ZERO_EFFECT');
  assert.equal(evidence.saleCancel.signedQuantity, 0);
  assert.match(evidence.saleCancel.alreadyCancelled, /ALREADY_CANCELLED/);
  assert.equal(evidence.mixedStocktake.conflicts, 2);
  assert.deepEqual(evidence.mixedStocktake.statuses,
    ['ABSORBED_BY_CHECKPOINT', 'APPLIED_AS_LATE_ADJUSTMENT']);
  assert.deepEqual(evidence.mixedStocktake.applied, [false, true]);
  assert.deepEqual(evidence.mixedStocktake.middleCancel,
    { cancelled: true, duplicate: false, officialWrites: 0 });
  assert.equal(evidence.mixedStocktake.middleCancelWritesZero, true);
  assert.deepEqual(evidence.transitions.unresolvedToMatched, { movements: 1, superseded: 1, pendingCreated: 0 });
  assert.deepEqual(evidence.transitions.matchedToUnresolved,
    { movements: 1, pendingCreated: 1, reinspectedRevision: 3, reinspectedStatus: 'UNRESOLVED_PRODUCT' });
  assert.equal(evidence.transitions.rematchedCorrection.beforeStatus, 'MATCHED');
  assert.deepEqual(evidence.transitions.rematchedCorrection.movements, [-7, 3]);
  assert.deepEqual(evidence.transitions.chainedRevision,
    { revision: 4, secondMovementCount: 0, revisionCount: 3, firstRevisionUnchanged: true });
  assert.match(evidence.referenceIntegrity.fabricatedProductError, /PRODUCT_SNAPSHOT_STALE|PRODUCT_REFERENCE_MISMATCH/);
  assert.equal(evidence.referenceIntegrity.fabricatedProductWritesZero, true);
  assert.match(evidence.referenceIntegrity.falseUnresolvedProductError, /PRODUCT_REFERENCE_MISMATCH/);
  assert.match(evidence.referenceIntegrity.arbitraryUnresolvedIdError, /UNRESOLVED_PRODUCT_ID_INVALID/);
  assert.equal(evidence.referenceIntegrity.falseUnresolvedProductWritesZero, true);
  assert.equal(evidence.referenceIntegrity.unchangedIdentityRevision, 3);
  assert.equal(evidence.referenceIntegrity.deletedMasterProviderCalls, 0);
  assert.match(evidence.referenceIntegrity.matchedPartnerUnsupported, /ARAP_NEW_MATCHED_PARTNER_UNSUPPORTED/);
  assert.equal(evidence.referenceIntegrity.matchedPartnerWritesZero, true);
  assert.match(evidence.referenceIntegrity.falseUnresolvedPartnerError, /CUSTOMER_SNAPSHOT_STALE|CUSTOMER_REFERENCE_MISMATCH/);
  assert.equal(evidence.referenceIntegrity.falseUnresolvedPartnerWritesZero, true);
  assert.match(evidence.referenceIntegrity.actualOwnerFalseUnresolvedError, /CUSTOMER_REFERENCE_MISMATCH/);
  assert.equal(evidence.referenceIntegrity.actualOwnerFalseUnresolvedWritesZero, true);
  assert.match(evidence.headProjectionIntegrity.contradictoryStatusError, /ALREADY_CANCELLED|HEAD_LINK/);
  assert.equal(evidence.headProjectionIntegrity.contradictoryStatusWritesZero, true);
  assert.match(evidence.headProjectionIntegrity.initialSnapshotTamperError, /HEAD_|COMMAND_RECEIPT/);
  assert.equal(evidence.headProjectionIntegrity.initialSnapshotTamperWritesZero, true);
  assert.match(evidence.headProjectionIntegrity.fullSnapshotTamperError, /HEAD_FULL_SNAPSHOT_MISMATCH|HEAD_LINE/);
  assert.equal(evidence.headProjectionIntegrity.fullSnapshotTamperWritesZero, true);
  assert.match(evidence.sourceEffectIntegrity.error, /ACTIVE_EFFECT/);
  assert.match(evidence.sourceEffectIntegrity.identityError, /ACTIVE_EFFECT_INVALID|ACTIVE_EFFECT_QUANTITY|ACTIVE_EFFECT_STATUS|ACTIVE_EFFECT_LINEAGE/);
  assert.equal(evidence.sourceEffectIntegrity.writesZero, true);
  Object.values(evidence.sourceEffectIntegrity.attacks).forEach(result => {
    assert.match(result.error, /ACTIVE_EFFECT|EFFECT_MEMBERSHIP|REVERSAL_LINEAGE/);
    assert.equal(result.writesZero, true);
  });
  Object.values(evidence.pendingLinkIntegrity).forEach(result => {
    assert.match(result.error, /PENDING_REVIEW_LINK/);
    assert.equal(result.writesZero, true);
  });
  assert.equal(evidence.activeSetCoverage.removedMovementReversal.normalRevision, 3);
  assert.equal(evidence.activeSetCoverage.removedPending.normalRevision, 3);
  for (const [attack, result] of Object.entries(evidence.activeSetCoverage)) {
    assert.match(result.inspectError, attack === 'abbreviatedMembership'
      ? /EFFECT_MEMBERSHIP/ : /ACTIVE_(EFFECT|PENDING)_COVERAGE/);
    assert.match(result.executeError, attack === 'abbreviatedMembership'
      ? /EFFECT_MEMBERSHIP/ : /ACTIVE_(EFFECT|PENDING)_COVERAGE/);
    assert.equal(result.writesZero, true, `${attack}: rejection wrote official state`);
  }
  assert.equal(evidence.unresolvedLifecycle.multiAfterOneStatus, 'UNRESOLVED_PRODUCT');
  assert.equal(evidence.unresolvedLifecycle.multiAfterOneActiveLinks, 1);
  assert.equal(evidence.unresolvedLifecycle.multiVisibleAfterOne, true);
  assert.equal(evidence.unresolvedLifecycle.multiAfterAllStatus, 'NO_ACTIVE_REVIEW');
  assert.equal(evidence.unresolvedLifecycle.multiVisibleAfterAll, false);
  assert.equal(evidence.unresolvedLifecycle.soleStatus, 'NO_ACTIVE_REVIEW');
  assert.equal(evidence.unresolvedLifecycle.soleVisible, false);
  assert.match(evidence.unresolvedLifecycle.matchedReuseError, /MATCHED_UNRESOLVED_ID_REUSE/);
  assert.equal(evidence.unresolvedLifecycle.matchedReuseWritesZero, true);
  assert.equal(evidence.unresolvedLifecycle.matchedIdentityStatusAfterReuse, 'MATCHED');
  assert.equal(evidence.unresolvedLifecycle.matchedIdentityProductAfterReuse, `${'V2-STAGE7A-A'}-P2`);
  assert.match(evidence.rejects.staleError, /TARGET_STALE|REVISION/);
  assert.match(evidence.rejects.crossCompany, /DOCUMENT_NOT_FOUND/);
  assert.match(evidence.rejects.arApUnsupported, /ARAP_EFFECT_UNSUPPORTED/);
  assert.match(evidence.rejects.payloadConflict, /PAYLOAD_CONFLICT/);
  assert.equal(evidence.rejects.payloadConflictHeadRevision, 2);
  assert.equal(evidence.rejects.payloadConflictRevisionCount, 1);
  assert.match(evidence.rollback.error, /ConstraintError|constraint|transaction failed/i);
  assert.deepEqual(evidence.rollback.after, evidence.rollback.baselineWithBlocker);
  assert.equal(evidence.rollback.headRevision, 2);
  assert.equal(evidence.rollback.revisionCount, 1);
  assert.equal(evidence.rollback.commandCommitted, false);
  assert.equal(evidence.rollback.injectedPoints.length, 9);
  evidence.rollback.injectedPoints.forEach(point => {
    assert.equal(point.injected, true, `${point.label}: failure was not injected`);
    assert.match(point.error, /INJECTED_|AbortError/);
    assert.equal(point.countsUnchanged, true, `${point.label}: counts changed`);
    assert.equal(point.headUnchanged, true, `${point.label}: head changed`);
    assert.equal(point.revisionCountUnchanged, true, `${point.label}: revision count changed`);
    assert.equal(point.commandCommitted, false, `${point.label}: command committed`);
  });
  const revisionTransactions = evidence.transactions.filter(item => new Set(item.stores).has('voucherRevisions')
    && new Set(item.stores).has('officialCommands') && new Set(item.stores).has('syncQueue')
    && new Set(item.stores).has('inventoryMovements') && new Set(item.stores).has('pendingInventoryEffects'));
  assert.ok(revisionTransactions.length >= 6);
  revisionTransactions.forEach(item => {
    const stores = new Set(item.stores);
    const purchase = stores.has('purchaseDocuments');
    assert.deepEqual(stores, new Set([
      purchase ? 'purchaseDocuments' : 'salesDocuments', purchase ? 'purchaseLines' : 'salesLines',
      'officialCommands', 'voucherRevisions', 'inventoryMovements',
      purchase ? 'payableEntries' : 'receivableEntries', 'pendingInventoryEffects',
      'inventoryCheckpoints', 'unresolvedProducts', 'syncQueue'
    ]));
  });
  const externalMutatingRequests = networkRequests.filter(row => !row.url.startsWith(origin)
    && !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  const localMutatingRequests = requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  assert.equal(externalMutatingRequests.length, 0);
  assert.equal(localMutatingRequests.length, 0);
  assert.deepEqual(exceptions, []);
  const report = {
    taskId: 'NEXUS-SI-V2-07A', status: 'PASS', ...evidence,
    isolation: { externalMutatingRequests: externalMutatingRequests.length,
      localMutatingRequests: localMutatingRequests.length, browserExceptions: exceptions.length }
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
