import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShipmentOrderSnapshot } from '../orderq/shipment-order-read-model.js';
import { mapOrderQSnapshotToParsedOrders, orderQCandidateMatches } from '../orderops/orderq-order-source-adapter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const snapshot = createShipmentOrderSnapshot({
  order: {
    orderId: 'ORD-Q-1', orderNo: '20260907-001', revision: 7, updatedAt: '2026-09-07T01:00:00.000Z',
    orderDate: '2026-09-07', customerId: 'CUS-1', customerName: '테스트상사', assigneeName: '김작업',
    warehouseId: 'WH-1', warehouseCode: '88', warehouseName: '본창고', deliveryRegion: '남부', orderStatus: 'ORDER', adminStatus: 'CHECKED', opsStatus: 'ACTIVE'
  },
  items: [{
    orderItemId: 'OI-Q-1', sourceLineKey: 'SOURCE-LINE-1', lineNo: 1, productId: 'P-A', masterProductId: 'P-A',
    itemCode: 'P-A', itemName: '원상품', specification: 'BOX', finalQuantity: 2, finalUnit: 'BOX', price: 13000,
    supplyAmount: 26000, memo: '일반 적요', description: '직원 전달사항', matchStatus: 'MATCHED', reviewStatus: 'CONFIRMED'
  }]
}, { generatedAt: '2026-09-07T01:01:00.000Z' });

const parsedOrders = mapOrderQSnapshotToParsedOrders(snapshot);
assert.equal(parsedOrders.sourceKind, 'ORDERQ_READ_MODEL');
assert.equal(parsedOrders.sourceMatrix.length, 0, 'ORDER Q 연결은 가짜 Excel matrix를 만들지 않는다.');
assert.equal(parsedOrders.rows[0].orderId, 'ORD-Q-1');
assert.equal(parsedOrders.rows[0].orderRevision, 7);
assert.equal(parsedOrders.rows[0].orderItemId, 'OI-Q-1');
assert.equal(parsedOrders.rows[0].sourceLineKey, 'SOURCE-LINE-1');
assert.equal(parsedOrders.rows[0].region, '남부');
assert.equal(parsedOrders.rows[0].note, '일반 적요');
assert.equal(parsedOrders.rows[0].note1, '직원 전달사항', 'ORDER Q description은 적요(직원) 경로로 분리해야 한다.');
assert.equal(orderQCandidateMatches(snapshot, '남부'), true, '저장 주문 검색에서 배송지역을 찾을 수 있어야 한다.');

// Keep the dormant source adapter and immutable ORDER Q model tested without
// requiring the removed a596cbbd-after direct-order intake in the UI/engine.
for (const relative of ['orderops/list.html', 'orderops_list.html']) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.doesNotMatch(html, /loadOrderQOrderSource/);
  assert.match(html, /id="ordersFileButton"/, 'manual order Excel intake remains available');
  assert.match(html, /id="inventoryFileButton"/, 'manual inventory Excel intake remains available');
}

console.log('Retained ORDER Q source adapter mapping and restored Excel-only intake contracts passed.');
