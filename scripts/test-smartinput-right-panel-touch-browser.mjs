#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-touch-e2e-'));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
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
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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

  close() {
    this.socket?.close();
  }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const touch = async (client, selector) => {
  const point = await evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.scrollIntoView({block:'center',inline:'center'});const rect=element.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};})()`);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1, force: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
};

let browser;
let client;
try {
  const address = await listen();
  const executable = browserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    try {
      return readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0] || null;
    } catch {
      return null;
    }
  }, 'browser debugging port');
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    return response.ok ? (await response.json()).filter(target => target.type === 'page') : null;
  }, 'browser target');
  client = new CdpClient(targets[0].webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await waitFor(() => evaluate(client, `Boolean(document.querySelector('.nexus-ui-header'))&&Boolean(document.querySelector('#inputRows tr'))`), 'SmartInput shell');

  await click(client, '[data-mode="estimate"]');
  await waitFor(() => evaluate(client, `!document.querySelector('#estimateLibraryHeading').hidden`), 'estimate library');
  if (!await evaluate(client, `document.querySelector('#estimateLibraryView').classList.contains('is-open')`)) {
    await click(client, '#relatedPanelToggle');
  }
  await waitFor(() => evaluate(client, `document.querySelector('#estimateLibraryView').classList.contains('is-open')`), 'mobile estimate drawer');

  const controls = await evaluate(client, `(() => [...document.querySelectorAll('#estimateLibraryIndividualButton,#estimateLibraryLinkedButton,#estimateMultiSelectButton')].map(button => ({id:button.id,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height,touchAction:getComputedStyle(button).touchAction,disabled:button.disabled})))()`);
  assert.equal(controls.every(control => control.width >= 44 && control.height >= 44 && control.touchAction === 'manipulation' && !control.disabled), true,
    'estimate-list header controls must expose enabled 44px touch targets');

  await touch(client, '#estimateMultiSelectButton');
  await waitFor(() => evaluate(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='true'`), 'plus touch enter');
  await touch(client, '#estimateMultiSelectButton');
  await waitFor(() => evaluate(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='false'`), 'plus touch exit');
  await touch(client, '#estimateMultiSelectButton');
  await waitFor(() => evaluate(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='true'`), 'plus touch re-entry');
  await touch(client, '#estimateLibraryLinkedButton');
  await waitFor(() => evaluate(client, `document.querySelector('#estimateMultiSelectButton').getAttribute('aria-pressed')==='false'&&!document.querySelector('#linkedEstimateList').hidden&&document.querySelector('#catalogPickerList').hidden`), 'linked list touch after multiselect');
  await touch(client, '#estimateLibraryIndividualButton');
  await waitFor(() => evaluate(client, `!document.querySelector('#catalogPickerList').hidden&&document.querySelector('#linkedEstimateList').hidden`), 'individual list touch return');

  console.log('SmartInput right-panel touchscreen hotfix PASS', controls);
} finally {
  if (client) {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await Promise.race([client.send('Browser.close').catch(() => {}), wait(2_000)]);
    client.close();
  }
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolveExit => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  await new Promise(resolveClose => server.close(resolveClose));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== 'EPERM' || attempt === 9) {
        if (error.code === 'EPERM') console.warn(`Deferred locked browser profile cleanup: ${profile}`);
        else throw error;
      }
      await wait(250);
    }
  }
}
