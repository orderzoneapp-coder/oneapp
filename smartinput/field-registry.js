import {
  loadCompanyVoucherFieldSettings,
  loadFieldDefinitions,
  loadSettingValue,
  replaceFieldCatalogGeneration,
  saveCompanyVoucherFieldSettings,
  saveSettingValue
} from './smartinput-data-store.js?v=0.15.0';

// Field definitions and company-specific display rules. Keep NFKC normalization local to these definitions.
export const FIELD_DEFINITION_SCHEMA = 'ONEAPP_SMARTINPUT_FIELD_DEFINITION_V2';
export const FIELD_SETTING_SCHEMA = 'ONEAPP_COMPANY_VOUCHER_FIELD_SETTING_V1';
export const FIELD_CATALOG_SEED_SCHEMA = 'ONEAPP_SMARTINPUT_FIELD_CATALOG_SEED_V2';

export const VOUCHER_MODES = Object.freeze(['estimate', 'order', 'purchase', 'sale']);
export const FIELD_SCOPES = Object.freeze(['HEADER', 'LINE', 'REFERENCE', 'RELATED', 'RESULT', 'CUSTOM']);
export const FIELD_STATUSES = Object.freeze(['ACTIVE', 'INACTIVE', 'REVIEW_REQUIRED']);
export const OWNER_DOMAINS = Object.freeze([
  'SMARTINPUT_VOUCHER', 'PRODUCT_MASTER', 'CUSTOMER_MASTER', 'WAREHOUSE_MASTER',
  'EMPLOYEE_MASTER', 'PROJECT_MASTER', 'LEDGER', 'SYSTEM'
]);

const fieldDefinitionText = value => String(value ?? '').normalize('NFKC').trim();
const clone = value => JSON.parse(JSON.stringify(value));

const MODE_LABEL = Object.freeze({ estimate: '견적', order: '주문', purchase: '구매', sale: '판매' });
const MODE_PARTNER = Object.freeze({ estimate: '거래처', order: '거래처', purchase: '구매처', sale: '판매처' });
const MODE_WAREHOUSE = Object.freeze({ estimate: '창고', order: '창고', purchase: '입고창고', sale: '출고창고' });

function field(mode, scope, key, label, projectionFieldId, options = {}) {
  const modeLabel = MODE_LABEL[mode];
  return Object.freeze({
    schemaVersion: FIELD_DEFINITION_SCHEMA,
    generationId: 'SMARTINPUT-CORE-V2',
    fieldId: `voucher.${mode}.${scope === 'HEADER' ? 'header' : 'line'}.${key}`,
    ownerDomain: 'SMARTINPUT_VOUCHER',
    relationshipPath: [mode.toUpperCase(), scope],
    voucherModes: [mode],
    scope,
    role: fieldDefinitionText(options.role || key).toUpperCase(),
    sourceFieldCode: label,
    displayLabel: label,
    advancedLabel: `${modeLabel} > ${scope === 'HEADER' ? '상단' : '행'} > ${label}`,
    valueType: options.valueType || 'TEXT',
    writable: options.writable !== false,
    mappable: options.mappable !== false,
    outputOnly: options.outputOnly === true,
    systemRequired: options.systemRequired === true,
    effectRole: options.effectRole || '',
    aliases: Object.freeze([...(options.aliases || [])]),
    status: 'ACTIVE',
    reviewReason: '',
    definitionRevision: 1,
    ownerRevision: 'SMARTINPUT-CORE-V2',
    projectionFieldId
  });
}

