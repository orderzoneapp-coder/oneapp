#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const methodStart = source.indexOf("openPrintWindow: (");
const methodEnd = source.indexOf("\n    createCombinedWorkbook:", methodStart);
assert.notEqual(methodStart, -1, "openPrintWindow start marker is missing");
assert.notEqual(methodEnd, -1, "openPrintWindow end marker is missing");

const methodSource = source
  .slice(methodStart, methodEnd)
  .trim()
  .replace(/^openPrintWindow:\s*/, "")
  .replace(/,\s*$/, "");

let renderedHtml = "";
const printRows = [
  {
    code: "101020116",
    name: "대파 서울 10단",
    spec: "BOX",
    unit: "BOX",
    finalQty: 123,
    baseQty: 100,
    inQty: 123,
    outQty: 999,
    purchaseDate: "2026-07-29",
    purchaseVendor: "가락(청산유통)",
    price: 123456,
    systemText: "관리자 확인 완료",
    category2Code: "1010",
  },
  {
    code: "1010201170",
    name: "팽이버섯 국내산 5개입 상품",
    spec: "EA",
    unit: "EA",
    finalQty: -123,
    baseQty: -123,
    inQty: 0,
    outQty: 1,
    purchaseDate: "",
    purchaseVendor: "",
    price: 0,
    systemText:
      "장문 시스템 메모는 기존처럼 말줄임표로 표시되어 표 영역을 벗어나지 않아야 합니다.",
    category2Code: "1010",
  },
  {
    code: "202030405",
    name: "냉동 수산 가공품 1kg",
    spec: "1kg",
    unit: "소분",
    finalQty: 8,
    baseQty: 5,
    inQty: 3,
    outQty: 0,
    purchaseDate: "2026-07-29",
    purchaseVendor: "부산 공동어시장",
    price: 8800,
    systemText: "",
    category2Code: "2020",
  },
];

