import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableViewport, createViewportFrameScheduler } from '../smartinput/table-viewport.js';
import { createVirtualTableBody } from '../smartinput/virtual-table-body.js';
const keys = count => Array.from({ length: count }, (_, i) => `r${i}`);
const rendered = view => view.segments.filter(s => s.kind === 'rows').flatMap(s => s.keys);

// Logical row/height/range plans and DOM reconciliation contracts. Real browser
// layout, native IME events and IDB are verified separately.
for (const count of [0, 1, 80, 200, 201, 1000, 5000]) test(`logical ${count} rows survive window slicing`, () => {
  const model = createTableViewport(), all = keys(count); model.setRows(all);
  const view = model.windowFor(0, 320);
  assert.equal(view.logicalRowCount, count); assert.equal(view.virtual, count > 200);
  assert.equal(view.totalHeight, count * 32); assert.deepEqual(all, keys(count));
  if (count <= 200) assert.deepEqual(rendered(view), all); else assert.equal(view.renderedCount, 20);
  assert.equal(new Set(rendered(view)).size, view.renderedCount);
});
test('same rendered range returns the same plan; scrolling does not rebuild logical keys', () => {
  const model = createTableViewport(); model.setRows(keys(5000));
  const before = model.stats(); assert.equal(model.windowFor(65, 310), model.windowFor(66, 310));
  for (let i = 0; i < 1000; i++) model.windowFor(i * 15, 320);
  assert.deepEqual(model.stats(), before);
});
test('a distant pinned editor does not render the entire gap', () => {
  const model = createTableViewport(); model.setRows(keys(5000)); model.pin('r1'); model.pin('r4999');
  const view = model.windowFor(32000, 320), rows = rendered(view);
  assert.equal(view.renderedCount, 32); assert.ok(rows.includes('r1')); assert.ok(rows.includes('r4999'));
  assert.ok(!rows.includes('r500')); assert.equal(view.segments.filter(s => s.kind === 'rows').length, 3);
  model.unpin('r1'); model.unpin('r4999'); assert.equal(model.windowFor(32000, 320).renderedCount, 30);
});
test('pin removal during filtering is deferred without changing the current logical model', () => {
  const model = createTableViewport(); model.setRows(keys(1000)); model.pin('r4');
  const next = keys(1000).filter(key => key !== 'r4'), before = model.windowFor(0, 320);
  assert.deepEqual(model.setRows(next), { status: 'DEFERRED', blockedKeys: ['r4'] });
  assert.equal(model.windowFor(0, 320), before); assert.equal(model.stats().logicalRowCount, 1000);
  model.unpin('r4'); assert.equal(model.setRows(next).status, 'READY'); assert.equal(model.stats().logicalRowCount, 999);
});
test('all composite estimate/row keys stay distinct, including repeated underlying row IDs', () => {
  const model = createTableViewport();
  const a = JSON.stringify(['C1', '0007', 'same-row']), b = JSON.stringify(['C1', '7', 'same-row']);
  model.setRows([a, b]); assert.deepEqual(rendered(model.windowFor(0, 30)), [a, b]);
  assert.throws(() => model.setRows([a, a]), /DUPLICATE_ROW_KEY/);
  assert.deepEqual(rendered(model.windowFor(0, 30)), [a, b]);
});
test('logical navigation crosses rendered boundaries without inserting rows', () => {
  const model = createTableViewport(); model.setRows([...keys(1000), 'DEFAULT_INPUT_ROW_ID']);
  const initial = model.windowFor(0, 320), finalRendered = rendered(initial).at(-1);
  assert.equal(model.adjacent(finalRendered, 1), 'r20'); assert.equal(model.stats().logicalRowCount, 1001);
  const target = model.ensureVisible('r950', 0, 320); assert.equal(target.status, 'READY'); assert.ok(rendered(target.window).includes('r950'));
  const blank = model.ensureVisible('DEFAULT_INPUT_ROW_ID', 0, 320); assert.ok(rendered(blank.window).includes('DEFAULT_INPUT_ROW_ID'));
  assert.equal(rendered(blank.window).filter(key => key === 'DEFAULT_INPUT_ROW_ID').length, 1);
  assert.equal(model.adjacent('DEFAULT_INPUT_ROW_ID', 1), null); assert.equal(model.adjacent('r0', -1), null);
});
test('variable-height measurement preserves the anchor key and in-row offset', () => {
  const model = createTableViewport(); model.setRows(keys(1000));
  const anchor = model.captureAnchor(3207); assert.deepEqual(anchor, { key: 'r100', offset: 7 });
  model.measure('r0', 200); model.measure('r55', 80);
  assert.equal(model.restoreAnchor(anchor), 3207 + 168 + 48);
  assert.deepEqual(model.captureAnchor(model.restoreAnchor(anchor)), anchor);
});
test('reorder preserves per-key heights and restores the same logical anchor', () => {
  const model = createTableViewport(); model.setRows(['A', 'B', 'C']); model.measure('B', 100);
  const anchor = model.captureAnchor(37); model.setRows(['C', 'A', 'B']);
  assert.equal(model.stats().totalHeight, 164); assert.equal(model.restoreAnchor(anchor), 69);
  model.invalidateMeasurements(); assert.equal(model.stats().totalHeight, 96);
  assert.equal(model.restoreAnchor({ key: 'deleted', offset: 0 }, 8), 8);
});
test('large wrapped rows can be reached without imposing a fixed row height', () => {
  const model = createTableViewport({ threshold: 0 }); model.setRows(keys(50)); model.measure('r20', 500);
  const target = model.ensureVisible('r20', 0, 100);
  assert.equal(target.scrollTop, 640); assert.ok(rendered(target.window).includes('r20'));
  assert.equal(model.stats().totalHeight, 50 * 32 + 468);
});
test('spacer heights sum with rendered row heights to exact total after random measurements', () => {
  const model = createTableViewport(); const all = keys(5000), sizes = all.map(() => 32); model.setRows(all);
  let seed = 715; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 600; i++) { const index = random() % all.length, height = 10 + random() % 200;
    sizes[index] = height; model.measure(all[index], height); }
  model.pin('r3'); model.pin('r4800');
  const total = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 100; i++) {
    const scroll = random() % total, view = model.windowFor(scroll, 400);
    let cursor = 0, height = 0;
    for (const segment of view.segments) {
      assert.equal(segment.start, cursor); cursor = segment.end;
      const expected = sizes.slice(segment.start, segment.end).reduce((a, b) => a + b, 0);
      if (segment.kind === 'spacer') assert.equal(segment.height, expected); else assert.deepEqual(segment.keys, all.slice(segment.start, segment.end));
      height += segment.kind === 'spacer' ? segment.height : expected;
    }
    assert.equal(cursor, all.length); assert.equal(height, total); assert.equal(view.totalHeight, total);
    assert.ok(view.renderedCount <= 400 / 10 + 1 + 20 + 2);
    const anchor = model.captureAnchor(scroll); const index = Number(anchor.key.slice(1));
    const top = sizes.slice(0, index).reduce((a, b) => a + b, 0);
    assert.ok(top <= scroll && top + sizes[index] > scroll);
  }
});
test('ensureVisible changes neither keys nor application data and handles absent keys', () => {
  const model = createTableViewport(); const rows = keys(1000).map(rowId => ({ rowId, price: 0, memo: '' }));
  model.setRows(rows.map(row => row.rowId)); const before = structuredClone(rows);
  model.ensureVisible('r800', 0, 320); assert.deepEqual(rows, before);
  assert.deepEqual(model.ensureVisible('missing', 100, 320), { status: 'NOT_FOUND', scrollTop: 100 });
});
test('invalid values and disposed models fail without inventing rows', () => {
  assert.throws(() => createTableViewport({ estimatedRowHeight: 0 })); assert.throws(() => createTableViewport({ overscan: -1 }));
  const model = createTableViewport(); model.setRows(['a']);
  assert.throws(() => model.setRows([''])); assert.throws(() => model.measure('a', -1)); assert.throws(() => model.windowFor(NaN, 100));
  assert.equal(model.measure('missing', 20), false); model.dispose();
  assert.equal(model.stats().logicalRowCount, 0); assert.throws(() => model.windowFor(0, 100), /VIEWPORT_DISPOSED/);
});
test('rAF coalescing uses latest scroll once and releases scheduled work on dispose', () => {
  const callbacks = new Map(), received = [], cancelled = []; let id = 0;
  const scheduler = createViewportFrameScheduler(payload => received.push(payload), {
    requestFrame: callback => { const token = id++; callbacks.set(token, callback); return token; },
    cancelFrame: token => { cancelled.push(token); callbacks.delete(token); }
  });
  scheduler.schedule(1); scheduler.schedule(2); scheduler.schedule(3); assert.equal(callbacks.size, 1);
  const callback = callbacks.get(0); callbacks.delete(0); callback(); assert.deepEqual(received, [3]);
  scheduler.schedule(4); scheduler.dispose(); assert.deepEqual(cancelled, [1]); assert.equal(callbacks.size, 0);
  scheduler.schedule(5); assert.equal(callbacks.size, 0); assert.deepEqual(received, [3]);
});

