import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../orderFulfillmentEngine.js");
const workbookTools = require("../orderFulfillmentWorkbook.js");
const XLSX = require("../customer-master/vendor/xlsx.full.min.js");
const parse = (matrix, name = "재고현황.xlsx") => engine.parseInventoryWorkbook({
  rawMatrix: matrix, displayMatrix: matrix, fileName: name, sheetName: "재고", fileHash: "1".repeat(64),
});
const snapshot = parse([
  ["원본 제목"],
  ["단위", "품목코드", "품명", "규격", "재고", "구매가"],
  ["BOX", "001", "배추", "BOX", 10.5, 1200],
  ["EA", "Case", "소포장", "EA", 0, 0],
  ["", "blank", "미입력", "", null, null],
  [null, null, "합계", null, 10.5],
]);
// A named footer is handled through its first nonblank label, even outside column A.
assert.deepEqual(snapshot.errors, []);
assert.equal(snapshot.inventoryLayout, "snapshot");
assert.equal(snapshot.headerRowIndex, 1);
assert.equal(snapshot.rows.length, 3);
assert.equal(snapshot.rows[0].productCode, "001");
assert.equal(snapshot.rows[2].openingQuantity, null);
const workspace = engine.analyzeInventory(snapshot, { sourceFingerprint: "2".repeat(64) });
assert.equal(workspace.inventoryOnly, true);
assert.deepEqual(workspace.orders, []);
workspace.orderOpsInputs = {
  purchases: { fileName: "구매현황.xlsx", rows: [
    { productCode: "001", quantity: 2.5 }, { productCode: "001", quantity: -1 },
    { productCode: "new", productName: "신규", quantity: 3.5 },
  ] },
  sales: { fileName: "판매현황.xlsx", rows: [
    { productCode: "001", quantity: 15 }, { productCode: "001", quantity: -0.5 },
    { productCode: "zero-only", quantity: 0 }, { productCode: "case", quantity: 1 },
    { productCode: "Case", sourceUnit: "KG", quantity: 2 },
  ] },
};
const rowFor = (code, unit) => engine.getInventoryMovementView(workspace).rows.find((row) => row.productCode === code && (unit === undefined || row.unit === unit));
assert.equal(rowFor("001").inboundQuantity, 1.5);
assert.equal(rowFor("001").salesQuantity, 14.5);
assert.equal(rowFor("001").remainingQuantity, -2.5, "oversold balance must stay negative");
assert.equal(rowFor("new").openingQuantity, 0);
assert.equal(rowFor("new").remainingQuantity, 3.5);
assert.match(rowFor("new").quantityMessage, /기초재고 없음 · 0 적용/);
assert.equal(rowFor("zero-only").remainingQuantity, 0);
assert.equal(rowFor("Case", "EA").remainingQuantity, 0);
assert.equal(rowFor("Case", "KG").remainingQuantity, -2);
assert.equal(rowFor("case").remainingQuantity, -1, "code case must not auto-match");
assert.equal(rowFor("blank").sourceOpeningQuantity, null);
assert.equal(rowFor("blank").openingQuantity, null, "existing snapshot blank must remain unknown");
assert.equal(rowFor("blank").remainingQuantity, null);
assert.equal(rowFor("001").sourceEvidence.purchases.length, 2);
assert.equal(rowFor("001").sourceEvidence.rawInventoryCells[4], 10.5);

