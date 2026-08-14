import { normalizeText } from '../orderq-db.js';
import { normalizeWarehouseCode } from '../warehouse-master.js';

export const COLLECTOR_SOURCE = Object.freeze({
  ORDER: 'ORDER_HISTORY',
  SALES: 'SALES_HISTORY',
  PURCHASE: 'PURCHASE_HISTORY',
  INVENTORY: 'INVENTORY_HISTORY',
  CUSTOMER_LEDGER: 'CUSTOMER_LEDGER',
  KAKAO: 'KAKAO_HISTORY'
});

export const SOURCE_LABEL = Object.freeze({
  [COLLECTOR_SOURCE.ORDER]: '주문현황',
  [COLLECTOR_SOURCE.SALES]: '판매현황',
  [COLLECTOR_SOURCE.PURCHASE]: '구매현황',
  [COLLECTOR_SOURCE.INVENTORY]: '재고현황',
  [COLLECTOR_SOURCE.CUSTOMER_LEDGER]: '거래처원장',
  [COLLECTOR_SOURCE.KAKAO]: '카카오 이력'
});

const DEFINITIONS = Object.freeze({
  [COLLECTOR_SOURCE.ORDER]: {
    sheetHints: ['미판매현황', '미출고현황', '주문현황', '주문'],
    required: ['orderDate', 'customerName', 'productName', 'quantity'],
    fields: {
      orderDate: ['일자', '주문일', '주문일자', '날짜'],
      orderTime: ['주문시간', '시간', '접수시간', '주문일시'],
      managerName: ['담당', '담당자'],
      unit: ['단위'],
      productCode: ['품목코드', '상품코드', '코드'],
      productName: ['품목명', '상품명', '품명'],
      specification: ['규격'],
      quantity: ['수량', '주문수량', '주문'],
      stockQuantity: ['재고', '재고수량'],
      unitPrice: ['단가', '판매단가'],
      note: ['적요', '전달사항'],
      note2: ['적요1', '전달사항1'],
      customerName: ['거래처', '거래처명', '고객명'],
      warehouseName: ['창고', '출하창고'],
      groupName: ['그룹', '배송그룹'],
      documentNo: ['전표번호', '주문번호', 'no.', 'no']
    }
  },
  [COLLECTOR_SOURCE.SALES]: {
    sheetHints: ['판매현황', '판매현황내역', '판매내역', '매출현황'],
    required: ['salesDate', 'customerName', 'productCode', 'quantity'],
    fields: {
      salesDate: ['일자', '판매일', '판매일자', '출고일', '날짜'],
      salesTime: ['판매시간', '출고시간', '시간', '판매일시'],
      warehouseCode: ['창고코드', '창고'],
      customerName: ['거래처명', '거래처', '고객명'],
      documentNo: ['no.', 'no', '전표번호', '판매번호'],
      productCode: ['품목코드', '상품코드', '코드'],
      productName: ['품명', '품목명', '상품명'],
      specification: ['규격'],
      quantity: ['수량', '판매수량', '출고수량'],
      unitPrice: ['단가', '판매단가'],
      amount: ['공급가', '합계', '금액', '판매합계'],
      note: ['적요', '비고'],
      shippingInstruction: ['출고지시'],
      purchasePlace: ['구매처', '매입처']
    }
  },
  [COLLECTOR_SOURCE.PURCHASE]: {
    sheetHints: ['구매현황', '구매현황내역', '구매내역', '매입현황'],
    required: ['purchaseDate', 'supplierName', 'productCode', 'quantity'],
    fields: {
      purchaseDate: ['일자', '구매일', '매입일', '날짜'],
      purchaseTime: ['구매시간', '매입시간', '시간', '구매일시'],
      supplierName: ['거래처명', '거래처', '공급처', '매입처'],
      warehouseCode: ['창고코드', '창고'],
      documentNo: ['전표번호', '구매번호', 'no.', 'no'],
      productCode: ['코드', '품목코드', '상품코드'],
      productName: ['품명', '품목명', '상품명'],
      specification: ['규격'],
      quantity: ['수량', '구매수량', '입고수량'],
      unitPrice: ['단가', '구매단가', '매입단가'],
      amount: ['합계', '금액', '구매합계'],
      note: ['적요', '비고'],
      purchaseFor: ['구매처', '납품처']
    }
  },
  [COLLECTOR_SOURCE.INVENTORY]: {
    sheetHints: ['전체재고', '재고현황', '창고별재고', '실사양식'],
    required: ['productCode', 'productName', 'inventoryQuantity'],
    fields: {
      basisDate: ['일자', '기준일', '결산일자', '날짜'],
      warehouseCode: ['창고', '창고코드'],
      unit: ['단위'],
      productCode: ['품목코드', '상품코드', '코드'],
      productName: ['품명', '품목명', '상품명', '상품명(규격)'],
      specification: ['규격'],
      inventoryQuantity: ['재고', '수량', '기말실사(이월수량)', '마감잔량'],
      recordedDate: ['기록', '구매일'],
      supplierName: ['거래', '구매처', '매입처(lot)', '매입처'],
      unitCost: ['구매가', '원가', '매입단가(원가)'],
      note: ['적요', '수기메모', '비고']
    }
  },
  [COLLECTOR_SOURCE.CUSTOMER_LEDGER]: {
    sheetHints: ['거래처원장', '거래처별원장', '원장'],
    required: ['transactionDate', 'customerName', 'productName', 'quantity'],
    fields: {
      transactionDate: ['일자', '거래일', '전표일자', '날짜'],
      documentNo: ['전표번호', 'no.', 'no'],
      customerName: ['거래처명', '거래처', '고객명'],
      transactionType: ['구분', '유형', '거래구분'],
      productCode: ['품목코드', '상품코드', '코드'],
      productName: ['품명', '품목명', '상품명'],
      specification: ['규격'],
      quantity: ['수량'],
      unitPrice: ['단가'],
      amount: ['합계', '금액', '공급가'],
      note: ['적요', '비고']
    }
  }
});

