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
assert.deepEqual(Array.from(workbookTools.REQUIRED_SHEETS), [
  "창고별 재고",
  "미출고현황",
  "상품별요약",
  "발주관리",
  "적요이슈",
  "검증결과",
  "주문원본",
]);
assert.deepEqual(
  Array.from(
    XLSX.utils.sheet_to_json(edgeWorkbook.Sheets["미출고현황"], {
      header: 1,
      raw: true,
      range: "A1:L1",
    })[0],
  ),
  ["상품코드", "품목명", "규격", "단가", "수량", "재고", "서울", "전송", "적요", "거래처", "그룹", "출고"],
);
assert.equal(edgeWorkbook.Sheets["미출고현황"]["A2"].t, "s");
assert.equal(edgeWorkbook.Sheets["미출고현황"]["A2"].v, "000100");
assert.equal(edgeWorkbook.Sheets["미출고현황"]["D2"].v, 1000);
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
  assert.equal(downloadedWorkbook.SheetNames[0], "창고별 재고");
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
const stringZeroWorkspace = {
  ...formatWorkspace,
  allocations: formatWorkspace.allocations.map((row, index) =>
    index === 0
      ? {
          ...row,
          wholeStockRaw: "0",
          seoulFirstPurchaseRaw: "0",
          firstTransferRaw: "0",
        }
      : row,
  ),
};
const stringZeroSheet = workbookTools.buildWorkbook(stringZeroWorkspace, XLSX).Sheets[
  "미출고현황"
];
for (const address of ["F2", "G2", "H2"]) {
  assert.equal(stringZeroSheet[address].v, "", `${address} string zero must display blank`);
}

