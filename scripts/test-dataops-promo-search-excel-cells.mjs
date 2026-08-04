#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.lastIndexOf("</script>");
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "DataOps main script block must exist");
new vm.Script(source.slice(scriptStart + marker.length, scriptEnd), { filename: "DataOps.inline.js" });

const helperStart = source.indexOf("const collectDataOpsSourceLedgerRows");
const helperEnd = source.indexOf("// V1.a22.12: 수량은", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "DataOps remark/search helpers must exist");
const context = {
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  formatMoney: value => Math.round(Number(value)).toLocaleString("en-US"),
};
vm.createContext(context);
vm.runInContext(`${source.slice(helperStart, helperEnd)}\nthis.helpers = { collectDataOpsSourceLedgerRows, buildDataOpsPurchaseRemarkView, matchesDataOpsTableSearch };`, context);
const { buildDataOpsPurchaseRemarkView, matchesDataOpsTableSearch } = context.helpers;

assert.deepEqual({ ...buildDataOpsPurchaseRemarkView([]) }, { summary: "", fullText: "", count: 0 }, "zero remarks must stay blank");
assert.deepEqual(
  { ...buildDataOpsPurchaseRemarkView([{ _purchaseRemark: "단일 적요" }]) },
  { summary: "단일 적요", fullText: "단일 적요", count: 1 },
  "one source remark must remain unchanged",
);
assert.deepEqual(
  { ...buildDataOpsPurchaseRemarkView([
    { _purchaseRemark: "첫 적요" },
    { _purchaseRemark: "대표 적요" },
    { _purchaseRemark: "세 번째 적요" },
  ], { _purchaseRemark: "대표 적요" }) },
  { summary: "대표 적요 외 2건", fullText: "대표 적요\n첫 적요\n세 번째 적요", count: 3 },
  "multiple remarks must prefer the representative and keep every full remark",
);
assert.deepEqual(
  { ...buildDataOpsPurchaseRemarkView([
    { _purchaseRemark: "" },
    { _purchaseRemark: "첫 유효 적요" },
    { _purchaseRemark: "다음 적요" },
  ], { _purchaseRemark: "" }) },
  { summary: "첫 유효 적요 외 1건", fullText: "첫 유효 적요\n다음 적요", count: 2 },
  "a blank representative must fall back to the first valid remark",
);

const mergedRow = {
  품명: "통합 상품",
  코드: "A-100",
  _sourceLedgerRows: [
    {
      _sourceLedgerRows: [
        { 품명: "원본 하나", 코드: "A-100", _purchaseRemark: "여름행사", 일자: "2026-08-01", _displayPurchaseVendor: "Alpha상회", 단가: 1234 },
        { 품명: "원본 둘", 코드: "A-100", _purchaseRemark: "보관주의", 일자: "2026-08-02", _purchaseLotVendor: "Beta상회", 단가: 5678 },
      ],
    },
  ],
};
for (const query of ["통합 상품", "a-100", "여름행사", "보관주의", "2026-08-02", "alpha상회", "BETA상회", "1234", "1,234", "5678", "5,678"]) {
  assert.equal(matchesDataOpsTableSearch(mergedRow, query), true, `merged source search must match ${query}`);
}
assert.equal(matchesDataOpsTableSearch(mergedRow, "없는값"), false, "unrelated search text must not match");
assert.equal(matchesDataOpsTableSearch({ 품명: "공란 단가", 단가: "" }, "0"), false, "blank prices must not become searchable zeroes");
assert.equal(matchesDataOpsTableSearch({ 품명: "영단가", 단가: 0 }, "0"), true, "an explicit numeric zero must remain searchable");

assert.match(source, /const purchaseRemarkView = buildDataOpsPurchaseRemarkView\(sourceRows, representativeRow\)/, "both integrated view types must use the shared remark aggregation");
assert.match(source, /_purchaseRemarkFull: purchaseRemarkView\.fullText/, "integrated rows must retain all remarks for the coachmark");
assert.match(source, /data = data\.filter\(row => matchesDataOpsTableSearch\(row, filters\.search\)\)/, "the table must use unified source-ledger search");
assert.match(source, /setFilters\(getDefaultFilters\(\)\);\s*setSearchInputVal\(''\);/, "filter reset must clear both committed and visible search state");

