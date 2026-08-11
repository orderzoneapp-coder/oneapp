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
new vm.Script(mainScriptSource, { filename: "DataOps.inline.js" });

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const safeStr = (value, fallback = "") => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim() || fallback;
};
const identitySource = section(
  "const DATAOPS_PRODUCT_IDENTITY_MODULE",
  "const UTIL_MODULE",
);
const identityContext = { safeStr, window: {} };
vm.createContext(identityContext);
new vm.Script(
  `${identitySource}
globalThis.productIdentity = DATAOPS_PRODUCT_IDENTITY_MODULE;`,
  { filename: "DataOps.product-identity.js" },
).runInContext(identityContext);
const identity = identityContext.productIdentity;

const code = "101020116";
assert.equal(
  identity.buildSalesAggregationKey({
    code,
    name: "대파_서울_10단",
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
  identity.buildSalesAggregationKey({
    code,
    name: "대파_서울(10단)",
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
);
assert.notEqual(
  identity.buildSalesAggregationKey({
    code: "NO_CODE",
    name: "대파_서울_10단",
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
  identity.buildSalesAggregationKey({
    code: "",
    name: "대파_서울(10단)",
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
);

assert.equal(
  identity.resolveRepresentativeName({
    code,
    masterName: "마스터명",
    baseName: "기초명",
    purchaseName: "구매명",
    salesName: "판매명",
  }),
  "마스터명",
);
assert.equal(
  identity.resolveRepresentativeName({
    code,
    baseName: "기초명",
    purchaseName: "구매명",
    salesName: "판매명",
  }),
  "기초명",
);
assert.equal(
  identity.resolveRepresentativeName({
    code,
    purchaseName: "구매명",
    salesName: "판매명",
  }),
  "구매명",
);
assert.equal(
  identity.resolveRepresentativeName({ code, salesName: "판매명" }),
  "판매명",
);

const lotKey = (overrides = {}) =>
  identity.buildBatchKey({
    code,
    name: "대파_서울_10단",
    price: 10000,
    vendor: "구매처A",
    date: "2026-07-27",
    manageMode: "LOT_DETAIL",
    ...overrides,
  });
assert.equal(lotKey(), lotKey({ name: "대파_서울(10단)" }));
assert.notEqual(lotKey(), lotKey({ vendor: "구매처B" }));
assert.notEqual(lotKey(), lotKey({ price: 11000 }));
assert.notEqual(lotKey(), lotKey({ date: "2026-07-28" }));

const variantMemo = identity.buildNameVariantMemo({
  representativeName: "마스터명",
  aliases: ["기초명", "구매명", "판매명"],
});
const dedupedMemo = identity.mergeNameVariantMemo({
  memo: `수기메모 / ${variantMemo}`,
  variantMemo,
});
assert.equal((dedupedMemo.match(/품명표기통합:/g) || []).length, 1);
assert.equal(
  identity.mergeNameVariantMemo({
    memo: dedupedMemo,
    variantMemo: "",
  }),
  dedupedMemo,
);
const upgradedLegacyMemo = identity.mergeNameVariantMemo({
  memo: "수기메모 / 품명표기통합: 이전별칭 / 대표=이전대표 / 후속메모",
  variantMemo,
});
assert.equal((upgradedLegacyMemo.match(/품명표기통합:/g) || []).length, 1);
assert.match(upgradedLegacyMemo, /수기메모/);
assert.match(upgradedLegacyMemo, /후속메모/);

const inventoryEngineMarker = "const useInventoryEngine =";
const inventoryEngineStart = mainScriptSource.indexOf(inventoryEngineMarker);
const inventoryEngineEnd = mainScriptSource.indexOf(
  "const IssueChip = React.memo",
  inventoryEngineStart,
);
assert.notEqual(
  inventoryEngineStart,
  -1,
  "Missing useInventoryEngine runtime source",
);
assert.ok(
  inventoryEngineEnd > inventoryEngineStart,
  "Missing useInventoryEngine runtime end marker",
);

function createRuntime({ master = {}, grouping = {} } = {}) {
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
  if (Object.keys(master).length > 0) {
    storageValues.set(
      "dataops_merch_master_cache_v1",
      JSON.stringify(master),
    );
    storageValues.set("dataops_master_sync_trigger", "fixture-1");
  }
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

  const runtimeAlerts = [];
  const inventoryEngine = runtimeContext.actualUseInventoryEngine({
    mappings: {},
    grouping,
    setAlertMsg: (message) => runtimeAlerts.push(message),
    setConfirmModal: () => {},
    setIsProcessing: () => {},
    setAppStep: () => {},
  });
  return {
    execute(payload) {
      const result = inventoryEngine.executeAnalysis({
        parsedPrev: [],
        parsedIn: [],
        parsedOut: [],
        parsedEnd: [],
        periodStr: "2026-07-31",
        targetDateStrFromData: "2026-07-31",
        endFileProvided: false,
        ...payload,
      });
      assert.equal(
        result,
        true,
        `actual executeAnalysis failed: ${runtimeAlerts.join(" | ")}`,
      );
      return hookState[0] || [];
    },
  };
}

const sale = ({
  code: productCode = code,
  name,
  vendor,
  purchaseVendor = "미지정",
  purchaseCost = 0,
  qty = 1,
} = {}) => ({
  코드: productCode,
  품명: name,
  거래처: vendor,
  매입처매칭: purchaseVendor,
  단가: 1000,
  수량: qty,
  _salesPurchaseUnitCost: purchaseCost,
  _salesConfirmedPurchaseVendor:
    purchaseVendor === "미지정" ? "" : purchaseVendor,
  _raw: { 거래처명: vendor },
});

const sameCodeRows = createRuntime().execute({
  parsedOut: [
    sale({ name: "대파_서울_10단", vendor: "로라식스" }),
    sale({ name: "대파_서울(10단)", vendor: "푸드박스정원" }),
  ],
  parsedEnd: [{ 코드: code, 품명: "대파 실사", 수량: 0, _raw: {} }],
  endFileProvided: true,
});
assert.equal(sameCodeRows.length, 1);
const mergedRow = sameCodeRows[0];
assert.equal(mergedRow.출고, 2);
assert.equal(mergedRow.전산잔량, -2);
assert.equal(mergedRow.실사, 0);
assert.equal(mergedRow.로스, 2);
assert.equal(Object.keys(mergedRow.출고내역).length, 2);
assert.deepEqual(
  Array.from(
    Object.values(mergedRow.출고내역),
    (detail) => [detail.displayVendor, detail.qty],
  ),
  [
    ["로라식스", 1],
    ["푸드박스정원", 1],
  ],
);
assert.equal(
  (mergedRow.메모.match(/품명표기통합:/g) || []).length,
  1,
);
assert.match(mergedRow.메모, /대파_서울\(10단\)/);

const noCodeRows = createRuntime().execute({
  parsedOut: [
    sale({
      code: "",
      name: "코드없는 대파 A",
      vendor: "판매처A",
    }),
    sale({
      code: "NO_CODE",
      name: "코드없는 대파 B",
      vendor: "판매처B",
    }),
  ],
});
assert.equal(noCodeRows.length, 2);
assert.deepEqual(
  Array.from(noCodeRows, (row) => row.품명).sort(),
  ["코드없는 대파 A", "코드없는 대파 B"],
);

const assertAllNames = (rows, expectedName, label) => {
  assert.ok(rows.length > 0, `${label}: expected at least one row`);
  assert.ok(
    rows.every((row) => row.품명 === expectedName),
    `${label}: expected representative name ${expectedName}`,
  );
};
const baseItem = (name) => ({
  코드: "P-BASE",
  품명: name,
  거래처: "기초처",
  단가: 100,
  수량: 2,
  일자: "2026-07-26",
  _raw: {},
});
const purchaseItem = (productCode, name, overrides = {}) => ({
  코드: productCode,
  품명: name,
  거래처: "구매처",
  단가: 100,
  수량: 2,
  일자: "2026-07-27",
  _raw: { 거래처명: "구매처" },
  ...overrides,
});

assertAllNames(
  createRuntime({
    master: {
      "P-MASTER": {
        코드: "P-MASTER",
        품목명: "마스터대표명",
        규격: "",
        단위: "BOX",
      },
    },
  }).execute({
    parsedPrev: [
      { ...baseItem("기초명"), 코드: "P-MASTER" },
    ],
    parsedIn: [purchaseItem("P-MASTER", "구매명")],
    parsedOut: [
      sale({
        code: "P-MASTER",
        name: "판매명",
        vendor: "판매처",
      }),
    ],
  }),
  "마스터대표명",
  "master priority",
);
assertAllNames(
  createRuntime().execute({
    parsedPrev: [baseItem("기초대표명")],
    parsedIn: [purchaseItem("P-BASE", "구매명")],
    parsedOut: [
      sale({
        code: "P-BASE",
        name: "판매명",
        vendor: "판매처",
      }),
    ],
  }),
  "기초대표명",
  "base priority",
);
assertAllNames(
  createRuntime().execute({
    parsedEnd: [
      {
        코드: "P-CLOSING",
        품명: "마감대표명",
        수량: 2,
        단가: 100,
        거래처: "마감구매처",
        _fileType: "CLOSING_RESTORE",
        _raw: {
          잔량: 2,
          구매가: 100,
          품명: "마감대표명",
          구매처: "마감구매처",
        },
      },
    ],
    parsedIn: [purchaseItem("P-CLOSING", "구매명")],
  }),
  "마감대표명",
  "closing priority",
);
assertAllNames(
  createRuntime().execute({
    parsedIn: [purchaseItem("P-PURCHASE", "구매대표명")],
    parsedOut: [
      sale({
        code: "P-PURCHASE",
        name: "판매명",
        vendor: "판매처",
      }),
    ],
  }),
  "구매대표명",
  "purchase priority",
);
assertAllNames(
  createRuntime().execute({
    parsedOut: [
      sale({
        code: "P-SALES",
        name: "판매최초명",
        vendor: "판매처A",
      }),
      sale({
        code: "P-SALES",
        name: "판매후속명",
        vendor: "판매처B",
      }),
    ],
  }),
  "판매최초명",
  "sales priority",
);

const lotRows = createRuntime({
  grouping: { manageMode: "LOT_DETAIL" },
}).execute({
  parsedIn: [
    purchaseItem("P-LOT", "구매대표명", {
      거래처: "구매처A",
      단가: 10000,
      일자: "2026-07-27",
    }),
    purchaseItem("P-LOT", "구매표기B", {
      거래처: "구매처B",
      단가: 10000,
      일자: "2026-07-27",
    }),
    purchaseItem("P-LOT", "구매표기C", {
      거래처: "구매처B",
      단가: 11000,
      일자: "2026-07-27",
    }),
    purchaseItem("P-LOT", "구매표기D", {
      거래처: "구매처B",
      단가: 11000,
      일자: "2026-07-28",
    }),
  ],
});
assert.deepEqual(
  Array.from(lotRows, (row) => row.batchKey).sort(),
  [
    "P-LOT|10000|구매처A|2026-07-27",
    "P-LOT|10000|구매처B|2026-07-27",
    "P-LOT|11000|구매처B|2026-07-27",
    "P-LOT|11000|구매처B|2026-07-28",
  ],
);
assert.ok(lotRows.every((row) => row.품명 === "구매대표명"));
assert.ok(
  lotRows.every(
    (row) => (row.메모.match(/품명표기통합:/g) || []).length === 1,
  ),
);

const executeAnalysis = section(
  "const executeAnalysis = useCallback",
  "const runAnalysis = useCallback",
);
assert.match(executeAnalysis, /registerProductNames\(closingEndItems,\s*'baseName'\)/);
assert.match(executeAnalysis, /registerProductNames\(prevItems,\s*'baseName'\)/);
assert.match(executeAnalysis, /registerProductNames\(inItems,\s*'purchaseName'\)/);
assert.match(executeAnalysis, /registerProductNames\(outItems,\s*'salesName'\)/);
assert.match(executeAnalysis, /masterInfo\.matchType === 'CODE'/);
assert.match(executeAnalysis, /buildSalesAggregationKey/);
assert.doesNotMatch(
  executeAnalysis,
  /const aggKey = `\$\{code\}\|\$\{sale\.품명\}\|/,
);
assert.match(executeAnalysis, /const pool = stockPool\[code\]/);
assert.match(
  executeAnalysis,
  /Object\.values\(pData\)\.forEach\(applyRepresentativeProductName\)/,
);
const expectedDisplayVersion =
  "V1.a22.110_WorkSaveCloudInventorySync · 2026-08-08 KST";
assert.equal(
  source.split(expectedDisplayVersion).length - 1,
  3,
  "dated V110 version must appear at title, loader, and header",
);
assert.match(source, /version:\s*'V1\.a22\.110_WorkSaveCloudInventorySync'/);

console.log(
  "DataOps actual executeAnalysis code-primary product-name merge contract passed.",
);