const originalMatrix = JSON.stringify(workspace.sourceFiles.inventory.matrix);
const originalInventory = JSON.stringify(workspace.inventory);
const key = rowFor("001").rowKey;
const beforeFocusOnly = JSON.stringify(workspace);
assert.equal(engine.setInventoryMovementCell(workspace, key, "movement:stocktake", ""), workspace);
engine.setInventoryMovementCell(workspace, key, "movement:stocktake", null);
engine.setInventoryMovementCell(workspace, rowFor("Case", "EA").rowKey, "movement:opening", "0");
engine.setInventoryMovementCell(workspace, key, "movement:note", "");
assert.equal(JSON.stringify(workspace), beforeFocusOnly, "Tab/Enter on untouched blank, zero and note must create no edit store or timestamp");
assert.deepEqual(rowFor("001").changedFields, []);
assert.deepEqual(rowFor("Case", "EA").changedFields, []);
engine.setInventoryMovementCell(workspace, key, "movement:stocktake", 0);
assert.equal(rowFor("001").stocktakeQuantity, 0);
assert.equal(rowFor("001").adjustmentQuantity, 2.5);
assert.equal(rowFor("001").finalQuantity, 0);
engine.setInventoryMovementCell(workspace, key, "movement:note", "실사 확인");
engine.setInventoryMovementCell(workspace, key, "movement:unit-price", 0);
const beforeReconfirm = JSON.stringify(workspace);
const editStoreBeforeReconfirm = workspace.inventoryMovementEdits;
engine.setInventoryMovementCell(workspace, key, "movement:stocktake", "0.0");
engine.setInventoryMovementCell(workspace, key, "movement:note", "실사 확인");
engine.setInventoryMovementCell(workspace, key, "movement:unit-price", 0);
assert.equal(JSON.stringify(workspace), beforeReconfirm, "reconfirming effective edits must preserve their timestamps");
assert.equal(workspace.inventoryMovementEdits, editStoreBeforeReconfirm, "unchanged edit must not replace edit store");
const beforeInvalid = JSON.stringify(workspace);
assert.throws(() => engine.setInventoryMovementCell(workspace, key, "movement:opening", "잘못된 수량"));
assert.equal(JSON.stringify(workspace), beforeInvalid, "failed edit must not mutate state");
assert.throws(() => engine.setInventoryMovementCell(workspace, key, "movement:remaining", 55));
engine.recalculateWorkspace(workspace);
assert.equal(rowFor("001").finalQuantity, 0);
assert.equal(rowFor("001").note, "실사 확인");
assert.equal(workspace.inventoryOnly, true);
assert.equal(JSON.stringify(workspace.sourceFiles.inventory.matrix), originalMatrix);
assert.equal(JSON.stringify(workspace.inventory), originalInventory);
engine.setInventoryMovementCell(workspace, key, "movement:stocktake", "");
assert.equal(rowFor("001").stocktakeQuantity, null);
assert.equal(rowFor("001").finalQuantity, -2.5);
const clearedStocktake = JSON.stringify(workspace.inventoryMovementEdits);
engine.setInventoryMovementCell(workspace, key, "movement:stocktake", "  ");
assert.equal(JSON.stringify(workspace.inventoryMovementEdits), clearedStocktake, "reconfirming cleared stocktake must remain a no-op");
engine.setInventoryMovementCell(workspace, key, "movement:opening", "");
assert.equal(rowFor("001").openingQuantity, null, "explicit blank edit is distinct from zero and missing source policy");
assert.equal(rowFor("001").remainingQuantity, null);
engine.setInventoryMovementCell(workspace, key, "movement:opening", 0);
assert.equal(rowFor("001").remainingQuantity, -13);