// Small DOM surface for exercising the real renderer without a browser package.
// The fixture HTML has one row/input; layout and native focus behavior are not simulated.
function tableBodyFixture(t) {
  const original = new Map(['document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.attributes = new Map();
      this.dataset = {}; this.style = {}; this.listeners = new Map(); this.parentElement = null;
    }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() {
      return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    closest(selector) {
      const name = selector.match(/\[([^\]]+)\]/)?.[1];
      return name && this.hasAttribute(name) ? this : this.parentElement?.closest(selector) || null;
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    insertBefore(node, cursor) {
      node.remove();
      const index = cursor ? this.children.indexOf(cursor) : this.children.length;
      assert.ok(index >= 0); this.children.splice(index, 0, node); node.parentElement = this;
    }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    getBoundingClientRect() { return { top: 0, height: 34 }; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type, target = this) { for (const listener of this.listeners.get(type) || []) listener({ target }); }
    set innerHTML(html) {
      assert.equal(this.tagName, 'tbody');
      const row = new Element('tr'), input = new Element('input');
      row.setAttribute('data-row-id', html.match(/data-row-id="([^"]*)"/)[1]);
      input.value = html.match(/value="([^"]*)"/)[1]; input.setAttribute('value', input.value);
      row.append(input); this.append(row);
    }
  }
  const document = { activeElement: null, createElement: tag => new Element(tag) };
  const frames = new Map(); let frameId = 0;
  Object.assign(globalThis, {
    document, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  const table = new Element('table'), body = new Element('tbody'), scroller = new Element('div');
  table.append(body); scroller.append(table); scroller.scrollTop = 0; scroller.clientHeight = 320;
  const view = createVirtualTableBody({ body, scroller, rowAttribute: 'data-row-id', keyOf: row => row.rowId });
  return {
    view, body, document,
    render: quantity => view.render([{ rowId: 'r1', quantity }],
      row => `<tr data-row-id="${row.rowId}"><input value="${row.quantity}"></tr>`, 1),
    focus: () => { document.activeElement = body.firstElementChild.firstElementChild; body.emit('focusin', document.activeElement); },
    flushFrames: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } }
  };
}

