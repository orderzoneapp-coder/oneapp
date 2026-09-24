// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.


// ============================================================================
// estimate-report-preset.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const estimateReportPresetSection = (() => {


// Built-in ERP report contract. Values belong to this input snapshot, not master writes.
const ESTIMATE_REPORT_PRESET_ID = 'SMARTINPUT_ESTIMATE_REPORT_V1';
const ESTIMATE_REPORT_PRESET_NAME = '견적서현황';
const ESTIMATE_REPORT_FIELDS = Object.freeze([
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
const ESTIMATE_REPORT_HEADERS = Object.freeze(ESTIMATE_REPORT_FIELDS.map(field => field.sourceHeader));
const text = value => String(value ?? '').normalize('NFKC').trim();

function isEstimateReportHeaders(headers = [], voucherMode = 'estimate') {
  if (String(voucherMode).toLowerCase() !== 'estimate' || !Array.isArray(headers)) return false;
  const names = headers.map(text);
  return names.length === ESTIMATE_REPORT_HEADERS.length
    && new Set(names).size === names.length
    && ESTIMATE_REPORT_HEADERS.every(name => names.includes(name));
}

// Do not discard incomplete product records. Only the report's timestamp-only footer
// (or a repeated, complete header) is metadata. No fixed last-row number is used.
function isEstimateReportMetadataRow(cells = [], headers = []) {
  if (!isEstimateReportHeaders(headers) || !Array.isArray(cells)) return false;
  const values = cells.map(text);
  if (values.length >= headers.length && headers.every((header, index) => text(header) === values[index])) return true;
  const present = values.filter(Boolean);
  return present.length === 1 && /^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}\s*(?:\([^)]*\))?\s*(?:오전|오후|AM|PM)?\s*\d{1,2}:\d{2}(?::\d{2})?$/i.test(present[0]);
}

function estimateReportField(headers, columnIndex) {
  const source = text(headers?.[columnIndex]);
  return ESTIMATE_REPORT_FIELDS.find(field => field.sourceHeader === source) || null;
}

