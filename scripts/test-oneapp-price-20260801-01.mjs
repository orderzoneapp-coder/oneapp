import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8").replace(/\r\n/g, "\n");
const smart = read("SmartParser.html");
const settings = read("settings.html");
const merch = read("MerchOps.html");
const historyViewer = read("history_viewer.html");

const parseInlineScripts = (html, label) => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim() !== "");
  assert.ok(scripts.length > 0, label + " inline scripts were not found");
  scripts.forEach((script, index) => new vm.Script(script, { filename: label + "-inline-" + (index + 1) + ".js" }));
};

const sliceBetween = (source, startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, label + " block was not found");
  return source.slice(start, end);
};

parseInlineScripts(smart, "SmartParser");
parseInlineScripts(settings, "settings");
parseInlineScripts(merch, "MerchOps");

const engineStart = smart.indexOf("const calculatePricesEngine =");
const engineReturn = smart.indexOf("            return newFinalData;", engineStart);
const engineEnd = smart.indexOf("        };", engineReturn) + "        };".length;
assert.ok(engineStart >= 0 && engineReturn > engineStart && engineEnd > engineReturn, "price engine block was not found");
const engineSource = smart.slice(engineStart, engineEnd);
const smartHelpers = sliceBetween(
  smart,
  "const PARSER_LIST_MARGIN_RULES_KEY =",
  "const cleanupSmartParserStorage =",
  "SmartParser pricing helpers",
);

const smartContext = vm.createContext({ console, Date, Object, Array, String, Number, Math, Set, Map, JSON });
vm.runInContext(
  [
    "const parseNum = (v) => (!v ? 0 : Number(String(v).replace(/,/g, '').replace(/[^\\d.-]/g, '')) || 0);",
    "const calcDiffRate = (oldVal, newVal) => { const oldNum = parseNum(oldVal); const newNum = parseNum(newVal); return oldNum ? Math.round(((newNum - oldNum) / oldNum) * 1000) / 10 : null; };",
    "let idCounter = 0;",
    "const generateUUID = () => 'test-' + (++idCounter);",
    "const normalizeText = (v) => String(v || '').replace(/\\s+/g, '').toLowerCase();",
    "const addTag = (oldTags, newTag) => { const tags = String(oldTags || '').split(',').map(v => v.trim()).filter(Boolean); if (newTag && !tags.includes(newTag)) tags.push(newTag); return tags.join(', '); };",
    "const removeTag = (oldTags, tag) => String(oldTags || '').split(',').map(v => v.trim()).filter(v => v && v !== tag).join(', ');",
    engineSource,
    smartHelpers,
    "globalThis.helpers = { calculatePricesEngine, normalizeParserListMarginRules, resolveParserListMarginRule, hasParserRowInPrice, getParserRowInPrice, areParserPriceValuesEqual, calculateParserCatalogPrices, buildSmartParserApplyPlan, buildSmartParserMissingTagPlan };",
  ].join("\n"),
  smartContext,
);
const h = smartContext.helpers;
const iso = "2026-08-01T03:04:05.678Z";
const divide10 = { marginRate: 10, calculationType: "divide", updatedAt: iso };
const divide20 = { marginRate: 20, calculationType: "divide", updatedAt: iso };
const multiply10 = { marginRate: 10, calculationType: "multiply", updatedAt: iso };

assert.equal(h.calculatePricesEngine(10000, {}, {}, [], true, divide10)["출고가"], 11100);
assert.equal(h.calculatePricesEngine(10000, {}, {}, [], true, divide20)["출고가"], 12500);
assert.equal(h.calculatePricesEngine(10000, {}, {}, [], true, multiply10)["출고가"], 11000);
assert.equal(
  h.calculatePricesEngine(10000, {}, { "창고": "01", "단위": "box" }, [{ whCode: "01", unit: "box", rate: 20, type: "divide" }], true, divide10)["출고가"],
  11100,
  "an explicit catalog rule must bypass warehouse and unit matching",
);
const costResult = h.calculatePricesEngine(
  10000,
  {},
  { "외주비": 2000, "노무비": 1000, "1종연산": 4, "경비": 50 },
  [],
  true,
  divide10,
);
assert.equal(costResult["출고가"], 14400);
assert.equal(costResult["시중가"], 14400);
assert.equal(costResult["1입고"], 3000);
assert.equal(costResult["1출고"], 3650);
assert.equal(
  h.calculatePricesEngine(10000, {}, { "창고": "01", "단위": "box" }, [{ whCode: "01", unit: "box", rate: 20, type: "divide" }], true)["출고가"],
  12500,
  "the existing general MerchOps rule path must remain unchanged",
);
assert.equal(
  h.calculatePricesEngine(10000, {}, {}, [], true)["출고가"],
  11100,
  "the legacy engine fallback remains available outside the SmartParser exact-rule path",
);

