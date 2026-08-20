import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");

const helperStart = html.indexOf("window.findMerchExcelHeaderRow =");
const helperEnd = html.indexOf("const parseExcelRobust =", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "common Excel routing helpers must exist");

const context = vm.createContext({ window: {} });
context.window.cleanHeaderKey = (value) => String(value ?? "").toLowerCase().replace(/\s/g, "");
vm.runInContext(html.slice(helperStart, helperEnd), context, { filename: "MerchOps-common-excel-helpers.js" });

const titleRow = ["회사명 : 원앱 / 1창고 / 2026/08/12"];
const derivedOnlyRow = ["품명", "규격", "1종코드", "1종규격", "1종연산"];
const estimateHeaders = [
  "일자", "창고", "거래처명", "품목명", "규격", "품목코드", "입고가", "출고가", "입고B",
  "도매A", "도매B", "행사가", "외주비", "노무비", "1종규격", "1종코드",
];
const purchaseHeaders = ["일자", "거래처명", "창고코드", "코드", "품명", "규격", "수량", "단가", "합계", "구매처"];
const inventoryHeaders = ["품목코드", "품명", "규격", "재고", "기록", "최종(창고)", "구분(기본)"];
const infoHeaders = ["상품코드", "상품명", "규격", "판매가격", "시중가격", "상품태그", "단가연동", "테마1"];

assert.equal(
  context.window.findMerchExcelHeaderRow([titleRow, derivedOnlyRow, estimateHeaders]),
  2,
  "title and derived-product rows must be ignored before the real header row",
);
assert.equal(
  context.window.findMerchExcelHeaderRow([titleRow, derivedOnlyRow]),
  -1,
  "1종코드 must never be accepted as the product-code header",
);

assert.equal(
  context.window.detectMerchExcelRoleFromHeaders(estimateHeaders, { fileName: "1견적.xlsx", sheetName: "견적서현황내역" }).role,
  "estimate",
  "the supplied estimate workbook shape must route to estimate",
);
assert.equal(
  context.window.detectMerchExcelRoleFromHeaders(purchaseHeaders, { fileName: "1구매.xlsx", sheetName: "구매현황" }).role,
  "purchase",
  "purchase workbook headers must route to purchase",
);
assert.equal(
  context.window.detectMerchExcelRoleFromHeaders(inventoryHeaders, { fileName: "1재고현황.xlsx", sheetName: "전체재고" }).role,
  "inventory",
  "inventory headers must route to inventory",
);
assert.equal(
  context.window.detectMerchExcelRoleFromHeaders(infoHeaders, { fileName: "상품정보.xls", sheetName: "Worksheet" }).role,
  "info",
  "shop information headers must route to info",
);
assert.equal(
  context.window.detectMerchExcelRoleFromHeaders(["1종코드", "1종규격", "품명"], { fileName: "unknown.xlsx" }).role,
  "",
  "ambiguous files must be blocked rather than loaded into the wrong role",
);

const toolbarStart = html.indexOf("const MainToolbar = React.memo");
const toolbarEnd = html.indexOf("const SessionExcludedPanel =", toolbarStart);
const toolbar = html.slice(toolbarStart, toolbarEnd);
const categoryGroupAt = toolbar.indexOf('data-merch-category-group": "top-left"');
const parserGroupAt = toolbar.indexOf('data-merch-toolbar-group": "parser-catalog"');
const excelGroupAt = toolbar.indexOf('data-merch-toolbar-group": "excel"');
const operationGroupAt = toolbar.indexOf('data-merch-toolbar-group": "operations"');
assert.ok(categoryGroupAt >= 0 && categoryGroupAt < parserGroupAt && parserGroupAt < excelGroupAt && excelGroupAt < operationGroupAt,
  "top toolbar groups must be ordered category, parser/catalog, Excel, operations");

const excelGroup = toolbar.slice(excelGroupAt, operationGroupAt);
const commonExcelAt = excelGroup.indexOf("onChange: handleCommonExcelUpload");
const estimateAt = excelGroup.indexOf("handleFileUpload(e, 'estimate')");
const purchaseAt = excelGroup.indexOf("handleFileUpload(e, 'purchase')");
const inventoryAt = excelGroup.indexOf("handleLoadDataOpsSnapshot");
const infoAt = excelGroup.indexOf("handleFileUpload(e, 'info')");
const templatesAt = excelGroup.indexOf("commonExcelTableViewOptions.map");
assert.ok(commonExcelAt >= 0 && commonExcelAt < estimateAt && estimateAt < purchaseAt && purchaseAt < inventoryAt && inventoryAt < infoAt && infoAt < templatesAt,
  "Excel group order must be Excel, estimate, purchase, inventory, info, templates");
assert.match(excelGroup, /getLoadButtonClass\(isExcelWorktableLoaded, 'emerald'\)/,
  "the classification-free Excel entry must use dynamic loaded-state styling");
