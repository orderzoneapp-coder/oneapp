(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ShippingManagementWorkbook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WORKBOOK_VERSION = "1.1.1";
  const REQUIRED_SHEETS = Object.freeze([
    "창고별 재고",
    "미출고현황",
    "상품별요약",
    "발주관리",
    "적요이슈",
    "검증결과",
    "주문원본",
  ]);

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

  function addCachedFormula(sheet, XLSX, rowIndex, columnIndex, formula, value, type) {
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
    const existingStyle = sheet[address]?.s;
    sheet[address] = {
      t: type || (typeof value === "number" ? "n" : "s"),
      v: safeValue(value),
      f: formula,
      ...(existingStyle ? { s: existingStyle } : {}),
    };
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

  function displayInventoryValue(value) {
    if (value === 0 || (typeof value === "string" && value.trim() === "0")) return "";
    return safeValue(value);
  }

  function allocationStatusLabel(status) {
    const labels = {
      "추가 구매 필요": "구매",
      "부분출고·추가구매": "추가",
      "서울 1차 구매분 출고": "서울",
      "전재고 출고": "재고",
    };
    return labels[status] || safeValue(status);
  }

  function managerFill(manager) {
    const palette = ["FCE7D6", "DDEBF7", "E2F0D9", "EDE9FE", "FEF3C7", "FCE7F3", "CCFBF1"];
    const text = String(manager || "");
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return palette[hash % palette.length];
  }

  function allocationStatusStyle(status) {
    if (status === "구매" || status === "재고정보 없음") {
      return { fill: COLORS.redSoft, font: COLORS.red };
    }
    if (status === "추가") return { fill: COLORS.orangeSoft, font: COLORS.orange };
    if (status === "서울") return { fill: COLORS.blueSoft, font: "1D4ED8" };
    if (status === "재고") return { fill: COLORS.greenSoft, font: "15803D" };
    return { fill: COLORS.orangeSoft, font: COLORS.orange };
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
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (!cell) continue;
        const style = {
          fill: { fgColor: { rgb: alternateFill } },
          font: { ...BASE_FONT },
          alignment: {
            vertical: "center",
            horizontal: numericColumns.includes(column) || priceColumns.includes(column)
              ? "right"
              : "left",
            wrapText: false,
          },
          border: { bottom: { style: "hair", color: { rgb: COLORS.line } } },
        };
        if (numericColumns.includes(column)) style.numFmt = "#,##0.###";
        if (priceColumns.includes(column)) style.numFmt = "#,##0";
        if (textColumns.includes(column)) {
          cell.t = "s";
          cell.v = String(cell.v ?? "");
          cell.w = cell.v;
          style.numFmt = "@";
        }
        if (column === statusColumn) {
          const status = String(cell.v || "");
          if (status.includes("재고정보") || status === "추가 구매 필요") {
            style.fill = { fgColor: { rgb: COLORS.redSoft } };
            style.font = { ...BASE_FONT, color: { rgb: COLORS.red }, bold: true };
          } else if (
            status.includes("부분출고") ||
            status.includes("확인") ||
            status.includes("발주 필요")
          ) {
            style.fill = { fgColor: { rgb: COLORS.orangeSoft } };
            style.font = { ...BASE_FONT, color: { rgb: COLORS.orange }, bold: true };
          } else if (status.includes("서울")) {
            style.fill = { fgColor: { rgb: COLORS.blueSoft } };
            style.font = { ...BASE_FONT, color: { rgb: "1D4ED8" }, bold: true };
          } else if (status) {
            style.fill = { fgColor: { rgb: COLORS.greenSoft } };
            style.font = { ...BASE_FONT, color: { rgb: "15803D" }, bold: true };
          }
        }
        applyCellStyle(cell, style);
      }
    }

    return sheet;
  }

  function buildAllocationSheet(workspace, XLSX) {
    const headers = [
      "상품코드",
      "품목명",
      "규격",
      "단가",
      "수량",
      "재고",
      "서울",
      "전송",
      "적요",
      "거래처",
      "그룹",
      "출고",
    ];
    const rows = workspace.allocations.map((row) => [
      row.productCode,
      row.productName,
      row.specification,
      row.unitPrice ?? "",
      row.quantity,
      row.inventoryMatched ? displayInventoryValue(row.wholeStockRaw) : "",
      row.inventoryMatched ? displayInventoryValue(row.seoulFirstPurchaseRaw) : "",
      row.inventoryMatched ? displayInventoryValue(row.firstTransferRaw) : "",
      row.note,
      row.customer,
      row.group,
      allocationStatusLabel(row.status),
    ]);
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const lastRow = Math.max(1, rows.length + 1);
    sheet["!cols"] = [
      { wch: 15 }, { wch: 31 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 22 }, { wch: 14 }, { wch: 12 },
    ];
    sheet["!rows"] = [{ hpt: 27 }];
    sheet["!autofilter"] = { ref: `A1:L${lastRow}` };
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
    sheet["!printArea"] = `A1:L${lastRow}`;
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
      const rowFill = managerFill(workspace.allocations[rowIndex]?.manager);
      row.forEach((value, column) => {
        const cell = ensureCell(sheet, XLSX, sheetRow, column);
        const style = {
          fill: { fgColor: { rgb: rowFill } },
          font: { ...BASE_FONT },
          alignment: {
            vertical: "center",
            horizontal: column >= 3 && column <= 7 ? "right" : "left",
            wrapText: false,
          },
          border: tableBorder(),
        };
        if (column >= 3 && column <= 7) style.numFmt = "#,##0.###";
        if (column === 5 && !isBlank(value)) style.fill = { fgColor: { rgb: COLORS.greenSoft } };
        if (column === 6 && !isBlank(value)) style.fill = { fgColor: { rgb: COLORS.blueSoft } };
        if (column === 7 && !isBlank(value)) style.fill = { fgColor: { rgb: COLORS.purpleSoft } };
        if (column === 11) {
          const statusStyle = allocationStatusStyle(String(value || ""));
          style.fill = { fgColor: { rgb: statusStyle.fill } };
          style.font = { ...BASE_FONT, color: { rgb: statusStyle.font }, bold: true };
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

  function buildProductSummarySheet(workspace, XLSX) {
    const headers = [
      "상품코드",
      "품목명",
      "규격",
      "전체 주문수량",
      "전재고 원값",
      "서울 1차 구매분",
      "4전송 원값",
      "서울 1차 구매잔량",
      "전재고 배정",
      "서울 1차 구매분 배정",
      "추가 구매 필요",
      "출고판정",
      "주문건수",
      "관련 거래처",
      "적요",
      "적요1",
      "배송그룹",
      "재고 매칭상태",
      "배정 검증",
    ];
    const rows = workspace.productSummaries.map((row) => [
      row.productCode,
      row.productName,
      row.specification,
      row.totalOrderQuantity,
      row.inventoryMatched ? row.wholeStockRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRaw : "",
      row.inventoryMatched ? row.firstTransferRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRemaining : "",
      row.wholeAllocation,
      row.seoulAllocation,
      row.inventoryMatched ? row.purchaseNeed : "",
      row.status,
      row.orderCount,
      row.customers,
      row.notes,
      row.notes1,
      row.groups,
      row.matchStatus,
      row.inventoryMatched
        ? Math.abs(row.reconciliationDifference || 0) <= 1e-9
          ? "정상"
          : "오류"
        : "확인 필요",
    ]);

    return buildTableSheet(XLSX, {
      title: "상품별요약",
      subtitle:
        "상품코드별 주문·재고·배정을 한 번만 집계합니다. 서울 1차 구매잔량은 MAX(0, 3서울 + 4전송)이며 상품명은 표시용입니다.",
      headers,
      rows,
      widths: [15, 31, 13, 14, 13, 15, 12, 16, 13, 17, 14, 20, 10, 32, 25, 25, 20, 15, 12],
      numericColumns: [3, 4, 5, 6, 7, 8, 9, 10, 12],
      textColumns: [0],
      statusColumn: 11,
      formulaWriter(sheet, startRow, sourceRows) {
        sourceRows.forEach((row, index) => {
          const zeroBasedRow = startRow + index;
          const excelRow = zeroBasedRow + 1;
          const matched = row[17] !== "재고정보 없음";
          addCachedFormula(
            sheet,
            XLSX,
            zeroBasedRow,
            7,
            `IF(R${excelRow}="재고정보 없음","",MAX(0,F${excelRow}+G${excelRow}))`,
            matched ? row[7] : "",
            matched ? "n" : "s",
          );
          addCachedFormula(
            sheet,
            XLSX,
            zeroBasedRow,
            10,
            `IF(R${excelRow}="재고정보 없음","",MAX(0,D${excelRow}-I${excelRow}-J${excelRow}))`,
            matched ? row[10] : "",
            matched ? "n" : "s",
          );
          addCachedFormula(
            sheet,
            XLSX,
            zeroBasedRow,
            18,
            `IF(R${excelRow}="재고정보 없음","확인 필요",IF(ABS(D${excelRow}-I${excelRow}-J${excelRow}-K${excelRow})<0.000000001,"정상","오류"))`,
            row[18],
            "s",
          );
        });
      },
    });
  }

  function buildPurchaseManagementSheet(workspace, XLSX) {
    const headers = [
      "상품코드",
      "품목명",
      "규격",
      "전체 주문수량",
      "전재고 원값",
      "서울 1차 구매잔량",
      "추가 구매 필요",
      "관리상태",
      "주문건수",
      "관련 거래처",
      "적요",
      "적요1",
      "배송그룹",
      "재고 매칭상태",
      "확정 발주수량",
      "관리자 확인",
    ];
    const rows = workspace.purchaseManagement.map((row) => [
      row.productCode,
      row.productName,
      row.specification,
      row.totalOrderQuantity,
      row.inventoryMatched ? row.wholeStockRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRemaining : "",
      row.inventoryMatched ? row.purchaseNeed : "",
      row.managementStatus,
      row.orderCount,
      row.customers,
      row.notes,
      row.notes1,
      row.groups,
      row.matchStatus,
      "",
      "",
    ]);

    return buildTableSheet(XLSX, {
      title: "발주관리",
      subtitle:
        "추가 구매 필요 상품과 재고정보 없음 상품을 함께 표시합니다. 재고정보 없음은 구매수량을 비워 두고 원본 상품코드를 먼저 확인하십시오.",
      headers,
      rows,
      widths: [15, 31, 13, 14, 13, 16, 14, 17, 10, 32, 25, 25, 20, 15, 14, 22],
      headerFill: COLORS.orange,
      numericColumns: [3, 4, 5, 6, 8, 14],
      textColumns: [0],
      statusColumn: 7,
    });
  }

  function buildMemoIssueSheet(workspace, XLSX) {
    const headers = [
      "배정순서",
      "원본행",
      "상품코드",
      "품목명",
      "적요",
      "적요1",
      "거래처",
      "그룹",
      "관리자 검토",
    ];
    const rows =
      workspace.memoIssues.length > 0
        ? workspace.memoIssues.map((row) => [
            row.inputOrder,
            row.sourceRowNumber,
            row.productCode,
            row.productName,
            row.note,
            row.note1,
            row.customer,
            row.group,
            "",
          ])
        : [["", "", "", "적요·적요1 확인 대상 없음", "", "", "", "", ""]];

    return buildTableSheet(XLSX, {
      title: "적요이슈",
      subtitle:
        "적요 또는 적요1의 원문만 수집합니다. 긴급도·거래처 우선순위·처리방법은 자동 추론하지 않습니다.",
      headers,
      rows,
      widths: [9, 9, 15, 31, 32, 32, 25, 16, 24],
      headerFill: COLORS.slate,
      numericColumns: [0, 1],
      textColumns: [2],
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
        "오류가 있으면 출력값을 운영 판단에 사용하지 마십시오. 확인 필요 항목은 원본 상품코드·수량·적요를 관리자가 비교합니다.",
      headers,
      rows,
      widths: [28, 16, 16, 14, 52],
      headerFill: COLORS.slate,
      numericColumns: [1, 2],
      statusColumn: 3,
    });

    const allocationStart = 2;
    const allocationEnd = Math.max(allocationStart, workspace.allocations.length + 1);
    const summaryStart = 5;
    const summaryEnd = Math.max(summaryStart, workspace.productSummaries.length + 4);
    const memoStart = 5;
    const memoEnd = Math.max(memoStart, workspace.memoIssues.length + 4);
    const formulaByItem = {
      "상품별 주문수량 대사 차이": {
        formula: `SUM('미출고현황'!$E$${allocationStart}:$E$${allocationEnd})-SUM('상품별요약'!$D$${summaryStart}:$D$${summaryEnd})`,
      },
      "매칭 주문 배정 대사 차이": {
        formula: `SUMIFS('상품별요약'!$D$${summaryStart}:$D$${summaryEnd},'상품별요약'!$R$${summaryStart}:$R$${summaryEnd},"매칭완료")-SUM('상품별요약'!$I$${summaryStart}:$K$${summaryEnd})`,
      },
      "음수 추가 구매 필요": {
        formula: `COUNTIF('상품별요약'!$K$${summaryStart}:$K$${summaryEnd},"<0")`,
      },
      "재고정보 없음": {
        formula: `COUNTIF('상품별요약'!$R$${summaryStart}:$R$${summaryEnd},"재고정보 없음")`,
      },
      "적요 확인": {
        formula: workspace.memoIssues.length
          ? `COUNTA('적요이슈'!$A$${memoStart}:$A$${memoEnd})`
          : "0",
      },
    };
    workspace.validationResults.forEach((row, index) => {
      const formulaConfig = formulaByItem[row.item];
      if (!formulaConfig) return;
      addCachedFormula(sheet, XLSX, 4 + index, 1, formulaConfig.formula, row.result, "n");
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

  function buildWarehouseInventorySheet(workspaceSource, XLSX) {
    const matrix = Array.isArray(workspaceSource.matrix)
      ? workspaceSource.matrix.map((row) => (Array.isArray(row) ? row.slice() : []))
      : [];
    const headerRowIndex = Math.max(0, workspaceSource.headerRowIndex || 0);
    const sourceHeaders = (matrix[headerRowIndex] || []).map(safeValue);
    const indexByHeader = new Map();
    sourceHeaders.forEach((header, index) => {
      const normalized = normalizedHeader(header);
      if (normalized && !indexByHeader.has(normalized)) indexByHeader.set(normalized, index);
    });

    const layout = [];
    const usedIndexes = new Set();
    const addSource = (header) => {
      const index = indexByHeader.get(normalizedHeader(header));
      if (index === undefined || usedIndexes.has(index)) return;
      usedIndexes.add(index);
      layout.push({ header: sourceHeaders[index], sourceIndex: index });
    };
    addSource("품목코드");
    addSource("품목명");
    addSource("규격");
    layout.push({ header: "구매", sourceIndex: null, purchase: true });
    addSource("수량");
    ["1창고", "3서울", "4전송", "7진영"].forEach(addSource);
    sourceHeaders.forEach((header, index) => {
      if (usedIndexes.has(index) || normalizedHeader(header) === "구매") return;
      usedIndexes.add(index);
      layout.push({ header, sourceIndex: index });
    });

    const dataRows = matrix.slice(headerRowIndex + 1).map((sourceRow) =>
      layout.map((column) => (column.purchase ? "" : safeValue(sourceRow[column.sourceIndex]))),
    );
    const headers = layout.map((column) => safeValue(column.header));
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    const codeColumn = headers.findIndex((header) => normalizedHeader(header) === "품목코드");
    const specificationColumn = headers.findIndex((header) => normalizedHeader(header) === "규격");
    const quantityColumn = headers.findIndex((header) => normalizedHeader(header) === "수량");
    const warehouseColumns = headers
      .map((header, index) => (isWarehouseQuantityHeader(header) ? index : -1))
      .filter((index) => index >= 0);
    const lastColumn = columnName(Math.max(0, headers.length - 1));
    const lastRow = Math.max(1, dataRows.length + 1);
    sheet["!cols"] = headers.map((header) => {
      const normalized = normalizedHeader(header);
      if (normalized === "품목코드") return { wch: 15 };
      if (normalized === "품목명") return { wch: 31 };
      if (normalized === "규격") return { wch: 13 };
      if (normalized === "구매") return { wch: 11 };
      return { wch: isWarehouseQuantityHeader(header) ? 11 : 13 };
    });
    sheet["!rows"] = [{ hpt: 27 }];
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
      const specification = String(row[specificationColumn] ?? "").trim().toUpperCase();
      const highlightText = specification === "EA" || specification === "소분";
      const quantity = Number(row[quantityColumn]);
      const negativeQuantity = !isBlank(row[quantityColumn]) && Number.isFinite(quantity) && quantity < 0;
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
          ...(typeof cell.v === "number" ? { numFmt: "#,##0.###" } : {}),
        };
        if (warehouseColumns.includes(column)) {
          style.fill = { fgColor: { rgb: warehouseFill(headers[column]) } };
        }
        if (negativeQuantity && column >= codeColumn && column <= quantityColumn) {
          style.fill = { fgColor: { rgb: "FFF200" } };
        }
        if (column === codeColumn && !isBlank(cell.v)) {
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

  function addPrintNames(workbook, sheetName, lastRow) {
    const sheetIndex = workbook.SheetNames.indexOf(sheetName);
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Names = workbook.Workbook.Names || [];
    workbook.Workbook.Names.push(
      {
        Name: "_xlnm.Print_Area",
        Sheet: sheetIndex,
        Ref: `'${sheetName}'!$A$1:$L$${lastRow}`,
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

  function buildWorkbook(workspace, XLSX) {
    requireXlsx(XLSX);
    if (!workspace || workspace.schemaVersion !== "shipping-workspace/v1") {
      throw new Error("지원하지 않는 Shipping Management 작업공간입니다.");
    }

    const workbook = XLSX.utils.book_new();
    workbook.Props = {
      Title: "Shipping Management 미출고현황",
      Subject: "전재고·서울 1차 구매잔량·추가 구매 필요 배정",
      Author: "ONEAPP Shipping Management",
      Company: "ONEAPP",
      Comments: `workspace=${workspace.schemaVersion}; workbook=${WORKBOOK_VERSION}`,
      CreatedDate: new Date(workspace.createdAt),
    };
    XLSX.utils.book_append_sheet(
      workbook,
      buildWarehouseInventorySheet(workspace.sourceFiles.inventory, XLSX),
      "창고별 재고",
    );
    XLSX.utils.book_append_sheet(workbook, buildAllocationSheet(workspace, XLSX), "미출고현황");
    XLSX.utils.book_append_sheet(
      workbook,
      buildProductSummarySheet(workspace, XLSX),
      "상품별요약",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      buildPurchaseManagementSheet(workspace, XLSX),
      "발주관리",
    );
    XLSX.utils.book_append_sheet(workbook, buildMemoIssueSheet(workspace, XLSX), "적요이슈");
    XLSX.utils.book_append_sheet(workbook, buildValidationSheet(workspace, XLSX), "검증결과");
    XLSX.utils.book_append_sheet(
      workbook,
      buildSourceSheet(workspace.sourceFiles.orders, XLSX),
      "주문원본",
    );
    addPrintNames(workbook, "미출고현황", Math.max(1, workspace.allocations.length + 1));
    return workbook;
  }

  function getOutputFileName(createdAt) {
    return `미출고현황_${localDateStamp(createdAt)}.xlsx`;
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
    getOutputFileName,
    buildWorkbook,
    writeWorkbook,
    downloadWorkbook,
  });
});
