import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");

assert.match(html, /v\d+\.\d+\.\d+_[A-Za-z0-9]+/);

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

assert.deepEqual(
  JSON.parse(JSON.stringify(browser.createMerchEmptyBulkInputs())),
  { theme: "", stock: "", sale: "", linkage: "", spot: "", warehouse: "", reportAction: "" },
  "filter reset must restore every common bulk input to unspecified/keep-existing",
);

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

const bulkPatch = browser.buildMerchBulkFieldPatch({
  theme: "1,2,2,5",
  stock: "0",
  sale: "0",
  linkage: "1",
  spot: "0",
  warehouse: "01",
});
assert.equal(bulkPatch.ok, true);
assert.deepEqual(JSON.parse(JSON.stringify(bulkPatch.inputFields)), ["행사테마", "재고", "판매여부", "연동", "싯가", "창고"]);
assert.equal(bulkPatch.patch.행사테마, "1,2,5");
assert.equal(bulkPatch.patch.테마1, "1");
assert.equal(bulkPatch.patch.테마3, "");
assert.equal(bulkPatch.patch.재고, 0, "numeric stock zero must not become blank");
assert.equal(bulkPatch.patch.재고수량, 0, "stock compatibility field must keep zero");
assert.equal(bulkPatch.patch.판매여부, 0, "sale stop code must remain numeric zero");
assert.equal(bulkPatch.patch.연동, 1);
assert.equal(bulkPatch.patch.단가연동, 1);
assert.equal(bulkPatch.patch.싯가, 0);
assert.equal(bulkPatch.patch.싯가판매여부, 0);
assert.equal(bulkPatch.patch.창고, "01", "warehouse code must preserve the leading zero");
assert.equal(browser.buildMerchBulkFieldPatch({ theme: "1,6" }).ok, false);
assert.equal(browser.buildMerchBulkFieldPatch({ themeAction: "assign", theme: "" }).ok, false,
  "theme designation must require one or more theme numbers");
const deleteThemePatch = browser.buildMerchBulkFieldPatch({ themeAction: "delete" });
assert.equal(deleteThemePatch.ok, true, "theme deletion must be a standalone bulk action");
assert.equal(deleteThemePatch.patch.행사테마, "");
assert.deepEqual(
  [1, 2, 3, 4, 5].map((number) => deleteThemePatch.patch[`테마${number}`]),
  ["", "", "", "", ""],
  "theme deletion must clear the normalized theme and all compatibility flags",
);
assert.deepEqual([...deleteThemePatch.inputFields], ["행사테마 삭제"]);
assert.equal(browser.buildMerchBulkFieldPatch({ stock: "abc" }).ok, false);
assert.equal(browser.buildMerchBulkFieldPatch({}).ok, false);

const reportOnlyPatch = browser.buildMerchBulkFieldPatch({ reportAction: "apply" });
assert.equal(reportOnlyPatch.ok, true, "price report must work without another bulk field");
assert.equal(reportOnlyPatch.reportAction, "apply");
assert.deepEqual([...reportOnlyPatch.inputFields], ["리포트"]);

const fallingRow = {
  코드: "A001",
  finalData: { 입고가: 13000, 간단설명: "국산 · 단가 UP! + 1,000원" },
  sources: {},
};
const fallingReport = browser.getMerchInboundPriceReport(fallingRow, { 입고가: 15000 });
assert.equal(fallingReport.text, "가격이 좋아요! -2,000원");
assert.equal(fallingReport.direction, "fall");
const fallingPatch = browser.buildMerchPriceChangeReportPatch(fallingRow, { 입고가: 15000 }, "apply");
assert.equal(fallingPatch.changed, true);
assert.equal(fallingPatch.patch.간단설명, "국산 · 가격이 좋아요! -2,000원", "a refreshed report must preserve manual copy and replace the old report");

const risingPatch = browser.buildMerchPriceChangeReportPatch(
  { 코드: "B002", finalData: { 입고가: 16500, 간단설명: "" }, sources: {} },
  { 입고가: 15000 },
  "apply",
);
assert.equal(risingPatch.patch.간단설명, "단가 UP! + 1,500원");

const clearPatch = browser.buildMerchPriceChangeReportPatch(
  { 코드: "C003", finalData: { 간단설명: "냉장 · 가격이 좋아요! -2,000원" }, sources: {} },
  { 입고가: 15000 },
  "clear",
);
assert.equal(clearPatch.changed, true);
assert.equal(clearPatch.patch.간단설명, "냉장", "clearing an auto report must preserve other simple-description text");
assert.equal(browser.stripMerchPriceChangeReport("단가 UP! + 1,500원"), "");

assert.equal(
  browser.isMerchNoInboundPrice({ finalData: { 입고가: 0 }, sources: {} }, { 입고가: 9000 }),
  true,
  "an explicit work-table zero must not fall back to the master price",
);
assert.equal(browser.isMerchNoInboundPrice({ finalData: { 입고가: "" }, sources: {} }, { 입고가: 9000 }), true);
assert.equal(browser.isMerchNoInboundPrice({ finalData: { 입고가: 1200 }, sources: {} }, { 입고가: 0 }), false);
assert.equal(browser.isMerchNoInboundPrice({ finalData: {}, sources: {} }, { 입고가: 0 }), true);
assert.equal(browser.isMerchNoInboundPrice({ finalData: {}, sources: {} }, { 입고가: 9000 }), false);

