#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const dataOpsSource = fs.readFileSync("DataOps.html", "utf8");
const masterSource = fs.readFileSync("masterAddUpdate.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("app-manifest.json", "utf8"));
const architecture = fs.readFileSync("APP_ARCHITECTURE.md", "utf8");

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${label} start marker`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing ${label} end marker`);
  return source.slice(start, end);
}

const moduleSource = sliceBetween(
  dataOpsSource,
  "const DATAOPS_INVENTORY_MASTER_ADD_MODULE =",
  "window.DATAOPS_INVENTORY_MASTER_ADD_MODULE = DATAOPS_INVENTORY_MASTER_ADD_MODULE;",
  "DataOps inventory master add module",
);

class MemoryLocalStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

const retryLocalStorage = new MemoryLocalStorage();
const dataOpsContext = vm.createContext({
  console,
  Date,
  Math,
  JSON,
  Object,
  Array,
  Set,
  Map,
  String,
  Number,
  Boolean,
  RegExp,
  Intl,
  window: { localStorage: retryLocalStorage },
  safeStr(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim();
    return text ? text : fallback;
  },
  DATAOPS_ISSUE_HELPER: {
    unique(values = []) {
      return [...new Set(values.filter(Boolean))];
    },
  },
});
vm.runInContext(`${moduleSource}\nglobalThis.inventoryMasterAddApi = DATAOPS_INVENTORY_MASTER_ADD_MODULE;`, dataOpsContext, {
  filename: "DataOps.inventory-master-add.js",
});
const dataOpsApi = dataOpsContext.inventoryMasterAddApi;

const searchMaster = {
  A100: { 코드: "A100", 품목코드: "A100", 품목명: "Red Apple", 규격: "1 kg", 단위: "BOX", 검색어등록: "fresh-fruit", 창고: "SECRET-WH", 판매여부: 1 },
  A101: { 코드: "A101", 품목코드: "A101", 품목명: "Red Pear", 규격: "2kg", 단위: "EA", 검색어등록: "fresh fruit", 창고: "SEOUL", 판매여부: 0 },
  B200: { 코드: "B200", 품목코드: "B200", 품목명: "Banana", 규격: "10EA", 단위: "BOX", 검색어등록: "yellow" },
};

assert.equal(dataOpsApi.search(searchMaster, "a-100").mode, "immediate", "separator-normalized exact code must win");
assert.equal(dataOpsApi.search(searchMaster, "RED 1-KG").selected.품목코드, "A100", "multi-term AND search must normalize case/space/separators");
assert.equal(dataOpsApi.search(searchMaster, "A100Red").mode, "register", "a token must not match across code/name field boundaries");
assert.equal(dataOpsApi.search(searchMaster, "fresh").mode, "choose", "multiple matches must open selection");
assert.equal(dataOpsApi.search(searchMaster, "yellow").selected.품목코드, "B200", "keyword field must be searchable");
assert.equal(dataOpsApi.search(searchMaster, "BOX").matches.length, 0, "unit must not be searched");
assert.equal(dataOpsApi.search(searchMaster, "SECRET-WH").matches.length, 0, "warehouse must not be searched");
assert.equal(dataOpsApi.search(searchMaster, "missing").mode, "register", "zero results must enter registration");

const stoppedRow = dataOpsApi.buildInventoryRow(searchMaster.A101, { batchKey: "added-A101", anchorBatchKey: "anchor", targetDateStr: "2026-08-05" });
assert.deepEqual(
  [stoppedRow.기초, stoppedRow.입고, stoppedRow.출고, stoppedRow.전산잔량, stoppedRow.로스],
  [0, 0, 0, 0, 0],
  "out-of-list inventory numbers must start at zero",
);
assert.equal(stoppedRow.상태, "목록 외 실사발견");
assert.equal(stoppedRow._inventoryMasterWasStopped, true);
assert.equal(dataOpsApi.applyActual(stoppedRow, 0).action, "exclude", "actual zero must remove an added row");
const positiveStopped = dataOpsApi.applyActual(stoppedRow, 3).row;
assert.equal(positiveStopped.실사, 3);
assert.equal(positiveStopped.로스, 3);
assert.equal(positiveStopped._inventoryMasterResumeRequired, true);
assert.equal(positiveStopped._inventoryMasterResumeState, "awaiting-close");
assert.equal(dataOpsApi.findExistingRow([{ ...stoppedRow, _hiddenBySalesMove: true }], " A101 ").batchKey, "added-A101", "duplicate lookup must include hidden rows");

