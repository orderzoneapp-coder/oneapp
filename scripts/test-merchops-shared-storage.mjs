import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSource = fs.readFileSync(path.join(ROOT, "coreEngine.js"), "utf8");
const clone = (value) => value === undefined ? undefined : structuredClone(value);

const createMemoryIDB = (initial = {}) => {
  const state = {
    master: new Map((initial.items || []).map((item) => [item.코드, clone(item)])),
    store: new Map([
      ["merchMaster_v870", clone(initial.snapshot)],
      ["merchMaster_revision_v870", initial.revision],
    ]),
  };
  const stats = { masterClearCount: 0 };
  let transactionQueue = Promise.resolve();
  let nextPause = null;
  let failStorePutKey = null;

  const pauseNextCommit = () => {
    let markStarted;
    let release;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    nextPause = { markStarted, released };
    return { started, release };
  };

  const db = {
    objectStoreNames: { contains: (name) => ["master_products", "store"].includes(name) },
    transaction(storeNames, mode) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const operations = [];
      let aborted = false;
      let activeState = null;
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          aborted = true;
          tx.error = new DOMException("Transaction aborted", "AbortError");
        },
        objectStore(name) {
          assert.ok(names.includes(name), `unexpected store ${name}`);
          if (name === "master_products") {
            return {
              getAll() {
                const request = { result: undefined, error: null, onsuccess: null, onerror: null };
                operations.push(() => {
                  request.result = [...activeState.master.values()].map(clone);
                  request.onsuccess?.();
                });
                return request;
              },
              clear() {
                operations.push(() => {
                  stats.masterClearCount++;
                  activeState.master.clear();
                });
              },
              put(item) {
                const copied = clone(item);
                if (!copied?.코드) throw new DOMException("Missing key", "DataError");
                operations.push(() => activeState.master.set(copied.코드, clone(copied)));
              },
            };
          }
          return {
            get(key) {
              const request = { result: undefined, error: null, onsuccess: null, onerror: null };
              operations.push(() => {
                request.result = clone(activeState.store.get(key));
                request.onsuccess?.();
              });
              return request;
            },
            put(value, key) {
              if (key === failStorePutKey) throw new DOMException(`Forced put failure: ${key}`, "QuotaExceededError");
              const copied = clone(value);
              operations.push(() => activeState.store.set(key, clone(copied)));
            },
            delete(key) {
              operations.push(() => activeState.store.delete(key));
            },
          };
        },
      };

      const execute = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (aborted) {
          tx.onabort?.();
          return;
        }
        activeState = {
          master: new Map([...state.master].map(([key, value]) => [key, clone(value)])),
          store: new Map([...state.store].map(([key, value]) => [key, clone(value)])),
        };
        try {
          for (let index = 0; index < operations.length; index++) operations[index]();
          if (aborted) {
            tx.onabort?.();
            return;
          }
          if (nextPause && mode === "readwrite") {
            const pause = nextPause;
            nextPause = null;
            pause.markStarted();
            await pause.released;
          }
          if (mode === "readwrite") {
            state.master = activeState.master;
            state.store = activeState.store;
          }
          tx.oncomplete?.();
        } catch (error) {
          tx.error = error;
          tx.onerror?.();
        }
      };
      transactionQueue = transactionQueue.then(execute, execute);
      return tx;
    },
  };

  return {
    db,
    state,
    stats,
    pauseNextCommit,
    setFailStorePutKey(key) {
      failStorePutKey = key;
    },
    snapshot() {
      return {
        items: [...state.master.values()].map(clone),
        snapshot: clone(state.store.get("merchMaster_v870")),
        revision: state.store.get("merchMaster_revision_v870"),
      };
    },
  };
};

const createSharedLocalStorage = (values) => ({
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
});

