export const SETTINGS_FIELD_GROUPS = Object.freeze([
  Object.freeze({ id: 'ITEM', label: '품목정보', sourceGroups: Object.freeze(['ITEM']) }),
  Object.freeze({ id: 'AMOUNT', label: '수량·단가·금액', sourceGroups: Object.freeze(['QUANTITY', 'PRICE', 'COST']) }),
  Object.freeze({ id: 'OTHER', label: '메모·기타', sourceGroups: Object.freeze(['ADDITIONAL']) })
]);

const groupIndex = new Map(SETTINGS_FIELD_GROUPS.map((group, index) => [group.id, index]));

export function settingsFieldGroupId(field = {}) {
  const sourceGroup = String(field.group || 'ADDITIONAL');
  return SETTINGS_FIELD_GROUPS.find(group => group.sourceGroups.includes(sourceGroup))?.id || 'OTHER';
}

export function sortSettingsFields(fields = []) {
  return fields
    .map((field, sourceIndex) => ({ field, sourceIndex }))
    .sort((left, right) => {
      const leftGroup = groupIndex.get(settingsFieldGroupId(left.field)) ?? Number.MAX_SAFE_INTEGER;
      const rightGroup = groupIndex.get(settingsFieldGroupId(right.field)) ?? Number.MAX_SAFE_INTEGER;
      return leftGroup - rightGroup || left.sourceIndex - right.sourceIndex;
    })
    .map(item => item.field);
}

export function parseSettingsInputOrder(value, maximum = 999) {
  const source = String(value ?? '').trim();
  if (!source) return { valid: false, code: 'INPUT_ORDER_REQUIRED', value: null };
  if (!/^\d+$/.test(source)) return { valid: false, code: 'INPUT_ORDER_NON_NEGATIVE_INTEGER_REQUIRED', value: null };
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return { valid: false, code: 'INPUT_ORDER_OUT_OF_RANGE', value: null };
  }
  return { valid: true, code: '', value: parsed };
}

export function reorderSettingsInputOrder({
  inputOrder = {},
  selectedFieldIds = [],
  fieldId,
  requestedOrder,
  editableFieldIds = selectedFieldIds,
  maximum = 999
} = {}) {
  const parsed = parseSettingsInputOrder(requestedOrder, maximum);
  if (!parsed.valid) return { ...parsed, inputOrder: { ...inputOrder }, sequence: [] };

  const selected = [...new Set(selectedFieldIds.map(value => String(value || '')).filter(Boolean))];
  const editable = new Set(editableFieldIds.map(value => String(value || '')).filter(Boolean));
  if (!selected.includes(fieldId) || !editable.has(fieldId)) {
    return { valid: false, code: 'INPUT_ORDER_FIELD_NOT_EDITABLE', value: null, inputOrder: { ...inputOrder }, sequence: [] };
  }

  const displayIndex = new Map(selected.map((id, index) => [id, index]));
  const positive = selected
    .filter(id => id !== fieldId && editable.has(id) && Number(inputOrder[id]) > 0)
    .sort((left, right) => Number(inputOrder[left]) - Number(inputOrder[right])
      || (displayIndex.get(left) ?? 0) - (displayIndex.get(right) ?? 0));

  if (parsed.value > 0) {
    positive.splice(Math.min(parsed.value - 1, positive.length), 0, fieldId);
  }

  const next = { ...inputOrder, [fieldId]: parsed.value === 0 ? 0 : parsed.value };
  selected.forEach(id => {
    if (!editable.has(id)) next[id] = 0;
  });
  positive.forEach((id, index) => { next[id] = index + 1; });

  return {
    valid: true,
    code: '',
    value: next[fieldId],
    inputOrder: next,
    sequence: positive
  };
}

export function compactSettingsInputOrder({ inputOrder = {}, selectedFieldIds = [], editableFieldIds = selectedFieldIds } = {}) {
  const selected = [...new Set(selectedFieldIds.map(value => String(value || '')).filter(Boolean))];
  const editable = new Set(editableFieldIds.map(value => String(value || '')).filter(Boolean));
  const selectedIndex = new Map(selected.map((fieldId, index) => [fieldId, index]));
  const sequence = selected
    .filter(fieldId => editable.has(fieldId) && Number(inputOrder[fieldId]) > 0)
    .sort((left, right) => Number(inputOrder[left]) - Number(inputOrder[right])
      || (selectedIndex.get(left) ?? 0) - (selectedIndex.get(right) ?? 0));
  const next = { ...inputOrder };
  selected.forEach(fieldId => {
    if (!editable.has(fieldId)) next[fieldId] = 0;
  });
  sequence.forEach((fieldId, index) => { next[fieldId] = index + 1; });
  return { inputOrder: next, sequence };
}

export function settingsInputOrderPreview({ inputOrder = {}, selectedFieldIds = [], labelById = {} } = {}) {
  const selectedIndex = new Map(selectedFieldIds.map((fieldId, index) => [fieldId, index]));
  return selectedFieldIds
    .filter(fieldId => Number(inputOrder[fieldId]) > 0)
    .sort((left, right) => Number(inputOrder[left]) - Number(inputOrder[right])
      || (selectedIndex.get(left) ?? 0) - (selectedIndex.get(right) ?? 0))
    .map(fieldId => ({
      fieldId,
      order: Number(inputOrder[fieldId]),
      label: String(labelById[fieldId] || fieldId)
    }));
}
