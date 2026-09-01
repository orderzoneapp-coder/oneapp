const text = value => String(value ?? '').trim();

export function parseBulkUnitPrice(displayValue) {
  const source = text(displayValue);
  if (!source) throw new Error('SMARTINPUT_BULK_PRICE_REQUIRED');
  const value = Number(source.replace(/[,원₩\s]/g, ''));
  if (!Number.isFinite(value)) throw new Error('SMARTINPUT_BULK_PRICE_INVALID');
  return Object.is(value, -0) ? 0 : value;
}

export function applyBulkUnitPrice(rows = [], selectedRowIds = [], displayValue = '', options = {}) {
  const selected = new Set(selectedRowIds);
  const unitPrice = parseBulkUnitPrice(displayValue);
  const occurredAt = text(options.occurredAt) || new Date().toISOString();
  const actor = text(options.actor) || 'SMART_INPUT_ADMIN';
  const targetFieldId = text(options.targetFieldId);
  let affectedCount = 0;
  const nextRows = rows.map(source => {
    if (!selected.has(source.rowId)) return source;
    affectedCount += 1;
    const row = {
      ...source,
      unitPrice,
      sourceUnitPrice: text(displayValue),
      editedFields: { ...(source.editedFields || {}), unitPrice: true },
      bulkEditHistory: [
        ...(source.bulkEditHistory || []),
        { action: 'APPLY_UNIT_PRICE', before: source.unitPrice ?? null, after: unitPrice, displayValue: text(displayValue), occurredAt, actor }
      ]
    };
    if (targetFieldId && source.fieldValues?.[targetFieldId]) {
      row.fieldValues = {
        ...source.fieldValues,
        [targetFieldId]: {
          ...source.fieldValues[targetFieldId],
          currentDisplayValue: text(displayValue),
          parsedValue: unitPrice,
          edited: true
        }
      };
    }
    return row;
  });
  return { rows: nextRows, affectedCount, unitPrice };
}
