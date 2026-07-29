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

const handlerSource = section(
  "const handleGenerateTransferSalesUpload = useCallback",
  "const handleValidateTransferSalesPrice = useCallback",
);
const baseFieldsSource = section(
  "const getTransferBaseFields = useCallback",
  "const isTransferSummaryLikeRow = useCallback",
);
const rowBuilderSource = section(
  "const buildTransferSalesUploadRows = useCallback",
  "const downloadWorkbook = useCallback",
);

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

let scenarioInput = [];
let capturedDownload = null;
let priceResolutionCount = 0;
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
  Promise,
  Uint8Array,
  ArrayBuffer,
  setTimeout,
  clearTimeout,
});
context.window = context;
context.self = context;
context.globalThis = context;
vm.runInContext(sheetJsSource.toString("utf8"), context, {
  filename: "xlsx.full.min.js",
});
assert.ok(context.XLSX?.utils, "SheetJS did not initialize");

Object.assign(context, {
  useCallback: (fn) => fn,
  files: { in: { name: "purchase.xlsx" } },
  isProcessing: false,
  mappings: { transferPriceGroups: {}, transferPriceColumns: {} },
  defaultMappings: { transferPriceGroups: {}, transferPriceColumns: {} },
  validateTransferPriceGroupText: () => [],
  parseExcelData: async () => scenarioInput.map((row) => ({ ...row })),
  buildTransferPriceConfig: () => ({
    groups: {
      샘플거래처: {
        customer: "샘플거래처",
        groupName: "샘플그룹",
        rule: ["입고가"],
        feeMode: "NONE",
        profitMode: "NONE",
        outputCustomerMode: "ORIGINAL_CUSTOMER",
      },
    },
    columns: {},
  }),
  downloadWorkbook: (wb, filename) => {
    capturedDownload = { wb, filename };
  },
  setAlertMsg: () => {},
  setIsProcessing: () => {},
  safeStr: (value, fallback = "") => {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value).trim() || fallback;
  },
  safeNum: (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  parseNumber: (value) => {
    if (value === undefined || value === null || value === "") return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const text = String(value).trim().replace(/,/g, "");
    if (/^\(.+\)$/.test(text)) return -Number(text.slice(1, -1)) || 0;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  formatMoney: (value) => String(value),
  getRawCell: (raw = {}, names = []) => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s/g, "")
        .toLowerCase();
    const keys = Object.keys(raw || {});
    for (const name of names) {
      const found = keys.find((key) => normalize(key) === normalize(name));
      if (
        found !== undefined &&
        raw[found] !== undefined &&
        raw[found] !== null &&
        String(raw[found]).trim() !== ""
      ) {
        return raw[found];
      }
    }
    return null;
  },
  transferStrictNumber: (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const text = String(value ?? "").replace(/,/g, "").trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return 0;
    return Number(text);
  },
  getTransferRawValue: (raw = {}, columnName = "") => {
    const target = String(columnName).replace(/\s/g, "").toLowerCase();
    const key = Object.keys(raw || {}).find(
      (candidate) =>
        String(candidate).replace(/\s/g, "").toLowerCase() === target,
    );
    return key === undefined ? null : raw[key];
  },
  isTransferSummaryLikeRow: () => false,
  getTransferPriceMissingReason: () => "판매단가 기준 없음",
});

new vm.Script(
  `${baseFieldsSource}\nglobalThis.actualGetTransferBaseFields = getTransferBaseFields;`,
  { filename: "DataOps.transfer-base-fields.js" },
).runInContext(context);

