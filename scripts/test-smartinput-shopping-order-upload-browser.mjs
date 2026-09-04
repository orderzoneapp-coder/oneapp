#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SHOPPING_ORDER_HEADERS } from '../orderq/shopping-order-dedupe-core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const XLSX = require(join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'));
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-shopping-browser-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-shopping-files-'));
const screenshotDir = resolve(process.env.SMARTINPUT_SHOPPING_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-shopping-screenshots'));
mkdirSync(screenshotDir, { recursive: true });

const customerNames = ['온라인거래처 가', '온라인거래처 나', '온라인거래처 다', '온라인거래처 라', '온라인거래처 마'];
const groupLengths = [2, 3, 3, 3, 3];
const sourceRows = [];
let sequence = 0;
customerNames.forEach((customerName, customerIndex) => {
  for (let line = 0; line < groupLengths[customerIndex]; line += 1) {
    sequence += 1;
    const quantity = sequence % 3 + 1;
    const unitPrice = 1000 + sequence * 100;
    sourceRows.push([
      '2026-09-04', customerName, `G-${customerIndex + 1}`, '입금', `전달 ${sequence}`, `메모 ${sequence}`,
      `SHOP-${String(sequence).padStart(3, '0')}`, `쇼핑 상품 ${sequence}`, `${sequence}BOX`, quantity, unitPrice,
      quantity * unitPrice, `COPY-${sequence}`, `원본 주소 ${customerIndex + 1}`, `010-0000-${String(customerIndex + 1).padStart(4, '0')}`,
      `ORIGIN-${sequence}`, `DIST-${customerIndex + 1}`
    ]);
  }
});

function writeWorkbook(file, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SHOPPING_ORDER_HEADERS, ...rows]), 'Worksheet');
  writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }));
}

const validFile = join(fixtureDir, 'shopping-valid.xls');
const issueFile = join(fixtureDir, 'shopping-one-amount-review.xls');
const issueRows = sourceRows.map(row => [...row]);
issueRows[groupLengths[0]][11] = Number(issueRows[groupLengths[0]][11]) - 1;
writeWorkbook(validFile, sourceRows);
writeWorkbook(issueFile, issueRows);

const requests = [];
const mime = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.xls': 'application/vnd.ms-excel'
};
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  requests.push({ method: request.method, pathname });
  if (pathname === '/fixture.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end('<!doctype html><meta charset="utf-8"><title>SmartInput shopping fixture</title>');
  }
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('Not found');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  response.end(readFileSync(target));
});

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 25_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
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
const click = (client, selector) => evaluate(client, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const input = (client, selector, value) => evaluate(client, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const upload = async (client, file) => {
  const documentNode = await client.send('DOM.getDocument');
  const fileNode = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#fileInput' });
  await client.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [file] });
};
const refreshPicker = async (client, {
  openSelector, dialogSelector, inputSelector, refreshSelector, resultSelector, expectedQuery, expectSuccess, counterKey
}) => {
  await click(client, openSelector);
  await expr(client, `document.querySelector(${JSON.stringify(dialogSelector)})?.open===true`, `${counterKey} dialog open`);
  assert.equal(await evaluate(client, `document.querySelector(${JSON.stringify(inputSelector)}).value`), expectedQuery,
    `${counterKey}: picker must open with its source search term`);
  const started = await evaluate(client, `(()=>{
    const button=document.querySelector(${JSON.stringify(refreshSelector)});
    window[${JSON.stringify(counterKey)}]=0;
    button.addEventListener('click',()=>{window[${JSON.stringify(counterKey)}]+=1;},{capture:true});
    button.click();
    button.click();
    return {disabled:button.disabled,query:document.querySelector(${JSON.stringify(inputSelector)}).value};
  })()`);
  assert.equal(started.disabled, true, `${counterKey}: refresh button must disable before awaiting`);
  assert.equal(started.query, expectedQuery, `${counterKey}: search term must stay visible during refresh`);
  await expr(client, `(()=>{
    const dialog=document.querySelector(${JSON.stringify(dialogSelector)});
    const button=document.querySelector(${JSON.stringify(refreshSelector)});
    const input=document.querySelector(${JSON.stringify(inputSelector)});
    return dialog?.open===true&&button?.disabled===false&&input?.value===${JSON.stringify(expectedQuery)}&&document.activeElement===input;
  })()`, `${counterKey} refresh completion`, 30_000);
  const completed = await evaluate(client, `(()=>({
    clickCount:window[${JSON.stringify(counterKey)}],
    query:document.querySelector(${JSON.stringify(inputSelector)}).value,
    focused:document.activeElement===document.querySelector(${JSON.stringify(inputSelector)}),
    resultCount:document.querySelectorAll(${JSON.stringify(resultSelector)}).length,
    message:document.querySelector(${JSON.stringify(dialogSelector)}+' .smart-dialog__message').textContent
  }))()`);
  assert.equal(completed.clickCount, 1, `${counterKey}: disabled button must suppress a duplicate refresh click`);
  assert.equal(completed.query, expectedQuery, `${counterKey}: completed refresh must restore the search term`);
  assert.equal(completed.focused, true, `${counterKey}: completed refresh must restore search focus`);
  assert.ok(completed.resultCount > 0, `${counterKey}: completed refresh must rerun the retained search`);
  if (expectSuccess) assert.doesNotMatch(completed.message, /실패/, `${counterKey}: successful refresh must not show failure`);
  else assert.match(completed.message, /새로고침에 실패했습니다.*검색어와 기존 검색 결과를 유지했습니다/,
    `${counterKey}: failed refresh must explain preserved query and results`);
  await click(client, `${dialogSelector} [data-close]`);
  await expr(client, `!document.querySelector(${JSON.stringify(dialogSelector)})`, `${counterKey} dialog close`);
  return completed;
};
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
};

