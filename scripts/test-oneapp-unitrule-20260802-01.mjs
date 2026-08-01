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

parseInlineScripts(smart, "SmartParser");
parseInlineScripts(settings, "settings");
parseInlineScripts(merch, "MerchOps");

const engineStart = smart.indexOf("const calculatePricesEngine =");
const engineReturn = smart.indexOf("            return newFinalData;", engineStart);
const engineEnd = smart.indexOf("        };", engineReturn) + "        };".length;
assert.ok(engineStart >= 0 && engineReturn > engineStart && engineEnd > engineReturn);
const engineSource = smart.slice(engineStart, engineEnd);
const helperSource = sliceBetween(smart, "const PARSER_LIST_MARGIN_RULES_KEY =", "const cleanupSmartParserStorage =", "SmartParser helpers");
const context = vm.createContext({ console, Date, Object, Array, String, Number, Math, Set, Map, JSON });
vm.runInContext([
  "const parseNum = (v) => (!v ? 0 : Number(String(v).replace(/,/g, '').replace(/[^\\d.-]/g, '')) || 0);",
  "const calcDiffRate = (oldVal, newVal) => { const oldNum = parseNum(oldVal); const newNum = parseNum(newVal); return oldNum ? Math.round(((newNum - oldNum) / oldNum) * 1000) / 10 : null; };",
  "let idCounter = 0; const generateUUID = () => 'unitrule-' + (++idCounter);",
  "const normalizeText = (v) => String(v || '').replace(/\\s+/g, '').toLowerCase();",
  "const addTag = (oldTags, newTag) => { const tags = String(oldTags || '').split(',').map(v => v.trim()).filter(Boolean); if (newTag && !tags.includes(newTag)) tags.push(newTag); return tags.join(', '); };",
  "const removeTag = (oldTags, tag) => String(oldTags || '').split(',').map(v => v.trim()).filter(v => v && v !== tag).join(', ');",
  engineSource,
  helperSource,
  "globalThis.h = { normalizeParserListMarginRules, getParserListMarginRuleSet, resolveParserListMarginRule, validateParserCatalogRuleSet, getParserCatalogRuleMatch, calculateParserCatalogPrices, buildSmartParserApplyPlan };",
].join("\n"), context);
const h = context.h;
const iso = "2026-08-02T01:02:03.456Z";

const legacyRaw = { Legacy: { marginRate: 10, calculationType: "divide", updatedAt: iso } };
const legacyNormalized = JSON.parse(JSON.stringify(h.normalizeParserListMarginRules(legacyRaw)));
assert.deepEqual(legacyNormalized, {
  Legacy: { rules: [{ unitCondition: "*", marginRate: 10, calculationType: "divide", updatedAt: iso }] },
});
assert.equal(h.resolveParserListMarginRule(legacyNormalized, "Legacy", "BOX").marginRate, 10);

const rawRules = {
  Cat: {
    rules: [
      { unitCondition: "BOX, 박스", marginRate: 10, calculationType: "divide", updatedAt: iso },
      { unitCondition: "ea, 개", marginRate: 15, calculationType: "multiply", updatedAt: iso },
      { unitCondition: "*", marginRate: 20, calculationType: "divide", updatedAt: iso },
    ],
  },
  Strict: {
    rules: [{ unitCondition: "BOX, 박스", marginRate: 10, calculationType: "divide", updatedAt: iso }],
  },
};
const normalizedRules = h.normalizeParserListMarginRules(rawRules);
assert.equal(h.resolveParserListMarginRule(normalizedRules, "Cat", " box ").marginRate, 10);
assert.equal(h.resolveParserListMarginRule(normalizedRules, "Cat", "박스").marginRate, 10);
assert.equal(h.resolveParserListMarginRule(normalizedRules, "Cat", "EA").marginRate, 15);
assert.equal(h.resolveParserListMarginRule(normalizedRules, "Cat", "병").marginRate, 20);
assert.equal(h.resolveParserListMarginRule(normalizedRules, "Strict", "병"), null);
assert.equal(h.getParserCatalogRuleMatch(normalizedRules, "Strict", "병").status, "unit_unmatched");
assert.equal(h.getParserCatalogRuleMatch(normalizedRules, "Missing", "BOX").status, "no_rule");
assert.match(h.validateParserCatalogRuleSet("Cat", [
  { unitCondition: "BOX", marginRate: 10, calculationType: "divide" },
  { unitCondition: "박스", marginRate: 20, calculationType: "divide" },
]), /중복/);
assert.match(h.validateParserCatalogRuleSet("Cat", [
  { unitCondition: "*", marginRate: 10, calculationType: "divide" },
  { unitCondition: "*", marginRate: 20, calculationType: "divide" },
]), /하나만/);
assert.match(h.validateParserCatalogRuleSet("Cat", [{ unitCondition: "EA", marginRate: 100, calculationType: "divide" }]), /100%/);