Object.assign(context, {
  resolveTransferSalesPrice: (item) => {
    priceResolutionCount += 1;
    const base = context.actualGetTransferBaseFields(item);
    const group = context.buildTransferPriceConfig().groups[base.groupCustomer];
    return {
      status: "MATCHED",
      price: 4500,
      priceKey: "입고가",
      columnName: "입고가",
      groupName: group?.groupName || "",
      rulePath: "입고가",
      feeMode: group?.feeMode || "NONE",
      profitMode: group?.profitMode || "NORMAL",
      outputCustomerMode: group?.outputCustomerMode || "GROUP_NAME",
      group,
      base,
    };
  },
  getTransferOutputCustomerName: (resolved) =>
    resolved.outputCustomerMode === "ORIGINAL_CUSTOMER"
      ? context.safeStr(
          resolved.base.detailCustomer || resolved.base.groupCustomer,
        )
      : context.safeStr(resolved.base.groupCustomer || resolved.groupName),
});

new vm.Script(
  `${rowBuilderSource}\nglobalThis.actualBuildTransferSalesUploadRows = buildTransferSalesUploadRows;`,
  { filename: "DataOps.transfer-sales-rows.js" },
).runInContext(context);

new vm.Script(
  `${handlerSource}\nglobalThis.runSalesUploadExport = handleGenerateTransferSalesUpload;`,
  { filename: "DataOps.sales-upload-columns.js" },
).runInContext(context);

const salesColumns = [
  "일자",
  "순번",
  "거래처코드",
  "거래처명",
  "출하창고",
  "거래유형",
  "전잔액",
  "전달사항",
  "품목코드",
  "품목명",
  "규격",
  "수량",
  "단가",
  "외화금액",
  "공급가액",
  "적요",
  "출고지시",
  "공지",
  "구매처",
  "날짜",
  "구매",
];
const outboundColumns = salesColumns.slice(0, 12);
const purchaseColumns = salesColumns.slice(0, 20);
const bannedHeaders = [
  "생산전표생성",
  "_적용그룹",
  "_적용단가명",
  "_단가룰",
  "_확인필요",
  "_수익",
  "_구매처보정전",
  "_구매처보정",
];

function purchaseInput(code, quantity, overrides = {}) {
  return {
    _raw: {
      거래처: "샘플거래처",
      거래처명: "3우리",
      품목코드: code,
      품목명: `상품-${code}`,
      수량: quantity,
      단가: 3200,
      도매A: 3800,
      구매처: "우리농산",
      날짜: "2026-07-29",
      적요: "정상",
      출고지시: "오전",
      전달사항: "전달",
      ...overrides,
    },
  };
}

const purchaseInputs = [
  purchaseInput("Q-BLANK", ""),
  purchaseInput("Q-ZERO", 0),
  purchaseInput("Q-POSITIVE", 2),
  purchaseInput("Q-NEGATIVE", -1),
  purchaseInput("Q-INVALID", "두개"),
  purchaseInput("Q-NO-CUSTOMER", 1, { 거래처: "", 거래처명: "" }),
  purchaseInput("", 1),
];

for (const missingQuantity of [null, undefined, "   "]) {
  const parsed = context.actualGetTransferBaseFields(
    purchaseInput("Q-MISSING-DIRECT", missingQuantity),
  );
  assert.equal(parsed.qtyMissing, true);
  assert.equal(parsed.qtyInvalid, false);
  assert.equal(parsed.qty, 0);
}

