import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { normalizedOrderView, ORDER_STATUS } from './order-document-model.js?v=0.7.1';
import {
  TRANSFER_EVENT_TYPE,
  deriveItemTransfer,
  isTransferEvent
} from './order-fulfillment-lifecycle.js?v=0.7.1';

export const PROCESSING_STATUS = Object.freeze({
  UNTRANSFERRED: 'UNTRANSFERRED',
  PARTIAL: 'PARTIAL',
  TRANSFERRED: 'TRANSFERRED',
  OVER_TRANSFERRED: 'OVER_TRANSFERRED',
  NEEDS_CORRECTION: 'NEEDS_CORRECTION',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});

export const PROCESSING_STATUS_LABEL = Object.freeze({
  [PROCESSING_STATUS.UNTRANSFERRED]: '미이관',
  [PROCESSING_STATUS.PARTIAL]: '일부이관',
  [PROCESSING_STATUS.TRANSFERRED]: '이관완료',
  [PROCESSING_STATUS.OVER_TRANSFERRED]: '이관초과',
  [PROCESSING_STATUS.NEEDS_CORRECTION]: '정정필요',
  [PROCESSING_STATUS.NOT_APPLICABLE]: '해당 없음',
  [PROCESSING_STATUS.REVIEW_REQUIRED]: '확인 필요'
});

export const REVERSE_STATUS_LABEL = Object.freeze({
  APPLIED: '반영됨',
  NONE: '없음',
  REVIEW_REQUIRED: '확인 필요'
});

const EPSILON = 1e-9;

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameNumber(left, right) {
  return Math.abs(left - right) <= EPSILON;
}

function itemQuantity(item = {}) {
  return numberOrNull(item.finalQuantity ?? item.rawQuantity ?? item.quantity);
}

function itemUnit(item = {}) {
  return String(item.finalUnit || item.rawUnit || '').trim();
}

function cancellationSnapshot(order, item, orderedQuantity) {
  if (order.orderStatus === ORDER_STATUS.FULL_CANCEL || item.matchStatus === 'CANCELLED' || item.active === false) {
    return { quantity: orderedQuantity, valid: orderedQuantity !== null };
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'cancelledQuantity')) return { quantity: 0, valid: true };
  const quantity = numberOrNull(item.cancelledQuantity);
  return { quantity, valid: quantity !== null && quantity >= 0 };
}

function transferEventIssue(event, itemById) {
  if (!isTransferEvent(event)) return '';
  const detail = event.detail || {};
  const orderItemId = String(detail.orderItemId || '').trim();
  const quantity = numberOrNull(detail.transferredQty);
  if (!orderItemId || !itemById.has(orderItemId) || quantity === null || quantity <= 0) return '판매이관 이벤트 필드가 불완전합니다.';
  if (!String(detail.salesDocumentId || '').trim() || !String(detail.salesLineId || '').trim()) return '판매이관 원문 식별정보가 없습니다.';
  if (event.eventType === TRANSFER_EVENT_TYPE.REVERSED && !String(detail.allocationEventId || '').trim()) return '역이관 대상 이관이력이 없습니다.';
  return '';
}

function transferEventsForItem(itemId, events) {
  return events.filter(event => isTransferEvent(event) && String(event.detail?.orderItemId || '') === String(itemId || ''));
}

