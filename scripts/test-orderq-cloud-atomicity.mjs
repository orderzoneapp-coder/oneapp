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
    rows.forEach((values) => values.forEach((value) => {
      if (String(value ?? '').length > 50000) throw new Error('MOCK_SHEETS_CELL_LIMIT_EXCEEDED');
    }));
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

  deleteRows(row, count = 1) {
    this.cells.splice(row - 1, count);
    return this;
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = new Map();
    this.failItemAppendOnce = false;
    this.failScriptLockOnce = false;
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
const properties = new Map([
  ["ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN", TOKEN],
  ["ONEAPP_ORDERQ_CUTOVER_MODE", "PILOT_WRITE"]
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
    getScriptLock: () => ({
      waitLock: () => {
        if (spreadsheet.failScriptLockOnce) {
          spreadsheet.failScriptLockOnce = false;
          throw new Error('MOCK_SCRIPT_LOCK_TIMEOUT');
        }
      },
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
const m9SpreadsheetDigest = () => JSON.stringify([...spreadsheet.sheets.entries()].map(([name, sheet]) => [name, sheet.cells]));
const m9OperationalDigest = () => {
  const commandSheet = spreadsheet.getSheetByName("ORDERQ_M9_COMMAND");
  const commands = (commandSheet?.cells || []).slice(1)
    .map(row => row?.[10] ? JSON.parse(String(row[10])) : null)
    .filter(Boolean)
    .sort((left, right) => String(left.idempotencyKey).localeCompare(String(right.idempotencyKey)));
  return JSON.stringify({
    entities:context.orderQM9ReadAllEntities(spreadsheet)
      .sort((left, right) => `${left.entityType}:${left.entityId}`.localeCompare(`${right.entityType}:${right.entityId}`)),
    changes:context.orderQM9ReadChanges(spreadsheet).rows.map(({ rowNumber, appliedAt, ...row }) => row),
    commands,
    syncSequence:context.orderQM9MetaNumber(spreadsheet, "syncSequence"),
    ledgerSequence:context.orderQM9MetaNumber(spreadsheet, "ledgerSequence"),
  });
};

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

const longOpeningEvidence = "G".repeat(1800);
const m9LargeOpeningEntities = [
  ...Array.from({ length:20 }, (_, index) => ({
    entityType:"PRODUCT", entityId:`M9-G2-P${String(index + 1).padStart(2, "0")}`, revision:1,
    payload:{ productId:`M9-G2-P${String(index + 1).padStart(2, "0")}`, itemName:`G2-${index + 1}`, evidence:longOpeningEvidence, revision:1, localOnly:true },
  })),
  { entityType:"WAREHOUSE", entityId:"M9-G2-W1", revision:1, payload:{ warehouseId:"M9-G2-W1", status:"ACTIVE", revision:1, localOnly:true } },
  { entityType:"INVENTORY_SNAPSHOT", entityId:"M9-G2-IS1", revision:1, payload:{ inventorySnapshotId:"M9-G2-IS1", basisDate:"2026-08-16", snapshotLastSequence:0, status:"ACTIVE", revision:1, localOnly:true } },
  ...Array.from({ length:20 }, (_, index) => ({
    entityType:"INVENTORY_LINE", entityId:`M9-G2-IL${String(index + 1).padStart(2, "0")}`, revision:1,
    payload:{ inventoryLineId:`M9-G2-IL${String(index + 1).padStart(2, "0")}`, inventorySnapshotId:"M9-G2-IS1", productId:`M9-G2-P${String(index + 1).padStart(2, "0")}`, warehouseId:"M9-G2-W1", inventoryQuantity:index - 3, evidence:longOpeningEvidence, status:"ACTIVE", revision:1, localOnly:true },
  })),
];
assert.ok(JSON.stringify(m9LargeOpeningEntities).length > 50000);
const m9LargeOpening = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-G2-OPENING-42", deviceId:"PC-A", entities:m9LargeOpeningEntities,
});
assert.equal(m9LargeOpening.status, "success");
assert.equal(m9LargeOpening.data.changes.length, 42);
const largeOpeningCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
const m9LargeOpeningDuplicate = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-G2-OPENING-42", deviceId:"PC-A", entities:m9LargeOpeningEntities,
});
assert.equal(m9LargeOpeningDuplicate.status, "success");
assert.equal(m9LargeOpeningDuplicate.data.duplicate, true);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), largeOpeningCursor);
const migrationTxnSheet = spreadsheet.getSheetByName("ORDERQ_M9_TXN_LOG");
let largeOpeningTxnRow = 0;
for (let row = 2; row <= migrationTxnSheet.getLastRow(); row += 1) {
  if (migrationTxnSheet.getCell(row, 2) === "M9-G2-OPENING-42") largeOpeningTxnRow = row;
}
assert.ok(largeOpeningTxnRow > 0);
assert.equal(migrationTxnSheet.getCell(largeOpeningTxnRow, 3), "COMMITTED");
assert.ok(String(migrationTxnSheet.getCell(largeOpeningTxnRow, 4)).length < 50000);
assert.ok(String(migrationTxnSheet.getCell(largeOpeningTxnRow, 5)).length < 50000);

const removedLargeOpeningEntity = context.orderQM9ReadEntity(spreadsheet, "INVENTORY_LINE", "M9-G2-IL20");
context.orderQDeleteEntityRow(spreadsheet.getSheetByName("ORDERQ_M9_ENTITY"), context.orderQM9EntityKey("INVENTORY_LINE", "M9-G2-IL20"));
const mismatchedDuplicate = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-G2-OPENING-42", deviceId:"PC-A", entities:m9LargeOpeningEntities,
});
assert.equal(mismatchedDuplicate.status, "error");
assert.match(mismatchedDuplicate.message, /IDEMPOTENCY_STATE_MISMATCH/);
context.orderQM9WriteEntity(spreadsheet, removedLargeOpeningEntity);
assert.equal(m9("orderq_m9_migrate", {
  idempotencyKey:"M9-G2-OPENING-42", deviceId:"PC-A", entities:m9LargeOpeningEntities,
}).status, "success");

const commitRecoveryCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
const interruptedCommit = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-INTERRUPT-COMMIT", deviceId:"PC-A",
  testFailureAt:"COMMAND_WRITTEN", testRollbackFailureAt:"BEFORE_ROLLBACK",
  entities:[{ entityType:"ORDER", entityId:"M9-O-INTERRUPT-COMMIT", revision:1, payload:{ orderId:"M9-O-INTERRUPT-COMMIT", revision:1, localOnly:true } }],
});
assert.equal(interruptedCommit.status, "error");
const commitRecoveryBlockedPull = m9("orderq_m9_pull", { afterSequence:commitRecoveryCursor, limit:50 });
assert.equal(commitRecoveryBlockedPull.status, "error");
assert.match(commitRecoveryBlockedPull.message, /MIGRATION_RECOVERY_COMPLETED_RETRY/);
const commitRecoveryPull = m9("orderq_m9_pull", { afterSequence:commitRecoveryCursor, limit:50 });
assert.equal(commitRecoveryPull.status, "success");
assert.ok(commitRecoveryPull.data.changes.some(row => row.entityId === "M9-O-INTERRUPT-COMMIT"));

const rollbackRecoveryCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
const interruptedRollback = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-INTERRUPT-ROLLBACK", deviceId:"PC-A",
  testFailureAt:"CHANGES_WRITTEN", testRollbackFailureAt:"ENTITIES_RESTORED",
  entities:[{ entityType:"ORDER", entityId:"M9-O-INTERRUPT-ROLLBACK", revision:1, payload:{ orderId:"M9-O-INTERRUPT-ROLLBACK", revision:1, localOnly:true } }],
});
assert.equal(interruptedRollback.status, "error");
const officialBlockedForRecovery = m9("orderq_m9_command_prepare", {
  commandType:"RELEASE_DISPATCH", aggregateId:"M9-D1", expectedRevision:1,
  idempotencyKey:"M9-PREPARE-DURING-RECOVERY", deviceId:"PC-B",
});
assert.equal(officialBlockedForRecovery.status, "error");
assert.match(officialBlockedForRecovery.message, /MIGRATION_RECOVERY_COMPLETED_RETRY/);
assert.equal(context.orderQM9ReadCommand(spreadsheet, "M9-PREPARE-DURING-RECOVERY"), null);
assert.equal(context.orderQM9ReadEntity(spreadsheet, "ORDER", "M9-O-INTERRUPT-ROLLBACK"), null);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), rollbackRecoveryCursor);
assert.equal(m9("orderq_m9_pull", { afterSequence:rollbackRecoveryCursor, limit:50 }).status, "success");

const beforeLockTimeout = m9SpreadsheetDigest();
spreadsheet.failScriptLockOnce = true;
const migrationLockTimeout = m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-LOCK-TIMEOUT", deviceId:"PC-B",
  entities:[{ entityType:"ORDER", entityId:"M9-O-LOCK-TIMEOUT", revision:1, payload:{ orderId:"M9-O-LOCK-TIMEOUT", revision:1, localOnly:true } }],
});
assert.equal(migrationLockTimeout.status, "error");
assert.match(migrationLockTimeout.message, /MOCK_SCRIPT_LOCK_TIMEOUT/);
assert.equal(m9SpreadsheetDigest(), beforeLockTimeout);

migrationTxnSheet.appendRow([
  "OQM9CMD-NON-MIGRATION-PREPARED", "M9-OFFICIAL-TXN-PREPARED", "PREPARED",
  JSON.stringify({ entities:{} }), JSON.stringify([]), "", "2026-08-16T00:00:00.000Z",
]);
assert.equal(
  context.orderQM9ReadMigrationTransactions(spreadsheet, ["PREPARED"]).some(row => row.txnId === "OQM9CMD-NON-MIGRATION-PREPARED"),
  false,
);
assert.equal(m9("orderq_m9_pull", { afterSequence:rollbackRecoveryCursor, limit:50 }).status, "success");

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
const m10LargeDispatchEvidence = "D".repeat(9000);
const m9ConfirmMutations = [
  { entityType:"DISPATCH_DECISION", entityId:"M9-D1", revision:4, payload:{ dispatchId:"M9-D1", status:"CONFIRMED", revision:4, localOnly:true } },
  { entityType:"DISPATCH_LINE", entityId:"M9-DL1", revision:4, payload:{ dispatchLineId:"M9-DL1", dispatchId:"M9-D1", orderItemId:"M9-OI1", actualProductId:"M9-P1", actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6, status:"CONFIRMED", localOnly:true } },
  { entityType:"DISPATCH_STOCK_ALLOCATION", entityId:"M9-DA1", revision:4, payload:{ allocationId:"M9-DA1", dispatchId:"M9-D1", dispatchLineId:"M9-DL1", warehouseId:"M9-W1", reservationId:"M9-IR1", actualBaseQuantity:6, movementId:"M9-IM1", status:"CONFIRMED", localOnly:true } },
  { entityType:"SALES_DOCUMENT", entityId:"M9-SD1", revision:4, payload:{ salesDocumentId:"M9-SD1", dispatchId:"M9-D1", status:"CONFIRMED", erpPostingStatus:"READY", localOnly:true } },
  { entityType:"SALES_LINE", entityId:"M9-SL1", revision:4, payload:{ salesLineId:"M9-SL1", salesDocumentId:"M9-SD1", dispatchLineId:"M9-DL1", orderItemId:"M9-OI1", productId:"M9-P1", warehouseId:"M9-W1", actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6, localOnly:true } },
  { entityType:"INVENTORY_MOVEMENT", entityId:"M9-IM1", revision:4, payload:{ movementId:"M9-IM1", dispatchId:"M9-D1", dispatchLineId:"M9-DL1", sourceLineId:"M9-DA1", productId:"M9-P1", warehouseId:"M9-W1", movementType:"SALE_ISSUE", signedBaseQuantity:-6, ledgerSequence:999, localOnly:true } },
  { entityType:"ORDER_EVENT", entityId:"M9-OE1", revision:4, payload:{ eventId:"M9-OE1", orderId:"M9-O1", eventType:"SALES_TRANSFER_ALLOCATED", detail:{ orderItemId:"M9-OI1", salesLineId:"M9-SL1", transferredQty:6 }, localOnly:true } },
  { entityType:"INVENTORY_RESERVATION", entityId:"M9-IR1", revision:4, payload:{ reservationId:"M9-IR1", dispatchId:"M9-D1", allocationId:"M9-DA1", productId:"M9-P1", warehouseId:"M9-W1", reservedBaseQuantity:6, consumedBaseQuantity:6, status:"CONSUMED", localOnly:true } },
].map((row, index) => ({ ...row, payload:{ ...row.payload, m10Evidence:`${index}:${m10LargeDispatchEvidence}` } }));
assert.ok(JSON.stringify(m9ConfirmMutations).length > 50000);
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

