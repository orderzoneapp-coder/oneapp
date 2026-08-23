import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "MerchOps.html"), "utf8");
const coreSource = fs.readFileSync(path.join(ROOT, "coreEngine.js"), "utf8");
const F8_START = "    const handleQuickExcelExport = useCallback(async () => {";
const F8_END = "    // [M-MASTER-COMMIT-01] F7 마스터 적용";
const INVENTORY_MODULE_START = "        window.MERCH_INVENTORY_F8_MODULE = window.MERCH_INVENTORY_F8_MODULE || (() => {";
const INVENTORY_MODULE_END = "        // 1재고현황 1행 메타 정책:";
const f8Start = html.indexOf(F8_START);
const f8End = html.indexOf(F8_END, f8Start);
const inventoryModuleStart = html.indexOf(INVENTORY_MODULE_START);
const inventoryModuleEnd = html.indexOf(INVENTORY_MODULE_END, inventoryModuleStart);
assert.ok(f8Start >= 0 && f8End > f8Start, "Quick F8 implementation was not found");
assert.ok(inventoryModuleStart >= 0 && inventoryModuleEnd > inventoryModuleStart, "inventory F8 module was not found");
const f8Declaration = html.slice(f8Start, f8End);
const inventoryModuleDeclaration = html.slice(inventoryModuleStart, inventoryModuleEnd);

const sheetJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const expectedSheetJsSha256 = "c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99";
const response = await fetch(sheetJsUrl);
assert.equal(response.ok, true, `SheetJS download failed: ${response.status}`);
const sheetJsSource = Buffer.from(await response.arrayBuffer());
assert.equal(
  crypto.createHash("sha256").update(sheetJsSource).digest("hex"),
  expectedSheetJsSha256,
  "SheetJS asset hash changed",
);

