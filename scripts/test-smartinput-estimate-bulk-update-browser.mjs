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
  client.on('Runtime.exceptionThrown', event => exceptions.push(`${event.exceptionDetails?.url || ''}:${Number(event.exceptionDetails?.lineNumber || 0) + 1}:${Number(event.exceptionDetails?.columnNumber || 0) + 1} ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'}`));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  await expr(client, `Boolean(document.querySelector('#inputRows'))`, 'SmartInput shell');
  if (exceptions.length) throw new Error(`SmartInput initial load exceptions: ${exceptions.join('\n')}`);
  await evaluate(client, String.raw`(async()=>{
    const contract=window.SMART_INPUT_CONTRACT;
    const base=contract.createDraft({activeMode:'estimate'});
    const headers=['일자','거래처명','품목코드','품목명','수량','출고가','적요'];
    const sourceMatrix=[['견적서 현황'],headers,['2026-09-04','거래처 A','SHARED','A 상품 0','0','100',''],['2026-09-04','거래처 A','A-2','A 상품','2','500','내부 빈 셀 보존'],['2026-09-04','거래처 B','B-CHECK','B 확인 품목','-2','300','확인 필요'],['2026-09-04','거래처 C','SHARED','C 정상 품목','1','700','정상'],['2026-09-04 14:30:00','','','','','','']];
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
      contract.normalizeRow({rowId:'source-2',sourceRowNo:3,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 A',masterProductId:'PRODUCT-SHARED',productId:'PRODUCT-SHARED',itemCode:'SHARED',itemName:'A 상품 0',quantity:0,unitPrice:100,memo:'',matchStatus:'MATCHED',reviewStatus:'CONFIRMED',productIdentityStatus:'MASTER_LINKED',fieldValues:{'voucher.estimate.line.productCode':makeField('C3','SHARED'),'voucher.estimate.line.quantity':makeField('E3',0)}}),
      contract.normalizeRow({rowId:'source-3',sourceRowNo:4,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 A',masterProductId:'PRODUCT-A2',productId:'PRODUCT-A2',itemCode:'A-2',itemName:'A 상품',quantity:2,unitPrice:500,memo:'내부 빈 셀 보존',matchStatus:'MATCHED',reviewStatus:'CONFIRMED',productIdentityStatus:'MASTER_LINKED',fieldValues:{'voucher.estimate.line.productCode':makeField('C4','A-2')}}),
      contract.normalizeRow({rowId:'source-4',sourceRowNo:5,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 B',itemCode:'B-CHECK',itemName:'B 확인 품목',quantity:-2,unitPrice:300,memo:'확인 필요',matchStatus:'SIMILAR',reviewStatus:'PENDING',productIdentityStatus:'UNRESOLVED',fieldValues:{'voucher.estimate.line.productCode':makeField('C5','B-CHECK'),'voucher.estimate.line.quantity':makeField('E5',-2)}}),
      contract.normalizeRow({rowId:'source-5',sourceRowNo:6,rowVoucherDate:'2026-09-04',rowCustomerName:'거래처 C',masterProductId:'PRODUCT-SHARED',productId:'PRODUCT-SHARED',itemCode:'SHARED',itemName:'C 정상 품목',quantity:1,unitPrice:700,memo:'정상',matchStatus:'MATCHED',reviewStatus:'CONFIRMED',productIdentityStatus:'MASTER_LINKED',fieldValues:{'voucher.estimate.line.productCode':makeField('C6','SHARED')}}),
      contract.normalizeRow({rowId:'source-6',sourceRowNo:7,rowVoucherDate:'2026-09-04 14:30:00'})
    ];
    const targetDraft=(customerId,customerCode,customerName,rowId,itemCode,quantity,unitPrice)=>contract.normalizeModeDraft('estimate',{...contract.createDraft().modes.estimate,header:{...contract.createDraft().modes.estimate.header,customerId,customerCode,customerName,customValues:{preserve:'yes'}},rows:[contract.normalizeRow({rowId,itemCode,itemName:'기존 상품',quantity,unitPrice,noticePrice:unitPrice})]});
    const timestamp='2026-09-01T00:00:00.000Z';
    const targetA={estimateId:'EST-BULK-A',catalogName:'A 기존 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-A',customerCode:'A001',customerName:'거래처 A',rowCount:1,amount:50,previousPrices:{},sortOrder:1,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-A','A001','거래처 A','OLD-A','OLD-A',1,50)};
    const targetB={estimateId:'EST-BULK-B',catalogName:'B 기존 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-B',customerCode:'B001',customerName:'거래처 B',rowCount:1,amount:80,previousPrices:{},sortOrder:2,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-B','B001','거래처 B','OLD-B','OLD-B',1,80)};
    const targetC={estimateId:'EST-BULK-C',catalogName:'C 기존 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-C',customerCode:'C001',customerName:'거래처 C',rowCount:1,amount:70,previousPrices:{},sortOrder:3,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-C','C001','거래처 C','OLD-C','OLD-C',1,70)};
    const untouched={estimateId:'EST-UNTOUCHED',catalogName:'미대상 견적',estimateKind:'INDIVIDUAL',customerId:'CUS-X',customerName:'미대상',rowCount:1,amount:90,sortOrder:4,createdAt:timestamp,updatedAt:timestamp,draft:targetDraft('CUS-X','X001','미대상','OLD-X','OLD-X',1,90)};
    const linked={estimateId:'EST-LINKED',catalogName:'연동 견적',estimateKind:'LINKED_GROUP',linkedEstimateSources:[{estimateId:'EST-BULK-A',catalogName:'A 기존 견적'},{estimateId:'EST-BULK-B',catalogName:'B 기존 견적'},{estimateId:'EST-BULK-C',catalogName:'C 기존 견적'}],rowCount:0,amount:0,sortOrder:5,createdAt:timestamp,updatedAt:timestamp,draft:contract.normalizeModeDraft('estimate',{...contract.createDraft().modes.estimate,estimateKind:'LINKED_GROUP',linkedEstimateSources:[{estimateId:'EST-BULK-A'},{estimateId:'EST-BULK-B'},{estimateId:'EST-BULK-C'}],rows:[]})};
    localStorage.setItem('merchMaster_v870',JSON.stringify([
      {productId:'PRODUCT-SHARED',masterProductId:'PRODUCT-SHARED',itemCode:'SHARED',itemName:'공용 상품',outPrice:100,status:'ACTIVE',active:true},
      {productId:'PRODUCT-A2',masterProductId:'PRODUCT-A2',itemCode:'A-2',itemName:'A 상품',outPrice:500,status:'ACTIVE',active:true}
    ]));
    localStorage.setItem('merchMaster_revision_v870','BULK-E2E-1');
    const productRows=[
      {productId:'PRODUCT-SHARED',masterProductId:'PRODUCT-SHARED',itemCode:'SHARED',itemName:'공용 상품',outPrice:100,priceOptions:[{key:'outPrice',label:'출고가',value:100}],status:'ACTIVE',active:true,source:'PRODUCT_MASTER_SNAPSHOT',revision:1},
      {productId:'PRODUCT-A2',masterProductId:'PRODUCT-A2',itemCode:'A-2',itemName:'A 상품',outPrice:500,priceOptions:[{key:'outPrice',label:'출고가',value:500}],status:'ACTIVE',active:true,source:'PRODUCT_MASTER_SNAPSHOT',revision:1}
    ];
    const productSnapshot={cacheSchemaVersion:'ONEAPP_SMARTINPUT_REFERENCE_CACHE_V1',domain:'product',ownerAppId:'master-lookup',schemaVersion:'ONEAPP_PRODUCT_SNAPSHOT_V1',adapterVersion:'BULK-E2E',status:'READY',source:'BULK_E2E_FIXTURE',fallback:false,count:productRows.length,revision:'BULK-E2E-1',snapshotId:'PRODUCT-BULK-E2E-1',contentHash:'BULK-E2E-HASH',snapshotCreatedAt:timestamp,checkedAt:timestamp,rows:productRows};
    await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['estimates','inputTemplatesV2','settings'],'readwrite');tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{db.close();resolve()};[targetA,targetB,targetC,untouched,linked].forEach(record=>tx.objectStore('estimates').put(record));tx.objectStore('inputTemplatesV2').put(template);tx.objectStore('settings').put({key:'reference:product',value:{cacheSchemaVersion:'ONEAPP_SMARTINPUT_REFERENCE_CACHE_V1',applied:productSnapshot,pending:null,updatedAt:timestamp},updatedAt:timestamp});};});
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
    rowCustomers: ['거래처 A', '거래처 A', '거래처 B', '거래처 C', ''],
    rowCodes: ['SHARED', 'A-2', 'B-CHECK', 'SHARED', ''],
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
    assert.equal(await evaluate(client, `document.activeElement?.matches('.estimate-bulk-update-dialog [data-bulk-action]')`), true, 'dialog must focus the first problem or target selector');
    assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-bulk-row').length`), 3);
    const initialDialogState = await evaluate(client, `({disabled:document.querySelector('.estimate-bulk-update-dialog [data-confirm-bulk]').disabled,states:[...document.querySelectorAll('.estimate-bulk-row')].map(row=>({name:row.querySelector('.estimate-bulk-row__source strong').textContent,status:row.dataset.bulkStateValue,reason:row.querySelector('[data-bulk-reason]').textContent,selected:row.querySelector('[data-bulk-select]').checked})),rows:JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.estimate.rows.map(row=>({customer:row.rowCustomerName,code:row.itemCode,master:row.masterProductId,product:row.productId,match:row.matchStatus,review:row.reviewStatus,identity:row.productIdentityStatus})),summary:document.querySelector('[data-bulk-summary]').textContent})`);
    assert.equal(initialDialogState.disabled, false, JSON.stringify(initialDialogState));
    for (const theme of ['light', 'dark']) {
      await evaluate(client, `document.documentElement.dataset.nexusTheme=${JSON.stringify(theme)};true`);
      await wait(80);
      const geometry = await evaluate(client, `(() => {const dialog=document.querySelector('.estimate-bulk-update-dialog');const body=dialog.querySelector('.estimate-bulk-body');const footer=dialog.querySelector('footer');const rect=dialog.getBoundingClientRect();const footerRect=footer.getBoundingClientRect();return {theme:document.documentElement.dataset.nexusTheme,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,documentScrollWidth:document.documentElement.scrollWidth,bodyOverflow:getComputedStyle(body).overflowY,bodyScrollHeight:body.scrollHeight,bodyClientHeight:body.clientHeight,footerBottom:footerRect.bottom,text:dialog.textContent};})()`);
      assert.equal(geometry.theme, theme);
      assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight, `${viewport.width}px ${theme} dialog must fit`);
      assert.ok(geometry.documentScrollWidth <= geometry.viewportWidth, `${viewport.width}px ${theme} must not overflow document`);
      assert.equal(geometry.bodyOverflow, 'auto');
      assert.ok(geometry.footerBottom <= geometry.bottom + 1);
      assert.match(geometry.text, /정상 전표만 거래처별로 독립 저장/);
      assert.match(geometry.text, /전체 3/);
      assert.match(geometry.text, /확인 필요 1/);
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
  const selectors = await evaluate(client, `[...document.querySelectorAll('.estimate-bulk-row [data-bulk-action]')].map(select=>select.value)`);
  assert.deepEqual(selectors, ['UPDATE:EST-BULK-A', 'UPDATE:EST-BULK-B', 'UPDATE:EST-BULK-C']);
  await select(client, '.estimate-bulk-row:first-child [data-bulk-action]', 'UPDATE:EST-BULK-B');
  assert.equal(await evaluate(client, `document.querySelector('[data-confirm-bulk]').disabled`), false, 'duplicate groups must be held while another ready group remains executable');
  assert.match(await evaluate(client, `document.querySelector('[data-bulk-issues]').textContent`), /중복/);
  assert.equal(await evaluate(client, `document.querySelectorAll('.estimate-bulk-row[data-bulk-state-value="PENDING"]').length`), 2);
  await select(client, '.estimate-bulk-row:first-child [data-bulk-action]', '');
  assert.equal(await evaluate(client, `document.querySelector('[data-confirm-bulk]').disabled`), false, 'one unresolved group must not block another ready group');
  await select(client, '.estimate-bulk-row:first-child [data-bulk-action]', 'CREATE');
  assert.equal(await evaluate(client, `document.querySelector('.estimate-bulk-row:first-child').dataset.bulkStateValue`), 'PENDING', 'explicit create requires a confirmed name');
  await evaluate(client, `(() => {const input=document.querySelector('.estimate-bulk-row:first-child [data-bulk-create-name]');input.value='A 명시 신규';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `document.querySelector('.estimate-bulk-row:first-child').dataset.bulkStateValue`), 'READY', 'named explicit create must revalidate only that group');
  await select(client, '.estimate-bulk-row:first-child [data-bulk-action]', 'EXCLUDE');
  assert.equal(await evaluate(client, `document.querySelector('.estimate-bulk-row:first-child').dataset.bulkStateValue`), 'EXCLUDED');
  await select(client, '.estimate-bulk-row:first-child [data-bulk-action]', 'UPDATE:EST-BULK-A');
  assert.equal(await evaluate(client, `document.querySelector('[data-confirm-bulk]').disabled`), false);

  await evaluate(client, `(async()=>{const records=${beforeJson};const stale={...records.find(record=>record.estimateId==='EST-BULK-A'),updatedAt:'2026-09-04T09:00:00.000Z'};await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');tx.objectStore('estimates').put(stale);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});return true;})()`);
  await click(client, '[data-confirm-bulk]');
  await expr(client, `document.querySelector('.estimate-bulk-update-dialog[open]')&&document.querySelector('#appStatus').textContent.includes('저장 완료 1개')&&document.querySelector('#appStatus').textContent.includes('확인 필요 2개')`, 'per-customer stale continuation');
  const afterStale = await readEstimates(client);
  assert.equal(afterStale.find(record => record.estimateId === 'EST-BULK-A').draft.rows[0].itemCode, 'OLD-A', 'stale group must remain unchanged');
  assert.equal(afterStale.find(record => record.estimateId === 'EST-BULK-B').draft.rows[0].itemCode, 'OLD-B', 'problem group must perform zero writes');
  assert.equal(afterStale.find(record => record.estimateId === 'EST-BULK-C').draft.rows[0].itemCode, 'SHARED', 'another normal group must continue after stale failure');
  const firstCUpdatedAt = afterStale.find(record => record.estimateId === 'EST-BULK-C').updatedAt;
  assert.equal(await evaluate(client, `document.querySelector('[data-bulk-group="NAME:거래처 a"]').dataset.bulkStateValue`), 'FAILED');
  assert.equal(await evaluate(client, `document.querySelector('[data-bulk-group="NAME:거래처 b"]').dataset.bulkStateValue`), 'PENDING');
  assert.equal(await evaluate(client, `document.querySelector('[data-bulk-group="NAME:거래처 c"]').dataset.bulkStateValue`), 'COMPLETED');
  assert.equal(await evaluate(client, `document.querySelector('[data-bulk-group="NAME:거래처 c"]').hidden`), true, 'problem-focused view must fold completed vouchers');
  await click(client, '[data-bulk-view="all"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-bulk-group="NAME:거래처 c"]').hidden`), false, 'full view must reveal completed vouchers without changing source rows');
  await click(client, '[data-bulk-view="review"]');
  await evaluate(client, `(async()=>{const original=${beforeJson}.find(record=>record.estimateId==='EST-BULK-A');await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');tx.objectStore('estimates').put(original);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});return true;})()`);

  await click(client, '[data-confirm-bulk]');
  await expr(client, `document.querySelector('#appStatus').textContent.includes('저장 완료 2개')&&document.querySelector('#appStatus').textContent.includes('확인 필요 1개')`, 'retry only failed group');
  const afterARetry = await readEstimates(client);
  assert.equal(afterARetry.find(record => record.estimateId === 'EST-BULK-C').updatedAt, firstCUpdatedAt, 'completed C must not be saved again while retrying A');

  await click(client, '.estimate-bulk-update-dialog [data-close]');
  await expr(client, `!document.querySelector('.estimate-bulk-update-dialog')`, 'close before correcting problem row');
  await evaluate(client, String.raw`(async()=>{
    const key=window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY;
    const draft=JSON.parse(localStorage.getItem(key));
    const row=draft.modes.estimate.rows.find(candidate=>candidate.rowCustomerName==='거래처 B');
    row.masterProductId='PRODUCT-B1';row.productId='PRODUCT-B1';row.matchStatus='MATCHED';row.reviewStatus='CONFIRMED';row.productIdentityStatus='MASTER_LINKED';
    draft.updatedAt=new Date().toISOString();draft.modes.estimate.updatedAt=draft.updatedAt;
    localStorage.setItem(key,JSON.stringify(draft));
    await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('autosave','readwrite');tx.objectStore('autosave').put({key:'current',schemaVersion:'ONEAPP_SMART_INPUT_AUTOSAVE_V1',updatedAt:draft.updatedAt,draft});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});
    return true;
  })()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expr(client, `document.querySelector('#completeButton')&&!document.querySelector('#completeButton').disabled`, 'corrected fixture ready', 60_000);
  await click(client, '#completeButton');
  await expr(client, `Boolean(document.querySelector('.estimate-bulk-update-dialog[open]'))`, 'corrected group dialog');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('.estimate-bulk-row')].map(row=>[row.querySelector('.estimate-bulk-row__source strong').textContent,row.dataset.bulkStateValue])`), [['거래처 A','COMPLETED'],['거래처 B','READY'],['거래처 C','COMPLETED']], 'only corrected B must become ready after reload');

  await evaluate(client, `(() => {window.__bulkPutOriginal=IDBObjectStore.prototype.put;window.__bulkFailed=false;IDBObjectStore.prototype.put=function(...args){if(this.name==='estimates'&&!window.__bulkFailed){window.__bulkFailed=true;throw new DOMException('Injected per-customer write failure','AbortError');}return window.__bulkPutOriginal.apply(this,args);};return true;})()`);
  await click(client, '[data-confirm-bulk]');
  await expr(client, `document.querySelector('[data-bulk-group="NAME:거래처 b"]').dataset.bulkStateValue==='FAILED'`, 'per-customer put failure');
  const afterBFailure = await readEstimates(client);
  assert.equal(afterBFailure.find(record => record.estimateId === 'EST-BULK-B').draft.rows[0].itemCode, 'OLD-B', 'failed B transaction must be zero-write');
  assert.equal(afterBFailure.find(record => record.estimateId === 'EST-BULK-C').updatedAt, firstCUpdatedAt, 'B failure must not rewrite completed C');
  await evaluate(client, `IDBObjectStore.prototype.put=window.__bulkPutOriginal;delete window.__bulkPutOriginal;true`);
  await click(client, '[data-confirm-bulk]');
  await expr(client, `document.querySelector('#appStatus').textContent.includes('저장 완료 3개')&&document.querySelector('#appStatus').textContent.includes('확인 필요 0개')`, 'successful B-only retry');

  const after = await readEstimates(client);
  const targetA = after.find(record => record.estimateId === 'EST-BULK-A');
  const targetB = after.find(record => record.estimateId === 'EST-BULK-B');
  const targetC = after.find(record => record.estimateId === 'EST-BULK-C');
  assert.deepEqual(targetA.draft.rows.map(row => [row.itemCode, row.quantity]), [['SHARED', 0], ['A-2', 2]]);
  assert.deepEqual(targetB.draft.rows.map(row => [row.itemCode, row.quantity]), [['B-CHECK', -2]]);
  assert.deepEqual(targetC.draft.rows.map(row => [row.itemCode, row.quantity]), [['SHARED', 1]]);
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
  assert.equal(JSON.stringify(targetC.draft.inputMapping.sourceMatrix).includes('거래처 A'), false);
  assert.deepEqual(targetA.previousPrices, { 'CODE:OLD-A': 50 });
  assert.equal(targetA.draft.catalogBaselinePrices['MASTER:PRODUCT-SHARED'], 100);
  assert.deepEqual(after.find(record => record.estimateId === 'EST-UNTOUCHED'), before.find(record => record.estimateId === 'EST-UNTOUCHED'));
  assert.deepEqual(after.find(record => record.estimateId === 'EST-LINKED'), before.find(record => record.estimateId === 'EST-LINKED'));
  assert.equal(await evaluate(client, `[...document.querySelectorAll('#mappingInputRows input')].some(input=>input.value==='A-2')&&[...document.querySelectorAll('#mappingInputRows input')].some(input=>input.value==='B-CHECK')&&[...document.querySelectorAll('#mappingInputRows input')].some(input=>input.value==='SHARED')`), true, 'successful per-customer updates must retain the full upload view');
  const progressStatuses = await evaluate(client, `Object.values(JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.estimate.estimateBulkProgress.groups).map(entry=>entry.status).sort()`);
  assert.deepEqual(progressStatuses, ['COMPLETED','COMPLETED','COMPLETED'], 'completed progress must persist without a new store or schema');

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ matrix, representativeScreenshot, rollback: ['per-customer-stale', 'per-customer-put-failure'], updated: { estimates: 3, items: 4 }, productionWrites: 0 }, null, 2));
  console.log('SmartInput per-customer estimate update focused browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  await wait(150);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