const m10LargeReverseEvidence = "R".repeat(12000);
const goodReverseMutations = [
  { entityType:"DISPATCH_DECISION", entityId:"M9-D1-R", revision:1, payload:{ dispatchId:"M9-D1-R", status:"CONFIRMED", reversalOf:"M9-D1", revision:1, localOnly:true } },
  { entityType:"SALES_DOCUMENT", entityId:"M9-SD1-R", revision:1, payload:{ salesDocumentId:"M9-SD1-R", dispatchId:"M9-D1-R", status:"REVERSED", reversalOf:"M9-SD1", erpPostingStatus:"READY", localOnly:true } },
  { entityType:"SALES_LINE", entityId:"M9-SL1-R", revision:1, payload:{ salesLineId:"M9-SL1-R", salesDocumentId:"M9-SD1-R", dispatchLineId:"M9-DL1-R", reversalOf:"M9-SL1", actualQuantity:-6, actualBaseQuantity:-6, recognizedOrderQuantity:-6, supplyAmountWon:0, vatAmountWon:0, totalAmountWon:0, localOnly:true } },
  { entityType:"INVENTORY_MOVEMENT", entityId:"M9-IM1-R", revision:1, payload:{ movementId:"M9-IM1-R", dispatchId:"M9-D1-R", dispatchLineId:"M9-DL1-R", productId:"M9-P1", warehouseId:"M9-W1", movementType:"REVERSAL", signedBaseQuantity:6, reversalOf:"M9-IM1", localOnly:true } },
  { entityType:"ORDER_EVENT", entityId:"M9-OE1-R", revision:1, payload:{ eventId:"M9-OE1-R", orderId:"M9-O1", eventType:"SALES_TRANSFER_REVERSED", detail:{ orderItemId:"M9-OI1", salesLineId:"M9-SL1-R", transferredQty:6 }, localOnly:true } },
].map((row, index) => ({ ...row, payload:{ ...row.payload, m10Evidence:`${index}:${m10LargeReverseEvidence}` } }));
assert.ok(JSON.stringify(goodReverseMutations).length > 50000);
const goodReversePrepare = m9("orderq_m9_command_prepare", {
  commandType:"REVERSE_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
  idempotencyKey:"M10-REVERSE-LARGE", deviceId:"PC-B", intent:{ quantity:6 },
});
const goodReverse = m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-REVERSE-LARGE", leaseToken:goodReversePrepare.data.leaseToken,
  fingerprint:goodReversePrepare.data.fingerprint, mutations:goodReverseMutations,
});
assert.equal(goodReverse.status, "success");
assert.equal(goodReverse.data.changes.length, goodReverseMutations.length);
const goodReverseCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-REVERSE-LARGE", leaseToken:goodReversePrepare.data.leaseToken,
  fingerprint:goodReversePrepare.data.fingerprint, mutations:goodReverseMutations,
}).data.duplicate, true);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), goodReverseCursor);

assert.equal(m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-PD", deviceId:"PC-A", entities:[
    { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PD1", revision:1, payload:{ purchaseDocumentId:"M9-PD1", status:"DRAFT", revision:1, localOnly:true } },
    { entityType:"PURCHASE_LINE", entityId:"M9-PL1", revision:1, payload:{ purchaseLineId:"M9-PL1", purchaseDocumentId:"M9-PD1", productId:"M9-P1", warehouseId:"M9-W1", quantity:5, baseQuantity:5, amountWon:500, status:"DRAFT", localOnly:true } },
  ],
}).status, "success");
const purchasePrepare = m9("orderq_m9_command_prepare", {
  commandType:"CONFIRM_PURCHASE", aggregateId:"M9-PD1", expectedRevision:1, idempotencyKey:"M9-PURCHASE", deviceId:"PC-A",
});
const m10LargePurchaseEvidence = "P".repeat(18000);
const purchaseMutations = [
  { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PD1", revision:2, payload:{ purchaseDocumentId:"M9-PD1", status:"CONFIRMED", revision:2, erpPostingStatus:"READY", amountWon:500, localOnly:true } },
  { entityType:"PURCHASE_LINE", entityId:"M9-PL1", revision:2, payload:{ purchaseLineId:"M9-PL1", purchaseDocumentId:"M9-PD1", productId:"M9-P1", warehouseId:"M9-W1", quantity:5, baseQuantity:5, amountWon:500, movementId:"M9-PIM1", status:"CONFIRMED", localOnly:true } },
  { entityType:"INVENTORY_MOVEMENT", entityId:"M9-PIM1", revision:2, payload:{ movementId:"M9-PIM1", sourceDocumentId:"M9-PD1", sourceLineId:"M9-PL1", productId:"M9-P1", warehouseId:"M9-W1", movementType:"PURCHASE_RECEIPT", signedBaseQuantity:5, localOnly:true } },
].map((row, index) => ({ ...row, payload:{ ...row.payload, m10Evidence:`${index}:${m10LargePurchaseEvidence}` } }));
assert.ok(JSON.stringify(purchaseMutations).length > 50000);
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
assert.equal(m9("orderq_m9_command_abort", {
  idempotencyKey:"M9-PURCHASE-REVERSE-BAD", leaseToken:purchaseReversePrepare.data.leaseToken, reason:"invalid",
}).status, "success");
const m10LargePurchaseReverseEvidence = "Q".repeat(18000);
const purchaseReverseMutations = [
  { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PD1-R", revision:1, payload:{ purchaseDocumentId:"M9-PD1-R", status:"REVERSED", reversalOf:"M9-PD1", erpPostingStatus:"READY", localOnly:true } },
  { entityType:"PURCHASE_LINE", entityId:"M9-PL1-R", revision:1, payload:{ purchaseLineId:"M9-PL1-R", purchaseDocumentId:"M9-PD1-R", status:"REVERSED", reversalOf:"M9-PL1", productId:"M9-P1", warehouseId:"M9-W1", quantity:-5, baseQuantity:-5, amountWon:-500, movementId:"M9-PIM1-R", localOnly:true } },
  { entityType:"INVENTORY_MOVEMENT", entityId:"M9-PIM1-R", revision:1, payload:{ movementId:"M9-PIM1-R", sourceLineId:"M9-PL1-R", productId:"M9-P1", warehouseId:"M9-W1", movementType:"REVERSAL", signedBaseQuantity:-5, reversalOf:"M9-PIM1", localOnly:true } },
].map((row, index) => ({ ...row, payload:{ ...row.payload, m10Evidence:`${index}:${m10LargePurchaseReverseEvidence}` } }));
assert.ok(JSON.stringify(purchaseReverseMutations).length > 50000);
const purchaseReverseGoodPrepare = m9("orderq_m9_command_prepare", {
  commandType:"REVERSE_PURCHASE", aggregateId:"M9-PD1", expectedRevision:2,
  idempotencyKey:"M10-PURCHASE-REVERSE-LARGE", deviceId:"PC-A",
});
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-PURCHASE-REVERSE-LARGE", leaseToken:purchaseReverseGoodPrepare.data.leaseToken,
  fingerprint:purchaseReverseGoodPrepare.data.fingerprint, mutations:purchaseReverseMutations,
}).status, "success");

