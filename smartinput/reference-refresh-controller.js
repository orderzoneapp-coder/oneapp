// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.
import * as smartinputDataStoreDependency0 from "./smartinput-data-store.js?v=0.15.0";
import * as officialVoucherCoreDependency1 from "../orderq/official-voucher-core.js?v=0.20.0";
import * as changeRequestContractDependency2 from "../reference-data/change-request-contract.js";
import * as legacyIntegrationAdapterDependency3 from "./legacy-integration-adapter.js?v=0.17.0";

// ============================================================================
// field-registry.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const fieldRegistrySection = (() => {
const { loadCompanyVoucherFieldSettings, loadFieldDefinitions, loadSettingValue, replaceFieldCatalogGeneration, saveCompanyVoucherFieldSettings, saveSettingValue } = smartinputDataStoreDependency0;

// Field definitions and company-specific display rules. Keep NFKC normalization local to these definitions.
const FIELD_DEFINITION_SCHEMA = 'ONEAPP_SMARTINPUT_FIELD_DEFINITION_V2';
const FIELD_SETTING_SCHEMA = 'ONEAPP_COMPANY_VOUCHER_FIELD_SETTING_V1';
const FIELD_CATALOG_SEED_SCHEMA = 'ONEAPP_SMARTINPUT_FIELD_CATALOG_SEED_V2';