function modeCoreFields(mode) {
  const label = MODE_LABEL[mode];
  const isPurchase = mode === 'purchase';
  const isSale = mode === 'sale';
  const inventoryMode = isPurchase || isSale;
  return [
    field(mode, 'HEADER', 'date', `${label}일자`, 'rowVoucherDate', { role: 'DATE', valueType: 'DATE', systemRequired: true, aliases: ['일자', '전표일자'] }),
    field(mode, 'HEADER', 'partnerId', MODE_PARTNER[mode], isPurchase ? 'supplierCustomerId' : (isSale ? 'salesCustomerId' : 'rowCustomerId'), { role: 'PARTNER', systemRequired: true, aliases: ['거래처', '거래처명'] }),
    field(mode, 'HEADER', 'warehouseId', MODE_WAREHOUSE[mode], 'rowWarehouseCode', { role: 'WAREHOUSE', systemRequired: inventoryMode, aliases: ['창고', '창고코드'] }),
    field(mode, 'HEADER', 'assigneeId', '담당자', 'assigneeId', { role: 'ASSIGNEE', aliases: ['담당자명', '사원'] }),
    ...(mode === 'estimate' ? [field(mode, 'HEADER', 'validUntil', '유효기간', 'validUntil', { role: 'VALID_UNTIL', valueType: 'DATE' })] : []),
    ...(mode === 'order' ? [field(mode, 'HEADER', 'dueDate', '납기일자', 'rowDeliveryDate', { role: 'DUE_DATE', valueType: 'DATE' })] : []),
    field(mode, 'LINE', 'productSearch', '품목검색', 'productSearch', { role: 'PRODUCT_SEARCH', mappable: false }),
    field(mode, 'LINE', 'productCode', '품목코드', 'itemCode', { role: 'PRODUCT_CODE', aliases: ['상품코드'] }),
    field(mode, 'LINE', 'productName', '품목명', 'itemName', { role: 'PRODUCT_NAME', systemRequired: true, aliases: ['상품명', '품명'] }),
    field(mode, 'LINE', 'specification', '규격', 'specification', { role: 'SPECIFICATION', aliases: ['규격명'] }),
    field(mode, 'LINE', 'quantity', `${label}수량`, 'quantity', { role: 'QUANTITY', valueType: 'DECIMAL', systemRequired: true, effectRole: `${mode.toUpperCase()}_QUANTITY`, aliases: ['수량'] }),
    field(mode, 'LINE', 'unit', '단위', 'unit', { role: 'UNIT', aliases: ['상품구성'] }),
    field(mode, 'LINE', 'unitPrice', `${label}단가`, 'unitPrice', { role: 'UNIT_PRICE', valueType: 'DECIMAL', systemRequired: inventoryMode, effectRole: `${mode.toUpperCase()}_UNIT_PRICE`, aliases: ['단가'] }),
    field(mode, 'LINE', 'supplyAmount', '공급가액', 'supplyAmount', { role: 'SUPPLY_AMOUNT', valueType: 'DECIMAL', aliases: ['금액'] }),
    ...(inventoryMode ? [
      field(mode, 'LINE', 'vatAmount', '부가세', 'vatAmount', { role: 'VAT_AMOUNT', valueType: 'DECIMAL' }),
      field(mode, 'LINE', 'totalAmount', '합계', 'totalAmount', { role: 'TOTAL_AMOUNT', valueType: 'DECIMAL' })
    ] : []),
    field(mode, 'LINE', 'memo', '적요', 'memo', { role: 'MEMO', aliases: ['메모', '비고'] })
  ];
}

export const CORE_FIELD_DEFINITIONS = Object.freeze(VOUCHER_MODES.flatMap(mode => modeCoreFields(mode)));

export const CUSTOM_FIELD_DEFINITIONS = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => ({ type: 'text', valueType: 'TEXT', index: index + 1 })),
  ...Array.from({ length: 10 }, (_, index) => ({ type: 'number', valueType: 'DECIMAL', index: index + 1 }))
].map(slot => Object.freeze({
  schemaVersion: FIELD_DEFINITION_SCHEMA,
  generationId: 'SMARTINPUT-CORE-V2',
  fieldId: `custom.${slot.type}.${String(slot.index).padStart(2, '0')}`,
  ownerDomain: 'SMARTINPUT_VOUCHER',
  relationshipPath: ['COMPANY', 'CUSTOM'],
  voucherModes: [...VOUCHER_MODES],
  scope: 'CUSTOM',
  role: 'CUSTOM_MEMO',
  sourceFieldCode: '',
  displayLabel: `${slot.valueType === 'TEXT' ? '사용자지정 문자' : '사용자지정 숫자'} ${slot.index}`,
  advancedLabel: `사용자지정 > ${slot.valueType === 'TEXT' ? '문자' : '숫자'} ${slot.index}`,
  valueType: slot.valueType,
  writable: true,
  mappable: true,
  outputOnly: false,
  systemRequired: false,
  effectRole: '',
  aliases: [],
  status: 'ACTIVE',
  reviewReason: '',
  definitionRevision: 1,
  ownerRevision: 'SMARTINPUT-CORE-V2',
  projectionFieldId: `custom.${slot.type}.${String(slot.index).padStart(2, '0')}`
})));

