#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const fixture = JSON.parse(
  fs.readFileSync("scripts/fixtures/dataops-code-summary-view.json", "utf8"),
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const mainScriptMarker = '<script type="text/javascript">';
const mainScriptStart = source.indexOf(mainScriptMarker);
const mainScriptEnd = source.lastIndexOf("</script>");
assert.notEqual(mainScriptStart, -1, "Missing DataOps main script block");
assert.ok(mainScriptEnd > mainScriptStart, "Missing DataOps main script closing tag");
new vm.Script(
  source.slice(mainScriptStart + mainScriptMarker.length, mainScriptEnd),
  { filename: "DataOps.inline.js" },
);

assert.match(
  source,
  /\[\['CODE_SUMMARY', '\uCF54\uB4DC \uD1B5\uD569\uD615'\], \['LOT_DETAIL', 'Lot \uC0C1\uC138\uD615'\]\]/,
  "the global CODE_SUMMARY/LOT_DETAIL toggle must be visible",
);
assert.match(
  source,
  /getSavedViewMode:\s*\(\)\s*=>\s*\{[\s\S]*?CODE_SUMMARY[\s\S]*?LOT_DETAIL[\s\S]*?\}/,
  "the saved view mode must restore CODE_SUMMARY or LOT_DETAIL",
);
assert.match(
  source,
  /buildViewRows:\s*\(rows = \[\], options = \{\}\)\s*=>\s*\{[\s\S]*?buildLotDetailRows[\s\S]*?buildCodeSummaryRows/,
  "buildViewRows must select the requested view algorithm",
);
assert.match(
  source,
  /const handleRunAnalysis = useCallback[\s\S]*?setViewMode\('LOT_DETAIL'\)/,
  "every newly uploaded analysis must still start in LOT_DETAIL",
);
assert.match(
  source,
  /onToggleCodeMerge:\s*handleToggleCodeMerge/,
  "per-product merge and split controls must remain connected",
);
assert.doesNotMatch(
  source,
  /코드 통합형의 원본 1행 상품은 현재 화면에서 바로 수정할 수 있습니다/,
  "the ambiguous protected-view edit alert must be removed",
);
const viewEditTransitionSource = section(
  "const handleViewLayerEditBlocked = useCallback",
  "// ProductRow의 React.memo",
);
assert.match(viewEditTransitionSource, /setViewMode\('LOT_DETAIL'\)/, "protected CODE_SUMMARY edits must switch to LOT_DETAIL");
assert.match(viewEditTransitionSource, /manageMode: 'LOT_DETAIL'/, "the grouping state must follow the LOT_DETAIL transition");
assert.match(viewEditTransitionSource, /isDetailMerged\(code\)/, "the transition must detect a protected detail merge for only the edited code");
assert.match(viewEditTransitionSource, /splitDetail\(code\)/, "the transition must split only the edited code");
assert.match(viewEditTransitionSource, /setMergeOverrideVersion\(version => version \+ 1\)/, "a detail split must refresh the merge view state");
assert.match(viewEditTransitionSource, /focusBatchKey[\s\S]*?querySelector\(`tr\[data-batch=/, "the original representative/source Lot must be focused when available");
assert.match(source, /onViewLayerEditBlocked\(item\)/, "ProductRow edit paths must pass the protected VIEW row to the transition");
assert.match(source, /onOpenMemo\(operationBatchKey, visibleMemoText \|\| '', item\)/, "VIEW-row memo actions must use the same automatic transition");

const safeStr = (value, fallback = "") => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim() || fallback;
};
const safeNum = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateNumber = (value) => {
  const digits = safeStr(value).replace(/[^0-9]/g, "");
  return digits.length >= 8 ? Number(digits.slice(0, 8)) : 0;
};
const stockQty = (row = {}) => {
  if (!(row["\uC2E4\uC0AC"] === "" || row["\uC2E4\uC0AC"] === null || row["\uC2E4\uC0AC"] === undefined)) {
    return safeNum(row["\uC2E4\uC0AC"]);
  }
  return (
    safeNum(row["\uAE30\uCD08"]) +
    safeNum(row["\uC785\uACE0"]) +
    safeNum(row["\uB300\uCCB4\uC785\uACE0"]) -
    safeNum(row["\uCD9C\uACE0"]) -
    safeNum(row["\uB300\uCCB4\uCD9C\uACE0"])
  );
};

const localStore = new Map();
const sessionStore = new Map();
const context = vm.createContext({
  console,
  Date,
  Map,
  Set,
  JSON,
  Object,
  Array,
  String,
  Number,
  Math,
  safeStr,
  safeNum,
  extractDateNum: dateNumber,
  formatStrForPeriod: (value) => {
    const digits = String(value || "").padStart(8, "0");
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  },
  readSavedDataOpsGrouping: () => ({ priceMode: "latest" }),
  getDataOpsPriceModeLabel: () => "latest",
  DATAOPS_ISSUE_HELPER: {
    unique: (values = []) => [...new Set(values.filter(Boolean))],
  },
  DATAOPS_VENDOR_CHIP_MODULE: {
    normalizeDisplayVendor: (key, data = {}) =>
      safeStr(data.displayVendor || key, "UNKNOWN"),
  },
  STOCK_ENGINE_MODULE: {
    calculateStock: (row = {}) => ({ finalQty: stockQty(row) }),
    getActualQty: stockQty,
  },
  FILTER_SORT_MODULE: {
    getPurchaseDateSortValue: (row = {}) =>
      dateNumber(row["\uC77C\uC790"]) || 99999999,
    compareByCodeThenName: (a = {}, b = {}) =>
      safeStr(a["\uCF54\uB4DC"] || a.code || "NO_CODE").localeCompare(
        safeStr(b["\uCF54\uB4DC"] || b.code || "NO_CODE"),
        "ko",
      ) ||
      dateNumber(a["\uC77C\uC790"]) - dateNumber(b["\uC77C\uC790"]),
  },
  localStorage: {
    getItem: (key) => localStore.get(String(key)) ?? null,
    setItem: (key, value) => localStore.set(String(key), String(value)),
    removeItem: (key) => localStore.delete(String(key)),
  },
  sessionStorage: {
    getItem: (key) => sessionStore.get(String(key)) ?? null,
    setItem: (key, value) => sessionStore.set(String(key), String(value)),
    removeItem: (key) => sessionStore.delete(String(key)),
  },
});
context.window = context;
context.self = context;
context.globalThis = context;

const viewLayerSource = section(
  "const DATAOPS_CODE_MERGE_OVERRIDE_MODULE",
  "\nconst EXPORT_MODULE",
);
new vm.Script(
  `${viewLayerSource}\n` +
    "globalThis.viewLayer = DATAOPS_VIEW_LAYER_MODULE; globalThis.codeMerge = DATAOPS_CODE_MERGE_OVERRIDE_MODULE;",
  { filename: "DataOps.code-summary-view.js" },
).runInContext(context);

const originalSnapshot = JSON.stringify(fixture.lots);
assert.equal(context.viewLayer.getSavedViewMode(), "LOT_DETAIL");
assert.equal(context.viewLayer.saveViewMode("CODE_SUMMARY"), "CODE_SUMMARY");
assert.equal(context.viewLayer.getSavedViewMode(), "CODE_SUMMARY");
assert.equal(context.viewLayer.saveViewMode("LOT_DETAIL"), "LOT_DETAIL");

const detailRows = Array.from(
  context.viewLayer.buildViewRows(fixture.lots, { viewMode: "LOT_DETAIL" }),
);
const summaryRows = Array.from(
  context.viewLayer.buildViewRows(fixture.lots, { viewMode: "CODE_SUMMARY" }),
);
assert.equal(detailRows.length, 2, "LOT_DETAIL must preserve both source Lots");
assert.equal(summaryRows.length, 1, "CODE_SUMMARY must merge the same product code");
const summary = summaryRows[0];
assert.equal(summary["\uAE30\uCD08"], 13);
assert.equal(summary["\uC785\uACE0"], 600);
assert.equal(summary["\uCD9C\uACE0"], 517);
assert.equal(summary["\uC2E4\uC0AC"], 96);
assert.equal(summary._viewMode, "CODE_SUMMARY");
assert.deepEqual(Array.from(summary._viewSourceKeys), [
  "GREEN-ONION-PREV",
  "GREEN-ONION-IN",
]);
assert.equal(
  Object.values(summary["\uCD9C\uACE0\uB0B4\uC5ED"]).reduce(
    (total, detail) => total + safeNum(detail.qty),
    0,
  ),
  517,
  "merged vendor chips must equal merged outbound quantity",
);
context.viewLayer.buildViewRows(fixture.lots, { viewMode: "LOT_DETAIL" });
context.viewLayer.buildViewRows(fixture.lots, { viewMode: "CODE_SUMMARY" });
assert.equal(
  JSON.stringify(fixture.lots),
  originalSnapshot,
  "summary/detail round trips must not mutate source Lots or Source Ledger",
);

context.codeMerge.clear();
context.codeMerge.split("101020114");
const splitSummaryRows = Array.from(
  context.viewLayer.buildViewRows(fixture.lots, { viewMode: "CODE_SUMMARY" }),
);
assert.equal(splitSummaryRows.length, 2, "a merged code must be expandable to its source Lots");
assert.ok(splitSummaryRows.every((row) => row._mergeDisabled === true));
context.codeMerge.mergeWithRepresentative("101020114", "GREEN-ONION-IN");
const remergedRows = Array.from(
  context.viewLayer.buildViewRows(fixture.lots, { viewMode: "CODE_SUMMARY" }),
);
assert.equal(remergedRows.length, 1, "an expanded code must merge again without changing source Lots");
assert.equal(remergedRows[0]._representativeSourceKey, "GREEN-ONION-IN");
assert.equal(JSON.stringify(fixture.lots), originalSnapshot);
context.codeMerge.clear();

console.log("DataOps CODE_SUMMARY view regression contract passed.");
