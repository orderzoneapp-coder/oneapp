import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const manual = process.argv.includes('--manual');
const evidence = resolve(process.env.ORDEROPS_EVIDENCE_DIR || join(tmpdir(), 'orderops-drop-visual-evidence'));
const profile = mkdtempSync(join(tmpdir(), 'orderops-drop-visual-'));
const runtimeFiles = ['orderops/list.html', 'orderops/workbench-ui.js', 'orderops/workbench-v12.css', 'orderFulfillmentEngine.js'];
const sources = new Map(runtimeFiles.map(path => [path, baseline ? execFileSync('git', ['show', `1a6f943f:${path}`], { cwd: root }) : readFileSync(join(root, path))]));
const report = { startedAt: new Date().toISOString(), baseline, manual, head: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries([...sources].map(([p,b]) => [p,createHash('sha256').update(b).digest('hex')])), profile, checks: [], errors: [], blockedRequests: [], result: 'running', dragEvidence: 'DOM DataTransfer/DragEvent; NOT OS drag-and-drop' };
mkdirSync(evidence, { recursive: true });
const html = String(sources.get('orderops/list.html')).replace('initializeLocalRecovery().then(loadOrderQSourceFromRoute)', 'globalThis.__ops={state,workbench,renderResults}; initializeLocalRecovery().then(loadOrderQSourceFromRoute)');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer((req,res) => {
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname), file = resolve(root, '.'+pathname);
  if (!file.startsWith(resolve(root)+sep) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
  res.end(pathname === '/orderops/list.html' ? html : sources.get(pathname.slice(1)) || readFileSync(file));
});
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn,label) { const end=Date.now()+30000; while(Date.now()<end) { if(await fn())return; await wait(100); } throw Error('Timeout: '+label); }
let browser, socket;
try {
  const commandPath=name=>{const r=spawnSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8',windowsHide:true});return r.status===0?r.stdout.trim().split(/\r?\n/)[0]:'';};
  const executable = [process.env.CHROME_PATH,process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),commandPath('google-chrome'),commandPath('chromium')].filter(Boolean).find(existsSync);
  assert.ok(existsSync(executable), 'Chrome required');
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(executable, [...(manual?[]:['--headless=new']), '--no-first-run', '--disable-gpu', '--remote-debugging-port=0', '--window-size=1366,900', '--window-position=0,0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: !manual, stdio:'ignore' });
  let port;
  await until(()=>{try {port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];return Boolean(port);} catch(error){if(!['ENOENT','EBUSY'].includes(error.code))throw error;return false;}},'CDP');
  const target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl); const pending=new Map();let next=0;
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(p)msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);} if(msg.method==='Runtime.exceptionThrown')report.errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);if(msg.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});if(msg.method==='Fetch.requestPaused'){const {requestId,request}=msg.params;if(request.url.startsWith(origin+'/')||(['GET','HEAD'].includes(request.method)&&/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//.test(request.url)))void send('Fetch.continueRequest',{requestId});else{report.blockedRequests.push({url:request.url,method:request.method});void send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}}};
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,name+'.png'),Buffer.from(r.data,'base64'));};
  const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
  await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  report.browser=await send('Browser.getVersion');report.origin=origin;report.pid=browser.pid;report.cdpPort=port;
  if(!manual)await send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:origin+'/orderops/list.html?isolated=drop-visual'});
  await until(()=>ev('Boolean(globalThis.__ops?.state.db && globalThis.XLSX)'), 'initialized');
  await ev(`localStorage.setItem('nexus.ui.theme','dark');document.documentElement.dataset.nexusUiTheme='dark';true`);
  await wait(200);await shot('dark-empty');
  // Only synthetic workbooks, generated locally. Same input for before/after.
  await ev(`globalThis.fixture=(kind,name)=>{const X=XLSX,w=X.utils.book_new();X.utils.book_append_sheet(w,X.utils.aoa_to_sheet(kind==='inventory'?[['품목코드','품목명','단위','3서울'],['0001','합성상품','EA',4]]:[['일자','창고','담당','단위','품목코드','품목명','규격','수량','적요','적요1','거래처','그룹'],['2026-09-12','3서울','담당 A','EA','0001','합성상품','규격',10,'일반 적요','직원 전달','거래처 A','주문1'],['2026-09-12','3서울','담당 B','EA','0002','합성상품2','규격',5,'일반 적요2','직원 전달2','거래처 B','주문2']]),kind==='inventory'?'재고':'주문');return new File([X.write(w,{type:'array',bookType:'xlsx'})],name||kind+'.xlsx');};globalThis.dropFiles=(files,target=document.querySelector('#orderOpsFilePreparePane'))=>{const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));const over=new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true});target.dispatchEvent(over);const highlight=document.querySelector('#orderOpsFilePreparePane').classList.contains('is-file-dragover');const drop=new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true});target.dispatchEvent(drop);return {overPrevented:over.defaultPrevented,dropPrevented:drop.defaultPrevented,highlight};};true`);
  for(const kind of ['orders','inventory'])writeFileSync(join(evidence,`synthetic-${kind}.xlsx`), Buffer.from(await ev(`(async()=>btoa(String.fromCharCode(...new Uint8Array(await fixture('${kind}').arrayBuffer()))))()`),'base64'));
  if(manual){report.dragEvidence='awaiting actual OS file drag';writeFileSync(join(evidence,'manual-session.json'),JSON.stringify(report,null,2));console.log('MANUAL SESSION',JSON.stringify({origin,port,pid:browser.pid,evidence}));while(true){await wait(3000);report.observed=await ev(`({at:new Date().toISOString(),url:location.href,prepared:__ops.state.preparedFiles.map(p=>({fileName:p.fileName,status:p.status,dirty:p.dirty,include:p.include})),orders:__ops.state.workspace?.orders?.length||0,status:document.querySelector('#prepareStatus').textContent})`);writeFileSync(join(evidence,'manual-session.json'),JSON.stringify(report,null,2));}}
  if(baseline){const old=await ev('dropFiles([fixture("orders")])');check('baseline reproduces missing pane drop',!old.dropPrevented&&!old.overPrevented);await ev('globalThis.__ops.workbench.prepare([fixture("orders")],"orders")');}
  else{const result=await ev('dropFiles([fixture("orders")])');check('file dragover/drop cancelled + highlight',result.overPrevented&&result.dropPrevented&&result.highlight);}
  await until(()=>ev('__ops.state.preparedFiles.length===1&&__ops.state.preparedFiles[0].status==="READY"'),'prepared');
  check('drop prepares only; no automatic apply',await ev('!__ops.state.workspace'));
  if(!baseline)for(const theme of ['dark','light']){
    await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';true`);await wait(100);
    const action=await ev(`(()=>{const b=document.querySelector('#prepareApplyButton'),c=getComputedStyle(b);return {disabled:b.disabled,height:b.getBoundingClientRect().height,background:c.backgroundColor,color:c.color,text:b.textContent,token:c.getPropertyValue('--ops-action').trim()};})()`);
    report.checks.push({activeAction:theme,...action});check(`${theme} ready: active primary action >=52px`,!action.disabled&&action.height>=52&&action.background!=='rgba(0, 0, 0, 0)');await shot(`${theme}-ready-before-apply`);
  }
  await ev(`document.querySelector('#prepareApplyButton').click()`);await until(()=>ev('__ops.state.workspace?.orders?.length===2&&!__ops.workbench.operation'),'explicit apply');
  await ev(`document.querySelector('#inventoryInspectorReopen').click();document.querySelector('#previewTable [data-order-row="2"]').click();true`);
  report.loadedGeometry=await ev(`(()=>{const rect=e=>e.getBoundingClientRect().toJSON(),header=document.querySelector('[data-nexus-app-header="orderops"]');return {header:rect(header),tabs:rect(document.querySelector('#previewTabs')),actions:rect(header.querySelector('.header-actions')),table:rect(document.querySelector('#previewTable')),workspace:rect(document.querySelector('.orderops-workbench-v12')),preparation:rect(document.querySelector('#orderOpsFilePreparePane'))};})()`);
  if(!baseline){
    const g=report.loadedGeometry;
    check('desktop app tabs centered',Math.abs(g.tabs.x+g.tabs.width/2-1366/2)<=2);
    check('desktop actions aligned right',Math.abs(g.actions.right-(g.header.right-24))<=2);
    check('workspace directly below header; two surplus rows removed',g.workspace.top-g.header.bottom<=9&&g.table.top<230);
    await ev(`document.querySelector('#orderOpsWorkbenchStatusButton').click();true`);await until(()=>ev(`document.querySelector('#orderOpsWorkbenchStatus').matches(':popover-open')`),'status open');
    check('full status outside clipped panel',await ev(`document.querySelector('#orderOpsWorkbenchStatus').parentElement===document.body&&document.querySelector('#orderOpsWorkbenchStatus').contains(document.querySelector('#validationBox'))`));
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait(100);
    check('Escape closes status and restores focus',await ev(`!document.querySelector('#orderOpsWorkbenchStatus').matches(':popover-open')&&document.activeElement.id==='orderOpsWorkbenchStatusButton'`));
    await ev(`document.querySelector('#validationBox').classList.add('bad');true`);await until(()=>ev(`document.querySelector('#orderOpsWorkbenchStatusButton').dataset.error==='true'`),'bad class observed');
    check('error visible without opening popup or scrolling toolbar',await ev(`(()=>{const b=document.querySelector('#orderOpsWorkbenchStatusButton'),r=b.getBoundingClientRect(),p=b.parentElement.getBoundingClientRect();return b.textContent.includes('확인 필요')&&r.left>=p.left&&r.right<=p.right&&!document.querySelector('#orderOpsWorkbenchStatus').matches(':popover-open');})()`));await shot('status-error-visible');
    await ev(`document.querySelector('#validationBox').classList.remove('bad');true`);
  }
  if(!baseline){
    await ev(`document.querySelector('#previewTable').insertAdjacentHTML('beforeend','<table id="styleContractProbe"><tbody><tr><td><input class="purchase-input excel-grid-input" data-negative-balance="true" value="경고"></td><td><input class="order-edit-input" value="0"></td><td><input class="order-edit-input" value=""></td></tr></tbody></table>');true`);
    for(const theme of ['dark','light'])for(const focused of [false,true]){
      const styles=await ev(`(()=>{document.documentElement.dataset.nexusUiTheme='${theme}';const i=document.querySelector('#styleContractProbe .purchase-input'),sheet=[...document.styleSheets].find(s=>s.href?.includes('workbench-v12.css'));${focused?'i.focus();':'i.blur();'}const read=()=>({background:getComputedStyle(i).backgroundColor,color:getComputedStyle(i).color});sheet.disabled=true;const before=read();sheet.disabled=false;return {before,after:read()};})()`);
      report.checks.push({warningStyle:theme,focused,...styles});assert.deepEqual(styles.after,styles.before,'warning surface/color preserved');
    }
    check('zero/blank editor values preserved',await ev(`(()=>{const inputs=document.querySelectorAll('#styleContractProbe .order-edit-input');return inputs[0].value==='0'&&inputs[1].value==='';})()`));await ev(`document.querySelector('#styleContractProbe').remove();true`);
  }
  for(const theme of ['dark','light'])for(const width of (process.argv.includes('--focused')?[1366]:[1366,1024,819,390])){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';__ops.workbench.setLeft(true);true`);await wait(250);
    if(!baseline){const overlaps=await ev(`(()=>{const nodes=[...document.querySelectorAll('.orderops-workbench-header #previewTabs button,.orderops-workbench-header > .header-actions > button')],rects=nodes.map(n=>n.getBoundingClientRect());return rects.some((a,i)=>rects.slice(i+1).some(b=>Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)));})()`);check(`${theme} ${width}: header buttons do not overlap`,!overlaps);}
    await shot(`${theme}-${width}`);
    if(!baseline){const bounds=await ev(`(()=>{const p=document.querySelector('#orderOpsFilePreparePane'),f=document.querySelector('#prepareApplyButton'),s=document.querySelector('#prepareDropSurface');return {body:document.documentElement.scrollWidth,work:p.parentElement.getBoundingClientRect().toJSON(),css:p.parentElement.style.cssText,pane:p.getBoundingClientRect().toJSON(),footer:f.getBoundingClientRect().toJSON(),surface:s.getBoundingClientRect().toJSON(),overflow:p.scrollWidth>p.clientWidth+1};})()`);report.checks.push({theme,width,bounds});check(`${theme} ${width}: no body/pane overflow and apply stays visible`,bounds.body<=width+1&&!bounds.overflow&&bounds.footer.bottom<=900&&bounds.footer.top>=bounds.pane.top&&bounds.surface.height>0);}
  }
  if(!baseline){
    await send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
    const kept=await ev(`JSON.stringify({work:__ops.state.workspace,prepared:__ops.state.preparedFiles[0]})`);
    await ev(`dropFiles([fixture('inventory'),new File(['not excel'],'unsupported.txt')])`);await until(()=>ev('__ops.state.preparedFiles.length===2&&!document.querySelector("#orderOpsFilePreparePane").matches("[aria-busy=true]")'),'multiple files');
    check('multiple-file drop preserves existing work/prepared item',kept===await ev(`JSON.stringify({work:__ops.state.workspace,prepared:__ops.state.preparedFiles[0]})`));
    check('mixed batch reports invalid file + valid prepared sheet',await ev(`document.querySelector('#prepareStatus').textContent.includes('unsupported.txt')&&document.querySelector('#prepareStatus').textContent.includes('1개 시트')`));
    check('new pending file not auto applied',await ev(`__ops.state.preparedFiles[1].dirty&&!__ops.state.preparedFiles[1].applied`));
    const off=await ev(`dropFiles([fixture('orders')],document.querySelector('#previewTable'))`);check('drop outside pane cannot navigate browser',off.dropPrevented&&off.overPrevented&&await ev('__ops.state.preparedFiles.length===2'));
    await ev(`dropFiles([new File([new Uint8Array(25*1024*1024+1)],'too-large.xlsx')])`);await until(()=>ev('document.querySelector("#prepareStatus").textContent.includes("too-large.xlsx")'),'size error');
    check('oversized file preserves pending preparation',await ev('__ops.state.preparedFiles.length===2&&__ops.state.preparedFiles[1].dirty'));
    check('text drag keeps native behavior',await ev(`(()=>{const dt=new DataTransfer();dt.setData('text/plain','입력 보존');const event=new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true});document.querySelector('#previewTable').dispatchEvent(event);return !event.defaultPrevented;})()`));
    await ev(`document.querySelector('#preparePaneClose').click();dropFiles([fixture('orders','reopen.xlsx')],document.querySelector('#preparePaneReopen'))`);await until(()=>ev('__ops.state.preparedFiles.length===3'),'reopen drop');
    check('reopen shortcut accepts files and retains pending files',await ev('!document.querySelector("#orderOpsFilePreparePane").hidden&&__ops.state.preparedFiles[1].dirty'));
    await send('Emulation.setEmulatedMedia',{media:'print'});check('prepare pane excluded from print',await ev(`getComputedStyle(document.querySelector('#orderOpsFilePreparePane')).display==='none'`));await send('Emulation.setEmulatedMedia',{media:''});
  }
  assert.deepEqual(report.errors,[]);report.result='passed';console.log('PASS PM-F09/PM-F10 browser checks',JSON.stringify(report.checks));
}catch(error){report.result='failed';report.error=error.stack;console.error(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(evidence,'verification.json'),JSON.stringify(report,null,2));socket?.close();if(browser?.pid){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else{spawnSync('pkill',['-TERM','-P',String(browser.pid)],{stdio:'ignore'});browser.kill('SIGTERM');}}server.closeAllConnections();await new Promise(r=>server.close(r));}
