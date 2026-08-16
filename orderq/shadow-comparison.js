const EPSILON = 1e-9;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function number(value) {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error(`ORDERQ_SHADOW_NUMBER_INVALID:${value}`);
  return result;
}

function sameNumber(left, right) {
  return Math.abs(number(left) - number(right)) <= EPSILON;
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
}

function movementKind(value) {
  const movement = value && typeof value === 'object' ? value : { movementType:value };
  const type = text(movement.movementType).toUpperCase();
  const sourceDocumentType = text(movement.sourceDocumentType).toUpperCase();
  if (type === 'PURCHASE_RECEIPT') return 'PURCHASE';
  if (type === 'SALE_ISSUE') return 'SALE';
  if (type === 'REVERSAL' && sourceDocumentType === 'PURCHASE_REVERSAL') return 'PURCHASE';
  if (type === 'REVERSAL' && sourceDocumentType === 'DISPATCH_REVERSAL') return 'SALE';
  return 'OTHER';
}

export function normalizeLegacyShadowRows(ledgerRows = [], source = {}) {
  const basisDate = text(source.basisDate);
  const sourceFingerprint = text(source.sourceFingerprint);
  return ledgerRows.map((row, index) => ({
    productKey: text(row.productCode || row.productId || `LEGACY-${index + 1}`),
    productCode: text(row.productCode),
    productName: text(row.productName),
    basisDate,
    sourceFingerprint,
    snapshotQuantity: number(row.stockQuantity ?? row.stockTotal ?? row.values?.[4] ?? 0),
    purchaseQuantity: number(row.inboundQuantity ?? row.values?.[5] ?? 0),
    orderRequestQuantity: number(row.orderQuantity ?? row.values?.[6] ?? 0),
    actualSalesQuantity: number(row.salesQuantity ?? row.values?.[7] ?? 0),
    evidenceIds: unique([
      sourceFingerprint,
      row.sourceRowId,
      row.sourceOrderId,
      row.inventorySourceId,
      ...(Array.isArray(row.evidenceIds) ? row.evidenceIds : [])
    ])
  }));
}

export function normalizeOrderQShadowRows(projection = {}, source = {}) {
  const basisDate = text(projection?.basis?.basisDate);
  return (projection.rows || []).map((row, index) => {
    const movements = row.movementEvidence || [];
    const purchaseQuantity = movements.filter(item => movementKind(item) === 'PURCHASE')
      .reduce((sum, item) => sum + number(item.signedBaseQuantity), 0);
    const saleSignedQuantity = movements.filter(item => movementKind(item) === 'SALE')
      .reduce((sum, item) => sum + number(item.signedBaseQuantity), 0);
    const otherMovementQuantity = movements.filter(item => movementKind(item) === 'OTHER')
      .reduce((sum, item) => sum + number(item.signedBaseQuantity), 0);
    return {
      productKey: text(row.productCode || row.productId || row.productKey || `VNEXT-${index + 1}`),
      productCode: text(row.productCode),
      productName: text(source.productNames?.[row.productId] || ''),
      basisDate,
      snapshotLastSequence: number(row.snapshotLastSequence || 0),
      snapshotQuantity: number(row.snapshotQuantity || 0),
      purchaseQuantity,
      actualSalesQuantity: -saleSignedQuantity,
      otherMovementQuantity,
      reservationQuantity: number(row.reservedQuantity || 0),
      onHandQuantity: number(row.onHandQuantity || 0),
      availableQuantity: number(row.availableQuantity || 0),
      evidenceIds: unique([
        ...(row.snapshotEvidence || []).flatMap(item => [item.inventorySnapshotId, item.inventoryLineId]),
        ...movements.flatMap(item => [item.movementId, item.sourceDocumentId, item.sourceLineId]),
        ...(Array.isArray(row.reservationEvidence) ? row.reservationEvidence.flatMap(item => [item.reservationId, item.allocationId]) : [])
      ])
    };
  });
}

