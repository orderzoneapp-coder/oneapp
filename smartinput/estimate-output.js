const SHOP_HEADERS = Object.freeze([
  '상품코드\n코드', '상품명', '규격', '출고가', '도매A', '시중가', 'B판매가', '도매B',
  'C 판매가', 'C 도매가', 'D 판매가', 'D 도매가', '브랜드', '기본설명', '판매여부',
  '재고수량', '테마1', '테마2', '테마3', '테마4', '테마5', '상품태그'
]);
const ERP_HEADERS = Object.freeze(['품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n']);
const ERROR_HEADERS = Object.freeze(['행', '품목', '필드', '원본값', '오류내용', '관리자 판단 안내']);
export const KAKAO_NOTICE_ROWS_PER_PAGE = 40;

export function paginateKakaoNoticeRows(rows = [], maxRowsPerPage = KAKAO_NOTICE_ROWS_PER_PAGE) {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) return [[]];
  const maximum = Math.max(1, Math.min(KAKAO_NOTICE_ROWS_PER_PAGE, Math.floor(Number(maxRowsPerPage)) || KAKAO_NOTICE_ROWS_PER_PAGE));
  return Array.from({ length: Math.ceil(source.length / maximum) }, (_, pageIndex) => source.slice(pageIndex * maximum, (pageIndex + 1) * maximum));
}

export function splitKakaoNoticeColumns(rows = []) {
  const source = Array.isArray(rows) ? rows.slice(0, KAKAO_NOTICE_ROWS_PER_PAGE) : [];
  return source.length <= 20 ? [source] : [source.slice(0, 20), source.slice(20)];
}

function text(value) {
  return String(value ?? '').trim();
}

function numeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,원₩]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceNumber(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const parsed = numeric(value);
  return parsed === null ? String(value) : parsed;
}

function unitPriceSource(row = {}) {
  return Object.prototype.hasOwnProperty.call(row, 'sourceUnitPrice') && row.sourceUnitPrice !== null
    ? row.sourceUnitPrice
    : row.unitPrice;
}

function itemLabel(row = {}) {
  return [text(row.itemCode), text(row.itemName)].filter(Boolean).join(' · ') || '품목 확인 필요';
}

function estimateIssue(code, row, rowIndex, field, originalValue, message, guide) {
  return { code, rowIndex, item: itemLabel(row), field, originalValue, message, guide };
}

function issueDataRow(issue = {}) {
  return [
    Number.isInteger(issue.rowIndex) ? issue.rowIndex + 1 : '',
    issue.item || '',
    issue.field || '',
    issue.originalValue ?? '',
    issue.message || '',
    issue.guide || '오류 정보를 확인한 뒤 관리자가 업로드 여부를 판단하세요.'
  ];
}

function priceKey(row = {}, index = 0) {
  const masterId = text(row.masterProductId);
  if (masterId) return `MASTER:${masterId}`;
  const code = text(row.itemCode);
  return code ? `CODE:${code}` : `ROW:${index}`;
}

export function buildCatalogPriceSnapshot(rows = [], priceFieldId = 'noticePrice') {
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row, index) => [
    priceKey(row, index),
    numeric(row?.[priceFieldId]) ?? 0
  ]));
}

export function priceSnapshotsEqual(left = {}, right = {}) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Number(left[key]) === Number(right[key]));
}

function normalizeNoticePriceFields(priceFields = []) {
  const normalized = (Array.isArray(priceFields) ? priceFields : []).map(field => ({
    id: text(typeof field === 'string' ? field : field?.id),
    label: text(typeof field === 'string' ? field : field?.label)
  })).filter(field => field.id).filter((field, index, fields) => fields.findIndex(other => other.id === field.id) === index).slice(0, 2);
  return normalized.length ? normalized : [{ id: 'noticePrice', label: '공지단가' }];
}

export function buildKakaoNoticeRows(rows = [], previousPrices = {}, priceFields = []) {
  const selectedPriceFields = normalizeNoticePriceFields(priceFields);
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const prices = selectedPriceFields.map(field => ({
      fieldId: field.id,
      label: field.label || field.id,
      value: numeric(row?.[field.id]) ?? 0
    }));
    const currentPrice = prices[0].value;
    const key = priceKey(row, index);
    const hasPrevious = Object.prototype.hasOwnProperty.call(previousPrices || {}, key);
    const previousPrice = hasPrevious ? numeric(previousPrices[key]) : null;
    return {
      key,
      itemCode: text(row.itemCode),
      nameSpec: [text(row.itemName), text(row.specification)].filter(Boolean).join(' · '),
      prices,
      price: currentPrice,
      change: previousPrice === null ? null : currentPrice - previousPrice,
      note: text(row.memo)
    };
  }).filter(row => row.itemCode || row.nameSpec);
}