function createEstimateReportPreset(headers = [], targetDefinitions = [], voucherMode = '') {
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

const ERP_ESTIMATE_HEADERS = Object.freeze([
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

function isEstimateWorkbookItemRow(row = [], headers = ERP_ESTIMATE_HEADERS) {
  if (isEstimateReportHeaders(headers)) return Array.isArray(row) && row.some(meaningful) && !isEstimateReportMetadataRow(row, headers);
  return Array.isArray(row) && ERP_ESTIMATE_HEADERS.slice(0, 6).every((unused, index) => meaningful(row[index]));
}

function inspectEstimateWorkbookCandidate(candidate = {}, voucherMode = '') {
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

function chooseEstimateWorkbookCandidate(current, candidate, voucherMode = '') {
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

return { ESTIMATE_REPORT_PRESET_ID, ESTIMATE_REPORT_PRESET_NAME, ESTIMATE_REPORT_FIELDS, ESTIMATE_REPORT_HEADERS, isEstimateReportHeaders, isEstimateReportMetadataRow, estimateReportField, createEstimateReportPreset, ERP_ESTIMATE_HEADERS, isEstimateWorkbookItemRow, inspectEstimateWorkbookCandidate, chooseEstimateWorkbookCandidate };
})();

// ============================================================================
// input-template-mapper.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const inputTemplateMapperSection = (() => {
const { createEstimateReportPreset, isEstimateReportHeaders, isEstimateReportMetadataRow, estimateReportField } = estimateReportPresetSection;

const SOURCE_WHITESPACE = /[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+/gu;

function hasMeaningfulSourceValue(value) {
  if (value === null || value === undefined) return false;
  return String(value).replace(SOURCE_WHITESPACE, '') !== '';
}

function sourceRowHasMeaningfulValue(row = []) {
  return (Array.isArray(row) ? row : [row]).some(hasMeaningfulSourceValue);
}

const DECISION = Object.freeze({
  UNDECIDED: 'UNDECIDED',
  RECOMMENDED: 'RECOMMENDED',
  MAPPED: 'MAPPED',
  UNMAPPED: 'UNMAPPED'
});

const SESSION_STATUS = Object.freeze({
  NEW_TEMPLATE: 'NEW_TEMPLATE',
  TEMPLATE_APPLIED: 'TEMPLATE_APPLIED',
  INVALID_TEMPLATE: 'INVALID_TEMPLATE',
  TEMPLATE_CONFLICT: 'TEMPLATE_CONFLICT',
  TEMPLATE_LOOKUP_ERROR: 'TEMPLATE_LOOKUP_ERROR'
});

const cellText = value => String(value ?? '');

const workingRowIndexes = new WeakMap();
const optimizationMetrics = {
  fullWorkingRowBuilds: 0,
  incrementalWorkingRowUpdates: 0,
  fullMappedRowProjections: 0,
  incrementalMappedRowProjections: 0
};

function rememberWorkingRowIndex(session, workingRows = session?.workingRows || []) {
  const index = new Map();
  workingRows.forEach((row, rowIndex) => index.set(row.rowId, rowIndex));
  workingRowIndexes.set(session, index);
  return index;
}

function workingRowIndex(session) {
  return workingRowIndexes.get(session) || rememberWorkingRowIndex(session);
}

function resetInputMappingOptimizationMetrics() {
  Object.keys(optimizationMetrics).forEach(key => { optimizationMetrics[key] = 0; });
}

function inputMappingOptimizationMetrics() {
  return { ...optimizationMetrics };
}

function cloneMatrix(matrix = []) {
  return (Array.isArray(matrix) ? matrix : []).map(row => (
    Array.isArray(row) ? row.map(cellText) : [cellText(row)]
  ));
}

function cloneSourceCellMatrix(matrix = []) {
  return (Array.isArray(matrix) ? matrix : []).map((row, rowIndex) => (
    (Array.isArray(row) ? row : []).map((cell, columnIndex) => ({
      address: cellText(cell?.address),
      rowIndex: Number.isInteger(cell?.rowIndex) ? cell.rowIndex : rowIndex,
      columnIndex: Number.isInteger(cell?.columnIndex) ? cell.columnIndex : columnIndex,
      displayValue: cellText(cell?.displayValue),
      rawValue: cell?.rawValue ?? null,
      formula: cellText(cell?.formula),
      numberFormat: cellText(cell?.numberFormat),
      cellType: cellText(cell?.cellType),
      blank: Boolean(cell?.blank)
    }))
  ));
}

function columnCount(matrix, headerRowIndex) {
  return Math.max(
    matrix[headerRowIndex]?.length || 0,
    ...matrix.slice(headerRowIndex + 1).map(row => row.length),
    0
  );
}

function headersAt(matrix = [], headerRowIndex = 0) {
  const source = cloneMatrix(matrix);
  if (!source.length) return [];
  const safeIndex = Math.max(0, Math.min(source.length - 1, Number(headerRowIndex) || 0));
  const width = columnCount(source, safeIndex);
  return Array.from({ length: width }, (_, columnIndex) => cellText(source[safeIndex]?.[columnIndex]));
}

function templateSignature(headers = []) {
  return JSON.stringify((Array.isArray(headers) ? headers : []).map(cellText));
}

function templateSignatureV2(companyId, voucherMode, headers = []) {
  return JSON.stringify({
    companyId: cellText(companyId).trim(),
    voucherMode: cellText(voucherMode).trim().toLowerCase(),
    headers: (Array.isArray(headers) ? headers : []).map(cellText)
  });
}

function detectHeaderRow(matrix = [], targetDefinitions = [], { maxScanRows = 80 } = {}) {
  const source = cloneMatrix(matrix);
  const targetLabels = new Set((targetDefinitions || []).map(target => cellText(target?.label)).filter(Boolean));
  let best = null;
  source.slice(0, Math.max(1, maxScanRows)).forEach((row, rowIndex) => {
    const nonEmpty = row.filter(hasMeaningfulSourceValue).length;
    if (nonEmpty < 2) return;
    const exactTargets = row.filter(value => targetLabels.has(value)).length;
    const textCells = row.filter(value => hasMeaningfulSourceValue(value) && !Number.isFinite(Number(value.replace(/,/g, '')))).length;
    const followingRows = source.slice(rowIndex + 1, rowIndex + 4).filter(candidate => candidate.some(hasMeaningfulSourceValue)).length;
    const score = (exactTargets * 1000) + (textCells * 20) + (nonEmpty * 5) + followingRows - rowIndex;
    if (!best || score > best.score) best = { rowIndex, rowNumber: rowIndex + 1, score, exactTargets, nonEmpty };
  });
  return best || { rowIndex: 0, rowNumber: 1, score: 0, exactTargets: 0, nonEmpty: source[0]?.filter(hasMeaningfulSourceValue).length || 0 };
}

function targetIndex(targetDefinitions = []) {
  return new Map((targetDefinitions || []).filter(target => target?.id).map(target => [target.id, target]));
}

function targetProjectionId(target) {
  return cellText(target?.projectionFieldId || target?.id);
}

function mappingValidation(mappings = [], targetDefinitions = []) {
  const targets = targetIndex(targetDefinitions);
  const used = new Map();
  const issues = [];
  mappings.forEach((mapping, columnIndex) => {
    const state = mapping?.state;
    if (state === DECISION.RECOMMENDED) {
      issues.push({
        code: 'RECOMMENDATION_APPROVAL_REQUIRED',
        columnIndex,
        targetFieldId: mapping.targetFieldId || ''
      });
      return;
    }
    if (![DECISION.MAPPED, DECISION.UNMAPPED].includes(state)) {
      issues.push({ code: 'UNDECIDED_COLUMN', columnIndex });
      return;
    }
    if (mapping?.reviewed !== true) {
      issues.push({ code: 'REVIEW_REQUIRED', columnIndex });
      return;
    }
    if (state === DECISION.UNMAPPED) return;
    if (!targets.has(mapping.targetFieldId)) {
      issues.push({ code: 'TARGET_MISSING', columnIndex, targetFieldId: mapping.targetFieldId || '' });
      return;
    }
    const target = targets.get(mapping.targetFieldId);
    const projectionFieldId = targetProjectionId(target);
    if (used.has(projectionFieldId)) {
      const previous = used.get(projectionFieldId);
      issues.push({
        code: 'TARGET_DUPLICATED',
        columnIndex,
        otherColumnIndex: previous.columnIndex,
        targetFieldId: mapping.targetFieldId,
        otherTargetFieldId: previous.targetFieldId,
        projectionFieldId
      });
      return;
    }
    used.set(projectionFieldId, { columnIndex, targetFieldId: mapping.targetFieldId });
  });
  return { valid: issues.length === 0, issues };
}

function recommendMappings(headers = [], targetDefinitions = []) {
  const sourceCounts = new Map();
  headers.forEach(header => sourceCounts.set(cellText(header), (sourceCounts.get(cellText(header)) || 0) + 1));
  const targetsByAlias = new Map();
  targetDefinitions.filter(target => target?.id && target.recommendable !== false).forEach(target => {
    [...new Set([target.label, ...(target.aliases || [])].map(cellText).filter(Boolean))].forEach(alias => {
      targetsByAlias.set(alias, [...(targetsByAlias.get(alias) || []), target]);
    });
  });
  return headers.map((header, columnIndex) => {
    const sourceHeader = cellText(header);
    const candidates = targetsByAlias.get(sourceHeader) || [];
    const target = candidates[0];
    const unique = sourceHeader !== '' && sourceCounts.get(sourceHeader) === 1 && candidates.length === 1;
    return unique && target
      ? { columnIndex, sourceHeader, state: DECISION.RECOMMENDED, targetFieldId: target.id }
      : { columnIndex, sourceHeader, state: DECISION.UNDECIDED, targetFieldId: '', reviewed: false };
  });
}

function normalizeStoredMappings(template, headers) {
  const mappings = Array.isArray(template?.mappings) ? template.mappings : [];
  return headers.map((sourceHeader, columnIndex) => {
    const stored = mappings.find(mapping => Number(mapping.columnIndex) === columnIndex);
    if (!stored) return { columnIndex, sourceHeader, state: DECISION.UNDECIDED, targetFieldId: '', reviewed: false };
    return {
      columnIndex,
      sourceHeader,
      state: stored.state === DECISION.UNMAPPED ? DECISION.UNMAPPED : DECISION.MAPPED,
      targetFieldId: stored.state === DECISION.UNMAPPED ? '' : cellText(stored.targetFieldId),
      reviewed: true
    };
  });
}

function resolveTemplate(companyId, voucherMode, headers, templates = [], targetDefinitions = []) {
  const signature = templateSignatureV2(companyId, voucherMode, headers);
  const matches = (templates || []).filter(template => template?.schemaVersion === 'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V2'
    && cellText(template.companyId) === cellText(companyId)
    && cellText(template.voucherMode).toLowerCase() === cellText(voucherMode).toLowerCase()
    && template.signature === signature);
  if (matches.length > 1) {
    return {
      status: SESSION_STATUS.TEMPLATE_CONFLICT,
      template: null,
      mappings: recommendMappings(headers, targetDefinitions),
      issues: [{ code: 'TEMPLATE_SIGNATURE_DUPLICATED', templateIds: matches.map(template => template.templateId) }]
    };
  }
  if (!matches.length) {
    const builtin = createEstimateReportPreset(headers, targetDefinitions, voucherMode);
    if (builtin) return builtin;
    return {
      status: SESSION_STATUS.NEW_TEMPLATE,
      template: null,
      mappings: recommendMappings(headers, targetDefinitions),
      issues: []
    };
  }
  const template = matches[0];
  const mappings = normalizeStoredMappings(template, headers);
  const validation = mappingValidation(mappings, targetDefinitions);
  return {
    status: validation.valid ? SESSION_STATUS.TEMPLATE_APPLIED : SESSION_STATUS.INVALID_TEMPLATE,
    template,
    mappings,
    issues: validation.issues
  };
}

function workingRows(sourceMatrix, sourceCellMatrix, headerRowIndex, headers, editJournal = {}, manualRows = [], voucherMode = '') {
  optimizationMetrics.fullWorkingRowBuilds += 1;
  const width = headers.length;
  const sourceRows = sourceMatrix.slice(headerRowIndex + 1).map((sourceRow, offset) => {
    const sourceRowIndex = headerRowIndex + 1 + offset;
    const cells = Array.from({ length: width }, (_, columnIndex) => {
      const key = `${sourceRowIndex}:${columnIndex}`;
      return Object.prototype.hasOwnProperty.call(editJournal, key)
        ? cellText(editJournal[key])
        : cellText(sourceRow[columnIndex]);
    });
    return {
      rowId: `source-${sourceRowIndex}`,
      sourceRowIndex,
      cells,
      sourceCells: Array.from({ length: width }, (_, columnIndex) => ({
        ...(sourceCellMatrix?.[sourceRowIndex]?.[columnIndex] || {}),
        displayValue: cellText(sourceMatrix?.[sourceRowIndex]?.[columnIndex])
      })),
      manual: false
    };
  }).filter(row => row.cells.some(hasMeaningfulSourceValue)
    && !(isEstimateReportHeaders(headers, voucherMode) && isEstimateReportMetadataRow(row.cells, headers)));
  const manual = (manualRows || []).map((row, index) => ({
    rowId: cellText(row?.rowId) || `manual-${index + 1}`,
    sourceRowIndex: null,
    cells: Array.from({ length: width }, (_, columnIndex) => cellText(row?.cells?.[columnIndex])),
    sourceCells: [],
    manual: true
  })).filter(row => row.cells.some(hasMeaningfulSourceValue));
  return [...sourceRows, ...manual];
}

function activeWorkingRows(session, editJournal = session?.editJournal, manualRows = session?.manualRows) {
  const deletedSourceRows = new Set(session?.deletedSourceRows || []);
  return workingRows(
    session?.sourceMatrix || [],
    session?.sourceCellMatrix || [],
    session?.headerRowIndex || 0,
    session?.headers || [],
    editJournal || {},
    manualRows || [],
    session?.voucherMode
  ).filter(row => row.manual || !deletedSourceRows.has(row.sourceRowIndex));
}

function createMappingSession({
  matrix = [],
  headerRowIndex = 0,
  templates = [],
  targetDefinitions = [],
  fileName = '',
  sheetName = '',
  fileFingerprint = '',
  editJournal = {},
  manualRows = [],
  hiddenColumns = [],
  companyId = '',
  voucherMode = '',
  sourceCellMatrix = []
} = {}) {
  const sourceMatrix = cloneMatrix(matrix);
  const cellMatrix = cloneSourceCellMatrix(sourceCellMatrix);
  const safeIndex = sourceMatrix.length
    ? Math.max(0, Math.min(sourceMatrix.length - 1, Number(headerRowIndex) || 0))
    : 0;
  const headers = headersAt(sourceMatrix, safeIndex);
  const resolved = resolveTemplate(companyId, voucherMode, headers, templates, targetDefinitions);
  const session = {
    schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
    sessionId: `SIMAP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    companyId: cellText(companyId),
    voucherMode: cellText(voucherMode).toLowerCase(),
    fileName: cellText(fileName),
    sheetName: cellText(sheetName),
    fileFingerprint: cellText(fileFingerprint),
    sourceMatrix,
    sourceCellMatrix: cellMatrix,
    headerRowIndex: safeIndex,
    headers,
    headerSignature: templateSignature(headers),
    signature: templateSignatureV2(companyId, voucherMode, headers),
    status: resolved.status,
    templateId: cellText(resolved.template?.templateId),
    templateName: cellText(resolved.template?.templateName),
    templateRevision: Number(resolved.template?.revision || 0),
    ...(resolved.template?.builtinPresetId ? { builtinPresetId: resolved.template.builtinPresetId } : {}),
    mappings: resolved.mappings,
    issues: resolved.issues,
    editJournal: { ...(editJournal || {}) },
    manualRows: (manualRows || []).map(row => ({ ...row, cells: [...(row.cells || [])] })),
    hiddenColumns: [...new Set((hiddenColumns || []).map(Number).filter(Number.isInteger))],
    workingRows: workingRows(sourceMatrix, cellMatrix, safeIndex, headers, editJournal, manualRows, voucherMode),
    updatedAt: new Date().toISOString()
  };
  rememberWorkingRowIndex(session);
  return session;
}

function reassignHeaderRow(session, headerRowIndex, templates = [], targetDefinitions = []) {
  const reassigned = createMappingSession({
    matrix: session?.sourceMatrix || [],
    sourceCellMatrix: session?.sourceCellMatrix || [],
    companyId: session?.companyId,
    voucherMode: session?.voucherMode,
    headerRowIndex,
    templates,
    targetDefinitions,
    fileName: session?.fileName,
    sheetName: session?.sheetName,
    fileFingerprint: session?.fileFingerprint,
    editJournal: session?.editJournal,
    manualRows: session?.manualRows,
    hiddenColumns: session?.hiddenColumns
  });
  reassigned.deletedSourceRows = [...(session?.deletedSourceRows || [])];
  reassigned.workingRows = activeWorkingRows(reassigned);
  return reassigned;
}

function setColumnDecision(session, columnIndex, decision, targetFieldId = '', targetDefinitions = []) {
  if (!session || !Array.isArray(session.mappings)) throw new Error('MAPPING_SESSION_REQUIRED');
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= session.mappings.length) throw new Error('MAPPING_COLUMN_INVALID');
  if (![DECISION.MAPPED, DECISION.UNMAPPED].includes(decision)) throw new Error('MAPPING_DECISION_INVALID');
  const mappings = session.mappings.map(mapping => ({ ...mapping }));
  if (decision === DECISION.MAPPED) {
    const targets = targetIndex(targetDefinitions);
    if (!targets.has(targetFieldId)) throw new Error('MAPPING_TARGET_MISSING');
    const projectionFieldId = targetProjectionId(targets.get(targetFieldId));
    const duplicate = mappings.find(mapping => mapping.columnIndex !== columnIndex
      && [DECISION.MAPPED, DECISION.RECOMMENDED].includes(mapping.state)
      && targetProjectionId(targets.get(mapping.targetFieldId)) === projectionFieldId);
    if (duplicate) {
      const error = new Error('MAPPING_TARGET_DUPLICATED');
      error.otherColumnIndex = duplicate.columnIndex;
      error.otherTargetFieldId = duplicate.targetFieldId;
      error.projectionFieldId = projectionFieldId;
      throw error;
    }
    mappings[columnIndex] = { ...mappings[columnIndex], state: DECISION.MAPPED, targetFieldId, reviewed: true };
  } else {
    mappings[columnIndex] = { ...mappings[columnIndex], state: DECISION.UNMAPPED, targetFieldId: '', reviewed: true };
  }
  return { ...session, mappings, issues: [], updatedAt: new Date().toISOString() };
}

function sourceWorkingRow(session, sourceRowIndex, editJournal) {
  const cells = Array.from({ length: session.headers.length }, (_, columnIndex) => {
    const key = `${sourceRowIndex}:${columnIndex}`;
    return Object.prototype.hasOwnProperty.call(editJournal, key)
      ? cellText(editJournal[key])
      : cellText(session.sourceMatrix?.[sourceRowIndex]?.[columnIndex]);
  });
  return {
    rowId: `source-${sourceRowIndex}`,
    sourceRowIndex,
    cells,
    sourceCells: Array.from({ length: session.headers.length }, (_, columnIndex) => ({
      ...(session.sourceCellMatrix?.[sourceRowIndex]?.[columnIndex] || {}),
      displayValue: cellText(session.sourceMatrix?.[sourceRowIndex]?.[columnIndex])
    })),
    manual: false
  };
}

function manualWorkingRow(session, stored, fallbackIndex = 0) {
  return {
    rowId: cellText(stored?.rowId) || `manual-${fallbackIndex + 1}`,
    sourceRowIndex: null,
    cells: Array.from({ length: session.headers.length }, (_, columnIndex) => cellText(stored?.cells?.[columnIndex])),
    sourceCells: [],
    manual: true
  };
}

function insertWorkingRowInStableOrder(rows, row) {
  if (row.manual) return [...rows, row];
  const insertAt = rows.findIndex(candidate => candidate.manual
    || Number(candidate.sourceRowIndex) > Number(row.sourceRowIndex));
  if (insertAt < 0) return [...rows, row];
  return [...rows.slice(0, insertAt), row, ...rows.slice(insertAt)];
}

function updateWorkingCells(session, rowId, changes = []) {
  if (!session || !Array.isArray(session.workingRows)) throw new Error('MAPPING_SESSION_REQUIRED');
  const stableRowId = cellText(rowId);
  const index = workingRowIndex(session);
  const rowIndex = index.get(stableRowId);
  const row = Number.isInteger(rowIndex) ? session.workingRows[rowIndex] : null;
  if (!row) throw new Error('MAPPING_CELL_INVALID');
  const byColumn = new Map();
  changes.forEach(change => {
    const columnIndex = Number(change?.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= session.headers.length) {
      throw new Error('MAPPING_CELL_INVALID');
    }
    byColumn.set(columnIndex, cellText(change?.value ?? change?.displayValue));
  });
  if (!byColumn.size || [...byColumn].every(([columnIndex, value]) => cellText(row.cells?.[columnIndex]) === value)) return session;
  const editJournal = { ...(session.editJournal || {}) };
  const manualRows = row.manual ? [...(session.manualRows || [])] : (session.manualRows || []);
  if (row.manual) {
    const manualIndex = manualRows.findIndex(item => item.rowId === stableRowId);
    if (manualIndex < 0) throw new Error('MAPPING_MANUAL_ROW_MISSING');
    const target = { ...manualRows[manualIndex], cells: [...(manualRows[manualIndex].cells || [])] };
    byColumn.forEach((value, columnIndex) => { target.cells[columnIndex] = value; });
    manualRows[manualIndex] = target;
  } else {
    byColumn.forEach((value, columnIndex) => { editJournal[`${row.sourceRowIndex}:${columnIndex}`] = value; });
  }
  const nextRow = row.manual
    ? manualWorkingRow(session, manualRows.find(item => item.rowId === stableRowId), rowIndex)
    : sourceWorkingRow(session, row.sourceRowIndex, editJournal);
  const nextWorkingRows = [...session.workingRows];
  if (nextRow.cells.some(hasMeaningfulSourceValue)) nextWorkingRows[rowIndex] = nextRow;
  else nextWorkingRows.splice(rowIndex, 1);
  const next = {
    ...session,
    editJournal,
    manualRows,
    workingRows: nextWorkingRows,
    updatedAt: new Date().toISOString()
  };
  optimizationMetrics.incrementalWorkingRowUpdates += 1;
  rememberWorkingRowIndex(next);
  return next;
}

function updateWorkingCell(session, rowId, columnIndex, value) {
  return updateWorkingCells(session, rowId, [{ columnIndex, value }]);
}

function synchronizeWorkingRow(session, rowId, updates = []) {
  if (!session || !Array.isArray(session.workingRows)) throw new Error('MAPPING_SESSION_REQUIRED');
  const stableRowId = cellText(rowId);
  if (!stableRowId) throw new Error('MAPPING_ROW_ID_REQUIRED');
  const byColumn = new Map();
  updates.forEach(update => {
    const columnIndex = Number(update?.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= session.headers.length) {
      throw new Error('MAPPING_CELL_INVALID');
    }
    byColumn.set(columnIndex, cellText(update?.displayValue));
  });
  if (!byColumn.size) return session;

  const existingIndex = workingRowIndex(session).get(stableRowId);
  const existing = Number.isInteger(existingIndex) ? session.workingRows[existingIndex] : null;
  if (existing) {
    return updateWorkingCells(session, stableRowId, [...byColumn].map(([columnIndex, value]) => ({ columnIndex, value })));
  }

  const sourceRowIndex = /^source-(\d+)$/.exec(stableRowId)?.[1];
  if (sourceRowIndex !== undefined
    && Number(sourceRowIndex) > Number(session.headerRowIndex)
    && Number(sourceRowIndex) < (session.sourceMatrix || []).length
    && !(session.deletedSourceRows || []).includes(Number(sourceRowIndex))) {
    const editJournal = { ...(session.editJournal || {}) };
    byColumn.forEach((value, columnIndex) => { editJournal[`${sourceRowIndex}:${columnIndex}`] = value; });
    const row = sourceWorkingRow(session, Number(sourceRowIndex), editJournal);
    if (!row.cells.some(hasMeaningfulSourceValue)) return { ...session, editJournal, updatedAt: new Date().toISOString() };
    const next = {
      ...session,
      editJournal,
      workingRows: insertWorkingRowInStableOrder(session.workingRows, row),
      updatedAt: new Date().toISOString()
    };
    optimizationMetrics.incrementalWorkingRowUpdates += 1;
    rememberWorkingRowIndex(next);
    return next;
  }

  const values = Array(session.headers.length).fill('');
  byColumn.forEach((value, columnIndex) => { values[columnIndex] = value; });
  if (!values.some(hasMeaningfulSourceValue)) return session;
  const manualRows = (session.manualRows || []).map(row => ({ ...row, cells: [...(row.cells || [])] }));
  const stored = manualRows.find(row => row.rowId === stableRowId);
  if (stored) {
    byColumn.forEach((value, columnIndex) => { stored.cells[columnIndex] = value; });
    const row = manualWorkingRow(session, stored, manualRows.indexOf(stored));
    const next = {
      ...session,
      manualRows,
      workingRows: insertWorkingRowInStableOrder(session.workingRows, row),
      updatedAt: new Date().toISOString()
    };
    optimizationMetrics.incrementalWorkingRowUpdates += 1;
    rememberWorkingRowIndex(next);
    return next;
  }
  return addManualRow(session, values, stableRowId);
}

function addManualRow(session, values = [], rowId = '') {
  if (!session) throw new Error('MAPPING_SESSION_REQUIRED');
  const manualRows = [
    ...(session.manualRows || []).map(row => ({ ...row, cells: [...(row.cells || [])] })),
    {
      rowId: rowId || `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      cells: Array.from({ length: session.headers.length }, (_, index) => cellText(values[index]))
    }
  ];
  return {
    ...session,
    manualRows,
    workingRows: activeWorkingRows(session, session.editJournal, manualRows),
    updatedAt: new Date().toISOString()
  };
}

function deleteWorkingRows(session, rowIds = []) {
  const selected = new Set(rowIds);
  const deletedSourceRows = new Set([...(session.deletedSourceRows || []), ...session.workingRows
    .filter(row => selected.has(row.rowId) && !row.manual)
    .map(row => row.sourceRowIndex)]);
  const manualRows = (session.manualRows || []).filter(row => !selected.has(row.rowId));
  const rows = workingRows(session.sourceMatrix, session.sourceCellMatrix || [], session.headerRowIndex, session.headers, session.editJournal, manualRows, session.voucherMode)
    .filter(row => row.manual || !deletedSourceRows.has(row.sourceRowIndex));
  return {
    ...session,
    deletedSourceRows: [...deletedSourceRows],
    manualRows,
    workingRows: rows,
    updatedAt: new Date().toISOString()
  };
}

function decidedMappings(session, targetDefinitions) {
  const mappings = (session?.mappings || []).map(mapping => ({ ...mapping }));
  return { mappings, validation: mappingValidation(mappings, targetDefinitions) };
}

function validateTemplateDraft(session, targetDefinitions = []) {
  return decidedMappings(session, targetDefinitions).validation;
}

function createTemplateRecord(session, templateName, targetDefinitions = [], previous = null) {
  const name = cellText(templateName).trim();
  if (!name) throw new Error('TEMPLATE_NAME_REQUIRED');
  const { mappings, validation } = decidedMappings(session, targetDefinitions);
  if (!validation.valid) {
    const error = new Error('TEMPLATE_MAPPING_INCOMPLETE');
    error.issues = validation.issues;
    throw error;
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V2',
    templateId: cellText(previous?.templateId) || `SITPL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    companyId: cellText(session?.companyId),
    voucherMode: cellText(session?.voucherMode).toLowerCase(),
    templateName: name,
    revision: Math.max(1, Number(previous?.revision || 0) + 1),
    signature: templateSignatureV2(session?.companyId, session?.voucherMode, session?.headers),
    headerSignature: templateSignature(session?.headers),
    headers: [...session.headers],
    fieldCount: session.headers.length,
    mappings: mappings.map(mapping => ({
      columnIndex: mapping.columnIndex,
      sourceHeader: mapping.sourceHeader,
      state: mapping.state,
      targetFieldId: mapping.state === DECISION.MAPPED ? mapping.targetFieldId : '',
      reviewed: true
    })),
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
}

function targetValue(target, value) {
  if (!hasMeaningfulSourceValue(value)) return target?.valueType === 'NUMBER' ? null : '';
  if (target?.valueType !== 'NUMBER') return cellText(value);
  const number = Number(cellText(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function projectMappedRows(session, targetDefinitions = [], { rowIds = null } = {}) {
  if (!session || [SESSION_STATUS.INVALID_TEMPLATE, SESSION_STATUS.TEMPLATE_CONFLICT].includes(session.status)) return [];
  const selected = rowIds ? new Set(rowIds) : null;
  if (selected) optimizationMetrics.incrementalMappedRowProjections += 1;
  else optimizationMetrics.fullMappedRowProjections += 1;
  const targets = targetIndex(targetDefinitions);
  const mappings = (session.mappings || []).filter(mapping => [DECISION.MAPPED, DECISION.RECOMMENDED].includes(mapping.state));
  const rowIndex = workingRowIndex(session);
  const candidates = selected
    ? [...selected].map(rowId => session.workingRows?.[rowIndex.get(rowId)]).filter(Boolean)
    : (session.workingRows || []);
  return candidates
    .filter(row => (row.cells || []).some(hasMeaningfulSourceValue))
    .map(row => {
      const rowOrdinal = rowIndex.get(row.rowId) || 0;
      const projected = {
        rowId: row.rowId,
        sourceLineNo: row.sourceRowIndex === null ? rowOrdinal + 1 : row.sourceRowIndex + 1,
        sourceRowNo: row.sourceRowIndex === null ? rowOrdinal + 1 : row.sourceRowIndex + 1,
        rawText: (row.cells || []).join('\t'),
        inputOwnership: row.manual ? 'USER' : 'SOURCE',
        customValues: {},
        fieldValues: {}
      };
      mappings.forEach(mapping => {
        const target = targets.get(mapping.targetFieldId);
        if (!target) return;
        const currentDisplayValue = cellText(row.cells?.[mapping.columnIndex]);
        const value = targetValue(target, currentDisplayValue);
        const evidence = row.manual ? null : (row.sourceCells?.[mapping.columnIndex] || null);
        projected.fieldValues[target.id] = {
          fieldId: target.id,
          ...(isEstimateReportHeaders(session.headers, session.voucherMode)
            ? { informationGroup: estimateReportField(session.headers, mapping.columnIndex)?.informationGroup, valueSource: 'SOURCE_FILE' } : {}),
          sourceDisplayValue: cellText(evidence?.displayValue),
          currentDisplayValue,
          parsedValue: value,
          edited: row.manual || Object.prototype.hasOwnProperty.call(session.editJournal || {}, `${row.sourceRowIndex}:${mapping.columnIndex}`),
          evidence: evidence ? { ...evidence } : null
        };
        if (target.custom) projected.customValues[target.id] = value;
        else projected[target.projectionFieldId || target.id] = value;
      });
      return projected;
    });
}

function mappingSummary(session) {
  const result = { mapped: 0, recommended: 0, unmapped: 0, undecided: 0 };
  (session?.mappings || []).forEach(mapping => {
    if (mapping.state === DECISION.MAPPED) result.mapped += 1;
    else if (mapping.state === DECISION.RECOMMENDED) result.recommended += 1;
    else if (mapping.state === DECISION.UNMAPPED) result.unmapped += 1;
    else result.undecided += 1;
  });
  return result;
}



const MAPPED_STATES = new Set(['MAPPED', 'RECOMMENDED']);

function hasEnteredValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function blankValue(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function sameProjectedValue(left, right) {
  if (blankValue(left) && blankValue(right)) return true;
  return Object.is(left, right);
}

function ownValue(values, key) {
  return values && Object.prototype.hasOwnProperty.call(values, key);
}

function projectedRowValue(row, target = {}) {
  if (!row) return undefined;
  const projectionFieldId = target.projectionFieldId || target.id;
  if (projectionFieldId === 'supplyAmount') {
    if (!hasEnteredValue(row.quantity) || !hasEnteredValue(row.unitPrice)) return '';
    const amount = Number(row.quantity) * Number(row.unitPrice);
    return Object.is(amount, -0) ? 0 : amount;
  }
  if (target.custom) return row.customValues?.[target.id] ?? '';
  return row[projectionFieldId] ?? '';
}

function mappedRowMutationPlan({
  beforeRow = null,
  afterRow = null,
  targetDefinitions = [],
  mappings = [],
  displayValues = {},
  forceFieldIds = []
} = {}) {
  if (!afterRow?.rowId) return [];
  const targetById = new Map(targetDefinitions.map(target => [target.id, target]));
  const forced = new Set(forceFieldIds);
  return mappings
    .filter(mapping => MAPPED_STATES.has(mapping?.state))
    .map(mapping => {
      const target = targetById.get(mapping.targetFieldId);
      if (!target || target.scope !== 'voucher') return null;
      const projectionFieldId = target.projectionFieldId || target.id;
      const beforeValue = projectedRowValue(beforeRow, target);
      const afterValue = projectedRowValue(afterRow, target);
      if (!forced.has(target.id) && !forced.has(projectionFieldId) && sameProjectedValue(beforeValue, afterValue)) return null;
      const displayValue = ownValue(displayValues, target.id)
        ? displayValues[target.id]
        : (ownValue(displayValues, projectionFieldId) ? displayValues[projectionFieldId] : afterValue);
      return {
        targetFieldId: target.id,
        projectionFieldId,
        columnIndex: Number(mapping.columnIndex),
        displayValue: String(displayValue ?? ''),
        parsedValue: afterValue
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.columnIndex - right.columnIndex);
}

function applyMappedFieldUpdates(row, updates = []) {
  if (!row?.fieldValues || !updates.length) return row;
  let fieldValues = row.fieldValues;
  updates.forEach(update => {
    const tracked = fieldValues[update.targetFieldId];
    if (!tracked) return;
    if (fieldValues === row.fieldValues) fieldValues = { ...row.fieldValues };
    fieldValues[update.targetFieldId] = {
      ...tracked,
      currentDisplayValue: update.displayValue,
      parsedValue: update.parsedValue,
      edited: true
    };
  });
  return fieldValues === row.fieldValues ? row : { ...row, fieldValues };
}

const bulkPriceText = value => String(value ?? '').trim();

function parseBulkUnitPrice(displayValue) {
  const source = bulkPriceText(displayValue);
  if (!source) throw new Error('SMARTINPUT_BULK_PRICE_REQUIRED');
  const value = Number(source.replace(/[,원₩\s]/g, ''));
  if (!Number.isFinite(value)) throw new Error('SMARTINPUT_BULK_PRICE_INVALID');
  return Object.is(value, -0) ? 0 : value;
}

function applyBulkUnitPrice(rows = [], selectedRowIds = [], displayValue = '', options = {}) {
  const selected = new Set(selectedRowIds);
  const unitPrice = parseBulkUnitPrice(displayValue);
  const occurredAt = bulkPriceText(options.occurredAt) || new Date().toISOString();
  const actor = bulkPriceText(options.actor) || 'SMART_INPUT_ADMIN';
  const targetFieldId = bulkPriceText(options.targetFieldId);
  let affectedCount = 0;
  const nextRows = rows.map(source => {
    if (!selected.has(source.rowId)) return source;
    affectedCount += 1;
    const row = {
      ...source,
      unitPrice,
      sourceUnitPrice: bulkPriceText(displayValue),
      editedFields: { ...(source.editedFields || {}), unitPrice: true },
      bulkEditHistory: [
        ...(source.bulkEditHistory || []),
        { action: 'APPLY_UNIT_PRICE', before: source.unitPrice ?? null, after: unitPrice, displayValue: bulkPriceText(displayValue), occurredAt, actor }
      ]
    };
    if (targetFieldId && source.fieldValues?.[targetFieldId]) {
      row.fieldValues = {
        ...source.fieldValues,
        [targetFieldId]: {
          ...source.fieldValues[targetFieldId],
          currentDisplayValue: bulkPriceText(displayValue),
          parsedValue: unitPrice,
          edited: true
        }
      };
    }
    return row;
  });
  return { rows: nextRows, affectedCount, unitPrice };
}

return { hasMeaningfulSourceValue, sourceRowHasMeaningfulValue, resetInputMappingOptimizationMetrics, inputMappingOptimizationMetrics, headersAt, templateSignature, templateSignatureV2, detectHeaderRow, recommendMappings, createMappingSession, reassignHeaderRow, setColumnDecision, updateWorkingCells, updateWorkingCell, synchronizeWorkingRow, addManualRow, deleteWorkingRows, validateTemplateDraft, createTemplateRecord, projectMappedRows, mappingSummary, DECISION, SESSION_STATUS, projectedRowValue, mappedRowMutationPlan, applyMappedFieldUpdates, parseBulkUnitPrice, applyBulkUnitPrice };
})();

// ============================================================================
// grid-clipboard.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const gridClipboardSection = (() => {
const { hasMeaningfulSourceValue, sourceRowHasMeaningfulValue } = inputTemplateMapperSection;

const DUPLICATED_FIELD_TERM = /(코드|번호|수량|단가|가격|품목|상품|이름|규격|메모)\1+/g;
const SUMMARY_LABEL = /^(?:합계|총계|소계)\s*[:：]?\s*$/;
const FOOTER_LABEL = /^(?:출력일시|출력시간|인쇄일시|작성일시)(?:\s|[:：]|$)/;
const PRINTED_AT = /^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}(?:\s|\([^)]*\)).*(?:오전|오후|\d{1,2}:\d{2})/;

function cellText(value) {
  const normalized = String(value ?? '').normalize('NFKC');
  return hasMeaningfulSourceValue(normalized) ? normalized.trim() : '';
}

function normalizeStructuredFieldName(value) {
  return cellText(value)
    .toLowerCase()
    .replace(/[\s\r\n\t()[\]{}<>_'".,:;·•/\\\-]+/g, '')
    .replace(DUPLICATED_FIELD_TERM, '$1');
}

function fieldAliases(field) {
  return [field.id, field.label, ...(field.masterAliases || []), ...(field.inputAliases || [])]
    .map(normalizeStructuredFieldName)
    .filter(Boolean);
}

function buildStructuredFieldIndex(fieldDefinitions = []) {
  const index = new Map();
  fieldDefinitions.forEach(field => {
    fieldAliases(field).forEach(alias => {
      if (!index.has(alias)) index.set(alias, field);
    });
  });
  return index;
}

function resolveHeaderMappings(row, fieldIndex) {
  const mappedFields = new Set();
  const mappings = [];
  (row || []).forEach((cell, columnIndex) => {
    const field = fieldIndex.get(normalizeStructuredFieldName(cell));
    if (!field || mappedFields.has(field.id)) return;
    mappedFields.add(field.id);
    mappings.push({
      columnIndex,
      fieldId: field.id,
      label: field.label,
      valueType: field.valueType,
      sourceHeader: cellText(cell)
    });
  });
  return mappings;
}

function detectStructuredHeader(matrix = [], fieldDefinitions = [], { maxScanRows = 80 } = {}) {
  const fieldIndex = buildStructuredFieldIndex(fieldDefinitions);
  let best = null;
  matrix.slice(0, maxScanRows).forEach((row, rowIndex) => {
    const mappings = resolveHeaderMappings(row, fieldIndex);
    const identityCount = mappings.filter(mapping => ['itemCode', 'itemName'].includes(mapping.fieldId)).length;
    if (!identityCount || mappings.length < 2) return;
    const score = (mappings.length * 100) + identityCount;
    if (!best || score > best.score || (score === best.score && rowIndex < best.rowIndex)) {
      best = { rowIndex, rowNumber: rowIndex + 1, mappings, score };
    }
  });
  return best;
}

function isRepeatedHeader(row, fieldIndex) {
  const mappings = resolveHeaderMappings(row, fieldIndex);
  return mappings.length >= 2 && mappings.some(mapping => ['itemCode', 'itemName'].includes(mapping.fieldId));
}

function isFooterIdentity(itemCode, itemName, rawRow) {
  const identities = [
    itemCode,
    itemName,
    (rawRow || []).find(value => cellText(value))
  ].map(cellText).filter(Boolean);
  return identities.some(value => SUMMARY_LABEL.test(value) || FOOTER_LABEL.test(value) || PRINTED_AT.test(value));
}

function numericValue(value, numberParser) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof numberParser === 'function') return numberParser(value);
  const parsed = Number(cellText(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function matrixToSourceText(matrix = []) {
  return matrix.map(row => (row || []).map(cell => String(cell ?? '')).join('\t')).join('\n');
}

function parseStructuredSheet(matrix = [], {
  fieldDefinitions = [],
  numberParser,
  maxScanRows = 80,
  sheetName = ''
} = {}) {
  const rawText = matrixToSourceText(matrix);
  const firstRow = (matrix[0] || []).map(cellText);
  const schemaColumn = firstRow.indexOf('schemaVersion');
  const isPurchaseMeta = cellText(sheetName) === '_NEXUS_META'
    || (schemaColumn >= 0 && matrix.slice(1, 6).some(row => cellText(row?.[schemaColumn]) === 'ORDERQ_PURCHASE_META_V2'));
  const isSalesMeta = cellText(sheetName) === '_NEXUS_SALES_META'
    || (schemaColumn >= 0 && matrix.slice(1, 6).some(row => cellText(row?.[schemaColumn]) === 'ORDERQ_SALES_META_V1'));
  if (isPurchaseMeta || isSalesMeta) {
    return { structured: false, excluded: true, exclusionReason: isSalesMeta ? 'SALES_META' : 'PURCHASE_META', rawText, headerRowIndex: -1, headerRowNumber: 0, score: 0, mappings: [], rows: [], invalidCells: [] };
  }
  const header = detectStructuredHeader(matrix, fieldDefinitions, { maxScanRows });
  if (!header) {
    return {
      structured: false,
      rawText,
      headerRowIndex: -1,
      headerRowNumber: 0,
      score: 0,
      mappings: [],
      rows: [],
      invalidCells: []
    };
  }

  const fieldIndex = buildStructuredFieldIndex(fieldDefinitions);
  const invalidCells = [];
  const rows = [];
  let sourceVoucherIndex = 1;
  let boundaryPending = false;
  matrix.slice(header.rowIndex + 1).forEach((sourceRow, offset) => {
    if (isRepeatedHeader(sourceRow, fieldIndex)) {
      if (rows.length) sourceVoucherIndex += 1;
      boundaryPending = false;
      return;
    }
    const hasSourceValue = sourceRowHasMeaningfulValue(sourceRow);
    if (!hasSourceValue) {
      boundaryPending = Boolean(rows.length);
      return;
    }
    const rawItemCode = sourceRow?.[header.mappings.find(mapping => mapping.fieldId === 'itemCode')?.columnIndex] ?? '';
    const rawItemName = sourceRow?.[header.mappings.find(mapping => mapping.fieldId === 'itemName')?.columnIndex] ?? '';
    if (isFooterIdentity(rawItemCode, rawItemName, sourceRow)) {
      boundaryPending = Boolean(rows.length);
      return;
    }
    const values = {};
    const editedFields = {};
    header.mappings.forEach(mapping => {
      const rawValue = sourceRow?.[mapping.columnIndex] ?? '';
      const hasValue = cellText(rawValue) !== '';
      editedFields[mapping.fieldId] = true;
      if (mapping.fieldId === 'unitPrice') values.sourceUnitPrice = String(rawValue ?? '');
      if (!hasValue) {
        values[mapping.fieldId] = mapping.valueType === 'NUMBER' ? null : '';
        return;
      }
      if (mapping.valueType === 'NUMBER') {
        const parsed = numericValue(rawValue, numberParser);
        values[mapping.fieldId] = parsed;
        if (parsed === null) {
          invalidCells.push({
            rowNumber: header.rowIndex + offset + 2,
            columnIndex: mapping.columnIndex,
            fieldId: mapping.fieldId,
            value: cellText(rawValue)
          });
        }
      } else {
        values[mapping.fieldId] = cellText(rawValue);
      }
    });

    if (boundaryPending) {
      sourceVoucherIndex += 1;
      boundaryPending = false;
    }
    const sourceLineNo = header.rowIndex + offset + 2;
    rows.push({
      ...values,
      rawText: (sourceRow || []).map(cell => String(cell ?? '')).join('\t'),
      productText: values.itemName || '',
      sourceLineNo,
      sourceVoucherIndex: Number(values.sourceVoucherIndex) || sourceVoucherIndex,
      editedFields,
      matchStatus: 'UNRESOLVED'
    });
  });

  return {
    structured: true,
    rawText,
    headerRowIndex: header.rowIndex,
    headerRowNumber: header.rowNumber,
    score: header.score,
    mappings: header.mappings,
    rows,
    invalidCells
  };
}

// Clipboard input keeps original text; do not use source-header normalization here.
function clipboardCellText(value) {
  return String(value ?? '');
}

function normalizedNumber(value, numberParser) {
  if (!hasMeaningfulSourceValue(value)) return null;
  if (typeof numberParser === 'function') return numberParser(value);
  const number = Number(String(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function parseClipboardMatrix(rawText = '') {
  const source = String(rawText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === '\t') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  row.push(cell);
  rows.push(row);
  if (source.endsWith('\n') && rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
  return rows;
}

function buildGridPastePlan(rawText = '', {
  fieldDefinitions = [],
  visibleFieldIds = [],
  startFieldId = '',
  numberParser,
  requireHeaders = false,
  exactHeaders = []
} = {}) {
  const matrix = parseClipboardMatrix(rawText);
  const editableDefinitions = fieldDefinitions.filter(field => field?.editable !== false);
  const fieldById = new Map(editableDefinitions.map(field => [field.id, field]));
  const fieldIndex = buildStructuredFieldIndex(editableDefinitions);
  const usedFields = new Set();
  const headerErrors = [];
  const hasExactHeaderContract = exactHeaders.length > 0;
  const headerMappings = (matrix[0] || []).map((rawHeader, columnIndex) => {
    const sourceHeader = clipboardCellText(rawHeader).trim();
    const expectedHeader = exactHeaders[columnIndex];
    const exactFieldId = visibleFieldIds[columnIndex];
    const field = hasExactHeaderContract
      ? (sourceHeader === expectedHeader ? fieldById.get(exactFieldId) : null)
      : fieldIndex.get(normalizeStructuredFieldName(sourceHeader));
    if (!sourceHeader) {
      headerErrors.push({ columnIndex, header: '', reason: 'EMPTY_HEADER' });
      return null;
    }
    if (!field) {
      headerErrors.push({
        columnIndex,
        header: sourceHeader,
        expectedHeader: hasExactHeaderContract ? expectedHeader : undefined,
        reason: hasExactHeaderContract ? 'HEADER_MISMATCH' : 'UNKNOWN_HEADER'
      });
      return null;
    }
    if (usedFields.has(field.id)) {
      headerErrors.push({ columnIndex, header: sourceHeader, fieldId: field.id, reason: 'DUPLICATE_FIELD' });
      return null;
    }
    usedFields.add(field.id);
    return { columnIndex, fieldId: field.id, sourceHeader };
  }).filter(Boolean);

  if (hasExactHeaderContract && matrix[0]?.length !== exactHeaders.length) {
    headerErrors.push({
      columnIndex: Math.min(matrix[0]?.length || 0, exactHeaders.length),
      header: '',
      reason: 'HEADER_COUNT_MISMATCH',
      expectedColumnCount: exactHeaders.length,
      actualColumnCount: matrix[0]?.length || 0
    });
  }

  if (requireHeaders || (headerMappings.length >= 2 && !headerErrors.length)) {
    const invalidCells = [];
    const expectedColumnCount = (matrix[0] || []).length;
    const sourceRows = matrix.slice(1)
      .map((sourceRow, rowIndex) => ({ sourceRow, rowIndex }))
      .filter(({ sourceRow }) => sourceRowHasMeaningfulValue(sourceRow));
    const rowErrors = sourceRows.flatMap(({ sourceRow, rowIndex }) => (
      sourceRow.length === expectedColumnCount
        ? []
        : [{ rowNumber: rowIndex + 2, expectedColumnCount, actualColumnCount: sourceRow.length, reason: 'COLUMN_COUNT_MISMATCH' }]
    ));
    const rows = headerErrors.length || rowErrors.length ? [] : sourceRows.map(({ sourceRow, rowIndex }) => ({
      rawText: sourceRow.join('\t'),
      cells: headerMappings.map(mapping => {
        const definition = fieldById.get(mapping.fieldId);
        const rawValue = sourceRow[mapping.columnIndex] ?? '';
        if (definition?.valueType !== 'NUMBER') return { fieldId: mapping.fieldId, value: clipboardCellText(rawValue) };
        const value = normalizedNumber(rawValue, numberParser);
        if (hasMeaningfulSourceValue(rawValue) && value === null) {
          invalidCells.push({
            rowNumber: rowIndex + 2,
            columnIndex: mapping.columnIndex,
            fieldId: mapping.fieldId,
            value: clipboardCellText(rawValue)
          });
        }
        return { fieldId: mapping.fieldId, value };
      })
    }));
    return {
      kind: 'HEADER',
      valid: headerErrors.length === 0 && rowErrors.length === 0 && headerMappings.length > 0,
      matrix,
      headerRowNumber: 1,
      fieldIds: headerMappings.map(mapping => mapping.fieldId),
      rows,
      headerErrors,
      rowErrors,
      invalidCells,
      ignoredColumnCount: 0
    };
  }

  const orderedFields = visibleFieldIds.filter(fieldId => fieldById.has(fieldId));
  const startIndex = orderedFields.indexOf(startFieldId);
  const targetFields = startIndex >= 0 ? orderedFields.slice(startIndex) : [];
  const invalidCells = [];
  let ignoredColumnCount = 0;
  const rows = matrix
    .map((sourceRow, rowIndex) => ({ sourceRow, rowIndex }))
    .filter(({ sourceRow }) => sourceRowHasMeaningfulValue(sourceRow))
    .map(({ sourceRow, rowIndex }) => {
      ignoredColumnCount = Math.max(ignoredColumnCount, Math.max(0, sourceRow.length - targetFields.length));
      const cells = sourceRow.slice(0, targetFields.length).map((rawValue, columnIndex) => {
        const fieldId = targetFields[columnIndex];
        const definition = fieldById.get(fieldId);
        if (definition?.valueType !== 'NUMBER') return { fieldId, value: clipboardCellText(rawValue) };
        const value = normalizedNumber(rawValue, numberParser);
        if (hasMeaningfulSourceValue(rawValue) && value === null) {
          invalidCells.push({ rowNumber: rowIndex + 1, columnIndex, fieldId, value: clipboardCellText(rawValue) });
        }
        return { fieldId, value };
      });
      return { rawText: sourceRow.join('\t'), cells };
    });

  return {
    kind: 'POSITIONAL',
    valid: targetFields.length > 0,
    matrix,
    headerRowNumber: 0,
    fieldIds: targetFields,
    rows,
    headerErrors: [],
    rowErrors: [],
    invalidCells,
    ignoredColumnCount
  };
}

return { normalizeStructuredFieldName, buildStructuredFieldIndex, detectStructuredHeader, matrixToSourceText, parseStructuredSheet, parseClipboardMatrix, buildGridPastePlan };
})();

// ============================================================================
// input.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const inputSection = (() => {
const { hasMeaningfulSourceValue } = inputTemplateMapperSection;

// SmartInput owns text intake and pure parsing. No repository, network, or other app engine is loaded here.
const text = value => String(value ?? '').normalize('NFKC').trim();
const normalize = value => text(value).toLowerCase().replace(/\s+/g, '');

function unavailable(code, message) {
  return Object.assign(new Error(message), { code });
}

const KAKAO_HEADER = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/;

function normalizeSourceText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function stableHash(value) {
  let hash = 14695981039346656037n;
  for (const char of String(value)) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36).padStart(13, '0');
}

function createSourceMessageKey({ sourceType, sourceId, senderRaw, timestampRaw, rawText }) {
  const normalized = [sourceType, sourceId, senderRaw, timestampRaw, rawText]
    .map(value => normalizeSourceText(value).toLowerCase().replace(/\s+/g, ''))
    .join('|');
  return `SMK-${stableHash(normalized)}`;
}

function finalizeMessage(messages, current, sourceType, sourceId) {
  if (!current) return;
  const rawText = normalizeSourceText(current.lines.join('\n'));
  if (!rawText) return;
  const message = {
    messageId: `MSG-${messages.length + 1}`,
    sourceType,
    sourceId,
    senderRaw: normalizeSourceText(current.senderRaw),
    senderNormalized: normalizeSourceText(current.senderRaw).toLowerCase().replace(/\s+/g, ''),
    timestampRaw: normalizeSourceText(current.timestampRaw),
    rawText,
    lines: rawText.split('\n').map(line => line.trim()).filter(Boolean),
    contextIndex: messages.length
  };
  message.sourceMessageKey = createSourceMessageKey(message);
  messages.push(message);
}

function parseKakaoText(rawText, sourceId = '') {
  const sourceType = 'KAKAO_TEXT';
  const messages = [];
  let current = null;
  normalizeSourceText(rawText).split('\n').forEach(line => {
    const header = line.match(KAKAO_HEADER);
    if (header) {
      finalizeMessage(messages, current, sourceType, sourceId);
      current = { senderRaw: header[1], timestampRaw: header[2], lines: [header[3]] };
      return;
    }
    if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = { senderRaw: '', timestampRaw: '', lines: [line] };
    }
  });
  finalizeMessage(messages, current, sourceType, sourceId);
  return messages;
}

function parseGeneralText(rawText, sourceId = '') {
  const sourceType = 'GENERAL_TEXT';
  const messages = [];
  const blocks = normalizeSourceText(rawText).split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length > 1 ? lines : [block];
  });
  blocks.map(normalizeSourceText).filter(Boolean).forEach((text, index) => {
    const message = {
      messageId: `MSG-${index + 1}`,
      sourceType,
      sourceId,
      senderRaw: '',
      senderNormalized: '',
      timestampRaw: '',
      rawText: text,
      lines: text.split('\n').map(line => line.trim()).filter(Boolean),
      contextIndex: index
    };
    message.sourceMessageKey = createSourceMessageKey(message);
    messages.push(message);
  });
  return messages;
}

function parseSourceInput({ sourceType = 'KAKAO_TEXT', sourceId = '', rawText = '' }) {
  const normalizedType = String(sourceType || '').toUpperCase();
  return normalizedType === 'GENERAL_TEXT'
    ? parseGeneralText(rawText, sourceId)
    : parseKakaoText(rawText, sourceId);
}

const EVENT_TYPE = Object.freeze({
  ORDER: 'ORDER',
  ORDER_UPDATE: 'ORDER_UPDATE',
  ORDER_CANCEL: 'ORDER_CANCEL',
  NOTICE: 'NOTICE',
  INFORMATION: 'INFORMATION',
  ACK: 'ACK',
  UNKNOWN: 'UNKNOWN'
});

const ACK_PATTERN = /^(?:[/.]|ㅇ|네|넵|예|확인|감사|감사합니다|알겠습니다|ok|okay)$/i;
const UNIT_PATTERN = '(?:박스|box|ea|개|봉|팩|단|망|묶음|kg|키로|통|병|포|롤|장|대|판)';

function detectOrderEvent(rawText) {
  const text = String(rawText ?? '').normalize('NFKC').trim();
  const compact = text.replace(/\s+/g, ' ');
  const reasons = [];
  if (!compact) return { eventType: EVENT_TYPE.UNKNOWN, score: 0, reasons: ['EMPTY'] };
  if (ACK_PATTERN.test(compact.toLowerCase())) return { eventType: EVENT_TYPE.ACK, score: 1, reasons: ['ACK_EXACT'] };

  if (/(?:주문|발주).{0,8}(?:취소|철회)|(?:취소|빼\s*주세요|안\s*할게|필요\s*없)/i.test(compact)) {
    return { eventType: EVENT_TYPE.ORDER_CANCEL, score: 0.96, reasons: ['CANCEL_EXPRESSION'] };
  }
  if (/(?:주문|수량|품목).{0,8}(?:변경|수정)|(?:추가|대신).{0,10}(?:주세요|부탁)/i.test(compact)) {
    return { eventType: EVENT_TYPE.ORDER_UPDATE, score: 0.88, reasons: ['UPDATE_EXPRESSION'] };
  }

  const noticeShape = /(?:공지|안내|마감|휴무|입고예정|출고예정|오픈|도착|가능시간|까지).*(?:발주|주문|부탁)/i.test(compact)
    || /\d{1,2}\s*시\s*(?:전|까지).*(?:발주|주문)\s*부탁/i.test(compact);
  if (noticeShape) return { eventType: EVENT_TYPE.NOTICE, score: 0.94, reasons: ['NOTICE_SENTENCE'] };

  if (/^(?:[가-힣A-Za-z][가-힣A-Za-z()/_\-\s]*)\s+\d{3,7}\s*(?:원)?$/i.test(compact)
      || /(?:단가|가격|재고|시세|원입니다|원이에요)/i.test(compact)) {
    return { eventType: EVENT_TYPE.INFORMATION, score: 0.9, reasons: ['PRICE_OR_STOCK_INFORMATION'] };
  }

  const hasUnitQuantity = new RegExp(`\\d+(?:\\.\\d+)?\\s*${UNIT_PATTERN}(?:요|주세요)?(?:\\s|$)`, 'i').test(compact);
  const hasTerminalQuantity = /[가-힣A-Za-z][가-힣A-Za-z()/_\-\s]*\d+(?:\.\d+)?\s*(?:요|주세요)?$/i.test(compact);
  const hasMultilineItems = text.includes('\n') && text.split('\n').filter(line => /\d/.test(line)).length >= 1;
  if (hasUnitQuantity || hasTerminalQuantity || hasMultilineItems) {
    if (hasUnitQuantity) reasons.push('QUANTITY_WITH_UNIT');
    if (hasTerminalQuantity) reasons.push('PRODUCT_WITH_TERMINAL_QUANTITY');
    if (hasMultilineItems) reasons.push('MULTILINE_ITEMS');
    return { eventType: EVENT_TYPE.ORDER, score: hasUnitQuantity ? 0.9 : 0.82, reasons };
  }

  if (/(?:부탁드립니다|참고하세요|확인바랍니다|전달드립니다)/i.test(compact)) {
    return { eventType: EVENT_TYPE.NOTICE, score: 0.7, reasons: ['NOTICE_REQUEST_STYLE'] };
  }
  return { eventType: EVENT_TYPE.UNKNOWN, score: 0.35, reasons: ['INSUFFICIENT_EVIDENCE'] };
}

const UNIT_ALIASES = Object.freeze({
  box: 'BOX', 박스: '박스', ea: 'EA', 개: '개', 봉: '봉', 팩: '팩', 단: '단', 망: '망', 묶음: '묶음',
  kg: 'kg', 키로: '키로', 통: '통', 병: '병', 포: '포', 롤: '롤', 장: '장', 대: '대', 판: '판'
});
const UNIT_SOURCE = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');
const ACK_LINE = /^(?:[/.]|ㅇ|네|넵|예|확인|감사|감사합니다|알겠습니다)$/i;

function cleanLine(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/^[\-•·*]+\s*/, '').replace(/^\d+[.)]\s+/, '');
}

function parseOrderLine(rawLine) {
  const rawText = cleanLine(rawLine);
  if (!rawText || ACK_LINE.test(rawText)) return { rawText, excluded: true, reason: 'ACK_OR_EMPTY' };

  let working = rawText.replace(/(?:주세요|부탁드립니다|부탁해요|입니다|이에요|요)\s*$/i, '').trim();
  let contextReference = '';
  const contextMatch = working.match(/^(\d+\s*번)(?:\s+|$)/);
  if (contextMatch) {
    contextReference = contextMatch[1].replace(/\s+/g, '');
    working = working.slice(contextMatch[0].length).trim();
    if (!working) return { rawText, contextReference, excluded: true, reason: 'CONTEXT_REFERENCE_ONLY' };
  }

  let quantity = null;
  let rawUnit = '';
  const unitQuantity = working.match(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(${UNIT_SOURCE})$`, 'i'));
  if (unitQuantity) {
    quantity = Number(unitQuantity[1]);
    rawUnit = UNIT_ALIASES[unitQuantity[2].toLowerCase()] || unitQuantity[2];
    working = working.slice(0, unitQuantity.index).trim();
  } else {
    const terminalQuantity = working.match(/(-?\d+(?:\.\d+)?)$/);
    if (terminalQuantity) {
      quantity = Number(terminalQuantity[1]);
      working = working.slice(0, terminalQuantity.index).trim();
    }
  }

  let specText = '';
  const specMatch = working.match(/(\d+(?:\.\d+)?\s*(?:개입|수|입))(?=\s|[가-힣A-Za-z]|$)/i);
  if (specMatch) {
    specText = specMatch[1].replace(/\s+/g, '');
    working = `${working.slice(0, specMatch.index)} ${working.slice(specMatch.index + specMatch[0].length)}`.trim();
  }

  const attributeMatches = working.match(/(?:좋은\s*거|큰\s*거|작은\s*거|굵은\s*거|특품|상품)/g) || [];
  const attributeText = attributeMatches.join(' ').replace(/\s+/g, ' ').trim();
  if (attributeText) working = working.replace(/(?:좋은\s*거|큰\s*거|작은\s*거|굵은\s*거|특품|상품)/g, ' ');
  const productText = working.replace(/[,:;]+/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    rawText,
    productText,
    specText,
    attributeText,
    contextReference,
    quantity,
    rawUnit,
    finalUnit: rawUnit,
    excluded: quantity === null && !productText,
    reason: quantity === null ? 'QUANTITY_UNRESOLVED' : (productText ? 'PARSED' : 'CONTEXT_PRODUCT_UNRESOLVED')
  };
}

function parseOrderLines(rawText) {
  return String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(parseOrderLine)
    .filter(line => line.rawText && !(line.excluded && line.reason === 'ACK_OR_EMPTY'));
}

const ORDER_LIKE = new Set([EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE]);

function extractOrderMessages({ sourceType = 'KAKAO_TEXT', sourceId = '', rawText = '' } = {}) {
  return parseSourceInput({ sourceType, sourceId, rawText }).map(message => {
    const event = detectOrderEvent(message.rawText);
    return {
      message,
      event,
      parsedLines: ORDER_LIKE.has(event.eventType) ? parseOrderLines(message.rawText) : []
    };
  });
}

function extractOrderProductLines(input = {}) {
  let sourceLineNo = 0;
  return extractOrderMessages(input).flatMap(({ message, event, parsedLines }) => parsedLines.map(line => ({
    ...line,
    sourceLineNo: ++sourceLineNo,
    sourceMessageKey: message.sourceMessageKey,
    senderRaw: message.senderRaw,
    timestampRaw: message.timestampRaw,
    eventType: event.eventType
  })));
}

async function sha256(value) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(String(value ?? ''));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function splitTableRow(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return [];
  if (raw.includes('\t')) return raw.split('\t').map(text);
  if (raw.includes('|')) return raw.split('|').map(text).filter(Boolean);
  const cells = raw.split(/\s{2,}/).map(text).filter(Boolean);
  return cells.length >= 4 ? cells : [];
}

function parseStructuredOrderText(rawText) {
  const lines = String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    const normalized = cells.map(normalize);
    if (cells.length >= 3 && normalized.some(value => value.includes('상품명') || value.includes('품목명'))
      && normalized.some(value => value.includes('수량'))) {
      headerIndex = index;
      headers = normalized;
      break;
    }
  }
  if (headerIndex < 0) return { detected: false, rows: [], analysisText: text(rawText) };
  const column = names => headers.findIndex(header => names.some(name => header.includes(name)));
  const productIndex = column(['상품명', '품목명', '상품']);
  const specIndex = column(['규격', '단위']);
  const quantityIndex = column(['수량']);
  const priceIndex = column(['판매가', '단가']);
  const rows = lines.slice(headerIndex + 1).flatMap(line => {
    if (/^(닫기|합계|총합)$/i.test(line)) return [];
    const cells = splitTableRow(line);
    if (cells.length <= Math.max(productIndex, quantityIndex)) return [];
    const quantity = Number(String(cells[quantityIndex]).replace(/[,원₩]/g, ''));
    if (!text(cells[productIndex]) || !Number.isFinite(quantity)) return [];
    const specification = specIndex >= 0 ? text(cells[specIndex]) : '';
    const unit = /^(box|ea)$/i.test(specification) ? specification.toUpperCase() : '';
    const unitPriceValue = priceIndex >= 0 ? Number(String(cells[priceIndex]).replace(/[,원₩]/g, '')) : NaN;
    return [{ productText: text(cells[productIndex]), specification, unit, quantity, unitPrice: Number.isFinite(unitPriceValue) ? unitPriceValue : null }];
  });
  return {
    detected: rows.length > 0,
    rows,
    analysisText: rows.map(row => `${row.productText}${row.specification && !row.unit ? ` ${row.specification}` : ''} ${row.quantity}${row.unit ? ` ${row.unit}` : ''}`).join('\n')
  };
}

function isSelectableMasterProduct(product = {}) {
  return Boolean(text(product.productId || product.itemCode || product.itemName))
    && text(product.status || 'ACTIVE').toUpperCase() !== 'INACTIVE'
    && product.active !== false;
}


const INPUT_MATCHING_CONTEXT = Symbol('SmartInput matching context');
const normalizeMatchText = value => normalize(value).replace(/[\u200b-\u200d\ufeff]/g, '');

function productSimilarity(left, right) {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.92;
  const previous = new Array(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const upper = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = upper;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length, 1);
}

function suppliedRows(rows, companyId) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object'
    && (!text(row.companyId) || text(row.companyId) === companyId)).map(row => ({ ...row }));
}

