import json,pathlib,threading,http.server,functools,os,shutil,hashlib,urllib.request
from playwright.sync_api import sync_playwright
root=pathlib.Path.cwd()
evidence=pathlib.Path(os.environ.get('PRINT_EVIDENCE_DIR','/tmp/manager-print-evidence'));evidence.mkdir(parents=True,exist_ok=True)
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(root)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=os.environ.get('PRINT_BASE_URL',f'http://127.0.0.1:{server.server_port}').rstrip('/')
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=shutil.which('google-chrome') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 try:
  for path in ['orderops/list.html','orderops_list.html']:
   expected_sha=os.environ.get('EXPECTED_COMMIT')
   if expected_sha:
    source=urllib.request.urlopen(f'https://raw.githubusercontent.com/orderzoneapp-coder/oneapp/{expected_sha}/{path}',timeout=30).read()
    deployed=urllib.request.urlopen(base+'/'+path+'?print-check='+expected_sha,timeout=30).read()
    assert source==deployed,(path,'deployed source mismatch')
    print('PASS deployed source equality',path,hashlib.sha256(source).hexdigest(),flush=True)
   for theme in ['light','dark']:
    context=browser.new_context(viewport={'width':1600,'height':1000})
    errors=[];writes=[]
    def route_request(route):
     if route.request.method not in ['GET','HEAD']:
      writes.append(route.request.url);route.abort();return
     route.continue_()
    context.route('**/*',route_request)
    context.add_init_script("localStorage.setItem('oneapp.nexus.ui.theme.v1',THEME);localStorage.setItem('oneapp.orderops.manager-colors.v1',JSON.stringify({schemaVersion:'orderops-manager-colors/v1',storageRevision:2,colors:{'담당A':'#dbeafe','담당B':'#fef3c7','담당C':'#102030'}}));".replace('THEME',json.dumps(theme)))
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    response=page.goto(base+'/'+path,wait_until='networkidle');assert response.status==200
    page.wait_for_function('Boolean(window.XLSX && document.querySelector("#ordersInput"))')
    def upload(kind,matrix):
     page.eval_on_selector('#'+kind+'Input',"(input,matrix)=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(matrix),'자료');const dt=new DataTransfer();dt.items.add(new File([XLSX.write(wb,{type:'array',bookType:'xlsx'})],'test.xlsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));}",matrix)
     page.wait_for_function('!document.querySelector("#prepFileButton").disabled')
    upload('orders',[
     ['품목코드','품목명','규격','수량','적요','적요1','거래처','그룹','담당','단위','단가','일자'],
     ['000001','파스텔BOX','BOX',2,'','','거래처A','그룹','담당A','BOX',1000,'2026-09-19'],
     ['000002','파스텔EA','EA',3,'','','거래처B','그룹','담당B','EA',2000,'2026-09-19'],
     ['000003','진한색BOX','BOX',1,'','','거래처C','그룹','담당C','BOX',3000,'2026-09-19'],
     ['000004','미지정BOX','BOX',1,'','','거래처D','그룹','미지정','BOX',4000,'2026-09-19']])
    upload('inventory',[
     ['품목코드','품목명','규격','단위','수량','1창고'],
     ['000001','파스텔BOX','BOX','BOX',10,10],['000002','파스텔EA','EA','EA',10,10],['000003','진한색BOX','BOX','BOX',10,10],['000004','미지정BOX','BOX','BOX',10,10]])
    page.wait_for_function('!document.querySelector("#printButton").disabled')
    page.locator('#prepPreviewTabs [data-preview="allocations"]').click()
    page.wait_for_function('document.querySelectorAll("#previewTable tbody tr[data-product-code]").length===4')
    page.evaluate("()=>{window.__printCapture=null;window.print=()=>{window.__printCapture=document.querySelector('#printArea').innerHTML;};document.querySelector('#printButton').click();if(!window.__printCapture)throw new Error('Print handler did not run');}")
    page.evaluate("document.querySelector('#printArea').innerHTML=window.__printCapture;document.body.classList.add('printing-table')")
    page.emulate_media(media='print')
    metrics=page.evaluate("()=>({header:getComputedStyle(document.querySelector('#printArea th')).backgroundColor,rows:[...document.querySelectorAll('#printArea tbody tr[data-product-code]')].map(r=>({code:r.dataset.productCode,manager:r.style.getPropertyValue('--manager-color'),print:r.style.getPropertyValue('--manager-print-color'),classes:r.className,cells:[...r.cells].map(c=>({background:getComputedStyle(c).backgroundColor,color:getComputedStyle(c).color}))})),sortButtons:document.querySelectorAll('#printArea .column-sort-trigger').length,inputs:document.querySelectorAll('#printArea input').length})")
    assert len(metrics['rows'])==4,metrics
    assert metrics['header']=='rgb(255, 255, 255)',metrics
    assert metrics['sortButtons']==0 and metrics['inputs']==0,metrics
    for row,expected in zip(metrics['rows'][:3],['rgb(219, 234, 254)','rgb(254, 243, 199)','rgb(140, 148, 156)']):
     assert row['cells'] and all(c['background']==expected for c in row['cells']),(path,theme,row,expected)
     color='rgb(185, 28, 28)' if 'unit-alert-row' in row['classes'] else 'rgb(15, 23, 42)'
     assert all(c['color']==color for c in row['cells']),(path,theme,'text changed',row)
    assert metrics['rows'][3]['manager']=='',metrics
    assert errors==[],errors
    assert writes==[],writes
    results.append({'path':path,'theme':theme,'status':'PASS','metrics':metrics,'runtimeErrors':errors,'blockedWrites':writes})
    page.screenshot(path=str(evidence/(path.replace('/','-')+'-'+theme+'.png')),full_page=True)
    print('PASS actual print handler, colors, warning text, header and noneditable output:',path,theme,flush=True)
    context.close()
 finally:browser.close();server.shutdown()
(evidence/'manager-print-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
