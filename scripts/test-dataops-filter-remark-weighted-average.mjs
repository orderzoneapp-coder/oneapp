#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const start = source.indexOf(marker);
const end = source.indexOf("</script>", start);
new vm.Script(source.slice(start + marker.length, end), { filename: "DataOps.inline.js" });

const mergeStart = source.indexOf("const DATAOPS_CODE_MERGE_OVERRIDE_MODULE =");
const mergeEnd = source.indexOf("const DATAOPS_VIEW_LAYER_MODULE =", mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, "current merge policy module must exist");
const state = new Map();
const context = vm.createContext({
  Date,
  JSON,
  Object,
  Math,
  sessionStorage: {
    getItem: key => state.get(key) ?? null,
    setItem: (key, value) => state.set(key, String(value)),
    removeItem: key => state.delete(key),
  },
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  safeNum: value => Number.isFinite(Number(value)) ? Number(value) : 0,
});
vm.runInContext(`${source.slice(mergeStart, mergeEnd)}\nglobalThis.merge = DATAOPS_CODE_MERGE_OVERRIDE_MODULE;globalThis.roundPrice = roundDataOpsAverageMergePrice;`, context);

context.merge.mergeDetail("A100", "LOT-SELECTED");
assert.equal(context.merge.isDetailMerged("A100"), true);
assert.equal(context.merge.getRepresentativeKey("A100"), "LOT-SELECTED");
assert.equal(context.merge.getPriceMode("A100"), "selected", "selected merge must preserve the administrator-picked LOT price");
context.merge.mergeDetailAverage("A100");
assert.equal(context.merge.isDetailMerged("A100"), true);
assert.equal(context.merge.getRepresentativeKey("A100"), "");
assert.equal(context.merge.getPriceMode("A100"), "average", "average must be an explicit administrator policy, not implicit rematching");
assert.equal(context.roundPrice(3444), 3400);
assert.equal(context.roundPrice(3450), 3500);

const viewStart = source.indexOf("const DATAOPS_VIEW_LAYER_MODULE =");
const viewEnd = source.indexOf("const DATAOPS_EVIDENCE_REPORT_MODULE =", viewStart);
const viewSource = source.slice(viewStart, viewEnd);
assert.match(viewSource, /pickLatestPurchaseRow: \(rows = \[\]\) =>/);
assert.match(viewSource, /dateValue > latestDateValue/, "latest purchase information must be selected by the newest purchase date");
assert.match(viewSource, /const weightedCost = priceRows\.reduce/);
assert.match(viewSource, /const weightedAveragePrice = weightedQty > 0 \? weightedCost \/ weightedQty : null/);
assert.match(viewSource, /roundDataOpsAverageMergePrice\(weightedAveragePrice\)/, "weighted average must be rounded once at the final 100-won boundary");
assert.match(viewSource, /costBasisMode === 'average'/);
assert.match(viewSource, /const purchaseInfoRow = latestPositiveRow/, "selected and average merge modes must retain latest positive purchase metadata");
assert.doesNotMatch(viewSource, /item\.단가\s*=\s*averagePrice/, "view calculation must not mutate a source LOT price");

assert.match(source, /onToggleCodeMerge: handleToggleCodeMerge/);
assert.match(source, /action === 'detail-merge-average'/);
assert.match(source, /action === 'detail-merge'/);
assert.match(source, /action === 'detail-split'/);

console.log("PASS test-dataops-filter-remark-weighted-average");
