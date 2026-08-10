#!/usr/bin/env node

import assert from "node:assert/strict";
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

const rematchSource = section(
  "const DATAOPS_SALES_REMATCH_MODULE",
  "// V1.a22.111: 역마진 검증",
);
const context = vm.createContext({
  console,
  safeNum: (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  safeStr: (value, fallback = "") => {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value).trim() || fallback;
  },
  DATAOPS_VENDOR_CHIP_MODULE: {
    aggregateDetails: (details = {}) => {
      const result = {};
      for (const [key, detail] of Object.entries(details)) {
        const vendor = String(detail.displayVendor || key);
        if (!result[vendor]) {
          result[vendor] = {
            keys: [],
            displayVendor: vendor,
            qty: 0,
            rev: 0,
            cogs: 0,
          };
        }
        result[vendor].keys.push(key);
        result[vendor].qty += Number(detail.qty || 0);
        result[vendor].rev += Number(detail.rev || 0);
        result[vendor].cogs += Number(detail.cogs || 0);
      }
      return result;
    },
  },
});
context.window = context;
context.globalThis = context;
new vm.Script(
  `${rematchSource}\nglobalThis.salesRematch = DATAOPS_SALES_REMATCH_MODULE;`,
  { filename: "DataOps.sales-rematch.js" },
).runInContext(context);
const salesRematch = context.salesRematch;

const sourceRaw1 = Object.freeze({ 전표번호: "S-001", 상품코드: "A" });
const sourceRaw2 = Object.freeze({ 전표번호: "S-002", 상품코드: "A" });
const sourceRawBefore = JSON.stringify([sourceRaw1, sourceRaw2]);
const productData = [
  {
    batchKey: "A-LOT-1",
    코드: "A",
    품명: "원본상품",
    단위: "BOX",
    출고내역: { 거래처1: { qty: 3, rev: 300, cogs: 150, displayVendor: "거래처1" } },
    _sourceEntries: [
      { id: "SRC_1", role: "out", qty: 3, rev: 300, price: 100, vendor: "거래처1", sourceRaw: sourceRaw1 },
      { id: "SRC_2", role: "out", qty: 2, rev: 200, price: 100, vendor: "거래처1", sourceRaw: sourceRaw2 },
    ],
  },
  {
    batchKey: "A-LOT-2",
    코드: "A",
    품명: "원본상품",
    단위: "BOX",
    출고내역: { 거래처1: { qty: 2, rev: 200, cogs: 120, displayVendor: "거래처1" } },
    _sourceEntries: [],
  },
  { batchKey: "B-LOT", 코드: "B", 품명: "정정상품", 단위: "BOX", 출고내역: {} },
  { batchKey: "C-LOT", 코드: "C", 품명: "묶음상품", 단위: "EA", 출고내역: {} },
];

const firstMoveAllocations = salesRematch.allocateSourceLedgerForMove({
  productData,
  substHistory: [],
  sourceCode: "A",
  vendor: "거래처1",
  sourceQty: 2,
});
assert.deepEqual(
  Array.from(firstMoveAllocations, (allocation) => ({
    sourceEntryId: allocation.sourceEntryId,
    qty: allocation.qty,
    revenue: allocation.revenue,
  })),
  [{ sourceEntryId: "SRC_1", qty: 2, revenue: 200 }],
  "partial move must select the exact first source sales row",
);
const firstMove = {
  id: "H1",
  type: "SALES_REMATCH",
  isSalesRematch: true,
  status: "active",
  sourceCode: "A",
  targetCode: "B",
  sourceName: "원본상품",
  targetName: "정정상품",
  vendor: "거래처1",
  sourceQty: 2,
  targetQty: 2,
  revenue: 200,
  sourceLedgerEntryIds: ["SRC_1"],
  sourceLedgerAllocations: firstMoveAllocations,
};
const chainedAllocations = salesRematch.allocateSourceLedgerForMove({
  productData,
  substHistory: [firstMove],
  sourceCode: "B",
  vendor: "거래처1",
  sourceQty: 1,
});
assert.deepEqual(
  Array.from(chainedAllocations, (allocation) => ({
    sourceEntryId: allocation.sourceEntryId,
    qty: allocation.qty,
    revenue: allocation.revenue,
  })),
  [{ sourceEntryId: "SRC_1", qty: 1, revenue: 100 }],
  "consecutive rematch must inherit the first source sales row",
);
const chainedCtrlMove = {
  id: "H2",
  type: "SALES_REMATCH",
  isSalesRematch: true,
  status: "active",
  sourceCode: "B",
  targetCode: "C",
  sourceName: "정정상품",
  targetName: "묶음상품",
  vendor: "거래처1",
  sourceQty: 1,
  targetQty: 2,
  revenue: 100,
  sourceLedgerEntryIds: ["SRC_1"],
  sourceLedgerAllocations: chainedAllocations,
};

