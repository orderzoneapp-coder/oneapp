import { getOrder, listOrders } from './order-intake-engine.js?v=0.8.0';
import { createShipmentOrderSnapshot, shipmentSnapshotMatches } from './shipment-order-read-model.js?v=0.8.1';

export const SHIPMENT_ORDER_READ_STATUS = Object.freeze({
  READY: 'READY',
  EMPTY: 'EMPTY',
  PARTIAL: 'PARTIAL',
  NOT_FOUND: 'NOT_FOUND',
  STALE: 'STALE',
  ERROR: 'ERROR'
});

const boundedLimit = value => Math.max(1, Math.min(200, Number(value) || 100));
const validDate = value => {
  const candidate = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate;
};

export async function readShipmentOrderCandidate(orderId, expectations = {}) {
  const requestedOrderId = String(orderId || '').trim();
  if (!requestedOrderId) return { status: SHIPMENT_ORDER_READ_STATUS.NOT_FOUND, orderId: '' };
  try {
    const bundle = await getOrder(requestedOrderId);
    if (!bundle) return { status: SHIPMENT_ORDER_READ_STATUS.NOT_FOUND, orderId: requestedOrderId };
    const snapshot = createShipmentOrderSnapshot(bundle);
    if (!shipmentSnapshotMatches(snapshot, expectations)) {
      return { status: SHIPMENT_ORDER_READ_STATUS.STALE, orderId: requestedOrderId, snapshot };
    }
    if (!snapshot.candidateLines.length) {
      return { status: SHIPMENT_ORDER_READ_STATUS.EMPTY, orderId: requestedOrderId, snapshot };
    }
    return { status: SHIPMENT_ORDER_READ_STATUS.READY, orderId: requestedOrderId, snapshot };
  } catch (error) {
    return {
      status: SHIPMENT_ORDER_READ_STATUS.ERROR,
      orderId: requestedOrderId,
      error: { code: String(error?.code || 'SHIPMENT_ORDER_READ_FAILED'), message: String(error?.message || error) }
    };
  }
}

export async function listShipmentOrderCandidates({ limit = 100, fromDate = '', toDate = '', companyId = '' } = {}) {
  try {
    if ((fromDate && !validDate(fromDate)) || (toDate && !validDate(toDate)) || (fromDate && toDate && fromDate > toDate)) {
      throw new Error('SHIPMENT_ORDER_RANGE_INVALID');
    }
    const orders = await listOrders();
    const matchesScope = order => {
      const date = String(order.orderDate || '');
      if (fromDate && (!date || date < fromDate)) return false;
      if (toDate && (!date || date > toDate)) return false;
      if (companyId && String(order.companyId || 'ONEAPP') !== String(companyId)) return false;
      return true;
    };
    const scoped = orders.filter(matchesScope);
    const eligible = scoped.filter(order => order.orderStatus !== 'FULL_CANCEL');
    const selected = eligible.slice(0, boundedLimit(limit));
    const results = [];
    for (let offset = 0; offset < selected.length; offset += 4) {
      results.push(...await Promise.all(selected.slice(offset, offset + 4).map(order => readShipmentOrderCandidate(order.orderId))));
    }
    const candidates = results.filter(result => result.status === SHIPMENT_ORDER_READ_STATUS.READY).map(result => result.snapshot);
    const failedCount = results.filter(result => result.status === SHIPMENT_ORDER_READ_STATUS.ERROR).length;
    return {
      status: eligible.length > selected.length || failedCount > 0
        ? SHIPMENT_ORDER_READ_STATUS.PARTIAL
        : (candidates.length ? SHIPMENT_ORDER_READ_STATUS.READY : SHIPMENT_ORDER_READ_STATUS.EMPTY),
      candidates,
      examinedCount: selected.length,
      totalCount: eligible.length,
      scopedCount: scoped.length,
      repositoryTotalCount: orders.length,
      truncated: eligible.length > selected.length,
      failedCount,
      scope: { fromDate: String(fromDate || ''), toDate: String(toDate || ''), companyId: String(companyId || '') }
    };
  } catch (error) {
    return {
      status: SHIPMENT_ORDER_READ_STATUS.ERROR,
      candidates: [],
      error: { code: String(error?.code || 'SHIPMENT_ORDER_LIST_FAILED'), message: String(error?.message || error) }
    };
  }
}
