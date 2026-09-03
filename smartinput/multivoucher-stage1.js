const MODE_CONFIG = Object.freeze({
  order: Object.freeze({
    customerLabel: '거래처명',
    customerAliases: ['거래처', '거래처명', '배송처', '고객명'],
    customerCodeLabel: '거래처코드',
    customerCodeAliases: ['거래처코드', '고객코드'],
    voucherDateLabel: '주문일자',
    voucherDateAliases: ['주문일자', '전표일자', '일자'],
    deliveryDateLabel: '배송일자',
    deliveryDateAliases: ['배송일자', '납품일자'],
    warehouseLabel: '출하창고코드',
    warehouseAliases: ['창고', '창고코드', '출하창고', '출하창고코드'],
    voucherNoLabel: '주문번호',
    voucherNoAliases: ['전표번호', '주문번호', '외부전표번호', '일자-No.'],
    quantityLabel: '주문수량',
    quantityAliases: ['주문수량', '수량'],
    unitPriceLabel: '주문단가',
    unitPriceAliases: ['주문단가', '단가']
  }),
  estimate: Object.freeze({
    customerLabel: '거래처명',
    customerAliases: ['거래처', '거래처명', '고객명'],
    customerCodeLabel: '거래처코드',
    customerCodeAliases: ['거래처코드', '고객코드'],
    voucherDateLabel: '견적일자',
    voucherDateAliases: ['견적일자', '전표일자', '일자'],
    deliveryDateLabel: '유효기간',
    deliveryDateAliases: ['유효기간'],
    warehouseLabel: '창고코드',
    warehouseAliases: ['창고', '창고코드'],
    voucherNoLabel: '견적번호',
    voucherNoAliases: ['전표번호', '견적번호', '외부전표번호'],
    quantityLabel: '견적수량',
    quantityAliases: ['견적수량', '수량'],
    unitPriceLabel: '견적단가',
    unitPriceAliases: ['견적단가', '단가']
  }),
  purchase: Object.freeze({
    customerLabel: '구매처명',
    customerAliases: ['구매처', '구매처명', '거래처', '거래처명'],
    customerCodeLabel: '구매처코드',
    customerCodeAliases: ['구매처코드', '거래처코드'],
    voucherDateLabel: '구매일자',
    voucherDateAliases: ['구매일자', '전표일자', '일자'],
    deliveryDateLabel: '입고일자',
    deliveryDateAliases: ['입고일자', '실입고일자'],
    warehouseLabel: '입고창고코드',
    warehouseAliases: ['창고', '창고코드', '입고창고', '입고창고코드'],
    voucherNoLabel: '구매전표번호',
    voucherNoAliases: ['전표번호', '구매전표번호', '외부전표번호'],
    quantityLabel: '구매수량',
    quantityAliases: ['구매수량', '수량'],
    unitPriceLabel: '구매단가',
    unitPriceAliases: ['구매단가', '입고가', '구매가', '단가']
  }),
  sale: Object.freeze({
    customerLabel: '판매처명',
    customerAliases: ['판매처', '판매처명', '거래처', '거래처명', '고객명'],
    customerCodeLabel: '판매처코드',
    customerCodeAliases: ['판매처코드', '거래처코드', '고객코드'],
    voucherDateLabel: '판매일자',
    voucherDateAliases: ['판매일자', '전표일자', '일자'],
    deliveryDateLabel: '출고일자',
    deliveryDateAliases: ['출고일자', '실출고일자'],
    warehouseLabel: '출하창고코드',
    warehouseAliases: ['창고', '창고코드', '출하창고', '출하창고코드'],
    voucherNoLabel: '판매전표번호',
    voucherNoAliases: ['전표번호', '판매전표번호', '외부전표번호'],
    quantityLabel: '판매수량',
    quantityAliases: ['판매수량', '수량'],
    unitPriceLabel: '판매단가',
    unitPriceAliases: ['판매단가', '판매가', '단가']
  })
});

const text = value => String(value ?? '').normalize('NFKC').trim();
const keyText = value => text(value).toLowerCase().replace(/\s+/g, '');
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,\s원₩]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

function field(id, label, aliases = [], valueType = 'TEXT') {
  return Object.freeze({
    id,
    label,
    group: 'ADDITIONAL',
    required: false,
    valueType,
    editable: true,
    masterAliases: Object.freeze([]),
    inputAliases: Object.freeze(aliases)
  });
}

