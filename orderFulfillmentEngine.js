(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ShippingManagementEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ENGINE_VERSION = "3.17.0";
  const WORKSPACE_SCHEMA_VERSION = "shipping-workspace/v2";
  const INVENTORY_OVERRIDE_SCHEMA_VERSION = "shipping-inventory-overrides/v1";
  const HEADER_SCAN_LIMIT = 30;
  const ORDER_REQUIRED_COLUMNS = Object.freeze([
    "품목코드",
    "품목명",
    "규격",
    "수량",
    "적요",
    "적요1",
    "거래처",
    "그룹",
  ]);

  const INVENTORY_REQUIRED_COLUMNS = Object.freeze(["품목코드", "품목명", "규격", "수량"]);

  const ORDER_DATE_COLUMNS = Object.freeze(["일자-No.", "일자", "주문일자"]);

  const ORDER_OPTIONAL_COLUMNS = Object.freeze([
    ...ORDER_DATE_COLUMNS,
    "담당",
    "창고",
    "단위",
    "재고",
    "단가",
    "공급가액",
  ]);

  const ORDER_CANONICAL_ALIASES = Object.freeze({
    "일자-No.": Object.freeze(["일자-No."]),
    "일자": Object.freeze(["일자"]),
    "주문일자": Object.freeze(["주문일자"]),
    "담당": Object.freeze(["담당"]),
    "창고": Object.freeze(["창고", "출고창고"]),
    "단위": Object.freeze(["단위"]),
    "품목코드": Object.freeze(["품목코드", "상품코드", "코드"]),
    "품목명": Object.freeze(["품목명", "상품명", "제품명"]),
    "규격": Object.freeze(["규격"]),
    "수량": Object.freeze(["수량", "주문수량", "미출고수량"]),
    "재고": Object.freeze(["재고"]),
    "단가": Object.freeze(["단가", "판매단가", "출고단가"]),
    "공급가액": Object.freeze(["공급가액", "금액", "합계금액"]),
    "적요": Object.freeze(["적요", "메모", "비고"]),
    "적요1": Object.freeze(["적요1"]),
    "거래처": Object.freeze(["거래처", "거래처명", "고객명"]),
    "그룹": Object.freeze(["그룹"]),
  });

  const INVENTORY_CANONICAL_ALIASES = Object.freeze({
    "사용": Object.freeze(["사용"]),
    "단위": Object.freeze(["단위"]),
    "품목코드": Object.freeze(["품목코드", "상품코드", "제품코드", "코드"]),
    "품목명": Object.freeze(["품목명", "품명", "상품명", "제품명"]),
    "규격": Object.freeze(["규격", "사양"]),
    "수량": Object.freeze(["수량", "재고수량", "합계수량"]),
    "재고": Object.freeze(["재고", "현재고", "기말재고"]),
    "기본": Object.freeze(["기본"]),
    "전송": Object.freeze(["전송"]),
    "창고": Object.freeze(["창고"]),
  });

  const INVENTORY_OPTIONAL_COLUMNS = Object.freeze([
    "사용",
    "단위",
    "재고",
    "2전송",
    "7진영",
    "기본",
    "전송",
    "창고",
  ]);

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === "";
  }

  function cleanText(value) {
    return isBlank(value) ? "" : String(value).trim();
  }

  function originalText(value) {
    return isBlank(value) ? "" : String(value);
  }

  function normalizeHeader(value) {
    return cleanText(value).replace(/\s+/g, "");
  }

  function normalizeOrderHeader(value) {
    return cleanText(value)
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .toLocaleLowerCase("ko-KR");
  }

  function createAliasLookup(defaultAliases, customAliases = {}) {
    const lookup = new Map();
    Object.entries(defaultAliases).forEach(([canonical, aliases]) => {
      [canonical, ...aliases].forEach((alias) => lookup.set(normalizeOrderHeader(alias), canonical));
    });
    Object.entries(customAliases && typeof customAliases === "object" ? customAliases : {})
      .forEach(([canonical, aliases]) => {
        if (!Object.prototype.hasOwnProperty.call(defaultAliases, canonical)) return;
        (Array.isArray(aliases) ? aliases : [aliases]).forEach((alias) => {
          const normalized = normalizeOrderHeader(alias);
          if (normalized) lookup.set(normalized, canonical);
        });
      });
    return lookup;
  }

  function normalizeProductCode(value) {
    if (isBlank(value)) return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
    }
    return String(value).trim();
  }

  function normalizeCategoryCode(value) {
    return normalizeProductCode(value).replace(/\s+/g, "").toUpperCase();
  }

  function stableTextHash(value) {
    const text = String(value ?? "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function validIsoDate(year, month, day) {
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const timestamp = Date.parse(`${iso}T00:00:00.000Z`);
    return Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== iso
      ? ""
      : iso;
  }

  function parseOrderBasisDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return validIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    const text = cleanText(value);
    if (!text) return "";
    let match = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:\D|$)/);
    if (!match) match = text.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/);
    return match ? validIsoDate(Number(match[1]), Number(match[2]), Number(match[3])) : "";
  }

  function roundQuantity(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round((value + Number.EPSILON) * 1e9) / 1e9;
  }

  function parseNumericCell(value) {
    if (isBlank(value)) return { ok: true, value: 0, blank: true };
    if (typeof value === "number") {
      return Number.isFinite(value)
        ? { ok: true, value: roundQuantity(value), blank: false }
        : { ok: false, value: null, blank: false };
    }

    let normalized = String(value).trim().replace(/,/g, "");
    let negative = false;
    if (/^\(.*\)$/.test(normalized)) {
      negative = true;
      normalized = normalized.slice(1, -1);
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return { ok: false, value: null, blank: false };
    return {
      ok: true,
      value: roundQuantity(negative ? -parsed : parsed),
      blank: false,
    };
  }

  function describeInventoryColumns(headerRow, headerAliases = {}) {
    const headers = Array.isArray(headerRow) ? headerRow : [];
    const normalized = headers.map(normalizeHeader);
    const aliasLookup = createAliasLookup(INVENTORY_CANONICAL_ALIASES, headerAliases);
    const canonicals = headers.map((header) => aliasLookup.get(normalizeOrderHeader(header)) || "");
    const quantityIndex = canonicals.indexOf("수량");
    let quantityBoundary = headers.length;
    if (quantityIndex >= 0) {
      for (let index = quantityIndex + 1; index < normalized.length; index += 1) {
        const header = normalized[index];
        if (!header) continue;
        if (
          /^(?:기본|전송|창고|창고단가)$/.test(header) ||
          /단가|가격|금액|원가|메모|비고|적요/.test(header)
        ) {
          quantityBoundary = index;
          break;
        }
      }
    }
    const result = headers.map((value, sourceIndex) => {
      const header = cleanText(value);
      const normalizedLabel = normalizeHeader(header);
      const canonical = canonicals[sourceIndex];
      if (!normalizedLabel) return null;
      let role = "value";
      if (canonical === "품목코드") role = "productCode";
      else if (canonical === "수량") role = "calculatedQuantity";
      else if (canonical === "창고" || /^(?:창고|창고단가)$/.test(normalizedLabel) || /창고.*(?:단가|가격|금액|원가)/.test(normalizedLabel)) {
        role = "warehousePrice";
      } else if (["기본", "전송"].includes(canonical) || /^(?:기본|전송)$/.test(normalizedLabel)) {
        role = "editableText";
      } else if (
        !/단가|가격|금액|원가|메모|비고|적요/.test(normalizedLabel) &&
        (
          /^\d+[^\d].*$/.test(normalizedLabel) ||
          /창고|서울|진영/.test(normalizedLabel) ||
          (quantityIndex >= 0 && sourceIndex > quantityIndex && sourceIndex < quantityBoundary)
        )
      ) {
        role = "warehouseQuantity";
      }
      return {
        key: `inventory:${sourceIndex}:${encodeURIComponent(normalizedLabel)}`,
        header: role === "calculatedQuantity"
          ? "잔량"
          : role === "warehousePrice" && canonical === "창고"
            ? "창고단가"
            : header,
        sourceIndex,
        role,
        editable: ["warehouseQuantity", "warehousePrice", "editableText"].includes(role),
        numeric: ["warehouseQuantity", "warehousePrice", "calculatedQuantity"].includes(role),
      };
    }).filter(Boolean);
    let calculatedIndex = result.findIndex((column) => column.role === "calculatedQuantity");
    if (calculatedIndex < 0) {
      const firstWarehouseIndex = result.findIndex(
        (column) => column.role === "warehouseQuantity",
      );
      const insertIndex = firstWarehouseIndex >= 0 ? firstWarehouseIndex : result.length;
      result.splice(insertIndex, 0, {
        key: "shipping:inventory:calculated-quantity",
        header: "잔량",
        sourceIndex: null,
        role: "calculatedQuantity",
        editable: false,
        numeric: true,
      });
      calculatedIndex = insertIndex;
    }
    result.splice(calculatedIndex, 0, {
      key: "shipping:inventory:order-quantity",
      header: "주문수량",
      sourceIndex: null,
      role: "orderQuantity",
      editable: false,
      numeric: true,
    });
    const usageIndex = result.findIndex((column) => normalizeHeader(column.header) === "사용");
    if (usageIndex >= 0) {
      result.splice(usageIndex, 1);
    }
    return result;
  }

  function toSerializableCell(value) {
    if (value instanceof Date) return value.toISOString();
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value ?? null;
    }
    return String(value);
  }

  function cloneMatrix(matrix) {
    if (!Array.isArray(matrix)) return [];
    return matrix.map((row) =>
      Array.isArray(row) ? row.map(toSerializableCell) : [toSerializableCell(row)],
    );
  }

  function getMatrixCell(matrix, rowIndex, columnIndex) {
    if (!Array.isArray(matrix) || rowIndex < 0 || columnIndex < 0) return null;
    const row = matrix[rowIndex];
    return Array.isArray(row) ? row[columnIndex] ?? null : null;
  }

  function createColumnMap(headerRow) {
    const result = {};
    (Array.isArray(headerRow) ? headerRow : []).forEach((value, index) => {
      const normalized = normalizeHeader(value);
      if (normalized && result[normalized] === undefined) result[normalized] = index;
    });
    return result;
  }

  function resolveOrderHeaders(headerRow, headerAliases = {}) {
    const aliasLookup = createAliasLookup(ORDER_CANONICAL_ALIASES, headerAliases);
    const matches = Object.create(null);
    const mappedColumns = [];
    const unmatchedHeaders = [];
    (Array.isArray(headerRow) ? headerRow : []).forEach((value, columnIndex) => {
      const header = cleanText(value);
      if (!header) return;
      const normalized = normalizeOrderHeader(header);
      const canonical = aliasLookup.get(normalized);
      const metadata = {
        header,
        normalized,
        columnIndex,
        columnNumber: columnIndex + 1,
      };
      if (!canonical) {
        unmatchedHeaders.push(metadata);
        return;
      }
      const mapped = { ...metadata, canonical };
      if (!matches[canonical]) matches[canonical] = [];
      matches[canonical].push(mapped);
      mappedColumns.push(mapped);
    });

    const columnMap = Object.create(null);
    Object.entries(matches).forEach(([canonical, columns]) => {
      if (columns.length === 1) columnMap[normalizeHeader(canonical)] = columns[0].columnIndex;
    });
    const duplicateCanonicalFields = Object.entries(matches)
      .filter(([, columns]) => columns.length > 1)
      .map(([canonical, columns]) => ({ canonical, columns }));
    return {
      columnMap,
      matches,
      mappedColumns,
      unmatchedHeaders,
      duplicateCanonicalFields,
    };
  }

  function resolveInventoryHeaders(headerRow, headerAliases = {}) {
    const lookup = createAliasLookup(INVENTORY_CANONICAL_ALIASES, headerAliases);
    const columnMap = Object.create(null);
    const matches = Object.create(null);
    (Array.isArray(headerRow) ? headerRow : []).forEach((value, columnIndex) => {
      const sourceHeader = normalizeHeader(value);
      if (sourceHeader && columnMap[sourceHeader] === undefined) columnMap[sourceHeader] = columnIndex;
      const canonical = lookup.get(normalizeOrderHeader(value));
      if (!canonical) return;
      if (!matches[canonical]) matches[canonical] = [];
      matches[canonical].push({ header: cleanText(value), canonical, columnIndex, columnNumber: columnIndex + 1 });
    });
    Object.entries(matches).forEach(([canonical, columns]) => {
      if (columns.length === 1) columnMap[normalizeHeader(canonical)] = columns[0].columnIndex;
    });
    return { columnMap, matches };
  }

  function findBestOrderHeaderRow(matrix, headerAliases = {}) {
    let best = { rowIndex: -1, requiredCount: -1, mappedCount: -1 };
    let completeWithConflict = -1;
    const limit = Math.min(Array.isArray(matrix) ? matrix.length : 0, HEADER_SCAN_LIMIT);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const resolution = resolveOrderHeaders(matrix[rowIndex], headerAliases);
      const requiredCount = ORDER_REQUIRED_COLUMNS.filter(
        (canonical) => Array.isArray(resolution.matches[canonical]) && resolution.matches[canonical].length > 0,
      ).length;
      const mappedCount = resolution.mappedColumns.length;
      if (requiredCount === ORDER_REQUIRED_COLUMNS.length) {
        if (resolution.duplicateCanonicalFields.length === 0) return rowIndex;
        if (completeWithConflict < 0) completeWithConflict = rowIndex;
      }
      if (
        requiredCount > best.requiredCount ||
        (requiredCount === best.requiredCount && mappedCount > best.mappedCount)
      ) {
        best = { rowIndex, requiredCount, mappedCount };
      }
    }
    return completeWithConflict >= 0 ? completeWithConflict : best.rowIndex;
  }

  function findBestInventoryHeaderRow(matrix, headerAliases = {}) {
    let best = { rowIndex: -1, count: -1 };
    const limit = Math.min(Array.isArray(matrix) ? matrix.length : 0, HEADER_SCAN_LIMIT);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const resolution = resolveInventoryHeaders(matrix[rowIndex], headerAliases);
      const count = INVENTORY_REQUIRED_COLUMNS.filter(
        (canonical) => Array.isArray(resolution.matches[canonical]) && resolution.matches[canonical].length === 1,
      ).length;
      if (count === INVENTORY_REQUIRED_COLUMNS.length) return rowIndex;
      if (count > best.count) best = { rowIndex, count };
    }
    return best.rowIndex;
  }

  function findHeaderRow(matrix, requiredColumns) {
    const expected = requiredColumns.map(normalizeHeader);
    const limit = Math.min(Array.isArray(matrix) ? matrix.length : 0, HEADER_SCAN_LIMIT);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const map = createColumnMap(matrix[rowIndex]);
      if (expected.every((column) => map[column] !== undefined)) return rowIndex;
    }
    return -1;
  }

  function findBestHeaderRow(matrix, requiredColumns) {
    const exact = findHeaderRow(matrix, requiredColumns);
    if (exact >= 0) return exact;

    const expected = requiredColumns.map(normalizeHeader);
    let best = { rowIndex: -1, count: -1 };
    const limit = Math.min(Array.isArray(matrix) ? matrix.length : 0, HEADER_SCAN_LIMIT);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const map = createColumnMap(matrix[rowIndex]);
      const count = expected.filter((column) => map[column] !== undefined).length;
      if (count > best.count) best = { rowIndex, count };
    }
    return best.rowIndex;
  }

  function getField(row, columnMap, name) {
    const index = columnMap[normalizeHeader(name)];
    return index === undefined || !Array.isArray(row) ? null : row[index] ?? null;
  }

  function hasAnyField(row, columnMap, fieldNames) {
    return fieldNames.some((name) => !isBlank(getField(row, columnMap, name)));
  }

  function createIssue(code, message, details = {}) {
    return { code, message, ...details };
  }

  function prepareSourceMatrix(rawMatrix, displayMatrix, headerRowIndex, productCodeColumnIndex) {
    const source = cloneMatrix(rawMatrix);
    const display = cloneMatrix(displayMatrix);
    const rowCount = Math.max(source.length, display.length);
    while (source.length < rowCount) source.push([]);

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const displayRow = display[rowIndex] || [];
      if (source[rowIndex].length < displayRow.length) {
        source[rowIndex].length = displayRow.length;
      }
      if (rowIndex > headerRowIndex && productCodeColumnIndex >= 0) {
        const displayedCode = displayRow[productCodeColumnIndex];
        const rawCode = source[rowIndex][productCodeColumnIndex];
        if (!isBlank(displayedCode) || !isBlank(rawCode)) {
          source[rowIndex][productCodeColumnIndex] = normalizeProductCode(
            !isBlank(displayedCode) ? displayedCode : rawCode,
          );
        }
      }
    }
    return source;
  }

  function parseOrderWorkbook(input = {}) {
    const displayMatrix = cloneMatrix(input.displayMatrix || input.rawMatrix || []);
    const rawMatrix = cloneMatrix(input.rawMatrix || input.displayMatrix || []);
    const headerAliases = input.headerAliases || {};
    const headerRowIndex = findBestOrderHeaderRow(displayMatrix, headerAliases);
    const headerRow = headerRowIndex >= 0 ? displayMatrix[headerRowIndex] || [] : [];
    const headerResolution = resolveOrderHeaders(headerRow, headerAliases);
    const columnMap = headerResolution.columnMap;
    const missingColumns = ORDER_REQUIRED_COLUMNS.filter(
      (column) => !Array.isArray(headerResolution.matches[column]) || headerResolution.matches[column].length === 0,
    );
    const errors = [];
    const warnings = [];

    if (headerRowIndex < 0 || missingColumns.length > 0) {
      errors.push(
        createIssue(
          "ORDER_REQUIRED_COLUMNS",
          `주문현황 필수 열이 없습니다: ${missingColumns.join(", ") || ORDER_REQUIRED_COLUMNS.join(", ")}`,
          { missingColumns },
        ),
      );
    }

    if (headerResolution.duplicateCanonicalFields.length > 0) {
      const conflictText = headerResolution.duplicateCanonicalFields.map(({ canonical, columns }) =>
        `${canonical}: ${columns.map((column) => `${column.header}(${column.columnNumber}열)`).join(", ")}`,
      ).join(" / ");
      errors.push(
        createIssue(
          "ORDER_DUPLICATE_CANONICAL_HEADERS",
          `주문현황 표준 항목에 둘 이상의 원본 열이 매칭되었습니다: ${conflictText}`,
          { conflicts: headerResolution.duplicateCanonicalFields },
        ),
      );
    }

    if (headerResolution.unmatchedHeaders.length > 0) {
      warnings.push(
        createIssue(
          "ORDER_UNKNOWN_HEADERS",
          `자동 매칭하지 않은 주문현황 열: ${headerResolution.unmatchedHeaders
            .map((column) => `${column.header}(${column.columnNumber}열)`)
            .join(", ")}`,
          { headers: headerResolution.unmatchedHeaders },
        ),
      );
    }

    const rows = [];
    const canonicalMappingIsValid = missingColumns.length === 0 &&
      headerResolution.duplicateCanonicalFields.length === 0;
    if (headerRowIndex >= 0 && canonicalMappingIsValid) {
      for (let rowIndex = headerRowIndex + 1; rowIndex < displayMatrix.length; rowIndex += 1) {
        const row = displayMatrix[rowIndex] || [];
        const code = normalizeProductCode(getField(row, columnMap, "품목코드"));
        const rowLabel = cleanText(row[0]);
        const hasProductData = hasAnyField(row, columnMap, [
          "품목명",
          "규격",
          "수량",
          "단가",
          "적요",
          "적요1",
          "거래처",
          "그룹",
        ]);
        if (!code && /^(합계|총계|소계|total)(?:$|\s|:)/i.test(rowLabel)) continue;
        if (!code && !hasProductData) continue;
        if (!code) {
          errors.push(
            createIssue(
              "ORDER_PRODUCT_CODE_MISSING",
              `${rowIndex + 1}행 주문에 상품코드가 없습니다.`,
              { rowNumber: rowIndex + 1 },
            ),
          );
          continue;
        }

        const quantityCell = getField(row, columnMap, "수량");
        const quantity = parseNumericCell(quantityCell);
        if (!quantity.ok || quantity.blank) {
          errors.push(
            createIssue(
              "ORDER_QUANTITY_INVALID",
              `${rowIndex + 1}행 주문수량은 빈값이 아닌 유한한 숫자여야 합니다.`,
              { rowNumber: rowIndex + 1, productCode: code, value: quantityCell },
            ),
          );
          continue;
        }

        const price = parseNumericCell(getField(row, columnMap, "단가"));
        const supplyAmountCell = getField(row, columnMap, "공급가액");
        const supplyAmount = parseNumericCell(supplyAmountCell);
        const orderNumberValue = getField(row, columnMap, "일자-No.");
        const basisDateCandidates = ORDER_DATE_COLUMNS.map((field) => {
          const value = getField(row, columnMap, field);
          const text = cleanText(value);
          return {
            field,
            value: text,
            basisDate: text ? parseOrderBasisDate(value) : "",
          };
        }).filter((candidate) => candidate.value);
        const rowBasisDates = uniqueTextValues(
          basisDateCandidates.map((candidate) => candidate.basisDate),
        );
        const invalidDateCandidates = basisDateCandidates.filter((candidate) => !candidate.basisDate);
        const rowBasisDateStatus = invalidDateCandidates.length > 0
          ? "invalid"
          : rowBasisDates.length > 1
            ? "conflict"
            : rowBasisDates.length === 1
              ? "valid"
              : "missing";
        rows.push({
          inputOrder: rows.length + 1,
          sourceRowNumber: rowIndex + 1,
          orderNumber: cleanText(orderNumberValue),
          basisDate: rowBasisDateStatus === "valid" ? rowBasisDates[0] : "",
          basisDateStatus: rowBasisDateStatus,
          basisDateCandidates,
          manager: cleanText(getField(row, columnMap, "담당")),
          warehouse: cleanText(getField(row, columnMap, "창고")),
          sourceUnit: cleanText(getField(row, columnMap, "단위")),
          productCode: code,
          productName: cleanText(getField(row, columnMap, "품목명")),
          specification: cleanText(getField(row, columnMap, "규격")),
          quantity: quantity.value,
          sourceStock: getField(row, columnMap, "재고"),
          unitPrice: price.ok && !price.blank ? price.value : null,
          supplyAmount: isBlank(supplyAmountCell)
            ? null
            : supplyAmount.ok
              ? supplyAmount.value
              : cleanText(supplyAmountCell),
          note: cleanText(getField(row, columnMap, "적요")),
          note1: cleanText(getField(row, columnMap, "적요1")),
          noteOriginal: originalText(getField(row, columnMap, "적요")),
          note1Original: originalText(getField(row, columnMap, "적요1")),
          customer: cleanText(getField(row, columnMap, "거래처")),
          group: cleanText(getField(row, columnMap, "그룹")),
        });
      }
    }

    if (canonicalMappingIsValid && rows.length === 0) {
      errors.push(createIssue("ORDER_NO_DATA", "분석할 주문 데이터행이 없습니다."));
    }

    const productCodeColumnIndex =
      columnMap[normalizeHeader("품목코드")] === undefined
        ? -1
        : columnMap[normalizeHeader("품목코드")];
    const memoCount = rows.filter((row) => row.note || row.note1).length;
    const zeroQuantityCount = rows.filter((row) => row.quantity === 0).length;
    const negativeQuantityCount = rows.filter((row) => row.quantity < 0).length;
    if (zeroQuantityCount > 0 || negativeQuantityCount > 0) {
      warnings.push(
        createIssue(
          "ORDER_NON_POSITIVE_QUANTITY",
          `주문수량 0 ${zeroQuantityCount}행, 음수 ${negativeQuantityCount}행을 원 부호 그대로 분석합니다.`,
          { zeroQuantityCount, negativeQuantityCount },
        ),
      );
    }

    return {
      kind: "orders",
      fileName: cleanText(input.fileName) || "주문현황.xlsx",
      sheetName: cleanText(input.sheetName),
      fileHash: cleanText(input.fileHash),
      headerRowIndex,
      headerRowNumber: headerRowIndex >= 0 ? headerRowIndex + 1 : null,
      headers: headerRow.map(cleanText),
      requiredColumns: [...ORDER_REQUIRED_COLUMNS],
      optionalColumns: [...ORDER_OPTIONAL_COLUMNS],
      missingColumns,
      rows,
      rowCount: rows.length,
      memoCount,
      zeroQuantityCount,
      negativeQuantityCount,
      errors,
      warnings,
      headerMapping: {
        schemaVersion: "shipping-order-header-mapping/v1",
        normalization: "unicode-letters-numbers-case-insensitive/v1",
        columns: headerResolution.mappedColumns,
        duplicateCanonicalFields: headerResolution.duplicateCanonicalFields,
        unmatchedHeaders: headerResolution.unmatchedHeaders,
      },
      sourceMatrix: prepareSourceMatrix(
        rawMatrix,
        displayMatrix,
        headerRowIndex,
        productCodeColumnIndex,
      ),
      productCodeColumnIndex,
    };
  }

  function parseInventoryWorkbook(input = {}) {
    const displayMatrix = cloneMatrix(input.displayMatrix || input.rawMatrix || []);
    const rawMatrix = cloneMatrix(input.rawMatrix || input.displayMatrix || []);
    const headerAliases = input.headerAliases || {};
    const headerRowIndex = findBestInventoryHeaderRow(displayMatrix, headerAliases);
    const headerRow = headerRowIndex >= 0 ? displayMatrix[headerRowIndex] || [] : [];
    const headerResolution = resolveInventoryHeaders(headerRow, headerAliases);
    const columnMap = headerResolution.columnMap;
    const columns = describeInventoryColumns(headerRow, headerAliases);
    const warehouseColumns = columns.filter((column) => column.role === "warehouseQuantity");
    const missingColumns = INVENTORY_REQUIRED_COLUMNS.filter(
      (column) => columnMap[normalizeHeader(column)] === undefined,
    );
    const errors = [];
    const warnings = [];

    if (headerRowIndex < 0 || missingColumns.length > 0) {
      errors.push(
        createIssue(
          "INVENTORY_REQUIRED_COLUMNS",
          `창고별재고 필수 열이 없습니다: ${missingColumns.join(", ") || INVENTORY_REQUIRED_COLUMNS.join(", ")}`,
          { missingColumns },
        ),
      );
    }
    if (headerRowIndex >= 0 && warehouseColumns.length === 0) {
      errors.push(
        createIssue(
          "INVENTORY_WAREHOUSE_COLUMNS_REQUIRED",
          "창고별재고에는 수량을 구성하는 창고별 수량 열이 하나 이상 있어야 합니다.",
          { warehouseColumnCount: 0 },
        ),
      );
    }

    const rows = [];
    const occurrences = new Map();
    if (headerRowIndex >= 0 && missingColumns.length === 0 && warehouseColumns.length > 0) {
      for (let rowIndex = headerRowIndex + 1; rowIndex < displayMatrix.length; rowIndex += 1) {
        const row = displayMatrix[rowIndex] || [];
        const code = normalizeProductCode(getField(row, columnMap, "품목코드"));
        const rowLabel = cleanText(row[0]);
        const hasProductData = hasAnyField(row, columnMap, [
          "품목명",
          "규격",
          "1창고",
          "3서울",
          "4전송",
        ]);
        if (!code && /^(합계|총계|소계|total)(?:$|\s|:)/i.test(rowLabel)) continue;
        if (!code && !hasProductData) continue;
        if (!code) {
          errors.push(
            createIssue(
              "INVENTORY_PRODUCT_CODE_MISSING",
              `${rowIndex + 1}행 재고에 상품코드가 없습니다.`,
              { rowNumber: rowIndex + 1 },
            ),
          );
          continue;
        }

        const wholeStockCell = getField(row, columnMap, "1창고");
        const seoulPurchaseCell = getField(row, columnMap, "3서울");
        const transferCell = getField(row, columnMap, "4전송");
        const wholeStock = parseNumericCell(wholeStockCell);
        const seoulPurchase = parseNumericCell(seoulPurchaseCell);
        const transfer = parseNumericCell(transferCell);
        const sourceInventoryTotalCell = getField(row, columnMap, "수량");
        const sourceInventoryTotal = parseNumericCell(sourceInventoryTotalCell);
        const parsedWarehouseValues = warehouseColumns.map((column) => [
          column,
          parseNumericCell(row[column.sourceIndex]),
          row[column.sourceIndex],
        ]);
        const invalidFields = [
          ...(sourceInventoryTotal.ok
            ? []
            : [["수량", sourceInventoryTotal, sourceInventoryTotalCell]]),
          ...parsedWarehouseValues
          .filter(([, parsed]) => !parsed.ok)
          .map(([column, parsed, value]) => [column.header, parsed, value]),
        ];
        if (invalidFields.length > 0) {
          errors.push(
            createIssue(
              "INVENTORY_QUANTITY_INVALID",
              `${rowIndex + 1}행 재고 수량을 숫자로 해석할 수 없습니다: ${invalidFields
                .map(([name]) => name)
                .join(", ")}`,
              {
                rowNumber: rowIndex + 1,
                productCode: code,
                fields: invalidFields.map(([name, , value]) => ({ name, value })),
              },
            ),
          );
          continue;
        }

        if (transfer.value > 0) {
          warnings.push(
            createIssue(
              "INVENTORY_POSITIVE_TRANSFER",
              `${rowIndex + 1}행 ${code}의 4전송이 양수입니다. 원값을 그대로 더해 서울 잔량을 계산합니다.`,
              { rowNumber: rowIndex + 1, productCode: code, value: transfer.value },
            ),
          );
        }
        if (wholeStock.value < 0) {
          warnings.push(
            createIssue(
              "INVENTORY_NEGATIVE_WHOLE_STOCK",
              `${rowIndex + 1}행 ${code}의 1창고가 음수이므로 출고 가능 전재고는 0으로 계산합니다.`,
              { rowNumber: rowIndex + 1, productCode: code, value: wholeStock.value },
            ),
          );
        }

        const inventoryTotal = roundQuantity(
          parsedWarehouseValues.reduce((sum, [, parsed]) => sum + parsed.value, 0),
        );
        if (sourceInventoryTotal.value !== inventoryTotal) {
          errors.push(
            createIssue(
              "INVENTORY_TOTAL_MISMATCH",
              `${rowIndex + 1}행 ${code}의 수량(${sourceInventoryTotal.value})과 창고별 수량 합계(${inventoryTotal})가 일치하지 않습니다.`,
              {
                rowNumber: rowIndex + 1,
                productCode: code,
                sourceInventoryTotal: sourceInventoryTotal.value,
                warehouseInventoryTotal: inventoryTotal,
              },
            ),
          );
          continue;
        }
        rows.push({
          sourceRowNumber: rowIndex + 1,
          productCode: code,
          productName: cleanText(getField(row, columnMap, "품목명")),
          specification: cleanText(getField(row, columnMap, "규격")),
          unit: cleanText(getField(row, columnMap, "단위")),
          wholeStockRaw: wholeStock.value,
          wholeStockAvailable: Math.max(0, wholeStock.value),
          seoulFirstPurchaseRaw: seoulPurchase.value,
          firstTransferRaw: transfer.value,
          seoulFirstPurchaseRemaining: Math.max(
            0,
            roundQuantity(seoulPurchase.value + transfer.value),
          ),
          sourceInventoryTotal: sourceInventoryTotal.value,
          inventoryTotal,
        });

        if (!occurrences.has(code)) occurrences.set(code, []);
        occurrences.get(code).push(rowIndex + 1);
      }
    }

    const duplicateCodes = [...occurrences.entries()]
      .filter(([, rowNumbers]) => rowNumbers.length > 1)
      .map(([productCode, rowNumbers]) => ({ productCode, rowNumbers }));
    for (const duplicate of duplicateCodes) {
      errors.push(
        createIssue(
          "INVENTORY_DUPLICATE_PRODUCT_CODE",
          `재고 상품코드 ${duplicate.productCode}가 ${duplicate.rowNumbers.join(", ")}행에 중복되어 있습니다.`,
          duplicate,
        ),
      );
    }

    if (missingColumns.length === 0 && rows.length === 0) {
      errors.push(createIssue("INVENTORY_NO_DATA", "분석할 재고 데이터행이 없습니다."));
    }

    const productCodeColumnIndex =
      columnMap[normalizeHeader("품목코드")] === undefined
        ? -1
        : columnMap[normalizeHeader("품목코드")];

    return {
      kind: "inventory",
      fileName: cleanText(input.fileName) || "창고별재고.xlsx",
      sheetName: cleanText(input.sheetName),
      fileHash: cleanText(input.fileHash),
      headerRowIndex,
      headerRowNumber: headerRowIndex >= 0 ? headerRowIndex + 1 : null,
      headers: headerRow.map(cleanText),
      requiredColumns: [...INVENTORY_REQUIRED_COLUMNS],
      optionalColumns: [...INVENTORY_OPTIONAL_COLUMNS],
      missingColumns,
      rows,
      rowCount: rows.length,
      duplicateCodes,
      errors,
      warnings,
      sourceMatrix: prepareSourceMatrix(
        rawMatrix,
        displayMatrix,
        headerRowIndex,
        productCodeColumnIndex,
      ),
      productCodeColumnIndex,
      columns,
    };
  }

  function buildNoticeId(row) {
    const sourceRowNumber = Number(row?.sourceRowNumber) || 0;
    const fingerprint = stableTextHash([
      sourceRowNumber,
      Number(row?.inputOrder) || 0,
      normalizeProductCode(row?.productCode),
      cleanText(row?.manager),
      cleanText(row?.customer),
      originalText(row?.noteOriginal ?? row?.note),
      originalText(row?.note1Original ?? row?.note1),
    ].join("\u001f"));
    return `notice-${sourceRowNumber}-${fingerprint}`;
  }

  function canonicalizeJsonValue(value) {
    if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
    if (value && typeof value === "object") {
      return Object.keys(value).sort().reduce((result, key) => {
        const item = value[key];
        if (item !== undefined) result[key] = canonicalizeJsonValue(item);
        return result;
      }, {});
    }
    return value;
  }

  function canonicalStringify(value) {
    return JSON.stringify(canonicalizeJsonValue(value));
  }

  function containsCloudTokenKey(value) {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsCloudTokenKey);
    return Object.entries(value).some(([key, item]) =>
      /cloud.?token|token/i.test(key) || containsCloudTokenKey(item),
    );
  }

  function sanitizeCloudTokenKeys(value) {
    if (Array.isArray(value)) return value.map(sanitizeCloudTokenKeys);
    if (value && typeof value === "object") {
      return Object.entries(value).reduce((result, [key, item]) => {
        if (!/cloud.?token|token/i.test(key)) result[key] = sanitizeCloudTokenKeys(item);
        return result;
      }, {});
    }
    return value;
  }

  function buildLocalRecoveryPayload(workspace, ui = {}, settings = {}, updatedAt) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    const payload = {
      schemaVersion: "shipping-local-recovery-payload/v2",
      sourceFingerprint: cleanText(workspace.sourceFingerprint),
      workspaceSchemaVersion: workspace.schemaVersion,
      updatedAt: cleanText(updatedAt) || new Date().toISOString(),
      workspace,
      ui: { activePreview: cleanText(ui.activePreview) || "validation" },
      settings: {
        cloudUrl: cleanText(settings.cloudUrl),
        savedBy: cleanText(settings.savedBy),
      },
    };
    if (!/^[a-f0-9]{64}$/.test(payload.sourceFingerprint)) {
      throw new Error("로컬 복구 payload의 source fingerprint가 올바르지 않습니다.");
    }
    const serialized = JSON.parse(JSON.stringify(payload));
    if (containsCloudTokenKey(serialized)) {
      throw new Error("로컬 복구 payload에는 Cloud token을 저장할 수 없습니다.");
    }
    return serialized;
  }

  async function commitVerifiedRecoveryRecord(record, adapter = {}) {
    const required = ["getPointer", "setPointer", "clearPointer", "putRecord", "readRecord", "verifyRecord"];
    if (required.some((name) => typeof adapter[name] !== "function")) {
      throw new Error("로컬 복구 저장 adapter가 올바르지 않습니다.");
    }
    const previousPointer = await adapter.getPointer();
    await adapter.putRecord(record);
    const reread = await adapter.readRecord(record.recordId);
    const verification = await adapter.verifyRecord(reread);
    const verified = verification === true || verification?.valid === true;
    if (!verified) {
      if (typeof adapter.deleteRecord === "function") {
        try { await adapter.deleteRecord(record.recordId); } catch (error) {}
      }
      const reason = verification?.reason ? `: ${verification.reason}` : "";
      throw new Error(`새 복구자료 검산 실패${reason}`);
    }
    try {
      await adapter.setPointer(record.recordId);
    } catch (error) {
      if (typeof adapter.restorePointer === "function") await adapter.restorePointer(previousPointer);
      else if (previousPointer) await adapter.setPointer(previousPointer);
      else await adapter.clearPointer();
      if (typeof adapter.deleteRecord === "function") {
        try { await adapter.deleteRecord(record.recordId); } catch (cleanupError) {}
      }
      throw error;
    }
    return reread;
  }

  function selectLatestVerifiedRecovery(candidates, pointer = "") {
    const list = Array.isArray(candidates) ? [...candidates] : [];
    const timestamp = (candidate) => {
      const parsed = Date.parse(candidate?.record?.updatedAt || "");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    list.sort((left, right) => timestamp(right) - timestamp(left));
    const valid = list.filter((candidate) => candidate?.valid === true);
    const selected = valid[0]?.record || null;
    const pointed = list.find((candidate) => candidate?.record?.recordId === pointer);
    return {
      candidates: list,
      selected,
      corruptionDetected: list.some((candidate) => candidate?.valid !== true) || Boolean(pointer && !pointed?.valid),
      pointerOutdated: Boolean(selected && pointed?.valid && selected.recordId !== pointed.record.recordId),
    };
  }

  function collectNotices(orderRows) {
    return orderRows
      .filter((row) => row.note || row.note1)
      .map((row) => ({
        noticeId: buildNoticeId(row),
        inputOrder: row.inputOrder,
        sourceRowNumber: row.sourceRowNumber,
        productCode: row.productCode,
        productName: row.productName,
        specification: row.specification,
        warehouse: row.warehouse,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        supplyAmount: row.supplyAmount,
        note: originalText(row.noteOriginal ?? row.note),
        note1: originalText(row.note1Original ?? row.note1),
        manager: row.manager,
        customer: row.customer,
        group: row.group,
      }));
  }

  function ensureNoticeState(workspace) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    if (!Array.isArray(workspace.notices)) {
      workspace.notices = collectNotices(Array.isArray(workspace.orders) ? workspace.orders : []);
    }
    const existing = workspace.noticeAcknowledgements;
    const acknowledgedIds = Array.isArray(existing?.acknowledgedIds)
      ? uniqueTextValues(existing.acknowledgedIds)
      : [];
    const validIds = new Set(workspace.notices.map((notice) => cleanText(notice.noticeId)).filter(Boolean));
    workspace.noticeAcknowledgements = {
      schemaVersion: "shipping-notice-acknowledgements/v1",
      acknowledgedIds: acknowledgedIds.filter((noticeId) => validIds.has(noticeId)),
    };
    return workspace.noticeAcknowledgements;
  }

  function isNoticeAcknowledged(workspace, noticeId) {
    const state = ensureNoticeState(workspace);
    return state.acknowledgedIds.includes(cleanText(noticeId));
  }

  function setNoticeAcknowledged(workspace, noticeId, acknowledged) {
    const state = ensureNoticeState(workspace);
    const normalizedId = cleanText(noticeId);
    if (!normalizedId || !workspace.notices.some((notice) => notice.noticeId === normalizedId)) {
      throw new Error("전달사항 항목을 찾을 수 없습니다.");
    }
    const ids = new Set(state.acknowledgedIds);
    if (acknowledged) ids.add(normalizedId);
    else ids.delete(normalizedId);
    state.acknowledgedIds = [...ids];
    return state;
  }

  function validateInputs(ordersParsed, inventoryParsed) {
    const orderErrors = Array.isArray(ordersParsed?.errors) ? ordersParsed.errors : [];
    const inventoryErrors = Array.isArray(inventoryParsed?.errors)
      ? inventoryParsed.errors
      : [];
    const errors = [...orderErrors, ...inventoryErrors];
    const warnings = [
      ...(Array.isArray(ordersParsed?.warnings) ? ordersParsed.warnings : []),
      ...(Array.isArray(inventoryParsed?.warnings) ? inventoryParsed.warnings : []),
    ];

    const inventoryCodes = new Set(
      (inventoryParsed?.rows || []).map((row) => row.productCode),
    );
    const unmatchedCodes = [
      ...new Set(
        (ordersParsed?.rows || [])
          .map((row) => row.productCode)
          .filter((code) => code && !inventoryCodes.has(code)),
      ),
    ];
    const notices = collectNotices(ordersParsed?.rows || []);
    const duplicateCodes = inventoryParsed?.duplicateCodes || [];

    return {
      canAnalyze: Boolean(ordersParsed && inventoryParsed && errors.length === 0),
      blockingCount: errors.length,
      errors,
      warnings,
      unmatchedCodes,
      unmatchedCount: unmatchedCodes.length,
      duplicateCodes,
      duplicateCount: duplicateCodes.length,
      notices,
      noticeCount: notices.length,
      memoIssues: notices,
      memoCount: notices.length,
    };
  }

  function classifyAllocation(currentAllocation, seoulAllocation, purchaseNeed, matched) {
    if (!matched) return "재고정보 없음";
    if (purchaseNeed > 0) {
      return currentAllocation + seoulAllocation > 0
        ? "부분출고·추가구매"
        : "추가 구매 필요";
    }
    if (currentAllocation > 0 && seoulAllocation > 0) return "혼합출고";
    if (seoulAllocation > 0) return "서울 1차 구매분 출고";
    return "전재고 출고";
  }

  function uniqueJoined(values) {
    return [...new Set(values.filter(Boolean))].join(", ");
  }

  function uniqueTextValues(values) {
    return [...new Set(values.map(cleanText).filter(Boolean))];
  }

  function formatPlainNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(roundQuantity(value));
  }

  function formatGroupedNumber(value) {
    const plain = formatPlainNumber(value);
    if (!plain) return "";
    const [integerPart, fractionPart] = plain.split(".");
    const sign = integerPart.startsWith("-") ? "-" : "";
    const digits = sign ? integerPart.slice(1) : integerPart;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}${grouped}${fractionPart === undefined ? "" : `.${fractionPart}`}`;
  }

  function uniqueSupplierPairs(rows) {
    const seen = new Set();
    const result = [];
    rows.forEach((row) => {
      const customer = cleanText(row.customer);
      const unitPrice = typeof row.unitPrice === "number" && Number.isFinite(row.unitPrice)
        ? row.unitPrice
        : null;
      if (!customer && unitPrice === null) return;
      const key = JSON.stringify([customer, unitPrice]);
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        customer,
        unitPrice,
        display: `${customer}${unitPrice === null ? "" : `(${formatPlainNumber(unitPrice)})`}`,
      });
    });
    return result;
  }

  function buildPlanId(basisDate, sourceFingerprint) {
    const date = String(basisDate || "").replace(/[^0-9]/g, "");
    const fingerprint = String(sourceFingerprint || "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
    return date.length === 8 && fingerprint.length >= 16
      ? `SHIPPLAN-${date}-${fingerprint.slice(0, 16)}`
      : "";
  }

  function isPurchaseUploadExcluded(value) {
    return value === "대체" || value === "소분";
  }

  function createInventoryShadowRow(inventory) {
    return {
      rowType: "main",
      referenceFor: "",
      inventoryShadow: true,
      productCode: inventory.productCode,
      productName: inventory.productName,
      specification: inventory.specification,
      inventoryMatched: true,
      matchStatus: "매칭완료",
      wholeStockRaw: inventory.wholeStockRaw,
      wholeStockAvailable: inventory.wholeStockAvailable,
      seoulFirstPurchaseRaw: inventory.seoulFirstPurchaseRaw,
      firstTransferRaw: inventory.firstTransferRaw,
      seoulFirstPurchaseRemaining: inventory.seoulFirstPurchaseRemaining,
      totalOrderQuantity: null,
      wholeAllocation: null,
      seoulAllocation: null,
      purchaseNeed: null,
      orderCount: null,
      customers: "",
      suppliers: "",
      supplierPairs: [],
      groups: "",
      managers: "",
      manager: "",
      noteValues: [],
      note1Values: [],
      notes: "",
      notes1: "",
      purchase: "",
      status: "전체 재고",
      reconciliationDifference: null,
    };
  }

  function ensureInventoryPurchaseRows(workspace) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    if (!Array.isArray(workspace.purchaseManagement)) workspace.purchaseManagement = [];
    const mainCodes = new Set(
      workspace.purchaseManagement
        .filter((row) => row?.rowType === "main")
        .map((row) => normalizeProductCode(row.productCode))
        .filter(Boolean),
    );
    (Array.isArray(workspace.inventory) ? workspace.inventory : []).forEach((inventory) => {
      const productCode = normalizeProductCode(inventory?.productCode);
      if (!productCode || mainCodes.has(productCode)) return;
      workspace.purchaseManagement.push(createInventoryShadowRow({
        ...inventory,
        productCode,
      }));
      mainCodes.add(productCode);
    });
    return workspace;
  }

  function getInventoryColumnDescriptors(workspace) {
    const source = workspace?.sourceFiles?.inventory || {};
    const matrix = Array.isArray(source.matrix) ? source.matrix : [];
    const headerRowIndex = Math.max(0, Number(source.headerRowIndex) || 0);
    const derived = describeInventoryColumns(matrix[headerRowIndex] || []);
    const stored = Array.isArray(source.columns) ? source.columns : [];
    if (stored.length !== derived.length) return derived;
    const storedIsValid = stored.every((column, index) =>
      column &&
      column.key === derived[index].key &&
      column.header === derived[index].header &&
      (column.sourceIndex === derived[index].sourceIndex ||
        (column.sourceIndex === null && derived[index].sourceIndex === null)) &&
      column.role === derived[index].role &&
      column.editable === derived[index].editable &&
      column.numeric === derived[index].numeric,
    );
    return storedIsValid ? stored.map((column) => ({ ...column })) : derived;
  }

  function createInventoryOverrideStore(workspace) {
    if (
      !workspace.inventoryOverrides ||
      workspace.inventoryOverrides.schemaVersion !== INVENTORY_OVERRIDE_SCHEMA_VERSION ||
      !Array.isArray(workspace.inventoryOverrides.cells)
    ) {
      workspace.inventoryOverrides = {
        schemaVersion: INVENTORY_OVERRIDE_SCHEMA_VERSION,
        cells: [],
      };
    }
    return workspace.inventoryOverrides;
  }

  function normalizeInventoryOverrideValue(column, value) {
    if (!column?.editable) return { ok: false, value: null };
    if (column.numeric) {
      const parsed = parseNumericCell(value);
      if (!parsed.ok) return { ok: false, value: null };
      return { ok: true, value: parsed.blank ? "" : parsed.value };
    }
    if (value === null || value === undefined) return { ok: true, value: "" };
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return { ok: false, value: null };
    }
    return { ok: true, value: String(value) };
  }

  function getInventoryOverrideMap(workspace, columns = getInventoryColumnDescriptors(workspace)) {
    const result = new Map();
    const store = workspace?.inventoryOverrides;
    if (
      !store ||
      store.schemaVersion !== INVENTORY_OVERRIDE_SCHEMA_VERSION ||
      !Array.isArray(store.cells)
    ) return result;
    const columnByKey = new Map(columns.map((column) => [column.key, column]));
    const validCodes = new Set(
      [
        ...(Array.isArray(workspace.inventory) ? workspace.inventory : []),
        ...(Array.isArray(workspace.orders) ? workspace.orders : []),
      ]
        .map((row) => normalizeProductCode(row?.productCode))
        .filter(Boolean),
    );
    store.cells.forEach((cell) => {
      const productCode = normalizeProductCode(cell?.productCode);
      const column = columnByKey.get(String(cell?.columnKey || ""));
      if (!productCode || !validCodes.has(productCode) || !column?.editable) return;
      const normalized = normalizeInventoryOverrideValue(column, cell.value);
      if (!normalized.ok) return;
      result.set(`${productCode}\u001f${column.key}`, normalized.value);
    });
    return result;
  }

  function getInventorySourceRow(workspace, inventory) {
    const source = workspace?.sourceFiles?.inventory || {};
    const matrix = Array.isArray(source.matrix) ? source.matrix : [];
    const headerRowIndex = Math.max(0, Number(source.headerRowIndex) || 0);
    const sourceRowNumber = Number(inventory?.sourceRowNumber);
    if (!Number.isFinite(sourceRowNumber) || sourceRowNumber <= headerRowIndex + 1) return [];
    const sourceRowIndex = sourceRowNumber - 1;
    return Array.isArray(matrix[sourceRowIndex]) ? matrix[sourceRowIndex] : [];
  }

  function getEffectiveInventoryCell(workspace, inventory, column, overrideMap) {
    const productCode = normalizeProductCode(inventory?.productCode);
    if (column.role === "productCode") return productCode;
    const sourceRow = getInventorySourceRow(workspace, inventory);
    const map = overrideMap || getInventoryOverrideMap(workspace);
    const overrideKey = `${productCode}\u001f${column.key}`;
    if (column.editable && map.has(overrideKey)) return map.get(overrideKey);
    return toSerializableCell(sourceRow[column.sourceIndex]);
  }

  function calculateInventoryTotal(workspace, inventory, columns, overrideMap) {
    return roundQuantity(
      columns
        .filter((column) => column.role === "warehouseQuantity")
        .reduce((sum, column) => {
          const parsed = parseNumericCell(
            getEffectiveInventoryCell(workspace, inventory, column, overrideMap),
          );
          return sum + (parsed.ok ? parsed.value : 0);
        }, 0),
    );
  }

  function inventorySupplierDisplay(workspace, productCode) {
    const summary = (workspace?.productSummaries || []).find(
      (row) => normalizeProductCode(row?.productCode) === normalizeProductCode(productCode),
    );
    return String(summary?.suppliers || "");
  }

  function orderInformationDisplay(workspace, productCode) {
    const code = normalizeProductCode(productCode);
    return (Array.isArray(workspace?.orders) ? workspace.orders : [])
      .filter((row) => normalizeProductCode(row?.productCode) === code)
      .map((row) => {
        const customer = cleanText(row.customer);
        const quantity = formatPlainNumber(row.quantity);
        const unitPrice = typeof row.unitPrice === "number" && Number.isFinite(row.unitPrice)
          ? formatGroupedNumber(row.unitPrice)
          : "";
        return `${customer}${quantity ? `(${quantity})` : ""}${unitPrice}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  function orderNoteDisplay(workspace, productCode) {
    const code = normalizeProductCode(productCode);
    return (Array.isArray(workspace?.orders) ? workspace.orders : [])
      .filter((row) => normalizeProductCode(row?.productCode) === code)
      .map((row) => [
          originalText(row.noteOriginal ?? row.note),
          originalText(row.note1Original ?? row.note1),
        ].filter((value) => String(value).trim() !== "").join(" / "))
      .filter(Boolean)
      .join("\n");
  }

  function getInventoryViewRows(workspace) {
    ensureInventoryPurchaseRows(workspace);
    const columns = getInventoryColumnDescriptors(workspace);
    const overrideMap = getInventoryOverrideMap(workspace, columns);
    const purchaseInputs = getPurchaseInputs(workspace);
    const inventoryAliasLookup = createAliasLookup(INVENTORY_CANONICAL_ALIASES);
    const orderProducts = new Map();
    (Array.isArray(workspace?.orders) ? workspace.orders : []).forEach((order) => {
      const productCode = normalizeProductCode(order?.productCode);
      if (!productCode) return;
      if (!orderProducts.has(productCode)) {
        orderProducts.set(productCode, {
          productCode,
          productName: cleanText(order?.productName),
          specification: cleanText(order?.specification),
          unit: cleanText(order?.sourceUnit),
          orderQuantity: 0,
        });
      }
      const product = orderProducts.get(productCode);
      if (!product.productName) product.productName = cleanText(order?.productName);
      if (!product.specification) product.specification = cleanText(order?.specification);
      if (!product.unit) product.unit = cleanText(order?.sourceUnit);
      const parsed = parseNumericCell(order?.quantity);
      product.orderQuantity = roundQuantity(
        product.orderQuantity + (parsed.ok ? parsed.value : 0),
      );
    });
    const inventoryCodes = new Set();
    const rows = (Array.isArray(workspace.inventory) ? workspace.inventory : []).map((inventory) => {
      const productCode = normalizeProductCode(inventory.productCode);
      inventoryCodes.add(productCode);
      const stockTotal = calculateInventoryTotal(workspace, inventory, columns, overrideMap);
      const orderQuantity = orderProducts.get(productCode)?.orderQuantity || 0;
      const remainingQuantity = roundQuantity(stockTotal - orderQuantity);
      const values = columns.map((column) => {
        if (column.role === "orderQuantity") return orderQuantity;
        if (column.role === "calculatedQuantity") {
          return remainingQuantity;
        }
        return getEffectiveInventoryCell(workspace, inventory, column, overrideMap);
      });
      return {
        productCode,
        productName: cleanText(inventory.productName),
        specification: cleanText(inventory.specification),
        values,
        inventoryTotal: stockTotal,
        stockTotal,
        orderQuantity,
        remainingQuantity,
        purchaseNeed: remainingQuantity < 0 ? roundQuantity(Math.abs(remainingQuantity)) : 0,
        purchase: String(purchaseInputs[productCode] || ""),
        suppliers: inventorySupplierDisplay(workspace, productCode),
        orderInformation: orderInformationDisplay(workspace, productCode),
        orderNotes: orderNoteDisplay(workspace, productCode),
        inventoryMissing: false,
      };
    });
    orderProducts.forEach((product, productCode) => {
      if (inventoryCodes.has(productCode)) return;
      const inventory = {
        productCode,
        productName: product.productName,
        specification: product.specification,
        unit: product.unit,
        sourceRowNumber: null,
      };
      const stockTotal = calculateInventoryTotal(workspace, inventory, columns, overrideMap);
      const orderQuantity = product.orderQuantity;
      const remainingQuantity = roundQuantity(stockTotal - orderQuantity);
      const values = columns.map((column) => {
        if (column.role === "orderQuantity") return orderQuantity;
        if (column.role === "calculatedQuantity") return remainingQuantity;
        if (column.role === "productCode") return productCode;
        const effectiveValue = getEffectiveInventoryCell(workspace, inventory, column, overrideMap);
        if (column.editable && effectiveValue !== null) return effectiveValue;
        if (column.role === "warehouseQuantity") return 0;
        const canonical = inventoryAliasLookup.get(normalizeOrderHeader(column.header));
        if (canonical === "품목명") return product.productName;
        if (canonical === "규격") return product.specification;
        if (canonical === "단위") return product.unit;
        return null;
      });
      rows.push({
        productCode,
        productName: product.productName,
        specification: product.specification,
        values,
        inventoryTotal: stockTotal,
        stockTotal,
        orderQuantity,
        remainingQuantity,
        purchaseNeed: null,
        purchase: String(purchaseInputs[productCode] || ""),
        suppliers: inventorySupplierDisplay(workspace, productCode),
        orderInformation: orderInformationDisplay(workspace, productCode),
        orderNotes: orderNoteDisplay(workspace, productCode),
        inventoryMissing: true,
      });
    });
    const negativeCount = rows.filter((row) => row.remainingQuantity < 0).length;
    if (workspace.stats && typeof workspace.stats === "object") {
      workspace.stats.inventoryNegativeCount = negativeCount;
    }
    return { columns, headers: columns.map((column) => column.header), rows };
  }

  function getShortageCategoryContext(workspace) {
    const inventoryRows = getInventoryViewRows(workspace).rows;
    const shortageRows = inventoryRows.filter((row) =>
      !row.inventoryMissing && row.orderQuantity > 0 && row.remainingQuantity < 0,
    );
    const shortageCodes = new Set(shortageRows.map((row) => normalizeProductCode(row.productCode)));
    const categories = new Map();

    shortageRows.forEach((row) => {
      const normalized = normalizeCategoryCode(row.productCode);
      if (normalized.length < 6) return;
      const categoryCode = normalized.slice(0, 6);
      if (!categories.has(categoryCode)) {
        categories.set(categoryCode, {
          categoryCode,
          shortageProductCodes: [],
          candidateProductCodes: [],
        });
      }
      categories.get(categoryCode).shortageProductCodes.push(row.productCode);
    });

    inventoryRows.forEach((row) => {
      if (row.inventoryMissing) return;
      const productCode = normalizeProductCode(row.productCode);
      if (!productCode || shortageCodes.has(productCode)) return;
      const normalized = normalizeCategoryCode(productCode);
      if (normalized.length < 6) return;
      const category = categories.get(normalized.slice(0, 6));
      if (category) category.candidateProductCodes.push(row.productCode);
    });

    const categoryRows = [...categories.values()]
      .map((category) => ({
        ...category,
        shortageProductCodes: [...new Set(category.shortageProductCodes)].sort(),
        candidateProductCodes: [...new Set(category.candidateProductCodes)].sort(),
      }))
      .sort((left, right) => left.categoryCode.localeCompare(right.categoryCode, "ko"));
    const candidateProductCodes = [...new Set(
      categoryRows.flatMap((category) => category.candidateProductCodes),
    )].sort();
    const shortageProductCodes = [...shortageCodes].sort();
    return {
      shortageCount: shortageProductCodes.length,
      shortageProductCodes,
      candidateProductCodes,
      categories: categoryRows,
    };
  }

  function getStockLedgerView(workspace) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    const inboundByCode = new Map();
    const purchasePartnersByCode = new Map();
    const purchaseRows = workspace?.orderOpsInputs?.purchases?.rows;
    (Array.isArray(purchaseRows) ? purchaseRows : []).forEach((row) => {
      const productCode = normalizeProductCode(row?.productCode);
      const parsed = parseNumericCell(row?.quantity);
      if (!productCode || !parsed.ok) return;
      inboundByCode.set(
        productCode,
        roundQuantity((inboundByCode.get(productCode) || 0) + parsed.value),
      );
      const partner = cleanText(row?.partner);
      if (partner) {
        if (!purchasePartnersByCode.has(productCode)) purchasePartnersByCode.set(productCode, new Set());
        purchasePartnersByCode.get(productCode).add(partner);
      }
    });
    const salesByCode = new Map();
    const salesMetadataByCode = new Map();
    const salesRows = workspace?.orderOpsInputs?.sales?.rows;
    (Array.isArray(salesRows) ? salesRows : []).forEach((row) => {
      const productCode = normalizeProductCode(row?.productCode);
      const parsed = parseNumericCell(row?.quantity);
      if (!productCode || !parsed.ok) return;
      salesByCode.set(
        productCode,
        roundQuantity((salesByCode.get(productCode) || 0) + parsed.value),
      );
      if (!salesMetadataByCode.has(productCode)) {
        salesMetadataByCode.set(productCode, {
          productName: cleanText(row?.productName),
        });
      }
    });
    const inventoryView = getInventoryViewRows(workspace);
    const unitPriceColumnIndex = inventoryView.columns.findIndex(
      (column) => column.role === "warehousePrice" && normalizeHeader(column.header) === "창고단가",
    );
    const fallbackUnitPriceColumnIndex = inventoryView.columns.findIndex(
      (column) => column.role === "warehousePrice",
    );
    const effectiveUnitPriceColumnIndex = unitPriceColumnIndex >= 0
      ? unitPriceColumnIndex
      : fallbackUnitPriceColumnIndex;
    const unitPriceColumn = effectiveUnitPriceColumnIndex >= 0
      ? inventoryView.columns[effectiveUnitPriceColumnIndex]
      : null;
    const columns = [
      { key: "ledger:product-code", header: "품목코드", role: "productCode", numeric: false },
      { key: "ledger:product-name", header: "품목명", role: "productName", numeric: false },
      { key: "ledger:specification", header: "규격", role: "specification", numeric: false },
      { key: "ledger:unit", header: "단위", role: "unit", numeric: false },
      { key: "ledger:stock", header: "재고", role: "stockQuantity", numeric: true },
      { key: "ledger:inbound", header: "입고", role: "inboundQuantity", numeric: true },
      { key: "ledger:outbound", header: "주문", role: "orderQuantity", numeric: true },
      { key: "ledger:sales", header: "출고수량", role: "salesQuantity", numeric: true },
      { key: "ledger:remaining", header: "잔량", role: "calculatedQuantity", numeric: true },
      {
        key: "ledger:unit-price",
        header: "단가",
        role: "unitPrice",
        numeric: true,
        editable: Boolean(unitPriceColumn?.editable),
        inventoryColumnKey: unitPriceColumn?.key || "",
      },
      { key: "ledger:purchase-place", header: "구매처", role: "purchasePlace", numeric: false },
      { key: "ledger:information", header: "정보", role: "orderInformation", numeric: false },
    ];
    const rows = inventoryView.rows.map((inventory) => {
      const source = (workspace.inventory || []).find(
        (candidate) => normalizeProductCode(candidate?.productCode) === inventory.productCode,
      ) || {};
      const values = [
        inventory.productCode,
        inventory.productName,
        inventory.specification,
        cleanText(source.unit),
        inventory.stockTotal,
        inboundByCode.get(inventory.productCode) || 0,
        inventory.orderQuantity,
        salesByCode.get(inventory.productCode) || 0,
        inventory.remainingQuantity,
        effectiveUnitPriceColumnIndex >= 0 ? inventory.values[effectiveUnitPriceColumnIndex] : "",
        inventory.purchase || [...(purchasePartnersByCode.get(inventory.productCode) || [])].join(", "),
        inventory.orderInformation || "",
      ];
      return {
        ...inventory,
        sourceRow: source,
        unitPriceColumnKey: unitPriceColumn?.key || "",
        values,
      };
    });
    const inventoryCodes = new Set(rows.map((row) => normalizeProductCode(row.productCode)));
    const purchaseInputs = getPurchaseInputs(workspace);
    salesByCode.forEach((salesQuantity, productCode) => {
      if (inventoryCodes.has(productCode)) return;
      const orderQuantity = roundQuantity(
        (Array.isArray(workspace?.orders) ? workspace.orders : [])
          .filter((order) => normalizeProductCode(order?.productCode) === productCode)
          .reduce((sum, order) => {
            const parsed = parseNumericCell(order?.quantity);
            return sum + (parsed.ok ? parsed.value : 0);
          }, 0),
      );
      const remainingQuantity = roundQuantity(0 - orderQuantity);
      const purchase = String(
        purchaseInputs[productCode] || [...(purchasePartnersByCode.get(productCode) || [])].join(", "),
      );
      const productName = salesMetadataByCode.get(productCode)?.productName || "";
      rows.push({
        productCode,
        productName,
        specification: "",
        sourceRow: null,
        values: [
          productCode,
          productName,
          "",
          "",
          0,
          inboundByCode.get(productCode) || 0,
          orderQuantity,
          salesQuantity,
          remainingQuantity,
          "",
          purchase,
          orderInformationDisplay(workspace, productCode),
        ],
        inventoryTotal: 0,
        stockTotal: 0,
        orderQuantity,
        remainingQuantity,
        purchase,
        suppliers: "",
        orderInformation: orderInformationDisplay(workspace, productCode),
        orderNotes: orderNoteDisplay(workspace, productCode),
        salesOnly: true,
      });
    });
    return { columns, headers: columns.map((column) => column.header), rows };
  }

  function setInventoryOverride(workspace, productCode, columnKey, value) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    const code = normalizeProductCode(productCode);
    const columns = getInventoryColumnDescriptors(workspace);
    const column = columns.find((candidate) => candidate.key === String(columnKey || ""));
    if (!code || !column?.editable) throw new Error("수정할 수 없는 재고 셀입니다.");
    if (![
      ...(Array.isArray(workspace.inventory) ? workspace.inventory : []),
      ...(Array.isArray(workspace.orders) ? workspace.orders : []),
    ].some((row) => normalizeProductCode(row?.productCode) === code)) {
      throw new Error("수정할 재고 품목을 찾지 못했습니다.");
    }
    const normalized = normalizeInventoryOverrideValue(column, value);
    if (!normalized.ok) throw new Error(`${column.header} 값은 숫자 또는 빈칸이어야 합니다.`);
    const store = createInventoryOverrideStore(workspace);
    store.cells = store.cells.filter((cell) =>
      !(normalizeProductCode(cell?.productCode) === code && cell?.columnKey === column.key),
    );
    store.cells.push({ productCode: code, columnKey: column.key, value: normalized.value });
    getInventoryViewRows(workspace);
    return normalized.value;
  }

  function getAllocationInventoryView(workspace) {
    const inventoryView = getInventoryViewRows(workspace);
    const warehouseColumns = inventoryView.columns.filter(
      (column) => column.role === "warehouseQuantity",
    );
    const sourceIndexByKey = new Map(
      inventoryView.columns.map((column, index) => [column.key, index]),
    );
    const inventoryByCode = new Map(
      inventoryView.rows.map((row) => [normalizeProductCode(row.productCode), row]),
    );
    const rows = (workspace.allocations || []).map((allocation) => {
      const inventory = inventoryByCode.get(normalizeProductCode(allocation.productCode));
      return {
        sourceRow: allocation,
        warehouseValues: warehouseColumns.map((column) => {
          if (!inventory) return "";
          return inventory.values[sourceIndexByKey.get(column.key)];
        }),
      };
    });
    return { columns: warehouseColumns, rows };
  }

  function rebuildWorkspaceFromOrders(workspace) {
    const purchaseInputs = getPurchaseInputs(workspace);
    const inventoryOverrides = JSON.parse(JSON.stringify(
      workspace.inventoryOverrides || { schemaVersion: INVENTORY_OVERRIDE_SCHEMA_VERSION, cells: [] },
    ));
    const orderOpsInputs = JSON.parse(JSON.stringify(workspace.orderOpsInputs || null));
    const acknowledgedIds = [...ensureNoticeState(workspace).acknowledgedIds];
    const orderSource = workspace.sourceFiles?.orders || {};
    const inventorySource = workspace.sourceFiles?.inventory || {};
    const parsedOrders = {
      fileName: orderSource.fileName,
      sheetName: orderSource.sheetName,
      fileHash: orderSource.sha256,
      headerRowIndex: orderSource.headerRowIndex,
      rowCount: workspace.orders.length,
      rows: workspace.orders.map((row) => ({ ...row })),
      missingColumns: [],
      errors: [],
      warnings: [],
      sourceMatrix: orderSource.matrix,
      productCodeColumnIndex: orderSource.productCodeColumnIndex,
      headerMapping: orderSource.headerMapping,
    };
    const parsedInventory = {
      fileName: inventorySource.fileName,
      sheetName: inventorySource.sheetName,
      fileHash: inventorySource.sha256,
      headerRowIndex: inventorySource.headerRowIndex,
      rowCount: workspace.inventory.length,
      rows: workspace.inventory.map((row) => ({ ...row })),
      columns: inventorySource.columns || [],
      missingColumns: [],
      duplicateCodes: [],
      errors: [],
      warnings: [],
      sourceMatrix: inventorySource.matrix,
      productCodeColumnIndex: inventorySource.productCodeColumnIndex,
    };
    const rebuilt = analyze(parsedOrders, parsedInventory, {
      sourceFingerprint: workspace.sourceFingerprint,
      createdAt: workspace.createdAt,
    });
    rebuilt.inventoryOverrides = inventoryOverrides;
    if (orderOpsInputs) rebuilt.orderOpsInputs = orderOpsInputs;
    Object.keys(workspace).forEach((key) => { delete workspace[key]; });
    Object.assign(workspace, rebuilt);
    applyPurchaseInputs(workspace, purchaseInputs);
    const noticeState = ensureNoticeState(workspace);
    const validNoticeIds = new Set(workspace.notices.map((notice) => notice.noticeId));
    noticeState.acknowledgedIds = acknowledgedIds.filter((noticeId) => validNoticeIds.has(noticeId));
    getInventoryViewRows(workspace);
    return workspace;
  }

  function setOrderValue(workspace, sourceRowNumber, field, value) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    const rowNumber = Number(sourceRowNumber);
    const order = (workspace.orders || []).find((row) => Number(row?.sourceRowNumber) === rowNumber);
    if (!order) throw new Error("수정할 주문행을 찾지 못했습니다.");
    if (field === "purchase") return setPurchaseValue(workspace, order.productCode, value);
    if (field === "quantity") {
      const parsed = parseNumericCell(value);
      if (!parsed.ok || parsed.blank) throw new Error("주문수량은 빈값이 아닌 숫자여야 합니다.");
      order.quantity = parsed.value;
    } else if (field === "unitPrice") {
      const parsed = parseNumericCell(value);
      if (!parsed.ok) throw new Error("단가는 숫자 또는 빈칸이어야 합니다.");
      order.unitPrice = parsed.blank ? null : parsed.value;
    } else if (field === "warehouse") {
      order.warehouse = cleanText(value);
    } else if (field === "note") {
      order.noteOriginal = originalText(value);
      order.note = cleanText(value);
    } else {
      throw new Error("수정할 수 없는 주문 항목입니다.");
    }
    if (["quantity", "unitPrice"].includes(field)) {
      order.supplyAmount = typeof order.unitPrice === "number"
        ? roundQuantity(order.quantity * order.unitPrice)
        : null;
    }
    return rebuildWorkspaceFromOrders(workspace);
  }

  function analyze(ordersParsed, inventoryParsed, options = {}) {
    const inputValidation = validateInputs(ordersParsed, inventoryParsed);
    if (!inputValidation.canAnalyze) {
      const error = new Error(
        inputValidation.errors.map((issue) => issue.message).join("\n") ||
          "입력 검증을 통과하지 못했습니다.",
      );
      error.name = "ShippingInputValidationError";
      error.validation = inputValidation;
      throw error;
    }

    const inventoryByCode = new Map(
      inventoryParsed.rows.map((row) => [row.productCode, row]),
    );
    const poolState = new Map(
      inventoryParsed.rows.map((row) => [
        row.productCode,
        {
          wholeRemaining: row.wholeStockAvailable,
          seoulRemaining: row.seoulFirstPurchaseRemaining,
        },
      ]),
    );

    const allocations = [];
    for (const order of ordersParsed.rows) {
      const inventory = inventoryByCode.get(order.productCode);
      const matched = Boolean(inventory);
      let wholeAllocation = 0;
      let seoulAllocation = 0;
      let purchaseNeed = null;
      let wholeRemaining = null;
      let seoulRemaining = null;

      if (matched) {
        const state = poolState.get(order.productCode);
        wholeAllocation = roundQuantity(Math.min(order.quantity, state.wholeRemaining));
        state.wholeRemaining = roundQuantity(state.wholeRemaining - wholeAllocation);
        const afterWhole = roundQuantity(order.quantity - wholeAllocation);
        seoulAllocation = roundQuantity(Math.min(afterWhole, state.seoulRemaining));
        state.seoulRemaining = roundQuantity(state.seoulRemaining - seoulAllocation);
        purchaseNeed = Math.max(
          0,
          roundQuantity(order.quantity - wholeAllocation - seoulAllocation),
        );
        wholeRemaining = state.wholeRemaining;
        seoulRemaining = state.seoulRemaining;
      }

      const reconciliationDifference = matched
        ? roundQuantity(
            order.quantity - wholeAllocation - seoulAllocation - purchaseNeed,
          )
        : null;
      allocations.push({
        ...order,
        noticeId: order.note || order.note1 ? buildNoticeId(order) : "",
        inventoryMatched: matched,
        inventoryProductName: inventory?.productName || "",
        wholeStockRaw: matched ? inventory.wholeStockRaw : null,
        wholeStockAvailable: matched ? inventory.wholeStockAvailable : null,
        seoulFirstPurchaseRaw: matched ? inventory.seoulFirstPurchaseRaw : null,
        firstTransferRaw: matched ? inventory.firstTransferRaw : null,
        seoulFirstPurchaseRemaining: matched
          ? inventory.seoulFirstPurchaseRemaining
          : null,
        wholeAllocation,
        seoulAllocation,
        purchaseNeed,
        wholeRemaining,
        seoulRemaining,
        status: classifyAllocation(
          wholeAllocation,
          seoulAllocation,
          purchaseNeed,
          matched,
        ),
        reconciliationDifference,
        matchStatus: matched ? "매칭완료" : "재고정보 없음",
        purchase: "",
        supplierDisplay: uniqueSupplierPairs([order])[0]?.display || "",
      });
    }

    const summaryByCode = new Map();
    for (const allocation of allocations) {
      if (!summaryByCode.has(allocation.productCode)) {
        summaryByCode.set(allocation.productCode, {
          productCode: allocation.productCode,
          productName: allocation.productName,
          specification: allocation.specification,
          inventoryMatched: allocation.inventoryMatched,
          matchStatus: allocation.matchStatus,
          wholeStockRaw: allocation.wholeStockRaw,
          wholeStockAvailable: allocation.wholeStockAvailable,
          seoulFirstPurchaseRaw: allocation.seoulFirstPurchaseRaw,
          firstTransferRaw: allocation.firstTransferRaw,
          seoulFirstPurchaseRemaining: allocation.seoulFirstPurchaseRemaining,
          totalOrderQuantity: 0,
          wholeAllocation: 0,
          seoulAllocation: 0,
          purchaseNeed: allocation.inventoryMatched ? 0 : null,
          orderCount: 0,
          customers: [],
          supplierRows: [],
          groups: [],
          managers: [],
          notes: [],
          notes1: [],
        });
      }
      const summary = summaryByCode.get(allocation.productCode);
      summary.totalOrderQuantity = roundQuantity(
        summary.totalOrderQuantity + allocation.quantity,
      );
      summary.wholeAllocation = roundQuantity(
        summary.wholeAllocation + allocation.wholeAllocation,
      );
      summary.seoulAllocation = roundQuantity(
        summary.seoulAllocation + allocation.seoulAllocation,
      );
      if (summary.inventoryMatched) {
        summary.purchaseNeed = roundQuantity(
          summary.purchaseNeed + allocation.purchaseNeed,
        );
      }
      summary.orderCount += 1;
      summary.customers.push(allocation.customer);
      summary.supplierRows.push(allocation);
      summary.groups.push(allocation.group);
      summary.managers.push(allocation.manager);
      summary.notes.push(allocation.note);
      summary.notes1.push(allocation.note1);
    }

    const productSummaries = [...summaryByCode.values()].map((summary) => {
      const reconciliationDifference = summary.inventoryMatched
        ? roundQuantity(
            summary.totalOrderQuantity -
              summary.wholeAllocation -
              summary.seoulAllocation -
              summary.purchaseNeed,
          )
        : null;
      const noteValues = uniqueTextValues(summary.notes);
      const note1Values = uniqueTextValues(summary.notes1);
      const managerValues = uniqueTextValues(summary.managers);
      const supplierPairs = uniqueSupplierPairs(summary.supplierRows);
      const primaryManager = managerValues[0] || "";
      const { supplierRows, ...publicSummary } = summary;
      return {
        ...publicSummary,
        customers: uniqueJoined(summary.customers),
        groups: uniqueJoined(summary.groups),
        managers: managerValues.join(", "),
        manager: primaryManager,
        noteValues,
        note1Values,
        notes: noteValues.join("\n"),
        notes1: note1Values.join("\n"),
        supplierPairs,
        suppliers: supplierPairs.map((pair) => pair.display).join("\n"),
        purchase: "",
        status: classifyAllocation(
          summary.wholeAllocation,
          summary.seoulAllocation,
          summary.purchaseNeed,
          summary.inventoryMatched,
        ),
        reconciliationDifference,
      };
    });

    const purchaseManagement = [];
    productSummaries
      .filter(
        (summary) =>
          !summary.inventoryMatched ||
          (typeof summary.purchaseNeed === "number" && summary.purchaseNeed > 0) ||
          summary.noteValues.length > 0 ||
          summary.note1Values.length > 0,
      )
      .forEach((summary) => {
        purchaseManagement.push({
          ...summary,
          rowType: "main",
          referenceFor: "",
        });
        if (!(typeof summary.purchaseNeed === "number" && summary.purchaseNeed > 0)) return;
        const categoryPrefix = normalizeCategoryCode(summary.productCode).slice(0, 6);
        if (categoryPrefix.length < 6) return;
        inventoryParsed.rows
          .filter(
            (inventory) =>
              inventory.productCode !== summary.productCode &&
              normalizeCategoryCode(inventory.productCode).slice(0, 6) === categoryPrefix,
          )
          .forEach((inventory) => {
            purchaseManagement.push({
              rowType: "reference",
              referenceFor: summary.productCode,
              productCode: inventory.productCode,
              productName: inventory.productName,
              specification: inventory.specification,
              inventoryMatched: true,
              matchStatus: "매칭완료",
              wholeStockRaw: inventory.wholeStockRaw,
              wholeStockAvailable: inventory.wholeStockAvailable,
              seoulFirstPurchaseRaw: inventory.seoulFirstPurchaseRaw,
              firstTransferRaw: inventory.firstTransferRaw,
              seoulFirstPurchaseRemaining: inventory.seoulFirstPurchaseRemaining,
              totalOrderQuantity: null,
              wholeAllocation: null,
              seoulAllocation: null,
              purchaseNeed: null,
              orderCount: null,
              customers: "",
              suppliers: "",
              supplierPairs: [],
              groups: "",
              managers: "",
              manager: "",
              noteValues: [],
              note1Values: [],
              notes: "",
              notes1: "",
              purchase: "",
              status: "카테고리 대체 참고",
              reconciliationDifference: null,
            });
          });
      });

    const purchaseMainCodes = new Set(
      purchaseManagement
        .filter((row) => row.rowType === "main")
        .map((row) => row.productCode),
    );
    inventoryParsed.rows.forEach((inventory) => {
      if (purchaseMainCodes.has(inventory.productCode)) return;
      purchaseManagement.push(createInventoryShadowRow(inventory));
      purchaseMainCodes.add(inventory.productCode);
    });

    const totalOrderQuantity = roundQuantity(
      allocations.reduce((sum, row) => sum + row.quantity, 0),
    );
    const totalMatchedOrderQuantity = roundQuantity(
      allocations.reduce(
        (sum, row) => sum + (row.inventoryMatched ? row.quantity : 0),
        0,
      ),
    );
    const totalAllocatedAndPurchase = roundQuantity(
      allocations.reduce(
        (sum, row) =>
          sum +
          row.wholeAllocation +
          row.seoulAllocation +
          (typeof row.purchaseNeed === "number" ? row.purchaseNeed : 0),
        0,
      ),
    );
    const totalPurchaseNeed = roundQuantity(
      allocations.reduce(
        (sum, row) =>
          sum + (typeof row.purchaseNeed === "number" ? row.purchaseNeed : 0),
        0,
      ),
    );
    const productQuantityDifference = roundQuantity(
      totalOrderQuantity -
        productSummaries.reduce((sum, row) => sum + row.totalOrderQuantity, 0),
    );
    const allocationDifference = roundQuantity(
      totalMatchedOrderQuantity - totalAllocatedAndPurchase,
    );
    const negativePurchaseCount = allocations.filter(
      (row) => typeof row.purchaseNeed === "number" && row.purchaseNeed < 0,
    ).length;
    const zeroOrderQuantityCount = allocations.filter((row) => row.quantity === 0).length;
    const negativeOrderQuantityCount = allocations.filter((row) => row.quantity < 0).length;
    const reconciliationErrorCount = allocations.filter(
      (row) =>
        row.inventoryMatched &&
        Math.abs(row.reconciliationDifference || 0) > 1e-9,
    ).length;
    const statusCounts = allocations.reduce((result, row) => {
      result[row.status] = (result[row.status] || 0) + 1;
      return result;
    }, {});
    const basisDates = uniqueTextValues(ordersParsed.rows.flatMap((row) =>
      Array.isArray(row.basisDateCandidates)
        ? row.basisDateCandidates.map((candidate) => candidate.basisDate)
        : [row.basisDate],
    ));
    const invalidDateRows = ordersParsed.rows
      .filter((row) => row.basisDateStatus === "invalid")
      .map((row) => row.sourceRowNumber);
    const conflictingDateRows = ordersParsed.rows
      .filter((row) => row.basisDateStatus === "conflict")
      .map((row) => row.sourceRowNumber);
    const missingDateRows = ordersParsed.rows
      .filter((row) => row.basisDateStatus === "missing")
      .map((row) => row.sourceRowNumber);
    const basisDate = basisDates.length === 1 && invalidDateRows.length === 0 && conflictingDateRows.length === 0
      ? basisDates[0]
      : "";
    const basisDateStatus = invalidDateRows.length > 0
      ? "invalid"
      : conflictingDateRows.length > 0 || basisDates.length > 1
      ? "conflict"
      : basisDates.length === 0
        ? "missing"
        : "valid";
    const uploadDate = basisDate ? basisDate.replace(/-/g, "") : "";
    const sourceFingerprint = cleanText(options.sourceFingerprint);
    const planId = buildPlanId(basisDate, sourceFingerprint);

    const notices = collectNotices(ordersParsed.rows);
    const validationResults = [
      {
        item: "주문 필수 열",
        result: ordersParsed.missingColumns.length,
        expected: 0,
        status: ordersParsed.missingColumns.length === 0 ? "정상" : "오류",
        description: "누락 필수 열 수",
      },
      {
        item: "재고 필수 열",
        result: inventoryParsed.missingColumns.length,
        expected: 0,
        status: inventoryParsed.missingColumns.length === 0 ? "정상" : "오류",
        description: "누락 필수 열 수",
      },
      {
        item: "재고 중복 상품코드",
        result: inputValidation.duplicateCount,
        expected: 0,
        status: inputValidation.duplicateCount === 0 ? "정상" : "오류",
        description: "중복은 분석 전 차단",
      },
      {
        item: "상품별 주문수량 대사 차이",
        result: productQuantityDifference,
        expected: 0,
        status: Math.abs(productQuantityDifference) <= 1e-9 ? "정상" : "오류",
        description: "주문행 합계 - 상품별요약 합계",
      },
      {
        item: "매칭 주문 배정 대사 차이",
        result: allocationDifference,
        expected: 0,
        status: Math.abs(allocationDifference) <= 1e-9 ? "정상" : "오류",
        description: "매칭 주문수량 - 전재고·서울·추가구매 배정 합계",
      },
      {
        item: "주문행 배정 오류",
        result: reconciliationErrorCount,
        expected: 0,
        status: reconciliationErrorCount === 0 ? "정상" : "오류",
        description: "주문행별 배정 불일치 건수",
      },
      {
        item: "음수 추가 구매 필요",
        result: negativePurchaseCount,
        expected: 0,
        status: negativePurchaseCount === 0 ? "정상" : "오류",
        description: "추가 구매 필요는 0 이상",
      },
      {
        item: "재고정보 없음",
        result: inputValidation.unmatchedCount,
        expected: 0,
        status: inputValidation.unmatchedCount === 0 ? "정상" : "확인 필요",
        description: "구매수량을 자동 확정하지 않는 상품 수",
      },
      {
        item: "구매업로드 기준일",
        result: basisDateStatus === "valid" ? basisDate : basisDates.join(", ") || "없음",
        expected: "단일 YYYY-MM-DD",
        status: basisDateStatus === "valid" ? "정상" : "오류",
        description: basisDateStatus === "conflict"
          ? `날짜 후보 열에서 서로 다른 기준일이 확인되었습니다${conflictingDateRows.length ? ` (원본행 ${conflictingDateRows.join(", ")})` : ""}.`
          : basisDateStatus === "invalid"
            ? `날짜 후보 값을 해석할 수 없는 원본행: ${invalidDateRows.join(", ")}`
            : basisDateStatus === "missing"
              ? "일자-No.·일자·주문일자에서 기준일을 찾지 못했습니다."
              : "날짜 후보 열 전체가 일치하는 단일 기준일",
      },
    ];

    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      createdAt: options.createdAt || new Date().toISOString(),
      sourceFingerprint,
      planId,
      basisDate,
      uploadDate,
      basisDateStatus,
      basisDates,
      invalidDateRows,
      conflictingDateRows,
      missingDateRows,
      sourceFiles: {
        orders: {
          fileName: ordersParsed.fileName,
          sheetName: ordersParsed.sheetName,
          headerRowIndex: ordersParsed.headerRowIndex,
          rowCount: ordersParsed.rowCount,
          sha256: ordersParsed.fileHash,
          matrix: ordersParsed.sourceMatrix,
          productCodeColumnIndex: ordersParsed.productCodeColumnIndex,
          headerMapping: ordersParsed.headerMapping,
        },
        inventory: {
          fileName: inventoryParsed.fileName,
          sheetName: inventoryParsed.sheetName,
          headerRowIndex: inventoryParsed.headerRowIndex,
          rowCount: inventoryParsed.rowCount,
          sha256: inventoryParsed.fileHash,
          matrix: inventoryParsed.sourceMatrix,
          productCodeColumnIndex: inventoryParsed.productCodeColumnIndex,
          columns: inventoryParsed.columns,
        },
      },
      inventoryOverrides: {
        schemaVersion: INVENTORY_OVERRIDE_SCHEMA_VERSION,
        cells: [],
      },
      inputValidation,
      orders: ordersParsed.rows,
      inventory: inventoryParsed.rows,
      allocations,
      productSummaries,
      purchaseManagement,
      notices,
      noticeAcknowledgements: {
        schemaVersion: "shipping-notice-acknowledgements/v1",
        acknowledgedIds: [],
      },
      memoIssues: notices,
      validationResults,
      stats: {
        orderRowCount: allocations.length,
        productCount: productSummaries.length,
        inventoryRowCount: inventoryParsed.rows.length,
        totalOrderQuantity,
        totalPurchaseNeed,
        unmatchedCount: inputValidation.unmatchedCount,
        duplicateCount: inputValidation.duplicateCount,
        noticeCount: notices.length,
        memoCount: notices.length,
        allocationDifference,
        productQuantityDifference,
        negativePurchaseCount,
        zeroOrderQuantityCount,
        negativeOrderQuantityCount,
        reconciliationErrorCount,
        statusCounts,
        inventoryNegativeCount: inventoryParsed.rows.filter(
          (row) => typeof row.inventoryTotal === "number" && row.inventoryTotal < 0,
        ).length,
        purchaseManagementMainCount: purchaseManagement.filter(
          (row) => row.rowType === "main" && row.inventoryShadow !== true,
        ).length,
        purchaseReferenceCount: purchaseManagement.filter((row) => row.rowType === "reference").length,
      },
    };
  }

  function setPurchaseValue(workspace, productCode, value) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    ensureInventoryPurchaseRows(workspace);
    const code = normalizeProductCode(productCode);
    const purchase = value === undefined || value === null ? "" : String(value);
    [workspace.allocations, workspace.productSummaries].forEach((rows) => {
      (rows || []).forEach((row) => {
        if (row.productCode === code) row.purchase = purchase;
      });
    });
    (workspace.purchaseManagement || []).forEach((row) => {
      if (row.rowType === "main" && row.productCode === code) row.purchase = purchase;
    });
    return purchase;
  }

  function applyPurchaseInputs(workspace, inputs) {
    ensureInventoryPurchaseRows(workspace);
    Object.entries(inputs && typeof inputs === "object" ? inputs : {}).forEach(([code, value]) => {
      setPurchaseValue(workspace, code, value);
    });
    return workspace;
  }

  function getPurchaseInputs(workspace) {
    ensureInventoryPurchaseRows(workspace);
    const result = {};
    (workspace?.purchaseManagement || []).forEach((row) => {
      if (row.rowType === "main") result[row.productCode] = String(row.purchase || "");
    });
    return result;
  }

  function getPurchaseUploadSelection(workspace) {
    if (!workspace || workspace.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    ensureInventoryPurchaseRows(workspace);
    const purchaseNeedByCode = new Map(
      getInventoryViewRows(workspace).rows.map((inventory) => [
        normalizeProductCode(inventory.productCode),
        inventory.remainingQuantity < 0 ? roundQuantity(Math.abs(inventory.remainingQuantity)) : 0,
      ]),
    );
    const included = [];
    const excluded = [];
    (workspace.purchaseManagement || []).forEach((row) => {
      if (row.rowType === "reference") {
        excluded.push({ productCode: row.productCode, reason: "카테고리 대체 참고행" });
        return;
      }
      const productCode = normalizeProductCode(row.productCode);
      if (!purchaseNeedByCode.has(productCode)) {
        excluded.push({ productCode: row.productCode, reason: "재고정보 없음·구매수량 근거 없음" });
        return;
      }
      const purchaseNeed = purchaseNeedByCode.get(productCode);
      if (!(purchaseNeed > 0)) {
        excluded.push({ productCode: row.productCode, reason: "창고별재고 부족 수량 없음" });
        return;
      }
      if (isPurchaseUploadExcluded(row.purchase)) {
        excluded.push({ productCode: row.productCode, reason: `구매값 ${row.purchase}` });
        return;
      }
      included.push({ ...row, purchaseNeed });
    });
    return { included, excluded };
  }

  return Object.freeze({
    ENGINE_VERSION,
    WORKSPACE_SCHEMA_VERSION,
    INVENTORY_OVERRIDE_SCHEMA_VERSION,
    ORDER_REQUIRED_COLUMNS,
    INVENTORY_REQUIRED_COLUMNS,
    ORDER_DATE_COLUMNS,
    ORDER_OPTIONAL_COLUMNS,
    ORDER_CANONICAL_ALIASES,
    INVENTORY_OPTIONAL_COLUMNS,
    normalizeProductCode,
    normalizeOrderHeader,
    normalizeCategoryCode,
    canonicalStringify,
    containsCloudTokenKey,
    sanitizeCloudTokenKeys,
    buildLocalRecoveryPayload,
    commitVerifiedRecoveryRecord,
    selectLatestVerifiedRecovery,
    parseOrderBasisDate,
    buildPlanId,
    isPurchaseUploadExcluded,
    parseNumericCell,
    findHeaderRow,
    parseOrderWorkbook,
    parseInventoryWorkbook,
    validateInputs,
    collectNotices,
    ensureNoticeState,
    isNoticeAcknowledged,
    setNoticeAcknowledged,
    analyze,
    setPurchaseValue,
    applyPurchaseInputs,
    getPurchaseInputs,
    getPurchaseUploadSelection,
    ensureInventoryPurchaseRows,
    getInventoryColumnDescriptors,
    getInventoryViewRows,
    getShortageCategoryContext,
    getStockLedgerView,
    setOrderValue,
    setInventoryOverride,
    getAllocationInventoryView,
  });
});
