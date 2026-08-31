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

function cloneMatrix(matrix = []) {
  return (Array.isArray(matrix) ? matrix : []).map(row => (
    Array.isArray(row) ? row.map(cellText) : [cellText(row)]
  ));
}

function columnCount(matrix, headerRowIndex) {
  return Math.max(
    matrix[headerRowIndex]?.length || 0,
    ...matrix.slice(headerRowIndex + 1).map(row => row.length),
    0
  );
}

export function headersAt(matrix = [], headerRowIndex = 0) {
  const source = cloneMatrix(matrix);
  if (!source.length) return [];
  const safeIndex = Math.max(0, Math.min(source.length - 1, Number(headerRowIndex) || 0));
  const width = columnCount(source, safeIndex);
  return Array.from({ length: width }, (_, columnIndex) => cellText(source[safeIndex]?.[columnIndex]));
}

export function templateSignature(headers = []) {
  return JSON.stringify((Array.isArray(headers) ? headers : []).map(cellText));
}

export function detectHeaderRow(matrix = [], targetDefinitions = [], { maxScanRows = 80 } = {}) {
  const source = cloneMatrix(matrix);
  const targetLabels = new Set((targetDefinitions || []).map(target => cellText(target?.label)).filter(Boolean));
  let best = null;
  source.slice(0, Math.max(1, maxScanRows)).forEach((row, rowIndex) => {
    const nonEmpty = row.filter(value => value !== '').length;
    if (nonEmpty < 2) return;
    const exactTargets = row.filter(value => targetLabels.has(value)).length;
    const textCells = row.filter(value => value !== '' && !Number.isFinite(Number(value.replace(/,/g, '')))).length;
    const followingRows = source.slice(rowIndex + 1, rowIndex + 4).filter(candidate => candidate.some(value => value !== '')).length;
    const score = (exactTargets * 1000) + (textCells * 20) + (nonEmpty * 5) + followingRows - rowIndex;
    if (!best || score > best.score) best = { rowIndex, rowNumber: rowIndex + 1, score, exactTargets, nonEmpty };
  });
  return best || { rowIndex: 0, rowNumber: 1, score: 0, exactTargets: 0, nonEmpty: source[0]?.filter(Boolean).length || 0 };
}

function targetIndex(targetDefinitions = []) {
  return new Map((targetDefinitions || []).filter(target => target?.id).map(target => [target.id, target]));
}

function mappingValidation(mappings = [], targetDefinitions = []) {
  const targets = targetIndex(targetDefinitions);
  const used = new Map();
  const issues = [];
  mappings.forEach((mapping, columnIndex) => {
    const state = mapping?.state;
    if (![DECISION.MAPPED, DECISION.UNMAPPED].includes(state)) {
      issues.push({ code: 'UNDECIDED_COLUMN', columnIndex });
      return;
    }
    if (state === DECISION.UNMAPPED) return;
    if (!targets.has(mapping.targetFieldId)) {
      issues.push({ code: 'TARGET_MISSING', columnIndex, targetFieldId: mapping.targetFieldId || '' });
      return;
    }
    if (used.has(mapping.targetFieldId)) {
      issues.push({
        code: 'TARGET_DUPLICATED',
        columnIndex,
        otherColumnIndex: used.get(mapping.targetFieldId),
        targetFieldId: mapping.targetFieldId
      });
      return;
    }
    used.set(mapping.targetFieldId, columnIndex);
  });
  return { valid: issues.length === 0, issues };
}

