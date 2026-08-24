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
const mainScriptSource = source.slice(
  mainScriptStart + mainScriptMarker.length,
  mainScriptEnd,
);
new vm.Script(
  mainScriptSource,
  { filename: "DataOps.inline.js" },
);

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
  const v110Analysis = section(
    "const executeAnalysis = useCallback",
    "const runAnalysis = useCallback",
  );
  assert.match(source, /excludeVendor:\s*'우리농산,\s*1전송,\s*3우리,\s*가구매,\s*가판매'/, "V110 CONFIG must retain 우리농산 exclusion");
  assert.match(v110Analysis, /const excludeList = \(mappings\.excludeVendor \|\| ''\)\.split/, "V110 analysis must build its exclusion list from CONFIG mappings");
  assert.match(v110Analysis, /const isExcludedTransactionRow = \(row = \{\}, role = ''\) => !!getExcludedVendorHit\(row, role\)/);
  assert.match(v110Analysis, /if \(type === 'in' && isExcludedTransactionRow\(item, 'in'\)\)\s*return;/, "V110 신규 매입 must exclude 우리농산 before calculation");
  const workState = section("const DATAOPS_WORK_STATE_MODULE", "const DATAOPS_XLSX_WORKER_MODULE");
  for (const field of ["DB_NAME", "STORE_NAME", "CURRENT_KEY", "VERSION", "productData", "substHistory", "analysisPeriod", "targetDateStr"]) assert.match(workState, new RegExp(`\\b${field}\\b`), `missing V110 work-state marker: ${field}`);
  assert.match(workState, /store\.put\(snapshot,\s*DATAOPS_WORK_STATE_MODULE\.CURRENT_KEY\)/);
  assert.match(workState, /\.get\(DATAOPS_WORK_STATE_MODULE\.CURRENT_KEY\)/);
  assert.match(source, /const handleSpacebarLink = useCallback[\s\S]*executeImmediateSubstitution/, "V110 Space substitution path must remain");
  const vendorChip = section("const DATAOPS_VENDOR_CHIP_MODULE", "const DATAOPS_SUMMARY_ROW_TOKENS");
  assert.match(vendorChip, /reconcileItem:/);
  assert.match(vendorChip, /cancelVendorChip:/);
  console.log("DataOps V110 operational integrity contract passed.");
  process.exit(0);
}

const executeAnalysis = section(
  "const executeAnalysis = useCallback",
  "const runAnalysis = useCallback",
);

const inventoryEngineMarker = "const useInventoryEngine =";
const inventoryEngineStart = mainScriptSource.indexOf(inventoryEngineMarker);
const inventoryEngineEnd = mainScriptSource.indexOf(
  "const IssueChip = React.memo",
  inventoryEngineStart,
);
assert.notEqual(
  inventoryEngineStart,
  -1,
  "Missing useInventoryEngine runtime source",
);
assert.ok(
  inventoryEngineEnd > inventoryEngineStart,
  "Missing useInventoryEngine runtime end marker",
);