const VOUCHER_MODES = Object.freeze(['estimate', 'order', 'purchase', 'sale']);
const FIELD_SCOPES = Object.freeze(['HEADER', 'LINE', 'REFERENCE', 'RELATED', 'RESULT', 'CUSTOM']);
const FIELD_STATUSES = Object.freeze(['ACTIVE', 'INACTIVE', 'REVIEW_REQUIRED']);
const OWNER_DOMAINS = Object.freeze([
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

const CORE_FIELD_DEFINITIONS = Object.freeze(VOUCHER_MODES.flatMap(mode => modeCoreFields(mode)));

const CUSTOM_FIELD_DEFINITIONS = Object.freeze([
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

function validateFieldDefinition(input = {}) {
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

function validateFieldCatalog(catalog = {}) {
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

function defaultCompanyVoucherFieldSettings(companyId, voucherMode, actor = '') {
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

function normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings = [], actor = '', additionalDefinitions = []) {
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

function effectiveFieldDefinitions({ catalog = [], settings = [], voucherMode, scope = '', mappableOnly = false } = {}) {
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

function coreFieldByProjection(voucherMode, projectionFieldId) {
  return CORE_FIELD_DEFINITIONS.find(field => field.voucherModes.includes(voucherMode) && field.projectionFieldId === projectionFieldId) || null;
}

// Stable settings groups and editable input navigation order.
const SETTINGS_FIELD_GROUPS = Object.freeze([
  Object.freeze({ id: 'ITEM', label: '품목정보', sourceGroups: Object.freeze(['ITEM']) }),
  Object.freeze({ id: 'AMOUNT', label: '수량·단가·금액', sourceGroups: Object.freeze(['QUANTITY', 'PRICE', 'COST']) }),
  Object.freeze({ id: 'OTHER', label: '메모·기타', sourceGroups: Object.freeze(['ADDITIONAL']) })
]);

const groupIndex = new Map(SETTINGS_FIELD_GROUPS.map((group, index) => [group.id, index]));

function settingsFieldGroupId(field = {}) {
  const sourceGroup = String(field.group || 'ADDITIONAL');
  return SETTINGS_FIELD_GROUPS.find(group => group.sourceGroups.includes(sourceGroup))?.id || 'OTHER';
}

function sortSettingsFields(fields = []) {
  return fields
    .map((field, sourceIndex) => ({ field, sourceIndex }))
    .sort((left, right) => {
      const leftGroup = groupIndex.get(settingsFieldGroupId(left.field)) ?? Number.MAX_SAFE_INTEGER;
      const rightGroup = groupIndex.get(settingsFieldGroupId(right.field)) ?? Number.MAX_SAFE_INTEGER;
      return leftGroup - rightGroup || left.sourceIndex - right.sourceIndex;
    })
    .map(item => item.field);
}

function parseSettingsInputOrder(value, maximum = 999) {
  const source = String(value ?? '').trim();
  if (!source) return { valid: false, code: 'INPUT_ORDER_REQUIRED', value: null };
  if (!/^\d+$/.test(source)) return { valid: false, code: 'INPUT_ORDER_NON_NEGATIVE_INTEGER_REQUIRED', value: null };
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return { valid: false, code: 'INPUT_ORDER_OUT_OF_RANGE', value: null };
  }
  return { valid: true, code: '', value: parsed };
}

function reorderSettingsInputOrder({
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

function compactSettingsInputOrder({ inputOrder = {}, selectedFieldIds = [], editableFieldIds = selectedFieldIds } = {}) {
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

function settingsInputOrderPreview({ inputOrder = {}, selectedFieldIds = [], labelById = {} } = {}) {
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

const FIELD_SEED_META_KEY = 'fieldCatalogSeed:v2';
const DEFAULT_COMPANY_ID = 'ONEAPP';

const text = value => String(value ?? '').trim();

function resolveSmartInputCompanyId(bundle = null) {
  if (bundle?.session?.companyId) return text(bundle.session.companyId);
  if (bundle?.session?.user?.companyId) return text(bundle.session.user.companyId);
  try {
    const stored = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(stored?.session?.companyId || stored?.session?.user?.companyId) || DEFAULT_COMPANY_ID;
  } catch {
    return DEFAULT_COMPANY_ID;
  }
}

function resolveSmartInputActor(bundle = null) {
  if (bundle?.session?.user?.loginId) return text(bundle.session.user.loginId);
  try {
    const stored = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(stored?.session?.user?.loginId) || 'SMART_INPUT_ADMIN';
  } catch {
    return 'SMART_INPUT_ADMIN';
  }
}

async function fetchStaticFieldCatalog(fetchImpl = globalThis.fetch) {
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

async function updateVoucherFieldSettings({ companyId = DEFAULT_COMPANY_ID, voucherMode, settings, actor = '', definitions = [] } = {}) {
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
function invalidateFieldRegistryCache() { seedPromises = new WeakMap(); registryPromises.clear(); }
function ensureFieldCatalogSeed(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (options.force) invalidateFieldRegistryCache();
  if (!seedPromises.has(fetchImpl)) {
    const pending = readFieldCatalogSeed(options);
    seedPromises.set(fetchImpl, pending);
    pending.catch(() => { if (seedPromises.get(fetchImpl) === pending) seedPromises.delete(fetchImpl); });
  }
  return seedPromises.get(fetchImpl);
}
async function loadVoucherFieldRegistry(options = {}) {
  const seeded = await ensureFieldCatalogSeed(options);
  const key = JSON.stringify([options.companyId || DEFAULT_COMPANY_ID, options.voucherMode, seeded.metadata.generationId, options.actor || '']);
  if (!registryPromises.has(key)) {
    const pending = readVoucherFieldRegistry(options); registryPromises.set(key, pending);
    pending.catch(() => { if (registryPromises.get(key) === pending) registryPromises.delete(key); });
  }
  return structuredClone(await registryPromises.get(key));
}

return { FIELD_DEFINITION_SCHEMA, FIELD_SETTING_SCHEMA, FIELD_CATALOG_SEED_SCHEMA, VOUCHER_MODES, FIELD_SCOPES, FIELD_STATUSES, OWNER_DOMAINS, CORE_FIELD_DEFINITIONS, CUSTOM_FIELD_DEFINITIONS, validateFieldDefinition, validateFieldCatalog, defaultCompanyVoucherFieldSettings, normalizeCompanyVoucherFieldSettings, effectiveFieldDefinitions, coreFieldByProjection, SETTINGS_FIELD_GROUPS, settingsFieldGroupId, sortSettingsFields, parseSettingsInputOrder, reorderSettingsInputOrder, compactSettingsInputOrder, settingsInputOrderPreview, FIELD_SEED_META_KEY, DEFAULT_COMPANY_ID, resolveSmartInputCompanyId, resolveSmartInputActor, fetchStaticFieldCatalog, updateVoucherFieldSettings, invalidateFieldRegistryCache, ensureFieldCatalogSeed, loadVoucherFieldRegistry };
})();

// ============================================================================
// reference-data-controller.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const referenceDataControllerSection = (() => {


const REFERENCE_DOMAIN_STATUS = Object.freeze({
  LOADING: 'LOADING',
  READY: 'READY',
  EMPTY: 'EMPTY',
  ERROR: 'ERROR',
  STALE: 'STALE'
});

const REFERENCE_CACHE_SCHEMA = 'ONEAPP_SMARTINPUT_REFERENCE_CACHE_V1';

const PRODUCT_OWNER_APP_ID = 'master-lookup';
const CUSTOMER_OWNER_APP_ID = 'customer-master';
const PRODUCT_SNAPSHOT_SCHEMA = 'ONEAPP_PRODUCT_SNAPSHOT_V1';
const CUSTOMER_SNAPSHOT_SCHEMA = 'ONEAPP_CUSTOMER_SNAPSHOT_V1';
const CHANGE_REQUEST_SCHEMA = 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1';
const PRODUCT_DB_NAME = 'MerchOpsDB';
const PRODUCT_RECORD_STORE = 'master_products';
const PRODUCT_KV_STORE = 'store';
const PRODUCT_SNAPSHOT_KEY = 'merchMaster_v870';
const PRODUCT_REVISION_KEY = 'merchMaster_revision_v870';
const CUSTOMER_DB_NAME = 'oneapp-customermaster-v1';

const clean = value => String(value ?? '').trim();
const cloneJson = value => {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function sha256Hex(value) {
  const source = typeof value === 'string' ? value : stableStringify(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeReferenceSearchText(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/[\s()[\]{}<>,.:;·_-]+/g, '');
}

function firstValue(source, keys, fallback = '') {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && clean(value) !== '') return clean(value);
  }
  return clean(fallback);
}

function numberOrNull(source, keys) {
  const raw = firstValue(source, keys);
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function splitAliases(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(entry => String(entry ?? '').split(/[,;|\n]+/))
    .map(clean).filter(Boolean);
}

function stableProductId(itemCode, itemName, specification) {
  if (itemCode) return `PRD-${itemCode}`;
  let hash = 2166136261;
  for (const character of `${normalizeReferenceSearchText(itemName)}|${normalizeReferenceSearchText(specification)}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `PRD-MASTER-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizePriceOptions(raw = {}) {
  const fields = [
    ['outPrice', '출고가', ['outPrice', '출고가']],
    ['wholesaleA', '도매A', ['wholesaleA', '도매A', '도매가', 'A판매', 'A판매가']],
    ['wholesaleB', '도매B', ['wholesaleB', '도매B', 'B판매', 'B판매가', 'B도매', 'B도매가']],
    ['listingPrice', '상장가', ['listingPrice', '상장가']],
    ['marketPrice', '시중가', ['marketPrice', '시중가', '시중가격']],
    ['promoPrice', '행사가', ['promoPrice', '행사가', '특가']]
  ];
  const outPrice = numberOrNull(raw, fields[0][2]);
  const promoPrice = numberOrNull(raw, fields[5][2]);
  const salePrice = promoPrice !== null && promoPrice > 0 ? promoPrice : outPrice;
  const options = salePrice === null ? [] : [{ key: 'salePrice', label: '판매가', value: salePrice }];
  fields.forEach(([key, label, aliases]) => {
    const value = numberOrNull(raw, aliases);
    if (value !== null) options.push({ key, label, value });
  });
  return options;
}

function normalizeProductReferenceRow(raw = {}, fallbackCode = '') {
  const itemCode = firstValue(raw, ['itemCode', 'productCode', '코드', '품목코드', '상품코드'], fallbackCode);
  const itemName = firstValue(raw, ['itemName', 'productName', '품목명', '상품명', '제품명', '품명']);
  if (!itemCode && !itemName) return null;
  const specification = firstValue(raw, ['specification', 'spec', '규격', '규격명']);
  const secondaryName = firstValue(raw, ['secondaryName', 'secondName', '제2품명', '제2상품명', '약칭']);
  const searchInfo = firstValue(raw, ['searchInfo', 'searchKeywords', '검색창정보', '검색어등록', '검색어', '간단설명']);
  const approvedAliases = [...new Set([
    secondaryName,
    ...splitAliases(searchInfo),
    ...splitAliases(raw.approvedAliases),
    ...splitAliases(raw['승인별칭']),
    ...splitAliases(raw['별칭'])
  ].filter(Boolean))];
  const productId = firstValue(raw, ['productId', 'masterProductId']) || stableProductId(itemCode, itemName, specification);
  return {
    productId,
    masterProductId: firstValue(raw, ['masterProductId']) || productId,
    itemCode,
    itemName,
    secondaryName,
    searchInfo,
    approvedAliases,
    specification,
    finalUnit: firstValue(raw, ['finalUnit', 'unit', '업무단위', '단위']),
    boxQuantity: numberOrNull(raw, ['boxQuantity', 'unitsPerBox', '박스당수량', '박스당 수량', '원단위', '입수', '기본']),
    outPrice: numberOrNull(raw, ['outPrice', '출고가']),
    priceOptions: normalizePriceOptions(raw),
    status: firstValue(raw, ['status', '상태'], 'ACTIVE'),
    active: raw.active !== false,
    source: 'PRODUCT_MASTER_SNAPSHOT',
    revision: Number(raw.revision || 0),
    raw: cloneJson(raw)
  };
}

function collectionRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value).map(([key, row]) => ({ key, row }));
  return [];
}

function normalizeProductCollection(value) {
  if (Array.isArray(value)) return value.map(row => normalizeProductReferenceRow(row)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, row]) => normalizeProductReferenceRow(row, key)).filter(Boolean);
  }
  return [];
}

function normalizeCustomerReferenceRow(raw = {}) {
  const customerId = clean(raw.customerId);
  if (!customerId || !clean(raw.customerName || raw.name)) return null;
  return {
    ...cloneJson(raw),
    customerId,
    customerCode: clean(raw.customerCode || raw.erpCustomerCode),
    customerName: clean(raw.customerName || raw.name),
    status: clean(raw.status || 'ACTIVE'),
    qualityStatus: clean(raw.qualityStatus || 'CANONICAL'),
    revision: Number(raw.revision || 0),
    updatedAt: clean(raw.updatedAt)
  };
}

function normalizeReferenceEnvelope(domain, snapshot, { source, fallback = false, checkedAt = new Date().toISOString(), adapterError = null } = {}) {
  const isProduct = domain === 'product';
  const expectedSchema = isProduct ? PRODUCT_SNAPSHOT_SCHEMA : CUSTOMER_SNAPSHOT_SCHEMA;
  if (!snapshot || snapshot.schemaVersion !== expectedSchema) throw new Error(`${domain.toUpperCase()}_SNAPSHOT_SCHEMA_INVALID`);
  const rawRows = isProduct ? snapshot.data?.products : snapshot.data?.customers;
  if (!Array.isArray(rawRows)) throw new Error(`${domain.toUpperCase()}_SNAPSHOT_ROWS_INVALID`);
  const rows = isProduct
    ? rawRows.map(row => normalizeProductReferenceRow(row)).filter(Boolean)
    : rawRows.map(row => normalizeCustomerReferenceRow(row)).filter(Boolean);
  const status = snapshot.status === REFERENCE_DOMAIN_STATUS.EMPTY || rows.length === 0
    ? REFERENCE_DOMAIN_STATUS.EMPTY
    : REFERENCE_DOMAIN_STATUS.READY;
  return {
    cacheSchemaVersion: REFERENCE_CACHE_SCHEMA,
    domain,
    ownerAppId: isProduct ? PRODUCT_OWNER_APP_ID : CUSTOMER_OWNER_APP_ID,
    schemaVersion: expectedSchema,
    adapterVersion: clean(snapshot.adapterVersion),
    status,
    source: clean(source || snapshot.source || 'ADAPTER_SNAPSHOT'),
    fallback,
    count: rows.length,
    revision: snapshot.snapshotVersion ?? snapshot.revision ?? '',
    snapshotId: clean(snapshot.snapshotId) || `${domain.toUpperCase()}-${clean(snapshot.contentHash).slice(0, 12)}`,
    contentHash: clean(snapshot.contentHash),
    snapshotCreatedAt: clean(snapshot.snapshotCreatedAt) || checkedAt,
    checkedAt,
    rows,
    adapterError: adapterError ? formatReferenceError(adapterError, domain) : null,
    error: null
  };
}

function formatReferenceError(error, domain) {
  return {
    code: clean(error?.code || error?.message) || `${domain.toUpperCase()}_REFERENCE_LOAD_FAILED`,
    message: clean(error?.message) || `${domain === 'product' ? '상품' : '거래처'} 기준정보를 불러오지 못했습니다.`,
    retryable: error?.retryable !== false
  };
}

function errorReference(domain, error, checkedAt = new Date().toISOString()) {
  return {
    cacheSchemaVersion: REFERENCE_CACHE_SCHEMA,
    domain,
    ownerAppId: domain === 'product' ? PRODUCT_OWNER_APP_ID : CUSTOMER_OWNER_APP_ID,
    schemaVersion: domain === 'product' ? PRODUCT_SNAPSHOT_SCHEMA : CUSTOMER_SNAPSHOT_SCHEMA,
    adapterVersion: '',
    status: REFERENCE_DOMAIN_STATUS.ERROR,
    source: 'UNAVAILABLE',
    fallback: false,
    count: null,
    revision: '',
    snapshotId: '',
    contentHash: '',
    snapshotCreatedAt: '',
    checkedAt,
    rows: [],
    adapterError: null,
    error: formatReferenceError(error, domain)
  };
}

function requestResult(request, code) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Object.assign(new Error(code), { cause: request.error }));
  });
}

function transactionDone(transaction, code) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(Object.assign(new Error(code), { cause: transaction.error }));
    transaction.onabort = () => reject(Object.assign(new Error(`${code}_ABORTED`), { cause: transaction.error }));
  });
}

async function databaseExists(name) {
  if (!globalThis.indexedDB) throw new Error('INDEXEDDB_NOT_AVAILABLE');
  if (typeof globalThis.indexedDB.databases !== 'function') return null;
  const databases = await globalThis.indexedDB.databases();
  return databases.some(entry => entry?.name === name);
}

function openExistingDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(name);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error(`${name}_UNEXPECTED_CREATION_BLOCKED`));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`${name}_OPEN_FAILED`));
    request.onblocked = () => reject(new Error(`${name}_OPEN_BLOCKED`));
  });
}

