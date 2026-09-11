import { readShipmentOrderCandidate } from '../orderq/shipment-order-read-adapter.js?v=0.8.1';
import { buildShipmentResult, buildShipmentReversal, SHIPMENT_STATUS } from './shipment-result-core.js?v=1.0.0';
import { commitShipmentBundle, listShipmentDocumentsByOrder, readShipmentDocument } from './shipment-result-repository.js?v=1.0.0';
import { readShipmentResultsByOrder } from './shipment-result-read-adapter.js?v=1.0.1';

export class ShipmentOrderConflictError extends Error {
  constructor(result) {
    super('주문이 출고 작업 시작 후 변경되었습니다. 최신 주문을 다시 불러온 뒤 출고수량을 확인하세요.');
    this.name = 'ShipmentOrderConflictError';
    this.code = 'SHIPMENT_ORDER_REVISION_CONFLICT';
    this.latest = result?.snapshot || null;
  }
}

async function verifiedSnapshot(orderId, expectedOrderRevision, expectedSnapshotHash) {
  const result = await readShipmentOrderCandidate(orderId, { expectedRevision: expectedOrderRevision, expectedSnapshotHash });
  if (result.status === 'STALE') throw new ShipmentOrderConflictError(result);
  if (result.status !== 'READY') throw new Error(result.error?.message || `출고 가능한 주문을 읽지 못했습니다. (${result.status})`);
  return result.snapshot;
}

export async function confirmShipment(command = {}) {
  const snapshot = await verifiedSnapshot(command.orderId, command.expectedOrderRevision, command.expectedSnapshotHash);
  const existingBundles = await listShipmentDocumentsByOrder(command.orderId);
  const priorBundles = existingBundles.filter(existing => existing.document.commandId !== command.commandId);
  const bundle = buildShipmentResult({ ...command, snapshot, existingBundles: priorBundles, intent: SHIPMENT_STATUS.CONFIRMED });
  await verifiedSnapshot(command.orderId, snapshot.orderRevision, snapshot.snapshotHash);
  const committed = await commitShipmentBundle(bundle);
  const verification = await readShipmentResultsByOrder(command.orderId);
  return { ...committed, verification };
}

export async function holdShipment(command = {}) {
  const snapshot = await verifiedSnapshot(command.orderId, command.expectedOrderRevision, command.expectedSnapshotHash);
  const bundle = buildShipmentResult({ ...command, snapshot, intent: SHIPMENT_STATUS.HOLD });
  await verifiedSnapshot(command.orderId, snapshot.orderRevision, snapshot.snapshotHash);
  return commitShipmentBundle(bundle);
}

export async function reverseShipment({ shipmentDocumentId, commandId, actor, reason, occurredAt } = {}) {
  const originalBundle = await readShipmentDocument(shipmentDocumentId);
  if (originalBundle) {
    const existingBundles = await listShipmentDocumentsByOrder(originalBundle.document.orderId);
    if (existingBundles.some(bundle => bundle.document.reversesShipmentDocumentId === shipmentDocumentId)) {
      throw new Error('이미 취소된 출고결과입니다.');
    }
  }
  const bundle = buildShipmentReversal({ commandId, originalBundle, actor, reason, occurredAt });
  return commitShipmentBundle(bundle);
}
