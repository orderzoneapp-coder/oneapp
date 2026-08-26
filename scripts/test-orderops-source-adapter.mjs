import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../orderops/orderops-source-adapter.js");
const engine = require("../orderFulfillmentEngine.js");

function snapshotHash(basisDate, rows) {
  const canonicalJson = JSON.stringify({
    schemaVersion: adapter.DATAOPS_SNAPSHOT_SCHEMA,
    basisDate,
    columns: adapter.DATAOPS_SNAPSHOT_COLUMNS,
    rows,
  });
  return crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

const basisDate = "2026-08-23";
const snapshotRows = [
  ["EA", "000100", "테스트 사과", "1kg", 3, "", "", 1000, "", "", ""],
  ["EA", "000100", "테스트 사과", "1kg", -1, "", "", 1100, "", "", ""],
  ["BOX", "000200", "테스트 배", "5kg", 0, "", "", 2000, "", "", 0],
];
const snapshot = {
  schemaVersion: adapter.DATAOPS_SNAPSHOT_SCHEMA,
  revision: 7,
  basisDate,
  savedAt: "2026-08-23T02:00:00.000Z",
  columns: [...adapter.DATAOPS_SNAPSHOT_COLUMNS],
  rows: snapshotRows,
  rowCount: snapshotRows.length,
  cellCount: snapshotRows.length * adapter.DATAOPS_SNAPSHOT_COLUMNS.length,
  hash: snapshotHash(basisDate, snapshotRows),
};

const validated = await adapter.validateDataOpsSnapshot(snapshot, { cryptoImpl: crypto.webcrypto });
assert.equal(validated.hash, snapshot.hash, "the verified DataOps hash must be retained");

const inventoryParsed = adapter.buildDataOpsInventoryParsed(validated, engine);
assert.equal(inventoryParsed.rowCount, 2, "DataOps LOT rows must become one shipping row per product code");
assert.equal(inventoryParsed.rows.find(row => row.productCode === "000100").inventoryTotal, 2,
  "DataOps signed LOT quantities must be summed without clipping");
assert.equal(inventoryParsed.rows.find(row => row.productCode === "000200").inventoryTotal, 0,
  "DataOps numeric zero stock must remain zero");
assert.equal(inventoryParsed.dataSource.revision, 7, "DataOps source revision must be retained");
assert.match(inventoryParsed.sourceLabel, /DataOps 확정재고 · 7 · 2행/);
assert.ok(inventoryParsed.warnings.some(warning => warning.code === "DATAOPS_LOT_ROWS_AGGREGATED"),
  "LOT aggregation must remain visible as source evidence");

await assert.rejects(
  adapter.validateDataOpsSnapshot({ ...snapshot, hash: "0".repeat(64) }, { cryptoImpl: crypto.webcrypto }),
  /hash 검산/,
  "a tampered DataOps snapshot must be rejected",
);

let readRequest = null;
const readCredential = { token: "READ-ONLY", actorId: "ADMIN", deviceId: "TEST", environment: "TEST", scope: { companyId: "ONEAPP" } };
const fetched = await adapter.fetchLatestDataOpsSnapshot("https://example.com/exec", {
  cryptoImpl: crypto.webcrypto,
  readCredential,
  securityClient: { released: () => true, ready: () => false, getSnapshot: async request => { readRequest = request; return snapshot; } },
});
assert.equal(readRequest.readCredential.token, "READ-ONLY", "DataOps read must use the dedicated ephemeral READ credential");
assert.equal(readRequest.readCredential.scope.companyId, "ONEAPP");
assert.equal(fetched.revision, 7);
let prereleaseNetwork = 0;
await assert.rejects(() => adapter.fetchLatestDataOpsSnapshot("https://example.com/exec", {
  cryptoImpl: crypto.webcrypto,
  securityClient: { released: () => false, getSnapshot: async () => { prereleaseNetwork += 1; } },
}), /DATAOPS_V1_SECURITY_NOT_RELEASED/);
assert.equal(prereleaseNetwork, 0, "unreleased authenticated transport must not fall back to anonymous network");

const smartOrders = [
  {
    orderId: "ORD-SMART-1",
    orderNo: "20260823-001",
    revision: 2,
    orderDate: "2026-08-23",
    customerName: "테스트 거래처",
    customerSnapshot: { group1Name: "온라인" },
    warehouseCode: "01",
    warehouseName: "1창고",
    assigneeName: "김담당",
    orderMessage: "오전 배송",
    sourceType: "SMART_INPUT",
    inputChannel: "SMART_INPUT",
    orderStatus: "ORDER",
    createdAt: "2026-08-23T01:00:00.000Z",
    updatedAt: "2026-08-23T01:10:00.000Z",
  },
  {
    orderId: "ORD-SMART-DONE",
    orderNo: "20260823-002",
    revision: 1,
    orderDate: "2026-08-23",
    customerName: "완료 거래처",
    sourceType: "SMART_INPUT",
    inputChannel: "SMART_INPUT",
    orderStatus: "COMPLETED",
  },
  {
    orderId: "ORD-MANUAL",
    orderNo: "20260823-003",
    revision: 1,
    orderDate: "2026-08-23",
    customerName: "수기 거래처",
    sourceType: "MANUAL",
    inputChannel: "DIRECT",
    orderStatus: "ORDER",
  },
];
const smartItems = [
  {
    orderItemId: "OI-1",
    orderId: "ORD-SMART-1",
    lineNo: 1,
    itemCode: "000100",
    itemName: "테스트 사과",
    specification: "1kg",
    finalQuantity: 4,
    finalUnit: "EA",
    price: 1500,
    supplyAmount: 6000,
    memo: "선별",
    matchStatus: "MATCHED",
  },
  {
    orderItemId: "OI-CANCELLED",
    orderId: "ORD-SMART-1",
    lineNo: 2,
    itemCode: "000200",
    itemName: "취소 상품",
    finalQuantity: 1,
    matchStatus: "CANCELLED",
  },
  {
    orderItemId: "OI-DONE",
    orderId: "ORD-SMART-DONE",
    lineNo: 1,
    itemCode: "000300",
    itemName: "완료 상품",
    finalQuantity: 2,
    matchStatus: "MATCHED",
  },
];

const orderParsed = await adapter.buildSmartInputOrdersParsed(
  { orders: smartOrders, items: smartItems },
  engine,
  { cryptoImpl: crypto.webcrypto },
);
assert.equal(orderParsed.rowCount, 1, "only active SmartInput order items must enter shipping analysis");
assert.equal(orderParsed.rows[0].productCode, "000100");
assert.equal(orderParsed.rows[0].quantity, 4);
assert.equal(orderParsed.rows[0].warehouse, "1창고");
assert.equal(orderParsed.rows[0].customer, "테스트 거래처");
assert.equal(orderParsed.rows[0].basisDate, basisDate, "the SmartInput order date must remain the shipping basis date");
assert.equal(orderParsed.dataSource.orderCount, 1);
assert.equal(orderParsed.dataSource.excludedCompletedOrCancelledCount, 1,
  "completed SmartInput orders must not be reintroduced into shipping work");

const loaded = await adapter.loadSmartInputOrders(engine, {
  cryptoImpl: crypto.webcrypto,
  importModule: async () => ({
    STORE: { ORDERS: "orders", ORDER_ITEMS: "orderItems" },
    getAll: async store => store === "orders" ? smartOrders : smartItems,
  }),
});
assert.equal(loaded.fileHash, orderParsed.fileHash, "ledger reads must produce a stable source fingerprint");

await assert.rejects(
  adapter.buildSmartInputOrdersParsed({ orders: [], items: [] }, engine, { cryptoImpl: crypto.webcrypto }),
  /스마트입력으로 저장된 주문이 없습니다/,
);

console.log("ORDER Q DataOps/SmartInput source adapter: PASS");
