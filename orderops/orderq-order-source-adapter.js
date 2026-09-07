export const ORDERQ_ORDER_SOURCE_SCHEMA = 'ONEAPP_ORDEROPS_ORDERQ_SOURCE_V1';

export function mapOrderQSnapshotToParsedOrders(snapshot) {
  const rows = snapshot.candidateLines.map((line, index) => ({
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
  const { readShipmentOrderCandidate, SHIPMENT_ORDER_READ_STATUS } = await import('../orderq/shipment-order-read-adapter.js?v=0.8.0');
  const result = await readShipmentOrderCandidate(orderId, expectations);
  if (result.status !== SHIPMENT_ORDER_READ_STATUS.READY) return result;
  return { ...result, parsedOrders: mapOrderQSnapshotToParsedOrders(result.snapshot) };
}