const m10CorrectionMutations = (prefix, evidenceCharacter) => Array.from({ length:4 }, (_, index) => ({
  entityType:"DISPATCH_RECONCILIATION",
  entityId:`${prefix}-${index + 1}`,
  revision:1,
  payload:{
    reconciliationId:`${prefix}-${index + 1}`,
    dispatchId:"M9-D1",
    status:"CORRECTION_DRAFT_CREATED",
    actualValue:{ actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6 },
    reasonCode:"M10_BOUNDED_TXN",
    reasonNote:`${index}:${evidenceCharacter.repeat(16000)}`,
    localOnly:true,
  },
}));
const commitRecoveryMutations = m10CorrectionMutations("M10-RC-COMMIT", "C");
assert.ok(JSON.stringify(commitRecoveryMutations).length > 50000);
const commitRecoveryPrepare = m9("orderq_m9_command_prepare", {
  commandType:"ADJUST_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
  idempotencyKey:"M10-OFFICIAL-COMMIT-RECOVERY", deviceId:"PC-A",
});
const interruptedOfficialCommit = m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-OFFICIAL-COMMIT-RECOVERY", leaseToken:commitRecoveryPrepare.data.leaseToken,
  fingerprint:commitRecoveryPrepare.data.fingerprint, mutations:commitRecoveryMutations,
  testFailureAt:"COMMAND_WRITTEN", testRollbackFailureAt:"BEFORE_ROLLBACK",
});
assert.equal(interruptedOfficialCommit.status, "error");
assert.match(interruptedOfficialCommit.message, /COMMAND_WRITTEN/);
assert.equal(context.orderQM9ReadMigrationTransactions(spreadsheet, ["PREPARED"]).some(row => row.idempotencyKey === "M10-OFFICIAL-COMMIT-RECOVERY"), false);
assert.equal(context.orderQM9ReadOfficialTransactions(spreadsheet, ["PREPARED"]).some(row => row.idempotencyKey === "M10-OFFICIAL-COMMIT-RECOVERY"), true);
const officialCommitRecoveryBlocked = m9("orderq_m9_pull", { afterSequence:0, limit:1 });
assert.equal(officialCommitRecoveryBlocked.status, "error");
assert.match(officialCommitRecoveryBlocked.message, /OFFICIAL_RECOVERY_COMPLETED_RETRY/);
assert.equal(m9("orderq_m9_pull", { afterSequence:0, limit:1 }).status, "success");
const officialCommitCursor = context.orderQM9MetaNumber(spreadsheet, "syncSequence");
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-OFFICIAL-COMMIT-RECOVERY", leaseToken:commitRecoveryPrepare.data.leaseToken,
  fingerprint:commitRecoveryPrepare.data.fingerprint, mutations:commitRecoveryMutations,
}).data.duplicate, true);
assert.equal(context.orderQM9MetaNumber(spreadsheet, "syncSequence"), officialCommitCursor);

const rollbackRecoveryMutations = m10CorrectionMutations("M10-RC-ROLLBACK", "B");
assert.ok(JSON.stringify(rollbackRecoveryMutations).length > 50000);
const rollbackRecoveryPrepare = m9("orderq_m9_command_prepare", {
  commandType:"ADJUST_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
  idempotencyKey:"M10-OFFICIAL-ROLLBACK-RECOVERY", deviceId:"PC-B",
});
const rollbackRecoveryBefore = m9OperationalDigest();
const interruptedOfficialRollback = m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-OFFICIAL-ROLLBACK-RECOVERY", leaseToken:rollbackRecoveryPrepare.data.leaseToken,
  fingerprint:rollbackRecoveryPrepare.data.fingerprint, mutations:rollbackRecoveryMutations,
  testFailureAt:"ENTITIES_WRITTEN", testRollbackFailureAt:"ENTITIES_RESTORED",
});
assert.equal(interruptedOfficialRollback.status, "error");
assert.match(interruptedOfficialRollback.message, /ENTITIES_WRITTEN/);
assert.equal(context.orderQM9ReadOfficialTransactions(spreadsheet, ["RECOVERY_REQUIRED"]).some(row => row.idempotencyKey === "M10-OFFICIAL-ROLLBACK-RECOVERY"), true);
const officialRollbackRecoveryBlocked = m9("orderq_m9_pull", { afterSequence:0, limit:1 });
assert.equal(officialRollbackRecoveryBlocked.status, "error");
assert.match(officialRollbackRecoveryBlocked.message, /OFFICIAL_RECOVERY_COMPLETED_RETRY/);
assert.equal(m9("orderq_m9_pull", { afterSequence:0, limit:1 }).status, "success");
assert.equal(context.orderQM9ReadEntity(spreadsheet, "DISPATCH_RECONCILIATION", "M10-RC-ROLLBACK-1"), null);
assert.equal(m9OperationalDigest(), rollbackRecoveryBefore);
const rollbackRetry = m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-OFFICIAL-ROLLBACK-RECOVERY", leaseToken:rollbackRecoveryPrepare.data.leaseToken,
  fingerprint:rollbackRecoveryPrepare.data.fingerprint, mutations:rollbackRecoveryMutations,
});
assert.equal(rollbackRetry.status, "success");
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-OFFICIAL-ROLLBACK-RECOVERY", leaseToken:rollbackRecoveryPrepare.data.leaseToken,
  fingerprint:rollbackRecoveryPrepare.data.fingerprint,
  mutations:rollbackRecoveryMutations.map((row, index) => index === 0
    ? { ...row, payload:{ ...row.payload, reasonCode:"DIFFERENT" } }
    : row),
}).status, "error");