const normalizedRule = JSON.parse(JSON.stringify(h.normalizeParserListMarginRules({
  "  Cat  ": { marginRate: 10, calculationType: "divide", updatedAt: iso, extra: "drop" },
  stringRate: { marginRate: "10", calculationType: "divide", updatedAt: iso },
  bad: { marginRate: 5, calculationType: "divide", updatedAt: "invalid" },
  hundred: { marginRate: 100, calculationType: "divide", updatedAt: iso },
})));
assert.deepEqual(normalizedRule, {
  Cat: { marginRate: 10, calculationType: "divide", updatedAt: iso },
});
assert.equal(h.resolveParserListMarginRule(normalizedRule, " Cat ").marginRate, 10);
assert.equal(h.resolveParserListMarginRule(normalizedRule, "cat"), null, "catalog matching is case-sensitive exact matching");

const existingMaster = {
  A: {
    "코드": "A",
    "품목명": "기존상품",
    "규격": "기존규격",
    "단위": "box",
    "카탈로그": "Other",
    "입고가": 9000,
    "출고가": 10000,
    "시중가": 10000,
    "1입고": 2200,
    "1출고": 2550,
    "1종연산": 4,
    "경비": 50,
    "판매여부": 1,
  },
};
const existingPlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{
    _matchCode: "A",
    _matchStatus: "자동일치",
    _hasParsedInPrice: true,
    "품목명": "기존상품",
    "규격": "기존규격",
    "단위": "box",
    finalData: { "입고가": 10000, "외주비": 2000, "노무비": 1000, "1종연산": 4, "경비": 50 },
  }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "2026. 8. 1.",
  updateTextData: false,
});
assert.equal(existingPlan.newMaster.A["입고가"], 10000);
assert.equal(existingPlan.newMaster.A["출고가"], 14400);
assert.equal(existingPlan.newMaster.A["시중가"], 14400);
assert.equal(existingPlan.newMaster.A["1입고"], 3000);
assert.equal(existingPlan.newMaster.A["1출고"], 3650);
assert.equal(existingPlan.newMaster.A["판매여부"], 1);
assert.equal(existingPlan.newMaster.A["카탈로그"], "Other, Cat");
const existingPriceLogs = existingPlan.logs.filter((log) => ["출고가", "시중가", "1입고", "1출고"].includes(log.field));
assert.equal(existingPriceLogs.length, 4);
assert.ok(existingPlan.logs.every((log) => log.timestampISO === iso));
assert.deepEqual(
  JSON.parse(JSON.stringify(existingPriceLogs[0].priceRule)),
  divide10,
  "price history records the exact catalog rule",
);
assert.equal(existingPlan.logs.find((log) => log.field === "입고가").priceChangeType, "up");

const newPlan = h.buildSmartParserApplyPlan({
  masterProducts: {},
  rows: [{ _matchCode: "B", _hasParsedInPrice: true, "품목명": "신규", "규격": "1개", "단위": "ea", finalData: { "입고가": 10000 } }],
  catalogLabel: "Cat",
  catalogRule: multiply10,
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(newPlan.newMaster.B["출고가"], 11000);
assert.equal(newPlan.newMaster.B["시중가"], 11000);
assert.equal(newPlan.newMaster.B["판매여부"], undefined);
assert.ok(newPlan.logs.some((log) => log.supplyChangeType === "new"));
assert.ok(newPlan.logs.some((log) => log.supplyChangeType === "tag_first" && log.isNewProduct === true));
assert.ok(newPlan.logs.every((log) => log.timestampISO === iso));
assert.equal(newPlan.logs.find((log) => log.field === "출고가").oldVal, "");

const existingMultiplyPlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: true, "품목명": "기존상품", finalData: { "입고가": 10000 } }],
  catalogLabel: "Cat",
  catalogRule: multiply10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
});
assert.equal(existingMultiplyPlan.newMaster.A["출고가"], 11000);

