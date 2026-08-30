#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const boundarySource = fs.readFileSync("dataops/inventory-master-boundary.js", "utf8");
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.indexOf("</script>", scriptStart);
new vm.Script(source.slice(scriptStart + marker.length, scriptEnd), { filename: "DataOps.inline.js" });

let persisted = { version: 1, savedAt: "before", productData: [{ batchKey: "SAFE" }], substHistory: [] };
let failNextWrite = false;
const indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: () => true },
        transaction() {
          const transaction = {
            error: null,
            objectStore: () => ({
              put(value) {
                queueMicrotask(() => {
                  if (failNextWrite) {
                    failNextWrite = false;
                    transaction.error = new Error("WRITE_FAILED");
                    transaction.onerror?.();
                  } else {
                    persisted = structuredClone(value);
                    transaction.oncomplete?.();
                  }
                });
              },
              get() {
                const getRequest = {};
                queueMicrotask(() => {
                  getRequest.result = structuredClone(persisted);
                  getRequest.onsuccess?.();
                });
                return getRequest;
              },
              delete() {
                queueMicrotask(() => {
                  persisted = null;
                  transaction.oncomplete?.();
                });
              },
            }),
          };
          return transaction;
        },
        close() {},
      };
      request.onsuccess?.();
    });
    return request;
  },
};
const workStart = source.indexOf("let dataOpsWorkStateWriteQueue");
const workEnd = source.indexOf("// V1.a22.108", workStart);
assert.ok(workStart >= 0 && workEnd > workStart, "DataOps work-state recovery module must exist");
const workContext = vm.createContext({
  console,
  Date,
  Promise,
  Array,
  Object,
  indexedDB,
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
});
vm.runInContext(`${source.slice(workStart, workEnd)}\nglobalThis.workState = DATAOPS_WORK_STATE_MODULE;`, workContext);
await workContext.workState.save("autosave", { productData: [{ batchKey: "CURRENT" }], analysisPeriod: "2026-08", targetDateStr: "2026-08-30" });
assert.equal((await workContext.workState.load("autosave")).productData[0].batchKey, "CURRENT");
failNextWrite = true;
await assert.rejects(workContext.workState.save("autosave", { productData: [{ batchKey: "BROKEN" }] }), /WRITE_FAILED/);
assert.equal((await workContext.workState.load("autosave")).productData[0].batchKey, "CURRENT", "failed save must preserve the last verified work snapshot");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}
const retryStorage = new MemoryStorage();
const retryContext = vm.createContext({ console, Date, Math, JSON, Object, Array, Set, Map, String, Number, localStorage: retryStorage });
retryContext.globalThis = retryContext;
vm.runInContext(boundarySource, retryContext);
const retry = retryContext.DATAOPS_INVENTORY_MASTER_ADD_MODULE;
let records = retry.markRetry({}, { codes: ["A100", "A100"], closingRevision: "DATAOPS-REV-1", state: "pending" });
retry.writeRetryRecords(records, retryStorage);
records = retry.markRetry(retry.readRetryRecords(retryStorage), { codes: ["A100"], state: "failed", error: "network" });
assert.equal(records.A100.closingRevision, "DATAOPS-REV-1", "failure must retain the already-finalized closing identity");
assert.deepEqual(Array.from(retry.getRetryCodes(records)), ["A100"]);
assert.equal(Object.keys(retry.clearRetry(records, ["A100"])).length, 0);

const retryHandlerStart = source.indexOf("const handleRetryInventoryMasterSalesResume =");
const retryHandlerEnd = source.indexOf("const handleCombinedExport =", retryHandlerStart);
const retryHandler = source.slice(retryHandlerStart, retryHandlerEnd);
assert.match(retryHandler, /executeInventoryMasterSalesResume/);
assert.doesNotMatch(retryHandler, /DATAOPS_MERCH_STOCK_SYNC_MODULE\.commit/, "resume recovery must never repeat the finalized inventory closing");
assert.match(retryHandler, /마감 재실행 없이/);
assert.doesNotMatch(source, /removeItem\(['"]dataops_inventory_master_resume_v1/, "boot must not purge unresolved resume evidence");

console.log("PASS test-dataops-regression-recovery");
