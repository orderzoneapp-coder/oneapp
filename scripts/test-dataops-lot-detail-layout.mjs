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
assert.doesNotMatch(source, /\[\['PURCHASE_BALANCE', '구매잔량'\], \['OTHER_STOCK', '기타상품'\]\]/);
assert.doesNotMatch(source, /if \(filters\.stockListType === 'PURCHASE_BALANCE'\)/);

console.log("DataOps CODE_SUMMARY/LOT_DETAIL layout contract passed.");
