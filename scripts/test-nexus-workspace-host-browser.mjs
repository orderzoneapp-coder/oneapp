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
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    requests.push(pathname);
    if (officialPaths.has(pathname)) {
      const remainingFailures = failNext.get(pathname) || 0;
      if (remainingFailures > 0) {
        failNext.set(pathname, remainingFailures - 1);
        response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
        response.end('<!doctype html><title>fixture 404</title><h1>Not found</h1>');
        return;
      }
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime['.html'] });
      response.end(fixture);
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
    order: [...document.querySelectorAll('[data-nexus-ui-app-target]')].map((node) => node.dataset.nexusUiAppTarget),
  }))()`);
  assert.equal(initial.headers, 1, 'the global header must remain a single DOM node');
  assert.equal(initial.frames, 1, 'the host must keep exactly one iframe');
  assert.equal(initial.app, 'master-lookup');
  assert.equal(initial.route, 'Master.html');
  assert.equal(initial.active, 'master-lookup');
  assert.deepEqual(initial.order, ['master-lookup', 'customer-master', 'smart-input', 'smart-parser', 'merchops', 'orderops', 'dataops']);

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
  const compactExpected = await evaluate(client, `(() => {
    const nav=document.querySelector('.nexus-ui-nav');
    nav.scrollLeft=0;
    const navRect=nav.getBoundingClientRect();
    const targetRect=document.querySelector('[data-nexus-ui-app-target="dataops"]').getBoundingClientRect();
    document.querySelector('#nexusWorkspaceFrame').contentWindow.fixtureState.leaveResult='READY';
    document.querySelector('[data-nexus-ui-app-target="dataops"]').click();
    return Math.max(0,targetRect.right-navRect.right);
  })()`);
  await waitFor(() => evaluate(client, `new URL(location.href).searchParams.get('app') === 'dataops'`), 'hidden-tab transition');
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
  failNext.set('/DataOps.html', 1);
  await evaluate(client, 'history.back()');
  await waitFor(() => evaluate(client, `document.querySelector('#nexusWorkspaceError')?.hidden === false && location.href === ${JSON.stringify(beforePopFailure.href)}`), 'popstate load failure and index restoration', 12_000);
  const popFailure = await evaluate(client, `({href:location.href,length:history.length,app:document.querySelector('[data-nexus-ui-app-target][aria-current="page"]').dataset.nexusUiAppTarget})`);
  assert.equal(popFailure.href, beforePopFailure.href, 'a failed popstate load must restore the previous parent URL');
  assert.equal(popFailure.length, beforePopFailure.length, 'popstate failure restoration must not add history');
  assert.equal(popFailure.app, 'merchops');
  await evaluate(client, `document.querySelector('#nexusWorkspaceRetry').click()`);
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

  assert.deepEqual(runtimeExceptions, [], `workspace runtime must not throw: ${runtimeExceptions.join('; ')}`);
  console.log('PASS NEXUS workspace browser: persistent header, reload re-handshake, indexed history retry, 404 timeout recovery, theme/print, compact reveal.');
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
