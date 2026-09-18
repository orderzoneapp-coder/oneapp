import hashlib,json,os,shutil,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
OUT=Path('/tmp/filter-live-evidence');OUT.mkdir(exist_ok=True)
EXPECTED={'orderops/list.html':'18d28fda6278f73748c21392c7849474207826cf71c97f1c1be59eb583121a44','orderops_list.html':'f9caa2bd046242557824c6e3e50508d588d1e88c309fa10685660746489ecb80'}
BASE='https://oneapp.orderz.co.kr/'
REPORT={'checks':[],'errors':[],'blocked_writes':[],'resources':{}}
def check(label,actual,expected):
 assert actual==expected,(label,actual,expected)
 REPORT['checks'].append(label);print('PASS',label,flush=True)
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=shutil.which('google-chrome'),headless=True,args=['--no-sandbox'])
  for route,digest in EXPECTED.items():
   url=BASE+route+'?filter-verification='+os.environ['EXPECTED_COMMIT']
   with urllib.request.urlopen(urllib.request.Request(url,headers={'Cache-Control':'no-cache'}),timeout=30) as response:
    actual=hashlib.sha256(response.read()).hexdigest();REPORT['resources'][route]={'status':response.status,'sha256':actual}
   check(route+' deployed HTML equals verified source',actual,digest)
   context=browser.new_context(viewport={'width':1440,'height':1000})
   def restrict(r):
    if r.request.method not in ['GET','HEAD']:
     REPORT['blocked_writes'].append(r.request.url);r.abort();return
    r.continue_()
   context.route('**/*',restrict)
   page=context.new_page();page.on('pageerror',lambda e:REPORT['errors'].append(str(e)))
   page.goto(url,wait_until='networkidle');page.wait_for_function('!!window.XLSX')
   def upload(kind,values):
    data=page.evaluate('''({kind,values})=>{
     const rows=kind==='orders'?[['일자','품목코드','품목명','규격','단위','수량','단가','공급가액','적요','적요1','거래처','그룹'],...values.map((v,i)=>['2026-09-19',String(i+1).padStart(4,'0'),'상품'+v,'','EA',1,1000,1000,'','',v,'G'])]:[['품목코드','품목명','규격','단위','수량','1창고'],...Array.from({length:20},(_,i)=>[String(i+1).padStart(4,'0'),'상품'+i,'','EA',100,100])];
     const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'자료');return Array.from(new Uint8Array(XLSX.write(wb,{bookType:'xlsx',type:'array'})));
    }''',{'kind':kind,'values':values})
    name=kind+'-'+str(len(values))+'.xlsx'
    page.locator('#'+kind+'Input').set_input_files({'name':name,'mimeType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','buffer':bytes(data)})
    page.wait_for_function('({kind,name})=>document.getElementById(kind+"FileName").textContent.includes(name)',arg={'kind':kind,'name':name})
   def visible():return page.locator('#previewTable tbody td[data-column-role="customer"]').evaluate_all("cells=>cells.map(c=>(c.querySelector('input,textarea')?.value ?? c.textContent).trim())")
   def menu():
    page.locator('button[aria-label="거래처 정렬 및 조건 필터"]').click()
    page.locator('#columnSortMenu').wait_for(state='visible')
   def item(v,checked):
    page.locator('[data-column-value-list] label').filter(has=page.locator('span',has_text=v)).get_by_role('checkbox').set_checked(checked)
   def apply():page.locator('[data-apply-column-values]').click()
   upload('orders',['A','B','C']);upload('inventory',[]);page.keyboard.press('F5')
   check(route+' actual file-input events display all orders',visible(),['A','B','C'])
   menu();item('B',False);apply();check(route+' exclusion B',visible(),['A','C'])
   upload('orders',['A','B','C','D']);check(route+' new D is included',visible(),['A','C','D'])
   menu();page.locator('[data-column-value-select-all]').check();page.locator('[data-column-value-select-all]').uncheck();item('A',True);item('C',True);apply()
   upload('orders',['A','B','C','D','E']);check(route+' inclusion A C hides new E',visible(),['A','C'])
   page.screenshot(path=str(OUT/('live-'+route.replace('/','-')+'.png')))
   context.close()
  browser.close()
 check('no uncaught JavaScript errors',REPORT['errors'],[])
 check('no attempted server writes',REPORT['blocked_writes'],[])
finally:
 (OUT/'report.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2))
