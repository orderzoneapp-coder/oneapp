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

for (const group of ["sort", "category", "unit", "exception"]) {
  assert.match(source, new RegExp(`data-filter-group": "${group}"[\\s\\S]{0,100}gap-1`), `${group} controls must form one compact group`);
}
assert.match(source, /items-center gap-3 md:gap-4 text-\[11px\]/, "filter groups must keep a 12–16px visual gap");
assert.match(source, /data-filter-group": "exception"[\s\S]*?hiddenMovedSourceCount[\s\S]*?\)\),\r?\n\s+React\.createElement\("button", \{ "data-filter-reset": "true"/, "filter reset must be the filter bar's direct last child, outside the exception group");
assert.match(source, /data-filter-reset": "true"[\s\S]{0,300}className: "ml-auto/, "filter reset must claim the right edge");

assert.match(source, /React\.createElement\("th", \{ colSpan: "2"[^\n]*w-\[350px\] min-w-\[350px\]/, "search header must span product and remark columns");
assert.match(source, /placeholder: "상품명·코드·적요·일자·구매처·단가 검색 \(F3\)"/, "unified search must describe the preserved search scope");
assert.doesNotMatch(source, /React\.createElement\("th", \{[^\n]*\}, "적요"\)/, "separate remark header text must be removed");

assert.match(source, /w-\[100px\] min-w-\[100px\] max-w-\[100px\]/, "remark width must shrink from 140px to 100px");
assert.match(source, /WebkitLineClamp: 2[\s\S]{0,80}overflow: 'hidden'[\s\S]{0,80}maxHeight: '30px'/, "remark preview must stay at two lines without growing every row");
assert.match(source, /onMouseEnter: showRemarkCoachmark[\s\S]{0,120}onFocus: showRemarkCoachmark/, "remark coachmark must support hover and keyboard focus");
assert.match(source, /data-remark-coachmark": "true"[\s\S]{0,180}z-\[300\]/, "overflow remark must render a custom coachmark");
assert.match(source, /window\.innerWidth - width - 8/, "coachmark must be horizontally clamped to the viewport");
assert.match(source, /\? \{ position: 'fixed'[\s\S]{0,500}: \{ position: 'fixed'/, "coachmark must stay viewport-positioned above or below the row");
assert.match(source, /displayPurchaseRemark \|\| '-'/, "blank remark must render as a dash");

const productCellStart = source.indexOf('React.createElement("td", { className: `py-2 px-3 sticky left-0 z-10');
const remarkCellStart = source.indexOf('React.createElement("td", { className: `relative py-2 px-2 w-[100px]', productCellStart);
assert.ok(productCellStart >= 0 && remarkCellStart > productCellStart, "product and remark cells must remain separate body cells");
const productCellContract = source.slice(productCellStart, remarkCellStart);
assert.doesNotMatch(productCellContract, /border-r border-slate-200|shadow-\[1px_0_0/, "product-to-remark separator must be removed");
assert.match(source, /productRemarkSurfaceClass[\s\S]{0,5000}productRemarkSurfaceClass/, "product and remark cells must share the same row surface class");

const fnMatch = source.match(/const calculatePositiveLotWeightedAveragePrice = ([\s\S]*?\n\};)/);
assert.ok(fnMatch, "display-only weighted-average helper must exist");
const calculate = vm.runInNewContext(`(${fnMatch[1].replace(/;$/, "")})`, {
  safeNum: value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  },
});
const lots = [
  { 단가: 2500, qty: 7 },
  { 단가: 3000, qty: 15 },
  { 단가: 3500, qty: 18 },
  { 단가: 4000, qty: 22 },
  { 단가: 999999, qty: 0 },
  { 단가: 999999, qty: -2 },
];
assert.equal(calculate(lots, row => row.qty), 3444, "positive LOT weighted average must round 213,500 ÷ 62 to 3,444");
assert.equal(calculate([{ 단가: 2500, qty: 0 }], row => row.qty), null, "zero-only lots must not produce a helper price");
assert.equal(calculate([{ 단가: 0, qty: 4 }], row => row.qty), 0, "a positive-quantity zero-price lot must display a zero average");

assert.match(source, /const \[localPrice, setLocalPrice\] = useState\(item\.단가 === 0/, "selected representative price must remain item.단가");
assert.match(source, /isDetailMergedViewRow && mergedWeightedAveragePrice !== null[\s\S]{0,500}`평균 \$\{formatMoney\(mergedWeightedAveragePrice\)\}`/, "helper must render only on a merged LOT-detail row, including a zero average");
assert.match(source, /title: `수량가중 평균단가 \$\{formatMoney\(mergedWeightedAveragePrice\)\}원`[\s\S]{0,180}"aria-label": `수량가중 평균단가/, "short helper text must retain its full meaning for pointer and assistive technology");
assert.doesNotMatch(source, /item\.단가\s*=\s*mergedWeightedAveragePrice|단가:\s*mergedWeightedAveragePrice/, "weighted average must never overwrite the reference price");

console.log("DataOps filter, remark, and weighted-average contract passed.");