assert.equal(h.calculateParserCatalogPrices(10000, {}, { 단위: "BOX" }, h.resolveParserListMarginRule(normalizedRules, "Cat", "BOX"))["출고가"], 11100);
assert.equal(h.calculateParserCatalogPrices(10000, {}, { 단위: "병" }, h.resolveParserListMarginRule(normalizedRules, "Cat", "병"))["출고가"], 12500);
assert.equal(h.calculateParserCatalogPrices(1000, {}, { 단위: "ea" }, h.resolveParserListMarginRule(normalizedRules, "Cat", "ea"))["출고가"], 1200);

const plan = h.buildSmartParserApplyPlan({
  masterProducts: {
    A: { 코드: "A", 품목명: "기존A", 규격: "구규격", 단위: "BOX", 입고가: 9000, 출고가: 10000, 시중가: 10000, 카탈로그: "Old", 판매여부: 1 },
    B: { 코드: "B", 품목명: "기존B", 규격: "구규격", 단위: "병", 입고가: 900, 출고가: 2000, 시중가: 2000, 카탈로그: "Old", 판매여부: 1 },
  },
  rows: [
    { _matchCode: "A", _hasParsedInPrice: true, 품목명: "새A", 규격: "새규격", 단위: "박스", finalData: { 입고가: 10000 } },
    { _matchCode: "B", _hasParsedInPrice: true, 품목명: "새B", 규격: "", 단위: "병", finalData: { 입고가: 1000 } },
  ],
  catalogLabel: "Strict",
  catalogRule: h.getParserListMarginRuleSet(normalizedRules, "Strict"),
  timestampISO: iso,
  timestampLabel: "now",
  updateTextData: true,
  allowExistingInfoChanges: true,
});
assert.equal(plan.newMaster.A["출고가"], 11100);
assert.equal(plan.newMaster.B["출고가"], 2000, "unit mismatch preserves existing sale price");
assert.equal(plan.newMaster.B["입고가"], 1000, "unit mismatch still applies inbound price");
assert.equal(plan.newMaster.B["카탈로그"], "Old, Strict", "unit mismatch still applies catalog tag");
assert.equal(plan.newMaster.B["품목명"], "새B", "unit mismatch still applies allowed text");
assert.equal(plan.newMaster.B["규격"], "구규격", "blank parsed text preserves master value");
assert.equal(plan.priceRuleMatchedCount, 1);
assert.equal(plan.priceRuleUnmatchedCount, 1);
const exactPriceLog = plan.logs.find((log) => log.code === "A" && log.field === "출고가");
assert.deepEqual(JSON.parse(JSON.stringify(exactPriceLog.priceRule)), {
  unitCondition: "BOX, 박스", marginRate: 10, calculationType: "divide", updatedAt: iso,
});
assert.equal(plan.newMaster.A["판매여부"], 1);
assert.equal(plan.newMaster.B["판매여부"], 1);

