// Verification branch only. Loads unmodified production assets; no production login or transaction.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const root=process.cwd(), origin='https://oneapp.orderz.co.kr';
const release='5e9673a7da0170f9fbee02cc0f5bf1d125c955ef';
const dir=join(root,'evidence/pr648-production'); mkdirSync(dir,{recursive:true});
const downloads=join(dir,'downloads');mkdirSync(downloads,{recursive:true});
const result={release,origin,startedAt:new Date().toISOString(),assets:[],checks:[],blocked:[],exceptions:[],responses:[],status:'RUNNING',isolation:{freshProfile:true,credentialsUsed:false,productionTransactions:false}};
const persist=()=>writeFileSync(join(dir,'live-result.json'),JSON.stringify(result,null,2));
const hash=x=>createHash('sha256').update(x).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=40000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}await wait(120);}throw Error(label+' timed out'+(error?': '+error.message:''));}
class CDP {
 constructor(url){this.url=url;this.id=0;this.pending=new Map();this.events=new Map();}
 async connect(){this.ws=new WebSocket(this.url);this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else for(const f of this.events.get(m.method)||[])f(m.params);};await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 on(name,f){this.events.set(name,[...(this.events.get(name)||[]),f]);}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
}
let browser,cdp,profile;
try{
 assert.equal(readFileSync(join(root,'CNAME'),'utf8').trim(),'oneapp.orderz.co.kr');
 const diff=spawnSync('git',['diff','--exit-code',release,'--','smartinput','nexus','reference-data','orderq','app-manifest.json'],{encoding:'utf8'});assert.equal(diff.status,0,'verification checkout must preserve exact released runtime');
 const paths=readdirSync(join(root,'smartinput')).filter(n=>/\.(js|css|html|json)$/.test(n)).map(n=>'smartinput/'+n);
 paths.push('app-manifest.json','nexus/workspace.html','nexus/workspace.js','nexus/common/nexus-ui.js');
 for(let i=0;i<paths.length;i+=6) await Promise.all(paths.slice(i,i+6).map(async path=>{
  const expected=hash(readFileSync(join(root,path))); let last;
  for(let attempt=0;attempt<6;attempt++){
   try{const response=await fetch(origin+'/'+path+'?verify='+release+'-'+attempt,{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});const bytes=Buffer.from(await response.arrayBuffer());last={path,status:response.status,expected,actual:hash(bytes),bytes:bytes.length};if(response.ok&&last.actual===expected){result.assets.push(last);console.log('PASS live asset',path);return;}}catch(e){last={path,error:e.message};}
   await wait(5000);
  }throw Error('Production asset mismatch '+JSON.stringify(last));
 }));
 result.checks.push({name:'all SmartInput runtime assets match released checkout',status:'PASS',count:result.assets.length});persist();
 const found=spawnSync('which',['google-chrome'],{encoding:'utf8'});const executable=process.env.CHROME_PATH||(found.status===0?found.stdout.trim():'chromium');
 profile=mkdtempSync(join(tmpdir(),'pr648-live-'));
 browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 const port=await until(()=>{try{return readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{return null;}},'Chrome startup');
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');cdp=new CDP(target.webSocketDebuggerUrl);await cdp.connect();
 await Promise.all([cdp.send('Page.enable'),cdp.send('Runtime.enable'),cdp.send('Network.enable')]);
 cdp.on('Runtime.exceptionThrown',e=>result.exceptions.push(e.exceptionDetails?.exception?.description||e.exceptionDetails?.text));
 cdp.on('Network.responseReceived',e=>{if(e.response.url.startsWith(origin))result.responses.push({url:e.response.url,status:e.response.status});});
 cdp.on('Page.javascriptDialogOpening',()=>{void cdp.send('Page.handleJavaScriptDialog',{accept:false});});
 cdp.on('Fetch.requestPaused',async e=>{
  const u=new URL(e.request.url),method=e.request.method;
  const own=u.origin===origin&&(u.pathname.endsWith('/')||/\.(?:js|css|html|json|png|svg|ico|woff2?|ttf)$/.test(u.pathname));
  const xlsx=u.href==='https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
  const allow=['GET','HEAD'].includes(method)&&(own||xlsx);
  if(!allow)result.blocked.push({method,url:u.origin+u.pathname});
  try{await cdp.send(allow?'Fetch.continueRequest':'Fetch.failRequest',allow?{requestId:e.requestId}:{requestId:e.requestId,errorReason:'Aborted'});}catch{}
 });
 await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
 const click=s=>cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(s)});if(!e||e.disabled)throw Error('Unavailable control '+${JSON.stringify(s)});e.click();return true;})()`);
 const input=(s,v)=>cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(s)});if(!e)throw Error('Missing input '+${JSON.stringify(s)});e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(v)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
 const ready=()=>until(()=>cdp.eval(`Boolean(document.querySelector('#inputRows tr'))&&['product','customer'].every(n=>{const s=document.getElementById(n+'ReferenceStatus')?.dataset.status;return s&&s!=='LOADING';})`),'live UI readiness',60000);
 const mode=async m=>{await click('.mode-tab[data-mode="'+m+'"]');await until(()=>cdp.eval(`document.querySelector('.mode-tab.is-active')?.dataset.mode===${JSON.stringify(m)}`),'mode '+m);};
 const shot=async n=>{const p=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(dir,n+'.png'),Buffer.from(p.data,'base64'));};
 await cdp.send('Page.navigate',{url:origin+'/smartinput/'});await ready();
 assert.equal(await cdp.eval(`document.querySelector('script[type="module"][src*="smartinput.js"]').src.includes('v=0.17.0')`),true);
 for(const m of ['order','purchase','sale','estimate'])await mode(m);
 result.checks.push({name:'production entry and all four tabs',status:'PASS'});
 await shot('live-estimate-initial');
 await click('#addRowButton');
 await input('#inputRows tr[data-default-row="true"] [data-field="itemCode"]','PR648-0001');
 await input('#inputRows [data-field="itemName"]','격리검증상품');
 await input('#inputRows [data-field="quantity"]','2');
 await input('#inputRows [data-field="unitPrice"]','1000');
 await click('#completeButton');
 await until(()=>cdp.eval(`Boolean(document.querySelector('[data-estimate-name]'))`),'new estimate name dialog');
 await input('[data-estimate-name]','PR648 운영검증-격리');await click('[data-confirm-save]');
 await until(()=>cdp.eval(`document.querySelector('#catalogPickerList [data-select-estimate-card]')?.textContent.includes('PR648 운영검증-격리')&&!document.querySelector('#completeButton').disabled`),'estimate save');
 await input('#inputRows [data-field="unitPrice"]','1750');await click('#completeButton');
 await until(()=>cdp.eval(`!document.querySelector('#completeButton').disabled&&!document.querySelector('[data-estimate-name]')`),'same estimate save');
 const saved=await cdp.eval(`(async()=>{const s=await import('/smartinput/smartinput-data-store.js?v=0.15.0');return (await s.loadEstimateLibrary()).filter(r=>r.catalogName==='PR648 운영검증-격리'||r.draft?.header?.catalogName==='PR648 운영검증-격리').map(r=>({id:r.estimateId,rows:r.ownedRows||r.draft?.rows}));})()`);
 // Match by the unique isolated library when the application stores its title under another key.
 const library=await cdp.eval(`(async()=>{const s=await import('/smartinput/smartinput-data-store.js?v=0.15.0');return (await s.loadEstimateLibrary()).map(r=>({id:r.estimateId,rows:r.ownedRows||r.draft?.rows}));})()`);
 assert.equal(library.length,1);assert.equal(Number(library[0].rows.find(r=>r.itemCode==='PR648-0001').unitPrice),1750);
 result.checks.push({name:'new estimate and same-ID update persisted in isolated IndexedDB',status:'PASS',id:library[0].id,price:1750});
 await cdp.send('Page.reload',{ignoreCache:false});await ready();await mode('estimate');
 await until(()=>cdp.eval(`Boolean(document.querySelector('#catalogPickerList [data-select-estimate-card]'))`),'saved estimate list after reload');
 const has=await cdp.eval(`Boolean(document.querySelector('#inputRows [data-field="itemCode"]')?.value==='PR648-0001')`);
 if(!has)await click('#catalogPickerList [data-select-estimate-card]');
 await until(()=>cdp.eval(`document.querySelector('#inputRows [data-field="unitPrice"]')?.value==='1750'`),'saved price recovered');
 result.checks.push({name:'reload and saved estimate recovery',status:'PASS'});await shot('live-estimate-saved');
 const countFiles=()=>readdirSync(downloads).filter(f=>f.endsWith('.xlsx'));
 async function downloadReport(label){const before=new Set(countFiles());await click('#estimateExcelButton');const f=await until(()=>countFiles().find(f=>!before.has(f)),label+' workbook download',60000);return join(downloads,f);}
 const estimateFile=await downloadReport('estimate');
 const sandbox={console,Buffer,setTimeout,clearTimeout};sandbox.global=sandbox;sandbox.window=sandbox;sandbox.self=sandbox;vm.createContext(sandbox);vm.runInContext(readFileSync(join(root,'customer-master/vendor/xlsx.full.min.js'),'utf8'),sandbox);const XLSX=sandbox.XLSX;
 function readBook(file){const b=XLSX.read(readFileSync(file),{type:'buffer'});return {sheets:Array.from(b.SheetNames),rows:Object.fromEntries(b.SheetNames.map(n=>[n,XLSX.utils.sheet_to_json(b.Sheets[n],{header:1,defval:''})]))};}
 const eb=readBook(estimateFile);assert.ok(eb.sheets.includes('ERP업데이트'));assert.ok(eb.sheets.includes('쇼핑몰업로드'));assert.ok(JSON.stringify(eb.rows).includes('PR648-0001'));result.checks.push({name:'estimate report button, XLSX download and reopen',status:'PASS',sheets:eb.sheets});
 await mode('purchase');await click('#addRowButton');
 await input('#inputRows tr[data-default-row="true"] [data-field="itemCode"]','PR648-P001');
 await input('#inputRows [data-field="itemName"]','격리구매검증상품');await input('#inputRows [data-field="quantity"]','2');await input('#inputRows [data-field="unitPrice"]','3200');
 const purchaseFile=await downloadReport('purchase');const pb=readBook(purchaseFile);
 assert.deepEqual(pb.sheets,['확인요청','판매입력','전송출고','전송구매','거래처별','단가설정','구매 업로드']);assert.ok(JSON.stringify(pb.rows['구매 업로드']).includes('PR648-P001'));
 result.checks.push({name:'purchase report button, seven sheets and XLSX reopen',status:'PASS',sheets:pb.sheets});await shot('live-purchase-report');
 const writes=result.blocked.filter(x=>!['GET','HEAD'].includes(x.method));result.isolation.blockedWriteAttempts=writes.length;result.isolation.outboundWritesAllowed=0;
 assert.equal(result.exceptions.length,0,JSON.stringify(result.exceptions));
 const failures=result.responses.filter(x=>x.status>=400&&/\/smartinput\/.*\.(js|css)(\?|$)/.test(x.url));assert.deepEqual(failures,[],'no deployed SmartInput module load errors');
 result.status='PASS';
}catch(e){result.status='FAIL';result.error=e.stack;if(cdp)try{result.diagnostic=await cdp.eval(`({url:location.href,status:document.querySelector('#appStatus')?.textContent,toasts:[...document.querySelectorAll('[role="alert"],.toast')].map(e=>e.textContent),body:document.body.innerText.slice(-3500)})`);const s=await cdp.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(dir,'failure.png'),Buffer.from(s.data,'base64'));}catch{}process.exitCode=1;console.error(e.stack);
}finally{result.completedAt=new Date().toISOString();persist();if(cdp)try{await Promise.race([cdp.send('Browser.close'),wait(1500)]);}catch{}cdp?.ws?.close();if(browser&&browser.exitCode===null)browser.kill();if(profile&&profile.startsWith(resolve(tmpdir())+sep+'pr648-live-')){try{rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}}console.log(JSON.stringify({status:result.status,checks:result.checks,assetCount:result.assets.length,error:result.error}));}
