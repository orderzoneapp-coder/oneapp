#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = readFileSync(join(root, 'scripts/fixtures/nexus-workspace-app-fixture.html'), 'utf8');
const officialPaths = new Set([
  '/Master.html',
  '/customer-master/index.html',
  '/smartinput/index.html',
  '/SmartParser.html',
  '/MerchOps.html',
  '/orderops/list.html',
  '/DataOps.html',
]);
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const requests = [];
const failNext = new Map();
const delayNext = new Map();
let serveRealApps = false;
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    requests.push(pathname);
    if (officialPaths.has(pathname) && !serveRealApps) {
      const remainingFailures = failNext.get(pathname) || 0;
      if (remainingFailures > 0) {
        failNext.set(pathname, remainingFailures - 1);
        response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
        response.end('<!doctype html><title>fixture 404</title><h1>Not found</h1>');
        return;
      }
      const delayMs = delayNext.get(pathname) || 0;
      delayNext.delete(pathname);
      const sendFixture = () => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
        response.end(fixture);
      };
      if (delayMs > 0) setTimeout(sendFixture, delayMs);
      else sendFixture();
      return;
    }
    const relative = `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
    const file = normalize(resolve(root, relative));
    if (file !== root && !file.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream' });
    response.end(readFileSync(file));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
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
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};

const commandPath = (command) => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '' : '';
};
const browserPath = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  commandPath('google-chrome'),
  commandPath('chromium'),
  commandPath('msedge'),
].filter(Boolean).find(existsSync) || '';

class Cdp {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
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
  once(method, timeout = 20_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) || []).filter((item) => item !== listener));
        resolveEvent(params);
      };
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

const profile = mkdtempSync(join(tmpdir(), 'oneapp-nexus-workspace-'));
let browser;
let client;
const runtimeExceptions = [];
try {
  assert.ok(browserPath, 'Chrome or Edge is required for the NEXUS workspace browser test');
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
  browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 'browser debug port');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).find((item) => item.type === 'page') : null;
  }, 'browser page');
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  client.events.set('Runtime.exceptionThrown', [
    (params) => runtimeExceptions.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Runtime exception'),
  ]);

  const origin = `http://127.0.0.1:${address.port}`;
  const homeLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${origin}/nexus/` });
  await homeLoaded;
  const homeLinks = await waitFor(() => evaluate(client, `(() => {
    const links=[...document.querySelectorAll('#appGrid .nexus-app-card')];
    if (links.length !== 12) return null;
    return links.map((link) => {
      const url=new URL(link.href);
      return {
        id:link.dataset.nexusAppId,
        route:link.dataset.nexusAppRoute,
        label:link.querySelector('strong')?.textContent,
        ariaLabel:link.getAttribute('aria-label'),
        path:url.pathname,
        app:url.searchParams.get('app'),
        workspaceRoute:url.searchParams.get('route')
      };
    });
  })()`), 'NEXUS home canonical app links');
  assert.deepEqual(homeLinks, [
    { id:'master-lookup', route:'/Master.html', label:'상품관리', ariaLabel:'상품관리 열기', path:'/nexus/workspace.html', app:'master-lookup', workspaceRoute:'Master.html' },
    { id:'customer-master', route:'/customer-master/index.html', label:'거래처관리', ariaLabel:'거래처관리 열기', path:'/nexus/workspace.html', app:'customer-master', workspaceRoute:'customer-master/index.html' },
    { id:'merchops', route:'/MerchOps.html', label:'가격·시세', ariaLabel:'가격·시세 열기', path:'/nexus/workspace.html', app:'merchops', workspaceRoute:'MerchOps.html' },
    { id:'smart-input', route:'/smartinput/index.html', label:'스마트입력', ariaLabel:'스마트입력 열기', path:'/nexus/workspace.html', app:'smart-input', workspaceRoute:'smartinput/index.html' },
    { id:'orderops', route:'/orderops/list.html', label:'출고관리', ariaLabel:'출고관리 열기', path:'/nexus/workspace.html', app:'orderops', workspaceRoute:'orderops/list.html' },
    { id:'dataops', route:'/DataOps.html', label:'재고·정산', ariaLabel:'재고·정산 열기', path:'/nexus/workspace.html', app:'dataops', workspaceRoute:'DataOps.html' },
    { id:'smart-parser', route:'/SmartParser.html', label:'문서분석', ariaLabel:'문서분석 열기', path:'/nexus/workspace.html', app:'smart-parser', workspaceRoute:'SmartParser.html' },
    { id:'export-center', route:'/export_center.html', label:'출력검증', ariaLabel:'출력검증 열기', path:'/export_center.html', app:null, workspaceRoute:null },
    { id:'settings', route:'/settings.html', label:'환경설정', ariaLabel:'환경설정 열기', path:'/settings.html', app:null, workspaceRoute:null },
    { id:'item-manager', route:'/Item_manager.html', label:'SKU 관리', ariaLabel:'SKU 관리 열기', path:'/Item_manager.html', app:null, workspaceRoute:null },
    { id:'history-viewer', route:'/history_viewer.html', label:'변경이력', ariaLabel:'변경이력 열기', path:'/history_viewer.html', app:null, workspaceRoute:null },
    { id:'orderq-vnext', route:'/orderq/', label:'주문조회', ariaLabel:'주문조회 열기', path:'/orderq/', app:null, workspaceRoute:null },
  ], 'all NEXUS home buttons must preserve label, app ID, route, and destination');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `document.querySelector('#loginPanel').hidden=true; document.querySelector('#homePanel').hidden=false; true`);
  const homeDesktopTargets = await evaluate(client, `(async () => {
    const results=[];
    for (const link of document.querySelectorAll('#appGrid .nexus-app-card')) {
      link.scrollIntoView({block:'center',inline:'nearest'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect=link.getBoundingClientRect();
      const x=rect.left+rect.width/2;
      const y=rect.top+rect.height/2;
      results.push({
        id:link.dataset.nexusAppId,
        hit:document.elementFromPoint(x,y)?.closest?.('[data-nexus-app-id]')?.dataset.nexusAppId || '',
      });
    }
    return results;
  })()`);
  assert.deepEqual(
    homeDesktopTargets,
    homeLinks.map(({ id }) => ({ id, hit:id })),
    'every NEXUS home button center must remain clickable at a 1080px desktop width',
  );
  const homeOrderOpsPoint = await evaluate(client, `(() => {
    const link=document.querySelector('[data-nexus-app-id="orderops"]');
    link.scrollIntoView({block:'center',inline:'nearest'});
    const rect=link.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  const homeOrderOpsLoaded = client.once('Page.loadEventFired');
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', x:homeOrderOpsPoint.x, y:homeOrderOpsPoint.y, button:'left', clickCount:1 });
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:homeOrderOpsPoint.x, y:homeOrderOpsPoint.y, button:'left', clickCount:1 });
  await homeOrderOpsLoaded;
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'orderops'
    && new URL(location.href).searchParams.get('route') === 'orderops/list.html'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'orderops'`), 'NEXUS home OrderOps card destination');

  const loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${origin}/nexus/workspace.html` });
  await loaded;
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceFrame')?.contentDocument?.documentElement.dataset.fixtureReady === 'true'`), 'initial fixture ready');

  const initial = await evaluate(client, `(() => ({
    headers: document.querySelectorAll('.nexus-ui-header').length,
    frames: document.querySelectorAll('#nexusWorkspaceFrame').length,
    app: new URL(location.href).searchParams.get('app'),
    route: new URL(location.href).searchParams.get('route'),
    active: document.querySelector('[data-nexus-ui-app-target][aria-current="page"]')?.dataset.nexusUiAppTarget,
    links: [...document.querySelectorAll('[data-nexus-ui-app-target]')].map((node) => ({
      id:node.dataset.nexusUiAppTarget,
      route:node.dataset.nexusUiRoute,
      href:new URL(node.href).pathname,
      label:node.textContent,
      ariaLabel:node.getAttribute('aria-label')
    })),
  }))()`);
  assert.equal(initial.headers, 1, 'the global header must remain a single DOM node');
  assert.equal(initial.frames, 1, 'the host must keep exactly one iframe');
  assert.equal(initial.app, 'master-lookup');
  assert.equal(initial.route, 'Master.html');
  assert.equal(initial.active, 'master-lookup');
  assert.deepEqual(initial.links, [
    { id:'master-lookup', route:'Master.html', href:'/Master.html', label:'상품관리', ariaLabel:'상품관리 열기' },
    { id:'customer-master', route:'customer-master/index.html', href:'/customer-master/index.html', label:'거래처관리', ariaLabel:'거래처관리 열기' },
    { id:'smart-input', route:'smartinput/index.html', href:'/smartinput/index.html', label:'스마트입력', ariaLabel:'스마트입력 열기' },
    { id:'smart-parser', route:'SmartParser.html', href:'/SmartParser.html', label:'스마트파서', ariaLabel:'스마트파서 열기' },
    { id:'merchops', route:'MerchOps.html', href:'/MerchOps.html', label:'MerchOps', ariaLabel:'MerchOps 열기' },
    { id:'orderops', route:'orderops/list.html', href:'/orderops/list.html', label:'출고관리', ariaLabel:'출고관리 열기' },
    { id:'dataops', route:'DataOps.html', href:'/DataOps.html', label:'DataOps', ariaLabel:'DataOps 열기' },
  ], 'the rendered global header must expose the exact canonical destination for every button');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const desktopHeaderTargets = await evaluate(client, `(() => ({
    headerHeight:document.querySelector('.nexus-ui-header').getBoundingClientRect().height,
    links:[...document.querySelectorAll('[data-nexus-ui-app-target]')].map((link) => {
      const rect=link.getBoundingClientRect();
      const x=rect.left+rect.width/2;
      const y=rect.top+rect.height/2;
      return {
        id:link.dataset.nexusUiAppTarget,
        hit:document.elementFromPoint(x,y)?.closest?.('[data-nexus-ui-app-target]')?.dataset.nexusUiAppTarget || '',
      };
    })
  }))()`);
  assert.equal(desktopHeaderTargets.headerHeight, 104, 'compact desktop header must use a second row instead of covering app links');
  assert.deepEqual(
    desktopHeaderTargets.links,
    initial.links.map(({ id }) => ({ id, hit:id })),
    'every global-header button center must remain clickable at a 1080px desktop width',
  );
  const desktopOrderOpsPoint = await evaluate(client, `(() => {
    document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.leaveResult='READY';
    const link=document.querySelector('[data-nexus-ui-app-target="orderops"]');
    const rect=link.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  })()`);
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', x:desktopOrderOpsPoint.x, y:desktopOrderOpsPoint.y, button:'left', clickCount:1 });
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:desktopOrderOpsPoint.x, y:desktopOrderOpsPoint.y, button:'left', clickCount:1 });
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'orderops'
    && new URL(location.href).searchParams.get('route') === 'orderops/list.html'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'orderops'`), 'desktop OrderOps mouse destination');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

  await evaluate(client, `document.querySelector('.nexus-ui-header').dataset.workspaceTestMarker='persistent-header'`);
  const visibleBefore = await evaluate(client, `document.querySelector('.nexus-ui-nav').scrollLeft`);
  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="customer-master"]').click()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'customer-master' && document.querySelector('#nexusWorkspaceFrame')?.contentDocument?.documentElement.dataset.fixtureReady === 'true'`), 'visible-tab transition');
  const visibleAfter = await evaluate(client, `document.querySelector('.nexus-ui-nav').scrollLeft`);
  assert.equal(visibleAfter, visibleBefore, 'a visible current tab must not move the navigation scroll position');
  assert.equal(await evaluate(client, `document.querySelector('.nexus-ui-header')?.dataset.workspaceTestMarker`), 'persistent-header', 'app transitions must preserve the original global-header DOM node');

  const hrefBeforeSpoof = await evaluate(client, 'location.href');
  await evaluate(client, `window.postMessage({schemaVersion:'nexus-workspace-message/v1',type:'NEXUS_WORKSPACE_ROUTE_CHANGED_V1',transitionId:'stale',appId:'customer-master',route:'customer-master/index.html?spoof=1'}, location.origin)`);
  await wait(100);
  assert.equal(await evaluate(client, 'location.href'), hrefBeforeSpoof, 'a message from the parent window must be ignored');
  await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureRouteChanged('customer-master/index.html?accepted=1', 'stale-transition')`);
  await wait(100);
  assert.equal(await evaluate(client, 'location.href'), hrefBeforeSpoof, 'a stale child transition must be ignored');
  await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureRouteChanged('customer-master/index.html?accepted=1')`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('route') === 'customer-master/index.html?accepted=1'`), 'accepted route replacement');

  const reloadBoot = await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.bootCount`);
  await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.location.reload()`);
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.bootCount > ${reloadBoot}
    && document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.hostReadyCount === 1
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'child reload re-handshake');

  await evaluate(client, `document.querySelector('[data-nexus-ui-theme-set="dark"]').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentDocument.documentElement.dataset.nexusUiTheme === 'dark'`), 'theme propagation');
  await evaluate(client, `document.querySelector('.nexus-ui-brand__current').focus(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true,cancelable:true}))`);
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.printCount === 1`), 'print delegation');

  await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.leaveResult='BLOCKED'; document.querySelector('[data-nexus-ui-app-target="smart-input"]').click()`);
  await waitFor(() => evaluate(client, `!document.querySelector('#nexusWorkspaceNotice').hidden`), 'blocked transition notice');
  assert.equal(await evaluate(client, `new URL(location.href).searchParams.get('app')`), 'customer-master', 'blocked leave must preserve the current route');
  assert.equal(await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.appId`), 'customer-master', 'blocked leave must preserve the current iframe');

  requests.length = 0;
  await evaluate(client, `(() => {
    const child=document.querySelector('#nexusWorkspaceFrame').contentWindow;
    child.fixtureState.leaveResult='READY';
    child.fixtureState.leaveDelay=150;
    document.querySelector('[data-nexus-ui-app-target="smart-parser"]').click();
    document.querySelector('[data-nexus-ui-app-target="merchops"]').click();
  })()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'merchops' && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'merchops'`), 'serialized final navigation');
  assert.equal(requests.filter((path) => path === '/SmartParser.html').length, 0, 'a superseded fast selection must not load an intermediate app');
  assert.equal(requests.filter((path) => path === '/MerchOps.html').length, 1, 'the final fast selection must load once');

  await evaluate(client, 'history.back()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'customer-master'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'customer-master'
    && document.querySelector('[data-nexus-ui-app-target][aria-current="page"]')?.dataset.nexusUiAppTarget === 'customer-master'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'parent history back');
  await evaluate(client, 'history.forward()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'merchops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'merchops'
    && document.querySelector('[data-nexus-ui-app-target][aria-current="page"]')?.dataset.nexusUiAppTarget === 'merchops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'parent history forward');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evaluate(client, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const orderOpsTouch = await evaluate(client, `(() => {
    const link=document.querySelector('[data-nexus-ui-app-target="orderops"]');
    link.scrollIntoView({block:'nearest',inline:'center'});
    const rect=link.getBoundingClientRect();
    const x=rect.left+rect.width/2;
    const y=rect.top+rect.height/2;
    return {x,y,hit:document.elementFromPoint(x,y)?.closest?.('[data-nexus-ui-app-target]')?.dataset.nexusUiAppTarget};
  })()`);
  assert.equal(orderOpsTouch.hit, 'orderops', 'the visual center of the mobile OrderOps button must hit OrderOps itself');
  await client.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ x:orderOpsTouch.x, y:orderOpsTouch.y }] });
  await client.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'orderops'
    && new URL(location.href).searchParams.get('route') === 'orderops/list.html'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'orderops'`), 'mobile OrderOps touch destination');
  const compactExpected = await evaluate(client, `(() => {
    const nav=document.querySelector('.nexus-ui-nav');
    nav.scrollLeft=0;
    const navRect=nav.getBoundingClientRect();
    const targetRect=document.querySelector('[data-nexus-ui-app-target="dataops"]').getBoundingClientRect();
    document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.leaveResult='READY';
    document.querySelector('[data-nexus-ui-app-target="dataops"]').click();
    return Math.max(0,targetRect.right-navRect.right);
  })()`);
  await waitFor(() => evaluate(client, `(() => {
    const nav=document.querySelector('.nexus-ui-nav').getBoundingClientRect();
    const active=document.querySelector('[data-nexus-ui-app-target="dataops"]').getBoundingClientRect();
    return new URL(location.href).searchParams.get('app') === 'dataops'
      && active.left >= nav.left - 1 && active.right <= nav.right + 1;
  })()`), 'hidden-tab transition and minimum reveal');
  const compactScroll = await evaluate(client, `document.querySelector('.nexus-ui-nav').scrollLeft`);
  assert.ok(compactScroll > 0, 'a hidden current tab must move only enough to reveal itself');
  assert.ok(Math.abs(compactScroll - compactExpected) <= 1, `a hidden tab must move by the minimum reveal distance: ${compactScroll} vs ${compactExpected}`);
  const geometry = await evaluate(client, `(() => {
    const nav=document.querySelector('.nexus-ui-nav').getBoundingClientRect();
    const active=document.querySelector('[data-nexus-ui-app-target][aria-current="page"]').getBoundingClientRect();
    const main=document.querySelector('.nexus-workspace__main').getBoundingClientRect();
    return {visible:active.left>=nav.left-1&&active.right<=nav.right+1, mainBottom:main.bottom, viewport:innerHeight, headerCount:document.querySelectorAll('.nexus-ui-header').length, frameCount:document.querySelectorAll('#nexusWorkspaceFrame').length};
  })()`);
  assert.equal(geometry.visible, true);
  assert.ok(Math.abs(geometry.mainBottom - geometry.viewport) <= 1, 'the host height must subtract the mobile global header exactly once');
  assert.equal(geometry.headerCount, 1);
  assert.equal(geometry.frameCount, 1);

  const recoveryPhaseLoaded = client.once('Page.loadEventFired');
  await evaluate(client, `location.replace(${JSON.stringify(`${origin}/nexus/workspace.html?app=dataops&route=DataOps.html`)})`);
  await recoveryPhaseLoaded;
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'isolated history recovery phase');

  const invalidHeaderHref = await evaluate(client, `(() => {
    const link=document.querySelector('[data-nexus-ui-app-target="orderops"]');
    const original=link.href;
    link.href='/smartinput/index.html';
    link.click();
    link.href=original;
    return location.href;
  })()`);
  await wait(100);
  assert.equal(await evaluate(client, 'location.href'), invalidHeaderHref, 'an invalid global-header href must be blocked before browser navigation');

  requests.length = 0;
  delayNext.set('/SmartParser.html', 2500);
  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="smart-parser"]').click()`);
  await waitFor(() => requests.includes('/SmartParser.html'), 'started intermediate app request');
  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="merchops"]').click()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'merchops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'merchops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'superseded started app navigation');
  assert.equal(requests.filter((path) => path === '/SmartParser.html').length, 1, 'an already-started intermediate request may occur once');
  assert.equal(requests.filter((path) => path === '/MerchOps.html').length, 1, 'the final selection must start without waiting for the superseded response');

  const resetAfterSupersede = client.once('Page.loadEventFired');
  await evaluate(client, `location.replace(${JSON.stringify(`${origin}/nexus/workspace.html?app=dataops&route=DataOps.html`)})`);
  await resetAfterSupersede;
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'current-tab cancellation source');

  requests.length = 0;
  delayNext.set('/smartinput/index.html', 2500);
  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="smart-input"]').click()`);
  await waitFor(() => requests.includes('/smartinput/index.html'), 'started target before current-tab cancellation');
  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="dataops"]').click()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'current-tab cancellation reload');
  assert.equal(requests.filter((path) => path === '/DataOps.html').length, 1, 'current-tab cancellation after document replacement must reopen the previous app once');

  failNext.set('/smartinput/index.html', 1);
  const beforePushFailure = await evaluate(client, `({href:location.href,length:history.length,app:document.querySelector('[data-nexus-ui-app-target][aria-current="page"]').dataset.nexusUiAppTarget})`);
  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="smart-input"]').click()`);
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceError')?.hidden === false`), '404 handshake timeout', 12_000);
  const pushFailure = await evaluate(client, `({href:location.href,length:history.length,app:document.querySelector('[data-nexus-ui-app-target][aria-current="page"]').dataset.nexusUiAppTarget,message:document.querySelector('#nexusWorkspaceErrorMessage').textContent})`);
  assert.equal(pushFailure.href, beforePushFailure.href, 'a failed pushed load must keep the previous parent URL');
  assert.equal(pushFailure.length, beforePushFailure.length, 'a failed pushed load must not create a parent history entry');
  assert.equal(pushFailure.app, beforePushFailure.app, 'a failed pushed load must restore the previous active header');
  assert.match(pushFailure.message, /연결 신호/);
  await evaluate(client, `document.querySelector('#nexusWorkspaceRetry').click()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'smart-input'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'smart-input'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'pushed retry success');
  assert.equal(await evaluate(client, 'history.length'), beforePushFailure.length + 1, 'retry must retain the original push history mode');
  await evaluate(client, 'history.back()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'retry push history back');
  await evaluate(client, 'history.forward()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'smart-input'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'smart-input'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'retry push history forward');
  await evaluate(client, 'history.back()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'retry push history back again');

  await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="merchops"]').click()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'merchops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'merchops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'popstate-failure source');
  const beforePopFailure = await evaluate(client, `({href:location.href,length:history.length})`);
  // Hold only the restored-document READY message. This makes retry run
  // inside the reconnect window deterministically, without a timing delay.
  await evaluate(client, `(() => {
    const prototype=ONEAPP_NEXUS_WORKSPACE.WorkspaceHost.prototype;
    const originalFail=prototype.failLoad;
    const originalMessage=prototype.onMessage;
    window.reconnectRace={held:[],restore(){prototype.failLoad=originalFail;prototype.onMessage=originalMessage;}};
    prototype.failLoad=function(...args){window.reconnectRace.host=this;return originalFail.apply(this,args);};
    prototype.onMessage=function(event){
      if(this.pendingLoad?.preserveFailedLoad && event.data?.type===ONEAPP_NEXUS_WORKSPACE.MESSAGE_TYPES.APP_READY){
        window.reconnectRace.held.push(event);
        return;
      }
      return originalMessage.call(this,event);
    };
  })()`);
  failNext.set('/DataOps.html', 1);
  await evaluate(client, 'history.back()');
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceError')?.hidden === false && location.href === ${JSON.stringify(beforePopFailure.href)}`), 'popstate load failure and index restoration', 12_000);
  const popFailure = await evaluate(client, `({href:location.href,length:history.length,app:document.querySelector('[data-nexus-ui-app-target][aria-current="page"]').dataset.nexusUiAppTarget})`);
  assert.equal(popFailure.href, beforePopFailure.href, 'a failed popstate load must restore the previous parent URL');
  assert.equal(popFailure.length, beforePopFailure.length, 'popstate failure restoration must not add history');
  assert.equal(popFailure.app, 'merchops');
  await evaluate(client, `(() => {
    const host=window.reconnectRace.host;
    if(!host.pendingLoad?.preserveFailedLoad){
      document.querySelector('#nexusWorkspaceFrame').contentWindow.location.replace(host.currentTarget.url);
    }
  })()`);
  const reconnectWindow = await waitFor(() => evaluate(client, `(() => {
    const race=window.reconnectRace;
    const host=race.host;
    if(!race.held.length || !host.pendingLoad?.preserveFailedLoad || host.historyRestore || host.transitionRunning) return null;
    return {
      current:host.currentTarget.app.id,
      reconnecting:host.loadingTarget.app.id,
      failed:host.failedLoad?.target.app.id,
      mode:host.failedLoad?.historyMode,
      errorVisible:!document.querySelector('#nexusWorkspaceError').hidden,
      standalone:new URL(document.querySelector('#nexusWorkspaceStandalone').href).pathname,
    };
  })()`), 'controlled restored-app reconnect before retry');
  assert.deepEqual(reconnectWindow, { current: 'merchops', reconnecting: 'merchops', failed: 'dataops', mode: 'none', errorVisible: true, standalone: '/DataOps.html' }, 'the visible failure must retain DataOps while MerchOps reconnect is unfinished');
  await evaluate(client, `document.querySelector('#nexusWorkspaceRetry').click()`);
  await evaluate(client, `(() => {
    const race=window.reconnectRace;
    race.restore();
    for(const event of race.held) race.host.onMessage(event);
  })()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'popstate retry success');
  assert.equal(await evaluate(client, 'history.length'), beforePopFailure.length, 'popstate retry must retain no-new-entry history mode');
  await evaluate(client, 'history.forward()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'merchops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'merchops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'restored popstate forward meaning');
  await evaluate(client, 'history.back()');
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'
    && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'dataops'
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'restored popstate back meaning');

  await evaluate(client, `document.querySelector('#nexusWorkspaceFrame').contentWindow.location.href='/DataOps.html?fullNavigation=1'`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('route') === 'DataOps.html?fullNavigation=1'
    && document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.hostReadyCount === 1
    && document.querySelector('#nexusWorkspaceLoading').hidden`), 'child full-navigation re-handshake');

  const invalidLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `${origin}/nexus/workspace.html?app=master-lookup&route=${encodeURIComponent('https://attacker.test/Master.html')}` });
  await invalidLoaded;
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceError')?.hidden === false`), 'invalid-route safe screen');
  const invalid = await evaluate(client, `(() => ({src:document.querySelector('#nexusWorkspaceFrame').getAttribute('src'), standalone:new URL(document.querySelector('#nexusWorkspaceStandalone').href).pathname, text:document.querySelector('#nexusWorkspaceErrorMessage').textContent}))()`);
  assert.equal(invalid.src, null, 'an invalid initial route must not navigate the iframe');
  assert.equal(invalid.standalone, '/Master.html');
  assert.match(invalid.text, /허용되지 않은/);
  await evaluate(client, `document.querySelector('#nexusWorkspaceRetry').click()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'master-lookup' && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === 'master-lookup'`), 'safe retry fallback');

  const appIds = ['master-lookup', 'customer-master', 'smart-input', 'smart-parser', 'merchops', 'orderops', 'dataops'];
  let directedTransitions = 0;
  for (const sourceAppId of appIds) {
    for (const targetAppId of appIds) {
      if (sourceAppId === targetAppId) continue;
      if (await evaluate(client, `new URL(location.href).searchParams.get('app')`) !== sourceAppId) {
        await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="${sourceAppId}"]').click()`);
        await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === '${sourceAppId}'
          && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === '${sourceAppId}'
          && document.querySelector('#nexusWorkspaceLoading').hidden`), `42-direction source ${sourceAppId}`);
      }
      await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="${targetAppId}"]').click()`);
      await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === '${targetAppId}'
        && document.querySelector('#nexusWorkspaceFrame')?.contentWindow.fixtureState?.appId === '${targetAppId}'
        && document.querySelector('#nexusWorkspaceLoading').hidden`), `42-direction ${sourceAppId} to ${targetAppId}`);
      directedTransitions += 1;
    }
  }
  assert.equal(directedTransitions, 42, 'all seven apps must complete all 42 directed transitions');

  serveRealApps = true;
  const realAppsLoaded = client.once('Page.loadEventFired');
  await evaluate(client, `location.replace(${JSON.stringify(`${origin}/nexus/workspace.html?app=master-lookup&route=Master.html`)})`);
  await realAppsLoaded;
  for (const realAppId of appIds) {
    // The restored OrderOps screen predates the shared app-header marker, but
    // still must complete the real host handshake and safe navigation checks.
    const realHeaderSelector = realAppId === 'orderops'
      ? 'header.global-header'
      : `[data-nexus-app-header="${realAppId}"]`;
    if (await evaluate(client, `new URL(location.href).searchParams.get('app')`) !== realAppId) {
      await evaluate(client, `document.querySelector('[data-nexus-ui-app-target="${realAppId}"]').click()`);
    }
    try {
      await waitFor(() => evaluate(client, `(() => {
        const frame=document.querySelector('#nexusWorkspaceFrame');
        const child=frame?.contentWindow;
        return new URL(location.href).searchParams.get('app') === '${realAppId}'
          && document.querySelector('#nexusWorkspaceLoading').hidden
          && child?.ONEAPP_NEXUS_WORKSPACE_CHILD?.connected === true
          && child.document.documentElement.dataset.nexusWorkspaceEmbedded === 'true'
          && Boolean(child.document.querySelector(${JSON.stringify(realHeaderSelector)}));
      })()`), `real integrated app ${realAppId}`, 60_000);
    } catch (error) {
      const diagnostic = await evaluate(client, `(() => {
        const frame=document.querySelector('#nexusWorkspaceFrame');
        const child=frame?.contentWindow;
        return {
          requested:'${realAppId}',
          parentApp:new URL(location.href).searchParams.get('app'),
          childHref:child?.location?.href || '',
          connected:child?.ONEAPP_NEXUS_WORKSPACE_CHILD?.connected || false,
          adapterRegistered:child?.ONEAPP_NEXUS_WORKSPACE_CHILD?.adapterRegistered || false,
          ready:child?.document?.documentElement?.dataset?.nexusWorkspaceReady || '',
          readyError:child?.document?.documentElement?.dataset?.nexusWorkspaceReadyError || '',
          rendered:Boolean(child?.__SMART_PARSER_RENDERED__),
          bodyText:child?.document?.body?.innerText?.slice(0,300) || '',
          errorHidden:document.querySelector('#nexusWorkspaceError')?.hidden,
          errorMessage:document.querySelector('#nexusWorkspaceErrorMessage')?.textContent || ''
        };
      })()`);
      console.error('Workspace real-app diagnostic:', JSON.stringify({ ...diagnostic, runtimeExceptions }));
      throw error;
    }
    const chromeState = await evaluate(client, `(() => {
      const frame=document.querySelector('#nexusWorkspaceFrame');
      return {
        hostHeaders:document.querySelectorAll('.nexus-ui-header').length,
        childHeaders:frame.contentDocument.querySelectorAll('.nexus-ui-header').length,
        frameCount:document.querySelectorAll('#nexusWorkspaceFrame').length
      };
    })()`);
    assert.deepEqual(chromeState, { hostHeaders: 1, childHeaders: 0, frameCount: 1 }, `${realAppId} must keep only the persistent host header`);
  }

  assert.deepEqual(runtimeExceptions, [], `workspace runtime must not throw: ${runtimeExceptions.join('; ')}`);
  console.log('PASS NEXUS workspace browser: exact header-link blocking, queued and started-navigation supersession, current-tab cancellation, seven real apps, 42 directed transitions, persistent header, adapter handshake, controlled reconnect/early indexed-history retry, failure recovery, theme/print, compact reveal.');
} finally {
  client?.close();
  if (browser && !browser.killed) {
    const exited = new Promise((resolveExit) => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(1500)]);
  }
  server.closeAllConnections?.();
  await new Promise((resolveClose) => server.close(resolveClose));
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
