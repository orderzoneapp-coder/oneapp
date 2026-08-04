#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8").replace(/\r\n/g, "\n");
const smartSource = read("SmartParser.html");
const merchSource = read("MerchOps.html");
const coreSource = read("coreEngine.js");
const manifest = JSON.parse(read("app-manifest.json"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sliceBetween = (source, startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} block not found`);
  return source.slice(start, end);
};

const parseInlineScripts = (html, label) => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(scripts.length > 0, `${label} inline scripts not found`);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `${label}-inline-${index + 1}.js` }));
};

parseInlineScripts(smartSource, "SmartParser");
parseInlineScripts(merchSource, "MerchOps");

const storageValues = new Map();
const localStorage = {
  getItem(key) { return storageValues.has(String(key)) ? storageValues.get(String(key)) : null; },
  setItem(key, value) { storageValues.set(String(key), String(value)); },
  removeItem(key) { storageValues.delete(String(key)); },
};
const coreWindow = {
  localStorage,
  console,
  crypto: { randomUUID: () => `uuid-${storageValues.size + 1}` },
  setTimeout,
  clearTimeout,
};
coreWindow.window = coreWindow;
vm.runInNewContext(coreSource, {
  window: coreWindow,
  console,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  JSON,
  Set,
  Map,
  Promise,
  Error,
  safeParseJson: (raw, fallback) => {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  },
  DOMException,
  setTimeout,
  clearTimeout,
}, { filename: "coreEngine.js" });

const helperSource = sliceBetween(
  smartSource,
  "const PARSER_PRICE_HISTORY_FIELDS =",
  "const cleanupSmartParserStorage =",
  "SmartParser duplicate and stop helpers",
);
const smartContext = vm.createContext({
  window: {
    ...coreWindow,
    sanitizeMerchMarginRules: coreWindow.sanitizeMerchMarginRules,
    selectMerchMarginRule: coreWindow.selectMerchMarginRule,
    calculateMerchPriceBundle: coreWindow.calculateMerchPriceBundle,
  },
  localStorage,
  console,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  JSON,
  Set,
  Map,
  Error,
  safeParseJson: (raw, fallback) => {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  },
  parseNum: coreWindow.parseNum,
  calcDiffRate: () => null,
  generateUUID: (() => { let id = 0; return () => `sp-${++id}`; })(),
  normalizeText: (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
  addTag: (oldTags, tag) => [...new Set([...String(oldTags || "").split(",").map((v) => v.trim()).filter(Boolean), tag])].join(", "),
  removeTag: (oldTags, tag) => String(oldTags || "").split(",").map((v) => v.trim()).filter((v) => v && v !== tag).join(", "),
});
vm.runInContext(`${helperSource}\nglobalThis.helpers = {
  createSmartParserMasterCodeResolver,
  reconcileSmartParserDuplicateRows,
  getSmartParserDuplicateSummary,
  normalizeSmartParserStoppedProducts,
  mergeSmartParserStoppedProductsWithLegacy,
  hasSmartParserLegacyStoppedProducts,
  buildSmartParserApplyPlan,
  buildSmartParserStopManagementPlan
};`, smartContext);
const helpers = smartContext.helpers;

const master = {
  "20404230": { 코드: "20404230", 품목명: "회귀상품", 판매여부: 1 },
  B: { 코드: "B", 품목명: "다른상품", 판매여부: 1 },
};
const sameAppliedRows = [
  { _id: "supplier-1", _matchCode: "20404230", _matchStatus: "🟢 일치", _apply: true, 품목명: "공급사 상품 1", 규격: "1kg", 단위: "BOX", 가격: 1000 },
  { _id: "supplier-2", _matchCode: "20 404230", _matchStatus: "🟢 일치", _apply: true, 품목명: "공급사 상품 2", 규격: "2kg", 단위: "EA", 가격: 2000 },
];
const duplicated20404230 = helpers.reconcileSmartParserDuplicateRows(sameAppliedRows, master);
assert.equal(duplicated20404230.length, 2);
assert.ok(duplicated20404230.every((row) => row._duplicateType === "applied_code"));
assert.ok(duplicated20404230.every((row) => row._duplicateCode === "20404230"));
assert.ok(duplicated20404230.every((row) => row._duplicateCount === 2 && row._apply === false));
assert.deepEqual(clone(helpers.getSmartParserDuplicateSummary(duplicated20404230).groups), [{ code: "20404230", count: 2 }]);

const resolvedRows = helpers.reconcileSmartParserDuplicateRows([
  duplicated20404230[0],
  { ...duplicated20404230[1], _matchCode: "B" },
], master);
assert.equal(resolvedRows[0]._duplicateType, undefined);
assert.equal(resolvedRows[0]._apply, true);
assert.equal(resolvedRows[1]._duplicateType, undefined);
assert.equal(resolvedRows[1]._apply, true);

const ambiguousMaster = {
  first: { 코드: "20404230", 품목명: "마스터 후보 1" },
  second: { 코드: "20 404230", 품목명: "마스터 후보 2" },
};
const masterDuplicate = helpers.reconcileSmartParserDuplicateRows([
  { _id: "supplier-master", _matchCode: "20404230", _matchStatus: "🟢 일치", _apply: true },
], ambiguousMaster)[0];
assert.equal(masterDuplicate._duplicateType, "master_code");
assert.equal(masterDuplicate._duplicateMasterCandidates.length, 2);
assert.equal(masterDuplicate._apply, false);
assert.throws(() => helpers.createSmartParserMasterCodeResolver(ambiguousMaster).resolve("20404230"), /적용 대상 상품코드 중복/);

const existingCandidateDuplicate = helpers.reconcileSmartParserDuplicateRows([
  { _id: "multi", _matchCode: "", _matchStatus: "🟠 다중 마스터 후보", _duplicateType: "master_candidates", _duplicateCandidates: [{ code: "A" }, { code: "B" }], _apply: true },
], master)[0];
assert.equal(existingCandidateDuplicate._duplicateType, "master_candidates");
assert.equal(existingCandidateDuplicate._apply, false);

assert.throws(() => helpers.buildSmartParserApplyPlan({
  masterProducts: master,
  rows: sameAppliedRows,
  catalogLabel: "회귀 카탈로그",
}), /적용 대상 상품코드 중복: \[20404230\]/);

const legacyStopped = helpers.normalizeSmartParserStoppedProducts({
  " 20404230 ": { pendingAction: "pendingStop", status: "legacy", memo: "보존" },
  B: { pendingAction: "재개예정", reason: "보존 사유" },
});
assert.equal(legacyStopped["20404230"].pendingAction, "stop");
assert.equal(legacyStopped["20404230"].status, "pendingStop");
assert.equal(legacyStopped["20404230"].memo, "보존");
assert.equal(legacyStopped.B.pendingAction, "resume");
assert.equal(legacyStopped.B.status, "pendingResume");
assert.equal(legacyStopped.B.reason, "보존 사유");

storageValues.set("merchWorkArchive_v1", JSON.stringify([
  { status: "정지", createdAt: "2026-01-02T03:04:05.000Z", rows: [{ 코드: "LEGACY", 품목명: "기존 정지상품" }] },
]));
const stoppedWithLegacy = helpers.mergeSmartParserStoppedProductsWithLegacy({ B: { productCode: "B", status: "stopped" } });
assert.equal(stoppedWithLegacy.LEGACY.reason, "기존 정지 보관함 변환");
assert.equal(stoppedWithLegacy.B.productCode, "B");
assert.equal(helpers.hasSmartParserLegacyStoppedProducts(), true);
storageValues.delete("merchWorkArchive_v1");

const timestampISO = "2026-08-04T03:04:05.000Z";
const stopPlan = helpers.buildSmartParserStopManagementPlan({
  masterProducts: master,
  stoppedProducts: legacyStopped,
  pendingShopStatus: [{ code: "OLD", type: "stop" }],
  codes: ["20404230"],
  action: "stop",
  reason: "공급중단",
  memo: "SmartParser 직접 처리",
  timestampISO,
  timestampLabel: "2026. 8. 4. 12:04:05",
});
assert.equal(stopPlan.newMaster["20404230"].판매여부, 0);
assert.equal(stopPlan.nextStoppedProducts["20404230"].status, "stopped");
assert.equal(stopPlan.nextStoppedProducts["20404230"].pendingAction, "");
assert.equal(stopPlan.nextStoppedProducts["20404230"].reason, "공급중단");
assert.equal(stopPlan.nextPendingShopStatus.find((item) => item.code === "20404230").type, "stop");
assert.equal(stopPlan.logs[0].oldVal, 1);
assert.equal(stopPlan.logs[0].newVal, 0);
assert.equal(stopPlan.logs[0].timestampISO, timestampISO);
assert.match(stopPlan.logs[0].path, /^SmartParser/);
assert.match(stopPlan.logs[0].route, /품절정지관리/);

const resumePlan = helpers.buildSmartParserStopManagementPlan({
  masterProducts: stopPlan.newMaster,
  stoppedProducts: stopPlan.nextStoppedProducts,
  pendingShopStatus: stopPlan.nextPendingShopStatus,
  codes: ["20404230"],
  action: "resume",
  timestampISO: "2026-08-04T04:05:06.000Z",
  timestampLabel: "2026. 8. 4. 13:05:06",
});
assert.equal(resumePlan.newMaster["20404230"].판매여부, 1);
assert.equal(resumePlan.nextStoppedProducts["20404230"], undefined);
assert.equal(resumePlan.nextPendingShopStatus.find((item) => item.code === "20404230").type, "resume");
assert.equal(resumePlan.logs[0].oldVal, 0);
assert.equal(resumePlan.logs[0].newVal, 1);

const commitSource = sliceBetween(smartSource, "let smartParserMasterRevision = undefined", "const useParserApp =", "SmartParser atomic commit");
const rollbackValues = new Map([
  ["merchHistory_v870", JSON.stringify([{ id: "history-before" }])],
  ["merchStoppedProducts_v2", JSON.stringify({ OLD: { productCode: "OLD" } })],
  ["pendingShopStatus", JSON.stringify([{ code: "OLD" }])],
  ["merchMaster_sync_trigger", "master-before"],
  ["merchStopManager_sync_trigger", "stop-before"],
]);
let failStopTrigger = true;
const rollbackStorage = {
  getItem(key) { return rollbackValues.has(key) ? rollbackValues.get(key) : null; },
  setItem(key, value) {
    if (key === "merchStopManager_sync_trigger" && failStopTrigger) {
      failStopTrigger = false;
      throw new Error("forced stop trigger failure");
    }
    rollbackValues.set(key, String(value));
  },
  removeItem(key) { rollbackValues.delete(key); },
};
let committedMaster = clone(master);
let committedEntries = {
  merchStoppedProducts_v2: { OLD: { productCode: "OLD" } },
  pending_shop_status: [{ code: "OLD" }],
};
const beforeMaster = clone(committedMaster);
const beforeEntries = clone(committedEntries);
const rollbackWindow = {
  ONEAPP: { STORAGE: { async commitMasterStateOrThrow(data, options) {
    const previousMaster = clone(committedMaster);
    const previousEntries = clone(committedEntries);
    committedMaster = clone(data);
    committedEntries = { ...committedEntries, ...clone(options.extraStoreEntries || {}) };
    try {
      if (options.afterVerified) options.afterVerified();
    } catch (error) {
      committedMaster = previousMaster;
      committedEntries = previousEntries;
      throw error;
    }
    return { revision: "after" };
  } } },
};
const rollbackContext = vm.createContext({
  window: rollbackWindow,
  localStorage: rollbackStorage,
  console,
  Date,
  Array,
  Object,
  String,
  JSON,
  Math,
  Error,
  saveMerchHistoryWithRetry(logs) {
    rollbackStorage.setItem("merchHistory_v870", JSON.stringify(logs));
    return logs.length;
  },
});
vm.runInContext(`${commitSource}\nglobalThis.commitForTest = commitSmartParserMaster;`, rollbackContext);
await assert.rejects(rollbackContext.commitForTest(
  stopPlan.newMaster,
  {
    merchStoppedProducts_v2: stopPlan.nextStoppedProducts,
    pending_shop_status: stopPlan.nextPendingShopStatus,
  },
  stopPlan.logs,
  {
    merchStoppedProducts_v2: stopPlan.nextStoppedProducts,
    pendingShopStatus: stopPlan.nextPendingShopStatus,
    merchMaster_sync_trigger: timestampISO,
    merchStopManager_sync_trigger: timestampISO,
  },
), /forced stop trigger failure/);
assert.deepEqual(committedMaster, beforeMaster);
assert.deepEqual(committedEntries, beforeEntries);
assert.deepEqual(JSON.parse(rollbackStorage.getItem("merchHistory_v870")), [{ id: "history-before" }]);
assert.deepEqual(JSON.parse(rollbackStorage.getItem("merchStoppedProducts_v2")), { OLD: { productCode: "OLD" } });
assert.deepEqual(JSON.parse(rollbackStorage.getItem("pendingShopStatus")), [{ code: "OLD" }]);
assert.equal(rollbackStorage.getItem("merchMaster_sync_trigger"), "master-before");
assert.equal(rollbackStorage.getItem("merchStopManager_sync_trigger"), "stop-before");

const merchNormalizeSource = sliceBetween(merchSource, "const normalizeMerchStoppedProductsForRead =", "window.normalizeMerchStoppedProductsForRead", "MerchOps stopped read normalizer");
const merchContext = vm.createContext({ window: {}, Object, Array, String });
vm.runInContext(`${merchNormalizeSource}\nglobalThis.normalizeForRead = normalizeMerchStoppedProductsForRead;`, merchContext);
const merchLegacy = merchContext.normalizeForRead({ A: { pendingAction: "pendingResume", memo: "keep" } });
assert.equal(merchLegacy.A.pendingAction, "resume");
assert.equal(merchLegacy.A.status, "pendingResume");
assert.equal(merchLegacy.A.memo, "keep");

assert.match(smartSource, /activeTab === 'duplicate'/);
assert.match(smartSource, /중복 탭에서 재매칭 또는 공급사 제외/);
assert.match(smartSource, /actions\.handleConfirmMapping/);
assert.match(smartSource, /actions\.handleCreateNewMasterItem/);
assert.match(smartSource, /actions\.handleCancelMapping/);
assert.match(smartSource, /actions\.handleExcludeParsedItem/);
assert.match(smartSource, /SmartParserStopManager/);
assert.match(smartSource, /선택 판매재개/);
assert.match(smartSource, /전체 판매재개/);
assert.match(smartSource, /smartParserExcludeDict_v3012/);
assert.match(smartSource, /smartParserExcludeDict_backup_v3015/);

assert.doesNotMatch(merchSource, /onClick:\s*handleStopSales/);
assert.doesNotMatch(merchSource, /React\.createElement\(StoppedProductsManager/);
assert.doesNotMatch(merchSource, /pendingStopEntries/);
assert.doesNotMatch(merchSource, /정지관리 변경대기도 함께 마스터에 반영/);
assert.doesNotMatch(merchSource, /localStorage\.setItem\('merchStoppedProducts_v2'/);
assert.doesNotMatch(merchSource, /setIDB\('merchStoppedProducts_v2'/);
assert.doesNotMatch(merchSource, /removeItem\('merchWorkArchive_v1'/);
assert.match(merchSource, /normalizeMerchStoppedProductsForRead/);
assert.match(merchSource, /readMerchStoppedProductsForProtection/);
assert.match(merchSource, /공유 정지자료는 상태 뱃지와 보호 필터에만 사용/);
assert.match(merchSource, /품절\/정지 관리 및 판매재개는 SmartParser에서 직접 반영/);

const stopContract = manifest.sharedDataContracts.find((contract) => contract.id === "stop-management");
const exclusionContract = manifest.sharedDataContracts.find((contract) => contract.id === "parser-supplier-exclusions");
assert.equal(stopContract.owner, "smart-parser");
assert.deepEqual(stopContract.resources.indexedDb.keys, ["merchStoppedProducts_v2", "pending_shop_status"]);
assert.equal(exclusionContract.owner, "smart-parser");
assert.deepEqual(exclusionContract.resources.localStorage, ["smartParserExcludeDict_v3012", "smartParserExcludeDict_backup_v3015"]);

console.log("PASS test-smartparser-supplier-stop-20260804-01");
