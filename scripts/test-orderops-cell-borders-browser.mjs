import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Extend the existing real-app intake/recovery regression, never a CSS mock.
// Its isolated browser profile blocks all external writes. Only the native
// print dialog is substituted; the real F9 handler builds the PDF table.
async function verifyGrid({ ev, send, upload, selectPreview, shot, check, report, evidence }) {
  const baseline = process.env.ORDEROPS_GRID_BASELINE === "1";
  report.gridBaseline = baseline;
  const gridCheck = (label, pass) => {
    if (baseline) report.checks.push({ label, pass: Boolean(pass), baseline: true });
    else check(label, pass);
  };
  await ev(`(() => {
    globalThis.__fixture = kind => {
      const matrix = kind === 'orders'
        ? [['일자','창고','담당','단위','품목코드','품목명','규격','수량','단가','공급가액','적요','적요1','거래처','그룹']]
        : [['품목코드','품목명','규격','단위','수량','1창고','3서울','4전송']];
      for (let i=0; i<30; i++) {
        const code='GRID-'+String(i).padStart(3,'0'), unit=i%2 ? 'EA':'BOX';
        if (kind==='inventory') matrix.push([code,'경계선상품 '+i,unit,unit,18,10,8,0]);
        else for (let j=0;j<3;j++) matrix.push(['2026-09-17','1창고',['민트담당','노랑담당',''][j],unit,code,'경계선상품 '+i,unit,[10,8,12][j],1000,[10000,8000,12000][j],j===1?'':'전달사항','','거래처 '+j,'기본']);
      }
      const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(matrix),kind==='orders'?'주문':'재고');
      return new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],'grid-'+kind+'.xlsx');
    };return true;
  })()`);
  await upload("inventory");
  await upload("orders");
  await selectPreview("allocations");
  await ev(`(() => {
    const s=__ops.state;s.searchQuery='';s.shortageFocus=false;s.columnFilters={};s.sortSettings={};
    s.specificationFilters.clear();s.warehouseFilters.clear();s.managerFilters.clear();
    s.hiddenColumnSettings.tabs.allocations=[];
    s.managerColorSettings.colors={'민트담당':'#ccfbf1','노랑담당':'#fef3c7'};
    __ops.renderResults();return true;
  })()`);
  await ev("document.fonts.ready.then(()=>true)");
  const snapshot = () => ev("JSON.stringify({workspace:__ops.state.workspace,hidden:__ops.state.hiddenColumnSettings,sort:__ops.state.sortSettings,filters:__ops.state.columnFilters,colors:__ops.state.managerColorSettings})");
  const before = await snapshot();
  report.grid = [];
  const readGrid = id => ev(`(() => {
    const table=document.querySelector('#${id} table.preview-allocations');
    const cells=[...table.querySelectorAll('th,td')].map(el=>{const s=getComputedStyle(el);return {tag:el.tagName,first:el.cellIndex===0,text:el.textContent.trim(),position:s.position,background:s.backgroundColor,color:s.color,weight:s.fontWeight,shadow:s.boxShadow,edges:['Top','Right','Bottom','Left'].map(side=>[s['border'+side+'Width'],s['border'+side+'Style'],s['border'+side+'Color']])};});
    const s=getComputedStyle(table);return {collapse:s.borderCollapse,spacing:s.borderSpacing,rows:table.tBodies[0].rows.length,cells};
  })()`);
  const edge = e => parseFloat(e[0]) >= 1 && e[1] === "solid" && e[2] === "rgb(100, 116, 139)";
  await ev("window.__gridNativePrint=window.print;window.print=()=>{};true");
  for (const theme of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", { media: "screen" });
    await ev(`document.documentElement.dataset.nexusUiTheme='${theme}';true`);
    const screen = await readGrid("previewTable");
    gridCheck(theme+": 90 rows including empty cells have complete screen borders", screen.rows===90 && screen.cells.filter(c=>c.tag==='TD').every(c=>c.edges.every(e=>parseFloat(e[0])===1 && e[1]==='solid')));
    gridCheck(theme+": navy heading and bold white text are retained", screen.cells.filter(c=>c.tag==='TH').every(c=>c.background==='rgb(22, 50, 79)' && c.color==='rgb(255, 255, 255)' && c.weight==='900'));
    await shot("grid-screen-"+theme);
    for (const background of [true, false]) {
      await send("Emulation.setEmulatedMedia", { media: "print" });
      await ev("document.querySelector('#printButton').click();true");
      const print = await readGrid("printArea");
      gridCheck(theme+": print uses separate zero-spacing borders", print.collapse==='separate' && print.spacing==='0px');
      gridCheck(theme+": print cells have right/bottom and outer left edges", print.rows===90 && print.cells.every(c=>edge(c.edges[1]) && edge(c.edges[2]) && (!c.first || edge(c.edges[3]))));
      gridCheck(theme+": repeating print headings have top edges and are not sticky", print.cells.filter(c=>c.tag==='TH').every(c=>c.position==='static' && edge(c.edges[0])));
      gridCheck(theme+": blank print cells retain borders", print.cells.some(c=>c.tag==='TD' && !c.text) && print.cells.filter(c=>c.tag==='TD' && !c.text).every(c=>edge(c.edges[1]) && edge(c.edges[2])));
      gridCheck(theme+": assigned print background colors remain distinct", new Set(print.cells.filter(c=>c.tag==='TD').map(c=>c.background)).size>=3);
      const pdf = await send("Page.printToPDF", { printBackground: background, preferCSSPageSize: true, displayHeaderFooter: false });
      writeFileSync(join(evidence, `grid-${theme}-background-${background}.pdf`), Buffer.from(pdf.data, "base64"));
      report.grid.push({ theme, background, screen, print });
      await ev("dispatchEvent(new Event('afterprint'));true");
      await send("Emulation.setEmulatedMedia", { media: "screen" });
      gridCheck(theme+": afterprint returns to the work screen", await ev("!document.body.classList.contains('printing-table')"));
      // Drain the app's fallback cleanup timer before opening another dialog.
      await ev("new Promise(resolve=>setTimeout(resolve,1250))");
    }
  }
  await ev("window.print=window.__gridNativePrint;delete window.__gridNativePrint;true");
  assert.equal(await snapshot(), before, "Printing must not mutate work, filters or stored colors");
  gridCheck("printing preserves all order values and view settings", true);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let fixture = readFileSync(join(root, "scripts/test-orderops-excel-preparation-browser.mjs"), "utf8");
const anchor = '  await settled("final state");';
assert.equal(fixture.split(anchor).length, 2, "Expected one final-state injection point");
const baselineRef = process.env.ORDEROPS_GRID_BASELINE_REF;
if (baselineRef) {
  assert.equal(process.env.ORDEROPS_GRID_BASELINE, "1", "Baseline CSS is diagnostic only");
  const css = execFileSync("git", ["show", `${baselineRef}:orderops/excel-preparation.css`], { cwd: root, encoding: "utf8" });
  fixture = fixture.replace("const report = {", `sources.set("orderops/excel-preparation.css", Buffer.from(${JSON.stringify(css)}));\nconst report = {`);
}
const injected = `  await (${verifyGrid.toString()})({ ev, send, upload, selectPreview, shot, check, report, evidence });\n`;
fixture = fixture.replace(anchor, injected + anchor).replace('report.result = "passed";', 'report.result = report.gridBaseline ? "baseline-captured" : "passed";');
const temporary = join(root, "scripts", `.orderops-cell-borders-${process.pid}.mjs`);
try {
  writeFileSync(temporary, fixture);
  execFileSync(process.execPath, [temporary], { cwd: root, stdio: "inherit", env: process.env, timeout: 240000 });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
