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

const safeStr = (value, fallback = "") => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim() || fallback;
};
const moduleSource = section(
  "const DATAOPS_PRODUCT_IDENTITY_MODULE",
  "const UTIL_MODULE",
);
const context = { safeStr, window: {} };
vm.createContext(context);
new vm.Script(
  `${moduleSource}\nglobalThis.productIdentity = DATAOPS_PRODUCT_IDENTITY_MODULE;`,
  { filename: "DataOps.product-identity.js" },
).runInContext(context);
const identity = context.productIdentity;

const code = "101020116";
const parsedSales = [
  { code, name: "대파_서울_10단", vendor: "로라식스", qty: 1 },
  { code, name: "대파_서울(10단)", vendor: "푸드박스정원", qty: 1 },
];
const aggregationKeys = parsedSales.map((row) =>
  identity.buildSalesAggregationKey({
    code: row.code,
    name: row.name,
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
);
assert.deepEqual(Array.from(new Set(aggregationKeys)), [
  "101020116|미지정|NO_COST",
]);

const aggregation = new Map();
for (const row of parsedSales) {
  const key = identity.buildSalesAggregationKey({
    code: row.code,
    name: row.name,
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  });
  if (!aggregation.has(key)) {
    aggregation.set(key, {
      code: row.code,
      qty: 0,
      chips: new Map(),
    });
  }
  const group = aggregation.get(key);
  group.qty += row.qty;
  group.chips.set(row.vendor, (group.chips.get(row.vendor) || 0) + row.qty);
}

assert.equal(aggregation.size, 1);
const mergedSale = aggregation.values().next().value;
assert.equal(mergedSale.qty, 2);
assert.deepEqual(Array.from(mergedSale.chips.entries()), [
  ["로라식스", 1],
  ["푸드박스정원", 1],
]);
const calculatedBalance = 0 + 0 - mergedSale.qty;
assert.equal(calculatedBalance, -2);
assert.equal(0 - calculatedBalance, 2);

assert.notEqual(
  identity.buildSalesAggregationKey({
    code: "NO_CODE",
    name: "대파_서울_10단",
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
  identity.buildSalesAggregationKey({
    code: "NO_CODE",
    name: "대파_서울(10단)",
    purchaseVendor: "미지정",
    costKey: "NO_COST",
  }),
);

assert.equal(
  identity.resolveRepresentativeName({
    code,
    masterName: "대파_서울_10단_BOX",
    baseName: "대파 서울 10단",
    purchaseName: "대파_서울(10단)",
    salesName: "대파_서울_10단",
  }),
  "대파_서울_10단_BOX",
);
assert.equal(
  identity.resolveRepresentativeName({
    code,
    baseName: "대파 서울 10단",
    purchaseName: "대파_서울(10단)",
    salesName: "대파_서울_10단",
  }),
  "대파 서울 10단",
);
assert.equal(
  identity.resolveRepresentativeName({
    code,
    purchaseName: "대파_서울(10단)",
    salesName: "대파_서울_10단",
  }),
  "대파_서울(10단)",
);

const lotA = identity.buildBatchKey({
  code,
  name: "대파_서울_10단",
  price: 10000,
  vendor: "구매처A",
  date: "2026-07-27",
  manageMode: "LOT_DETAIL",
});
const sameLotDifferentName = identity.buildBatchKey({
  code,
  name: "대파_서울(10단)",
  price: 10000,
  vendor: "구매처A",
  date: "2026-07-27",
  manageMode: "LOT_DETAIL",
});
const lotB = identity.buildBatchKey({
  code,
  name: "대파_서울(10단)",
  price: 11000,
  vendor: "구매처B",
  date: "2026-07-28",
  manageMode: "LOT_DETAIL",
});
assert.equal(lotA, sameLotDifferentName);
assert.notEqual(lotA, lotB);
assert.equal(lotA, "101020116|10000|구매처A|2026-07-27");
assert.equal(lotB, "101020116|11000|구매처B|2026-07-28");

const missingPurchaseBatch = identity.buildBatchKey({
  code,
  name: "대파_서울_10단",
  price: 0,
  vendor: "로라식스",
  date: "",
  manageMode: "LOT_DETAIL",
});
assert.equal(missingPurchaseBatch, "101020116|0|로라식스|");

const aliasMemo = identity.buildNameVariantMemo({
  representativeName: "대파_서울_10단_BOX",
  aliases: ["대파_서울_10단", "대파_서울(10단)"],
});
assert.match(aliasMemo, /대파_서울_10단/);
assert.match(aliasMemo, /대파_서울\(10단\)/);
assert.match(aliasMemo, /대표=대파_서울_10단_BOX/);

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
assert.doesNotMatch(executeAnalysis, /const aggKey = `\$\{code\}\|\$\{sale\.품명\}\|/);
assert.match(executeAnalysis, /const pool = stockPool\[code\]/);
assert.match(executeAnalysis, /Object\.values\(pData\)\.forEach\(applyRepresentativeProductName\)/);

const groupTrace = {
  parsed: parsedSales.map((row) => `${row.code}|${row.name}`),
  aggregatedSales: Array.from(new Set(aggregationKeys)),
  stockPool: "stockPool[101020116]=없음",
  missingPurchaseRow: missingPurchaseBatch,
  finalProductData: [
    {
      code,
      rowCount: aggregation.size,
      outQty: mergedSale.qty,
      balance: calculatedBalance,
      chips: Array.from(mergedSale.chips.entries()),
    },
  ],
};
console.log(`DataOps code-primary group trace: ${JSON.stringify(groupTrace)}`);
console.log("DataOps code-primary product-name merge contract passed.");
