import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const indexSource = fs.readFileSync(new URL('../smartinput/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const appSource = fs.readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const startMarker = "    (() => {\n      const validModes = ['order', 'purchase', 'sale', 'estimate'];";
const start = indexSource.indexOf(startMarker);
const end = indexSource.indexOf('\n  </script>', start);
assert.ok(start >= 0 && end > start, 'SmartInput early draft bootstrap script must remain discoverable');
const bootstrapSource = indexSource.slice(start, end);
const loadDraftStart = appSource.indexOf('function loadDraft() {');
const loadDraftEnd = appSource.indexOf('\nfunction hasMeaningfulDraftContent', loadDraftStart);
assert.ok(loadDraftStart >= 0 && loadDraftEnd > loadDraftStart, 'SmartInput loadDraft function must remain discoverable');
const loadDraftSource = appSource.slice(loadDraftStart, loadDraftEnd);

function createBootstrap(rawValue) {
  let readCount = 0;
  const window = new EventTarget();
  const localStorage = {
    getItem(key) {
      assert.equal(key, 'oneapp.smartinput.draft.v1');
      readCount += 1;
      return rawValue;
    }
  };
  const context = vm.createContext({
    resetResumedShoppingInspection: value => value,
    AbortController,
    Boolean,
    Event,
    EventTarget,
    JSON,
    localStorage,
    window
  });
  vm.runInContext(bootstrapSource, context);
  return {
    get readCount() { return readCount; },
    shell: window.__ONEAPP_SMARTINPUT_EARLY_UI__,
    dispatchStorage(key) {
      const event = new Event('storage');
      Object.defineProperty(event, 'key', { value: key });
      window.dispatchEvent(event);
    }
  };
}

function runMainLoadDraft(shell, rawValue) {
  let readCount = 0;
  const context = vm.createContext({
    resetResumedShoppingInspection: value => value,
    contract: {
      DRAFT_STORAGE_KEY: 'oneapp.smartinput.draft.v1',
      createDraft: () => ({ activeMode: 'order', fallback: true }),
      normalizeDraft: value => value || { activeMode: 'order', empty: true }
    },
    earlyUi: shell,
    JSON,
    localStorage: {
      getItem(key) {
        assert.equal(key, 'oneapp.smartinput.draft.v1');
        readCount += 1;
        return rawValue;
      }
    }
  });
  vm.runInContext(`${loadDraftSource}\nresult = loadDraft();`, context);
  return { readCount, result: JSON.parse(JSON.stringify(context.result)) };
}

const fixture = {
  schemaVersion: 'ONEAPP_SMART_INPUT_DRAFT_V1',
  activeMode: 'estimate',
  ui: { relatedPanelLayoutVersion: 1, relatedOpen: false },
  modes: { estimate: { rows: [{ rowId: 'ROW-1', itemName: '보존 상품' }] } }
};

const unchanged = createBootstrap(JSON.stringify(fixture));
assert.equal(unchanged.readCount, 1, 'early bootstrap must read the compatibility draft once');
assert.equal(unchanged.shell.activeMode, 'estimate');
assert.equal(unchanged.shell.relatedOpen, false);
assert.deepEqual(
  JSON.parse(JSON.stringify(unchanged.shell.consumeInitialDraft())),
  { reused: true, value: fixture },
  'unchanged bootstrap must hand the parsed draft to the main application'
);

const unchangedMainPath = createBootstrap(JSON.stringify(fixture));
const reusedByMain = runMainLoadDraft(unchangedMainPath.shell, JSON.stringify({ activeMode: 'order' }));
assert.equal(reusedByMain.readCount, 0, 'main initialization must not read unchanged compatibility data again');
assert.deepEqual(reusedByMain.result, fixture, 'main initialization must receive the exact parsed bootstrap value');
assert.deepEqual(
  JSON.parse(JSON.stringify(unchanged.shell.consumeInitialDraft())),
  { reused: false, value: null },
  'the bootstrap draft must be one-shot'
);

const crossDocumentChange = createBootstrap(JSON.stringify(fixture));
crossDocumentChange.dispatchStorage('oneapp.smartinput.draft.v1');
assert.equal(crossDocumentChange.shell.consumeInitialDraft().reused, false, 'another document write must invalidate the cache');

const crossDocumentClear = createBootstrap(JSON.stringify(fixture));
crossDocumentClear.dispatchStorage(null);
assert.equal(crossDocumentClear.shell.consumeInitialDraft().reused, false, 'another document clear must invalidate the cache');

const sameDocumentChange = createBootstrap(JSON.stringify(fixture));
sameDocumentChange.shell.invalidateInitialDraft();
assert.equal(sameDocumentChange.shell.consumeInitialDraft().reused, false, 'same-document writes must invalidate the cache directly');

const changedBeforeMain = createBootstrap(JSON.stringify(fixture));
changedBeforeMain.shell.invalidateInitialDraft();
const latestFixture = { ...fixture, activeMode: 'sale' };
const reloadedByMain = runMainLoadDraft(changedBeforeMain.shell, JSON.stringify(latestFixture));
assert.equal(reloadedByMain.readCount, 1, 'invalidated initialization must use the existing fresh-read path once');
assert.deepEqual(reloadedByMain.result, latestFixture);

const malformed = createBootstrap('{broken-json');
assert.equal(malformed.readCount, 1);
assert.equal(malformed.shell.consumeInitialDraft().reused, false, 'malformed data must use the existing fallback path');

assert.match(appSource, /const bootstrapDraft = earlyUi\?\.consumeInitialDraft\?\.\(\);/);
assert.match(appSource, /if \(bootstrapDraft\?\.reused\)/);
assert.equal(
  [...appSource.matchAll(/earlyUi\?\.invalidateInitialDraft\?\.\(\);/g)].length,
  2,
  'both same-document compatibility draft write paths must invalidate the bootstrap cache'
);

console.log('SmartInput draft bootstrap reuse tests passed.');
