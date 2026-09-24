// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.


// ============================================================================
// table-view-state.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const tableViewStateSection = (() => {


const TABLE_VIEW_MODE = Object.freeze({
  SOURCE: 'source',
  INPUT: 'input'
});

function createTableViewPreferences(modes = []) {
  return Object.fromEntries(modes.map(mode => [mode, TABLE_VIEW_MODE.INPUT]));
}

function tableViewFor(preferences, mode, hasSource) {
  if (!hasSource) return TABLE_VIEW_MODE.INPUT;
  return preferences?.[mode] === TABLE_VIEW_MODE.INPUT
    ? TABLE_VIEW_MODE.INPUT
    : TABLE_VIEW_MODE.SOURCE;
}

function selectTableView(preferences, mode, view, { hasSource = true } = {}) {
  if (!Object.values(TABLE_VIEW_MODE).includes(view)) throw new Error('SMARTINPUT_TABLE_VIEW_INVALID');
  return {
    ...(preferences || {}),
    [mode]: hasSource ? view : TABLE_VIEW_MODE.INPUT
  };
}

function resetTableViewForSource(preferences, mode) {
  return {
    ...(preferences || {}),
    [mode]: TABLE_VIEW_MODE.INPUT
  };
}

function sourceViewColumns(session = {}) {
  const mappingByIndex = new Map((session.mappings || []).map(mapping => [Number(mapping.columnIndex), mapping]));
  return (session.headers || []).map((header, columnIndex) => {
    const mapping = mappingByIndex.get(columnIndex);
    return {
      id: `source:${columnIndex}`,
      columnIndex,
      label: String(header ?? ''),
      mappingState: String(mapping?.state || 'UNDECIDED'),
      targetFieldId: String(mapping?.targetFieldId || '')
    };
  });
}

function inputViewColumns(fieldIds = [], definitions = []) {
  const definitionById = new Map(definitions.map(definition => [definition.id, definition]));
  return fieldIds.map((fieldId, columnIndex) => {
    const definition = definitionById.get(fieldId);
    return {
      id: fieldId,
      columnIndex,
      label: String(definition?.label || fieldId),
      definition: definition || null
    };
  });
}

return { TABLE_VIEW_MODE, createTableViewPreferences, tableViewFor, selectTableView, resetTableViewForSource, sourceViewColumns, inputViewColumns };
})();

// ============================================================================
// input-list-search.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const inputListSearchSection = (() => {


