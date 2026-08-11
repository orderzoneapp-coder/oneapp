(function (root, factory) {
  const engine = typeof module === "object" && module.exports
    ? require("./orderFulfillmentEngine.js")
    : root.ShippingManagementEngine;
  const api = factory(engine);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ShippingManagementWorkbook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (engine) {
  "use strict";

  const WORKBOOK_VERSION = "4.0.0";
  const REQUIRED_SHEETS = Object.freeze([
    "전달사항(적요보기)",
    "창고별재고",
    "미출고현황",
    "구매업로드",
  ]);
  const PURCHASE_UPLOAD_SCHEMA_VERSION = "shipping-purchase-upload/v1";
  const PURCHASE_UPLOAD_HEADERS = Object.freeze([
    "일자", "순번", "거래처코드", "거래처명", "입고창고", "거래유형", "전잔액", "전달사항",
    "코드", "품명", "규격(기본)", "수량", "단가", "외화금액", "공급가", "간단설명(품위)",
    "지시사항", "출고가 (공지)", "판매", "no.",
  ]);
  const PURCHASE_UPLOAD_REQUIRED_HEADER_INDEXES = Object.freeze([0, 4, 5, 8, 9, 11]);

  const COLORS = Object.freeze({
    navy: "153B55",
    navySoft: "DCEAF3",
    slate: "4A5B73",
    teal: "0F766E",
    tealSoft: "D8F3EE",
    orange: "B45309",
    orangeSoft: "FEF3C7",
    blueSoft: "DBEAFE",
    purpleSoft: "F3E8FF",
    greenSoft: "DCFCE7",
    red: "B91C1C",
    redSoft: "FEE2E2",
    graySoft: "F1F5F9",
    line: "CBD5E1",
    white: "FFFFFF",
    text: "1E293B",
  });

  const BASE_FONT = Object.freeze({
    name: "Pretendard",
    sz: 10,
    color: { rgb: COLORS.text },
  });

  function requireXlsx(XLSX) {
    if (!XLSX?.utils?.book_new || !XLSX?.utils?.aoa_to_sheet) {
      throw new Error("XLSX 출력 라이브러리를 불러오지 못했습니다.");
    }
  }

  function safeValue(value) {
    return value === undefined || value === null ? "" : value;
  }

  function localDateStamp(value) {
    const text = String(value || "");
    const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function columnName(index) {
    let value = index + 1;
    let result = "";
    while (value > 0) {
      const remainder = (value - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      value = Math.floor((value - 1) / 26);
    }
    return result;
  }

  function applyCellStyle(cell, style) {
    if (!cell) return;
    cell.s = style;
  }

  function tableBorder() {
    const border = { style: "thin", color: { rgb: COLORS.line } };
    return { top: border, bottom: border, left: border, right: border };
  }

  function ensureCell(sheet, XLSX, rowIndex, columnIndex) {
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
    if (!sheet[address]) sheet[address] = { t: "s", v: "" };
    return sheet[address];
  }

  function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === "";
  }

  function managerFill(manager) {
    const palette = ["FFF7ED", "EFF6FF", "F0FDF4", "FAF5FF", "FFFBEB", "FDF2F8", "F0FDFA"];
    const text = String(manager || "");
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return palette[hash % palette.length];
  }

  function exactUnitWarning(specification) {
    const value = String(specification ?? "").trim();
    return value === "EA" || value === "소분";
  }

  function dominantManager(rows) {
    const productCodesByManager = new Map();
    (rows || []).forEach((row) => {
      const manager = String(row?.manager || "").trim();
      const productCode = String(row?.productCode || "").trim();
      if (!manager || !productCode) return;
      if (!productCodesByManager.has(manager)) productCodesByManager.set(manager, new Set());
      productCodesByManager.get(manager).add(productCode);
    });
    return [...productCodesByManager.entries()]
      .sort((left, right) => right[1].size - left[1].size || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))[0]?.[0] || "";
  }

  function numberFormatForValue(value, maxDecimals = 9) {
    if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value)) return "#,##0";
    const decimalText = Math.abs(value).toFixed(maxDecimals).replace(/0+$/, "").split(".")[1] || "";
    return decimalText ? `#,##0.${"0".repeat(decimalText.length)}` : "#,##0";
  }

  function buildTableSheet(XLSX, config) {
    const {
      title,
      subtitle,
      headers,
      rows,
      widths,
      headerFill = COLORS.teal,
      numericColumns = [],
      textColumns = [],
      priceColumns = [],
      statusColumn = -1,
      inventoryColumns = [],
      rowStyleResolver,
      formulaWriter,
    } = config;
    const columnCount = Math.max(1, headers.length);
    const aoa = [
      [title, ...Array(columnCount - 1).fill("")],
      [subtitle, ...Array(columnCount - 1).fill("")],
      Array(columnCount).fill(""),
      headers,
      ...rows.map((row) => headers.map((_, index) => safeValue(row[index]))),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const endColumn = columnName(columnCount - 1);
    const endRow = Math.max(4, aoa.length);
    sheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: columnCount - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: columnCount - 1 } },
    ];
    sheet["!cols"] = widths.map((wch) => ({ wch }));
    sheet["!rows"] = [{ hpt: 27 }, { hpt: 23 }, { hpt: 8 }, { hpt: 27 }];
    sheet["!autofilter"] = { ref: `A4:${endColumn}${endRow}` };
    sheet["!freeze"] = { xSplit: 0, ySplit: 4 };
    sheet["!views"] = [{ showGridLines: false }];

    if (typeof formulaWriter === "function") formulaWriter(sheet, 4, rows);

    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      applyCellStyle(sheet[XLSX.utils.encode_cell({ r: 0, c: column })], {
        fill: { fgColor: { rgb: COLORS.navy } },
        font: {
          name: "Pretendard",
          sz: 16,
          bold: true,
          color: { rgb: COLORS.white },
        },
        alignment: { vertical: "center", horizontal: "left" },
      });
      applyCellStyle(sheet[XLSX.utils.encode_cell({ r: 1, c: column })], {
        fill: { fgColor: { rgb: COLORS.navySoft } },
        font: {
          name: "Pretendard",
          sz: 10,
          italic: true,
          color: { rgb: COLORS.navy },
        },
        alignment: { vertical: "center", horizontal: "left", wrapText: true },
      });
      applyCellStyle(sheet[XLSX.utils.encode_cell({ r: 3, c: column })], {
        fill: { fgColor: { rgb: headerFill } },
        font: {
          name: "Pretendard",
          sz: 10,
          bold: true,
          color: { rgb: COLORS.white },
        },
        alignment: { vertical: "center", horizontal: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: headerFill } } },
      });
    }

    for (let row = 4; row <= range.e.r; row += 1) {
      const alternateFill = row % 2 === 0 ? COLORS.white : "F8FAFC";
      const sourceRow = rows[row - 4];
      const rowStyle = typeof rowStyleResolver === "function"
        ? rowStyleResolver(sourceRow, row - 4) || {}
        : {};
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (!cell) continue;
        const style = {
          fill: { fgColor: { rgb: rowStyle.fill || alternateFill } },
          font: {
            ...BASE_FONT,
            ...(rowStyle.fontColor ? { color: { rgb: rowStyle.fontColor } } : {}),
          },
          alignment: {
            vertical: "center",
            horizontal: numericColumns.includes(column) || priceColumns.includes(column)
              ? "right"
              : "left",
            wrapText: false,
          },
          border: { bottom: { style: "hair", color: { rgb: COLORS.line } } },
        };
        if (numericColumns.includes(column) || priceColumns.includes(column)) {
          style.numFmt = numberFormatForValue(cell.v);
        }
        if (
          !rowStyle.suppressInventory &&
          inventoryColumns.includes(column) &&
          typeof cell.v === "number" &&
          Number.isFinite(cell.v) &&
          cell.v !== 0
        ) {
          style.fill = { fgColor: { rgb: COLORS.greenSoft } };
        }
        if (textColumns.includes(column)) {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
          cell.w = cell.v;
          style.numFmt = "@";
        }
        if (column === statusColumn) {
          const status = String(cell.v || "");
          if (status.includes("재고정보") || status === "추가 구매 필요") {
            style.font = { ...BASE_FONT, color: { rgb: COLORS.red }, bold: true };
          } else if (
            status.includes("부분출고") ||
            status.includes("확인") ||
            status.includes("발주 필요")
          ) {
            style.font = { ...BASE_FONT, color: { rgb: COLORS.orange }, bold: true };
          } else if (status.includes("서울")) {
            style.font = { ...BASE_FONT, color: { rgb: "1D4ED8" }, bold: true };
          } else if (status) {
            style.font = { ...BASE_FONT, color: { rgb: "15803D" }, bold: true };
          }
          if (status.includes("오류")) style.fill = { fgColor: { rgb: COLORS.redSoft } };
        }
        if (typeof cell.v === "number" && (!Number.isFinite(cell.v) || cell.v < 0)) {
          style.fill = { fgColor: { rgb: COLORS.redSoft } };
          style.font = { ...BASE_FONT, color: { rgb: COLORS.red }, bold: true };
        }
        applyCellStyle(cell, style);
      }
    }

    return sheet;
  }

  function buildDeliveryNoticeSheet(workspace, XLSX) {
    const acknowledgementState = engine?.ensureNoticeState?.(workspace) || { acknowledgedIds: [] };
    const acknowledgedIds = new Set(acknowledgementState.acknowledgedIds || []);
    const orderByNoticeId = new Map(
      (workspace.orders || [])
        .filter((row) => row.noticeId || row.note || row.note1)
        .map((row) => [row.noticeId || `${row.sourceRowNumber}`, row]),
    );
    const headers = [
      "담당", "거래처", "품목코드", "품목명", "규격", "주문수량", "적요", "적요1", "그룹", "확인상태",
    ];
    const noticeRows = (workspace.notices || []).map((notice) => {
      const order = orderByNoticeId.get(notice.noticeId) ||
        (workspace.orders || []).find((row) => row.sourceRowNumber === notice.sourceRowNumber) || {};
      return [
        notice.manager || order.manager || "",
        notice.customer || order.customer || "",
        notice.productCode || order.productCode || "",
        notice.productName || order.productName || "",
        order.specification || "",
        typeof order.quantity === "number" ? order.quantity : "",
        notice.note ?? order.noteOriginal ?? order.note ?? "",
        notice.note1 ?? order.note1Original ?? order.note1 ?? "",
        notice.group || order.group || "",
        acknowledgedIds.has(notice.noticeId) ? "확인함" : "미확인",
      ];
    });
    const sheet = buildTableSheet(XLSX, {
      title: "전달사항(적요보기)",
      subtitle: "원 주문행 순서와 적요·적요1 원문을 유지합니다. 확인상태는 선택적 운영 기록입니다.",
      headers,
      rows: noticeRows,
      widths: [13, 22, 15, 31, 13, 12, 28, 28, 14, 11],
      numericColumns: [5],
      textColumns: [2],
    });
    sheet["!rows"] = [
      { hpt: 27 }, { hpt: 28 }, { hpt: 8 }, { hpt: 27 },
      ...noticeRows.map((row) => ({
        hpt: Math.min(120, Math.max(22, Math.max(
          String(row[6] || "").split(/\r?\n/).length,
          String(row[7] || "").split(/\r?\n/).length,
        ) * 18)),
      })),
    ];
    noticeRows.forEach((_, rowIndex) => {
      [6, 7].forEach((column) => {
        const cell = ensureCell(sheet, XLSX, rowIndex + 4, column);
        cell.s = {
          ...(cell.s || {}),
          alignment: { vertical: "top", horizontal: "left", wrapText: true },
        };
      });
    });
    return sheet;
  }

  function buildAllocationSheet(workspace, XLSX) {
    if (!engine?.getAllocationInventoryView) {
      throw new Error("Shipping Management 재고 엔진을 불러오지 못했습니다.");
    }
    const inventoryView = engine.getAllocationInventoryView(workspace);
    const warehouseHeaders = inventoryView.columns.map((column) => column.header);
    const headers = [
      "상품코드",
      "품목명",
      "규격",
      ...warehouseHeaders,
      "주문수량",
      "전재고",
      "서울잔량",
      "구매수량",
      "구매",
      "거래처",
      "단가",
      "공급가액",
      "적요",
      "적요1",
      "담당자",
    ];
    const rows = workspace.allocations.map((row, index) => [
      row.productCode,
      row.productName,
      row.specification,
      ...inventoryView.rows[index].warehouseValues,
      row.quantity,
      row.inventoryMatched ? row.wholeStockRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRemaining : "",
      row.inventoryMatched ? row.purchaseNeed : "",
      row.purchase,
      row.customer,
      row.unitPrice === null || row.unitPrice === undefined ? "" : row.unitPrice,
      row.supplyAmount === null || row.supplyAmount === undefined ? "" : row.supplyAmount,
      row.note,
      row.note1,
      row.manager,
    ]);
    const warehouseStart = 3;
    const orderQuantityColumn = warehouseStart + warehouseHeaders.length;
    const purchaseColumn = orderQuantityColumn + 4;
    const priceColumn = purchaseColumn + 2;
    const supplyAmountColumn = priceColumn + 1;
    const numericColumns = new Set([
      ...warehouseHeaders.map((_, index) => warehouseStart + index),
      orderQuantityColumn,
      orderQuantityColumn + 1,
      orderQuantityColumn + 2,
      orderQuantityColumn + 3,
      priceColumn,
      supplyAmountColumn,
    ]);
    const whiteManager = dominantManager(workspace.allocations);
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const lastRow = Math.max(1, rows.length + 1);
    const lastColumn = columnName(headers.length - 1);
    sheet["!cols"] = headers.map((header, index) => {
      if (index === 0) return { wch: 15 };
      if (index === 1) return { wch: 31 };
      if (index === 2) return { wch: 13 };
      if (index >= warehouseStart && index < orderQuantityColumn) return { wch: 11 };
      if (header === "거래처") return { wch: 22 };
      if (header === "적요" || header === "적요1") return { wch: 24 };
      if (header === "담당자") return { wch: 14 };
      return { wch: 12 };
    });
    sheet["!rows"] = [{ hpt: 27 }];
    sheet["!autofilter"] = { ref: `A1:${lastColumn}${lastRow}` };
    sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    sheet["!views"] = [{ showGridLines: false }];
    sheet["!margins"] = {
      left: 0.25,
      right: 0.25,
      top: 0.75,
      bottom: 0.75,
      header: 0.3,
      footer: 0.3,
    };
    sheet["!pageSetup"] = {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
    sheet["!printArea"] = `A1:${lastColumn}${lastRow}`;
    sheet["!printTitles"] = "$1:$1";

    for (let column = 0; column < headers.length; column += 1) {
      applyCellStyle(ensureCell(sheet, XLSX, 0, column), {
        fill: { fgColor: { rgb: COLORS.teal } },
        font: { name: "Pretendard", sz: 10, bold: true, color: { rgb: COLORS.white } },
        alignment: { vertical: "center", horizontal: "center", wrapText: true },
        border: tableBorder(),
      });
    }

    rows.forEach((row, rowIndex) => {
      const sheetRow = rowIndex + 1;
      const sourceRow = workspace.allocations[rowIndex];
      const rowManager = String(sourceRow.manager || "").trim();
      const rowFill = !rowManager || rowManager === whiteManager
        ? COLORS.white
        : managerFill(rowManager);
      const warningUnit = exactUnitWarning(sourceRow.specification);
      row.forEach((value, column) => {
        const cell = ensureCell(sheet, XLSX, sheetRow, column);
        const style = {
          fill: { fgColor: { rgb: rowFill } },
          font: {
            ...BASE_FONT,
            ...(warningUnit ? { color: { rgb: COLORS.red } } : {}),
          },
          alignment: {
            vertical: "center",
            horizontal: numericColumns.has(column) ? "right" : "left",
            wrapText: false,
          },
          border: tableBorder(),
        };
        if (numericColumns.has(column)) style.numFmt = numberFormatForValue(cell.v);
        if (typeof cell.v === "number" && (!Number.isFinite(cell.v) || cell.v < 0)) {
          style.fill = { fgColor: { rgb: COLORS.redSoft } };
          style.font = { ...BASE_FONT, color: { rgb: COLORS.red }, bold: true };
        }
        if (column === 0) {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
          cell.w = cell.v;
          style.numFmt = "@";
        }
        applyCellStyle(cell, style);
      });
    });
    return sheet;
  }

  function buildPurchaseManagementSheet(workspace, XLSX) {
    const headers = [
      "상품코드",
      "품목명",
      "규격",
      "전체주문",
      "전재고",
      "서울잔량",
      "구매수량",
      "구매",
      "거래처(단가)",
      "적요",
      "적요1",
    ];
    const sourceRows = workspace.purchaseManagement.filter(
      (row) => row.rowType === "main" && row.inventoryShadow !== true &&
        typeof row.purchaseNeed === "number" && row.purchaseNeed > 0,
    );
    const rows = sourceRows.map((row) => [
      row.productCode,
      row.productName,
      row.specification,
      row.totalOrderQuantity,
      row.inventoryMatched ? row.wholeStockRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRemaining : "",
      row.purchaseNeed,
      row.purchase,
      row.suppliers,
      row.notes,
      row.notes1,
    ]);

    return buildTableSheet(XLSX, {
      title: "발주관리",
      subtitle:
        "구매수량이 0보다 큰 상품만 상품코드별 한 행으로 표시합니다. 구매값이 정확히 대체 또는 소분인 행만 구매업로드에서 제외됩니다.",
      headers,
      rows,
      widths: [15, 34, 13, 14, 13, 16, 14, 18, 34, 30, 30],
      headerFill: COLORS.orange,
      numericColumns: [3, 4, 5, 6],
      textColumns: [0],
      inventoryColumns: [],
      rowStyleResolver(row, index) {
        return exactUnitWarning(sourceRows[index]?.specification)
          ? { fill: COLORS.white, fontColor: COLORS.red }
          : { fill: COLORS.white };
      },
    });
  }

  function buildValidationSheet(workspace, XLSX) {
    const headers = ["검증 항목", "계산 결과", "정상 기준", "판정", "설명"];
    const rows = workspace.validationResults.map((row) => [
      row.item,
      row.result,
      row.expected,
      row.status,
      row.description,
    ]);
    const sheet = buildTableSheet(XLSX, {
      title: "검증결과",
      subtitle:
        "오류가 있으면 출력값을 운영 판단에 사용하지 마십시오. 오류 검산은 원본 상품코드·수량을 기준으로 수행하며, 적요·적요1은 기능을 차단하지 않는 참고 전달사항입니다.",
      headers,
      rows,
      widths: [28, 16, 16, 14, 52],
      headerFill: COLORS.slate,
      numericColumns: [1, 2],
      statusColumn: 3,
    });

    return sheet;
  }

  function styleSourceSheet(sheet, XLSX, source) {
    if (!sheet["!ref"]) return sheet;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const headerRowIndex = Math.max(0, source.headerRowIndex || 0);
    const codeColumnIndex = source.productCodeColumnIndex;
    const endColumn = columnName(range.e.c);
    sheet["!freeze"] = { xSplit: 0, ySplit: headerRowIndex + 1 };
    sheet["!autofilter"] = {
      ref: `A${headerRowIndex + 1}:${endColumn}${range.e.r + 1}`,
    };
    sheet["!views"] = [{ showGridLines: false }];
    sheet["!cols"] = Array.from({ length: range.e.c + 1 }, (_, index) => ({
      wch: index === codeColumnIndex ? 15 : index === 3 || index === 4 ? 28 : 13,
    }));

    for (let row = range.s.r; row < headerRowIndex; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address] || { t: "s", v: "" };
        sheet[address] = cell;
        applyCellStyle(cell, {
          font: {
            name: "Pretendard",
            sz: row === 0 ? 11 : 10,
            bold: row === 0,
            color: { rgb: COLORS.navy },
          },
          fill: { fgColor: { rgb: row === 0 ? COLORS.navySoft : COLORS.white } },
          alignment: { vertical: "center", horizontal: "left" },
        });
      }
    }

    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: headerRowIndex, c: column });
      const cell = sheet[address] || { t: "s", v: "" };
      sheet[address] = cell;
      applyCellStyle(cell, {
        fill: { fgColor: { rgb: COLORS.slate } },
        font: {
          name: "Pretendard",
          sz: 10,
          bold: true,
          color: { rgb: COLORS.white },
        },
        alignment: { vertical: "center", horizontal: "center", wrapText: true },
        border: { bottom: { style: "medium", color: { rgb: COLORS.slate } } },
      });
    }
    for (let row = headerRowIndex + 1; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address] || { t: "s", v: "" };
        sheet[address] = cell;
        if (column === codeColumnIndex && cell.v !== "") {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
          cell.w = cell.v;
        }
        applyCellStyle(cell, {
          font: { ...BASE_FONT },
          fill: { fgColor: { rgb: row % 2 === 0 ? "F8FAFC" : COLORS.white } },
          alignment: { vertical: "center", horizontal: "left" },
          border: { bottom: { style: "hair", color: { rgb: COLORS.line } } },
          ...(column === codeColumnIndex ? { numFmt: "@" } : {}),
        });
      }
    }
    return sheet;
  }

  function buildSourceSheet(workspaceSource, XLSX) {
    const matrix = Array.isArray(workspaceSource.matrix) ? workspaceSource.matrix : [];
    const safeMatrix = matrix.length > 0 ? matrix : [["원본 데이터 없음"]];
    const sheet = XLSX.utils.aoa_to_sheet(safeMatrix);
    return styleSourceSheet(sheet, XLSX, workspaceSource);
  }

  function normalizedHeader(value) {
    return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
  }

  function isWarehouseQuantityHeader(value) {
    const header = normalizedHeader(value);
    if (!header || /단가|가격|금액|원가/.test(header)) return false;
    return /^\d+[^\d].*$/.test(header);
  }

  function warehouseFill(value) {
    const header = normalizedHeader(value);
    const fixed = {
      "1창고": COLORS.graySoft,
      "3서울": "FFEDD5",
      "4전송": COLORS.blueSoft,
      "7진영": COLORS.greenSoft,
    };
    if (fixed[header]) return fixed[header];
    const palette = ["F3E8FF", "E0F2FE", "FEF9C3", "FCE7F3", "E2E8F0", "CCFBF1"];
    let hash = 0;
    for (let index = 0; index < header.length; index += 1) {
      hash = (hash * 31 + header.charCodeAt(index)) >>> 0;
    }
    return palette[hash % palette.length];
  }

  function getInventoryColumnDescriptors(workspaceSource) {
    const matrix = Array.isArray(workspaceSource?.matrix) ? workspaceSource.matrix : [];
    const headerRowIndex = Math.max(0, Number(workspaceSource?.headerRowIndex) || 0);
    return (matrix[headerRowIndex] || []).map((value, sourceIndex) => {
      const header = String(value ?? "").trim();
      const normalizedLabel = normalizedHeader(header);
      if (!normalizedLabel) return null;
      return {
        key: `inventory:${sourceIndex}:${encodeURIComponent(normalizedLabel)}`,
        header,
        sourceIndex,
      };
    }).filter(Boolean);
  }

  function buildWarehouseInventorySheet(workspace, XLSX) {
    if (!engine?.getInventoryViewRows) {
      throw new Error("Shipping Management 재고 엔진을 불러오지 못했습니다.");
    }
    const inventoryView = engine.getInventoryViewRows(workspace);
    const layout = inventoryView.columns.map((column) => ({ ...column }));
    layout.push({ key: "shipping:inventory:purchase", header: "구매", sourceIndex: null, purchase: true });
    layout.push({ key: "shipping:inventory:suppliers", header: "거래처(단가)", sourceIndex: null, suppliers: true });
    layout.push({
      key: "shipping:inventory:order-customers",
      header: "주문거래처명(수량)",
      sourceIndex: null,
      orderCustomers: true,
    });

    const dataRows = inventoryView.rows.map((inventory) => [
      ...inventory.values,
      inventory.purchase,
      inventory.suppliers,
      inventory.orderCustomers,
    ]);
    const headers = layout.map((column) => safeValue(column.header));
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    const codeColumn = layout.findIndex((column) => column.role === "productCode");
    const specificationColumn = headers.findIndex((header) => normalizedHeader(header) === "규격");
    const supplierColumn = layout.findIndex((column) => column.suppliers === true);
    const orderCustomerColumn = layout.findIndex((column) => column.orderCustomers === true);
    const lastColumn = columnName(Math.max(0, headers.length - 1));
    const lastRow = Math.max(1, dataRows.length + 1);
    sheet["!cols"] = headers.map((header) => {
      const normalized = normalizedHeader(header);
      if (normalized === "품목코드") return { wch: 15 };
      if (normalized === "품목명") return { wch: 31 };
      if (normalized === "규격") return { wch: 13 };
      if (normalized === "구매") return { wch: 11 };
      if (normalized === "거래처(단가)") return { wch: 34 };
      if (normalized === "주문거래처명(수량)") return { wch: 34 };
      return { wch: isWarehouseQuantityHeader(header) ? 11 : 13 };
    });
    sheet["!rows"] = [{ hpt: 27 }, ...dataRows.map((row) => ({
      hpt: Math.min(120, Math.max(32, Math.max(
        String(row[supplierColumn] || "").split(/\r?\n/).length,
        String(row[orderCustomerColumn] || "").split(/\r?\n/).length,
      ) * 18)),
    }))];
    sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    sheet["!autofilter"] = { ref: `A1:${lastColumn}${lastRow}` };
    sheet["!views"] = [{ showGridLines: false }];

    headers.forEach((_, column) => {
      applyCellStyle(ensureCell(sheet, XLSX, 0, column), {
        fill: { fgColor: { rgb: COLORS.slate } },
        font: { name: "Pretendard", sz: 10, bold: true, color: { rgb: COLORS.white } },
        alignment: { vertical: "center", horizontal: "center", wrapText: true },
        border: tableBorder(),
      });
    });

    dataRows.forEach((row, rowIndex) => {
      const sheetRow = rowIndex + 1;
      const highlightText = exactUnitWarning(row[specificationColumn]);
      row.forEach((_, column) => {
        const cell = ensureCell(sheet, XLSX, sheetRow, column);
        const style = {
          fill: { fgColor: { rgb: COLORS.white } },
          font: {
            ...BASE_FONT,
            ...(highlightText && !isBlank(cell.v) ? { color: { rgb: COLORS.red } } : {}),
          },
          alignment: {
            vertical: "center",
            horizontal: typeof cell.v === "number" ? "right" : "left",
            wrapText: false,
          },
          border: tableBorder(),
          ...(typeof cell.v === "number" ? { numFmt: numberFormatForValue(cell.v) } : {}),
        };
        if (typeof cell.v === "string") {
          cell.t = "s";
          cell.w = cell.v;
          style.numFmt = "@";
        }
        if (
          typeof cell.v === "number" &&
          Number.isFinite(cell.v) &&
          cell.v < 0 &&
          ["warehouseQuantity", "calculatedQuantity"].includes(layout[column]?.role)
        ) {
          style.fill = { fgColor: { rgb: "FFF200" } };
        }
        if (column === codeColumn && !isBlank(cell.v)) {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
          cell.w = cell.v;
          style.numFmt = "@";
        }
        if (column === supplierColumn || column === orderCustomerColumn) {
          style.alignment = { vertical: "top", horizontal: "left", wrapText: true };
        }
        applyCellStyle(cell, style);
      });
    });
    return sheet;
  }

  function addPrintNames(workbook, sheetName, lastRow, lastColumn = "L") {
    const sheetIndex = workbook.SheetNames.indexOf(sheetName);
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Names = workbook.Workbook.Names || [];
    workbook.Workbook.Names.push(
      {
        Name: "_xlnm.Print_Area",
        Sheet: sheetIndex,
        Ref: `'${sheetName}'!$A$1:$${lastColumn}$${lastRow}`,
      },
      {
        Name: "_xlnm.Print_Titles",
        Sheet: sheetIndex,
        Ref: `'${sheetName}'!$1:$1`,
      },
    );
  }

  function crc32(bytes) {
    const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    }));
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  function readStoredZip(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let endOffset = -1;
    for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error("XLSX ZIP 끝 레코드를 찾지 못했습니다.");
    const entryCount = view.getUint16(endOffset + 10, true);
    let centralOffset = view.getUint32(endOffset + 16, true);
    const decoder = new TextDecoder("utf-8");
    const entries = [];
    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(centralOffset, true) !== 0x02014b50) {
        throw new Error("XLSX ZIP 중앙 디렉터리가 손상되었습니다.");
      }
      const method = view.getUint16(centralOffset + 10, true);
      if (method !== 0) throw new Error("인쇄 설정 보강에는 비압축 XLSX 패키지가 필요합니다.");
      const time = view.getUint16(centralOffset + 12, true);
      const date = view.getUint16(centralOffset + 14, true);
      const compressedSize = view.getUint32(centralOffset + 20, true);
      const nameLength = view.getUint16(centralOffset + 28, true);
      const extraLength = view.getUint16(centralOffset + 30, true);
      const commentLength = view.getUint16(centralOffset + 32, true);
      const localOffset = view.getUint32(centralOffset + 42, true);
      const nameBytes = data.slice(centralOffset + 46, centralOffset + 46 + nameLength);
      const name = decoder.decode(nameBytes);
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error(`XLSX ZIP 로컬 엔트리가 손상되었습니다: ${name}`);
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const contentStart = localOffset + 30 + localNameLength + localExtraLength;
      entries.push({
        name,
        nameBytes,
        time,
        date,
        content: data.slice(contentStart, contentStart + compressedSize),
      });
      centralOffset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  function writeStoredZip(entries) {
    const localSize = entries.reduce(
      (total, entry) => total + 30 + entry.nameBytes.length + entry.content.length,
      0,
    );
    const centralSize = entries.reduce(
      (total, entry) => total + 46 + entry.nameBytes.length,
      0,
    );
    const output = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(output.buffer);
    const writeUint16 = (offset, value) => view.setUint16(offset, value, true);
    const writeUint32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
    const metadata = [];
    let offset = 0;
    entries.forEach((entry) => {
      const checksum = crc32(entry.content);
      metadata.push({ ...entry, checksum, localOffset: offset });
      writeUint32(offset, 0x04034b50);
      writeUint16(offset + 4, 20);
      writeUint16(offset + 6, 0x0800);
      writeUint16(offset + 8, 0);
      writeUint16(offset + 10, entry.time);
      writeUint16(offset + 12, entry.date);
      writeUint32(offset + 14, checksum);
      writeUint32(offset + 18, entry.content.length);
      writeUint32(offset + 22, entry.content.length);
      writeUint16(offset + 26, entry.nameBytes.length);
      writeUint16(offset + 28, 0);
      output.set(entry.nameBytes, offset + 30);
      output.set(entry.content, offset + 30 + entry.nameBytes.length);
      offset += 30 + entry.nameBytes.length + entry.content.length;
    });
    const centralOffset = offset;
    metadata.forEach((entry) => {
      writeUint32(offset, 0x02014b50);
      writeUint16(offset + 4, 20);
      writeUint16(offset + 6, 20);
      writeUint16(offset + 8, 0x0800);
      writeUint16(offset + 10, 0);
      writeUint16(offset + 12, entry.time);
      writeUint16(offset + 14, entry.date);
      writeUint32(offset + 16, entry.checksum);
      writeUint32(offset + 20, entry.content.length);
      writeUint32(offset + 24, entry.content.length);
      writeUint16(offset + 28, entry.nameBytes.length);
      writeUint16(offset + 30, 0);
      writeUint16(offset + 32, 0);
      writeUint16(offset + 34, 0);
      writeUint16(offset + 36, 0);
      writeUint32(offset + 38, 0);
      writeUint32(offset + 42, entry.localOffset);
      output.set(entry.nameBytes, offset + 46);
      offset += 46 + entry.nameBytes.length;
    });
    writeUint32(offset, 0x06054b50);
    writeUint16(offset + 4, 0);
    writeUint16(offset + 6, 0);
    writeUint16(offset + 8, entries.length);
    writeUint16(offset + 10, entries.length);
    writeUint32(offset + 12, centralSize);
    writeUint32(offset + 16, centralOffset);
    writeUint16(offset + 20, 0);
    return output;
  }

  function addPageSetupXml(xml) {
    let result = xml.replace(/<pageSetup\b[^>]*\/>/g, "");
    if (/<sheetPr\b[^>]*\/>/.test(result)) {
      result = result.replace(
        /<sheetPr\b([^>]*)\/>/,
        '<sheetPr$1><pageSetUpPr fitToPage="1"/></sheetPr>',
      );
    } else if (/<sheetPr\b[^>]*>/.test(result)) {
      if (/<pageSetUpPr\b/.test(result)) {
        result = result.replace(/<pageSetUpPr\b[^>]*\/>/, '<pageSetUpPr fitToPage="1"/>');
      } else {
        result = result.replace(/<\/sheetPr>/, '<pageSetUpPr fitToPage="1"/></sheetPr>');
      }
    } else {
      result = result.replace(
        /(<worksheet\b[^>]*>)/,
        '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
      );
    }
    const pageSetup =
      '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>';
    if (/<pageMargins\b[^>]*\/>/.test(result)) {
      result = result.replace(/(<pageMargins\b[^>]*\/>)/, `$1${pageSetup}`);
    } else {
      result = result.replace(/<\/worksheet>/, `${pageSetup}</worksheet>`);
    }
    return result;
  }

  function writeWorkbook(workbook, XLSX) {
    requireXlsx(XLSX);
    const raw = XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      compression: false,
      cellStyles: true,
    });
    const entries = readStoredZip(new Uint8Array(raw));
    const sheetNumber = workbook.SheetNames.indexOf("미출고현황") + 1;
    const targetName = `xl/worksheets/sheet${sheetNumber}.xml`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8");
    let updated = false;
    entries.forEach((entry) => {
      if (entry.name !== targetName) return;
      entry.content = encoder.encode(addPageSetupXml(decoder.decode(entry.content)));
      updated = true;
    });
    if (!updated) throw new Error("미출고현황 인쇄 설정 대상 시트를 찾지 못했습니다.");
    return writeStoredZip(entries);
  }

  function downloadBytes(bytes, fileName) {
    if (typeof document === "undefined" || typeof URL === "undefined") {
      throw new Error("브라우저 다운로드 환경을 찾지 못했습니다.");
    }
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function getPurchaseUploadRows(workspace) {
    return (workspace?.purchaseManagement || []).filter(
      (row) =>
        row.rowType !== "reference" &&
        row.inventoryMatched &&
        typeof row.purchaseNeed === "number" &&
        row.purchaseNeed > 0 &&
        row.purchase !== "대체" &&
        row.purchase !== "소분",
    );
  }

  function requirePurchaseUploadReady(workspace) {
    if (!workspace || workspace.schemaVersion !== "shipping-workspace/v2") {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }
    if (workspace.basisDateStatus !== "valid" || !/^\d{8}$/.test(String(workspace.uploadDate || ""))) {
      const dates = Array.isArray(workspace.basisDates) ? workspace.basisDates.join(", ") : "";
      throw new Error(
        dates
          ? `구매업로드 기준일 날짜 후보가 서로 다르거나 올바르지 않습니다: ${dates}`
          : "구매업로드 기준일을 일자-No.·일자·주문일자에서 확인할 수 없습니다.",
      );
    }
  }

  function buildPurchaseUploadSheet(workspace, XLSX) {
    requireXlsx(XLSX);
    requirePurchaseUploadReady(workspace);
    const sourceRows = getPurchaseUploadRows(workspace);
    const rows = sourceRows.map((row) => [
      workspace.uploadDate,
      "",
      "",
      String(row.purchase || ""),
      "01",
      "",
      "",
      "",
      String(row.productCode || ""),
      String(row.productName || ""),
      String(row.specification || ""),
      row.purchaseNeed,
      0,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    const sheet = XLSX.utils.aoa_to_sheet([[...PURCHASE_UPLOAD_HEADERS], ...rows]);
    const lastRow = Math.max(1, rows.length + 1);
    sheet["!ref"] = `A1:T${lastRow}`;
    sheet["!cols"] = PURCHASE_UPLOAD_HEADERS.map(() => ({ wch: 15.125 }));
    sheet["!rows"] = Array.from({ length: lastRow }, () => ({ hpt: 16.5 }));

    PURCHASE_UPLOAD_HEADERS.forEach((_, column) => {
      const cell = ensureCell(sheet, XLSX, 0, column);
      cell.t = "s";
      cell.v = PURCHASE_UPLOAD_HEADERS[column];
      cell.w = cell.v;
      applyCellStyle(cell, {
        fill: { fgColor: { rgb: "FFFFFF" } },
        font: {
          name: "Arial",
          sz: PURCHASE_UPLOAD_REQUIRED_HEADER_INDEXES.includes(column) ? 11 : 10,
          color: { rgb: "000000" },
          ...(PURCHASE_UPLOAD_REQUIRED_HEADER_INDEXES.includes(column) ? { bold: true } : {}),
        },
        alignment: { horizontal: "left", vertical: "center", wrapText: false },
        border: {
          top: { style: "thin", color: { rgb: "000000" } },
          bottom: { style: "thin", color: { rgb: "000000" } },
          left: { style: "thin", color: { rgb: "000000" } },
          right: { style: "thin", color: { rgb: "000000" } },
        },
        protection: { locked: false },
      });
    });

    for (let row = 1; row < lastRow; row += 1) {
      for (let column = 0; column < PURCHASE_UPLOAD_HEADERS.length; column += 1) {
        const cell = ensureCell(sheet, XLSX, row, column);
        const numeric = column === 11 || column === 12;
        if (numeric) {
          cell.t = "n";
          cell.v = Number(cell.v || 0);
        } else {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
          cell.w = cell.v;
        }
        applyCellStyle(cell, {
          fill: { fgColor: { rgb: "FFFFFF" } },
          font: { name: "맑은 고딕", sz: 11, color: { rgb: "000000" } },
          alignment: { horizontal: "left", vertical: "center", wrapText: false },
          protection: { locked: false },
          numFmt: numeric ? numberFormatForValue(cell.v) : "@",
        });
      }
    }

    return sheet;
  }

  function buildPurchaseUploadWorkbook(workspace, XLSX) {
    const sheet = buildPurchaseUploadSheet(workspace, XLSX);
    const workbook = XLSX.utils.book_new();
    workbook.Props = {
      Title: "구매업로드",
      Subject: "ONEAPP Shipping Management 구매입력",
      Author: "ONEAPP Shipping Management",
      Company: "ONEAPP",
      Comments: `schema=${PURCHASE_UPLOAD_SCHEMA_VERSION}; workbook=${WORKBOOK_VERSION}`,
      CreatedDate: new Date(workspace.createdAt),
    };
    XLSX.utils.book_append_sheet(workbook, sheet, "구매입력");
    return workbook;
  }

  function getPurchaseUploadFileName(workspace) {
    requirePurchaseUploadReady(workspace);
    return `구매업로드_${workspace.uploadDate}.xlsx`;
  }

  function writeStandardWorkbook(workbook, XLSX) {
    requireXlsx(XLSX);
    return XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      compression: true,
      cellStyles: true,
    });
  }

  function downloadPurchaseUploadWorkbook(workspace, XLSX, fileName) {
    const workbook = buildPurchaseUploadWorkbook(workspace, XLSX);
    downloadBytes(
      writeStandardWorkbook(workbook, XLSX),
      fileName || getPurchaseUploadFileName(workspace),
    );
    return workbook;
  }

  function buildWorkbook(workspace, XLSX) {
    requireXlsx(XLSX);
    if (!workspace || workspace.schemaVersion !== "shipping-workspace/v2") {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }

    requirePurchaseUploadReady(workspace);
    const workbook = XLSX.utils.book_new();
    workbook.Props = {
      Title: "OrderOps 통합 출력",
      Subject: "전달사항·창고별재고·미출고현황·구매업로드",
      Author: "ONEAPP Shipping Management",
      Company: "ONEAPP",
      Comments: `workspace=${workspace.schemaVersion}; workbook=${WORKBOOK_VERSION}`,
      CreatedDate: new Date(workspace.createdAt),
    };
    XLSX.utils.book_append_sheet(
      workbook,
      buildDeliveryNoticeSheet(workspace, XLSX),
      "전달사항(적요보기)",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      buildWarehouseInventorySheet(workspace, XLSX),
      "창고별재고",
    );
    const allocationSheet = buildAllocationSheet(workspace, XLSX);
    XLSX.utils.book_append_sheet(workbook, allocationSheet, "미출고현황");
    XLSX.utils.book_append_sheet(
      workbook,
      buildPurchaseUploadSheet(workspace, XLSX),
      "구매업로드",
    );
    const allocationLastColumn = columnName(
      XLSX.utils.decode_range(allocationSheet["!ref"]).e.c,
    );
    addPrintNames(
      workbook,
      "미출고현황",
      Math.max(1, workspace.allocations.length + 1),
      allocationLastColumn,
    );
    return workbook;
  }

  function getOutputFileName(createdAt) {
    return `OrderOps_통합출력_${localDateStamp(createdAt)}.xlsx`;
  }

  function downloadWorkbook(workspace, XLSX, fileName) {
    requireXlsx(XLSX);
    const workbook = buildWorkbook(workspace, XLSX);
    downloadBytes(
      writeWorkbook(workbook, XLSX),
      fileName || getOutputFileName(workspace.createdAt),
    );
    return workbook;
  }

  return Object.freeze({
    WORKBOOK_VERSION,
    REQUIRED_SHEETS,
    PURCHASE_UPLOAD_SCHEMA_VERSION,
    PURCHASE_UPLOAD_HEADERS,
    getOutputFileName,
    getPurchaseUploadRows,
    getPurchaseUploadFileName,
    buildWorkbook,
    buildDeliveryNoticeSheet,
    buildPurchaseUploadSheet,
    buildPurchaseUploadWorkbook,
    writeWorkbook,
    writeStandardWorkbook,
    downloadWorkbook,
    downloadPurchaseUploadWorkbook,
  });
});
