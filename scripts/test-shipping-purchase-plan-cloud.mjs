import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const codeSource = fs.readFileSync(path.join(rootDir, "code.gs"), "utf8");

const SHIPPING_TOKEN = "shipping-token";
const DATAOPS_TOKEN = "dataops-token";
const SHIPPING_FORMAT = "ONEAPP_SHIPPING_PURCHASE_PLAN_V1";
const WORKSPACE_SCHEMA = "shipping-workspace/v2";
const PLAN_FINGERPRINT = "a".repeat(64);
const PLAN_ID = `SHIPPLAN-20260804-${PLAN_FINGERPRINT.slice(0, 16)}`;

function columnNumber(label) {
  return [...label].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0);
}

class MockRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  setValues(rows) {
    assert.equal(rows.length, this.rowCount);
    rows.forEach((values) => assert.equal(values.length, this.columnCount));
    if (
      this.sheet.spreadsheet.failIndexAppendOnce &&
      this.sheet.name === "ShippingPlanIndex" &&
      this.row > 1
    ) {
      this.sheet.spreadsheet.failIndexAppendOnce = false;
      throw new Error("INJECTED_INDEX_FINALIZE_FAILURE");
    }
    rows.forEach((values, rowOffset) => {
      values.forEach((value, columnOffset) => {
        this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, value);
      });
    });
    return this;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.getCell(this.row + rowOffset, this.column + columnOffset),
      ),
    );
  }

  setValue(value) {
    return this.setValues([[value]]);
  }

  getValue() {
    return this.getValues()[0][0];
  }
}

