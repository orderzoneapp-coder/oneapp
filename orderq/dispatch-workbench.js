import {
  effectiveOrderQuantity,
  effectiveTransferredQuantity
} from './order-fulfillment-lifecycle.js?v=0.8.0';

export const DISPATCH_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  RELEASED: 'RELEASED',
  READY_TO_CONFIRM: 'READY_TO_CONFIRM',
  CONFIRMED: 'CONFIRMED'
});

export const FULFILLMENT_TYPE = Object.freeze({
  NORMAL: 'NORMAL',
  SUBSTITUTE: 'SUBSTITUTE',
  INDEPENDENT: 'INDEPENDENT'
});

export const CONVERSION_TYPE = Object.freeze({
  NONE: 'NONE',
  CUT: 'CUT',
  PORTION: 'PORTION',
  MEASURED: 'MEASURED'
});

export const MEASUREMENT_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  MEASURE_PENDING: 'MEASURE_PENDING',
  MEASURED: 'MEASURED'
});

export const DISPATCH_PRICE_SOURCE = Object.freeze({
  ORDER_AGREED: 'ORDER_AGREED',
  ACTUAL_PRODUCT: 'ACTUAL_PRODUCT',
  MANUAL: 'MANUAL'
});

export const CUSTOMER_NOTICE_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  NOTIFIED: 'NOTIFIED',
  WAIVED: 'WAIVED'
});

export const RESERVATION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
  EXPIRED: 'EXPIRED'
});

export const WORK_EXCEPTION_CODE = Object.freeze({
  NONE: '',
  NO_STOCK: 'NO_STOCK',
  QUANTITY_SHORT: 'QUANTITY_SHORT',
  LOCATION_MISMATCH: 'LOCATION_MISMATCH',
  PRODUCT_MISMATCH: 'PRODUCT_MISMATCH',
  DAMAGED: 'DAMAGED',
  MEASUREMENT_VARIANCE: 'MEASUREMENT_VARIANCE',
  OTHER: 'OTHER'
});

export const NEEDS_ACTION_CODE = Object.freeze({
  READY: 'READY',
  HOLD: 'HOLD',
  PRODUCT_REVIEW: 'PRODUCT_REVIEW',
  SHORTAGE: 'SHORTAGE',
  NO_ALLOCATION: 'NO_ALLOCATION',
  ALLOCATION_MISMATCH: 'ALLOCATION_MISMATCH',
  SUBSTITUTE_REVIEW: 'SUBSTITUTE_REVIEW',
  MEASUREMENT_REQUIRED: 'MEASUREMENT_REQUIRED',
  RESERVATION_CONFLICT: 'RESERVATION_CONFLICT',
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
  WORK_EXCEPTION: 'WORK_EXCEPTION'
});

export const DISPATCH_WORKSPACE_STORAGE_KEY = 'oneapp.orderq.dispatch-workbench.v1';
export const DISPATCH_DRAFT_BUFFER_STORAGE_KEY = 'oneapp.orderq.dispatch-draft-buffer.v1';
export const DISPATCH_QUANTITY_SCALE = 1_000_000;

const FULFILLMENT_TYPES = new Set(Object.values(FULFILLMENT_TYPE));
const WORK_EXCEPTION_CODES = new Set(Object.values(WORK_EXCEPTION_CODE));
const CONVERSION_TYPES = new Set(Object.values(CONVERSION_TYPE));
const PRICE_SOURCES = new Set(Object.values(DISPATCH_PRICE_SOURCE));

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('ORDERQ_DISPATCH_NUMBER_INVALID');
  return number;
}