function localProductSnapshot() {
  const raw = globalThis.localStorage?.getItem(PRODUCT_SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error('PRODUCT_FALLBACK_LOCAL_INVALID'), { cause: error });
  }
}

async function loadProductDirectFallback({ now = new Date().toISOString() } = {}) {
  const exists = await databaseExists(PRODUCT_DB_NAME);
  let recordRows = [];
  let storedSnapshot = null;
  let revision = globalThis.localStorage?.getItem(PRODUCT_REVISION_KEY) || '';
  let source = 'LOCAL_STORAGE_SNAPSHOT_KEY';
  let db;
  if (exists !== false) {
    try {
      db = await openExistingDatabase(PRODUCT_DB_NAME);
      const stores = [PRODUCT_RECORD_STORE, PRODUCT_KV_STORE].filter(name => db.objectStoreNames.contains(name));
      if (stores.length) {
        const transaction = db.transaction(stores, 'readonly');
        const done = transactionDone(transaction, 'PRODUCT_FALLBACK_READ_FAILED');
        if (stores.includes(PRODUCT_RECORD_STORE)) recordRows = await requestResult(transaction.objectStore(PRODUCT_RECORD_STORE).getAll(), 'PRODUCT_FALLBACK_RECORD_READ_FAILED');
        if (stores.includes(PRODUCT_KV_STORE)) {
          [storedSnapshot, revision] = await Promise.all([
            requestResult(transaction.objectStore(PRODUCT_KV_STORE).get(PRODUCT_SNAPSHOT_KEY), 'PRODUCT_FALLBACK_SNAPSHOT_READ_FAILED'),
            requestResult(transaction.objectStore(PRODUCT_KV_STORE).get(PRODUCT_REVISION_KEY), 'PRODUCT_FALLBACK_REVISION_READ_FAILED')
          ]);
        }
        await done;
      }
    } catch (error) {
      if (!/_UNEXPECTED_CREATION_BLOCKED$/.test(clean(error?.message))) throw error;
    } finally {
      db?.close();
    }
  }
  let rawRows = recordRows;
  if (rawRows.length) source = 'INDEXEDDB_RECORD_STORE';
  else if (collectionRows(storedSnapshot).length) {
    rawRows = storedSnapshot;
    source = 'INDEXEDDB_SNAPSHOT_KEY';
  } else rawRows = localProductSnapshot();
  const products = normalizeProductCollection(rawRows);
  const data = { products: products.map(product => product.raw) };
  const contentHash = await sha256Hex(data);
  const snapshotVersion = clean(revision) || `HASH-${contentHash}`;
  return normalizeReferenceEnvelope('product', {
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA,
    adapterVersion: 'SMARTINPUT_PRODUCT_DIRECT_FALLBACK_V1',
    status: products.length ? 'READY' : 'EMPTY',
    snapshotId: `PRODUCT-${snapshotVersion}-${contentHash.slice(0, 12)}`,
    snapshotVersion,
    snapshotCreatedAt: now,
    contentHash,
    source,
    data
  }, { source: `FALLBACK_DIRECT:${source}`, fallback: true, checkedAt: now });
}

async function loadCustomerDirectFallback({ now = new Date().toISOString() } = {}) {
  const exists = await databaseExists(CUSTOMER_DB_NAME);
  if (exists === false) {
    const contentHash = await sha256Hex({ customers: [] });
    return normalizeReferenceEnvelope('customer', {
      schemaVersion: CUSTOMER_SNAPSHOT_SCHEMA,
      adapterVersion: 'SMARTINPUT_CUSTOMER_DIRECT_FALLBACK_V1',
      status: 'EMPTY',
      snapshotId: `CUSTOMER-0-${contentHash.slice(0, 12)}`,
      snapshotVersion: 0,
      snapshotCreatedAt: now,
      contentHash,
      data: { customers: [] }
    }, { source: 'FALLBACK_DIRECT:INDEXEDDB_CONFIRMED_EMPTY', fallback: true, checkedAt: now });
  }
  let db;
  try {
    db = await openExistingDatabase(CUSTOMER_DB_NAME);
    if (!db.objectStoreNames.contains('customers')) throw new Error('CUSTOMER_FALLBACK_STORE_MISSING');
    const stores = ['customers', 'appMeta'].filter(name => db.objectStoreNames.contains(name));
    const transaction = db.transaction(stores, 'readonly');
    const done = transactionDone(transaction, 'CUSTOMER_FALLBACK_READ_FAILED');
    const customers = await requestResult(transaction.objectStore('customers').getAll(), 'CUSTOMER_FALLBACK_CUSTOMER_READ_FAILED');
    const head = stores.includes('appMeta')
      ? await requestResult(transaction.objectStore('appMeta').get('headRevision'), 'CUSTOMER_FALLBACK_REVISION_READ_FAILED')
      : null;
    await done;
    const selected = customers.filter(customer => customer.status !== 'DELETED' && customer.qualityStatus !== 'SUPERSEDED');
    const data = { customers: selected };
    const contentHash = await sha256Hex(data);
    const revision = Number(head?.value || 0);
    return normalizeReferenceEnvelope('customer', {
      schemaVersion: CUSTOMER_SNAPSHOT_SCHEMA,
      adapterVersion: 'SMARTINPUT_CUSTOMER_DIRECT_FALLBACK_V1',
      status: selected.length ? 'READY' : 'EMPTY',
      snapshotId: `CUSTOMER-${revision}-${contentHash.slice(0, 12)}`,
      snapshotVersion: revision,
      snapshotCreatedAt: now,
      contentHash,
      data
    }, { source: 'FALLBACK_DIRECT:INDEXEDDB_CUSTOMERS', fallback: true, checkedAt: now });
  } finally {
    db?.close();
  }
}

