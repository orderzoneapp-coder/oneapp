#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-initial-layout-'));
const screenshotDir = resolve(process.env.SMARTINPUT_INITIAL_LAYOUT_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-initial-layout-screenshots'));
const evidenceFile = process.env.SMARTINPUT_INITIAL_LAYOUT_EVIDENCE_FILE ? resolve(process.env.SMARTINPUT_INITIAL_LAYOUT_EVIDENCE_FILE) : '';
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
    return response.end('<!doctype html><meta charset="utf-8"><title>SmartInput initial layout fixture</title>');
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
  commandPath('google-chrome'), commandPath('chromium'), commandPath('chromium-browser'), commandPath('msedge')
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

// Isolated browser profile and loopback server only. No production app or DB is used.
const presets = {
  order: {
    fields: ['itemCode', 'itemName', 'specification', 'quantity', 'unitPrice', 'supplyAmount', 'memo', 'description', 'noticePrice'],
    labels: ['품목코드', '품목명', '규격', '수량', '단가', '공급가액', '메모', '적요(직원)', '공지단가']
  },
  purchase: {
    fields: ['itemCode', 'itemName', 'specification', 'quantity', 'unitPrice', 'supplyAmount', 'productDescription', 'memo', 'noticePrice', 'rowVoucherNo'],
    labels: ['코드', '품명', '규격(기본)', '수량', '단가', '공급가', '간단설명(품위)', '지시사항', '출고가 (공지)', '판매no.']
  },
  estimate: {
    fields: ['itemCode', 'itemName', 'specification', 'quantity', 'unitPrice', 'purchasePriceB', 'wholesaleA', 'wholesaleB', 'memo', 'promoPrice', 'memo2'],
    labels: ['품목코드', '품목명', '규격', '수량', '단가', 'B단가', 'A판매', 'B판매', '적요', '행사가', '적요2']
  }
};
const seededSettings = {
  orderCutoffTime: '13:45', allowSameDayDelivery: true,
  defaultDeliveryWeekdays: [1, 2, 3, 4, 5], holidayWeekdays: [0], holidayDates: ['2027-01-01'],
  deliveryCustomerWeekdays: { 'TEST-CUSTOMER': [2, 4] },
  voucherColumns: ['itemCode', 'memo', 'custom.text.01'],
  voucherColumnsByMode: {
    order: ['itemCode', 'memo', 'custom.text.01'],
    purchase: ['itemCode', 'quantity', 'unitPrice', 'memo'],
    sale: ['itemCode', 'memo', 'custom.text.01'],
    estimate: ['itemCode', 'memo', 'custom.text.01']
  },
  inputOrderByMode: {
    order: { itemCode: 1, memo: 2, 'custom.text.01': 3 },
    purchase: { itemCode: 1, quantity: 2, unitPrice: 3, memo: 4 },
    sale: { itemCode: 1, memo: 2, 'custom.text.01': 3 },
    estimate: { itemCode: 1, memo: 2, 'custom.text.01': 3 }
  },
  customFields: [{ id: 'custom.text.01', label: '사용자 보존 항목', valueType: 'TEXT', scope: 'voucher' }]
};
const coreSettings = settings => Object.fromEntries([
  'orderCutoffTime', 'allowSameDayDelivery', 'defaultDeliveryWeekdays', 'holidayWeekdays',
  'holidayDates', 'deliveryCustomerWeekdays', 'customFields'
].map(key => [key, settings[key]]));
const rowSnapshot = client => evaluate(client, `(() => {
  const draft=JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1'));
  for(const value of Object.values(draft.modes)){
    // This pre-existing policy diagnostic is refreshed on every render/save.
    if(value.header.deliveryPolicySnapshot)delete value.header.deliveryPolicySnapshot.evaluatedAt;
  }
  return Object.fromEntries(Object.entries(draft.modes).map(([mode,value])=>[mode,{
    header:value.header, rows:value.rows, delivery:value.delivery, sourceText:value.sourceText, batches:value.batches
  }]));
})()`);
const visibleLabels = client => evaluate(client, `[...document.querySelectorAll('#voucherInputTable thead th[data-column]:not(.is-column-hidden)')].map(element=>element.querySelector('.column-header-label')?.textContent.trim()||element.textContent.trim())`);
const expectedInputOrder = preset => {
  let next = 0;
  return Object.fromEntries(preset.fields.map(id => [id, id === 'supplyAmount' ? 0 : ++next]));
};
const selectedInputOrder = (settings, mode) => Object.fromEntries(presets[mode].fields.map(id => [id, settings.inputOrderByMode[mode][id]]));
const waitForSettingsHydration = client => expr(client, `['product','customer'].every(domain=>{
  const status=document.getElementById(domain+'ReferenceStatus')?.dataset.status;
  return Boolean(status)&&status!=='LOADING';
})`, 'settings hydration before completed reference status');
const selectMode = async (client, mode) => {
  await click(client, `[data-mode="${mode}"]`);
  await expr(client, `document.querySelector('.mode-tab.is-active')?.dataset.mode===${JSON.stringify(mode)}`, `${mode} active`);
};
const openSettings = async client => {
  await click(client, '#settingsButton');
  await expr(client, `Boolean(document.querySelector('.smart-settings-dialog[open] [data-restore-initial-input]'))`, 'initial input restore control');
};
const saveSettings = async client => {
  await click(client, '.smart-settings-dialog [data-save]');
  await expr(client, `!document.querySelector('.smart-settings-dialog')`, 'settings saved');
};

let browser;
let client;
const exceptions = [];
const screenshots = [];
const settingsViewports = [];
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required (set CHROME_PATH)');
  browser = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const debugPort = await waitFor(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)[0]; } catch { return null; }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  // The fixture does not need external network access, including customer/product cloud endpoints.
  await client.send('Network.setBlockedURLs', { urls: ['https://*', 'http://script.*', 'http://*.google.*'] });
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Page.javascriptDialogOpening', () => { void client.send('Page.handleJavaScriptDialog', { accept: true }); });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const navigate = async path => {
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}${path}` });
    await loaded;
  };

  await navigate('/smartinput/');
  await expr(client, `Boolean(document.querySelector('#inputRows tr'))`, 'new empty input table');
  // Initial rows render synchronously, whereas stored settings hydrate asynchronously.
  // Reference loading follows that hydration; use its visible state, never a fixed delay.
  await waitForSettingsHydration(client);
  for (const [mode, preset] of Object.entries(presets)) {
    await selectMode(client, mode);
    assert.deepEqual(await visibleWorktableColumns(client), preset.fields, `${mode}: first use must apply the approved initial column order`);
    assert.deepEqual(await visibleLabels(client), preset.labels, `${mode}: visible labels must match the requested voucher names`);
  }

  await navigate('/fixture.html');
  await evaluate(client, `(async()=>{
    await import('/smartinput/smartinput-contract.js');
    const contract=window.SMART_INPUT_CONTRACT;
    const store=await import('/smartinput/smartinput-data-store.js');
    await store.saveSettings(contract.normalizeSettings(${JSON.stringify(seededSettings)}));
    const draft=contract.createDraft();
    for(const [mode,current] of Object.entries(draft.modes)){
      current.rows=[contract.normalizeRow({rowId:'PRESERVE-'+mode,itemCode:'0007',itemName:'검증 상품 '+mode,
        specification:'1kg',quantity:2,unitPrice:100,purchasePriceB:0,wholesaleA:120,wholesaleB:130,
        memo:'적요 원문',memo2:'두 번째 적요',promoPrice:90,description:'직원 원문',
        customValues:{'custom.text.01':'사용자 값 유지'},noticePrice:150,sourceType:'MANUAL'})];
      current.sourceText='원본 텍스트 '+mode;
      current.header.rawOrdererName=current.sourceText;
      // Represent an already-processed draft. A source with no matching live batch
      // legitimately starts the app's independent automatic parser after render.
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(current.sourceText));
      const contentHash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      const batch=contract.createBatch({batchId:'PRESERVE-BATCH-'+mode,method:'text',
        sourceType:'GENERAL_TEXT',sourceRole:'LIVE_SOURCE',rawText:current.sourceText,contentHash});
      current.batches=[batch];
      current.rows[0].batchId=batch.batchId;
    }
    localStorage.setItem(contract.DRAFT_STORAGE_KEY,JSON.stringify(draft));
    await store.saveLatestAutosave(draft);
    return true;
  })()`);
  await navigate('/smartinput/');
  await expr(client, `Boolean(document.querySelector('#inputRows [data-row-id="PRESERVE-order"]'))`, 'seeded draft');
  await waitForSettingsHydration(client);
  await expr(client, `JSON.stringify([...document.querySelectorAll('#voucherInputTable thead th[data-column]:not(.is-column-hidden)')].map(element=>element.dataset.column))===${JSON.stringify(JSON.stringify(seededSettings.voucherColumnsByMode.order))}`, 'seeded saved column order applied');
  assert.deepEqual(await visibleWorktableColumns(client), seededSettings.voucherColumnsByMode.order,
    'existing saved layout must never be silently replaced by the new initial layout');
  for(const mode of ['purchase', 'sale', 'estimate', 'order']) await selectMode(client, mode);
  const originalStored = await storedSettings(client);
  let expectedRows = await rowSnapshot(client);
  const originalActive = await visibleWorktableColumns(client);

  await openSettings(client);
  await click(client, '[data-settings-layout-mode="estimate"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-restore-initial-input]').textContent.trim()`), '초기 입력 모드로 변경');
  for (const [width, height, theme] of [[1920, 1080, 'light'], [1920, 1080, 'dark'], [390, 844, 'light']]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate(client, `document.documentElement.dataset.nexusTheme=${JSON.stringify(theme)};document.documentElement.dataset.nexusUiTheme=${JSON.stringify(theme)};document.querySelector('[data-restore-initial-input]').scrollIntoView({block:'nearest'});true`);
    const geometry = await evaluate(client, `(() => {
      const dialog=document.querySelector('.smart-settings-dialog');
      const button=dialog.querySelector('[data-restore-initial-input]');
      const shell=dialog.querySelector('.smart-dialog__shell');
      const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      return {dialog:box(dialog),button:box(button),footer:box(dialog.querySelector('footer')),
        enabled:!button.disabled,overflow:shell.scrollWidth-shell.clientWidth,display:getComputedStyle(button).display};
    })()`);
    assert.ok(geometry.dialog.x >= -1 && geometry.dialog.y >= -1 && geometry.dialog.right <= width + 1 && geometry.dialog.bottom <= height + 1,
      `${width}/${theme}: settings dialog must remain inside the viewport`);
    assert.ok(geometry.button.width > 0 && geometry.button.height > 0 && geometry.button.y >= -1 && geometry.button.bottom <= height + 1,
      `${width}/${theme}: initial restore button must be reachable and visible`);
    assert.equal(geometry.enabled, true);
    assert.notEqual(geometry.display, 'none');
    assert.ok(geometry.overflow <= 1, `${width}/${theme}: restore controls must not cause horizontal overflow`);
    assert.ok(geometry.footer.bottom <= height + 1, `${width}/${theme}: Save/Cancel footer must remain reachable`);
    settingsViewports.push({ width, height, theme, ...geometry });
    screenshots.push(await capture(client, `smartinput-initial-settings-${width}-${theme}.png`));
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `(() => {const field=document.querySelector('[data-layout-fields="header"] input[value="transactionType"]');field.checked=false;field.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await click(client, '[data-restore-initial-input]');
  assert.equal(await evaluate(client, `document.querySelector('[data-layout-fields="header"] input[value="transactionType"]').checked`), false,
    'restoring input columns must preserve unsaved header selections');
  assert.deepEqual(await evaluate(client, `Object.fromEntries([...document.querySelectorAll('[data-input-order-field]')].map(input=>[input.dataset.inputOrderField,Number(input.value)]))`), expectedInputOrder(presets.estimate));
  assert.deepEqual(await storedSettings(client), originalStored, 'restore must remain a dialog draft until Save');
  assert.deepEqual(await visibleWorktableColumns(client), originalActive, 'restoring a dialog mode must not mutate the active table');
  await click(client, '.smart-settings-dialog footer [data-close]');
  await expr(client, `!document.querySelector('.smart-settings-dialog')`, 'cancelled restoration');
  assert.deepEqual(await storedSettings(client), originalStored, 'Cancel must discard restored settings');
  assert.deepEqual(await rowSnapshot(client), expectedRows, 'Cancel must preserve all voucher data');

  const previousByMode = structuredClone(seededSettings.voucherColumnsByMode);
  for (const [mode, preset] of Object.entries(presets)) {
    const previousStored = await storedSettings(client);
    await openSettings(client);
    await click(client, `[data-settings-layout-mode="${mode}"]`);
    await click(client, '[data-restore-initial-input]');
    await saveSettings(client);
    previousByMode[mode] = preset.fields;
    const stored = await storedSettings(client);
    assert.deepEqual(stored.voucherColumnsByMode, previousByMode, `${mode}: restoration must affect only the selected voucher`);
    assert.deepEqual(selectedInputOrder(stored, mode), expectedInputOrder(preset), `${mode}: restored Enter order`);
    for (const other of Object.keys(previousByMode).filter(id => id !== mode)) {
      assert.deepEqual(stored.inputOrderByMode[other], previousStored.inputOrderByMode[other], `${mode}: must preserve ${other} Enter order`);
    }
    assert.deepEqual(coreSettings(stored), coreSettings(originalStored), 'restoration must preserve delivery policy and custom field definitions');
    assert.deepEqual(await rowSnapshot(client), expectedRows, 'restoration must preserve all rows, custom values, header and delivery data');
    await selectMode(client, mode);
    assert.deepEqual(await visibleWorktableColumns(client), preset.fields);
    assert.deepEqual(await visibleLabels(client), preset.labels);
  }

  const estimateValues = await evaluate(client, `Object.fromEntries(['purchasePriceB','wholesaleA','wholesaleB','memo','promoPrice','memo2'].map(id=>[id,document.querySelector('#inputRows [data-row-id="PRESERVE-estimate"] [data-field="'+id+'"]').value]))`);
  assert.deepEqual(estimateValues, { purchasePriceB: '0', wholesaleA: '120', wholesaleB: '130', memo: '적요 원문', promoPrice: '90', memo2: '두 번째 적요' },
    'estimate labels must address their independent stored values, including zero and memo2');
  await evaluate(client, `document.querySelector('#inputRows [data-row-id="PRESERVE-estimate"] [data-field="unitPrice"]').focus();true`);
  for (const field of ['purchasePriceB', 'wholesaleA', 'wholesaleB', 'memo', 'promoPrice', 'memo2']) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(client, `document.activeElement?.dataset.field`), field, `Enter must move to ${field}`);
  }
  screenshots.push(await capture(client, 'smartinput-estimate-initial-layout.png'));

  await input(client, '#inputRows [data-row-id="PRESERVE-estimate"] [data-field="memo2"]', '수정한 두 번째 적요');
  await expr(client, `JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')).modes.estimate.rows[0].memo2==='수정한 두 번째 적요'`, 'memo2 saved in draft');
  expectedRows = await rowSnapshot(client);
  assert.equal(expectedRows.estimate.rows[0].memo, '적요 원문', 'editing memo2 must not overwrite memo');

  // The restored initial layout is still editable and changes must survive a reload.
  await openSettings(client);
  await input(client, '[data-input-order-field="memo2"]', '6');
  await saveSettings(client);
  const changed = await storedSettings(client);
  assert.equal(changed.inputOrderByMode.estimate.memo2, 6);
  await navigate('/smartinput/');
  await expr(client, `Boolean(document.querySelector('#inputRows [data-row-id="PRESERVE-estimate"]'))`, 'reloaded estimate');
  await waitForSettingsHydration(client);
  assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-row-id="PRESERVE-estimate"] [data-field="memo2"]').value`), '수정한 두 번째 적요', 'memo2 edits must survive reload');
  assert.equal((await storedSettings(client)).inputOrderByMode.estimate.memo2, 6, 'user changes must persist across reload');
  await openSettings(client);
  assert.equal(await evaluate(client, `document.querySelector('[data-input-order-field="memo2"]').value`), '6', 'reloaded user Enter order must be active in the settings UI');
  await click(client, '[data-restore-initial-input]');
  await saveSettings(client);
  assert.deepEqual(selectedInputOrder(await storedSettings(client), 'estimate'), expectedInputOrder(presets.estimate), 'initial layout must remain available after user changes');

  await openSettings(client);
  await click(client, '[data-settings-layout-mode="sale"]');
  assert.equal(await evaluate(client, `document.querySelector('[data-restore-initial-input]').disabled`), true,
    'Sale restoration must remain disabled until the user confirms its ambiguous mappings');
  await click(client, '.smart-settings-dialog footer [data-close]');
  await expr(client, `!document.querySelector('.smart-settings-dialog')`, 'closed sale settings');
  const finalSettings = await storedSettings(client);
  assert.deepEqual(finalSettings.voucherColumnsByMode.sale, seededSettings.voucherColumnsByMode.sale);
  assert.deepEqual(finalSettings.inputOrderByMode.sale, originalStored.inputOrderByMode.sale);
  assert.deepEqual(coreSettings(finalSettings), coreSettings(originalStored));
  assert.deepEqual(await rowSnapshot(client), expectedRows);
  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  const evidence = {
    schemaVersion: 'SMARTINPUT_INITIAL_INPUT_LAYOUT_BROWSER_V1',
    recordedAt: new Date().toISOString(), modes: Object.keys(presets),
    firstUse: true, preservedExistingLayout: true, restoreCancel: true,
    restoredOnlySelectedMode: true, userChangesSurviveReload: true,
    rowsCustomFieldsDeliveryPreserved: true, estimateIndependentValues: estimateValues,
    estimateEnterNavigation: true, saleRestoreDisabled: true,
    runtimeExceptions: exceptions.length, settingsViewports, screenshots: screenshots.map(file => basename(file))
  };
  if (evidenceFile) writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  console.log('SmartInput initial input layout browser PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.closeAllConnections?.();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
