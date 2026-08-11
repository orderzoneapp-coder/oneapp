#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const fixture = JSON.parse(
  fs.readFileSync("scripts/fixtures/dataops-inbound-cost-lot-allocation.json", "utf8"),
);

const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.lastIndexOf("</script>");
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "DataOps main script block must exist");
const mainScriptSource = source.slice(scriptStart + marker.length, scriptEnd);
new vm.Script(mainScriptSource, { filename: "DataOps.inline.js" });

const inventoryEngineStart = mainScriptSource.indexOf("const useInventoryEngine =");
const inventoryEngineEnd = mainScriptSource.indexOf("const IssueChip = React.memo", inventoryEngineStart);
assert.ok(inventoryEngineStart >= 0 && inventoryEngineEnd > inventoryEngineStart, "inventory engine section must exist");

const hookState = [];
let hookIndex = 0;
const runtimeReact = {
  useState: (initialValue) => {
    const index = hookIndex++;
    hookState[index] = typeof initialValue === "function" ? initialValue() : initialValue;
    return [
      hookState[index],
      (nextValue) => {
        hookState[index] = typeof nextValue === "function" ? nextValue(hookState[index]) : nextValue;
      },
    ];
  },
  useRef: (initialValue) => ({ current: initialValue }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
};

const runtimeContext = vm.createContext({
  console,
  React: runtimeReact,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  setTimeout: (callback) => {
    callback();
    return 1;
  },
  clearTimeout: () => {},
});
runtimeContext.window = runtimeContext;
runtimeContext.self = runtimeContext;
runtimeContext.globalThis = runtimeContext;

new vm.Script(mainScriptSource.slice(0, inventoryEngineStart), {
  filename: "DataOps.runtime-preamble.js",
}).runInContext(runtimeContext);
new vm.Script("globalThis.actualVendorChipModule = DATAOPS_VENDOR_CHIP_MODULE; globalThis.actualLotInvariantModule = DATAOPS_LOT_ALLOCATION_INVARIANT_MODULE; globalThis.actualPurchaseFlowModule = DATAOPS_PURCHASE_FLOW_MODULE;", {
  filename: "DataOps.vendor-chip-export.js",
}).runInContext(runtimeContext);
new vm.Script(
  `${mainScriptSource.slice(inventoryEngineStart, inventoryEngineEnd)}\n` +
    "globalThis.actualUseInventoryEngine = useInventoryEngine;",
  { filename: "DataOps.inventory-engine.js" },
).runInContext(runtimeContext);

const alertMessages = [];
const mappings = {
  excludeVendor: "우리농산, 1전송, 3우리, 가구매, 가판매",
  internalLot: "우리, 우리농산",
  lifoVendor: "",
  priorityVendor: "",
};
const inventoryEngine = runtimeContext.actualUseInventoryEngine({
  mappings,
  grouping: { manageMode: "LOT_DETAIL", priceMode: "latest" },
  setAlertMsg: (message) => alertMessages.push(String(message)),
  setConfirmModal: () => {},
  setIsProcessing: () => {},
  setAppStep: () => {},
});

assert.equal(inventoryEngine.executeAnalysis(fixture), true, "fixture analysis must complete");

const makeIsolatedFixture = ({ parsedPrev = [], parsedIn = [], parsedOut = [] } = {}) => ({
  ...fixture,
  parsedPrev,
  parsedIn,
  parsedOut,
  parsedEnd: [],
  endFileProvided: false,
});
const makeClassificationPurchase = (testCase, purchase, index) => ({
  코드: testCase.code,
  품명: `분류_${testCase.name}`,
  단위: "BOX",
  수량: purchase.qty,
  단가: purchase.cost,
  거래처: purchase.vendor,
  일자: fixture.periodStr,
  _transactionVendor: purchase.vendor,
  _purchaseTargetVendor: purchase.targetVendor,
  _purchaseLotVendor: purchase.vendor,
  _displayPurchaseVendor: purchase.vendor,
  _uploadRole: "in",
  _fileType: "RAW_DATA",
  _sourceFileName: "구매_분류fixture.xlsx",
  _sourceSheet: "구매현황",
  _raw: {
    전표번호: `${testCase.code}-IN-${index + 1}`,
    거래처명: purchase.vendor,
    구매처: purchase.targetVendor,
    품목코드: testCase.code,
    품목명: `분류_${testCase.name}`,
    수량: purchase.qty,
    단가: purchase.cost,
  },
});
const makeClassificationSale = (testCase, sale, index) => ({
  코드: testCase.code,
  품명: `분류_${testCase.name}`,
  단위: "BOX",
  수량: sale.qty,
  단가: sale.cost * 2,
  거래처: sale.vendor,
  매입처매칭: sale.purchaseVendor,
  일자: fixture.periodStr,
  _transactionVendor: sale.vendor,
  _salesVendor: sale.vendor,
  _salesDisplayVendor: sale.vendor,
  _salesGroupVendor: sale.vendor,
  _confirmedPurchaseVendor: sale.purchaseVendor,
  _salesConfirmedPurchaseVendor: sale.purchaseVendor,
  _hasSalesConfirmedPurchase: true,
  _salesPurchaseUnitCost: sale.cost,
  _uploadRole: "out",
  _fileType: "RAW_DATA",
  _sourceFileName: "판매_분류fixture.xlsx",
  _sourceSheet: "판매현황",
  _raw: {
    전표번호: `${testCase.code}-OUT-${index + 1}`,
    거래처명: sale.vendor,
    구매처: sale.purchaseVendor,
    구매단가: sale.cost,
    품목코드: testCase.code,
    품목명: `분류_${testCase.name}`,
    수량: sale.qty,
    단가: sale.cost * 2,
  },
});
const sourceEntriesForRole = (testRows, role) => testRows.flatMap((row) => row._sourceEntries || [])
  .filter((entry, index, entries) => entry.role === role && entries.findIndex((candidate) => candidate.id === entry.id) === index);
const chipQty = (row) => Object.values(row?.출고내역 || {}).reduce(
  (sum, detail) => sum + Number(detail?.qty || 0),
  0,
);

const exclusionViolations = [];
for (const testCase of fixture.internalPurchaseExclusionRegression.classificationCases) {
  const caseFixture = makeIsolatedFixture({
    parsedIn: testCase.purchases.map((purchase, index) => makeClassificationPurchase(testCase, purchase, index)),
    parsedOut: testCase.sales.map((sale, index) => makeClassificationSale(testCase, sale, index)),
  });
  assert.equal(inventoryEngine.executeAnalysis(caseFixture), true, `${testCase.name} analysis must complete`);
  const caseRows = hookState[0].filter((row) => String(row.코드) === testCase.code);
  const calculatedPurchaseRows = caseRows.filter((row) => Number(row.입고 || 0) !== 0);
  const expectedRow = testCase.expectedVendor ? calculatedPurchaseRows.find((row) => String(row.거래처) === testCase.expectedVendor) : null;
  if (calculatedPurchaseRows.length !== testCase.expectedCalculatedPurchaseRows) {
    exclusionViolations.push(
      `${testCase.name}: expected ${testCase.expectedCalculatedPurchaseRows} calculated purchase Lot(s), got ${calculatedPurchaseRows.length} (${calculatedPurchaseRows.map((row) => `${row.거래처}:${row._purchaseFlowKind}`).join(", ")})`,
    );
  }
  if (testCase.expectedKind && (!expectedRow || expectedRow._purchaseFlowKind !== testCase.expectedKind)) {
    exclusionViolations.push(
      `${testCase.name}: expected ${testCase.expectedVendor}:${testCase.expectedKind}, got ${expectedRow?._purchaseFlowKind || "missing"}`,
    );
  }
  const excludedInEntries = sourceEntriesForRole(caseRows, "in")
    .filter((entry) => ["우리농산", "3우리", "1전송"].includes(String(entry.vendor)));
  if (excludedInEntries.length !== testCase.expectedAuditExcludedCount || excludedInEntries.some((entry) => entry.calculationExcluded !== true)) {
    exclusionViolations.push(`${testCase.name}: expected ${testCase.expectedAuditExcludedCount} calculation-excluded audit entry, got ${excludedInEntries.length}`);
  }
  const calculatedInboundQty = sourceEntriesForRole(caseRows, "in")
    .filter((entry) => entry.calculationExcluded !== true)
    .reduce((sum, entry) => sum + Number(entry.qty || 0), 0);
  if (calculatedInboundQty !== testCase.expectedCalculatedInboundQty) {
    exclusionViolations.push(`${testCase.name}: calculated inbound ledger qty=${calculatedInboundQty}`);
  }
}

const greenOnionFixture = makeIsolatedFixture(fixture.internalPurchaseExclusionRegression);
assert.equal(inventoryEngine.executeAnalysis(greenOnionFixture), true, "green-onion actual-structure analysis must complete");
const greenOnionRows = hookState[0].filter((row) => String(row.코드) === "101020114");
const greenOnionPrevious = greenOnionRows.find((row) => Number(row.기초) === 13);
const greenOnionExternal = greenOnionRows.find((row) => String(row.거래처) === "가락(태수농산)");
const greenOnionInternalRows = greenOnionRows.filter((row) => ["우리농산", "3우리"].includes(String(row.거래처)));
const greenOnionInEntries = sourceEntriesForRole(greenOnionRows, "in");
const greenOnionInternalInEntries = greenOnionInEntries.filter((entry) => ["우리농산", "3우리"].includes(String(entry.vendor)));
if (greenOnionRows.length !== 2) exclusionViolations.push(`green-onion: expected 2 Lots, got ${greenOnionRows.length}`);
if (greenOnionInternalRows.length !== 0) exclusionViolations.push(`green-onion: internal Lots retained=${greenOnionInternalRows.map((row) => row.거래처).join(",")}`);
if (greenOnionInternalInEntries.length === 0 || greenOnionInternalInEntries.some((entry) => entry.calculationExcluded !== true)) exclusionViolations.push(`green-onion: excluded audit entries invalid=${greenOnionInternalInEntries.length}`);
const greenOnionCalculatedInboundQty = greenOnionInEntries.filter((entry) => entry.calculationExcluded !== true).reduce((sum, entry) => sum + Number(entry.qty || 0), 0);
if (greenOnionCalculatedInboundQty !== 600) {
  exclusionViolations.push(`green-onion: calculated inbound ledger qty=${greenOnionCalculatedInboundQty}`);
}
if (!greenOnionPrevious || Number(greenOnionPrevious.출고) !== 13) exclusionViolations.push(`green-onion: previous outbound=${greenOnionPrevious?.출고 ?? "missing"}`);
if (!greenOnionExternal || greenOnionExternal._purchaseFlowKind !== "STANDARD") exclusionViolations.push(`green-onion: external kind=${greenOnionExternal?._purchaseFlowKind || "missing"}`);
if (!greenOnionExternal || Number(greenOnionExternal.입고) !== 600 || Number(greenOnionExternal.출고) !== 504 || Number(greenOnionExternal.전산잔량) !== 96) {
  exclusionViolations.push(`green-onion: external in/out/remain=${greenOnionExternal?.입고 ?? "missing"}/${greenOnionExternal?.출고 ?? "missing"}/${greenOnionExternal?.전산잔량 ?? "missing"}`);
}
if (greenOnionRows.reduce((sum, row) => sum + Number(row.출고 || 0), 0) !== 517) {
  exclusionViolations.push(`green-onion: external-sale outbound=${greenOnionRows.reduce((sum, row) => sum + Number(row.출고 || 0), 0)}`);
}
if (greenOnionRows.reduce((sum, row) => sum + chipQty(row), 0) !== 517) {
  exclusionViolations.push(`green-onion: customer-chip qty=${greenOnionRows.reduce((sum, row) => sum + chipQty(row), 0)}`);
}
const greenOnionInvariant = runtimeContext.actualLotInvariantModule.validateRows(greenOnionRows);
if (greenOnionInvariant.mismatchCount !== 0) exclusionViolations.push(`green-onion: allocation mismatches=${greenOnionInvariant.mismatchCount}`);

assert.deepEqual(
  exclusionViolations,
  [],
  "excluded purchase rows must stay audit-only while calculated purchase Lots remain external-source only",
);

assert.equal(inventoryEngine.executeAnalysis(fixture), true, "fixture analysis must still complete after isolated classification checks");
const returnFixture = {
  ...fixture,
  parsedPrev: [...fixture.parsedPrev, ...fixture.returnRegression.parsedPrev],
  parsedOut: [...fixture.parsedOut, ...fixture.returnRegression.parsedOut],
};
assert.equal(
  inventoryEngine.executeAnalysis(returnFixture),
  true,
  "actual sales-sheet negative quantity/return structure must complete without a runtime ReferenceError",
);
const rows = hookState[0];
assert.ok(Array.isArray(rows), "analysis must publish product rows");

const bokChoyRows = rows.filter((row) => String(row.코드) === "104574110");
const rowByPrice = (price) => bokChoyRows.find((row) => Number(row.단가) === price);

assert.equal(bokChoyRows.length, 3, "previous and the two calculated Garak Lots must remain without an excluded Woori purchase Lot");

const previousLot = rowByPrice(14000);
const garakLot = rowByPrice(9000);
const external9500Lot = rowByPrice(9500);
assert.ok(previousLot, "previous closing Lot must remain at 14,000");
assert.ok(garakLot, "Garak Lot must remain at 9,000");
assert.equal(rowByPrice(6500), undefined, "excluded Woori purchase must not create a calculated 6,500 Lot");
assert.ok(external9500Lot, "non-excluded Garak external-source Lot must remain at 9,500");
assert.equal(external9500Lot.거래처, "가락(고창)");
assert.equal(external9500Lot._purchaseFlowKind, "STANDARD");
assert.equal(bokChoyRows.some((row) => String(row.거래처) === "3우리"), false, "3-Woori internal-move Lot must be completely excluded from purchases");
assert.equal(runtimeContext.actualPurchaseFlowModule.isExactStockInstruction("재고"), true);
assert.equal(runtimeContext.actualPurchaseFlowModule.isExactStockInstruction("재고 확인"), false);

assert.equal(previousLot.기초, 1);
assert.equal(previousLot.단가, 14000, "previous closing Lot cost must not be overwritten");
assert.equal(previousLot.출고, 1, "exact stock instruction must consume previous FIFO stock");
assert.equal(garakLot.출고, 18, "Garak confirmed purchase and FIFO fallback must allocate 18 in total");
assert.equal(external9500Lot.출고, 121, "the excluded-purchase confirmed sale must fall back to calculated external FIFO Lots");

assert.equal(chipQty(previousLot), 1);
assert.equal(chipQty(garakLot), 18);
assert.equal(chipQty(external9500Lot), 121);
assert.equal(bokChoyRows.reduce((sum, row) => sum + Number(row.출고 || 0), 0), 140);
assert.equal(bokChoyRows.reduce((sum, row) => sum + chipQty(row), 0), 140);
const excludedBokChoyAuditEntries = sourceEntriesForRole(bokChoyRows, "in")
  .filter((entry) => ["우리농산", "3우리"].includes(String(entry.vendor)));
assert.ok(excludedBokChoyAuditEntries.length >= 2, "excluded purchases must survive in the audit Source Ledger");
assert.ok(excludedBokChoyAuditEntries.every((entry) => entry.calculationExcluded === true));

const invariant = runtimeContext.actualLotInvariantModule.validateRows(bokChoyRows);
assert.equal(invariant.mismatchCount, 0);
assert.equal(invariant.unallocatedQty, 0);
assert.equal(invariant.overallocatedQty, 0);

const matchedReturnRows = rows.filter((row) => String(row.코드) === "990001001");
assert.equal(matchedReturnRows.length, 1, "same-vendor return fixture must stay on its source Lot");
assert.equal(matchedReturnRows[0].출고, 0, "same-vendor return must reverse the original sale quantity");
assert.equal(chipQty(matchedReturnRows[0]), 0, "same-vendor return must reverse the original sales chip quantity");
assert.equal(matchedReturnRows[0].매출액, 0, "same-vendor return must reverse the original sale revenue");
assert.equal(matchedReturnRows[0].매출원가, 0, "same-vendor return must reverse the original sale COGS");
assert.match(matchedReturnRows[0].메모, /원판매Lot복원/, "same-vendor return must use the original sale-allocation reversal path");
assert.doesNotMatch(matchedReturnRows[0].메모, /원판매미확정/, "same-vendor return must not use guarded fallback");
assert.equal(
  (matchedReturnRows[0].이슈 || []).some((issue) => String(issue).includes("반품원판매매칭확인")),
  false,
  "same-vendor return must not be reported as a vendor mismatch",
);

const mismatchedReturnRows = rows.filter((row) => String(row.코드) === "990001002");
assert.equal(mismatchedReturnRows.length, 1, "mismatched-vendor return fixture must remain auditable on one Lot");
assert.equal(mismatchedReturnRows[0].출고, 0, "mismatched-vendor return may restore stock through guarded fallback");
assert.equal(mismatchedReturnRows[0]._salesLotAllocations?.[0]?.returnableQty, 1, "mismatched return must not consume another customer's sale allocation");
assert.equal(mismatchedReturnRows[0].출고내역?.판매처A?.qty, 1, "original customer sale chip must remain auditable");
assert.equal(mismatchedReturnRows[0].출고내역?.판매처B?.qty, -1, "mismatched return chip must remain a separate guarded fallback entry");
assert.equal(
  (mismatchedReturnRows[0].이슈 || []).some((issue) => String(issue).includes("반품원판매매칭확인")),
  true,
  "explicitly mismatched return vendor must not silently reverse another customer's sale history",
);

const salesReturnSource = source.slice(
  source.indexOf("const applySalesReturn = () =>"),
  source.indexOf("if (qtyToDeduct < 0)", source.indexOf("const applySalesReturn = () =>")),
);
assert.doesNotMatch(salesReturnSource, /normalizeVendorIdentity/, "sales return path must not reference the removed internal-vendor helper");
assert.match(
  salesReturnSource,
  /normalizeSalesVendorIdentity\s*=\s*\(value\)\s*=>\s*normalizeLotNameForMatch\(value\)/,
  "sales return vendor equality must reuse the neutral Lot/vendor normalizer",
);
assert.match(
  salesReturnSource,
  /const hasExplicitReturnVendor = !!normalizeSalesVendorIdentity\(state\.vendor\)/,
  "explicit return-vendor defense must use the same neutral identity helper",
);

const correctedLedger = runtimeContext.DATAOPS_SALES_REMATCH_MODULE.buildCorrectedLedgerRows({
  productData: rows,
  substHistory: [],
});
const ledgerAllocations = (identifier) => correctedLedger.filter((row) => row.originalIdentifier === identifier);
const stockLedgerAllocations = ledgerAllocations("SALE-STOCK-001");
const garakLedgerAllocations = ledgerAllocations("SALE-GARAK-009");
const wooriLedgerAllocations = ledgerAllocations("SALE-WOORI-130");
assert.equal(stockLedgerAllocations.length, 1);
assert.equal(stockLedgerAllocations[0].currentKey, external9500Lot.batchKey);
assert.equal(garakLedgerAllocations.length, 1);
assert.equal(garakLedgerAllocations[0].currentKey, garakLot.batchKey);
assert.equal(wooriLedgerAllocations.reduce((sum, row) => sum + Number(row.qty || 0), 0), 130);
assert.ok(wooriLedgerAllocations.every((row) => row.unitPrice === 10000));
assert.equal(wooriLedgerAllocations.some((row) => Number(row.unitCost) === 6500), false, "excluded Woori purchase cost must not enter corrected-ledger FIFO allocations");
const stockAllocation = external9500Lot._salesLotAllocations?.find((allocation) => allocation.originalIdentifier === "SALE-STOCK-001");
assert.equal(stockAllocation?.originalIdentifier, "SALE-STOCK-001");
assert.equal(stockAllocation?.sourceEntryId.startsWith("SRC_"), true);
assert.equal(stockAllocation?.batchKey, external9500Lot.batchKey);
assert.equal(stockAllocation?.salesVendor, "재고판매처");
assert.equal(stockAllocation?.qty, 1);
assert.equal(stockAllocation?.revenue, 20000);
assert.equal(stockAllocation?.unitPrice, 20000);
assert.equal(external9500Lot._sourceEntries?.some((entry) => entry.role === "out" && entry.sourceRaw?.전표번호 === "SALE-STOCK-001"), true);

const detailRows = runtimeContext.DATAOPS_SALES_REMATCH_MODULE.applyCorrectedDetailsToViewRows({
  viewRows: rows.map((row) => ({ ...row, _isViewRow: true, _viewMode: "LOT_DETAIL", _viewSourceKeys: [row.batchKey] })),
  productData: rows,
  substHistory: [],
  viewMode: "LOT_DETAIL",
});
for (const row of detailRows) {
  const displayedChipQty = Object.values(row._correctedSalesDetails || {}).reduce(
    (sum, detail) => sum + Number(detail?.qty || 0),
    0,
  );
  assert.equal(displayedChipQty, Number(row.출고 || 0), `Lot chip invariant failed for ${row.batchKey}`);
}

const mismatchSample = runtimeContext.actualLotInvariantModule.validateRows([
  {
    batchKey: "SHORT",
    코드: "SHORT",
    품명: "부족",
    출고: 3,
    출고내역: { 거래처A: { qty: 2, rev: 200, cogs: 100, displayVendor: "거래처A" } },
  },
  {
    batchKey: "OVER",
    코드: "OVER",
    품명: "초과",
    출고: 1,
    출고내역: { 거래처B: { qty: 2, rev: 200, cogs: 100, displayVendor: "거래처B" } },
  },
]);
assert.equal(mismatchSample.mismatchCount, 2);
assert.equal(mismatchSample.unallocatedQty, 1);
assert.equal(mismatchSample.overallocatedQty, 1);
assert.match(mismatchSample.rows[0].message, /거래처 미배정 1/);
assert.match(mismatchSample.rows[1].message, /거래처 과다배정 1/);
assert.ok(mismatchSample.rows.every((row) => row.commonMessage === "출고·거래처 수량 불일치"));
const unreconciled = runtimeContext.actualVendorChipModule.reconcileItem({
  batchKey: "NO_AUTO_FIX",
  코드: "NO_AUTO_FIX",
  품명: "자동보정금지",
  출고: 3,
  이슈: [],
  출고내역: { 거래처A: { qty: 2, rev: 200, cogs: 100, displayVendor: "거래처A" } },
});
assert.equal(unreconciled.출고, 3);
assert.equal(chipQty(unreconciled), 2, "reconcileItem must not hide one unallocated unit");
assert.ok(unreconciled.이슈.some((issue) => issue.includes("거래처 미배정 1")));

const splitLedgerRows = [
  {
    batchKey: "LOT_A",
    코드: "SPLIT",
    품명: "분할원본",
    단위: "BOX",
    _salesLotAllocations: [{ allocationId: "ALLOC_A", sourceEntryId: "SRC_SPLIT", originalIdentifier: "SALE-SPLIT", batchKey: "LOT_A", salesVendor: "분할거래처", purchaseVendor: "구매처A", qty: 1, revenue: 10000, unitPrice: 10000, unitCost: 5000 }],
  },
  {
    batchKey: "LOT_B",
    코드: "SPLIT",
    품명: "분할원본",
    단위: "BOX",
    _salesLotAllocations: [{ allocationId: "ALLOC_B", sourceEntryId: "SRC_SPLIT", originalIdentifier: "SALE-SPLIT", batchKey: "LOT_B", salesVendor: "분할거래처", purchaseVendor: "구매처B", qty: 3, revenue: 30000, unitPrice: 10000, unitCost: 6000 }],
  },
];
const splitCorrected = runtimeContext.DATAOPS_SALES_REMATCH_MODULE.buildCorrectedLedgerRows({ productData: splitLedgerRows, substHistory: [] });
assert.deepEqual(Array.from(splitCorrected, (row) => row.currentKey).sort(), ["LOT_A", "LOT_B"]);
const splitOriginal = runtimeContext.DATAOPS_SALES_REMATCH_MODULE.buildOriginalStatementRows(splitLedgerRows);
assert.equal(splitOriginal.length, 1, "one original sale row must remain one original statement row");
assert.equal(splitOriginal[0].qty, 4);
assert.equal(splitOriginal[0].supplyAmount, 40000);
const dragAllocation = runtimeContext.DATAOPS_SALES_REMATCH_MODULE.allocateSourceLedgerForMove({
  productData: splitLedgerRows,
  substHistory: [],
  sourceCode: "SPLIT",
  sourceKey: "LOT_A",
  vendor: "분할거래처",
  sourceQty: 1,
});
assert.equal(dragAllocation.length, 1);
assert.equal(dragAllocation[0].sourceEntryId, "SRC_SPLIT");
assert.equal(dragAllocation[0].qty, 1);

const purchaseFlowSource = source.slice(
  source.indexOf("const DATAOPS_PURCHASE_FLOW_MODULE"),
  source.indexOf("// V1.a22.111: ONEAPP 원본보존 규범."),
);
assert.doesNotMatch(purchaseFlowSource, /우리농산|3우리|excludeVendor|internalLot/, "purchase flow classifier must not depend on vendor-name lists");

assert.match(source, /handleGenerateTransferSalesUpload[\s\S]*?allocationInvariantSummary[\s\S]*?판매업로드/);
assert.match(source, /handleCombinedExport[\s\S]*?allocationInvariantSummary[\s\S]*?F9/);
assert.match(source, /saveWorkState[\s\S]*?DATAOPS_WORK_STATE_MODULE\.save/);

console.log("DataOps inbound-cost and Lot allocation regression contract passed.");