function adapterFromModule(module, domain) {
  return domain === 'product'
    ? (module.productMasterReadAdapter || module.default || globalThis.ONEAPP_PRODUCT_MASTER_READ_ADAPTER)
    : (module.customerReadAdapter || module.default || globalThis.ONEAPP_CUSTOMER_MASTER_READ_ADAPTER);
}

async function defaultAdapterLoader(domain) {
  return domain === 'product'
    ? import('../reference-data/product-master-read-adapter.js')
    : import('../customer-master/read-adapter.js');
}

async function defaultFallbackLoader(domain, options) {
  return domain === 'product' ? loadProductDirectFallback(options) : loadCustomerDirectFallback(options);
}

async function loadReferenceDomain(domain, options = {}) {
  if (!['product', 'customer'].includes(domain)) throw new Error('REFERENCE_DOMAIN_INVALID');
  const checkedAt = options.now || new Date().toISOString();
  let adapterError = null;
  try {
    const module = await (options.adapterLoader || defaultAdapterLoader)(domain);
    const adapter = adapterFromModule(module, domain);
    if (!adapter?.getSnapshotResult) throw new Error(`${domain.toUpperCase()}_READ_ADAPTER_NOT_AVAILABLE`);
    const result = await adapter.getSnapshotResult(domain === 'customer' ? { includeInactive: false } : {});
    if (result?.status === REFERENCE_DOMAIN_STATUS.ERROR || !result?.snapshot) {
      const error = new Error(result?.error?.message || `${domain.toUpperCase()}_SNAPSHOT_READ_FAILED`);
      error.code = result?.error?.code || error.message;
      error.retryable = result?.error?.retryable !== false;
      throw error;
    }
    return normalizeReferenceEnvelope(domain, result.snapshot, { source: `ADAPTER:${clean(result.snapshot.source || 'OWNER_SNAPSHOT')}`, checkedAt });
  } catch (error) {
    adapterError = error;
  }
  if (options.allowFallback === false) return errorReference(domain, adapterError, checkedAt);
  try {
    const fallback = await (options.fallbackLoader || defaultFallbackLoader)(domain, { now: checkedAt });
    return { ...fallback, adapterError: formatReferenceError(adapterError, domain) };
  } catch (fallbackError) {
    const combined = new Error(clean(fallbackError?.message) || `${domain.toUpperCase()}_REFERENCE_LOAD_FAILED`);
    combined.code = combined.message;
    combined.adapterError = formatReferenceError(adapterError, domain);
    return errorReference(domain, combined, checkedAt);
  }
}

function normalizeCachedReference(value, domain) {
  if (!value || value.cacheSchemaVersion !== REFERENCE_CACHE_SCHEMA || value.domain !== domain || !Array.isArray(value.rows)) return null;
  if (![REFERENCE_DOMAIN_STATUS.READY, REFERENCE_DOMAIN_STATUS.EMPTY].includes(value.status)) return null;
  return cloneJson(value);
}

function sameReferenceRevision(left, right) {
  if (!left || !right) return false;
  if (left.snapshotId && right.snapshotId) return left.snapshotId === right.snapshotId;
  if (left.contentHash && right.contentHash) return left.contentHash === right.contentHash;
  return String(left.revision) === String(right.revision) && Number(left.count) === Number(right.count);
}

function referenceKey(domain, row) {
  return domain === 'product'
    ? clean(row.itemCode || row.productId || row.masterProductId)
    : clean(row.customerId || row.customerCode);
}

function diffReferenceSnapshots(domain, current, next) {
  const before = new Map((current?.rows || []).map(row => [referenceKey(domain, row), row]).filter(([key]) => key));
  const after = new Map((next?.rows || []).map(row => [referenceKey(domain, row), row]).filter(([key]) => key));
  let added = 0;
  let removed = 0;
  let changed = 0;
  after.forEach((row, key) => {
    if (!before.has(key)) added += 1;
    else if (stableStringify(before.get(key)) !== stableStringify(row)) changed += 1;
  });
  before.forEach((_, key) => { if (!after.has(key)) removed += 1; });
  return {
    domain,
    fromRevision: current?.revision ?? '',
    toRevision: next?.revision ?? '',
    fromCount: Number(current?.count || 0),
    toCount: Number(next?.count || 0),
    added,
    removed,
    changed
  };
}

function diceSimilarity(left, right) {
  const a = normalizeReferenceSearchText(left);
  const b = normalizeReferenceSearchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.7 : 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index += 1) {
    const pair = a.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = pairs.get(pair) || 0;
    if (!count) continue;
    overlap += 1;
    pairs.set(pair, count - 1);
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

function productEntry(product, index) {
  const aliases = [...new Set([
    product.secondaryName,
    ...(Array.isArray(product.approvedAliases) ? product.approvedAliases : []),
    ...splitAliases(product.searchInfo)
  ].map(normalizeReferenceSearchText).filter(Boolean))];
  return {
    product,
    index,
    code: normalizeReferenceSearchText(product.itemCode),
    name: normalizeReferenceSearchText(product.itemName),
    secondary: normalizeReferenceSearchText(product.secondaryName),
    aliases,
    specification: normalizeReferenceSearchText(product.specification)
  };
}

function addIndex(map, key, index) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(index);
}

function grams(value) {
  if (!value) return [];
  if (value.length < 2) return [value];
  const result = new Set();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return [...result];
}

function createProductMatchIndex(products = []) {
  const entries = products.filter(product => clean(product?.status || 'ACTIVE').toUpperCase() !== 'INACTIVE' && product?.active !== false)
    .map(productEntry);
  const exactCodes = new Map();
  const exactTexts = new Map();
  const gramIndex = new Map();
  entries.forEach((entry, index) => {
    addIndex(exactCodes, entry.code, index);
    [entry.name, entry.secondary, ...entry.aliases].forEach(value => addIndex(exactTexts, value, index));
    [entry.code, entry.name, entry.secondary, entry.specification, ...entry.aliases]
      .forEach(value => grams(value).forEach(gram => addIndex(gramIndex, gram, index)));
  });
  return { entries, exactCodes, exactTexts, gramIndex };
}

function indexedProducts(index, positions = []) {
  return [...new Set(positions)].map(position => index.entries[position]?.product).filter(Boolean);
}

