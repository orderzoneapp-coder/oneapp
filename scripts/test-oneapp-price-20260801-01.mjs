import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
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
    "globalThis.helpers = { calculatePricesEngine, normalizeParserListMarginRules, resolveParserListMarginRule, classifyParserInPriceChange, hasParserRowInPrice, getParserRowInPrice, areParserPriceValuesEqual, calculateParserCatalogPrices, createSmartParserMasterCodeResolver, buildSmartParserApplyPlan, buildSmartParserMissingTagPlan };",
  ].join("\n"),
  smartContext,
);
const h = smartContext.helpers;
const iso = "2026-08-01T03:04:05.678Z";
const divide10 = { marginRate: 10, calculationType: "divide", updatedAt: iso };
const divide20 = { marginRate: 20, calculationType: "divide", updatedAt: iso };
const multiply10 = { marginRate: 10, calculationType: "multiply", updatedAt: iso };
const offsetIso = "2026-08-01T12:04:05.678+09:00";
const canonicalOffsetIso = "2026-08-01T03:04:05.678Z";
const parserRuleNormalizationCorpus = {
  "  Cat  ": { marginRate: 10, calculationType: "divide", updatedAt: iso, extra: "drop" },
  Offset: { marginRate: 15, calculationType: "multiply", updatedAt: offsetIso },
  MultiplyAbove100: { marginRate: 101, calculationType: "multiply", updatedAt: iso },
  stringRate: { marginRate: "10", calculationType: "divide", updatedAt: iso },
  invalidDate: { marginRate: 5, calculationType: "divide", updatedAt: "invalid" },
  nullDate: { marginRate: 5, calculationType: "divide", updatedAt: null },
  blankDate: { marginRate: 5, calculationType: "divide", updatedAt: "   " },
  numericEpochZero: { marginRate: 5, calculationType: "divide", updatedAt: 0 },
  numericEpochPositive: { marginRate: 5, calculationType: "divide", updatedAt: 1722481445678 },
  stringEpochZero: { marginRate: 5, calculationType: "divide", updatedAt: "0" },
  naturalLanguageDate: { marginRate: 5, calculationType: "divide", updatedAt: "August 1, 2026" },
  timezoneMissing: { marginRate: 5, calculationType: "divide", updatedAt: "2026-08-01T03:04:05.678" },
  dateObject: { marginRate: 5, calculationType: "divide", updatedAt: new Date(iso) },
  paddedType: { marginRate: 5, calculationType: " divide ", updatedAt: iso },
  divide100: { marginRate: 100, calculationType: "divide", updatedAt: iso },
  divide101: { marginRate: 101, calculationType: "divide", updatedAt: iso },
};
const expectedNormalizedRules = {
  Cat: { marginRate: 10, calculationType: "divide", updatedAt: iso },
  Offset: { marginRate: 15, calculationType: "multiply", updatedAt: canonicalOffsetIso },
  MultiplyAbove100: { marginRate: 101, calculationType: "multiply", updatedAt: iso },
};

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

