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

const orderMatrix = [
  ["일자", "담당", "창고", "단위", "품목코드", "품목명", "규격", "수량", "적요", "적요1", "거래처", "그룹"],
  ["2026-09-12", "김담당", "본사", "EA", "A100", "상품 A", "10입", 5, "일반 적요", "직원 적요", "거래처 A", "A그룹"],
];
const parsedOrders = engine.parseOrderWorkbook({
  fileName: "주문현황.xlsx",
  sheetName: "주문",
  fileHash: await sha256Hex(JSON.stringify(orderMatrix)),
  rawMatrix: orderMatrix,
  displayMatrix: orderMatrix,
});
assert.deepEqual(parsedOrders.errors, []);
const workspace = engine.createPreviewWorkspace(parsedOrders, parsedInventory);
workspace.shipmentExecutionDraft = {
  schemaVersion: "orderops-shipment-execution-draft/v1",
  values: { line1: { shippedQuantity: "2", reason: "부분" } },
};
const sourceFingerprint = await sha256Hex("orders-plus-dataops");
const replaced = engine.replaceWorkspaceInventory(workspace, totalParsed, {
  applicationMode: "TOTAL_ONLY",
  sourceFingerprint,
  sourceReference: {
    schemaVersion: engine.INVENTORY_SOURCE_REFERENCE_SCHEMA_VERSION,
    sourceType: "DATAOPS_FINALIZED",
    sourceId: totalReadModel.sourceId,
    revision: totalReadModel.revision,
    hash: totalReadModel.hash,
    basisDate: totalReadModel.basisDate,
  },
});
assert.equal(replaced.workspaceMode, engine.PREVIEW_WORKSPACE_MODE);
assert.equal(replaced.inventoryApplicationMode, "TOTAL_ONLY");
assert.equal(replaced.planId, `SHIPPLAN-20260912-${sourceFingerprint.slice(0, 16)}`);
assert.equal(replaced.basisDateStatus, "valid");
assert.deepEqual(replaced.sourceFiles.inventory.sourceEvidence.rows, dataOpsRows);
assert.equal(replaced.inputValidation.canAnalyze, false);
assert.equal(replaced.inputValidation.errors[0].code, "TOTAL_ONLY_NOT_ALLOCATABLE");
assert.deepEqual(replaced.purchaseManagement, []);
assert.deepEqual(replaced.inventoryOverrides.cells, []);
assert.equal(replaced.allocations[0].stockTotal, 7);
assert.equal(replaced.allocations[0].remainingQuantity, 2);
assert.equal(replaced.shipmentExecutionDraft.values.line1.shippedQuantity, "2");
assert.equal(engine.getPurchaseUploadSelection(replaced).included.length, 0);
assert.equal(engine.getShortageCategoryContext(replaced).purchaseActionCount, 0);

const analyzedWorkspace = engine.analyze(parsedOrders, parsedInventory, {
  sourceFingerprint: await sha256Hex("orders-plus-erp"),
});
const warehouseOverrideColumn = engine.getInventoryColumnDescriptors(analyzedWorkspace)
  .find((column) => column.role === "warehouseQuantity");
engine.setInventoryOverride(analyzedWorkspace, "A100", warehouseOverrideColumn.key, 8);
const sameUnitReplacement = engine.replaceWorkspaceInventory(analyzedWorkspace, parsedInventory, {
  applicationMode: "ERP_WAREHOUSE",
  inventoryOverridePolicy: "PRESERVE_COMPATIBLE",
  sourceFingerprint: await sha256Hex("same-unit-compatible-overrides"),
  sourceReference: {
    schemaVersion: engine.INVENTORY_SOURCE_REFERENCE_SCHEMA_VERSION,
    sourceType: "ORDEROPS_ERP",
    sourceId: "INV-same-unit",
    revision: "INVREV-same-unit",
    hash: envelope.hash,
  },
});
assert.equal(sameUnitReplacement.inventoryOverrideDisposition.preservedCount, 1);
const changedUnitInventory = JSON.parse(JSON.stringify(parsedInventory));
changedUnitInventory.rows[0].unit = "BOX";
changedUnitInventory.fileHash = await sha256Hex("changed-unit-inventory");
const changedUnitReplacement = engine.replaceWorkspaceInventory(analyzedWorkspace, changedUnitInventory, {
  applicationMode: "ERP_WAREHOUSE",
  inventoryOverridePolicy: "PRESERVE_COMPATIBLE",
  sourceFingerprint: await sha256Hex("changed-unit-incompatible-overrides"),
  sourceReference: {
    schemaVersion: engine.INVENTORY_SOURCE_REFERENCE_SCHEMA_VERSION,
    sourceType: "ORDEROPS_ERP",
    sourceId: "INV-changed-unit",
    revision: "INVREV-changed-unit",
    hash: envelope.hash,
  },
});
assert.equal(changedUnitReplacement.inventoryOverrideDisposition.preservedCount, 0);
assert.equal(changedUnitReplacement.inventoryOverrideDisposition.discardedCount, 1);
const totalAfterAnalysis = engine.replaceWorkspaceInventory(analyzedWorkspace, totalParsed, {
  applicationMode: "TOTAL_ONLY",
  sourceFingerprint: await sha256Hex("analyzed-plus-total"),
  sourceReference: {
    schemaVersion: engine.INVENTORY_SOURCE_REFERENCE_SCHEMA_VERSION,
    sourceType: "DATAOPS_FINALIZED",
    sourceId: totalReadModel.sourceId,
    revision: totalReadModel.revision,
    hash: totalReadModel.hash,
  },
});
const erpRestored = engine.replaceWorkspaceInventory(totalAfterAnalysis, parsedInventory, {
  applicationMode: "ERP_WAREHOUSE",
  sourceFingerprint: await sha256Hex("analyzed-plus-restored-erp"),
  sourceReference: {
    schemaVersion: engine.INVENTORY_SOURCE_REFERENCE_SCHEMA_VERSION,
    sourceType: "ORDEROPS_ERP",
    sourceId: "INV-test",
    revision: "INVREV-test",
    hash: envelope.hash,
  },
});
assert.notEqual(erpRestored.workspaceMode, engine.PREVIEW_WORKSPACE_MODE);
assert.equal(erpRestored.inventoryPreviousWorkspaceMode, undefined);
assert.equal(erpRestored.inventoryApplicationMode, "ERP_WAREHOUSE");
assert.ok(erpRestored.planId);
assert.equal(erpRestored.inputValidation.canAnalyze, true);

const recoverySelection = engine.selectLatestVerifiedRecovery([
  { valid: true, record: { recordId: "published-old", publicationState: "PUBLISHED", updatedAt: "2026-09-12T00:00:00.000Z" } },
  { valid: true, record: { recordId: "staged-new", publicationState: "STAGED", updatedAt: "2026-09-12T02:00:00.000Z" } },
  { valid: true, record: { recordId: "legacy-published", updatedAt: "2026-09-12T01:00:00.000Z" } },
], "staged-new");
assert.equal(recoverySelection.selected.recordId, "legacy-published");
assert.equal(recoverySelection.candidates.some((candidate) => candidate.record.recordId === "staged-new"), false);

console.log("Common inventory snapshot tests passed.");
