#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-orderq-cloud-settings-'));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'orderq/cloud.html' : `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
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
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
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
const setInput = (client, selector, value) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const navigate = async (client, url) => {
  await client.send('Page.navigate', { url });
  await waitFor(() => evaluate(client, `document.readyState==='complete'`), 'page ready');
  await waitFor(() => evaluate(client, `document.querySelector('#cloudTokenState')?.dataset.state!=='unknown'`), 'cloud token state');
};

const tokenStorageKey = 'oneapp_orderq_access_token_v1';
const urlStorageKey = 'oneapp_cloud_sync_url_v1';
const cloudUrl = 'https://script.google.com/macros/s/orderq-browser-test/exec';
const changedCloudUrl = 'https://script.google.com/macros/s/orderq-browser-test-changed/exec';
const savedToken = 'ORDERQ_BROWSER_SECRET_20260906';
const failedToken = 'ORDERQ_BROWSER_NOOP_SECRET_20260906';
const domSafetyExpression = token => `(() => {const token=${JSON.stringify(token)};const input=document.querySelector('#cloudToken');return {inputType:input?.type||'',inputValueBlank:input?.value==='',valueAttributeBlank:!input?.getAttribute('value'),bodySafe:!document.body.innerText.includes(token),htmlSafe:!document.documentElement.outerHTML.includes(token)};})()`;

