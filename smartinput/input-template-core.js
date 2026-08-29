const TEMPLATE_MODES = Object.freeze({
  CREATE: 'CREATE',
  FILL: 'FILL'
});

const text = value => String(value ?? '').normalize('NFKC').trim();
const normalizeName = value => text(value).toLowerCase().replace(/\s+/g, ' ');
const normalizeHeader = value => text(value).toLowerCase().replace(/[\s\r\n\t()[\]{}<>_'".,:;·•/\\\-]+/g, '');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizeTemplateRecord(input = {}) {
  const mappings = Array.isArray(input.mappings) ? input.mappings.map(mapping => ({
    sourceHeader: text(mapping.sourceHeader),
    normalizedSourceHeader: normalizeHeader(mapping.normalizedSourceHeader || mapping.sourceHeader),
    fieldId: text(mapping.fieldId || mapping.targetFieldKey),
    label: text(mapping.label || mapping.sourceHeader),
    valueType: mapping.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT'
  })).filter(mapping => mapping.normalizedSourceHeader && mapping.fieldId) : [];
  const columns = Array.isArray(input.columns) ? input.columns.map((column, index) => ({
    fieldId: text(column.fieldId || column.fieldKey),
    label: text(column.label || column.displayLabel || column.fieldId || column.fieldKey),
    order: Number.isFinite(Number(column.order)) ? Number(column.order) : index
  })).filter(column => column.fieldId).sort((left, right) => left.order - right.order) : [];
  return {
    templateId: text(input.templateId),
    mode: ['order', 'purchase', 'sale', 'estimate'].includes(input.mode) ? input.mode : 'order',
    name: text(input.name),
    normalizedName: normalizeName(input.normalizedName || input.name),
    revision: Math.max(1, Number(input.revision || 1)),
    mappings,
    columns,
    createdAt: text(input.createdAt),
    updatedAt: text(input.updatedAt)
  };
}

export function templateColumnsFromMappings(mappings = [], tableFieldIds = []) {
  const allowed = new Set(tableFieldIds);
  const seen = new Set();
  return mappings.filter(mapping => allowed.has(mapping.fieldId) && !seen.has(mapping.fieldId)).map((mapping, order) => {
    seen.add(mapping.fieldId);
    return { fieldId: mapping.fieldId, label: mapping.sourceHeader || mapping.label || mapping.fieldId, order };
  });
}

export function createTemplateRecord({ mode, name, mappings = [], tableFieldIds = [] } = {}, {
  templateId,
  now = new Date().toISOString()
} = {}) {
  const templateName = text(name);
  if (!templateName) throw Object.assign(new Error('양식명을 입력하세요.'), { code: 'TEMPLATE_NAME_REQUIRED' });
  const normalizedMappings = normalizeTemplateRecord({ mode, mappings }).mappings;
  if (!normalizedMappings.some(mapping => ['itemCode', 'itemName'].includes(mapping.fieldId))) {
    throw Object.assign(new Error('품목코드 또는 품목명 열을 확인하세요.'), { code: 'TEMPLATE_ITEM_IDENTITY_REQUIRED' });
  }
  return normalizeTemplateRecord({
    templateId,
    mode,
    name: templateName,
    revision: 1,
    mappings: normalizedMappings,
    columns: templateColumnsFromMappings(normalizedMappings, tableFieldIds),
    createdAt: now,
    updatedAt: now
  });
}

export function templateFieldDefinitions(templateInput, knownDefinitions = []) {
  const template = normalizeTemplateRecord(templateInput);
  const byId = new Map(knownDefinitions.map(field => [field.id, field]));
  return template.mappings.map(mapping => {
    const known = byId.get(mapping.fieldId) || {};
    return {
      id: mapping.fieldId,
      label: known.label || mapping.label || mapping.sourceHeader,
      group: known.group || 'ADDITIONAL',
      required: known.required === true,
      valueType: mapping.valueType === 'NUMBER' || known.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT',
      editable: known.editable !== false,
      masterAliases: [],
      inputAliases: [mapping.sourceHeader]
    };
  });
}

export function loadTemplateLibrary(storage, storageKey) {
  try {
    const root = JSON.parse(storage.getItem(storageKey) || '{}');
    const records = Array.isArray(root.inputTemplates) ? root.inputTemplates.map(normalizeTemplateRecord) : [];
    return { root: root && typeof root === 'object' ? root : {}, records: records.filter(record => record.templateId && record.name) };
  } catch (_) {
    return { root: {}, records: [] };
  }
}

export function saveTemplateLibrary(storage, storageKey, records = []) {
  const loaded = loadTemplateLibrary(storage, storageKey);
  const next = {
    ...loaded.root,
    inputTemplates: records.map(normalizeTemplateRecord)
  };
  storage.setItem(storageKey, JSON.stringify(next));
  return clone(next.inputTemplates);
}

export { TEMPLATE_MODES, normalizeHeader, normalizeName };