for (const rollbackFailureAt of ["BEFORE_ROLLBACK", "STATE_RESTORED"]) {
  const suffix = rollbackFailureAt.replaceAll("_", "-");
  const idempotencyKey = `M10-OFFICIAL-ROLLBACK-${suffix}`;
  const mutations = m10CorrectionMutations(`M10-RC-${suffix}`, rollbackFailureAt === "BEFORE_ROLLBACK" ? "E" : "S");
  const prepare = m9("orderq_m9_command_prepare", {
    commandType:"ADJUST_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
    idempotencyKey, deviceId:"PC-A",
  });
  const before = m9OperationalDigest();
  const interrupted = m9("orderq_m9_command_commit", {
    idempotencyKey, leaseToken:prepare.data.leaseToken,
    fingerprint:prepare.data.fingerprint, mutations,
    testFailureAt:"ENTITIES_WRITTEN", testRollbackFailureAt:rollbackFailureAt,
  });
  assert.equal(interrupted.status, "error");
  assert.match(interrupted.message, /ENTITIES_WRITTEN/);
  assert.equal(context.orderQM9ReadOfficialTransactions(spreadsheet, ["PREPARED", "RECOVERY_REQUIRED"])
    .some(row => row.idempotencyKey === idempotencyKey), true);
  const blocked = m9("orderq_m9_pull", { afterSequence:0, limit:1 });
  assert.equal(blocked.status, "error");
  assert.match(blocked.message, /OFFICIAL_RECOVERY_COMPLETED_RETRY/);
  assert.equal(m9("orderq_m9_pull", { afterSequence:0, limit:1 }).status, "success");
  assert.equal(context.orderQM9ReadEntity(spreadsheet, "DISPATCH_RECONCILIATION", `M10-RC-${suffix}-1`), null);
  assert.equal(m9OperationalDigest(), before);
  assert.equal(m9("orderq_m9_command_commit", {
    idempotencyKey, leaseToken:prepare.data.leaseToken,
    fingerprint:prepare.data.fingerprint, mutations,
  }).status, "success");
}

assert.equal(context.orderQM9ReadOfficialTransactions(spreadsheet).some(row => row.idempotencyKey === "M9-G2-OPENING-42"), false);
const m10TxnSheet = spreadsheet.getSheetByName("ORDERQ_M9_TXN_LOG");
const m10TxnMaxCellLength = Math.max(...m10TxnSheet.cells.flat().map(value => String(value ?? "").length));
assert.ok(m10TxnMaxCellLength < 50000, `M10 TXN cell too large: ${m10TxnMaxCellLength}`);
const m10TxnCellMaxForKey = (idempotencyKey) => Math.max(...m10TxnSheet.cells
  .filter(row => String(row?.[1] || "") === idempotencyKey)
  .flat()
  .map(value => String(value ?? "").length));
const m10OfficialTxnEvidence = {
  dispatchConfirm:{ requestLength:JSON.stringify(m9ConfirmMutations).length, maxTxnCell:m10TxnCellMaxForKey("M9-CONFIRM-1") },
  purchaseConfirm:{ requestLength:JSON.stringify(purchaseMutations).length, maxTxnCell:m10TxnCellMaxForKey("M9-PURCHASE") },
  dispatchReversal:{ requestLength:JSON.stringify(goodReverseMutations).length, maxTxnCell:m10TxnCellMaxForKey("M10-REVERSE-LARGE") },
  purchaseReversal:{ requestLength:JSON.stringify(purchaseReverseMutations).length, maxTxnCell:m10TxnCellMaxForKey("M10-PURCHASE-REVERSE-LARGE") },
  correctionCommitRecovery:{ requestLength:JSON.stringify(commitRecoveryMutations).length, maxTxnCell:m10TxnCellMaxForKey("M10-OFFICIAL-COMMIT-RECOVERY") },
  correctionRollbackRecovery:{ requestLength:JSON.stringify(rollbackRecoveryMutations).length, maxTxnCell:m10TxnCellMaxForKey("M10-OFFICIAL-ROLLBACK-RECOVERY") },
  overallMaxTxnCell:m10TxnMaxCellLength,
};
Object.values(m10OfficialTxnEvidence).filter(value => value && typeof value === "object").forEach(value => {
  assert.ok(value.requestLength > 50000);
  assert.ok(value.maxTxnCell < 50000);
});