export function recommendMappings(headers = [], targetDefinitions = []) {
  const sourceCounts = new Map();
  headers.forEach(header => sourceCounts.set(cellText(header), (sourceCounts.get(cellText(header)) || 0) + 1));
  const targetCounts = new Map();
  targetDefinitions.forEach(target => {
    const label = cellText(target?.label);
    if (label) targetCounts.set(label, (targetCounts.get(label) || 0) + 1);
  });
  const targetByLabel = new Map(targetDefinitions.filter(target => target?.id).map(target => [cellText(target.label), target]));
  return headers.map((header, columnIndex) => {
    const sourceHeader = cellText(header);
    const target = targetByLabel.get(sourceHeader);
    const unique = sourceHeader !== '' && sourceCounts.get(sourceHeader) === 1 && targetCounts.get(sourceHeader) === 1;
    return unique && target
      ? { columnIndex, sourceHeader, state: DECISION.RECOMMENDED, targetFieldId: target.id }
      : { columnIndex, sourceHeader, state: DECISION.UNDECIDED, targetFieldId: '' };
  });
}

function normalizeStoredMappings(template, headers) {
  const mappings = Array.isArray(template?.mappings) ? template.mappings : [];
  return headers.map((sourceHeader, columnIndex) => {
    const stored = mappings.find(mapping => Number(mapping.columnIndex) === columnIndex);
    if (!stored) return { columnIndex, sourceHeader, state: DECISION.UNDECIDED, targetFieldId: '' };
    return {
      columnIndex,
      sourceHeader,
      state: stored.state === DECISION.UNMAPPED ? DECISION.UNMAPPED : DECISION.MAPPED,
      targetFieldId: stored.state === DECISION.UNMAPPED ? '' : cellText(stored.targetFieldId)
    };
  });
}