priceResolutionCount = 0;
const rowBuildResult = context.actualBuildTransferSalesUploadRows(
  purchaseInputs.map((row) => ({ ...row, _raw: { ...row._raw } })),
);
assert.equal(
  priceResolutionCount,
  2,
  "판매가 후보는 정상 양수와 음수 수량에만 적용해야 합니다.",
);
assert.equal(rowBuildResult.rows.length, 4);
assert.equal(rowBuildResult.fatalErrors.length, 3);
assert.equal(
  rowBuildResult.fatalErrors.some((row) =>
    String(row.reason).includes("수량 형식 확인"),
  ),
  true,
);
assert.equal(
  rowBuildResult.fatalErrors.some((row) =>
    String(row.reason).includes("거래처명 없음"),
  ),
  true,
);
assert.equal(
  rowBuildResult.fatalErrors.some((row) =>
    String(row.reason).includes("품목코드 없음"),
  ),
  true,
);
assert.equal(
  rowBuildResult.fatalErrors.some((row) =>
    ["Q-BLANK", "Q-ZERO"].includes(row.code),
  ),
  false,
  "수량 공란·0 행은 업로드불가에 포함되면 안 됩니다.",
);
const zeroWarnings = rowBuildResult.warnings.filter((row) =>
  String(row.reason).includes("수량 없음/0"),
);
assert.equal(zeroWarnings.length, 2);
assert.ok(
  zeroWarnings.every(
    (row) =>
      !String(row.reason).includes("역마진") &&
      !String(row.reason).includes("도매A과대"),
  ),
);
const builtRowsByCode = Object.fromEntries(
  rowBuildResult.rows.map((row) => [row["품목코드"], row]),
);
for (const code of ["Q-BLANK", "Q-ZERO"]) {
  assert.equal(builtRowsByCode[code]["수량"], 0);
  assert.equal(builtRowsByCode[code]["단가"], 0);
  assert.equal(builtRowsByCode[code]["공급가액"], 0);
  assert.equal(builtRowsByCode[code]["_수익"], 0);
}
assert.equal(builtRowsByCode["Q-POSITIVE"]["수량"], 2);
assert.equal(builtRowsByCode["Q-POSITIVE"]["단가"], 4500);
assert.equal(builtRowsByCode["Q-POSITIVE"]["공급가액"], 9000);
assert.equal(builtRowsByCode["Q-NEGATIVE"]["수량"], -1);
assert.equal(builtRowsByCode["Q-NEGATIVE"]["단가"], 4500);
assert.equal(builtRowsByCode["Q-NEGATIVE"]["공급가액"], -4500);

function plainRows(rows) {
  return Array.from(rows, (row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value])),
  );
}

function readSheetRows(XLSX, workbook, sheetName) {
  return plainRows(
    XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true }),
  );
}

async function buildAndReopen(inputRows) {
  scenarioInput = inputRows;
  capturedDownload = null;
  await context.runSalesUploadExport({ in: { name: "purchase.xlsx" } });
  assert.ok(capturedDownload?.wb, "판매업로드 workbook was not generated");

  const xlsxBytes = context.XLSX.write(capturedDownload.wb, {
    bookType: "xlsx",
    type: "array",
  });
  const byteView = new Uint8Array(xlsxBytes);
  assert.equal(String.fromCharCode(byteView[0], byteView[1]), "PK");
  return {
    original: capturedDownload.wb,
    reopened: context.XLSX.read(byteView, { type: "array" }),
  };
}

function assertUploadSheet(workbook, sheetName, expectedColumns, dataRowCount) {
  const XLSX = context.XLSX;
  const worksheet = workbook.Sheets[sheetName];
  assert.ok(worksheet, `Missing sheet: ${sheetName}`);
  const grid = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  const header = Array.from(grid[0] || []);
  assert.deepEqual(header, expectedColumns, `${sheetName} header changed`);
  assert.equal(grid.length - 1, dataRowCount, `${sheetName} row count changed`);
  const usedRange = XLSX.utils.decode_range(worksheet["!ref"]);
  assert.equal(usedRange.s.c, 0, `${sheetName} must start at column A`);
  assert.equal(
    usedRange.e.c,
    expectedColumns.length - 1,
    `${sheetName} used range has unexpected trailing columns`,
  );
  for (const banned of bannedHeaders) {
    assert.equal(
      header.includes(banned),
      false,
      `${sheetName} leaked internal header: ${banned}`,
    );
  }
}

function assertColumnWidths(workbook, sheetName, expectedColumnCount) {
  const worksheet = workbook.Sheets[sheetName];
  assert.ok(worksheet, `Missing original sheet: ${sheetName}`);
  assert.equal(
    worksheet["!cols"].length,
    expectedColumnCount,
    `${sheetName} column widths must match its schema`,
  );
}

