import {
  classifyMatrix,
  mapMatrixRows,
  expandInventoryWarehouseRows,
  COLLECTOR_SOURCE,
  excelDateToIso
} from './collector-schema.js?v=0.8.0';
import { parseOrderLines } from '../smartparser/order-line-parser.js?v=0.8.0';
import { detectOrderEvent, EVENT_TYPE } from '../smartparser/order-event-detector.js?v=0.8.0';
import { createSourceMessageKey, normalizeSourceText } from '../smartparser/source-parser.js?v=0.8.0';

export async function sha256File(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function matrixContextDate(matrix, fileName) {
  const candidates = [];
  const dates = [];
  const addDate = (year, month, day) => {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return;
    dates.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  };
  (matrix || []).slice(0, 4).forEach(row => (row || []).forEach(value => candidates.push(String(value ?? ''))));
  candidates.push(String(fileName || ''));
  for (const value of candidates) {
    const iso = excelDateToIso(value);
    if (iso) dates.push(iso);
    for (const match of value.matchAll(/(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/g)) {
      addDate(match[1], match[2], match[3]);
    }
    const compact = value.match(/(20\d{2})(\d{2})(\d{2})/);
    if (compact) addDate(compact[1], compact[2], compact[3]);
    if (!/20\d{2}/.test(value)) {
      const short = value.match(/(?:^|\D)(\d{2})(\d{2})(?:\D|$)/);
      if (short) addDate(new Date().getFullYear(), short[1], short[2]);
    }
  }
  return [...new Set(dates)].sort().at(-1) || '';
}

function matrixContextWarehouse(matrix) {
  for (const row of (matrix || []).slice(0, 3)) {
    for (const value of row || []) {
      const match = String(value ?? '').match(/(?:^|\/|\s)(\d+)\s*창고/);
      if (match) return match[1].padStart(2, '0');
    }
  }
  return '';
}

function sheetPriority(sourceType, sheetName) {
  const normalized = String(sheetName || '').replace(/\s+/g, '');
  if (sourceType === COLLECTOR_SOURCE.INVENTORY && normalized === '전체재고') return 30;
  if (sourceType === COLLECTOR_SOURCE.SALES && /판매현황(?:내역)?/.test(normalized)) return 25;
  if (sourceType === COLLECTOR_SOURCE.PURCHASE && /구매현황(?:내역)?/.test(normalized)) return 25;
  if (sourceType === COLLECTOR_SOURCE.ORDER && /(미판매|미출고|주문)현황/.test(normalized)) return 25;
  if (sourceType === COLLECTOR_SOURCE.CUSTOMER_LEDGER && /원장/.test(normalized)) return 25;
  return 0;
}

export async function analyzeExcelFile(file, XLSX) {
  if (!XLSX) throw new Error('Excel 읽기 라이브러리를 불러오지 못했습니다.');
  const bytes = await file.arrayBuffer();
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true, cellNF: true, cellText: true });
  const candidates = workbook.SheetNames.map(sheetName => {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true });
    const classification = classifyMatrix(matrix, sheetName, file.name);
    return { sheetName, matrix, classification, priority: sheetPriority(classification.sourceType, sheetName) };
  }).filter(row => row.classification.sourceType);
  if (!candidates.length) throw new Error(`${file.name}: 주문·판매·구매·재고·거래처원장 구조를 판별하지 못했습니다.`);
  candidates.sort((a, b) => (b.classification.score + b.priority) - (a.classification.score + a.priority) || b.matrix.length - a.matrix.length);
  const selected = candidates[0];
  const mapped = mapMatrixRows(selected.matrix, selected.classification);
  const inventoryLayout = selected.classification.sourceType === COLLECTOR_SOURCE.INVENTORY
    ? expandInventoryWarehouseRows(mapped.rows, selected.classification)
    : { rows: mapped.rows, warehouseColumns: [], discrepancies: [] };
  const preparedRows = inventoryLayout.rows;
  const defaultDate = matrixContextDate(selected.matrix, file.name);
  const defaultWarehouseCode = matrixContextWarehouse(selected.matrix);
  preparedRows.forEach(row => {
    const record = row.normalizedRecord;
    if (!record.orderDate && selected.classification.sourceType === COLLECTOR_SOURCE.ORDER) record.orderDate = defaultDate;
    if (!record.salesDate && selected.classification.sourceType === COLLECTOR_SOURCE.SALES) record.salesDate = defaultDate;
    if (!record.purchaseDate && selected.classification.sourceType === COLLECTOR_SOURCE.PURCHASE) record.purchaseDate = defaultDate;
    if (!record.basisDate && selected.classification.sourceType === COLLECTOR_SOURCE.INVENTORY) record.basisDate = defaultDate;
    if (!record.transactionDate && selected.classification.sourceType === COLLECTOR_SOURCE.CUSTOMER_LEDGER) record.transactionDate = defaultDate;
    if (!record.warehouseCode && defaultWarehouseCode) record.warehouseCode = defaultWarehouseCode;
  });
  const warnings = [];
  if (inventoryLayout.warehouseColumns.length) {
    warnings.push(`창고별재고 ${inventoryLayout.warehouseColumns.length}개 열을 품목코드별 창고 잔량으로 분리했습니다.`);
  }
  if (inventoryLayout.discrepancies.length) {
    warnings.push(`총재고와 창고별 합계가 다른 품목 ${inventoryLayout.discrepancies.length}건을 확인하세요.`);
  }
  if (!defaultDate && [COLLECTOR_SOURCE.ORDER, COLLECTOR_SOURCE.SALES, COLLECTOR_SOURCE.PURCHASE, COLLECTOR_SOURCE.INVENTORY].includes(selected.classification.sourceType)) warnings.push('기준일을 찾지 못했습니다. 날짜가 없는 행은 연결 후보에서 제외됩니다.');
  if (selected.classification.sourceType === COLLECTOR_SOURCE.ORDER && mapped.rows.some(row => !row.normalizedRecord.orderTime)) warnings.push('주문시각이 없는 행은 당일 오전 추가주문으로 자동 확정하지 않습니다.');
  if (selected.classification.sourceType === COLLECTOR_SOURCE.SALES && mapped.rows.some(row => Number(row.normalizedRecord.quantity || 0) < 0)) warnings.push('음수 판매는 반품·결품·취소 보정으로 분리합니다.');
  return {
    sourceType: selected.classification.sourceType,
    fileName: file.name,
    fileSize: file.size,
    fileHash: await sha256File(file),
    sheetName: selected.sheetName,
    headerRowNo: selected.classification.headerRowIndex + 1,
    confidence: selected.classification.confidence,
    defaultDate,
    defaultWarehouseCode,
    warehouseColumns: inventoryLayout.warehouseColumns,
    inventoryDiscrepancies: inventoryLayout.discrepancies,
    rows: preparedRows,
    warnings,
    ignoredSheets: candidates.slice(1).map(row => row.sheetName)
  };
}

