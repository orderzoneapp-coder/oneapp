"""Unmodified original screen in Chromium; synthetic files and isolated storage only."""
import functools
import hashlib
import http.server
import json
import os
import shutil
import threading
import time
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('ORDEROPS_ORIGINAL_EVIDENCE_DIR', '/tmp/orderops-original-browser'))
OUT.mkdir(parents=True, exist_ok=True)
CDN = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js'
server = None
origin = os.environ.get('ORDEROPS_LIVE_ORIGIN', '').rstrip('/')
if origin:
    assert origin == 'https://oneapp.orderz.co.kr', 'Only the approved production origin is allowed'
else:
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
report = {'result': 'running', 'origin': origin, 'checks': [], 'page_errors': [], 'external_writes': [],
          'method': 'Unmodified HTML, actual Chromium file inputs and keyboard; synthetic XLSX only; isolated browser storage',
          'source_sha256': hashlib.sha256((ROOT / 'orderops_list.html').read_bytes()).hexdigest()}


def check(name, value=True):
    assert value, name
    report['checks'].append(name)
    print('PASS', name, flush=True)


DB_READ = '''async () => new Promise((resolve,reject) => {
 const req=indexedDB.open('ONEAPPShippingRecoveryDB'); req.onerror=()=>reject(req.error);
 req.onsuccess=()=>{const db=req.result;
  if(!db.objectStoreNames.contains('recoveryRecords')){db.close();resolve(null);return;}
  const q=db.transaction('recoveryRecords','readonly').objectStore('recoveryRecords').getAll();
  q.onerror=()=>reject(q.error);q.onsuccess=()=>{const pointer=localStorage.getItem('oneapp.shipping.recovery.pointer.v1');
   db.close();resolve(q.result.find(r=>r.recordId===pointer)||null);};
 };
})'''


