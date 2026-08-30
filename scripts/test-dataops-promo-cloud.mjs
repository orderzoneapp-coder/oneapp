#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { TextEncoder } from "node:util";

const dataOpsSource = fs.readFileSync("DataOps.html", "utf8");
const merchSource = fs.readFileSync("MerchOps.html", "utf8");
const serverSource = fs.readFileSync("code.gs", "utf8");

const start = dataOpsSource.indexOf("const DATAOPS_MERCH_STOCK_SYNC_MODULE =");
const end = dataOpsSource.indexOf("const STORAGE_MODULE =", start);
assert.ok(start >= 0 && end > start, "current DataOps FULL Snapshot module must exist");
const context = vm.createContext({
  console,
  TextEncoder,
  safeNum: value => Number.isFinite(Number(value)) ? Number(value) : 0,
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  DATAOPS_VIEW_LAYER_MODULE: { buildCodeSummaryRows: rows => rows },
  FILTER_SORT_MODULE: { compareByCodeThenName: (left, right) => String(left.품목코드 || left.코드).localeCompare(String(right.품목코드 || right.코드)) },
  EXPORT_MODULE: {
    buildNextBaseStockRows: ({ productData }) => productData.map(row => ({
      단위: row.단위,
      품목코드: row.품목코드 || row.코드,
      품명: row.품명,
      규격: row.규격,
      재고: row.재고,
      기록: row.기록,
      거래: row.거래,
      구매가: row.구매가,
      기본: row.기본,
      적요: row.적요,
    })),
  },
  DATAOPS_CLOUD_MODULE: {
    normalizeUrl: value => String(value || "").trim(),
    getCloudUrl: () => "https://example.invalid/exec",
    readJsonResponse: response => response.json(),
  },
  fetch: async () => { throw new Error("unexpected fetch"); },
});
context.window = context;
context.window.crypto = crypto.webcrypto;
vm.runInContext(`${dataOpsSource.slice(start, end)}\nglobalThis.snapshotApi = DATAOPS_MERCH_STOCK_SYNC_MODULE;`, context);
const snapshotApi = context.snapshotApi;

