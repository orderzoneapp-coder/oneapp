import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORDER_STATUS,
  ADMIN_STATUS,
  OPS_STATUS,
  INPUT_CHANNEL,
  normalizeOrderStatus,
  normalizeAdminStatus,
  normalizeOpsStatus,
  inferInputChannel,
  initialAdminStatus,
  orderDateKey,
  formatOrderNo,
  orderSequenceFromNo,
  assigneeIdentity,
  inheritedAssigneeSnapshot,
  externalOrderSnapshot,
  normalizedOrderView,
  documentFieldChanges,
  orderItemChanges
} from '../orderq/order-document-model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const db = read('orderq/orderq-db.js');
const engine = read('orderq/order-intake-engine.js');
const input = read('orderq/input.html');
const history = read('orderq/index.html');
const parserUi = read('orderq/parser-ui.js');

assert.equal(orderDateKey('2026-08-14'), '20260814');
assert.equal(formatOrderNo('20260814', 1), '20260814-001');
assert.equal(formatOrderNo('20260814', 1000), '20260814-1000');
assert.equal(orderSequenceFromNo('20260814-023', '20260814'), 23);
assert.equal(orderSequenceFromNo('20260813-023', '20260814'), 0);

assert.equal(normalizeOrderStatus('', 'CANCELLED'), ORDER_STATUS.FULL_CANCEL);
assert.equal(normalizeOrderStatus('PAID'), ORDER_STATUS.PAID);
assert.equal(normalizeAdminStatus(''), ADMIN_STATUS.UNCHECKED);
assert.equal(normalizeAdminStatus('CHECKED'), ADMIN_STATUS.CHECKED);
assert.equal(normalizeOpsStatus('CLOSED'), OPS_STATUS.CLOSED);
assert.equal(inferInputChannel('KAKAO_TEXT'), INPUT_CHANNEL.ORDER_IN);
assert.equal(inferInputChannel('EXCEL_UPLOAD'), INPUT_CHANNEL.EXCEL);
assert.equal(inferInputChannel('SHOP_ORDER'), INPUT_CHANNEL.SHOPPING_MALL);
assert.equal(inferInputChannel('MANUAL'), INPUT_CHANNEL.DIRECT);
assert.equal(initialAdminStatus('MANUAL', INPUT_CHANNEL.DIRECT), ADMIN_STATUS.CHECKED);
assert.equal(initialAdminStatus('KAKAO_TEXT', INPUT_CHANNEL.ORDER_IN), ADMIN_STATUS.UNCHECKED);
assert.equal(initialAdminStatus('EXCEL_UPLOAD', INPUT_CHANNEL.EXCEL), ADMIN_STATUS.UNCHECKED);

const firstAssignee = assigneeIdentity('김관리');
assert.match(firstAssignee.assigneeId, /^MGR-/);
assert.deepEqual(assigneeIdentity('김관리', '', firstAssignee), firstAssignee);
assert.notEqual(assigneeIdentity('이관리', firstAssignee.assigneeId, firstAssignee).assigneeId, firstAssignee.assigneeId);
assert.deepEqual(assigneeIdentity(''), { assigneeId: '', assigneeName: '' });
assert.deepEqual(inheritedAssigneeSnapshot({ orderId: 'ORD-1', assigneeId: 'MGR-1', assigneeName: '김관리' }), {
  assigneeId: 'MGR-1', assigneeName: '김관리', assigneeInheritedFromOrderId: 'ORD-1'
});

assert.deepEqual(externalOrderSnapshot({
  externalOrderNo: 'SHOP-1', productAmount: '10000', couponDiscount: '1000', pointsUsed: 500,
  shippingFee: 3000, paymentAmount: 11500, externalOriginalStatus: 'paid'
}), {
  externalOrderNo: 'SHOP-1', externalOriginalStatus: 'paid', productAmount: 10000,
  couponDiscount: 1000, pointsUsed: 500, shippingFee: 3000, paymentAmount: 11500
});

