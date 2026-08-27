import {
  planExistingTemplateMappings,
  recommendTemplateMappings,
  stableTemplateHash
} from './input-template-core.js?v=1.0.0';

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

function decodeHtmlText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .normalize('NFKC');
}

export function parseTabularText(rawText = '') {
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
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && cell === '') quoted = true;
    else if (character === '\t') { row.push(cell); cell = ''; }
    else if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += character;
  }
  row.push(cell);
  rows.push(row);
  if (source.endsWith('\n') && rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
  return rows;
}

export function htmlTableToMatrix(rawHtml = '') {
  const html = String(rawHtml ?? '');
  if (!/<table\b/i.test(html)) return [];
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const table = document.querySelector('table');
    if (!table) return [];
    return [...table.rows].map(row => [...row.cells].map(cell => cell.innerText ?? cell.textContent ?? ''));
  }
  const tableMatch = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  return [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(rowMatch => (
    [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cellMatch => decodeHtmlText(cellMatch[1]))
  )).filter(row => row.length);
}

async function contentHash(value) {
  const source = String(value ?? '');
  if (globalThis.crypto?.subtle && typeof TextEncoder !== 'undefined') {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return stableTemplateHash(source);
}

export async function createImportMatrix({ sourceKind, sourceName = '', sheetName = '', matrix = [], contentHash: suppliedHash = '' } = {}) {
  const normalizedMatrix = (matrix || []).map(row => Array.isArray(row) ? [...row] : [row]);
  return {
    sourceKind: sourceKind === 'CLIPBOARD' ? 'CLIPBOARD' : 'FILE',
    sourceName: String(sourceName || (sourceKind === 'CLIPBOARD' ? 'Excel 붙여넣기' : '파일')),
    sheetName: String(sheetName || (sourceKind === 'CLIPBOARD' ? '붙여넣기' : 'Sheet1')),
    matrix: normalizedMatrix,
    contentHash: suppliedHash || await contentHash(matrixToSourceText(normalizedMatrix))
  };
}

export async function clipboardToImportMatrix({ html = '', text = '', sourceName = 'Excel 붙여넣기' } = {}) {
  const htmlMatrix = htmlTableToMatrix(html);
  const matrix = htmlMatrix.length ? htmlMatrix : parseTabularText(text);
  const hashSource = htmlMatrix.length ? matrixToSourceText(htmlMatrix) : String(text ?? '');
  return createImportMatrix({
    sourceKind: 'CLIPBOARD', sourceName, sheetName: '붙여넣기', matrix,
    contentHash: await contentHash(hashSource)
  });
}

export async function workbookToImportMatrices(workbook, xlsx, { sourceName = 'Excel', contentHash: suppliedHash = '' } = {}) {
  if (!workbook || !xlsx?.utils?.sheet_to_json) return [];
  return Promise.all((workbook.SheetNames || []).filter(sheetName => workbook.Sheets?.[sheetName]?.['!ref']).map(sheetName => (
    createImportMatrix({
      sourceKind: 'FILE', sourceName, sheetName,
      matrix: xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true }),
      contentHash: suppliedHash
    })
  )));
}

function mappedFieldId(mapping) {
  return mapping.targetFieldKey || mapping.fieldId || '';
}

function mappedValueType(mapping) {
  return mapping.valueType === 'NUMBER' ? 'NUMBER' : (mapping.valueType === 'DATE' ? 'DATE' : 'TEXT');
}

function repeatedMappedHeader(row, mappings = []) {
  const cells = (row || []).map(normalizeStructuredFieldName);
  const matches = mappings.filter(mapping => {
    const aliases = [mapping.sourceHeader, mapping.normalizedSourceHeader, ...(mapping.sourceAliases || [])]
      .map(normalizeStructuredFieldName).filter(Boolean);
    return aliases.includes(cells[mapping.columnIndex]);
  });
  return matches.length >= 2 && matches.some(mapping => ['itemCode', 'itemName'].includes(mappedFieldId(mapping)));
}

