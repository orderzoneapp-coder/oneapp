import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const engine = require("../orderFulfillmentEngine.js");
const preparation = require("../orderops/excel-preparation.js");
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixtures = [
  [["단위", "품목코드", "품명", "규격", "재고", "기록", "구매가"], ["EA", "001", "소분상품", "EA", -1.5, "기록", 350], ["BOX", "002", "박스상품", "BOX", 0, "", 1200]],
  [["품목코드", "품목명", "규격", "재고", "입고", "출고", "잔량", "잔량", "입고가"], ["001", "상품", "EA", 3, 2, 7.5, -2.5, -2.5, 100], ["002", "상품2", "BOX", 0, 0, 0, 0, 0, 0]],
];
for (const [index, matrix] of fixtures.entries()) {
  const parsed = engine.parseInventoryWorkbook({ fileName: index ? "재고변동표.xlsx" : "전일재고현황.xlsx", sheetName: "자료", rawMatrix: matrix, displayMatrix: clone(matrix) });
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  const draft = preparation.createDraft({ kind: "inventory", sheetName: "자료", rawMatrix: matrix, displayMatrix: clone(matrix), parsed });
  assert.equal(preparation.validateDraft({ draft, rawMatrix: matrix, displayMatrix: matrix }).ok, true);
  const applied = preparation.applyDraft({ draft, rawMatrix: matrix, displayMatrix: matrix });
  assert.equal(applied.ok, true);
  const reparsed = engine.parseInventoryWorkbook({ fileName: parsed.fileName, sheetName: "자료", ...applied, columnMappings: applied.columns });
  assert.equal(reparsed.inventoryLayout, parsed.inventoryLayout);
  assert.deepEqual(reparsed.rows.map((row) => [row.productCode, row.openingQuantity, row.inboundQuantity, row.salesQuantity, row.inventoryTotal]), parsed.rows.map((row) => [row.productCode, row.openingQuantity, row.inboundQuantity, row.salesQuantity, row.inventoryTotal]));
  assert.deepEqual(applied.originalRawMatrix, matrix);
  if (index) assert.equal(applied.displayMatrix[0].filter((header) => header === "잔량").length, 2, "same-name balance evidence is preserved");
  console.log(`PASS ${parsed.inventoryLayout}: native classification and column-mapping reapply retain signed values, zero and source evidence`);
}
function extractFunction(html, name) {
  const match = new RegExp(`      (?:async )?function ${name}\\(`).exec(html);
  assert.ok(match, name);
  const rest = html.slice(match.index + match[0].length);
  const end = /\r?\n      }\r?\n/.exec(rest);
  return html.slice(match.index, match.index + match[0].length + end.index + end[0].length);
}
for (const path of ["../orderops/list.html", "../orderops_list.html"]) {
  const html = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) if (match[1].trim()) new vm.Script(match[1]);
  const env = vm.createContext({});
  vm.runInContext(extractFunction(html, "integratedCandidateScore") + ";globalThis.score=integratedCandidateScore", env);
  assert.ok(env.score("inventory", { rowCount: 2, errors: [], missingColumns: [], columns: [], inventoryLayout: "snapshot" }) > 0);
  assert.ok(env.score("inventory", { rowCount: 2, errors: [], missingColumns: [], columns: [], inventoryLayout: "movement" }) > 0);
  assert.equal(env.score("inventory", { rowCount: 2, errors: [{ message: "invalid" }], columns: [], inventoryLayout: "movement" }), 0);
  assert.match(html, /data-preview="movement"/);
  assert.match(html, /id="movementDownloadButton"/);
  assert.match(html, /data-movement-row=/);
  assert.match(html, /engine\.analyzeInventory\(inventory/);
  console.log(`PASS ${path}: script syntax, inventory structure classification and movement UI entry points`);
  const purchaseMatrix = [["일자", "창고코드", "코드", "품명", "규격", "수량", "구매처"], ["2026/09/19", "02", "001", "상품", "EA", 2, "공급처"]];
  const salesMatrix = [["일자", "품목코드", "품명", "수량", "거래처명", "구매처"], ["2026/09/19", "001", "상품", 2, "고객", "공급처"], ["2026/09 계", 2, "", 90000, "", ""]];
  const inputEnv = vm.createContext({ engine, state: {}, FILE_KIND_LABELS: { purchases: "구매", sales: "판매", orders: "주문", inventory: "재고" }, MAX_FILE_SIZE: 1000000, isSupportedFile: () => true });
  const constantStart = html.indexOf("      const DEFAULT_EXCEL_MAPPINGS =");
  const constantEnd = html.indexOf("      const PASTEL_COLOR_PALETTE", constantStart);
  vm.runInContext(html.slice(constantStart, constantEnd) + "state.excelMappings=DEFAULT_EXCEL_MAPPINGS;" + ["normalizeMappingText", "aliasMatches", "sheetAliasMatchScore", "parseGenericWorkbookSheet", "classifyBundleFile"].map((name) => extractFunction(html, name)).join("\n") + ";globalThis.parseGeneric=parseGenericWorkbookSheet;globalThis.classify=classifyBundleFile", inputEnv);
  const parsedSales = inputEnv.parseGeneric({ fileName: "판매현황.xlsx", sheetName: "판매현황내역", kind: "sales", displayMatrix: salesMatrix });
  assert.equal(parsedSales.rowCount, 1, "merged total footer must never become a sale even with a numeric SKU cell");
  const file = { name: "구매현황.xlsx", size: 100 };
  inputEnv.parseExcelFile = async (_file, kind) => kind === "inventory" ? engine.parseInventoryWorkbook({ fileName: file.name, sheetName: "구매현황내역", rawMatrix: purchaseMatrix, displayMatrix: purchaseMatrix }) : { headerMapping: { columns: [] }, missingColumns: ["적요"] };
  inputEnv.parseGenericExcelFile = async (_file, kind) => inputEnv.parseGeneric({ fileName: file.name, sheetName: "구매현황내역", kind, displayMatrix: purchaseMatrix });
  assert.equal((await inputEnv.classify(file)).kind, "purchases", "warehouse code is metadata and cannot outrank purchase structure");
  console.log(`PASS ${path}: purchase classification excludes warehouse-code metadata; sales total footer excluded`);
}
