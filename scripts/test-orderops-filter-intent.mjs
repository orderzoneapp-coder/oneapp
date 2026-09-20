import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Execute the actual entrypoint functions and checkbox listener. Synthetic
// inputs/storage only; this suite makes no production or browser-E2E claim.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const paths = ["orderops_list.html"];
const clone = (value) => JSON.parse(JSON.stringify(value));
let cases = 0;
function extract(html, name) {
  const source = new RegExp(`      function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n      \\}`).exec(html)?.[0];
  assert.ok(source, `Missing real function: ${name}`);
  return source;
}
function harness(html) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", innerHTML: "", checked: false, indeterminate: false,
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
      querySelectorAll() { return []; },
    });
    return nodes.get(selector);
  };
  const store = new Map();
  const state = {
    activePreview: "allocations", columnFilters: {}, sortSettings: {},
    orderViewPresets: [], selectedOrderViewPresetId: "", searchQuery: "", shortageFocus: false,
    specificationFilters: new Set(), warehouseFilters: new Set(), managerFilters: new Set(),
    warehouseColorSettings: { colors: {} }, managerColorSettings: { colors: {} },
    columnWidthSettings: { tabs: {} }, columnWidthDrafts: {}, columnWidthDirtyTabs: new Set(),
    columnOrderSettings: { tabs: {} }, hiddenColumnSettings: { tabs: {} },
  };
  const preview = { columns: [{ key: "customer", header: "거래처" }, { key: "quantity", header: "수량", numeric: true }], rows: [], sourceRows: [] };
  const env = {
    state, preview, console, Set, Map, Date, nodes,
    TABLE_WIDTH_MIN: 32, TABLE_WIDTH_MAX: 720,
    ORDER_VIEW_PRESETS_KEY: "test-presets", ORDER_VIEW_PRESETS_SCHEMA: "orderops-order-view-presets/v4",
    PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA: "orderops-order-view-presets/v3",
    LEGACY_ORDER_VIEW_PRESETS_SCHEMA: "orderops-order-view-presets/v2", ORIGINAL_ORDER_VIEW_PRESETS_SCHEMA: "orderops-order-view-presets/v1",
    ORDER_VIEW_PRESET_LIMIT: 100, VIEW_PRESET_TABS: new Set(["allocations", "inventory"]),
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    elements: { columnSortMenu: { querySelector: node, querySelectorAll() { return []; }, addEventListener(type, fn) { env.change = fn; } }, columnSortMenuTitle: node("title"), tableSearchInput: node("search"), specFilterGroup: node("spec") },
    escapeHtml: String, columnSortSetting: () => null, closeColumnSortMenu() {},
    previewDefinitionById: () => preview, getActivePreviewDefinitions: () => ({ allocations: preview, inventory: preview }),
    hasActivePreviewDefinition: () => true, renderPreview() {}, markOrderViewPresetCustom() {},
    currentColumnWidth: () => 100, orderedColumns: (p) => p.columns, hiddenColumnSet: () => new Set(),
    saveColumnWidthSettings() {}, saveColumnOrderSettings() {}, saveHiddenColumnSettings() {}, setActiveFilterPanel() {}, showToast() {},
  };
  const names = ["isPlainRecord", "isSafeColumnKey", "isSafeManagerName", "isSafeHexColor", "normalizeStringList",
    "normalizeStoredColumnFilters", "normalizeStoredColumnWidths", "normalizeStoredColumnOrder", "normalizeStoredColorMap",
    "normalizeOrderViewPreset", "loadOrderViewPresets", "persistOrderViewPresets", "captureOrderViewPreset", "applyOrderViewPreset", "applyDefaultOrderViewPreset",
    "columnFilterSetting", "columnFilterIsActive", "isBlankCell", "isZeroCell", "textFilterValueKey", "columnTextValueOptions", "rowMatchesColumnFilters",
    "refreshColumnSortMenu", "renderColumnTextValueOptions", "setColumnCondition", "initializeColumnTextSelection", "setColumnTextSelection", "applyColumnTextFilter"];
  vm.createContext(env);
  const start = html.indexOf('      elements.columnSortMenu.addEventListener("change",');
  const end = html.indexOf('\n      elements.columnSortMenu.addEventListener("input",', start);
  assert.ok(start > 0 && end > start, "Real checkbox listener must exist");
  vm.runInContext(names.map((name) => extract(html, name)).join("\n") + "\n" + html.slice(start, end), env);
  env.open = (values = ["A", "B", "C"], columnKey = "customer", tab = "allocations") => {
    preview.rows = values.map((v) => columnKey === "customer" ? [v, 1] : ["A", v]);
    state.activeColumnMenu = { previewId: tab, columnKey, textSearch: "", textSelection: null };
    env.refreshColumnSortMenu();
  };
  env.changeValue = (value, checked) => {
    const input = { checked, dataset: { columnValue: env.textFilterValueKey(value) } };
    env.change({ target: { closest: (selector) => selector === "[data-column-value]" ? input : null } });
  };
  env.all = (checked) => env.change({ target: { closest: (selector) => selector === "[data-column-value-select-all]" ? { checked } : null } });
  env.visible = (values, tab = "allocations", columnKey = "customer") => values.filter((value) => env.rowMatchesColumnFilters(tab, { row: columnKey === "customer" ? [value, 1] : ["A", value] }, preview));
  env.save = () => { env.applyColumnTextFilter(); return clone(state.columnFilters[state.activeColumnMenu.previewId][state.activeColumnMenu.columnKey]); };
  env.roundtrip = (name) => {
    state.orderViewPresets = [env.normalizeOrderViewPreset({ id: name, name, previewId: "allocations", isDefault: true, view: env.captureOrderViewPreset() })];
    env.persistOrderViewPresets();
    state.orderViewPresets = env.loadOrderViewPresets();
    state.columnFilters = {};
    env.applyDefaultOrderViewPreset("allocations", { render: false });
  };
  return env;
}
for (const path of paths) {
  const html = fs.readFileSync(ROOT + path, "utf8");
  const inputCommit = /      async function commitInputCandidates\([^\n]*\) \{[\s\S]*?\n      \}/.exec(html)?.[0];
  assert.ok(inputCommit && !inputCommit.includes("resetResultViewFilters()"), "Input replacement must retain filter rules");
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1], { filename: path });
  }
  const test = (label, fn) => { fn(harness(html)); cases++; console.log(`PASS ${path}: ${label}`); };
  test("select all / exclude B / new D survives preset storage and default restore", (h) => {
    h.open(); h.all(true); h.changeValue("B", false);
    assert.deepEqual(h.save(), { valueMode: "exclude", excludedValues: [h.textFilterValueKey("B")] });
    h.roundtrip("exclude-b");
    assert.deepEqual(h.visible(["A", "B", "C", "D"]), ["A", "C", "D"]);
  });
  test("inclusion A,C never admits new D after preset reload", (h) => {
    h.open(); h.all(false); h.changeValue("A", true); h.changeValue("C", true); h.save(); h.roundtrip("include-ac");
    assert.deepEqual(h.visible(["A", "B", "C", "D"]), ["A", "C"]);
  });
  test("individually selecting every current value is not select-all intent", (h) => {
    h.open(); h.all(false); ["A", "B", "C"].forEach((v) => h.changeValue(v, true));
    assert.equal(h.nodes.get("[data-column-value-select-all]").checked, false);
    assert.equal(h.nodes.get("[data-column-value-select-all]").indeterminate, true);
    assert.equal(h.save().valueMode, "include");
    assert.deepEqual(h.visible(["A", "B", "C", "D"]), ["A", "B", "C"]);
    h.all(true); h.save(); assert.deepEqual(h.visible(["A", "B", "C", "D"]), ["A", "B", "C", "D"]);
  });
  test("empty inclusion displays zero rows, not all rows", (h) => {
    h.open(); h.all(false); assert.deepEqual(h.save().allowedValues, []); h.roundtrip("none");
    assert.deepEqual(h.visible(["A", "D"]), []);
  });
  test("all checked with no exclusions displays future values", (h) => {
    h.open(); h.all(true); h.save(); h.roundtrip("all");
    assert.deepEqual(h.visible(["A", "D"]), ["A", "D"]);
  });
  test("missing excluded value is retained when saving another file", (h) => {
    h.open(); h.all(true); h.changeValue("B", false); h.save();
    h.open(["A", "C", "D"]); h.save(); h.roundtrip("missing-exclusion");
    assert.deepEqual(h.visible(["B", "D", "E"]), ["D", "E"]);
  });
  test("missing included value survives reopen and re-save", (h) => {
    h.open(); h.all(false); h.changeValue("B", true); h.save();
    h.open(["A", "C", "D"]); h.save(); h.roundtrip("missing-inclusion");
    assert.deepEqual(h.visible(["B", "D", "E"]), ["B"]);
  });
  test("search select-all changes only visible values without changing mode", (h) => {
    h.open(); h.all(true); h.state.activeColumnMenu.textSearch = "B"; h.renderColumnTextValueOptions(); h.all(false);
    assert.equal(h.save().valueMode, "exclude"); assert.deepEqual(h.visible(["A", "B", "D"]), ["A", "D"]);
    h.open(); h.all(false); h.state.activeColumnMenu.textSearch = "A"; h.renderColumnTextValueOptions(); h.all(true);
    assert.equal(h.save().valueMode, "include"); assert.deepEqual(h.visible(["A", "B", "D"]), ["A"]);
  });
  test("legacy allowedValues migrate conservatively to inclusion", (h) => {
    h.state.columnFilters.allocations = h.normalizeStoredColumnFilters({ customer: { allowedValues: [h.textFilterValueKey("A")] } });
    h.open(); assert.equal(h.state.activeColumnMenu.textMode, "include"); h.save();
    assert.deepEqual(h.visible(["A", "D"]), ["A"]);
  });
  test("inclusion above 500 entries is not silently truncated", (h) => {
    const values = Array.from({ length: 650 }, (_, i) => "항목" + i);
    h.open(values); h.all(false); values.forEach((v) => h.changeValue(v, true)); h.save(); h.roundtrip("large-include");
    assert.equal(h.state.columnFilters.allocations.customer.allowedValues.length, 650);
    assert.equal(h.visible([...values, "신규"]).length, 650);
  });
  test("exclusion above 500 entries is not silently truncated", (h) => {
    const values = Array.from({ length: 650 }, (_, i) => "항목" + i);
    h.open(values); h.all(true); values.forEach((v) => h.changeValue(v, false)); h.save(); h.roundtrip("large-exclude");
    assert.equal(h.state.columnFilters.allocations.customer.excludedValues.length, 650);
    assert.deepEqual(h.visible([...values, "신규"]), ["신규"]);
  });
  test("blank, quotes and zero preserve stable value identity", (h) => {
    h.open(["", null, "A\"B", "0"]); h.all(true); h.changeValue("", false); h.changeValue('A"B', false); h.save();
    assert.deepEqual(h.visible(["", undefined, " ", 'A"B', "0", "D"]), ["0", "D"]);
  });
  test("numeric conditions stay independent of checklist confirmation", (h) => {
    h.state.columnFilters.allocations = { quantity: { excludeZero: true, excludeBlank: true } };
    h.open(["", 0, 1, 2], "quantity"); h.all(true); h.changeValue(2, false); const saved = h.save();
    assert.equal(saved.excludeZero, true); assert.equal(saved.excludeBlank, true);
    assert.deepEqual(h.visible(["", 0, 1, 2, 3], "allocations", "quantity"), [1, 3]);
    h.setColumnCondition("allocations", "quantity", "excludeZero", false);
    assert.deepEqual(h.visible([0, 1, 2, 3], "allocations", "quantity"), [0, 1, 3]);
  });
  test("selecting only nonzero values remains inclusion", (h) => {
    h.open([0, 1, 2], "quantity"); h.all(false); h.changeValue(1, true); h.changeValue(2, true);
    assert.equal(h.save().valueMode, "include");
    assert.deepEqual(h.visible([0, 1, 2, 3], "allocations", "quantity"), [1, 2]);
  });
  test("unchecking zero from select-all retains existing dynamic zero exclusion", (h) => {
    h.open([0, 1, 2], "quantity"); h.all(true); h.changeValue(0, false);
    assert.equal(h.save().excludeZero, true);
    assert.deepEqual(h.visible([0, "0.0", 1, 2, 3], "allocations", "quantity"), [1, 2, 3]);
  });
  test("columns and tabs retain independent rules", (h) => {
    h.open(); h.all(true); h.changeValue("B", false); h.save();
    h.open([1, 2], "quantity"); h.all(false); h.changeValue(1, true); h.save();
    h.open(["A", "B"], "customer", "inventory"); h.all(false); h.changeValue("B", true); h.save();
    assert.deepEqual(h.visible(["A", "B", "D"]), ["A", "D"]);
    assert.deepEqual(h.visible([1, 2, 3], "allocations", "quantity"), [1]);
    assert.deepEqual(h.visible(["A", "B", "D"], "inventory"), ["B"]);
  });
  test("cancelled draft changes do not alter active rules", (h) => {
    h.open(); h.all(true); h.changeValue("B", false); h.save(); const before = clone(h.state.columnFilters);
    h.open(); h.all(false); h.changeValue("B", true);
    assert.deepEqual(clone(h.state.columnFilters), before);
  });
}
console.log(`OrderOps filter intent passed (${cases} behavioral cases, current standalone HTML syntax-checked; frozen route checked separately).`);
