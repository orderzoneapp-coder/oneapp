import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");

const toolbarStart = html.indexOf("const MainToolbar = React.memo");
const filterHelperStart = html.indexOf("const getPromotionThemeCodesForFilter =");
assert.ok(toolbarStart >= 0 && filterHelperStart > toolbarStart, "MerchOps toolbar/filter helper boundaries must exist");

const toolbar = html.slice(toolbarStart, filterHelperStart);
const topRowStart = toolbar.indexOf('className: "px-5 py-2 bg-slate-50');
const lowerRowStart = toolbar.indexOf('className: "px-6 pt-3 pb-2');
assert.ok(topRowStart >= 0 && lowerRowStart > topRowStart, "top and lower toolbar rows must exist");

const topRow = toolbar.slice(topRowStart, lowerRowStart);
const lowerRow = toolbar.slice(lowerRowStart);
assert.doesNotMatch(topRow, /cat-main-|handleAllCategoryClick/, "category group must be removed from the top row");
assert.match(topRow, /data-merch-toolbar-group": "parser-catalog"[\s\S]*data-merch-toolbar-group": "excel"[\s\S]*data-merch-toolbar-group": "operations"/,
  "top row must contain the three independent parser/catalog, Excel, and operation groups");
assert.doesNotMatch(topRow, /justify-around/, "buttons inside each top group must remain clustered rather than spread apart");

const categoryAt = lowerRow.indexOf('title: "카테고리: 클릭 단일선택');
const themeAt = lowerRow.indexOf('title: "마스터 행사테마: 클릭 단일선택');
const marginAt = lowerRow.indexOf("toggleDetailFilter('margin')");
const priceAt = lowerRow.indexOf("applyPriceFilter('priceCheck')");
const noInboundAt = lowerRow.indexOf("toggleDetailFilter('noInboundPrice')");
assert.ok(categoryAt >= 0, "category group must be rendered on the lower filter row");
assert.ok(categoryAt < themeAt && themeAt < marginAt && marginAt < priceAt && priceAt < noInboundAt,
  "lower row order must be category, theme, margin, price change, and no inbound price");
assert.match(lowerRow, /handleAllThemeClick[\s\S]*\['theme1', '테마1'\][\s\S]*\['theme5', '테마5'\][\s\S]*\['themeNone', '없음'\]/,
  "theme group must render 행사, 테마1~테마5, and 없음");
assert.match(lowerRow, /handleAllThemeClick[\s\S]*"행사"/,
  "the all-theme control must be named 행사");
assert.match(toolbar, /isDetailFilterActive[\s\S]*!isThemeFilterValue\(v\)[\s\S]*!\['margin', 'noInboundPrice'\]\.includes\(v\)/,
  "fixed theme, margin, and no-inbound filters must not force the detail panel open");
assert.doesNotMatch(toolbar, /showDetailFilterPanel\s*=\s*[^;]*isCategoryFilterActive/,
  "fixed category filters must not force the detail panel open");

const allThemeHandler = toolbar.slice(toolbar.indexOf("const handleAllThemeClick ="), toolbar.indexOf("const toggleThemeFilter ="));
assert.match(allThemeHandler, /filter\(v => !isThemeFilterValue\(v\)\)/, "행사 must preserve non-theme filters");
assert.match(allThemeHandler, /return \[\.\.\.nonTheme, \.\.\.allThemeFilters\]/,
  "행사 must select only the five named theme filters");
assert.doesNotMatch(allThemeHandler, /setPriceFilter|setCategoryFilters|setGlobalSearch/,
  "행사 must preserve every non-theme filter");
assert.match(toolbar, /const isAllThemeFilterActive = allThemeFilters\.every[\s\S]*!activeThemeFilters\.includes\('themeNone'\)/,
  "행사 must be active for all five named themes and exclude 없음");

const promoWorkbenchStart = lowerRow.indexOf('title: "현재 마스터/카탈로그 작업범위를 그대로 사용하는 행사 전용 작업대"');
const detailPanelStart = lowerRow.indexOf("showDetailFilterPanel &&");
assert.ok(promoWorkbenchStart >= 0 && detailPanelStart > promoWorkbenchStart, "promotion workbench/detail panel boundaries must exist");
const promoWorkbench = lowerRow.slice(promoWorkbenchStart, detailPanelStart);
assert.match(promoWorkbench, /\['promo', '행사가'\][\s\S]*\['promoExclude', '행사가없음'\]/,
  "promotion workbench must expose 행사가 and 행사가없음");
