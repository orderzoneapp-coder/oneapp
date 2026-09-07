import { getOrder, listOrders } from './order-intake-engine.js?v=0.8.0';
import { createShipmentOrderSnapshot, shipmentSnapshotMatches } from './shipment-order-read-model.js?v=0.8.0';

export const SHIPMENT_ORDER_READ_STATUS = Object.freeze({
  READY: 'READY',
  EMPTY: 'EMPTY',
  NOT_FOUND: 'NOT_FOUND',
  STALE: 'STALE',
  ERROR: 'ERROR'
});

const boundedLimit = value => Math.max(1, Math.min(200, Number(value) || 100));

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

export async function listShipmentOrderCandidates({ limit = 100 } = {}) {
  try {
    const orders = await listOrders();
    const selected = orders
      .filter(order => order.orderStatus !== 'FULL_CANCEL')
      .slice(0, boundedLimit(limit));
    const results = await Promise.all(selected.map(order => readShipmentOrderCandidate(order.orderId)));
    const candidates = results.filter(result => result.status === SHIPMENT_ORDER_READ_STATUS.READY).map(result => result.snapshot);
    return {
      status: candidates.length ? SHIPMENT_ORDER_READ_STATUS.READY : SHIPMENT_ORDER_READ_STATUS.EMPTY,
      candidates,
      examinedCount: selected.length,
      totalCount: orders.length,
      truncated: orders.length > selected.length
    };
  } catch (error) {
    return {
      status: SHIPMENT_ORDER_READ_STATUS.ERROR,
      candidates: [],
      error: { code: String(error?.code || 'SHIPMENT_ORDER_LIST_FAILED'), message: String(error?.message || error) }
    };
  }
}
