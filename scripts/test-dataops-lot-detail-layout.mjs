#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const start = source.indexOf(marker);
const end = source.lastIndexOf("</script>");
assert.ok(start >= 0 && end > start, "DataOps main script block must exist");
new vm.Script(source.slice(start + marker.length, end), { filename: "DataOps.inline.js" });

assert.match(
  source,
  /const manageMode = explicitMode \|\| \(legacySeparate \? 'LOT_DETAIL' : DATAOPS_DEFAULT_GROUPING\.manageMode\);/,
  "inventory grouping must preserve explicit CODE_SUMMARY and LOT_DETAIL modes",
);
assert.match(
  source,
  /getSavedViewMode: \(\) => \{[\s\S]*?CODE_SUMMARY[\s\S]*?LOT_DETAIL[\s\S]*?\}/,
  "saved view mode must restore CODE_SUMMARY or LOT_DETAIL",
);
assert.match(
  source,
  /\[\['CODE_SUMMARY', '코드 통합형'\], \['LOT_DETAIL', 'Lot 상세형'\]\]/,
  "the global view toggle must remain available",
);
assert.match(
  source,
  /buildViewRows: \(rows = \[\], options = \{\}\) => \{[\s\S]*?buildLotDetailRows[\s\S]*?buildCodeSummaryRows/,
  "the view layer must implement both detail and summary algorithms",
);
assert.match(
  source,
  /const handleRunAnalysis = useCallback[\s\S]*?setViewMode\('LOT_DETAIL'\)/,
  "a new analysis must start in LOT_DETAIL",
);
assert.match(
  source,
  /onToggleCodeMerge: handleToggleCodeMerge/,
  "per-product merge and split actions must remain connected",
);
assert.match(source, /getPriceMode: \(code = ''\) =>/);
assert.match(source, /priceMode: 'selected'/);
assert.match(source, /mergeDetailAverage: \(code = ''\) =>/);
assert.match(source, /priceMode: 'average'/);
assert.match(source, /const mergePriceMode = DATAOPS_CODE_MERGE_OVERRIDE_MODULE\.getPriceMode\(code\)/);
assert.match(source, /const costBasisMode = mergePriceMode \|\| DATAOPS_VIEW_LAYER_MODULE\.getCostBasisMode\(\)/);
assert.match(source, /const weightedAveragePrice = weightedQty > 0 \? weightedCost \/ weightedQty : null/);
assert.match(source, /mergePriceMode === 'average' \? roundDataOpsAverageMergePrice\(weightedAveragePrice\) : Math\.round\(weightedAveragePrice\)/);
assert.match(source, /qtyForPrice = \(row = \{\}\) => Math\.max\(0, DATAOPS_VIEW_LAYER_MODULE\.getRowStockQty\(row\)\)/);
assert.match(source, /선택원가 통합/);
assert.match(source, /평균가 통합/);
assert.match(source, /detail-merge-average/);

const mergeModuleStart = source.indexOf("const DATAOPS_CODE_MERGE_OVERRIDE_MODULE");
const mergeModuleEnd = source.indexOf("const DATAOPS_VIEW_LAYER_MODULE", mergeModuleStart);
assert.ok(mergeModuleStart >= 0 && mergeModuleEnd > mergeModuleStart);
const sessionValues = new Map();
const mergeContext = vm.createContext({
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  sessionStorage: {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, String(value)),
    removeItem: (key) => sessionValues.delete(key),
  },
});
new vm.Script(
  `${source.slice(mergeModuleStart, mergeModuleEnd)}\nglobalThis.mergeModule = DATAOPS_CODE_MERGE_OVERRIDE_MODULE;`,
).runInContext(mergeContext);
mergeContext.mergeModule.mergeDetail("CODE-A", "LOT-A");
assert.equal(mergeContext.mergeModule.getRepresentativeKey("CODE-A"), "LOT-A");
assert.equal(mergeContext.mergeModule.getPriceMode("CODE-A"), "selected");
mergeContext.mergeModule.mergeDetailAverage("CODE-A");
assert.equal(mergeContext.mergeModule.getRepresentativeKey("CODE-A"), "");
assert.equal(mergeContext.mergeModule.getPriceMode("CODE-A"), "average");
console.log("DataOps CODE_SUMMARY/LOT_DETAIL layout contract passed.");
