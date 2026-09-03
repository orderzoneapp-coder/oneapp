#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-input-list-search-e2e-'));
const screenshotDir = resolve(process.env.SMARTINPUT_INPUT_LIST_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-input-list-search-screenshots'));
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
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return element.value;})()`);
const key = async (client, keyValue, code, virtualKeyCode) => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyValue, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyValue, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
};
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
};

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
    const mapper=await import('/smartinput/input-template-mapper.js?input-list-search-e2e=1');
    const contract=window.SMART_INPUT_CONTRACT;
    const draft=contract.createDraft({activeMode:'order'});
    const matrix=[
      ['품목코드','품목명','규격','수량','단가','공급가액','메모','적요(직원)'],
      ['CODE-ZERO','사과','BOX','0','100','0','','직원 전달'],
      ['CODE-NEG','배','EA','-2','100','-200','반품 확인','']
    ];
    const targets=[
      {id:'voucher.order.line.productCode',label:'품목코드',scope:'voucher',projectionFieldId:'itemCode',valueType:'TEXT'},
      {id:'voucher.order.line.productName',label:'품목명',scope:'voucher',projectionFieldId:'itemName',valueType:'TEXT'},
      {id:'voucher.order.line.specification',label:'규격',scope:'voucher',projectionFieldId:'specification',valueType:'TEXT'},
      {id:'voucher.order.line.quantity',label:'수량',scope:'voucher',projectionFieldId:'quantity',valueType:'NUMBER'},
      {id:'voucher.order.line.unitPrice',label:'단가',scope:'voucher',projectionFieldId:'unitPrice',valueType:'NUMBER'},
      {id:'voucher.order.line.supplyAmount',label:'공급가액',scope:'voucher',projectionFieldId:'supplyAmount',valueType:'NUMBER'},
      {id:'voucher.order.line.memo',label:'메모',scope:'voucher',projectionFieldId:'memo',valueType:'TEXT'},
      {id:'description',label:'적요(직원)',scope:'voucher',projectionFieldId:'description',valueType:'TEXT'}
    ];
    const session=mapper.createMappingSession({matrix,headerRowIndex:0,targetDefinitions:targets,fileName:'검색계약.xlsx',sheetName:'원본',companyId:'ONEAPP',voucherMode:'order'});
    session.batchId='SIBATCH-INPUT-LIST-SEARCH-E2E';
    draft.modes.order.inputMapping=session;
    draft.modes.order.rows=mapper.projectMappedRows(session,targets).map(row=>contract.normalizeRow({...row,batchId:session.batchId},session.batchId));
    draft.modes.order.activeMethod='excel';
    draft.modes.order.sourceText=matrix.map(row=>row.join('\t')).join('\n');
    localStorage.setItem('merchMaster_v870',JSON.stringify([
      {productId:'P-F3-A',masterProductId:'MP-F3-A',itemCode:'F3-A',itemName:'상품검색 A',searchInfo:'PAIRCHOICE',specification:'5kg',finalUnit:'BOX',outPrice:100,status:'ACTIVE'},
      {productId:'P-F3-B',masterProductId:'MP-F3-B',itemCode:'F3-B',itemName:'상품검색 B',searchInfo:'PAIRCHOICE',specification:'10kg',finalUnit:'EA',outPrice:200,status:'ACTIVE'}
    ]));
    localStorage.setItem('merchMaster_revision_v870','1');
    localStorage.setItem(contract.DRAFT_STORAGE_KEY,JSON.stringify(draft));
    return true;
  })()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expr(client, `!document.querySelector('#mappingWorktable').hidden`, 'source-column table view');
  await expr(client, `document.querySelector('#productReferenceStatus').dataset.status!=='LOADING'&&document.querySelector('#customerReferenceStatus').dataset.status!=='LOADING'`, 'reference initialization', 30_000);
  await wait(500);

  const fixtureDraftJson = await evaluate(client, `localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)`);
  const ensureTableView = async view => {
    const selector = `[data-table-view="${view}"]`;
    if (await evaluate(client, `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed')!=='true'`)) await click(client, selector);
    await expr(client, view === 'source'
      ? `!document.querySelector('#mappingWorktable').hidden`
      : `!document.querySelector('#voucherInputTable').hidden`, `${view} table view`);
  };
  const restoreFixture = async view => {
    await evaluate(client, `localStorage.setItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY,${JSON.stringify(fixtureDraftJson)});true`);
    loaded = client.once('Page.loadEventFired');
    await client.send('Page.reload', { ignoreCache: true });
    await loaded;
    await expr(client, `Boolean(document.querySelector('#inputRows tr')||document.querySelector('#mappingInputRows tr'))`, 'restored SmartInput shell');
    await expr(client, `document.querySelector('#productReferenceStatus').dataset.status!=='LOADING'&&document.querySelector('#customerReferenceStatus').dataset.status!=='LOADING'`, 'restored reference initialization', 30_000);
    await ensureTableView(view);
  };
  const mappingTotals = () => evaluate(client, `Object.fromEntries([...document.querySelectorAll('#mappingTableTotals [data-mapping-total-column]')].map(cell=>[cell.dataset.mappingTotalColumn,cell.textContent.trim()]))`);
  const inputTotals = () => evaluate(client, `({quantity:document.querySelector('#totalQuantity').textContent.trim(),amount:document.querySelector('#totalAmount').textContent.trim()})`);

  const protectedDataExpression = `(() => {const mode=JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order;return JSON.stringify({rows:mode.rows.map(row=>({rowId:row.rowId,itemCode:row.itemCode,itemName:row.itemName,specification:row.specification,quantity:row.quantity,unitPrice:row.unitPrice,memo:row.memo,description:row.description,customValues:row.customValues})),inputMapping:{workingRows:mode.inputMapping.workingRows,sourceMatrix:mode.inputMapping.sourceMatrix,sourceCellMatrix:mode.inputMapping.sourceCellMatrix,headers:mode.inputMapping.headers,signature:mode.inputMapping.signature,headerSignature:mode.inputMapping.headerSignature}});})()`;
  const originalData = await evaluate(client, protectedDataExpression);
  assert.deepEqual(await mappingTotals(), {
    0: '합계', 1: '', 2: '', 3: '-2', 4: '200', 5: '-200', 6: '', 7: ''
  }, 'closed source search must total all working rows, including numeric mapped columns');
  assert.deepEqual(await evaluate(client, `(() => ({panelHidden:document.querySelector('#inputListSearchPanel').hidden,expanded:document.querySelector('#inputListSearchButton').getAttribute('aria-expanded'),role:document.querySelector('#inputListSearchPanel').getAttribute('role'),controls:document.querySelector('#inputListSearchButton').getAttribute('aria-controls'),closeLabel:document.querySelector('#inputListSearchCloseButton').getAttribute('aria-label')}))()`), {
    panelHidden: true,
    expanded: 'false',
    role: 'search',
    controls: 'inputListSearchPanel',
    closeLabel: '입력목록 검색 닫기'
  });

  await click(client, '[data-mapping-select-row="source-1"]');
  await click(client, '[data-mapping-select-row="source-2"]');
  assert.deepEqual(await evaluate(client, `(() => {const all=document.querySelector('#mappingSelectAllRows');return {checked:all.checked,indeterminate:all.indeterminate,disabled:all.disabled};})()`), {
    checked: true, indeterminate: false, disabled: false
  }, 'source select-all state must be calculated from the visible source rows');
  await evaluate(client, `(() => {const scroll=document.querySelector('#tableScroll');scroll.scrollLeft=Math.min(80,Math.max(0,scroll.scrollWidth-scroll.clientWidth));scroll.scrollTop=Math.min(24,Math.max(0,scroll.scrollHeight-scroll.clientHeight));scroll.dispatchEvent(new Event('scroll'));const cell=document.querySelector('[data-mapping-row-id="source-1"] [data-mapping-column="0"] input');cell.focus({preventScroll:true});window.__searchScroll={left:scroll.scrollLeft,top:scroll.scrollTop};return true;})()`);
  assert.equal(await evaluate(client, `(() => {const event=new KeyboardEvent('keydown',{key:'F3',code:'F3',bubbles:true,cancelable:true});document.activeElement.dispatchEvent(event);return event.defaultPrevented;})()`), true,
    'F3 must prevent the browser default');
  await key(client, 'F3', 'F3', 114);
  await expr(client, `!document.querySelector('#inputListSearchPanel').hidden&&document.activeElement===document.querySelector('#gridSearchInput')`, 'F3 search focus');
  assert.deepEqual(await evaluate(client, `(() => {const scroll=document.querySelector('#tableScroll');return {left:scroll.scrollLeft,top:scroll.scrollTop};})()`), await evaluate(client, `window.__searchScroll`),
    'opening the search must preserve the worktable scroll position');
  assert.equal(await evaluate(client, `document.querySelectorAll('#mappingInputRows tr[data-mapping-default-row]').length`), 0,
    'an open empty query must omit the blank default work row');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  await expr(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length===1`, 'source-view filtered row');
  const sourceIds = await evaluate(client, `[...document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])')].map(row=>row.dataset.mappingRowId)`);
  assert.deepEqual(sourceIds, ['source-1']);
  assert.deepEqual(await mappingTotals(), {
    0: '합계', 1: '', 2: '', 3: '0', 4: '100', 5: '0', 6: '', 7: ''
  }, 'source search must total only the visible zero row across mapped numeric columns');
  await key(client, 'Escape', 'Escape', 27);
  await expr(client, `document.querySelector('#inputListSearchPanel').hidden`, 'selection-pruning Escape close');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('[data-mapping-select-row]')].map(input=>({rowId:input.dataset.mappingSelectRow,checked:input.checked}))`), [
    { rowId: 'source-1', checked: true },
    { rowId: 'source-2', checked: false },
    { rowId: '', checked: false }
  ], 'A/B selected then filtering to A must remove B permanently when Escape closes search');
  assert.deepEqual(await evaluate(client, `(() => {const all=document.querySelector('#mappingSelectAllRows');return {checked:all.checked,indeterminate:all.indeterminate,disabled:all.disabled};})()`), {
    checked: false, indeterminate: true, disabled: false
  }, 'source select-all indeterminate state must be calculated from the currently displayed rows');
  assert.deepEqual(await mappingTotals(), {
    0: '합계', 1: '', 2: '', 3: '-2', 4: '200', 5: '-200', 6: '', 7: ''
  }, 'source Escape must immediately restore whole-working-row totals');

  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-NEG');
  assert.deepEqual(await mappingTotals(), {
    0: '합계', 1: '', 2: '', 3: '-2', 4: '100', 5: '-200', 6: '', 7: ''
  }, 'source search must preserve negative visible totals');
  await click(client, '#inputListSearchCloseButton');

  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-ZERO');

  await click(client, '[data-table-view="input"]');
  await expr(client, `!document.querySelector('#voucherInputTable').hidden&&document.querySelector('#inputListSearchPanel').hidden`, 'view switch clears search');
  assert.deepEqual(await evaluate(client, `(() => ({value:document.querySelector('#gridSearchInput').value,expanded:document.querySelector('#inputListSearchButton').getAttribute('aria-expanded'),rows:document.querySelectorAll('#inputRows tr:not([data-default-row])').length,defaults:document.querySelectorAll('#inputRows tr[data-default-row]').length}))()`), {
    value: '', expanded: 'false', rows: 2, defaults: 1
  }, 'view switching must clear the query and restore every actual row plus the default row');

  await evaluate(client, `document.querySelector('[data-row-id="source-1"] [data-field="itemCode"]').focus({preventScroll:true})`);
  await key(client, 'F3', 'F3', 114);
  await expr(client, `document.activeElement===document.querySelector('#gridSearchInput')`, 'input-view F3 focus');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  const inputIds = await evaluate(client, `[...document.querySelectorAll('#inputRows tr:not([data-default-row])')].map(row=>row.dataset.rowId)`);
  assert.deepEqual(inputIds, sourceIds, 'source-column and configured-input views must expose the same row IDs');
  assert.deepEqual(await inputTotals(), { quantity: '0', amount: '0원' },
    'configured-input search must total only the visible zero row');
  await key(client, 'Escape', 'Escape', 27);
  await expr(client, `document.querySelector('#inputListSearchPanel').hidden&&document.activeElement?.matches('[data-row-id="source-1"] [data-field="itemCode"]')`, 'Escape clear, hide, and focus restoration');
  assert.equal(await evaluate(client, `document.querySelector('#gridSearchInput').value`), '');
  assert.deepEqual(await inputTotals(), { quantity: '-2', amount: '-200원' },
    'configured-input Escape must immediately restore whole-row totals');

  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-NEG');
  assert.deepEqual(await inputTotals(), { quantity: '-2', amount: '-200원' },
    'configured-input search must preserve negative visible totals');
  await click(client, '#inputListSearchCloseButton');

  await click(client, '#inputListSearchButton');
  await expr(client, `document.activeElement===document.querySelector('#gridSearchInput')`, 'button-open focus');
  await input(client, '#gridSearchInput', '직원');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('#inputRows tr:not([data-default-row])')].map(row=>row.dataset.rowId)`), ['source-1'],
    'employee description must be searchable');
  await click(client, '#inputListSearchCloseButton');
  await expr(client, `document.querySelector('#inputListSearchPanel').hidden&&document.querySelector('#gridSearchInput').value===''`, 'explicit close clears filter');

  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'NO-SUCH-INPUT-ROW');
  assert.deepEqual(await evaluate(client, `(() => {const all=document.querySelector('#selectAllRows');return {checked:all.checked,indeterminate:all.indeterminate,disabled:all.disabled};})()`), {
    checked: false, indeterminate: false, disabled: true
  }, 'input select-all must be disabled when the visible search result is empty');
  await key(client, 'Escape', 'Escape', 27);

  await key(client, 'F3', 'F3', 114);
  await input(client, '#gridSearchInput', 'CODE-NEG');
  await click(client, '.mode-tab[data-mode="purchase"]');
  await expr(client, `document.querySelector('.mode-tab[data-mode="purchase"]').getAttribute('aria-selected')==='true'`, 'voucher mode switch');
  assert.deepEqual(await evaluate(client, `(() => ({hidden:document.querySelector('#inputListSearchPanel').hidden,value:document.querySelector('#gridSearchInput').value,expanded:document.querySelector('#inputListSearchButton').getAttribute('aria-expanded')}))()`), {
    hidden: true, value: '', expanded: 'false'
  }, 'voucher-mode switching must never retain a hidden list filter');
  await click(client, '.mode-tab[data-mode="order"]');
  await expr(client, `document.querySelector('.mode-tab[data-mode="order"]').getAttribute('aria-selected')==='true'`, 'return to order mode');
  assert.equal(await evaluate(client, protectedDataExpression), originalData,
    'search, close, and view/mode transitions must not mutate persisted rows, working rows, source evidence, headers, or signatures');

  await restoreFixture('input');
  const editBefore = JSON.parse(await evaluate(client, protectedDataExpression));
  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  await input(client, '[data-row-id="source-1"] [data-field="quantity"]', '3');
  await expr(client, `document.querySelector('#totalQuantity').textContent.trim()==='3'&&document.querySelector('#totalAmount').textContent.trim()==='300원'`, 'visible totals after quantity edit');
  await input(client, '[data-row-id="source-1"] [data-field="unitPrice"]', '120');
  await expr(client, `document.querySelector('#totalAmount').textContent.trim()==='360원'`, 'visible totals after unit-price edit');
  const editAfter = JSON.parse(await evaluate(client, protectedDataExpression));
  assert.deepEqual(editAfter.rows.find(row => row.rowId === 'source-2'), editBefore.rows.find(row => row.rowId === 'source-2'),
    'editing a visible filtered row must not mutate the hidden voucher row');
  assert.deepEqual({
    sourceMatrix: editAfter.inputMapping.sourceMatrix,
    sourceCellMatrix: editAfter.inputMapping.sourceCellMatrix,
    signature: editAfter.inputMapping.signature,
    headerSignature: editAfter.inputMapping.headerSignature
  }, {
    sourceMatrix: editBefore.inputMapping.sourceMatrix,
    sourceCellMatrix: editBefore.inputMapping.sourceCellMatrix,
    signature: editBefore.inputMapping.signature,
    headerSignature: editBefore.inputMapping.headerSignature
  }, 'filtered editing must preserve immutable source evidence and signatures');

  await restoreFixture('input');
  const productBefore = JSON.parse(await evaluate(client, protectedDataExpression));
  await input(client, '[data-row-id][data-default-row="true"] [data-field="itemCode"]', 'PAIRCHOICE');
  await expr(client, `document.querySelectorAll('#inputRows tr:not([data-default-row])').length===3`, 'materialized product-choice row');
  const productRowId = await evaluate(client, `[...document.querySelectorAll('#inputRows tr:not([data-default-row])')].map(row=>row.dataset.rowId).find(rowId=>!['source-1','source-2'].includes(rowId))`);
  assert.ok(productRowId, 'the product-choice row must have a stable row ID');
  const productRowSelector = `[data-row-id="${productRowId}"]`;
  await input(client, `${productRowSelector} [data-field="quantity"]`, '2');
  await input(client, `${productRowSelector} [data-field="memo"]`, '상품합계');
  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', '상품합계');
  assert.deepEqual(await inputTotals(), { quantity: '2', amount: '0원' },
    'a filtered row without a selected product price must initially total zero amount');
  await evaluate(client, `(() => {const cell=document.querySelector(${JSON.stringify(`${productRowSelector} [data-field="itemCode"]`)});cell.focus();cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));return true;})()`);
  await expr(client, `Boolean(document.querySelector('.product-picker-dialog[open]'))`, 'filtered row product-master search');
  await click(client, '.product-picker-result');
  await expr(client, `!document.querySelector('.product-picker-dialog[open]')&&document.querySelector('#totalAmount').textContent.trim()==='200원'`, 'visible totals after product selection');
  assert.deepEqual(await inputTotals(), { quantity: '2', amount: '200원' },
    'product selection must refresh totals from the still-visible filtered row');
  assert.equal(await evaluate(client, `document.querySelectorAll('#inputRows tr:not([data-default-row])').length`), 1,
    'product selection must preserve the active visible-result set');
  const productAfter = JSON.parse(await evaluate(client, protectedDataExpression));
  assert.deepEqual(productAfter.rows.find(row => row.rowId === 'source-1'), productBefore.rows.find(row => row.rowId === 'source-1'),
    'filtered product selection must not mutate the first hidden voucher row');
  assert.deepEqual(productAfter.rows.find(row => row.rowId === 'source-2'), productBefore.rows.find(row => row.rowId === 'source-2'),
    'filtered product selection must not mutate the second hidden voucher row');
  assert.deepEqual({
    sourceMatrix: productAfter.inputMapping.sourceMatrix,
    sourceCellMatrix: productAfter.inputMapping.sourceCellMatrix,
    signature: productAfter.inputMapping.signature,
    headerSignature: productAfter.inputMapping.headerSignature
  }, {
    sourceMatrix: productBefore.inputMapping.sourceMatrix,
    sourceCellMatrix: productBefore.inputMapping.sourceCellMatrix,
    signature: productBefore.inputMapping.signature,
    headerSignature: productBefore.inputMapping.headerSignature
  }, 'filtered product selection must preserve immutable source evidence and signatures');

  await restoreFixture('source');
  const mappingEditBefore = JSON.parse(await evaluate(client, protectedDataExpression));
  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  await input(client, '[data-mapping-row-id="source-1"] [data-mapping-column="3"] input', '4');
  await expr(client, `document.querySelector('[data-mapping-total-column="3"]').textContent.trim()==='4'`, 'source visible quantity total after edit');
  await input(client, '[data-mapping-row-id="source-1"] [data-mapping-column="5"] input', '444');
  await expr(client, `document.querySelector('[data-mapping-total-column="5"]').textContent.trim()==='444'`, 'source visible supply total after edit');
  const mappingEditAfter = JSON.parse(await evaluate(client, protectedDataExpression));
  assert.deepEqual(mappingEditAfter.inputMapping.workingRows.find(row => row.rowId === 'source-2'), mappingEditBefore.inputMapping.workingRows.find(row => row.rowId === 'source-2'),
    'source editing a visible filtered row must not mutate the hidden working row');
  assert.deepEqual({
    sourceMatrix: mappingEditAfter.inputMapping.sourceMatrix,
    sourceCellMatrix: mappingEditAfter.inputMapping.sourceCellMatrix,
    signature: mappingEditAfter.inputMapping.signature,
    headerSignature: mappingEditAfter.inputMapping.headerSignature
  }, {
    sourceMatrix: mappingEditBefore.inputMapping.sourceMatrix,
    sourceCellMatrix: mappingEditBefore.inputMapping.sourceCellMatrix,
    signature: mappingEditBefore.inputMapping.signature,
    headerSignature: mappingEditBefore.inputMapping.headerSignature
  }, 'source filtered editing must preserve immutable source evidence and signatures');

  await restoreFixture('input');

  const firstItemCode = '[data-row-id="source-1"] [data-field="itemCode"]';
  await input(client, firstItemCode, 'PAIRCHOICE');
  await evaluate(client, `(() => {const cell=document.querySelector(${JSON.stringify(firstItemCode)});cell.focus();cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));return true;})()`);
  await expr(client, `Boolean(document.querySelector('.product-picker-dialog[open]'))`, 'item-code Enter product-master search');
  const dialogFocusBefore = await evaluate(client, `document.activeElement?.outerHTML`);
  await key(client, 'F3', 'F3', 114);
  await wait(100);
  assert.deepEqual(await evaluate(client, `(() => ({dialogOpen:Boolean(document.querySelector('.product-picker-dialog[open]')),searchHidden:document.querySelector('#inputListSearchPanel').hidden,focusInside:Boolean(document.activeElement?.closest('.product-picker-dialog')),toast:document.querySelector('#toast').textContent}))()`), {
    dialogOpen: true,
    searchHidden: true,
    focusInside: true,
    toast: '열려 있는 창을 닫은 뒤 입력목록 검색을 사용할 수 있습니다.'
  }, `modal keyboard context must win over F3 without moving focus behind it; before=${dialogFocusBefore}`);
  await key(client, 'Escape', 'Escape', 27);
  await expr(client, `!document.querySelector('.product-picker-dialog[open]')`, 'product dialog Escape');
  await evaluate(client, `document.querySelector('#estimateLibraryView').classList.contains('is-open')&&document.querySelector('#relatedPanelCloseButton').click()`);
  await wait(4_000);

  await restoreFixture('source');
  const sourceDeleteBefore = JSON.parse(await evaluate(client, protectedDataExpression));
  await click(client, '[data-mapping-select-row="source-1"]');
  await click(client, '[data-mapping-select-row="source-2"]');
  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  await expr(client, `document.querySelectorAll('#mappingInputRows tr:not([data-mapping-default-row])').length===1`, 'source delete search result');
  await click(client, '#deleteSelectedRows');
  await expr(client, `JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.inputMapping.workingRows.length===1`, 'source visible-only deletion');
  const sourceDeleteAfter = JSON.parse(await evaluate(client, protectedDataExpression));
  assert.deepEqual(sourceDeleteAfter.rows.map(row => row.rowId), ['source-2'],
    'source view deletion must remove only the selected visible search result');
  assert.deepEqual(sourceDeleteAfter.rows[0], sourceDeleteBefore.rows.find(row => row.rowId === 'source-2'),
    'source view deletion must not mutate the hidden voucher row');
  assert.deepEqual(sourceDeleteAfter.inputMapping.workingRows[0], sourceDeleteBefore.inputMapping.workingRows.find(row => row.rowId === 'source-2'),
    'source view deletion must not delete or mutate the hidden working row');
  assert.deepEqual({
    sourceMatrix: sourceDeleteAfter.inputMapping.sourceMatrix,
    sourceCellMatrix: sourceDeleteAfter.inputMapping.sourceCellMatrix,
    headers: sourceDeleteAfter.inputMapping.headers,
    signature: sourceDeleteAfter.inputMapping.signature,
    headerSignature: sourceDeleteAfter.inputMapping.headerSignature
  }, {
    sourceMatrix: sourceDeleteBefore.inputMapping.sourceMatrix,
    sourceCellMatrix: sourceDeleteBefore.inputMapping.sourceCellMatrix,
    headers: sourceDeleteBefore.inputMapping.headers,
    signature: sourceDeleteBefore.inputMapping.signature,
    headerSignature: sourceDeleteBefore.inputMapping.headerSignature
  }, 'source view visible-only deletion must preserve immutable source evidence and signatures');

  await restoreFixture('input');
  const inputDeleteBefore = JSON.parse(await evaluate(client, protectedDataExpression));
  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  await click(client, '#selectAllRows');
  assert.deepEqual(await evaluate(client, `(() => {const all=document.querySelector('#selectAllRows');return {checked:all.checked,indeterminate:all.indeterminate,disabled:all.disabled,visible:[...document.querySelectorAll('#inputRows [data-select-row]:checked')].map(input=>input.dataset.selectRow)};})()`), {
    checked: true, indeterminate: false, disabled: false, visible: ['source-1']
  }, 'input view select-all must select and calculate state from the one visible result');
  await click(client, '#deleteSelectedRows');
  await expr(client, `JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.rows.length===1`, 'input visible-only deletion');
  const inputDeleteAfter = JSON.parse(await evaluate(client, protectedDataExpression));
  assert.deepEqual(inputDeleteAfter.rows, [inputDeleteBefore.rows.find(row => row.rowId === 'source-2')],
    'input view visible select-all deletion must leave the hidden row unchanged');
  assert.deepEqual(inputDeleteAfter.inputMapping.workingRows, [inputDeleteBefore.inputMapping.workingRows.find(row => row.rowId === 'source-2')],
    'input view visible select-all deletion must leave the hidden working row unchanged');

  await restoreFixture('input');
  const priceBefore = JSON.parse(await evaluate(client, protectedDataExpression));
  await click(client, '#inputListSearchButton');
  await input(client, '#gridSearchInput', 'CODE-ZERO');
  await click(client, '#selectAllRows');
  await input(client, '#bulkUnitPriceInput', '321');
  await click(client, '#applyBulkUnitPriceButton');
  await expr(client, `Number(JSON.parse(localStorage.getItem(window.SMART_INPUT_CONTRACT.DRAFT_STORAGE_KEY)).modes.order.rows.find(row=>row.rowId==='source-1')?.unitPrice)===321`, 'visible-only unit-price application');
  const priceAfter = JSON.parse(await evaluate(client, protectedDataExpression));
  assert.equal(Number(priceAfter.rows.find(row => row.rowId === 'source-1').unitPrice), 321,
    'selected visible search result must receive the bulk unit price');
  assert.deepEqual(priceAfter.rows.find(row => row.rowId === 'source-2'), priceBefore.rows.find(row => row.rowId === 'source-2'),
    'bulk unit price must not mutate the hidden voucher row');
  assert.deepEqual(priceAfter.inputMapping.workingRows.find(row => row.rowId === 'source-2'), priceBefore.inputMapping.workingRows.find(row => row.rowId === 'source-2'),
    'bulk unit price must not mutate the hidden working row');
  assert.deepEqual({
    sourceMatrix: priceAfter.inputMapping.sourceMatrix,
    sourceCellMatrix: priceAfter.inputMapping.sourceCellMatrix,
    headers: priceAfter.inputMapping.headers,
    signature: priceAfter.inputMapping.signature,
    headerSignature: priceAfter.inputMapping.headerSignature
  }, {
    sourceMatrix: priceBefore.inputMapping.sourceMatrix,
    sourceCellMatrix: priceBefore.inputMapping.sourceCellMatrix,
    headers: priceBefore.inputMapping.headers,
    signature: priceBefore.inputMapping.signature,
    headerSignature: priceBefore.inputMapping.headerSignature
  }, 'visible-only bulk price must preserve source evidence and signatures');
  await click(client, '#inputListSearchCloseButton');
  assert.equal(await evaluate(client, `document.querySelector('[data-row-id="source-2"] [data-select-row]').checked`), false,
    'explicit close must not revive hidden selection');

  const screenshots = [];
  for (const width of [1920, 1440, 390]) {
    for (const theme of ['light', 'dark']) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
      await evaluate(client, `(() => {const theme=${JSON.stringify(theme)};document.documentElement.dataset.nexusUiTheme=theme;document.documentElement.dataset.nexusTheme=theme;document.documentElement.style.colorScheme=theme;window.dispatchEvent(new CustomEvent('nexus-ui:theme-change',{detail:{theme}}));return true;})()`);
      const triggerHeight = await evaluate(client, `document.querySelector('#inputListSearchButton').getBoundingClientRect().height`);
      await click(client, '#inputListSearchButton');
      await expr(client, `document.activeElement===document.querySelector('#gridSearchInput')`, `${width} ${theme} search focus`);
      await input(client, '#gridSearchInput', width === 390 ? '-2' : '사과');
      const layout = await evaluate(client, `(() => {const button=document.querySelector('#inputListSearchButton').getBoundingClientRect();const panel=document.querySelector('#inputListSearchPanel').getBoundingClientRect();return {pageWidth:document.documentElement.scrollWidth,viewportWidth:document.documentElement.clientWidth,buttonHeight:button.height,panelHeight:panel.height,buttonRight:button.right,panelRight:panel.right,theme:document.documentElement.dataset.nexusUiTheme,active:document.activeElement?.id};})()`);
      assert.equal(layout.theme, theme);
      assert.equal(layout.active, 'gridSearchInput');
      assert.ok(triggerHeight >= (width === 390 ? 40 : 36), `${width} ${theme}: compact trigger target height (${triggerHeight})`);
      assert.ok(layout.panelHeight >= (width === 390 ? 40 : 36), `${width} ${theme}: search panel target height (${layout.panelHeight})`);
      assert.ok(layout.buttonRight <= layout.pageWidth + 1 && layout.panelRight <= layout.pageWidth + 1, `${width} ${theme}: controls stay within the document (${JSON.stringify(layout)})`);
      screenshots.push(await capture(client, `smartinput-input-list-search-${width}-${theme}.png`));
      await key(client, 'Escape', 'Escape', 27);
      await expr(client, `document.querySelector('#inputListSearchPanel').hidden`, `${width} ${theme} Escape close`);
    }
  }

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({
    status: 'ok',
    f3: 'ordinary focus opens input-list search and prevents browser default; open modal retains ownership',
    enter: 'itemCode Enter still opens product-master search',
    viewports: ['1920-light', '1920-dark', '1440-light', '1440-dark', '390-light', '390-dark'],
    screenshots,
    consoleErrors: consoleErrors.length,
    runtimeExceptions: exceptions.length
  }, null, 2));
} finally {
  client?.close();
  browser?.kill();
  await new Promise(resolveClose => server.close(resolveClose));
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (_) { /* Browser can release its profile after process exit on Windows. */ }
}
