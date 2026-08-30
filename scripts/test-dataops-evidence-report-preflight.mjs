#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const fixture = JSON.parse(
  fs.readFileSync(
    "scripts/fixtures/dataops-evidence-report-preflight.json",
    "utf8",
  ),
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const safeNum = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const safeStr = (value, fallback = "") => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim() || fallback;
};
const vendorSource = section(
  "const DATAOPS_VENDOR_CHIP_MODULE",
  "const DATAOPS_SUMMARY_ROW_TOKENS",
);
const context = vm.createContext({
  console,
  Date,
  safeNum,
  safeStr,
  parseNumber: safeNum,
  formatQty: (value) => String(value),
});
context.window = context;
context.globalThis = context;
new vm.Script(
  `${vendorSource}\nglobalThis.vendorChipModule = DATAOPS_VENDOR_CHIP_MODULE;\nglobalThis.preflightModule = DATAOPS_F9_PREFLIGHT_MODULE;`,
  { filename: "DataOps.vendor-chip.js" },
).runInContext(context);

for (const testCase of fixture.salesSourceEvidenceCases) {
  const evidence = context.vendorChipModule.buildSalesSourceEvidence({
    sale: testCase.sale,
    sourceId: `${testCase.sale._sourceFileName}|${testCase.sale._sourceSheet}|${testCase.sale._sourceRowNumber}`,
    code: "SALE-RAW",
    name: testCase.name,
    vendor: "거래처A",
    qty: testCase.qty,
    calculatedAmount: testCase.calculatedAmount,
  });
  assert.equal(evidence.unitPrice, testCase.expectedUnitPrice, `${testCase.name}: 원본 단가`);
  assert.equal(evidence.amount, testCase.expectedAmount, `${testCase.name}: 원본 금액`);
  assert.equal(evidence.calculatedAmount, testCase.expectedCalculatedAmount, `${testCase.name}: 계산 금액 분리`);
  assert.equal(evidence.fileName, testCase.sale._sourceFileName);
  assert.equal(evidence.sheetName, testCase.sale._sourceSheet);
  assert.equal(evidence.rowNumber, testCase.sale._sourceRowNumber);
}

for (const testCase of fixture.vendorChipCases) {
  const reconciled = context.vendorChipModule.reconcileItem(testCase.item);
  const chipQty = Object.values(reconciled.출고내역).reduce(
    (sum, detail) => sum + safeNum(detail.qty),
    0,
  );
  assert.equal(chipQty, testCase.expectedChipQty, testCase.name);
  assert.equal(
    Object.prototype.hasOwnProperty.call(reconciled.출고내역, "미지정"),
    false,
    `${testCase.name}: 미지정 칩 자동생성 금지`,
  );
  const vendorErrors = context.preflightModule
    .run({ productData: [reconciled] })
    .issues.filter((issue) => issue.type === "VENDOR_CHIP_MISMATCH");
  assert.equal(
    vendorErrors.length > 0,
    testCase.blocking,
    `${testCase.name}: 판매원본-칩 검증 판정`,
  );
  if (testCase.blocking) {
    assert.equal(vendorErrors[0].differenceQty, testCase.expectedDifference);
    assert.ok(vendorErrors[0].batchKey, `${testCase.name}: 상품 이동키`);
    assert.ok(vendorErrors[0].code, `${testCase.name}: 상품코드`);
    assert.ok(vendorErrors[0].name, `${testCase.name}: 상품명`);
    assert.ok(vendorErrors[0].reason, `${testCase.name}: 오류 사유`);
    assert.ok(vendorErrors[0].action, `${testCase.name}: 확인 조치`);
    assert.equal(vendorErrors[0].differenceAmount, testCase.expectedDifferenceAmount, `${testCase.name}: 차이금액 공란 보존`);
    assert.equal(vendorErrors[0].fileName, "판매.xlsx");
    assert.ok(vendorErrors[0].rowNumber);
  }
}

