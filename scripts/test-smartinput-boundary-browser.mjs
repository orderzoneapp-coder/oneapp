#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'si-boundary-browser-'));
const evidenceDir = join(root, 'evidence/si-boundary-20260920-01');
mkdirSync(evidenceDir, { recursive: true });
const report = { taskId: 'SI-BOUNDARY-20260920-01', mainSourceSha256: createHash('sha256').update(readFileSync(join(root, 'smartinput/smartinput.js'))).digest('hex'), fixture: 'Synthetic local-only data and host fixture; real child bridge and application source', checks: [], unverified: ['Actual NEXUS app-to-app transition KPI', 'Production user data or authentication service'] };
const record = (name, detail) => { report.checks.push({ name, status: 'PASS', detail }); console.log(`PASS ${name}`); };
let blockCommon = false;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const hostFixture = `<!doctype html><title>SmartInput isolated bridge fixture</title>
<script>window.__bridgeEvents=[];window.sendHost=(type,extra={})=>document.querySelector('iframe').contentWindow.postMessage({schemaVersion:'nexus-workspace-message/v1',type,transitionId:'BOUNDARY-HOST-1',appId:'smart-input',route:'smartinput/index.html',...extra},location.origin);window.addEventListener('message',event=>{if(event.origin!==location.origin)return;window.__bridgeEvents.push(event.data);if(event.data?.type==='NEXUS_WORKSPACE_BRIDGE_READY_V1')window.sendHost('NEXUS_WORKSPACE_HOST_READY_V1',{theme:'light'});});</script>
<iframe id="boundaryFrame" src="/smartinput/index.html" style="width:100%;height:950px"></iframe>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/nexus/workspace.html' && url.searchParams.has('boundaryFixture')) return response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(hostFixture);
  if (pathname === '/__boundary_blank.html') return response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>isolated fixture</title>');
  if (blockCommon && /^\/nexus\/common\/nexus-ui(?:-theme-init)?\.js$/.test(pathname)) return response.writeHead(503).end('Injected shared UI outage');
  const target = normalize(resolve(root, `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end();
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end();
  response.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (target === join(root, 'smartinput', 'smartinput.js')) response.end(`${readFileSync(target, 'utf8')}\nwindow.__boundaryReadModel=()=>({activeMode:state.draft.activeMode,rows:modeDraft().rows.map(row=>({rowId:row.rowId,itemCode:row.itemCode,itemName:row.itemName,quantity:row.quantity})),hasGridPasteUndo:Boolean(state.gridPasteUndo)});`);
  else response.end(readFileSync(target));
});
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(check, name, timeout = 25000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await wait(40); }
  throw new Error(`${name} timed out${last ? `: ${last.message}` : ''}`);
}
class Cdp {
  constructor(url) { this.url = url; this.pending = new Map(); this.listeners = new Map(); this.id = 0; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = event => { const item = JSON.parse(event.data); if (item.id) { const request = this.pending.get(item.id); if (!request) return; this.pending.delete(item.id); return item.error ? request.reject(new Error(item.error.message)) : request.resolve(item.result); } for (const listener of this.listeners.get(item.method) || []) listener(item.params); };
    await new Promise((resolveOpen, reject) => { this.socket.onopen = resolveOpen; this.socket.onerror = reject; });
  }
  send(method, params = {}) { return new Promise((resolveSend, reject) => { const id = ++this.id; this.pending.set(id, { resolve: resolveSend, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  on(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}
let browser; let client; let embedded = false;
const app = expression => client.eval(embedded ? `document.querySelector('#boundaryFrame').contentWindow.eval(${JSON.stringify(expression)})` : expression);
const check = (expression, label) => until(() => app(expression), label);
const click = selector => app(`document.querySelector(${JSON.stringify(selector)}).click();true`);
const setInput = (selector, value, emitChange = true) => app(`(() => {const element=document.querySelector(${JSON.stringify(selector)});element.focus();Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));${emitChange ? "element.dispatchEvent(new Event('change',{bubbles:true}));" : ''}return true;})()`);
const ledgerReads = async () => app(`window.__boundary.reads.filter(item=>/^(orders|orderItems|orderEvents|salesDocuments|salesLines|purchaseDocuments|purchaseLines|ledgerDocuments|ledgerLines|officialCommands|voucherRevisions|inventoryMovements|payableEntries|receivableEntries|pendingInventoryEffects|inventoryCheckpoints|unresolvedProducts|inventorySnapshots|inventoryLines|historicalOrderGroups|historicalOrderLines|fulfillmentLinks|fulfillmentBalances|syncQueue)$/.test(item.store))`);
const assertIndependent = async label => { const reads = await ledgerReads(); assert.deepEqual(reads, [], `${label}: owner ledger/sync queue must stay unread`); const writes = await app(`window.__boundary.writes.filter(item=>/orderq/i.test(item.database))`); assert.deepEqual(writes, [], `${label}: independent work must not mutate owner storage`); const network = await app('window.__boundary.external'); assert.deepEqual(network, [], `${label}: independent path must not request external services`); record(label, { ledgerReads: reads.length, ownerWrites: writes.length, externalRequests: network.length }); };
const firstQuantity = '#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]';
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executable = [process.env.CHROME_PATH, process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'), '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(existsSync);
  assert.ok(executable, 'Chrome or Edge required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const port = await until(() => { try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; } catch { return ''; } }, 'browser debugging');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  client = new Cdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl); await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  const exceptions = []; const deniedRequests = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  client.on('Page.javascriptDialogOpening', () => { void client.send('Page.handleJavaScriptDialog', { accept: true }); });
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  client.on('Fetch.requestPaused', event => { const external = /^https?:/.test(event.request.url) && !event.request.url.startsWith(origin); if (external) deniedRequests.push({ url: event.request.url, method: event.request.method }); void client.send(external ? 'Fetch.failRequest' : 'Fetch.continueRequest', external ? { requestId: event.requestId, errorReason: 'BlockedByClient' } : { requestId: event.requestId }); });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__boundary={reads:[],writes:[],external:[],prints:0}; const state=window.__boundary;
    window.print=()=>{state.prints++;};
    for(const method of ['get','getAll','openCursor','count']) {const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){state.reads.push({database:this.transaction.db.name,store:this.name,method,...(/^(orders|orderItems|syncQueue)$/.test(this.name)?{stack:new Error().stack}:{})});return original.apply(this,args);};}
    for(const method of ['get','getAll','openCursor','count']) {const original=IDBIndex.prototype[method];IDBIndex.prototype[method]=function(...args){state.reads.push({database:this.objectStore.transaction.db.name,store:this.objectStore.name,index:this.name,method});return original.apply(this,args);};}
    for(const method of ['put','add','delete','clear']) {const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){state.writes.push({database:this.transaction.db.name,store:this.name,method});return original.apply(this,args);};}
    const nativeFetch=window.fetch;window.fetch=function(resource,options){const url=String(typeof resource==='string'?resource:resource?.url||resource);if(new URL(url,location.href).origin!==location.origin)state.external.push({url,method:options?.method||'GET'});return nativeFetch.apply(this,arguments);};
  })();` });
  const navigate = async (url, inFrame = false) => { embedded = inFrame; await client.send('Page.navigate', { url }); await check(`Boolean(document.querySelector('#inputRows tr'))&&!document.querySelector('#analyzeButton')?.disabled`, 'application input ready'); };
  await client.send('Page.navigate', { url: `${origin}/__boundary_blank.html` });
  await until(() => client.eval('document.readyState==="complete"'), 'fixture ready');
  await client.eval(`localStorage.setItem('merchMaster_v870',JSON.stringify([{productId:'BOUNDARY-P1',itemCode:'0001',itemName:'사과',finalUnit:'EA',status:'ACTIVE',outPrice:1000}]));localStorage.setItem('merchMaster_revision_v870','1');true`);
  await navigate(`${origin}/smartinput/`);
  await wait(400);
  await assertIndependent('direct entry');
  await setInput('#sourceTextInput', '경계확인 고객\n사과 2개\n배 3개'); await click('#analyzeButton');
  await check(`document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length===2&&!document.querySelector('#analyzeButton').disabled`, 'two text input rows');
  await setInput(firstQuantity, '0');
  await check(`JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')||'{}').modes?.order?.rows?.[0]?.quantity===0`, 'local zero quantity autosave');
  await assertIndependent('text analysis and autosave');
  await app(`new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/customer-master/vendor/xlsx.full.min.js';script.onload=()=>{XLSX.writeFile=(book,name)=>{window.__boundary.workbook={name,bytes:XLSX.write(book,{type:'array',bookType:'xlsx'}).byteLength,sheets:book.SheetNames.map(sheet=>({name:sheet,rows:XLSX.utils.sheet_to_json(book.Sheets[sheet],{header:1,defval:''})}))};};resolve(true);};script.onerror=reject;document.head.append(script);})`);
  await click('#estimateExcelButton'); await check('Boolean(window.__boundary.workbook)', 'Excel serialization');
  const workbook = await app('window.__boundary.workbook'); assert.ok(workbook.bytes > 1000); assert.match(workbook.name, /스마트입력_주문서_/); assert.match(JSON.stringify(workbook.sheets), /사과/);
  record('local Excel output', workbook); await assertIndependent('Excel output boundary');
  // Reproduce the old full-suite undo assertion, then observe the next render.
  const undoState = () => app(`(() => {const input=document.querySelector(${JSON.stringify(firstQuantity)});const row=input?.closest('tr');return {value:input?.value,modelQuantity:window.__boundaryReadModel?.().rows.find(item=>item.rowId===row?.dataset.rowId)?.quantity,attribute:input?.getAttribute('value'),activeTag:document.activeElement?.tagName,activeField:document.activeElement?.dataset?.field,activeInRow:row?.contains(document.activeElement),hasGridPasteUndo:Boolean(window.__boundaryReadModel?.().hasGridPasteUndo),cachedQuantity:row?.__virtualHtml?.match(/<input[^>]*data-field="quantity"[^>]*>/)?.[0]};})()`);
  const undoBeforePaste = await undoState();
  await app(String.raw`(() => {const row=document.querySelector('#inputRows tr:not([data-default-row="true"])');const fields=[...document.querySelectorAll('#voucherInputTable thead th[data-column]')].filter(th=>!th.classList.contains('is-column-hidden')).map(th=>th.dataset.column).filter(field=>row.querySelector('[data-field="'+CSS.escape(field)+'"],[data-custom-row-field="'+CSS.escape(field)+'"]'));const headers=fields.map(field=>document.querySelector('#voucherInputTable thead th[data-column="'+CSS.escape(field)+'"]').childNodes[0]?.textContent?.trim()||document.querySelector('#voucherInputTable thead th[data-column="'+CSS.escape(field)+'"]').textContent.trim());const values=fields.map(field=>{const input=row.querySelector('[data-field="'+CSS.escape(field)+'"],[data-custom-row-field="'+CSS.escape(field)+'"]');return field==='quantity'?'8':input.value;});const target=row.querySelector('[data-field="'+CSS.escape(fields[0])+'"]');const text=headers.join('\t')+'\n'+values.join('\t');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?text:''}});target.dispatchEvent(event);return true;})()`);
  await check(`document.querySelector(${JSON.stringify(firstQuantity)}).value==='8'`, 'paste quantity 8');
  const undoAfterPaste = await undoState();
  const undoImmediate = await app(`(() => {document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true,cancelable:true}));return document.querySelector(${JSON.stringify(firstQuantity)}).value;})()`);
  await app('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await wait(250);
  const undoLater = await undoState();
  assert.equal(undoLater.value, '0', 'explicit undo must restore the visible input as well as its saved model');
  record('paste undo displayed row recovery', { beforePaste: undoBeforePaste, afterPaste: undoAfterPaste, immediateValue: undoImmediate, afterRender: undoLater, expectedValue: '0' });
  await assertIndependent('paste undo local boundary');
  for (const mode of ['purchase', 'sale', 'estimate', 'order']) {
    await click(`.mode-tab[data-mode="${mode}"]`);
    await check(`document.querySelector('.mode-tab.is-active')?.dataset.mode===${JSON.stringify(mode)}`, `${mode} local tab`);
  }
  await assertIndependent('all four local voucher tabs');
  // The earlier independent checks used an absent owner database. Create an
  // empty isolated owner fixture now, so explicit lookup must exercise reads.
  await app(`(async()=>{const module=await import('/orderq/orderq-db.js');const db=await module.openOrderQDb();db.close();window.__boundary.reads=[];window.__boundary.writes=[];return true;})()`);
  report.explicitReadFixture = 'Empty ORDER Q database created in the temporary profile only after absent-owner independent checks; fixture setup reads/writes are excluded from the next action';
  await click('#voucherActivityReload');
  await until(async () => (await ledgerReads()).length > 0, 'explicit voucher list query');
  record('explicit voucher list prepares owner read', await ledgerReads());

  await navigate(`${origin}/nexus/workspace.html?boundaryFixture=1`, true);
  await until(() => client.eval(`window.__bridgeEvents?.some(item=>item.type==='NEXUS_WORKSPACE_APP_READY_V1')`), 'real child bridge APP_READY');
  await assertIndependent('embedded initial entry');
  await setInput(firstQuantity, '9', false);
  await client.eval(`window.sendHost('NEXUS_WORKSPACE_BEFORE_LEAVE_V1');true`);
  const leave = await until(() => client.eval(`window.__bridgeEvents?.findLast(item=>item.type==='NEXUS_WORKSPACE_LEAVE_RESULT_V1')`), 'beforeLeave flush');
  assert.equal(leave.result, 'READY', leave.message);
  assert.equal(await app(`JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.order.rows[0].quantity`), 9);
  await client.eval(`window.sendHost('NEXUS_WORKSPACE_THEME_V1',{theme:'dark'});window.sendHost('NEXUS_WORKSPACE_PRINT_V1');true`);
  await check(`document.documentElement.dataset.nexusUiTheme==='dark'&&window.__boundary.prints===1`, 'host theme and print');
  record('host adapter contracts', { appReady: true, beforeLeave: leave, savedUnblurredQuantity: 9, theme: 'dark', printCalls: 1 });
  await assertIndependent('host bridge does not enable business integration');

  blockCommon = true;
  await navigate(`${origin}/smartinput/index.html?sharedUiFailure=1`);
  assert.equal(await app(`Boolean(document.querySelector('.nexus-ui-header'))`), false);
  await check(`document.querySelector(${JSON.stringify(firstQuantity)}).value==='9'`, 'saved last input restored during shared UI outage');
  await setInput(firstQuantity, '11');
  await check(`JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')||'{}').modes?.order?.rows?.[0]?.quantity===11`, 'autosave during shared UI outage');
  await app(`document.querySelector(${JSON.stringify(firstQuantity)}).value='99';true`);
  await click('#restoreAutosaveButton'); await check(`document.querySelector(${JSON.stringify(firstQuantity)}).value==='11'`, 'explicit local restore during shared UI outage');
  await assertIndependent('shared UI and external-server outage input/save/recovery');
  assert.deepEqual(deniedRequests, [], 'ordinary local work must not attempt external requests');

  // Existing aliases are prepared only by the real explicit toolbar action.
  // Seed synthetic owner rows in this test profile, then exclude fixture writes.
  blockCommon = false;
  await navigate(`${origin}/smartinput/index.html?matchingPreparation=1`);
  await click('#resetDraftButton');
  await setInput('#sourceTextInput', '테스트 고객\n노란거 2개'); await click('#analyzeButton');
  await check(`document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="itemName"]')?.value==='노란거'&&!document.querySelector('#analyzeButton').disabled`, 'unprepared alias keeps original text');
  await check(`document.querySelector('#inputMatchingStatus')?.textContent==='NOT_PREPARED'`, 'first profile reports missing preparation');
  assert.equal(await app(`document.querySelector('#inputMatchingNotice').hidden`), false);
  await assertIndependent('unprepared alias remains local');
  const rowsBeforePreparation = await app('window.__boundaryReadModel().rows');
  await app(`(async()=>{const {openOrderQDb}=await import('/orderq/orderq-db.js');const db=await openOrderQDb();await new Promise((resolve,reject)=>{const tx=db.transaction(['products','productMappings'],'readwrite');tx.objectStore('products').put({productId:'BOUNDARY-ALIAS-P1',itemCode:'001',itemName:'수입바나나',specification:'13kg',unit:'BOX'});tx.objectStore('productMappings').put({mappingId:'BOUNDARY-ALIAS-M1',productId:'BOUNDARY-ALIAS-P1',rawText:'노란거'});tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});db.close();window.__boundary.reads=[];window.__boundary.writes=[];return true;})()`);
  await click('#allReferenceReload');
  await check(`document.querySelector('#inputMatchingStatus')?.textContent==='READY'&&!document.querySelector('#allReferenceReload').disabled`, 'explicit toolbar prepares matching snapshot');
  assert.deepEqual(await app('window.__boundaryReadModel().rows'), rowsBeforePreparation, 'reference preparation must not overwrite active rows');
  const preparationReads = await ledgerReads();
  assert.ok(preparationReads.some(read => read.store === 'orders') && preparationReads.some(read => read.store === 'orderItems'));
  record('explicit matching preparation preserves active rows', { ledgerReads: preparationReads.length, externalAttemptsBlocked: deniedRequests.length });
  deniedRequests.length = 0;
  await app('window.__boundary.reads=[];window.__boundary.writes=[];window.__boundary.external=[];true');
  await click('#analyzeButton');
  await check(`document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="itemName"]')?.value==='수입바나나'&&!document.querySelector('#analyzeButton').disabled`, 'same source reanalysis uses prepared alias');
  const aliasRow = await app(`(()=>{const row=document.querySelector('#inputRows tr:not([data-default-row="true"])');return Object.fromEntries(['itemCode','itemName','specification','quantity','unit'].map(field=>[field,row.querySelector('[data-field="'+field+'"]')?.value]));})()`);
  assert.deepEqual(aliasRow, { itemCode: '001', itemName: '수입바나나', specification: '13kg', quantity: '2', unit: '개' });
  await assertIndependent('prepared alias reanalysis uses local snapshot');
  await navigate(`${origin}/smartinput/index.html?matchingCached=1`);
  await check(`document.querySelector('#inputMatchingStatus')?.textContent==='READY'&&document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="itemName"]')?.value==='수입바나나'`, 'prepared alias cache and document survive reload');
  await assertIndependent('prepared alias reload uses cache without owner reads');
  record('preserved alias final row values', aliasRow);
  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(deniedRequests, [], 'normal local paths must not even attempt external requests');
  report.isolation = { temporaryProfile: true, externalNetworkBlocked: true, actualExternalRequestsSent: 0, productionDataUsed: false };
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack;
  try { report.failureDiagnostic = await app(`({url:location.href,body:document.body.innerText.slice(-2500),state:window.__boundary,model:window.__boundaryReadModel?.(),visibleRows:[...document.querySelectorAll('#inputRows tr[data-row-id]')].map(row=>({rowId:row.dataset.rowId,quantity:row.querySelector('[data-field="quantity"]')?.value})),hasGridPasteUndo:Boolean(window.__boundaryReadModel?.().hasGridPasteUndo),activeField:document.activeElement?.dataset?.field,activeRowId:document.activeElement?.closest('tr')?.dataset?.rowId})`); } catch {}
  throw error;
} finally {
  writeFileSync(join(evidenceDir, 'after-boundary-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  client?.socket?.close(); browser?.kill(); server.close();
  const target = resolve(profile); if (target.startsWith(`${resolve(tmpdir())}${sep}`) && target.includes('si-boundary-browser-')) { try { rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
}
