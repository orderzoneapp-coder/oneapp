#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const datedV110Version =
  "V1.a22.110_WorkSaveCloudInventorySync · 2026-08-08 KST";
const v110ConfigVersion = "V1.a22.110_WorkSaveCloudInventorySync";
const datedV111Version =
  "V1.a22.111_WorkSaveCloudInventorySync · 2026-08-08 KST";
const v111ConfigVersion = "V1.a22.111_WorkSaveCloudInventorySync";
const datedV112Version =
  "V1.a22.112_EvidenceReportPreflight · 2026-08-12 KST";
const v112ConfigVersion = "V1.a22.112_EvidenceReportPreflight";
const datedV113Version =
  "V1.a22.115_InputPerformance · 2026-08-21 KST";
const v114ConfigVersion = "V1.a22.115_InputPerformance";
const hasCompatibleVersion = (datedVersion, configVersion) =>
  source.split(datedVersion).length - 1 >= 2 &&
  new RegExp(`version:\\s*'${configVersion}'`).test(source);
const isCompatibleV110ThroughV113 =
  hasCompatibleVersion(datedV110Version, v110ConfigVersion) ||
  hasCompatibleVersion(datedV111Version, v111ConfigVersion) ||
  hasCompatibleVersion(datedV112Version, v112ConfigVersion) ||
  hasCompatibleVersion(datedV113Version, v114ConfigVersion);
if (isCompatibleV110ThroughV113) {
  const workbook = section("createCombinedWorkbook:", "const STORAGE_MODULE");
  const viewLayer = section(
    "const DATAOPS_VIEW_LAYER_MODULE",
    "\nconst EXPORT_MODULE",
  );
  const nextBaseRows = section(
    "buildNextBaseStockRows:",
    "buildScreenStockRows:",
  );
  assert.match(workbook, /const operationalProductData = DATAOPS_VIEW_LAYER_MODULE\.buildCodeSummaryRows\(productData \|\| \[\]\)/, "V110 F9 must summarize full productData");
  assert.match(workbook, /buildNextBaseStockRows\(\{\s*productData:\s*operationalProductData,\s*targetDateStr\s*\}\)/, "V110 whole-stock must use administrator-aware summaries");
  assert.doesNotMatch(workbook, /filteredProductData|screenRows/);
  assert.match(viewLayer, /buildCodeSummaryRows:/);
  assert.match(viewLayer, /DATAOPS_CODE_MERGE_OVERRIDE_MODULE\.isDisabled/, "V110 administrator split/merge override must remain");
  assert.match(nextBaseRows, /\.filter\(item => STOCK_ENGINE_MODULE\.getActualQty\(item\) > 0\)/, "V110 whole-stock must retain positive balances only");
  const sheets = ["전체재고", "구매잔량", "기타상품", "실사양식", "확인요청", "재고수불_마감", "수불마감_분석원장", "소분치환_후보", "마스터_확인필요", "보고서"];
  let previous = -1;
  for (const sheet of sheets) { const index = workbook.indexOf(`'${sheet}'`); assert.ok(index > previous, `V110 sheet order changed at ${sheet}`); previous = index; }
  console.log("DataOps V110 administrator-merged whole-stock contract passed.");
  process.exit(0);
}

const mergeAndViewSource = section(
  "const DATAOPS_CODE_MERGE_OVERRIDE_MODULE",
  "\nconst EXPORT_MODULE",
);
const remarkAndSearchSource = section(
  "const collectDataOpsSourceLedgerRows",
  "\n// V1.a22.12: 수량은",
);
const exportSource = section(
  "const EXPORT_MODULE",
  "\nconst STORAGE_MODULE",
);
const combinedWorkbookSource = section(
  "createCombinedWorkbook:",
  "const STORAGE_MODULE",
);
const stockCountSource = section(
  "buildStockCountSheetRows:",
  "buildSalesDetailRows:",
);