const INPUT_LIST_SEARCH_ACTION = Object.freeze({
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

function createInputListSearchIndex(rows = [], { sourceRows = [] } = {}) {
  const sourceByRowId = new Map(sourceRows.map(row => [String(row?.rowId || ''), row]));
  const entries = new Map();
  rows.forEach(row => {
    const rowId = String(row?.rowId || '');
    if (rowId) entries.set(rowId, indexedSearchRow(row, sourceByRowId.get(rowId) || null));
  });
  return { entries, sourceByRowId };
}

function updateInputListSearchIndex(index, row, sourceRow = null) {
  const target = index?.entries instanceof Map ? index : createInputListSearchIndex();
  const rowId = String(row?.rowId || '');
  if (!rowId) return target;
  if (sourceRow) target.sourceByRowId.set(rowId, sourceRow);
  target.entries.set(rowId, indexedSearchRow(row, sourceRow || target.sourceByRowId.get(rowId) || null));
  return target;
}

function removeInputListSearchIndexRow(index, rowId) {
  const stableRowId = String(rowId || '');
  index?.entries?.delete(stableRowId);
  index?.sourceByRowId?.delete(stableRowId);
  return index;
}

function createInputListSearchState() {
  return Object.freeze({ open: false, query: '' });
}

function reduceInputListSearchState(current, action = {}) {
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

function isActualInputListRow(row = {}, sourceRow = null) {
  return rowSearchValues(row, sourceRow).some(value => searchableValue(value) !== '');
}

function filterInputListRows(rows = [], query = '', { sourceRows = [], searchIndex = null } = {}) {
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

function inputListDisplayRows(allRows = [], visibleRows = [], { searchOpen = false } = {}) {
  return searchOpen ? visibleRows : allRows;
}

function inputListSelectionScopeRowIds(allRows = [], visibleRows = [], { searchOpen = false } = {}) {
  const rows = inputListDisplayRows(allRows, visibleRows, { searchOpen });
  return [...new Set(rows.map(row => String(row?.rowId || '')).filter(Boolean))];
}

function constrainInputListSelection(selectedRowIds = [], allowedRowIds = []) {
  const allowed = new Set(allowedRowIds.map(rowId => String(rowId || '')).filter(Boolean));
  return [...new Set([...selectedRowIds].map(rowId => String(rowId || '')).filter(rowId => allowed.has(rowId)))];
}

return { INPUT_LIST_SEARCH_ACTION, createInputListSearchIndex, updateInputListSearchIndex, removeInputListSearchIndexRow, createInputListSearchState, reduceInputListSearchState, isActualInputListRow, filterInputListRows, inputListDisplayRows, inputListSelectionScopeRowIds, constrainInputListSelection };
})();

// ============================================================================
// virtual-table-body.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const virtualTableBodySection = (() => {


/* Stage 4 row-window mathematics only. No DOM, editing, storage, or app boot.
   Supply ALL filtered/sorted logical keys; never feed this model only DOM rows. */
const keyOf = key => {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('Stable nonempty row key required');
  return key;
};
const finite = (value, name, minimum = 0) => {
  if (!Number.isFinite(value) || value < minimum) throw new TypeError(`Invalid ${name}`);
  return value;
};

/** Fenwick prefix sums support variable row heights without per-scroll scans. */
class HeightIndex {
  constructor(values) {
    this.values = Float64Array.from(values);
    this.tree = new Float64Array(values.length + 1);
    for (let i = 1; i < this.tree.length; i++) {
      this.tree[i] += this.values[i - 1];
      const parent = i + (i & -i);
      if (parent < this.tree.length) this.tree[parent] += this.tree[i];
    }
  }
  prefix(end) {
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }
  set(index, value) {
    const delta = value - this.values[index];
    this.values[index] = value;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
  }
  atOffset(offset) {
    if (!this.values.length) return -1;
    let index = 0, sum = 0;
    let bit = 1;
    while (bit * 2 < this.tree.length) bit *= 2;
    for (; bit; bit = Math.floor(bit / 2)) {
      const next = index + bit;
      if (next < this.tree.length && sum + this.tree[next] <= offset) {
        index = next; sum += this.tree[next];
      }
    }
    return Math.min(index, this.values.length - 1);
  }
}

function createTableViewport({ threshold = 200, overscan = 10, estimatedRowHeight = 32 } = {}) {
  if (!Number.isInteger(threshold) || threshold < 0 || !Number.isInteger(overscan) || overscan < 0) {
    throw new TypeError('Invalid viewport limits');
  }
  finite(estimatedRowHeight, 'estimatedRowHeight', Number.MIN_VALUE);
  let keys = [], indices = new Map(), heights = new HeightIndex([]), measurements = new Map();
  let generation = 0, disposed = false, lastSignature = '', lastWindow = null;
  const pins = new Set();
  const assertOpen = () => { if (disposed) throw new Error('VIEWPORT_DISPOSED'); };
  const changed = () => { generation++; lastSignature = ''; lastWindow = null; };
  const totalHeight = () => heights.prefix(keys.length);
  const clampScroll = (scrollTop, viewportHeight) => Math.max(0, Math.min(scrollTop, totalHeight() - viewportHeight));
  function setRows(rowKeys) {
    assertOpen();
    const next = [...rowKeys].map(keyOf), map = new Map(next.map((key, index) => [key, index]));
    if (map.size !== next.length) throw new Error('DUPLICATE_ROW_KEY');
    // Composition/filter integration must defer removing its pinned editor.
    const blockedKeys = [...pins].filter(key => !map.has(key));
    if (blockedKeys.length) return Object.freeze({ status: 'DEFERRED', blockedKeys: Object.freeze(blockedKeys) });
    keys = next; indices = map;
    measurements = new Map([...measurements].filter(([key]) => map.has(key)));
    heights = new HeightIndex(keys.map(key => measurements.get(key) ?? estimatedRowHeight));
    changed();
    return Object.freeze({ status: 'READY', rowCount: keys.length });
  }
  function captureAnchor(scrollTop) {
    assertOpen(); finite(scrollTop, 'scrollTop');
    const index = heights.atOffset(scrollTop);
    return index < 0 ? null : Object.freeze({ key: keys[index], offset: Math.min(scrollTop - heights.prefix(index), heights.values[index]) });
  }
  function restoreAnchor(anchor, fallback = 0) {
    assertOpen(); finite(fallback, 'fallback');
    if (!anchor || !indices.has(anchor.key)) return fallback;
    finite(anchor.offset, 'anchor offset');
    const index = indices.get(anchor.key);
    return heights.prefix(index) + Math.min(anchor.offset, heights.values[index]);
  }
  function measure(key, height) {
    assertOpen(); keyOf(key); finite(height, 'row height', Number.MIN_VALUE);
    const index = indices.get(key);
    if (index === undefined) return false;
    measurements.set(key, height);
    if (heights.values[index] === height) return false;
    heights.set(index, height); changed(); return true;
  }
  function invalidateMeasurements() {
    assertOpen(); measurements.clear(); heights = new HeightIndex(keys.map(() => estimatedRowHeight)); changed();
  }
  function windowFor(scrollTop, viewportHeight) {
    assertOpen(); finite(scrollTop, 'scrollTop'); finite(viewportHeight, 'viewportHeight');
    const top = clampScroll(scrollTop, viewportHeight), virtual = keys.length > threshold;
    const first = virtual ? Math.max(0, heights.atOffset(top)) : 0;
    let endVisible = virtual ? heights.atOffset(top + viewportHeight) + 1 : keys.length;
    // A row beginning exactly at the lower viewport edge is outside the view.
    if (virtual && endVisible > first + 1 && heights.prefix(endVisible - 1) >= top + viewportHeight) endVisible--;
    const start = virtual ? Math.max(0, first - overscan) : 0;
    const end = virtual ? Math.min(keys.length, endVisible + overscan) : keys.length;
    const intervals = end > start ? [[start, end]] : [];
    for (const key of pins) { const index = indices.get(key); if (index !== undefined) intervals.push([index, index + 1]); }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const pair of intervals) {
      const last = merged.at(-1);
      if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]); else merged.push([...pair]);
    }
    const signature = JSON.stringify([generation, virtual, merged]);
    if (signature === lastSignature) return lastWindow;
    const segments = []; let cursor = 0, renderedCount = 0;
    const gap = end => { if (end > cursor) segments.push(Object.freeze({ kind: 'spacer', start: cursor, end,
      height: heights.prefix(end) - heights.prefix(cursor) })); };
    for (const [begin, finish] of merged) {
      gap(begin);
      segments.push(Object.freeze({ kind: 'rows', start: begin, end: finish, keys: Object.freeze(keys.slice(begin, finish)) }));
      renderedCount += finish - begin; cursor = finish;
    }
    gap(keys.length);
    lastSignature = signature;
    lastWindow = Object.freeze({ virtual, logicalRowCount: keys.length, renderedCount, totalHeight: totalHeight(), segments: Object.freeze(segments) });
    return lastWindow;
  }
  function ensureVisible(key, scrollTop, viewportHeight) {
    assertOpen(); keyOf(key); finite(scrollTop, 'scrollTop'); finite(viewportHeight, 'viewportHeight');
    const index = indices.get(key);
    if (index === undefined) return Object.freeze({ status: 'NOT_FOUND', scrollTop });
    const begin = heights.prefix(index), end = heights.prefix(index + 1);
    let next = scrollTop;
    if (begin < scrollTop || heights.values[index] > viewportHeight) next = begin;
    else if (end > scrollTop + viewportHeight) next = end - viewportHeight;
    next = clampScroll(next, viewportHeight);
    return Object.freeze({ status: 'READY', key, index, scrollTop: next, window: windowFor(next, viewportHeight) });
  }
  function pin(key) {
    assertOpen(); keyOf(key);
    if (!indices.has(key)) return false;
    if (!pins.has(key)) { pins.add(key); changed(); }
    return true;
  }
  function unpin(key) { assertOpen(); if (pins.delete(key)) changed(); }
  return Object.freeze({ setRows, windowFor, measure, invalidateMeasurements, captureAnchor, restoreAnchor, ensureVisible, pin, unpin,
    // Logical navigation does not depend on the rendered window.
    adjacent: (key, delta) => { assertOpen(); if (!Number.isInteger(delta)) throw new TypeError('Integer delta required');
      const index = indices.get(key); return index === undefined ? null : (keys[index + delta] ?? null); },
    stats: () => Object.freeze({ logicalRowCount: keys.length, measuredRows: measurements.size, pins: pins.size, totalHeight: totalHeight() }),
    dispose: () => { disposed = true; keys = []; indices.clear(); pins.clear(); measurements.clear(); heights = new HeightIndex([]); changed(); }
  });
}

