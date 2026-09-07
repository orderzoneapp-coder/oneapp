import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createShipmentOrderSnapshot } from '../orderq/shipment-order-read-model.js';
import { mapOrderQSnapshotToParsedOrders } from '../orderops/orderq-order-source-adapter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const engine = require(path.join(root, 'orderFulfillmentEngine.js'));

const snapshot = createShipmentOrderSnapshot({
  order: {
    orderId: 'ORD-Q-1', orderNo: '20260907-001', revision: 7, updatedAt: '2026-09-07T01:00:00.000Z',
    orderDate: '2026-09-07', customerId: 'CUS-1', customerName: '테스트상사', assigneeName: '김작업',
    warehouseId: 'WH-1', warehouseCode: '88', warehouseName: '본창고', orderStatus: 'ORDER', adminStatus: 'CHECKED', opsStatus: 'ACTIVE'
  },
  items: [{
    orderItemId: 'OI-Q-1', sourceLineKey: 'SOURCE-LINE-1', lineNo: 1, productId: 'P-A', masterProductId: 'P-A',
    itemCode: 'P-A', itemName: '원상품', specification: 'BOX', finalQuantity: 2, finalUnit: 'BOX', price: 13000,
    supplyAmount: 26000, matchStatus: 'MATCHED', reviewStatus: 'CONFIRMED'
  }]
}, { generatedAt: '2026-09-07T01:01:00.000Z' });

const parsedOrders = mapOrderQSnapshotToParsedOrders(snapshot);
assert.equal(parsedOrders.sourceKind, 'ORDERQ_READ_MODEL');
assert.equal(parsedOrders.sourceMatrix.length, 0, 'ORDER Q 연결은 가짜 Excel matrix를 만들지 않는다.');
assert.equal(parsedOrders.rows[0].orderId, 'ORD-Q-1');
assert.equal(parsedOrders.rows[0].orderRevision, 7);
assert.equal(parsedOrders.rows[0].orderItemId, 'OI-Q-1');
assert.equal(parsedOrders.rows[0].sourceLineKey, 'SOURCE-LINE-1');

const inventoryMatrix = [
  ['품목코드', '품목명', '규격', '단위', '수량', '1창고', '3서울', '4전송'],
  ['P-A', '원상품', 'BOX', 'BOX', 2, 2, 0, 0],
  ['P-B', '대체상품', 'BOX', 'BOX', 10, 10, 0, 0]
];
const parsedInventory = engine.parseInventoryWorkbook({ fileName: '재고.xlsx', sheetName: '재고', rawMatrix: inventoryMatrix, displayMatrix: inventoryMatrix });
assert.equal(engine.validateInputs(parsedOrders, parsedInventory).canAnalyze, true, 'ORDER Q 주문에도 창고재고 Excel 검증이 필요하다.');
const workspace = engine.analyze(parsedOrders, parsedInventory, { sourceFingerprint: snapshot.snapshotHash });
assert.equal(workspace.sourceFiles.orders.sourceKind, 'ORDERQ_READ_MODEL');
assert.equal(workspace.sourceFiles.orders.orderId, 'ORD-Q-1');
assert.equal(workspace.sourceFiles.orders.orderRevision, 7);
assert.equal(workspace.sourceFiles.orders.orderSnapshotHash, snapshot.snapshotHash);
assert.equal(workspace.orders[0].orderItemId, 'OI-Q-1');

const event = engine.substituteOrderProduct(workspace, workspace.orders[0].sourceRowNumber, 'P-B', { actor: '김작업', occurredAt: '2026-09-07T02:00:00.000Z' });
assert.equal(event.orderId, 'ORD-Q-1');
assert.equal(event.orderRevision, 7);
assert.equal(event.orderItemId, 'OI-Q-1');
assert.equal(workspace.sourceFiles.orders.orderSnapshotHash, snapshot.snapshotHash, '재분석 후에도 동결 주문 식별정보를 보존한다.');

for (const relative of ['orderops/list.html', 'orderops_list.html']) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\("orderId"\)/);
  assert.match(html, /loadOrderQOrderSource/);
  assert.match(html, /창고재고 Excel은 계속 필요합니다/);
  assert.match(html, /id="ordersFileButton"/, '주문현황 Excel 수동 대체 경로는 유지한다.');
  assert.match(html, /id="inventoryFileButton"/, '창고재고 Excel 입력은 유지한다.');
}

console.log('OrderOps ORDER Q Read Model intake, Excel inventory requirement, fallback, lineage, and substitution preservation passed.');