function productSearchScore(query, entry) {
  if (entry.code.startsWith(query)) return 880 - Math.min(100, entry.code.length - query.length);
  if (entry.name.startsWith(query)) return 840 - Math.min(100, entry.name.length - query.length);
  if (entry.code.includes(query)) return 800;
  if (entry.name.includes(query)) return 760;
  if (entry.aliases.some(alias => alias.includes(query)) || entry.secondary.includes(query)) return 720;
  if (entry.specification.includes(query)) return 620;
  const similarity = Math.max(
    diceSimilarity(query, entry.name),
    diceSimilarity(query, entry.secondary),
    ...entry.aliases.map(alias => diceSimilarity(query, alias))
  );
  return similarity >= 0.38 ? Math.round(300 + similarity * 300) : 0;
}

function searchProductMatchIndex(index, query, limit = 12) {
  const normalized = normalizeReferenceSearchText(query);
  if (!normalized || !index?.entries) return [];
  const positions = new Set();
  if (normalized.length < 2) index.entries.forEach((_, position) => positions.add(position));
  else grams(normalized).forEach(gram => (index.gramIndex.get(gram) || []).forEach(position => positions.add(position)));
  const candidates = [...positions].map(position => ({ position, score: productSearchScore(normalized, index.entries[position]) }))
    .filter(candidate => candidate.score > 0);
  return candidates.sort((left, right) => right.score - left.score
    || clean(index.entries[left.position].product.itemCode).localeCompare(clean(index.entries[right.position].product.itemCode), 'ko', { numeric: true }))
    .slice(0, Math.max(0, limit))
    .map(candidate => ({ ...index.entries[candidate.position].product, score: candidate.score }));
}

function classifyProductMatch(index, query, { limit = 12 } = {}) {
  const normalized = normalizeReferenceSearchText(query);
  if (!normalized) return { kind: 'MISSING', autoConfirm: false, candidates: [] };
  const codeMatches = indexedProducts(index, index.exactCodes.get(normalized) || []);
  if (codeMatches.length === 1) return { kind: 'EXACT_CODE', autoConfirm: true, candidates: codeMatches, product: codeMatches[0] };
  if (codeMatches.length > 1) return { kind: 'AMBIGUOUS_EXACT_CODE', autoConfirm: false, candidates: codeMatches };
  const textMatches = indexedProducts(index, index.exactTexts.get(normalized) || []);
  if (textMatches.length === 1) return { kind: 'UNIQUE_EXACT_TEXT', autoConfirm: true, candidates: textMatches, product: textMatches[0] };
  if (textMatches.length > 1) return { kind: 'AMBIGUOUS_EXACT_TEXT', autoConfirm: false, candidates: textMatches };
  const candidates = searchProductMatchIndex(index, normalized, limit);
  return candidates.length
    ? { kind: 'FUZZY', autoConfirm: false, candidates }
    : { kind: 'MISSING', autoConfirm: false, candidates: [] };
}

function ownerAppHref(domain) {
  return domain === 'product' ? '../Master.html' : '../customer-master/index.html';
}

function createRequestId(domain) {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `SI-${domain.toUpperCase()}-${uuid}`;
}

function buildRegistrationChangeRequest(domain, prefill = {}, context = {}) {
  if (!['product', 'customer'].includes(domain)) throw new Error('REFERENCE_DOMAIN_INVALID');
  const requestId = createRequestId(domain);
  const product = domain === 'product';
  const fields = product
    ? [['itemCode', prefill.itemCode], ['itemName', prefill.itemName], ['specification', prefill.specification], ['unit', prefill.unit]]
    : [['customerCode', prefill.customerCode], ['customerName', prefill.customerName], ['address', prefill.address], ['phone', prefill.phone]];
  const changes = fields.filter(([, value]) => clean(value) !== '')
    .map(([field, proposedValue]) => ({ field, beforeValue: null, proposedValue }));
  if (!changes.length) changes.push({ field: product ? 'itemName' : 'customerName', beforeValue: null, proposedValue: product ? '미등록 상품' : '미등록 거래처' });
  const entityId = clean(product ? prefill.itemCode : prefill.customerCode) || requestId;
  return {
    schemaVersion: CHANGE_REQUEST_SCHEMA,
    requestId,
    idempotencyKey: clean(context.idempotencyKey) || `${requestId}:${entityId}`,
    domain: product ? 'PRODUCT' : 'CUSTOMER',
    ownerAppId: product ? PRODUCT_OWNER_APP_ID : CUSTOMER_OWNER_APP_ID,
    entityId,
    operation: 'CREATE',
    requestedAt: context.requestedAt || new Date().toISOString(),
    changes,
    source: {
      appId: 'smart-input',
      route: 'smartinput/index.html',
      mode: clean(context.mode),
      documentId: clean(context.documentId),
      rowId: clean(context.rowId)
    },
    actor: { actorState: 'UNVERIFIED_LOCAL' }
  };
}

async function submitRegistrationChangeRequest(domain, request, options = {}) {
  try {
    const module = await (options.adapterLoader || (async requestedDomain => requestedDomain === 'product'
      ? import('../reference-data/product-change-request-adapter.js')
      : import('../customer-master/change-request-adapter.js')))(domain);
    const adapter = domain === 'product'
      ? (module.productMasterChangeRequestAdapter || globalThis.ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER)
      : (module.customerMasterChangeRequestAdapter || globalThis.ONEAPP_CUSTOMER_MASTER_CHANGE_REQUEST_ADAPTER);
    if (!adapter?.submitChangeRequest) throw new Error(`${domain.toUpperCase()}_CHANGE_REQUEST_ADAPTER_NOT_AVAILABLE`);
    return adapter.submitChangeRequest(request);
  } catch (error) {
    return {
      schemaVersion: CHANGE_REQUEST_SCHEMA,
      accepted: false,
      status: 'NOT_AVAILABLE',
      requestId: clean(request?.requestId),
      idempotencyKey: clean(request?.idempotencyKey),
      error: formatReferenceError(error, domain)
    };
  }
}

function referenceSourceLabel(reference) {
  if (!reference) return '아직 확인하지 않음';
  const owner = reference.domain === 'product' ? '상품관리' : '거래처관리';
  if (reference.fallback) return `${owner} 직접 읽기 fallback`;
  if (String(reference.source || '').startsWith('CACHE:')) return `SmartInput 로컬 보관 · ${owner}`;
  return `${owner} Snapshot Adapter`;
}

return { REFERENCE_DOMAIN_STATUS, REFERENCE_CACHE_SCHEMA, normalizeReferenceSearchText, normalizeProductReferenceRow, normalizeCustomerReferenceRow, loadReferenceDomain, normalizeCachedReference, sameReferenceRevision, diffReferenceSnapshots, createProductMatchIndex, searchProductMatchIndex, classifyProductMatch, ownerAppHref, buildRegistrationChangeRequest, submitRegistrationChangeRequest, referenceSourceLabel };
})();

// ============================================================================
// reference-generation-repository.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const referenceGenerationRepositorySection = (() => {
const { canonicalSha256 } = officialVoucherCoreDependency1;
const { activateReferenceGeneration, loadActiveReferenceGeneration, saveReferenceGenerationState } = smartinputDataStoreDependency0;

const REFERENCE_GENERATION_SCHEMA = 'ONEAPP_REFERENCE_GENERATION_V1';
const REFERENCE_DOMAINS = Object.freeze(['customer', 'product', 'warehouse', 'employee', 'project', 'fieldDefinition']);

const text = value => String(value ?? '').normalize('NFKC').trim();
const clone = value => JSON.parse(JSON.stringify(value));

function referenceEntityId(domain, row = {}) {
  const fields = {
    customer: ['customerId', 'customerCode'],
    product: ['productId', 'masterProductId', 'itemCode'],
    warehouse: ['warehouseId', 'warehouseCode'],
    employee: ['loginId', 'userId'],
    project: ['projectId', 'projectCode'],
    fieldDefinition: ['fieldId']
  }[domain] || [];
  const id = fields.map(field => text(row[field])).find(Boolean);
  if (!id) throw new Error(`SMARTINPUT_REFERENCE_ENTITY_ID_REQUIRED:${domain}`);
  return id;
}

