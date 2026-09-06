const ERP_ESTIMATE_SHEET_NAME = '견적서현황내역';

export const ERP_ESTIMATE_HEADERS = Object.freeze([
  '일자', '창고', '거래처명', '품목명', '규격', '품목코드', '입고가', '출고가', '입고B',
  '도매A', '도매B', '행사가', '적요2', '간단설명', '1종연산', '외주비', '경비', '노무비',
  '재료비', '1종규격', '1종코드', '1입고', '1출고'
]);

function cellText(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function meaningful(value) {
  return cellText(value) !== '';
}

export function inspectEstimateWorkbookCandidate(candidate = {}, voucherMode = '') {
  const matrix = Array.isArray(candidate.matrix) ? candidate.matrix : [];
  const headerRowIndex = Number(candidate?.detection?.rowIndex);
  const header = Number.isInteger(headerRowIndex) && headerRowIndex >= 0
    ? matrix[headerRowIndex]
    : null;
  const recognized = String(voucherMode || '').toLowerCase() === 'estimate'
    && Array.isArray(header)
    && ERP_ESTIMATE_HEADERS.every((expected, index) => cellText(header[index]) === expected)
    && header.slice(ERP_ESTIMATE_HEADERS.length).every(value => !meaningful(value));
  if (!recognized) return Object.freeze({ recognized: false, preferred: false });

  const itemRows = matrix.slice(headerRowIndex + 1).filter(row => (
    Array.isArray(row) && ERP_ESTIMATE_HEADERS.slice(0, 6).every((unused, index) => meaningful(row[index]))
  ));
  const customerNames = new Set(itemRows.map(row => cellText(row[2])).filter(Boolean));
  return Object.freeze({
    schemaVersion: 'ONEAPP_SMARTINPUT_ERP_ESTIMATE_STATUS_SUMMARY_V1',
    recognized: true,
    preferred: cellText(candidate.sheetName) === ERP_ESTIMATE_SHEET_NAME,
    sheetName: cellText(candidate.sheetName),
    headerRowNumber: headerRowIndex + 1,
    itemCount: itemRows.length,
    customerCount: customerNames.size,
    sourceRowCount: matrix.length,
    sourceColumnCount: Math.max(ERP_ESTIMATE_HEADERS.length, ...matrix.map(row => Array.isArray(row) ? row.length : 0), 0)
  });
}

export function chooseEstimateWorkbookCandidate(current, candidate, voucherMode = '') {
  if (!candidate) return current || null;
  if (!current) return candidate;
  if (String(voucherMode || '').toLowerCase() !== 'estimate') {
    return Number(candidate?.detection?.score || 0) > Number(current?.detection?.score || 0) ? candidate : current;
  }
  const currentInfo = current.estimateErpSummary || inspectEstimateWorkbookCandidate(current, voucherMode);
  const candidateInfo = candidate.estimateErpSummary || inspectEstimateWorkbookCandidate(candidate, voucherMode);
  if (candidateInfo.preferred !== currentInfo.preferred) return candidateInfo.preferred ? candidate : current;
  return Number(candidate?.detection?.score || 0) > Number(current?.detection?.score || 0) ? candidate : current;
}
