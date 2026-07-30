(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ShippingManagementEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ENGINE_VERSION = "1.0.0";
  const WORKSPACE_SCHEMA_VERSION = "shipping-workspace/v1";
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

  const INVENTORY_REQUIRED_COLUMNS = Object.freeze([
    "품목코드",
    "품목명",
    "규격",
    "1창고",
    "3서울",
    "4전송",
  ]);

  const ORDER_OPTIONAL_COLUMNS = Object.freeze([
    "일자-No.",
    "담당",
    "단위",
    "재고",
    "단가",
  ]);

  const INVENTORY_OPTIONAL_COLUMNS = Object.freeze([
    "사용",
    "단위",
    "수량",
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

  function normalizeHeader(value) {
    return cleanText(value).replace(/\s+/g, "");
  }

  function normalizeProductCode(value) {
    if (isBlank(value)) return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
    }
    return String(value).trim();
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
    const headerRowIndex = findBestHeaderRow(displayMatrix, ORDER_REQUIRED_COLUMNS);
    const headerRow = headerRowIndex >= 0 ? displayMatrix[headerRowIndex] || [] : [];
    const columnMap = createColumnMap(headerRow);
    const missingColumns = ORDER_REQUIRED_COLUMNS.filter(
      (column) => columnMap[normalizeHeader(column)] === undefined,
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

    const rows = [];
    if (headerRowIndex >= 0) {
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
        if (!quantity.ok || quantity.value < 0) {
          errors.push(
            createIssue(
              "ORDER_QUANTITY_INVALID",
              `${rowIndex + 1}행 주문수량은 0 이상의 숫자여야 합니다.`,
              { rowNumber: rowIndex + 1, productCode: code, value: quantityCell },
            ),
          );
          continue;
        }

        const price = parseNumericCell(getField(row, columnMap, "단가"));
        rows.push({
          inputOrder: rows.length + 1,
          sourceRowNumber: rowIndex + 1,
          orderNumber: cleanText(getField(row, columnMap, "일자-No.")),
          manager: cleanText(getField(row, columnMap, "담당")),
          sourceUnit: cleanText(getField(row, columnMap, "단위")),
          productCode: code,
          productName: cleanText(getField(row, columnMap, "품목명")),
          specification: cleanText(getField(row, columnMap, "규격")),
          quantity: quantity.value,
          sourceStock: getField(row, columnMap, "재고"),
          unitPrice: price.ok && !price.blank ? price.value : null,
          note: cleanText(getField(row, columnMap, "적요")),
          note1: cleanText(getField(row, columnMap, "적요1")),
          customer: cleanText(getField(row, columnMap, "거래처")),
          group: cleanText(getField(row, columnMap, "그룹")),
        });
      }
    }

    if (missingColumns.length === 0 && rows.length === 0) {
      errors.push(createIssue("ORDER_NO_DATA", "분석할 주문 데이터행이 없습니다."));
    }

    const productCodeColumnIndex =
      columnMap[normalizeHeader("품목코드")] === undefined
        ? -1
        : columnMap[normalizeHeader("품목코드")];
    const memoCount = rows.filter((row) => row.note || row.note1).length;

    return {
      kind: "orders",
      fileName: cleanText(input.fileName) || "주문현황.xlsx",
      sheetName: cleanText(input.sheetName),
      headerRowIndex,
      headerRowNumber: headerRowIndex >= 0 ? headerRowIndex + 1 : null,
      headers: headerRow.map(cleanText),
      requiredColumns: [...ORDER_REQUIRED_COLUMNS],
      optionalColumns: [...ORDER_OPTIONAL_COLUMNS],
      missingColumns,
      rows,
      rowCount: rows.length,
      memoCount,
      errors,
      warnings,
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
    const headerRowIndex = findBestHeaderRow(displayMatrix, INVENTORY_REQUIRED_COLUMNS);
    const headerRow = headerRowIndex >= 0 ? displayMatrix[headerRowIndex] || [] : [];
    const columnMap = createColumnMap(headerRow);
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

    const rows = [];
    const occurrences = new Map();
    if (headerRowIndex >= 0) {
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
        const invalidFields = [
          ["1창고", wholeStock, wholeStockCell],
          ["3서울", seoulPurchase, seoulPurchaseCell],
          ["4전송", transfer, transferCell],
        ].filter(([, parsed]) => !parsed.ok);
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
    };
  }

  function collectMemoIssues(orderRows) {
    return orderRows
      .filter((row) => row.note || row.note1)
      .map((row) => ({
        inputOrder: row.inputOrder,
        sourceRowNumber: row.sourceRowNumber,
        productCode: row.productCode,
        productName: row.productName,
        note: row.note,
        note1: row.note1,
        customer: row.customer,
        group: row.group,
      }));
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
    const memoIssues = collectMemoIssues(ordersParsed?.rows || []);
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
      memoIssues,
      memoCount: memoIssues.length,
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
          groups: [],
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
      summary.groups.push(allocation.group);
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
      return {
        ...summary,
        customers: uniqueJoined(summary.customers),
        groups: uniqueJoined(summary.groups),
        notes: uniqueJoined(summary.notes),
        notes1: uniqueJoined(summary.notes1),
        status: classifyAllocation(
          summary.wholeAllocation,
          summary.seoulAllocation,
          summary.purchaseNeed,
          summary.inventoryMatched,
        ),
        reconciliationDifference,
      };
    });

    const purchaseManagement = productSummaries
      .filter(
        (summary) =>
          !summary.inventoryMatched ||
          (typeof summary.purchaseNeed === "number" && summary.purchaseNeed > 0),
      )
      .map((summary) => ({
        ...summary,
        managementStatus: summary.inventoryMatched ? "발주 필요" : "재고 확인 필요",
        confirmedPurchaseQuantity: null,
      }));

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
    const reconciliationErrorCount = allocations.filter(
      (row) =>
        row.inventoryMatched &&
        Math.abs(row.reconciliationDifference || 0) > 1e-9,
    ).length;
    const statusCounts = allocations.reduce((result, row) => {
      result[row.status] = (result[row.status] || 0) + 1;
      return result;
    }, {});

    const memoIssues = collectMemoIssues(ordersParsed.rows);
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
        item: "적요 확인",
        result: memoIssues.length,
        expected: 0,
        status: memoIssues.length === 0 ? "정상" : "확인 필요",
        description: "적요·적요1이 있는 주문행 수",
      },
    ];

    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      createdAt: options.createdAt || new Date().toISOString(),
      sourceFiles: {
        orders: {
          fileName: ordersParsed.fileName,
          sheetName: ordersParsed.sheetName,
          headerRowIndex: ordersParsed.headerRowIndex,
          rowCount: ordersParsed.rowCount,
          matrix: ordersParsed.sourceMatrix,
          productCodeColumnIndex: ordersParsed.productCodeColumnIndex,
        },
        inventory: {
          fileName: inventoryParsed.fileName,
          sheetName: inventoryParsed.sheetName,
          headerRowIndex: inventoryParsed.headerRowIndex,
          rowCount: inventoryParsed.rowCount,
          matrix: inventoryParsed.sourceMatrix,
          productCodeColumnIndex: inventoryParsed.productCodeColumnIndex,
        },
      },
      inputValidation,
      orders: ordersParsed.rows,
      inventory: inventoryParsed.rows,
      allocations,
      productSummaries,
      purchaseManagement,
      memoIssues,
      validationResults,
      stats: {
        orderRowCount: allocations.length,
        productCount: productSummaries.length,
        inventoryRowCount: inventoryParsed.rows.length,
        totalOrderQuantity,
        totalPurchaseNeed,
        unmatchedCount: inputValidation.unmatchedCount,
        duplicateCount: inputValidation.duplicateCount,
        memoCount: memoIssues.length,
        allocationDifference,
        productQuantityDifference,
        negativePurchaseCount,
        reconciliationErrorCount,
        statusCounts,
      },
    };
  }

  return Object.freeze({
    ENGINE_VERSION,
    WORKSPACE_SCHEMA_VERSION,
    ORDER_REQUIRED_COLUMNS,
    INVENTORY_REQUIRED_COLUMNS,
    ORDER_OPTIONAL_COLUMNS,
    INVENTORY_OPTIONAL_COLUMNS,
    normalizeProductCode,
    parseNumericCell,
    findHeaderRow,
    parseOrderWorkbook,
    parseInventoryWorkbook,
    validateInputs,
    analyze,
  });
});
