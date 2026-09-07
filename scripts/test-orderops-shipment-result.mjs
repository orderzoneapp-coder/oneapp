import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createShipmentOrderSnapshot } from '../orderq/shipment-order-read-model.js';
import {
  buildShipmentResult,
  buildShipmentReversal,
  deriveShipmentProgress,
  netShippedByItem,
  SHIPMENT_PROGRESS_STATUS,
  SHIPMENT_STATUS
} from '../orderops/shipment-result-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = createShipmentOrderSnapshot({
  order: {
    orderId: 'ORD-1', orderNo: '20260907-001', revision: 4, updatedAt: '2026-09-07T01:00:00.000Z',
    orderDate: '2026-09-07', customerId: 'CUS-1', customerName: '작업상사', assigneeName: '김작업',
    warehouseId: 'WH-1', warehouseCode: '88', warehouseName: '본창고', orderStatus: 'ORDER', adminStatus: 'CHECKED', opsStatus: 'ACTIVE'
  },
  items: [{ orderItemId: 'OI-1', sourceLineKey: 'LINE-1', lineNo: 1, productId: 'P-A', itemCode: 'P-A', itemName: '원상품', specification: 'BOX', finalQuantity: 5, finalUnit: 'BOX', matchStatus: 'MATCHED' }]
}, { generatedAt: '2026-09-07T01:01:00.000Z' });
const workspace = { orders: [{ orderId: 'ORD-1', orderRevision: 4, orderItemId: 'OI-1', productCode: 'P-B', productName: '대체상품', specification: 'BOX', sourceUnit: 'BOX', substitution: { latestEventId: 'SUB-1', actualProduct: { productCode: 'P-B', productName: '대체상품', specification: 'BOX', unit: 'BOX' } } }] };

assert.throws(() => buildShipmentResult({ commandId: 'PARTIAL-NO-REASON', snapshot, workspace, lineInputs: [{ orderItemId: 'OI-1', shippedQuantity: 2 }] }), /부분출고 사유/);
const first = buildShipmentResult({
  commandId: 'CONFIRM-1', snapshot, workspace, actor: '김작업', occurredAt: '2026-09-07T02:00:00.000Z',
  lineInputs: [{ orderItemId: 'OI-1', shippedQuantity: 2, reason: '재고 일부 확보' }]
});
assert.equal(first.document.status, SHIPMENT_STATUS.CONFIRMED);
assert.equal(first.document.orderRevision, 4);
assert.equal(first.document.orderSnapshotHash, snapshot.snapshotHash);
assert.equal(first.lines[0].orderItemId, 'OI-1');
assert.equal(first.lines[0].sourceLineKey, 'LINE-1');
assert.equal(first.lines[0].requestedProduct.itemCode, 'P-A');
assert.equal(first.lines[0].actualProduct.itemCode, 'P-B');
assert.equal(first.lines[0].substitutionEventId, 'SUB-1');
assert.equal(first.lines[0].remainingQuantity, 3);

const retry = buildShipmentResult({
  commandId: 'CONFIRM-1', snapshot, workspace, actor: '김작업', occurredAt: '2026-09-07T03:00:00.000Z',
  lineInputs: [{ orderItemId: 'OI-1', shippedQuantity: 2, reason: '재고 일부 확보' }]
});
assert.equal(retry.receipt.payloadHash, first.receipt.payloadHash, '재시도 시각과 무관하게 같은 명령은 같은 멱등 hash여야 한다.');
assert.throws(() => buildShipmentResult({
  commandId: 'CONFIRM-2', snapshot, workspace, existingBundles: [first],
  lineInputs: [{ orderItemId: 'OI-1', shippedQuantity: 4 }]
}), /초과/);
const second = buildShipmentResult({
  commandId: 'CONFIRM-2', snapshot, workspace, existingBundles: [first], occurredAt: '2026-09-07T03:00:00.000Z',
  lineInputs: [{ orderItemId: 'OI-1', shippedQuantity: 3 }]
});
assert.equal(netShippedByItem([first, second]).get('OI-1'), 5);
assert.throws(() => buildShipmentResult({ commandId: 'HOLD-1', snapshot, intent: SHIPMENT_STATUS.HOLD }), /보류 사유/);
const hold = buildShipmentResult({ commandId: 'HOLD-1', snapshot, intent: SHIPMENT_STATUS.HOLD, holdReason: '주소 확인' });
assert.equal(hold.document.status, SHIPMENT_STATUS.HOLD);
assert.equal(netShippedByItem([hold]).get('OI-1'), 0);