const allocationSheet = formatWorkbook.Sheets["미출고현황"];
assert.equal(allocationSheet["!ref"], "A1:L7");
assert.deepEqual(allocationSheet["!autofilter"], { ref: "A1:L7" });
assert.deepEqual(allocationSheet["!freeze"], { xSplit: 0, ySplit: 1 });
assert.equal(allocationSheet["A2"].t, "s");
assert.equal(allocationSheet["A2"].v, "PURCHASE");
assert.equal(allocationSheet["D2"].v, 1000);
for (const address of ["F2", "G2", "H2"]) {
  assert.equal(allocationSheet[address].v, "", `${address} zero inventory must display blank`);
}
assert.deepEqual(
  ["L2", "L3", "L4", "L5", "L6", "L7"].map((address) => allocationSheet[address].v),
  ["구매", "추가", "서울", "재고", "혼합출고", "재고정보 없음"],
);
assert.equal(allocationSheet["A2"].s.fill.fgColor.rgb, allocationSheet["A4"].s.fill.fgColor.rgb);
assert.notEqual(allocationSheet["A2"].s.fill.fgColor.rgb, allocationSheet["A3"].s.fill.fgColor.rgb);
for (const address of ["A2", "B2", "C2", "D2", "E2", "I2", "J2", "K2"]) {
  assert.equal(
    allocationSheet[address].s.fill.fgColor.rgb,
    allocationSheet["A2"].s.fill.fgColor.rgb,
    `${address} must inherit the manager row fill`,
  );
}
assert.equal(
  allocationSheet["F2"].s.fill.fgColor.rgb,
  allocationSheet["A2"].s.fill.fgColor.rgb,
  "blank stock quantity must retain the manager row fill",
);
assert.equal(allocationSheet["F3"].s.fill.fgColor.rgb, "DCFCE7");
assert.equal(allocationSheet["G4"].s.fill.fgColor.rgb, "DBEAFE");
assert.equal(allocationSheet["H4"].s.fill.fgColor.rgb, "F3E8FF");
assert.equal(allocationSheet["L2"].s.fill.fgColor.rgb, "FEE2E2");
assert.equal(allocationSheet["L3"].s.fill.fgColor.rgb, "FEF3C7");
assert.equal(allocationSheet["L4"].s.fill.fgColor.rgb, "DBEAFE");
assert.equal(allocationSheet["L5"].s.fill.fgColor.rgb, "DCFCE7");
assert.equal(allocationSheet["L7"].s.fill.fgColor.rgb, "FEE2E2");
for (let row = 1; row <= 7; row += 1) {
  for (let column = 0; column < 12; column += 1) {
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
assert.equal(allocationSheet["!printArea"], "A1:L7");
assert.equal(allocationSheet["!printTitles"], "$1:$1");
const printNames = formatWorkbook.Workbook.Names.filter(
  (name) => name.Sheet === 1 && /^_xlnm\.Print_/.test(name.Name),
);
assert.deepEqual(printNames, [
  { Name: "_xlnm.Print_Area", Sheet: 1, Ref: "'미출고현황'!$A$1:$L$7" },
  { Name: "_xlnm.Print_Titles", Sheet: 1, Ref: "'미출고현황'!$1:$1" },
]);

const inventorySheet = formatWorkbook.Sheets["창고별 재고"];
assert.deepEqual(
  Array.from(
    XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: true, range: "A1:I1" })[0],
  ),
  ["품목코드", "품목명", "규격", "구매", "수량", "1창고", "3서울", "4전송", "7진영"],
);
for (let row = 2; row <= 6; row += 1) {
  assert.equal(inventorySheet[`D${row}`].v, "", "purchase column must default to blank text");
}
assert.equal(inventorySheet["A2"].t, "s");
assert.equal(inventorySheet["A2"].v, "PURCHASE");
assert.equal(inventorySheet["E2"].v, -4);
for (const address of ["A2", "B2", "C2", "D2", "E2"]) {
  assert.equal(inventorySheet[address].s.fill.fgColor.rgb, "FFF200");
}
assert.equal(inventorySheet["A3"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["E3"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["A4"].s.font.color.rgb, "B91C1C");
assert.equal(inventorySheet["A2"].s.font.color.rgb, "1E293B");
assert.equal(inventorySheet["F3"].s.fill.fgColor.rgb, "F1F5F9");
assert.equal(inventorySheet["G4"].s.fill.fgColor.rgb, "FFEDD5");
assert.equal(inventorySheet["H4"].s.fill.fgColor.rgb, "DBEAFE");
assert.equal(inventorySheet["I2"].s.fill.fgColor.rgb, "DCFCE7");
const inventoryHeaderRow = Array.from(
  XLSX.utils.sheet_to_json(inventorySheet, { header: 1, raw: true, range: 0 })[0],
);
const transfer2Column = inventoryHeaderRow.indexOf("2전송");
const otherWarehouseColumn = inventoryHeaderRow.indexOf("창고");
assert.ok(transfer2Column >= 9, "additional warehouse column must remain in output");
assert.ok(otherWarehouseColumn > transfer2Column, "remaining original columns must be preserved");
assert.notEqual(
  inventorySheet[XLSX.utils.encode_cell({ r: 2, c: transfer2Column })].s.fill.fgColor.rgb,
  "FFFFFF",
  "additional numbered warehouse column must receive deterministic fill",
);
assert.equal(
  inventorySheet[XLSX.utils.encode_cell({ r: 2, c: otherWarehouseColumn })].s.fill.fgColor.rgb,
  "FFFFFF",
  "non-quantity 창고 column must not receive warehouse fill",
);
for (let row = 1; row <= 6; row += 1) {
  for (let column = 0; column < inventoryHeaderRow.length; column += 1) {
    const cell = inventorySheet[XLSX.utils.encode_cell({ r: row - 1, c: column })];
    assert.ok(cell, `inventory table cell missing at row=${row} column=${column + 1}`);
    assert.equal(cell.s.border.top.style, "thin");
    assert.equal(cell.s.border.top.color.rgb, "CBD5E1");
  }
}

const validationSheet = formatWorkbook.Sheets["검증결과"];
assert.match(validationSheet["B8"].f, /'미출고현황'!\$E\$2:\$E\$7/);
assert.doesNotMatch(validationSheet["B8"].f, /\$G\$/);
assert.match(validationSheet["B9"].f, /'상품별요약'!\$D\$5:\$D\$10/);
assert.match(validationSheet["B9"].f, /'상품별요약'!\$I\$5:\$K\$10/);
assert.match(validationSheet["B11"].f, /'상품별요약'!\$K\$5:\$K\$10/);
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
assert.equal(largeWorkbook.Sheets["미출고현황"]["!printArea"], "A1:L181");
assert.equal(largeWorkbook.Sheets["미출고현황"]["!pageSetup"].fitToWidth, 1);
assert.equal(largeWorkbook.Sheets["미출고현황"]["!pageSetup"].fitToHeight, 0);
assert.ok(
  largeWorkbook.Workbook.Names.some(
    (name) => name.Name === "_xlnm.Print_Area" && name.Ref === "'미출고현황'!$A$1:$L$181",
  ),
);

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

const outputWorkspace = referenceWorkspace || formatWorkspace;
const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-shipping-management-"));
try {
  const outputPath = path.join(tempDir, "미출고현황_테스트.xlsx");
  const outputWorkbook = workbookTools.buildWorkbook(outputWorkspace, XLSX);
  const outputBytes = workbookTools.writeWorkbook(outputWorkbook, XLSX);
  fs.writeFileSync(outputPath, Buffer.from(new Uint8Array(outputBytes)));
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
      XLSX.utils.sheet_to_json(reopened.Sheets["미출고현황"], {
        header: 1,
        raw: true,
        range: "A1:L1",
      })[0],
    ),
    ["상품코드", "품목명", "규격", "단가", "수량", "재고", "서울", "전송", "적요", "거래처", "그룹", "출고"],
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
