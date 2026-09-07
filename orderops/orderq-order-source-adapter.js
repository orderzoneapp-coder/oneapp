export const ORDERQ_ORDER_SOURCE_SCHEMA = 'ONEAPP_ORDEROPS_ORDERQ_SOURCE_V1';

const text = value => String(value ?? '').trim();

const draftEntry = value => {
  if (!value || typeof value !== 'object') return null;
  return {
    shippedQuantity: String(value.shippedQuantity ?? ''),
    reason: String(value.reason ?? '')
  };
};

export function orderQCandidateMatches(snapshot = {}, query = '') {
  const tokens = text(query).toLocaleLowerCase('ko-KR').split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = [
    snapshot.orderNo,
    snapshot.orderId,
    snapshot.orderDate,
    snapshot.deliveryExpectedDate,
    snapshot.customerName,
    snapshot.customerId,
    snapshot.warehouseName,
    snapshot.warehouseCode,
    snapshot.assigneeName
  ].map(value => text(value).toLocaleLowerCase('ko-KR')).join(' ');
  return tokens.every(token => haystack.includes(token));
}

export function shipmentDraftQuantity(line = {}, alreadyShippedQuantity = 0, currentDraft = null) {
  if (currentDraft && Object.prototype.hasOwnProperty.call(currentDraft, 'shippedQuantity')) {
    return String(currentDraft.shippedQuantity ?? '');
  }
  const remaining = Math.max(0, Number(line.shippableQuantity || 0) - Math.max(0, Number(alreadyShippedQuantity || 0)));
  return String(Math.round((remaining + Number.EPSILON) * 1e9) / 1e9);
}

export function reconcileShipmentDraft(previousSnapshot = {}, nextSnapshot = {}, currentDraft = {}) {
  if (text(previousSnapshot.orderId) && text(nextSnapshot.orderId) && text(previousSnapshot.orderId) !== text(nextSnapshot.orderId)) {
    return {
      draft: Object.create(null),
      retainedOrderItemIds: [],
      removedOrderItemIds: (previousSnapshot.candidateLines || []).map(line => text(line.orderItemId)).filter(Boolean),
      addedOrderItemIds: (nextSnapshot.candidateLines || []).map(line => text(line.orderItemId)).filter(Boolean)
    };
  }
  const previousLines = Array.isArray(previousSnapshot.candidateLines) ? previousSnapshot.candidateLines : [];
  const nextLines = Array.isArray(nextSnapshot.candidateLines) ? nextSnapshot.candidateLines : [];
  const previousById = new Map(previousLines.map(line => [text(line.orderItemId), line]).filter(([id]) => id));
  const previousBySource = new Map();
  const nextSourceCounts = new Map();
  previousLines.forEach(line => {
    const key = text(line.sourceLineKey);
    if (!key) return;
    if (!previousBySource.has(key)) previousBySource.set(key, []);
    previousBySource.get(key).push(line);
  });
  nextLines.forEach(line => {
    const key = text(line.sourceLineKey);
    if (key) nextSourceCounts.set(key, (nextSourceCounts.get(key) || 0) + 1);
  });

  const nextDraft = Object.create(null);
  const matchedPreviousIds = new Set();
  const retainedOrderItemIds = [];
  const addedOrderItemIds = [];
  nextLines.forEach(line => {
    const nextId = text(line.orderItemId);
    let previousId = previousById.has(nextId) ? nextId : '';
    if (!previousId) {
      const sourceKey = text(line.sourceLineKey);
      const matches = previousBySource.get(sourceKey) || [];
      if (sourceKey && matches.length === 1 && nextSourceCounts.get(sourceKey) === 1) previousId = text(matches[0].orderItemId);
    }
    const retained = previousId ? draftEntry(currentDraft[previousId]) : null;
    if (previousId) matchedPreviousIds.add(previousId);
    if (retained && nextId) {
      nextDraft[nextId] = retained;
      retainedOrderItemIds.push(nextId);
    } else if (!previousId && nextId) {
      addedOrderItemIds.push(nextId);
    }
  });
  const removedOrderItemIds = previousLines
    .map(line => text(line.orderItemId))
    .filter(id => id && !matchedPreviousIds.has(id));
  return { draft: nextDraft, retainedOrderItemIds, removedOrderItemIds, addedOrderItemIds };
}

