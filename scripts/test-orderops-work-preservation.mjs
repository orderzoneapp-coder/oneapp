import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Regression boundaries after PR #622: reanalysis preserves reviewed work, and
// failed/cancelled file reads do not discard it. Actual HTML handlers execute;
// DOM rendering, timers and file-reader outcomes are isolated test adapters.
// XLSX values use bundled SheetJS bytes. No browser/IndexedDB/style claim.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "orderFulfillmentEngine.js"));
const workbookTools = require(path.join(ROOT, "orderFulfillmentWorkbook.js"));
const XLSX = require(path.join(ROOT, "customer-master/vendor/xlsx.full.min.js"));
const HTML_PATHS = ["orderops/list.html", "orderops_list.html"];
const FILE_KINDS = ["orders", "inventory", "purchases", "sales"];
const FILE_KIND_LABELS = { orders: "주문", inventory: "재고", purchases: "구매", sales: "판매" };
const FILE_KIND_PREVIEWS = { orders: "allocations", inventory: "inventory", purchases: "purchases", sales: "sales" };
const WHEN = "2026-09-17T01:00:00.000Z";
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function inputs() {
  const orderMatrix = [
    ["일자", "창고", "담당", "단위", "품목코드", "품목명", "규격", "수량", "단가", "공급가액", "적요", "적요1", "거래처", "그룹"],
    ["2026-09-17", "1창고", "담당A", "EA", "0001", "합성상품", "원본규격", 10, 1000, 10000, "  원본 적요  ", "", "거래처A", "기본"],
  ];
  const inventoryMatrix = [
    ["품목코드", "품목명", "규격", "단위", "수량", "1창고", "3서울", "4전송"],
    ["0001", "합성상품", "원본규격", "EA", 10, 10, 0, 0],
  ];
  const transactions = (kind) => ({
    kind, fileName: `${kind}.xlsx`, fileHash: hash(kind), sheetName: "자료", rowCount: 1,
    missingColumns: [], errors: [], warnings: [],
    rows: [{ productCode: "0001", productName: "합성상품", sourceUnit: "EA", specification: "원본규격", quantity: kind === "purchases" ? 2 : 1, partner: "원본 거래처", sourceRowNumber: 2 }],
  });
  return {
    orders: engine.parseOrderWorkbook({ fileName: "orders.xlsx", fileHash: hash("orders"), sheetName: "주문", rawMatrix: orderMatrix, displayMatrix: clone(orderMatrix) }),
    inventory: engine.parseInventoryWorkbook({ fileName: "inventory.xlsx", fileHash: hash("inventory"), sheetName: "재고", rawMatrix: inventoryMatrix, displayMatrix: clone(inventoryMatrix) }),
    purchases: transactions("purchases"), sales: transactions("sales"),
  };
}

function extractFunction(html, name) {
  const match = new RegExp(`      (?:async )?function ${name}\\(`).exec(html);
  assert.ok(match, `${name} 실제 화면 함수를 찾을 수 없습니다.`);
  const rest = html.slice(match.index + match[0].length);
  const end = /\r?\n      }\r?\n/.exec(rest);
  assert.ok(end, `${name} 함수의 끝 경계가 없습니다.`);
  return html.slice(match.index, match.index + match[0].length + end.index + end[0].length);
}

function element() {
  const classes = new Set();
  return {
    disabled: false, textContent: "", innerHTML: "", value: "",
    classList: { add: (...values) => values.forEach((value) => classes.add(value)), remove: (...values) => values.forEach((value) => classes.delete(value)), toggle(value, active) { if (active) classes.add(value); else classes.delete(value); }, contains: (value) => classes.has(value) },
    setAttribute() {}, focus() {}, scrollIntoView() {},
  };
}

function sheetValues(book) {
  return Object.fromEntries(book.SheetNames.map((name) => [name, XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: "" })]));
}

function reopenedValues(workspace) {
  const built = workbookTools.buildWorkbook(workspace, XLSX);
  const bytes = XLSX.write(built, { type: "buffer", bookType: "xlsx" });
  assert.ok(bytes.length > 0);
  return sheetValues(XLSX.read(bytes, { type: "buffer" }));
}

function outputRows(values, name, header) {
  const matrix = values[name];
  assert.ok(matrix, `${name} 시트가 있어야 합니다.`);
  const index = matrix.findIndex((row) => row.includes(header));
  assert.ok(index >= 0, `${name} 시트에 ${header} 열이 있어야 합니다.`);
  return matrix.slice(index + 1).map((row) => Object.fromEntries(matrix[index].map((title, column) => [title, row[column] ?? ""])));
}