function roleFieldDefinitions(mode) {
  const delivery = [
    field('deliveryCustomerId', '배송처ID', ['배송처아이디', '납품처ID', '납품처아이디']),
    field('deliveryCustomerCode', '배송처코드', ['납품처코드']),
    field('deliveryCustomerName', '배송처명', ['납품처명'])
  ];
  const billing = [
    field('billingCustomerId', '세무거래처ID', ['세무거래처아이디', '청구처ID', '채권거래처ID']),
    field('billingCustomerCode', '세무거래처코드', ['청구처코드', '채권거래처코드']),
    field('billingCustomerName', '세무거래처명', ['청구처명', '채권거래처명'])
  ];
  const supplier = [
    field('supplierCustomerId', '공급처ID', ['공급처아이디', '구매공급처ID', '구매처ID']),
    field('supplierCustomerCode', '공급처코드', ['구매공급처코드']),
    field('supplierCustomerName', '공급처명', ['구매공급처명'])
  ];
  const sales = [
    field('salesCustomerId', '판매업무처ID', ['판매업무처아이디', '영업거래처ID']),
    field('salesCustomerCode', '판매업무처코드', ['영업거래처코드']),
    field('salesCustomerName', '판매업무처명', ['영업거래처명'])
  ];
  if (mode === 'purchase') return supplier;
  if (mode === 'sale') return [...sales, ...delivery, ...billing];
  return [...delivery, ...billing];
}

export function modeConfig(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG.order;
}

export function stage1RowFieldDefinitions(mode = 'order') {
  const config = modeConfig(mode);
  return Object.freeze([
    field('rowCustomerCode', config.customerCodeLabel, config.customerCodeAliases),
    field('rowCustomerName', config.customerLabel, config.customerAliases),
    field('rowVoucherDate', config.voucherDateLabel, config.voucherDateAliases),
    field('rowDeliveryDate', config.deliveryDateLabel, config.deliveryDateAliases),
    field('rowWarehouseCode', config.warehouseLabel, config.warehouseAliases),
    field('rowVoucherNo', config.voucherNoLabel, config.voucherNoAliases),
    ...roleFieldDefinitions(mode),
    field('sourceDocumentKey', '원본문서키', ['원본문서키', '문서키']),
    field('sourceVoucherIndex', '원본전표순번', ['원본전표순번', '전표순번'], 'NUMBER'),
    field('manualSplitKey', '전표분리키', ['전표분리키', '수동분리키'])
  ]);
}

export function structuredFieldsForMode(mode, productFieldDefinitions = []) {
  const config = modeConfig(mode);
  const overrides = [
    ...stage1RowFieldDefinitions(mode),
    field('quantity', config.quantityLabel, config.quantityAliases, 'NUMBER'),
    field('unit', '단위', ['단위', '상품구성']),
    field('unitPrice', config.unitPriceLabel, config.unitPriceAliases, 'NUMBER')
  ];
  const overriddenIds = new Set(overrides.map(item => item.id));
  return [...overrides, ...productFieldDefinitions.filter(item => !overriddenIds.has(item.id))];
}

