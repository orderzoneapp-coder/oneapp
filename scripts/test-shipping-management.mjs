import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const workbookTools = require(path.join(ROOT, "orderFulfillmentWorkbook.js"));

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
const XLSX_SHA256 = "1c7abf2993ff2cd61e508f9268e9acda0098c9796f3925d2ba0d2579072653e2";

const response = await fetch(XLSX_URL);
assert.equal(response.ok, true, `xlsx-js-style download failed: ${response.status}`);
const xlsxSource = Buffer.from(await response.arrayBuffer());
assert.equal(
  crypto.createHash("sha256").update(xlsxSource).digest("hex"),
  XLSX_SHA256,
  "xlsx-js-style asset hash changed",
);

const context = vm.createContext({
  console,
  Date,
  Map,
  Set,
  Symbol,
  Number,
  Object,
  String,
  Array,
  Math,
  JSON,
  RegExp,
  Error,
  Promise,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
});
context.window = context;
context.self = context;
context.globalThis = context;
context.global = context;
vm.runInContext(xlsxSource.toString("utf8"), context, { filename: "xlsx-js-style.bundle.js" });
const XLSX = context.XLSX;
assert.ok(XLSX?.utils?.sheet_to_json, "xlsx-js-style did not initialize");

const ORDER_HEADERS = [
  "일자-No.",
  "담당",
  "단위",
  "품목코드",
  "품목명",
  "규격",
  "수량",
  "재고",
  "단가",
  "적요",
  "적요1",
  "거래처",
  "그룹",
];
const INVENTORY_HEADERS = [
  "사용",
  "품목코드",
  "단위",
  "품목명",
  "규격",
  "수량",
  "1창고",
  "2전송",
  "3서울",
  "4전송",
  "7진영",
  "기본",
  "전송",
  "창고",
];

function buildOrderMatrix(rows) {
  return [
    ["회사명 : 테스트 / 주문현황"],
    ORDER_HEADERS,
    ...rows.map((row, index) => [
      `07/30-${index + 1}`,
      "담당",
      row.unit || "EA",
      row.code,
      row.name || `상품 ${row.code}`,
      row.spec || row.unit || "EA",
      row.quantity,
      "",
      row.price ?? 1000,
      row.note || "",
      row.note1 || "",
      row.customer || `거래처 ${index + 1}`,
      row.group || "기본그룹",
    ]),
  ];
}

function buildInventoryMatrix(rows) {
  return [
    ["회사명 : 테스트 / 창고별재고"],
    INVENTORY_HEADERS,
    ...rows.map((row) => [
      "Yes",
      row.code,
      row.unit || "EA",
      row.name || `상품 ${row.code}`,
      row.spec || row.unit || "EA",
      "",
      row.whole ?? "",
      "",
      row.seoul ?? "",
      row.transfer ?? "",
      "",
      "",
      "",
      "",
    ]),
  ];
}

function parseOrders(matrix, fileName = "주문현황.xlsx") {
  return engine.parseOrderWorkbook({
    fileName,
    sheetName: "미판매현황",
    rawMatrix: matrix,
    displayMatrix: matrix,
  });
}

function parseInventory(matrix, fileName = "창고별재고.xlsx") {
  return engine.parseInventoryWorkbook({
    fileName,
    sheetName: "재고현황",
    rawMatrix: matrix,
    displayMatrix: matrix,
  });
}

const edgeOrders = parseOrders(
  buildOrderMatrix([
    { code: "000100", quantity: 4, note: "원문 적요" },
    { code: "000100", quantity: 4, note1: "원문 적요1" },
    { code: "000100", quantity: 2 },
    { code: "NO-STOCK", quantity: 3 },
  ]),
);
const edgeInventory = parseInventory(
  buildInventoryMatrix([{ code: "000100", whole: 5, seoul: 4, transfer: -1 }]),
);
const edgeValidation = engine.validateInputs(edgeOrders, edgeInventory);
assert.equal(edgeValidation.canAnalyze, true);
assert.equal(edgeValidation.unmatchedCount, 1);
assert.equal(edgeValidation.memoCount, 2);

