#!/usr/bin/env node
// Verification branch only. Never writes business records or uploads to ERP/shop.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const origin = 'https://oneapp.orderz.co.kr';
assert.equal(readFileSync('CNAME', 'utf8').trim(), 'oneapp.orderz.co.kr');
const revision = process.env.DEPLOYED_SHA;
assert.match(revision || '', /^[a-f0-9]{40}$/);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 45000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await wait(150);
  }
  throw new Error(`Timeout: ${label}${last ? `: ${last.message}` : ''}`);
}

const assets = [
  ['smartinput/index.html', ''],
  ['smartinput/smartinput.js', '0.15.2'],
  ['smartinput/estimate-output.js', '0.2.10'],
  ['smartinput/stage5-compute-runner.js', '0.1.2'],
  ['smartinput/stage5-compute-worker.js', '0.1.2'],
  ['smartinput/estimate-migration.js', '0.1.3']
];
for (const [name, version] of assets) {
  const expected = readFileSync(name);
  await waitFor(async () => {
    const response = await fetch(`${origin}/${name}?v=${version}&verify=${revision}`, {
      headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000)
    });
    assert.equal(response.status, 200, name);
    const actual = Buffer.from(await response.arrayBuffer());
    return actual.equals(expected);
  }, `deployed bytes ${name}`, 180000);
  console.log('PASS deployed asset', name, createHash('sha256').update(expected).digest('hex'));
}

class CdpClient {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else (this.listeners.get(message.method) || []).forEach(fn => fn(message.params));
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 90000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { this.listeners.set(method, [...(this.listeners.get(method) || []), fn]); }
  close() { for (const pending of this.pending.values()) clearTimeout(pending.timer); this.socket?.close(); }
}
async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function checkActualReport() {
  const require = (condition, label) => { if (!condition) throw new Error(label); };
  const api = await import('/smartinput/estimate-output.js?v=0.2.10');
  const cases = [
    ['promotion-only',15800,'',15800,'1'],
    ['promotion-zero-out','15,800원',0,15800,'1'],
    ['out-only','',18000,18000,'1'],
    ['both-prices',15800,18000,15800,'1'],
    ['empty-prices','','','','0'],
    ['zero-prices',0,0,0,'0'],
    ['negative-promotion',-100,18000,18000,'1'],
    ['invalid-promotion','확인',18000,18000,'1'],
    ['invalid-out','','확인',0,'0'],
    ['negative-out','',-100,-100,'0'],
    ['missing-prices',undefined,undefined,'','0']
  ];
  const results = [];
  const headers = ['품목코드','품목명','출고가','행사가'];
  for (const [label,promoPrice,outPrice,price,sale] of cases) {
    const code = `VERIFY-${label}`;
    const cells = [code,label,outPrice ?? '',promoPrice ?? ''];
    const mapped = api.buildEstimateF8RowsFromDraft({
      rows: [{rowId:'R1',itemCode:'UNUSED-DIRECT',itemName:'UNUSED-DIRECT',outPrice:999999}],
      inputMapping: {
        headerRowIndex:0, headers, sourceMatrix:[headers,cells],
        mappings: headers.map((_,i)=>({state:'MAPPED',columnIndex:i,targetFieldId:`src_${i}`})),
        workingRows: [{rowId:'R1',sourceRowIndex:1,cells}]
      }
    });
    const direct = [{itemCode:code,itemName:label,promoPrice,outPrice}];
    for (const [mode,rows] of [['direct',direct],['mapped',mapped]]) {
      const before = JSON.stringify(rows);
      const output = api.buildEstimateF8Data(rows);
      require(output.ok, `${mode}/${label}: output rejected`);
      const shop = output.shopData[1];
      require(shop[0] === code && shop[3] === price && shop[14] === sale && shop[15] === 999, `${mode}/${label}: price, sale or stock mismatch`);
      const raw = Number(String(outPrice ?? '').replace(/[,원₩]/g,'').trim());
      const erpPrice = outPrice === '' || outPrice == null ? '' : (Number.isFinite(raw) ? raw : 0);
      require(output.erpData[1][3] === erpPrice, `${mode}/${label}: ERP changed`);
      require(JSON.stringify(rows) === before, `${mode}/${label}: source mutated`);
      results.push({mode,label,price:shop[3],sale:shop[14]});
    }
  }
  const bulkRows = Array.from({length:600},(_,i)=>({itemCode:`VERIFY-BULK-${i}`,itemName:'검증 전용',outPrice:'',promoPrice:15800}));
  const metrics = [];
  const workerOutput = await api.runStage5Compute({
    feature:'estimate-report',phase:'ESTIMATE_F8_BUILD',
    payload:{rows:bulkRows,options:{},duplicateResolutionEntries:[]},rowCount:bulkRows.length,
    direct:()=>api.buildEstimateF8Data(bulkRows),onMetric:m=>metrics.push(m)
  });
  require(metrics.at(-1)?.path === 'worker', 'Real production Worker did not execute (fallback is not accepted)');
  require(workerOutput.ok && workerOutput.shopData.length === 601, '600-row report failed');
  require(workerOutput.shopData.slice(1).every(r=>r[3]===15800 && r[14]==='1' && r[15]===999), 'Worker sale policy mismatch');
  require(workerOutput.erpData.slice(1).every(r=>r[3]===''), 'Worker modified ERP prices');
  require(JSON.stringify(workerOutput) === JSON.stringify(api.buildEstimateF8Data(bulkRows)), 'Worker/direct output mismatch');
  const smallMetrics = [];
  await api.runStage5Compute({feature:'estimate-report',phase:'ESTIMATE_F8_BUILD',payload:{rows:bulkRows.slice(0,4)},rowCount:4,direct:()=>api.buildEstimateF8Data(bulkRows.slice(0,4)),onMetric:m=>smallMetrics.push(m)});
  require(smallMetrics.at(-1)?.path === 'direct','Small report should use direct path');
  return {caseCount:results.length,results,bulkRows:600,workerPath:metrics.at(-1).path,smallPath:smallMetrics.at(-1).path,erpPreserved:true,stockPreserved:true,sourcePreserved:true,location:location.href};
}