test('ordinary rendering preserves an active editor; explicit restoration replaces it', t => {
  const fixture = tableBodyFixture(t); fixture.render(8); fixture.focus();
  const previous = fixture.body.firstElementChild;
  fixture.render(0);
  assert.equal(fixture.body.firstElementChild, previous);
  assert.equal(previous.firstElementChild.value, '8');
  fixture.view.invalidate();
  assert.equal(fixture.body.firstElementChild, previous, 'invalidation waits for the caller to render restored data');
  fixture.render(0);
  const restored = fixture.body.firstElementChild;
  assert.notEqual(restored, previous); assert.equal(restored.firstElementChild.value, '0');
  fixture.focus(); fixture.render(3);
  assert.equal(fixture.body.firstElementChild, restored, 'ordinary focus protection resumes after the reset');
  assert.equal(restored.firstElementChild.value, '0');
});

test('explicit restoration resets live input values even when cached model HTML is unchanged', t => {
  const fixture = tableBodyFixture(t); fixture.render(0); fixture.focus();
  const previous = fixture.body.firstElementChild, html = previous.__virtualHtml;
  previous.firstElementChild.value = '8';
  fixture.render(0);
  assert.equal(fixture.body.firstElementChild, previous);
  assert.equal(previous.firstElementChild.value, '8');
  fixture.view.invalidate(); fixture.render(0);
  const restored = fixture.body.firstElementChild;
  assert.notEqual(restored, previous); assert.equal(restored.__virtualHtml, html);
  assert.equal(restored.firstElementChild.value, '0');
  assert.equal(restored.firstElementChild.getAttribute('value'), '0');
});

test('IME composition defers explicit restoration and retains its reset until composition ends', async t => {
  const fixture = tableBodyFixture(t); fixture.render(8); fixture.focus();
  const previous = fixture.body.firstElementChild;
  fixture.body.emit('compositionstart'); fixture.view.invalidate(); fixture.render(0);
  fixture.render(3); // The latest deferred model wins; the requested DOM reset must survive.
  fixture.view.ensure('r1');
  assert.equal(fixture.body.firstElementChild, previous); assert.equal(previous.firstElementChild.value, '8');
  fixture.body.emit('compositionend'); await Promise.resolve();
  const restored = fixture.body.firstElementChild;
  assert.notEqual(restored, previous); assert.equal(restored.firstElementChild.value, '3');
  fixture.focus(); fixture.render(4);
  assert.equal(fixture.body.firstElementChild, restored, 'composition completion consumes the explicit reset once');
});

test('hidden bodies retain restoration until they can paint, including without another model render', t => {
  const fixture = tableBodyFixture(t); fixture.render(8); fixture.focus();
  const previous = fixture.body.firstElementChild;
  fixture.body.setAttribute('hidden', ''); fixture.view.invalidate(); fixture.render(0);
  assert.equal(fixture.body.firstElementChild, previous);
  fixture.body.attributes.delete('hidden'); fixture.view.ensure('r1');
  assert.notEqual(fixture.body.firstElementChild, previous);
  assert.equal(fixture.body.firstElementChild.firstElementChild.value, '0');
});
