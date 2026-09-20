import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual UI lifecycle against controlled asynchronous local reads.
const source = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `${start} lifecycle must remain testable`);
  return source.slice(first, last);
}
const saveSource = extract('async function saveEstimateDocument(', '\nfunction clearCustomerAfterSave(');
const idleSource = extract('async function waitForSmartInputIdle(', '\nasync function flushSmartInputBeforeWorkspaceLeave(');
function fixture({ read, schema = 'INDEPENDENT', collision = false, confirm = true } = {}) {
  const draft = { catalogRecordId: collision ? '' : 'E1', header: {}, rows: [{ rowId: 'R1', itemCode: 'A', quantity: 0, unitPrice: 1750 }] };
  const record = { estimateId: 'E1', catalogName: '견적', schemaVersion: schema, draft };
  const observed = { reads: 0, writes: 0, selected: [], renders: [], messages: [] };
  const state = { companyId: 'C1', busy: false, activeFileInputAttemptId: '', estimateSelectionQueue: Promise.resolve(),
    estimates: [record], draft: { modes: { estimate: draft } } };
  const context = vm.createContext({
    state, window: { setTimeout, confirm: () => confirm }, structuredClone, Date,
    INDEPENDENT_ESTIMATE_SCHEMA: 'INDEPENDENT',
    modeDraft: () => state.draft.modes.estimate,
    validateEstimateDocument: () => true,
    ensureEstimateBodies: async () => { observed.reads += 1; await read?.(); },
    estimateTitle: item => item.catalogName,
    renderDelivery: () => observed.renders.push(state.busy),
    toast: message => observed.messages.push(message),
    estimateWorkspace: {
      pending: async () => [], adopt: () => {},
      edit: async () => { observed.writes += 1; },
      select: ids => { observed.selected = [...ids]; }
    },
    createCatalogOnlyDraft: current => current,
    estimateStore: { loadEstimateForUpdate: async () => ({ status: 'READY', record: { ...record, draft: { ...draft, saved: true } } }) },
    contract: { normalizeModeDraft: (_mode, current) => current },
    hydrateEstimateLibrary: async () => {}, saveDraftNow: () => {}, renderMode: () => {}, setAppStatus: () => {}
  });
  vm.runInContext(`${saveSource}\n${idleSource}`, context);
  return { context, state, draft, observed };
}

let release;
const pendingRead = new Promise(resolve => { release = resolve; });
const normal = fixture({ read: () => pendingRead });
const completion = normal.context.saveEstimateDocument('견적');
assert.equal(normal.state.busy, true, 'the UI must be busy before the first asynchronous read');
assert.equal(await normal.context.saveEstimateDocument('견적'), false, 'a duplicate submission must not start another read');
assert.equal(normal.observed.reads, 1);
let idle = false;
const beforeLeaveIdle = normal.context.waitForSmartInputIdle().then(() => { idle = true; });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(idle, false, 'host beforeLeave idle gate must wait for estimate preparation');
release();
assert.equal(await completion, true);
await beforeLeaveIdle;
assert.equal(normal.observed.writes, 1);
assert.equal(normal.state.busy, false);
assert.deepEqual(normal.observed.selected, ['E1']);
assert.equal(normal.state.draft.modes.estimate.rows[0].quantity, 0);

const failed = fixture({ read: async () => { throw new Error('LOCAL_READ_FAILED'); } });
assert.equal(await failed.context.saveEstimateDocument('견적'), false);
assert.equal(failed.state.busy, false, 'failed preparation must release busy');
assert.equal(failed.observed.writes, 0);
assert.equal(failed.state.draft.modes.estimate, failed.draft, 'failed preparation must preserve the active draft');
assert.deepEqual(failed.observed.messages, ['LOCAL_READ_FAILED']);

for (const options of [{ schema: 'LEGACY' }, { collision: true, confirm: false }]) {
  const blocked = fixture(options);
  assert.equal(await blocked.context.saveEstimateDocument('견적'), false);
  assert.equal(blocked.state.busy, false, 'validation rejection or overwrite cancellation must release busy');
  assert.equal(blocked.observed.writes, 0);
}

let releaseChanged;
const changed = fixture({ read: () => new Promise(resolve => { releaseChanged = resolve; }) });
const oldSave = changed.context.saveEstimateDocument('견적');
const replacement = { catalogRecordId: '', header: {}, rows: [{ itemName: '새 작업', quantity: 3 }] };
changed.state.draft.modes.estimate = replacement;
releaseChanged();
assert.equal(await oldSave, true);
assert.equal(changed.state.draft.modes.estimate, replacement, 'completion of an older save must not overwrite a new active draft');
assert.deepEqual(changed.observed.selected, [], 'an older save must not reselect itself over the new draft');
assert.equal(changed.state.busy, false);
console.log('SmartInput estimate save lifecycle: busy/read failure/cancel/duplicate/host idle/new draft PASS');
