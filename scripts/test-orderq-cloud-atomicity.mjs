import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const source = ["code.gs", "orderq-cloud.gs"]
  .map((fileName) => fs.readFileSync(path.join(rootDir, fileName), "utf8"))
  .join("\n");

const TOKEN = "shipping-plan-fallback-token";

class MockTextFinder {
  constructor(range, text) {
    this.range = range;
    this.text = String(text);
    this.entire = false;
  }

  matchEntireCell(value) {
    this.entire = Boolean(value);
    return this;
  }

  findNext() {
    for (let rowOffset = 0; rowOffset < this.range.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.range.columnCount; columnOffset += 1) {
        const value = String(this.range.sheet.getCell(
          this.range.row + rowOffset,
          this.range.column + columnOffset,
        ));
        const matched = this.entire ? value === this.text : value.includes(this.text);
        if (matched) return { getRow: () => this.range.row + rowOffset };
      }
    }
    return null;
  }
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
      this.sheet.spreadsheet.failItemAppendOnce
      && this.sheet.name === "ORDER_ITEM"
      && this.row > 1
    ) {
      this.sheet.spreadsheet.failItemAppendOnce = false;
      throw new Error("INJECTED_ORDER_ITEM_FAILURE");
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

  createTextFinder(text) {
    return new MockTextFinder(this, text);
  }
}

class MockSheet {
  constructor(spreadsheet, name) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.cells = [];
  }

  getName() {
    return this.name;
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

  getLastColumn() {
    return this.cells.reduce((maximum, row) => Math.max(maximum, (row || []).length), 0);
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new MockRange(this, row, column, rowCount, columnCount);
  }

  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((value, index) => this.setCell(row, index + 1, value));
    return this;
  }

  deleteRow(row) {
    this.cells.splice(row - 1, 1);
    return this;
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = new Map();
    this.failItemAppendOnce = false;
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

const spreadsheet = new MockSpreadsheet();
const properties = new Map([["ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN", TOKEN]]);
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
    getScriptLock: () => ({
      waitLock: () => {},
      releaseLock: () => {},
    }),
  },
  Utilities: {
    getUuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    computeDigest: (_algorithm, value) => [...crypto.createHash("sha256").update(String(value)).digest()],
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: (value) => ({
      value: String(value),
      setMimeType() { return this; },
      getContent() { return this.value; },
    }),
  },
});
vm.runInContext(source, context, { filename: "orderq-appscript-bundle.gs" });

function post(payload) {
  const output = context.doPost({ postData: { contents: JSON.stringify(payload) } });
  return JSON.parse(output.getContent());
}

function orderBundle(revision, quantity = 3) {
  const updatedAt = `2026-08-13T0${revision}:00:00.000Z`;
  return {
    order: {
      orderId: "ORDER-001",
      revision,
      customerId: "CUSTOMER-001",
      customerName: "테스트거래처",
      orderDate: "2026-08-13",
      status: "CONFIRMED",
      sourceMessageKey: "KAKAO-001",
      updatedAt,
    },
    items: [{
      orderItemId: "ORDER-001-L1",
      orderId: "ORDER-001",
      lineNo: 1,
      productId: "PRODUCT-001",
      quantity,
      matchStatus: "CONFIRMED",
      updatedAt,
    }],
  };
}

function pushOrder(revision, quantity, queueId, includeToken = true) {
  const payload = {
    action: "orderq_sync_push",
    schemaVersion: "ONEAPP_ORDERQ_SYNC_V1",
    deviceId: "TEST-PC-A",
    changes: [{
      queueId,
      entityType: "ORDER",
      entityId: "ORDER-001",
      operation: "UPSERT",
      revision,
      baseRevision: revision - 1,
      payload: orderBundle(revision, quantity),
    }],
  };
  if (includeToken) payload.token = TOKEN;
  return post(payload);
}

const denied = pushOrder(1, 3, "QUEUE-DENIED", false);
assert.equal(denied.status, "error");
assert.match(denied.message, /ORDERQ_ACCESS_DENIED/);

const created = pushOrder(1, 3, "QUEUE-ORDER-R1");
assert.equal(created.status, "success");
assert.equal(created.data.results[0].status, "applied");
assert.equal(created.data.results[0].serverRevision, 1);
assert.equal(context.orderQReadOrderBundle(spreadsheet, "ORDER-001").items[0].quantity, 3);