const headerStart = source.indexOf('React.createElement("header"');
const systemStart = source.indexOf('React.createElement("div", { className: "bg-white rounded-2xl', headerStart);
const headerSlice = source.slice(headerStart, systemStart);
assert.doesNotMatch(headerSlice, /"행사 보기"|"행사가 초기화"/, "promotion controls must be removed from the top header");
const exceptionStart = source.indexOf('"data-filter-group": "exception"');
const promoViewIndex = source.indexOf('"행사 보기"', exceptionStart);
const promoResetIndex = source.indexOf('"행사가 초기화"', promoViewIndex);
const filterResetIndex = source.indexOf('"data-filter-reset": "true"', promoResetIndex);
assert.ok(exceptionStart >= 0 && promoViewIndex > exceptionStart && promoResetIndex > promoViewIndex && filterResetIndex > promoResetIndex, "promotion controls must sit after zero exclusion and before filter reset");
assert.doesNotMatch(source, /text-slate-300 bg-slate-900\/50 border border-slate-700 rounded-lg px-3 py-2/, "System.IO status must not use a separate card surface");
assert.match(source, /handleResetFiles[^]*border bg-slate-800 text-slate-200 border-slate-500[^]*"\\uCD08\\uAE30\\uD654"/, "file reset must use a neutral bordered button system");

assert.match(source, /const cellInputBase = "[^"]*absolute inset-0[^"]*bg-transparent border-0 rounded-none[^"]*shadow-none"/, "numeric inputs must fill the cell without drawing inner rounded boxes or shadows");
assert.match(source, /focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500/, "only the focused cell must receive the blue inset focus line");
assert.match(source, /bg-slate-50\/80 text-slate-500/, "calculated neutral cells must use a quiet full-cell surface");
assert.match(source, /item\.로스 < 0 \? 'bg-rose-50 text-rose-700'/, "error state must color the full variance cell");
assert.match(source, /bg-amber-50 text-amber-800" \}, "행사가"/, "promotion header must use the amber column surface");
assert.match(source, /safeNum\(item\.행사가\) > 0 \? 'bg-amber-100\/90 text-amber-900' : 'bg-amber-50\/80 text-amber-700'/, "promotion values must use a stronger amber cell surface");
assert.match(source, /flex flex-nowrap items-center[^\n]*overflow-x-auto hide-scrollbar/, "the filter row must scroll horizontally instead of wrapping on narrow screens");
assert.match(source, /thead"[^\n]*sticky z-\[35\][^\n]*style: \{ top:/, "the table header must retain its sticky offset contract");
assert.match(source, /sticky left-0 bg-slate-50 z-30 w-\[350px\] min-w-\[350px\]/, "the sticky product/search columns must retain their fixed narrow-screen width");
assert.doesNotMatch(source, /const cellInputBase = "[^"]*min-h-\[/, "numeric inputs must not increase the existing row height");

assert.match(source, /const cols = \['price-input', 'promo-input', 'base-prev', 'base-in', 'base-out', 'actual-input'\]/, "keyboard column order must remain intact");
assert.match(source, /e\.key === 'ArrowDown' \|\| e\.key === 'Enter'/, "Enter and down-arrow movement must remain intact");
assert.match(source, /e\.key === 'ArrowRight'[\s\S]*e\.key === 'ArrowLeft'/, "horizontal arrow movement must remain intact");
assert.match(source, /if \(e\.key === 'F9'\)[\s\S]*latestHandlers\.current\.handleCombinedExport\(\)/, "F9 save path must remain intact");
assert.match(source, /__dataopsFlushNow = \(\) => flushPendingEdit\(type\)/, "blur and immediate edit confirmation hook must remain intact");

console.log("DataOps promotion tools, integrated remarks/search, and Excel-cell contract passed.");