let browser;
let client;
const runtimeErrors = [];
const consoleMessages = [];
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
  client.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'runtime exception'));
  client.on('Runtime.consoleAPICalled', event => consoleMessages.push((event.args || []).map(argument => String(argument.value ?? argument.description ?? '')).join(' ')));
  const pageUrl = `http://127.0.0.1:${address.port}/orderq/cloud.html?token-settings-browser=1`;
  await navigate(client, pageUrl);

  const initial = await evaluate(client, `(() => ({inputType:document.querySelector('#cloudToken').type,inputValue:document.querySelector('#cloudToken').value,state:document.querySelector('#cloudTokenState').dataset.state,stateText:document.querySelector('#cloudTokenState').textContent,hasBrowserNotice:document.body.innerText.includes('현재 브라우저의 로컬 저장소에만 저장됩니다')}))()`);
  assert.deepEqual(initial, { inputType: 'password', inputValue: '', state: 'unset', stateText: '현재 브라우저 토큰: 미설정', hasBrowserNotice: true });

  await setInput(client, '#cloudUrl', changedCloudUrl);
  await setInput(client, '#cloudToken', '   ');
  await click(client, '#saveUrlBtn');
  await waitFor(() => evaluate(client, `document.querySelector('#message').textContent.includes('빈 값은 저장할 수 없습니다')`), 'blank-token warning');
  const blankSave = await evaluate(client, `(() => ({tokenUntouched:localStorage.getItem(${JSON.stringify(tokenStorageKey)})===null,urlUntouched:localStorage.getItem(${JSON.stringify(urlStorageKey)})===null,inputBlank:document.querySelector('#cloudToken').value==='',state:document.querySelector('#cloudTokenState').dataset.state,messageType:document.querySelector('#message').classList.contains('warn')}))()`);
  assert.deepEqual(blankSave, { tokenUntouched: true, urlUntouched: true, inputBlank: true, state: 'unset', messageType: true });

  await setInput(client, '#cloudUrl', cloudUrl);
  await setInput(client, '#cloudToken', savedToken);
  await click(client, '#saveUrlBtn');
  await waitFor(() => evaluate(client, `document.querySelector('#message').textContent.includes('접근 토큰을 저장했습니다')&&document.querySelector('#cloudTokenState').dataset.state==='saved'`), 'verified token save');
  const saved = await evaluate(client, `(() => ({tokenPersisted:localStorage.getItem(${JSON.stringify(tokenStorageKey)})===${JSON.stringify(savedToken)},urlPersisted:localStorage.getItem(${JSON.stringify(urlStorageKey)})===${JSON.stringify(cloudUrl)},stateText:document.querySelector('#cloudTokenState').textContent}))()`);
  assert.deepEqual(saved, { tokenPersisted: true, urlPersisted: true, stateText: '현재 브라우저 토큰: 저장됨' });
  assert.deepEqual(await evaluate(client, domSafetyExpression(savedToken)), { inputType: 'password', inputValueBlank: true, valueAttributeBlank: true, bodySafe: true, htmlSafe: true });

  await navigate(client, pageUrl);
  const reloaded = await evaluate(client, `(() => ({tokenPersisted:localStorage.getItem(${JSON.stringify(tokenStorageKey)})===${JSON.stringify(savedToken)},urlPersisted:document.querySelector('#cloudUrl').value===${JSON.stringify(cloudUrl)},inputBlank:document.querySelector('#cloudToken').value==='',state:document.querySelector('#cloudTokenState').dataset.state,stateText:document.querySelector('#cloudTokenState').textContent}))()`);
  assert.deepEqual(reloaded, { tokenPersisted: true, urlPersisted: true, inputBlank: true, state: 'saved', stateText: '현재 브라우저 토큰: 저장됨' });
  assert.deepEqual(await evaluate(client, domSafetyExpression(savedToken)), { inputType: 'password', inputValueBlank: true, valueAttributeBlank: true, bodySafe: true, htmlSafe: true });

  await setInput(client, '#cloudUrl', changedCloudUrl);
  await setInput(client, '#cloudToken', '\t  ');
  await click(client, '#saveUrlBtn');
  await waitFor(() => evaluate(client, `document.querySelector('#message').textContent.includes('빈 값은 저장할 수 없습니다')`), 'blank-token preservation warning');
  const preserved = await evaluate(client, `(() => ({tokenPreserved:localStorage.getItem(${JSON.stringify(tokenStorageKey)})===${JSON.stringify(savedToken)},urlPreserved:localStorage.getItem(${JSON.stringify(urlStorageKey)})===${JSON.stringify(cloudUrl)},inputBlank:document.querySelector('#cloudToken').value==='',state:document.querySelector('#cloudTokenState').dataset.state}))()`);
  assert.deepEqual(preserved, { tokenPreserved: true, urlPreserved: true, inputBlank: true, state: 'saved' });

  await evaluate(client, `(() => {window.__orderQOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===${JSON.stringify(tokenStorageKey)})return;return window.__orderQOriginalSetItem.call(this,key,value);};return true;})()`);
  await setInput(client, '#cloudToken', failedToken);
  await click(client, '#saveUrlBtn');
  await waitFor(() => evaluate(client, `document.querySelector('#message').textContent.includes('토큰 저장을 확인하지 못했습니다')`), 'persistence verification failure');
  const failed = await evaluate(client, `(() => ({successMessage:document.querySelector('#message').textContent.includes('접근 토큰을 저장했습니다'),messageType:document.querySelector('#message').classList.contains('error'),inputBlank:document.querySelector('#cloudToken').value==='',state:document.querySelector('#cloudTokenState').dataset.state,tokenMissing:localStorage.getItem(${JSON.stringify(tokenStorageKey)})===null}))()`);
  assert.deepEqual(failed, { successMessage: false, messageType: true, inputBlank: true, state: 'unset', tokenMissing: true });
  assert.deepEqual(await evaluate(client, domSafetyExpression(failedToken)), { inputType: 'password', inputValueBlank: true, valueAttributeBlank: true, bodySafe: true, htmlSafe: true });
  await evaluate(client, `(() => {Storage.prototype.setItem=window.__orderQOriginalSetItem;delete window.__orderQOriginalSetItem;return true;})()`);

  const logged = consoleMessages.join('\n');
  assert.equal(logged.includes(savedToken), false, 'saved token must not be logged');
  assert.equal(logged.includes(failedToken), false, 'failed token must not be logged');
  assert.deepEqual(runtimeErrors, []);
  console.log('ORDER Q Cloud token settings browser regression PASS', {
    blankSaveBlocked: true,
    persistenceReloaded: true,
    persistenceFailureBlocked: true,
    tokenExposedInDomOrConsole: false
  });
} finally {
  if (client) {
    await Promise.race([client.send('Browser.close').catch(() => {}), wait(2_000)]);
    client.close();
  }
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolveExit => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(5_000)]);
  }
  server.closeAllConnections?.();
  await Promise.race([new Promise(resolveClose => server.close(resolveClose)), wait(2_000)]);
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
