#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "export_center.html"), "utf8");
const scriptStart = html.indexOf("const { useState, useEffect, useMemo, useCallback } = React;");
const scriptEnd = html.indexOf("const ExportApp = () => {", scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "Export Center utility script was not found");
const utilitySource = html.slice(scriptStart, scriptEnd);

const sheetJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const expectedSheetJsSha256 = "c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99";
const response = await fetch(sheetJsUrl);
assert.equal(response.ok, true, `SheetJS download failed: ${response.status}`);
const sheetJsSource = Buffer.from(await response.arrayBuffer());
assert.equal(
  crypto.createHash("sha256").update(sheetJsSource).digest("hex"),
  expectedSheetJsSha256,
  "SheetJS asset hash changed",
);

const memoryStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const context = vm.createContext({
  console,
  Date,
  Math,
  Set,
  Map,
  Array,
  Object,
  Number,
  String,
  Boolean,
  RegExp,
  JSON,
  Promise,
  Error,
  URL,
  Uint8Array,
  ArrayBuffer,
  Intl,
  setTimeout,
  clearTimeout,
  localStorage: memoryStorage,
  sessionStorage: memoryStorage,
  document: { referrer: "" },
  React: { useState() {}, useEffect() {}, useMemo() {}, useCallback() {} },
});
context.window = context;
context.self = context;
context.globalThis = context;
context.location = { protocol: "https:", origin: "https://example.test", href: "https://example.test/export_center.html" };
vm.runInContext(sheetJsSource.toString("utf8"), context, { filename: "xlsx.full.min.js" });
vm.runInContext(utilitySource, context, { filename: "export_center-utilities.js" });
assert.equal(typeof context.buildMerchIntegratedUploadWorkbook, "function", "production workbook builder must be exposed for regression verification");

const workingState = (field, value, options = {}) => ({
  value,
  origin: options.origin || "source",
  isWorkingValue: options.isWorkingValue ?? true,
  isExplicitBlank: options.isExplicitBlank ?? (value === undefined || value === null || String(value).trim() === ""),
  field,
  sourceRole: options.sourceRole || "estimate",
});
const withStates = (code, values, optionsByField = {}) => ({
  코드: code,
  ...values,
  _fieldStates: Object.fromEntries(Object.entries(values).map(([field, value]) => [field, workingState(field, value, optionsByField[field] || {})])),
});

const zeroRow = withStates("ZERO", {
  품목명: "0 보존 상품",
  규격: "1개",
  브랜드: "브랜드",
  간단설명: "설명",
  검색어등록: "태그",
  입고가: 10000,
  출고가: 12000,
  행사가: 0,
  입고B: "0",
  도매A: 0,
  도매B: 0,
  B판매가: 0,
  B도매가: 0,
  시중가: 0,
  최종전송: 0,
  판매여부: false,
  재고수량: "0",
});

const blankValues = Object.fromEntries(Object.keys(zeroRow._fieldStates).map((field) => [field, ""]));
const blankRow = withStates("BLANK", blankValues);

const referenceValues = {
  품목명: "MASTER NAME",
  규격: "MASTER SPEC",
  브랜드: "MASTER BRAND",
  간단설명: "MASTER DESC",
  검색어등록: "MASTER TAG",
  입고가: 777,
  출고가: 888,
  행사가: 999,
  입고B: 777,
  도매A: 777,
  도매B: 777,
  B판매가: 777,
  B도매가: 777,
  시중가: 777,
  최종전송: 777,
  판매여부: true,
  재고수량: 777,
};
const referenceRow = withStates("REFERENCE", referenceValues,
  Object.fromEntries(Object.keys(referenceValues).map((field) => [field, { origin: "master-reference", isWorkingValue: false, isExplicitBlank: false }])));
referenceRow._masterReference = { ...referenceValues };
referenceRow.기준입고가 = 777;
referenceRow.기준출고가 = 888;

const { wb, erpData, shopData } = context.buildMerchIntegratedUploadWorkbook([zeroRow, blankRow, referenceRow], {
  REFERENCE: { ...referenceValues },
});

assert.equal(erpData[1][5], 0, "string zero inbound-B must remain numeric zero in ERP assembly");
assert.equal(erpData[1][7], 0, "explicit zero wholesale-A must remain zero in ERP assembly");
assert.equal(erpData[1][9], 0, "explicit zero wholesale-B must remain zero in ERP assembly");
assert.equal(erpData[1][11], 0, "explicit zero final-transmission must remain zero in ERP assembly");
assert.equal(erpData[1][13], 0, "explicit zero promotion price must remain zero in ERP assembly");
assert.equal(erpData[1][15], "0", "explicit false sale state must remain stopped");
assert.equal(shopData[1][3], 12000, "zero promotion price must not replace the explicit output price");
assert.equal(shopData[1][4], 0, "explicit zero wholesale-A must not be regenerated from output price");
assert.equal(shopData[1][5], 0, "explicit zero market price must not be regenerated from output price");
assert.equal(shopData[1][6], 0);
assert.equal(shopData[1][7], 0);
assert.equal(shopData[1][14], "0");
assert.equal(shopData[1][15], 0, "string zero stock must remain zero");

for (const index of [1, 3, 5, 7, 9, 11, 13, 15]) assert.equal(erpData[2][index], "", `explicit blank ERP field ${index} must remain blank`);
for (const index of [1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 21]) assert.equal(shopData[2][index], "", `explicit blank shop field ${index} must remain blank`);
for (const index of [1, 3, 5, 7, 9, 11, 13, 15]) assert.equal(erpData[3][index], "", `master-reference ERP field ${index} must not enter actual output`);
for (const index of [1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 21]) assert.equal(shopData[3][index], "", `master-reference shop field ${index} must not enter actual output`);

const bytes = context.XLSX.write(wb, { type: "array", bookType: "xlsx" });
const reopened = context.XLSX.read(Buffer.from(new Uint8Array(bytes)), { type: "buffer" });
const reopenedErp = context.XLSX.utils.sheet_to_json(reopened.Sheets.ERP업데이트, { header: 1, raw: true, defval: "" });
const reopenedShop = context.XLSX.utils.sheet_to_json(reopened.Sheets.쇼핑몰업로드, { header: 1, raw: true, defval: "" });
assert.equal(reopenedErp[1][5], 0);
assert.equal(reopenedErp[1][7], 0);
assert.equal(reopenedErp[1][9], 0);
assert.equal(reopenedErp[1][11], 0);
assert.equal(reopenedErp[1][13], 0);
assert.equal(reopenedShop[1][4], 0);
assert.equal(reopenedShop[1][5], 0);
assert.equal(reopenedShop[1][6], 0);
assert.equal(reopenedShop[1][7], 0);
assert.equal(reopenedShop[1][15], 0);
for (const rowIndex of [2, 3]) {
  for (const index of [1, 3, 5, 7, 9, 11, 13, 15]) assert.equal(reopenedErp[rowIndex][index], "");
  for (const index of [1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 21]) assert.equal(reopenedShop[rowIndex][index], "");
}

console.log("Export Center working-state XLSX assembly preserves zero/false/blanks and rejects baseline/master-reference fallback.");
