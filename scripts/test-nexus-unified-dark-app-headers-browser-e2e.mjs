#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-dark-app-headers-'));
const apps = [
  { path: 'Master.html', id: 'master-lookup', title: '상품관리' },
  { path: 'customer-master/index.html', id: 'customer-master', title: '거래처관리' },
  { path: 'SmartParser.html', id: 'smart-parser', title: '스마트파서', logoFree: true },
  { path: 'MerchOps.html', id: 'merchops', title: 'MerchOps' },
  { path: 'smartinput/index.html', id: 'smart-input', title: '스마트입력' },
  { path: 'orderops/list.html', id: 'orderops', title: '출고관리', logoFree: true },
  { path: 'DataOps.html', id: 'dataops', title: 'DataOps' },
];

for (const app of apps) {
  const html = readFileSync(join(root, app.path), 'utf8');
  assert.match(html, /nexus-ui-app-themes\.css\?v=1\.3\.11/, `${app.path} must load the unified app-header stylesheet token`);
  assert.match(html, new RegExp(`data-nexus-app-header["']?\\s*[:=]\\s*["']${app.id}["']`), `${app.path} must expose the canonical app-header marker`);
  assert.match(html, /data-nexus-app-(?:identity|title)/, `${app.path} must expose its left-aligned app identity`);
}
const parserHtml = readFileSync(join(root, 'SmartParser.html'), 'utf8');
assert.doesNotMatch(parserHtml.slice(parserHtml.indexOf('data-nexus-app-header'), parserHtml.indexOf('data-nexus-app-header') + 5000), />ONEAPP</, 'SmartParser app header must not render the ONEAPP wordmark');
const orderOpsHtml = readFileSync(join(root, 'orderops/list.html'), 'utf8');
assert.doesNotMatch(orderOpsHtml, /brand-logo-frame|brand-logo|brand-mark|brand-badge/, 'OrderOps app header must not retain ONEAPP/ORDER Q logo markup or spacing');

const mime = { '.css':'text/css; charset=utf-8', '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}` || 'Master.html';
    const file = normalize(resolve(root, relative));
    if (file !== root && !file.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Cache-Control':'no-store', 'Content-Type':mime[extname(file).toLowerCase()] || 'application/octet-stream' });
    response.end(readFileSync(file));
  } catch (error) { response.writeHead(500).end(String(error)); }
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const waitFor = async (check, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};
const commandPath = (command) => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding:'utf8', windowsHide:true });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '' : '';
};
const browserPath = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge'),
].filter(Boolean).find(existsSync) || '';

