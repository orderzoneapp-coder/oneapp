/**
 * SmartInput WorkTable Core
 *
 * Pure row/column calculations only. This module intentionally has no access
 * to the DOM, SmartInput drafts, storage, voucher writers, or parser modules.
 */

const asArray = value => Array.isArray(value) ? value : [];

export function uniqueOrder(values = []) {
  return [...new Set(asArray(values))];
}

export function createSelection(mode = '') {
  return {
    mode,
    type: null,
    anchorRowId: null,
    selectedRowIds: [],
    anchorColumnKey: null,
    selectedColumnKeys: []
  };
}

export function contiguousRange(orderedKeys = [], anchorKey, endKey) {
  const order = uniqueOrder(orderedKeys);
  const endIndex = order.indexOf(endKey);
  if (endIndex < 0) return [];
  const anchorIndex = order.indexOf(anchorKey);
  if (anchorIndex < 0) return [endKey];
  return order.slice(Math.min(anchorIndex, endIndex), Math.max(anchorIndex, endIndex) + 1);
}

export function selectRange(selection = {}, { mode = '', type, orderedKeys = [], endKey, anchorKey } = {}) {
  const order = uniqueOrder(orderedKeys);
  if (!['ROW', 'COLUMN'].includes(type) || !order.includes(endKey)) return createSelection(mode);
  const existingAnchor = type === 'ROW' ? selection.anchorRowId : selection.anchorColumnKey;
  const resolvedAnchor = order.includes(anchorKey)
    ? anchorKey
    : (selection.type === type && order.includes(existingAnchor) ? existingAnchor : endKey);
  const selected = contiguousRange(order, resolvedAnchor, endKey);
  return type === 'ROW'
    ? {
        mode,
        type,
        anchorRowId: resolvedAnchor,
        selectedRowIds: selected,
        anchorColumnKey: null,
        selectedColumnKeys: []
      }
    : {
        mode,
        type,
        anchorRowId: null,
        selectedRowIds: [],
        anchorColumnKey: resolvedAnchor,
        selectedColumnKeys: selected
      };
}

export function trimSelection(selection = {}, { mode = '', visibleRowIds = [], visibleColumnKeys = [] } = {}) {
  if (!selection || selection.mode !== mode) return createSelection(mode);
  if (selection.type === 'ROW') {
    const visible = new Set(uniqueOrder(visibleRowIds));
    const selectedRowIds = asArray(selection.selectedRowIds).filter(rowId => visible.has(rowId));
    if (!selectedRowIds.length) return createSelection(mode);
    return {
      ...createSelection(mode),
      type: 'ROW',
      anchorRowId: visible.has(selection.anchorRowId) ? selection.anchorRowId : selectedRowIds[0],
      selectedRowIds
    };
  }
  if (selection.type === 'COLUMN') {
    const visible = new Set(uniqueOrder(visibleColumnKeys));
    const selectedColumnKeys = asArray(selection.selectedColumnKeys).filter(columnKey => visible.has(columnKey));
    if (!selectedColumnKeys.length) return createSelection(mode);
    return {
      ...createSelection(mode),
      type: 'COLUMN',
      anchorColumnKey: visible.has(selection.anchorColumnKey) ? selection.anchorColumnKey : selectedColumnKeys[0],
      selectedColumnKeys
    };
  }
  return createSelection(mode);
}

export function firstSelectedIndex(orderedKeys = [], selectedKeys = []) {
  const selected = new Set(asArray(selectedKeys));
  return uniqueOrder(orderedKeys).findIndex(key => selected.has(key));
}

export function insertRowsAbove(rows = [], selectedRowIds = [], rowsToInsert = []) {
  const sourceRows = asArray(rows);
  const additions = asArray(rowsToInsert);
  const selected = new Set(asArray(selectedRowIds));
  const selectedIndex = sourceRows.findIndex(row => row && selected.has(row.rowId));
  const insertionIndex = selectedIndex >= 0 ? selectedIndex : sourceRows.length;
  return [...sourceRows.slice(0, insertionIndex), ...additions, ...sourceRows.slice(insertionIndex)];
}

export function removeRowsById(rows = [], selectedRowIds = []) {
  const selected = new Set(asArray(selectedRowIds));
  return asArray(rows).filter(row => !row || !selected.has(row.rowId));
}

export function calculateColumnHide({
  visibleOrder = [],
  selectedColumnKeys = [],
  protectedColumnKeys = [],
  editableColumnKeys = [],
  minimumEditableColumns = 1
} = {}) {
  const order = uniqueOrder(visibleOrder);
  const selected = new Set(asArray(selectedColumnKeys));
  const protectedKeys = new Set(asArray(protectedColumnKeys));
  const editableKeys = new Set(asArray(editableColumnKeys));
  const hiddenKeys = [];
  const retainedForMinimum = [];
  const protectedSelectedKeys = asArray(selectedColumnKeys).filter(key => protectedKeys.has(key));
  const remaining = new Set(order);
  const minimum = Math.max(0, Number(minimumEditableColumns) || 0);

  order.forEach(key => {
    if (!selected.has(key) || protectedKeys.has(key)) return;
    const editableRemaining = [...remaining].filter(candidate => candidate !== key && editableKeys.has(candidate)).length;
    if (editableKeys.has(key) && editableRemaining < minimum) {
      retainedForMinimum.push(key);
      return;
    }
    remaining.delete(key);
    hiddenKeys.push(key);
  });

  return {
    visibleOrder: order.filter(key => remaining.has(key)),
    hiddenKeys,
    protectedSelectedKeys: uniqueOrder(protectedSelectedKeys),
    retainedForMinimum
  };
}

export function restoreColumnLeft({ visibleOrder = [], columnKey, selectedColumnKeys = [] } = {}) {
  const order = uniqueOrder(visibleOrder).filter(key => key !== columnKey);
  if (columnKey === null || columnKey === undefined || columnKey === '') return order;
  const selected = new Set(asArray(selectedColumnKeys));
  const selectedIndex = order.findIndex(key => selected.has(key));
  order.splice(selectedIndex >= 0 ? selectedIndex : 0, 0, columnKey);
  return order;
}

export function moveRangeEnd(orderedKeys = [], currentKey, direction = 0) {
  const order = uniqueOrder(orderedKeys);
  if (!order.length) return null;
  const currentIndex = order.indexOf(currentKey);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  return order[Math.max(0, Math.min(order.length - 1, safeIndex + Math.sign(Number(direction) || 0)))];
}
