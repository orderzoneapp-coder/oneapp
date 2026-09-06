#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSource = fs.readFileSync(path.join(ROOT, "coreEngine.js"), "utf8");
const moduleSource = fs.readFileSync(path.join(ROOT, "masterAddUpdate.js"), "utf8");
const masterHtml = fs.readFileSync(path.join(ROOT, "Master.html"), "utf8");
const sheetJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const expectedSheetJsSha256 = "c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99";

const response = await fetch(sheetJsUrl);
assert.equal(response.ok, true, `SheetJS download failed: ${response.status}`);
const sheetJsSource = Buffer.from(await response.arrayBuffer());
assert.equal(
  crypto.createHash("sha256").update(sheetJsSource).digest("hex"),
  expectedSheetJsSha256,
  "SheetJS asset hash changed",
);

const makeBrowserContext = () => {
  const context = vm.createContext({
    console,
    Date,
    Map,
    Set,
    Symbol,
    Number,
    Object,
    String,
    Array,
    Math,
    JSON,
    Promise,
    Uint8Array,
    ArrayBuffer,
  });
  context.window = context;
  context.self = context;
  context.globalThis = context;
  context.crypto = { randomUUID: () => crypto.randomUUID() };
  vm.runInContext(sheetJsSource.toString("utf8"), context, { filename: "xlsx.full.min.js" });
  vm.runInContext(coreSource, context, { filename: "coreEngine.js" });
  vm.runInContext(moduleSource, context, { filename: "masterAddUpdate.js" });
  assert.ok(context.XLSX?.utils, "SheetJS did not initialize");
  assert.ok(context.ONEAPP_MASTER_ADD_UPDATE?.parseWorkbook, "Master workbook parser did not initialize");
  return context;
};

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

const clone = value => structuredClone(value);
const createStorage = (initialMaster, localStorageRef) => {
  let state = { masterMap: clone(initialMaster), revision: "rev-1" };
  return {
    async readMasterSnapshotState() {
      return clone(state);
    },
    writeLocalJSON(key, value) {
      localStorageRef.setItem(key, JSON.stringify(value));
    },
    restoreLocalValue(key, raw) {
      if (raw === null) localStorageRef.removeItem(key);
      else localStorageRef.setItem(key, raw);
    },
    async commitMasterStateOrThrow(nextMaster, options) {
      assert.equal(options.expectedRevision, state.revision, "fixture revision must match");
      const previous = clone(state);
      state = { masterMap: clone(nextMaster), revision: "rev-2" };
      try {
        if (options.afterVerified) await options.afterVerified();
      } catch (error) {
        state = previous;
        const wrapped = new Error(error.message);
        wrapped.code = "MERCH_MASTER_COMMIT_FAILURE";
        wrapped.result = { revision: "rev-2", rollbackOk: true };
        throw wrapped;
      }
      return { ok: true, verified: true, revision: state.revision };
    },
  };
};

assert.match(
  masterHtml,
  /parseMasterAddUpdateWorkbook[\s\S]{0,500}api\.parseWorkbook\(arrayBuffer,\s*window\.XLSX\)/,
  "Master.html must use the tested production workbook parser",
);
assert.match(masterHtml, /ONEAPP_MASTER_ADD_UPDATE\.analyzeUploadRows/);
assert.match(masterHtml, /ONEAPP_MASTER_ADD_UPDATE\.commitApprovedChanges/);
assert.match(masterHtml, /formatReviewValue\(field\.uploadDisplay, field\.uploadPresent\)/);
assert.match(masterHtml, /원본 \{field\.sourceHeader\}/);

const context = makeBrowserContext();
const api = context.ONEAPP_MASTER_ADD_UPDATE;
const workbook = context.XLSX.utils.book_new();
const sheet = context.XLSX.utils.aoa_to_sheet([
  ["회사명 : 원앱"],
  ["품목코드", "품목명", "규격", "단위", "시중가"],
  ["001", "청사과", "1kg", "EA", 0],
  ["003", "감", "500g", "BOX", 3000],
  ["", "무코드 상품", "1kg", "EA", 1000],
  ["2026/09/06 오전 3:35:53"],
]);
context.XLSX.utils.book_append_sheet(workbook, sheet, "상품마스터");