async function harness(htmlPath) {
  const html = fs.readFileSync(path.join(ROOT, htmlPath), "utf8");
  const state = {
    ...inputs(), workspace: null, validation: null, activePreview: "allocations",
    searchQuery: "", selectedOrderViewPresetId: "", activeFilterPanel: "",
    loading: Object.fromEntries([...FILE_KINDS, "bundle", "integrated"].map((kind) => [kind, false])),
    analysisEnterLocked: false, analysisEnterReady: false, analysisRunning: false,
  };
  state.validation = engine.validateInputs(state.orders, state.inventory);
  const elements = new Proxy({}, { get: (target, key) => target[key] || (target[key] = element()) });
  const log = { toasts: [], messages: [], saves: [], exports: [], reads: [], classifications: [], integratedReads: 0, recovery: null, viewResets: 0 };
  const env = {
    engine, state, elements, FILE_KINDS, FILE_KIND_LABELS, FILE_KIND_PREVIEWS, MAX_FILE_SIZE: 25 * 1024 * 1024,
    window: { XLSX, setTimeout: (callback) => { callback(); return 0; } },
    document: { activeElement: null }, HTMLElement: class TestHTMLElement {},
    sha256Hex: async (value) => hash(value),
    showToast: (message, error) => log.toasts.push({ message, error: Boolean(error) }),
    setSystemMessage: (message) => log.messages.push(message),
    leaveUnresolvedReview() {}, clearSubstitutionSelection() {}, renderSourceViewCards() {},
    renderFileCard() {}, renderIntegratedFileCard() {}, renderValidation() {},
    getPreviewDefinitions: () => ({ validation: {}, allocations: {}, inventory: {}, ledger: {}, purchases: {}, sales: {} }),
    renderPreview() {
      const kind = FILE_KINDS.find((candidate) => FILE_KIND_PREVIEWS[candidate] === state.activePreview) || "workspace";
      elements.previewTable.innerHTML = `<table data-prepared-preview="${kind}"><thead><tr><th>자료</th></tr></thead></table>`;
    },
    resetResultViewFilters() {
      log.viewResets += 1;
      state.searchQuery = "";
      state.selectedOrderViewPresetId = "";
      state.activeFilterPanel = "";
    },
    renderResults() {
      elements.downloadButton.disabled = !state.workspace;
      elements.printButton.disabled = !state.workspace;
    },
    scheduleLocalSave() {
      const payload = engine.buildLocalRecoveryPayload(state.workspace, { activePreview: state.activePreview }, {}, WHEN);
      log.recovery = clone(payload);
      log.saves.push(clone(payload));
    },
    readOperation: async (_file, kind) => clone(state[kind]),
    parseExcelFile: async (file, kind) => { log.reads.push(kind); return env.readOperation(file, kind); },
    parseGenericExcelFile: async (file, kind) => { log.reads.push(kind); return env.readOperation(file, kind); },
    classifyOperation: async () => { throw new Error("UNCONFIGURED_CLASSIFICATION"); },
    classifyBundleFile: async (file) => { log.classifications.push(file.name); return env.classifyOperation(file); },
    integratedOperation: async () => { throw new Error("UNCONFIGURED_INTEGRATED_READ"); },
    parseIntegratedExcelFile: async (file) => { log.integratedReads += 1; return env.integratedOperation(file); },
    workbookTools: {
      ...workbookTools,
      downloadWorkbook(workspace) {
        const built = workbookTools.buildWorkbook(workspace, XLSX);
        const bytes = XLSX.write(built, { type: "buffer", bookType: "xlsx" });
        log.exports.push(sheetValues(XLSX.read(bytes, { type: "buffer" })));
        return built;
      },
    },
  };
  const context = vm.createContext(env);
  vm.runInContext([
    "isSupportedFile", "isInputOperationBusy", "validateFileCandidate", "setLoading", "setAnalysisEnterReady", "resetResults", "refreshInputState",
    "escapeHtml", "renderPreparedInputPreview", "removePreparedKind", "analyzeCurrentInputs", "commitInputCandidates", "runAnalysis", "handleFile", "handleBundleFiles", "handleIntegratedFile", "refreshCurrentSession", "downloadResult",
  ].map((name) => extractFunction(html, name)).join("\n"), context, { filename: `${htmlPath}:work-preservation` });
  const call = async (name, ...args) => {
    env.callArgs = args;
    return vm.runInContext(`${name}(...callArgs)`, context);
  };
  state.workspace = await call("analyzeCurrentInputs");
  env.renderResults();
  return { state, elements, env, log, call };
}

const POSITIVE = { quantity: 7, unitPrice: 1200, inventory: 4, purchase: "수정 구매처" };
const SCENARIOS = [
  ["reviewed", POSITIVE],
  ["zero", { quantity: 0, unitPrice: 0, inventory: 0, purchase: "" }],
  ["blank", { quantity: 7, unitPrice: "", inventory: "", purchase: "" }],
  ["negative", { quantity: -2, unitPrice: -1200, inventory: -4, purchase: "음수 검토처" }],
];
const EDIT_ORDERS = [
  ["order-first", ["quantity", "unitPrice", "inventory", "purchase"]],
  ["inventory-first", ["inventory", "purchase", "quantity", "unitPrice"]],
];

function edit(workspace, values, order) {
  const rowNumber = workspace.orders[0].sourceRowNumber;
  const inventoryColumn = engine.getInventoryColumnDescriptors(workspace).find((column) => column.header === "1창고");
  order.forEach((field) => {
    if (field === "inventory") engine.setInventoryOverride(workspace, "0001", inventoryColumn.key, values[field]);
    else if (field === "purchase") engine.setPurchaseValue(workspace, "0001", values[field]);
    else engine.setOrderValue(workspace, rowNumber, field, values[field]);
  });
}

