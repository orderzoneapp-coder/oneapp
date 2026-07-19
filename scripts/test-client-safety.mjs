#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function loadCoreEngine() {
  const source = fs.readFileSync(path.join(ROOT, "coreEngine.js"), "utf8");
  const context = {
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
    localStorage: new MemoryStorage(),
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "coreEngine.js" });
  return context;
}

const browser = loadCoreEngine();
const master = browser.ONEAPP.MASTER;
const storage = browser.ONEAPP.STORAGE;

assert.equal(typeof master.analyzeMasterExcelUpload, "function");
assert.equal(typeof master.validateMasterExcelAnalysis, "function");
assert.equal(typeof master.applyMasterExcelUpload, "function");
assert.equal(browser.analyzeMasterExcelUpload, master.analyzeMasterExcelUpload);
assert.equal(browser.applyMasterExcelUpload, master.applyMasterExcelUpload);

const currentMaster = {
  A001: { 코드: "A001", 품목코드: "A001", 품목명: "기존상품", 규격: "EA", 출고가: 1000 },
};
const sourceHeaders = ["품목코드", "품목명", "규격", "출고가"];
const validAnalysis = master.analyzeMasterExcelUpload({
  currentMaster,
  sourceHeaders,
  excelRows: [
    { 품목코드: "A001", 품목명: "기존상품", 규격: "EA", 출고가: 1200 },
    { 품목코드: "A002", 품목명: "신규상품", 규격: "BOX", 출고가: 2400 },
  ],
});

assert.equal(validAnalysis.validation.ok, true);
assert.equal(validAnalysis.summary.updateCount, 1);
assert.equal(validAnalysis.summary.createCount, 1);

const duplicateAnalysis = master.analyzeMasterExcelUpload({
  currentMaster,
  sourceHeaders,
  excelRows: [
    { 품목코드: "A001", 품목명: "첫 번째" },
    { 품목코드: "A001", 품목명: "두 번째" },
  ],
});
assert.equal(duplicateAnalysis.validation.ok, false);
assert.match(duplicateAnalysis.validation.message, /중복 품목코드/);

const missingCodeAnalysis = master.analyzeMasterExcelUpload({
  currentMaster,
  sourceHeaders,
  excelRows: [
    { 품목코드: "", 품목명: "코드없음" },
    { 품목코드: "A003", 품목명: "정상상품" },
  ],
});
assert.equal(missingCodeAnalysis.validation.ok, false);
assert.match(missingCodeAnalysis.validation.message, /품목코드가 없는 행/);

storage.writeLocalJSON("client_safety_test", { ok: true }, { label: "테스트 저장" });
assert.deepEqual(JSON.parse(browser.localStorage.getItem("client_safety_test")), { ok: true });

browser.localStorage = {
  getItem: () => null,
  removeItem: () => {},
  setItem: () => {
    const error = new Error("storage full");
    error.name = "QuotaExceededError";
    throw error;
  },
};
assert.throws(
  () => storage.writeLocalValue("client_safety_test", "value", { label: "테스트 저장" }),
  /브라우저 저장공간이 부족합니다/,
);

const settings = fs.readFileSync(path.join(ROOT, "settings.html"), "utf8");
const inlineScripts = [...settings.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim() !== "");
assert.ok(inlineScripts.length > 0, "settings.html must contain an inline application script");
inlineScripts.forEach((script, index) => new vm.Script(script, { filename: `settings-inline-${index + 1}.js` }));
assert.match(settings, /MASTER_IMPORT_MAX_BYTES/);
assert.match(settings, /analyzeMasterExcelUpload/);
assert.match(settings, /applyMasterExcelUpload/);
assert.doesNotMatch(settings, /analyzePromotionThemeSettings/);
assert.doesNotMatch(settings, /applyPromotionThemeSettings/);

console.log("Client safety tests passed.");
