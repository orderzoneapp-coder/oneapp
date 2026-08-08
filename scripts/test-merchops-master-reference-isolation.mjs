#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

const coreSource = fs.readFileSync(path.join(ROOT, "coreEngine.js"), "utf8");
const merchSource = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const exportSource = fs.readFileSync(path.join(ROOT, "export_center.html"), "utf8");
const dataOpsSource = fs.readFileSync(path.join(ROOT, "DataOps.html"), "utf8");

const browser = {
  console,
  Date,
  Math,
  Set,
  Map,
  Array,
  Object,
  Number,
  String,
  Boolean,
  RegExp,
  JSON,
  Promise,
  Error,
  DOMException,
  URL,
  encodeURIComponent,
  decodeURIComponent,
  localStorage: new MemoryStorage(),
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
};
browser.window = browser;
vm.runInNewContext(coreSource, browser, { filename: "coreEngine.js" });

assert.equal(typeof browser.resolveMerchWorkingField, "function", "shared MerchOps field resolver must exist");
assert.equal(typeof browser.ONEAPP.EXPORT.buildMasterReference, "function", "F9 must expose a separate master reference builder");

const resolve = browser.resolveMerchWorkingField;
const master = {
  품목명: "마스터 상품",
  규격: "MASTER-SPEC",
  브랜드: "MASTER-BRAND",
  간단설명: "MASTER-DESC",
  입고가: 9000,
  판매여부: 1,
  재고수량: 999,
};
const sourceRow = {
  코드: "A001",
  sources: {
    _activeRole: "estimate",
    estimate: {
      품목명: "엑셀 상품",
      브랜드: "",
      입고가: 0,
      판매여부: false,
    },
  },
  finalData: {
    품목명: "엑셀 상품",
    브랜드: "",
    입고가: 0,
    판매여부: false,
  },
};

assert.deepEqual(
  JSON.parse(JSON.stringify(resolve(sourceRow, master, "품목명"))),
  { value: "엑셀 상품", origin: "source", isWorkingValue: true, isExplicitBlank: false, field: "품목명", sourceRole: "estimate" },
);
assert.equal(resolve(sourceRow, master, "브랜드").value, "");
assert.equal(resolve(sourceRow, master, "브랜드").isExplicitBlank, true, "owned blank must remain an explicit working blank");
assert.equal(resolve(sourceRow, master, "규격").value, "MASTER-SPEC");
assert.equal(resolve(sourceRow, master, "규격").origin, "master-reference");
assert.equal(resolve(sourceRow, master, "규격").isWorkingValue, false, "missing source column must stay reference-only");
assert.equal(resolve(sourceRow, master, "입고가").value, 0, "numeric zero must survive");
assert.equal(resolve(sourceRow, master, "판매여부").value, false, "boolean false must survive");

const blankSaleRow = {
  코드: "A002",
  sources: { _activeRole: "estimate", estimate: { 판매여부: "" } },
  finalData: { 판매여부: "" },
};
assert.equal(resolve(blankSaleRow, master, "판매여부").isExplicitBlank, true, "blank sale cells must remain explicit blanks");
assert.equal(browser.ONEAPP.EXPORT.buildWorkingPayload(blankSaleRow, master).판매여부, "");

const directSameValue = {
  ...sourceRow,
  finalData: { ...sourceRow.finalData, 규격: "MASTER-SPEC", _editedFields: { 규격: true } },
};
assert.equal(resolve(directSameValue, master, "규격").origin, "direct");
assert.equal(resolve(directSameValue, master, "규격").isWorkingValue, true, "editing a gray reference to the same value must make it direct");

const generated = {
  ...sourceRow,
  finalData: { ...sourceRow.finalData, 출고가: 12000, _isRuleApplied: true, _ruleAppliedAt: "2026-08-09T00:00:00.000Z" },
};
assert.equal(resolve(generated, master, "출고가").origin, "generated");
assert.equal(resolve(generated, master, "출고가").isWorkingValue, true);

const promoReset = {
  ...sourceRow,
  finalData: { ...sourceRow.finalData, 행사가: 0, 행사테마: "", _promoResetRequested: true },
};
assert.equal(resolve(promoReset, master, "행사가").origin, "generated");
assert.equal(resolve(promoReset, master, "행사테마").isExplicitBlank, true);
assert.equal(browser.ONEAPP.EXPORT.buildWorkingPayload(promoReset, master).행사가, 0);

const resumed = { ...sourceRow, finalData: { _salesResumeRequested: true } };
assert.equal(browser.ONEAPP.EXPORT.buildWorkingPayload(resumed, master).판매여부, 1);

const masterLookupRow = { 코드: "A001", _masterLookupOnly: true, sources: {}, finalData: {} };
assert.equal(resolve(masterLookupRow, master, "규격").origin, "master-lookup");
assert.equal(resolve(masterLookupRow, master, "규격").isWorkingValue, true, "explicit master lookup must remain exportable");

const working = browser.ONEAPP.EXPORT.buildWorkingPayload(sourceRow, master);
assert.equal(working.품목명, "엑셀 상품");
assert.equal(working.브랜드, "");
assert.equal(working.입고가, 0);
assert.equal(working.판매여부, false);
assert.equal(Object.prototype.hasOwnProperty.call(working, "규격"), false, "reference-only fields must not enter F9 working");
assert.equal(Object.prototype.hasOwnProperty.call(working, "재고수량"), false, "missing stock columns must not receive a generated default");
assert.equal(working._fieldStates.브랜드.isExplicitBlank, true);
assert.equal(working._fieldStates.규격.origin, "master-reference");

