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

const stockCountSource = section(
  "buildStockCountSheetRows:",
  "buildSalesDetailRows:",
);
assert.match(
  stockCountSource,
  /const stockCountDate\s*=\s*targetDateStr\s*;/,
  "실사양식 날짜는 DataOps 마감 기준일을 그대로 사용해야 합니다.",
);
assert.doesNotMatch(
  stockCountSource,
  /addOneDay\s*\(/,
  "실사양식 날짜에 다음날 계산을 적용하면 안 됩니다.",
);
const combinedWorkbookSource = section(
  "createCombinedWorkbook:",
  "const STORAGE_MODULE",
);
assert.match(
  combinedWorkbookSource,
  /const exportFileNameDate\s*=\s*targetDateStr\s*\?\s*targetDateStr\.replace\(\/-\/g,\s*''\)/,
  "수불마감 파일명 날짜도 DataOps 마감 기준일을 사용해야 합니다.",
);

const stockCountDeclaration = stockCountSource
  .replace(
    /^buildStockCountSheetRows:/,
    "const buildStockCountSheetRows =",
  )
  .replace(/,\s*$/, ";");
const rowContext = vm.createContext({
  safeNum: (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  safeStr: (value, fallback = "") => {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value).trim() || fallback;
  },
  STOCK_ENGINE_MODULE: {
    getActualQty: (item) => Number(item.actualQty) || 0,
  },
});
new vm.Script(
  `${stockCountDeclaration}\nglobalThis.buildStockCountSheetRows = buildStockCountSheetRows;`,
  { filename: "DataOps.stock-count-date.js" },
).runInContext(rowContext);

const productData = [
  { 코드: "101020116", 품명: "대파_서울_10단", actualQty: 1 },
  { 코드: "101020117", 품명: "검증상품", actualQty: 2 },
  { 코드: "101020118", 품명: "0재고 제외상품", actualQty: 0 },
];
const closingDates = ["2026-07-28", "2026-07-31", "2026-12-31"];

const sheetJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
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

const xlsxContext = vm.createContext({
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
});
xlsxContext.window = xlsxContext;
xlsxContext.self = xlsxContext;
xlsxContext.globalThis = xlsxContext;
vm.runInContext(sheetJsSource.toString("utf8"), xlsxContext, {
  filename: "xlsx.full.min.js",
});
const XLSX = xlsxContext.XLSX;
assert.ok(XLSX?.utils, "SheetJS did not initialize");

for (const targetDateStr of closingDates) {
  const rows = rowContext.buildStockCountSheetRows({
    productData,
    targetDateStr,
  });
  assert.equal(rows.length, 2, "기존 실사양식의 0재고 제외 정책이 바뀌면 안 됩니다.");
  assert.ok(
    Array.from(rows).every((row) => row["일자"] === targetDateStr),
    `모든 실사양식 행의 일자는 ${targetDateStr}이어야 합니다.`,
  );

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(Array.from(rows, (row) => ({ ...row }))),
    "실사양식",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["검증값", "수량", "원가", "Lot"],
      ["다른 시트 불변", 3, 1200, "LOT-01"],
    ]),
    "다른시트",
  );

  const xlsxBytes = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
  });
  assert.ok(xlsxBytes.byteLength > 1000, "생성된 XLSX가 비정상적으로 작습니다.");
  const xlsxByteView = new Uint8Array(xlsxBytes);
  assert.equal(String.fromCharCode(xlsxByteView[0], xlsxByteView[1]), "PK");

  const reopened = XLSX.read(xlsxByteView, { type: "array" });
  const reopenedRows = XLSX.utils.sheet_to_json(reopened.Sheets["실사양식"], {
    raw: true,
  });
  assert.ok(
    Array.from(reopenedRows).every((row) => row["일자"] === targetDateStr),
    `재오픈한 실사양식의 일자는 ${targetDateStr}이어야 합니다.`,
  );
  const otherSheetRows = XLSX.utils.sheet_to_json(
    reopened.Sheets["다른시트"],
    { header: 1, raw: true },
  );
  assert.deepEqual(
    Array.from(otherSheetRows, (row) => Array.from(row)),
    [
      ["검증값", "수량", "원가", "Lot"],
      ["다른 시트 불변", 3, 1200, "LOT-01"],
    ],
  );

  const exportFileNameDate = targetDateStr.replace(/-/g, "");
  assert.equal(
    `수불마감_${exportFileNameDate}.xlsx`,
    `수불마감_${targetDateStr.replace(/-/g, "")}.xlsx`,
  );
}

console.log(
  "DataOps 실사양식 마감일 계약과 실제 XLSX 재오픈 검증이 통과했습니다.",
);