const originalRows = salesRematch.buildOriginalLedgerRows(productData);
assert.equal(originalRows.length, 2);
assert.deepEqual(Array.from(originalRows, (row) => row.sourceEntryId), ["SRC_1", "SRC_2"]);
assert.equal(originalRows.reduce((sum, row) => sum + row.qty, 0), 5);
assert.equal(originalRows.reduce((sum, row) => sum + row.supplyAmount, 0), 500);

const correctedRows = salesRematch.buildCorrectedLedgerRows({
  productData,
  substHistory: [firstMove, chainedCtrlMove],
});
const totalsByCode = Object.fromEntries(
  ["A", "B", "C"].map((code) => [
    code,
    correctedRows
      .filter((row) => row.currentCode === code)
      .reduce((total, row) => ({ qty: total.qty + row.qty, supply: total.supply + row.supplyAmount }), { qty: 0, supply: 0 }),
  ]),
);
assert.deepEqual(totalsByCode, {
  A: { qty: 3, supply: 300 },
  B: { qty: 1, supply: 100 },
  C: { qty: 2, supply: 100 },
});
assert.deepEqual(
  Array.from(correctedRows.filter((row) => row.currentCode === "C"), (row) => row.sourceEntryId),
  ["SRC_1"],
  "A→B→C must preserve the first original sales row identity",
);
assert.equal(correctedRows.reduce((sum, row) => sum + row.supplyAmount, 0), 500, "Ctrl conversion must preserve supply amount");
assert.equal(JSON.stringify([sourceRaw1, sourceRaw2]), sourceRawBefore, "Source raw rows must stay immutable");

const afterSecondUndo = salesRematch.buildCorrectedLedgerRows({
  productData,
  substHistory: [firstMove, { ...chainedCtrlMove, status: "cancelled" }],
});
assert.equal(afterSecondUndo.filter((row) => row.currentCode === "B").reduce((sum, row) => sum + row.qty, 0), 2);
assert.equal(afterSecondUndo.filter((row) => row.currentCode === "C").length, 0);
assert.equal(afterSecondUndo.reduce((sum, row) => sum + row.qty, 0), 5, "normal rematch quantity must be preserved");
assert.equal(afterSecondUndo.reduce((sum, row) => sum + row.supplyAmount, 0), 500);

const legacy = salesRematch.normalizeHistory([{
  id: 77,
  type: "CTRL_DRAG_REPLACEMENT",
  sourceKey: "A-LOT-1",
  targetKey: "B-LOT",
  sourceName: "원본상품",
  targetName: "정정상품",
  sQty: 2,
  tQty: 2,
  sourceItemPrev: productData[0],
  targetItemPrev: productData[2],
}]);
assert.equal(legacy[0].status, "active");
assert.equal(salesRematch.isSalesEvent(legacy[0]), true);
const legacyCorrected = salesRematch.buildCorrectedLedgerRows({ productData, substHistory: legacy });
assert.equal(legacyCorrected.filter((row) => row.currentCode === "B").reduce((sum, row) => sum + row.qty, 0), 2);
assert.equal(legacyCorrected.reduce((sum, row) => sum + row.supplyAmount, 0), 500);

