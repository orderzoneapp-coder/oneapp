#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-smartinput-linked-source-dialog-e2e-'));
const screenshotDir = resolve(process.env.SMARTINPUT_LINKED_SOURCE_SCREENSHOT_DIR || join(tmpdir(), 'oneapp-smartinput-linked-source-dialog-screenshots'));
mkdirSync(screenshotDir, { recursive: true });
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
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
  once(method, timeout = 60_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = params => { clearTimeout(timer); this.events.set(method, (this.events.get(method) || []).filter(item => item !== listener)); resolveEvent(params); };
      const timer = setTimeout(() => rejectEvent(new Error(`Timed out waiting for ${method}`)), timeout);
      this.events.set(method, [...(this.events.get(method) || []), listener]);
    });
  }
  on(method, listener) { this.events.set(method, [...(this.events.get(method) || []), listener]); }
  close() { this.socket?.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const expr = (client, expression, label, timeout) => waitFor(() => evaluate(client, expression), label, timeout);
const click = (client, selector) => evaluate(client, `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('missing ${selector}');element.click();return true;})()`);
const escape = async client => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
};
const sourceQuantities = client => evaluate(client, `new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readonly');const get=tx.objectStore('estimates').getAll();get.onerror=()=>reject(get.error);get.onsuccess=()=>{resolve(Object.fromEntries(get.result.filter(record=>record.estimateKind!=='LINKED_GROUP').map(record=>[record.estimateId,record.draft.rows[0].quantity])));db.close();};};})`);

