import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const orderOpsHtml = fs.readFileSync(path.join(ROOT, "orderops_list.html"), "utf8");
assert.doesNotMatch(orderOpsHtml, /tokens truncated|…\d+ tokens truncated…/,
  "the public OrderOps mirror must not contain a truncated source fragment");
assert.match(orderOpsHtml, /<body>[\s\S]*<\/body>\s*<\/html>/,
  "the public OrderOps mirror must remain a complete HTML document");
assert.match(orderOpsHtml, /brand-badge">v1\.54</, "ORDER Q visible version must be v1.54");
assert.match(orderOpsHtml, /<title>ONEAPP ORDER Q · 출고관리<\/title>/,
  "the public page title must establish ORDER Q as shipment management");
assert.match(orderOpsHtml, /aria-label="ONEAPP ORDER Q 출고관리"/,
  "the public brand must identify ONEAPP ORDER Q shipment management");
assert.match(orderOpsHtml, /class="brand-logo" src="assets\/order-q-logo\.png"/,
  "the public header must use the approved ORDER Q logo asset");
assert.match(orderOpsHtml, /\.brand-logo-frame\s*\{[\s\S]*?width:\s*120px;[\s\S]*?height:\s*20px;/,
  "the public ORDER Q logo must match the ONEAPP wordmark height");
assert.match(orderOpsHtml, /ORDER Q v1\.54 · 출고관리/,
  "the public footer must use the ORDER Q product concept");
assert.doesNotMatch(
  orderOpsHtml.slice(orderOpsHtml.indexOf('<header class="global-header">'), orderOpsHtml.indexOf('</header>')),
  /NEXUS|OrderOps/,
  "legacy NEXUS and OrderOps labels must not remain in the public header",
);
const orderQLogoPath = path.join(ROOT, "assets", "order-q-logo.png");
assert.equal(fs.existsSync(orderQLogoPath), true, "the approved ORDER Q logo asset must exist");
assert.equal(
  crypto.createHash("sha256").update(fs.readFileSync(orderQLogoPath)).digest("hex"),
  "411a798c3afefe8840fb614cc1b14eb24e5a069460006e782b96678ad970f588",
  "the repository logo must be the unmodified approved source image",
);
assert.ok(orderOpsHtml.includes('class="execution-panel"'),
  "the public v1.54 execution controls must be separate from the upload strip");
assert.match(orderOpsHtml, /\.execution-panel\s*\{[^}]*grid-template-columns:\s*repeat\(2,/,
  "the public execution controls must use two independent buttons");
assert.match(orderOpsHtml, /\.execution-panel\s*\{[^}]*border:\s*0;/,
  "the public execution controls must not share an outer border");
assert.match(orderOpsHtml, /\.upload-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,/,
  "the public source strip must expose exactly five source/result tabs");
assert.match(orderOpsHtml, /\.system-topbar\s*\{[^}]*min-height:\s*58px;[^}]*padding:\s*10px 14px;/,
  "the public System.IO status row must use the DataOps-scale vertical spacing");
assert.match(orderOpsHtml, /\.upload-card,\s*\.execution-panel\s*\{[^}]*min-height:\s*54px;/,
  "the public uploader tabs must retain the taller DataOps-scale hit area");
assert.match(orderOpsHtml, /ORDER Q v1\.54: align System\.IO directly under the global header[\s\S]*?\.page-shell\s*\{\s*padding-top:\s*0;/,
  "the public System.IO workbench must start directly below the global header");
assert.ok(orderOpsHtml.includes('class="upload-grid" role="tablist" aria-label="업로드 자료 및 결과 화면"'),
  "the five source/result cards must form one accessible tab list");
const publicSourceTabOrder = ["ordersCard", "ledgerCard", "inventoryCard", "purchasesCard", "salesCard"]
  .map((id) => orderOpsHtml.indexOf(`id="${id}"`));
assert.ok(publicSourceTabOrder.every((position, index) => position >= 0 && (index === 0 || position > publicSourceTabOrder[index - 1])),
  "the source tabs must be ordered as order, stock ledger, inventory, purchase, and sales");
for (const sourceCardContract of [
  'id="ordersDrop" type="button" role="tab"',
  'id="inventoryDrop" type="button" role="tab"',
  'id="purchasesDrop" type="button" role="tab"',
  'id="salesDrop" type="button" role="tab"',
  'id="ledgerDrop" type="button" role="tab"',
  'id="ordersFileButton"',
  'id="inventoryFileButton"',
  'id="purchasesFileButton"',
  'id="salesFileButton"',
  '<p class="drop-title">수불현황</p>',
  'class="integrated-compact-slot" id="integratedCard"',
  'id="integratedFileButton"',
  '📁</span><span>통합</span>',
  'aria-label="통합 Excel 파일 불러오기"',
]) {
  assert.ok(orderOpsHtml.includes(sourceCardContract),
    `public source-card navigation contract is missing: ${sourceCardContract}`);
}
assert.doesNotMatch(orderOpsHtml, /integrated-uploader|id="integratedDrop"|id="integratedFileName"/,
  "the large integrated workbook uploader UI must be removed");
assert.match(orderOpsHtml, /<div class="data-source-label">[\s\S]*class="integrated-compact-slot" id="integratedCard"/,
  "the compact integrated picker must sit beside the data-source label");
assert.doesNotMatch(orderOpsHtml, /<div class="file-icon"[^>]*>6<\/div>/,
  "the integrated workbook uploader must not look like a sixth numbered result tab");
assert.ok(orderOpsHtml.includes('const FILE_KIND_PREVIEWS = Object.freeze({ orders: "allocations", inventory: "inventory", purchases: "purchases", sales: "sales" })'),
  "each uploaded source card must map to its result view");
assert.ok(orderOpsHtml.includes('data-preview="validation"') &&
  !orderOpsHtml.includes('Object.entries(definitions).map(([id, definition])'),
  "the middle toolbar must retain only 검증요약 instead of duplicate result tabs");
assert.ok(orderOpsHtml.includes("function resetResultViewFilters()"),
  "the public refresh control must reset result filters without a runtime reference error");
assert.match(orderOpsHtml, /\.system-topbar \.validation-box\s*\{[^}]*background:\s*transparent;/,
  "essential validation state must remain compact beside the System.IO console");
assert.match(orderOpsHtml, /table\.column-width-managed\s*\{[^}]*min-width:\s*0;/,
  "the public OrderOps table must allow unused space on the right");
assert.doesNotMatch(orderOpsHtml, /table\.column-width-managed\s*\{[^}]*min-width:\s*100%;/,
  "the public OrderOps table must not stretch to the full viewport width");
assert.match(orderOpsHtml, /const TABLE_WIDTH_MIN = 32;/,
  "the public OrderOps columns must support compact manual widths");
assert.match(orderOpsHtml, /const tableWidth = visibleEntries\.reduce\(/,
  "the public OrderOps table width must equal the sum of visible column widths");
assert.match(orderOpsHtml, /table\.style\.width = `\$\{renderedWidth\}px`;/,
  "the public OrderOps table must shrink with a resized column");
assert.doesNotMatch(orderOpsHtml, /\.print-area col\s*\{[^}]*width:\s*auto\s*!important/,
  "screen print must not discard saved column-width proportions");
for (const printWidthContract of [
  "function savedColumnWidth", 'widthSource: "saved"', "fitWidth: true", "sortable: false",
  'data-width-source="${options.widthSource || "draft"}"', 'data-saved-width="${width}"',
]) {
  assert.ok(orderOpsHtml.includes(printWidthContract),
    `public saved-width print contract is missing: ${printWidthContract}`);
}
assert.match(orderOpsHtml, /table\.preview-inventory \.inventory-input\s*\{[^}]*min-width:\s*0;/,
  "inventory editors must not force their columns wider");
assert.match(orderOpsHtml, /table\.preview-inventory td\.information-value\s*\{[^}]*min-width:\s*0;/,
  "the information column must remain freely resizable");
for (const requiredWarehouseColorContract of [
  'id="warehouseColorBar"',
  'id="warehouseColorOptions"',
  'id="colorTargetSelect"',
  'id="pastelColorPalette"',
  'id="vividColorPalette"',
  'oneapp.orderops.warehouse-colors.v1',
  'data-warehouse-filter',
  'data-palette-color',
  'isNonblankNumericValue(value)',
  'background-color:${warehouseFill}',
  'class="inventory-total-frame"',
]) {
  assert.ok(orderOpsHtml.includes(requiredWarehouseColorContract),
    `public OrderOps warehouse color contract is missing: ${requiredWarehouseColorContract}`);
}
for (const requiredInteractionContract of [
  'id="managerColorOptions"',
  'id="sourceSelector"',
  'id="warehouseFilterToggle"',
  'id="managerFilterToggle"',
  'id="warehouseFilterPanel"',
  'id="managerFilterPanel"',
  'oneapp.orderops.manager-colors.v1',
  'oneapp.orderops.column-order.v1',
  'data-manager-filter',
  'id="resultFilterResetButton"',
  'id="columnSortMenu"',
  'id="purchaseAutocomplete"',
  'id="purchaseCompletionCoachmark"',
  'data-sort-direction="asc"',
  'data-sort-direction="desc"',
  'data-column-condition="excludeBlank"',
  'data-column-condition="excludeZero"',
  'data-numeric-filter-section',
  'data-text-filter-section',
  'data-column-value-search',
  'data-column-value-select-all',
  'function columnTextValueOptions',
  'function applyColumnTextFilter',
  'Array.isArray(setting?.allowedValues)',
  'function rowMatchesColumnFilters',
  'function comparePreviewPairs',
  'function layeredColumnSortSettings',
  'allocations.columns[1].role = "customer"',
  'allocations.columns[2].role = "group"',
  'await restoreLocalRecord(candidate.record)',
  'data-column-drag-key',
  'analysisEnterLocked',
  'event.stopImmediatePropagation()',
  '["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"]',
  'filteredSortedPreviewPairs(state.activePreview, preview)',
  'getAllocationInventoryView(workspace)',
  'id="viewPresetSelect"',
  'id="viewPresetSaveButton"',
  'id="viewPresetDefaultButton"',
  'oneapp.orderops.order-view-presets.v1',
  'orderops-order-view-presets/v4',
  'const PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v3"',
  'const VIEW_PRESET_TABS = new Set(["allocations", "ledger", "inventory", "purchases", "sales"])',
  'columnWidths: normalizeStoredColumnWidths(value.view.columnWidths)',
  'columnOrder: normalizeStoredColumnOrder(value.view.columnOrder)',
  'hiddenColumns: normalizeStoredColumnOrder(value.view.hiddenColumns)',
  'warehouseColors: normalizeStoredColorMap(value.view.warehouseColors, isSafeColumnKey)',
  'managerColors: normalizeStoredColorMap(value.view.managerColors, isSafeManagerName)',
  'function persistSelectedOrderViewPresetColors',
  'colors: Object.assign(Object.create(null), preset.view.warehouseColors)',
  'colors: Object.assign(Object.create(null), preset.view.managerColors)',
  'persistSelectedOrderViewPresetColors();',
  'function applyOrderViewPreset',
  'function saveCurrentOrderViewPreset',
  'function setSelectedOrderViewPresetDefault',
  'function applyDefaultOrderViewPreset',
  'function parseIntegratedExcelFile',
  'function handleIntegratedFile',
]) {
  assert.ok(orderOpsHtml.includes(requiredInteractionContract),
    `public ORDER Q v1.54 interaction contract is missing: ${requiredInteractionContract}`);
}
const publicApplyColumnFilterSource = orderOpsHtml.slice(
  orderOpsHtml.indexOf("function applyColumnTextFilter"),
  orderOpsHtml.indexOf("function visibleColumnEntries"),
);
assert.match(publicApplyColumnFilterSource,
  /const next = \{ \.\.\.\(state\.columnFilters\[context\.previewId\]\[context\.columnKey\] \|\| \{\}\) \};/,
  "confirming Excel-style cell values must start from the active numeric conditions");
assert.doesNotMatch(publicApplyColumnFilterSource, /delete next\.exclude(?:Blank|Zero)/,
  "confirming the value list must preserve 공백 제외 and 0 제외 conditions");
const publicHeaderSource = orderOpsHtml.slice(
  orderOpsHtml.indexOf('<header class="global-header">'),
  orderOpsHtml.indexOf('</header>'),
);
assert.ok(publicHeaderSource.indexOf('id="smartInputButton"') < publicHeaderSource.indexOf('id="printButton"'),
  "Smart input F4 must sit immediately before screen print in the global header");
assert.equal(orderOpsHtml.split('id="smartInputButton"').length - 1, 1,
  "Smart input F4 must not remain duplicated inside the execution panel");
assert.match(orderOpsHtml, /\.print-area table\s*\{[\s\S]*?font-size:\s*10\.6px;/,
  "public screen print text must be twenty percent larger than v1.35");
assert.match(orderOpsHtml, /table\.preview-allocations\s*\{[\s\S]*?font-size:\s*11\.9px;/,
  "public order-status print text must be twenty percent larger than v1.35");
assert.doesNotMatch(orderOpsHtml, /<input[^>]+type="color"|data-warehouse-color|data-manager-color/,
  "the public OrderOps filter strip must not use a native color picker inside filter options");
const publicPastelSource = orderOpsHtml.slice(
  orderOpsHtml.indexOf("const PASTEL_COLOR_PALETTE"),
  orderOpsHtml.indexOf("const VIVID_COLOR_PALETTE"),
);
const publicVividSource = orderOpsHtml.slice(
  orderOpsHtml.indexOf("const VIVID_COLOR_PALETTE"),
  orderOpsHtml.indexOf("const WAREHOUSE_COLOR_PALETTE"),
);
assert.equal(publicPastelSource.match(/#[0-9a-f]{6}/gi)?.length, 10,
  "the public palette must expose ten pastel choices immediately");
assert.equal(publicVividSource.match(/#[0-9a-f]{6}/gi)?.length, 10,
  "the public palette must retain ten vivid choices behind the more control");
for (const cancelColorContract of [
  'const COLOR_CANCEL_COLOR = "#ffffff"',
  '"흰색 · 선택 배색 취소"',
  '[COLOR_CANCEL_COLOR, ...PASTEL_COLOR_PALETTE]',
  'color === COLOR_CANCEL_COLOR',
  '배색을 흰색으로 해제했습니다',
]) {
  assert.ok(orderOpsHtml.includes(cancelColorContract),
    `public ORDER Q white color-cancel contract is missing: ${cancelColorContract}`);
}
const publicViewControls = orderOpsHtml.slice(
  orderOpsHtml.indexOf('<div class="view-controls"'),
  orderOpsHtml.indexOf('<div class="warehouse-color-bar"'),
);
assert.ok(publicViewControls.indexOf('id="columnWidthResetButton"') < publicViewControls.indexOf('id="warehouseFilterToggle"'),
  "warehouse and manager filter buttons must sit at the far right after column-width reset");
assert.ok(publicViewControls.indexOf('id="tableSearchInput"') < publicViewControls.indexOf('id="resultFilterResetButton"'),
  "F2 filter reset must remain beside the integrated search");
assert.ok(orderOpsHtml.includes("function runResultFilterReset()") && orderOpsHtml.includes('event.key === "F2"'),
  "F2 must clear the result view through the dedicated reset path");
assert.match(orderOpsHtml, /body\s*\{[^}]*font-size:\s*14px;/,
  "the public OrderOps base text must increase by one pixel");
assert.ok(orderOpsHtml.includes("필수 파일 대기 · 주문현황과 창고재고를 선택하세요"),
  "the public System.IO console must explain the required operator action in Korean");
for (const shortcutContract of [
  'shortcut: "F5"',
  'shortcut: "F6"',
  'inventory.shortcut = "F7"',
  '저장 F8',
  'activatePreview("allocations")',
  'activatePreview("ledger")',
  'activatePreview("inventory")',
]) {
  assert.ok(orderOpsHtml.includes(shortcutContract), `public OrderOps shortcut contract is missing: ${shortcutContract}`);
}
assert.doesNotMatch(orderOpsHtml, /F12|새로고침 F5|aria-keyshortcuts="F5"[^>]*refreshButton/,
  "retired F12 and refresh-F5 shortcuts must not remain");
assert.ok(orderOpsHtml.includes(
  'headers: ["창고", "거래처", "그룹", "담당자", "상품코드", "품명", "규격", "정보", "주문", "단가", ...allocationWarehouseHeaders, "전달사항", "구매"]',
), "the public order table must include the source customer group in the approved sequence");
assert.doesNotMatch(orderOpsHtml, /allocations\.columns\[0\]\.orderField\s*=\s*"warehouse"/,
  "the order warehouse column must remain read-only");
assert.match(orderOpsHtml, /table\s*\{[^}]*border-collapse:\s*collapse;[^}]*border:\s*1px solid #d9e2ec;/,
  "public preview tables must use a light Excel-like grid");
assert.match(orderOpsHtml, /\.order-edit-input\s*\{[^}]*border:\s*0;/,
  "public editable cells must not draw an inner input border");
assert.match(orderOpsHtml, /\.table-wrap td:focus-within\s*\{[^}]*background:\s*#edf9f7 !important;/,
  "public editable cells must show a light focus fill");
assert.doesNotMatch(orderOpsHtml, /id="bundleDrop"|id="bundleInput"|Excel 묶음파일을 여기에 크게 던지기/,
  "the compact source strip must not retain a permanent bundle panel");
assert.match(orderOpsHtml, /function setActiveFilterPanel\(panelName = ""\)/,
  "warehouse and manager filters must open from their toolbar buttons");
assert.match(orderOpsHtml, /@page\s*\{\s*size:\s*A4 portrait;/,
  "public OrderOps screen print must use A4 portrait");
assert.doesNotMatch(orderOpsHtml, /sourceRow\.managerColors/,
  "public OrderOps must not retain automatic manager hash colors");
assert.match(orderOpsHtml, /purchase-input\[data-negative-balance="true"\][^{]*\{[^}]*background:\s*#fef9c3;/,
  "verified shortages must use a pale yellow purchase editor inside its border");
assert.doesNotMatch(orderOpsHtml, /background:\s*#fff200/,
  "quantity and purchase states must not use the former noisy saturated yellow fill");
assert.match(orderOpsHtml, /workbookTools\.downloadWorkbook\(state\.workspace, window\.XLSX, fileName\)/,
  "the single Excel output must use the integrated workbook");
assert.doesNotMatch(orderOpsHtml, /<datalist[^>]+purchaseSupplierHistory|list="purchaseSupplierHistory"|title="\$\{escapeHtml\(value\)\}"/,
  "public purchase entry and data cells must not open cell-obscuring bubbles");
for (const firstViewContract of [
  'class="validation-notice-summary"',
  'id="validationNoticeHeading">전달사항(적요보기)',
  'state.activePreview === "validation"',
]) {
  assert.ok(orderOpsHtml.includes(firstViewContract), `public OrderOps first-view notice contract is missing: ${firstViewContract}`);
}
assert.doesNotMatch(orderOpsHtml, /id="purchaseUploadButton"/,
  "a separate purchase-upload button must not remain");
assert.match(orderOpsHtml, />엑셀출력 F10</, "the integrated Excel output button must remain visible in the header");
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const workbookTools = require(path.join(ROOT, "orderFulfillmentWorkbook.js"));
assert.equal("managerColors" in engine, false, "automatic manager hash color API must be removed");
const PURCHASE_TEMPLATE_PATH = "C:\\Users\\USER\\Desktop\\구매업로드.xlsx";
const purchaseTemplateBaseline = fs.existsSync(PURCHASE_TEMPLATE_PATH)
  ? {
      hash: crypto.createHash("sha256").update(fs.readFileSync(PURCHASE_TEMPLATE_PATH)).digest("hex"),
      mtimeMs: fs.statSync(PURCHASE_TEMPLATE_PATH).mtimeMs,
    }
  : null;

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
const XLSX_SHA256 = "1c7abf2993ff2cd61e508f9268e9acda0098c9796f3925d2ba0d2579072653e2";

const response = await fetch(XLSX_URL);
assert.equal(response.ok, true, `xlsx-js-style download failed: ${response.status}`);
const xlsxSource = Buffer.from(await response.arrayBuffer());
assert.equal(
  crypto.createHash("sha256").update(xlsxSource).digest("hex"),
  XLSX_SHA256,
  "xlsx-js-style asset hash changed",
);

const context = vm.createContext({
  console,
  Date,
  Map,
  Set,
  Symbol,
  Number,
  Object,
  String,
  Array,
  Math,
  JSON,
  RegExp,
  Error,
  Promise,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
});
context.window = context;
context.self = context;
context.globalThis = context;
context.global = context;
vm.runInContext(xlsxSource.toString("utf8"), context, { filename: "xlsx-js-style.bundle.js" });
const XLSX = context.XLSX;
assert.ok(XLSX?.utils?.sheet_to_json, "xlsx-js-style did not initialize");

const ORDER_HEADERS = [
  "일자-No.",
  "담당",
  "단위",
  "품목코드",
  "품목명",
  "규격",
  "수량",
  "재고",
  "단가",
  "적요",
  "적요1",
  "거래처",
  "그룹",
];
const INVENTORY_HEADERS = [
  "사용",
  "품목코드",
  "단위",
  "품목명",
  "규격",
  "수량",
  "1창고",
  "2전송",
  "3서울",
  "4전송",
  "7진영",
  "기본",
  "전송",
  "창고",
];

function buildOrderMatrix(rows) {
  return [
    ["회사명 : 테스트 / 주문현황"],
    ORDER_HEADERS,
    ...rows.map((row, index) => [
      row.date || `2026-08-04-${index + 1}`,
      row.manager || "담당",
      row.unit || "EA",
      row.code,
      row.name || `상품 ${row.code}`,
      row.spec || row.unit || "EA",
      row.quantity,
      "",
      row.price ?? 1000,
      row.note || "",
      row.note1 || "",
      row.customer || `거래처 ${index + 1}`,
      row.group || "기본그룹",
    ]),
  ];
}

function buildInventoryMatrix(rows) {
  return [
    ["회사명 : 테스트 / 창고별재고"],
    INVENTORY_HEADERS,
    ...rows.map((row) => {
      const sourceTotal = row.quantity ?? [
        row.whole,
        row.transfer2,
        row.seoul,
        row.transfer,
        row.jinyeong,
      ].reduce((sum, value) => sum + (Number(value) || 0), 0);
      return [
        "Yes",
        row.code,
        row.unit || "EA",
        row.name || `상품 ${row.code}`,
        row.spec || row.unit || "EA",
        sourceTotal,
        row.whole ?? "",
        row.transfer2 ?? "",
        row.seoul ?? "",
        row.transfer ?? "",
        row.jinyeong ?? "",
        row.base ?? "",
        row.transferLabel ?? "",
        row.warehousePrice ?? "",
      ];
    }),
  ];
}

function parseOrders(matrix, fileName = "주문현황.xlsx") {
  return engine.parseOrderWorkbook({
    fileName,
    sheetName: "미판매현황",
    rawMatrix: matrix,
    displayMatrix: matrix,
  });
}

function parseInventory(matrix, fileName = "창고별재고.xlsx") {
  return engine.parseInventoryWorkbook({
    fileName,
    sheetName: "재고현황",
    rawMatrix: matrix,
    displayMatrix: matrix,
  });
}

const CANONICAL_ORDER_HEADERS = [...ORDER_HEADERS, "공급가액"];
const CANONICAL_ORDER_VALUES = Object.freeze({
  "일자-No.": "2026-08-04-1",
  "담당": "담당A",
  "단위": "EA",
  "품목코드": "ALIAS-001",
  "품목명": "별칭 상품",
  "규격": "EA",
  "수량": 3,
  "재고": 7,
  "단가": 1200,
  "공급가액": 3600,
  "적요": "별칭 적요",
  "적요1": "유지 적요1",
  "거래처": "별칭 거래처",
  "그룹": "별칭 그룹",
});

function buildCanonicalOrderMatrix({ replacements = {}, headerOrder = CANONICAL_ORDER_HEADERS, preambleCount = 1, extraHeaders = [] } = {}) {
  const headers = [...headerOrder.map((canonical) => replacements[canonical] || canonical), ...extraHeaders];
  const values = [...headerOrder.map((canonical) => CANONICAL_ORDER_VALUES[canonical]), ...extraHeaders.map(() => "확인값")];
  return [
    ...Array.from({ length: preambleCount }, (_, index) => [`상단 안내 ${index + 1}`]),
    headers,
    values,
  ];
}

const approvedAliasGroups = {
  "품목코드": ["상품코드", "품목코드", "코드"],
  "품목명": ["상품명", "품목명", "제품명"],
  "수량": ["수량", "주문수량", "미출고수량"],
  "단가": ["단가", "판매단가", "출고단가"],
  "공급가액": ["공급가액", "금액", "합계금액"],
  "거래처": ["거래처", "거래처명", "고객명"],
  "적요": ["메모", "비고", "적요"],
};
for (const [canonical, aliases] of Object.entries(approvedAliasGroups)) {
  for (const alias of aliases) {
    const parsed = parseOrders(buildCanonicalOrderMatrix({ replacements: { [canonical]: alias } }));
    assert.equal(parsed.errors.length, 0, `${canonical} alias ${alias} must parse`);
    assert.equal(parsed.headerMapping.columns.some((column) => column.canonical === canonical && column.header === alias), true);
    assert.equal(parsed.rows[0].productCode, "ALIAS-001");
    assert.equal(parsed.rows[0].productName, "별칭 상품");
    assert.equal(parsed.rows[0].quantity, 3);
    assert.equal(parsed.rows[0].unitPrice, 1200);
    assert.equal(parsed.rows[0].supplyAmount, 3600);
    assert.equal(parsed.rows[0].customer, "별칭 거래처");
    assert.equal(parsed.rows[0].note, "별칭 적요");
  }
}

const normalizedAliasOrders = parseOrders(buildCanonicalOrderMatrix({
  replacements: { "일자-No.": "일자 - nO .", "품목코드": " 상-품_코 드 ", "품목명": "제 품-명" },
  headerOrder: [...CANONICAL_ORDER_HEADERS].reverse(),
  preambleCount: 29,
}));
assert.equal(normalizedAliasOrders.headerRowIndex, 29, "the thirtieth row must remain inside the order header scan range");
assert.equal(normalizedAliasOrders.rows[0].productCode, "ALIAS-001", "punctuation, spaces, and case must not change alias matching");
assert.deepEqual(
  normalizedAliasOrders.sourceMatrix[29],
  [...CANONICAL_ORDER_HEADERS].reverse().map((canonical) => ({
    "일자-No.": "일자 - nO .",
    "품목코드": " 상-품_코 드 ",
    "품목명": "제 품-명",
  }[canonical] || canonical)),
  "source headers must not be renamed by canonical mapping",
);

const duplicateCanonicalOrders = parseOrders(buildCanonicalOrderMatrix({ extraHeaders: ["상품코드"] }));
assert.equal(duplicateCanonicalOrders.errors.some((issue) => issue.code === "ORDER_DUPLICATE_CANONICAL_HEADERS"), true);
assert.match(
  duplicateCanonicalOrders.errors.find((issue) => issue.code === "ORDER_DUPLICATE_CANONICAL_HEADERS").message,
  /품목코드: 품목코드\(4열\), 상품코드\(15열\)/,
  "duplicate canonical errors must identify the standard field and source positions",
);
assert.equal(duplicateCanonicalOrders.rows.length, 0, "ambiguous canonical mappings must block row import");

const missingCanonicalOrders = parseOrders(buildCanonicalOrderMatrix({
  headerOrder: CANONICAL_ORDER_HEADERS.filter((header) => header !== "규격"),
}));
assert.deepEqual(missingCanonicalOrders.missingColumns, ["규격"]);
assert.match(missingCanonicalOrders.errors[0].message, /규격/);

const unknownHeaderOrders = parseOrders(buildCanonicalOrderMatrix({ extraHeaders: ["사용자 정의 열"] }));
assert.equal(unknownHeaderOrders.errors.length, 0);
assert.equal(unknownHeaderOrders.warnings.some((issue) => issue.code === "ORDER_UNKNOWN_HEADERS"), true);
assert.match(unknownHeaderOrders.warnings[0].message, /사용자 정의 열\(15열\)/);

const supplyHeaders = [...CANONICAL_ORDER_HEADERS];
const supplyMatrix = [
  ["공급가액 보존"],
  supplyHeaders,
  ...[
    ["SUPPLY-0", 0],
    ["SUPPLY-BLANK", ""],
    ["SUPPLY-TEXT", "숫자 확인 필요"],
  ].map(([code, supplyAmount], index) => supplyHeaders.map((canonical) => ({
    ...CANONICAL_ORDER_VALUES,
    "일자-No.": `2026-08-04-${index + 1}`,
    "품목코드": code,
    "공급가액": supplyAmount,
  }[canonical]))),
];
const supplyOrders = parseOrders(supplyMatrix);
assert.deepEqual(supplyOrders.rows.map((row) => row.supplyAmount), [0, null, "숫자 확인 필요"]);
assert.deepEqual(supplyOrders.sourceMatrix, supplyMatrix, "supply source cells and headers must remain unchanged");

const edgeOrders = parseOrders(
  buildOrderMatrix([
    { code: "000100", quantity: 4, note: "원문 적요", customer: "같은거래처", price: 1000 },
    { code: "000100", quantity: 4, note: "원문 적요", note1: "원문 적요1", customer: "같은거래처", price: 1200 },
    { code: "000100", quantity: 2 },
    { code: "NO-STOCK", quantity: 3 },
  ]),
);
const edgeInventory = parseInventory(
  buildInventoryMatrix([
    { code: "000100", whole: 5, transfer2: -10, seoul: 4, transfer: -1 },
    { code: "000100-A", name: "대체 참고상품", whole: 7, seoul: 0, transfer: 0 },
  ]),
);
const stockCloseInventory = parseInventory([
  ["회사명 : 원앱 / 1창고 / 2026/08/10 / 전체재고"],
  ["단위", "창고", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요"],
  ["BOX", "01", "CLOSE-001", "수불마감 상품 1", "BOX", 4, "2026-08-10", "거창", 16000, "1", ""],
  ["EA", "01", "CLOSE-002", "수불마감 상품 2", "EA", -1.5, "2026-08-10", "경매", 9000, "1", "확인"],
], "수불마감_20260810.xlsx");
assert.equal(stockCloseInventory.rowCount, 0, "row-based stock-closing input must not be parsed as aggregate inventory");
assert.ok(
  stockCloseInventory.errors.some(
    (issue) => issue.code === "INVENTORY_REQUIRED_COLUMNS" && issue.missingColumns.includes("수량"),
  ),
  "row-based stock-closing input must be rejected when aggregate 수량 is absent",
);
assert.ok(
  stockCloseInventory.errors.some((issue) => issue.code === "INVENTORY_WAREHOUSE_COLUMNS_REQUIRED"),
  "row-based stock-closing input must be rejected when warehouse breakdown columns are absent",
);
assert.notEqual(
  stockCloseInventory.columns.find((column) => column.header === "재고")?.role,
  "warehouseQuantity",
  "a row-based 재고 value must not be treated as a warehouse breakdown",
);
const mismatchedAggregateInventory = parseInventory(buildInventoryMatrix([{
  code: "TOTAL-MISMATCH",
  quantity: 99,
  whole: 20,
  transfer2: 50,
  seoul: 30,
  transfer: 0,
}]));
assert.equal(mismatchedAggregateInventory.rowCount, 0, "a mismatched aggregate row must not enter analysis");
assert.deepEqual(
  mismatchedAggregateInventory.errors.find((issue) => issue.code === "INVENTORY_TOTAL_MISMATCH"),
  {
    code: "INVENTORY_TOTAL_MISMATCH",
    message: "3행 TOTAL-MISMATCH의 수량(99)과 창고별 수량 합계(100)가 일치하지 않습니다.",
    rowNumber: 3,
    productCode: "TOTAL-MISMATCH",
    sourceInventoryTotal: 99,
    warehouseInventoryTotal: 100,
  },
  "aggregate inventory must reconcile total stock with all warehouse quantity columns",
);
const unknownHeaderInventory = parseInventory(buildInventoryMatrix([
  { code: "ALIAS-001", whole: 3, seoul: 0, transfer: 0 },
]));
assert.equal(
  engine.validateInputs(unknownHeaderOrders, unknownHeaderInventory).canAnalyze,
  true,
  "unknown headers must warn without blocking otherwise valid input",
);

const supplyInventory = parseInventory(buildInventoryMatrix([
  { code: "SUPPLY-0", whole: 0, seoul: 0, transfer: 0 },
  { code: "SUPPLY-BLANK", whole: 0, seoul: 0, transfer: 0 },
  { code: "SUPPLY-TEXT", whole: 0, seoul: 0, transfer: 0 },
]));
const supplyWorkspace = engine.analyze(supplyOrders, supplyInventory, {
  createdAt: "2026-08-04T00:00:00.000Z",
});
const blankSupplyMatrix = supplyMatrix.map((row, rowIndex) =>
  rowIndex <= 1 ? [...row] : row.map((value, columnIndex) =>
    columnIndex === supplyHeaders.indexOf("공급가액") ? "" : value,
  ),
);
const blankSupplyWorkspace = engine.analyze(parseOrders(blankSupplyMatrix), supplyInventory, {
  createdAt: "2026-08-04T00:00:00.000Z",
});
assert.equal(supplyWorkspace.stats.totalOrderQuantity, 9);
assert.equal(supplyWorkspace.stats.totalPurchaseNeed, 9);
assert.equal(supplyWorkspace.stats.allocationDifference, 0);
assert.deepEqual(
  supplyWorkspace.allocations.map((row) => [row.quantity, row.wholeAllocation, row.seoulAllocation, row.purchaseNeed]),
  blankSupplyWorkspace.allocations.map((row) => [row.quantity, row.wholeAllocation, row.seoulAllocation, row.purchaseNeed]),
  "supply amount must not participate in allocation or purchase-need calculations",
);
assert.deepEqual(supplyWorkspace.allocations.map((row) => row.supplyAmount), [0, null, "숫자 확인 필요"]);
assert.equal(supplyWorkspace.sourceFiles.orders.headerMapping.schemaVersion, "shipping-order-header-mapping/v1");
const supplyWorkbook = workbookTools.buildWorkbook(supplyWorkspace, XLSX);
assert.deepEqual(
  [2, 3, 4].map((rowNumber) => sheetCellByHeader(supplyWorkbook.Sheets["주문현황"], "공급가액", rowNumber).v),
  [0, "", "숫자 확인 필요"],
  "general Excel must preserve supply amount zero, blank, and nonnumeric source meaning",
);
assert.equal(
  XLSX.utils.decode_range(workbookTools.buildPurchaseUploadWorkbook(supplyWorkspace, XLSX).Sheets["구매입력"]["!ref"]).e.c,
  19,
  "supply amount must not change the purchase-upload A:T contract",
);
const edgeValidation = engine.validateInputs(edgeOrders, edgeInventory);
assert.equal(edgeValidation.canAnalyze, true);
assert.equal(edgeValidation.unmatchedCount, 1);
assert.equal(edgeValidation.memoCount, 2);

const edgeWorkspace = engine.analyze(edgeOrders, edgeInventory, {
  createdAt: "2026-07-30T00:00:00.000Z",
  sourceFingerprint: "a".repeat(64),
});
assert.equal(engine.ENGINE_VERSION, "3.18.0");
assert.equal(workbookTools.WORKBOOK_VERSION, "4.8.0");
assert.equal(edgeWorkspace.schemaVersion, "shipping-workspace/v2");
const edgeShortageContext = engine.getShortageCategoryContext(edgeWorkspace);
assert.deepEqual(edgeShortageContext, {
  shortageCount: 2,
  shortageProductCodes: ["000100", "NO-STOCK"],
  candidateProductCodes: ["000100-A"],
  purchaseActionCount: 3,
  purchaseActionProductCodes: ["000100", "000100-A", "NO-STOCK"],
  categories: [
    {
      categoryCode: "000100",
      shortageProductCodes: ["000100"],
      candidateProductCodes: ["000100-A"],
    },
    {
      categoryCode: "NO-STO",
      shortageProductCodes: ["NO-STOCK"],
      candidateProductCodes: [],
    },
  ],
}, "purchase-action shortages must include missing inventory and group substitute candidates by six-character category");
assert.equal(edgeShortageContext.shortageProductCodes.includes("NO-STOCK"), true,
  "an ordered product without inventory information must remain visible in shortage focus for purchasing action");
const edgeInventoryView = engine.getInventoryViewRows(edgeWorkspace);
const orderOnlyInventoryRow = edgeInventoryView.rows.find((row) => row.productCode === "NO-STOCK");
assert.equal(edgeInventoryView.rows.length, edgeInventory.rowCount + 1,
  "inventory view must append order products that do not exist in the inventory source");
assert.deepEqual(
  [orderOnlyInventoryRow?.productName, orderOnlyInventoryRow?.stockTotal,
    orderOnlyInventoryRow?.orderQuantity, orderOnlyInventoryRow?.remainingQuantity,
    orderOnlyInventoryRow?.inventoryMissing],
  ["상품 NO-STOCK", 0, 3, -3, true],
  "order-only products must display source identity, zero stock, and a negative order-aware balance",
);
assert.deepEqual(
  edgeInventoryView.columns
    .map((column, index) => column.role === "warehouseQuantity" ? orderOnlyInventoryRow.values[index] : null)
    .filter((value) => value !== null),
  edgeInventoryView.columns.filter((column) => column.role === "warehouseQuantity").map(() => 0),
  "every warehouse quantity cell for an order-only product must begin at numeric zero",
);
assert.equal(
  engine.getPurchaseUploadSelection(edgeWorkspace).included.find((row) => row.productCode === "NO-STOCK")?.purchaseNeed,
  3,
  "an order-only product must become a purchase-upload target instead of being silently excluded",
);
const orderOnlyOverrideWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
const firstWarehouseColumn = engine.getInventoryColumnDescriptors(orderOnlyOverrideWorkspace)
  .find((column) => column.role === "warehouseQuantity");
engine.setInventoryOverride(orderOnlyOverrideWorkspace, "NO-STOCK", firstWarehouseColumn.key, 1);
assert.equal(
  engine.getInventoryViewRows(orderOnlyOverrideWorkspace).rows
    .find((row) => row.productCode === "NO-STOCK").remainingQuantity,
  -2,
  "administrators must be able to correct an order-only product warehouse quantity",
);
assert.equal(
  engine.getPurchaseUploadSelection(orderOnlyOverrideWorkspace).included
    .find((row) => row.productCode === "NO-STOCK")?.purchaseNeed,
  2,
  "the corrected order-only stock must immediately recalculate the purchase-upload quantity",
);

const signedOrders = parseOrders(buildOrderMatrix([
  { code: "SIGNED-001", quantity: 0, customer: "제로거래처", note: "0 수량 전달" },
  { code: "SIGNED-001", quantity: -1, customer: "중복거래처", note1: "음수 전달" },
  { code: "SIGNED-001", quantity: 2, customer: "중복거래처" },
]));
assert.equal(signedOrders.errors.length, 0, "0 and negative finite quantities must parse");
assert.equal(signedOrders.warnings.some((issue) => issue.code === "ORDER_NON_POSITIVE_QUANTITY"), true);
assert.deepEqual([signedOrders.zeroQuantityCount, signedOrders.negativeQuantityCount], [1, 1]);
for (const invalidQuantity of ["", "not-a-number", Number.POSITIVE_INFINITY, Number.NaN]) {
  const invalidOrders = parseOrders(buildOrderMatrix([{ code: "INVALID-QTY", quantity: invalidQuantity }]));
  assert.equal(
    invalidOrders.errors.some((issue) => issue.code === "ORDER_QUANTITY_INVALID"),
    true,
    `invalid quantity must be blocked: ${String(invalidQuantity)}`,
  );
}
const signedWorkspace = engine.analyze(
  signedOrders,
  parseInventory(buildInventoryMatrix([{ code: "SIGNED-001", whole: 5, seoul: 0, transfer: 0 }])),
  { createdAt: "2026-08-04T00:00:00.000Z", sourceFingerprint: "9".repeat(64) },
);
assert.deepEqual(
  signedWorkspace.allocations.map((row) => [row.quantity, row.wholeAllocation, row.wholeRemaining, row.purchaseNeed]),
  [[0, 0, 5, 0], [-1, -1, 6, 0], [2, 2, 4, 0]],
  "signed order quantities must flow through allocation, remaining stock, and nonnegative purchase need",
);
assert.deepEqual(
  [signedWorkspace.stats.totalOrderQuantity, signedWorkspace.stats.allocationDifference,
    signedWorkspace.stats.zeroOrderQuantityCount, signedWorkspace.stats.negativeOrderQuantityCount],
  [1, 0, 1, 1],
);
const signedInventoryView = engine.getInventoryViewRows(signedWorkspace);
assert.equal(
  signedInventoryView.rows[0].orderInformation,
  "제로거래처(0)1,000\n중복거래처(-1)1,000\n중복거래처(2)1,000",
  "order information must preserve customer, quantity, unit price, row order, and duplicates",
);
assert.equal(signedInventoryView.rows[0].orderNotes, "0 수량 전달\n음수 전달");
const signedWorkbook = workbookTools.buildWorkbook(signedWorkspace, XLSX);
assert.deepEqual(Array.from(signedWorkbook.SheetNames), [
  "전달사항(적요보기)", "주문현황", "재고수불부", "창고별재고", "구매업로드", "판매업로드",
]);
const signedNoticeSheet = signedWorkbook.Sheets["전달사항(적요보기)"];
assert.deepEqual(
  [signedNoticeSheet.E5.v, signedNoticeSheet.F5.v, signedNoticeSheet.I5.v, signedNoticeSheet.I6.v],
  ["EA", 0, "0 수량 전달", "음수 전달"],
);
assert.equal(signedNoticeSheet.I5.s.fill.fgColor.rgb, "FFFFFF");
assert.equal(signedNoticeSheet.I5.s.alignment.wrapText, true);
const signedInventorySheet = signedWorkbook.Sheets["창고별재고"];
const signedInventoryHeaders = XLSX.utils.sheet_to_json(signedInventorySheet, { header: 1, raw: true })[0];
assert.deepEqual(Array.from(signedInventoryHeaders.slice(-2)), ["정보", "적요"]);
assert.equal(
  signedInventorySheet[XLSX.utils.encode_cell({ r: 1, c: signedInventoryHeaders.length - 2 })].v,
  "제로거래처(0)1,000\n중복거래처(-1)1,000\n중복거래처(2)1,000",
  "inventory information must remain available regardless of the final balance sign",
);
assert.equal(sheetCellByHeader(signedWorkbook.Sheets["주문현황"], "주문수량", 3).v, -1);
assert.equal(XLSX.utils.decode_range(signedWorkbook.Sheets["구매업로드"]["!ref"]).e.c, 19);
assert.equal(XLSX.utils.decode_range(signedWorkbook.Sheets["구매업로드"]["!ref"]).e.r, 0);
assert.equal(XLSX.utils.decode_range(signedWorkbook.Sheets["판매업로드"]["!ref"]).e.c, 21);
assert.equal(XLSX.utils.decode_range(signedWorkbook.Sheets["판매업로드"]["!ref"]).e.r, 2,
  "sales upload must preserve negative order quantities and omit zero quantities");
assert.equal(edgeWorkspace.basisDate, "2026-08-04");
assert.equal(edgeWorkspace.uploadDate, "20260804");
assert.equal(edgeWorkspace.planId, `SHIPPLAN-20260804-${"a".repeat(16)}`);
assert.deepEqual(
  edgeWorkspace.allocations.slice(0, 3).map((row) => [
    row.wholeAllocation,
    row.seoulAllocation,
    row.purchaseNeed,
  ]),
  [
    [4, 0, 0],
    [1, 3, 0],
    [0, 0, 2],
  ],
  "duplicate order lines must consume aggregate pools in input order without reuse",
);
assert.equal(
  edgeWorkspace.inventory[0].seoulFirstPurchaseRemaining,
  3,
  "negative 4전송 must reduce the 서울 first-purchase pool",
);
assert.equal(
  edgeWorkspace.allocations[3].status,
  "재고정보 없음",
  "unmatched codes must remain explicit",
);
assert.equal(
  edgeWorkspace.allocations[3].purchaseNeed,
  null,
  "unmatched codes must not receive a confirmed purchase quantity",
);
assert.ok(
  edgeWorkspace.allocations
    .filter((row) => row.purchaseNeed !== null)
    .every((row) => row.purchaseNeed >= 0),
  "purchase need must never be negative",
);
assert.ok(
  edgeWorkspace.allocations
    .filter((row) => row.inventoryMatched)
    .every((row) => Math.abs(row.reconciliationDifference) <= 1e-9),
  "every matched order line must reconcile",
);
assert.equal(edgeWorkspace.memoIssues.length, 2, "적요 and 적요1 must be collected");
assert.equal(
  edgeWorkspace.purchaseManagement.find((row) => row.productCode === "NO-STOCK").inventoryMatched,
  false,
);
assert.deepEqual(
  edgeWorkspace.productSummaries.find((row) => row.productCode === "000100").supplierPairs.map((pair) => pair.display),
  ["같은거래처(1000)", "같은거래처(1200)", "거래처 3(1000)"],
  "same customer with different original prices must remain separate",
);
assert.deepEqual(
  edgeWorkspace.allocations.slice(0, 3).map((row) => [row.supplierDisplay, row.unitPrice, typeof row.unitPrice]),
  [
    ["같은거래처(1000)", 1000, "number"],
    ["같은거래처(1200)", 1200, "number"],
    ["거래처 3(1000)", 1000, "number"],
  ],
  "each allocation must preserve its original numeric unit price and pair display",
);
assert.equal(
  edgeWorkspace.productSummaries.find((row) => row.productCode === "000100").noteValues.length,
  1,
  "memo originals must be de-duplicated without losing the original text",
);
const purchaseRowsFor000100 = edgeWorkspace.purchaseManagement.filter((row) => row.referenceFor === "000100" || row.productCode === "000100");
assert.deepEqual(purchaseRowsFor000100.map((row) => [row.productCode, row.rowType]), [
  ["000100", "main"],
  ["000100-A", "reference"],
]);

const shadowWorkspace = engine.analyze(
  parseOrders(buildOrderMatrix([{ code: "000001", quantity: 2, spec: "BOX" }])),
  parseInventory(buildInventoryMatrix([
    { code: "000001", whole: 0, seoul: 0, transfer: 0, spec: "BOX" },
    { code: "000002", whole: 5, seoul: 0, transfer: 0, spec: "EA" },
    { code: "000003", whole: 3, seoul: 0, transfer: 0, spec: "소분" },
  ])),
  { sourceFingerprint: "b".repeat(64) },
);
const totalsBeforeShadowEdit = {
  totalOrderQuantity: shadowWorkspace.stats.totalOrderQuantity,
  productCount: shadowWorkspace.stats.productCount,
  totalPurchaseNeed: shadowWorkspace.stats.totalPurchaseNeed,
  validationResults: JSON.stringify(shadowWorkspace.validationResults),
  unmatchedCount: shadowWorkspace.stats.unmatchedCount,
};
const shadowRows = shadowWorkspace.purchaseManagement.filter((row) => row.inventoryShadow === true);
assert.deepEqual(shadowRows.map((row) => [row.productCode, row.purchaseNeed, row.totalOrderQuantity]), [
  ["000002", null, null],
  ["000003", null, null],
]);
assert.equal(engine.ensureInventoryPurchaseRows(shadowWorkspace), shadowWorkspace);
assert.equal(shadowWorkspace.purchaseManagement.filter((row) => row.inventoryShadow === true).length, 2);
engine.setPurchaseValue(shadowWorkspace, "000002", "재고전용거래처");
assert.equal(engine.getPurchaseInputs(shadowWorkspace)["000002"], "재고전용거래처");
assert.equal(engine.getPurchaseUploadSelection(shadowWorkspace).included.some((row) => row.productCode === "000002"), false);
assert.equal(engine.getPurchaseUploadSelection(shadowWorkspace).excluded.some((row) => row.productCode === "000002"), true);
assert.deepEqual(
  {
    totalOrderQuantity: shadowWorkspace.stats.totalOrderQuantity,
    productCount: shadowWorkspace.stats.productCount,
    totalPurchaseNeed: shadowWorkspace.stats.totalPurchaseNeed,
    validationResults: JSON.stringify(shadowWorkspace.validationResults),
    unmatchedCount: shadowWorkspace.stats.unmatchedCount,
  },
  totalsBeforeShadowEdit,
  "inventory-only purchase edits must not alter calculations, validation, or unmatched counts",
);
assert.equal(engine.getInventoryViewRows(shadowWorkspace).rows.length, 3);
const roundTripShadow = JSON.parse(JSON.stringify(shadowWorkspace));
engine.applyPurchaseInputs(roundTripShadow, engine.getPurchaseInputs(shadowWorkspace));
assert.equal(engine.getPurchaseInputs(roundTripShadow)["000002"], "재고전용거래처");
assert.equal(roundTripShadow.purchaseManagement.filter((row) => row.inventoryShadow === true).length, 2);
const legacyWorkspace = JSON.parse(JSON.stringify(shadowWorkspace));
legacyWorkspace.purchaseManagement = legacyWorkspace.purchaseManagement.filter((row) => row.inventoryShadow !== true);
engine.ensureInventoryPurchaseRows(legacyWorkspace);
assert.deepEqual(
  legacyWorkspace.purchaseManagement.filter((row) => row.inventoryShadow === true).map((row) => row.productCode),
  ["000002", "000003"],
  "legacy v2 workspaces must reconstruct inventory shadow rows idempotently",
);

const duplicateInventory = parseInventory(
  buildInventoryMatrix([
    { code: "000100", whole: 1 },
    { code: "000100", whole: 2 },
  ]),
);
const duplicateValidation = engine.validateInputs(edgeOrders, duplicateInventory);
assert.equal(duplicateValidation.canAnalyze, false);
assert.equal(duplicateValidation.duplicateCount, 1);
assert.ok(
  duplicateValidation.errors.some(
    (issue) => issue.code === "INVENTORY_DUPLICATE_PRODUCT_CODE",
  ),
  "duplicate inventory codes must be a blocking error",
);

const dynamicInventoryHeaders = [
  "품목코드", "품목명", "규격", "수량", "1창고", "", "3서울", "4전송", "신규창고", "신규창고", "창고메모", "", "",
];
const dynamicInventoryMatrix = [
  ["동적 창고열 테스트"],
  dynamicInventoryHeaders,
  ["000010", "동적상품", "EA", -7, 0, "숨김값", 0, 0, -130, "00123", "A동", "", ""],
  ["000011", "텍스트상품", "BOX", 5, 2, "숨김값2", "", 0, "-4", "00007", "B동", "", ""],
];
const baseInventoryMatrix = dynamicInventoryMatrix.map((row, rowIndex) => {
  const copy = row.slice();
  if (rowIndex === 1) [8, 9, 10].forEach((index) => { copy[index] = ""; });
  if (rowIndex > 1) {
    [8, 9, 10].forEach((index) => { copy[index] = ""; });
    copy[3] = [4, 6, 7].reduce((sum, index) => sum + (Number(copy[index]) || 0), 0);
  }
  return copy;
});
const dynamicOrders = parseOrders(buildOrderMatrix([
  { code: "000010", quantity: 2, spec: "EA", note: "긴급출고" },
  { code: "000010", quantity: 1, spec: "EA", customer: "반복거래처", note1: "오전배송" },
  { code: "000011", quantity: 1, spec: "BOX" },
]));
const dynamicWorkspace = engine.analyze(dynamicOrders, parseInventory(dynamicInventoryMatrix), {
  sourceFingerprint: "e".repeat(64),
});
const baseDynamicWorkspace = engine.analyze(dynamicOrders, parseInventory(baseInventoryMatrix), {
  sourceFingerprint: "f".repeat(64),
});
const dynamicView = engine.getInventoryViewRows(dynamicWorkspace);
assert.deepEqual(dynamicView.headers, [
  "품목코드", "품목명", "규격", "주문수량", "잔량", "1창고", "3서울", "4전송", "신규창고", "신규창고", "창고메모",
]);
assert.deepEqual(dynamicView.columns.map((column) => column.sourceIndex), [0, 1, 2, null, 3, 4, 6, 7, 8, 9, 10]);
assert.equal(new Set(dynamicView.columns.map((column) => column.key)).size, dynamicView.columns.length);
assert.notEqual(dynamicView.columns[8].key, dynamicView.columns[9].key, "duplicate labels must remain isolated by source index");
assert.deepEqual(dynamicView.rows[0].values, ["000010", "동적상품", "EA", 3, -10, 0, 0, 0, -130, "00123", "A동"]);
assert.equal(dynamicView.rows[0].values.includes("숨김값"), false, "interior blank-header data must not shift into visible columns");
assert.equal(dynamicView.rows[0].inventoryTotal, -7, "all dynamic warehouse columns must retain signs in the arithmetic total");
assert.equal(dynamicView.rows[1].inventoryTotal, 5, "numeric text warehouse values must participate without changing source display");
assert.equal(dynamicView.rows[1].values[6], "", "blank warehouse cells must remain blank for UI color filtering");
dynamicWorkspace.orderOpsInputs = {
  schemaVersion: "orderops-analysis-inputs/v1",
  purchases: { rows: [{ productCode: "000010", quantity: 5, partner: "구매처A" }] },
  sales: { rows: [
    { productCode: "000010", productName: "동적상품", quantity: 4, partner: "판매처A" },
    { productCode: "SALE-ONLY", productName: "재고목록 외 출고상품", quantity: 6, partner: "판매처B" },
  ] },
};
const dynamicLedger = engine.getStockLedgerView(dynamicWorkspace);
assert.deepEqual(dynamicLedger.headers, ["품목코드", "품목명", "규격", "단위", "재고", "입고", "주문", "출고", "잔량", "단가", "구매처", "정보"]);
assert.deepEqual(dynamicLedger.rows[0].values, ["000010", "동적상품", "EA", "", -7, 5, 3, 4, -10, "", "구매처A", "거래처 1(2)1,000\n반복거래처(1)1,000"]);
const salesOnlyLedgerRow = dynamicLedger.rows.find((row) => row.productCode === "SALE-ONLY");
assert.deepEqual(
  salesOnlyLedgerRow?.values,
  ["SALE-ONLY", "재고목록 외 출고상품", "", "", 0, 0, 0, 6, 0, "", "", ""],
  "sales-only product codes must remain visible instead of losing outbound quantities",
);
assert.equal(salesOnlyLedgerRow?.salesOnly, true);

const editableWorkspace = engine.analyze(
  parseOrders(buildOrderMatrix([{ code: "EDIT-001", quantity: 2, price: 1000, note: "기존 전달" }])),
  parseInventory(buildInventoryMatrix([{ code: "EDIT-001", whole: 5, seoul: 0, transfer: 0 }])),
  { createdAt: "2026-08-12T00:00:00.000Z", sourceFingerprint: "7".repeat(64) },
);
const editableOrderRow = editableWorkspace.orders[0].sourceRowNumber;
engine.setOrderValue(editableWorkspace, editableOrderRow, "warehouse", "1창고");
engine.setOrderValue(editableWorkspace, editableOrderRow, "quantity", "7");
engine.setOrderValue(editableWorkspace, editableOrderRow, "unitPrice", "1200");
engine.setOrderValue(editableWorkspace, editableOrderRow, "note", "변경 전달");
engine.setOrderValue(editableWorkspace, editableOrderRow, "purchase", "구매처B");
assert.deepEqual(
  [editableWorkspace.orders[0].warehouse, editableWorkspace.orders[0].quantity,
    editableWorkspace.orders[0].unitPrice, editableWorkspace.orders[0].supplyAmount,
    editableWorkspace.orders[0].note, editableWorkspace.allocations[0].purchase],
  ["1창고", 7, 1200, 8400, "변경 전달", "구매처B"],
  "editable order values must survive the workspace recalculation",
);
assert.equal(engine.getInventoryViewRows(editableWorkspace).rows[0].remainingQuantity, -2);
assert.equal(engine.getPurchaseUploadSelection(editableWorkspace).included[0].purchaseNeed, 2);
assert.equal(editableWorkspace.notices[0].warehouse, "1창고");
assert.equal(
  dynamicView.rows[0].orderInformation,
  "거래처 1(2)1,000\n반복거래처(1)1,000",
  "inventory information must combine customer, quantity, and unit price",
);
assert.equal(dynamicView.rows[0].orderNotes, "긴급출고\n오전배송", "order notes must use a separate column");
assert.deepEqual(
  {
    allocations: dynamicWorkspace.allocations,
    validation: dynamicWorkspace.validationResults,
  },
  {
    allocations: baseDynamicWorkspace.allocations,
    validation: baseDynamicWorkspace.validationResults,
  },
  "dynamic inspection columns must not alter legacy allocation or validation",
);
assert.deepEqual(
  engine.getPurchaseUploadSelection(dynamicWorkspace).included.map((row) => [row.productCode, row.purchaseNeed]),
  [["000010", 10]],
  "negative order-aware remainder must become a positive purchase-upload quantity",
);
assert.deepEqual(
  engine.getPurchaseUploadSelection(baseDynamicWorkspace).included.map((row) => [row.productCode, row.purchaseNeed]),
  [["000010", 3]],
  "orders must create a purchase need when the base warehouse stock is insufficient",
);
assert.equal(dynamicWorkspace.stats.inventoryNegativeCount, 1);
assert.equal(baseDynamicWorkspace.stats.inventoryNegativeCount, 1);
const dynamicAllocationView = engine.getAllocationInventoryView(dynamicWorkspace);
assert.deepEqual(
  dynamicAllocationView.columns.map((column) => column.header),
  ["1창고", "3서울", "4전송", "신규창고", "신규창고"],
  "all dynamic warehouses including 4전송 must appear independently in source order",
);
assert.deepEqual(
  dynamicAllocationView.rows[0].warehouseValues,
  dynamicAllocationView.rows[1].warehouseValues,
  "repeated order lines for one product must repeat the same warehouse values",
);
const dynamicRoundTrip = JSON.parse(JSON.stringify(dynamicWorkspace));
assert.deepEqual(
  engine.getInventoryViewRows(dynamicRoundTrip).columns,
  dynamicView.columns,
  "dynamic descriptors and stable keys must survive workspace round-trip",
);
const corruptColumnMetadataWorkspace = JSON.parse(JSON.stringify(dynamicWorkspace));
corruptColumnMetadataWorkspace.sourceFiles.inventory.columns.find(
  (column) => column.role === "calculatedQuantity",
).editable = true;
assert.equal(
  engine.getInventoryColumnDescriptors(corruptColumnMetadataWorkspace).find(
    (column) => column.role === "calculatedQuantity",
  ).editable,
  false,
  "corrupt stored column metadata must be re-derived from the original header row",
);
const overrideWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
const overrideSourceBefore = JSON.stringify(overrideWorkspace.sourceFiles.inventory.matrix);
const legacyCalculationSnapshot = (workspace) => JSON.stringify({
  allocations: workspace.allocations.map((row) => [
    row.productCode, row.quantity, row.wholeAllocation, row.seoulAllocation,
    row.purchaseNeed, row.wholeRemaining, row.seoulRemaining, row.status,
  ]),
  productSummaries: workspace.productSummaries.map((row) => [
    row.productCode, row.totalOrderQuantity, row.wholeAllocation, row.seoulAllocation,
    row.purchaseNeed, row.reconciliationDifference,
  ]),
  validationResults: workspace.validationResults,
  purchaseUpload: {
    included: engine.getPurchaseUploadSelection(workspace).included.map((row) => row.productCode),
    excluded: engine.getPurchaseUploadSelection(workspace).excluded.map((row) => [row.productCode, row.reason]),
  },
});
const allocationBeforeOverrides = legacyCalculationSnapshot(overrideWorkspace);
const overrideColumns = engine.getInventoryColumnDescriptors(overrideWorkspace);
const columnByHeader = new Map(overrideColumns.map((column) => [column.header, column]));
assert.equal(columnByHeader.get("품목코드")?.role, "productCode");
assert.equal(columnByHeader.get("품목명")?.role, "productName");
assert.equal(columnByHeader.get("규격")?.role, "specification");
for (const header of ["1창고", "2전송", "3서울", "4전송", "7진영"]) {
  assert.equal(columnByHeader.get(header)?.role, "warehouseQuantity", `${header} must be a signed warehouse quantity`);
}

function sheetCellByHeader(sheet, header, rowNumber = 2) {
  const headerRow = Array.from(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, range: 0 })[0]);
  const columnIndex = headerRow.indexOf(header);
  assert.notEqual(columnIndex, -1, `missing workbook header: ${header}`);
  return sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: columnIndex })];
}
for (const header of ["기본", "전송", "창고단가"]) {
  assert.equal(columnByHeader.get(header)?.editable, true, `${header} must be editable`);
}
assert.equal(columnByHeader.get("잔량")?.role, "calculatedQuantity");
assert.equal(columnByHeader.get("주문수량")?.role, "orderQuantity");
assert.equal(columnByHeader.get("잔량")?.editable, false, "automatic balance must remain readonly");
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("2전송").key, -20);
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("기본").key, "검수기본");
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("전송").key, "검수전송");
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("창고단가").key, 4321);
engine.setPurchaseValue(overrideWorkspace, "000100", "검수구매");
const overriddenRow = engine.getInventoryViewRows(overrideWorkspace).rows.find((row) => row.productCode === "000100");
assert.equal(overriddenRow.inventoryTotal, -12, "blank warehouse cells must be zero and signed transfer warehouses must be summed");
assert.equal(overriddenRow.orderQuantity, 10);
assert.equal(overriddenRow.remainingQuantity, -22);
assert.equal(overriddenRow.values[overrideColumns.indexOf(columnByHeader.get("잔량"))], -22);
assert.equal(overriddenRow.values[overrideColumns.indexOf(columnByHeader.get("기본"))], "검수기본");
assert.equal(overriddenRow.values[overrideColumns.indexOf(columnByHeader.get("전송"))], "검수전송");
assert.equal(overriddenRow.values[overrideColumns.indexOf(columnByHeader.get("창고단가"))], 4321);
assert.equal(overriddenRow.purchase, "검수구매");
const overriddenLedger = engine.getStockLedgerView(overrideWorkspace);
const ledgerUnitPriceIndex = overriddenLedger.columns.findIndex((column) => column.role === "unitPrice");
const ledgerPurchaseIndex = overriddenLedger.columns.findIndex((column) => column.role === "purchasePlace");
const ledgerInformationIndex = overriddenLedger.columns.findIndex((column) => column.role === "orderInformation");
const overriddenLedgerRow = overriddenLedger.rows.find((row) => row.productCode === "000100");
assert.equal(overriddenLedger.columns[ledgerUnitPriceIndex].inventoryColumnKey, columnByHeader.get("창고단가").key,
  "ledger unit price must edit the same inventory price cell used by warehouse inventory");
assert.deepEqual(
  [overriddenLedgerRow.values[ledgerUnitPriceIndex], overriddenLedgerRow.values[ledgerPurchaseIndex],
    overriddenLedgerRow.values[ledgerInformationIndex]],
  [4321, "검수구매", overriddenRow.orderInformation],
  "ledger purchasing must share unit price, purchase place, and customer information with inventory",
);
assert.deepEqual(
  engine.getPurchaseUploadSelection(overrideWorkspace).included
    .filter((row) => row.productCode === "000100")
    .map((row) => row.purchaseNeed),
  [22],
  "edited stock -12 minus orders 10 must export as positive purchase quantity 22",
);
assert.equal(JSON.stringify(overrideWorkspace.sourceFiles.inventory.matrix), overrideSourceBefore, "source inventory matrix must remain byte-shape immutable");
assert.equal(
  legacyCalculationSnapshot(overrideWorkspace),
  allocationBeforeOverrides,
  "inspection overrides must never feed legacy allocation or purchase-need calculations",
);
const recoveredOverrideWorkspace = JSON.parse(JSON.stringify(overrideWorkspace));
assert.deepEqual(
  engine.getInventoryViewRows(recoveredOverrideWorkspace).rows.find((row) => row.productCode === "000100"),
  overriddenRow,
  "optional overrides must survive local/cloud compatible JSON recovery",
);
const corruptOverrideWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
corruptOverrideWorkspace.inventoryOverrides = {
  schemaVersion: engine.INVENTORY_OVERRIDE_SCHEMA_VERSION,
  cells: [{ productCode: "000100", columnKey: columnByHeader.get("2전송").key, value: "손상숫자" }],
};
assert.equal(
  engine.getInventoryViewRows(corruptOverrideWorkspace).rows.find((row) => row.productCode === "000100").inventoryTotal,
  -2,
  "corrupt numeric overrides must fall back to the original signed warehouse values",
);
assert.throws(
  () => engine.setInventoryOverride(corruptOverrideWorkspace, "000100", columnByHeader.get("2전송").key, "손상숫자"),
  /숫자 또는 빈칸/,
);
const reorderedOverrideWorkspace = JSON.parse(JSON.stringify(overrideWorkspace));
const reorderedHeader = reorderedOverrideWorkspace.sourceFiles.inventory.matrix[1];
[reorderedHeader[7], reorderedHeader[8]] = [reorderedHeader[8], reorderedHeader[7]];
const reorderedRow = engine.getInventoryViewRows(reorderedOverrideWorkspace).rows.find((row) => row.productCode === "000100");
assert.notEqual(
  reorderedRow.values[7],
  -20,
  "sourceIndex+normalized-header identity must prevent an override from moving to a reordered column",
);
const dynamicWorkbook = workbookTools.buildWorkbook(dynamicWorkspace, XLSX);
const dynamicInventorySheet = dynamicWorkbook.Sheets["창고별재고"];
assert.deepEqual(
  Array.from(XLSX.utils.sheet_to_json(dynamicInventorySheet, { header: 1, raw: true, range: "A1:N1" })[0]),
  [...dynamicView.headers, "구매", "정보", "적요"],
);
assert.equal(dynamicInventorySheet["B1"].v, "품목명");
assert.equal(dynamicInventorySheet["I1"].v, "신규창고");
assert.equal(dynamicInventorySheet["J1"].v, "신규창고");
assert.deepEqual([dynamicInventorySheet["D2"].t, dynamicInventorySheet["D2"].v], ["n", 3]);
assert.deepEqual([dynamicInventorySheet["E2"].t, dynamicInventorySheet["E2"].v], ["n", -10]);
assert.deepEqual([dynamicInventorySheet["I2"].t, dynamicInventorySheet["I2"].v], ["n", -130]);
assert.equal(dynamicInventorySheet["E2"].s.fill.fgColor.rgb, "FFF200");
assert.equal(dynamicInventorySheet["I2"].s.fill.fgColor.rgb, "FFF200");
assert.deepEqual([dynamicInventorySheet["J2"].t, dynamicInventorySheet["J2"].v], ["s", "00123"]);
assert.equal(dynamicInventorySheet["J2"].s.numFmt, "@");
assert.notEqual(dynamicInventorySheet["J2"].s.fill.fgColor.rgb, "FFF200");
assert.equal(dynamicInventorySheet["L1"].v, "구매", "reserved purchase descriptor must be appended exactly once after source columns");
assert.equal(dynamicInventorySheet["M1"].v, "정보");
assert.equal(dynamicInventorySheet["N1"].v, "적요");
assert.equal(dynamicInventorySheet["M2"].v, "거래처 1(2)1,000\n반복거래처(1)1,000");
assert.equal(dynamicInventorySheet["N2"].v, "긴급출고\n오전배송");
assert.equal(dynamicInventorySheet["M3"].v, "거래처 3(1)1,000", "nonnegative balance must retain order information");
assert.equal(dynamicInventorySheet["!ref"], "A1:N3", "inventory rows must remain one row per inventory product despite repeated orders");
const overrideInventorySheet = workbookTools.buildWorkbook(overrideWorkspace, XLSX).Sheets["창고별재고"];
assert.deepEqual(
  ["F2", "H2", "L2", "M2", "N2", "O2", "P2"].map((address) => overrideInventorySheet[address].v),
  [-22, -20, "검수기본", "검수전송", 4321, "검수구매", "같은거래처(4)1,000\n같은거래처(4)1,200\n거래처 3(2)1,000"],
  "general Excel must carry every effective override, automatic quantity, purchase, and order information",
);
assert.equal(overrideInventorySheet["P2"].s.alignment.wrapText, true, "Excel information must use full wrapped lines");
assert.equal(overrideInventorySheet["Q2"].v, "원문 적요\n원문 적요 / 원문 적요1");
assert.equal(overrideInventorySheet["F2"].s.fill.fgColor.rgb, "FFF200", "negative automatic balance must be highlighted");
const purchaseContractWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
const purchaseShapeBeforeOverride = XLSX.utils.sheet_to_json(
  workbookTools.buildPurchaseUploadWorkbook(purchaseContractWorkspace, XLSX).Sheets["구매입력"],
  { header: 1, raw: true, defval: null },
);
engine.setInventoryOverride(
  purchaseContractWorkspace,
  "000100",
  engine.getInventoryColumnDescriptors(purchaseContractWorkspace).find((column) => column.header === "2전송").key,
  -999,
);
const purchaseShapeAfterOverride = XLSX.utils.sheet_to_json(
  workbookTools.buildPurchaseUploadWorkbook(purchaseContractWorkspace, XLSX).Sheets["구매입력"],
  { header: 1, raw: true, defval: null },
);
assert.deepEqual(
  purchaseShapeAfterOverride,
  purchaseShapeBeforeOverride,
  "inventory overrides must not change the purchase-upload workbook shape or meaning",
);

const edgeWorkbook = workbookTools.buildWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(
  Array.from(edgeWorkbook.SheetNames),
  Array.from(workbookTools.REQUIRED_SHEETS),
  "workbook sheet contract changed",
);
assert.deepEqual(Array.from(workbookTools.REQUIRED_SHEETS), [
  "전달사항(적요보기)",
  "주문현황",
  "재고수불부",
  "창고별재고",
  "구매업로드",
  "판매업로드",
]);
assert.deepEqual(
  Array.from(
    XLSX.utils.sheet_to_json(edgeWorkbook.Sheets["주문현황"], { header: 1, raw: true, range: 0 })[0],
  ),
  [
    "창고", "상품코드", "품목명", "규격", "1창고", "2전송", "3서울", "4전송", "7진영",
    "주문수량", "전재고", "서울잔량", "구매수량", "구매", "거래처", "그룹", "단가", "공급가액", "적요", "적요1", "담당자",
  ],
);
assert.equal(engine.parseOrderBasisDate("2026-08-04-17"), "2026-08-04");
assert.equal(engine.parseOrderBasisDate("20260804-17"), "2026-08-04");
assert.equal(engine.parseOrderBasisDate("2026.8.4 No.17"), "2026-08-04");

for (const [purchase, expectedCount] of [
  ["대체", 1],
  ["소분", 1],
  ["대채", 2],
  ["대체 예정", 2],
  ["소분작업", 2],
  ["", 2],
]) {
  engine.setPurchaseValue(edgeWorkspace, "000100", purchase);
  assert.equal(
    engine.getPurchaseUploadSelection(edgeWorkspace).included.length,
    expectedCount,
    `${purchase || "blank"} exact exclusion rule changed`,
  );
}
engine.setPurchaseValue(edgeWorkspace, "000100", "거래처A");
assert.ok(edgeWorkspace.allocations.filter((row) => row.productCode === "000100").every((row) => row.purchase === "거래처A"));
assert.equal(edgeWorkspace.productSummaries.find((row) => row.productCode === "000100").purchase, "거래처A");
assert.equal(edgeWorkspace.purchaseManagement.find((row) => row.productCode === "000100" && row.rowType === "main").purchase, "거래처A");
const linkedPurchaseWorkbook = workbookTools.buildWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(
  [
    [
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "거래처", 2).v,
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "단가", 2).v,
      typeof sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "단가", 2).v,
    ],
    [
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "거래처", 3).v,
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "단가", 3).v,
      typeof sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "단가", 3).v,
    ],
  ],
  [
    ["같은거래처", 1000, "number"],
    ["같은거래처", 1200, "number"],
  ],
  "주문현황 workbook must split each original customer and numeric unit price",
);
assert.equal(sheetCellByHeader(linkedPurchaseWorkbook.Sheets["주문현황"], "구매", 2).v, "거래처A");
assert.equal(linkedPurchaseWorkbook.Sheets["창고별재고"].O2.v, "거래처A");
assert.equal(linkedPurchaseWorkbook.Sheets["창고별재고"].P2.v, "같은거래처(4)1,000\n같은거래처(4)1,200\n거래처 3(2)1,000");
assert.equal(linkedPurchaseWorkbook.Sheets["창고별재고"].Q2.v, "원문 적요\n원문 적요 / 원문 적요1");