assert.equal(m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-COMPLETE-D", deviceId:"PC-A", entities:[
    { entityType:"DISPATCH_DECISION", entityId:"M9-DC", revision:1, payload:{ dispatchId:"M9-DC", status:"DRAFT", revision:1, localOnly:true } },
    ...[1, 2].map(index => ({ entityType:"DISPATCH_LINE", entityId:`M9-DLC${index}`, revision:1, payload:{ dispatchLineId:`M9-DLC${index}`, dispatchId:"M9-DC", orderId:"M9-OC", orderItemId:`M9-OIC${index}`, actualProductId:"M9-P1", plannedBaseQuantity:5, localOnly:true } })),
    ...[1, 2].map(index => ({ entityType:"DISPATCH_STOCK_ALLOCATION", entityId:`M9-DAC${index}`, revision:1, payload:{ allocationId:`M9-DAC${index}`, dispatchId:"M9-DC", dispatchLineId:`M9-DLC${index}`, warehouseId:"M9-W1", plannedBaseQuantity:5, localOnly:true } })),
  ],
}).status, "success");
const completeReleasePrepare = m9("orderq_m9_command_prepare", {
  commandType:"RELEASE_DISPATCH", aggregateId:"M9-DC", expectedRevision:1, idempotencyKey:"M9-COMPLETE-REL", deviceId:"PC-A",
});
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-COMPLETE-REL", leaseToken:completeReleasePrepare.data.leaseToken, fingerprint:completeReleasePrepare.data.fingerprint,
  mutations:[
    { entityType:"DISPATCH_DECISION", entityId:"M9-DC", revision:2, payload:{ dispatchId:"M9-DC", status:"RELEASED", revision:2 } },
    ...[1, 2].map(index => ({ entityType:"INVENTORY_RESERVATION", entityId:`M9-IRC${index}`, revision:2, payload:{ reservationId:`M9-IRC${index}`, dispatchId:"M9-DC", allocationId:`M9-DAC${index}`, productId:"M9-P1", warehouseId:"M9-W1", reservedBaseQuantity:5, status:"ACTIVE" } })),
  ],
}).status, "success");
const completeActualPrepare = m9("orderq_m9_command_prepare", {
  commandType:"UPDATE_DISPATCH", aggregateId:"M9-DC", expectedRevision:2, idempotencyKey:"M9-COMPLETE-ACTUAL", deviceId:"PC-A",
});
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-COMPLETE-ACTUAL", leaseToken:completeActualPrepare.data.leaseToken, fingerprint:completeActualPrepare.data.fingerprint,
  mutations:[
    { entityType:"DISPATCH_DECISION", entityId:"M9-DC", revision:3, payload:{ dispatchId:"M9-DC", status:"READY_TO_CONFIRM", revision:3 } },
    ...[1, 2].map(index => ({ entityType:"DISPATCH_LINE", entityId:`M9-DLC${index}`, revision:3, payload:{ dispatchLineId:`M9-DLC${index}`, dispatchId:"M9-DC", orderId:"M9-OC", orderItemId:`M9-OIC${index}`, actualProductId:"M9-P1", actualQuantity:5, actualBaseQuantity:5, recognizedOrderQuantity:5, status:"ACTUAL_RECORDED" } })),
    ...[1, 2].map(index => ({ entityType:"DISPATCH_STOCK_ALLOCATION", entityId:`M9-DAC${index}`, revision:3, payload:{ allocationId:`M9-DAC${index}`, dispatchId:"M9-DC", dispatchLineId:`M9-DLC${index}`, warehouseId:"M9-W1", reservationId:`M9-IRC${index}`, actualBaseQuantity:5, status:"ACTUAL_RECORDED" } })),
  ],
}).status, "success");
const completeConfirmPrepare = m9("orderq_m9_command_prepare", {
  commandType:"CONFIRM_DISPATCH", aggregateId:"M9-DC", expectedRevision:3, idempotencyKey:"M9-COMPLETE-CONFIRM", deviceId:"PC-A",
});
const completeConfirmMutations = [
  { entityType:"DISPATCH_DECISION", entityId:"M9-DC", revision:4, payload:{ dispatchId:"M9-DC", status:"CONFIRMED", revision:4 } },
  ...[1, 2].map(index => ({ entityType:"DISPATCH_LINE", entityId:`M9-DLC${index}`, revision:4, payload:{ dispatchLineId:`M9-DLC${index}`, dispatchId:"M9-DC", orderId:"M9-OC", orderItemId:`M9-OIC${index}`, actualProductId:"M9-P1", actualQuantity:5, actualBaseQuantity:5, recognizedOrderQuantity:5, status:"CONFIRMED" } })),
  ...[1, 2].map(index => ({ entityType:"DISPATCH_STOCK_ALLOCATION", entityId:`M9-DAC${index}`, revision:4, payload:{ allocationId:`M9-DAC${index}`, dispatchId:"M9-DC", dispatchLineId:`M9-DLC${index}`, warehouseId:"M9-W1", reservationId:`M9-IRC${index}`, actualBaseQuantity:5, movementId:`M9-IMC${index}`, status:"CONFIRMED" } })),
  { entityType:"SALES_DOCUMENT", entityId:"M9-SDC", revision:4, payload:{ salesDocumentId:"M9-SDC", dispatchId:"M9-DC", status:"CONFIRMED", erpPostingStatus:"READY", supplyAmountWon:0, vatAmountWon:0, totalAmountWon:0 } },
  ...[1, 2].map(index => ({ entityType:"SALES_LINE", entityId:`M9-SLC${index}`, revision:4, payload:{ salesLineId:`M9-SLC${index}`, salesDocumentId:"M9-SDC", dispatchLineId:`M9-DLC${index}`, orderItemId:`M9-OIC${index}`, productId:"M9-P1", warehouseId:"M9-W1", actualQuantity:5, actualBaseQuantity:5, recognizedOrderQuantity:5, supplyAmountWon:0, vatAmountWon:0, totalAmountWon:0 } })),
  ...[1, 2].map(index => ({ entityType:"INVENTORY_MOVEMENT", entityId:`M9-IMC${index}`, revision:4, payload:{ movementId:`M9-IMC${index}`, dispatchId:"M9-DC", dispatchLineId:`M9-DLC${index}`, sourceLineId:`M9-DAC${index}`, productId:"M9-P1", warehouseId:"M9-W1", movementType:"SALE_ISSUE", signedBaseQuantity:-5 } })),
  ...[1, 2].map(index => ({ entityType:"ORDER_EVENT", entityId:`M9-OEC${index}`, revision:4, payload:{ eventId:`M9-OEC${index}`, orderId:"M9-OC", eventType:"SALES_TRANSFER_ALLOCATED", detail:{ orderItemId:`M9-OIC${index}`, salesLineId:`M9-SLC${index}`, transferredQty:5 } } })),
  ...[1, 2].map(index => ({ entityType:"INVENTORY_RESERVATION", entityId:`M9-IRC${index}`, revision:4, payload:{ reservationId:`M9-IRC${index}`, dispatchId:"M9-DC", allocationId:`M9-DAC${index}`, productId:"M9-P1", warehouseId:"M9-W1", reservedBaseQuantity:5, consumedBaseQuantity:5, status:"CONSUMED" } })),
];
for (const [label, malformed, pattern] of [
  ["missing-dispatch-line", completeConfirmMutations.filter(row => !["M9-DLC2", "M9-SLC2", "M9-OEC2"].includes(row.entityId)), /CONFIRM_LINE_SET_MISMATCH|CONFIRM_LINE_STATE_SET_MISMATCH/],
  ["missing-allocation", completeConfirmMutations.filter(row => row.entityId !== "M9-IMC2"), /CONFIRM_ALLOCATION_MOVEMENT_SET_MISMATCH/],
  ["missing-reservation", completeConfirmMutations.filter(row => row.entityId !== "M9-IRC2"), /CONFIRM_RESERVATION_SET_MISMATCH/],
  ["duplicate-dispatch-line", [...completeConfirmMutations, { ...completeConfirmMutations.find(row => row.entityId === "M9-SLC1"), entityId:"M9-SLC-DUP", payload:{ ...completeConfirmMutations.find(row => row.entityId === "M9-SLC1").payload, salesLineId:"M9-SLC-DUP" } }], /CONFIRM_LINE_SET_MISMATCH/],
  ["duplicate-dispatch-movement", [...completeConfirmMutations, { ...completeConfirmMutations.find(row => row.entityId === "M9-IMC1"), entityId:"M9-IMC-DUP", payload:{ ...completeConfirmMutations.find(row => row.entityId === "M9-IMC1").payload, movementId:"M9-IMC-DUP" } }], /CONFIRM_ALLOCATION_MOVEMENT_SET_MISMATCH/],
  ["duplicate-dispatch-event", [...completeConfirmMutations, { ...completeConfirmMutations.find(row => row.entityId === "M9-OEC1"), entityId:"M9-OEC-DUP", payload:{ ...completeConfirmMutations.find(row => row.entityId === "M9-OEC1").payload, eventId:"M9-OEC-DUP" } }], /CONFIRM_FULFILLMENT_SET_MISMATCH/],
  ["duplicate-dispatch-reservation", [...completeConfirmMutations, { ...completeConfirmMutations.find(row => row.entityId === "M9-IRC1"), entityId:"M9-IRC-DUP", payload:{ ...completeConfirmMutations.find(row => row.entityId === "M9-IRC1").payload, reservationId:"M9-IRC-DUP" } }], /CONFIRM_RESERVATION_SET_MISMATCH/],
  ["duplicate-dispatch-movement-entity-key", completeConfirmMutations.map(row => row.entityId === "M9-IMC2" ? { ...row, entityId:"M9-IMC1", payload:{ ...row.payload, movementId:"M9-IMC1" } } : row), /MUTATION_ENTITY_DUPLICATE:INVENTORY_MOVEMENT:M9-IMC1/],
  ["duplicate-dispatch-event-entity-key", completeConfirmMutations.map(row => row.entityId === "M9-OEC2" ? { ...row, entityId:"M9-OEC1", payload:{ ...row.payload, eventId:"M9-OEC1" } } : row), /MUTATION_ENTITY_DUPLICATE:ORDER_EVENT:M9-OEC1/],
]) {
  const before = m9SpreadsheetDigest();
  const rejected = m9("orderq_m9_command_commit", {
    idempotencyKey:"M9-COMPLETE-CONFIRM", leaseToken:completeConfirmPrepare.data.leaseToken, fingerprint:completeConfirmPrepare.data.fingerprint, mutations:malformed,
  });
  assert.equal(rejected.status, "error", label);
  assert.match(rejected.message, pattern, label);
  assert.equal(m9SpreadsheetDigest(), before, `${label} changed Apps Script state`);
}
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-COMPLETE-CONFIRM", leaseToken:completeConfirmPrepare.data.leaseToken, fingerprint:completeConfirmPrepare.data.fingerprint, mutations:completeConfirmMutations,
}).status, "success");
assert.equal(context.orderQM9ReadAllEntities(spreadsheet).filter(row => row.entityType === "INVENTORY_RESERVATION" && row.payload.dispatchId === "M9-DC" && row.payload.status === "ACTIVE").length, 0);

