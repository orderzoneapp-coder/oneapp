#!/usr/bin/env node
// Real host and app sources; all browser storage belongs to a new temporary profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes('--help')) {
  console.log('node scripts/measure-smartinput-host-navigation.mjs [--base-url https://oneapp.orderz.co.kr/] [--samples 20] [--label local-host] [--trace]');
  console.log('Without --base-url, serve this checkout on loopback. Remote mode uses GET-only static resources and a fresh synthetic local browser profile. --trace records one extra roundtrip; common-layer 150 ms remains UNMEASURED until trace attribution is reviewed.');
  process.exit(0);
}
const samples = Number(option('--samples', '20'));
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 100, '--samples must be 1..100');
const label = option('--label', option('--base-url') ? 'production-host' : 'local-host');
assert.match(label, /^[a-zA-Z0-9_-]+$/, '--label must be a safe filename component');
const outputDir = join(root, 'evidence/si-boundary-20260920-01');
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, `${label}-navigation.json`);
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Number(value.toFixed(3));
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, samples: values.map(round), p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted.at(-1)) };
};
const report = {
  schema: 'SMARTINPUT_REAL_HOST_NAVIGATION_V1', taskId: 'SI-BOUNDARY-20260920-01', label,
  recordedAt: new Date().toISOString(), samplePairs: samples,
  environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model },
  fixture: '20 synthetic direct-input order rows in a newly created browser profile. Real workspace.html, workspace.js, SmartInput and customer-master are used without source replacement. No authentication session, personal profile, production database, external command or owner transmission is used.',
  methodology: {
    warmup: 'One unrecorded real roundtrip, with the last synthetic quantity edited immediately before leaving SmartInput to verify beforeLeave persistence.',
    appUsable: 'From captured trusted click timestamp to the first painted state with the correct host route, connected/ready child adapter, hidden host loading/error, expected SmartInput row name and quantity plus enabled input/analyze controls; customer-master requires its ready bridge, completed initialization, ready status, visible header and enabled search.',
    clickFeedback: 'From captured click timestamp to a requestAnimationFrame in which the pending/active target is visible, followed by a second animation frame. A conservative paint-opportunity upper bound, not screenshot-confirmed compositor presentation.',
    statistics: 'Nearest-rank p95. Each recorded pair contains SmartInput -> customer-master -> SmartInput. No artificial source mutations, cache disabling or all-request Fetch interception are used.',
    commonLayer: 'nexusUiReadyMs is diagnostic wall time, not common-layer blocking. Optional trace is separate from KPI sampling and requires attribution review; it cannot produce a 150 ms PASS automatically.'
  },
  commonLayerWarmBlocking: { status: 'UNMEASURED', limitMs: 150, reason: 'No validated attribution of common-only synchronous intervals and gate waits. APP_READY, UI-ready wall time and total navigation are not substitutes.' },
  relativeRegression: { status: 'UNMEASURED', reason: 'No before-change sample set exists for this exact real-host fixture. Absolute KPI results do not establish the architecture relative-regression condition. Unchanged host/common source is not evidence of a 150 ms time budget.' },
  transitions: [], checks: [], exceptions: [], forbiddenNetworkRequests: [], externalRequestsAttempted: [], blockedTransports: [], status: 'RUNNING'
};
const persist = () => writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(check, name, timeout = 25000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await wait(35);
  }
  throw new Error(`${name} timed out${lastError ? `: ${lastError.message}` : ''}`);
}
class Cdp {
  constructor(url) { this.url = url; this.nextId = 0; this.pending = new Map(); this.listeners = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = event => {
      const result = JSON.parse(event.data);
      if (result.id) {
        const pending = this.pending.get(result.id); if (!pending) return;
        this.pending.delete(result.id);
        return result.error ? pending.reject(new Error(result.error.message)) : pending.resolve(result.result);
      }
      for (const listener of this.listeners.get(result.method) || []) listener(result.params);
    };
    await new Promise((resolveOpen, reject) => { this.socket.onopen = resolveOpen; this.socket.onerror = reject; });
  }
  send(method, params = {}) {
    return new Promise((resolveSend, reject) => { const id = ++this.nextId; this.pending.set(id, { resolve: resolveSend, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

let server, browser, client, profile, baseUrl;
let traceActive = false;
const traceEvents = [];
try {
  if (option('--base-url')) {
    baseUrl = new URL(option('--base-url'));
    assert.ok(baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(baseUrl.hostname)), 'remote base URL must use HTTPS');
    assert.ok(!baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash, 'base URL must not contain credentials, query or hash');
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  } else {
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
    server = createServer((request, response) => {
      if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405).end();
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = resolve(root, `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`);
      if (!file.startsWith(`${root}${sep}`)) return response.writeHead(403).end();
      if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end();
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      response.end(request.method === 'HEAD' ? undefined : readFileSync(file));
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    baseUrl = new URL(`http://127.0.0.1:${server.address().port}/`);
  }
  report.baseUrl = baseUrl.href;
  report.assets = [];
  const entryAsset = (entry, scriptName) => {
    const html = readFileSync(join(root, entry), 'utf8');
    const source = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1]).find(value => value.split('?')[0].endsWith(scriptName));
    assert.ok(source, `${entry} must declare ${scriptName}`);
    return new URL(source, new URL(entry, baseUrl)).href.slice(baseUrl.href.length);
  };
  for (const path of ['smartinput/index.html', entryAsset('smartinput/index.html', 'smartinput.js'), 'nexus/workspace.html', entryAsset('nexus/workspace.html', 'workspace.js'), entryAsset('nexus/workspace.html', 'nexus-ui.js')]) {
    const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, `${path} must be available`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sourcePath = path.split('?')[0];
    const localSha256 = hash(readFileSync(join(root, sourcePath)));
    let expectedBytes;
    if (option('--base-url')) {
      const blob = spawnSync('git', ['show', `HEAD:${sourcePath}`], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(blob.status, 0, `Git blob HEAD:${sourcePath} must be readable`);
      expectedBytes = blob.stdout;
    } else expectedBytes = readFileSync(join(root, sourcePath));
    const expectedSha256 = hash(expectedBytes);
    const servedSha256 = hash(bytes);
    report.assets.push({ path, servedSha256, localSha256, expectedSha256, expectedSource: option('--base-url') ? 'git blob HEAD' : 'working file', matchesExpected: servedSha256 === expectedSha256, matchesCheckout: servedSha256 === localSha256, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') });
  }
  report.assetIdentityStatus = report.assets.every(asset => asset.matchesExpected) ? 'PASS' : 'FAIL';
  assert.equal(report.assetIdentityStatus, 'PASS', 'served entry and principal app/host assets must match the expected source bytes before behavior is attributed to them');
  const browserCandidates = [process.env.CHROME_PATH, process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'), process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
  for (const name of ['google-chrome', 'chromium', 'msedge']) {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) browserCandidates.push(...result.stdout.trim().split(/\r?\n/));
  }
  const executable = browserCandidates.find(existsSync);
  assert.ok(executable, 'Chrome or Edge is required');
  profile = mkdtempSync(join(tmpdir(), 'si-real-host-'));
  browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--no-proxy-server', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${baseUrl.hostname}, EXCLUDE 127.0.0.1`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const debugPort = await until(() => { try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; } catch { return ''; } }, 'browser debug port');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'), 'browser page');
  client = new Cdp(target.webSocketDebuggerUrl); await client.connect();
  await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Network.enable');
  await client.send('Runtime.addBinding', { name: '__siReportBlockedTransport' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  client.on('Runtime.exceptionThrown', event => report.exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  client.on('Page.javascriptDialogOpening', () => { void client.send('Page.handleJavaScriptDialog', { accept: false }); });
  client.on('Network.requestWillBeSent', event => {
    if (!['GET', 'HEAD'].includes(event.request.method)) report.forbiddenNetworkRequests.push({ method: event.request.method, url: event.request.url.split('?')[0] });
    if (/^https?:/.test(event.request.url) && new URL(event.request.url).origin !== baseUrl.origin) report.externalRequestsAttempted.push({ method: event.request.method, url: event.request.url.split('?')[0], type: event.type });
  });
  client.on('Runtime.bindingCalled', event => { if (event.name === '__siReportBlockedTransport') report.blockedTransports.push(JSON.parse(event.payload)); });
  // Safety instrumentation is installed in every new document, including app iframes.
  // It blocks application transports before dispatch; static GET requests remain normal.
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if(location.origin!==${JSON.stringify(baseUrl.origin)})return;
    window.__siHostIsolation={blocked:[]};
    const allowed=(url,method)=>new URL(url,location.href).origin===location.origin&&['GET','HEAD'].includes(String(method||'GET').toUpperCase());
    const blocked=(url,method)=>{const entry={url:new URL(url,location.href).origin+new URL(url,location.href).pathname,method:String(method||'GET')};window.__siHostIsolation.blocked.push(entry);window.__siReportBlockedTransport?.(JSON.stringify(entry));};
    const nativeFetch=window.fetch;window.fetch=function(resource,options){const url=typeof resource==='string'||resource instanceof URL?String(resource):resource.url;const method=options?.method||resource?.method||'GET';if(!allowed(url,method)){blocked(url,method);return Promise.reject(new Error('ISOLATED_HOST_TRANSPORT_BLOCKED'));}return nativeFetch.apply(this,arguments);};
    const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(method,url){this.__siReadOnly={method,url};return open.apply(this,arguments);};
    XMLHttpRequest.prototype.send=function(){const r=this.__siReadOnly;if(r&&!allowed(r.url,r.method)){blocked(r.url,r.method);throw new Error('ISOLATED_HOST_TRANSPORT_BLOCKED');}return send.apply(this,arguments);};
    navigator.sendBeacon=(url)=>{blocked(url,'BEACON');return false;};
    window.WebSocket=function(url){blocked(url,'WEBSOCKET');throw new Error('ISOLATED_HOST_TRANSPORT_BLOCKED');};
    window.EventSource=function(url){blocked(url,'EVENTSOURCE');throw new Error('ISOLATED_HOST_TRANSPORT_BLOCKED');};
    window.addEventListener('submit',event=>event.preventDefault(),true);
    if(window.parent!==window||!/\\/nexus\\/workspace\\.html$/.test(location.pathname))return;
    window.__siHostRuns=[];window.__siHostMessages=[];
    window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==document.querySelector('#nexusWorkspaceFrame')?.contentWindow)return;const data=event.data;if(data?.schemaVersion!=='nexus-workspace-message/v1')return;window.__siHostMessages.push({type:data.type,appId:data.appId,transitionId:data.transitionId,at:performance.now()});});
    window.addEventListener('click',event=>{
      const link=event.target.closest?.('[data-nexus-ui-app-target]');if(!link||event.button!==0)return;
      const run={target:link.dataset.nexusUiAppTarget,startedAt:event.timeStamp,feedbackMs:null,usableMs:null,localDataMs:null,messagesFrom:window.__siHostMessages.length};window.__siHostRuns.push(run);
      function frame(){
        const child=document.querySelector('#nexusWorkspaceFrame')?.contentWindow;
        const route=new URL(location.href).searchParams.get('app');
        const visual=link.classList.contains('is-pending')||link.getAttribute('aria-current')==='page';
        if(visual&&run.feedbackMs===null&&!run.feedbackPending){run.feedbackPending=true;requestAnimationFrame(()=>{run.feedbackMs=performance.now()-run.startedAt;});}
        try {
          const doc=child?.document,bridge=child?.ONEAPP_NEXUS_WORKSPACE_CHILD;
          const connected=route===run.target&&bridge?.connected&&bridge?.adapterRegistered&&doc.documentElement.dataset.nexusWorkspaceReady==='true'&&document.querySelector('#nexusWorkspaceLoading').hidden&&document.querySelector('#nexusWorkspaceError').hidden;
          const rows=[...(doc?.querySelectorAll('#inputRows tr[data-row-id]')||[])].filter(row=>row.dataset.rowId?.startsWith('SI-HOST-ROW-'));
          const first=rows.find(row=>row.dataset.rowId==='SI-HOST-ROW-0');
          const quantity=first?.querySelector('[data-field="quantity"]'),name=first?.querySelector('[data-field="itemName"]');
          const local=run.target==='smart-input'&&rows.length===20&&name?.value==='HOST FIXTURE 0'&&quantity?.value==='7';
          if(local&&run.localDataMs===null)run.localDataMs=performance.now()-run.startedAt;
          const usable=connected&&(run.target==='smart-input'?(local&&!quantity.disabled&&!doc.querySelector('#analyzeButton')?.disabled):Boolean(doc.documentElement.dataset.customerMasterReady==='true'&&doc.querySelector('#appStatus')?.dataset.state==='ready'&&doc.querySelector('[data-nexus-app-header="customer-master"]')&&!doc.querySelector('#customerSearch')?.disabled));
          if(usable&&run.usableMs===null&&!run.usablePending){run.usablePending=true;requestAnimationFrame(()=>{run.usableMs=performance.now()-run.startedAt;run.headerCount=document.querySelectorAll('.nexus-ui-header').length;run.childHeaderCount=doc.querySelectorAll('.nexus-ui-header').length;run.frameCount=document.querySelectorAll('#nexusWorkspaceFrame').length;run.childIsolation=child.__siHostIsolation;run.uiReadyWallMs=Number(doc.documentElement.dataset.nexusUiReadyMs||0);});}
        }catch{}
        if(run.usableMs===null||run.feedbackMs===null)requestAnimationFrame(frame);
      }requestAnimationFrame(frame);
    },true);
  })();` });

  await client.send('Page.navigate', { url: new URL('smartinput/index.html', baseUrl).href });
  await until(() => client.eval('Boolean(window.__ONEAPP_SMARTINPUT_EARLY_UI__?.ready&&window.SMART_INPUT_CONTRACT)'), 'standalone fixture initialization');
  report.checks.push({ name: 'standalone direct entry', status: 'PASS' });
  for (const mode of ['purchase', 'sale', 'estimate', 'order']) {
    await client.eval(`document.querySelector('.mode-tab[data-mode="${mode}"]').click();true`);
    await until(() => client.eval(`document.querySelector('.mode-tab[data-mode="${mode}"]').getAttribute('aria-selected')==='true'&&Boolean(document.querySelector('#sourceTextInput'))`), `standalone ${mode} tab`);
  }
  report.checks.push({ name: 'standalone four voucher tabs', status: 'PASS', modes: ['order', 'purchase', 'sale', 'estimate'] });
  const fixture = await client.eval(`(() => {const c=window.SMART_INPUT_CONTRACT,d=c.createDraft();d.activeMode='order';d.updatedAt=new Date().toISOString();const current=d.modes.order;current.updatedAt=d.updatedAt;current.activeMethod='direct';current.sourceText='';current.rows=Array.from({length:20},(_,index)=>c.normalizeRow({rowId:'SI-HOST-ROW-'+index,itemName:'HOST FIXTURE '+index,itemCode:'SYNTHETIC-'+index,quantity:2,unit:'EA',unitPrice:10,inputOwnership:'USER'}));return {key:c.DRAFT_STORAGE_KEY,value:JSON.stringify(d)};})()`);
  // Leave the running app before seeding its compatibility key. A same-origin
  // static text resource has no app handlers that could overwrite the fixture.
  const seedUrl = new URL('smartinput/smartinput-contract.js', baseUrl).href;
  await client.send('Page.navigate', { url: seedUrl });
  await until(() => client.eval(`location.href===${JSON.stringify(seedUrl)}&&document.readyState==='complete'&&!window.SMART_INPUT_CONTRACT`), 'inert same-origin seed document');
  await client.eval(`localStorage.setItem(${JSON.stringify(fixture.key)},${JSON.stringify(fixture.value)});true`);
  await client.send('Page.navigate', { url: new URL('smartinput/index.html', baseUrl).href });
  await until(() => client.eval(`document.querySelector('[data-row-id="SI-HOST-ROW-0"] [data-field="quantity"]')?.value==='2'`), 'standalone synthetic rows');
  report.fixtureSeed = 'One synthetic compatibility draft installed from an inert same-origin static-text document after the prior app unloads. Subsequent edits and recovery use actual app handlers; no synthetic draft is written into a running app.';
  await client.eval(`(()=>{const input=document.querySelector('[data-row-id="SI-HOST-ROW-0"] [data-field="quantity"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'3');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await until(() => client.eval(`JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')||'{}').modes?.order?.rows?.[0]?.quantity===3`), 'standalone actual autosave');
  await client.send('Page.reload', {});
  await until(() => client.eval(`document.querySelector('[data-row-id="SI-HOST-ROW-0"] [data-field="quantity"]')?.value==='3'`), 'standalone reload recovery');
  report.checks.push({ name: 'standalone input, automatic local save and reload recovery', status: 'PASS', row: 'SI-HOST-ROW-0', restoredQuantity: 3 });
  const hostUrl = new URL('nexus/workspace.html?app=smart-input&route=smartinput%2Findex.html', baseUrl).href;
  await client.send('Page.navigate', { url: hostUrl });
  await until(() => client.eval(`(()=>{const child=document.querySelector('#nexusWorkspaceFrame')?.contentWindow;return document.querySelector('#nexusWorkspaceLoading')?.hidden&&child?.document.querySelector('[data-row-id="SI-HOST-ROW-0"] [data-field="quantity"]')?.value==='3';})()`), 'real host synthetic work');
  report.checks.push({ name: 'real NEXUS host entry with recovered work', status: 'PASS' });
  for (const mode of ['purchase', 'sale', 'estimate', 'order']) {
    await client.eval(`document.querySelector('#nexusWorkspaceFrame').contentDocument.querySelector('.mode-tab[data-mode="${mode}"]').click();true`);
    await until(() => client.eval(`document.querySelector('#nexusWorkspaceFrame').contentDocument.querySelector('.mode-tab[data-mode="${mode}"]').getAttribute('aria-selected')==='true'`), `embedded ${mode} tab`);
  }
  report.checks.push({ name: 'embedded four voucher tabs', status: 'PASS', modes: ['order', 'purchase', 'sale', 'estimate'] });
  report.environment.userAgent = await client.eval('navigator.userAgent');
  await client.eval(`document.querySelector('.nexus-ui-header').dataset.siHostPersistent='true';true`);
  const clickTarget = async appId => {
    const previous = await client.eval('window.__siHostRuns.length');
    const point = await client.eval(`(()=>{const link=document.querySelector('[data-nexus-ui-app-target="${appId}"]');link.scrollIntoView({block:'nearest',inline:'nearest'});const r=link.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    const result = await until(() => client.eval(`(()=>{const r=window.__siHostRuns[${previous}];return r?.usableMs!==null&&r?.feedbackMs!==null?r:null;})()`), `${appId} usable`);
    assert.equal(result.target, appId);
    assert.deepEqual([result.headerCount, result.childHeaderCount, result.frameCount], [1, 0, 1]);
    assert.equal(await client.eval(`document.querySelector('.nexus-ui-header').dataset.siHostPersistent`), 'true', 'host header must retain identity');
    return result;
  };
  // Real DOM input just before a real host click exercises the application's save gate.
  await client.eval(`(()=>{const child=document.querySelector('#nexusWorkspaceFrame').contentWindow;const input=child.document.querySelector('[data-row-id="SI-HOST-ROW-0"] [data-field="quantity"]');input.focus();Object.getOwnPropertyDescriptor(child.HTMLInputElement.prototype,'value').set.call(input,'7');input.dispatchEvent(new child.Event('input',{bubbles:true}));return true;})()`);
  await clickTarget('customer-master'); await clickTarget('smart-input');
  report.beforeLeaveSyntheticEditRestored = true;
  for (let sample = 0; sample < samples; sample++) {
    report.transitions.push({ sample: sample + 1, direction: 'smart-input-to-customer-master', ...await clickTarget('customer-master') });
    report.transitions.push({ sample: sample + 1, direction: 'customer-master-to-smart-input', ...await clickTarget('smart-input') });
    console.log(`${label}: completed warm pair ${sample + 1}/${samples}`);
  }
  const intoSmartInput = report.transitions.filter(row => row.target === 'smart-input');
  const intoCustomerMaster = report.transitions.filter(row => row.target === 'customer-master');
  report.metrics = {
    smartInputUsable: { ...summarize(intoSmartInput.map(row => row.usableMs)), limitMs: 1000 },
    customerMasterUsable: { ...summarize(intoCustomerMaster.map(row => row.usableMs)), limitMs: 1000 },
    clickVisualFeedback: { ...summarize(report.transitions.map(row => row.feedbackMs)), limitMs: 100 },
    smartInputDataFromHostClick: { ...summarize(intoSmartInput.map(row => row.localDataMs)), note: 'Includes leaving the prior app; not the separate direct-entry local-data KPI.' }
  };
  for (const metric of [report.metrics.smartInputUsable, report.metrics.customerMasterUsable, report.metrics.clickVisualFeedback]) metric.status = samples >= 20 ? (metric.p95Ms <= metric.limitMs ? 'PASS' : 'FAIL') : 'INSUFFICIENT_SAMPLES';
  if (args.includes('--trace')) {
    let tracingFinished;
    const finished = new Promise(resolveTrace => { tracingFinished = resolveTrace; });
    client.on('Tracing.dataCollected', event => traceEvents.push(...event.value));
    client.on('Tracing.tracingComplete', () => tracingFinished());
    await client.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', options: 'record-as-much-as-possible' }); traceActive = true;
    await clickTarget('customer-master'); await clickTarget('smart-input');
    await client.send('Tracing.end'); traceActive = false;
    await Promise.race([finished, wait(10000).then(() => { throw new Error('trace collection timed out'); })]);
    const traceFile = join(outputDir, `${label}-common-diagnostic-trace.json`);
    writeFileSync(traceFile, JSON.stringify({ traceEvents }));
    report.commonLayerWarmBlocking.traceFile = traceFile;
    report.commonLayerWarmBlocking.traceNote = 'One additional actual-app roundtrip, excluded from sampled metrics. Attribute non-overlapping common script intervals and explicit common gate waits; app-owned save waits and other-app work must remain separate. No automatic common KPI verdict.';
  }
  assert.equal(report.forbiddenNetworkRequests.length, 0, 'no non-GET/HEAD browser request may reach the network');
  assert.equal(report.exceptions.length, 0, `runtime exceptions: ${report.exceptions.join('; ')}`);
  report.isolation = { temporaryProfile: true, applicationTransportsBlockedBeforeDispatch: true, externalHostResolutionBlocked: true, blockedTransportCount: report.blockedTransports.length, nonGetHeadRequestCount: report.forbiddenNetworkRequests.length, externalRequestAttemptCount: report.externalRequestsAttempted.length, productionDataUsed: false, productionWrites: false, personalProfileUsed: false };
  report.functionalStatus = 'PASS';
  report.status = Object.values(report.metrics).some(metric => metric.status === 'FAIL') ? 'KPI_FAIL' : samples < 20 ? 'SMOKE_ONLY' : 'MEASURED';
  console.log(JSON.stringify({ report: outputPath, status: report.status, smartInputUsableP95: report.metrics.smartInputUsable.p95Ms, feedbackP95: report.metrics.clickVisualFeedback.p95Ms, commonLayer: 'UNMEASURED' }));
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack;
  if (client) try { report.failureDiagnostic = await client.eval(`(()=>{const f=document.querySelector('#nexusWorkspaceFrame'),d=JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')||'null');return {url:location.href,childUrl:f?.contentWindow?.location.href,runs:window.__siHostRuns?.slice(-2),messages:window.__siHostMessages?.slice(-10),hostError:document.querySelector('#nexusWorkspaceErrorMessage')?.textContent,childStatus:f?.contentDocument?.querySelector('#appStatus')?.textContent,syntheticStoredRowCount:d?.modes?.order?.rows?.length,syntheticStoredFirstId:d?.modes?.order?.rows?.[0]?.rowId,renderedRowCount:document.querySelectorAll('#inputRows tr[data-row-id]').length};})()`); } catch {}
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (traceActive && client) try { await client.send('Tracing.end'); } catch {}
  persist();
  if (browser && browser.exitCode === null) {
    // Graceful Browser.close also releases profile handles held by utility processes.
    const exited = new Promise(resolveExit => browser.once('exit', resolveExit));
    if (client?.socket?.readyState === WebSocket.OPEN) await Promise.race([client.send('Browser.close').catch(() => {}), wait(1000)]);
    await Promise.race([exited, wait(1500)]);
    if (browser.exitCode === null) browser.kill();
  }
  client?.socket?.close(); server?.close();
  if (profile) {
    const target = resolve(profile), temp = resolve(tmpdir());
    if (target.startsWith(`${temp}${sep}`) && target === profile && target.split(sep).at(-1).startsWith('si-real-host-')) {
      try { rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { report.profileCleanup = 'Temporary profile removal deferred because the browser still held a file'; persist(); }
    }
  }
}
