import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const merch = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const parser = fs.readFileSync(path.join(ROOT, "SmartParser.html"), "utf8");
const manifest = fs.readFileSync(path.join(ROOT, "app-manifest.json"), "utf8");
const architecture = fs.readFileSync(path.join(ROOT, "APP_ARCHITECTURE.md"), "utf8");
const history = fs.readFileSync(path.join(ROOT, "history_viewer.html"), "utf8");

const parseInlineScripts = (html, label) => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim() !== "");
  assert.ok(scripts.length > 0, label + " inline scripts were not found");
  scripts.forEach((script, index) => new vm.Script(script, { filename: label + "-inline-" + (index + 1) + ".js" }));
};

parseInlineScripts(merch, "MerchOps");
parseInlineScripts(parser, "SmartParser");
JSON.parse(manifest);

assert.match(merch, /ONEAPP MerchOps - Main Workspace \[v\d+\.\d+\.\d+_[^\]]+\]/);
assert.match(parser, /ONEAPP MerchOps - Smart Parser \[v3\.\d+\.\d+/);

assert.match(merch, /window\.hasMerchExistingWorktableRows =/);
assert.match(merch, /const preserveExistingWorktable = window\.hasMerchExistingWorktableRows/);
assert.match(merch, /if \(nextCatalogName && !preserveExistingWorktable\)/);
assert.doesNotMatch(merch, /if \(!hasExternalExcel\) next = \{\};/);
assert.match(merch, /actionType: '작업테이블 직접수정'/);
assert.match(merch, /const editOrigin = window\.getMerchFieldEditOrigin/);
assert.match(merch, /recordedFieldChangeLogs\.add\(linked\)/);

const catalogHelperStart = merch.indexOf("window.isMerchCatalogEditRow =");
const catalogHelperEnd = merch.indexOf("window.rebuildMerchEstimateComparisonForScope =", catalogHelperStart);
assert.ok(catalogHelperStart >= 0 && catalogHelperEnd > catalogHelperStart, "Catalog worktable helper block was not found");
const catalogBrowser = {};
vm.runInContext(merch.slice(catalogHelperStart, catalogHelperEnd), vm.createContext({ window: catalogBrowser, Object }));
const parserListRows = {
  P001: { sources: { catalog: { 품목명: "파서 상품", _catalogListOnly: true } }, finalData: { 품목명: "파서 상품" } },
};
const catalogEditRows = {
  P002: { _catalogEditOnly: true, sources: { catalog: { 품목명: "편집 상품", _catalogEditOnly: true } } },
};
assert.equal(catalogBrowser.hasMerchExistingWorktableRows(parserListRows), true,
  "A loaded parser list must keep the existing worktable when catalog scope changes");
assert.equal(catalogBrowser.hasMerchExistingWorktableRows(catalogEditRows), false,
  "Catalog-only edit rows must be replaceable when catalog scope changes");

const displayHelperStart = merch.indexOf("window.getMerchDisplayBaseRows =");
const displayHelperEnd = merch.indexOf("const useMerchActions =", displayHelperStart);
assert.ok(displayHelperStart >= 0 && displayHelperEnd > displayHelperStart,
  "MerchOps display-base helper block was not found");
const displayBrowser = {};
vm.runInContext(merch.slice(displayHelperStart, displayHelperEnd), vm.createContext({ window: displayBrowser, Object }));
const resetMaster = {
  P001: { 코드: "P001", 품목명: "기존 마스터 1" },
  P002: { 코드: "P002", 품목명: "기존 마스터 2" },
};
assert.equal(displayBrowser.getMerchDisplayBaseRows({}, resetMaster, { suppressMasterFallback: true }).length, 0,
  "An explicit reset must keep the worktable empty instead of expanding the full master");
const explicitAllRows = displayBrowser.getMerchDisplayBaseRows({}, resetMaster, {
  suppressMasterFallback: true,
  masterLookupMode: "all",
});
assert.equal(explicitAllRows.length, 2,
  "Touching the all button must explicitly expose the full master");
assert.equal(explicitAllRows.every(row => row._masterLookupOnly === true), true,
  "Explicit master lookup rows must be marked as read-only lookup rows");
assert.equal(displayBrowser.getMerchDisplayBaseRows({
  P003: { 코드: "P003", sources: { estimate: {} }, finalData: {} },
}, resetMaster, { suppressMasterFallback: true })[0].코드, "P003",
  "Newly loaded work rows must display even before the reset guard state effect settles");
assert.equal(displayBrowser.isMerchUnmodifiedMasterLookupRow(explicitAllRows[0]), true,
  "An untouched master lookup row must not be eligible for F7");
assert.equal(displayBrowser.isMerchUnmodifiedMasterLookupRow({
  ...explicitAllRows[0],
  finalData: { 입고가: 1234, _editedFields: { 입고가: true } },
}), false, "An edited master lookup row must become eligible for F7");
assert.match(merch, /const \[suppressMasterFallback, setSuppressMasterFallback\] = useState\(true\);/);
assert.match(merch, /data\.setSuppressMasterFallback\(true\);\s*data\.setMasterLookupMode\(''\);\s*data\.setManagedItems\(\{\}\);/);
assert.match(merch, /handleMasterLookup\?\.\(\[\]\)/);
assert.match(merch, /handleMasterLookup\?\.\(nextCategories\)/);
assert.match(merch, /suppressMasterFallback: data\.suppressMasterFallback/);
assert.match(merch, /masterLookupMode: data\.masterLookupMode/);
assert.match(merch, /visibleTargetRowsRaw[\s\S]{0,500}isMerchUnmodifiedMasterLookupRow/);
assert.match(merch, /조회 전용 Snapshot 행은 F7 반영 대상이 아닙니다/);
assert.match(merch, /작업 테이블이 비어 있습니다/);
assert.match(merch, /선택한 마스터 조회 범위에 상품이 없습니다/);

for (const removed of [
  "정보변경 대기",
  "merchInfoChangeQueue_v1",
  "merchInfoChange_sync_trigger",
  "InfoChangeManager",
  "infoChangeQueue",
  "appendInfoChangeSheets",
  "merch_master_return_synced",
  "merch_force_master_reload",
]) {
  assert.ok(!merch.includes(removed), "MerchOps still contains deleted waiting logic: " + removed);
}
assert.ok(!merch.includes("if (e.key === 'merchMaster_sync_trigger')"), "MerchOps must not hot-reload an open worktable");

const loadTools = merch.indexOf('data-merch-toolbar-group": "parser-catalog"');
const excelTools = merch.indexOf('data-merch-toolbar-group": "excel"', loadTools);
const tableView = merch.indexOf("showTableViewSelect && commonExcelTableViewOptions.length > 0", excelTools);
const operationTools = merch.indexOf('data-merch-toolbar-group": "operations"', tableView);
const autoRule = merch.indexOf('"aria-label": "파일 불러오기 시 출고가 자동적용"', operationTools);
const manualRule = merch.indexOf("onClick: handleForceApplyMarginRules", autoRule);
const mainReset = merch.indexOf("onClick: handleReset", manualRule);
assert.ok(loadTools >= 0 && excelTools > loadTools && tableView > excelTools && operationTools > tableView && autoRule > operationTools && manualRule > autoRule && mainReset > manualRule,
  "The table view must stay in the Excel group while auto-rule, manual out-price, and reset stay in the operation group");
const fixedTools = merch.indexOf('title: "기본 판매가·필터 초기화·검색"');
const filterReset = merch.indexOf("onClick: handleFilterResetOnly", fixedTools);
const searchBar = merch.indexOf("React.createElement(SearchBar", fixedTools);
assert.ok(fixedTools >= 0 && filterReset > fixedTools && searchBar > filterReset,
  "Filter reset must remain immediately left of search");
assert.equal((merch.match(/onClick: handleForceApplyMarginRules/g) || []).length, 1,
  "Rule apply must appear once and must not remain in the promotion workbench");
assert.match(merch, /출고가: 선택행 또는 현재 화면에 기존 마진룰을 수동 적용합니다/);

for (const removed of [
  "merchInfoChangeQueue_v1",
  "merchInfoChange_sync_trigger",
  "INFO_CHANGE_QUEUE_KEY",
  "upsertParserInfoChange",
  "normalizeInfoChangeQueue",
  "outputPending",
  "parser_stale_external_value_blocked",
]) {
  assert.ok(!parser.includes(removed), "SmartParser still contains deleted waiting logic: " + removed);
}
assert.match(parser, /actionType: '정보변경'/);
assert.match(parser, /historyType: '정보변경'/);
assert.match(parser, /changeType: '정보변경'/);
assert.match(parser, /SmartParser > \$\{catalogLabel\} > 정보 마스터 즉시 반영/);
assert.match(parser, /newMaster\[code\]\[fieldName\] = parsedVal/);
assert.match(parser, /handleUpdateMatchedText/);
assert.match(parser, /_editedTextFields/);
assert.match(parser, /hasExplicitTextEdit/);
assert.match(parser, /const shouldApplyTextField = hasExplicitTextEdit \|\| updateTextData/);
assert.match(parser, /if \(!shouldApplyTextField\) return/);
assert.match(parser, /const hasApplicableValue = hasExplicitTextEdit \|\| !!parsedVal/);
assert.match(parser, /저장할 품목명 수정/);
assert.match(parser, /저장할 규격 수정/);
assert.match(parser, /await saveMaster\(newMaster, sharedEntries\)/);

assert.ok(!manifest.includes('"information-change-queue"'));
assert.ok(!architecture.includes("merchInfoChangeQueue_v1"));
assert.match(architecture, /currently open MerchOps worktable/);
assert.match(history, /log\.actionType/);
assert.match(history, /oldVal/);
assert.match(history, /newVal/);

console.log("MerchOps rule placement and SmartParser direct information-master tests passed.");

