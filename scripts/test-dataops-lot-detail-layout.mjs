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
assert.match(source, /const label = isLotDetailMergeButtonRow \? '선택'/, "the selected-price merge button label must be exactly 선택");
assert.match(source, /isLotDetailMergeButtonRow && isLotReviewGroupStart && React\.createElement\("button"[\s\S]*?}, "평균"\)/, "the average button must be shown once on the group-start row with the exact 평균 label");
assert.doesNotMatch(source, /이 기준 통합|선택원가 통합|평균가 통합/, "retired merge labels must not remain in DataOps");
assert.match(source, /detail-merge-average/);

const mergeModuleStart = source.indexOf("const DATAOPS_CODE_MERGE_OVERRIDE_MODULE");
const mergeModuleEnd = source.indexOf("const roundDataOpsAverageMergePrice", mergeModuleStart);
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

sessionValues.set("dataops_code_merge_override_v1", JSON.stringify({
  LEGACY_DISABLED: { disabled: true },
  LEGACY_MERGED: { detailMerged: true },
  LEGACY_SELECTED: { representativeKey: "OLD-LOT" },
}));
assert.equal(mergeContext.mergeModule.isDisabled("LEGACY_DISABLED"), true);
assert.equal(mergeContext.mergeModule.isDetailMerged("LEGACY_MERGED"), true);
assert.equal(mergeContext.mergeModule.getRepresentativeKey("LEGACY_SELECTED"), "OLD-LOT");
assert.equal(mergeContext.mergeModule.getPriceMode("LEGACY_SELECTED"), "selected");

mergeContext.mergeModule.mergeDetail("CODE-A", "LOT-A");
assert.equal(mergeContext.mergeModule.getRepresentativeKey("CODE-A"), "LOT-A");
assert.equal(mergeContext.mergeModule.getPriceMode("CODE-A"), "selected");
mergeContext.mergeModule.mergeDetailAverage("CODE-A");
assert.equal(mergeContext.mergeModule.getRepresentativeKey("CODE-A"), "");
assert.equal(mergeContext.mergeModule.getPriceMode("CODE-A"), "average");

console.log("DataOps CODE_SUMMARY/LOT_DETAIL layout contract passed.");
