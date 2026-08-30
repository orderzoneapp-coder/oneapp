#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const moduleStart = source.indexOf("let dataOpsWorkStateWriteQueue");
const moduleEnd = source.indexOf("const DATAOPS_XLSX_WORKER_MODULE", moduleStart);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "DataOps work-state module must exist");

const records = new Map();
let failNextWrite = false;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        close: () => {},
        transaction() {
          const transaction = {
            error: null,
            objectStore() {
              return {
                put(value, key) {
                  const nextValue = clone(value);
                  queueMicrotask(() => {
                    if (failNextWrite) {
                      failNextWrite = false;
                      transaction.error = new Error("forced write failure");
                      transaction.onerror?.();
                      return;
                    }
                    records.set(String(key), nextValue);
                    transaction.oncomplete?.();
                  });
                  return {};
                },
                get(key) {
                  const getRequest = {};
                  queueMicrotask(() => {
                    getRequest.result = clone(records.get(String(key)));
                    getRequest.onsuccess?.();
                  });
                  return getRequest;
                },
                delete(key) {
                  queueMicrotask(() => {
                    records.delete(String(key));
                    transaction.oncomplete?.();
                  });
                  return {};
                },
              };
            },
          };
          return transaction;
        },
      };
      request.onsuccess?.();
    });
    return request;
  },
};

const context = vm.createContext({
  console,
  Date,
  Promise,
  indexedDB,
  queueMicrotask,
  safeStr: (value, fallback = "") => {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    return String(value).trim();
  },
});
context.window = context;
context.globalThis = context;
new vm.Script(
  `${source.slice(moduleStart, moduleEnd)}\nglobalThis.workState = DATAOPS_WORK_STATE_MODULE;`,
  { filename: "DataOps.work-state.js" },
).runInContext(context);

const workState = context.workState;
const baseScreenState = {
  viewMode: "CODE_SUMMARY",
  filters: {
    search: "배추",
    category: ["10"],
    stockListType: "PURCHASE_BALANCE",
    unit: { BOX: false, EA: true, SPLIT: false },
    sortMode: "PRICE",
    sortDesc: true,
  },
  searchInputVal: "배추",
  analysisMeta: { fileLabel: "매입:구매.xlsx", analyzedAt: "2026-08-30 12:15", status: "done" },
  sourceFileNames: { prev: "", in: "구매.xlsx", out: "", end: "실사.xlsx" },
  activeIssueMode: "stockLot",
  activeMultiCode: "1010",
  selectedBatchKey: "ROW-1",
  scrollTop: 640,
};
const manualPayload = {
  productData: [{ batchKey: "ROW-1", 코드: "1010", 품명: "직접저장" }],
  substHistory: [{ id: "manual-history" }],
  ackMultiCodes: ["1010"],
  analysisPeriod: "2026-08-28 ~ 2026-08-29",
  targetDateStr: "2026-08-29",
  screenState: baseScreenState,
};
const autosavePayload = {
  ...manualPayload,
  productData: [{ batchKey: "ROW-2", 코드: "2020", 품명: "자동저장" }],
  substHistory: [{ id: "autosave-history" }],
  ackMultiCodes: ["2020"],
  screenState: { ...baseScreenState, selectedBatchKey: "ROW-2", scrollTop: 900 },
};

await workState.save("manual", manualPayload);
const manualBeforeAutosave = clone(await workState.load("manual"));
await workState.save("autosave", autosavePayload);
const manualAfterAutosave = clone(await workState.load("manual"));
const autosave = clone(await workState.load("autosave"));

assert.deepEqual(manualAfterAutosave.productData, manualBeforeAutosave.productData, "autosave must not overwrite manual snapshot");
assert.deepEqual(manualAfterAutosave.ackMultiCodes, ["1010"]);
assert.deepEqual(manualAfterAutosave.screenState, baseScreenState, "manual screen state must round-trip");
assert.deepEqual(autosave.productData, autosavePayload.productData);
assert.deepEqual(autosave.ackMultiCodes, ["2020"]);
assert.equal(autosave.screenState.selectedBatchKey, "ROW-2");
assert.equal(autosave.screenState.scrollTop, 900);

failNextWrite = true;
await assert.rejects(() => workState.save("manual", { ...manualPayload, productData: [{ batchKey: "BROKEN" }] }));
assert.deepEqual(clone(await workState.load("manual")).productData, manualPayload.productData, "failed write must preserve previous manual snapshot");
await assert.rejects(() => workState.save("manual", { productData: [] }), /저장할 DataOps 작업이 없습니다/);

records.delete("autosave");
records.set("current", clone({ ...autosavePayload, savedAt: "2026-08-29T01:02:03.000Z" }));
const legacy = clone(await workState.load("autosave"));
assert.deepEqual(legacy.productData, autosavePayload.productData, "legacy current must remain an autosave fallback");
assert.equal(legacy.savedAt, "2026-08-29T01:02:03.000Z");
assert.ok(records.has("autosave"), "legacy current must migrate to the autosave key");

assert.match(source, /"직접 저장 복구"/);
assert.match(source, /"자동저장 복구"/);
assert.match(source, /setAckMultiCodes\(new Set\(Array\.isArray\(snapshot\.ackMultiCodes\)/);
assert.match(source, /onRestoreWorkScreenState\(snapshot\.screenState \|\| \{\}, snapshot\)/);
assert.match(source, /setFiles\(\{ prev: null, in: null, out: null, end: null \}\)/);
assert.doesNotMatch(source, /restoreWorkState\(\{ silent: true \}\)/, "saved work must not silently replace the current screen on load");

const screenAutosaveStart = source.indexOf("const scheduleWorkScreenAutosave = useCallback");
const screenAutosaveEnd = source.indexOf("const activeIssueModeRef", screenAutosaveStart);
assert.ok(screenAutosaveStart >= 0 && screenAutosaveEnd > screenAutosaveStart, "screen autosave debounce must exist");
const screenAutosaveSource = source.slice(screenAutosaveStart, screenAutosaveEnd);
assert.match(screenAutosaveSource, /clearTimeout\(workScreenAutosaveTimerRef\.current\)/);
assert.match(screenAutosaveSource, /setTimeout\(\(\) => \{[\s\S]*setWorkScreenRevision\(revision => revision \+ 1\)[\s\S]*\}, 200\)/);
assert.match(source, /screenRevision:\s*workScreenRevision/);
const focusHandlerStart = source.indexOf("const handleFocusInput = useCallback");
const focusHandlerEnd = source.indexOf("const handleRunAnalysis = useCallback", focusHandlerStart);
assert.ok(focusHandlerStart >= 0 && focusHandlerEnd > focusHandlerStart);
assert.match(source.slice(focusHandlerStart, focusHandlerEnd), /focusedInputRef\.current = \{ key: focusKey, idx \};\s*scheduleWorkScreenAutosave\(\)/, "pure row focus changes must refresh autosave");
const scrollHandlerStart = source.indexOf("const onScroll = () => {");
const scrollHandlerEnd = source.indexOf("container.addEventListener('wheel'", scrollHandlerStart);
assert.ok(scrollHandlerStart >= 0 && scrollHandlerEnd > scrollHandlerStart);
assert.match(source.slice(scrollHandlerStart, scrollHandlerEnd), /workScrollTopRef\.current = container\.scrollTop;\s*scheduleWorkScreenAutosave\(\)/, "scroll-end state must refresh autosave");

console.log("PASS test-dataops-work-recovery");
