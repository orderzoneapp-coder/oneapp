/** ORDEROPS-3P-01 browser regression. Synthetic local data; external requests blocked. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.env.ORDEROPS_EVIDENCE_DIR || join(tmpdir(), 'orderops-three-pane-evidence'));
mkdirSync(evidence, { recursive: true });
const source = readFileSync(join(root, 'orderops/list.html'), 'utf8');
const hook = 'initializeLocalRecovery().then(loadOrderQSourceFromRoute)';
assert.equal(source.split(hook).length, 2, 'one test observability anchor');
const html = source.replace(hook, 'globalThis.__ops={state,workbench,voucherWorkbench,renderResults,renderPreview,commitCurrentWorkspaceInputs}; '+hook)
  .replace('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js', '/customer-master/vendor/xlsx.full.min.js');
const report = { release: 'ORDEROPS-3P-01', startedAt: new Date().toISOString(), htmlSha256: createHash('sha256').update(source).digest('hex'), checks: [], errors: [], blocked: [], result: 'running', note: 'Synthetic local browser. Bundled SheetJS substitutes only CDN parser in test response, not full styled-output verification.' };
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer((req,res) => {
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file = resolve(root, '.'+pathname);
  if (!file.startsWith(resolve(root)+sep) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, {'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store'});
  res.end(pathname === '/orderops/list.html' ? html : readFileSync(file));
});
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn,label) { const end=Date.now()+25000; while(Date.now()<end) { if(await fn()) return; await wait(80); } throw Error('Timeout: '+label); }
const profile = mkdtempSync(join(tmpdir(),'orderops-3p-'));
let browser, socket, send, ev, shot;
try {
  const command = name => { const r=spawnSync('which',[name],{encoding:'utf8'}); return r.status===0 ? r.stdout.trim().split(/\r?\n/)[0] : ''; };
  const exe=[process.env.CHROME_PATH,command('google-chrome'),command('chromium')].filter(Boolean).find(existsSync);
  assert.ok(exe,'Chrome is required');
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;
  browser=spawn(exe,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  let port; await until(()=>{try { port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0]; return Boolean(port); } catch(error) { if(error.code!=='ENOENT')throw error;return false;}},'Chrome port');
  const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl);const pending=new Map();let next=0;
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  socket.onmessage=event=>{
    const m=JSON.parse(event.data);
    if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
    if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});
    if(m.method==='Fetch.requestPaused'){
      const {requestId,request}=m.params;const allow=request.url.startsWith(origin+'/')&&['GET','HEAD'].includes(request.method);
      if(!allow)report.blocked.push({url:request.url,method:request.method});
      void send(allow?'Fetch.continueRequest':'Fetch.failRequest',allow?{requestId}:{requestId,errorReason:'BlockedByClient'});
    }
  };
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  const fill=(selector,value)=>ev(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,name+'.png'),Buffer.from(r.data,'base64'));};
  const check=async (label,expression)=>{assert.ok(await ev(expression),label);report.checks.push(label);console.log('PASS',label);};
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await send('Emulation.setDeviceMetricsOverride',{width:1704,height:960,deviceScaleFactor:1,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"try{localStorage.setItem('oneapp.nexus.ui.theme.v1','dark')}catch(_){}"});
  report.browser=await send('Browser.getVersion');
  await send('Page.navigate',{url:origin+'/orderops/list.html'});
  await until(()=>ev('Boolean(globalThis.__ops?.state.db && globalThis.XLSX)'),'app ready');
  await check('three direct sibling panes','document.querySelectorAll(".orderops-three-pane > [data-nexus-pane]").length===3');
  await check('Excel button exclusively in left parser','document.querySelector("#prepareDropSurface").contains(document.querySelector("#prepareFilesButton")) && !document.querySelector("#resultsPanel").querySelector("input[type=file],#orderQSourcePicker,#prepareFilesButton")');
  await check('select-all and search share row','document.querySelector("#voucherSelectAll").closest(".voucher-searchbar").contains(document.querySelector("#voucherSearch"))');
  await check('empty table remains table, not import UI','Boolean(document.querySelector("#previewTable thead th")) && !document.querySelector("#previewTable").textContent.includes("불러")');
  await check('bulk hidden without selection','document.querySelector("#voucherBulk").hidden');
  await check('pane geometry left-center-right',`(()=>{const a=document.querySelector('#orderOpsFilePreparePane').getBoundingClientRect(),b=document.querySelector('#resultsPanel').getBoundingClientRect(),c=document.querySelector('#inventoryInspector').getBoundingClientRect();return a.width>150&&b.width>400&&c.width>220&&a.right<=b.left+1&&b.right<=c.left+1})()`);
  await shot('01-empty');
  const matrix=[['주문일자','품목코드','품목명','규격','수량','적요','적요1','거래처','그룹','창고','담당','단위','단가','공급가액','거래처코드'],
    ['2026-09-12','P1','상품 1','EA',3.5,'메모A','직원A','같은 거래처','A','88창고','담당1','EA',1000,3500,'C1'],
    ['2026-09-12','P2','상품 2','BOX',2,'메모A','직원A','같은 거래처','A','88창고','담당1','BOX',500,1000,'C1'],
    ['2026-09-13','P1','상품 1','EA',0.5,'메모B','직원B','같은 거래처','B','88창고','담당1','EA',1000,500,'C1']];
  const fileScript=`const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(${JSON.stringify(matrix)}),'주문현황');const file=new File([XLSX.write(wb,{bookType:'xlsx',type:'array'})],'주문현황.xlsx');const dt=new DataTransfer();dt.items.add(file);`;
  await ev(`(()=>{${fileScript}document.querySelector('#previewTable').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));return true;})()`);
  await wait(200);
  await check('center drop neither prepares nor applies','__ops.state.preparedFiles.length===0 && !__ops.state.workspace');
  await ev(`(()=>{${fileScript}const input=document.querySelector('#prepareFilesInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await until(()=>ev('__ops.state.preparedFiles.length===1 && !document.querySelector("#prepareApplyButton").disabled'),'file ready');
  await check('file prepares without replacing working data','!__ops.state.workspace && __ops.state.preparedFiles[0].status==="READY"');
  await click('#prepareApplyButton');
  await until(()=>ev('__ops.state.workspace?.orders.length===3 && !__ops.workbench.operation'),'file applied');
  await check('same customer still has two vouchers','document.querySelectorAll("#voucherRows [data-voucher-id]").length===2');
  await click('#voucherRows input[type=checkbox]');
  await check('bulk shown only after checkbox','!document.querySelector("#voucherBulk").hidden');
  await fill('#voucherWarehouseInput','본사');await fill('#voucherManagerInput','담당2');await click('#voucherApply');
  await until(()=>ev('!__ops.workbench.operation && __ops.state.workspace.orders[0].manager==="담당2"'),'bulk applied');
  await check('only selected document changes','JSON.stringify(__ops.state.workspace.orders.map(r=>r.manager))===JSON.stringify(["담당2","담당2","담당1"])');
  await check('checkbox survives warehouse edit','document.querySelectorAll("#voucherRows input:checked").length===1');
  await check('verified recovery published','Boolean(localStorage.getItem("oneapp.shipping.recovery.pointer.v1"))');
  await check('mixed units not added together','document.querySelector("#voucherTotals").textContent.includes("3.5 EA / 2 BOX")');
  await shot('02-selected-applied');
  await click('#voucherWarehouses button[data-value="88창고"]');
  await check('hidden selected voucher remains explicit','document.querySelector("#voucherTotals").textContent.includes("현재 목록 밖 1건")');
  await click('#voucherSelectAll');await check('select all adds visible only','document.querySelector("#voucherTotals").textContent.includes("선택 2건")');
  await click('#voucherSelectAll');await check('deselect all removes visible only','document.querySelector("#voucherTotals").textContent.includes("선택 1건")');
  await fill('#voucherManagerInput','우측 대기');
  await ev("ShippingManagementEngine.setOrderValue(__ops.state.workspace,__ops.state.workspace.orders[0].sourceRowNumber,'manager','중앙 변경',{recordHistory:true});__ops.state.workspaceChangeVersion++;__ops.renderResults();true");
  await click('#voucherManagerApply');
  await check('central conflict keeps both values','__ops.state.workspace.orders[0].manager==="중앙 변경" && document.querySelector("#voucherManagerInput").value==="우측 대기"');
  await click('#voucherCancel');
  await click('#preparePaneClose');await check('left closes','document.querySelector("#orderOpsFilePreparePane").hidden');
  await click('#preparePaneReopen');await check('left reopens without dropping input','!document.querySelector("#orderOpsFilePreparePane").hidden && __ops.state.preparedFiles.length===1');
  await click('#inventoryInspectorClose');await check('right closes','document.querySelector("#inventoryInspector").hidden');
  // Existing right-panel reopen control must remain reachable from central table tools.
  await click('#inventoryInspectorReopen');await check('right reopens','!document.querySelector("#inventoryInspector").hidden');
  await click('#voucherWarehouses button[data-value=""]');
  await fill('#voucherManagerInput','대기');await click('#voucherRows input:checked');
  await check('last deselection clears hidden draft','document.querySelector("#voucherBulk").hidden && !__ops.voucherWorkbench.dirty()');
  // Existing internal read adapter: EMPTY must not silently clear current work.
  await click('#purchaseApiButton');
  await check('purchase read opens in its own dialog','document.querySelector(".orderops-source-dialog").open');
  await click('.orderops-source-dialog button[type=submit]');
  await until(()=>ev('document.querySelector(".orderops-source-dialog [role=status]").textContent.includes("조회된 전표가 없습니다")'),'empty internal purchase response');
  await check('empty API result keeps orders','__ops.state.workspace.orders.length===3');
  await click('.orderops-source-dialog [data-close]');
  await shot('03-workspace');
  assert.deepEqual(report.errors,[],'no runtime exceptions');
  report.result='passed'; console.log('PASS ORDEROPS-3P-01 browser:',report.checks.length,'checks');
} catch(error) {
  report.result='failed';report.error=error.stack;console.error(error);process.exitCode=1;
  try { if(shot)await shot('failure'); if(ev)report.dom=await ev('document.body.innerText.slice(0,14000)'); } catch(_) {}
} finally {
  report.finishedAt=new Date().toISOString();writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2));
  socket?.close();if(browser?.pid){spawnSync('pkill',['-TERM','-P',String(browser.pid)],{stdio:'ignore'});browser.kill('SIGTERM');}
  server.closeAllConnections();await new Promise(r=>server.close(r));
}