const transactionSheet = spreadsheet.getSheetByName("ORDER_TXN_LOG");
assert.equal(transactionSheet.getCell(transactionSheet.getLastRow(), 3), "COMMITTED");

spreadsheet.failItemAppendOnce = true;
const failedUpdate = pushOrder(2, 5, "QUEUE-ORDER-R2-FAIL");
assert.equal(failedUpdate.data.results[0].status, "error");
assert.match(failedUpdate.data.results[0].message, /INJECTED_ORDER_ITEM_FAILURE/);
const afterRollback = context.orderQReadOrderBundle(spreadsheet, "ORDER-001");
assert.equal(afterRollback.order.revision, 1);
assert.equal(afterRollback.items[0].quantity, 3);
assert.equal(transactionSheet.getCell(transactionSheet.getLastRow(), 3), "ROLLED_BACK");

const previousState = {
  bundle: afterRollback,
  customerId: "CUSTOMER-001",
  customer: context.orderQReadCustomer(spreadsheet, "CUSTOMER-001"),
};
const interruptedTransaction = context.orderQBeginTransaction(
  spreadsheet,
  "ORDER-001",
  previousState,
  { bundle: orderBundle(2, 7), customerId: "CUSTOMER-001" },
);
const orderSheet = context.orderQEnsureSheet(spreadsheet, "ORDER");
const partial = orderBundle(2, 7).order;
context.orderQWriteRow(orderSheet, partial.orderId, [
  partial.orderId,
  partial.revision,
  partial.customerId,
  partial.orderDate,
  partial.status,
  partial.updatedAt,
  JSON.stringify(partial),
]);

const recoveredHead = post({
  action: "orderq_order_head",
  token: TOKEN,
  orderId: "ORDER-001",
});
assert.equal(recoveredHead.status, "success");
assert.equal(recoveredHead.data.revision, 1);
assert.equal(recoveredHead.data.payload.items[0].quantity, 3);
assert.equal(transactionSheet.getCell(interruptedTransaction.row, 3), "RECOVERED");

const collectorPush = post({
  action: "orderq_sync_push",
  token: TOKEN,
  schemaVersion: "ONEAPP_ORDERQ_SYNC_V1",
  deviceId: "TEST-PC-A",
  changes: [{
    queueId: "QUEUE-BATCH-1",
    entityType: "IMPORT_BATCH",
    entityId: "BATCH-001",
    operation: "UPSERT",
    revision: 1,
    baseRevision: 0,
    payload: {
      importBatchId: "BATCH-001",
      sourceType: "SALES_HISTORY",
      status: "ACTIVE",
      updatedAt: "2026-08-13T03:00:00.000Z",
    },
  }],
});
assert.equal(collectorPush.data.results[0].status, "applied");

const pulled = post({
  action: "orderq_sync_pull",
  token: TOKEN,
  schemaVersion: "ONEAPP_ORDERQ_SYNC_V1",
  deviceId: "TEST-PC-B",
  afterSequence: 0,
  limit: 50,
});
assert.equal(pulled.status, "success");
assert.ok(pulled.data.changes.some((change) =>
  change.entityType === "IMPORT_BATCH" && change.payload.importBatchId === "BATCH-001",
));

const m9 = (action, body = {}) => post({
  action,
  token: TOKEN,
  schemaVersion: "ONEAPP_ORDERQ_CENTRAL_V1",
  ...body,
});

