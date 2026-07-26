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

const browser = {};
const storageValues = new Map();
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
  localStorage: {
    getItem: (key) => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
  },
  navigator: {},
  indexedDB: {},
  crypto: { randomUUID: () => "test-uuid" },
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
});
vm.runInContext(inlineScripts[0], context, { filename: "MerchOps-head.js" });
const queuedStorageLock = browser.withMerchStorageLock;

const clone = (value) => value === undefined ? undefined : structuredClone(value);
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

console.log("MerchOps IndexedDB atomicity, save queue, stale rollback, and persisted history merge tests passed.");