let browser;
let client;
const exceptions = [];
const consoleErrors = [];
const networkRequests = [];
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const debugPort = await waitFor(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)[0] || null; } catch { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable'), client.send('DOM.enable')]);
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });
  client.on('Network.requestWillBeSent', event => networkRequests.push({ method: event.request?.method || '', url: event.request?.url || '' }));

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${origin}/fixture.html` });
  await loaded;
  const products = sourceRows.map(row => ({
    productId: `PRODUCT:${row[6]}`, masterProductId: `PRODUCT:${row[6]}`, itemCode: row[6], itemName: row[7],
    specification: row[8], finalUnit: row[8], outPrice: row[10], status: 'ACTIVE'
  }));
  await evaluate(client, `localStorage.setItem('merchMaster_v870',${JSON.stringify(JSON.stringify(products))});localStorage.setItem('merchMaster_revision_v870','1');true`);
  await evaluate(client, `(async()=>{
    const customerDb=await import('/customer-master/db.js?shopping-ui-fixture=1');
    const db=await customerDb.openDb();
    const tx=db.transaction(['customers','appMeta'],'readwrite');
    ${JSON.stringify(customerNames)}.forEach((customerName,index)=>tx.objectStore('customers').put({customerId:'CUSTOMER:'+(index+1),customerCode:'C-'+(index+1),customerName,normalizedCustomerCode:'c-'+(index+1),normalizedName:customerName,searchText:customerName+' C-'+(index+1),status:'ACTIVE',qualityStatus:'VERIFIED',revision:1,createdAt:'2026-09-04T00:00:00.000Z',updatedAt:'2026-09-04T00:00:00.000Z'}));
    tx.objectStore('appMeta').put({key:'headRevision',value:1,updatedAt:'2026-09-04T00:00:00.000Z'});
    await customerDb.transactionDone(tx);
    const orderDb=await import('/orderq/orderq-db.js?shopping-ui-fixture=1');
    const odb=await orderDb.openOrderQDb();
    const otx=odb.transaction('warehouses','readwrite');
    otx.objectStore('warehouses').put({warehouseId:'WH-01',warehouseCode:'01',warehouseName:'본사창고',normalizedName:'본사창고',warehouseType:'STOCK',status:'ACTIVE',createdAt:'2026-09-04T00:00:00.000Z',updatedAt:'2026-09-04T00:00:00.000Z'});
    await orderDb.transactionDone(otx);
    return true;
  })()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${origin}/smartinput/` });
  await loaded;
  await expr(client, `document.querySelector('#productReferenceStatus')?.textContent==='READY'&&document.querySelector('#customerReferenceStatus')?.textContent==='READY'`, 'owner references ready');
  await input(client, '#warehouseInput', '본사창고');
  await expr(client, `document.querySelector('#warehouseInput').value==='본사창고'`, 'owner warehouse selected');
  await evaluate(client, `new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/customer-master/vendor/xlsx.full.min.js';script.onload=()=>resolve(true);script.onerror=()=>reject(new Error('XLSX_LOAD_FAILED'));document.head.append(script);})`);

  await upload(client, issueFile);
  await expr(client, `document.querySelectorAll('.shopping-order-candidate').length===5&&document.querySelectorAll('.shopping-order-candidate[data-status="NEW"]').length===4&&document.querySelectorAll('.shopping-order-candidate[data-status="REVIEW_REQUIRED"]').length===1`, 'one review candidate and four normal candidates', 30_000);
  assert.match(await evaluate(client, `document.querySelector('.shopping-order-candidate[data-status="REVIEW_REQUIRED"] .shopping-order-issues').textContent`), /금액/);
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent.trim()`), '신규 주문 저장 4건');
  const pickerRefresh = {
    customerSuccess: await refreshPicker(client, {
      openSelector: '[data-shopping-customer]', dialogSelector: 'dialog.smart-customer-dialog',
      inputSelector: 'dialog.smart-customer-dialog input[type="search"]',
      refreshSelector: 'dialog.smart-customer-dialog [data-customer-refresh]',
      resultSelector: 'dialog.smart-customer-dialog .smart-customer-row', expectedQuery: customerNames[0],
      expectSuccess: true, counterKey: '__customerRefreshSuccessClicks'
    }),
    productSuccess: await refreshPicker(client, {
      openSelector: '[data-shopping-product-row]', dialogSelector: 'dialog.product-picker-dialog',
      inputSelector: 'dialog.product-picker-dialog [data-product-search]',
      refreshSelector: 'dialog.product-picker-dialog [data-refresh-product-reference]',
      resultSelector: 'dialog.product-picker-dialog .product-picker-result', expectedQuery: sourceRows[0][6],
      expectSuccess: true, counterKey: '__productRefreshSuccessClicks'
    })
  };
  const validProductSnapshot = await evaluate(client, `localStorage.getItem('merchMaster_v870')`);
  await evaluate(client, `localStorage.setItem('merchMaster_v870','{');true`);
  pickerRefresh.customerFailure = await refreshPicker(client, {
    openSelector: '[data-shopping-customer]', dialogSelector: 'dialog.smart-customer-dialog',
    inputSelector: 'dialog.smart-customer-dialog input[type="search"]',
    refreshSelector: 'dialog.smart-customer-dialog [data-customer-refresh]',
    resultSelector: 'dialog.smart-customer-dialog .smart-customer-row', expectedQuery: customerNames[0],
    expectSuccess: false, counterKey: '__customerRefreshFailureClicks'
  });
  pickerRefresh.productFailure = await refreshPicker(client, {
    openSelector: '[data-shopping-product-row]', dialogSelector: 'dialog.product-picker-dialog',
    inputSelector: 'dialog.product-picker-dialog [data-product-search]',
    refreshSelector: 'dialog.product-picker-dialog [data-refresh-product-reference]',
    resultSelector: 'dialog.product-picker-dialog .product-picker-result', expectedQuery: sourceRows[0][6],
    expectSuccess: false, counterKey: '__productRefreshFailureClicks'
  });
  await evaluate(client, `localStorage.setItem('merchMaster_v870',${JSON.stringify(validProductSnapshot)});true`);
  await click(client, '#completeButton');
  await expr(client, `(async()=>{const db=await import('/orderq/orderq-db.js?shopping-ui-count=1');return (await db.getAll(db.STORE.ORDERS)).length===4;})()`, 'four isolated normal candidates saved', 30_000);

  await upload(client, validFile);
  await expr(client, `document.querySelectorAll('.shopping-order-candidate').length===5&&document.querySelectorAll('.shopping-order-candidate[data-status="NEW"]').length===1&&document.querySelectorAll('.shopping-order-candidate[data-status="DUPLICATE"]').length===4`, 'one surplus and four actual-ledger duplicates', 30_000);
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent.trim()`), '신규 주문 저장 1건');
  const screenshots = [];
  for (const [width, height, mobile] of [[1920, 1080, false], [1440, 1000, false], [390, 844, true]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await wait(180);
    if (width === 390 && await evaluate(client, `document.querySelector('#estimateLibraryView')?.classList.contains('is-open')`)) {
      await click(client, '#relatedPanelCloseButton');
      await expr(client, `!document.querySelector('#estimateLibraryView')?.classList.contains('is-open')`, 'close mobile activity drawer');
    }
    for (const theme of ['light', 'dark']) {
      const isDark = await evaluate(client, `document.documentElement.dataset.nexusUiTheme==='dark'`);
      if ((theme === 'dark') !== isDark) {
        await click(client, '[data-nexus-ui-theme-toggle]');
        await expr(client, `document.documentElement.dataset.nexusUiTheme===${JSON.stringify(theme)}`, `${width}px ${theme} theme`);
      }
      if (width === 390) await evaluate(client, `document.querySelector('#shoppingOrderImport').scrollIntoView({block:'start'});true`);
      const metrics = await evaluate(client, `(()=>{const panel=document.querySelector('#shoppingOrderImport').getBoundingClientRect();const cards=[...document.querySelectorAll('.shopping-order-candidate')].map(card=>{const rect=card.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width,scrollWidth:card.scrollWidth,clientWidth:card.clientWidth};});const focused=document.querySelector('[data-shopping-customer]');focused.focus();return {pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,panel:{left:panel.left,right:panel.right,width:panel.width,scrollWidth:document.querySelector('#shoppingOrderImport').scrollWidth,clientWidth:document.querySelector('#shoppingOrderImport').clientWidth},cards,focusVisible:document.activeElement===focused,theme:document.documentElement.dataset.nexusUiTheme};})()`);
      assert.ok(metrics.pageOverflow <= 0, `${width}px ${theme}: page horizontal overflow`);
      assert.ok(metrics.panel.left >= 0 && metrics.panel.right <= width + 1, `${width}px ${theme}: panel outside viewport`);
      assert.ok(metrics.panel.scrollWidth <= metrics.panel.clientWidth + 1, `${width}px ${theme}: panel clips horizontally`);
      assert.ok(metrics.cards.every(card => card.scrollWidth <= card.clientWidth + 1 && card.left >= 0 && card.right <= width + 1), `${width}px ${theme}: candidate clips horizontally`);
      assert.equal(metrics.focusVisible, true, `${width}px ${theme}: candidate owner button must accept focus`);
      screenshots.push(await capture(client, `smartinput-shopping-${width}-${theme}.png`));
    }
  }

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click(client, '#completeButton');
  await expr(client, `(async()=>{const db=await import('/orderq/orderq-db.js?shopping-ui-count=2');return (await db.getAll(db.STORE.ORDERS)).length===5;})()`, 'fifth surplus saved', 30_000);
  await upload(client, validFile);
  await expr(client, `document.querySelectorAll('.shopping-order-candidate[data-status="DUPLICATE"]').length===5&&document.querySelector('#completeButton').disabled`, 'all existing orders excluded with zero-write action', 30_000);
  const finalEvidence = await evaluate(client, `(async()=>{const db=await import('/orderq/orderq-db.js?shopping-ui-final=1');const orders=await db.getAll(db.STORE.ORDERS);const items=await db.getAll(db.STORE.ORDER_ITEMS);const events=await db.getAll(db.STORE.ORDER_EVENTS);const queue=await db.getAll(db.STORE.SYNC_QUEUE);return {orders:orders.length,items:items.length,events:events.length,queue:queue.length,externalOrderNos:orders.map(order=>order.externalOrderNo),sourceType:[...new Set(orders.map(order=>order.sourceType))],firstEvidence:orders[0].shoppingSourceEvidence.rows[0]};})()`);
  assert.equal(finalEvidence.orders, 5);
  assert.equal(finalEvidence.items, 14);
  assert.equal(finalEvidence.events, 5);
  assert.equal(finalEvidence.queue, 10);
  assert.deepEqual(finalEvidence.externalOrderNos, ['', '', '', '', '']);
  assert.deepEqual(finalEvidence.sourceType, ['SHOPPING_MALL_ORIGINAL']);
  assert.equal(finalEvidence.firstEvidence.sourceValues['상점메모'].startsWith('메모 '), true);
  assert.equal(finalEvidence.firstEvidence.sourceCellEvidence.length, 17);

  const externalMutations = networkRequests.filter(row => !row.url.startsWith(origin) && !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  const localMutations = requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method.toUpperCase()));
  assert.deepEqual(externalMutations, []);
  assert.deepEqual(localMutations, []);
  assert.deepEqual(exceptions, []);
  assert.deepEqual(consoleErrors, []);
  console.log(JSON.stringify({
    taskId: 'NEXUS-SMARTINPUT-SHOPPING-UPLOAD-20260904-01',
    status: 'PASS',
    candidates: 5,
    firstCommit: { created: 4, reviewRequired: 1 },
    secondCommit: { priorDuplicates: 4, created: 1 },
    finalDuplicateZeroWrite: 5,
    stored: finalEvidence,
    pickerRefresh,
    viewports: ['1920 light/dark', '1440 light/dark', '390 light/dark'],
    screenshots,
    isolation: { externalMutations: 0, localMutations: 0, exceptions: 0, consoleErrors: 0, temporaryProfile: true }
  }, null, 2));
} finally {
  client?.close();
  browser?.kill();
  await new Promise(resolveClose => server.close(resolveClose));
  await wait(250);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  try { rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
