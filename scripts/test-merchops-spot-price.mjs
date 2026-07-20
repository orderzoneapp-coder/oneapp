import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");

assert.match(html, /v2\.1\.156_LinkageExcelCode/);

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

const estimateImport = {};
const estimateImportResult = browser.copyMerchSpotPriceFromExcelRow(
  estimateImport,
  { 품목코드: "101010111", 싯가: 1 },
  ["품목코드", "싯가"],
  {},
);
assert.deepEqual(
  JSON.parse(JSON.stringify(estimateImportResult)),
  { found: true, header: "싯가", value: 1 },
  "the basic-reset workbook header must be recognized without info-role mappings",
);
assert.equal(estimateImport.싯가, 1, "estimate-role import must keep Excel numeric 1");
assert.equal(estimateImport._spotPriceSourceHeader, "싯가");

const aliasImport = {};
browser.copyMerchSpotPriceFromExcelRow(
  aliasImport,
  { "싯가판매여부": "1" },
  ["싯가판매여부"],
  {},
);
assert.equal(aliasImport.싯가, "1", "legacy header aliases must populate canonical 싯가");

const blankImport = {};
browser.copyMerchSpotPriceFromExcelRow(blankImport, { 싯가: "" }, ["싯가"], {});
assert.ok(Object.hasOwn(blankImport, "싯가"), "an explicit blank Excel cell must still exist in the source");
assert.equal(blankImport.싯가, "");

assert.equal(browser.normalizeMerchLinkageCode(1), 1, "numeric Excel linkage flag 1 must remain numeric 1");
assert.equal(browser.normalizeMerchLinkageCode("1"), 1, "text Excel linkage flag 1 must normalize to numeric 1");
assert.equal(browser.normalizeMerchLinkageCode("사용"), 1, "legacy master label 사용 must normalize to numeric 1");
assert.equal(browser.normalizeMerchLinkageCode(0), 0, "numeric Excel linkage flag 0 must remain numeric 0");
assert.equal(browser.normalizeMerchLinkageCode("미사용"), 0, "legacy master label 미사용 must normalize to numeric 0");
assert.equal(browser.normalizeMerchLinkageCode(""), "", "explicit blank linkage cells must remain blank");

const linkageImport = {};
const linkageImportResult = browser.copyMerchLinkageFromExcelRow(
  linkageImport,
  { 품목코드: "101010111", 연동: 1 },
  ["품목코드", "연동"],
  {},
);
assert.deepEqual(
  JSON.parse(JSON.stringify(linkageImportResult)),
  { found: true, header: "연동", value: 1 },
  "the basic-reset workbook 연동 header must be recognized for every import role",
);
assert.equal(linkageImport.연동, 1, "work-table linkage must display Excel numeric 1");
assert.equal(linkageImport.단가연동, 1, "upload field 단가연동 must keep numeric 1");
assert.equal(linkageImport._linkageSourceHeader, "연동");

const linkageAliasImport = {};
browser.copyMerchLinkageFromExcelRow(
  linkageAliasImport,
  { 단가연동: "사용" },
  ["단가연동"],
  {},
);
assert.equal(linkageAliasImport.연동, 1, "단가연동 alias must normalize the legacy 사용 label to numeric 1");
assert.equal(linkageAliasImport.단가연동, 1);

const estimateSource = { _activeRole: "estimate", estimate: { 싯가: 1 } };
const appliedEstimate = browser.applyMerchSpotPriceExcelPriority({ 싯가: "" }, estimateSource);
assert.equal(appliedEstimate.싯가, 1, "estimate Excel spot-price must override a blank master value");

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
assert.match(html, /window\.copyMerchSpotPriceFromExcelRow\(mItem\.sources\[role\], row, actualHeaders, headerCache\)/);
assert.match(html, /window\.copyMerchLinkageFromExcelRow\(mItem\.sources\[role\], row, actualHeaders, headerCache\)/);
assert.match(html, /const rawLinkage = getFirstInfoValue\(finalData\['단가연동'\], finalData\['연동'\]/);
assert.doesNotMatch(html, /infoSource\['싯가'\] = window\.keepExcelCellValue\(row\[spotPriceKey\], false\)/);
assert.match(html, /working = window\.applyMerchSpotPriceExcelPriority/);
assert.match(html, /const initialVal = hasFinalField \? row\.finalData\[field\]/);
assert.match(html, /if \(\['싯가판매여부', '시가판매여부'\]\.includes\(clean\)\)\s+return '싯가'/);
assert.match(html, /delete merged\.info\['싯가판매여부'\]/);
assert.match(html, /if \(hasOwn\(targetMaster, '싯가'\)\) targetMaster\['싯가판매여부'\] = targetMaster\['싯가'\]/);

console.log("MerchOps Excel spot-price and linkage-code mapping tests passed.");
