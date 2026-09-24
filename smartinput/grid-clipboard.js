import {
  hasMeaningfulSourceValue,
  sourceRowHasMeaningfulValue
} from './input-template-mapper.js?v=0.3.2';

const DUPLICATED_FIELD_TERM = /(코드|번호|수량|단가|가격|품목|상품|이름|규격|메모)\1+/g;
const SUMMARY_LABEL = /^(?:합계|총계|소계)\s*[:：]?\s*$/;
const FOOTER_LABEL = /^(?:출력일시|출력시간|인쇄일시|작성일시)(?:\s|[:：]|$)/;
const PRINTED_AT = /^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}(?:\s|\([^)]*\)).*(?:오전|오후|\d{1,2}:\d{2})/;

function cellText(value) {
  const normalized = String(value ?? '').normalize('NFKC');
  return hasMeaningfulSourceValue(normalized) ? normalized.trim() : '';
}

export function normalizeStructuredFieldName(value) {
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

export function buildStructuredFieldIndex(fieldDefinitions = []) {
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

export function detectStructuredHeader(matrix = [], fieldDefinitions = [], { maxScanRows = 80 } = {}) {
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

export function matrixToSourceText(matrix = []) {
  return matrix.map(row => (row || []).map(cell => String(cell ?? '')).join('\t')).join('\n');
}

export function parseStructuredSheet(matrix = [], {
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
