import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const F8_START = "    const handleQuickExcelExport = useCallback(() => {";
const F8_END = "    // [M-MASTER-COMMIT-01] F7 마스터 적용";
const start = html.indexOf(F8_START);
const end = html.indexOf(F8_END, start);
assert.ok(start >= 0 && end > start, "Quick F8 implementation was not found");

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

const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-merchops-f8-"));
let writtenFile = "";
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
vm.runInContext(sheetJsSource.toString("utf8"), context, { filename: "xlsx.full.min.js" });
assert.ok(context.XLSX?.utils, "SheetJS did not initialize");

const realXlsx = context.XLSX;
realXlsx.writeFile = (workbook, filename, options = {}) => {
  writtenFile = path.join(tempDir, path.basename(filename));
  const bookType = options.bookType || "xlsx";
  const array = realXlsx.write(workbook, { ...options, bookType, type: "array" });
  fs.writeFileSync(writtenFile, Buffer.from(new Uint8Array(array)));
};

const row = {
  코드: "20010001",
  _lastUploadRole: "estimate",
  sources: {
    _activeRole: "estimate",
    estimate: {
      품목코드: "20010001",
      품목명: "F8 회귀상품",
      규격: "1kg",
      입고가: 10000,
      출고가: 13000,
      행사가: 12000,
      도매A: 11500,
      판매여부: 1,
      재고수량: 0,
      테마1: 1,
      상품태그: "회귀검증",
    },
  },
  finalData: {},
};

Object.assign(context, {
  useCallback: (fn) => fn,
  fullDisplayRows: [row],
  quickExcelReadyRef: { current: { ready: false, at: 0, count: 0, codes: [], rows: [] } },
  collectWholesaleBelowCostWarnings: () => [],
  data: { masterProducts: {} },
  ui: {
    filterSteps: [],
    disabledFilterStepIds: [],
    selectedRows: new Set(),
    showToast: () => {},
  },
});

Object.assign(context.window, {
  XLSX: realXlsx,
  confirm: () => true,
  normalizeProductCodeText: (value) => String(value ?? "").replace(/\s/g, ""),
  getCurrentMerchSourceRole: (sources = {}, fallback = "") =>
    String(sources._activeRole || fallback || (sources.estimate ? "estimate" : "")),
  hasMerchSourceObjectData: (value) =>
    !!(value && typeof value === "object" && Object.keys(value).some((key) => !key.startsWith("_"))),
  hasOwnField: (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key),
  isBlankCell: (value) => value === undefined || value === null || String(value).trim() === "",
  parseNum: (value) => {
    const parsed = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  },
  getWorkingSourcePriority: (sources = {}) =>
    ["estimate", "purchase", "sales", "inventory", "info", "catalog", "parser"].filter((key) => sources[key]),
  getMerchExplicitSaleAvailability: () => ({ hasValue: true, code: "1" }),
  getMerchLocalDateStamp: () => "2026-07-26",
});

const f8Declaration = html.slice(start, end);
vm.runInContext(`${f8Declaration}\nglobalThis.__runQuickF8 = handleQuickExcelExport;`, context, {
  filename: "MerchOps-F8.js",
});
context.__runQuickF8();

try {
  assert.ok(writtenFile && fs.existsSync(writtenFile), "F8 did not write an XLSX file");
  assert.ok(fs.statSync(writtenFile).size > 1000, "generated XLSX file is unexpectedly small");

  const reopened = realXlsx.read(fs.readFileSync(writtenFile), { type: "buffer" });
  assert.deepEqual(
    Array.from(reopened.SheetNames),
    ["쇼핑몰업로드", "ERP업데이트"],
    "F8 workbook sheet names changed",
  );

  const shopRows = realXlsx.utils.sheet_to_json(reopened.Sheets["쇼핑몰업로드"], { header: 1, raw: true });
  const erpRows = realXlsx.utils.sheet_to_json(reopened.Sheets["ERP업데이트"], { header: 1, raw: true });
  assert.equal(shopRows[1][0], "20010001");
  assert.equal(shopRows[1][1], "F8 회귀상품");
  assert.equal(shopRows[1][3], 12000, "promotion price must be the shop sale price");
  assert.equal(shopRows[1][14], "1", "explicit sale availability must survive XLSX generation");
  assert.equal(shopRows[1][15], 0, "explicit zero stock must survive XLSX generation");
  assert.equal(shopRows[1][16], "1", "theme flag must survive XLSX generation");
  assert.equal(erpRows[1][0], "20010001");
  assert.equal(erpRows[1][1], 10000);
  assert.equal(erpRows[1][3], 13000);
  assert.equal(erpRows[1][15], "1");
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedTempPrefix = path.resolve(ROOT, ".tmp-merchops-f8-");
  assert.ok(
    resolvedTempDir.startsWith(allowedTempPrefix),
    `refusing to remove unexpected temp directory: ${resolvedTempDir}`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("MerchOps Quick F8 generated and reopened a real XLSX workbook successfully.");
