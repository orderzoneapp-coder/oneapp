#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-settings-ux-'));
const screenshotDir = resolve(process.env.SMARTINPUT_SETTINGS_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-settings-ux-screenshots'));
const evidenceFile = process.env.SMARTINPUT_SETTINGS_EVIDENCE_FILE ? resolve(process.env.SMARTINPUT_SETTINGS_EVIDENCE_FILE) : '';
mkdirSync(screenshotDir, { recursive: true });
if (evidenceFile) mkdirSync(dirname(evidenceFile), { recursive: true });

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/fixture.html') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
    return response.end('<!doctype html><meta charset="utf-8"><title>SmartInput settings fixture</title>');
  }
  const relative = pathname === '/' ? 'smartinput/index.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const target = normalize(resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('Not found');
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
  response.end(readFileSync(target));
});

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
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
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }
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
  on(method, listener) {
    this.events.set(method, [...(this.events.get(method) || []), listener]);
  }
  once(method, timeout = 20_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener));
        resolveEvent(params);
      };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const input = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value;})()`);
const capture = async (client, name) => {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const target = join(screenshotDir, name);
  writeFileSync(target, Buffer.from(result.data, 'base64'));
  return target;
};
const visibleWorktableColumns = client => evaluate(client, `[...document.querySelectorAll('#voucherInputTable thead th[data-column]:not(.is-column-hidden)')].map(element=>element.dataset.column)`);
const storedSettings = client => evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?settings-read='+Date.now());return (await store.loadSmartInputData()).settings;})()`);

const seededSettings = {
  voucherColumns: ['itemCode', 'quantity', 'itemName', 'specification', 'unit', 'unitPrice', 'supplyAmount', 'memo'],
  voucherColumnsByMode: {
    order: ['itemCode', 'quantity', 'itemName', 'specification', 'unit', 'unitPrice', 'supplyAmount', 'memo'],
    purchase: ['itemCode', 'unitPrice', 'itemName', 'quantity'],
    sale: ['itemCode', 'memo'],
    estimate: ['itemCode', 'noticePrice']
  },
  inputOrderByMode: {
    order: { itemCode: 1, itemName: 2, specification: 3, quantity: 4, unit: 0, unitPrice: 5, supplyAmount: 0, memo: 0 },
    purchase: { itemCode: 1, unitPrice: 2, itemName: 3, quantity: 4 },
    sale: { itemCode: 1, memo: 0 },
    estimate: { itemCode: 1, noticePrice: 2 }
  }
};