export function validateFieldDefinition(input = {}) {
  const definition = clone(input);
  if (definition.schemaVersion !== FIELD_DEFINITION_SCHEMA) throw new Error('SMARTINPUT_FIELD_SCHEMA_INVALID');
  if (!fieldDefinitionText(definition.fieldId)) throw new Error('SMARTINPUT_FIELD_ID_REQUIRED');
  if (!OWNER_DOMAINS.includes(definition.ownerDomain)) throw new Error(`SMARTINPUT_FIELD_OWNER_INVALID:${definition.fieldId}`);
  if (!FIELD_SCOPES.includes(definition.scope)) throw new Error(`SMARTINPUT_FIELD_SCOPE_INVALID:${definition.fieldId}`);
  if (!FIELD_STATUSES.includes(definition.status)) throw new Error(`SMARTINPUT_FIELD_STATUS_INVALID:${definition.fieldId}`);
  if (!Array.isArray(definition.voucherModes) || !definition.voucherModes.length
    || definition.voucherModes.some(mode => !VOUCHER_MODES.includes(mode))) throw new Error(`SMARTINPUT_FIELD_MODE_INVALID:${definition.fieldId}`);
  if (!fieldDefinitionText(definition.displayLabel) || !fieldDefinitionText(definition.advancedLabel)) throw new Error(`SMARTINPUT_FIELD_LABEL_REQUIRED:${definition.fieldId}`);
  if (definition.outputOnly && definition.writable) throw new Error(`SMARTINPUT_FIELD_WRITE_CONFLICT:${definition.fieldId}`);
  return definition;
}

export function validateFieldCatalog(catalog = {}) {
  if (catalog.schemaVersion !== FIELD_CATALOG_SEED_SCHEMA) throw new Error('SMARTINPUT_FIELD_CATALOG_SCHEMA_INVALID');
  const definitions = (catalog.definitions || []).map(validateFieldDefinition);
  const keys = new Set();
  definitions.forEach(definition => {
    const key = `${definition.generationId}\u001f${definition.fieldId}`;
    if (keys.has(key)) throw new Error(`SMARTINPUT_FIELD_DUPLICATED:${definition.fieldId}`);
    keys.add(key);
  });
  if (Number(catalog.reviewRequiredCount) !== definitions.filter(row => row.status === 'REVIEW_REQUIRED').length) {
    throw new Error('SMARTINPUT_FIELD_REVIEW_COUNT_INVALID');
  }
  return { ...clone(catalog), definitions };
}

export function defaultCompanyVoucherFieldSettings(companyId, voucherMode, actor = '') {
  const company = fieldDefinitionText(companyId);
  if (!company) throw new Error('SMARTINPUT_FIELD_SETTING_COMPANY_REQUIRED');
  if (!VOUCHER_MODES.includes(voucherMode)) throw new Error('SMARTINPUT_FIELD_SETTING_MODE_INVALID');
  const now = new Date().toISOString();
  return CORE_FIELD_DEFINITIONS.filter(field => field.voucherModes.includes(voucherMode)).map((definition, index) => ({
    schemaVersion: FIELD_SETTING_SCHEMA,
    companyId: company,
    voucherMode,
    fieldId: definition.fieldId,
    enabled: true,
    required: definition.systemRequired,
    uiZone: definition.scope === 'HEADER' ? 'HEADER_FORM' : 'LINE_GRID',
    uiOrder: (index + 1) * 10,
    width: definition.scope === 'LINE' ? 120 : 0,
    userLabel: definition.displayLabel,
    settingRevision: 1,
    updatedBy: fieldDefinitionText(actor),
    updatedAt: now
  }));
}

