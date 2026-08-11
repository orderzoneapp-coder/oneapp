#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const mainScriptMarker = '<script type="text/javascript">';
const mainScriptStart = source.indexOf(mainScriptMarker);
const mainScriptEnd = source.lastIndexOf("</script>");
assert.notEqual(mainScriptStart, -1, "Missing DataOps main script block");
assert.ok(mainScriptEnd > mainScriptStart, "Missing DataOps main script closing tag");
new vm.Script(
  source.slice(mainScriptStart + mainScriptMarker.length, mainScriptEnd),
  { filename: "DataOps.inline.js" },
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);

  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);

  return source.slice(start, end);
}

const datedV110Version =
  "V1.a22.110_WorkSaveCloudInventorySync · 2026-08-08 KST";
const v110ConfigVersion = "V1.a22.110_WorkSaveCloudInventorySync";
const datedV111Version =
  "V1.a22.111_WorkSaveCloudInventorySync · 2026-08-08 KST";
const v111ConfigVersion = "V1.a22.111_WorkSaveCloudInventorySync";
const isCompatibleV110OrV111 =
  (source.split(datedV110Version).length - 1 === 3 &&
    new RegExp(`version:\\s*'${v110ConfigVersion}'`).test(source)) ||
  (source.split(datedV111Version).length - 1 === 3 &&
    new RegExp(`version:\\s*'${v111ConfigVersion}'`).test(source));
if (isCompatibleV110OrV111) {
  const workbook = section("createCombinedWorkbook:", "const STORAGE_MODULE");
  assert.doesNotMatch(workbook, /\bscreenRows\b/);
  assert.match(workbook, /const operationalProductData = DATAOPS_VIEW_LAYER_MODULE\.buildCodeSummaryRows\(productData \|\| \[\]\)/, "V110 F9 must summarize complete productData");
  assert.match(workbook, /buildNextBaseStockRows\(\{\s*productData:\s*operationalProductData,\s*targetDateStr\s*\}\)/, "V110 whole-stock must use code-summary rows");
  for (const sheet of ["전체재고", "구매잔량", "기타상품", "실사양식", "확인요청", "재고수불_마감", "수불마감_분석원장", "소분치환_후보", "마스터_확인필요", "보고서"]) assert.match(workbook, new RegExp(`'${sheet}'`), `missing V110 sheet: ${sheet}`);
  assert.match(section("buildNextBaseStockRows:", "buildScreenStockRows:"), /\.filter\(item => STOCK_ENGINE_MODULE\.getActualQty\(item\) > 0\)/, "V110 next-day stock must retain positive balances only");
  console.log("DataOps V110 zero/negative stock and F9 full-data contract passed.");
  process.exit(0);
}

const executeAnalysis = section(
  "const executeAnalysis = useCallback",
  "const runAnalysis = useCallback",
);
assert.doesNotMatch(
  executeAnalysis,
  /\.filter\(item => !\(item\.기초 === 0 && item\.입고 === 0/,
  "executeAnalysis must preserve all-zero rows during analysis",
);

const costExtraction = section(
  "const runCostExtraction = useCallback",
  "const IssueChip =",
);
assert.doesNotMatch(
  costExtraction,
  /if \(actualQty <= 0\)\s*return;/,
  "cost extraction must not discard zero or negative stock rows",
);
assert.match(costExtraction, /const makeNonPositiveStockRow = \(\) =>/);
assert.match(costExtraction, /actualQty < 0 \? 'NEGATIVE_STOCK' : 'ZERO_STOCK'/);
assert.match(costExtraction, /if \(actualQty <= 0\) \{\s*makeNonPositiveStockRow\(\);/);
assert.doesNotMatch(
  costExtraction,
  /\.filter\(item => !\(item\.기초 === 0 && item\.입고 === 0/,
  "cost extraction result must preserve all-zero rows",
);

const screenStockRows = section(
  "buildScreenStockRows:",
  "buildNextBaseStockSheet:",
);
assert.doesNotMatch(
  screenStockRows,
  /getActualQty\(item\) > 0/,
  "screen-derived rows must not silently remove zero stock",
);

const combinedWorkbook = section(
  "createCombinedWorkbook:",
  "const STORAGE_MODULE",
);
assert.doesNotMatch(combinedWorkbook, /\bscreenRows\b/);
assert.match(
  combinedWorkbook,
  /buildNextBaseStockRows\(\{ productData: operationalProductData, targetDateStr \}\)/,
  "F9 whole-stock sheet must use the administrator-aware summary built from complete productData",
);
assert.match(
  combinedWorkbook,
  /const operationalProductData = DATAOPS_VIEW_LAYER_MODULE\.buildCodeSummaryRows\(productData \|\| \[\]\)/,
  "administrator-aware whole-stock data must originate from the complete productData collection",
);

const f9Handler = section(
  "const handleCombinedExport = useCallback",
  "const handlePrintOutput = useCallback",
);
assert.doesNotMatch(f9Handler, /filteredProductDataRef/);
assert.match(
  f9Handler,
  /createCombinedWorkbook\(\{ productData: closingProductData, analysisPeriod, targetDateStr, closingStats, wholeStockRows: closingRows \}\)/,
  "F9 must feed one frozen full closing-row set to the workbook and cloud snapshot",
);

const nextBaseRows = section(
  "buildNextBaseStockRows:",
  "buildScreenStockRows:",
);
assert.match(
  nextBaseRows,
  /\.filter\(item => STOCK_ENGINE_MODULE\.getActualQty\(item\) > 0\)/,
  "next-day base-stock generation must require a positive actual balance",
);

assert.match(
  source,
  /if \(filters\.excludeZeroActual\)\s*data = data\.filter/,
  "the explicit UI zero-stock filter must remain available",
);

console.log("DataOps zero/negative stock contract passed.");
