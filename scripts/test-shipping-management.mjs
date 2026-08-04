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
const PURCHASE_TEMPLATE_PATH = "C:\\Users\\USER\\Desktop\\구매업로드.xlsx";
const purchaseTemplateBaseline = fs.existsSync(PURCHASE_TEMPLATE_PATH)
  ? {
      hash: crypto.createHash("sha256").update(fs.readFileSync(PURCHASE_TEMPLATE_PATH)).digest("hex"),
      mtimeMs: fs.statSync(PURCHASE_TEMPLATE_PATH).mtimeMs,
    }
  : null;

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
      row.date || `2026-08-04-${index + 1}`,
      row.manager || "담당",
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
      row.quantity ?? "",
      row.whole ?? "",
      row.transfer2 ?? "",
      row.seoul ?? "",
      row.transfer ?? "",
      row.jinyeong ?? "",
      row.base ?? "",
      row.transferLabel ?? "",
      row.warehousePrice ?? "",
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

const CANONICAL_ORDER_HEADERS = [...ORDER_HEADERS, "공급가액"];
const CANONICAL_ORDER_VALUES = Object.freeze({
  "일자-No.": "2026-08-04-1",
  "담당": "담당A",
  "단위": "EA",
  "품목코드": "ALIAS-001",
  "품목명": "별칭 상품",
  "규격": "EA",
  "수량": 3,
  "재고": 7,
  "단가": 1200,
  "공급가액": 3600,
  "적요": "별칭 적요",
  "적요1": "유지 적요1",
  "거래처": "별칭 거래처",
  "그룹": "별칭 그룹",
});

function buildCanonicalOrderMatrix({ replacements = {}, headerOrder = CANONICAL_ORDER_HEADERS, preambleCount = 1, extraHeaders = [] } = {}) {
  const headers = [...headerOrder.map((canonical) => replacements[canonical] || canonical), ...extraHeaders];
  const values = [...headerOrder.map((canonical) => CANONICAL_ORDER_VALUES[canonical]), ...extraHeaders.map(() => "확인값")];
  return [
    ...Array.from({ length: preambleCount }, (_, index) => [`상단 안내 ${index + 1}`]),
    headers,
    values,
  ];
}

const approvedAliasGroups = {
  "품목코드": ["상품코드", "품목코드", "코드"],
  "품목명": ["상품명", "품목명", "제품명"],
  "수량": ["수량", "주문수량", "미출고수량"],
  "단가": ["단가", "판매단가", "출고단가"],
  "공급가액": ["공급가액", "금액", "합계금액"],
  "거래처": ["거래처", "거래처명", "고객명"],
  "적요": ["메모", "비고", "적요"],
};
for (const [canonical, aliases] of Object.entries(approvedAliasGroups)) {
  for (const alias of aliases) {
    const parsed = parseOrders(buildCanonicalOrderMatrix({ replacements: { [canonical]: alias } }));
    assert.equal(parsed.errors.length, 0, `${canonical} alias ${alias} must parse`);
    assert.equal(parsed.headerMapping.columns.some((column) => column.canonical === canonical && column.header === alias), true);
    assert.equal(parsed.rows[0].productCode, "ALIAS-001");
    assert.equal(parsed.rows[0].productName, "별칭 상품");
    assert.equal(parsed.rows[0].quantity, 3);
    assert.equal(parsed.rows[0].unitPrice, 1200);
    assert.equal(parsed.rows[0].supplyAmount, 3600);
    assert.equal(parsed.rows[0].customer, "별칭 거래처");
    assert.equal(parsed.rows[0].note, "별칭 적요");
  }
}

const normalizedAliasOrders = parseOrders(buildCanonicalOrderMatrix({
  replacements: { "일자-No.": "일자 - nO .", "품목코드": " 상-품_코 드 ", "품목명": "제 품-명" },
  headerOrder: [...CANONICAL_ORDER_HEADERS].reverse(),
  preambleCount: 29,
}));
assert.equal(normalizedAliasOrders.headerRowIndex, 29, "the thirtieth row must remain inside the order header scan range");
assert.equal(normalizedAliasOrders.rows[0].productCode, "ALIAS-001", "punctuation, spaces, and case must not change alias matching");
assert.deepEqual(
  normalizedAliasOrders.sourceMatrix[29],
  [...CANONICAL_ORDER_HEADERS].reverse().map((canonical) => ({
    "일자-No.": "일자 - nO .",
    "품목코드": " 상-품_코 드 ",
    "품목명": "제 품-명",
  }[canonical] || canonical)),
  "source headers must not be renamed by canonical mapping",
);

const duplicateCanonicalOrders = parseOrders(buildCanonicalOrderMatrix({ extraHeaders: ["상품코드"] }));
assert.equal(duplicateCanonicalOrders.errors.some((issue) => issue.code === "ORDER_DUPLICATE_CANONICAL_HEADERS"), true);
assert.match(
  duplicateCanonicalOrders.errors.find((issue) => issue.code === "ORDER_DUPLICATE_CANONICAL_HEADERS").message,
  /품목코드: 품목코드\(4열\), 상품코드\(15열\)/,
  "duplicate canonical errors must identify the standard field and source positions",
);
assert.equal(duplicateCanonicalOrders.rows.length, 0, "ambiguous canonical mappings must block row import");

const missingCanonicalOrders = parseOrders(buildCanonicalOrderMatrix({
  headerOrder: CANONICAL_ORDER_HEADERS.filter((header) => header !== "규격"),
}));
assert.deepEqual(missingCanonicalOrders.missingColumns, ["규격"]);
assert.match(missingCanonicalOrders.errors[0].message, /규격/);

const unknownHeaderOrders = parseOrders(buildCanonicalOrderMatrix({ extraHeaders: ["사용자 정의 열"] }));
assert.equal(unknownHeaderOrders.errors.length, 0);
assert.equal(unknownHeaderOrders.warnings.some((issue) => issue.code === "ORDER_UNKNOWN_HEADERS"), true);
assert.match(unknownHeaderOrders.warnings[0].message, /사용자 정의 열\(15열\)/);

const supplyHeaders = [...CANONICAL_ORDER_HEADERS];
const supplyMatrix = [
  ["공급가액 보존"],
  supplyHeaders,
  ...[
    ["SUPPLY-0", 0],
    ["SUPPLY-BLANK", ""],
    ["SUPPLY-TEXT", "숫자 확인 필요"],
  ].map(([code, supplyAmount], index) => supplyHeaders.map((canonical) => ({
    ...CANONICAL_ORDER_VALUES,
    "일자-No.": `2026-08-04-${index + 1}`,
    "품목코드": code,
    "공급가액": supplyAmount,
  }[canonical]))),
];
const supplyOrders = parseOrders(supplyMatrix);
assert.deepEqual(supplyOrders.rows.map((row) => row.supplyAmount), [0, null, "숫자 확인 필요"]);
assert.deepEqual(supplyOrders.sourceMatrix, supplyMatrix, "supply source cells and headers must remain unchanged");

const edgeOrders = parseOrders(
  buildOrderMatrix([
    { code: "000100", quantity: 4, note: "원문 적요", customer: "같은거래처", price: 1000 },
    { code: "000100", quantity: 4, note: "원문 적요", note1: "원문 적요1", customer: "같은거래처", price: 1200 },
    { code: "000100", quantity: 2 },
    { code: "NO-STOCK", quantity: 3 },
  ]),
);
const edgeInventory = parseInventory(
  buildInventoryMatrix([
    { code: "000100", whole: 5, seoul: 4, transfer: -1 },
    { code: "000100-A", name: "대체 참고상품", whole: 7, seoul: 0, transfer: 0 },
  ]),
);
const unknownHeaderInventory = parseInventory(buildInventoryMatrix([
  { code: "ALIAS-001", whole: 3, seoul: 0, transfer: 0 },
]));
assert.equal(
  engine.validateInputs(unknownHeaderOrders, unknownHeaderInventory).canAnalyze,
  true,
  "unknown headers must warn without blocking otherwise valid input",
);

const supplyInventory = parseInventory(buildInventoryMatrix([
  { code: "SUPPLY-0", whole: 0, seoul: 0, transfer: 0 },
  { code: "SUPPLY-BLANK", whole: 0, seoul: 0, transfer: 0 },
  { code: "SUPPLY-TEXT", whole: 0, seoul: 0, transfer: 0 },
]));
const supplyWorkspace = engine.analyze(supplyOrders, supplyInventory, {
  createdAt: "2026-08-04T00:00:00.000Z",
});
const blankSupplyMatrix = supplyMatrix.map((row, rowIndex) =>
  rowIndex <= 1 ? [...row] : row.map((value, columnIndex) =>
    columnIndex === supplyHeaders.indexOf("공급가액") ? "" : value,
  ),
);
const blankSupplyWorkspace = engine.analyze(parseOrders(blankSupplyMatrix), supplyInventory, {
  createdAt: "2026-08-04T00:00:00.000Z",
});
assert.equal(supplyWorkspace.stats.totalOrderQuantity, 9);
assert.equal(supplyWorkspace.stats.totalPurchaseNeed, 9);
assert.equal(supplyWorkspace.stats.allocationDifference, 0);
assert.deepEqual(
  supplyWorkspace.allocations.map((row) => [row.quantity, row.wholeAllocation, row.seoulAllocation, row.purchaseNeed]),
  blankSupplyWorkspace.allocations.map((row) => [row.quantity, row.wholeAllocation, row.seoulAllocation, row.purchaseNeed]),
  "supply amount must not participate in allocation or purchase-need calculations",
);
assert.deepEqual(supplyWorkspace.allocations.map((row) => row.supplyAmount), [0, null, "숫자 확인 필요"]);
assert.equal(supplyWorkspace.sourceFiles.orders.headerMapping.schemaVersion, "shipping-order-header-mapping/v1");
const supplyWorkbook = workbookTools.buildWorkbook(supplyWorkspace, XLSX);
assert.deepEqual(
  [2, 3, 4].map((rowNumber) => sheetCellByHeader(supplyWorkbook.Sheets["미출고현황"], "공급가액", rowNumber).v),
  [0, "", "숫자 확인 필요"],
  "general Excel must preserve supply amount zero, blank, and nonnumeric source meaning",
);
assert.equal(
  XLSX.utils.decode_range(workbookTools.buildPurchaseUploadWorkbook(supplyWorkspace, XLSX).Sheets["구매입력"]["!ref"]).e.c,
  19,
  "supply amount must not change the purchase-upload A:T contract",
);
const edgeValidation = engine.validateInputs(edgeOrders, edgeInventory);
assert.equal(edgeValidation.canAnalyze, true);
assert.equal(edgeValidation.unmatchedCount, 1);
assert.equal(edgeValidation.memoCount, 2);