const pinnedRows = dataOpsApi.pinAddedRows([
  { batchKey: "other" },
  stoppedRow,
  { batchKey: "anchor" },
]);
assert.deepEqual(Array.from(pinnedRows, row => row.batchKey), ["other", "anchor", "added-A101"], "added row must stay immediately after its anchor");
const consecutiveRows = dataOpsApi.pinAddedRows([
  { ...stoppedRow, batchKey: "added-2", _manualDisplayAfterBatchKey: "added-A101" },
  { batchKey: "anchor" },
  stoppedRow,
]);
assert.deepEqual(Array.from(consecutiveRows, row => row.batchKey), ["anchor", "added-A101", "added-2"], "consecutive F6 additions must retain their working position");

let retryRecords = dataOpsApi.markRetry({}, { codes: ["A101", "A101"], closingRevision: "close-rev-1", state: "pending" });
dataOpsApi.writeRetryRecords(retryRecords, retryLocalStorage);
assert.deepEqual(Array.from(dataOpsApi.getRetryCodes(dataOpsApi.readRetryRecords(retryLocalStorage))), ["A101"]);
retryRecords = dataOpsApi.markRetry(retryRecords, { codes: ["A101"], state: "failed", error: "forced" });
assert.equal(retryRecords.A101.closingRevision, "close-rev-1", "retry must retain the finalized closing revision");
assert.equal(retryRecords.A101.state, "failed");
assert.equal(JSON.stringify(dataOpsApi.clearRetry(retryRecords, ["A101"])), "{}");

const browser = { crypto: { randomUUID: () => crypto.randomUUID() } };
const masterContext = vm.createContext({ window: browser, console, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean });
vm.runInContext(masterSource, masterContext, { filename: "masterAddUpdate.js" });
const masterApi = browser.ONEAPP_MASTER_ADD_UPDATE;
assert.ok(masterApi?.commitSingleProductRegistration);
assert.ok(masterApi?.commitSalesStatusChanges);

const clone = value => structuredClone(value);

function createStorage(initialMaster, localStorageRef, options = {}) {
  let state = {
    masterMap: clone(initialMaster),
    revision: options.revision || "rev-1",
    extraStoreEntries: clone(options.extraStoreEntries || {}),
  };
  let revisionCounter = 1;
  let failHistory = !!options.failHistory;
  return {
    get state() {
      return clone(state);
    },
    async readMasterSnapshotState(extraKeys = []) {
      const extras = {};
      for (const key of extraKeys || []) extras[key] = clone(state.extraStoreEntries[key]);
      return { masterMap: clone(state.masterMap), revision: state.revision, extraStoreEntries: extras };
    },
    writeLocalValue(key, value) {
      localStorageRef.setItem(key, value);
      return String(value);
    },
    writeLocalJSON(key, value) {
      if (failHistory && key === "merchHistory_v870") {
        failHistory = false;
        throw new Error("forced history failure");
      }
      localStorageRef.setItem(key, JSON.stringify(value));
    },
    restoreLocalValue(key, raw) {
      if (raw === null || raw === undefined) localStorageRef.removeItem(key);
      else localStorageRef.setItem(key, raw);
    },
    async commitMasterStateOrThrow(nextMaster, commitOptions) {
      if (state.revision !== commitOptions.expectedRevision) {
        const error = new Error("forced revision conflict");
        error.code = "MERCH_MASTER_REVISION_CONFLICT";
        throw error;
      }
      if (options.failMaster) {
        const error = new Error("forced master failure");
        error.code = "MERCH_MASTER_COMMIT_FAILURE";
        throw error;
      }
      const previous = clone(state);
      const revision = `rev-${++revisionCounter}`;
      state = {
        masterMap: clone(nextMaster),
        revision,
        extraStoreEntries: { ...clone(state.extraStoreEntries), ...clone(commitOptions.extraStoreEntries || {}) },
      };
      try {
        if (commitOptions.afterVerified) await commitOptions.afterVerified();
      } catch (cause) {
        state = previous;
        const error = new Error(cause.message);
        error.code = "MERCH_MASTER_COMMIT_FAILURE";
        error.result = { revision, rollbackOk: true };
        throw error;
      }
      return { ok: true, verified: true, revision };
    },
  };
}