const purchaseUploadWorkbook = workbookTools.buildPurchaseUploadWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(Array.from(purchaseUploadWorkbook.SheetNames), ["구매입력"]);
const purchaseUploadSheet = purchaseUploadWorkbook.Sheets["구매입력"];
assert.deepEqual(
  Array.from(XLSX.utils.sheet_to_json(purchaseUploadSheet, { header: 1, raw: true, range: "A1:T1" })[0]),
  Array.from(workbookTools.PURCHASE_UPLOAD_HEADERS),
);
for (const address of ["A1", "E1", "F1", "I1", "J1", "L1"]) {
  assert.equal(purchaseUploadSheet[address].s.font.bold, true, `${address} must retain required bold style`);
}
for (const address of ["B1", "C1", "D1", "G1", "H1", "K1", "M1", "N1", "O1", "P1", "Q1", "R1", "S1", "T1"]) {
  assert.notEqual(purchaseUploadSheet[address].s.font.bold, true, `${address} must remain a normal header`);
}
assert.deepEqual(
  ["A2", "D2", "E2", "F2", "I2", "J2", "K2"].map((address) => [purchaseUploadSheet[address].t, purchaseUploadSheet[address].v]),
  [
    ["s", "20260804"], ["s", "거래처A"], ["s", "01"], ["s", ""], ["s", "000100"],
    ["s", "상품 000100"], ["s", "EA"],
  ],
);
assert.deepEqual([purchaseUploadSheet.L2.t, purchaseUploadSheet.L2.v], ["n", 2]);
assert.deepEqual([purchaseUploadSheet.M2.t, purchaseUploadSheet.M2.v], ["n", 0]);
assert.equal(purchaseUploadSheet.L2.s.numFmt, "#,##0");
assert.equal(purchaseUploadSheet.M2.s.numFmt, "#,##0");
assert.equal(workbookTools.getPurchaseUploadFileName(edgeWorkspace), "구매업로드_20260804.xlsx");

const salesUploadWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
Object.assign(salesUploadWorkspace.allocations[0], {
  orderNumber: "2026-08-04-17",
  customer: "가거래처",
  warehouse: "01",
  unitPrice: 2500,
  supplyAmount: 10000,
  noteOriginal: "출고 전달",
  note1Original: "판매 적요",
  purchase: "매입처A",
  purchaseNeed: 2,
});
salesUploadWorkspace.allocations[1].quantity = 0;
salesUploadWorkspace.allocations[2].customer = "나거래처";
Object.assign(salesUploadWorkspace.allocations[3], {
  customer: "가거래처",
  unitPrice: null,
  supplyAmount: null,
});
salesUploadWorkspace.sourceFiles.sales = { rows: [{ productCode: "HISTORY-ONLY", quantity: 99 }] };
const salesUploadRows = workbookTools.getSalesUploadRows(salesUploadWorkspace);
assert.equal(salesUploadRows.length, 3, "sales upload must contain only current nonzero allocation rows");
assert.equal(salesUploadRows.some((row) => row.productCode === "HISTORY-ONLY"), false,
  "historical sales evidence must not be re-exported as a new sales voucher");
assert.deepEqual(
  salesUploadRows.map((row) => row.customer),
  ["가거래처", "가거래처", "나거래처"],
  "sales upload rows must be grouped in ascending customer order while retaining source order inside each customer",
);
const salesUploadSheet = workbookTools.buildSalesUploadSheet(salesUploadWorkspace, XLSX);
assert.deepEqual(
  Array.from(XLSX.utils.sheet_to_json(salesUploadSheet, { header: 1, raw: true, range: "A1:V1" })[0]),
  Array.from(workbookTools.SALES_UPLOAD_HEADERS),
);
assert.deepEqual(Array.from(workbookTools.SALES_UPLOAD_HEADERS), [
  "일자", "순번", "거래처코드", "거래처명", "출하창고", "거래유형", "전잔액", "전달사항",
  "품목코드", "품목명", "규격", "수량", "단가", "외화금액", "공급가액", "적요",
  "출고지시", "공지", "구매처", "날짜", "구매", "생산전표생성",
]);
assert.deepEqual(
  ["A2", "B2", "C2", "D2", "E2", "H2", "I2", "J2", "K2", "P2", "S2", "T2"]
    .map((address) => [salesUploadSheet[address].t, salesUploadSheet[address].v]),
  [
    ["s", "20260804"], ["s", ""], ["s", ""], ["s", "가거래처"], ["s", "01"],
    ["s", "출고 전달"], ["s", "000100"], ["s", "상품 000100"], ["s", "EA"],
    ["s", "판매 적요"], ["s", "매입처A"], ["s", "20260804"],
  ],
);
assert.deepEqual(
  ["B2", "B3", "B4"].map((address) => [salesUploadSheet[address].t, salesUploadSheet[address].v]),
  [["s", ""], ["s", ""], ["s", ""]],
  "sales upload sequence cells must remain blank",
);
assert.deepEqual(
  [salesUploadSheet.M3.t, salesUploadSheet.M3.v, salesUploadSheet.O3.t, salesUploadSheet.O3.v],
  ["s", "", "s", ""],
  "blank source unit price and amount must stay blank instead of becoming zero",
);
assert.deepEqual(
  ["L2", "M2", "O2", "U2"].map((address) => [salesUploadSheet[address].t, salesUploadSheet[address].v]),
  [["n", 4], ["n", 2500], ["n", 10000], ["n", 2]],
);
for (const address of ["E1", "I1", "J1", "L1", "M1", "O1", "P1", "E2", "I2", "J2", "L2", "M2", "O2", "P2"]) {
  assert.equal(salesUploadSheet[address].s.fill.fgColor.rgb, "FFFF00", `${address} must retain the source-template required fill`);
}
for (const address of ["A1", "E1", "F1", "I1", "J1", "L1", "M1", "O1", "P1"]) {
  assert.equal(salesUploadSheet[address].s.font.bold, true, `${address} must retain the source-template bold header`);
}