// One immutable input batch prepares the product identity map and dictionary once.
// Optional history is an owner-issued snapshot of item rows with customerId already resolved.
function createInputMatchingContext(input = {}) {
  if (input?.[INPUT_MATCHING_CONTEXT]) return input;
  const companyId = text(input?.companyId);
  const products = suppliedRows(input?.products, companyId);
  const mappings = suppliedRows(input?.mappings, companyId);
  const history = suppliedRows(input?.history, companyId);
  const productById = new Map(products.filter(product => text(product.productId)).map(product => [product.productId, product]));
  const mappingsByText = new Map();
  mappings.forEach(mapping => {
    if ((mapping.status || 'ACTIVE') !== 'ACTIVE') return;
    const key = normalizeMatchText(mapping.normalizedText || mapping.rawText);
    if (!mappingsByText.has(key)) mappingsByText.set(key, []);
    mappingsByText.get(key).push(mapping);
  });
  const historyByCustomer = new Map();
  history.forEach(item => {
    if (!historyByCustomer.has(item.customerId)) historyByCustomer.set(item.customerId, []);
    historyByCustomer.get(item.customerId).push(item);
  });
  return { [INPUT_MATCHING_CONTEXT]: true, companyId, revision: input?.revision ?? '',
    products, productById, mappingsByText, historyByCustomer, candidateCache: new Map() };
}

