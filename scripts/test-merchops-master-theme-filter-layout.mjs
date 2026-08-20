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
const promoEntryAt = lowerRow.indexOf('data-merch-promo-entry": "single"');
const marginAt = lowerRow.indexOf("selectIssueFilter('margin')");
const priceAt = lowerRow.indexOf("selectIssueFilter('priceCheck')");
const noInboundAt = lowerRow.indexOf("selectIssueFilter('noInboundPrice')");
assert.ok(categoryAt >= 0, "category group must be rendered on the lower filter row");
assert.ok(categoryAt < promoEntryAt && promoEntryAt < marginAt && marginAt < priceAt && priceAt < noInboundAt,
  "lower row order must be category, single promotion entry, margin, price change, and no inbound price");
const promoEntryEnd = lowerRow.indexOf('data-merch-issue-filter-group": "single"', promoEntryAt);
const promoEntry = lowerRow.slice(promoEntryAt, promoEntryEnd);
assert.match(promoEntry, /togglePromoWorkbenchManual[\s\S]*"행사작업"/,
  "the upper promotion area must contain one 행사작업 entry button");
assert.doesNotMatch(promoEntry, /handleAllThemeClick|promo-work-theme-|테마전체|테마없음|테마지정|테마삭제/,
  "theme controls must not remain beside the upper 행사작업 entry");
assert.match(toolbar, /isDetailFilterActive[\s\S]*!isThemeFilterValue\(v\)[\s\S]*!\['margin', 'noInboundPrice'\]\.includes\(v\)/,
  "fixed theme, margin, and no-inbound filters must not force the detail panel open");
assert.doesNotMatch(toolbar, /showDetailFilterPanel\s*=\s*[^;]*isCategoryFilterActive/,
  "fixed category filters must not force the detail panel open");

const allThemeHandler = toolbar.slice(toolbar.indexOf("const handleAllThemeClick ="), toolbar.indexOf("const toggleThemeFilter ="));
assert.match(allThemeHandler, /filter\(v => !isThemeFilterValue\(v\)\)/, "테마전체 must preserve non-theme filters");
assert.match(allThemeHandler, /return \[\.\.\.nonTheme, \.\.\.allThemeFilters\]/,
  "테마전체 must select only the five named theme filters");
assert.doesNotMatch(allThemeHandler, /setPriceFilter|setCategoryFilters|setGlobalSearch/,
  "테마전체 must preserve every non-theme filter");
assert.match(toolbar, /const isAllThemeFilterActive = allThemeFilters\.every[\s\S]*!activeThemeFilters\.includes\('themeNone'\)/,
  "테마전체 must be active for all five named themes and exclude 테마없음");

const promoWorkbenchStart = lowerRow.indexOf('data-merch-promo-workbench": "manual-open"');
const detailPanelStart = lowerRow.indexOf("showDetailFilterPanel &&");
assert.ok(promoWorkbenchStart >= 0 && detailPanelStart > promoWorkbenchStart, "promotion workbench/detail panel boundaries must exist");
const promoWorkbench = lowerRow.slice(promoWorkbenchStart, detailPanelStart);
const themeGroupAt = promoWorkbench.indexOf('data-merch-promo-theme-group": "exposure"');
const priceGroupAt = promoWorkbench.indexOf('data-merch-promo-price-group": "price"');
assert.ok(themeGroupAt >= 0 && priceGroupAt > themeGroupAt,
  "theme exposure controls must be grouped on the left and promo-price controls on the right");
assert.match(promoWorkbench, /"테마 노출위치"[\s\S]*"테마전체"[\s\S]*\['theme1', '테마1'\][\s\S]*\['theme5', '테마5'\][\s\S]*\['themeNone', '테마없음'\][\s\S]*"테마지정"[\s\S]*"테마삭제"/,
  "theme exposure group must expose the exact requested terminology and assignment/deletion actions");
assert.match(promoWorkbench, /"행사가 설정"[\s\S]*\['promo', '행사가상품'\][\s\S]*\['promoExclude', '행사가없음'\][\s\S]*"행사가 생성"[\s\S]*"행사가초기화"[\s\S]*"전행사가적용"[\s\S]*"행사가 비교"/,
  "promo-price group must expose the exact requested terminology");
assert.doesNotMatch(promoWorkbench, /promoSuggest|'행사제안'|'행사상품'|'행사제외'/,
  "promotion workbench must remove the former suggestion and legacy labels");
assert.match(promoWorkbench, /promo-work-theme-[\s\S]*beginThemeDrag[\s\S]*handleThemeClick/,
  "promotion workbench must own the relocated theme filters");
assert.match(toolbar, /promoWorkbenchManualOpen[\s\S]*togglePromoWorkbenchManual[\s\S]*"행사작업"/,
  "the promotion workbench may be opened explicitly without changing the theme filter");
assert.match(toolbar, /const isPromoWorkbenchVisible = promoWorkbenchManualOpen;/,
  "the promotion workbench must be controlled only by the single 행사작업 entry");
assert.doesNotMatch(toolbar, /const isPromoThemeSelected|isPromoWorkbenchVisible = isPromoThemeSelected/,
  "theme selection must not implicitly open the workbench");
