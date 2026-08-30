#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const fixture = JSON.parse(fs.readFileSync("scripts/fixtures/dataops-inbound-cost-lot-allocation.json", "utf8"));
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.indexOf("</script>", scriptStart);
new vm.Script(source.slice(scriptStart + marker.length, scriptEnd), { filename: "DataOps.inline.js" });

const moduleStart = source.indexOf("const DATAOPS_OPERATION_MODULE =");
const moduleEnd = source.indexOf("window.DATAOPS_OPERATION_MODULE = DATAOPS_OPERATION_MODULE;", moduleStart);
assert.ok(moduleStart >= 0 && moduleEnd > moduleStart, "current operation/cost module must exist");
const context = vm.createContext({
  Date,
  Math,
  Object,
  Array,
  String,
  Number,
  safeNum: value => Number.isFinite(Number(value)) ? Number(value) : 0,
  safeStr: (value, fallback = "") => value === null || value === undefined || String(value).trim() === "" ? fallback : String(value).trim(),
  formatQty: value => String(value),
  normalizeDataOpsMasterUnit: value => String(value ?? ""),
  DATAOPS_MASTER_LINK_MODULE: {
    buildMasterLedgerInfo: item => item._masterLink || { productType: "", masterUnit: "", masterInPrice: 0 },
  },
  DATAOPS_ISSUE_HELPER: { unique: values => [...new Set(values.filter(Boolean))] },
});
context.window = context;
vm.runInContext(`${source.slice(moduleStart, moduleEnd)}\nglobalThis.operation = DATAOPS_OPERATION_MODULE;`, context);
const operation = context.operation;

assert.deepEqual(
  { ...operation.resolveSplitMoveQuantities({ maxQty: 7 }, 3) },
  { sourceDeductQty: 3, targetQty: 3 },
  "ordinary allocation must preserve entered source and target quantity",
);
assert.deepEqual(
  { ...operation.resolveSplitMoveQuantities({ isCtrlPressed: true, allowOverMax: true, maxQty: 2 }, 5) },
  { sourceDeductQty: 2, targetQty: 5 },
  "explicit conversion may expand only the target while capping source deduction",
);

const baseLayer = operation.buildCostLayer({
  type: operation.TYPES.SUBSTITUTE,
  sourceItem: { 코드: "RAW", 품명: "원가Lot", 일자: "2026-08-01", 거래처: "공급사" },
  targetItem: { 코드: "SALE", 품명: "판매품" },
  vendorName: "거래처",
  sourceQty: 2,
  targetQty: 5,
  unitCost: 1200,
  revenue: 10000,
});
assert.equal(baseLayer.costSourceCode, "RAW");
assert.equal(baseLayer.salesItemCode, "SALE");
assert.equal(baseLayer.costAmount, 6000);
assert.equal(baseLayer.typeLabel, operation.getOperationLabel(operation.TYPES.SUBSTITUTE));

const merged = operation.normalizeCostLayers([
  { ...baseLayer, id: "L1" },
  { ...baseLayer, id: "L2", sourceQty: 1, targetQty: 2, costAmount: 2400, revenueAmount: 4000 },
]);
assert.equal(merged.length, 1, "same source LOT/cost identity must merge without losing provenance fields");
assert.equal(merged[0].sourceQty, 3);
assert.equal(merged[0].targetQty, 7);
assert.equal(merged[0].costAmount, 8400);
assert.equal(merged[0].revenueAmount, 14000);

const appended = operation.appendCostLayer({ 코드: "SALE", _costLayers: [] }, baseLayer);
assert.equal(appended._lotCostResolved, true);
assert.equal(operation.hasLotCostResolved(appended), true);
const labels = operation.buildOperationIssueSummaries([baseLayer], "IN");
assert.equal(labels.length, 1);
assert.match(labels[0], /대체입고/);

const splitLoss = operation.syncSplitLossInsight({
  코드: "SPLIT",
  품명: "소분상품",
  단가: 500,
  로스: -3,
  이슈: [],
  _masterLink: { productType: "소분", masterUnit: "소분", masterInPrice: 0 },
});
assert.equal(splitLoss._splitLossCandidate, true);
assert.equal(splitLoss._splitLossQty, 3);
assert.equal(splitLoss._splitLossUnitCost, 500);
assert.equal(splitLoss._splitLossValue, 1500);

assert.ok(Array.isArray(fixture.internalPurchaseExclusionRegression.classificationCases));
assert.ok(fixture.internalPurchaseExclusionRegression.classificationCases.length > 0, "the operational fixture must retain internal-purchase classification evidence");
assert.match(source, /_purchaseCandidateLots/);
assert.match(source, /_purchaseLotKey/);
assert.match(source, /handlePurchaseLotManualAdjust/);

console.log("PASS test-dataops-inbound-cost-lot-allocation");
