import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const moduleStart = html.indexOf("window.MERCH_PROMO_CATALOG_COMPARE_MODULE = (() => {");
const moduleEnd = html.indexOf("\nconst useMerchConfig = () => {", moduleStart);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "promo catalog comparison module was not found");

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

const context = vm.createContext({
  console,
  Date,
  Map,
  Set,
  Number,
  Object,
  String,
  Array,
  Math,
  JSON,
  Promise,
  Uint8Array,
  ArrayBuffer,
});
context.window = context;
context.self = context;
context.globalThis = context;
context.normalizeProductCodeText = (value) => String(value ?? "").trim().replace(/\s+/g, "");
context.normalizeMerchSaleAvailability = (value) => String(value ?? "").trim();
vm.runInContext(sheetJsSource.toString("utf8"), context, { filename: "xlsx.full.min.js" });
vm.runInContext(html.slice(moduleStart, moduleEnd), context, { filename: "MerchOps-promo-catalog-compare.js" });
const XLSX = context.XLSX;
const compare = context.MERCH_PROMO_CATALOG_COMPARE_MODULE;

const makeWorkbook = (sheets) => {
  const workbook = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
  });
  return workbook;
};
const reopen = (workbook) => XLSX.read(XLSX.write(workbook, { type: "array", bookType: "xlsx" }), { type: "array", cellDates: false });
const browserFixtureDir = process.env.MERCHOPS_PROMO_BROWSER_FIXTURE_DIR
  ? path.resolve(process.env.MERCHOPS_PROMO_BROWSER_FIXTURE_DIR)
  : "";
if (browserFixtureDir) {
  const allowedFixtureRoot = path.resolve(ROOT, ".tmp-merchops-promo-browser");
  assert.ok(browserFixtureDir.startsWith(allowedFixtureRoot), `refusing to write fixtures outside ${allowedFixtureRoot}`);
  fs.mkdirSync(browserFixtureDir, { recursive: true });
}

const catalogSourceWorkbook = makeWorkbook({
  다음카탈로그: [
    { 품목코드: "A001", 품목명: "사과", 규격: "1kg", 단위: "봉", "불러온 재고": 8, "LOT 구성": JSON.stringify([{ lotId: "L1", qty: 8, vendor: "V", price: 7000, warehouse: "W", unit: "봉" }]), "작업 출고가": 10000, "작업 행사가": 9000, 행사테마: "1", 판매여부: 1, 작업상태: "완료", "확정 여부": true, "관리자 완료 여부": true },
    { 품목코드: "B002", 품목명: "배", 규격: "2kg", 단위: "박스", "불러온 재고": "", "작업 출고가": 20000, "작업 행사가": "", 행사테마: "", 판매여부: 1, 작업상태: "보류", "확정 여부": false, "관리자 완료 여부": false },
  ],
});
const loadedSourceWorkbook = makeWorkbook({
  전체재고: [
    { 품목코드: "A001", 품목명: "사과", 규격: "1kg", 단위: "봉", 재고수량: 0 },
    { 품목코드: "B002", 품목명: "배", 규격: "2kg", 단위: "박스", 재고수량: "" },
  ],
  구매잔량: [{ 품목코드: "A001", LOT번호: "L1", 잔량: 0, 구매처: "V", 구매단가: 7000, 창고: "W", 단위: "봉" }],
  기타상품: [],
});
if (browserFixtureDir) {
  fs.writeFileSync(path.join(browserFixtureDir, "catalog.xlsx"), Buffer.from(new Uint8Array(XLSX.write(catalogSourceWorkbook, { type: "array", bookType: "xlsx" }))));
  fs.writeFileSync(path.join(browserFixtureDir, "loaded.xlsx"), Buffer.from(new Uint8Array(XLSX.write(loadedSourceWorkbook, { type: "array", bookType: "xlsx" }))));
}
const catalogWorkbook = reopen(catalogSourceWorkbook);
const loadedWorkbook = reopen(loadedSourceWorkbook);

