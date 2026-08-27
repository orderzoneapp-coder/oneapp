/**
 * SmartInput input-template core.
 *
 * Pure template/mapping calculations only. This module intentionally has no
 * access to the DOM, IndexedDB, XLSX, SmartInput drafts, or voucher writers.
 */

export const TEMPLATE_SESSION_MODES = Object.freeze({
  CREATE: 'CREATE_TEMPLATE',
  FILL: 'FILL_EXISTING_TEMPLATE'
});

export const TEMPLATE_STRUCTURE_COMMANDS = Object.freeze({
  CREATE: 'CREATE_TEMPLATE_STRUCTURE',
  UPDATE: 'UPDATE_TEMPLATE_STRUCTURE',
  ARCHIVE: 'ARCHIVE_TEMPLATE_STRUCTURE'
});

const MODES = new Set(['order', 'purchase', 'sale', 'estimate']);
const VALUE_TYPES = new Set(['TEXT', 'NUMBER', 'DATE']);
const REQUIRED_ROLES = new Set(['ITEM_IDENTITY', 'MODE_REQUIRED']);

function text(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function templateError(code, message, detail = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

export function normalizeTemplateName(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeTemplateHeader(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\s\r\n\t()[\]{}<>_'".,:;·•/\\\-]+/g, '');
}

function canonicalMappings(mappings = []) {
  return mappings.map(mapping => ({
    sourceHeader: text(mapping.sourceHeader),
    normalizedSourceHeader: normalizeTemplateHeader(mapping.normalizedSourceHeader || mapping.sourceHeader),
    sourceAliases: [...new Set((mapping.sourceAliases || [])
      .map(normalizeTemplateHeader)
      .filter(Boolean))].sort(),
    targetFieldKey: text(mapping.targetFieldKey || mapping.fieldKey),
    valueType: VALUE_TYPES.has(mapping.valueType) ? mapping.valueType : 'TEXT',
    ...(REQUIRED_ROLES.has(mapping.requiredRole) ? { requiredRole: mapping.requiredRole } : {})
  })).filter(mapping => mapping.normalizedSourceHeader && mapping.targetFieldKey);
}

function canonicalColumns(columns = []) {
  return columns.map((column, index) => ({
    fieldKey: text(column.fieldKey),
    displayLabel: text(column.displayLabel || column.label || column.fieldKey),
    order: Number.isFinite(Number(column.order)) ? Number(column.order) : index,
    visible: column.visible !== false
  })).filter(column => column.fieldKey)
    .sort((left, right) => left.order - right.order || left.fieldKey.localeCompare(right.fieldKey, 'ko'))
    .map((column, order) => ({ ...column, order }));
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function stableTemplateHash(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  return `fnv1a:${fnv1a(source)}`;
}

export function templateStructureHash({ mappings = [], columns = [] } = {}) {
  return stableTemplateHash({
    mappings: canonicalMappings(mappings),
    columns: canonicalColumns(columns)
  });
}

export function mappingDigest(mappings = []) {
  return stableTemplateHash(canonicalMappings(mappings));
}

function fieldCategory(field = {}) {
  if (['rowCustomerCode', 'rowCustomerName', 'deliveryCustomerId', 'deliveryCustomerCode', 'deliveryCustomerName',
    'billingCustomerId', 'billingCustomerCode', 'billingCustomerName', 'supplierCustomerId', 'supplierCustomerCode',
    'supplierCustomerName', 'salesCustomerId', 'salesCustomerCode', 'salesCustomerName'].includes(field.id)) return 'CUSTOMER';
  if (['rowVoucherDate', 'rowDeliveryDate', 'rowWarehouseCode', 'rowVoucherNo', 'sourceDocumentKey',
    'sourceVoucherIndex', 'manualSplitKey'].includes(field.id)) return 'VOUCHER';
  if (['quantity', 'unitPrice', 'supplyAmount'].includes(field.id) || ['QUANTITY', 'PRICE', 'COST'].includes(field.group)) {
    return 'QUANTITY_PRICE';
  }
  if (field.group === 'ITEM' || ['itemCode', 'itemName', 'specification', 'unit'].includes(field.id)) return 'PRODUCT';
  return 'ETC';
}

export function buildTemplateFieldRegistry(mode, fieldDefinitions = [], customFields = []) {
  if (!MODES.has(mode)) throw templateError('TEMPLATE_MODE_INVALID', '지원하지 않는 전표 mode입니다.');
  const voucherCustomFields = (customFields || []).filter(field => field?.scope === 'voucher');
  return [...fieldDefinitions, ...voucherCustomFields].map(field => {
    const fieldKey = text(field.id || field.fieldKey);
    const aliases = [fieldKey, field.label, ...(field.masterAliases || []), ...(field.inputAliases || [])]
      .map(text).filter(Boolean);
    const dateField = ['rowVoucherDate', 'rowDeliveryDate'].includes(fieldKey);
    return {
      fieldKey,
      mode,
      label: text(field.label || fieldKey),
      aliases: [...new Set(aliases)],
      valueType: dateField ? 'DATE' : (field.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT'),
      category: fieldCategory(field),
      ...(['itemCode', 'itemName'].includes(fieldKey) ? { requiredRole: 'ITEM_IDENTITY' } : {}),
      editable: field.editable !== false,
      custom: Boolean(field.custom || voucherCustomFields.includes(field))
    };
  }).filter(field => field.fieldKey)
    .filter((field, index, fields) => fields.findIndex(other => other.fieldKey === field.fieldKey) === index);
}

export function buildTemplateFieldIndex(fieldRegistry = []) {
  const index = new Map();
  fieldRegistry.forEach(field => {
    [field.fieldKey, field.label, ...(field.aliases || [])].map(normalizeTemplateHeader).filter(Boolean).forEach(alias => {
      if (!index.has(alias)) index.set(alias, field);
    });
  });
  return index;
}

function duplicateValues(values = []) {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value);
}

export function recommendTemplateMappings(headers = [], fieldRegistry = []) {
  const fieldIndex = buildTemplateFieldIndex(fieldRegistry);
  const sourceHeaders = headers.map(text);
  const normalizedHeaders = sourceHeaders.map(normalizeTemplateHeader);
  const duplicateSourceHeaders = duplicateValues(normalizedHeaders);
  const usedTargets = new Set();
  const mappings = sourceHeaders.map((sourceHeader, columnIndex) => {
    const normalizedSourceHeader = normalizedHeaders[columnIndex];
    const field = fieldIndex.get(normalizedSourceHeader);
    const recommended = Boolean(field && !usedTargets.has(field.fieldKey) && !duplicateSourceHeaders.includes(normalizedSourceHeader));
    if (recommended) usedTargets.add(field.fieldKey);
    return {
      columnIndex,
      sourceHeader,
      normalizedSourceHeader,
      targetFieldKey: recommended ? field.fieldKey : '',
      valueType: recommended ? field.valueType : 'TEXT',
      ...(recommended && field.requiredRole ? { requiredRole: field.requiredRole } : {}),
      recommendation: recommended ? 'EXACT' : (field ? 'REVIEW_REQUIRED' : 'UNMAPPED')
    };
  });
  return {
    mappings,
    duplicateSourceHeaders,
    mappedCount: mappings.filter(mapping => mapping.targetFieldKey).length,
    identityCount: mappings.filter(mapping => ['itemCode', 'itemName'].includes(mapping.targetFieldKey)).length,
    unmappedHeaders: mappings.filter(mapping => !mapping.targetFieldKey).map(mapping => mapping.sourceHeader)
  };
}

export function planExistingTemplateMappings(headers = [], template = {}) {
  const sourceHeaders = headers.map(text);
  const normalizedHeaders = sourceHeaders.map(normalizeTemplateHeader);
  const duplicateSourceHeaders = duplicateValues(normalizedHeaders);
  const templateMappings = canonicalMappings(template.mappings || []);
  const matches = [];
  const targetColumns = new Map();
  const sourceTargets = new Map();
  templateMappings.forEach(mapping => {
    const aliases = new Set([mapping.normalizedSourceHeader, ...(mapping.sourceAliases || [])]);
    const matchedIndexes = normalizedHeaders
      .map((header, columnIndex) => aliases.has(header) ? columnIndex : -1)
      .filter(columnIndex => columnIndex >= 0);
    matchedIndexes.forEach(columnIndex => {
      matches.push({ ...mapping, columnIndex, sourceHeader: sourceHeaders[columnIndex] });
      const columns = targetColumns.get(mapping.targetFieldKey) || [];
      columns.push(columnIndex);
      targetColumns.set(mapping.targetFieldKey, columns);
      const targets = sourceTargets.get(columnIndex) || [];
      targets.push(mapping.targetFieldKey);
      sourceTargets.set(columnIndex, targets);
    });
  });
  const duplicateTargets = [...targetColumns].filter(([, columns]) => columns.length > 1).map(([fieldKey]) => fieldKey);
  const duplicateMappedSources = [...sourceTargets]
    .filter(([, targets]) => new Set(targets).size > 1)
    .map(([columnIndex]) => sourceHeaders[columnIndex]);
  const matchedSources = new Set(matches.map(match => match.columnIndex));
  const missingMappings = templateMappings.filter(mapping => !matches.some(match => match.targetFieldKey === mapping.targetFieldKey));
  const blockingErrors = [];
  if (duplicateSourceHeaders.length || duplicateMappedSources.length) blockingErrors.push({
    code: 'DUPLICATE_SOURCE_HEADER',
    values: [...new Set([...duplicateSourceHeaders, ...duplicateMappedSources])]
  });
  if (duplicateTargets.length) blockingErrors.push({ code: 'DUPLICATE_TARGET_FIELD', values: duplicateTargets });
  if (!matches.some(match => ['itemCode', 'itemName'].includes(match.targetFieldKey))) {
    blockingErrors.push({ code: 'ITEM_IDENTITY_MISSING', values: [] });
  }
  return {
    mappings: matches,
    mappedCount: matches.length,
    duplicateSourceHeaders,
    duplicateMappedSources,
    duplicateTargets,
    missingMappings,
    unmappedHeaders: sourceHeaders.filter((header, columnIndex) => header && !matchedSources.has(columnIndex)),
    blockingErrors,
    valid: blockingErrors.length === 0
  };
}

export function validateTemplateMappings(mappings = []) {
  const normalized = canonicalMappings(mappings);
  const duplicateSourceHeaders = duplicateValues(normalized.map(mapping => mapping.normalizedSourceHeader));
  const duplicateTargets = duplicateValues(normalized.map(mapping => mapping.targetFieldKey));
  const errors = [];
  if (duplicateSourceHeaders.length) errors.push({ code: 'DUPLICATE_SOURCE_HEADER', values: duplicateSourceHeaders });
  if (duplicateTargets.length) errors.push({ code: 'DUPLICATE_TARGET_FIELD', values: duplicateTargets });
  if (!normalized.some(mapping => ['itemCode', 'itemName'].includes(mapping.targetFieldKey))) {
    errors.push({ code: 'ITEM_IDENTITY_MISSING', values: [] });
  }
  return { valid: errors.length === 0, mappings: normalized, errors, duplicateSourceHeaders, duplicateTargets };
}

export function templateColumnsFromMappings(mappings = [], fieldRegistry = []) {
  const fields = new Map(fieldRegistry.map(field => [field.fieldKey, field]));
  return canonicalMappings(mappings).map((mapping, index) => ({
    fieldKey: mapping.targetFieldKey,
    displayLabel: fields.get(mapping.targetFieldKey)?.label || mapping.targetFieldKey,
    order: index,
    visible: true
  })).filter((column, index, columns) => columns.findIndex(other => other.fieldKey === column.fieldKey) === index);
}

export function normalizeInputTemplate(input = {}) {
  const mode = MODES.has(input.mode) ? input.mode : 'order';
  const mappings = canonicalMappings(input.mappings || []);
  const columns = canonicalColumns(input.columns || []);
  return {
    templateId: text(input.templateId),
    mode,
    name: text(input.name),
    normalizedName: normalizeTemplateName(input.normalizedName || input.name),
    revision: Math.max(1, Number(input.revision) || 1),
    status: input.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    mappings,
    columns,
    structureHash: text(input.structureHash) || templateStructureHash({ mappings, columns }),
    createdAt: text(input.createdAt),
    updatedAt: text(input.updatedAt),
    ...(input.system ? { system: true } : {})
  };
}

export function assertTemplateStructureCommand(sessionMode, command) {
  if (sessionMode !== TEMPLATE_SESSION_MODES.CREATE) {
    throw templateError('TEMPLATE_STRUCTURE_LOCKED', '기존 양식에서는 구조를 저장할 수 없습니다.', { command, sessionMode });
  }
  if (!Object.values(TEMPLATE_STRUCTURE_COMMANDS).includes(command)) {
    throw templateError('TEMPLATE_COMMAND_INVALID', '지원하지 않는 양식 구조 명령입니다.', { command });
  }
  return true;
}

export function createTemplateRecord(input = {}, { templateId, now = new Date().toISOString(), sessionMode } = {}) {
  assertTemplateStructureCommand(sessionMode, TEMPLATE_STRUCTURE_COMMANDS.CREATE);
  const name = text(input.name);
  if (!name) throw templateError('TEMPLATE_NAME_REQUIRED', '양식명을 입력하세요.');
  const validation = validateTemplateMappings(input.mappings);
  if (!validation.valid) throw templateError(validation.errors[0].code, '양식 매핑을 확인하세요.', { errors: validation.errors });
  const columns = canonicalColumns(input.columns || []);
  const structureHash = templateStructureHash({ mappings: validation.mappings, columns });
  return normalizeInputTemplate({
    ...input,
    templateId,
    name,
    normalizedName: normalizeTemplateName(name),
    revision: 1,
    status: 'ACTIVE',
    mappings: validation.mappings,
    columns,
    structureHash,
    createdAt: now,
    updatedAt: now
  });
}

export function planTemplateStructureUpdate(currentInput, nextInput, { expectedRevision, now = new Date().toISOString(), sessionMode } = {}) {
  assertTemplateStructureCommand(sessionMode, TEMPLATE_STRUCTURE_COMMANDS.UPDATE);
  const current = normalizeInputTemplate(currentInput);
  if (current.system) throw templateError('TEMPLATE_STRUCTURE_LOCKED', '시스템 양식은 수정할 수 없습니다.');
  if (Number(expectedRevision) !== current.revision) {
    throw templateError('TEMPLATE_REVISION_CONFLICT', '양식 revision이 변경되었습니다.', {
      expectedRevision: Number(expectedRevision), actualRevision: current.revision
    });
  }
  const validation = validateTemplateMappings(nextInput.mappings || current.mappings);
  if (!validation.valid) throw templateError(validation.errors[0].code, '양식 매핑을 확인하세요.', { errors: validation.errors });
  const columns = canonicalColumns(nextInput.columns || current.columns);
  const structureHash = templateStructureHash({ mappings: validation.mappings, columns });
  if (structureHash === current.structureHash) return { changed: false, record: current };
  return {
    changed: true,
    record: normalizeInputTemplate({
      ...current,
      mappings: validation.mappings,
      columns,
      structureHash,
      revision: current.revision + 1,
      updatedAt: now
    })
  };
}

export function buildImportIdempotencyKey({ mode, templateId, templateRevision, importContentHash, sheetName } = {}) {
  return [mode, templateId, Number(templateRevision) || 0, importContentHash, sheetName]
    .map(value => encodeURIComponent(text(value))).join('|');
}

const SYSTEM_TEMPLATE_HEADERS = Object.freeze({
  order: Object.freeze([
    ['거래처명', 'rowCustomerName'], ['배송일자', 'rowDeliveryDate'], ['품목코드', 'itemCode'],
    ['품목명', 'itemName'], ['수량', 'quantity'], ['단가', 'unitPrice'], ['메모', 'memo']
  ]),
  purchase: Object.freeze([
    ['구매처명', 'rowCustomerName'], ['구매일자', 'rowVoucherDate'], ['품목코드', 'itemCode'],
    ['품목명', 'itemName'], ['수량', 'quantity'], ['입고가', 'unitPrice']
  ]),
  sale: Object.freeze([
    ['판매처명', 'rowCustomerName'], ['판매일자', 'rowVoucherDate'], ['품목코드', 'itemCode'],
    ['품목명', 'itemName'], ['수량', 'quantity'], ['판매가', 'unitPrice']
  ]),
  estimate: Object.freeze([
    ['품목코드', 'itemCode'], ['품목명', 'itemName'], ['수량', 'quantity'], ['단가', 'unitPrice'], ['메모', 'memo']
  ])
});

export function systemInputTemplate(mode, fieldRegistry = []) {
  const registry = new Map(fieldRegistry.map(field => [field.fieldKey, field]));
  const pairs = SYSTEM_TEMPLATE_HEADERS[mode] || SYSTEM_TEMPLATE_HEADERS.order;
  const mappings = pairs.map(([sourceHeader, targetFieldKey]) => {
    const field = registry.get(targetFieldKey) || {};
    return {
      sourceHeader,
      normalizedSourceHeader: normalizeTemplateHeader(sourceHeader),
      sourceAliases: [...new Set([sourceHeader, ...(field.aliases || [])].map(normalizeTemplateHeader).filter(Boolean))],
      targetFieldKey,
      valueType: field.valueType || 'TEXT',
      ...(field.requiredRole ? { requiredRole: field.requiredRole } : {})
    };
  });
  const columns = pairs.map(([, fieldKey], order) => ({
    fieldKey,
    displayLabel: registry.get(fieldKey)?.label || pairs[order][0],
    order,
    visible: true
  }));
  return normalizeInputTemplate({
    templateId: `system:${mode}:default`,
    mode,
    name: `${mode === 'order' ? '주문' : mode === 'purchase' ? '구매' : mode === 'sale' ? '판매' : '견적'} 기본 양식`,
    revision: 1,
    status: 'ACTIVE',
    mappings,
    columns,
    createdAt: 'system',
    updatedAt: 'system',
    system: true
  });
}

export { templateError };