assert.match(
  combinedWorkbookSource,
  /const operationalProductData = DATAOPS_VIEW_LAYER_MODULE\.buildCodeSummaryRows\(productData \|\| \[\]\)/,
  "operationalProductData must be built from the complete productData collection",
);
assert.match(
  combinedWorkbookSource,
  /buildNextBaseStockRows\(\{\s*productData:\s*operationalProductData,\s*targetDateStr\s*\}\)/,
  "whole-stock output must use the administrator-aware operationalProductData",
);
assert.doesNotMatch(
  combinedWorkbookSource,
  /filteredProductData|screenRows/,
  "whole-stock output must not depend on screen filters or hidden rows",
);
assert.match(
  stockCountSource,
  /const stockCountDate\s*=\s*targetDateStr\s*;/,
  "the existing stock-count date contract must remain unchanged",
);
assert.match(
  stockCountSource,
  /const key = actualCode \+ '\|' \+ item\.품명;/,
  "the existing stock-count aggregation key must remain unchanged",
);
assert.match(
  stockCountSource,
  /safeNum\(aggregated\[key\]\.수량\) === 0/,
  "the existing stock-count zero-row policy must remain unchanged",
);

const sheetOrder = [
  "전체재고",
  "구매잔량",
  "기타상품",
  "실사양식",
  "확인요청",
  "재고수불_마감",
  "수불마감_분석원장",
  "소분치환_후보",
  "마스터_확인필요",
  "보고서",
];
let previousSheetIndex = -1;
for (const sheetName of sheetOrder) {
  const currentSheetIndex = combinedWorkbookSource.indexOf(`'${sheetName}'`);
  assert.ok(
    currentSheetIndex > previousSheetIndex,
    `combined workbook sheet order changed at ${sheetName}`,
  );
  previousSheetIndex = currentSheetIndex;
}

const sheetJsUrl =
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const expectedSheetJsSha256 =
  "c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99";
const response = await fetch(sheetJsUrl);
assert.equal(response.ok, true, `SheetJS download failed: ${response.status}`);
const sheetJsSource = Buffer.from(await response.arrayBuffer());
assert.equal(
  crypto.createHash("sha256").update(sheetJsSource).digest("hex"),
  expectedSheetJsSha256,
  "SheetJS asset hash changed",
);

const sessionStore = new Map();
const localStore = new Map();
const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const toText = (value, fallback = "") => {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  return text || fallback;
};
const dateNumber = (value) => {
  const digits = toText(value).replace(/[^0-9]/g, "");
  return digits.length >= 8 ? Number(digits.slice(0, 8)) : 0;
};
const actualQuantity = (item = {}) => {
  if (!(item.실사 === "" || item.실사 === null || item.실사 === undefined)) {
    return toNumber(item.실사);
  }
  if (item.actualQty !== undefined) return toNumber(item.actualQty);
  if (item.전산잔량 !== undefined) return toNumber(item.전산잔량);
  return (
    toNumber(item.기초) +
    toNumber(item.입고) +
    toNumber(item.대체입고) -
    toNumber(item.출고) -
    toNumber(item.대체출고)
  );
};

const context = vm.createContext({
  console,
  Date,
  Map,
  Set,
  Symbol,
  Number,
  Object,
  String,
  Array,
  Math,
  Uint8Array,
  ArrayBuffer,
  JSON,
  safeNum: toNumber,
  safeStr: toText,
  extractDateNum: dateNumber,
  formatStrForPeriod: (value) => {
    const digits = String(value || "").padStart(8, "0");
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  },
  formatQty: (value) => String(value),
  formatMoney: (value) => String(value),
  readSavedDataOpsGrouping: () => ({ priceMode: "representative" }),
  getDataOpsPriceModeLabel: () => "대표단가",
  getBasicDisplayValue: (item = {}) =>
    toText(item.기본 || item._raw?.기본, ""),
  getStockManageGroup: () => "",
  DATAOPS_ISSUE_HELPER: {
    unique: (values = []) => [...new Set(values.filter(Boolean))],
  },
  DATAOPS_VENDOR_CHIP_MODULE: {
    normalizeDisplayVendor: (key, data = {}) =>
      toText(data.displayVendor || key, "미지정"),
  },
  STOCK_ENGINE_MODULE: {
    calculateStock: (item = {}) => ({ finalQty: actualQuantity(item) }),
    getActualQty: actualQuantity,
    getAdjustmentQty: (item = {}) =>
      actualQuantity(item) - toNumber(item.전산잔량),
  },
  FILTER_SORT_MODULE: {
    getPurchaseDateSortValue: (item = {}) =>
      dateNumber(item.일자) || 99999999,
    compareByCodeThenName: (a = {}, b = {}) =>
      toText(a.코드 || a.code || "NO_CODE").localeCompare(
        toText(b.코드 || b.code || "NO_CODE"),
        "ko",
      ) ||
      (dateNumber(a.일자) || 99999999) -
        (dateNumber(b.일자) || 99999999) ||
      toText(a.품명 || a.name).localeCompare(toText(b.품명 || b.name), "ko"),
  },
  DATAOPS_MASTER_LINK_MODULE: {
    buildOutputColumns: () => ({}),
    getCachedContext: () => ({}),
    buildMasterLedgerInfo: () => ({
      matchStatus: "코드일치",
      productType: "일반",
      masterCode: "",
      masterName: "",
      masterSpec: "",
      masterUnit: "",
      rawCode: "",
      subCode: "",
      conversionRate: "",
      stockConversionQty: "",
      masterRaw: {},
    }),
  },
  DATAOPS_MASTER_ITEM_HELPER: {
    isSettlementItem: () => false,
  },
  DATAOPS_SUBSTITUTION_CANDIDATE_MODULE: {
    buildExecutableRows: () => [],
  },
  sessionStorage: {
    getItem: (key) => sessionStore.get(key) ?? null,
    setItem: (key, value) => sessionStore.set(key, String(value)),
    removeItem: (key) => sessionStore.delete(key),
  },
  localStorage: {
    getItem: (key) => localStore.get(key) ?? null,
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
  },
});
context.window = context;
context.self = context;
context.globalThis = context;
vm.runInContext(sheetJsSource.toString("utf8"), context, {
  filename: "xlsx.full.min.js",
});
assert.ok(context.XLSX?.utils, "SheetJS did not initialize");