export function normalizeStage1Row(row = {}, context = {}) {
  const rawQuantity = Object.prototype.hasOwnProperty.call(row, 'rawQuantity')
    ? numberOrNull(row.rawQuantity)
    : numberOrNull(row.quantity);
  const quantity = numberOrNull(row.quantity ?? row.finalQuantity ?? rawQuantity);
  const rawUnit = text(row.rawUnit ?? row.unit);
  const unit = text(row.unit ?? row.finalUnit ?? rawUnit);
  const requestedBaseUnit = text(row.baseUnit);
  const factor = numberOrNull(row.unitConversionFactor);
  const sameUnit = !requestedBaseUnit || !unit || keyText(requestedBaseUnit) === keyText(unit);
  const resolvedFactor = factor ?? (sameUnit ? 1 : null);
  const baseQuantity = quantity === null || resolvedFactor === null ? null : quantity * resolvedFactor;
  return {
    ...row,
    rowCustomerCode: text(row.rowCustomerCode),
    rowCustomerId: text(row.rowCustomerId),
    rowCustomerName: text(row.rowCustomerName),
    deliveryCustomerId: text(row.deliveryCustomerId),
    deliveryCustomerCode: text(row.deliveryCustomerCode),
    deliveryCustomerName: text(row.deliveryCustomerName),
    billingCustomerId: text(row.billingCustomerId),
    billingCustomerCode: text(row.billingCustomerCode),
    billingCustomerName: text(row.billingCustomerName),
    supplierCustomerId: text(row.supplierCustomerId),
    supplierCustomerCode: text(row.supplierCustomerCode),
    supplierCustomerName: text(row.supplierCustomerName),
    salesCustomerId: text(row.salesCustomerId),
    salesCustomerCode: text(row.salesCustomerCode),
    salesCustomerName: text(row.salesCustomerName),
    rowVoucherDate: text(row.rowVoucherDate),
    rowDeliveryDate: text(row.rowDeliveryDate),
    rowWarehouseId: text(row.rowWarehouseId),
    rowWarehouseCode: text(row.rowWarehouseCode),
    rowVoucherNo: text(row.rowVoucherNo),
    sourceBatchId: text(row.sourceBatchId || context.sourceBatchId || row.batchId),
    sourceDocumentKey: text(row.sourceDocumentKey || context.sourceDocumentKey),
    sourceVoucherIndex: numberOrNull(row.sourceVoucherIndex ?? context.sourceVoucherIndex) ?? 1,
    sourceSheetName: text(row.sourceSheetName || context.sourceSheetName),
    manualSplitKey: text(row.manualSplitKey),
    sourceRowNo: Number(row.sourceRowNo || row.sourceLineNo || 0),
    sourceFingerprint: text(row.sourceFingerprint || context.sourceFingerprint),
    rawQuantity,
    rawUnit,
    quantity,
    unit,
    baseQuantity,
    baseUnit: requestedBaseUnit || unit,
    unitConversionFactor: resolvedFactor,
    unitConversionSource: text(row.unitConversionSource) || (resolvedFactor === 1 ? 'SAME_UNIT' : (resolvedFactor === null ? 'UNRESOLVED' : 'ROW_RULE')),
    unitConversionStatus: resolvedFactor === null ? 'REVIEW_REQUIRED' : 'CONFIRMED'
  };
}

export function decorateStructuredRows(rows = [], context = {}) {
  return rows.map((row, index) => normalizeStage1Row(row, {
    ...context,
    sourceVoucherIndex: row.sourceVoucherIndex ?? context.sourceVoucherIndex ?? 1,
    sourceDocumentKey: row.sourceDocumentKey || context.sourceDocumentKey
      || `${text(context.sourceSheetName) || 'SHEET'}:${row.sourceVoucherIndex ?? context.sourceVoucherIndex ?? 1}`,
    sourceRowNo: row.sourceLineNo || index + 1
  }));
}

function rowValue(row, fieldName, fallback) {
  const value = text(row?.[fieldName]);
  return value || text(fallback);
}

function groupRoleSnapshot(mode, row, header = {}) {
  const generic = {
    id: rowValue(row, 'rowCustomerId', header.customerId),
    code: rowValue(row, 'rowCustomerCode', header.customerCode),
    name: rowValue(row, 'rowCustomerName', header.customerName)
  };
  const role = (prefix, headerPrefix = prefix) => ({
    id: rowValue(row, `${prefix}CustomerId`, header[`${headerPrefix}CustomerId`]),
    code: rowValue(row, `${prefix}CustomerCode`, header[`${headerPrefix}CustomerCode`]),
    name: rowValue(row, `${prefix}CustomerName`, header[`${headerPrefix}CustomerName`])
  });
  const withDefault = value => (value.id || value.code || value.name) ? value : generic;
  if (mode === 'purchase') {
    const supplier = withDefault(role('supplier'));
    return { supplierCustomerId: supplier.id, supplierCustomerCode: supplier.code, supplierCustomerName: supplier.name };
  }
  if (mode === 'sale') {
    const sales = withDefault(role('sales'));
    const delivery = withDefault(role('delivery'));
    const billing = withDefault(role('billing', 'tax'));
    return {
      salesCustomerId: sales.id,
      salesCustomerCode: sales.code,
      salesCustomerName: sales.name,
      deliveryCustomerId: delivery.id,
      deliveryCustomerCode: delivery.code,
      deliveryCustomerName: delivery.name,
      billingCustomerId: billing.id,
      billingCustomerCode: billing.code,
      billingCustomerName: billing.name
    };
  }
  const delivery = withDefault(role('delivery'));
  const billing = withDefault(role('billing', 'tax'));
  return {
    deliveryCustomerId: delivery.id,
    deliveryCustomerCode: delivery.code,
    deliveryCustomerName: delivery.name,
    billingCustomerId: billing.id,
    billingCustomerCode: billing.code,
    billingCustomerName: billing.name
  };
}