const preflightItems = fixture.preflightCases.map((testCase) => ({
    batchKey: testCase.batchKey,
    코드: testCase.code,
    품명: testCase.name,
    기초: 0,
    입고: testCase.inQty || 0,
    출고: testCase.type === "TOTAL_COST_MISMATCH" ? 1 : 0,
    전산잔량: testCase.inQty || 0,
    단가: testCase.unitCost === undefined ? 100 : testCase.unitCost,
    매출원가: testCase.salesCost || 0,
    출고내역:
      testCase.type === "TOTAL_COST_MISMATCH"
        ? {
            거래처A: {
              qty: 1,
              rev: 1000,
              cogs: testCase.chipCost,
              displayVendor: "거래처A",
            },
          }
        : {},
    이슈: testCase.issue ? [testCase.issue] : [],
    _unitConversionError: testCase.conversionError || "",
    _sourceEvidence:
      testCase.type === "MISSING_INBOUND_COST"
        ? [
            {
              sourceId: "구매.xlsx|구매현황|22",
              role: "in",
              vendor: "구매처A",
              qty: testCase.inQty,
              unitPrice: "",
              amount: "",
              fileName: "구매.xlsx",
              sheetName: "구매현황",
              rowNumber: 22,
            },
          ]
        : [],
  }));
const warehouseCase = fixture.preflightCases.find(
  (testCase) => testCase.type === "WAREHOUSE_02_MISMATCH",
);
const preflight = context.preflightModule.run({
  productData: preflightItems,
  transferClosingCheck: {
    errors: [
      {
        code: warehouseCase.code,
        name: warehouseCase.name,
        purchaseQty: warehouseCase.purchaseQty,
        salesQty: warehouseCase.salesQty,
        balance: warehouseCase.purchaseQty - warehouseCase.salesQty,
        purchaseDetails: [],
        salesDetails: [],
      },
    ],
  },
});
for (const testCase of fixture.preflightCases) {
  const issue = preflight.issues.find((candidate) => candidate.type === testCase.type);
  assert.ok(issue, `${testCase.type} fixture must remain in the F9 evidence report`);
  assert.ok(issue.batchKey || issue.code, `${testCase.type}: 상품 이동키가 필요합니다`);
  assert.ok(issue.code, `${testCase.type}: 상품코드가 필요합니다`);
  assert.ok(issue.name, `${testCase.type}: 상품명이 필요합니다`);
  assert.ok(issue.reason, `${testCase.type}: 오류 사유가 필요합니다`);
  assert.ok(issue.action, `${testCase.type}: 확인 조치가 필요합니다`);
}
const missingCostIssue = preflight.issues.find(
  (issue) => issue.type === "MISSING_INBOUND_COST",
);
assert.equal(missingCostIssue.fileName, "구매.xlsx");
assert.equal(missingCostIssue.sheetName, "구매현황");
assert.equal(missingCostIssue.rowNumber, 22);
assert.equal(missingCostIssue.sourcePrice, "", "비어 있는 원본 단가를 0으로 추정하면 안 됩니다");
assert.equal(missingCostIssue.calculatedCost, 0);
const unitConversionIssue = preflight.issues.find(
  (issue) => issue.type === "UNIT_CONVERSION_FAILURE",
);
assert.equal(unitConversionIssue.sourceQty, "", "단위변환 원본 수량 근거가 없으면 공란이어야 합니다");
assert.equal(unitConversionIssue.calculatedQty, "", "단위변환 계산 수량 근거가 없으면 공란이어야 합니다");
const warehouseIssue = preflight.issues.find(
  (issue) => issue.type === "WAREHOUSE_02_MISMATCH",
);
assert.equal(warehouseIssue.sourcePrice, "", "02창고 원본 단가 근거가 없으면 공란이어야 합니다");

const exportHandler = section(
  "const handleCombinedExport = useCallback",
  "const handlePrintOutput = useCallback",
);
assert.match(exportHandler, /flushFocusedTableEdit/);
assert.match(exportHandler, /DATAOPS_F9_PREFLIGHT_MODULE\.run/);
assert.doesNotMatch(exportHandler, /if \(!preflightResult\.ok\)/);
assert.doesNotMatch(exportHandler, /setF9PreflightResult|return;\s*}\s*setIsProcessing/);
assert.ok(
  exportHandler.indexOf("DATAOPS_F9_PREFLIGHT_MODULE.run") <
    exportHandler.indexOf("EXPORT_MODULE.createCombinedWorkbook"),
  "preflight must run before workbook creation",
);
assert.doesNotMatch(source, /f9PreflightResult|setF9PreflightResult/);
assert.doesNotMatch(source, /focusF9PreflightIssue|handleF9PreflightRecheck/);
assert.doesNotMatch(source, /오류를 해결하기 전에는 workbook을 생성하지 않습니다|해당 상품으로 이동|다시 점검/);

