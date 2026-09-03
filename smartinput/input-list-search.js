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

export function filterInputListRows(rows = [], query = '', { sourceRows = [] } = {}) {
  const sourceByRowId = new Map(sourceRows.map(row => [String(row?.rowId || ''), row]));
  const terms = String(query || '').split(/\s+/).map(normalizeSearchValue).filter(Boolean);
  return rows.filter(row => {
    const sourceRow = sourceByRowId.get(String(row?.rowId || '')) || null;
    if (!isActualInputListRow(row, sourceRow)) return false;
    if (!terms.length) return true;
    const haystack = rowSearchValues(row, sourceRow).map(normalizeSearchValue).filter(Boolean).join('|');
    return terms.every(term => haystack.includes(term));
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