const profile = mkdtempSync(join(tmpdir(),'oneapp-live-shop-sale-'));
let browser, client;
const runtimeErrors = [], failedResources = [], blockedWrites = [], loadedResources = [];
try {
  const which = command => {
    const result = spawnSync('which',[command],{encoding:'utf8'});
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const chrome = [process.env.CHROME_PATH,which('google-chrome'),which('chromium')].filter(Boolean).find(existsSync);
  assert.ok(chrome,'Chrome executable required');
  browser = spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  const port = await waitFor(()=>existsSync(join(profile,'DevToolsActivePort')) && readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0],'Chrome port');
  const target = await waitFor(async()=>{
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(t=>t.type==='page');
  },'Chrome page');
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  client.on('Runtime.exceptionThrown',event=>runtimeErrors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  client.on('Network.responseReceived',event=>{
    if (event.response.url.startsWith(origin)) loadedResources.push({url:event.response.url,status:event.response.status});
    if (event.response.status >= 400) failedResources.push({url:event.response.url,status:event.response.status});
  });
  client.on('Fetch.requestPaused',event=>{
    const writing = !['GET','HEAD','OPTIONS'].includes(event.request.method);
    if (writing) blockedWrites.push({method:event.request.method,url:event.request.url});
    client.send(writing ? 'Fetch.failRequest' : 'Fetch.continueRequest',writing ? {requestId:event.requestId,errorReason:'BlockedByClient'} : {requestId:event.requestId}).catch(()=>{});
  });
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled',{cacheDisabled:true});
  await client.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await client.send('Page.navigate',{url:`${origin}/smartinput/?verify=${revision}`});
  const page = await waitFor(()=>evaluate(client,`document.readyState === 'complete' && document.querySelector('.mode-tab[data-mode="estimate"]') && ({title:document.title,url:location.href})`),'live SmartInput page');
  assert.ok(page.url.startsWith(`${origin}/smartinput/`),'Unexpected navigation away from SmartInput');
  await waitFor(()=>evaluate(client,`performance.getEntriesByType('resource').some(e=>e.name.includes('/smartinput/smartinput.js?v=0.15.2'))`),'new SmartInput module loaded');
  await evaluate(client,`document.querySelector('.mode-tab[data-mode="estimate"]').click()`);
  await wait(1000);
  const report = await evaluate(client,`(${checkActualReport.toString()})()`);
  assert.equal(runtimeErrors.length,0,JSON.stringify(runtimeErrors));
  assert.equal(blockedWrites.length,0,`Unexpected HTTP writes were safely blocked: ${JSON.stringify(blockedWrites)}`);
  const appFailures = failedResources.filter(r=>r.url.startsWith(`${origin}/smartinput/`));
  assert.equal(appFailures.length,0,JSON.stringify(appFailures));
  console.log('PASS actual production Chromium UI and report calculation',JSON.stringify({revision,page,...report,runtimeErrors,blockedWrites,failedResources,loadedResources},null,2));
} finally {
  client?.close();
  if (browser) { browser.kill('SIGTERM'); await wait(500); if (browser.exitCode === null) browser.kill('SIGKILL'); }
  rmSync(profile,{recursive:true,force:true});
}
