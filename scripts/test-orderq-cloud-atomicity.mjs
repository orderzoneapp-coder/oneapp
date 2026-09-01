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

function officialCommandPayload({ companyId = "COMPANY-A", documentId = "PD-OFFICIAL-1", commandId = "POST_PURCHASE:OFFICIAL-1", memo = "" } = {}) {
  return {
    schemaVersion: "ONEAPP_ORDERQ_OFFICIAL_COMMAND_PAYLOAD_V1",
    companyId,
    voucherMode: "purchase",
    documentId,
    command: {
      companyId,
      commandId,
      idempotencyKey: commandId,
      commandType: "POST_PURCHASE",
      expectedRevision: 1,
      purchaseDocumentId: documentId,
      occurredAt: "2026-09-01T09:00:00.000Z",
      actor: "TEST",
      document: { companyId, purchaseDocumentId: documentId, memo },
      lines: [{ purchaseLineId: `${documentId}:L1`, quantity: 1 }],
    },
    projectionDigest: "projection-digest",
  };
}

function pushOfficial(change, companyId = "COMPANY-A") {
  return post({
    action: "orderq_official_sync_push",
    token: TOKEN,
    schemaVersion: "ONEAPP_ORDERQ_OFFICIAL_SYNC_V1",
    companyId,
    deviceId: "TEST-PC-A",
    changes: [change],
  });
}

const officialPayload = officialCommandPayload();
const officialCreated = pushOfficial({
  queueId: "QUEUE-OFFICIAL-1",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: officialPayload.command.commandId,
  revision: 2,
  payload: officialPayload,
});
assert.equal(officialCreated.status, "success");
assert.equal(officialCreated.data.results[0].status, "applied");
assert.equal(officialCreated.data.results[0].serverRevision, 2);

const officialQueueRetry = pushOfficial({
  queueId: "QUEUE-OFFICIAL-1",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: officialPayload.command.commandId,
  revision: 2,
  payload: officialPayload,
});
assert.equal(officialQueueRetry.data.results[0].status, "duplicate");

const officialEntityRetry = pushOfficial({
  queueId: "QUEUE-OFFICIAL-1-REINSTALLED",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: officialPayload.command.commandId,
  revision: 2,
  payload: officialPayload,
});
assert.equal(officialEntityRetry.data.results[0].status, "duplicate");

const competingPayload = officialCommandPayload({ commandId: "POST_PURCHASE:OFFICIAL-COMPETING" });
const officialConflict = pushOfficial({
  queueId: "QUEUE-OFFICIAL-CONFLICT",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: competingPayload.command.commandId,
  revision: 2,
  payload: competingPayload,
});
assert.equal(officialConflict.data.results[0].status, "conflict");
assert.equal(officialConflict.data.results[0].serverRevision, 2);
assert.equal(officialConflict.data.results[0].serverPayload.command.commandId, officialPayload.command.commandId);

const longPayload = officialCommandPayload({ documentId: "PD-OFFICIAL-LONG", commandId: "POST_PURCHASE:OFFICIAL-LONG", memo: "가".repeat(85000) });
const longCreated = pushOfficial({
  queueId: "QUEUE-OFFICIAL-LONG",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: longPayload.command.commandId,
  revision: 2,
  payload: longPayload,
});
assert.equal(longCreated.data.results[0].status, "applied");

const resolutionPayload = {
  companyId: "COMPANY-A",
  resolutionId: "RESOLUTION-1",
  unresolvedProductId: "UNRESOLVED-1",
  productId: "PRODUCT-1",
  occurredAt: "2026-09-01T10:00:00.000Z",
  productResolution: { companyId: "COMPANY-A", unresolvedProductId: "UNRESOLVED-1", productId: "PRODUCT-1", status: "MATCHED" },
  resolvedEffects: [],
  inventoryMovements: [],
  resolutionDigest: "resolution-digest",
};
const resolutionCreated = pushOfficial({
  queueId: "QUEUE-RESOLUTION-1",
  entityType: "PENDING_INVENTORY_RESOLUTION",
  entityId: resolutionPayload.resolutionId,
  revision: 1,
  payload: resolutionPayload,
});
assert.equal(resolutionCreated.data.results[0].status, "applied");

const competingResolution = { ...resolutionPayload, resolutionId: "RESOLUTION-2", productId: "PRODUCT-2",
  productResolution: { ...resolutionPayload.productResolution, productId: "PRODUCT-2" } };
const resolutionConflict = pushOfficial({
  queueId: "QUEUE-RESOLUTION-2",
  entityType: "PENDING_INVENTORY_RESOLUTION",
  entityId: competingResolution.resolutionId,
  revision: 1,
  payload: competingResolution,
});
assert.equal(resolutionConflict.data.results[0].status, "conflict");
assert.equal(resolutionConflict.data.results[0].serverPayload.productId, "PRODUCT-1");

const companyAPull = post({
  action: "orderq_official_sync_pull",
  token: TOKEN,
  schemaVersion: "ONEAPP_ORDERQ_OFFICIAL_SYNC_V1",
  companyId: "COMPANY-A",
  deviceId: "TEST-PC-B",
  afterSequence: 0,
  limit: 50,
});
assert.equal(companyAPull.status, "success");
assert.equal(companyAPull.data.changes.length, 3);
assert.equal(companyAPull.data.changes[1].payload.command.document.memo.length, 85000);

const companyBPull = post({
  action: "orderq_official_sync_pull",
  token: TOKEN,
  schemaVersion: "ONEAPP_ORDERQ_OFFICIAL_SYNC_V1",
  companyId: "COMPANY-B",
  deviceId: "TEST-PC-B",
  afterSequence: 0,
  limit: 50,
});
assert.equal(companyBPull.status, "success");
assert.equal(companyBPull.data.changes.length, 0, "company-scoped pull must not expose another company");

const crossCompanyQueueRetry = pushOfficial({
  queueId: "QUEUE-OFFICIAL-1",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: officialPayload.command.commandId,
  revision: 2,
  payload: officialCommandPayload({ companyId: "COMPANY-B" }),
}, "COMPANY-B");
assert.equal(crossCompanyQueueRetry.data.results[0].status, "error", "a queue id cannot be reused across companies");
assert.equal(crossCompanyQueueRetry.data.results[0].message, "ORDERQ_OFFICIAL_QUEUE_COMPANY_MISMATCH");

const companyBSameEntity = pushOfficial({
  queueId: "QUEUE-OFFICIAL-B-1",
  entityType: "OFFICIAL_VOUCHER_COMMAND",
  entityId: officialPayload.command.commandId,
  revision: 2,
  payload: officialCommandPayload({ companyId: "COMPANY-B" }),
}, "COMPANY-B");
assert.equal(companyBSameEntity.data.results[0].status, "applied", "the same raw entity id must remain independent by company");

const companyBAfterOwnWrite = post({
  action: "orderq_official_sync_pull",
  token: TOKEN,
  schemaVersion: "ONEAPP_ORDERQ_OFFICIAL_SYNC_V1",
  companyId: "COMPANY-B",
  deviceId: "TEST-PC-B",
  afterSequence: 0,
  limit: 50,
});
assert.equal(companyBAfterOwnWrite.data.changes.length, 1);
assert.equal(companyBAfterOwnWrite.data.changes[0].payload.companyId, "COMPANY-B");

console.log("ORDER Q Apps Script token/atomicity/recovery tests passed.");