export function normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings = [], actor = '', additionalDefinitions = []) {
  const defaults = defaultCompanyVoucherFieldSettings(companyId, voucherMode, actor);
  const definitions = new Map([...CORE_FIELD_DEFINITIONS, ...CUSTOM_FIELD_DEFINITIONS, ...additionalDefinitions].map(field => [field.fieldId, field]));
  const supplied = new Map((Array.isArray(settings) ? settings : []).filter(row => row.voucherMode === voucherMode).map(row => [fieldDefinitionText(row.fieldId), row]));
  const result = defaults.map(fallback => {
    const source = supplied.get(fallback.fieldId) || {};
    const definition = definitions.get(fallback.fieldId);
    return {
      ...fallback,
      ...clone(source),
      schemaVersion: FIELD_SETTING_SCHEMA,
      companyId: fieldDefinitionText(companyId),
      voucherMode,
      fieldId: fallback.fieldId,
      enabled: definition.systemRequired ? true : source.enabled !== false,
      required: definition.systemRequired ? true : source.required === true,
      userLabel: fieldDefinitionText(source.userLabel) || definition.displayLabel
    };
  });
  (Array.isArray(settings) ? settings : []).forEach(source => {
    const definition = definitions.get(fieldDefinitionText(source.fieldId));
    if (!definition || result.some(row => row.fieldId === definition.fieldId)) return;
    result.push({
      schemaVersion: FIELD_SETTING_SCHEMA,
      companyId: fieldDefinitionText(companyId),
      voucherMode,
      fieldId: definition.fieldId,
      enabled: source.enabled === true,
      required: false,
      uiZone: source.uiZone === 'HEADER_FORM' ? 'HEADER_FORM' : 'LINE_GRID',
      uiOrder: Number(source.uiOrder || 999),
      width: Number(source.width || 120),
      userLabel: fieldDefinitionText(source.userLabel) || definition.displayLabel,
      settingRevision: Number(source.settingRevision || 1),
      updatedBy: fieldDefinitionText(source.updatedBy || actor),
      updatedAt: fieldDefinitionText(source.updatedAt) || new Date().toISOString()
    });
  });
  return result.sort((left, right) => left.uiOrder - right.uiOrder || left.fieldId.localeCompare(right.fieldId));
}

export function effectiveFieldDefinitions({ catalog = [], settings = [], voucherMode, scope = '', mappableOnly = false } = {}) {
  const enabled = new Map(settings.filter(row => row.enabled === true).map(row => [row.fieldId, row]));
  return [...CORE_FIELD_DEFINITIONS, ...CUSTOM_FIELD_DEFINITIONS, ...(Array.isArray(catalog) ? catalog : [])]
    .filter(definition => definition.status === 'ACTIVE'
      && definition.voucherModes.includes(voucherMode)
      && (!scope || definition.scope === scope)
      && (!mappableOnly || definition.mappable)
      && enabled.has(definition.fieldId))
    .map(definition => ({
      ...definition,
      displayLabel: fieldDefinitionText(enabled.get(definition.fieldId)?.userLabel) || definition.displayLabel,
      setting: clone(enabled.get(definition.fieldId))
    }))
    .sort((left, right) => Number(left.setting.uiOrder || 0) - Number(right.setting.uiOrder || 0));
}

export function coreFieldByProjection(voucherMode, projectionFieldId) {
  return CORE_FIELD_DEFINITIONS.find(field => field.voucherModes.includes(voucherMode) && field.projectionFieldId === projectionFieldId) || null;
}

// Stable settings groups and editable input navigation order.
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

export const FIELD_SEED_META_KEY = 'fieldCatalogSeed:v2';
export const DEFAULT_COMPANY_ID = 'ONEAPP';

const text = value => String(value ?? '').trim();

export function resolveSmartInputCompanyId(bundle = null) {
  if (bundle?.session?.companyId) return text(bundle.session.companyId);
  if (bundle?.session?.user?.companyId) return text(bundle.session.user.companyId);
  try {
    const stored = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(stored?.session?.companyId || stored?.session?.user?.companyId) || DEFAULT_COMPANY_ID;
  } catch {
    return DEFAULT_COMPANY_ID;
  }
}

export function resolveSmartInputActor(bundle = null) {
  if (bundle?.session?.user?.loginId) return text(bundle.session.user.loginId);
  try {
    const stored = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(stored?.session?.user?.loginId) || 'SMART_INPUT_ADMIN';
  } catch {
    return 'SMART_INPUT_ADMIN';
  }
}

export async function fetchStaticFieldCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('SMARTINPUT_FIELD_CATALOG_FETCH_UNAVAILABLE');
  const response = await fetchImpl('./field-catalog-seed.v2.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`SMARTINPUT_FIELD_CATALOG_HTTP_${response.status}`);
  return validateFieldCatalog(await response.json());
}

