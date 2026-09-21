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
