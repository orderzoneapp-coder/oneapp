import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'orderops-v12-'));
const evidence = process.env.ORDEROPS_EVIDENCE_DIR;
const performanceMode = process.env.ORDEROPS_PERFORMANCE === '1';
const cellContainmentPair = performanceMode && process.env.ORDEROPS_CELL_CONTAINMENT_PAIR === '1';
const predecoratedPair = performanceMode && process.env.ORDEROPS_PREDECORATED_PAIR === '1';
const evidenceRun={startedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,platform:process.platform,performanceMode,result:'running',logs:[],sourceHashes:Object.fromEntries(['orderops/list.html','orderops/workbench-ui.js','orderops/workbench-contract.js','orderops/workbench-v12.css','orderFulfillmentEngine.js','orderFulfillmentWorkbook.js','nexus/common/nexus-workbench-layout-v2.js'].map(path=>[path,createHash('sha256').update(readFileSync(join(root,path))).digest('hex')]))};
evidenceRun.performanceVerdict=performanceMode?'not-measured':'not-applicable';
evidenceRun.predecoratedPair=predecoratedPair;
evidenceRun.responseHashes=[];
evidenceRun.diagnosticOptions={profile:process.env.ORDEROPS_PROFILE==='1',cellContainmentResponseOnly:process.env.ORDEROPS_CELL_CONTAINMENT==='1',cellContainmentPair,predecoratedPair,diagnosticOnly:process.env.ORDEROPS_DIAGNOSTIC==='1'||cellContainmentPair||predecoratedPair,diagnosticSamples:process.env.ORDEROPS_DIAGNOSTIC_SAMPLES||'1',gpu:performanceMode?'default':'disabled'};
const log=console.log;console.log=(...args)=>{evidenceRun.logs.push(args.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' '));log(...args);};
let baselineMode = false;
const baselineFiles = performanceMode ? new Map(['orderops/list.html','orderFulfillmentEngine.js','orderFulfillmentWorkbook.js','nexus/common/nexus-workbench-layout-v2.js'].map(path=>[path,execFileSync('git',['show',`a5eeb19ca3ae104f66c86dc5b6b9b63df501d41c:${path}`],{cwd:root,encoding:'utf8'})])) : new Map();
const perfHook = 'globalThis.__perf={state,renderResults,renderPreview}; initializeLocalRecovery().then(loadOrderQSourceFromRoute)';
const html = readFileSync(join(root, 'orderops/list.html'), 'utf8').replace('initializeLocalRecovery().then(loadOrderQSourceFromRoute)', 'globalThis.__ops={state,workbench,renderResults,refreshInputState,applyLatestOrderQSource,restorePreviewInputState,loadOrderQSource,flushOrderOpsBeforeWorkspaceLeave,performAnalysis,refreshShipmentExecution,commitCurrentWorkspaceInputs,saveCloudPlan,loadCloudPlan}; initializeLocalRecovery().then(loadOrderQSourceFromRoute)');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(requestUrl.pathname);
  if (performanceMode && pathname==='/orderops/list.html') baselineMode=requestUrl.searchParams.get('baseline')==='1';
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(resolve(root) + sep) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
  let source = baselineMode && baselineFiles.has(pathname.slice(1)) ? baselineFiles.get(pathname.slice(1)) : pathname === '/orderops/list.html' ? html : readFileSync(file);
  if(predecoratedPair&&pathname==='/orderops/list.html'&&requestUrl.searchParams.get('predecorated')!=='1')source=String(source).replace('column-width-managed${options.printOutput ? "" : " nexus-table-ux"}', 'column-width-managed');
  const cellContainment=cellContainmentPair?requestUrl.searchParams.get('cellContainment')==='1':process.env.ORDEROPS_CELL_CONTAINMENT==='1';
  if(performanceMode&&cellContainment&&pathname==='/orderops/list.html')source=String(source).replace('mountPreparedPreview(previewMarkup);','mountPreparedPreview(previewMarkup.replace(/<input\\b[^>]*>/g, value => `<div style="content-visibility:auto;contain-intrinsic-size:auto 28px;height:28px">${value}</div>`));');
  if (performanceMode && process.env.ORDEROPS_PROFILE==='1' && pathname==='/orderops/list.html') {
    for(const name of ['getPreviewDefinitions','renderPreview','renderTableMarkup','renderOrderOpsSidePanels','renderWarehouseColorBar','renderSourceViewCards','renderColumnVisibilityMenu','updateColumnWidthToolbar','activatePreview','commitPreviewInputs','renderResults']) {
      source=String(source).replace(`function ${name}(`,`function ${name}(...args) { const start=performance.now(); try { return __profile_${name}(...args); } finally { (globalThis.__profileStages ||= []).push({name:'${name}',ms:performance.now()-start}); } } function __profile_${name}(`);
    }
  }
  if(performanceMode && pathname==='/nexus/common/nexus-workbench-layout-v2.js') source=String(source).replace('function positionHandles(layout) {','function positionHandles(layout) { globalThis.__layoutCalls=(globalThis.__layoutCalls||0)+1;');
  if(performanceMode && process.env.ORDEROPS_PROFILE==='1' && pathname==='/nexus/common/nexus-table-ux.js') {
    for(const name of ['decorate','applyView','applyNumericAlignment']) source=String(source).replace(`function ${name}(`,`function ${name}(...args) { const start=performance.now(); try { return __profile_${name}(...args); } finally { (globalThis.__profileStages ||= []).push({name:'table-${name}',ms:performance.now()-start}); } } function __profile_${name}(`);
  }
  if(performanceMode && process.env.ORDEROPS_PROFILE==='1') {
    const names=pathname==='/orderFulfillmentEngine.js'?['getInventoryViewRows','getShortageCategoryContext','getStockLedgerView','getFinalPurchaseUploadSelection']:pathname==='/nexus/common/nexus-workbench-layout-v2.js'?['positionHandles']:[];
    for(const name of names)source=String(source).replace(`function ${name}(`,`function ${name}(...args) { const start=performance.now(); try { return __profile_${name}(...args); } finally { (globalThis.__profileStages ||= []).push({name:'${name}',ms:performance.now()-start}); } } function __profile_${name}(`);
  }
  const response=performanceMode && pathname === '/orderops/list.html' ? String(source).replace('initializeLocalRecovery().then(loadOrderQSourceFromRoute)',perfHook) : source;
  if(performanceMode&&pathname==='/orderops/list.html') {
    evidenceRun.responseHashes.push({url:requestUrl.pathname+requestUrl.search,at:new Date().toISOString(),sha256:createHash('sha256').update(response).digest('hex')});
    if(evidence&&cellContainmentPair){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,cellContainment?'cell-containment-response.html':'unchanged-response.html'),response);}
  }
  res.end(response);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const end=Date.now()+20000; let last; while(Date.now()<end) { try { const value=await fn(); if(value)return value; }catch(error){last=error;} await wait(80); } throw new Error(label + ': ' + (last?.message || 'timeout')); }
