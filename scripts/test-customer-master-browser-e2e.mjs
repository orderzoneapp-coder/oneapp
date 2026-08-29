import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-customer-master-e2e-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'oneapp-customer-master-fixture-'));
const xlsxPath = join(fixtureDir, 'customers.xlsx');

const storedZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

writeFileSync(xlsxPath, storedZip({
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="거래처" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>거래처코드</t></is></c><c r="B1" t="inlineStr"><is><t>거래처명</t></is></c><c r="C1" t="inlineStr"><is><t>여신한도</t></is></c><c r="D1" t="inlineStr"><is><t>주소</t></is></c><c r="E1" t="inlineStr"><is><t>휴대폰</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>C001</t></is></c><c r="C2"><v>0</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>C002</t></is></c><c r="B3" t="inlineStr"><is><t>신규 거래처</t></is></c><c r="C3"><v>25000</v></c><c r="D3" t="inlineStr"><is><t>부산광역시</t></is></c><c r="E3" t="inlineStr"><is><t>010-2222-3333</t></is></c></row></sheetData></worksheet>',
}));

const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = pathname === '/' ? 'customer-master/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
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
  once(method, timeout = 30_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => { this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener)); rejectEvent(new Error(`Timed out waiting for ${method}`)); }, timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
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
const click = (client, selector) => evaluate(client, `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)throw new Error('Missing ${selector}'); element.click(); return true; })()`);
const input = (client, selector, value) => evaluate(client, `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)throw new Error('Missing ${selector}'); const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
const readDb = (client, name) => evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open(${JSON.stringify(name)});r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const stores=['customers','customerEvents','importBatches','sourceRecords'];const tx=db.transaction(stores,'readonly');const out={};let pending=stores.length;stores.forEach(store=>{const q=tx.objectStore(store).getAll();q.onsuccess=()=>{out[store]=q.result;if(--pending===0){db.close();resolve(out);}};q.onerror=()=>reject(q.error);});};})`);

