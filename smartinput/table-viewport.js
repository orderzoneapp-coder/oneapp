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