const movement = parse([
  ["단위", "품목코드", "품목명", "규격", "재고", "입고", "출고", "잔량", "잔량", "입고가"],
  ["BOX", "001", "배추", "BOX", 10.5, 2, 3, 9.5, 9.5, 1000],
  ["EA", "002", "깻잎", "EA", null, 1, 2, -1, -1, 500],
]);
assert.deepEqual(movement.errors, []);
assert.equal(movement.inventoryLayout, "movement");
assert.equal(movement.rows[0].inventoryTotal, 9.5);
assert.equal(movement.columns.filter((column) => column.role === "warehouseQuantity").length, 1);
const moved = engine.analyzeInventory(movement);
let movedRow = () => engine.getInventoryMovementView(moved).rows[0];
assert.equal(movedRow().remainingQuantity, 9.5, "use opening plus embedded movements, never closing plus movements");
assert.equal(engine.getInventoryMovementView(moved).rows[1].remainingQuantity, -1);
moved.orderOpsInputs = { purchases: { rows: [{ productCode: "001", quantity: 2 }] } };
assert.equal(movedRow().remainingQuantity, 9.5, "uploaded purchase replaces embedded purchase");
moved.orderOpsInputs.sales = { rows: [{ productCode: "001", quantity: 4 }] };
assert.equal(movedRow().remainingQuantity, 8.5);
assert.match(movedRow().quantityMessage, /재계산 차이 -1/);
engine.setInventoryMovementCell(moved, movedRow().rowKey, "movement:stocktake", 0);
const exportedView = engine.getInventoryMovementView(moved);
const reimport = parse([exportedView.headers, ...exportedView.rows.map((row) => row.values)], "재고변동표.xlsx");
assert.deepEqual(reimport.errors, []);
assert.equal(reimport.rows[0].inventoryTotal, 0);
const restored = engine.analyzeInventory(reimport);
restored.orderOpsInputs = moved.orderOpsInputs;
const restoredRow = engine.getInventoryMovementView(restored).rows[0];
assert.equal(restoredRow.remainingQuantity, 8.5);
assert.equal(restoredRow.stocktakeQuantity, 0);
assert.equal(restoredRow.finalQuantity, 0);
assert.equal(restoredRow.sourceEvidence.rawInventoryCells.length, exportedView.headers.length);
const conflict = parse([
  movement.headers,
  ["BOX", "001", "배추", "BOX", 10, 2, 3, 9, 99, 1000],
]);
assert.ok(conflict.warnings.some((warning) => warning.code === "INVENTORY_CLOSING_CONFLICT"));
assert.equal(conflict.rows[0].inventoryTotal, 9);
assert.equal(conflict.rows[0].rawCells[8], 99);

