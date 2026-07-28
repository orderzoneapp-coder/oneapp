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

const safeNum = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const safeStr = (value, fallback = "") => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim() || fallback;
};
const policySource = section(
  "const DATAOPS_SALES_POLICY_MODULE",
  "const UTIL_MODULE",
);
const policyContext = { safeNum, safeStr, window: {} };
vm.createContext(policyContext);
new vm.Script(
  `${policySource}\nglobalThis.salesPolicy = DATAOPS_SALES_POLICY_MODULE;`,
  { filename: "DataOps.sales-policy.js" },
).runInContext(policyContext);
const policy = policyContext.salesPolicy;

function applyPlan(buckets, qty) {
  const plan = policy.buildSameCodeAllocationPlan({ buckets, qty });
  for (const allocation of plan.allocations) {
    allocation.bucket.수량 -= allocation.qty;
    allocation.bucket.출고 = safeNum(allocation.bucket.출고) + allocation.qty;
  }
  return plan;
}

{
  const buckets = [{ batchKey: "A", 코드: "1001", 수량: 2, 출고: 0 }];
  const plan = applyPlan(buckets, 3);
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.allocations[0].qty, 3);
  assert.equal(plan.allocations[0].overdrawQty, 1);
  assert.equal(buckets[0].출고, 3);
  assert.equal(buckets[0].수량, -1);
}

{
  const buckets = [
    { batchKey: "OLD", 코드: "2001", 수량: 2, 출고: 0 },
    { batchKey: "NEW", 코드: "2001", 수량: 14, 출고: 0 },
  ];
  const plan = applyPlan(buckets, 15);
  assert.deepEqual(
    Array.from(plan.allocations, (allocation) => allocation.qty),
    [2, 13],
  );
  assert.deepEqual(
    Array.from(buckets, (bucket) => bucket.수량),
    [0, 1],
  );
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.출고, 0),
    15,
  );
}

{
  const details = [
    { vendor: "판매처A", qty: 1, rev: 100, remainingQty: 1, remainingRev: 100 },
    { vendor: "판매처B", qty: 4, rev: 400, remainingQty: 4, remainingRev: 400 },
  ];
  const firstLot = policy.consumeVendorDetails(details, 2);
  const secondLot = policy.consumeVendorDetails(details, 3);
  const allocations = [...firstLot.allocations, ...secondLot.allocations];
  assert.deepEqual(
    Array.from(allocations, (row) => row.qty),
    [1, 1, 3],
  );
  assert.ok(allocations.every((row) => Number.isInteger(row.qty)));
  assert.equal(
    allocations.reduce((sum, row) => sum + row.qty, 0),
    5,
  );
  assert.equal(
    details.reduce((sum, row) => sum + row.remainingQty, 0),
    0,
  );
}

{
  const buckets = [{ batchKey: "RETURN", 코드: "3001", 수량: 0, 출고: 0 }];
  applyPlan(buckets, -2);
  assert.equal(buckets[0].출고, -2);
  assert.equal(buckets[0].수량, 2);
}

const executeAnalysis = section(
  "const executeAnalysis = useCallback",
  "const runAnalysis = useCallback",
);
assert.match(executeAnalysis, /const code = String\(sale\.코드 \|\| 'NO_CODE'\)/);
assert.match(executeAnalysis, /const pool = stockPool\[code\]/);
assert.match(executeAnalysis, /DATAOPS_PRODUCT_IDENTITY_MODULE\.buildSalesAggregationKey/);
assert.doesNotMatch(executeAnalysis, /const aggKey = `\$\{code\}\|\$\{sale\.품명\}\|/);
assert.match(executeAnalysis, /getStockLotIndexKey\(code,/);
assert.match(executeAnalysis, /FIFO_SHORTAGE_SAME_CODE/);
assert.match(executeAnalysis, /구매처단가확인/);
assert.doesNotMatch(
  executeAnalysis,
  /recordUnallocatedLot|UNALLOCATED_LOT|detailShare/,
);

const exactMatch = section(
  "const applySalesConfirmedPurchase =",
  "if (hasSalesConfirmedPurchase) {",
);
assert.match(exactMatch, /findConfirmedPurchaseBuckets/);
assert.match(exactMatch, /buildSameCodeAllocationPlan/);
assert.match(exactMatch, /consumeVendorDetails/);

const stockCountRows = section(
  "buildStockCountSheetRows:",
  "buildSalesDetailRows:",
);
assert.match(stockCountRows, /addOneDay\(extractDateNum\(targetDateStr\)\)/);
assert.match(stockCountRows, /safeNum\(aggregated\[key\]\.수량\) === 0/);

assert.doesNotMatch(source, /handleToggleAdminComplete|onToggleAdminComplete/);
assert.match(source, /'관리자확인완료':\s*''/);
assert.match(source, /'관리자확인시각':\s*''/);

console.log("DataOps sales/Lot policy regression contract passed.");