const edgeWorkspace = engine.analyze(edgeOrders, edgeInventory, {
  createdAt: "2026-07-30T00:00:00.000Z",
  sourceFingerprint: "a".repeat(64),
});
assert.equal(engine.ENGINE_VERSION, "3.3.0");
assert.equal(workbookTools.WORKBOOK_VERSION, "3.3.0");
assert.equal(edgeWorkspace.schemaVersion, "shipping-workspace/v2");
assert.equal(edgeWorkspace.basisDate, "2026-08-04");
assert.equal(edgeWorkspace.uploadDate, "20260804");
assert.equal(edgeWorkspace.planId, `SHIPPLAN-20260804-${"a".repeat(16)}`);
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
  edgeWorkspace.purchaseManagement.find((row) => row.productCode === "NO-STOCK").inventoryMatched,
  false,
);
assert.deepEqual(
  edgeWorkspace.productSummaries.find((row) => row.productCode === "000100").supplierPairs.map((pair) => pair.display),
  ["같은거래처(1000)", "같은거래처(1200)", "거래처 3(1000)"],
  "same customer with different original prices must remain separate",
);
assert.deepEqual(
  edgeWorkspace.allocations.slice(0, 3).map((row) => [row.supplierDisplay, row.unitPrice, typeof row.unitPrice]),
  [
    ["같은거래처(1000)", 1000, "number"],
    ["같은거래처(1200)", 1200, "number"],
    ["거래처 3(1000)", 1000, "number"],
  ],
  "each allocation must preserve its original numeric unit price and pair display",
);
assert.equal(
  edgeWorkspace.productSummaries.find((row) => row.productCode === "000100").noteValues.length,
  1,
  "memo originals must be de-duplicated without losing the original text",
);
const purchaseRowsFor000100 = edgeWorkspace.purchaseManagement.filter((row) => row.referenceFor === "000100" || row.productCode === "000100");
assert.deepEqual(purchaseRowsFor000100.map((row) => [row.productCode, row.rowType]), [
  ["000100", "main"],
  ["000100-A", "reference"],
]);

