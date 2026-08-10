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

const readConst = (name, nextName, prefix = "") => {
  const sectionStart = source.indexOf(`const ${name} =`);
  const sectionEnd = source.indexOf(`const ${nextName} =`, sectionStart);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, `${name} source section must exist`);
  const context = {};
  vm.runInNewContext(`${prefix}\n${source.slice(sectionStart, sectionEnd)}\nthis.result = ${name};`, context);
  return context.result;
};

const unitFilter = readConst("DATAOPS_UNIT_FILTER_MODULE", "DATAOPS_SYSTEM_ACTION_MODULE");
const allUnits = { BOX: false, EA: false, SPLIT: false };
assert.equal(unitFilter.matches("BOX", allUnits), true);
assert.equal(unitFilter.matches("EA", allUnits), true);
assert.equal(unitFilter.matches("SPLIT", allUnits), true);
assert.equal(unitFilter.matches("UNKNOWN", allUnits), true, "UNKNOWN is visible only in the unfiltered all state");

const boxOnly = { BOX: true, EA: false, SPLIT: false };
assert.equal(unitFilter.matches("BOX", boxOnly), true);
assert.equal(unitFilter.matches("EA", boxOnly), false);
assert.equal(unitFilter.matches("SPLIT", boxOnly), false);
assert.equal(unitFilter.matches("UNKNOWN", boxOnly), false);

const boxAndEa = { BOX: true, EA: true, SPLIT: false };
assert.equal(unitFilter.matches("BOX", boxAndEa), true);
assert.equal(unitFilter.matches("EA", boxAndEa), true);
assert.equal(unitFilter.matches("SPLIT", boxAndEa), false);
assert.equal(unitFilter.matches("UNKNOWN", boxAndEa), false);

const toggleUnit = (state, unitType) => ({ ...state, [unitType]: !state[unitType] });
let toggledUnits = toggleUnit(allUnits, "BOX");
assert.deepEqual(Array.from(unitFilter.selectedTypes(toggledUnits)), ["BOX"]);
toggledUnits = toggleUnit(toggledUnits, "EA");
assert.deepEqual(Array.from(unitFilter.selectedTypes(toggledUnits)), ["BOX", "EA"]);
toggledUnits = toggleUnit(toggledUnits, "BOX");
assert.deepEqual(Array.from(unitFilter.selectedTypes(toggledUnits)), ["EA"]);
toggledUnits = toggleUnit(toggledUnits, "EA");
assert.deepEqual(Array.from(unitFilter.selectedTypes(toggledUnits)), []);
assert.equal(unitFilter.matches("UNKNOWN", toggledUnits), true, "clearing every unit returns to the all state");

const allSpecificUnits = { BOX: true, EA: true, SPLIT: true };
assert.equal(unitFilter.matches("SPLIT", allSpecificUnits), true);
assert.equal(unitFilter.matches("UNKNOWN", allSpecificUnits), false, "explicit unit selections must exclude UNKNOWN");

const actions = readConst("DATAOPS_SYSTEM_ACTION_MODULE", "DATAOPS_CLOUD_DEFAULT_URL");
const file = {};
const action = (prev, purchase, sales, count) => actions.getAction({
  prev: prev ? file : null,
  in: purchase ? file : null,
  out: sales ? file : null,
  end: count ? file : null,
});
assert.equal(action(false, false, false, false), "NONE");
assert.equal(action(false, true, false, false), "SALES_UPLOAD");
assert.equal(action(false, true, false, true), "COST_EXTRACT");
assert.equal(action(false, true, true, false), "TRANSFER_CHECK");
assert.equal(action(false, true, true, true), "TRANSFER_CHECK");
assert.equal(action(true, true, true, false), "STOCK_COUNT");
assert.equal(action(true, true, true, true), "STOCK_COUNT");
assert.equal(action(true, false, false, false), "NONE");
assert.equal(action(false, false, true, false), "NONE");
assert.equal(action(false, false, false, true), "NONE");
assert.equal(action(true, true, false, false), "NONE");
assert.equal(action(true, false, true, false), "NONE");