async function readFieldCatalogSeed({ fetchImpl = globalThis.fetch, force = false } = {}) {
  const metadata = await loadSettingValue(FIELD_SEED_META_KEY);
  if (!force && metadata?.generationId && metadata?.definitionCount === 2178) {
    const definitions = await loadFieldDefinitions(metadata.generationId);
    if (definitions.length === metadata.definitionCount) return { metadata, definitions, changed: false };
  }
  const catalog = await fetchStaticFieldCatalog(fetchImpl);
  const definitions = await replaceFieldCatalogGeneration(catalog);
  const nextMetadata = {
    schemaVersion: catalog.schemaVersion,
    generationId: catalog.generationId,
    sourceFile: catalog.sourceFile,
    sourceSha256: catalog.sourceSha256,
    definitionCount: catalog.definitionCount,
    occurrenceCount: catalog.occurrenceCount,
    reviewRequiredCount: catalog.reviewRequiredCount,
    modeCounts: catalog.modeCounts,
    appliedAt: new Date().toISOString()
  };
  await saveSettingValue(FIELD_SEED_META_KEY, nextMetadata);
  return { metadata: nextMetadata, definitions, changed: true };
}

async function readVoucherFieldRegistry({ companyId = DEFAULT_COMPANY_ID, voucherMode, actor = '', fetchImpl = globalThis.fetch } = {}) {
  const seeded = await ensureFieldCatalogSeed({ fetchImpl });
  const catalog = seeded.definitions.filter(field => field.voucherModes?.includes(voucherMode));
  let settings = await loadCompanyVoucherFieldSettings(companyId, voucherMode);
  if (!settings.length) {
    settings = defaultCompanyVoucherFieldSettings(companyId, voucherMode, actor);
    await saveCompanyVoucherFieldSettings(settings);
  } else {
    settings = normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings, actor, catalog);
  }
  return {
    companyId,
    voucherMode,
    catalogGenerationId: seeded.metadata.generationId,
    coreDefinitions: CORE_FIELD_DEFINITIONS.filter(field => field.voucherModes.includes(voucherMode)),
    customDefinitions: CUSTOM_FIELD_DEFINITIONS,
    catalog,
    settings,
    enabled: effectiveFieldDefinitions({ catalog, settings, voucherMode }),
    mappingCandidates: effectiveFieldDefinitions({ catalog, settings, voucherMode, mappableOnly: true })
  };
}

export async function updateVoucherFieldSettings({ companyId = DEFAULT_COMPANY_ID, voucherMode, settings, actor = '', definitions = [] } = {}) {
  registryPromises.clear();
  const normalized = normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings, actor, definitions).map(row => ({
    ...row,
    settingRevision: Number(row.settingRevision || 0) + 1,
    updatedBy: text(actor),
    updatedAt: new Date().toISOString()
  }));
  await saveCompanyVoucherFieldSettings(normalized);
  registryPromises.clear();
  return normalized;
}


let seedPromises = new WeakMap();
const registryPromises = new Map();
export function invalidateFieldRegistryCache() { seedPromises = new WeakMap(); registryPromises.clear(); }
export function ensureFieldCatalogSeed(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (options.force) invalidateFieldRegistryCache();
  if (!seedPromises.has(fetchImpl)) {
    const pending = readFieldCatalogSeed(options);
    seedPromises.set(fetchImpl, pending);
    pending.catch(() => { if (seedPromises.get(fetchImpl) === pending) seedPromises.delete(fetchImpl); });
  }
  return seedPromises.get(fetchImpl);
}
export async function loadVoucherFieldRegistry(options = {}) {
  const seeded = await ensureFieldCatalogSeed(options);
  const key = JSON.stringify([options.companyId || DEFAULT_COMPANY_ID, options.voucherMode, seeded.metadata.generationId, options.actor || '']);
  if (!registryPromises.has(key)) {
    const pending = readVoucherFieldRegistry(options); registryPromises.set(key, pending);
    pending.catch(() => { if (registryPromises.get(key) === pending) registryPromises.delete(key); });
  }
  return structuredClone(await registryPromises.get(key));
}
