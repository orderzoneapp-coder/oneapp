const text = value => String(value ?? '');

function serializableRawValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  if (value && typeof value === 'object') return JSON.parse(JSON.stringify(value));
  return value;
}

function displayValueOf(xlsx, cell) {
  if (!cell) return '';
  if (cell.w !== undefined && cell.w !== null) return text(cell.w);
  try {
    return text(xlsx?.utils?.format_cell ? xlsx.utils.format_cell(cell) : cell.v);
  } catch (_) {
    return text(cell.v);
  }
}

export function readWorksheetSource(xlsx, worksheet) {
  if (!xlsx?.utils?.decode_range || !xlsx?.utils?.encode_cell) throw new Error('XLSX_UTILS_REQUIRED');
  if (!worksheet?.['!ref']) return { displayMatrix: [], sourceCellMatrix: [] };
  const range = xlsx.utils.decode_range(worksheet['!ref']);
  const displayMatrix = [];
  const sourceCellMatrix = [];
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const displayRow = [];
    const sourceRow = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[address] || null;
      const displayValue = displayValueOf(xlsx, cell);
      displayRow.push(displayValue);
      sourceRow.push(Object.freeze({
        address,
        rowIndex,
        columnIndex,
        displayValue,
        rawValue: serializableRawValue(cell?.v),
        formula: text(cell?.f),
        numberFormat: text(cell?.z),
        cellType: text(cell?.t),
        blank: !cell
      }));
    }
    displayMatrix.push(Object.freeze(displayRow));
    sourceCellMatrix.push(Object.freeze(sourceRow));
  }
  return {
    displayMatrix: Object.freeze(displayMatrix),
    sourceCellMatrix: Object.freeze(sourceCellMatrix)
  };
}