const fractionalWorkspace = engine.analyze(
  parseOrders(buildOrderMatrix([{ code: "FRACTION", quantity: 1.25, date: "2026-08-04-1" }])),
  parseInventory(buildInventoryMatrix([{ code: "FRACTION", quantity: 0, whole: 0, seoul: 0, transfer: 0 }])),
);
const fractionalPurchaseSheet = workbookTools.buildPurchaseUploadWorkbook(fractionalWorkspace, XLSX).Sheets["구매입력"];
assert.deepEqual([fractionalPurchaseSheet.L2.t, fractionalPurchaseSheet.L2.v], ["n", 1.25]);
assert.equal(fractionalPurchaseSheet.L2.s.numFmt, "#,##0.00");

const conflictingOrders = parseOrders(buildOrderMatrix([
  { code: "000100", quantity: 1, date: "2026-08-04-1" },
  { code: "000100", quantity: 1, date: "2026-08-05-2" },
]));
const conflictingWorkspace = engine.analyze(conflictingOrders, edgeInventory);
assert.equal(conflictingWorkspace.basisDateStatus, "conflict");
assert.throws(
  () => workbookTools.buildPurchaseUploadWorkbook(conflictingWorkspace, XLSX),
  /기준일/,
  "conflicting basis dates must block purchase upload",
);
assert.equal(edgeWorkbook.Sheets["주문현황"]["B2"].t, "s");
assert.equal(edgeWorkbook.Sheets["주문현황"]["B2"].v, "000100");
assert.equal(sheetCellByHeader(edgeWorkbook.Sheets["주문현황"], "주문수량", 2).v, 4);
assert.ok(edgeWorkbook.Sheets["주문현황"]["!autofilter"], "filter metadata missing");
assert.deepEqual(edgeWorkbook.Sheets["주문현황"]["!freeze"], { xSplit: 0, ySplit: 1 });

