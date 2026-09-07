import { readShipmentOrderCandidate } from '../orderq/shipment-order-read-adapter.js?v=0.8.0';
import { listShipmentDocumentsByOrder } from './shipment-result-repository.js?v=1.0.0';
import {
  deriveShipmentProgress,
  netShippedByItem,
  SHIPMENT_PROGRESS_LABEL,
  SHIPMENT_PROGRESS_STATUS,
  SHIPMENT_STATUS
} from './shipment-result-core.js?v=1.0.0';

export async function readShipmentResultsByOrder(orderId) {
  try {
    const [bundles, currentOrder] = await Promise.all([
      listShipmentDocumentsByOrder(orderId),
      readShipmentOrderCandidate(orderId)
    ]);
    const currentSnapshot = currentOrder.snapshot || null;
    const reversedIds = new Set(bundles.map(bundle => bundle.document.reversesShipmentDocumentId).filter(Boolean));
    const results = bundles.map(bundle => {
      const frozenMatches = Boolean(currentSnapshot
        && Number(currentSnapshot.orderRevision) === Number(bundle.document.orderRevision)
        && currentSnapshot.snapshotHash === bundle.document.orderSnapshotHash);
      const reviewRequired = bundle.document.status === SHIPMENT_STATUS.CONFIRMED
        && !reversedIds.has(bundle.document.shipmentDocumentId)
        && !frozenMatches;
      return {
        ...bundle,
        frozenMatches,
        reviewRequired,
        displayStatus: reviewRequired ? SHIPMENT_STATUS.REVIEW_REQUIRED : bundle.document.status
      };
    });
    const netByOrderItem = netShippedByItem(bundles);
    const reviewRequired = results.some(result => result.reviewRequired);
    const shipmentStatus = deriveShipmentProgress({ bundles, currentSnapshot, reviewRequired, netByOrderItem });
    return {
      status: results.length ? 'READY' : 'EMPTY',
      orderId,
      currentOrderStatus: currentOrder.status,
      currentSnapshot,
      results,
      reviewRequired,
      shipmentStatus,
      shipmentStatusLabel: SHIPMENT_PROGRESS_LABEL[shipmentStatus],
      netByOrderItem: Object.fromEntries(netByOrderItem)
    };
  } catch (error) {
    return { status: 'ERROR', orderId, results: [], reviewRequired: false, shipmentStatus: SHIPMENT_PROGRESS_STATUS.REVIEW_REQUIRED, shipmentStatusLabel: SHIPMENT_PROGRESS_LABEL.REVIEW_REQUIRED, netByOrderItem: {}, error: { code: error?.code || 'SHIPMENT_RESULT_READ_FAILED', message: error?.message || String(error) } };
  }
}
