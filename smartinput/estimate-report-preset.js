// Built-in ERP report contract. Values belong to this input snapshot, not master writes.
export const ESTIMATE_REPORT_PRESET_ID = 'SMARTINPUT_ESTIMATE_REPORT_V1';
export const ESTIMATE_REPORT_PRESET_NAME = '견적서현황';
export const ESTIMATE_REPORT_FIELDS = Object.freeze([
  ['일자', 'rowVoucherDate', '전표정보'],
  ['창고', 'rowWarehouseCode', '전표정보'],
  ['거래처명', 'rowCustomerName', '전표정보'],
  ['품목명', 'itemName', '품목 입력정보'],
  ['규격', 'specification', '품목 입력정보'],
  ['품목코드', 'itemCode', '품목 입력정보'],
  ['입고가', 'unitPrice', '품목 입력정보'],
  ['출고가', 'outPrice', '상품 참조정보'],
  ['입고B', 'purchasePriceB', '품목 입력정보'],
  ['도매A', 'wholesaleA', '품목 입력정보'],
  ['도매B', 'wholesaleB', '품목 입력정보'],
  ['행사가', 'promoPrice', '품목 입력정보'],
  ['적요2', 'memo2', '품목 입력정보'],
  ['간단설명', 'productDescription', '상품 참조정보'],
  ['단위', 'unit', '상품 참조정보'],
  ['1종연산', 'type1Operation', '상품 참조정보'],
  ['외주비', 'outsourcingUnitPrice', '상품 참조정보'],
  ['경비', 'expenseStandardCost', '상품 참조정보'],
  ['노무비', 'laborStandardCost', '상품 참조정보'],
  ['재료비', 'materialStandardCost', '상품 참조정보'],
  ['1종규격', 'type1Specification', '상품 참조정보'],
  ['1종코드', 'type1Code', '상품 참조정보'],
  ['1입고', 'type1InboundPrice', '상품 참조정보'],
  ['1출고', 'type1OutPrice', '상품 참조정보']
].map(([sourceHeader, projectionFieldId, informationGroup]) => Object.freeze({ sourceHeader, projectionFieldId, informationGroup })));
export const ESTIMATE_REPORT_HEADERS = Object.freeze(ESTIMATE_REPORT_FIELDS.map(field => field.sourceHeader));
const text = value => String(value ?? '').normalize('NFKC').trim();

export function isEstimateReportHeaders(headers = [], voucherMode = 'estimate') {
  if (String(voucherMode).toLowerCase() !== 'estimate' || !Array.isArray(headers)) return false;
  const names = headers.map(text);
  return names.length === ESTIMATE_REPORT_HEADERS.length
    && new Set(names).size === names.length
    && ESTIMATE_REPORT_HEADERS.every(name => names.includes(name));
}

// Do not discard incomplete product records. Only the report's timestamp-only footer
// (or a repeated, complete header) is metadata. No fixed last-row number is used.
export function isEstimateReportMetadataRow(cells = [], headers = []) {
  if (!isEstimateReportHeaders(headers) || !Array.isArray(cells)) return false;
  const values = cells.map(text);
  if (values.length >= headers.length && headers.every((header, index) => text(header) === values[index])) return true;
  const present = values.filter(Boolean);
  return present.length === 1 && /^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}\s*(?:\([^)]*\))?\s*(?:오전|오후|AM|PM)?\s*\d{1,2}:\d{2}(?::\d{2})?$/i.test(present[0]);
}

export function estimateReportField(headers, columnIndex) {
  const source = text(headers?.[columnIndex]);
  return ESTIMATE_REPORT_FIELDS.find(field => field.sourceHeader === source) || null;
}

export function createEstimateReportPreset(headers = [], targetDefinitions = [], voucherMode = '') {
  if (!isEstimateReportHeaders(headers, voucherMode)) return null;
  const mappings = headers.map((sourceHeader, columnIndex) => {
    const field = estimateReportField(headers, columnIndex);
    // Stable projection identity, never a label substring or the current visible column list.
    const candidates = targetDefinitions.filter(target => !target.custom && !target.registryField
      && (target.projectionFieldId || target.id) === field.projectionFieldId);
    const target = candidates.find(candidate => candidate.pickerVisible !== false) || candidates[0];
    return { columnIndex, sourceHeader, state: target ? 'MAPPED' : 'UNDECIDED', targetFieldId: target?.id || '',
      reviewed: Boolean(target), informationGroup: field.informationGroup };
  });
  const missing = mappings.filter(mapping => !mapping.targetFieldId);
  return {
    status: missing.length ? 'INVALID_TEMPLATE' : 'TEMPLATE_APPLIED',
    template: { templateId: ESTIMATE_REPORT_PRESET_ID, templateName: ESTIMATE_REPORT_PRESET_NAME,
      revision: 1, builtinPresetId: ESTIMATE_REPORT_PRESET_ID },
    mappings,
    issues: missing.map(mapping => ({ code: 'TARGET_MISSING', columnIndex: mapping.columnIndex,
      targetFieldId: estimateReportField(headers, mapping.columnIndex).projectionFieldId }))
  };
}

// Workbook selection and its built-in report fields share one input contract.
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

export function isEstimateWorkbookItemRow(row = [], headers = ERP_ESTIMATE_HEADERS) {
  if (isEstimateReportHeaders(headers)) return Array.isArray(row) && row.some(meaningful) && !isEstimateReportMetadataRow(row, headers);
  return Array.isArray(row) && ERP_ESTIMATE_HEADERS.slice(0, 6).every((unused, index) => meaningful(row[index]));
}

export function inspectEstimateWorkbookCandidate(candidate = {}, voucherMode = '') {
  const matrix = Array.isArray(candidate.matrix) ? candidate.matrix : [];
  const headerRowIndex = Number(candidate?.detection?.rowIndex);
  const header = Number.isInteger(headerRowIndex) && headerRowIndex >= 0
    ? matrix[headerRowIndex]
    : null;
  const recognized = String(voucherMode || '').toLowerCase() === 'estimate'
    && Array.isArray(header)
    && (isEstimateReportHeaders(header) || (ERP_ESTIMATE_HEADERS.every((expected, index) => cellText(header[index]) === expected)
      && header.slice(ERP_ESTIMATE_HEADERS.length).every(value => !meaningful(value))));
  if (!recognized) return Object.freeze({ recognized: false, preferred: false });

  const itemRows = matrix.slice(headerRowIndex + 1).filter(row => isEstimateWorkbookItemRow(row, header));
  const customerColumn = header.map(cellText).indexOf('거래처명');
  const customerNames = new Set(itemRows.map(row => cellText(row[customerColumn])).filter(Boolean));
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