const formatOrders = parseOrders(
  buildOrderMatrix([
    { code: "PURCHASE", quantity: 2, manager: "담당A", spec: "BOX" },
    { code: "ADDITIONAL", quantity: 2, manager: "담당B", spec: "EA" },
    { code: "SEOUL", quantity: 2, manager: "담당A", spec: "소분" },
    { code: "STOCK", quantity: 2, manager: "담당C", spec: "BOX" },
    { code: "MIXED", quantity: 2, manager: "담당C", spec: "EA" },
    { code: "NO-STOCK", quantity: 1, manager: "담당D", spec: "BOX" },
  ]),
);
const formatInventory = parseInventory(
  buildInventoryMatrix([
    { code: "PURCHASE", spec: "BOX", quantity: -4, whole: 0, seoul: 0, transfer: 0, jinyeong: -4, warehousePrice: 6000 },
    { code: "ADDITIONAL", spec: "EA", quantity: 4, whole: 1, seoul: 0, transfer: 0, transfer2: 3, warehousePrice: 2000 },
    { code: "SEOUL", spec: "소분", quantity: 2, whole: 0, seoul: 3, transfer: -1, warehousePrice: 17000 },
    { code: "STOCK", spec: "BOX", quantity: 5, whole: 5, seoul: 0, transfer: 0, warehousePrice: 15000 },
    { code: "MIXED", spec: "EA", quantity: 2, whole: 1, seoul: 1, transfer: 0, warehousePrice: 8100 },
  ]),
);
const formatValidation = engine.validateInputs(formatOrders, formatInventory);
assert.equal(formatValidation.canAnalyze, true, JSON.stringify(formatValidation.errors));
const formatWorkspace = engine.analyze(formatOrders, formatInventory, {
  createdAt: "2026-08-03T00:00:00.000Z",
});
const inventorySourceSnapshot = JSON.parse(
  JSON.stringify(formatWorkspace.sourceFiles.inventory.matrix),
);
const formatWorkbook = workbookTools.buildWorkbook(formatWorkspace, XLSX);
assert.deepEqual(
  formatWorkspace.sourceFiles.inventory.matrix,
  inventorySourceSnapshot,
  "inventory source matrix must not be mutated while formatting output",
);
const originalDocument = globalThis.document;
const originalUrl = globalThis.URL;
const downloadState = { clicked: false, removed: false, appended: false, revoked: false };
const downloadAnchor = {
  href: "",
  download: "",
  style: {},
  click() {
    downloadState.clicked = true;
  },
  remove() {
    downloadState.removed = true;
  },
};
try {
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "a");
      return downloadAnchor;
    },
    body: {
      appendChild(anchor) {
        assert.equal(anchor, downloadAnchor);
        downloadState.appended = true;
      },
    },
  };
  globalThis.URL = {
    createObjectURL(blob) {
      assert.ok(blob.size > 10000);
      return "blob:shipping-test";
    },
    revokeObjectURL(url) {
      assert.equal(url, "blob:shipping-test");
      downloadState.revoked = true;
    },
  };
  const downloadedWorkbook = workbookTools.downloadWorkbook(
    formatWorkspace,
    XLSX,
    "미출고현황_브라우저테스트.xlsx",
  );
  assert.equal(downloadedWorkbook.SheetNames[0], "전달사항(적요보기)");
  assert.equal(downloadAnchor.download, "미출고현황_브라우저테스트.xlsx");
  assert.equal(downloadAnchor.href, "blob:shipping-test");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(downloadState, {
    clicked: true,
    removed: true,
    appended: true,
    revoked: true,
  });
} finally {
  globalThis.document = originalDocument;
  globalThis.URL = originalUrl;
}
const allocationSheet = formatWorkbook.Sheets["주문현황"];
assert.equal(allocationSheet["!ref"], "A1:U7");
assert.deepEqual(allocationSheet["!autofilter"], { ref: "A1:U7" });
assert.deepEqual(allocationSheet["!freeze"], { xSplit: 0, ySplit: 1 });
assert.equal(allocationSheet["B2"].t, "s");
assert.equal(allocationSheet["B2"].v, "PURCHASE");
assert.equal(sheetCellByHeader(allocationSheet, "1창고", 2).v, 0);
assert.equal(sheetCellByHeader(allocationSheet, "4전송", 2).v, 0);
assert.equal(sheetCellByHeader(allocationSheet, "7진영", 2).v, -4);
assert.equal(sheetCellByHeader(allocationSheet, "주문수량", 2).v, 2);
assert.equal(sheetCellByHeader(allocationSheet, "구매수량", 2).v, 2);
assert.equal(sheetCellByHeader(allocationSheet, "거래처", 2).v, "거래처 1");
assert.equal(sheetCellByHeader(allocationSheet, "그룹", 2).v, "기본그룹");
assert.equal(sheetCellByHeader(allocationSheet, "단가", 2).v, 1000);
assert.equal(sheetCellByHeader(allocationSheet, "담당자", 2).v, "담당A");
assert.equal(allocationSheet["A2"].s.fill.fgColor.rgb, "FFFFFF", "stable tie winner 담당A must remain white");
assert.equal(allocationSheet["A4"].s.fill.fgColor.rgb, "FFFFFF", "all rows for the dominant manager must remain white");
assert.notEqual(allocationSheet["A2"].s.fill.fgColor.rgb, allocationSheet["A3"].s.fill.fgColor.rgb);
assert.equal(allocationSheet["A5"].s.fill.fgColor.rgb, allocationSheet["A6"].s.fill.fgColor.rgb);
for (let column = 0; column < 21; column += 1) {
  const address = XLSX.utils.encode_cell({ r: 1, c: column });
  if (address === "I2") continue;
  assert.equal(
    allocationSheet[address].s.fill.fgColor.rgb,
    allocationSheet["A2"].s.fill.fgColor.rgb,
    `${address} must inherit the manager row fill`,
  );
}
assert.equal(allocationSheet["I2"].s.fill.fgColor.rgb, "FEE2E2", "negative warehouse cells must override manager fill");
for (const row of [3, 4, 6]) {
  assert.equal(allocationSheet[`A${row}`].s.font.color.rgb, "B91C1C", `EA/소분 row ${row} must use red text`);
  assert.equal(allocationSheet[`U${row}`].s.font.color.rgb, "B91C1C", `EA/소분 manager row ${row} must use red text`);
}
for (let row = 1; row <= 7; row += 1) {
  for (let column = 0; column < 21; column += 1) {
    const cell = allocationSheet[XLSX.utils.encode_cell({ r: row - 1, c: column })];
    assert.ok(cell, `allocation table cell missing at row=${row} column=${column + 1}`);
    for (const edge of ["top", "bottom", "left", "right"]) {
      assert.equal(cell.s.border[edge].style, "thin");
      assert.equal(cell.s.border[edge].color.rgb, "CBD5E1");
    }
  }
}
assert.deepEqual(allocationSheet["!margins"], {
  left: 0.25,
  right: 0.25,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3,
});
assert.deepEqual(allocationSheet["!pageSetup"], {
  paperSize: 9,
  orientation: "portrait",
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 0,
});
assert.equal(allocationSheet["!printArea"], "A1:U7");
assert.equal(allocationSheet["!printTitles"], "$1:$1");
const printNames = formatWorkbook.Workbook.Names.filter(
  (name) => name.Sheet === 1 && /^_xlnm\.Print_/.test(name.Name),
);
assert.deepEqual(printNames, [
  { Name: "_xlnm.Print_Area", Sheet: 1, Ref: "'주문현황'!$A$1:$U$7" },
  { Name: "_xlnm.Print_Titles", Sheet: 1, Ref: "'주문현황'!$1:$1" },
]);

