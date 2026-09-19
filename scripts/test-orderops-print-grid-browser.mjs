import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse the canonical app's real Excel intake/recovery fixture. Only the local
// test server exposes state; native print is replaced so CDP can capture PDFs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let fixture = readFileSync(join(root, "scripts/test-orderops-excel-preparation-browser.mjs"), "utf8");
const hook = "runAnalysis, renderResults, persistLocalWorkspace";
assert.equal(fixture.split(hook).length, 2, "Expected one test-only state hook");
fixture = fixture.replace(hook, "getPreviewDefinitions, runAnalysis, renderResults, persistLocalWorkspace");
const anchor = '  report.result = "passed";';
assert.equal(fixture.split(anchor).length, 2, "Expected one final success boundary");
const baselineRef = process.env.ORDEROPS_PRINT_GRID_BASELINE;
const baselineCss = baselineRef ? execFileSync("git", ["show", `${baselineRef}:orderops/excel-preparation.css`], { cwd: root, encoding: "utf8" }) : null;
const injection = `
  await ev(\`(() => {
    globalThis.__fixture = kind => {
      const orders = [['일자','창고','담당','단위','품목코드','품목명','규격','수량','단가','공급가액','적요','적요1','거래처','그룹']];
      const inventory = [['품목코드','품목명','규격','단위','수량','1창고','3서울','4전송']];
      for (let i=0;i<40;i++) {
        const code=String(1001+i),unit=i%2?'EA':'BOX',name='인쇄검증상품 '+String(i+1).padStart(3,'0');
        inventory.push([code,name,unit,unit,20,20,'',0]);
        for (let j=0;j<3;j++) {
          const quantity=j===0?3:j===1?0:-1;
          orders.push(['2026-09-19','1창고',['담당A','담당B',''][j],unit,code,name,unit,quantity,1000,quantity*1000,'',i%7===0?'긴 전달사항 줄바꿈 확인':'','거래처 '+j,'G'+i]);
        }
      }
      const book=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(kind==='orders'?orders:inventory),'자료');
      return new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],'print-grid-'+kind+'.xlsx');
    };
    return true;
  })()\`);
  await upload("inventory");
  await upload("orders");
  await selectPreview("allocations");
  await ev(\`(() => {
    const s=__ops.state;
    s.searchQuery='';s.shortageFocus=false;s.columnFilters={};s.sortSettings={};
    s.managerFilters.clear();s.warehouseFilters.clear();s.specificationFilters.clear();
    s.managerColorSettings.colors={'담당A':'#ccfbf1','담당B':'#fef3c7'};
    const columns=__ops.getPreviewDefinitions(s.workspace).allocations.columns;
    const roles=['purchase','productAggregateQuantity','productName','specification','orderQuantity','warehouseQuantity','unitPrice','customer','deliveryNotice'];
    const keys=roles.flatMap(role=>columns.filter(c=>c.role===role).map(c=>c.key));
    s.columnOrderSettings.tabs.allocations=keys;
    s.hiddenColumnSettings.tabs.allocations=columns.filter(c=>!keys.includes(c.key)).map(c=>c.key);
    __ops.renderResults();return true;
  })()\`);
  assert.equal(await ev("__ops.state.workspace.orders.length"),120,"Real XLSX intake must retain all rows, including zero and negative orders");
  await ev("document.fonts.ready.then(()=>true)");
  await ev("__ops.persistLocalWorkspace().then(()=>true)");
  const gridSnapshot=()=>ev("JSON.stringify({workspace:__ops.state.workspace,filters:__ops.state.columnFilters,hidden:__ops.state.hiddenColumnSettings,order:__ops.state.columnOrderSettings,colors:__ops.state.managerColorSettings})");
  const savedGrid=await gridSnapshot();
  const savedTheme=await ev("document.documentElement.dataset.nexusUiTheme");
  const baselinePrintCss=${JSON.stringify(baselineCss)};
  await ev("globalThis.__gridNativePrint=window.print;window.print=()=>{};true");
  const readPrintGrid=()=>ev(\`(() => {
    const t=document.querySelector('#printArea table'),ts=getComputedStyle(t);
    const read=c=>{const s=getComputedStyle(c);return {text:c.textContent,color:s.color,background:s.backgroundColor,position:s.position,shadow:s.boxShadow,edges:['Top','Right','Bottom','Left'].map(side=>({width:parseFloat(s['border'+side+'Width']),style:s['border'+side+'Style'],color:s['border'+side+'Color']}))};};
    return {collapse:ts.borderCollapse,spacing:ts.borderSpacing,headers:[...t.querySelectorAll('thead th')].map(read),rows:[...t.querySelectorAll('tbody tr')].map(tr=>[...tr.cells].map(read))};
  })()\`);
  const paletteAndText=g=>JSON.stringify([g.headers,...g.rows].map(row=>row.map(c=>[c.text,c.color,c.background])));
  const screenSnapshot=()=>ev("JSON.stringify([...document.querySelectorAll('#previewTable th,#previewTable td,#previewTable input,.global-header,.nexus-ui-header')].map(e=>{const s=getComputedStyle(e);return [s.color,s.backgroundColor,s.fontSize,s.fontWeight,s.border,s.boxShadow];}))");
  report.printGrid=[];
  for (const theme of ['light','dark']) {
    await send('Emulation.setEmulatedMedia',{media:'screen'});
    await ev("document.documentElement.dataset.nexusUiTheme="+JSON.stringify(theme)+";true");
    const screenBefore=await screenSnapshot();
    let beforeGrid;
    if (baselinePrintCss) {
      await ev("(()=>{document.querySelector('link[href*=\\\"excel-preparation.css\\\"]').disabled=true;const s=document.createElement('style');s.id='print-grid-baseline';s.textContent="+JSON.stringify(baselinePrintCss)+";document.head.append(s);return true;})()");
      assert.equal(await screenSnapshot(),screenBefore,'The fix must not change any on-screen cell or header');
      await ev("document.querySelector('#printButton').click();true");
      await send('Emulation.setEmulatedMedia',{media:'print'});
      beforeGrid=await readPrintGrid();
      assert.equal(beforeGrid.collapse,'collapse','Capture the old collapsed-border print path');
      const oldPdf=await send('Page.printToPDF',{preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
      writeFileSync(join(evidence,'print-grid-before-'+theme+'.pdf'),Buffer.from(oldPdf.data,'base64'));
      await ev("dispatchEvent(new Event('afterprint'));document.querySelector('#print-grid-baseline').remove();document.querySelector('link[href*=\\\"excel-preparation.css\\\"]').disabled=false;true");
      await delay(1250);
    }
    for (const scale of [0.8,1]) for (const backgrounds of [true,false]) {
      await send('Emulation.setEmulatedMedia',{media:'screen'});
      await ev("document.querySelector('#printButton').click();true");
      await send('Emulation.setEmulatedMedia',{media:'print'});
      const grid=await readPrintGrid();
      assert.equal(grid.rows.length,120);
      assert.equal(grid.collapse,'separate');assert.equal(grid.spacing,'0px');
      const valid=edge=>edge.width===1&&edge.style==='solid'&&edge.color==='rgb(71, 85, 105)';
      for (const row of [grid.headers,...grid.rows]) {
        assert.ok(valid(row[0].edges[3]),'Every row must have a left outer edge');
        for (const cell of row) assert.ok(valid(cell.edges[1])&&valid(cell.edges[2])&&cell.position==='static'&&cell.shadow==='none','Every cell including blanks needs solid right/bottom edges without sticky/shadow artifacts');
      }
      assert.ok(grid.headers.every(c=>valid(c.edges[0])),'Repeated print heading has a closed top edge');
      if(beforeGrid) assert.equal(paletteAndText(grid),paletteAndText(beforeGrid),'Preserve original values, text colors, and all assigned print backgrounds');
      const name='print-grid-'+theme+'-'+scale+'-'+(backgrounds?'on':'off');
      const pdf=await send('Page.printToPDF',{preferCSSPageSize:true,printBackground:backgrounds,displayHeaderFooter:false,scale});
      writeFileSync(join(evidence,name+'.pdf'),Buffer.from(pdf.data,'base64'));
      report.printGrid.push({theme,scale,backgrounds,rows:grid.rows.length,columns:grid.headers.length,bytes:Buffer.from(pdf.data,'base64').length,metrics:grid});
      await ev("dispatchEvent(new Event('afterprint'));true");
      await send('Emulation.setEmulatedMedia',{media:'screen'});
      await delay(1250);
      assert.equal(await screenSnapshot(),screenBefore,'F9 close restores the unchanged screen styles');
      assert.equal(await gridSnapshot(),savedGrid,'F9 must not mutate order data, filters, widths or manager colors');
      check(name+': actual F9 PDF, all borders, blank cells, colors and data preserved',true);
    }
  }
  await ev("window.print=globalThis.__gridNativePrint;delete globalThis.__gridNativePrint;document.documentElement.dataset.nexusUiTheme="+JSON.stringify(savedTheme)+";true");
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalWrites,[]);
`;
const temporary = join(root, "scripts", `.orderops-print-grid-${process.pid}.mjs`);
try {
  writeFileSync(temporary, fixture.replace(anchor, injection + anchor));
  execFileSync(process.execPath, [temporary], { cwd: root, stdio: "inherit", env: process.env, timeout: 240000 });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
