import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8").replace(/\r\n/g, "\n");
const coreSource = read("coreEngine.js");
const smartSource = read("SmartParser.html");
const settingsSource = read("settings.html");
const merchSource = read("MerchOps.html");
const dataOpsSource = read("DataOps.html");
const exportSource = read("export_center.html");

const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
const parseInlineScripts = (html, label) => {
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, `${label} inline scripts not found`);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `${label}-inline-${index + 1}.js` }));
};
const sliceBetween = (source, startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} block not found`);
  return source.slice(start, end);
};
const clone = (value) => JSON.parse(JSON.stringify(value));

for (const [label, source] of [
  ["SmartParser", smartSource],
  ["settings", settingsSource],
  ["MerchOps", merchSource],
  ["DataOps", dataOpsSource],
  ["export_center", exportSource],
]) parseInlineScripts(source, label);
new vm.Script(coreSource, { filename: "coreEngine.js" });

const storageValues = new Map();
const localStorage = {
  getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
  setItem(key, value) { storageValues.set(key, String(value)); },
  removeItem(key) { storageValues.delete(key); },
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
  DOMException,
  setTimeout,
  clearTimeout,
}, { filename: "coreEngine.js" });
const pricing = coreWindow.ONEAPP.PRICING;
const config = coreWindow.ONEAPP.CONFIG;

const legacySentinel = JSON.stringify({ Preserve: { marginRate: 17 } });
localStorage.setItem("parserListMarginRules_v1", legacySentinel);
assert.deepEqual(clone(config.normalizeParserCatalogWarehouseMap({ "  Cat A  ": " 01 ", Blank: "  ", " ": "99" })), {
  "Cat A": "01",
  Blank: "",
});
config.writeParserCatalogWarehouseMap({ " Cat A ": " 01 ", Blank: "" });
assert.equal(config.readParserCatalogWarehouseMap()["Cat A"], "01");
config.setParserCatalogWarehouse(" Cat B ", " 003 ");
assert.equal(config.readParserCatalogWarehouseMap()["Cat B"], "003");
assert.equal(localStorage.getItem("parserListMarginRules_v1"), legacySentinel, "legacy parser rules must remain byte-for-byte untouched");
const cloudConfigPayload = await coreWindow.ONEAPP.CLOUD.buildCloudConfigPayload();
assert.equal(JSON.parse(cloudConfigPayload.settingsKeys.parserCatalogWarehouseMap_v1)["Cat A"], "01");
await coreWindow.ONEAPP.CLOUD.restoreCloudData({
  status: "success",
  data: { settingsKeys: { parserCatalogWarehouseMap_v1: JSON.stringify({ Restored: "01" }) } },
});
assert.deepEqual(clone(config.readParserCatalogWarehouseMap()), { Restored: "01" });
config.writeParserCatalogWarehouseMap({ "Cat A": "01", "Cat B": "003", Blank: "" });

const rules = [
  { id: "exact-first", whCode: "01", unit: "BOX, 박스", rate: 10, type: "divide" },
  { id: "exact-duplicate", whCode: "01", unit: "BOX", rate: 30, type: "multiply" },
  { id: "partial-wh", whCode: "01", unit: "*", rate: 1, type: "multiply" },
  { id: "partial-unit", whCode: "*", unit: "EA", rate: 1, type: "multiply" },
  { id: "default-first", whCode: "*", unit: "*", rate: 20, type: "divide" },
  { id: "default-duplicate", whCode: "*", unit: "*", rate: 30, type: "divide" },
];
const sanitizedRules = pricing.sanitizeMerchMarginRules(rules);
assert.equal(sanitizedRules.filter((rule) => rule.whCode === "*" && rule.unit === "*").length, 1, "exactly one default must remain");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "01", _calcUnit: "box" }).ruleId, "exact-first", "saved-order first exact rule wins");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "", _calcUnit: "BOX" }).ruleId, "default-first");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "01", _calcUnit: "" }).ruleId, "default-first");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "01", _calcUnit: "EA" }).ruleId, "default-first", "warehouse-only wildcard rule never applies");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "02", _calcUnit: "EA" }).ruleId, "default-first", "partial wildcard rules never apply");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "01", _calcUnit: "BOX(10)" }).ruleId, "default-first", "unit matching must not use fuzzy includes");
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: "01", _calcUnit: "", 품목명: "BOX 상품", 규격: "BOX" }).ruleId, "default-first", "name/spec must not infer unit");
assert.equal(pricing.findDuplicateMerchMarginRuleConditions(rules).length >= 1, true);
assert.equal(pricing.sanitizeMerchMarginRules([]).filter((rule) => rule.whCode === "*" && rule.unit === "*")[0].rate, 20);

const bundle = pricing.calculatePriceBundle(10000, { 외주비: 2000, 노무비: 1000, "1종연산": 4, 경비: 50 }, {
  _calcWarehouse: "01",
  _calcUnit: "BOX",
}, rules);
assert.equal(bundle.출고가, 14400);
assert.equal(bundle.시중가, 14400);
assert.equal(bundle["1입고"], 3000);
assert.equal(bundle["1출고"], 3650);
assert.deepEqual(clone(bundle.pricingEvidence), {
  marginRuleId: "exact-first",
  marginRate: 10,
  calculationType: "divide",
  matchType: "exact",
  inputWarehouse: "01",
  inputUnit: "BOX",
});
assert.equal(pricing.calculatePricesEngine(10000, 0, { 외주비: 2000, 노무비: 1000 }, { _calcWarehouse: "01", _calcUnit: "BOX" }, rules, true), bundle.출고가);

const smartHelpers = sliceBetween(smartSource, "const PARSER_PRICE_HISTORY_FIELDS =", "const cleanupSmartParserStorage =", "SmartParser apply helpers");
const smartWindow = {
  ...coreWindow,
  ONEAPP: coreWindow.ONEAPP,
  sanitizeMerchMarginRules: coreWindow.sanitizeMerchMarginRules,
  selectMerchMarginRule: coreWindow.selectMerchMarginRule,
  calculateMerchPriceBundle: coreWindow.calculateMerchPriceBundle,
};
const smartContext = vm.createContext({
  window: smartWindow,
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
  parseNum: coreWindow.parseNum,
  calcDiffRate: (oldValue, newValue) => {
    const oldNum = coreWindow.parseNum(oldValue);
    const newNum = coreWindow.parseNum(newValue);
    return oldNum ? Math.round(((newNum - oldNum) / oldNum) * 1000) / 10 : null;
  },
  normalizeSharedProductCode: (value) => String(value ?? "").replace(/\s/g, "").trim(),
  generateUUID: (() => { let id = 0; return () => `smart-${++id}`; })(),
  normalizeText: (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
  addTag: (oldTags, newTag) => [...new Set([...String(oldTags || "").split(",").map((v) => v.trim()).filter(Boolean), newTag].filter(Boolean))].join(", "),
  removeTag: (oldTags, tag) => String(oldTags || "").split(",").map((v) => v.trim()).filter((v) => v && v !== tag).join(", "),
});
vm.runInContext(`${smartHelpers}\nglobalThis.smartHelpers = { buildSmartParserApplyPlan, buildSmartParserMissingTagPlan, calculateParserCatalogPrices };`, smartContext);
const smart = smartContext.smartHelpers;
const iso = "2026-08-02T01:02:03.456Z";
const existingMaster = {
  A: { 코드: "A", 품목명: "기존", 규격: "규격", 단위: "BOX", 창고: "99", 카탈로그: "Old", 입고가: 9000, 출고가: 12000, 시중가: 12000, "1입고": 3000, "1출고": 4000, "1종연산": 4, 경비: 50, 판매여부: 1 },
};
const zeroPlan = smart.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: true, 품목명: "기존", 단위: "BOX", finalData: { 입고가: 0 } }],
  catalogLabel: "Cat",
  catalogWarehouse: "01",
  marginRules: rules,
  stoppedProducts: {},
  pendingShopStatus: [],
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
for (const field of ["입고가", "출고가", "시중가", "1입고", "1출고", "판매여부"]) assert.equal(zeroPlan.newMaster.A[field], 0, `${field} must be zero`);
assert.equal(zeroPlan.newMaster.A.창고, "99", "master warehouse must remain unchanged");
assert.equal(zeroPlan.logs.some((log) => log.field === "창고"), false, "warehouse history is forbidden");
assert.equal(zeroPlan.nextStoppedProducts.A.reason, "입고가 0");
assert.equal(zeroPlan.nextStoppedProducts.A.source, "SmartParser");
assert.equal(zeroPlan.nextStoppedProducts.A.stoppedAt, iso);
assert.equal(zeroPlan.nextStoppedProducts.A.updatedAt, iso);
assert.equal(zeroPlan.nextStoppedProducts.A.status, "stopped");
assert.equal(zeroPlan.nextStoppedProducts.A.pendingAction, "");
assert.deepEqual(clone(zeroPlan.nextPendingShopStatus), [{ code: "A", type: "stop", name: "기존", source: "SmartParser", reason: "입고가 0", catalog: "Cat", updatedAt: iso }]);
assert.ok(zeroPlan.logs.every((log) => log.timestampISO === iso));

const duplicateZeroPlan = smart.buildSmartParserApplyPlan({
  masterProducts: zeroPlan.newMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: true, 품목명: "기존", 단위: "BOX", finalData: { 입고가: 0 } }],
  catalogLabel: "Cat",
  catalogWarehouse: "01",
  marginRules: rules,
  stoppedProducts: zeroPlan.nextStoppedProducts,
  pendingShopStatus: zeroPlan.nextPendingShopStatus,
  timestampISO: "2026-08-02T02:00:00.000Z",
  timestampLabel: "later",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.equal(duplicateZeroPlan.stoppedProductsChanged, false);
assert.equal(duplicateZeroPlan.pendingShopStatusChanged, false);
assert.equal(duplicateZeroPlan.logs.filter((log) => ["입고가", "정지관리", "pending_shop_status"].includes(log.field)).length, 0);
assert.equal(duplicateZeroPlan.nextPendingShopStatus.length, 1);

const newZeroPlan = smart.buildSmartParserApplyPlan({
  masterProducts: {},
  rows: [{ _matchCode: "N", _hasParsedInPrice: true, 품목명: "신규0", 단위: "EA", finalData: { 입고가: 0 } }],
  catalogLabel: "Cat",
  catalogWarehouse: "01",
  marginRules: rules,
  timestampISO: iso,
  timestampLabel: "now",
});
for (const field of ["입고가", "출고가", "시중가", "1입고", "1출고", "판매여부"]) assert.equal(newZeroPlan.newMaster.N[field], 0);

const reappearPlan = smart.buildSmartParserApplyPlan({
  masterProducts: { R: { 코드: "R", 품목명: "정지상품", 단위: "EA", 창고: "88", 카탈로그: "Cat", 입고가: 0, 출고가: 0, 판매여부: 0 } },
  rows: [{ _matchCode: "R", _hasParsedInPrice: true, 품목명: "BOX라고 써도 단위만 사용", 규격: "BOX", 단위: "EA", finalData: { 입고가: 1000 } }],
  catalogLabel: "Cat",
  catalogWarehouse: "01",
  marginRules: rules,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.equal(reappearPlan.newMaster.R.판매여부, 0, "normal price must not auto-resume sales");
assert.equal(reappearPlan.newMaster.R.창고, "88");
assert.equal(reappearPlan.priceRuleExactCount, 0, "EA must not be inferred as BOX from name/spec");
assert.equal(reappearPlan.priceRuleDefaultCount, 1);
assert.equal(reappearPlan.logs.find((log) => log.field === "출고가").matchType, "default");

const exactPlan = smart.buildSmartParserApplyPlan({
  masterProducts: { E: { 코드: "E", 품목명: "정확", 단위: "EA", 창고: "77", 카탈로그: "Cat", 입고가: 900, 출고가: 1200, 판매여부: 1 } },
  rows: [{ _matchCode: "E", _hasParsedInPrice: true, 품목명: "정확", 단위: "EA", _editedTextFields: { 단위: "BOX" }, finalData: { 입고가: 1000 } }],
  catalogLabel: "Cat",
  catalogWarehouse: "01",
  marginRules: rules,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: true,
});
assert.equal(exactPlan.priceRuleExactCount, 1);
const exactPriceLog = exactPlan.logs.find((log) => log.field === "출고가");
assert.equal(exactPriceLog.unit, "BOX");
assert.equal(exactPriceLog.catalogWarehouse, "01");
assert.equal(exactPriceLog.marginRuleId, "exact-first");
assert.equal(exactPriceLog.marginRate, 10);
assert.equal(exactPriceLog.calculationType, "divide");
assert.equal(exactPriceLog.matchType, "exact");

const missingPlan = smart.buildSmartParserMissingTagPlan({
  masterProducts: { A: { ...existingMaster.A, 카탈로그: "Cat, Other", 판매여부: 0 } },
  codes: ["A"],
  catalogLabel: "Cat",
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(missingPlan.newMaster.A.카탈로그, "Other");
assert.equal(missingPlan.newMaster.A.판매여부, 0);
assert.equal(missingPlan.logs.length, 1);

const commitSource = sliceBetween(smartSource, "let smartParserMasterRevision = undefined", "const useParserApp =", "SmartParser atomic commit");
const rollbackValues = new Map([
  ["merchHistory_v870", JSON.stringify([{ id: "before" }])],
  ["pendingShopStatus", JSON.stringify([{ code: "OLD" }])],
  ["merchMaster_sync_trigger", "before-trigger"],
]);
let failPendingWrite = true;
const rollbackLocalStorage = {
  getItem(key) { return rollbackValues.has(key) ? rollbackValues.get(key) : null; },
  setItem(key, value) {
    if (key === "pendingShopStatus" && failPendingWrite) { failPendingWrite = false; throw new Error("forced pending mirror failure"); }
    rollbackValues.set(key, String(value));
  },
  removeItem(key) { rollbackValues.delete(key); },
};
let committedMaster = { A: { 코드: "A", 입고가: 10 } };
let committedEntries = { pending_shop_status: [{ code: "OLD" }] };
const rollbackWindow = {
  ONEAPP: { STORAGE: { async commitMasterStateOrThrow(data, options) {
    const beforeMaster = clone(committedMaster);
    const beforeEntries = clone(committedEntries);
    committedMaster = clone(data);
    committedEntries = { ...committedEntries, ...clone(options.extraStoreEntries || {}) };
    try { if (options.afterVerified) options.afterVerified(); }
    catch (error) { committedMaster = beforeMaster; committedEntries = beforeEntries; throw error; }
    return { revision: "new" };
  } } },
};
const rollbackContext = vm.createContext({
  window: rollbackWindow,
  localStorage: rollbackLocalStorage,
  console,
  Date,
  Array,
  Object,
  String,
  JSON,
  Math,
  Error,
  safeParseJson: (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
  saveMerchHistoryWithRetry: (logs) => {
    rollbackLocalStorage.setItem("merchHistory_v870", JSON.stringify(logs));
    return logs.length;
  },
});
vm.runInContext(`${commitSource}\nglobalThis.commitSmartParserMasterForTest = commitSmartParserMaster;`, rollbackContext);
await assert.rejects(rollbackContext.commitSmartParserMasterForTest(
  { A: { 코드: "A", 입고가: 0 } },
  { pending_shop_status: [{ code: "A", type: "stop" }] },
  [{ id: "after" }],
  { pendingShopStatus: [{ code: "A", type: "stop" }], merchMaster_sync_trigger: iso },
), /forced pending mirror failure/);
assert.deepEqual(committedMaster, { A: { 코드: "A", 입고가: 10 } });
assert.deepEqual(committedEntries, { pending_shop_status: [{ code: "OLD" }] });
assert.deepEqual(JSON.parse(rollbackLocalStorage.getItem("merchHistory_v870")), [{ id: "before" }]);
assert.deepEqual(JSON.parse(rollbackLocalStorage.getItem("pendingShopStatus")), [{ code: "OLD" }]);
assert.equal(rollbackLocalStorage.getItem("merchMaster_sync_trigger"), "before-trigger");

const merchAnalysisSource = sliceBetween(merchSource, "window.MERCH_PARSER_PRICE_HISTORY_FIELDS =", "const formatSignedNumber =", "MerchOps parser history analysis");
const merchWindow = {
  parseNum: coreWindow.parseNum,
  getMerchMasterSalePriceInfo: (master) => ({ value: master.출고가 ?? "", source: "출고가" }),
  getMasterSalesState: (master) => ({ text: String(master.판매여부 ?? "-") }),
};
const merchContext = vm.createContext({
  window: merchWindow,
  Object,
  Array,
  String,
  Number,
  JSON,
  Set,
  Map,
  isExactParserHistoryLog: (log) => log?.source === "parser",
  getHistoryLogCode: (log) => String(log?.code || ""),
  normalizeHistoryCatalog: (log) => String(log?.catalogName || log?.catalog || ""),
  getHistoryFieldName: (log) => String(log?.field || ""),
  getHistoryOldValue: (log) => log?.oldVal,
  getHistoryNewValue: (log) => log?.newVal,
  areMerchHistoryValuesEqual: (left, right) => String(left ?? "") === String(right ?? ""),
  parseHistoryTime: (log) => Date.parse(log?.timestampISO || "") || 0,
});
vm.runInContext(merchAnalysisSource, merchContext);
const samePositiveHistory = [{ id: "same", source: "parser", code: "R", catalogName: "Cat", field: "입고가", oldVal: 1000, newVal: 1000, timestampISO: iso }];
const stoppedAnalysis = merchWindow.buildMerchParserListHistoryAnalysis({
  historyLogs: samePositiveHistory,
  activeTags: [{ type: "catalog", name: "Cat" }],
  masterProducts: { R: { 코드: "R", 품목명: "정지", 입고가: 1000, 출고가: 1300, 판매여부: 0 } },
});
assert.equal(stoppedAnalysis.events.length, 1);
assert.equal(stoppedAnalysis.events[0].kind, "supply");
assert.equal(stoppedAnalysis.events[0].changeType, "new");
assert.equal(stoppedAnalysis.events[0].priceChangeType, "new_price");
assert.equal(merchWindow.normalizeMerchParserSupplyChangeType("reappeared"), "new");

for (const source of [coreSource, smartSource, settingsSource, merchSource]) {
  assert.doesNotMatch(source, /parserListMarginRules_v1|parserListMarginRules|PARSER_LIST_MARGIN_RULES_KEY/);
}
assert.match(coreSource, /PARSER_CATALOG_WAREHOUSE_MAP_KEY[\s\S]*settingsKeys/);
assert.match(settingsSource, /parserCatalogWarehouseMap_v1/);
assert.match(settingsSource, /addEventListener\('storage'/);
assert.match(settingsSource, /addEventListener\('focus'/);
assert.match(smartSource, /addEventListener\('storage'/);
assert.match(smartSource, /addEventListener\('focus'/);
assert.match(smartSource, /창고 저장/);
assert.match(smartSource, /공란 허용 · 01 그대로 보존/);
assert.match(smartSource, /Object\.keys\(catalogWarehouseMap \|\| \{\}\)/);
assert.match(smartSource, /data-parser-review-scroll": "price"/);
assert.match(smartSource, /data-parser-review-scroll": "mapping"/);
assert.match(smartSource, /document\.body\.style\.overflow = 'hidden'/);
assert.match(smartSource, /fieldName === '단위'/);
assert.match(smartSource, /\['품목명', '규격', '단위'\]/);
assert.match(smartSource, /removeTag\(oldCatalogTags, catalog\)/);
assert.doesNotMatch(smartSource, /nextItem\['창고'\]\s*=/);
assert.match(merchSource, /v2\.1\.174_CoreWarehouseUnitPricing/);
assert.match(merchSource, /supply_new: '신규상품'/);
assert.match(merchSource, /"F7"/);
assert.match(merchSource, /"F8"/);
assert.match(merchSource, /"F9"/);
assert.match(merchSource, /cost_up/);
assert.match(merchSource, /cost_down/);
assert.match(merchSource, /cost_zero/);
assert.match(merchSource, /supply_stopped/);
assert.equal(localStorage.getItem("parserListMarginRules_v1"), legacySentinel);

console.log("PASS test-oneapp-parser-wh-20260802-01");