const populatedResult = await buildAndReopen(purchaseInputs);
const populatedWorkbook = populatedResult.reopened;
assert.deepEqual(Array.from(populatedWorkbook.SheetNames), [
  "확인요청",
  "판매입력",
  "전송출고",
  "전송구매",
  "거래처별",
  "단가설정",
]);
assertUploadSheet(populatedWorkbook, "판매입력", salesColumns, 4);
assertUploadSheet(populatedWorkbook, "전송출고", outboundColumns, 4);
assertUploadSheet(populatedWorkbook, "전송구매", purchaseColumns, 4);
assertColumnWidths(populatedResult.original, "판매입력", salesColumns.length);
assertColumnWidths(populatedResult.original, "전송출고", outboundColumns.length);
assertColumnWidths(populatedResult.original, "전송구매", purchaseColumns.length);

const salesRows = readSheetRows(context.XLSX, populatedWorkbook, "판매입력");
const salesRowsByCode = Object.fromEntries(
  salesRows.map((row) => [row["품목코드"], row]),
);
for (const code of ["Q-BLANK", "Q-ZERO"]) {
  assert.equal(salesRowsByCode[code]["수량"], 0);
  assert.equal(typeof salesRowsByCode[code]["수량"], "number");
  assert.equal(salesRowsByCode[code]["단가"], 0);
  assert.equal(typeof salesRowsByCode[code]["단가"], "number");
  assert.equal(salesRowsByCode[code]["공급가액"], 0);
  assert.equal(typeof salesRowsByCode[code]["공급가액"], "number");
}
assert.equal(salesRowsByCode["Q-POSITIVE"]["수량"], 2);
assert.equal(salesRowsByCode["Q-POSITIVE"]["단가"], 4500);
assert.equal(salesRowsByCode["Q-POSITIVE"]["공급가액"], 9000);
assert.equal(salesRowsByCode["Q-NEGATIVE"]["수량"], -1);
assert.equal(salesRowsByCode["Q-NEGATIVE"]["단가"], 4500);
assert.equal(salesRowsByCode["Q-NEGATIVE"]["공급가액"], -4500);

const outboundRows = readSheetRows(
  context.XLSX,
  populatedWorkbook,
  "전송출고",
);
assert.ok(outboundRows.every((row) => row["거래처명"] === "1전송"));
assert.equal(
  outboundRows.find((row) => row["품목코드"] === "Q-BLANK")["수량"],
  0,
);

const purchaseRows = readSheetRows(
  context.XLSX,
  populatedWorkbook,
  "전송구매",
);
const purchaseRowsByCode = Object.fromEntries(
  purchaseRows.map((row) => [row["품목코드"], row]),
);
for (const code of ["Q-BLANK", "Q-ZERO"]) {
  assert.equal(purchaseRowsByCode[code]["수량"], 0);
  assert.equal(purchaseRowsByCode[code]["단가"], 0);
  assert.equal(purchaseRowsByCode[code]["공급가액"], 0);
}
assert.equal(purchaseRowsByCode["Q-POSITIVE"]["단가"], 4500);
assert.equal(purchaseRowsByCode["Q-POSITIVE"]["공급가액"], 9000);
assert.equal(purchaseRowsByCode["Q-NEGATIVE"]["단가"], 4500);
assert.equal(purchaseRowsByCode["Q-NEGATIVE"]["공급가액"], -4500);

for (const sheetName of ["거래처별", "확인요청", "단가설정"]) {
  assert.ok(
    populatedWorkbook.SheetNames.includes(sheetName),
    `Existing sheet disappeared: ${sheetName}`,
  );
}