const allocations = salesRematch.buildSourceAllocations({ productData, code: "A", vendor: "거래처1" });
assert.equal(allocations.length, 2);
assert.equal(allocations.reduce((sum, item) => sum + item.qty, 0), 5);
const projected = salesRematch.applyCorrectedDetailsToViewRows({
  viewRows: productData.map((row) => ({ ...row })),
  productData,
  substHistory: [],
});
assert.equal(projected.filter((row) => Object.keys(row._correctedSalesDetails).length > 0).length, 1, "current sales chip must have one manipulation anchor");

const mainScriptMarker = '<script type="text/javascript">';
const mainScriptStart = source.indexOf(mainScriptMarker);
const mainScriptEnd = source.lastIndexOf("</script>");
const mainScriptSource = source.slice(mainScriptStart + mainScriptMarker.length, mainScriptEnd);
new vm.Script(mainScriptSource, { filename: "DataOps.inline.js" });
const inventoryEngineStart = mainScriptSource.indexOf("const useInventoryEngine =");
const inventoryEngineEnd = mainScriptSource.indexOf("const IssueChip = React.memo", inventoryEngineStart);
const hookState = [];
let hookIndex = 0;
const runtimeReact = {
  useState: (initialValue) => {
    const index = hookIndex++;
    hookState[index] = typeof initialValue === "function" ? initialValue() : initialValue;
    return [
      hookState[index],
      (nextValue) => {
        hookState[index] = typeof nextValue === "function" ? nextValue(hookState[index]) : nextValue;
      },
    ];
  },
  useRef: (initialValue) => ({ current: initialValue }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
};
const storageValues = new Map();
const runtimeContext = vm.createContext({
  console,
  React: runtimeReact,
  localStorage: {
    getItem: (key) => storageValues.get(String(key)) ?? null,
    setItem: (key, value) => storageValues.set(String(key), String(value)),
    removeItem: (key) => storageValues.delete(String(key)),
  },
  setTimeout: (callback) => { callback(); return 1; },
  clearTimeout: () => {},
});
runtimeContext.window = runtimeContext;
runtimeContext.self = runtimeContext;
runtimeContext.globalThis = runtimeContext;
new vm.Script(mainScriptSource.slice(0, inventoryEngineStart), { filename: "DataOps.runtime-preamble.js" }).runInContext(runtimeContext);
new vm.Script("globalThis.actualExportModule = EXPORT_MODULE;", { filename: "DataOps.export-module.js" }).runInContext(runtimeContext);
new vm.Script(
  `${mainScriptSource.slice(inventoryEngineStart, inventoryEngineEnd)}\nglobalThis.actualUseInventoryEngine = useInventoryEngine;`,
  { filename: "DataOps.inventory-engine.js" },
).runInContext(runtimeContext);
const inventoryEngine = runtimeContext.actualUseInventoryEngine({
  mappings: {},
  grouping: {},
  setAlertMsg: () => {},
  setConfirmModal: () => {},
  setIsProcessing: () => {},
  setAppStep: () => {},
});
const frozenLedgerEntries = Object.freeze([
  Object.freeze({ id: "SRC_1", role: "out", qty: 3, rev: 300, vendor: "거래처1", sourceRaw: Object.freeze({ 전표번호: "IMMUTABLE-1" }) }),
  Object.freeze({ id: "SRC_2", role: "out", qty: 2, rev: 200, vendor: "거래처1", sourceRaw: Object.freeze({ 전표번호: "IMMUTABLE-2" }) }),
]);
const frozenLedgerBefore = JSON.stringify(frozenLedgerEntries);
const makeInventoryRows = () => [
  {
    batchKey: "A1", 코드: "A", 품명: "원본상품", 단위: "BOX", 단가: 100,
    기초: 5, 입고: 0, 출고: 5, 대체입고: 0, 대체출고: 0, 전산잔량: 0, 실사: 0, 로스: 0,
    매출액: 500, 매출원가: 500, 이슈: [], 메모: "",
    출고내역: { 거래처1: { qty: 5, rev: 500, cogs: 500, displayVendor: "거래처1" } },
    _sourceEntries: frozenLedgerEntries,
  },
  {
    batchKey: "B1", 코드: "B", 품명: "정정상품", 단위: "BOX", 단가: 60,
    기초: 10, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0, 전산잔량: 10, 실사: 10, 로스: 0,
    매출액: 0, 매출원가: 0, 이슈: [], 메모: "", 출고내역: {}, _sourceEntries: [],
  },
  {
    batchKey: "C1", 코드: "C", 품명: "묶음상품", 단위: "EA", 단가: 25,
    기초: 10, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0, 전산잔량: 10, 실사: 10, 로스: 0,
    매출액: 0, 매출원가: 0, 이슈: [], 메모: "", 출고내역: {}, _sourceEntries: [],
  },
  {
    batchKey: "D1", 코드: "D", 품명: "원가미정상품", 단위: "BOX", 단가: 0,
    기초: 10, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0, 전산잔량: 10, 실사: 10, 로스: 0,
    매출액: 0, 매출원가: 0, 이슈: [], 메모: "", 출고내역: {}, _sourceEntries: [],
  },
];
inventoryEngine.setProductData(makeInventoryRows());
inventoryEngine.handleSalesMove("A1", "B1", "거래처1", 2, { maxQty: 5, sourceDeductQty: 2, targetQty: 2 });
const partialSource = hookState[0].find((row) => row.batchKey === "A1");
const partialTarget = hookState[0].find((row) => row.batchKey === "B1");
assert.equal(partialSource.출고, 3);
assert.equal(partialSource.매출원가, 300, "source decrease must retain the source Lot cost of 100");
assert.equal(partialSource.전산잔량, 2);
assert.equal(partialTarget.출고, 2);
assert.equal(partialTarget.매출액, 200);
assert.equal(partialTarget.매출원가, 120, "ordinary target increase must apply the target Lot cost of 60");
assert.equal(partialTarget.전산잔량, 8);
assert.equal(hookState[0].reduce((sum, row) => sum + Number(row.출고 || 0), 0), 5);
assert.equal(hookState[0].reduce((sum, row) => sum + Number(row.매출원가 || 0), 0), 420);
assert.equal(hookState[3].length, 1);
assert.equal(hookState[3][0].status, "active");
assert.equal(hookState[3][0].method, "partialDrag");
assert.deepEqual(
  Array.from(hookState[3][0].sourceLedgerAllocations, (allocation) => ({
    sourceEntryId: allocation.sourceEntryId,
    qty: allocation.qty,
    revenue: allocation.revenue,
  })),
  [{ sourceEntryId: "SRC_1", qty: 2, revenue: 200 }],
);
inventoryEngine.handleSalesMove("B1", "C1", "거래처1", 1, { maxQty: 2, sourceDeductQty: 1, targetQty: 1 });
assert.equal(hookState[0].find((row) => row.batchKey === "B1").출고, 1);
assert.equal(hookState[0].find((row) => row.batchKey === "C1").출고, 1);
assert.equal(hookState[3].length, 2, "consecutive re-edit must append history");
assert.deepEqual(Array.from(hookState[3][1].sourceLedgerEntryIds), ["SRC_1"], "consecutive re-edit must retain the first source identity");
assert.deepEqual(
  Array.from(hookState[3][1].sourceLedgerAllocations, (allocation) => ({
    sourceEntryId: allocation.sourceEntryId,
    qty: allocation.qty,
    revenue: allocation.revenue,
  })),
  [{ sourceEntryId: "SRC_1", qty: 1, revenue: 100 }],
);
assert.equal(JSON.stringify(frozenLedgerEntries), frozenLedgerBefore, "source ledger rows and sourceRaw objects must stay immutable");

inventoryEngine.setProductData(makeInventoryRows());
inventoryEngine.setSubstHistory([]);
inventoryEngine.handleSalesMove("A1", "B1", "거래처1", 5, { maxQty: 5, sourceDeductQty: 5, targetQty: 5 });
assert.equal(hookState[0].find((row) => row.batchKey === "A1").출고, 0);
assert.equal(hookState[0].find((row) => row.batchKey === "B1").출고, 5);
assert.equal(hookState[3][0].method, "drag");

inventoryEngine.setProductData(makeInventoryRows());
inventoryEngine.setSubstHistory([]);
inventoryEngine.handleSalesMove("A1", "D1", "거래처1", 1, { maxQty: 5, sourceDeductQty: 1, targetQty: 1 });
assert.equal(hookState[0].find((row) => row.batchKey === "D1").매출원가, 100, "zero target cost must keep the existing safe source-cost fallback");
assert.equal(hookState[0].find((row) => row.batchKey === "D1").출고내역.거래처1.lotUnitCost, 100);

inventoryEngine.setProductData(makeInventoryRows());
inventoryEngine.setSubstHistory([]);
inventoryEngine.handleSalesMove("A1", "C1", "거래처1", 4, {
  isCtrlPressed: true,
  skipTargetInference: true,
  maxQty: 5,
  sourceDeductQty: 2,
  targetQty: 4,
});
assert.equal(hookState[0].find((row) => row.batchKey === "A1").출고, 3);
assert.equal(hookState[0].find((row) => row.batchKey === "C1").출고, 4);
assert.equal(hookState[0].find((row) => row.batchKey === "C1").매출액, 200, "Ctrl target must preserve source supply amount");
assert.equal(hookState[3][0].targetQty, 4);
assert.equal(hookState[3][0].revenue, 200);

const marginSource = section("const DATAOPS_MARGIN_REVIEW_MODULE", "window.DATAOPS_MARGIN_REVIEW_MODULE");
const marginContext = vm.createContext({
  safeNum: context.safeNum,
  safeStr: context.safeStr,
  DATAOPS_VENDOR_CHIP_MODULE: context.DATAOPS_VENDOR_CHIP_MODULE,
});
new vm.Script(`${marginSource}\nglobalThis.marginReview = DATAOPS_MARGIN_REVIEW_MODULE;`).runInContext(marginContext);
assert.equal(marginContext.marginReview.isReverseMargin({ 단가: 100, 출고내역: { V: { qty: 1, rev: 100 } } }), false);
assert.equal(marginContext.marginReview.isReverseMargin({ 단가: 101, 출고내역: { V: { qty: 1, rev: 100 } } }), true);

const undoSource = section("const handleUndoAction = useCallback", "// V1.a22.12: 이슈카드");
assert.match(undoSource, /status:\s*'cancelled'/);
assert.doesNotMatch(undoSource, /\.filter\(item\s*=>\s*item\.id\s*!==/);
assert.match(source, /setSubstHistory\(DATAOPS_SALES_REMATCH_MODULE\.normalizeHistory\(snapshot\.substHistory\)\)/);
assert.match(source, /sourceLedgerEntryIds/);
assert.match(source, /sourceAllocations:\s*allocationSnapshot/);
assert.match(source, /cost > salePrice/);
assert.doesNotMatch(source, /cost >= salePrice/);

let persistedSnapshot = { version: 1, savedAt: "before", productData: [{ batchKey: "SAFE" }], substHistory: [] };
let failNextWrite = false;
const fakeIndexedDb = {
  open: () => {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: () => true },
        transaction: () => {
          const transaction = {
            error: null,
            objectStore: () => ({
              put: (value) => {
                queueMicrotask(() => {
                  if (failNextWrite) {
                    failNextWrite = false;
                    transaction.error = new Error("WRITE_FAILED");
                    transaction.onerror?.();
                    return;
                  }
                  persistedSnapshot = value;
                  transaction.oncomplete?.();
                });
              },
              get: () => {
                const getRequest = {};
                queueMicrotask(() => {
                  getRequest.result = persistedSnapshot;
                  getRequest.onsuccess?.();
                });
                return getRequest;
              },
              delete: () => queueMicrotask(() => transaction.oncomplete?.()),
            }),
          };
          return transaction;
        },
        close: () => {},
      };
      request.onsuccess?.();
    });
    return request;
  },
};
const workStateSource = section("let dataOpsWorkStateWriteQueue", "// V1.a22.108: 입력 파일마다 Web Worker");
const workStateContext = vm.createContext({
  console,
  indexedDB: fakeIndexedDb,
  safeStr: context.safeStr,
});
new vm.Script(`${workStateSource}\nglobalThis.workState = DATAOPS_WORK_STATE_MODULE;`).runInContext(workStateContext);
failNextWrite = true;
await assert.rejects(
  workStateContext.workState.save({ productData: [{ batchKey: "BROKEN" }], substHistory: [{ id: "NEW" }] }),
  /WRITE_FAILED/,
);
assert.equal(persistedSnapshot.productData[0].batchKey, "SAFE", "failed save must not replace the previous snapshot");
assert.equal((await workStateContext.workState.load()).productData[0].batchKey, "SAFE");

