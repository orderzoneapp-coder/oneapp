import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
assert.match(html, /v2\.1\.156_LinkageExcelCode/);
assert.doesNotMatch(html, /v2\.1\.151_ResetVerticalAlign/);
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim() !== "");

assert.ok(inlineScripts.length >= 3, "MerchOps.html inline scripts were not found");
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

assert.equal(browser.normalizeMerchSaleAvailability(0), "0", "numeric zero must remain a sale-stop value");
assert.equal(browser.normalizeMerchSaleAvailability("false"), "0");
assert.equal(browser.normalizeMerchSaleAvailability("판매중"), "1");
assert.equal(browser.normalizeMerchSaleAvailability(""), "");

const estimateStopped = {
  _lastUploadRole: "estimate",
  sources: { _activeRole: "estimate", estimate: { 판매여부: "0" } },
  finalData: { 판매여부: "0" },
};
const inventorySelling = {
  _lastUploadRole: "inventory",
  sources: { _activeRole: "inventory", inventory: { 판매: 1 } },
  finalData: { 판매: 1 },
};

assert.deepEqual(
  JSON.parse(JSON.stringify(browser.getMerchExplicitSaleAvailability(estimateStopped))),
  { hasValue: true, code: "0", raw: "0", field: "판매여부", origin: "source:estimate" },
);
assert.equal(browser.getMerchExplicitSaleAvailability(inventorySelling).code, "1");
assert.equal(browser.resolveMerchSaleAvailability(estimateStopped, { 판매여부: 1 }).code, "0");

assert.match(html, /const saleKey = headerCache\['판매'\] \|\| headerCache\['판매여부'\]/);
assert.match(html, /_saleAvailabilitySourceHeader/);
assert.equal(
  (html.match(/withMerchSaleAvailabilityColumn\(window\.filterMerchInfoWorkColumns/g) || []).length,
  2,
  "the workbench row and header must share the sale-column policy",
);

const f8Start = html.indexOf("const getSaleCode = (row) => {");
const f8End = html.indexOf("const getShopSalePrice", f8Start);
assert.ok(f8Start >= 0 && f8End > f8Start, "Quick F8 sale resolver was not found");
const f8Block = html.slice(f8Start, f8End);
assert.ok(
  f8Block.indexOf("if (explicitSale.hasValue) return explicitSale.code;") <
    f8Block.indexOf("if (isEstimateQuickRow(row)) return '1';"),
  "Quick F8 must honor an explicit Excel sale value before the estimate default",
);

assert.match(html, /actionType: '엑셀 판매여부 반영'/);
assert.match(html, /window\.resolveMerchSaleAvailability\(current, mItem\)/);
assert.match(html, /판매여부: mItem\['판매여부'\] \?\? ''/);

console.log("MerchOps sale availability pipeline tests passed.");