function inputProductShape(product = {}, mapping = {}, context) {
  const requestedId = mapping.productId || product.productId || '';
  return {
    productId: context.productById.has(requestedId) ? requestedId : '',
    itemCode: mapping.itemCode || product.itemCode || product.productCode || '',
    itemName: mapping.itemName || product.itemName || product.productName || '',
    specification: mapping.specification || product.specification || '',
    finalUnit: mapping.finalUnit || product.unit || product.finalUnit || ''
  };
}

function generateInputProductCandidates({ productText, customerId = '', sourceId = '' } = {}, matchingContext = {}) {
  const context = createInputMatchingContext(matchingContext);
  const normalized = normalizeMatchText(productText);
  if (!normalized) return [];
  const cacheKey = JSON.stringify([normalized, customerId, sourceId]);
  if (context.candidateCache.has(cacheKey)) return context.candidateCache.get(cacheKey).map(candidate => ({ ...candidate }));
  const candidates = [];
  const add = (shape, score, source) => {
    if (!shape.productId && !shape.itemCode && !shape.itemName) return;
    candidates.push({ ...shape, score, source });
  };
  (context.mappingsByText.get(normalized) || []).forEach(mapping => {
    const product = context.productById.get(mapping.productId) || {};
    if (customerId && mapping.customerId === customerId) add(inputProductShape(product, mapping, context), 1, 'CUSTOMER_MAPPING');
    else if (sourceId && mapping.sourceId === sourceId) add(inputProductShape(product, mapping, context), 0.98, 'SOURCE_MAPPING');
    else if (!mapping.customerId && !mapping.sourceId) add(inputProductShape(product, mapping, context), 0.96, 'COMMON_MAPPING');
  });
  if (customerId) {
    (context.historyByCustomer.get(customerId) || []).forEach(item => {
      const score = productSimilarity(productText, item.itemName);
      if (score >= 0.72) add(inputProductShape(item, item, context), Math.min(0.94, 0.78 + score * 0.16), 'CUSTOMER_HISTORY');
    });
  }
  context.products.forEach(product => {
    const score = productSimilarity(productText, product.itemName || product.productName);
    if (score >= 0.58) add(inputProductShape(product, {}, context), score === 1 ? 0.94 : 0.52 + score * 0.38, score === 1 ? 'MASTER_EXACT' : 'MASTER_FUZZY');
  });
  const byIdentity = new Map();
  candidates.forEach(candidate => {
    const key = candidate.productId || candidate.itemCode || normalizeMatchText(candidate.itemName);
    const previous = byIdentity.get(key);
    if (!previous || candidate.score > previous.score) byIdentity.set(key, candidate);
  });
  const result = [...byIdentity.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  context.candidateCache.set(cacheKey, result);
  return result.map(candidate => ({ ...candidate }));
}

function matchLine(line, customer = null, sourceId = 'SMART_INPUT', matchingContext = {}) {
  const candidates = line.excluded ? [] : generateInputProductCandidates({
    productText: line.productText || line.itemName || line.rawExpression,
    customerId: text(customer?.customerId), sourceId
  }, matchingContext);
  if (line.excluded) return { ...line, candidateProducts: candidates, matchStatus: 'EXCLUDED', matchSource: line.reason || 'EXCLUDED' };
  const best = candidates[0] || null;
  const autoMatched = best && best.score >= 0.94 && best.productId;
  if (!autoMatched) {
    return { ...line, candidateProducts: candidates, matchStatus: 'MATCH_FAILED',
      matchSource: best ? 'CANDIDATE_REVIEW_REQUIRED' : 'NO_CANDIDATE',
      productId: '', confirmedProductId: '', itemCode: '', itemName: '' };
  }
  return { ...line, candidateProducts: candidates, matchStatus: 'MATCHED', matchSource: best.source,
    confirmedProductId: best.productId, productId: best.productId, itemCode: best.itemCode, itemName: best.itemName,
    specification: line.specText || best.specification || '', finalUnit: best.finalUnit || line.rawUnit || '' };
}

async function rematchExtractedLinesForCustomer(lines, customer, sourceId = 'SMART_INPUT', matchingContext = {}) {
  if (!customer?.customerId || !customer?.customerName) throw unavailable('CUSTOMER_REQUIRED', '거래처를 먼저 선택하세요.');
  const context = createInputMatchingContext(matchingContext);
  return (lines || []).map(line => ({
    ...matchLine(line, customer, sourceId, context),
    customerId: customer.customerId, customerName: customer.customerName
  }));
}

async function captureTextIntake(input = {}) {
  if (!text(input.rawText)) throw unavailable('SMARTINPUT_SOURCE_EMPTY', '분석할 원문을 입력하세요.');
  const fingerprint = await sha256(`${input.sourceType || 'GENERAL_TEXT'}|${input.sourceId || 'SMART_INPUT'}|${input.rawText}`);
  const sessionId = `SI-LOCAL-${fingerprint.slice(0, 24)}`;
  const sourcePartId = `SI-PART-${fingerprint.slice(0, 24)}`;
  const imageHash = text(input.imageEvidence?.contentHash);
  return {
    session: {
      intakeSessionId: sessionId,
      sourceType: text(input.sourceType || 'GENERAL_TEXT'),
      sourceId: text(input.sourceId || 'SMART_INPUT'),
      sourceOccurrenceKey: text(input.captureOccurrenceId || fingerprint),
      rawFingerprint: fingerprint,
      localOnly: true
    },
    sourcePart: { sourcePartId, rawText: String(input.rawText), contentHash: fingerprint, localOnly: true },
    imagePart: imageHash ? { sourcePartId: `SI-IMAGE-${imageHash.slice(0, 24)}`, contentHash: imageHash, localOnly: true } : null
  };
}

async function analyzeSingleOrderDocument(input = {}) {
  const matchingContext = createInputMatchingContext(input.matchingContext);
  const rawText = String(input.rawText || '');
  const structured = parseStructuredOrderText(rawText);
  const customer = input.customerOverride?.customerId && input.customerOverride?.customerName ? input.customerOverride : null;
  let parserText = structured.detected ? structured.analysisText : rawText;
  let sourceType = text(input.session?.sourceType || 'GENERAL_TEXT').toUpperCase();
  if (sourceType !== 'KAKAO_TEXT') {
    const lines = parserText.split(/\r?\n/).filter(value => value.trim());
    const sender = customer?.customerName || (!structured.detected && sourceType === 'GENERAL_TEXT' ? text(lines.shift()) : '') || 'SMART INPUT';
    parserText = `[${sender}] [SMART INPUT] ${lines.join('\n')}`;
    sourceType = 'KAKAO_TEXT';
  }
  const extracted = extractOrderProductLines({ sourceType, sourceId: input.session?.sourceId || 'SMART_INPUT', rawText: parserText });
  const lines = await Promise.all(extracted.map(async (line, index) => {
    const structuredRow = structured.rows[index] || null;
    const enriched = {
      ...line,
      productText: structuredRow?.productText || line.productText,
      specification: structuredRow?.specification || line.specification || line.specText || '',
      quantity: structuredRow?.quantity ?? line.quantity,
      unit: structuredRow?.unit || line.finalUnit || line.rawUnit || '',
      unitPrice: structuredRow?.unitPrice ?? line.unitPrice ?? null,
      rawExpression: line.rawText || line.productText
    };
    const matched = await matchLine(enriched, customer, input.session?.sourceId || 'SMART_INPUT', matchingContext);
    const productId = matched.productId || matched.confirmedProductId || '';
    return {
      ...matched,
      sourcePartId: input.sourcePart?.sourcePartId || '',
      sourceLineKey: `${input.session?.intakeSessionId || 'SI-LOCAL'}:${line.sourceMessageKey}:${index + 1}`,
      itemName: matched.itemName || enriched.productText,
      productId: productId || null,
      matchStatus: enriched.excluded ? 'EXCLUDED' : (productId ? 'MATCHED' : 'MATCH_FAILED'),
      reviewStatus: enriched.excluded ? 'EXCLUDED' : 'PENDING',
      productIdentityStatus: productId ? 'MASTER_LINKED' : 'UNRESOLVED'
    };
  }));
  if (!lines.length) throw unavailable('SMARTINPUT_PARSER_NO_ROWS', '상품 행을 인식하지 못했습니다. 상품명과 수량을 확인해 주세요.');
  const documentHash = await sha256(`${input.session?.intakeSessionId || ''}|${rawText}`);
  const document = {
    intakeDocumentId: `SI-DOC-${documentHash.slice(0, 24)}`,
    intakeSessionId: input.session?.intakeSessionId || '',
    revision: 1,
    confirmedCustomerId: customer?.customerId || '',
    confirmedCustomerName: customer?.customerName || '',
    localOnly: true
  };
  return { analysis: { results: [], localOnly: true }, document, lines, detectedInputType: structured.detected ? 'SHOP_TABLE' : sourceType };
}


const MEANINGFUL_ROW_FIELDS = Object.freeze([
  'productId', 'masterProductId', 'itemCode', 'itemName', 'secondaryName', 'searchInfo',
  'unregisteredProductQuery', 'specification', 'boxQuantity', 'quantity', 'unit', 'unitPrice',
  'sourceUnitPrice', 'outPrice', 'wholesaleA', 'wholesaleB', 'listingPrice', 'marketPrice',
  'promoPrice', 'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI',
  'memo', 'memo2', 'description', 'rowCustomerCode', 'rowCustomerId', 'rowCustomerName',
  'saleAmount1', 'saleAmount2', 'saleMemo3',
  'deliveryCustomerId', 'deliveryCustomerCode', 'deliveryCustomerName', 'billingCustomerId',
  'billingCustomerCode', 'billingCustomerName', 'supplierCustomerId', 'supplierCustomerCode',
  'supplierCustomerName', 'salesCustomerId', 'salesCustomerCode', 'salesCustomerName',
  'rowVoucherDate', 'rowDeliveryDate', 'rowWarehouseId', 'rowWarehouseCode', 'rowVoucherNo'
]);

function hasEnteredValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return hasMeaningfulSourceValue(value);
  if (typeof value === 'number') return Number.isFinite(value);
  return Boolean(value);
}

