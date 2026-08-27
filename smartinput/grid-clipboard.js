import {
  buildStructuredFieldIndex,
  normalizeStructuredFieldName,
  parseTabularText
} from './structured-sheet-parser.js?v=0.2.0';

function cellText(value) {
  return String(value ?? '');
}

function normalizedNumber(value, numberParser) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof numberParser === 'function') return numberParser(value);
  const number = Number(String(value).replace(/[,원₩\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function parseClipboardMatrix(rawText = '') {
  return parseTabularText(rawText);
}

export function buildGridPastePlan(rawText = '', {
  fieldDefinitions = [],
  visibleFieldIds = [],
  startFieldId = '',
  numberParser,
  requireHeaders = false
} = {}) {
  const matrix = parseClipboardMatrix(rawText);
  const editableDefinitions = fieldDefinitions.filter(field => field?.editable !== false);
  const fieldById = new Map(editableDefinitions.map(field => [field.id, field]));
  const fieldIndex = buildStructuredFieldIndex(editableDefinitions);
  const usedFields = new Set();
  const headerErrors = [];
  const headerMappings = (matrix[0] || []).map((rawHeader, columnIndex) => {
    const sourceHeader = cellText(rawHeader).trim();
    const field = fieldIndex.get(normalizeStructuredFieldName(sourceHeader));
    if (!sourceHeader) {
      headerErrors.push({ columnIndex, header: '', reason: 'EMPTY_HEADER' });
      return null;
    }
    if (!field) {
      headerErrors.push({ columnIndex, header: sourceHeader, reason: 'UNKNOWN_HEADER' });
      return null;
    }
    if (usedFields.has(field.id)) {
      headerErrors.push({ columnIndex, header: sourceHeader, fieldId: field.id, reason: 'DUPLICATE_FIELD' });
      return null;
    }
    usedFields.add(field.id);
    return { columnIndex, fieldId: field.id, sourceHeader };
  }).filter(Boolean);

  if (requireHeaders || (headerMappings.length >= 2 && !headerErrors.length)) {
    const invalidCells = [];
    const expectedColumnCount = (matrix[0] || []).length;
    const rowErrors = matrix.slice(1).flatMap((sourceRow, rowIndex) => (
      sourceRow.length === expectedColumnCount
        ? []
        : [{ rowNumber: rowIndex + 2, expectedColumnCount, actualColumnCount: sourceRow.length, reason: 'COLUMN_COUNT_MISMATCH' }]
    ));
    const rows = headerErrors.length || rowErrors.length ? [] : matrix.slice(1).map((sourceRow, rowIndex) => ({
      rawText: sourceRow.join('\t'),
      cells: headerMappings.map(mapping => {
        const definition = fieldById.get(mapping.fieldId);
        const rawValue = sourceRow[mapping.columnIndex] ?? '';
        if (definition?.valueType !== 'NUMBER') return { fieldId: mapping.fieldId, value: cellText(rawValue) };
        const value = normalizedNumber(rawValue, numberParser);
        if (cellText(rawValue).trim() && value === null) {
          invalidCells.push({
            rowNumber: rowIndex + 2,
            columnIndex: mapping.columnIndex,
            fieldId: mapping.fieldId,
            value: cellText(rawValue)
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
  const rows = matrix.map((sourceRow, rowIndex) => {
    ignoredColumnCount = Math.max(ignoredColumnCount, Math.max(0, sourceRow.length - targetFields.length));
    const cells = sourceRow.slice(0, targetFields.length).map((rawValue, columnIndex) => {
      const fieldId = targetFields[columnIndex];
      const definition = fieldById.get(fieldId);
      if (definition?.valueType !== 'NUMBER') return { fieldId, value: cellText(rawValue) };
      const value = normalizedNumber(rawValue, numberParser);
      if (cellText(rawValue).trim() && value === null) {
        invalidCells.push({ rowNumber: rowIndex + 1, columnIndex, fieldId, value: cellText(rawValue) });
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
