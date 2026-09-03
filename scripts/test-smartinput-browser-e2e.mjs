#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const logo of ['logo-light.png', 'logo-dark.png']) {
  const bytes = readFileSync(join(root, 'nexus', 'assets', 'brand', 'apps', 'smart-input', logo));
  assert.equal(bytes[25], 6, `${logo} must keep an RGBA alpha channel`);
}
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-0a-e2e-'));
const screenshotDir = resolve(process.env.SMARTINPUT_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-0a-screenshots'));
const baselineEvidenceFile = process.env.SMARTINPUT_BASELINE_EVIDENCE_FILE
  ? resolve(process.env.SMARTINPUT_BASELINE_EVIDENCE_FILE)
  : '';
mkdirSync(screenshotDir, { recursive: true });
if (baselineEvidenceFile) mkdirSync(dirname(baselineEvidenceFile), { recursive: true });
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const localServerRequests = [];
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  localServerRequests.push({ method: request.method, pathname });
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
const listen = () => new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});
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
  once(method, timeout = 20_000) {
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
const click = (client, selector) => evaluate(client, `(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const typeWithoutBlur = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return element.value;})()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
};

let browser;
let client;
const networkRequests = [];
const flowTimings = {};
const officialSaveEntryEvidence = [];
const baselineScreenshots = [];
try {
  const address = await listen();
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
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeFetch = globalThis.fetch?.bind(globalThis);
    if (!nativeFetch) return;
    globalThis.fetch = (resource, options = {}) => {
      const url = String(typeof resource === 'string' ? resource : resource?.url || '');
      const method = String(options.method || resource?.method || 'GET').toUpperCase();
      let external = false;
      try { external = new URL(url, location.href).origin !== ${JSON.stringify(`http://127.0.0.1:${address.port}`)}; } catch { external = true; }
      if (external && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        let payload = {};
        try { payload = JSON.parse(options.body || '{}'); } catch {}
        const record = {
          method, url, action: String(payload.action || ''), companyId: String(payload.companyId || ''),
          changeCount: Array.isArray(payload.changes) ? payload.changes.length : 0,
          blockedAt: new Date().toISOString()
        };
        try {
          const key = 'oneapp.smartinput.e2e.blockedExternalMutations';
          const history = JSON.parse(localStorage.getItem(key) || '[]');
          localStorage.setItem(key, JSON.stringify([...history, record]));
        } catch {}
        return Promise.resolve({ ok: false, status: 599, json: async () => ({ status: 'error', code: 'E2E_EXTERNAL_MUTATION_BLOCKED' }) });
      }
      return nativeFetch(resource, options);
    };
  })();` });
  client.on('Page.javascriptDialogOpening', () => { void client.send('Page.handleJavaScriptDialog', { accept: true }); });
  const exceptions = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });
  client.on('Network.requestWillBeSent', event => networkRequests.push({
    method: event.request?.method || '',
    url: event.request?.url || '',
    type: event.type || ''
  }));

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/fixture.html` });
  await loaded;
  await evaluate(client, `localStorage.setItem('merchMaster_v870', JSON.stringify([{productId:'P-MASTER-1',itemCode:'MASTER-1',itemName:'마스터 사과',specification:'10kg',finalUnit:'BOX',outPrice:3200,status:'ACTIVE'},{productId:'P-MASTER-2',itemCode:'MASTER-2',itemName:'마스터 포도',specification:'5kg',finalUnit:'EA',outPrice:1800,status:'ACTIVE'}]));true`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  try {
    await expr(client, `Boolean(document.querySelector('.nexus-ui-header'))&&Boolean(document.querySelector('#inputRows tr'))`, 'restored SmartInput shell');
  } catch (error) {
    const diagnostic = await evaluate(client, `({title:document.title,body:document.body?.innerText?.slice(0,800),rows:document.querySelectorAll('#inputRows tr').length,header:Boolean(document.querySelector('.nexus-ui-header')),scripts:[...document.scripts].map(script=>script.src),html:document.documentElement.outerHTML.slice(0,500)})`);
    throw new Error(`${error.message} · ${JSON.stringify(diagnostic)} · ${exceptions.join(' | ')}`);
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await wait(260);
  const metrics = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};return {title:document.title,global:q('.nexus-ui-header'),app:q('.app-bar'),parser:q('.parser-card'),resizer:q('#photoResizer'),workbench:q('.workbench'),grid:q('.grid-card'),related:q('.related-panel'),columns:getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns};})()`);
  console.log('SmartInput desktop metrics', metrics);
  assert.equal(metrics.title, '스마트입력 - NEXUS');
  assert.ok(metrics.parser.width >= 330 && metrics.workbench.width > metrics.parser.width, 'desktop must preserve the independent parser and larger work table');
  assert.ok(metrics.resizer.width > 0 && metrics.related.width >= 220, 'desktop must preserve the parser resizer and right estimate library');
  assert.ok(Math.abs(metrics.grid.width - metrics.workbench.width) <= 2, 'search/edit controls and the grid must share the center work card');
  assert.ok(metrics.app.height >= 55 && metrics.app.height <= 58, 'desktop app header must follow the 56px common AppHeader contract');
  await evaluate(client, `document.querySelector('.workspace').classList.add('has-photo-source');true`);
  for (const width of [1788, 1440, 1366, 1280]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 902, deviceScaleFactor: 1, mobile: false });
    await wait(80);
    const responsive = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};return {width:innerWidth,mobile:matchMedia('(max-width: 820px)').matches,parser:q('.parser-card'),resizer:q('#photoResizer'),workbench:q('.workbench'),table:q('#tableScroll'),columns:getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns};})()`);
    assert.equal(responsive.mobile, false, `${width}px desktop must not activate mobile rules`);
    assert.ok(responsive.parser.width >= 330 && responsive.resizer.width > 0, `${width}px desktop must keep the parser and resizer visible`);
    assert.ok(responsive.workbench.x > responsive.parser.right && Math.abs(responsive.workbench.y - responsive.parser.y) <= 2, `${width}px desktop must keep parser and table side by side`);
    assert.ok(responsive.table.width > 0 && responsive.table.height > 0, `${width}px desktop must keep the Excel table visible`);
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await wait(260);
  await evaluate(client, `document.querySelector('.workspace').classList.remove('has-photo-source');true`);
  const visualZones = await evaluate(client, `(() => {const search=document.querySelector('#inputRows .product-code-search-cell');const excel=search?.nextElementSibling;const logo=document.querySelector('.brand__logo--light');const brand=document.querySelector('.brand').getBoundingClientRect();const appInner=document.querySelector('.app-bar__inner').getBoundingClientRect();const voucher=document.querySelector('.app-voucher-switcher').getBoundingClientRect();const customer=document.querySelector('.header-customer-group').getBoundingClientRect();const header=document.querySelector('.header-fields');const headerBounds=header.getBoundingClientRect();return {removeCell:Boolean(document.querySelector('#inputRows [data-remove-row]')),nativeSearchCells:document.querySelectorAll('#inputRows input[type="search"]').length,standaloneProductSearchColumn:Boolean(document.querySelector('#voucherInputTable [data-column="productSearch"]')),firstProductColumn:document.querySelector('#voucherInputTable thead th[data-column]')?.dataset.column,customerRegisterCoachmark:document.body.innerText.includes('거래처관리에서 등록'),searchBackground:getComputedStyle(search).backgroundColor,excelBackground:getComputedStyle(excel).backgroundColor,searchDivider:getComputedStyle(search).borderRightWidth,logoComplete:logo?.complete,logoWidth:logo?.naturalWidth,brandHeight:brand.height,brandLeftGap:Math.abs(appInner.left-brand.left),voucherCustomerGap:customer.left-voucher.right,customerHeaderGap:headerBounds.left-customer.right,headerDivider:getComputedStyle(header).borderLeftWidth,customerInHeader:Boolean(document.querySelector('.app-bar .header-customer-group #customerInput')),headerHasReferenceCounts:/상품\s[\d,]+건\s*·\s*거래처\s[\d,]+건/.test(document.querySelector('.app-bar').innerText),coachmark:Boolean(document.querySelector('.reference-overview__coachmark')),referenceBeforeSettings:document.querySelector('#referenceOverview')?.nextElementSibling?.id==='settingsButton',legacyButtons:[...document.querySelectorAll('#draftListButton,#saveDraftButton,#catalogSaveButton,#uploadTemplateButton')].length,completeText:document.querySelector('#completeButton')?.textContent.trim(),completeInFooter:Boolean(document.querySelector('.voucher-footer-actions #completeButton')),deliveryCardVisible:getComputedStyle(document.querySelector('.voucher-footer-actions .delivery-card')).display!=='none',shareText:document.querySelector('#estimateNoticeButton')?.textContent.trim(),excelText:document.querySelector('#estimateExcelButton')?.textContent.trim(),outputsInFooter:Boolean(document.querySelector('.voucher-footer-actions #estimateOutputActions')),sequence:document.querySelector('#tableScroll thead th:first-child')?.textContent.trim(),resetInTopBar:Boolean(document.querySelector('.work-action-bar>#deliveryPolicyHint')&&document.querySelector('.work-action-bar #resetDraftButton')),voucherContextVisible:!document.querySelector('#voucherContextView').hidden,voucherContextTitle:document.querySelector('#voucherContextTitle').textContent.trim(),voucherContextStatus:document.querySelector('#voucherContextDelivery').textContent.trim(),estimateHeadingHidden:document.querySelector('#estimateLibraryHeading').hidden,estimateListsHidden:document.querySelector('#catalogPickerList').hidden&&document.querySelector('#linkedEstimateList').hidden};})()`);
  assert.equal(visualZones.removeCell, false, 'Excel rows must not render an in-cell × delete control');
  assert.equal(visualZones.nativeSearchCells, 0, 'Excel cells must not expose native search × controls');
  assert.equal(visualZones.standaloneProductSearchColumn, false, 'worktable must not render a standalone product-search column');
  assert.equal(visualZones.firstProductColumn, 'itemCode', 'itemCode must remain the first product entry column');
  assert.equal(visualZones.customerRegisterCoachmark, false, 'obsolete customer registration coachmark must not be exposed');
  assert.notEqual(visualZones.searchBackground, visualZones.excelBackground, 'itemCode product lookup and regular entry cells must be visually distinct');
  assert.equal(visualZones.searchDivider, '2px', 'product lookup must have an explicit boundary before the Excel grid');
  assert.equal(visualZones.logoComplete, true, 'transparent Smart X Input logo must load');
  assert.ok(visualZones.logoWidth >= 2000 && visualZones.brandHeight <= 40, 'header logo must use the supplied high-resolution asset inside the compact app identity slot');
  assert.ok(visualZones.brandLeftGap <= 1, 'SmartInput logo must occupy the far-left edge of the app header');
  assert.equal(visualZones.customerInHeader, true, 'customer entry must live in the app header');
  assert.ok(visualZones.voucherCustomerGap >= 8 && visualZones.customerHeaderGap >= 8, 'voucher, customer and operational header groups must remain visually separated');
  assert.equal(visualZones.headerDivider, '1px', 'customer and operational header groups must use an explicit divider');
  assert.equal(visualZones.headerHasReferenceCounts, false, 'product and customer counts must not remain as an app-header annotation');
  assert.equal(visualZones.coachmark, false, 'reference status must not use a coachmark or outlined annotation surface');
  assert.equal(visualZones.referenceBeforeSettings, true, 'reference status must sit immediately before settings');
  assert.equal(visualZones.legacyButtons, 0, 'manual draft-list, duplicate save, and top upload-template controls must be removed');
  assert.equal(visualZones.completeText, '저장');
  assert.equal(visualZones.completeInFooter, true, 'the all-voucher completion action must be in the table footer');
  assert.equal(visualZones.deliveryCardVisible, false, 'the footer left side must expose only the Save action');
  assert.deepEqual({ share: visualZones.shareText, excel: visualZones.excelText, footer: visualZones.outputsInFooter }, { share: '카톡 공유', excel: 'EXCEL', footer: true }, 'voucher output actions must remain in the table footer for every mode');
  assert.equal(visualZones.sequence, 'No.');
  const domBaseline = await evaluate(client, `(() => {const rect=selector=>{const value=document.querySelector(selector).getBoundingClientRect();return {x:Math.round(value.x),y:Math.round(value.y),width:Math.round(value.width),height:Math.round(value.height)};};return {
    title:document.title,
    modeTabs:[...document.querySelectorAll('.mode-tab')].map(button=>({mode:button.dataset.mode,label:button.textContent.trim()})),
    sourceMethods:[...document.querySelectorAll('.parser-toolbar [data-method]')].map(button=>({method:button.dataset.method,label:button.textContent.replace(/^[＋●]\s*/, '').trim()})),
    actionButtons:['restoreAutosaveButton','analyzeButton','addRowButton','resetDraftButton','completeButton','estimateNoticeButton','estimateExcelButton'].map(id=>({id,label:document.getElementById(id).textContent.replace(/✦|↻/g,'').replace(/\s+/g,' ').trim()})),
    tableColumns:[...document.querySelectorAll('#voucherInputTable thead th')].map(cell=>({id:cell.dataset.column||'sequence',label:cell.textContent.trim()})),
    regions:{appBar:rect('.app-bar'),parser:rect('.parser-card'),workbench:rect('.workbench'),grid:rect('.grid-card'),related:rect('.related-panel')},
    footerOrder:[...document.querySelectorAll('.voucher-footer-actions button')].map(button=>button.id)
  };})()`);
  assert.deepEqual(domBaseline.modeTabs, [
    { mode: 'order', label: '주문서' },
    { mode: 'purchase', label: '구매' },
    { mode: 'sale', label: '판매' },
    { mode: 'estimate', label: '견적서' }
  ]);
  assert.deepEqual(domBaseline.sourceMethods, [
    { method: 'excel', label: 'Excel 파일' },
    { method: 'voice', label: '음성' }
  ]);
  assert.deepEqual(domBaseline.tableColumns.map(column => column.label), [
    'No.', '품목코드', '품목명', '규격', '수량', '단위', '단가', '공급가액', '메모', '적요(직원)', '공지단가', '상태'
  ]);
  assert.deepEqual(domBaseline.footerOrder, ['completeButton', 'estimateCreateButton', 'saveEstimateAsButton', 'estimateNoticeButton', 'estimateExcelButton']);
  const mergedSelectionColumn = await evaluate(client, `(() => {const heading=document.querySelector('#voucherInputTable thead th:first-child');const row=document.querySelector('#inputRows tr');const checkbox=row?.querySelector('[data-select-row]');return {fixedColumns:document.querySelectorAll('#voucherInputTable colgroup col:not([data-column])').length,headerHasSelectAll:Boolean(heading?.querySelector('#selectAllRows')),rowNumber:row?.querySelector('.row-sequence-number')?.textContent.trim(),sameCell:checkbox?.closest('td')===row?.cells[0],checkboxWidth:checkbox?.getBoundingClientRect().width||0};})()`);
  assert.deepEqual({ fixedColumns: mergedSelectionColumn.fixedColumns, headerHasSelectAll: mergedSelectionColumn.headerHasSelectAll, rowNumber: mergedSelectionColumn.rowNumber, sameCell: mergedSelectionColumn.sameCell }, { fixedColumns: 1, headerHasSelectAll: true, rowNumber: '1', sameCell: true }, 'No. and selection must share one fixed column');
  assert.ok(mergedSelectionColumn.checkboxWidth >= 20, 'row selection checkbox must be enlarged');
  assert.equal(visualZones.resetInTopBar, true, 'voucher reset must be in the top unified work bar');
  assert.equal(visualZones.voucherContextVisible, true, 'order mode must expose the date-scoped voucher activity panel');
  assert.match(visualZones.voucherContextTitle, /주문서$/, 'activity title must describe the selected order date in the browser timezone');
  assert.match(visualZones.voucherContextStatus, /EMPTY|READY|조회/);
  assert.deepEqual({ estimateHeadingHidden: visualZones.estimateHeadingHidden, estimateListsHidden: visualZones.estimateListsHidden }, { estimateHeadingHidden: true, estimateListsHidden: true });
  const lightShot = await capture(client, 'smartinput-0a-1920-light.png');
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'dark theme');
  const darkShot = await capture(client, 'smartinput-0a-1920-dark.png');

  const beforeResize = await evaluate(client, `document.querySelector('.parser-card').getBoundingClientRect().width`);
  await evaluate(client, `(() => {const h=document.querySelector('#photoResizer');h.focus();for(let index=0;index<7;index+=1)h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  const afterResize = await expr(client, `Math.abs(document.querySelector('.parser-card').getBoundingClientRect().width-${beforeResize})>20&&document.querySelector('.parser-card').getBoundingClientRect().width`, 'parser resize');
  assert.ok(afterResize > beforeResize, 'desktop parser width control must remain interactive');
  const beforeRelatedResize = await evaluate(client, `document.querySelector('.related-panel').getBoundingClientRect().width`);
  assert.equal(await evaluate(client, `(() => {const parser=getComputedStyle(document.querySelector('#photoResizer span'));const related=getComputedStyle(document.querySelector('#relatedPanelResizer span'));return parser.height===related.height&&related.backgroundColor===parser.backgroundColor;})()`), true, 'right resize handle must be as visible as the left parser handle');
  const relatedCloseIdle = await evaluate(client, `(() => {const close=document.querySelector('#relatedPanelCloseButton');return {text:close.textContent.trim(),label:close.getAttribute('aria-label'),opacity:getComputedStyle(document.querySelector('.related-panel-chrome')).opacity,hoverNone:matchMedia('(hover: none)').matches};})()`);
  assert.deepEqual({ text: relatedCloseIdle.text, label: relatedCloseIdle.label }, { text: '×', label: '우측 패널 닫기' }, 'desktop close must be an accessible X without a top labeled button');
  assert.equal(relatedCloseIdle.opacity, relatedCloseIdle.hoverNone ? '1' : '0', 'the X must stay touch-visible and otherwise wait for pointer hover');
  if (!relatedCloseIdle.hoverNone) {
    const relatedHandlePoint = await evaluate(client, `(() => {const rect=document.querySelector('#relatedPanelResizer').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...relatedHandlePoint });
    await wait(250);
    assert.equal(await evaluate(client, `(() => {const close=getComputedStyle(document.querySelector('#relatedPanelCloseButton'));const handle=getComputedStyle(document.querySelector('#relatedPanelResizer span'));return getComputedStyle(document.querySelector('.related-panel-chrome')).opacity==='1'&&close.color==='rgb(255, 255, 255)'&&handle.height==='76px';})()`), true, 'resizer hover must reveal and highlight both the handle and X');
    const relatedClosePoint = await evaluate(client, `(() => {const rect=document.querySelector('#relatedPanelCloseButton').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...relatedClosePoint });
    await wait(250);
    assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#relatedPanelResizer span')).height`), '76px', 'X hover must also highlight the left resize handle');
  }
  await evaluate(client, `(() => {const handle=document.querySelector('#relatedPanelResizer');handle.focus();handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));return true;})()`);
  assert.ok(await evaluate(client, `document.querySelector('.related-panel').getBoundingClientRect().width`) > beforeRelatedResize, 'desktop right panel width must be keyboard adjustable');
  await click(client, '#relatedPanelCloseButton');
  await expr(client, `!document.querySelector('.related-panel').classList.contains('is-open')&&document.querySelector('#relatedPanelToggle').getAttribute('aria-expanded')==='false'`, 'right panel slide close');
  await click(client, '#relatedPanelToggle');
  assert.equal(await evaluate(client, `document.querySelector('.related-panel').classList.contains('is-open')&&document.querySelector('#relatedPanelToggle').getAttribute('aria-expanded')==='true'`), true, 'right panel must slide open from the right edge');

  await input(client, '#sourceTextInput', '주문서 전환 보존');
  await click(client, '[data-mode="purchase"]');
  const purchaseSwitch = await evaluate(client, `({active:document.querySelector('.mode-tab.is-active')?.dataset.mode,selected:document.querySelector('[data-mode="purchase"]').getAttribute('aria-selected'),date:document.querySelector('[data-header-field="deliveryDate"]>span').textContent.trim(),source:document.querySelector('#sourceTextInput').value,context:document.querySelector('#voucherContextTitle').textContent.trim()})`);
  assert.deepEqual({ active: purchaseSwitch.active, selected: purchaseSwitch.selected, date: purchaseSwitch.date, source: purchaseSwitch.source }, { active: 'purchase', selected: 'true', date: '구매일자', source: '' }, 'purchase voucher button must switch the active draft and header');
  assert.match(purchaseSwitch.context, /구매전표$/, 'purchase activity title must use the selected voucher date');
  await input(client, '#sourceTextInput', '구매 전환 보존');
  await click(client, '[data-mode="order"]');
  const orderSwitch = await evaluate(client, `({active:document.querySelector('.mode-tab.is-active')?.dataset.mode,selected:document.querySelector('[data-mode="order"]').getAttribute('aria-selected'),date:document.querySelector('[data-header-field="deliveryDate"]>span').textContent.trim(),source:document.querySelector('#sourceTextInput').value,context:document.querySelector('#voucherContextTitle').textContent.trim()})`);
  assert.deepEqual({ active: orderSwitch.active, selected: orderSwitch.selected, date: orderSwitch.date, source: orderSwitch.source }, { active: 'order', selected: 'true', date: '주문일자', source: '주문서 전환 보존' }, 'order voucher button must restore its own preserved draft');
  assert.match(orderSwitch.context, /주문서$/, 'order activity title must use the selected voucher date');
  await click(client, '[data-mode="purchase"]');
  assert.equal(await evaluate(client, `document.querySelector('#sourceTextInput').value`), '구매 전환 보존', 'purchase draft must survive repeated voucher switching');
  await click(client, '[data-mode="order"]');
  await input(client, '#sourceTextInput', '');

  const directInputStartedAt = performance.now();
  await input(client, '#sourceTextInput', '테스트 거래처\n사과 2박스\n배 3개');
  await click(client, '#analyzeButton');
  await expr(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length===2`, 'pure text parsing rows');
  flowTimings.directInputAnalyzeMs = Number((performance.now() - directInputStartedAt).toFixed(2));
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]')].map(input=>Number(input.value))`), [2, 3]);
  assert.equal(await evaluate(client, `document.querySelectorAll('#inputRows tr[data-default-row="true"]').length`), 1, 'parsed information must always retain one trailing manual row');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows tr[data-default-row="true"] [data-supply-amount]').value`), '', 'empty calculated values must not be displayed');
  await expr(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.order.rows.length===2`, 'blank parsed rows excluded from persistence');
  assert.match(await evaluate(client, `document.querySelector('#sourceTextInput').value`), /사과 2박스/, 'source text must remain visible during analysis');
  assert.match(await evaluate(client, `document.querySelector('#customerValidation').textContent`), /등록 거래처/, 'required-field guidance must appear beside the customer editor instead of in the right panel');
  assert.match(await evaluate(client, `document.querySelector('#gridValidation').textContent`), /미등록 상품/, 'table review guidance must appear in the unified table toolbar');

  await evaluate(client, `Object.defineProperty(navigator,'share',{configurable:true,value:async payload=>{window.__voucherSharePayload=payload;}});true`);
  await click(client, '#estimateNoticeButton');
  await expr(client, `Boolean(window.__voucherSharePayload)`, 'order Kakao share payload');
  assert.match(await evaluate(client, `window.__voucherSharePayload.text`), /\[주문서\][\s\S]*사과[\s\S]*배[\s\S]*합계/, 'Kakao share must include current non-empty voucher rows and totals');
  await evaluate(client, `window.XLSX={utils:{book_new:()=>({sheets:{}}),aoa_to_sheet:data=>data,book_append_sheet:(book,sheet,name)=>{book.sheets[name]=sheet;window.__voucherExportMatrix=sheet;}},writeFile:(book,name)=>{window.__voucherExportName=name;}};true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(window.__voucherExportName)`, 'order Excel output');
  assert.match(await evaluate(client, `window.__voucherExportName`), /스마트입력_주문서_/);
  assert.equal(await evaluate(client, `window.__voucherExportMatrix.length`), 7, 'Excel output must include two working rows and exclude the trailing manual blank row');
  await evaluate(client, `delete window.XLSX;true`);

  const firstQuantity = '#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]';
  const beforeGridPaste = await evaluate(client, `(() => ({
    quantities:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]')].map(input=>input.value),
    units:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="unit"]')].map(input=>input.value)
  }))()`);
  const gridPasteText = [
    '단가\t수량\t단위',
    '1500\t7\tEA',
    '\t\t',
    ' \t\u00a0\t\u200b',
    '0\t0\t',
    '1600\t-9\tBOX',
    '\t\t',
    '',
    ''
  ].join('\n');
  const gridPasteStartedAt = performance.now();
  await evaluate(client, `(() => {const target=document.querySelector(${JSON.stringify(firstQuantity)});const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?${JSON.stringify(gridPasteText)}:''}});target.dispatchEvent(event);return event.defaultPrevented;})()`);
  await expr(client, `document.querySelector(${JSON.stringify(firstQuantity)}).value==='7'`, 'reordered field-name grid paste');
  flowTimings.excelTablePasteMs = Number((performance.now() - gridPasteStartedAt).toFixed(2));
  assert.deepEqual(await evaluate(client, `(() => {const row=document.querySelector('#inputRows tr:not([data-default-row="true"])');return {unit:row.querySelector('[data-field="unit"]').value,unitPrice:row.querySelector('[data-field="unitPrice"]').value,pending:!document.querySelector('#pendingPasteToSourceButton').hidden};})()`),
    { unit: 'EA', unitPrice: '1500', pending: false }, 'reordered fields must map by name without opening the source fallback');
  assert.deepEqual(await evaluate(client, `(() => ({
    quantities:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]')].map(input=>Number(input.value)),
    unitPrices:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="unitPrice"]')].map(input=>Number(input.value)),
    units:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="unit"]')].map(input=>input.value)
  }))()`), {
    quantities: [7, 0, -9],
    unitPrices: [1500, 0, 1600],
    units: ['EA', beforeGridPaste.units[1], 'BOX']
  }, 'blank and invisible-whitespace rows must not create work rows; explicit zero and negative values must survive; blank cells keep the existing direct-grid overwrite contract');
  await click(client, '#undoGridPasteButton');
  assert.deepEqual(await evaluate(client, `(() => ({
    quantities:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]')].map(input=>input.value),
    units:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"]) [data-field="unit"]')].map(input=>input.value)
  }))()`), beforeGridPaste, 'reordered grid paste undo must restore the prior rows without retaining a fake blank row');
  await evaluate(client, String.raw`(() => {const row=document.querySelector('#inputRows tr:not([data-default-row="true"])');const fields=[...document.querySelectorAll('#voucherInputTable thead th[data-column]')].filter(th=>!th.classList.contains('is-column-hidden')).map(th=>th.dataset.column).filter(field=>row.querySelector('[data-field="'+CSS.escape(field)+'"],[data-custom-row-field="'+CSS.escape(field)+'"]'));const headers=fields.map(field=>document.querySelector('#voucherInputTable thead th[data-column="'+CSS.escape(field)+'"]').childNodes[0]?.textContent?.trim()||document.querySelector('#voucherInputTable thead th[data-column="'+CSS.escape(field)+'"]').textContent.trim());const values=fields.map(field=>{const input=row.querySelector('[data-field="'+CSS.escape(field)+'"],[data-custom-row-field="'+CSS.escape(field)+'"]');return field==='quantity'?'8':input.value;});const target=row.querySelector('[data-field="'+CSS.escape(fields[0])+'"],[data-custom-row-field="'+CSS.escape(fields[0])+'"]');const text=headers.join('\t')+'\n'+values.join('\t');const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?text:''}});target.dispatchEvent(event);})()`);
  await wait(120);
  await expr(client, `document.querySelector(${JSON.stringify(firstQuantity)}).value==='8'&&!document.querySelector('#undoGridPasteButton').disabled&&document.querySelector('#pendingPasteToSourceButton').hidden`, 'exact-structure grid paste');
  await click(client, '#undoGridPasteButton');
  assert.equal(await evaluate(client, `document.querySelector(${JSON.stringify(firstQuantity)}).value`), '2', 'grid paste undo must restore the prior row');
  await click(client, '#inputRows [data-select-row]');
  assert.equal(await evaluate(client, `!document.querySelector('#deleteSelectedRows').disabled`), true, 'row selection must enable bulk delete');
  await evaluate(client, `(() => {const current=document.querySelector(${JSON.stringify(firstQuantity)});current.focus();current.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `document.activeElement?.dataset?.field`), 'unit', 'keyboard navigation must move to the adjacent cell');
  const handleWidthBefore = await evaluate(client, `document.querySelector('col[data-column="itemName"]').getBoundingClientRect().width`);
  await evaluate(client, `(() => {const handle=document.querySelector('.column-resize-handle[data-resize-column="itemName"]');handle.focus();handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;})()`);
  const handleWidthAfter = await expr(client, `document.querySelector('col[data-column="itemName"]').getBoundingClientRect().width>${handleWidthBefore}&&document.querySelector('col[data-column="itemName"]').getBoundingClientRect().width`, 'keyboard column resize');
  assert.ok(handleWidthAfter > handleWidthBefore);

  await expr(client, `!document.querySelector('#restoreAutosaveButton').disabled`, 'latest autosave ready');
  const autosave = await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('autosave','readonly');const get=tx.objectStore('autosave').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result.map(record=>({key:record.key,schemaVersion:record.schemaVersion,sourceText:record.draft?.modes?.order?.sourceText})));db.close();};};})`);
  assert.equal(autosave.length, 1, 'autosave DB must overwrite one current record instead of building a list');
  assert.equal(autosave[0].key, 'current');
  assert.equal(autosave[0].schemaVersion, 'ONEAPP_SMART_INPUT_AUTOSAVE_V1');
  assert.match(autosave[0].sourceText, /사과 2박스/);
  const autosaveStartedAt = performance.now();
  await input(client, '#sourceTextInput', '테스트 거래처\n사과 2박스\n배 3개\n자동저장 성능 기준선');
  await expr(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('autosave','readonly');const get=tx.objectStore('autosave').get('current');get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result?.draft?.modes?.order?.sourceText?.includes('자동저장 성능 기준선'));db.close();};};})`, 'autosave response baseline');
  flowTimings.autosavePersistMs = Number((performance.now() - autosaveStartedAt).toFixed(2));
  await evaluate(client, `(() => {window.confirm=()=>true;document.querySelector('#sourceTextInput').value='화면에서만 바뀐 값';return true;})()`);
  await click(client, '#restoreAutosaveButton');
  await expr(client, `document.querySelector('#sourceTextInput').value.includes('사과 2박스')`, 'explicit latest autosave restore');

  await click(client, '#resetDraftButton');
  await expr(client, `document.querySelector('#inputRows tr[data-default-row="true"]')`, 'reset before recovery');
  await click(client, '#restoreAutosaveButton');
  await expr(client, `document.querySelector('#sourceTextInput').value.includes('사과 2박스')`, 'reset round-trip recovery');
  await evaluate(client, `window.confirm=()=>true;document.querySelector('#resetDraftButton').click();true`);
  await expr(client, `document.querySelector('#inputRows tr[data-default-row="true"]')`, 'empty default row');
  await typeWithoutBlur(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', '마스터 사과');
  await evaluate(client, `document.querySelector('#inputRows [data-field="itemCode"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await expr(client, `document.querySelector('#inputRows [data-field="itemCode"]')?.value==='MASTER-1'`, 'public master product selection');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="specification"]').value`), '10kg');
  await evaluate(client, `(() => {const input=document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="itemCode"]');input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `document.activeElement?.dataset?.field==='itemCode'&&document.activeElement?.closest('tr')?.dataset?.defaultRow==='true'`), true,
    'Tab from itemCode must move to the next row itemCode search entry');
  await typeWithoutBlur(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', '마스터');
  await evaluate(client, `(() => {const rows=[...document.querySelectorAll('#inputRows tr[data-row-id]:not([data-default-row])')];rows.at(-1).querySelector('[data-field="itemCode"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
  await expr(client, `Boolean(document.querySelector('.product-picker-dialog[open] .product-picker-result'))`, 'quality product candidate modal');
  const productModal = await evaluate(client, `(() => {const dialog=document.querySelector('.product-picker-dialog');const shell=dialog.querySelector('.smart-dialog__shell');const results=dialog.querySelector('.product-picker-results');const options=dialog.querySelectorAll('.product-picker-result');const option=options[0];const footer=dialog.querySelector('footer');const cancel=footer.querySelector('button');const dr=dialog.getBoundingClientRect();const rr=results.getBoundingClientRect();const or=option.getBoundingClientRect();const fr=footer.getBoundingClientRect();const cr=cancel.getBoundingClientRect();return {width:dr.width,shellHeight:shell.getBoundingClientRect().height,resultsHeight:rr.height,optionWidth:or.width,optionCount:options.length,optionShadow:getComputedStyle(option).boxShadow,footerHeight:fr.height,footerButtonAligned:Math.abs((fr.top+fr.height/2)-(cr.top+cr.height/2))<2,nativeSearchClear:dialog.querySelectorAll('input[type="search"]').length};})()`);
  assert.ok(productModal.width >= 560 && productModal.shellHeight >= 460 && productModal.resultsHeight >= 220, 'product modal must have a full shared-dialog layout and scrollable result area');
  assert.equal(productModal.optionCount, 2, 'a broad query must expose multiple product candidates');
  assert.ok(productModal.optionWidth >= productModal.width - 40 && productModal.optionShadow !== 'none', 'candidate must render as one full-width row with a non-green keyboard marker');
  assert.equal(productModal.footerButtonAligned, true, 'product modal actions must remain horizontally aligned');
  assert.equal(productModal.nativeSearchClear, 0, 'product modal must not expose a browser-native search × control');
  await click(client, '.product-picker-dialog .product-picker-result');
  await expr(client, `!document.querySelector('.product-picker-dialog')&&(()=>{const row=[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"])')].at(-1);return row?.querySelector('[data-field="itemCode"]')?.value==='MASTER-1'&&row?.querySelector('[data-field="itemName"]')?.value==='마스터 사과'&&row?.querySelector('[data-field="specification"]')?.value==='10kg';})()`, 'mouse candidate selection applies the product and closes the dialog');
  assert.deepEqual(exceptions, [], `mouse product selection runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `mouse product selection console errors: ${consoleErrors.join('\n')}`);

  await typeWithoutBlur(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', '마스터');
  await evaluate(client, `(() => {const rows=[...document.querySelectorAll('#inputRows tr[data-row-id]:not([data-default-row])')];rows.at(-1).querySelector('[data-field="itemCode"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
  await expr(client, `document.querySelectorAll('.product-picker-dialog[open] .product-picker-result').length===2`, 'keyboard product candidate modal');
  await evaluate(client, `(() => {const search=document.querySelector('.product-picker-dialog [data-product-search]');search.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));search.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
  await expr(client, `!document.querySelector('.product-picker-dialog')&&(()=>{const row=[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"])')].at(-1);return row?.querySelector('[data-field="itemCode"]')?.value==='MASTER-2'&&row?.querySelector('[data-field="itemName"]')?.value==='마스터 포도'&&row?.querySelector('[data-field="specification"]')?.value==='5kg'&&row?.querySelector('[data-field="unit"]')?.value==='EA';})()`, 'keyboard candidate selection applies the highlighted product and closes the dialog');
  assert.deepEqual(exceptions, [], `keyboard product selection runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `keyboard product selection console errors: ${consoleErrors.join('\n')}`);

  await typeWithoutBlur(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', '마스터');
  await evaluate(client, `(() => {const rows=[...document.querySelectorAll('#inputRows tr[data-row-id]:not([data-default-row])')];rows.at(-1).querySelector('[data-field="itemCode"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
  await expr(client, `document.querySelectorAll('.product-picker-dialog[open] .product-picker-result').length===2`, 'cancel product candidate modal');
  await click(client, '.product-picker-dialog [data-close]');
  await expr(client, `!document.querySelector('.product-picker-dialog')&&[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"])')].at(-1)?.querySelector('[data-field="itemCode"]')?.value==='마스터'`, 'candidate cancel keeps the current query and closes the dialog');
  assert.equal(await evaluate(client, `document.querySelector('#productReferenceStatus').textContent`), 'READY', 'product Snapshot must expose READY independently');
  assert.equal(await evaluate(client, `document.querySelector('#productReferenceCount').textContent`), '2건');
  assert.match(await evaluate(client, `document.querySelector('#productReferenceSource').textContent`), /상품관리 Snapshot Adapter/);
  await click(client, '#customerSearchButton');
  await expr(client, `document.querySelector('.smart-customer-dialog .smart-dialog__empty')?.textContent.includes('등록 거래처 0건')`, 'confirmed empty customer state');
  await input(client, '.smart-customer-dialog input[type="search"]', '조회없는거래처');
  await expr(client, `document.querySelector('.smart-customer-dialog .smart-dialog__empty')?.textContent.includes('검색 결과 0건')`, 'zero customer search result');
  assert.equal(await evaluate(client, `document.querySelector('#customerReferenceStatus').textContent`), 'EMPTY', 'customer EMPTY must remain distinct from ERROR');
  await click(client, '.smart-customer-dialog [data-close]');
  await evaluate(client, `(async()=>{const dbModule=await import('/customer-master/db.js?smartinput-e2e-fixture=1');const db=await dbModule.openDb();const tx=db.transaction(['customers','appMeta'],'readwrite');tx.objectStore('customers').put({customerId:'E2E-CUSTOMER',customerCode:'E2E-CUSTOMER',customerName:'격리 검증 거래처',normalizedCustomerCode:'e2e-customer',normalizedName:'격리 검증 거래처',searchText:'격리 검증 거래처 E2E-CUSTOMER',status:'ACTIVE',qualityStatus:'VERIFIED',revision:1,createdAt:'2026-09-02T08:00:00.000Z',updatedAt:'2026-09-02T08:00:00.000Z'});tx.objectStore('appMeta').put({key:'headRevision',value:1,updatedAt:'2026-09-02T08:00:00.000Z'});await dbModule.transactionDone(tx);return true;})()`);

  await input(client, '#inputRows [data-field="specification"]', '관리자 규격');
  await click(client, '#inputRows [data-select-row]');
  await evaluate(client, `window.__referenceRowMutations=0;window.__referenceRowObserver=new MutationObserver(records=>window.__referenceRowMutations+=records.length);window.__referenceRowObserver.observe(document.querySelector('#inputRows'),{childList:true,subtree:true});localStorage.setItem('merchMaster_v870',JSON.stringify([{productId:'P-MASTER-1',itemCode:'MASTER-1',itemName:'마스터 청사과',specification:'20kg',finalUnit:'BOX',outPrice:3300,status:'ACTIVE'}]));localStorage.setItem('merchMaster_revision_v870','2');true`);
  await click(client, '#allReferenceReload');
  await expr(client, `document.querySelector('#productReferenceStatus').textContent==='READY'&&document.querySelector('#productReferenceRevision').textContent==='2'`, 'new full-reference generation active');
  assert.equal(await evaluate(client, `document.querySelector('#customerReferenceStatus').textContent`), 'READY', 'isolated customer fixture must be available for current official save flows');
  assert.equal(await evaluate(client, `document.querySelector('#customerReferenceCount').textContent`), '1건');
  assert.equal(await evaluate(client, `document.querySelector('#referencePendingApply').hidden`), true, 'manual full refresh must activate one complete generation without a second apply step');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="itemName"]').value`), '마스터 사과', 'snapshot refresh must not rewrite current row values');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="specification"]').value`), '관리자 규격', 'snapshot refresh must preserve admin-edited fields');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-select-row]').checked`), true, 'snapshot refresh must preserve row selection');

  await evaluate(client, `localStorage.setItem('merchMaster_v870',JSON.stringify([{productId:'P-MASTER-1',itemCode:'MASTER-1',itemName:'마스터 최신 사과',secondaryName:'최신사과',approvedAliases:['새별칭'],specification:'30kg',finalUnit:'BOX',outPrice:3400,status:'ACTIVE'}]));localStorage.setItem('merchMaster_revision_v870','3');true`);
  await click(client, '#allReferenceReload');
  await expr(client, `document.querySelector('#productReferenceStatus').textContent==='READY'&&document.querySelector('#productReferenceRevision').textContent==='3'`, 'next full-reference generation active');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="itemName"]').value`), '마스터 사과', 'new snapshot must preserve current values');
  await click(client, '#resetDraftButton');
  await expr(client, `document.querySelector('#productReferenceRevision').textContent==='3'&&document.querySelector('#inputRows tr[data-default-row="true"]')`, 'pending revision promoted for next work');
  await typeWithoutBlur(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', '등록되지않은상품XYZ');
  await evaluate(client, `document.querySelector('#inputRows [data-field="itemCode"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
  await expr(client, `document.querySelector('#inputRows .row-owner-register')?.textContent==='상품관리에서 등록'`, 'missing product owner path');
  const missingBefore = await evaluate(client, `({rows:document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length,query:document.querySelector('#inputRows [data-field="itemCode"]').value,master:localStorage.getItem('merchMaster_v870'),href:document.querySelector('#inputRows .row-owner-register').getAttribute('href')})`);
  assert.equal(missingBefore.query, '등록되지않은상품XYZ');
  assert.equal(missingBefore.href, '../Master.html');
  await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('MerchOpsDB',2);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('store'))db.createObjectStore('store');if(!db.objectStoreNames.contains('master_products'))db.createObjectStore('master_products',{keyPath:'코드'});};request.onerror=()=>reject(request.error);request.onsuccess=()=>{request.result.close();resolve(true);};})`);
  await evaluate(client, `(() => {const link=document.querySelector('#inputRows .row-owner-register');link.addEventListener('click',event=>event.preventDefault(),{capture:true,once:true});link.click();return true;})()`);
  const requestStatus = await expr(client, `document.querySelector('#inputRows .row-owner-register')?.dataset.requestStatus`, 'product registration request result');
  assert.equal(requestStatus, 'PENDING', `product change request status: ${requestStatus}`);
  await expr(client, `(async()=>{const module=await import('/reference-data/product-change-request-adapter.js');const result=await module.productMasterChangeRequestAdapter.listChangeRequests();return result.requests.some(entry=>entry.request?.operation==='CREATE'&&entry.request?.source?.appId==='smart-input')})()`, 'product registration change request');
  await evaluate(client, `window.open(document.querySelector('#inputRows .row-owner-register').href,'_blank','noopener');true`);
  assert.equal(await evaluate(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length`), missingBefore.rows, 'owner-app round trip must preserve the current row');
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="itemCode"]').value`), missingBefore.query, 'owner-app round trip must preserve the missing input');
  assert.equal(await evaluate(client, `localStorage.getItem('merchMaster_v870')`), missingBefore.master, 'SmartInput must not directly write the product master');

  const orderResult = await evaluate(client, `(async()=>{const adapter=await import('/smartinput/legacy-integration-adapter.js');const saved=await adapter.createOrder({orderDate:'2026-08-29',deliveryExpectedDate:'2026-08-30',customerId:'E2E-CUSTOMER',customerName:'격리 검증 거래처',warehouseCode:'88',warehouseName:'격리 검증 창고',sourceType:'SMART_INPUT_E2E',sourceId:'ISOLATED_PROFILE',sourceMessageKey:'SMARTINPUT-E2E-ONE',items:[{itemCode:'MASTER-1',itemName:'마스터 사과',rawText:'마스터 사과 1BOX',rawQuantity:1,rawUnit:'BOX',finalQuantity:1,finalUnit:'BOX',price:3200,matchStatus:'MATCHED'}]});const intake=await import('/orderq/order-intake-engine.js');const operations=await import('/orderq/order-operations-repository.js');const orders=await intake.listOrders();const snapshot=await operations.getOperationsSnapshot();const warehouses=await adapter.loadWarehouseCatalog();return {orderId:saved.order.orderId,listed:orders.some(order=>order.orderId===saved.order.orderId),operational:snapshot.bundles.some(bundle=>bundle.order.orderId===saved.order.orderId),warehouse:warehouses.warehouses.some(row=>row.warehouseCode==='88')};})()`);
  assert.equal(orderResult.listed, true, 'current ORDER Q listOrders must read the SmartInput-created order');
  assert.equal(orderResult.operational, true, 'current operations snapshot must read the SmartInput-created order');
  assert.equal(orderResult.warehouse, true, 'current warehouse catalog must expose the writer-resolved warehouse');
  const officialResult = await evaluate(client, `(async()=>{const repo=await import('/orderq/official-voucher-repository.js?e2e=1');const make=(suffix,date,quantity)=>{const purchaseDocumentId='PD-E2E-'+suffix;const purchaseLineId='PL-E2E-'+suffix;const commandId='POST_PURCHASE:E2E:'+suffix;const document={companyId:'ONEAPP',purchaseDocumentId,supplierCustomerId:'E2E-CUSTOMER',warehouseId:'WH-E2E',purchaseDate:date,status:'DRAFT',businessStatus:'DRAFT',revision:1};const lines=[{purchaseLineId,purchaseDocumentId,lineIdentityId:'LI-E2E-'+suffix,unresolvedProductId:'UP-E2E',warehouseId:'WH-E2E',actualQuantity:quantity,baseQuantity:quantity,unitPrice:1000,supplyAmount:quantity*1000,totalAmount:quantity*1000}];const commandEnvelope={...document,document,lines,commandType:'POST_PURCHASE',commandId,idempotencyKey:commandId,expectedRevision:1,actor:'E2E',occurredAt:date+'T09:00:00.000Z'};return {kind:'PURCHASE',companyId:'ONEAPP',purchaseDocumentId,document,lines,commandEnvelope,commandSource:commandEnvelope};};const first=make('U1','2026-08-24',2);await repo.saveOfficialVoucherDraft(first,'E2E');const posted=await repo.runCentralOfficialVoucherCommand({...first.commandEnvelope,intent:first.commandEnvelope});const duplicate=await repo.runCentralOfficialVoucherCommand({...first.commandEnvelope,intent:first.commandEnvelope});await repo.recordInventoryCheckpoint({companyId:'ONEAPP',warehouseId:'WH-E2E',sessionId:'STOCKTAKE-E2E',effectiveAt:'2026-08-25',counts:[{productId:'PRODUCT-E2E',quantity:10}],actor:'E2E',confirmedAt:'2026-08-25T12:00:00.000Z'});let rawRematchError='';try{await repo.resolveUnresolvedProductInventory({companyId:'ONEAPP',unresolvedProductId:'UP-E2E',productId:'PRODUCT-E2E',actor:'E2E',occurredAt:'2026-08-26T09:00:00.000Z'});}catch(error){rawRematchError=error?.message||String(error);}const second=make('U2','2026-08-26',3);await repo.saveOfficialVoucherDraft(second,'E2E');const afterAttempt=await repo.runCentralOfficialVoucherCommand({...second.commandEnvelope,intent:second.commandEnvelope});return {postedPending:posted.pendingInventoryEffects.length,postedInventory:posted.inventoryMovements.length,payable:posted.ledgerEntries.length,duplicate:duplicate.duplicate,rawRematchError,afterAttemptInventory:afterAttempt.inventoryMovements.length,afterAttemptPending:afterAttempt.pendingInventoryEffects.length,afterAttemptProduct:afterAttempt.lines[0]?.productId||''};})()`);
  assert.deepEqual(officialResult, { postedPending: 1, postedInventory: 0, payable: 1, duplicate: true,
    rawRematchError: 'ORDERQ_REMATCH_OWNER_GATEWAY_REQUIRED', afterAttemptInventory: 0,
    afterAttemptPending: 1, afterAttemptProduct: '' },
  'official repository must preserve AR/AP, defer unmatched inventory, and reject raw rematch writes outside the owner Gateway');
  const officialRollbackResult = await evaluate(client, `(async()=>{const repo=await import('/orderq/official-voucher-repository.js?rollback-e2e=1');const dbModule=await import('/orderq/orderq-db.js?rollback-e2e=1');const purchaseDocumentId='PD-E2E-ROLLBACK';const purchaseLineId='PL-E2E-ROLLBACK';const commandId='POST_PURCHASE:E2E:ROLLBACK';const document={companyId:'ONEAPP',purchaseDocumentId,supplierCustomerId:'E2E-CUSTOMER',warehouseId:'WH-E2E',purchaseDate:'2026-09-02',status:'DRAFT',businessStatus:'DRAFT',revision:1};const lines=[{purchaseLineId,purchaseDocumentId,lineIdentityId:'LI-E2E-ROLLBACK',productId:'PRODUCT-E2E',warehouseId:'WH-E2E',actualQuantity:5,baseQuantity:5,unitPrice:1000,supplyAmount:5000,totalAmount:5000}];const commandEnvelope={...document,document,lines,commandType:'POST_PURCHASE',commandId,idempotencyKey:commandId,expectedRevision:1,actor:'E2E',occurredAt:'2026-09-02T09:00:00.000Z'};await repo.saveOfficialVoucherDraft({kind:'PURCHASE',companyId:'ONEAPP',purchaseDocumentId,document,lines,commandEnvelope,commandSource:commandEnvelope},'E2E');const db=await dbModule.openOrderQDb();const blockerTx=db.transaction('officialCommands','readwrite');blockerTx.objectStore('officialCommands').add({commandId:'ROLLBACK-BLOCKER',idempotencyKey:commandId,companyId:'ONEAPP',voucherMode:'purchase',documentId:'ROLLBACK-BLOCKER-DOCUMENT',commandType:'POST_PURCHASE',status:'TEST_BLOCKER',requestedAt:'2026-09-02T08:00:00.000Z'});await dbModule.transactionDone(blockerTx);const originalTransaction=IDBDatabase.prototype.transaction;const observed=[];IDBDatabase.prototype.transaction=function(storeNames,mode,...rest){if(mode==='readwrite'){observed.push(Array.isArray(storeNames)?[...storeNames]:[storeNames]);}return originalTransaction.call(this,storeNames,mode,...rest);};let errorName='';let errorMessage='';try{await repo.runCentralOfficialVoucherCommand({...commandEnvelope,intent:commandEnvelope});}catch(error){errorName=error?.name||'';errorMessage=error?.message||String(error);}finally{IDBDatabase.prototype.transaction=originalTransaction;}const aggregate=await repo.loadOfficialPurchaseAggregate(purchaseDocumentId);const verifyDb=await dbModule.openOrderQDb();const verifyTx=verifyDb.transaction(['syncQueue','unresolvedProducts'],'readonly');const queue=await dbModule.requestToPromise(verifyTx.objectStore('syncQueue').index('byEntity').getAll(['OFFICIAL_VOUCHER_COMMAND',commandId]));const unresolved=await dbModule.requestToPromise(verifyTx.objectStore('unresolvedProducts').getAll());await dbModule.transactionDone(verifyTx);return {errorName,errorMessage,transactionCount:observed.length,stores:observed[0]||[],documentStatus:aggregate.document.status,documentRevision:aggregate.document.revision,lineStatuses:aggregate.lines.map(row=>row.status),revisions:aggregate.revisions.length,inventory:aggregate.inventoryMovements.length,ledger:aggregate.ledgerEntries.length,pending:aggregate.pendingInventoryEffects.length,commands:aggregate.commands.length,queue:queue.length,unresolvedForDocument:unresolved.filter(row=>row.sourceDocumentId===purchaseDocumentId).length};})()`);
  assert.match(`${officialRollbackResult.errorName}:${officialRollbackResult.errorMessage}`, /ConstraintError|AbortError|IndexedDB transaction failed/,
    'injected unique-index failure must abort the official commit');
  assert.equal(officialRollbackResult.transactionCount, 1, 'official finalize must use one readwrite transaction');
  assert.deepEqual(new Set(officialRollbackResult.stores), new Set([
    'purchaseDocuments', 'purchaseLines', 'officialCommands', 'voucherRevisions', 'inventoryMovements',
    'payableEntries', 'pendingInventoryEffects', 'unresolvedProducts', 'syncQueue'
  ]));
  assert.deepEqual({
    status: officialRollbackResult.documentStatus,
    revision: officialRollbackResult.documentRevision,
    lines: officialRollbackResult.lineStatuses,
    revisions: officialRollbackResult.revisions,
    inventory: officialRollbackResult.inventory,
    ledger: officialRollbackResult.ledger,
    pending: officialRollbackResult.pending,
    commands: officialRollbackResult.commands,
    queue: officialRollbackResult.queue,
    unresolved: officialRollbackResult.unresolvedForDocument
  }, {
    status: 'DRAFT', revision: 1, lines: ['DRAFT'], revisions: 0, inventory: 0,
    ledger: 0, pending: 0, commands: 0, queue: 0, unresolved: 0
  }, 'an injected finalize failure must leave the pre-existing draft intact and commit zero partial effects');
  const officialGatewayRollbackResult = await evaluate(client, `(async()=>{const repo=await import('/orderq/official-voucher-repository.js?gateway-rollback-read=1');const gateway=await import('/orderq/official-command-gateway.js?gateway-rollback-e2e=1');const id='PD-E2E-ROLLBACK';const before=await repo.loadOfficialPurchaseAggregate(id);let error='';try{const envelope=before.document.commandEnvelope;await gateway.OfficialCommandGateway.execute({...envelope,intent:envelope});}catch(cause){error=(cause?.name||'')+':'+(cause?.message||String(cause));}const after=await repo.loadOfficialPurchaseAggregate(id);return {error,status:after.document.status,revision:after.document.revision,revisions:after.revisions.length,inventory:after.inventoryMovements.length,ledger:after.ledgerEntries.length,pending:after.pendingInventoryEffects.length,commands:after.commands.length};})()`);
  const { error: officialGatewayRollbackError, ...officialGatewayRollbackState } = officialGatewayRollbackResult;
  assert.match(officialGatewayRollbackError, /ConstraintError|AbortError|IndexedDB transaction failed/,
    'the owner Gateway must propagate the same injected repository transaction failure');
  assert.deepEqual(officialGatewayRollbackState, {
    status: 'DRAFT', revision: 1, revisions: 0, inventory: 0,
    ledger: 0, pending: 0, commands: 0
  }, 'Gateway-routed failure must preserve the same zero-partial-write rollback result');
  const officialV2Stage3Result = await evaluate(client, `(async()=>{const scenario=await import('/scripts/fixtures/smartinput-v2-stage3-browser-scenario.js?e2e=1');return scenario.runSmartInputV2Stage3BrowserScenario();})()`);
  assert.deepEqual(officialV2Stage3Result.featureGates, { PURCHASE: true, SALE: true });
  assert.deepEqual(officialV2Stage3Result.purchase, {
    date: '2026-09-01', dayDefaulted: true, inventory: 2, ledger: 1,
    duplicate: true, commands: 1, revisions: 1,
    frozenName: '㈜金 확정상품', frozenCode: '０００７',
    frozenOriginalName: '㈜金 원본상품', frozenOriginalCode: '０００７'
  }, 'purchase V2 must preserve its confirmed Snapshot and apply one effect across identical retries');
  assert.deepEqual(officialV2Stage3Result.sale, {
    inventory: -2, ledger: 1, duplicate: true, differentGroupDocumentId: true
  }, 'sale V2 must isolate voucher groups and apply one effect across identical retries');
  assert.match(officialV2Stage3Result.safety.expectedRevisionError, /REVISION_CONFLICT/);
  assert.match(officialV2Stage3Result.safety.saleExpectedRevisionError, /REVISION_CONFLICT/);
  assert.match(officialV2Stage3Result.safety.payloadConflictError, /AMOUNT_DERIVATION_MISMATCH|LINE_SNAPSHOT_MISMATCH|COMMAND_PAYLOAD_CONFLICT|COMMAND_ID_INVALID/);
  assert.match(officialV2Stage3Result.safety.salePayloadConflictError, /AMOUNT_DERIVATION_MISMATCH|LINE_SNAPSHOT_MISMATCH|COMMAND_PAYLOAD_CONFLICT|COMMAND_ID_INVALID/);
  assert.equal(officialV2Stage3Result.safety.gatewayCommandPayloadConflictError, 'Error:ORDERQ_OFFICIAL_V2_COMMAND_PAYLOAD_CONFLICT');
  assert.equal(officialV2Stage3Result.safety.repositoryCommandPayloadConflictError, 'Error:ORDERQ_OFFICIAL_V2_COMMAND_PAYLOAD_CONFLICT');
  assert.equal(officialV2Stage3Result.safety.nonSnapshotCommandIdUnchanged, true);
  assert.match(officialV2Stage3Result.safety.repositoryCompanyError, /COMPANY_MISMATCH|COMMAND_PAYLOAD_CONFLICT|COMMAND_ID_INVALID/);
  assert.match(officialV2Stage3Result.safety.gatewayIdentityError, /IDENTITY_VERSION_INVALID/);
  assert.match(officialV2Stage3Result.safety.repositoryIdentityError, /IDENTITY_VERSION_INVALID/);
  assert.match(officialV2Stage3Result.rollback.error, /ConstraintError|AbortError|IndexedDB transaction failed/);
  assert.deepEqual({ ...officialV2Stage3Result.rollback, error: undefined }, {
    error: undefined, status: 'DRAFT', revision: 1, lineStatuses: ['DRAFT'],
    revisions: 0, inventory: 0, ledger: 0, pending: 0, commands: 0
  }, 'V2 injected failure must rollback the document, line, revision, inventory, ledger, and command atomically');
  assert.match(officialV2Stage3Result.saleRollback.error, /ConstraintError|AbortError|IndexedDB transaction failed/);
  assert.deepEqual({ ...officialV2Stage3Result.saleRollback, error: undefined }, {
    error: undefined, status: 'DRAFT', revision: 1, lineStatuses: ['DRAFT'],
    revisions: 0, inventory: 0, ledger: 0, pending: 0, commands: 0
  }, 'sale V2 injected failure must rollback the document, line, revision, inventory, ledger, and command atomically');
  const officialV2Stage4Result = await evaluate(client, `(async()=>{const scenario=await import('/scripts/fixtures/smartinput-v2-stage4-browser-scenario.js?e2e=1');return scenario.runSmartInputV2Stage4BrowserScenario();})()`);
  assert.deepEqual(officialV2Stage4Result.featureGates, { PURCHASE: true, SALE: true });
  assert.deepEqual(officialV2Stage4Result.purchase.matchedEffects, [
    { quantity: 10, status: 'APPLIED_NORMAL' },
    { quantity: 0, status: 'ZERO_EFFECT' }
  ], 'V2 must persist purchase +quantity and a separate ZERO_EFFECT without applying the legacy factor');
  assert.equal(officialV2Stage4Result.purchase.unresolvedOfficialInventory, 0,
    'unmatched products must create no official inventory movement, including a zero quantity');
  assert.deepEqual(officialV2Stage4Result.purchase.pending, [
    { code: '0099', name: '미등록 상품', status: 'UNRESOLVED_PRODUCT', applied: false, documentLinked: true, revisionLinked: true },
    { code: '0099', name: '미등록 상품 별칭', status: 'UNRESOLVED_PRODUCT', applied: false, documentLinked: true, revisionLinked: true },
    { code: '', name: '같은 이름', status: 'UNRESOLVED_PRODUCT', applied: false, documentLinked: true, revisionLinked: true }
  ], 'code-unmatched and name-only rows must remain reviewable without name auto-matching');
  assert.equal(officialV2Stage4Result.purchase.unresolvedReviewRecords.length, 2);
  assert.equal(officialV2Stage4Result.purchase.unresolvedReviewRecords.every(record => record.status === 'UNRESOLVED_PRODUCT'
    && record.documentLinked && record.lineLinked && record.revisionLinked && record.applied === false), true,
  'unresolved review records must preserve document, line, and Revision links');
  assert.deepEqual(officialV2Stage4Result.purchase.unresolvedReviewRecords.map(record => record.linkCount).sort(), [1, 2],
    'one unresolved product must retain every source line without duplicate links');
  assert.deepEqual(officialV2Stage4Result.purchase.payable, [{
    partnerId: 'V2-STAGE4-C-0003', amount: 2661,
    effectiveAt: '2026-08-05', occurredAt: '2026-09-02T10:00:00.000Z'
  }]);
  assert.equal(officialV2Stage4Result.purchase.documentBusinessDate, '2026-08-05');
  assert.equal(officialV2Stage4Result.purchase.ledgerDecision.status, 'CREATED');
  assert.equal(officialV2Stage4Result.purchase.ledgerDecision.reason, 'EXACT_COMPANY_CUSTOMER_CODE');
  assert.equal(officialV2Stage4Result.purchase.ledgerDecision.effectiveAt, '2026-08-05');
  assert.equal(officialV2Stage4Result.purchase.ledgerDecision.occurredAt, '2026-09-02T10:00:00.000Z');
  assert.equal(officialV2Stage4Result.purchase.duplicate, true);
  assert.match(officialV2Stage4Result.purchase.repositoryLedgerDateGuardError, /LEDGER_PROJECTION_MISMATCH/,
    'Repository retry must reject a stored V2 ledger projection whose effective date was tampered');
  assert.deepEqual(officialV2Stage4Result.purchase.aggregateCounts, {
    lines: 5, inventory: 2, pending: 3, unresolved: 2, ledger: 1, revisions: 1, commands: 1, queue: 1
  }, 'one transaction and one idempotent retry must leave exactly one official projection set and queue row');
  assert.equal(officialV2Stage4Result.purchase.factorOne, true);
  assert.equal(officialV2Stage4Result.purchase.leadingZeroProductId, 'V2-STAGE4-P-0007');
  assert.equal(officialV2Stage4Result.sale.inventory, -4);
  assert.equal(officialV2Stage4Result.sale.receivables, 0);
  assert.equal(officialV2Stage4Result.sale.ledgerDecision.status, 'NOT_CREATED');
  assert.equal(officialV2Stage4Result.sale.ledgerDecision.reason, 'CUSTOMER_CODE_UNMATCHED');
  assert.equal(officialV2Stage4Result.sale.ledgerDecision.effectiveAt, '2026-08-05');
  assert.equal(officialV2Stage4Result.sale.ledgerDecision.occurredAt, '2026-09-02T10:00:00.000Z');
  assert.equal(officialV2Stage4Result.sale.partnerId, '');
  assert.equal(officialV2Stage4Result.sale.matchedInventory, -4);
  assert.deepEqual(officialV2Stage4Result.sale.matchedReceivable, [{
    partnerId: 'V2-STAGE4-C-0003', amount: 400,
    effectiveAt: '2026-08-05', occurredAt: '2026-09-02T10:00:00.000Z'
  }]);
  assert.equal(officialV2Stage4Result.sale.matchedLedgerDecision.status, 'CREATED');
  assert.equal(officialV2Stage4Result.sale.matchedLedgerDecision.effectiveAt, '2026-08-05');
  assert.equal(officialV2Stage4Result.sale.matchedLedgerDecision.occurredAt, '2026-09-02T10:00:00.000Z');
  assert.equal(officialV2Stage4Result.sale.matchedDocumentBusinessDate, '2026-08-05');
  assert.match(officialV2Stage4Result.rollback.error, /ConstraintError|AbortError|IndexedDB transaction failed/);
  assert.deepEqual({ ...officialV2Stage4Result.rollback, error: undefined }, {
    error: undefined, status: 'DRAFT', revision: 1, lineStatuses: ['DRAFT', 'DRAFT'],
    revisions: 0, inventory: 0, pending: 0, unresolved: 0, ledger: 0, commands: 0, queue: 0
  }, 'forced V2 Stage 4 failure must leave zero confirmed partial effects, review records, commands, or queue rows');
  const officialV2Phase6AReadResult = await evaluate(client, `(async()=>{
    const adapterModule=await import('/orderq/unresolved-review-read-adapter.js?phase6a-e2e=1');
    const dbModule=await import('/orderq/orderq-db.js?phase6a-e2e=1');
    const selectedProduct={companyId:'V2-STAGE4-COMPANY',productId:'V2-STAGE4-P-0099-NOW',itemCode:'0099',itemName:'현재 등록된 상품',status:'ACTIVE',revision:1};
    const productResult={status:'READY',snapshot:{status:'READY',snapshotId:'PHASE6A-E2E-PRODUCTS',revision:1,data:{products:[selectedProduct]}},error:null};
    const adapter=adapterModule.createUnresolvedReviewReadAdapter({readProductSnapshot:async()=>productResult});
    const db=await dbModule.openOrderQDb();
    const relevantStores=['unresolvedProducts','pendingInventoryEffects','purchaseDocuments','purchaseLines','salesDocuments','salesLines','voucherRevisions','inventoryCheckpoints'];
    const adversarialTx=db.transaction(['unresolvedProducts','pendingInventoryEffects','purchaseDocuments','purchaseLines','voucherRevisions'],'readwrite');
    adversarialTx.objectStore('unresolvedProducts').put({
      unresolvedProductId:'UP-PHASE6A-CROSS-COMPANY',companyId:'V2-STAGE4-COMPANY',status:'UNRESOLVED_PRODUCT',
      originalProductCode:'',originalProductName:'',reviewLinks:[{
        pendingEffectId:'E-PHASE6A-CROSS-COMPANY',voucherMode:'purchase',sourceDocumentId:'PD-PHASE6A-CROSS-COMPANY',
        sourceLineId:'PL-PHASE6A-CROSS-COMPANY',sourceDocumentRevision:1,voucherRevisionId:'VR-PHASE6A-CROSS-COMPANY',
        warehouseId:'PHASE6A-WH-SAFE',businessDate:'2026-09-03',inventoryEffectStatus:'UNRESOLVED_PRODUCT',officialInventoryApplied:false
      }]
    });
    adversarialTx.objectStore('pendingInventoryEffects').put({
      pendingEffectId:'E-PHASE6A-CROSS-COMPANY',companyId:'V2-STAGE4-COMPANY',unresolvedProductId:'UP-PHASE6A-CROSS-COMPANY',
      status:'PENDING_PRODUCT_MATCH',inventoryEffectStatus:'UNRESOLVED_PRODUCT',officialInventoryApplied:false,voucherMode:'purchase',
      sourceDocumentId:'PD-PHASE6A-CROSS-COMPANY',sourceLineId:'PL-PHASE6A-CROSS-COMPANY',sourceDocumentRevision:1,
      voucherRevisionId:'VR-PHASE6A-CROSS-COMPANY',warehouseId:'PHASE6A-WH-SAFE',effectiveAt:'2026-09-03'
    });
    adversarialTx.objectStore('purchaseDocuments').put({
      purchaseDocumentId:'PD-PHASE6A-CROSS-COMPANY',companyId:'OTHER-COMPANY',status:'CONFIRMED',revision:1,
      warehouseId:'PHASE6A-LEAK-DOCUMENT-WAREHOUSE',businessDate:'2099-12-31',businessOccurredAt:'PHASE6A-LEAK-DOCUMENT-TIME'
    });
    adversarialTx.objectStore('purchaseLines').put({
      purchaseLineId:'PL-PHASE6A-CROSS-COMPANY',purchaseDocumentId:'PD-PHASE6A-CROSS-COMPANY',companyId:'OTHER-COMPANY',
      originalProductCode:'PHASE6A-LEAK-CODE',originalProductName:'PHASE6A-LEAK-NAME',specification:'PHASE6A-LEAK-SPEC',
      unit:'PHASE6A-LEAK-UNIT',actualQuantity:987654321,businessOccurredAt:'PHASE6A-LEAK-LINE-TIME',
      productSnapshot:{productName:'PHASE6A-LEAK-SNAPSHOT'}
    });
    adversarialTx.objectStore('voucherRevisions').put({
      voucherRevisionId:'VR-PHASE6A-CROSS-COMPANY',documentId:'PD-PHASE6A-CROSS-COMPANY',companyId:'OTHER-COMPANY',
      status:'CONFIRMED',revision:1,afterSnapshot:{memo:'PHASE6A-LEAK-REVISION'}
    });
    await dbModule.transactionDone(adversarialTx);
    const count=async()=>{const tx=db.transaction(relevantStores,'readonly');const pairs=await Promise.all(relevantStores.map(async name=>[name,(await dbModule.requestToPromise(tx.objectStore(name).getAll())).length]));await dbModule.transactionDone(tx);return Object.fromEntries(pairs);};
    const before=await count();
    const objectStoreMethods=['put','add','delete','clear'];
    const originals=Object.fromEntries(objectStoreMethods.map(name=>[name,IDBObjectStore.prototype[name]]));
    const transactionOriginal=IDBDatabase.prototype.transaction;
    const observed={writes:[],transactionModes:[]};
    objectStoreMethods.forEach(name=>{IDBObjectStore.prototype[name]=function(...args){observed.writes.push({store:this.name,operation:name});return originals[name].apply(this,args);};});
    IDBDatabase.prototype.transaction=function(storeNames,mode,...args){observed.transactionModes.push(mode||'readonly');return transactionOriginal.call(this,storeNames,mode,...args);};
    let review;
    let preview;
    let empty;
    try{
      review=await adapter.getReviewResult({companyId:'V2-STAGE4-COMPANY',limit:20,generatedAt:'2026-09-03T09:00:00.000Z'});
      const target=review.items.find(item=>item.originalProductCode==='0099');
      preview=await adapter.previewRematchImpactResult({companyId:'V2-STAGE4-COMPANY',unresolvedProductId:target.unresolvedProductId,selectedProductId:selectedProduct.productId,generatedAt:'2026-09-03T09:00:00.000Z'});
      empty=await adapter.getReviewResult({companyId:'PHASE6A-NO-DATA',limit:20,generatedAt:'2026-09-03T09:00:00.000Z'});
    }finally{
      objectStoreMethods.forEach(name=>{IDBObjectStore.prototype[name]=originals[name];});
      IDBDatabase.prototype.transaction=transactionOriginal;
    }
    const after=await count();
    const crossCompanyItem=review.items.find(item=>item.unresolvedProductId==='UP-PHASE6A-CROSS-COMPANY');
    db.close();
    return {
      databaseVersion:dbModule.DB_VERSION,
      reviewStatus:review.status,
      reviewCount:review.count,
      linkCounts:review.items.map(item=>item.aggregate.linkCount).sort((a,b)=>a-b),
      officialQuantityNull:review.items.every(item=>item.officialInventory.officialQuantity===null&&item.links.every(link=>link.officialInventory.officialQuantity===null)),
      traceComplete:review.items.every(item=>item.links.every(link=>link.sourceVoucher.documentId&&link.sourceVoucher.lineId&&link.sourceVoucher.revisionId&&link.sourceVoucher.detailHref)),
      noAutoConfirmation:review.items.every(item=>item.candidates.every(candidate=>candidate.automaticConfirmation===false)),
      crossCompanyPayloadHidden:crossCompanyItem
        && !JSON.stringify(crossCompanyItem).includes('PHASE6A-LEAK-'),
      crossCompanyReviewStatus:crossCompanyItem?.integrity?.status,
      crossCompanyIssues:crossCompanyItem?.links[0]?.integrity?.issues?.map(issue=>issue.code)||[],
      previewStatus:preview.status,
      previewEffects:preview.summary.affectedEffectCount,
      previewWrites:preview.officialWritePlan,
      emptyStatus:empty.status,
      emptyCount:empty.count,
      observed,
      countsUnchanged:JSON.stringify(before)===JSON.stringify(after)
    };
  })()`);
  assert.equal(officialV2Phase6AReadResult.databaseVersion, 7, 'Phase 6A read must reuse the existing ORDER Q schema');
  assert.deepEqual({
    status: officialV2Phase6AReadResult.reviewStatus,
    count: officialV2Phase6AReadResult.reviewCount,
    links: officialV2Phase6AReadResult.linkCounts,
    officialQuantityNull: officialV2Phase6AReadResult.officialQuantityNull,
    traceComplete: officialV2Phase6AReadResult.traceComplete,
    noAutoConfirmation: officialV2Phase6AReadResult.noAutoConfirmation
  }, {
    status: 'READY', count: 3, links: [1, 1, 2], officialQuantityNull: true,
    traceComplete: true, noAutoConfirmation: true
  }, 'ORDER Q owner read adapter must expose every Stage 4 unresolved link without direct consumer Store access');
  assert.equal(officialV2Phase6AReadResult.crossCompanyPayloadHidden, true,
    'cross-company point-get payload must not reach the owner Adapter output');
  assert.equal(officialV2Phase6AReadResult.crossCompanyReviewStatus, 'REVIEW_REQUIRED');
  assert.equal(officialV2Phase6AReadResult.crossCompanyIssues.includes('SOURCE_DOCUMENT_COMPANY_MISMATCH'), true);
  assert.equal(officialV2Phase6AReadResult.crossCompanyIssues.includes('SOURCE_LINE_COMPANY_MISMATCH'), true);
  assert.equal(officialV2Phase6AReadResult.crossCompanyIssues.includes('VOUCHER_REVISION_COMPANY_MISMATCH'), true);
  assert.equal(officialV2Phase6AReadResult.previewStatus, 'APPLY_READY');
  assert.equal(officialV2Phase6AReadResult.previewEffects, 2);
  assert.deepEqual(officialV2Phase6AReadResult.previewWrites, {
    commands: 0, inventoryWrites: 0, referenceDataWrites: 0,
    note: '적용 전 영향 미리보기이며 실제 재매칭·재고·기준정보 쓰기를 수행하지 않음'
  });
  assert.deepEqual({ status: officialV2Phase6AReadResult.emptyStatus, count: officialV2Phase6AReadResult.emptyCount },
    { status: 'EMPTY', count: 0 }, 'empty owner data must remain distinct from a read error');
  assert.deepEqual(officialV2Phase6AReadResult.observed.writes, [], 'Phase 6A browser read and preview must perform zero IndexedDB writes');
  assert.equal(officialV2Phase6AReadResult.observed.transactionModes.every(mode => mode === 'readonly'), true,
    'Phase 6A browser operations must open readonly transactions only');
  assert.equal(officialV2Phase6AReadResult.countsUnchanged, true, 'Phase 6A browser operations must leave official Store counts unchanged');
  const officialV2Stage5Result = await evaluate(client, `(async()=>{const scenario=await import('/scripts/fixtures/smartinput-v2-stage5-browser-scenario.js?e2e=1');return scenario.runSmartInputV2Stage5BrowserScenario();})()`);
  assert.deepEqual(officialV2Stage5Result.featureGates, { PURCHASE: true, SALE: true });
  assert.match(officialV2Stage5Result.preview.error, /STOCKTAKE_DECISION_REQUIRED/);
  assert.deepEqual(officialV2Stage5Result.preview.conflicts, [{
    productCode: '0007', productName: '실사 충돌 상품', warehouse: '단계5창고', quantity: 10,
    checkpointId: 'V2-STAGE5-CP-SEP01'
  }]);
  assert.equal(officialV2Stage5Result.preview.submitCount, 0,
    'checkpoint review must finish before the first official draft or command submit');
  assert.equal(Object.values(officialV2Stage5Result.preview.countsBeforeDecision).every(count => count === 0), true,
    'preview and cancel boundary must leave zero official documents, lines, revisions, effects, ledgers, commands, and queue rows');
  assert.deepEqual(officialV2Stage5Result.included, {
    status: 'ABSORBED_BY_CHECKPOINT', appliedQuantity: 0, applied: false,
    checkpointId: 'V2-STAGE5-CP-SEP01', decisions: 1, duplicate: true,
    movements: 1, commands: 1, revisions: 1
  }, 'included stocktake quantity must preserve the voucher while applying zero duplicate stock');
  assert.deepEqual(officialV2Stage5Result.notIncluded, {
    sourceStatus: 'APPLIED_AS_LATE_ADJUSTMENT',
    adjustmentStatus: 'APPLIED_AS_LATE_ADJUSTMENT', adjustmentCount: 1,
    appliedQuantity: -4, checkpointLinked: true, duplicate: true, commands: 1, revisions: 1
  }, 'not-included sale quantity must create exactly one linked late adjustment and stay idempotent');
  assert.match(officialV2Stage5Result.staleCheckpoint.error, /STOCKTAKE_DECISION_TARGET_MISMATCH/);
  assert.deepEqual({ ...officialV2Stage5Result.staleCheckpoint, error: undefined }, {
    error: undefined, submitCount: 0, officialDocument: false
  }, 'a newer checkpoint between preview and commit must fail closed before the first write');
  assert.match(officialV2Stage5Result.rollback.error, /ConstraintError|AbortError|IndexedDB transaction failed/);
  assert.deepEqual({ ...officialV2Stage5Result.rollback, error: undefined }, {
    error: undefined, documentStatus: 'DRAFT', documentRevision: 1,
    revisions: 0, inventory: 0, ledger: 0, commands: 0, queue: 0
  }, 'forced Stage 5 transaction failure must rollback revision, adjustment, ledger, command, and queue together');
  assert.equal(officialV2Stage5Result.companyIsolation, true);
  for (const [kind, appliedQuantity] of [['purchase', 4], ['sale', -4]]) {
    assert.deepEqual(officialV2Stage5Result.mixed[kind], {
      decisions: [
        { productCode: '0007', decisionType: 'INCLUDED_IN_CHECKPOINT' },
        { productCode: '0008', decisionType: 'NOT_INCLUDED_IN_CHECKPOINT' }
      ],
      movementCount: 3,
      adjustmentCount: 1,
      appliedQuantity,
      submitCount: 1
    }, `${kind} two-row voucher must preserve independent included/not-included decisions`);
  }
  assert.deepEqual(officialV2Stage5Result.midCancel, {
    conflictCount: 2,
    submitCount: 0,
    countsUnchanged: true
  }, 'cancelling after an intermediate row choice must leave every official store unchanged');
  if (await evaluate(client, `document.documentElement.dataset.nexusUiTheme==='dark'`)) {
    await click(client, '[data-nexus-ui-theme-toggle]');
    await expr(client, `document.documentElement.dataset.nexusUiTheme==='light'`, 'light theme for stocktake popup');
  }
  const stocktakeUiBefore = await evaluate(client, `(() => {
    const input=document.querySelector('#inputRows input:not([type="checkbox"])');
    if(!input)throw new Error('stocktake state fixture input missing');
    input.dataset.stage5Focus='true';input.focus({preventScroll:true});
    if(typeof input.setSelectionRange==='function')input.setSelectionRange(0,Math.min(1,input.value.length));
    const scroll=document.querySelector('#tableScroll');if(scroll){scroll.scrollTop=17;scroll.scrollLeft=23;}
    const app=document.querySelector('.app-shell').getBoundingClientRect();
    return {value:input.value,start:input.selectionStart,end:input.selectionEnd,scrollTop:scroll?.scrollTop||0,scrollLeft:scroll?.scrollLeft||0,
      selected:[...document.querySelectorAll('#inputRows [data-select-row]')].map(box=>box.checked),
      modeTabs:[...document.querySelectorAll('.mode-tab')].map(button=>button.textContent.trim()),
      footer:[...document.querySelectorAll('.voucher-footer-actions button')].map(button=>button.id),
      app:{x:app.x,y:app.y,width:app.width,height:app.height}};
  })()`);
  await evaluate(client, `(async()=>{const popup=await import('/smartinput/stocktake-conflict-dialog.js?ui-e2e=1');window.__stage5DialogResult='PENDING';window.__stage5DialogPromise=popup.showStocktakeConflictDialog([{
    companyId:'V2-STAGE5-COMPANY',voucherMode:'purchase',documentId:'PD-UI',sourceLineId:'PL-UI-1',checkpointId:'CP-UI',
    productCode:'0007',productName:'실사 충돌 상품',warehouseName:'단계5창고',quantity:10
  },{
    companyId:'V2-STAGE5-COMPANY',voucherMode:'purchase',documentId:'PD-UI',sourceLineId:'PL-UI-2',checkpointId:'CP-UI',
    productCode:'0008',productName:'혼합결정 상품',warehouseName:'단계5창고',quantity:4
  }]).then(value=>{window.__stage5DialogResult=value;return value;});return true;})()`);
  await expr(client, `Boolean(document.querySelector('dialog.stocktake-conflict-dialog[open]'))`, 'light stocktake popup');
  const stocktakePopupContract = await evaluate(client, `(() => {const dialog=document.querySelector('dialog.stocktake-conflict-dialog');return {
    message:dialog.querySelector('#stocktakeConflictMessage').textContent.trim(),
    question:dialog.querySelector('.stocktake-conflict-dialog__question').textContent.trim(),
    row:dialog.querySelector('.stocktake-conflict-dialog__row').textContent.replace(/\s+/g,' ').trim(),
    buttons:[...dialog.querySelectorAll('footer button')].map(button=>button.textContent.trim()),
    labelledBy:dialog.getAttribute('aria-labelledby'),describedBy:dialog.getAttribute('aria-describedby'),
    focused:document.activeElement?.textContent.trim()};})()`);
  assert.deepEqual(stocktakePopupContract.buttons, ['실사수량에 포함됨', '실사수량에 포함되지 않음', '확정 취소']);
  assert.equal(stocktakePopupContract.message, '이 전표는 최근 재고실사 이전의 거래입니다.');
  assert.equal(stocktakePopupContract.question, '이 수량이 실사 결과에 이미 포함되어 있습니까?');
  assert.match(stocktakePopupContract.row, /0007 \/ 실사 충돌 상품.*단계5창고.*수량 10/);
  assert.deepEqual({ labelledBy: stocktakePopupContract.labelledBy, describedBy: stocktakePopupContract.describedBy },
    { labelledBy: 'stocktakeConflictTitle', describedBy: 'stocktakeConflictMessage' });
  assert.equal(stocktakePopupContract.focused, '실사수량에 포함됨');
  const stocktakeLightShot = await capture(client, 'smartinput-stocktake-conflict-light.png');
  baselineScreenshots.push(stocktakeLightShot);
  await click(client, 'dialog.stocktake-conflict-dialog [data-stocktake-decision="INCLUDED_IN_CHECKPOINT"]');
  await expr(client, `window.__stage5DialogResult==='PENDING'&&document.querySelector('dialog.stocktake-conflict-dialog[open]')?.textContent.includes('0008 / 혼합결정 상품')`,
    'stocktake popup must advance one row without persisting the first selection');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await expr(client, `window.__stage5DialogResult===null&&!document.querySelector('dialog.stocktake-conflict-dialog')`, 'stocktake popup ESC cancel');
  const stocktakeUiAfter = await evaluate(client, `(() => {const input=document.querySelector('[data-stage5-focus="true"]');const scroll=document.querySelector('#tableScroll');const app=document.querySelector('.app-shell').getBoundingClientRect();return {
    value:input.value,start:input.selectionStart,end:input.selectionEnd,scrollTop:scroll?.scrollTop||0,scrollLeft:scroll?.scrollLeft||0,
    selected:[...document.querySelectorAll('#inputRows [data-select-row]')].map(box=>box.checked),
    modeTabs:[...document.querySelectorAll('.mode-tab')].map(button=>button.textContent.trim()),
    footer:[...document.querySelectorAll('.voucher-footer-actions button')].map(button=>button.id),
    app:{x:app.x,y:app.y,width:app.width,height:app.height},focusRestored:document.activeElement===input};})()`);
  assert.deepEqual({ ...stocktakeUiAfter, focusRestored: undefined }, { ...stocktakeUiBefore, focusRestored: undefined },
    'ESC/cancel must preserve input, selection, scroll, selected rows, existing buttons, and layout');
  assert.equal(stocktakeUiAfter.focusRestored, true);

  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='dark'`, 'dark stocktake popup theme');
  await evaluate(client, `(async()=>{const popup=await import('/smartinput/stocktake-conflict-dialog.js?ui-e2e=2');window.__stage5DialogPromise=popup.showStocktakeConflictDialog([{companyId:'V2-STAGE5-COMPANY',voucherMode:'purchase',documentId:'PD-DARK',sourceLineId:'PL-DARK',checkpointId:'CP-DARK',productCode:'0007',productName:'실사 충돌 상품',warehouseName:'단계5창고',quantity:10}]);return true;})()`);
  await expr(client, `Boolean(document.querySelector('dialog.stocktake-conflict-dialog[open]'))`, 'dark stocktake popup');
  const stocktakeDarkShot = await capture(client, 'smartinput-stocktake-conflict-dark.png');
  baselineScreenshots.push(stocktakeDarkShot);
  await click(client, 'dialog.stocktake-conflict-dialog [data-stocktake-cancel]');
  await evaluate(client, `window.__stage5DialogPromise`);
  await click(client, '[data-nexus-ui-theme-toggle]');
  await expr(client, `document.documentElement.dataset.nexusUiTheme==='light'`, 'restore light theme after stocktake popup');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(client, `(async()=>{const popup=await import('/smartinput/stocktake-conflict-dialog.js?ui-e2e=3');window.__stage5DialogResult='PENDING';window.__stage5DialogPromise=popup.showStocktakeConflictDialog([{
    companyId:'V2-STAGE5-COMPANY',voucherMode:'sale',documentId:'SD-MOBILE',sourceLineId:'SL-MOBILE-1',checkpointId:'CP-MOBILE',productCode:'0007',productName:'실사 충돌 상품',warehouseName:'단계5창고',quantity:10
  },{
    companyId:'V2-STAGE5-COMPANY',voucherMode:'sale',documentId:'SD-MOBILE',sourceLineId:'SL-MOBILE-2',checkpointId:'CP-MOBILE',productCode:'0008',productName:'혼합결정 상품',warehouseName:'단계5창고',quantity:4
  }]).then(value=>{window.__stage5DialogResult=value;return value;});return true;})()`);
  await expr(client, `Boolean(document.querySelector('dialog.stocktake-conflict-dialog[open]'))`, 'mobile stocktake popup');
  assert.equal(await evaluate(client, `[...document.querySelectorAll('dialog.stocktake-conflict-dialog footer .button')].every(button=>button.getBoundingClientRect().height>=44&&button.getBoundingClientRect().right<=innerWidth)`), true);
  const stocktakeMobileShot = await capture(client, 'smartinput-stocktake-conflict-mobile.png');
  baselineScreenshots.push(stocktakeMobileShot);
  await click(client, 'dialog.stocktake-conflict-dialog [data-stocktake-decision="INCLUDED_IN_CHECKPOINT"]');
  await expr(client, `window.__stage5DialogResult==='PENDING'&&document.querySelector('dialog.stocktake-conflict-dialog[open]')?.textContent.includes('0008 / 혼합결정 상품')`,
    'mobile stocktake popup second row');
  await click(client, 'dialog.stocktake-conflict-dialog [data-stocktake-decision="NOT_INCLUDED_IN_CHECKPOINT"]');
  await expr(client, `Array.isArray(window.__stage5DialogResult)&&window.__stage5DialogResult.length===2`, 'mobile stocktake mixed decisions');
  const stocktakeSequentialMixed = await evaluate(client, `window.__stage5DialogResult`);
  assert.deepEqual(stocktakeSequentialMixed.map(row => row.decisionType), ['INCLUDED_IN_CHECKPOINT', 'NOT_INCLUDED_IN_CHECKPOINT']);
  assert.equal(new Set(stocktakeSequentialMixed.map(row => row.conflictKey)).size, 2);
  assert.equal(stocktakeSequentialMixed.every(row => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(row.judgedAt)), true);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `window.dispatchEvent(new Event('resize'));true`);
  const officialSyncResult = await evaluate(client, `(async()=>{const originalFetch=window.fetch;const calls=[];localStorage.setItem('oneapp_cloud_sync_url_v1','https://official-sync.test/exec');window.fetch=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);const data=body.action==='orderq_official_sync_push'?{schemaVersion:'ONEAPP_ORDERQ_OFFICIAL_SYNC_V1',companyId:body.companyId,results:body.changes.map((row,index)=>({queueId:row.queueId,status:'applied',sequence:index+1,serverRevision:row.revision})),cursor:body.changes.length}:{schemaVersion:'ONEAPP_ORDERQ_OFFICIAL_SYNC_V1',companyId:body.companyId,changes:[],nextCursor:0,hasMore:false};return {ok:true,json:async()=>({status:'success',data})};};try{const sync=await import('/orderq/official-voucher-sync.js?sync-e2e=1');const result=await sync.syncOfficialVouchers('ONEAPP');const state=await sync.getOfficialSyncState('ONEAPP');return {online:result.online,applied:result.push.applied,waiting:state.waiting,acked:state.acked,actions:calls.map(row=>row.action),companies:[...new Set(calls.map(row=>row.companyId))]};}finally{window.fetch=originalFetch;localStorage.removeItem('oneapp_cloud_sync_url_v1');}})()`);
  assert.equal(officialSyncResult.online, true);
  assert.equal(officialSyncResult.applied >= 2, true, 'legacy waiting official voucher rows must become uploadable without rewriting the local voucher');
  assert.equal(officialSyncResult.waiting, 0);
  assert.equal(officialSyncResult.acked >= 2, true);
  assert.deepEqual(officialSyncResult.actions, ['orderq_official_sync_push', 'orderq_official_sync_pull']);
  assert.deepEqual(officialSyncResult.companies, ['ONEAPP']);
  const remoteOfficialResult = await evaluate(client, `(async()=>{const repo=await import('/orderq/official-voucher-repository.js?remote-e2e=1');const core=await import('/orderq/official-voucher-core.js?remote-e2e=1');const purchaseDocumentId='PD-REMOTE-E2E';const commandId='POST_PURCHASE:REMOTE:E2E';const document={companyId:'REMOTE-COMPANY',purchaseDocumentId,supplierCustomerId:'REMOTE-SUPPLIER',warehouseId:'REMOTE-WH',purchaseDate:'2026-09-01',status:'DRAFT',businessStatus:'DRAFT',revision:1};const lines=[{purchaseLineId:'PL-REMOTE-E2E',purchaseDocumentId,lineIdentityId:'LI-REMOTE-E2E',productId:'REMOTE-PRODUCT',warehouseId:'REMOTE-WH',actualQuantity:4,baseQuantity:4,unitPrice:1250,supplyAmount:5000,totalAmount:5000}];const command={...document,document,lines,commandType:'POST_PURCHASE',commandId,idempotencyKey:commandId,expectedRevision:1,actor:'REMOTE-DEVICE',occurredAt:'2026-09-01T09:00:00.000Z'};const plan=core.planOfficialVoucherCommand({command,document,lines});const payload={schemaVersion:'ONEAPP_ORDERQ_OFFICIAL_COMMAND_PAYLOAD_V1',companyId:'REMOTE-COMPANY',voucherMode:'purchase',documentId:purchaseDocumentId,command,projectionDigest:core.canonicalSha256(plan.voucherRevision)};const applied=await repo.applyRemoteOfficialVoucherCommandPayload(payload);const duplicate=await repo.applyRemoteOfficialVoucherCommandPayload(payload);const aggregate=await repo.loadOfficialPurchaseAggregate(purchaseDocumentId);return {authority:applied.authority,inventory:aggregate.inventoryMovements[0]?.signedQuantity,payable:aggregate.ledgerEntries[0]?.totalAmount,revision:aggregate.document.revision,duplicate:duplicate.duplicate,commands:aggregate.commands.length};})()`);
  assert.deepEqual(remoteOfficialResult, { authority: 'CLOUD_REPLICA', inventory: 4, payable: 5000, revision: 2, duplicate: true, commands: 1 },
    'remote official command must materialize voucher, inventory, payable, revision, and idempotency in one IndexedDB transaction');
  const remoteResolutionResult = await evaluate(client, `(async()=>{const repo=await import('/orderq/official-voucher-repository.js?remote-resolution-e2e=1');const core=await import('/orderq/official-voucher-core.js?remote-resolution-e2e=1');const rematch=await import('/orderq/inventory-rematch-core.js?remote-resolution-e2e=1');const purchaseDocumentId='PD-REMOTE-UNMATCHED';const commandId='POST_PURCHASE:REMOTE:UNMATCHED';const document={companyId:'REMOTE-COMPANY',purchaseDocumentId,supplierCustomerId:'REMOTE-SUPPLIER',warehouseId:'REMOTE-WH',purchaseDate:'2026-09-02',status:'DRAFT',businessStatus:'DRAFT',revision:1};const lines=[{purchaseLineId:'PL-REMOTE-UNMATCHED',purchaseDocumentId,lineIdentityId:'LI-REMOTE-UNMATCHED',unresolvedProductId:'UP-REMOTE-E2E',warehouseId:'REMOTE-WH',actualQuantity:2,baseQuantity:2,unitPrice:500,supplyAmount:1000,totalAmount:1000}];const command={...document,document,lines,commandType:'POST_PURCHASE',commandId,idempotencyKey:commandId,expectedRevision:1,actor:'REMOTE-DEVICE',occurredAt:'2026-09-02T09:00:00.000Z'};const planned=core.planOfficialVoucherCommand({command,document,lines});await repo.applyRemoteOfficialVoucherCommandPayload({schemaVersion:'ONEAPP_ORDERQ_OFFICIAL_COMMAND_PAYLOAD_V1',companyId:'REMOTE-COMPANY',voucherMode:'purchase',documentId:purchaseDocumentId,command,projectionDigest:core.canonicalSha256(planned.voucherRevision)});const aggregate=await repo.loadOfficialPurchaseAggregate(purchaseDocumentId);const resolutionPlan=rematch.planPendingInventoryResolution({companyId:'REMOTE-COMPANY',unresolvedProductId:'UP-REMOTE-E2E',productId:'REMOTE-RESOLVED',pendingEffects:aggregate.pendingInventoryEffects,inventoryCheckpoints:[],actor:'REMOTE-DEVICE',occurredAt:'2026-09-03T09:00:00.000Z'});const applied=await repo.applyRemotePendingInventoryResolutionPayload({...resolutionPlan,resolutionDigest:core.canonicalSha256(resolutionPlan)});const duplicate=await repo.applyRemotePendingInventoryResolutionPayload({...resolutionPlan,resolutionDigest:core.canonicalSha256(resolutionPlan)});return {movement:applied.inventoryMovements[0]?.signedQuantity,status:applied.productResolution.status,duplicate:duplicate.duplicate};})()`);
  assert.deepEqual(remoteResolutionResult, { movement: 2, status: 'MATCHED', duplicate: true },
    'remote unmatched-product resolution must apply its authoritative inventory decision once');
  await input(client, '#deliveryDateInput', '2026-08-29');
  await expr(client, `document.querySelector('#voucherContextDelivery').textContent.includes('READY')&&document.querySelector('#voucherContextList').textContent.includes('격리 검증 거래처')`, 'date-scoped order activity adapter');
  assert.match(await evaluate(client, `document.querySelector('#voucherContextList .voucher-activity-item a')?.getAttribute('href')||''`), new RegExp(`voucher-query\\.html\\?mode=order&date=2026-08-29&focus=${orderResult.orderId}`), 'activity card must route to read-only voucher detail without replacing the worktable');
  await wait(350);

  const documentId = await evaluate(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.order.documentId`);
  await evaluate(client, `(async()=>{window.dispatchEvent(new PageTransitionEvent('pagehide'));const store=await import('/smartinput/smartinput-data-store.js');await store.saveSourceImage({documentId:${JSON.stringify(documentId)},mode:'order',sourceImageId:'E2E-SOURCE-IMAGE',fileName:'원본.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',notice:'저장 원본'});const draft=JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1'));draft.modes.order.activeMethod='photo';draft.futureRoot='KEEP-UNKNOWN';draft.modes.order.futureMode='KEEP-MODE';localStorage.setItem('oneapp.smartinput.draft.v1',JSON.stringify(draft));return true;})()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: false });
  await loaded;
  try {
    await expr(client, `document.querySelector('#photoPreview')?.dataset.sourceImageId==='E2E-SOURCE-IMAGE'&&!document.querySelector('#photoViewer').hidden`, 'source image reload', 30_000);
  } catch (error) {
    const sourceDiagnostic = await evaluate(client, `({method:JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1'))?.modes?.order?.activeMethod,preview:document.querySelector('#photoPreview')?.dataset.sourceImageId,viewerHidden:document.querySelector('#photoViewer')?.hidden,status:document.querySelector('#appStatusMessage')?.textContent})`);
    throw new Error(`${error.message} · ${JSON.stringify(sourceDiagnostic)}`);
  }
  assert.equal(await evaluate(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).futureRoot`), 'KEEP-UNKNOWN', 'unknown draft fields must survive reload');
  const photoShot = await capture(client, 'smartinput-0a-photo-reload.png');

  if (await evaluate(client, `document.documentElement.dataset.nexusUiTheme==='dark'`)) {
    await click(client, '[data-nexus-ui-theme-toggle]');
    await expr(client, `document.documentElement.dataset.nexusUiTheme==='light'`, 'light theme for purchase and sale baselines');
    await wait(200);
  }
  await evaluate(client, `Promise.all([...document.querySelectorAll('.brand__logo')].map(image=>image.decode?.().catch(()=>{})||Promise.resolve())).then(()=>true)`);
  for (const mode of ['purchase', 'sale']) {
    const modeFlowStartedAt = performance.now();
    let dateDeleteEvidence = null;
    await click(client, `[data-mode="${mode}"]`);
    await click(client, '#addRowButton');
    await click(client, '#customerSearchButton');
    await expr(client, `Boolean(document.querySelector('.smart-customer-dialog [data-customer-id="E2E-CUSTOMER"] input[type="checkbox"]'))`, `${mode} customer fixture in chooser`);
    await click(client, '.smart-customer-dialog [data-customer-id="E2E-CUSTOMER"] input[type="checkbox"]');
    await click(client, '.smart-customer-dialog [data-customer-use]');
    await expr(client, `document.querySelector('#customerInput').dataset.customerId==='E2E-CUSTOMER'&&!document.querySelector('.smart-customer-dialog')`, `${mode} customer selected`);
    if (mode === 'purchase') {
      await input(client, '#deliveryDateInput', '2026-09-17');
      const displayedAfterDelete = await input(client, '#deliveryDateInput', '');
      assert.equal(displayedAfterDelete, '2026-09-01', 'clearing the native date input must restore the preserved month at day 1');
      await expr(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.purchase.header.voucherDate==='2026-09-01'`, 'date deletion persisted to compatibility draft');
      await expr(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?date-delete-e2e=1');const record=await store.loadLatestAutosave();return record?.draft?.modes?.purchase?.header?.voucherDate==='2026-09-01';})()`, 'date deletion persisted to autosave draft');
      dateDeleteEvidence = await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?date-delete-read-e2e=1');const record=await store.loadLatestAutosave();const local=JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.purchase.header;return {deletedFrom:'2026-09-17',displayed:document.querySelector('#deliveryDateInput').value,compatibilityDraft:local.voucherDate,monthAnchor:local.voucherDateMonthAnchor,autosaveDraft:record.draft.modes.purchase.header.voucherDate};})()`);
    } else {
      await input(client, '#deliveryDateInput', '2026-09-02');
    }
    await input(client, '#warehouseInput', '격리 검증 창고');
    await typeWithoutBlur(client, '#inputRows [data-field="itemCode"]', '마스터 최신 사과');
    await evaluate(client, `document.querySelector('#inputRows [data-field="itemCode"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true`);
    await expr(client, `document.querySelector('#inputRows [data-field="itemCode"]')?.value==='MASTER-1'`, `${mode} exact product selected`);
    await input(client, '#inputRows [data-field="quantity"]', '2');
    await input(client, '#inputRows [data-field="unitPrice"]', '1500');
    const modeDom = await evaluate(client, `(() => ({
      mode:document.querySelector('.mode-tab.is-active')?.dataset.mode,
      customerLabel:document.querySelector('#customerFieldLabel').childNodes[0]?.textContent.trim(),
      dateLabel:document.querySelector('[data-header-field="deliveryDate"]>span').textContent.trim(),
      warehouseLabel:document.querySelector('[data-header-field="warehouse"]>span').textContent.replace(/필수/g,'').trim(),
      saveLabel:document.querySelector('#completeButton').textContent.trim(),
      rowCount:document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length,
      rowValues:['itemCode','itemName','quantity','unit','unitPrice'].map(field=>document.querySelector('#inputRows [data-field="'+field+'"]')?.value||''),
      amount:document.querySelector('#inputRows [data-supply-amount]')?.value||'',
      layout:{parser:Math.round(document.querySelector('.parser-card').getBoundingClientRect().width),workbench:Math.round(document.querySelector('.workbench').getBoundingClientRect().width),related:Math.round(document.querySelector('.related-panel').getBoundingClientRect().width)}
    }))()`);
    assert.equal(modeDom.mode, mode);
    assert.equal(modeDom.dateLabel, mode === 'purchase' ? '구매일자' : '판매일자');
    assert.equal(modeDom.saveLabel, '저장');
    assert.equal(modeDom.amount, '3,000');
    const modeEntryReadyMs = Number((performance.now() - modeFlowStartedAt).toFixed(2));
    await evaluate(client, `document.querySelector('#toast').hidden=true;true`);
    const modeShot = await capture(client, `smartinput-v2-baseline-${mode}.png`);
    baselineScreenshots.push(modeShot);
    const rowsBefore = await evaluate(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length`);
    assert.equal(rowsBefore, 1);
    const saveStartedAt = performance.now();
    await click(client, '#completeButton');
    await expr(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length===0&&document.querySelector('#appStatus').textContent.includes('저장 완료')`, `${mode} official save completion`);
    const saveFeedbackMs = Number((performance.now() - saveStartedAt).toFixed(2));
    const feedback = await evaluate(client, `document.querySelector('#appStatus').textContent.trim()`);
    assert.match(feedback, mode === 'purchase' ? /공식 구매전표 1건 저장 완료/ : /공식 판매전표 1건 저장 완료/);
    if (mode === 'purchase') {
      dateDeleteEvidence.savedRequest = await evaluate(client, `(async()=>{const draft=JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1'));const pointer=draft.modes.purchase.purchaseSubmissions.at(-1);const repo=await import('/orderq/official-voucher-repository.js?date-delete-read-e2e=1');const aggregate=await repo.loadOfficialPurchaseAggregate(pointer.purchaseDocumentId);return aggregate.document.purchaseDate;})()`);
      assert.deepEqual(dateDeleteEvidence, {
        deletedFrom: '2026-09-17',
        displayed: '2026-09-01',
        compatibilityDraft: '2026-09-01',
        monthAnchor: '2026-09',
        autosaveDraft: '2026-09-01',
        savedRequest: '2026-09-01'
      }, 'native date deletion must agree across display, both draft stores, and the official save request');
    }
    officialSaveEntryEvidence.push({
      mode,
      clickCount: 6,
      clickDefinition: 'mode tab + add row + customer chooser + customer checkbox + chooser apply + Save; field and product entry use keyboard',
      modeAndEntryReadyMs: modeEntryReadyMs,
      saveFeedbackMs,
      currentResult: 'SAVED',
      feedback,
      ...(dateDeleteEvidence ? { dateDeleteEvidence } : {}),
      dom: modeDom
    });
  }

  const headerBeforeEstimate = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:Math.round(r.x),width:Math.round(r.width),height:Math.round(r.height)};};return {customer:q('.header-customer-group'),fields:q('.header-fields')};})()`);
  await click(client, '[data-mode="estimate"]');
  const estimateHeader = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:Math.round(r.x),width:Math.round(r.width),height:Math.round(r.height)};};const warehouse=document.querySelector('[data-header-field="warehouse"]');const transaction=document.querySelector('[data-header-field="transactionType"]');return {label:document.querySelector('[data-header-field="deliveryDate"]>span').textContent.trim(),warehouseLabel:warehouse.querySelector('span').textContent.trim(),warehouseHidden:warehouse.hidden,transactionHidden:transaction.hidden,transactionVisibility:getComputedStyle(transaction).visibility,contextHidden:document.querySelector('#voucherContextView').hidden,estimateHeadingVisible:!document.querySelector('#estimateLibraryHeading').hidden,individualText:document.querySelector('#estimateLibraryIndividualButton').textContent.trim(),linkedText:document.querySelector('#estimateLibraryLinkedButton').textContent.trim(),multiLabel:document.querySelector('#estimateMultiSelectButton').getAttribute('aria-label'),customer:q('.header-customer-group'),fields:q('.header-fields')};})()`);
  assert.deepEqual({ label: estimateHeader.label, warehouseLabel: estimateHeader.warehouseLabel, warehouseHidden: estimateHeader.warehouseHidden, transactionHidden: estimateHeader.transactionHidden, transactionVisibility: estimateHeader.transactionVisibility, contextHidden: estimateHeader.contextHidden, estimateHeadingVisible: estimateHeader.estimateHeadingVisible, individualText: estimateHeader.individualText, linkedText: estimateHeader.linkedText, multiLabel: estimateHeader.multiLabel }, { label: '견적 작성일', warehouseLabel: '최종수정일', warehouseHidden: false, transactionHidden: false, transactionVisibility: 'hidden', contextHidden: true, estimateHeadingVisible: true, individualText: '견적서 목록', linkedText: '연동견적서', multiLabel: '견적서 다중 선택' }, 'estimate mode must restore the dedicated estimate-list rail without the voucher activity view');
  assert.deepEqual(estimateHeader.customer, headerBeforeEstimate.customer, 'customer entry position and size must stay fixed across voucher switching');
  assert.deepEqual(estimateHeader.fields, headerBeforeEstimate.fields, 'header field shell must stay fixed across voucher switching');
  assert.equal(await evaluate(client, `!document.querySelector('#estimateEditorView').hidden&&!document.querySelector('#sourceInputPanel').hidden&&document.querySelector('#tableScroll').offsetWidth>0&&!document.querySelector('#estimateLibraryButton')&&!document.querySelector('#estimateEditorButton')`), true, 'estimate mode must always preserve the parser and table beside the right list');
  assert.equal(await evaluate(client, `(() => {const search=document.querySelector('#gridSearchInput').getBoundingClientRect();const stats=document.querySelector('#gridRowCount').getBoundingClientRect();const reset=document.querySelector('#resetDraftButton').getBoundingClientRect();return Math.abs(search.y-stats.y)<12&&Math.abs(search.y-reset.y)<12&&!document.querySelector('.grid-toolbar');})()`), true, 'all table search, counts, and editing controls must share one toolbar row');
  const estimateRailFooter = await evaluate(client, `(() => {const footer=document.querySelector('#catalogComposeArea').getBoundingClientRect();const buttons=[...document.querySelectorAll('#catalogComposeArea .button')].map(button=>{const rect=button.getBoundingClientRect();return {id:button.id,y:Math.round(rect.y),height:Math.round(rect.height),hidden:button.hidden};});return {height:Math.round(footer.height),buttons};})()`);
  assert.equal(estimateRailFooter.height <= 44, true, 'right rail footer must not exceed 44px');
  assert.deepEqual(estimateRailFooter.buttons.map(button => button.id), ['selectedEstimateDeleteButton', 'estimateRenameButton'], 'right rail footer must contain only deletion and rename');
  assert.equal(new Set(estimateRailFooter.buttons.map(button => button.y)).size, 1, 'right rail actions must remain horizontal');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('#estimateOutputActions .button')].map(button=>button.id)`), ['estimateCreateButton', 'saveEstimateAsButton', 'estimateNoticeButton', 'estimateExcelButton'], 'estimate table footer must keep linked creation, Save As, Kakao, and Excel in the approved order');
  await click(client, '#addRowButton');
  await input(client, '#inputRows [data-field="itemCode"]', 'EST-1');
  await input(client, '#inputRows [data-field="itemName"]', '견적 상품');
  await input(client, '#inputRows [data-field="quantity"]', '2');
  await input(client, '#inputRows [data-field="unitPrice"]', '1500');
  assert.equal(await evaluate(client, `document.querySelector('#completeButton').textContent.trim()`), '저장');
  await click(client, '#completeButton');
  await expr(client, `Boolean(document.querySelector('[data-estimate-name]'))`, 'estimate save dialog');
  await expr(client, `document.activeElement?.matches('[data-estimate-name]')`, 'estimate name direct-input focus');
  await expr(client, `(() => {const input=document.querySelector('[data-estimate-name]');return input.selectionStart===0&&input.selectionEnd===input.value.length;})()`, 'default estimate name selection for immediate replacement');
  await input(client, '[data-estimate-name]', '격리 견적');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelector('#catalogPickerList [data-select-estimate-card]')?.textContent.includes('격리 견적')`, 'individual estimate persisted');
  assert.equal(await evaluate(client, `document.querySelector('#customerInput').value`), '', 'successful voucher save must clear the customer field');
  const savedEstimateId = await evaluate(client, `document.querySelector('#catalogPickerList [data-estimate-id]').dataset.estimateId`);
  assert.equal(await evaluate(client, `document.querySelector('#catalogPickerList [data-estimate-id]').classList.contains('is-selected')`), true, 'a saved estimate must remain the one lit active card');
  await input(client, '#inputRows [data-field="unitPrice"]', '1750');
  await click(client, '#completeButton');
  await expr(client, `!document.querySelector('#completeButton').disabled&&!document.querySelector('[data-estimate-name]')&&document.querySelector('#catalogPickerList [data-estimate-id="${savedEstimateId}"]')?.classList.contains('is-selected')`, 'existing estimate in-place save without a new-name dialog');
  assert.equal(await evaluate(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length`), 1, 'in-place estimate save must not create a duplicate record');
  await click(client, '#resetDraftButton');
  await click(client, '#addRowButton');
  await evaluate(client, `(() => {const element=document.querySelector('#inputRows tr[data-default-row="true"] [data-field="itemCode"]');element.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,'EST-2');element.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `document.activeElement?.dataset?.field==='itemCode'&&document.activeElement?.closest('tr')?.dataset.defaultRow!=='true'&&document.querySelectorAll('#inputRows tr[data-default-row="true"]').length===1`), true, 'materializing the trailing row must preserve keyboard focus and append one new manual row without rerendering the active cell');
  await input(client, '#inputRows [data-field="itemName"]', '행사 견적 상품');
  await input(client, '#inputRows [data-field="quantity"]', '3');
  await input(client, '#inputRows [data-field="unitPrice"]', '2400');
  await input(client, '#inputRows tr[data-default-row="true"] [data-field="itemCode"]', 'EST-1');
  await input(client, '#inputRows tr:nth-last-child(2) [data-field="itemName"]', '견적 상품');
  await input(client, '#inputRows tr:nth-last-child(2) [data-field="quantity"]', '4');
  await input(client, '#inputRows tr:nth-last-child(2) [data-field="unitPrice"]', '1500');
  assert.equal(await evaluate(client, `document.querySelectorAll('#inputRows tr[data-default-row="true"]').length`), 1, 'manual entry must materialize the row and immediately append exactly one new trailing row');
  await click(client, '#completeButton');
  await expr(client, `Boolean(document.querySelector('[data-estimate-name]'))`, 'second estimate save dialog');
  await input(client, '[data-estimate-name]', '행사 원본 견적');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===2`, 'two individual estimates persisted');
  const estimateCardsShot = await capture(client, 'smartinput-estimate-library-cards.png');
  assert.equal(await evaluate(client, `document.querySelectorAll('#catalogPickerList input[type="checkbox"],#catalogPickerList [data-edit-estimate]').length`), 0, 'estimate cards must have no checkbox or per-card management button');
  await evaluate(client, `(() => {const cards=[...document.querySelectorAll('#catalogPickerList [data-estimate-id]')];window.__estimateCardOrder=cards.map(card=>card.dataset.estimateId);const handle=cards[0].querySelector('[data-estimate-drag-handle]');const transfer=new DataTransfer();handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));cards[1].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));cards[1].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));return true;})()`);
  await expr(client, `document.querySelector('#catalogPickerList [data-estimate-id]')?.dataset.estimateId===window.__estimateCardOrder[1]`, 'handle-only estimate card drag reorder');
  await evaluate(client, `(() => {const cards=[...document.querySelectorAll('#catalogPickerList [data-estimate-id]')];const handle=cards[0].querySelector('[data-estimate-drag-handle]');const transfer=new DataTransfer();handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));cards[1].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));cards[1].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));return true;})()`);
  await expr(client, `document.querySelector('#catalogPickerList [data-estimate-id]')?.dataset.estimateId===window.__estimateCardOrder[0]`, 'estimate card drag order restore');
  await wait(350);
  await click(client, '#catalogPickerList .estimate-card:not(.is-selected) [data-select-estimate-card]');
  await expr(client, `document.querySelectorAll('#catalogPickerList .is-selected').length===1`, 'normal card touch must switch to exactly one open estimate');
  await evaluate(client, `(() => {const target=document.querySelector('#catalogPickerList .estimate-card:not(.is-selected) [data-select-estimate-card]');target.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true;})()`);
  await expr(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#catalogPickerList .is-selected').length===2`, 'Ctrl+click must enter the same ordered multiselect and add the touched estimate');
  await click(client, '#estimateMultiSelectButton');
  await expr(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='false'&&document.querySelectorAll('#catalogPickerList .is-selected').length===1`, 'plus must cancel multiselect and restore the previously open estimate');
  await click(client, '#estimateMultiSelectButton');
  await expr(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#catalogPickerList .is-selected').length===1&&document.querySelector('#estimateCreateButton').disabled`, 'plus must enter multiselect while carrying the open estimate');
  await click(client, '#catalogPickerList .estimate-card:not(.is-selected) [data-select-estimate-card]');
  await expr(client, `document.querySelectorAll('#catalogPickerList .is-selected').length===2&&document.querySelectorAll('.estimate-card__selection-order').length===2`, 'creation mode card touches must accumulate ordered selections');
  await expr(client, `document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length===2&&document.querySelectorAll('#inputRows .linked-row-badge').length===2`, 'linked creation preview with duplicate products removed');
  assert.match(await evaluate(client, `document.querySelector('#inputRows .linked-row-badge')?.textContent`), /2개 견적서/, 'deduplicated row must retain both source links');
  assert.match(await evaluate(client, `document.querySelector('#estimateSelectionSummary').textContent.trim()`), /다중 선택 · 2개 선택 · 미리보기/, 'multiselect status must distinguish selected sources and preview');
  assert.equal(await evaluate(client, `!/중복 제거|상품 미리보기/.test(document.querySelector('#toast').textContent)`), true, 'estimate selection must not create a redundant lower coachmark');
  assert.equal(await evaluate(client, `document.querySelector('#estimateCreateButton').textContent.trim()`), '연동견적서 생성', 'linked creation belongs in the main table footer');
  await click(client, '#estimateCreateButton');
  await expr(client, `Boolean(document.querySelector('[data-estimate-name]'))`, 'linked estimate save dialog');
  await input(client, '[data-estimate-name]', '가을 행사 연동견적');
  await click(client, '[data-confirm-save]');
  await expr(client, `!document.querySelector('#linkedEstimateList').hidden&&Boolean(document.querySelector('#linkedEstimateList [data-estimate-kind="LINKED_GROUP"]'))`, 'linked estimate persisted and linked list selected');
  assert.match(await evaluate(client, `document.querySelector('#estimateSelectionSummary').textContent.trim()`), /저장 완료.*연결 2개/, 'fixed estimate status must report saved linked-source count');
  assert.match(await evaluate(client, `document.querySelector('#linkedEstimateList [data-select-estimate-card] small')?.textContent`), /작성 .*수정/, 'estimate cards must distinguish immutable creation and latest modification dates');
  await click(client, '#estimateLibraryIndividualButton');
  await click(client, '#catalogPickerList [data-select-estimate-card]');
  await expr(client, `document.querySelectorAll('#catalogPickerList .is-selected').length===1`, 'individual source selected before protected deletion');
  await click(client, '#selectedEstimateDeleteButton');
  await expr(client, `document.querySelector('#toast').textContent.includes('연동견적서에서 사용 중')`, 'linked source deletion blocked');
  assert.equal(await evaluate(client, `(() => {const toast=document.querySelector('#toast').getBoundingClientRect();const actions=document.querySelector('#catalogComposeArea').getBoundingClientRect();return toast.bottom<=actions.top;})()`), true, 'required error notifications must stay above the lower action buttons');
  assert.equal(await evaluate(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length`), 2, 'linked source protection must preserve all selected individual estimates');
  await click(client, '#estimateLibraryLinkedButton');
  await click(client, '#linkedEstimateList [data-select-estimate-card]');
  assert.ok(await evaluate(client, `document.querySelectorAll('#inputRows .linked-value-conflict').length>=1`), 'different source values must be identified instead of silently overwritten');
  await input(client, '#inputRows [data-field="quantity"]', '9');
  await wait(500);
  assert.equal(await evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readonly');const get=tx.objectStore('estimates').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result.some(record=>record.estimateKind!=='LINKED_GROUP'&&record.draft?.rows?.some(row=>Number(row.quantity)===9)));db.close();};};})`), false, 'autosave must not write linked edits into source estimates');
  await click(client, '#completeButton');
  const linkedSourceId = await expr(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readonly');const get=tx.objectStore('estimates').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(get.result.find(record=>record.estimateKind!=='LINKED_GROUP'&&record.draft?.rows?.some(row=>Number(row.quantity)===9))?.estimateId||'');db.close();};};})`, 'linked source write-through record');
  await click(client, '#estimateLibraryIndividualButton');
  await click(client, `#catalogPickerList [data-estimate-id="${linkedSourceId}"] [data-select-estimate-card]`);
  await expr(client, `[...document.querySelectorAll('#inputRows [data-field="quantity"]')].some(input=>input.value==='9')`, 'linked edit written through to individual estimate');
  await input(client, '#inputRows [data-field="quantity"]', '11');
  await wait(500);
  await click(client, '#completeButton');
  await expr(client, `!document.querySelector('#completeButton').disabled&&document.querySelector('#appStatus').textContent.includes('저장 완료')`, 'individual estimate explicit save completion');
  assert.match(await evaluate(client, `document.querySelector('#estimateSelectionSummary').textContent.trim()`), /저장 완료.*연결 1개.*반영 1건/, 'fixed estimate status must report explicit linked write impact');
  await click(client, '#estimateLibraryLinkedButton');
  await expr(client, `!document.querySelector('#linkedEstimateList').hidden&&Boolean(document.querySelector('#linkedEstimateList [data-select-estimate-card]'))`, 'linked estimate list');
  await click(client, '#linkedEstimateList [data-select-estimate-card]');
  await expr(client, `[...document.querySelectorAll('#inputRows [data-field="quantity"]')].some(input=>input.value==='11')`, 'individual edit reflected in linked estimate');
  await click(client, '#saveEstimateAsButton');
  await input(client, '[data-estimate-name]', '가을 행사 연동견적 수정');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelectorAll('#linkedEstimateList [data-estimate-kind="LINKED_GROUP"]').length===2&&[...document.querySelectorAll('#linkedEstimateList [data-select-estimate-card]')].some(button=>button.textContent.includes('가을 행사 연동견적 수정'))`, 'Save As must create a new named form and preserve the original');
  await evaluate(client, `window.XLSX={utils:{book_new:()=>({names:[]}),aoa_to_sheet:data=>data,book_append_sheet:(book,sheet,name)=>book.names.push(name)},writeFile:(book,name)=>{window.__estimateExportName=name;window.__estimateExportSheets=book.names}};true`);
  await click(client, '#estimateExcelButton');
  await expr(client, `Boolean(window.__estimateExportName)`, 'estimate export');
  assert.match(await evaluate(client, `window.__estimateExportName`), /견적F8/);
  assert.deepEqual(await evaluate(client, `window.__estimateExportSheets`), ['쇼핑몰업로드','ERP업데이트','오류정보'], 'SmartInput Excel must place usable data sheets before errors');
  await click(client, '#estimateLibraryIndividualButton');
  await click(client, '#catalogPickerList [data-select-estimate-card]');
  const renameTargetId = await evaluate(client, `document.querySelector('#catalogPickerList .is-selected').dataset.estimateId`);
  await click(client, '#estimateRenameButton');
  await expr(client, `document.activeElement?.matches('[data-estimate-rename]')`, 'rename dialog direct input focus');
  await input(client, '[data-estimate-rename]', '이름 변경된 견적');
  await click(client, '[data-confirm-rename]');
  await expr(client, `document.querySelector('#catalogPickerList [data-estimate-id="${renameTargetId}"] [data-select-estimate-card]')?.textContent.includes('이름 변경된 견적')`, 'single estimate rename persisted without changing its id');
  await click(client, '#saveEstimateAsButton');
  await input(client, '[data-estimate-name]', '삭제 확인용 사본');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===3`, 'one-source independent copy creation');
  await evaluate(client, `window.__estimateDeleteConfirmCalls=0;window.confirm=()=>{window.__estimateDeleteConfirmCalls+=1;return true;};true`);
  await click(client, '#selectedEstimateDeleteButton');
  await expr(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===2`, 'single selected estimate deletion');
  assert.equal(await evaluate(client, `window.__estimateDeleteConfirmCalls`), 0, 'one selected card deletion must proceed without a redundant confirmation');
  await click(client, '#catalogPickerList [data-select-estimate-card]');
  await click(client, '#saveEstimateAsButton');
  await input(client, '[data-estimate-name]', '다중 삭제 사본 A');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===3`, 'first disposable copy');
  await click(client, '#saveEstimateAsButton');
  await input(client, '[data-estimate-name]', '다중 삭제 사본 B');
  await click(client, '[data-confirm-save]');
  await expr(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===4`, 'second disposable copy');
  await click(client, '#estimateMultiSelectButton');
  await evaluate(client, `(() => {const cards=[...document.querySelectorAll('#catalogPickerList [data-estimate-id]')].filter(card=>/다중 삭제 사본/.test(card.textContent));const selected=cards.find(card=>!card.classList.contains('is-selected'));selected?.querySelector('[data-select-estimate-card]').click();return cards.length;})()`);
  await expr(client, `[...document.querySelectorAll('#catalogPickerList .is-selected')].filter(card=>/다중 삭제 사본/.test(card.textContent)).length===2`, 'explicit multiselect for two disposable copies');
  await click(client, '#selectedEstimateDeleteButton');
  await expr(client, `document.querySelectorAll('#catalogPickerList [data-estimate-id]').length===2`, 'confirmed multiple deletion');
  assert.equal(await evaluate(client, `window.__estimateDeleteConfirmCalls`), 1, 'two selected cards must require one confirmation');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.reload', { ignoreCache: true });
  await expr(client, `document.readyState==='complete'&&Boolean(document.querySelector('#relatedPanelCloseButton'))`, 'intermediate layout reload');
  await evaluate(client, `window.dispatchEvent(new Event('resize'));true`);
  await expr(client, `(() => {const panel=document.querySelector('#estimateLibraryView').getBoundingClientRect();const appBar=document.querySelector('.app-bar').getBoundingClientRect();return panel.top>=appBar.bottom-1;})()`, 'intermediate panel positioned below app header');
  const intermediatePanel = await evaluate(client, `(() => {const workspace=document.querySelector('#smartInputWorkspace');const panel=document.querySelector('#estimateLibraryView').getBoundingClientRect();const appBar=document.querySelector('.app-bar').getBoundingClientRect();const global=document.querySelector('.nexus-ui-header').getBoundingClientRect();const close=document.querySelector('#relatedPanelCloseButton').getBoundingClientRect();return {panelTop:panel.top,panelHeight:panel.height,appBarTop:appBar.top,appBarHeight:appBar.height,appBarBottom:appBar.bottom,globalBottom:global.bottom,customTop:workspace.style.getPropertyValue('--related-panel-top'),closeTop:close.top,closeHeight:close.height,closeText:document.querySelector('#relatedPanelCloseButton').textContent.trim(),legacyCollapse:getComputedStyle(document.querySelector('#relatedCollapseButton')).display};})()`);
  console.log('SmartInput intermediate panel metrics', intermediatePanel);
  assert.ok(intermediatePanel.panelTop >= intermediatePanel.appBarBottom - 1 && Math.abs((intermediatePanel.closeTop + intermediatePanel.closeHeight / 2) - (intermediatePanel.panelTop + intermediatePanel.panelHeight / 2)) <= 2, 'intermediate right drawer must begin below the app header and center its hover X on the right edge');
  assert.equal(intermediatePanel.closeText, '×', 'the top labeled close control must stay removed');
  assert.equal(intermediatePanel.legacyCollapse, 'none', 'intermediate right drawer must not expose the legacy lower close button');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(200);
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#relatedPanelResizer')).display`), 'none', 'mobile right panel must not expose width resizing');
  await click(client, '#relatedPanelCloseButton');
  await expr(client, `document.querySelector('#relatedPanelToggle').getAttribute('aria-expanded')==='false'`, 'mobile right panel close');
  await click(client, '#relatedPanelToggle');
  await expr(client, `document.querySelector('#estimateLibraryView').classList.contains('is-open')`, 'mobile right panel slide open');
  await click(client, '#relatedPanelCloseButton');
  const mobile = await evaluate(client, `(() => {const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};const tabs=[...document.querySelectorAll('.mode-tab')].map(tab=>q('.mode-tab[data-mode="'+tab.dataset.mode+'"]'));const headerFields=document.querySelector('.header-fields');return {scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,header:q('.nexus-ui-header'),app:q('.app-bar'),appInner:q('.app-bar__inner'),brand:q('.brand'),tabs,headerFields:q('.header-fields'),headerDivider:getComputedStyle(headerFields).borderTopWidth,actions:q('.app-bar__actions'),parser:q('.parser-card'),workbench:q('.workbench')};})()`);
  console.log('SmartInput mobile metrics', mobile);
  assert.ok(mobile.header.height >= 100 && mobile.parser.width <= 390 && mobile.workbench.width <= 390, 'mobile header and stacked workspace must fit viewport');
  assert.ok(mobile.app.height <= 300 && mobile.brand.height <= 36, 'mobile app header and logo must remain compact while preserving customer and operational groups');
  assert.ok(Math.abs(mobile.appInner.x - mobile.brand.x) <= 1, 'mobile SmartInput logo must remain at the app-header far left');
  assert.equal(new Set(mobile.tabs.map(tab => Math.round(tab.y))).size, 1, 'all four voucher tabs must remain on one mobile row');
  assert.ok(mobile.headerFields.y >= Math.max(...mobile.tabs.map(tab => tab.bottom)) + 7, 'mobile header fields must be spaced below the voucher buttons');
  assert.equal(mobile.headerDivider, '1px', 'mobile header fields must retain a horizontal group divider');
  await evaluate(client, `document.querySelector('#referenceOverview > summary').focus();true`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const mobileReference = await expr(client, `(() => {const overview=document.querySelector('#referenceOverview');const panel=document.querySelector('.reference-overview__panel').getBoundingClientRect();const globalHeader=document.querySelector('.nexus-ui-header').getBoundingClientRect();return overview.open&&overview.querySelector('summary').getAttribute('aria-expanded')==='true'&&panel.top>=globalHeader.bottom&&panel.right<=innerWidth&&panel.bottom<=innerHeight;})()`, 'mobile reference keyboard panel');
  assert.equal(mobileReference, true, 'mobile reference panel must open by keyboard below the common header');
  const mobileReferenceShot = await capture(client, 'smartinput-reference-mobile.png');
  await evaluate(client, `document.querySelector('#referenceOverview > summary').focus();true`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate(client, `!document.querySelector('#referenceOverview').open&&document.activeElement===document.querySelector('#referenceOverview > summary')`), true, 'Enter must close the reference panel without losing focus');
  const mobileShot = await capture(client, 'smartinput-0a-mobile.png');

  const localOrigin = `http://127.0.0.1:${address.port}`;
  const externalMutatingRequests = networkRequests.filter(request =>
    !request.url.startsWith(localOrigin)
    && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())
  );
  const localMutatingRequests = localServerRequests.filter(request => !['GET', 'HEAD'].includes(String(request.method).toUpperCase()));
  const guardedExternalMutationAttempts = await evaluate(client,
    `JSON.parse(localStorage.getItem('oneapp.smartinput.e2e.blockedExternalMutations')||'[]')`);
  assert.deepEqual(externalMutatingRequests, [], 'isolated browser baseline must make zero actual external mutating requests');
  assert.deepEqual(localMutatingRequests, [], 'the read-only fixture server must receive zero writes');
  const browserEnvironment = await evaluate(client, `(async()=>({
    userAgent:navigator.userAgent,
    platform:navigator.platform,
    language:navigator.language,
    viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
    indexedDbDatabases:typeof indexedDB.databases==='function'?await indexedDB.databases():[]
  }))()`);
  const baselineEvidence = {
    schemaVersion: 'NEXUS_SMARTINPUT_V2_PHASE1_BASELINE_V1',
    recordedAt: new Date().toISOString(),
    isolation: {
      browserProfile: 'mkdtemp isolated profile, removed after run',
      productionIndexedDbWrites: 0,
      actualExternalMutatingRequests: externalMutatingRequests.length,
      guardedExternalMutationAttempts,
      localFixtureServerWrites: localMutatingRequests.length,
      simulatedCloudCalls: officialSyncResult.actions,
      note: 'Cloud sync is exercised only through a temporary window.fetch stub; no network request is emitted.'
    },
    environment: {
      userAgent: browserEnvironment.userAgent,
      platform: browserEnvironment.platform,
      language: browserEnvironment.language,
      measurementViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
      finalCapturedViewport: browserEnvironment.viewport,
      indexedDbDatabases: browserEnvironment.indexedDbDatabases
    },
    dom: domBaseline,
    keyboardContractsExercised: [
      'grid ArrowRight navigation',
      'column-resize ArrowRight',
      'parser-pane ArrowRight',
      'related-pane ArrowLeft',
      'reference panel Enter',
      'product selection Enter'
    ],
    flows: {
      directInput: { clicks: 1, clickDefinition: 'Analyze button after keyboard entry', responseMs: flowTimings.directInputAnalyzeMs },
      excelTablePaste: { clicks: 0, clickDefinition: 'Ctrl+V/paste event into the grid', responseMs: flowTimings.excelTablePasteMs },
      autosave: { clicks: 0, clickDefinition: 'automatic after keyboard entry', responseMs: flowTimings.autosavePersistMs },
      autosaveRestore: { clicks: 1, clickDefinition: 'Restore autosave button', verified: true },
      currentOfficialSaveEntry: officialSaveEntryEvidence
    },
    officialTransaction: {
      successBaseline: officialResult,
      injectedFailure: officialRollbackResult,
      gatewayInjectedFailure: officialGatewayRollbackResult,
      stage3V2: officialV2Stage3Result,
      stage4V2: officialV2Stage4Result,
      phase6AReadModel: officialV2Phase6AReadResult,
      stage5V2: officialV2Stage5Result,
      expectedFinalizeTransactionCount: 1,
      partialFinalizeWritesAfterFailure: 0
    },
    stocktakeConflictUi: {
      contract: stocktakePopupContract,
      cancelStateBefore: stocktakeUiBefore,
      cancelStateAfter: stocktakeUiAfter,
      sequentialMixed: stocktakeSequentialMixed,
      themes: ['light', 'dark'],
      mobileViewport: { width: 390, height: 844 },
      normalFlowPopupCount: 0
    },
    screenshots: baselineScreenshots.map(file => basename(file))
  };
  if (baselineEvidenceFile) writeFileSync(baselineEvidenceFile, `${JSON.stringify(baselineEvidence, null, 2)}\n`);

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ orderId: orderResult.orderId, screenshots: [lightShot, darkShot, photoShot, ...baselineScreenshots, estimateCardsShot, mobileReferenceShot, mobileShot], metrics: { parserWidth: metrics.parser.width, workbenchWidth: metrics.workbench.width, resizedParserWidth: afterResize, mobileHeaderHeight: mobile.header.height }, baselineEvidenceFile }, null, 2));
  console.log('SmartInput protected desktop workspace browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
