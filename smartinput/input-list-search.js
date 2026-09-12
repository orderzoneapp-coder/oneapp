export const INPUT_LIST_SEARCH_ACTION = Object.freeze({
  OPEN: 'OPEN',
  QUERY: 'QUERY',
  CLOSE: 'CLOSE',
  CONTEXT_CHANGE: 'CONTEXT_CHANGE'
});

const SEARCHABLE_ROW_FIELDS = Object.freeze([
  'itemCode', 'itemName', 'secondaryName', 'searchInfo', 'specification',
  'quantity', 'unit', 'unitPrice', 'supplyAmount',
  'memo', 'description',
  'rowCustomerCode', 'rowCustomerName',
  'deliveryCustomerCode', 'deliveryCustomerName',
  'billingCustomerCode', 'billingCustomerName',
  'supplierCustomerCode', 'supplierCustomerName',
  'salesCustomerCode', 'salesCustomerName',
  'rowWarehouseId', 'rowWarehouseCode', 'rowVoucherNo'
]);

const INVISIBLE_WHITESPACE_PATTERN = /[\s\u00a0\u200b\u200c\u200d\ufeff]+/g;

function searchableValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  return String(value).replace(INVISIBLE_WHITESPACE_PATTERN, '');
}

function normalizeSearchValue(value) {
  return searchableValue(value).normalize('NFKC').toLocaleLowerCase('ko-KR');
}

function rowSearchValues(row = {}, sourceRow = null) {
  const fieldValues = Object.values(row.fieldValues || {}).map(value => (
    value && typeof value === 'object' ? value.currentDisplayValue ?? value.parsedValue : value
  ));
  const explicitNoticePrice = Number(row.noticePrice) !== 0 || row.editedFields?.noticePrice
    ? [row.noticePrice]
    : [];
  return [
    ...SEARCHABLE_ROW_FIELDS.map(field => row[field]),
    ...explicitNoticePrice,
    ...Object.values(row.customValues || {}),
    ...fieldValues,
    ...(sourceRow?.cells || [])
  ];
}

function indexedSearchRow(row = {}, sourceRow = null) {
  const values = rowSearchValues(row, sourceRow);
  return Object.freeze({
    row,
    sourceRow,
    actual: values.some(value => searchableValue(value) !== ''),
    haystack: values.map(normalizeSearchValue).filter(Boolean).join('|')
  });
}

export function createInputListSearchIndex(rows = [], { sourceRows = [] } = {}) {
  const sourceByRowId = new Map(sourceRows.map(row => [String(row?.rowId || ''), row]));
  const entries = new Map();
  rows.forEach(row => {
    const rowId = String(row?.rowId || '');
    if (rowId) entries.set(rowId, indexedSearchRow(row, sourceByRowId.get(rowId) || null));
  });
  return { entries, sourceByRowId };
}

export function updateInputListSearchIndex(index, row, sourceRow = null) {
  const target = index?.entries instanceof Map ? index : createInputListSearchIndex();
  const rowId = String(row?.rowId || '');
  if (!rowId) return target;
  if (sourceRow) target.sourceByRowId.set(rowId, sourceRow);
  target.entries.set(rowId, indexedSearchRow(row, sourceRow || target.sourceByRowId.get(rowId) || null));
  return target;
}

export function removeInputListSearchIndexRow(index, rowId) {
  const stableRowId = String(rowId || '');
  index?.entries?.delete(stableRowId);
  index?.sourceByRowId?.delete(stableRowId);
  return index;
}

export function createInputListSearchState() {
  return Object.freeze({ open: false, query: '' });
}

export function reduceInputListSearchState(current, action = {}) {
  const state = current || createInputListSearchState();
  if (action.type === INPUT_LIST_SEARCH_ACTION.OPEN) {
    return Object.freeze({ open: true, query: String(state.query || '') });
  }
  if (action.type === INPUT_LIST_SEARCH_ACTION.QUERY) {
    return Object.freeze({ open: true, query: String(action.query ?? '') });
  }
  if ([INPUT_LIST_SEARCH_ACTION.CLOSE, INPUT_LIST_SEARCH_ACTION.CONTEXT_CHANGE].includes(action.type)) {
    return createInputListSearchState();
  }
  return state;
}

export function isActualInputListRow(row = {}, sourceRow = null) {
  return rowSearchValues(row, sourceRow).some(value => searchableValue(value) !== '');
}

export function filterInputListRows(rows = [], query = '', { sourceRows = [], searchIndex = null } = {}) {
  const index = searchIndex?.entries instanceof Map
    ? searchIndex
    : createInputListSearchIndex(rows, { sourceRows });
  const terms = String(query || '').split(/\s+/).map(normalizeSearchValue).filter(Boolean);
  return rows.filter(row => {
    const rowId = String(row?.rowId || '');
    const sourceRow = index.sourceByRowId.get(rowId) || null;
    let entry = index.entries.get(rowId);
    if (!entry || entry.row !== row || entry.sourceRow !== sourceRow) {
      updateInputListSearchIndex(index, row, sourceRow);
      entry = index.entries.get(rowId);
    }
    if (!entry?.actual) return false;
    if (!terms.length) return true;
    return terms.every(term => entry.haystack.includes(term));
  });
}

export function inputListDisplayRows(allRows = [], visibleRows = [], { searchOpen = false } = {}) {
  return searchOpen ? visibleRows : allRows;
}

export function inputListSelectionScopeRowIds(allRows = [], visibleRows = [], { searchOpen = false } = {}) {
  const rows = inputListDisplayRows(allRows, visibleRows, { searchOpen });
  return [...new Set(rows.map(row => String(row?.rowId || '')).filter(Boolean))];
}

export function constrainInputListSelection(selectedRowIds = [], allowedRowIds = []) {
  const allowed = new Set(allowedRowIds.map(rowId => String(rowId || '')).filter(Boolean));
  return [...new Set([...selectedRowIds].map(rowId => String(rowId || '')).filter(rowId => allowed.has(rowId)))];
}