function resolveTemplate(headers, templates = [], targetDefinitions = []) {
  const signature = templateSignature(headers);
  const matches = (templates || []).filter(template => template?.signature === signature
    || templateSignature(template?.headers || []) === signature);
  if (matches.length > 1) {
    return {
      status: SESSION_STATUS.TEMPLATE_CONFLICT,
      template: null,
      mappings: recommendMappings(headers, targetDefinitions),
      issues: [{ code: 'TEMPLATE_SIGNATURE_DUPLICATED', templateIds: matches.map(template => template.templateId) }]
    };
  }
  if (!matches.length) {
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

function workingRows(sourceMatrix, headerRowIndex, headers, editJournal = {}, manualRows = []) {
  const width = headers.length;
  const hasWorkingValue = value => cellText(value).trim() !== '';
  const sourceRows = sourceMatrix.slice(headerRowIndex + 1).map((sourceRow, offset) => {
    const sourceRowIndex = headerRowIndex + 1 + offset;
    const cells = Array.from({ length: width }, (_, columnIndex) => {
      const key = `${sourceRowIndex}:${columnIndex}`;
      return Object.prototype.hasOwnProperty.call(editJournal, key)
        ? cellText(editJournal[key])
        : cellText(sourceRow[columnIndex]);
    });
    return { rowId: `source-${sourceRowIndex}`, sourceRowIndex, cells, manual: false };
  }).filter(row => row.cells.some(hasWorkingValue));
  const manual = (manualRows || []).map((row, index) => ({
    rowId: cellText(row?.rowId) || `manual-${index + 1}`,
    sourceRowIndex: null,
    cells: Array.from({ length: width }, (_, columnIndex) => cellText(row?.cells?.[columnIndex])),
    manual: true
  })).filter(row => row.cells.some(hasWorkingValue));
  return [...sourceRows, ...manual];
}

function activeWorkingRows(session, editJournal = session?.editJournal, manualRows = session?.manualRows) {
  const deletedSourceRows = new Set(session?.deletedSourceRows || []);
  return workingRows(
    session?.sourceMatrix || [],
    session?.headerRowIndex || 0,
    session?.headers || [],
    editJournal || {},
    manualRows || []
  ).filter(row => row.manual || !deletedSourceRows.has(row.sourceRowIndex));
}

export function createMappingSession({
  matrix = [],
  headerRowIndex = 0,
  templates = [],
  targetDefinitions = [],
  fileName = '',
  sheetName = '',
  fileFingerprint = '',
  editJournal = {},
  manualRows = [],
  hiddenColumns = []
} = {}) {
  const sourceMatrix = cloneMatrix(matrix);
  const safeIndex = sourceMatrix.length
    ? Math.max(0, Math.min(sourceMatrix.length - 1, Number(headerRowIndex) || 0))
    : 0;
  const headers = headersAt(sourceMatrix, safeIndex);
  const resolved = resolveTemplate(headers, templates, targetDefinitions);
  return {
    schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V1',
    fileName: cellText(fileName),
    sheetName: cellText(sheetName),
    fileFingerprint: cellText(fileFingerprint),
    sourceMatrix,
    headerRowIndex: safeIndex,
    headers,
    signature: templateSignature(headers),
    status: resolved.status,
    templateId: cellText(resolved.template?.templateId),
    templateName: cellText(resolved.template?.templateName),
    templateRevision: Number(resolved.template?.revision || 0),
    mappings: resolved.mappings,
    issues: resolved.issues,
    editJournal: { ...(editJournal || {}) },
    manualRows: (manualRows || []).map(row => ({ ...row, cells: [...(row.cells || [])] })),
    hiddenColumns: [...new Set((hiddenColumns || []).map(Number).filter(Number.isInteger))],
    workingRows: workingRows(sourceMatrix, safeIndex, headers, editJournal, manualRows),
    updatedAt: new Date().toISOString()
  };
}

export function reassignHeaderRow(session, headerRowIndex, templates = [], targetDefinitions = []) {
  const reassigned = createMappingSession({
    matrix: session?.sourceMatrix || [],
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

export function setColumnDecision(session, columnIndex, decision, targetFieldId = '', targetDefinitions = []) {
  if (!session || !Array.isArray(session.mappings)) throw new Error('MAPPING_SESSION_REQUIRED');
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= session.mappings.length) throw new Error('MAPPING_COLUMN_INVALID');
  if (![DECISION.MAPPED, DECISION.UNMAPPED].includes(decision)) throw new Error('MAPPING_DECISION_INVALID');
  const mappings = session.mappings.map(mapping => ({ ...mapping }));
  if (decision === DECISION.MAPPED) {
    const targets = targetIndex(targetDefinitions);
    if (!targets.has(targetFieldId)) throw new Error('MAPPING_TARGET_MISSING');
    const duplicate = mappings.find(mapping => mapping.columnIndex !== columnIndex
      && [DECISION.MAPPED, DECISION.RECOMMENDED].includes(mapping.state)
      && mapping.targetFieldId === targetFieldId);
    if (duplicate) {
      const error = new Error('MAPPING_TARGET_DUPLICATED');
      error.otherColumnIndex = duplicate.columnIndex;
      throw error;
    }
    mappings[columnIndex] = { ...mappings[columnIndex], state: DECISION.MAPPED, targetFieldId };
  } else {
    mappings[columnIndex] = { ...mappings[columnIndex], state: DECISION.UNMAPPED, targetFieldId: '' };
  }
  return { ...session, mappings, issues: [], updatedAt: new Date().toISOString() };
}

export function updateWorkingCell(session, rowId, columnIndex, value) {
  if (!session || !Array.isArray(session.workingRows)) throw new Error('MAPPING_SESSION_REQUIRED');
  const row = session.workingRows.find(item => item.rowId === rowId);
  if (!row || !Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= session.headers.length) {
    throw new Error('MAPPING_CELL_INVALID');
  }
  const editJournal = { ...(session.editJournal || {}) };
  const manualRows = (session.manualRows || []).map(item => ({ ...item, cells: [...(item.cells || [])] }));
  if (row.manual) {
    const target = manualRows.find(item => item.rowId === rowId);
    if (!target) throw new Error('MAPPING_MANUAL_ROW_MISSING');
    target.cells[columnIndex] = cellText(value);
  } else {
    editJournal[`${row.sourceRowIndex}:${columnIndex}`] = cellText(value);
  }
  return {
    ...session,
    editJournal,
    manualRows,
    workingRows: activeWorkingRows(session, editJournal, manualRows),
    updatedAt: new Date().toISOString()
  };
}

export function addManualRow(session, values = []) {
  if (!session) throw new Error('MAPPING_SESSION_REQUIRED');
  const manualRows = [
    ...(session.manualRows || []).map(row => ({ ...row, cells: [...(row.cells || [])] })),
    {
      rowId: `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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

export function deleteWorkingRows(session, rowIds = []) {
  const selected = new Set(rowIds);
  const deletedSourceRows = new Set([...(session.deletedSourceRows || []), ...session.workingRows
    .filter(row => selected.has(row.rowId) && !row.manual)
    .map(row => row.sourceRowIndex)]);
  const manualRows = (session.manualRows || []).filter(row => !selected.has(row.rowId));
  const rows = workingRows(session.sourceMatrix, session.headerRowIndex, session.headers, session.editJournal, manualRows)
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
  const mappings = (session?.mappings || []).map(mapping => ({
    ...mapping,
    state: mapping.state === DECISION.RECOMMENDED ? DECISION.MAPPED : mapping.state
  }));
  return { mappings, validation: mappingValidation(mappings, targetDefinitions) };
}

export function validateTemplateDraft(session, targetDefinitions = []) {
  return decidedMappings(session, targetDefinitions).validation;
}

export function createTemplateRecord(session, templateName, targetDefinitions = [], previous = null) {
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
    schemaVersion: 'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V1',
    templateId: cellText(previous?.templateId) || `SITPL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    templateName: name,
    revision: Math.max(1, Number(previous?.revision || 0) + 1),
    signature: session.signature,
    headers: [...session.headers],
    fieldCount: session.headers.length,
    mappings: mappings.map(mapping => ({
      columnIndex: mapping.columnIndex,
      sourceHeader: mapping.sourceHeader,
      state: mapping.state,
      targetFieldId: mapping.state === DECISION.MAPPED ? mapping.targetFieldId : ''
    })),
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
}

function targetValue(target, value) {
  if (target?.valueType !== 'NUMBER') return cellText(value);
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(cellText(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function projectMappedRows(session, targetDefinitions = []) {
  if (!session || [SESSION_STATUS.INVALID_TEMPLATE, SESSION_STATUS.TEMPLATE_CONFLICT].includes(session.status)) return [];
  const targets = targetIndex(targetDefinitions);
  const mappings = (session.mappings || []).filter(mapping => [DECISION.MAPPED, DECISION.RECOMMENDED].includes(mapping.state));
  return (session.workingRows || [])
    .filter(row => (row.cells || []).some(value => cellText(value).trim() !== ''))
    .map((row, rowIndex) => {
      const projected = {
        rowId: row.rowId,
        sourceLineNo: row.sourceRowIndex === null ? rowIndex + 1 : row.sourceRowIndex + 1,
        sourceRowNo: row.sourceRowIndex === null ? rowIndex + 1 : row.sourceRowIndex + 1,
        rawText: (row.cells || []).join('\t'),
        inputOwnership: row.manual ? 'USER' : 'SOURCE',
        customValues: {}
      };
      mappings.forEach(mapping => {
        const target = targets.get(mapping.targetFieldId);
        if (!target) return;
        const value = targetValue(target, row.cells?.[mapping.columnIndex]);
        if (target.custom) projected.customValues[target.id] = value;
        else projected[target.projectionFieldId || target.id] = value;
      });
      return projected;
    });
}

export function mappingSummary(session) {
  const result = { mapped: 0, recommended: 0, unmapped: 0, undecided: 0 };
  (session?.mappings || []).forEach(mapping => {
    if (mapping.state === DECISION.MAPPED) result.mapped += 1;
    else if (mapping.state === DECISION.RECOMMENDED) result.recommended += 1;
    else if (mapping.state === DECISION.UNMAPPED) result.unmapped += 1;
    else result.undecided += 1;
  });
  return result;
}

export { DECISION, SESSION_STATUS };
