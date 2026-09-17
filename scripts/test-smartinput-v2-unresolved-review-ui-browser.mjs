#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_SHA = 'b126b298a18671942a70d8ae2ae53d1b25234fcb';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-orderops-unresolved-e2e-'));
const evidenceDir = resolve(process.env.ORDEROPS_UNRESOLVED_EVIDENCE_DIR || join(tmpdir(), 'oneapp-orderops-unresolved-evidence'));
const screenshotDir = join(evidenceDir, 'screenshots');
mkdirSync(screenshotDir, { recursive: true });

const baselineHtml = execFileSync('git', ['show', `${BASE_SHA}:orderops/list.html`], { cwd: root, encoding: 'utf8' });
const currentHtml = readFileSync(join(root, 'orderops', 'list.html'), 'utf8');
const localizeXlsx = source => source.replace(
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  '/customer-master/vendor/xlsx.full.min.js'
);
const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};
const localServerRequests = [];
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  localServerRequests.push({ method: request.method, pathname });
  if (pathname === '/orderops/list-baseline.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end(localizeXlsx(baselineHtml));
  }
  if (pathname === '/orderops/list.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end(localizeXlsx(currentHtml));
  }
  const relative = pathname === '/' ? 'orderops/list.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  response.end(readFileSync(target));
});

const reviewItems = [
  {
    unresolvedProductId: 'UP-CODE', companyId: 'COMPANY-A', originalProductCode: '0007', originalProductName: '',
    specification: '10kg', unit: 'BOX',
    officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: 0 },
    aggregate: { documentCount: 1, lineCount: 1, inputQuantityTotal: 0, signedQuantityTotal: 0, warehouseIds: ['1창고'], businessDates: ['2026-09-03'] },
    links: [{ pendingEffectId: 'PE-0', originalProductCode: '0007', originalProductName: '', specification: '10kg', unit: 'BOX', warehouseId: '1창고', businessDate: '2026-09-03', inputQuantity: 0, signedQuantity: 0, officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: 0 }, sourceVoucher: { voucherMode: 'purchase', documentId: 'PURCHASE-0', lineId: 'PURCHASE-LINE-0', documentRevision: 1, revisionId: 'REV-0' }, integrity: { status: 'READY', issues: [] } }],
    candidates: [{ productId: 'PRODUCT-EXACT', companyId: 'COMPANY-A', productCode: '0007', productName: '정확 후보', specification: '10kg', unit: 'BOX', matchBasis: 'EXACT_COMPANY_PRODUCT_CODE', exactCandidate: true, selectable: true, automaticConfirmation: false }, { productId: 'PRODUCT-NAME', companyId: 'COMPANY-A', productCode: 'NAME-7', productName: '품명 참고', specification: '10kg', unit: 'BOX', matchBasis: 'EXACT_PRODUCT_NAME_REFERENCE_ONLY', exactCandidate: false, selectable: true, automaticConfirmation: false }],
    integrity: { status: 'READY', issues: [] }
  },
  {
    unresolvedProductId: 'UP-NAME', companyId: 'COMPANY-A', originalProductCode: '', originalProductName: '품명만 상품',
    specification: 'EA', unit: 'EA',
    officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: -3 },
    aggregate: { documentCount: 1, lineCount: 1, inputQuantityTotal: 3, signedQuantityTotal: -3, warehouseIds: ['2전송'], businessDates: ['2026-09-02'] },
    links: [{ pendingEffectId: 'PE-NAME', originalProductCode: '', originalProductName: '품명만 상품', specification: 'EA', unit: 'EA', warehouseId: '2전송', businessDate: '2026-09-02', inputQuantity: 3, signedQuantity: -3, officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: -3 }, sourceVoucher: { voucherMode: 'sale', documentId: 'SALE-NAME', lineId: 'SALE-LINE-NAME', documentRevision: 2, revisionId: 'REV-NAME' }, integrity: { status: 'READY', issues: [] } }],
    candidates: [{ productId: 'PRODUCT-NAME', companyId: 'COMPANY-A', productCode: 'NAME-7', productName: '품명만 상품', specification: 'EA', unit: 'EA', matchBasis: 'EXACT_PRODUCT_NAME_REFERENCE_ONLY', exactCandidate: false, selectable: true, automaticConfirmation: false }],
    integrity: { status: 'READY', issues: [] }
  },
  {
    unresolvedProductId: 'UP-BOTH', companyId: 'COMPANY-A', originalProductCode: 'BOTH', originalProductName: '코드와 품명',
    specification: '5kg', unit: 'BOX', foreignPayload: 'COMPANY-B-SECRET',
    officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: 3 },
    aggregate: { documentCount: 2, lineCount: 2, inputQuantityTotal: 7, signedQuantityTotal: 3, warehouseIds: ['1창고', '3서울'], businessDates: ['2026-09-01', '2026-09-03'] },
    links: [
      { pendingEffectId: 'PE-BOTH-1', originalProductCode: 'BOTH', originalProductName: '코드와 품명', specification: '5kg', unit: 'BOX', warehouseId: '1창고', businessDate: '2026-09-03', inputQuantity: 5, signedQuantity: 5, officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: 5 }, sourceVoucher: { voucherMode: 'purchase', documentId: 'PURCHASE-BOTH', lineId: 'PURCHASE-LINE-BOTH', documentRevision: 3, revisionId: 'REV-BOTH-1', detailHref: '../orderq/voucher-query.html?mode=purchase&date=2026-09-03&focus=PURCHASE-BOTH' }, integrity: { status: 'READY', issues: [] } },
      { pendingEffectId: 'PE-BOTH-2', originalProductCode: 'BOTH', originalProductName: '코드와 품명', specification: '5kg', unit: 'BOX', warehouseId: '3서울', businessDate: '2026-09-01', inputQuantity: 2, signedQuantity: -2, officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: -2 }, sourceVoucher: { voucherMode: 'sale', documentId: 'SALE-BOTH', lineId: 'SALE-LINE-BOTH', documentRevision: 4, revisionId: 'REV-BOTH-2', detailHref: '../orderq/voucher-query.html?mode=sale&date=2026-09-01&focus=SALE-BOTH' }, integrity: { status: 'REVIEW_REQUIRED', issues: [{ code: 'SOURCE_LINE_MISSING', detail: 'COMPANY-B-SECRET' }] } }
    ],
    candidates: [{ productId: 'PRODUCT-EXACT', companyId: 'COMPANY-A', productCode: 'BOTH', productName: '코드와 품명', specification: '5kg', unit: 'BOX', matchBasis: 'EXACT_COMPANY_PRODUCT_CODE', exactCandidate: true, selectable: true, automaticConfirmation: false }, { productId: 'PRODUCT-NAME', companyId: 'COMPANY-A', productCode: 'ALT-BOTH', productName: '코드와 품명', specification: '5kg', unit: 'BOX', matchBasis: 'EXACT_PRODUCT_NAME_REFERENCE_ONLY', exactCandidate: false, selectable: true, automaticConfirmation: false }],
    integrity: { status: 'REVIEW_REQUIRED', issues: [{ code: 'SOURCE_LINE_MISSING', detail: 'COMPANY-B-SECRET' }] }
  }
];