const catalog = compare.parseWorkbook(catalogWorkbook, "catalog");
const loaded = compare.parseWorkbook(loadedWorkbook, "loaded");
assert.equal(catalog.byCode.A001.stock, 8);
assert.equal(loaded.byCode.A001.stock, 0);
assert.equal(loaded.byCode.B002.stock, "");

const masterProducts = {
  A001: { 코드: "A001", 품목명: "사과", 규격: "1kg", 단위: "봉", 출고가: 10000, 시중가: 12000, 행사가: 9000, 행사테마: "1", 판매여부: 1 },
  B002: { 코드: "B002", 품목명: "배", 규격: "2kg", 단위: "박스", 출고가: 20000, 시중가: 23000, 행사가: "", 행사테마: "", 판매여부: 1 },
};
let session = compare.createSession({
  masterSnapshot: compare.captureMasterSnapshot(masterProducts),
  previousCatalog: catalog,
  loadedRaw: loaded,
});
session = compare.updateDraft(session, "A001", "promoPrice", 0);
session = compare.setRowsStatus(session, ["A001"], compare.STATUS.DONE);
session = compare.setRowsStatus(session, ["B002"], compare.STATUS.HOLD);

const outputWorkbook = compare.createWorkbook(session, XLSX);
const outputBytes = XLSX.write(outputWorkbook, { type: "array", bookType: "xlsx" });
const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-merchops-promo-compare-"));
const outputPath = path.join(tempDir, "promo-catalog-compare.xlsx");
fs.writeFileSync(outputPath, Buffer.from(new Uint8Array(outputBytes)));

try {
  assert.ok(fs.statSync(outputPath).size > 1000, "generated XLSX file is unexpectedly small");
  const reopened = XLSX.read(fs.readFileSync(outputPath), { type: "buffer", cellDates: false });
  assert.deepEqual(Array.from(reopened.SheetNames), ["적용결과", "작업이력", "다음카탈로그"]);

  const apply = XLSX.utils.sheet_to_json(reopened.Sheets["적용결과"], { defval: null, raw: true });
  const history = XLSX.utils.sheet_to_json(reopened.Sheets["작업이력"], { defval: null, raw: true });
  const next = XLSX.utils.sheet_to_json(reopened.Sheets["다음카탈로그"], { defval: null, raw: true });

  assert.equal(apply.length, 1);
  assert.equal(apply[0].품목코드, "A001");
  assert.equal(apply[0]["확정 행사가"], 0, "numeric zero must survive XLSX generation and reopen");
  assert.equal(apply[0]["관리자 완료 여부"], true);
  assert.equal(history.some((row) => row.품목코드 === "A001" && row.필드 === "행사가" && row["변경 후 값"] === 0), true);
  assert.equal(next.length, 2, "hold rows must remain in the next catalog");
  assert.equal(next.find((row) => row.품목코드 === "B002").작업상태, "보류");
  assert.ok(
    [null, ""].includes(next.find((row) => row.품목코드 === "B002")["불러온 재고"]),
    "blank must reopen as blank, not zero",
  );
  assert.equal(next.find((row) => row.품목코드 === "A001")["관리자 완료 여부"], true);
  assert.match(next.find((row) => row.품목코드 === "A001")["작업값 출처"], /행사가:직접수정/);

  Object.values(reopened.Sheets).forEach((sheet) => {
    Object.entries(sheet).forEach(([address, cell]) => {
      if (address.startsWith("!")) return;
      assert.notEqual(cell?.t, "f", `formula cell is not allowed: ${address}`);
      assert.equal(typeof cell?.f, "undefined", `formula payload is not allowed: ${address}`);
    });
  });
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedTempPrefix = path.resolve(ROOT, ".tmp-merchops-promo-compare-");
  assert.ok(resolvedTempDir.startsWith(allowedTempPrefix), `refusing to remove unexpected temp directory: ${resolvedTempDir}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("MerchOps promotion catalog comparison generated and reopened real XLSX inputs and outputs successfully.");