/** Coalesces scroll/resize preparation; caller owns listeners and observers. */
function createViewportFrameScheduler(render, { requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame } = {}) {
  if ([render, requestFrame, cancelFrame].some(fn => typeof fn !== 'function')) throw new TypeError('Frame callbacks required');
  let pending = null, payload, disposed = false;
  return Object.freeze({
    schedule(value) {
      if (disposed) return;
      payload = value;
      if (pending !== null) return;
      pending = requestFrame(() => { pending = null; if (!disposed) render(payload); });
    },
    dispose() { disposed = true; if (pending !== null) cancelFrame(pending); pending = null; payload = undefined; }
  });
}

// Native table rendering uses the same row-window model above.
// Keep the native table and the full application model. Only its body has a window.
function createVirtualTableBody({ body, scroller, rowAttribute, keyOf, decorate = () => {}, onRender = () => {} }) {
  const viewport = createTableViewport({ threshold: 200, overscan: 10, estimatedRowHeight: 34 });
  let rows = [], records = new Map(), indices = new Map(), rowRenderer, columns = 1, composing = false, deferred = null;
  let focusKey = null, painting = false, lastWindow = null;
  let resetMountedRows = false;
  let baseRows = [], baseIndices = new Map(), cellValue = () => '', viewState = null, viewSignature = '';
  const metrics = { renders: 0, logicalRows: 0, mountedRows: 0, lastRenderMs: 0 };
  const keyFrom = element => element?.closest?.(`tr[${rowAttribute}]`)?.getAttribute(rowAttribute);
  const offset = () => body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const height = () => Math.max(1, scroller.clientHeight - (body.parentElement.tHead?.offsetHeight || 0));
  const scheduler = createViewportFrameScheduler(() => paint());
  const observer = new ResizeObserver(entries => {
    if (painting || !rows.length) return;
    const anchor = viewport.captureAnchor(Math.max(0, scroller.scrollTop - offset()));
    let changed = false;
    for (const entry of entries) {
      const key = entry.target.getAttribute(rowAttribute);
      if (key && entry.target.getBoundingClientRect().height > 0) changed = viewport.measure(key, entry.target.getBoundingClientRect().height) || changed;
    }
    if (changed) { scroller.scrollTop = offset() + viewport.restoreAnchor(anchor); scheduler.schedule(); }
  });
  function paint(force = false) {
    if (!rowRenderer || painting || composing || body.closest('[hidden]')) return;
    const window = viewport.windowFor(Math.max(0, scroller.scrollTop - offset()), height());
    if (!force && !resetMountedRows && window === lastWindow) return;
    lastWindow = window; painting = true;
    const start = performance.now();
    try {
      const mounted = new Map([...body.children].filter(node => node.hasAttribute(rowAttribute)).map(node => [node.getAttribute(rowAttribute), node]));
      const wanted = [];
      for (const segment of window.segments) {
        if (segment.kind === 'spacer') {
          const tr = document.createElement('tr'); tr.setAttribute('aria-hidden', 'true'); tr.className = 'virtual-table-spacer';
          const td = document.createElement('td'); td.colSpan = columns; td.style.cssText = `height:${segment.height}px;padding:0;border:0;line-height:0;`; tr.append(td); wanted.push(tr);
        } else for (const key of segment.keys) {
          const row = records.get(key); const html = rowRenderer(row, indices.get(key));
          let node = mounted.get(key);
          const active = node?.contains(document.activeElement);
          if (!node || resetMountedRows || (!active && node.__virtualHtml !== html)) {
            const holder = document.createElement('tbody'); holder.innerHTML = html; node = holder.firstElementChild;
            decorate(node);
            node.__virtualHtml = html;
          }
          wanted.push(node);
        }
      }
      const keep = new Set(wanted); observer.disconnect();
      for (const node of [...body.children]) if (!keep.has(node)) node.remove();
      let cursor = body.firstElementChild;
      for (const node of wanted) {
        if (node !== cursor) body.insertBefore(node, cursor);
        else cursor = cursor.nextElementSibling;
        if (node.hasAttribute(rowAttribute)) observer.observe(node);
      }
      metrics.renders++; metrics.logicalRows = rows.length; metrics.mountedRows = window.renderedCount;
      metrics.lastRenderMs = performance.now() - start;
      body.dataset.logicalRowCount = String(rows.length);
      body.dataset.virtualized = String(window.virtual);
      resetMountedRows = false;
      onRender();
    } finally { painting = false; }
  }
  const api = {
    // Explicit model restoration may replace even a focused row. Keep this
    // pending through hidden/composing renders; ordinary edits retain their DOM.
    invalidate() { resetMountedRows = true; lastWindow = null; },
    render(nextRows, renderer, columnCount, readCell = cellValue) {
      if (composing) { deferred = [nextRows, renderer, columnCount, readCell]; return; }
      if (focusKey) viewport.unpin(focusKey);
      baseRows = nextRows; baseIndices = new Map(baseRows.map((row, index) => [String(keyOf(row)), index]));
      cellValue = readCell; rowRenderer = renderer; columns = columnCount;
      rows = filteredRows(); records = new Map(rows.map(row => [String(keyOf(row)), row]));
      indices = new Map(rows.map((row, index) => [String(keyOf(row)), index]));
      viewport.setRows([...records.keys()]);
      focusKey = body.contains(document.activeElement) ? keyFrom(document.activeElement) : null;
      if (focusKey) viewport.pin(focusKey);
      paint(true);
    },
    ensure(key) {
      if (!records.has(String(key))) return false;
      const result = viewport.ensureVisible(String(key), Math.max(0, scroller.scrollTop - offset()), height());
      scroller.scrollTop = offset() + result.scrollTop; paint(true); return true;
    },
    stats: () => ({ ...metrics, ...viewport.stats(), totalRows: baseRows.length, filterActive: Boolean(viewState?.query || viewState?.filters.size) }),
    visibleKeys: () => rows.map(row => String(keyOf(row)))
  };
  const normalize = value => String(value ?? '').trim().toLocaleLowerCase('ko-KR');
  function filteredRows() {
    if (!viewState) return baseRows;
    const { query, filters, sort, compare } = viewState;
    const value = (row, column) => cellValue(row, column, baseIndices.get(String(keyOf(row))));
    const result = baseRows.filter(row => (!query || normalize(Array.from({ length: columns }, (_, i) => value(row, i)).join(' ')).includes(normalize(query)))
      && [...filters].every(([i, selected]) => selected.has(normalize(value(row, i)))));
    if (sort) result.sort((a, b) => compare(value(a, sort.index), value(b, sort.index)) * (sort.direction === 'desc' ? -1 : 1));
    const active = baseRows.find(row => String(keyOf(row)) === keyFrom(document.activeElement));
    if (active && !result.includes(active)) result.push(active);
    return result;
  }
  body.parentElement.__nexusLogicalView = {
    values: index => baseRows.map((row, i) => cellValue(row, index, i)),
    apply(next) {
      const signature = JSON.stringify([next.query, [...next.filters].map(([index, set]) => [index, [...set]]), next.sort]);
      if (signature !== viewSignature) {
        viewState = next; viewSignature = signature;
        api.render(baseRows, rowRenderer, columns, cellValue);
      }
      return { total: baseRows.length, visible: rows.length };
    }
  };
  scroller.addEventListener('scroll', () => scheduler.schedule(), { passive: true });
  new ResizeObserver(() => { lastWindow = null; scheduler.schedule(); }).observe(scroller);
  body.addEventListener('focusin', event => {
    if (focusKey) viewport.unpin(focusKey);
    focusKey = keyFrom(event.target); if (focusKey) viewport.pin(focusKey);
  });
  body.addEventListener('focusout', () => queueMicrotask(() => {
    if (!body.contains(document.activeElement) && !composing) { if (focusKey) viewport.unpin(focusKey); focusKey = null; if (viewState) api.render(baseRows, rowRenderer, columns, cellValue); else scheduler.schedule(); }
  }));
  body.addEventListener('compositionstart', () => { composing = true; });
  body.addEventListener('compositionend', () => {
    composing = false;
    queueMicrotask(() => { if (deferred) { const next = deferred; deferred = null; api.render(...next); } else scheduler.schedule(); });
  });
  return api;
}