const createCoreRuntime = (tabId, memoryIDB, navigatorValue = {}) => {
  let uuidSequence = 0;
  const context = vm.createContext({
    console,
    Date,
    Math,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    RegExp,
    JSON,
    Promise,
    Error,
    DOMException,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    localStorage: createSharedLocalStorage(new Map()),
    crypto: { randomUUID: () => `${tabId}-${++uuidSequence}` },
    navigator: navigatorValue,
    indexedDB: {},
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  context.window = context;
  vm.runInContext(coreSource, context, { filename: `coreEngine-${tabId}.js` });
  context.ONEAPP.STORAGE.initIDB = async () => memoryIDB.db;
  return context;
};

const initial = {
  items: [{ 코드: "OLD", 품목명: "기존" }],
  snapshot: { OLD: { 코드: "OLD", 품목명: "기존" } },
  revision: "rev-old",
};
const memoryIDB = createMemoryIDB(initial);
const runtime = createCoreRuntime("primary", memoryIDB);
const storage = runtime.ONEAPP.STORAGE;
const dataA = { A: { 코드: "A", 품목명: "A 저장" } };
const dataB = { B: { 코드: "B", 품목명: "B 최신 저장" } };

await assert.rejects(storage.bulkPutIDB("master_products", []), /commitMasterState/);
await assert.rejects(storage.replaceAllIDB("master_products", []), /commitMasterState/);
await assert.rejects(storage.setIDB("merchMaster_v870", {}), /commitMasterState/);
await assert.rejects(
  storage.commitMasterStateOrThrow(dataA),
  (error) => error?.code === "MERCH_MASTER_REVISION_REQUIRED",
  "the production writer must reject a full snapshot without a read revision",
);

const emptyBefore = memoryIDB.snapshot();
const emptyCommit = await storage.commitMasterState({});
assert.equal(emptyCommit.ok, false);
assert.match(emptyCommit.error, /빈 마스터 전체교체/);
assert.deepEqual(memoryIDB.snapshot(), emptyBefore);
const duplicateCommit = await storage.commitMasterState([
  { 코드: "DUP", 품목명: "first" },
  { 코드: "DUP", 품목명: "second" },
]);
assert.equal(duplicateCommit.ok, false);
assert.match(duplicateCommit.error, /중복 코드/);
assert.deepEqual(memoryIDB.snapshot(), emptyBefore);
const intentionalEmptyIDB = createMemoryIDB(initial);
const intentionalEmptyRuntime = createCoreRuntime("intentional-empty", intentionalEmptyIDB);
const intentionalEmpty = await intentionalEmptyRuntime.ONEAPP.STORAGE.commitMasterState({}, {
  allowEmpty: true,
});
assert.equal(intentionalEmpty.ok, true);
assert.deepEqual(intentionalEmptyIDB.snapshot().items, []);
assert.deepEqual(intentionalEmptyIDB.snapshot().snapshot, {});

const legacyIDB = createMemoryIDB({ items: [], snapshot: dataA, revision: undefined });
const legacyRuntime = createCoreRuntime("legacy-migration", legacyIDB);
const legacyMigration = await legacyRuntime.ONEAPP.STORAGE.commitMasterState(dataA, {
  expectedRevision: undefined,
});
assert.equal(legacyMigration.ok, true);
assert.deepEqual(legacyIDB.snapshot().items, Object.values(dataA));
assert.deepEqual(legacyIDB.snapshot().snapshot, dataA);
assert.ok(legacyIDB.snapshot().revision, "legacy databases without a revision must receive one atomically");

const linkedStoreIDB = createMemoryIDB(initial);
linkedStoreIDB.state.store.set("pending_shop_status", [{ code: "OLD" }]);
const linkedStoreRuntime = createCoreRuntime("linked-store", linkedStoreIDB);
const linkedStoreFailure = await linkedStoreRuntime.ONEAPP.STORAGE.commitMasterState(dataA, {
  extraStoreEntries: { pending_shop_status: [{ code: "A" }] },
  afterVerified: () => {
    throw new Error("forced linked history failure");
  },
});
assert.equal(linkedStoreFailure.ok, false);
assert.equal(linkedStoreFailure.rollbackOk, true);
assert.deepEqual(linkedStoreIDB.snapshot().snapshot, initial.snapshot);
assert.deepEqual(
  linkedStoreIDB.state.store.get("pending_shop_status"),
  [{ code: "OLD" }],
  "linked SmartParser state must roll back with the master in the same CAS boundary",
);

const missingLeaseIDB = createMemoryIDB(initial);
const missingLeaseRuntime = createCoreRuntime("missing-lease", missingLeaseIDB);
const missingLease = await missingLeaseRuntime.ONEAPP.STORAGE.mutateFallbackLock("release-check", "owner", "acquire");
assert.equal(missingLease.owner, "owner");
assert.ok(missingLease.token > 0);
const leaseKey = [...missingLeaseIDB.state.store.keys()].find((key) => String(key).startsWith("merch_fallback_lock_v1:release-check"));
missingLeaseIDB.state.store.delete(leaseKey);
assert.equal(
  await missingLeaseRuntime.ONEAPP.STORAGE.mutateFallbackLock("release-check", missingLease, "release"),
  false,
  "a missing lease record must be treated as ownership loss",
);

const fencedMissingIDB = createMemoryIDB(initial);
const fencedMissingRuntime = createCoreRuntime("fenced-missing", fencedMissingIDB);
const fencedMissingNewerRuntime = createCoreRuntime("fenced-missing-newer", fencedMissingIDB);
const fencedMissingStorage = fencedMissingRuntime.ONEAPP.STORAGE;
const replaceWithMissingFence = fencedMissingStorage.replaceMasterState.bind(fencedMissingStorage);
let missingLeaseNewerPromise;
fencedMissingStorage.replaceMasterState = async (state, extraEntries, lease) => {
  fencedMissingIDB.state.store.delete(lease.lockKey);
  missingLeaseNewerPromise = fencedMissingNewerRuntime.ONEAPP.STORAGE.commitMasterState(dataB);
  const newer = await missingLeaseNewerPromise;
  assert.equal(newer.ok, true);
  return replaceWithMissingFence(state, extraEntries, lease);
};
const fencedMissingResult = await fencedMissingStorage.commitMasterState(dataA);
const missingLeaseNewerResult = await missingLeaseNewerPromise;
assert.equal(fencedMissingResult.ok, false);
assert.equal(fencedMissingResult.lockFailure, true);
assert.equal(missingLeaseNewerResult.ok, true);
assert.equal(
  [fencedMissingResult, missingLeaseNewerResult].filter(result => result.ok).length,
  1,
);
assert.equal(fencedMissingIDB.stats.masterClearCount, 1, "the fenced stale writer must not enter master clear/put");
assert.deepEqual(
  fencedMissingIDB.snapshot().snapshot,
  dataB,
  "a writer whose lease record disappeared must be fenced without overwriting the newer commit",
);

const expiredFenceIDB = createMemoryIDB(initial);
const expiredWriterA = createCoreRuntime("expired-a", expiredFenceIDB);
const expiredWriterB = createCoreRuntime("expired-b", expiredFenceIDB);
const originalExpiredReplace = expiredWriterA.ONEAPP.STORAGE.replaceMasterState.bind(expiredWriterA.ONEAPP.STORAGE);
let newerCommitPromise;
expiredWriterA.ONEAPP.STORAGE.replaceMasterState = async (state, extraEntries, lease) => {
  const staleLease = expiredFenceIDB.state.store.get(lease.lockKey);
  expiredFenceIDB.state.store.set(lease.lockKey, { ...staleLease, expiresAt: Date.now() - 1 });
  newerCommitPromise = expiredWriterB.ONEAPP.STORAGE.commitMasterState(dataB);
  const newerResult = await newerCommitPromise;
  assert.equal(newerResult.ok, true);
  return originalExpiredReplace(state, extraEntries, lease);
};
const expiredWriterResult = await expiredWriterA.ONEAPP.STORAGE.commitMasterState(dataA);
const expiredNewerResult = await newerCommitPromise;
assert.equal(expiredWriterResult.ok, false);
assert.equal(expiredWriterResult.lockFailure, true);
assert.equal(expiredNewerResult.ok, true);
assert.equal(
  [expiredWriterResult, expiredNewerResult].filter(result => result.ok).length,
  1,
  "lease expiry competition must produce exactly one successful master writer",
);
assert.equal(expiredFenceIDB.stats.masterClearCount, 1, "only the new fencing token may enter master clear/put");
assert.deepEqual(
  expiredFenceIDB.snapshot().snapshot,
  dataB,
  "only the newer fenced writer may commit after the previous lease expires",
);

const renewFailureIDB = createMemoryIDB(initial);
const renewFailureRuntime = createCoreRuntime("renew-failure", renewFailureIDB);
const renewFailureStorage = renewFailureRuntime.ONEAPP.STORAGE;
const originalRenewMutation = renewFailureStorage.mutateFallbackLock.bind(renewFailureStorage);
renewFailureStorage.mutateFallbackLock = async (lockName, lease, action, leaseMs) => {
  if (action === "renew") return false;
  return originalRenewMutation(lockName, lease, action, leaseMs);
};
const originalRenewReplace = renewFailureStorage.replaceMasterState.bind(renewFailureStorage);
renewFailureStorage.replaceMasterState = async (...args) => {
  await new Promise((resolve) => setTimeout(resolve, 15));
  return originalRenewReplace(...args);
};
const renewFailureResult = await renewFailureStorage.commitMasterState(dataA, {
  lockOptions: { heartbeatMs: 4 },
});
const renewFailureNewerRuntime = createCoreRuntime("renew-failure-newer", renewFailureIDB);
const renewFailureNewerResult = await renewFailureNewerRuntime.ONEAPP.STORAGE.commitMasterState(dataB);
assert.equal(renewFailureResult.ok, false);
assert.equal(renewFailureResult.lockFailure, true);
assert.equal(renewFailureNewerResult.ok, true);
assert.equal(
  [renewFailureResult, renewFailureNewerResult].filter(result => result.ok).length,
  1,
);
assert.equal(renewFailureIDB.stats.masterClearCount, 1, "heartbeat ownership loss must fence the stale master transaction");
assert.deepEqual(renewFailureIDB.snapshot().snapshot, dataB);

const firstCommit = await storage.commitMasterState(dataA, { expectedRevision: "rev-old" });
assert.equal(firstCommit.ok, true);
assert.equal(memoryIDB.snapshot().revision, firstCommit.revision);
assert.deepEqual(memoryIDB.snapshot().snapshot, dataA);
await assert.rejects(
  storage.commitMasterStateOrThrow(dataB, { expectedRevision: "rev-old" }),
  (error) => error?.code === "MERCH_MASTER_REVISION_CONFLICT",
  "a stale full snapshot must not delete a newer successful save",
);
assert.deepEqual(memoryIDB.snapshot().snapshot, dataA);

const previousState = {
  items: initial.items,
  snapshot: initial.snapshot,
  revision: initial.revision,
  extraStoreEntries: {},
};
const expectedA = {
  items: Object.values(dataA),
  snapshot: dataA,
  revision: firstCommit.revision,
  extraStoreEntries: {},
};

const pause = memoryIDB.pauseNextCommit();
const rollbackA = storage.rollbackMasterStateCAS(expectedA, previousState);
await pause.started;
const queuedB = storage.commitMasterState(dataB);
pause.release();
const [rollbackResult, resultB] = await Promise.all([rollbackA, queuedB]);
assert.equal(rollbackResult.restored, true, "A may restore only before B enters the serialized transaction");
assert.equal(resultB.ok, true);
assert.deepEqual(memoryIDB.snapshot().snapshot, dataB, "B must remain after being queued after A's rollback decision");

const stateBeforeStaleRollback = await storage.readMasterState();
const staleRollback = await storage.rollbackMasterStateCAS(expectedA, previousState);
assert.equal(staleRollback.stale, true);
assert.deepEqual((await storage.readMasterState()).snapshot, stateBeforeStaleRollback.snapshot);

const mixedIDB = createMemoryIDB(initial);
const webLockTab = createCoreRuntime("web-lock-tab", mixedIDB, {
  locks: { request: async (_name, _options, callback) => callback() },
});
const fallbackTab = createCoreRuntime("fallback-tab", mixedIDB);
let activeWriters = 0;
let maximumWriters = 0;
const lockedTask = (runtimeValue, delay) => runtimeValue.ONEAPP.STORAGE.withStorageLock("mixed-lock", async () => {
  activeWriters++;
  maximumWriters = Math.max(maximumWriters, activeWriters);
  try {
    await new Promise((resolve) => setTimeout(resolve, delay));
  } finally {
    activeWriters--;
  }
});
await Promise.all([lockedTask(webLockTab, 15), lockedTask(fallbackTab, 2)]);
assert.equal(maximumWriters, 1, "Web Lock and fallback users must share the IndexedDB lease");

const failureIDB = createMemoryIDB(initial);
const failureRuntime = createCoreRuntime("failure-tab", failureIDB);
failureRuntime.ONEAPP.STORAGE.acquireFallbackLock = async () => {
  const error = new Error("forced lock timeout");
  error.code = "MERCH_FALLBACK_LOCK_TIMEOUT";
  throw error;
};
const lockFailure = await failureRuntime.ONEAPP.STORAGE.commitMasterState(dataA);
assert.equal(lockFailure.ok, false);
assert.equal(lockFailure.lockFailure, true);
assert.match(lockFailure.error, /forced lock timeout/);
assert.deepEqual(failureIDB.snapshot().snapshot, initial.snapshot);

const releaseWarningIDB = createMemoryIDB(initial);
const releaseWarningRuntime = createCoreRuntime("release-warning", releaseWarningIDB);
const acquireReleaseWarning = releaseWarningRuntime.ONEAPP.STORAGE.acquireFallbackLock.bind(releaseWarningRuntime.ONEAPP.STORAGE);
releaseWarningRuntime.ONEAPP.STORAGE.acquireFallbackLock = async (...args) => {
  const lease = await acquireReleaseWarning(...args);
  const release = lease.release;
  lease.release = async () => {
    await release();
    throw new Error("forced release ownership loss");
  };
  return lease;
};
const committedWithReleaseWarning = await releaseWarningRuntime.ONEAPP.STORAGE.commitMasterState(dataA);
assert.equal(committedWithReleaseWarning.ok, true);
assert.equal(committedWithReleaseWarning.verified, true);
assert.equal(committedWithReleaseWarning.lockReleaseWarning, true);
assert.match(committedWithReleaseWarning.warning, /forced release ownership loss/);
assert.deepEqual(
  releaseWarningIDB.snapshot().snapshot,
  dataA,
  "a verified commit must not become a false failure solely because release failed",
);

const supersededIDB = createMemoryIDB(initial);
const supersededRuntime = createCoreRuntime("release-superseded", supersededIDB);
const acquireSuperseded = supersededRuntime.ONEAPP.STORAGE.acquireFallbackLock.bind(supersededRuntime.ONEAPP.STORAGE);
supersededRuntime.ONEAPP.STORAGE.acquireFallbackLock = async (...args) => {
  const lease = await acquireSuperseded(...args);
  const release = lease.release;
  lease.release = async () => {
    await release();
    await supersededRuntime.ONEAPP.STORAGE.replaceMasterState({
      items: Object.values(dataB),
      snapshot: dataB,
      revision: "rev-B",
      extraStoreEntries: {},
    });
    throw new Error("forced release after newer writer");
  };
  return lease;
};
const supersededCommit = await supersededRuntime.ONEAPP.STORAGE.commitMasterState(dataA);
assert.equal(supersededCommit.ok, false);
assert.equal(supersededCommit.lockFailure, true);
assert.equal(supersededCommit.conflict, true);
assert.equal(supersededCommit.lockReleaseWarning, true);
assert.deepEqual(
  supersededIDB.snapshot().snapshot,
  dataB,
  "release recovery must not overwrite a newer successful revision",
);

const dataOpsIDB = createMemoryIDB(initial);
const dataOpsRuntime = createCoreRuntime("dataops-linked", dataOpsIDB);
dataOpsRuntime.ONEAPP.CLOUD.fetchJson = async () => ({ data: { master: dataA, summary: {} } });
const dataOpsResult = await dataOpsRuntime.ONEAPP.CLOUD.pullMerchMasterForDataOps({
  url: "https://example.invalid/exec",
});
assert.equal(dataOpsResult.status, "success");
assert.equal(
  JSON.stringify(dataOpsIDB.snapshot().snapshot),
  JSON.stringify(dataOpsResult.master),
);
assert.equal(
  JSON.stringify(dataOpsIDB.state.store.get("dataops_merch_master_cache_v1")),
  JSON.stringify(dataOpsResult.master),
);
assert.ok(dataOpsIDB.state.store.get("dataops_raw_subdivision_cache_v1"));

const dataOpsFailureIDB = createMemoryIDB(initial);
const dataOpsFailureRuntime = createCoreRuntime("dataops-failure", dataOpsFailureIDB);
dataOpsFailureRuntime.ONEAPP.CLOUD.fetchJson = async () => ({ data: { master: dataA, summary: {} } });
dataOpsFailureIDB.setFailStorePutKey("dataops_raw_subdivision_cache_v1");
await assert.rejects(
  dataOpsFailureRuntime.ONEAPP.CLOUD.pullMerchMasterForDataOps({
    url: "https://example.invalid/exec",
  }),
);
assert.deepEqual(
  dataOpsFailureIDB.snapshot().snapshot,
  initial.snapshot,
  "a required DataOps cache failure must abort the master and linked cache transaction",
);
assert.equal(dataOpsFailureIDB.state.store.has("dataops_merch_master_cache_v1"), false);

const restoreFailureIDB = createMemoryIDB(initial);
const restoreFailureRuntime = createCoreRuntime("restore-failure", restoreFailureIDB);
restoreFailureIDB.setFailStorePutKey("pending_shop_status");
let restoreHookCalls = 0;
await assert.rejects(
  restoreFailureRuntime.ONEAPP.CLOUD.restoreCloudData(
    {
      status: "success",
      data: { master: dataA, pendingShopStatus: [{ code: "A" }] },
    },
    { setMasterProducts: () => { restoreHookCalls++; } },
  ),
);
assert.equal(restoreHookCalls, 0, "restore UI hooks must not run before the atomic commit succeeds");
assert.deepEqual(restoreFailureIDB.snapshot().snapshot, initial.snapshot);
assert.equal(restoreFailureIDB.state.store.has("pending_shop_status"), false);

const restoreSuccessIDB = createMemoryIDB(initial);
const restoreSuccessRuntime = createCoreRuntime("restore-success", restoreSuccessIDB);
let restoreSuccessHookCalls = 0;
await restoreSuccessRuntime.ONEAPP.CLOUD.restoreCloudData(
  {
    status: "success",
    data: { master: dataA, pendingShopStatus: [{ code: "A" }] },
  },
  { setMasterProducts: () => { restoreSuccessHookCalls++; } },
);
assert.equal(restoreSuccessHookCalls, 1);
assert.deepEqual(restoreSuccessIDB.snapshot().snapshot, dataA);
assert.deepEqual(
  restoreSuccessIDB.state.store.get("pending_shop_status"),
  [{ code: "A" }],
);

const excelRollbackIDB = createMemoryIDB(initial);
const excelRollbackRuntime = createCoreRuntime("excel-rollback", excelRollbackIDB);
const excelStorage = excelRollbackRuntime.ONEAPP.STORAGE;
const excelAnalysis = {
  sourceColumns: ["품목코드", "품목명"],
  summary: {
    totalRows: 1,
    noCodeCount: 0,
    duplicateCodeCount: 0,
    updateCount: 0,
    createCount: 1,
  },
  candidates: [{
    code: "A",
    status: "create",
    item: { 코드: "A", 품목코드: "A", 품목명: "A 저장" },
    sourceColumns: ["품목코드", "품목명"],
    changes: [],
  }],
};
const originalExcelWriteLocalValue = excelStorage.writeLocalValue.bind(excelStorage);
excelStorage.writeLocalValue = (key, ...args) => {
  if (key === "merchMaster_sync_trigger") throw new Error("forced sync trigger failure");
  return originalExcelWriteLocalValue(key, ...args);
};
const originalExcelCommitOrThrow = excelStorage.commitMasterStateOrThrow.bind(excelStorage);
let excelCommitCalls = 0;
excelStorage.commitMasterStateOrThrow = async (...args) => {
  const result = await originalExcelCommitOrThrow(...args);
  excelCommitCalls++;
  if (excelCommitCalls === 1) {
    const newer = await excelStorage.commitMasterState(dataB);
    assert.equal(newer.ok, true);
  }
  return result;
};
await assert.rejects(
  excelRollbackRuntime.ONEAPP.MASTER.applyMasterExcelUpload({
    analysis: excelAnalysis,
    currentMaster: initial.snapshot,
  }),
);
assert.deepEqual(
  excelRollbackIDB.snapshot().snapshot,
  dataB,
  "Excel follow-up failure must not restore backup over a newer B revision",
);

const files = Object.fromEntries(
  [
    "MerchOps.html",
    "SmartParser.html",
    "settings.html",
    "export_center.html",
    "Master.html",
    "Item_manager.html",
    "Item_manager.js",
    "DataOps.html",
    "coreEngine.js",
    "masterAddUpdate.js",
    "app-manifest.json",
    "APP_ARCHITECTURE.md",
  ]
    .map((name) => [name, fs.readFileSync(path.join(ROOT, name), "utf8")]),
);
const dataOpsPersistStart = files["DataOps.html"].indexOf("const persistDataOpsMasterCache =");
const dataOpsPersistEnd = files["DataOps.html"].indexOf("const DATAOPS_MASTER_ITEM_HELPER", dataOpsPersistStart);
assert.ok(dataOpsPersistStart >= 0 && dataOpsPersistEnd > dataOpsPersistStart);
const dataOpsCacheValues = new Map();
const dataOpsCacheStorage = {
  setItem(key, value) {
    if (key === "dataops_raw_subdivision_cache_v1") throw new Error("forced derived cache failure");
    dataOpsCacheValues.set(key, String(value));
  },
};
const dataOpsPersistContext = vm.createContext({ JSON, Date });
vm.runInContext(
  `const DATAOPS_MERCH_MASTER_CACHE_KEY = "dataops_merch_master_cache_v1";
const DATAOPS_MERCH_MASTER_SUMMARY_KEY = "dataops_merch_master_summary_v1";
const DATAOPS_RAW_SUBDIVISION_CACHE_KEY = "dataops_raw_subdivision_cache_v1";
${files["DataOps.html"].slice(dataOpsPersistStart, dataOpsPersistEnd)}
globalThis.__persistDataOpsMasterCache = persistDataOpsMasterCache;`,
  dataOpsPersistContext,
);
const activeDataOpsCacheResult = dataOpsPersistContext.__persistDataOpsMasterCache(
  dataA,
  { relations: [{ subCode: "S", rawCode: "A" }] },
  { total: 1 },
  dataOpsCacheStorage,
);
assert.equal(activeDataOpsCacheResult.ok, true);
assert.equal(activeDataOpsCacheResult.warnings.length, 1);
assert.deepEqual(
  JSON.parse(dataOpsCacheValues.get("dataops_merch_master_cache_v1")),
  dataA,
  "the active DataOps cache must retain its authoritative master when a derived mirror fails",
);
assert.ok(dataOpsCacheValues.has("dataops_master_sync_trigger"));

const smartParserHelperStart = files["SmartParser.html"].indexOf("let smartParserMasterRevision = undefined");
const smartParserHelperEnd = files["SmartParser.html"].indexOf("const useParserApp =", smartParserHelperStart);
assert.ok(smartParserHelperStart >= 0 && smartParserHelperEnd > smartParserHelperStart);
let smartParserCommitShouldFail = true;
let smartParserHistoryWrites = 0;
const smartParserStorageValues = new Map([
  ["merchHistory_v870", JSON.stringify([{ id: "before" }])],
]);
const smartParserLocalStorage = createSharedLocalStorage(smartParserStorageValues);
const smartParserWarnings = [];
const smartParserContext = vm.createContext({
  window: {
    ONEAPP: {
      STORAGE: {
        commitMasterStateOrThrow: async (_data, options) => {
          assert.ok(Object.prototype.hasOwnProperty.call(options, "expectedRevision"));
          if (smartParserCommitShouldFail) throw new Error("forced master failure");
          options.afterVerified?.();
          return { ok: true, revision: "rev-smart-success" };
        },
      },
    },
  },
  localStorage: smartParserLocalStorage,
  saveMerchHistoryWithRetry: (logs) => {
    smartParserHistoryWrites++;
    smartParserLocalStorage.setItem("merchHistory_v870", JSON.stringify(logs));
  },
  console: {
    log: console.log,
    error: console.error,
    warn: (...args) => smartParserWarnings.push(args),
  },
  Date,
  Array,
  String,
  Error,
});
smartParserContext.window.window = smartParserContext.window;
vm.runInContext(
  `${files["SmartParser.html"].slice(smartParserHelperStart, smartParserHelperEnd)}
window.__commitSmartParserMaster = commitSmartParserMaster;`,
  smartParserContext,
);
let smartParserMemoryUpdates = 0;
await assert.rejects(
  smartParserContext.window.__commitSmartParserMaster(
    dataA,
    {},
    [{ id: "success-only", code: "A" }],
    {},
    () => { smartParserMemoryUpdates++; },
  ),
  /forced master failure/,
);
assert.equal(smartParserMemoryUpdates, 0);
assert.deepEqual(
  JSON.parse(smartParserContext.localStorage.getItem("merchHistory_v870")),
  [{ id: "before" }],
  "SmartParser history must remain unchanged when the master commit fails",
);
assert.equal(smartParserHistoryWrites, 0);
assert.equal(smartParserContext.localStorage.getItem("merchMaster_sync_trigger"), null);

smartParserCommitShouldFail = false;
const originalSmartParserSetItem = smartParserLocalStorage.setItem;
smartParserLocalStorage.setItem = (key, value) => {
  if (key === "merchMaster_sync_trigger") throw new Error("forced trigger failure");
  return originalSmartParserSetItem(key, value);
};
await assert.rejects(
  smartParserContext.window.__commitSmartParserMaster(
    dataA,
    {},
    [{ id: "committed", code: "A" }],
    { merchMaster_sync_trigger: "now" },
    () => { smartParserMemoryUpdates++; },
  ),
  /forced trigger failure/,
);
assert.equal(smartParserWarnings.length, 0);
assert.equal(smartParserMemoryUpdates, 0);
assert.equal(smartParserHistoryWrites, 1);
assert.deepEqual(
  JSON.parse(smartParserContext.localStorage.getItem("merchHistory_v870")),
  [{ id: "before" }],
  "a notification failure inside the atomic commit must restore the previous history",
);

for (const name of [
  "MerchOps.html",
  "SmartParser.html",
  "settings.html",
  "export_center.html",
  "Master.html",
  "Item_manager.html",
]) {
  assert.match(files[name], /<script src="coreEngine\.js"><\/script>/, `${name} must load the shared storage engine`);
}
assert.match(files["SmartParser.html"], /afterVerified: \(\) => \{\s*saveMerchHistoryWithRetry\(logs\)/);
assert.match(files["SmartParser.html"], /await commitSmartParserMaster\(data, storeEntries, historyLogs/);
assert.match(files["settings.html"], /commitMasterStateOrThrow\(newMaster, \{\s*expectedRevision: settingsMasterRevision/);
assert.match(files["settings.html"], /commitMasterStateOrThrow\(nextMaster, \{\s*expectedRevision: masterState\.revision/);
assert.match(files["export_center.html"], /commitMasterStateOrThrow\(newMaster, \{\s*expectedRevision: exportMasterRevision/);
assert.match(files["SmartParser.html"], /commitMasterStateOrThrow\(data, \{\s*expectedRevision: smartParserMasterRevision/);
assert.match(
  files["settings.html"],
  /var activation = await activateMasterProduct\(rec\.code\);[\s\S]*?catch \(error\)[\s\S]*?완료 상태로 변경하지 않았습니다/,
);
assert.doesNotMatch(files["SmartParser.html"], /db\.transaction\(\['master_products', 'store'\], 'readwrite'\)/);
assert.doesNotMatch(files["settings.html"], /bulkPutIDB\('master_products'/);
assert.doesNotMatch(files["settings.html"], /setIDB\('merchMaster_v870'/);
assert.doesNotMatch(files["export_center.html"], /bulkPutIDB\('master_products'/);
assert.doesNotMatch(files["export_center.html"], /setIDB\('merchMaster_v870'/);
for (const name of ["Master.html"]) {
  const saveMasterLocal = files[name].match(/const saveMasterLocal = async[\s\S]*?\n        };/)?.[0] || "";
  assert.match(saveMasterLocal, /commitMasterStateOrThrow\(safeMap, \{\s*expectedRevision:/, `${name} must use the revision-checked shared writer`);
  assert.doesNotMatch(saveMasterLocal, /setIDB\(/, `${name} must not split the snapshot write`);
  assert.doesNotMatch(saveMasterLocal, /bulkPutMasterIDB\(/, `${name} must not split the row write`);
  assert.doesNotMatch(files[name], /bulkPutMasterIDB/, `${name} must not retain an alternate master writer`);
  assert.match(
    files[name],
    /\[STORAGE_KEYS\.MASTER_DB, 'merchMaster_revision_v870'\]\.includes\(key\)/,
    `${name} must reject direct snapshot and revision writes`,
  );
}
assert.match(
  files["Item_manager.js"],
  /function commitMaster\(masterMap(?:, options)?\)[\s\S]*?commitMasterStateOrThrow\(masterMap, (?:Object\.assign\()?\{\s*expectedRevision: state\.revision/,
  "Item manager must use the revision-checked shared writer",
);
assert.doesNotMatch(files["Item_manager.js"], /setIDB\(|bulkPutMasterIDB|bulkPutIDB\(/);
assert.match(
  files["Item_manager.js"],
  /async function performSave[\s\S]*?catch \(error\)[\s\S]*?저장하지 못했습니다/,
  "Item manager must absorb writer rejection and avoid a false success UI",
);
assert.doesNotMatch(files["coreEngine.js"], /bulkPutIDB\(STORE_MASTER/);
assert.doesNotMatch(files["coreEngine.js"], /replaceAllIDB\(STORE_MASTER/);
assert.match(files["coreEngine.js"], /CLOUD\.pullMerchMasterForDataOps[\s\S]*commitMasterStateOrThrow\(normalizedMaster, \{/);
assert.match(files["coreEngine.js"], /commitMasterStateOrThrow\(normalizedMaster, \{\s*expectedRevision: currentState\.revision/);
assert.match(files["coreEngine.js"], /\[DATAOPS_MASTER_CACHE_KEY\]: normalizedMaster/);
assert.match(files["coreEngine.js"], /\[DATAOPS_RAW_SUBDIVISION_KEY\]: rawSubdivision/);
assert.match(files["coreEngine.js"], /pending_shop_status: data\.pendingShopStatus/);
assert.match(files["coreEngine.js"], /MASTER\.restoreMasterBackup[\s\S]*commitMasterStateOrThrow\(backup\.data \|\| \{\}, \{\s*expectedRevision: currentState\.revision/);
assert.match(files["coreEngine.js"], /totalCount: Object\.keys\(masterMap\)\.length/);
assert.match(files["coreEngine.js"], /revision: committedRevision/);
assert.doesNotMatch(files["coreEngine.js"], /totalCount: items\.length/);
assert.match(
  files["coreEngine.js"],
  /commitMasterStateOrThrow\(backup\.data \|\| \{\}, \{\s*expectedRevision: committedRevision/,
);
assert.match(files["MerchOps.html"], /catch \(error\) \{\s*result = \{\s*ok: false,[\s\S]*lockFailure: true/);
assert.match(
  files["MerchOps.html"],
  /const migration = await window\.commitMerchMasterState\(state\.snapshot, \{\s*expectedRevision: state\.revision/,
);
for (const [name, source] of [["Master.html", files["Master.html"]], ["Item_manager.js", files["Item_manager.js"]]]) {
  assert.doesNotMatch(source, /ROW-\$\{idx\}/);
  assert.match(source, /상품코드가 중복되어 있습니다|마스터 중복 코드가 있습니다/);
  assert.match(source, /Object\.keys\(legacy\)\.length/);
}
assert.match(files["Master.html"], /ONEAPP_MASTER_ADD_UPDATE\.analyzeUploadRows/);
assert.match(files["Master.html"], /ONEAPP_MASTER_ADD_UPDATE\.commitApprovedChanges/);
assert.doesNotMatch(files["Master.html"], /saveMasterLocal\(newMaster\)/);
assert.match(files["masterAddUpdate.js"], /commitMasterStateOrThrow\(plan\.nextMaster/);
assert.match(files["masterAddUpdate.js"], /afterVerifiedError: 'Master 추가·갱신 master\/history 검증 실패'/);
assert.match(files["app-manifest.json"], /"F7": "Apply current work to the MerchOps master/);
assert.match(files["app-manifest.json"], /"F8": "Create the Excel output from current work without changing the master/);
assert.match(files["app-manifest.json"], /"id": "master-lookup"[\s\S]*?"path": "Master\.html"[\s\S]*?"status": "pilot"[\s\S]*?"productionWrites": true/);
assert.match(files["app-manifest.json"], /"id": "item-manager"[\s\S]*?"path": "Item_manager\.html"[\s\S]*?"status": "pilot"[\s\S]*?"productionWrites": true/);
const plannedManifestSection = files["app-manifest.json"].slice(files["app-manifest.json"].indexOf('"plannedApplications"'));
assert.doesNotMatch(plannedManifestSection, /"id": "(master-lookup|item-manager)"/);
assert.match(files["APP_ARCHITECTURE.md"], /#### MerchOps[\s\S]*F7 applies reviewed work[\s\S]*F8 creates the Excel output/);
assert.match(files["DataOps.html"], /persistDataOpsMasterCache[\s\S]*storage\.setItem\(DATAOPS_MERCH_MASTER_CACHE_KEY/);
assert.match(files["DataOps.html"], /const rawSubdivision = DATAOPS_CLOUD_MODULE\.buildRawSubdivisionFromMaster\(master\)/);
assert.match(files["DataOps.html"], /derived cache mirror update failed after atomic master cache save/);

console.log("Shared writer, fencing, invalid-input, linked-store, CAS rollback, SmartParser history, and F7/F8 tests passed.");
