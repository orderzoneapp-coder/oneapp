import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-customer-master-e2e-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'oneapp-customer-master-fixture-'));
const xlsxPath = join(fixtureDir, 'customers.xlsx');
const xlsPath = join(fixtureDir, 'members.xls');

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
  'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>회사명 : 원앱</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>거래처코드</t></is></c><c r="B2" t="inlineStr"><is><t>거래처명</t></is></c><c r="C2" t="inlineStr"><is><t>여신한도</t></is></c><c r="D2" t="inlineStr"><is><t>주소</t></is></c><c r="E2" t="inlineStr"><is><t>휴대폰</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>C001</t></is></c><c r="C3"><v>0</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>C002</t></is></c><c r="B4" t="inlineStr"><is><t>신규 거래처</t></is></c><c r="C4"><v>25000</v></c><c r="D4" t="inlineStr"><is><t>부산광역시</t></is></c><c r="E4" t="inlineStr"><is><t>010-2222-3333</t></is></c></row></sheetData></worksheet>',
}));

const sheetJsContext = {};
runInNewContext(readFileSync(join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'), 'utf8'), sheetJsContext);
const XLSX = sheetJsContext.XLSX;
assert.ok(XLSX?.write && XLSX?.utils?.aoa_to_sheet, 'vendored SheetJS must initialize for XLS fixture creation');
const xlsWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(xlsWorkbook, XLSX.utils.aoa_to_sheet([
  ['아이디', '이름(거래처명)', '닉네임', '휴대폰번호', '이메일'],
  ['member-1', '테스트 거래처', '테스트상사', '010-9999-9999', 'shop@example.test'],
]), '회원정보');
writeFileSync(xlsPath, Buffer.from(XLSX.write(xlsWorkbook, { bookType: 'biff8', type: 'array' })));

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
const readDb = (client, name) => evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open(${JSON.stringify(name)});r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const stores=['customers','customerEvents','customerSourceLinks','importBatches','sourceRecords'];const tx=db.transaction(stores,'readonly');const out={};let pending=stores.length;stores.forEach(store=>{const q=tx.objectStore(store).getAll();q.onsuccess=()=>{out[store]=q.result;if(--pending===0){db.close();resolve(out);}};q.onerror=()=>reject(q.error);});};})`);

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
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('.cm-tab')].map(element=>element.textContent.trim())`), ['거래처 목록', '정보 보완', 'Excel 등록·수정', '매핑사전', '변경이력', '변경요청', '데이터 이전·복원']);

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
  await input(client, '#customerForm [name="customerName"]', '테스트 거래처');
  await input(client, '#customerForm [name="address"]', '서울특별시');
  await input(client, '#customerForm [name="mobile"]', '010-1111-2222');
  await input(client, '#customerForm [name="erpCode"]', 'C001');
  await input(client, '#customerForm [name="aliases"]', '테스트상사');
  await click(client, '#saveCustomerButton');
  await waitFor(() => evaluate(client, `document.querySelector('#totalCount').textContent==='2' && !document.querySelector('#customerDialog').open`), 'first customer save');
  assert.equal(await evaluate(client, `document.querySelector('#customerTableBody').innerText.includes('테스트 거래처')`), true);

  const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const fileNode = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#customerFileInput' });
  await client.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [xlsxPath] });
  await evaluate(client, `document.querySelector('#customerFileInput').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(() => evaluate(client, `!document.querySelector('#mappingWorkbench').hidden && document.querySelector('#selectedFileName').textContent.includes('거래처')`), 'XLSX mapping preview');
  assert.equal(await evaluate(client, `document.querySelector('#selectedFileName').textContent.includes('헤더 2행 자동 인식')`), true);
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-index="0"]').value`), 'sourceCustomerCode');
  await click(client, '#analyzeImportButton');
  await waitFor(() => evaluate(client, `!document.querySelector('#importResult').hidden && !document.querySelector('#applyImportButton').disabled`), 'XLSX analysis');
  assert.equal(await evaluate(client, `document.querySelector('#importPreviewBody').innerText.includes('기존 거래처 수정')`), true);
  await click(client, '#applyImportButton');
  await waitFor(() => evaluate(client, `document.querySelector('#totalCount').textContent==='3'`), 'XLSX row-by-row apply');

  const data = await readDb(client, dbName);
  assert.equal(data.customers.length, 3);
  assert.equal(data.customers.some((row) => row.customerId === 'LEGACY-1' && row.revision === 3), true);
  const first = data.customers.find((row) => row.customerName === '테스트 거래처');
  assert.equal(first.customerName, '테스트 거래처', 'blank Excel value must preserve the stored name');
  assert.equal(first.creditLimitAmount, 0, 'numeric zero must be applied');
  assert.ok(first.revision >= 2, 'Excel update must advance revision');
  assert.equal(data.customerEvents.every((event) => event.operationId && event.actorId === null && event.actorState === 'UNVERIFIED_LOCAL'), true);
  assert.equal(data.sourceRecords.filter((row) => ['CREATED', 'UPDATED'].includes(row.resultType)).length, 2);
  assert.equal(data.customerSourceLinks.length, 2, 'ERP codes must be stored as source links to NEXUS customers');
  const split = data.customers.find((row) => row.customerName === '신규 거래처');
  await click(client, '.cm-tab[data-tab="mapping"]');
  await input(client, '#mappingSourceReference', split.customerId);
  await input(client, '#mappingTargetReference', first.customerId);
  await click(client, '#mapCustomerButton');
  await waitFor(() => evaluate(client, `document.querySelector('#canonicalMappingsBody').innerText.includes(${JSON.stringify(split.customerId)}) && document.querySelector('#totalCount').textContent==='2'`), 'manual canonical customer mapping');
  const mappedData = await readDb(client, dbName);
  assert.equal(mappedData.customers.find((row) => row.customerId === split.customerId).qualityStatus, 'SUPERSEDED');
  const mappedSnapshot = await evaluate(client, `window.__CUSTOMER_MASTER_DEBUG__.customerReadAdapter.getSnapshot()`);
  assert.equal(mappedSnapshot.data.customers.length, 2, 'snapshot must publish only canonical NEXUS customers');
  assert.equal(mappedSnapshot.data.sourceLinks.find((row) => row.sourceCustomerCode === 'C002').customerId, first.customerId, 'split ERP code must be projected to the canonical NEXUS customer');
  await click(client, '.cm-tab[data-tab="customers"]');
  await input(client, '#customerSearch', 'C002');
  await waitFor(() => evaluate(client, `document.querySelector('#customerTableBody').innerText.includes('테스트 거래처')`), 'ERP source code canonical resolution');
  assert.equal(await evaluate(client, `document.querySelector('#customerTableBody').innerText.includes('신규 거래처')`), false, 'mapped source code must display only the canonical customer');
  await input(client, '#customerSearch', '');
  await click(client, '.cm-tab[data-tab="mapping"]');
  await click(client, `[data-release-customer-mapping="${split.customerId}"]`);
  await waitFor(() => evaluate(client, `document.querySelector('#canonicalMappingsEmpty').hidden===false && document.querySelector('#totalCount').textContent==='3'`), 'manual canonical mapping release');
  const releasedData = await readDb(client, dbName);
  assert.equal(releasedData.customers.find((row) => row.customerId === split.customerId).qualityStatus, 'UNVERIFIED');
  const snapshot = await evaluate(client, `window.__CUSTOMER_MASTER_DEBUG__.createSnapshot()`);
  assert.equal(snapshot.schemaVersion, 'ONEAPP_CUSTOMER_SNAPSHOT_V1');
  assert.equal(snapshot.counts.customers, 3);
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/);

  await client.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [xlsPath] });
  await evaluate(client, `document.querySelector('#customerFileInput').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(() => evaluate(client, `document.querySelector('#selectedFileName').textContent.includes('members.xls')`), 'legacy XLS mapping preview');
  assert.equal(await evaluate(client, `document.querySelector('#importSourceSystem').value`), 'SHOP', 'SHOP workbook headers must select SHOP mode automatically');
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-index="0"]').value`), 'sourceCustomerCode');
  assert.equal(await evaluate(client, `document.querySelector('[data-mapping-index="2"]').value`), 'sourceNickname');
  assert.equal(await evaluate(client, `document.querySelector('#importSourceCodeHeading').textContent`), 'SHOP 회원 아이디');
  await click(client, '#analyzeImportButton');
  await waitFor(() => evaluate(client, `document.querySelector('#importSummary').textContent.includes('연결 확인 필요')`), 'SHOP name-only review');
  assert.equal(await evaluate(client, `document.querySelector('#applyImportButton').disabled`), true, 'unresolved name-only matches must not be applied');
  await click(client, '[data-resolve-review="LINK"]');
  await waitFor(() => evaluate(client, `document.querySelector('#importSummary').textContent.includes('기존 거래처 연결')`), 'manual NEXUS link resolution');
  await click(client, '#applyImportButton');
  await waitFor(async () => (await readDb(client, dbName)).customerSourceLinks.some((row) => row.sourceSystem === 'SHOP' && row.sourceCustomerCode === 'member-1'), 'SHOP source link apply');
  const linkedData = await readDb(client, dbName);
  assert.equal(linkedData.customers.length, 3, 'manual SHOP link must not create a duplicate NEXUS customer');
  assert.equal(linkedData.customerSourceLinks.length, 3);

  const readContract = await evaluate(client, `(async()=>{
    const adapter=window.__CUSTOMER_MASTER_DEBUG__.customerReadAdapter;
    const first=await adapter.getSnapshotResult();
    const second=await adapter.getSnapshot();
    const beforeName=first.snapshot.data.customers[0].customerName;
    try{first.snapshot.data.customers[0].customerName='mutated';}catch{}
    return {status:first.status,schema:first.snapshot.schemaVersion,adapterVersion:first.snapshot.adapterVersion,sameHash:first.snapshot.contentHash===second.contentHash,frozen:Object.isFrozen(first.snapshot)&&Object.isFrozen(first.snapshot.data)&&Object.isFrozen(first.snapshot.data.customers)&&Object.isFrozen(first.snapshot.data.customers[0]),unchanged:first.snapshot.data.customers[0].customerName===beforeName};
  })()`);
  assert.equal(readContract.status, 'READY');
  assert.equal(readContract.schema, 'ONEAPP_CUSTOMER_SNAPSHOT_V1');
  assert.equal(readContract.adapterVersion, 'ONEAPP_CUSTOMER_READ_ADAPTER_V1');
  assert.equal(readContract.sameHash, true);
  assert.equal(readContract.frozen, true);
  assert.equal(readContract.unchanged, true);

  const forcedReadFailure = await evaluate(client, `(async()=>{
    const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(){throw new Error('FORCED_CUSTOMER_READ_FAILURE');};
    try{return await window.__CUSTOMER_MASTER_DEBUG__.customerReadAdapter.getSnapshotResult();}
    finally{IDBDatabase.prototype.transaction=original;}
  })()`);
  assert.equal(forcedReadFailure.status, 'ERROR');
  assert.equal(forcedReadFailure.snapshot, null, 'customer read failure must not masquerade as zero customers');

  const customerRequest = {
    schemaVersion: 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1', requestId: 'CUSTOMER-REQ-1', idempotencyKey: 'CUSTOMER-IDEM-1',
    domain: 'CUSTOMER', ownerAppId: 'customer-master', entityId: first.customerId, operation: 'UPDATE',
    baseSnapshotId: mappedSnapshot.snapshotId, baseRevision: first.revision,
    changes: [{ field: 'customerName', beforeValue: first.customerName, proposedValue: '검토 제안명' }],
    reason: 'Customer browser contract test', source: { appId: 'browser-test' },
    actor: { actorId: null, actorName: 'browser', actorState: 'UNVERIFIED_LOCAL' }, requestedAt: '2026-08-30T00:00:00.000Z',
  };
  const requestReceipts = await evaluate(client, `(async()=>{
    const module=await import('/customer-master/change-request-adapter.js?browser=1');
    const request=${JSON.stringify(customerRequest)};
    const first=await module.customerMasterChangeRequestAdapter.submitChangeRequest(request);
    const replay=await module.customerMasterChangeRequestAdapter.submitChangeRequest(request);
    const conflict=await module.customerMasterChangeRequestAdapter.submitChangeRequest({...request,changes:[{field:'customerName',beforeValue:request.changes[0].beforeValue,proposedValue:'다른 제안'}]});
    const invalid=await module.customerMasterChangeRequestAdapter.submitChangeRequest({...request,requestId:'BAD',idempotencyKey:'BAD',ownerAppId:'master-lookup'});
    const list=await module.customerMasterChangeRequestAdapter.listChangeRequests();
    return {first,replay,conflict,invalid,list};
  })()`);
  assert.equal(requestReceipts.first.status, 'PENDING');
  assert.equal(requestReceipts.replay.status, 'DUPLICATE');
  assert.equal(requestReceipts.conflict.status, 'CONFLICT');
  assert.equal(requestReceipts.invalid.status, 'REJECTED');
  assert.equal(requestReceipts.list.requests.length, 1);

  const inboxState = await evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open(${JSON.stringify(dbName)},1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction(['customers','appMeta'],'readonly');const count=tx.objectStore('customers').count();const inbox=tx.objectStore('appMeta').get('referenceChangeRequestsV1');tx.oncomplete=()=>{const result={version:db.version,stores:[...db.objectStoreNames],count:count.result,inbox:inbox.result};db.close();resolve(result);};tx.onerror=()=>reject(tx.error);};})`);
  assert.equal(inboxState.version, 1, 'customer inbox must not require a DB version migration');
  assert.deepEqual(inboxState.stores.sort(), ['appMeta','customerAliases','customerEvents','customerHeaderMappings','customerSourceLinkEvents','customerSourceLinks','customerUserFieldDefinitions','customers','importBatches','migrationSnapshots','sourceRecords'].sort());
  assert.equal(inboxState.count, 3, 'request receipt must preserve customer records');
  assert.equal(inboxState.inbox.value.requests.length, 1);
  assert.equal((await readDb(client, dbName)).customers.find((row) => row.customerId === first.customerId).customerName, first.customerName, 'request receipt must not apply customer changes');

  await click(client, '.cm-tab[data-tab="requests"]');
  await waitFor(() => evaluate(client, `document.querySelector('#changeRequestInboxBody').innerText.includes('CUSTOMER-REQ-1') && document.querySelector('#changeRequestInboxState').textContent.includes('자동 승인·자동 반영 없음')`), 'customer read-only change-request inbox');
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