const expectedExistingSheets = [
  "전체재고", "구매잔량", "기타상품", "실사양식", "확인요청", "재고수불_마감",
  "수불마감_분석원장", "소분치환_후보", "마스터_확인필요", "보고서",
];
const exportSource = section("createCombinedWorkbook:", "const DATAOPS_MERCH_STOCK_SYNC_MODULE");
for (const sheetName of expectedExistingSheets) assert.match(exportSource, new RegExp(`'${sheetName}'`));
assert.ok(exportSource.indexOf("'보고서'") < exportSource.indexOf("'원본 판매전표'"));
assert.ok(exportSource.indexOf("'원본 판매전표'") < exportSource.indexOf("'정정 판매현황'"));

const bundleUrl = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
const bundleResponse = await fetch(bundleUrl);
assert.equal(bundleResponse.ok, true, `Unable to load XLSX runtime: ${bundleResponse.status}`);
const xlsxContext = vm.createContext({ console, setTimeout, clearTimeout });
xlsxContext.window = xlsxContext;
xlsxContext.self = xlsxContext;
xlsxContext.globalThis = xlsxContext;
new vm.Script(await bundleResponse.text(), { filename: "xlsx.bundle.js" }).runInContext(xlsxContext);
const XLSX = xlsxContext.XLSX;
assert.ok(XLSX);
runtimeContext.XLSX = XLSX;
const f9ProductData = productData.map((row, index) => ({
  기초: index === 0 ? 5 : (index === 1 ? 2 : 10),
  입고: 0,
  출고: index === 0 ? 3 : (index === 1 ? 2 : 0),
  대체입고: 0,
  대체출고: 0,
  전산잔량: index === 0 ? 2 : (index === 1 ? 0 : 10),
  실사: index === 0 ? 2 : (index === 1 ? 0 : 10),
  로스: 0,
  단가: row.코드 === "A" ? (index === 0 ? 50 : 60) : (row.코드 === "B" ? 60 : 25),
  매출액: index === 0 ? 300 : (index === 1 ? 200 : 0),
  매출원가: index === 0 ? 150 : (index === 1 ? 120 : 0),
  이슈: [],
  메모: "",
  ...row,
  _sourceEntries: (row._sourceEntries || []).map((entry) => ({
    ...entry,
    date: "2026-08-10",
    sourceFile: "sales.xlsx",
    sourceSheet: "판매",
  })),
}));
const chainedSameQty = { ...chainedCtrlMove, id: "H2_F9", targetQty: 1, tQty: 1 };
const { wb: actualWorkbook } = runtimeContext.actualExportModule.createCombinedWorkbook({
  productData: f9ProductData,
  substHistory: [firstMove, chainedSameQty],
  analysisPeriod: "2026-08",
  targetDateStr: "2026-08-10",
  closingStats: {},
});
const bytes = XLSX.write(actualWorkbook, { bookType: "xlsx", type: "array" });
assert.ok(bytes.byteLength > 0);
const reopened = XLSX.read(bytes, { type: "array" });
assert.deepEqual(Array.from(reopened.SheetNames), [...expectedExistingSheets, "원본 판매전표", "정정 판매현황"]);
for (const sheetName of expectedExistingSheets) {
  assert.ok(reopened.Sheets[sheetName]?.["!ref"], `existing F9 sheet must remain readable: ${sheetName}`);
}
const sheetValues = (sheet) => Object.entries(sheet)
  .filter(([address]) => !address.startsWith("!"))
  .map(([, cell]) => String(cell?.v ?? ""));
