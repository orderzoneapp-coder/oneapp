import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildReferenceGeneration, REFERENCE_DOMAINS } from '../smartinput/reference-generation-repository.js';
import { loadLocalWarehouseCatalog } from '../smartinput/reference-refresh-controller.js';

const snapshots = Object.fromEntries(REFERENCE_DOMAINS.map(domain => [domain, { status: 'EMPTY', rows: [], revision: '1' }]));
snapshots.warehouse = { status: 'READY', rows: [{ warehouseId: 'W1', warehouseCode: '01', warehouseName: '검증 창고' }], revision: '2' };
const bundle = buildReferenceGeneration({ companyId: 'C1', generationId: 'G1', snapshots });
bundle.generation.status = 'ACTIVE';
let requestedCompany;
const options = { loadGeneration: async company => { requestedCompany = company; return structuredClone(bundle); } };
const catalog = await loadLocalWarehouseCatalog('C1', options);
assert.equal(requestedCompany, 'C1');
assert.deepEqual(catalog.warehouses, snapshots.warehouse.rows);
assert.equal(catalog.generationId, 'G1');
assert.equal(catalog.revision, '2');
assert.equal(catalog.aliasesAvailable, false);
const aliasRows = [{ warehouseId: 'W1', warehouseCode: '01', warehouseName: '검증 창고', referenceAliases: [{ warehouseId: 'W1', rawText: '본창고' }] }];
const aliasBundle = buildReferenceGeneration({ companyId: 'C1', generationId: 'G-ALIAS', snapshots: { ...snapshots, warehouse: { rows: aliasRows } } });
aliasBundle.generation.status = 'ACTIVE';
const aliasCatalog = await loadLocalWarehouseCatalog('C1', { loadGeneration: async () => aliasBundle });
assert.equal(aliasCatalog.aliasesAvailable, true);
assert.deepEqual(aliasCatalog.aliases, [{ warehouseId: 'W1', rawText: '본창고' }]);
await assert.rejects(loadLocalWarehouseCatalog('C2', options), /SCOPE_INVALID/);
await assert.rejects(loadLocalWarehouseCatalog('C1', { loadGeneration: async () => null }), /로컬 창고 기준정보/);
for (const mutate of [
  copy => { copy.generation.status = 'STAGED'; },
  copy => { delete copy.generation.domains.customer; },
  copy => { copy.generation.domains.product.count = 2; },
  copy => { copy.entities[0].generationId = 'OTHER'; },
  copy => { copy.entities[0].value.warehouseName = '변조'; }
]) {
  const copy = structuredClone(bundle); mutate(copy);
  await assert.rejects(loadLocalWarehouseCatalog('C1', { loadGeneration: async () => copy }));
}
const emptyBundle = buildReferenceGeneration({ companyId: 'C1', generationId: 'G2', snapshots: { ...snapshots, warehouse: { status: 'EMPTY', rows: [] } } });
emptyBundle.generation.status = 'ACTIVE';
assert.deepEqual((await loadLocalWarehouseCatalog('C1', { loadGeneration: async () => emptyBundle })).warehouses, []);

const source = fs.readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
}
let settingsResult;
const settingsContext = vm.createContext({ getMerchOpsSettingsSnapshotResult: () => settingsResult });
vm.runInContext(functionSource('merchOpsEstimateOutputConfig', 'estimateF8RecoveryTargets'), settingsContext);
for (const result of [
  { status: 'ERROR', error: { code: 'READ_FAILED' } },
  { status: 'READY', snapshot: { values: { marginRules: 'invalid', mappings: {} } } },
  { status: 'READY', snapshot: { values: { marginRules: [], mappings: [] } } }
]) {
  settingsResult = result;
  assert.throws(() => settingsContext.merchOpsEstimateOutputConfig(), /가격·매핑 설정/);
}
settingsResult = { status: 'READY', snapshot: { values: { marginRules: [{ rate: 0 }], mappings: { A: 0 } } } };
assert.deepEqual(JSON.parse(JSON.stringify(settingsContext.merchOpsEstimateOutputConfig())), { marginRules: [{ rate: 0 }], estimateMappings: { A: 0 } });