new vm.Script(
  `${remarkAndSearchSource}
${mergeAndViewSource}
${exportSource}
globalThis.mergeOverride = DATAOPS_CODE_MERGE_OVERRIDE_MODULE;
globalThis.viewLayer = DATAOPS_VIEW_LAYER_MODULE;
globalThis.exportModule = EXPORT_MODULE;`,
  { filename: "DataOps.whole-stock-admin-merge.js" },
).runInContext(context);

const makeLot = ({
  code = "101020114",
  batchKey,
  quantity,
  date,
  vendor,
  price,
  name = "대파_단_EA",
  unit = "EA",
  spec = "EA",
  basic = "1",
  remark = "",
}) => ({
  batchKey,
  코드: code,
  품명: name,
  단위: unit,
  규격: spec,
  기초: quantity,
  입고: 0,
  출고: 0,
  대체입고: 0,
  대체출고: 0,
  전산잔량: quantity,
  실사: quantity,
  로스: 0,
  단가: price,
  일자: date,
  거래처: vendor,
  매출액: 0,
  매출원가: 0,
  출고내역: {},
  이슈: [],
  메모: "",
  _raw: {
    단위: unit,
    품명: name,
    규격: spec,
    기본: basic,
    적요: remark,
  },
});

const originalLots = [
  makeLot({
    batchKey: "LOT-0728",
    quantity: 70,
    date: "2026-07-28",
    vendor: "가락A",
    price: 1000,
    remark: "07/28 원본 Lot",
  }),
  makeLot({
    batchKey: "LOT-0729",
    quantity: 100,
    date: "2026-07-29",
    vendor: "가락B",
    price: 2000,
    remark: "07/29 원본 Lot",
  }),
  makeLot({
    code: "202030405",
    batchKey: "OTHER-01",
    quantity: 5,
    date: "",
    vendor: "",
    price: 0,
    name: "기타상품",
    unit: "BOX",
    spec: "BOX",
    remark: "기타상품 원본",
  }),
];

context.mergeOverride.clear();
const operationalRows = context.viewLayer.buildCodeSummaryRows(originalLots);
const mergedCodeRows = Array.from(operationalRows).filter(
  (row) => row.코드 === "101020114",
);
assert.equal(mergedCodeRows.length, 1);
assert.equal(mergedCodeRows[0].실사, 170);
assert.deepEqual(Array.from(mergedCodeRows[0]._viewSourceKeys), [
  "LOT-0728",
  "LOT-0729",
]);

const wholeStockRows = context.exportModule.buildNextBaseStockRows({
  productData: operationalRows,
  targetDateStr: "2026-07-29",
});
const mergedWholeStock = Array.from(wholeStockRows).filter(
  (row) => row["품목코드"] === "101020114",
);
assert.equal(mergedWholeStock.length, 1);
assert.equal(mergedWholeStock[0]["재고"], 170);
assert.equal(mergedWholeStock[0]["단위"], "EA");
assert.equal(mergedWholeStock[0]["품명"], "대파_단_EA");
assert.equal(mergedWholeStock[0]["규격"], "EA");
assert.equal(mergedWholeStock[0]["기록"], "2026-07-29");
assert.equal(mergedWholeStock[0]["거래"], "가락B");
assert.equal(mergedWholeStock[0]["구매가"], 2000);
assert.equal(mergedWholeStock[0]["기본"], "1");
assert.equal(mergedWholeStock[0]["적요"], "07/29 원본 Lot");
assert.equal(
  Array.from(wholeStockRows).filter(
    (row) => row["품목코드"] === "202030405",
  ).length,
  1,
  "different product codes must remain separate",
);