let browser;
let client;
const exceptions = [];
const consoleErrors = [];
const screenshots = [];
const confirmationMessages = [];
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
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
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push(event.args?.map(argument => argument.value || argument.description || '').join(' '));
  });
  client.on('Page.javascriptDialogOpening', event => {
    confirmationMessages.push(event.message);
    void client.send('Page.handleJavaScriptDialog', { accept: true });
  });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/fixture.html` });
  await loaded;
  await evaluate(client, `(async()=>{const store=await import('/smartinput/smartinput-data-store.js?settings-seed=1');await store.saveSettings(${JSON.stringify(seededSettings)});return true;})()`);

  loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await expr(client, `[...document.querySelectorAll('#voucherInputTable thead th[data-column]:not(.is-column-hidden)')].map(element=>element.dataset.column).slice(0,4).join(',')==='itemCode,quantity,itemName,specification'`, 'seeded worktable order');
  const worktableBefore = await visibleWorktableColumns(client);
  const storedBefore = await storedSettings(client);
  assert.deepEqual(storedBefore, seededSettings, 'opening the app must not rewrite the stored settings');

  await click(client, '#settingsButton');
  await expr(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-voucher-field-row]'))`, 'settings dialog');
  const initial = await evaluate(client, `(() => {
    const dialog=document.querySelector('.smart-settings-dialog');
    const bounds=dialog.getBoundingClientRect();
    return {
      dialogCount:document.querySelectorAll('dialog[open]').length,
      width:bounds.width,height:bounds.height,
      activeMode:dialog.querySelector('[data-settings-layout-mode].is-active')?.dataset.settingsLayoutMode,
      firstGroup:dialog.querySelector('.smart-settings-grid > .settings-group')?.dataset.settingsGroup,
      voucherOpen:dialog.querySelector('[data-settings-group="voucher"]').open,
      selected:[...dialog.querySelectorAll('[data-voucher-field-row]')].map(row=>row.dataset.voucherFieldRow),
      selectedGeometry:[...dialog.querySelectorAll('[data-voucher-field-row]')].map(row=>{const r=row.getBoundingClientRect();return {id:row.dataset.voucherFieldRow,top:r.top,bottom:r.bottom,height:r.height,display:getComputedStyle(row).display};}),
      groupGeometry:[...dialog.querySelectorAll('[data-settings-field-group]')].map(group=>({id:group.dataset.settingsFieldGroup,clientHeight:group.clientHeight,scrollHeight:group.scrollHeight})),
      groups:[...dialog.querySelectorAll('[data-settings-field-group] h4')].map(node=>node.textContent.trim()),
      requiredDisabled:dialog.querySelector('[data-voucher-visible-field="itemCode"]')?.disabled,
      draggable:dialog.querySelectorAll('[data-voucher-field-row][draggable="true"]').length,
      explorerHidden:dialog.querySelector('[data-voucher-field-explorer]').hidden
    };
  })()`);
  assert.equal(initial.dialogCount, 1);
  assert.ok(initial.width >= 1100 && initial.width <= 1181 && initial.height >= 840 && initial.height <= 861, 'desktop settings modal must be large but viewport-bound');
  assert.equal(initial.activeMode, 'order');
  assert.equal(initial.firstGroup, 'voucher');
  assert.equal(initial.voucherOpen, true);
  assert.deepEqual(initial.selected, ['itemCode', 'itemName', 'specification', 'unit', 'quantity', 'unitPrice', 'supplyAmount', 'memo'],
    'selected fields must render in fixed business order instead of worktable order');
  assert.deepEqual(initial.groups, ['품목정보', '수량·단가·금액', '메모·기타']);
  assert.ok(initial.selectedGeometry.every(row => row.height >= 60 && row.display === 'grid'));
  assert.ok(initial.groupGeometry.every(group => group.scrollHeight <= group.clientHeight + 1),
    'field groups must keep their natural height so rows scroll instead of overlapping or clipping');
  assert.equal(initial.requiredDisabled, true, 'the current required-field contract must prevent hiding itemCode');
  assert.equal(initial.draggable, 0, 'settings rows must not expose drag ordering');
  assert.equal(initial.explorerHidden, true);
  screenshots.push(await capture(client, 'smartinput-settings-1920-selected.png'));

  await click(client, '[data-toggle-voucher-explorer]');
  await expr(client, `!document.querySelector('[data-voucher-field-explorer]').hidden`, 'inline explorer');
  assert.equal(await evaluate(client, `document.querySelectorAll('dialog[open]').length`), 1, 'voucher item discovery must not open a nested modal');
  await evaluate(client, `(() => {const select=document.querySelector('[data-voucher-field-category]');select.value='AMOUNT';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  assert.equal(await evaluate(client, `Boolean(document.querySelector('[data-add-voucher-field="brand"]'))`), false,
    'the business category filter must exclude fields from other groups');
  assert.equal(await evaluate(client, `document.querySelector('[data-add-voucher-field="quantity"]')?.disabled`), true,
    'category results must retain the already-selected marker');
  await evaluate(client, `(() => {const select=document.querySelector('[data-voucher-field-category]');select.value='ALL';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await input(client, '[data-voucher-field-search]', '브랜드');
  const explorerState = await evaluate(client, `(() => ({
    summary:document.querySelector('[data-voucher-explorer-count]').textContent.replace(/\s+/g,' ').trim(),
    resultCount:document.querySelectorAll('[data-voucher-explorer-results] [data-add-voucher-field]').length,
    brandSelected:document.querySelector('[data-add-voucher-field="brand"]')?.disabled,
    categoryCount:document.querySelector('[data-voucher-field-category]').options.length
  }))()`);
  assert.match(explorerState.summary, /전체 \d+.*선택 8.*검색 결과/);
  assert.ok(explorerState.resultCount >= 1);
  assert.equal(explorerState.brandSelected, false);
  assert.equal(explorerState.categoryCount, 4);
  await click(client, '[data-add-voucher-field="brand"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-input-order-field="brand"]').value`), '0');
  assert.deepEqual(await visibleWorktableColumns(client), worktableBefore, 'adding a setting must not change the active worktable before Save');

  await input(client, '[data-input-order-field="quantity"]', '2');
  const duplicateInsertion = await evaluate(client, `Object.fromEntries(['itemCode','quantity','itemName','specification','unit','brand'].map(id=>[id,document.querySelector('[data-input-order-field="'+id+'"]').value]))`);
  assert.deepEqual(duplicateInsertion, { itemCode: '1', quantity: '2', itemName: '3', specification: '4', unit: '0', brand: '0' });
  assert.match(await evaluate(client, `document.querySelector('[data-enter-order-preview]').textContent.replace(/\s+/g,' ').trim()`), /1 품목코드.*2 (?:주문)?수량.*3 품목\(상품명\).*4 규격/);

  await input(client, '[data-input-order-field="itemName"]', '');
  await click(client, '.smart-settings-dialog [data-save]');
  assert.equal(await evaluate(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-input-order-field="itemName"][aria-invalid="true"]'))`), true,
    'blank input order must block Save');
  await input(client, '[data-input-order-field="itemName"]', '-1');
  await click(client, '.smart-settings-dialog [data-save]');
  assert.match(await evaluate(client, `document.querySelector('[data-settings-message]').textContent`), /0 이상의 정수/);
  await input(client, '[data-input-order-field="itemName"]', '3');
  await input(client, '[data-voucher-field-search]', '');

  const fixedBefore = await evaluate(client, `(() => {const dialog=document.querySelector('.smart-settings-dialog');const box=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom};};return {header:box(dialog.querySelector('header')),tabs:box(dialog.querySelector('.smart-settings-dialog__mode-tabs')),footer:box(dialog.querySelector('footer')),gridScroll:dialog.querySelector('.smart-settings-grid').scrollTop};})()`);
  await evaluate(client, `(() => {const grid=document.querySelector('.smart-settings-grid');grid.scrollTop=grid.scrollHeight;return grid.scrollTop;})()`);
  await wait(100);
  const fixedAfter = await evaluate(client, `(() => {const dialog=document.querySelector('.smart-settings-dialog');const box=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom};};const selected=dialog.querySelector('.settings-voucher-selected');const explorer=dialog.querySelector('.settings-voucher-explorer__results');return {header:box(dialog.querySelector('header')),tabs:box(dialog.querySelector('.smart-settings-dialog__mode-tabs')),footer:box(dialog.querySelector('footer')),gridScroll:dialog.querySelector('.smart-settings-grid').scrollTop,selectedScrollable:selected.scrollHeight>selected.clientHeight,explorerScrollable:explorer.scrollHeight>explorer.clientHeight};})()`);
  assert.deepEqual(fixedAfter.header, fixedBefore.header);
  assert.deepEqual(fixedAfter.tabs, fixedBefore.tabs);
  assert.deepEqual(fixedAfter.footer, fixedBefore.footer);
  assert.ok(fixedAfter.gridScroll >= fixedBefore.gridScroll);
  assert.equal(fixedAfter.explorerScrollable, true, 'the full field catalog must scroll inside the modal');

  await evaluate(client, `document.querySelector('[data-voucher-field-search]').focus();true`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const keyboardFocus = await evaluate(client, `(() => {const active=document.activeElement;return {inside:Boolean(active?.closest('.smart-settings-dialog')),visible:active?.matches(':focus-visible'),outline:getComputedStyle(active).outlineStyle};})()`);
  assert.equal(keyboardFocus.inside, true);
  assert.equal(keyboardFocus.visible, true);
  assert.notEqual(keyboardFocus.outline, 'none');

  await evaluate(client, `document.documentElement.dataset.nexusTheme='light';document.documentElement.dataset.nexusUiTheme='light';true`);
  const lightColors = await evaluate(client, `(() => {const row=document.querySelector('[data-voucher-field-row="itemCode"]');const style=getComputedStyle(row);return {background:style.backgroundColor,color:style.color};})()`);
  screenshots.push(await capture(client, 'smartinput-settings-1920-light.png'));
  await evaluate(client, `document.documentElement.dataset.nexusTheme='dark';document.documentElement.dataset.nexusUiTheme='dark';true`);
  await wait(100);
  const darkColors = await evaluate(client, `(() => {const row=document.querySelector('[data-voucher-field-row="itemCode"]');const style=getComputedStyle(row);return {background:style.backgroundColor,color:style.color};})()`);
  assert.notEqual(darkColors.background, lightColors.background, 'dark mode must restyle the settings surface');
  assert.notEqual(darkColors.color, darkColors.background);
  screenshots.push(await capture(client, 'smartinput-settings-1920-dark.png'));
  await evaluate(client, `document.documentElement.dataset.nexusTheme='light';document.documentElement.dataset.nexusUiTheme='light';true`);

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(100);
  const medium = await evaluate(client, `(() => {const r=document.querySelector('.smart-settings-dialog').getBoundingClientRect();return {width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
  assert.ok(medium.width <= 1181 && medium.right <= 1440 && medium.bottom <= 900);
  screenshots.push(await capture(client, 'smartinput-settings-1440-light.png'));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(120);
  const mobile = await evaluate(client, `(() => {const dialog=document.querySelector('.smart-settings-dialog');const r=dialog.getBoundingClientRect();const shell=dialog.querySelector('.smart-dialog__shell');return {x:r.x,y:r.y,width:r.width,height:r.height,tabHeights:[...dialog.querySelectorAll('[data-settings-layout-mode]')].map(button=>button.getBoundingClientRect().height),overflow:shell.scrollWidth-shell.clientWidth};})()`);
  assert.ok(Math.abs(mobile.x) <= 1 && Math.abs(mobile.y) <= 1 && Math.abs(mobile.width - 390) <= 1 && Math.abs(mobile.height - 844) <= 1,
    '390px settings must use a viewport-sized modal');
  assert.ok(mobile.tabHeights.every(height => height >= 44));
  assert.ok(mobile.overflow <= 1, 'mobile settings shell must not overflow horizontally');
  screenshots.push(await capture(client, 'smartinput-settings-390-light.png'));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await click(client, '.smart-settings-dialog footer [data-close]');
  await expr(client, `!document.querySelector('.smart-settings-dialog')`, 'discarded settings close');
  assert.match(confirmationMessages.at(-1) || '', /저장하지 않은 환경설정 변경을 취소/);
  assert.deepEqual(await storedSettings(client), seededSettings, 'Cancel must leave the persisted settings untouched');
  assert.deepEqual(await visibleWorktableColumns(client), worktableBefore, 'Cancel must fully restore the active worktable');

  await click(client, '#settingsButton');
  await expr(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-voucher-field-row]'))`, 'reopened settings dialog');
  await click(client, '[data-settings-layout-mode="sale"]');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('[data-voucher-field-row]')].map(row=>row.dataset.voucherFieldRow)`), ['itemCode', 'memo']);
  await click(client, '[data-toggle-voucher-explorer]');
  await input(client, '[data-voucher-field-search]', '브랜드');
  await click(client, '[data-add-voucher-field="brand"]');
  await click(client, '.smart-settings-dialog [data-save]');
  await expr(client, `!document.querySelector('.smart-settings-dialog')`, 'saved settings close');
  const storedAfter = await storedSettings(client);
  assert.deepEqual(storedAfter.voucherColumnsByMode.order, seededSettings.voucherColumnsByMode.order,
    'saving Sale settings must not reorder Order worktable columns');
  assert.deepEqual(storedAfter.voucherColumnsByMode.purchase, seededSettings.voucherColumnsByMode.purchase);
  assert.deepEqual(storedAfter.voucherColumnsByMode.estimate, seededSettings.voucherColumnsByMode.estimate);
  assert.deepEqual(storedAfter.voucherColumnsByMode.sale, ['itemCode', 'memo', 'brand']);
  assert.equal(storedAfter.inputOrderByMode.sale.brand, 0);
  assert.deepEqual(await visibleWorktableColumns(client), worktableBefore,
    'saving another voucher mode must not change the active Order worktable');

  await click(client, '#settingsButton');
  await expr(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-voucher-field-row]'))`, 'saved settings verification dialog');
  await click(client, '[data-settings-layout-mode="sale"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-input-order-field="brand"]')?.value`), '0');
  await click(client, '[data-settings-layout-mode="order"]');
  assert.equal(await evaluate(client, `Boolean(document.querySelector('[data-voucher-field-row="brand"]'))`), false,
    'the four voucher tabs must keep independent selections');
  await click(client, '.smart-settings-dialog footer [data-close]');
  await expr(client, `!document.querySelector('.smart-settings-dialog')`, 'final settings close');

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  const evidence = {
    schemaVersion: 'NEXUS_SMARTINPUT_SETTINGS_UX_EVIDENCE_V1',
    taskId: 'NEXUS-SI-SETTINGS-UX-20260903-01',
    recordedAt: new Date().toISOString(),
    viewports: { desktop: [1920, 1080], medium: [1440, 900], mobile: [390, 844] },
    themes: ['light', 'dark'],
    initial,
    fixedRegions: { header: true, voucherTabs: true, footer: true, internalCatalogScroll: fixedAfter.explorerScrollable },
    keyboard: keyboardFocus,
    worktableBefore,
    confirmationMessages,
    storedVoucherColumnsByMode: storedAfter.voucherColumnsByMode,
    runtimeExceptions: exceptions.length,
    consoleErrors: consoleErrors.length,
    screenshots: screenshots.map(file => basename(file))
  };
  if (evidenceFile) writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  console.log('SmartInput selected-fields settings browser UX PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
