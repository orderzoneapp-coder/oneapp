from pathlib import Path
import os
root=Path(os.environ.get('FILTER_SOURCE_ROOT','/mnt/data/oneapp-filter'))
for name in ['orderops/list.html','orderops_list.html']:
 p=root/name;s=p.read_text();a='''            state.activePreview = FILE_KIND_PREVIEWS[previewKind];
            resetResultViewFilters();
            renderResults();''';b='''            state.activePreview = FILE_KIND_PREVIEWS[previewKind];
            // Replacing input data must not erase the selected form's filter intent.
            closeColumnSortMenu();
            renderResults();''';assert s.count(a)==1,name;p.write_text(s.replace(a,b))
p=root/'scripts/test-orderops-work-preservation.mjs';s=p.read_text();a='leaveUnresolvedReview() {}, clearSubstitutionSelection() {}, renderSourceViewCards() {},';assert s.count(a)==1;s=s.replace(a,a+' closeColumnSortMenu() {},');p.write_text(s)
p=root/'scripts/test-orderops-filter-intent.mjs';s=p.read_text();a='  const html = fs.readFileSync(ROOT + path, "utf8");';b=a+'''
  const inputCommit = /      async function commitInputCandidates\\([^\\n]*\\) \\{[\\s\\S]*?\\n      \\}/.exec(html)?.[0];
  assert.ok(inputCommit && !inputCommit.includes("resetResultViewFilters()"), "Input replacement must retain filter rules");''';assert s.count(a)==1;s=s.replace(a,b);p.write_text(s)
p=Path('/tmp/test_filter_browser.py') if Path('/tmp/test_filter_browser.py').exists() else Path('/mnt/data/test_filter_browser.py');s=p.read_text();s=s.replace('getActivePreviewDefinitions, renderPreview }','getActivePreviewDefinitions, renderPreview, persistLocalWorkspace }')
a="  def visible():";b='''  def inventory():
   page.evaluate("""async()=>{
    const rows=[['품목코드','품목명','규격','단위','수량','1창고'],...Array.from({length:20},(_,i)=>[String(i+1).padStart(4,'0'),'상품'+i,'','EA',100,100])];
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'재고');
    await __filterTest.handleFile('inventory',new File([XLSX.write(wb,{bookType:'xlsx',type:'array'})],'inventory.xlsx'));
    if(!__filterTest.state.workspace)throw new Error('Inventory did not create workspace');
   }""")
   page.keyboard.press('F5')
  def restore():
   page.reload();page.wait_for_function('!!(window.__filterTest?.state.db && __filterTest.state.recoveryRecords.some(r=>r.valid))')
   page.locator('#restoreButton').click();page.wait_for_function('!!__filterTest.state.workspace')
'''+a
assert s.count(a)==1;s=s.replace(a,b)
a="   if default and page.locator('#viewPresetDefaultButton').get_attribute('aria-pressed')!='true':page.locator('#viewPresetDefaultButton').click()";b=a+"\n   page.evaluate('()=>__filterTest.persistLocalWorkspace().then(()=>true)')";assert s.count(a)==1;s=s.replace(a,b)
s=s.replace("  upload(['A','B','C']);open_menu()","  upload(['A','B','C']);inventory();open_menu()")
s=s.replace("  page.reload();page.wait_for_function('!!(window.__filterTest?.state.db && window.XLSX)');upload(","  restore();upload(")
p.write_text(s)
print('Applied input-filter preservation and real IndexedDB recovery browser coverage.')