const groupingPrefix = `
const safeStr = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
};`;
const groupingStart = source.indexOf("const DATAOPS_DEFAULT_GROUPING =");
const groupingEnd = source.indexOf("const DATAOPS_PURCHASE_LOT_OVERRIDE_KEY =", groupingStart);
assert.ok(groupingStart >= 0 && groupingEnd > groupingStart, "grouping normalization section must exist");
const groupingContext = { localStorage: { getItem: () => null } };
vm.runInNewContext(`${groupingPrefix}\n${source.slice(groupingStart, groupingEnd)}\nthis.result = { defaults: DATAOPS_DEFAULT_GROUPING, normalize: normalizeDataOpsGrouping };`, groupingContext);
assert.equal(groupingContext.result.defaults.manageMode, "LOT_DETAIL");
assert.equal(groupingContext.result.normalize({ manageMode: "CODE_SUMMARY", priceMode: "average" }).manageMode, "LOT_DETAIL");
assert.equal(groupingContext.result.normalize({ manageMode: "CODE_SUMMARY", priceMode: "average" }).priceMode, "average", "internal F9 price basis compatibility must be preserved");
assert.match(source, /const manageMode = 'LOT_DETAIL';/);
assert.match(source, /getSavedViewMode: \(\) => 'LOT_DETAIL'/);
assert.match(source, /defaultUnitFilter: Object\.freeze\(\{ BOX: false, EA: false, SPLIT: false \}\)/);

const unitFilterSource = source.slice(
  source.indexOf("shouldShowSplitItem:"),
  source.indexOf("applyFilters:", source.indexOf("shouldShowSplitItem:")),
);
assert.match(unitFilterSource, /DATAOPS_UNIT_FILTER_MODULE\.matches\(unitType, unitFilter\)/);
assert.doesNotMatch(unitFilterSource, /diffQty|finalQty|systemQty/, "SPLIT error/negative rows must not bypass the selected units");

assert.doesNotMatch(source, /stockListType/, "removed purchase-balance/other-stock filter state must not remain");
assert.doesNotMatch(source, /onToggleCodeMerge|handleToggleCodeMerge|moveMergeCandidate|jumpToFirstMergeCandidate/, "merge/split UI entry points must not remain");
assert.doesNotMatch(source, /\[\['CODE_SUMMARY', '코드 통합형'\], \['LOT_DETAIL', 'Lot 상세형'\]\]/, "global view toggle must not remain");
assert.doesNotMatch(source, /\[\['PURCHASE_BALANCE', '구매잔량'\], \['OTHER_STOCK', '기타상품'\]\]/, "removed stock list buttons must not remain");
assert.match(source, /if \(categoryCode === 'ALL'\) return \{ \.\.\.f, category: \[\], favoriteVendorOnly: false, unit: \{ \.\.\.CONFIG_MODULE\.defaultUnitFilter \} \};/);
assert.match(source, /setFilters\(getDefaultFilters\(\)\)/, "new analysis/re-upload must restore the all-units default");
assert.match(source, /systemAction === 'SALES_UPLOAD'[\s\S]*?"판매업로드 생성"/);
assert.match(source, /systemAction === 'TRANSFER_CHECK'[\s\S]*?"전송 검증"/);
assert.match(source, /systemAction === 'STOCK_COUNT'[\s\S]*?"재고 실사"/);
assert.doesNotMatch(source, /showClosingButton|showTransferUploadButton|showTransferCheckButton/);
assert.match(source, /book_append_sheet\(wb,[^\n]+, '구매잔량'\);/);
assert.match(source, /book_append_sheet\(wb,[^\n]+, '기타상품'\);/);
assert.match(source, /version: 'V1\.a22\.114_FilterActions'/);

console.log("DataOps filter and System.IO action contract passed.");
