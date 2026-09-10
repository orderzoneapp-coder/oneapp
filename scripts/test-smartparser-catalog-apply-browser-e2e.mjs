#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'SmartParser.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const file = normalize(resolve(root, relative));
  if (file !== root && !file.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end('Not found');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream' });
  response.end(readFileSync(file));
});
const listen = () => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address())); });
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 25_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const browserPath = () => [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean).find(existsSync) || '';

class Cdp {
  constructor(url) { this.url = url; this.socket = null; this.id = 0; this.pending = new Map(); this.events = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        return message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      }
      (this.events.get(message.method) || []).forEach((listener) => listener(message.params));
    });
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((resolveEvent, reject) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) || []).filter((item) => item !== listener));
        resolveEvent(params);
      };
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 25_000);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { this.socket?.close(); }
}

const evaluate = (client, expression) => client.send('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true, userGesture: true,
}).then((result) => {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
});
const navigate = async (client, url) => {
  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url });
  await loaded;
  await waitFor(() => evaluate(client, `document.readyState === 'complete'`), 'page ready');
};

let browserProcess;
let client;
let address;
const profile = join(tmpdir(), `oneapp-smartparser-catalog-${Date.now()}`);
try {
  address = await listen();
  const executable = browserPath();
  assert.ok(executable, 'Chrome/Edge is required for SmartParser catalog browser E2E');
  mkdirSync(profile, { recursive: true });
  browserProcess = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) ? readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] : '', 'browser debug port');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).find((item) => item.type === 'page') : null;
  }, 'browser target');
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const runtimeErrors = [];
  client.on('Runtime.exceptionThrown', (event) => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'runtime exception'));
  const origin = `http://127.0.0.1:${address.port}`;

  await navigate(client, `${origin}/SmartParser.html`);
  await waitFor(() => evaluate(client, `window.__SMART_PARSER_RENDERED__ === true`), 'SmartParser initial render');
  await evaluate(client, `(async () => {
    localStorage.clear();
    localStorage.setItem('merchHistory_v870', '[]');
    localStorage.setItem('merchStoppedProducts_v2', '{}');
    localStorage.setItem('pendingShopStatus', '[]');
    const state = await ONEAPP.STORAGE.readMasterState();
    await ONEAPP.STORAGE.commitMasterStateOrThrow({
      A: { 코드:'A', 품목명:'상품 A', 규격:'1kg', 단위:'BOX', 입고가:1000, 카탈로그:'KEEP, CAT', 판매여부:1 },
      B: { 코드:'B', 품목명:'기존 B', 규격:'2kg', 단위:'EA', 입고가:2000, 카탈로그:'CAT', 판매여부:1 }
    }, { expectedRevision: state.revision });
    return true;
  })()`);
  await navigate(client, `${origin}/SmartParser.html`);
  await waitFor(() => evaluate(client, `window.__SMART_PARSER_RENDERED__ === true && [...document.querySelectorAll('[data-nexus-pane="reference"] div')].some(node => node.textContent.trim()==='상품 Snapshot' && node.nextElementSibling?.textContent.trim()==='READY')`), 'ready product snapshot');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('[data-nexus-workspace="smart-parser"] > [data-nexus-pane]')].map(element=>element.dataset.nexusPane)`), ['reference', 'work', 'result']);
  assert.equal(await evaluate(client, `document.querySelector('[data-nexus-app-header="smart-parser"]')?.offsetHeight >= 56`), true);
  await evaluate(client, `document.querySelector('[data-nexus-pane="result"] button[aria-label="결과 패널 닫기"]').click()`);
  assert.deepEqual(await evaluate(client, `({closed:!document.querySelector('[data-nexus-pane="result"]'), reopen:!!document.querySelector('[data-nexus-result-reopen="smart-parser"]'), catalog:document.body.textContent.includes('현재 카탈로그')})`), { closed:true, reopen:true, catalog:true });
  await evaluate(client, `document.querySelector('[data-nexus-result-reopen="smart-parser"]').click()`);
  assert.equal(await evaluate(client, `!!document.querySelector('[data-nexus-pane="result"]')`), true);

  const modalState = await evaluate(client, `(async () => {
    const host = document.createElement('div');
    host.id = 'catalog-exclusion-contract-test';
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    root.render(React.createElement(ExcludeOptionModal, { count:2, onClose:()=>{}, onConfirm:async()=>true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const checkbox = host.querySelector('input[type="checkbox"]');
    const select = host.querySelector('select');
    const before = { text:host.textContent, disabled:select.disabled, reasons:[...select.options].map(option => option.value) };
    checkbox.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const after = { checked:checkbox.checked, disabled:select.disabled };
    root.unmount(); host.remove();
    return { before, after };
  })()`);
  assert.ok(modalState.before.text.includes('판매정지 함께 적용'));
  assert.deepEqual(modalState.before.reasons, ['품절', '공급중단', '판매종료']);
  assert.equal(modalState.before.disabled, true);
  assert.deepEqual(modalState.after, { checked: true, disabled: false });

  await evaluate(client, `[...document.querySelectorAll('button')].find(element => element.textContent.includes('새로 만들기')).click()`);
  await waitFor(() => evaluate(client, `document.querySelector('input[placeholder="새 카탈로그 이름"]') !== null`), 'new catalog input');
  await evaluate(client, `(() => {
    const nameInput = document.querySelector('input[placeholder="새 카탈로그 이름"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameInput, 'FLOW');
    nameInput.dispatchEvent(new Event('input', { bubbles:true }));
    nameInput.dispatchEvent(new Event('change', { bubbles:true }));
    const textarea = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '미연결 하나 / 1kg\\n1,000원\\n미연결 둘 / 2kg\\n2,000원');
    textarea.dispatchEvent(new Event('input', { bubbles:true }));
    textarea.dispatchEvent(new Event('change', { bubbles:true }));
    const manual = [...document.querySelectorAll('label')].find(label => label.textContent.includes('강제 수동 연결 모드')).querySelector('input[type="checkbox"]');
    manual.click();
    return true;
  })()`);
  await waitFor(() => evaluate(client, `[...document.querySelectorAll('label')].find(label => label.textContent.includes('강제 수동 연결 모드')).querySelector('input[type="checkbox"]').checked`), 'manual mode checked');
  await evaluate(client, `[...document.querySelectorAll('button')].find(element => element.textContent.includes('분석 시작')).click()`);
  await waitFor(() => evaluate(client, `document.querySelector('[data-parser-link-scroll="unmatched-items"]')?.textContent.includes('미연결 하나')`), 'manual unmatched link screen');

  const connectOne = async (masterName, expectedRemaining) => {
    await evaluate(client, `(() => {
      const right = document.querySelector('[data-parser-link-scroll="unmatched-items"]');
      const left = document.querySelector('[data-parser-link-scroll="master-results"]');
      Object.defineProperty(right, 'scrollTop', { value:137, writable:true, configurable:true });
      Object.defineProperty(left, 'scrollTop', { value:83, writable:true, configurable:true });
      right.querySelector('tbody tr').click();
      const search = document.querySelector('input[placeholder="품명/상품코드/품목코드 검색"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, ${JSON.stringify(masterName)});
      search.dispatchEvent(new Event('input', { bubbles:true }));
      search.dispatchEvent(new Event('change', { bubbles:true }));
      return true;
    })()`);
    await waitFor(() => evaluate(client, `document.querySelector('[data-parser-link-scroll="master-results"] tbody button')?.textContent.includes('연결')`), `${masterName} link candidate`);
    await evaluate(client, `document.querySelector('[data-parser-link-scroll="master-results"] tbody button').click()`);
    await waitFor(() => evaluate(client, `document.body.textContent.includes(${JSON.stringify(expectedRemaining === 0 ? '모든 미연결 항목의 연결이 완료되었습니다' : `남은 미연결 ${expectedRemaining}건`)})`), `${masterName} link completion`);
    return evaluate(client, `(() => {
      const unmatchedButton = [...document.querySelectorAll('button')].find(button => button.textContent.includes('불일치'));
      const search = document.querySelector('input[placeholder="품명/상품코드/품목코드 검색"]');
      const right = document.querySelector('[data-parser-link-scroll="unmatched-items"]');
      const left = document.querySelector('[data-parser-link-scroll="master-results"]');
      return {
        tabStayed:unmatchedButton.className.includes('bg-white'),
        search:search.value,
        rightScroll:right.scrollTop,
        leftScroll:left.scrollTop,
        empty:right.textContent.includes('대기중인 데이터가 없습니다'),
        reviewOpened:document.body.textContent.includes('관리자 즉시 저장 검토')
      };
    })()`);
  };
  const firstLinkState = await connectOne('상품 A', 1);
  assert.deepEqual(firstLinkState, { tabStayed:true, search:'상품 A', rightScroll:137, leftScroll:83, empty:false, reviewOpened:false });
  const secondLinkState = await connectOne('상품 B', 0);
  assert.deepEqual(secondLinkState, { tabStayed:true, search:'상품 B', rightScroll:137, leftScroll:83, empty:true, reviewOpened:false });

  const applyReceipt = await evaluate(client, `(async () => {
    const read = await import('./reference-data/product-master-read-adapter.js');
    const analysis = await import('./smartparser/analysis-result-contract.js');
    const apply = await import('./smartparser/catalog-apply-command-adapter.js');
    const snapshot = await read.getProductSnapshot();
    const result = analysis.createSmartParserAnalysisResult({
      analysisId:'BROWSER-APPLY', idempotencyKey:'BROWSER-APPLY-IDEM', createdAt:'2026-09-10T05:00:00.000Z',
      sourceMetadata:{ catalog:'CAT', documentDisplayName:'CAT', catalogWarehouse:'01', updateTextData:true, workflow:'ANALYSIS_REVIEW' },
      baseProductSnapshot:snapshot,
      rows:[{
        rowId:'update-b',
        match:{ status:'🟢 일치', productCode:'B', normalizedProductCode:'B', isNewProduct:false, candidates:[] },
        proposedChanges:[
          { field:'품목명', beforeValue:'기존 B', proposedValue:'검토 B', reason:'체크된 검토 상품명' },
          { field:'카탈로그', beforeValue:'CAT', proposedValue:'CAT, NEW', reason:'카탈로그 업데이트' }
        ],
        decision:{ selected:true, excluded:false, blocked:false }
      }]
    });
    const command = apply.createSmartParserCatalogApplyCommand(result, { action:'APPLY_ANALYSIS', operationId:'BROWSER-APPLY-OP', requestedAt:'2026-09-10T05:10:00.000Z' });
    return apply.commitSmartParserCatalogApply(command);
  })()`);
  assert.equal(applyReceipt.status, 'APPLIED');

  const checkboxPlan = await evaluate(client, `(async () => {
    const snapshot = await (await import('./reference-data/product-master-read-adapter.js')).getProductSnapshot();
    const master = Object.fromEntries(snapshot.data.products.map(item => [item.코드, item]));
    const row = { _id:'checkbox-b', _matchCode:'B', _matchStatus:'🟢 일치', _apply:true, 품목명:'체크 상품명', 규격:'9kg', 단위:'BOX', finalData:{} };
    const checked = buildSmartParserAnalysisPlan({ masterProducts:master, rows:[row], catalogLabel:'NEW2', updateTextData:true });
    const unchecked = buildSmartParserAnalysisPlan({ masterProducts:master, rows:[row], catalogLabel:'NEW2', updateTextData:false });
    return {
      checkedFields:checked.rows[0].proposedChanges.map(change => change.field),
      uncheckedFields:unchecked.rows[0].proposedChanges.map(change => change.field)
    };
  })()`);
  assert.ok(checkboxPlan.checkedFields.includes('품목명'));
  assert.equal(checkboxPlan.uncheckedFields.includes('품목명'), false);
  assert.equal(checkboxPlan.uncheckedFields.includes('규격'), false);
  assert.equal(checkboxPlan.uncheckedFields.includes('단위'), false);

  const uncheckedReceipt = await evaluate(client, `(async () => {
    const read = await import('./reference-data/product-master-read-adapter.js');
    const apply = await import('./smartparser/catalog-apply-command-adapter.js');
    const snapshot = await read.getProductSnapshot();
    const master = Object.fromEntries(snapshot.data.products.map(item => [item.코드, item]));
    const row = { _id:'unchecked-b', _matchCode:'B', _matchStatus:'🟢 일치', _apply:true, 품목명:'저장하면 안 되는 상품명', 규격:'99kg', 단위:'BOX', finalData:{} };
    const prepared = await createSmartParserFinalAnalysis({
      productSnapshot:snapshot, rows:[row], masterProducts:master, catalogLabel:'NEW2', catalogWarehouse:'01', marginRules:[], updateTextData:false,
      workflow:'ANALYSIS_REVIEW', identity:{ analysisId:'BROWSER-UNCHECKED', idempotencyKey:'BROWSER-UNCHECKED-IDEM', createdAt:'2026-09-10T05:20:00.000Z' }
    });
    const command = apply.createSmartParserCatalogApplyCommand(prepared.result, {
      action:'APPLY_ANALYSIS', operationId:'BROWSER-UNCHECKED-OP', requestedAt:'2026-09-10T05:30:00.000Z'
    });
    const receipt = await apply.commitSmartParserCatalogApply(command);
    const saved = (await read.getProductSnapshot()).data.products.find(item => item.코드 === 'B');
    return { status:receipt.status, fields:command.items[0].changes.map(change => change.field), name:saved.품목명, spec:saved.규격, unit:saved.단위, catalog:saved.카탈로그 };
  })()`);
  assert.equal(uncheckedReceipt.status, 'APPLIED');
  assert.equal(uncheckedReceipt.fields.includes('품목명'), false);
  assert.equal(uncheckedReceipt.name, '검토 B');
  assert.equal(uncheckedReceipt.spec, '2kg');
  assert.equal(uncheckedReceipt.unit, 'EA');
  assert.equal(uncheckedReceipt.catalog, 'CAT, NEW, NEW2');

  const excludeReceipt = await evaluate(client, `(async () => {
    const read = await import('./reference-data/product-master-read-adapter.js');
    const apply = await import('./smartparser/catalog-apply-command-adapter.js');
    const snapshot = await read.getProductSnapshot();
    const master = Object.fromEntries(snapshot.data.products.map(item => [item.코드, item]));
    const prepared = await createSmartParserFinalAnalysis({
      productSnapshot:snapshot, masterProducts:master, catalogLabel:'CAT', catalogWarehouse:'01', marginRules:[],
      workflow:'CATALOG_SUPPLY_STOP_REVIEW', catalogRemovalCodes:['A'],
      identity:{ analysisId:'BROWSER-EXCLUDE', idempotencyKey:'BROWSER-EXCLUDE-IDEM', createdAt:'2026-09-10T06:00:00.000Z' }
    });
    const command = apply.createSmartParserCatalogApplyCommand(prepared.result, {
      action:'EXCLUDE_CATALOG', operationId:'BROWSER-EXCLUDE-OP', requestedAt:'2026-09-10T06:10:00.000Z', applyStop:true, stopReason:'공급중단'
    });
    return apply.commitSmartParserCatalogApply(command);
  })()`);
  assert.equal(excludeReceipt.status, 'APPLIED');

  const stored = await evaluate(client, `(async () => {
    const state = await ONEAPP.STORAGE.readMasterState(['merchStoppedProducts_v2','pending_shop_status']);
    const byCode = Object.fromEntries(state.items.map(item => [item.코드, item]));
    const history = JSON.parse(localStorage.getItem('merchHistory_v870') || '[]');
    return {
      a:byCode.A, b:byCode.B,
      stop:state.extraStoreEntries.merchStoppedProducts_v2.A,
      pending:state.extraStoreEntries.pending_shop_status.find(item => item.code === 'A'),
      historyTypes:history.map(item => item.actionType)
    };
  })()`);
  assert.equal(stored.b.품목명, '검토 B');
  assert.equal(stored.b.카탈로그, 'CAT, NEW, NEW2');
  assert.equal(stored.a.카탈로그, 'KEEP');
  assert.equal(stored.a.판매여부, 0);
  assert.equal(stored.stop.reason, '공급중단');
  assert.equal(stored.pending.reason, '공급중단');
  assert.ok(stored.historyTypes.includes('smartparser_catalog_apply'));
  assert.ok(stored.historyTypes.includes('smartparser_catalog_exclude'));
  assert.ok(stored.historyTypes.includes('smartparser_catalog_exclude_stop'));
  assert.equal(runtimeErrors.length, 0, `browser runtime errors: ${runtimeErrors.join('; ')}`);

  console.log('PASS SmartParser browser E2E: render, continuous link tab/search/scroll retention, no automatic navigation, exclusion modal, checked/unchecked name policy, immediate catalog apply, catalog-only exclusion, optional stop reason, actual history.');
} finally {
  client?.close();
  browserProcess?.kill();
  server.close();
}
