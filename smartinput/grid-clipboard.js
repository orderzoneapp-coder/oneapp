import {
  buildStructuredFieldIndex,
  normalizeStructuredFieldName
} from './structured-sheet-parser.js';

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

export function buildGridPastePlan(rawText = '', {
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
    const sourceHeader = cellText(rawHeader).trim();
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