function assertWork(workspace, values) {
  assert.equal(workspace.orders[0].quantity, values.quantity);
  const unitPrice = values.unitPrice === "" ? null : values.unitPrice;
  assert.equal(workspace.orders[0].unitPrice, unitPrice);
  assert.equal(workspace.orders[0].supplyAmount, unitPrice === null ? null : values.quantity * unitPrice);
  assert.equal(engine.getPurchaseInputs(workspace)["0001"], values.purchase);
  const view = engine.getInventoryViewRows(workspace);
  const index = view.columns.findIndex((column) => column.header === "1창고");
  assert.equal(view.rows[0].values[index], values.inventory);
  assert.equal(view.rows[0].stockTotal, values.inventory === "" ? 0 : values.inventory);
  assert.equal(workspace.sourceFiles.orders.matrix[1][7], 10, "원본 수량 10을 작업값으로 덮어쓰면 안 됩니다.");
  assert.equal(workspace.sourceFiles.orders.matrix[1][8], 1000);
  assert.equal(workspace.sourceFiles.inventory.matrix[1][5], 10);
}

function assertRecoveryAndOutput(workspace, values) {
  const restored = JSON.parse(JSON.stringify(engine.buildLocalRecoveryPayload(workspace, {}, {}, WHEN))).workspace;
  assertWork(restored, values);
  const output = reopenedValues(restored);
  const orders = outputRows(output, "주문현황", "주문수량");
  assert.equal(orders[0]["주문수량"], values.quantity);
  assert.equal(orders[0]["단가"], values.unitPrice);
  assert.equal(orders[0]["공급가액"], values.unitPrice === "" ? "" : values.quantity * values.unitPrice);
  assert.equal(orders[0]["구매"], values.purchase);
  assert.equal(outputRows(output, "창고별재고", "1창고")[0]["1창고"], values.inventory);
  const selected = engine.getPurchaseUploadSelection(restored).included;
  assert.deepEqual(outputRows(output, "구매업로드", "수량").map((row) => row["수량"]), selected.map((row) => row.purchaseNeed));
}

const results = [];
async function test(name, action) {
  try { await action(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false }); console.error(`FAIL ${name}\n${error.stack}`); }
}

await test("engine: initial analysis owns row copies instead of mutating parsed inputs", () => {
  const parsed = inputs();
  const before = clone(parsed);
  const workspace = engine.analyze(parsed.orders, parsed.inventory, { sourceFingerprint: hash("immutable") });
  assert.notStrictEqual(workspace.orders, parsed.orders.rows);
  assert.notStrictEqual(workspace.orders[0], parsed.orders.rows[0]);
  assert.notStrictEqual(workspace.inventory, parsed.inventory.rows);
  assert.notStrictEqual(workspace.sourceFiles.orders.matrix, parsed.orders.sourceMatrix);
  assert.notStrictEqual(workspace.sourceFiles.inventory.matrix, parsed.inventory.sourceMatrix);
  edit(workspace, POSITIVE, EDIT_ORDERS[0][1]);
  assertWork(workspace, POSITIVE);
  assert.deepEqual(parsed, before, "편집 순서와 무관하게 처음 읽은 입력은 불변이어야 합니다.");
});

await test("engine: recalculateWorkspace returns a detached candidate and preserves the input", () => {
  assert.equal(typeof engine.recalculateWorkspace, "function");
  const parsed = inputs();
  const workspace = engine.analyze(parsed.orders, parsed.inventory, { sourceFingerprint: hash("candidate") });
  edit(workspace, POSITIVE, EDIT_ORDERS[1][1]);
  assertWork(workspace, POSITIVE);
  const before = clone(workspace);
  const candidate = engine.recalculateWorkspace(workspace);
  assert.notStrictEqual(candidate, workspace);
  assert.notStrictEqual(candidate.orders, workspace.orders);
  assert.notStrictEqual(candidate.sourceFiles, workspace.sourceFiles);
  assert.deepEqual(workspace, before);
  assertWork(candidate, POSITIVE);
  assertRecoveryAndOutput(candidate, POSITIVE);
  candidate.orders[0].quantity = 999;
  candidate.sourceFiles.orders.matrix[1][7] = 999;
  assert.deepEqual(workspace, before, "후보를 편집해도 현재 작업에 전파되지 않아야 합니다.");
});