let browserProcess;
let client;
try {
  const address = await listen();
  const browserExecutable = findBrowser();
  assert.ok(browserExecutable, 'Chrome, Chromium, or Edge is required for CustomerMaster browser E2E');
  browserProcess = spawn(browserExecutable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(browserProfile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    if (!existsSync(portFile)) return '';
    return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter((target) => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  const runtimeErrors = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', (event) => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Runtime exception'));
  client.on('Runtime.consoleAPICalled', (event) => { if (event.type === 'error') consoleErrors.push(event.args?.map((value) => value.value || value.description || '').join(' ') || 'console.error'); });

  const dbName = `oneapp-customermaster-e2e-${Date.now()}`;
  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/seed.html` });
  await loaded;
  await evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open('oneapp-orderq-vnext',17);r.onupgradeneeded=()=>{r.result.createObjectStore('customers',{keyPath:'customerId'});};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('customers','readwrite');tx.objectStore('customers').put({customerId:'LEGACY-1',customerCode:'LEG001',erpCustomerCode:'LEG001',customerName:'기존 v17 거래처',normalizedCustomerCode:'leg001',normalizedName:'기존 v17 거래처',looseNormalizedName:'기존v17거래처',status:'ACTIVE',qualityStatus:'UNVERIFIED',canonicalCustomerId:'LEGACY-1',revision:3,createdAt:'2025-01-01T00:00:00.000Z',updatedAt:'2025-01-02T00:00:00.000Z'});tx.oncomplete=()=>{db.close();resolve(true);};tx.onerror=()=>reject(tx.error);};})`);
  console.log('CustomerMaster E2E · legacy v17 fixture ready');
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/customer-master/?customerMasterTestDb=${dbName}` });
  await loaded;
  await waitFor(() => evaluate(client, `document.documentElement.dataset.customerMasterReady==='true'`), 'CustomerMaster ready');
  console.log('CustomerMaster E2E · independent app ready');
  assert.equal(await evaluate(client, 'document.title'), '거래처관리 - NEXUS');
  assert.equal(await evaluate(client, `document.querySelector('[data-nexus-app-header="customer-master"]')?.offsetHeight >= 56`), true);
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('.cm-tab')].map(element=>element.textContent.trim())`), ['거래처 목록', '정보 보완', 'Excel 등록·수정', '매핑사전', '변경이력', '데이터 이전·복원']);

  await click(client, '.cm-tab[data-tab="data"]');
  await click(client, '#inspectLegacyButton');
  await waitFor(() => evaluate(client, `!document.querySelector('#migrateLegacyButton').hidden && document.querySelector('#legacyState').textContent.includes('v17')`), 'legacy v17 inspection');
  console.log('CustomerMaster E2E · legacy v17 inspected');
  await evaluate(client, `window.confirm=()=>true`);
  await click(client, '#migrateLegacyButton');
  await waitFor(() => evaluate(client, `document.querySelector('#totalCount').textContent==='1' && document.querySelector('#legacyState').textContent.includes('복사 완료')`), 'legacy v17 migration and equivalence check');
  console.log('CustomerMaster E2E · legacy v17 migrated and verified');
  assert.equal(await evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open('oneapp-orderq-vnext');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('customers','readonly');const q=tx.objectStore('customers').count();q.onsuccess=()=>{db.close();resolve(q.result);};q.onerror=()=>reject(q.error);};})`), 1, 'legacy source must remain unchanged');
  await click(client, '.cm-tab[data-tab="customers"]');

  await click(client, '#newCustomerButton');
  await waitFor(() => evaluate(client, `document.querySelector('#customerDialog').open`), 'customer dialog');
  await input(client, '#customerForm [name="customerCode"]', 'C001');
  await input(client, '#customerForm [name="customerName"]', '테스트 거래처');
  await input(client, '#customerForm [name="address"]', '서울특별시');
  await input(client, '#customerForm [name="mobile"]', '010-1111-2222');
  await input(client, '#customerForm [name="erpCode"]', 'ERP-C001');
  await input(client, '#customerForm [name="aliases"]', '테스트상사');
  await click(client, '#saveCustomerButton');
  await waitFor(() => evaluate(client, `document.querySelector('#totalCount').textContent==='2' && !document.querySelector('#customerDialog').open`), 'first customer save');
  assert.equal(await evaluate(client, `document.querySelector('#customerTableBody').innerText.includes('테스트 거래처')`), true);

  const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const fileNode = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#customerFileInput' });
  await client.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [xlsxPath] });
  await evaluate(client, `document.querySelector('#customerFileInput').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(() => evaluate(client, `!document.querySelector('#mappingWorkbench').hidden && document.querySelector('#selectedFileName').textContent.includes('거래처')`), 'XLSX mapping preview');
  await click(client, '#analyzeImportButton');
  await waitFor(() => evaluate(client, `!document.querySelector('#importResult').hidden && !document.querySelector('#applyImportButton').disabled`), 'XLSX analysis');
  assert.equal(await evaluate(client, `document.querySelector('#importPreviewBody').innerText.includes('기존 거래처 수정')`), true);
  await click(client, '#applyImportButton');
  await waitFor(() => evaluate(client, `document.querySelector('#totalCount').textContent==='3'`), 'XLSX row-by-row apply');

  const data = await readDb(client, dbName);
  assert.equal(data.customers.length, 3);
  assert.equal(data.customers.some((row) => row.customerId === 'LEGACY-1' && row.revision === 3), true);
  const first = data.customers.find((row) => row.customerCode === 'C001');
  assert.equal(first.customerName, '테스트 거래처', 'blank Excel value must preserve the stored name');
  assert.equal(first.creditLimitAmount, 0, 'numeric zero must be applied');
  assert.ok(first.revision >= 2, 'Excel update must advance revision');
  assert.equal(data.customerEvents.every((event) => event.operationId && event.actorId === null && event.actorState === 'UNVERIFIED_LOCAL'), true);
  assert.equal(data.sourceRecords.filter((row) => ['CREATED', 'UPDATED'].includes(row.resultType)).length, 2);
  const snapshot = await evaluate(client, `window.__CUSTOMER_MASTER_DEBUG__.createSnapshot()`);
  assert.equal(snapshot.schemaVersion, 'ONEAPP_CUSTOMER_SNAPSHOT_V1');
  assert.equal(snapshot.counts.customers, 3);
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(consoleErrors, []);
  console.log(`PASS CustomerMaster browser E2E · customers=${data.customers.length} · events=${data.customerEvents.length}`);
} finally {
  client?.close();
  if (browserProcess && !browserProcess.killed) {
    const exited = new Promise((resolveExit) => browserProcess.once('exit', resolveExit));
    browserProcess.kill();
    await Promise.race([exited, wait(3_000)]);
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  await wait(500);
  for (const temporaryPath of [browserProfile, fixtureDir]) {
    try { rmSync(temporaryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error;
    }
  }
}
