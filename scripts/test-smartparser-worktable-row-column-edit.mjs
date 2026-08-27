#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smartSource = fs.readFileSync(path.join(ROOT, "SmartParser.html"), "utf8").replace(/\r\n/g, "\n");
const clone = (value) => JSON.parse(JSON.stringify(value));
const sliceBetween = (source, startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} block not found`);
  return source.slice(start, end);
};

const inlineScripts = [...smartSource.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());
assert.ok(inlineScripts.length > 0, "SmartParser inline scripts not found");
inlineScripts.forEach((script, index) => new vm.Script(script, { filename: `SmartParser-inline-${index + 1}.js` }));

const helperSource = sliceBetween(
  smartSource,
  "// SmartParser 일치 작업테이블의 행·열 편집은",
  "const normalizeSmartParserStoppedProducts =",
  "SmartParser worktable helpers",
);
let uuidSequence = 0;
const context = vm.createContext({
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  JSON,
  Set,
  Map,
  generateUUID: () => `manual-${++uuidSequence}`,
});
vm.runInContext(`${helperSource}\nglobalThis.helpers = {
  SMART_PARSER_WORKTABLE_COLUMNS,
  SMART_PARSER_WORKTABLE_DEFAULT_ORDER,
  SMART_PARSER_WORKTABLE_DATA_KEYS,
  getSmartParserContiguousRange,
  createSmartParserManualRows,
  insertSmartParserRowsAbove,
  removeSmartParserRowsById,
  getSmartParserColumnHideResult,
  restoreSmartParserColumn,
  isSmartParserApplyCandidate
};`, context);
const helpers = context.helpers;

assert.deepEqual(clone(helpers.getSmartParserContiguousRange(["r1", "r2", "r3", "r4"], "r2", "r4")), ["r2", "r3", "r4"]);
assert.deepEqual(clone(helpers.getSmartParserContiguousRange(["r1", "r2", "r3", "r4"], "r4", "r2")), ["r2", "r3", "r4"]);
assert.deepEqual(clone(helpers.getSmartParserContiguousRange(["a", "b", "c"], "a", "missing")), []);
assert.deepEqual(clone(helpers.getSmartParserContiguousRange(["productCode", "masterProduct", "parsedProduct"], "productCode", "parsedProduct")), ["productCode", "masterProduct", "parsedProduct"]);

const manualRows = helpers.createSmartParserManualRows(3, {
  catalogWarehouse: "01",
  priceRule: { marginRate: 20 },
  priceRuleStatus: "default",
  priceRuleReason: "*/* 기본 룰",
});
assert.equal(manualRows.length, 3);
assert.equal(new Set(manualRows.map((row) => row._id)).size, 3);
for (const row of manualRows) {
  assert.equal(row._manualAdded, true);
  assert.equal(row._apply, false);
  assert.equal(row._matchCode, "");
  assert.equal(row._matchStatus, "🔴 수동추가·매핑필요");
  assert.equal(row.품목명, "");
  assert.equal(row.규격, "");
  assert.equal(row.단위, "");
  assert.equal(row.입고가, "");
  assert.deepEqual(clone(row.finalData), {});
  assert.equal(row._catalogWarehouse, "01");
  assert.equal(helpers.isSmartParserApplyCandidate(row), false, "unmapped manual rows must stay out of F7");
}

const sourceRows = [
  { _id: "r1", _apply: true, _matchCode: "P1", finalData: { 입고가: 100 } },
  { _id: "r2", _apply: false, _matchCode: "P2", finalData: { 입고가: 200 } },
  { _id: "r3", _apply: true, _matchCode: "P3", finalData: { 입고가: 300 } },
  { _id: "r4", _apply: true, _matchCode: "P4", finalData: { 입고가: 400 } },
];
const originalRows = clone(sourceRows);
const withManualRows = helpers.insertSmartParserRowsAbove(sourceRows, ["r2", "r3", "r4"], manualRows);
assert.deepEqual(clone(withManualRows.map((row) => row._id)), ["r1", ...clone(manualRows.map((row) => row._id)), "r2", "r3", "r4"]);
assert.deepEqual(clone(sourceRows), originalRows, "row insertion must not mutate parserBuffer input rows");
assert.deepEqual(clone(withManualRows.filter((row) => row._id.startsWith("r")).map((row) => row._apply)), [true, false, true, true], "row selection/insertion must not change _apply");

const mappedManual = { ...withManualRows[1], _matchCode: "P5", _matchStatus: "🟢 수동일치", _apply: true };
assert.equal(helpers.isSmartParserApplyCandidate(mappedManual), true, "mapped manual rows must reuse the existing F7 condition");
assert.equal(helpers.isSmartParserApplyCandidate({ ...mappedManual, _apply: false }), false);
assert.equal(helpers.isSmartParserApplyCandidate({ ...mappedManual, _matchCode: "" }), false);

const integrationRows = withManualRows.map((row) => row._id === mappedManual._id ? mappedManual : row);
const afterDelete = helpers.removeSmartParserRowsById(integrationRows, ["r2", "r3"]);
assert.deepEqual(clone(afterDelete.map((row) => row._id)), ["r1", ...clone(manualRows.map((row) => row._id)), "r4"]);
assert.deepEqual(clone(integrationRows.filter((row) => ["r2", "r3"].includes(row._id))), clone(withManualRows.filter((row) => ["r2", "r3"].includes(row._id))), "row deletion must not mutate deleted row data");

const defaultOrder = clone(helpers.SMART_PARSER_WORKTABLE_DEFAULT_ORDER);
assert.deepEqual(defaultOrder.slice(0, 2), ["rowNumber", "apply"], "row number must remain immediately left of the existing apply checkbox");
const allSelectableColumns = ["productCode", "masterProduct", "parsedProduct", "currentInPrice", "newInPrice", "management"];
const hideAllResult = helpers.getSmartParserColumnHideResult(defaultOrder, [], allSelectableColumns);
assert.deepEqual(clone(hideAllResult.hiddenNow), ["productCode", "masterProduct", "parsedProduct", "currentInPrice"]);
assert.deepEqual(clone(hideAllResult.retainedForMinimum), ["newInPrice"], "at least one data column must remain visible");
assert.deepEqual(clone(hideAllResult.protectedSelected), ["management"], "management must remain protected");

const rowSnapshotBeforeColumnEdit = clone(afterDelete);
const hiddenOne = helpers.getSmartParserColumnHideResult(defaultOrder, [], ["productCode"]);
const restored = helpers.restoreSmartParserColumn(defaultOrder, hiddenOne.hidden, "productCode", ["parsedProduct"]);
assert.equal(restored.hidden.includes("productCode"), false);
assert.equal(restored.order.indexOf("productCode") + 1, restored.order.indexOf("parsedProduct"), "restored column must be inserted immediately before the selected leftmost data column");
assert.deepEqual(clone(afterDelete), rowSnapshotBeforeColumnEdit, "column hide/restore must not mutate parserBuffer or F7 data");

const rowDeleteHandler = sliceBetween(
  smartSource,
  "const deleteSmartParserWorkRows =",
  "const hideSelectedSmartParserColumns =",
  "row delete handler",
);
assert.match(rowDeleteHandler, /removeSmartParserRowsById\(parserBuffer, existingIds\)/);
assert.match(rowDeleteHandler, /reconcileSmartParserDuplicateRows/);
assert.match(rowDeleteHandler, /마스터 상품과 공급사 제외목록은 변경되지 않습니다/);
assert.doesNotMatch(rowDeleteHandler, /saveMaster|saveDict|saveParserExcludeDict|handleStopProducts|handleResumeStoppedProducts|setIDB|localStorage|merchHistory/,
  "worktable row deletion must not call master, dictionary, exclusion, stop, history, or storage writers");

const columnStateBlock = sliceBetween(
  smartSource,
  "const [worktableSelection, setWorktableSelection] =",
  "const availableTags =",
  "worktable React UI state",
);
assert.doesNotMatch(columnStateBlock, /localStorage|setIDB|getIDB/, "worktable UI state must remain page-session React state");
assert.match(smartSource, /const matchedWorkRows = parserBuffer\.filter\(r => !duplicateIds\.has\(r\._id\) && \(r\._matchCode \|\| r\._manualAdded\)\)/);
assert.match(smartSource, /const targetRows = useMemo\(\(\) => parserBuffer\.filter\(r => r\._apply && r\._matchCode\)/,
  "review modal must retain _apply && _matchCode eligibility");
assert.match(smartSource, /const toApply = reconciledRows\.filter\(isSmartParserApplyCandidate\)/);
assert.match(smartSource, /aria-label": `\$\{rowIndex \+ 1\}번 행 선택`/);
assert.match(smartSource, /aria-label": `\$\{column\?\.label \|\| columnKey\} 열 선택`/);
assert.match(smartSource, /"aria-selected": isRowSelected/);
assert.match(smartSource, /"aria-selected": isSelected/);
assert.match(smartSource, /event\.shiftKey && \(event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'\)/);
assert.match(smartSource, /event\.shiftKey && \(event\.key === 'ArrowLeft' \|\| event\.key === 'ArrowRight'\)/);
assert.match(smartSource, /if \(rowDragRef\.current\.active\) selectWorktableRowRange\(row\._id, rowDragRef\.current\.anchorId\)/,
  "row-header drag must extend a contiguous selection");
assert.match(smartSource, /if \(columnDragRef\.current\.active\) selectWorktableColumnRange\(columnKey, columnDragRef\.current\.anchorKey\)/,
  "column-header drag must extend a contiguous selection");
assert.match(smartSource, /e\.key === 'Escape' && worktableSelection\.type/);
const globalKeyHandler = sliceBetween(smartSource, "const handleGlobalKeyDown =", "window.addEventListener('keydown', handleGlobalKeyDown)", "global key handler");
assert.doesNotMatch(globalKeyHandler, /Delete|Backspace|Ctrl\+|Control/, "destructive worktable editing must remain button-only");
assert.match(smartSource, /행 추가\(\$\{worktableSelection\.selectedRowIds\.length\}\)/);
assert.match(smartSource, /선택 행 삭제\(\$\{worktableSelection\.selectedRowIds\.length\}\)/);
assert.match(smartSource, /선택 열 삭제\(\$\{worktableSelection\.selectedColumnKeys\.length\}\)/);
assert.match(smartSource, /화면에서만 숨기며 데이터는 유지됩니다/);
assert.match(smartSource, /"첫 행 추가"/);

console.log("SmartParser worktable row/column selection, insertion, deletion, visibility, accessibility, and F7-preservation tests passed.");
