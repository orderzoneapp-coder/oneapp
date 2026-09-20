import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// F05-F08 from the 2026-09-16 original-versus-current reproduction report.
// Real engine, HTML screen-model functions, recovery serialization, and bundled
// SheetJS CE XLSX bytes are exercised. This is not browser/IndexedDB/style QA.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const workbook = require(path.join(ROOT, "orderFulfillmentWorkbook.js"));
const XLSX = require(path.join(ROOT, "customer-master/vendor/xlsx.full.min.js"));
const html = fs.readFileSync(path.join(ROOT, "orderops_list.html"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const FINGERPRINT = "b".repeat(64);
const WHEN = "2026-09-16T09:00:00.000Z";
const ORDER_HEADERS = ["일자", "창고", "담당", "단위", "품목코드", "품목명", "규격", "수량", "단가", "공급가액", "적요", "적요1", "거래처", "그룹"];
const INVENTORY_HEADERS = ["품목코드", "품목명", "규격", "단위", "수량", "1창고", "3서울", "4전송"];

function parseOrders(rows) {
  const matrix = [ORDER_HEADERS, ...rows.map((row, index) => [
    "2026-09-16", "1창고", row.manager ?? `담당${index + 1}`, row.unit ?? "EA",
    row.code ?? "0001", row.name ?? "기본 상품", row.specification ?? "원본 규격",
    row.quantity, row.price ?? 1000, row.amount ?? "", row.note ?? "", "",
    row.customer ?? `거래처${index + 1}`, "기본",
  ])];
  return engine.parseOrderWorkbook({
    fileName: "합성주문.xlsx", sheetName: "주문", fileHash: "a".repeat(64),
    rawMatrix: matrix, displayMatrix: clone(matrix),
  });
}

function parseInventory(rows) {
  const matrix = [INVENTORY_HEADERS, ...rows.map((row) => [
    row.code ?? "0001", row.name ?? "기본 상품", row.specification ?? "원본 규격",
    row.unit ?? "EA", row.total ?? row.stock ?? 0, row.stock ?? 0, row.seoul ?? 0, row.transfer ?? 0,
  ])];
  return engine.parseInventoryWorkbook({
    fileName: "합성재고.xlsx", sheetName: "재고", fileHash: "c".repeat(64),
    rawMatrix: matrix, displayMatrix: clone(matrix),
  });
}

function makeWorkspace(orderRows = [{ quantity: 10 }], inventoryRows = [{ stock: 10 }], transactions = {}) {
  const orders = parseOrders(orderRows);
  const inventory = parseInventory(inventoryRows);
  assert.equal(orders.errors.length, 0, JSON.stringify(orders.errors));
  assert.equal(inventory.errors.length, 0, JSON.stringify(inventory.errors));
  const result = engine.analyze(orders, inventory, { sourceFingerprint: FINGERPRINT, createdAt: WHEN });
  result.orderOpsInputs = clone(transactions);
  return result;
}

function override(workspace, value) {
  const column = engine.getInventoryColumnDescriptors(workspace).find((entry) => entry.header === "1창고");
  assert.ok(column?.editable, "1창고 수량 편집 열이 있어야 합니다.");
  engine.setInventoryOverride(workspace, "0001", column.key, value);
  return column;
}

function restore(workspace) {
  const payload = engine.buildLocalRecoveryPayload(workspace, { activePreview: "allocations" }, {}, WHEN);
  const restored = JSON.parse(JSON.stringify(payload));
  assert.equal(restored.sourceFingerprint, FINGERPRINT);
  assert.equal(restored.workspaceSchemaVersion, workspace.schemaVersion);
  return restored.workspace;
}

function extractFunction(name) {
  const prefix = `      function ${name}(`;
  const begin = html.indexOf(prefix);
  assert.ok(begin >= 0, `화면 함수 ${name}를 찾을 수 없습니다.`);
  const tail = html.slice(begin + prefix.length);
  const end = tail.search(/\n      (?:async )?function /);
  assert.ok(end >= 0, `화면 함수 ${name}의 끝 경계를 찾을 수 없습니다.`);
  return html.slice(begin, begin + prefix.length + end);
}

const screenSource = [
  "isSafeColumnKey", "createPreviewColumns", "shortageCategoryCode", "inventoryRowState",
  "decorateShortageRow", "buildInventoryPreview", "blankZero", "formatDeliveryNotice",
  "buildTransactionPreview", "getPreviewDefinitions",
].map(extractFunction).join("\n");

function screen(workspace) {
  const context = vm.createContext({ engine, workspace, state: { workspace, warehouseFilters: new Set() } });
  vm.runInContext(screenSource, context, { filename: "orderops/list.html:screen-model" });
  return clone(vm.runInContext("getPreviewDefinitions(workspace)", context));
}

function parseTransactionSheet(kind, matrix, savedMappings = null) {
  const sourceBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(sourceBook, XLSX.utils.aoa_to_sheet(matrix), "거래");
  const inputBook = XLSX.read(XLSX.write(sourceBook, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
  const before = XLSX.utils.sheet_to_json(inputBook.Sheets["거래"], { header: 1, raw: true, defval: "" });
  const constantsStart = html.indexOf("      const FILE_KINDS =");
  const constantsEnd = html.indexOf("      const PASTEL_COLOR_PALETTE =", constantsStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, "거래 파일 매핑 상수를 찾을 수 없습니다.");
  const source = html.slice(constantsStart, constantsEnd) + [
    "splitAliases", "normalizeExcelMappingRecord", "normalizeMappingText", "parseGenericWorkbookSheet",
  ].map(extractFunction).join("\n");
  const context = vm.createContext({
    engine, window: { XLSX }, state: {}, savedMappings,
    input: { workbook: inputBook, fileName: "거래.xlsx", fileHash: FINGERPRINT, sheetName: "거래", kind },
  });
  vm.runInContext(source, context, { filename: "orderops/list.html:transaction-parser" });
  const parsed = clone(vm.runInContext("state.excelMappings = normalizeExcelMappingRecord(savedMappings); parseGenericWorkbookSheet(input)", context));
  assert.deepEqual(XLSX.utils.sheet_to_json(inputBook.Sheets["거래"], { header: 1, raw: true, defval: "" }), before,
    "거래 파서는 원본 워크북 셀을 변경하지 않아야 합니다.");
  return parsed;
}

function reopen(workspace) {
  const before = clone({ orders: workspace.orders, inventory: workspace.inventory, sourceFiles: workspace.sourceFiles, inputs: workspace.orderOpsInputs });
  const built = workbook.buildWorkbook(workspace, XLSX);
  const bytes = XLSX.write(built, { type: "buffer", bookType: "xlsx" });
  assert.ok(bytes.length > 0, "실제 XLSX 바이트를 생성해야 합니다.");
  const reopened = XLSX.read(bytes, { type: "buffer" });
  assert.deepEqual({ orders: workspace.orders, inventory: workspace.inventory, sourceFiles: workspace.sourceFiles, inputs: workspace.orderOpsInputs }, before,
    "출력은 원본 행·원본 행렬·구매/판매 입력을 변경하지 않아야 합니다.");
  return reopened;
}

function table(book, name, requiredHeader) {
  assert.ok(book.Sheets[name], `${name} 시트가 있어야 합니다.`);
  const matrix = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: "" });
  const headerIndex = matrix.findIndex((row) => row.includes(requiredHeader));
  assert.ok(headerIndex >= 0, `${name} 시트에서 ${requiredHeader} 머리글을 찾을 수 없습니다.`);
  const headers = matrix[headerIndex];
  return matrix.slice(headerIndex + 1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

const ledgerRows = (workspace) => {
  const view = engine.getStockLedgerView(workspace);
  return view.rows.map((row) => ({ source: row, cells: Object.fromEntries(view.headers.map((header, index) => [header, row.values[index]])) }));
};
const quantityUnavailable = (value) => value === null || value === undefined || value === "";
const unitExplanation = (value) => /단위|비교|미확인|혼합|BOX|EA|UNKNOWN|MISMATCH|MIXED/i.test(String(value));
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, pass: false });
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

test("control: same-unit allocation order, leading-zero code, and purchase quantity", () => {
  const workspace = makeWorkspace([{ quantity: 5 }, { quantity: 4, name: "다른 표시 상품명" }], [{ stock: 3, seoul: 5, transfer: -1, total: 7 }]);
  assert.deepEqual(workspace.orders.map((row) => row.productCode), ["0001", "0001"]);
  assert.deepEqual(workspace.allocations.map((row) => [row.wholeAllocation, row.seoulAllocation, row.purchaseNeed]), [[3, 2, 0], [0, 2, 2]]);
  assert.equal(engine.getPurchaseUploadSelection(workspace).included[0]?.purchaseNeed, 2);
  const preview = screen(workspace).allocations;
  assert.deepEqual(preview.sourceRows.map((row) => row.productAggregateQuantity), [9, ""]);
  const saved = restore(workspace);
  assert.deepEqual(saved.orders, workspace.orders);
  const book = reopen(saved);
  assert.deepEqual(table(book, "주문현황", "주문수량").map((row) => row["주문수량 합계"]), [9, 9]);
  assert.equal(table(book, "구매업로드", "수량")[0]["수량"], 2);
});

for (const [value, expected] of [["0", 0], ["-2", -2], ["0.5", 0.5], ["1,000", 1000], ["(2)", -2]]) {
  test(`control: numeric source ${value} remains ${expected}`, () => {
    assert.equal(engine.parseNumericCell(value).value, expected);
    const parsed = parseOrders([{ quantity: value }]);
    assert.equal(parsed.rows[0].quantity, expected);
    assert.equal(parsed.sourceMatrix[1][7], value);
  });
}

test("control: blank quantity remains blank source and blocks analysis", () => {
  const parsed = parseOrders([{ quantity: "" }]);
  assert.equal(parsed.sourceMatrix[1][7], "");
  assert.ok(parsed.errors.some((error) => error.code === "ORDER_QUANTITY_INVALID"));
  assert.throws(() => engine.analyze(parsed, parseInventory([{ stock: 10 }])), /수량|입력/);
});

test("control: zero, negative, fractional quantities and blank/zero prices survive saved output", () => {
  const workspace = makeWorkspace([
    { code: "0001", quantity: 0, price: 0, amount: 0 },
    { code: "0002", quantity: -2, price: 1000, amount: -2000 },
    { code: "0003", quantity: 0.5, price: "", amount: "" },
  ], ["0001", "0002", "0003"].map((code) => ({ code, stock: 10 })));
  const source = clone(workspace.sourceFiles);
  const saved = restore(workspace);
  const output = table(reopen(saved), "주문현황", "주문수량");
  assert.deepEqual(output.map((row) => [row["상품코드"], row["주문수량"], row["단가"], row["공급가액"]]), [
    ["0001", 0, 0, 0], ["0002", -2, 1000, -2000], ["0003", 0.5, "", ""],
  ]);
  assert.deepEqual(saved.sourceFiles, source);
});

test("F06: quantity grouping uses explicit product/unit, not product name or specification conversion", () => {
  assert.equal(typeof engine.getQuantityGroupKey, "function");
  const key = (values) => engine.getQuantityGroupKey({ productCode: "0001", ...values });
  assert.equal(key({ sourceUnit: "ea", productName: "A" }), key({ sourceUnit: "EA", productName: "B" }));
  assert.notEqual(key({ sourceUnit: "BOX" }), key({ sourceUnit: "EA" }));
  assert.notEqual(key({ sourceUnit: "", specification: "EA" }), key({ sourceUnit: "EA" }), "규격 문자열을 단위/환산 근거로 대체하면 안 됩니다.");
});

for (const value of [0, 4]) {
  for (const boundary of ["workspace", "recovery", "xlsx"]) {
    test(`F05: inventory override ${value} synchronizes ${boundary}`, () => {
      let workspace = makeWorkspace([{ quantity: 10, note: "  원본 전달사항  " }]);
      const source = clone(workspace.sourceFiles);
      const originalInventory = clone(workspace.inventory);
      engine.setPurchaseValue(workspace, "0001", "검토 구매처");
      engine.setNoticeAcknowledged(workspace, workspace.notices[0].noticeId, true);
      override(workspace, value);
      if (boundary === "recovery") workspace = restore(workspace);
      const need = 10 - value;
      const inventory = engine.getInventoryViewRows(workspace).rows[0];
      assert.equal(inventory.stockTotal, value);
      assert.equal(inventory.remainingQuantity, -need);
      assert.equal(engine.getPurchaseUploadSelection(workspace).included[0]?.purchaseNeed, need);
      if (boundary === "xlsx") {
        const book = reopen(workspace);
        assert.equal(table(book, "주문현황", "주문수량")[0]["구매수량"], need);
        assert.equal(table(book, "구매업로드", "수량")[0]["수량"], need);
        assert.equal(table(book, "재고수불부", "잔량")[0]["잔량"], -need);
      } else {
        assert.equal(workspace.allocations[0].purchaseNeed, need);
        assert.equal(workspace.productSummaries[0].purchaseNeed, need);
        assert.equal(workspace.stats.totalPurchaseNeed, need);
        assert.equal(screen(workspace).allocations.sourceRows[0].purchaseNeed, need);
        assert.equal(engine.getPurchaseInputs(workspace)["0001"], "검토 구매처");
        assert.equal(engine.isNoticeAcknowledged(workspace, workspace.notices[0].noticeId), true);
      }
      assert.deepEqual(workspace.sourceFiles, source);
      assert.deepEqual(workspace.inventory, originalInventory);
      assert.equal(workspace.orders[0].noteOriginal, "  원본 전달사항  ");
    });
  }
}

test("F05: order edit after override uses effective inventory without losing source", () => {
  const workspace = makeWorkspace();
  const source = clone(workspace.sourceFiles);
  override(workspace, 4);
  engine.setOrderValue(workspace, workspace.orders[0].sourceRowNumber, "quantity", 12);
  assert.equal(workspace.allocations[0].purchaseNeed, 8);
  assert.equal(engine.getPurchaseUploadSelection(workspace).included[0]?.purchaseNeed, 8);
  assert.deepEqual(workspace.sourceFiles, source);
  assert.equal(workspace.sourceFiles.orders.matrix[1][7], 10);
});

test("F05: override recalculates repeated-order allocations in original row order", () => {
  const workspace = makeWorkspace([{ quantity: 5 }, { quantity: 4 }], [{ stock: 9 }]);
  override(workspace, 3);
  const saved = restore(workspace);
  assert.deepEqual(saved.allocations.map((row) => [row.sourceRowNumber, row.wholeAllocation, row.seoulAllocation, row.purchaseNeed]), [
    [2, 3, 0, 2], [3, 0, 0, 4],
  ]);
  assert.equal(engine.getPurchaseUploadSelection(saved).included[0]?.purchaseNeed, 6);
  const output = reopen(saved);
  assert.deepEqual(table(output, "주문현황", "주문수량").map((row) => row["구매수량"]), [2, 4]);
  assert.equal(table(output, "구매업로드", "수량")[0]["수량"], 6);
});

test("F05: negative-stock replenishment is explicit and distinct from order allocation", () => {
  const workspace = makeWorkspace([{ quantity: 5 }, { quantity: 5 }], [{ stock: 10 }]);
  const source = clone(workspace.sourceFiles);
  const sourceInventory = clone(workspace.inventory);
  const orders = clone(workspace.orders);
  override(workspace, -2);
  const saved = restore(workspace);
  assert.equal(engine.getInventoryViewRows(saved).rows[0].remainingQuantity, -12);
  assert.equal(engine.getPurchaseUploadSelection(saved).included[0]?.purchaseNeed, 12);
  assert.deepEqual(saved.allocations.map((row) => row.purchaseNeed), [5, 5],
    "음수 실재고 보충분을 만들기 위해 주문 배정량이나 구매필요를 임의로 변조하면 안 됩니다.");
  saved.allocations.forEach((row) => {
    assert.equal(row.quantity, row.wholeAllocation + row.seoulAllocation + row.purchaseNeed);
    assert.ok(row.wholeAllocation >= 0, "원본 음수 재고를 음수 출고배정으로 바꾸면 안 됩니다.");
  });
  assert.equal(workbook.getPurchaseUploadRows(saved)[0]?.purchaseNeed, 12);
  const output = reopen(saved);
  const orderRows = table(output, "주문현황", "주문수량");
  assert.deepEqual(orderRows.map((row) => row["구매수량"]), [5, 5]);
  assert.deepEqual(orderRows.map((row) => row["최종 구매수량(상품별)"]), [12, ""],
    "최종 보충 수량은 상품별 한 번만 표시되어야 합니다.");
  assert.ok(orderRows.some((row) => String(row["구매수량 기준"] ?? "").trim()),
    "주문배정 구매수량 합계 10과 최종 보충 수량 12의 차이를 설명해야 합니다.");
  assert.equal(table(output, "구매업로드", "수량")[0]["수량"], 12);
  assert.deepEqual(saved.sourceFiles, source);
  assert.deepEqual(saved.inventory, sourceInventory);
  assert.deepEqual(saved.orders, orders);
});

test("control: blank, zero, and negative inventory overrides survive recovery and XLSX", () => {
  for (const value of ["", 0, -2]) {
    const workspace = makeWorkspace();
    const original = clone(workspace.sourceFiles);
    const column = override(workspace, value);
    const saved = restore(workspace);
    assert.equal(saved.inventoryOverrides.cells.find((cell) => cell.columnKey === column.key).value, value);
    const view = engine.getInventoryViewRows(saved);
    assert.equal(view.rows[0].values[view.columns.findIndex((entry) => entry.key === column.key)], value);
    assert.equal(table(reopen(saved), "창고별재고", "1창고")[0]["1창고"], value);
    assert.deepEqual(saved.sourceFiles, original);
  }
});

for (const boundary of ["screen", "recovery", "xlsx"]) {
  test(`F06: incompatible order units never become numeric 12 in ${boundary}`, () => {
    let workspace = makeWorkspace([{ quantity: 2, unit: "BOX" }, { quantity: 10, unit: "EA" }], [{ stock: 20 }]);
    if (boundary === "recovery") workspace = restore(workspace);
    let values;
    if (boundary === "xlsx") {
      const rows = table(reopen(workspace), "주문현황", "주문수량");
      values = rows.map((row) => row["주문수량 합계"]);
      assert.deepEqual(rows.map((row) => row["주문수량"]), [2, 10]);
      assert.ok(rows.some((row) => unitExplanation(Object.values(row).join(" "))), "단위별 값 또는 단위 확인 설명이 출력되어야 합니다.");
    } else {
      const preview = screen(workspace).allocations;
      values = preview.sourceRows.map((row) => row.productAggregateQuantity);
      assert.ok(unitExplanation(JSON.stringify(preview.rows)), "실제로 표시할 화면 셀에 단위별 값 또는 비교 불가 이유가 있어야 합니다.");
    }
    assert.ok(values.every((value) => value !== 12), "2 BOX + 10 EA를 근거 없이 12로 합산하면 안 됩니다.");
    const inventory = engine.getInventoryViewRows(workspace).rows[0];
    assert.equal(inventory.quantityComparable, false);
    assert.equal(inventory.quantityIssue, "UNIT_MISMATCH");
    assert.ok(quantityUnavailable(inventory.orderQuantity));
    assert.ok(quantityUnavailable(inventory.remainingQuantity), "서로 다른 주문 단위로 재고 잔량을 임의 확정하면 안 됩니다.");
    assert.equal(engine.getPurchaseUploadSelection(workspace).included.length, 0, "단위 미확인 상품을 구매업로드 수량으로 확정하면 안 됩니다.");
    assert.deepEqual(workspace.orders.map((row) => [row.quantity, row.sourceUnit]), [[2, "BOX"], [10, "EA"]]);
  });
}

test("F06: a single incompatible or unknown order unit cannot consume known EA inventory", () => {
  for (const unit of ["BOX", ""]) {
    const workspace = makeWorkspace([{ quantity: 2, unit }], [{ stock: 20 }]);
    const row = engine.getInventoryViewRows(workspace).rows[0];
    assert.equal(row.quantityComparable, false);
    assert.ok(quantityUnavailable(row.remainingQuantity));
    assert.equal(engine.getPurchaseUploadSelection(workspace).included.length, 0);
    assert.ok(quantityUnavailable(workspace.allocations[0].purchaseNeed));
    assert.deepEqual(workspace.orders.map((order) => [order.quantity, order.sourceUnit]), [[2, unit]]);
  }
});

test("F06: mixed-unit canonical exclusion also excludes an otherwise-short EA allocation from purchase output", () => {
  const workspace = makeWorkspace([{ quantity: 2, unit: "BOX" }, { quantity: 30, unit: "EA" }], [{ stock: 20 }]);
  const source = clone(workspace.sourceFiles);
  const sourceInventory = clone(workspace.inventory);
  const orders = clone(workspace.orders);
  const saved = restore(workspace);
  assert.deepEqual(saved.allocations.map((row) => [row.sourceUnit, row.purchaseNeed]), [["BOX", null], ["EA", 10]]);
  assert.equal(engine.getPurchaseUploadSelection(saved).included.length, 0);
  assert.equal(workbook.getPurchaseUploadRows(saved).length, 0,
    "워크북이 상품별 최종 구매 제외 결정을 우회하여 EA 배정 필요량만 출력하면 안 됩니다.");
  const output = reopen(saved);
  assert.equal(table(output, "구매업로드", "수량").length, 0);
  const orderRows = table(output, "주문현황", "주문수량");
  assert.deepEqual(orderRows.map((row) => row["구매수량"]), ["", 10]);
  assert.deepEqual(orderRows.map((row) => row["최종 구매수량(상품별)"]), ["", ""]);
  assert.ok(orderRows.some((row) => /단위/.test(String(row["구매수량 기준"] ?? ""))),
    "최종 구매수량 공란의 단위 확인 사유를 설명해야 합니다.");
  assert.deepEqual(saved.sourceFiles, source);
  assert.deepEqual(saved.inventory, sourceInventory);
  assert.deepEqual(saved.orders, orders);
});

const onlyTransactions = {
  purchases: { rows: [{ productCode: "ONLY-BUY", productName: "구매 전용", specification: "매입 규격", sourceUnit: "EA", quantity: 3, partner: "공급사" }] },
  sales: { rows: [{ productCode: "ONLY-SELL", productName: "판매 전용", specification: "매출 규격", sourceUnit: "BOX", quantity: 1, partner: "판매처" }] },
};
for (const boundary of ["screen", "recovery", "xlsx"]) {
  test(`F07: purchase-only and sales-only products retain unknown inventory in ${boundary}`, () => {
    let workspace = makeWorkspace(undefined, undefined, onlyTransactions);
    if (boundary === "recovery") workspace = restore(workspace);
    const view = ledgerRows(workspace);
    const book = boundary === "xlsx" ? reopen(workspace) : null;
    const preview = boundary === "screen" ? screen(workspace).ledger : null;
    for (const [code, quantityHeader, quantity, unit] of [["ONLY-BUY", "입고", 3, "EA"], ["ONLY-SELL", "출고", 1, "BOX"]]) {
      const row = view.find((entry) => entry.source.productCode === code);
      assert.ok(row, `${code}가 수불 조회에 포함되어야 합니다.`);
      assert.equal(row.source.inventoryMissing, true, `${code}를 확인된 재고 0으로 바꾸면 안 됩니다.`);
      assert.ok(quantityUnavailable(row.cells["재고"]));
      assert.ok(quantityUnavailable(row.cells["잔량"]));
      assert.equal(row.cells[quantityHeader], quantity);
      assert.equal(row.cells["단위"], unit);
      if (book) {
        const output = table(book, "재고수불부", "잔량").find((entry) => entry["품목코드"] === code);
        assert.ok(output);
        assert.equal(output[quantityHeader], quantity);
        assert.equal(output["재고"], "");
        assert.equal(output["잔량"], "");
      }
      if (preview) {
        const source = preview.sourceRows.find((entry) => entry.productCode === code);
        assert.ok(source?.inventoryMissing);
        assert.match(source.rowState, /재고정보|재고자료|미확인|미확정/);
      }
    }
    assert.deepEqual(workspace.orderOpsInputs, onlyTransactions);
  });
}

for (const unit of ["EA", "BOX", ""]) {
  test(`F08: purchase/sale references preserve ${unit || "unknown"} units through screen, recovery and XLSX`, () => {
    const transactions = {
      purchases: { rows: [{ productCode: "0001", specification: "매입 규격", sourceUnit: unit, quantity: 3, partner: "공급사" }] },
      sales: { rows: [{ productCode: "0001", specification: "매출 규격", sourceUnit: unit, quantity: 1, partner: "판매처" }] },
    };
    const workspace = restore(makeWorkspace([{ quantity: 2 }], [{ stock: 20 }], transactions));
    const ledger = ledgerRows(workspace).filter((entry) => entry.source.productCode === "0001");
    const preview = screen(workspace).ledger;
    const output = table(reopen(workspace), "재고수불부", "잔량").filter((entry) => entry["품목코드"] === "0001");
    const screenRows = preview.rows.map((row) => Object.fromEntries(preview.headers.map((header, index) => [header, row[index]])))
      .filter((entry) => entry["품목코드"] === "0001");
    assert.equal(engine.getInventoryViewRows(workspace).rows[0].remainingQuantity, 18, "잔량은 재고−주문이며 구매/판매 참조가 자동 가감되지 않습니다.");
    for (const rows of [ledger.map((row) => row.cells), screenRows, output]) {
      if (unit === "EA") {
        assert.equal(rows[0]["입고"], 3);
        assert.equal(rows[0]["출고"], 1);
      } else {
        const inventoryRow = rows.find((row) => row["단위"] === "EA");
        assert.ok(!inventoryRow || (inventoryRow["입고"] !== 3 && inventoryRow["출고"] !== 1), "BOX/미확인 수량을 EA 입출고 수량으로 표시하면 안 됩니다.");
        const referenceRow = rows.find((row) => row["입고"] === 3 && row["출고"] === 1 && row["단위"] !== "EA");
        assert.ok(referenceRow, "입출고 원 수량 3/1을 단위별 행에 보존해야 합니다.");
        assert.ok(quantityUnavailable(referenceRow["재고"]));
        assert.ok(quantityUnavailable(referenceRow["잔량"]));
        if (unit === "BOX") assert.equal(referenceRow["단위"], "BOX");
        else assert.ok(unitExplanation(Object.values(referenceRow).join(" ")), "미확인 단위의 설명을 해당 행에 표시해야 합니다.");
      }
    }
    assert.ok(preview.sourceRows.length > 0);
    assert.deepEqual(workspace.orderOpsInputs, transactions);
  });
}

test("F08: each transaction unit preserves zero and signed quantities without changing stock balance", () => {
  const transactions = {
    purchases: { rows: [
      { productCode: "0001", sourceUnit: "EA", quantity: 0 },
      { productCode: "0001", sourceUnit: "EA", quantity: -2 },
      { productCode: "0001", sourceUnit: "BOX", quantity: 3 },
    ] },
    sales: { rows: [
      { productCode: "0001", sourceUnit: "EA", quantity: 0 },
      { productCode: "0001", sourceUnit: "EA", quantity: -1 },
      { productCode: "0001", sourceUnit: "BOX", quantity: 1 },
    ] },
  };
  const workspace = restore(makeWorkspace([{ quantity: 2 }], [{ stock: 20 }], transactions));
  const rows = table(reopen(workspace), "재고수불부", "잔량").filter((entry) => entry["품목코드"] === "0001");
  const ea = rows.find((row) => row["단위"] === "EA");
  const box = rows.find((row) => row["단위"] === "BOX");
  assert.deepEqual([ea["재고"], ea["입고"], ea["출고"], ea["잔량"]], [20, -2, -1, 18]);
  assert.deepEqual([box?.["입고"], box?.["출고"], box?.["재고"], box?.["잔량"]], [3, 1, "", ""]);
  assert.deepEqual(workspace.orderOpsInputs, transactions);
});

for (const kind of ["purchases", "sales"]) {
  for (const restoredMappings of [false, true]) {
    test(`F08: ${kind} XLSX parser preserves units/specification with ${restoredMappings ? "recovered" : "default"} mappings`, () => {
      const partnerHeader = kind === "purchases" ? "구매처" : "거래처";
      const quantityHeader = restoredMappings ? "검토수량" : "수량";
      const matrix = [
        ["품목코드", "품목명", quantityHeader, partnerHeader, "규격", "단위"],
        ["0001", "상품0", 0, "거래처", "  원본 규격  ", " EA "],
        ["0002", "상품음수", -2, "거래처", "", "BOX"],
        ["0003", "단위 미확인 상품", 3, "거래처", "EA", ""],
      ];
      // Previously stored mappings have no unit/specification entries. New defaults
      // must still preserve those source columns without discarding the saved alias.
      const savedMappings = restoredMappings ? { [kind]: { columns: { "수량": [quantityHeader] } } } : null;
      const parsed = parseTransactionSheet(kind, matrix, savedMappings);
      assert.equal(parsed.errors.length, 0);
      assert.deepEqual(parsed.rows.map((row) => [row.productCode, row.quantity, row.sourceUnit, row.specification]), [
        ["0001", 0, " EA ", "  원본 규격  "], ["0002", -2, "BOX", ""], ["0003", 3, "", "EA"],
      ]);
      const workspace = restore(makeWorkspace(undefined, undefined, { [kind]: parsed }));
      assert.deepEqual(workspace.orderOpsInputs[kind].rows, parsed.rows);
    });
  }
}

test("F08: optional transaction blank quantity stays distinct from zero after parser, recovery and XLSX", () => {
  const transactions = {};
  for (const kind of ["purchases", "sales"]) {
    transactions[kind] = parseTransactionSheet(kind, [
      ["품목코드", "품목명", "수량", kind === "purchases" ? "구매처" : "거래처", "규격", "단위"],
      ["BLANK", "공란 수량 상품", "", "거래처", "", "EA"],
      ["ZERO", "0 수량 상품", 0, "거래처", "", "EA"],
      ["MIXED", "일부 미확인 수량", "", "거래처", "", "EA"],
      ["MIXED", "일부 미확인 수량", 3, "거래처", "", "EA"],
    ]);
    assert.deepEqual(transactions[kind].rows.map((row) => [row.quantity, row.sourceQuantity]), [
      ["", ""], [0, "0"], ["", ""], [3, "3"],
    ]);
  }
  const workspace = restore(makeWorkspace(undefined, undefined, transactions));
  assert.deepEqual(workspace.orderOpsInputs, transactions);
  const preview = screen(workspace);
  for (const kind of ["purchases", "sales"]) {
    assert.deepEqual(preview[kind].sourceRows.map((row) => row.quantity), ["", 0, "", 3]);
  }
  const view = ledgerRows(workspace);
  for (const code of ["BLANK", "MIXED"]) {
    const entry = view.find((row) => row.source.productCode === code);
    assert.ok(entry, `${code} 원천 상품을 누락하면 안 됩니다.`);
    assert.equal(entry.cells["입고"], null, "공란이 포함된 수량을 확인된 숫자로 합산하면 안 됩니다.");
    assert.equal(entry.cells["출고"], null);
  }
  const bookRows = table(reopen(workspace), "재고수불부", "잔량");
  for (const code of ["BLANK", "MIXED"]) {
    const row = bookRows.find((entry) => entry["품목코드"] === code);
    assert.deepEqual([row["입고"], row["출고"]], ["", ""]);
  }
  const zero = bookRows.find((entry) => entry["품목코드"] === "ZERO");
  assert.deepEqual([zero["입고"], zero["출고"]], [0, 0]);
});

const failures = results.filter((result) => !result.pass);
console.log(`ORDER Q baseline calculation: ${results.length - failures.length}/${results.length} passed (engine/screen-model/recovery JSON/XLSX values; no browser, IndexedDB, or style claim).`);
if (failures.length) process.exitCode = 1;
