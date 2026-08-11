#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const fixture = JSON.parse(fs.readFileSync("scripts/fixtures/dataops-regression-recovery.json", "utf8"));
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.lastIndexOf("</script>");
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "DataOps main script must exist");
const mainScriptSource = source.slice(scriptStart + marker.length, scriptEnd);
new vm.Script(mainScriptSource, { filename: "DataOps.inline.js" });

let hookState = [];
let hookIndex = 0;
const runtimeReact = {
  useState: (initialValue) => {
    const index = hookIndex++;
    hookState[index] = typeof initialValue === "function" ? initialValue() : initialValue;
    return [hookState[index], (nextValue) => {
      hookState[index] = typeof nextValue === "function" ? nextValue(hookState[index]) : nextValue;
    }];
  },
  useRef: (initialValue) => ({ current: initialValue }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  memo: (component) => component,
};

const encodeCell = ({ r, c }) => {
  let col = "";
  for (let value = c + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    col = String.fromCharCode(65 + ((value - 1) % 26)) + col;
  }
  return `${col}${r + 1}`;
};
const decodeCell = (address) => {
  const match = String(address).match(/^([A-Z]+)(\d+)$/);
  let col = 0;
  for (const char of match[1]) col = col * 26 + char.charCodeAt(0) - 64;
  return { c: col - 1, r: Number(match[2]) - 1 };
};
const sheetFromAoa = (aoa) => {
  const ws = { __aoa: aoa.map((row) => [...row]) };
  let maxColumn = 0;
  aoa.forEach((row, r) => {
    maxColumn = Math.max(maxColumn, row.length);
    row.forEach((value, c) => { ws[encodeCell({ r, c })] = { v: value, t: typeof value === "number" ? "n" : "s" }; });
  });
  ws["!ref"] = `A1:${encodeCell({ r: Math.max(0, aoa.length - 1), c: Math.max(0, maxColumn - 1) })}`;
  return ws;
};
const XLSX = { utils: {
  aoa_to_sheet: sheetFromAoa,
  json_to_sheet: (rows) => {
    const headers = Array.from(new Set((rows || []).flatMap((row) => Object.keys(row))));
    return sheetFromAoa([headers, ...(rows || []).map((row) => headers.map((header) => row[header] ?? ""))]);
  },
  book_new: () => ({ SheetNames: [], Sheets: {} }),
  book_append_sheet: (workbook, sheet, name) => { workbook.SheetNames.push(name); workbook.Sheets[name] = sheet; },
  encode_cell: encodeCell,
  decode_range: (range) => {
    const [start, end] = String(range).split(":");
    return { s: decodeCell(start), e: decodeCell(end || start) };
  },
} };

const runtimeContext = vm.createContext({
  console,
  React: runtimeReact,
  XLSX,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout: (callback) => { callback(); return 1; },
  clearTimeout: () => {},
});
runtimeContext.window = runtimeContext;
runtimeContext.self = runtimeContext;
runtimeContext.globalThis = runtimeContext;

const inventoryEngineStart = mainScriptSource.indexOf("const useInventoryEngine =");
const inventoryEngineEnd = mainScriptSource.indexOf("const IssueChip = React.memo", inventoryEngineStart);
assert.ok(inventoryEngineStart >= 0 && inventoryEngineEnd > inventoryEngineStart, "inventory engine section must exist");
new vm.Script(mainScriptSource.slice(0, inventoryEngineStart), { filename: "DataOps.runtime-preamble.js" }).runInContext(runtimeContext);
new vm.Script(
  "globalThis.actualOperationModule = DATAOPS_OPERATION_MODULE;" +
  "globalThis.actualPurchaseFlowModule = DATAOPS_PURCHASE_FLOW_MODULE;" +
  "globalThis.actualSourceLedgerModule = DATAOPS_SOURCE_LEDGER_MODULE;" +
  "globalThis.actualExportModule = EXPORT_MODULE;",
  { filename: "DataOps.module-exports.js" },
).runInContext(runtimeContext);
new vm.Script(
  `${mainScriptSource.slice(inventoryEngineStart, inventoryEngineEnd)}\nglobalThis.actualUseInventoryEngine = useInventoryEngine;`,
  { filename: "DataOps.inventory-engine.js" },
).runInContext(runtimeContext);

const mappings = { excludeVendor: "우리농산, 1전송, 3우리, 가구매, 가판매", internalLot: "", lifoVendor: "", priorityVendor: "" };
const createEngine = () => {
  hookState = [];
  hookIndex = 0;
  const alerts = [];
  const transferAlerts = [];
  const engine = runtimeContext.actualUseInventoryEngine({
    mappings,
    grouping: { manageMode: "CODE_SUMMARY", priceMode: "latest" },
    setAlertMsg: (message) => alerts.push(String(message)),
    setTransferClosingAlert: (payload) => transferAlerts.push(payload),
    setConfirmModal: () => {},
    setIsProcessing: () => {},
    setAppStep: () => {},
  });
  return { engine, alerts, transferAlerts };
};

const conversion = fixture.conversion;
const match = runtimeContext.actualOperationModule.buildReplacementCostMatch({
  salesItem: { 코드: "SPLIT", 품명: "소분" },
  actualItem: { 코드: "RAW", 품명: "원물", 단가: conversion.sourceUnitCost },
  salesQty: conversion.targetQty,
  actualQty: conversion.sourceQty,
  type: runtimeContext.actualOperationModule.TYPES.BUNDLE_CONVERT,
});
assert.equal(match.costAmount, conversion.expectedTotalCost, "source costAmount must be the single total-cost basis");
assert.ok(Math.abs(match.salesUnitCost * conversion.targetQty - conversion.expectedTotalCost) < 1e-9, "precise converted unit cost must retain the source total");
assert.equal(match.displayUnitCost, conversion.expectedDisplayUnitCost, "converted unit cost display must retain the legacy 100-won rounding policy");
assert.equal(match.costLayer.costAmount, conversion.expectedTotalCost, "cost layer must retain the source total");

const conversionRuntime = createEngine();
conversionRuntime.engine.setProductData([
  { batchKey: "RAW", 코드: "RAW", 품명: "원물", 단가: conversion.sourceUnitCost, 기초: 1, 입고: 0, 출고: 1, 대체입고: 0, 대체출고: 0, 전산잔량: 0, 실사: 0, 로스: 0, 매출액: 18000, 매출원가: 12000, 메모: "", 이슈: [], 출고내역: { 고객: { qty: 1, rev: 18000, cogs: 12000, displayVendor: "고객" } } },
  { batchKey: "SPLIT", 코드: "SPLIT", 품명: "소분", 단가: conversion.existingTargetUnitCost, 기초: 9, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0, 전산잔량: 9, 실사: 9, 로스: 0, 매출액: 0, 매출원가: 0, 메모: "", 이슈: [], 출고내역: {} },
]);
conversionRuntime.engine.handleSalesMove("RAW", "SPLIT", "고객", conversion.targetQty, { sourceDeductQty: conversion.sourceQty, maxQty: conversion.sourceQty, isCtrlPressed: true, skipTargetInference: true });
const convertedRows = hookState[0];
const convertedTarget = convertedRows.find((row) => row.batchKey === "SPLIT");
assert.equal(convertedTarget.매출원가, conversion.expectedTotalCost, "converted Lot COGS must retain the source total");
assert.equal(convertedTarget.출고내역.고객.cogs, conversion.expectedTotalCost, "customer allocation must retain the source total");
assert.equal(convertedTarget._costLayers[0].costAmount, conversion.expectedTotalCost, "runtime cost layer must retain the source total");
assert.ok(Math.abs(convertedTarget._costLayers[0].unitCost * conversion.targetQty - conversion.expectedTotalCost) < 1e-9, "subsequent FIFO cost must use the precise converted unit cost");
assert.equal(runtimeContext.actualOperationModule.getDisplayUnitCost(convertedTarget), conversion.expectedDisplayUnitCost, "runtime converted unit cost display must remain 1,300 won");
const f9SalesRows = runtimeContext.actualExportModule.buildSalesSummaryRows({ productData: convertedRows, targetDateStr: "2026-08-11" });
assert.equal(f9SalesRows.find((row) => row["상품코드"] === "SPLIT")["총원가"], conversion.expectedTotalCost, "F9 sales cost must retain the source total");
const convertedInventoryRow = {
  batchKey: "SPLIT-STOCK", 코드: "SPLIT", 품명: "소분 재고", 단가: conversion.existingTargetUnitCost,
  _matchedUnitCost: conversion.sourceUnitCost / conversion.targetQty, _convertedUnitCostApplied: true,
  기초: conversion.targetQty, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0,
  전산잔량: conversion.targetQty, 실사: conversion.targetQty, 로스: 0, 이슈: [], 출고내역: {},
};
const convertedInventoryLedger = runtimeContext.actualExportModule.buildClosingAnalysisLedgerRows({ productData: [convertedInventoryRow], targetDateStr: "2026-08-11" })[0];
assert.equal(convertedInventoryLedger["매입단가(원가)"], conversion.expectedDisplayUnitCost, "F9 inventory must display the legacy rounded unit cost");
assert.equal(convertedInventoryLedger["기말재고액(자산가치)"], conversion.expectedTotalCost, "F9 inventory amount must retain the precise converted total");

const excludedRuntime = createEngine();
assert.equal(excludedRuntime.engine.executeAnalysis(fixture.excludedConfirmedPurchase), true, "excluded-purchase fixture must analyze");
const excludedRows = hookState[0].filter((row) => String(row.코드) === "DOPS-EXCLUDED-001");
assert.equal(excludedRows.some((row) => row._purchaseFlowKind === "CONFIRMED_EXTERNAL" || Number(row.입고) === 130), false, "excluded transaction vendor must not create a calculated purchase Lot");
assert.equal(excludedRows.reduce((sum, row) => sum + Number(row.입고 || 0), 0), 0, "excluded purchase must contribute zero calculated inbound quantity");
assert.equal(runtimeContext.actualExportModule.buildPurchaseRows({ productData: excludedRows, targetDateStr: "2026-08-11" }).length, 0, "excluded purchase must not enter F9 purchase rows");
assert.equal(runtimeContext.actualExportModule.buildNextBaseStockRows({ productData: excludedRows, targetDateStr: "2026-08-11" }).length, 0, "excluded purchase must not create F9 stock value");
const excludedAuditEntries = runtimeContext.actualSourceLedgerModule.collectEntries(excludedRows)
  .filter((entry) => entry.sourceRaw?.전표번호 === "EXCLUDED-IN-001");
assert.equal(excludedAuditEntries.length, 1, "excluded purchase must remain once in the audit Source Ledger");
assert.equal(excludedAuditEntries[0].calculationExcluded, true, "audit Source Ledger entry must be explicitly calculation-excluded");
assert.equal(runtimeContext.actualSourceLedgerModule.sumRole(excludedRows, "in"), 0, "audit-only inbound must not affect calculated Source Ledger totals");

const excludedOnlyRuntime = createEngine();
assert.equal(excludedOnlyRuntime.engine.executeAnalysis(fixture.excludedOnlyPurchase), true, "hostless excluded-only fixture must analyze");
const excludedOnlyRows = hookState[0];
assert.equal(excludedOnlyRows.filter((row) => !row._auditOnly).length, 0, "hostless excluded-only input must create no calculated product row");
assert.equal(excludedOnlyRows.reduce((sum, row) => sum + Number(row.입고 || 0), 0), 0, "hostless excluded-only input must contribute zero calculated inbound quantity");
assert.equal(runtimeContext.actualExportModule.buildPurchaseRows({ productData: excludedOnlyRows, targetDateStr: "2026-08-11" }).length, 0, "hostless excluded-only input must create no F9 purchase row");
assert.equal(runtimeContext.actualExportModule.buildNextBaseStockRows({ productData: excludedOnlyRows, targetDateStr: "2026-08-11" }).length, 0, "hostless excluded-only input must create no F9 stock or FIFO row");
const excludedOnlyAuditEntries = runtimeContext.actualSourceLedgerModule.collectEntries(excludedOnlyRows)
  .filter((entry) => entry.sourceRaw?.전표번호 === "EXCLUDED-ONLY-IN-001");
assert.equal(excludedOnlyAuditEntries.length, 1, "hostless excluded-only source must remain once in the audit Source Ledger");
assert.equal(excludedOnlyAuditEntries[0].calculationExcluded, true, "hostless audit Source Ledger entry must be explicitly calculation-excluded");
assert.equal(runtimeContext.actualSourceLedgerModule.sumRole(excludedOnlyRows, "in"), 0, "hostless audit-only inbound must have zero calculated Source Ledger effect");

const warehouseRuntime = createEngine();
assert.equal(warehouseRuntime.engine.executeAnalysis(fixture.warehouse02), true, "02 warehouse analysis must complete without ReferenceError");
assert.equal(warehouseRuntime.transferAlerts.length, 1, "02 warehouse imbalance must open one dedicated popup");
assert.equal(warehouseRuntime.transferAlerts[0].errors.length, 1, "02 warehouse popup must contain the one imbalance");

const f9ProductData = [
  { batchKey: "F9-A", 코드: "F9-A", 품명: "A", 단가: 1000, 기초: 1, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0, 전산잔량: 1, 실사: 1, 로스: 0, 이슈: [], 출고내역: {} },
  { batchKey: "F9-B", 코드: "F9-B", 품명: "B", 단가: 2000, 기초: 1, 입고: 0, 출고: 0, 대체입고: 0, 대체출고: 0, 전산잔량: 1, 실사: 1, 로스: 0, 이슈: [], 출고내역: {} },
];
const emptyViewWorkbook = runtimeContext.actualExportModule.createCombinedWorkbook({ productData: f9ProductData, screenRows: [], targetDateStr: "2026-08-11" }).wb;
assert.deepEqual(Array.from(emptyViewWorkbook.SheetNames), ["전체재고", "구매잔량", "기타상품", "실사양식", "확인요청", "재고수불_마감", "수불마감_분석원장", "소분치환_후보", "마스터_확인필요", "보고서", "원본 판매전표", "정정 판매현황"]);
assert.equal(emptyViewWorkbook.Sheets["전체재고"].__aoa.length, 2, "explicit empty current view must export zero first-sheet data rows");
assert.equal(emptyViewWorkbook.Sheets["재고수불_마감"].__aoa.length, 3, "explicit empty current view must not remove full-data closing-ledger rows");
assert.equal(emptyViewWorkbook.Sheets["수불마감_분석원장"].__aoa.length, 3, "explicit empty current view must not remove full-data analysis-ledger rows");
const nonEmptyViewWorkbook = runtimeContext.actualExportModule.createCombinedWorkbook({ productData: f9ProductData, screenRows: [f9ProductData[1]], targetDateStr: "2026-08-11" }).wb;
assert.equal(nonEmptyViewWorkbook.Sheets["전체재고"].__aoa.length, 3, "non-empty current view must export only its one first-sheet row");
assert.equal(nonEmptyViewWorkbook.Sheets["전체재고"].__aoa[2][1], "F9-B", "non-empty current view must preserve the selected screen row");
const omittedViewWorkbook = runtimeContext.actualExportModule.createCombinedWorkbook({ productData: f9ProductData, targetDateStr: "2026-08-11" }).wb;
assert.equal(omittedViewWorkbook.Sheets["전체재고"].__aoa.length, 4, "omitted screenRows must preserve the full-data compatibility fallback");

console.log("DataOps regression-recovery fixture contract passed.");
