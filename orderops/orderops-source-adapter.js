(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OrderOpsSourceAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const DATAOPS_SNAPSHOT_SCHEMA = "ONEAPP_DATAOPS_SNAPSHOT_V1";
  const DATAOPS_SNAPSHOT_COLUMNS = Object.freeze([
    "단위", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요", "행사가",
  ]);
  const SMART_INPUT_SOURCE = "SMART_INPUT";
  const SMART_INPUT_EXCLUDED_ORDER_STATUS = new Set(["COMPLETED", "FULL_CANCEL"]);
  const SMART_INPUT_EXCLUDED_ITEM_STATUS = new Set(["CANCELLED", "EXCLUDED"]);
  const currentScriptUrl = root.document?.currentScript?.src || "";
  const DEFAULT_ORDERQ_DB_MODULE_URL = currentScriptUrl
    ? new URL("../orderq/orderq-db.js?v=0.16.0", currentScriptUrl).href
    : "../orderq/orderq-db.js?v=0.16.0";

  function cleanText(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function normalizeProductCode(value) {
    if (value === null || value === undefined || cleanText(value) === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
    }
    return cleanText(value).replace(/\.0$/, "");
  }

  function parseFiniteNumber(value) {
    if (value === null || value === undefined || cleanText(value) === "") return null;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function roundQuantity(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1e9) / 1e9;
  }

  function resolveCrypto(cryptoImpl) {
    const candidate = cryptoImpl || root.crypto;
    if (!candidate?.subtle || typeof TextEncoder === "undefined") {
      throw new Error("이 브라우저에서는 클라우드 무결성 검사를 사용할 수 없습니다.");
    }
    return candidate;
  }

  async function sha256Hex(value, cryptoImpl) {
    const digest = await resolveCrypto(cryptoImpl).subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(value ?? "")),
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function mapDataOpsReadError(message = "", httpStatus = 0) {
    const detail = cleanText(message);
    if (/알 수 없는 Action|unknown action/i.test(detail)) {
      return "클라우드 서버에 재고 조회 기능이 아직 배포되지 않았습니다. Apps Script를 최신 버전으로 배포하세요.";
    }
    if (detail === "DATAOPS_ACCESS_NOT_CONFIGURED") {
      return "클라우드 서버의 DataOps 쓰기 토큰이 설정되지 않았습니다. Apps Script 설정과 최신 배포 상태를 확인하세요.";
    }
    if (detail === "DATAOPS_ACCESS_DENIED") {
      return "클라우드 서버가 재고 조회에 이전 토큰 인증을 요구하고 있습니다. Apps Script를 최신 버전으로 배포하세요.";
    }
    if (httpStatus) {
      return `클라우드 서버 응답 오류 (HTTP ${httpStatus}). Apps Script 주소와 배포 권한을 확인하세요.`;
    }
    return detail || "클라우드 응답 형식이 올바르지 않습니다.";
  }

  async function validateDataOpsSnapshot(snapshot, options = {}) {
    if (!snapshot || snapshot.schemaVersion !== DATAOPS_SNAPSHOT_SCHEMA) {
      throw new Error("DataOps 스냅샷 schema가 올바르지 않습니다.");
    }
    if (!snapshot.revision || !/^\d{4}-\d{2}-\d{2}$/.test(cleanText(snapshot.basisDate))) {
      throw new Error("DataOps 스냅샷 revision/기준일이 올바르지 않습니다.");
    }
    if (!Array.isArray(snapshot.columns) ||
        JSON.stringify(snapshot.columns) !== JSON.stringify(DATAOPS_SNAPSHOT_COLUMNS)) {
      throw new Error("DataOps 스냅샷 열 계약이 올바르지 않습니다.");
    }
    if (!Array.isArray(snapshot.rows) ||
        snapshot.rows.some((row) => !Array.isArray(row) || row.length !== DATAOPS_SNAPSHOT_COLUMNS.length)) {
      throw new Error("DataOps 스냅샷 행 계약이 올바르지 않습니다.");
    }

    const rowCount = snapshot.rows.length;
    const cellCount = rowCount * DATAOPS_SNAPSHOT_COLUMNS.length;
    if (Number(snapshot.rowCount) !== rowCount || Number(snapshot.cellCount) !== cellCount) {
      throw new Error("DataOps 스냅샷 행/셀 수 검산에 실패했습니다.");
    }
    const canonicalJson = JSON.stringify({
      schemaVersion: snapshot.schemaVersion,
      basisDate: snapshot.basisDate,
      columns: snapshot.columns,
      rows: snapshot.rows,
    });
    const hash = await sha256Hex(canonicalJson, options.cryptoImpl);
    if (hash !== cleanText(snapshot.hash).toLowerCase()) {
      throw new Error("DataOps 스냅샷 hash 검산에 실패했습니다.");
    }

    const promotionByCode = new Map();
    snapshot.rows.forEach((row, index) => {
      const productCode = normalizeProductCode(row[1]);
      const rawPromotion = row[10];
      const promotion = rawPromotion === "" || rawPromotion === null || rawPromotion === undefined
        ? 0
        : parseFiniteNumber(rawPromotion);
      if (promotion === null || promotion < 0) {
        throw new Error(`DataOps ${index + 1}행 행사가 값이 올바르지 않습니다: ${productCode || "품목코드 없음"}`);
      }
      if (productCode && promotionByCode.has(productCode) && promotionByCode.get(productCode) !== promotion) {
        throw new Error(`같은 품목코드의 LOT별 행사가가 다릅니다: ${productCode}`);
      }
      if (productCode) promotionByCode.set(productCode, promotion);
    });
    return { ...snapshot, hash };
  }

  async function fetchLatestDataOpsSnapshot(url, options = {}) {
    let targetUrl;
    try {
      targetUrl = new URL(cleanText(url));
      if (!/^https?:$/.test(targetUrl.protocol)) throw new Error("INVALID_CLOUD_URL");
    } catch (_) {
      throw new Error("클라우드 주소가 올바르지 않습니다. 환경설정의 Apps Script 웹앱 주소를 확인하세요.");
    }

    const securityClient = options.securityClient || root.DATAOPS_V1_SECURITY_CLIENT?.readClient;
    if (!securityClient?.released?.()) throw new Error("DATAOPS_V1_SECURITY_NOT_RELEASED");
    let readCredential = options.readCredential;
    if (!securityClient.ready?.() && !readCredential) {
      await root.ONEAPP_AUTH?.ready;
      if (!root.ONEAPP_AUTH?.session) throw new Error("NEXUS_AUTH_SESSION_REQUIRED");
      readCredential = root.ONEAPP_AUTH.businessCredential("DATAOPS_READ");
    }
    let snapshot;
    try {
      snapshot = await securityClient.getSnapshot({ url: targetUrl.href, readCredential });
    } catch (_) {
      throw new Error("클라우드 서버에 연결할 수 없습니다. 환경설정의 Apps Script 주소와 네트워크를 확인하세요.");
    }
    if (!snapshot) {
      throw new Error("확정된 DataOps 클라우드 재고자료가 없습니다. DataOps에서 작업 저장 또는 F9 저장을 먼저 실행하세요.");
    }
    return validateDataOpsSnapshot(snapshot, options);
  }

  function aggregateDataOpsRows(snapshot) {
    const grouped = new Map();
    snapshot.rows.forEach((row, index) => {
      const productCode = normalizeProductCode(row[1]);
      if (!productCode) throw new Error(`DataOps ${index + 1}행에 품목코드가 없습니다.`);
      const stock = parseFiniteNumber(row[4]);
      if (stock === null) throw new Error(`DataOps ${index + 1}행 ${productCode} 재고를 숫자로 해석할 수 없습니다.`);
      if (!grouped.has(productCode)) {
        grouped.set(productCode, {
          unit: cleanText(row[0]),
          productCode,
          productName: cleanText(row[2]),
          specification: cleanText(row[3]),
          stock: 0,
          sourceRowCount: 0,
          units: new Set(),
          names: new Set(),
          specifications: new Set(),
        });
      }
      const target = grouped.get(productCode);
      target.stock = roundQuantity(target.stock + stock);
      target.sourceRowCount += 1;
      if (cleanText(row[0])) target.units.add(cleanText(row[0]));
      if (cleanText(row[2])) target.names.add(cleanText(row[2]));
      if (cleanText(row[3])) target.specifications.add(cleanText(row[3]));
      if (!target.unit && cleanText(row[0])) target.unit = cleanText(row[0]);
      if (!target.productName && cleanText(row[2])) target.productName = cleanText(row[2]);
      if (!target.specification && cleanText(row[3])) target.specification = cleanText(row[3]);
    });
    return [...grouped.values()];
  }

  function buildDataOpsInventoryParsed(snapshot, engine) {
    if (!engine?.parseInventoryWorkbook) throw new Error("출고관리 재고 변환 모듈을 불러오지 못했습니다.");
    const rows = aggregateDataOpsRows(snapshot);
    if (!rows.length) throw new Error("DataOps 확정 재고에 불러올 상품행이 없습니다.");
    const headers = ["단위", "품목코드", "품목명", "규격", "수량", "1창고"];
    const matrix = [
      headers,
      ...rows.map((row) => [
        row.unit,
        row.productCode,
        row.productName,
        row.specification,
        row.stock,
        row.stock,
      ]),
    ];
    const parsed = engine.parseInventoryWorkbook({
      fileName: `DataOps_확정재고_${cleanText(snapshot.revision)}.cloud`,
      sheetName: "전체재고",
      fileHash: cleanText(snapshot.hash),
      rawMatrix: matrix,
      displayMatrix: matrix,
    });
    const aggregatedLotCount = rows.reduce((sum, row) => sum + Math.max(0, row.sourceRowCount - 1), 0);
    const conflictingMetadata = rows.filter((row) =>
      row.units.size > 1 || row.names.size > 1 || row.specifications.size > 1,
    );
    if (aggregatedLotCount > 0) {
      parsed.warnings.push({
        code: "DATAOPS_LOT_ROWS_AGGREGATED",
        message: `DataOps LOT ${aggregatedLotCount.toLocaleString("ko-KR")}행을 품목코드별 재고 합계로 묶었습니다.`,
      });
    }
    if (conflictingMetadata.length > 0) {
      parsed.warnings.push({
        code: "DATAOPS_PRODUCT_METADATA_CONFLICT",
        message: `DataOps 품목코드 ${conflictingMetadata.length.toLocaleString("ko-KR")}개의 단위·품명·규격이 LOT별로 달라 첫 유효값을 표시합니다.`,
      });
    }
    parsed.sourceLabel = `DataOps 확정재고 · ${cleanText(snapshot.revision)} · ${parsed.rowCount.toLocaleString("ko-KR")}행`;
    parsed.dataSource = {
      type: "DATAOPS_CLOUD_SNAPSHOT",
      schemaVersion: snapshot.schemaVersion,
      revision: snapshot.revision,
      basisDate: snapshot.basisDate,
      savedAt: snapshot.savedAt,
      hash: snapshot.hash,
      sourceRowCount: snapshot.rowCount,
      productRowCount: parsed.rowCount,
    };
    return parsed;
  }

  function isSmartInputOrder(order) {
    return cleanText(order?.sourceType).toUpperCase() === SMART_INPUT_SOURCE ||
      cleanText(order?.inputChannel).toUpperCase() === SMART_INPUT_SOURCE;
  }

  function orderReference(order) {
    const orderDate = cleanText(order?.orderDate);
    const orderNo = cleanText(order?.orderNo);
    return orderDate ? `${orderDate}${orderNo ? ` · ${orderNo}` : ""}` : orderNo;
  }

  function smartInputOrderProjection(order, items) {
    return {
      orderId: cleanText(order.orderId),
      revision: Number(order.revision || 0),
      orderNo: cleanText(order.orderNo),
      orderDate: cleanText(order.orderDate),
      orderStatus: cleanText(order.orderStatus),
      updatedAt: cleanText(order.updatedAt),
      items: items.map((item) => ({
        orderItemId: cleanText(item.orderItemId),
        lineNo: Number(item.lineNo || 0),
        itemCode: cleanText(item.itemCode),
        finalQuantity: item.finalQuantity,
        rawQuantity: item.rawQuantity,
        price: item.price,
        matchStatus: cleanText(item.matchStatus),
        updatedAt: cleanText(item.updatedAt),
      })),
    };
  }

  async function buildSmartInputOrdersParsed(input, engine, options = {}) {
    if (!engine?.parseOrderWorkbook) throw new Error("출고관리 주문 변환 모듈을 불러오지 못했습니다.");
    const allOrders = Array.isArray(input?.orders) ? input.orders : [];
    const allItems = Array.isArray(input?.items) ? input.items : [];
    const smartOrders = allOrders.filter(isSmartInputOrder);
    if (!smartOrders.length) {
      throw new Error("스마트입력으로 저장된 주문이 없습니다. 스마트입력에서 주문서를 먼저 저장하세요.");
    }

    const eligibleOrders = smartOrders
      .filter((order) => !SMART_INPUT_EXCLUDED_ORDER_STATUS.has(cleanText(order.orderStatus).toUpperCase()))
      .sort((left, right) =>
        cleanText(left.orderDate).localeCompare(cleanText(right.orderDate), "ko", { numeric: true }) ||
        cleanText(left.createdAt).localeCompare(cleanText(right.createdAt), "ko", { numeric: true }) ||
        cleanText(left.orderNo).localeCompare(cleanText(right.orderNo), "ko", { numeric: true }),
      );
    if (!eligibleOrders.length) {
      throw new Error("스마트입력 주문은 있으나 출고 대상 주문이 없습니다. 완료·전체취소 주문은 제외됩니다.");
    }

    const itemsByOrder = new Map();
    allItems.forEach((item) => {
      const orderId = cleanText(item?.orderId);
      if (!orderId) return;
      if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
      itemsByOrder.get(orderId).push(item);
    });
    itemsByOrder.forEach((items) => items.sort((left, right) =>
      Number(left.lineNo || 0) - Number(right.lineNo || 0) ||
      cleanText(left.orderItemId).localeCompare(cleanText(right.orderItemId), "ko", { numeric: true }),
    ));

    const headers = [
      "일자-No.", "담당", "창고", "단위", "품목코드", "품목명", "규격", "수량",
      "재고", "단가", "공급가액", "적요", "적요1", "거래처", "그룹",
    ];
    const matrix = [headers];
    const projections = [];
    eligibleOrders.forEach((order) => {
      const activeItems = (itemsByOrder.get(cleanText(order.orderId)) || [])
        .filter((item) => !SMART_INPUT_EXCLUDED_ITEM_STATUS.has(cleanText(item.matchStatus).toUpperCase()));
      projections.push(smartInputOrderProjection(order, activeItems));
      activeItems.forEach((item) => {
        const quantity = item.finalQuantity !== null && item.finalQuantity !== undefined
          ? item.finalQuantity
          : item.rawQuantity;
        const itemNote = cleanText(item.memo);
        const secondaryNote = [cleanText(item.description), cleanText(order.orderMessage)].filter(Boolean).join(" / ");
        matrix.push([
          orderReference(order),
          cleanText(order.assigneeName),
          cleanText(order.warehouseName || order.warehouseCode),
          cleanText(item.finalUnit || item.rawUnit),
          normalizeProductCode(item.itemCode),
          cleanText(item.itemName),
          cleanText(item.specification),
          quantity,
          "",
          item.price,
          item.supplyAmount,
          itemNote,
          secondaryNote,
          cleanText(order.customerName),
          cleanText(order.customerSnapshot?.group1Name || order.customerSnapshot?.group2Name),
        ]);
      });
    });
    if (matrix.length === 1) {
      throw new Error("스마트입력 주문에 출고할 상품행이 없습니다. 취소·제외된 상품행은 불러오지 않습니다.");
    }

    const fileHash = await sha256Hex(JSON.stringify(projections), options.cryptoImpl);
    const parsed = engine.parseOrderWorkbook({
      fileName: `스마트입력_주문조회_${new Date().toISOString().slice(0, 10)}.ledger`,
      sheetName: "스마트입력 주문조회",
      fileHash,
      rawMatrix: matrix,
      displayMatrix: matrix,
    });
    parsed.sourceLabel = `스마트입력 주문 · ${eligibleOrders.length.toLocaleString("ko-KR")}건 · ${parsed.rowCount.toLocaleString("ko-KR")}행`;
    parsed.dataSource = {
      type: "ORDERQ_VNEXT_SMART_INPUT",
      schemaVersion: "SMART_INPUT_V1",
      orderCount: eligibleOrders.length,
      rowCount: parsed.rowCount,
      excludedCompletedOrCancelledCount: smartOrders.length - eligibleOrders.length,
      hash: fileHash,
    };
    return parsed;
  }

  async function loadSmartInputOrders(engine, options = {}) {
    const importModule = options.importModule || ((url) => import(url));
    let dbModule;
    try {
      dbModule = await importModule(options.dbModuleUrl || DEFAULT_ORDERQ_DB_MODULE_URL);
    } catch (_) {
      throw new Error("ORDER Q 주문 원장을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
    }
    if (!dbModule?.STORE || typeof dbModule.getAll !== "function") {
      throw new Error("ORDER Q 주문 원장 읽기 계약이 올바르지 않습니다.");
    }
    const [orders, items] = await Promise.all([
      dbModule.getAll(dbModule.STORE.ORDERS),
      dbModule.getAll(dbModule.STORE.ORDER_ITEMS),
    ]);
    return buildSmartInputOrdersParsed({ orders, items }, engine, options);
  }

  return Object.freeze({
    DATAOPS_SNAPSHOT_SCHEMA,
    DATAOPS_SNAPSHOT_COLUMNS,
    DEFAULT_ORDERQ_DB_MODULE_URL,
    mapDataOpsReadError,
    sha256Hex,
    validateDataOpsSnapshot,
    fetchLatestDataOpsSnapshot,
    aggregateDataOpsRows,
    buildDataOpsInventoryParsed,
    buildSmartInputOrdersParsed,
    loadSmartInputOrders,
  });
});