export function normalizeHeader(value) {
  return normalizeText(value).replace(/[()\[\]{}._\-\/\\]/g, '');
}

function aliasLookup(definition) {
  const lookup = new Map();
  Object.entries(definition.fields).forEach(([field, aliases]) => {
    aliases.forEach(alias => lookup.set(normalizeHeader(alias), field));
  });
  return lookup;
}

export function detectHeaderRow(matrix, maxRows = 12) {
  let best = { rowIndex: -1, score: 0, populated: 0 };
  const limit = Math.min(maxRows, Array.isArray(matrix) ? matrix.length : 0);
  for (let rowIndex = 0; rowIndex < limit; rowIndex++) {
    const row = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    const headers = new Set(row.map(normalizeHeader).filter(Boolean));
    let score = 0;
    Object.values(DEFINITIONS).forEach(definition => {
      const lookup = aliasLookup(definition);
      headers.forEach(header => { if (lookup.has(header)) score += 1; });
    });
    if (score > best.score || (score === best.score && headers.size > best.populated)) {
      best = { rowIndex, score, populated: headers.size };
    }
  }
  return best;
}

function scoreDefinition(definition, sheetName, headers) {
  const lookup = aliasLookup(definition);
  const mapped = new Set();
  headers.forEach(header => {
    const field = lookup.get(header);
    if (field) mapped.add(field);
  });
  const missing = definition.required.filter(field => !mapped.has(field));
  const hint = definition.sheetHints.some(value => normalizeHeader(sheetName).includes(normalizeHeader(value)));
  return {
    score: mapped.size * 4 + (definition.required.length - missing.length) * 8 + (hint ? 18 : 0),
    mappedFields: [...mapped],
    missing,
    hint
  };
}

export function classifyMatrix(matrix, sheetName = '', fileName = '') {
  const header = detectHeaderRow(matrix);
  if (header.rowIndex < 0) return { sourceType: '', confidence: 0, reason: '헤더를 찾지 못했습니다.' };
  const rawHeaders = (matrix[header.rowIndex] || []).map(value => String(value ?? '').trim());
  const headers = rawHeaders.map(normalizeHeader);
  const candidates = Object.entries(DEFINITIONS).map(([sourceType, definition]) => ({
    sourceType,
    ...scoreDefinition(definition, sheetName, headers)
  })).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const next = candidates[1];
  if (!best || best.missing.length) {
    return { sourceType: '', confidence: 0, headerRowIndex: header.rowIndex, rawHeaders, candidates, reason: `필수 열 부족: ${(best?.missing || []).join(', ')}` };
  }
  const confidence = Math.max(0, Math.min(100, 55 + best.mappedFields.length * 4 + (best.hint ? 12 : 0) - (best.score === next?.score ? 20 : 0)));
  return { ...best, confidence, headerRowIndex: header.rowIndex, rawHeaders, candidates, fileName, sheetName };
}

