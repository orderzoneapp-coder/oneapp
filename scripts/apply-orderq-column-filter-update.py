import json
import subprocess
from pathlib import Path

root = Path.cwd()
expected = {
    'orderops_list.html': 'c78a57fe0866de198ec9d3cf1e32e8c6a6739c5c',
    'scripts/test-orderops-original-recovery.mjs': '49c028b20961a8f709530a807f69981cfe2aa9bb',
    'scripts/test-orderops-original-recovery-browser.py': '504a2e92ba5b7d46d58f5695819b339a053908e4',
}
for name, sha in expected.items():
    actual = subprocess.check_output(['git', 'hash-object', name], text=True).strip()
    assert actual == sha, f'Unexpected source version for {name}: {actual}'

patches = [
    ('<div class="column-sort-menu-section" data-numeric-filter-section aria-label="숫자 열 조건">',
     '<div class="column-sort-menu-section" data-column-condition-section aria-label="선택 값에 우선 적용할 제외 조건">'),
    ('<label class="column-sort-condition"><input type="checkbox" data-column-condition="excludeZero">0 제외</label>',
     '<label class="column-sort-condition" data-numeric-filter-section><input type="checkbox" data-column-condition="excludeZero">0 제외</label>'),
    ('        elements.columnSortMenu.querySelector("[data-numeric-filter-section]")\n          .classList.toggle("hidden", !numericColumn);',
     '        elements.columnSortMenu.querySelector("[data-numeric-filter-section]")\n          .classList.toggle("hidden", !isQuantityColumn(column));'),
    ('''      function setColumnCondition(previewId, columnKey, condition, enabled) {
        if (!state.columnFilters[previewId]) state.columnFilters[previewId] = Object.create(null);
        const next = { ...(state.columnFilters[previewId][columnKey] || {}), [condition]: enabled };
        delete next.allowedValues;
        if (!columnFilterIsActive(next)) delete state.columnFilters[previewId][columnKey];
        else state.columnFilters[previewId][columnKey] = next;
        if (Object.keys(state.columnFilters[previewId]).length === 0) delete state.columnFilters[previewId];
        if (state.activeColumnMenu?.previewId === previewId && state.activeColumnMenu?.columnKey === columnKey) {
          state.activeColumnMenu.textSelection = null;
        }
      }''',
     '''      function setColumnCondition(previewId, columnKey, condition, enabled) {
        if (!state.columnFilters[previewId]) state.columnFilters[previewId] = Object.create(null);
        // Exclusions are independent of both saved values and the pending checkbox selection.
        const next = { ...(state.columnFilters[previewId][columnKey] || {}), [condition]: enabled };
        if (!columnFilterIsActive(next)) delete state.columnFilters[previewId][columnKey];
        else state.columnFilters[previewId][columnKey] = next;
        if (Object.keys(state.columnFilters[previewId]).length === 0) delete state.columnFilters[previewId];
      }'''),
]

def replace_once(source, before, after):
    assert source.count(before) == 1, f'Expected a unique anchor: {before[:100]}'
    return source.replace(before, after, 1)

html = (root / 'orderops_list.html').read_text()
for before, after in patches:
    html = replace_once(html, before, after)
(root / 'orderops_list.html').write_text(html)

name = root / 'scripts/test-orderops-original-recovery.mjs'
source = name.read_text()
anchor = "    assert.equal(text('orderops_list.html'), expected,"
approved = '''    // Approved column-filter delta: universal blanks, quantity-only zeros,
    // and exclusions independent of committed and pending value selections.
    for (const [from, to] of ''' + json.dumps(patches, ensure_ascii=False, indent=6) + ''') {
      assert.equal(expected.split(from).length, 2, 'Unique original column-filter anchor');
      expected = expected.replace(from, to);
    }
'''
source = replace_once(source, anchor, approved + anchor)
source = replace_once(source,
    'Original ROOT remains exact except pinned module URLs and the approved warehouse full-cell fill',
    'Original ROOT remains exact except pinned module URLs, full-cell fill and approved column-filter exclusions')