def saved(page, predicate=lambda _r: True, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        record = page.evaluate(DB_READ)
        if record and predicate(record):
            return record
        page.wait_for_timeout(100)
    raise AssertionError('Verified recovery record not observed: ' + page.locator('#localSaveStatus').inner_text())


def ready(page):
    page.wait_for_function("window.ShippingManagementEngine && window.XLSX && document.querySelector('#localSaveStatus')?.textContent !== '임시저장 준비'")


def upload(page, kind, count=None):
    count = count or (115 if kind == 'orders' else 297)
    name = f'{kind}-{count}.xlsx'
    data = page.evaluate('''({kind,count})=>{
      const order=kind==='orders';
      const h=order?['일자-No.','담당','창고코드','단위','품목코드','품목명','규격','수량','재고','단가','적요','적요1','거래처','그룹']
       :['사용','품목코드','단위','품목명','규격','수량','1창고','2전송','3서울','4전송','기본','전송','창고'];
      const matrix=[[order?'미판매현황':'재고현황'],h];
      for(let i=0;i<count;i++){
       const code=order&&i>=count-21?'M'+String(i-(count-21)).padStart(4,'0'):'X'+String(order?i%60:i).padStart(4,'0');
       const q=order?(i===0?2:1):(i===296?-0.5:i===295?0:11);
       const unit=['BOX','EA',''][i%3];
       matrix.push(order?['2026-09-21-1','담당A','1창고',unit,code,'합성상품'+i,'합성규격',q,0,1000,'','','합성거래처','기본']
        :['Y',code,unit,'합성상품'+i,'합성규격',q,q,0,0,0,0,9000,8000]);
      }
      if(!order)matrix.push(['합계','','','','',matrix.slice(2).reduce((s,r)=>s+r[5],0)]);
      matrix.push(['2026-09-21 (월) 오전 09:00:00']);
      const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(matrix),order?'미판매현황':'재고현황');
      return Array.from(new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'})));
    }''', {'kind': kind, 'count': count})
    page.set_input_files('#' + kind + 'Input', {'name': name, 'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'buffer': bytes(data)})
    page.wait_for_function('(x)=>document.getElementById(x.kind+"Card").classList.contains("has-file") && document.getElementById(x.kind+"FileName").textContent.includes(x.name)', arg={'kind': kind, 'name': name})


def run(page, enter=False, orders=115):
    page.wait_for_function("!document.querySelector('#analyzeButton').disabled")
    if enter:
        page.locator('#systemMessage').click()
        page.keyboard.press('Enter')
    else:
        page.locator('#analyzeButton').click()
    page.wait_for_function("!document.querySelector('#resultsPanel').classList.contains('hidden')")
    return saved(page, lambda r: len(r['payload']['workspace']['orders']) == orders)


try:
    with sync_playwright() as pw:
        executable = os.environ.get('CHROME_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
        assert executable, 'Chrome/Chromium is required; no skipped browser tests'
        browser = pw.chromium.launch(executable_path=executable, headless=True)

        def context(seed=None):
            ctx = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)

            def route(r):
                if r.request.method not in ('GET', 'HEAD'):
                    report['external_writes'].append({'method': r.request.method, 'url': r.request.url})
                    r.abort()
                elif r.request.url.startswith(origin + '/') or r.request.url == CDN:
                    r.continue_()
                else:
                    r.fulfill(status=204, body='')
            ctx.route('**/*', route)
            if seed:
                ctx.add_init_script('for(const [k,v] of Object.entries(' + json.dumps(seed) + ')){if(!localStorage.getItem(k))localStorage.setItem(k,v)}')
            page = ctx.new_page()
            page.on('pageerror', lambda error: report['page_errors'].append(str(error)))
            response = page.goto(origin + '/orderops_list.html', wait_until='load')
            assert response and response.status == 200
            check('served root HTML bytes match the candidate', hashlib.sha256(response.body()).hexdigest() == report['source_sha256'])
            ready(page)
            return ctx, page

        ctx, p = context()
        upload(p, 'orders'); upload(p, 'inventory')
        w = run(p)['payload']['workspace']
        check('order-first button: 115 orders / 297 inventory rows', len(w['orders']) == 115 and len(w['inventory']) == 297)
        view = p.evaluate('(w)=>ShippingManagementEngine.getInventoryViewRows(w).rows', w)
        check('21 unmatched products retained without blocking', sum(bool(r.get('inventoryMissing')) for r in view) == 21)
        check('negative decimal and actual zero preserved', w['inventory'][-1]['inventoryTotal'] == -0.5 and w['inventory'][-2]['inventoryTotal'] == 0)
        check('first and last business rows retained, footer excluded', w['orders'][0]['sourceRowNumber'] == 3 and w['orders'][-1]['sourceRowNumber'] == 117)
        p.locator('#ordersDrop').click()
        editor = p.locator('.order-edit-input[data-order-row="3"][data-order-field="quantity"]')
        editor.fill('7'); editor.press('Tab')
        before = saved(p, lambda r: r['payload']['workspace']['orders'][0]['quantity'] == 7)['payload']['workspace']
        check('edited quantity saved and hash-verified in IndexedDB')
        p.reload(); ready(p)
        p.locator('#headerRestoreButton').click()
        p.wait_for_function("!document.querySelector('#resultsPanel').classList.contains('hidden')")
        p.locator('#ordersDrop').click()
        check('refresh and recovery restore quantity 7', editor.input_value() == '7')
        check('complete workspace preserved after recovery', saved(p)['payload']['workspace'] == before)
        with p.expect_download() as download:
            p.locator('#downloadButton').click()
        exported = OUT / 'synthetic-export.xlsx'
        download.value.save_as(str(exported))
        export_rows = p.evaluate('''(data)=>{const b=XLSX.read(new Uint8Array(data),{type:'array'});return b.SheetNames.map(n=>({name:n,rows:XLSX.utils.sheet_to_json(b.Sheets[n],{header:1,defval:''})}));}''', list(exported.read_bytes()))
        check('download is a readable XLSX with restored edited quantity', any('X0000' in row and 7 in row for sheet in export_rows for row in sheet['rows']))
        old_name = p.locator('#ordersFileName').inner_text()
        p.set_input_files('#ordersInput', {'name': 'invalid.xlsx', 'mimeType': 'application/octet-stream', 'buffer': b'invalid fixture'})
        p.wait_for_function("document.querySelector('#toast').textContent.includes('유지')")
        check('invalid file preserves previous filename and visible edit', p.locator('#ordersFileName').inner_text() == old_name and editor.input_value() == '7')
        check('invalid file preserves complete saved workspace', saved(p)['payload']['workspace'] == before)
        run(p); p.locator('#ordersDrop').click()
        check('execution resumes after invalid file without losing edit', editor.input_value() == '7')
        p.screenshot(path=str(OUT / 'synthetic-original-screen.png'))
        ctx.close()
        ctx, p = context(); upload(p, 'inventory'); upload(p, 'orders')
        w = run(p, enter=True)['payload']['workspace']
        check('inventory-first Enter: 115 orders / 297 inventory rows', len(w['orders']) == 115 and len(w['inventory']) == 297)
        ctx.close()
        seed = {
            'oneapp.orderops.excel-templates.v1': json.dumps({'schemaVersion': 'orderops-excel-templates/v1', 'items': [{'kind': 'orders', 'name': 'old range', 'endRow': 103}]}),
            'oneapp.orderops.excel-mappings.v1': json.dumps({'schemaVersion': 'orderops-excel-mappings/v1', 'types': {'orders': {'fileAliases': ['주문'], 'sheetAliases': ['미판매현황'], 'columns': {'수량': ['사용자주문량']}}}})}
        ctx, p = context(seed); upload(p, 'orders', 160); upload(p, 'inventory')
        w = run(p, orders=160)['payload']['workspace']
        check('old preparation range cannot truncate enlarged file', len(w['orders']) == 160 and w['orders'][-1]['sourceRowNumber'] == 162)
        check('stored aliases/templates are not deleted or rewritten', p.evaluate('(s)=>Object.entries(s).every(([k,v])=>localStorage.getItem(k)===v)', seed))
        ctx.close()
        ctx, p = context(); upload(p, 'orders', 30); upload(p, 'inventory')
        w = run(p, orders=30)['payload']['workspace']
        check('smaller renamed file excludes footer dynamically', len(w['orders']) == 30 and w['orders'][-1]['sourceRowNumber'] == 32)
        ctx.close(); browser.close()
    check('no JavaScript runtime exceptions', not report['page_errors'])
    check('no external writes attempted', not report['external_writes'])
    report['result'] = 'passed'
except Exception as error:
    report['result'] = 'failed'; report['failure'] = str(error)
    traceback.print_exc()
finally:
    if server:
        server.shutdown()
    (OUT / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
if report['result'] != 'passed':
    raise SystemExit(1)