const analysisRows = context.exportModule.buildClosingAnalysisLedgerRows({
  productData: originalLots,
  targetDateStr: "2026-07-29",
});
const originalAnalysisLots = Array.from(analysisRows).filter(
  (row) => row["상품코드"] === "101020114",
);
assert.deepEqual(
  originalAnalysisLots.map((row) => ({
    quantity: row["마감잔량"],
    vendor: row["매입처(Lot)"],
    price: row["매입단가(원가)"],
  })),
  [
    { quantity: 70, vendor: "가락A", price: 1000 },
    { quantity: 100, vendor: "가락B", price: 2000 },
  ],
);
assert.deepEqual(
  originalLots
    .filter((row) => row.코드 === "101020114")
    .map((row) => row.일자),
  ["2026-07-28", "2026-07-29"],
  "building operational rows and the analysis ledger must not mutate source Lot dates",
);

const purchaseBalanceRows = context.exportModule.buildPurchaseBalanceRows({
  productData: originalLots,
  targetDateStr: "2026-07-29",
});
assert.deepEqual(
  Array.from(purchaseBalanceRows)
    .filter((row) => row["품목코드"] === "101020114")
    .map((row) => [row["재고"], row["기록"], row["거래"], row["구매가"]]),
  [
    [70, "2026-07-28", "가락A", 1000],
    [100, "2026-07-29", "가락B", 2000],
  ],
);
const otherStockRows = context.exportModule.buildOtherStockRows({
  productData: originalLots,
  targetDateStr: "2026-07-29",
});
assert.equal(
  Array.from(otherStockRows).filter(
    (row) => row["품목코드"] === "202030405",
  ).length,
  1,
);

const stockCountRows = context.exportModule.buildStockCountSheetRows({
  productData: operationalRows,
  targetDateStr: "2026-07-29",
});
const mergedStockCount = Array.from(stockCountRows).filter(
  (row) => row["상품코드"] === "101020114",
);
assert.equal(mergedStockCount.length, 1);
assert.equal(mergedStockCount[0]["수량"], 170);
assert.equal(mergedStockCount[0]["일자"], "2026-07-29");

const combined = context.exportModule.createCombinedWorkbook({
  productData: originalLots,
  analysisPeriod: "2026-07-29",
  targetDateStr: "2026-07-29",
  closingStats: {},
});
assert.deepEqual(Array.from(combined.wb.SheetNames), sheetOrder);
const workbookBytes = context.XLSX.write(combined.wb, {
  bookType: "xlsx",
  type: "array",
});
assert.ok(workbookBytes.byteLength > 1000, "generated XLSX is unexpectedly small");
const workbookByteView = new Uint8Array(workbookBytes);
assert.equal(
  String.fromCharCode(workbookByteView[0], workbookByteView[1]),
  "PK",
);
const reopened = context.XLSX.read(workbookByteView, { type: "array" });
assert.deepEqual(Array.from(reopened.SheetNames), sheetOrder);

const reopenedWholeStock = context.XLSX.utils.sheet_to_json(
  reopened.Sheets["전체재고"],
  { range: 1, raw: true },
);
const reopenedMergedWholeStock = Array.from(reopenedWholeStock).filter(
  (row) => String(row["품목코드"]) === "101020114",
);
assert.equal(reopenedMergedWholeStock.length, 1);
assert.equal(reopenedMergedWholeStock[0]["재고"], 170);

