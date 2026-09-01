const text = value => String(value ?? '');
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(text(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const TARGET_FIELDS = Object.freeze({
  estimate: Object.freeze({ quantity: 'voucher.estimate.line.quantity', unitPrice: 'voucher.estimate.line.unitPrice' }),
  order: Object.freeze({ quantity: 'voucher.order.line.quantity', unitPrice: 'voucher.order.line.unitPrice' }),
  purchase: Object.freeze({ quantity: 'voucher.purchase.line.quantity', unitPrice: 'voucher.purchase.line.unitPrice' }),
  sale: Object.freeze({ quantity: 'voucher.sale.line.quantity', unitPrice: 'voucher.sale.line.unitPrice' })
});

export const RELATED_VOUCHER_IMPORT_SCHEMA = 'ONEAPP_RELATED_VOUCHER_IMPORT_PLAN_V1';

function trackedValue(fieldId, displayValue, parsedValue, evidence) {
  return {
    fieldId,
    sourceDisplayValue: text(displayValue),
    currentDisplayValue: text(displayValue),
    parsedValue,
    edited: false,
    evidence: { ...evidence }
  };
}
function identity(value = {}) {
  return text(value.id || value.code || value.name);
}

export function createRelatedVoucherImportPlan({
  companyId,
  targetVoucherMode,
  sourceVoucherMode,
  sourceVoucher,
  selectedLineIds = []
} = {}) {
  const targetFields = TARGET_FIELDS[targetVoucherMode];
  if (!text(companyId)) throw new Error('RELATED_IMPORT_COMPANY_REQUIRED');
  if (!targetFields) throw new Error('RELATED_IMPORT_TARGET_MODE_INVALID');
  if (!TARGET_FIELDS[sourceVoucherMode]) throw new Error('RELATED_IMPORT_SOURCE_MODE_INVALID');
  if (!sourceVoucher?.id) throw new Error('RELATED_IMPORT_SOURCE_REQUIRED');
  if (sourceVoucher.companyId && sourceVoucher.companyId !== companyId) throw new Error('RELATED_IMPORT_COMPANY_MISMATCH');
  const selected = new Set((selectedLineIds || []).map(text).filter(Boolean));
  const sourceLines = Array.isArray(sourceVoucher.items) ? sourceVoucher.items : [];
  const lines = selected.size ? sourceLines.filter(line => selected.has(text(line.lineId || line.id))) : sourceLines;
  if (!lines.length) throw new Error('RELATED_IMPORT_LINES_REQUIRED');
  const sourceKey = `RELATED:${sourceVoucherMode}:${sourceVoucher.id}`;
  const evidenceBase = {
    kind: 'RELATED_VOUCHER',
    companyId,
    sourceVoucherMode,
    sourceVoucherId: sourceVoucher.id,
    sourceVoucherNo: sourceVoucher.voucherNo || ''
  };
  const rows = lines.map((line, index) => {
    const quantityDisplay = text(line.quantityDisplay ?? line.quantity);
    const unitPriceDisplay = text(line.unitPriceDisplay ?? line.unitPrice);
    const quantity = numberOrNull(line.quantity);
    const unitPrice = numberOrNull(line.unitPrice);
    const lineId = text(line.lineId || line.id || index + 1);
    return {
      rowId: `SIROW-RELATED-${sourceVoucherMode}-${sourceVoucher.id}-${lineId}`,
      sourceType: 'RELATED_VOUCHER',
      inputOwnership: 'SOURCE',
      sourceBatchId: sourceKey,
      sourceDocumentKey: sourceKey,
      sourceRowKey: lineId,
      sourceRowNo: index + 1,
      originSystem: 'ONEAPP_OFFICIAL_VOUCHER',
      originTransactionId: sourceVoucher.id,
      relatedSource: { ...evidenceBase, sourceLineId: lineId },
      productId: text(line.productId),
      masterProductId: text(line.masterProductId || line.productId),
      itemCode: text(line.code || line.itemCode),
      itemName: text(line.name || line.itemName),
      specification: text(line.specification),
      quantity,
      rawQuantity: quantity,
      unit: text(line.unit),
      rawUnit: text(line.unit),
      unitPrice,
      sourceUnitPrice: unitPriceDisplay,
      rowCustomerId: text(sourceVoucher.customerId),
      rowCustomerCode: text(sourceVoucher.customerCode),
      rowCustomerName: text(sourceVoucher.customerName),
      rowVoucherDate: text(sourceVoucher.date),
      rowWarehouseId: text(sourceVoucher.warehouseId),
      rowWarehouseCode: text(sourceVoucher.warehouseCode),
      rowVoucherNo: text(sourceVoucher.voucherNo),
      memo: text(line.memo),
      matchStatus: line.productId ? 'MATCHED' : 'UNRESOLVED',
      fieldValues: {
        [targetFields.quantity]: trackedValue(targetFields.quantity, quantityDisplay, quantity, { ...evidenceBase, sourceLineId: lineId, sourceField: 'quantity' }),
        [targetFields.unitPrice]: trackedValue(targetFields.unitPrice, unitPriceDisplay, unitPrice, { ...evidenceBase, sourceLineId: lineId, sourceField: 'unitPrice' })
      }
    };
  });
  return {
    schemaVersion: RELATED_VOUCHER_IMPORT_SCHEMA,
    planId: `SIRVI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    companyId,
    targetVoucherMode,
    sourceVoucherMode,
    sourceVoucherId: sourceVoucher.id,
    sourceVoucherNo: text(sourceVoucher.voucherNo),
    sourceSnapshot: JSON.parse(JSON.stringify(sourceVoucher)),
    headerSuggestion: {
      customerId: text(sourceVoucher.customerId),
      customerCode: text(sourceVoucher.customerCode),
      customerName: text(sourceVoucher.customerName),
      warehouseId: text(sourceVoucher.warehouseId),
      warehouseCode: text(sourceVoucher.warehouseCode),
      warehouseName: text(sourceVoucher.warehouseName)
    },
    rows,
    createdAt: new Date().toISOString()
  };
}

export function relatedImportConflicts(plan, targetHeader = {}) {
  const suggestion = plan?.headerSuggestion || {};
  const conflicts = [];
  const compare = (kind, current, incoming) => {
    if (identity(current) && identity(incoming) && identity(current) !== identity(incoming)) {
      conflicts.push({ kind, current: { ...current }, incoming: { ...incoming } });
    }
  };
  compare('CUSTOMER',
    { id: targetHeader.customerId, code: targetHeader.customerCode, name: targetHeader.customerName },
    { id: suggestion.customerId, code: suggestion.customerCode, name: suggestion.customerName });
  compare('WAREHOUSE',
    { id: targetHeader.warehouseId, code: targetHeader.warehouseCode, name: targetHeader.warehouseName },
    { id: suggestion.warehouseId, code: suggestion.warehouseCode, name: suggestion.warehouseName });
  return conflicts;
}

export function applyRelatedVoucherImportPlan(plan, targetDraft = {}, { acceptConflicts = false } = {}) {
  if (plan?.schemaVersion !== RELATED_VOUCHER_IMPORT_SCHEMA) throw new Error('RELATED_IMPORT_PLAN_INVALID');
  const conflicts = relatedImportConflicts(plan, targetDraft.header || {});
  if (conflicts.length && !acceptConflicts) {
    const error = new Error('RELATED_IMPORT_CONFIRMATION_REQUIRED');
    error.conflicts = conflicts;
    throw error;
  }
  const header = { ...(targetDraft.header || {}) };
  const suggestion = plan.headerSuggestion || {};
  ['customerId', 'customerCode', 'customerName', 'warehouseId', 'warehouseCode', 'warehouseName']
    .forEach(field => { if (!header[field]) header[field] = suggestion[field] || ''; });
  const existingRowIds = new Set((targetDraft.rows || []).map(row => row.rowId));
  const imported = plan.rows.filter(row => !existingRowIds.has(row.rowId));
  return {
    ...targetDraft,
    header,
    rows: [...(targetDraft.rows || []), ...imported],
    relatedImportHistory: [...(targetDraft.relatedImportHistory || []), {
      planId: plan.planId,
      sourceVoucherMode: plan.sourceVoucherMode,
      sourceVoucherId: plan.sourceVoucherId,
      rowCount: imported.length,
      conflictsAccepted: conflicts.map(item => item.kind),
      appliedAt: new Date().toISOString()
    }]
  };
}