function normalizeReferenceDomainSnapshot(domain, snapshot = {}, companyId) {
  if (!REFERENCE_DOMAINS.includes(domain)) throw new Error(`SMARTINPUT_REFERENCE_DOMAIN_INVALID:${domain}`);
  const status = text(snapshot.status || (snapshot.rows?.length ? 'READY' : 'EMPTY')).toUpperCase();
  if (!['READY', 'EMPTY'].includes(status)) throw new Error(`SMARTINPUT_REFERENCE_DOMAIN_ERROR:${domain}`);
  const rows = clone(Array.isArray(snapshot.rows) ? snapshot.rows : []);
  if (status === 'EMPTY' && rows.length) throw new Error(`SMARTINPUT_REFERENCE_EMPTY_HAS_ROWS:${domain}`);
  const ids = new Set();
  const entities = rows.map(row => {
    const entityId = referenceEntityId(domain, row);
    if (ids.has(entityId)) throw new Error(`SMARTINPUT_REFERENCE_ENTITY_DUPLICATED:${domain}:${entityId}`);
    ids.add(entityId);
    const code = text(row.customerCode || row.itemCode || row.warehouseCode || row.loginId || row.projectCode || row.sourceFieldCode);
    const searchText = [code, row.customerName, row.itemName, row.warehouseName, row.displayName,
      row.projectName, row.displayLabel, row.advancedLabel].map(text).filter(Boolean).join(' ').toLocaleLowerCase('ko');
    return { companyId, domain, entityId, code, searchText, value: row };
  });
  const contentHash = text(snapshot.contentHash) || canonicalSha256(rows);
  return {
    domain,
    status: rows.length ? 'READY' : 'EMPTY',
    ownerRevision: text(snapshot.ownerRevision ?? snapshot.revision ?? snapshot.snapshotId ?? '0'),
    count: rows.length,
    contentHash,
    entities
  };
}

function buildReferenceGeneration({ companyId, generationId, snapshots = {}, startedAt = new Date().toISOString() } = {}) {
  const company = text(companyId);
  const id = text(generationId);
  if (!company) throw new Error('SMARTINPUT_REFERENCE_COMPANY_REQUIRED');
  if (!id) throw new Error('SMARTINPUT_REFERENCE_GENERATION_ID_REQUIRED');
  const domains = {};
  const entities = [];
  REFERENCE_DOMAINS.forEach(domain => {
    if (!snapshots[domain]) throw new Error(`SMARTINPUT_REFERENCE_DOMAIN_MISSING:${domain}`);
    const normalized = normalizeReferenceDomainSnapshot(domain, snapshots[domain], company);
    domains[domain] = {
      status: normalized.status,
      ownerRevision: normalized.ownerRevision,
      count: normalized.count,
      contentHash: normalized.contentHash
    };
    normalized.entities.forEach(row => entities.push({ ...row, generationId: id }));
  });
  const completedAt = new Date().toISOString();
  return {
    generation: {
      schemaVersion: REFERENCE_GENERATION_SCHEMA,
      generationId: id,
      companyId: company,
      status: 'STAGED',
      domains,
      startedAt,
      completedAt,
      activatedAt: ''
    },
    entities
  };
}

async function beginReferenceGeneration(companyId, generationId, startedAt = new Date().toISOString()) {
  const generation = {
    schemaVersion: REFERENCE_GENERATION_SCHEMA,
    generationId,
    companyId,
    status: 'STAGING',
    domains: {},
    startedAt,
    completedAt: '',
    activatedAt: ''
  };
  await saveReferenceGenerationState(generation);
  return generation;
}

async function failReferenceGeneration(generation, error) {
  const failed = {
    ...generation,
    status: 'FAILED',
    completedAt: new Date().toISOString(),
    error: { code: text(error?.code || error?.message || 'REFERENCE_REFRESH_FAILED'), message: text(error?.message || error) }
  };
  await saveReferenceGenerationState(failed);
  return failed;
}

async function commitReferenceGeneration(bundle) {
  return activateReferenceGeneration(bundle);
}

return { REFERENCE_GENERATION_SCHEMA, REFERENCE_DOMAINS, referenceEntityId, normalizeReferenceDomainSnapshot, buildReferenceGeneration, beginReferenceGeneration, failReferenceGeneration, commitReferenceGeneration, loadActiveReferenceGeneration };
})();

// ============================================================================
// input-matching-snapshot.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const inputMatchingSnapshotSection = (() => {
const { cloneJson, deepFreeze, sha256Hex } = changeRequestContractDependency2;
const { loadSettingValue, saveSettingValue } = smartinputDataStoreDependency0;

const SCHEMA = 'ONEAPP_ORDERQ_INPUT_MATCHING_SNAPSHOT_V1';
const text = value => String(value ?? '').trim();
const requests = new Map(), writes = new Map();
const failure = error => ({ status: 'ERROR', error: { code: 'INPUT_MATCHING_SNAPSHOT_FAILED', message: error?.message || String(error) } });
const stale = () => ({ status: 'STALE', error: { code: 'INPUT_MATCHING_SCOPE_CHANGED', message: '입력 기준을 요청한 회사·사용자 또는 갱신 요청이 변경되었습니다.' } });

function scopeKey({ companyId, actorId } = {}) {
  if (!text(companyId) || !text(actorId)) throw new Error('INPUT_MATCHING_SCOPE_REQUIRED');
  return `inputMatchingSnapshot:v1:${encodeURIComponent(text(companyId))}:${encodeURIComponent(text(actorId))}`;
}

async function validateInputMatchingSnapshot(value, scope) {
  scopeKey(scope);
  const snapshot = cloneJson(value);
  if (!snapshot || snapshot.schemaVersion !== SCHEMA || snapshot.ownerAppId !== 'orderq-vnext'
    || snapshot.sourceDatabase !== 'oneapp-orderq-pre-m1-v6' || snapshot.legacyDefaultCompanyId !== 'ONEAPP'
    || snapshot.companyId !== text(scope.companyId) || snapshot.actorId !== text(scope.actorId)
    || !snapshot.readAt || Number.isNaN(Date.parse(snapshot.readAt))) throw new Error('INPUT_MATCHING_SNAPSHOT_SCOPE_INVALID');
  for (const field of ['products', 'mappings', 'history']) {
    if (!Array.isArray(snapshot[field]) || snapshot.counts?.[field] !== snapshot[field].length
      || snapshot[field].some(row => !row || row.companyId !== snapshot.companyId)) throw new Error('INPUT_MATCHING_SNAPSHOT_ROWS_INVALID');
  }
  const { contentHash, readAt, ...content } = snapshot;
  if (!contentHash || await sha256Hex(content) !== contentHash) throw new Error('INPUT_MATCHING_SNAPSHOT_HASH_INVALID');
  return deepFreeze(snapshot);
}

function result(snapshot) {
  return { status: snapshot.products.length || snapshot.mappings.length || snapshot.history.length ? 'READY' : 'EMPTY', snapshot };
}

// Startup and ordinary intake read only the SmartInput-owned cache. Owner code is
// loaded exclusively by the explicit refresh below; this is never an owner writer.
async function loadLocalInputMatchingSnapshot(scope, { loadValue = loadSettingValue, isCurrent = () => true } = {}) {
  try {
    if (!isCurrent()) return stale();
    const value = await loadValue(scopeKey(scope));
    if (!isCurrent()) return stale();
    if (value === null || value === undefined) return { status: 'NOT_PREPARED', snapshot: null };
    const snapshot = await validateInputMatchingSnapshot(value, scope);
    return isCurrent() ? result(snapshot) : stale();
  } catch (error) { return failure(error); }
}

