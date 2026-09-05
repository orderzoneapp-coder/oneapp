import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'orderq/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const file = normalize(resolve(root, relative));
  if (file !== root && !file.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end('Not found');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream' });
  response.end(readFileSync(file));
});
const listen = () => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address())); });
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 20_000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await wait(80); } throw new Error(`Timed out waiting for ${label}`); };
const browserPath = () => [process.env.CHROME_PATH, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'), process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')].filter(Boolean).find(existsSync) || '';

class Cdp {
  constructor(url) { this.url = url; this.socket = null; this.id = 0; this.pending = new Map(); this.events = new Map(); }
  async connect() { this.socket = new WebSocket(this.url); this.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); return message.error ? pending.reject(new Error(`${message.error.message} [${message.id}]`)) : pending.resolve(message.result); } (this.events.get(message.method) || []).forEach(listener => listener(message.params)); }); await new Promise((resolveOpen, reject) => { this.socket.addEventListener('open', resolveOpen, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolveSend, reject) => { this.pending.set(id, { resolve: resolveSend, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  once(method) { return new Promise((resolveEvent, reject) => { const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); }; const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 20_000); this.events.set(method, [...(this.events.get(method) || []), listener]); }); }
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { this.socket?.close(); }
}
const evaluate = (client, expression) => client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }).then(result => { if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; });
const click = (client, selector) => evaluate(client, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('missing ${selector}'); el.click(); return true; })()`);
const setInput = (client, selector, value) => evaluate(client, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
const navigate = async (client, url) => { const loaded = client.once('Page.loadEventFired'); await client.send('Page.navigate', { url }); await loaded; await waitFor(() => evaluate(client, `document.readyState==='complete'`), 'page ready'); await wait(250); };
const seed = async client => evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open('oneapp-orderq-pre-m1-v6');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction(['orders','orderItems','orderEvents'],'readwrite');const orders=[
{orderId:'ORD-OLD',orderNo:'20260901-001',orderDate:'2026-09-01',customerName:'오래상사',customerId:'C-OLD',warehouseName:'서울창고',orderStatus:'ORDER',adminStatus:'UNCHECKED',opsStatus:'ACTIVE',sourceType:'MANUAL',inputChannel:'DIRECT',revision:1,sourceMessageKey:'seed-old',createdAt:'2026-09-01T01:00:00.000Z',updatedAt:'2026-09-01T01:00:00.000Z'},
{orderId:'ORD-MID',orderNo:'20260902-001',orderDate:'2026-09-02',customerName:'중간상사',customerId:'C-MID',warehouseName:'부산창고',orderStatus:'ORDER',adminStatus:'CHECKED',opsStatus:'ACTIVE',revision:1,sourceType:'MANUAL',inputChannel:'DIRECT',sourceMessageKey:'seed-mid',createdAt:'2026-09-02T01:00:00.000Z',updatedAt:'2026-09-02T02:00:00.000Z'},
{orderId:'ORD-NEW',orderNo:'20260903-001',orderDate:'2026-09-03',customerName:'새상사',customerId:'C-NEW',warehouseName:'대전창고',orderStatus:'COMPLETED',adminStatus:'CHECKED',opsStatus:'CLOSED',revision:1,sourceType:'MANUAL',inputChannel:'DIRECT',sourceMessageKey:'seed-new',createdAt:'2026-09-03T01:00:00.000Z',updatedAt:'2026-09-03T03:00:00.000Z'}];
const items=[['ORD-OLD','OI-OLD','OLD-001','사과','2'],['ORD-MID','OI-MID','MID-002','바나나','3'],['ORD-NEW','OI-NEW','NEW-003','포도','4']].map(([orderId,orderItemId,itemCode,itemName,quantity],i)=>({orderId,orderItemId,lineNo:1,itemCode,itemName,specification:'BOX',finalUnit:'EA',rawUnit:'EA',finalQuantity:quantity,rawQuantity:quantity,price:1000,supplyAmount:Number(quantity)*1000,matchStatus:'MATCHED',createdAt:'2026-09-01T01:00:00.000Z'}));
orders.forEach(order=>tx.objectStore('orders').put(order));items.forEach(item=>tx.objectStore('orderItems').put(item));orders.forEach(order=>tx.objectStore('orderEvents').put({eventId:'EV-'+order.orderId,orderId:order.orderId,eventType:'ORDER_CREATED',revision:1,actor:'SEED',createdAt:order.createdAt,detail:{}}));tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);

let browserProcess; let client; let address; const profile = join(tmpdir(), `oneapp-orderq-query-${Date.now()}`);
try {
  address = await listen();
  const executable = browserPath(); assert.ok(executable, 'Chrome/Edge is required for ORDER Q query browser E2E');
  mkdirSync(profile, { recursive: true });
  browserProcess = spawn(executable, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio:'ignore', windowsHide:true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) ? readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] : '', 'browser debug port');
  const target = await waitFor(async () => { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); return response.ok ? (await response.json()).find(item => item.type === 'page') : null; }, 'browser target');
  client = new Cdp(target.webSocketDebuggerUrl); await client.connect(); await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const runtimeErrors=[]; client.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.text || 'runtime exception'));
  const origin = `http://127.0.0.1:${address.port}`;
  await navigate(client, `${origin}/orderq/index.html`); await seed(client); await navigate(client, `${origin}/orderq/index.html?view=query`);
  await waitFor(() => evaluate(client, `document.querySelector('#summaryText')?.textContent.includes('전표 3/3')`), 'default all orders');
  assert.equal(await evaluate(client, `document.querySelector('#periodMode').value`), 'all');
  await setInput(client, '#orderSearch', '바나나'); await waitFor(() => evaluate(client, `document.querySelector('#summaryText').textContent.includes('전표 1/3')`), 'item search');
  await setInput(client, '#orderSearch', ''); await click(client, '#periodMode');
  await setInput(client, '#periodMode', 'custom'); await setInput(client, '#dateFrom', '2026-09-02'); await setInput(client, '#dateTo', '2026-09-03');
  await waitFor(() => evaluate(client, `document.querySelector('#summaryText').textContent.includes('전표 2/3')`), 'date range');
  await click(client, '#periodResetBtn'); await waitFor(() => evaluate(client, `document.querySelector('#summaryText').textContent.includes('전표 3/3') && document.querySelector('#periodMode').value==='all'`), 'date reset');
  await navigate(client, `${origin}/orderq/index.html?view=query&from=2026-09-02&to=2026-09-03&focus=ORD-OLD&saved=1`);
  await waitFor(() => evaluate(client, `document.querySelector('[data-order-id="ORD-OLD"]') && !document.querySelector('[data-detail-for="ORD-OLD"]').hidden`), 'out-of-range focus');
  assert.equal(await evaluate(client, `document.querySelector('#message').textContent.includes('저장했습니다')`), true);
  await navigate(client, `${origin}/orderq/index.html?view=invalid&focus=ORD-OLD`);
  assert.equal(await evaluate(client, `new URL(location.href).searchParams.get('view')`), 'query');
  await click(client, '[data-view="processing"]'); await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('view')==='processing' && !document.querySelector('#processingView').hidden`), 'processing view');
  assert.equal(await evaluate(client, `document.querySelector('#processingView').textContent.includes('읽기 전용 화면')`), true);
  await click(client, '[data-view="query"]'); await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('view')==='query' && !document.querySelector('#queryView').hidden`), 'query view return');
  await evaluate(client, 'history.back()'); await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('view')==='processing'`), 'browser back');
  await evaluate(client, 'history.forward()'); await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('view')==='query'`), 'browser forward');
  await navigate(client, `${origin}/orderq/index.html?view=query&focus=ORD-MID`);
  await waitFor(() => evaluate(client, `document.querySelector('[data-order-id="ORD-MID"]') && !document.querySelector('[data-detail-for="ORD-MID"]').hidden && document.querySelector('[data-edit="ORD-MID"]')`), 'focused order edit action');
  await click(client, '[data-edit="ORD-MID"]');
  await evaluate(client, `new Promise((resolve,reject)=>{const r=indexedDB.open('oneapp-orderq-pre-m1-v6');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('orders','readwrite');const order=tx.objectStore('orders').get('ORD-MID');order.onsuccess=()=>{order.result.revision=99;tx.objectStore('orders').put(order.result)};tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  await click(client, '[data-save-inline="ORD-MID"]'); await waitFor(() => evaluate(client, `document.querySelector('#message').textContent.includes('저장되지 않았습니다')`), 'revision conflict');
  await navigate(client, `${origin}/orderq/index.html?view=query&focus=ORD-MID`); await click(client, '[data-edit="ORD-MID"]'); await evaluate(client, 'window.confirm=()=>true'); await click(client, '[data-cancel-order="ORD-MID"]'); await waitFor(() => evaluate(client, `document.querySelector('[data-order-id="ORD-MID"]').textContent.includes('전체취소')`), 'full cancel');
  await navigate(client, `${origin}/orderq/voucher-query.html?mode=order&date=2026-09-01&focus=ORD-OLD`); await waitFor(() => evaluate(client, `document.querySelector('.voucher-query-card__open')?.getAttribute('href')?.includes('index.html?view=query&focus=ORD-OLD')`), 'voucher order result link');
  await setInput(client, '#modeInput', 'purchase'); await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('mode')==='purchase'`), 'purchase query regression');
  await setInput(client, '#modeInput', 'sale'); await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('mode')==='sale'`), 'sale query regression');
  const evidenceDir = resolve(root, '..', '..', 'evidence'); mkdirSync(evidenceDir, { recursive: true });
  await navigate(client, `${origin}/orderq/index.html?view=query&focus=ORD-OLD`); const desktop = await client.send('Page.captureScreenshot', { format:'png' }); writeFileSync(join(evidenceDir, 'orderq-query-pr-a-desktop.png'), Buffer.from(desktop.data, 'base64'));
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await wait(300); const mobile = await client.send('Page.captureScreenshot', { format:'png' }); writeFileSync(join(evidenceDir, 'orderq-query-pr-a-mobile.png'), Buffer.from(mobile.data, 'base64'));
  assert.equal(runtimeErrors.length, 0, `browser runtime errors: ${runtimeErrors.join('; ')}`);
  console.log('ORDER Q query browser E2E passed: default/all, date range/reset, item search, out-of-range focus, saved/view navigation, back/forward, revision conflict, full cancel, voucher order link, purchase/sale regression, desktop/mobile screenshots.');
} finally {
  client?.close(); browserProcess?.kill(); server.close();
}
