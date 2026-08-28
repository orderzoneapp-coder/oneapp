#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const mainScriptMarker = '<script type="text/javascript">';
const mainScriptStart = source.indexOf(mainScriptMarker);
const mainScriptEnd = source.lastIndexOf("</script>");
assert.notEqual(mainScriptStart, -1, "Missing DataOps main script block");
assert.ok(mainScriptEnd > mainScriptStart, "Missing DataOps main script closing tag");
const mainScriptSource = source.slice(
  mainScriptStart + mainScriptMarker.length,
  mainScriptEnd,
);

const inventoryEngineMarker = "const useInventoryEngine =";
const inventoryEngineStart = mainScriptSource.indexOf(inventoryEngineMarker);
const inventoryEngineEnd = mainScriptSource.indexOf(
  "const IssueChip = React.memo",
  inventoryEngineStart,
);
assert.notEqual(inventoryEngineStart, -1, "Missing useInventoryEngine runtime source");
assert.ok(
  inventoryEngineEnd > inventoryEngineStart,
  "Missing useInventoryEngine runtime end marker",
);

function createRuntime() {
  const hookState = [];
  let hookIndex = 0;
  const runtimeReact = {
    useState: (initialValue) => {
      const index = hookIndex++;
      const initial =
        typeof initialValue === "function" ? initialValue() : initialValue;
      hookState[index] = initial;
      return [
        initial,
        (nextValue) => {
          hookState[index] =
            typeof nextValue === "function"
              ? nextValue(hookState[index])
              : nextValue;
        },
      ];
    },
    useRef: (initialValue) => ({ current: initialValue }),
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
  };
  const storageValues = new Map();
  const runtimeContext = vm.createContext({
    console,
    React: runtimeReact,
    localStorage: {
      getItem: (key) =>
        storageValues.has(String(key)) ? storageValues.get(String(key)) : null,
      setItem: (key, value) =>
        storageValues.set(String(key), String(value)),
      removeItem: (key) => storageValues.delete(String(key)),
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
    `${mainScriptSource.slice(inventoryEngineStart, inventoryEngineEnd)}
globalThis.actualUseInventoryEngine = useInventoryEngine;`,
    { filename: "DataOps.inventory-engine.js" },
  ).runInContext(runtimeContext);

  const alerts = [];
  const engine = runtimeContext.actualUseInventoryEngine({
    mappings: {},
    grouping: {},
    setAlertMsg: (message) => alerts.push(message),
    setConfirmModal: () => {},
    setIsProcessing: () => {},
    setAppStep: () => {},
  });
  return {
    run(rows, sourceKey, targetKey) {
      engine.setProductData(rows);
      engine.executeImmediateSubstitution(sourceKey, targetKey);
      return {
        rows: hookState[0],
        history: hookState[3],
        alerts,
      };
    },
  };
}

const makeRow = (overrides = {}) => ({
  batchKey: "",
  코드: "",
  품명: "",
  단위: "EA",
  단가: 0,
  기초: 0,
  입고: 0,
  출고: 0,
  대체입고: 0,
  대체출고: 0,
  전산잔량: 0,
  실사: 0,
  로스: 0,
  매출액: 0,
  매출원가: 0,
  메모: "",
  이슈: [],
  출고내역: {},
  수기확인완료: false,
  _orig: { 기초: 0, 입고: 0, 출고: 0, 단가: 0 },
  ...overrides,
});

const actualSource = makeRow({
  batchKey: "RAW_LOT",
  코드: "RAW",
  품명: "실제 출고 원물",
  단가: 100,
  전산잔량: 0,
  실사: 9,
  로스: 9,
  이슈: ["🚨실사오차(+9)"],
  _masterLink: {
    productType: "원물",
    masterCode: "RAW",
    subCode: "SALE",
    conversionRate: 1,
  },
});
const salesTarget = makeRow({
  batchKey: "SALE_LOT",
  코드: "SALE",
  품명: "판매 전표 상품",
  출고: 2,
  전산잔량: -2,
  실사: -2,
  로스: 0,
  이슈: ["🚨수량부족(2)"],
  출고내역: {
    거래처A: { qty: 2, rev: 200, cogs: 0, displayVendor: "거래처A" },
  },
  _masterLink: {
    productType: "소분",
    masterCode: "SALE",
    rawCode: "RAW",
    conversionRate: 1,
  },
});

const representative = createRuntime().run(
  [actualSource, salesTarget],
  actualSource.batchKey,
  salesTarget.batchKey,
);
const sourceAfter = representative.rows.find(
  (row) => row.batchKey === actualSource.batchKey,
);
const targetAfter = representative.rows.find(
  (row) => row.batchKey === salesTarget.batchKey,
);

assert.ok(sourceAfter, "Missing actual-source row after manual substitution");
assert.ok(targetAfter, "Missing sales-target row after manual substitution");
assert.ok(
  sourceAfter.이슈.includes("🔄수기치환오차(-9)"),
  "actual source error +9 must produce source manual-substitution quantity -9",
);
assert.ok(
  targetAfter.이슈.includes("🔄수기치환오차(+9)"),
  "actual error +9 must win over unrelated Lot outbound quantity 2",
);
assert.equal(representative.history.length, 1);
assert.equal(representative.history[0].sQty, 9);
assert.equal(representative.history[0].tQty, 9);
assert.deepEqual(representative.alerts, []);

const decimalSource = makeRow({
  ...actualSource,
  batchKey: "RAW_DECIMAL",
  코드: "RAW_DECIMAL",
  실사: -1.25,
  로스: -1.25,
  이슈: ["🚨실사오차(-1.25)"],
  _masterLink: {
    productType: "원물",
    masterCode: "RAW_DECIMAL",
    subCode: "SALE_DECIMAL",
    conversionRate: 2,
  },
});
const decimalTarget = makeRow({
  ...salesTarget,
  batchKey: "SALE_DECIMAL",
  코드: "SALE_DECIMAL",
  출고: 2,
  전산잔량: -2,
  실사: -2,
  로스: 0,
  이슈: ["🚨수량부족(2)"],
  _masterLink: {
    productType: "소분",
    masterCode: "SALE_DECIMAL",
    rawCode: "RAW_DECIMAL",
    conversionRate: 2,
  },
});
const decimalResult = createRuntime().run(
  [decimalSource, decimalTarget],
  decimalSource.batchKey,
  decimalTarget.batchKey,
);
assert.ok(
  decimalResult.rows
    .find((row) => row.batchKey === decimalSource.batchKey)
    .이슈.includes("🔄수기치환오차(-1.25)"),
  "source role sign and decimal actual error must be preserved",
);
assert.ok(
  decimalResult.rows
    .find((row) => row.batchKey === decimalTarget.batchKey)
    .이슈.includes("🔄수기치환오차(+2.5)"),
  "confirmed 1:2 conversion must derive decimal target quantity from actual error",
);
assert.equal(decimalResult.history[0].sQty, 1.25);
assert.equal(decimalResult.history[0].tQty, 2.5);

const reverseSource = makeRow({
  ...actualSource,
  batchKey: "SUB_REVERSE",
  코드: "SUB_REVERSE",
  품명: "원가 출처 소분상품",
  실사: 4,
  로스: 4,
  _masterLink: {
    productType: "소분",
    masterCode: "SUB_REVERSE",
    rawCode: "RAW_REVERSE",
    conversionRate: 2,
  },
});
const reverseTarget = makeRow({
  ...salesTarget,
  batchKey: "RAW_REVERSE",
  코드: "RAW_REVERSE",
  품명: "판매 전표 원물상품",
  출고: 1,
  전산잔량: -1,
  실사: -1,
  로스: 0,
  _masterLink: {
    productType: "원물",
    masterCode: "RAW_REVERSE",
    subCode: "SUB_REVERSE",
    conversionRate: 2,
  },
});
const reverseResult = createRuntime().run(
  [reverseSource, reverseTarget],
  reverseSource.batchKey,
  reverseTarget.batchKey,
);
assert.equal(reverseResult.history[0].sQty, 4);
assert.equal(
  reverseResult.history[0].tQty,
  2,
  "confirmed raw-to-sub rate must be inverted when operational source/target roles are reversed",
);

const bothActualSource = makeRow({
  ...decimalSource,
  batchKey: "RAW_BOTH_ACTUAL",
  코드: "RAW_BOTH_ACTUAL",
  실사: 3,
  로스: 3,
  _masterLink: {
    productType: "원물",
    masterCode: "RAW_BOTH_ACTUAL",
    subCode: "SALE_BOTH_ACTUAL",
    conversionRate: 2,
  },
});
const bothActualTarget = makeRow({
  ...decimalTarget,
  batchKey: "SALE_BOTH_ACTUAL",
  코드: "SALE_BOTH_ACTUAL",
  출고: 2,
  전산잔량: -2,
  실사: 4,
  로스: 6,
  _masterLink: {
    productType: "소분",
    masterCode: "SALE_BOTH_ACTUAL",
    rawCode: "RAW_BOTH_ACTUAL",
    conversionRate: 2,
  },
});
const bothActualResult = createRuntime().run(
  [bothActualSource, bothActualTarget],
  bothActualSource.batchKey,
  bothActualTarget.batchKey,
);
assert.equal(bothActualResult.history[0].sQty, 3);
assert.equal(
  bothActualResult.history[0].tQty,
  6,
  "matching actual errors on both sides must override unrelated outbound quantity",
);

const targetOnlySource = makeRow({
  ...actualSource,
  batchKey: "RAW_TARGET_ONLY",
  코드: "RAW_TARGET_ONLY",
  실사: 0,
  로스: 0,
  _masterLink: {
    productType: "원물",
    masterCode: "RAW_TARGET_ONLY",
    subCode: "SALE_TARGET_ONLY",
    conversionRate: 2,
  },
});
const targetOnlyTarget = makeRow({
  ...salesTarget,
  batchKey: "SALE_TARGET_ONLY",
  코드: "SALE_TARGET_ONLY",
  출고: 2,
  전산잔량: -2,
  실사: 3,
  로스: 5,
  _masterLink: {
    productType: "소분",
    masterCode: "SALE_TARGET_ONLY",
    rawCode: "RAW_TARGET_ONLY",
    conversionRate: 2,
  },
});
const targetOnlyResult = createRuntime().run(
  [targetOnlySource, targetOnlyTarget],
  targetOnlySource.batchKey,
  targetOnlyTarget.batchKey,
);
assert.equal(targetOnlyResult.history[0].sQty, 2.5);
assert.equal(targetOnlyResult.history[0].tQty, 5);

const mismatchedSource = makeRow({
  ...actualSource,
  batchKey: "RAW_MISMATCH",
  코드: "RAW_MISMATCH",
  실사: 4,
  로스: 4,
  _masterLink: {
    productType: "원물",
    masterCode: "RAW_MISMATCH",
    subCode: "SALE_MISMATCH",
    conversionRate: 2,
  },
});
const mismatchedTarget = makeRow({
  ...salesTarget,
  batchKey: "SALE_MISMATCH",
  코드: "SALE_MISMATCH",
  전산잔량: -2,
  실사: 5,
  로스: 7,
  _masterLink: {
    productType: "소분",
    masterCode: "SALE_MISMATCH",
    rawCode: "RAW_MISMATCH",
    conversionRate: 2,
  },
});
const mismatchResult = createRuntime().run(
  [mismatchedSource, mismatchedTarget],
  mismatchedSource.batchKey,
  mismatchedTarget.batchKey,
);
assert.equal(mismatchResult.history.length, 0);
assert.equal(
  mismatchResult.rows.some((row) => row._manualSubstitutionResolved === true),
  false,
  "actual errors that disagree with the confirmed conversion must stay unresolved",
);
assert.equal(
  mismatchResult.rows.every((row) => row.수기확인완료 === false),
  true,
  "conversion mismatch must preserve administrator-confirmation state",
);
assert.match(
  mismatchResult.alerts.join("\n"),
  /관리자 확인/,
  "conversion mismatch must remain in administrator-confirmation state",
);

const noActualSource = makeRow({
  ...actualSource,
  batchKey: "RAW_NO_ACTUAL",
  코드: "RAW_NO_ACTUAL",
  실사: 0,
  로스: 0,
  _masterLink: {
    productType: "원물",
    masterCode: "RAW_NO_ACTUAL",
    subCode: "SALE_NO_ACTUAL",
    conversionRate: 1,
  },
});
const noActualTarget = makeRow({
  ...salesTarget,
  batchKey: "SALE_NO_ACTUAL",
  코드: "SALE_NO_ACTUAL",
  출고: 2,
  전산잔량: -2,
  실사: -2,
  로스: 0,
  _masterLink: {
    productType: "소분",
    masterCode: "SALE_NO_ACTUAL",
    rawCode: "RAW_NO_ACTUAL",
    conversionRate: 1,
  },
});
const noActualResult = createRuntime().run(
  [noActualSource, noActualTarget],
  noActualSource.batchKey,
  noActualTarget.batchKey,
);
assert.equal(noActualResult.history.length, 0);
assert.equal(
  noActualResult.rows.some((row) => row._manualSubstitutionResolved === true),
  false,
  "Lot outbound and targetNeedQty must not replace a missing actual error",
);
assert.match(noActualResult.alerts.join("\n"), /관리자 확인/);

const unconfirmedSource = makeRow({
  ...actualSource,
  batchKey: "RAW_UNCONFIRMED",
  코드: "RAW_UNCONFIRMED",
  실사: 3,
  로스: 3,
  _masterLink: {},
});
const unconfirmedTarget = makeRow({
  ...salesTarget,
  batchKey: "SALE_UNCONFIRMED",
  코드: "SALE_UNCONFIRMED",
  출고: 3,
  전산잔량: -3,
  실사: -3,
  로스: 0,
  _masterLink: {},
});
const unconfirmedResult = createRuntime().run(
  [unconfirmedSource, unconfirmedTarget],
  unconfirmedSource.batchKey,
  unconfirmedTarget.batchKey,
);
assert.equal(unconfirmedResult.history.length, 0);
assert.equal(
  unconfirmedResult.rows.some((row) => row._manualSubstitutionResolved === true),
  false,
  "equal units or quantities alone must not invent a conversion relationship",
);
assert.match(unconfirmedResult.alerts.join("\n"), /관리자 확인/);

console.log("DataOps manual substitution actual-error contract passed.");
