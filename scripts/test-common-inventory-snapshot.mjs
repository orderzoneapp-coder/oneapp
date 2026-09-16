import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const snapshotTools = require(path.join(ROOT, "orderops", "inventory-snapshot.js"));
const sha256Hex = async (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const inventoryMatrix = [
  ["품목코드", "품목명", "규격", "단위", "수량", "1창고", "3서울", "4전송"],
  ["A100", "상품 A", "10입", "EA", 9, 5, 3, 1],
  ["B200", "상품 B", "20입", "BOX", 4, 4, 0, 0],
];
const inventoryFileHash = await sha256Hex(JSON.stringify(inventoryMatrix));
const parsedInventory = engine.parseInventoryWorkbook({
  fileName: "창고별재고.xlsx",
  sheetName: "재고",
  fileHash: inventoryFileHash,
  rawMatrix: inventoryMatrix,
  displayMatrix: inventoryMatrix,
});
assert.deepEqual(parsedInventory.errors, []);

const envelope = await snapshotTools.buildErpEnvelope(parsedInventory, {
  basisDate: "2026-09-12",
  engineVersion: engine.ENGINE_VERSION,
  sha256Hex,
});
assert.equal(envelope.schemaVersion, snapshotTools.ERP_SCHEMA);
assert.equal(envelope.rowCount, 2);
assert.equal(envelope.hash, await sha256Hex(envelope.canonicalJson));
const canonical = JSON.parse(envelope.canonicalJson);
assert.equal(canonical.normalizedRows[0].totalQuantity, 9);
assert.equal(canonical.normalizedRows[0].warehouseValues.reduce((sum, row) => sum + row.quantity, 0), 9);
assert.equal(canonical.warehouseScope.length, 3);

const groupedInventory = JSON.parse(JSON.stringify(parsedInventory));
groupedInventory.sourceMatrix[1][5] = "1,000";
groupedInventory.rows[0].inventoryTotal = 1004;
groupedInventory.sourceMatrix[2][6] = "";
const groupedCanonical = snapshotTools.buildErpCanonical(groupedInventory, { basisDate: "2026-09-12" });
assert.equal(groupedCanonical.normalizedRows[0].warehouseValues[0].quantity, 1000);
assert.equal(groupedCanonical.normalizedRows[0].totalQuantity, 1004);

const verifiedErp = await snapshotTools.readErpSnapshot({
  metadata: {
    snapshotId: "INV-test",
    revision: "INVREV-test",
    hash: envelope.hash,
    rowCount: envelope.rowCount,
    cellCount: envelope.cellCount,
  },
  snapshot: envelope,
}, { sha256Hex });
assert.equal(verifiedErp.canonical.sourceFile.sha256, inventoryFileHash);
assert.equal(verifiedErp.readModel.schemaVersion, snapshotTools.READ_SCHEMA);
assert.equal(verifiedErp.readModel.applicationMode, "ERP_WAREHOUSE");
assert.equal(verifiedErp.readModel.warehouseScope.length, 3);

const dataOpsRows = [
  ["EA", "A100", "상품 A", "10입", 3, "LOT-1", "", 0, 0, "", 0],
  ["EA", "A100", "상품 A", "10입", 4, "LOT-2", "", 0, 0, "", 0],
  ["BOX", "B200", "상품 B", "20입", 5, "LOT-3", "", 0, 0, "", 0],
  ["EA", "B200", "상품 B", "20입", 6, "LOT-4", "", 0, 0, "", 0],
  ["EA", "C300", "상품 C", "30입", "", "LOT-BLANK", "", 0, 0, "확인 필요", 0],
  ["EA", "D400", "상품 D", "40입", 0, "LOT-ZERO", "", 0, 0, "실제 0", 0],
];
const dataOpsCanonical = {
  schemaVersion: snapshotTools.DATAOPS_SCHEMA,
  basisDate: "2026-09-12",
  columns: snapshotTools.DATAOPS_COLUMNS,
  rows: dataOpsRows,
};
const dataOpsSnapshot = {
  ...dataOpsCanonical,
  revision: "20260912-001",
  savedAt: "2026-09-12T01:00:00.000Z",
  hash: await sha256Hex(JSON.stringify(dataOpsCanonical)),
  rowCount: dataOpsRows.length,
  cellCount: dataOpsRows.length * snapshotTools.DATAOPS_COLUMNS.length,
};
const totalReadModel = await snapshotTools.readDataOpsSnapshot(dataOpsSnapshot, { sha256Hex });
assert.equal(totalReadModel.applicationMode, "TOTAL_ONLY");
assert.equal(totalReadModel.normalizedRows.length, 2);
assert.equal(totalReadModel.normalizedRows[0].totalQuantity, 7);
assert.deepEqual(totalReadModel.normalizedRows[0].sourceRowNumbers, [1, 2]);
assert.equal(totalReadModel.validation.errors.some((error) => error.code === "DATAOPS_UNIT_CONFLICT"), true);
assert.equal(totalReadModel.validation.errors.some((error) => error.code === "DATAOPS_QUANTITY_BLANK"), true);
assert.equal(totalReadModel.normalizedRows.find((row) => row.productCode === "D400").totalQuantity, 0);
assert.equal(totalReadModel.normalizedRows.some((row) => row.productCode === "C300"), false);
assert.deepEqual(totalReadModel.sourceRows, dataOpsRows);

const totalParsed = snapshotTools.dataOpsReadModelToParsed(totalReadModel);
assert.equal(totalParsed.columns.some((column) => column.role === "warehouseQuantity"), false);
assert.equal(totalParsed.rows[0].inventoryTotal, 7);
assert.equal(totalParsed.sourceEvidence.schemaVersion, snapshotTools.SOURCE_EVIDENCE_SCHEMA);
assert.deepEqual(totalParsed.sourceEvidence.rows, dataOpsRows);
assert.equal(totalParsed.sourceEvidence.exclusions.some((item) =>
  item.code === "DATAOPS_QUANTITY_BLANK" && item.sourceRows[0].values[5] === "LOT-BLANK"), true);

// The a596cbbd rollback removes common-inventory application from the UI and
// fulfillment engine. Keep the independent snapshot/adapter contract covered;
// server publication and failure safety remain in test-shipping-purchase-plan-cloud.mjs.
console.log("Retained common inventory snapshot and DataOps read-model tests passed.");
