import { canonicalShoppingJson, sha256Text } from './shopping-order-dedupe-core.js?v=0.8.0';

export const SHIPMENT_ORDER_READ_MODEL_SCHEMA = 'ONEAPP_ORDERQ_SHIPMENT_CANDIDATE_V1';

const text = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : null;
};

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function lineSnapshot(order, item = {}, index = 0) {
  const orderedQuantity = numberOrNull(item.finalQuantity ?? item.rawQuantity ?? item.quantity);
  const cancelledQuantity = order.orderStatus === 'FULL_CANCEL' || item.matchStatus === 'CANCELLED' || item.active === false
    ? orderedQuantity
    : numberOrNull(item.cancelledQuantity) ?? 0;
  const shippableQuantity = orderedQuantity === null
    ? null
    : Math.max(0, orderedQuantity - Math.max(0, cancelledQuantity || 0));
  return {
    orderItemId: text(item.orderItemId),
    lineNo: Number(item.lineNo) || index + 1,
    sourceLineKey: text(item.sourceLineKey),
    productId: text(item.productId),
    masterProductId: text(item.masterProductId),
    itemCode: text(item.itemCode),
    itemName: text(item.itemName),
    specification: text(item.specification),
    unit: text(item.finalUnit || item.rawUnit),
    unitPrice: numberOrNull(item.price),
    supplyAmount: numberOrNull(item.supplyAmount),
    orderedQuantity,
    cancelledQuantity,
    shippableQuantity,
    matchStatus: text(item.matchStatus),
    reviewStatus: text(item.reviewStatus),
    productIdentityStatus: text(item.productIdentityStatus),
    memo: text(item.memo),
    description: text(item.description)
  };
}

function hashBasis(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    orderId: snapshot.orderId,
    orderNo: snapshot.orderNo,
    orderRevision: snapshot.orderRevision,
    orderUpdatedAt: snapshot.orderUpdatedAt,
    orderDate: snapshot.orderDate,
    orderStatus: snapshot.orderStatus,
    adminStatus: snapshot.adminStatus,
    opsStatus: snapshot.opsStatus,
    customerId: snapshot.customerId,
    customerName: snapshot.customerName,
    assigneeId: snapshot.assigneeId,
    assigneeName: snapshot.assigneeName,
    warehouseId: snapshot.warehouseId,
    warehouseCode: snapshot.warehouseCode,
    warehouseName: snapshot.warehouseName,
    deliveryRegion: snapshot.deliveryRegion,
    deliveryExpectedDate: snapshot.deliveryExpectedDate,
    inputChannel: snapshot.inputChannel,
    sourceDocumentKey: snapshot.sourceDocumentKey,
    lines: snapshot.lines
  };
}

export function createShipmentOrderSnapshot(bundle = {}, { generatedAt = new Date().toISOString() } = {}) {
  const order = bundle.order || {};
  const lines = (bundle.items || [])
    .filter(item => item.matchStatus !== 'EXCLUDED')
    .map((item, index) => lineSnapshot(order, item, index))
    .sort((left, right) => left.lineNo - right.lineNo || left.orderItemId.localeCompare(right.orderItemId));
  const blockers = [];
  if (order.orderStatus === 'FULL_CANCEL') blockers.push('ORDER_FULL_CANCELLED');
  if (order.adminStatus === 'HOLD') blockers.push('ORDER_ON_HOLD');
  if (!Number.isInteger(Number(order.revision)) || Number(order.revision) < 1) blockers.push('ORDER_REVISION_INVALID');
  if (lines.some(line => !line.orderItemId || line.shippableQuantity === null)) blockers.push('ORDER_LINE_INVALID');
  const candidateLines = lines.filter(line => Number(line.shippableQuantity) > 0);
  const snapshot = {
    schemaVersion: SHIPMENT_ORDER_READ_MODEL_SCHEMA,
    generatedAt,
    orderId: text(order.orderId),
    orderNo: text(order.orderNo),
    orderRevision: Number(order.revision) || 0,
    orderUpdatedAt: text(order.updatedAt),
    orderDate: text(order.orderDate),
    deliveryExpectedDate: text(order.deliveryExpectedDate),
    customerId: text(order.customerId),
    customerName: text(order.customerName),
    assigneeId: text(order.assigneeId),
    assigneeName: text(order.assigneeName),
    warehouseId: text(order.warehouseId),
    warehouseCode: text(order.warehouseCode),
    warehouseName: text(order.warehouseName || order.warehouse),
    deliveryRegion: text(order.deliveryRegion || order.region),
    orderStatus: text(order.orderStatus),
    adminStatus: text(order.adminStatus),
    opsStatus: text(order.opsStatus),
    inputChannel: text(order.inputChannel),
    sourceDocumentKey: text(order.sourceDocumentKey),
    eligible: blockers.length === 0 && candidateLines.length > 0,
    blockers,
    lines,
    candidateLines
  };
  snapshot.snapshotHash = sha256Text(canonicalShoppingJson(hashBasis(snapshot)));
  return deepFreeze(snapshot);
}

export function shipmentSnapshotMatches(snapshot, { expectedRevision, expectedSnapshotHash } = {}) {
  if (expectedRevision !== undefined && Number(expectedRevision) !== Number(snapshot?.orderRevision)) return false;
  if (expectedSnapshotHash && text(expectedSnapshotHash) !== text(snapshot?.snapshotHash)) return false;
  return true;
}