const closingReport = section(
  "buildClosingReportSheet:",
  "buildPrintRows:",
);
assert.match(closingReport, /DATAOPS_EVIDENCE_REPORT_MODULE\.buildRows/);
assert.doesNotMatch(closingReport, /거래처별 매출\/이익\/이익률|총매출|총이익|이익률\(%\)/);

const evidenceReportSource = section(
  "const DATAOPS_EVIDENCE_REPORT_MODULE",
  "const EXPORT_MODULE",
);
new vm.Script(
  `${evidenceReportSource}\nglobalThis.evidenceReportModule = DATAOPS_EVIDENCE_REPORT_MODULE;`,
  { filename: "DataOps.evidence-report.js" },
).runInContext(context);
assert.deepEqual(Array.from(context.evidenceReportModule.COLUMNS), [
  "상태",
  "오류·변경 유형",
  "상품코드",
  "상품명",
  "LOT 또는 작업행 식별값",
  "원본 파일명",
  "원본 시트명",
  "원본 행번호",
  "원본 거래처",
  "원본 수량",
  "원본 단가",
  "원본 금액",
  "계산 수량",
  "계산 단가",
  "계산 금액",
  "관리자 작업 유형",
  "관리자 작업 전 값",
  "관리자 작업 후 값",
  "수량 차이",
  "원가 차이",
  "차이·변경 사유",
  "확인 필요 내용",
]);
const normalItem = {
  batchKey: "NORMAL",
  코드: "NORMAL",
  품명: "정상행",
  출고: 0,
  단가: 100,
  매출원가: 0,
  출고내역: {},
  이슈: [],
  _orig: { 출고: 0, 단가: 100 },
};
assert.equal(
  context.evidenceReportModule.buildRows({
    productData: [normalItem],
    preflightResult: { ok: true, issues: [], counts: {} },
    substHistory: [],
  }).length,
  0,
  "normal ledger rows must not be duplicated in the report",
);
const adminRows = context.evidenceReportModule.buildRows({
  productData: [{ ...normalItem, 출고: 2 }],
  preflightResult: { ok: true, issues: [], counts: {} },
  substHistory: [
    {
      id: 1,
      type: "VENDOR_CHIP_EDIT",
      sourceKey: "NORMAL",
      sourceName: "정상행",
      sQty: 3,
      tQty: 2,
      sourceItemPrev: { ...normalItem, 출고: 3 },
      afterSummary: "after",
    },
  ],
});
assert.equal(adminRows.length, 1);
assert.equal(adminRows[0]["관리자 작업 유형"], "거래처 칩 수정");
assert.match(adminRows[0]["관리자 작업 전 값"], /출고/);
assert.equal(adminRows[0]["관리자 작업 후 값"], "after");
assert.equal(adminRows[0]["원본 금액"], "", "없는 원본 금액을 0으로 추정하면 안 됩니다");
assert.equal(adminRows[0]["확인 필요 내용"], "", "before 이력이 있으면 근거 없음으로 표시하면 안 됩니다");

const normalPreflight = context.preflightModule.run({
  productData: [normalItem],
});
assert.equal(normalPreflight.ok, true, "오류 0건 fixture는 F9를 통과해야 합니다");

const sheetJsResponse = await fetch(
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
);
assert.equal(sheetJsResponse.ok, true, "SheetJS를 불러와 실제 workbook을 검증해야 합니다");
new vm.Script(await sheetJsResponse.text(), {
  filename: "xlsx.full.min.js",
}).runInContext(context);
assert.ok(context.XLSX?.utils, "SheetJS가 초기화되어야 합니다");
new vm.Script(
  `globalThis.closingReportExportModule = Object.freeze({${closingReport}});`,
  { filename: "DataOps.closing-report-sheet.js" },
).runInContext(context);
const reportSheet = context.closingReportExportModule.buildClosingReportSheet({
  productData: [{ ...normalItem, 출고: 2 }],
  preflightResult: normalPreflight,
  substHistory: [
    {
      id: 1,
      type: "VENDOR_CHIP_EDIT",
      sourceKey: "NORMAL",
      sourceName: "정상행",
      sourceItemPrev: { ...normalItem, 출고: 3 },
      afterSummary: "after",
    },
  ],
});
const reportGrid = context.XLSX.utils.sheet_to_json(reportSheet, {
  header: 1,
  defval: "",
});
assert.deepEqual(
  Array.from(reportGrid[0]),
  Array.from(context.evidenceReportModule.COLUMNS),
  "보고서 시트의 실제 첫 행은 계산근거 22열이어야 합니다",
);
assert.equal(reportGrid.length, 2, "정상 원장행은 보고서에 중복되지 않아야 합니다");