function rowHasMeaningfulInput(row = {}) {
  return MEANINGFUL_ROW_FIELDS.some(field => hasEnteredValue(row[field]))
    || hasEnteredValue(row.rawText)
    || Object.values(row.customValues || {}).some(hasEnteredValue);
}

function rowHasLinkedSource(row = {}) {
  return Boolean(row.linkedSourceRefs?.length || (row.linkedSourceEstimateId && row.linkedSourceRowId));
}

function compactRowBlankValues(row) {
  if (!row?.customValues || typeof row.customValues !== 'object') return row;
  row.customValues = Object.fromEntries(Object.entries(row.customValues).filter(([, value]) => hasEnteredValue(value)));
  return row;
}

function pruneEmptyWorkRows(current) {
  if (!current?.rows) return false;
  const before = current.rows.length;
  current.rows = current.rows.filter(rowHasMeaningfulInput).map(compactRowBlankValues);
  return before !== current.rows.length;
}

function manualLinkedRows(rows = []) {
  return rows.filter(row => !rowHasLinkedSource(row) && rowHasMeaningfulInput(row));
}

return { normalizeSourceText, createSourceMessageKey, parseKakaoText, parseGeneralText, parseSourceInput, EVENT_TYPE, detectOrderEvent, parseOrderLine, parseOrderLines, extractOrderMessages, extractOrderProductLines, isSelectableMasterProduct, createInputMatchingContext, generateInputProductCandidates, rematchExtractedLinesForCustomer, captureTextIntake, analyzeSingleOrderDocument, hasEnteredValue, rowHasMeaningfulInput, rowHasLinkedSource, compactRowBlankValues, pruneEmptyWorkRows, manualLinkedRows };
})();