const newDividePlan = h.buildSmartParserApplyPlan({
  masterProducts: {},
  rows: [{ _matchCode: "D", _hasParsedInPrice: true, "품목명": "나누기신규", finalData: { "입고가": 10000 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(newDividePlan.newMaster.D["출고가"], 11100);

const noRulePlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{
    _matchCode: "A",
    _hasParsedInPrice: true,
    "품목명": "룰없이 바뀌면 안 됨",
    "규격": "새규격",
    finalData: { "입고가": 11000, "품목명": "누출금지" },
    _editedTextFields: { "품목명": "누출금지" },
  }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: true,
  allowExistingInfoChanges: false,
});
assert.equal(noRulePlan.newMaster.A["입고가"], 11000);
assert.equal(noRulePlan.newMaster.A["출고가"], existingMaster.A["출고가"]);
assert.equal(noRulePlan.newMaster.A["시중가"], existingMaster.A["시중가"]);
assert.equal(noRulePlan.newMaster.A["품목명"], existingMaster.A["품목명"]);
assert.equal(noRulePlan.logs.filter((log) => ["출고가", "시중가", "1입고", "1출고"].includes(log.field)).length, 0);
assert.equal(noRulePlan.logs.filter((log) => log.actionType === "정보변경").length, 0);

const noRuleNewPlan = h.buildSmartParserApplyPlan({
  masterProducts: {},
  rows: [{ _matchCode: "N", _hasParsedInPrice: true, "품목명": "룰없는신규", finalData: { "입고가": 7000 } }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  allowExistingInfoChanges: false,
});
assert.equal(noRuleNewPlan.newMaster.N["입고가"], 7000);
assert.equal(noRuleNewPlan.newMaster.N["카탈로그"], "Cat");
assert.equal(noRuleNewPlan.newMaster.N["출고가"], undefined);
assert.equal(noRuleNewPlan.logs.some((log) => ["출고가", "시중가", "1입고", "1출고"].includes(log.field)), false);

const explicitInfoPlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{
    _matchCode: "A",
    _hasParsedInPrice: true,
    "품목명": "수정상품",
    "규격": "기존규격",
    finalData: { "입고가": 9000, "품목명": "수정상품" },
    _editedTextFields: { "품목명": "수정상품" },
  }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: true,
});
assert.equal(explicitInfoPlan.newMaster.A["품목명"], "수정상품");
const infoLog = explicitInfoPlan.logs.find((log) => log.actionType === "정보변경" && log.field === "품목명");
assert.equal(infoLog.oldVal, "기존상품");
assert.equal(infoLog.newVal, "수정상품");

const missingPricePlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: false, "품목명": "기존상품", "입고가": "0", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
});
assert.equal(missingPricePlan.newMaster.A["입고가"], existingMaster.A["입고가"]);
assert.equal(missingPricePlan.newMaster.A["출고가"], existingMaster.A["출고가"]);
assert.equal(missingPricePlan.logs.some((log) => log.field === "입고가"), false);
assert.equal(missingPricePlan.logs.some((log) => ["출고가", "시중가", "1입고", "1출고"].includes(log.field)), false);

const legacyMissingPricePlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", "품목명": "기존상품", finalData: { "입고가": 0 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
});
assert.equal(legacyMissingPricePlan.newMaster.A["입고가"], existingMaster.A["입고가"]);
assert.equal(legacyMissingPricePlan.logs.some((log) => log.field === "입고가"), false);

const legacyExplicitZeroPlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", "품목명": "기존상품", "입고가": "0", finalData: { "입고가": 0 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
});
assert.equal(legacyExplicitZeroPlan.newMaster.A["입고가"], 0);
assert.equal(legacyExplicitZeroPlan.logs.find((log) => log.field === "입고가").priceChangeType, "zero");

const zeroPlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: true, "품목명": "기존상품", finalData: { "입고가": 0 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
});
assert.equal(zeroPlan.newMaster.A["입고가"], 0);
assert.equal(zeroPlan.newMaster.A["출고가"], existingMaster.A["출고가"]);
assert.equal(zeroPlan.newMaster.A["판매여부"], existingMaster.A["판매여부"]);
assert.equal(zeroPlan.logs.filter((log) => ["출고가", "시중가", "1입고", "1출고"].includes(log.field)).length, 0);
const zeroLog = zeroPlan.logs.find((log) => log.field === "입고가");
assert.equal(zeroLog.priceChangeType, "zero");
assert.equal(zeroLog.availabilityType, "unavailable");
assert.match(zeroLog.memo, /판매불가/);

const zeroNewPlan = h.buildSmartParserApplyPlan({
  masterProducts: {},
  rows: [{ _matchCode: "Z", _hasParsedInPrice: true, "품목명": "0원신규", finalData: { "입고가": 0 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(zeroNewPlan.newMaster.Z["입고가"], 0);
assert.equal(zeroNewPlan.newMaster.Z["출고가"], undefined);
assert.equal(zeroNewPlan.newMaster.Z["판매여부"], undefined);
assert.equal(zeroNewPlan.logs.filter((log) => ["출고가", "시중가", "1입고", "1출고"].includes(log.field)).length, 0);

const sameMaster = {
  A: { ...existingMaster.A, "카탈로그": "Cat", "입고가": 10000, "출고가": 11100, "시중가": 11100 },
};
const samePlan = h.buildSmartParserApplyPlan({
  masterProducts: sameMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: true, "품목명": "기존상품", finalData: { "입고가": 10000 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
});
assert.equal(samePlan.logs.some((log) => ["출고가", "시중가"].includes(log.field)), false);
assert.equal(h.areParserPriceValuesEqual("", 0), false, "blank and numeric zero remain distinguishable");
assert.equal(h.areParserPriceValuesEqual("0", 0), true);

const reappearedPlan = h.buildSmartParserApplyPlan({
  masterProducts: existingMaster,
  rows: [{ _matchCode: "A", _hasParsedInPrice: false, "품목명": "기존상품", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: null,
  priorHistory: [{ source: "parser", code: "A", catalogName: "Cat", supplyChangeType: "stopped" }],
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.equal(Object.keys(reappearedPlan.newMaster).length, 1);
assert.equal(reappearedPlan.logs.filter((log) => log.supplyChangeType === "reappeared").length, 1);
assert.equal(reappearedPlan.logs.some((log) => log.supplyChangeType === "new"), false);
assert.equal(reappearedPlan.newMaster.A["판매여부"], existingMaster.A["판매여부"]);

const existingTagFormattingPlan = h.buildSmartParserApplyPlan({
  masterProducts: { A: { ...existingMaster.A, "카탈로그": "Cat,  Other" } },
  rows: [{ _matchCode: "A", _hasParsedInPrice: false, "품목명": "기존상품", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.equal(existingTagFormattingPlan.newMaster.A["카탈로그"], "Cat,  Other");
assert.equal(existingTagFormattingPlan.logs.some((log) => log.field === "카탈로그"), false);

const missingTagPlan = h.buildSmartParserMissingTagPlan({
  masterProducts: { A: { ...existingMaster.A, "카탈로그": "Cat, Other", "판매여부": 0 } },
  codes: ["A", "A"],
  catalogLabel: "Cat",
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(missingTagPlan.newMaster.A["카탈로그"], "Other");
assert.equal(missingTagPlan.newMaster.A["판매여부"], 0);
assert.equal(missingTagPlan.logs.length, 1);
assert.equal(missingTagPlan.logs[0].supplyChangeType, "stopped");
const absentTagPlan = h.buildSmartParserMissingTagPlan({
  masterProducts: { A: { ...existingMaster.A, "카탈로그": "Other,  Extra" } },
  codes: ["A"],
  catalogLabel: "Cat",
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(absentTagPlan.newMaster.A["카탈로그"], "Other,  Extra");
assert.equal(absentTagPlan.logs.length, 0);

const noEngineContext = vm.createContext({ Date, Object, Array, String, Number, Math, Set, JSON });
vm.runInContext(
  [
    "const parseNum = (v) => (!v ? 0 : Number(String(v).replace(/,/g, '')) || 0);",
    "const calcDiffRate = () => null;",
    "const generateUUID = () => 'id';",
    "const normalizeText = (v) => String(v || '');",
    "const addTag = (v) => v || '';",
    "const removeTag = (v) => v || '';",
    "let engineCalls = 0;",
    "const calculatePricesEngine = () => { engineCalls++; return { '출고가': 123, '시중가': 123 }; };",
    smartHelpers,
    "globalThis.pricingProbe = { calculateParserCatalogPrices, calls: () => engineCalls };",
  ].join("\n"),
  noEngineContext,
);
noEngineContext.pricingProbe.calculateParserCatalogPrices(0, {}, {}, divide10);
noEngineContext.pricingProbe.calculateParserCatalogPrices(10000, {}, {}, null);
assert.equal(noEngineContext.pricingProbe.calls(), 0, "zero and no-rule paths must not invoke the price engine");
noEngineContext.pricingProbe.calculateParserCatalogPrices(10000, {}, {}, divide10);
assert.equal(noEngineContext.pricingProbe.calls(), 1);

const applyBlock = sliceBetween(smart, "const handleApplyMatched =", "const handleConfirmMapping =", "SmartParser apply handler");
assert.ok(applyBlock.indexOf("window.confirm(confirmMessage)") < applyBlock.indexOf("setIsProcessing(true)"), "cancel must return before mutations");
assert.ok(applyBlock.indexOf("window.confirm(confirmMessage)") < applyBlock.indexOf("buildSmartParserApplyPlan({"));
assert.ok(applyBlock.indexOf("window.confirm(confirmMessage)") < applyBlock.indexOf("await saveMaster(newMaster, sharedEntries)"));
assert.match(applyBlock, /if \(!window\.confirm\(confirmMessage\)\)\s*return false/);
assert.match(applyBlock, /allowExistingInfoChanges: !!catalogRule/);
assert.match(applyBlock, /판매가격은 계산하거나 변경하지 않습니다/);
assert.doesNotMatch(smart, /merchMarginRules_v878/);
assert.doesNotMatch(smart, /pending_shop_status|merchStoppedProducts_v2/);
assert.doesNotMatch(smart, /\['판매여부'\]\s*=(?!=)/);

const commitSource = sliceBetween(
  smart,
  "let smartParserMasterRevision = undefined",
  "const useParserApp =",
  "SmartParser commit helper",
);
const rollbackValues = new Map([["merchHistory_v870", JSON.stringify([{ id: "before" }])]]);
const rollbackStorage = {
  getItem(key) { return rollbackValues.has(key) ? rollbackValues.get(key) : null; },
  setItem(key, value) { rollbackValues.set(key, String(value)); },
  removeItem(key) { rollbackValues.delete(key); },
};
let committedMaster = { A: { 코드: "A", 입고가: 9000 } };
const rollbackWindow = {
  ONEAPP: {
    STORAGE: {
      async commitMasterStateOrThrow(data, options) {
        const before = JSON.parse(JSON.stringify(committedMaster));
        committedMaster = JSON.parse(JSON.stringify(data));
        try {
          if (options.afterVerified) options.afterVerified();
        } catch (error) {
          committedMaster = before;
          throw error;
        }
        return { revision: "unexpected-success" };
      },
    },
  },
};
const rollbackContext = vm.createContext({
  window: rollbackWindow,
  localStorage: rollbackStorage,
  Date,
  Array,
  String,
  Error,
  console,
  saveMerchHistoryWithRetry(logs) {
    rollbackStorage.setItem("merchHistory_v870", JSON.stringify(logs));
    throw new Error("forced history write failure");
  },
});
vm.runInContext(commitSource + "\nglobalThis.commitUnderTest = commitSmartParserMaster;", rollbackContext);
await assert.rejects(
  rollbackContext.commitUnderTest(
    { A: { 코드: "A", 입고가: 10000 } },
    {},
    [{ id: "new-history" }],
  ),
  /forced history write failure/,
);
assert.deepEqual(committedMaster, { A: { 코드: "A", 입고가: 9000 } });
assert.deepEqual(JSON.parse(rollbackStorage.getItem("merchHistory_v870")), [{ id: "before" }]);
assert.equal(rollbackStorage.getItem("merchMaster_sync_trigger"), null);

const settingsHelperSource = sliceBetween(
  settings,
  "const PARSER_LIST_MARGIN_RULES_KEY =",
  "const TABLE_VIEW_TARGETS =",
  "settings parser-list rule helpers",
);
const settingsContext = vm.createContext({ Date, Object, Array, String, Number });
vm.runInContext(settingsHelperSource + "\nglobalThis.normalizeRules = normalizeParserListMarginRules;", settingsContext);
const settingsNormalized = JSON.parse(JSON.stringify(settingsContext.normalizeRules({
  " Cat ": { marginRate: 20, calculationType: "multiply", updatedAt: iso, warehouse: "must-drop" },
  invalid100: { marginRate: 100, calculationType: "divide", updatedAt: iso },
})));
assert.deepEqual(settingsNormalized, { Cat: { marginRate: 20, calculationType: "multiply", updatedAt: iso } });
const cloudBlock = sliceBetween(settings, "const CONFIG_SYNC_KEYS =", "const applySettingsCloudData =", "settings cloud payload");
assert.doesNotMatch(cloudBlock, /parserListMarginRules_v1|PARSER_LIST_MARGIN_RULES_KEY/);
assert.match(settings, /merchMarginRules_v878/);
assert.match(settings, /const addMarginRule =/);
assert.match(settings, /const updateMarginRule =/);
assert.match(settings, /const deleteMarginRule =/);

const merchHelpers = sliceBetween(
  merch,
  "window.MERCH_PARSER_PRICE_HISTORY_FIELDS =",
  "const formatSignedNumber =",
  "MerchOps parser analysis helpers",
);
const merchWindow = {
  normalizeParserListMarginRules(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  },
  parseNum(value) {
    if (!value) return 0;
    return Number(String(value).replace(/,/g, "").replace(/[^\d.-]/g, "")) || 0;
  },
  getMerchMasterSalePriceInfo(master) {
    return { value: master["출고가"] ?? "", source: "출고가" };
  },
  getMasterSalesState(master) {
    return { text: String(master["판매여부"] ?? "-") };
  },
};
const merchContext = vm.createContext({ window: merchWindow, Object, Array, String, Number, Set, Map, Date });
vm.runInContext(
  [
    "const normalizeHistoryCatalog = (log = {}) => String(log.catalogName || log.catalog || '').trim();",
    "const getHistoryLogCode = (log = {}) => String(log.code || log['품목코드'] || '').trim();",
    "const getHistoryFieldName = (log = {}) => String(log.field || '').trim();",
    "const getHistoryOldValue = (log = {}) => log.oldVal ?? '';",
    "const getHistoryNewValue = (log = {}) => log.newVal ?? '';",
    "const isExactParserHistoryLog = (log = {}) => String(log.source || '').trim() === 'parser';",
    "const areMerchHistoryValuesEqual = (left, right) => String(left ?? '').trim() === String(right ?? '').trim();",
    "const parseHistoryTime = (log = {}) => { const parsed = new Date(log.timestampISO || log.timestamp || 0); return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime(); };",
    merchHelpers,
  ].join("\n"),
  merchContext,
);
const mh = merchContext.window;
assert.equal(mh.buildMerchParserListHistoryAnalysis({
  historyLogs: [],
  activeTags: [],
  masterProducts: { A: { 코드: "A" } },
}).active, false);

const t1 = "2026-08-01T01:00:00.000Z";
const t2 = "2026-08-01T02:00:00.000Z";
const t3 = "2026-08-01T03:00:00.000Z";
const t4 = "2026-08-01T04:00:00.000Z";
const analysisLogs = [
  { id: "cost-up", source: "parser", code: "A", catalogName: "Cat", timestampISO: t1, field: "입고가", oldVal: 100, newVal: 120 },
  { id: "price-exact", source: "parser", code: "A", catalogName: "Cat", timestampISO: t1, field: "출고가", oldVal: 150, newVal: 180 },
  { id: "price-other-catalog", source: "parser", code: "A", catalogName: "Other", timestampISO: t1, field: "시중가", oldVal: 150, newVal: 999 },
  { id: "price-near-time", source: "parser", code: "A", catalogName: "Cat", timestampISO: "2026-08-01T01:00:01.000Z", field: "시중가", oldVal: 150, newVal: 190 },
  { id: "cost-zero", source: "parser", code: "A", catalogName: "Cat", timestampISO: t2, field: "입고가", oldVal: 120, newVal: 0 },
  { id: "cost-recovery", source: "parser", code: "A", catalogName: "Cat", timestampISO: t3, field: "입고가", oldVal: 0, newVal: 130 },
  { id: "cost-down", source: "parser", code: "A", catalogName: "Cat", timestampISO: t4, field: "입고가", oldVal: 130, newVal: 110 },
  { id: "same", source: "parser", code: "A", catalogName: "Cat", timestampISO: t4, field: "입고가", oldVal: 110, newVal: 110 },
  { id: "wrong-source", source: "estimate", code: "A", catalogName: "Cat", timestampISO: t4, field: "입고가", oldVal: 110, newVal: 200 },
  { id: "wrong-catalog", source: "parser", code: "A", catalogName: "Other", timestampISO: t4, field: "입고가", oldVal: 110, newVal: 200 },
  { id: "missing-master", source: "parser", code: "B", catalogName: "Cat", timestampISO: t4, field: "입고가", oldVal: 1, newVal: 2 },
  { id: "supply-new", source: "parser", code: "A", catalogName: "Cat", timestampISO: t1, field: "신규", oldVal: "", newVal: "A", supplyChangeType: "new" },
  { id: "supply-tag-detail", source: "parser", code: "A", catalogName: "Cat", timestampISO: t1, field: "카탈로그", oldVal: "", newVal: "Cat", supplyChangeType: "tag_first", isNewProduct: true },
  { id: "supply-stopped", source: "parser", code: "A", catalogName: "Cat", timestampISO: t2, field: "카탈로그", oldVal: "Cat", newVal: "", supplyChangeType: "stopped" },
  { id: "supply-reappeared", source: "parser", code: "A", catalogName: "Cat", timestampISO: t3, field: "카탈로그", oldVal: "", newVal: "Cat", supplyChangeType: "reappeared" },
];
const merchAnalysis = mh.buildMerchParserListHistoryAnalysis({
  historyLogs: analysisLogs,
  activeTags: [{ type: "catalog", name: "Cat" }],
  masterProducts: { A: { 코드: "A", 품목명: "상품A", 출고가: 190, 판매여부: 1 } },
  parserListMarginRules: { Cat: divide10 },
});
assert.equal(merchAnalysis.active, true);
assert.equal(merchAnalysis.events.length, 7);
assert.equal(merchAnalysis.counts.cost_up, 1);
assert.equal(merchAnalysis.counts.cost_down, 1);
assert.equal(merchAnalysis.counts.cost_zero, 1);
assert.equal(merchAnalysis.counts.cost_recovery, 1);
assert.equal(merchAnalysis.counts.supply_new, 1, "new-product tag detail must not duplicate the new supply event");
assert.equal(merchAnalysis.counts.supply_stopped, 1);
assert.equal(merchAnalysis.counts.supply_reappeared, 1);
const upEvent = merchAnalysis.events.find((event) => event.log.id === "cost-up");
assert.deepEqual(JSON.parse(JSON.stringify(upEvent.priceChanges.map((entry) => entry.field))), ["출고가"]);
assert.equal(upEvent.currentSalePrice, 190);
assert.equal(upEvent.currentSaleAvailability, 1);
assert.equal(upEvent.rule.marginRate, 10);
const supplyEvent = merchAnalysis.events.find((event) => event.kind === "supply");
assert.equal(Object.prototype.hasOwnProperty.call(supplyEvent, "diffRate"), false);
assert.equal(mh.findMerchParserPriceHistoryExact(analysisLogs, { code: "A", catalogName: "Cat", timestampISO: t1, field: "출고가" }).id, "price-exact");
assert.equal(mh.findMerchParserPriceHistoryExact(analysisLogs, { code: "A", catalogName: "Cat", timestampISO: t1, field: "시중가" }), null);

assert.match(historyViewer, /merchHistory_v870/);
assert.match(historyViewer, /oldVal/);
assert.match(historyViewer, /newVal/);
assert.match(historyViewer, /actionType/);
assert.match(smart, /commitMasterStateOrThrow\(data,/);
assert.match(merch, /return exact\[0\] \|\| null/);
assert.match(merch, /Array\.isArray\(data\.historyLogs\)[\s\S]*?isExactParserHistoryLog\(log\)[\s\S]*?normalizeHistoryCatalog\(log\)/);

console.log("ONEAPP parser-list price rules, atomic history, supply events, and exact MerchOps analysis tests passed.");
