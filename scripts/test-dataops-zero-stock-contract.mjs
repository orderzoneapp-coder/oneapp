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
assert.match(combinedWorkbook, /const hasScreenRowsForExport = Array\.isArray\(screenRows\)/);
assert.match(
  combinedWorkbook,
  /hasScreenRowsForExport[\s\S]*?buildScreenStockRows\(\{ productData: screenRows, targetDateStr \}\)[\s\S]*?: EXPORT_MODULE\.buildNextBaseStockRows\(\{ productData: operationalProductData, targetDateStr \}\)/,
  "F9 first sheet must preserve explicit empty/current-view rows and use full data only when screenRows is omitted",
);
assert.match(
  combinedWorkbook,
  /const calculationProductData = \(productData \|\| \[\]\)\.filter\(item => !item\._auditOnly\);[\s\S]*?const operationalProductData = DATAOPS_VIEW_LAYER_MODULE\.buildCodeSummaryRows\(calculationProductData\)/,
  "administrator-aware whole-stock data must originate from the complete productData collection",
);

const f9Handler = section(
  "const handleCombinedExport = useCallback",
  "const handlePrintOutput = useCallback",
);
assert.match(
  f9Handler,
  /createCombinedWorkbook\(\{ productData, screenRows: filteredProductDataRef\.current, substHistory, analysisPeriod, targetDateStr, closingStats \}\)/,
  "F9 must feed the current view, including zero rows, to the first sheet while retaining full productData for the other ledgers",
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
