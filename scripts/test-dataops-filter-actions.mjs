#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const start = source.indexOf(marker);
const end = source.indexOf("</script>", start);
assert.ok(start >= 0 && end > start, "DataOps main script block must exist");
new vm.Script(source.slice(start + marker.length, end), { filename: "DataOps.inline.js" });

const moduleStart = source.indexOf("const FILTER_SORT_MODULE =");
const moduleEnd = source.indexOf("/* =======================================================================", moduleStart);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "current filter/sort module must exist");
const context = vm.createContext({
  safeNum: value => Number.isFinite(Number(value)) ? Number(value) : 0,
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  UTIL_MODULE: { normalizeText: value => String(value ?? "").trim().toLowerCase() },
  DATA_MODEL_MODULE: { fromLegacyRow: row => row },
  CONFIG_MODULE: {
    defaultFavoriteVendors: ["우리농산"],
    defaultUnitFilter: { BOX: false, EA: false, SPLIT: false },
    getUnitRules: () => ({}),
  },
  defaultMappings: {},
  formatItemDate: value => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 8 ? Number(digits.slice(0, 8)) : 0;
  },
  formatStrForPeriod: value => String(value),
});
vm.runInContext(`${source.slice(moduleStart, moduleEnd)}\nglobalThis.api = FILTER_SORT_MODULE;`, context);
const filter = context.api;

const row = (unitType, overrides = {}) => ({
  code: overrides.code || unitType,
  displayName: unitType,
  unitType,
  categoryCode: overrides.categoryCode || "10",
  category2Code: overrides.category2Code || "1001",
  vendor: overrides.vendor || "공급사",
  price: overrides.price || 0,
  batchKey: overrides.batchKey || unitType,
  ...overrides,
});
const allUnits = { BOX: false, EA: false, SPLIT: false };
assert.equal(filter.shouldShowSplitItem(row("BOX"), allUnits), true);
assert.equal(filter.shouldShowSplitItem(row("EA"), allUnits), true);
assert.equal(filter.shouldShowSplitItem(row("SPLIT"), allUnits), true);
assert.equal(filter.shouldShowSplitItem(row("UNKNOWN"), allUnits), true, "no selected unit means the unfiltered all state");

const boxOnly = { BOX: true, EA: false, SPLIT: false };
assert.equal(filter.shouldShowSplitItem(row("BOX"), boxOnly), true);
assert.equal(filter.shouldShowSplitItem(row("EA"), boxOnly), false);
assert.equal(filter.shouldShowSplitItem(row("UNKNOWN"), boxOnly), false);
assert.deepEqual(
  Array.from(filter.applyFilters([row("BOX"), row("EA"), row("SPLIT")], { category: ["10"], unit: boxOnly }), item => item.code),
  ["BOX"],
  "category and unit filters must intersect",
);

const sorted = filter.sortRows([
  row("BOX", { code: "20", batchKey: "late", 일자: "2026-08-02", price: 200 }),
  row("BOX", { code: "10", batchKey: "first", 일자: "2026-08-03", price: 300 }),
  row("BOX", { code: "20", batchKey: "early", 일자: "2026-08-01", price: 100 }),
]);
assert.deepEqual(Array.from(sorted, item => item.batchKey), ["first", "early", "late"], "code remains primary and same-code LOTs remain date ordered");

assert.match(source, /stockListType: 'ALL'/, "current purchase-balance/other-stock filter state must remain");
assert.match(source, /\[\['PURCHASE_BALANCE', '구매잔량'\], \['OTHER_STOCK', '기타상품'\]\]/);
assert.match(source, /\[\['CODE_SUMMARY', '코드 통합형'\], \['LOT_DETAIL', 'Lot 상세형'\]\]/);
assert.match(source, /const showClosingButton = hasAnyUploadedFile && !isCostExtractionMode/);
assert.match(source, /const showTransferUploadButton = hasPurchaseFile && !isCostExtractionMode/);
assert.match(source, /const showTransferCheckButton = hasPurchaseFile && hasSalesFile && !isCostExtractionMode/);
assert.match(source, /book_append_sheet\(wb,[^\n]+, '구매잔량'\);/);
assert.match(source, /book_append_sheet\(wb,[^\n]+, '기타상품'\);/);

console.log("PASS test-dataops-filter-actions");