const textMaster = { T: { 코드: "T", 품목명: "원품명", 규격: "원규격", 단위: "EA", 카탈로그: "Cat", 입고가: 1000, 출고가: 1200 } };
const textBase = { masterProducts: textMaster, catalogLabel: "Cat", catalogRule: null, timestampISO: iso, timestampLabel: "now", allowExistingInfoChanges: true };
const textOn = h.buildSmartParserApplyPlan({
  ...textBase,
  rows: [{ _matchCode: "T", _hasParsedInPrice: false, 품목명: "새품명", 규격: "새규격", 단위: "BOX", finalData: {} }],
  updateTextData: true,
});
assert.equal(textOn.newMaster.T["품목명"], "새품명");
assert.equal(textOn.newMaster.T["규격"], "새규격");
assert.equal(textOn.newMaster.T["단위"], "BOX");
assert.equal(textOn.logs.filter((log) => log.actionType === "정보변경").length, 3);
assert.equal(textOn.newMaster.T["출고가"], 1200, "no-rule text apply does not alter sale price");

const textOff = h.buildSmartParserApplyPlan({
  ...textBase,
  rows: [{ _matchCode: "T", _hasParsedInPrice: false, 품목명: "새품명", 규격: "새규격", 단위: "BOX", finalData: {} }],
  updateTextData: false,
});
assert.equal(textOff.newMaster.T["품목명"], "원품명");
assert.equal(textOff.newMaster.T["규격"], "원규격");
assert.equal(textOff.newMaster.T["단위"], "EA");

const manualText = h.buildSmartParserApplyPlan({
  ...textBase,
  rows: [{ _matchCode: "T", _hasParsedInPrice: false, 품목명: "파싱품명", 규격: "", 단위: "EA", finalData: {}, _editedTextFields: { 품목명: "수동품명" } }],
  updateTextData: false,
});
assert.equal(manualText.newMaster.T["품목명"], "수동품명");
assert.equal(manualText.newMaster.T["규격"], "원규격");

const newUnmatched = h.buildSmartParserApplyPlan({
  masterProducts: {},
  rows: [{ _matchCode: "N", _hasParsedInPrice: true, 품목명: "신규", 규격: "1병", 단위: "병", finalData: { 입고가: 500 } }],
  catalogLabel: "Strict",
  catalogRule: h.getParserListMarginRuleSet(normalizedRules, "Strict"),
  timestampISO: iso,
  timestampLabel: "now",
});
assert.equal(newUnmatched.newMaster.N["입고가"], 500);
assert.equal(newUnmatched.newMaster.N["출고가"], undefined);
assert.equal(newUnmatched.newMaster.N["품목명"], "신규");
assert.equal(newUnmatched.newMaster.N["카탈로그"], "Strict");