const command = name => { const result=spawnSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8',windowsHide:true});return result.status===0?result.stdout.trim().split(/\r?\n/)[0]:''; };
const executable=[process.env.CHROME_PATH,process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),command('google-chrome'),command('chromium')].filter(Boolean).find(existsSync);
let browser, socket;
const errors=[];
try {
  assert.ok(executable, 'Chrome is required');
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=spawn(executable,['--headless=new','--no-sandbox',...(performanceMode?[]:['--disable-gpu']),'--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const port=await until(()=>existsSync(join(profile,'DevToolsActivePort'))&&readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0],'CDP port');
  const target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl); const pending=new Map();let next=0;
  socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(p)msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);} if(msg.method==='Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);if(msg.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});};
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const origin=`http://127.0.0.1:${server.address().port}`;
  await send('Runtime.enable');await send('Page.enable');
  evidenceRun.browser=await send('Browser.getVersion');
  const downloadDir=join(profile,'downloads');mkdirSync(downloadDir,{recursive:true});
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
  await send('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:origin+'/orderops/list.html'});
  await until(()=>ev('Boolean(globalThis.__ops?.state.db || globalThis.__perf?.state.db)'), 'app initialization');
  if (performanceMode) {
    const reports=[];
    const profiling=process.env.ORDEROPS_PROFILE==='1';
    const diagnostic=profiling || process.env.ORDEROPS_DIAGNOSTIC==='1' || cellContainmentPair || predecoratedPair;
    const variants=cellContainmentPair?[{baseline:false,cell:false},{baseline:false,cell:true}]:predecoratedPair?[{baseline:false,predecorated:false},{baseline:false,predecorated:true}]:(diagnostic?[false]:[true,false]).map(baseline=>({baseline,cell:process.env.ORDEROPS_CELL_CONTAINMENT==='1'}));
    for(const {baseline,cell,predecorated=true} of variants) {
      // Reset only this isolated fixture's UI preferences. Odd panel clicks
      // must not change the next comparison's initial table viewport.
      await ev(`localStorage.setItem('oneapp.orderops.inventory-inspector-open.v1','0');localStorage.setItem('oneapp.orderops.file-prepare-open.v1','1');localStorage.setItem('nexus:workbench-layout:orderops:v2',JSON.stringify({schemaVersion:2,left:380,right:280}));true`);
      await send('Page.navigate',{url:origin+'/orderops/list.html?baseline='+(baseline?'1':'0')+'&cellContainment='+(cell?'1':'0')+'&predecorated='+(predecorated?'1':'0')});
      await until(()=>ev('Boolean(globalThis.__perf?.state.db) && Boolean(globalThis.__ops)==='+String(!baseline)),'performance version initialization');
      for(const [count,warehouses] of (diagnostic?[[500,10]]:[[100,3],[500,10],[2000,10]])) {
        if(profiling){await send('Profiler.enable');await send('Profiler.start');}
        const result=await ev(readFileSync(join(root,'scripts/fixtures/orderops-workbench-performance.js'),'utf8').replaceAll('__ROW_COUNT__',String(count)).replaceAll('__WAREHOUSE_COUNT__',String(warehouses)).replaceAll('__SAMPLES__',diagnostic?String(Math.max(1,Math.min(5,Number(process.env.ORDEROPS_DIAGNOSTIC_SAMPLES)||1))):'30'));
        if(profiling){const {profile:cpu}=await send('Profiler.stop');console.log('CPU',JSON.stringify(cpu.nodes.filter(n=>n.hitCount).sort((a,b)=>b.hitCount-a.hitCount).slice(0,30).map(n=>({name:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber,hits:n.hitCount}))));}
        reports.push({version:baseline?'a5eeb19':'development',cellContainmentResponseOnly:cell,predecorated,...result});console.log('PERFORMANCE',JSON.stringify(reports.at(-1)));
        if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'performance-progress.json'),JSON.stringify({completed:false,reports},null,2));}
      }
    }
    const notMet=reports.filter(report=>report.version==='development').some(report=>report.summary.orders.p95>500||report.summary.inventory.p95>500||report.summary.selection.p95>100||report.summary.panel.p95>100);
    evidenceRun.performanceVerdict=notMet?'not-met':diagnostic?'diagnostic-only':'programmatic-thresholds-met-physical-touch-unverified';
    if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'performance.json'),JSON.stringify({performanceVerdict:evidenceRun.performanceVerdict,environment:'headless Chrome, same isolated profile/server, 1366x768, next two animation frames; no network business I/O',reports},null,2));}
  } else if(process.env.ORDEROPS_PREPARATION==='1') {
    console.log('PASS preparation acceptance',JSON.stringify(await ev(readFileSync(join(root,'scripts/fixtures/orderops-workbench-preparation.js'),'utf8'))));
    assert.deepEqual(errors,[]);
  } else {
  assert.deepEqual(errors,[]);
  assert.equal(await ev('document.querySelectorAll("#previewTabs [data-preview]").length'),6);
  await ev(`window.confirm=()=>true;window.alert=()=>{};`);
  // Real File/SheetJS/explicit mapping/apply UI. Test hook exists only in this
  // local server's response; shipped application has no test state endpoint.
  await ev(`(async()=>{const X=window.XLSX;const wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([
    ['일자','창고','담당','단위','품목코드','품목명','규격','수량','적요','적요1','거래처','그룹'],
    ['2026-09-12','3서울','담당 A','EA','0001','합성상품','규격',10,'일반','직원','거래처 A','주문1'],
    ['2026-09-12','3서울','담당 A','EA','0002','합성상품2','규격',5,'일반2','직원2','거래처 B','주문2']]),'주문');
    const file=new File([X.write(wb,{type:'array',bookType:'xlsx'})],'orders.xlsx');await __ops.workbench.prepare([file],'orders');return true;})()`);
  assert.equal(await ev('__ops.state.preparedFiles[0].status'),'READY', await ev('JSON.stringify(__ops.state.preparedFiles[0].parsed?.errors)'));
  assert.equal(await ev('Boolean(__ops.state.workspace)'),false,'file parsing must not replace work');
  await click('#prepareApplyButton');
  await until(()=>ev('__ops.state.workspace?.orders?.length===2&&!__ops.workbench.operation'),'file apply');
  assert.equal(await ev('__ops.state.activePreview'),'allocations');
  assert.ok(await ev('document.querySelector("#previewTable").textContent.includes("합성상품")'));
  assert.equal(await ev('Boolean(__ops.state.workspace.sourceFiles.orders.explicitMapping)'),true);
  assert.equal(await ev('Boolean(__ops.state.workspace.sourceFiles.orders.sourceEvidence.cells)'),true);
  await click('#inventoryInspectorReopen');
  await click('#previewTable [data-order-row="2"]');
  await ev(`const edit=document.querySelector('[data-inspector-field="note1Original"]');edit.value='보존할 직원 입력';edit.dispatchEvent(new Event('input',{bubbles:true}));`);
  await click('#previewTable [data-order-row="3"]');
  await click('#previewTable [data-order-row="2"]');
  assert.equal(await ev(`document.querySelector('[data-inspector-field="note1Original"]').value`),'보존할 직원 입력');
  await click('[data-inspector-apply]');
  assert.equal(await ev('__ops.state.workspace.orders[0].note1Original'),'보존할 직원 입력');
  assert.equal(await ev('__ops.state.workspace.orders[0].noteOriginal'),'일반');
  const layout=[];
  for(const width of [1920,1366,1024,819,640,639,390]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:768,deviceScaleFactor:1,mobile:false});await wait(120);
    await click('#inventoryInspectorReopen');
    const result=await ev(`(()=>{const panes=[...document.querySelectorAll('.orderops-workbench-v12 > [data-nexus-pane]')];return {width:innerWidth,panes:panes.map(p=>({role:p.dataset.nexusPane,hidden:p.hidden,x:p.getBoundingClientRect().x,right:p.getBoundingClientRect().right})),footer:document.querySelector('.orderops-bottom-workbar').getBoundingClientRect().toJSON(),handles:[...document.querySelectorAll('.nexus-pane-resizer-v2')].filter(e=>!e.hidden).length,body:document.documentElement.scrollWidth};})()`);
    layout.push(result);assert.equal(result.panes.length,3);assert.ok(result.footer.bottom<=769,JSON.stringify(result));assert.ok(result.body<=width+1,JSON.stringify(result));
    if(width<=639)assert.equal(result.handles,0);
    if(evidence&&[1366,819,390].includes(width)){mkdirSync(evidence,{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,`orderops-${width}.png`),Buffer.from(shot.data,'base64'));}
  }
  assert.deepEqual(errors,[]);
  console.log('PASS U01/02/04/07/08/14/15/16/18/31 initial workbench browser',JSON.stringify(layout));
  await send('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});
  console.log('PASS preparation acceptance',JSON.stringify(await ev(readFileSync(join(root,'scripts/fixtures/orderops-workbench-preparation.js'),'utf8'))));
  const scenario=await ev(readFileSync(join(root,'scripts/fixtures/orderops-workbench-scenario.js'),'utf8'));
  console.log('PASS U06/U19/U22 transaction and actual command browser scenarios',JSON.stringify(scenario));
  const download=await until(()=>readdirSync(downloadDir).find(name=>name.endsWith('.xlsx')),'actual F10 downloaded file');
  const bytes=readFileSync(join(downloadDir,download));
  const exported=await ev(`(()=>{const book=XLSX.read(Uint8Array.from(atob('${bytes.toString('base64')}'),c=>c.charCodeAt(0)),{type:'array'});return {sheets:book.SheetNames,rows:XLSX.utils.sheet_to_json(book.Sheets['구매업로드'],{header:1,raw:true}).slice(1).map(row=>[row[5],row[11]])};})()`);
  assert.equal(exported.rows.length,1,'actual file excludes sufficient stock');assert.equal(exported.rows[0][1],6,'actual F10 file shortage quantity');assert.match(scenario.f10Message,/구매업로드 1행/);
  if(evidence)writeFileSync(join(evidence,'U06-F10-synthetic.xlsx'),bytes);
  console.log('PASS U06/U26 real UI F10 download, purchase quantity 6, sufficient stock excluded, same-version notice 1 row');
  assert.deepEqual(errors,[]);
  await ev('globalThis.__stageCrash()');
  await until(()=>ev('globalThis.__stagedCrashReady'),'STAGED record before forced reload');
  const returnUrl=await ev('location.href');
  const restartAfterTermination=async()=>{
    const handleMessage=socket.onmessage;socket.close();
    if(process.platform==='win32'){const killed=spawnSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{windowsHide:true,encoding:'utf8'});console.log('Isolated browser termination',JSON.stringify({pid:browser.pid,status:killed.status,stdout:killed.stdout}));}
    else {spawnSync('pkill',['-KILL','-P',String(browser.pid)],{stdio:'ignore'});browser.kill('SIGKILL');}
    const terminatedPid=browser.pid;
    await until(()=>{try{process.kill(terminatedPid,0);return false;}catch(error){return error.code==='ESRCH';}},'owned browser process exit');
    await wait(500);rmSync(join(profile,'DevToolsActivePort'),{force:true});
    browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--hide-crash-restore-bubble','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let restartErrors='';browser.stderr.on('data',chunk=>{restartErrors+=chunk;});
    const newPort=await until(()=>{if(browser.exitCode!==null)throw Error('restart exit '+browser.exitCode+' '+restartErrors.slice(-2000));return restartErrors.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]||(existsSync(join(profile,'DevToolsActivePort'))&&readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);},'restart debug port').catch(error=>{throw Error(error.message+' '+restartErrors.slice(-2500));});
    const newTarget=(await(await fetch(`http://127.0.0.1:${newPort}/json/list`)).json()).find(t=>t.type==='page');
    socket=new WebSocket(newTarget.webSocketDebuggerUrl);socket.onmessage=handleMessage;await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
    await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:returnUrl});
  };
  await restartAfterTermination();
  await until(()=>ev('!globalThis.__stagedCrashReady && globalThis.__ops?.state.workspace?.workbenchReconciliation && globalThis.__ops.state.inventory'),'accepted recovery after forced reload');
  const recovered=await ev(`({revision:__ops.state.orderQSource.snapshot.orderRevision,note:__ops.state.workspace.orders[0].note1Original,orphans:__ops.state.workspace.workbenchUnapplied.length,code:__ops.state.workspace.orders[0].productCode})`);
  assert.deepEqual(recovered,{revision:scenario.latestRevision,note:'저장 대기 중 최신 입력',orphans:1,code:'ALT'},'U22-e actual forced reload must recover complete accepted work, never staged revision');
  console.log('PASS U22-e/f forced browser process termination: accepted complete work and inventory restored; staged candidate excluded');
  await restartAfterTermination();
  await until(()=>ev('globalThis.__ops?.state.workspace?.workbenchReconciliation && globalThis.__ops.state.inventory'),'accepted work after second process termination');
  assert.equal(await ev('__ops.state.workspace.orders[0].note1Original'),recovered.note);
  assert.equal(await ev('__ops.state.workspace.workbenchUnapplied.length'),1);
  console.log('PASS U22-e/f second termination after accepted recovery: notes, orphan and inventory retained');
  await send('Page.navigate',{url:origin+'/nexus/workspace.html?app=orderops&route='+encodeURIComponent('orderops/list.html?orderId=WB-ORDER&returnTo=orderops_list.html&focus=WB-I1')});
  await until(()=>ev('Boolean(document.querySelector("#nexusWorkspaceFrame")?.contentWindow.__ops?.state.workspace?.workbenchReconciliation)'), 'actual host OrderOps ready');
  console.log('PASS U29 actual host preparation/conflict/round-trip',JSON.stringify(await ev(readFileSync(join(root,'scripts/fixtures/orderops-workbench-host.js'),'utf8'))));
  }
  evidenceRun.result='passed';
} catch(error) { evidenceRun.result='failed';evidenceRun.error=error.message;console.error('Runtime errors:',errors,'Failure:',error.message);throw error; }
finally { if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'browser-result.json'),JSON.stringify({...evidenceRun,finishedAt:new Date().toISOString(),runtimeErrors:errors},null,2));}socket?.close();if(browser){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else browser.kill('SIGKILL');}await new Promise(r=>server.close(r));await wait(300);try { if(resolve(profile).startsWith(resolve(tmpdir())+sep))rmSync(profile,{recursive:true,force:true,maxRetries:2,retryDelay:100}); } catch { console.warn('Temporary browser evidence retained:',profile); } }