async function refreshInputMatchingSnapshot(scope, {
  readOwner = async request => (await import('../orderq/input-matching-read-adapter.js?v=0.1.0')).readInputMatchingSnapshot(request),
  saveValue = saveSettingValue, isCurrent = () => true
} = {}) {
  try {
    const key = scopeKey(scope), requestId = (requests.get(key) || 0) + 1;
    requests.set(key, requestId);
    const current = () => isCurrent() && requests.get(key) === requestId;
    if (!current()) return stale();
    const response = await readOwner({ companyId: text(scope.companyId), actorId: text(scope.actorId) });
    if (!current()) return stale();
    if (!['READY', 'EMPTY'].includes(response?.status)) throw new Error(response?.error?.message || 'INPUT_MATCHING_OWNER_NOT_READY');
    const snapshot = await validateInputMatchingSnapshot(response.snapshot, scope);
    if (result(snapshot).status !== response.status) throw new Error('INPUT_MATCHING_OWNER_STATUS_INVALID');
    // Serialize writes per scope so an older in-flight write cannot replace a
    // newer refresh. Recheck actor/company both before persistence and activation.
    const pending = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!current()) return stale();
      await saveValue(key, snapshot);
      return current() ? result(snapshot) : stale();
    });
    writes.set(key, pending);
    try { return await pending; }
    finally { if (writes.get(key) === pending) writes.delete(key); }
  } catch (error) { return failure(error); }
}

function inputContextFromMatchingSnapshot(snapshot, fallback) {
  if (!snapshot || snapshot.companyId !== fallback.companyId || snapshot.actorId !== fallback.actorId) return fallback;
  return { ...fallback, products: snapshot.products, mappings: snapshot.mappings, history: snapshot.history, revision: snapshot.contentHash };
}

function inputMatchingAnalysisRevision(snapshot, fallback) {
  const scoped = snapshot && snapshot.companyId === fallback.companyId && snapshot.actorId === fallback.actorId;
  return JSON.stringify([fallback.companyId, fallback.actorId, scoped ? snapshot.contentHash : null, fallback.revision || '']);
}

function canReuseInputAnalysis(batch, { contentHash, matchingRevision, automatic = false }) {
  // A refreshed snapshot never rewrites existing work merely because an automatic
  // analysis is scheduled. Explicit analysis may apply a new matching revision.
  return Boolean(batch?.contentHash && batch.contentHash === contentHash
    && (automatic || batch.inputMatchingRevision === matchingRevision));
}

return { validateInputMatchingSnapshot, loadLocalInputMatchingSnapshot, refreshInputMatchingSnapshot, inputContextFromMatchingSnapshot, inputMatchingAnalysisRevision, canReuseInputAnalysis };
})();

// ============================================================================
// reference-refresh-controller.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const referenceRefreshControllerSection = (() => {
const { loadWarehouseCatalog } = legacyIntegrationAdapterDependency3;
const { loadFieldDefinitions, loadSettingValue } = smartinputDataStoreDependency0;
const { ensureFieldCatalogSeed } = fieldRegistrySection;
const { loadReferenceDomain } = referenceDataControllerSection;
const { beginReferenceGeneration, buildReferenceGeneration, commitReferenceGeneration, failReferenceGeneration, loadActiveReferenceGeneration, normalizeReferenceDomainSnapshot, REFERENCE_DOMAINS, REFERENCE_GENERATION_SCHEMA } = referenceGenerationRepositorySection;

const text = value => String(value ?? '').trim();

function generationId() {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `REFGEN-${token}`;
}

// Independent work reads only a complete generation already activated in this app.
// The legacy owner catalog also migrates orders, so it is reserved for explicit refresh.
async function loadLocalWarehouseCatalog(companyId, { loadGeneration = loadActiveReferenceGeneration } = {}) {
  const company = text(companyId);
  const stored = await loadGeneration(company);
  if (!stored) throw new Error('로컬 창고 기준정보가 없습니다. 기준정보 갱신을 실행하세요. 입력과 자동저장은 계속 사용할 수 있습니다.');
  const { generation, entities } = stored;
  if (generation?.schemaVersion !== REFERENCE_GENERATION_SCHEMA || generation.status !== 'ACTIVE'
    || generation.companyId !== company || !Array.isArray(entities)
    || entities.some(row => row.companyId !== company || row.generationId !== generation.generationId)) {
    throw new Error('SMARTINPUT_LOCAL_REFERENCE_SCOPE_INVALID');
  }
  for (const domain of REFERENCE_DOMAINS) {
    const metadata = generation.domains?.[domain];
    const count = entities.filter(row => row.domain === domain).length;
    if (!metadata || !['READY', 'EMPTY'].includes(metadata.status) || metadata.count !== count
      || (metadata.status === 'EMPTY') !== (count === 0)) throw new Error('SMARTINPUT_LOCAL_REFERENCE_GENERATION_INVALID');
  }
  const warehouses = entities.filter(row => row.domain === 'warehouse').map(row => row.value);
  const normalized = normalizeReferenceDomainSnapshot('warehouse', { rows: warehouses }, company);
  if (normalized.contentHash !== generation.domains.warehouse.contentHash) throw new Error('SMARTINPUT_LOCAL_WAREHOUSE_CONTENT_CHANGED');
  return {
    warehouses,
    aliases: warehouses.flatMap(row => Array.isArray(row.referenceAliases) ? row.referenceAliases.filter(alias => alias.warehouseId === row.warehouseId) : []),
    aliasesAvailable: warehouses.every(row => Array.isArray(row.referenceAliases)),
    revision: generation.domains.warehouse.ownerRevision,
    generationId: generation.generationId
  };
}

function sessionEmployee() {
  try {
    const bundle = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    const user = bundle?.session?.user;
    if (!text(user?.loginId)) return [];
    return [{
      userId: text(user.userId),
      loginId: text(user.loginId),
      employeeCode: text(user.loginId),
      displayName: text(user.displayName || user.loginId),
      status: 'ACTIVE',
      revision: Number(user.version || 0)
    }];
  } catch {
    return [];
  }
}

async function readAllReferenceSnapshots({ companyId, referenceLoader = loadReferenceDomain, warehouseLoader = loadWarehouseCatalog } = {}) {
  const seed = await ensureFieldCatalogSeed({ force: true });
  const [product, customer, warehouseCatalog] = await Promise.all([
    referenceLoader('product', { allowFallback: false }),
    referenceLoader('customer', { allowFallback: false }),
    warehouseLoader()
  ]);
  if (product.status === 'ERROR') throw new Error(product.error?.message || 'PRODUCT_REFERENCE_REFRESH_FAILED');
  if (customer.status === 'ERROR') throw new Error(customer.error?.message || 'CUSTOMER_REFERENCE_REFRESH_FAILED');
  const fieldDefinitions = await loadFieldDefinitions(seed.metadata.generationId);
  return {
    product: { status: product.status, rows: product.rows, revision: product.revision, contentHash: product.contentHash },
    customer: { status: customer.status, rows: customer.rows, revision: customer.revision, contentHash: customer.contentHash },
    warehouse: {
      status: warehouseCatalog.warehouses?.length ? 'READY' : 'EMPTY',
      rows: (warehouseCatalog.warehouses || []).map(row => ({
        ...row,
        referenceAliases: (warehouseCatalog.aliases || []).filter(alias => alias.warehouseId === row.warehouseId)
      })),
      revision: warehouseCatalog.revision || warehouseCatalog.updatedAt || '0'
    },
    employee: { status: sessionEmployee().length ? 'READY' : 'EMPTY', rows: sessionEmployee(), revision: 'NEXUS-SESSION' },
    project: { status: 'EMPTY', rows: [], revision: '0' },
    fieldDefinition: {
      status: fieldDefinitions.length ? 'READY' : 'EMPTY',
      rows: fieldDefinitions,
      revision: seed.metadata.sourceSha256,
      contentHash: seed.metadata.sourceSha256
    },
    companyId,
    previousGenerationId: (await loadSettingValue(`referenceActive:${companyId}`))?.generationId || ''
  };
}

