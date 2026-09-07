import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const orderOpsHtml = readFileSync(join(root, 'orderops', 'list.html'), 'utf8').replace(
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  '/customer-master/vendor/xlsx.full.min.js'
);
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/orderops/list.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end(orderOpsHtml);
  }
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
const commandPath = command => {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 ? found.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || '' : '';
};
const browserPath = () => [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  commandPath('google-chrome'), commandPath('google-chrome-stable'), commandPath('chromium'), commandPath('chromium-browser'), commandPath('msedge'),
].filter(Boolean).find(existsSync) || '';

class Cdp {
  constructor(url) { this.url = url; this.socket = null; this.id = 0; this.pending = new Map(); this.events = new Map(); }
  async connect() { this.socket = new WebSocket(this.url); this.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } (this.events.get(message.method) || []).forEach(listener => listener(message.params)); }); await new Promise((resolveOpen, reject) => { this.socket.addEventListener('open', resolveOpen, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolveSend, reject) => { this.pending.set(id, { resolve: resolveSend, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  once(method) { return new Promise((resolveEvent, reject) => { const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); }; const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 20_000); this.events.set(method, [...(this.events.get(method) || []), listener]); }); }
  close() { this.socket?.close(); }
}
const evaluate = (client, expression) => client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }).then(result => { if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; });
const navigate = async (client, url) => { const loaded = client.once('Page.loadEventFired'); await client.send('Page.navigate', { url }); await loaded; await waitFor(() => evaluate(client, `document.readyState==='complete'`), 'page ready'); };