export function normalizeConversionRuleSnapshot(source = {}, line = {}) {
  const snapshotSource = source && typeof source === 'object' ? source : {};
  const ruleId = text(line.conversionRuleId || snapshotSource.conversionRuleId || snapshotSource.ruleId);
  const ruleVersion = text(line.conversionRuleVersion || snapshotSource.conversionRuleVersion || snapshotSource.version);
  if (!ruleId && !ruleVersion && !Object.keys(snapshotSource).length) return null;
  return {
    conversionRuleId: ruleId,
    conversionRuleVersion: ruleVersion,
    actualToBaseFactor: quantityFromUnits(quantityUnits(snapshotSource.actualToBaseFactor ?? 1)),
    actualToRecognizedFactor: quantityFromUnits(quantityUnits(snapshotSource.actualToRecognizedFactor ?? 1)),
    requestedUnit: text(snapshotSource.requestedUnit || line.requestedUnit),
    actualUnit: text(snapshotSource.actualUnit || line.actualUnit),
    baseUnit: text(snapshotSource.baseUnit || line.baseUnit || line.actualUnit),
    description: text(snapshotSource.description)
  };
}

export function quantityUnits(value, errorCode = 'ORDERQ_DISPATCH_QUANTITY_INVALID') {
  if (value === '' || value === null || value === undefined) return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(errorCode);
  return Math.round(number * DISPATCH_QUANTITY_SCALE);
}

export function quantityFromUnits(value) {
  return Number(value || 0) / DISPATCH_QUANTITY_SCALE;
}

export function sumQuantities(values = []) {
  return quantityFromUnits(values.reduce((sum, value) => sum + quantityUnits(value), 0));
}

export function normalizeWorkspaceState(source = {}) {
  const filters = source.filters && typeof source.filters === 'object' && !Array.isArray(source.filters)
    ? Object.fromEntries(Object.entries(source.filters).map(([key, value]) => [text(key), text(value)]).filter(([key]) => key))
    : {};
  const stringList = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
  const scrollTop = Number(source.scrollTop);
  return {
    mode: ['ADMIN', 'WORKER'].includes(text(source.mode).toUpperCase()) ? text(source.mode).toUpperCase() : 'ADMIN',
    filters,
    selectedDispatchIds: stringList(source.selectedDispatchIds),
    expandedDispatchIds: stringList(source.expandedDispatchIds),
    focusedDispatchLineId: text(source.focusedDispatchLineId),
    scrollTop: Number.isFinite(scrollTop) && scrollTop >= 0 ? scrollTop : 0
  };
}