const m9Migration = m9("orderq_m9_migrate", {
  idempotencyKey: "M9-MIGRATE-D1",
  deviceId: "PC-A",
  entities: [
    { entityType:"ORDER", entityId:"M9-O1", revision:1, payload:{ orderId:"M9-O1", revision:1, localOnly:true } },
    { entityType:"ORDER_ITEM", entityId:"M9-OI1", revision:1, payload:{ orderItemId:"M9-OI1", orderId:"M9-O1", productId:"M9-P1", finalQuantity:6, revision:1, localOnly:true } },
    { entityType:"PRODUCT", entityId:"M9-P1", revision:1, payload:{ productId:"M9-P1", revision:1, localOnly:true } },
    { entityType:"WAREHOUSE", entityId:"M9-W1", revision:1, payload:{ warehouseId:"M9-W1", revision:1, localOnly:true } },
    { entityType:"INVENTORY_SNAPSHOT", entityId:"M9-IS1", revision:1, payload:{ inventorySnapshotId:"M9-IS1", importBatchId:"M9-IB1", basisDate:"2026-08-15", snapshotLastSequence:0, status:"ACTIVE", localOnly:true } },
    { entityType:"INVENTORY_LINE", entityId:"M9-IL1", revision:1, payload:{ inventoryLineId:"M9-IL1", inventorySnapshotId:"M9-IS1", productId:"M9-P1", warehouseId:"M9-W1", inventoryQuantity:10, status:"ACTIVE", localOnly:true } },
    { entityType:"DISPATCH_DECISION", entityId:"M9-D1", revision:1, payload:{ dispatchId:"M9-D1", status:"DRAFT", revision:1, localOnly:true } },
    { entityType:"DISPATCH_LINE", entityId:"M9-DL1", revision:1, payload:{ dispatchLineId:"M9-DL1", dispatchId:"M9-D1", orderItemId:"M9-OI1", actualProductId:"M9-P1", plannedBaseQuantity:6, localOnly:true } },
    { entityType:"DISPATCH_STOCK_ALLOCATION", entityId:"M9-DA1", revision:1, payload:{ allocationId:"M9-DA1", dispatchId:"M9-D1", dispatchLineId:"M9-DL1", warehouseId:"M9-W1", plannedBaseQuantity:6, localOnly:true } },
  ],
});
assert.equal(m9Migration.status, "success");
assert.equal(m9Migration.data.duplicate, false);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "DISPATCH_DECISION", "M9-D1").payload.localOnly, false);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "DISPATCH_DECISION", "M9-D1").payload.centralRevision, 1);
const m9MigrationCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
const m9MigrationConflict = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-CONFLICT", deviceId:"PC-B",
  entities:[
    { entityType:"ORDER", entityId:"M9-O-PARTIAL", revision:1, payload:{ orderId:"M9-O-PARTIAL", revision:1, localOnly:true } },
    { entityType:"DISPATCH_DECISION", entityId:"M9-D1", revision:1, payload:{ dispatchId:"M9-D1", status:"DRAFT", revision:1, customerId:"CHANGED", localOnly:true } },
  ],
});
assert.equal(m9MigrationConflict.status, "error");
assert.match(m9MigrationConflict.message, /MIGRATION_CONFLICT/);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "ORDER", "M9-O-PARTIAL"), null);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), m9MigrationCursor);

for (const testFailureAt of ["ENTITIES_WRITTEN", "CHANGES_WRITTEN", "COMMAND_WRITTEN"]) {
  const failureKey = `M9-MIGRATE-FAIL-${testFailureAt}`;
  const beforeCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
  const failed = m9("orderq_m9_migrate", {
    idempotencyKey:failureKey, deviceId:"PC-A", testFailureAt,
    entities:[{ entityType:"ORDER", entityId:`M9-O-${testFailureAt}`, revision:1, payload:{ orderId:`M9-O-${testFailureAt}`, revision:1, localOnly:true } }],
  });
  assert.equal(failed.status, "error");
  assert.match(failed.message, /MIGRATION_FAILURE_INJECTED/);
  assert.equal(context.orderQM9ReadEntity(spreadsheet, "ORDER", `M9-O-${testFailureAt}`), null);
  assert.equal(context.orderQM9ReadCommand(spreadsheet, failureKey), null);
  assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), beforeCursor);
  const recovered = m9("orderq_m9_migrate", {
    idempotencyKey:failureKey, deviceId:"PC-A",
    entities:[{ entityType:"ORDER", entityId:`M9-O-${testFailureAt}`, revision:1, payload:{ orderId:`M9-O-${testFailureAt}`, revision:1, localOnly:true } }],
  });
  assert.equal(recovered.status, "success");
  assert.equal(recovered.data.changes.length, 1);
}

