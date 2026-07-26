import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim() !== "");

const createSharedLocalStorage = (values) => ({
  get length() {
    return values.size;
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
  removeItem(key) {
    values.delete(key);
  },
});

const createBrowserRuntime = (tabId, storageValues = new Map(), navigatorValue = {}) => {
  const browser = {};
  const context = vm.createContext({
    window: browser,
    document: {
      getElementById: () => null,
      createElement: () => ({
        style: {},
        appendChild() {},
        append() {},
        remove() {},
        addEventListener() {},
        querySelector: () => ({}),
        focus() {},
      }),
      body: { appendChild() {} },
    },
    localStorage: createSharedLocalStorage(storageValues),
    navigator: navigatorValue,
    indexedDB: {},
    crypto: { randomUUID: () => tabId },
    console,
    Date,
    Map,
    Set,
    Number,
    Object,
    String,
    Array,
    Math,
    Promise,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(inlineScripts[0], context, { filename: `MerchOps-head-${tabId}.js` });
  return { browser, context, storageValues };
};

const storageValues = new Map();
const primaryRuntime = createBrowserRuntime("test-primary-tab", storageValues, {
  locks: {
    request: async (_name, _options, callback) => callback(),
  },
});
const { browser, context } = primaryRuntime;
const queuedStorageLock = browser.withMerchStorageLock;

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const createSerializedLockIDB = () => {
  const state = new Map();
  let writeQueue = Promise.resolve();
  return {
    state,
    db: {
      transaction(storeName, mode) {
        assert.equal(storeName, "store");
        assert.equal(mode, "readwrite");
        const pendingGets = [];
        let staged = null;
        const tx = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(name) {
            assert.equal(name, "store");
            return {
              get(key) {
                const request = { result: undefined, error: null, onsuccess: null, onerror: null };
                pendingGets.push({ key, request });
                return request;
              },
              put(value, key) {
                assert.ok(staged, "lock transaction must be active before put");
                staged.set(key, clone(value));
              },
              delete(key) {
                assert.ok(staged, "lock transaction must be active before delete");
                staged.delete(key);
              },
            };
          },
        };
        const execute = () => new Promise((resolve) => {
          setTimeout(() => {
            try {
              staged = new Map([...state].map(([key, value]) => [key, clone(value)]));
              pendingGets.forEach(({ key, request }) => {
                request.result = clone(staged.get(key));
                request.onsuccess?.();
              });
              state.clear();
              staged.forEach((value, key) => state.set(key, clone(value)));
              tx.oncomplete?.();
            } catch (error) {
              tx.error = error;
              tx.onerror?.();
            } finally {
              resolve();
            }
          }, 0);
        });
        writeQueue = writeQueue.then(execute, execute);
        return tx;
      },
    },
  };
};

const createFakeIDB = (initial) => {
  const state = {
    master: new Map((initial.items || []).map((item) => [item.코드, clone(item)])),
    store: new Map([
      ["merchMaster_v870", clone(initial.snapshot)],
      ["merchMaster_revision_v870", initial.revision],
    ]),
  };

  return {
    state,
    db: {
      transaction(storeNames, mode) {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const stagedMaster = new Map([...state.master].map(([key, value]) => [key, clone(value)]));
        const stagedStore = new Map([...state.store].map(([key, value]) => [key, clone(value)]));
        let aborted = false;
        const tx = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort() {
            aborted = true;
            tx.error = new Error("AbortError");
          },
          objectStore(name) {
            assert.ok(names.includes(name), `unexpected store ${name}`);
            if (name === "master_products") {
              return {
                clear() {
                  stagedMaster.clear();
                },
                put(item) {
                  const copied = clone(item);
                  if (!copied?.코드) throw new Error("DataError");
                  stagedMaster.set(copied.코드, copied);
                },
                getAll() {
                  return { result: [...stagedMaster.values()].map(clone) };
                },
              };
            }
            return {
              put(value, key) {
                stagedStore.set(key, clone(value));
              },
              delete(key) {
                stagedStore.delete(key);
              },
              get(key) {
                return { result: clone(stagedStore.get(key)) };
              },
            };
          },
        };
        setTimeout(() => {
          if (aborted) {
            tx.onabort?.();
            return;
          }
          if (mode === "readwrite") {
            state.master = stagedMaster;
            state.store = stagedStore;
          }
          tx.oncomplete?.();
        }, 0);
        return tx;
      },
    },
  };
};

const initial = {
  items: [{ 코드: "OLD", 품목명: "기존" }],
  snapshot: { OLD: { 코드: "OLD", 품목명: "기존" } },
  revision: "rev-old",
};
const fake = createFakeIDB(initial);
browser.initIDB = async () => fake.db;
let revisionSequence = 0;
browser.createMerchMasterRevision = () => `rev-${++revisionSequence}`;

await assert.rejects(
  browser.replaceMasterIDBState({
    items: [{ 코드: "BROKEN", invalid: () => true }],
    snapshot: { BROKEN: { 코드: "BROKEN" } },
    revision: "rev-broken",
  }),
);
assert.deepEqual(
  JSON.parse(JSON.stringify(await browser.readMasterIDBState())),
  initial,
  "a synchronous clone failure must abort the clear/put transaction without changing the database",
);

let activeLocks = 0;
let maximumActiveLocks = 0;
await Promise.all(Array.from({ length: 12 }, (_, index) =>
  browser.withMerchStorageLock("queue-test", async () => {
    activeLocks++;
    maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks);
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    activeLocks--;
  })
));
assert.equal(maximumActiveLocks, 1, "same-tab storage requests must run one at a time");