const historyApi = {
  DEFAULT_LIMIT: 5000,
  normalizeHistoryLog(payload) {
    return { normalized: true, ...payload };
  },
};

const baseMaster = {
  A100: { 코드: "A100", 품목코드: "A100", 품목명: "사과", 규격: "1kg", 단위: "EA", 판매여부: 1 },
  A101: { 코드: "A101", 품목코드: "A101", 품목명: "배", 규격: "2kg", 단위: "BOX", 판매여부: 0 },
};

{
  const local = new MemoryLocalStorage({ merchHistory_v870: "[]", merchMaster_sync_trigger: "before" });
  const storage = createStorage(baseMaster, local);
  const result = await masterApi.commitSingleProductRegistration({
    item: { 품목코드: " C300 ", 품목명: "감", 규격: "3kg", 단위: "BOX" },
    expectedRevision: "rev-1",
    storage,
    historyApi,
    localStorageRef: local,
  });
  assert.equal(result.item.코드, "C300");
  assert.equal(storage.state.masterMap.C300.품목명, "감");
  const history = JSON.parse(local.getItem("merchHistory_v870"));
  assert.equal(history.length, 5, "single registration must write job plus four field logs");
  assert.ok(history.every(log => log.source === "dataops_inventory"));
  assert.notEqual(local.getItem("merchMaster_sync_trigger"), "before");
}

await assert.rejects(
  masterApi.commitSingleProductRegistration({
    item: { 품목코드: "A100", 품목명: "중복", 규격: "1", 단위: "EA" },
    expectedRevision: "rev-1",
    storage: createStorage(baseMaster, new MemoryLocalStorage({ merchHistory_v870: "[]" })),
    historyApi,
    localStorageRef: new MemoryLocalStorage({ merchHistory_v870: "[]" }),
  }),
  error => error.code === "MASTER_SINGLE_PRODUCT_DUPLICATE_CODE",
);

await assert.rejects(
  masterApi.commitSingleProductRegistration({
    item: { 품목코드: "C301", 품목명: "", 규격: "1", 단위: "EA" },
    expectedRevision: "rev-1",
    storage: createStorage(baseMaster, new MemoryLocalStorage({ merchHistory_v870: "[]" })),
    historyApi,
    localStorageRef: new MemoryLocalStorage({ merchHistory_v870: "[]" }),
  }),
  error => error.code === "MASTER_SINGLE_PRODUCT_REQUIRED_MISSING",
);

{
  const local = new MemoryLocalStorage({ merchHistory_v870: "[]", merchMaster_sync_trigger: "before" });
  const storage = createStorage(baseMaster, local, { revision: "rev-2" });
  await assert.rejects(masterApi.commitSingleProductRegistration({
    item: { 품목코드: "C303", 품목명: "감", 규격: "3kg", 단위: "BOX" },
    expectedRevision: "rev-1",
    storage,
    historyApi,
    localStorageRef: local,
  }), error => error.code === "MERCH_MASTER_REVISION_CONFLICT");
  assert.deepEqual(storage.state.masterMap, baseMaster);
  assert.equal(local.getItem("merchHistory_v870"), "[]");
}

