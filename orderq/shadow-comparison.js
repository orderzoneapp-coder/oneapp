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
  return ledgerRows.map((row, index) => {
    const currentRemainingRaw = row.remainingQuantity ?? row.values?.[8];
    const hasCurrentRemainingEvidence = currentRemainingRaw !== ''
      && currentRemainingRaw !== null
      && currentRemainingRaw !== undefined;
    return {
      productKey: text(row.productCode || row.productId || `LEGACY-${index + 1}`),
      productCode: text(row.productCode),
      productName: text(row.productName),
      basisDate,
      sourceFingerprint,
      snapshotQuantity: number(row.stockQuantity ?? row.stockTotal ?? row.values?.[4] ?? 0),
      purchaseQuantity: number(row.inboundQuantity ?? row.values?.[5] ?? 0),
      orderRequestQuantity: number(row.orderQuantity ?? row.values?.[6] ?? 0),
      actualSalesQuantity: number(row.salesQuantity ?? row.values?.[7] ?? 0),
      currentRemainingQuantity: hasCurrentRemainingEvidence ? number(currentRemainingRaw) : null,
      hasCurrentRemainingEvidence,
      evidenceIds: unique([
        sourceFingerprint,
        row.sourceRowId,
        row.sourceOrderId,
        row.inventorySourceId,
        ...(Array.isArray(row.evidenceIds) ? row.evidenceIds : [])
      ])
    };
  });
}

function dataOpsRowValues(row = {}) {
  const baseQuantity = number(row.baseQty ?? row.기초 ?? 0);
  const purchaseQuantity = number(row.inQty ?? row.입고 ?? 0);
  const saleQuantity = number(row.outQty ?? row.출고 ?? 0);
  const substitutionInQuantity = number(row.subInQty ?? row.대체입고 ?? 0);
  const substitutionOutQuantity = number(row.subOutQty ?? row.대체출고 ?? 0);
  const systemRemainingQuantity = baseQuantity + purchaseQuantity + substitutionInQuantity
    - saleQuantity - substitutionOutQuantity;
  const actualRaw = row.finalQty ?? row.실사;
  const currentRemainingQuantity = actualRaw === '' || actualRaw === null || actualRaw === undefined
    ? systemRemainingQuantity
    : number(actualRaw);
  const inventoryAdjustmentQuantity = currentRemainingQuantity - systemRemainingQuantity;
  const reportedLossRaw = row.diffQty ?? row.로스;
  const lossQuantity = reportedLossRaw === '' || reportedLossRaw === null || reportedLossRaw === undefined
    ? inventoryAdjustmentQuantity
    : number(reportedLossRaw);
  return {
    baseQuantity,
    purchaseQuantity,
    saleQuantity,
    substitutionInQuantity,
    substitutionOutQuantity,
    substitutionAdjustmentQuantity: substitutionInQuantity - substitutionOutQuantity,
    systemRemainingQuantity,
    currentRemainingQuantity,
    inventoryAdjustmentQuantity,
    lossQuantity
  };
}

function manualSubstitutionEvidence(row = {}, historyRows = []) {
  const rowKey = text(row.batchKey || row.sourceRowId || row.rowId);
  const issueText = Array.isArray(row.이슈) ? row.이슈.map(text).join(' ') : text(row.이슈);
  const memoText = text(row.메모 || row.memo);
  const linkedHistory = historyRows.filter(history => [history?.sourceKey, history?.targetKey]
    .map(text).includes(rowKey));
  const manual = row._manualSubstitutionResolved === true
    || /수기치환/.test(`${issueText} ${memoText}`)
    || linkedHistory.some(history => text(history?.type).toUpperCase() === 'MANUAL_LOSS_LINK');
  let quantified = false;
  const historyQuantity = linkedHistory.reduce((sum, history) => {
    if (text(history?.type).toUpperCase() !== 'MANUAL_LOSS_LINK') return sum;
    if (text(history?.sourceKey) === rowKey && history?.sQty !== undefined && history?.sQty !== null && history?.sQty !== '') {
      quantified = true;
      return sum - Math.abs(number(history.sQty));
    }
    if (text(history?.targetKey) === rowKey && history?.tQty !== undefined && history?.tQty !== null && history?.tQty !== '') {
      quantified = true;
      return sum + Math.abs(number(history.tQty));
    }
    return sum;
  }, 0);
  return {
    manual,
    quantified,
    historyQuantity,
    evidenceIds: unique(linkedHistory.flatMap(history => [
      history?.id && `DATAOPS_HISTORY:${history.id}`,
      history?.sourceKey,
      history?.targetKey
    ]))
  };
}

