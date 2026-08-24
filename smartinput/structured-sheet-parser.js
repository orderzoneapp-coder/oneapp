const DUPLICATED_FIELD_TERM = /(코드|번호|수량|단가|가격|품목|상품|이름|규격|메모)\1+/g;
const SUMMARY_LABEL = /^(?:합계|총계|소계)\s*[:：]?\s*$/;
const FOOTER_LABEL = /^(?:출력일시|출력시간|인쇄일시|작성일시)(?:\s|[:：]|$)/;
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
    const hasSourceValue = (sourceRow || []).some(value => cellText(value));
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

    if (!cellText(values.itemCode) && !cellText(values.itemName)) return;
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