let rendered = 0;
const renderContext = vm.createContext({
  state: { companyId: 'C1', draft: { activeMode: 'order' }, voucherActivity: { companyId: 'C1', date: '2026-09-20', status: 'READY', requestId: 1, rows: [{ id: 'O1' }] } },
  voucherActivityDate: () => '2026-09-21',
  renderVoucherActivitySnapshot: () => { rendered += 1; },
  loadVoucherActivity: () => { throw new Error('render started owner read'); }
});
vm.runInContext(functionSource('renderVoucherContext', 'relatedPanelButtonLabel'), renderContext);
renderContext.renderVoucherContext();
assert.equal(rendered, 1);
assert.equal(renderContext.state.voucherActivity.status, 'IDLE');
assert.equal(renderContext.state.voucherActivity.rows.length, 0);
assert.equal(renderContext.state.voucherActivity.requestId, 2);
const resumeContext = vm.createContext({ SMARTINPUT_SHOPPING_ORDER_UPLOAD_SCHEMA: 'ONEAPP_SMARTINPUT_SHOPPING_ORDER_UPLOAD_V1' });
vm.runInContext(functionSource('resetResumedShoppingInspection', 'inputMatchingContext'), resumeContext);
for (const status of ['ANALYZING', 'READY', 'ERROR']) {
  const resumed = { modes: { order: { shoppingOrderImport: {
    schemaVersion: 'ONEAPP_SMARTINPUT_SHOPPING_ORDER_UPLOAD_V1', status,
    inspection: { summary: { newCount: 0 } }, inspectionError: { message: 'old' },
    sourceRows: [{ sourceCells: ['원본', 0] }], commitResult: { receipt: 'saved-receipt' }
  } } } };
  resumeContext.resetResumedShoppingInspection(resumed);
  const upload = resumed.modes.order.shoppingOrderImport;
  assert.equal(upload.status, 'LOADED');
  assert.equal(upload.inspection, null);
  assert.deepEqual(upload.sourceRows, [{ sourceCells: ['원본', 0] }]);
  assert.deepEqual(upload.commitResult, { receipt: 'saved-receipt' });
}
assert.doesNotMatch(source, /scheduleOfficialVoucherSync\(false\)|scheduleShoppingOrderInspection/);
assert.match(source, /loadLocalWarehouseCatalog\(companyId\)/);
let definitionReads = 0;
let displayDefinitions = [
  { id: 'mappedQuantity', projectionFieldId: 'quantity' },
  { id: 'duplicateQuantity', projectionFieldId: 'quantity' },
  { id: 'memo' }
];
const displayContext = vm.createContext({ inputMappingDefinitions: () => { definitionReads += 1; return displayDefinitions; } });
vm.runInContext(functionSource('createRowFieldDisplayReader', 'markMappedFieldEdited'), displayContext);
const readDisplay = displayContext.createRowFieldDisplayReader();
assert.equal(readDisplay({}, 'quantity', 0), 0);
assert.equal(readDisplay({ fieldValues: {} }, 'memo', ''), '');
assert.equal(definitionReads, 0, 'ordinary rows must not build mapping definitions');
const mappedRow = { fieldValues: {
  mappedQuantity: { edited: false, currentDisplayValue: '0002' },
  duplicateQuantity: { edited: false, currentDisplayValue: 'wrong target' },
  memo: { edited: false, currentDisplayValue: '' }
} };
assert.equal(readDisplay(mappedRow, 'quantity', 2), '0002');
assert.equal(readDisplay(mappedRow, 'memo', 'fallback'), '');
assert.equal(readDisplay(mappedRow, 'unknown', 0), 0);
assert.equal(definitionReads, 1, 'one mapping definition set per render');
mappedRow.fieldValues.mappedQuantity.edited = true;
assert.equal(readDisplay(mappedRow, 'quantity', 0), 0);
displayDefinitions = [{ id: 'duplicateQuantity', projectionFieldId: 'quantity' }];
assert.equal(displayContext.createRowFieldDisplayReader()(mappedRow, 'quantity', 2), 'wrong target');
assert.equal(definitionReads, 2, 'new render must observe changed definitions');
function columnContainer(ids) {
  const container = { children: [], moves: 0, insertBefore(cell, next) {
    this.children.splice(this.children.indexOf(cell), 1);
    this.children.splice(this.children.indexOf(next), 0, cell);
    this.moves += 1;
  } };
  container.children = ids.map(id => ({ dataset: { column: id }, get nextElementSibling() {
    return container.children[container.children.indexOf(this) + 1] || null;
  } }));
  return container;
}
const columnCases = [
  [undefined, 'itemCode', 'memo', 'quantity', 'itemName', 'status'],
  [undefined, 'quantity', 'itemName', 'memo', 'itemCode', 'status'],
  [undefined, 'unknown', 'quantity', 'itemCode', 'memo', 'status'],
  [undefined, 'memo', 'itemCode', 'quantity', 'itemName', 'itemCode', 'status']
];
for (const ids of columnCases) {
  const container = columnContainer(ids);
  const expected = columnContainer(ids);
  for (const fieldId of ['itemCode', 'memo', 'quantity', 'itemName']) {
    const cell = expected.children.find(child => child.dataset.column === fieldId);
    if (cell) expected.insertBefore(cell, expected.children.find(child => child.dataset.column === 'status'));
  }
  const orderContext = vm.createContext({
    voucherColumnsForMode: () => ['memo', 'itemCode', 'quantity'],
    layoutDefinitions: () => ['itemCode', 'itemName', 'quantity', 'memo'].map(id => ({ id })),
    document: { querySelector: selector => selector.endsWith('colgroup') ? container : null, querySelectorAll: () => [] }
  });
  vm.runInContext(functionSource('applyVoucherColumnOrder', 'clearColumnDragMarkers'), orderContext);
  orderContext.applyVoucherColumnOrder();
  assert.deepEqual(container.children.map(cell => cell.dataset.column), expected.children.map(cell => cell.dataset.column), 'column order must match the previous implementation');
  container.moves = 0;
  orderContext.applyVoucherColumnOrder();
  if (new Set(ids).size === ids.length) assert.equal(container.moves, 0, 'unchanged column order must not reparent focused inputs');
}
let releaseInspection;
const pendingInspection = new Promise(resolve => { releaseInspection = resolve; });
const pendingUpload = { status: 'LOADED' };
let shoppingCommits = 0;
const shoppingContext = vm.createContext({
  state: { busy: false, activeFileInputAttemptId: null, estimateSelectionQueue: Promise.resolve() },
  window: { setTimeout },
  shoppingOrderImport: () => pendingUpload,
  refreshShoppingOrderInspection: async () => {
    pendingUpload.status = 'ANALYZING';
    await pendingInspection;
    pendingUpload.status = 'READY';
    pendingUpload.inspection = { summary: { newCount: 0 } };
    return pendingUpload.inspection;
  },
  renderDelivery: () => {}, renderShoppingOrderPanel: () => {},
  setAppStatus: () => {}, toast: () => {},
  commitShoppingOrderUpload: () => { shoppingCommits += 1; throw new Error('empty inspection must not commit'); }
});
vm.runInContext(source.slice(source.indexOf('async function waitForSmartInputIdle('), source.indexOf('\nasync function flushSmartInputBeforeWorkspaceLeave(')), shoppingContext);
vm.runInContext(source.slice(source.indexOf('async function completeShoppingOrderImport('), source.indexOf('\nfunction renderRows(')), shoppingContext);
const pendingCompletion = shoppingContext.completeShoppingOrderImport();
assert.equal(shoppingContext.state.busy, true, 'host must wait during delivery preflight');
assert.equal(pendingUpload.status, 'ANALYZING');
let idleResolved = false;
const pendingIdle = shoppingContext.waitForSmartInputIdle().then(() => { idleResolved = true; });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(idleResolved, false, 'beforeLeave idle gate cannot resolve before owner inspection');
releaseInspection();
await Promise.all([pendingCompletion, pendingIdle]);
assert.equal(shoppingContext.state.busy, false, 'empty result must release the delivery guard');
shoppingContext.refreshShoppingOrderInspection = async () => { throw new Error('inspection unavailable'); };
pendingUpload.status = 'LOADED';
await shoppingContext.completeShoppingOrderImport();
assert.equal(shoppingContext.state.busy, false, 'inspection failure must release the delivery guard');
assert.equal(shoppingCommits, 0, 'empty and failed inspections cannot commit');
console.log('SmartInput independent local references, settings failure, and render isolation passed.');
