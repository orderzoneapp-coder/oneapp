#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const stockModuleSource = section(
  "const STOCK_ENGINE_MODULE",
  "const ISSUE_MODULE",
);
const stockContext = {
  safeNum(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
};
vm.createContext(stockContext);
new vm.Script(
  `${stockModuleSource}
globalThis.stockEngine = STOCK_ENGINE_MODULE;`,
  { filename: "DataOps.stock-engine.js" },
).runInContext(stockContext);

const untouchedShortage = {
  기초: 0,
  입고: 0,
  출고: 1,
  대체입고: 0,
  대체출고: 0,
  실사: null,
  로스: 0,
};
assert.deepEqual(
  { ...stockContext.stockEngine.calculateStock(untouchedShortage) },
  { systemQty: -1, finalQty: -1, diffQty: 0 },
  "an untouched shortage must remain balance -1 / difference 0",
);
assert.equal(stockContext.stockEngine.getActualQty(untouchedShortage), -1);

const manuallyCorrected = { ...untouchedShortage, 실사: 0 };
assert.deepEqual(
  { ...stockContext.stockEngine.calculateStock(manuallyCorrected) },
  { systemQty: -1, finalQty: 0, diffQty: 1 },
  "only an explicit final balance of zero may produce difference +1",
);

const candidateModuleSource = section(
  "const DATAOPS_SUBSTITUTION_CANDIDATE_MODULE",
  "window.DATAOPS_SUBSTITUTION_CANDIDATE_MODULE",
);
const candidateContext = {
  safeNum: stockContext.safeNum,
  safeStr(value, fallback = "") {
    return value === undefined || value === null || value === ""
      ? fallback
      : String(value);
  },
  parseNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  formatItemDate(value) {
    return value || "";
  },
  STOCK_ENGINE_MODULE: stockContext.stockEngine,
  DATAOPS_MASTER_LINK_MODULE: {
    applyMasterLinksToRows(rows) {
      return rows.map((row) => ({ ...row }));
    },
    buildMasterLedgerInfo(item) {
      return item._masterLink || {};
    },
  },
  DATAOPS_OPERATION_MODULE: {
    hasLotCostResolved() {
      return false;
    },
  },
  DATAOPS_ISSUE_HELPER: {
    syncQuantityIssues(_item, issues) {
      return issues;
    },
    unique(issues) {
      return [...new Set(issues)];
    },
  },
  window: {},
};
vm.createContext(candidateContext);
new vm.Script(
  `${candidateModuleSource}
globalThis.candidateModule = DATAOPS_SUBSTITUTION_CANDIDATE_MODULE;`,
  { filename: "DataOps.substitution-candidates.js" },
).runInContext(candidateContext);

const chainRows = [
  {
    batchKey: "BOX_LOT",
    코드: "ENOKI_BOX",
    품명: "팽이버섯 원물",
    기초: 1,
    입고: 0,
    출고: 0,
    대체입고: 0,
    대체출고: 0,
    전산잔량: 1,
    실사: 1,
    로스: 0,
    단가: 34000,
    이슈: [],
    출고내역: {},
    _masterLink: { productType: "원물" },
  },
  {
    batchKey: "LOOSE",
    코드: "ENOKI_LOOSE",
    품명: "팽이버섯 낱개",
    기초: 0,
    입고: 0,
    출고: 1,
    대체입고: 0,
    대체출고: 0,
    전산잔량: -1,
    실사: -1,
    로스: 0,
    단가: 0,
    이슈: [],
    출고내역: {},
    _masterLink: {
      productType: "원물/소분",
      masterCode: "ENOKI_LOOSE",
      masterName: "팽이버섯 낱개",
      rawCode: "ENOKI_BOX",
      rawName: "팽이버섯 원물",
      conversionRate: 34,
      stockConversionQty: 34,
    },
  },
  {
    batchKey: "PACK5",
    코드: "ENOKI_PACK5",
    품명: "팽이버섯 5개입",
    기초: 0,
    입고: 0,
    출고: 1,
    대체입고: 0,
    대체출고: 0,
    전산잔량: -1,
    실사: -1,
    로스: 0,
    단가: 0,
    이슈: [],
    출고내역: {},
    _masterLink: {
      productType: "소분",
      masterCode: "ENOKI_PACK5",
      masterName: "팽이버섯 5개입",
      rawCode: "ENOKI_LOOSE",
      rawName: "팽이버섯 낱개",
      conversionRate: 0.2,
      stockConversionQty: 0.2,
    },
  },
];
const beforeCandidateLookup = structuredClone(chainRows);
candidateContext.candidateModule.buildCandidateRows({
  productData: chainRows,
  targetDateStr: "2026-07-27",
});
assert.deepEqual(
  chainRows,
  beforeCandidateLookup,
  "candidate lookup must not mutate BOX, loose-unit, or 5-pack inventory",
);

const executeAnalysis = section(
  "const executeAnalysis = useCallback",
  "const runAnalysis = useCallback",
);
assert.doesNotMatch(executeAnalysis, /recordUnallocatedLot|UNALLOCATED_LOT/);
assert.match(executeAnalysis, /item\._actualQtySource\s*=\s*'SYSTEM_CALCULATED'/);

const previewFilter = section(
  "else if (filters.reviewType === 'substitution') {",
  "data = FILTER_SORT_MODULE.applyFilters",
);
assert.match(previewFilter, /STOCK_ENGINE_MODULE\.calculateStock\(p\)/);
assert.doesNotMatch(previewFilter, /setProductData|executeMasterSubstitutionCandidates/);

const previewButton = section(
  'React.createElement("div", { onClick: () => { setActiveIssueMode(null); setActiveMultiCode(null); setFilters({ ...filters, reviewType:',
  'React.createElement("div", { onClick: () => { if (activeIssueMode !== \'stockLot\')',
);
const previewToggleHandler = previewButton.match(
  /onClick:\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*className:/,
);
assert.ok(previewToggleHandler, "missing substitution preview toggle handler");
assert.match(previewToggleHandler[1], /setFilters/);
assert.doesNotMatch(
  previewToggleHandler[1],
  /setProductData|executeMasterSubstitutionCandidates/,
);
assert.match(previewButton, /e\.stopPropagation\(\);\s*executeMasterSubstitutionCandidates\(\)/);

console.log("DataOps substitution preview read-only contract passed.");
