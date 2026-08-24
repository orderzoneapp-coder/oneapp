const DUPLICATED_FIELD_TERM = /(코드|번호|수량|단가|가격|품목|상품|이름|규격|메모)\1+/g;
const FOOTER_LABEL = /^(?:합계|총계|소계|출력일시|출력시간|인쇄일시|작성일시)(?:\s|[:：]|$)/;
const PRINTED_AT = /^\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}(?:\s|\([^)]*\)).*(?:오전|오후|\d{1,2}:\d{2})/;

function cellText(value) {
  return String(value ?? '').normalize('NFKC').trim();
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
  if (cellText(itemName)) return false;
  const code = cellText(itemCode);
  const firstValue = cellText((rawRow || []).find(value => cellText(value)));
  return FOOTER_LABEL.test(code || firstValue) || PRINTED_AT.test(code || firstValue);
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
  maxScanRows = 80
} = {}) {
  const rawText = matrixToSourceText(matrix);
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
  matrix.slice(header.rowIndex + 1).forEach((sourceRow, offset) => {
    if (isRepeatedHeader(sourceRow, fieldIndex)) return;
    const values = {};
    const editedFields = {};
    header.mappings.forEach(mapping => {
      const rawValue = sourceRow?.[mapping.columnIndex] ?? '';
      const hasValue = cellText(rawValue) !== '';
      editedFields[mapping.fieldId] = true;
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

    if (!cellText(values.itemCode) && !cellText(values.itemName)) return;
    if (isFooterIdentity(values.itemCode, values.itemName, sourceRow)) return;
    const sourceLineNo = header.rowIndex + offset + 2;
    rows.push({
      ...values,
      rawText: (sourceRow || []).map(cell => String(cell ?? '')).join('\t'),
      productText: values.itemName || '',
      sourceLineNo,
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
