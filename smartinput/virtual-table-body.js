import { createTableViewport, createViewportFrameScheduler } from './table-viewport.js?v=0.1.0';

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