const tempDir = fs.mkdtempSync(path.join(ROOT, ".tmp-merchops-f8-"));
const normalizeCode = (value) => String(value ?? "").replace(/\s/g, "").replace(/\.0$/, "");
const parseNum = (value) => {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

const makeInventoryDateKey = (value, baseDate = "") => {
  const raw = String(value ?? "").trim();
  const full = raw.match(/(\d{4})[.\/\-](\d{1,2})[.\/\-](\d{1,2})/);
  if (full) return (Number(full[1]) * 10000) + (Number(full[2]) * 100) + Number(full[3]);
  const short = raw.match(/(\d{1,2})[.\/\-](\d{1,2})/);
  if (!short) return 99999999;
  const baseYear = String(baseDate || "").match(/(\d{4})/)?.[1] || "2026";
  return (Number(baseYear) * 10000) + (Number(short[1]) * 100) + Number(short[2]);
};

const makeContext = (scenarioName) => {
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
    Promise,
    Uint8Array,
    ArrayBuffer,
    Intl,
    setTimeout,
    clearTimeout,
  });
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.runInContext(coreSource, context, { filename: "coreEngine.js" });
  vm.runInContext(sheetJsSource.toString("utf8"), context, { filename: "xlsx.full.min.js" });
  assert.ok(context.XLSX?.utils, "SheetJS did not initialize");

  const writtenFiles = [];
  const realXlsx = context.XLSX;
  realXlsx.writeFile = (workbook, filename, options = {}) => {
    const writtenFile = path.join(tempDir, `${scenarioName}-${path.basename(filename)}`);
    const bookType = options.bookType || "xlsx";
    const array = realXlsx.write(workbook, { ...options, bookType, type: "array" });
    fs.writeFileSync(writtenFile, Buffer.from(new Uint8Array(array)));
    writtenFiles.push(writtenFile);
  };

  Object.assign(context.window, {
    XLSX: realXlsx,
    confirm: () => true,
    normalizeProductCodeText: normalizeCode,
    hasOwnField: hasOwn,
    isBlankCell: (value) => value === undefined || value === null || String(value).trim() === "",
    parseNum,
    getInventoryPurchaseDateKey: makeInventoryDateKey,
    getCurrentMerchSourceRole: (sources = {}, fallback = "") => {
      const roles = [sources._activeRole, fallback, "estimate", "purchase", "sales", "inventory", "info", "catalog", "parser"].filter(Boolean);
      return roles.find((role) => {
        const source = sources[role];
        return source && typeof source === "object" && Object.keys(source).some((key) => !key.startsWith("_"));
      }) || "";
    },
    hasMerchSourceObjectData: (value) =>
      !!(value && typeof value === "object" && Object.keys(value).some((key) => !key.startsWith("_"))),
    getWorkingSourcePriority: (sources = {}) => {
      const active = context.window.getCurrentMerchSourceRole(sources);
      return [active, "estimate", "purchase", "sales", "inventory", "info", "catalog", "parser"].filter((role, index, roles) => role && roles.indexOf(role) === index && sources[role]);
    },
    getTableValueFromRow: (row = {}, field, defaultValue = "") => {
      if (hasOwn(row.finalData, field)) return row.finalData[field] ?? "";
      for (const role of context.window.getWorkingSourcePriority(row.sources || {})) {
        if (hasOwn(row.sources?.[role], field)) return row.sources[role][field] ?? "";
      }
      return defaultValue;
    },
    getTableValueByAliases: (row = {}, aliases = [], defaultValue = "") => {
      for (const key of aliases) if (hasOwn(row.finalData, key)) return row.finalData[key] ?? "";
      for (const role of context.window.getWorkingSourcePriority(row.sources || {})) {
        for (const key of aliases) if (hasOwn(row.sources?.[role], key)) return row.sources[role][key] ?? "";
      }
      return defaultValue;
    },
    getMerchMasterItemForRow: (masterProducts = {}, row = {}) => masterProducts[normalizeCode(row.코드)] || {},
    resolveMerchWorkingField: (row = {}, master = {}, field = "", options = {}) => {
      const aliases = Array.from(new Set([field, ...(options.aliases || [])]));
      for (const [origin, obj] of [["direct", row.finalData || {}], ...context.window.getWorkingSourcePriority(row.sources || {}).map((role) => [`source:${role}`, row.sources?.[role] || {}])]) {
        for (const key of aliases) {
          if (!hasOwn(obj, key)) continue;
          const value = obj[key] ?? "";
          return { value, origin, isWorkingValue: true, isExplicitBlank: String(value).trim() === "", field: key };
        }
      }
      const masterKey = aliases.find((key) => hasOwn(master, key));
      return { value: masterKey ? (master[masterKey] ?? "") : "", origin: "master-reference", isWorkingValue: false, isExplicitBlank: false, field: masterKey || field };
    },
    getMerchExplicitSaleAvailability: (row = {}) => {
      const state = context.window.resolveMerchWorkingField(row, {}, "판매여부", { aliases: ["판매여부", "판매"] });
      if (state.isWorkingValue && state.isExplicitBlank) return { hasValue: true, code: "", isExplicitBlank: true };
      if (state.isWorkingValue) return { hasValue: true, code: String(parseNum(state.value) === 0 ? 0 : 1) };
      return { hasValue: false, code: "" };
    },
    resolveMerchSaleAvailability: (row = {}, master = {}) => {
      const explicit = context.window.getMerchExplicitSaleAvailability(row);
      if (explicit.hasValue) return explicit;
      if (hasOwn(master, "판매여부") && String(master.판매여부 ?? "").trim() !== "") {
        return { hasValue: true, code: String(parseNum(master.판매여부) === 0 ? 0 : 1) };
      }
      return { hasValue: false, code: "" };
    },
    shouldUseMasterMarketPriceForRole: (role = "") => ["purchase", "inventory"].includes(role),
    resolvePromotionThemeByPriority: (finalData = {}, sources = {}, master = {}) => {
      if (hasOwn(finalData, "행사테마")) return finalData.행사테마;
      for (const role of context.window.getWorkingSourcePriority(sources)) {
        if (hasOwn(sources[role], "행사테마")) return sources[role].행사테마;
      }
      return master.행사테마 || "";
    },
    normalizePromotionThemeValue: (...objects) => objects.map((obj) => obj?.행사테마).find(Boolean) || "",
    getMerchLocalDateStamp: () => "2026-08-05",
  });
  context.getEffectivePromoPriceForMargin = (row = {}, master = {}) => {
    if (hasOwn(row.finalData, "행사가")) return parseNum(row.finalData.행사가);
    for (const role of context.window.getWorkingSourcePriority(row.sources || {})) {
      if (hasOwn(row.sources?.[role], "행사가")) return parseNum(row.sources[role].행사가);
    }
    return parseNum(master.행사가);
  };
  vm.runInContext(inventoryModuleDeclaration, context, { filename: "MerchOps-inventory-F8-module.js" });
  return { context, realXlsx, writtenFiles };
};