const normalizedRule = JSON.parse(JSON.stringify(h.normalizeParserListMarginRules(parserRuleNormalizationCorpus)));
assert.deepEqual(normalizedRule, expectedNormalizedRules);
assert.equal(h.resolveParserListMarginRule(normalizedRule, " Cat ").marginRate, 10);
assert.equal(h.resolveParserListMarginRule(normalizedRule, "cat"), null, "catalog matching is case-sensitive exact matching");
assert.equal(h.resolveParserListMarginRule({ Cat: parserRuleNormalizationCorpus.nullDate }, "Cat"), null, "null updatedAt must never become an epoch rule");
assert.equal(h.classifyParserInPriceChange("", 1000), "new_price");
assert.equal(h.classifyParserInPriceChange(null, 1000), "new_price");
assert.equal(h.classifyParserInPriceChange(0, 1000), "new_price");
assert.equal(h.classifyParserInPriceChange("0", 1000), "new_price");
assert.equal(h.classifyParserInPriceChange(800, 1000), "up");
assert.equal(h.classifyParserInPriceChange(1200, 1000), "down");
assert.equal(h.classifyParserInPriceChange(10000, 0), "zero");
assert.equal(h.classifyParserInPriceChange("", 0), "", "blank-to-zero is not a positive-to-zero event");

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
const spacedMaster = {
  "A 1": {
    "코드": "A 1",
    "품목명": "공백코드 기존상품",
    "카탈로그": "Other",
    "입고가": 9000,
    "출고가": 10000,
    "판매여부": 0,
  },
};
const spacedResolution = h.createSmartParserMasterCodeResolver(spacedMaster).resolve("A1");
assert.equal(spacedResolution.exists, true);
assert.equal(spacedResolution.masterKey, "A 1");
assert.equal(spacedResolution.actualCode, "A 1");
const spacedApplyPlan = h.buildSmartParserApplyPlan({
  masterProducts: spacedMaster,
  rows: [{ _matchCode: "A1", _hasParsedInPrice: false, "품목명": "공백코드 기존상품", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.deepEqual(Object.keys(spacedApplyPlan.newMaster), ["A 1"]);
assert.equal(Object.prototype.hasOwnProperty.call(spacedApplyPlan.newMaster, "A1"), false);
assert.equal(spacedApplyPlan.newMaster["A 1"]["코드"], "A 1");
assert.equal(spacedApplyPlan.newMaster["A 1"]["판매여부"], 0);
assert.equal(spacedApplyPlan.logs.some((log) => log.supplyChangeType === "new"), false);
assert.deepEqual(JSON.parse(JSON.stringify(spacedApplyPlan.processedCodes)), ["A 1"]);

const spacedReappearedPlan = h.buildSmartParserApplyPlan({
  masterProducts: spacedMaster,
  rows: [{ _matchCode: "A1", _hasParsedInPrice: false, "품목명": "공백코드 기존상품", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: null,
  priorHistory: [{ source: "parser", code: "A1", catalogName: "Cat", supplyChangeType: "stopped" }],
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.equal(spacedReappearedPlan.logs.filter((log) => log.supplyChangeType === "reappeared").length, 1);
assert.equal(spacedReappearedPlan.logs.some((log) => ["new", "tag_first"].includes(log.supplyChangeType)), false);
assert.deepEqual(Object.keys(spacedReappearedPlan.newMaster), ["A 1"]);

const spacedMissingPlan = h.buildSmartParserMissingTagPlan({
  masterProducts: { "A 1": { ...spacedMaster["A 1"], "카탈로그": "Cat, Other" } },
  codes: ["A1"],
  catalogLabel: "Cat",
  timestampISO: iso,
  timestampLabel: "now",
});
assert.deepEqual(Object.keys(spacedMissingPlan.newMaster), ["A 1"]);
assert.equal(spacedMissingPlan.newMaster["A 1"]["카탈로그"], "Other");
assert.equal(spacedMissingPlan.newMaster["A 1"]["판매여부"], 0);
assert.equal(spacedMissingPlan.logs.length, 1);
assert.equal(spacedMissingPlan.logs[0].code, "A 1");

const distinctKeyMaster = {
  "stored-row-key": { ...spacedMaster["A 1"], "코드": "A 1" },
};
const distinctKeyPlan = h.buildSmartParserApplyPlan({
  masterProducts: distinctKeyMaster,
  rows: [{ _matchCode: "A1", _hasParsedInPrice: false, "품목명": "공백코드 기존상품", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.deepEqual(Object.keys(distinctKeyPlan.newMaster), ["stored-row-key"]);
assert.equal(distinctKeyPlan.newMaster["stored-row-key"]["코드"], "A 1");
assert.equal(distinctKeyPlan.logs.some((log) => log.supplyChangeType === "new"), false);
assert.ok(distinctKeyPlan.logs.every((log) => log.code === "A 1"));

const ambiguousMaster = {
  "A 1": { "코드": "A 1", "품목명": "중복1", "카탈로그": "Cat", "판매여부": 1 },
  A1: { "코드": "A1", "품목명": "중복2", "카탈로그": "Cat", "판매여부": 0 },
};
const ambiguousMasterBefore = JSON.parse(JSON.stringify(ambiguousMaster));
const ambiguousHistory = [{ id: "before", source: "parser" }];
const ambiguousHistoryBefore = JSON.parse(JSON.stringify(ambiguousHistory));
let ambiguousApplyWrites = 0;
assert.throws(() => {
  h.buildSmartParserApplyPlan({
    masterProducts: ambiguousMaster,
    rows: [{ _matchCode: "A1", _hasParsedInPrice: false, "품목명": "중복", finalData: {} }],
    catalogLabel: "Cat",
    catalogRule: null,
    priorHistory: ambiguousHistory,
    timestampISO: iso,
    timestampLabel: "now",
  });
  ambiguousApplyWrites++;
}, /정규화 상품코드 \[A1\].*여러 개/);
assert.equal(ambiguousApplyWrites, 0);
assert.deepEqual(ambiguousMaster, ambiguousMasterBefore);
assert.deepEqual(ambiguousHistory, ambiguousHistoryBefore);
assert.throws(() => h.buildSmartParserMissingTagPlan({
  masterProducts: ambiguousMaster,
  codes: ["A1"],
  catalogLabel: "Cat",
  timestampISO: iso,
  timestampLabel: "now",
}), /정규화 상품코드 \[A1\].*여러 개/);
assert.deepEqual(ambiguousMaster, ambiguousMasterBefore);

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
  rows: [{ _matchCode: "B", _hasParsedInPrice: true, "품목명": "신규", "규격": "1개", "단위": "ea", finalData: { "입고가": 1000 } }],
  catalogLabel: "Cat",
  catalogRule: multiply10,
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(newPlan.newMaster.B["출고가"], 1100);
assert.equal(newPlan.newMaster.B["시중가"], 1100);
assert.equal(newPlan.newMaster.B["판매여부"], undefined);
assert.ok(newPlan.logs.some((log) => log.supplyChangeType === "new"));
assert.ok(newPlan.logs.some((log) => log.supplyChangeType === "tag_first" && log.isNewProduct === true));
assert.ok(newPlan.logs.every((log) => log.timestampISO === iso));
assert.equal(newPlan.logs.find((log) => log.field === "출고가").oldVal, "");
const newPlanInPriceLog = newPlan.logs.find((log) => log.field === "입고가");
assert.equal(newPlanInPriceLog.oldVal, "");
assert.equal(newPlanInPriceLog.newVal, 1000);
assert.equal(newPlanInPriceLog.priceChangeType, "new_price");
assert.equal(newPlanInPriceLog.changeType, "신규");
assert.equal(newPlanInPriceLog.diff, null);
assert.equal(newPlanInPriceLog.diffRate, null);

const blankCostMaster = {
  C: { "코드": "C", "품목명": "공란단가", "카탈로그": "Cat", "입고가": "", "출고가": 5000, "판매여부": 1 },
};
const blankToPositivePlan = h.buildSmartParserApplyPlan({
  masterProducts: blankCostMaster,
  rows: [{ _matchCode: "C", _hasParsedInPrice: true, "품목명": "공란단가", finalData: { "입고가": 1000 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
const blankToPositiveLog = blankToPositivePlan.logs.find((log) => log.field === "입고가");
assert.equal(blankToPositiveLog.oldVal, "");
assert.equal(blankToPositiveLog.newVal, 1000);
assert.equal(blankToPositiveLog.priceChangeType, "new_price");
assert.equal(blankToPositiveLog.changeType, "신규");
assert.equal(blankToPositiveLog.diff, null);
assert.equal(blankToPositiveLog.diffRate, null);
assert.equal(blankToPositivePlan.newMaster.C["출고가"], 1100);
assert.equal(blankToPositivePlan.newMaster.C["판매여부"], 1);
assert.ok(blankToPositivePlan.logs.every((log) => log.timestampISO === iso));
assert.ok(blankToPositivePlan.logs.some((log) => log.field === "출고가" && log.oldVal === 5000 && log.newVal === 1100));

const blankInputMaster = {
  C: { "코드": "C", "품목명": "공란입력", "카탈로그": "Cat", "입고가": 9000, "출고가": 10000, "판매여부": 1 },
};
const blankInputPlan = h.buildSmartParserApplyPlan({
  masterProducts: blankInputMaster,
  rows: [{ _matchCode: "C", _hasParsedInPrice: false, "품목명": "공란입력", "입고가": "   ", finalData: {} }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
assert.deepEqual(JSON.parse(JSON.stringify(blankInputPlan.newMaster)), blankInputMaster);
assert.equal(blankInputPlan.masterMutationCount, 0);
assert.equal(blankInputPlan.logs.length, 0);

const zeroToNewPricePlan = h.buildSmartParserApplyPlan({
  masterProducts: { Z: { ...blankInputMaster.C, "코드": "Z", "품목명": "0단가", "입고가": 0 } },
  rows: [{ _matchCode: "Z", _hasParsedInPrice: true, "품목명": "0단가", finalData: { "입고가": 1000 } }],
  catalogLabel: "Cat",
  catalogRule: divide10,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
const zeroToNewPriceLog = zeroToNewPricePlan.logs.find((log) => log.field === "입고가");
assert.equal(zeroToNewPriceLog.oldVal, 0);
assert.equal(zeroToNewPriceLog.newVal, 1000);
assert.equal(zeroToNewPriceLog.priceChangeType, "new_price");
assert.equal(zeroToNewPriceLog.changeType, "신규");
assert.equal(zeroToNewPriceLog.diff, null);
assert.equal(zeroToNewPriceLog.diffRate, null);
assert.equal(zeroToNewPricePlan.newMaster.Z["출고가"], 1100);
assert.equal(zeroToNewPricePlan.newMaster.Z["판매여부"], 1);
assert.ok(zeroToNewPricePlan.logs.every((log) => log.timestampISO === iso));
assert.ok(zeroToNewPricePlan.logs.some((log) => log.field === "출고가" && log.oldVal === 10000 && log.newVal === 1100));

const positiveUpPlan = h.buildSmartParserApplyPlan({
  masterProducts: { U: { "코드": "U", "품목명": "인상", "카탈로그": "Cat", "입고가": 800, "판매여부": 1 } },
  rows: [{ _matchCode: "U", _hasParsedInPrice: true, "품목명": "인상", finalData: { "입고가": 1000 } }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
const positiveUpLog = positiveUpPlan.logs.find((log) => log.field === "입고가");
assert.equal(positiveUpLog.priceChangeType, "up");
assert.equal(positiveUpLog.diff, 200);
assert.equal(positiveUpLog.diffRate, 25);

const positiveDownPlan = h.buildSmartParserApplyPlan({
  masterProducts: { D: { "코드": "D", "품목명": "인하", "카탈로그": "Cat", "입고가": 1200, "판매여부": 1 } },
  rows: [{ _matchCode: "D", _hasParsedInPrice: true, "품목명": "인하", finalData: { "입고가": 1000 } }],
  catalogLabel: "Cat",
  catalogRule: null,
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: false,
  allowExistingInfoChanges: false,
});
const positiveDownLog = positiveDownPlan.logs.find((log) => log.field === "입고가");
assert.equal(positiveDownLog.priceChangeType, "down");
assert.equal(positiveDownLog.diff, -200);
assert.equal(positiveDownLog.diffRate, -16.7);

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
assert.ok(applyBlock.indexOf("createSmartParserMasterCodeResolver(masterProducts)") < applyBlock.indexOf("window.confirm(confirmMessage)"), "ambiguous normalized codes must be rejected before confirmation and writes");
assert.ok(applyBlock.indexOf("window.confirm(confirmMessage)") < applyBlock.indexOf("setIsProcessing(true)"), "cancel must return before mutations");
assert.ok(applyBlock.indexOf("window.confirm(confirmMessage)") < applyBlock.indexOf("buildSmartParserApplyPlan({"));
assert.ok(applyBlock.indexOf("window.confirm(confirmMessage)") < applyBlock.indexOf("await saveMaster(newMaster, sharedEntries)"));
assert.match(applyBlock, /if \(!window\.confirm\(confirmMessage\)\)\s*return false/);
assert.match(applyBlock, /allowExistingInfoChanges: !!catalogRule/);
assert.match(applyBlock, /판매가격은 계산하거나 변경하지 않습니다/);
const createNewBlock = sliceBetween(smart, "const handleCreateNewMasterItem =", "const handleIgnoreParsedItem =", "SmartParser new-product precheck");
assert.match(createNewBlock, /createSmartParserMasterCodeResolver\(masterProducts\)\.resolve\(newCode\)/);
assert.doesNotMatch(createNewBlock, /if \(masterProducts\[newCode\]\)/);
const missingRowsBlock = sliceBetween(smart, "const missingRows = useMemo", "const masterSearchResults = useMemo", "SmartParser missing rows");
assert.match(missingRowsBlock, /createSmartParserMasterCodeResolver\(masterProducts\)/);
assert.match(missingRowsBlock, /codeResolver\.normalize/);
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
const settingsNormalized = JSON.parse(JSON.stringify(settingsContext.normalizeRules(parserRuleNormalizationCorpus)));
assert.deepEqual(settingsNormalized, expectedNormalizedRules);
const cloudBlock = sliceBetween(settings, "const CONFIG_SYNC_KEYS =", "const applySettingsCloudData =", "settings cloud payload");
assert.doesNotMatch(cloudBlock, /parserListMarginRules_v1|PARSER_LIST_MARGIN_RULES_KEY/);
assert.match(settings, /merchMarginRules_v878/);
assert.match(settings, /const addMarginRule =/);
assert.match(settings, /const updateMarginRule =/);
assert.match(settings, /const deleteMarginRule =/);
const saveParserListRuleBlock = sliceBetween(settings, "const saveParserListMarginRule =", "const deleteParserListMarginRule =", "settings parser-list rule save handler");
assert.match(saveParserListRuleBlock, /calculationType === 'divide' && marginRate >= 100/);

const merchRuleHelperSource = sliceBetween(
  merch,
  "window.PARSER_LIST_MARGIN_RULES_KEY =",
  "const TABLE_VIEW_TARGETS =",
  "MerchOps parser-list rule helpers",
);
const merchRuleWindow = {};
const merchRuleContext = vm.createContext({ window: merchRuleWindow, Date, Object, Array, String, Number });
vm.runInContext(merchRuleHelperSource, merchRuleContext);
const merchNormalizedRules = JSON.parse(JSON.stringify(merchRuleWindow.normalizeParserListMarginRules(parserRuleNormalizationCorpus)));
assert.deepEqual(merchNormalizedRules, expectedNormalizedRules);

const merchHelpers = sliceBetween(
  merch,
  "window.MERCH_PARSER_PRICE_HISTORY_FIELDS =",
  "const formatSignedNumber =",
  "MerchOps parser analysis helpers",
);
const merchWindow = {
  normalizeParserListMarginRules: merchRuleWindow.normalizeParserListMarginRules,
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
assert.equal(mh.classifyMerchParserCostChange("", 1000), "new_price");
assert.equal(mh.classifyMerchParserCostChange(null, 1000), "new_price");
assert.equal(mh.classifyMerchParserCostChange(0, 1000), "new_price");
assert.equal(mh.classifyMerchParserCostChange("0", 1000), "new_price");
assert.equal(mh.classifyMerchParserCostChange(800, 1000), "up");
assert.equal(mh.classifyMerchParserCostChange(1200, 1000), "down");
assert.equal(mh.classifyMerchParserCostChange(10000, 0), "zero");
assert.equal(mh.classifyMerchParserCostChange("", 0), "");
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
  { id: "cost-new-price", source: "parser", code: "A", catalogName: "Cat", timestampISO: t3, field: "입고가", oldVal: 0, newVal: 130, priceChangeType: "new_price" },
  { id: "price-new-exact", source: "parser", code: "A", catalogName: "Cat", timestampISO: t3, field: "출고가", oldVal: 150, newVal: 181 },
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
assert.equal(merchAnalysis.counts.cost_recovery, 0);
assert.equal(merchAnalysis.counts.supply_new, 2, "new_price and the distinct new-product supply event are both 신규");
assert.equal(merchAnalysis.counts.supply_stopped, 1);
assert.equal(merchAnalysis.counts.supply_reappeared, 1);
const upEvent = merchAnalysis.events.find((event) => event.log.id === "cost-up");
assert.deepEqual(JSON.parse(JSON.stringify(upEvent.priceChanges.map((entry) => entry.field))), ["출고가"]);
assert.equal(upEvent.currentSalePrice, 190);
assert.equal(upEvent.currentSaleAvailability, 1);
assert.equal(upEvent.rule.marginRate, 10);
const newPriceEvent = merchAnalysis.events.find((event) => event.log.id === "cost-new-price");
assert.equal(newPriceEvent.kind, "supply");
assert.equal(newPriceEvent.changeType, "new");
assert.equal(newPriceEvent.priceChangeType, "new_price");
assert.equal(newPriceEvent.oldVal, 0);
assert.equal(newPriceEvent.newVal, 130);
assert.equal(newPriceEvent.diff, null);
assert.equal(newPriceEvent.diffRate, null);
assert.deepEqual(JSON.parse(JSON.stringify(newPriceEvent.priceChanges.map((entry) => entry.field))), ["출고가"]);
assert.equal(mh.matchMerchParserAnalysisFilter(newPriceEvent, "supply_new"), true);
assert.equal(mh.matchMerchParserAnalysisFilter(newPriceEvent, "cost_up"), false);
assert.equal(mh.matchMerchParserAnalysisFilter(newPriceEvent, "cost_down"), false);
assert.equal(mh.matchMerchParserAnalysisFilter(newPriceEvent, "cost_recovery"), false);
const supplyEvent = merchAnalysis.events.find((event) => event.log.id === "supply-stopped");
assert.equal(Object.prototype.hasOwnProperty.call(supplyEvent, "diffRate"), false);
assert.equal(mh.findMerchParserPriceHistoryExact(analysisLogs, { code: "A", catalogName: "Cat", timestampISO: t1, field: "출고가" }).id, "price-exact");
assert.equal(mh.findMerchParserPriceHistoryExact(analysisLogs, { code: "A", catalogName: "Cat", timestampISO: t1, field: "시중가" }), null);

const blankCostAnalysis = mh.buildMerchParserListHistoryAnalysis({
  historyLogs: [
    { id: "cost-first-positive", source: "parser", code: "A", catalogName: "Cat", timestampISO: t1, field: "입고가", oldVal: "", newVal: 1000, priceChangeType: "new_price" },
    { id: "blank-price-exact", source: "parser", code: "A", catalogName: "Cat", timestampISO: t1, field: "출고가", oldVal: 5000, newVal: 1100 },
  ],
  activeTags: [{ type: "catalog", name: "Cat" }],
  masterProducts: { A: { 코드: "A", 품목명: "상품A", 출고가: 12000, 판매여부: 1 } },
  parserListMarginRules: { Cat: divide10 },
});
assert.equal(blankCostAnalysis.events.length, 1);
assert.equal(blankCostAnalysis.events[0].kind, "supply");
assert.equal(blankCostAnalysis.events[0].changeType, "new");
assert.equal(blankCostAnalysis.events[0].priceChangeType, "new_price");
assert.equal(blankCostAnalysis.events[0].oldVal, "");
assert.equal(blankCostAnalysis.events[0].newVal, 1000);
assert.equal(blankCostAnalysis.events[0].oldNum, null);
assert.equal(blankCostAnalysis.events[0].diff, null);
assert.equal(blankCostAnalysis.events[0].diffRate, null);
assert.deepEqual(JSON.parse(JSON.stringify(blankCostAnalysis.events[0].priceChanges.map((entry) => entry.field))), ["출고가"]);
assert.equal(blankCostAnalysis.counts.supply_new, 1);
assert.equal(blankCostAnalysis.counts.cost_up, 0);
assert.equal(blankCostAnalysis.counts.cost_down, 0);
assert.equal(blankCostAnalysis.counts.cost_recovery, 0);

const newProductAnalysis = mh.buildMerchParserListHistoryAnalysis({
  historyLogs: newPlan.logs,
  activeTags: [{ type: "catalog", name: "Cat" }],
  masterProducts: newPlan.newMaster,
  parserListMarginRules: { Cat: multiply10 },
});
assert.equal(newProductAnalysis.events.length, 1, "new product supply, tag detail, and new_price logs must render as one 신규 event");
assert.equal(newProductAnalysis.counts.supply_new, 1);
assert.equal(newProductAnalysis.counts.cost_up, 0);
assert.equal(newProductAnalysis.counts.cost_down, 0);
assert.equal(newProductAnalysis.counts.cost_recovery, 0);
const newProductEvent = newProductAnalysis.events[0];
assert.equal(newProductEvent.kind, "supply");
assert.equal(newProductEvent.changeType, "new");
assert.equal(newProductEvent.priceChangeType, "new_price");
assert.equal(newProductEvent.oldVal, "");
assert.equal(newProductEvent.newVal, 1000);
assert.equal(newProductEvent.diff, null);
assert.equal(newProductEvent.diffRate, null);
assert.ok(newProductEvent.priceChanges.some((entry) => entry.field === "출고가" && entry.oldVal === "" && entry.newVal === 1100));

const zeroCostAnalysis = mh.buildMerchParserListHistoryAnalysis({
  historyLogs: zeroToNewPricePlan.logs,
  activeTags: [{ type: "catalog", name: "Cat" }],
  masterProducts: zeroToNewPricePlan.newMaster,
  parserListMarginRules: { Cat: divide10 },
});
assert.equal(zeroCostAnalysis.events.length, 1);
assert.equal(zeroCostAnalysis.events[0].kind, "supply");
assert.equal(zeroCostAnalysis.events[0].changeType, "new");
assert.equal(zeroCostAnalysis.events[0].priceChangeType, "new_price");
assert.equal(zeroCostAnalysis.events[0].oldVal, 0);
assert.equal(zeroCostAnalysis.events[0].newVal, 1000);
assert.equal(zeroCostAnalysis.events[0].diff, null);
assert.equal(zeroCostAnalysis.events[0].diffRate, null);
assert.equal(zeroCostAnalysis.counts.supply_new, 1);
assert.equal(zeroCostAnalysis.counts.cost_up, 0);
assert.equal(zeroCostAnalysis.counts.cost_down, 0);
assert.equal(zeroCostAnalysis.counts.cost_recovery, 0);
[newProductEvent, blankCostAnalysis.events[0], zeroCostAnalysis.events[0]].forEach((event) => {
  assert.equal(mh.matchMerchParserAnalysisFilter(event, "supply_new"), true);
  assert.equal(mh.matchMerchParserAnalysisFilter(event, "cost_up"), false);
  assert.equal(mh.matchMerchParserAnalysisFilter(event, "cost_down"), false);
  assert.equal(mh.matchMerchParserAnalysisFilter(event, "cost_recovery"), false);
});

const makePerformanceCostLogs = (count) => Array.from({ length: count }, (_, index) => ({
  id: `perf-cost-${index}`,
  source: "parser",
  code: "A",
  catalogName: "Cat",
  timestampISO: new Date(Date.UTC(2026, 7, 1) + index).toISOString(),
  field: "입고가",
  oldVal: 100,
  newVal: 101,
}));
const performanceMaster = { A: { 코드: "A", 품목명: "성능상품", 출고가: 150, 판매여부: 1 } };
const performanceTags = [{ type: "catalog", name: "Cat" }];
const noPricePerformanceLogs = makePerformanceCostLogs(2000);
const noPriceStarted = performance.now();
const noPricePerformance = mh.buildMerchParserListHistoryAnalysis({
  historyLogs: noPricePerformanceLogs,
  activeTags: performanceTags,
  masterProducts: performanceMaster,
  parserListMarginRules: {},
});
const noPriceElapsedMs = performance.now() - noPriceStarted;
assert.equal(noPricePerformance.events.length, 2000);
assert.equal(noPricePerformance.metrics.historyIndexVisits, 2000);
assert.equal(noPricePerformance.metrics.historyEventVisits, 2000);
assert.equal(noPricePerformance.metrics.priceHistoryLookups, 8000);
assert.ok(noPricePerformance.events.every((event) => event.priceChanges.length === 0));
assert.ok(noPriceElapsedMs < 5000, `2,000 no-price histories must finish under 5 seconds (actual ${Math.round(noPriceElapsedMs)}ms)`);

const exactPricePerformanceLogs = noPricePerformanceLogs.flatMap((costLog, index) => [
  costLog,
  { id: `perf-price-${index}`, source: "parser", code: "A", catalogName: "Cat", timestampISO: costLog.timestampISO, field: "출고가", oldVal: 120, newVal: 130 },
]);
const exactPriceStarted = performance.now();
const exactPricePerformance = mh.buildMerchParserListHistoryAnalysis({
  historyLogs: exactPricePerformanceLogs,
  activeTags: performanceTags,
  masterProducts: performanceMaster,
  parserListMarginRules: {},
});
const exactPriceElapsedMs = performance.now() - exactPriceStarted;
assert.equal(exactPricePerformance.events.length, 2000);
assert.equal(exactPricePerformance.metrics.historyIndexVisits, 4000);
assert.equal(exactPricePerformance.metrics.historyEventVisits, 4000);
assert.equal(exactPricePerformance.metrics.priceHistoryLookups, 8000);
assert.ok(exactPricePerformance.events.every((event) => event.priceChanges.length === 1 && event.priceChanges[0].field === "출고가"));
assert.ok(exactPriceElapsedMs < 5000, `2,000 exact price joins must finish under 5 seconds (actual ${Math.round(exactPriceElapsedMs)}ms)`);

const parserAnalysisBlock = sliceBetween(merch, "window.buildMerchParserListHistoryAnalysis =", "const formatSignedNumber =", "MerchOps analysis implementation");
assert.match(parserAnalysisBlock, /buildMerchParserPriceHistoryExactIndex\(logs, metrics\)/);
assert.doesNotMatch(parserAnalysisBlock, /findMerchParserPriceHistoryExact\(logs,/);
assert.match(merch, /이전 단가 없음/);
assert.match(merch, /const isNewPriceEvent = event\.priceChangeType === 'new_price'/);
assert.match(merch, /`입고 \$\{formatPreviousCost\(event\.oldVal\)\} → \$\{formatPrice\(event\.newVal\)\}`/);
assert.match(merch, /`차액 - · 변동률 - · \$\{priceEvidence\}`/);

assert.match(historyViewer, /merchHistory_v870/);
assert.match(historyViewer, /oldVal/);
assert.match(historyViewer, /newVal/);
assert.match(historyViewer, /actionType/);
assert.match(smart, /commitMasterStateOrThrow\(data,/);
assert.match(merch, /return exact\[0\] \|\| null/);
assert.match(merch, /Array\.isArray\(data\.historyLogs\)[\s\S]*?isExactParserHistoryLog\(log\)[\s\S]*?normalizeHistoryCatalog\(log\)/);

console.log("ONEAPP parser-list price rules, atomic history, supply events, and exact MerchOps analysis tests passed.");