function roleIdentity(mode, role) {
  if (mode === 'purchase') return role.supplierCustomerId || role.supplierCustomerCode || role.supplierCustomerName;
  if (mode === 'sale') return [
    role.salesCustomerId || role.salesCustomerCode || role.salesCustomerName,
    role.deliveryCustomerId || role.deliveryCustomerCode || role.deliveryCustomerName,
    role.billingCustomerId || role.billingCustomerCode || role.billingCustomerName
  ].join('>');
  return [
    role.deliveryCustomerId || role.deliveryCustomerCode || role.deliveryCustomerName,
    role.billingCustomerId || role.billingCustomerCode || role.billingCustomerName
  ].join('>');
}

function sourcePartition(row) {
  if (text(row.manualSplitKey)) return `MANUAL:${text(row.manualSplitKey)}`;
  if (text(row.sourceDocumentKey)) return `DOCUMENT:${text(row.sourceDocumentKey)}`;
  return `INDEX:${numberOrNull(row.sourceVoucherIndex) ?? 1}`;
}

export function buildVoucherGroupKey(mode, row, header = {}) {
  const role = groupRoleSnapshot(mode, row, header);
  const parts = [
    text(row.sourceBatchId || row.batchId || header.sourceBatchId),
    sourcePartition(row),
    roleIdentity(mode, role),
    rowValue(row, 'rowVoucherDate', header.voucherDate || header.orderDate),
    rowValue(row, 'rowDeliveryDate', header.deliveryDate),
    rowValue(row, 'rowWarehouseCode', header.warehouseCode || header.warehouseName),
    rowValue(row, 'rowVoucherNo', '')
  ];
  return `${mode.toUpperCase()}|${parts.map(part => encodeURIComponent(part)).join('|')}`;
}

export function groupVoucherRows(mode, rows = [], header = {}) {
  const groups = new Map();
  rows.forEach((input, index) => {
    const row = normalizeStage1Row(input, { sourceBatchId: input.batchId, sourceRowNo: input.sourceLineNo || index + 1 });
    const voucherGroupKey = buildVoucherGroupKey(mode, row, header);
    if (!groups.has(voucherGroupKey)) {
      const role = groupRoleSnapshot(mode, row, header);
      const idempotencyParts = [
        mode,
        row.sourceBatchId,
        voucherGroupKey,
        row.sourceFingerprint
      ];
      groups.set(voucherGroupKey, {
        voucherGroupKey,
        idempotencyKey: `SMART_INPUT_STAGE1:${idempotencyParts.map(part => encodeURIComponent(text(part))).join('|')}`,
        voucherType: mode,
        ...role,
        voucherDate: rowValue(row, 'rowVoucherDate', header.voucherDate || header.orderDate),
        deliveryDate: rowValue(row, 'rowDeliveryDate', header.deliveryDate),
        warehouseId: rowValue(row, 'rowWarehouseId', header.warehouseId),
        warehouseCode: rowValue(row, 'rowWarehouseCode', header.warehouseCode || header.warehouseName),
        transactionType: text(header.transactionType),
        externalVoucherNo: text(row.rowVoucherNo),
        sourceBatchId: text(row.sourceBatchId),
        sourceDocumentKey: text(row.sourceDocumentKey),
        sourceVoucherIndex: row.sourceVoucherIndex,
        sourceSheetName: text(row.sourceSheetName),
        manualSplitKey: text(row.manualSplitKey),
        validationStatus: 'READY',
        validationErrors: [],
        rows: []
      });
    }
    const group = groups.get(voucherGroupKey);
    if (row.orderDocumentNoError) {
      group.validationErrors.push(`${row.sourceRowNo || index + 1}행 ${row.orderDocumentNoError}`);
    }
    if (row.quantity === null) group.validationErrors.push(`${row.sourceRowNo || index + 1}행 수량 공란`);
    if (row.unitConversionStatus === 'REVIEW_REQUIRED') group.validationErrors.push(`${row.sourceRowNo || index + 1}행 단위 환산 확인 필요`);
    group.rows.push({ ...row, voucherGroupKey });
  });
  return [...groups.values()].map(group => ({
    ...group,
    validationStatus: group.validationErrors.length ? 'REVIEW_REQUIRED' : 'READY',
    rowIds: group.rows.map(row => row.rowId).filter(Boolean)
  }));
}