const context = vm.createContext({
  console,
  Date,
  setTimeout,
  clearTimeout,
  safeNum: (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  safeStr: (value, fallback = "") => {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  },
  formatQty: (value) => String(value),
  formatMoney: (value) => Number(value).toLocaleString("ko-KR"),
});
context.window = {
  open: () => ({
    document: {
      write: (html) => {
        renderedHtml += html;
      },
      close: () => {},
    },
  }),
};
context.EXPORT_MODULE = {
  buildPrintRows: ({ productData }) => productData.map((row) => ({ ...row })),
  escapeHtml: (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;"),
};
context.globalThis = context;

new vm.Script(
  `globalThis.actualOpenPrintWindow = ${methodSource};`,
  { filename: "DataOps.openPrintWindow.js" },
).runInContext(context);

const opened = context.actualOpenPrintWindow({
  productData: printRows,
  targetDateStr: "2026-07-29",
  title: "DataOps 재고 실사 출력",
});
assert.equal(opened, true);
assert.match(renderedHtml, /@page\{size:A4 portrait;/);
assert.match(renderedHtml, /thead\{display:table-header-group\}/);
assert.match(renderedHtml, /table\{[^}]*width:100%[^}]*font-size:11px[^}]*line-height:1\.17[^}]*table-layout:fixed/);
assert.match(renderedHtml, /h1\{font-size:22px;/);
assert.match(renderedHtml, /\.meta\{font-size:13\.5px;/);
assert.match(renderedHtml, /\.summary\{[^}]*font-size:13\.5px;/);
assert.match(renderedHtml, /th\{[^}]*font-size:10px;/);
assert.match(renderedHtml, /td\{[^}]*padding:3\.5px 3px;[^}]*text-overflow:ellipsis/);
assert.match(renderedHtml, /\.code\{[^}]*font-size:11px/);
assert.match(renderedHtml, /\.qty\{padding-left:1px;padding-right:1px\}/);
assert.match(renderedHtml, /\.purchase-date\{text-align:center;padding-left:1px;padding-right:1px\}/);
assert.match(renderedHtml, /\.print-unit-alert\{color:#b91c1c!important;font-weight:900\}/);
assert.match(renderedHtml, /print-color-adjust:exact/);
assert.doesNotMatch(renderedHtml, /\.code\{[^}]*font-size:15\.5px/);

const expectedWidths = {
  "code-col": 6.7,
  "name-col": 30,
  "spec-col": 5.9,
  "price-col": 9.4,
  "final-col": 5.9,
  "stock-col": 5,
  "move-col": 5,
  "date-col": 6.1,
  "vendor-col": 10.9,
  "system-col": 10.1,
};
for (const [className, width] of Object.entries(expectedWidths)) {
  assert.match(
    renderedHtml,
    new RegExp(`col\\.${className}\\{width:${String(width).replace(".", "\\.")}%\\}`),
  );
}
const widthSum =
  expectedWidths["code-col"] +
  expectedWidths["name-col"] +
  expectedWidths["spec-col"] +
  expectedWidths["price-col"] +
  expectedWidths["final-col"] +
  expectedWidths["stock-col"] +
  expectedWidths["move-col"] * 2 +
  expectedWidths["date-col"] +
  expectedWidths["vendor-col"] +
  expectedWidths["system-col"];
assert.equal(Math.round(widthSum * 10) / 10, 100);
for (const viewportWidth of [1366, 1920]) {
  const pixelTotal = (widthSum / 100) * viewportWidth;
  assert.ok(Math.abs(pixelTotal - viewportWidth) < 0.001);
  assert.ok((expectedWidths["code-col"] / 100) * viewportWidth >= 91);
  assert.ok((expectedWidths["name-col"] / 100) * viewportWidth >= 409);
  assert.ok((expectedWidths["price-col"] / 100) * viewportWidth >= 128);
  assert.ok((expectedWidths["date-col"] / 100) * viewportWidth >= 69);
  assert.ok((expectedWidths["vendor-col"] / 100) * viewportWidth >= 148);
}

const a4PrintableWidthPx = ((210 - 10) / 25.4) * 96;
const maxQtyTextWidthPx = 4 * 6.5;
for (const quantityColumn of ["stock-col", "move-col"]) {
  const effectiveWidthPx =
    (expectedWidths[quantityColumn] / 100) * a4PrintableWidthPx - 4;
  assert.ok(
    effectiveWidthPx > maxQtyTextWidthPx,
    `${quantityColumn} must fit 0-999 and -999 at 11px with 1px horizontal padding`,
  );
}
const effectivePurchaseDateWidthPx =
  (expectedWidths["date-col"] / 100) * a4PrintableWidthPx - 4;
const boldPurchaseDateWidthPx = 5 * 6.5;
assert.ok(
  effectivePurchaseDateWidthPx > boldPurchaseDateWidthPx,
  "purchase-date must fit bold MM/DD at 11px with 1px horizontal padding",
);

const expectedColgroup =
  '<colgroup><col class="code-col"><col class="name-col"><col class="spec-col"><col class="price-col"><col class="final-col"><col class="stock-col"><col class="move-col"><col class="move-col"><col class="date-col"><col class="vendor-col"><col class="system-col"></colgroup>';
const expectedHeader =
  '<thead><tr><th>품목코드</th><th>품명</th><th>규격</th><th>구매가</th><th class="divider-core">잔량</th><th>재고</th><th>입고</th><th class="divider-check">출고</th><th>구매일</th><th>구매처</th><th>시스템</th></tr></thead>';
assert.ok(renderedHtml.includes(expectedColgroup));
assert.ok(renderedHtml.includes(expectedHeader));
assert.match(
  renderedHtml,
  /<td class="spec"><span class="print-unit ">BOX<\/span><\/td>\s*<td class="price">123,456<\/td>\s*<td class="qty final divider-core [^"]*">123<\/td>/,
);
assert.match(
  renderedHtml,
  /<span class="print-unit print-unit-alert">EA<\/span>/,
);
assert.match(
  renderedHtml,
  /1kg <span class="print-unit print-unit-alert">소분<\/span>/,
);
assert.doesNotMatch(renderedHtml, /print-unit-alert">BOX<\/span>/);

assert.equal((renderedHtml.match(/<tr class="/g) || []).length, printRows.length);
assert.match(renderedHtml, /101020116/);
assert.match(renderedHtml, /1010201170/);
assert.match(renderedHtml, /07\/29/);
assert.match(renderedHtml, /123,456/);
assert.match(renderedHtml, /<td class="qty">100<\/td>/);
assert.match(renderedHtml, /<td class="qty inbound-value">123<\/td>/);
assert.match(renderedHtml, /<td class="qty divider-check outbound-value">999<\/td>/);
assert.match(renderedHtml, /<td class="qty">-123<\/td>/);
assert.match(renderedHtml, /가락\(청산유통\)/);
assert.match(renderedHtml, /inbound-value/);
assert.match(renderedHtml, /outbound-value/);
assert.match(renderedHtml, /negative-final/);
assert.match(renderedHtml, /category-break/);
assert.match(renderedHtml, /window\.print\(\)/);

const expectedDisplayVersion =
  "V1.a22.115_InputPerformance · 2026-08-21 KST";
assert.equal(
  source.split(expectedDisplayVersion).length - 1,
  2,
  "dated V113 version must appear at loader and application header",
);
assert.match(source, /version:\s*'V1\.a22\.115_InputPerformance'/);

console.log("DataOps stock print readability contract passed.");