primitives = r'''
    // Exercise actual production predicates without a browser or replacing their code.
    const predicates = ['isBlankCell', 'isZeroCell', 'textFilterValueKey'].map((name) => {
      const match = expected.match(new RegExp('      function ' + name + '\\([^]*?\\n      \\}'));
      assert.ok(match, 'Production predicate found: ' + name);
      return match[0];
    }).join('\n');
    const { isBlankCell, isZeroCell } = new Function(predicates + '\nreturn { isBlankCell, isZeroCell };')();
    for (const value of [null, undefined, '', ' ', '\u3000', '\t\n']) {
      assert.equal(isBlankCell(value), true);
      assert.equal(isZeroCell(value), false, 'Blank must not be numeric zero');
    }
    for (const value of [0, -0, '0', '0.0', '-0', ' 0 ', '0,000']) {
      assert.equal(isBlankCell(value), false);
      assert.equal(isZeroCell(value), true);
    }
    for (const value of [-2, -0.5, 0.5, 3, '-2', '0.5', 'text']) {
      assert.equal(isBlankCell(value), false);
      assert.equal(isZeroCell(value), false, 'Nonzero numbers and text must survive');
    }
    console.log('PASS original column-filter blank/zero predicates: 20 cases');
'''
source = replace_once(source, "    assert.ok(!expected.includes('excel-preparation'),", primitives + "    assert.ok(!expected.includes('excel-preparation'),")
name.write_text(source)