const applyBlock = sliceBetween(smart, "const handleApplyMatched =", "const handleConfirmMapping =", "apply handler");
assert.match(applyBlock, /allowExistingInfoChanges: true/);
assert.doesNotMatch(applyBlock, /allowExistingInfoChanges: !!catalogRule/);
assert.match(applyBlock, /단위 미일치/);
const editBlock = sliceBetween(smart, "const handleUpdateMatchedText =", "const safeGoToMain =", "matched text edit");
assert.match(editBlock, /fieldName === '단위'/);
assert.match(editBlock, /getParserCatalogRuleMatch/);
assert.match(editBlock, /calculateParserCatalogPrices/);
assert.match(smart, /data-parser-review-scroll": "price"/);
assert.match(smart, /data-parser-review-scroll": "mapping"/);
assert.match(smart, /h-\[85vh\].*min-h-0/);
assert.match(smart, /flex-1 min-h-0 overflow-auto overscroll-contain/);
assert.match(smart, /document\.body\.style\.overflow = 'hidden'/);
assert.match(smart, /@media \(max-height: 650px\).*parser-review-insight \{ height: 36px/s);
assert.doesNotMatch(smart, /parser-review-insight, \.parser-review-price-cards \{ display: none/);

const settingsHelpers = sliceBetween(settings, "const PARSER_LIST_MARGIN_RULES_KEY =", "const TABLE_VIEW_TARGETS =", "settings helpers");
const settingsContext = vm.createContext({ Date, Object, Array, String, Number, Set });
vm.runInContext(settingsHelpers + "\nglobalThis.h = { normalizeParserListMarginRules, validateParserCatalogRuleSet };", settingsContext);
assert.deepEqual(JSON.parse(JSON.stringify(settingsContext.h.normalizeParserListMarginRules(legacyRaw))), legacyNormalized);
assert.match(settings, /parserListRulesLoadedRef\.current/);
const parserSaveEffect = sliceBetween(settings, "useEffect(() => {\n        if (!parserListRulesLoadedRef.current)", "useEffect(() => {\n        if (cloudUrl)", "explicit parser rule save effect");
assert.ok(parserSaveEffect.indexOf("return;") < parserSaveEffect.indexOf("localStorage.setItem(PARSER_LIST_MARGIN_RULES_KEY"));
assert.match(settings, /단위조건 \(콤마 별칭 \/ 전체 \*\)/);

const merchHelpers = sliceBetween(merch, "window.PARSER_LIST_MARGIN_RULES_KEY =", "const TABLE_VIEW_TARGETS =", "MerchOps parser helpers");
const merchWindow = {
  getMerchUnitRuleCandidates(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw || raw === "*") return raw === "*" ? ["*"] : [];
    const candidates = [];
    const push = (valueToPush) => { if (valueToPush && !candidates.includes(valueToPush)) candidates.push(valueToPush); };
    [raw.replace(/\s/g, ""), ...raw.split(/[,./|\s()_\-]+/)].forEach((part) => {
      const normalized = String(part || "").toLowerCase().replace(/\s/g, "");
      if (!normalized) return;
      if (/box|박스|상자|bx/.test(normalized)) push("box");
      if (/소분|분할|절단|컷|소포장|묶음/.test(normalized)) push("sub");
      if (/ea|each|개|낱개|낱|kg|킬로|단|봉|포/.test(normalized)) push("ea");
      push(normalized);
    });
    return candidates;
  },
};
const merchContext = vm.createContext({ window: merchWindow, Date, Object, Array, String, Number, Set });
vm.runInContext(merchHelpers, merchContext);
assert.deepEqual(JSON.parse(JSON.stringify(merchWindow.normalizeParserListMarginRules(legacyRaw))), legacyNormalized);
assert.equal(merchWindow.resolveParserListMarginRule(rawRules, "Cat", "박스").marginRate, 10);
assert.equal(merchWindow.resolveParserListMarginRule(rawRules, "Strict", "병"), null);
assert.match(merch, /rule\.unitCondition \|\| '\*'/);

const commitSource = sliceBetween(smart, "let smartParserMasterRevision = undefined", "const useParserApp =", "SmartParser commit helper");
const storageValues = new Map([["merchHistory_v870", JSON.stringify([{ id: "before" }])]]);
const localStorage = {
  getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
  setItem(key, value) { storageValues.set(key, String(value)); },
  removeItem(key) { storageValues.delete(key); },
};
let committedMaster = { T: { 코드: "T", 품목명: "원품명" } };
const rollbackWindow = {
  ONEAPP: { STORAGE: { async commitMasterStateOrThrow(data, options) {
    const before = structuredClone(committedMaster);
    committedMaster = structuredClone(data);
    try { if (options.afterVerified) options.afterVerified(); }
    catch (error) { committedMaster = before; throw error; }
    return { revision: "unexpected" };
  } } },
};
const rollbackContext = vm.createContext({
  window: rollbackWindow, localStorage, Date, Array, String, Error, console,
  saveMerchHistoryWithRetry(logs) {
    localStorage.setItem("merchHistory_v870", JSON.stringify(logs));
    throw new Error("forced history failure");
  },
});
vm.runInContext(commitSource + "\nglobalThis.commit = commitSmartParserMaster;", rollbackContext);
await assert.rejects(rollbackContext.commit({ T: { 코드: "T", 품목명: "변경" } }, {}, [{ id: "after" }]), /forced history failure/);
assert.deepEqual(committedMaster, { T: { 코드: "T", 품목명: "원품명" } });
assert.deepEqual(JSON.parse(localStorage.getItem("merchHistory_v870")), [{ id: "before" }]);

assert.doesNotMatch(smart, /merchMarginRules_v878/);
assert.doesNotMatch(smart, /\['판매여부'\]\s*=(?!=)/);
assert.doesNotMatch(settingsHelpers, /merchMarginRules_v878/);

console.log("PASS test-oneapp-unitrule-20260802-01");