let browserProcess; let client;
const profile = join(tmpdir(), `oneapp-shipment-conflict-${Date.now()}`);
try {
  const address = await listen();
  const executable = browserPath();
  assert.ok(executable, 'Chrome/Edge is required');
  mkdirSync(profile, { recursive: true });
  browserProcess = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) ? readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] : '', 'browser debug port');
  const target = await waitFor(async () => { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); return response.ok ? (await response.json()).find(item => item.type === 'page') : null; }, 'browser target');
  client = new Cdp(target.webSocketDebuggerUrl); await client.connect(); await client.send('Page.enable'); await client.send('Runtime.enable');
  const origin = `http://127.0.0.1:${address.port}`;
  await navigate(client, `${origin}/orderq/index.html?view=query`);
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-orderq-pre-m1-v6');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['orders','orderItems','orderEvents'],'readwrite');tx.objectStore('orders').put({orderId:'ORD-CONFLICT',orderNo:'20260907-001',orderDate:'2026-09-07',customerId:'CUS-1',customerName:'동시성상사',warehouseId:'WH-1',warehouseCode:'88',warehouseName:'본창고',assigneeName:'김작업',orderStatus:'ORDER',adminStatus:'CHECKED',opsStatus:'ACTIVE',sourceType:'SMART_INPUT',inputChannel:'SMART_INPUT',revision:1,createdAt:'2026-09-07T01:00:00.000Z',updatedAt:'2026-09-07T01:00:00.000Z'});tx.objectStore('orderItems').put({orderItemId:'OI-CONFLICT',orderId:'ORD-CONFLICT',lineNo:1,productId:'P-1',itemCode:'P-1',itemName:'상품',specification:'BOX',finalQuantity:5,rawQuantity:5,finalUnit:'BOX',rawUnit:'BOX',matchStatus:'MATCHED'});tx.objectStore('orderEvents').put({eventId:'OE-CONFLICT',orderId:'ORD-CONFLICT',revision:1,eventType:'ORDER_CREATED',createdAt:'2026-09-07T01:00:00.000Z',detail:{}});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  const snapshot = await evaluate(client, `(async()=>{const adapter=await import('/orderq/shipment-order-read-adapter.js?browser-test');const result=await adapter.readShipmentOrderCandidate('ORD-CONFLICT');globalThis.__shipmentSnapshot=result.snapshot;return result.snapshot})()`);
  assert.equal(snapshot.orderRevision, 1);
  await evaluate(client, `document.querySelector('#refreshBtn').click()`);
  const queryShipmentStatus = () => evaluate(client, `(()=>{const headers=[...document.querySelectorAll('.document-list thead th')];const index=headers.findIndex(header=>header.textContent.trim()==='출고상태');return document.querySelector('[data-order-id="ORD-CONFLICT"]')?.children[index]?.textContent.trim()||''})()`);
  assert.equal(await waitFor(queryShipmentStatus, 'initial order-query shipment status'), '출고대기');
  const first = await evaluate(client, `(async()=>{const commands=await import('/orderops/shipment-result-command-adapter.js?browser-test');const snapshot=globalThis.__shipmentSnapshot;const result=await commands.confirmShipment({commandId:'BROWSER-CONFIRM-1',orderId:snapshot.orderId,expectedOrderRevision:snapshot.orderRevision,expectedSnapshotHash:snapshot.snapshotHash,workspace:{orders:[{orderItemId:'OI-CONFLICT',productCode:'P-1',productName:'상품',specification:'BOX',sourceUnit:'BOX'}]},actor:'김작업',lineInputs:[{orderItemId:'OI-CONFLICT',shippedQuantity:5}]});return {id:result.document.shipmentDocumentId,duplicate:result.duplicate,review:result.verification.reviewRequired,status:result.verification.shipmentStatus}})()`);
  assert.equal(first.duplicate, false);
  assert.equal(first.review, false);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(await waitFor(async () => (await queryShipmentStatus()) === '출고완료' ? '출고완료' : '', 'completed order-query shipment status'), '출고완료');
  const retry = await evaluate(client, `(async()=>{const commands=await import('/orderops/shipment-result-command-adapter.js?browser-test');const snapshot=globalThis.__shipmentSnapshot;const result=await commands.confirmShipment({commandId:'BROWSER-CONFIRM-1',orderId:snapshot.orderId,expectedOrderRevision:snapshot.orderRevision,expectedSnapshotHash:snapshot.snapshotHash,workspace:{orders:[{orderItemId:'OI-CONFLICT',productCode:'P-1',productName:'상품',specification:'BOX',sourceUnit:'BOX'}]},actor:'김작업',lineInputs:[{orderItemId:'OI-CONFLICT',shippedQuantity:5}]});return {id:result.document.shipmentDocumentId,duplicate:result.duplicate}})()`);
  assert.deepEqual(retry, { id: first.id, duplicate: true });
  const resultConflictCode = await evaluate(client, `(async()=>{try{const core=await import('/orderops/shipment-result-core.js?browser-result-race');const repository=await import('/orderops/shipment-result-repository.js?browser-result-race');const snapshot=globalThis.__shipmentSnapshot;const staleBundle=core.buildShipmentResult({commandId:'BROWSER-CONCURRENT-CONFIRM',snapshot,workspace:{orders:[]},existingBundles:[],lineInputs:[{orderItemId:'OI-CONFLICT',shippedQuantity:1,reason:'동시 확정 검증'}]});await repository.commitShipmentBundle(staleBundle);return 'NO_CONFLICT'}catch(error){return error.code}})()`);
  assert.equal(resultConflictCode, 'SHIPMENT_RESULT_CONFLICT');
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-orderq-pre-m1-v6');request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['orders','orderItems'],'readwrite');const order=tx.objectStore('orders').get('ORD-CONFLICT');order.onsuccess=()=>{order.result.revision=2;order.result.updatedAt='2026-09-07T02:00:00.000Z';tx.objectStore('orders').put(order.result)};const item=tx.objectStore('orderItems').get('OI-CONFLICT');item.onsuccess=()=>{item.result.finalQuantity=6;tx.objectStore('orderItems').put(item.result)};tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  const conflictCode = await evaluate(client, `(async()=>{try{const commands=await import('/orderops/shipment-result-command-adapter.js?browser-test');const snapshot=globalThis.__shipmentSnapshot;await commands.confirmShipment({commandId:'BROWSER-CONFIRM-2',orderId:snapshot.orderId,expectedOrderRevision:snapshot.orderRevision,expectedSnapshotHash:snapshot.snapshotHash,workspace:{orders:[]},lineInputs:[{orderItemId:'OI-CONFLICT',shippedQuantity:1}]});return 'NO_CONFLICT'}catch(error){return error.code}})()`);
  assert.equal(conflictCode, 'SHIPMENT_ORDER_REVISION_CONFLICT');
  const reviewBefore = await evaluate(client, `(async()=>{const adapter=await import('/orderops/shipment-result-read-adapter.js?browser-test');const result=await adapter.readShipmentResultsByOrder('ORD-CONFLICT');return {review:result.reviewRequired,net:result.netByOrderItem['OI-CONFLICT'],status:result.shipmentStatus}})()`);
  assert.deepEqual(reviewBefore, { review: true, net: 5, status: 'REVIEW_REQUIRED' });
  await evaluate(client, `document.querySelector('#refreshBtn').click()`);
  assert.equal(await waitFor(async () => (await queryShipmentStatus()) === '확인필요' ? '확인필요' : '', 'review-required order-query shipment status'), '확인필요');
  await evaluate(client, `(async()=>{const commands=await import('/orderops/shipment-result-command-adapter.js?browser-test');await commands.reverseShipment({shipmentDocumentId:${JSON.stringify(first.id)},commandId:'BROWSER-REVERSE-1',actor:'김작업',reason:'주문수량 변경'});return true})()`);
  const reviewAfter = await evaluate(client, `(async()=>{const adapter=await import('/orderops/shipment-result-read-adapter.js?browser-test');const result=await adapter.readShipmentResultsByOrder('ORD-CONFLICT');return {review:result.reviewRequired,net:result.netByOrderItem['OI-CONFLICT'],count:result.results.length,status:result.shipmentStatus}})()`);
  assert.deepEqual(reviewAfter, { review: false, net: 0, count: 2, status: 'REVERSED' });
  assert.equal(await waitFor(async () => (await queryShipmentStatus()) === '출고취소' ? '출고취소' : '', 'reversed order-query shipment status'), '출고취소');
  await navigate(client, `${origin}/orderops/list.html?orderId=ORD-CONFLICT`);
  await waitFor(() => evaluate(client, `Boolean(window.XLSX?.utils?.aoa_to_sheet)`), 'OrderOps XLSX runtime');
  await waitFor(() => evaluate(client, `document.querySelector('#ordersFileName')?.textContent.includes('20260907-001')`), 'ORDER Q direct source');
  await evaluate(client, `(async()=>{const workbook=XLSX.utils.book_new();const matrix=[['회사명 : 테스트 / 창고별재고'],['사용','품목코드','단위','품목명','규격','수량','1창고','2전송','3서울','4전송','7진영','기본','전송','창고'],['Yes','P-1','BOX','상품','BOX',10,10,'','','','','','','']];XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(matrix),'재고현황');const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'});const transfer=new DataTransfer();transfer.items.add(new File([bytes],'창고별재고_출고파이프라인.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const input=document.querySelector('#inventoryInput');Object.defineProperty(input,'files',{configurable:true,value:transfer.files});input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await waitFor(() => evaluate(client, `!document.querySelector('#analyzeButton').disabled`), 'OrderOps direct-source analysis readiness');
  await evaluate(client, `document.querySelector('#analyzeButton').click()`);
  await waitFor(() => evaluate(client, `!document.querySelector('#shipmentExecution').hidden&&document.querySelectorAll('#shipmentExecutionRows tr').length===1`), 'shipment execution panel');
  const executionLight = await evaluate(client, `(()=>{const panel=document.querySelector('#shipmentExecution');const quantity=panel.querySelector('[data-shipped-quantity]');return {title:document.title,status:document.querySelector('#shipmentExecutionStatus').textContent,remaining:panel.querySelector('tbody td:nth-child(3)').textContent.trim(),quantity:quantity.value,max:quantity.max,rows:panel.querySelectorAll('tbody tr').length,background:getComputedStyle(panel).backgroundColor,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}})()`);
  assert.equal(executionLight.title, '출고관리 - NEXUS');
  assert.equal(executionLight.rows, 1);
  assert.equal(executionLight.quantity, '6');
  assert.equal(executionLight.max, '6');
  assert.match(executionLight.remaining, /6 BOX/);
  assert.match(executionLight.status, /동결 Revision 2/);
  await evaluate(client, `(()=>{document.documentElement.dataset.nexusUiTheme='dark';document.documentElement.dataset.nexusTheme='dark';window.dispatchEvent(new CustomEvent('nexus-ui:theme-change',{detail:{theme:'dark'}}));return true})()`);
  const darkBackground = await evaluate(client, `getComputedStyle(document.querySelector('#shipmentExecution')).backgroundColor`);
  assert.notEqual(darkBackground, executionLight.background);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileLayout = await evaluate(client, `(()=>{const panel=document.querySelector('#shipmentExecution').getBoundingClientRect();return {panelRight:panel.right,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,tableScroll:document.querySelector('#shipmentExecution .table-wrap').scrollWidth>document.querySelector('#shipmentExecution .table-wrap').clientWidth}})()`);
  assert.ok(mobileLayout.panelRight <= mobileLayout.scrollWidth + 1);
  assert.equal(mobileLayout.scrollWidth, mobileLayout.clientWidth);
  assert.equal(mobileLayout.tableScroll, true);
  const dbShape = await evaluate(client, `(async()=>{const info=(await indexedDB.databases()).find(item=>item.name==='ONEAPPShippingResultDB');const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ONEAPPShippingResultDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const stores=[...db.objectStoreNames];db.close();return {version:info.version,stores}})()`);
  assert.equal(dbShape.version, 1);
  assert.deepEqual(dbShape.stores.sort(), ['shipmentCommandReceipts', 'shipmentDocuments', 'shipmentEvents', 'shipmentLines'].sort());
  console.log('OrderOps browser shipment pipeline UI, idempotent confirm, concurrent-result guard, optimistic revision conflict, post-confirm review, and reversal passed.');
} finally {
  client?.close(); browserProcess?.kill(); server.close();
}