assert.ok(sheetValues(reopened.Sheets["전체재고"]).some((value) => value === "A"), "existing whole-stock sheet must retain a product code");
assert.ok(sheetValues(reopened.Sheets["재고수불_마감"]).some((value) => value === "원본상품"), "existing closing sheet must retain a product name");
assert.ok(sheetValues(reopened.Sheets["보고서"]).some((value) => value === "보고서"), "existing report sheet must retain its title");
const reopenedOriginal = XLSX.utils.sheet_to_json(reopened.Sheets["원본 판매전표"]);
const reopenedCorrected = XLSX.utils.sheet_to_json(reopened.Sheets["정정 판매현황"]);
assert.equal(reopenedOriginal.length, 2);
assert.equal(reopenedOriginal.reduce((sum, row) => sum + Number(row["판매수량"] || 0), 0), 5);
assert.equal(reopenedOriginal.reduce((sum, row) => sum + Number(row["공급가액"] || 0), 0), 500);
assert.equal(reopenedCorrected.reduce((sum, row) => sum + Number(row["판매수량"] || 0), 0), 5, "ordinary rematch F9 quantity total must be preserved");
assert.equal(reopenedCorrected.reduce((sum, row) => sum + Number(row["공급가액"] || 0), 0), 500);
const reopenedC = reopenedCorrected.find((row) => row["정정상품코드"] === "C");
assert.equal(reopenedC["판매수량"], 1);
assert.equal(reopenedC["원본식별자"], "S-001", "F9 corrected row must retain the exact first source slip identifier");

const { wb: ctrlWorkbook } = runtimeContext.actualExportModule.createCombinedWorkbook({
  productData: f9ProductData,
  substHistory: [firstMove, chainedCtrlMove],
  analysisPeriod: "2026-08",
  targetDateStr: "2026-08-10",
  closingStats: {},
});
const ctrlBytes = XLSX.write(ctrlWorkbook, { bookType: "xlsx", type: "array" });
const reopenedCtrl = XLSX.read(ctrlBytes, { type: "array" });
const reopenedCtrlCorrected = XLSX.utils.sheet_to_json(reopenedCtrl.Sheets["정정 판매현황"]);
assert.equal(reopenedCtrlCorrected.reduce((sum, row) => sum + Number(row["공급가액"] || 0), 0), 500, "Ctrl conversion F9 must preserve original supply total");
assert.equal(reopenedCtrlCorrected.find((row) => row["정정상품코드"] === "C")["판매수량"], 2);
assert.equal(reopenedCtrlCorrected.find((row) => row["정정상품코드"] === "C")["원본식별자"], "S-001");

console.log("DataOps sales rematch contract passed.");