export function validateEstimateRows(rows = []) {
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => text(row.itemCode) || text(row.itemName));
  const errors = [];
  if (!candidates.length) errors.push({
    code: 'EMPTY', rowIndex: null, item: '', field: '품목', originalValue: '',
    message: '출력할 견적 품목이 없습니다.',
    guide: '견적 품목을 추가한 뒤 다시 출력하세요.'
  });
  const codeCounts = new Map();
  candidates.forEach(({ row, rowIndex }) => {
    const code = text(row.itemCode);
    if (!code) errors.push(estimateIssue(
      'ITEM_CODE_REQUIRED', row, rowIndex, '품목코드', row.itemCode ?? '', '품목코드가 없습니다.',
      '업로드 대상 시스템에서 코드 공백을 허용하는지 확인하고 업로드 여부를 판단하세요.'
    ));
    else codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    if (!text(row.masterProductId)) {
      errors.push(estimateIssue(
        'MASTER_LINK_REQUIRED', row, rowIndex, '마스터 연결', row.masterProductId ?? '', '마스터 상품이 연결되지 않았습니다.',
        '원본 품목과 업로드 결과를 대조하고 업로드 여부를 판단하세요.'
      ));
    }
    const originalUnitPrice = unitPriceSource(row);
    if (numeric(originalUnitPrice) === null) {
      const originalValue = originalUnitPrice ?? '';
      errors.push(estimateIssue(
        'UNIT_PRICE_INVALID', row, rowIndex, '단가', originalValue,
        String(originalValue) === '' ? '단가가 공백입니다.' : '단가가 숫자가 아닙니다.',
        '원본 단가를 그대로 출력했습니다. 업로드 대상 시스템의 허용 여부를 확인하고 판단하세요.'
      ));
    }
  });
  candidates.forEach(({ row, rowIndex }) => {
    const code = text(row.itemCode);
    if (code && codeCounts.get(code) > 1) errors.push(estimateIssue(
      'DUPLICATE_ITEM_CODE', row, rowIndex, '품목코드', row.itemCode ?? '', `품목코드 ${code}가 중복되었습니다.`,
      '중복 행을 각각 업로드할지 확인하고 업로드 여부를 판단하세요.'
    ));
  });
  return { ok: errors.length === 0, errors, entries: candidates, rows: candidates.map(({ row }) => row) };
}

export function buildEstimateF8Data(rows = []) {
  const validation = validateEstimateRows(rows);
  const shopData = [[...SHOP_HEADERS]];
  const erpData = [[...ERP_HEADERS]];
  const errorData = [[...ERROR_HEADERS], ...validation.errors.map(issueDataRow)];
  validation.entries.forEach(({ row, rowIndex }) => {
    const code = text(row.itemCode);
    const originalUnitPrice = unitPriceSource(row);
    const unitPrice = sourceNumber(originalUnitPrice);
    const noticePrice = numeric(row.noticePrice) ?? 0;
    shopData.push([
      code, text(row.itemName), text(row.specification), '', unitPrice, noticePrice, '', '',
      0, 0, 0, 0, '', '', 1, '', '', '', '', '', '', ''
    ]);
    erpData.push([
      code, unitPrice, '0', '', '0', sourceNumber(row.purchasePriceB), 'n', sourceNumber(row.wholesaleA), 'n', sourceNumber(row.wholesaleB), 'n'
    ]);
    if (row.unitPriceReviewStatus === 'PENDING' && numeric(originalUnitPrice) !== null) {
      errorData.push(issueDataRow(estimateIssue(
        'UNIT_PRICE_REVIEW_REQUIRED', row, rowIndex, '단가', originalUnitPrice ?? '', '사진 인식 단가 확인이 필요합니다.',
        '원본 사진과 단가를 대조한 뒤 업로드 여부를 판단하세요.'
      )));
    }
  });
  return {
    ok: true,
    validationOk: validation.ok,
    errors: validation.errors,
    rows: validation.rows,
    errorData,
    shopData,
    erpData
  };
}

