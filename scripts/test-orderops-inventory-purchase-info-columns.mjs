import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.env.ORDEROPS_EVIDENCE_DIR || join(tmpdir(), 'orderops-inventory-columns-evidence'));
const baseline = process.env.ORDEROPS_INVENTORY_BASELINE_REF;
const source = baseline ? execFileSync('git',['show',`${baseline}:orderops/list.html`],{cwd:root,encoding:'utf8'}) : readFileSync(join(root,'orderops/list.html'),'utf8');
// Local response-only observability; uploads, edits, analysis and DataOps loading use UI handlers.
const html = source.replace('initializeLocalRecovery().then(loadOrderQSourceFromRoute)', 'globalThis.__inventoryColumnTest={state,renderResults,getPreviewDefinitions}; initializeLocalRecovery().then(loadOrderQSourceFromRoute)')
  .replace('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js','/customer-master/vendor/xlsx.full.min.js');
const report = { startedAt:new Date().toISOString(), head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), baseline:baseline||null, htmlSha256:createHash('sha256').update(source).digest('hex'), checks:[], errors:[], blocked:[], result:'running' };
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
  const informationShot=async name=>{const left=await ev(`(()=>{const p=document.querySelector('#previewTable'),left=p.scrollLeft;p.scrollLeft=p.scrollWidth;return left;})()`);await wait(50);await shot(name);await ev(`document.querySelector('#previewTable').scrollLeft=${left};true`);};
  const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);};
  await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});await send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
  report.browser=await send('Browser.getVersion');report.profile=profile;
  await send('Page.navigate',{url:origin+'/orderops/list.html'});
  await until(()=>ev('Boolean(globalThis.__inventoryColumnTest?.state.db && globalThis.XLSX)'),'ready');
  const inventory=[['사용','품목코드','단위','품목명','규격','수량','1창고','2전송','3서울','4전송','7진영','기본','전송','창고'],['Yes','INV-001','EA','부족 상품','EA',4,4,'','','','','','',''],['Yes','INV-002','EA','충분 상품','EA',20,20,'','','','','','',''],['Yes','INV-003','EA','재고만 상품','EA',8,8,'','','','','','','']];
  const orders=[['일자-No.','담당','창고','단위','품목코드','품목명','규격','수량','재고','단가','공급가액','적요','적요1','거래처','그룹'],['2026/09/13-001','김담당','1창고','EA','INV-001','부족 상품','EA',10,0,1000,10000,'일반 A','직원 A','거래처 A','A'],['2026/09/13-002','박담당','1창고','EA','INV-002','충분 상품','EA',10,0,2000,20000,'일반 B','직원 B','거래처 B','B']];
  async function upload(kind,matrix){const name=`columns-${kind}.xlsx`;await ev(`(()=>{const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(${JSON.stringify(matrix)}),'${kind==='orders'?'주문현황':'창고별재고'}');const t=new DataTransfer();t.items.add(new File([XLSX.write(w,{type:'array',bookType:'xlsx'})],'${name}'));const input=document.querySelector('#${kind}Input');Object.defineProperty(input,'files',{configurable:true,value:t.files});input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);await until(()=>ev(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(b=>b.textContent.includes('${name}'))?.querySelector('[data-prepare-state="READY"]'))`),name+' READY');await click('#prepareApplyButton');await until(()=>ev(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(b=>b.textContent.includes('${name}'))?.querySelector('[data-prepare-state="APPLIED"]'))`),name+' APPLIED');}
  const purchase='shipping:inventory:purchase', info='shipping:inventory:order-information';
  async function columns(label){const m=await ev(`(()=>{const t=document.querySelector('table.preview-inventory');return {headers:[...t.querySelectorAll('thead .column-header-label')].map(n=>n.textContent),keys:[...t.querySelectorAll('col')].map(n=>n.dataset.columnKey),information:[...t.querySelectorAll('td.information-value')].map(n=>n.textContent.trim()),editors:[...t.querySelectorAll('.purchase-input')].map(n=>({code:n.dataset.purchaseCode,value:n.value}))}})()`);assert.equal(m.keys.filter(k=>k===purchase).length,1,label+' purchase unique');assert.equal(m.keys.filter(k=>k===info).length,1,label+' info unique');assert.equal(m.headers.indexOf('구매'),m.headers.indexOf('구분')+1);assert.equal(m.headers.indexOf('정보'),m.headers.indexOf('적요')-1);report.checks.push({label,...m});return m;}
  // Keep legacy meanings distinct: inventory has aggregate order / remaining;
  // order lines have product aggregate (합계) / individual quantity (주문).
  async function quantityCells(label, tab, expected) {
    const roles = tab === 'inventory'
      ? ['orderQuantity', 'calculatedQuantity']
      : ['productAggregateQuantity', 'orderQuantity'];
    const labels = tab === 'inventory' ? ['주문', '잔량'] : ['합계', '주문'];
    const result = await ev(`(() => {
      const {state, getPreviewDefinitions} = __inventoryColumnTest;
      const preview = getPreviewDefinitions(state.workspace)[${JSON.stringify(tab)}];
      const table = document.querySelector('table.preview-${tab}');
      const keys = [...table.querySelectorAll('col')].map(n => n.dataset.columnKey);
      const headers = [...table.querySelectorAll('thead .column-header-label')].map(n => n.textContent);
      const columns = ${JSON.stringify(roles)}.map(role => preview.columns.filter(c => c.role === role));
      const rows = [...table.querySelectorAll('tbody tr[data-product-code]')]
        .filter(row => row.dataset.productCode).map(row => ({
          code: row.dataset.productCode,
          values: columns.map(matches => {
            const index = keys.indexOf(matches[0]?.key);
            const cell = index < 0 ? null : row.children[index];
            return cell ? (cell.querySelector('input')?.value ?? cell.textContent.trim()) : null;
          })
        }));
      return {keys, headers, columns, rows};
    })()`);
    result.columns.forEach((matches, index) => {
      assert.equal(matches.length, 1, `${label}: one ${roles[index]} model column`);
      const column = matches[0];
      assert.equal(column.header, labels[index], `${label}: legacy header`);
      assert.equal(column.numeric, true, `${label}: numeric column`);
      assert.equal(result.keys.filter(key => key === column.key).length, 1, `${label}: visible stable key`);
      assert.equal(result.headers.filter(header => header === labels[index]).length, 1, `${label}: unique visible header`);
      if (tab === 'inventory' && index === 0) assert.equal(column.key, 'shipping:inventory:order-quantity');
    });
    // Blank aggregate cells must stay blank, not become another copy or zero.
    const values = result.rows.map(row => [row.code, ...row.values.map(value => {
      assert.notEqual(value, null, `${label}: rendered quantity cell exists`);
      return value === '' ? '' : Number(String(value).replace(/,/g, ''));
    })]);
    assert.deepEqual(values.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      expected.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), `${label}: displayed quantities`);
    report.checks.push({label, quantityColumns: result.columns, quantityRows: values});
  }
  await upload('inventory',inventory);await click('[data-preview="inventory"]');
  const only=await columns('inventory-only before analysis');check('inventory-only information blank and purchase editable',only.information.every(s=>s==='')&&only.editors.length===3);
  await quantityCells('inventory-only quantities', 'inventory', [['INV-001',0,4],['INV-002',0,20],['INV-003',0,8]]);
  check('no orders cannot create purchase upload',await ev('ShippingManagementEngine.getFinalPurchaseUploadSelection(__inventoryColumnTest.state.workspace).included.length===0 && document.querySelector("#downloadButton").disabled'));
  await upload('orders',orders);await click('[data-preview="inventory"]');
  const before=await columns('orders + inventory before analysis');check('order information customer / quantity / unit price',before.information.some(s=>s.includes('거래처 A')&&s.includes('10')&&s.includes('1,000')));
  await quantityCells('pre-analysis inventory quantities', 'inventory', [['INV-001',10,-6],['INV-002',10,10],['INV-003',0,8]]);
  check('before analysis official outputs remain blocked',await ev('document.querySelector("#downloadButton").disabled && document.querySelector("#headerCloudSaveButton").disabled && ShippingManagementEngine.getFinalPurchaseUploadSelection(__inventoryColumnTest.state.workspace).included.length===0'));
  const inputPurchase=async(code,value)=>ev(`(()=>{const n=document.querySelector('.purchase-input[data-purchase-code="${code}"]');n.focus();n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await inputPurchase('INV-001','분석전 구매처');await inputPurchase('INV-002','충분 구매처');await inputPurchase('INV-003','재고전용 구매처');
  await click('[data-preview="allocations"]');await click('[data-preview="inventory"]');
  await ev(`(()=>{const n=document.querySelector('#tableSearchInput');n.focus();n.value='INV-001';n.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);await wait(220);await click('#tableSearchClearButton');
  await click(`.column-sort-trigger[data-sort-column-key="${purchase}"]`);await click('[data-sort-direction="desc"]');
  await ev('__inventoryColumnTest.renderResults();true');
  check('purchase survives tabs / search / sorting / rerender',await ev(`document.querySelector('.purchase-input[data-purchase-code="INV-001"]').value==='분석전 구매처'`));
  await click('#preparePaneClose');await click('#preparePaneReopen');await click('#inventoryInspectorReopen');await click('#inventoryInspectorClose');
  check('purchase survives panel close and reopen',await ev(`document.querySelector('.purchase-input[data-purchase-code="INV-001"]').value==='분석전 구매처'`));
  for(const theme of ['light','dark']){await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';true`);await shot('before-analysis-'+theme);await informationShot('before-analysis-information-'+theme);}
  await click('#analyzeButton');await until(()=>ev('__inventoryColumnTest.state.workspace.workspaceMode!==ShippingManagementEngine.PREVIEW_WORKSPACE_MODE && !document.querySelector("#downloadButton").disabled'),'analysis complete');await click('[data-preview="inventory"]');
  const after=await columns('after analysis');check('analysis retains purchase inputs',after.editors.find(r=>r.code==='INV-001')?.value==='분석전 구매처');
  await quantityCells('post-analysis inventory quantities', 'inventory', [['INV-001',10,-6],['INV-002',10,10],['INV-003',0,8]]);
  for(const theme of ['light','dark']){await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';true`);await informationShot('after-analysis-information-'+theme);}
  const selection=await ev('ShippingManagementEngine.getFinalPurchaseUploadSelection(__inventoryColumnTest.state.workspace)');assert.deepEqual(selection.included.map(r=>[r.productCode,r.purchaseNeed]),[['INV-001',6]]);check('F10 sufficient and inventory-only rows excluded',!selection.included.some(r=>['INV-002','INV-003'].includes(r.productCode)));
  // Settings use actual menu and native header drag events with the stable keys.
  await click('#tableSettingsButton');await click('#columnVisibilityButton');
  await ev(`(()=>{const n=document.querySelector('[data-column-visible="${purchase}"]');n.checked=false;n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await click('[data-preview="allocations"]');await click('[data-preview="inventory"]');
  check('explicit hidden purchase key respected across render',await ev(`!document.querySelector('table.preview-inventory col[data-column-key="${purchase}"]')`));
  await ev(`(()=>{const n=document.querySelector('[data-column-visible="${purchase}"]');n.checked=true;n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await ev(`(()=>{const a=document.querySelector('th[data-column-drag-key="${info}"]'),b=document.querySelector('th[data-column-drag-key="${purchase}"]'),dt=new DataTransfer();a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));b.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:b.getBoundingClientRect().left}));a.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));return true;})()`);
  await click('[data-preview="allocations"]');await click('[data-preview="inventory"]');
  check('explicit column order saved with stable keys',await ev(`(()=>{const keys=[...document.querySelectorAll('table.preview-inventory col')].map(n=>n.dataset.columnKey);return keys.indexOf('${info}')<keys.indexOf('${purchase}');})()`));
  await ev(`document.querySelector('[data-reset-column-order]').click();true`);
  for(const theme of ['light','dark'])for(const width of [1366,1024,819,390]){await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';true`);await wait(130);const m=await ev(`(()=>{const p=document.querySelector('#previewTable'),r=p.getBoundingClientRect(),w=document.querySelector('#resultsPanel').getBoundingClientRect(),n=p.querySelector('.purchase-input[data-purchase-code="INV-001"]'),td=n.closest('td'),badge=p.querySelector('[data-substitute-order-row]');return {body:document.documentElement.scrollWidth,viewport:innerWidth,left:r.left,right:r.right,paneLeft:w.left,paneRight:w.right,scroll:p.scrollWidth>p.clientWidth,input:getComputedStyle(n).color,inputBackground:getComputedStyle(n).backgroundColor,row:getComputedStyle(td.parentElement).backgroundColor,negative:n.dataset.negativeBalance,badge:badge&&getComputedStyle(badge).color,value:n.value}})()`);check(`${theme}/${width} table scroll contained`,m.body<=m.viewport+1&&m.left>=m.paneLeft-1&&m.right<=m.paneRight+1&&m.scroll);check(`${theme}/${width} purchase/badge readable and preserved`,m.value==='분석전 구매처'&&Boolean(m.badge)&&m.input!=='rgba(0, 0, 0, 0)'&&m.negative==='true');report.checks.push({theme,width,styles:m});await shot(`after-analysis-${theme}-${width}`);}
  await send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false});
  await ev(`document.querySelector('tr[data-product-code="INV-001"] button[data-substitute-order-row]').click();true`);check('information badge selects existing order',await ev('document.querySelectorAll(".substitution-selected").length===1'));
  await ev(`document.querySelector('[data-substitution-target-product="INV-002"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}));true`);
  await until(()=>ev(`document.querySelectorAll('.substitution-selected').length===0 && document.querySelector('[data-substitution-target-product="INV-002"]').textContent.includes('거래처 A')`),'Ctrl target substitution');check('existing substitution history recorded',await ev('__inventoryColumnTest.state.workspace.substitutionHistory.events.length>0'));
  // Real DataOps apply UI; only its read-only HTTP response is synthetic.
  const canonical={schemaVersion:'ONEAPP_DATAOPS_SNAPSHOT_V1',basisDate:'2026-09-13',columns:['단위','품목코드','품명','규격','재고','기록','거래','구매가','기본','적요','행사가'],rows:[['EA','INV-002','충분 상품','EA',7,'LOT-1','',0,0,'',0]]};
  const snapshot={...canonical,revision:'INV-COLS-1',savedAt:'2026-09-13T01:00:00.000Z',hash:createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),rowCount:1,cellCount:11};
  await ev(`(()=>{document.querySelector('#cloudUrlInput').value='https://script.google.com/macros/s/inventory-columns-fixture/exec';const native=window.fetch;window.fetch=async(url,options)=>{if(!String(url).includes('inventory-columns-fixture'))return native(url,options);const p=JSON.parse(options.body);if(p.action!=='dataops_snapshot_get')throw Error('unexpected fixture action '+p.action);return new Response(JSON.stringify({status:'success',action:p.action,data:${JSON.stringify(snapshot)}}),{status:200,headers:{'Content-Type':'application/json'}});};return true;})()`);
  await click('#inventoryMenuButton');await click('#inventoryDataOpsLoadButton');await until(()=>ev('__inventoryColumnTest.state.workspace.inventoryApplicationMode==="TOTAL_ONLY" && !__inventoryColumnTest.state.inventoryApplyBusy'),'TOTAL_ONLY apply');await click('[data-preview="inventory"]');
  const total=await columns('TOTAL_ONLY');check('TOTAL_ONLY purchase read only and upload empty',total.editors.length===0&&await ev('ShippingManagementEngine.getFinalPurchaseUploadSelection(__inventoryColumnTest.state.workspace).included.length===0'));
  check('TOTAL_ONLY information read only',await ev(`document.querySelectorAll('.preview-inventory button[data-substitute-order-row],.preview-inventory [data-substitution-target-product]').length===0 && document.querySelector('.preview-inventory .order-information-badge').textContent.includes('거래처')`));
  await quantityCells('TOTAL_ONLY quantities stay readable', 'inventory', [['INV-002',20,-13]]);
  await shot('total-only');
  await click('#workbenchResetButton');await until(()=>ev('!__inventoryColumnTest.state.workspace'),'reset synthetic work');
  await upload('orders',orders);await click('[data-preview="inventory"]');
  check('unapplied inventory stays empty without fake product rows or purchase inputs',await ev(`document.querySelectorAll('.preview-inventory tr[data-product-code]:not([data-product-code=""]),.preview-inventory .purchase-input').length===0 && __inventoryColumnTest.state.workspace.inventory.length===0 && !__inventoryColumnTest.state.workspace.previewDataState.inventory && document.querySelector('#previewTable').textContent.includes('재고 자료 미적용')`));
  // Three customers ordering one product: 합계 is 30, never money or stock 18.
  // All mutations below are real UI operations inside the isolated fixture profile.
  await click('#workbenchResetButton');await until(()=>ev('!__inventoryColumnTest.state.workspace'),'reset aggregate fixture');
  const aggregateOrders = [orders[0], ...[10,8,12].map((quantity,index) => {
    const row = [...orders[1]];
    row[0] = `2026/09/13-10${index}`; row[7] = quantity;
    row[10] = quantity * 1000; row[13] = `합계 거래처 ${index+1}`; row[14] = `TOTAL-${index}`;
    return row;
  })];
  const aggregateInventory = inventory.map(row => [...row]);
  aggregateInventory[1][5] = 18; aggregateInventory[1][6] = 18;
  await upload('inventory',aggregateInventory);await upload('orders',aggregateOrders);
  const lineQuantities = [['INV-001',30,10],['INV-001','',8],['INV-001','',12]];
  await click('[data-preview="allocations"]');
  await quantityCells('pre-analysis order aggregate is sum of order quantities', 'allocations', lineQuantities);
  await shot('before-analysis-order-aggregate');
  await click('[data-preview="inventory"]');
  await quantityCells('three-customer inventory aggregate / remaining', 'inventory', [['INV-001',30,-12],['INV-002',0,20],['INV-003',0,8]]);
  await shot('before-analysis-inventory-order-remaining');
  check('quantity displays do not enable preview output', await ev('document.querySelector("#downloadButton").disabled && document.querySelector("#headerCloudSaveButton").disabled'));
  await inputPurchase('INV-001','합계 검증 구매처');
  await click('#analyzeButton');await until(()=>ev('__inventoryColumnTest.state.workspace.workspaceMode!==ShippingManagementEngine.PREVIEW_WORKSPACE_MODE && !document.querySelector("#downloadButton").disabled'),'aggregate analysis complete');
  await click('[data-preview="allocations"]');
  await quantityCells('post-analysis order aggregate unchanged', 'allocations', lineQuantities);
  await shot('after-analysis-order-aggregate');
  await click('[data-preview="inventory"]');
  await quantityCells('post-analysis inventory aggregate / remaining unchanged', 'inventory', [['INV-001',30,-12],['INV-002',0,20],['INV-003',0,8]]);
  check('aggregate fixture preserves purchase input', await ev(`document.querySelector('.purchase-input[data-purchase-code="INV-001"]').value==='합계 검증 구매처'`));
  assert.deepEqual(await ev('ShippingManagementEngine.getFinalPurchaseUploadSelection(__inventoryColumnTest.state.workspace).included.map(row=>[row.productCode,row.purchaseNeed])'), [['INV-001',12]], 'F10 remains shortage 12, not order 30 or stock 18');
  await shot('after-analysis-inventory-order-remaining');
  assert.deepEqual(report.errors,[]);report.result='passed';console.log('PASS inventory purchase/info/order/remaining and order aggregate columns',JSON.stringify(report.checks));
}catch(error){report.error=error.stack;report.result='failed';console.error(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2));socket?.close();if(browser?.pid){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else{spawnSync('pkill',['-TERM','-P',String(browser.pid)],{stdio:'ignore'});browser.kill('SIGTERM');}}server.closeAllConnections();await new Promise(r=>server.close(r));}