let browser;
let client;
try {
  const address = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
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
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
  const exceptions = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' ')); });

  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/smartinput/` });
  await loaded;
  await expr(client, `Boolean(document.querySelector('#inputRows tr'))`, 'SmartInput shell');
  await evaluate(client, String.raw`(async()=>{
    const contract=window.SMART_INPUT_CONTRACT;
    const makeRow=(rowId,quantity,unitPrice)=>contract.normalizeRow({
      rowId,itemCode:'SRC-001',itemName:'원본 선택 상품',specification:'10kg',quantity,rawQuantity:quantity,unit:'BOX',unitPrice,sourceUnitPrice:String(unitPrice),
      inputOwnership:'SOURCE',editedFields:{},sourceType:'XLSX',sourceBatchId:'BATCH-SOURCE',sourceDocumentKey:'SOURCE-DOC',sourceRowKey:rowId,sourceFingerprint:'SIG-'+rowId,
      fieldValues:{'voucher.estimate.line.quantity':{fieldId:'voucher.estimate.line.quantity',sourceDisplayValue:String(quantity),currentDisplayValue:String(quantity),parsedValue:quantity,edited:false,evidence:{signature:'SIG-'+rowId,sourceMatrixCell:'A1'}}}
    });
    const base=contract.createDraft().modes.estimate;
    const sourceDraft=(row)=>contract.normalizeModeDraft('estimate',{...base,rows:[row],activeMethod:'direct'});
    const sourceA={estimateId:'EST-DIALOG-A',catalogName:'원본 견적 A',estimateKind:'INDIVIDUAL',rowCount:1,amount:1000,sortOrder:1,createdAt:'2026-09-03T09:00:00+09:00',updatedAt:'2026-09-03T09:00:00+09:00',draft:sourceDraft(makeRow('ROW-DIALOG-A',1,1000))};
    const sourceB={estimateId:'EST-DIALOG-B',catalogName:'원본 견적 B',estimateKind:'INDIVIDUAL',rowCount:1,amount:3600,sortOrder:2,createdAt:'2026-09-03T09:00:00+09:00',updatedAt:'2026-09-03T09:00:00+09:00',draft:sourceDraft(makeRow('ROW-DIALOG-B',3,1200))};
    const linkedRow=contract.normalizeRow({...makeRow('ROW-DIALOG-LINKED',9,1500),inputOwnership:'SOURCE',editedFields:{quantity:true,unitPrice:true},linkedSourceEstimateId:sourceA.estimateId,linkedSourceEstimateName:'2개 견적서',linkedSourceRowId:'ROW-DIALOG-A',linkedSourceEstimateIds:[sourceA.estimateId,sourceB.estimateId],linkedSourceRefs:[{estimateId:sourceA.estimateId,estimateName:sourceA.catalogName,rowId:'ROW-DIALOG-A'},{estimateId:sourceB.estimateId,estimateName:sourceB.catalogName,rowId:'ROW-DIALOG-B'}]});
    const linkedSources=[{estimateId:sourceA.estimateId,catalogName:sourceA.catalogName,updatedAt:sourceA.updatedAt},{estimateId:sourceB.estimateId,catalogName:sourceB.catalogName,updatedAt:sourceB.updatedAt}];
    const linkedDraft=contract.normalizeModeDraft('estimate',{...base,catalogRecordId:'EST-DIALOG-LINKED',estimateKind:'LINKED_GROUP',linkedEstimateSources:linkedSources,rows:[linkedRow],activeMethod:'direct'});
    const linked={estimateId:'EST-DIALOG-LINKED',catalogName:'연동 원본 선택 검증',estimateKind:'LINKED_GROUP',linkedEstimateSources:linkedSources,rowCount:1,amount:13500,sortOrder:3,createdAt:'2026-09-03T09:00:00+09:00',updatedAt:'2026-09-03T09:00:00+09:00',draft:linkedDraft};
    await new Promise((resolve,reject)=>{const request=indexedDB.open('oneapp-smartinput',5);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('estimates','readwrite');tx.onerror=()=>reject(tx.error);tx.oncomplete=()=>{db.close();resolve()};const store=tx.objectStore('estimates');store.put(sourceA);store.put(sourceB);store.put(linked);};});
    const appDraft=contract.createDraft({activeMode:'estimate'});appDraft.activeMode='estimate';appDraft.modes.estimate=linkedDraft;
    localStorage.setItem(contract.DRAFT_STORAGE_KEY,JSON.stringify(appDraft));
    return true;
  })()`);
  loaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expr(client, `document.querySelector('#inputRows [data-field="quantity"]')?.value==='9'`, 'linked working row');
  assert.deepEqual(await sourceQuantities(client), { 'EST-DIALOG-A': 1, 'EST-DIALOG-B': 3 });

  const matrix = [];
  const viewports = [{ width: 1920, height: 1080, mobile: false }, { width: 1440, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }];
  let representativeScreenshot = '';
  for (const viewport of viewports) {
    await client.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1 });
    await click(client, '#completeButton');
    await expr(client, `Boolean(document.querySelector('.linked-source-edit-dialog[open]'))`, `${viewport.width}px dialog open`);
    assert.equal(await evaluate(client, `document.activeElement?.matches('.linked-source-edit-dialog [data-source-choice]')`), true, `${viewport.width}px dialog must focus its first source choice`);
    assert.equal(await evaluate(client, `document.querySelectorAll('.linked-source-edit-dialog [data-source-choice]:checked').length`), 0, `${viewport.width}px merged row must have no hidden selection`);
    assert.equal(await evaluate(client, `document.querySelector('.linked-source-edit-dialog [data-confirm-source]').disabled`), true, `${viewport.width}px unselected confirmation must be disabled`);
    for (const theme of ['light', 'dark']) {
      await evaluate(client, `document.documentElement.dataset.nexusTheme=${JSON.stringify(theme)};true`);
      await wait(80);
      const geometry = await evaluate(client, `(() => {const dialog=document.querySelector('.linked-source-edit-dialog');const body=dialog.querySelector('.linked-source-edit-body');const footer=dialog.querySelector('footer');const rect=dialog.getBoundingClientRect();const footerRect=footer.getBoundingClientRect();return {theme:document.documentElement.dataset.nexusTheme,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,documentScrollWidth:document.documentElement.scrollWidth,bodyOverflow:getComputedStyle(body).overflowY,bodyScrollHeight:body.scrollHeight,bodyClientHeight:body.clientHeight,footerBottom:footerRect.bottom,text:dialog.textContent};})()`);
      assert.equal(geometry.theme, theme);
      assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight, `${viewport.width}px ${theme} dialog must fit the viewport`);
      assert.ok(geometry.documentScrollWidth <= geometry.viewportWidth, `${viewport.width}px ${theme} must not create horizontal document overflow`);
      assert.equal(geometry.bodyOverflow, 'auto');
      assert.ok(geometry.footerBottom <= geometry.bottom + 1, `${viewport.width}px ${theme} footer must remain reachable`);
      assert.match(geometry.text, /원본 견적 A/);
      assert.match(geometry.text, /EST-DIALOG-A/);
      assert.match(geometry.text, /ROW-DIALOG-A/);
      assert.match(geometry.text, /수량/);
      assert.match(geometry.text, /단가/);
      assert.match(geometry.text, /금액/);
      matrix.push({ viewport: viewport.width, theme, geometry: { width: geometry.width, height: geometry.height, bodyScrollHeight: geometry.bodyScrollHeight, bodyClientHeight: geometry.bodyClientHeight } });
      if (viewport.width === 1440 && theme === 'light') {
        const capture = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
        representativeScreenshot = join(screenshotDir, 'smartinput-linked-source-dialog-1440-light.png');
        writeFileSync(representativeScreenshot, Buffer.from(capture.data, 'base64'));
      }
    }
    await escape(client);
    await expr(client, `!document.querySelector('.linked-source-edit-dialog')&&!document.querySelector('#completeButton').disabled`, `${viewport.width}px dialog cancel`);
    assert.equal(await evaluate(client, `document.querySelector('#inputRows [data-field="quantity"]').value`), '9', `${viewport.width}px cancel must retain the working edit`);
    assert.deepEqual(await sourceQuantities(client), { 'EST-DIALOG-A': 1, 'EST-DIALOG-B': 3 }, `${viewport.width}px cancel must preserve both sources`);
  }

  assert.deepEqual(exceptions, [], `runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ matrix, representativeScreenshot, profileCleanupTarget: profile }, null, 2));
  console.log('SmartInput linked-estimate source dialog focused browser E2E PASS');
} finally {
  client?.close();
  if (browser && !browser.killed) browser.kill();
  server.close();
  await wait(150);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
}