const workbookSource = section("createCombinedWorkbook:", "const STORAGE_MODULE");
const expectedSheetOrder = [
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
for (const sheetName of expectedSheetOrder) {
  const sheetIndex = workbookSource.indexOf(`'${sheetName}'`);
  assert.ok(sheetIndex > previousSheetIndex, `F9 시트 순서 변경: ${sheetName}`);
  previousSheetIndex = sheetIndex;
}

context.DATAOPS_VIEW_LAYER_MODULE = { buildCodeSummaryRows: (rows) => rows };
context.FILTER_SORT_MODULE = { compareByCodeThenName: () => 0 };
context.STOCK_ENGINE_MODULE = {
  getActualQty: (item) => safeNum(item.실사 ?? item.전산잔량),
  getAdjustmentQty: (item) => safeNum(item.로스),
};
context.DATAOPS_MASTER_LINK_MODULE = {
  getCachedContext: () => ({}),
  buildOutputColumns: () => ({}),
  buildMasterLedgerInfo: () => ({}),
};
context.DATAOPS_MASTER_ITEM_HELPER = { isSettlementItem: () => false };
context.DATAOPS_SUBSTITUTION_CANDIDATE_MODULE = {
  buildExecutableRows: () => [],
};
context.DATAOPS_ISSUE_HELPER = {
  unique: (values) => Array.from(new Set(values)),
};
context.getBasicDisplayValue = () => "";
context.getStockManageGroup = () => "기타";
context.extractDateNum = () => 0;
const exportModuleSource = section(
  "const EXPORT_MODULE = Object.freeze({",
  "const DATAOPS_MERCH_STOCK_SYNC_MODULE",
);
new vm.Script(
  `${exportModuleSource}\nglobalThis.fullExportModule = EXPORT_MODULE;`,
  { filename: "DataOps.full-export-module.js" },
).runInContext(context);
const normalWorkbook = context.fullExportModule.createCombinedWorkbook({
  productData: [],
  targetDateStr: "2026-08-12",
  preflightResult: { ok: true, issues: [], counts: {} },
  substHistory: [],
});
assert.equal(normalWorkbook.exportFileNameDate, "20260812");
const issueWorkbook = context.fullExportModule.createCombinedWorkbook({
  productData: preflightItems,
  targetDateStr: "2026-08-12",
  preflightResult: preflight,
  substHistory: [],
});
assert.ok(issueWorkbook.wb.Sheets["보고서"], "preflight issues must be included in the workbook instead of blocking it");
const issueReportRows = context.XLSX.utils.sheet_to_json(issueWorkbook.wb.Sheets["보고서"], { defval: "" });
assert.ok(issueReportRows.length >= preflight.issues.length, "all detected issues must remain in the workbook report");
const workbookBytes = context.XLSX.write(normalWorkbook.wb, {
  bookType: "xlsx",
  type: "array",
});
assert.ok(workbookBytes.byteLength > 1000, "실제 F9 XLSX가 생성되어야 합니다");
const reopenedWorkbook = context.XLSX.read(new Uint8Array(workbookBytes), {
  type: "array",
});
assert.deepEqual(
  Array.from(reopenedWorkbook.SheetNames),
  expectedSheetOrder,
  "오류 0건이면 보고서 외 기존 시트 구조를 유지한 workbook을 생성해야 합니다",
);
const reopenedReportGrid = context.XLSX.utils.sheet_to_json(
  reopenedWorkbook.Sheets["보고서"],
  { header: 1, defval: "" },
);
assert.deepEqual(
  Array.from(reopenedReportGrid[0]),
  Array.from(context.evidenceReportModule.COLUMNS),
  "재오픈한 F9 보고서도 계산근거 22열 계약을 유지해야 합니다",
);

assert.doesNotMatch(source, /해당 상품으로 이동|다시 점검|오류를 해결하기 전에는 workbook을 생성하지 않습니다/);
assert.match(source, /salesSourceEvidenceByProductKey/);
assert.match(source, /NO_CODE\|\$\{safeStr\(evidenceName, '이름없음'\)\}/);
assert.match(source, /V1\.a22\.112_EvidenceReportPreflight/);
assert.doesNotMatch(vendorSource, /RECONCILED|base\.qty \+= delta|const delta = outQty - chipSum/);

console.log("DataOps 계산근거 리포트·판매칩 사전검증 계약이 통과했습니다.");
