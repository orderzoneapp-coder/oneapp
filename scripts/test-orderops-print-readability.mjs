import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.env.ORDEROPS_READABILITY_DIR || (process.env.ORDEROPS_EVIDENCE_DIR && join(process.env.ORDEROPS_EVIDENCE_DIR,'print-readability')) || join(tmpdir(), 'orderops-print-readability-evidence'));
const baseline = process.env.ORDEROPS_READABILITY_BASELINE === '1';
const source = readFileSync(join(root,'orderops/list.html'),'utf8');
// Test-server-only observability; production source remains unchanged.
const html = source.replace('initializeLocalRecovery().then(loadOrderQSourceFromRoute)', 'globalThis.__inventoryColumnTest={state,renderResults,getPreviewDefinitions}; initializeLocalRecovery().then(loadOrderQSourceFromRoute)')
  .replace('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js','/customer-master/vendor/xlsx.full.min.js');
const report = { startedAt:new Date().toISOString(), head:process.env.GITHUB_SHA || 'local-verified-pages-snapshot', baseline:baseline||null, htmlSha256:createHash('sha256').update(source).digest('hex'), checks:[], errors:[], blocked:[], result:'running' };
mkdirSync(evidence,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=resolve(root,'.'+pathname);if(!file.startsWith(resolve(root)+sep)||!existsSync(file)||!statSync(file).isFile())return res.writeHead(404).end();res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(pathname==='/orderops/list.html'?html:readFileSync(file));});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await wait(80);}throw Error('Timeout: '+label);}
const profile=mkdtempSync(join(tmpdir(),'orderops-inventory-columns-'));
let browser,socket;
try {
  const command=name=>{const r=spawnSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8',windowsHide:true});return r.status===0?r.stdout.trim().split(/\r?\n/)[0]:'';};
  const exe=[process.env.CHROME_PATH,process.env.PROGRAMFILES&&join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),command('google-chrome'),command('chromium')].filter(Boolean).find(existsSync);
  assert.ok(exe,'Chrome required');
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;
  browser=spawn(exe,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let port;await until(()=>{try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];return Boolean(port);}catch(e){if(!['ENOENT','EBUSY'].includes(e.code))throw e;return false;}},'browser port');
  const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl);const pending=new Map();let next=0;
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening')void send('Page.handleJavaScriptDialog',{accept:true});if(m.method==='Fetch.requestPaused'){const {requestId,request}=m.params;const allow=request.url.startsWith(origin+'/')&&['GET','HEAD'].includes(request.method);if(!allow)report.blocked.push({url:request.url,method:request.method});void send(allow?'Fetch.continueRequest':'Fetch.failRequest',allow?{requestId}:{requestId,errorReason:'BlockedByClient'});}};
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(evidence,name+'.png'),Buffer.from(r.data,'base64'));};
  const check=(label,value)=>{report.checks.push({label,pass:Boolean(value)});if(!baseline)assert.ok(value,label);};
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
  report.browser=await send('Browser.getVersion'); report.cssSha256=createHash('sha256').update(readFileSync(join(root,'orderops/workbench-v12.css'))).digest('hex');
  await send('Page.navigate',{url:origin+'/orderops/list.html'});
  await until(()=>ev('Boolean(globalThis.__inventoryColumnTest?.state.db && globalThis.XLSX)'), 'ready');
  async function upload(kind,matrix){const name=`columns-${kind}.xlsx`;await ev(`(()=>{const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(${JSON.stringify(matrix)}),'${kind==='orders'?'주문현황':'창고별재고'}');const t=new DataTransfer();t.items.add(new File([XLSX.write(w,{type:'array',bookType:'xlsx'})],'${name}'));const input=document.querySelector('#${kind}Input');Object.defineProperty(input,'files',{configurable:true,value:t.files});input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await until(()=>ev(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(b=>b.textContent.includes('${name}'))?.querySelector('[data-prepare-state="READY"]'))`),name+' READY');await click('#prepareApplyButton');await until(()=>ev(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(b=>b.textContent.includes('${name}'))?.querySelector('[data-prepare-state="APPLIED"]'))`),name+' APPLIED');}
  // Isolated synthetic profile. File preparation, applying files, editing and
  // the F9 action use the real app. Only view/color preferences are seeded.
  const inventory=[['사용','품목코드','단위','품목명','규격','수량','1창고','3서울','4전송']];
  const orders=[['일자-No.','담당','창고','단위','품목코드','품목명','규격','수량','재고','단가','공급가액','적요','적요1','거래처','그룹']];
  const managers=['민트담당','노랑담당','분홍담당','진한색담당',''];
  const palette={'민트담당':'#ccfbf1','노랑담당':'#fef3c7','분홍담당':'#fce7f3','진한색담당':'#102030'};
  const units=['BOX','EA','소분','kg','1kg','단',''];
  const unitByCode=new Map();
  for(let group=0;group<30;group++){
    const code=`PRINT-${String(group+1).padStart(3,'0')}`;
    const unit=units[group%units.length];
    unitByCode.set(code,unit);
    inventory.push(['Yes',code,unit,`인쇄 검증상품 ${group+1}`,unit,18,10,8,0]);
    [10,8,12].forEach((quantity,line)=>{
      orders.push([`2026/09/13-${String(group*3+line+1).padStart(3,'0')}`,managers[(group*3+line)%managers.length],'1창고',unit,code,`인쇄 검증상품 ${group+1}`,unit,quantity,0,1000,quantity*1000,'일반 적요',line===1?'':'전달사항',`거래처 ${line+1}`,`G-${group}-${line}`]);
    });
  }
  await upload('inventory',inventory);await upload('orders',orders);
  await click('[data-preview="allocations"]');
  await ev(`(()=>{
    const {state:s,getPreviewDefinitions,renderResults}=__inventoryColumnTest;
    s.managerColorSettings.colors=${JSON.stringify(palette)};
    const columns=getPreviewDefinitions(s.workspace).allocations.columns;
    const roles=['productAggregateQuantity','productName','specification','orderQuantity','warehouseQuantity','purchase','customer','unitPrice','deliveryNotice'];
    const keys=roles.flatMap(role=>columns.filter(c=>c.role===role || (role==='deliveryNotice' && c.orderField==='deliveryNotice')).map(c=>c.key));
    s.columnOrderSettings.tabs.allocations=keys;
    s.hiddenColumnSettings.tabs.allocations=columns.filter(c=>!keys.includes(c.key)).map(c=>c.key);
    renderResults();return true;
  })()`);
  await click('#preparePaneClose');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await ev('document.fonts.ready.then(()=>true)');
  const captureState=()=>ev(`(()=>{const {state:s}=__inventoryColumnTest;return JSON.stringify({workspace:s.workspace,search:s.searchQuery,sort:s.sortSettings,hidden:s.hiddenColumnSettings,order:s.columnOrderSettings,colors:s.managerColorSettings});})()`);
  async function metrics(){return ev(`(()=>{
    const host=document.querySelector('#previewTable'),table=host.querySelector('table');
    const read=n=>{const c=getComputedStyle(n);return {text:n.textContent.trim(),color:c.color,textFill:c.webkitTextFillColor,background:c.backgroundColor,shadow:c.boxShadow};};
    return {theme:document.documentElement.dataset.nexusUiTheme,headers:[...table.querySelectorAll('thead .column-header-label')].map(n=>n.textContent),
      rows:[...table.querySelectorAll('tbody tr')].map(tr=>({code:tr.dataset.productCode,manager:tr.classList.contains('manager-color-row'),cells:[...tr.cells].map(td=>({...read(td),children:[...td.querySelectorAll('input,span,button')].map(read)}))})),
      body:document.documentElement.scrollWidth,viewport:innerWidth,
      host:{left:host.getBoundingClientRect().left,right:host.getBoundingClientRect().right},
      panel:{left:document.querySelector('#resultsPanel').getBoundingClientRect().left,right:document.querySelector('#resultsPanel').getBoundingClientRect().right}};
  })()`);}
  for(const theme of ['light','dark']){
    await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';true`);
    const m=await metrics();report[theme]=m;
    check(`${theme}: order aggregate and individual order columns remain visible`,m.headers[0]==='합계'&&m.headers.includes('주문')&&m.rows.length===90);
    check(`${theme}: per-product order sum is once, not duplicated`,m.rows.filter(r=>r.cells[0].text==='30').length===30&&m.rows.filter(r=>r.cells[0].text==='').length===60);
    await shot('order-table-'+theme);
  }
  const rowColorsCorrect=rows=>rows.every(row=>{
    assert.ok(unitByCode.has(row.code),'known source row for color assertion');
    const expected=unitByCode.get(row.code)==='BOX'?'rgb(0, 0, 0)':'rgb(128, 0, 0)';
    return row.cells.every(cell=>[cell,...(cell.children||[])].every(node=>node.color===expected&&node.textFill===expected));
  });
  const dark=report.dark;
  check('dark neutral body uses gray surface',dark.rows.filter(r=>!r.manager).every(r=>r.cells.every(c=>c.background==='rgb(209, 213, 219)')));
  check('dark BOX rows are black; every other unit row and editor is red',rowColorsCorrect(dark.rows));
  // Resolve color-mix to sRGB with the browser's canvas rather than assuming
  // getComputedStyle serializes every color as rgb().
  const contrasts=await ev(`(()=>{
    const ctx=document.createElement('canvas').getContext('2d');
    const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
    const lum=color=>rgb(color).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
    return [...document.querySelectorAll('#previewTable tbody td')].map(n=>{const c=getComputedStyle(n),a=lum(c.color),b=lum(c.backgroundColor);return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),box:n.closest('tr').classList.contains('box-unit-row')};});
  })()`);
  // User-requested red text: WCAG AA 4.5:1; retain the 7:1 check for black BOX text.
  // https://www.w3.org/TR/WCAG22/#contrast-minimum
  report.minimumContrast=Math.min(...contrasts.map(c=>c.ratio));
  report.minimumBoxContrast=Math.min(...contrasts.filter(c=>c.box).map(c=>c.ratio));
  check('dark red/black text contrast at least 4.5:1 for every cell and assigned palette',report.minimumContrast>=4.5);
  check('dark black BOX text retains at least 7:1 contrast',report.minimumBoxContrast>=7);
  check('manager identification remains distinct',new Set(dark.rows.filter(r=>r.manager).map(r=>r.cells[0].background)).size>=4&&dark.rows.filter(r=>r.manager).every(r=>r.cells[0].shadow!=='none'));
  for(let index=0;index<units.length;index++){
    const code=`PRINT-${String(index+1).padStart(3,'0')}`;
    await ev(`(()=>{const selector='#previewTable tr[data-product-code="${code}"]';document.querySelector(selector+' td').click();document.querySelector(selector+' .order-edit-input').focus();return true;})()`);
    check(`selected/focused ${units[index]||'blank unit'} row keeps its unit text color`,rowColorsCorrect((await metrics()).rows));
  }
  for(const width of [1366,1024,819,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const m=await metrics();check(`dark ${width}: horizontal scrolling stays inside central panel`,m.body<=m.viewport+1&&m.host.left>=m.panel.left-1&&m.host.right<=m.panel.right+1);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
  await ev(`(()=>{const p=document.querySelector('#previewTable');p.scrollTop=137;p.scrollLeft=27;return true;})()`);
  const scrollBefore=await ev(`(()=>{const p=document.querySelector('#previewTable');return [p.scrollTop,p.scrollLeft];})()`);
  const baselineData=await captureState();
  // window.print is the only substituted browser API: the real button builds
  // printArea; CDP then produces a paginated PDF. No physical printer is used.
  await ev(`window.__nativePrint=window.print;window.print=()=>{};true`);
  for(const background of [true,false]){
    await click('#printButton');
    await send('Emulation.setEmulatedMedia',{media:'print'});
    const p=await ev(`(()=>{const t=document.querySelector('#printArea table'),s=getComputedStyle(t),read=n=>{const c=getComputedStyle(n);return {text:n.textContent.trim(),color:c.color,textFill:c.webkitTextFillColor,position:c.position,borders:['Top','Right','Bottom','Left'].map(side=>({width:parseFloat(c['border'+side+'Width']),style:c['border'+side+'Style'],color:c['border'+side+'Color']})),background:c.backgroundColor,shadow:c.boxShadow};};return {collapse:s.borderCollapse,spacing:s.borderSpacing,headers:[...t.querySelectorAll('thead th')].map(read),rows:[...t.querySelectorAll('tbody tr')].map(tr=>({code:tr.dataset.productCode,manager:tr.classList.contains('manager-color-row'),cells:[...tr.cells].map(read)}))};})()`);
    report['print-'+background]=p;
    check(`print ${background}: BOX black / every non-BOX unit red`,rowColorsCorrect(p.rows));
    const pdf=await send('Page.printToPDF',{printBackground:background,preferCSSPageSize:true,displayHeaderFooter:false});
    writeFileSync(join(evidence,`order-table-background-${background?'on':'off'}.pdf`),Buffer.from(pdf.data,'base64'));
    await ev(`dispatchEvent(new Event('afterprint'));true`);
    await send('Emulation.setEmulatedMedia',{media:'screen'});
    check(`print ${background}: independent continuous cell borders`,p.collapse==='separate'&&p.spacing==='0px');
    check(`print ${background}: repeated header is static with complete edges`,p.headers.every(c=>c.position==='static'&&c.borders[0].width>0&&c.borders[1].width>0&&c.borders[2].width>0)&&p.headers[0].borders[3].width>0);
    check(`print ${background}: blank aggregate cells keep border on every row`,p.rows.every(r=>r.cells.every(c=>c.borders[1].width>0&&c.borders[2].width>0&&c.shadow==='none')&&r.cells[0].borders[3].width>0));
    check(`print ${background}: screen-only gray becomes white paper`,p.rows.filter(r=>!r.manager).every(r=>r.cells.every(c=>c.background==='rgb(255, 255, 255)')));
    check(`print ${background}: original manager print colors preserved`,new Set(p.rows.filter(r=>r.manager).map(r=>r.cells[0].background)).size>=4);
    check(`print ${background}: all 90 rows and 30 order sums are preserved`,p.rows.length===90&&p.rows.filter(r=>r.cells[0].text==='30').length===30&&p.rows.filter(r=>r.cells[0].text==='').length===60);
  }
  await ev(`window.print=window.__nativePrint;delete window.__nativePrint;true`);
  check('print cancel restores dark screen and scroll',await ev(`(()=>{const p=document.querySelector('#previewTable');return !document.body.classList.contains('printing-table')&&document.documentElement.dataset.nexusUiTheme==='dark'&&p.scrollTop===${scrollBefore[0]}&&p.scrollLeft===${scrollBefore[1]};})()`));
  check('print does not change work, order quantity, stored colors or view settings',(await captureState())===baselineData);
  await shot('order-table-after-print');
  assert.deepEqual(report.errors,[]);
  report.result=baseline?'baseline-captured':'passed';
  console.log('OrderOps print/readability',report.result,'checks',report.checks.length,'minimum contrast',report.minimumContrast);
}catch(error){report.error=error.stack;report.result='failed';console.error(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(evidence,'print-readability-result.json'),JSON.stringify(report,null,2));socket?.close();if(browser?.pid){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else{spawnSync('pkill',['-TERM','-P',String(browser.pid)],{stdio:'ignore'});browser.kill('SIGTERM');}}server.closeAllConnections();await new Promise(r=>server.close(r));}