const reversal = buildShipmentReversal({ commandId: 'REVERSE-1', originalBundle: first, actor: '김작업', reason: '주문 변경', occurredAt: '2026-09-07T04:00:00.000Z' });
assert.equal(reversal.document.status, SHIPMENT_STATUS.REVERSED);
assert.equal(reversal.document.reversesShipmentDocumentId, first.document.shipmentDocumentId);
assert.equal(netShippedByItem([first, reversal]).get('OI-1'), 0);
assert.equal(deriveShipmentProgress({ bundles: [], currentSnapshot: snapshot, netByOrderItem: new Map() }), SHIPMENT_PROGRESS_STATUS.WAITING);
assert.equal(deriveShipmentProgress({ bundles: [hold], currentSnapshot: snapshot, netByOrderItem: netShippedByItem([hold]) }), SHIPMENT_PROGRESS_STATUS.HOLD);
assert.equal(deriveShipmentProgress({ bundles: [first], currentSnapshot: snapshot, netByOrderItem: netShippedByItem([first]) }), SHIPMENT_PROGRESS_STATUS.PARTIAL);
assert.equal(deriveShipmentProgress({ bundles: [first, second], currentSnapshot: snapshot, netByOrderItem: netShippedByItem([first, second]) }), SHIPMENT_PROGRESS_STATUS.COMPLETED);
assert.equal(deriveShipmentProgress({ bundles: [first, reversal], currentSnapshot: snapshot, netByOrderItem: netShippedByItem([first, reversal]) }), SHIPMENT_PROGRESS_STATUS.REVERSED);
assert.equal(deriveShipmentProgress({ bundles: [first], currentSnapshot: snapshot, reviewRequired: true, netByOrderItem: netShippedByItem([first]) }), SHIPMENT_PROGRESS_STATUS.REVIEW_REQUIRED);

const repository = fs.readFileSync(path.join(root, 'orderops/shipment-result-repository.js'), 'utf8');
assert.match(repository, /ONEAPPShippingResultDB/);
for (const store of ['shipmentDocuments', 'shipmentLines', 'shipmentEvents', 'shipmentCommandReceipts']) assert.match(repository, new RegExp(store));
assert.doesNotMatch(repository, /oneapp-orderq-pre-m1-v6|openOrderQDb/, '출고결과 Repository는 ORDER Q 저장소를 직접 열면 안 된다.');
const commandAdapter = fs.readFileSync(path.join(root, 'orderops/shipment-result-command-adapter.js'), 'utf8');
assert.match(commandAdapter, /await verifiedSnapshot[\s\S]*buildShipmentResult[\s\S]*await verifiedSnapshot[\s\S]*commitShipmentBundle/,
  '출고 확정은 결과 저장 직전 주문 Revision을 다시 검증해야 한다.');

for (const relative of ['orderops/list.html', 'orderops_list.html']) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  inlineScripts.forEach((match, index) => new vm.Script(match[1], { filename: `${relative}:inline-${index + 1}` }));
  for (const contract of ['id="shipmentExecution"', 'id="shipmentConfirmButton"', 'id="shipmentHoldButton"', 'data-shipped-quantity', '부분출고 사유', 'data-reverse-shipment', 'SHIPMENT_ORDER_REVISION_CONFLICT']) {
    assert.ok(html.includes(contract), `${relative} 출고 작업 UI 계약 누락: ${contract}`);
  }
  assert.doesNotMatch(html, /NEXUS 판매전표 직접 등록|ECOUNT.*API.*등록/, '이번 범위에 판매전표 직접 등록을 추가하면 안 된다.');
}

const orderQuery = fs.readFileSync(path.join(root, 'orderq/index.html'), 'utf8');
assert.match(orderQuery, /<th>출고상태<\/th>/);
assert.match(orderQuery, /shipment-result-read-adapter\.js/);
assert.match(orderQuery, /oneapp-orderops-shipment-results/);

console.log('OrderOps shipment core, progress axis, idempotence, partial/over shipment, substitution lineage, hold/reversal, ownership, and UI contracts passed.');