const leaseMigration = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-LEASE", deviceId:"PC-A",
  entities:[{ entityType:"DISPATCH_DECISION", entityId:"M9-D-LEASE", revision:1, payload:{ dispatchId:"M9-D-LEASE", status:"DRAFT", revision:1, localOnly:true } }],
});
assert.equal(leaseMigration.status, "success");
const oldLease = m9("orderq_m9_command_prepare", {
  commandType:"RELEASE_DISPATCH", aggregateId:"M9-D-LEASE", expectedRevision:1, idempotencyKey:"M9-LEASE-OLD", deviceId:"PC-A",
});
assert.equal(oldLease.status, "success");
const oldLeaseCommand = context.orderQM9ReadCommand(spreadsheet, "M9-LEASE-OLD");
oldLeaseCommand.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
context.orderQM9WriteCommand(spreadsheet, oldLeaseCommand);
const newLease = m9("orderq_m9_command_prepare", {
  commandType:"RELEASE_DISPATCH", aggregateId:"M9-D-LEASE", expectedRevision:1, idempotencyKey:"M9-LEASE-NEW", deviceId:"PC-B",
});
assert.equal(newLease.status, "success");
assert.equal(context.orderQM9ReadCommand(spreadsheet, "M9-LEASE-OLD").status, "EXPIRED");
const abortedLease = m9("orderq_m9_command_abort", { idempotencyKey:"M9-LEASE-NEW", leaseToken:newLease.data.leaseToken, reason:"cancel" });
assert.equal(abortedLease.status, "success");
assert.equal(context.orderQM9ReadCommand(spreadsheet, "M9-LEASE-NEW").status, "ABORTED");
const abortedCommit = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-LEASE-NEW", leaseToken:newLease.data.leaseToken, fingerprint:newLease.data.fingerprint, mutations:[],
});
assert.equal(abortedCommit.status, "error");
assert.match(abortedCommit.message, /COMMAND_TERMINAL/);

const m9PrepareRelease = m9("orderq_m9_command_prepare", {
  commandType:"RELEASE_DISPATCH", aggregateId:"M9-D1", expectedRevision:1,
  idempotencyKey:"M9-REL-1", deviceId:"PC-A",
});
assert.equal(m9PrepareRelease.status, "success");
const m9Release = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-REL-1", leaseToken:m9PrepareRelease.data.leaseToken,
  fingerprint:m9PrepareRelease.data.fingerprint,
  mutations:[
    { entityType:"DISPATCH_DECISION", entityId:"M9-D1", revision:2, payload:{ dispatchId:"M9-D1", status:"RELEASED", revision:2, localOnly:true } },
    { entityType:"INVENTORY_RESERVATION", entityId:"M9-IR1", revision:2, payload:{ reservationId:"M9-IR1", dispatchId:"M9-D1", allocationId:"M9-DA1", productId:"M9-P1", warehouseId:"M9-W1", reservedBaseQuantity:6, status:"ACTIVE", localOnly:true } },
  ],
});
assert.equal(m9Release.status, "success");

const m9PrepareActual = m9("orderq_m9_command_prepare", {
  commandType:"UPDATE_DISPATCH", aggregateId:"M9-D1", expectedRevision:2,
  idempotencyKey:"M9-ACTUAL-1", deviceId:"PC-A",
});
const m9Actual = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-ACTUAL-1", leaseToken:m9PrepareActual.data.leaseToken,
  fingerprint:m9PrepareActual.data.fingerprint,
  mutations:[
    { entityType:"DISPATCH_DECISION", entityId:"M9-D1", revision:3, payload:{ dispatchId:"M9-D1", status:"READY_TO_CONFIRM", revision:3, localOnly:true } },
    { entityType:"DISPATCH_LINE", entityId:"M9-DL1", revision:3, payload:{ dispatchLineId:"M9-DL1", dispatchId:"M9-D1", orderItemId:"M9-OI1", actualProductId:"M9-P1", actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6, localOnly:true } },
    { entityType:"DISPATCH_STOCK_ALLOCATION", entityId:"M9-DA1", revision:3, payload:{ allocationId:"M9-DA1", dispatchId:"M9-D1", dispatchLineId:"M9-DL1", warehouseId:"M9-W1", reservationId:"M9-IR1", actualBaseQuantity:6, localOnly:true } },
  ],
});
assert.equal(m9Actual.status, "success");