function fitText(context, value, maxWidth) {
  const source = text(value);
  if (context.measureText(source).width <= maxWidth) return source;
  let output = source;
  while (output && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
  return `${output}…`;
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

export function renderKakaoNoticeCanvases(noticeRows = [], { title = '견적 단가 안내', rowsPerPage = KAKAO_NOTICE_ROWS_PER_PAGE } = {}) {
  if (typeof document === 'undefined') return [];
  const rows = Array.isArray(noticeRows) ? noticeRows : [];
  const requestedPageSize = Math.floor(Number(rowsPerPage));
  const pageSize = Math.max(1, Math.min(KAKAO_NOTICE_ROWS_PER_PAGE, Number.isFinite(requestedPageSize) ? requestedPageSize : KAKAO_NOTICE_ROWS_PER_PAGE));
  const rowPages = paginateKakaoNoticeRows(rows, pageSize);
  const pages = [];
  const pageCount = rowPages.length;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageRows = rowPages[pageIndex];
    const rowColumns = splitKakaoNoticeColumns(pageRows);
    const twoColumn = rowColumns.length === 2;
    const canvas = document.createElement('canvas');
    const width = twoColumn ? 1440 : 960;
    const headerHeight = 132;
    const tableHeaderHeight = 54;
    const rowHeight = 66;
    const footerHeight = 54;
    const visibleRowCount = Math.max(1, ...rowColumns.map(columnRows => columnRows.length));
    canvas.width = width;
    canvas.height = headerHeight + tableHeaderHeight + visibleRowCount * rowHeight + footerHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fffaf4';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#10253f';
    context.fillRect(0, 0, width, headerHeight);
    context.fillStyle = '#f59e0b';
    context.fillRect(0, headerHeight - 7, width, 7);
    context.fillStyle = '#ffffff';
    context.font = '700 34px Pretendard, Arial, sans-serif';
    context.fillText(fitText(context, title, 700), 42, 58);
    context.fillStyle = '#cbd5e1';
    context.font = '500 19px Pretendard, Arial, sans-serif';
    context.fillText(new Date().toLocaleDateString('ko-KR'), 42, 96);
    context.textAlign = 'right';
    context.fillText(`${pageIndex + 1} / ${pageCount}`, width - 42, 96);
    context.textAlign = 'left';
    const selectedPriceFields = (pageRows[0]?.prices || rows[0]?.prices || [{ fieldId: 'noticePrice', label: '공지단가', value: 0 }]).slice(0, 2);
    const priceCount = Math.max(1, selectedPriceFields.length);
    const outerMargin = 24;
    const panelGap = twoColumn ? 20 : 0;
    const panelWidth = (width - (outerMargin * 2) - panelGap) / rowColumns.length;
    rowColumns.forEach((columnRows, panelIndex) => {
      const panelLeft = outerMargin + panelIndex * (panelWidth + panelGap);
      const nameWidth = twoColumn ? (priceCount === 2 ? 406 : 510) : (priceCount === 2 ? 552 : 650);
      const priceWidth = (panelWidth - nameWidth) / priceCount;
      const columns = [{ key: 'name', label: '품명·규격', left: panelLeft, width: nameWidth }];
      selectedPriceFields.forEach((field, index) => columns.push({ key: `price-${index}`, label: field.label, left: panelLeft + nameWidth + (priceWidth * index), width: priceWidth }));
      context.fillStyle = '#ffedd5';
      context.fillRect(panelLeft, headerHeight, panelWidth, tableHeaderHeight);
      context.fillStyle = '#9a4a08';
      context.font = `700 ${twoColumn ? 15 : 18}px Pretendard, Arial, sans-serif`;
      columns.forEach(column => context.fillText(fitText(context, column.label, column.width - 20), column.left + 10, headerHeight + 35));
      columnRows.forEach((row, rowIndex) => {
        const top = headerHeight + tableHeaderHeight + rowIndex * rowHeight;
        context.fillStyle = rowIndex % 2 ? '#fff7ed' : '#ffffff';
        context.fillRect(panelLeft, top, panelWidth, rowHeight);
        context.strokeStyle = '#fed7aa';
        context.beginPath();
        context.moveTo(panelLeft, top + rowHeight);
        context.lineTo(panelLeft + panelWidth, top + rowHeight);
        context.stroke();
        context.fillStyle = '#172033';
        context.font = `600 ${twoColumn ? 17 : 20}px Pretendard, Arial, sans-serif`;
        context.fillText(fitText(context, row.nameSpec, columns[0].width - 22), columns[0].left + 10, top + 40);
        context.textAlign = 'right';
        selectedPriceFields.forEach((field, priceIndex) => {
          const column = columns[priceIndex + 1];
          context.fillStyle = '#172033';
          context.fillText(formatAmount(row.prices?.[priceIndex]?.value ?? 0), column.left + column.width - 12, top + 40);
        });
        context.textAlign = 'left';
      });
    });
    if (!pageRows.length) {
      context.fillStyle = '#667085';
      context.font = '600 20px Pretendard, Arial, sans-serif';
      context.fillText('출력할 견적 품목이 없습니다.', 42, headerHeight + tableHeaderHeight + 42);
    }
    context.fillStyle = '#667085';
    context.font = '500 15px Pretendard, Arial, sans-serif';
    context.fillText(`SMART INPUT · ${selectedPriceFields.map(field => field.label).join(' · ')} 표시`, 42, canvas.height - 20);
    pages.push(canvas);
  }
  return pages;
}

export const ESTIMATE_F8_HEADERS = Object.freeze({ error: ERROR_HEADERS, shop: SHOP_HEADERS, erp: ERP_HEADERS });
