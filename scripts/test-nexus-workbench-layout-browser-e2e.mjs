#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'oneapp-workbench-layout-'));
const sixAppPaths = ['Master.html','customer-master/index.html','SmartParser.html','MerchOps.html','smartinput/index.html','DataOps.html'];
sixAppPaths.forEach((path) => {
  const html = readFileSync(join(root, path), 'utf8');
  assert.match(html, /nexus-workbench-layout-v2\.css/, `${path} must consume the six-app layout stylesheet`);
  assert.match(html, /nexus-workbench-layout-v2\.js/, `${path} must consume the six-app layout controller`);
});
assert.doesNotMatch(readFileSync(join(root, 'orderops/list.html'), 'utf8'), /nexus-workbench-layout-v2/, 'OrderOps must remain outside the six-app layout module');
assert.doesNotMatch(readFileSync(join(root, 'DataOps.html'), 'utf8'), /min-w-\[1000px\]/, 'DataOps must not restore the clipped forced-width wrapper');
assert.doesNotMatch(readFileSync(join(root, 'nexus/common/nexus-workbench-layout-v2.js'), 'utf8'), /['"]orderops['"]\s*:/, 'the common layout allowlist must exclude OrderOps');
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
const waitFor = async (check, label, timeout = 45_000) => {
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
  once(method, timeout=45_000) {
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
const click = (client, selector) => evaluate(client, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw new Error('Missing ${selector}'); node.click(); return true; })()`);

let browser;
let client;
const runtimeExceptions = [];
try {
  assert.ok(browserPath, 'Chrome/Edge is required for NEXUS workbench browser E2E');
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
  await client.send('Emulation.setDeviceMetricsOverride', { width:1600, height:900, deviceScaleFactor:1, mobile:false });
  const origin = `http://127.0.0.1:${address.port}`;

  const navigate = async (path, appId, { desktop = true } = {}) => {
    const loaded = client.once('Page.loadEventFired');
    await client.send('Page.navigate', { url:`${origin}/${path}` });
    await loaded;
    await waitFor(() => evaluate(client, `Boolean(document.querySelector('[data-nexus-workspace="${appId}"][data-nexus-resizable-workspace="true"]')) && document.documentElement.dataset.nexusUiReady==='true'`), `${appId} enhanced workbench`);
    const state = await evaluate(client, `(() => {
      const workspace=document.querySelector('[data-nexus-workspace="${appId}"]');
      const panes=[...workspace.querySelectorAll(':scope > [data-nexus-pane]')];
      return {
        panes:panes.map((node)=>node.dataset.nexusPane),
        widths:panes.map((node)=>node.getBoundingClientRect().width),
        header:document.querySelector('[data-nexus-app-header="${appId}"]')?.getBoundingClientRect().height || 0,
        styleHref:document.querySelector('#nexusWorkbenchStyles')?.href || '',
        layoutStyleHref:[...document.styleSheets].map((sheet)=>sheet.href||'').find((href)=>href.includes('nexus-workbench-layout-v2.css')) || '',
        selectionReference:Boolean(workspace.querySelector('[data-nexus-selection-reference]')),
        handles:[...document.querySelectorAll('.nexus-pane-resizer-v2')].filter((node)=>!node.hidden).map((node)=>node.dataset.nexusPaneResize),
        tabs:[...document.querySelectorAll('[data-nexus-ui-app-target]')].map((node)=>node.textContent.trim())
      };
    })()`);
    assert.deepEqual(state.panes, ['reference','work','result'], `${appId} must expose the three pane roles`);
    assert.ok(state.widths.every((width) => width > 0), `${appId} desktop panes must be visible: ${state.widths.join(',')}`);
    assert.ok(state.header >= 50, `${appId} app header must remain compact and visible`);
    assert.match(state.styleHref, /nexus-workbench\.css/);
    assert.match(state.layoutStyleHref, /nexus-workbench-layout-v2\.css/);
    assert.equal(state.selectionReference, true, `${appId} must expose selected-row reference content`);
    assert.deepEqual(state.handles, desktop ? ['left','right'] : [], `${appId} separator visibility must match the viewport mode`);
    assert.deepEqual(state.tabs, ['상품관리','거래처관리','스마트파서','MerchOps','스마트입력','출고관리','DataOps']);
    const themeBefore = await evaluate(client, `document.documentElement.dataset.nexusUiTheme`);
    await click(client, '[data-nexus-ui-theme-toggle]');
    const themeAfter = themeBefore === 'dark' ? 'light' : 'dark';
    await waitFor(() => evaluate(client, `document.documentElement.dataset.nexusUiTheme===${JSON.stringify(themeAfter)}`), `${appId} ${themeAfter} theme`);
    assert.equal(await evaluate(client, `[...document.querySelectorAll('[data-nexus-workspace="${appId}"] > [data-nexus-pane]')].every((pane)=>pane.getBoundingClientRect().height>0)`), true, `${appId} panes must remain visible after theme change`);
    await click(client, '[data-nexus-ui-theme-toggle]');
    await waitFor(() => evaluate(client, `document.documentElement.dataset.nexusUiTheme===${JSON.stringify(themeBefore)}`), `${appId} theme restoration`);
    return state;
  };

  await navigate('Master.html', 'master-lookup');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-completion-bar="master-lookup"]'))`));
  const resizeState = await evaluate(client, `(() => {
    const workspace=document.querySelector('[data-nexus-workspace="master-lookup"]');
    const work=workspace.querySelector(':scope > [data-nexus-pane="work"]');
    const probe=document.createElement('div');
    probe.innerHTML='<input id="nexusResizeStateProbe" value="필터 유지"><div style="width:20px;height:20px;overflow:auto"><div style="width:100px;height:100px"></div></div><table><thead><tr><th>코드</th><th>상품명</th></tr></thead><tbody><tr><td>P-001</td><td>선택 참고 상품</td></tr></tbody></table>';
    work.prepend(probe);
    const input=probe.querySelector('input');
    const scroll=probe.querySelector('div');
    scroll.scrollTop=19; scroll.scrollLeft=17; input.focus(); probe.querySelector('tbody tr').click();
    const widths=()=>({left:workspace.querySelector(':scope > [data-nexus-pane="reference"]').getBoundingClientRect().width,right:workspace.querySelector(':scope > [data-nexus-pane="result"]').getBoundingClientRect().width});
    const before=widths();
    document.querySelector('[data-nexus-pane-resize="left"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    const afterLeft=widths();
    document.querySelector('[data-nexus-pane-resize="right"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    const afterRight=widths();
    const result={before,afterLeft,afterRight,value:input.value,focused:document.activeElement===input,scrollTop:scroll.scrollTop,scrollLeft:scroll.scrollLeft,reference:workspace.querySelector('[data-nexus-selection-reference]').textContent};
    probe.remove();
    return result;
  })()`);
  assert.ok(resizeState.afterLeft.left > resizeState.before.left, 'left separator keyboard resize must enlarge only the left pane');
  assert.ok(Math.abs(resizeState.afterLeft.right - resizeState.before.right) < 1, 'left resize must preserve right pane width');
  assert.ok(resizeState.afterRight.right > resizeState.afterLeft.right, 'right separator keyboard resize must enlarge the right pane independently');
  assert.equal(resizeState.value, '필터 유지');
  assert.equal(resizeState.focused, true);
  assert.equal(resizeState.scrollTop, 19);
  assert.equal(resizeState.scrollLeft, 17);
  assert.match(resizeState.reference, /P-001/);
  assert.match(resizeState.reference, /선택 참고 상품/);
  const pointerResize = await evaluate(client, `(() => { const pane=document.querySelector('[data-nexus-workspace="master-lookup"] > [data-nexus-pane="reference"]'); const handle=document.querySelector('[data-nexus-pane-resize="left"]'); const rect=handle.getBoundingClientRect(); return {before:pane.getBoundingClientRect().width,x:rect.left+rect.width/2,y:rect.top+Math.min(rect.height/2,120)}; })()`);
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', x:pointerResize.x, y:pointerResize.y, button:'left', buttons:1, clickCount:1 });
  await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:pointerResize.x + 24, y:pointerResize.y, button:'left', buttons:1 });
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:pointerResize.x + 24, y:pointerResize.y, button:'left', buttons:0, clickCount:1 });
  await waitFor(() => evaluate(client, `document.querySelector('[data-nexus-workspace="master-lookup"] > [data-nexus-pane="reference"]').getBoundingClientRect().width>${pointerResize.before + 10}`), 'Master pointer resize');
  assert.ok(await evaluate(client, `JSON.parse(localStorage.getItem('nexus:workbench-layout:master-lookup:v2')).left>${pointerResize.before}`), 'pointer resize must persist only the app layout width');
  await click(client, '[data-nexus-pane="result"] button[aria-label="선택 상품 결과 닫기"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-result-reopen="master-lookup"]'))`));
  await click(client, '[data-nexus-result-reopen="master-lookup"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-pane="result"]'))`));

  await navigate('MerchOps.html', 'merchops');
  await click(client, '[data-nexus-pane="result"] button[aria-label="MerchOps 결과 닫기"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-result-reopen="merchops"]'))`));
  await click(client, '[data-nexus-result-reopen="merchops"]');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-pane="result"]'))`));

  await navigate('smartinput/index.html', 'smart-input');
  assert.ok(await evaluate(client, `Boolean(document.querySelector('[data-nexus-completion-bar="smart-input"]'))`));
  const smartInputPanelBefore = await evaluate(client, `(() => { const workspace=document.querySelector('[data-nexus-workspace="smart-input"]'); return {work:workspace.querySelector(':scope > [data-nexus-pane="work"]').getBoundingClientRect().width,right:workspace.querySelector(':scope > [data-nexus-pane="result"]').getBoundingClientRect().width,saved:JSON.parse(localStorage.getItem('nexus:workbench-layout:smart-input:v2')||'null')?.right||300}; })()`);
  await click(client, '#relatedPanelCloseButton');
  await waitFor(() => evaluate(client, `document.querySelector('[data-nexus-workspace="smart-input"]').dataset.nexusRightOpen==='false'`), 'SmartInput common result collapse');
  const smartInputPanelClosed = await evaluate(client, `(() => { const workspace=document.querySelector('[data-nexus-workspace="smart-input"]'); return {work:workspace.querySelector(':scope > [data-nexus-pane="work"]').getBoundingClientRect().width,right:workspace.querySelector(':scope > [data-nexus-pane="result"]').getBoundingClientRect().width}; })()`);
  assert.ok(smartInputPanelClosed.work > smartInputPanelBefore.work && smartInputPanelClosed.right === 0, 'closing SmartInput result must return its space to the center');
  await click(client, '#relatedPanelToggle');
  await waitFor(() => evaluate(client, `document.querySelector('[data-nexus-workspace="smart-input"]').dataset.nexusRightOpen==='true'`), 'SmartInput common result reopen');
  assert.ok(Math.abs(await evaluate(client, `document.querySelector('[data-nexus-workspace="smart-input"] > [data-nexus-pane="result"]').getBoundingClientRect().width`) - smartInputPanelBefore.right) < 1, 'reopening SmartInput result must restore its saved width');
  await navigate('customer-master/index.html', 'customer-master');
  await navigate('SmartParser.html', 'smart-parser');
  assert.ok(await evaluate(client, `document.querySelector('[data-nexus-completion-bar="smart-parser"]')?.getBoundingClientRect().bottom <= innerHeight`), 'SmartParser F7/F8 completion bar must remain in the viewport');
  await navigate('DataOps.html', 'dataops');
  assert.equal(await evaluate(client, `document.querySelector('[data-nexus-workspace="dataops"] > [data-nexus-pane="work"] > div:nth-child(2)')?.scrollWidth <= document.querySelector('[data-nexus-workspace="dataops"] > [data-nexus-pane="work"]')?.scrollWidth`), true, 'DataOps central flow must not retain the former forced 1000px hidden width');

  await client.send('Emulation.setDeviceMetricsOverride', { width:900, height:1100, deviceScaleFactor:1, mobile:false });
  await navigate('customer-master/index.html', 'customer-master', { desktop:false });
  const compact = await evaluate(client, `(() => { const workspace=document.querySelector('[data-nexus-workspace="customer-master"]'); const panes=[...workspace.querySelectorAll(':scope > [data-nexus-pane]')]; return {visible:panes.map((pane)=>pane.getBoundingClientRect().height>0),tops:panes.map((pane)=>pane.getBoundingClientRect().top),handles:[...document.querySelectorAll('.nexus-pane-resizer-v2')].some((node)=>!node.hidden)}; })()`);
  assert.deepEqual(compact.visible, [true,true,true], 'small screens must retain access to left, center, and right panes');
  assert.ok(compact.tops[0] <= compact.tops[1] && compact.tops[1] <= compact.tops[2], 'small-screen pane order must be reference, work, result');
  assert.equal(compact.handles, false, 'desktop drag separators must be hidden in the stacked small-screen layout');
  let loaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url:`${origin}/history_viewer.html?returnApp=dataops` });
  await loaded;
  await waitFor(() => evaluate(client, `document.querySelector('#btnBackLabel')?.textContent==='DataOps'`), 'History Viewer DataOps return label');
  loaded = client.once('Page.loadEventFired');
  await click(client, '#btnBack');
  await loaded;
  assert.equal(await evaluate(client, `location.pathname.endsWith('/DataOps.html')`), true, 'History Viewer must return to its validated calling app');
  assert.deepEqual(runtimeExceptions, [], `workbench pages must not throw runtime exceptions: ${runtimeExceptions.join('; ')}`);
  console.log('PASS NEXUS six-app workbench browser E2E: seven tabs, three-pane roles, independent persisted keyboard resize, state preservation, close/reopen, small-screen access, SmartParser completion bar, DataOps width repair, no runtime exceptions.');
} finally {
  client?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (browser && !browser.killed) {
    const exited = new Promise((resolveExit) => browser.once('exit', resolveExit));
    browser.kill();
    await Promise.race([exited, wait(1500)]);
  }
  try { rmSync(profile, { recursive:true, force:true, maxRetries:5, retryDelay:100 }); } catch (error) {}
}
