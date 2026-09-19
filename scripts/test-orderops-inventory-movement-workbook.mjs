import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const engine = require("../orderFulfillmentEngine.js");
const output = require("../orderFulfillmentWorkbook.js");
const XLSX = require("../customer-master/vendor/xlsx.full.min.js");

const matrix = [
  ["품목코드", "품명", "규격", "재고", "구매가"],
  ["00001", "박스 품목", "bOX", 2, 1200],
  ["한글02", "낱개 품목", "EA", 0, 0],
];
const parsed = engine.parseInventoryWorkbook({ fileName: "전일재고현황.xlsx", rawMatrix: matrix, displayMatrix: matrix });
assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
const workspace = engine.analyzeInventory(parsed, { createdAt: "2026-09-20T00:00:00Z" });
workspace.orderOpsInputs = { sales: { rows: [
  { productCode: "00001", specification: "bOX", quantity: 4 },
  { productCode: "한글02", specification: "EA", quantity: 1.5 },
] } };
const view = engine.getInventoryMovementView(workspace);
const countColumn = view.columns.find((column) => column.role === "stocktakeQuantity");
engine.setInventoryMovementCell(workspace, view.rows.find((row) => row.productCode === "한글02").rowKey, countColumn.key, 0);
const before = JSON.stringify(workspace);
const workbook = output.buildInventoryMovementWorkbook(workspace, XLSX);
assert.deepEqual(workbook.SheetNames, ["재고변동표"]);
const sheet = workbook.Sheets["재고변동표"];
const afterView = engine.getInventoryMovementView(workspace);
const position = (code, role) => XLSX.utils.encode_cell({
  r: 4 + afterView.rows.findIndex((row) => row.productCode === code),
  c: afterView.columns.findIndex((column) => column.role === role),
});
assert.equal(sheet[position("00001", "productCode")].t, "s");
assert.equal(sheet[position("00001", "productCode")].v, "00001");
assert.equal(sheet[position("00001", "calculatedQuantity")].v, -2);
assert.equal(sheet[position("00001", "calculatedQuantity")].s.fill.fgColor.rgb, "FFF200");
assert.equal(sheet[position("00001", "productName")].s.font.color.rgb, "1E293B");
assert.equal(sheet[position("한글02", "productName")].s.font.color.rgb, "B91C1C");
assert.equal(sheet[position("한글02", "stocktakeQuantity")].v, 0);
assert.equal(sheet[position("한글02", "finalQuantity")].v, 0);
assert.equal(sheet[position("한글02", "adjustmentQuantity")].v, 1.5);
assert.equal(JSON.stringify(workspace), before, "export must not mutate source/workspace");
const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
const reopened = XLSX.read(bytes, { type: "buffer" });
const imported = XLSX.utils.sheet_to_json(reopened.Sheets["재고변동표"], { header: 1, raw: true, defval: "" });
const reparsed = engine.parseInventoryWorkbook({ fileName: "재고변동표.xlsx", rawMatrix: imported, displayMatrix: imported });
assert.equal(reparsed.errors.length, 0, JSON.stringify(reparsed.errors));
const restored = engine.analyzeInventory(reparsed);
const reView = engine.getInventoryMovementView(restored);
assert.equal(reView.rows.find((row) => row.productCode === "00001").remainingQuantity, -2);
assert.equal(reView.rows.find((row) => row.productCode === "한글02").stocktakeQuantity, 0);
assert.equal(reView.rows.find((row) => row.productCode === "한글02").finalQuantity, 0);
console.log("PASS inventory movement XLSX: signed quantities, zero stocktake, text SKU, source preservation, red units, yellow negatives and export/reimport.");