let dataA;
let dataB;
for (let attempt = 0; attempt < 12; attempt++) {
  const baseRevision = (await browser.readMasterIDBState()).revision;
  dataA = { [`A-${attempt}`]: { 코드: `A-${attempt}`, 품목명: "실패 요청" } };
  dataB = { [`B-${attempt}`]: { 코드: `B-${attempt}`, 품목명: "성공 요청" } };
  const failedA = browser.commitMerchMasterState(dataA, {
    expectedRevision: baseRevision,
    afterVerified: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("forced history failure");
    },
  });
  const successfulB = browser.commitMerchMasterState(dataB, { expectedRevision: baseRevision });
  const [resultA, resultB] = await Promise.all([failedA, successfulB]);
  assert.equal(resultA.ok, false);
  assert.equal(resultA.rollbackOk, true);
  assert.equal(resultB.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify((await browser.readMasterIDBState()).snapshot)),
    dataB,
    `queued successful save ${attempt + 1} must remain after the earlier request rolls back`,
  );
}

await browser.replaceMasterIDBState({
  items: initial.items,
  snapshot: initial.snapshot,
  revision: initial.revision,
});
browser.__MERCHOPS_STORAGE_QUEUES = {};
browser.withMerchStorageLock = (_name, task) => task();
const staleA = browser.commitMerchMasterState(dataA, {
  afterVerified: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error("late failure");
  },
});
await new Promise((resolve) => setTimeout(resolve, 5));
const newerB = browser.commitMerchMasterState(dataB);
const [staleResult, newerResult] = await Promise.all([staleA, newerB]);
assert.equal(newerResult.ok, true);
assert.equal(staleResult.ok, false);
assert.equal(staleResult.staleRollbackSkipped, true);
assert.deepEqual(
  JSON.parse(JSON.stringify((await browser.readMasterIDBState()).snapshot)),
  dataB,
  "a stale rollback must never overwrite a newer revision",
);
const beforeConflict = await browser.readMasterIDBState();
const conflictResult = await browser.commitMerchMasterState(dataA, { expectedRevision: "outdated-revision" });
assert.equal(conflictResult.ok, false);
assert.equal(conflictResult.conflict, true);
assert.deepEqual(
  JSON.parse(JSON.stringify(await browser.readMasterIDBState())),
  JSON.parse(JSON.stringify(beforeConflict)),
  "an outdated full snapshot must be rejected without touching the latest master",
);

const repeated = Array.from({ length: 1001 }, (_, index) => ({
  id: "same-id",
  code: "1001",
  timestamp: index,
}));
assert.equal(browser.mergeMerchHistoryLogs(repeated).length, 1, "duplicate history IDs must be removed before limits");

const uniqueAgri = Array.from({ length: 1001 }, (_, index) => ({
  id: `agri-${index}`,
  code: "1001",
  timestamp: index,
}));
assert.equal(browser.mergeMerchHistoryLogs(uniqueAgri).length, 1000, "agricultural history must enforce the unique 1,000-entry limit");

