export const TABLE_VIEW_MODE = Object.freeze({
  SOURCE: 'source',
  INPUT: 'input'
});

export function createTableViewPreferences(modes = []) {
  return Object.fromEntries(modes.map(mode => [mode, TABLE_VIEW_MODE.SOURCE]));
}

export function tableViewFor(preferences, mode, hasSource) {
  if (!hasSource) return TABLE_VIEW_MODE.INPUT;
  return preferences?.[mode] === TABLE_VIEW_MODE.INPUT
    ? TABLE_VIEW_MODE.INPUT
    : TABLE_VIEW_MODE.SOURCE;
}

export function selectTableView(preferences, mode, view, { hasSource = true } = {}) {
  if (!Object.values(TABLE_VIEW_MODE).includes(view)) throw new Error('SMARTINPUT_TABLE_VIEW_INVALID');
  return {
    ...(preferences || {}),
    [mode]: hasSource ? view : TABLE_VIEW_MODE.INPUT
  };
}

export function resetTableViewForSource(preferences, mode) {
  return {
    ...(preferences || {}),
    [mode]: TABLE_VIEW_MODE.SOURCE
  };
}

export function sourceViewColumns(session = {}) {
  const mappingByIndex = new Map((session.mappings || []).map(mapping => [Number(mapping.columnIndex), mapping]));
  return (session.headers || []).map((header, columnIndex) => {
    const mapping = mappingByIndex.get(columnIndex);
    return {
      id: `source:${columnIndex}`,
      columnIndex,
      label: String(header ?? ''),
      mappingState: String(mapping?.state || 'UNDECIDED'),
      targetFieldId: String(mapping?.targetFieldId || '')
    };
  });
}

export function inputViewColumns(fieldIds = [], definitions = []) {
  const definitionById = new Map(definitions.map(definition => [definition.id, definition]));
  return fieldIds.map((fieldId, columnIndex) => {
    const definition = definitionById.get(fieldId);
    return {
      id: fieldId,
      columnIndex,
      label: String(definition?.label || fieldId),
      definition: definition || null
    };
  });
}