const reopenedAnalysis = context.XLSX.utils.sheet_to_json(
  reopened.Sheets["수불마감_분석원장"],
  { raw: true },
);
assert.deepEqual(
  Array.from(reopenedAnalysis)
    .filter((row) => String(row["상품코드"]) === "101020114")
    .map((row) => [
      row["마감잔량"],
      row["매입처(Lot)"],
      row["매입단가(원가)"],
    ]),
  [
    [70, "가락A", 1000],
    [100, "가락B", 2000],
  ],
);
const reopenedPurchaseBalance = context.XLSX.utils.sheet_to_json(
  reopened.Sheets["구매잔량"],
  { range: 1, raw: true },
);
assert.deepEqual(
  Array.from(reopenedPurchaseBalance)
    .filter((row) => String(row["품목코드"]) === "101020114")
    .map((row) => [
      row["재고"],
      row["기록"],
      row["거래"],
      row["구매가"],
    ]),
  [
    [70, "2026-07-28", "가락A", 1000],
    [100, "2026-07-29", "가락B", 2000],
  ],
);
const reopenedOtherStock = context.XLSX.utils.sheet_to_json(
  reopened.Sheets["기타상품"],
  { range: 1, raw: true },
);
assert.equal(
  Array.from(reopenedOtherStock).filter(
    (row) => String(row["품목코드"]) === "202030405",
  ).length,
  1,
);
const reopenedStockCount = context.XLSX.utils.sheet_to_json(
  reopened.Sheets["실사양식"],
  { raw: true },
);
const reopenedMergedStockCount = Array.from(reopenedStockCount).filter(
  (row) => String(row["상품코드"]) === "101020114",
);
assert.equal(reopenedMergedStockCount.length, 1);
assert.equal(reopenedMergedStockCount[0]["수량"], 170);
assert.equal(reopenedMergedStockCount[0]["일자"], "2026-07-29");

context.mergeOverride.split("101020114");
const splitOperationalRows =
  context.viewLayer.buildCodeSummaryRows(originalLots);
const splitWholeStockRows = context.exportModule.buildNextBaseStockRows({
  productData: splitOperationalRows,
  targetDateStr: "2026-07-29",
});
assert.deepEqual(
  Array.from(splitWholeStockRows)
    .filter((row) => row["품목코드"] === "101020114")
    .map((row) => row["재고"]),
  [70, 100],
  "administrator-disabled codes must remain split in whole-stock output",
);
context.mergeOverride.clear();

const positiveNegativeLots = [
  makeLot({
    batchKey: "BOUNDARY-POSITIVE",
    quantity: 100,
    date: "2026-07-28",
    vendor: "가락A",
    price: 1000,
  }),
  makeLot({
    batchKey: "BOUNDARY-NEGATIVE",
    quantity: -30,
    date: "2026-07-29",
    vendor: "가락B",
    price: 2000,
  }),
];
const positiveNegativeOperational =
  context.viewLayer.buildCodeSummaryRows(positiveNegativeLots);
const positiveNegativeWhole =
  context.exportModule.buildNextBaseStockRows({
    productData: positiveNegativeOperational,
    targetDateStr: "2026-07-29",
  });
assert.equal(positiveNegativeWhole.length, 1);
assert.equal(positiveNegativeWhole[0]["재고"], 70);
const positiveNegativeAnalysis =
  context.exportModule.buildClosingAnalysisLedgerRows({
    productData: positiveNegativeLots,
    targetDateStr: "2026-07-29",
  });
assert.deepEqual(
  Array.from(positiveNegativeAnalysis).map((row) => row["마감잔량"]),
  [100, -30],
);

const zeroSumLots = [
  makeLot({
    batchKey: "ZERO-POSITIVE",
    quantity: 100,
    date: "2026-07-28",
    vendor: "가락A",
    price: 1000,
  }),
  makeLot({
    batchKey: "ZERO-NEGATIVE",
    quantity: -100,
    date: "2026-07-29",
    vendor: "가락B",
    price: 2000,
  }),
];
const zeroSumOperational = context.viewLayer.buildCodeSummaryRows(zeroSumLots);
const zeroSumWhole = context.exportModule.buildNextBaseStockRows({
  productData: zeroSumOperational,
  targetDateStr: "2026-07-29",
});
assert.equal(zeroSumWhole.length, 0);
const zeroSumAnalysis =
  context.exportModule.buildClosingAnalysisLedgerRows({
    productData: zeroSumLots,
    targetDateStr: "2026-07-29",
  });
assert.deepEqual(
  Array.from(zeroSumAnalysis).map((row) => row["마감잔량"]),
  [100, -100],
);

const expectedVersion = "V1.a22.106_CodePrimaryNameMerge";
assert.equal(
  (source.match(new RegExp(expectedVersion, "g")) || []).length,
  3,
  "DataOps title, loader, and CONFIG_MODULE version must match",
);

console.log(
  "DataOps 관리자 통합 전체재고와 원본 Lot 보존 XLSX 계약이 통과했습니다.",
);