const noInboundQueue = browser.buildMerchNoInboundActionQueue("spot", [
  { 코드: "A001", finalData: { 입고가: 0 }, sources: {} },
  { 코드: "A001", finalData: { 입고가: "" }, sources: {} },
  { 코드: "B002", finalData: { 입고가: "" }, sources: {} },
  { 코드: "C003", finalData: { 입고가: 1200 }, sources: {} },
], {});
assert.equal(noInboundQueue.action, "spot");
assert.deepEqual([...noInboundQueue.codes], ["A001", "B002"], "the queue must keep unique zero/blank inbound-price product codes only");
assert.deepEqual(
  JSON.parse(JSON.stringify(browser.applyMerchNoInboundActionToMaster({ 코드: "A001", 싯가: 0 }, "spot"))),
  { 코드: "A001", 싯가: 1, 싯가판매여부: 1 },
);
assert.equal(browser.applyMerchNoInboundActionToMaster({ 코드: "B002", 판매여부: 1 }, "stop").판매여부, 0);

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
assert.match(html, /const rawLinkage = readOwnedInfoValue\(\[\[finalData, '단가연동'\], \[finalData, '연동'\]/);
assert.doesNotMatch(html, /infoSource\['싯가'\] = window\.keepExcelCellValue\(row\[spotPriceKey\], false\)/);
assert.match(html, /working = window\.applyMerchSpotPriceExcelPriority/);
assert.match(html, /const initialVal = hasFinalField \? row\.finalData\[field\]/);
assert.match(html, /if \(\['싯가판매여부', '시가판매여부'\]\.includes\(clean\)\)\s+return '싯가'/);
assert.match(html, /delete merged\.info\['싯가판매여부'\]/);
assert.match(html, /if \(hasOwn\(targetMaster, '싯가'\)\) targetMaster\['싯가판매여부'\] = targetMaster\['싯가'\]/);

assert.doesNotMatch(html, /handleApplySelectedWarehouse|selectedWarehouseInput/);
assert.match(html, /const handleApplyBulkFields = useCallback/);
assert.match(html, /ui\.selectedRows\.size > 0[\s\S]*fullDisplayRows\.filter[\s\S]*: fullDisplayRows/);
assert.match(html, /value: promoThemeInput[\s\S]*"aria-label": "지정할 행사테마"[\s\S]*"테마지정"/);
assert.match(html, /placeholder: getBulkPlaceholder\('stock', '재고'\)/);
assert.match(html, /getBulkSelectBlankLabel\('sale', '판매'\)/);
assert.match(html, /getBulkSelectBlankLabel\('linkage', '연동'\)/);
assert.match(html, /getBulkSelectBlankLabel\('spot', '싯가'\)/);
assert.match(html, /placeholder: getBulkPlaceholder\('warehouse', '창고'\)/);
assert.match(html, /setFilterScenarioOpen\(false\);\s*resetBulkInputs\(\);/);
assert.match(html, /getBulkSelectBlankLabel = \(field, label\) =>[\s\S]*'지정 안 함\(기존 유지\)'/);
assert.match(html, /React\.createElement\("option", \{ value: "" \}, getBulkSelectBlankLabel\('sale', '판매'\)\)/);
assert.match(html, /React\.createElement\("option", \{ value: "" \}, getBulkSelectBlankLabel\('linkage', '연동'\)\)/);
assert.match(html, /React\.createElement\("option", \{ value: "" \}, getBulkSelectBlankLabel\('spot', '싯가'\)\)/);
assert.doesNotMatch(html, /value: "", disabled: true \}, getBulkSelectBlankLabel\('(sale|linkage|spot)'/);
assert.match(html, /"판매\(1\)"[\s\S]*"정지\(0\)"/);
assert.match(html, /"사용\(1\)"[\s\S]*"사용 안 함\(0\)"/);
assert.match(html, /"적용\(1\)"[\s\S]*"미적용\(0\)"/);
assert.match(html, /_bulkEditedFields/);
assert.match(html, /actionType: '공통 일괄입력'/);
assert.match(html, /source: 'MerchOps bulk'/);
assert.match(html, /type: "checkbox", checked: bulkInputs\.reportAction === 'apply'/);
assert.match(html, /type: "checkbox", checked: bulkInputs\.reportAction === 'clear'/);
assert.match(html, /화면상품 \$\{actionablePlans\.length\.toLocaleString\(\)\}건/);

assert.match(html, /MERCH_DETAIL_FILTER_VALUES = \['noInboundPrice'/);
assert.match(html, /noInboundPrice: '입고가없음'/);
assert.match(html, /data-merch-issue-filter-group": "single"/);
assert.match(html, /selectIssueFilter\('margin'\)[\s\S]*selectIssueFilter\('priceCheck'\)[\s\S]*selectIssueFilter\('noInboundPrice'\)/);
assert.match(html, /data-merch-no-inbound-action": "touch-choice"[\s\S]*'싯가판매'[\s\S]*'판매정지'/);
assert.match(html, /queuedNoInboundCodes[\s\S]*applyMerchNoInboundActionToMaster[\s\S]*setNoInboundActionQueue/);
assert.match(html, /has\('noInboundPrice'\)/);
assert.match(html, /changed: '가격변동', priceCheck: '가격변동'/);
assert.match(html, /}, "가격변동"\)/);
assert.doesNotMatch(html, /가격확인/);
assert.match(html, /excludedReason: '입고가없음'/);

console.log("MerchOps Excel codes, bulk edit, and price-filter tests passed.");

