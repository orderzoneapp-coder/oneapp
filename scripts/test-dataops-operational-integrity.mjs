#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const mainScriptMarker = '<script type="text/javascript">';
const mainScriptStart = source.indexOf(mainScriptMarker);
const mainScriptEnd = source.lastIndexOf("</script>");
assert.notEqual(mainScriptStart, -1, "Missing DataOps main script block");
assert.ok(mainScriptEnd > mainScriptStart, "Missing DataOps main script closing tag");
new vm.Script(
  source.slice(mainScriptStart + mainScriptMarker.length, mainScriptEnd),
  { filename: "DataOps.inline.js" },
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const executeAnalysis = section(
  "const executeAnalysis = useCallback",
  "const runAnalysis = useCallback",
);
assert.doesNotMatch(executeAnalysis, /0\.7|70\s*%|isFullEndFile/);
assert.match(
  executeAnalysis,
  /simpleCountEndItems\.length === 0[\s\S]*실사파일이 없거나 실사 품목을 읽지 못해 작업을 중단했습니다[\s\S]*return false;/,
  "missing actual-count file must stop analysis",
);
assert.match(
  executeAnalysis,
  /missingCountItems\.length > 0[\s\S]*실사파일 품목 누락으로 작업을 중단했습니다[\s\S]*return false;/,
  "one missing inventory item must stop analysis",
);
assert.doesNotMatch(
  executeAnalysis,
  /item\.실사\s*=\s*0\s*;/,
  "analysis must not auto-confirm a missing actual quantity as zero",
);
assert.doesNotMatch(
  executeAnalysis,
  /if\s*\(baseQty\s*<=\s*0\)\s*return/,
  "closing restore must preserve zero and negative rows during today's analysis",
);
assert.doesNotMatch(
  executeAnalysis,
  /type\s*===\s*['"]prev['"][\s\S]{0,120}qtyToApply\s*<=\s*0[\s\S]{0,40}return/,
  "previous-stock input must not discard zero or negative rows during analysis",
);

const issueJump = section(
  "const handleIssueJump = useCallback",
  "const handleAcknowledgeAll = useCallback",
);
assert.doesNotMatch(issueJump, /수기확인완료\s*=\s*true/);
assert.doesNotMatch(issueJump, /replace\(\/🚨\/g,\s*['\"]✅['\"]\)/);
const acknowledgeAll = section(
  "const handleAcknowledgeAll = useCallback",
  "const handleSpacebarLink = useCallback",
);
assert.doesNotMatch(acknowledgeAll, /setProductData|수기확인완료\s*=\s*true/);
assert.match(acknowledgeAll, /handleIssueJump\(type,\s*'next',\s*false\)/);
assert.match(source, /_adminCompletionSource:\s*shouldComplete\s*\?\s*'MANUAL_ADMIN'/);
assert.doesNotMatch(source, /수기확인완료\s*:\s*true/);

const parseAndAnalysis = section(
  "const parseExcelData =",
  "const runCostExtraction = useCallback",
);
assert.match(parseAndAnalysis, /sale\._salesPurchaseAmount\s*=\s*qty\s*\*\s*purchaseUnitCost/);
assert.match(parseAndAnalysis, /item\.전산잔량\s*=\s*item\.기초\s*\+\s*item\.입고\s*-\s*item\.출고/);
assert.match(parseAndAnalysis, /if\s*\(remainingQty < 0\)[\s\S]*deductFromBucket\([^;]+remainingQty[^;]*'RETURN'\)/);
assert.doesNotMatch(
  parseAndAnalysis,
  /Math\.abs\(\s*(?:sale\.)?(?:수량|_computedQty|_salesPurchaseAmount)\s*\)/,
  "ERP quantities and amounts must not be normalized with Math.abs",
);
const vendorChipModule = section(
  "const DATAOPS_VENDOR_CHIP_MODULE",
  "const DATAOPS_SUMMARY_ROW_TOKENS",
);
assert.doesNotMatch(vendorChipModule, /if\s*\(outQty\s*<=\s*0\)\s*reconciledDetails\s*=\s*\{\}/);
assert.doesNotMatch(vendorChipModule, /출고:\s*Math\.max\(0,/);
assert.doesNotMatch(vendorChipModule, /매출액:\s*Math\.max\(0,/);
assert.doesNotMatch(vendorChipModule, /매출원가:\s*Math\.max\(0,/);
const vendorContext = {
  safeNum: (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  safeStr: (value, fallback = "") =>
    value === undefined || value === null || value === "" ? fallback : String(value),
  formatQty: (value) => String(value),
};
vm.createContext(vendorContext);
new vm.Script(
  `${vendorChipModule}\nglobalThis.vendorChipModule = DATAOPS_VENDOR_CHIP_MODULE;`,
  { filename: "DataOps.vendor-chip.js" },
).runInContext(vendorContext);
const returnRow = {
  출고: -2,
  매출액: -200,
  매출원가: -100,
  기초: 0,
  입고: 0,
  대체입고: 0,
  대체출고: 0,
  실사: 2,
  메모: "",
  출고내역: {
    반품처: {
      qty: -2,
      rev: -200,
      cogs: -100,
      displayVendor: "반품처",
    },
  },
};
const reconciledReturn = vendorContext.vendorChipModule.reconcileItem(returnRow);
assert.equal(reconciledReturn.출고내역["반품처"].qty, -2);
assert.equal(reconciledReturn.출고내역["반품처"].rev, -200);
assert.equal(reconciledReturn.출고내역["반품처"].cogs, -100);
const reducedReturn = vendorContext.vendorChipModule.cancelVendorChip(
  returnRow,
  "반품처",
  -1,
);
assert.equal(reducedReturn.출고, -1);
assert.equal(reducedReturn.매출액, -100);
assert.equal(reducedReturn.매출원가, -50);

assert.match(executeAnalysis, /const recordUnallocatedLot\s*=/);
assert.match(executeAnalysis, /_lotAllocationStatus:\s*'UNALLOCATED'/);
assert.match(executeAnalysis, /_unallocatedLotQty/);
assert.match(executeAnalysis, /mode:\s*'NO_PURCHASE_LOT_UNALLOCATED'/);
assert.doesNotMatch(executeAnalysis, /SHORTAGE_OVER_ALLOC/);
assert.doesNotMatch(executeAnalysis, /lastRow\.출고\s*\+=\s*remaining/);
assert.match(source, /msg\.includes\('🚨Lot미배정'\)/);

const substitution = section(
  "const executeImmediateSubstitution = useCallback",
  "const executeAnalysis = useCallback",
);
assert.match(substitution, /previousCostForReplacedQty/);
assert.match(substitution, /np\.매출원가\s*=\s*safeNum\(np\.매출원가\)\s*-\s*previousCostForReplacedQty\s*\+\s*replacementCostAmount/);
assert.match(substitution, /previousManualCostForReplacementQty/);
assert.match(substitution, /targetAfter\.매출원가\s*=\s*safeNum\(targetAfter\.매출원가\)\s*-\s*previousManualCostForReplacementQty\s*\+\s*manualAppliedCostAmount/);
assert.match(substitution, /return\s*\{\s*\.\.\.item,\s*단가:\s*originalPrice\s*\}/);
assert.doesNotMatch(substitution, /np\.단가\s*=\s*(?:targetUnitCost|replacementUnitCost)/);
assert.doesNotMatch(substitution, /subItem\.매출원가\s*=/);

const exportModule = section(
  "createCombinedWorkbook:",
  "const STORAGE_MODULE",
);
assert.match(exportModule, /buildNextBaseStockRows\(\{\s*productData,\s*targetDateStr\s*\}\)/);
assert.doesNotMatch(exportModule, /filteredProductData|screenRows/);
const stockCountRows = section(
  "buildStockCountSheetRows:",
  "buildSalesDetailRows:",
);
assert.doesNotMatch(
  stockCountRows,
  /aggregated\[key\]\.수량\s*!==\s*0/,
  "actual-count output must retain zero rows",
);
const combinedExport = section(
  "const handleCombinedExport = useCallback",
  "const handlePrintOutput = useCallback",
);
assert.match(combinedExport, /if\s*\(isClosingOutputBlocked\)/);
assert.match(combinedExport, /createCombinedWorkbook\(\{\s*productData,/);
assert.doesNotMatch(combinedExport, /filteredProductDataRef/);

const workState = section(
  "const DATAOPS_WORK_STATE_MODULE",
  "const DATAOPS_XLSX_WORKER_MODULE",
);
for (const field of [
  "productData",
  "substHistory",
  "ackMultiCodes",
  "analysisPeriod",
  "targetDateStr",
]) {
  assert.match(workState, new RegExp(`\\b${field}\\b`), `work-state snapshot missing ${field}`);
}
assert.match(source, /'관리자확인완료'/);
assert.match(source, /'관리자확인시각'/);
assert.match(source, /restoreWorkState/);

assert.match(source, /const stockLotIndex = new Map\(\)/);
assert.doesNotMatch(
  source,
  /dataops-virtual-row|content-visibility:\s*auto/,
  "interactive table rows must not use content-visibility virtualization",
);
assert.doesNotMatch(
  source,
  /\bisGlobalDragging\b|\bsetIsGlobalDragging\b/,
  "external file drag must not rerender the full DataOps app",
);
assert.match(
  source,
  /\.dataops-external-file-drag\s+\.dataops-work-table\s+tbody[\s\S]*?pointer-events:\s*none\s*!important/,
  "external file drag must bypass hit-testing in the large work table",
);
const dragEventModuleSource = section(
  "const DATAOPS_VENDOR_DRAG_TYPE",
  "const ProductRow",
);
const dragEventContext = {};
vm.runInNewContext(
  `${dragEventModuleSource}
globalThis.dragEventModule = DATAOPS_DRAG_EVENT_MODULE;
globalThis.vendorDragType = DATAOPS_VENDOR_DRAG_TYPE;`,
  dragEventContext,
  { filename: "DataOps.drag-events.js" },
);
const dragEventModule = dragEventContext.dragEventModule;
assert.equal(
  dragEventModule.isFileDrag({ dataTransfer: { types: ["Files"], files: [] } }),
  true,
);
assert.equal(
  dragEventModule.isVendorDrag({
    dataTransfer: { types: [dragEventContext.vendorDragType], files: [] },
  }),
  true,
);
assert.equal(
  dragEventModule.isVendorDrag({
    dataTransfer: { types: ["Files", "text/plain"], files: [{}] },
  }),
  false,
  "external Excel drag must not enter row-level vendor movement",
);
const externalDragClasses = new Set();
const externalDragRoot = {
  classList: {
    contains: (name) => externalDragClasses.has(name),
    toggle: (name, active) => (
      active ? externalDragClasses.add(name) : externalDragClasses.delete(name)
    ),
  },
};
const externalDragChild = { closest: () => externalDragRoot };
dragEventModule.setExternalFileDragActive(
  { currentTarget: externalDragChild },
  true,
);
assert.equal(externalDragClasses.has("dataops-external-file-drag"), true);
dragEventModule.setExternalFileDragActive(
  { currentTarget: externalDragChild },
  false,
);
assert.equal(externalDragClasses.has("dataops-external-file-drag"), false);
const productRowDrag = section("const ProductRow", "const FileBox");
assert.match(
  productRowDrag,
  /if\s*\(!DATAOPS_DRAG_EVENT_MODULE\.isVendorDrag\(e\)\)\s*return;/,
);
assert.match(
  productRowDrag,
  /setData\(DATAOPS_VENDOR_DRAG_TYPE,\s*'1'\)/,
);
const globalDragHandlers = section(
  "const handleGlobalDragEnter",
  "const handleResetFiles",
);
assert.match(
  globalDragHandlers,
  /if\s*\(DATAOPS_DRAG_EVENT_MODULE\.isFileDrag\(e\)\)\s*e\.preventDefault\(\)/,
);
assert.match(globalDragHandlers, /setExternalFileDragActive\(e,\s*true\)/);
assert.match(globalDragHandlers, /setExternalFileDragActive\(e,\s*false\)/);
assert.match(source, /"data-dataops-root":\s*"1"/);
assert.match(source, /onDragEnter:\s*handleGlobalDragEnter/);
assert.match(source, /onDragLeave:\s*handleGlobalDragLeave/);
assert.match(source, /className:\s*"dataops-work-table /);
assert.match(source, /const DATAOPS_XLSX_WORKER_MODULE/);
assert.match(source, /XLSX Worker 파싱 실패, 메인 스레드 경로로 복구합니다/);
assert.match(source, /XLSX Worker 출력 실패, 메인 스레드 경로로 복구합니다/);
const workerModule = section(
  "const DATAOPS_XLSX_WORKER_MODULE",
  "const parseExcelData =",
);
const workerTemplate = workerModule.match(/const source = `([\s\S]*?)`;/);
assert.ok(workerTemplate, "missing XLSX worker source template");
const compiledWorkerSource = workerTemplate[1].replace(
  /\$\{JSON\.stringify\('([^']+)'\)\}/g,
  (_, url) => JSON.stringify(url),
);
new vm.Script(compiledWorkerSource, { filename: "DataOps.xlsx-worker.js" });
assert.match(workerModule, /XLSX Worker 응답 시간 초과/);

console.log("DataOps operational integrity contract passed.");