const mergedTabs = browser.mergeMerchHistoryLogs(
  [{ id: "tab-b", code: "2001" }],
  [{ id: "tab-a", code: "2001" }, { id: "tab-b", code: "2001" }],
);
assert.deepEqual(
  JSON.parse(JSON.stringify(mergedTabs.map((log) => log.id))),
  ["tab-b", "tab-a"],
  "cross-tab history merges must preserve both unique logs",
);

browser.withMerchStorageLock = queuedStorageLock;
storageValues.delete("merchHistory_v870");
const [persistedA, persistedB] = await Promise.all([
  browser.persistMerchHistoryLogs([{ id: "tab-a", code: "2001" }], []),
  browser.persistMerchHistoryLogs([{ id: "tab-b", code: "2001" }], []),
]);
assert.deepEqual(
  JSON.parse(storageValues.get("merchHistory_v870")).map((log) => log.id),
  ["tab-b", "tab-a"],
  "queued history writes must re-read and merge the latest persisted history",
);
assert.equal(persistedA.length, 1);
assert.equal(persistedB.length, 2);

const fallbackStorage = new Map();
const fallbackTabA = createBrowserRuntime("fallback-tab-a", fallbackStorage).browser;
const fallbackTabB = createBrowserRuntime("fallback-tab-b", fallbackStorage).browser;
const fallbackLockIDB = createSerializedLockIDB();
fallbackTabA.initIDB = async () => fallbackLockIDB.db;
fallbackTabB.initIDB = async () => fallbackLockIDB.db;
let activeFallbackWriters = 0;
let maximumFallbackWriters = 0;
for (let attempt = 0; attempt < 12; attempt++) {
  fallbackStorage.clear();
  const writeWithReadPause = (tab, id) => tab.withMerchStorageLock("oneapp-merch-history-save", async () => {
    activeFallbackWriters++;
    maximumFallbackWriters = Math.max(maximumFallbackWriters, activeFallbackWriters);
    try {
      const before = JSON.parse(fallbackStorage.get("merchHistory_v870") || "[]");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const merged = tab.mergeMerchHistoryLogs([{ id, code: "2001" }], before);
      fallbackStorage.set("merchHistory_v870", JSON.stringify(merged));
    } finally {
      activeFallbackWriters--;
    }
  });
  await Promise.all([
    writeWithReadPause(fallbackTabA, `fallback-a-${attempt}`),
    writeWithReadPause(fallbackTabB, `fallback-b-${attempt}`),
  ]);
  assert.deepEqual(
    JSON.parse(fallbackStorage.get("merchHistory_v870")).map((log) => log.id).sort(),
    [`fallback-a-${attempt}`, `fallback-b-${attempt}`],
    `fallback cross-tab save ${attempt + 1} must preserve both logs`,
  );
  assert.equal(
    [...fallbackLockIDB.state.keys()].filter((key) => key.startsWith("merch_fallback_lock_v1:")).length,
    0,
    "fallback lock entries must be released after each save",
  );
}
assert.equal(maximumFallbackWriters, 1, "Web Locks fallback must serialize independent tab writers");

const staleLockKey = "merch_fallback_lock_v1:stale-cleanup";
fallbackLockIDB.state.set(staleLockKey, { owner: "crashed-tab", expiresAt: Date.now() - 1 });
const releaseAfterStale = await fallbackTabA.acquireMerchFallbackStorageLock("stale-cleanup", {
  timeoutMs: 1000,
  pollMs: 4,
  leaseMs: 10000,
});
await releaseAfterStale();
assert.equal(
  fallbackLockIDB.state.has(staleLockKey),
  false,
  "expired fallback lock entries must not block the next writer",
);

fallbackStorage.clear();
await Promise.all([
  fallbackTabA.persistMerchHistoryLogs([{ id: "fallback-production-a", code: "2001" }], []),
  fallbackTabB.persistMerchHistoryLogs([{ id: "fallback-production-b", code: "2001" }], []),
]);
assert.deepEqual(
  JSON.parse(fallbackStorage.get("merchHistory_v870")).map((log) => log.id).sort(),
  ["fallback-production-a", "fallback-production-b"],
  "production history persistence must preserve both logs without Web Locks",
);

console.log("MerchOps IndexedDB atomicity, save queue, stale rollback, fallback tab lock, and persisted history merge tests passed.");
