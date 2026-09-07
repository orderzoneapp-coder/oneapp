import { canonicalShoppingJson, sha256Text } from '../orderq/shopping-order-dedupe-core.js?v=0.8.0';

export const SHIPMENT_RESULT_SCHEMA = 'ONEAPP_SHIPPING_RESULT_V1';
export const SHIPMENT_STATUS = Object.freeze({
  HOLD: 'HOLD',
  CONFIRMED: 'CONFIRMED',
  REVERSED: 'REVERSED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});
export const SHIPMENT_PROGRESS_STATUS = Object.freeze({
  WAITING: 'WAITING',
  HOLD: 'HOLD',
  PARTIAL: 'PARTIAL',
  COMPLETED: 'COMPLETED',
  REVERSED: 'REVERSED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
});
export const SHIPMENT_PROGRESS_LABEL = Object.freeze({
  WAITING: '출고대기',
  HOLD: '출고보류',
  PARTIAL: '부분출고',
  COMPLETED: '출고완료',
  REVERSED: '출고취소',
  REVIEW_REQUIRED: '확인필요'
});

const text = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : null;
};
const round = value => Math.round((Number(value || 0) + Number.EPSILON) * 1e9) / 1e9;

export function shipmentCommandHash(value) {
  return sha256Text(canonicalShoppingJson(value));
}

function documentId(commandId) {
  return `SHP-${shipmentCommandHash(commandId).slice(0, 24)}`;
}

function eventId(commandId, kind) {
  return `SHE-${shipmentCommandHash(`${kind}:${commandId}`).slice(0, 24)}`;
}

export function netShippedByItem(bundles = []) {
  const result = new Map();
  bundles.forEach(bundle => {
    const status = bundle?.document?.status;
    const sign = status === SHIPMENT_STATUS.CONFIRMED ? 1 : status === SHIPMENT_STATUS.REVERSED ? -1 : 0;
    (bundle?.lines || []).forEach(line => {
      const orderItemId = text(line.orderItemId);
      if (!orderItemId) return;
      result.set(orderItemId, round((result.get(orderItemId) || 0) + sign * Math.abs(Number(line.shippedQuantity || 0))));
    });
  });
  return result;
}

export function deriveShipmentProgress({ bundles = [], currentSnapshot = null, reviewRequired = false, netByOrderItem = new Map() } = {}) {
  if (reviewRequired) return SHIPMENT_PROGRESS_STATUS.REVIEW_REQUIRED;
  const lines = currentSnapshot?.candidateLines || [];
  const shippableTotal = lines.reduce((sum, line) => sum + Math.max(0, Number(line.shippableQuantity || 0)), 0);
  const shippedTotal = lines.reduce((sum, line) => sum + Math.max(0, Number(netByOrderItem.get(line.orderItemId) || 0)), 0);
  if (shippableTotal > 0 && shippedTotal >= shippableTotal) return SHIPMENT_PROGRESS_STATUS.COMPLETED;
  if (shippedTotal > 0) return SHIPMENT_PROGRESS_STATUS.PARTIAL;
  const latest = bundles.at(-1)?.document;
  if (latest?.status === SHIPMENT_STATUS.HOLD) return SHIPMENT_PROGRESS_STATUS.HOLD;
  if (bundles.some(bundle => bundle.document.status === SHIPMENT_STATUS.REVERSED)) return SHIPMENT_PROGRESS_STATUS.REVERSED;
  return SHIPMENT_PROGRESS_STATUS.WAITING;
}

function actualProductSnapshot(snapshotLine, workspaceRow) {
  const requestedProduct = {
    productId: text(snapshotLine.productId || snapshotLine.masterProductId),
    itemCode: text(snapshotLine.itemCode),
    itemName: text(snapshotLine.itemName),
    specification: text(snapshotLine.specification),
    unit: text(snapshotLine.unit)
  };
  const actual = workspaceRow?.substitution?.actualProduct || workspaceRow || {};
  return {
    requestedProduct,
    actualProduct: {
      productId: text(actual.productId || actual.masterProductId),
      itemCode: text(actual.productCode || actual.itemCode || snapshotLine.itemCode),
      itemName: text(actual.productName || actual.itemName || snapshotLine.itemName),
      specification: text(actual.specification || snapshotLine.specification),
      unit: text(actual.sourceUnit || actual.unit || snapshotLine.unit)
    },
    substitutionEventId: text(workspaceRow?.substitution?.latestEventId)
  };
}

export function buildShipmentResult({
  commandId,
  snapshot,
  workspace = null,
  lineInputs = [],
  existingBundles = [],
  actor = 'LOCAL_USER',
  intent = SHIPMENT_STATUS.CONFIRMED,
  holdReason = '',
  occurredAt = new Date().toISOString()
} = {}) {
  const normalizedCommandId = text(commandId);
  if (!normalizedCommandId) throw new Error('출고 명령 ID가 필요합니다.');
  if (!snapshot?.orderId || !snapshot?.snapshotHash || !snapshot?.orderRevision) throw new Error('ORDER Q 주문 Snapshot이 필요합니다.');
  if (![SHIPMENT_STATUS.CONFIRMED, SHIPMENT_STATUS.HOLD].includes(intent)) throw new Error('지원하지 않는 출고 명령입니다.');
  if (intent === SHIPMENT_STATUS.CONFIRMED && !snapshot.eligible) throw new Error(`출고 확정할 수 없는 주문입니다: ${(snapshot.blockers || []).join(', ')}`);
  if (intent === SHIPMENT_STATUS.HOLD && !text(holdReason)) throw new Error('보류 사유를 입력하세요.');

  const inputByItem = new Map(lineInputs.map(input => [text(input.orderItemId), input]));
  const prior = netShippedByItem(existingBundles);
  const workspaceByItem = new Map((workspace?.orders || []).map(row => [text(row.orderItemId), row]));
  const shipmentDocumentId = documentId(normalizedCommandId);
  const lines = snapshot.candidateLines.map((sourceLine, index) => {
    const input = inputByItem.get(sourceLine.orderItemId) || {};
    const alreadyShippedQuantity = Math.max(0, Number(prior.get(sourceLine.orderItemId) || 0));
    const availableQuantity = Math.max(0, round(Number(sourceLine.shippableQuantity || 0) - alreadyShippedQuantity));
    const shippedQuantity = intent === SHIPMENT_STATUS.HOLD ? 0 : numberOrNull(input.shippedQuantity);
    if (shippedQuantity === null || shippedQuantity < 0) throw new Error(`${sourceLine.itemName || sourceLine.itemCode} 출고수량을 확인하세요.`);
    if (shippedQuantity > availableQuantity) throw new Error(`${sourceLine.itemName || sourceLine.itemCode} 출고수량이 남은 주문수량을 초과합니다.`);
    const reason = intent === SHIPMENT_STATUS.HOLD ? text(holdReason) : text(input.reason);
    if (intent === SHIPMENT_STATUS.CONFIRMED && shippedQuantity < availableQuantity && !reason) {
      throw new Error(`${sourceLine.itemName || sourceLine.itemCode} 부분출고 사유를 입력하세요.`);
    }
    return {
      schemaVersion: SHIPMENT_RESULT_SCHEMA,
      shipmentLineId: `${shipmentDocumentId}-L${String(index + 1).padStart(3, '0')}`,
      shipmentDocumentId,
      orderId: snapshot.orderId,
      orderItemId: sourceLine.orderItemId,
      sourceLineKey: sourceLine.sourceLineKey,
      lineNo: sourceLine.lineNo,
      orderedQuantity: sourceLine.orderedQuantity,
      shippableQuantity: sourceLine.shippableQuantity,
      alreadyShippedQuantity,
      shippedQuantity,
      remainingQuantity: round(availableQuantity - shippedQuantity),
      unit: sourceLine.unit,
      reason,
      ...actualProductSnapshot(sourceLine, workspaceByItem.get(sourceLine.orderItemId)),
      createdAt: occurredAt
    };
  });
  if (intent === SHIPMENT_STATUS.CONFIRMED && !lines.some(line => line.shippedQuantity > 0)) throw new Error('확정할 출고수량이 없습니다.');

  const document = {
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    shipmentDocumentId,
    commandId: normalizedCommandId,
    orderId: snapshot.orderId,
    orderNo: snapshot.orderNo,
    orderRevision: snapshot.orderRevision,
    orderSnapshotHash: snapshot.snapshotHash,
    orderUpdatedAt: snapshot.orderUpdatedAt,
    status: intent,
    holdReason: intent === SHIPMENT_STATUS.HOLD ? text(holdReason) : '',
    customerId: snapshot.customerId,
    customerName: snapshot.customerName,
    assigneeId: snapshot.assigneeId,
    assigneeName: snapshot.assigneeName,
    warehouseId: snapshot.warehouseId,
    warehouseCode: snapshot.warehouseCode,
    warehouseName: snapshot.warehouseName,
    actor: text(actor) || 'LOCAL_USER',
    confirmedAt: intent === SHIPMENT_STATUS.CONFIRMED ? occurredAt : '',
    heldAt: intent === SHIPMENT_STATUS.HOLD ? occurredAt : '',
    createdAt: occurredAt,
    updatedAt: occurredAt
  };
  const event = {
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    shipmentEventId: eventId(normalizedCommandId, intent),
    shipmentDocumentId,
    orderId: snapshot.orderId,
    eventType: intent === SHIPMENT_STATUS.CONFIRMED ? 'SHIPMENT_CONFIRMED' : 'SHIPMENT_HELD',
    actor: document.actor,
    detail: { orderRevision: snapshot.orderRevision, orderSnapshotHash: snapshot.snapshotHash, lineCount: lines.length, holdReason: document.holdReason },
    createdAt: occurredAt
  };
  const payloadHash = shipmentCommandHash({
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    commandId: normalizedCommandId,
    status: intent,
    orderId: snapshot.orderId,
    orderRevision: snapshot.orderRevision,
    orderSnapshotHash: snapshot.snapshotHash,
    actor: document.actor,
    holdReason: document.holdReason,
    lines: lines.map(line => ({
      orderItemId: line.orderItemId,
      shippedQuantity: line.shippedQuantity,
      reason: line.reason,
      actualProduct: line.actualProduct,
      substitutionEventId: line.substitutionEventId
    }))
  });
  return {
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    document,
    lines,
    events: [event],
    receipt: { commandId: normalizedCommandId, payloadHash, shipmentDocumentId, orderId: snapshot.orderId, createdAt: occurredAt }
  };
}

export function buildShipmentReversal({ commandId, originalBundle, actor = 'LOCAL_USER', reason = '', occurredAt = new Date().toISOString() } = {}) {
  const normalizedCommandId = text(commandId);
  const original = originalBundle?.document;
  if (!normalizedCommandId || !original || original.status !== SHIPMENT_STATUS.CONFIRMED) throw new Error('되돌릴 확정 출고결과가 필요합니다.');
  if (!text(reason)) throw new Error('출고 취소 사유를 입력하세요.');
  const shipmentDocumentId = documentId(normalizedCommandId);
  const document = {
    ...original,
    shipmentDocumentId,
    commandId: normalizedCommandId,
    status: SHIPMENT_STATUS.REVERSED,
    reversesShipmentDocumentId: original.shipmentDocumentId,
    reversalReason: text(reason),
    actor: text(actor) || 'LOCAL_USER',
    confirmedAt: '',
    reversedAt: occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt
  };
  const lines = (originalBundle.lines || []).map((line, index) => ({
    ...line,
    shipmentLineId: `${shipmentDocumentId}-L${String(index + 1).padStart(3, '0')}`,
    shipmentDocumentId,
    reason: text(reason),
    createdAt: occurredAt
  }));
  const event = {
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    shipmentEventId: eventId(normalizedCommandId, SHIPMENT_STATUS.REVERSED),
    shipmentDocumentId,
    orderId: original.orderId,
    eventType: 'SHIPMENT_REVERSED',
    actor: document.actor,
    detail: { reversesShipmentDocumentId: original.shipmentDocumentId, reason: text(reason) },
    createdAt: occurredAt
  };
  const payloadHash = shipmentCommandHash({
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    commandId: normalizedCommandId,
    status: SHIPMENT_STATUS.REVERSED,
    reversesShipmentDocumentId: original.shipmentDocumentId,
    actor: document.actor,
    reason: text(reason)
  });
  return {
    schemaVersion: SHIPMENT_RESULT_SCHEMA,
    document,
    lines,
    events: [event],
    receipt: { commandId: normalizedCommandId, payloadHash, shipmentDocumentId, orderId: original.orderId, createdAt: occurredAt }
  };
}