const shadowWorkspace = engine.analyze(
  parseOrders(buildOrderMatrix([{ code: "000001", quantity: 2, spec: "BOX" }])),
  parseInventory(buildInventoryMatrix([
    { code: "000001", whole: 0, seoul: 0, transfer: 0, spec: "BOX" },
    { code: "000002", whole: 5, seoul: 0, transfer: 0, spec: "EA" },
    { code: "000003", whole: 3, seoul: 0, transfer: 0, spec: "소분" },
  ])),
  { sourceFingerprint: "b".repeat(64) },
);
const totalsBeforeShadowEdit = {
  totalOrderQuantity: shadowWorkspace.stats.totalOrderQuantity,
  productCount: shadowWorkspace.stats.productCount,
  totalPurchaseNeed: shadowWorkspace.stats.totalPurchaseNeed,
  validationResults: JSON.stringify(shadowWorkspace.validationResults),
  unmatchedCount: shadowWorkspace.stats.unmatchedCount,
};
const shadowRows = shadowWorkspace.purchaseManagement.filter((row) => row.inventoryShadow === true);
assert.deepEqual(shadowRows.map((row) => [row.productCode, row.purchaseNeed, row.totalOrderQuantity]), [
  ["000002", null, null],
  ["000003", null, null],
]);
assert.equal(engine.ensureInventoryPurchaseRows(shadowWorkspace), shadowWorkspace);
assert.equal(shadowWorkspace.purchaseManagement.filter((row) => row.inventoryShadow === true).length, 2);
engine.setPurchaseValue(shadowWorkspace, "000002", "재고전용거래처");
assert.equal(engine.getPurchaseInputs(shadowWorkspace)["000002"], "재고전용거래처");
assert.equal(engine.getPurchaseUploadSelection(shadowWorkspace).included.some((row) => row.productCode === "000002"), false);
assert.equal(engine.getPurchaseUploadSelection(shadowWorkspace).excluded.some((row) => row.productCode === "000002"), false);
assert.deepEqual(
  {
    totalOrderQuantity: shadowWorkspace.stats.totalOrderQuantity,
    productCount: shadowWorkspace.stats.productCount,
    totalPurchaseNeed: shadowWorkspace.stats.totalPurchaseNeed,
    validationResults: JSON.stringify(shadowWorkspace.validationResults),
    unmatchedCount: shadowWorkspace.stats.unmatchedCount,
  },
  totalsBeforeShadowEdit,
  "inventory-only purchase edits must not alter calculations, validation, or unmatched counts",
);
assert.equal(engine.getInventoryViewRows(shadowWorkspace).rows.length, 3);
const roundTripShadow = JSON.parse(JSON.stringify(shadowWorkspace));
engine.applyPurchaseInputs(roundTripShadow, engine.getPurchaseInputs(shadowWorkspace));
assert.equal(engine.getPurchaseInputs(roundTripShadow)["000002"], "재고전용거래처");
assert.equal(roundTripShadow.purchaseManagement.filter((row) => row.inventoryShadow === true).length, 2);
const legacyWorkspace = JSON.parse(JSON.stringify(shadowWorkspace));
legacyWorkspace.purchaseManagement = legacyWorkspace.purchaseManagement.filter((row) => row.inventoryShadow !== true);
engine.ensureInventoryPurchaseRows(legacyWorkspace);
assert.deepEqual(
  legacyWorkspace.purchaseManagement.filter((row) => row.inventoryShadow === true).map((row) => row.productCode),
  ["000002", "000003"],
  "legacy v2 workspaces must reconstruct inventory shadow rows idempotently",
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

const dynamicInventoryHeaders = [
  "품목코드", "품목명", "규격", "1창고", "", "3서울", "4전송", "신규창고", "신규창고", "창고메모", "", "",
];
const dynamicInventoryMatrix = [
  ["동적 창고열 테스트"],
  dynamicInventoryHeaders,
  ["000010", "동적상품", "EA", 0, "숨김값", 0, 0, -130, "00123", "A동", "", ""],
  ["000011", "텍스트상품", "BOX", 2, "숨김값2", 0, 0, "-4", "00007", "B동", "", ""],
];
const baseInventoryMatrix = dynamicInventoryMatrix.map((row, rowIndex) => {
  const copy = row.slice();
  if (rowIndex === 1) [7, 8, 9].forEach((index) => { copy[index] = ""; });
  if (rowIndex > 1) [7, 8, 9].forEach((index) => { copy[index] = ""; });
  return copy;
});
const dynamicOrders = parseOrders(buildOrderMatrix([
  { code: "000010", quantity: 2, spec: "EA" },
  { code: "000010", quantity: 1, spec: "EA", customer: "반복거래처" },
  { code: "000011", quantity: 1, spec: "BOX" },
]));
const dynamicWorkspace = engine.analyze(dynamicOrders, parseInventory(dynamicInventoryMatrix), {
  sourceFingerprint: "e".repeat(64),
});
const baseDynamicWorkspace = engine.analyze(dynamicOrders, parseInventory(baseInventoryMatrix), {
  sourceFingerprint: "f".repeat(64),
});
const dynamicView = engine.getInventoryViewRows(dynamicWorkspace);
assert.deepEqual(dynamicView.headers, [
  "품목코드", "품목명", "규격", "수량", "1창고", "3서울", "4전송", "신규창고", "신규창고", "창고메모",
]);
assert.deepEqual(dynamicView.columns.map((column) => column.sourceIndex), [0, 1, 2, null, 3, 5, 6, 7, 8, 9]);
assert.equal(new Set(dynamicView.columns.map((column) => column.key)).size, dynamicView.columns.length);
assert.notEqual(dynamicView.columns[7].key, dynamicView.columns[8].key, "duplicate labels must remain isolated by source index");
assert.deepEqual(dynamicView.rows[0].values, ["000010", "동적상품", "EA", -7, 0, 0, 0, -130, "00123", "A동"]);
assert.equal(dynamicView.rows[0].values.includes("숨김값"), false, "interior blank-header data must not shift into visible columns");
assert.equal(dynamicView.rows[0].inventoryTotal, -7, "all dynamic warehouse columns must retain signs in the arithmetic total");
assert.equal(dynamicView.rows[1].inventoryTotal, 5, "numeric text warehouse values must participate without changing source display");
assert.deepEqual(
  {
    allocations: dynamicWorkspace.allocations,
    validation: dynamicWorkspace.validationResults,
    upload: engine.getPurchaseUploadSelection(dynamicWorkspace),
  },
  {
    allocations: baseDynamicWorkspace.allocations,
    validation: baseDynamicWorkspace.validationResults,
    upload: engine.getPurchaseUploadSelection(baseDynamicWorkspace),
  },
  "dynamic inspection columns must not alter legacy allocation, validation, or purchase-upload selection",
);
assert.equal(dynamicWorkspace.stats.inventoryNegativeCount, 1);
assert.equal(baseDynamicWorkspace.stats.inventoryNegativeCount, 0);
const dynamicAllocationView = engine.getAllocationInventoryView(dynamicWorkspace);
assert.deepEqual(
  dynamicAllocationView.columns.map((column) => column.header),
  ["1창고", "3서울", "4전송", "신규창고", "신규창고"],
  "all dynamic warehouses including 4전송 must appear independently in source order",
);
assert.deepEqual(
  dynamicAllocationView.rows[0].warehouseValues,
  dynamicAllocationView.rows[1].warehouseValues,
  "repeated order lines for one product must repeat the same warehouse values",
);
const dynamicRoundTrip = JSON.parse(JSON.stringify(dynamicWorkspace));
assert.deepEqual(
  engine.getInventoryViewRows(dynamicRoundTrip).columns,
  dynamicView.columns,
  "dynamic descriptors and stable keys must survive workspace round-trip",
);
const corruptColumnMetadataWorkspace = JSON.parse(JSON.stringify(dynamicWorkspace));
corruptColumnMetadataWorkspace.sourceFiles.inventory.columns.find(
  (column) => column.role === "calculatedQuantity",
).editable = true;
assert.equal(
  engine.getInventoryColumnDescriptors(corruptColumnMetadataWorkspace).find(
    (column) => column.role === "calculatedQuantity",
  ).editable,
  false,
  "corrupt stored column metadata must be re-derived from the original header row",
);
const overrideWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
const overrideSourceBefore = JSON.stringify(overrideWorkspace.sourceFiles.inventory.matrix);
const legacyCalculationSnapshot = (workspace) => JSON.stringify({
  allocations: workspace.allocations.map((row) => [
    row.productCode, row.quantity, row.wholeAllocation, row.seoulAllocation,
    row.purchaseNeed, row.wholeRemaining, row.seoulRemaining, row.status,
  ]),
  productSummaries: workspace.productSummaries.map((row) => [
    row.productCode, row.totalOrderQuantity, row.wholeAllocation, row.seoulAllocation,
    row.purchaseNeed, row.reconciliationDifference,
  ]),
  validationResults: workspace.validationResults,
  purchaseUpload: {
    included: engine.getPurchaseUploadSelection(workspace).included.map((row) => row.productCode),
    excluded: engine.getPurchaseUploadSelection(workspace).excluded.map((row) => [row.productCode, row.reason]),
  },
});
const allocationBeforeOverrides = legacyCalculationSnapshot(overrideWorkspace);
const overrideColumns = engine.getInventoryColumnDescriptors(overrideWorkspace);
const columnByHeader = new Map(overrideColumns.map((column) => [column.header, column]));
for (const header of ["1창고", "2전송", "3서울", "4전송", "7진영"]) {
  assert.equal(columnByHeader.get(header)?.role, "warehouseQuantity", `${header} must be a signed warehouse quantity`);
}

function sheetCellByHeader(sheet, header, rowNumber = 2) {
  const headerRow = Array.from(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, range: 0 })[0]);
  const columnIndex = headerRow.indexOf(header);
  assert.notEqual(columnIndex, -1, `missing workbook header: ${header}`);
  return sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: columnIndex })];
}
for (const header of ["기본", "전송", "창고"]) {
  assert.equal(columnByHeader.get(header)?.editable, true, `${header} must be editable`);
}
assert.equal(columnByHeader.get("수량")?.role, "calculatedQuantity");
assert.equal(columnByHeader.get("수량")?.editable, false, "automatic quantity must remain readonly");
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("2전송").key, -20);
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("기본").key, "검수기본");
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("전송").key, "검수전송");
engine.setInventoryOverride(overrideWorkspace, "000100", columnByHeader.get("창고").key, 4321);
engine.setPurchaseValue(overrideWorkspace, "000100", "검수구매");
const overriddenRow = engine.getInventoryViewRows(overrideWorkspace).rows.find((row) => row.productCode === "000100");
assert.equal(overriddenRow.inventoryTotal, -12, "blank warehouse cells must be zero and signed transfer warehouses must be summed");
assert.equal(overriddenRow.values[columnByHeader.get("수량").sourceIndex], -12);
assert.equal(overriddenRow.values[columnByHeader.get("기본").sourceIndex], "검수기본");
assert.equal(overriddenRow.values[columnByHeader.get("전송").sourceIndex], "검수전송");
assert.equal(overriddenRow.values[columnByHeader.get("창고").sourceIndex], 4321);
assert.equal(overriddenRow.purchase, "검수구매");
assert.equal(JSON.stringify(overrideWorkspace.sourceFiles.inventory.matrix), overrideSourceBefore, "source inventory matrix must remain byte-shape immutable");
assert.equal(
  legacyCalculationSnapshot(overrideWorkspace),
  allocationBeforeOverrides,
  "inspection overrides must never feed legacy allocation or purchase-need calculations",
);
const recoveredOverrideWorkspace = JSON.parse(JSON.stringify(overrideWorkspace));
assert.deepEqual(
  engine.getInventoryViewRows(recoveredOverrideWorkspace).rows.find((row) => row.productCode === "000100"),
  overriddenRow,
  "optional overrides must survive local/cloud compatible JSON recovery",
);
const corruptOverrideWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
corruptOverrideWorkspace.inventoryOverrides = {
  schemaVersion: engine.INVENTORY_OVERRIDE_SCHEMA_VERSION,
  cells: [{ productCode: "000100", columnKey: columnByHeader.get("2전송").key, value: "손상숫자" }],
};
assert.equal(
  engine.getInventoryViewRows(corruptOverrideWorkspace).rows.find((row) => row.productCode === "000100").inventoryTotal,
  8,
  "corrupt numeric overrides must fall back to the original signed warehouse values",
);
assert.throws(
  () => engine.setInventoryOverride(corruptOverrideWorkspace, "000100", columnByHeader.get("2전송").key, "손상숫자"),
  /숫자 또는 빈칸/,
);
const reorderedOverrideWorkspace = JSON.parse(JSON.stringify(overrideWorkspace));
const reorderedHeader = reorderedOverrideWorkspace.sourceFiles.inventory.matrix[1];
[reorderedHeader[7], reorderedHeader[8]] = [reorderedHeader[8], reorderedHeader[7]];
const reorderedRow = engine.getInventoryViewRows(reorderedOverrideWorkspace).rows.find((row) => row.productCode === "000100");
assert.notEqual(
  reorderedRow.values[7],
  -20,
  "sourceIndex+normalized-header identity must prevent an override from moving to a reordered column",
);
const dynamicWorkbook = workbookTools.buildWorkbook(dynamicWorkspace, XLSX);
const dynamicInventorySheet = dynamicWorkbook.Sheets["창고별 재고"];
assert.deepEqual(
  Array.from(XLSX.utils.sheet_to_json(dynamicInventorySheet, { header: 1, raw: true, range: "A1:L1" })[0]),
  [...dynamicView.headers, "구매", "거래처(단가)"],
);
assert.equal(dynamicInventorySheet["B1"].v, "품목명");
assert.equal(dynamicInventorySheet["H1"].v, "신규창고");
assert.equal(dynamicInventorySheet["I1"].v, "신규창고");
assert.deepEqual([dynamicInventorySheet["D2"].t, dynamicInventorySheet["D2"].v], ["n", -7]);
assert.deepEqual([dynamicInventorySheet["H2"].t, dynamicInventorySheet["H2"].v], ["n", -130]);
assert.equal(dynamicInventorySheet["D2"].s.fill.fgColor.rgb, "FFF200");
assert.equal(dynamicInventorySheet["H2"].s.fill.fgColor.rgb, "FFF200");
assert.deepEqual([dynamicInventorySheet["I2"].t, dynamicInventorySheet["I2"].v], ["s", "00123"]);
assert.equal(dynamicInventorySheet["I2"].s.numFmt, "@");
assert.notEqual(dynamicInventorySheet["I2"].s.fill.fgColor.rgb, "FFF200");
assert.equal(dynamicInventorySheet["K1"].v, "구매", "reserved purchase descriptor must be appended exactly once after source columns");
assert.equal(dynamicInventorySheet["L1"].v, "거래처(단가)", "supplier pairs must be the rightmost inventory column");
assert.equal(dynamicInventorySheet["!ref"], "A1:L3", "inventory rows must remain one row per inventory product despite repeated orders");
const overrideInventorySheet = workbookTools.buildWorkbook(overrideWorkspace, XLSX).Sheets["창고별 재고"];
assert.deepEqual(
  ["F2", "H2", "L2", "M2", "N2", "O2", "P2"].map((address) => overrideInventorySheet[address].v),
  [-12, -20, "검수기본", "검수전송", 4321, "검수구매", "같은거래처(1000)\n같은거래처(1200)\n거래처 3(1000)"],
  "general Excel must carry every effective override, automatic quantity, purchase, and supplier pairs",
);
assert.equal(overrideInventorySheet["P2"].s.alignment.wrapText, true, "Excel supplier pairs must use full wrapped lines");
assert.equal(overrideInventorySheet["F2"].s.fill.fgColor.rgb, "FFF200", "negative automatic quantity must be highlighted");
const purchaseContractWorkspace = JSON.parse(JSON.stringify(edgeWorkspace));
const purchaseShapeBeforeOverride = XLSX.utils.sheet_to_json(
  workbookTools.buildPurchaseUploadWorkbook(purchaseContractWorkspace, XLSX).Sheets["구매입력"],
  { header: 1, raw: true, defval: null },
);
engine.setInventoryOverride(
  purchaseContractWorkspace,
  "000100",
  engine.getInventoryColumnDescriptors(purchaseContractWorkspace).find((column) => column.header === "2전송").key,
  -999,
);
const purchaseShapeAfterOverride = XLSX.utils.sheet_to_json(
  workbookTools.buildPurchaseUploadWorkbook(purchaseContractWorkspace, XLSX).Sheets["구매입력"],
  { header: 1, raw: true, defval: null },
);
assert.deepEqual(
  purchaseShapeAfterOverride,
  purchaseShapeBeforeOverride,
  "inventory overrides must not change the purchase-upload workbook shape or meaning",
);

const edgeWorkbook = workbookTools.buildWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(
  Array.from(edgeWorkbook.SheetNames),
  Array.from(workbookTools.REQUIRED_SHEETS),
  "workbook sheet contract changed",
);
assert.deepEqual(Array.from(workbookTools.REQUIRED_SHEETS), [
  "발주관리",
  "미출고현황",
  "창고별 재고",
  "검증결과",
  "주문원본",
]);
assert.deepEqual(
  Array.from(
    XLSX.utils.sheet_to_json(edgeWorkbook.Sheets["미출고현황"], { header: 1, raw: true, range: 0 })[0],
  ),
  [
    "상품코드", "품목명", "규격", "1창고", "2전송", "3서울", "4전송", "7진영",
    "주문수량", "전재고", "서울잔량", "구매수량", "구매", "거래처", "단가", "공급가액", "적요", "적요1", "담당자",
  ],
);
assert.equal(engine.parseOrderBasisDate("2026-08-04-17"), "2026-08-04");
assert.equal(engine.parseOrderBasisDate("20260804-17"), "2026-08-04");
assert.equal(engine.parseOrderBasisDate("2026.8.4 No.17"), "2026-08-04");

