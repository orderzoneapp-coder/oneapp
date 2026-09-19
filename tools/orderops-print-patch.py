import pathlib,re,hashlib
root=pathlib.Path.cwd()
expected={
 'orderops/list.html':'ecea2aabf0a572b5421ddf8141b76b3aaa049b5c',
 'orderops_list.html':'5e6954fbbb37d8cd58b826c32d109a031bf8ea53',
 'scripts/test-orderops-theme-browser-e2e.mjs':'1cf528ca085de488ef799333c79a30ee32666010',
}
for path,sha in expected.items():
 b=(root/path).read_bytes();actual=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
 assert actual==sha,(path,actual)
for name in ['orderops/list.html','orderops_list.html']:
 p=root/name;s=p.read_text()
 pattern=r'(      (?:html\[data-nexus-ui-app="orderops"\] )?body\.printing-table \.print-area tbody tr\.manager-color-row\[style\*="--manager-color"\] > td \{[^}]*?)background: #fff !important;'
 s,n=re.subn(pattern,r'\1background: var(--manager-print-color, var(--manager-color)) !important;',s)
 assert n==1,(name,n)
 p.write_text(s)
p=root/'scripts/test-orderops-theme-browser-e2e.mjs';s=p.read_text()
start=s.index("  await client.send('Emulation.setEmulatedMedia', { media: 'print' });")
end=s.index("\n  await client.send('Emulation.setEmulatedMedia', { media: 'screen' });",start)
b=s[start:end]
old="""  assert.ok([...printMetrics.managerCells, ...printMetrics.unitCells].every((cell) => cell.background === 'rgb(255, 255, 255)'),
    'every printed information cell must use a white paper background');"""
new="""  assert.ok(printMetrics.managerCells.every((cell) => cell.background === 'rgb(219, 234, 254)'),
    'printed manager cells must retain the assigned pastel color, not be reset to white');
  assert.ok(printMetrics.unitCells.every((cell) => cell.background === 'rgb(254, 243, 199)'),
    'printed warning rows must retain their assigned color as well as red text');
  assert.ok(printMetrics.vividCells.every((cell) => cell.background === 'rgb(140, 148, 156)'),
    'vivid manager colors must use the existing lightened print color');
  assert.ok(printMetrics.fallbackCells.every((cell) => cell.background === 'rgb(220, 252, 231)'),
    'a missing print-color variable must fall back to the saved manager color');
  console.log(`PASS manager print colors: ${printPath} / ${printTheme}`);"""
assert b.count(old)==1;b=b.replace(old,new)
oldrow='<td>박담당</td><td>2</td></tr></tbody></table>'
newrow='<td>박담당</td><td>2</td></tr><tr class="manager-color-row" style="--manager-color:#102030;--manager-print-color:#8c949c"><td>진한색</td><td>최담당</td><td>3</td></tr><tr class="manager-color-row" style="--manager-color:#dcfce7"><td>호환</td><td>이담당</td><td>1</td></tr></tbody></table>'
assert b.count(oldrow)==1;b=b.replace(oldrow,newrow)
anchor="      unitCells:[...printArea.querySelectorAll('tbody tr.unit-alert-row > td')].map((node)=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor};}),"
assert b.count(anchor)==1
b=b.replace(anchor,anchor+"\n      vividCells:[...printArea.querySelectorAll('tbody tr:nth-child(3) > td')].map((node)=>({background:getComputedStyle(node).backgroundColor})),\n      fallbackCells:[...printArea.querySelectorAll('tbody tr:nth-child(4) > td')].map((node)=>({background:getComputedStyle(node).backgroundColor})),")
loop="""  // Print colors must survive both entrypoints and both screen themes.
  for (const printPath of ['orderops/list.html', 'orderops_list.html']) {
    if (printPath === 'orderops_list.html') {
      await client.send('Emulation.setEmulatedMedia', { media: 'screen' });
      const printLoaded = client.once('Page.loadEventFired');
      await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/${printPath}` });
      await printLoaded;
    }
    for (const printTheme of ['light', 'dark']) {
      await evaluate(client, `document.documentElement.dataset.nexusUiTheme=${JSON.stringify(printTheme)}`);
"""+'\n'.join('    '+line if line else '' for line in b.splitlines())+"\n    }\n  }\n"
s=s[:start]+loop+s[end:];p.write_text(s)
outputs={'orderops/list.html':'1d5922ba6c8f0c9891b8c1789571f41a7c25378a','orderops_list.html':'e28a1bc7f790f105230b23503f1df274a0d4eed0','scripts/test-orderops-theme-browser-e2e.mjs':'ed7929ff6ed6c8f876f014b17f27c526ced75b5e'}
for path,sha in outputs.items():
 b=(root/path).read_bytes();actual=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
 assert actual==sha,(path,actual)
 print(path,actual)
