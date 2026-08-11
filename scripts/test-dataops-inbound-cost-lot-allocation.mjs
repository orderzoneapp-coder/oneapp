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
const chipQty = (row) => Object.values(row?.출고내역 || {}).reduce(
  (sum, detail) => sum + Number(detail?.qty || 0),
  0,
);

assert.equal(bokChoyRows.length, 4, "previous, Garak, Woori, and 3-Woori Lot rows must all remain");

const previousLot = rowByPrice(14000);
const garakLot = rowByPrice(9000);
const wooriLot = rowByPrice(6500);
const internalMoveLot = rowByPrice(9500);
assert.ok(previousLot, "previous closing Lot must remain at 14,000");
assert.ok(garakLot, "Garak Lot must remain at 9,000");
assert.ok(wooriLot, "Woori external-sale Lot must remain at 6,500");
assert.ok(internalMoveLot, "3-Woori internal-move Lot must remain at 9,500");
assert.equal(wooriLot._purchaseFlowKind, "CONFIRMED_EXTERNAL");
assert.equal(wooriLot._externalSalesCostEligible, true);
assert.equal(internalMoveLot._purchaseFlowKind, "INTERNAL_MOVEMENT");
assert.equal(internalMoveLot._externalSalesCostEligible, false);
assert.equal(runtimeContext.actualPurchaseFlowModule.isExactStockInstruction("재고"), true);
assert.equal(runtimeContext.actualPurchaseFlowModule.isExactStockInstruction("재고 확인"), false);

assert.equal(previousLot.기초, 1);
assert.equal(previousLot.단가, 14000, "previous closing Lot cost must not be overwritten");
assert.equal(previousLot.출고, 1, "exact stock instruction must consume previous FIFO stock");
assert.equal(garakLot.출고, 9, "Garak confirmed purchase must allocate 9");
assert.equal(wooriLot.출고, 130, "Woori confirmed purchase must allocate 130 even though the name is internal-looking");
assert.equal(internalMoveLot.출고, 0, "3-Woori internal-move Lot must not receive external sales cost allocation");

assert.equal(chipQty(previousLot), 1);
assert.equal(chipQty(garakLot), 9);
assert.equal(chipQty(wooriLot), 130);
assert.equal(chipQty(internalMoveLot), 0);
assert.equal(bokChoyRows.reduce((sum, row) => sum + Number(row.출고 || 0), 0), 140);
assert.equal(bokChoyRows.reduce((sum, row) => sum + chipQty(row), 0), 140);

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
const ledgerByIdentifier = new Map(correctedLedger.map((row) => [row.originalIdentifier, row]));
assert.equal(ledgerByIdentifier.get("SALE-STOCK-001")?.currentKey, previousLot.batchKey);
assert.equal(ledgerByIdentifier.get("SALE-GARAK-009")?.currentKey, garakLot.batchKey);
assert.equal(ledgerByIdentifier.get("SALE-WOORI-130")?.currentKey, wooriLot.batchKey);
assert.equal(ledgerByIdentifier.get("SALE-WOORI-130")?.qty, 130);
assert.equal(ledgerByIdentifier.get("SALE-WOORI-130")?.unitPrice, 10000);
const stockAllocation = previousLot._salesLotAllocations?.[0];
assert.equal(stockAllocation?.originalIdentifier, "SALE-STOCK-001");
assert.equal(stockAllocation?.sourceEntryId.startsWith("SRC_"), true);
assert.equal(stockAllocation?.batchKey, previousLot.batchKey);
assert.equal(stockAllocation?.salesVendor, "재고판매처");
assert.equal(stockAllocation?.qty, 1);
assert.equal(stockAllocation?.revenue, 20000);
assert.equal(stockAllocation?.unitPrice, 20000);
assert.equal(previousLot._sourceEntries?.filter((entry) => entry.role === "out").length, 1);
assert.equal(previousLot._sourceEntries?.find((entry) => entry.role === "out")?.sourceRaw?.전표번호, "SALE-STOCK-001");

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