export function parseMappedMatrix(matrix = [], {
  headerRowIndex = 0,
  mappings = [],
  numberParser,
  sheetName = ''
} = {}) {
  const rawText = matrixToSourceText(matrix);
  const normalizedMappings = mappings.map(mapping => ({
    ...mapping,
    fieldId: mappedFieldId(mapping),
    valueType: mappedValueType(mapping),
    sourceHeader: mapping.sourceHeader || cellText(matrix?.[headerRowIndex]?.[mapping.columnIndex])
  })).filter(mapping => mapping.fieldId && Number.isInteger(Number(mapping.columnIndex)));
  const invalidCells = [];
  const excludedRows = [];
  const rows = [];
  let sourceVoucherIndex = 1;
  let boundaryPending = false;
  matrix.slice(headerRowIndex + 1).forEach((sourceRow, offset) => {
    if (repeatedMappedHeader(sourceRow, normalizedMappings)) {
      excludedRows.push({ rowNumber: headerRowIndex + offset + 2, reason: 'REPEATED_HEADER' });
      if (rows.length) sourceVoucherIndex += 1;
      boundaryPending = false;
      return;
    }
    const hasSourceValue = (sourceRow || []).some(value => cellText(value));
    if (!hasSourceValue) { boundaryPending = Boolean(rows.length); return; }
    const itemCodeMapping = normalizedMappings.find(mapping => mapping.fieldId === 'itemCode');
    const itemNameMapping = normalizedMappings.find(mapping => mapping.fieldId === 'itemName');
    const rawItemCode = sourceRow?.[itemCodeMapping?.columnIndex] ?? '';
    const rawItemName = sourceRow?.[itemNameMapping?.columnIndex] ?? '';
    if (isFooterIdentity(rawItemCode, rawItemName, sourceRow)) {
      excludedRows.push({ rowNumber: headerRowIndex + offset + 2, reason: 'FOOTER' });
      boundaryPending = Boolean(rows.length);
      return;
    }
    const values = {};
    const editedFields = {};
    normalizedMappings.forEach(mapping => {
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
        if (parsed === null) invalidCells.push({
          rowNumber: headerRowIndex + offset + 2, columnIndex: mapping.columnIndex,
          fieldId: mapping.fieldId, value: cellText(rawValue), valueType: 'NUMBER'
        });
      } else {
        values[mapping.fieldId] = cellText(rawValue);
        if (mapping.valueType === 'DATE' && !/^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?)$/.test(cellText(rawValue))) {
          invalidCells.push({
            rowNumber: headerRowIndex + offset + 2, columnIndex: mapping.columnIndex,
            fieldId: mapping.fieldId, value: cellText(rawValue), valueType: 'DATE'
          });
        }
      }
    });
    if (!cellText(values.itemCode) && !cellText(values.itemName)) {
      excludedRows.push({ rowNumber: headerRowIndex + offset + 2, reason: 'ITEM_IDENTITY_MISSING' });
      return;
    }
    if (boundaryPending) { sourceVoucherIndex += 1; boundaryPending = false; }
    const sourceLineNo = headerRowIndex + offset + 2;
    rows.push({
      ...values,
      rawText: (sourceRow || []).map(cell => String(cell ?? '')).join('\t'),
      productText: values.itemName || '', sourceLineNo,
      sourceVoucherIndex: Number(values.sourceVoucherIndex) || sourceVoucherIndex,
      editedFields, matchStatus: 'UNRESOLVED'
    });
  });
  return {
    structured: true, rawText, sheetName, headerRowIndex, headerRowNumber: headerRowIndex + 1,
    mappings: normalizedMappings, rows, invalidCells, excludedRows, excludedRowCount: excludedRows.length
  };
}

function matrixCandidate(importMatrix, rowIndex, mappingPlan, sessionMode) {
  const dataRowCount = Math.max(0, importMatrix.matrix.slice(rowIndex + 1).filter(row => (row || []).some(cell => cellText(cell))).length);
  const identityCount = mappingPlan.identityCount ?? mappingPlan.mappings.filter(mapping => ['itemCode', 'itemName'].includes(mappedFieldId(mapping))).length;
  const score = (mappingPlan.mappedCount * 10000) + (identityCount * 1000) + dataRowCount;
  return { importMatrix, sheetName: importMatrix.sheetName, headerRowIndex: rowIndex, headerRowNumber: rowIndex + 1, mappingPlan, score, dataRowCount, sessionMode };
}

export function analyzeImportMatrices(importMatrices = [], {
  sessionMode,
  template = null,
  fieldRegistry = [],
  maxScanRows = 80,
  selectedSheetName = '',
  selectedHeaderRowIndex = null
} = {}) {
  const candidates = [];
  (importMatrices || []).forEach(importMatrix => {
    if (selectedSheetName && importMatrix.sheetName !== selectedSheetName) return;
    const excluded = parseStructuredSheet(importMatrix.matrix, { fieldDefinitions: [], sheetName: importMatrix.sheetName }).excluded;
    if (excluded) return;
    const rowIndexes = Number.isInteger(selectedHeaderRowIndex)
      ? [selectedHeaderRowIndex]
      : Array.from({ length: Math.min(maxScanRows, importMatrix.matrix.length) }, (_, index) => index);
    rowIndexes.forEach(rowIndex => {
      const headers = importMatrix.matrix[rowIndex] || [];
      const mappingPlan = sessionMode === 'FILL_EXISTING_TEMPLATE'
        ? planExistingTemplateMappings(headers, template)
        : recommendTemplateMappings(headers, fieldRegistry);
      const hasCandidate = sessionMode === 'FILL_EXISTING_TEMPLATE'
        ? mappingPlan.mappedCount > 0
        : mappingPlan.mappedCount >= 2 && mappingPlan.identityCount > 0;
      if (hasCandidate) candidates.push(matrixCandidate(importMatrix, rowIndex, mappingPlan, sessionMode));
    });
  });
  candidates.sort((left, right) => right.score - left.score || left.headerRowIndex - right.headerRowIndex || left.sheetName.localeCompare(right.sheetName, 'ko'));
  const best = candidates[0] || null;
  return {
    candidates,
    best,
    tiedBest: best ? candidates.filter(candidate => candidate.score === best.score) : [],
    requiresSelection: Boolean(best && candidates.filter(candidate => candidate.score === best.score).length > 1)
  };
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

  const parsed = parseMappedMatrix(matrix, {
    headerRowIndex: header.rowIndex,
    mappings: header.mappings,
    numberParser,
    sheetName
  });
  return { ...parsed, score: header.score };
}
