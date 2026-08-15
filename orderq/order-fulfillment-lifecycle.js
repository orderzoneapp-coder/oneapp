import { ADMIN_STATUS, OPS_STATUS, ORDER_STATUS } from './order-document-model.js?v=0.8.0';

export const TRANSFER_EVENT_TYPE = Object.freeze({
  ALLOCATED: 'SALES_TRANSFER_ALLOCATED',
  REVERSED: 'SALES_TRANSFER_REVERSED',
  CLOSED: 'ORDER_OPERATIONS_CLOSED',
  REOPENED: 'ORDER_OPERATIONS_REOPENED'
});

export const TRANSFER_STATUS = Object.freeze({
  UNTRANSFERRED: 'UNTRANSFERRED',
  PARTIAL: 'PARTIAL',
  TRANSFERRED: 'TRANSFERRED',
  OVER_TRANSFERRED: 'OVER_TRANSFERRED'
});

export const TRANSFER_STATUS_LABEL = Object.freeze({
  [TRANSFER_STATUS.UNTRANSFERRED]: '미이관',
  [TRANSFER_STATUS.PARTIAL]: '부분이관',
  [TRANSFER_STATUS.TRANSFERRED]: '이관완료',
  [TRANSFER_STATUS.OVER_TRANSFERRED]: '초과이관'
});

const EPSILON = 1e-9;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sameNumber(left, right) {
  return Math.abs(finiteNumber(left) - finiteNumber(right)) <= EPSILON;
}