const legacy = normalizedOrderView({ orderId: 'ORD-1', status: 'CONFIRMED', sourceType: 'MANUAL' });
assert.equal(legacy.orderStatus, ORDER_STATUS.ORDER);
assert.equal(legacy.adminStatus, ADMIN_STATUS.UNCHECKED);
assert.equal(legacy.opsStatus, OPS_STATUS.ACTIVE);
assert.equal(legacy.matchingStatus, 'CONFIRMED');

const changes = documentFieldChanges({ assigneeName: 'A', adminStatus: 'UNCHECKED' }, { assigneeName: 'B', adminStatus: 'CHECKED' });
assert.deepEqual(changes.map(change => change.field), ['assigneeName', 'adminStatus']);
assert.deepEqual(
  documentFieldChanges({ deliveryExpectedDate: '' }, { deliveryExpectedDate: '2026-08-20' }).map(change => change.field),
  ['deliveryExpectedDate']
);
const itemChanges = orderItemChanges(
  [{ orderItemId: 'OI-1', lineNo: 1, itemCode: 'A', itemName: '사과', finalQuantity: 2, price: 1000 }],
  [
    { orderItemId: 'OI-1', lineNo: 1, itemCode: 'A', itemName: '사과', finalQuantity: 3, price: 1200 },
    { orderItemId: 'OI-2', lineNo: 2, itemCode: 'B', itemName: '배', finalQuantity: 1, price: 900 }
  ]
);
assert.deepEqual(itemChanges.map(change => change.itemField), ['finalQuantity', 'price', 'added']);
assert.equal(orderItemChanges([{ orderItemId: 'OI-1', itemName: '사과' }], [])[0].itemField, 'removed');

assert.match(db, /export const DB_VERSION = ORDERQ_DB_VERSION/);
for (const index of ['byOrderNo', 'byExternalOrderNo', 'byOrderStatus', 'byAdminStatus', 'byOpsStatus', 'byAssigneeId', 'byInputChannel']) {
  assert.match(db, new RegExp(`['"]${index}['"]`), `${index} DB index is required`);
}
assert.match(db, /orderNoSequence:/);
assert.match(engine, /allocateOrderNoInTransaction/);
assert.match(engine, /documentFieldChanges\(previousOrder, next\)/);
assert.match(engine, /orderItemChanges\(oldItems, items\)/);
assert.match(engine, /ORDER_CREATED/);
assert.match(engine, /ORDER_UPDATED/);
assert.match(engine, /initialAdminStatus\(sourceType, inputChannel\)/);
assert.match(engine, /normalizedOrderView/);

assert.match(input, /id="assigneeName"/);
assert.match(input, /id="orderStatus"/);
assert.match(input, /id="adminStatus"/);
assert.match(input, /id="deliveryExpectedDate"/);
assert.match(input, /if \(!editingOrderId\)[\s\S]*adminStatusInput\.value = 'CHECKED'/);
assert.match(input, /id="opsStatus"/);
assert.match(input, /id="externalOrderNo"/);
assert.match(input, /id="paymentAmount"/);
assert.match(input, /\.\/index\.html\?focus=/, 'save must return to order document history');

assert.match(history, /주문현황 · 전표관리/);
assert.match(history, /data-detail-for=/);
assert.match(history, /펼침영역 수정/);
assert.match(history, /data-edit-form=/);
assert.match(history, /data-save-inline=/);
assert.match(history, /updateOrder/);
assert.match(history, /deliveryExpectedDate/);
assert.match(history, /대표품목/);
assert.match(history, /일반 인쇄/);
assert.match(history, /카카오톡 복사/);
assert.match(history, /ClipboardItem/);
assert.match(history, /renderKakaoPng/);
assert.match(history, /외부 주문번호/);
assert.match(history, /ORDER Q 운영/);
assert.match(parserUi, /inputChannel:\s*'ORDER_IN'/);
assert.match(parserUi, /index\.html\?focus=/);

for (const source of [db, engine, input, history, parserUi]) {
  assert.doesNotMatch(source, /\?v=0\.5\.1/);
}

console.log('ORDER Q order-document workflow, numbering, statuses, assignee history, expansion, printing, and external-order fields passed.');