{
  const local = new MemoryLocalStorage({ merchHistory_v870: "[]", merchMaster_sync_trigger: "before" });
  const storage = createStorage(baseMaster, local, { failMaster: true });
  await assert.rejects(masterApi.commitSingleProductRegistration({
    item: { 품목코드: "C304", 품목명: "감", 규격: "3kg", 단위: "BOX" },
    expectedRevision: "rev-1",
    storage,
    historyApi,
    localStorageRef: local,
  }), error => error.code === "MERCH_MASTER_COMMIT_FAILURE");
  assert.deepEqual(storage.state.masterMap, baseMaster);
  assert.equal(local.getItem("merchHistory_v870"), "[]");
  assert.equal(local.getItem("merchMaster_sync_trigger"), "before");
}

{
  const local = new MemoryLocalStorage({ merchHistory_v870: JSON.stringify([{ id: "old" }]), merchMaster_sync_trigger: "master-before" });
  const storage = createStorage(baseMaster, local, { failHistory: true });
  await assert.rejects(masterApi.commitSingleProductRegistration({
    item: { 품목코드: "C302", 품목명: "감", 규격: "3kg", 단위: "BOX" },
    expectedRevision: "rev-1",
    storage,
    historyApi,
    localStorageRef: local,
  }));
  assert.deepEqual(storage.state.masterMap, baseMaster, "registration history failure must roll back master");
  assert.equal(local.getItem("merchHistory_v870"), JSON.stringify([{ id: "old" }]));
  assert.equal(local.getItem("merchMaster_sync_trigger"), "master-before");
}

{
  const stopped = { A101: { productCode: "A101", status: "stopped", reason: "품절" } };
  const pending = [{ code: "OLD", type: "stop" }];
  const local = new MemoryLocalStorage({
    merchHistory_v870: "[]",
    merchStoppedProducts_v2: JSON.stringify(stopped),
    pendingShopStatus: JSON.stringify(pending),
    merchMaster_sync_trigger: "master-before",
    merchStopManager_sync_trigger: "stop-before",
  });
  const storage = createStorage(baseMaster, local, {
    extraStoreEntries: { merchStoppedProducts_v2: stopped, pending_shop_status: pending },
  });
  const result = await masterApi.commitSalesStatusChanges({
    codes: ["A101"],
    expectedRevision: "rev-1",
    storage,
    historyApi,
    localStorageRef: local,
  });
  assert.equal(result.status, "success");
  assert.equal(storage.state.masterMap.A101.판매여부, 1);
  assert.equal(storage.state.extraStoreEntries.merchStoppedProducts_v2.A101, undefined);
  assert.equal(storage.state.extraStoreEntries.pending_shop_status.find(row => row.code === "A101").type, "resume");
  const history = JSON.parse(local.getItem("merchHistory_v870"));
  assert.equal(history[0].field, "판매여부");
  assert.equal(history[0].oldVal, 0);
  assert.equal(history[0].newVal, 1);
  assert.match(history[0].path, /^DataOps/);
  const noop = await masterApi.commitSalesStatusChanges({
    codes: ["A101"],
    expectedRevision: result.revision,
    storage,
    historyApi,
    localStorageRef: local,
  });
  assert.equal(noop.status, "noop", "a completed resume retry must be idempotent");
  assert.equal(noop.revision, result.revision);
}