const hookState = [];
let hookIndex = 0;
const runtimeReact = {
  useState: (initialValue) => {
    const index = hookIndex++;
    const initial =
      typeof initialValue === "function" ? initialValue() : initialValue;
    hookState[index] = initial;
    return [
      initial,
      (nextValue) => {
        hookState[index] =
          typeof nextValue === "function"
            ? nextValue(hookState[index])
            : nextValue;
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
    getItem: (key) =>
      storageValues.has(String(key)) ? storageValues.get(String(key)) : null,
    setItem: (key, value) => storageValues.set(String(key), String(value)),
    removeItem: (key) => storageValues.delete(String(key)),
  },
  setTimeout: (callback) => {
    callback();
    return 1;
  },
  clearTimeout: () => {},
});
runtimeContext.window = runtimeContext;
runtimeContext.self = runtimeContext;
runtimeContext.globalThis = runtimeContext;

new vm.Script(mainScriptSource.slice(0, inventoryEngineStart), {
  filename: "DataOps.runtime-preamble.js",
}).runInContext(runtimeContext);
new vm.Script(
  `${mainScriptSource.slice(
    inventoryEngineStart,
    inventoryEngineEnd,
  )}\nglobalThis.actualUseInventoryEngine = useInventoryEngine;`,
  { filename: "DataOps.inventory-engine.js" },
).runInContext(runtimeContext);

const runtimeAlerts = [];
const inventoryEngine = runtimeContext.actualUseInventoryEngine({
  mappings: {},
  grouping: {},
  setAlertMsg: (message) => runtimeAlerts.push(message),
  setConfirmModal: () => {},
  setIsProcessing: () => {},
  setAppStep: () => {},
});
const actualExecuteResult = inventoryEngine.executeAnalysis({
  parsedPrev: [],
  parsedIn: [],
  parsedOut: [],
  parsedEnd: [
    {
      코드: "",
      품명: "기준선 테스트 상품",
      수량: 0,
      _raw: {},
    },
  ],
  periodStr: "2026-07-31",
  targetDateStrFromData: "2026-07-31",
  endFileProvided: true,
});
assert.equal(
  actualExecuteResult,
  true,
  "actual executeAnalysis must complete for a name-keyed stock-count row",
);
assert.equal(hookState[0].length, 1);
assert.equal(hookState[0][0].품명, "기준선 테스트 상품");
assert.equal(hookState[0][0].실사, 0);

assert.doesNotMatch(executeAnalysis, /0\.7|70\s*%|isFullEndFile/);
assert.match(
  executeAnalysis,
  /!hasClosingEnd\s*&&\s*endFileProvided\s*&&\s*simpleCountEndItems\.length === 0[\s\S]*return false;/,
  "an uploaded but unreadable actual-count file must stop analysis",
);
assert.doesNotMatch(
  executeAnalysis,
  /pDataKeysByCountKey\.size\s*>\s*0\s*&&\s*simpleCountEndItems\.length === 0/,
  "normal analysis without slot-4 actual-count input must remain available",
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
assert.doesNotMatch(source, /handleToggleAdminComplete|onToggleAdminComplete/);
assert.doesNotMatch(source, />완료 확정<|>관리자 완료</);
assert.doesNotMatch(source, /수기확인완료\s*:\s*true/);

const parseAndAnalysis = section(
  "const parseExcelData =",
  "const runCostExtraction = useCallback",
);
assert.match(
  parseAndAnalysis,
  /endFileProvided:\s*!!filesObj\.end/,
  "runAnalysis must distinguish an absent count file from an uploaded unreadable file",
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

assert.doesNotMatch(executeAnalysis, /recordUnallocatedLot|UNALLOCATED_LOT|_unallocatedLotQty/);
assert.match(executeAnalysis, /DATAOPS_SALES_POLICY_MODULE\.buildSameCodeAllocationPlan/);
assert.match(executeAnalysis, /FIFO_SHORTAGE_SAME_CODE/);
assert.match(executeAnalysis, /const pool = stockPool\[code\]/);
assert.doesNotMatch(executeAnalysis, /detailShare/);

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
assert.match(
  exportModule,
  /buildNextBaseStockRows\(\{\s*productData:\s*operationalProductData,\s*targetDateStr\s*\}\)/,
);
assert.doesNotMatch(exportModule, /filteredProductData|screenRows/);
const stockCountRows = section(
  "buildStockCountSheetRows:",
  "buildSalesDetailRows:",
);
assert.match(
  stockCountRows,
  /safeNum\(aggregated\[key\]\.수량\)\s*===\s*0/,
  "same-day actual-count template must omit zero rows",
);
assert.match(stockCountRows, /const stockCountDate\s*=\s*targetDateStr\s*;/);
assert.doesNotMatch(stockCountRows, /addOneDay\s*\(/);
const combinedExport = section(
  "const handleCombinedExport = useCallback",
  "const handlePrintOutput = useCallback",
);
assert.match(combinedExport, /if\s*\(isClosingOutputBlocked\)/);
assert.match(combinedExport, /createCombinedWorkbook\(\{\s*productData: closingProductData,[\s\S]*wholeStockRows: closingRows/);
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
assert.match(source, /'관리자확인완료':\s*''/);
assert.match(source, /'관리자확인시각':\s*''/);
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
  "const handleGlobalDragOver",
  "const handleResetFiles",
);
assert.match(
  globalDragHandlers,
  /if\s*\(DATAOPS_DRAG_EVENT_MODULE\.isFileDrag\(e\)\)\s*e\.preventDefault\(\)/,
);
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