const productData = [{
  단위: "EA", 품목코드: "100", 품명: "테스트", 규격: "", 재고: 0,
  기록: "", 거래: "거래처", 구매가: 2500, 기본: "", 적요: "",
}];
const snapshot = await snapshotApi.buildSnapshot({ productData, targetDateStr: "2026-08-04" });
const canonical = JSON.parse(snapshot.canonicalJson);
assert.deepEqual(Array.from(canonical.columns), ["단위", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요", "행사가"]);
assert.equal(canonical.rows[0][3], "", "blank must remain blank");
assert.equal(canonical.rows[0][4], 0, "numeric zero must remain numeric zero");
assert.equal(canonical.rows[0][10], "", "DataOps must not own promotion input");
assert.equal(snapshot.rowCount, 1);
assert.equal(snapshot.cellCount, 11);
assert.equal(snapshot.hash, crypto.createHash("sha256").update(snapshot.canonicalJson).digest("hex"));
const lotSnapshot = await snapshotApi.buildSnapshot({
  productData: [
    { ...productData[0], 기록: "2026-08-01", 거래: "공급사A", 재고: 1, 구매가: 1000 },
    { ...productData[0], 기록: "2026-08-02", 거래: "공급사B", 재고: 2, 구매가: 1200 },
  ],
  targetDateStr: "2026-08-04",
});
assert.equal(lotSnapshot.rowCount, 2, "FULL Snapshot must preserve same-code LOT rows instead of summarizing them");
assert.deepEqual(JSON.parse(lotSnapshot.canonicalJson).rows.map(row => row[6]), ["공급사A", "공급사B"]);

let requestBody;
context.fetch = async (_url, options) => {
  requestBody = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => ({
      status: "success",
      data: { revision: "R1", hash: snapshot.hash, rowCount: 1, cellCount: 11, basisDate: "2026-08-04" },
    }),
  };
};
const committed = await snapshotApi.commit({ productData, targetDateStr: "2026-08-04" });
assert.equal(committed.saved.revision, "R1");
assert.equal(requestBody.action, "dataops_snapshot_commit");
assert.equal(requestBody.snapshot.hash, snapshot.hash);
assert.equal(requestBody.snapshot.canonicalJson, snapshot.canonicalJson);
assert.equal(requestBody.snapshot.rowCount, snapshot.rowCount);
assert.equal(requestBody.snapshot.cellCount, snapshot.cellCount);
assert.doesNotMatch(JSON.stringify(requestBody), /token/i, "snapshot commit must remain tokenless");

context.fetch = async () => ({
  ok: true,
  json: async () => ({ status: "success", data: { revision: "R2", hash: "bad", rowCount: 1, cellCount: 11, basisDate: "2026-08-04" } }),
});
await assert.rejects(snapshotApi.commit({ productData, targetDateStr: "2026-08-04" }), /검산값이 일치하지 않습니다/);

assert.doesNotMatch(dataOpsSource, /oneapp_dataops_cloud_token_v1|DATAOPS_CLOUD_TOKEN_KEY|getAccessToken|ONEAPP_DATAOPS_ACCESS_TOKEN/);
assert.doesNotMatch(dataOpsSource, /localStorage\.setItem\(DATAOPS_CLOUD_URL_KEY/);
assert.doesNotMatch(dataOpsSource, /setCloudUrl:|resetCloudUrl:/);
const cloudUiStart = dataOpsSource.indexOf('React.createElement("label", { className: "text-xs font-bold text-emerald-800 mb-1" }');
const cloudUiEnd = dataOpsSource.indexOf("Object.entries({", cloudUiStart);
const cloudUi = dataOpsSource.slice(cloudUiStart, cloudUiEnd);
assert.match(cloudUi, /readOnly: true/);
assert.match(cloudUi, /aria-readonly/);
assert.match(cloudUi, /Settings에서 공식 URL 관리/);
assert.doesNotMatch(cloudUi, /handleSaveCloudUrl|handleResetCloudUrl|onChange:/);

const localSaveStart = dataOpsSource.indexOf("const saveWorkState = useCallback");
const localSaveEnd = dataOpsSource.indexOf("const resetEngine =", localSaveStart);
assert.doesNotMatch(dataOpsSource.slice(localSaveStart, localSaveEnd), /DATAOPS_MERCH_STOCK_SYNC_MODULE\.commit/, "ordinary work save must stay local-only");
const f9Start = dataOpsSource.indexOf("const handleCombinedExport = useCallback");
const f9End = dataOpsSource.indexOf("const handlePrintOutput", f9Start);
const f9 = dataOpsSource.slice(f9Start, f9End);
assert.ok(f9.indexOf("a.click();") < f9.indexOf("DATAOPS_MERCH_STOCK_SYNC_MODULE.commit"), "F9 must download before cloud finalization");
assert.ok(f9.indexOf("DATAOPS_MERCH_STOCK_SYNC_MODULE.commit") < f9.indexOf("state: 'pending'"));
assert.ok(f9.indexOf("state: 'pending'") < f9.indexOf("executeInventoryMasterSalesResume"));
assert.match(f9, /Excel 다운로드는 완료되었지만 클라우드 저장에 실패했습니다/);

assert.match(serverSource, /dataops_snapshot_commit/);
assert.match(serverSource, /dataops_snapshot_get/);
assert.match(serverSource, /DataOpsSnapshot_A/);
assert.match(serverSource, /DataOpsSnapshot_B/);
assert.match(serverSource, /ONEAPP_DATAOPS_CURRENT_SLOT/);
assert.match(serverSource, /LockService\.getScriptLock\(\)/);
assert.match(serverSource, /DATAOPS_HASH_MISMATCH|DATAOPS_CANONICAL_MISMATCH/);
assert.match(merchSource, /body: JSON\.stringify\(\{ action: 'dataops_snapshot_get' \}\)/);

console.log("PASS test-dataops-promo-cloud");