function normalizeLine(source = {}) {
  const {
    actualQuantity: _actualQuantity,
    actualBaseQuantity: _actualBaseQuantity,
    recognizedOrderQuantity: _recognizedOrderQuantity,
    confirmedQuantity: _confirmedQuantity,
    confirmedBaseQuantity: _confirmedBaseQuantity,
    salesLineId: _salesLineId,
    inventoryMovementId: _inventoryMovementId,
    confirmedAt: _confirmedAt,
    confirmedBy: _confirmedBy,
    measuredActualQuantity: _measuredActualQuantity,
    measuredBaseQuantity: _measuredBaseQuantity,
    measuredRecognizedOrderQuantity: _measuredRecognizedOrderQuantity,
    measuredAt: _measuredAt,
    measuredBy: _measuredBy,
    actualRevision: _actualRevision,
    actualRecordedAt: _actualRecordedAt,
    actualRecordedBy: _actualRecordedBy,
    customerNoticeActorId: _customerNoticeActorId,
    customerNoticeAt: _customerNoticeAt,
    customerNoticeMemo: _customerNoticeMemo,
    customerNoticePriceFingerprint: _customerNoticePriceFingerprint,
    ...draftSource
  } = source;
  const fulfillmentType = text(source.fulfillmentType).toUpperCase() || FULFILLMENT_TYPE.NORMAL;
  if (!FULFILLMENT_TYPES.has(fulfillmentType)) throw new Error(`ORDERQ_DISPATCH_FULFILLMENT_TYPE_INVALID:${fulfillmentType}`);
  const plannedActualQuantity = quantityFromUnits(quantityUnits(source.plannedActualQuantity));
  if (plannedActualQuantity < 0) throw new Error('ORDERQ_DISPATCH_PLANNED_QUANTITY_NEGATIVE');
  const conversionType = text(source.conversionType).toUpperCase() || CONVERSION_TYPE.NONE;
  if (!CONVERSION_TYPES.has(conversionType)) throw new Error(`ORDERQ_DISPATCH_CONVERSION_TYPE_INVALID:${conversionType}`);
  const conversionRuleSnapshot = normalizeConversionRuleSnapshot(source.conversionRuleSnapshot, source);
  const measurementRequired = Boolean(source.measurementRequired) || conversionType === CONVERSION_TYPE.MEASURED;
  const priceSource = text(source.priceSource).toUpperCase() || DISPATCH_PRICE_SOURCE.ORDER_AGREED;
  if (!PRICE_SOURCES.has(priceSource)) throw new Error(`ORDERQ_DISPATCH_PRICE_SOURCE_INVALID:${priceSource}`);
  const customerNoticeRequired = Boolean(source.customerNoticeRequired);
  const customerNoticeStatus = customerNoticeRequired ? CUSTOMER_NOTICE_STATUS.PENDING : CUSTOMER_NOTICE_STATUS.NOT_REQUIRED;
  return {
    ...draftSource,
    dispatchLineId: text(source.dispatchLineId),
    dispatchId: text(source.dispatchId),
    orderId: text(source.orderId),
    orderItemId: text(source.orderItemId),
    requestedProductId: text(source.requestedProductId),
    requestedProductCode: text(source.requestedProductCode),
    requestedProductName: text(source.requestedProductName),
    actualProductId: text(source.actualProductId),
    actualProductCode: text(source.actualProductCode),
    actualProductName: text(source.actualProductName),
    fulfillmentType,
    executionStatus: text(source.executionStatus).toUpperCase() || 'PLANNED',
    plannedActualQuantity,
    plannedBaseQuantity: quantityFromUnits(quantityUnits(source.plannedBaseQuantity ?? plannedActualQuantity)),
    plannedRecognizedOrderQuantity: quantityFromUnits(quantityUnits(source.plannedRecognizedOrderQuantity ?? plannedActualQuantity)),
    actualUnit: source.actualUnit === undefined || source.actualUnit === null ? '' : String(source.actualUnit),
    baseUnit: text(source.baseUnit || source.actualUnit),
    conversionType,
    conversionRuleId: text(source.conversionRuleId || conversionRuleSnapshot?.conversionRuleId),
    conversionRuleVersion: text(source.conversionRuleVersion || conversionRuleSnapshot?.conversionRuleVersion),
    conversionRuleSnapshot,
    measurementRequired,
    measurementStatus: measurementRequired ? MEASUREMENT_STATUS.MEASURE_PENDING : MEASUREMENT_STATUS.NOT_REQUIRED,
    priceSource,
    orderAgreedUnitPriceWon: optionalNumber(source.orderAgreedUnitPriceWon),
    actualProductUnitPriceWon: optionalNumber(source.actualProductUnitPriceWon),
    manualUnitPriceWon: optionalNumber(source.manualUnitPriceWon),
    appliedUnitPriceWon: optionalNumber(source.appliedUnitPriceWon),
    priceChanged: Boolean(source.priceChanged),
    priceChangeReason: text(source.priceChangeReason),
    customerNoticeRequired,
    customerNoticeStatus,
    customerNoticeActorId: '',
    customerNoticeAt: '',
    customerNoticeMemo: '',
    customerNoticePriceFingerprint: '',
    workStatus: text(source.workStatus).toUpperCase() || 'PENDING',
    workerExceptionCode: text(source.workerExceptionCode).toUpperCase(),
    workerExceptionMemo: source.workerExceptionMemo === undefined || source.workerExceptionMemo === null ? '' : String(source.workerExceptionMemo),
    workerReportedQuantity: source.workerReportedQuantity === '' || source.workerReportedQuantity === null || source.workerReportedQuantity === undefined
      ? null
      : quantityFromUnits(quantityUnits(source.workerReportedQuantity)),
    workerReportedProductId: text(source.workerReportedProductId)
  };
}