for (const [purchase, expectedCount] of [
  ["대체", 0],
  ["소분", 0],
  ["대채", 1],
  ["대체 예정", 1],
  ["소분작업", 1],
  ["", 1],
]) {
  engine.setPurchaseValue(edgeWorkspace, "000100", purchase);
  assert.equal(
    engine.getPurchaseUploadSelection(edgeWorkspace).included.length,
    expectedCount,
    `${purchase || "blank"} exact exclusion rule changed`,
  );
}
engine.setPurchaseValue(edgeWorkspace, "000100", "거래처A");
assert.ok(edgeWorkspace.allocations.filter((row) => row.productCode === "000100").every((row) => row.purchase === "거래처A"));
assert.equal(edgeWorkspace.productSummaries.find((row) => row.productCode === "000100").purchase, "거래처A");
assert.equal(edgeWorkspace.purchaseManagement.find((row) => row.productCode === "000100" && row.rowType === "main").purchase, "거래처A");
const linkedPurchaseWorkbook = workbookTools.buildWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(
  [
    [
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "거래처", 2).v,
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "단가", 2).v,
      typeof sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "단가", 2).v,
    ],
    [
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "거래처", 3).v,
      sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "단가", 3).v,
      typeof sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "단가", 3).v,
    ],
  ],
  [
    ["같은거래처", 1000, "number"],
    ["같은거래처", 1200, "number"],
  ],
  "미출고현황 workbook must split each original customer and numeric unit price",
);
assert.equal(sheetCellByHeader(linkedPurchaseWorkbook.Sheets["미출고현황"], "구매", 2).v, "거래처A");
assert.equal(linkedPurchaseWorkbook.Sheets["발주관리"].H5.v, "거래처A");
assert.equal(linkedPurchaseWorkbook.Sheets["발주관리"].A6, undefined, "reference/shadow rows must not appear in 발주관리");
assert.equal(linkedPurchaseWorkbook.Sheets["창고별 재고"].O2.v, "거래처A");
assert.equal(linkedPurchaseWorkbook.Sheets["창고별 재고"].P2.v, "같은거래처(1000)\n같은거래처(1200)\n거래처 3(1000)");

const purchaseUploadWorkbook = workbookTools.buildPurchaseUploadWorkbook(edgeWorkspace, XLSX);
assert.deepEqual(Array.from(purchaseUploadWorkbook.SheetNames), ["구매입력"]);
const purchaseUploadSheet = purchaseUploadWorkbook.Sheets["구매입력"];
assert.deepEqual(
  Array.from(XLSX.utils.sheet_to_json(purchaseUploadSheet, { header: 1, raw: true, range: "A1:T1" })[0]),
  Array.from(workbookTools.PURCHASE_UPLOAD_HEADERS),
);
for (const address of ["A1", "E1", "F1", "I1", "J1", "L1"]) {
  assert.equal(purchaseUploadSheet[address].s.font.bold, true, `${address} must retain required bold style`);
}
for (const address of ["B1", "C1", "D1", "G1", "H1", "K1", "M1", "N1", "O1", "P1", "Q1", "R1", "S1", "T1"]) {
  assert.notEqual(purchaseUploadSheet[address].s.font.bold, true, `${address} must remain a normal header`);
}
assert.deepEqual(
  ["A2", "D2", "E2", "F2", "I2", "J2", "K2"].map((address) => [purchaseUploadSheet[address].t, purchaseUploadSheet[address].v]),
  [
    ["s", "20260804"], ["s", "거래처A"], ["s", "01"], ["s", ""], ["s", "000100"],
    ["s", "상품 000100"], ["s", "EA"],
  ],
);
assert.deepEqual([purchaseUploadSheet.L2.t, purchaseUploadSheet.L2.v], ["n", 2]);
assert.deepEqual([purchaseUploadSheet.M2.t, purchaseUploadSheet.M2.v], ["n", 0]);
assert.equal(purchaseUploadSheet.L2.s.numFmt, "#,##0");
assert.equal(purchaseUploadSheet.M2.s.numFmt, "#,##0");
assert.equal(workbookTools.getPurchaseUploadFileName(edgeWorkspace), "구매업로드_20260804.xlsx");

const fractionalWorkspace = engine.analyze(
  parseOrders(buildOrderMatrix([{ code: "FRACTION", quantity: 1.25, date: "2026-08-04-1" }])),
  parseInventory(buildInventoryMatrix([{ code: "FRACTION", quantity: 0, whole: 0, seoul: 0, transfer: 0 }])),
);
const fractionalPurchaseSheet = workbookTools.buildPurchaseUploadWorkbook(fractionalWorkspace, XLSX).Sheets["구매입력"];
assert.deepEqual([fractionalPurchaseSheet.L2.t, fractionalPurchaseSheet.L2.v], ["n", 1.25]);
assert.equal(fractionalPurchaseSheet.L2.s.numFmt, "#,##0.00");

const conflictingOrders = parseOrders(buildOrderMatrix([
  { code: "000100", quantity: 1, date: "2026-08-04-1" },
  { code: "000100", quantity: 1, date: "2026-08-05-2" },
]));
const conflictingWorkspace = engine.analyze(conflictingOrders, edgeInventory);
assert.equal(conflictingWorkspace.basisDateStatus, "conflict");
assert.throws(
  () => workbookTools.buildPurchaseUploadWorkbook(conflictingWorkspace, XLSX),
  /기준일/,
  "conflicting basis dates must block purchase upload",
);
assert.equal(edgeWorkbook.Sheets["미출고현황"]["A2"].t, "s");
assert.equal(edgeWorkbook.Sheets["미출고현황"]["A2"].v, "000100");
assert.equal(sheetCellByHeader(edgeWorkbook.Sheets["미출고현황"], "주문수량", 2).v, 4);
assert.ok(edgeWorkbook.Sheets["미출고현황"]["!autofilter"], "filter metadata missing");
assert.deepEqual(edgeWorkbook.Sheets["미출고현황"]["!freeze"], { xSplit: 0, ySplit: 1 });