class Cdp {
  constructor(url) { this.url=url; this.socket=null; this.nextId=1; this.pending=new Map(); this.events=new Map(); }
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
      this.socket.addEventListener('open', resolveOpen, { once:true });
      this.socket.addEventListener('error', rejectOpen, { once:true });
    });
  }
  send(method, params={}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve:resolveSend, reject:rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout=60_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter((item) => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true, userGesture:true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};

let browser;
let client;
const runtimeExceptions = [];
try {
  assert.ok(browserPath, 'Chrome/Edge is required for unified app-header browser E2E');
  const address = await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', () => resolveListen(server.address())); });
  browser = spawn(browserPath, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio:'ignore', windowsHide:true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0], 'browser debug port');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).find((item) => item.type === 'page') : null;
  }, 'browser target');
  client = new Cdp(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  client.events.set('Runtime.exceptionThrown', [(params) => runtimeExceptions.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Runtime exception')]);
  const origin = `http://127.0.0.1:${address.port}`;

  const inspect = async (app, width, theme) => {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url:`${origin}/${app.path}` });
    await loaded;
    await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-nexus-app-header="${app.id}"]')) && document.documentElement.dataset.nexusUiReady==='true'`), `${app.id} app header`);
    await evaluate(client, `window.ONEAPP_NEXUS_UI_THEME.apply(${JSON.stringify(theme)})`);
    await waitFor(() => evaluate(client, `document.documentElement.dataset.nexusUiTheme===${JSON.stringify(theme)}`), `${app.id} ${theme} theme`);
    return evaluate(client, `(() => {
      const parseRgb=(value)=>{const parts=value.match(/[\\d.]+/g)?.map(Number)||[];return parts.slice(0,3);};
      const luminance=(rgb)=>rgb.map((v)=>v/255).map((v)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,index)=>sum+(index===0?.2126:index===1?.7152:.0722)*v,0);
      const contrast=(fg,bg)=>{const a=luminance(parseRgb(fg)),b=luminance(parseRgb(bg));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
      const global=document.querySelector('.nexus-ui-header');
      const header=document.querySelector('[data-nexus-app-header="${app.id}"]');
      const identity=header.querySelector('[data-nexus-app-identity]') || header.querySelector('[data-nexus-app-title]');
      const title=header.querySelector('[data-nexus-app-title]');
      const globalRect=global.getBoundingClientRect();
      const headerRect=header.getBoundingClientRect();
      const identityRect=identity.getBoundingClientRect();
      const titleStyle=getComputedStyle(title);
      const headerStyle=getComputedStyle(header);
      const globalStyle=getComputedStyle(global);
      const controls=[...header.querySelectorAll('button,a:not([data-nexus-app-title])')].filter((node)=>{
        const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
        return rect.width>0&&rect.height>0&&rect.bottom>headerRect.top&&rect.top<headerRect.bottom&&style.display!=='none'&&style.visibility!=='hidden';
      });
      const readable=controls.map((node)=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return {text:(node.textContent||node.getAttribute('aria-label')||'').trim(),ratio:contrast(style.color,style.backgroundColor==='rgba(0, 0, 0, 0)'?headerStyle.backgroundColor:style.backgroundColor),left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};});
      const overlap=controls.some((node,index)=>controls.slice(index+1).some((other)=>{const a=node.getBoundingClientRect(),b=other.getBoundingClientRect();return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;}));
      return {
        rootApp:document.documentElement.dataset.nexusUiApp,
        headerMatches:header.matches('html[data-nexus-ui-app] body [data-nexus-app-header]'),
        headerVariable:headerStyle.getPropertyValue('--nexus-app-header-bg').trim(),
        theme:document.documentElement.dataset.nexusUiTheme,
        globalBg:globalStyle.backgroundColor,
        appBg:headerStyle.backgroundColor,
        globalBottom:globalRect.bottom,
        appTop:headerRect.top,
        appHeight:headerRect.height,
        identityLeft:identityRect.left,
        identityText:(identity.textContent||identity.getAttribute('aria-label')||'').trim(),
        titleContrast:contrast(titleStyle.color,headerStyle.backgroundColor),
        controlCount:controls.length,
        minControlContrast:readable.length?Math.min(...readable.map((item)=>item.ratio)):99,
        controls:readable,
        verticalOverflow:readable.some((item)=>item.top<headerRect.top-1||item.bottom>headerRect.bottom+1),
        overlap,
        logoCount:header.querySelectorAll('img,.brand-mark,.brand-logo,.brand-logo-frame').length,
        hasOneApp:/ONEAPP/.test(header.textContent||''),
      };
    })()`);
  };

  for (const width of [1600, 1280, 390]) {
    for (const theme of ['light', 'dark']) {
      const states = [];
      for (const app of apps) {
        const state = await inspect(app, width, theme);
        states.push(state);
        assert.equal(state.globalBg, 'rgb(11, 16, 33)', `${app.id} global header must use the shared dark background`);
        assert.equal(state.appBg, state.globalBg, `${app.id} app header background must match the global header in ${theme}: ${JSON.stringify(state)}`);
        assert.ok(Math.abs(state.appHeight - 56) <= 1, `${app.id} app header must remain 56px at ${width}px`);
        assert.ok(Math.abs(state.appTop - state.globalBottom) <= 1, `${app.id} app header must start immediately below the global header`);
        assert.match(state.identityText, new RegExp(app.title), `${app.id} must expose its app name on the left`);
        assert.ok(state.titleContrast >= 4.5, `${app.id} title contrast must be readable: ${state.titleContrast}`);
        assert.ok(state.minControlContrast >= 4.5, `${app.id} app-header controls must be readable: ${state.minControlContrast}`);
        assert.equal(state.verticalOverflow, false, `${app.id} controls must stay inside the 56px app-header row: ${JSON.stringify(state)}`);
        assert.equal(state.overlap, false, `${app.id} app-header controls must not overlap: ${JSON.stringify(state)}`);
        if (app.logoFree) {
          assert.equal(state.logoCount, 0, `${app.id} app header must not include a logo`);
          assert.equal(state.hasOneApp, false, `${app.id} app header must not include ONEAPP text`);
        }
      }
      const expectedLeft = width <= 700 ? 10 : 24;
      states.forEach((state, index) => assert.ok(Math.abs(state.identityLeft - expectedLeft) <= 1, `${apps[index].id} identity must align at ${expectedLeft}px, got ${state.identityLeft}`));
    }
  }
  assert.deepEqual(runtimeExceptions, [], `app-header pages must not throw runtime exceptions: ${runtimeExceptions.join('; ')}`);
  console.log('PASS NEXUS unified dark app headers: seven apps, theme-independent colors, 56px height, aligned identities, logo removal, readable non-overlapping controls.');
} finally {
  client?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (browser && !browser.killed) {
    const exited = new Promise((resolveExit) => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(1500)]);
  }
  try { rmSync(profile, { recursive:true, force:true, maxRetries:5, retryDelay:100 }); } catch (_) {}
}