const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-master-add-update-"));
const fixturePath = path.join(tempDir, "master-add-update-fixture.xlsx");
try {
  const fixtureBytes = context.XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  fs.writeFileSync(fixturePath, Buffer.from(new Uint8Array(fixtureBytes)));
  assert.ok(fs.statSync(fixturePath).size > 1000, "actual XLSX fixture is unexpectedly small");

  const parsed = api.parseWorkbook(fs.readFileSync(fixturePath), context.XLSX);
  assert.deepEqual(
    Array.from(parsed.headers),
    ["품목코드", "품목명", "규격", "단위", "시중가"],
    "Master parser did not preserve the actual workbook headers",
  );
  assert.equal(parsed.rows.length, 3, "the timestamp footer must be ignored while a product-shaped blank-code row remains");
  assert.equal(parsed.reportRows.length, 2, "top report information and footer timestamp evidence must be preserved");
  assert.equal(parsed.rows[0].시중가, 0, "numeric zero must survive actual XLSX reading");

  const baseMaster = {
    "001": { 코드: "001", 품목코드: "001", 품목명: "사과", 규격: "1kg", 단위: "EA", 시중가: 1000, 유지필드: "보존" },
    "002": { 코드: "002", 품목코드: "002", 품목명: "배", 규격: "2kg", 단위: "BOX", 시중가: 2000, 유지필드: "누락 유지" },
  };
  let analysis = api.analyzeUploadRows({
    ...parsed,
    currentMaster: baseMaster,
    revision: "rev-1",
    fileName: path.basename(fixturePath),
  });

  const existing = analysis.candidates.find(candidate => candidate.code === "001" && candidate.status === "changed");
  const added = analysis.candidates.find(candidate => candidate.code === "003" && candidate.status === "new");
  const blankCode = analysis.candidates.find(candidate => candidate.status === "blocked");
  assert.ok(existing && added, "actual workbook comparison did not produce changed and new candidates");
  assert.ok(blankCode?.blockingReasons.includes("blank_code"), "ordinary product-shaped blank-code rows must remain blocked");
  analysis = api.setFieldDecision(analysis, existing.id, "품목명", { approved: true });
  analysis = api.setFieldDecision(analysis, existing.id, "시중가", { approved: true });
  analysis = api.setFieldDecision(analysis, existing.id, "규격", { excluded: true });
  analysis = api.setAdminComplete(analysis, existing.id, true);
  analysis = api.setProductApproved(analysis, added.id, true);
  analysis = api.setAdminComplete(analysis, added.id, true);

  const localStorageRef = new MemoryLocalStorage();
  const storage = createStorage(baseMaster, localStorageRef);
  const result = await api.commitApprovedChanges({
    analysis,
    currentMaster: baseMaster,
    expectedRevision: "rev-1",
    storage,
    historyApi: {
      DEFAULT_LIMIT: api.HISTORY_DEFAULT_LIMIT,
      normalizeHistoryLog: log => ({ ...log }),
    },
    localStorageRef,
    actor: "fixture-admin",
  });
  assert.equal(result.revision, "rev-2");

  const refreshedContext = makeBrowserContext();
  const refreshedApi = refreshedContext.ONEAPP_MASTER_ADD_UPDATE;
  const refreshedState = await storage.readMasterSnapshotState();
  const refreshedHistory = JSON.parse(localStorageRef.getItem(refreshedApi.HISTORY_KEY));
  assert.equal(refreshedState.masterMap["001"].품목명, "청사과");
  assert.equal(refreshedState.masterMap["001"].규격, "1kg", "excluded field must retain the old master value");
  assert.equal(refreshedState.masterMap["001"].시중가, 0, "actual XLSX numeric zero must persist");
  assert.equal(refreshedState.masterMap["001"].유지필드, "보존");
  assert.equal(refreshedState.masterMap["002"].품목명, "배", "workbook-omitted product must remain");
  assert.equal(refreshedState.masterMap["003"].품목명, "감");
  assert.equal(refreshedState.masterMap["003"].규격, "500g");
  assert.equal(refreshedState.masterMap["003"].단위, "BOX");
  assert.ok(refreshedHistory.some(log => log.recordType === "master_add_update_job"));
  assert.ok(refreshedHistory.some(log => (
    log.recordType === "master_add_update_detail"
    && log.code === "003"
    && log.field === "단위"
    && log.finalValue === "BOX"
  )));
  assert.ok(refreshedHistory.every(log => log.executionId === result.executionId));
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedPrefix = path.resolve(ROOT, ".tmp-master-add-update-");
  assert.ok(
    resolvedTempDir.startsWith(allowedPrefix),
    `refusing to remove unexpected temp directory: ${resolvedTempDir}`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const actualErpPath = process.argv[2];
if (actualErpPath) {
  const actual = api.parseWorkbook(fs.readFileSync(actualErpPath), context.XLSX);
  assert.equal(actual.sourceHeaders.length, 44, "ERP workbook source header count changed");
  assert.equal(actual.rows.length, 4350, "ERP workbook parsed product count changed");
  const codes = actual.rows.map(row => api.getRowCode(row));
  assert.equal(codes.filter(Boolean).length, 4350, "every parsed ERP product must retain a product code");
  assert.equal(new Set(codes).size, 4350, "ERP workbook must not contain duplicate product codes");
  assert.equal(actual.reportRows.filter(row => row.kind === "output_timestamp").length, 1);

  const numericHeaders = new Set(Array.from(context.NUMERIC_HEADERS || []));
  const syntheticMaster = Object.fromEntries(actual.rows.map(row => {
    const code = api.getRowCode(row);
    const item = { 코드: code, 품목코드: code };
    Object.keys(row).filter(key => !key.startsWith("__")).forEach(key => {
      const value = row[key];
      if (value === "" || value === undefined || value === null) return;
      item[key] = numericHeaders.has(key) && typeof value === "number" ? String(value) : value;
    });
    return [code, item];
  }));
  const actualAnalysis = api.analyzeUploadRows({
    ...actual,
    currentMaster: syntheticMaster,
    revision: "erp-fixture",
    fileName: path.basename(actualErpPath),
  });
  assert.equal(actualAnalysis.summary.compareCount, 4350);
  assert.equal(actualAnalysis.summary.sameCount, 4350, "blank omission and numeric-string storage must not create false changes");
  assert.equal(actualAnalysis.summary.changedCount, 0);
  assert.equal(actualAnalysis.summary.blockingCount, 0);
  console.log(`ERP workbook verified: parsed=${actual.rows.length}, duplicates=${codes.length - new Set(codes).size}, timestampBlocked=0, falseChanges=${actualAnalysis.summary.changedCount}`);
}

console.log("Master screen path read a real XLSX fixture, applied approvals/exclusions, saved, refreshed, and verified master/history successfully.");
