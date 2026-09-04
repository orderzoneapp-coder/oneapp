import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const moduleStart = html.indexOf("window.MERCH_PROMO_CATALOG_COMPARE_MODULE = (() => {");
const moduleEnd = html.indexOf("\nconst useMerchConfig = () => {", moduleStart);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "promo catalog comparison module was not found");
const moduleSource = html.slice(moduleStart, moduleEnd);

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
  FileReader: class {},
});
context.window = context;
context.normalizeProductCodeText = (value) => String(value ?? "").trim().replace(/\s+/g, "");
context.normalizeMerchSaleAvailability = (value) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "정지"].includes(text)) return "0";
  if (["1", "true", "판매"].includes(text)) return "1";
  return value;
};
context.XLSX = {
  utils: {
    sheet_to_json: (sheet) => sheet.rows,
  },
};
vm.runInContext(moduleSource, context, { filename: "MerchOps-promo-catalog-compare.js" });
const compare = context.MERCH_PROMO_CATALOG_COMPARE_MODULE;
const plain = (value) => JSON.parse(JSON.stringify(value));

const masterProducts = {
  A001: { 코드: "A001", 품목명: "사과", 규격: "1kg", 단위: "봉", 입고가: 7000, 출고가: 10000, 시중가: 12000, 행사가: 9000, 행사테마: "1", 판매여부: 1 },
  B002: { 코드: "B002", 품목명: "배", 규격: "2kg", 단위: "박스", 입고가: 15000, 출고가: 20000, 시중가: 23000, 행사가: "", 행사테마: "", 판매여부: 1 },
  C003: { 코드: "C003", 품목명: "감", 규격: "1kg", 단위: "봉", 입고가: 6000, 출고가: 8000, 시중가: 9000, 행사가: "", 행사테마: "", 판매여부: 1 },
};
const master = compare.captureMasterSnapshot(masterProducts);
const catalogRows = [
  { 품목코드: "A001", 품목명: "사과", 재고: 8, 구매단가: 7000, "작업 출고가": 10000, "작업 행사가": 9000, 행사테마: "1", 판매여부: 1, 작업상태: "완료", "확정 여부": true, "관리자 완료 여부": true, "LOT 구성": JSON.stringify([{ lotId: "L1", qty: 8, vendor: "V", price: 7000, warehouse: "W", unit: "봉", 입고일: "2026-01-01" }]) },
  { 품목코드: "B002", 품목명: "배", 재고: "", 구매단가: 15000, "작업 출고가": 20000, "작업 행사가": "", 행사테마: "", 판매여부: 1, 작업상태: "미처리", "확정 여부": false, "관리자 완료 여부": false },
];
const loadedRows = [
  { 품목코드: "A001", 품목명: "사과", 재고: 0, 구매단가: 7200, LOT번호: "L1", LOT수량: 0, 구매처: "V", 창고: "W", 단위: "봉", 입고일: "2026-07-30" },
  { 품목코드: "C003", 품목명: "감", 재고: 4, 구매단가: 6100, LOT번호: "L2", LOT수량: 4, 구매처: "V", 창고: "W", 단위: "봉" },
];
const catalog = compare.buildArea(catalogRows, "catalog");
const loaded = compare.buildArea(loadedRows, "loaded");

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

test("load order produces the same comparison", () => {
  const base = compare.createSession({ masterSnapshot: master });
  const a = compare.replaceSource(compare.replaceSource(base, "catalog", catalog).session, "loaded", loaded).session;
  const b = compare.replaceSource(compare.replaceSource(base, "loaded", loaded).session, "catalog", catalog).session;
  const project = (session) => session.rows.map((row) => [row.key, row.code, row.status, row.purposes, row.issues, row.draft]);
  assert.deepEqual(plain(project(a)), plain(project(b)));
});

const session = compare.createSession({ masterSnapshot: master, previousCatalog: catalog, loadedRaw: loaded });

test("product union keeps master, catalog, and loaded codes", () => {
  assert.deepEqual(plain(session.rows.filter((row) => !row.unmatched).map((row) => row.code)), ["A001", "B002", "C003"]);
});

test("unique normalized product codes match automatically", () => {
  const row = session.rows.find((item) => item.code === "A001");
  assert.ok(row.master && row.catalog && row.loaded);
});

test("blank and duplicate codes remain unmatched without preserving prior work", () => {
  let edited = compare.updateDraft(session, "A001", "promoPrice", 7777);
  const duplicated = compare.buildArea([
    { 품목코드: "A001", 재고: 1 },
    { 품목코드: "A001", 재고: 2 },
    { 품목코드: "", 재고: 3 },
  ], "loaded");
  edited = compare.replaceSource(edited, "loaded", duplicated).session;
  const masterRow = edited.rows.find((row) => row.key === "A001");
  assert.equal(masterRow.blocked, true);
  assert.equal(masterRow.status, compare.STATUS.REVIEW);
  assert.equal(masterRow.draft.promoPrice, 9000, "duplicate code must not preserve the edited work value");
  assert.equal(edited.rows.filter((row) => row.unmatched).length, 3);
});