// Public API (same functions and constants; no additional command layer).
export const ESTIMATE_REPORT_PRESET_ID = estimateReportPresetSection.ESTIMATE_REPORT_PRESET_ID;
export const ESTIMATE_REPORT_PRESET_NAME = estimateReportPresetSection.ESTIMATE_REPORT_PRESET_NAME;
export const ESTIMATE_REPORT_FIELDS = estimateReportPresetSection.ESTIMATE_REPORT_FIELDS;
export const ESTIMATE_REPORT_HEADERS = estimateReportPresetSection.ESTIMATE_REPORT_HEADERS;
export const isEstimateReportHeaders = estimateReportPresetSection.isEstimateReportHeaders;
export const isEstimateReportMetadataRow = estimateReportPresetSection.isEstimateReportMetadataRow;
export const estimateReportField = estimateReportPresetSection.estimateReportField;
export const createEstimateReportPreset = estimateReportPresetSection.createEstimateReportPreset;
export const ERP_ESTIMATE_HEADERS = estimateReportPresetSection.ERP_ESTIMATE_HEADERS;
export const isEstimateWorkbookItemRow = estimateReportPresetSection.isEstimateWorkbookItemRow;
export const inspectEstimateWorkbookCandidate = estimateReportPresetSection.inspectEstimateWorkbookCandidate;
export const chooseEstimateWorkbookCandidate = estimateReportPresetSection.chooseEstimateWorkbookCandidate;
export const hasMeaningfulSourceValue = inputTemplateMapperSection.hasMeaningfulSourceValue;
export const sourceRowHasMeaningfulValue = inputTemplateMapperSection.sourceRowHasMeaningfulValue;
export const resetInputMappingOptimizationMetrics = inputTemplateMapperSection.resetInputMappingOptimizationMetrics;
export const inputMappingOptimizationMetrics = inputTemplateMapperSection.inputMappingOptimizationMetrics;
export const headersAt = inputTemplateMapperSection.headersAt;
export const templateSignature = inputTemplateMapperSection.templateSignature;
export const templateSignatureV2 = inputTemplateMapperSection.templateSignatureV2;
export const detectHeaderRow = inputTemplateMapperSection.detectHeaderRow;
export const recommendMappings = inputTemplateMapperSection.recommendMappings;
export const createMappingSession = inputTemplateMapperSection.createMappingSession;
export const reassignHeaderRow = inputTemplateMapperSection.reassignHeaderRow;
export const setColumnDecision = inputTemplateMapperSection.setColumnDecision;
export const updateWorkingCells = inputTemplateMapperSection.updateWorkingCells;
export const updateWorkingCell = inputTemplateMapperSection.updateWorkingCell;
export const synchronizeWorkingRow = inputTemplateMapperSection.synchronizeWorkingRow;
export const addManualRow = inputTemplateMapperSection.addManualRow;
export const deleteWorkingRows = inputTemplateMapperSection.deleteWorkingRows;
export const validateTemplateDraft = inputTemplateMapperSection.validateTemplateDraft;
export const createTemplateRecord = inputTemplateMapperSection.createTemplateRecord;
export const projectMappedRows = inputTemplateMapperSection.projectMappedRows;
export const mappingSummary = inputTemplateMapperSection.mappingSummary;
export const DECISION = inputTemplateMapperSection.DECISION;
export const SESSION_STATUS = inputTemplateMapperSection.SESSION_STATUS;
export const projectedRowValue = inputTemplateMapperSection.projectedRowValue;
export const mappedRowMutationPlan = inputTemplateMapperSection.mappedRowMutationPlan;
export const applyMappedFieldUpdates = inputTemplateMapperSection.applyMappedFieldUpdates;
export const parseBulkUnitPrice = inputTemplateMapperSection.parseBulkUnitPrice;
export const applyBulkUnitPrice = inputTemplateMapperSection.applyBulkUnitPrice;
export const normalizeStructuredFieldName = gridClipboardSection.normalizeStructuredFieldName;
export const buildStructuredFieldIndex = gridClipboardSection.buildStructuredFieldIndex;
export const detectStructuredHeader = gridClipboardSection.detectStructuredHeader;
export const matrixToSourceText = gridClipboardSection.matrixToSourceText;
export const parseStructuredSheet = gridClipboardSection.parseStructuredSheet;
export const parseClipboardMatrix = gridClipboardSection.parseClipboardMatrix;
export const buildGridPastePlan = gridClipboardSection.buildGridPastePlan;
export const normalizeSourceText = inputSection.normalizeSourceText;
export const createSourceMessageKey = inputSection.createSourceMessageKey;
export const parseKakaoText = inputSection.parseKakaoText;
export const parseGeneralText = inputSection.parseGeneralText;
export const parseSourceInput = inputSection.parseSourceInput;
export const EVENT_TYPE = inputSection.EVENT_TYPE;
export const detectOrderEvent = inputSection.detectOrderEvent;
export const parseOrderLine = inputSection.parseOrderLine;
export const parseOrderLines = inputSection.parseOrderLines;
export const extractOrderMessages = inputSection.extractOrderMessages;
export const extractOrderProductLines = inputSection.extractOrderProductLines;
export const isSelectableMasterProduct = inputSection.isSelectableMasterProduct;
export const createInputMatchingContext = inputSection.createInputMatchingContext;
export const generateInputProductCandidates = inputSection.generateInputProductCandidates;
export const rematchExtractedLinesForCustomer = inputSection.rematchExtractedLinesForCustomer;
export const captureTextIntake = inputSection.captureTextIntake;
export const analyzeSingleOrderDocument = inputSection.analyzeSingleOrderDocument;
export const hasEnteredValue = inputSection.hasEnteredValue;
export const rowHasMeaningfulInput = inputSection.rowHasMeaningfulInput;
export const rowHasLinkedSource = inputSection.rowHasLinkedSource;
export const compactRowBlankValues = inputSection.compactRowBlankValues;
export const pruneEmptyWorkRows = inputSection.pruneEmptyWorkRows;
export const manualLinkedRows = inputSection.manualLinkedRows;