const missingColumnsWorking = browser.ONEAPP.EXPORT.buildWorkingPayload({
  코드: "A003",
  sources: { _activeRole: "estimate", estimate: { 품목명: "최소 컬럼" } },
  finalData: { 품목명: "최소 컬럼" },
}, master);
for (const field of ["입고가", "판매여부", "재고수량", "시중가"]) {
  assert.equal(Object.prototype.hasOwnProperty.call(missingColumnsWorking, field), false, `missing ${field} must not be generated`);
}

const lookupWorking = browser.ONEAPP.EXPORT.buildWorkingPayload(masterLookupRow, master);
assert.equal(lookupWorking.규격, "MASTER-SPEC", "master-only lookup F9 output must remain available");
assert.equal(lookupWorking.재고수량, 999, "explicit master-only lookup must preserve master stock values including 999");

const [draft] = browser.ONEAPP.EXPORT.buildExportDraft({ targetRows: [sourceRow], masterProducts: { A001: master } });
assert.equal(draft.working.품목명, "엑셀 상품");
assert.equal(Object.prototype.hasOwnProperty.call(draft.working, "규격"), false);
assert.equal(draft.masterReference.규격, "MASTER-SPEC");
assert.equal(draft.baselineSnapshot.기준입고가, 9000);

const f8Start = merchSource.indexOf("const handleQuickExcelExport = useCallback(() => {");
const f8End = merchSource.indexOf("// [M-MASTER-COMMIT-01] F7", f8Start);
const f7Start = merchSource.indexOf("const handleCommitEstimate = useCallback(async () => {");
const f7End = merchSource.indexOf("const toggleAllRows = useCallback", f7Start);
const f9Start = merchSource.indexOf("const handleOpenExportCenter = useCallback(() => {");
const f9End = merchSource.indexOf("useEffect(() => {", f9Start);
assert.ok(f8Start >= 0 && f8End > f8Start && f7Start >= 0 && f7End > f7Start && f9Start >= 0 && f9End > f9Start);
assert.match(merchSource.slice(f8Start, f8End), /resolveMerchWorkingField/, "F8 must use the shared resolver");
assert.match(merchSource.slice(f7Start, f7End), /resolveMerchWorkingField/, "F7 must use the shared resolver");
assert.match(merchSource.slice(f9Start, f9End), /ONEAPP\.EXPORT\.buildWorkingPayload/, "F9 must use the shared resolver-backed payload builder");
assert.match(merchSource, /String\(v\) === String\(initialVal\) && !\(isMasterReferenceCell && userEdited\)/, "same-value edits on gray references must be recorded");
assert.match(merchSource.slice(f8Start, f8End), /explicitSale\.hasValue && explicitSale\.isExplicitBlank\) return ''/, "F8 must preserve an explicit blank sale cell");
assert.match(merchSource.slice(f7Start, f7End), /newMaster\[item\.코드\]\['판매여부'\] = explicitSale\.isExplicitBlank \? ''/, "F7 must preserve an explicit blank sale cell");
assert.match(merchSource.slice(f7Start, f7End), /commitCandidateFields = new Set\(\[\.\.\.Object\.keys\(activeSourceForCommit\), \.\.\.Object\.keys\(item\.finalData\)\]\)/, "F7 must inspect source-owned fields even when finalData omits them");

assert.doesNotMatch(exportSource, /working\.품목명 \|\| master\['품목명'\]/, "Export Center must not mix master reference into working name");
assert.doesNotMatch(exportSource, /working\.시중가 \|\| 기준시중가/, "Export Center must not mix baseline into working market price");
assert.doesNotMatch(exportSource, /getPromotionThemeString\(working\) \|\| getPromotionThemeString\(master\)/, "Export Center must not mix master theme into working theme");
assert.doesNotMatch(exportSource, /saleIsGenerated/, "F9 must not generate sale availability from unrelated price fields");
assert.match(exportSource, /'검색어등록', '창고', '단위', '1종코드'/, "F9 must preserve actual warehouse and unit working values");
assert.doesNotMatch(exportSource, /if \(!hasStockValue\(working\.재고수량\)\) return DEFAULT_EXPORT_STOCK_QTY/, "F9 must not generate stock 999 when the source column is missing");
assert.doesNotMatch(merchSource.slice(f8Start, f8End), /shopUploadStock = !window\.isBlankCell\(finalStockRaw\) \? window\.parseNum\(finalStockRaw\) : 999/, "F8 must not generate stock 999 when the source column is missing");
assert.doesNotMatch(merchSource.slice(f8Start, f8End), /finalTransmission = readQuickSourceNum\([^\n]+, inPrice\)/, "F8 must not copy inbound price into a missing final-transmission column");
assert.doesNotMatch(merchSource.slice(f8Start, f8End), /subMaster\['품목명'\]/, "F8 subdivision rows must not use master metadata as working fallback");
assert.doesNotMatch(dataOpsSource, /merch_export_draft/, "DataOps is not a consumer of the MerchOps F9 draft contract");

console.log("MerchOps master-reference isolation, explicit blank, zero/false, F7/F8/F9, and consumer contract tests passed.");
