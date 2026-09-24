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

export function createTableViewport({ threshold = 200, overscan = 10, estimatedRowHeight = 32 } = {}) {
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
export function createViewportFrameScheduler(render, { requestFrame = globalThis.requestAnimationFrame,
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
export function createVirtualTableBody({ body, scroller, rowAttribute, keyOf, decorate = () => {}, onRender = () => {} }) {
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
