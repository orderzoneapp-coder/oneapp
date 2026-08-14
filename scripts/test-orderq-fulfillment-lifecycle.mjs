import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRANSFER_EVENT_TYPE,
  TRANSFER_STATUS,
  createAllocationEvent,
  createReversalEvent,
  deriveItemTransfer,
  deriveOrderLifecycle,
  filterOrderBundles,
  aggregateOperationsByProduct
} from '../orderq/order-fulfillment-lifecycle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const order = (id, assigneeId = 'MGR-A', adminStatus = 'CHECKED') => ({
  orderId: id,
  orderNo: `20260814-${id.slice(-1)}`,
  orderStatus: 'ORDER',
  adminStatus,
  assigneeId,
  assigneeName: assigneeId === 'MGR-A' ? '김관리' : '이관리'
});
const item = (orderId, id, code, quantity) => ({
  orderId,
  orderItemId: id,
  itemCode: code,
  itemName: `상품 ${code}`,
  specification: 'BOX',
  finalUnit: 'BOX',
  finalQuantity: quantity,
  matchStatus: 'MATCHED'
});
const allocation = (orderId, orderItemId, sequence, quantity) => createAllocationEvent({
  orderId,
  orderItemId,
  salesDocumentId: `SD-${sequence}`,
  salesLineId: `SL-${sequence}`,
  quantity,
  createdAt: `2026-08-14T0${sequence}:00:00.000Z`
});

const baseOrder = order('ORD-1');
const baseItem = item('ORD-1', 'OI-1', '100100', 10);
const first = allocation('ORD-1', 'OI-1', 1, 4);
const second = allocation('ORD-1', 'OI-1', 2, 3);
const third = allocation('ORD-1', 'OI-1', 3, 3);

assert.equal(deriveItemTransfer(baseOrder, baseItem, [first]).remainingQty, 6);
assert.equal(deriveItemTransfer(baseOrder, baseItem, [first]).transferStatus, TRANSFER_STATUS.PARTIAL);
assert.equal(deriveOrderLifecycle(baseOrder, [baseItem], [first, second, third]).operationStatus, 'CLOSED');
assert.equal(deriveOrderLifecycle(baseOrder, [baseItem], [first, second, third]).transferStatus, TRANSFER_STATUS.TRANSFERRED);

const reversal = createReversalEvent({
  orderId: 'ORD-1', orderItemId: 'OI-1', salesDocumentId: 'SD-2', salesLineId: 'SL-2',
  allocationEventId: second.eventId, idempotencyKey: 'SD-2-CANCEL-1', quantity: 3
});
const reopened = deriveOrderLifecycle(baseOrder, [baseItem], [first, second, third, reversal]);
assert.equal(reopened.remainingQty, 3);
assert.equal(reopened.operationStatus, 'ACTIVE');
assert.equal(reopened.transferStatus, TRANSFER_STATUS.PARTIAL);

const over = allocation('ORD-1', 'OI-1', 4, 2);
const overState = deriveOrderLifecycle(baseOrder, [baseItem], [first, second, third, over]);
assert.equal(overState.remainingQty, -2, '초과이관은 0으로 보정하면 안 된다');
assert.equal(overState.transferStatus, TRANSFER_STATUS.OVER_TRANSFERRED);
assert.equal(overState.operationStatus, 'ACTIVE');

assert.equal(deriveOrderLifecycle(order('ORD-1', 'MGR-A', 'HOLD'), [baseItem], [first, second, third]).operationStatus, 'ACTIVE', '보류 주문은 종결되지 않는다');
assert.equal(createAllocationEvent({ orderId: 'ORD-1', orderItemId: 'OI-1', salesDocumentId: 'SD-1', salesLineId: 'SL-1', quantity: 4 }).eventId, first.eventId, '동일 판매행 이관은 같은 이벤트 ID를 사용한다');
assert.equal(reversal.eventType, TRANSFER_EVENT_TYPE.REVERSED);
assert.throws(() => createReversalEvent({ allocationEventId: second.eventId, orderItemId: 'OI-1', quantity: 1 }), /식별키/);

const orderA = order('ORD-A', 'MGR-A');
const orderB = order('ORD-B', 'MGR-B');
const itemA = item('ORD-A', 'OI-A', '200200', 6);
const itemB = item('ORD-B', 'OI-B', '200200', 9);
const bundles = [
  { order: orderA, items: [itemA], events: [], lifecycle: deriveOrderLifecycle(orderA, [itemA], []) },
  { order: orderB, items: [itemB], events: [], lifecycle: deriveOrderLifecycle(orderB, [itemB], []) }
];
const filtered = filterOrderBundles(bundles, { assigneeId: 'MGR-A', adminStatus: 'CHECKED' });
assert.equal(filtered.length, 1, '담당자·상태는 상품 집계 전에 적용한다');
const aggregate = aggregateOperationsByProduct(filtered, new Map([['200200', 8]]));
assert.equal(aggregate.length, 1);
assert.equal(aggregate[0].orderQty, 6);
assert.equal(aggregate[0].remainingQty, 6);
assert.equal(aggregate[0].availableAfterOrders, 2);
assert.equal(aggregate[0].orderRefs[0].orderId, 'ORD-A');

const operations = read('orderq/operations.html');
const repository = read('orderq/order-operations-repository.js');
const intake = read('orderq/order-intake-engine.js');
const cloud = read('orderq-cloud.gs');
assert.match(operations, /ORDER Q · 출고 운영/);
assert.match(operations, /\.\/\?focus=/, '주문번호는 주문현황 전표로 연결해야 한다');
assert.match(operations, /transferStatusFilter/);
assert.match(operations, /operationStatusFilter/);
assert.match(operations, /assigneeFilter/);
assert.match(repository, /inheritedAssigneeSnapshot/);
assert.match(repository, /STORE\.SALES_DOCUMENTS/);
assert.match(intake, /appendLifecycleTransition/);
assert.match(cloud, /ORDERQ_TRANSFER_EVENT_IMMUTABLE/);
assert.match(cloud, /SALES_TRANSFER_\(ALLOCATED\|REVERSED\)/);

console.log('ORDER Q transfer lifecycle, reversal, over-transfer, closure, assignee filtering, aggregation, and immutable cloud events passed.');