export function mapOrderQSnapshotToParsedOrders(snapshot) {
  const rows = (snapshot.candidateLines || []).map((line, index) => ({
    inputOrder: index + 1,
    sourceRowNumber: index + 2,
    sourceKind: 'ORDERQ_READ_MODEL',
    orderId: snapshot.orderId,
    orderRevision: snapshot.orderRevision,
    orderSnapshotHash: snapshot.snapshotHash,
    orderItemId: line.orderItemId,
    sourceLineKey: line.sourceLineKey,
    orderNumber: snapshot.orderNo,
    basisDate: snapshot.orderDate,
    basisDateStatus: 'valid',
    basisDateCandidates: [{ field: 'ORDER_Q', value: snapshot.orderDate, basisDate: snapshot.orderDate }],
    manager: snapshot.assigneeName,
    warehouse: snapshot.warehouseName || snapshot.warehouseCode,
    sourceUnit: line.unit,
    productCode: line.itemCode,
    productName: line.itemName,
    specification: line.specification,
    quantity: line.shippableQuantity,
    sourceStock: '',
    unitPrice: line.unitPrice,
    supplyAmount: line.supplyAmount,
    note: line.memo,
    note1: line.description,
    noteOriginal: line.memo,
    note1Original: line.description,
    customer: snapshot.customerName,
    group: snapshot.orderNo
  }));
  return {
    kind: 'orders',
    sourceKind: 'ORDERQ_READ_MODEL',
    sourceSchemaVersion: ORDERQ_ORDER_SOURCE_SCHEMA,
    orderId: snapshot.orderId,
    orderNo: snapshot.orderNo,
    orderRevision: snapshot.orderRevision,
    orderSnapshotHash: snapshot.snapshotHash,
    orderUpdatedAt: snapshot.orderUpdatedAt,
    fileName: `ORDER Q · ${snapshot.orderNo || snapshot.orderId}`,
    sheetName: 'ORDER Q Read Model',
    fileHash: snapshot.snapshotHash,
    headerRowIndex: -1,
    headerRowNumber: null,
    headers: [],
    requiredColumns: [],
    optionalColumns: [],
    missingColumns: [],
    rows,
    rowCount: rows.length,
    memoCount: rows.filter(row => row.note || row.note1).length,
    zeroQuantityCount: rows.filter(row => row.quantity === 0).length,
    negativeQuantityCount: rows.filter(row => row.quantity < 0).length,
    errors: snapshot.eligible ? [] : [{ code: 'ORDERQ_ORDER_NOT_ELIGIBLE', message: snapshot.blockers.join(', ') }],
    warnings: [],
    headerMapping: { schemaVersion: 'shipping-orderq-read-model-mapping/v1', normalization: 'not-applicable', columns: [] },
    sourceMatrix: [],
    productCodeColumnIndex: -1
  };
}

export async function loadOrderQOrderSource(orderId, expectations = {}) {
  const { readShipmentOrderCandidate } = await import('../orderq/shipment-order-read-adapter.js?v=0.8.0');
  const result = await readShipmentOrderCandidate(orderId, expectations);
  if (!result.snapshot) return result;
  return { ...result, parsedOrders: mapOrderQSnapshotToParsedOrders(result.snapshot) };
}

export async function listOrderQOrderSources(options = {}) {
  const { listShipmentOrderCandidates } = await import('../orderq/shipment-order-read-adapter.js?v=0.8.0');
  return listShipmentOrderCandidates(options);
}