const makeRow = ({ code, role, source = {}, finalData = {}, inputOrder = 0 }) => ({
  코드: code,
  _managedKey: role === "inventory" ? `${code}__INV__${inputOrder}` : code,
  _lastUploadRole: role,
  sources: {
    _activeRole: role,
    [role]: role === "inventory" ? { ...source, 품목코드: code, _inventoryInputOrder: inputOrder } : { ...source, 품목코드: code },
  },
  finalData: { ...finalData },
});

const runF8Scenario = async ({ name, rows, masterProducts = {}, snapshotRows = null, aggregateTransform = null }) => {
  const { context, realXlsx, writtenFiles } = makeContext(name);
  const toasts = [];
  const alerts = [];
  const managedRows = snapshotRows || rows;
  Object.assign(context, {
    useCallback: (fn) => fn,
    fullDisplayRows: rows,
    quickExcelInFlightRef: { current: false },
    quickExcelReadyRef: { current: { ready: false, at: 0, count: 0, codes: [], rows: [] } },
    collectWholesaleBelowCostWarnings: () => [],
    data: {
      masterProducts,
      managedItems: Object.fromEntries(managedRows.map((row, index) => [row._managedKey || `${row.코드}-${index}`, row])),
    },
    ui: {
      filterSteps: [],
      disabledFilterStepIds: [],
      selectedRows: new Set(),
      showToast: (message) => toasts.push(String(message)),
      setAlertMsg: (message) => alerts.push(String(message)),
    },
  });
  if (snapshotRows) {
    const baseModule = context.window.MERCH_INVENTORY_F8_MODULE;
    context.window.__MERCHOPS_INVENTORY_F8_SOURCE_SNAPSHOT = baseModule.captureSourceSnapshot(snapshotRows, { basisDate: "2026-08-04" });
    if (aggregateTransform) {
      context.window.MERCH_INVENTORY_F8_MODULE = Object.freeze({
        ...baseModule,
        aggregateRows: (targetRows) => aggregateTransform(baseModule.aggregateRows(targetRows), baseModule),
      });
    }
  }
  vm.runInContext(`${f8Declaration}\nglobalThis.__runQuickF8 = handleQuickExcelExport;`, context, {
    filename: "MerchOps-F8.js",
  });
  await context.__runQuickF8();
  const writtenFile = writtenFiles.at(-1) || "";
  const reopened = writtenFile ? realXlsx.read(fs.readFileSync(writtenFile), { type: "buffer" }) : null;
  return { context, reopened, writtenFile, toasts, alerts };
};

