(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OrderOpsExcelPreparation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "1.0.0";
  const DRAFT_SCHEMA = "orderops-excel-preparation/v1";
  const TEMPLATE_SCHEMA = "orderops-excel-template/v1";
  const KINDS = Object.freeze(["orders", "purchases", "sales", "inventory"]);
  const KIND_LABELS = Object.freeze({ orders: "주문서", purchases: "구매", sales: "판매", inventory: "재고" });
  const EXCLUDE_TARGET = "";
  const WAREHOUSE_TARGET = "warehouseQuantity";
  const WAREHOUSE_PRICE_TARGET = "warehousePrice";
  // These are the existing parser contracts, not a new common required schema.
  const REQUIRED_FIELDS = Object.freeze({
    orders: Object.freeze(["품목코드", "품목명", "규격", "수량", "적요", "적요1", "거래처", "그룹"]),
    inventory: Object.freeze(["품목코드", "품목명", "규격", "수량"]),
    purchases: Object.freeze(["품목코드", "품목명", "수량", "구매처"]),
    sales: Object.freeze(["품목코드", "품목명", "수량", "거래처"]),
  });
  const FIELDS = Object.freeze({
    orders: Object.freeze([...REQUIRED_FIELDS.orders, "일자-No.", "일자", "주문일자", "담당", "창고", "단위", "재고", "단가", "공급가액"]),
    inventory: Object.freeze([...REQUIRED_FIELDS.inventory, "사용", "단위", "재고", "기본", "전송", "창고", WAREHOUSE_TARGET, WAREHOUSE_PRICE_TARGET]),
    purchases: Object.freeze([...REQUIRED_FIELDS.purchases, "규격", "단위"]),
    sales: Object.freeze([...REQUIRED_FIELDS.sales, "규격", "단위"]),
  });
  const FIELD_LABELS = Object.freeze({ [WAREHOUSE_TARGET]: "창고 수량", [WAREHOUSE_PRICE_TARGET]: "창고 단가", [EXCLUDE_TARGET]: "제외" });
  const DEFAULT_ALIASES = {
    orders: {
      "품목코드": ["상품코드", "코드"], "품목명": ["상품명", "제품명"], "수량": ["주문수량", "미출고수량"],
      "창고": ["출고창고"], "단가": ["판매단가", "출고단가"], "공급가액": ["금액", "합계금액"],
      "적요": ["메모", "비고"], "거래처": ["거래처명", "고객명"],
    },
    inventory: {
      "품목코드": ["상품코드", "제품코드", "코드"], "품목명": ["품명", "상품명", "제품명"],
      "규격": ["사양"], "수량": ["재고수량", "합계수량"], "재고": ["현재고", "기말재고"],
    },
    purchases: {
      "품목코드": ["상품코드", "제품코드", "코드"], "품목명": ["품명", "상품명", "제품명"],
      "수량": ["구매수량", "매입수량", "입고수량"], "구매처": ["매입처", "공급처"],
      "규격": ["specification", "spec"], "단위": ["unit"],
    },
    sales: {
      "품목코드": ["상품코드", "제품코드", "코드"], "품목명": ["품명", "상품명", "제품명"],
      "수량": ["판매수량", "매출수량", "출고수량"], "거래처": ["거래처명", "판매처", "고객명"],
      "규격": ["specification", "spec"], "단위": ["unit"],
    },
  };
  const text = (value) => value == null ? "" : String(value);
  const headerKey = (value) => text(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
  const aliasKey = (value) => text(value).replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("ko-KR");
  const issue = (code, message, details = {}) => ({ code, message, ...details });
  function copy(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
  }
  function matrices(input) {
    const raw = input.rawMatrix;
    const display = input.displayMatrix === undefined ? raw : input.displayMatrix;
    if (!Array.isArray(raw) || !Array.isArray(display) || raw.some((row) => !Array.isArray(row)) || display.some((row) => !Array.isArray(row))) {
      return { errors: [issue("INVALID_MATRIX", "원본 raw/표시 행렬을 확인해 주세요.")] };
    }
    if (raw.length !== display.length) return { errors: [issue("MATRIX_ROW_MISMATCH", "원본과 표시 행렬의 행 좌표가 다릅니다.")] };
    return { raw, display, errors: [] };
  }
  function aliasMatches(kind, header, custom = {}) {
    const key = aliasKey(header);
    if (!key) return [];
    return FIELDS[kind].filter((field) => ![WAREHOUSE_TARGET, WAREHOUSE_PRICE_TARGET].includes(field) && [field, ...(DEFAULT_ALIASES[kind][field] || []),
      ...(Array.isArray(custom[field]) ? custom[field] : custom[field] == null ? [] : [custom[field]])].some((alias) => aliasKey(alias) === key));
  }

  function createDraft({ kind, sheetName = "", rawMatrix, displayMatrix, parsed = {}, headerAliases = {} }) {
    if (!KINDS.includes(kind)) throw new TypeError("지원하지 않는 자료 종류입니다.");
    const source = matrices({ rawMatrix, displayMatrix });
    if (source.errors.length) throw new TypeError(source.errors[0].message);
    const headerIndex = Number.isInteger(parsed.headerRowIndex) && parsed.headerRowIndex >= 0 ? parsed.headerRowIndex
      : Number.isInteger(parsed.headerRowNumber) && parsed.headerRowNumber > 0 ? parsed.headerRowNumber - 1 : 0;
    const headers = source.display[headerIndex] || [];
    const width = [source.raw, source.display].reduce((maximum, matrix) => matrix.reduce((size, row) => Math.max(size, row.length), maximum), headers.length);
    const columns = Array.from({ length: width }, (_, sourceIndex) => {
      const sourceHeader = text(headers[sourceIndex]);
      const candidates = aliasMatches(kind, sourceHeader, headerAliases);
      const mapped = (parsed.headerMapping?.columns || []).find((column) => column.columnIndex === sourceIndex);
      const inventory = (parsed.columns || []).find((column) => column.sourceIndex === sourceIndex);
      let target = candidates.length === 1 ? candidates[0] : EXCLUDE_TARGET;
      // Parser metadata is authoritative; warehouse names are never guessed here.
      if (mapped && FIELDS[kind].includes(mapped.canonical)) target = mapped.canonical;
      if (FIELDS[kind].includes(parsed.canonicalHeaders?.[sourceIndex])) target = parsed.canonicalHeaders[sourceIndex];
      if (kind === "inventory" && inventory) {
        const roles = { productCode: "품목코드", productName: "품목명", specification: "규격", unit: "단위", calculatedQuantity: "수량", warehousePrice: candidates.includes("창고") ? "창고" : WAREHOUSE_PRICE_TARGET, warehouseQuantity: WAREHOUSE_TARGET };
        if (roles[inventory.role]) target = roles[inventory.role];
      }
      if (candidates.length > 1) target = EXCLUDE_TARGET;
      return { sourceIndex, sourceHeader, target, enabled: Boolean(target) };
    });
    return {
      schemaVersion: DRAFT_SCHEMA, kind, sheetName: text(sheetName || parsed.sheetName), headerRow: headerIndex + 1,
      startRow: headerIndex + 2, endRow: source.raw.length, rowCount: source.raw.length, columns,
      sourceMetadata: { fileName: text(parsed.fileName), fileHash: text(parsed.fileHash), sheetName: text(sheetName || parsed.sheetName) },
    };
  }

  function validateDraft({ draft, rawMatrix, displayMatrix } = {}) {
    const errors = [];
    if (!draft || draft.schemaVersion !== DRAFT_SCHEMA || !KINDS.includes(draft.kind)) {
      return { ok: false, errors: [issue("INVALID_DRAFT", "매핑 초안의 종류와 형식을 확인해 주세요.")] };
    }
    let rowCount = draft.rowCount;
    let source;
    if (rawMatrix !== undefined || displayMatrix !== undefined) {
      source = matrices({ rawMatrix, displayMatrix });
      errors.push(...source.errors);
      if (!source.errors.length) rowCount = source.raw.length;
    }
    const { headerRow, startRow, endRow } = draft;
    if (![rowCount, headerRow, startRow, endRow].every(Number.isInteger) || headerRow < 1 || startRow <= headerRow || endRow < startRow || endRow > rowCount) {
      errors.push(issue("INVALID_ROW_RANGE", "항목명 행 뒤의 자료 시작·끝 행을 원본 범위 안에서 지정해 주세요."));
    }
    if (!Array.isArray(draft.columns) || !draft.columns.length) return { ok: false, errors: [...errors, issue("NO_COLUMNS", "연결할 원본 열이 없습니다.")] };
    const indices = new Set();
    const targets = new Map();
    const warehouses = new Set();
    const warehousePrices = new Set();
    for (const column of draft.columns) {
      const { sourceIndex, sourceHeader, target, enabled } = column || {};
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= draft.columns.length || indices.has(sourceIndex)) {
        errors.push(issue("INVALID_SOURCE_COLUMN", "원본 열 위치가 없거나 중복되었습니다.", { sourceIndex }));
        continue;
      }
      indices.add(sourceIndex);
      if (source && !source.errors.length && text(source.display[headerRow - 1]?.[sourceIndex]) !== sourceHeader) {
        errors.push(issue("SOURCE_HEADER_CHANGED", "항목명 행이나 원본 열이 변경되었습니다. 열 연결을 다시 확인해 주세요.", { sourceIndex }));
      }
      if (!enabled || target === EXCLUDE_TARGET) continue;
      if (!FIELDS[draft.kind].includes(target)) {
        errors.push(issue("INVALID_TARGET", "현재 자료 종류에서 지원하지 않는 작업 항목입니다.", { sourceIndex, target }));
        continue;
      }
      if (target === WAREHOUSE_TARGET || target === WAREHOUSE_PRICE_TARGET) {
        const names = target === WAREHOUSE_TARGET ? warehouses : warehousePrices;
        const name = headerKey(target === WAREHOUSE_TARGET ? column.warehouseName ?? sourceHeader : sourceHeader);
        if (!name || names.has(name)) errors.push(issue(target === WAREHOUSE_TARGET ? "AMBIGUOUS_WAREHOUSE" : "AMBIGUOUS_WAREHOUSE_PRICE", "창고 수량·단가 열의 이름이 없거나 중복되었습니다.", { sourceIndex }));
        names.add(name);
      } else {
        if (targets.has(target)) errors.push(issue("DUPLICATE_TARGET", `같은 작업 항목이 여러 열에 연결되었습니다: ${target}`, { target, sourceIndices: [targets.get(target), sourceIndex] }));
        targets.set(target, sourceIndex);
      }
    }
    REQUIRED_FIELDS[draft.kind].forEach((target) => {
      if (!targets.has(target)) errors.push(issue("MISSING_REQUIRED_FIELD", `필수 항목을 연결해 주세요: ${target}`, { target }));
    });
    if (draft.kind === "inventory" && !warehouses.size) errors.push(issue("MISSING_WAREHOUSE", "창고 수량 열을 하나 이상 연결해 주세요."));
    return { ok: errors.length === 0, errors };
  }

  function applyDraft({ rawMatrix, displayMatrix, draft } = {}) {
    const source = matrices({ rawMatrix, displayMatrix });
    if (source.errors.length) return { ok: false, errors: source.errors };
    const validation = validateDraft({ draft, rawMatrix, displayMatrix });
    if (!validation.ok) return validation;
    const columns = copy(draft.columns);
    const mappedHeader = Array.from({ length: Math.max(...columns.map((column) => column.sourceIndex)) + 1 }, () => "");
    for (const column of columns) {
      if (!column.enabled || !column.target) continue;
      mappedHeader[column.sourceIndex] = column.target === WAREHOUSE_TARGET ? text(column.warehouseName ?? column.sourceHeader)
        : column.target === WAREHOUSE_PRICE_TARGET ? column.sourceHeader : column.target;
    }
    const prepare = (matrix) => matrix.map((row, index) => index === draft.headerRow - 1 ? mappedHeader.slice()
      : index + 1 >= draft.startRow && index + 1 <= draft.endRow ? copy(row) : []);
    return {
      ok: true, errors: [], rawMatrix: prepare(source.raw), displayMatrix: prepare(source.display),
      originalRawMatrix: copy(source.raw), originalDisplayMatrix: copy(source.display), columns,
      sourceMetadata: { ...copy(draft.sourceMetadata), kind: draft.kind, sheetName: draft.sheetName,
        headerRow: draft.headerRow, startRow: draft.startRow, endRow: draft.endRow,
        sourceRowNumbers: Array.from({ length: draft.endRow - draft.startRow + 1 }, (_, offset) => draft.startRow + offset), columns: copy(columns) },
    };
  }

  function createTemplate({ name, draft } = {}) {
    const validation = validateDraft({ draft });
    if (!validation.ok) return validation;
    if (!text(name).trim()) return { ok: false, errors: [issue("TEMPLATE_NAME_REQUIRED", "양식명을 입력해 주세요.")] };
    const keys = draft.columns.map((column) => headerKey(column.sourceHeader));
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
      return { ok: false, errors: [issue("AMBIGUOUS_TEMPLATE_HEADERS", "같은 이름 또는 이름 없는 열은 새 파일에 자동 연결할 수 없습니다.")] };
    }
    return { ok: true, errors: [], template: { schemaVersion: TEMPLATE_SCHEMA, name: text(name).trim(), kind: draft.kind,
      sheetName: draft.sheetName, headerRow: draft.headerRow, startOffset: draft.startRow - draft.headerRow,
      endRow: draft.endRow === draft.rowCount ? null : draft.endRow, columns: copy(draft.columns) } };
  }

  function matchTemplate({ template, kind, sheetName = "", rawMatrix, displayMatrix, parsed = {} } = {}) {
    if (template?.schemaVersion !== TEMPLATE_SCHEMA || !KINDS.includes(kind) || template.kind !== kind || !Array.isArray(template.columns)
      || template.columns.some((column) => !column || typeof column.sourceHeader !== "string")) {
      return { ok: false, errors: [issue("TEMPLATE_KIND_MISMATCH", "양식의 자료 종류와 형식을 확인해 주세요.")] };
    }
    const source = matrices({ rawMatrix, displayMatrix });
    if (source.errors.length) return { ok: false, errors: source.errors };
    const keys = template.columns.map((column) => headerKey(column.sourceHeader));
    if (!keys.length || keys.some((key) => !key) || new Set(keys).size !== keys.length) {
      return { ok: false, errors: [issue("AMBIGUOUS_TEMPLATE_HEADERS", "양식의 원본 열 이름이 모호합니다.")] };
    }
    const candidates = [];
    source.display.forEach((row, index) => {
      const actual = row.map(headerKey);
      if (actual.length === keys.length && new Set(actual).size === actual.length && keys.every((key) => actual.includes(key))) candidates.push(index);
    });
    if (candidates.length !== 1) return { ok: false, errors: [issue(candidates.length ? "AMBIGUOUS_HEADER_ROWS" : "TEMPLATE_STRUCTURE_MISMATCH", "양식과 유일하게 일치하는 항목명 행을 확인해 주세요.")] };
    const headerIndex = candidates[0];
    const headers = source.display[headerIndex];
    const draft = createDraft({ kind, sheetName, rawMatrix, displayMatrix, parsed: { ...parsed, headerRowIndex: headerIndex } });
    draft.startRow = draft.headerRow + template.startOffset;
    draft.endRow = template.endRow === null ? source.raw.length : template.endRow + draft.headerRow - template.headerRow;
    draft.columns = template.columns.map((column) => {
      const sourceIndex = headers.findIndex((header) => headerKey(header) === headerKey(column.sourceHeader));
      return { ...copy(column), sourceIndex, sourceHeader: text(headers[sourceIndex]) };
    }).sort((a, b) => a.sourceIndex - b.sourceIndex);
    const validation = validateDraft({ draft, rawMatrix, displayMatrix });
    return validation.ok ? { ...validation, draft } : validation;
  }

  return Object.freeze({ VERSION, DRAFT_SCHEMA, TEMPLATE_SCHEMA, KINDS, KIND_LABELS, FIELDS, FIELD_LABELS,
    REQUIRED_FIELDS, EXCLUDE_TARGET, WAREHOUSE_TARGET, WAREHOUSE_PRICE_TARGET, createDraft, validateDraft, applyDraft, createTemplate, matchTemplate });
});
