#!/usr/bin/env node
// Real app/DOM, isolated profile and synthetic records; never connects to production.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineSha = '5315b63ef8b4ae443a7b01ee35687f3314fd57f0';
const baseline = execFileSync('git', ['show', `${baselineSha}:smartinput/smartinput.js`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const current = readFileSync(join(root, 'smartinput/smartinput.js'), 'utf8');
let variant = 'before';
const hook = `
window.__renderTest={
  prepare(n) {
    state.draft.activeMode='estimate';state.smartDataReady=true;state.smartDataError=null;
    state.estimates=Array.from({length:n},(_,i)=>({estimateId:'PERF-'+i,companyId:state.companyId,
      catalogName:'Synthetic '+i,schemaVersion:INDEPENDENT_ESTIMATE_SCHEMA,sortOrder:i+1,
      createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-02T00:00:00Z',dataRevision:1,
      draft:{header:{customerName:''},rows:[]}}));
    modeDraft().catalogRecordId='PERF-0'; estimateWorkspace.select(['PERF-0']);
    renderMode({persistCleanup:false,scheduleAnalysis:false});
  },
  mode:()=>renderMode({persistCleanup:false,scheduleAnalysis:false}),
  catalog:()=>renderCatalogControls(), delivery:()=>renderDelivery(),
  select(ids){estimateWorkspace.select(ids);modeDraft().stage3SelectedTable=true;renderCatalogControls();},
  mutate(kind){
    if(kind==='rename') state.estimates=state.estimates.map((r,i)=>i===0?{...r,catalogName:'Renamed',updatedAt:'2026-09-03T00:00:00Z'}:r);
    if(kind==='reorder') state.estimates=state.estimates.map((r,i)=>({...r,sortOrder:state.estimates.length-i}));
    if(kind==='body') state.estimates=state.estimates.map((r,i)=>i===0?{...r,dataRevision:2,draft:{header:{},rows:[{rowId:'body-only',quantity:0}]}}:r);
    if(kind==='remove') state.estimates=state.estimates.filter(r=>r.estimateId!=='PERF-0');
    if(kind==='error'){state.smartDataReady=false;state.smartDataError=new Error('synthetic');}
    if(kind==='ready'){state.smartDataReady=true;state.smartDataError=null;}
    if(kind==='company') state.estimates=[...state.estimates,{estimateId:'FOREIGN',companyId:'OTHER-COMPANY',catalogName:'Foreign'}];
    renderCatalogControls();
  },
  remember(){estimateWorkspace.remember('PERF-0',{header:{customerName:'unsaved'},rows:[{rowId:'local',quantity:0}]});},
  work:()=>estimateWorkspace.getWork('PERF-0'),
  pending(value){state.activeFileInputAttemptId=value;renderDelivery();},
  async hydrate(){await hydrateEstimateLibrary();},
  snapshot:()=>window.ONEAPP_SMARTINPUT_PERFORMANCE.snapshot()
};`;
function instrument(source) {
  return `window.__probe={mode:0,catalog:0,adopt:0,context:0};\n` + source
    .replace(/function renderMode\(\{ persistCleanup = true, scheduleAnalysis = true \} = \{\}\) \{/, '$&\nwindow.__probe.mode++;')
    .replace('list.innerHTML = records.length', 'window.__probe.catalog++; list.innerHTML = records.length')
    .replaceAll('estimateWorkspace.adopt(record);', '{ window.__probe.adopt++; estimateWorkspace.adopt(record); }')
    .replace('const view = buildWorkContextView(', 'window.__probe.context++; const view = buildWorkContextView(')
    .replace('void hydrateReferences();', 'void hydrateReferences().finally(()=>{window.__refsDone=true;});')
    .replace('void hydrateEstimateLibrary();', 'void hydrateEstimateLibrary().finally(()=>{window.__listDone=true;});') + hook;
}
const mime = { '.js':'text/javascript', '.html':'text/html', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer((req,res)=>{
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const path = resolve(root, pathname.replace(/^\/+/, '') + (pathname.endsWith('/')?'index.html':''));
  if (!path.startsWith(root+sep) || !existsSync(path) || !statSync(path).isFile()) return res.writeHead(404).end();
  res.writeHead(200, {'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});
  res.end(path===join(root,'smartinput','smartinput.js')?instrument(variant==='before'?baseline:current):readFileSync(path));
});
const delay = ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await fn())return;await delay(50);}throw new Error('Timeout: '+label);}
class Cdp {
  constructor(url){this.socket=new WebSocket(url);this.pending=new Map();this.id=0;this.handlers={};this.socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}else this.handlers[m.method]?.(m.params);};}
  async open(){await new Promise((resolve,reject)=>{this.socket.onopen=resolve;this.socket.onerror=reject;});}
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
const profile=mkdtempSync(join(tmpdir(),'si-render-perf-'));
let browser,client;
const report={baselineSha,fixture:'1000 synthetic estimate cards, same browser/profile, no production data',unverified:['Production end-to-end delay','First large-list DOM virtualization'],runs:{}};
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const executable=[process.env.CHROME_PATH,process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Microsoft/Edge/Application/msedge.exe'),'/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
  assert.ok(executable,'Chrome/Edge required');
  browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  await until(()=>existsSync(join(profile,'DevToolsActivePort')),'browser');
  const port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  client=new Cdp(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await client.open();
  await client.send('Page.enable');await client.send('Runtime.enable');
  const exceptions=[],external=[];
  client.handlers['Runtime.exceptionThrown']=p=>exceptions.push(p.exceptionDetails.exception?.description||p.exceptionDetails.text);
  await client.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  client.handlers['Fetch.requestPaused']=p=>{const blocked=/^https?:/.test(p.request.url)&&!p.request.url.startsWith(origin+'/');if(blocked)external.push(p.request.url);void client.send(blocked?'Fetch.failRequest':'Fetch.continueRequest',blocked?{requestId:p.requestId,errorReason:'BlockedByClient'}:{requestId:p.requestId});};
  for (variant of ['before','after']) {
    await client.send('Page.navigate',{url:origin+'/smartinput/index.html?perf='+variant});
    await until(()=>client.eval('Boolean(window.__refsDone&&window.__listDone&&window.__renderTest)'),'initial hydrations');
    report.runs[variant]={startup:await client.eval('({...window.__probe})')};
    await client.eval('__renderTest.prepare(1000)');
    await client.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    report.runs[variant].warm=await client.eval(`(()=>{
      const before={...__probe};const samples=[];const first=document.querySelector('#catalogPickerList .estimate-card');
      for(let i=0;i<10;i++){const t=performance.now();__renderTest.mode();samples.push(performance.now()-t);}
      return {samplesMs:samples,p95Ms:[...samples].sort((a,b)=>a-b)[9],sameCard:first===document.querySelector('#catalogPickerList .estimate-card'),counts:Object.fromEntries(Object.keys(before).map(k=>[k,__probe[k]-before[k]]))};
    })()`);
    if(variant==='after') {
      const warm=report.runs.after.warm;
      assert.equal(warm.sameCard,true,'unchanged full renders preserve card nodes');
      assert.deepEqual(warm.counts,{mode:10,catalog:0,adopt:0,context:0});
      assert.ok(warm.p95Ms<=500,`warm local display p95 ${warm.p95Ms}ms exceeds 500ms`);
      await client.eval('__renderTest.remember();window.__firstCard=document.querySelector("#catalogPickerList .estimate-card");window.__beforeWork=JSON.stringify(__renderTest.work());__firstCard.querySelector("button").focus();');
      await client.eval('__renderTest.select(["PERF-0","PERF-1"]);');
      assert.equal(await client.eval('__firstCard===document.querySelector("#catalogPickerList .estimate-card")&&__firstCard.contains(document.activeElement)'),true,'selection preserves card and keyboard focus');
      assert.equal(await client.eval('document.querySelectorAll("#catalogPickerList .is-selected").length'),2);
      await client.eval('__renderTest.select(Array.from({length:1000},(_,i)=>"PERF-"+i))');
      assert.equal(await client.eval('document.querySelectorAll("#catalogPickerList .is-selected").length'),1000);
      await client.eval('__renderTest.select(Array.from({length:999},(_,i)=>"PERF-"+(i+1)))');
      assert.equal(await client.eval('__firstCard.classList.contains("is-selected")'),false,'individual deselection must stay visible');
      await client.eval('__renderTest.select([])');
      assert.equal(await client.eval('document.querySelectorAll("#catalogPickerList [aria-pressed=true]").length'),0);
      assert.equal(await client.eval('__firstCard.querySelector("button").title'),'업데이트 대상 선택');
      await client.eval('__renderTest.select(["PERF-0"]);__renderTest.mutate("body")');
      assert.equal(await client.eval('__firstCard===document.querySelector("#catalogPickerList .estimate-card")'),true,'body-only revision must not replace cards');
      assert.equal(await client.eval('JSON.stringify(__renderTest.work())===__beforeWork'),true,'unsaved workspace, including zero, preserved');
      await client.eval('__renderTest.mutate("rename")');
      assert.match(await client.eval('document.querySelector("#sourceWorkContext").textContent'),/Renamed/);
      assert.match(await client.eval('document.querySelector("#catalogPickerList .estimate-card").textContent'),/Renamed/);
      await client.eval('__renderTest.mutate("reorder")');
      assert.equal(await client.eval('document.querySelector("#catalogPickerList .estimate-card").dataset.estimateId'),'PERF-999');
      await client.eval('__renderTest.mutate("company")');
      assert.equal(await client.eval('Boolean(document.querySelector("[data-estimate-id=FOREIGN]"))'),false);
      await client.eval('__renderTest.pending("test-attempt")');
      assert.match(await client.eval('document.querySelector("#sourceWorkContext").textContent'),/대상 확인 중/);
      await client.eval('__renderTest.pending("");__renderTest.mutate("remove")');
      assert.match(await client.eval('document.querySelector("#sourceWorkContext").textContent'),/대상 확인 필요/);
      await client.eval('__renderTest.mutate("error")');
      assert.match(await client.eval('document.querySelector("#catalogPickerList").textContent'),/조회 실패/);
      await client.eval('__renderTest.mutate("ready")');
      assert.equal(await client.eval('document.querySelectorAll("#catalogPickerList .estimate-card").length'),999);
      const hydrate=await client.eval(`(async()=>{const modes=__probe.mode;const draft=document.querySelector('#inputRows');const input=draft.querySelector('input');input?.focus();const active=document.activeElement;await __renderTest.hydrate();return {modes:__probe.mode-modes,sameInput:active===document.activeElement&&active.isConnected};})()`);
      assert.deepEqual(hydrate,{modes:0,sameInput:true},'summary hydration must not rerender/focus the active input');
      await client.eval('__renderTest.prepare(1000);');
      await client.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      // Actual delegated input event -> application's existing next-frame metric.
      await client.eval(`(async()=>{for(let i=0;i<30;i++){const input=document.querySelector('#inputRows [data-field="quantity"]');input.value=String(i);input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}})()`);
      report.runs.after.snapshot=await client.eval('__renderTest.snapshot()');
      assert.equal(report.runs.after.snapshot.inputToNextFrameMs.length,30);
      assert.ok(report.runs.after.snapshot.p95InputToNextFrameMs<=100,'input feedback p95 must be <=100ms');
    }
  }
  assert.equal(report.runs.before.warm.counts.catalog,10,'baseline must reproduce list rebuilds');
  assert.equal(report.runs.before.warm.counts.adopt,10000,'baseline must reproduce workspace copies');
  assert.equal(report.runs.before.warm.sameCard,false);
  assert.deepEqual(exceptions,[]);assert.deepEqual(external,[]);
  report.status='PASS';console.log(JSON.stringify(report,null,2));
  if(process.env.SMARTINPUT_RENDER_PERF_EVIDENCE) writeFileSync(resolve(process.env.SMARTINPUT_RENDER_PERF_EVIDENCE),JSON.stringify(report,null,2)+'\n');
} finally {
  client?.socket.close();browser?.kill();server.close();
  const target=resolve(profile);
  if(target.startsWith(resolve(tmpdir())+sep)&&target.includes('si-render-perf-'))try{rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
}