try {
  // 대표 Lot 기준: 유효한 최신일 우선, 공란일 후순위, 동일일과 전체 공란은 단가와 무관하게 첫 원본 입력순서 우선.
  const representativeEnv = makeContext("representative");
  const inventoryModule = representativeEnv.context.window.MERCH_INVENTORY_F8_MODULE;
  const representativeRows = [
    makeRow({ code: "R1", role: "inventory", inputOrder: 0, source: { 기록: "", 재고수량: 1, 입고가: 50000, 구매처: "공란일" } }),
    makeRow({ code: "R1", role: "inventory", inputOrder: 1, source: { 기록: "2026-08-03", 재고수량: 2, 입고가: 10000, 구매처: "과거" } }),
    makeRow({ code: "R1", role: "inventory", inputOrder: 2, source: { 기록: "2026-08-04", 재고수량: 3, 입고가: 0, 구매처: "최근0" } }),
    makeRow({ code: "R1", role: "inventory", inputOrder: 3, source: { 기록: "2026-08-04", 재고수량: 4, 입고가: 20000, 구매처: "최근고가" } }),
    makeRow({ code: "R1", role: "inventory", inputOrder: 4, source: { 기록: "2026-08-04", 재고수량: 5, 입고가: 20000, 구매처: "최근동률후행" } }),
  ];
  const representative = inventoryModule.selectLatestRepresentative(representativeRows);
  assert.equal(representative.sources.inventory.구매처, "최근0", "same-date latest ties must preserve the first source input row even when its price is zero");
  const sourceBeforeAggregate = JSON.parse(JSON.stringify(representativeRows));
  const aggregatedRepresentativeRows = inventoryModule.aggregateRows(representativeRows);
  assert.deepEqual(JSON.parse(JSON.stringify(representativeRows)), sourceBeforeAggregate, "inventory aggregation must not mutate source LOT rows");
  assert.equal(aggregatedRepresentativeRows.length, 1);
  assert.equal(aggregatedRepresentativeRows[0].sources.inventory.재고수량, 15);
  assert.equal(aggregatedRepresentativeRows[0]._inventoryF8RepresentativePrice, 0);
  const allBlankRepresentative = inventoryModule.selectLatestRepresentative([
    makeRow({ code: "R2", role: "inventory", inputOrder: 0, source: { 기록: "", 재고수량: 1, 입고가: 0, 구매처: "공란첫행" } }),
    makeRow({ code: "R2", role: "inventory", inputOrder: 1, source: { 기록: "", 재고수량: 1, 입고가: 90000, 구매처: "공란고가후행" } }),
  ]);
  assert.equal(allBlankRepresentative.sources.inventory.구매처, "공란첫행", "all-blank dates must preserve the first source input row regardless of price");

  const diagnosticSnapshot = inventoryModule.captureSourceSnapshot([
    makeRow({ code: "A", role: "inventory", inputOrder: 0, source: { 기록: "2026-08-01", 재고수량: 2, 입고가: 100 } }),
    makeRow({ code: "B", role: "inventory", inputOrder: 1, source: { 기록: "2026-08-02", 재고수량: 3, 입고가: 200 } }),
  ]);
  const validShop = [["A", "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "", "", "1", 2], ["B", "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "", "", "1", 3]];
  const validErp = [["A"], ["B"]];
  assert.equal(inventoryModule.validateOutput(diagnosticSnapshot, validShop, validErp).ok, true);
  const directDiagnostics = {
    missing: inventoryModule.validateOutput(diagnosticSnapshot, validShop.slice(1), validErp.slice(1)),
    duplicate: inventoryModule.validateOutput(diagnosticSnapshot, [validShop[0], validShop[0], validShop[1]], [["A"], ["A"], ["B"]]),
    extra: inventoryModule.validateOutput(diagnosticSnapshot, [...validShop, ["X", "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "", "", "1", 4]], [...validErp, ["X"]]),
    total: inventoryModule.validateOutput(diagnosticSnapshot, [["A", "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "", "", "1", 3], validShop[1]], validErp),
    order: inventoryModule.validateOutput(diagnosticSnapshot, validShop, [["B"], ["A"]]),
  };
  assert.deepEqual(Array.from(directDiagnostics.missing.missingCodes), ["A"]);
  assert.deepEqual(Array.from(directDiagnostics.duplicate.duplicateCodes), ["A"]);
  assert.deepEqual(Array.from(directDiagnostics.extra.extraNonZeroCodes), ["X"]);
  assert.equal(directDiagnostics.total.stockDifference, 1);
  assert.equal(directDiagnostics.order.orderMatches, false);
  Object.values(directDiagnostics).forEach((result) => assert.equal(result.ok, false));

  // 입고가가 있는 비재고 상품과 소분행은 판매여부 1·재고수량 999를 출력하고 테마는 변경하지 않는다.
  const estimateRow = makeRow({
    code: "20010001",
    role: "estimate",
    source: {
      품목명: "견적 F8 회귀상품", 규격: "1kg", 입고가: 10000, 출고가: 13000, 행사가: 12000,
      도매A: 11500, 판매여부: 1, 재고수량: 0, 테마1: 1, 상품태그: "회귀검증",
      "1종코드": "20010002", "1종규격": "100g", "1종연산": 10, 외주비: 0, 경비: 50,
    },
  });
  const estimateResult = await runF8Scenario({
    name: "estimate",
    rows: [estimateRow],
    masterProducts: { "20010002": { 품목명: "견적 소분상품", 규격: "100g" } },
  });
  assert.ok(estimateResult.writtenFile && fs.statSync(estimateResult.writtenFile).size > 1000);
  assert.deepEqual(Array.from(estimateResult.reopened.SheetNames), ["쇼핑몰업로드", "ERP업데이트"]);
  const estimateShop = estimateResult.context.XLSX.utils.sheet_to_json(estimateResult.reopened.Sheets["쇼핑몰업로드"], { header: 1, raw: true });
  const estimateErp = estimateResult.context.XLSX.utils.sheet_to_json(estimateResult.reopened.Sheets["ERP업데이트"], { header: 1, raw: true, defval: "" });
  assert.equal(estimateShop.length - 1, 2, "estimate F8 subdivision row must remain");
  assert.equal(estimateShop[1][14], "1", "priced estimate row must be sale-enabled");
  assert.equal(estimateShop[1][15], 999, "priced estimate row must receive shopping-mall stock 999");
  assert.deepEqual(Array.from(estimateShop[1].slice(16, 21)), ["1", "", "", "", ""], "priced estimate row themes must remain unchanged");
  assert.equal(estimateShop[2][0], "20010002");
  assert.equal(estimateShop[2][14], "1", "priced subdivision row must be sale-enabled");
  assert.equal(estimateShop[2][15], 999, "priced subdivision row must receive shopping-mall stock 999");
  assert.deepEqual(Array.from(estimateShop[2].slice(16, 21)), ["1", "", "", "", ""], "subdivision themes must remain unchanged");
  assert.deepEqual(Array.from(estimateErp[0]), ['품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n'],
    "F8 ERP upload must end at the wholesale-B helper column");
  assert.ok(estimateErp.slice(1).every((row) => row.length === 11),
    "main and subdivision ERP rows must contain exactly 11 columns");

  const inboundDefaultsResult = await runF8Scenario({
    name: "inbound-shop-defaults",
    rows: [
      makeRow({ code: "IP1", role: "purchase", source: { 품목명: "입고가 있음", 입고가: 9000, 출고가: 11000, 판매여부: 0, 재고수량: 3, 행사테마: "1,4" } }),
      makeRow({ code: "IP0", role: "purchase", source: { 품목명: "입고가 0", 입고가: 0, 출고가: 11000, 판매여부: 0, 재고수량: 4, 행사테마: "2" } }),
      makeRow({ code: "IPB", role: "purchase", source: { 품목명: "입고가 공란", 입고가: "", 출고가: 11000, 판매여부: "", 재고수량: "", 행사테마: "3" } }),
      makeRow({ code: "IPM", role: "purchase", source: { 품목명: "입고가 없음 마스터 보강", 출고가: 11000 } }),
    ],
    masterProducts: { IPM: { 판매여부: 1, 재고수량: 7 } },
  });
  const inboundDefaultsShop = inboundDefaultsResult.context.XLSX.utils.sheet_to_json(inboundDefaultsResult.reopened.Sheets["쇼핑몰업로드"], { header: 1, raw: true, defval: "" });
  assert.equal(inboundDefaultsShop[1][14], "1", "positive inbound price must override sale availability to 1");
  assert.equal(inboundDefaultsShop[1][15], 999, "positive inbound price must override stock to 999");
  assert.deepEqual(Array.from(inboundDefaultsShop[1].slice(16, 21)), ["1", "", "", "1", ""], "positive inbound price must not add or remove themes");
  assert.equal(inboundDefaultsShop[2][14], "0", "zero inbound price must preserve existing sale availability");
  assert.equal(inboundDefaultsShop[2][15], 4, "zero inbound price must preserve existing stock");
  assert.deepEqual(Array.from(inboundDefaultsShop[2].slice(16, 21)), ["", "1", "", "", ""], "zero inbound price must preserve themes");
  assert.equal(inboundDefaultsShop[3][14], "", "blank inbound price must preserve blank sale availability");
  assert.equal(inboundDefaultsShop[3][15], "", "blank inbound price must preserve blank stock");
  assert.deepEqual(Array.from(inboundDefaultsShop[3].slice(16, 21)), ["", "", "1", "", ""], "blank inbound price must preserve themes");
  assert.equal(inboundDefaultsShop[4][14], "1", "missing inbound price must preserve the existing master sale fallback");
  assert.equal(inboundDefaultsShop[4][15], 7, "missing inbound price must preserve the existing master stock fallback");
  assert.deepEqual(Array.from(inboundDefaultsShop[4].slice(16, 21)), ["", "", "", "", ""], "missing inbound price must not add theme 2");

  const purchaseRow = makeRow({
    code: "30010001",
    role: "purchase",
    source: {
      품목명: "구매 F8 회귀상품", 규격: "1kg", 입고가: 10000, 출고가: 15000, 판매여부: 1, 재고수량: 5,
      "1종코드": "30010002", "1종규격": "100g", "1종연산": 10, 외주비: 0, 경비: 0,
    },
  });
  const purchaseResult = await runF8Scenario({
    name: "purchase",
    rows: [purchaseRow],
    masterProducts: { "30010002": { 품목명: "구매 소분상품", 규격: "100g" } },
  });
  const purchaseShop = purchaseResult.context.XLSX.utils.sheet_to_json(purchaseResult.reopened.Sheets["쇼핑몰업로드"], { header: 1, raw: true });
  assert.equal(purchaseShop.length - 1, 2, "purchase F8 subdivision row must remain");
  assert.equal(purchaseShop[1][14], "1");
  assert.equal(purchaseShop[1][15], 999, "priced purchase row must receive shopping-mall stock 999");
  assert.equal(purchaseShop[2][0], "30010002");
  assert.equal(purchaseShop[2][14], "1");
  assert.equal(purchaseShop[2][15], 999, "priced subdivision row must receive shopping-mall stock 999");

  const inventoryDefaultsGuardRow = makeRow({
    code: "INV1",
    role: "inventory",
    source: { 품목명: "재고 계약 보존", 입고가: 5000, 출고가: 7000, 판매여부: 0, 재고수량: 6, 행사테마: "2" },
  });
  const inventoryDefaultsGuardResult = await runF8Scenario({
    name: "inventory-defaults-guard",
    rows: [inventoryDefaultsGuardRow],
    snapshotRows: [inventoryDefaultsGuardRow],
  });
  const inventoryDefaultsGuardShop = inventoryDefaultsGuardResult.context.XLSX.utils.sheet_to_json(inventoryDefaultsGuardResult.reopened.Sheets["쇼핑몰업로드"], { header: 1, raw: true, defval: "" });
  assert.equal(inventoryDefaultsGuardShop[1][14], "0", "inventory F8 sale availability must not be overridden");
  assert.equal(inventoryDefaultsGuardShop[1][15], 6, "inventory F8 must preserve the actual aggregated stock");
  assert.deepEqual(Array.from(inventoryDefaultsGuardShop[1].slice(16, 21)), ["", "1", "", "", ""], "inventory F8 themes must remain unchanged");

  // 네 오류 유형이 실제 F8 파일 쓰기 전에 전체 출력을 차단하고 진단을 남기는지 확인한다.
  const blockerRows = [
    makeRow({ code: "A", role: "inventory", inputOrder: 0, source: { 품목명: "A", 기록: "2026-08-01", 재고수량: 2, 입고가: 100 } }),
    makeRow({ code: "B", role: "inventory", inputOrder: 1, source: { 품목명: "B", 기록: "2026-08-02", 재고수량: 3, 입고가: 200 } }),
  ];
  const blockCases = [
    { name: "block-missing", transform: (rows) => rows.slice(1), expected: "누락 1코드: A" },
    { name: "block-duplicate", transform: (rows) => [rows[0], rows[0], rows[1]], expected: "동일 상품코드가 중복되어 F8 출력을 차단했습니다: A" },
    { name: "block-extra", transform: (rows) => [...rows, { ...rows[0], 코드: "X", _managedKey: "X__INV_F8", sources: { ...rows[0].sources, inventory: { ...rows[0].sources.inventory, 품목코드: "X", 재고: 4, 재고수량: 4 } }, finalData: { ...rows[0].finalData, 재고: 4, 재고수량: 4 } }], expected: "원본 외 비영재고 1코드 / 수량 4: X" },
    { name: "block-total", transform: (rows) => [{ ...rows[0], sources: { ...rows[0].sources, inventory: { ...rows[0].sources.inventory, 재고: 3, 재고수량: 3 } }, finalData: { ...rows[0].finalData, 재고: 3, 재고수량: 3 } }, rows[1]], expected: "재고합계 차이 +1" },
  ];
  for (const blockCase of blockCases) {
    const result = await runF8Scenario({
      name: blockCase.name,
      rows: blockerRows,
      snapshotRows: blockerRows,
      masterProducts: { A: { 출고가: 100, 판매여부: 1 }, B: { 출고가: 200, 판매여부: 1 }, X: { 출고가: 300, 판매여부: 1 } },
      aggregateTransform: blockCase.transform,
    });
    assert.equal(result.writtenFile, "", `${blockCase.name} must not write an XLSX file`);
    assert.match(result.alerts.join("\n"), new RegExp(blockCase.expected.replace(/[+]/g, "\\+")));
  }

  // 제공 운영 파일이 있을 때 실제 전체재고 277 Lot을 F8 생성·재열기까지 검증한다.
  const sourceWorkbookPath = "C:/Users/USER/Desktop/수불마감_20260804 (4).xlsx";
  const previousQuickPath = "C:/Users/USER/Desktop/통합업로드용_QuickF8_2026-08-04 (5).xlsx";
  if (fs.existsSync(sourceWorkbookPath) && fs.existsSync(previousQuickPath)) {
    const parserEnv = makeContext("reference-parser");
    const sourceWorkbook = parserEnv.realXlsx.read(fs.readFileSync(sourceWorkbookPath), { type: "buffer", cellDates: false });
    const previousQuick = parserEnv.realXlsx.read(fs.readFileSync(previousQuickPath), { type: "buffer" });
    const sourceAoa = parserEnv.realXlsx.utils.sheet_to_json(sourceWorkbook.Sheets["전체재고"], { header: 1, raw: true });
    const previousShopAoa = parserEnv.realXlsx.utils.sheet_to_json(previousQuick.Sheets["쇼핑몰업로드"], { header: 1, raw: true });
    const previousErpAoa = parserEnv.realXlsx.utils.sheet_to_json(previousQuick.Sheets["ERP업데이트"], { header: 1, raw: true });
    const sourceRecords = sourceAoa.slice(2).filter((row) => normalizeCode(row[1])).map((row, index) => ({
      code: normalizeCode(row[1]), unit: row[0] ?? "", name: row[2] ?? "", spec: row[3] ?? "",
      stock: parseNum(row[4]), recordDate: row[5] ?? "", vendor: row[6] ?? "", price: parseNum(row[7]),
      basic: row[8] ?? "", memo: row[9] ?? "", promo: row[10] ?? "", inputOrder: index,
    }));
    const sourceCodes = new Set(sourceRecords.map((row) => row.code));
    const sourceTripleCounts = new Map();
    for (const row of sourceRecords) {
      const key = JSON.stringify([row.code, row.stock, row.price]);
      sourceTripleCounts.set(key, (sourceTripleCounts.get(key) || 0) + 1);
    }
    const previousRows = previousShopAoa.slice(1).map((shopRow, index) => ({
      code: normalizeCode(shopRow[0]), stock: parseNum(shopRow[15]), price: parseNum(previousErpAoa[index + 1]?.[1]), index,
    })).filter((row) => row.code);
    const extraRows = [];
    for (const row of previousRows) {
      const key = JSON.stringify([row.code, row.stock, row.price]);
      const remaining = sourceTripleCounts.get(key) || 0;
      if (remaining > 0) sourceTripleCounts.set(key, remaining - 1);
      else extraRows.push(row);
    }
    const subdivisionMappings = extraRows.map((row) => ({ rawCode: previousRows[row.index - 1]?.code || "", subCode: row.code })).filter((row) => row.rawCode && row.subCode);
    const extraCodesNotInSource = [...new Set(extraRows.filter((row) => !sourceCodes.has(row.code)).map((row) => row.code))].sort();

    const inventoryRows = sourceRecords.map((record) => makeRow({
      code: record.code,
      role: "inventory",
      inputOrder: record.inputOrder,
      source: {
        단위: record.unit, 품목명: record.name, 규격: record.spec, 재고: record.stock, 재고수량: record.stock,
        기록: record.recordDate, "상품 구매일자": record.recordDate, 거래: record.vendor, 구매처: record.vendor,
        구매가: record.price, "최종(창고)": record.price, 최신단가: record.price, 입고가: record.price,
        기본: record.basic, 적요: record.memo, 행사가: record.promo, _inventoryFifoKey: makeInventoryDateKey(record.recordDate, "2026-08-04"),
        _dataOpsBasisDate: "2026-08-04",
      },
    }));
    const masterProducts = {};
    for (const record of sourceRecords) {
      masterProducts[record.code] = {
        품목명: record.name, 규격: record.spec, 입고가: record.price, 출고가: Math.max(record.price, 1),
        시중가: Math.max(record.price, 1), 판매여부: 1,
      };
    }
    for (const mapping of subdivisionMappings) {
      masterProducts[mapping.rawCode] = {
        ...(masterProducts[mapping.rawCode] || {}), "1종코드": mapping.subCode, "1종규격": "소분", "1종연산": 2,
      };
      masterProducts[mapping.subCode] = { ...(masterProducts[mapping.subCode] || {}), 품목명: masterProducts[mapping.subCode]?.품목명 || `소분 ${mapping.subCode}`, 규격: masterProducts[mapping.subCode]?.규격 || "소분" };
    }

    const inventoryResult = await runF8Scenario({
      name: "inventory-reference",
      rows: inventoryRows,
      snapshotRows: inventoryRows,
      masterProducts,
    });
    assert.ok(inventoryResult.writtenFile && fs.statSync(inventoryResult.writtenFile).size > 1000, "inventory F8 must write a real XLSX file");
    const shopRows = inventoryResult.context.XLSX.utils.sheet_to_json(inventoryResult.reopened.Sheets["쇼핑몰업로드"], { header: 1, raw: true }).slice(1);
    const erpRows = inventoryResult.context.XLSX.utils.sheet_to_json(inventoryResult.reopened.Sheets["ERP업데이트"], { header: 1, raw: true }).slice(1);
    const shopCodes = shopRows.map((row) => normalizeCode(row[0]));
    const erpCodes = erpRows.map((row) => normalizeCode(row[0]));
    const stockByCode = new Map(shopRows.map((row) => [normalizeCode(row[0]), parseNum(row[15])]));
    const erpByCode = new Map(erpRows.map((row) => [normalizeCode(row[0]), row]));
    assert.equal(sourceRecords.length, 277);
    assert.equal(sourceCodes.size, 275);
    assert.equal(sourceRecords.reduce((sum, row) => sum + row.stock, 0), 2146);
    assert.equal(shopRows.length, 275);
    assert.equal(new Set(shopCodes).size, 275);
    assert.equal(shopRows.reduce((sum, row) => sum + parseNum(row[15]), 0), 2146);
    assert.deepEqual(shopCodes, erpCodes, "shopping-mall and ERP output code order must match");
    assert.equal(stockByCode.get("104028112"), 3);
    assert.equal(stockByCode.get("104524110"), 3);
    assert.equal(stockByCode.get("101010114"), 6);
    assert.equal(stockByCode.get("101018132"), 4);
    assert.equal(parseNum(erpByCode.get("104524110")?.[1]), 20000, "latest 2026-08-04 LOT price must be representative");
    assert.equal(extraCodesNotInSource.length, 16);
    extraCodesNotInSource.forEach((code) => assert.equal(stockByCode.has(code), false, `source-absent subdivision code must not be generated: ${code}`));

    const snapshot = inventoryResult.context.window.__MERCHOPS_INVENTORY_F8_SOURCE_SNAPSHOT;
    const sourceTriples = sourceRecords.map((row) => JSON.stringify([row.code, row.stock, row.price])).sort();
    const snapshotTriples = Array.from(snapshot.entries).map((row) => JSON.stringify([row.code, row.stock, row.purchasePrice])).sort();
    assert.equal(snapshot.rowCount, 277);
    assert.equal(snapshot.uniqueCodeCount, 275);
    assert.equal(snapshot.stockTotal, 2146);
    assert.equal(JSON.stringify(snapshotTriples), JSON.stringify(sourceTriples), "all 277 source code/stock/purchase-price rows must remain in the source snapshot");
  } else {
    console.warn("Reference inventory workbooks were not found; repository-safe synthetic F8 regressions still passed.");
  }

  console.log("MerchOps Quick F8 inventory aggregation, blocking diagnostics, role regressions, and real XLSX reopen checks passed.");
} finally {
  const resolvedTempDir = path.resolve(tempDir);
  const allowedTempPrefix = path.resolve(ROOT, ".tmp-merchops-f8-");
  assert.ok(resolvedTempDir.startsWith(allowedTempPrefix), `refusing to remove unexpected temp directory: ${resolvedTempDir}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// The repository Actions already execute this real-XLSX suite. Keep the shared
// resolver and F9 consumer regressions on that same CI path without widening
// the workflow-file change scope for this task.
await import("./test-merchops-master-reference-isolation.mjs");
await import("./test-export-center-working-xlsx.mjs");
