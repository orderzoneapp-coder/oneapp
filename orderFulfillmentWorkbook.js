(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ShippingManagementWorkbook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WORKBOOK_VERSION = "1.0.0";
  const REQUIRED_SHEETS = Object.freeze([
    "미출고현황",
    "상품별요약",
    "발주관리",
    "적요이슈",
    "검증결과",
    "주문원본",
    "재고원본",
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
      "배정순서",
      "일자-No.",
      "담당",
      "상품코드",
      "품목명",
      "규격",
      "주문수량",
      "전재고 원값",
      "서울 1차 구매분",
      "4전송 원값",
      "서울 1차 구매잔량",
      "전재고 배정",
      "서울 1차 구매분 배정",
      "추가 구매 필요",
      "출고판정",
      "배정 후 전재고",
      "배정 후 서울잔량",
      "단가",
      "적요",
      "적요1",
      "거래처",
      "그룹",
      "재고 매칭상태",
      "배정 검증",
    ];
    const rows = workspace.allocations.map((row) => [
      row.inputOrder,
      row.orderNumber,
      row.manager,
      row.productCode,
      row.productName,
      row.specification,
      row.quantity,
      row.inventoryMatched ? row.wholeStockRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRaw : "",
      row.inventoryMatched ? row.firstTransferRaw : "",
      row.inventoryMatched ? row.seoulFirstPurchaseRemaining : "",
      row.wholeAllocation,
      row.seoulAllocation,
      row.inventoryMatched ? row.purchaseNeed : "",
      row.status,
      row.inventoryMatched ? row.wholeRemaining : "",
      row.inventoryMatched ? row.seoulRemaining : "",
      row.unitPrice ?? "",
      row.note,
      row.note1,
      row.customer,
      row.group,
      row.matchStatus,
      row.inventoryMatched
        ? Math.abs(row.reconciliationDifference || 0) <= 1e-9
          ? "정상"
          : "오류"
        : "확인 필요",
    ]);

    return buildTableSheet(XLSX, {
      title: "미출고현황",
      subtitle:
        "배정 기준: 주문현황 Excel 행 순서. 전재고 → 서울 1차 구매잔량 → 추가 구매 필요 순서이며 재고정보가 없는 상품은 구매수량을 확정하지 않습니다.",
      headers,
      rows,
      widths: [9, 13, 13, 15, 31, 13, 11, 12, 15, 12, 16, 12, 16, 14, 20, 14, 14, 12, 24, 24, 22, 14, 15, 12],
      numericColumns: [0, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16],
      priceColumns: [17],
      textColumns: [3],
      statusColumn: 14,
      formulaWriter(sheet, startRow, sourceRows) {
        sourceRows.forEach((row, index) => {
          const zeroBasedRow = startRow + index;
          const excelRow = zeroBasedRow + 1;
          const matched = row[22] !== "재고정보 없음";
          addCachedFormula(
            sheet,
            XLSX,
            zeroBasedRow,
            10,
            `IF(W${excelRow}="재고정보 없음","",MAX(0,I${excelRow}+J${excelRow}))`,
            matched ? row[10] : "",
            matched ? "n" : "s",
          );
          addCachedFormula(
            sheet,
            XLSX,
            zeroBasedRow,
            13,
            `IF(W${excelRow}="재고정보 없음","",MAX(0,G${excelRow}-L${excelRow}-M${excelRow}))`,
            matched ? row[13] : "",
            matched ? "n" : "s",
          );
          addCachedFormula(
            sheet,
            XLSX,
            zeroBasedRow,
            23,
            `IF(W${excelRow}="재고정보 없음","확인 필요",IF(ABS(G${excelRow}-L${excelRow}-M${excelRow}-N${excelRow})<0.000000001,"정상","오류"))`,
            row[23],
            "s",
          );
        });
      },
    });
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

    const allocationStart = 5;
    const allocationEnd = Math.max(allocationStart, workspace.allocations.length + 4);
    const summaryStart = 5;
    const summaryEnd = Math.max(summaryStart, workspace.productSummaries.length + 4);
    const memoStart = 5;
    const memoEnd = Math.max(memoStart, workspace.memoIssues.length + 4);
    const formulaByItem = {
      "상품별 주문수량 대사 차이": {
        formula: `SUM('미출고현황'!$G$${allocationStart}:$G$${allocationEnd})-SUM('상품별요약'!$D$${summaryStart}:$D$${summaryEnd})`,
      },
      "매칭 주문 배정 대사 차이": {
        formula: `SUMIFS('미출고현황'!$G$${allocationStart}:$G$${allocationEnd},'미출고현황'!$W$${allocationStart}:$W$${allocationEnd},"매칭완료")-SUM('미출고현황'!$L$${allocationStart}:$N$${allocationEnd})`,
      },
      "음수 추가 구매 필요": {
        formula: `COUNTIF('미출고현황'!$N$${allocationStart}:$N$${allocationEnd},"<0")`,
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
    XLSX.utils.book_append_sheet(
      workbook,
      buildSourceSheet(workspace.sourceFiles.inventory, XLSX),
      "재고원본",
    );
    return workbook;
  }

  function getOutputFileName(createdAt) {
    return `미출고현황_${localDateStamp(createdAt)}.xlsx`;
  }

  function downloadWorkbook(workspace, XLSX, fileName) {
    requireXlsx(XLSX);
    const workbook = buildWorkbook(workspace, XLSX);
    XLSX.writeFile(workbook, fileName || getOutputFileName(workspace.createdAt), {
      bookType: "xlsx",
      compression: true,
      cellStyles: true,
    });
    return workbook;
  }

  return Object.freeze({
    WORKBOOK_VERSION,
    REQUIRED_SHEETS,
    getOutputFileName,
    buildWorkbook,
    downloadWorkbook,
  });
});
