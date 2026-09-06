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
  const send = () => {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': mime[extname(target)] || 'application/octet-stream' });
    response.end(readFileSync(target));
  };
  if (pathname === '/smartinput/smartinput-contract.js') return setTimeout(send, 1_800);
  send();
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
  const point = await waitFor(() => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;element.scrollIntoView({block:'center',inline:'center'});const rect=element.getBoundingClientRect();const x=Math.round(rect.left+rect.width/2);const y=Math.round(rect.top+rect.height/2);const controlId=element.id;const hitId=document.elementFromPoint(x,y)?.closest('button')?.id||'';return hitId===controlId?{x,y,controlId,hitId}:null;})()`), `${selector} stable touch target`, 1_200);
  assert.equal(point.hitId, point.controlId, `${selector} center must hit the expected control`);
  await client.send('Page.bringToFront');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    const timestamp = Date.now() / 1000;
    await client.send('Input.emulateTouchFromMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, timestamp });
    await wait(50);
    await client.send('Input.emulateTouchFromMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, timestamp: timestamp + 0.05 });
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
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{if(location.hostname==='127.0.0.1')localStorage.setItem('oneapp.smartinput.draft.v1',JSON.stringify({schemaVersion:'ONEAPP_SMART_INPUT_DRAFT_V1',activeMode:'estimate',modes:{},ui:{relatedPanelLayoutVersion:1,relatedOpen:true}}));}catch(_){}`
  });
  const navigationStartedAt = Date.now();
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  const earlyControls = await waitFor(() => evaluate(client, `(() => {const shell=window.__ONEAPP_SMARTINPUT_EARLY_UI__;const heading=document.querySelector('#estimateLibraryHeading');const panel=document.querySelector('#estimateLibraryView');const individual=document.querySelector('#estimateLibraryIndividualButton');const linked=document.querySelector('#estimateLibraryLinkedButton');if(!shell?.mounted||shell.ready||!heading||!panel||!individual||!linked)return null;return {headingVisible:!heading.hidden&&heading.getBoundingClientRect().height>0,panelOpen:panel.classList.contains('is-open'),individualEnabled:!individual.disabled,linkedEnabled:!linked.disabled,loadingText:document.querySelector('#catalogPickerList')?.textContent?.trim()||''};})()`), 'early estimate-list controls', 1_500);
  const earlyRevealMs = Date.now() - navigationStartedAt;
  assert.equal(await evaluate(client, `window.__ONEAPP_SMARTINPUT_EARLY_UI__?.ready===false`), true,
    'estimate-list controls must appear before the delayed main module');
  assert.deepEqual(earlyControls, {
    headingVisible: true,
    panelOpen: true,
    individualEnabled: true,
    linkedEnabled: true,
    loadingText: '견적서 목록을 불러오는 중입니다.'
  }, 'local UI state must reveal the estimate-list shell before the main module');
  await touch(client, '#estimateLibraryLinkedButton');
  const earlyLinked = await waitFor(() => evaluate(client, `(() => {const shell=window.__ONEAPP_SMARTINPUT_EARLY_UI__;const linked=document.querySelector('#estimateLibraryLinkedButton');const list=document.querySelector('#linkedEstimateList');return shell&&!shell.ready&&linked?.getAttribute('aria-pressed')==='true'&&!list?.hidden?{kind:shell.estimateLibraryKind,loadingText:list.textContent.trim()}:null;})()`), 'early linked-estimate selection', 1_200);
  assert.deepEqual(earlyLinked, { kind: 'linked', loadingText: '연동견적서를 불러오는 중입니다.' }, 'linked-estimate selection must respond while data modules load');
  await waitFor(() => evaluate(client, `window.__ONEAPP_SMARTINPUT_EARLY_UI__?.ready===true&&Boolean(document.querySelector('.nexus-ui-header'))&&Boolean(document.querySelector('#inputRows tr'))`), 'SmartInput shell');
  assert.equal(await evaluate(client, `document.querySelector('#estimateLibraryLinkedButton').getAttribute('aria-pressed')==='true'&&!document.querySelector('#linkedEstimateList').hidden`), true,
    'early linked-estimate selection must survive main-module initialization');

  await click(client, '[data-mode="estimate"]');
  await waitFor(() => evaluate(client, `!document.querySelector('#estimateLibraryHeading').hidden`), 'estimate library');
  if (!await evaluate(client, `document.querySelector('#estimateLibraryView').classList.contains('is-open')`)) {
    await click(client, '#relatedPanelToggle');
  }
  await waitFor(() => evaluate(client, `document.querySelector('#estimateLibraryView').classList.contains('is-open')`), 'mobile estimate drawer');
  await waitFor(() => evaluate(client, `!document.querySelector('#estimateMultiSelectButton').disabled`), 'estimate library data');
  await wait(500);
  await evaluate(client, `(() => {window.__touchInputEvidence=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{const control=event.target.closest?.('#estimateLibraryIndividualButton,#estimateLibraryLinkedButton,#estimateMultiSelectButton');if(control)window.__touchInputEvidence.push({type,controlId:control.id,pointerType:event.pointerType||''});},true);return true;})()`);

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
  const touchEvidence = await evaluate(client, `window.__touchInputEvidence`);
  assert.ok(touchEvidence.filter(event => event.type === 'pointerdown' && event.pointerType === 'touch').length >= 5, 'each control tap must use a touch pointer');
  assert.ok(touchEvidence.filter(event => event.type === 'pointerup' && event.pointerType === 'touch').length >= 5, 'each touch pointer must complete');
  assert.ok(touchEvidence.filter(event => event.type === 'click' && event.pointerType === 'touch').length >= 5, 'each touch sequence must synthesize its activation click');

  console.log('SmartInput right-panel touchscreen hotfix PASS', { earlyRevealMs, delayedContractMs: 1_800, controls, touchEvents: touchEvidence.length });
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
