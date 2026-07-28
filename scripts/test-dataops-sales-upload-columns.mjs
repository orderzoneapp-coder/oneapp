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

let scenarioRows = [];
let capturedDownload = null;
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
  mappings: { transferPriceGroups: {} },
  defaultMappings: { transferPriceGroups: {} },
  validateTransferPriceGroupText: () => [],
  parseExcelData: async () => [],
  buildTransferSalesUploadRows: () => ({
    rows: scenarioRows.map((row) => ({ ...row })),
    fatalErrors: [],
    warnings: [],
  }),
  buildTransferPriceConfig: () => ({
    groups: {
      sample: {
        customer: "샘플거래처",
        groupName: "샘플그룹",
        rule: ["입고가"],
        feeMode: "NONE",
        profitMode: "NONE",
        outputCustomerMode: "GROUP_NAME",
      },
    },
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
});

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

const representativeRow = {
  일자: "2026-07-29",
  순번: 7,
  거래처코드: "C001",
  거래처명: "3우리",
  출하창고: "01",
  거래유형: "판매",
  전잔액: 0,
  전달사항: "전달",
  품목코드: "101020116",
  품목명: "대파_서울_10단",
  규격: "10단",
  수량: 2,
  단가: 4500,
  외화금액: 0,
  공급가액: 9000,
  적요: "정상",
  출고지시: "오전",
  공지: 5000,
  구매처: "우리농산",
  날짜: "2026-07-29",
  구매: 3200,
  생산전표생성: "Y",
  _적용그룹: "청과상장",
  _적용단가명: "입고가",
  _단가룰: "입고가",
  _확인필요: "N",
  _수익: 2600,
  _구매처보정전: "우리농산",
  _구매처보정: "우리농산",
};

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

async function buildAndReopen(rows) {
  scenarioRows = rows;
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

const populatedResult = await buildAndReopen([representativeRow]);
const populatedWorkbook = populatedResult.reopened;
assertUploadSheet(populatedWorkbook, "판매입력", salesColumns, 1);
assertUploadSheet(populatedWorkbook, "전송출고", outboundColumns, 1);
assertUploadSheet(populatedWorkbook, "전송구매", purchaseColumns, 1);
assertColumnWidths(populatedResult.original, "판매입력", salesColumns.length);
assertColumnWidths(populatedResult.original, "전송출고", outboundColumns.length);
assertColumnWidths(populatedResult.original, "전송구매", purchaseColumns.length);

const salesRows = readSheetRows(context.XLSX, populatedWorkbook, "판매입력");
assert.equal(salesRows[0]["거래처명"], representativeRow["거래처명"]);
assert.equal(salesRows[0]["품목코드"], representativeRow["품목코드"]);
assert.equal(salesRows[0]["수량"], representativeRow["수량"]);
assert.equal(salesRows[0]["단가"], representativeRow["단가"]);
assert.equal(salesRows[0]["공급가액"], representativeRow["공급가액"]);
assert.equal(salesRows[0]["구매"], representativeRow["구매"]);

const outboundRows = readSheetRows(
  context.XLSX,
  populatedWorkbook,
  "전송출고",
);
assert.equal(outboundRows[0]["거래처명"], "1전송");
assert.equal(outboundRows[0]["품목코드"], representativeRow["품목코드"]);
assert.equal(outboundRows[0]["수량"], representativeRow["수량"]);

const purchaseRows = readSheetRows(
  context.XLSX,
  populatedWorkbook,
  "전송구매",
);
assert.equal(purchaseRows[0]["거래처명"], "3우리");
assert.equal(purchaseRows[0]["품목코드"], representativeRow["품목코드"]);
assert.equal(purchaseRows[0]["수량"], representativeRow["수량"]);
assert.equal(purchaseRows[0]["단가"], representativeRow["단가"]);
assert.equal(purchaseRows[0]["공급가액"], representativeRow["공급가액"]);
assert.equal(purchaseRows[0]["구매처"], representativeRow["구매처"]);
assert.equal(purchaseRows[0]["날짜"], representativeRow["날짜"]);

for (const sheetName of ["거래처별", "확인요청", "단가설정"]) {
  assert.ok(
    populatedWorkbook.SheetNames.includes(sheetName),
    `Existing sheet disappeared: ${sheetName}`,
  );
}

const emptyResult = await buildAndReopen([]);
const emptyWorkbook = emptyResult.reopened;
assertUploadSheet(emptyWorkbook, "판매입력", salesColumns, 0);
assertUploadSheet(emptyWorkbook, "전송출고", outboundColumns, 0);
assertUploadSheet(emptyWorkbook, "전송구매", purchaseColumns, 0);
assertColumnWidths(emptyResult.original, "판매입력", salesColumns.length);
assertColumnWidths(emptyResult.original, "전송출고", outboundColumns.length);
assertColumnWidths(emptyResult.original, "전송구매", purchaseColumns.length);

const expectedVersion = "V1.a22.99_SalesUploadColumns";
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