test("LOT matching ignores date fields", () => {
  const lots = compare.compareLots(
    [{ vendor: "V", price: 10, warehouse: "W", unit: "EA", qty: 2, 구매일: "2020-01-01" }],
    [{ vendor: "V", price: 10, warehouse: "W", unit: "EA", qty: 2, 구매일: "2030-12-31" }],
    "A001",
  );
  assert.equal(lots.retained.length, 1);
  const lotKeyBlock = moduleSource.slice(moduleSource.indexOf("const lotKey"), moduleSource.indexOf("const groupedLots"));
  assert.doesNotMatch(lotKeyBlock, /일자|날짜|Date|date/);
});

test("zero, blank, missing sources, and unmatched rows stay distinct", () => {
  assert.equal(compare.sameValue(0, ""), false);
  assert.equal(compare.display(0), "0");
  assert.equal(compare.display(""), "—");
  assert.match(html, /카탈로그 없음/);
  assert.match(html, /오늘 정보 없음/);
  assert.match(html, /미매칭/);
});

test("equal comparison values use one centered line at fixed height", () => {
  const block = html.slice(html.indexOf("const CompareCell"), html.indexOf("const WorkInput"));
  assert.match(block, /h-\[58px\] min-h-\[58px\]/);
  assert.match(block, /equal[\s\S]*text-center/);
});

test("different comparison values render old above new", () => {
  const block = html.slice(html.indexOf("const CompareCell"), html.indexOf("const WorkInput"));
  assert.ok(block.indexOf("beforeText") < block.indexOf("afterText"));
  assert.match(block, /React\.Fragment/);
});

test("comparison cells do not render arrows, deltas, or badges", () => {
  const block = html.slice(html.indexOf("const CompareCell"), html.indexOf("const WorkInput"));
  assert.doesNotMatch(block, /→|➡|차액|badge|rounded-full/);
});

test("purpose filters allow one row in multiple purposes", () => {
  const row = session.rows.find((item) => item.code === "A001");
  assert.ok(row.purposes.includes("기존행사"));
  assert.ok(row.purposes.includes("행사종료"));
  assert.ok(row.purposes.includes("가격변동"));
});

test("other-review is the complement of the main purpose groups", () => {
  session.rows.forEach((row) => {
    const main = row.purposes.some((purpose) => ["기존행사", "행사종료", "가격변동", "신규입고"].includes(purpose));
    assert.equal(row.purposes.includes("기타검토"), !main);
  });
});

test("filtering never mutates work values", () => {
  const before = JSON.stringify(session.rows.map((row) => row.draft));
  compare.filterRows(session, "가격변동", "전체");
  compare.purposeCounts(session);
  assert.equal(JSON.stringify(session.rows.map((row) => row.draft)), before);
});

test("promotion-end candidate does not automatically clear promotion price", () => {
  const row = session.rows.find((item) => item.code === "A001");
  assert.ok(row.issues.includes("행사 종료 검토"));
  assert.equal(row.draft.promoPrice, 9000);
  assert.equal(row.draft.actions.promoPrice, "KEEP");
});

test("reloading replaces only the selected source area", () => {
  const replacement = compare.buildArea([{ 품목코드: "A001", 재고: 5 }], "loaded");
  const replaced = compare.replaceSource(session, "loaded", replacement).session;
  assert.equal(replaced.previousCatalog.total, catalog.total);
  assert.equal(replaced.loadedRaw.total, 1);
});

test("unique-code work values survive source reload", () => {
  const edited = compare.updateDraft(session, "A001", "promoPrice", 7777);
  const replacement = compare.buildArea([{ 품목코드: "A001", 재고: 5, 구매단가: 7300 }], "loaded");
  const replaced = compare.replaceSource(edited, "loaded", replacement).session;
  assert.equal(replaced.rows.find((row) => row.code === "A001").draft.promoPrice, 7777);
});

test("disappearing products preserve work values and become hold", () => {
  const edited = compare.updateDraft(session, "A001", "promoPrice", 7777);
  const replacement = compare.buildArea([{ 품목코드: "C003", 재고: 5 }], "loaded");
  const replaced = compare.replaceSource(edited, "loaded", replacement).session;
  const row = replaced.rows.find((item) => item.code === "A001");
  assert.equal(row.draft.promoPrice, 7777);
  assert.equal(row.status, compare.STATUS.HOLD);
});

test("direct edits are not overwritten by master refresh", () => {
  let edited = compare.updateDraft(session, "A001", "outPrice", 12345);
  edited = compare.refreshMaster(edited, { ...masterProducts, A001: { ...masterProducts.A001, 출고가: 15000 } });
  assert.equal(edited.rows.find((row) => row.code === "A001").draft.outPrice, 12345);
});

