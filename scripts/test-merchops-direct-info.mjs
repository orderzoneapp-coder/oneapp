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

assert.match(merch, /v2\.1\.161_WorktableHistoryPreserve/);
assert.match(parser, /v3\.0\.19 ExplicitInfoSave/);

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

const fixedTools = merch.indexOf('title: "기본 판매가·필터 초기화·검색"');
const fixedRule = merch.indexOf("onClick: handleForceApplyMarginRules", fixedTools);
const filterReset = merch.indexOf("onClick: handleFilterResetOnly", fixedTools);
const searchBar = merch.indexOf("React.createElement(SearchBar", fixedTools);
assert.ok(fixedTools >= 0 && fixedRule > fixedTools && filterReset > fixedRule && searchBar > filterReset,
  "Rule apply must be fixed immediately left of filter reset and search");
assert.equal((merch.match(/onClick: handleForceApplyMarginRules/g) || []).length, 1,
  "Rule apply must appear once and must not remain in the promotion workbench");
assert.match(merch, /기본 판매가\(출고가\).*행사작업과 독립된 가격 작업/);

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