async function refreshAllReferenceData({ companyId, snapshotLoader = readAllReferenceSnapshots } = {}) {
  const id = generationId();
  const startedAt = new Date().toISOString();
  const staging = await beginReferenceGeneration(companyId, id, startedAt);
  try {
    const snapshots = await snapshotLoader({ companyId });
    const bundle = buildReferenceGeneration({ companyId, generationId: id, snapshots, startedAt });
    const generation = await commitReferenceGeneration(bundle);
    globalThis.dispatchEvent?.(new CustomEvent('smartinput:reference-generation-activated', {
      detail: { generation, domains: generation.domains }
    }));
    return { generation, entities: bundle.entities };
  } catch (error) {
    await failReferenceGeneration(staging, error);
    throw error;
  }
}

return { loadLocalWarehouseCatalog, readAllReferenceSnapshots, refreshAllReferenceData };
})();

// Public API (same functions and constants; no additional command layer).
export const FIELD_DEFINITION_SCHEMA = fieldRegistrySection.FIELD_DEFINITION_SCHEMA;
export const FIELD_SETTING_SCHEMA = fieldRegistrySection.FIELD_SETTING_SCHEMA;
export const FIELD_CATALOG_SEED_SCHEMA = fieldRegistrySection.FIELD_CATALOG_SEED_SCHEMA;
export const VOUCHER_MODES = fieldRegistrySection.VOUCHER_MODES;
export const FIELD_SCOPES = fieldRegistrySection.FIELD_SCOPES;
export const FIELD_STATUSES = fieldRegistrySection.FIELD_STATUSES;
export const OWNER_DOMAINS = fieldRegistrySection.OWNER_DOMAINS;
export const CORE_FIELD_DEFINITIONS = fieldRegistrySection.CORE_FIELD_DEFINITIONS;
export const CUSTOM_FIELD_DEFINITIONS = fieldRegistrySection.CUSTOM_FIELD_DEFINITIONS;
export const validateFieldDefinition = fieldRegistrySection.validateFieldDefinition;
export const validateFieldCatalog = fieldRegistrySection.validateFieldCatalog;
export const defaultCompanyVoucherFieldSettings = fieldRegistrySection.defaultCompanyVoucherFieldSettings;
export const normalizeCompanyVoucherFieldSettings = fieldRegistrySection.normalizeCompanyVoucherFieldSettings;
export const effectiveFieldDefinitions = fieldRegistrySection.effectiveFieldDefinitions;
export const coreFieldByProjection = fieldRegistrySection.coreFieldByProjection;
export const SETTINGS_FIELD_GROUPS = fieldRegistrySection.SETTINGS_FIELD_GROUPS;
export const settingsFieldGroupId = fieldRegistrySection.settingsFieldGroupId;
export const sortSettingsFields = fieldRegistrySection.sortSettingsFields;
export const parseSettingsInputOrder = fieldRegistrySection.parseSettingsInputOrder;
export const reorderSettingsInputOrder = fieldRegistrySection.reorderSettingsInputOrder;
export const compactSettingsInputOrder = fieldRegistrySection.compactSettingsInputOrder;
export const settingsInputOrderPreview = fieldRegistrySection.settingsInputOrderPreview;
export const FIELD_SEED_META_KEY = fieldRegistrySection.FIELD_SEED_META_KEY;
export const DEFAULT_COMPANY_ID = fieldRegistrySection.DEFAULT_COMPANY_ID;
export const resolveSmartInputCompanyId = fieldRegistrySection.resolveSmartInputCompanyId;
export const resolveSmartInputActor = fieldRegistrySection.resolveSmartInputActor;
export const fetchStaticFieldCatalog = fieldRegistrySection.fetchStaticFieldCatalog;
export const updateVoucherFieldSettings = fieldRegistrySection.updateVoucherFieldSettings;
export const invalidateFieldRegistryCache = fieldRegistrySection.invalidateFieldRegistryCache;
export const ensureFieldCatalogSeed = fieldRegistrySection.ensureFieldCatalogSeed;
export const loadVoucherFieldRegistry = fieldRegistrySection.loadVoucherFieldRegistry;
export const REFERENCE_DOMAIN_STATUS = referenceDataControllerSection.REFERENCE_DOMAIN_STATUS;
export const REFERENCE_CACHE_SCHEMA = referenceDataControllerSection.REFERENCE_CACHE_SCHEMA;
export const normalizeReferenceSearchText = referenceDataControllerSection.normalizeReferenceSearchText;
export const normalizeProductReferenceRow = referenceDataControllerSection.normalizeProductReferenceRow;
export const normalizeCustomerReferenceRow = referenceDataControllerSection.normalizeCustomerReferenceRow;
export const loadReferenceDomain = referenceDataControllerSection.loadReferenceDomain;
export const normalizeCachedReference = referenceDataControllerSection.normalizeCachedReference;
export const sameReferenceRevision = referenceDataControllerSection.sameReferenceRevision;
export const diffReferenceSnapshots = referenceDataControllerSection.diffReferenceSnapshots;
export const createProductMatchIndex = referenceDataControllerSection.createProductMatchIndex;
export const searchProductMatchIndex = referenceDataControllerSection.searchProductMatchIndex;
export const classifyProductMatch = referenceDataControllerSection.classifyProductMatch;
export const ownerAppHref = referenceDataControllerSection.ownerAppHref;
export const buildRegistrationChangeRequest = referenceDataControllerSection.buildRegistrationChangeRequest;
export const submitRegistrationChangeRequest = referenceDataControllerSection.submitRegistrationChangeRequest;
export const referenceSourceLabel = referenceDataControllerSection.referenceSourceLabel;
export const REFERENCE_GENERATION_SCHEMA = referenceGenerationRepositorySection.REFERENCE_GENERATION_SCHEMA;
export const REFERENCE_DOMAINS = referenceGenerationRepositorySection.REFERENCE_DOMAINS;
export const referenceEntityId = referenceGenerationRepositorySection.referenceEntityId;
export const normalizeReferenceDomainSnapshot = referenceGenerationRepositorySection.normalizeReferenceDomainSnapshot;
export const buildReferenceGeneration = referenceGenerationRepositorySection.buildReferenceGeneration;
export const beginReferenceGeneration = referenceGenerationRepositorySection.beginReferenceGeneration;
export const failReferenceGeneration = referenceGenerationRepositorySection.failReferenceGeneration;
export const commitReferenceGeneration = referenceGenerationRepositorySection.commitReferenceGeneration;
export const loadActiveReferenceGeneration = referenceGenerationRepositorySection.loadActiveReferenceGeneration;
export const validateInputMatchingSnapshot = inputMatchingSnapshotSection.validateInputMatchingSnapshot;
export const loadLocalInputMatchingSnapshot = inputMatchingSnapshotSection.loadLocalInputMatchingSnapshot;
export const refreshInputMatchingSnapshot = inputMatchingSnapshotSection.refreshInputMatchingSnapshot;
export const inputContextFromMatchingSnapshot = inputMatchingSnapshotSection.inputContextFromMatchingSnapshot;
export const inputMatchingAnalysisRevision = inputMatchingSnapshotSection.inputMatchingAnalysisRevision;
export const canReuseInputAnalysis = inputMatchingSnapshotSection.canReuseInputAnalysis;
export const loadLocalWarehouseCatalog = referenceRefreshControllerSection.loadLocalWarehouseCatalog;
export const readAllReferenceSnapshots = referenceRefreshControllerSection.readAllReferenceSnapshots;
export const refreshAllReferenceData = referenceRefreshControllerSection.refreshAllReferenceData;