const pagedReviewItems = Array.from({ length: 201 }, (_, index) => {
  const position = index + 1;
  if (position === 201) {
    return {
      ...reviewItems[2],
      unresolvedProductId: 'UP-PAGE-201',
      originalProductCode: 'PAGE-0201',
      originalProductName: '201번째 미매칭 자료'
    };
  }
  return {
    unresolvedProductId: `UP-PAGE-${String(position).padStart(3, '0')}`,
    companyId: 'COMPANY-A',
    originalProductCode: `PAGE-${String(position).padStart(4, '0')}`,
    originalProductName: `${position}번째 미매칭 자료`,
    specification: 'EA', unit: 'EA',
    officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: 1 },
    aggregate: { documentCount: 1, lineCount: 1, inputQuantityTotal: 1, signedQuantityTotal: 1, warehouseIds: ['1창고'], businessDates: ['2026-09-03'] },
    links: [], candidates: [], integrity: { status: 'READY', issues: [] }
  };
});

const impactFixture = {
  status: 'REVIEW_REQUIRED', readOnly: true, automaticConfirmation: false, userConfirmationRequired: true,
  summary: { affectedDocumentCount: 3, affectedLineCount: 3, affectedEffectCount: 3, inputQuantityTotal: 8, signedQuantityTotal: 2, decisionRequiredCount: 1, reviewRequiredCount: 1, applyReadyCount: 1 },
  impacts: [
    { status: 'APPLY_READY', sourceVoucher: { voucherMode: 'purchase', documentId: 'PURCHASE-BOTH', lineId: 'PURCHASE-LINE-BOTH' }, warehouseId: '1창고', businessDate: '2026-09-03', inputQuantity: 5, signedQuantity: 5, checkpoint: null },
    { status: 'DECISION_REQUIRED', sourceVoucher: { voucherMode: 'sale', documentId: 'SALE-BOTH', lineId: 'SALE-LINE-BOTH' }, warehouseId: '3서울', businessDate: '2026-09-01', inputQuantity: 2, signedQuantity: -2, checkpoint: { effectiveAt: '2026-09-02', checkpointId: 'CHECKPOINT-A' } },
    { status: 'REVIEW_REQUIRED', sourceVoucher: { voucherMode: 'sale', documentId: 'SALE-BROKEN', lineId: 'SALE-LINE-BROKEN' }, warehouseId: '3서울', businessDate: '2026-09-01', inputQuantity: 1, signedQuantity: -1, checkpoint: null }
  ]
};

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 25_000) => {
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
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  once(method, timeout = 25_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return element.value;})()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return name;
};
const navigate = async (client, url) => {
  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url });
  await loaded;
};
const prepareWorkspace = async (client, { automatic = false } = {}) => {
  await expr(client, `Boolean(window.XLSX?.utils?.aoa_to_sheet)`, 'local XLSX runtime');
  const files = [
      { kind:'orders', name:'주문현황_브라우저.xlsx', sheet:'미판매현황', matrix:[
        ['회사명 : 테스트 / 주문현황'],
        ['일자-No.', '담당', '단위', '품목코드', '품목명', '규격', '수량', '재고', '단가', '적요', '적요1', '거래처', '그룹'],
        ['2026-09-03-1', '담당A', 'EA', 'NORMAL-1', '정상상품', 'EA', 2, '', 1000, '', '', '거래처A', '기본그룹']
      ] },
      { kind:'inventory', name:'창고별재고_브라우저.xlsx', sheet:'재고현황', matrix:[
        ['회사명 : 테스트 / 창고별재고'],
        ['사용', '품목코드', '단위', '품목명', '규격', '수량', '1창고', '2전송', '3서울', '4전송', '7진영', '기본', '전송', '창고'],
        ['Yes', 'NORMAL-1', 'EA', '정상상품', 'EA', 8, 8, '', '', '', '', '', '', '']
      ] }
    ];
  for (const source of files) {
    await evaluate(client, `(() => {
      const source=${JSON.stringify(source)};
      const workbook=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(source.matrix),source.sheet);
      const bytes=XLSX.write(workbook,{type:'array',bookType:'xlsx'});
      const transfer=new DataTransfer();
      transfer.items.add(new File([bytes],source.name,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const target=document.querySelector('#'+source.kind+'Input');
      Object.defineProperty(target,'files',{configurable:true,value:transfer.files});
      target.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    await expr(client, `document.querySelector('#${source.kind}FileName').textContent.includes(${JSON.stringify(source.name)})${automatic ? "&&document.querySelector('#prepDropZone').getAttribute('aria-busy')==='false'&&!document.querySelector('#prepFileButton').disabled" : ''}`, source.kind+' accepted and settled');
    if (automatic) {
      const preview = source.kind === 'orders' ? 'allocations' : source.kind;
      assert.equal(await evaluate(client, `document.querySelector('#prepPreviewTabs [data-preview="${preview}"]')?.getAttribute('aria-selected')`), 'true', source.kind+' upload must display its own source kind without analysis or tab selection');
    }
  }
  if (!automatic) {
    await expr(client, `!document.querySelector('#analyzeButton').disabled`, 'baseline analysis readiness');
    await click(client, '#analyzeButton');
  }
  await expr(client, `!document.querySelector('#analyzeButton').disabled&&!document.querySelector('#downloadButton').disabled&&!document.querySelector('#resultsPanel').classList.contains('hidden')&&document.querySelectorAll('#previewTable tbody tr').length>0`, 'normal OrderOps result', 30_000);
  await evaluate(client, `(async()=>{window.scrollTo({top:0,left:0,behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true;})()`);
  return { fileSelections: files.length, analysisActions: automatic ? 0 : 1 };
};
const normalMetrics = client => evaluate(client, `(() => {
  const rect = selector => {const node=document.querySelector(selector);if(!node)return null;const r=node.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom)};};
  const prep=document.querySelector('.excel-preparation-panel');
  return {
    viewportWidth:document.documentElement.clientWidth,
    existingButtonIds:[...document.querySelectorAll('button[id]')].map(node=>node.id).filter(id=>id!=='unresolvedReviewToggle').sort(),
    sourceTabs:[...document.querySelectorAll('#sourceSelector [role="tab"]')].map(node=>({id:node.id,label:node.getAttribute('aria-label')})),
    shortcuts:[...document.querySelectorAll('[aria-keyshortcuts]')].filter(node=>!node.closest('#prepPreviewTabs')).map(node=>({id:node.id,key:node.getAttribute('aria-keyshortcuts')})).sort((a,b)=>a.id.localeCompare(b.id)),
    regions:{sourceSelector:rect('#sourceSelector'),resultsPanel:rect('#resultsPanel'),previewTable:rect('#previewTable'),globalHeader:rect('.nexus-ui-header'),preparation:rect('.excel-preparation-panel')},
    preparation:prep?{
      compatibilityHidden:document.querySelector('#sourceSelector').getClientRects().length===0,
      kindButtons:[...document.querySelectorAll('#prepKindButtons [data-prep-kind]')].map(node=>({kind:node.dataset.prepKind,label:node.textContent.trim(),rect:rect('[data-prep-kind="'+node.dataset.prepKind+'"]')})),
      fileButtonInsideDrop:document.querySelector('#prepDropZone').contains(document.querySelector('#prepFileButton')),
      details:[...prep.querySelectorAll('details')].map(node=>({id:node.id,label:node.querySelector('summary').textContent.trim()})),
      actions:[...prep.querySelectorAll('.prep-mapping-actions button')].map(node=>({id:node.id,label:node.textContent.trim()})),
      previewTabs:[...document.querySelectorAll('#prepPreviewTabs [data-preview]')].map(node=>({view:node.dataset.preview,key:node.getAttribute('aria-keyshortcuts'),visible:node.getClientRects().length>0})),
      overflowY:getComputedStyle(prep).overflowY
    }:null
  };
})()`);

let browser;
let client;
const networkRequests = [];
const exceptions = [];
const consoleErrors = [];
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    try { return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] || null; } catch { return null; }
  }, 'browser debugging port', 40_000);
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const testState={mode:'READY',failPage:0,reviewCalls:[],impactCalls:[],dbOpens:[],transactions:[]};
    globalThis.__unresolvedTestState=testState;
    try { sessionStorage.setItem('oneapp.nexus.home.session.v1',JSON.stringify({session:{companyId:'COMPANY-A'}})); } catch {}
    const nativeOpen=indexedDB.open.bind(indexedDB);
    indexedDB.open=(name,...args)=>{testState.dbOpens.push(String(name));return nativeOpen(name,...args);};
    const nativeTransaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...args){testState.transactions.push({database:this.name,stores:Array.isArray(stores)?stores:[stores],mode:String(mode||'readonly')});return nativeTransaction.call(this,stores,mode,...args);};
    globalThis.ONEAPP_ORDEROPS_UNRESOLVED_REVIEW_TEST_PORT={
      async getReviewResult(options){
        testState.reviewCalls.push(structuredClone(options));
        const mode=testState.mode;
        const requestedPage=Number(options.page)||1;
        const failPage=Number(testState.failPage)||0;
        await new Promise(resolve=>setTimeout(resolve,mode==='PAGED_SLOW'?300:30));
        if(mode==='EMPTY')return {status:'EMPTY',count:0,items:[],page:{number:1,limit:200,totalItems:0,totalPages:0,returnedItems:0,hasPrevious:false,hasNext:false}};
        if(mode==='ERROR'||failPage===requestedPage)return {status:'ERROR',count:null,items:[],error:{code:'SAFE_TEST_ERROR'}};
        if(mode==='PAGED'||mode==='PAGED_SLOW'){
          const all=${JSON.stringify(pagedReviewItems)};
          const items=requestedPage===1?all.slice(0,200):requestedPage===2?all.slice(200):[];
          return {status:'READY',count:all.length,items,page:{number:requestedPage,limit:200,totalItems:all.length,totalPages:2,returnedItems:items.length,hasPrevious:requestedPage>1,hasNext:requestedPage<2}};
        }
        const items=${JSON.stringify(reviewItems)};
        return {status:'READY',count:items.length,items,page:{number:1,limit:200,totalItems:items.length,totalPages:1,returnedItems:items.length,hasPrevious:false,hasNext:false}};
      },
      async previewRematchImpactResult(options){testState.impactCalls.push(structuredClone(options));await new Promise(resolve=>setTimeout(resolve,30));return ${JSON.stringify(impactFixture)};}
    };
  })();` });
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });
  client.on('Network.requestWillBeSent', event => networkRequests.push({ method: event.request?.method || '', url: event.request?.url || '', type: event.type || '' }));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate(client, `${origin}/orderops/list-baseline.html`);
  const baselineFlow = await prepareWorkspace(client);
  const baseline = await normalMetrics(client);
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'baseline dark theme');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await wait(150);
  const baselineMobileShell = await evaluate(client, `({viewportWidth:document.documentElement.clientWidth,documentScrollWidth:document.documentElement.scrollWidth,resultsWidth:Math.round(document.querySelector('#resultsPanel').getBoundingClientRect().width)})`);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='light'`, 'baseline light theme restore');

  await navigate(client, `${origin}/fixture.html`);
  await evaluate(client, `(async()=>{localStorage.clear();sessionStorage.clear();for(const info of await indexedDB.databases())await new Promise(resolve=>{const request=indexedDB.deleteDatabase(info.name);request.onsuccess=request.onerror=request.onblocked=resolve;});return true;})()`);
  await navigate(client, `${origin}/orderops/list.html`);
  const currentFlow = await prepareWorkspace(client, { automatic: true });
  const current = await normalMetrics(client);
  const addedPreparationButtonIds = ['prepApplyButton', 'prepFileButton', 'prepSaveTemplateButton'];
  assert.deepEqual(current.existingButtonIds.filter(id => !addedPreparationButtonIds.includes(id)), baseline.existingButtonIds, 'all legacy button IDs must remain; only the approved preparation actions may be added');
  assert.deepEqual(current.existingButtonIds.filter(id => addedPreparationButtonIds.includes(id)), addedPreparationButtonIds, 'the approved preparation actions must all exist exactly once');
  assert.deepEqual(current.sourceTabs, baseline.sourceTabs, 'legacy source tab contracts must remain available for compatibility');
  assert.deepEqual(current.shortcuts, baseline.shortcuts, 'existing shortcut contracts must remain unchanged');
  for (const key of ['x', 'y', 'height', 'bottom']) assert.equal(current.regions.globalHeader[key], baseline.regions.globalHeader[key], 'the local layout must not move or change NEXUS header height');
  assert.equal(current.regions.globalHeader.width, current.viewportWidth, 'NEXUS header must fill the viewport excluding its native scrollbar');
  assert.equal(baseline.preparation, null);
  assert.equal(current.preparation.compatibilityHidden, true, 'the old upload selector must not duplicate the visible preparation controls');
  assert.deepEqual(current.preparation.kindButtons.map(({ kind, label }) => ({ kind, label })), [
    { kind: 'orders', label: '주문서' }, { kind: 'purchases', label: '구매' }, { kind: 'sales', label: '판매' }, { kind: 'inventory', label: '재고' }
  ]);
  const kindRects = current.preparation.kindButtons.map(button => button.rect);
  assert.equal(kindRects[0].y, kindRects[1].y, 'first-row kind controls must share a row');
  assert.equal(kindRects[2].y, kindRects[3].y, 'second-row kind controls must share a row');
  assert.equal(kindRects[0].x, kindRects[2].x);
  assert.equal(kindRects[1].x, kindRects[3].x);
  assert.ok(kindRects[0].right < kindRects[1].x && kindRects[0].bottom < kindRects[2].y, 'kind controls must form a non-overlapping 2×2 grid');
  assert.equal(current.preparation.fileButtonInsideDrop, true);
  assert.deepEqual(current.preparation.details, [{ id: 'prepFileDetails', label: '① 파일·양식 확인' }, { id: 'prepMappingDetails', label: '② 항목명 매핑' }]);
  assert.deepEqual(current.preparation.actions, [{ id: 'prepSaveTemplateButton', label: '매핑 저장' }, { id: 'prepApplyButton', label: '자료 반영' }]);
  assert.deepEqual(current.preparation.previewTabs, [
    { view: 'allocations', key: 'F5', visible: true }, { view: 'ledger', key: 'F6', visible: true }, { view: 'inventory', key: 'F7', visible: true },
    { view: 'purchases', key: null, visible: true }, { view: 'sales', key: null, visible: true }
  ]);
  assert.ok(['auto', 'scroll'].includes(current.preparation.overflowY), 'the preparation panel must own its vertical scroll');
  const { preparation, resultsPanel, previewTable } = current.regions;
  assert.ok(preparation.width > 0 && preparation.right < resultsPanel.x && Math.abs(preparation.y - resultsPanel.y) <= 1, 'desktop preparation and results must remain separate, aligned columns');
  assert.ok(resultsPanel.right <= 1440 && previewTable.width > 0 && previewTable.x >= resultsPanel.x && previewTable.right <= resultsPanel.right + 1, 'the existing worktable must stay inside the right result region');
  assert.deepEqual(baselineFlow, { fileSelections: 2, analysisActions: 1 });
  assert.deepEqual(currentFlow, { fileSelections: 2, analysisActions: 0 }, 'normal files must show results without a new analysis or apply action');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await wait(150);
  const currentMobileShell = await evaluate(client, `(() => {const prep=document.querySelector('.excel-preparation-panel');const p=prep.getBoundingClientRect();const r=document.querySelector('#resultsPanel').getBoundingClientRect();return {viewportWidth:document.documentElement.clientWidth,documentScrollWidth:document.documentElement.scrollWidth,resultsWidth:Math.round(r.width),preparationWidth:Math.round(p.width),preparationHeight:Math.round(p.height),stacked:p.bottom<=r.top+1,internalScroll:['auto','scroll'].includes(getComputedStyle(prep).overflowY)};})()`);
  assert.ok(currentMobileShell.documentScrollWidth <= baselineMobileShell.documentScrollWidth,
    `approved preparation controls must not increase document overflow: ${JSON.stringify({ baselineMobileShell, currentMobileShell })}`);
  assert.ok(currentMobileShell.documentScrollWidth <= 390 && currentMobileShell.resultsWidth > 0 && currentMobileShell.resultsWidth <= 390 && currentMobileShell.preparationWidth > 0 && currentMobileShell.preparationWidth <= 390,
    'both preparation and the result region must fit the 390px shell');
  assert.ok(currentMobileShell.stacked && currentMobileShell.internalScroll && currentMobileShell.preparationHeight <= 521, 'mobile preparation must stack above results with bounded internal scrolling');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await click(client, '#prepPreviewTabs [data-preview="inventory"]');
  await input(client, '#tableSearchInput', '정상상품');
  await click(client, '#specFilterGroup input[value="EA"]');
  const hostBefore = await evaluate(client, `(() => {const table=document.querySelector('#previewTable');table.scrollLeft=80;document.querySelector('#tableSearchInput').focus();return {search:document.querySelector('#tableSearchInput').value,spec:document.querySelector('#specFilterGroup input[value="EA"]').checked,scrollLeft:table.scrollLeft,activeCard:document.querySelector('#prepPreviewTabs [data-preview="inventory"]').getAttribute('aria-selected'),focus:document.activeElement.id,output:{print:document.querySelector('#printButton').disabled,download:document.querySelector('#downloadButton').disabled,cloud:document.querySelector('#cloudSaveButton').disabled,headerCloud:document.querySelector('#headerCloudSaveButton').disabled}};})()`);
  const warmBeforeEntry = await evaluate(client, `({reviewCalls:__unresolvedTestState.reviewCalls.length,impactCalls:__unresolvedTestState.impactCalls.length,orderQDbOpens:__unresolvedTestState.dbOpens.filter(name=>name.includes('orderq')).length})`);
  assert.deepEqual(warmBeforeEntry, { reviewCalls: 0, impactCalls: 0, orderQDbOpens: 0 }, 'warm local display must perform no review gateway/network access before entry');

  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('#previewCount').textContent.includes('3/3')`, 'unresolved READY list');
  const listEvidence = await evaluate(client, `(() => {const rows=[...document.querySelectorAll('#previewTable tbody tr')];const byText=text=>rows.find(row=>row.textContent.includes(text));return {rowCount:rows.length,codeOnly:byText('0007')?.textContent||'',nameOnly:byText('품명만 상품')?.textContent||'',zero:byText('0007')?.children[6]?.textContent.trim(),negative:byText('품명만 상품')?.textContent||'',official:[...document.querySelectorAll('.unresolved-official-null')].map(node=>node.textContent.trim()),impactCalls:__unresolvedTestState.impactCalls.length,foreignVisible:document.body.innerText.includes('COMPANY-B-SECRET'),roleTabs:[...document.querySelectorAll('#resultsPanel [role="tab"]')].map(node=>node.textContent.trim())};})()`);
  assert.equal(listEvidence.rowCount, 3);
  assert.equal(listEvidence.zero, '0');
  assert.match(listEvidence.nameOnly, /품명만 상품/);
  assert.match(listEvidence.negative, /-3/);
  assert.equal(listEvidence.official.every(value => value === '— · 미반영'), true);
  assert.equal(listEvidence.impactCalls, 0, 'impact preview must not run before explicit candidate selection');
  assert.equal(listEvidence.foreignVisible, false);
  assert.equal(listEvidence.roleTabs.includes('미매칭'), false, '미매칭 must not become a new global tab');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await wait(150);
  const listMobile = await evaluate(client, `(() => {const preview=document.querySelector('#previewTable');const scroller=document.querySelector('[data-unresolved-list-table]');const style=getComputedStyle(preview);const rect=preview.getBoundingClientRect();return {documentScrollWidth:document.documentElement.scrollWidth,resultsWidth:Math.round(document.querySelector('#resultsPanel').getBoundingClientRect().width),pageStatus:document.querySelector('[data-unresolved-page-status]')?.textContent.trim(),preview:{left:Math.round(rect.left),right:Math.round(rect.right),width:Math.round(rect.width),clientWidth:preview.clientWidth,scrollWidth:preview.scrollWidth,overflowX:style.overflowX,contain:style.contain},innerTableScroller:{clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,horizontal:scroller.scrollWidth>scroller.clientWidth}};})()`);
  assert.ok(listMobile.documentScrollWidth <= currentMobileShell.documentScrollWidth,
    `unresolved list must not increase document overflow: ${JSON.stringify({ currentMobileShell, listMobile })}`);
  assert.equal(listMobile.innerTableScroller.horizontal, true, 'unresolved list must scroll only inside its table scroller');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await input(client, '#tableSearchInput', '품명만');
  assert.equal(await evaluate(client, `document.querySelectorAll('#previewTable tbody tr:not(.hidden)').length`), 1);
  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true,cancelable:true}));true`);
  await expr(client, `document.querySelector('#previewCount').textContent.includes('3/3')`, 'unresolved F2 reset');
  await click(client, '[data-sort-preview-id="unresolved"][data-sort-column-key="unresolved:product-name"]');
  await click(client, '#columnSortMenu [data-sort-direction="asc"]');
  await evaluate(client, `([...document.querySelectorAll('#previewTable tbody tr')].find(row=>row.textContent.includes('코드와 품명')).querySelector('[data-unresolved-detail]')).click();true`);
  await expr(client, `document.querySelectorAll('.unresolved-detail-table tbody tr').length>=4`, 'source trace and candidate detail');
  const detailBeforeSelection = await evaluate(client, `({sourceRows:document.querySelector('.unresolved-detail-table:not(.unresolved-candidate-table):not(.unresolved-impact-table)').querySelectorAll('tbody tr').length,candidateRows:document.querySelectorAll('.unresolved-candidate-table tbody tr').length,checked:document.querySelectorAll('[data-unresolved-candidate]:checked').length,automaticText:(document.body.innerText.match(/자동확정 아님/g)||[]).length,impactCalls:__unresolvedTestState.impactCalls.length,hasRevision:document.body.innerText.includes('REV-BOTH-2'),traceLinks:[...document.querySelectorAll('.unresolved-inline-link[target="_blank"]')].map(node=>node.getAttribute('href')),foreignVisible:document.body.innerText.includes('COMPANY-B-SECRET')})`);
  assert.deepEqual(detailBeforeSelection, { sourceRows: 2, candidateRows: 2, checked: 0, automaticText: 3, impactCalls: 0, hasRevision: true, traceLinks: ['../orderq/voucher-query.html?mode=purchase&date=2026-09-03&focus=PURCHASE-BOTH', '../orderq/voucher-query.html?mode=sale&date=2026-09-01&focus=SALE-BOTH'], foreignVisible: false });
  await click(client, '[data-unresolved-candidate="PRODUCT-EXACT"]');
  await expr(client, `document.querySelector('[data-impact-status="REVIEW_REQUIRED"]')&&__unresolvedTestState.impactCalls.length===1`, 'explicit candidate impact preview');
  const impactEvidence = await evaluate(client, `({labels:[...document.querySelectorAll('.unresolved-impact-label')].map(node=>node.textContent.trim()),checkpoint:document.body.innerText.includes('CHECKPOINT-A'),applyButtons:[...document.querySelectorAll('#previewTable button')].filter(node=>/확정|적용/.test(node.textContent)).length,companyIds:__unresolvedTestState.reviewCalls.concat(__unresolvedTestState.impactCalls).map(call=>call.companyId),selected:document.querySelector('[data-unresolved-candidate="PRODUCT-EXACT"]').checked})`);
  assert.equal(impactEvidence.labels.some(value => value.includes('적용 가능') && value.includes('APPLY_READY')), true);
  assert.equal(impactEvidence.labels.some(value => value.includes('실사 판단 필요') && value.includes('DECISION_REQUIRED')), true);
  assert.equal(impactEvidence.labels.some(value => value.includes('원자료 확인 필요') && value.includes('REVIEW_REQUIRED')), true);
  assert.equal(impactEvidence.checkpoint, true);
  assert.equal(impactEvidence.applyButtons, 0);
  assert.equal(impactEvidence.companyIds.every(value => value === 'COMPANY-A'), true);
  assert.equal(impactEvidence.selected, true);

  await wait(2600);
  const lightScreenshot = await capture(client, 'orderops-unresolved-review-light.png');
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'dark theme');
  const darkScreenshot = await capture(client, 'orderops-unresolved-review-dark.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await wait(200);
  await evaluate(client, `document.querySelector('#resultsPanel').scrollIntoView({block:'start'});document.querySelector('#previewTable').scrollTop=0;true`);
  const mobile = await evaluate(client, `(() => {const scroller=document.querySelector('.unresolved-table-scroll');return {viewportWidth:document.documentElement.clientWidth,documentScrollWidth:document.documentElement.scrollWidth,resultsWidth:Math.round(document.querySelector('#resultsPanel').getBoundingClientRect().width),horizontalScroller:scroller.scrollWidth>scroller.clientWidth,focusableCandidate:document.querySelector('[data-unresolved-candidate]')?.tabIndex>=0};})()`);
  assert.ok(mobile.viewportWidth >= 375 && mobile.viewportWidth <= 390, `390px emulation content width must account only for the browser scrollbar: ${mobile.viewportWidth}`);
  assert.ok(currentMobileShell.resultsWidth <= 390 && mobile.resultsWidth <= 390 && mobile.horizontalScroller && mobile.focusableCandidate,
    `390px result area must stay contained and preserve feature table horizontal scroll: ${JSON.stringify({ currentMobileShell, mobile })}`);
  assert.ok(mobile.documentScrollWidth <= currentMobileShell.documentScrollWidth,
    `unresolved detail must not increase document overflow: ${JSON.stringify({ currentMobileShell, mobile })}`);
  const mobileScreenshot = await capture(client, 'orderops-unresolved-review-mobile-390.png');

  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('#tableSearchInput').value==='정상상품'&&document.querySelector('#prepPreviewTabs [data-preview="inventory"]').getAttribute('aria-selected')==='true'&&document.querySelector('#previewTable').scrollLeft===80&&document.activeElement.id==='tableSearchInput'`, 'host view restoration');
  const hostAfter = await evaluate(client, `({search:document.querySelector('#tableSearchInput').value,spec:document.querySelector('#specFilterGroup input[value="EA"]').checked,scrollLeft:document.querySelector('#previewTable').scrollLeft,activeCard:document.querySelector('#prepPreviewTabs [data-preview="inventory"]').getAttribute('aria-selected'),focus:document.activeElement.id,output:{print:document.querySelector('#printButton').disabled,download:document.querySelector('#downloadButton').disabled,cloud:document.querySelector('#cloudSaveButton').disabled,headerCloud:document.querySelector('#headerCloudSaveButton').disabled}})`);
  assert.deepEqual(hostAfter, hostBefore, 'search, selection, scroll, active view, and focus must restore on exit');

  await evaluate(client, `__unresolvedTestState.mode='ERROR';true`);
  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('#previewTable').textContent.includes('조회 실패 · 재시도 필요')`, 'ERROR state');
  assert.equal(await evaluate(client, `document.querySelector('#previewTable').textContent.includes('미매칭 자료 없음')`), false);
  await evaluate(client, `__unresolvedTestState.mode='READY';true`);
  await click(client, '[data-unresolved-retry]');
  await expr(client, `document.querySelector('#previewCount').textContent.includes('3/3')`, 'ERROR retry');
  await click(client, '#unresolvedReviewToggle');
  await evaluate(client, `__unresolvedTestState.mode='EMPTY';true`);
  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('#previewTable').textContent.includes('미매칭 자료 없음')`, 'EMPTY state');
  assert.equal(await evaluate(client, `document.querySelector('#previewTable').textContent.includes('조회 실패')`), false);
  await click(client, '#unresolvedReviewToggle');
  await evaluate(client, `__unresolvedTestState.mode='READY';true`);
  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('#previewCount').textContent.includes('3/3')`, 'shortcut exit setup');
  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'F7',bubbles:true,cancelable:true}));true`);
  await expr(client, `document.querySelector('#prepPreviewTabs [data-preview="inventory"]').getAttribute('aria-selected')==='true'&&document.querySelector('#unresolvedReviewToggle').getAttribute('aria-pressed')==='false'`, 'F7 exit to inventory');
  assert.deepEqual(await evaluate(client, `({print:document.querySelector('#printButton').disabled,download:document.querySelector('#downloadButton').disabled,cloud:document.querySelector('#cloudSaveButton').disabled,headerCloud:document.querySelector('#headerCloudSaveButton').disabled})`), hostBefore.output,
    'normal output button state must restore when a legacy shortcut exits review');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `__unresolvedTestState.mode='PAGED';__unresolvedTestState.failPage=0;true`);
  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('[data-unresolved-page-status]')?.textContent.includes('1/2')&&document.querySelectorAll('#previewTable tbody tr').length===200`, 'paged review first page');
  const pageOneBoundary = await evaluate(client, `({status:document.querySelector('[data-unresolved-page-status]').textContent.trim(),previousDisabled:document.querySelector('[data-unresolved-page="0"]').disabled,nextDisabled:document.querySelector('[data-unresolved-page="2"]').disabled,scope:document.querySelector('.unresolved-pagination-copy small').textContent.trim(),lastRequest:__unresolvedTestState.reviewCalls.at(-1)})`);
  assert.deepEqual({ previousDisabled: pageOneBoundary.previousDisabled, nextDisabled: pageOneBoundary.nextDisabled }, { previousDisabled: true, nextDisabled: false });
  assert.match(pageOneBoundary.scope, /현재 페이지 자료에만 적용/);
  assert.deepEqual({ page: pageOneBoundary.lastRequest.page, limit: pageOneBoundary.lastRequest.limit }, { page: 1, limit: 200 });

  await evaluate(client, `__unresolvedTestState.failPage=2;true`);
  await click(client, '[data-unresolved-page="2"]');
  await expr(client, `document.querySelector('#previewTable').textContent.includes('2페이지 조회 실패 · 재시도 필요')`, 'second page error');
  assert.equal(await evaluate(client, `__unresolvedTestState.reviewCalls.at(-1).page`), 2, 'page error must preserve requested page');
  await evaluate(client, `__unresolvedTestState.failPage=0;true`);
  await click(client, '[data-unresolved-retry]');
  await expr(client, `document.querySelector('[data-unresolved-page-status]')?.textContent.includes('2/2')&&document.body.innerText.includes('201번째 미매칭 자료')`, 'second page retry and row 201');
  const pageTwoBoundary = await evaluate(client, `({status:document.querySelector('[data-unresolved-page-status]').textContent.trim(),rowCount:document.querySelectorAll('#previewTable tbody tr').length,previousDisabled:document.querySelector('[data-unresolved-page="1"]').disabled,nextDisabled:document.querySelector('[data-unresolved-page="3"]').disabled,lastRequest:__unresolvedTestState.reviewCalls.at(-1)})`);
  assert.deepEqual({ previousDisabled: pageTwoBoundary.previousDisabled, nextDisabled: pageTwoBoundary.nextDisabled }, { previousDisabled: false, nextDisabled: true });
  assert.equal(pageTwoBoundary.rowCount, 1);
  assert.deepEqual({ page: pageTwoBoundary.lastRequest.page, limit: pageTwoBoundary.lastRequest.limit }, { page: 2, limit: 200 });
  const paginationScreenshot = await capture(client, 'orderops-unresolved-review-page-2.png');
  await click(client, '[data-unresolved-detail="UP-PAGE-201"]');
  await expr(client, `document.body.innerText.includes('201번째 미매칭 자료')&&document.querySelector('[data-unresolved-list]')`, 'page two detail');
  await click(client, '[data-unresolved-list]');
  await expr(client, `document.querySelector('[data-unresolved-page-status]')?.textContent.includes('2/2')&&document.body.innerText.includes('201번째 미매칭 자료')`, 'page two preserved after detail return');

  await evaluate(client, `__unresolvedTestState.mode='PAGED_SLOW';true`);
  await click(client, '[data-unresolved-page="1"]');
  await expr(client, `document.querySelector('#previewTable').textContent.includes('미매칭 1페이지 조회 중')`, 'slow previous page request');
  await evaluate(client, `__unresolvedTestState.mode='ERROR';true`);
  await click(client, '#unresolvedReviewToggle');
  await click(client, '#unresolvedReviewToggle');
  await expr(client, `document.querySelector('#previewTable').textContent.includes('1페이지 조회 실패 · 재시도 필요')`, 'fresh request after leaving slow page request');
  await wait(360);
  const stalePageEvidence = await evaluate(client, `({stillError:document.querySelector('#previewTable').textContent.includes('1페이지 조회 실패 · 재시도 필요'),staleRowVisible:document.body.innerText.includes('1번째 미매칭 자료'),lastRequest:__unresolvedTestState.reviewCalls.at(-1)})`);
  assert.deepEqual({ stillError: stalePageEvidence.stillError, staleRowVisible: stalePageEvidence.staleRowVisible }, { stillError: true, staleRowVisible: false }, 'stale page response must not replace the current request state');
  await click(client, '#unresolvedReviewToggle');
  await evaluate(client, `__unresolvedTestState.mode='READY';__unresolvedTestState.failPage=0;true`);

  const paginationEvidence = { totalItems: 201, totalPages: 2, pageOneBoundary, pageTwoBoundary, detailReturnPage: 2, stalePageEvidence };

  const runtimeIsolation = await evaluate(client, `({orderQDbOpens:__unresolvedTestState.dbOpens.filter(name=>name.includes('orderq')).length,orderQReadwriteTransactions:__unresolvedTestState.transactions.filter(tx=>tx.database.includes('orderq')&&tx.mode==='readwrite').length,reviewCalls:__unresolvedTestState.reviewCalls.length,impactCalls:__unresolvedTestState.impactCalls.length})`);
  const externalMutatingRequests = networkRequests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()) && !request.url.startsWith(origin));
  const fixtureServerWrites = localServerRequests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(String(request.method).toUpperCase()));
  assert.deepEqual(externalMutatingRequests, []);
  assert.deepEqual(fixtureServerWrites, []);
  assert.equal(runtimeIsolation.orderQDbOpens, 0);
  assert.equal(runtimeIsolation.orderQReadwriteTransactions, 0);
  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);

  const evidence = {
    taskId: 'NEXUS-SI-V2-06B', baselineSha: BASE_SHA, status: 'PASS',
    domAndLayout: { baseline, current, unchangedExistingButtons: true, addedPreparationButtonIds, unchangedSourceTabs: true, unchangedShortcuts: true, preservedGlobalHeader: true, approvedPreparationLayout: true },
    clickContract: { baselineFlow, currentFlow, normalFlowBefore: baselineFlow.fileSelections + baselineFlow.analysisActions, normalFlowAfter: currentFlow.fileSelections + currentFlow.analysisActions, unresolvedListEntry: 1, listToImpactPreview: 2 },
    review: { listEvidence, detailBeforeSelection, impactEvidence, paginationEvidence, errorDistinctFromEmpty: true, companyIsolation: true },
    statePreservation: { before: hostBefore, after: hostAfter },
    isolation: { ...runtimeIsolation, warmBeforeEntry, actualExternalMutatingRequests: 0, fixtureServerWrites: 0, productionOrderQIndexedDbWrites: 0 },
    display: { baselineMobileShell, currentMobileShell, listMobile, mobile, noAddedDocumentOverflow: true, themes: ['light', 'dark'], screenshots: [lightScreenshot, darkScreenshot, mobileScreenshot, paginationScreenshot] }
  };
  writeFileSync(join(evidenceDir, 'browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  console.log('OrderOps unresolved-review browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
