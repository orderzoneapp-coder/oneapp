#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-stage3-native-'));
const screenshotDir = resolve(process.env.SMARTINPUT_ESTIMATE_BULK_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-estimate-bulk-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  if (process.env.STAGE3_DEBUG) console.error('REQUEST', request.url);
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/__stage3_native_fixture.html') return response.writeHead(200, {'Content-Type':'text/html'}).end('<!doctype html><title>isolated native fixture</title>');
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  response.end(readFileSync(target));
});

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};
const commandPath = command => {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
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
  once(method, timeout = 60_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const select = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const escape = async client => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
};
const readEstimates = client => evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('estimates','readonly').objectStore('estimates').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result);db.close();};};})`);
const readAliasMappings = client => evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('customerAliasMappings','readonly').objectStore('customerAliasMappings').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result);db.close();};};})`);

let browser;
let client;
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    try { return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] || null; } catch (_) { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  const exceptions = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => { exceptions.push(`${event.exceptionDetails?.url || ''}:${Number(event.exceptionDetails?.lineNumber || 0) + 1}:${Number(event.exceptionDetails?.columnNumber || 0) + 1} ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'}`); writeFileSync(join(screenshotDir,'stage3-module-exceptions.json'),JSON.stringify(exceptions,null,2)); console.error(exceptions.at(-1)); });
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });


  const loaded = client.once('Page.loadEventFired');
  const destination = `http://127.0.0.1:${address.port}/__stage3_native_fixture.html`;
  const probe = await fetch(destination);
  if (process.env.STAGE3_DEBUG) console.error('HTTP', probe.status, await probe.text());
  const navigation = await client.send('Page.navigate', {url:destination});
  if (process.env.STAGE3_DEBUG) console.error('NAVIGATION', navigation);
  await loaded;

  await evaluate(client, String.raw`(async () => {
    await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/smartinput/smartinput-contract.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
    const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');
    const pure=await import('/smartinput/independent-estimate.js?v=0.2.0');
    const contract=window.SMART_INPUT_CONTRACT;
    const base=contract.createDraft({activeMode:'estimate'});
    const make=(estimateId,price)=>{
      const draft=contract.normalizeModeDraft('estimate',{...base.modes.estimate,documentId:'DOC-'+estimateId,catalogRecordId:estimateId,
        header:{...base.modes.estimate.header,customerId:'CUSTOMER',customerCode:'C1',customerName:'거래처'},
        rows:[contract.normalizeRow({rowId:estimateId+'-ROW',itemCode:'P1',itemName:'상품',unit:'개',quantity:1,unitPrice:price,purchasePriceB:price,
          rowCustomerId:'CUSTOMER',rowCustomerCode:'C1',productId:'PRODUCT1',masterProductId:'PRODUCT1',reviewStatus:'CONFIRMED'})]});
      if(estimateId==='EST-A') draft.rows.push(contract.normalizeRow({...draft.rows[0],rowId:'EST-A-MISSING',itemCode:'P2',itemName:'업로드에 없는 상품',productId:'PRODUCT2',masterProductId:'PRODUCT2'}));
      const ownedRows=draft.rows.map(row=>({...row,ownedRowId:row.rowId,matchIdentity:pure.estimateIdentityFromRow(row,draft.header)}));
      const record={estimateId,companyId:'ONEAPP',schemaVersion:pure.INDEPENDENT_ESTIMATE_SCHEMA,estimateKind:'INDIVIDUAL',linkedEstimateSources:[],
        dataRevision:1,catalogName:estimateId,rowCount:1,amount:price,sortOrder:estimateId==='EST-A'?1:2,createdAt:'2026-09-01',updatedAt:'2026-09-01',ownedRows,
        displayGroups:ownedRows.map(row=>({rowId:row.rowId,ownedRowIds:[row.ownedRowId],visible:true})),draft};
      record.draft=pure.projectIndependentEstimateDraft(record);return record;
    };
    await store.saveEstimate(make('EST-A',10)); await store.saveEstimate(make('EST-B',20));
    const fields=await import('/smartinput/field-definition-contract.js');
    const mapper=await import('/smartinput/input-template-mapper.js');
    const headers=['거래처코드','품목코드','품목명','단위','수량','입고B'];
    const projections=['rowCustomerCode','itemCode','itemName','unit','quantity','purchasePriceB'];
    const definitions=projections.map((key,index)=>({id:fields.coreFieldByProjection('estimate',key)?.fieldId || key,
      projectionFieldId:key,label:headers[index],valueType:['quantity','purchasePriceB'].includes(key)?'NUMBER':'TEXT',scope:index===0?'header':'voucher'}));
    const session=mapper.createMappingSession({matrix:[headers,['C1','P1','상품','개','7','30']],companyId:'ONEAPP',voucherMode:'estimate',targetDefinitions:definitions});
    session.mappings=headers.map((sourceHeader,columnIndex)=>({columnIndex,sourceHeader,state:'MAPPED',targetFieldId:definitions[columnIndex].id,reviewed:true}));
    const template=mapper.createTemplateRecord(session,'선택 업데이트 검증',definitions);
    await store.saveInputTemplates([template],{companyId:'ONEAPP',voucherMode:'estimate'});
    base.modes.estimate=contract.normalizeModeDraft('estimate',{...base.modes.estimate,rows:[]});
    localStorage.setItem(contract.DRAFT_STORAGE_KEY,JSON.stringify(base));
    return true;
  })()`);
  const appLoaded=client.once('Page.loadEventFired');
  await client.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/smartinput/`}); await appLoaded;
  await waitFor(async () => { if(exceptions.length) throw new Error(exceptions.join('\n')); return evaluate(client, `window.__ONEAPP_SMARTINPUT_EARLY_UI__?.ready`); }, 'app module ready');
  assert.deepEqual(exceptions,[], 'app must boot without runtime exceptions');
  await expr(client, `document.querySelectorAll('.estimate-card').length===2`, 'estimate cards');
  assert.equal(await evaluate(client, `Boolean(document.querySelector('#estimateLibraryLinkedButton,#linkedEstimateList,#estimateCreateButton'))`),false);
  await click(client,'#estimateMultiSelectButton');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===2 && document.querySelectorAll('#inputRows tr[data-row-id]:not([data-default-row])').length===3`, 'all selected rows');
  await click(client,'#estimateDeselectAllButton');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===0`, 'deselect all');
  await click(client,'[data-estimate-id="EST-A"] [data-select-estimate-card]');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===1 && document.querySelector('#inputRows input[data-field="quantity"]')`, 'single selection');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows input[data-field="quantity"]');input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await click(client,'#estimateDeselectAllButton');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===0`, 'dirty deselection');
  await click(client,'[data-estimate-id="EST-A"] [data-select-estimate-card]');
  await expr(client, `document.querySelector('#inputRows input[data-field="quantity"]')?.value==='7'`, 'dirty work preserved on reopen');
  const before=await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');return (await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-B'})).record;})()`);
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');const a=await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-A'});return a.record.ownedRows[0].quantity===7;})()`, 'selected general edit committed');
  const after=await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');return (await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-B'})).record;})()`);
  assert.deepEqual(after,before,'unselected estimate must remain byte-equivalent');
  assert.equal(await evaluate(client, `document.querySelector('#estimateExcludedCount').textContent`),'업데이트 제외: 0건');
  await evaluate(client, String.raw`(()=>{const data=new DataTransfer();data.items.add(new File(['\ufeff거래처코드,품목코드,품목명,단위,수량,입고B\r\nC1,P1,상품,개,7,30\r\nC1,EXTRA,추가상품,개,1,5'],'선택 업데이트.csv',{type:'text/csv'}));const input=document.querySelector('#fileInput');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await expr(client, `document.querySelector('#sourceTextInput').value.includes('EXTRA') && !document.querySelector('#completeButton').disabled`, 'real CSV loaded with confirmed template');
  assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-card.is-selected').length`),1,'selection survives file load');
  const excelText=await evaluate(client, `document.querySelector('#sourceTextInput').value`);
  await click(client,'[data-estimate-id="EST-B"] [data-select-estimate-card]');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===2`, 'Excel then target selection');
  assert.equal(await evaluate(client, `document.querySelector('#sourceTextInput').value`),excelText,'selection must not replace Excel');
  await click(client,'[data-estimate-id="EST-B"] [data-select-estimate-card]');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===1`, 'individual deselection');
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');const a=await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-A'});return a.record.ownedRows[0].purchasePriceB===30;})()`, 'selected Excel update committed');
  assert.deepEqual(await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.6.4');return (await store.loadEstimateForUpdate({companyId:'ONEAPP',estimateId:'EST-B'})).record;})()`),before);
  await expr(client, `document.querySelector('#estimateExcludedCount').textContent==='업데이트 제외: 1건'`, 'Excel unmatched row count');
  await click(client,'#estimateExcludedToggle');
  await expr(client, `document.querySelectorAll('#inputRows tr[data-row-id]:not([data-default-row])').length===1`, 'same table exclusion filter');
  await click(client,'#resetDraftButton');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===0`, 'reset clears explicit selection');
  await click(client,'#estimateMultiSelectButton');
  await expr(client, `document.querySelectorAll('.estimate-card.is-selected').length===2 && document.querySelectorAll('#inputRows tr[data-row-id]:not([data-default-row])').length===3`, 'all estimates after reset');
  assert.equal(await evaluate(client, `document.querySelector('#estimateExcludedCount').textContent`),'업데이트 제외: 1건','last round excludes missing target, no-history estimate does not add exclusions');
  await click(client,'#estimateExcludedToggle');
  await expr(client, `document.querySelector('#inputRows input[data-field="itemCode"]')?.value==='P2'`, 'last Excel exclusion joined to owner row');
  assert.deepEqual(exceptions,[]);
  console.log('PASS: actual app boot, linked UI removal, select/deselect, dirty work reopen, target-only general save, real CSV selection preservation/update and exclusion filter');

} catch(error) {
  if(client) {
    try {
      const diagnostics=await evaluate(client,`({text:document.body.innerText.slice(-16000),title:document.title})`);
      writeFileSync(join(screenshotDir,'stage3-ui-failure.json'),JSON.stringify({error:error.stack,diagnostics},null,2));
      const shot=await client.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshotDir,'stage3-ui-failure.png'),Buffer.from(shot.data,'base64'));
      console.error(JSON.stringify(diagnostics));
    }catch(captureError){console.error(captureError.message);}
  }
  throw error;
} finally {
  client?.close();browser?.kill();await new Promise(done=>server.close(done));
  try{rmSync(profile,{recursive:true,force:true});}catch(_){}
}