test("source or master changes move completed rows back to review", () => {
  let done = compare.setRowsStatus(session, ["A001"], compare.STATUS.DONE);
  const sourceChanged = compare.replaceSource(done, "loaded", compare.buildArea([{ 품목코드: "A001", 재고: 1, 구매단가: 7300 }], "loaded")).session;
  assert.equal(sourceChanged.rows.find((row) => row.code === "A001").status, compare.STATUS.REVIEW);
  done = compare.setRowsStatus(session, ["A001"], compare.STATUS.DONE);
  const masterChanged = compare.refreshMaster(done, { ...masterProducts, A001: { ...masterProducts.A001, 시중가: 13000 } });
  assert.equal(masterChanged.rows.find((row) => row.code === "A001").status, compare.STATUS.REVIEW);
});

test("only completed, confirmed, registered rows enter apply results", () => {
  let mixed = compare.setRowsStatus(session, ["A001"], compare.STATUS.DONE);
  mixed = compare.setRowsStatus(mixed, ["B002"], compare.STATUS.HOLD);
  const outputs = compare.buildOutputRows(mixed);
  assert.deepEqual(plain(outputs.apply.map((row) => row.품목코드)), ["A001"]);
  assert.deepEqual(plain(compare.getEligibleRows(mixed).map((row) => row.code)), ["A001"]);
  const unregistered = compare.createSession({
    masterSnapshot: master,
    loadedRaw: compare.buildArea([{ 품목코드: "Z999", 재고: 1 }], "loaded"),
  });
  const attempted = compare.setRowsStatus(unregistered, ["Z999"], compare.STATUS.DONE);
  assert.equal(attempted.rows.find((row) => row.code === "Z999").status, compare.STATUS.REVIEW);
});

test("unfinished catalog values are reference-only and never inherited", () => {
  const row = session.rows.find((item) => item.code === "B002");
  assert.equal(row.draft.outPrice, 20000);
  assert.equal(row.draft.sources.outPrice, "마스터");
});

test("next catalog preserves every row and its status", () => {
  const outputs = compare.buildOutputRows(session);
  assert.equal(outputs.next.length, session.rows.length);
  assert.deepEqual(plain(outputs.next.map((row) => row.작업상태)), plain(session.rows.map((row) => row.status)));
});

test("promotion price and theme remain independent", () => {
  let edited = compare.updateDraft(session, "A001", "promoPrice", "");
  const row = edited.rows.find((item) => item.code === "A001");
  assert.equal(row.draft.actions.promoPrice, "CLEAR");
  assert.equal(row.draft.theme, "1");
  assert.ok(row.issues.includes("행사가 없이 테마만 존재"));
});

test("blank values are never converted to numeric zero", () => {
  const normalized = compare.normalizeInputRow({ 품목코드: "A001", 재고: "", 구매단가: "", 행사가: "" }, "loaded", 0);
  assert.equal(normalized.stock, "");
  assert.equal(normalized.purchasePrice, "");
  assert.equal(normalized.workPromoPrice, "");
});

test("DataOps total stock and LOT evidence are parsed without double counting", () => {
  const workbook = {
    SheetNames: ["전체재고", "구매잔량", "기타상품"],
    Sheets: {
      전체재고: { rows: [{ 품목코드: "A001", 재고수량: 10 }] },
      구매잔량: { rows: [{ 품목코드: "A001", 잔량: 4, 구매처: "V1", 구매단가: 100 }] },
      기타상품: { rows: [{ 품목코드: "A001", 잔량: 6, 구매처: "V2", 구매단가: 200 }] },
    },
  };
  const area = compare.parseWorkbook(workbook, "loaded");
  assert.equal(area.byCode.A001.stock, 10);
  assert.equal(area.byCode.A001.lots.length, 2);
});

assert.equal(passed, 24, "all 24 dedicated scenarios must execute");

const ready = compare.setRowsStatus(session, ["A001"], compare.STATUS.DONE);
assert.equal(compare.getApplyReadiness(ready, masterProducts).ready, true);
assert.equal(compare.getApplyReadiness(ready, { ...masterProducts, A001: { ...masterProducts.A001, 출고가: 15000 } }).ready, false);
assert.equal(compare.getApplyReadiness(ready, { B002: masterProducts.B002, C003: masterProducts.C003 }).ready, false);

const versions = [...html.matchAll(/v2\.1\.195_ProductRegistration/g)].length;
assert.ok(versions >= 2, "all visible MerchOps version labels must use the target version");
assert.match(html, /handleOpenPromoCompare/);
assert.match(html, /handleApplyPromoCompare/);
assert.match(html, /handleQuickExcelExport/);
assert.match(html, /handleOpenExportCenter/);

console.log(`MerchOps promotion catalog comparison tests passed (${passed} dedicated scenarios).`);