const formatOrders = parseOrders(
  buildOrderMatrix([
    { code: "PURCHASE", quantity: 2, manager: "담당A", spec: "BOX" },
    { code: "ADDITIONAL", quantity: 2, manager: "담당B", spec: "EA" },
    { code: "SEOUL", quantity: 2, manager: "담당A", spec: "소분" },
    { code: "STOCK", quantity: 2, manager: "담당C", spec: "BOX" },
    { code: "MIXED", quantity: 2, manager: "담당C", spec: "EA" },
    { code: "NO-STOCK", quantity: 1, manager: "담당D", spec: "BOX" },
  ]),
);
const formatInventory = parseInventory(
  buildInventoryMatrix([
    { code: "PURCHASE", spec: "BOX", quantity: -4, whole: 0, seoul: 0, transfer: 0, jinyeong: -4, warehousePrice: 6000 },
    { code: "ADDITIONAL", spec: "EA", quantity: 1, whole: 1, seoul: 0, transfer: 0, transfer2: 3, warehousePrice: 2000 },
    { code: "SEOUL", spec: "소분", quantity: 2, whole: 0, seoul: 3, transfer: -1, warehousePrice: 17000 },
    { code: "STOCK", spec: "BOX", quantity: 5, whole: 5, seoul: 0, transfer: 0, warehousePrice: 15000 },
    { code: "MIXED", spec: "EA", quantity: 2, whole: 1, seoul: 1, transfer: 0, warehousePrice: 8100 },
  ]),
);
const formatValidation = engine.validateInputs(formatOrders, formatInventory);
assert.equal(formatValidation.canAnalyze, true, JSON.stringify(formatValidation.errors));
const formatWorkspace = engine.analyze(formatOrders, formatInventory, {
  createdAt: "2026-08-03T00:00:00.000Z",
});
const inventorySourceSnapshot = JSON.parse(
  JSON.stringify(formatWorkspace.sourceFiles.inventory.matrix),
);
const formatWorkbook = workbookTools.buildWorkbook(formatWorkspace, XLSX);
assert.deepEqual(
  formatWorkspace.sourceFiles.inventory.matrix,
  inventorySourceSnapshot,
  "inventory source matrix must not be mutated while formatting output",
);
const originalDocument = globalThis.document;
const originalUrl = globalThis.URL;
const downloadState = { clicked: false, removed: false, appended: false, revoked: false };
const downloadAnchor = {
  href: "",
  download: "",
  style: {},
  click() {
    downloadState.clicked = true;
  },
  remove() {
    downloadState.removed = true;
  },
};
try {
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "a");
      return downloadAnchor;
    },
    body: {
      appendChild(anchor) {
        assert.equal(anchor, downloadAnchor);
        downloadState.appended = true;
      },
    },
  };
  globalThis.URL = {
    createObjectURL(blob) {
      assert.ok(blob.size > 10000);
      return "blob:shipping-test";
    },
    revokeObjectURL(url) {
      assert.equal(url, "blob:shipping-test");
      downloadState.revoked = true;
    },
  };
  const downloadedWorkbook = workbookTools.downloadWorkbook(
    formatWorkspace,
    XLSX,
    "미출고현황_브라우저테스트.xlsx",
  );
  assert.equal(downloadedWorkbook.SheetNames[0], "발주관리");
  assert.equal(downloadAnchor.download, "미출고현황_브라우저테스트.xlsx");
  assert.equal(downloadAnchor.href, "blob:shipping-test");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(downloadState, {
    clicked: true,
    removed: true,
    appended: true,
    revoked: true,
  });
} finally {
  globalThis.document = originalDocument;
  globalThis.URL = originalUrl;
}
const allocationSheet = formatWorkbook.Sheets["미출고현황"];
assert.equal(allocationSheet["!ref"], "A1:S7");
assert.deepEqual(allocationSheet["!autofilter"], { ref: "A1:S7" });
assert.deepEqual(allocationSheet["!freeze"], { xSplit: 0, ySplit: 1 });
assert.equal(allocationSheet["A2"].t, "s");
assert.equal(allocationSheet["A2"].v, "PURCHASE");
assert.equal(sheetCellByHeader(allocationSheet, "1창고", 2).v, 0);
assert.equal(sheetCellByHeader(allocationSheet, "4전송", 2).v, 0);
assert.equal(sheetCellByHeader(allocationSheet, "7진영", 2).v, -4);
assert.equal(sheetCellByHeader(allocationSheet, "주문수량", 2).v, 2);
assert.equal(sheetCellByHeader(allocationSheet, "구매수량", 2).v, 2);
assert.equal(sheetCellByHeader(allocationSheet, "거래처", 2).v, "거래처 1");
assert.equal(sheetCellByHeader(allocationSheet, "단가", 2).v, 1000);
assert.equal(sheetCellByHeader(allocationSheet, "담당자", 2).v, "담당A");
assert.equal(allocationSheet["A2"].s.fill.fgColor.rgb, "FFFFFF", "stable tie winner 담당A must remain white");
assert.equal(allocationSheet["A4"].s.fill.fgColor.rgb, "FFFFFF", "all rows for the dominant manager must remain white");
assert.notEqual(allocationSheet["A2"].s.fill.fgColor.rgb, allocationSheet["A3"].s.fill.fgColor.rgb);
assert.equal(allocationSheet["A5"].s.fill.fgColor.rgb, allocationSheet["A6"].s.fill.fgColor.rgb);
for (let column = 0; column < 19; column += 1) {
  const address = XLSX.utils.encode_cell({ r: 1, c: column });
  if (address === "H2") continue;
  assert.equal(
    allocationSheet[address].s.fill.fgColor.rgb,
    allocationSheet["A2"].s.fill.fgColor.rgb,
    `${address} must inherit the manager row fill`,
  );
}
assert.equal(allocationSheet["H2"].s.fill.fgColor.rgb, "FEE2E2", "negative warehouse cells must override manager fill");
for (const row of [3, 4, 6]) {
  assert.equal(allocationSheet[`A${row}`].s.font.color.rgb, "B91C1C", `EA/소분 row ${row} must use red text`);
  assert.equal(allocationSheet[`S${row}`].s.font.color.rgb, "B91C1C", `EA/소분 manager row ${row} must use red text`);
}
for (let row = 1; row <= 7; row += 1) {
  for (let column = 0; column < 19; column += 1) {
    const cell = allocationSheet[XLSX.utils.encode_cell({ r: row - 1, c: column })];
    assert.ok(cell, `allocation table cell missing at row=${row} column=${column + 1}`);
    for (const edge of ["top", "bottom", "left", "right"]) {
      assert.equal(cell.s.border[edge].style, "thin");
      assert.equal(cell.s.border[edge].color.rgb, "CBD5E1");
    }
  }
}
assert.deepEqual(allocationSheet["!margins"], {
  left: 0.25,
  right: 0.25,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3,
});
assert.deepEqual(allocationSheet["!pageSetup"], {
  paperSize: 9,
  orientation: "portrait",
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 0,
});
assert.equal(allocationSheet["!printArea"], "A1:S7");
assert.equal(allocationSheet["!printTitles"], "$1:$1");
const printNames = formatWorkbook.Workbook.Names.filter(
  (name) => name.Sheet === 1 && /^_xlnm\.Print_/.test(name.Name),
);
assert.deepEqual(printNames, [
  { Name: "_xlnm.Print_Area", Sheet: 1, Ref: "'미출고현황'!$A$1:$S$7" },
  { Name: "_xlnm.Print_Titles", Sheet: 1, Ref: "'미출고현황'!$1:$1" },
]);