return { createTableViewport, createViewportFrameScheduler, createVirtualTableBody };
})();

// Public API (same functions and constants; no additional command layer).
export const TABLE_VIEW_MODE = tableViewStateSection.TABLE_VIEW_MODE;
export const createTableViewPreferences = tableViewStateSection.createTableViewPreferences;
export const tableViewFor = tableViewStateSection.tableViewFor;
export const selectTableView = tableViewStateSection.selectTableView;
export const resetTableViewForSource = tableViewStateSection.resetTableViewForSource;
export const sourceViewColumns = tableViewStateSection.sourceViewColumns;
export const inputViewColumns = tableViewStateSection.inputViewColumns;
export const INPUT_LIST_SEARCH_ACTION = inputListSearchSection.INPUT_LIST_SEARCH_ACTION;
export const createInputListSearchIndex = inputListSearchSection.createInputListSearchIndex;
export const updateInputListSearchIndex = inputListSearchSection.updateInputListSearchIndex;
export const removeInputListSearchIndexRow = inputListSearchSection.removeInputListSearchIndexRow;
export const createInputListSearchState = inputListSearchSection.createInputListSearchState;
export const reduceInputListSearchState = inputListSearchSection.reduceInputListSearchState;
export const isActualInputListRow = inputListSearchSection.isActualInputListRow;
export const filterInputListRows = inputListSearchSection.filterInputListRows;
export const inputListDisplayRows = inputListSearchSection.inputListDisplayRows;
export const inputListSelectionScopeRowIds = inputListSearchSection.inputListSelectionScopeRowIds;
export const constrainInputListSelection = inputListSearchSection.constrainInputListSelection;
export const createTableViewport = virtualTableBodySection.createTableViewport;
export const createViewportFrameScheduler = virtualTableBodySection.createViewportFrameScheduler;
export const createVirtualTableBody = virtualTableBodySection.createVirtualTableBody;
