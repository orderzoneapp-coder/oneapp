#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.lastIndexOf("</script>");
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "DataOps main script block must exist");

const mainScriptSource = source.slice(scriptStart + marker.length, scriptEnd);
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
new vm.Script(
  `${mainScriptSource.slice(inventoryEngineStart, inventoryEngineEnd)}\n` +
    "globalThis.actualUseInventoryEngine = useInventoryEngine;",
  { filename: "DataOps.inventory-engine.js" },
).runInContext(runtimeContext);

const inventoryEngine = runtimeContext.actualUseInventoryEngine({
  mappings: {
    excludeVendor: "우리농산, 1전송, 3우리, 가구매, 가판매",
    internalLot: "우리, 우리농산",
    lifoVendor: "",
    priorityVendor: "",
  },
  grouping: { manageMode: "LOT_DETAIL", priceMode: "average" },
  setAlertMsg: () => {},
  setConfirmModal: () => {},
  setIsProcessing: () => {},
  setAppStep: () => {},
});

const openingStock = {
  코드: "TEST-A",
  품명: "테스트상품_A",
  단위: "BOX",
  수량: 2,
  단가: 100,
  거래처: "테스트공급사_A",
  일자: "2026-01-01",
  _uploadRole: "prev",
  _fileType: "CLOSING_RESTORE",
  _sourceFileName: "테스트_기초재고.xlsx",
  _sourceSheet: "전체재고",
  _sourceRowNumber: 3,
  _raw: {
    품목코드: "TEST-A",
    품명: "테스트상품_A",
    재고: 2,
    구매가: 100,
    거래: "테스트공급사_A",
    기록: "2026-01-01",
  },
};

assert.equal(inventoryEngine.executeAnalysis({
  parsedPrev: [openingStock],
  parsedIn: [],
  parsedOut: [],
  parsedEnd: [],
  periodStr: "2026-01-02",
  targetDateStrFromData: "2026-01-02",
  endFileProvided: false,
}), true);

const [row] = hookState[0];
assert.equal(row.단가, 100, "average mode must not double a newly created opening-stock Lot cost");
assert.equal(row._totalCostForAvg, 200, "opening stock total cost must equal quantity times unit cost once");

const purchase = {
  코드: "TEST-B",
  품명: "테스트상품_B",
  단위: "BOX",
  수량: 3,
  단가: 200,
  거래처: "테스트공급사_B",
  일자: "2026-01-02",
  _transactionVendor: "테스트공급사_B",
  _purchaseLotVendor: "테스트공급사_B",
  _displayPurchaseVendor: "테스트공급사_B",
  _uploadRole: "in",
  _fileType: "RAW_DATA",
  _sourceFileName: "테스트_구매.xlsx",
  _sourceSheet: "구매현황내역",
  _sourceRowNumber: 3,
  _raw: {
    일자: "2026/01/02",
    거래처명: "테스트공급사_B",
    코드: "TEST-B",
    품명: "테스트상품_B",
    규격: "BOX",
    수량: 3,
    단가: 200,
    합계: 600,
  },
};

assert.equal(inventoryEngine.executeAnalysis({
  parsedPrev: [],
  parsedIn: [purchase],
  parsedOut: [],
  parsedEnd: [],
  periodStr: "2026-01-02",
  targetDateStrFromData: "2026-01-02",
  endFileProvided: false,
}), true);

const [purchaseRow] = hookState[0];
assert.equal(purchaseRow.단가, 200, "average mode must not double a newly created purchase Lot cost");
assert.equal(purchaseRow._totalCostForAvg, 600, "purchase total cost must equal quantity times unit cost once");

console.log("DataOps average-cost initialization regression contract passed.");