const toggleWorkbench = toolbar.slice(toolbar.indexOf("const togglePromoWorkbenchManual ="), toolbar.indexOf("const isDetailFilterActive ="));
assert.doesNotMatch(toggleWorkbench, /setPriceFilter|setDetailFilters/,
  "closing 행사작업 must preserve the user's event filters and queued working values");
assert.match(toolbar, /handleApplyBulkFields\(\{ themeAction: 'assign', theme: promoThemeInput \}\)[\s\S]*handleApplyBulkFields\(\{ themeAction: 'delete' \}\)/,
  "theme designation and deletion must use the persisted bulk-work path");
const promoResetStart = html.indexOf("const handleResetPromoValues = useCallback");
const promoResetEnd = html.indexOf("// [M-BRIDGE-01]", promoResetStart);
const promoResetSource = html.slice(promoResetStart, promoResetEnd);
assert.match(promoResetSource, /행사가: 0[\s\S]*행사테마\/테마1~5: 기존 값 유지[\s\S]*_promoPriceResetRequested: true/,
  "행사가초기화 must reset only the promo price and preserve theme exposure");
assert.doesNotMatch(promoResetSource, /행사테마:\s*''|테마1:\s*''|_promoResetRequested:\s*true/,
  "the price-reset action must not delete theme values or use the legacy combined reset marker");
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
assert.doesNotMatch(detailOptions, /\['margin', '역마진'\]/,
  "detail panel must not duplicate the fixed margin filter");
assert.match(detailOptions, /isPriceCheckActive[\s\S]*data-merch-price-direction": "single-choice"[\s\S]*'priceRise', '상승만보기'[\s\S]*'priceFall', '하락만보기'/,
  "price change must dynamically expose mutually-exclusive rise/fall controls in the detail panel");
assert.match(detailOptions, /isNoInboundPriceActive[\s\S]*data-merch-no-inbound-action": "touch-choice"[\s\S]*'싯가판매'[\s\S]*'판매정지'/,
  "no inbound price must expose the existing F7 reservation controls in the detail panel");
assert.match(toolbar, /const showDetailFilterPanel = filterPanelOpen \|\| isDetailFilterActive \|\| isPriceCheckActive \|\| isNoInboundPriceActive/,
  "active price-change and no-inbound filters must open the detail panel for their dynamic controls");
assert.match(toolbar, /if \(\['priceRise', 'priceFall'\]\.includes\(value\)\) return 'priceDirection';/,
  "rise and fall must be a single-choice detail-filter group");
assert.match(toolbar, /\['status', 'priceDirection'\]\.includes\(group\)[\s\S]*current\.filter\(v => getDetailFilterGroup\(v\) !== group\)/,
  "selecting a rise/fall direction must clear the other direction");
assert.match(toolbar, /priceFilter !== 'priceCheck'[\s\S]*filter\(value => !\['priceRise', 'priceFall'\]\.includes\(value\)\)/,
  "clearing price change must clear the hidden rise/fall filters too");

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
assert.match(compositeSource, /getMerchPriceCheckDirection[\s\S]*priceRise[\s\S]*direction !== 'rise'[\s\S]*priceFall[\s\S]*direction !== 'fall'/,
  "rise/fall detail filters must use the common price-check comparison direction");
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
assert.equal(filterContext.window.MERCH_DETAIL_FILTER_VALUES.includes("priceRise"), true,
  "상승만보기 must be an allowed dynamic detail filter");
assert.equal(filterContext.window.MERCH_DETAIL_FILTER_VALUES.includes("priceFall"), true,
  "하락만보기 must be an allowed dynamic detail filter");
assert.deepEqual(
  JSON.parse(JSON.stringify(filterContext.window.normalizeMerchFilterPreset({ priceFilter: "promoSuggest", detailFilters: ["basic", "basicExclude", "themeNone"] }))),
  { priceFilter: "all", categoryFilters: [], detailFilters: ["themeNone"] },
  "legacy removed filters must be ignored while the new 없음 filter remains valid",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(filterContext.window.normalizeMerchFilterPreset({ priceFilter: "all", detailFilters: ["theme1", "margin", "noInboundPrice"] }))),
  { priceFilter: "all", categoryFilters: [], detailFilters: ["theme1", "noInboundPrice"] },
  "saved presets must retain only the last issue-detail filter",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(filterContext.window.normalizeMerchFilterPreset({ priceFilter: "priceCheck", detailFilters: ["margin", "noInboundPrice"] }))),
  { priceFilter: "priceCheck", categoryFilters: [], detailFilters: [] },
  "price change must take precedence over issue-detail filters in saved presets",
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

assert.match(toolbar, /data-merch-issue-filter-group": "single"/, "the three issue filters must be rendered as one single-select group");
assert.match(toolbar, /const selectIssueFilter = \(value\) =>[\s\S]*withoutIssueFilters[\s\S]*value === 'priceCheck'/,
  "selecting one issue filter must clear the other issue filters");
assert.match(toolbar, /data-merch-no-inbound-action": "touch-choice"[\s\S]*\['spot', '싯가판매'\][\s\S]*\['stop', '판매정지'\]/,
  "the no-inbound action touch choices must be adjacent and conditionally visible");

const versionMatches = [...html.matchAll(/v2\.1\.194_PromoWorkspaceGroups/g)];
assert.ok(versionMatches.length >= 3, "all MerchOps version labels must use v2.1.194");

console.log("MerchOps theme-none, promo-price, and fixed-layout contracts passed.");
