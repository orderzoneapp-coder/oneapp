import assert from 'node:assert/strict';
import {
  PROCESSING_STATUS,
  PROCESSING_STATUS_LABEL,
  buildProcessingSnapshot,
  calculateProcessingRow,
  aggregateProcessingOrder
} from '../orderq/order-processing-view.js';
import { createAllocationEvent, createReversalEvent } from '../orderq/order-fulfillment-lifecycle.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const order = (id, orderStatus = 'ORDER') => ({ orderId: id, orderNo: `20260906-${id}`, orderDate: '2026-09-06', customerName: '거래처', orderStatus, adminStatus: 'CHECKED' });
const item = (orderId, itemId, quantity, extra = {}) => ({ orderId, orderItemId: itemId, itemCode: itemId, itemName: itemId, finalQuantity: quantity, finalUnit: 'BOX', matchStatus: 'MATCHED', ...extra });
const allocation = (orderId, orderItemId, n, quantity) => createAllocationEvent({ orderId, orderItemId, salesDocumentId: `SD-${n}`, salesLineId: `SL-${n}`, quantity, createdAt: `2026-09-06T0${n}:00:00.000Z` });

const row = (quantity, events = [], extra = {}) => calculateProcessingRow(order('ORD'), item('ORD', 'ITEM', quantity, extra), events, { calculatedAt: '2026-09-06T12:00:00.000Z' });
assert.equal(row(5).transferStatus, PROCESSING_STATUS.UNTRANSFERRED, '신규/0 이관');
assert.equal(row(5, [allocation('ORD', 'ITEM', 1, 2)]).transferStatus, PROCESSING_STATUS.PARTIAL, '일부 이관');
assert.equal(row(5, [allocation('ORD', 'ITEM', 1, 5)]).transferStatus, PROCESSING_STATUS.TRANSFERRED, '전량 이관');
assert.equal(row(5, [allocation('ORD', 'ITEM', 1, 7)]).untransferredQuantity, 0, '초과 표시수량은 0');
assert.equal(row(5, [allocation('ORD', 'ITEM', 1, 7)]).rawUntransferredQuantity, -2, '초과 원수량 보존');
assert.equal(row(5, [allocation('ORD', 'ITEM', 1, 7)]).transferStatus, PROCESSING_STATUS.OVER_TRANSFERRED, '초과 이관');
const allocated = allocation('ORD', 'ITEM', 1, 5);
const reversed = createReversalEvent({ orderId: 'ORD', orderItemId: 'ITEM', salesDocumentId: 'SD-1', salesLineId: 'SL-1', allocationEventId: allocated.eventId, idempotencyKey: 'REV-1', quantity: 2 });
assert.equal(row(5, [allocated, reversed]).netTransferQuantity, 3, '역이관 차감');
assert.equal(row(5, [allocated, reversed]).reverseStatus, '반영됨', '역이관 반영 여부');
assert.equal(row(5, [], { cancelledQuantity: 2 }).effectiveOrderQuantity, 3, '부분취소 유효수량');
assert.equal(row(5, [allocation('ORD', 'ITEM', 1, 3)], { cancelledQuantity: 2 }).transferStatus, PROCESSING_STATUS.TRANSFERRED, '부분취소 후 이관');
assert.equal(calculateProcessingRow(order('ORD', 'FULL_CANCEL'), item('ORD', 'ITEM', 5), [], { calculatedAt: 'now' }).transferStatus, PROCESSING_STATUS.NOT_APPLICABLE, '전체취소');
assert.equal(row(0).transferStatus, PROCESSING_STATUS.NOT_APPLICABLE, '유효수량 0');
assert.equal(row(1.25, [allocation('ORD', 'ITEM', 1, 0.25)]).untransferredQuantity, 1, '소수 수량 손실 없음');
const multi = buildProcessingSnapshot({
  orders: [order('ORD-MULTI')],
  items: [item('ORD-MULTI', 'A', 2), item('ORD-MULTI', 'B', 3)],
  events: [allocation('ORD-MULTI', 'A', 1, 2), allocation('ORD-MULTI', 'B', 1, 1)],
  calculatedAt: 'fixed'
});
assert.deepEqual(multi.rows.map(result => result.netTransferQuantity), [2, 1], '복수 주문행은 행별 집계');
assert.equal(multi.orders[0].status, PROCESSING_STATUS.PARTIAL, '복수 주문행 주문 집계');
assert.equal(row(5, [], {},).aggregationError, '', '정상 집계');
assert.equal(row(5, [], { cancelledQuantity: -1 }).transferStatus, PROCESSING_STATUS.REVIEW_REQUIRED, '잘못된 취소수량은 확인 필요');
const failed = calculateProcessingRow(order('ORD'), item('ORD', 'ITEM', 5), [{ eventType: 'SALES_TRANSFER_ALLOCATED', orderId: 'ORD', detail: { orderItemId: 'ITEM', transferredQty: 2 } }], { calculatedAt: 'fixed', aggregationError: '필드 누락' });
assert.equal(failed.transferStatus, PROCESSING_STATUS.REVIEW_REQUIRED, '집계 실패를 0으로 단정하지 않음');
assert.equal(aggregateProcessingOrder([row(-1)]).status, PROCESSING_STATUS.NEEDS_CORRECTION, '음수 원수량 정정필요');
assert.equal(calculateProcessingRow(order('ORD', 'FULL_CANCEL'), item('ORD', 'ITEM', 5), [], { calculatedAt: 'fixed', aggregationError: '취소 주문의 이관 필드 누락' }).transferStatus, PROCESSING_STATUS.NOT_APPLICABLE, '전체취소 우선순위');
const differentUnits = aggregateProcessingOrder([row(1), calculateProcessingRow(order('ORD'), item('ORD', 'ITEM-2', 1, { finalUnit: 'EA' }), [])]);
assert.equal(differentUnits.status, PROCESSING_STATUS.REVIEW_REQUIRED, '단위 불일치 합산 금지');

const html = read('orderq/index.html');
const processingSection = html.match(/<section id="processingView"[\s\S]*?<\/section>/)?.[0] || '';
assert.match(processingSection, /주문번호/);
assert.match(processingSection, /취소수량/);
assert.match(processingSection, /순판매이관수량/);
assert.match(processingSection, /역이관 반영 여부/);
assert.match(processingSection, /주문조회/);
assert.match(processingSection, /주문·출고/);
assert.doesNotMatch(processingSection, /미출고|부분출고|출고완료|출고대기|실제 출고수량|실제출고수량/, '처리현황에 M5 출고 상태·수량 없음');
assert.match(html, /readProcessingSnapshot/);
assert.match(html, /processingError/);
assert.match(html, /data-processing-readonly/);
assert.match(html, /orderops\/list\.html\?orderId=/);
assert.doesNotMatch(html, /orderops\/list\.html\?orderId=\$\{[^}]*\bundefined/);

console.log(`ORDER Q processing passed: ${PROCESSING_STATUS_LABEL[PROCESSING_STATUS.PARTIAL]}, reversal, cancellation, decimal, multi-line, failure, unit safety, read-only markup.`);
