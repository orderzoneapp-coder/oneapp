import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createShipmentOrderSnapshot, shipmentSnapshotMatches } from '../orderq/shipment-order-read-model.js';

const bundle = {
  order: {
    orderId: 'ORD-1', orderNo: '20260907-001', revision: 3, updatedAt: '2026-09-07T01:02:03.000Z',
    orderDate: '2026-09-07', deliveryExpectedDate: '2026-09-08', customerId: 'CUS-1', customerName: '테스트상사',
    assigneeId: 'MGR-1', assigneeName: '김작업', warehouseId: 'WH-1', warehouseCode: '88', warehouseName: '본창고',
    deliveryRegion: '남부',
    orderStatus: 'ORDER', adminStatus: 'CHECKED', opsStatus: 'ACTIVE', inputChannel: 'SMART_INPUT', sourceDocumentKey: 'DOC-1'
  },
  items: [
    { orderItemId: 'OI-2', lineNo: 2, itemCode: 'B', itemName: '상품B', finalQuantity: 1, finalUnit: 'EA', matchStatus: 'EXCLUDED' },
    { orderItemId: 'OI-1', lineNo: 1, sourceLineKey: 'LINE-1', productId: 'P-1', masterProductId: 'P-1', itemCode: 'A', itemName: '상품A', finalQuantity: 5, cancelledQuantity: 2, finalUnit: 'BOX', matchStatus: 'MATCHED', reviewStatus: 'CONFIRMED' }
  ]
};

const snapshot = createShipmentOrderSnapshot(bundle, { generatedAt: '2026-09-07T02:00:00.000Z' });
assert.equal(snapshot.schemaVersion, 'ONEAPP_ORDERQ_SHIPMENT_CANDIDATE_V1');
assert.equal(snapshot.orderRevision, 3);
assert.equal(snapshot.deliveryRegion, '남부', '원천 배송지역을 출고 후보 Read Model에 보존해야 한다.');
assert.equal(snapshot.lines.length, 1, '제외 행은 출고 후보 Read Model에 포함하지 않는다.');
assert.equal(snapshot.lines[0].orderItemId, 'OI-1');
assert.equal(snapshot.lines[0].sourceLineKey, 'LINE-1');
assert.equal(snapshot.lines[0].shippableQuantity, 3);
assert.equal(snapshot.eligible, true);
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.lines[0]), true);
assert.equal(shipmentSnapshotMatches(snapshot, { expectedRevision: 3, expectedSnapshotHash: snapshot.snapshotHash }), true);
assert.equal(shipmentSnapshotMatches(snapshot, { expectedRevision: 2 }), false);

const changed = createShipmentOrderSnapshot({
  ...bundle,
  order: { ...bundle.order, revision: 4 },
  items: [{ ...bundle.items[1], finalQuantity: 6 }]
}, { generatedAt: '2026-09-07T02:00:00.000Z' });
assert.notEqual(changed.snapshotHash, snapshot.snapshotHash, '주문 Revision/수량 변경은 Snapshot hash를 변경해야 한다.');

const regionChanged = createShipmentOrderSnapshot({
  ...bundle,
  order: { ...bundle.order, deliveryRegion: '북부' },
}, { generatedAt: '2026-09-07T02:00:00.000Z' });
assert.notEqual(regionChanged.snapshotHash, snapshot.snapshotHash, '배송지역 변경은 Snapshot hash에 포함되어야 한다.');
const noRegion = createShipmentOrderSnapshot({
  ...bundle,
  order: { ...bundle.order, deliveryRegion: undefined, region: undefined },
}, { generatedAt: '2026-09-07T02:00:00.000Z' });
assert.equal(noRegion.deliveryRegion, '', '원천 지역이 없으면 추정하지 않고 미지정 값으로 유지해야 한다.');

const adapter = fs.readFileSync(new URL('../orderq/shipment-order-read-adapter.js', import.meta.url), 'utf8');
for (const status of ['READY', 'EMPTY', 'NOT_FOUND', 'STALE', 'ERROR']) assert.match(adapter, new RegExp(`${status}: '${status}'`));
assert.match(adapter, /Math\.min\(200/);
assert.match(adapter, /getOrder\(requestedOrderId\)/);

console.log('ORDER Q shipment candidate immutable read model, provenance, bounded adapter, and stale detection passed.');