for (const htmlPath of HTML_PATHS) {
  await test(`${htmlPath}: recovery-only workspace reanalyzes without re-uploading original files`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    h.state.workspace = clone(engine.buildLocalRecoveryPayload(h.state.workspace, {}, {}, WHEN)).workspace;
    FILE_KINDS.forEach((kind) => { h.state[kind] = null; });
    h.state.validation = null;
    await h.call("refreshInputState");
    assert.equal(h.elements.analyzeButton.disabled, false);
    h.state.activePreview = "inventory";
    h.state.searchQuery = "합성";
    h.state.selectedOrderViewPresetId = "saved-inventory-view";
    h.state.activeFilterPanel = "warehouse";
    await h.call("runAnalysis");
    assertWork(h.state.workspace, POSITIVE);
    assertRecoveryAndOutput(h.state.workspace, POSITIVE);
    assert.equal(h.log.saves.length, 1);
    assert.equal(h.state.analysisRunning, false);
    assert.equal(h.state.activePreview, "inventory");
    assert.equal(h.state.searchQuery, "합성");
    assert.equal(h.state.selectedOrderViewPresetId, "saved-inventory-view");
    assert.equal(h.state.activeFilterPanel, "warehouse");
    assert.equal(h.log.viewResets, 0, "수동 재분석이 현재 보기 상태를 초기화하면 안 됩니다.");
  });

  await test(`${htmlPath}: explicit fromSources creates source-based replacement without mutating reviewed work`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    const current = h.state.workspace;
    const before = clone(current);
    const candidate = await h.call("analyzeCurrentInputs", { fromSources: true });
    assertWork(candidate, { quantity: 10, unitPrice: 1000, inventory: 10, purchase: "" });
    assert.strictEqual(h.state.workspace, current);
    assert.deepEqual(current, before);
  });

  await test(`${htmlPath}: reanalysis failure preserves work/recovery/export and releases busy state`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    h.env.scheduleLocalSave();
    const recovery = clone(h.log.recovery);
    const current = h.state.workspace;
    const before = clone(current);
    h.env.engine = { ...engine, recalculateWorkspace() { throw new Error("INJECTED_RECALCULATION_FAILURE"); } };
    await h.call("runAnalysis");
    assert.strictEqual(h.state.workspace, current);
    assert.deepEqual(current, before);
    assert.deepEqual(h.log.recovery, recovery);
    assert.equal(h.log.saves.length, 1);
    assert.equal(h.state.analysisRunning, false);
    assert.equal(h.elements.analyzeButton.disabled, false);
    assert.equal(h.elements.downloadButton.disabled, false);
    assert.ok(h.log.toasts.some((toast) => toast.error && toast.message.includes("INJECTED_RECALCULATION_FAILURE")));
    h.env.engine = engine;
    await h.call("runAnalysis");
    assertWork(h.state.workspace, POSITIVE);
    assert.equal(h.log.saves.length, 2);
  });

  for (const [scenarioName, values] of SCENARIOS) {
    for (const [orderName, order] of EDIT_ORDERS) {
      for (const entry of ["analyzeCurrentInputs", "runAnalysis"]) {
        await test(`${htmlPath}: ${entry} preserves ${scenarioName} ${orderName} work`, async () => {
          const h = await harness(htmlPath);
          const originalInputs = clone(Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]])));
          edit(h.state.workspace, values, order);
          assertWork(h.state.workspace, values);
          const current = h.state.workspace;
          const before = clone(current);
          if (entry === "analyzeCurrentInputs") {
            const candidate = await h.call(entry);
            assert.strictEqual(h.state.workspace, current, "후보 계산만으로 현재 작업을 교체하면 안 됩니다.");
            assert.deepEqual(current, before);
            assertWork(candidate, values);
            assertRecoveryAndOutput(candidate, values);
          } else {
            await h.call(entry);
            assertWork(h.state.workspace, values);
            assertRecoveryAndOutput(h.state.workspace, values);
            assert.equal(h.log.saves.length, 1);
            assertWork(h.log.recovery.workspace, values);
            assert.equal(h.elements.downloadButton.disabled, false);
          }
          assert.deepEqual(Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]])), originalInputs);
        });
      }
    }
  }

  for (const kind of FILE_KINDS) {
    for (const failure of ["read-reject", "invalid-parse", "cancel"]) {
      await test(`${htmlPath}: ${kind} ${failure} preserves inputs/work/export/recovery`, async () => {
        const h = await harness(htmlPath);
        edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
        assertWork(h.state.workspace, POSITIVE);
        h.env.scheduleLocalSave();
        await h.call("downloadResult");
        assert.equal(h.log.exports.length, 1);
        const previousExport = clone(h.log.exports[0]);
        const previousRecovery = clone(h.log.recovery);
        const previousInputs = Object.fromEntries(FILE_KINDS.map((type) => [type, h.state[type]]));
        const previousWorkspace = h.state.workspace;
        const before = clone(previousWorkspace);
        h.env.readOperation = async () => {
          if (failure === "read-reject") throw new Error("INJECTED_READ_REJECT");
          return { ...clone(previousInputs[kind]), missingColumns: ["필수 열"], errors: [{ code: "INJECTED_INVALID_PARSE", message: "유효하지 않은 자료" }] };
        };
        await h.call("handleFile", kind, failure === "cancel" ? null : { name: "실패자료.xlsx", size: 32 });
        assert.strictEqual(h.state.workspace, previousWorkspace);
        assert.deepEqual(h.state.workspace, before);
        FILE_KINDS.forEach((type) => assert.strictEqual(h.state[type], previousInputs[type]));
        assert.equal(h.elements.downloadButton.disabled, false);
        assert.equal(h.elements.printButton.disabled, false);
        assert.deepEqual(h.log.recovery, previousRecovery);
        assert.equal(h.log.saves.length, 1, "실패한 입력이 정상 복구자료를 갱신하면 안 됩니다.");
        assert.equal(h.state.loading[kind], false);
        if (failure === "cancel") assert.equal(h.log.reads.length, 0);
        else assert.ok(h.log.toasts.some((toast) => toast.error));
        await h.call("downloadResult");
        assert.equal(h.log.exports.length, 2);
        assert.deepEqual(h.log.exports[1], previousExport);
        assertWork(JSON.parse(JSON.stringify(h.log.recovery)).workspace, POSITIVE);
      });
    }

    await test(`${htmlPath}: valid ${kind} read automatically replaces only its source and displays reviewed work`, async () => {
      const h = await harness(htmlPath);
      edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
      h.env.scheduleLocalSave();
      const previousRecovery = clone(h.log.recovery);
      const previousInputs = Object.fromEntries(FILE_KINDS.map((type) => [type, h.state[type]]));
      const replacement = { ...clone(h.state[kind]), fileName: `new-${kind}.xlsx`, fileHash: hash(`new-${kind}`) };
      h.env.readOperation = async () => replacement;
      await h.call("handleFile", kind, { name: replacement.fileName, size: 32 });
      assert.equal(h.state[kind].fileName, replacement.fileName);
      assert.equal(h.state[kind].fileHash, replacement.fileHash);
      FILE_KINDS.filter((type) => type !== kind).forEach((type) => assert.strictEqual(h.state[type], previousInputs[type]));
      const expected = kind === "orders" ? { ...POSITIVE, quantity: 10, unitPrice: 1000, purchase: "" }
        : kind === "inventory" ? { ...POSITIVE, inventory: 10 } : POSITIVE;
      assertWork(h.state.workspace, expected);
      assertRecoveryAndOutput(h.state.workspace, expected);
      assert.equal(h.state.activePreview, FILE_KIND_PREVIEWS[kind], "정상 새 자료는 추가 분석 없이 해당 종류의 현황을 표시해야 합니다.");
      assert.equal(h.elements.downloadButton.disabled, false);
      assert.deepEqual(h.log.saves[0], previousRecovery, "새 작업 저장이 이전 정상 복구자료를 삭제하면 안 됩니다.");
      assertWork(h.log.recovery.workspace, expected);
      assert.equal(h.log.saves.length, 2);
      assert.equal(h.state.loading[kind], false);
      assert.ok(h.log.toasts.some((toast) => !toast.error));
    });
  }

  for (const kind of ["inventory", "purchases"]) {
    await test(`${htmlPath}: ${kind} candidate preserves recovery source metadata and audit history`, async () => {
      const h = await harness(htmlPath);
      edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
      const replacement = { ...clone(h.state[kind]), fileName: `replacement-${kind}.xlsx`, fileHash: hash(`replacement-${kind}`) };
      h.state.workspace.systemHistory = {
        schemaVersion: "shipping-system-history/v1",
        events: [{ eventId: "review-edit-1", kind: "CELL_EDITED", field: "quantity", previousValue: 10, nextValue: 7, occurredAt: WHEN }],
      };
      h.state.workspace.substitutionHistory.events.push({
        eventId: "review-substitution-1", kind: "SUBSTITUTED", occurredAt: WHEN,
        fromProduct: { productCode: "0002", productName: "이전 상품" },
        toProduct: { productCode: "0001", productName: "합성상품" }, quantity: 7, customer: "거래처A",
      });
      const noticeId = h.state.workspace.notices[0]?.noticeId;
      assert.ok(noticeId, "전달사항 확인 보존용 fixture가 있어야 합니다.");
      engine.setNoticeAcknowledged(h.state.workspace, noticeId, true);
      h.state.workspace.sourceFiles.orders.sourceMetadata = { originalSheet: "주문", headerRow: 1, sourceColumns: [4, 5, 7], rawEvidence: ["", 0, "0", -2] };
      h.state.workspace.sourceFiles.inventory.sourceMetadata = { originalSheet: "재고", sourceColumns: [5, 6, 7] };
      h.state.workspace.orderOpsInputs.sales.sourceMetadata = { originalSheet: "판매", sourceRows: [2] };
      h.state.workspace = clone(engine.buildLocalRecoveryPayload(h.state.workspace, {}, {}, WHEN)).workspace;
      const previous = h.state.workspace;
      const before = clone(previous);
      // Old recovery records must not require the original File objects again.
      FILE_KINDS.forEach((type) => { h.state[type] = null; });
      h.state.validation = null;
      const result = await h.call("commitInputCandidates", new Map([[kind, replacement]]), { preferredKind: kind });
      const expected = kind === "inventory" ? { ...POSITIVE, inventory: 10 } : POSITIVE;
      assert.notStrictEqual(h.state.workspace, previous);
      assert.deepEqual(previous, before, "입력으로 쓴 복구 작업본도 불변이어야 합니다.");
      assertWork(h.state.workspace, expected);
      assertRecoveryAndOutput(h.state.workspace, expected);
      assert.deepEqual(clone(h.state.workspace.systemHistory), before.systemHistory);
      assert.deepEqual(clone(h.state.workspace.substitutionHistory), before.substitutionHistory);
      assert.deepEqual(clone(h.state.workspace.noticeAcknowledgements), before.noticeAcknowledgements);
      assert.deepEqual(clone(h.state.workspace.sourceFiles.orders), before.sourceFiles.orders);
      assert.deepEqual(clone(h.state.workspace.orderOpsInputs.sales), before.orderOpsInputs.sales);
      if (kind === "inventory") {
        assert.equal(h.state.workspace.sourceFiles.inventory.fileName, replacement.fileName);
        assert.equal(h.state.workspace.sourceFiles.inventory.sha256, replacement.fileHash);
        assert.equal(h.state.workspace.sourceFiles.inventory.sourceMetadata, undefined, "교체된 원본의 옛 좌표를 새 원본으로 이월하면 안 됩니다.");
        assert.deepEqual(clone(h.state.workspace.inventoryOverrides.cells), []);
      } else {
        assert.deepEqual(clone(h.state.workspace.sourceFiles.inventory), before.sourceFiles.inventory);
        assert.deepEqual(clone(h.state.workspace.inventoryOverrides), before.inventoryOverrides);
        assert.equal(h.state.workspace.orderOpsInputs.purchases.fileName, replacement.fileName);
      }
      assert.equal(result.workspace, h.state.workspace);
      assert.equal(result.previewKind, kind);
      assert.equal(h.state.activePreview, FILE_KIND_PREVIEWS[kind]);
      assert.equal(h.state.analysisRunning, false);
      assert.equal(h.log.saves.length, 1);
      assert.deepEqual(h.log.recovery.workspace.systemHistory, before.systemHistory);
      assert.deepEqual(h.log.recovery.workspace.sourceFiles.orders, before.sourceFiles.orders);
    });
  }

  await test(`${htmlPath}: recovered inventory removal and reinput preserve reviewed orders, suppliers and original sources`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    h.state.workspace.substitutionHistory.events.push({
      eventId: "retained-substitution-1", kind: "SUBSTITUTED", occurredAt: WHEN,
      fromProduct: { productCode: "0002", productName: "이전 상품" },
      toProduct: { productCode: "0001", productName: "합성상품" }, quantity: 7, customer: "거래처A",
    });
    const noticeId = h.state.workspace.notices[0]?.noticeId;
    assert.ok(noticeId, "전달사항 확인 보존용 fixture가 있어야 합니다.");
    engine.setNoticeAcknowledged(h.state.workspace, noticeId, true);
    h.state.workspace.sourceFiles.orders.intakeMapping = { draft: { sheetName: "주문", headerRow: 1, startRow: 2 } };
    h.state.workspace = clone(engine.buildLocalRecoveryPayload(h.state.workspace, {}, {}, WHEN)).workspace;
    const original = h.state.workspace;
    const before = clone(original);
    const purchaseInputs = clone(engine.getPurchaseInputs(original));
    FILE_KINDS.forEach((kind) => { h.state[kind] = null; });
    h.state.validation = null;
    h.env.scheduleLocalSave();
    const recoveryBefore = clone(h.log.recovery);

    await h.call("removePreparedKind", "inventory");
    assert.equal(h.state.workspace, null);
    assert.equal(h.state.inventory, null);
    assert.equal(h.state.activePreview, "allocations");
    assert.deepEqual(clone(h.state.orders.rows), before.orders);
    assert.deepEqual(clone(h.state.orders.sourceMatrix), before.sourceFiles.orders.matrix);
    assert.equal(h.state.orders.fileHash, before.sourceFiles.orders.sha256);
    assert.equal(h.state.orders.headerRowIndex, before.sourceFiles.orders.headerRowIndex);
    assert.deepEqual(clone(h.state.orders.headerMapping), before.sourceFiles.orders.headerMapping);
    assert.deepEqual(clone(h.state.orders.intakeMapping), before.sourceFiles.orders.intakeMapping);
    assert.deepEqual(clone(h.state.orders.preservedPurchaseInputs), purchaseInputs);
    for (const kind of ["purchases", "sales"]) {
      assert.deepEqual(clone(h.state[kind]), { ...before.orderOpsInputs[kind], rowCount: before.orderOpsInputs[kind].rows.length });
    }
    assert.notStrictEqual(h.state.orders.rows, original.orders);
    assert.notStrictEqual(h.state.orders.sourceMatrix, original.sourceFiles.orders.matrix);
    assert.match(h.elements.previewTable.innerHTML, /data-prepared-preview="orders"/);
    assert.doesNotMatch(h.elements.previewTable.innerHTML, /<th>(재고|잔량|구매수량)<\/th>/, "재고 해제 뒤 원자료 조회에 확정 계산값을 만들어내면 안 됩니다.");
    assert.match(h.elements.resultSubtitle.textContent, /미확인/);
    assert.equal(h.elements.downloadButton.disabled, true);
    assert.deepEqual(h.log.recovery, recoveryBefore, "재고 해제가 이전 정상 복구 작업을 덮어쓰면 안 됩니다.");

    const replacement = { ...inputs().inventory, fileName: "reinput-inventory.xlsx", fileHash: hash("reinput-inventory") };
    h.env.readOperation = async () => replacement;
    await h.call("handleFile", "inventory", { name: replacement.fileName, size: 32 });
    const expected = { ...POSITIVE, inventory: 10 };
    assertWork(h.state.workspace, expected);
    assertRecoveryAndOutput(h.state.workspace, expected);
    assert.deepEqual(clone(engine.getPurchaseInputs(h.state.workspace)), purchaseInputs);
    assert.deepEqual(clone(h.state.workspace.substitutionHistory), before.substitutionHistory);
    assert.deepEqual(clone(h.state.workspace.noticeAcknowledgements), before.noticeAcknowledgements);
    assert.deepEqual(clone(h.state.workspace.sourceFiles.orders), before.sourceFiles.orders);
    assert.deepEqual(clone(h.state.workspace.orderOpsInputs), before.orderOpsInputs);
    assert.equal(h.state.workspace.sourceFiles.inventory.fileName, replacement.fileName);
    assert.equal(h.state.workspace.sourceFiles.inventory.sha256, replacement.fileHash);
    assert.deepEqual(clone(h.state.workspace.inventoryOverrides.cells), [], "해제한 재고의 보정값이 새 재고로 이월되면 안 됩니다.");
    assert.equal(h.state.activePreview, "inventory");
    assert.equal(h.log.saves.length, 2);
    assert.deepEqual(h.log.saves[0], recoveryBefore);
    assertWork(h.log.recovery.workspace, expected);
    assert.deepEqual(original, before, "해제·재입력에 사용한 복구 원본은 변경되면 안 됩니다.");
  });

  await test(`${htmlPath}: candidate calculation throw leaves inputs/work/export/recovery untouched`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    h.env.scheduleLocalSave();
    await h.call("downloadResult");
    const current = h.state.workspace;
    const before = clone(current);
    const previousInputs = Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]]));
    const recovery = clone(h.log.recovery);
    const replacement = { ...clone(h.state.inventory), fileName: "candidate-inventory.xlsx", fileHash: hash("candidate-inventory") };
    h.env.engine = { ...engine, recalculateWorkspace() { throw new Error("INJECTED_CANDIDATE_CALCULATION_FAILURE"); } };
    await assert.rejects(h.call("commitInputCandidates", new Map([["inventory", replacement]])), /INJECTED_CANDIDATE_CALCULATION_FAILURE/);
    assert.strictEqual(h.state.workspace, current);
    assert.deepEqual(current, before);
    FILE_KINDS.forEach((kind) => assert.strictEqual(h.state[kind], previousInputs[kind]));
    assert.deepEqual(h.log.recovery, recovery);
    assert.equal(h.log.saves.length, 1);
    assert.equal(h.elements.downloadButton.disabled, false);
    assert.equal(h.elements.printButton.disabled, false);
    assert.equal(h.state.analysisRunning, false);
    h.env.engine = engine;
    await h.call("downloadResult");
    assert.deepEqual(h.log.exports[1], h.log.exports[0]);
    assertRecoveryAndOutput(current, POSITIVE);
  });

  await test(`${htmlPath}: pending read blocks double-file, reanalysis and refresh without clearing active work`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    const current = h.state.workspace;
    const input = h.state.orders;
    let rejectRead;
    h.env.readOperation = () => new Promise((_resolve, reject) => { rejectRead = reject; });
    const read = h.call("handleFile", "orders", { name: "대기.xlsx", size: 32 });
    read.catch(() => {}); // Keep unexpected harness failures attached until finally awaits them.
    try {
      assert.strictEqual(h.state.workspace, current);
      assert.strictEqual(h.state.orders, input);
      assert.equal(h.elements.downloadButton.disabled, false);
      await h.call("handleFile", "inventory", { name: "중복읽기.xlsx", size: 32 });
      await h.call("runAnalysis");
      await h.call("refreshCurrentSession");
      assert.deepEqual(h.log.reads, ["orders"]);
      assert.equal(h.log.saves.length, 0);
      assert.strictEqual(h.state.workspace, current);
      assert.strictEqual(h.state.orders, input);
      assert.ok(h.log.toasts.some((toast) => toast.error && /끝난 뒤/.test(toast.message)));
    } finally {
      if (typeof rejectRead === "function") rejectRead(new Error("INJECTED_DELAYED_REJECT"));
      await read;
    }
    assert.strictEqual(h.state.workspace, current);
    assert.strictEqual(h.state.orders, input);
  });

  for (const failure of ["classification-reject", "duplicate-kind"]) {
    await test(`${htmlPath}: bundle ${failure} preserves every input and saved result`, async () => {
      const h = await harness(htmlPath);
      edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
      h.env.scheduleLocalSave();
      const recovery = clone(h.log.recovery);
      const current = h.state.workspace;
      const before = clone(current);
      const previous = Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]]));
      h.env.classifyOperation = async (file) => {
        if (failure === "classification-reject" && file.name === "second.xlsx") throw new Error("INJECTED_CLASSIFICATION_REJECT");
        return { kind: "orders", parsed: { ...clone(previous.orders), fileName: file.name, fileHash: hash(file.name) } };
      };
      await h.call("handleBundleFiles", [{ name: "first.xlsx", size: 32 }, { name: "second.xlsx", size: 32 }]);
      assert.strictEqual(h.state.workspace, current);
      assert.deepEqual(current, before);
      FILE_KINDS.forEach((kind) => assert.strictEqual(h.state[kind], previous[kind]));
      assert.deepEqual(h.log.recovery, recovery);
      assert.equal(h.log.saves.length, 1);
      assert.equal(h.elements.downloadButton.disabled, false);
      assert.equal(h.state.loading.bundle, false);
      assert.ok(h.log.toasts.some((toast) => toast.error));
      assertRecoveryAndOutput(current, POSITIVE);
    });
  }

  for (const [scenario, rejectedFile, shouldRetain] of [
    ["unsupported-extension", { name: "renamed-workbook.txt", size: 32 }, false],
    ["oversized-workbook", { name: "oversized.xlsx", size: 25 * 1024 * 1024 + 1 }, false],
    ["supported-mapping-error", { name: "mapping-review.xlsx", size: 32 }, true],
  ]) {
    await test(`${htmlPath}: bundle ${scenario} respects candidate intake limits without discarding current work`, async () => {
      const h = await harness(htmlPath);
      edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
      h.env.scheduleLocalSave();
      const recovery = clone(h.log.recovery);
      const current = h.state.workspace;
      const before = clone(current);
      const previous = Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]]));
      const retained = [];
      const remembered = [];
      let applied = 0;
      const rejection = new Error(`INJECTED_${scenario}`);
      h.env.preparationController = {
        isBusy: () => false, refresh() {}, markFailed() {},
        markApplied() { applied += 1; },
        rememberParsed(parsed) { remembered.push(parsed.fileName); },
        async retainCandidate(file, { error }) { retained.push(file); assert.strictEqual(error, rejection); },
      };
      // Only classification outcomes are injected; the actual extracted batch
      // handler must decide which rejected File may enter the re-read pathway.
      h.env.classifyOperation = async (file) => {
        if (file === rejectedFile) throw rejection;
        return { kind: "inventory", parsed: { ...clone(previous.inventory), fileName: file.name, fileHash: hash(file.name) } };
      };
      await h.call("handleBundleFiles", [rejectedFile, { name: "valid-inventory.xlsx", size: 32 }]);
      assert.deepEqual(retained, shouldRetain ? [rejectedFile] : [], "형식·크기 거부 파일은 재읽기·수동 반영 후보로 들어가면 안 됩니다.");
      assert.deepEqual(remembered, ["valid-inventory.xlsx"], "같이 선택한 정상 파일의 후보는 남아야 합니다.");
      assert.equal(applied, 0);
      assert.strictEqual(h.state.workspace, current);
      assert.deepEqual(current, before);
      FILE_KINDS.forEach((kind) => assert.strictEqual(h.state[kind], previous[kind]));
      assert.deepEqual(h.log.recovery, recovery);
      assert.equal(h.log.saves.length, 1);
      assert.equal(h.elements.downloadButton.disabled, false);
      assert.equal(h.state.loading.bundle, false);
      assert.ok(h.log.toasts.some((toast) => toast.error && toast.message.includes(rejection.message)));
      assertRecoveryAndOutput(current, POSITIVE);
    });
  }

  await test(`${htmlPath}: integrated all-failed read preserves metadata, work and recovery`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    h.env.scheduleLocalSave();
    const recovery = clone(h.log.recovery);
    const current = h.state.workspace;
    const before = clone(current);
    const previous = Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]]));
    const metadata = { fileName: "previous-integrated.xlsx", applied: new Map([["orders", h.state.orders]]), failures: [] };
    h.state.integratedFile = metadata;
    h.env.integratedOperation = async () => ({ fileName: "failed-integrated.xlsx", applied: new Map(), failures: [{ kind: "orders", message: "INJECTED_ALL_SHEETS_FAILED" }] });
    await h.call("handleIntegratedFile", { name: "failed-integrated.xlsx", size: 32 });
    assert.strictEqual(h.state.integratedFile, metadata);
    assert.strictEqual(h.state.workspace, current);
    assert.deepEqual(current, before);
    FILE_KINDS.forEach((kind) => assert.strictEqual(h.state[kind], previous[kind]));
    assert.deepEqual(h.log.recovery, recovery);
    assert.equal(h.log.saves.length, 1);
    assert.equal(h.elements.downloadButton.disabled, false);
    assert.equal(h.state.loading.integrated, false);
    assert.ok(h.log.toasts.some((toast) => toast.error));
    assertRecoveryAndOutput(current, POSITIVE);
  });

  await test(`${htmlPath}: integrated partial success replaces only valid kinds and preserves failed inputs`, async () => {
    const h = await harness(htmlPath);
    edit(h.state.workspace, POSITIVE, EDIT_ORDERS[1][1]);
    h.env.scheduleLocalSave();
    const recovery = clone(h.log.recovery);
    const previous = Object.fromEntries(FILE_KINDS.map((kind) => [kind, h.state[kind]]));
    const purchases = { ...clone(h.state.purchases), fileName: "new-purchases.xlsx", fileHash: hash("partial-success") };
    const result = { fileName: "partial.xlsx", applied: new Map([["purchases", purchases]]), failures: [{ kind: "inventory", message: "INJECTED_INVENTORY_FAILURE" }] };
    h.env.integratedOperation = async () => result;
    await h.call("handleIntegratedFile", { name: "partial.xlsx", size: 32 });
    assert.strictEqual(h.state.purchases, purchases);
    for (const kind of ["orders", "inventory", "sales"]) assert.strictEqual(h.state[kind], previous[kind]);
    assert.strictEqual(h.state.integratedFile, result);
    assertWork(h.state.workspace, POSITIVE);
    assertRecoveryAndOutput(h.state.workspace, POSITIVE);
    assert.equal(h.state.activePreview, "purchases", "통합파일의 주문 시트가 없으면 실제로 반영된 구매 현황을 표시해야 합니다.");
    assert.equal(h.elements.downloadButton.disabled, false);
    assert.deepEqual(h.log.saves[0], recovery);
    assertWork(h.log.recovery.workspace, POSITIVE);
    assert.equal(h.log.saves.length, 2);
    assert.equal(h.state.loading.integrated, false);
    assert.ok(h.log.toasts.some((toast) => /기존 데이터 유지/.test(toast.message)));
  });
}

const failed = results.filter((result) => !result.pass);
console.log(`ORDER Q work preservation: ${results.length - failed.length}/${results.length} passed (exact HTML handlers, engine, JSON recovery, XLSX values; isolated DOM/read adapters).`);
if (failed.length) process.exitCode = 1;