const m9PrepareConfirm = m9("orderq_m9_command_prepare", {
  commandType:"CONFIRM_DISPATCH", aggregateId:"M9-D1", expectedRevision:3,
  idempotencyKey:"M9-CONFIRM-1", deviceId:"PC-A",
});
const m9ConfirmMutations = [
  { entityType:"DISPATCH_DECISION", entityId:"M9-D1", revision:4, payload:{ dispatchId:"M9-D1", status:"CONFIRMED", revision:4, localOnly:true } },
  { entityType:"SALES_DOCUMENT", entityId:"M9-SD1", revision:4, payload:{ salesDocumentId:"M9-SD1", dispatchId:"M9-D1", status:"CONFIRMED", erpPostingStatus:"READY", localOnly:true } },
  { entityType:"SALES_LINE", entityId:"M9-SL1", revision:4, payload:{ salesLineId:"M9-SL1", salesDocumentId:"M9-SD1", dispatchLineId:"M9-DL1", orderItemId:"M9-OI1", productId:"M9-P1", warehouseId:"M9-W1", actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6, localOnly:true } },
  { entityType:"INVENTORY_MOVEMENT", entityId:"M9-IM1", revision:4, payload:{ movementId:"M9-IM1", dispatchId:"M9-D1", dispatchLineId:"M9-DL1", sourceLineId:"M9-DA1", productId:"M9-P1", warehouseId:"M9-W1", movementType:"SALE_ISSUE", signedBaseQuantity:-6, ledgerSequence:999, localOnly:true } },
  { entityType:"ORDER_EVENT", entityId:"M9-OE1", revision:4, payload:{ eventId:"M9-OE1", orderId:"M9-O1", eventType:"SALES_TRANSFER_ALLOCATED", detail:{ orderItemId:"M9-OI1", salesLineId:"M9-SL1", transferredQty:6 }, localOnly:true } },
  { entityType:"INVENTORY_RESERVATION", entityId:"M9-IR1", revision:4, payload:{ reservationId:"M9-IR1", dispatchId:"M9-D1", allocationId:"M9-DA1", productId:"M9-P1", warehouseId:"M9-W1", reservedBaseQuantity:6, consumedBaseQuantity:6, status:"CONSUMED", localOnly:true } },
];
const m9BeforeFailureCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
const m9BeforeInvalidLedger = context.orderQM9MetaNumber(spreadsheet, "ledgerSequence");
const m9BeforeInvalidCommand = JSON.stringify(context.orderQM9ReadCommand(spreadsheet, "M9-CONFIRM-1"));
const m9InvalidCrossLedger = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-CONFIRM-1", leaseToken:m9PrepareConfirm.data.leaseToken,
  fingerprint:m9PrepareConfirm.data.fingerprint,
  mutations:m9ConfirmMutations.map(row => row.entityId === "M9-IM1"
    ? { ...row, payload:{ ...row.payload, signedBaseQuantity:-999 } }
    : row),
});
assert.equal(m9InvalidCrossLedger.status, "error");
assert.match(m9InvalidCrossLedger.message, /CONFIRM_MOVEMENT_QUANTITY_MISMATCH/);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "INVENTORY_MOVEMENT", "M9-IM1"), null);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), m9BeforeInvalidLedger);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), m9BeforeFailureCursor);
assert.equal(JSON.stringify(context.orderQM9ReadCommand(spreadsheet, "M9-CONFIRM-1")), m9BeforeInvalidCommand);
const m9FailedConfirm = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-CONFIRM-1", leaseToken:m9PrepareConfirm.data.leaseToken,
  fingerprint:m9PrepareConfirm.data.fingerprint, mutations:m9ConfirmMutations,
  testFailureAt:"ENTITIES_WRITTEN",
});
assert.equal(m9FailedConfirm.status, "error");
assert.match(m9FailedConfirm.message, /FAILURE_INJECTED/);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "DISPATCH_DECISION", "M9-D1").status, "READY_TO_CONFIRM");
assert.equal(context.orderQM9ReadEntity(spreadsheet, "INVENTORY_MOVEMENT", "M9-IM1"), null);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), 0);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), m9BeforeFailureCursor);

const m9FailedAfterCommandWrite = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-CONFIRM-1", leaseToken:m9PrepareConfirm.data.leaseToken,
  fingerprint:m9PrepareConfirm.data.fingerprint, mutations:m9ConfirmMutations,
  testFailureAt:"COMMAND_WRITTEN",
});
assert.equal(m9FailedAfterCommandWrite.status, "error");
assert.match(m9FailedAfterCommandWrite.message, /COMMAND_WRITTEN/);
assert.equal(context.orderQM9ReadCommand(spreadsheet, "M9-CONFIRM-1").status, "PREPARED");
assert.equal(context.orderQM9ReadEntity(spreadsheet, "INVENTORY_MOVEMENT", "M9-IM1"), null);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), 0);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), m9BeforeFailureCursor);