assert.match(excelGroup, /Excel: 유형을 고르지 않고 파일을 불러옵니다/,
  "the common Excel entry must explain that users do not classify the file type");
assert.doesNotMatch(excelGroup, /handleFileUpload\(e, 'inventory'\)/,
  "the common Excel button must not force every file through inventory logic");
assert.doesNotMatch(toolbar.slice(parserGroupAt, operationGroupAt), /justify-around/,
  "buttons inside toolbar groups must not be distributed independently");
assert.match(toolbar,
  /data-merch-category-group": "top-left"[\s\S]*data-merch-toolbar-group": "parser-catalog"[\s\S]*commonExcelTableViewOptions\.map\([\s\S]*?`양식: \$\{view\.targetLabel\} · \$\{view\.name\}`\)\)\)\)\)\),\s*React\.createElement\("div", \{ "data-merch-toolbar-group": "operations"/,
  "category, parser/catalog, Excel, and operations must remain siblings in the same top-level grid");

assert.match(toolbar, /\['estimate', 'purchase', 'inventory', 'info'\]/,
  "the common template selector must aggregate all four individual Excel roles");
assert.match(toolbar, /양식: \$\{view\.targetLabel\} · \$\{view\.name\}/,
  "template options must show their role and template name");

const mainFilterAt = toolbar.indexOf('title: "필터·조회: 조건을 선택한 뒤 우측 액션을 실행합니다."');
const searchAt = toolbar.indexOf("React.createElement(SearchBar", mainFilterAt);
const registrationToolsAt = toolbar.indexOf('data-merch-registration-tools": "subordinate"');
const topOperations = toolbar.slice(operationGroupAt, mainFilterAt);
const outPriceActionAt = toolbar.indexOf("onClick: handleForceApplyMarginRules", mainFilterAt);
const excludeActionAt = toolbar.indexOf('data-merch-exclude-action": "lower-right"', mainFilterAt);
const autoOutPriceAt = toolbar.indexOf("setAutoApplyOutPriceRule", mainFilterAt);
const excludedItemsAt = toolbar.indexOf('data-merch-excluded-items": "left"', mainFilterAt);
const promoEntryAt = toolbar.indexOf('data-merch-promo-entry": "single"', mainFilterAt);
assert.match(topOperations, /onClick: handleReset/, "the top-right operations group must retain the main reset action");
assert.doesNotMatch(topOperations, /handleForceApplyMarginRules|handleExcludeSelectedFromUpdate|setAutoApplyOutPriceRule/,
  "out-price and exclude actions must leave the top operations group");
assert.ok(autoOutPriceAt > mainFilterAt && autoOutPriceAt < outPriceActionAt && outPriceActionAt < excludeActionAt && excludeActionAt < searchAt,
  "auto out-price, out-price, and exclude controls must render together before lower-right filter reset and search");
assert.ok(excludedItemsAt > mainFilterAt && excludedItemsAt < promoEntryAt,
  "the dynamic excluded-items button must render at the far left of the lower filter row");
assert.match(toolbar.slice(mainFilterAt, promoEntryAt), /Object\.keys\(sessionExcludedItems \|\| \{\}\)\.length > 0/,
  "the excluded-items button must remain hidden until excluded items exist");
assert.doesNotMatch(toolbar.slice(mainFilterAt, promoEntryAt), /cat-main-|handleAllCategoryClick|data-merch-category-group/,
  "category buttons must not remain in the lower filter row");
assert.match(toolbar.slice(mainFilterAt, searchAt), /title: "출고가·제외·필터 초기화·검색"/,
  "the lower-right sticky group must identify the moved out-price and exclude controls");
assert.ok(mainFilterAt >= 0 && searchAt > mainFilterAt && registrationToolsAt > searchAt,
  "registration actions must render in a subordinate row after the main filter row");
assert.doesNotMatch(toolbar.slice(mainFilterAt, searchAt), /신규등록용 양식|선택 마스터 적용|이전 양식/,
  "registration actions must not remain inside the main filter row");
assert.match(toolbar,
  /React\.createElement\(SearchBar, \{ value: globalSearch, onChange: setGlobalSearch \}\)\)\),\s*registrationMode && React\.createElement/,
  "the main filter row must remain a child of the always-rendered toolbar container");
assert.match(toolbar.trimEnd(), /"적용"\)\)\)\)\)\)\)\);\s*\}\);$/,
  "MainToolbar must return its root element instead of the final detail-filter condition");

const versions = [...html.matchAll(/v2\.1\.200_WorkModeIssueSystem/g)].length;
assert.ok(versions >= 3, "all MerchOps version labels must use v2.1.200");

console.log("MerchOps common Excel routing, toolbar grouping, template aggregation, and registration sub-toolbar contracts passed.");