{
  const stopped = { A101: { productCode: "A101", status: "stopped" } };
  const pending = [{ code: "A101", type: "stop" }];
  const initialHistory = JSON.stringify([{ id: "old-history" }]);
  const local = new MemoryLocalStorage({
    merchHistory_v870: initialHistory,
    merchStoppedProducts_v2: JSON.stringify(stopped),
    pendingShopStatus: JSON.stringify(pending),
    merchMaster_sync_trigger: "master-before",
    merchStopManager_sync_trigger: "stop-before",
  });
  const storage = createStorage(baseMaster, local, {
    failHistory: true,
    extraStoreEntries: { merchStoppedProducts_v2: stopped, pending_shop_status: pending },
  });
  await assert.rejects(masterApi.commitSalesStatusChanges({
    codes: ["A101"],
    expectedRevision: "rev-1",
    storage,
    historyApi,
    localStorageRef: local,
  }));
  assert.deepEqual(storage.state.masterMap, baseMaster, "resume history failure must preserve master");
  assert.deepEqual(storage.state.extraStoreEntries.merchStoppedProducts_v2, stopped, "resume history failure must preserve stopped state");
  assert.deepEqual(storage.state.extraStoreEntries.pending_shop_status, pending, "resume history failure must preserve pending state");
  assert.equal(local.getItem("merchHistory_v870"), initialHistory);
  assert.equal(local.getItem("merchStoppedProducts_v2"), JSON.stringify(stopped));
  assert.equal(local.getItem("pendingShopStatus"), JSON.stringify(pending));
  assert.equal(local.getItem("merchMaster_sync_trigger"), "master-before");
  assert.equal(local.getItem("merchStopManager_sync_trigger"), "stop-before");
}

const globalKeyHandler = sliceBetween(dataOpsSource, "const handleGlobalKeys =", "window.addEventListener('keydown', handleGlobalEnter);", "DataOps global key handler");
assert.match(globalKeyHandler, /e\.key === 'F6'/);
assert.match(globalKeyHandler, /handleOpenInventoryMasterAdd/);
assert.match(dataOpsSource, /onClick: handleOpenInventoryMasterAdd/);
assert.match(dataOpsSource, /data-inventory-master-add-draft/);
assert.match(dataOpsSource, /commitSingleProductRegistration/);
assert.match(dataOpsSource, /commitSalesStatusChanges/);
assert.match(dataOpsSource, /dataops_inventory_master_resume_v1/);
assert.match(dataOpsSource, /\.filter\(row => !row\._inventoryMasterAdded \|\| STOCK_ENGINE_MODULE\.getActualQty\(row\) > 0\)/);
const openHandler = sliceBetween(dataOpsSource, "const handleOpenInventoryMasterAdd =", "const closeInventoryMasterAdd =", "DataOps F6 open handler");
assert.doesNotMatch(openHandler, /setFilters|setSearchInputVal|scrollTo/, "opening F6 must preserve filters, search, and scroll position");
assert.match(dataOpsSource, /scrollIntoView\(\{ behavior: 'auto', block: 'nearest' \}\)/);

const f9 = sliceBetween(dataOpsSource, "const handleCombinedExport = useCallback", "const handlePrintOutput = useCallback", "DataOps F9 handler");
const snapshotCommitAt = f9.indexOf("DATAOPS_PROMO_SNAPSHOT_MODULE.commit");
const pendingRetryAt = f9.indexOf("state: 'pending'");
const resumeAt = f9.indexOf("executeInventoryMasterSalesResume");
assert.ok(snapshotCommitAt >= 0 && pendingRetryAt > snapshotCommitAt && resumeAt > pendingRetryAt, "F9 must finalize stock, persist retry identity, then resume sales");
assert.match(f9, /마감 재실행 없이/);

const dataOpsApp = manifest.applications.find(app => app.id === "dataops");
assert.ok(dataOpsApp.productionWrites);
assert.ok(dataOpsApp.runtimeDependencies.includes("core-engine"));
assert.ok(dataOpsApp.sharedContracts.includes("stop-management"));
assert.ok(dataOpsApp.sharedContracts.includes("dataops-inventory-master-resume"));
const retryContract = manifest.sharedDataContracts.find(contract => contract.id === "dataops-inventory-master-resume");
assert.deepEqual(retryContract.resources.localStorage, ["dataops_inventory_master_resume_v1"]);
const stopContract = manifest.sharedDataContracts.find(contract => contract.id === "stop-management");
assert.ok(stopContract.consumers.includes("DataOps.html"));
assert.match(stopContract.writerPolicy, /resume-only/);
assert.match(architecture, /dataops_inventory_master_resume_v1/);
assert.match(architecture, /separate recovery boundaries/);

console.log("PASS test-dataops-inventory-master-add");
