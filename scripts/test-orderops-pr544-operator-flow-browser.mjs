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
  '/customer-master/vendor/xlsx.full.min.js',
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
const configuredOrigin = String(process.env.ORDEROPS_TEST_ORIGIN || '').trim().replace(/\/$/, '');
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 25_000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await wait(80); } throw new Error(`Timed out waiting for ${label}`); };
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
const uploadInventory = client => evaluate(client, `(async()=>{const workbook=XLSX.utils.book_new();const matrix=[['회사명 : 테스트 / 창고별재고'],['사용','품목코드','단위','품목명','규격','수량','1창고','2전송','3서울','4전송','7진영','기본','전송','창고'],['Yes','P-1','BOX','부분출고 상품','BOX',20,20,'','','','','','',''],['Yes','P-2','EA','복구 상품','EA',20,20,'','','','','','','']];XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(matrix),'재고현황');const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'});const transfer=new DataTransfer();transfer.items.add(new File([bytes],'PR544_창고별재고.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const input=document.querySelector('#inventoryInput');Object.defineProperty(input,'files',{configurable:true,value:transfer.files});input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const uploadDispatchOrders = client => evaluate(client, `(async()=>{const workbook=XLSX.utils.book_new();const matrix=[['회사명 : 테스트 / 주문현황'],['일자-No.','담당','창고','단위','품목코드','품목명','규격','수량','재고','단가','공급가액','적요','적요(직원)','거래처','거래처코드','지역','그룹'],['2026-09-11-001','담당A','본창고','BOX','P-1','부분출고 상품','BOX',2,'',1000,2000,'일반메모','직원메모1','고객1','C-1','남부','G-1'],['2026-09-11-001','담당A','본창고','EA','P-2','복구 상품','EA',3,'',2000,6000,'일반메모2','직원메모2','고객1','C-1','남부','G-1'],['2026-09-11-002','담당A','본창고','BOX','P-1','부분출고 상품','BOX',1,'',1000,1000,'','직원메모3','고객1','C-1','남부','G-2'],['2026-09-11-003','담당A','본창고','EA','P-2','복구 상품','EA',4,'',2000,8000,'','다음작업','고객2','C-2','북부','G-3']];XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(matrix),'미판매현황');const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'});const transfer=new DataTransfer();transfer.items.add(new File([bytes],'작업자배정_주문현황.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const input=document.querySelector('#ordersInput');Object.defineProperty(input,'files',{configurable:true,value:transfer.files});input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const analyze = async client => {
  await waitFor(() => evaluate(client, `!document.querySelector('#analyzeButton').disabled`), 'analysis readiness');
  await evaluate(client, `document.querySelector('#analyzeButton').click()`);
  try {
    await waitFor(() => evaluate(client, `!document.querySelector('#shipmentExecution').hidden&&Boolean(document.querySelector('[data-preview="allocations"]'))`), 'shipment execution');
  } catch (error) {
    const detail = await evaluate(client, `document.body.innerText.slice(-1200)`);
    throw new Error(`${error.message}: ${detail}`);
  }
};
const analyzeExcelWorkspace = async client => {
  await waitFor(() => evaluate(client, `!document.querySelector('#analyzeButton').disabled`), 'Excel analysis readiness');
  await evaluate(client, `document.querySelector('#analyzeButton').click()`);
  await waitFor(() => evaluate(client, `!document.querySelector('#resultsPanel').classList.contains('hidden')&&Boolean(document.querySelector('[data-preview="allocations"]'))`), 'Excel analysis results');
};

let browserProcess; let client;
const profile = join(tmpdir(), `oneapp-pr544-operator-flow-${Date.now()}`);
try {
  const address = configuredOrigin ? null : await listen();
  const executable = browserPath();
  assert.ok(executable, 'Chrome/Edge is required');
  mkdirSync(profile, { recursive: true });
  browserProcess = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) ? readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] : '', 'browser debug port');
  const target = await waitFor(async () => { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); return response.ok ? (await response.json()).find(item => item.type === 'page') : null; }, 'browser target');
  client = new Cdp(target.webSocketDebuggerUrl); await client.connect(); await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  const origin = configuredOrigin || `http://127.0.0.1:${address.port}`;

  await navigate(client, `${origin}/orderq/index.html?view=query`);
  const operationsMenu = await evaluate(client, `(()=>{const details=document.querySelector('.operations-tools');details.querySelector('summary').click();return {open:details.open,links:[...details.querySelectorAll('nav a')].map(link=>link.textContent.trim()),primary:document.querySelector('.top-actions>a.btn.primary')?.textContent.trim()}})()`);
  assert.equal(operationsMenu.open, true);
  assert.equal(operationsMenu.links.length, 4);
  assert.equal(operationsMenu.primary, '+ 주문서 입력');
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-orderq-pre-m1-v6');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['orders','orderItems','orderEvents'],'readwrite');const orders=[{orderId:'ORD-PARTIAL',orderNo:'20260908-001',itemId:'OI-PARTIAL',itemCode:'P-1',itemName:'부분출고 상품',quantity:10,customerName:'부분상사',deliveryRegion:'남부'},{orderId:'ORD-RECOVERY',orderNo:'20260908-002',itemId:'OI-RECOVERY',itemCode:'P-2',itemName:'복구 상품',quantity:5,customerName:'복구상사',deliveryRegion:''},{orderId:'ORD-MISSING',orderNo:'20260908-003',itemId:'OI-MISSING',itemCode:'P-X',itemName:'재고없는 상품',quantity:3,customerName:'재고없음상사',deliveryRegion:'북부'}];orders.forEach((entry,index)=>{tx.objectStore('orders').put({orderId:entry.orderId,orderNo:entry.orderNo,orderDate:'2026-09-08',deliveryRegion:entry.deliveryRegion,customerId:'CUS-'+index,customerName:entry.customerName,warehouseId:'WH-1',warehouseCode:'88',warehouseName:'본창고',assigneeName:'작업자',orderStatus:'ORDER',adminStatus:'CHECKED',opsStatus:'ACTIVE',sourceType:'SMART_INPUT',inputChannel:'SMART_INPUT',revision:1,createdAt:'2026-09-08T00:00:00.000Z',updatedAt:'2026-09-08T00:00:00.000Z'});tx.objectStore('orderItems').put({orderItemId:entry.itemId,orderId:entry.orderId,lineNo:1,sourceLineKey:'SOURCE-'+index,productId:entry.itemCode,itemCode:entry.itemCode,itemName:entry.itemName,specification:index?'EA':'BOX',finalQuantity:entry.quantity,rawQuantity:entry.quantity,finalUnit:index?'EA':'BOX',rawUnit:index?'EA':'BOX',description:index===0?'현관 앞 전달':'',matchStatus:'MATCHED'});tx.objectStore('orderEvents').put({eventId:'EVENT-'+index,orderId:entry.orderId,revision:1,eventType:'ORDER_CREATED',createdAt:'2026-09-08T00:00:00.000Z',detail:{}})});tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);

  await navigate(client, `${origin}/orderops/list.html`);
  await uploadInventory(client);
  const inventoryOnly = await waitFor(async () => {
    const value = await evaluate(client, `(()=>({active:document.querySelector('#inventoryDrop')?.getAttribute('aria-selected'),rows:document.querySelectorAll('#previewTable table.preview-inventory tbody tr').length,text:document.querySelector('#previewTable').textContent}))()`);
    return value.rows >= 2 ? value : null;
  }, 'inventory-only source preview');
  assert.equal(inventoryOnly.active, 'true');
  assert.doesNotMatch(inventoryOnly.text, /주문서를 불러오면 목록이 표시됩니다|재고자료 없음/, '재고 단독 업로드는 가짜 주문·재고 없음 화면으로 바꾸면 안 된다.');
  await navigate(client, `${origin}/orderops/list.html`);
  assert.equal(await evaluate(client, `document.querySelector('#orderQCandidateSelect').value`), '', '일반 화면 진입만으로 ORDER Q 목록을 자동 선택하지 않아야 한다.');
  await evaluate(client, `document.querySelector('[data-orderq-candidate-action="refresh"]').click()`);
  await waitFor(() => evaluate(client, `[...document.querySelector('#orderQCandidateSelect').options].some(option=>option.value==='ORD-PARTIAL')`), 'general-entry saved order candidates');
  await evaluate(client, `(()=>{const search=document.querySelector('#orderQCandidateSearch');search.value='복구상사';search.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  assert.deepEqual(await waitFor(async () => { const values = await evaluate(client, `[...document.querySelector('#orderQCandidateSelect').options].map(option=>option.value).filter(Boolean)`); return values.length === 1 ? values : null; }, 'saved-order search'), ['ORD-RECOVERY']);
  await evaluate(client, `(()=>{const search=document.querySelector('#orderQCandidateSearch');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await waitFor(() => evaluate(client, `[...document.querySelector('#orderQCandidateSelect').options].some(option=>option.value==='ORD-PARTIAL')`), 'cleared saved-order search');
  const initial = await evaluate(client, `(()=>{const select=document.querySelector('#orderQCandidateSelect');select.value='ORD-PARTIAL';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-orderq-candidate-action="load"]').click();return {analyzeDisabled:document.querySelector('#analyzeButton').disabled,title:document.querySelector('#orderQSourcePicker strong').textContent}})()`);
  assert.equal(initial.analyzeDisabled, true, '창고재고 Excel 없이는 분석할 수 없어야 한다.');
  assert.equal(initial.title, '저장 주문 선택');
  await waitFor(() => evaluate(client, `document.querySelector('#ordersFileName')?.textContent.includes('20260908-001')`), 'selected saved order source');
  const beforeAnalysis = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{const workspace=document.querySelector('[data-nexus-workspace="orderops"]');const table=document.querySelector('#previewTable table.preview-readiness');return {headerOwnsSources:document.querySelector('[data-nexus-app-header="orderops"] > .orderops-header-sources #sourceSelector')!==null,panes:[...workspace.querySelectorAll(':scope > [data-nexus-pane]')].map(node=>node.dataset.nexusPane),deliveries:document.querySelectorAll('#deliverySummaryBody tr[data-delivery-key]').length,headers:[...table?.querySelectorAll('thead th')||[]].map(node=>node.textContent.replace('필터','').trim()),inputValues:[...table?.querySelectorAll('tbody input')||[]].map(node=>node.value),rowText:table?.querySelector('tbody tr')?.textContent||'',stockText:table?.textContent||'',printDisabled:document.querySelector('#printButton').disabled}})()`);
    return value.deliveries === 1 && value.inputValues.includes('부분상사') ? value : null;
  }, 'orders displayed before inventory and analysis');
  assert.equal(beforeAnalysis.headerOwnsSources, true, '업로더와 분석 실행은 앱헤더 안에 있어야 한다.');
  assert.deepEqual(beforeAnalysis.panes, ['reference', 'work', 'result'], '앱헤더 아래 세 섹션은 동일 부모의 직접 자식이어야 한다.');
  assert.deepEqual(beforeAnalysis.headers, ['거래처', '상품', '주문수량', '직원 적요']);
  assert.deepEqual(beforeAnalysis.inputValues, ['부분상사', '10', '현관 앞 전달']);
  assert.doesNotMatch(beforeAnalysis.stockText, /재고|잔량/, '재고자료가 없을 때 0 재고 열을 만들어서는 안 된다.');
  assert.equal(beforeAnalysis.printDisabled, false, '분석 전 기본 분석표도 인쇄할 수 있어야 한다.');
  const previewEdit = await evaluate(client, `(()=>{const input=document.querySelector('.order-edit-input[data-order-field="deliveryNotice"]');input.value='분석전 수정';input.dispatchEvent(new Event('change',{bubbles:true}));window.__orderopsPrintCalled=0;window.print=()=>{window.__orderopsPrintCalled+=1};document.querySelector('#printButton').click();return {value:document.querySelector('.order-edit-input[data-order-field="deliveryNotice"]')?.value,printCalled:window.__orderopsPrintCalled,printing:document.body.classList.contains('printing-table')}})()`);
  assert.deepEqual(previewEdit, { value: '분석전 수정', printCalled: 1, printing: true });
  assert.equal(await evaluate(client, `document.querySelector('#orderQSourcePicker').hidden`), true, '저장 주문 연결 뒤에는 선택기를 접어 기존 작업 화면 배치를 유지해야 한다.');
  assert.equal(await evaluate(client, `document.querySelector('#analyzeButton').disabled`), true, '저장 주문을 선택해도 창고재고 Excel은 필수다.');
  const previewRecovery = await waitFor(async () => {
    const value = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('ONEAPPShippingRecoveryDB',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const pointer=localStorage.getItem('oneapp.shipping.recovery.pointer.v1');if(!pointer){db.close();resolve(null);return}const get=db.transaction('recoveryRecords','readonly').objectStore('recoveryRecords').get(pointer);get.onerror=()=>{db.close();reject(get.error)};get.onsuccess=()=>{const record=get.result;const row=record?.payload?.workspace?.orders?.[0];resolve(record?{fingerprint:record.sourceFingerprint,note:row?.note1||'',mode:record.payload?.workspace?.workspaceMode}:null);db.close()}}})`);
    return value?.note === '분석전 수정' ? value : null;
  }, 'orders-only preview recovery save');
  assert.match(previewRecovery.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(previewRecovery.mode, 'ORDEROPS_PREVIEW');
  await navigate(client, `${origin}/orderops/list.html`);
  await waitFor(() => evaluate(client, `!document.querySelector('#headerRestoreButton').disabled`), 'orders-only preview recovery candidate');
  await evaluate(client, `document.querySelector('#headerRestoreButton').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('.order-edit-input[data-order-field="deliveryNotice"]')?.value==='분석전 수정'`), 'orders-only preview recovery restore');
  assert.equal(await evaluate(client, `document.querySelector('#analyzeButton').disabled`), true);
  await uploadInventory(client);
  const withInventoryBeforeAnalysis = await waitFor(async () => {
    const value = await evaluate(client, `(()=>({headers:[...document.querySelectorAll('#previewTable table.preview-readiness thead th')].map(node=>node.textContent.replace('필터','').trim()),employeeNote:document.querySelector('.order-edit-input[data-order-field="deliveryNotice"]')?.value||'',row:document.querySelector('#previewTable table.preview-readiness tbody tr')?.textContent||''}))()`);
    return value.headers.includes('재고') ? value : null;
  }, 'inventory columns before analysis');
  assert.ok(withInventoryBeforeAnalysis.headers.includes('잔량'));
  assert.equal(withInventoryBeforeAnalysis.employeeNote, '분석전 수정', '재고 추가 갱신에도 분석 전 입력값을 보존해야 한다.');
  assert.match(withInventoryBeforeAnalysis.row, /20[\s\S]*10/, '실제 재고자료가 있을 때만 재고·잔량을 표시해야 한다.');
  await waitFor(async () => {
    const value = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('ONEAPPShippingRecoveryDB',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const pointer=localStorage.getItem('oneapp.shipping.recovery.pointer.v1');const get=pointer&&db.transaction('recoveryRecords','readonly').objectStore('recoveryRecords').get(pointer);if(!get){db.close();resolve(false);return}get.onerror=()=>{db.close();reject(get.error)};get.onsuccess=()=>{resolve(Boolean(get.result?.payload?.workspace?.previewDataState?.inventory&&get.result?.payload?.workspace?.orders?.[0]?.note1==='분석전 수정'));db.close()}}})`);
    return value;
  }, 'orders and inventory preview recovery save');
  await navigate(client, `${origin}/orderops/list.html`);
  await waitFor(() => evaluate(client, `!document.querySelector('#headerRestoreButton').disabled`), 'orders and inventory preview recovery candidate');
  await evaluate(client, `document.querySelector('#headerRestoreButton').click()`);
  await waitFor(() => evaluate(client, `!document.querySelector('#analyzeButton').disabled&&document.querySelector('.order-edit-input[data-order-field="deliveryNotice"]')?.value==='분석전 수정'`), 'orders and inventory preview recovery restore');
  await analyze(client);
  const analyzedReadiness = await waitFor(async () => {
    const value = await evaluate(client, `(()=>({headers:[...document.querySelectorAll('#previewTable table.preview-readiness thead th')].map(node=>node.textContent.replace('필터','').trim()),detailTab:Boolean(document.querySelector('[data-preview="allocations"]'))}))()`);
    return value.headers.length ? value : null;
  }, 'post-analysis readiness view');
  assert.deepEqual(analyzedReadiness.headers, ['거래처', '상품', '주문수량', '직원 적요', '재고', '잔량']);
  assert.equal(analyzedReadiness.detailTab, true, '분석 뒤 상세 주문현황은 별도 선택 화면으로 남아야 한다.');
  assert.match(await evaluate(client, `document.querySelector('#columnVisibilityMenu').textContent`), /상품별 주문합계/);
  await evaluate(client, `document.querySelector('[data-preview="allocations"]').click()`);
  assert.ok(await waitFor(() => evaluate(client, `document.querySelectorAll('#previewTable table.preview-allocations thead th').length>=15`), 'detailed allocation columns'));
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-shipment-draft-line="OI-PARTIAL"]'))`), 'worktable actual shipment input');
  await waitFor(() => evaluate(client, `[...document.querySelectorAll('.nexus-pane-resizer-v2')].filter(node=>!node.hidden).length===2`), 'OrderOps desktop panel handles');
  const workbench = await evaluate(client, `(()=>({
    panes:[...document.querySelectorAll('[data-nexus-workspace="orderops"] > [data-nexus-pane]')].map(node=>node.dataset.nexusPane),
    enhanced:document.querySelector('[data-nexus-workspace="orderops"]')?.dataset.nexusResizableWorkspace,
    handles:[...document.querySelectorAll('.nexus-pane-resizer-v2')].filter(node=>!node.hidden).map(node=>node.dataset.nexusPaneResize),
    deliveries:document.querySelectorAll('#deliverySummaryBody tr[data-delivery-customer-key]').length,
    distribution:document.querySelector('#deliveryDistribution').textContent,
    filters:[...document.querySelectorAll('.orderops-delivery-filters select')].map(node=>node.id),
    summaryHeaders:[...document.querySelectorAll('.orderops-delivery-table thead th')].map(node=>node.textContent.trim()),
    summaryText:document.querySelector('#deliverySummaryBody').textContent,
    inventory:document.querySelector('#inventoryInspectorIdentity').textContent,
    metrics:document.querySelector('#inventoryInspectorMetrics').textContent
  }))()`);
  assert.deepEqual(workbench.panes, ['reference', 'work', 'result']);
  assert.equal(workbench.enhanced, 'true');
  assert.deepEqual(workbench.handles, ['left', 'right']);
  assert.equal(workbench.deliveries, 1, '배송 건수는 상품행이 아닌 고객·주문 배송 단위여야 한다.');
  assert.match(workbench.distribution, /작업자 1건/);
  assert.deepEqual(workbench.filters, ['deliveryWarehouseFilter', 'deliveryManagerFilter', 'deliveryRegionFilter']);
  assert.deepEqual(workbench.summaryHeaders, ['거래처','수량','금액','적요']);
  assert.match(workbench.summaryText, /부분상사[\s\S]*10 BOX[\s\S]*분석전 수정/);
  assert.doesNotMatch(workbench.summaryText, /20260908-001|본창고|작업자|남부|부분출고 상품/);
  assert.match(workbench.inventory, /보조 패널/, '우측은 위치·표시·너비 설정만 제공해야 한다.');
  assert.equal(workbench.metrics, '');
  await evaluate(client, `document.querySelector('#previewTable tr[data-product-code="P-1"]').click()`);
  assert.match(await evaluate(client, `document.querySelector('#inventoryInspectorIdentity').textContent`), /보조 패널/);
  assert.equal(await evaluate(client, `document.querySelector('#inventoryInspectorMetrics').textContent`), '');
  const defaultLayout = await evaluate(client, `(()=>{const workspace=document.querySelector('[data-nexus-workspace="orderops"]');const left=workspace.querySelector(':scope > [data-nexus-pane="reference"]');const center=workspace.querySelector(':scope > [data-nexus-pane="work"]');const reset=document.querySelector('#deliveryFilterReset');const table=document.querySelector('.orderops-delivery-table');return {leftWidth:left.getBoundingClientRect().width,centerWidth:center.getBoundingClientRect().width,resetRight:reset.getBoundingClientRect().right,leftRight:left.getBoundingClientRect().right,resetWidth:reset.getBoundingClientRect().width,fontSize:getComputedStyle(table).fontSize,tableWidth:table.scrollWidth}})()`);
  assert.ok(defaultLayout.leftWidth >= 370, `기본 좌측 패널 폭이 핵심 판단에 부족합니다: ${defaultLayout.leftWidth}`);
  assert.ok(defaultLayout.centerWidth > defaultLayout.leftWidth, '중앙 작업표는 기본 배치에서 좌측보다 넓어야 한다.');
  assert.ok(defaultLayout.resetRight <= defaultLayout.leftRight && defaultLayout.resetWidth > 100, '전체 버튼은 좁은 좌측 패널에서도 잘리지 않고 한 행을 사용해야 한다.');
  assert.equal(defaultLayout.fontSize, '10px', '좌측 접근성 개선을 위해 글자를 더 줄이면 안 된다.');
  assert.ok(defaultLayout.tableWidth <= defaultLayout.leftWidth + 2, `좌측 4열 표는 패널 안에 맞아야 한다: ${defaultLayout.tableWidth}`);
  const resizePreservation = await evaluate(client, `(()=>{const workspace=document.querySelector('[data-nexus-workspace="orderops"]');const left=workspace.querySelector(':scope > [data-nexus-pane="reference"]');const right=workspace.querySelector(':scope > [data-nexus-pane="result"]');const draft=document.querySelector('[data-shipment-draft-line="OI-PARTIAL"]');draft.value='7';draft.focus();document.querySelector('#previewTable').scrollLeft=18;const before={left:left.getBoundingClientRect().width,right:right.getBoundingClientRect().width};document.querySelector('[data-nexus-pane-resize="left"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return {before,after:{left:left.getBoundingClientRect().width,right:right.getBoundingClientRect().width},draft:draft.value,focused:document.activeElement===draft,scrollLeft:document.querySelector('#previewTable').scrollLeft}})()`);
  assert.ok(resizePreservation.after.left > resizePreservation.before.left);
  assert.ok(Math.abs(resizePreservation.after.right - resizePreservation.before.right) < 1);
  assert.equal(resizePreservation.draft, '7');
  assert.equal(resizePreservation.focused, true);
  await evaluate(client, `document.querySelector('#deliverySummaryBody tr[data-delivery-key]').click()`);
  const deliveryFocus = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{const row=document.querySelector('#previewTable [data-grid-row-key="order:2"]');return {selected:row?.classList.contains('orderops-selected-delivery-row'),focused:document.activeElement===row}})()`);
    return value.selected && value.focused ? value : null;
  }, 'left-order central focus');
  assert.deepEqual(deliveryFocus, { selected: true, focused: true });
  await evaluate(client, `document.querySelector('[data-preview="allocations"]').click()`);
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('.order-edit-input[data-order-field="manager"]'))`), 'detailed manager editor');
  await evaluate(client, `document.querySelector('[data-delivery-manager-filter="작업자"]').click()`);
  assert.deepEqual(await evaluate(client, `(()=>({filter:document.querySelector('#deliveryManagerFilter').value,rows:document.querySelectorAll('#deliverySummaryBody tr[data-delivery-key]').length,pressed:document.querySelector('[data-delivery-manager-filter="작업자"]').getAttribute('aria-pressed')}))()`),
    { filter: '작업자', rows: 1, pressed: 'true' }, '담당자별 건수를 누르면 해당 담당자의 주문만 모아야 한다.');
  await evaluate(client, `(()=>{const input=document.querySelector('.order-edit-input[data-order-field="manager"]');input.value='재배정';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await waitFor(() => evaluate(client, `document.querySelector('.order-edit-input[data-order-field="manager"]')?.value==='재배정'`), 'customer-unit manager synchronization');
  assert.match(await evaluate(client, `document.querySelector('#deliveryDistribution').textContent`), /재배정 1건/);
  assert.deepEqual(await evaluate(client, `(()=>({filter:document.querySelector('#deliveryManagerFilter').value,count:document.querySelector('#deliverySummaryCount').textContent,rows:document.querySelectorAll('#deliverySummaryBody tr[data-delivery-key]').length}))()`),
    { filter: '작업자', count: '현재 작업 1건 · 조회 0건', rows: 0 }, '담당자별 조회 중 재배정하면 필터는 유지하고 전체·조회 건수를 구분해야 한다.');
  await evaluate(client, `document.querySelector('#deliveryFilterReset').click()`);
  await evaluate(client, `(()=>{const input=document.querySelector('.order-edit-input[data-order-field="manager"]');input.value='중앙재배정';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await waitFor(() => evaluate(client, `document.querySelector('#deliveryDistribution').textContent.includes('중앙재배정 1건')`), 'central-to-summary customer manager synchronization');
  assert.match(await evaluate(client, `document.querySelector('#deliveryDistribution').textContent`), /중앙재배정 1건/);
  await evaluate(client, `document.querySelector('[data-preview="allocations"]').click()`);
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-shipment-draft-line="OI-PARTIAL"]'))`), 'allocation view restored after left focus');
  const panelBefore = await evaluate(client, `(()=>{const panel=document.querySelector('#inventoryInspector');return {identity:document.querySelector('#inventoryInspectorIdentity').textContent,width:panel.getBoundingClientRect().width,draft:document.querySelector('[data-shipment-draft-line="OI-PARTIAL"]').value}})()`);
  await evaluate(client, `document.querySelector('#inventoryInspectorClose').click()`);
  const panelClosed = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{const workspace=document.querySelector('[data-nexus-workspace="orderops"]');const panel=document.querySelector('#inventoryInspector');const reopen=document.querySelector('#inventoryInspectorReopen');const handle=document.querySelector('[data-nexus-pane-resize="right"]');return {hidden:panel.hidden,display:getComputedStyle(panel).display,width:panel.getBoundingClientRect().width,rightOpen:workspace.dataset.nexusRightOpen,reopenDisplay:getComputedStyle(reopen).display,handleHidden:handle.hidden}})()`);
    return value.hidden && value.display === 'none' && value.width === 0 && value.rightOpen === 'false' && value.reopenDisplay !== 'none' && value.handleHidden ? value : null;
  }, 'rendered inventory inspector close');
  assert.equal(panelClosed.rightOpen, 'false');
  await evaluate(client, `(()=>{const center=document.querySelector('[data-nexus-pane="work"]');center.scrollLeft=160;document.querySelector('#inventoryInspectorReopen').focus();return document.activeElement.id})()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  const panelReopened = await waitFor(async () => {
    const value = await evaluate(client, `(()=>{const workspace=document.querySelector('[data-nexus-workspace="orderops"]');const panel=document.querySelector('#inventoryInspector');const center=workspace.querySelector(':scope > [data-nexus-pane="work"]');const tableWrap=document.querySelector('#previewTable');const handle=document.querySelector('[data-nexus-pane-resize="right"]');const centerRect=center.getBoundingClientRect();const wrapRect=tableWrap.getBoundingClientRect();return {hidden:panel.hidden,display:getComputedStyle(panel).display,width:panel.getBoundingClientRect().width,height:panel.getBoundingClientRect().height,rightOpen:workspace.dataset.nexusRightOpen,handleHidden:handle.hidden,identity:document.querySelector('#inventoryInspectorIdentity').textContent,draft:document.querySelector('[data-shipment-draft-line="OI-PARTIAL"]').value,centerScroll:center.scrollLeft,contained:wrapRect.left>=centerRect.left-1&&wrapRect.right<=centerRect.right+1}})()`);
    return !value.hidden && value.display !== 'none' && value.width > 0 && value.height > 0 && value.rightOpen === 'true' && !value.handleHidden ? value : null;
  }, 'rendered inventory inspector reopen');
  assert.ok(Math.abs(panelReopened.width - panelBefore.width) < 1, '재열기 뒤 이전 우측 패널 폭을 유지해야 한다.');
  assert.equal(panelReopened.identity, panelBefore.identity, '재열기 뒤 선택 상품과 재고 내용을 유지해야 한다.');
  assert.equal(panelReopened.draft, panelBefore.draft, '재열기 뒤 중앙 입력값을 유지해야 한다.');
  assert.equal(panelReopened.centerScroll, 0, '키보드로 우측을 다시 열어도 중앙 패널 전체가 가로 이동하면 안 된다.');
  assert.equal(panelReopened.contained, true, '표 래퍼는 중앙 패널 경계 안에 남아야 한다.');
  await evaluate(client, `document.querySelector('.order-edit-input[data-order-field="manager"]')?.dispatchEvent(new Event('change',{bubbles:true}))`);
  assert.equal(await evaluate(client, `document.querySelector('#inventoryInspector').hidden`), false, '사용자가 우측을 다시 연 뒤 화면 갱신만으로 닫히면 안 된다.');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 819, height: 720, deviceScaleFactor: 1.25, mobile: false });
  await wait(250);
  const zoomedLayout = await evaluate(client, `(()=>{const workspace=document.querySelector('[data-nexus-workspace="orderops"]');const left=workspace.querySelector(':scope > [data-nexus-pane="reference"]');const center=workspace.querySelector(':scope > [data-nexus-pane="work"]');const right=workspace.querySelector(':scope > [data-nexus-pane="result"]');const scroller=document.querySelector('#previewTable');return {viewport:document.documentElement.clientWidth,documentWidth:document.documentElement.scrollWidth,leftDisplay:getComputedStyle(left).display,leftWidth:left.getBoundingClientRect().width,centerWidth:center.getBoundingClientRect().width,rightWidth:right.getBoundingClientRect().width,internalHorizontal:scroller.scrollWidth>scroller.clientWidth,handles:[...document.querySelectorAll('.nexus-pane-resizer-v2[data-nexus-pane-resize-app="orderops"]')].filter(node=>!node.hidden).length}})()`);
  assert.ok(zoomedLayout.viewport <= 819, `1024px·125% 상당 CSS 폭이어야 한다: ${zoomedLayout.viewport}`);
  assert.equal(zoomedLayout.documentWidth, zoomedLayout.viewport, '1024px·125% 상당 화면에서 페이지 전체 가로 넘침이 없어야 한다.');
  assert.equal(zoomedLayout.leftDisplay, 'flex');
  assert.ok(zoomedLayout.leftWidth > 0 && zoomedLayout.centerWidth > 0 && zoomedLayout.rightWidth > 0);
  assert.equal(zoomedLayout.internalHorizontal, true, '작은 화면의 가로 이동은 중앙 표 내부에서 처리해야 한다.');
  assert.equal(zoomedLayout.handles, 2, '작은 화면에서도 좌우 폭을 독립 조절할 수 있어야 한다.');
  await evaluate(client, `document.querySelector('[data-nexus-pane-resize="left"]').focus()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  const keyboardResize = await waitFor(async () => {
    const value = await evaluate(client, `document.querySelector('[data-nexus-pane="reference"]').getBoundingClientRect().width`);
    return value < zoomedLayout.leftWidth - 5 ? value : null;
  }, 'small-screen keyboard panel resize');
  assert.ok(keyboardResize < zoomedLayout.leftWidth);
  const rightDragStart = await evaluate(client, `(()=>{const rect=document.querySelector('[data-nexus-pane-resize="right"]').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+Math.min(40,rect.height/2),width:document.querySelector('[data-nexus-pane="result"]').getBoundingClientRect().width}})()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rightDragStart.x, y: rightDragStart.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rightDragStart.x + 24, y: rightDragStart.y, button: 'left', buttons: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rightDragStart.x + 24, y: rightDragStart.y, button: 'left', buttons: 0, clickCount: 1 });
  const pointerResize = await waitFor(async () => {
    const value = await evaluate(client, `document.querySelector('[data-nexus-pane="result"]').getBoundingClientRect().width`);
    return value < rightDragStart.width - 5 ? value : null;
  }, 'small-screen pointer panel resize');
  assert.ok(pointerResize < rightDragStart.width);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  const handoff = await evaluate(client, `(()=>{const work=document.querySelector('[data-shipment-draft-line="OI-PARTIAL"]');work.value='6';work.dispatchEvent(new Event('change',{bubbles:true}));const confirm=document.querySelector('[data-shipment-line="OI-PARTIAL"]');confirm.querySelector('[data-shipment-reason]').value='부분 출고';confirm.querySelector('[data-shipment-reason]').dispatchEvent(new Event('change',{bubbles:true}));return {work:work.value,confirm:confirm.querySelector('[data-shipped-quantity]').value,headers:[...document.querySelectorAll('.shipment-execution__table th')].map(node=>node.textContent.trim())}})()`);
  assert.equal(handoff.work, '6');
  assert.equal(handoff.confirm, '6', '작업표 실제 출고수량이 확정표에 전달되어야 한다.');
  assert.deepEqual(handoff.headers.slice(2, 6), ['주문수량', '기출고', '남은 주문수량', '이번 실제 출고수량']);
  await evaluate(client, `document.querySelector('#shipmentConfirmButton').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('#shipmentResultHistory').textContent.includes('확정')&&document.querySelector('[data-shipment-line="OI-PARTIAL"] [data-shipped-quantity]').value==='4'`), 'partial shipment remaining quantity');
  const partial = await evaluate(client, `(async()=>{const adapter=await import('/orderops/shipment-result-read-adapter.js?pr544');const result=await adapter.readShipmentResultsByOrder('ORD-PARTIAL');return {net:result.netByOrderItem['OI-PARTIAL'],status:result.shipmentStatus,remaining:document.querySelector('[data-shipment-line="OI-PARTIAL"] td:nth-child(5)').textContent.trim()}})()`);
  assert.deepEqual(partial, { net: 6, status: 'PARTIAL', remaining: '4 BOX' });
  await navigate(client, `${origin}/orderq/index.html?view=query&focus=ORD-PARTIAL`);
  const queryStatus = () => evaluate(client, `(()=>{const headers=[...document.querySelectorAll('.document-list thead th')];const index=headers.findIndex(header=>header.textContent.trim()==='출고상태');return document.querySelector('[data-order-id="ORD-PARTIAL"]')?.children[index]?.textContent.trim()||''})()`);
  assert.equal(await waitFor(async () => (await queryStatus()) === '부분출고' ? '부분출고' : '', 'ORDER Q partial shipment status'), '부분출고');

  await navigate(client, `${origin}/orderops/list.html?orderId=ORD-RECOVERY`);
  await waitFor(() => evaluate(client, `document.querySelector('#ordersFileName')?.textContent.includes('20260908-002')`), 'recovery order source');
  await uploadInventory(client);
  await analyze(client);
  await evaluate(client, `document.querySelector('[data-preview="allocations"]').click()`);
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-shipment-draft-line="OI-RECOVERY"]'))`), 'recovery worktable input');
  await evaluate(client, `(()=>{const work=document.querySelector('[data-shipment-draft-line="OI-RECOVERY"]');work.value='2';work.dispatchEvent(new Event('change',{bubbles:true}));const reason=document.querySelector('[data-shipment-line="OI-RECOVERY"] [data-shipment-reason]');reason.value='작업 유지 사유';reason.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-orderq-pre-m1-v6');request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['orders','orderItems'],'readwrite');const order=tx.objectStore('orders').get('ORD-RECOVERY');order.onsuccess=()=>{order.result.revision=2;order.result.updatedAt='2026-09-08T02:00:00.000Z';tx.objectStore('orders').put(order.result)};const item=tx.objectStore('orderItems').get('OI-RECOVERY');item.onsuccess=()=>{item.result.finalQuantity=6;tx.objectStore('orderItems').put(item.result)};tx.oncomplete=()=>{db.close();const channel=new BroadcastChannel('oneapp-orderq-orders');channel.postMessage({orderId:'ORD-RECOVERY'});channel.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  await waitFor(() => evaluate(client, `!document.querySelector('#shipmentSourceActions').hidden&&document.querySelector('#shipmentConfirmButton').disabled`), 'changed-order recovery choices');
  const retainedBefore = await evaluate(client, `(()=>{const row=document.querySelector('[data-shipment-line="OI-RECOVERY"]');return {quantity:row.querySelector('[data-shipped-quantity]').value,reason:row.querySelector('[data-shipment-reason]').value}})()`);
  assert.deepEqual(retainedBefore, { quantity: '2', reason: '작업 유지 사유' });
  await evaluate(client, `document.querySelector('[data-shipment-source-action="keep-work"]').click()`);
  assert.equal(await evaluate(client, `document.querySelector('#shipmentConfirmButton').disabled&&document.querySelector('#shipmentSourceActionMessage').textContent.includes('현재 작업을 유지')`), true);
  await evaluate(client, `document.querySelector('[data-shipment-source-action="apply-latest"]').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('#shipmentExecutionStatus').textContent.includes('동결 Revision 2')&&document.querySelector('#shipmentSourceActions').hidden`), 'latest order applied');
  const retainedAfter = await evaluate(client, `(()=>{const row=document.querySelector('[data-shipment-line="OI-RECOVERY"]');return {quantity:row.querySelector('[data-shipped-quantity]').value,reason:row.querySelector('[data-shipment-reason]').value,max:row.querySelector('[data-shipped-quantity]').max,confirmDisabled:document.querySelector('#shipmentConfirmButton').disabled,url:location.search}})()`);
  assert.deepEqual(retainedAfter, { quantity: '2', reason: '작업 유지 사유', max: '6', confirmDisabled: false, url: '?orderId=ORD-RECOVERY' });

  await navigate(client, `${origin}/orderops/list.html?orderId=ORD-MISSING`);
  await waitFor(() => evaluate(client, `document.querySelector('#ordersFileName')?.textContent.includes('20260908-003')`), 'missing inventory order source');
  await uploadInventory(client);
  await analyze(client);
  await evaluate(client, `document.querySelector('[data-preview="allocations"]').click()`);
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('#previewTable tr[data-product-code="P-X"]'))`), 'missing inventory order row');
  await evaluate(client, `document.querySelector('#previewTable tr[data-product-code="P-X"]').click()`);
  const missingInventory = await waitFor(async () => {
    const value = await evaluate(client, `(()=>({selected:document.querySelector('#previewTable tr.orderops-selected-product-row')?.dataset.productCode,identity:document.querySelector('#inventoryInspectorIdentity').textContent,body:document.querySelector('#inventoryInspectorBody').textContent,metrics:document.querySelector('#inventoryInspectorMetrics').textContent,region:document.querySelector('#deliveryRegionFilter').textContent}))()`);
    return value.selected === 'P-X' ? value : null;
  }, 'missing inventory product identity preservation');
  assert.equal(missingInventory.selected, 'P-X');
  assert.match(missingInventory.identity, /보조 패널/);
  assert.match(missingInventory.body, /표시 상태[\s\S]*열림/);
  assert.equal(missingInventory.metrics, '');
  assert.match(missingInventory.region, /북부/, 'ORDER Q 배송지역이 좌측 주문서 목록까지 전달되어야 한다.');

  await navigate(client, `${origin}/orderops/list.html`);
  await uploadDispatchOrders(client);
  await waitFor(() => evaluate(client, `document.querySelector('#ordersFileName')?.textContent.includes('작업자배정_주문현황')`), 'dispatch Excel order source');
  await uploadInventory(client);
  await analyzeExcelWorkspace(client);
  await evaluate(client, `document.querySelector('#ordersDrop').click()`);
  await waitFor(() => evaluate(client, `document.querySelectorAll('#deliverySummaryBody tr[data-delivery-key]').length===3`), 'three order-document summaries');
  assert.equal(await evaluate(client, `document.querySelectorAll('#deliverySummaryBody tr[data-delivery-customer-key="CUSTOMER:C-1"]').length`), 2,
    '같은 거래처의 서로 다른 주문서는 좌측에서 별도 행이어야 한다.');
  await evaluate(client, `(()=>{const input=document.querySelector('.order-edit-input[data-order-field="deliveryNotice"][data-order-row="3"]');input.value='직원메모1 수정';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await waitFor(() => evaluate(client, `document.querySelector('.order-edit-input[data-order-field="deliveryNotice"][data-order-row="3"]')?.value==='직원메모1 수정'`), 'employee note edit');
  const editedNotes = await evaluate(client, `(()=>{const summary=document.querySelector('#deliverySummaryBody tr[data-delivery-key]')?.textContent||'';const noticeInput=document.querySelector('.order-edit-input[data-order-field="deliveryNotice"][data-order-row="3"]');return {summary,input:noticeInput?.value||''}})()`);
  assert.match(editedNotes.summary, /직원메모1 수정 \/ 직원메모2/);
  assert.doesNotMatch(editedNotes.summary, /일반메모/, '좌측 직원 적요 요약에 일반 적요를 섞으면 안 된다.');
  const savedNotes = await waitFor(async () => {
    const value = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('ONEAPPShippingRecoveryDB',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const pointer=localStorage.getItem('oneapp.shipping.recovery.pointer.v1');if(!pointer){db.close();resolve(null);return}let get;try{get=db.transaction('recoveryRecords','readonly').objectStore('recoveryRecords').get(pointer)}catch(error){db.close();resolve(null);return}get.onerror=()=>{db.close();reject(get.error)};get.onsuccess=()=>{const row=get.result?.payload?.workspace?.orders?.find(item=>Number(item.sourceRowNumber)===3);resolve(row?{note:row.note,noteOriginal:row.noteOriginal,note1:row.note1,note1Original:row.note1Original}:null);db.close()}}})`);
    return value?.note1 === '직원메모1 수정' ? value : null;
  }, 'separated employee note local save');
  assert.deepEqual(savedNotes, { note:'일반메모', noteOriginal:'일반메모', note1:'직원메모1 수정', note1Original:'직원메모1 수정' });
  await navigate(client, `${origin}/orderops/list.html`);
  await waitFor(() => evaluate(client, `document.querySelector('#recoveryMessage').textContent.includes('작업자배정_주문현황')`), 'employee note recovery candidate');
  await evaluate(client, `document.querySelector('#headerRestoreButton').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('.order-edit-input[data-order-field="deliveryNotice"][data-order-row="3"]')?.value==='직원메모1 수정'`), 'employee note restored worktable');
  assert.match(await evaluate(client, `document.querySelector('#deliverySummaryBody tr[data-delivery-key]')?.textContent||''`), /직원메모1 수정 \/ 직원메모2/);
  assert.deepEqual(await evaluate(client, `(()=>({warehouse:[...document.querySelector('#deliveryWarehouseFilter').options].map(option=>option.textContent),region:[...document.querySelector('#deliveryRegionFilter').options].map(option=>option.textContent)}))()`),
    { warehouse: ['전체 창고','본창고'], region: ['전체 지역','남부','북부'] });
  await evaluate(client, `document.querySelector('[data-preview="allocations"]').click()`);
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('.order-edit-input[data-order-field="manager"][data-order-row="3"]'))`), 'restored detailed manager editor');
  await evaluate(client, `(()=>{const filter=document.querySelector('#deliveryManagerFilter');filter.value='담당A';filter.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('.order-edit-input[data-order-field="manager"][data-order-row="3"]');input.value='담당B';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const continuousAssignment = await waitFor(async () => {
    const value = await evaluate(client, `(()=>({filter:document.querySelector('#deliveryManagerFilter').value,remaining:document.querySelectorAll('#deliverySummaryBody tr[data-delivery-key]').length,distribution:document.querySelector('#deliveryDistribution').textContent,central:[...document.querySelectorAll('.order-edit-input[data-order-field="manager"]')].map(input=>input.value)}))()`);
    return value.remaining === 1 && value.central.slice(0,3).every(manager=>manager==='담당B') ? value : null;
  }, 'continuous filtered manager assignment');
  assert.equal(continuousAssignment.filter, '담당A');
  assert.match(continuousAssignment.distribution, /담당A 1건[\s\S]*담당B 2건|담당B 2건[\s\S]*담당A 1건/);
  assert.deepEqual(continuousAssignment.central, ['담당B','담당B','담당B','담당A'],
    '거래처 C-1의 숨겨진 행과 다른 주문서까지 변경하되 C-2는 유지해야 한다.');

  await navigate(client, `${origin}/orderops/list.html?orderId=DOES-NOT-EXIST`);
  const notFound = await waitFor(async () => { const value = await evaluate(client, `(()=>({notice:document.querySelector('#orderQSourceNotice').textContent,href:document.querySelector('#orderQReturnLink').getAttribute('href'),orders:document.querySelector('#ordersFileName').textContent}))()`); return value.notice.includes('주문을 찾을 수 없습니다') ? value : null; }, 'not-found recovery notice');
  assert.match(notFound.href, /orderq\/index\.html\?view=query&focus=DOES-NOT-EXIST/);
  assert.equal(notFound.orders, '파일을 선택하세요');

  console.log('PASS OrderOps browser acceptance: app-header uploaders, pre-analysis orders, direct three panes, right reopen persistence, 1024px·125% equivalent layout, print/input preservation, employee-note recovery, partial shipment, and conflict recovery.');
} finally {
  client?.close();
  browserProcess?.kill();
  server.close();
}
