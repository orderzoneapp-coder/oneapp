import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");

assert.match(html, /v2\.1\.154_SpotPriceExcelPriority/);

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim() !== "");
assert.ok(inlineScripts.length >= 3, "MerchOps inline scripts were not found");
inlineScripts.forEach((script, index) => new vm.Script(script, { filename: `MerchOps-inline-${index + 1}.js` }));

const browser = {};
const context = vm.createContext({
  window: browser,
  document: {
    getElementById: () => null,
    createElement: () => ({
      style: {},
      appendChild() {},
      append() {},
      remove() {},
      addEventListener() {},
      querySelector: () => ({}),
      focus() {},
    }),
    body: { appendChild() {} },
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  indexedDB: {},
  crypto: { randomUUID: () => "test-uuid" },
  console,
  Date,
  Map,
  Set,
  Number,
  Object,
  String,
  Array,
  Math,
});
vm.runInContext(inlineScripts[0], context, { filename: "MerchOps-head.js" });

assert.equal(browser.keepExcelCellValue(1, false), 1, "numeric Excel spot-price flag 1 must remain 1");
assert.equal(browser.keepExcelCellValue("1", false), "1", "formatted Excel spot-price flag must remain original text");
assert.equal(browser.keepExcelCellValue(0, false), 0, "numeric Excel spot-price flag 0 must remain 0");

const sourceOne = { _activeRole: "info", info: { 싯가: 1 } };
assert.deepEqual(
  JSON.parse(JSON.stringify(browser.getMerchSpotPriceSourceCell(sourceOne))),
  { hasValue: true, value: 1, role: "info", field: "싯가" },
);
const appliedOne = browser.applyMerchSpotPriceExcelPriority({ 싯가: "" }, sourceOne);
assert.equal(appliedOne.싯가, 1, "Excel spot-price value must override the working/master fallback");
assert.equal(appliedOne._spotPricePolicy, "excel_original_first");

const legacySource = { _activeRole: "info", info: { 싯가판매여부: "1" } };
const appliedLegacy = browser.applyMerchSpotPriceExcelPriority({ 싯가: "" }, legacySource);
assert.equal(appliedLegacy.싯가, "1", "legacy saved source must migrate without losing the cell value");

assert.match(html, /'싯가': '싯가, 싯가판매여부, 시가판매여부'/);
assert.match(html, /'싯가': '싯가'/);
assert.match(html, /infoSource\['싯가'\] = window\.keepExcelCellValue\(row\[spotPriceKey\], false\)/);
assert.match(html, /working = window\.applyMerchSpotPriceExcelPriority/);
assert.match(html, /const initialVal = hasFinalField \? row\.finalData\[field\]/);
assert.match(html, /if \(\['싯가판매여부', '시가판매여부'\]\.includes\(clean\)\)\s+return '싯가'/);
assert.match(html, /delete merged\.info\['싯가판매여부'\]/);
assert.match(html, /if \(hasOwn\(targetMaster, '싯가'\)\) targetMaster\['싯가판매여부'\] = targetMaster\['싯가'\]/);

console.log("MerchOps Excel spot-price mapping and source-priority tests passed.");