assert.equal(m9("orderq_m9_migrate", {
  idempotencyKey:"M9-MIGRATE-COMPLETE-P", deviceId:"PC-B", entities:[
    { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PDC", revision:1, payload:{ purchaseDocumentId:"M9-PDC", status:"DRAFT", revision:1, localOnly:true } },
    ...[1, 2].map(index => ({ entityType:"PURCHASE_LINE", entityId:`M9-PLC${index}`, revision:1, payload:{ purchaseLineId:`M9-PLC${index}`, purchaseDocumentId:"M9-PDC", productId:"M9-P1", warehouseId:"M9-W1", quantity:index === 1 ? 5 : 7, baseQuantity:index === 1 ? 5 : 7, amountWon:0, status:"DRAFT", localOnly:true } })),
  ],
}).status, "success");
const completePurchasePrepare = m9("orderq_m9_command_prepare", {
  commandType:"CONFIRM_PURCHASE", aggregateId:"M9-PDC", expectedRevision:1, idempotencyKey:"M9-COMPLETE-PURCHASE", deviceId:"PC-B",
});
const completePurchaseMutations = [
  { entityType:"PURCHASE_DOCUMENT", entityId:"M9-PDC", revision:2, payload:{ purchaseDocumentId:"M9-PDC", status:"CONFIRMED", revision:2, erpPostingStatus:"READY", amountWon:0 } },
  ...[1, 2].map(index => ({ entityType:"PURCHASE_LINE", entityId:`M9-PLC${index}`, revision:2, payload:{ purchaseLineId:`M9-PLC${index}`, purchaseDocumentId:"M9-PDC", productId:"M9-P1", warehouseId:"M9-W1", quantity:index === 1 ? 5 : 7, baseQuantity:index === 1 ? 5 : 7, amountWon:0, movementId:`M9-PIMC${index}`, status:"CONFIRMED" } })),
  ...[1, 2].map(index => ({ entityType:"INVENTORY_MOVEMENT", entityId:`M9-PIMC${index}`, revision:2, payload:{ movementId:`M9-PIMC${index}`, sourceDocumentId:"M9-PDC", sourceLineId:`M9-PLC${index}`, productId:"M9-P1", warehouseId:"M9-W1", movementType:"PURCHASE_RECEIPT", signedBaseQuantity:index === 1 ? 5 : 7 } })),
];
for (const [label, malformed, pattern] of [
  ["missing-purchase-line", completePurchaseMutations.filter(row => !["M9-PLC2", "M9-PIMC2"].includes(row.entityId)), /PURCHASE_LINE_SET_MISMATCH/],
  ["duplicate-purchase-movement", [...completePurchaseMutations, { ...completePurchaseMutations.find(row => row.entityId === "M9-PIMC1"), entityId:"M9-PIMC-DUP", payload:{ ...completePurchaseMutations.find(row => row.entityId === "M9-PIMC1").payload, movementId:"M9-PIMC-DUP" } }], /PURCHASE_RESULT_INVALID|PURCHASE_MOVEMENT_SET_MISMATCH/],
  ["duplicate-purchase-movement-entity-key", completePurchaseMutations.map(row => row.entityId === "M9-PIMC2" ? { ...row, entityId:"M9-PIMC1", payload:{ ...row.payload, movementId:"M9-PIMC1" } } : row), /MUTATION_ENTITY_DUPLICATE:INVENTORY_MOVEMENT:M9-PIMC1/],
]) {
  const before = m9SpreadsheetDigest();
  const rejected = m9("orderq_m9_command_commit", {
    idempotencyKey:"M9-COMPLETE-PURCHASE", leaseToken:completePurchasePrepare.data.leaseToken, fingerprint:completePurchasePrepare.data.fingerprint, mutations:malformed,
  });
  assert.equal(rejected.status, "error", label);
  assert.match(rejected.message, pattern, label);
  assert.equal(m9SpreadsheetDigest(), before, `${label} changed Apps Script state`);
}
assert.equal(m9("orderq_m9_command_commit", {
  idempotencyKey:"M9-COMPLETE-PURCHASE", leaseToken:completePurchasePrepare.data.leaseToken, fingerprint:completePurchasePrepare.data.fingerprint, mutations:completePurchaseMutations,
}).status, "success");
assert.equal(context.orderQM9ReadAllEntities(spreadsheet).filter(row => row.entityType === "PURCHASE_LINE" && row.payload.purchaseDocumentId === "M9-PDC" && row.payload.status === "DRAFT").length, 0);
const m9Pulled = m9("orderq_m9_pull", { afterSequence:m9BeforeFailureCursor, limit:50 });
assert.equal(m9Pulled.status, "success");
assert.ok(m9Pulled.data.changes.some(row => row.entityId === "M9-IM1"));

// M10 cutover is a second, server-owned key. Read/Pull and already committed
// retries remain available, but fresh migration/prepare/commit stop in SHADOW.
properties.set("ONEAPP_ORDERQ_CUTOVER_MODE", "SHADOW");
const shadowPing = m9("orderq_m9_ping", {});
assert.equal(shadowPing.status, "success");
assert.equal(shadowPing.data.cutoverMode, "SHADOW");
assert.equal(m9("orderq_m9_pull", { afterSequence:0, limit:1 }).status, "success");
const shadowDigest = m9SpreadsheetDigest();
const shadowMigration = m9("orderq_m9_migrate", {
  idempotencyKey:"M10-SHADOW-MIGRATION", deviceId:"PC-SHADOW",
  entities:[{ entityType:"PRODUCT", entityId:"M10-SHADOW-P", revision:1, payload:{ productId:"M10-SHADOW-P", localOnly:true } }],
});
assert.equal(shadowMigration.status, "error");
assert.match(shadowMigration.message, /ORDERQ_CUTOVER_CENTRAL_WRITE_BLOCKED:SHADOW:MIGRATION/);
assert.equal(m9SpreadsheetDigest(), shadowDigest);
const shadowPrepare = m9("orderq_m9_command_prepare", {
  commandType:"ADJUST_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
  idempotencyKey:"M10-SHADOW-PREPARE", deviceId:"PC-SHADOW",
});
assert.equal(shadowPrepare.status, "error");
assert.match(shadowPrepare.message, /ORDERQ_CUTOVER_CENTRAL_WRITE_BLOCKED:SHADOW:ADJUST_DISPATCH/);
assert.equal(m9SpreadsheetDigest(), shadowDigest);
const committedRetryInShadow = m9("orderq_m9_command_prepare", {
  commandType:"CONFIRM_DISPATCH", aggregateId:"M9-DC", expectedRevision:3,
  idempotencyKey:"M9-COMPLETE-CONFIRM", deviceId:"PC-A",
});
assert.equal(committedRetryInShadow.status, "success");
assert.equal(committedRetryInShadow.data.committed, true);

properties.set("ONEAPP_ORDERQ_CUTOVER_MODE", "PILOT_WRITE");
const rollbackPrepare = m9("orderq_m9_command_prepare", {
  commandType:"ADJUST_DISPATCH", aggregateId:"M9-D1", expectedRevision:4,
  idempotencyKey:"M10-CENTRAL-ROLLBACK", deviceId:"PC-A",
});
assert.equal(rollbackPrepare.status, "success");
properties.set("ONEAPP_ORDERQ_CUTOVER_MODE", "LEGACY_PRIMARY");
const blockedCommit = m9("orderq_m9_command_commit", {
  idempotencyKey:"M10-CENTRAL-ROLLBACK", leaseToken:rollbackPrepare.data.leaseToken,
  fingerprint:rollbackPrepare.data.fingerprint, mutations:[],
});
assert.equal(blockedCommit.status, "error");
assert.match(blockedCommit.message, /ORDERQ_CUTOVER_CENTRAL_WRITE_BLOCKED:LEGACY_PRIMARY:ADJUST_DISPATCH/);
assert.equal(m9("orderq_m9_command_abort", {
  idempotencyKey:"M10-CENTRAL-ROLLBACK", leaseToken:rollbackPrepare.data.leaseToken, reason:"M10_ROLLBACK",
}).data.aborted, true);
properties.set("ONEAPP_ORDERQ_CUTOVER_MODE", "PILOT_WRITE");

console.log(`ORDER Q Apps Script token/atomicity/recovery tests passed. ${JSON.stringify(m10OfficialTxnEvidence)}`);