export function stableTransferId(parts = []) {
  const source = parts.map(value => String(value ?? '').normalize('NFKC').trim()).join('|');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `OE-XFER-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function transferBusinessKey({ salesDocumentId = '', salesLineId = '', orderItemId = '' } = {}) {
  if (!salesDocumentId || !salesLineId || !orderItemId) throw new Error('판매전표·판매행·주문상품 식별정보가 필요합니다.');
  return [salesDocumentId, salesLineId, orderItemId].map(value => String(value).trim()).join('|');
}

export function isTransferEvent(event = {}) {
  return event.eventType === TRANSFER_EVENT_TYPE.ALLOCATED || event.eventType === TRANSFER_EVENT_TYPE.REVERSED;
}

export function createAllocationEvent(input = {}) {
  const quantity = finiteNumber(input.quantity);
  if (!(quantity > 0)) throw new Error('이관수량은 0보다 커야 합니다.');
  const businessKey = transferBusinessKey(input);
  const createdAt = String(input.createdAt || new Date().toISOString());
  return {
    eventId: stableTransferId(['ALLOCATED', businessKey]),
    orderId: String(input.orderId || '').trim(),
    revision: Number(input.revision || 0),
    eventType: TRANSFER_EVENT_TYPE.ALLOCATED,
    actor: String(input.actor || 'LOCAL_USER'),
    detail: {
      transferBusinessKey: businessKey,
      orderItemId: String(input.orderItemId).trim(),
      salesDocumentId: String(input.salesDocumentId).trim(),
      salesLineId: String(input.salesLineId).trim(),
      transferredQty: quantity,
      inheritedAssigneeSnapshot: input.inheritedAssigneeSnapshot || null,
      reason: String(input.reason || '')
    },
    createdAt
  };
}

export function createReversalEvent(input = {}) {
  const quantity = finiteNumber(input.quantity);
  if (!(quantity > 0)) throw new Error('취소·역분개수량은 0보다 커야 합니다.');
  const allocationEventId = String(input.allocationEventId || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!allocationEventId || !idempotencyKey) throw new Error('원 이관이력과 역분개 식별키가 필요합니다.');
  const createdAt = String(input.createdAt || new Date().toISOString());
  return {
    eventId: stableTransferId(['REVERSED', allocationEventId, idempotencyKey]),
    orderId: String(input.orderId || '').trim(),
    revision: Number(input.revision || 0),
    eventType: TRANSFER_EVENT_TYPE.REVERSED,
    actor: String(input.actor || 'LOCAL_USER'),
    detail: {
      allocationEventId,
      orderItemId: String(input.orderItemId || '').trim(),
      salesDocumentId: String(input.salesDocumentId || '').trim(),
      salesLineId: String(input.salesLineId || '').trim(),
      transferredQty: quantity,
      idempotencyKey,
      reason: String(input.reason || '판매전표 취소·수정')
    },
    createdAt
  };
}

export function effectiveOrderQuantity(order = {}, item = {}) {
  if (order.orderStatus === ORDER_STATUS.FULL_CANCEL || item.matchStatus === 'CANCELLED' || item.active === false) return 0;
  const ordered = finiteNumber(item.finalQuantity ?? item.rawQuantity ?? item.quantity);
  const cancelled = Math.max(0, finiteNumber(item.cancelledQuantity));
  return ordered - cancelled;
}

export function effectiveTransferredQuantity(orderItemId, events = []) {
  return events.reduce((total, event) => {
    if (!isTransferEvent(event) || String(event.detail?.orderItemId || '') !== String(orderItemId || '')) return total;
    const quantity = Math.max(0, finiteNumber(event.detail?.transferredQty));
    return total + (event.eventType === TRANSFER_EVENT_TYPE.ALLOCATED ? quantity : -quantity);
  }, 0);
}

export function deriveItemTransfer(order = {}, item = {}, events = []) {
  const effectiveOrderQty = effectiveOrderQuantity(order, item);
  const transferredQty = effectiveTransferredQuantity(item.orderItemId, events);
  const remainingQty = effectiveOrderQty - transferredQty;
  let transferStatus = TRANSFER_STATUS.UNTRANSFERRED;
  if (remainingQty < -EPSILON) transferStatus = TRANSFER_STATUS.OVER_TRANSFERRED;
  else if (effectiveOrderQty <= EPSILON || sameNumber(remainingQty, 0)) transferStatus = TRANSFER_STATUS.TRANSFERRED;
  else if (transferredQty > EPSILON) transferStatus = TRANSFER_STATUS.PARTIAL;
  return { effectiveOrderQty, transferredQty, remainingQty, transferStatus };
}

export function deriveOrderLifecycle(order = {}, items = [], events = []) {
  const itemStates = items.map(item => ({ item, ...deriveItemTransfer(order, item, events) }));
  const valid = itemStates.filter(state => state.effectiveOrderQty > EPSILON);
  const hasOverTransfer = itemStates.some(state => state.transferStatus === TRANSFER_STATUS.OVER_TRANSFERRED);
  const allTransferred = valid.every(state => sameNumber(state.remainingQty, 0));
  const operationStatus = allTransferred && !hasOverTransfer && order.adminStatus !== ADMIN_STATUS.HOLD
    ? OPS_STATUS.CLOSED
    : OPS_STATUS.ACTIVE;
  let transferStatus = TRANSFER_STATUS.UNTRANSFERRED;
  if (hasOverTransfer) transferStatus = TRANSFER_STATUS.OVER_TRANSFERRED;
  else if (allTransferred) transferStatus = TRANSFER_STATUS.TRANSFERRED;
  else if (valid.some(state => state.transferredQty > EPSILON)) transferStatus = TRANSFER_STATUS.PARTIAL;
  const latestCloseEvent = [...events]
    .filter(event => event.eventType === TRANSFER_EVENT_TYPE.CLOSED)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  return {
    order,
    itemStates,
    effectiveOrderQty: itemStates.reduce((sum, state) => sum + state.effectiveOrderQty, 0),
    transferredQty: itemStates.reduce((sum, state) => sum + state.transferredQty, 0),
    remainingQty: itemStates.reduce((sum, state) => sum + state.remainingQty, 0),
    transferStatus,
    operationStatus,
    hasOverTransfer,
    closedAt: operationStatus === OPS_STATUS.CLOSED ? String(latestCloseEvent?.createdAt || '') : ''
  };
}

export function filterOrderBundles(bundles = [], filters = {}) {
  return bundles.filter(bundle => {
    const order = bundle.order || {};
    const lifecycle = bundle.lifecycle || deriveOrderLifecycle(order, bundle.items || [], bundle.events || []);
    if (filters.orderStatus && order.orderStatus !== filters.orderStatus) return false;
    if (filters.adminStatus && order.adminStatus !== filters.adminStatus) return false;
    if (filters.transferStatus && lifecycle.transferStatus !== filters.transferStatus) return false;
    if (filters.operationStatus && lifecycle.operationStatus !== filters.operationStatus) return false;
    if (filters.assigneeId && order.assigneeId !== filters.assigneeId) return false;
    if (filters.assigneeName && order.assigneeName !== filters.assigneeName) return false;
    return true;
  });
}

export function aggregateOperationsByProduct(bundles = [], inventoryByProduct = new Map()) {
  const rows = new Map();
  bundles.forEach(bundle => {
    const lifecycle = bundle.lifecycle || deriveOrderLifecycle(bundle.order, bundle.items || [], bundle.events || []);
    lifecycle.itemStates.forEach(state => {
      if (state.effectiveOrderQty <= EPSILON) return;
      const item = state.item;
      const productCode = String(item.itemCode || item.productId || '').trim();
      if (!productCode) return;
      const row = rows.get(productCode) || {
        productCode,
        productName: String(item.itemName || '').trim(),
        specification: String(item.specification || '').trim(),
        unit: String(item.finalUnit || item.rawUnit || '').trim(),
        orderQty: 0,
        transferredQty: 0,
        remainingQty: 0,
        inventoryQty: finiteNumber(inventoryByProduct.get(productCode)),
        orderRefs: [],
        assignees: new Set(),
        hasOverTransfer: false
      };
      row.orderQty += state.effectiveOrderQty;
      row.transferredQty += state.transferredQty;
      row.remainingQty += state.remainingQty;
      row.hasOverTransfer ||= state.transferStatus === TRANSFER_STATUS.OVER_TRANSFERRED;
      row.orderRefs.push({
        orderId: bundle.order.orderId,
        orderNo: bundle.order.orderNo || bundle.order.orderId,
        quantity: state.effectiveOrderQty,
        remainingQty: state.remainingQty,
        adminStatus: bundle.order.adminStatus,
        assigneeName: bundle.order.assigneeName || ''
      });
      if (bundle.order.assigneeName) row.assignees.add(bundle.order.assigneeName);
      rows.set(productCode, row);
    });
  });
  return [...rows.values()].map(row => ({
    ...row,
    assignees: [...row.assignees].sort((a, b) => a.localeCompare(b, 'ko')),
    availableAfterOrders: row.inventoryQty - row.remainingQty,
    transferStatus: row.hasOverTransfer
      ? TRANSFER_STATUS.OVER_TRANSFERRED
      : row.remainingQty <= EPSILON
        ? TRANSFER_STATUS.TRANSFERRED
        : row.transferredQty > EPSILON ? TRANSFER_STATUS.PARTIAL : TRANSFER_STATUS.UNTRANSFERRED
  })).sort((a, b) => a.productCode.localeCompare(b.productCode, 'ko', { numeric: true }));
}