// Opt-in real workbook acceptance: source files are read only and never checked in.
if (process.env.ORDERQ_REAL_XLSX_DIR) {
  const directory = process.env.ORDERQ_REAL_XLSX_DIR;
  const load = (name) => {
    const workbook = XLSX.read(fs.readFileSync(path.join(directory, `${name}.xlsx`)), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return {
      rawMatrix: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }),
      displayMatrix: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null }),
      sheetName: workbook.SheetNames[0], fileName: `${name}.xlsx`,
    };
  };
  const auxiliary = (name, codeIndex) => ({ fileName: `${name}.xlsx`, rows: load(name).rawMatrix.slice(2)
    .filter((row) => row[codeIndex] !== null && row[codeIndex] !== undefined && String(row[codeIndex]).trim() && row[codeIndex + 1])
    .map((row, index) => ({ productCode: String(row[codeIndex]), productName: String(row[codeIndex + 1] || ""),
      specification: name === "구매현황" ? String(row[7] || "") : "",
      quantity: row[8], rawCells: row, sourceRowNumber: index + 3 })) });
  const inputs = { purchases: auxiliary("구매현황", 5), sales: auxiliary("판매현황", 6) };
  assert.ok(inputs.purchases.rows.length > 0);
  assert.ok(inputs.sales.rows.length > 0);
  for (const name of ["전일재고현황", "재고변동표"]) {
    const sourceInput = load(name);
    const isMovement = name === "재고변동표";
    const codeIndex = isMovement ? 6 : 1;
    const openingIndex = isMovement ? 9 : 4;
    const rawInventory = sourceInput.rawMatrix.slice(isMovement ? 1 : 2)
      .filter((row) => row[codeIndex] !== null && row[codeIndex] !== undefined && String(row[codeIndex]).trim() && row[codeIndex + 1]);
    const rawOpeningByCode = new Map(rawInventory.map((row) => [String(row[codeIndex]), Number(row[openingIndex] ?? 0)]));
    const expectedCodes = new Set([...rawOpeningByCode.keys(), ...inputs.purchases.rows.map((row) => row.productCode), ...inputs.sales.rows.map((row) => row.productCode)]);
    const expectedByCode = new Map([...expectedCodes].map((code) => {
      const sum = (kind) => inputs[kind].rows.filter((row) => row.productCode === code).reduce((acc, row) => acc + row.quantity, 0);
      return [code, (rawOpeningByCode.get(code) ?? 0) + sum("purchases") - sum("sales")];
    }));
    const expectedTotal = [...expectedByCode.values()].reduce((sum, value) => sum + value, 0);
    const source = engine.parseInventoryWorkbook(sourceInput);
    assert.deepEqual(source.errors, []);
    assert.equal(source.rows.length, rawInventory.length);
    const realWorkspace = engine.analyzeInventory(source);
    if (isMovement) {
      const standalone = engine.getInventoryMovementView(realWorkspace);
      const rawClosingByCode = new Map(rawInventory.map((row) => [String(row[codeIndex]), Number(row[12])]));
      assert.equal(standalone.rows.length, rawInventory.length);
      assert.equal(standalone.rows.reduce((sum, row) => sum + row.remainingQuantity, 0), [...rawClosingByCode.values()].reduce((sum, quantity) => sum + quantity, 0));
      standalone.rows.forEach((row) => assert.equal(row.remainingQuantity, rawClosingByCode.get(row.productCode),
        `standalone movement closing must match source M/N for SKU ${row.productCode}`));
    }
    realWorkspace.orderOpsInputs = inputs;
    const view = engine.getInventoryMovementView(realWorkspace);
    assert.equal(view.rows.length, expectedCodes.size);
    assert.equal(view.rows.reduce((sum, row) => sum + row.remainingQuantity, 0), expectedTotal);
    for (const row of view.rows) {
      assert.equal(row.remainingQuantity, expectedByCode.get(row.productCode), `${name}: SKU ${row.productCode}`);
    }
    const selected = [view.rows[0], view.rows.find((row) => row.inventoryMissing && row.unit) || view.rows.find((row) => row.inventoryMissing)].filter(Boolean);
    selected.forEach((row) => engine.setInventoryMovementCell(realWorkspace, row.rowKey, "movement:stocktake", 0));
    const beforeExport = engine.getInventoryMovementView(realWorkspace);
    // Serialize an actual .xlsx, not just the in-memory grid; export adds title rows and unit inference.
    const bytes = XLSX.write(workbookTools.buildInventoryMovementWorkbook(realWorkspace, XLSX), { bookType: "xlsx", type: "buffer" });
    const readBack = XLSX.read(bytes, { type: "buffer" });
    const exportSheet = readBack.Sheets["재고변동표"];
    const exportedSource = engine.parseInventoryWorkbook({
      fileName: "재고변동표.xlsx", sheetName: "재고변동표",
      rawMatrix: XLSX.utils.sheet_to_json(exportSheet, { header: 1, raw: true, defval: null }),
      displayMatrix: XLSX.utils.sheet_to_json(exportSheet, { header: 1, raw: false, defval: null }),
    });
    assert.deepEqual(exportedSource.errors, []);
    const roundtripWorkspace = engine.analyzeInventory(exportedSource);
    roundtripWorkspace.orderOpsInputs = inputs;
    const roundtrip = engine.getInventoryMovementView(roundtripWorkspace);
    assert.equal(roundtrip.rows.length, expectedCodes.size, "exported unit inference must not split transaction-only SKUs on reimport");
    assert.equal(roundtrip.rows.reduce((sum, row) => sum + row.remainingQuantity, 0), expectedTotal);
    const roundtripByCode = new Map(roundtrip.rows.map((row) => [row.productCode, row]));
    beforeExport.rows.forEach((before) => {
      const after = roundtripByCode.get(before.productCode);
      assert.ok(after, `roundtrip must retain SKU ${before.productCode}`);
      for (const field of ["openingQuantity", "inboundQuantity", "salesQuantity", "remainingQuantity", "stocktakeQuantity", "adjustmentQuantity", "finalQuantity", "unit"]) {
        assert.equal(after[field], before[field], `${name} XLSX roundtrip ${before.productCode}.${field}`);
      }
    });
    console.log(`${name}: ${rawInventory.length} inventory rows, ${expectedCodes.size} union SKUs, closing ${expectedTotal}`);
  }
}
console.log("ORDER Q inventory movement engine tests passed");