const edgeWorkspace = engine.analyze(edgeOrders, edgeInventory, {
  createdAt: "2026-07-30T00:00:00.000Z",
});
assert.equal(edgeWorkspace.schemaVersion, "shipping-workspace/v1");
assert.deepEqual(
  edgeWorkspace.allocations.slice(0, 3).map((row) => [
    row.wholeAllocation,
    row.seoulAllocation,
    row.purchaseNeed,
  ]),
  [
    [4, 0, 0],
    [1, 3, 0],
    [0, 0, 2],
  ],
  "duplicate order lines must consume aggregate pools in input order without reuse",
);
assert.equal(
  edgeWorkspace.inventory[0].seoulFirstPurchaseRemaining,
  3,
  "negative 4전송 must reduce the 서울 first-purchase pool",
);
assert.equal(
  edgeWorkspace.allocations[3].status,
  "재고정보 없음",
  "unmatched codes must remain explicit",
);
assert.equal(
  edgeWorkspace.allocations[3].purchaseNeed,
  null,
  "unmatched codes must not receive a confirmed purchase quantity",
);
assert.ok(
  edgeWorkspace.allocations
    .filter((row) => row.purchaseNeed !== null)
    .every((row) => row.purchaseNeed >= 0),
  "purchase need must never be negative",
);
assert.ok(
  edgeWorkspace.allocations
    .filter((row) => row.inventoryMatched)
    .every((row) => Math.abs(row.reconciliationDifference) <= 1e-9),
  "every matched order line must reconcile",
);
assert.equal(edgeWorkspace.memoIssues.length, 2, "적요 and 적요1 must be collected");
assert.equal(
  edgeWorkspace.purchaseManagement.find((row) => row.productCode === "NO-STOCK")
    .managementStatus,
  "재고 확인 필요",
);

const duplicateInventory = parseInventory(
  buildInventoryMatrix([
    { code: "000100", whole: 1 },
    { code: "000100", whole: 2 },
  ]),
);
const duplicateValidation = engine.validateInputs(edgeOrders, duplicateInventory);
assert.equal(duplicateValidation.canAnalyze, false);
assert.equal(duplicateValidation.duplicateCount, 1);
assert.ok(
  duplicateValidation.errors.some(
    (issue) => issue.code === "INVENTORY_DUPLICATE_PRODUCT_CODE",
  ),
  "duplicate inventory codes must be a blocking error",
);

const edgeWorkbook = workbookTools.buildWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(
  Array.from(edgeWorkbook.SheetNames),
  Array.from(workbookTools.REQUIRED_SHEETS),
  "workbook sheet contract changed",
);
assert.equal(edgeWorkbook.Sheets["미출고현황"]["D5"].t, "s");
assert.equal(edgeWorkbook.Sheets["미출고현황"]["D5"].v, "000100");
assert.ok(edgeWorkbook.Sheets["미출고현황"]["K5"].f, "allocation sheet formula missing");
assert.ok(edgeWorkbook.Sheets["미출고현황"]["!autofilter"], "filter metadata missing");
assert.deepEqual(edgeWorkbook.Sheets["미출고현황"]["!freeze"], { xSplit: 0, ySplit: 4 });

const html = fs.readFileSync(path.join(ROOT, "orders.html"), "utf8");
for (const requiredText of [
  "Shipping Management",
  "주문현황 Excel",
  "창고별재고 Excel",
  "미출고현황 Excel 다운로드",
  "orderFulfillmentEngine.js",
  "orderFulfillmentWorkbook.js",
]) {
  assert.ok(html.includes(requiredText), `orders.html is missing: ${requiredText}`);
}

function readFileMatrices(filePath, sheetName) {
  const workbook = XLSX.read(fs.readFileSync(filePath), {
    type: "buffer",
    cellDates: false,
    cellNF: true,
    cellText: true,
  });
  const selectedName = workbook.SheetNames.includes(sheetName)
    ? sheetName
    : workbook.SheetNames[0];
  const sheet = workbook.Sheets[selectedName];
  return {
    sheetName: selectedName,
    rawMatrix: XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    }),
    displayMatrix: XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    }),
  };
}

