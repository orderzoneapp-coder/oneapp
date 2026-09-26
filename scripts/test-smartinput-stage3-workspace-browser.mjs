#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOPPING_ORDER_HEADERS } from '../orderq/shopping-order-dedupe-core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-stage3-native-'));
const screenshotDir = resolve(process.env.SMARTINPUT_ESTIMATE_BULK_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-estimate-bulk-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const downloadDir = join(profile, 'downloads');
mkdirSync(downloadDir, { recursive: true });
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
let exceptions = [];
let consoleErrors = [];
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
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  exceptions = [];
  consoleErrors = [];
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
    const fields=await import('/smartinput/reference-refresh-controller.js?v=0.3.0');
    const mapper=await import('/smartinput/input.js');
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
  await click(client,'.mode-tab[data-mode="purchase"]');
  await expr(client, `document.querySelector('.mode-tab[data-mode="purchase"]').getAttribute('aria-selected')==='true' && document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]')`, 'purchase mode ready');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]');input.value='SmartInput 독립 저장 검증';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="itemName"]')?.value==='SmartInput 독립 저장 검증'`, 'purchase row materialized');
  await evaluate(client, `(()=>{const customer=document.querySelector('#customerInput');customer.value='독립 보고서 거래처';customer.dispatchEvent(new Event('input',{bubbles:true}));const row=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row])');for(const [field,value] of [['itemCode','SI-REPORT-1'],['quantity','2'],['unitPrice','150']]){const input=row.querySelector('[data-field="'+field+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
  await expr(client, `document.querySelector('#completeButton').textContent==='내 자료 저장' && !document.querySelector('#completeButton').disabled`, 'purchase uses standalone save');
  await click(client,'#completeButton');
  const savedDocument = await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const list=await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'purchase'});return list[0]||null;})()`, 'purchase work document persisted');
  assert.ok(savedDocument?.documentId && savedDocument.revision===1,'purchase must commit one SmartInput-owned document');
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedDocument.documentId}"]')`, 'saved work list entry');
  await click(client,`[data-open-saved-work-document="${savedDocument.documentId}"]`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]')?.value==='2'`, 'saved work reopens into the editor');
  await expr(client, `!document.querySelector('#completeButton').disabled`, 'saved work open transaction finished');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]');input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await expr(client, `!document.querySelector('#completeButton').disabled`, 'edited work ready to save');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const autosave=await store.loadLatestAutosave();return String(autosave?.draft?.modes?.purchase?.rows?.[0]?.quantity)==='3';})()`, 'purchase autosave settled before same-document reopen');
  await click(client,`[data-open-saved-work-document="${savedDocument.documentId}"]`);
  await expr(client, `document.querySelector('#appStatusMessage').textContent.includes('내 자료 저장') && document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]')?.value==='3' && !document.querySelector('#completeButton').disabled`, 'same-document reopen blocks unsaved own-work edits after autosave');
  assert.equal(await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const opened=await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedDocument.documentId)}});return opened.record.revision===1&&String(opened.record.payload.rows[0].quantity)==='2';})()`),true,
    'blocked same-document reopen must not change the saved document');
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const opened=await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedDocument.documentId)}});return opened.status==='READY'&&opened.record.revision===2&&String(opened.record.payload.rows[0].quantity)==='3';})()`, 'edited work resaved to the same document');
  await expr(client, `!document.querySelector('#estimateExcelButton').disabled`, 'saved work transaction finished before report');
  await expr(client, `document.querySelector('#toast').hidden`, 'previous save confirmation cleared before report');
  const savedBeforeReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedDocument.documentId)}})).record;})()`);
  await click(client,'#estimateExcelButton');
  await expr(client, `document.querySelector('#appStatusMessage').textContent.includes('DataOps 판매업로드 생성 완료') || !document.querySelector('#toast').hidden`, 'report attempt completed from reopened purchase work', 30_000);
  const reportNotice = await evaluate(client, `({status:document.querySelector('#appStatusMessage').textContent,toast:document.querySelector('#toast').textContent})`);
  assert.match(reportNotice.status, /판매업로드 생성 완료 · 1행/, `report generation failed or did not reconstruct its source row: ${JSON.stringify(reportNotice)}`);
  await waitFor(() => readdirSync(downloadDir).find(name => name.toLowerCase().endsWith('.xlsx')), 'purchase report workbook downloaded', 10_000);
  const savedAfterReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedDocument.documentId)}})).record;})()`);
  assert.deepEqual(savedAfterReport,savedBeforeReport,'report output must not save or mutate the standalone source document');
  const savedPhotoId = 'SIWORK-PHOTO-BROWSER';
  const photoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const base=(await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedDocument.documentId)}})).record;const payload={...base.payload,documentId:'SIDOC-PHOTO-BROWSER',activeMethod:'photo',savedWorkDocumentId:${JSON.stringify(savedPhotoId)},savedWorkRevision:1};await store.commitSmartInputWorkDocument({companyId:'ONEAPP',voucherMode:'purchase',documentId:${JSON.stringify(savedPhotoId)},expectedRevision:0,operationId:'PHOTO-BROWSER-OP-1',title:'사진 원본 보존 검증',actorId:'TEST',summary:{rowCount:1},payload,sourceImage:{sourceImageId:'SIIMG-PHOTO-BROWSER',fileName:'source.png',mimeType:'image/png',byteLength:68,contentHash:'photo-browser',dataUrl:${JSON.stringify(photoDataUrl)}},updatedAt:new Date().toISOString()});return true;})()`);
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedPhotoId}"]')`, 'saved photo work listed');
  await click(client,`[data-open-saved-work-document="${savedPhotoId}"]`);
  await expr(client, `document.querySelector('#photoPreview').src===${JSON.stringify(photoDataUrl)} && !document.querySelector('#photoPreview').hidden`, 'saved photo restored into the editor');
  await click(client,'#saveWorkDocumentAsButton');
  const photoCopy = await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const list=await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'purchase'});return list.find(row=>row.documentId!==${JSON.stringify(savedPhotoId)}&&row.sourceImageId==='SIIMG-PHOTO-BROWSER')||null;})()`, 'save-as-new retains photo in independent work');
  assert.notEqual(photoCopy.documentId,savedPhotoId,'photo save-as-new must allocate an independent work ID');
  await click(client,'#clearParserButton');
  await expr(client, `document.querySelector('#photoPreview').hidden`, 'parser clear removes only the current photo editor');
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const copy=await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(photoCopy.documentId)}});return copy.status==='READY'&&copy.record.revision===2&&!copy.sourceImage;})()`, 'cleared copy saved without changing original photo');
  await click(client,'#resetDraftButton');
  await expr(client, `document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]')`, 'new purchase editor ready after photo reset');
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedPhotoId}"]')`, 'original saved photo still listed after clearing copy');
  await click(client,`[data-open-saved-work-document="${savedPhotoId}"]`);
  await expr(client, `document.querySelector('#photoPreview').src===${JSON.stringify(photoDataUrl)} && !document.querySelector('#photoPreview').hidden`, 'original saved photo survives save-as-new and clearing copy');
  await click(client,'.mode-tab[data-mode="sale"]');
  await expr(client, `document.querySelector('.mode-tab[data-mode="sale"]').getAttribute('aria-selected')==='true' && document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]')`, 'sale mode ready without official service');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]');input.value='독립 판매 자료';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="itemName"]')?.value==='독립 판매 자료'`, 'sale row materialized');
  await evaluate(client, `(()=>{const customer=document.querySelector('#customerInput');customer.value='독립 판매 보고서 거래처';customer.dispatchEvent(new Event('input',{bubbles:true}));const row=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row])');for(const [field,value] of [['itemCode','SI-SALE-1'],['itemName','독립 판매 자료'],['quantity','2'],['unitPrice','180']]){const input=row.querySelector('[data-field="'+field+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent==='내 자료 저장' && !document.querySelector('#officialDeliveryButton').hidden && !document.querySelector('#completeButton').disabled`),true,
    'sale own save must be available independently of the separate official delivery action');
  await evaluate(client, `(()=>{window.__smartInputNativePut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(this.name==='draftVouchersV2'&&value.schemaVersion==='ONEAPP_SMARTINPUT_SAVED_WORK_DOCUMENT_V1')throw new DOMException('INJECTED_OWN_SAVE_FAILURE','AbortError');return window.__smartInputNativePut.call(this,value,...args);};return true;})()`);
  await click(client,'#completeButton');
  await expr(client, `document.querySelector('#appStatusMessage').textContent.includes('내 자료 저장 실패') && !document.querySelector('#completeButton').disabled`, 'failed local sale save returns to an editable state');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="itemCode"]').value==='SI-SALE-1'&&document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]').value==='2'`),true,
    'failed sale save must preserve current rows and values');
  assert.equal(await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'sale'})).length;})()`),0,
    'failed first save must not leave a partial sale document');
  await evaluate(client, `(()=>{IDBObjectStore.prototype.put=window.__smartInputNativePut;delete window.__smartInputNativePut;return true;})()`);
  await click(client,'#completeButton');
  const savedSale = await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const list=await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'sale'});return list[0]||null;})()`, 'sale work document persisted without official service');
  assert.ok(savedSale?.documentId && savedSale.revision===1,'sale must create one SmartInput-owned document while official service is deferred');
  await click(client,'#resetDraftButton');
  await expr(client, `document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]')`, 'new unsaved sale editor ready');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]');input.value='열기 전 미저장 신규 자료';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const autosave=await store.loadLatestAutosave();return autosave?.draft?.modes?.sale?.rows?.[0]?.itemName==='열기 전 미저장 신규 자료';})()`, 'new unsaved sale autosave settled');
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedSale.documentId}"]')`, 'saved sale work list entry');
  await click(client,`[data-open-saved-work-document="${savedSale.documentId}"]`);
  await expr(client, `document.querySelector('#appStatusMessage').textContent.includes('내 자료 저장') && document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="itemName"]')?.value==='열기 전 미저장 신규 자료' && !document.querySelector('#completeButton').disabled`, 'saved-document reopen blocks unsaved new work after autosave');
  assert.equal(await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'sale'})).length;})()`),1,
    'blocked new-document reopen must not silently save or replace either document');
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const list=await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'sale'});return list.length===2&&list.some(row=>row.documentId!==${JSON.stringify(savedSale.documentId)});})()`, 'new work explicitly saved before switching');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedSale.documentId}"]') && !document.querySelector('#completeButton').disabled`, 'prior saved sale remains accessible');
  await click(client,`[data-open-saved-work-document="${savedSale.documentId}"]`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]')?.value==='2'`, 'saved sale work reopens into the editor');
  await expr(client, `!document.querySelector('#completeButton').disabled`, 'saved sale work open transaction finished');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]');input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const opened=await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedSale.documentId)}});return opened.status==='READY'&&opened.record.revision===2&&String(opened.record.payload.rows[0].quantity)==='3';})()`, 'sale work resaved to the same document ID');
  await expr(client, `!document.querySelector('#completeButton').disabled && !document.querySelector('#estimateExcelButton').disabled`, 'sale resave finished and report remains available');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]');input.value='4';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const opened=await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedSale.documentId)}});return opened.status==='READY'&&opened.record.revision===3&&String(opened.record.payload.rows[0].quantity)==='4';})()`, 'third sale save keeps one SmartInput document');
  await expr(client, `!document.querySelector('#estimateExcelButton').disabled`, 'sale report enabled after third save');
  await expr(client, `document.querySelector('#toast').hidden`, 'previous sale save confirmation cleared before report');
  const saleBeforeReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedSale.documentId)}})).record;})()`);
  const filesBeforeSaleReport = readdirSync(downloadDir);
  await click(client,'#estimateExcelButton');
  await expr(client, `document.querySelector('#toast').textContent.includes('Excel을 생성했습니다') && !document.querySelector('#toast').hidden`, 'sale report generated from saved work');
  await waitFor(() => readdirSync(downloadDir).some(name => name.toLowerCase().endsWith('.xlsx') && !filesBeforeSaleReport.includes(name)), 'sale report workbook downloaded', 10_000);
  const saleAfterReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedSale.documentId)}})).record;})()`);
  assert.deepEqual(saleAfterReport,saleBeforeReport,'sale report must not mutate the saved work or deliver it');
  const reconnected = client.once('Page.loadEventFired');
  await client.send('Page.reload',{ignoreCache:true});
  await reconnected;
  await waitFor(async()=>evaluate(client,`window.__ONEAPP_SMARTINPUT_EARLY_UI__?.ready`),'SmartInput reconnect after saved work');
  await expr(client, `document.querySelector('#completeButton').textContent==='내 자료 저장' && !document.querySelector('#officialDeliveryButton').hidden`, 'SmartInput work module ready after reconnect');
  await click(client,'.mode-tab[data-mode="sale"]');
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedSale.documentId}"]')`, 'saved sale document remains listed after app reconnect');
  await click(client,`[data-open-saved-work-document="${savedSale.documentId}"]`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]')?.value==='4'`, 'saved sale work reopens from persistent storage after reconnect');
  await expr(client, `!document.querySelector('#completeButton').disabled`, 'reopened sale transaction finished after reconnect');
  assert.deepEqual(await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedSale.documentId)}})).record;})()`),saleBeforeReport,
    'reconnect and reopen must not alter the persisted sale document');
  await click(client,'.mode-tab[data-mode="order"]');
  await expr(client, `document.querySelector('.mode-tab[data-mode="order"]').getAttribute('aria-selected')==='true' && document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]') && !document.querySelector('#completeButton').disabled`, 'order mode ready');
  await evaluate(client, `(()=>{const customer=document.querySelector('#customerInput');customer.value='독립 주문 거래처';customer.dispatchEvent(new Event('input',{bubbles:true}));const input=document.querySelector('#inputRows tr[data-default-row="true"] input[data-field="itemName"]');input.value='SmartInput 주문 자체 저장';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="itemName"]')?.value==='SmartInput 주문 자체 저장'`, 'order row materialized');
  await evaluate(client, `(()=>{const row=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row])');for(const [field,value] of [['itemCode','ORD-SELF-1'],['quantity','4'],['unitPrice','25']]){const input=row.querySelector('[data-field="'+field+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent==='내 자료 저장' && document.querySelector('#officialDeliveryButton').textContent==='ORDER Q로 전달'`),true,
    'regular order save must be separate from its explicit ORDER Q delivery action');
  await click(client,'#completeButton');
  const savedOrder = await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const list=await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'order'});return list[0]||null;})()`, 'regular order saved locally');
  assert.ok(savedOrder?.documentId && savedOrder.revision===1 && savedOrder.summary.rowCount===1,'regular order must create an isolated SmartInput work document');
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedOrder.documentId}"]')`, 'saved order list entry');
  await click(client,`[data-open-saved-work-document="${savedOrder.documentId}"]`);
  await expr(client, `document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]')?.value==='4'`, 'saved regular order reopened');
  await expr(client, `!document.querySelector('#completeButton').disabled`, 'saved regular order open finished');
  await evaluate(client, `(()=>{const input=document.querySelector('#inputRows tr[data-row-id]:not([data-default-row]) input[data-field="quantity"]');input.value='5';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await click(client,'#completeButton');
  await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const opened=await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedOrder.documentId)}});return opened.status==='READY'&&opened.record.revision===2&&String(opened.record.payload.rows[0].quantity)==='5';})()`, 'regular order same-ID resave');
  await expr(client, `!document.querySelector('#estimateExcelButton').disabled`, 'regular order save finished before report');
  await expr(client, `document.querySelector('#toast').hidden`, 'prior order save toast cleared before report');
  const filesBeforeOrderReport = readdirSync(downloadDir);
  const orderBeforeReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedOrder.documentId)}})).record;})()`);
  await click(client,'#estimateExcelButton');
  await expr(client, `document.querySelector('#toast').textContent.includes('Excel을 생성했습니다') && !document.querySelector('#toast').hidden`, 'regular order report generated');
  await waitFor(() => readdirSync(downloadDir).some(name => name.toLowerCase().endsWith('.xlsx') && !filesBeforeOrderReport.includes(name)), 'regular order report workbook downloaded', 10_000);
  const orderAfterReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedOrder.documentId)}})).record;})()`);
  assert.deepEqual(orderAfterReport,orderBeforeReport,'regular order report must not mutate the saved work or deliver it');
  const shoppingSourceRow = ['2026-09-26','독립 쇼핑 거래처','','입금','전달 메모','상점 메모','SHOP-LOCAL-1','쇼핑 원본 품목','BOX',2,100,200,'COPY-LOCAL-1','원본 주소','010-0000-0000','ORIGIN-LOCAL-1','DIST-LOCAL-1'];
  const shoppingCsv = [SHOPPING_ORDER_HEADERS, shoppingSourceRow].map(row => row.join(',')).join('\r\n');
  await evaluate(client, `(()=>{const data=new DataTransfer();data.items.add(new File(['\\ufeff'+${JSON.stringify(shoppingCsv)}],'shop-independent.csv',{type:'text/csv'}));const input=document.querySelector('#fileInput');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await expr(client, `!document.querySelector('#shoppingOrderImport').hidden && document.querySelector('#shoppingOrderSummary').textContent.includes('1행')`, 'shopping mall source loaded as SmartInput work');
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent==='내 자료 저장' && document.querySelector('#officialDeliveryButton').textContent==='ORDER Q 신규 주문 전달' && !document.querySelector('#officialDeliveryButton').disabled`),true,
    'shopping source save must remain separate while explicit delivery can perform the existing ledger check');
  await click(client,'#completeButton');
  const savedShopping = await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');const list=await store.listSmartInputWorkDocuments({companyId:'ONEAPP',voucherMode:'order'});return list.find(row=>row.title.includes('shop-independent.csv'))||null;})()`, 'shopping source saved locally');
  assert.ok(savedShopping?.documentId && savedShopping.revision===1 && savedShopping.summary.rowCount===1,'shopping source must be stored independently of ORDER Q');
  const originalShopping = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedShopping.documentId)}})).record;})()`);
  assert.equal(originalShopping.payload.shoppingOrderImport.sourceMatrix.length,2,'saved shopping document must preserve original table evidence');
  assert.deepEqual(originalShopping.payload.shoppingOrderImport.sourceMatrix[0],SHOPPING_ORDER_HEADERS,'saved shopping document must retain all 17 source headers');
  await click(client,'#voucherSavedDocumentsTab');
  await expr(client, `document.querySelector('[data-open-saved-work-document="${savedShopping.documentId}"]')`, 'saved shopping document list entry');
  await click(client,`[data-open-saved-work-document="${savedShopping.documentId}"]`);
  await expr(client, `!document.querySelector('#shoppingOrderImport').hidden && document.querySelector('#shoppingOrderSummary').textContent.includes('1행')`, 'saved shopping source reopened');
  const reopenedShopping = await evaluate(client, `(()=>{const element=document.querySelector('#shoppingOrderNotice');return element.textContent.includes('실제 원장 확인')||element.textContent.includes('전달 시 원장 확인');})()`);
  assert.equal(reopenedShopping,true,'reopened shopping source must not trust stale duplicate inspection evidence');
  await expr(client, `!document.querySelector('#estimateExcelButton').disabled`, 'saved shopping report enabled after reopen');
  await expr(client, `document.querySelector('#toast').hidden`, 'prior shopping save toast cleared before report');
  const filesBeforeShoppingReport = readdirSync(downloadDir);
  await click(client,'#estimateExcelButton');
  await expr(client, `document.querySelector('#appStatusMessage').textContent.includes('쇼핑몰 주문 원본 보고서 생성 완료')`, 'shopping original report generated from saved source');
  await waitFor(() => readdirSync(downloadDir).some(name => name.toLowerCase().endsWith('.xlsx') && !filesBeforeShoppingReport.includes(name)), 'shopping original report workbook downloaded', 10_000);
  const shoppingAfterReport = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?v=0.18.0');return (await store.loadSmartInputWorkDocument({companyId:'ONEAPP',documentId:${JSON.stringify(savedShopping.documentId)}})).record;})()`);
  assert.deepEqual(shoppingAfterReport,originalShopping,'shopping report must not mutate the original SmartInput document or deliver it');
  assert.deepEqual(exceptions,[]);
  console.log('PASS: estimate isolation; purchase, sale, regular order, and shopping source standalone save/list/reopen/revision/report contracts');

} catch(error) {
  if(client) {
    try {
      const diagnostics=await evaluate(client,`({text:document.body.innerText.slice(-16000),title:document.title,status:document.querySelector('#appStatusMessage')?.textContent,toast:document.querySelector('#toast')?.textContent})`);
      writeFileSync(join(screenshotDir,'stage3-ui-failure.json'),JSON.stringify({error:error.stack,diagnostics,exceptions,consoleErrors},null,2));
      const shot=await client.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshotDir,'stage3-ui-failure.png'),Buffer.from(shot.data,'base64'));
      console.error(JSON.stringify(diagnostics));
    }catch(captureError){console.error(captureError.message);}
  }
  throw error;
} finally {
  client?.close();browser?.kill();await new Promise(done=>server.close(done));
  try{rmSync(profile,{recursive:true,force:true});}catch(_){}
}
