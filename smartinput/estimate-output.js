const SHOP_HEADERS = Object.freeze([
  '상품코드\n코드', '상품명', '규격', '출고가', '도매A', '시중가', 'B판매가', '도매B',
  'C 판매가', 'C 도매가', 'D 판매가', 'D 도매가', '브랜드', '기본설명', '판매여부',
  '재고수량', '테마1', '테마2', '테마3', '테마4', '테마5', '상품태그'
]);
const ERP_HEADERS = Object.freeze(['품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n']);
const CONFIRM_HEADERS = Object.freeze([
  '확인구분', '상품코드', '상품명', '규격', '기준입고항목',
  '기준입고가', '도매항목', '도매가', '차이', '확인요청'
]);

function text(value) {
  return String(value ?? '').trim();
}

function numeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,원₩]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function priceKey(row = {}, index = 0) {
  const masterId = text(row.masterProductId);
  if (masterId) return `MASTER:${masterId}`;
  const code = text(row.itemCode);
  return code ? `CODE:${code}` : `ROW:${index}`;
}

export function buildCatalogPriceSnapshot(rows = []) {
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row, index) => [
    priceKey(row, index),
    numeric(row.noticePrice) ?? 0
  ]));
}

export function priceSnapshotsEqual(left = {}, right = {}) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Number(left[key]) === Number(right[key]));
}

export function buildKakaoNoticeRows(rows = [], previousPrices = {}) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const currentPrice = numeric(row.noticePrice) ?? 0;
    const key = priceKey(row, index);
    const hasPrevious = Object.prototype.hasOwnProperty.call(previousPrices || {}, key);
    const previousPrice = hasPrevious ? numeric(previousPrices[key]) : null;
    return {
      key,
      itemCode: text(row.itemCode),
      nameSpec: [text(row.itemName), text(row.specification)].filter(Boolean).join(' · '),
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
  if (!candidates.length) errors.push({ code: 'EMPTY', message: '출력할 견적 품목이 없습니다.' });
  const codeCounts = new Map();
  candidates.forEach(({ row, rowIndex }) => {
    const code = text(row.itemCode);
    if (!code) errors.push({ code: 'ITEM_CODE_REQUIRED', rowIndex, message: `${rowIndex + 1}행 품목코드가 없습니다.` });
    else codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    if (!text(row.masterProductId)) {
      errors.push({ code: 'MASTER_LINK_REQUIRED', rowIndex, message: `${rowIndex + 1}행 마스터 상품 연결을 확인하세요.` });
    }
    if (numeric(row.unitPrice) === null) {
      errors.push({ code: 'UNIT_PRICE_INVALID', rowIndex, message: `${rowIndex + 1}행 단가가 숫자가 아닙니다.` });
    }
  });
  codeCounts.forEach((count, code) => {
    if (count > 1) errors.push({ code: 'DUPLICATE_ITEM_CODE', itemCode: code, message: `품목코드 ${code}가 중복되었습니다.` });
  });
  return { ok: errors.length === 0, errors, rows: candidates.map(({ row }) => row) };
}

export function buildEstimateF8Data(rows = []) {
  const validation = validateEstimateRows(rows);
  if (!validation.ok) return { ...validation, shopData: [], erpData: [], confirmData: [] };
  const shopData = [[...SHOP_HEADERS]];
  const erpData = [[...ERP_HEADERS]];
  const confirmData = [[...CONFIRM_HEADERS]];
  validation.rows.forEach(row => {
    const code = text(row.itemCode);
    const unitPrice = numeric(row.unitPrice) ?? 0;
    const noticePrice = numeric(row.noticePrice) ?? 0;
    shopData.push([
      code, text(row.itemName), text(row.specification), '', unitPrice, noticePrice, '', '',
      0, 0, 0, 0, '', '', 1, '', '', '', '', '', '', ''
    ]);
    erpData.push([code, '', '0', '', '0', '', 'n', unitPrice, 'n', '', 'n']);
    if (row.unitPriceReviewStatus === 'PENDING') {
      confirmData.push([
        '단가 확인 필요', code, text(row.itemName), text(row.specification), '',
        '', '도매A', unitPrice, '', '사진 인식 단가를 확인하세요.'
      ]);
    }
  });
  return { ok: true, errors: [], rows: validation.rows, shopData, erpData, confirmData };
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

function formatChange(value) {
  if (value === null || value === undefined) return '';
  const amount = Number(value || 0);
  return `${amount > 0 ? '+' : ''}${formatAmount(amount)}`;
}

export function renderKakaoNoticeCanvases(noticeRows = [], { title = '견적 단가 안내', rowsPerPage = 12 } = {}) {
  if (typeof document === 'undefined') return [];
  const rows = Array.isArray(noticeRows) ? noticeRows : [];
  const pageSize = Math.max(1, Number(rowsPerPage) || 12);
  const pages = [];
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageRows = rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const canvas = document.createElement('canvas');
    const width = 960;
    const headerHeight = 132;
    const tableHeaderHeight = 54;
    const rowHeight = 66;
    const footerHeight = 54;
    canvas.width = width;
    canvas.height = headerHeight + tableHeaderHeight + Math.max(1, pageRows.length) * rowHeight + footerHeight;
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
    const columns = [42, 474, 640, 778, 918];
    const headers = ['품명·규격', '단가', '변동액', '적요'];
    context.fillStyle = '#ffedd5';
    context.fillRect(24, headerHeight, width - 48, tableHeaderHeight);
    context.fillStyle = '#9a4a08';
    context.font = '700 19px Pretendard, Arial, sans-serif';
    headers.forEach((header, index) => context.fillText(header, columns[index] + 10, headerHeight + 35));
    pageRows.forEach((row, rowIndex) => {
      const top = headerHeight + tableHeaderHeight + rowIndex * rowHeight;
      context.fillStyle = rowIndex % 2 ? '#fff7ed' : '#ffffff';
      context.fillRect(24, top, width - 48, rowHeight);
      context.strokeStyle = '#fed7aa';
      context.beginPath();
      context.moveTo(24, top + rowHeight);
      context.lineTo(width - 24, top + rowHeight);
      context.stroke();
      context.fillStyle = '#172033';
      context.font = '600 20px Pretendard, Arial, sans-serif';
      context.fillText(fitText(context, row.nameSpec, columns[1] - columns[0] - 22), columns[0] + 10, top + 40);
      context.textAlign = 'right';
      context.fillText(formatAmount(row.price), columns[2] - 14, top + 40);
      context.fillStyle = row.change > 0 ? '#b42318' : (row.change < 0 ? '#16746d' : '#667085');
      context.fillText(formatChange(row.change), columns[3] - 14, top + 40);
      context.textAlign = 'left';
      context.fillStyle = '#475467';
      context.font = '500 18px Pretendard, Arial, sans-serif';
      context.fillText(fitText(context, row.note, columns[4] - columns[3] - 20), columns[3] + 10, top + 40);
    });
    if (!pageRows.length) {
      context.fillStyle = '#667085';
      context.font = '600 20px Pretendard, Arial, sans-serif';
      context.fillText('출력할 견적 품목이 없습니다.', 42, headerHeight + tableHeaderHeight + 42);
    }
    context.fillStyle = '#667085';
    context.font = '500 15px Pretendard, Arial, sans-serif';
    context.fillText('SMART INPUT · 저장된 직전 공지단가 기준', 42, canvas.height - 20);
    pages.push(canvas);
  }
  return pages;
}

export const ESTIMATE_F8_HEADERS = Object.freeze({ shop: SHOP_HEADERS, erp: ERP_HEADERS, confirm: CONFIRM_HEADERS });