export function summarizeVoucherGroups(groups = []) {
  const customerKeys = new Set();
  let rowCount = 0;
  let reviewRequired = 0;
  groups.forEach(group => {
    customerKeys.add(group.supplierCustomerId || group.supplierCustomerCode || group.supplierCustomerName
      || group.salesCustomerId || group.salesCustomerCode || group.salesCustomerName
      || group.deliveryCustomerId || group.deliveryCustomerCode || group.deliveryCustomerName || '');
    rowCount += group.rows.length;
    reviewRequired += group.rows.filter(row => row.matchStatus !== 'MATCHED'
      || row.quantity === null || row.unitConversionStatus === 'REVIEW_REQUIRED').length;
  });
  customerKeys.delete('');
  return {
    customerCount: customerKeys.size,
    voucherCount: groups.length,
    rowCount,
    reviewRequired,
    label: `거래처 ${customerKeys.size}곳 · 생성 예정 전표 ${groups.length}건 · 상품 ${rowCount}행 · 확인 필요 ${reviewRequired}행`
  };
}

export function filterVoucherRows(rows = [], query = '') {
  const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter(row => {
    const haystack = [
      row.itemCode, row.itemName, row.specification, row.secondaryName, row.searchInfo,
      row.rowCustomerCode, row.rowCustomerName,
      row.deliveryCustomerCode, row.deliveryCustomerName,
      row.billingCustomerCode, row.billingCustomerName,
      row.supplierCustomerCode, row.supplierCustomerName,
      row.salesCustomerCode, row.salesCustomerName,
      row.rowVoucherNo, row.memo
    ].map(value => text(value).toLowerCase().replace(/\s+/g, '')).join('|');
    return terms.every(term => haystack.includes(term.replace(/\s+/g, '')));
  });
}

export function minimumUploadHeaders(mode = 'order') {
  if (mode === 'purchase') return ['구매처명', '구매일자', '품목코드', '품목명', '규격', '수량', '단위', '입고가', '메모'];
  if (mode === 'sale') return ['판매처명', '판매일자', '품목코드', '품목명', '규격', '수량', '단위', '판매가', '메모'];
  return ['거래처명', '배송일자', '품목코드', '품목명', '규격', '수량', '단위', '단가', '메모'];
}

export function buildMinimumUploadMatrix(mode = 'order') {
  return [minimumUploadHeaders(mode), []];
}

export function buildOrderGroupPayload(group, common = {}) {
  return {
    ...common,
    customerId: group.deliveryCustomerId || common.customerId || '',
    customerName: group.deliveryCustomerName || common.customerName || '',
    externalOrderNo: group.externalVoucherNo || common.externalOrderNo || '',
    orderDate: group.voucherDate || common.orderDate,
    deliveryExpectedDate: group.deliveryDate || common.deliveryExpectedDate || '',
    warehouseId: group.warehouseId || common.warehouseId || '',
    warehouseCode: group.warehouseCode || common.warehouseCode || '',
    warehouseName: group.warehouseCode || common.warehouseName || '',
    transactionType: group.transactionType || common.transactionType || '',
    sourceDocumentKey: group.idempotencyKey,
    sourceId: group.sourceBatchId,
    items: group.rows.map((row, index) => ({
      ...row,
      lineNo: index + 1,
      rawQuantity: row.rawQuantity,
      rawUnit: row.rawUnit,
      finalQuantity: row.quantity,
      finalUnit: row.unit,
      supplyAmount: Number(row.quantity || 0) * Number(row.unitPrice || 0)
    }))
  };
}

export { MODE_CONFIG };