const m9Confirmed = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-CONFIRM-1", leaseToken:m9PrepareConfirm.data.leaseToken,
  fingerprint:m9PrepareConfirm.data.fingerprint, mutations:m9ConfirmMutations,
});
assert.equal(m9Confirmed.status, "success");
assert.equal(m9Confirmed.data.ledgerSequence, 1);
assert.equal(m9Confirmed.data.changes.find(row => row.entityId === "M9-IM1").payload.ledgerSequence, 1);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "INVENTORY_MOVEMENT", "M9-IM1").payload.ledgerSequence, 1);
const m9Retry = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-CONFIRM-1", leaseToken:m9PrepareConfirm.data.leaseToken,
  fingerprint:m9PrepareConfirm.data.fingerprint, mutations:m9ConfirmMutations,
});
assert.equal(m9Retry.data.duplicate, true);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), 1);
const m9MutationConflict = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-CONFIRM-1", leaseToken:m9PrepareConfirm.data.leaseToken,
  fingerprint:m9PrepareConfirm.data.fingerprint,
  mutations:m9ConfirmMutations.map(row => row.entityId === "M9-SL1"
    ? { ...row, payload:{ ...row.payload, actualQuantity:5 } }
    : row),
});
assert.equal(m9MutationConflict.status, "error");
assert.match(m9MutationConflict.message, /MUTATION_IDEMPOTENCY_CONFLICT/);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), 1);

const reversePrepare = m9("orderq_m9_command_prepare", {
  commandType:"REVERSE_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
  idempotencyKey:"M9-REVERSE-BAD", deviceId:"PC-B", intent:{ quantity:6 },
});
const beforeBadReverseSequence = context.orderQM9MetaNumber(spreadsheet, "ledgerSequence");
const badReverse = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-REVERSE-BAD", leaseToken:reversePrepare.data.leaseToken, fingerprint:reversePrepare.data.fingerprint,
  mutations:[
    { entityType:"DISPATCH_DECISION", entityId:"M9-D1-R", revision:1, payload:{ dispatchId:"M9-D1-R", status:"CONFIRMED", reversalOf:"M9-D1", revision:1, localOnly:true } },
    { entityType:"SALES_DOCUMENT", entityId:"M9-SD1-R", revision:1, payload:{ salesDocumentId:"M9-SD1-R", dispatchId:"M9-D1-R", status:"REVERSED", reversalOf:"M9-SD1", erpPostingStatus:"READY", localOnly:true } },
    { entityType:"SALES_LINE", entityId:"M9-SL1-R", revision:1, payload:{ salesLineId:"M9-SL1-R", salesDocumentId:"M9-SD1-R", dispatchLineId:"M9-DL1-R", reversalOf:"M9-SL1", actualQuantity:-6, actualBaseQuantity:-6, recognizedOrderQuantity:-6, localOnly:true } },
    { entityType:"INVENTORY_MOVEMENT", entityId:"M9-IM1-R", revision:1, payload:{ movementId:"M9-IM1-R", dispatchLineId:"M9-DL1-R", productId:"M9-P1", warehouseId:"M9-W1", movementType:"REVERSAL", signedBaseQuantity:999, reversalOf:"M9-IM1", localOnly:true } },
    { entityType:"ORDER_EVENT", entityId:"M9-OE1-R", revision:1, payload:{ eventId:"M9-OE1-R", orderId:"M9-O1", eventType:"SALES_TRANSFER_REVERSED", detail:{ orderItemId:"M9-OI1", salesLineId:"M9-SL1-R", transferredQty:6 }, localOnly:true } },
  ],
});
assert.equal(badReverse.status, "error");
assert.match(badReverse.message, /REVERSAL_MOVEMENT_MISMATCH|REVERSAL_MOVEMENT_INVALID/);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), beforeBadReverseSequence);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "INVENTORY_MOVEMENT", "M9-IM1-R"), null);
assert.equal(m9("orderq_m9_command_abort", { idempotencyKey:"M9-REVERSE-BAD", leaseToken:reversePrepare.data.leaseToken, reason:"invalid" }).status, "success");