assert.doesNotMatch(promoWorkbench, /promoSuggest|'행사제안'|'행사상품'|'행사제외'/,
  "promotion workbench must remove the former suggestion and legacy labels");
assert.doesNotMatch(promoWorkbench, /promo-work-theme-|beginThemeDrag|handleThemeClick/,
  "promotion workbench must not duplicate the fixed theme group");
assert.doesNotMatch(toolbar, /promoWorkbenchOpen|togglePromoWorkbench|"행사작업"/,
  "the promotion workbench must stay visible without a separate toggle button");
assert.match(lowerRow, /React\.createElement\("div", \{ className: `rounded-xl border px-3 py-2[\s\S]*"행사 작업대"/,
  "the promotion workbench must render unconditionally");
assert.doesNotMatch(toolbar, /basic-pill-|toggleDetailFilter\('basic'\)|toggleDetailFilter\('basicExclude'\)/,
  "basic-product controls must be removed from MerchOps");

assert.match(topRow, /getLoadButtonClass\(isExcelWorktableLoaded, 'emerald'\)/,
  "Excel must stay neutral until an Excel worktable is loaded");
assert.match(topRow, /hasResettableWorkSession \? 'text-white bg-rose-600[\s\S]*: 'bg-white text-slate-500/,
  "main reset must use a neutral initial style and a strong loaded-work style");
assert.match(lowerRow, /isAllCategoryActive \? 'bg-blue-600[\s\S]*: 'bg-white text-blue-700/,
  "category 전체 must become strong only when the full product view is active");

const detailOptionsEnd = lowerRow.indexOf("!registrationMode", detailPanelStart);
const detailOptions = lowerRow.slice(detailPanelStart, detailOptionsEnd);
assert.doesNotMatch(detailOptions, /noInboundPrice|\['margin', '역마진'\]/,
  "detail panel must not duplicate the fixed margin and no-inbound filters");

const compositeStart = html.indexOf("const matchCompositeDetailFilters =", filterHelperStart);
assert.ok(compositeStart > filterHelperStart, "composite filter helper must exist");
const themeHelperSource = html.slice(filterHelperStart, compositeStart);
assert.doesNotMatch(themeHelperSource, /row\.finalData|row\.sources|resolvePromotionThemeState/,
  "theme filter helper must not read worktable or upload-source theme values");
assert.match(themeHelperSource, /normalizePromotionThemeValue\(mItem \|\| \{\}\)/,
  "theme filter helper must normalize the master item only");

const themeContext = {
  window: {
    normalizePromotionThemeValue(item = {}) {
      return String(item['행사테마'] || '');
    },
  },
};
vm.createContext(themeContext);
vm.runInContext(`${themeHelperSource}\nthis.getPromotionThemeCodesForFilterUnderTest = getPromotionThemeCodesForFilter;\nthis.matchPromotionThemeFilterUnderTest = matchPromotionThemeFilter;`, themeContext);
assert.deepEqual(
  [...themeContext.getPromotionThemeCodesForFilterUnderTest(
    { finalData: { 행사테마: "1" }, sources: { purchase: { 행사테마: "2" } } },
    { 행사테마: "3,5" },
  )],
  ["3", "5"],
  "master theme must win even when worktable and source values disagree",
);
assert.equal(themeContext.matchPromotionThemeFilterUnderTest({}, { 행사테마: "" }, "themeNone"), true,
  "없음 must include a master product without a theme");
assert.equal(themeContext.matchPromotionThemeFilterUnderTest({}, { 행사테마: "2" }, "themeNone"), false,
  "없음 must exclude a master product with a theme");

const compositeEnd = html.indexOf("const resolveWorkingPromoPrice =", compositeStart);
const compositeSource = html.slice(compositeStart, compositeEnd);
assert.match(compositeSource, /themeFilters\.some\(v => matchPromotionThemeFilter/,
  "multiple theme selections must keep OR behavior");
assert.match(compositeSource, /\^theme\(\?:\[1-5\]\|None\)\$/,
  "the composite matcher must include the 없음 filter");
assert.doesNotMatch(compositeSource, /basicSearch|has\('basic'\)|has\('basicExclude'\)|matchBasicFilter/,
  "basic-product filter matching must be removed");

const filterConstantsStart = html.indexOf("window.MERCH_PRICE_FILTER_VALUES =");
const filterConstantsEnd = html.indexOf("// [M-MGMT-CODE-01]", filterConstantsStart);
const normalizePresetStart = html.indexOf("window.normalizeMerchFilterPreset =");
const normalizePresetEnd = html.indexOf("window.isMerchFilterPresetEmpty =", normalizePresetStart);
const filterContext = { window: {} };
vm.createContext(filterContext);
vm.runInContext(`${html.slice(filterConstantsStart, filterConstantsEnd)}\n${html.slice(normalizePresetStart, normalizePresetEnd)}`, filterContext);
assert.equal(filterContext.window.MERCH_PRICE_FILTER_VALUES.includes("promoSuggest"), false,
  "행사제안 must be removed from allowed price filters");
assert.equal(filterContext.window.MERCH_DETAIL_FILTER_VALUES.includes("basic"), false,
  "기본상품 must be removed from allowed detail filters");
assert.equal(filterContext.window.MERCH_DETAIL_FILTER_VALUES.includes("basicExclude"), false,
  "기본제외 must be removed from allowed detail filters");
assert.equal(filterContext.window.MERCH_DETAIL_FILTER_VALUES.includes("themeNone"), true,
  "없음 must be an allowed detail filter");
assert.deepEqual(
  JSON.parse(JSON.stringify(filterContext.window.normalizeMerchFilterPreset({ priceFilter: "promoSuggest", detailFilters: ["basic", "basicExclude", "themeNone"] }))),
  { priceFilter: "all", categoryFilters: [], detailFilters: ["themeNone"] },
  "legacy removed filters must be ignored while the new 없음 filter remains valid",
);

const promoResolverStart = html.indexOf("const resolveWorkingPromoPrice =");
const promoResolverEnd = html.indexOf("const isSellingItem =", promoResolverStart);
const promoContext = {
  window: {
    parseNum(value) {
      const parsed = Number(String(value ?? '').replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : 0;
    },
    MERCH_CURRENT_SOURCE_ROLES: ['inventory', 'estimate', 'purchase', 'sales', 'info', 'catalog', 'parser'],
  },
  getMasterPromoPrice(item = {}) {
    const parsed = Number(item['행사가']);
    return Number.isFinite(parsed) ? parsed : 0;
  },
};
vm.createContext(promoContext);
vm.runInContext(`${html.slice(promoResolverStart, promoResolverEnd)}\nthis.isPromoActiveUnderTest = isPromoActive;`, promoContext);
assert.equal(promoContext.isPromoActiveUnderTest({ finalData: { 행사가: 1200 } }, { 행사가: 0 }), true,
  "행사가는 a positive current working promo price");
assert.equal(promoContext.isPromoActiveUnderTest({ finalData: { 행사가: 0 } }, { 행사가: 1200 }), false,
  "행사가없음 includes an explicit current zero even when the master previously had a promo price");
assert.equal(promoContext.isPromoActiveUnderTest({}, { 행사가: 1200 }), true,
  "행사가는 the master promo price when no current working value overrides it");
assert.equal(promoContext.isPromoActiveUnderTest({}, { 행사가: '' }), false,
  "행사가없음 includes a blank effective promo price");
assert.match(html, /if \(ui\.priceFilter === 'promo'\)[\s\S]*return isPromoActive\(item, mItem\)[\s\S]*if \(ui\.priceFilter === 'promoExclude'\)[\s\S]*return !isPromoActive\(item, mItem\)/,
  "visible row filtering must split positive and missing promo prices without overlap");

const versionMatches = [...html.matchAll(/v2\.1\.188_ThemeAndPromoFilters/g)];
assert.ok(versionMatches.length >= 3, "all MerchOps version labels must use v2.1.188");

console.log("MerchOps theme-none, promo-price, and fixed-layout contracts passed.");
