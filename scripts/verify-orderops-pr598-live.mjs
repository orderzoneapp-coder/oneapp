import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verification-only branch. Never merge this one-off runner into main.
// The browser gets a fresh profile; synthetic files stay in that profile.
// Browser network permits static GET/HEAD only and blocks all server writes.
const origin='https://oneapp.orderz.co.kr';
const expectedCommit='732e2922b36d5cfaf057b14446bca1bea87971dc';
const out='test-artifacts/orderops-pr598-live';
mkdirSync(out,{recursive:true});
const report={expectedCommit,startedAt:new Date().toISOString(),files:[],checks:[],exceptions:[],blocked:[],result:'running'};
const hash=b=>createHash('sha256').update(b).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const profile=mkdtempSync(join(tmpdir(),'orderops-live-'));
let browser,socket;
const pending=new Map();let nextId=0;
async function until(fn,label){const end=Date.now()+35000;while(Date.now()<end){if(await fn())return;await wait(120);}throw Error('Timeout: '+label);}
function check(label,value){report.checks.push({label,pass:Boolean(value)});assert.ok(value,label);}
try{
  for(const path of ['orderops/list.html','orderops/workbench-v12.css']){
    const expected=readFileSync(path);
    const response=await fetch(`${origin}/${path}?verify=${expectedCommit}`,{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(25000)});
    const bytes=Buffer.from(await response.arrayBuffer());
    const result={path,url:response.url,status:response.status,expectedSha256:hash(expected),liveSha256:hash(bytes),bytes:bytes.length};
    report.files.push(result);console.log('LIVE_FILE',JSON.stringify(result));
    check(path+' returns HTTP 200',response.status===200);
    check(path+' matches deployed merge byte-for-byte',result.liveSha256===result.expectedSha256);
  }
  const command=n=>{const r=spawnSync('which',[n],{encoding:'utf8'});return r.status===0?r.stdout.trim():'';};
  const chrome=[process.env.CHROME_PATH,command('google-chrome'),command('chromium')].filter(Boolean).find(existsSync);
  assert.ok(chrome,'Chrome installed');
  browser=spawn(chrome,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  let port;await until(()=>{try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];return Boolean(port);}catch{return false;}},'Chrome port');
  const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl);
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},25000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  socket.onmessage=event=>{
    const m=JSON.parse(event.data);
    if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}
    if(m.method==='Runtime.exceptionThrown')report.exceptions.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});
    if(m.method==='Fetch.requestPaused'){
      const {requestId,request}=m.params;const url=new URL(request.url);
      const staticOrigin=url.origin===origin&&!url.pathname.startsWith('/api/');
      const staticCdn=['cdn.jsdelivr.net','fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname);
      const allowed=['GET','HEAD'].includes(request.method)&&(staticOrigin||staticCdn);
      if(!allowed)report.blocked.push({origin:url.origin,path:url.pathname,method:request.method});
      void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId}:{requestId,errorReason:'BlockedByClient'}).catch(()=>{});
    }
  };
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  const screenshot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name+'.png'),Buffer.from(r.data,'base64'));};
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`${origin}/orderops/list.html?verify=${expectedCommit}`});
  await until(()=>ev('Boolean(window.XLSX && document.querySelector("#prepareApplyButton") && document.querySelector("#prepareFileList"))'),'live app and XLSX ready');
  report.browser=await send('Browser.getVersion');
  report.page=await ev('({url:location.href,title:document.title,css:[...document.styleSheets].map(s=>s.href).filter(Boolean)})');
  check('live app loads the workbench stylesheet',report.page.css.some(x=>x.includes('orderops/workbench-v12.css')));
  await screenshot('live-empty');
  async function upload(kind,matrix){
    const name=`pr598-live-${kind}.xlsx`;
    await ev(`(()=>{const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(${JSON.stringify(matrix)}),'${kind==='orders'?'주문현황':'창고별재고'}');const t=new DataTransfer();t.items.add(new File([XLSX.write(w,{type:'array',bookType:'xlsx'})],${JSON.stringify(name)}));const input=document.querySelector('#${kind}Input');Object.defineProperty(input,'files',{configurable:true,value:t.files});input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await until(()=>ev(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(b=>b.textContent.includes(${JSON.stringify(name)}))?.querySelector('[data-prepare-state="READY"]'))`),name+' READY');
    await click('#prepareApplyButton');
    await until(()=>ev(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(b=>b.textContent.includes(${JSON.stringify(name)}))?.querySelector('[data-prepare-state="APPLIED"]'))`),name+' APPLIED');
  }
  const inventory=[['사용','품목코드','단위','품목명','규격','수량','1창고','3서울','4전송']];
  const orders=[['일자-No.','담당','창고','단위','품목코드','품목명','규격','수량','재고','단가','공급가액','적요','적요1','거래처','그룹']];
  for(const [index,unit] of ['BOX','EA','kg'].entries()){
    const code=`OPS-LIVE-${index+1}`;
    inventory.push(['Yes',code,unit,`운영 표시 검증 ${unit}`,unit,18,10,8,0]);
    [10,8,12].forEach((q,j)=>orders.push([`2026/09/13-${index*3+j+1}`,'','1창고',unit,code,`운영 표시 검증 ${unit}`,unit,q,0,1000,q*1000,'합성 검증','',`검증 거래처 ${j+1}`,`G-${index}-${j}`]));
  }
  await upload('inventory',inventory);await upload('orders',orders);await click('[data-preview="allocations"]');
  await ev('document.documentElement.dataset.nexusUiTheme="dark";true');
  await ev('document.fonts.ready.then(()=>true)');
  await until(()=>ev('document.querySelectorAll("#previewTable tbody tr[data-product-code]").length===9'),'nine real UI rows');
  async function colors(selector){return ev(`(()=>{const read=n=>{const c=getComputedStyle(n);return {color:c.color,fill:c.webkitTextFillColor,background:c.backgroundColor,text:n.textContent.trim()};};return [...document.querySelectorAll(${JSON.stringify(selector)}+' tbody tr[data-product-code]')].map(tr=>({code:tr.dataset.productCode,box:tr.classList.contains('box-unit-row'),cells:[...tr.cells].map(td=>({...read(td),children:[...td.querySelectorAll('input,span,button')].map(read)}))}));})()`);}
  const correct=rows=>rows.length===9&&rows.every(r=>{const expected=r.code==='OPS-LIVE-1'?'rgb(0, 0, 0)':'rgb(128, 0, 0)';return r.cells.every(c=>[c,...c.children].every(n=>n.color===expected&&n.fill===expected));});
  report.dark=await colors('#previewTable');
  check('live dark neutral cells are #D1D5DB',report.dark.every(r=>r.cells.every(c=>c.background==='rgb(209, 213, 219)')));
  check('live BOX text black, EA/kg text red, including editors',correct(report.dark));
  await screenshot('live-dark-with-synthetic-orders');
  for(const code of ['OPS-LIVE-1','OPS-LIVE-2','OPS-LIVE-3']){
    await ev(`(()=>{const row=document.querySelector('#previewTable tr[data-product-code="${code}"]');row.cells[0].click();row.querySelector('input')?.focus();return true;})()`);
    check(code+' selected/focused text colors persist',correct(await colors('#previewTable')));
  }
  await ev('window.print=()=>{};true');await click('#printButton');await send('Emulation.setEmulatedMedia',{media:'print'});
  report.print=await colors('#printArea');
  check('live F9 preserves BOX/non-BOX text colors',correct(report.print));
  check('live F9 neutral gray becomes white',report.print.every(r=>r.cells.every(c=>c.background==='rgb(255, 255, 255)')));
  report.borders=await ev(`(()=>{const table=document.querySelector('#printArea table');return {collapse:getComputedStyle(table).borderCollapse,spacing:getComputedStyle(table).borderSpacing,rows:[...table.tBodies[0].rows].map(tr=>[...tr.cells].map(td=>{const c=getComputedStyle(td);return {left:parseFloat(c.borderLeftWidth),right:parseFloat(c.borderRightWidth),bottom:parseFloat(c.borderBottomWidth),shadow:c.boxShadow};}))};})()`);
  check('live F9 continuous cell border model',report.borders.collapse==='separate'&&report.borders.spacing==='0px'&&report.borders.rows.every(r=>r[0].left>0&&r.every(c=>c.right>0&&c.bottom>0&&c.shadow==='none')));
  await ev('dispatchEvent(new Event("afterprint"));true');await send('Emulation.setEmulatedMedia',{media:'screen'});
  check('live screen colors survive print cancel',correct(await colors('#previewTable')));
  check('no uncaught app exceptions',report.exceptions.length===0);
  report.result='passed';console.log('LIVE_UI_PASS',report.checks.length);
}catch(error){report.result='failed';report.error=error.stack;console.error(error);process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();writeFileSync(join(out,'live-verification.json'),JSON.stringify(report,null,2));
  for(const p of pending.values())clearTimeout(p.timer);
  socket?.close();if(browser?.pid){spawnSync('pkill',['-TERM','-P',String(browser.pid)],{stdio:'ignore'});browser.kill('SIGTERM');}
}