const inventorySheet = formatWorkbook.Sheets["창고별 재고"];
assert.deepEqual(
  Array.from(
    XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: true, range: "A1:P1" })[0],
  ),
  [...INVENTORY_HEADERS, "구매", "거래처(단가)"],
);
for (let row = 2; row <= 6; row += 1) {
  assert.equal(inventorySheet[`O${row}`].v, "", "purchase column must default to blank text");
}
assert.equal(inventorySheet["B2"].t, "s");
assert.equal(inventorySheet["B2"].v, "PURCHASE");
assert.equal(inventorySheet["F2"].v, -4);
assert.equal(inventorySheet["K2"].v, -4);
assert.equal(inventorySheet["F2"].s.fill.fgColor.rgb, "FFF200");
assert.equal(inventorySheet["K2"].s.fill.fgColor.rgb, "FFF200");
for (const address of ["A2", "B2", "C2", "D2", "E2", "G2", "H2", "I2", "J2", "L2", "M2", "N2", "O2", "P2"]) {
  assert.equal(inventorySheet[address].s.fill.fgColor.rgb, "FFFFFF", `${address} must have no warehouse/manager fill`);
}
assert.equal(inventorySheet["B3"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["G3"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["B4"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["B2"].s.font.color.rgb, "1E293B");
const inventoryHeaderRow = Array.from(
  XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: true, range: 0 })[0],
);
assert.equal(inventoryHeaderRow.includes("2전송"), true, "all nonblank source inventory headers must be retained");
assert.equal(inventoryHeaderRow.at(-2), "구매", "purchase must follow all dynamic source inventory columns");
assert.equal(inventoryHeaderRow.at(-1), "거래처(단가)", "supplier pairs must remain the rightmost inventory column");
for (let row = 1; row <= 6; row += 1) {
  for (let column = 0; column < inventoryHeaderRow.length; column += 1) {
    const cell = inventorySheet[XLSX.utils.encode_cell({ r: row - 1, c: column })];
    assert.ok(cell, `inventory table cell missing at row=${row} column=${column + 1}`);
    assert.equal(cell.s.border.top.style, "thin");
    assert.equal(cell.s.border.top.color.rgb, "CBD5E1");
  }
}
const shadowInventorySheet = workbookTools.buildWorkbook(shadowWorkspace, XLSX).Sheets["창고별 재고"];
assert.equal(shadowInventorySheet["B3"].v, "000002");
assert.equal(shadowInventorySheet["B3"].t, "s", "inventory-only leading zero code must remain text");
assert.equal(shadowInventorySheet["O3"].v, "재고전용거래처");
assert.equal(workbookTools.buildWorkbook(shadowWorkspace, XLSX).Sheets["발주관리"]["A6"], undefined);

const validationSheet = formatWorkbook.Sheets["검증결과"];
formatWorkspace.validationResults.forEach((result, index) => {
  const cell = validationSheet[`B${index + 5}`];
  assert.equal(cell.v, result.result, `${result.item} cached validation result changed`);
  assert.equal(cell.f, undefined, "validation output must not reference the removed 상품별요약 sheet");
});
assert.equal(formatWorkbook.SheetNames.includes("상품별요약"), false);
for (const sheetName of formatWorkbook.SheetNames) {
  const sheet = formatWorkbook.Sheets[sheetName];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    const text = `${cell?.f || ""} ${cell?.v || ""}`;
    assert.doesNotMatch(text, /#REF!|#VALUE!|#DIV\/0!|#NAME\?|#N\/A/i, `${sheetName}!${address}`);
  }
}

const largeRows = Array.from({ length: 180 }, (_, index) => ({
  code: `ROW-${String(index + 1).padStart(3, "0")}`,
  quantity: 1,
  manager: `담당${index % 5}`,
  spec: index % 2 === 0 ? "BOX" : "EA",
}));
const largeOrders = parseOrders(buildOrderMatrix(largeRows));
const largeInventory = parseInventory(
  buildInventoryMatrix(
    largeRows.map((row) => ({ ...row, quantity: 2, whole: 2, seoul: 0, transfer: 0 })),
  ),
);
assert.equal(engine.validateInputs(largeOrders, largeInventory).canAnalyze, true);
const largeWorkspace = engine.analyze(largeOrders, largeInventory, {
  createdAt: "2026-08-03T00:00:00.000Z",
});
const largeWorkbook = workbookTools.buildWorkbook(largeWorkspace, XLSX);
assert.equal(largeWorkbook.Sheets["미출고현황"]["!printArea"], "A1:S181");
assert.equal(largeWorkbook.Sheets["미출고현황"]["!pageSetup"].fitToWidth, 1);
assert.equal(largeWorkbook.Sheets["미출고현황"]["!pageSetup"].fitToHeight, 0);
assert.ok(
  largeWorkbook.Workbook.Names.some(
    (name) => name.Name === "_xlnm.Print_Area" && name.Ref === "'미출고현황'!$A$1:$S$181",
  ),
);

const html = fs.readFileSync(path.join(ROOT, "orders.html"), "utf8");
for (const requiredText of [
  "Shipping Management",
  "주문현황 Excel",
  "창고별재고 Excel",
  "Excel 출력",
  "구매업로드 Excel",
  "통합 검색",
  "화면 인쇄",
  "현재 파일로 교체",
  "purchaseUploadNotice",
  "ONEAPPShippingManagementDB",
  "shipping-local-recovery/v1",
  "validRecoveryRecord",
  "workspace.sourceFingerprint === record.sourceFingerprint",
  "oneapp.shipping.recovery.pointer.v1",
  "oneapp.shipping.recovery.meta.v1",
  "oneapp.shipping.table-widths.v1",
  "shipping-table-widths/v1",
  "oneapp.shipping.hidden-columns.v1",
  "shipping-hidden-columns/v1",
  "열폭 저장",
  "열 표시/숨김",
  "현재 탭 모두 표시",
  "orderFulfillmentEngine.js",
  "orderFulfillmentWorkbook.js",
]) {
  assert.ok(html.includes(requiredText), `orders.html is missing: ${requiredText}`);
}

assert.match(
  html,
  /<a class="brand" href="dashboard\.html" aria-label="ONEAPP NEXUS 대시보드로 이동">/,
  "the complete ONEAPP NEXUS brand must be a keyboard-accessible dashboard link",
);
assert.doesNotMatch(
  html,
  /<a class="header-link"[^>]*href="dashboard\.html"/,
  "the former right-side dashboard button must be removed",
);
assert.match(
  html,
  /<button class="header-link" id="settingsButton"[^>]*aria-label="환경설정 열기"[^>]*aria-haspopup="dialog"[\s\S]*?aria-expanded="false" aria-controls="settingsModal">/,
  "the right-side settings button must expose its dialog contract",
);
assert.match(
  html,
  /id="settingsModal" role="dialog" aria-modal="true"[\s\S]*?aria-labelledby="settingsModalTitle" aria-describedby="settingsModalDescription" aria-hidden="true"/,
  "the settings modal must expose an accessible title, description, and modal state",
);
assert.match(html, /Shipping Management v3\.3\.0/, "Shipping UI version must be 3.3.0");

for (const id of [
  "cloudUrlInput",
  "cloudTokenInput",
  "cloudSavedByInput",
  "cloudListButton",
  "cloudSaveButton",
  "cloudRevisionSelect",
  "cloudLoadButton",
  "localResetButton",
]) {
  assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} must exist exactly once inside the settings modal`);
}
const settingsModalMarkup = html.slice(
  html.indexOf('<div class="settings-modal hidden"'),
  html.indexOf('<div class="toast hidden"'),
);
for (const id of [
  "cloudUrlInput",
  "cloudTokenInput",
  "cloudSavedByInput",
  "cloudListButton",
  "cloudSaveButton",
  "cloudRevisionSelect",
  "cloudLoadButton",
  "localResetButton",
]) {
  assert.ok(settingsModalMarkup.includes(`id="${id}"`), `${id} must be located inside the settings modal`);
}

const settingsBehaviorSource = html.slice(
  html.indexOf("function settingsFocusableElements"),
  html.indexOf("async function sha256Hex"),
);
assert.match(settingsBehaviorSource, /classList\.remove\("hidden"\)/, "settings open must reveal the modal");
assert.match(settingsBehaviorSource, /setAttribute\("aria-expanded", "true"\)/, "settings open must update aria-expanded");
assert.match(settingsBehaviorSource, /cloudUrlInput\.focus\(\{ preventScroll: true \}\)/, "settings open must focus the first form control");
assert.match(settingsBehaviorSource, /classList\.add\("settings-modal-open"\)/, "settings open must lock background scrolling");
assert.match(settingsBehaviorSource, /event\.key === "Escape"[\s\S]*?closeSettingsModal\(\)/, "Escape must close settings");
assert.match(settingsBehaviorSource, /event\.key !== "Tab"[\s\S]*?focusable\[0\][\s\S]*?focusable\[focusable\.length - 1\]/, "Tab focus must be trapped inside settings");
assert.match(settingsBehaviorSource, /settingsButton\.focus\(\{ preventScroll: true \}\)/, "closing settings must return focus to its button");
assert.match(
  settingsBehaviorSource,
  /const confirmed = window\.confirm\([\s\S]*?if \(!confirmed\) return;[\s\S]*?clearLocalRecovery\(\)/,
  "cancelling local reset must return before clearLocalRecovery",
);
assert.match(
  html,
  /settingsModal\.addEventListener\("click", \(event\) => \{[\s\S]*?event\.target === elements\.settingsModal[\s\S]*?closeSettingsModal\(\)/,
  "clicking the modal backdrop must close settings",
);
assert.match(html, /settingsCloseButton\.addEventListener\("click", closeSettingsModal\)/, "the close button must close settings");
assert.match(html, /cloudListButton\.addEventListener\("click", listCloudPlans\)/, "Cloud list wiring changed");
assert.match(html, /cloudSaveButton\.addEventListener\("click", saveCloudPlan\)/, "Cloud save wiring changed");
assert.match(html, /cloudLoadButton\.addEventListener\("click", loadCloudPlan\)/, "Cloud load wiring changed");
assert.match(
  html,
  /localResetButton\.addEventListener\("click", \(\) => \{[\s\S]*?confirmAndClearLocalRecovery\(\)/,
  "local reset must use the explicit confirmation path",
);

const previewDefinitionsSource = html.slice(
  html.indexOf("function getPreviewDefinitions"),
  html.indexOf("function statusTone"),
);
const inventoryPreviewStart = previewDefinitionsSource.indexOf("inventory: {");
const allocationPreviewStart = previewDefinitionsSource.indexOf("allocations: {");
const validationPreviewStart = previewDefinitionsSource.indexOf("validation: {");
const inventoryPreviewSource = previewDefinitionsSource.slice(inventoryPreviewStart, allocationPreviewStart);
const allocationPreviewSource = previewDefinitionsSource.slice(allocationPreviewStart, validationPreviewStart);
assert.ok(inventoryPreviewStart >= 0 && allocationPreviewStart > inventoryPreviewStart && validationPreviewStart > allocationPreviewStart,
  "preview object boundaries must be found without depending on nested object braces");
assert.doesNotMatch(previewDefinitionsSource, /purchases:\s*\{/, "발주관리 screen tab must be removed");
assert.ok(previewDefinitionsSource.indexOf("inventory:") < previewDefinitionsSource.indexOf("allocations:"), "inventory must be the first screen tab");
assert.match(allocationPreviewSource, /purchaseEditable:\s*false/, "미출고현황 purchase must be readonly");
assert.match(inventoryPreviewSource, /purchaseEditable:\s*true/, "창고별 재고 purchase must be editable");
assert.match(previewDefinitionsSource, /const allocationHeaders = \[[\s\S]*?"거래처", "단가", "공급가액"/, "미출고현황 web must split customer, price, and supply amount");
assert.match(allocationPreviewSource, /row\.customer[\s\S]*?row\.unitPrice[\s\S]*?row\.supplyAmount/, "미출고현황 web must preserve original customer, numeric price, and independent supply amount");
assert.match(previewDefinitionsSource, /engine\.getInventoryViewRows/, "창고별 재고 must derive the complete inventory view");
assert.match(previewDefinitionsSource, /engine\.getAllocationInventoryView/, "미출고현황 must derive all dynamic warehouse values");
assert.match(
  html,
  /const editablePurchase = editable && preview\.purchaseEditable === true && column\.role === "purchase";/,
  "only a preview explicitly marked purchaseEditable may render purchase inputs",
);
assert.match(
  html,
  /function commitGridInput\(input\)[\s\S]*?engine\.setPurchaseValue\(state\.workspace, input\.dataset\.purchaseCode, input\.value\);/,
  "purchase edits must stay on the inventory grid and update the internal purchase contract",
);
assert.match(html, /addEventListener\("change"[\s\S]*?state\.activePreview !== "inventory"/, "purchase and inventory edit events must be scoped to the inventory grid");
assert.match(html, /engine\.setInventoryOverride\([\s\S]*?input\.dataset\.inventoryColumn/, "inventory edits must use validated optional overrides");
assert.match(html, /event\.key === "Tab"[\s\S]*?focusAdjacentNegativeInventory/, "table Tab must navigate negative review rows");
assert.match(html, /event\.key === "Enter"[\s\S]*?event\.shiftKey \? -1 : 1/, "Enter and Shift+Enter must move vertically");
assert.match(html, /ArrowUp:[\s\S]*?ArrowDown:[\s\S]*?ArrowLeft:[\s\S]*?ArrowRight:/, "arrow keys must move across inventory cells");
assert.match(html, /event\.key === "Escape"[\s\S]*?input\.dataset\.originalValue/, "Escape must restore the uncommitted cell value");
assert.match(html, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/, "grid focus movement must auto-scroll");
assert.match(html, /input\.select\(\)/, "negative review navigation must select the purchase value");
assert.match(html, /inventoryNegativeCount/, "the screen must show the negative inventory count");
assert.match(
  html,
  /const reviewIsVisibleNegative = pairs\.some\(\(\{ sourceRow \}\) =>[\s\S]*?sourceRow\.productCode === state\.inventoryReviewCode && Number\(sourceRow\.inventoryTotal\) < 0[\s\S]*?if \(!reviewIsVisibleNegative\) state\.inventoryReviewCode = "";/,
  "the current inventory review highlight must clear when the row is filtered out or becomes non-negative",
);
assert.match(html, /workspace: state\.workspace/, "Cloud revisions must include the additive override workspace");
assert.match(html, /workspace: state\.workspace[\s\S]*?ui: \{ activePreview: state\.activePreview \}/, "local recovery must include the additive override workspace");
for (const id of ["tableSearchInput", "specFilterGroup", "printButton", "printArea", "systemBasisDate", "systemFileState", "systemMatchState", "systemViewState", "columnVisibilityTools", "columnVisibilityList", "showAllColumnsButton", "columnWidthSaveButton", "columnWidthResetButton"]) {
  assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} must exist exactly once`);
}
assert.match(html, /<div class="validation-box hidden" id="validationBox"/, "initial duplicate validation guidance must stay hidden in the compact System.IO layout");
assert.match(html, /state\.specificationFilters\.size === 0 \|\| state\.specificationFilters\.has\(specification\)/, "unit filters must be exact OR matches");
assert.match(html, /const queryMatches = !query \|\| previewSearchCorpus\(sourceRow, row\)\.includes\(query\)/, "search and unit filters must combine without mutating workspace");
assert.match(html, /@page \{ size: A4 portrait; margin: 9mm; \}/, "screen print must use A4 portrait");
assert.match(html, /body\.printing-table \* \{ visibility: hidden !important; \}/, "print must hide non-table UI");
assert.match(html, /thead \{ display: table-header-group; \}/, "print headers must repeat");
assert.match(html, /function printActiveTable\([\s\S]*?filteredPreviewPairs\(preview\)[\s\S]*?window\.print\(\)/, "print must use the current filtered active table");
assert.match(html, /const TABLE_WIDTHS_KEY = "oneapp\.shipping\.table-widths\.v1"/, "Shipping width preference key changed");
assert.match(html, /const TABLE_WIDTH_MIN = 24;[\s\S]*?const TABLE_WIDTH_MAX = 720;/, "column widths must support the approved compact range");
assert.match(html, /\.purchase-input,[\s\S]*?\.inventory-grid-input \{[\s\S]*?min-width: 0;[\s\S]*?border: 1px solid transparent;/, "editable cells must stay compact and borderless until focus");
assert.match(html, /\.overflow-shell\.is-overflowing::after \{[\s\S]*?content: "\.\.";/, "clipped table values must use the exact two-dot marker");
assert.match(html, /function refreshOverflowMarkers\(\)[\s\S]*?scrollWidth > probe\.clientWidth[\s\S]*?scrollHeight > probe\.clientHeight/, "two-dot markers must appear only after real overflow measurement");
assert.match(html, /const managedTableWidth = useColumnWidths[\s\S]*?columns\.reduce\(\(sum, column\) => sum \+ currentColumnWidth[\s\S]*?style="width:\$\{managedTableWidth\}px;min-width:\$\{managedTableWidth\}px"/, "managed tables must use the exact sum of visible compact column widths");
assert.match(html, /role="separator"[\s\S]*?aria-orientation="vertical"[\s\S]*?aria-valuemin=/, "resize handles must expose the separator ARIA contract");
assert.match(html, /\["ArrowLeft", "ArrowRight"\][\s\S]*?event\.shiftKey \? 24 : 8/, "resize handles must support small and shifted keyboard steps");
assert.match(html, /addEventListener\("pointerdown", beginColumnResize\)/, "pointer resize wiring is missing");
assert.match(html, /pointerup[\s\S]*?pointercancel[\s\S]*?window\.addEventListener\("blur", finishColumnResize\)/, "pointer resize cleanup boundaries are missing");
assert.match(html, /removeEventListener\("pointermove", handleColumnPointerMove\)[\s\S]*?classList\.remove\("shipping-column-resizing"\)/, "pointer resize listeners and cursor must be cleaned up");
assert.match(html, /function resetActiveColumnWidths\([\s\S]*?columnWidthDrafts\[state\.activePreview\] = Object\.create\(null\)[\s\S]*?columnWidthDirtyTabs\.add/, "reset must create an unsaved dirty default draft");
assert.doesNotMatch(
  html.slice(html.indexOf("function resetActiveColumnWidths"), html.indexOf("function showToast")),
  /localStorage\.(?:removeItem|setItem)/,
  "reset must not overwrite the last saved preference until explicit save",
);
assert.match(html, /function loadColumnWidthSettings\([\s\S]*?isPlainRecord\(parsed\.tabs\)[\s\S]*?isSafeColumnKey\(columnKey\)/, "stored width payload must validate schema, tabs, and safe keys");
assert.match(html, /const payload = \{ schemaVersion: TABLE_WIDTHS_SCHEMA, tabs: serializableTabs \}/, "saved width payload must contain only schemaVersion and tabs");
assert.match(html, /const useColumnWidths = editable === true;/, "screen-only width application boundary changed");
assert.match(html, /renderTableMarkup\(preview, pairs, false\)/, "print markup must omit saved and draft pixel widths");

const widthLoaderSource = html.slice(
  html.indexOf("function isPlainRecord"),
  html.indexOf("function defaultColumnWidth"),
);
const storedWidthPayload = JSON.stringify({
  schemaVersion: "shipping-table-widths/v1",
  tabs: {
    inventory: {
      "inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0": 144,
      "inventory:8:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0": 216,
      "shipping:inventory:purchase": 900,
      "inventory:9:__proto__": 120,
      constructor: 120,
    },
    unknown: { "shipping:unknown:0": 100 },
  },
  unexpected: "ignored",
});
const widthLoaderContext = vm.createContext({
  Object,
  Array,
  JSON,
  String,
  Number,
  Set,
  Math,
  TABLE_WIDTHS_KEY: "oneapp.shipping.table-widths.v1",
  TABLE_WIDTHS_SCHEMA: "shipping-table-widths/v1",
  HIDDEN_COLUMNS_KEY: "oneapp.shipping.hidden-columns.v1",
  HIDDEN_COLUMNS_SCHEMA: "shipping-hidden-columns/v1",
  TABLE_WIDTH_MIN: 24,
  TABLE_WIDTH_MAX: 720,
  TABLE_WIDTH_TABS: new Set(["inventory", "allocations", "validation"]),
  localStorage: { getItem: () => storedWidthPayload },
});
vm.runInContext(`${widthLoaderSource}; globalThis.loadedWidths = loadColumnWidthSettings();`, widthLoaderContext);
assert.deepEqual(JSON.parse(JSON.stringify(widthLoaderContext.loadedWidths)), {
  schemaVersion: "shipping-table-widths/v1",
  tabs: {
    inventory: {
      "inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0": 144,
      "inventory:8:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0": 216,
    },
  },
}, "duplicate-label widths must remain isolated while unsafe and out-of-range values fall back");
widthLoaderContext.localStorage.getItem = () => "{broken";
vm.runInContext("globalThis.fallbackWidths = loadColumnWidthSettings();", widthLoaderContext);
assert.deepEqual(JSON.parse(JSON.stringify(widthLoaderContext.fallbackWidths)), {
  schemaVersion: "shipping-table-widths/v1",
  tabs: {},
}, "corrupt local width JSON must fall back without throwing");

const storedHiddenPayload = JSON.stringify({
  schemaVersion: "shipping-hidden-columns/v1",
  tabs: {
    inventory: [
      "inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0",
      "inventory:8:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0",
      "inventory:9:__proto__",
      "inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0",
    ],
    allocations: ["shipping:allocations:inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0"],
    unknown: ["shipping:unknown:column"],
  },
  workspace: { forbidden: true },
});
widthLoaderContext.localStorage.getItem = (key) => key === "oneapp.shipping.hidden-columns.v1" ? storedHiddenPayload : null;
vm.runInContext("globalThis.loadedHidden = loadHiddenColumnSettings();", widthLoaderContext);
assert.deepEqual(JSON.parse(JSON.stringify(widthLoaderContext.loadedHidden)), {
  schemaVersion: "shipping-hidden-columns/v1",
  tabs: {
    inventory: [
      "inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0",
      "inventory:8:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0",
    ],
    allocations: ["shipping:allocations:inventory:7:%EC%8B%A0%EA%B7%9C%EC%B0%BD%EA%B3%A0"],
  },
}, "hidden-column state must keep duplicate source labels isolated and reject unsafe or unknown data");
widthLoaderContext.localStorage.getItem = () => "{broken";
vm.runInContext("globalThis.fallbackHidden = loadHiddenColumnSettings();", widthLoaderContext);
assert.deepEqual(JSON.parse(JSON.stringify(widthLoaderContext.fallbackHidden)), {
  schemaVersion: "shipping-hidden-columns/v1",
  tabs: {},
}, "corrupt hidden-column JSON must fall back without throwing");

assert.match(html, /const HIDDEN_COLUMNS_KEY = "oneapp\.shipping\.hidden-columns\.v1"/, "hidden-column preference key changed");
assert.match(html, /function loadHiddenColumnSettings\(\)[\s\S]*?Array\.isArray\(keys\)[\s\S]*?isSafeColumnKey\(key\)/, "hidden-column payload must validate tab arrays and safe stable keys");
assert.match(html, /allocationInventory\.columns\.map\(\(column\) => `shipping:allocations:\$\{column\.key\}`\)/, "allocation warehouse visibility keys must preserve inventory sourceIndex identity");
assert.match(html, /function visiblePreviewColumns[\s\S]*?!hidden\.has\(columnVisibilityKey\(column\)\)/, "new columns absent from the hidden-key set must default to visible");
assert.match(html, /column\?\.role === "calculatedQuantity"[\s\S]*?column\?\.role === "purchase"/, "inventory quantity and purchase columns must be protected");
assert.match(html, /visiblePreviewColumns\(preview\)\.length <= 1[\s\S]*?최소 한 열을 표시/, "the last visible column must not be hidden");
assert.match(html, /function moveInventoryGridFocus[\s\S]*?visiblePreviewColumns\(preview, "inventory"\)[\s\S]*?visibleColumns\.length - 1/, "arrow and Enter navigation must use visible columns");
assert.match(html, /function focusAdjacentNegativeInventory[\s\S]*?findIndex\(\(column\) => column\.role === "purchase"\)/, "negative Tab navigation must target the visible protected purchase column");
assert.doesNotMatch(
  html.slice(html.indexOf("async function persistLocalWorkspace"), html.indexOf("function scheduleLocalSave")),
  /hiddenColumnSettings|HIDDEN_COLUMNS_KEY/,
  "hidden-column preferences must not enter IndexedDB recovery records",
);
assert.doesNotMatch(
  html.slice(html.indexOf("async function buildCloudEnvelope"), html.indexOf("async function postCloudAction")),
  /hiddenColumnSettings|HIDDEN_COLUMNS_KEY/,
  "hidden-column preferences must not enter Cloud payloads",
);
assert.doesNotMatch(
  html.slice(html.indexOf("function setActiveColumnVisible"), html.indexOf("function renderColumnVisibilityControls")),
  /scheduleLocalSave|state\.workspace\s*=/,
  "visibility changes must stay outside workspace autosave",
);
assert.doesNotMatch(
  fs.readFileSync(path.join(ROOT, "orderFulfillmentWorkbook.js"), "utf8"),
  /hidden-columns|hiddenColumnSettings/,
  "hidden-column preferences must not alter general or purchase-upload workbooks",
);

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
let inventoryReferenceWorkspace = null;
if (fs.existsSync(referenceInventoryPath)) {
  const inventoryInput = readFileMatrices(referenceInventoryPath, "재고현황");
  const referenceInventoryOnly = engine.parseInventoryWorkbook({
    fileName: path.basename(referenceInventoryPath),
    ...inventoryInput,
  });
  assert.equal(referenceInventoryOnly.errors.length, 0, JSON.stringify(referenceInventoryOnly.errors, null, 2));
  assert.ok(referenceInventoryOnly.rowCount >= 300, "real inventory workbook must expose the full operational list");
  const firstInventoryCode = referenceInventoryOnly.rows[0].productCode;
  const referenceSingleOrder = parseOrders(buildOrderMatrix([
    { code: firstInventoryCode, quantity: 1, date: "2026-08-04-1", spec: referenceInventoryOnly.rows[0].specification || "BOX" },
  ]));
  inventoryReferenceWorkspace = engine.analyze(referenceSingleOrder, referenceInventoryOnly, {
    createdAt: "2026-08-04T00:00:00.000Z",
    sourceFingerprint: "d".repeat(64),
  });
  const actualInventoryView = engine.getInventoryViewRows(inventoryReferenceWorkspace);
  assert.equal(actualInventoryView.rows.length, referenceInventoryOnly.rowCount);
  const inventoryOnlyCode = referenceInventoryOnly.rows.at(-1).productCode;
  engine.setPurchaseValue(inventoryReferenceWorkspace, inventoryOnlyCode, "실재고입력검증");
  assert.equal(engine.getPurchaseUploadSelection(inventoryReferenceWorkspace).included.some((row) => row.productCode === inventoryOnlyCode), false);
  const actualInventorySheet = workbookTools.buildWorkbook(inventoryReferenceWorkspace, XLSX).Sheets["창고별 재고"];
  const actualPurchaseColumn = XLSX.utils.encode_col(actualInventoryView.headers.length);
  const actualSupplierColumn = XLSX.utils.encode_col(actualInventoryView.headers.length + 1);
  assert.equal(actualInventorySheet["!ref"], `A1:${actualSupplierColumn}${referenceInventoryOnly.rowCount + 1}`);
  assert.equal(actualInventorySheet[`${actualPurchaseColumn}${referenceInventoryOnly.rowCount + 1}`].v, "실재고입력검증");
}
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
  assert.ok(referenceInventory.rowCount >= 300, "reference inventory must expose the complete operational list");
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
  assert.equal(
    engine.getInventoryViewRows(referenceWorkspace).rows.length,
    referenceInventory.rowCount,
    "full inventory view row count must equal the parsed source data row count",
  );
}

const outputWorkspace = referenceWorkspace || inventoryReferenceWorkspace || formatWorkspace;
const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-shipping-management-"));
try {
  const outputPath = path.join(tempDir, "미출고현황_테스트.xlsx");
  const purchaseOutputPath = path.join(tempDir, "구매업로드_20260804.xlsx");
  const dynamicOutputPath = path.join(tempDir, "동적창고열_테스트.xlsx");
  const outputWorkbook = workbookTools.buildWorkbook(outputWorkspace, XLSX);
  const outputBytes = workbookTools.writeWorkbook(outputWorkbook, XLSX);
  fs.writeFileSync(outputPath, Buffer.from(new Uint8Array(outputBytes)));
  const purchaseOutputBytes = workbookTools.writeStandardWorkbook(purchaseUploadWorkbook, XLSX);
  fs.writeFileSync(purchaseOutputPath, Buffer.from(new Uint8Array(purchaseOutputBytes)));
  const dynamicOutputBytes = workbookTools.writeWorkbook(dynamicWorkbook, XLSX);
  fs.writeFileSync(dynamicOutputPath, Buffer.from(new Uint8Array(dynamicOutputBytes)));
  assert.ok(fs.statSync(outputPath).size > 10000, "generated workbook is unexpectedly small");
  const packageText = Buffer.from(outputBytes).toString("utf8");
  assert.match(packageText, /<pageSetUpPr fitToPage="1"\/>/);
  assert.match(
    packageText,
    /<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"\/>/,
  );
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
  if (process.env.SHIPPING_PURCHASE_TEST_OUTPUT) {
    const requestedPurchaseOutput = path.resolve(ROOT, process.env.SHIPPING_PURCHASE_TEST_OUTPUT);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    assert.ok(
      requestedPurchaseOutput.startsWith(rootPrefix),
      `SHIPPING_PURCHASE_TEST_OUTPUT must remain inside the repository: ${requestedPurchaseOutput}`,
    );
    fs.mkdirSync(path.dirname(requestedPurchaseOutput), { recursive: true });
    fs.copyFileSync(purchaseOutputPath, requestedPurchaseOutput);
  }
  if (process.env.SHIPPING_DYNAMIC_TEST_OUTPUT) {
    const requestedDynamicOutput = path.resolve(ROOT, process.env.SHIPPING_DYNAMIC_TEST_OUTPUT);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
    assert.ok(
      requestedDynamicOutput.startsWith(rootPrefix),
      `SHIPPING_DYNAMIC_TEST_OUTPUT must remain inside the repository: ${requestedDynamicOutput}`,
    );
    fs.mkdirSync(path.dirname(requestedDynamicOutput), { recursive: true });
    fs.copyFileSync(dynamicOutputPath, requestedDynamicOutput);
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
    reopened.Sheets["미출고현황"]["A2"].t,
    "s",
    "product code must reopen as text",
  );
  assert.deepEqual(
    Array.from(
      XLSX.utils.sheet_to_json(reopened.Sheets["미출고현황"], { header: 1, raw: true, range: 0 })[0],
    ),
    [
      "상품코드", "품목명", "규격",
      ...engine.getAllocationInventoryView(outputWorkspace).columns.map((column) => column.header),
      "주문수량", "전재고", "서울잔량", "구매수량", "구매", "거래처", "단가", "공급가액", "적요", "적요1", "담당자",
    ],
  );
  const reopenedPrintNames = (reopened.Workbook?.Names || []).filter(
    (name) => name.Sheet === 1 && /^_xlnm\.Print_/.test(name.Name),
  );
  assert.equal(reopenedPrintNames.length, 2, "print area and print titles must reopen");
  assert.deepEqual({ ...reopened.Sheets["미출고현황"]["!margins"] }, {
    left: 0.25,
    right: 0.25,
    top: 0.75,
    bottom: 0.75,
    header: 0.3,
    footer: 0.3,
  });
  const reopenedDynamic = XLSX.read(fs.readFileSync(dynamicOutputPath), {
    type: "buffer",
    cellStyles: true,
    cellText: true,
  });
  assert.deepEqual(
    Array.from(XLSX.utils.sheet_to_json(reopenedDynamic.Sheets["창고별 재고"], { header: 1, raw: true, range: "A1:L1" })[0]),
    [...dynamicView.headers, "구매", "거래처(단가)"],
  );
  assert.deepEqual(
    [reopenedDynamic.Sheets["창고별 재고"].H2.t, reopenedDynamic.Sheets["창고별 재고"].H2.v],
    ["n", -130],
  );
  assert.deepEqual(
    [reopenedDynamic.Sheets["창고별 재고"].I2.t, reopenedDynamic.Sheets["창고별 재고"].I2.v],
    ["s", "00123"],
  );
  assert.ok(reopenedDynamic.Sheets["창고별 재고"].H2.s, "negative dynamic inventory cell style must reopen");
  assert.ok(reopenedDynamic.Sheets["창고별 재고"].A2.s, "EA row font style must reopen");
  const reopenedPurchase = XLSX.read(fs.readFileSync(purchaseOutputPath), {
    type: "buffer",
    cellStyles: true,
    cellText: true,
  });
  assert.deepEqual(Array.from(reopenedPurchase.SheetNames), ["구매입력"]);
  assert.equal(reopenedPurchase.Sheets["구매입력"].A2.t, "s");
  assert.equal(reopenedPurchase.Sheets["구매입력"].A2.v, "20260804");
  assert.equal(reopenedPurchase.Sheets["구매입력"].E2.t, "s");
  assert.equal(reopenedPurchase.Sheets["구매입력"].E2.v, "01");
  assert.equal(reopenedPurchase.Sheets["구매입력"].F2.v, "");
  assert.equal(reopenedPurchase.Sheets["구매입력"].I2.t, "s");
  assert.equal(reopenedPurchase.Sheets["구매입력"].L2.t, "n");
  assert.equal(reopenedPurchase.Sheets["구매입력"].M2.t, "n");
  assert.equal(reopenedPurchase.Sheets["구매입력"].M2.v, 0);
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedPrefix = path.resolve(ROOT, ".tmp-shipping-management-");
  assert.ok(
    resolvedTempDir.startsWith(allowedPrefix),
    `refusing to remove unexpected temp directory: ${resolvedTempDir}`,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (purchaseTemplateBaseline) {
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(PURCHASE_TEMPLATE_PATH)).digest("hex"),
    purchaseTemplateBaseline.hash,
    "original purchase upload template hash must remain unchanged",
  );
  assert.equal(
    fs.statSync(PURCHASE_TEMPLATE_PATH).mtimeMs,
    purchaseTemplateBaseline.mtimeMs,
    "original purchase upload template mtime must remain unchanged",
  );
}

if (process.env.SHIPPING_BROWSER_FIXTURE_DIR) {
  const fixtureDir = path.resolve(ROOT, process.env.SHIPPING_BROWSER_FIXTURE_DIR);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  assert.ok(fixtureDir.startsWith(rootPrefix), `SHIPPING_BROWSER_FIXTURE_DIR must remain inside the repository: ${fixtureDir}`);
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const [fileName, sheetName, matrix] of [
    ["주문현황_브라우저.xlsx", "미판매현황", edgeOrders.sourceMatrix],
    ["창고별재고_브라우저.xlsx", "재고현황", edgeInventory.sourceMatrix],
    ["주문현황_동적창고열_브라우저.xlsx", "미판매현황", dynamicOrders.sourceMatrix],
    ["창고별재고_동적창고열_브라우저.xlsx", "재고현황", dynamicInventoryMatrix],
  ]) {
    const fixtureWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(fixtureWorkbook, XLSX.utils.aoa_to_sheet(matrix), sheetName);
    const fixtureBytes = XLSX.write(fixtureWorkbook, { type: "array", bookType: "xlsx", compression: true });
    fs.writeFileSync(path.join(fixtureDir, fileName), Buffer.from(new Uint8Array(fixtureBytes)));
  }
}

console.log(
  referenceWorkspace
    ? `Shipping Management tests passed, including the real ${referenceWorkspace.stats.orderRowCount}-order/${referenceWorkspace.stats.inventoryRowCount}-inventory reference files.`
    : inventoryReferenceWorkspace
      ? `Shipping Management tests passed, including the real ${inventoryReferenceWorkspace.stats.inventoryRowCount}-inventory reference file.`
      : "Shipping Management tests passed. Real reference files were not present and were skipped.",
);