class MockSheet {
  constructor(spreadsheet, name) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.cells = [];
  }

  setCell(row, column, value) {
    if (!this.cells[row - 1]) this.cells[row - 1] = [];
    this.cells[row - 1][column - 1] = value;
  }

  getCell(row, column) {
    const value = this.cells[row - 1]?.[column - 1];
    return value === undefined || value === null ? "" : value;
  }

  getLastRow() {
    for (let index = this.cells.length - 1; index >= 0; index -= 1) {
      if ((this.cells[index] || []).some((value) => value !== undefined && value !== null && value !== "")) {
        return index + 1;
      }
    }
    return 0;
  }

  getRange(rowOrA1, column, rowCount, columnCount) {
    if (typeof rowOrA1 === "string") {
      const match = /^([A-Z]+)(\d+)$/.exec(rowOrA1);
      assert.ok(match, `Unsupported A1 range: ${rowOrA1}`);
      return new MockRange(this, Number(match[2]), columnNumber(match[1]));
    }
    return new MockRange(this, rowOrA1, column, rowCount, columnCount);
  }

  clearContents() {
    this.cells = [];
    return this;
  }

  snapshot() {
    return this.cells.map((row) => [...(row || [])]);
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = new Map();
    this.failIndexAppendOnce = false;
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    assert.equal(this.sheets.has(name), false, `Duplicate sheet: ${name}`);
    const sheet = new MockSheet(this, name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

function countScalarCells(value) {
  if (value === null || value === undefined) return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countScalarCells(item), 0);
  if (typeof value === "object") {
    return Object.keys(value).reduce((sum, key) => sum + countScalarCells(value[key]), 0);
  }
  return 1;
}

function countRows(canonical) {
  const { workspace } = canonical;
  return [
    workspace.allocations,
    workspace.productSummaries,
    workspace.purchaseManagement,
    workspace.sourceFiles.orders.matrix,
    workspace.sourceFiles.inventory.matrix,
  ].reduce((sum, rows) => sum + rows.length, 0);
}

function buildSnapshot(purchase, savedBy) {
  const purchaseRow = {
    rowType: "main",
    productCode: "000100",
    productName: "테스트 상품",
    spec: "BOX",
    purchaseNeed: 2,
    purchase,
    inventoryMatched: true,
  };
  const inventoryShadowRow = {
    rowType: "main",
    inventoryShadow: true,
    productCode: "000200",
    productName: "주문 없는 재고상품",
    specification: "EA",
    purchaseNeed: null,
    totalOrderQuantity: null,
    purchase: "재고전용거래처",
    inventoryMatched: true,
  };
  const workspace = {
    schemaVersion: WORKSPACE_SCHEMA,
    sourceFingerprint: PLAN_FINGERPRINT,
    planId: PLAN_ID,
    basisDate: "2026-08-04",
    basisDateStatus: "valid",
    sourceFiles: {
      orders: {
        fileName: "주문.xlsx",
        sheetName: "주문",
        rowCount: 1,
        sha256: "b".repeat(64),
        matrix: [["일자-No.", "2026-08-04-1"]],
      },
      inventory: {
        fileName: "재고.xlsx",
        sheetName: "재고",
        rowCount: 2,
        sha256: "c".repeat(64),
        matrix: [["코드", "000100"], ["코드", "000200"]],
      },
    },
    allocations: [{ productCode: "000100", purchase }],
    productSummaries: [{ productCode: "000100", purchase }],
    purchaseManagement: [purchaseRow, inventoryShadowRow],
  };
  const canonical = {
    schemaVersion: SHIPPING_FORMAT,
    planId: PLAN_ID,
    basisDate: "2026-08-04",
    sourceFingerprint: PLAN_FINGERPRINT,
    sourceFileName: "주문.xlsx / 재고.xlsx",
    sourceFiles: {
      orders: { fileName: "주문.xlsx", sheetName: "주문", rowCount: 1, sha256: "b".repeat(64) },
      inventory: { fileName: "재고.xlsx", sheetName: "재고", rowCount: 2, sha256: "c".repeat(64) },
    },
    savedBy,
    productRowCount: 1,
    purchaseUploadRowCount: purchase === "대체" || purchase === "소분" ? 0 : 1,
    purchaseInputs: { "000100": purchase, "000200": "재고전용거래처" },
    activePreview: "purchases",
    workspace,
  };
  const canonicalJson = JSON.stringify(canonical);
  return {
    schemaVersion: SHIPPING_FORMAT,
    planId: PLAN_ID,
    hashAlgorithm: "SHA-256",
    hash: crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    rowCount: countRows(canonical),
    cellCount: countScalarCells(canonical),
    canonicalJson,
  };
}

function buildDataOpsSnapshot() {
  const columns = ["단위", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요", "행사가"];
  const rows = [["EA", "000100", "테스트 상품", "", 1, "2026-08-04", "", 1000, "", "", 0]];
  const canonicalJson = JSON.stringify({
    schemaVersion: "ONEAPP_DATAOPS_SNAPSHOT_V1",
    basisDate: "2026-08-04",
    columns,
    rows,
  });
  return {
    schemaVersion: "ONEAPP_DATAOPS_SNAPSHOT_V1",
    basisDate: "2026-08-04",
    savedAt: "2026-08-04T01:00:00.000Z",
    hashAlgorithm: "SHA-256",
    hash: crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    rowCount: rows.length,
    cellCount: rows.length * columns.length,
    canonicalJson,
  };
}

const spreadsheet = new MockSpreadsheet();
const properties = new Map([
  ["ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN", SHIPPING_TOKEN],
]);
let uuidCounter = 0;
const context = vm.createContext({
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, String(value)),
    }),
  },
  LockService: {
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
    computeDigest: (_algorithm, text) =>
      [...crypto.createHash("sha256").update(String(text), "utf8").digest()].map((value) =>
        value > 127 ? value - 256 : value,
      ),
    getUuid: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, "0")}`,
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: (text) => ({
      text,
      mimeType: "",
      setMimeType(mimeType) {
        this.mimeType = mimeType;
        return this;
      },
    }),
  },
});
vm.runInContext(codeSource, context, { filename: "code.gs" });

function post(payload) {
  const output = context.doPost({ postData: { contents: JSON.stringify(payload) } });
  assert.equal(output.mimeType, "application/json");
  return JSON.parse(output.text);
}

function shippingPost(action, extra = {}) {
  return post({ action, token: SHIPPING_TOKEN, ...extra });
}

function shippingList() {
  const response = shippingPost("shipping_plan_list", { planId: PLAN_ID, limit: 200 });
  assert.equal(response.status, "success", response.message);
  return response.data;
}

function nonShippingSnapshot() {
  return JSON.stringify(
    ["MasterDB", "HistoryLogs", "AppConfig", "DataOpsSnapshot_A", "DataOpsSnapshot_B"].map((name) => [
      name,
      spreadsheet.getSheetByName(name)?.snapshot() || null,
    ]),
  );
}

for (const [name, value] of [
  ["MasterDB", "master-sentinel"],
  ["HistoryLogs", "history-sentinel"],
  ["AppConfig", "config-sentinel"],
]) {
  spreadsheet.insertSheet(name).getRange(1, 1).setValue(value);
}
const nonShippingBeforeSave = nonShippingSnapshot();

const firstSnapshot = buildSnapshot("거래처A", "담당A");
for (const [action, extra] of [
  ["shipping_plan_save", { snapshot: firstSnapshot }],
  ["shipping_plan_list", { planId: PLAN_ID }],
  ["shipping_plan_get", { planId: PLAN_ID }],
]) {
  assert.equal(post({ action, ...extra }).message, "SHIPPING_PLAN_ACCESS_DENIED", `${action} must reject a missing token`);
  assert.equal(post({ action, token: "wrong", ...extra }).message, "SHIPPING_PLAN_ACCESS_DENIED", `${action} must reject a wrong token`);
  assert.equal(post({ action, token: DATAOPS_TOKEN, ...extra }).message, "SHIPPING_PLAN_ACCESS_DENIED", `${action} must reject a DataOps legacy token value`);
}
const firstSave = shippingPost("shipping_plan_save", { snapshot: firstSnapshot });
assert.equal(firstSave.status, "success", firstSave.message);
assert.equal(firstSave.data.planId, PLAN_ID);
assert.equal(nonShippingSnapshot(), nonShippingBeforeSave, "Shipping save must not mutate shared sheets");

let revisions = shippingList();
assert.equal(revisions.length, 1);
const firstRevision = revisions[0];
assert.equal(firstRevision.hash, firstSnapshot.hash);
assert.equal(firstRevision.rowCount, firstSnapshot.rowCount);
assert.equal(firstRevision.cellCount, firstSnapshot.cellCount);

const firstGet = shippingPost("shipping_plan_get", { planId: PLAN_ID });
assert.equal(firstGet.status, "success", firstGet.message);
assert.equal(firstGet.data.metadata.revision, firstRevision.revision);
assert.equal(firstGet.data.metadata.hash, firstSnapshot.hash);
assert.equal(firstGet.data.metadata.rowCount, firstSnapshot.rowCount);
assert.equal(firstGet.data.metadata.cellCount, firstSnapshot.cellCount);
assert.equal(firstGet.data.plan.purchaseInputs["000100"], "거래처A");
assert.equal(firstGet.data.plan.purchaseInputs["000200"], "재고전용거래처");
assert.equal(firstGet.data.metadata.productRowCount, 1, "cloud product metadata must ignore inventory shadow rows");
assert.equal(firstGet.data.metadata.purchaseUploadRowCount, 1, "cloud upload metadata must ignore inventory shadow rows");

const historySheet = spreadsheet.getSheetByName("ShippingPlanHistory");
const historyRowsBeforeFailure = historySheet.getLastRow();
spreadsheet.failIndexAppendOnce = true;
const failedSnapshot = buildSnapshot("거래처B", "담당B");
const failedSave = shippingPost("shipping_plan_save", { snapshot: failedSnapshot });
assert.equal(failedSave.status, "error");
assert.match(failedSave.message, /INJECTED_INDEX_FINALIZE_FAILURE/);
assert.ok(historySheet.getLastRow() > historyRowsBeforeFailure, "history append must precede index finalize");

const orphanRevision = String(historySheet.getRange(historyRowsBeforeFailure + 1, 2).getValue());
revisions = shippingList();
assert.deepEqual(revisions.map((item) => item.revision), [firstRevision.revision]);
const latestAfterFailure = shippingPost("shipping_plan_get", { planId: PLAN_ID });
assert.equal(latestAfterFailure.status, "success");
assert.equal(latestAfterFailure.data.metadata.revision, firstRevision.revision);
assert.equal(latestAfterFailure.data.plan.purchaseInputs["000100"], "거래처A");
const orphanGet = shippingPost("shipping_plan_get", { planId: PLAN_ID, revision: orphanRevision });
assert.equal(orphanGet.status, "error");
assert.match(orphanGet.message, /SHIPPING_PLAN_REVISION_NOT_FOUND/);

const retrySave = shippingPost("shipping_plan_save", { snapshot: failedSnapshot });
assert.equal(retrySave.status, "success", retrySave.message);
revisions = shippingList();
assert.equal(revisions.length, 2);
assert.equal(revisions[0].revision, retrySave.data.revision);
assert.equal(revisions[1].revision, firstRevision.revision);
assert.notEqual(retrySave.data.revision, orphanRevision);

const previousAfterRetry = shippingPost("shipping_plan_get", {
  planId: PLAN_ID,
  revision: firstRevision.revision,
});
assert.equal(previousAfterRetry.status, "success", previousAfterRetry.message);
assert.equal(previousAfterRetry.data.plan.purchaseInputs["000100"], "거래처A");
const latestAfterRetry = shippingPost("shipping_plan_get", { planId: PLAN_ID });
assert.equal(latestAfterRetry.status, "success", latestAfterRetry.message);
assert.equal(latestAfterRetry.data.plan.purchaseInputs["000100"], "거래처B");
assert.equal(latestAfterRetry.data.plan.purchaseInputs["000200"], "재고전용거래처");
assert.equal(latestAfterRetry.data.metadata.hash, failedSnapshot.hash);
assert.equal(latestAfterRetry.data.metadata.rowCount, failedSnapshot.rowCount);
assert.equal(latestAfterRetry.data.metadata.cellCount, failedSnapshot.cellCount);

const dataOpsGetWithLegacyToken = post({ action: "dataops_snapshot_get", token: SHIPPING_TOKEN });
assert.equal(dataOpsGetWithLegacyToken.status, "success");
assert.equal(dataOpsGetWithLegacyToken.data, null);
const dataOpsGet = post({ action: "dataops_snapshot_get", token: DATAOPS_TOKEN });
assert.equal(dataOpsGet.status, "success");
assert.equal(dataOpsGet.data, null);

const shippingStateBeforeSharedActions = JSON.stringify({
  list: shippingList(),
  history: historySheet.snapshot(),
});
const dataOpsSnapshot = buildDataOpsSnapshot();
const dataOpsCommit = post({ action: "dataops_snapshot_commit", snapshot: dataOpsSnapshot });
assert.equal(dataOpsCommit.status, "success", dataOpsCommit.message);
const dataOpsLegacyCommit = post({ action: "dataops_snapshot_commit", token: SHIPPING_TOKEN, snapshot: dataOpsSnapshot });
assert.equal(dataOpsLegacyCommit.status, "success", dataOpsLegacyCommit.message);
assert.equal(dataOpsLegacyCommit.data.revision, dataOpsCommit.data.revision, "legacy token fields must be ignored without changing DataOps identity");
const dataOpsTokenlessRead = post({ action: "dataops_snapshot_get" });
assert.equal(dataOpsTokenlessRead.data.revision, dataOpsCommit.data.revision);
assert.equal(dataOpsTokenlessRead.data.hash, dataOpsCommit.data.hash);
assert.equal(dataOpsTokenlessRead.data.rowCount, dataOpsCommit.data.rowCount);
assert.equal(dataOpsTokenlessRead.data.cellCount, dataOpsCommit.data.cellCount);
assert.equal(
  JSON.stringify({ list: shippingList(), history: historySheet.snapshot() }),
  shippingStateBeforeSharedActions,
  "DataOps tokenless commit/get must not mutate Shipping plan history or index",
);
for (const payload of [
  { action: "initSync" },
  { action: "chunk_master", data: [{ 코드: "M001", 품명: "마스터" }] },
  { action: "chunk_history", data: [{ action: "history" }] },
  { action: "config", data: { schemaVersion: "shared-config-test" } },
]) {
  const response = post(payload);
  assert.equal(response.status, "success", `${payload.action}: ${response.message}`);
}
assert.equal(
  JSON.stringify({ list: shippingList(), history: historySheet.snapshot() }),
  shippingStateBeforeSharedActions,
  "Master/History/Config actions must not mutate Shipping plan history or index",
);

const latestIndex = shippingList()[0];
const tamperedPayload = `${historySheet.getRange(latestIndex.historyStartRow, 4).getValue()} `;
historySheet.getRange(latestIndex.historyStartRow, 4).setValue(tamperedPayload);
const tamperedGet = shippingPost("shipping_plan_get", { planId: PLAN_ID });
assert.equal(tamperedGet.status, "error");
assert.match(tamperedGet.message, /SHIPPING_PLAN_HISTORY_CHAR_COUNT_MISMATCH|SHIPPING_PLAN_HASH_MISMATCH/);

console.log("Shipping purchase-plan cloud failure-injection tests passed.");
