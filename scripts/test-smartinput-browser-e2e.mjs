import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const acceptanceXlsxPath = process.env.SMARTINPUT_ACCEPTANCE_XLSX ? resolve(process.env.SMARTINPUT_ACCEPTANCE_XLSX) : '';
const acceptanceHeaders = ['일자', '담당', '창고코드', '단위', '품목코드', '품목명', '규격', '수량', '재고', '단가', '적요', '적요1', '거래처', '그룹'];
if (acceptanceXlsxPath) assert.ok(existsSync(acceptanceXlsxPath), `acceptance workbook not found: ${acceptanceXlsxPath}`);
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-e2e-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-fixtures-'));
const screenshotDir = resolve(process.env.SMARTINPUT_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const tsvPath = join(fixtureDir, 'smartinput.tsv');
const csvPath = join(fixtureDir, 'smartinput.csv');
const xlsxPath = join(fixtureDir, 'smartinput.xlsx');
const photoPath = join(fixtureDir, 'source.png');
writeFileSync(tsvPath, '품목코드\t품목명\t수량\t단위\t단가\nTSV-1\tTSV 상품\t2\tEA\t1500');
writeFileSync(csvPath, '품목코드,품목명,수량,단위,단가\nCSV-1,CSV 상품,4,EA,2100');
writeFileSync(xlsxPath, 'XLSX_STUB_FIXTURE');
writeFileSync(photoPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.tsv': 'text/tab-separated-values; charset=utf-8' };
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = pathname === '/'
      ? 'smartinput/index.html'
      : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
    const filePath = normalize(resolve(root, relativePath));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return response.writeHead(404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Fixture</title>');
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    response.end(readFileSync(filePath));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
const listen = () => new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});
const commandPath = command => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || '' : '';
};
const findBrowser = () => [
  process.env.CHROME_PATH,
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge')
].filter(Boolean).find(existsSync) || '';
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
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
    return new Promise((resolveSend, rejectSend) => { this.pending.set(id, { resolve: resolveSend, reject: rejectSend }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  once(method, timeout = 30_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(value => value !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => { this.events.set(method, (this.events.get(method) || []).filter(value => value !== listener)); rejectEvent(new Error(`Timed out waiting for ${method}`)); }, timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  on(method, listener) {
    this.events.set(method, [...(this.events.get(method) || []), listener]);
    return () => this.events.set(method, (this.events.get(method) || []).filter(value => value !== listener));
  }
  close() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Browser evaluation failed');
  return response.result.value;
};
const waitForExpression = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) throw new Error('missing ${selector}'); element.click(); return true; })()`);
const input = (client, selector, value) => evaluate(client, `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) throw new Error('missing ${selector}'); const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return element.value; })()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const path = join(screenshotDir, name);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  return path;
};
const readSmartInputDb = client => evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open('oneapp-smartinput',3);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const names=[...db.objectStoreNames];const tx=db.transaction(names,'readonly');const out={};let pending=names.length;names.forEach(name=>{const q=tx.objectStore(name).getAll();q.onsuccess=()=>{out[name]=q.result;if(--pending===0){db.close();resolve(out);}};q.onerror=()=>reject(q.error);});};})`);

let browserProcess;
let client;
try {
  const address = await listen();
  const browserExecutable = findBrowser();
  assert.ok(browserExecutable, 'Chrome, Chromium, or Edge is required for SmartInput browser E2E');
  browserProcess = spawn(browserExecutable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(browserProfile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), 'browser debugging port');
  const [debugPort] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('DOM.enable');
  const runtimeErrors = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.text || 'Runtime exception'));
  client.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push(event.args?.map(value => value.value || value.description || '').join(' ') || 'console.error');
  });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/seed.html` });
  await loaded;
  const originalDraftBytes = '{"schemaVersion":"ONEAPP_SMART_INPUT_DRAFT_V1","appId":"smart-input","sentinel":"EXISTING_BYTES"}';
  await evaluate(client, `(() => { localStorage.setItem('oneapp.smartinput.draft.v1', ${JSON.stringify(originalDraftBytes)}); return new Promise((resolve,reject)=>{const r=indexedDB.open('oneapp-smartinput',3);r.onupgradeneeded=()=>{const db=r.result;const defs=[['settings','key'],['customerLinkGroups','linkGroupId'],['temporaryCustomers','customerId'],['customerAliasMappings','aliasMappingId'],['estimates','estimateId'],['sourceImages','documentId']];defs.forEach(([name,keyPath])=>{if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath});});};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction([...db.objectStoreNames],'readwrite');tx.objectStore('settings').put({key:'app',marker:'KEEP-SETTINGS'});tx.objectStore('customerLinkGroups').put({linkGroupId:'L1',marker:'KEEP-LINK'});tx.objectStore('temporaryCustomers').put({customerId:'C1',marker:'KEEP-CUSTOMER'});tx.objectStore('customerAliasMappings').put({aliasMappingId:'A1',marker:'KEEP-ALIAS'});tx.objectStore('estimates').put({estimateId:'E1',catalogName:'기존 견적',createdAt:'2026-01-01',marker:'KEEP-ESTIMATE'});tx.objectStore('sourceImages').put({documentId:'D1',mode:'order',marker:'KEEP-IMAGE'});tx.oncomplete=()=>{db.close();resolve(true);};tx.onerror=()=>reject(tx.error);};}); })()`);
  const beforeDb = await readSmartInputDb(client);

  const coldStart = Date.now();
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  try {
    await waitForExpression(client, `Boolean(window.__SMARTINPUT_DEBUG__) && Boolean(document.querySelector('#workTableBody'))`, 'SmartInput local shell');
  } catch (error) {
    const diagnostic = await evaluate(client, `({title:document.title,body:document.body?.innerText?.slice(0,1000),scripts:[...document.scripts].map(script=>({src:script.src,type:script.type})),debug:typeof window.__SMARTINPUT_DEBUG__})`);
    throw new Error(`${error.message} · ${JSON.stringify(diagnostic)}`);
  }
  const coldMs = Date.now() - coldStart;
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: false });
  await loaded;
  await waitForExpression(client, `Boolean(window.__SMARTINPUT_DEBUG__) && Boolean(document.querySelector('#workTableBody'))`, 'warm SmartInput local shell');
  const warmMs = await evaluate(client, `Math.round(performance.getEntriesByName('smartinput-ready')[0]?.startTime || performance.now())`);
  assert.ok(warmMs < 15_000, `local shell must not wait on the removed long reference bootstrap, observed ${warmMs}ms`);
  await wait(700);
  assert.equal(await evaluate(client, `localStorage.getItem('oneapp.smartinput.draft.v1')`), originalDraftBytes, 'opening the app must not rewrite existing draft bytes');
  assert.deepEqual(await readSmartInputDb(client), beforeDb, 'opening and failed reference loads must preserve every existing DB record');
  await evaluate(client, `(async()=>{const failure=code=>async()=>{const error=new Error(code);error.code=code;throw error;};window.__SMARTINPUT_INTEGRATION_BRIDGE__={loadCustomers:failure('CUSTOMER_TEST_ERROR'),loadProducts:failure('PRODUCT_TEST_ERROR'),loadWarehouses:failure('WAREHOUSE_TEST_ERROR')};await Promise.all(['customer','product','warehouse'].map(area=>window.__SMARTINPUT_DEBUG__.refreshReference(area)));return true;})()`);
  await waitForExpression(client, `[...document.querySelectorAll('[data-reference]')].every(element=>element.dataset.state==='error')`, 'isolated reference errors');
  assert.equal(await evaluate(client, `document.querySelector('#smartInputApp').offsetHeight > 0`), true);

  const initialWorkTable = await evaluate(client, `({
    actualRows: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length,
    visibleRows: document.querySelectorAll('#workTableBody tr').length,
    virtualRows: document.querySelectorAll('#workTableBody tr[data-virtual-row="true"]').length,
    summary: document.querySelector('#rowSummary').textContent,
    emptyHidden: document.querySelector('#tableEmpty').hidden
  })`);
  assert.deepEqual(initialWorkTable, { actualRows: 0, visibleRows: 3, virtualRows: 3, summary: '0행 · 수량 0 · 금액 0', emptyHidden: true },
    'an empty draft must show three editable UI-only rows without changing business totals');

  await input(client, '#workTableBody tr[data-virtual-row="true"] input[data-field="itemName"]', '가상행 최초 입력');
  assert.deepEqual(await evaluate(client, `({
    actualRows: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length,
    itemName: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows[0]?.itemName,
    visibleRows: document.querySelectorAll('#workTableBody tr').length,
    virtualRows: document.querySelectorAll('#workTableBody tr[data-virtual-row="true"]').length,
    summary: document.querySelector('#rowSummary').textContent
  })`), { actualRows: 1, itemName: '가상행 최초 입력', visibleRows: 3, virtualRows: 2, summary: '1행 · 수량 0 · 금액 0' },
  'the first value entered in a virtual row must create exactly one real row');
  await click(client, '#workTableBody tr[data-row-id] [data-delete-row]');
  assert.deepEqual(await evaluate(client, `({
    actualRows: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length,
    visibleRows: document.querySelectorAll('#workTableBody tr').length,
    virtualRows: document.querySelectorAll('#workTableBody tr[data-virtual-row="true"]').length
  })`), { actualRows: 0, visibleRows: 3, virtualRows: 3 }, 'deleting the real row must restore three UI-only rows');

  await evaluate(client, `(() => {
    const target = document.querySelector('#workTableBody tr[data-virtual-row="true"] input[data-field="itemCode"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: type => type === 'text/plain' ? 'GRID-1\\t붙여넣기 1\\t\\t2\\tEA\\t100\\nGRID-2\\t붙여넣기 2\\t\\t3\\tEA\\t200' : '' } });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  assert.deepEqual(await evaluate(client, `({
    actualRows: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length,
    itemCodes: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.map(row => row.itemCode),
    quantities: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.map(row => row.quantity),
    visibleRows: document.querySelectorAll('#workTableBody tr').length,
    virtualRows: document.querySelectorAll('#workTableBody tr[data-virtual-row="true"]').length
  })`), { actualRows: 2, itemCodes: ['GRID-1', 'GRID-2'], quantities: [2, 3], visibleRows: 3, virtualRows: 1 },
  'grid paste starting on a virtual row must append only pasted real rows');
  await click(client, '#addRowButton');
  assert.deepEqual(await evaluate(client, `({
    actualRows: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length,
    visibleRows: document.querySelectorAll('#workTableBody tr').length,
    virtualRows: document.querySelectorAll('#workTableBody tr[data-virtual-row="true"]').length
  })`), { actualRows: 3, visibleRows: 3, virtualRows: 0 }, 'three real rows must not render any virtual row');
  await click(client, '#workTableBody tr[data-row-id] [data-delete-row]');
  await click(client, '#workTableBody tr[data-row-id] [data-delete-row]');
  await click(client, '#workTableBody tr[data-row-id] [data-delete-row]');
  await click(client, '#addRowButton');
  await waitForExpression(client, `Boolean(document.activeElement?.closest('tr[data-row-id]'))`, 'new real row focus');
  assert.deepEqual(await evaluate(client, `({
    actualRows: window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length,
    visibleRows: document.querySelectorAll('#workTableBody tr').length,
    virtualRows: document.querySelectorAll('#workTableBody tr[data-virtual-row="true"]').length,
    actualRowFocused: Boolean(document.activeElement?.closest('tr[data-row-id]'))
  })`), { actualRows: 1, visibleRows: 3, virtualRows: 2, actualRowFocused: true },
  'the existing add-row action must still create and focus one real row');
  await click(client, '#workTableBody tr[data-row-id] [data-delete-row]');

  const initialMode = await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.activeMode`);
  for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.slice(-1), modifiers: 1 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.slice(-1), modifiers: 1 });
  }
  assert.equal(await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.activeMode`), initialMode, 'voucher mode must ignore modifier-number keys');
  for (const mode of ['purchase', 'sale', 'estimate', 'order']) {
    const feedback = await evaluate(client, `(() => { const start=performance.now(); document.querySelector('[data-mode="${mode}"]').click(); return {mode:window.__SMARTINPUT_DEBUG__.getState().draft.activeMode,ms:performance.now()-start}; })()`);
    assert.equal(feedback.mode, mode);
    assert.ok(feedback.ms < 100, `tab feedback for ${mode} should be under 100ms`);
  }

  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
  await click(client, '[data-method="text"]');
  await input(client, '#sourceTextInput', 'OFF-1 오프라인상품 3 EA 1200');
  await click(client, '#analyzeTextButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length===0 && window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.length===1`, 'offline text staging');
  await click(client, '#applyStagingButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length===1`, 'offline text apply');
  await input(client, '#customerInput', '수동 거래처');
  await input(client, '#voucherDateInput', '2026-08-29');
  await input(client, '#warehouseInput', '수동 창고');
  await click(client, '#saveDraftButton');
  assert.match(await evaluate(client, `localStorage.getItem('oneapp.smartinput.draft.v1')`), /오프라인상품/);

  await click(client, '[data-method="paste"]');
  await input(client, '#pasteInput', '품목코드\t품목명\t수량\t단위\t단가\nP-1\t붙여넣기상품\t2\tEA\t2500');
  await click(client, '#analyzePasteButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length===1 && window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.some(row=>row.itemCode==='P-1')`, 'clipboard table staging');
  await click(client, '#applyStagingButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length===2`, 'clipboard table apply');

  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' });
  await click(client, '[data-method="excel"]');
  const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const sheetNode = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#sheetFileInput' });
  await client.send('DOM.setFileInputFiles', { nodeId: sheetNode.nodeId, files: [tsvPath] });
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.some(row=>row.itemCode==='TSV-1') && !window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.some(row=>row.itemCode==='TSV-1')`, 'TSV staging');
  await click(client, '#applyStagingButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.some(row=>row.itemCode==='TSV-1')`, 'TSV apply');
  await client.send('DOM.setFileInputFiles', { nodeId: sheetNode.nodeId, files: [csvPath] });
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.some(row=>row.itemCode==='CSV-1') && !window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.some(row=>row.itemCode==='CSV-1')`, 'CSV staging');
  await click(client, '#applyStagingButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.some(row=>row.itemCode==='CSV-1')`, 'CSV apply');
  await evaluate(client, `(() => {
    window.__SMARTINPUT_EXTERNALS__ = {
      ...(window.__SMARTINPUT_EXTERNALS__ || {}),
      XLSX: {
        read: () => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }),
        utils: { sheet_to_json: () => [['품목코드','품목명','수량','단위','단가'],['XLSX-1','Excel 상품','5','EA','3200']] }
      }
    };
    return true;
  })()`);
  await client.send('DOM.setFileInputFiles', { nodeId: sheetNode.nodeId, files: [xlsxPath] });
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.some(row=>row.itemCode==='XLSX-1') && !window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.some(row=>row.itemCode==='XLSX-1')`, 'Excel workbook staging');
  await click(client, '#applyStagingButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.some(row=>row.itemCode==='XLSX-1')`, 'Excel workbook apply');

  await click(client, '[data-method="photo"]');
  const photoNode = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#photoFileInput' });
  await client.send('DOM.setFileInputFiles', { nodeId: photoNode.nodeId, files: [photoPath] });
  await waitForExpression(client, `!document.querySelector('#photoImage').hidden && document.querySelector('#photoImage').complete`, 'immediate photo preview');
  const rowsBeforeOcr = await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length`);
  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
  await click(client, '#ocrButton');
  await waitForExpression(client, `document.querySelector('#ocrMessage').dataset.state==='error'`, 'isolated OCR CDN failure');
  assert.equal(await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length`), rowsBeforeOcr);
  await click(client, '[data-method="voice"]');
  await click(client, '#voiceButton');
  await waitForExpression(client, `document.querySelector('#voiceMessage').textContent.length>0`, 'isolated speech availability');

  await evaluate(client, `window.__SMARTINPUT_INTEGRATION_BRIDGE__={createOrder:async payload=>({order:{orderId:'BROWSER-O1'},payload}),syncOrder:async()=>{const error=new Error('offline');error.code='ORDER_SYNC_OFFLINE';throw error;},finalizePurchase:async()=>{const error=new Error('auth');error.code='AUTH_REQUIRED';throw error;},finalizeSale:async()=>{const error=new Error('revision');error.code='REVISION_CONFLICT';throw error;}}`);
  await click(client, '[data-mode="order"]');
  await click(client, '#completeButton');
  await waitForExpression(client, `document.querySelector('#deliveryMessage').textContent.includes('로컬 저장 완료')`, 'order local-first result');

  await click(client, '[data-method="paste"]');
  await input(client, '#pasteInput', '일자\t창고코드\t품목코드\t품목명\t수량\t단위\t단가\t거래처\n2026/08/29\t88\tPART-1\t부분성공 상품\t1\tEA\t1000\t성공 거래처\n2026/08/29\t88\tPART-2\t부분실패 상품\t1\tEA\t2000\t실패 거래처');
  await click(client, '#analyzePasteButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.length===2`, 'two-group order staging');
  await click(client, '#applyStagingButton');
  await evaluate(client, `window.__SMARTINPUT_INTEGRATION_BRIDGE__={createOrder:async payload=>{if(payload.customerName==='실패 거래처'){const error=new Error('group failed');error.code='GROUP_FAILED';throw error;}return {order:{orderId:'PART-'+payload.customerName}};},syncOrder:async()=>({ok:true}),finalizePurchase:async()=>{const error=new Error('auth');error.code='AUTH_REQUIRED';throw error;},finalizeSale:async()=>{const error=new Error('revision');error.code='REVISION_CONFLICT';throw error;}}`);
  await click(client, '#completeButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.groupDeliveryResults?.some(result=>result.status==='FAILED')`, 'partial order group failure');
  assert.deepEqual(await evaluate(client, `(() => {const mode=window.__SMARTINPUT_DEBUG__.getState().draft.modes.order;return {rows:mode.rows.length,success:mode.groupDeliveryResults.filter(result=>result.status==='SUCCESS').length,failed:mode.groupDeliveryResults.filter(result=>result.status==='FAILED').length,retryVisible:!document.querySelector('#retryFailedButton').hidden,remainingCustomer:mode.rows[0]?.rowCustomerName};})()`),
    { rows: 1, success: 1, failed: 1, retryVisible: true, remainingCustomer: '실패 거래처' },
    'only the failed customer group must remain after partial order delivery');
  await evaluate(client, `window.__SMARTINPUT_INTEGRATION_BRIDGE__.createOrder=async payload=>({order:{orderId:'RETRY-'+payload.customerName}})`);
  await click(client, '#retryFailedButton');
  await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows.length===0 && window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.groupDeliveryResults.every(result=>result.status==='SUCCESS')`, 'failed group retry');

  for (const [mode, code] of [['purchase', 'AUTH_REQUIRED'], ['sale', 'REVISION_CONFLICT']]) {
    await click(client, `[data-mode="${mode}"]`);
    await input(client, '#customerInput', `${mode} 거래처`);
    await input(client, '#voucherDateInput', '2026-08-29');
    await input(client, '#warehouseInput', `${mode} 창고`);
    await click(client, '#addRowButton');
    await input(client, '#workTableBody tr[data-row-id] input[data-field="itemName"]', `${mode} 상품`);
    await input(client, '#workTableBody tr[data-row-id] input[data-field="quantity"]', '1');
    const rowCount = await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.${mode}.rows.length`);
    await click(client, '#completeButton');
    await waitForExpression(client, `document.querySelector('#deliveryMessage').textContent.includes('${code}')`, `${mode} finalize failure`);
    assert.equal(await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.${mode}.rows.length`), rowCount, `${mode} rows must survive finalize failure`);
  }

  await click(client, '[data-mode="estimate"]');
  await input(client, '#estimateNameInput', '브라우저 견적');
  await click(client, '#addRowButton');
  await input(client, '#workTableBody tr[data-row-id] input[data-field="itemName"]', '견적 상품');
  await input(client, '#workTableBody tr[data-row-id] input[data-field="quantity"]', '0');
  await click(client, '#completeButton');
  try {
    await waitForExpression(client, `document.querySelector('#deliveryMessage').dataset.state==='success'`, 'estimate local save');
  } catch (error) {
    const diagnostic = await evaluate(client, `({message:document.querySelector('#deliveryMessage').textContent,state:window.__SMARTINPUT_DEBUG__.getState().draft.modes.estimate})`);
    throw new Error(`${error.message} · ${JSON.stringify(diagnostic)}`);
  }
  const savedEstimate = (await readSmartInputDb(client)).estimates.find(record => record.catalogName === '브라우저 견적');
  assert.equal(savedEstimate.draft.rows[0].quantity, 0, 'numeric zero must survive estimate save');

  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' });
  await client.send('Page.reload', { ignoreCache: false });
  await waitForExpression(client, `Boolean(window.__SMARTINPUT_DEBUG__) && Boolean(document.querySelector('.nexus-ui-logo--light'))`, 'visual shell');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `scrollTo(0,0);document.documentElement.setAttribute('data-nexus-ui-theme','light');document.documentElement.setAttribute('data-nexus-theme','light')`);
  await waitForExpression(client, `document.querySelector('.nexus-ui-logo--light').naturalWidth>0`, 'light logo');
  await wait(180);
  await evaluate(client, `scrollTo(0,0)`);
  const sourceModeLayout = {};
  for (const [method, mainSelector] of [['text', 'textarea'], ['paste', 'textarea'], ['photo', '.si-photo-preview'], ['direct', null], ['excel', '.si-dropzone'], ['voice', null]]) {
    await click(client, `[data-method="${method}"]`);
    sourceModeLayout[method] = await evaluate(client, `(() => {
      const body = document.querySelector('.si-source-card__body');
      const pane = document.querySelector('.si-source-pane:not([hidden])');
      const preview = document.querySelector('.si-source-preview');
      const main = ${mainSelector ? `pane.querySelector(${JSON.stringify(mainSelector)})` : 'pane'};
      const bodyHeight = body.getBoundingClientRect().height;
      return {
        bodyHeight: Math.round(bodyHeight),
        paneHeight: Math.round(pane.getBoundingClientRect().height),
        mainHeight: Math.round(main.getBoundingClientRect().height),
        mainRatio: Number((main.getBoundingClientRect().height / bodyHeight).toFixed(3)),
        previewDisplay: getComputedStyle(preview).display,
        previewHeight: Math.round(preview.getBoundingClientRect().height),
        previewRatio: Number((preview.getBoundingClientRect().height / bodyHeight).toFixed(3))
      };
    })()`);
  }
  for (const method of ['text', 'paste', 'photo']) {
    assert.equal(sourceModeLayout[method].previewDisplay, 'none', `${method} must expose one primary source surface without a second preview`);
    assert.ok(sourceModeLayout[method].mainRatio >= 0.85,
      `${method} primary source surface must consume at least 85% of the parser body, observed ${sourceModeLayout[method].mainRatio}`);
  }
  for (const method of ['direct', 'excel', 'voice']) {
    assert.notEqual(sourceModeLayout[method].previewDisplay, 'none', `${method} must retain the source preview below compact controls`);
    assert.ok(sourceModeLayout[method].previewRatio >= 0.7,
      `${method} source preview must consume the parser remainder, observed ${sourceModeLayout[method].previewRatio}`);
  }
  await click(client, '[data-method="text"]');
  const textSurfaceShot = await capture(client, 'smartinput-desktop-light-text.png');
  await click(client, '[data-method="photo"]');
  const photoSurfaceShot = await capture(client, 'smartinput-desktop-light-photo.png');
  const desktopLayout = await evaluate(client, `(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const appHeader = box('[data-nexus-app-header="smart-input"]');
    const shell = box('.si-shell');
    const workspace = box('.si-workspace');
    const source = box('.si-source-card');
    const table = box('.si-table-card');
    const tableScroll = box('.si-table-scroll');
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      appHeader: { left: appHeader.left, width: appHeader.width, height: appHeader.height },
      shell: { left: shell.left, width: shell.width, height: shell.height },
      workspace: { height: workspace.height },
      sourceWidth: source.width,
      tableWidth: table.width,
      tableBottom: table.bottom,
      tableScrollHeight: tableScroll.height
    };
  })()`);
  assert.ok(Math.abs(desktopLayout.appHeader.height - 56) <= 1, `app header must be 56px, observed ${desktopLayout.appHeader.height}`);
  assert.ok(desktopLayout.appHeader.left <= 1 && desktopLayout.appHeader.width >= desktopLayout.viewportWidth - 1,
    'app-header background and divider must span the viewport');
  assert.ok(desktopLayout.shell.left <= 1 && desktopLayout.shell.width >= desktopLayout.viewportWidth - 1,
    'SmartInput shell must use the full viewport width');
  assert.ok(desktopLayout.tableWidth > desktopLayout.sourceWidth * 2,
    `work table must receive remaining width (${desktopLayout.tableWidth}px vs ${desktopLayout.sourceWidth}px source)`);
  assert.ok(desktopLayout.tableScrollHeight >= 600,
    `work table must consume remaining viewport height, observed ${desktopLayout.tableScrollHeight}px`);
  assert.ok(desktopLayout.tableBottom <= desktopLayout.viewportHeight + 1,
    'desktop work table must fit in the remaining viewport height');
  const lightShot = await capture(client, 'smartinput-desktop-light.png');
  await evaluate(client, `scrollTo(0,0);document.documentElement.setAttribute('data-nexus-ui-theme','dark');document.documentElement.setAttribute('data-nexus-theme','dark')`);
  await waitForExpression(client, `document.querySelector('.nexus-ui-logo--dark').naturalWidth>0`, 'dark logo');
  await wait(100);
  await evaluate(client, `scrollTo(0,0)`);
  const darkShot = await capture(client, 'smartinput-desktop-dark.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.reload', { ignoreCache: false });
  await waitForExpression(client, `Boolean(window.__SMARTINPUT_DEBUG__) && document.querySelector('.nexus-ui-logo--dark').naturalWidth>0`, 'mobile visual shell');
  await evaluate(client, `document.documentElement.setAttribute('data-nexus-ui-theme','dark');document.documentElement.setAttribute('data-nexus-theme','dark');document.activeElement?.blur();scrollTo(0,0)`);
  await wait(150);
  await evaluate(client, `document.activeElement?.blur();scrollTo(0,0)`);
  const mobileShot = await capture(client, 'smartinput-mobile-dark.png');
  const mobileLayout = await evaluate(client, `(() => {
    const appHeader = document.querySelector('[data-nexus-app-header="smart-input"]');
    const appBox = appHeader.getBoundingClientRect();
    const globalBox = document.querySelector('.nexus-ui-header').getBoundingClientRect();
    const tabs = document.querySelector('.si-mode-tabs');
    return {
      appTop: appBox.top,
      appHeight: appBox.height,
      globalBottom: globalBox.bottom,
      viewportWidth: innerWidth,
      appWidth: appBox.width,
      canScrollModes: appHeader.scrollWidth > appHeader.clientWidth,
      tabLabels: [...tabs.querySelectorAll('button')].map(button => button.textContent.trim()),
      rowsVisible: document.querySelectorAll('#workTableBody tr').length
    };
  })()`);
  assert.ok(mobileLayout.appTop >= mobileLayout.globalBottom - 1, 'mobile app header must remain below the common header');
  assert.ok(Math.abs(mobileLayout.appHeight - 56) <= 1, `mobile app header must remain one 56px row, observed ${mobileLayout.appHeight}`);
  assert.ok(mobileLayout.appWidth >= mobileLayout.viewportWidth - 1, 'mobile app-header background must span the viewport');
  assert.equal(mobileLayout.canScrollModes, true, 'compact app-header controls must remain horizontally reachable on mobile');
  assert.deepEqual(mobileLayout.tabLabels, ['주문서', '구매', '판매', '견적서']);
  assert.ok(mobileLayout.rowsVisible >= 3, 'the work table must keep at least three visible rows on mobile');
  let acceptance = null;
  let acceptanceShot = '';
  if (acceptanceXlsxPath) {
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(client, `localStorage.removeItem('oneapp.smartinput.draft.v1');localStorage.removeItem('oneapp.smartinput.drafts.v1');true`);
    await client.send('Page.reload', { ignoreCache: true });
    await waitForExpression(client, `Boolean(window.__SMARTINPUT_DEBUG__) && document.querySelectorAll('#workTableBody tr').length===3`, 'acceptance SmartInput shell');
    await click(client, '#addRowButton');
    await input(client, '#workTableBody tr[data-row-id] input[data-field="itemName"]', '기존 보존 행');
    await input(client, '#workTableBody tr[data-row-id] input[data-field="quantity"]', '1');
    await click(client, '[data-method="excel"]');
    await input(client, '#newTemplateNameInput', '미출고 주문 검증');
    const acceptanceDocument = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const acceptanceSheetNode = await client.send('DOM.querySelector', { nodeId: acceptanceDocument.root.nodeId, selector: '#sheetFileInput' });
    await client.send('DOM.setFileInputFiles', { nodeId: acceptanceSheetNode.nodeId, files: [acceptanceXlsxPath] });
    await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.rows?.length===93`, '93-row acceptance staging', 30_000);
    const stagedAcceptance = await evaluate(client, `(() => {
      const mode=window.__SMARTINPUT_DEBUG__.getState().draft.modes.order;
      const rows=mode.staging.rows;
      const columns=mode.inputTemplate.columns;
      const stagedDomRow=document.querySelector('#workTableBody tr[data-staged-row="true"]');
      const existingDomRow=document.querySelector('#workTableBody tr[data-row-id]');
      return {
        status:mode.staging.status,
        headerRowNumber:mode.staging.headerRowNumber,
        sourceHash:mode.staging.sourceHash,
        stagedRows:rows.length,
        workRows:mode.rows.length,
        customers:new Set(rows.map(row=>row.rowCustomerName)).size,
        quantity:rows.reduce((sum,row)=>sum+Number(row.quantity||0),0),
        amount:rows.reduce((sum,row)=>sum+Number(row.quantity||0)*Number(row.unitPrice||0),0),
        halfQuantity:rows.some(row=>Number(row.quantity)===0.5),
        normalizedBox:rows.some(row=>row.rawUnit==='bOX'&&row.unit==='BOX')&&mode.staging.warnings.some(w=>w.code==='UNIT_CASE_NORMALIZED'),
        unitAndSpecSeparate:rows.some(row=>row.unit&&row.specification),
        domHeaders:[...document.querySelectorAll('#workTableHeadRow th')].slice(1,-1).map(cell=>cell.textContent.trim()),
        domFirstSourceValues:[...stagedDomRow.querySelectorAll('input[data-field]')].map(input=>input.value),
        expectedFirstSourceValues:columns.map(column=>rows[0].sourceValues[column.sourceValueKey]??rows[0][column.targetFieldId]??''),
        provisionalColumns:columns.map(column=>({label:column.label,targetFieldId:column.targetFieldId,sourceValueKey:column.sourceValueKey})),
        existingRowPreserved:columns.map((column,index)=>({label:column.label,value:existingDomRow.querySelectorAll('input[data-field]')[index]?.value||''})).filter(item=>item.value)
      };
    })()`);
    assert.deepEqual({
      status: stagedAcceptance.status,
      headerRowNumber: stagedAcceptance.headerRowNumber,
      stagedRows: stagedAcceptance.stagedRows,
      workRows: stagedAcceptance.workRows,
      customers: stagedAcceptance.customers,
      quantity: stagedAcceptance.quantity,
      amount: stagedAcceptance.amount,
      halfQuantity: stagedAcceptance.halfQuantity,
      normalizedBox: stagedAcceptance.normalizedBox,
      unitAndSpecSeparate: stagedAcceptance.unitAndSpecSeparate
    }, { status: 'PENDING', headerRowNumber: 2, stagedRows: 93, workRows: 1, customers: 18, quantity: 184.5, amount: 2168350, halfQuantity: true, normalizedBox: true, unitAndSpecSeparate: true });
    assert.match(stagedAcceptance.sourceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(stagedAcceptance.domHeaders, acceptanceHeaders, 'staging DOM headers must immediately match A2:N2 exactly');
    assert.deepEqual(stagedAcceptance.domFirstSourceValues, stagedAcceptance.expectedFirstSourceValues, 'the representative staging row must render all 14 original values');
    assert.equal(stagedAcceptance.domFirstSourceValues.length, 14);
    assert.equal(stagedAcceptance.provisionalColumns.length, 14);
    assert.ok(stagedAcceptance.provisionalColumns.every(column => column.sourceValueKey), 'all original columns require stable source value keys');
    assert.deepEqual(stagedAcceptance.existingRowPreserved, [{ label: '품목명', value: '기존 보존 행' }, { label: '수량', value: '1' }]);
    const assigneeColumnId = stagedAcceptance.provisionalColumns.find(column => column.label === '담당').sourceValueKey;
    await input(client, `#workTableBody tr[data-row-id] input[data-field="${assigneeColumnId}"]`, '직접 담당');
    assert.equal(await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.rows[0].sourceValues[${JSON.stringify(assigneeColumnId)}]`), '직접 담당',
      'direct edit must preserve a custom dynamic-column value');
    await evaluate(client, `(() => {
      const target=document.querySelector('#workTableBody tr[data-row-id] input[data-field=${JSON.stringify(assigneeColumnId)}]');
      const event=new Event('paste',{bubbles:true,cancelable:true});
      Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'붙여넣기 담당\\t99':''}});
      target.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.deepEqual(await evaluate(client, `(() => {
      const mode=window.__SMARTINPUT_DEBUG__.getState().draft.modes.order;
      const row=mode.rows[0];
      const columns=mode.inputTemplate.columns;
      const assignee=columns.find(column=>column.label==='담당');
      const warehouse=columns.find(column=>column.label==='창고코드');
      return {assignee:row.sourceValues[assignee.sourceValueKey],warehouseSource:row.sourceValues[warehouse.sourceValueKey],warehouseTarget:row.rowWarehouseCode};
    })()`), { assignee: '붙여넣기 담당', warehouseSource: '99', warehouseTarget: '99' },
    'grid paste must preserve custom source values and update mapped standard fields under the dynamic column model');
    acceptanceShot = await capture(client, 'smartinput-acceptance-93-staging.png');
    await click(client, '#createFromStagingButton');
    await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.groupDeliveryResults?.length===18`, '18 order-group results', 30_000);
    const consumerAcceptance = await evaluate(client, `(async()=>{
      const intake=await import('/orderq/order-intake-engine.js');
      const operations=await import('/orderq/order-operations-repository.js');
      const orders=await intake.listOrders();
      const snapshot=await operations.getOperationsSnapshot();
      const mode=window.__SMARTINPUT_DEBUG__.getState().draft.modes.order;
      const template=window.__SMARTINPUT_DEBUG__.getState().templates.find(item=>item.templateId===mode.selectedTemplateId);
      const detail=await intake.getOrder(orders[0].orderId);
      const rawText=detail.items[0]?.rawText||'';
      const envelope=rawText.startsWith('SMART_INPUT_SOURCE_ROW_V1\t')?JSON.parse(rawText.split('\t',2)[1]):null;
      return {orders:orders.length,operations:snapshot.bundles.length,groupResults:mode.groupDeliveryResults.length,success:mode.groupDeliveryResults.filter(result=>result.status==='SUCCESS').length,remainingRows:mode.rows.length,templateSave:mode.staging.templateSave.status,templateId:mode.selectedTemplateId,templateUpdatedAt:template.updatedAt,templateHeaders:template.columns.map(column=>column.label),templateColumns:template.columns.length,sourceEnvelopeColumns:envelope?.columns?.length||0,sourceEnvelopeValues:Object.keys(envelope?.values||{}).length};
    })()`);
    assert.deepEqual({ orders: consumerAcceptance.orders, operations: consumerAcceptance.operations, groupResults: consumerAcceptance.groupResults, success: consumerAcceptance.success, remainingRows: consumerAcceptance.remainingRows, templateSave: consumerAcceptance.templateSave },
      { orders: 18, operations: 18, groupResults: 18, success: 18, remainingRows: 1, templateSave: 'SAVED' },
      'continuous creation must preserve prior work and expose 18 orders through both ORDER Q readers');
    assert.deepEqual(consumerAcceptance.templateHeaders, acceptanceHeaders);
    assert.equal(consumerAcceptance.templateColumns, 14);
    assert.equal(consumerAcceptance.sourceEnvelopeColumns, 14);
    assert.equal(consumerAcceptance.sourceEnvelopeValues, 14, 'ORDER Q rawText metadata envelope must preserve all source values');
    await click(client, '#existingTemplateModeButton');
    await evaluate(client, `(() => { const select=document.querySelector('#existingTemplateSelect');select.value=${JSON.stringify(consumerAcceptance.templateId)};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value; })()`);
    await wait(250);
    await client.send('Page.reload', { ignoreCache: false });
    await waitForExpression(client, `Boolean(window.__SMARTINPUT_DEBUG__) && window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.selectedTemplateId===${JSON.stringify(consumerAcceptance.templateId)}`, 'existing template reload');
    assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('#workTableHeadRow th')].slice(1,-1).map(cell=>cell.textContent.trim())`), acceptanceHeaders,
      'reloaded existing template must immediately restore the same 14-column order');
    const rerunDocument = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const rerunSheetNode = await client.send('DOM.querySelector', { nodeId: rerunDocument.root.nodeId, selector: '#sheetFileInput' });
    await client.send('DOM.setFileInputFiles', { nodeId: rerunSheetNode.nodeId, files: [acceptanceXlsxPath] });
    await waitForExpression(client, `window.__SMARTINPUT_DEBUG__.getState().draft.modes.order.staging?.status==='ALREADY_PROCESSED'`, 'same-source idempotency', 30_000);
    const rerunOrders = await evaluate(client, `(async()=>{const intake=await import('/orderq/order-intake-engine.js');return (await intake.listOrders()).length;})()`);
    assert.equal(rerunOrders, 18, 'same workbook rerun must create zero duplicate orders');
    assert.equal(await evaluate(client, `window.__SMARTINPUT_DEBUG__.getState().templates.find(item=>item.templateId===${JSON.stringify(consumerAcceptance.templateId)}).updatedAt`), consumerAcceptance.templateUpdatedAt,
      'existing template application must not resave its structure');
    const idempotencyAcceptance = await evaluate(client, `(async()=>{
      const intake=await import('/orderq/order-intake-engine.js');
      const adapter=await import('/smartinput/integration-adapter.js');
      const order=(await intake.listOrders())[0];
      const payload={customerId:order.customerId,customerName:order.customerName,warehouseId:order.warehouseId,warehouseCode:order.warehouseCode,warehouseName:order.warehouseName,orderDate:order.orderDate,sourceType:'SMART_INPUT',sourceMessageKey:order.sourceMessageKey,sourceId:order.sourceId,items:[]};
      const same=await adapter.saveOrderLocal(payload);
      let conflictCode='';
      try{await adapter.saveOrderLocal({...payload,sourceId:'changed-'+order.sourceId});}catch(error){conflictCode=error.code||error.message;}
      return {sameHashIdempotent:same.idempotent===true,conflictCode,orders:(await intake.listOrders()).length};
    })()`);
    assert.deepEqual(idempotencyAcceptance, { sameHashIdempotent: true, conflictCode: 'ORDER_BUSINESS_KEY_CONFLICT', orders: 18 },
      'same business key/hash must be idempotent and a changed hash must be blocked without another order');
    acceptance = { ...stagedAcceptance, ...consumerAcceptance, rerunOrders, duplicateCreated: rerunOrders - consumerAcceptance.orders, ...idempotencyAcceptance };
  }
  assert.deepEqual(runtimeErrors, [], `uncaught browser runtime errors: ${runtimeErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(' | ')}`);

  console.log(JSON.stringify({ status: 'PASS', coldMs, warmMs, warmTargetMet: warmMs < 1000, desktopLayout, mobileLayout, sourceModeLayout, acceptance, screenshots: [textSurfaceShot, photoSurfaceShot, lightShot, darkShot, mobileShot, acceptanceShot].filter(Boolean), preservedStores: Object.keys(beforeDb), modes: ['order', 'purchase', 'sale', 'estimate'], methods: ['direct', 'text', 'paste', 'tsv', 'csv', 'xlsx', 'photo', 'voice'], consoleErrors: consoleErrors.length, runtimeErrors: runtimeErrors.length }, null, 2));
} finally {
  client?.close();
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) browserProcess.kill();
  await new Promise(resolveClose => server.close(() => resolveClose()));
  try { rmSync(browserProfile, { recursive: true, force: true }); } catch {}
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
}