name = root / 'scripts/test-orderops-original-recovery-browser.py'
source = name.read_text()
helpers = r'''

def upload_filter_fixture(page, kind, enlarged=False):
    """Small known-value fixture; never reads or modifies a user's browser storage."""
    count = 7 if enlarged else 5
    filename = f'filter-{kind}-{count}.xlsx'
    data = page.evaluate(''' + "'''" + r'''({kind,count})=>{
      const order=kind==='orders';
      const h=order?['일자-No.','담당','창고코드','단위','품목코드','품목명','규격','수량','재고','단가','적요','적요1','거래처','그룹']
       :['사용','품목코드','단위','품목명','규격','수량','1창고','2전송','3서울','4전송','기본','전송','창고'];
      const matrix=[[order?'미판매현황':'재고현황'],h];
      const quantities=[null,0,-2,0.5,3,7,0];
      for(let i=0;i<count;i++){
        const code='Q'+String(i).padStart(4,'0'); const q=quantities[i];
        matrix.push(order?['2026-09-23-1',i===0?'':'담당A','1창고','BOX',code,'필터상품'+i,'규격',1,0,1000,'','','필터거래처','기본']
          :['Y',code,'BOX','필터상품'+i,'규격',q,q,0,0,0,0,0,0]);
      }
      const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(matrix),order?'미판매현황':'재고현황');
      return Array.from(new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'})));
    }''' + "'''" + r''', {'kind': kind, 'count': count})
    page.set_input_files('#' + kind + 'Input', {'name': filename, 'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'buffer': bytes(data)})
    page.wait_for_function('(x)=>document.getElementById(x.kind+"Card").classList.contains("has-file") && document.getElementById(x.kind+"FileName").textContent.includes(x.filename)', arg={'kind': kind, 'filename': filename})


def filter_menu(page, label):
    page.get_by_role('button', name=label + ' 정렬 및 조건 필터', exact=True).click()
    menu = page.locator('#columnSortMenu')
    assert menu.is_visible(), 'Filter menu opened: ' + label
    return menu


def value_option(menu, value=None):
    key = json.dumps(['blank'] if value is None else ['value', str(value)], ensure_ascii=False, separators=(',', ':'))
    return menu.locator("[data-column-value='" + key + "']")


def selected_values(menu):
    return menu.locator('[data-column-value]:checked').evaluate_all('(items)=>items.map(x=>x.dataset.columnValue).sort()')


def inventory_codes(page):
    return sorted(page.locator('#previewTable tbody tr[data-product-code]').evaluate_all('(items)=>items.map(x=>x.dataset.productCode).filter(Boolean)'))

'''
source = replace_once(source, '\ntry:\n    with sync_playwright()', helpers + '\ntry:\n    with sync_playwright()')
checks = r'''        ctx.close()
        ctx, p = context()
        upload_filter_fixture(p, 'orders'); upload_filter_fixture(p, 'inventory')
        filter_workspace = run(p, orders=5)['payload']['workspace']
        for shortcut in ['F5', 'F6', 'F7']:
            p.keyboard.press(shortcut)
            labels = p.locator('#previewTable .column-sort-trigger').evaluate_all('(items)=>items.map(x=>x.getAttribute("aria-label"))')
            assert labels, 'Filter columns exist on ' + shortcut
            for label in labels:
                p.get_by_role('button', name=label, exact=True).click()
                menu = p.locator('#columnSortMenu')
                assert menu.locator('[data-column-condition="excludeBlank"]').is_visible(), label
                if label.startswith('단가 ') or label.startswith('품명 ') or label.startswith('품목코드 '):
                    assert not menu.locator('[data-column-condition="excludeZero"]').is_visible(), label
                menu.locator('[data-cancel-column-values]').click()
            check('blank exclusion visible on every column: ' + shortcut)
        menu = filter_menu(p, '1창고')
        blank = menu.locator('[data-column-condition="excludeBlank"]')
        zero = menu.locator('[data-column-condition="excludeZero"]')
        all_values = menu.locator('[data-column-value-select-all]')
        check('quantity filter has both exclusions and all values selected', blank.is_visible() and zero.is_visible() and all_values.is_checked())
        check('fixture distinguishes blank from numeric zero', value_option(menu).is_checked() and value_option(menu, 0).is_checked())
        blank.check()
        check('blank exclusion alone leaves actual zero', inventory_codes(p) == ['Q0001', 'Q0002', 'Q0003', 'Q0004'])
        zero.check()
        check('both upper exclusions override all-selected values', inventory_codes(p) == ['Q0002', 'Q0003', 'Q0004'] and all_values.is_checked())
        check('negative and decimal quantities remain visible', 'Q0002' in inventory_codes(p) and 'Q0003' in inventory_codes(p))
        all_values.uncheck(); all_values.check()
        check('select-all never clears upper exclusions', blank.is_checked() and zero.is_checked() and value_option(menu).is_checked() and value_option(menu, 0).is_checked())
        menu.locator('[data-apply-column-values]').click()
        menu = filter_menu(p, '1창고')
        check('reopened menu retains all-selected and both exclusions', all_values.is_checked() and blank.is_checked() and zero.is_checked())
        all_values.uncheck(); value_option(menu, 0).check(); value_option(menu, 3).check()
        pending = selected_values(menu)
        blank.uncheck(); zero.uncheck(); zero.check(); blank.check()
        check('upper toggles preserve pending individual values', selected_values(menu) == pending)
        menu.locator('[data-apply-column-values]').click()
        check('individual values intersect upper exclusions', inventory_codes(p) == ['Q0004'])
        menu = filter_menu(p, '1창고')
        blank.uncheck()
        check('upper toggles preserve committed individual values', selected_values(menu) == pending and inventory_codes(p) == ['Q0004'])
        blank.check()
        all_values.uncheck(); all_values.check()
        menu.locator('[data-apply-column-values]').click()
        check('all-selected restores all nonblank nonzero quantities', inventory_codes(p) == ['Q0002', 'Q0003', 'Q0004'])
        check('filters never mutate the workspace', saved(p)['payload']['workspace'] == filter_workspace)
        p.locator('#viewPresetSaveButton').click()
        p.locator('#viewPresetNameInput').fill('filter-exclusions-regression')
        p.locator('[data-save-view-preset]').click()
        p.locator('#viewPresetDefaultButton').click()
        p.reload(); ready(p)
        p.locator('#headerRestoreButton').click()
        p.wait_for_function("!document.querySelector('#resultsPanel').classList.contains('hidden')")
        p.keyboard.press('F7')
        check('saved default preset survives reload and recovery', inventory_codes(p) == ['Q0002', 'Q0003', 'Q0004'])
        menu = filter_menu(p, '1창고')
        check('saved preset keeps all-selected independent of exclusions', all_values.is_checked() and blank.is_checked() and zero.is_checked())
        menu.locator('[data-cancel-column-values]').click()
        upload_filter_fixture(p, 'orders', True); upload_filter_fixture(p, 'inventory', True)
        run(p, orders=7); p.keyboard.press('F7')
        check('same preset accepts new nonzero values in the next file', inventory_codes(p) == ['Q0002', 'Q0003', 'Q0004', 'Q0005'])
        menu = filter_menu(p, '1창고')
        check('new-file all-selection still includes blank and zero underneath exclusions', all_values.is_checked() and value_option(menu).is_checked() and value_option(menu, 0).is_checked())
        menu.locator('[data-clear-column-filter]').click()
        check('explicit column reset clears exclusions and selections', len(inventory_codes(p)) == 7)
        p.screenshot(path=str(OUT / 'synthetic-filter-exclusions.png'))
        ctx.close(); browser.close()'''
source = replace_once(source, '        ctx.close(); browser.close()', checks)
name.write_text(source)
print('Updated only: ' + ', '.join(expected))
