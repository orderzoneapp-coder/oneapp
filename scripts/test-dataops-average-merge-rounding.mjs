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

const helperMatch = source.match(/const roundDataOpsAverageMergePrice = ([^;]+);/);
assert.ok(helperMatch, "average-merge rounding helper must exist");
const roundAverageMergePrice = vm.runInNewContext(`(${helperMatch[1]})`, {
  safeNum: value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  },
});
assert.equal(roundAverageMergePrice(3444), 3400, "3,444 must round to 3,400 at the final 100-won boundary");
assert.equal(roundAverageMergePrice(3450), 3500, "3,450 must round to 3,500 at the final 100-won boundary");

const viewStart = source.indexOf("const DATAOPS_VIEW_LAYER_MODULE");
const viewEnd = source.indexOf("window.DATAOPS_VIEW_LAYER_MODULE = DATAOPS_VIEW_LAYER_MODULE;", viewStart);
assert.ok(viewStart >= 0 && viewEnd > viewStart, "DataOps view-layer module must exist");

let mergePriceMode = "average";
let representativeKey = "";
let globalPriceMode = "latest";
const safeNum = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const safeStr = (value, fallback = "") => {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  return String(value).trim();
};
const context = vm.createContext({
  safeNum,
  safeStr,
  roundDataOpsAverageMergePrice: roundAverageMergePrice,
  localStorage: { getItem: () => null, setItem: () => {} },
  readSavedDataOpsGrouping: () => ({ priceMode: globalPriceMode }),
  getDataOpsPriceModeLabel: mode => mode,
  formatStrForPeriod: value => String(value),
  FILTER_SORT_MODULE: {
    getPurchaseDateSortValue: row => safeNum(row._purchaseDateNum) || 99999999,
    compareByCodeThenName: () => 0,
  },
  STOCK_ENGINE_MODULE: {
    calculateStock: row => ({ finalQty: safeNum(row.qty) }),
  },
  DATAOPS_ISSUE_HELPER: {
    unique: values => [...new Set(values)],
  },
  DATAOPS_CODE_MERGE_OVERRIDE_MODULE: {
    getRepresentativeKey: () => representativeKey,
    getPriceMode: () => mergePriceMode,
    isDisabled: () => false,
    isDetailMerged: () => true,
  },
});
new vm.Script(
  `${source.slice(viewStart, viewEnd)}\nglobalThis.viewLayer = DATAOPS_VIEW_LAYER_MODULE;`,
  { filename: "DataOps.view-layer.js" },
).runInContext(context);

const makeRow = ({ key, price, qty, date }) => ({
  batchKey: key,
  코드: "CODE-A",
  품명: "테스트상품",
  거래처: `구매처-${key}`,
  _purchaseDateNum: date,
  일자: String(date),
  단가: price,
  qty,
  기초: qty,
  입고: 0,
  출고: 0,
  대체입고: 0,
  대체출고: 0,
  전산잔량: qty,
  실사: "",
  로스: 0,
  매출액: 0,
  매출원가: 0,
  출고내역: {},
  이슈: [],
  메모: "",
});

const lots3444 = [
  makeRow({ key: "A", price: 2500, qty: 7, date: 20260801 }),
  makeRow({ key: "B", price: 3000, qty: 15, date: 20260802 }),
  makeRow({ key: "C", price: 3500, qty: 18, date: 20260803 }),
  makeRow({ key: "D", price: 4000, qty: 22, date: 20260804 }),
  makeRow({ key: "ZERO", price: 999999, qty: 0, date: 20260805 }),
  makeRow({ key: "NEG", price: 999999, qty: -2, date: 20260806 }),
];
const originalLots3444 = structuredClone(lots3444);
const averageMerged3444 = context.viewLayer.buildCodeSummaryRow("CODE-A", lots3444);
assert.equal(averageMerged3444.단가, 3400, "raw 213,500 ÷ 62 average must round once from 3,443.548... to 3,400");
assert.deepEqual(lots3444, originalLots3444, "average merge must not mutate original LOT quantities or prices");

const lots3450 = [
  makeRow({ key: "E", price: 3400, qty: 1, date: 20260801 }),
  makeRow({ key: "F", price: 3500, qty: 1, date: 20260802 }),
];
assert.equal(context.viewLayer.buildCodeSummaryRow("CODE-A", lots3450).단가, 3500, "raw 3,450 average must round once to 3,500");

mergePriceMode = "selected";
representativeKey = "F";
const selectedRows = [
  makeRow({ key: "E", price: 3444, qty: 1, date: 20260801 }),
  makeRow({ key: "F", price: 3455, qty: 1, date: 20260802 }),
];
assert.equal(context.viewLayer.buildCodeSummaryRow("CODE-A", selectedRows).단가, 3455, "selected-cost merge must preserve the chosen LOT price");

mergePriceMode = "";
representativeKey = "";
globalPriceMode = "average";
assert.equal(context.viewLayer.buildCodeSummaryRow("CODE-A", lots3444).단가, 3444, "global code-summary weighted average must keep its existing one-won rounding");

for (const [mode, expected] of [["latest", 4000], ["highest", 999999], ["fifo", 4000]]) {
  globalPriceMode = mode;
  assert.equal(context.viewLayer.buildCodeSummaryRow("CODE-A", lots3444).단가, expected, `${mode} price mode must remain unchanged`);
}

assert.match(
  source,
  /mergePriceMode === 'average' \? roundDataOpsAverageMergePrice\(weightedAveragePrice\) : Math\.round\(weightedAveragePrice\)/,
  "100-won rounding must be gated to the average-merge override",
);
assert.match(
  source,
  /title: "재고가 남은 LOT 수량을 합산하고, 양수 잔량·양수 단가 LOT의 수량가중 평균원가를 마지막에 한 번만 100원 단위로 반올림하여 적용합니다\."/,
  "average-merge tooltip must disclose the exact 100-won rounding rule",
);

console.log("DataOps average-merge 100-won rounding contract passed.");