const inventorySheet = formatWorkbook.Sheets["창고별재고"];
assert.deepEqual(
  Array.from(
    XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: true, range: "A1:Q1" })[0],
  ),
  [...INVENTORY_HEADERS.filter((header) => header !== "사용")
    .flatMap((header) => header === "수량"
      ? ["주문수량", "잔량"]
      : [header === "창고" ? "창고단가" : header]), "구매", "정보", "적요"],
);
for (let row = 2; row <= 6; row += 1) {
  assert.equal(inventorySheet[`O${row}`].v, "", "purchase column must default to blank text");
}
assert.equal(inventorySheet["A2"].t, "s");
assert.equal(inventorySheet["A2"].v, "PURCHASE");
assert.equal(inventorySheet["E2"].v, 2);
assert.equal(inventorySheet["F2"].v, -6);
assert.equal(inventorySheet["K2"].v, -4);
assert.equal(inventorySheet["F2"].s.fill.fgColor.rgb, "FFF200");
assert.equal(inventorySheet["K2"].s.fill.fgColor.rgb, "FFF200");
for (const address of ["A2", "B2", "C2", "D2", "E2", "G2", "H2", "I2", "J2", "L2", "M2", "N2", "O2", "P2", "Q2"]) {
  assert.equal(inventorySheet[address].s.fill.fgColor.rgb, "FFFFFF", `${address} must have no warehouse/manager fill`);
}
assert.equal(inventorySheet["A3"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["G3"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["A4"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["A2"].s.font.color.rgb, "1E293B");
const inventoryHeaderRow = Array.from(
  XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: true, range: 0 })[0],
);
assert.equal(inventoryHeaderRow.includes("2전송"), true, "all nonblank source inventory headers must be retained");
assert.equal(inventoryHeaderRow.at(-3), "구매", "purchase must follow all dynamic source inventory columns");
assert.equal(inventoryHeaderRow.at(-2), "정보", "customer, quantity, and unit price must be grouped in the information column");
assert.equal(inventoryHeaderRow.at(-1), "적요", "order notes must be the rightmost inventory column");
for (let row = 1; row <= 6; row += 1) {
  for (let column = 0; column < inventoryHeaderRow.length; column += 1) {
    const cell = inventorySheet[XLSX.utils.encode_cell({ r: row - 1, c: column })];
    assert.ok(cell, `inventory table cell missing at row=${row} column=${column + 1}`);
    assert.equal(cell.s.border.top.style, "thin");
    assert.equal(cell.s.border.top.color.rgb, "CBD5E1");
  }
}
const shadowInventorySheet = workbookTools.buildWorkbook(shadowWorkspace, XLSX).Sheets["창고별재고"];
assert.equal(shadowInventorySheet["A3"].v, "000002");
assert.equal(shadowInventorySheet["A3"].t, "s", "inventory-only leading zero code must remain text");
assert.equal(shadowInventorySheet["O3"].v, "재고전용거래처");
assert.equal(workbookTools.buildWorkbook(shadowWorkspace, XLSX).SheetNames.includes("발주관리"), false);
assert.equal(formatWorkbook.SheetNames.includes("검증결과"), false);
assert.equal(formatWorkbook.SheetNames.includes("주문원본"), false);
assert.equal(formatWorkbook.SheetNames.includes("상품별요약"), false);
for (const sheetName of formatWorkbook.SheetNames) {
  const sheet = formatWorkbook.Sheets[sheetName];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    const text = `${cell?.f || ""} ${cell?.v || ""}`;
    assert.doesNotMatch(text, /#REF!|#VALUE!|#DIV\/0!|#NAME\?|#N\/A/i, `${sheetName}!${address}`);
  }
}

const inventory305Rows = Array.from({ length: 305 }, (_, index) => ({
  code: `FIXTURE-305-${String(index + 1).padStart(3, "0")}`,
  name: `305행 재고상품 ${index + 1}`,
  spec: index % 2 === 0 ? "EA" : "BOX",
  whole: index === 0 ? -5 : 2,
  transfer2: index === 0 ? -3 : 0,
  seoul: 0,
  transfer: 0,
  jinyeong: 0,
}));
const inventory305Orders = parseOrders(buildOrderMatrix([{
  code: inventory305Rows[0].code,
  name: inventory305Rows[0].name,
  quantity: 2,
  spec: inventory305Rows[0].spec,
  manager: "305행 검증담당",
}]));
const inventory305Parsed = parseInventory(buildInventoryMatrix(inventory305Rows));
assert.equal(inventory305Orders.rowCount, 1, "305-row fixture must include one representative unshipped order row");
assert.equal(inventory305Parsed.rowCount, 305, "synthetic inventory fixture must parse exactly 305 data rows");
const inventory305Validation = engine.validateInputs(inventory305Orders, inventory305Parsed);
assert.equal(inventory305Validation.canAnalyze, true, JSON.stringify(inventory305Validation.errors, null, 2));
assert.equal(inventory305Validation.unmatchedCount, 0, "the representative order must match the 305-row inventory fixture");
assert.equal(
  inventory305Parsed.rows.find((row) => row.productCode === inventory305Rows[0].code).inventoryTotal,
  -8,
  "negative warehouse quantities must retain their signed arithmetic sum during parse",
);
const inventory305Workspace = engine.analyze(inventory305Orders, inventory305Parsed, {
  createdAt: "2026-08-05T00:00:00.000Z",
  sourceFingerprint: "3".repeat(64),
});
assert.equal(inventory305Workspace.stats.inventoryRowCount, 305, "analysis must preserve all 305 parsed inventory rows");
assert.equal(inventory305Workspace.stats.orderRowCount, 1, "analysis must preserve the representative unshipped row");
assert.equal(inventory305Workspace.stats.inventoryNegativeCount, 1, "negative inventory is valid review data, not an analysis blocker");
assert.equal(inventory305Workspace.allocations.length, 1, "the representative order must produce one shipping allocation row");
const inventory305ViewBefore = engine.getInventoryViewRows(inventory305Workspace);
assert.equal(inventory305ViewBefore.rows.length, 305, "the inventory review view must preserve all 305 rows");
assert.equal(inventory305ViewBefore.rows[0].productCode, "FIXTURE-305-001");
assert.equal(inventory305ViewBefore.rows.at(-1).productCode, "FIXTURE-305-305");
assert.equal(inventory305ViewBefore.rows[0].inventoryTotal, -8, "the automatic quantity must display the negative signed sum unchanged");
const inventory305Columns = engine.getInventoryColumnDescriptors(inventory305Workspace);
const inventory305QuantityColumn = inventory305Columns.find((column) => column.role === "calculatedQuantity");
const inventory305InboundColumn = inventory305Columns.find(
  (column) => column.header === "7진영" && column.role === "warehouseQuantity",
);
assert.equal(inventory305QuantityColumn?.editable, false, "the 305-row automatic quantity must remain readonly");
assert.equal(inventory305InboundColumn?.editable, true, "the positive correction must target an editable warehouseQuantity cell");
const inventory305AllocationBefore = engine.getAllocationInventoryView(inventory305Workspace);
assert.equal(inventory305AllocationBefore.rows[0].warehouseValues.at(-1), 0);
engine.setInventoryOverride(
  inventory305Workspace,
  inventory305Rows[0].code,
  inventory305InboundColumn.key,
  10,
);
const inventory305ViewAfter = engine.getInventoryViewRows(inventory305Workspace);
assert.equal(inventory305ViewAfter.rows.length, 305, "a warehouse correction must not add, drop, or merge inventory rows");
assert.equal(inventory305ViewAfter.rows[0].inventoryTotal, 2, "positive inbound stock must resolve -8 to the signed arithmetic total 2");
assert.equal(inventory305Workspace.stats.inventoryNegativeCount, 0, "negative review count must recalculate after the positive correction");
const inventory305AllocationAfter = engine.getAllocationInventoryView(inventory305Workspace);
assert.equal(
  inventory305AllocationAfter.rows[0].warehouseValues.at(-1),
  10,
  "the representative unshipped view must recalculate its warehouse display from the corrected cell",
);
const inventory305Workbook = workbookTools.buildWorkbook(inventory305Workspace, XLSX);
assert.equal(
  XLSX.utils.sheet_to_json(inventory305Workbook.Sheets["창고별재고"], { header: 1, raw: true }).length,
  306,
  "the workbook inventory sheet must contain one header plus all 305 inventory rows",
);
assert.equal(
  sheetCellByHeader(inventory305Workbook.Sheets["창고별재고"], "잔량", 2).v,
  0,
  "the workbook automatic balance must subtract the order from corrected warehouse stock",
);
assert.equal(
  sheetCellByHeader(inventory305Workbook.Sheets["주문현황"], "7진영", 2).v,
  10,
  "the workbook shipping list must show the corrected positive warehouse quantity",
);

const largeRows = Array.from({ length: 180 }, (_, index) => ({
  code: `ROW-${String(index + 1).padStart(3, "0")}`,
  quantity: 1,
  manager: `담당${index % 5}`,
  spec: index % 2 === 0 ? "BOX" : "EA",
}));
const largeOrders = parseOrders(buildOrderMatrix(largeRows));
const largeInventory = parseInventory(
  buildInventoryMatrix(
    largeRows.map((row) => ({ ...row, quantity: 2, whole: 2, seoul: 0, transfer: 0 })),
  ),
);
assert.equal(engine.validateInputs(largeOrders, largeInventory).canAnalyze, true);
const largeWorkspace = engine.analyze(largeOrders, largeInventory, {
  createdAt: "2026-08-03T00:00:00.000Z",
});
const largeWorkbook = workbookTools.buildWorkbook(largeWorkspace, XLSX);
assert.equal(largeWorkbook.Sheets["주문현황"]["!printArea"], "A1:U181");
assert.equal(largeWorkbook.Sheets["주문현황"]["!pageSetup"].fitToWidth, 1);
assert.equal(largeWorkbook.Sheets["주문현황"]["!pageSetup"].fitToHeight, 0);
assert.ok(
  largeWorkbook.Workbook.Names.some(
    (name) => name.Name === "_xlnm.Print_Area" && name.Ref === "'주문현황'!$A$1:$U$181",
  ),
);

const html = fs.readFileSync(path.join(ROOT, "orderops", "list.html"), "utf8");
const inlineScriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
assert.ok(inlineScriptMatch, "canonical ORDER Q inline application script must exist");
new vm.Script(inlineScriptMatch[1], { filename: "orderops/list.html:inline" });
assert.match(html, /brand-badge">v1\.54</, "canonical ORDER Q visible version must be v1.54");
assert.match(html, /class="brand-logo" src="\.\.\/assets\/order-q-logo\.png"/,
  "the canonical header must use the shared ORDER Q logo asset");
assert.match(html, /<h2 id="settingsModalTitle">ORDER Q 환경설정<\/h2>/,
  "the settings title must use the ORDER Q brand");
assert.match(
  html,
  /"품목명": \["품목명", "품명", "상품명", "제품명"\]/,
  "purchase and sales mappings must recognize the operational 품명 header",
);
assert.ok(
  html.includes("(!productName && !partner)"),
  "generic purchase and sales parsing must exclude workbook summary rows without row identity",
);
assert.ok(
  html.includes("const defaultAliases = DEFAULT_EXCEL_MAPPINGS[kind]?.columns?.[canonical] || []"),
  "new operational defaults must remain active when a browser still has older saved aliases",
);
const styleBlocks = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
assert.ok(styleBlocks.length > 0, "orderops/list.html must contain a style block");

function assertBalancedCssBraces(css) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const nextCharacter = css[index + 1];
    if (inComment) {
      if (character === "*" && nextCharacter === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      inComment = true;
      index += 1;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      assert.ok(depth >= 0, "orderops/list.html CSS must not contain an unmatched closing brace");
    }
  }
  assert.equal(inComment, false, "orderops/list.html CSS comment must be closed");
  assert.equal(quote, "", "orderops/list.html CSS string must be closed");
  assert.equal(depth, 0, "orderops/list.html CSS braces must be balanced");
}

styleBlocks.forEach(assertBalancedCssBraces);
const combinedCss = styleBlocks.join("\n");
assert.match(combinedCss, /table\.column-width-managed\s*\{[^}]*min-width:\s*0;/,
  "the canonical OrderOps table must allow unused space on the right");
assert.doesNotMatch(combinedCss, /table\.column-width-managed\s*\{[^}]*min-width:\s*100%;/,
  "the canonical OrderOps table must not stretch to the full viewport width");
assert.match(html, /const TABLE_WIDTH_MIN = 32;/,
  "the canonical OrderOps columns must support compact manual widths");
assert.match(html, /const tableWidth = visibleEntries\.reduce\(/,
  "the canonical OrderOps table width must equal the sum of visible column widths");
assert.match(html, /table\.style\.width = `\$\{renderedWidth\}px`;/,
  "the canonical OrderOps table must shrink with a resized column");
assert.doesNotMatch(combinedCss, /\.print-area col\s*\{[^}]*width:\s*auto\s*!important/,
  "canonical screen print must preserve saved column-width proportions");
for (const printWidthContract of [
  "function savedColumnWidth", 'widthSource: "saved"', "fitWidth: true", "sortable: false",
  'overflow: visible !important', 'white-space: normal !important',
]) {
  assert.ok(html.includes(printWidthContract),
    `canonical saved-width print contract is missing: ${printWidthContract}`);
}
for (const requiredWarehouseColorContract of [
  'id="warehouseColorBar"',
  'id="warehouseColorOptions"',
  'id="colorTargetSelect"',
  'id="pastelColorPalette"',
  'id="vividColorPalette"',
  'oneapp.orderops.warehouse-colors.v1',
  'data-warehouse-filter',
  'data-palette-color',
  'class="inventory-input"',
  'class="inventory-total-frame"',
]) {
  assert.ok(html.includes(requiredWarehouseColorContract),
    `canonical OrderOps warehouse color contract is missing: ${requiredWarehouseColorContract}`);
}
for (const requiredInteractionContract of [
  'id="managerColorOptions"',
  'id="sourceSelector"',
  'id="warehouseFilterToggle"',
  'id="managerFilterToggle"',
  'id="warehouseFilterPanel"',
  'id="managerFilterPanel"',
  'oneapp.orderops.manager-colors.v1',
  'oneapp.orderops.column-order.v1',
  'data-manager-filter',
  'id="resultFilterResetButton"',
  'id="columnSortMenu"',
  'id="purchaseAutocomplete"',
  'id="purchaseCompletionCoachmark"',
  'data-sort-direction="default"',
  'data-column-condition="excludeBlank"',
  'data-column-condition="excludeZero"',
  'data-numeric-filter-section',
  'data-text-filter-section',
  'data-column-value-search',
  'data-column-value-select-all',
  'function columnTextValueOptions',
  'function applyColumnTextFilter',
  'Array.isArray(setting?.allowedValues)',
  'state.sortSettings = Object.create(null)',
  'state.columnFilters = Object.create(null)',
  'function layeredColumnSortSettings',
  'allocations.columns[1].role = "customer"',
  'allocations.columns[2].role = "group"',
  'await restoreLocalRecord(candidate.record)',
  'data-column-drag-key',
  'analysisEnterLocked',
  'event.stopImmediatePropagation()',
  '["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"]',
  'filteredSortedPreviewPairs(state.activePreview, preview)',
  'getAllocationInventoryView(workspace)',
  'id="viewPresetSelect"',
  'id="viewPresetSaveButton"',
  'id="viewPresetDefaultButton"',
  'oneapp.orderops.order-view-presets.v1',
  'orderops-order-view-presets/v4',
  'const PREVIOUS_ORDER_VIEW_PRESETS_SCHEMA = "orderops-order-view-presets/v3"',
  'const VIEW_PRESET_TABS = new Set(["allocations", "ledger", "inventory", "purchases", "sales"])',
  'columnWidths: normalizeStoredColumnWidths(value.view.columnWidths)',
  'columnOrder: normalizeStoredColumnOrder(value.view.columnOrder)',
  'hiddenColumns: normalizeStoredColumnOrder(value.view.hiddenColumns)',
  'warehouseColors: normalizeStoredColorMap(value.view.warehouseColors, isSafeColumnKey)',
  'managerColors: normalizeStoredColorMap(value.view.managerColors, isSafeManagerName)',
  'function persistSelectedOrderViewPresetColors',
  'colors: Object.assign(Object.create(null), preset.view.warehouseColors)',
  'colors: Object.assign(Object.create(null), preset.view.managerColors)',
  'persistSelectedOrderViewPresetColors();',
  'function applyOrderViewPreset',
  'function saveCurrentOrderViewPreset',
  'function setSelectedOrderViewPresetDefault',
  'function applyDefaultOrderViewPreset',
  'function parseIntegratedExcelFile',
  'function handleIntegratedFile',
]) {
  assert.ok(html.includes(requiredInteractionContract),
    `canonical ORDER Q v1.54 interaction contract is missing: ${requiredInteractionContract}`);
}
assert.doesNotMatch(html, /<input[^>]+type="color"|data-warehouse-color|data-manager-color/,
  "canonical OrderOps filter options must remain separate from color assignment");
const canonicalViewControls = html.slice(
  html.indexOf('<div class="view-controls"'),
  html.indexOf('<div class="warehouse-color-bar"'),
);
assert.ok(canonicalViewControls.indexOf('id="columnWidthResetButton"') < canonicalViewControls.indexOf('id="warehouseFilterToggle"'),
  "canonical filter buttons must remain at the right edge after the column tools");
assert.match(combinedCss, /body\s*\{[^}]*font-size:\s*14px;/,
  "canonical OrderOps base text must increase by one pixel");
assert.match(combinedCss, /\.system-console\s*\{[^}]*font:\s*700 11px\/1\.3/,
  "System.IO status text must increase by one pixel");
assert.ok(html.includes(
  'headers: ["창고", "거래처", "그룹", "담당자", "상품코드", "품명", "규격", "정보", "주문", "단가", ...allocationWarehouseHeaders, "전달사항", "구매"]',
), "the canonical order table must include the source customer group in the approved sequence");
assert.doesNotMatch(html, /allocations\.columns\[0\]\.orderField\s*=\s*"warehouse"/,
  "the canonical order warehouse column must remain read-only");
assert.match(combinedCss, /\.purchase-input\s*\{[^}]*border:\s*0;/,
  "canonical purchase editors must not draw an inner input border");
assert.match(combinedCss, /table\.preview-inventory \.inventory-input\s*\{[^}]*border:\s*0;/,
  "canonical inventory editors must not draw an inner input border");
assert.match(combinedCss, /\.table-wrap td:focus-within\s*\{[^}]*background:\s*#edf9f7 !important;/,
  "canonical editable cells must show a light focus fill");
assert.doesNotMatch(html, /id="bundleDrop"|id="bundleInput"|Excel 묶음파일을 여기에 크게 던지기/,
  "canonical compact source strip must not retain a permanent bundle panel");
assert.match(html, /function setActiveFilterPanel\(panelName = ""\)/,
  "canonical warehouse and manager filters must be toolbar toggles");
assert.match(combinedCss, /(?:^|})\s*th\s*\{[^{}]*\bposition\s*:\s*sticky\s*;/m,
  "the current OrderOps table must keep sticky headers");
assert.match(combinedCss, /(?:^|})\s*td\s*\{[^{}]*\boverflow\s*:\s*hidden\s*;/m,
  "the current OrderOps table must keep cell overflow protection");

for (const requiredText of [
  "OrderOps",
  "주문현황",
  "창고재고",
  "엑셀출력 F10",
  "통합 검색",
  "화면인쇄 F9",
  "스마트입력",
  "구매현황",
  "판매현황",
  "통합 Excel 시트명 매칭",
  "oneapp.orderops.excel-mappings.v1",
  "oneapp.orderops.purchase-history.v1",
  "현재 파일로 교체",
  "purchaseUploadNotice",
  "ONEAPPShippingManagementDB",
  "shipping-local-recovery/v2",
  "record.payload.workspace.sourceFingerprint !== record.sourceFingerprint",
  "oneapp.shipping.recovery.pointer.v1",
  "oneapp.shipping.recovery.meta.v1",
  "oneapp.shipping.table-widths.v1",
  "shipping-table-widths/v1",
  "oneapp.orderops.hidden-columns.v1",
  "orderops-hidden-columns/v1",
  "../orderFulfillmentEngine.js",
  "../orderFulfillmentWorkbook.js",
  "../SHIPPING_MANAGEMENT_GUIDANCE.md",
]) {
  assert.ok(html.includes(requiredText), `orderops/list.html is missing: ${requiredText}`);
}

for (const id of [
  "sourceSelector", "ordersInput", "inventoryInput", "purchasesInput", "salesInput", "analyzeButton", "refreshButton",
  "ordersFileButton", "inventoryFileButton", "purchasesFileButton", "salesFileButton", "ledgerCard", "ledgerDrop", "ledgerStatus",
  "integratedCard", "integratedFileButton", "integratedInput",
  "resultFilterResetButton", "warehouseFilterToggle", "managerFilterToggle", "warehouseFilterPanel", "managerFilterPanel",
  "shortageFocusButton",
  "colorAssignmentPanel", "colorTargetSelect", "pastelColorPalette", "vividColorPalette", "vividColorToggle",
  "columnVisibilityButton", "columnWidthSaveButton", "columnWidthResetButton",
  "viewPresetSelect", "viewPresetSaveButton", "viewPresetDefaultButton", "viewPresetDeleteButton", "viewPresetDialog", "viewPresetNameInput",
  "downloadButton", "printButton",
  "headerCloudLoadButton", "headerCloudSaveButton",
  "headerRestoreButton", "headerSettingsButton", "settingsModal", "workspaceStorage",
  "excelMappingEditor", "sheetAliasWarning", "mappingSaveButton", "mappingResetButton",
]) {
  assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} must exist exactly once`);
}
assert.doesNotMatch(html, /id="bundleInput"|id="bundleDrop"/,
  "the auto-routing drop surface must reuse the visible five-card strip");
for (const kind of ["orders", "inventory", "purchases", "sales"]) {
  assert.ok(html.includes(`id="${kind}Input" type="file" accept=".xlsx,.xls">`),
    `${kind} input must remain a single-file picker`);
}
assert.ok(html.includes('id="integratedInput" type="file" accept=".xlsx,.xls">'),
  "integrated upload must remain a single-workbook picker");
assert.match(combinedCss, /\.execution-panel\s*\{[^}]*grid-template-columns:\s*repeat\(2,[^}]*border:\s*0;/,
  "canonical analysis and refresh actions must be two buttons without a shared outer border");
assert.match(combinedCss, /\.upload-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,/,
  "canonical upload strip must contain exactly five result tabs");
assert.match(combinedCss, /\.integrated-compact-slot\s*\{[^}]*display:\s*inline-flex;/,
  "canonical integrated workbook control must be a compact data-source picker");
assert.doesNotMatch(combinedCss, /\.integrated-uploader\s*\{/,
  "canonical large integrated uploader styling must be removed");
const canonicalHeaderSource = html.slice(html.indexOf('<header class="global-header">'), html.indexOf('</header>'));
assert.ok(canonicalHeaderSource.indexOf('id="smartInputButton"') < canonicalHeaderSource.indexOf('id="printButton"'),
  "canonical Smart input F4 must move before screen print in the global header");
for (const transactionViewContract of [
  'function buildTransactionPreview(workspace, kind)',
  'purchases: buildTransactionPreview(workspace, "purchases")',
  'sales: buildTransactionPreview(workspace, "sales")',
  'headers: ["원본행", "상품코드", "품명", isPurchase ? "구매처" : "거래처", "수량"]',
]) {
  assert.ok(html.includes(transactionViewContract), `purchase/sales result view is missing: ${transactionViewContract}`);
}
for (const ledgerContract of ['label: "수불현황"', 'label: "창고별재고"', "getStockLedgerView(workspace)", "orderops-analysis-inputs/v1"]) {
  assert.ok(html.includes(ledgerContract), `stock-ledger contract is missing: ${ledgerContract}`);
}
for (const ledgerPurchasingContract of [
  'column.role === "unitPrice"', 'column.role === "orderInformation"',
  'purchaseEditable: ledgerPurchaseIndex >= 0', 'renderOrderInformationBadges(displayValue)',
  '["inventory", "ledger"].includes(state.activePreview)',
  'getShortageCategoryContext(workspace)', 'column.role === "rowState"',
  'block: "center"', 'class="inventory-total-frame"', '재고부족 모아보기',
]) {
  assert.ok(html.includes(ledgerPurchasingContract), `ledger purchasing contract is missing: ${ledgerPurchasingContract}`);
}
const inventoryRowStateStart = html.indexOf("function inventoryRowState");
const inventoryRowStateEnd = html.indexOf("function decorateShortageRow", inventoryRowStateStart);
assert.ok(inventoryRowStateStart >= 0 && inventoryRowStateEnd > inventoryRowStateStart,
  "inventory row-state renderer must exist");
const inventoryRowStateSource = html.slice(inventoryRowStateStart, inventoryRowStateEnd);
assert.match(inventoryRowStateSource, /return "대체상품";/,
  "same-category reference rows must be identified as 대체상품");
assert.match(inventoryRowStateSource, /return "재고정보 없음";/,
  "shortage focus must retain the missing-inventory filter value");
assert.match(inventoryRowStateSource, /return "부족상품";/,
  "shortage focus must retain the shortage filter value");
assert.doesNotMatch(inventoryRowStateSource, /주문상품 ·/,
  "the 구분 column must not repeat the generic ordered-product chip on every shortage row");
assert.doesNotMatch(inventoryRowStateSource, /대체후보/,
  "the 구분 column must use 대체상품 instead of the ambiguous 대체후보 label");
assert.match(inventoryRowStateSource, /return "주문 없음 · 재고 0";[\s\S]*return "주문 없음";/,
  "existing 주문 없음 row-state values must remain available to the filter");
assert.doesNotMatch(combinedCss, /tr\.shortage-category-start td\s*\{|border-top:\s*3px solid var\(--shortage-category-color/,
  "shortage categories must not draw distracting horizontal color dividers");
assert.match(combinedCss, /tr\.shortage-category-row td:first-child\s*\{[\s\S]*?inset 3px 0 0 var\(--shortage-category-color/,
  "shortage categories must retain only a quiet leading vertical rail");
assert.ok(html.includes('data-shortage-category="${escapeHtml(shortageCategory)}"') &&
  html.includes('const SHORTAGE_CATEGORY_COLORS = Object.freeze(['),
  "shortage rows must expose deterministic multi-color category rails");
assert.ok(html.includes('column.role === "rowState"') &&
  html.includes('? ""') && !html.includes("renderRowStateBadges"),
  "the 구분 column must keep filter values in row data without rendering any state chips");
assert.ok(html.includes('elements.viewPresetSaveButton.disabled = !state.workspace || !VIEW_PRESET_TABS.has(state.activePreview)') &&
  html.includes('columnWidths: normalizeStoredColumnWidths(value.view.columnWidths)') &&
  html.includes('columnOrder: normalizeStoredColumnOrder(value.view.columnOrder)'),
  "all five result screens must save their filters, widths, and column positions as one layout");
assert.ok(html.includes('isDefault: value.isDefault === true') &&
  html.includes('preset.isDefault ? "★ " : ""') &&
  html.includes('candidate.previewId === previewId && candidate.isDefault === true') &&
  html.includes('if (!applyDefaultOrderViewPreset(previewId, { render: true })) renderPreview();'),
  "one saved layout per result screen must be selectable as the automatic default");
assert.match(html, /\.column-sort-trigger\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?visibility:\s*hidden;/,
  "filter controls must remain hidden until the pointer reaches the header");
assert.match(html, /th:hover \.column-sort-trigger,[\s\S]*?opacity:\s*1;/,
  "filter controls must appear on header hover");
assert.match(html, /\.column-sort-trigger\s*\{[\s\S]*?right:\s*1px;[\s\S]*?width:\s*24px;[\s\S]*?height:\s*18px;/,
  "filter controls must remain compact and attached to the right edge of narrow headers");
assert.doesNotMatch(html, /data-sort-header-preview-id=|function cycleColumnSort/,
  "header body clicks must not sort outside the filter control");
assert.ok(html.includes('data-text-filter-section data-value-filter-section') &&
  html.includes('querySelector("[data-text-filter-section]").classList.remove("hidden")'),
  "numeric and text columns must both expose Excel-style cell-value selection");
assert.doesNotMatch(html, /purchase-required-badge|inventory-unavailable-value|>발주 \$\{/,
  "quantity cells must not replace signed numeric results with explanatory text");
assert.ok(html.includes('column.role === "salesQuantity" ? "출고"') &&
  html.includes('column.role === "calculatedQuantity" ? "잔량"'),
  "stock-ledger headers must use 출고 and 잔량");
assert.ok(html.includes('column?.role === "calculatedQuantity" && state.warehouseFilters.size > 0') &&
  (html.match(/\? "잔량"/g) || []).length >= 2,
  "warehouse inventory must use the 잔량 header with or without a warehouse filter");
assert.ok(html.includes('const displayValue = quantityColumn && numericQuantityValue === 0 ? "" : value;'),
  "zero quantity cells must render as blank without changing the underlying value");
assert.ok(html.includes('["productCode", "productName", "specification", "orderQuantity"].includes(column.role)') &&
  html.includes('orderedContext ? "ordered-context-cell"'),
  "ordered rows must share one context fill from product code through order quantity");
assert.ok(html.includes('const negativeRemaining = ["inventory", "ledger"].includes(previewId)') &&
  html.includes('negativeRemaining ? "ledger-negative-cell"') &&
  html.includes('purchaseNegative ? "purchase-negative-cell"'),
  "negative warehouse and ledger balances must share the purchase-place highlight");
assert.match(combinedCss, /\.purchase-input\[data-negative-balance="true"\]\s*\{[^}]*background:\s*#fef9c3;[^}]*box-shadow:\s*none;/,
  "negative purchase cells must retain only the pale fill without an internal horizontal rule");
assert.match(combinedCss, /td\.ledger-negative-cell \.inventory-total-frame\s*\{[^}]*background:\s*#fef9c3\s*!important;[^}]*box-shadow:\s*none;/,
  "negative balance cells must retain only the pale fill without an internal vertical rule");
assert.ok(html.includes('specification === "EA" || specification === "소분"') &&
  html.includes('const warningUnitContext = exactWarningUnit(sourceRow)') &&
  html.includes('["productName", "specification"].includes(column.role) || quantityColumn') &&
  html.includes('warningUnitContext ? "unit-alert-cell"'),
  "EA and 소분 rows must use red text for product name, specification, order, stock, and balance quantities");
assert.match(combinedCss, /td\.unit-alert-cell \.inventory-total-frame\s*\{[^}]*color:\s*#b91c1c\s*!important;/,
  "EA and 소분 quantity frames must keep red text even when quantity-zero styling is also present");
assert.match(combinedCss, /td\.unit-alert-cell[\s\S]*?\.inventory-total-frame\s*\{[^}]*font-weight:\s*400\s*!important;/,
  "EA and 소분 emphasis must use normal font weight");
assert.ok(html.includes('const boxUnitContext = exactBoxUnit(sourceRow) &&') &&
  html.includes('["productName", "specification"].includes(column.role)') &&
  html.includes('boxUnitContext ? "box-unit-cell"'),
  "exact BOX product-name and specification cells must receive their own bold black emphasis class");
assert.match(combinedCss, /td\.box-unit-cell\s*\{[^}]*color:\s*#0f172a\s*!important;[^}]*font-weight:\s*900;/,
  "BOX product-name and specification text must be bold black");
assert.ok(html.includes('const readablePrimary = ["productName", "specification"].includes(column.role) || quantityColumn') &&
  html.includes('readablePrimary ? "primary-readable-cell"'),
  "product name, specification, and quantity text must use the larger readable table size");
assert.match(combinedCss, /td\.primary-readable-cell,[\s\S]*?font-size:\s*13px;/,
  "primary item and quantity text must be slightly larger than the base table text");
assert.ok(html.includes('class="order-information-quantity"') && html.includes('class="order-information-price"'),
  "order information badges must separate quantity and unit-price metrics");
assert.match(combinedCss, /\.order-information-quantity,[\s\S]*?\.order-information-price\s*\{\s*font-size:\s*10px;/,
  "order information unit price must use the same compact size as quantity");
assert.ok(html.includes("const allocationProductSummaries = new Map();") &&
  html.includes("summary.rowCount += 1;") &&
  html.includes("summary.quantity += parsedQuantity.ok ? parsedQuantity.value : 0;") &&
  html.includes("productCode && summary && !allocationAggregateShown.has(productCode)") &&
  html.includes('allocations.columns[7].role = "productAggregateQuantity"') &&
  html.includes("row.productAggregateQuantity"),
  "order information must show every product-code quantity total once on its first order row");
assert.ok(html.includes('elements.systemViewNote.textContent = viewNotes.join(" · ")') &&
  html.includes('elements.previewCount.textContent = `${formatNumber(pairs.length)}/${formatNumber(preview.rows.length)}행`;'),
  "dynamic view guidance must move to the System.IO top bar while the table toolbar keeps only the row count");
assert.match(combinedCss, /\.print-area table\s*\{[\s\S]*?font-size:\s*10\.6px;/,
  "canonical screen print text must be twenty percent larger than v1.35");
assert.match(combinedCss, /table\.preview-allocations\s*\{[\s\S]*?font-size:\s*11\.9px;/,
  "canonical order-status print text must be twenty percent larger than v1.35");

const layeredSortHelperStart = html.indexOf("function compareProductCodes");
const layeredSortHelperEnd = html.indexOf("function filteredSortedPreviewPairs", layeredSortHelperStart);
assert.ok(layeredSortHelperStart >= 0 && layeredSortHelperEnd > layeredSortHelperStart,
  "layered order sorting helpers must exist");
const layeredSortContext = {};
vm.runInNewContext(`
  const state = {
    shortageFocus: false,
    sortSettings: { allocations: { columnKey: "group", direction: "asc" } },
  };
  ${html.slice(layeredSortHelperStart, layeredSortHelperEnd)}
  const preview = {
    sortByProductCode: true,
    columns: [
      { key: "warehouse", role: "warehouse" },
      { key: "customer", role: "customer" },
      { key: "group", role: "group" },
      { key: "manager", role: "manager" },
      { key: "productCode", role: "productCode" },
    ],
  };
  const pairs = [
    { index: 0, row: ["01", "거래처B", "그룹A", "담당", "200"], sourceRow: { id: "r1", productCode: "200" } },
    { index: 1, row: ["01", "거래처A", "그룹B", "담당", "100"], sourceRow: { id: "r2", productCode: "100" } },
    { index: 2, row: ["01", "거래처A", "그룹A", "담당", "300"], sourceRow: { id: "r3", productCode: "300" } },
    { index: 3, row: ["01", "거래처A", "그룹A", "담당", "100"], sourceRow: { id: "r4", productCode: "100" } },
  ];
  this.groupCriteria = layeredColumnSortSettings("allocations", preview).map((setting) =>
    preview.columns.find((column) => column.key === setting.columnKey).role);
  this.groupOrder = [...pairs].sort((left, right) => comparePreviewPairs("allocations", preview, left, right))
    .map((pair) => pair.sourceRow.id);
  delete state.sortSettings.allocations;
  this.defaultOrder = [...pairs].sort((left, right) => comparePreviewPairs("allocations", preview, left, right))
    .map((pair) => pair.sourceRow.id);
  state.sortSettings.allocations = { columnKey: "customer", direction: "desc" };
  this.customerCriteria = layeredColumnSortSettings("allocations", preview).map((setting) =>
    preview.columns.find((column) => column.key === setting.columnKey).role);
  this.customerOrder = [...pairs].sort((left, right) => comparePreviewPairs("allocations", preview, left, right))
    .map((pair) => pair.sourceRow.id);
`, layeredSortContext);
assert.deepEqual(Array.from(layeredSortContext.groupCriteria), ["group", "customer", "productCode"]);
assert.deepEqual(Array.from(layeredSortContext.groupOrder), ["r4", "r3", "r1", "r2"],
  "group sorting must nest customer and product-code sorting in that priority order");
assert.deepEqual(Array.from(layeredSortContext.defaultOrder), ["r2", "r4", "r1", "r3"],
  "order status must default to product-code sorting");
assert.deepEqual(Array.from(layeredSortContext.customerCriteria), ["customer", "productCode"]);
assert.deepEqual(Array.from(layeredSortContext.customerOrder), ["r1", "r2", "r4", "r3"],
  "customer sorting must retain product code as its final tie-breaker");

const presetHelperStart = html.indexOf("function isPlainRecord");
const presetHelperEnd = html.indexOf("function loadWarehouseColorSettings", presetHelperStart);
assert.ok(presetHelperStart >= 0 && presetHelperEnd > presetHelperStart,
  "order-view preset normalization helpers must exist");
const presetContext = {};
vm.runInNewContext(`const TABLE_WIDTH_MIN = 32;
  const TABLE_WIDTH_MAX = 720;
  const VIEW_PRESET_TABS = new Set(["allocations", "ledger", "inventory", "purchases", "sales"]);
  ${html.slice(presetHelperStart, presetHelperEnd)}
  this.normalizedPreset = normalizeOrderViewPreset({
    id: "view-test", name: "부족상품", isDefault: true, updatedAt: "2026-08-14T00:00:00.000Z",
    previewId: "inventory",
    view: {
      searchQuery: "양파", shortageFocus: true,
      specificationFilters: ["BOX", "BOX"], managerFilters: ["담당A"], warehouseFilters: ["wh:1"],
      sortSetting: { columnKey: "shipping:allocations:7:주문", direction: "desc" },
      columnFilters: {
        "shipping:allocations:7:주문": { excludeBlank: true, excludeZero: true, allowedValues: ["[\\\"value\\\",\\\"2\\\"]"] },
        "__proto__": { excludeBlank: true }
      },
      layoutCaptured: true,
      columnWidths: { "shipping:inventory:1:품명": 245, "__proto__": 100 },
      columnOrder: ["shipping:inventory:1:품명", "shipping:inventory:0:상품코드"],
      hiddenColumns: ["shipping:inventory:9:정보"],
      colorSettingsCaptured: true,
      warehouseColors: { "shipping:inventory:4:1창고": "#DDEEFF", constructor: "#112233" },
      managerColors: { "담당A": "#AaBbCc", prototype: "#445566" }
    }
  });`, presetContext);
assert.equal(presetContext.normalizedPreset.name, "부족상품");
assert.equal(presetContext.normalizedPreset.previewId, "inventory");
assert.equal(presetContext.normalizedPreset.isDefault, true);
assert.deepEqual(Array.from(presetContext.normalizedPreset.view.specificationFilters), ["BOX"]);
assert.equal(presetContext.normalizedPreset.view.sortSetting.direction, "desc");
assert.equal(presetContext.normalizedPreset.view.columnWidths["shipping:inventory:1:품명"], 245);
assert.deepEqual(Array.from(presetContext.normalizedPreset.view.columnOrder), [
  "shipping:inventory:1:품명", "shipping:inventory:0:상품코드",
]);
assert.deepEqual(Array.from(presetContext.normalizedPreset.view.hiddenColumns), ["shipping:inventory:9:정보"]);
assert.equal(presetContext.normalizedPreset.view.colorSettingsCaptured, true);
assert.equal(presetContext.normalizedPreset.view.warehouseColors["shipping:inventory:4:1창고"], "#ddeeff");
assert.equal(presetContext.normalizedPreset.view.managerColors["담당A"], "#aabbcc");
assert.equal(Object.prototype.hasOwnProperty.call(presetContext.normalizedPreset.view.warehouseColors, "constructor"), false,
  "saved view presets must reject unsafe warehouse color keys");
assert.equal(Object.prototype.hasOwnProperty.call(presetContext.normalizedPreset.view.managerColors, "prototype"), false,
  "saved view presets must reject unsafe manager color keys");
assert.equal(Object.prototype.hasOwnProperty.call(presetContext.normalizedPreset.view.columnFilters, "__proto__"), false,
  "saved view presets must reject unsafe filter keys");

const administratorAliasMatrix = buildCanonicalOrderMatrix({
  replacements: {
    "품목코드": "관리SKU", "품목명": "관리상품", "규격": "관리사양", "수량": "관리Qty",
    "적요": "관리메모", "적요1": "관리보조", "거래처": "관리고객", "그룹": "관리분류",
  },
});
const administratorAliasOrders = engine.parseOrderWorkbook({
  fileName: "관리주문.xlsx", sheetName: "사용자시트",
  rawMatrix: administratorAliasMatrix, displayMatrix: administratorAliasMatrix,
  headerAliases: {
    "품목코드": ["관리SKU"], "품목명": ["관리상품"], "규격": ["관리사양"], "수량": ["관리Qty"],
    "적요": ["관리메모"], "적요1": ["관리보조"], "거래처": ["관리고객"], "그룹": ["관리분류"],
  },
});
assert.equal(administratorAliasOrders.errors.length, 0, "administrator order column aliases must reach the real parser");
assert.equal(administratorAliasOrders.rows[0].productCode, "ALIAS-001");
assert.equal(administratorAliasOrders.headers.includes("관리SKU"), true, "administrator aliases must not rename source headers");

const administratorInventoryMatrix = [
  ["관리SKU", "관리상품", "관리사양", "관리합계", "A보관"],
  ["ALIAS-001", "별칭 상품", "EA", 4, 4],
];
const administratorAliasInventory = engine.parseInventoryWorkbook({
  fileName: "관리재고.xlsx", sheetName: "사용자재고",
  rawMatrix: administratorInventoryMatrix, displayMatrix: administratorInventoryMatrix,
  headerAliases: { "품목코드": ["관리SKU"], "품목명": ["관리상품"], "규격": ["관리사양"], "수량": ["관리합계"] },
});
assert.equal(administratorAliasInventory.errors.length, 0, "administrator inventory aliases must reach the real parser");
assert.equal(administratorAliasInventory.rows[0].inventoryTotal, 4);

const classifyStart = html.indexOf("async function classifyBundleFile");
const classifyEnd = html.indexOf("async function handleBundleFiles", classifyStart);
assert.ok(classifyStart >= 0 && classifyEnd > classifyStart, "bundle classifier must exist");
const classifySource = html.slice(classifyStart, classifyEnd);
for (const requiredSource of [
  "Promise.all([",
  'parseExcelFile(file, "orders")',
  'parseExcelFile(file, "inventory")',
  'parseGenericExcelFile(file, "purchases")',
  'parseGenericExcelFile(file, "sales")',
  "orderSignature",
  "inventorySignature",
  "topStructureScore",
  "bestSheetHint",
  "bestFileHint",
]) {
  assert.ok(classifySource.includes(requiredSource), `bundle classifier is missing: ${requiredSource}`);
}

const bundleStart = html.indexOf("async function handleBundleFiles");
const bundleEnd = html.indexOf("function toggleWorkspaceStorage", bundleStart);
assert.ok(bundleStart >= 0 && bundleEnd > bundleStart, "bundle handler must exist");
const bundleSource = html.slice(bundleStart, bundleEnd);
for (const requiredSource of [
  "files.length < 1 || files.length > 4",
  "Promise.all(files.map(classifyBundleFile))",
  "const byKind = new Map();",
  "byKind.has(item.kind)",
  "byKind.forEach((parsed, kind) => { state[kind] = parsed; });",
  "refreshInputState();",
]) {
  assert.ok(bundleSource.includes(requiredSource), `bundle handler is missing: ${requiredSource}`);
}

const dropBindingStart = html.indexOf("function bindDropZone");
assert.ok(dropBindingStart >= 0, "four-way drop binding must exist");
const dropBindingSource = html.slice(dropBindingStart, html.indexOf("elements.headerSettingsButton", dropBindingStart));
assert.ok(dropBindingSource.includes("function bindBundleDropSurface()"), "the existing source strip drop binding must exist");
assert.ok(dropBindingSource.includes('drop.classList.add("bundle-dragover")'), "the source strip must show feedback only while dragging");
assert.ok(dropBindingSource.includes("handleBundleFiles(event.dataTransfer.files)"), "the full source strip must auto-route dropped files");
assert.ok(html.includes("FILE_KINDS.forEach(bindDropZone)"), "all four named slots must use the single-file binding");
assert.ok(html.includes("bindLedgerViewCard();"), "the derived stock-ledger card must be initialized as a result tab");
assert.ok(html.includes('fileButton.addEventListener("click", () => input.click())'),
  "the small file control must remain separate from source-card navigation");
assert.ok(html.includes("bindBundleDropSurface();"), "the compact source-strip drop target must be initialized");

const individualStart = html.indexOf("async function handleFile");
const individualEnd = html.indexOf("function renderFileCard", individualStart);
assert.ok(individualStart >= 0 && individualEnd > individualStart, "individual upload handler must exist");
const individualSource = html.slice(individualStart, individualEnd);
for (const requiredSource of [
  "isSupportedFile(file)",
  "file.size > MAX_FILE_SIZE",
  "resetResults();",
  "setLoading(kind, true);",
  '["orders", "inventory"].includes(kind)',
  "await parseGenericExcelFile(file, kind)",
  "state[kind] = null;",
  "refreshInputState();",
]) {
  assert.ok(individualSource.includes(requiredSource), `individual upload flow is missing: ${requiredSource}`);
}
const integratedParseStart = html.indexOf("async function parseIntegratedExcelFile");
const integratedParseEnd = html.indexOf("async function classifyBundleFile", integratedParseStart);
assert.ok(integratedParseStart >= 0 && integratedParseEnd > integratedParseStart,
  "integrated workbook parser must exist before the legacy multi-file classifier");
const integratedParseSource = html.slice(integratedParseStart, integratedParseEnd);
for (const integratedContract of [
  "workbook.SheetNames.forEach", "sheetAliasMatchScore(sheetName", "integratedCandidateScore",
  "필수 열·헤더 구조 검증에 실패했습니다", "applied.set(selected.kind, selected.parsed)",
  "selected.parsed.sourceLabel", "failures", "ignored",
]) {
  assert.ok(integratedParseSource.includes(integratedContract),
    `integrated workbook sheet contract is missing: ${integratedContract}`);
}
const integratedHandleStart = html.indexOf("async function handleIntegratedFile");
const integratedHandleEnd = html.indexOf("function renderFileCard", integratedHandleStart);
const integratedHandleSource = html.slice(integratedHandleStart, integratedHandleEnd);
assert.ok(integratedHandleSource.includes("result.applied.forEach") &&
  integratedHandleSource.includes("오류 ${result.failures.length}개 시트는 기존 데이터 유지") &&
  !integratedHandleSource.includes("state[kind] = null"),
  "integrated upload must replace only successfully validated data kinds and preserve failed active data");
for (const integratedMappingContract of [
  'sheetAliases: ["주문", "미출고", "주문현황"]',
  'sheetAliases: ["재고", "전체재고", "창고재고"]',
  'sheetAliases: ["구매", "매입", "전송구매"]',
  'sheetAliases: ["판매", "판매입력", "전송출고"]',
  "시트명 매칭 <span>→</span> 헤더·필수열 검증 <span>→</span> 데이터 종류 확정",
  "function sheetAliasConflicts(types)",
  "function sheetAliasMatchScore(value, aliases)",
  "function renderSheetAliasWarning(conflicts)",
  'showToast("중복된 통합 시트명 별칭을 정리한 후 저장하세요.", true)',
]) {
  assert.ok(html.includes(integratedMappingContract),
    `integrated workbook mapping contract is missing: ${integratedMappingContract}`);
}
const integratedBindStart = html.indexOf("function bindIntegratedFileCard");
const integratedBindEnd = html.indexOf("function bindBundleDropSurface", integratedBindStart);
const integratedBindSource = html.slice(integratedBindStart, integratedBindEnd);
assert.ok(integratedBindSource.includes('elements.integratedFileButton.addEventListener("click", openPicker)'),
  "the compact integrated folder button must open its workbook picker");
assert.doesNotMatch(integratedBindSource, /integratedDrop|dragenter|dragleave|addEventListener\("drop"/,
  "the removed large integrated drop zone must not retain event bindings");

const settingsStart = html.indexOf("function toggleWorkspaceStorage");
const settingsEnd = html.indexOf("function setLoading", settingsStart);
assert.ok(settingsStart >= 0 && settingsEnd > settingsStart, "settings toggle must exist");
const settingsSource = html.slice(settingsStart, settingsEnd);
assert.ok(settingsSource.includes('classList.toggle("hidden", !open)'), "settings panel visibility toggle is missing");
assert.ok(settingsSource.includes('setAttribute("aria-expanded", String(open))'), "settings control must update aria-expanded");
assert.match(html, /id="settingsModal"[\s\S]*role="dialog" aria-modal="true"/, "settings must open as a modal dialog");
for (const contract of [
  "normalizeExcelMappingRecord", "saveExcelMappingsFromEditor", "headerAliases",
  "handleInventoryGridArrowNavigation", "autocompletePurchaseInput", "rememberPurchaseName",
  "purchaseAutocompleteNames", "handlePurchaseAutocompleteKeyboard", "finishPurchaseEntry",
  "showPurchaseCompletionCoachmark",
  "function resetResultViewFilters()", 'grid-template-columns: repeat(2, minmax(0, 1fr))',
]) {
  assert.ok(html.includes(contract), `ORDER Q v1.54 contract is missing: ${contract}`);
}
const purchaseAutocompleteStart = html.indexOf("function purchaseAutocompleteNames");
const purchaseAutocompleteEnd = html.indexOf("function closePurchaseAutocomplete", purchaseAutocompleteStart);
assert.ok(purchaseAutocompleteStart >= 0 && purchaseAutocompleteEnd > purchaseAutocompleteStart,
  "purchase autocomplete source must exist");
const purchaseAutocompleteSource = html.slice(purchaseAutocompleteStart, purchaseAutocompleteEnd);
assert.ok(purchaseAutocompleteSource.includes("state.purchaseHistory"),
  "purchase autocomplete must use previously confirmed purchase-place names");
assert.doesNotMatch(purchaseAutocompleteSource, /workspace\.orders|customer|거래처/,
  "purchase autocomplete must not use order-customer names before a supplier master exists");
const purchaseCompletionStart = html.indexOf("function finishPurchaseEntry");
const purchaseCompletionEnd = html.indexOf("function focusInventoryInput", purchaseCompletionStart);
assert.ok(purchaseCompletionStart >= 0 && purchaseCompletionEnd > purchaseCompletionStart,
  "purchase completion audit must exist");
const purchaseCompletionSource = html.slice(purchaseCompletionStart, purchaseCompletionEnd);
assert.ok(purchaseCompletionSource.includes("requiredInputs.find") &&
  purchaseCompletionSource.includes("focusPurchaseInput(missing)"),
  "purchase completion must return to the first missing shortage purchase place");
assert.ok(purchaseCompletionSource.includes("previewTable.scrollTo") &&
  purchaseCompletionSource.includes("window.scrollTo") &&
  purchaseCompletionSource.includes("showPurchaseCompletionCoachmark"),
  "completed purchase entry must scroll both views to the top and show temporary guidance");
assert.ok(html.includes('id="warehouseColorResetButton" type="button">전체 다시보기</button>'),
  "filter reset must be presented as returning to the full view");
assert.ok(html.includes("색 선택 즉시 저장·적용"),
  "filter color persistence and immediate application must be visible to operators");
const resultResetStart = html.indexOf("function runResultFilterReset()");
const resultResetEnd = html.indexOf("async function analyzeCurrentInputs", resultResetStart);
assert.ok(resultResetStart >= 0 && resultResetEnd > resultResetStart, "F2 result-filter reset handler must exist");
const resultResetSource = html.slice(resultResetStart, resultResetEnd);
assert.ok(resultResetSource.includes("resetResultViewFilters()") && resultResetSource.includes("renderPreview()"),
  "F2 must clear search and every view filter, then redraw the table");
assert.equal(resultResetSource.includes("saveManagerColorSettings"), false,
  "F2 reset must preserve saved manager colors");
assert.equal(resultResetSource.includes("saveWarehouseColorSettings"), false,
  "F2 reset must preserve saved warehouse colors");
const colorResetStart = html.indexOf('elements.warehouseColorResetButton.addEventListener("click"');
const colorResetEnd = html.indexOf("elements.columnVisibilityButton.addEventListener", colorResetStart);
assert.ok(colorResetStart >= 0 && colorResetEnd > colorResetStart, "filter reset handler must exist");
const colorResetSource = html.slice(colorResetStart, colorResetEnd);
assert.ok(colorResetSource.includes("state.managerFilters.clear()") && colorResetSource.includes("state.warehouseFilters.clear()"),
  "full view must clear warehouse and manager filters");
assert.equal(colorResetSource.includes("saveManagerColorSettings"), false,
  "full view must preserve saved manager colors");
assert.equal(colorResetSource.includes("saveWarehouseColorSettings"), false,
  "full view must preserve saved warehouse colors");

for (const firstViewContract of [
  'class="validation-notice-summary"',
  'id="validationNoticeHeading">전달사항(적요보기)',
  'state.activePreview === "validation"',
]) {
  assert.ok(html.includes(firstViewContract), `OrderOps first-view notice contract is missing: ${firstViewContract}`);
}
assert.doesNotMatch(html, /<datalist[^>]+purchaseSupplierHistory|list="purchaseSupplierHistory"|title="\$\{escapeHtml\(value\)\}"/,
  "purchase entry and data cells must not open cell-obscuring bubbles");

const localWorkspaceStart = html.indexOf("async function persistLocalWorkspace");
const localWorkspaceEnd = html.indexOf("function scheduleLocalSave", localWorkspaceStart);
assert.ok(localWorkspaceStart >= 0 && localWorkspaceEnd > localWorkspaceStart, "local workspace persistence must exist");
const localWorkspaceSource = html.slice(localWorkspaceStart, localWorkspaceEnd);
assert.equal(localWorkspaceSource.includes("hiddenColumnSettings"), false,
  "hidden-column UI preferences must stay outside workspace recovery");
assert.equal(localWorkspaceSource.includes("HIDDEN_COLUMNS_KEY"), false,
  "hidden-column storage keys must stay outside workspace recovery");

const workbookSource = fs.readFileSync(path.join(ROOT, "orderFulfillmentWorkbook.js"), "utf8");
assert.equal(workbookSource.includes("hiddenColumnSettings"), false,
  "hidden-column UI state must not alter generated workbooks");

// Technical compatibility contracts intentionally retain their existing names.
assert.ok(html.includes("const engine = window.ShippingManagementEngine;"), "engine global compatibility changed");
assert.ok(html.includes("const workbookTools = window.ShippingManagementWorkbook;"), "workbook global compatibility changed");
assert.ok(html.includes('const CLOUD_PLAN_SCHEMA = "ONEAPP_SHIPPING_PURCHASE_PLAN_V1"'), "cloud plan schema changed");
assert.ok(orderOpsHtml.includes("<strong>임시저장</strong> · 완료 후 저장"),
  "the public OrderOps local autosave must be described as temporary work storage");
assert.ok(html.includes('id="localSaveStatus">임시저장 준비'),
  "the canonical OrderOps local autosave must be described as temporary work storage");
assert.ok(html.includes('postCloudAction("shipping_plan_save"'),
  "the explicit save button must commit a cloud revision");
assert.ok(html.includes('postCloudAction("shipping_plan_list"'),
  "another computer must be able to list cloud revisions");
assert.ok(html.includes('postCloudAction("shipping_plan_get"'),
  "another computer must be able to load a verified cloud revision");
assert.ok(html.includes("headerCloudSaveButton.disabled = cloudSaveDisabled"),
  "header and settings cloud-save controls must share the same availability");


function readFileMatrices(filePath, sheetName) {
  const workbook = XLSX.read(fs.readFileSync(filePath), {
    type: "buffer",
    cellDates: false,
    cellNF: true,
    cellText: true,
  });
  const selectedName = workbook.SheetNames.includes(sheetName)
    ? sheetName
    : workbook.SheetNames[0];
  const sheet = workbook.Sheets[selectedName];
  return {
    sheetName: selectedName,
    rawMatrix: XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    }),
    displayMatrix: XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    }),
  };
}

const referenceOrdersPath = "C:\\Users\\USER\\Desktop\\미출고현황.xlsx";
const referenceInventoryPath = "C:\\Users\\USER\\Desktop\\창고별재고.xlsx";
const referenceStockClosePath = "C:\\Users\\USER\\Desktop\\수불마감_20260810.xlsx";
const referenceFilesEnabled = process.env.SHIPPING_SKIP_REFERENCE_FILES !== "1";
let referenceWorkspace = null;
let inventoryReferenceWorkspace = null;
if (referenceFilesEnabled && fs.existsSync(referenceStockClosePath)) {
  const stockCloseInput = readFileMatrices(referenceStockClosePath, "전체재고");
  const stockCloseInventory = engine.parseInventoryWorkbook({
    fileName: path.basename(referenceStockClosePath),
    ...stockCloseInput,
  });
  assert.equal(stockCloseInventory.rowCount, 0, "수불마감 전체재고 must not be accepted as 창고별재고");
  assert.ok(
    stockCloseInventory.errors.some(
      (issue) => issue.code === "INVENTORY_REQUIRED_COLUMNS" && issue.missingColumns.includes("수량"),
    ),
    "수불마감 전체재고 must fail the aggregate inventory signature",
  );
}
if (referenceFilesEnabled && fs.existsSync(referenceInventoryPath)) {
  const inventoryInput = readFileMatrices(referenceInventoryPath, "재고현황");
  const referenceInventoryOnly = engine.parseInventoryWorkbook({
    fileName: path.basename(referenceInventoryPath),
    ...inventoryInput,
  });
  assert.equal(referenceInventoryOnly.errors.length, 0, JSON.stringify(referenceInventoryOnly.errors, null, 2));
  assert.ok(referenceInventoryOnly.rowCount >= 250, "real inventory workbook must expose the full operational list");
  assert.ok(
    referenceInventoryOnly.rows.every((row) => row.sourceInventoryTotal === row.inventoryTotal),
    "every real inventory row must reconcile source 수량 with its warehouse breakdown",
  );
  assert.equal(referenceInventoryOnly.columns[0]?.header, "품목코드", "warehouse inventory must lead with product identity");
  assert.equal(
    referenceInventoryOnly.columns.some((column) => column.header === "창고"),
    false,
    "warehouse inventory must not expose an ambiguous standalone 창고 column",
  );
  assert.equal(
    referenceInventoryOnly.columns.find((column) => column.header === "창고단가")?.role,
    "warehousePrice",
    "the trailing source 창고 price must be displayed explicitly as 창고단가",
  );
  const firstInventoryCode = referenceInventoryOnly.rows[0].productCode;
  const referenceSingleOrder = parseOrders(buildOrderMatrix([
    { code: firstInventoryCode, quantity: 1, date: "2026-08-04-1", spec: referenceInventoryOnly.rows[0].specification || "BOX" },
  ]));
  inventoryReferenceWorkspace = engine.analyze(referenceSingleOrder, referenceInventoryOnly, {
    createdAt: "2026-08-04T00:00:00.000Z",
    sourceFingerprint: "d".repeat(64),
  });
  const actualInventoryView = engine.getInventoryViewRows(inventoryReferenceWorkspace);
  assert.equal(actualInventoryView.rows.length, referenceInventoryOnly.rowCount);
  const inventoryOnlyCode = referenceInventoryOnly.rows.at(-1).productCode;
  engine.setPurchaseValue(inventoryReferenceWorkspace, inventoryOnlyCode, "실재고입력검증");
  assert.equal(engine.getPurchaseUploadSelection(inventoryReferenceWorkspace).included.some((row) => row.productCode === inventoryOnlyCode), false);
  const actualInventorySheet = workbookTools.buildWorkbook(inventoryReferenceWorkspace, XLSX).Sheets["창고별재고"];
  const actualPurchaseColumn = XLSX.utils.encode_col(actualInventoryView.headers.length);
  const actualSupplierColumn = XLSX.utils.encode_col(actualInventoryView.headers.length + 1);
  const actualOrderCustomerColumn = XLSX.utils.encode_col(actualInventoryView.headers.length + 2);
  assert.equal(actualInventorySheet["!ref"], `A1:${actualOrderCustomerColumn}${referenceInventoryOnly.rowCount + 1}`);
  assert.equal(actualInventorySheet[`${actualPurchaseColumn}${referenceInventoryOnly.rowCount + 1}`].v, "실재고입력검증");
}
if (referenceFilesEnabled && fs.existsSync(referenceOrdersPath) && fs.existsSync(referenceInventoryPath)) {
  const orderInput = readFileMatrices(referenceOrdersPath, "미판매현황");
  const inventoryInput = readFileMatrices(referenceInventoryPath, "재고현황");
  const referenceOrders = engine.parseOrderWorkbook({
    fileName: path.basename(referenceOrdersPath),
    ...orderInput,
  });
  const referenceInventory = engine.parseInventoryWorkbook({
    fileName: path.basename(referenceInventoryPath),
    ...inventoryInput,
  });
  const referenceValidation = engine.validateInputs(referenceOrders, referenceInventory);
  assert.equal(
    referenceValidation.canAnalyze,
    true,
    JSON.stringify(referenceValidation.errors, null, 2),
  );
  assert.ok(referenceOrders.rowCount > 0, "reference orders must expose operational rows");
  assert.ok(referenceInventory.rowCount >= 250, "reference inventory must expose the complete operational list");
  assert.equal(referenceValidation.duplicateCount, 0);
  const referenceInventoryCodes = new Set(referenceInventory.rows.map((row) => row.productCode));
  const referenceOrderOnlyCodes = [...new Set(referenceOrders.rows
    .map((row) => row.productCode)
    .filter((code) => !referenceInventoryCodes.has(code)))];
  assert.equal(referenceValidation.unmatchedCount, referenceOrderOnlyCodes.length);
  assert.equal(referenceValidation.memoCount, referenceOrders.rows.filter((row) => row.note || row.note1).length);

  referenceWorkspace = engine.analyze(referenceOrders, referenceInventory, {
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  assert.equal(referenceWorkspace.stats.productCount, new Set(referenceOrders.rows.map((row) => row.productCode)).size);
  assert.equal(
    referenceWorkspace.stats.totalOrderQuantity,
    referenceOrders.rows.reduce((sum, row) => sum + row.quantity, 0),
  );
  assert.ok(referenceWorkspace.stats.totalPurchaseNeed >= 0);
  assert.equal(referenceWorkspace.stats.allocationDifference, 0);
  assert.equal(referenceWorkspace.stats.productQuantityDifference, 0);
  assert.equal(referenceWorkspace.stats.negativePurchaseCount, 0);
  assert.equal(referenceWorkspace.stats.reconciliationErrorCount, 0);
  const referenceInventoryView = engine.getInventoryViewRows(referenceWorkspace);
  assert.equal(
    referenceInventoryView.rows.length,
    referenceInventory.rowCount + referenceOrderOnlyCodes.length,
    "full inventory view must equal inventory products plus unique order-only products",
  );
  assert.ok(
    referenceOrderOnlyCodes.every((code) => {
      const row = referenceInventoryView.rows.find((candidate) => candidate.productCode === code);
      const orderQuantity = referenceOrders.rows
        .filter((order) => order.productCode === code)
        .reduce((sum, order) => sum + order.quantity, 0);
      return row?.inventoryMissing === true && row.stockTotal === 0 &&
        row.orderQuantity === orderQuantity && row.remainingQuantity === -orderQuantity;
    }),
    "every real order-only product must display zero stock and its full negative remaining quantity",
  );
}

const outputWorkspace = referenceWorkspace || inventoryReferenceWorkspace || formatWorkspace;
const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-shipping-management-"));
try {
  const outputPath = path.join(tempDir, "미출고현황_테스트.xlsx");
  const purchaseOutputPath = path.join(tempDir, "구매업로드_20260804.xlsx");
  const dynamicOutputPath = path.join(tempDir, "동적창고열_테스트.xlsx");
  const outputWorkbook = workbookTools.buildWorkbook(outputWorkspace, XLSX);
  const outputBytes = workbookTools.writeWorkbook(outputWorkbook, XLSX);
  fs.writeFileSync(outputPath, Buffer.from(new Uint8Array(outputBytes)));
  const purchaseOutputBytes = workbookTools.writeStandardWorkbook(purchaseUploadWorkbook, XLSX);
  fs.writeFileSync(purchaseOutputPath, Buffer.from(new Uint8Array(purchaseOutputBytes)));
  const dynamicOutputBytes = workbookTools.writeWorkbook(dynamicWorkbook, XLSX);
  fs.writeFileSync(dynamicOutputPath, Buffer.from(new Uint8Array(dynamicOutputBytes)));
  assert.ok(fs.statSync(outputPath).size > 10000, "generated workbook is unexpectedly small");
  const packageText = Buffer.from(outputBytes).toString("utf8");
  assert.match(packageText, /<pageSetUpPr fitToPage="1"\/>/);
  assert.match(
    packageText,
    /<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"\/>/,
  );
  if (process.env.SHIPPING_TEST_OUTPUT) {
    const requestedOutput = path.resolve(ROOT, process.env.SHIPPING_TEST_OUTPUT);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    assert.ok(
      requestedOutput.startsWith(rootPrefix),
      `SHIPPING_TEST_OUTPUT must remain inside the repository: ${requestedOutput}`,
    );
    fs.mkdirSync(path.dirname(requestedOutput), { recursive: true });
    fs.copyFileSync(outputPath, requestedOutput);
  }
  if (process.env.SHIPPING_PURCHASE_TEST_OUTPUT) {
    const requestedPurchaseOutput = path.resolve(ROOT, process.env.SHIPPING_PURCHASE_TEST_OUTPUT);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    assert.ok(
      requestedPurchaseOutput.startsWith(rootPrefix),
      `SHIPPING_PURCHASE_TEST_OUTPUT must remain inside the repository: ${requestedPurchaseOutput}`,
    );
    fs.mkdirSync(path.dirname(requestedPurchaseOutput), { recursive: true });
    fs.copyFileSync(purchaseOutputPath, requestedPurchaseOutput);
  }
  if (process.env.SHIPPING_DYNAMIC_TEST_OUTPUT) {
    const requestedDynamicOutput = path.resolve(ROOT, process.env.SHIPPING_DYNAMIC_TEST_OUTPUT);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    assert.ok(
      requestedDynamicOutput.startsWith(rootPrefix),
      `SHIPPING_DYNAMIC_TEST_OUTPUT must remain inside the repository: ${requestedDynamicOutput}`,
    );
    fs.mkdirSync(path.dirname(requestedDynamicOutput), { recursive: true });
    fs.copyFileSync(dynamicOutputPath, requestedDynamicOutput);
  }
  const reopened = XLSX.read(fs.readFileSync(outputPath), {
    type: "buffer",
    cellFormula: true,
    cellStyles: true,
  });
  assert.deepEqual(
    Array.from(reopened.SheetNames),
    Array.from(workbookTools.REQUIRED_SHEETS),
    "reopened workbook sheet contract changed",
  );
  assert.equal(
    reopened.Sheets["주문현황"]["B2"].t,
    "s",
    "product code must reopen as text",
  );
  assert.deepEqual(
    Array.from(
      XLSX.utils.sheet_to_json(reopened.Sheets["주문현황"], { header: 1, raw: true, range: 0 })[0],
    ),
    [
      "창고", "상품코드", "품목명", "규격",
      ...engine.getAllocationInventoryView(outputWorkspace).columns.map((column) => column.header),
      "주문수량", "전재고", "서울잔량", "구매수량", "구매", "거래처", "그룹", "단가", "공급가액", "적요", "적요1", "담당자",
    ],
  );
  const reopenedPrintNames = (reopened.Workbook?.Names || []).filter(
    (name) => name.Sheet === 1 && /^_xlnm\.Print_/.test(name.Name),
  );
  assert.equal(reopenedPrintNames.length, 2, "print area and print titles must reopen");
  assert.deepEqual({ ...reopened.Sheets["주문현황"]["!margins"] }, {
    left: 0.25,
    right: 0.25,
    top: 0.75,
    bottom: 0.75,
    header: 0.3,
    footer: 0.3,
  });
  const reopenedDynamic = XLSX.read(fs.readFileSync(dynamicOutputPath), {
    type: "buffer",
    cellStyles: true,
    cellText: true,
  });
  assert.deepEqual(
    Array.from(XLSX.utils.sheet_to_json(reopenedDynamic.Sheets["창고별재고"], { header: 1, raw: true, range: "A1:N1" })[0]),
    [...dynamicView.headers, "구매", "정보", "적요"],
  );
  assert.deepEqual(
    [reopenedDynamic.Sheets["창고별재고"].I2.t, reopenedDynamic.Sheets["창고별재고"].I2.v],
    ["n", -130],
  );
  assert.deepEqual(
    [reopenedDynamic.Sheets["창고별재고"].J2.t, reopenedDynamic.Sheets["창고별재고"].J2.v],
    ["s", "00123"],
  );
  assert.ok(reopenedDynamic.Sheets["창고별재고"].I2.s, "negative dynamic inventory cell style must reopen");
  assert.ok(reopenedDynamic.Sheets["창고별재고"].A2.s, "EA row font style must reopen");
  const reopenedPurchase = XLSX.read(fs.readFileSync(purchaseOutputPath), {
    type: "buffer",
    cellStyles: true,
    cellText: true,
  });
  assert.deepEqual(Array.from(reopenedPurchase.SheetNames), ["구매입력"]);
  assert.equal(reopenedPurchase.Sheets["구매입력"].A2.t, "s");
  assert.equal(reopenedPurchase.Sheets["구매입력"].A2.v, "20260804");
  assert.equal(reopenedPurchase.Sheets["구매입력"].E2.t, "s");
  assert.equal(reopenedPurchase.Sheets["구매입력"].E2.v, "01");
  assert.equal(reopenedPurchase.Sheets["구매입력"].F2.v, "");
  assert.equal(reopenedPurchase.Sheets["구매입력"].I2.t, "s");
  assert.equal(reopenedPurchase.Sheets["구매입력"].L2.t, "n");
  assert.equal(reopenedPurchase.Sheets["구매입력"].M2.t, "n");
  assert.equal(reopenedPurchase.Sheets["구매입력"].M2.v, 0);
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedPrefix = path.resolve(ROOT, ".tmp-shipping-management-");
  assert.ok(
    resolvedTempDir.startsWith(allowedPrefix),
    `refusing to remove unexpected temp directory: ${resolvedTempDir}`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (purchaseTemplateBaseline) {
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(PURCHASE_TEMPLATE_PATH)).digest("hex"),
    purchaseTemplateBaseline.hash,
    "original purchase upload template hash must remain unchanged",
  );
  assert.equal(
    fs.statSync(PURCHASE_TEMPLATE_PATH).mtimeMs,
    purchaseTemplateBaseline.mtimeMs,
    "original purchase upload template mtime must remain unchanged",
  );
}

if (process.env.SHIPPING_BROWSER_FIXTURE_DIR) {
  const fixtureDir = path.resolve(ROOT, process.env.SHIPPING_BROWSER_FIXTURE_DIR);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  assert.ok(fixtureDir.startsWith(rootPrefix), `SHIPPING_BROWSER_FIXTURE_DIR must remain inside the repository: ${fixtureDir}`);
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const [fileName, sheetName, matrix] of [
    ["주문현황_브라우저.xlsx", "미판매현황", edgeOrders.sourceMatrix],
    ["창고별재고_브라우저.xlsx", "재고현황", edgeInventory.sourceMatrix],
    ["주문현황_동적창고열_브라우저.xlsx", "미판매현황", dynamicOrders.sourceMatrix],
    ["창고별재고_동적창고열_브라우저.xlsx", "재고현황", dynamicInventoryMatrix],
  ]) {
    const fixtureWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(fixtureWorkbook, XLSX.utils.aoa_to_sheet(matrix), sheetName);
    const fixtureBytes = XLSX.write(fixtureWorkbook, { type: "array", bookType: "xlsx", compression: true });
    fs.writeFileSync(path.join(fixtureDir, fileName), Buffer.from(new Uint8Array(fixtureBytes)));
  }
}

console.log(
  referenceWorkspace
    ? `OrderOps tests passed, including the real ${referenceWorkspace.stats.orderRowCount}-order/${referenceWorkspace.stats.inventoryRowCount}-inventory reference files.`
    : inventoryReferenceWorkspace
      ? `OrderOps tests passed, including the real ${inventoryReferenceWorkspace.stats.inventoryRowCount}-inventory reference file.`
      : "OrderOps tests passed. Real reference files were not present and were skipped.",
);

