import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../orderops/workbench-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('  function protectResultSearch(api) {');
const end = source.indexOf('  root.createOrderOpsWorkbench = function (api) {', start);
assert.ok(start >= 0 && end > start, 'search guard exists in the loaded workbench asset');
assert.match(source.slice(end, end + 110), /protectResultSearch\(api\);/, 'guard is installed at workbench startup');
new vm.Script(source, { filename: 'workbench-ui.js' });

class Element {
  constructor(doc, tag = 'input') {
    this.ownerDocument = doc;
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.listeners = [];
    this.children = [];
    this.value = '';
    this.autofill = '';
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, listener, capture = false) { this.listeners.push({ type, listener, capture }); }
  append(element) { this.children.push(element); if (element.id) this.ownerDocument.nodes.set(element.id, element); }
  matches(selector) { if (this.unsupported) throw new SyntaxError('unsupported selector'); return this.autofill === selector; }
  emit(type, detail = {}) {
    const event = { type, target: this, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...detail };
    const listeners = this.listeners.filter(item => item.type === type).sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const { listener } of listeners) { listener(event); if (event.stopped) break; }
    return event;
  }
}
function fixture(query = '', initialValue = 'saved-account') {
  const doc = { nodes: new Map(), getElementById(id) { return this.nodes.get(id) || null; }, createElement(tag) { return new Element(this, tag); } };
  doc.body = new Element(doc, 'body'); doc.head = new Element(doc, 'head');
  const root = new Element(doc, 'window');
  const elements = Object.fromEntries(['tableSearchInput', 'cloudUrlInput', 'cloudTokenInput', 'cloudSavedByInput'].map(id => {
    const element = new Element(doc); element.id = id; doc.nodes.set(id, element); return [id, element];
  }));
  elements.tableSearchInput.value = initialValue;
  elements.cloudTokenInput.value = 'synthetic-token';
  elements.cloudSavedByInput.value = 'saved-account';
  const state = { searchQuery: query, selectedOrderViewPresetId: 'saved-view', workspace: { orders: [{ quantity: 0 }, { quantity: '' }], source: 'original' }, specificationFilters: ['EA'] };
  let rendered = 0;
  // Register the existing application's bubble listener BEFORE installing the
  // guard: capture must keep an autofill event from ever changing search state.
  elements.tableSearchInput.addEventListener('input', () => {
    state.searchQuery = elements.tableSearchInput.value;
    state.selectedOrderViewPresetId = '';
    rendered++;
  });
  const install = vm.runInNewContext(`${source.slice(start, end)}; protectResultSearch`, { root });
  const api = { state, elements };
  install(api);
  return { doc, root, elements, state, install, api, get rendered() { return rendered; } };
}
const f = fixture();
const input = f.elements.tableSearchInput;
const protectedData = JSON.stringify(f.state.workspace);
assert.equal(input.value, '', 'startup discards DOM-only prefill, not application search');
assert.equal(input.getAttribute('autocomplete'), 'off');
assert.equal(input.getAttribute('name'), 'orderops-result-query');
assert.notEqual(input.getAttribute('form'), f.elements.cloudTokenInput.getAttribute('form'), 'search and token have different form owners');
assert.equal(f.elements.cloudTokenInput.getAttribute('autocomplete'), 'new-password');
for (const id of ['orderopsResultSearchForm', 'orderopsCloudSettingsForm']) {
  const form = f.doc.getElementById(id);
  assert.ok(form.hidden);
  assert.ok(form.emit('submit').prevented, 'Enter cannot submit/navigate an implicit form');
}
for (const selector of [':autofill', ':-webkit-autofill']) {
  input.autofill = selector; input.value = 'saved-account';
  assert.ok(input.emit('input').stopped, `${selector}: captured before existing search handler`);
  assert.equal(input.value, ''); assert.equal(f.state.searchQuery, '');
  assert.equal(f.state.selectedOrderViewPresetId, 'saved-view');
}
assert.equal(f.rendered, 0, 'no unwanted zero-result render');
input.autofill = ':autofill'; input.value = 'saved-account';
assert.ok(input.emit('change').stopped);
assert.equal(input.value, '');
input.value = 'saved-account'; input.emit('animationstart', { animationName: 'orderopsSearchAutofill' });
assert.equal(input.value, '', 'eventless native autofill is removed from DOM');
input.autofill = '';
for (const [value, inputType] of [['saved-account', 'insertText'], ['한글 상품', 'insertCompositionText'], ['000123', 'insertFromPaste'], ['음성 검색', 'insertText']]) {
  input.value = value; assert.equal(input.emit('input', { inputType }).stopped, false);
  assert.equal(f.state.searchQuery, value, 'explicit search including an account-like name remains allowed');
}
input.autofill = ':autofill'; input.value = ''; input.emit('input');
assert.equal(f.state.searchQuery, '', 'native search clear is not blocked');
f.state.searchQuery = '기본 양식 검색'; f.state.selectedOrderViewPresetId = 'explicit-preset'; input.value = 'injected-account';
input.emit('input');
assert.equal(input.value, '기본 양식 검색');
assert.equal(f.state.selectedOrderViewPresetId, 'explicit-preset');
input.value = 'history-prefill'; f.root.emit('pageshow');
assert.equal(input.value, '기본 양식 검색', 'history restoration retains the app-owned search');
const counts = [input.listeners.length, f.doc.body.children.length, f.doc.head.children.length];
f.install(f.api);
assert.deepEqual([input.listeners.length, f.doc.body.children.length, f.doc.head.children.length], counts, 'installation is idempotent');
input.unsupported = true; input.value = '수동 검색'; input.emit('input');
assert.equal(f.state.searchQuery, '수동 검색', 'unsupported autofill selectors cannot break manual input');
assert.equal(JSON.stringify(f.state.workspace), protectedData, 'no business data mutation');
assert.deepEqual(f.state.specificationFilters, ['EA'], 'unrelated filters preserved');
assert.equal(f.elements.cloudTokenInput.value, 'synthetic-token', 'token is never erased or copied');
assert.equal(f.elements.cloudSavedByInput.value, 'saved-account', 'operator name remains unchanged');
const preset = fixture('보존할 검색');
assert.equal(preset.elements.tableSearchInput.value, '보존할 검색', 'initialization preserves explicit app state');
console.log('PASS OrderOps search autofill: isolated forms; prefill/input/change/animation/pageshow; manual/IME/paste/clear/preset preservation; idempotence; zero business-data writes.');