const referenceOrdersPath = "C:\\Users\\USER\\Desktop\\미출고.xlsx";
const referenceInventoryPath = "C:\\Users\\USER\\Desktop\\창고별재고.xlsx";
let referenceWorkspace = null;
if (fs.existsSync(referenceOrdersPath) && fs.existsSync(referenceInventoryPath)) {
  const orderInput = readFileMatrices(referenceOrdersPath, "미판매현황");
  const inventoryInput = readFileMatrices(referenceInventoryPath, "재고현황");
  const referenceOrders = engine.parseOrderWorkbook({
    fileName: path.basename(referenceOrdersPath),
    ...orderInput,
  });
  const referenceInventory = engine.parseInventoryWorkbook({
    fileName: path.basename(referenceInventoryPath),
    ...inventoryInput,
  });
  const referenceValidation = engine.validateInputs(referenceOrders, referenceInventory);
  assert.equal(
    referenceValidation.canAnalyze,
    true,
    JSON.stringify(referenceValidation.errors, null, 2),
  );
  assert.equal(referenceOrders.rowCount, 90);
  assert.equal(referenceInventory.rowCount, 325);
  assert.equal(referenceValidation.duplicateCount, 0);
  assert.equal(referenceValidation.unmatchedCount, 0);
  assert.equal(referenceValidation.memoCount, 6);

  referenceWorkspace = engine.analyze(referenceOrders, referenceInventory, {
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  assert.equal(referenceWorkspace.stats.productCount, 72);
  assert.equal(referenceWorkspace.stats.totalOrderQuantity, 163.8);
  assert.equal(referenceWorkspace.stats.totalPurchaseNeed, 73.5);
  assert.equal(referenceWorkspace.stats.allocationDifference, 0);
  assert.equal(referenceWorkspace.stats.productQuantityDifference, 0);
  assert.equal(referenceWorkspace.stats.negativePurchaseCount, 0);
  assert.equal(referenceWorkspace.stats.reconciliationErrorCount, 0);
}

const outputWorkspace = referenceWorkspace || edgeWorkspace;
const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-shipping-management-"));
try {
  const outputPath = path.join(tempDir, "미출고현황_테스트.xlsx");
  const outputWorkbook = workbookTools.buildWorkbook(outputWorkspace, XLSX);
  const outputBytes = XLSX.write(outputWorkbook, {
    type: "array",
    bookType: "xlsx",
    compression: true,
    cellStyles: true,
  });
  fs.writeFileSync(outputPath, Buffer.from(new Uint8Array(outputBytes)));
  assert.ok(fs.statSync(outputPath).size > 10000, "generated workbook is unexpectedly small");
  if (process.env.SHIPPING_TEST_OUTPUT) {
    const requestedOutput = path.resolve(ROOT, process.env.SHIPPING_TEST_OUTPUT);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    assert.ok(
      requestedOutput.startsWith(rootPrefix),
      `SHIPPING_TEST_OUTPUT must remain inside the repository: ${requestedOutput}`,
    );
    fs.mkdirSync(path.dirname(requestedOutput), { recursive: true });
    fs.copyFileSync(outputPath, requestedOutput);
  }
  const reopened = XLSX.read(fs.readFileSync(outputPath), {
    type: "buffer",
    cellFormula: true,
    cellStyles: true,
  });
  assert.deepEqual(
    Array.from(reopened.SheetNames),
    Array.from(workbookTools.REQUIRED_SHEETS),
    "reopened workbook sheet contract changed",
  );
  assert.equal(
    reopened.Sheets["미출고현황"]["D5"].t,
    "s",
    "product code must reopen as text",
  );
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedPrefix = path.resolve(ROOT, ".tmp-shipping-management-");
  assert.ok(
    resolvedTempDir.startsWith(allowedPrefix),
    `refusing to remove unexpected temp directory: ${resolvedTempDir}`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(
  referenceWorkspace
    ? "Shipping Management tests passed, including the real 90-order/325-inventory reference files."
    : "Shipping Management tests passed. Real reference files were not present and were skipped.",
);
