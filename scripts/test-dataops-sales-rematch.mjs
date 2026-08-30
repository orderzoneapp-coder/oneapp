#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.indexOf("</script>", scriptStart);
new vm.Script(source.slice(scriptStart + marker.length, scriptEnd), { filename: "DataOps.inline.js" });

const moduleStart = source.indexOf("const DATAOPS_VENDOR_CHIP_MODULE =");
const moduleEnd = source.indexOf("const DATAOPS_F9_PREFLIGHT_MODULE =", moduleStart);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "current sales evidence/vendor-chip module must exist");
const context = vm.createContext({
  JSON,
  Object,
  Array,
  Map,
  Set,
  Math,
  safeNum: value => Number.isFinite(Number(value)) ? Number(value) : 0,
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  parseNumber: value => Number(String(value ?? "").replace(/,/g, "")) || 0,
  formatQty: value => String(value),
});
vm.runInContext(`${source.slice(moduleStart, moduleEnd)}\nglobalThis.vendorChip = DATAOPS_VENDOR_CHIP_MODULE;`, context);
const chips = context.vendorChip;

const sourceDetails = {
  거래처1: { qty: 3, rev: 300, cogs: 180, displayVendor: "거래처1", _sourceAllocations: [{ sourceId: "S1", qty: 3 }] },
  거래처1_perfect: { qty: 2, rev: 220, cogs: 120, displayVendor: "거래처1", _sourceAllocations: [{ sourceId: "S2", qty: 2 }] },
};
const sourceDetailsBefore = JSON.stringify(sourceDetails);
const aggregated = chips.aggregateDetails(sourceDetails);
assert.equal(aggregated.거래처1.qty, 5);
assert.equal(aggregated.거래처1.rev, 520);
assert.equal(aggregated.거래처1.cogs, 300);
assert.deepEqual(Array.from(aggregated.거래처1._sourceAllocations, allocation => allocation.sourceId), ["S1", "S2"]);
assert.equal(JSON.stringify(sourceDetails), sourceDetailsBefore, "aggregation must not mutate source sales evidence");

const inventoryRow = {
  batchKey: "ROW-1",
  코드: "A100",
  품명: "상품",
  기초: 10,
  입고: 0,
  출고: 5,
  대체입고: 0,
  대체출고: 0,
  실사: 5,
  전산잔량: 5,
  로스: 0,
  매출액: 520,
  매출원가: 300,
  출고내역: sourceDetails,
  메모: "",
};
const partiallyCancelled = chips.cancelVendorChip(inventoryRow, "거래처1", 2);
assert.equal(partiallyCancelled.출고, 2);
assert.equal(partiallyCancelled.출고내역.거래처1.qty, 2);
assert.equal(partiallyCancelled.매출액, 208);
assert.equal(partiallyCancelled.매출원가, 120);
assert.equal(inventoryRow.출고, 5, "administrator correction must produce a new row and preserve the prior snapshot");

const evidence = chips.buildSalesSourceEvidence({
  sale: { _raw: { 판매단가: "1,200", 공급가액: "6,000" }, _sourceFileName: "판매.xlsx", _sourceSheet: "판매", _sourceRowNumber: 7, 매입처매칭: "공급사" },
  sourceId: "S1", code: "A100", name: "상품", vendor: "거래처1", qty: 5, calculatedAmount: 6000,
});
assert.equal(evidence.unitPrice, 1200);
assert.equal(evidence.amount, 6000);
assert.equal(evidence.fileName, "판매.xlsx");
assert.equal(evidence.rowNumber, 7);

const integrityErrors = chips.buildIntegrityErrors({ productData: [{
  ...inventoryRow,
  _salesSourceEvidence: [{ sourceId: "S1", vendor: "거래처1", qty: 5, amount: 500 }],
  출고내역: { 거래처1: { qty: 4, rev: 400, cogs: 240, displayVendor: "거래처1" } },
}] });
assert.equal(integrityErrors.length, 1);
assert.equal(integrityErrors[0].type, "VENDOR_CHIP_MISMATCH");
assert.equal(integrityErrors[0].differenceQty, 1);

const moveStart = source.indexOf("const handleSalesMove = useCallback");
const moveEnd = source.indexOf("return {", moveStart);
const moveSource = source.slice(moveStart, moveEnd);
assert.match(moveSource, /sourceKey/);
assert.match(moveSource, /targetKey/);
assert.match(moveSource, /sourceItemPrev/);
assert.match(moveSource, /targetItemPrev/);
assert.match(moveSource, /_costLayers/);
assert.doesNotMatch(source, /const DATAOPS_SALES_REMATCH_MODULE/, "removed automatic rematch policy must not be revived over PR #442 administrator-directed moves");

console.log("PASS test-dataops-sales-rematch");
