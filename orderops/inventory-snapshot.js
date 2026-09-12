(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OrderOpsInventorySnapshot = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ERP_SCHEMA = "ONEAPP_INVENTORY_SNAPSHOT_V1";
  const READ_SCHEMA = "oneapp-common-inventory-read/v1";
  const DATAOPS_SCHEMA = "ONEAPP_DATAOPS_SNAPSHOT_V1";
  const DATAOPS_COLUMNS = Object.freeze([
    "단위", "품목코드", "품명", "규격", "재고", "기록", "거래", "구매가", "기본", "적요", "행사가",
  ]);

  function text(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function normalizeCode(value) {
    return text(value).replace(/\.0$/, "");
  }

  function normalizeUnit(value) {
    return text(value).replace(/\s+/g, "").toLocaleUpperCase("ko-KR");
  }

  function countScalarCells(value) {
    if (value === null || value === undefined) return 1;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + countScalarCells(item), 0);
    if (typeof value === "object") {
      return Object.keys(value).reduce((sum, key) => sum + countScalarCells(value[key]), 0);
    }
    return 1;
  }

  function basisDateValue(value) {
    const basisDate = text(value);
    if (!basisDate) return { basisDate: "", basisDateStatus: "missing" };
    const parsed = new Date(`${basisDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(basisDate) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== basisDate) {
      throw new Error("재고 기준일은 YYYY-MM-DD 형식이어야 합니다.");
    }
    return { basisDate, basisDateStatus: "valid" };
  }

  function warehouseKey(column) {
    return `warehouse:${Number(column.sourceIndex)}:${encodeURIComponent(text(column.header))}`;
  }

  function buildErpCanonical(parsed, options = {}) {
    if (!parsed || parsed.kind !== "inventory" || !Array.isArray(parsed.rows) || parsed.errors?.length) {
      throw new Error("검증을 통과한 ERP 재고만 공유 저장할 수 있습니다.");
    }
    if (!/^[a-f0-9]{64}$/.test(text(parsed.fileHash).toLowerCase())) {
      throw new Error("ERP 재고 원본 SHA-256이 없습니다.");
    }
    const basis = basisDateValue(options.basisDate);
    const sourceMatrix = Array.isArray(parsed.sourceMatrix)
      ? parsed.sourceMatrix.map((row) => Array.isArray(row) ? row.map((cell) => cell ?? null) : [row ?? null])
      : [];
    const sourceColumns = (parsed.columns || []).filter((column) => Number.isInteger(column?.sourceIndex));
    const warehouses = sourceColumns.filter((column) => column.role === "warehouseQuantity");
    if (!warehouses.length) throw new Error("저장할 창고 수량 열이 없습니다.");
    const warehouseScope = warehouses.map((column) => ({
      warehouseKey: warehouseKey(column),
      label: text(column.header),
      sourceColumnIndex: Number(column.sourceIndex),
      role: "warehouseQuantity",
    }));
    const columns = sourceColumns.map((column) => ({
      sourceIndex: Number(column.sourceIndex),
      header: text(column.header),
      normalizedHeader: text(column.header).replace(/\s+/g, ""),
      role: text(column.role),
      warehouseKey: column.role === "warehouseQuantity" ? warehouseKey(column) : "",
    }));
    const normalizedRows = parsed.rows.map((row) => {
      const sourceRowNumber = Number(row.sourceRowNumber);
      const source = sourceMatrix[sourceRowNumber - 1] || [];
      const warehouseValues = warehouses.map((column) => {
        const quantity = Number(source[column.sourceIndex]);
        if (!Number.isFinite(quantity)) throw new Error(`${sourceRowNumber}행 ${column.header} 수량을 저장할 수 없습니다.`);
        return {
          warehouseKey: warehouseKey(column),
          sourceColumnIndex: Number(column.sourceIndex),
          quantity,
        };
      });
      const totalQuantity = warehouseValues.reduce((sum, value) => sum + value.quantity, 0);
      if (Math.abs(totalQuantity - Number(row.inventoryTotal)) > 1e-9) {
        throw new Error(`${sourceRowNumber}행 창고 합계가 파서 검산값과 다릅니다.`);
      }
      return {
        sourceRowNumber,
        productCode: normalizeCode(row.productCode),
        productName: text(row.productName),
        specification: text(row.specification),
        unit: text(row.unit),
        totalQuantity,
        warehouseValues,
      };
    });
    return {
      schemaVersion: ERP_SCHEMA,
      sourceType: "ORDEROPS_ERP",
      ...basis,
      sourceFile: {
        fileName: text(parsed.fileName),
        sheetName: text(parsed.sheetName),
        sha256: text(parsed.fileHash).toLowerCase(),
        rowCount: normalizedRows.length,
        headerRowIndex: Number(parsed.headerRowIndex) || 0,
        productCodeColumnIndex: Number(parsed.productCodeColumnIndex),
      },
      parser: {
        engineVersion: text(options.engineVersion),
        mappingVersion: "shipping-inventory-columns/v1",
      },
      warehouseScope,
      columns,
      sourceMatrix,
      normalizedRows,
    };
  }

  async function buildErpEnvelope(parsed, options = {}) {
    if (typeof options.sha256Hex !== "function") throw new Error("SHA-256 계산기를 사용할 수 없습니다.");
    const canonical = buildErpCanonical(parsed, options);
    const canonicalJson = JSON.stringify(canonical);
    return {
      schemaVersion: ERP_SCHEMA,
      hashAlgorithm: "SHA-256",
      hash: await options.sha256Hex(canonicalJson),
      rowCount: canonical.normalizedRows.length,
      cellCount: countScalarCells(canonical),
      canonicalJson,
    };
  }

  async function readErpSnapshot(result, options = {}) {
    if (typeof options.sha256Hex !== "function") throw new Error("SHA-256 계산기를 사용할 수 없습니다.");
    const metadata = result?.metadata;
    const snapshot = result?.snapshot;
    if (!metadata || !snapshot || snapshot.schemaVersion !== ERP_SCHEMA) throw new Error("ERP 재고 응답 계약이 올바르지 않습니다.");
    const hash = await options.sha256Hex(String(snapshot.canonicalJson || ""));
    if (hash !== snapshot.hash || hash !== metadata.hash || Number(snapshot.rowCount) !== Number(metadata.rowCount) ||
        Number(snapshot.cellCount) !== Number(metadata.cellCount)) {
      throw new Error("ERP 재고 응답 검산값이 일치하지 않습니다.");
    }
    let canonical;
    try { canonical = JSON.parse(snapshot.canonicalJson); }
    catch (error) { throw new Error("ERP 재고 원문을 해석할 수 없습니다."); }
    if (canonical.schemaVersion !== ERP_SCHEMA || canonical.sourceType !== "ORDEROPS_ERP" ||
        canonical.normalizedRows.length !== Number(snapshot.rowCount) || countScalarCells(canonical) !== Number(snapshot.cellCount)) {
      throw new Error("ERP 재고 원문 계약이 올바르지 않습니다.");
    }
    return {
      metadata,
      snapshot,
      canonical,
      readModel: {
        schemaVersion: READ_SCHEMA,
        sourceType: "ORDEROPS_ERP",
        sourceId: text(metadata.snapshotId),
        revision: text(metadata.revision),
        hash,
        basisDate: text(metadata.basisDate ?? canonical.basisDate),
        basisDateStatus: text(metadata.basisDateStatus ?? canonical.basisDateStatus) || "missing",
        savedAt: text(metadata.savedAt),
        applicationMode: "ERP_WAREHOUSE",
        warehouseScope: canonical.warehouseScope.map((item) => ({ ...item })),
        warehouseMapping: canonical.warehouseScope.map((item) => ({
          sourceWarehouseKey: item.warehouseKey,
          targetWarehouseRole: item.label,
          mappingMode: "ERP_VERIFIED",
        })),
        sourceRows: canonical.sourceMatrix.map((row) => [...row]),
        normalizedRows: canonical.normalizedRows.map((row) => ({
          ...row,
          warehouseValues: row.warehouseValues.map((value) => ({ ...value })),
        })),
        validation: { warnings: [], errors: [] },
      },
    };
  }

  async function readDataOpsSnapshot(snapshot, options = {}) {
    if (typeof options.sha256Hex !== "function") throw new Error("SHA-256 계산기를 사용할 수 없습니다.");
    if (!snapshot || snapshot.schemaVersion !== DATAOPS_SCHEMA || JSON.stringify(snapshot.columns) !== JSON.stringify(DATAOPS_COLUMNS)) {
      throw new Error("DataOps 확정재고 계약이 올바르지 않습니다.");
    }
    const canonicalJson = JSON.stringify({
      schemaVersion: DATAOPS_SCHEMA,
      basisDate: snapshot.basisDate,
      columns: snapshot.columns,
      rows: snapshot.rows,
    });
    const hash = await options.sha256Hex(canonicalJson);
    if (hash !== snapshot.hash || Number(snapshot.rowCount) !== snapshot.rows.length ||
        Number(snapshot.cellCount) !== snapshot.rows.length * DATAOPS_COLUMNS.length) {
      throw new Error("DataOps 확정재고 검산값이 일치하지 않습니다.");
    }
    const groups = new Map();
    const errors = [];
    snapshot.rows.forEach((row, index) => {
      const sourceRowNumber = index + 1;
      if (!Array.isArray(row) || row.length !== DATAOPS_COLUMNS.length) {
        errors.push({ code: "DATAOPS_ROW_WIDTH_INVALID", sourceRowNumber });
        return;
      }
      const productCode = normalizeCode(row[1]);
      const quantity = typeof row[4] === "number" ? row[4] : Number(text(row[4]).replace(/,/g, ""));
      if (!productCode || !Number.isFinite(quantity)) {
        errors.push({ code: "DATAOPS_ROW_INVALID", sourceRowNumber, productCode });
        return;
      }
      if (!groups.has(productCode)) groups.set(productCode, []);
      groups.get(productCode).push({
        sourceRowNumber, productCode, productName: text(row[2]), specification: text(row[3]),
        unit: text(row[0]), quantity,
      });
    });
    const normalizedRows = [];
    groups.forEach((rows, productCode) => {
      const units = new Set(rows.map((row) => normalizeUnit(row.unit)));
      const names = new Set(rows.map((row) => row.productName));
      const specifications = new Set(rows.map((row) => row.specification));
      if (units.size !== 1 || ![...units][0]) {
        errors.push({ code: "DATAOPS_UNIT_CONFLICT", productCode, sourceRowNumbers: rows.map((row) => row.sourceRowNumber) });
        return;
      }
      if (names.size !== 1 || specifications.size !== 1) {
        errors.push({ code: "DATAOPS_IDENTITY_CONFLICT", productCode, sourceRowNumbers: rows.map((row) => row.sourceRowNumber) });
        return;
      }
      normalizedRows.push({
        sourceRowNumber: rows[0].sourceRowNumber,
        sourceRowNumbers: rows.map((row) => row.sourceRowNumber),
        productCode,
        productName: [...names][0] || "",
        specification: [...specifications][0] || "",
        unit: rows[0].unit,
        totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        warehouseValues: [],
      });
    });
    if (!normalizedRows.length) throw new Error("DataOps 확정재고에서 안전하게 비교할 상품이 없습니다.");
    return {
      schemaVersion: READ_SCHEMA,
      sourceType: "DATAOPS_FINALIZED",
      sourceId: text(snapshot.revision),
      revision: text(snapshot.revision),
      hash,
      basisDate: text(snapshot.basisDate),
      basisDateStatus: "valid",
      savedAt: text(snapshot.savedAt),
      applicationMode: "TOTAL_ONLY",
      warehouseScope: [],
      warehouseMapping: [],
      sourceRows: snapshot.rows.map((row) => [...row]),
      normalizedRows,
      validation: { warnings: [], errors },
    };
  }

  function dataOpsReadModelToParsed(readModel) {
    if (!readModel || readModel.schemaVersion !== READ_SCHEMA || readModel.applicationMode !== "TOTAL_ONLY") {
      throw new Error("총량 비교 재고 모델이 올바르지 않습니다.");
    }
    const header = ["품목코드", "품목명", "규격", "단위", "수량"];
    const sourceMatrix = [header, ...readModel.normalizedRows.map((row) => [
      row.productCode, row.productName, row.specification, row.unit, row.totalQuantity,
    ])];
    return {
      kind: "inventory",
      fileName: `DataOps 확정재고 ${readModel.basisDate}`,
      sheetName: "DataOpsSnapshot",
      fileHash: readModel.hash,
      headerRowIndex: 0,
      headerRowNumber: 1,
      headers: header,
      requiredColumns: ["품목코드", "품목명", "규격", "수량"],
      optionalColumns: ["단위"],
      missingColumns: [],
      rows: readModel.normalizedRows.map((row, index) => ({
        sourceRowNumber: index + 2,
        sourceDataOpsRowNumbers: [...row.sourceRowNumbers],
        productCode: row.productCode,
        productName: row.productName,
        specification: row.specification,
        unit: row.unit,
        sourceInventoryTotal: row.totalQuantity,
        inventoryTotal: row.totalQuantity,
      })),
      rowCount: readModel.normalizedRows.length,
      duplicateCodes: [],
      errors: [],
      warnings: [...readModel.validation.errors],
      sourceMatrix,
      productCodeColumnIndex: 0,
      columns: [
        { key: "inventory:0:product", header: "품목코드", sourceIndex: 0, role: "productCode", editable: false, numeric: false },
        { key: "inventory:1:name", header: "품목명", sourceIndex: 1, role: "productName", editable: false, numeric: false },
        { key: "inventory:2:spec", header: "규격", sourceIndex: 2, role: "specification", editable: false, numeric: false },
        { key: "inventory:3:unit", header: "단위", sourceIndex: 3, role: "unit", editable: false, numeric: false },
        { key: "inventory:4:total", header: "비교잔량", sourceIndex: 4, role: "calculatedQuantity", editable: false, numeric: true },
      ],
      sourceKind: "DATAOPS_FINALIZED",
      sourceSchemaVersion: DATAOPS_SCHEMA,
    };
  }

  return Object.freeze({
    ERP_SCHEMA,
    READ_SCHEMA,
    DATAOPS_SCHEMA,
    DATAOPS_COLUMNS,
    countScalarCells,
    buildErpCanonical,
    buildErpEnvelope,
    readErpSnapshot,
    readDataOpsSnapshot,
    dataOpsReadModelToParsed,
  });
});
