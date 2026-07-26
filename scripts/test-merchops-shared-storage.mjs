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
  let transactionQueue = Promise.resolve();
  let nextPause = null;

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
                operations.push(() => activeState.master.clear());
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
    pauseNextCommit,
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
assert.equal(
  await missingLeaseRuntime.ONEAPP.STORAGE.mutateFallbackLock("release-check", "owner", "acquire"),
  true,
);
const leaseKey = [...missingLeaseIDB.state.store.keys()].find((key) => String(key).includes("release-check"));
missingLeaseIDB.state.store.delete(leaseKey);
assert.equal(
  await missingLeaseRuntime.ONEAPP.STORAGE.mutateFallbackLock("release-check", "owner", "release"),
  false,
  "a missing lease record must be treated as ownership loss",
);

const firstCommit = await storage.commitMasterState(dataA, { expectedRevision: "rev-old" });
assert.equal(firstCommit.ok, true);
assert.equal(memoryIDB.snapshot().revision, firstCommit.revision);
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
const fallbackTab = createCoreRuntime("fallback-tab", mixedIDB, {
  locks: { request: async () => { throw new Error("initial Web Locks failure"); } },
});
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
releaseWarningRuntime.ONEAPP.STORAGE.acquireFallbackLock = async () => async () => {
  throw new Error("forced release ownership loss");
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
supersededRuntime.ONEAPP.STORAGE.acquireFallbackLock = async () => async () => {
  await supersededRuntime.ONEAPP.STORAGE.replaceMasterState({
    items: Object.values(dataB),
    snapshot: dataB,
    revision: "rev-B",
    extraStoreEntries: {},
  });
  throw new Error("forced release after newer writer");
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

const files = Object.fromEntries(
  [
    "MerchOps.html",
    "SmartParser.html",
    "settings.html",
    "export_center.html",
    "Master.html",
    "Item_manager.html",
    "coreEngine.js",
    "app-manifest.json",
  ]
    .map((name) => [name, fs.readFileSync(path.join(ROOT, name), "utf8")]),
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
assert.match(files["SmartParser.html"], /commitMasterStateOrThrow\(data, \{ extraStoreEntries: storeEntries \}\)/);
assert.match(files["settings.html"], /commitMasterStateOrThrow\(newMaster\)/);
assert.match(files["export_center.html"], /commitMasterStateOrThrow\(newMaster\)/);
assert.match(
  files["settings.html"],
  /var activation = await activateMasterProduct\(rec\.code\);[\s\S]*?catch \(error\)[\s\S]*?완료 상태로 변경하지 않았습니다/,
);
assert.doesNotMatch(files["SmartParser.html"], /db\.transaction\(\['master_products', 'store'\], 'readwrite'\)/);
assert.doesNotMatch(files["settings.html"], /bulkPutIDB\('master_products'/);
assert.doesNotMatch(files["settings.html"], /setIDB\('merchMaster_v870'/);
assert.doesNotMatch(files["export_center.html"], /bulkPutIDB\('master_products'/);
assert.doesNotMatch(files["export_center.html"], /setIDB\('merchMaster_v870'/);
for (const name of ["Master.html", "Item_manager.html"]) {
  const saveMasterLocal = files[name].match(/const saveMasterLocal = async[\s\S]*?\n        };/)?.[0] || "";
  assert.match(saveMasterLocal, /commitMasterStateOrThrow\(safeMap\)/, `${name} must use the shared writer`);
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
  files["Item_manager.html"],
  /const handleMasterItemUpdate = async[\s\S]*?catch \(error\)[\s\S]*?마스터 저장 실패/,
  "Item manager must absorb writer rejection and avoid a false success UI",
);
assert.doesNotMatch(files["coreEngine.js"], /bulkPutIDB\(STORE_MASTER/);
assert.doesNotMatch(files["coreEngine.js"], /replaceAllIDB\(STORE_MASTER/);
assert.match(files["coreEngine.js"], /CLOUD\.pullMerchMasterForDataOps[\s\S]*commitMasterStateOrThrow\(normalizedMaster\)/);
assert.match(files["coreEngine.js"], /MASTER\.restoreMasterBackup[\s\S]*commitMasterStateOrThrow\(backup\.data \|\| \{\}\)/);
assert.match(files["coreEngine.js"], /totalCount: Object\.keys\(masterMap\)\.length/);
assert.doesNotMatch(files["coreEngine.js"], /totalCount: items\.length/);
assert.match(files["MerchOps.html"], /catch \(error\) \{\s*result = \{\s*ok: false,[\s\S]*lockFailure: true/);
assert.match(
  files["MerchOps.html"],
  /const migration = await window\.commitMerchMasterState\(state\.snapshot, \{\s*expectedRevision: state\.revision/,
);
assert.match(files["app-manifest.json"], /"F7": "Apply current work to the MerchOps master/);
assert.match(files["app-manifest.json"], /"F8": "Create the Excel output from current work without changing the master/);

console.log("Shared master writer, CAS rollback, mixed lock, failure contract, and F7/F8 manifest tests passed.");
