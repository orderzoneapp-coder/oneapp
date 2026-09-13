(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OrderOpsVoucherWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VOUCHER_WORKBENCH_SCHEMA = 'ONEAPP_ORDEROPS_VOUCHER_WORKBENCH_V1';
  const text = value => String(value ?? '').trim();
  const canonical = value => JSON.stringify(value);
  const round = value => Math.round((Number(value) + Number.EPSILON) * 1e9) / 1e9;
  const parseNumeric = value => {
    if (value === '' || value === null || value === undefined || String(value).trim() === '') {
      return { ok: true, blank: true, value: 0 };
    }
    let normalized = String(value).trim().replace(/,/g, '');
    let negative = false;
    if (/^\(.*\)$/.test(normalized)) {
      negative = true;
      normalized = normalized.slice(1, -1);
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed)
      ? { ok: true, blank: false, value: round(negative ? -parsed : parsed) }
      : { ok: false, blank: false, value: null };
  };
  const defaultRowId = (row = {}, index = 0, source = {}) => {
    if (text(row.workRowId)) return text(row.workRowId);
    const document = text(row.orderId || row.sourceDocumentKey || source.orderId || source.sourceDocumentKey);
    const line = text(row.orderItemId || row.sourceLineKey) || String(Number(row.originalSourceRowNumber || row.sourceRowNumber) || index + 1);
    const fingerprint = text(row.sourceFingerprint || source.orderSnapshotHash || source.sha256 || source.fileHash);
    return document ? `document:${document}:line:${line}` : `file:${fingerprint || 'unidentified'}:sheet:${text(source.sheetName)}:line:${line}`;
  };
  const voucherIdFor = (row = {}, index = 0, source = {}) => {
    const ownerDocument = text(row.orderId || row.sourceDocumentKey || source.orderId || source.sourceDocumentKey);
    if (ownerDocument) return `document:${ownerDocument}`;
    const fingerprint = text(row.sourceFingerprint || source.orderSnapshotHash || source.sha256 || source.fileHash) || 'unidentified';
    const orderNumber = text(row.orderNumber || row.group);
    const customer = text(row.customerId || row.customerCode || row.customerKey || row.customer);
    if (orderNumber) return `file:${fingerprint}:sheet:${text(source.sheetName)}:voucher:${orderNumber}:customer:${customer}`;
    const originalLine = Number(row.originalSourceRowNumber || row.sourceRowNumber) || index + 1;
    return `file:${fingerprint}:sheet:${text(source.sheetName)}:unbounded-line:${originalLine}`;
  };

  function buildVouchers(workspace = {}, options = {}) {
    const rows = Array.isArray(workspace.orders) ? workspace.orders : [];
    const source = workspace.sourceFiles?.orders || {};
    const rowId = typeof options.rowId === 'function'
      ? (row, index) => options.rowId(row, source, index)
      : (row, index) => defaultRowId(row, index, source);
    const groups = new Map();
    rows.forEach((row, index) => {
      const voucherId = text(row.voucherId) || voucherIdFor(row, index, source);
      if (!groups.has(voucherId)) groups.set(voucherId, {
        schemaVersion: VOUCHER_WORKBENCH_SCHEMA,
        voucherId,
        orderId: text(row.orderId),
        orderNumber: text(row.orderNumber || row.group),
        companyId: text(row.companyId),
        date: text(row.basisDate),
        customer: text(row.customer),
        customerId: text(row.customerId || row.customerCode),
        warehouses: new Set(),
        managers: new Set(),
        rowIds: [],
        sourceRowNumbers: [],
        productCodes: [],
        notes: new Set(),
        note1s: new Set(),
        quantityGroups: new Map(),
        amountTotal: 0,
        amountValueCount: 0,
        calculatedAmountTotal: 0,
        calculatedAmountValueCount: 0,
        amountBlankCount: 0,
        amountInvalidCount: 0,
        amountUnknownCount: 0,
        rowCount: 0,
      });
      const voucher = groups.get(voucherId);
      voucher.warehouses.add(text(row.warehouse));
      voucher.managers.add(text(row.manager));
      voucher.rowIds.push(rowId(row, index));
      voucher.sourceRowNumbers.push(Number(row.sourceRowNumber) || 0);
      voucher.productCodes.push(text(row.productCode));
      if (text(row.noteOriginal || row.note)) voucher.notes.add(text(row.noteOriginal || row.note));
      if (text(row.note1Original || row.note1)) voucher.note1s.add(text(row.note1Original || row.note1));
      voucher.rowCount += 1;
      const unit = text(row.sourceUnit);
      const key = unit || '__UNASSIGNED__';
      const quantity = parseNumeric(row.quantity);
      const group = voucher.quantityGroups.get(key) || { unit, total: 0, valueCount: 0, blankCount: 0, invalidCount: 0 };
      if (!quantity.ok) group.invalidCount += 1;
      else if (quantity.blank) group.blankCount += 1;
      else { group.total = round(group.total + quantity.value); group.valueCount += 1; }
      voucher.quantityGroups.set(key, group);

      const amount = parseNumeric(row.supplyAmount);
      if (!amount.ok) voucher.amountInvalidCount += 1;
      else if (!amount.blank) {
        voucher.amountTotal = round(voucher.amountTotal + amount.value);
        voucher.amountValueCount += 1;
      } else {
        voucher.amountBlankCount += 1;
        const unitPrice = parseNumeric(row.unitPrice);
        if (quantity.ok && !quantity.blank && unitPrice.ok && !unitPrice.blank) {
          voucher.calculatedAmountTotal = round(voucher.calculatedAmountTotal + round(quantity.value * unitPrice.value));
          voucher.calculatedAmountValueCount += 1;
        } else {
          voucher.amountUnknownCount += 1;
        }
      }
    });
    return [...groups.values()].map(voucher => {
      const warehouses = [...voucher.warehouses];
      const managers = [...voucher.managers];
      const notes = [...voucher.notes];
      const note1s = [...voucher.note1s];
      return Object.freeze({
        ...voucher,
        warehouses,
        warehouse: warehouses.length === 1 ? warehouses[0] : '',
        warehouseLabel: warehouses.length > 1 ? `혼합(${warehouses.map(value => value || '미지정').join(', ')})` : warehouses[0] || '미지정',
        managers,
        manager: managers.length === 1 ? managers[0] : '',
        managerLabel: managers.length > 1 ? `혼합(${managers.map(value => value || '미지정').join(', ')})` : managers[0] || '미지정',
        notes,
        note1s,
        note: notes.join(' / '),
        note1: note1s.join(' / '),
        noteLabel: [...notes, ...note1s].join(' / '),
        quantityGroups: [...voucher.quantityGroups.values()].map(item => ({ ...item, total: round(item.total) })),
        amountTotal: voucher.amountValueCount > 0 ? voucher.amountTotal : null,
        calculatedAmountTotal: voucher.calculatedAmountValueCount > 0 ? voucher.calculatedAmountTotal : null,
      });
    });
  }

  function filterVouchers(vouchers = [], filters = {}) {
    const query = text(filters.query).toLocaleLowerCase('ko-KR').split(/\s+/).filter(Boolean);
    const fromDate = text(filters.fromDate);
    const toDate = text(filters.toDate);
    const warehouse = text(filters.warehouse);
    const manager = text(filters.manager);
    return vouchers.filter(voucher => {
      if (fromDate && (!voucher.date || voucher.date < fromDate)) return false;
      if (toDate && (!voucher.date || voucher.date > toDate)) return false;
      if (warehouse && !voucher.warehouses.includes(warehouse)) return false;
      if (manager && !voucher.managers.includes(manager)) return false;
      const haystack = [voucher.date, voucher.orderNumber, voucher.orderId, voucher.customer, voucher.customerId, voucher.noteLabel, ...voucher.notes, ...voucher.note1s, ...voucher.warehouses, ...voucher.managers, ...voucher.productCodes]
        .map(value => text(value).toLocaleLowerCase('ko-KR')).join(' ');
      return query.every(token => haystack.includes(token));
    });
  }

  function summarizeSelection(vouchers = [], selectedIds = []) {
    const selected = new Set(selectedIds);
    const quantities = new Map();
    const rows = vouchers.filter(voucher => selected.has(voucher.voucherId));
    rows.forEach(voucher => voucher.quantityGroups.forEach(item => {
      const key = item.unit || '__UNASSIGNED__';
      const current = quantities.get(key) || { unit: item.unit, total: 0, valueCount: 0, invalidCount: 0 };
      current.total += Number(item.total || 0);
      current.valueCount += Number(item.valueCount || 0);
      current.invalidCount += Number(item.invalidCount || 0);
      quantities.set(key, current);
    }));
    return {
      voucherCount: rows.length,
      rowCount: rows.reduce((sum, voucher) => sum + voucher.rowCount, 0),
      quantities: [...quantities.values()].map(item => ({ ...item, total: round(item.total) })),
      amountTotal: rows.some(voucher => voucher.amountValueCount > 0)
        ? round(rows.reduce((sum, voucher) => sum + Number(voucher.amountTotal || 0), 0))
        : null,
      amountValueCount: rows.reduce((sum, voucher) => sum + Number(voucher.amountValueCount || 0), 0),
      calculatedAmountTotal: rows.some(voucher => voucher.calculatedAmountValueCount > 0)
        ? round(rows.reduce((sum, voucher) => sum + Number(voucher.calculatedAmountTotal || 0), 0))
        : null,
      calculatedAmountValueCount: rows.reduce((sum, voucher) => sum + Number(voucher.calculatedAmountValueCount || 0), 0),
      amountBlankCount: rows.reduce((sum, voucher) => sum + Number(voucher.amountBlankCount || 0), 0),
      amountUnknownCount: rows.reduce((sum, voucher) => sum + Number(voucher.amountUnknownCount || 0), 0),
      amountInvalidCount: rows.reduce((sum, voucher) => sum + Number(voucher.amountInvalidCount || 0), 0),
    };
  }

  function buildPatches(vouchers = [], selectedIds = [], changes = {}, baseByRowId = {}) {
    const selected = new Set(selectedIds);
    const fields = ['warehouse', 'manager'].filter(field => changes[field]?.mode === 'SET' || changes[field]?.mode === 'CLEAR');
    if (!selected.size) throw new Error('ORDEROPS_VOUCHER_SELECTION_EMPTY');
    if (!fields.length) throw new Error('ORDEROPS_VOUCHER_PATCH_EMPTY');
    const patches = [];
    vouchers.filter(voucher => selected.has(voucher.voucherId)).forEach(voucher => {
      voucher.rowIds.forEach(workRowId => {
        const values = {};
        const expected = {};
        fields.forEach(field => {
          values[field] = changes[field].mode === 'CLEAR' ? '' : text(changes[field].value);
          if (Object.prototype.hasOwnProperty.call(baseByRowId[workRowId] || {}, field)) expected[field] = baseByRowId[workRowId][field];
        });
        patches.push({ workRowId, voucherId: voucher.voucherId, values, expected });
      });
    });
    return patches;
  }

  return Object.freeze({
    VOUCHER_WORKBENCH_SCHEMA,
    parseNumeric,
    defaultRowId,
    voucherIdFor,
    buildVouchers,
    filterVouchers,
    summarizeSelection,
    buildPatches,
    canonical,
  });
});
