#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-estimate-bulk-e2e-'));
const screenshotDir = resolve(process.env.SMARTINPUT_ESTIMATE_BULK_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-estimate-bulk-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
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
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  await expr(client, `Boolean(document.querySelector('#inputRows tr'))`, 'SmartInput shell');
  await evaluate(client, String.raw`(async()=>{
    const contract=window.SMART_INPUT_CONTRACT;
    const base=contract.createDraft({activeMode:'estimate'});
    const headers=['일자','거래처명','품목코드','품목명','수량','출고가','적요'];
    const sourceMatrix=[['견적서 현황'],headers,['2026-09-04','거래처 A','SHARED','A 상품 0','0','100',''],['2026-09-04','거래처 A','A-2','A 상품','2','500','내부 빈 셀 보존'],['2026-09-04','거래처 B','SHARED','B 반품','-2','300','반품'],['2026-09-04 14:30:00','','','','','','']];
    const letters=['A','B','C','D','E','F','G'];
    const sourceCellMatrix=sourceMatrix.map((row,rowIndex)=>row.map((displayValue,columnIndex)=>({address:letters[columnIndex]+(rowIndex+1),rowIndex,columnIndex,displayValue,rawValue:displayValue,blank:displayValue===''})));
    const workingRows=sourceMatrix.slice(2).map((cells,offset)=>({rowId:'source-'+(offset+2),sourceRowIndex:offset+2,cells:[...cells],sourceCells:sourceCellMatrix[offset+2],manual:false}));
    const headerSignature=JSON.stringify(headers);
    const signature=JSON.stringify({companyId:'ONEAPP',voucherMode:'estimate',headers});
    const targetFieldIds=['voucher.estimate.header.date','rowCustomerName','voucher.estimate.line.productCode','voucher.estimate.line.productName','voucher.estimate.line.quantity','noticePrice','voucher.estimate.line.memo'];
    const mappings=headers.map((sourceHeader,columnIndex)=>({columnIndex,sourceHeader,state:'MAPPED',targetFieldId:targetFieldIds[columnIndex],reviewed:true}));
    const session={schemaVersion:'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',sessionId:'BULK-BROWSER-SESSION',companyId:'ONEAPP',voucherMode:'estimate',fileName:'합성 견적서현황.xlsx',sheetName:'견적서현황내역',fileFingerprint:'SYNTHETIC-BULK-E2E',sourceMatrix,sourceCellMatrix,headerRowIndex:1,headers,headerSignature,signature,status:'TEMPLATE_APPLIED',templateId:'BULK-TEMPLATE',templateName:'견적서 현황',templateRevision:1,mappings,issues:[],editJournal:{},manualRows:[],deletedSourceRows:[],workingRows};
    const template={schemaVersion:'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V2',templateId:'BULK-TEMPLATE',companyId:'ONEAPP',voucherMode:'estimate',templateName:'견적서 현황',revision:1,signature,headerSignature,headers,fieldCount:headers.length,mappings,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',status:'ACTIVE'};
    const makeField=(address,value)=>({currentDisplayValue:String(value??''),sourceDisplayValue:String(value??''),parsedValue:value,edited:false,evidence:{address,rowIndex:Number(address.match(/\d+/)[0])-1,columnIndex:letters.indexOf(address[0]),displayValue:String(value??''),signature:'CELL-EVIDENCE'}});
    const currentRows=[
      contract.normalizeRow({rowId:'source-2',sourceRowNo:3,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 A',itemCode:'SHARED',itemName:'A 상품 0',quantity:0,unitPrice:100,memo:'',fieldValues:{'voucher.estimate.line.productCode':makeField('C3','SHARED'),'voucher.estimate.line.quantity':makeField('E3',0)}}),
      contract.normalizeRow({rowId:'source-3',sourceRowNo:4,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 A',itemCode:'A-2',itemName:'A 상품',quantity:2,unitPrice:500,memo:'내부 빈 셀 보존',fieldValues:{'voucher.estimate.line.productCode':makeField('C4','A-2')}}),
      contract.normalizeRow({rowId:'source-4',sourceRowNo:5,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 B',itemCode:'SHARED',itemName:'B 반품',quantity:-2,unitPrice:300,memo:'반품',fieldValues:{'voucher.estimate.line.productCode':makeField('C5','SHARED'),'voucher.estimate.line.quantity':makeField('E5',-2)}}),
      contract.normalizeRow({rowId:'source-5',sourceRowNo:6,rowVoucherDate:'2026-09-04 14:30:00'})
    ];
    const targetDraft=(customerId,customerCode,customerName,rowId,itemCode,quantity,unitPrice)=>contract.normalizeModeDraft('estimate',{...contract.createDraft().modes.estimate,header:{...contract.createDraft().modes.estimate.header,customerId,customerCode,customerName,customValues:{preserve:'yes'}},rows:[contract.normalizeRow({rowId,itemCode,itemName:'기존 상품',quantity,unitPrice,noticePrice:unitPrice})]});
    const timestamp='2026-09-01T00:00:00.000Z';
    const targetA={estimateId:'EST-BULK-A',catalogName:'A 기존 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-A',customerCode:'A001',customerName:'거래처 A',rowCount:1,amount:50,previousPrices:{},sortOrder:1,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-A','A001','거래처 A','OLD-A','OLD-A',1,50)};
    const targetB={estimateId:'EST-BULK-B',catalogName:'B 기존 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-B',customerCode:'B001',customerName:'거래처 B',rowCount:1,amount:80,previousPrices:{},sortOrder:2,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-B','B001','거래처 B','OLD-B','OLD-B',1,80)};
    const untouched={estimateId:'EST-UNTOUCHED',catalogName:'미대상 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-X',customerName:'미대상',rowCount:1,amount:90,sortOrder:3,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-X','X001','미대상','OLD-X','OLD-X',1,90)};
    const linked={estimateId:'EST-LINKED',catalogName:'연동 견적',estimateKind:'LINKED_GROUP',linkedEstimateSources:[{estimateId:'EST-BULK-A',catalogName:'A 기존 견적'},{estimateId:'EST-BULK-B',catalogName:'B 기존 견적'}],rowCount:0,amount:0,sortOrder:4,createdAt:timestamp,updatedAt:timestamp,draft:contract.normalizeModeDraft('estimate',{...contract.createDraft().modes.estimate,estimateKind:'LINKED_GROUP',linkedEstimateSources:[{estimateId:'EST-BULK-A'},{estimateId:'EST-BULK-B'}],rows:[]})};
    await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['estimates','inputTemplatesV2'],'readwrite');tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{db.close();resolve()};[targetA,targetB,untouched,linked].forEach(record=>tx.objectStore('estimates').put(record));tx.objectStore('inputTemplatesV2').put(template);};});
    base.activeMode='estimate';
    base.modes.estimate={...base.modes.estimate,activeMethod:'excel',catalogRecordId:'',inputMapping:session,rows:currentRows,sourceText:sourceMatrix.map(row=>row.join('\t')).join('\n')};
    localStorage.setItem(contract.DRAFT_STORAGE_KEY,JSON.stringify(base));
    return true;
  })()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expr(client, `document.querySelector('#productReferenceStatus').dataset.status!=='LOADING'&&document.querySelector('#customerReferenceStatus').dataset.status!=='LOADING'`, 'reference initialization', 60_000);
  await expr(client, `document.querySelector('#completeButton')&&!document.querySelector('#completeButton').disabled`, 'bulk fixture ready', 60_000);
  const fixtureState = await evaluate(client, `(() => {const draft=JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY));const mode=draft?.modes?.estimate;return {activeMode:draft?.activeMode,templateId:mode?.inputMapping?.templateId,mappingStatus:mode?.inputMapping?.status,rowCustomers:(mode?.rows||[]).map(row=>row.rowCustomerName),rowCodes:(mode?.rows||[]).map(row=>row.itemCode),appStatus:document.querySelector('#appStatus')?.textContent};})()`);
  assert.deepEqual(fixtureState, {
    activeMode: 'estimate',
    templateId: 'BULK-TEMPLATE',
    mappingStatus: 'TEMPLATE_APPLIED',
    rowCustomers: ['거래처 A', '거래처 A', '거래처 B', ''],
    rowCodes: ['SHARED', 'A-2', 'SHARED', ''],
    appStatus: fixtureState.appStatus
  });
  const before = await readEstimates(client);
  const beforeJson = JSON.stringify(before);

  const matrix = [];
  const viewports = [{ width: 1920, height: 1080, mobile: false }, { width: 1440, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }];
  let representativeScreenshot = '';
  for (const viewport of viewports) {
    await client.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1 });
    await click(client, '#completeButton');
    await wait(250);
    if (!await evaluate(client, `Boolean(document.querySelector('.estimate-bulk-update-dialog[open]'))`)) {
      const debug = await evaluate(client, `({status:document.querySelector('#appStatus')?.textContent,toast:document.querySelector('#toast')?.textContent,dialogs:[...document.querySelectorAll('dialog')].map(dialog=>({className:dialog.className,open:dialog.open,text:dialog.textContent.slice(0,160)})),rows:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"])')].map(row=>({customer:row.querySelector('[data-field="rowCustomerName"]')?.value,code:row.querySelector('[data-field="itemCode"]')?.value}))})`);
      throw new Error(`bulk dialog did not open: ${JSON.stringify(debug)}`);
    }
    await expr(client, `Boolean(document.querySelector('.estimate-bulk-update-dialog[open]'))`, `${viewport.width}px dialog open`);
    assert.equal(await evaluate(client, `document.activeElement?.matches('.estimate-bulk-update-dialog [data-bulk-target]')`), true, 'dialog must focus the first target selector');
    assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-bulk-row').length`), 2);
    assert.equal(await evaluate(client, `document.querySelector('.estimate-bulk-update-dialog [data-confirm-bulk]').disabled`), false);
    for (const theme of ['light', 'dark']) {
      await evaluate(client, `document.documentElement.dataset.nexusTheme=${JSON.stringify(theme)};true`);
      await wait(80);
      const geometry = await evaluate(client, `(() => {const dialog=document.querySelector('.estimate-bulk-update-dialog');const body=dialog.querySelector('.estimate-bulk-body');const footer=dialog.querySelector('footer');const rect=dialog.getBoundingClientRect();const footerRect=footer.getBoundingClientRect();return {theme:document.documentElement.dataset.nexusTheme,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,documentScrollWidth:document.documentElement.scrollWidth,bodyOverflow:getComputedStyle(body).overflowY,bodyScrollHeight:body.scrollHeight,bodyClientHeight:body.clientHeight,footerBottom:footerRect.bottom,text:dialog.textContent};})()`);
      assert.equal(geometry.theme, theme);
      assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight, `${viewport.width}px ${theme} dialog must fit`);
      assert.ok(geometry.documentScrollWidth <= geometry.viewportWidth, `${viewport.width}px ${theme} must not overflow document`);
      assert.equal(geometry.bodyOverflow, 'auto');
      assert.ok(geometry.footerBottom <= geometry.bottom + 1);
      assert.match(geometry.text, /선택한 기존 견적서의 품목 전체/);
      assert.match(geometry.text, /전체 2/);
      assert.match(geometry.text, /미대상 1/);
      matrix.push({ viewport: viewport.width, theme, width: geometry.width, height: geometry.height, bodyScrollHeight: geometry.bodyScrollHeight, bodyClientHeight: geometry.bodyClientHeight });
      if (viewport.width === 1440 && theme === 'light') {
        const capture = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
        representativeScreenshot = join(screenshotDir, 'smartinput-estimate-bulk-update-1440-light.png');
        writeFileSync(representativeScreenshot, Buffer.from(capture.data, 'base64'));
      }
    }
    await escape(client);
    await expr(client, `!document.querySelector('.estimate-bulk-update-dialog')`, `${viewport.width}px Escape close`);
    assert.equal(JSON.stringify(await readEstimates(client)), beforeJson, `${viewport.width}px Escape must perform zero writes`);
  }

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 });
  await click(client, '#completeButton');
  await expr(client, `Boolean(document.querySelector('.estimate-bulk-update-dialog[open]'))`, 'target change dialog');
  const selectors = await evaluate(client, `[...document.querySelectorAll('.estimate-bulk-row [data-bulk-target]')].map(select=>select.value)`);
  assert.deepEqual(selectors, ['EST-BULK-A', 'EST-BULK-B']);
  await select(client, '.estimate-bulk-row:first-child [data-bulk-target]', 'EST-BULK-B');
  assert.equal(await evaluate(client, `document.querySelector('[data-confirm-bulk]').disabled`), true, 'duplicate target must disable update');
  assert.match(await evaluate(client, `document.querySelector('[data-bulk-issues]').textContent`), /중복/);
  await select(client, '.estimate-bulk-row:first-child [data-bulk-target]', '');
  assert.equal(await evaluate(client, `document.querySelector('[data-confirm-bulk]').disabled`), true, 'explicit unresolved target must remain unresolved');
  await select(client, '.estimate-bulk-row:first-child [data-bulk-target]', 'EST-BULK-A');
  assert.equal(await evaluate(client, `document.querySelector('[data-confirm-bulk]').disabled`), false);

  await evaluate(client, `(() => {window.__bulkPutOriginal=IDBObjectStore.prototype.put;window.__bulkPutCount=0;IDBObjectStore.prototype.put=function(...args){if(this.name==='estimates'&&++window.__bulkPutCount===2)throw new DOMException('Injected second estimate write failure','AbortError');return window.__bulkPutOriginal.apply(this,args);};return true;})()`);
  await click(client, '[data-confirm-bulk]');
  await expr(client, `document.querySelector('#appStatus').textContent.includes('업데이트하지 못했습니다')`, 'injected transaction rollback');
  assert.equal(JSON.stringify(await readEstimates(client)), beforeJson, 'second put failure must roll back every target');
  assert.equal(await evaluate(client, `[...document.querySelectorAll('#mappingInputRows input')].some(input=>input.value==='A-2')`), true, 'failed write must preserve input');
  await evaluate(client, `IDBObjectStore.prototype.put=window.__bulkPutOriginal;delete window.__bulkPutOriginal;true`);

  await evaluate(client, `(async()=>{const records=${beforeJson};const stale={...records.find(record=>record.estimateId==='EST-BULK-A'),updatedAt:'2026-09-04T09:00:00.000Z'};await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');tx.objectStore('estimates').put(stale);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});return true;})()`);
  await click(client, '[data-confirm-bulk]');
  await expr(client, `document.querySelector('.estimate-bulk-update-dialog[open]')&&document.querySelector('[data-bulk-issues]').textContent.includes('변경')`, 'stale preimage rejection');
  const afterStale = await readEstimates(client);
  assert.equal(afterStale.find(record => record.estimateId === 'EST-BULK-B').draft.rows[0].itemCode, 'OLD-B', 'stale preimage must prevent every planned replacement');
  await evaluate(client, `(async()=>{const original=${beforeJson}.find(record=>record.estimateId==='EST-BULK-A');await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');tx.objectStore('estimates').put(original);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});return true;})()`);

  await click(client, '[data-confirm-bulk]');
  await expr(client, `!document.querySelector('.estimate-bulk-update-dialog')&&document.querySelector('#appStatus').textContent.includes('2개 견적서 · 3품목 업데이트 완료')`, 'successful bulk retry');
  const after = await readEstimates(client);
  const targetA = after.find(record => record.estimateId === 'EST-BULK-A');
  const targetB = after.find(record => record.estimateId === 'EST-BULK-B');
  assert.deepEqual(targetA.draft.rows.map(row => [row.itemCode, row.quantity]), [['SHARED', 0], ['A-2', 2]]);
  assert.deepEqual(targetB.draft.rows.map(row => [row.itemCode, row.quantity]), [['SHARED', -2]]);
  assert.equal(targetA.catalogName, 'A 기존 견적');
  assert.equal(targetA.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(targetA.sortOrder, 1);
  assert.equal(targetA.draft.header.customerId, 'CUS-A');
  assert.equal(targetA.draft.inputMapping.sourceMatrix.length, 3);
  assert.equal(targetB.draft.inputMapping.sourceMatrix.length, 2);
  assert.equal(targetA.draft.inputMapping.sourceCellMatrix[1][2].address, 'C3');
  assert.equal(targetB.draft.inputMapping.sourceCellMatrix[1][2].address, 'C5');
  assert.equal(targetA.draft.inputMapping.signature, JSON.stringify({ companyId: 'ONEAPP', voucherMode: 'estimate', headers: ['일자', '거래처명', '품목코드', '품목명', '수량', '출고가', '적요'] }));
  assert.equal(JSON.stringify(targetA.draft.inputMapping.sourceMatrix).includes('거래처 B'), false);
  assert.equal(JSON.stringify(targetB.draft.inputMapping.sourceMatrix).includes('거래처 A'), false);
  assert.deepEqual(targetA.previousPrices, { 'CODE:OLD-A': 50 });
  assert.equal(targetA.draft.catalogBaselinePrices['CODE:SHARED'], 100);
  assert.deepEqual(after.find(record => record.estimateId === 'EST-UNTOUCHED'), before.find(record => record.estimateId === 'EST-UNTOUCHED'));
  assert.deepEqual(after.find(record => record.estimateId === 'EST-LINKED'), before.find(record => record.estimateId === 'EST-LINKED'));
  assert.equal(await evaluate(client, `[...document.querySelectorAll('#mappingInputRows input')].some(input=>input.value==='A-2')&&[...document.querySelectorAll('#mappingInputRows input')].some(input=>input.value==='SHARED')`), true, 'successful bulk update must retain the full upload view');

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ matrix, representativeScreenshot, rollback: ['indexeddb-second-put', 'stale-preimage'], updated: { estimates: 2, items: 3 } }, null, 2));
  console.log('SmartInput estimate bulk update focused browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  await wait(150);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