function columnMapFor(sourceType, rawHeaders) {
  const definition = DEFINITIONS[sourceType];
  const lookup = aliasLookup(definition);
  const map = {};
  rawHeaders.forEach((header, index) => {
    const field = lookup.get(normalizeHeader(header));
    if (field && map[field] === undefined) map[field] = index;
  });
  return map;
}

export function excelDateToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 90000) {
    const utc = Math.round((value - 25569) * 86400 * 1000);
    return new Date(utc).toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
  if (!match) return '';
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

export function numericValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

export function mapMatrixRows(matrix, classification) {
  const { sourceType, headerRowIndex, rawHeaders } = classification;
  const columns = columnMapFor(sourceType, rawHeaders);
  const dateFields = new Set(['orderDate', 'salesDate', 'purchaseDate', 'basisDate', 'transactionDate', 'recordedDate']);
  const numberFields = new Set(['quantity', 'stockQuantity', 'inventoryQuantity', 'unitPrice', 'unitCost', 'amount']);
  const rows = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex++) {
    const sourceRow = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
    if (!sourceRow.some(value => String(value ?? '').trim())) continue;
    const normalized = {};
    Object.entries(columns).forEach(([field, index]) => {
      const value = sourceRow[index];
      if (dateFields.has(field)) normalized[field] = excelDateToIso(value);
      else if (numberFields.has(field)) normalized[field] = numericValue(value);
      else normalized[field] = String(value ?? '').trim();
    });
    rows.push({
      rowNo: rowIndex + 1,
      rawValues: [...sourceRow],
      rawRecord: Object.fromEntries(rawHeaders.map((header, index) => [header || `COL_${index + 1}`, sourceRow[index] ?? ''])),
      normalizedRecord: normalized
    });
  }
  return { columns, rows };
}

export function inventoryWarehouseColumns(classification) {
  if (classification?.sourceType !== COLLECTOR_SOURCE.INVENTORY) return [];
  return (classification.rawHeaders || []).map((header, index) => {
    const text = String(header ?? '').normalize('NFKC').trim();
    const match = text.match(/^0*(\d+)\s*([^\d].*)$/);
    if (!match) return null;
    return {
      index,
      warehouseCode: normalizeWarehouseCode(match[1]),
      warehouseName: text,
      sourceHeader: text
    };
  }).filter(Boolean);
}

export function expandInventoryWarehouseRows(rows, classification) {
  const warehouseColumns = inventoryWarehouseColumns(classification);
  if (!warehouseColumns.length) return { rows, warehouseColumns, discrepancies: [] };
  const expanded = [];
  const discrepancies = [];
  (rows || []).forEach(row => {
    const normalized = row.normalizedRecord || {};
    if (!String(normalized.productCode || normalized.productName || '').trim()) return;
    const inventoryTotal = normalized.inventoryQuantity;
    let warehouseSum = 0;
    warehouseColumns.forEach((column, offset) => {
      const rawValue = row.rawValues?.[column.index] ?? row.rawRecord?.[column.sourceHeader] ?? '';
      const parsed = numericValue(rawValue);
      const inventoryQuantity = parsed ?? 0;
      warehouseSum += inventoryQuantity;
      expanded.push({
        ...row,
        rowNo: row.rowNo * 1000 + offset + 1,
        sourceRowNo: row.rowNo,
        warehouseColumnIndex: column.index,
        normalizedRecord: {
          ...normalized,
          warehouseCode: column.warehouseCode,
          warehouseName: column.warehouseName,
          inventoryTotal,
          inventoryQuantity,
          warehouseSourceHeader: column.sourceHeader,
          warehouseSourceBlank: parsed === null
        }
      });
    });
    if (inventoryTotal !== null && inventoryTotal !== undefined && Number.isFinite(Number(inventoryTotal))
      && Math.abs(Number(inventoryTotal) - warehouseSum) > 1e-9) {
      discrepancies.push({
        rowNo: row.rowNo,
        productCode: String(normalized.productCode || ''),
        inventoryTotal: Number(inventoryTotal),
        warehouseSum
      });
    }
  });
  return { rows: expanded, warehouseColumns, discrepancies };
}

export function sourceDefinition(sourceType) {
  return DEFINITIONS[sourceType] || null;
}