export function normalizeDataOpsShadowRows(productData = [], source = {}) {
  const sourceFingerprint = text(source.sourceFingerprint);
  const savedAt = text(source.savedAt);
  const historyRows = Array.isArray(source.substHistory) ? source.substHistory : [];
  return (Array.isArray(productData) ? productData : []).map((row, index) => {
    const values = dataOpsRowValues(row);
    const rowKey = text(row.batchKey || row.sourceRowId || row.rowId || `DATAOPS-${index + 1}`);
    const manual = manualSubstitutionEvidence(row, historyRows);
    return {
      productKey: text(row.코드 || row.productCode || row.productId || `DATAOPS-${index + 1}`)
        .replace(/\.0$/, ''),
      productCode: text(row.코드 || row.productCode).replace(/\.0$/, ''),
      productName: text(row.품명 || row.productName),
      savedAt,
      sourceFingerprint,
      ...values,
      manualSubstitutionQuantity: manual.manual
        ? (manual.quantified ? manual.historyQuantity : values.lossQuantity)
        : 0,
      evidenceIds: unique([
        sourceFingerprint && `DATAOPS_WORKSPACE:${sourceFingerprint}`,
        savedAt && `DATAOPS_SAVED_AT:${savedAt}`,
        rowKey,
        ...manual.evidenceIds
      ]),
      adjustmentEvidence: {
        evidenceId: rowKey,
        manualSubstitution: manual.manual,
        currentRemainingQuantity: values.currentRemainingQuantity,
        systemRemainingQuantity: values.systemRemainingQuantity,
        inventoryAdjustmentQuantity: values.inventoryAdjustmentQuantity,
        substitutionInQuantity: values.substitutionInQuantity,
        substitutionOutQuantity: values.substitutionOutQuantity,
        lossQuantity: values.lossQuantity
      }
    };
  });
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
      currentRemainingQuantity: 0,
      hasCurrentRemainingEvidence: false,
      otherMovementQuantity: 0,
      reservationQuantity: 0,
      onHandQuantity: 0,
      availableQuantity: 0,
      evidenceIds: []
    };
    current.snapshotQuantity += number(row.snapshotQuantity || 0);
    current.purchaseQuantity += number(row.purchaseQuantity || 0);
    current.actualSalesQuantity += number(row.actualSalesQuantity || 0);
    current.orderRequestQuantity += number(row.orderRequestQuantity || 0);
    const hasCurrentRemainingEvidence = row.hasCurrentRemainingEvidence === true
      || (row.hasCurrentRemainingEvidence !== false
        && row.currentRemainingQuantity !== undefined
        && row.currentRemainingQuantity !== null
        && row.currentRemainingQuantity !== '');
    if (hasCurrentRemainingEvidence) {
      current.currentRemainingQuantity += number(row.currentRemainingQuantity);
      current.hasCurrentRemainingEvidence = true;
    }
    current.otherMovementQuantity += number(row.otherMovementQuantity || 0);
    current.reservationQuantity += number(row.reservationQuantity || 0);
    current.onHandQuantity += number(row.onHandQuantity || 0);
    current.availableQuantity += number(row.availableQuantity || 0);
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

function aggregateDataOps(rows) {
  const result = new Map();
  rows.forEach(row => {
    const key = text(row.productKey || row.productCode);
    if (!key) return;
    const current = result.get(key) || {
      productKey: key,
      productCode: text(row.productCode),
      productName: text(row.productName),
      currentRemainingQuantity: 0,
      systemRemainingQuantity: 0,
      inventoryAdjustmentQuantity: 0,
      substitutionAdjustmentQuantity: 0,
      manualSubstitutionQuantity: 0,
      lossQuantity: 0,
      evidenceIds: [],
      adjustmentEvidence: []
    };
    current.currentRemainingQuantity += number(row.currentRemainingQuantity || 0);
    current.systemRemainingQuantity += number(row.systemRemainingQuantity || 0);
    current.inventoryAdjustmentQuantity += number(row.inventoryAdjustmentQuantity || 0);
    current.substitutionAdjustmentQuantity += number(row.substitutionAdjustmentQuantity || 0);
    current.manualSubstitutionQuantity += number(row.manualSubstitutionQuantity || 0);
    current.lossQuantity += number(row.lossQuantity || 0);
    current.evidenceIds.push(...(row.evidenceIds || []));
    if (row.adjustmentEvidence) current.adjustmentEvidence.push(row.adjustmentEvidence);
    result.set(key, current);
  });
  result.forEach(row => { row.evidenceIds = unique(row.evidenceIds); });
  return result;
}

