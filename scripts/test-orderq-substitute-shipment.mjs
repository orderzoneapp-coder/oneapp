import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));

const orderMatrix = [
  ["품목코드", "품목명", "규격", "수량", "적요", "적요1", "거래처", "그룹", "담당", "단위", "단가"],
  ["P-A", "원상품", "BOX", 2, "", "", "거래처A", "기본", "김담당", "BOX", 13000],
];
const inventoryMatrix = [
  ["품목코드", "품목명", "규격", "단위", "수량", "1창고", "3서울", "4전송"],
  ["P-A", "원상품", "BOX", "BOX", 1, 1, 0, 0],
  ["P-B", "대체상품", "BOX", "BOX", 10, 10, 0, 0],
];
const parsedOrders = engine.parseOrderWorkbook({
  fileName: "주문.xlsx",
  sheetName: "주문",
  rawMatrix: orderMatrix,
  displayMatrix: orderMatrix,
});
const parsedInventory = engine.parseInventoryWorkbook({
  fileName: "재고.xlsx",
  sheetName: "재고",
  rawMatrix: inventoryMatrix,
  displayMatrix: inventoryMatrix,
});
assert.equal(parsedOrders.errors.length, 0);
assert.equal(parsedInventory.errors.length, 0);

const workspace = engine.analyze(parsedOrders, parsedInventory, { sourceFingerprint: "a".repeat(64) });
const sourceRowNumber = workspace.orders[0].sourceRowNumber;
const beforeSourceMatrix = structuredClone(workspace.sourceFiles.orders.matrix);
const beforeInventory = new Map(engine.getInventoryViewRows(workspace).rows.map((row) => [row.productCode, row]));
assert.equal(beforeInventory.get("P-A").orderQuantity, 2);
assert.equal(beforeInventory.get("P-A").remainingQuantity, -1);
assert.equal(beforeInventory.get("P-B").orderQuantity, 0);

assert.throws(
  () => engine.substituteOrderProduct(workspace, sourceRowNumber, "P-A"),
  /다른 상품/,
  "같은 상품은 대체출고 대상으로 사용할 수 없어야 합니다.",
);
assert.throws(
  () => engine.substituteOrderProduct(workspace, sourceRowNumber, "NOT-FOUND"),
  /상품을 찾지 못했습니다/,
  "없는 상품은 작업본을 변경하지 않아야 합니다.",
);
assert.throws(
  () => engine.substituteOrderProduct(workspace, 99999, "P-B"),
  /주문행을 찾지 못했습니다/,
  "없는 주문행은 작업본을 변경하지 않아야 합니다.",
);
assert.equal(workspace.substitutionHistory.events.length, 0);

const substitution = engine.substituteOrderProduct(workspace, sourceRowNumber, "P-B", {
  actor: "김담당",
  occurredAt: "2026-09-04T01:23:00.000Z",
});
assert.equal(substitution.kind, "SUBSTITUTED");
assert.deepEqual(
  [substitution.customer, substitution.quantity, substitution.unitPrice],
  ["거래처A", 2, 13000],
  "대체출고는 거래처·수량·단가를 유지해야 합니다.",
);
assert.deepEqual(
  [workspace.orders[0].productCode, workspace.orders[0].productName, workspace.orders[0].specification],
  ["P-B", "대체상품", "BOX"],
);
assert.deepEqual(
  workspace.orders[0].substitution.requestedProduct,
  { productCode: "P-A", productName: "원상품", specification: "BOX", unit: "BOX" },
  "원 주문상품 Snapshot을 별도로 보존해야 합니다.",
);
assert.deepEqual(workspace.sourceFiles.orders.matrix, beforeSourceMatrix, "원본 주문 matrix를 덮어쓰면 안 됩니다.");

const afterInventory = new Map(engine.getInventoryViewRows(workspace).rows.map((row) => [row.productCode, row]));
assert.equal(afterInventory.get("P-A").orderQuantity, 0);
assert.equal(afterInventory.get("P-A").remainingQuantity, 1);
assert.equal(afterInventory.get("P-B").orderQuantity, 2);
assert.equal(afterInventory.get("P-B").remainingQuantity, 8);
assert.equal(workspace.stats.totalOrderQuantity, 2);
assert.equal(workspace.stats.totalPurchaseNeed, 0);
assert.match(afterInventory.get("P-A").systemMessage, /\[대체됨\].*거래처A\(2\).*대체상품 BOX/);
assert.match(afterInventory.get("P-B").systemMessage, /\[대체받음\].*거래처A\(2\).*원상품 BOX/);

const recoveryPayload = engine.buildLocalRecoveryPayload(workspace, { activePreview: "inventory" }, {}, "2026-09-04T01:24:00.000Z");
const restoredWorkspace = JSON.parse(JSON.stringify(recoveryPayload.workspace));
assert.equal(restoredWorkspace.substitutionHistory.schemaVersion, engine.SUBSTITUTION_HISTORY_SCHEMA_VERSION);
assert.equal(restoredWorkspace.substitutionHistory.events.length, 1);
assert.match(
  engine.getInventoryViewRows(restoredWorkspace).rows.find((row) => row.productCode === "P-B").systemMessage,
  /대체받음/,
  "JSON round-trip 후에도 시스템 메시지를 재구성해야 합니다.",
);

const undo = engine.undoLastSubstitution(workspace, {
  actor: "김담당",
  occurredAt: "2026-09-04T01:25:00.000Z",
});
assert.equal(undo.kind, "SUBSTITUTION_UNDONE");
assert.equal(workspace.orders[0].productCode, "P-A");
assert.equal(workspace.orders[0].quantity, 2);
assert.equal(workspace.orders[0].unitPrice, 13000);
assert.equal(workspace.orders[0].substitution, undefined);
assert.equal(workspace.substitutionHistory.events.length, 2, "취소는 기존 이력을 삭제하지 않고 새 이벤트를 추가해야 합니다.");
const undoneInventory = new Map(engine.getInventoryViewRows(workspace).rows.map((row) => [row.productCode, row]));
assert.equal(undoneInventory.get("P-A").orderQuantity, 2);
assert.equal(undoneInventory.get("P-A").remainingQuantity, -1);
assert.equal(undoneInventory.get("P-B").orderQuantity, 0);
assert.match(undoneInventory.get("P-A").systemMessage, /\[복원됨\]/);
assert.match(undoneInventory.get("P-B").systemMessage, /\[대체취소\]/);
assert.throws(() => engine.undoLastSubstitution(workspace), /취소할 대체출고 작업이 없습니다/);

for (const relativePath of ["orderops/list.html", "orderops_list.html"]) {
  const html = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  inlineScripts.forEach((match, index) => new vm.Script(match[1], { filename: `${relativePath}:inline-${index + 1}` }));
  for (const contract of [
    'header: "시스템 메시지"',
    'role: "systemMessages"',
    'data-substitute-order-row=',
    'function handleSubstitutionTableClick',
    'engine.substituteOrderProduct(',
    'engine.undoLastSubstitution(',
    '대체출고: 거래처 칩 선택 → Ctrl+상품 클릭',
    'substitution-target-mode',
  ]) {
    assert.ok(html.includes(contract), `${relativePath} 대체출고 UI 계약 누락: ${contract}`);
  }
}

console.log("ORDER Q substitute shipment and system-message tests passed.");
