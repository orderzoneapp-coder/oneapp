#!/usr/bin/env node
// Isolated, reproducible fixture benchmark. Never reads a normal browser profile.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildEstimateF8Data } from '../smartinput/report.js';
import { buildPurchaseSalesUploadData } from '../smartinput/report.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2] || 'baseline';
const functionDiagnostic = process.env.SI_BENCH_FUNCTION_DIAGNOSTIC === '1';
const diagnostic = process.env.SI_BENCH_DIAGNOSTIC === '1' || functionDiagnostic;
const startupMarks = process.env.SI_BENCH_STARTUP_MARKS === '1';
const browserOnly = process.env.SI_BENCH_BROWSER_ONLY === '1';
const evidenceDir = resolve(root, 'evidence/si-boundary-20260920-01');
mkdirSync(evidenceDir, { recursive: true });
const samples = Number(process.env.SI_BENCH_SAMPLES || (diagnostic ? 3 : 20));
const round = n => Number(n.toFixed(3));
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map(round), count: sorted.length, p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted.at(-1)) };
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidence = {
  schema: 'SMARTINPUT_BOUNDARY_BENCHMARK_V1', label, recordedAt: new Date().toISOString(),
  head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
  mainSourceSha256: createHash('sha256').update(readFileSync(join(root, 'smartinput/smartinput.js'))).digest('hex'),
  environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  fixture: 'Synthetic fixture derived from test-smartinput-stage5-compute.mjs; not user or production data',
  statistics: 'Nearest-rank p95; 3 unrecorded warmups for pure matrices; warm navigation follows seeded local save',
  diagnosticOnly: diagnostic,
  browserOnly,
  pureComputeReference: browserOnly ? { file: 'after-intermediate-performance.json', rerun: false, note: 'Pure output calculations were not rerun in this browser-only pass. Refer to the earlier six matrix cases and preserved baseline-equal output hashes; their implementation has not changed since that run.' } : undefined,
  startupMarksNote: startupMarks ? 'Two performance marks inserted at serve time before main module body and after its initial renderMode call; production files unchanged. Normal fixture, cache, and sampling protocol retained.' : undefined,
  pureCompute: [], browser: {},
  unmeasured: ['Real user workload', 'NEXUS host app-to-app navigation', 'Common-layer blocking time', 'Actual XLSX file serialization/download', 'Click visual feedback p95'],
};
const persist = () => writeFileSync(join(evidenceDir, `${label}-performance.json`), `${JSON.stringify(evidence, null, 2)}\n`);
if (process.env.SI_BENCH_SKIP_PURE === '1' && !diagnostic) evidence.pureCompute = JSON.parse(readFileSync(join(evidenceDir, `${label}-performance.json`), 'utf8')).pureCompute;
for (const count of diagnostic || browserOnly || process.env.SI_BENCH_SKIP_PURE === '1' ? [] : [20, 600, 3000]) {
  const rows = Array.from({ length: count }, (_, index) => ({
    rowId: `R${index}`, itemCode: `ITEM-${index}`, itemName: `상품 ${index}`, specification: 'EA', unit: 'EA', quantity: 1,
    inboundPrice: 1000 + index, outPrice: 1500 + index, wholesaleA: 1400 + index, wholesaleB: 1450 + index,
    marketPrice: 1600 + index, rowCustomerName: `거래처 ${index % 20}`,
  }));
  const purchaseRows = rows.map(row => ({ 품목코드: row.itemCode, 품명: row.itemName, 수량: 1, 단가: row.inboundPrice }));
  for (const [name, fn] of [['estimateMatrix', () => buildEstimateF8Data(rows)], ['purchaseSalesMatrix', () => buildPurchaseSalesUploadData(purchaseRows)]]) {
    for (let run = 0; run < 3; run++) fn();
    const timings = []; let result;
    for (let run = 0; run < samples; run++) { const started = performance.now(); result = fn(); timings.push(performance.now() - started); }
    evidence.pureCompute.push({ name, rows: count, ...summary(timings), outputSha256: digest(result), path: 'Node main-thread pure computation (not Worker or browser KPI)' });
  }
}
persist();
console.log(`${label}: ${browserOnly || diagnostic ? 'browser measurement initialized' : 'pure-compute evidence saved'}`);
const profile = mkdtempSync(join(tmpdir(), 'si-boundary-benchmark-'));
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const target = normalize(resolve(root, `${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`));
  if (target !== root && !target.startsWith(`${root}${sep}`)) return response.writeHead(403).end();
  if (!existsSync(target) || !statSync(target).isFile()) return response.writeHead(404).end('<!doctype html><title>fixture</title>');
  response.writeHead(200, { 'Content-Type': contentTypes[extname(target)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
  if ((diagnostic || startupMarks) && target === join(root, 'smartinput', 'smartinput.js')) {
    let instrumented = readFileSync(target, 'utf8');
    if (functionDiagnostic) {
      const names = [...instrumented.matchAll(/^(?:async )?function (\w+)\(/gm)].map(match => match[1]);
      const wrappers = `const __siFunctionProfile={enabled:true,stack:[],totals:{},initial:null,wrappedCount:${names.length}};window.__siFunctionProfile=__siFunctionProfile;
function __siWrapFunction(name,original){return function(...args){const p=__siFunctionProfile;if(!p.enabled)return original.apply(this,args);const frame={started:performance.now(),children:0};p.stack.push(frame);try{return original.apply(this,args);}finally{const elapsed=performance.now()-frame.started;p.stack.pop();if(p.stack.length)p.stack[p.stack.length-1].children+=elapsed;const total=p.totals[name]||(p.totals[name]={name,count:0,inclusiveMs:0,selfMs:0,maxMs:0});total.count++;total.inclusiveMs+=elapsed;total.selfMs+=Math.max(0,elapsed-frame.children);total.maxMs=Math.max(total.maxMs,elapsed);if(name==='renderMode'&&!p.initial){p.initial={endedAtMs:performance.now(),totals:structuredClone(p.totals)};p.enabled=false;}}};}
${names.map(name => `${name}=__siWrapFunction(${JSON.stringify(name)},${name});`).join('\n')}
`;
      instrumented = instrumented.replace('const contract = window.SMART_INPUT_CONTRACT;', `${wrappers}\nconst contract = window.SMART_INPUT_CONTRACT;`);
    }
    instrumented = diagnostic
      ? instrumented.replaceAll('renderMode();', 'renderMode(); performance.mark("si-renderMode-return");')
      : instrumented.replace(/(\r?\n)renderMode\(\);(\r?\n)if \(earlyUi\)/, '$1renderMode(); performance.mark("si-renderMode-return");$2if (earlyUi)');
    response.end(`performance.mark('si-main-start');\n${instrumented}${diagnostic ? "\nperformance.mark('si-main-end');" : ''}`);
  } else response.end(readFileSync(target));
});
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(check, labelText, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(30); }
  throw new Error(`Timeout: ${labelText}`);
}
class Cdp {
  constructor(url) { this.url = url; this.pending = new Map(); this.listeners = new Map(); this.id = 0; }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = event => {
      const item = JSON.parse(event.data);
      if (item.id) { const request = this.pending.get(item.id); this.pending.delete(item.id); return item.error ? request.reject(new Error(item.error.message)) : request.resolve(item.result); }
      for (const listener of this.listeners.get(item.method) || []) listener(item.params);
    };
    await new Promise((resolveOpen, reject) => { this.socket.onopen = resolveOpen; this.socket.onerror = reject; });
  }
  send(method, params = {}) { return new Promise((resolveSend, reject) => { const id = ++this.id; this.pending.set(id, { resolve: resolveSend, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  on(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}
let browser; let client;
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executable = [process.env.CHROME_PATH, process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean).find(existsSync);
  assert.ok(executable, 'Chrome or Edge required');
  browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const debugPort = await until(() => { try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; } catch { return ''; } }, 'debug port');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  client = new Cdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable')]);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  // Deny all external network requests: even read-only operations cannot reach a production system.
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const externalRequests = [];
  client.on('Fetch.requestPaused', event => {
    const external = !event.request.url.startsWith(origin) && /^https?:/.test(event.request.url);
    if (external) externalRequests.push({ url: event.request.url, method: event.request.method });
    void client.send(external ? 'Fetch.failRequest' : 'Fetch.continueRequest', external ? { requestId: event.requestId, errorReason: 'BlockedByClient' } : { requestId: event.requestId });
  });
  const exceptions = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  client.on('Page.javascriptDialogOpening', () => { void client.send('Page.handleJavaScriptDialog', { accept: true }); });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__siBenchmark={storage:{},getItem:0,readyMs:null,localDataMs:null};
    const b=window.__siBenchmark;
    if(${diagnostic}) { b.longTasks=[];new PerformanceObserver(list=>b.longTasks.push(...list.getEntries().map(entry=>({startTime:entry.startTime,duration:entry.duration})))).observe({type:'longtask',buffered:true});
      const originalFetch=window.fetch;window.fetch=function(resource,options){const url=String(typeof resource==='string'?resource:resource?.url||resource);if(new URL(url,location.href).origin!==location.origin)return Promise.reject(new Error('DIAGNOSTIC_EXTERNAL_NETWORK_BLOCKED'));return originalFetch.apply(this,arguments);};
    }
    const getItem=Storage.prototype.getItem; Storage.prototype.getItem=function(...args){b.getItem++;return getItem.apply(this,args);};
    for(const method of ['get','getAll','openCursor']) {const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){const key=this.transaction.db.name+'/'+this.name+'/'+method;b.storage[key]=(b.storage[key]||0)+1;return original.apply(this,args);};}
    function check(){const row=document.querySelector('#inputRows [data-field="itemName"]');const ready=document.querySelector('.nexus-ui-header')&&document.querySelector('#inputRows tr')&&!document.querySelector('#analyzeButton')?.disabled;if(ready&&b.readyMs===null)b.readyMs=performance.now();if(row?.value?.startsWith('측정')&&b.localDataMs===null)b.localDataMs=performance.now();if(b.localDataMs===null||b.readyMs===null)requestAnimationFrame(check);}
    requestAnimationFrame(check);
  })();` });
  await client.send('Page.navigate', { url: `${origin}/fixture.html` });
  await until(() => client.eval('document.readyState==="complete"'), 'fixture ready');
  const products = Array.from({ length: 600 }, (_, index) => ({ productId: `P-BENCH-${index}`, itemCode: `BENCH-${index}`, itemName: `측정${String.fromCharCode(0xac00 + index)}`, specification: 'EA', finalUnit: 'EA', outPrice: 1000 + index, status: 'ACTIVE' }));
  await client.eval(`localStorage.setItem('merchMaster_v870',JSON.stringify(${JSON.stringify(products)}));true`);
  await client.send('Page.navigate', { url: `${origin}/smartinput/` });
  await until(() => client.eval('window.__siBenchmark?.readyMs'), 'initial app ready');
  await wait(600);
  evidence.browser.initial = await client.eval(`({marks:window.__siBenchmark,resources:performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,initiatorType:r.initiatorType,transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,decodedBodySize:r.decodedBodySize,durationMs:r.duration})),userAgent:navigator.userAgent})`);
  evidence.browser.initial.moduleResourceCount = evidence.browser.initial.resources.filter(resource => resource.path.endsWith('.js')).length;
  evidence.browser.initial.totalEncodedResourceBytes = evidence.browser.initial.resources.reduce((sum, resource) => sum + resource.encodedBodySize, 0);
  const analyze = async quantity => {
    const source = ['성능측정 거래처', ...products.slice(0, 20).map(product => `${product.itemName} ${quantity}개`)].join('\n');
    return client.eval(`new Promise((resolve,reject)=>{const text=${JSON.stringify(source)};const input=document.querySelector('#sourceTextInput');const b=window.__siBenchmark;const before={...b.storage};const start=performance.now();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#analyzeButton').click();const timeout=setTimeout(()=>reject(new Error('analysis timeout: '+document.querySelector('#toast')?.textContent)),20000);function check(){const first=document.querySelector('#inputRows tr:not([data-default-row="true"]) [data-field="quantity"]');if(first?.value===${JSON.stringify(String(quantity))}&&!document.querySelector('#analyzeButton').disabled){clearTimeout(timeout);const storage={};for(const[key,value]of Object.entries(b.storage))if(value!==(before[key]||0))storage[key]=value-(before[key]||0);resolve({durationMs:performance.now()-start,storage,renderedRows:document.querySelectorAll('#inputRows tr:not([data-default-row="true"])').length});}else requestAnimationFrame(check);}requestAnimationFrame(check);})`);
  };
  evidence.browser.firstTextAnalysis = await analyze(2);
  await until(() => client.eval(`JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')||'{}').modes?.order?.rows?.length===20`), '20-row local autosave');
  await wait(300);
  const warmReady = []; const warmData = []; const warmReads = []; const warmResources = []; const warmStartupMarks = []; const diagnosticWithFetch = [];
  const readDiagnostic = () => client.eval(`({marks:structuredClone(window.__siBenchmark),functionProfile:window.__siFunctionProfile?structuredClone(window.__siFunctionProfile.initial):null,wrappedFunctionCount:window.__siFunctionProfile?.wrappedCount,timing:performance.getEntriesByType('navigation')[0]?.toJSON(),mainMarks:performance.getEntriesByType('mark').filter(mark=>mark.name.startsWith('si-')).map(mark=>({name:mark.name,startTime:mark.startTime})),resources:performance.getEntriesByType('resource').map(resource=>({path:new URL(resource.name).pathname,startTime:resource.startTime,responseEnd:resource.responseEnd,duration:resource.duration,transferSize:resource.transferSize}))})`);
  for (let run = 0; run < samples; run++) {
    await client.send('Page.navigate', { url: `${origin}/smartinput/?siBenchmark=${run}` });
    await until(() => client.eval('window.__siBenchmark?.localDataMs&&window.__siBenchmark?.readyMs'), 'warm local data');
    const result = await client.eval(`({...structuredClone(window.__siBenchmark),startupMarks:performance.getEntriesByType('mark').filter(mark=>mark.name.startsWith('si-')).map(mark=>({name:mark.name,startTime:mark.startTime})),resources:performance.getEntriesByType('resource').map(resource=>({path:new URL(resource.name).pathname,transferSize:resource.transferSize,encodedBodySize:resource.encodedBodySize}))})`);
    warmData.push(result.localDataMs); warmReady.push(result.readyMs); warmReads.push(result.storage);
    if (startupMarks) warmStartupMarks.push(result.startupMarks);
    warmResources.push({ count: result.resources.length, transferBytes: result.resources.reduce((sum, resource) => sum + resource.transferSize, 0), zeroTransferResources: result.resources.filter(resource => resource.transferSize === 0).length, jsCount: result.resources.filter(resource => resource.path.endsWith('.js')).length, jsTransferBytes: result.resources.filter(resource => resource.path.endsWith('.js')).reduce((sum, resource) => sum + resource.transferSize, 0) });
    if (diagnostic) { await wait(250); diagnosticWithFetch.push(await readDiagnostic()); }
  }
  evidence.browser.warmDirectEntry = { localDataDisplay: summary(warmData), shellUsable: summary(warmReady), localDataLimitMs: 500, appUsableReferenceLimitMs: 1000, localDataPass: summary(warmData).p95Ms <= 500, directEntryPass: summary(warmReady).p95Ms <= 1000, storageReadsByRun: warmReads, resourcesByRun: warmResources, cacheControl: 'public, max-age=3600 (unchanged since baseline)', note: 'Direct entry of warmed static assets and saved 20-row local draft. Does not verify NEXUS host switching.' };
  if (startupMarks) evidence.browser.warmDirectEntry.startupMarksByRun = warmStartupMarks;
  if (diagnostic) {
    evidence.browser.diagnostic = { note: 'Serve-time performance marks and long-task observer only; no production files altered. Same profile and dataset, three cache-warm navigations with Fetch interception followed by three without it. This diagnoses instrumentation and does not replace the 20-sample before/after comparison.', withFetch: diagnosticWithFetch, withoutFetch: [] };
    if (functionDiagnostic) evidence.browser.diagnostic.note = 'Three cached navigations with Fetch interception. Serve-time wrappers measure only synchronous execution of top-level function declarations until the first renderMode return, with inclusive and child-subtracted self time. Promise wait time, imported functions, and module-level expressions are not independently attributed; wrapper overhead is included. No production files altered. This diagnoses initialization and does not replace the 20-sample comparison.';
    if (!functionDiagnostic) {
    const httpHosts = [...new Set(externalRequests.filter(request => request.url.startsWith('http://')).map(request => `${new URL(request.url).origin}/*`))];
    await client.send('Network.setBlockedURLs', { urls: ['https://*', ...httpHosts] });
    await client.send('Fetch.disable');
    client.on('Network.requestWillBeSent', event => { if (/^https?:/.test(event.request.url) && !event.request.url.startsWith(origin)) externalRequests.push({ url: event.request.url, method: event.request.method, phase: 'diagnostic-without-fetch' }); });
    for (let run = 0; run < samples; run++) {
      await client.send('Page.navigate', { url: `${origin}/smartinput/?siDiagnosticNoFetch=${run}` });
      await until(() => client.eval('window.__siBenchmark?.localDataMs&&window.__siBenchmark?.readyMs'), 'warm local data without interception');
      await wait(250); evidence.browser.diagnostic.withoutFetch.push(await readDiagnostic());
    }
    }
  }
  const analysisRuns = [];
  for (let run = 0; run < (diagnostic ? 0 : samples); run++) { analysisRuns.push(await analyze(run + 3)); await wait(250); }
  if (!diagnostic) evidence.browser.warmTextAnalysis = { rows: 20, catalogProducts: 600, ...summary(analysisRuns.map(result => result.durationMs)), storageReadsByRun: analysisRuns.map(result => result.storage), renderedRowsByRun: analysisRuns.map(result => result.renderedRows) };
  evidence.browser.externalRequestsBlocked = externalRequests;
  evidence.browser.runtimeExceptions = exceptions;
  evidence.browser.isolation = { temporaryProfile: true, productionNetworkRequestsSent: 0, externalNetworkBlocked: true, localFixtureOnly: true };
  evidence.browser.status = 'completed';
  assert.deepEqual(exceptions, []);
  persist();
  console.log(JSON.stringify({ label, pure: evidence.pureCompute.map(({ name, rows, p95Ms }) => ({ name, rows, p95Ms })), warmLocalP95: evidence.browser.warmDirectEntry.localDataDisplay.p95Ms, warmReadyP95: evidence.browser.warmDirectEntry.shellUsable.p95Ms, warmAnalysisP95: evidence.browser.warmTextAnalysis?.p95Ms, file: join(evidenceDir, `${label}-performance.json`) }));
} catch (error) {
  try { evidence.browser.failureDiagnostic = await client?.eval(`({url:location.href,marks:window.__siBenchmark,fields:[...document.querySelectorAll('#inputRows tr:not([data-default-row="true"])')].slice(0,3).map(row=>({item:row.querySelector('[data-field="itemName"]')?.value,quantity:row.querySelector('[data-field="quantity"]')?.value})),saved:JSON.parse(localStorage.getItem('oneapp.smartinput.draft.v1')||'{}').modes?.order?.rows?.slice(0,2),status:document.querySelector('#appStatus')?.textContent})`); } catch {}
  evidence.browser.status = 'failed'; evidence.browser.error = error.stack; persist(); throw error;
} finally {
  client?.socket?.close(); browser?.kill(); server.close();
  // Only the mkdtemp-created isolated profile is removed.
  const resolvedProfile = resolve(profile);
  if (resolvedProfile.startsWith(`${resolve(tmpdir())}${sep}`) && resolvedProfile.includes('si-boundary-benchmark-')) {
    try { rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
}
