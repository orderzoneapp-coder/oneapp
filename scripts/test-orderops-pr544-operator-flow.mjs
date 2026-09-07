import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  orderQCandidateMatches,
  reconcileShipmentDraft,
  shipmentDraftQuantity,
} from '../orderops/orderq-order-source-adapter.js';
import {
  buildShipmentResult,
  deriveShipmentProgress,
  netShippedByItem,
} from '../orderops/shipment-result-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const previousSnapshot = {
  orderId: 'ORD-544',
  orderRevision: 1,
  candidateLines: [
    { orderItemId: 'OI-1', sourceLineKey: 'SOURCE-1', shippableQuantity: 10 },
    { orderItemId: 'OI-2', sourceLineKey: 'SOURCE-2', shippableQuantity: 3 },
    { orderItemId: 'OI-DELETED', sourceLineKey: 'SOURCE-DELETED', shippableQuantity: 1 },
  ],
};
const nextSnapshot = {
  orderId: 'ORD-544',
  orderRevision: 2,
  candidateLines: [
    { orderItemId: 'OI-1', sourceLineKey: 'SOURCE-1', shippableQuantity: 8 },
    { orderItemId: 'OI-2-REBUILT', sourceLineKey: 'SOURCE-2', shippableQuantity: 3 },
    { orderItemId: 'OI-ADDED', sourceLineKey: 'SOURCE-ADDED', shippableQuantity: 4 },
  ],
};
const reconciled = reconcileShipmentDraft(previousSnapshot, nextSnapshot, {
  'OI-1': { shippedQuantity: '6', reason: '부분 출고' },
  'OI-2': { shippedQuantity: '2', reason: '재고 부족' },
  'OI-DELETED': { shippedQuantity: '1', reason: '' },
});
assert.deepEqual(reconciled.draft['OI-1'], { shippedQuantity: '6', reason: '부분 출고' });
assert.deepEqual(reconciled.draft['OI-2-REBUILT'], { shippedQuantity: '2', reason: '재고 부족' });
assert.equal(reconciled.draft['OI-ADDED'], undefined, '새 주문행은 과거 입력을 임의 상속하면 안 된다.');
assert.deepEqual(reconciled.removedOrderItemIds, ['OI-DELETED']);
assert.deepEqual(reconciled.addedOrderItemIds, ['OI-ADDED']);

const ambiguous = reconcileShipmentDraft(
  { orderId: 'ORD-544', candidateLines: [
    { orderItemId: 'OLD-A', sourceLineKey: 'DUP' },
    { orderItemId: 'OLD-B', sourceLineKey: 'DUP' },
  ] },
  { orderId: 'ORD-544', candidateLines: [{ orderItemId: 'NEW-A', sourceLineKey: 'DUP' }] },
  { 'OLD-A': { shippedQuantity: '1', reason: 'A' }, 'OLD-B': { shippedQuantity: '2', reason: 'B' } },
);
assert.equal(ambiguous.draft['NEW-A'], undefined, '중복 sourceLineKey는 안전하지 않으므로 자동 매칭하면 안 된다.');

assert.equal(shipmentDraftQuantity({ shippableQuantity: 10 }, 0, undefined), '10');
assert.equal(shipmentDraftQuantity({ shippableQuantity: 10 }, 6, undefined), '4');
assert.equal(shipmentDraftQuantity({ shippableQuantity: 10 }, 0, { shippedQuantity: '6' }), '6');
assert.equal(orderQCandidateMatches({ orderNo: '20260908-001', customerName: '테스트상사', warehouseName: '본창고' }, '테스트 본창고'), true);
assert.equal(orderQCandidateMatches({ orderNo: '20260908-001', customerName: '테스트상사', warehouseName: '본창고' }, '없는주문'), false);

const shipmentSnapshot = {
  orderId: 'ORD-544', orderNo: '20260908-001', orderRevision: 1, snapshotHash: 'HASH-1',
  orderUpdatedAt: '2026-09-08T00:00:00.000Z', eligible: true,
  customerId: 'CUS-1', customerName: '테스트상사', assigneeId: 'EMP-1', assigneeName: '작업자',
  warehouseId: 'WH-1', warehouseCode: '88', warehouseName: '본창고',
  candidateLines: [{
    orderItemId: 'OI-1', sourceLineKey: 'SOURCE-1', lineNo: 1,
    itemCode: 'P-1', itemName: '상품', specification: 'BOX', unit: 'BOX',
    orderedQuantity: 10, shippableQuantity: 10,
  }],
};
const partial = buildShipmentResult({
  commandId: 'PR544-PARTIAL-6', snapshot: shipmentSnapshot,
  workspace: { orders: [{ orderItemId: 'OI-1', productCode: 'P-1', productName: '상품', sourceUnit: 'BOX' }] },
  lineInputs: [{ orderItemId: 'OI-1', shippedQuantity: 6, reason: '부분 출고' }],
  actor: '작업자', occurredAt: '2026-09-08T01:00:00.000Z',
});
assert.equal(partial.lines[0].orderedQuantity, 10);
assert.equal(partial.lines[0].shippedQuantity, 6);
assert.equal(partial.lines[0].remainingQuantity, 4);
const net = netShippedByItem([partial]);
assert.equal(deriveShipmentProgress({ bundles: [partial], currentSnapshot: shipmentSnapshot, netByOrderItem: net }), 'PARTIAL');

const orderQHtml = read('orderq/index.html');
assert.match(orderQHtml, /<details class="operations-tools"/);
assert.match(orderQHtml, /<summary class="btn dark">운영 도구<\/summary>/);

const orderOpsHtml = read('orderops/list.html');
for (const contract of [
  'id="orderQSourcePicker"',
  'id="orderQCandidateSearch"',
  'id="orderQCandidateSelect"',
  'id="orderQCandidateLoadButton"',
  'id="shipmentApplyLatestButton"',
  'id="shipmentKeepWorkButton"',
  '주문수량',
  '이번 실제 출고수량',
  'data-shipment-draft-line',
]) assert.ok(orderOpsHtml.includes(contract), `PR #544 후속 작업자 흐름 계약 누락: ${contract}`);
assert.match(orderOpsHtml, /listOrderQOrderSources/);
assert.match(orderOpsHtml, /reconcileShipmentDraft/);
assert.match(orderOpsHtml, /SHIPMENT_ORDER_REVISION_CONFLICT[\s\S]*shipmentSourceChanged/);

console.log('PR #544 operator picker, quantity-axis handoff, partial shipment, and safe latest-order recovery contracts passed.');