function normalizeAllocation(source = {}) {
  const {
    actualBaseQuantity: _actualBaseQuantity,
    movementId: _movementId,
    confirmedAt: _confirmedAt,
    confirmedBy: _confirmedBy,
    ...draftSource
  } = source;
  const plannedBaseQuantity = quantityFromUnits(quantityUnits(source.plannedBaseQuantity));
  if (plannedBaseQuantity < 0) throw new Error('ORDERQ_ALLOCATION_QUANTITY_NEGATIVE');
  return {
    ...draftSource,
    allocationId: text(source.allocationId),
    dispatchId: text(source.dispatchId),
    dispatchLineId: text(source.dispatchLineId),
    warehouseId: text(source.warehouseId),
    plannedBaseQuantity,
    reservationId: text(source.reservationId),
    status: text(source.status).toUpperCase() || 'PLANNED'
  };
}

export function validateDispatchDraftPlan({ lines = [], allocations = [], strict = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('ORDERQ_DISPATCH_LINE_REQUIRED');
  if (!Array.isArray(allocations)) throw new Error('ORDERQ_DISPATCH_ALLOCATION_INVALID');
  const normalizedLines = lines.map(normalizeLine);
  const normalizedAllocations = allocations.map(normalizeAllocation);
  const lineIds = new Set();
  for (const line of normalizedLines) {
    if (!line.dispatchLineId) throw new Error('ORDERQ_DISPATCH_LINE_ID_REQUIRED');
    if (lineIds.has(line.dispatchLineId)) throw new Error(`ORDERQ_DISPATCH_LINE_DUPLICATE:${line.dispatchLineId}`);
    lineIds.add(line.dispatchLineId);
    if (!line.orderId || !line.orderItemId) throw new Error(`ORDERQ_DISPATCH_ORDER_ITEM_REQUIRED:${line.dispatchLineId}`);
    if (!line.requestedProductId) throw new Error(`ORDERQ_DISPATCH_REQUESTED_PRODUCT_REQUIRED:${line.dispatchLineId}`);
    if (strict && !line.actualProductId) throw new Error(`ORDERQ_DISPATCH_ACTUAL_PRODUCT_REQUIRED:${line.dispatchLineId}`);
    if (strict && line.fulfillmentType === FULFILLMENT_TYPE.SUBSTITUTE && line.actualProductId === line.requestedProductId) {
      throw new Error(`ORDERQ_DISPATCH_SUBSTITUTE_PRODUCT_REQUIRED:${line.dispatchLineId}`);
    }
    if (strict && line.fulfillmentType !== FULFILLMENT_TYPE.SUBSTITUTE && line.actualProductId !== line.requestedProductId) {
      throw new Error(`ORDERQ_DISPATCH_SUBSTITUTE_TYPE_REQUIRED:${line.dispatchLineId}`);
    }
    if (strict && line.conversionType !== CONVERSION_TYPE.NONE) {
      const snapshot = line.conversionRuleSnapshot;
      if (!line.conversionRuleId || !line.conversionRuleVersion || !snapshot
        || !(snapshot.actualToBaseFactor > 0) || !(snapshot.actualToRecognizedFactor > 0)) {
        throw new Error(`ORDERQ_DISPATCH_CONVERSION_SNAPSHOT_REQUIRED:${line.dispatchLineId}`);
      }
      const expectedBaseUnits = quantityUnits(line.plannedActualQuantity * snapshot.actualToBaseFactor);
      const expectedRecognizedUnits = quantityUnits(line.plannedActualQuantity * snapshot.actualToRecognizedFactor);
      if (quantityUnits(line.plannedBaseQuantity) !== expectedBaseUnits
        || quantityUnits(line.plannedRecognizedOrderQuantity) !== expectedRecognizedUnits) {
        throw new Error(`ORDERQ_DISPATCH_CONVERSION_PLAN_MISMATCH:${line.dispatchLineId}`);
      }
    }
  }
  const allocationIds = new Set();
  const allocationsByLine = new Map();
  for (const allocation of normalizedAllocations) {
    if (!allocation.allocationId) throw new Error('ORDERQ_ALLOCATION_ID_REQUIRED');
    if (allocationIds.has(allocation.allocationId)) throw new Error(`ORDERQ_ALLOCATION_DUPLICATE:${allocation.allocationId}`);
    allocationIds.add(allocation.allocationId);
    if (!lineIds.has(allocation.dispatchLineId)) throw new Error(`ORDERQ_ALLOCATION_LINE_UNKNOWN:${allocation.dispatchLineId}`);
    if (!allocation.warehouseId) throw new Error(`ORDERQ_ALLOCATION_WAREHOUSE_REQUIRED:${allocation.allocationId}`);
    const list = allocationsByLine.get(allocation.dispatchLineId) || [];
    list.push(allocation);
    allocationsByLine.set(allocation.dispatchLineId, list);
  }
  for (const line of normalizedLines) {
    const list = allocationsByLine.get(line.dispatchLineId) || [];
    const allocationUnits = list.reduce((sum, row) => sum + quantityUnits(row.plannedBaseQuantity), 0);
    const lineUnits = quantityUnits(line.plannedBaseQuantity);
    if (strict && lineUnits > 0 && !list.length) throw new Error(`ORDERQ_DISPATCH_ALLOCATION_REQUIRED:${line.dispatchLineId}`);
    if (strict && allocationUnits !== lineUnits) throw new Error(`ORDERQ_DISPATCH_ALLOCATION_SUM_MISMATCH:${line.dispatchLineId}`);
  }
  return { lines: normalizedLines, allocations: normalizedAllocations };
}

export function deriveNeedsActionCodes({ line, allocations = [], availableByWarehouse = new Map(), reservationConflicts = [] } = {}) {
  const codes = new Set();
  if (!line?.actualProductId) codes.add(NEEDS_ACTION_CODE.PRODUCT_REVIEW);
  if (line?.fulfillmentType === FULFILLMENT_TYPE.SUBSTITUTE) codes.add(NEEDS_ACTION_CODE.SUBSTITUTE_REVIEW);
  if (line?.measurementRequired) codes.add(NEEDS_ACTION_CODE.MEASUREMENT_REQUIRED);
  if (!allocations.length && quantityUnits(line?.plannedBaseQuantity) > 0) codes.add(NEEDS_ACTION_CODE.NO_ALLOCATION);
  const allocationUnits = allocations.reduce((sum, row) => sum + quantityUnits(row.plannedBaseQuantity), 0);
  if (allocationUnits !== quantityUnits(line?.plannedBaseQuantity)) codes.add(NEEDS_ACTION_CODE.ALLOCATION_MISMATCH);
  const shortage = allocations.some(row => quantityUnits(row.plannedBaseQuantity) > quantityUnits(availableByWarehouse.get(row.warehouseId) ?? 0));
  if (shortage) codes.add(NEEDS_ACTION_CODE.SHORTAGE);
  if (reservationConflicts.some(row => row.dispatchLineId === line?.dispatchLineId && quantityUnits(row.conflictBaseQuantity) > 0)) {
    codes.add(NEEDS_ACTION_CODE.RESERVATION_CONFLICT);
  }
  if (line?.workerExceptionCode) codes.add(NEEDS_ACTION_CODE.WORK_EXCEPTION);
  if (!codes.size) codes.add(NEEDS_ACTION_CODE.READY);
  return [...codes];
}

function itemQuantity(order = {}, item = {}, events = []) {
  const remaining = effectiveOrderQuantity(order, item) - effectiveTransferredQuantity(item.orderItemId, events);
  return quantityFromUnits(Math.max(0, quantityUnits(remaining)));
}

export function proposeNormalDispatchDrafts({ orders = [], orderItems = [], orderEvents = [], inventoryProjection, businessDate = '', dispatchStageCode = 'UNSPECIFIED' } = {}) {
  const itemsByOrder = new Map();
  for (const item of orderItems) {
    const list = itemsByOrder.get(text(item.orderId)) || [];
    list.push(item);
    itemsByOrder.set(text(item.orderId), list);
  }
  const availableRows = (inventoryProjection?.rows || []).filter(row => row.countsInAvailable !== false);
  const availableUnits = new Map(availableRows.map(row => [`${text(row.productId)}\u001f${text(row.warehouseId)}`, quantityUnits(row.availableQuantity)]));
  const proposals = [];
  for (const order of orders) {
    if (text(order.orderStatus).toUpperCase() === 'FULL_CANCEL' || text(order.opsStatus).toUpperCase() === 'CLOSED') continue;
    const lines = [];
    const allocations = [];
    for (const item of itemsByOrder.get(text(order.orderId)) || []) {
      const requestedQuantity = itemQuantity(order, item, orderEvents);
      const requestedProductId = text(item.productId);
      if (requestedQuantity <= 0) continue;
      const dispatchLineId = `DL-PROPOSAL-${text(item.orderItemId)}`;
      const line = normalizeLine({
        dispatchLineId,
        orderId: order.orderId,
        orderItemId: item.orderItemId,
        requestedProductId,
        requestedProductCode: item.itemCode,
        requestedProductName: item.itemName,
        actualProductId: requestedProductId,
        actualProductCode: item.itemCode,
        actualProductName: item.itemName,
        fulfillmentType: FULFILLMENT_TYPE.NORMAL,
        executionStatus: 'PLANNED',
        plannedActualQuantity: requestedQuantity,
        plannedBaseQuantity: requestedQuantity,
        actualUnit: item.finalUnit ?? item.rawUnit ?? item.unit ?? '',
        measurementRequired: false
      });
      let remainingUnits = quantityUnits(requestedQuantity);
      const candidates = availableRows
        .filter(row => text(row.productId) === requestedProductId)
        .sort((left, right) => quantityUnits(right.availableQuantity) - quantityUnits(left.availableQuantity));
      for (const candidate of candidates) {
        if (remainingUnits <= 0) break;
        const key = `${requestedProductId}\u001f${text(candidate.warehouseId)}`;
        const available = Math.max(0, availableUnits.get(key) || 0);
        if (!available) continue;
        const allocated = Math.min(available, remainingUnits);
        availableUnits.set(key, available - allocated);
        allocations.push(normalizeAllocation({
          allocationId: `DA-PROPOSAL-${text(item.orderItemId)}-${text(candidate.warehouseId)}`,
          dispatchLineId,
          warehouseId: candidate.warehouseId,
          plannedBaseQuantity: quantityFromUnits(allocated),
          status: 'PLANNED',
          availableAtPlan: candidate.availableQuantity
        }));
        remainingUnits -= allocated;
      }
      if (remainingUnits > 0) {
        const fallbackWarehouseId = text(order.warehouseId || order.defaultWarehouseId);
        if (fallbackWarehouseId) {
          allocations.push(normalizeAllocation({
            allocationId: `DA-PROPOSAL-${text(item.orderItemId)}-${fallbackWarehouseId}-SHORT`,
            dispatchLineId,
            warehouseId: fallbackWarehouseId,
            plannedBaseQuantity: quantityFromUnits(remainingUnits),
            status: 'PLANNED',
            availableAtPlan: 0
          }));
          remainingUnits = 0;
        }
      }
      line.needsActionCodes = deriveNeedsActionCodes({
        line,
        allocations: allocations.filter(row => row.dispatchLineId === dispatchLineId),
        availableByWarehouse: new Map(candidates.map(row => [text(row.warehouseId), row.availableQuantity]))
      });
      if (text(order.adminStatus).toUpperCase() === 'HOLD') line.needsActionCodes = [NEEDS_ACTION_CODE.HOLD];
      lines.push(line);
    }
    if (!lines.length) continue;
    proposals.push({
      decision: {
        dispatchId: '',
        dispatchNo: '',
        customerId: text(order.customerId),
        customerName: text(order.customerName),
        sourceOrderIds: [text(order.orderId)],
        dispatchStageCode,
        status: DISPATCH_STATUS.DRAFT,
        revision: 0,
        baseRevision: Number(order.revision || 0),
        defaultWarehouseId: text(order.warehouseId),
        businessDate: businessDate || text(order.deliveryExpectedDate || order.orderDate),
        reason: '',
        memo: ''
      },
      lines,
      allocations,
      proposalOnly: true
    });
  }
  return proposals;
}

export function buildWorkerPickViews(aggregates = [], warehouses = []) {
  const warehouseById = new Map(warehouses.map(row => [text(row.warehouseId), row]));
  const byOrder = [];
  const grouped = new Map();
  for (const aggregate of aggregates.filter(row => row.decision?.status === DISPATCH_STATUS.RELEASED)) {
    const allocationsByLine = new Map();
    for (const allocation of aggregate.allocations || []) {
      const list = allocationsByLine.get(allocation.dispatchLineId) || [];
      list.push(allocation);
      allocationsByLine.set(allocation.dispatchLineId, list);
    }
    for (const line of aggregate.lines || []) {
      const sources = allocationsByLine.get(line.dispatchLineId) || [];
      byOrder.push({
        dispatchId: aggregate.decision.dispatchId,
        dispatchNo: aggregate.decision.dispatchNo,
        customerId: aggregate.decision.customerId,
        customerName: aggregate.decision.customerName,
        dispatchLineId: line.dispatchLineId,
        orderId: line.orderId,
        orderItemId: line.orderItemId,
        productId: line.actualProductId,
        productCode: line.actualProductCode,
        productName: line.actualProductName,
        plannedBaseQuantity: line.plannedBaseQuantity,
        actualUnit: line.actualUnit,
        workStatus: line.workStatus,
        workerReportedQuantity: line.workerReportedQuantity,
        workerReportedProductId: line.workerReportedProductId,
        workerExceptionCode: line.workerExceptionCode,
        workerExceptionMemo: line.workerExceptionMemo,
        allocations: sources.map(row => ({ allocationId: row.allocationId, warehouseId: row.warehouseId, plannedBaseQuantity: row.plannedBaseQuantity }))
      });
      for (const allocation of sources) {
        const key = `${allocation.warehouseId}\u001f${line.actualProductId}`;
        if (!grouped.has(key)) {
          const warehouse = warehouseById.get(allocation.warehouseId) || {};
          grouped.set(key, {
            key,
            warehouseId: allocation.warehouseId,
            warehouseCode: text(warehouse.warehouseCode),
            warehouseName: text(warehouse.warehouseName || warehouse.warehouse),
            productId: line.actualProductId,
            productCode: line.actualProductCode,
            productName: line.actualProductName,
            actualUnit: line.actualUnit,
            plannedBaseQuantity: 0,
            sources: []
          });
        }
        const row = grouped.get(key);
        row.plannedBaseQuantity = sumQuantities([row.plannedBaseQuantity, allocation.plannedBaseQuantity]);
        row.sources.push({
          dispatchId: aggregate.decision.dispatchId,
          dispatchLineId: line.dispatchLineId,
          allocationId: allocation.allocationId,
          plannedBaseQuantity: allocation.plannedBaseQuantity
        });
      }
    }
  }
  return {
    byOrder,
    byLocationProduct: [...grouped.values()].sort((left, right) => (
      left.warehouseCode.localeCompare(right.warehouseCode, 'ko', { numeric: true })
      || left.productCode.localeCompare(right.productCode, 'ko', { numeric: true })
    ))
  };
}

export function normalizeWorkerFact(source = {}) {
  const workerExceptionCode = text(source.workerExceptionCode).toUpperCase();
  if (!WORK_EXCEPTION_CODES.has(workerExceptionCode)) throw new Error(`ORDERQ_WORK_EXCEPTION_CODE_INVALID:${workerExceptionCode}`);
  const workerReportedQuantity = source.workerReportedQuantity === '' || source.workerReportedQuantity === null || source.workerReportedQuantity === undefined
    ? null
    : quantityFromUnits(quantityUnits(source.workerReportedQuantity));
  if (workerReportedQuantity !== null && workerReportedQuantity < 0) throw new Error('ORDERQ_WORK_REPORTED_QUANTITY_NEGATIVE');
  return {
    dispatchLineId: text(source.dispatchLineId),
    workerReportedProductId: text(source.workerReportedProductId),
    workerReportedQuantity,
    workerExceptionCode,
    workerExceptionMemo: source.workerExceptionMemo === undefined || source.workerExceptionMemo === null ? '' : String(source.workerExceptionMemo),
    workStatus: workerExceptionCode ? 'EXCEPTION' : 'DONE'
  };
}
