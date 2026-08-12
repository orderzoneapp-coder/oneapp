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
assert.match(lowerRow, /handleAllThemeClick[\s\S]*\['theme1', '테마1'\][\s\S]*\['theme5', '테마5'\]/,
  "theme group must render 전체 and 테마1~테마5");
assert.match(toolbar, /isDetailFilterActive[\s\S]*!\['margin', 'noInboundPrice'\]\.includes\(v\)/,
  "fixed margin and no-inbound filters must not force the detail panel open");
assert.doesNotMatch(toolbar, /showDetailFilterPanel\s*=\s*[^;]*isCategoryFilterActive/,
  "fixed category filters must not force the detail panel open");

const allThemeHandler = toolbar.slice(toolbar.indexOf("const handleAllThemeClick ="), toolbar.indexOf("const toggleThemeFilter ="));
assert.match(allThemeHandler, /filter\(v => !\/\^theme\[1-5\]\$\//, "theme 전체 must remove theme filters");
assert.doesNotMatch(allThemeHandler, /setPriceFilter|setCategoryFilters|setBasicSearch|setGlobalSearch/,
  "theme 전체 must preserve every non-theme filter");

const promoWorkbenchStart = lowerRow.indexOf("promoWorkbenchOpen &&");
const detailPanelStart = lowerRow.indexOf("showDetailFilterPanel &&");
assert.ok(promoWorkbenchStart >= 0 && detailPanelStart > promoWorkbenchStart, "promotion workbench/detail panel boundaries must exist");
const promoWorkbench = lowerRow.slice(promoWorkbenchStart, detailPanelStart);
assert.doesNotMatch(promoWorkbench, /promo-work-theme-|beginThemeDrag|handleThemeClick/,
  "promotion workbench must not duplicate the fixed theme group");

const detailOptionsEnd = lowerRow.indexOf("!registrationMode", detailPanelStart);
const detailOptions = lowerRow.slice(detailPanelStart, detailOptionsEnd);
assert.doesNotMatch(detailOptions, /noInboundPrice|\['margin', '역마진'\]/,
  "detail panel must not duplicate the fixed margin and no-inbound filters");

const helperEnd = html.indexOf("const matchPromotionThemeFilter =", filterHelperStart);
const helperSource = html.slice(filterHelperStart, helperEnd);
assert.doesNotMatch(helperSource, /row\.finalData|row\.sources|resolvePromotionThemeState/,
  "theme filter helper must not read worktable or upload-source theme values");
assert.match(helperSource, /normalizePromotionThemeValue\(mItem \|\| \{\}\)/,
  "theme filter helper must normalize the master item only");

const context = {
  window: {
    normalizePromotionThemeValue(item = {}) {
      return String(item['행사테마'] || '');
    },
  },
};
vm.createContext(context);
vm.runInContext(`${helperSource}\nthis.getPromotionThemeCodesForFilterUnderTest = getPromotionThemeCodesForFilter;`, context);
assert.deepEqual(
  [...context.getPromotionThemeCodesForFilterUnderTest(
    { finalData: { 행사테마: "1" }, sources: { purchase: { 행사테마: "2" } } },
    { 행사테마: "3,5" },
  )],
  ["3", "5"],
  "master theme must win even when worktable and source values disagree",
);

const compositeStart = html.indexOf("const matchCompositeDetailFilters =", helperEnd);
const compositeEnd = html.indexOf("const resolveWorkingPromoPrice =", compositeStart);
const compositeSource = html.slice(compositeStart, compositeEnd);
assert.match(compositeSource, /themeFilters\.some\(v => matchPromotionThemeFilter/,
  "multiple theme selections must keep OR behavior");
assert.match(compositeSource, /if \(has\('margin'\)\)[\s\S]*if \(themeFilters\.length > 0/,
  "core filters and theme filters must remain combined as sequential AND conditions");

const versionMatches = [...html.matchAll(/v2\.1\.186_ExcludeActionLayout/g)];
assert.ok(versionMatches.length >= 3, "all MerchOps version labels must use v2.1.186");

console.log("MerchOps master-theme filter and fixed-layout contracts passed.");