function latestEventAt(events) {
  return events
    .map(event => String(event.createdAt || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] || '';
}

function reverseStatus(events, aggregationOk) {
  if (!aggregationOk) return REVERSE_STATUS_LABEL.REVIEW_REQUIRED;
  return events.some(event => event.eventType === TRANSFER_EVENT_TYPE.REVERSED)
    ? REVERSE_STATUS_LABEL.APPLIED
    : REVERSE_STATUS_LABEL.NONE;
}

export function calculateProcessingRow(order = {}, item = {}, events = [], { calculatedAt = new Date().toISOString(), aggregationError = '' } = {}) {
  const normalized = normalizedOrderView(order);
  const orderedQuantity = itemQuantity(item);
  const cancellation = cancellationSnapshot(normalized, item, orderedQuantity);
  const itemEvents = transferEventsForItem(item.orderItemId, events);
  const aggregationOk = !aggregationError && orderedQuantity !== null && cancellation.valid;
  const lifecycle = aggregationOk ? deriveItemTransfer(normalized, item, itemEvents) : null;
  const effectiveOrderQty = lifecycle?.effectiveOrderQty ?? (orderedQuantity !== null && cancellation.quantity !== null
    ? orderedQuantity - cancellation.quantity
    : null);
  const transferredQty = lifecycle?.transferredQty ?? null;
  const remainingQty = effectiveOrderQty !== null && transferredQty !== null ? effectiveOrderQty - transferredQty : null;
  let status = PROCESSING_STATUS.REVIEW_REQUIRED;
  const notApplicable = normalized.orderStatus === ORDER_STATUS.FULL_CANCEL || item.matchStatus === 'CANCELLED' || item.active === false || (effectiveOrderQty !== null && Math.abs(effectiveOrderQty) <= EPSILON);
  if (effectiveOrderQty !== null && effectiveOrderQty < -EPSILON) status = PROCESSING_STATUS.NEEDS_CORRECTION;
  else if (notApplicable) status = PROCESSING_STATUS.NOT_APPLICABLE;
  else if (!aggregationOk) status = PROCESSING_STATUS.REVIEW_REQUIRED;
  else if (transferredQty < -EPSILON) status = PROCESSING_STATUS.NEEDS_CORRECTION;
  else if (sameNumber(transferredQty, 0)) status = PROCESSING_STATUS.UNTRANSFERRED;
  else if (remainingQty < -EPSILON) status = PROCESSING_STATUS.OVER_TRANSFERRED;
  else if (sameNumber(remainingQty, 0)) status = PROCESSING_STATUS.TRANSFERRED;
  else status = PROCESSING_STATUS.PARTIAL;

  return {
    orderId: String(normalized.orderId || '').trim(),
    orderItemId: String(item.orderItemId || '').trim(),
    orderNo: String(normalized.orderNo || normalized.orderId || '').trim(),
    orderDate: String(normalized.orderDate || '').trim(),
    customerName: String(normalized.customerName || '').trim(),
    itemName: String(item.itemName || item.itemCode || '').trim(),
    itemCode: String(item.itemCode || '').trim(),
    specification: String(item.specification || '').trim(),
    unit: itemUnit(item),
    orderQuantity: orderedQuantity,
    cancelledQuantity: cancellation.quantity,
    effectiveOrderQuantity: effectiveOrderQty,
    netTransferQuantity: transferredQty,
    rawUntransferredQuantity: remainingQty,
    untransferredQuantity: remainingQty === null ? null : Math.max(0, remainingQty),
    transferStatus: status,
    transferStatusLabel: PROCESSING_STATUS_LABEL[status],
    reverseStatus: reverseStatus(itemEvents, aggregationOk),
    latestEventAt: latestEventAt(itemEvents),
    calculatedAt,
    aggregationError: aggregationError || ''
  };
}

function compatibleUnits(rows) {
  const units = [...new Set(rows.filter(row => row.effectiveOrderQuantity > EPSILON).map(row => row.unit).filter(Boolean))];
  return units.length <= 1;
}

export function aggregateProcessingOrder(rows = []) {
  const validRows = rows.filter(Boolean);
  const hasCorrection = validRows.some(row => row.transferStatus === PROCESSING_STATUS.NEEDS_CORRECTION);
  const hasReview = validRows.some(row => row.transferStatus === PROCESSING_STATUS.REVIEW_REQUIRED);
  const activeRows = validRows.filter(row => row.effectiveOrderQuantity !== null && row.effectiveOrderQuantity > EPSILON);
  let status = PROCESSING_STATUS.REVIEW_REQUIRED;
  if (hasCorrection) status = PROCESSING_STATUS.NEEDS_CORRECTION;
  else if (!validRows.length || validRows.every(row => row.effectiveOrderQuantity !== null && row.effectiveOrderQuantity <= EPSILON)) status = PROCESSING_STATUS.NOT_APPLICABLE;
  else if (hasReview || !compatibleUnits(validRows)) status = PROCESSING_STATUS.REVIEW_REQUIRED;
  else if (activeRows.every(row => sameNumber(row.rawUntransferredQuantity, 0))) status = PROCESSING_STATUS.TRANSFERRED;
  else if (activeRows.some(row => row.rawUntransferredQuantity < -EPSILON)) status = PROCESSING_STATUS.OVER_TRANSFERRED;
  else if (activeRows.every(row => sameNumber(row.netTransferQuantity, 0))) status = PROCESSING_STATUS.UNTRANSFERRED;
  else status = PROCESSING_STATUS.PARTIAL;
  return {
    orderId: validRows[0]?.orderId || '',
    status,
    statusLabel: PROCESSING_STATUS_LABEL[status],
    rows: validRows,
    compatibleUnits: compatibleUnits(validRows),
    latestEventAt: latestEventAt(validRows.flatMap(row => row.latestEventAt ? [{ createdAt: row.latestEventAt }] : [])),
    calculatedAt: validRows[0]?.calculatedAt || ''
  };
}

export function buildProcessingSnapshot({ orders = [], items = [], events = [], calculatedAt = new Date().toISOString() } = {}) {
  const itemsByOrder = new Map();
  const eventsByOrder = new Map();
  const itemByIdByOrder = new Map();
  items.forEach(item => {
    const orderId = String(item.orderId || '').trim();
    itemsByOrder.set(orderId, [...(itemsByOrder.get(orderId) || []), item]);
    itemByIdByOrder.set(orderId, new Map([...(itemByIdByOrder.get(orderId) || new Map()), [String(item.orderItemId || ''), item]]));
  });
  events.forEach(event => {
    const orderId = String(event.orderId || '').trim();
    eventsByOrder.set(orderId, [...(eventsByOrder.get(orderId) || []), event]);
  });
  const rows = [];
  const orderSummaries = [];
  orders.forEach(sourceOrder => {
    const order = normalizedOrderView(sourceOrder);
    const orderItems = itemsByOrder.get(String(order.orderId || '').trim()) || [];
    const orderEvents = eventsByOrder.get(String(order.orderId || '').trim()) || [];
    const itemById = itemByIdByOrder.get(String(order.orderId || '').trim()) || new Map();
    const unknownEvent = orderEvents.map(event => transferEventIssue(event, itemById)).find(Boolean) || '';
    const orderRows = orderItems.map(item => calculateProcessingRow(order, item, orderEvents, { calculatedAt, aggregationError: unknownEvent }));
    rows.push(...orderRows);
    orderSummaries.push(aggregateProcessingOrder(orderRows));
  });
  const summaryByOrderId = new Map(orderSummaries.map(summary => [summary.orderId, summary]));
  return {
    calculatedAt,
    rows: rows.map(row => ({ ...row, orderStatus: summaryByOrderId.get(row.orderId)?.status || PROCESSING_STATUS.REVIEW_REQUIRED, orderStatusLabel: summaryByOrderId.get(row.orderId)?.statusLabel || PROCESSING_STATUS_LABEL.REVIEW_REQUIRED })),
    orders: orderSummaries
  };
}

export async function readProcessingSnapshot({ calculatedAt = new Date().toISOString() } = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS], 'readonly');
  const [orders, items, events] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.ORDERS).getAll()),
    requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).getAll()),
    requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).getAll())
  ]);
  await transactionDone(tx);
  return buildProcessingSnapshot({ orders, items, events, calculatedAt });
}