function parseKoreanDate(value) {
  const match = String(value || '').match(/(20\d{2})\s*[.년\/-]\s*(\d{1,2})\s*[.월\/-]\s*(\d{1,2})/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : '';
}

function parseTime(value) {
  const match = String(value || '').match(/(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (!match) return '';
  let hour = Number(match[2]);
  if (match[1] === '오후' && hour < 12) hour += 12;
  if (match[1] === '오전' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[3]}`;
}

export async function analyzeHistoricalText({ rawText, fileName = '카카오 이력.txt', sourceId = '', defaultDate = '' }) {
  const normalized = normalizeSourceText(rawText);
  if (!normalized) throw new Error('수집할 카카오/일반 텍스트가 없습니다.');
  const rows = [];
  const lines = normalized.split('\n');
  let currentDate = defaultDate;
  let current = null;
  const messages = [];
  const flush = () => {
    if (!current) return;
    current.rawText = current.lines.join('\n').trim();
    if (current.rawText) messages.push(current);
    current = null;
  };
  lines.forEach(line => {
    const date = parseKoreanDate(line);
    if (date && !/^\[/.test(line.trim())) { flush(); currentDate = date; return; }
    const header = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
    if (header) {
      flush();
      current = { senderRaw: header[1].trim(), timestampRaw: header[2].trim(), lines: [header[3]], orderDate: currentDate };
    } else if (current) current.lines.push(line);
    else if (line.trim()) current = { senderRaw: '', timestampRaw: '', lines: [line], orderDate: currentDate };
  });
  flush();
  messages.forEach((message, messageIndex) => {
    const event = detectOrderEvent(message.rawText);
    if (![EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE].includes(event.eventType)) return;
    const sourceMessageKey = createSourceMessageKey({ sourceType: 'KAKAO_TEXT', sourceId, senderRaw: message.senderRaw, timestampRaw: message.timestampRaw, rawText: message.rawText });
    parseOrderLines(message.rawText).forEach((line, lineIndex) => {
      if (!line.quantity || line.quantity <= 0) return;
      rows.push({
        rowNo: messageIndex * 100 + lineIndex + 1,
        rawRecord: { sender: message.senderRaw, timestamp: message.timestampRaw, message: message.rawText, line: line.rawText },
        normalizedRecord: {
          orderDate: message.orderDate || defaultDate,
          orderTime: parseTime(message.timestampRaw),
          customerName: message.senderRaw,
          sourceMessageKey,
          documentNo: sourceMessageKey,
          productName: line.productText,
          // SmartParser의 불변 원문 계약은 rawText다. productText가 비어도 원문은 절대 잃지 않는다.
          rawExpression: line.rawText,
          specification: line.specText,
          quantity: line.quantity,
          rawUnit: line.rawUnit,
          unit: line.rawUnit,
          note: line.attributeText,
          createdAt: message.orderDate && parseTime(message.timestampRaw) ? `${message.orderDate}T${parseTime(message.timestampRaw)}:00+09:00` : ''
        }
      });
    });
  });
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fileHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return {
    sourceType: COLLECTOR_SOURCE.KAKAO, fileName, fileSize: bytes.length, fileHash, sheetName: 'TEXT', headerRowNo: 0,
    confidence: rows.some(row => row.normalizedRecord.orderDate) ? 90 : 65, defaultDate, rows,
    warnings: rows.some(row => !row.normalizedRecord.orderDate) ? ['날짜가 없는 메시지는 판매일 연결을 자동 확정하지 않습니다.'] : [],
    ignoredSheets: []
  };
}