function aggregate(rows) {
  const result = new Map();
  rows.forEach(row => {
    const key = text(row.productKey || row.productCode);
    if (!key) return;
    const current = result.get(key) || {
      productKey: key,
      productCode: text(row.productCode),
      productName: text(row.productName),
      basisDates: [],
      snapshotQuantity: 0,
      purchaseQuantity: 0,
      actualSalesQuantity: 0,
      orderRequestQuantity: 0,
      otherMovementQuantity: 0,
      reservationQuantity: 0,
      evidenceIds: []
    };
    current.snapshotQuantity += number(row.snapshotQuantity || 0);
    current.purchaseQuantity += number(row.purchaseQuantity || 0);
    current.actualSalesQuantity += number(row.actualSalesQuantity || 0);
    current.orderRequestQuantity += number(row.orderRequestQuantity || 0);
    current.otherMovementQuantity += number(row.otherMovementQuantity || 0);
    current.reservationQuantity += number(row.reservationQuantity || 0);
    current.basisDates.push(text(row.basisDate));
    current.evidenceIds.push(...(row.evidenceIds || []));
    result.set(key, current);
  });
  result.forEach(row => {
    row.basisDates = unique(row.basisDates);
    row.evidenceIds = unique(row.evidenceIds);
  });
  return result;
}

export function compareShadowFacts({ legacyRows = [], orderQRows = [] } = {}) {
  const legacy = aggregate(legacyRows);
  const orderq = aggregate(orderQRows);
  const keys = unique([...legacy.keys(), ...orderq.keys()]);
  const rows = keys.map(productKey => {
    const left = legacy.get(productKey);
    const right = orderq.get(productKey);
    const reasonCodes = [];
    if (!left || !right) reasonCodes.push('MAPPING_MISSING');
    const legacyBasis = left?.basisDates || [];
    const orderqBasis = right?.basisDates || [];
    if (left && right && legacyBasis.join('|') !== orderqBasis.join('|')) reasonCodes.push('BASIS_MISMATCH');
    if (left && right && !sameNumber(left.snapshotQuantity, right.snapshotQuantity)) reasonCodes.push('OPENING_DIFFERENCE');
    if (left && right && !sameNumber(left.purchaseQuantity, right.purchaseQuantity)) reasonCodes.push('PURCHASE_DIFFERENCE');
    if (left && right && !sameNumber(left.actualSalesQuantity, right.actualSalesQuantity)) reasonCodes.push('SALE_DIFFERENCE');
    if (left && right && !sameNumber(right.otherMovementQuantity, 0)) reasonCodes.push('OTHER_MOVEMENT_DIFFERENCE');
    if (left && right && !sameNumber(left.orderRequestQuantity, right.reservationQuantity)) {
      reasonCodes.push('REQUEST_RESERVATION_DIFFERENCE', 'ORDER_REQUEST_NOT_SALE');
    }
    if (!reasonCodes.length) reasonCodes.push('MATCH');
    const legacyOnHand = left ? left.snapshotQuantity + left.purchaseQuantity - left.actualSalesQuantity : null;
    const orderQOnHand = right
      ? right.snapshotQuantity + right.purchaseQuantity - right.actualSalesQuantity + right.otherMovementQuantity
      : null;
    const legacyRequestedAvailable = left ? legacyOnHand - left.orderRequestQuantity : null;
    const orderQAvailable = right ? orderQOnHand - right.reservationQuantity : null;
    return {
      productKey,
      productCode: left?.productCode || right?.productCode || productKey,
      productName: left?.productName || right?.productName || '',
      basis: { legacy: legacyBasis, orderq: orderqBasis },
      axes: {
        snapshot: { legacy: left?.snapshotQuantity ?? null, orderq: right?.snapshotQuantity ?? null },
        purchase: { legacy: left?.purchaseQuantity ?? null, orderq: right?.purchaseQuantity ?? null },
        actualSale: { legacy: left?.actualSalesQuantity ?? null, orderq: right?.actualSalesQuantity ?? null },
        orderRequestVsReservation: { legacy: left?.orderRequestQuantity ?? null, orderq: right?.reservationQuantity ?? null },
        onHand: { legacy: legacyOnHand, orderq: orderQOnHand },
        available: { legacy: legacyRequestedAvailable, orderq: orderQAvailable }
      },
      reasonCodes: unique(reasonCodes),
      evidenceIds: { legacy: left?.evidenceIds || [], orderq: right?.evidenceIds || [] },
      matched: reasonCodes.length === 1 && reasonCodes[0] === 'MATCH'
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    rows,
    summary: {
      total: rows.length,
      matched: rows.filter(row => row.matched).length,
      differences: rows.filter(row => !row.matched).length,
      reasonCounts: rows.flatMap(row => row.reasonCodes).reduce((result, code) => {
        result[code] = (result[code] || 0) + 1;
        return result;
      }, {})
    }
  };
}
