#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-orderops-theme-e2e-'));
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = pathname === '/' ? 'orderops/list.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
    const filePath = normalize(resolve(root, relativePath));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    response.end(readFileSync(filePath));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

const commandPath = (command) => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '' : '';
};
const findBrowser = () => [
  process.env.CHROME_PATH,
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge'),
].filter(Boolean).find(existsSync) || '';
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const waitFor = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(80);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};

class CdpClient {
  constructor(url) { this.url = url; this.socket = null; this.nextId = 1; this.pending = new Map(); this.events = new Map(); }
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
  once(method, timeout = 30_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener));
        resolveEvent(params);
      };
      const timer = setTimeout(() => {
        this.events.set(method, (this.events.get(method) || []).filter((value) => value !== listener));
        rejectEvent(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(); }
}

const evaluate = async (client, expression) => {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
  return result.result.value;
};
const click = (client, selector) => evaluate(client, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) throw new Error('Missing ${selector}'); node.click(); return true; })()`);
const dispatchKey = async (client, key) => {
  const code = key === 'Enter' ? 'Enter' : 'Space';
  const virtualKeyCode = key === 'Enter' ? 13 : 32;
  const text = key === 'Enter' ? '\r' : ' ';
  const params = { key, code, text, unmodifiedText: text, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
};
const contrast = (foreground, background) => {
  const channels = (value) => {
    const values = (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    return /^color\(srgb\s/i.test(value) ? values.map((channel) => channel * 255) : values;
  };
  const luminance = (value) => {
    const [red, green, blue] = channels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
};

let browserProcess;
let client;
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  const browserExecutable = findBrowser();
  assert.ok(browserExecutable, 'Chrome, Chromium, or Edge is required for OrderOps theme E2E');
  browserProcess = spawn(browserExecutable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${browserProfile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const portFile = join(browserProfile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter((target) => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  const runtimeErrors = [];
  client.on('Runtime.exceptionThrown', (event) => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Runtime exception'));

  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/orderops/list.html` });
  await loaded;
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('.nexus-ui-header'))`), 'common header');
  await evaluate(client, `(() => {
    const host=document.querySelector('#previewTable');
    host.innerHTML='<table class="preview-allocations"><thead><tr><th>품명</th><th>담당자</th><th>정보</th><th>단가</th></tr></thead><tbody><tr class="manager-color-row" style="--manager-color:#dbeafe"><td class="primary-readable-cell">양배추_왕_3입</td><td class="manager-value warning-value"><span class="manager-name">김담당</span></td><td class="information-value ordered-context-cell"><span class="order-information-badges"><span class="order-information-badge manager-color-badge" style="--manager-color:#dbeafe">우리식당(1)8,900</span><span class="order-information-badge manager-color-badge" style="--manager-color:#fce7f3">한국리장원(1)24,800</span></span></td><td class="number ledger-negative-cell">4,000</td></tr><tr class="no-order-row"><td class="primary-readable-cell">보조 상품</td><td>미지정</td><td class="quantity-zero">0</td><td class="number">2,200</td></tr><tr class="manager-color-row unit-alert-row" style="--manager-color:#fef3c7"><td class="unit-alert-cell">EA 상품</td><td>박담당</td><td>일반 정보</td><td class="number">1,700</td></tr><tr class="manager-color-row box-unit-row" style="--manager-color:#dcfce7"><td class="box-unit-cell">BOX 상품</td><td>이담당</td><td>박스 정보</td><td class="number">2,300</td></tr></tbody></table>';
    document.querySelector('tbody tr.manager-color-row').insertAdjacentHTML('beforeend','<td><input class="inventory-input ledger-price-input" value="8700"></td><td><input class="order-edit-input" value="5"></td><td><input class="purchase-input" data-negative-balance="true" value="거창"></td><td><span class="inventory-total-frame">8</span></td>');
    document.querySelector('.order-edit-input').focus();
    return true;
  })()`);
  const lightMetrics = await evaluate(client, `(() => { const read=(selector)=>{const style=getComputedStyle(document.querySelector(selector));return {color:style.color,background:style.backgroundColor};}; const readAll=(selector)=>[...document.querySelectorAll(selector)].map((node)=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor};}); return {theme:document.documentElement.dataset.nexusUiTheme,primary:read('tbody tr:first-child td:first-child'),inactive:read('tr.no-order-row td:first-child'),managerCells:readAll('tbody tr.manager-color-row:first-child > td'),managerControls:readAll('tbody tr.manager-color-row:first-child :is(.purchase-input,.order-edit-input,.inventory-input,.inventory-total-frame)'),unitCells:readAll('tbody tr.unit-alert-row > td'),boxCells:readAll('tbody tr.box-unit-row > td')}; })()`);
  assert.equal(lightMetrics.theme, 'light');
  assert.notEqual(lightMetrics.primary.background, lightMetrics.inactive.background,
    'saved manager colors must restore a visible row surface in light mode');
  assert.ok(contrast(lightMetrics.primary.color, lightMetrics.primary.background) >= 7,
    'restored light manager rows must preserve strong text contrast');
  assert.equal(new Set(lightMetrics.managerCells.map((cell) => cell.background)).size, 1,
    'light manager color must cover every cell even when cells carry semantic state classes');
  assert.equal(new Set(lightMetrics.managerCells.map((cell) => cell.color)).size, 1,
    'light manager text color must cover the complete row');
  assert.ok(lightMetrics.managerControls.every((control) => control.background === 'rgba(0, 0, 0, 0)'),
    'light manager-row editors and quantity frames must not cover the assigned row color');
  assert.equal(new Set(lightMetrics.unitCells.map((cell) => cell.color)).size, 1,
    'EA and 소분 warning text must cover the complete light row');
  assert.equal(new Set(lightMetrics.boxCells.map((cell) => cell.color)).size, 1,
    'BOX text color must cover the complete light row');
  await click(client, '[data-nexus-ui-theme-set="dark"]');
  await wait(120);
  const metrics = await evaluate(client, `(() => { const read=(selector)=>{const style=getComputedStyle(document.querySelector(selector));return {color:style.color,background:style.backgroundColor,border:style.borderColor,shadow:style.boxShadow};}; const readAll=(selector)=>[...document.querySelectorAll(selector)].map((node)=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor};}); return {theme:document.documentElement.dataset.nexusUiTheme,unitTextToken:getComputedStyle(document.documentElement).getPropertyValue('--orderops-unit-row-text').trim(),header:read('th'),primary:read('tbody tr:first-child td:first-child'),inactive:read('tr.no-order-row td:first-child'),warning:read('td.unit-alert-cell'),manager:read('.manager-name'),badge1:read('.manager-color-badge'),badge2:read('.manager-color-badge:nth-child(2)'),managerCells:readAll('tbody tr.manager-color-row:first-child > td'),managerControls:readAll('tbody tr.manager-color-row:first-child :is(.purchase-input,.order-edit-input,.inventory-input,.inventory-total-frame)'),unitCells:readAll('tbody tr.unit-alert-row > td'),boxCells:readAll('tbody tr.box-unit-row > td')}; })()`);
  assert.equal(metrics.theme, 'dark');
  assert.ok(contrast(metrics.header.color, metrics.header.background) >= 7, 'dark table headers must have strong text contrast');
  assert.ok(contrast(metrics.primary.color, metrics.primary.background) >= 7,
    `dark primary table information must have strong text contrast: ${JSON.stringify(metrics.primary)} ratio=${contrast(metrics.primary.color, metrics.primary.background)}`);
  assert.ok(contrast(metrics.inactive.color, metrics.inactive.background) >= 4.5, 'inactive dark rows must remain readable');
  assert.ok(contrast(metrics.warning.color, metrics.warning.background) >= 4.5,
    `dark warning units must remain readable: ${JSON.stringify(metrics.warning)} token=${metrics.unitTextToken} ratio=${contrast(metrics.warning.color, metrics.warning.background)}`);
  assert.ok(contrast(metrics.manager.color, metrics.manager.background) >= 4.5, 'dark manager labels must remain readable');
  assert.ok(contrast(metrics.badge1.color, metrics.badge1.background) >= 4.5, 'dark manager information badges must remain readable');
  assert.notEqual(metrics.primary.background, metrics.inactive.background,
    'saved manager colors must restore a visible row surface in dark mode');
  assert.equal(new Set(metrics.managerCells.map((cell) => cell.background)).size, 1,
    'dark manager color must cover every cell even when cells carry semantic state classes');
  assert.equal(new Set(metrics.managerCells.map((cell) => cell.color)).size, 1,
    'dark manager text color must cover the complete row');
  assert.ok(metrics.managerControls.every((control) => control.background === 'rgba(0, 0, 0, 0)'),
    'dark manager-row editors and quantity frames must not cover the assigned row color');
  assert.equal(new Set(metrics.unitCells.map((cell) => cell.color)).size, 1,
    'EA and 소분 warning text must cover the complete dark row');
  assert.equal(new Set(metrics.boxCells.map((cell) => cell.color)).size, 1,
    'BOX text color must cover the complete dark row');
  assert.notEqual(metrics.badge1.background, metrics.badge2.background,
    'assigned manager information badges must remain visually distinct');
  assert.notEqual(metrics.primary.shadow, 'none', 'assigned manager rows must retain their color edge marker');
  await client.send('Emulation.setEmulatedMedia', { media: 'print' });
  const printMetrics = await evaluate(client, `(() => {
    const printArea=document.querySelector('#printArea');
    printArea.innerHTML='<table class="preview-allocations"><thead><tr><th>품명</th><th>담당자</th><th>수량</th></tr></thead><tbody><tr class="manager-color-row" style="--manager-color:#dbeafe;--manager-print-color:#dbeafe"><td>첫 출력 행</td><td class="warning-value">김담당</td><td class="ordered-context-cell">4</td></tr><tr class="manager-color-row unit-alert-row" style="--manager-color:#fef3c7;--manager-print-color:#fef3c7"><td>EA 상품</td><td>박담당</td><td>2</td></tr></tbody></table>';
    document.body.classList.add('printing-table');
    const bodyStyle=getComputedStyle(document.body);
    const printStyle=getComputedStyle(printArea);
    return {
      bodyMarginTop:parseFloat(bodyStyle.marginTop),
      bodyPaddingTop:parseFloat(bodyStyle.paddingTop),
      printMarginTop:parseFloat(printStyle.marginTop),
      printPaddingTop:parseFloat(printStyle.paddingTop),
      printTop:printArea.getBoundingClientRect().top,
      tableTop:printArea.querySelector('table').getBoundingClientRect().top,
      managerCells:[...printArea.querySelectorAll('tbody tr.manager-color-row:first-child > td')].map((node)=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor};}),
      unitCells:[...printArea.querySelectorAll('tbody tr.unit-alert-row > td')].map((node)=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor};}),
    };
  })()`);
  assert.equal(printMetrics.bodyMarginTop, 0, 'print body must not reserve a top margin');
  assert.equal(printMetrics.bodyPaddingTop, 0, 'print body must remove the common-header top offset');
  assert.equal(printMetrics.printMarginTop, 0, 'print area must not reserve a top margin');
  assert.equal(printMetrics.printPaddingTop, 0, 'print area must not reserve top padding');
  assert.ok(Math.abs(printMetrics.printTop) <= 0.5 && Math.abs(printMetrics.tableTop) <= 0.5,
    `printed table must start at the printable origin, got print=${printMetrics.printTop}, table=${printMetrics.tableTop}`);
  assert.equal(new Set(printMetrics.managerCells.map((cell) => cell.background)).size, 1,
    'printed manager background must cover the complete row');
  assert.equal(new Set(printMetrics.managerCells.map((cell) => cell.color)).size, 1,
    'printed manager text color must cover the complete row');
  assert.equal(printMetrics.managerCells[0].color, 'rgb(23, 32, 51)',
    'dark screen text tokens must not leak into the printed manager row');
  assert.equal(new Set(printMetrics.unitCells.map((cell) => cell.color)).size, 1,
    'printed EA and 소분 warning text must cover the complete row');
  assert.equal(printMetrics.unitCells[0].color, 'rgb(185, 28, 28)',
    'printed EA and 소분 rows must retain the paper-safe red text');
  assert.equal(printMetrics.managerCells[0].background, 'rgb(219, 234, 254)',
    'print-only manager token must preserve the selected pastel without screen-theme dilution');

  await client.send('Emulation.setEmulatedMedia', { media: 'screen' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const dataOpsConsoleErrors = [];
  client.on('Runtime.consoleAPICalled', (event) => {
    if (event.type !== 'error') return;
    dataOpsConsoleErrors.push(event.args.map((argument) => argument.value ?? argument.description ?? '').join(' '));
  });
  const dataOpsLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/DataOps.html` });
  await dataOpsLoaded;
  await waitFor(() => evaluate(client, `document.querySelectorAll('.bg-\\\\[\\\\#f8fafc\\\\]').length === 3 && Boolean(document.querySelector('[data-nexus-ui-theme-toggle]'))`), 'DataOps theme surfaces');

  await click(client, '[data-nexus-ui-theme-set="light"]');
  await wait(100);
  const lightDataOps = await evaluate(client, `(() => {
    const toggle=document.querySelector('[data-nexus-ui-theme-toggle]');
    const headerCell=[...document.querySelectorAll('th')].find((node)=>node.textContent.trim()) || document.querySelector('th');
    const cellStyle=getComputedStyle(headerCell);
    return {
      theme:document.documentElement.dataset.nexusUiTheme,
      body:getComputedStyle(document.body).backgroundColor,
      wrappers:[...document.querySelectorAll('.bg-\\\\[\\\\#f8fafc\\\\]')].map((node)=>getComputedStyle(node).backgroundColor),
      headerText:headerCell.textContent.trim(),
      headerColor:cellStyle.color,
      headerBackground:cellStyle.backgroundColor,
      iconPressed:document.querySelector('[data-nexus-ui-theme-set="light"]').getAttribute('aria-pressed'),
      checked:toggle.getAttribute('aria-checked'),
      label:toggle.getAttribute('aria-label'),
      title:toggle.getAttribute('title'),
    };
  })()`);
  assert.equal(lightDataOps.theme, 'light');
  assert.equal(lightDataOps.body, 'rgb(243, 239, 230)', 'DataOps light body must use the approved ivory page tone');
  assert.deepEqual(lightDataOps.wrappers, Array(3).fill(lightDataOps.body), 'all DataOps light page wrappers must use the ivory page token');
  assert.ok(lightDataOps.headerText.length > 0, 'DataOps table header information must remain visible');
  assert.ok(contrast(lightDataOps.headerColor, lightDataOps.headerBackground) >= 4.5, 'DataOps light table text must remain readable');
  assert.equal(lightDataOps.iconPressed, 'true', 'the light icon must expose its selected state');
  assert.equal(lightDataOps.checked, 'false');
  assert.equal(lightDataOps.label, '다크모드', 'the switch accessible name must remain stable in light mode');
  assert.equal(lightDataOps.title, '다크모드로 전환', 'the switch title must describe the next light-mode action');

  await click(client, '[data-nexus-ui-theme-set="dark"]');
  await wait(100);
  let themeState = await evaluate(client, `({ theme:document.documentElement.dataset.nexusUiTheme, pressed:document.querySelector('[data-nexus-ui-theme-set="dark"]').getAttribute('aria-pressed') })`);
  assert.deepEqual(themeState, { theme: 'dark', pressed: 'true' }, 'the dark icon must apply dark mode with the correct pressed state');
  await click(client, '[data-nexus-ui-theme-set="light"]');
  await click(client, '[data-nexus-ui-theme-toggle]');
  await wait(100);
  assert.equal(await evaluate(client, `document.documentElement.dataset.nexusUiTheme`), 'dark', 'mouse activation of the center switch must toggle exactly once');
  await click(client, '[data-nexus-ui-theme-set="light"]');

  await evaluate(client, `(() => {
    window.__nexusThemeChangeCount=0;
    window.addEventListener('nexus-ui:theme-change',()=>{window.__nexusThemeChangeCount+=1;});
    document.querySelector('[data-nexus-ui-theme-toggle]').focus();
    return true;
  })()`);
  await dispatchKey(client, 'Enter');
  await wait(100);
  const afterEnter = await evaluate(client, `({ theme:document.documentElement.dataset.nexusUiTheme, checked:document.querySelector('[data-nexus-ui-theme-toggle]').getAttribute('aria-checked'), events:window.__nexusThemeChangeCount })`);
  assert.deepEqual(afterEnter, { theme: 'dark', checked: 'true', events: 1 }, 'Enter must toggle the native switch exactly once');
  await dispatchKey(client, ' ');
  await wait(100);
  const afterSpace = await evaluate(client, `({ theme:document.documentElement.dataset.nexusUiTheme, checked:document.querySelector('[data-nexus-ui-theme-toggle]').getAttribute('aria-checked'), events:window.__nexusThemeChangeCount })`);
  assert.deepEqual(afterSpace, { theme: 'light', checked: 'false', events: 2 }, 'Space must toggle the native switch exactly once');

  await click(client, '[data-nexus-ui-theme-set="dark"]');
  await wait(100);
  const darkDataOps = await evaluate(client, `(() => {
    const toggle=document.querySelector('[data-nexus-ui-theme-toggle]');
    const rect=toggle.getBoundingClientRect();
    const track=getComputedStyle(toggle,'::before');
    const focus=getComputedStyle(toggle);
    const headerCell=[...document.querySelectorAll('th')].find((node)=>node.textContent.trim()) || document.querySelector('th');
    const cellStyle=getComputedStyle(headerCell);
    toggle.focus();
    return {
      theme:document.documentElement.dataset.nexusUiTheme,
      body:getComputedStyle(document.body).backgroundColor,
      wrappers:[...document.querySelectorAll('.bg-\\\\[\\\\#f8fafc\\\\]')].map((node)=>getComputedStyle(node).backgroundColor),
      width:rect.width,
      height:rect.height,
      trackWidth:parseFloat(track.width),
      trackHeight:parseFloat(track.height),
      label:toggle.getAttribute('aria-label'),
      title:toggle.getAttribute('title'),
      checked:toggle.getAttribute('aria-checked'),
      outlineStyle:focus.outlineStyle,
      outlineWidth:parseFloat(focus.outlineWidth),
      headerColor:cellStyle.color,
      headerBackground:cellStyle.backgroundColor,
    };
  })()`);
  assert.equal(darkDataOps.body, 'rgb(21, 24, 29)', 'DataOps dark body must use the graphite page tone');
  assert.deepEqual(darkDataOps.wrappers, Array(3).fill(darkDataOps.body), 'all DataOps dark page wrappers must remove bright side gaps');
  assert.ok(darkDataOps.width >= 44 && darkDataOps.height >= 44, `theme switch hit target must be at least 44x44, got ${darkDataOps.width}x${darkDataOps.height}`);
  assert.equal(darkDataOps.trackWidth, 42, 'desktop theme switch visual track width must remain 42px');
  assert.equal(darkDataOps.trackHeight, 28, 'desktop theme switch visual track height must remain 28px');
  assert.equal(darkDataOps.label, '다크모드', 'the switch accessible name must remain stable in dark mode');
  assert.equal(darkDataOps.title, '일반모드로 전환', 'the switch title must describe the next dark-mode action');
  assert.equal(darkDataOps.checked, 'true');
  assert.notEqual(darkDataOps.outlineStyle, 'none', 'the focused switch must retain a visible outline');
  assert.ok(darkDataOps.outlineWidth >= 2, 'the focused switch outline must remain at least 2px');
  assert.ok(contrast(darkDataOps.headerColor, darkDataOps.headerBackground) >= 4.5, 'DataOps dark table text must remain readable');

  const reloaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await reloaded;
  await waitFor(() => evaluate(client, `document.documentElement.dataset.nexusUiTheme === 'dark' && document.querySelectorAll('.bg-\\\\[\\\\#f8fafc\\\\]').length === 3`), 'persisted DataOps dark mode');
  assert.equal(await evaluate(client, `document.querySelector('[data-nexus-ui-theme-toggle]').getAttribute('aria-checked')`), 'true', 'dark mode must persist after reload');

  for (const width of [1920, 1440, 390]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    await wait(80);
    const layout = await evaluate(client, `(() => {
      const header=document.querySelector('.nexus-ui-header').getBoundingClientRect();
      const toggle=document.querySelector('[data-nexus-ui-theme-toggle]').getBoundingClientRect();
      return { viewport:window.innerWidth, scrollWidth:document.scrollingElement.scrollWidth, headerLeft:header.left, headerWidth:header.width, toggleWidth:toggle.width, toggleHeight:toggle.height };
    })()`);
    assert.ok(layout.scrollWidth <= layout.viewport, `DataOps must not add page-level horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs(layout.headerLeft) <= 0.5 && Math.abs(layout.headerWidth - layout.viewport) <= 0.5, `common header must span the viewport at ${width}px`);
    assert.ok(layout.toggleWidth >= 44 && layout.toggleHeight >= 44, `theme switch must retain its hit target at ${width}px`);
  }
  assert.deepEqual(dataOpsConsoleErrors, [], `DataOps console errors: ${dataOpsConsoleErrors.join(' | ')}`);
  assert.deepEqual(runtimeErrors, [], `browser runtime errors: ${runtimeErrors.join(' | ')}`);
  console.log('OrderOps theme/print and DataOps page/switch browser E2E PASS');
} finally {
  client?.close();
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    const exited = new Promise((resolveExit) => browserProcess.once('exit', resolveExit));
    browserProcess.kill();
    await Promise.race([exited, wait(3_000)]);
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  await wait(500);
  assert.ok(resolve(browserProfile).startsWith(`${resolve(tmpdir())}${sep}`), 'browser profile cleanup must stay inside the temporary directory');
  try { rmSync(browserProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch (error) {
    if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error;
  }
}
