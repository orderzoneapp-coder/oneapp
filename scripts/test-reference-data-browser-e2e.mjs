import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-refdata-e2e-'));
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
let blockRequestAdapters = false;

const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/blank.html') return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><html><body>reference test</body></html>');
    if (blockRequestAdapters && (pathname.endsWith('/product-change-request-adapter.js') || pathname === '/customer-master/change-request-adapter.js')) return response.writeHead(503).end('Adapter unavailable test');
    const relativePath = `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
    const filePath = normalize(resolve(root, relativePath));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    response.end(readFileSync(filePath));
  } catch (error) { response.writeHead(500).end(String(error)); }
});

const listen = () => new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});
const commandPath = (command) => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '' : '';
};
const findBrowser = () => [
  process.env.CHROME_PATH,
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge'),
].filter(Boolean).find(existsSync) || '';
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};

class CdpClient {
  constructor(url) { this.url = url; this.socket = null; this.nextId = 1; this.pending = new Map(); this.events = new Map(); }
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
  close() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Browser evaluation failed');
  return response.result.value;
};

let browserProcess;
let client;
try {
  const address = await listen();
  const browserExecutable = findBrowser();
  assert.ok(browserExecutable, 'Chrome, Chromium, or Edge is required for reference-data browser E2E');
  browserProcess = spawn(browserExecutable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const activePortFile = join(browserProfile, 'DevToolsActivePort');
  await waitFor(() => existsSync(activePortFile), 'browser debugging port');
  const [debugPort] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const values = response.ok ? await response.json() : [];
    return values.find((target) => target.type === 'page') ? values : null;
  }, 'browser page target');
  client = new CdpClient(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  const runtimeErrors = [];
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => runtimeErrors.push(exceptionDetails.text || 'exception'));
  client.on('Runtime.consoleAPICalled', ({ type, args }) => { if (type === 'error') runtimeErrors.push(args.map((arg) => arg.value || arg.description || '').join(' ')); });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/blank.html` });
  await waitFor(() => evaluate(client, `document.readyState === 'complete'`), 'blank page');

  const emptyResult = await evaluate(client, `(async()=>{
    const before=(await indexedDB.databases()).map(row=>row.name);
    const module=await import('/reference-data/product-master-read-adapter.js?empty=1');
    const result=await module.productMasterReadAdapter.getSnapshotResult();
    const after=(await indexedDB.databases()).map(row=>row.name);
    return {status:result.status,count:result.snapshot?.data.products.length,before,after};
  })()`);
  assert.equal(emptyResult.status, 'EMPTY');
  assert.equal(emptyResult.count, 0);
  assert.equal(emptyResult.before.includes('MerchOpsDB'), false);
  assert.equal(emptyResult.after.includes('MerchOpsDB'), false, 'read-only empty lookup must not create MerchOpsDB');

  await evaluate(client, `new Promise((resolve,reject)=>{
    localStorage.setItem('merchMaster_v870','{broken-json');
    const request=indexedDB.open('MerchOpsDB',2);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('store'))db.createObjectStore('store');if(!db.objectStoreNames.contains('master_products'))db.createObjectStore('master_products',{keyPath:'코드'});};
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['store','master_products'],'readwrite');tx.objectStore('master_products').put({코드:'P-STORE',품목명:'Store source',규격:'',재고:0,custom:'keep'});tx.objectStore('store').put({'P-FALLBACK':{코드:'P-FALLBACK',품목명:'fallback'}},'merchMaster_v870');tx.objectStore('store').put(41,'merchMaster_revision_v870');tx.oncomplete=()=>{db.close();resolve(true);};tx.onerror=()=>reject(tx.error);};
  })`);

  const ready = await evaluate(client, `(async()=>{
    const module=await import('/reference-data/product-master-read-adapter.js?ready=1');
    const first=await module.productMasterReadAdapter.getSnapshotResult();
    const second=await module.productMasterReadAdapter.getSnapshotResult();
    globalThis.__heldProductSnapshot=first.snapshot;
    return {status:first.status,source:first.snapshot.source,version:first.snapshot.snapshotVersion,hash:first.snapshot.contentHash,sameHash:first.snapshot.contentHash===second.snapshot.contentHash,sameId:first.snapshot.snapshotId===second.snapshot.snapshotId,row:first.snapshot.data.products[0],frozen:Object.isFrozen(first.snapshot)&&Object.isFrozen(first.snapshot.data)&&Object.isFrozen(first.snapshot.data.products)&&Object.isFrozen(first.snapshot.data.products[0])};
  })()`);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.source, 'INDEXEDDB_RECORD_STORE');
  assert.equal(ready.version, '41');
  assert.equal(ready.sameHash, true);
  assert.equal(ready.sameId, true);
  assert.equal(ready.row.규격, '');
  assert.equal(ready.row.재고, 0);
  assert.equal(ready.row.custom, 'keep');
  assert.equal(ready.frozen, true);

  const request = {
    schemaVersion: 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1', requestId: 'PRODUCT-REQ-1', idempotencyKey: 'PRODUCT-IDEM-1',
    domain: 'PRODUCT', ownerAppId: 'master-lookup', entityId: 'P-STORE', operation: 'UPDATE',
    baseSnapshotId: 'PRODUCT-41', baseRevision: 41,
    changes: [{ field: '품목명', beforeValue: 'Store source', proposedValue: 'Proposed only' }],
    reason: 'browser contract test', source: { appId: 'browser-test' },
    actor: { actorId: null, actorName: 'browser', actorState: 'UNVERIFIED_LOCAL' }, requestedAt: '2026-08-30T00:00:00.000Z',
  };
  const receipts = await evaluate(client, `(async()=>{
    const module=await import('/reference-data/product-change-request-adapter.js?inbox=1');
    const request=${JSON.stringify(request)};
    const first=await module.productMasterChangeRequestAdapter.submitChangeRequest(request);
    const replay=await module.productMasterChangeRequestAdapter.submitChangeRequest(request);
    const conflict=await module.productMasterChangeRequestAdapter.submitChangeRequest({...request,changes:[{field:'품목명',beforeValue:'Store source',proposedValue:'different'}]});
    const invalid=await module.productMasterChangeRequestAdapter.submitChangeRequest({...request,requestId:'BAD',idempotencyKey:'BAD',changes:[]});
    const list=await module.productMasterChangeRequestAdapter.listChangeRequests();
    return {first,replay,conflict,invalid,list};
  })()`);
  assert.equal(receipts.first.status, 'PENDING');
  assert.equal(receipts.replay.status, 'DUPLICATE');
  assert.equal(receipts.conflict.status, 'CONFLICT');
  assert.equal(receipts.invalid.status, 'REJECTED');
  assert.equal(receipts.list.requests.length, 1);

  const preserved = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('MerchOpsDB',2);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['store','master_products'],'readonly');const product=tx.objectStore('master_products').get('P-STORE');const snapshot=tx.objectStore('store').get('merchMaster_v870');const revision=tx.objectStore('store').get('merchMaster_revision_v870');const inbox=tx.objectStore('store').get('oneappProductReferenceChangeRequests_v1');tx.oncomplete=()=>{const result={version:db.version,stores:[...db.objectStoreNames],product:product.result,snapshot:snapshot.result,revision:revision.result,inbox:inbox.result};db.close();resolve(result);};tx.onerror=()=>reject(tx.error);};})`);
  assert.equal(preserved.version, 2);
  assert.deepEqual(preserved.stores.sort(), ['master_products', 'store']);
  assert.equal(preserved.product.품목명, 'Store source', 'request receipt must not apply master changes');
  assert.equal(preserved.revision, 41);
  assert.equal(preserved.snapshot['P-FALLBACK'].품목명, 'fallback');
  assert.equal(preserved.inbox.requests.length, 1);

  await evaluate(client, `new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/coreEngine.js?product-registration-e2e=1';script.onload=()=>resolve(true);script.onerror=()=>reject(new Error('coreEngine load failed'));document.head.appendChild(script);})`);
  const registration = await evaluate(client, `(async()=>{
    const readModule=await import('/reference-data/product-master-read-adapter.js?registration-base=1');
    const baseResult=await readModule.productMasterReadAdapter.getSnapshotResult();
    const commandModule=await import('/reference-data/product-master-command-adapter.js?registration-command=1');
    const command={
      schemaVersion:'MERCHOPS_PRODUCT_REGISTRATION_V1',operationId:'BROWSER-MERCHOPS-REGISTER-1',
      ownerAppId:'master-lookup',sourceAppId:'merchops',expectedRevision:baseResult.snapshot.snapshotVersion,
      baseSnapshotId:baseResult.snapshot.snapshotId,baseContentHash:baseResult.snapshot.contentHash,
      reason:'browser product registration e2e',actor:{actorId:'browser-tester',actorState:'UNVERIFIED_LOCAL'},
      products:[{코드:'P-NEW',품목코드:'P-NEW',품목명:'브라우저 신규상품',규격:'1kg',단위:'BOX',입고가:0,구매처:'공급사',창고:'01',기본:'1',과세:0}]
    };
    const first=await commandModule.productMasterCommandAdapter.registerMerchOpsProducts(command);
    const replay=await commandModule.productMasterCommandAdapter.registerMerchOpsProducts(command);
    const finalResult=await readModule.productMasterReadAdapter.getSnapshotResult();
    const product=finalResult.snapshot.data.products.find(row=>row.코드==='P-NEW');
    const history=JSON.parse(localStorage.getItem('merchHistory_v870')||'[]').filter(row=>row.operationId===command.operationId);
    return {firstStatus:first.status,replayStatus:replay.status,firstRevision:first.revision,finalRevision:finalResult.snapshot.snapshotVersion,product,historyCount:history.length,firstHistoryCount:first.historyCount,error:first.error,replayError:replay.error,rollback:first.rollback};
  })()`);
  assert.equal(registration.firstStatus, 'APPLIED', JSON.stringify(registration));
  assert.equal(registration.replayStatus, 'DUPLICATE', JSON.stringify(registration));
  assert.equal(registration.firstRevision, registration.finalRevision);
  assert.equal(registration.product.품목명, '브라우저 신규상품');
  assert.equal(registration.product.입고가, 0);
  assert.equal('수량' in registration.product, false);
  assert.equal('기준일자' in registration.product, false);
  assert.equal(registration.historyCount, registration.firstHistoryCount, 'browser retry must not duplicate registration history');

  const immutableCopy = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('MerchOpsDB',2);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('master_products','readwrite');tx.objectStore('master_products').put({코드:'P-STORE',품목명:'Owner changed later'});tx.oncomplete=()=>{db.close();resolve({held:globalThis.__heldProductSnapshot.data.products[0].품목명});};tx.onerror=()=>reject(tx.error);};})`);
  assert.equal(immutableCopy.held, 'Store source', 'an already copied Snapshot must not change with a later owner revision');

  await evaluate(client, `new Promise((resolve,reject)=>{const deletion=indexedDB.deleteDatabase('MerchOpsDB');deletion.onerror=()=>reject(deletion.error);deletion.onsuccess=()=>{const request=indexedDB.open('MerchOpsDB',2);request.onupgradeneeded=()=>request.result.createObjectStore('store');request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve(true);};};})`);
  const errorResult = await evaluate(client, `(async()=>{const module=await import('/reference-data/product-master-read-adapter.js?error=1');const result=await module.productMasterReadAdapter.getSnapshotResult();return {status:result.status,snapshot:result.snapshot,code:result.error?.code};})()`);
  assert.equal(errorResult.status, 'ERROR');
  assert.equal(errorResult.snapshot, null, 'read failure must not masquerade as a zero-row snapshot');
  assert.equal(errorResult.code, 'PRODUCT_DB_CONTRACT_STORE_MISSING');

  await evaluate(client, `new Promise((resolve,reject)=>{const deletion=indexedDB.deleteDatabase('MerchOpsDB');deletion.onerror=()=>reject(deletion.error);deletion.onsuccess=()=>resolve(true);})`);
  blockRequestAdapters = true;
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/Master.html?adapterFailure=1` });
  await waitFor(() => evaluate(client, `document.body?.innerText.includes('Excel 최초 등록 또는 상품 단건 등록으로 시작하세요') && document.querySelector('[data-product-change-request-inbox="ERROR"]')?.innerText.includes('Inbox 진단')`), 'Master core with unavailable request adapter', 45_000);
  assert.equal(await evaluate(client, `document.getElementById('boot-error')?.style.display !== 'block'`), true);

  const customerDb = `oneapp-customermaster-adapter-failure-${Date.now()}`;
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/customer-master/?customerMasterTestDb=${customerDb}` });
  await waitFor(() => evaluate(client, `document.documentElement.dataset.customerMasterReady==='true'`), 'CustomerMaster core with request adapter not yet loaded');
  await evaluate(client, `document.querySelector('.cm-tab[data-tab="requests"]').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('#changeRequestInboxState').textContent.includes('사용할 수 없습니다')`), 'CustomerMaster unavailable request adapter diagnostic');
  assert.equal(await evaluate(client, `document.documentElement.dataset.customerMasterReady==='true' && !!document.querySelector('#newCustomerButton')`), true, 'request adapter failure must not block CustomerMaster core');
  assert.deepEqual(runtimeErrors, [], `browser console/runtime errors: ${runtimeErrors.join(' | ')}`);
  console.log('PASS reference Snapshot, no-create read, idempotent inbox, product registration owner command, owner failure isolation, and browser console');
} finally {
  client?.close();
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    const exited = new Promise((resolveExit) => browserProcess.once('exit', resolveExit));
    browserProcess.kill();
    await Promise.race([exited, wait(3_000)]);
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  await wait(500);
  if (existsSync(browserProfile)) {
    try { rmSync(browserProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error;
    }
  }
}