assert.equal(m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-PD", deviceId:"PC-A", entities:[
    { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PD1", revision:1, payload:{ purchaseDocumentId:"M9-PD1", status:"DRAFT", revision:1, localOnly:true } },
    { entityType:"PURCHASE_LINE", entityId:"M9-PL1", revision:1, payload:{ purchaseLineId:"M9-PL1", purchaseDocumentId:"M9-PD1", productId:"M9-P1", warehouseId:"M9-W1", quantity:5, baseQuantity:5, amountWon:500, status:"DRAFT", localOnly:true } },
  ],
}).status, "success");
const purchasePrepare = m9("orderq_m9_command_prepare", {
  commandType:"CONFIRM_PURCHASE", aggregateId:"M9-PD1", expectedRevision:1, idempotencyKey:"M9-PURCHASE", deviceId:"PC-A",
});
const purchaseMutations = [
  { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PD1", revision:2, payload:{ purchaseDocumentId:"M9-PD1", status:"CONFIRMED", revision:2, erpPostingStatus:"READY", amountWon:500, localOnly:true } },
  { entityType:"PURCHASE_LINE", entityId:"M9-PL1", revision:2, payload:{ purchaseLineId:"M9-PL1", purchaseDocumentId:"M9-PD1", productId:"M9-P1", warehouseId:"M9-W1", quantity:5, baseQuantity:5, amountWon:500, movementId:"M9-PIM1", status:"CONFIRMED", localOnly:true } },
  { entityType:"INVENTORY_MOVEMENT", entityId:"M9-PIM1", revision:2, payload:{ movementId:"M9-PIM1", sourceDocumentId:"M9-PD1", sourceLineId:"M9-PL1", productId:"M9-P1", warehouseId:"M9-W1", movementType:"PURCHASE_RECEIPT", signedBaseQuantity:5, localOnly:true } },
];
const purchaseBefore = context.orderQM9MetaNumber(spreadsheet, "ledgerSequence");
const badPurchase = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-PURCHASE", leaseToken:purchasePrepare.data.leaseToken, fingerprint:purchasePrepare.data.fingerprint,
  mutations:purchaseMutations.map(row => row.entityId === "M9-PIM1" ? { ...row, payload:{ ...row.payload, signedBaseQuantity:999 } } : row),
});
assert.equal(badPurchase.status, "error");
assert.match(badPurchase.message, /PURCHASE_QUANTITY_MISMATCH/);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), purchaseBefore);
const goodPurchase = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-PURCHASE", leaseToken:purchasePrepare.data.leaseToken, fingerprint:purchasePrepare.data.fingerprint, mutations:purchaseMutations,
});
assert.equal(goodPurchase.status, "success");
assert.equal(goodPurchase.data.ledgerSequence, purchaseBefore + 1);
const purchaseReversePrepare = m9("orderq_m9_command_prepare", {
  commandType:"REVERSE_PURCHASE", aggregateId:"M9-PD1", expectedRevision:2, idempotencyKey:"M9-PURCHASE-REVERSE-BAD", deviceId:"PC-A",
});
const badPurchaseReverse = m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-PURCHASE-REVERSE-BAD", leaseToken:purchaseReversePrepare.data.leaseToken, fingerprint:purchaseReversePrepare.data.fingerprint,
  mutations:[
    { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PD1-R", revision:1, payload:{ purchaseDocumentId:"M9-PD1-R", status:"REVERSED", reversalOf:"M9-PD1", erpPostingStatus:"READY", localOnly:true } },
    { entityType:"PURCHASE_LINE", entityId:"M9-PL1-R", revision:1, payload:{ purchaseLineId:"M9-PL1-R", purchaseDocumentId:"M9-PD1-R", status:"REVERSED", reversalOf:"M9-PL1", productId:"M9-P1", warehouseId:"M9-W1", quantity:-6, baseQuantity:-6, amountWon:-600, movementId:"M9-PIM1-R", localOnly:true } },
    { entityType:"INVENTORY_MOVEMENT", entityId:"M9-PIM1-R", revision:1, payload:{ movementId:"M9-PIM1-R", sourceLineId:"M9-PL1-R", productId:"M9-P1", warehouseId:"M9-W1", movementType:"REVERSAL", signedBaseQuantity:-6, reversalOf:"M9-PIM1", localOnly:true } },
  ],
});
assert.equal(badPurchaseReverse.status, "error");
assert.match(badPurchaseReverse.message, /PURCHASE_REVERSAL_EXCEEDS_ORIGINAL|PURCHASE_REVERSAL_MOVEMENT_EXCEEDS_ORIGINAL/);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"), goodPurchase.data.ledgerSequence);
const m9Pulled = m9("orderq_m9_pull", { afterSequence:m9BeforeFailureCursor, limit:50 });
assert.equal(m9Pulled.status, "success");
assert.ok(m9Pulled.data.changes.some(row => row.entityId === "M9-IM1"));

console.log("ORDER Q Apps Script token/atomicity/recovery tests passed.");
