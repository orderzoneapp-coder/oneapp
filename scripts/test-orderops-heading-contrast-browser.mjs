import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse the real canonical-page intake/recovery/browser fixture, not a simplified
// CSS mock. The generated harness is temporary; production HTML is never edited.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readFileSync(join(root, "scripts/test-orderops-excel-preparation-browser.mjs"), "utf8");
const anchor = '  await selectPreview("allocations");';
assert.ok(fixture.includes(anchor), "Canonical fixture must select calculated orders after intake");
const baselineRef = process.env.ORDEROPS_HEADING_BASELINE;
const baselineCss = baselineRef ? execFileSync("git", ["show", `${baselineRef}:orderops/excel-preparation.css`], { cwd: root, encoding: "utf8" }) : null;
const injection = `
  report.headingContrast = [];
  const headingRead = () => ev("(() => { const cells=[...document.querySelectorAll('#previewTable table.preview-allocations thead th')]; return cells.map(th=>{const s=getComputedStyle(th),label=th.querySelector('.column-header-label');return {text:label?.textContent,foreground:getComputedStyle(label||th).color,background:s.backgroundColor,weight:s.fontWeight,size:s.fontSize,position:s.position,border:s.borderBottomWidth};});})()");
  const headingContrast = (foreground, background) => {
    const luminance = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    return (values[1] + .05) / (values[0] + .05);
  };
  const headingOriginalTheme = await ev("document.documentElement.dataset.nexusUiTheme");
  const headingWorkspace = await ev("JSON.stringify(__ops.state.workspace)");
  const headingBaselineCss = ${JSON.stringify(baselineCss)};
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 768]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await ev("document.documentElement.dataset.nexusUiTheme=" + JSON.stringify(theme) + ";true");
      const cells = await headingRead();
      check("order headings: " + theme + " " + width + " use paired navy/white and bold 13px type", cells.length > 5 && cells.every(c => c.foreground === "rgb(255, 255, 255)" && c.background === "rgb(22, 50, 79)" && c.weight === "900" && c.size === "13px" && c.border === "3px" && c.position === "sticky"));
      const ratio = Math.min(...cells.map(c => headingContrast(c.foreground, c.background)));
      check("order headings: " + theme + " " + width + " contrast at least 7:1", ratio >= 7);
      for (const stateClass of ["column-sorted", "column-filtered"]) {
        await ev("document.querySelector('#previewTable table.preview-allocations thead th').classList.add(" + JSON.stringify(stateClass) + ");true");
        const special = (await headingRead())[0];
        check("order headings: " + theme + " " + width + " " + stateClass + " stays readable", special.foreground === "rgb(167, 243, 208)" && headingContrast(special.foreground, special.background) >= 7);
        await ev("document.querySelector('#previewTable table.preview-allocations thead th').classList.remove(" + JSON.stringify(stateClass) + ");true");
      }
      await ev("document.querySelector('#previewTable').scrollIntoView({block:'center'});true");
      await shot("heading-" + theme + "-" + width);
      report.headingContrast.push({ theme, width, ratio, cells });
    }
  }
  if (headingBaselineCss) {
    const unaffected = "JSON.stringify([...document.querySelectorAll('#previewTable tbody td,#previewTable tbody input,.nexus-ui-header,.global-header,#prepPreviewTabs button')].map(e=>{const s=getComputedStyle(e);return [s.color,s.backgroundColor,s.fontWeight,s.fontSize];}))";
    const currentUnaffected = await ev(unaffected);
    await ev("(()=>{document.querySelector('link[href*=\\\"excel-preparation.css\\\"]').disabled=true;const style=document.createElement('style');style.id='heading-baseline-test';style.textContent=" + JSON.stringify(headingBaselineCss) + ";document.head.append(style);return true;})()");
    const oldCells = await headingRead();
    const oldRatio = Math.min(...oldCells.map(c => headingContrast(c.foreground, c.background)));
    check("original reported dark-theme ivory/light-ink defect is reproduced in the actual app", oldRatio < 2);
    assert.equal(await ev(unaffected), currentUnaffected, "Body, controls and headers remain unchanged");
    report.headingBaseline = { ratio: oldRatio, cells: oldCells };
    await ev("document.querySelector('#heading-baseline-test').remove();document.querySelector('link[href*=\\\"excel-preparation.css\\\"]').disabled=false;true");
  }
  assert.equal(await ev("JSON.stringify(__ops.state.workspace)"), headingWorkspace, "Visual verification must not mutate order data");
  await ev("document.documentElement.dataset.nexusUiTheme=" + JSON.stringify(headingOriginalTheme) + ";window.scrollTo(0,0);true");
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
`;
const temporary = join(root, "scripts", `.orderops-heading-browser-${process.pid}.mjs`);
try {
  writeFileSync(temporary, fixture.replace(anchor, anchor + injection));
  execFileSync(process.execPath, [temporary], { cwd: root, stdio: "inherit", env: process.env, timeout: 240000 });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
