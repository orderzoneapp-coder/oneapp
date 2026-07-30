#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const html = fs.readFileSync(path.join(ROOT, "DataOps.html"), "utf8");

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim() !== "");

assert.ok(inlineScripts.length > 0, "DataOps.html must contain inline scripts");
inlineScripts.forEach((script, index) => {
  new vm.Script(script, { filename: `DataOps-inline-${index + 1}.js` });
});

const moduleStart = html.indexOf("const DATAOPS_SUBSTITUTION_CANDIDATE_MODULE = Object.freeze({");
const moduleExport = html.indexOf("window.DATAOPS_SUBSTITUTION_CANDIDATE_MODULE", moduleStart);
const moduleEnd = html.lastIndexOf("});", moduleExport);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "substitution candidate module must be extractable");

const expressionStart = html.indexOf("Object.freeze({", moduleStart);
const moduleExpression = `${html.slice(expressionStart, moduleEnd + 2)}`;
const context = {
  console,
  Object,
  Array,
  Math,
  Date,
  Number,
  String,
  Set,
  Map,
  safeStr: (value, fallback = "") => {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  },
  safeNum: (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  parseNumber: (value) => {
    const parsed = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  },
  formatItemDate: (value) => Number(String(value ?? "").replace(/\D/g, "")) || 99999999,
  STOCK_ENGINE_MODULE: {
    getActualQty: (item = {}) => {
      if (item.실사 !== "" && item.실사 !== null && item.실사 !== undefined) return Number(item.실사) || 0;
      return Number(item.전산잔량) || 0;
    },
  },
  FILTER_SORT_MODULE: {
    getPurchaseDateSortValue: (item = {}) => Number(String(item.일자 || "").replace(/\D/g, "")) || 99999999,
  },
  DATAOPS_MASTER_LINK_MODULE: {
    applyMasterLinksToRows: (rows = []) => rows,
    buildMasterLedgerInfo: () => ({}),
  },
};
context.window = context;
vm.runInNewContext(`DATAOPS_SUBSTITUTION_CANDIDATE_MODULE = ${moduleExpression}`, context, {
  filename: "DataOps-substitution-candidate-module.js",
});

const candidateModule = context.DATAOPS_SUBSTITUTION_CANDIDATE_MODULE;
assert.equal(typeof candidateModule.buildRowsByCode, "function");
assert.equal(typeof candidateModule.selectRawLotsForExecution, "function");

const productData = [
  { batchKey: "R1", 코드: "RAW", 일자: "2026-07-28", 전산잔량: 3, 실사: 3, 거래처: "A", 단가: 1000 },
  { batchKey: "R2", 코드: "RAW", 일자: "2026-07-29", 전산잔량: 4, 실사: 4, 거래처: "B", 단가: 1100 },
  { batchKey: "S1", 코드: "SUB", 일자: "2026-07-30", 전산잔량: -5, 실사: -5, 거래처: "C", 단가: 0 },
];
const candidateRow = { 원물코드: "RAW", 필요원물수량: 5 };

const legacyResult = candidateModule.selectRawLotsForExecution(candidateRow, productData);
const rowsByCode = candidateModule.buildRowsByCode(productData);
const indexedResult = candidateModule.selectRawLotsForExecution(candidateRow, productData, rowsByCode);
const simplify = (result) => ({
  ok: result.ok,
  remaining: result.remaining,
  allocations: result.allocations.map((allocation) => ({
    batchKey: allocation.item.batchKey,
    takeQty: allocation.takeQty,
  })),
});

assert.equal(JSON.stringify(simplify(indexedResult)), JSON.stringify(simplify(legacyResult)));
assert.equal(JSON.stringify(simplify(indexedResult)), JSON.stringify({
  ok: true,
  remaining: 0,
  allocations: [
    { batchKey: "R1", takeQty: 3 },
    { batchKey: "R2", takeQty: 2 },
  ],
}));

const previewStart = html.indexOf("const substitutionPreviewView = useMemo(() => {");
const previewEnd = html.indexOf("const substitutionCandidateStatusCounts", previewStart);
const previewSource = html.slice(previewStart, previewEnd);
assert.match(previewSource, /const rowsByCode = DATAOPS_SUBSTITUTION_CANDIDATE_MODULE\.buildRowsByCode\(productData \|\| \[\]\)/);
assert.match(previewSource, /selectRawLotsForExecution\(row, productData \|\| \[\], rowsByCode\)/);
assert.doesNotMatch(previewSource, /const subItems = \(productData \|\| \[\]\)\.filter/);

assert.match(html, /const handleOpenMemo = useCallback/);
assert.doesNotMatch(html, /onOpenMemo: \(key, text\) =>/);
assert.match(html, /isMultiGroupItem: multiPriceCodeSet\.has\(item\.코드\)/);
assert.match(html, /const stabilizeViewRows = useCallback/);

const appStart = html.indexOf("function App() {");
const productDataBinding = html.indexOf("const { productData, setProductData", appStart);
const productDataRefBinding = html.indexOf("const productDataRef = useRef(productData);", appStart);
assert.ok(appStart >= 0 && productDataBinding > appStart, "App productData binding must be present");
assert.ok(
  productDataRefBinding > productDataBinding,
  "App productDataRef must be initialized after productData to prevent initial-render TDZ failures",
);

const benchmarkRows = Array.from({ length: 5000 }, (_, index) => ({
  batchKey: `RAW_${index}`,
  코드: `RAW_${index % 500}`,
  일자: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
  전산잔량: 10,
  실사: 10,
  거래처: `V_${index % 20}`,
  단가: 1000 + (index % 100),
}));
const benchmarkCandidates = Array.from({ length: 300 }, (_, index) => ({
  원물코드: `RAW_${index % 500}`,
  필요원물수량: 15,
}));

for (let index = 0; index < 3; index += 1) {
  candidateModule.selectRawLotsForExecution(benchmarkCandidates[index], benchmarkRows);
}

let legacyAllocationCount = 0;
const legacyStartedAt = performance.now();
benchmarkCandidates.forEach((row) => {
  legacyAllocationCount += candidateModule.selectRawLotsForExecution(row, benchmarkRows).allocations.length;
});
const legacyMs = performance.now() - legacyStartedAt;

const indexedStartedAt = performance.now();
const benchmarkRowsByCode = candidateModule.buildRowsByCode(benchmarkRows);
let indexedAllocationCount = 0;
benchmarkCandidates.forEach((row) => {
  indexedAllocationCount += candidateModule.selectRawLotsForExecution(row, benchmarkRows, benchmarkRowsByCode).allocations.length;
});
const indexedMs = performance.now() - indexedStartedAt;

assert.equal(indexedAllocationCount, legacyAllocationCount);
assert.ok(indexedMs < legacyMs, `indexed preview must be faster (legacy=${legacyMs.toFixed(1)}ms, indexed=${indexedMs.toFixed(1)}ms)`);

console.log(
  `DataOps space replacement performance regression tests passed. ` +
  `Synthetic preview: ${legacyMs.toFixed(1)}ms -> ${indexedMs.toFixed(1)}ms ` +
  `(${((1 - indexedMs / legacyMs) * 100).toFixed(1)}% faster).`,
);