const previewSheet = populatedWorkbook.Sheets["거래처별"];
const previewGrid = context.XLSX.utils.sheet_to_json(previewSheet, {
  header: 1,
  raw: true,
  blankrows: false,
});
const previewColumns = [
  "일자",
  "거래처명",
  "no.",
  "품목코드",
  "품명",
  "수량",
  "단가",
  "공급가",
  "적요",
  "출고지시",
  "출고가 (공지)",
  "구매처",
  "구매",
  "구매합계",
  "정리",
  "정산",
  "수수료",
];
assert.deepEqual(Array.from(previewGrid[0]), previewColumns);
assert.equal(previewGrid.length, 5);
assert.ok(
  ["Q-BLANK", "Q-ZERO", "Q-POSITIVE", "Q-NEGATIVE"].includes(
    previewGrid[1][3],
  ),
  "거래처별 첫 데이터 행은 2행이어야 합니다.",
);
assert.equal(previewSheet["!merges"], undefined);
const previewRows = readSheetRows(context.XLSX, populatedWorkbook, "거래처별");
const previewRowsByCode = Object.fromEntries(
  previewRows.map((row) => [row["품목코드"], row]),
);
for (const code of ["Q-BLANK", "Q-ZERO"]) {
  assert.equal(previewRowsByCode[code]["수량"], 0);
  assert.equal(previewRowsByCode[code]["단가"], 0);
  assert.equal(previewRowsByCode[code]["공급가"], 0);
  assert.equal(previewRowsByCode[code]["정리"], 0);
  assert.equal(previewRowsByCode[code]["정산"], 0);
  assert.equal(previewRowsByCode[code]["수수료"], 0);
}

const checkRows = readSheetRows(context.XLSX, populatedWorkbook, "확인요청");
assert.equal(
  checkRows.filter((row) =>
    String(row["확인사항"]).includes(
      "수량 없음/0: 수량 0, 판매가 0으로 업로드",
    ),
  ).length,
  2,
);
assert.equal(
  checkRows.some((row) => String(row["확인사항"]).includes("수량 형식 확인")),
  true,
);
assert.equal(
  checkRows.some(
    (row) =>
      String(row["확인사항"]).includes("수량 없음/0") &&
      (String(row["확인사항"]).includes("역마진") ||
        String(row["확인사항"]).includes("도매A과대")),
  ),
  false,
);

const emptyResult = await buildAndReopen([]);
const emptyWorkbook = emptyResult.reopened;
assert.deepEqual(Array.from(emptyWorkbook.SheetNames), [
  "확인요청",
  "판매입력",
  "전송출고",
  "전송구매",
  "거래처별",
  "단가설정",
]);
assertUploadSheet(emptyWorkbook, "판매입력", salesColumns, 0);
assertUploadSheet(emptyWorkbook, "전송출고", outboundColumns, 0);
assertUploadSheet(emptyWorkbook, "전송구매", purchaseColumns, 0);
assertColumnWidths(emptyResult.original, "판매입력", salesColumns.length);
assertColumnWidths(emptyResult.original, "전송출고", outboundColumns.length);
assertColumnWidths(emptyResult.original, "전송구매", purchaseColumns.length);

const emptyPreviewSheet = emptyWorkbook.Sheets["거래처별"];
const emptyPreviewGrid = context.XLSX.utils.sheet_to_json(emptyPreviewSheet, {
  header: 1,
  raw: true,
  blankrows: false,
});
assert.deepEqual(Array.from(emptyPreviewGrid[0]), previewColumns);
assert.equal(emptyPreviewGrid.length, 1);
assert.equal(emptyPreviewSheet["!merges"], undefined);

const expectedVersion = "V1.a22.102_StockPrintLayout";
assert.match(
  source,
  new RegExp(
    `<title>ONEAPP DataOps - 핵심 수불부 관리 \\(${expectedVersion}\\)</title>`,
  ),
);
assert.match(
  source,
  new RegExp(`loader-text">ONEAPP DataOps ${expectedVersion}\\.\\.\\.\\.\\.</div>`),
);
assert.match(
  source,
  new RegExp(`version:\\s*'${expectedVersion}'`),
);

console.log(
  "DataOps 판매업로드 시트별 열 계약과 실제 XLSX 재오픈 검증이 통과했습니다.",
);
