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

export function projectedRowValue(row, target = {}) {
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

export function mappedRowMutationPlan({
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

export function applyMappedFieldUpdates(row, updates = []) {
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