export function compareShadowFacts({
  legacyRows = [],
  orderQRows = [],
  dataOpsRows = [],
  requireDataOpsEvidence = false
} = {}) {
  const legacy = aggregate(legacyRows);
  const orderq = aggregate(orderQRows);
  const dataops = aggregateDataOps(dataOpsRows);
  // Shadow의 비교 모집단은 기존 OrderOps와 ORDER Q가 정의한다. DataOps는
  // 두 시스템의 품목에 조정 근거를 보강할 뿐, DataOps 전용 품목을 전환
  // 대상에 자동 편입하지 않는다.
  const keys = unique([...legacy.keys(), ...orderq.keys()]);
  const rows = keys.map(productKey => {
    const left = legacy.get(productKey);
    const right = orderq.get(productKey);
    const adjustment = dataops.get(productKey);
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
    if (left && right && left.hasCurrentRemainingEvidence
      && !sameNumber(left.currentRemainingQuantity, right.availableQuantity)) {
      reasonCodes.push('ORDEROPS_CURRENT_AVAILABLE_DIFFERENCE');
    }
    if (left && right && requireDataOpsEvidence && !adjustment) {
      reasonCodes.push('DATAOPS_ADJUSTMENT_EVIDENCE_MISSING');
    }
    if (adjustment && right && !sameNumber(adjustment.currentRemainingQuantity, right.onHandQuantity)) {
      reasonCodes.push('DATAOPS_CURRENT_REMAINING_DIFFERENCE');
    }
    if (adjustment && !sameNumber(adjustment.manualSubstitutionQuantity, 0)) {
      reasonCodes.push('MANUAL_SUBSTITUTION_ADJUSTMENT_PRESENT');
    }
    if (adjustment && !sameNumber(adjustment.inventoryAdjustmentQuantity, 0)) {
      reasonCodes.push('INVENTORY_ADJUSTMENT_PRESENT');
    }
    if (adjustment && !sameNumber(adjustment.substitutionAdjustmentQuantity, 0)) {
      reasonCodes.push('SUBSTITUTION_ADJUSTMENT_PRESENT');
    }
    if (adjustment && !sameNumber(adjustment.lossQuantity, 0)) {
      reasonCodes.push('LOSS_ADJUSTMENT_PRESENT');
    }
    if (adjustment && right
      && !sameNumber(adjustment.inventoryAdjustmentQuantity + adjustment.substitutionAdjustmentQuantity,
        right.otherMovementQuantity)) {
      reasonCodes.push('ADJUSTMENT_MOVEMENT_DIFFERENCE');
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
        available: { legacy: legacyRequestedAvailable, orderq: orderQAvailable },
        orderOpsCurrentAvailable: {
          legacy: left?.hasCurrentRemainingEvidence ? left.currentRemainingQuantity : null,
          orderq: right?.availableQuantity ?? null
        },
        dataOpsCurrentOnHand: {
          legacy: adjustment?.currentRemainingQuantity ?? null,
          orderq: right?.onHandQuantity ?? null
        },
        adjustment: {
          legacy: adjustment
            ? adjustment.inventoryAdjustmentQuantity + adjustment.substitutionAdjustmentQuantity
            : null,
          orderq: right?.otherMovementQuantity ?? null
        },
        manualSubstitution: { legacy: adjustment?.manualSubstitutionQuantity ?? null, orderq: null },
        loss: { legacy: adjustment?.lossQuantity ?? null, orderq: null }
      },
      reasonCodes: unique(reasonCodes),
      evidenceIds: {
        legacy: left?.evidenceIds || [],
        dataops: adjustment?.evidenceIds || [],
        orderq: right?.evidenceIds || []
      },
      adjustmentEvidence: adjustment?.adjustmentEvidence || [],
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
