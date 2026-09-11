import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engine = require(join(root, "orderFulfillmentEngine.js"));
const html = readFileSync(join(root, "orderops", "list.html"), "utf8");

const orders = {
  fileName: "synthetic-orders.xlsx",
  fileHash: "a".repeat(64),
  rowCount: 2,
  rows: [
    { sourceRowNumber: 2, productCode: "P-1", productName: "상품 1", customer: "거래처 A", customerCode: "C-1", quantity: 3, sourceUnit: "EA", note: "일반 적요", note1: "직원 적요", manager: "담당 A" },
    { sourceRowNumber: 3, productCode: "P-1", productName: "상품 1", customer: "거래처 A", customerCode: "C-1", quantity: 2, sourceUnit: "EA", note: "일반 적요 2", note1: "직원 적요 2", manager: "담당 A" },
  ],
};
const inventory = {
  fileName: "synthetic-inventory.xlsx",
  fileHash: "b".repeat(64),
  rowCount: 1,
  rows: [{ productCode: "P-1", productName: "상품 1", unit: "EA", inventoryTotal: 12 }],
};

const ordersOnly = engine.createPreviewWorkspace(orders);
assert.equal(ordersOnly.workspaceMode, engine.PREVIEW_WORKSPACE_MODE);
assert.equal(ordersOnly.sourceFingerprint, "a".repeat(64), "orders-first preview must have a recoverable fingerprint");
assert.equal(ordersOnly.orders.length, 2);
assert.equal(ordersOnly.allocations[0].stockTotal, null);
assert.equal(ordersOnly.allocations[0].remainingQuantity, null, "missing inventory must not become zero");
assert.equal(engine.getDeliverySummaryRows(ordersOnly).length, 1);

engine.setOrderValue(ordersOnly, 2, "deliveryNotice", "직원 적요 수정", { recordHistory: true, actor: "synthetic-admin" });
assert.equal(orders.rows[0].note, "일반 적요", "employee and general notes must stay separate");
assert.equal(orders.rows[0].note1, "직원 적요 수정");
assert.equal(ordersOnly.systemHistory.events.length, 1);
engine.setCustomerManager(ordersOnly, engine.customerWorkKey(orders.rows[0]), "담당 B", { recordHistory: true, actor: "synthetic-admin" });
assert.deepEqual(ordersOnly.orders.map((row) => row.manager), ["담당 B", "담당 B"]);

const withInventory = engine.createPreviewWorkspace(orders, inventory, { systemHistory: ordersOnly.systemHistory });
assert.equal(withInventory.allocations[0].stockTotal, 12);
assert.equal(withInventory.allocations[0].remainingQuantity, 7, "remaining quantity must use actual inventory minus total product orders");
assert.equal(withInventory.systemHistory.events.length, 3, "preview history must cross source refreshes");

const inventoryOnly = engine.createPreviewWorkspace(null, inventory);
assert.equal(inventoryOnly.sourceFingerprint, "b".repeat(64), "inventory-only preview must have a recoverable fingerprint");
assert.equal(inventoryOnly.orders.length, 0);
assert.equal(inventoryOnly.inventory.length, 1);
const purchaseOnly = engine.createPreviewWorkspace(null, null, {
  purchases: { fileName: "purchases.xlsx", fileHash: "e".repeat(64), rows: [{ productCode: "P-2", quantity: 4 }] },
});
const salesOnly = engine.createPreviewWorkspace(null, null, {
  sales: { fileName: "sales.xlsx", fileHash: "f".repeat(64), rows: [{ productCode: "P-3", quantity: 2 }] },
});
assert.equal(purchaseOnly.sourceFingerprint, "e".repeat(64));
assert.equal(salesOnly.sourceFingerprint, "f".repeat(64));

const mixedUnitOrders = {
  fileName: "mixed-unit-orders.xlsx",
  fileHash: "c".repeat(64),
  rowCount: 2,
  rows: [
    { sourceRowNumber: 2, productCode: "P-1", productName: "상품 1", customer: "거래처 A", quantity: 10, sourceUnit: "EA" },
    { sourceRowNumber: 3, productCode: "P-1", productName: "상품 1", customer: "거래처 B", quantity: 2, sourceUnit: "BOX" },
  ],
};
const mixedUnits = engine.createPreviewWorkspace(mixedUnitOrders, inventory);
assert.equal(mixedUnits.productSummaries[0].totalOrderQuantity, null, "mixed units must not be added into one product total");
assert.equal(mixedUnits.productSummaries[0].totalOrderQuantityDisplay, "10 EA / 2 BOX");
assert.ok(mixedUnits.allocations.every((row) => row.remainingQuantity === null && row.status === "단위 확인"),
  "mixed units must not calculate a stock balance without a conversion rule");
assert.equal(mixedUnits.stats.mixedUnitProductCount, 1);
const analyzedMixedUnits = engine.analyze(
  { ...mixedUnitOrders, missingColumns: [], errors: [], warnings: [] },
  {
    ...inventory, missingColumns: [], errors: [], warnings: [], duplicateCodes: [],
    rows: [{ ...inventory.rows[0], wholeStockRaw: 20, wholeStockAvailable: 20, seoulFirstPurchaseRaw: 0, firstTransferRaw: 0, seoulFirstPurchaseRemaining: 0 }],
  },
  { sourceFingerprint: "d".repeat(64) },
);
assert.ok(analyzedMixedUnits.allocations.every((row) =>
  row.status === "단위 확인" && row.wholeAllocation === 0 && row.seoulAllocation === 0 && row.purchaseNeed === null));
assert.equal(analyzedMixedUnits.productSummaries[0].totalOrderQuantity, null);
assert.equal(analyzedMixedUnits.stats.mixedUnitProductCount, 1);

for (const contract of [
  "normalizeOrderOpsWorkspaceDom",
  'outerWorkspace.append(leftPane, resultsPanel, rightPane)',
  'workspaceMode === engine.PREVIEW_WORKSPACE_MODE',
  '"거래처", "상품", "주문수량", "직원 적요"',
  'hasInventory ? ["재고", "잔량"]',
  "orderops-header-primary",
  'id="deliveryWarehouseFilter"',
  '<th>거래처</th><th>수량</th><th>금액</th><th>적요</th>',
  "data-delivery-manager-filter",
  "restorePreviewInputState",
  "localStorage.setItem(INVENTORY_INSPECTOR_OPEN_KEY",
]) {
  assert.ok(html.includes(contract), `OrderOps three-section contract missing: ${contract}`);
}

console.log("PASS OrderOps analysis-ready preview: orders-first rendering data, real-inventory-only balances, note separation, manager linkage, and history preservation.");
