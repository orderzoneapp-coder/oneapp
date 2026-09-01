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

const text = value => String(value ?? '').normalize('NFKC').trim();
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
    role: text(options.role || key).toUpperCase(),
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
  if (!text(definition.fieldId)) throw new Error('SMARTINPUT_FIELD_ID_REQUIRED');
  if (!OWNER_DOMAINS.includes(definition.ownerDomain)) throw new Error(`SMARTINPUT_FIELD_OWNER_INVALID:${definition.fieldId}`);
  if (!FIELD_SCOPES.includes(definition.scope)) throw new Error(`SMARTINPUT_FIELD_SCOPE_INVALID:${definition.fieldId}`);
  if (!FIELD_STATUSES.includes(definition.status)) throw new Error(`SMARTINPUT_FIELD_STATUS_INVALID:${definition.fieldId}`);
  if (!Array.isArray(definition.voucherModes) || !definition.voucherModes.length
    || definition.voucherModes.some(mode => !VOUCHER_MODES.includes(mode))) throw new Error(`SMARTINPUT_FIELD_MODE_INVALID:${definition.fieldId}`);
  if (!text(definition.displayLabel) || !text(definition.advancedLabel)) throw new Error(`SMARTINPUT_FIELD_LABEL_REQUIRED:${definition.fieldId}`);
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
  const company = text(companyId);
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
    updatedBy: text(actor),
    updatedAt: now
  }));
}

export function normalizeCompanyVoucherFieldSettings(companyId, voucherMode, settings = [], actor = '', additionalDefinitions = []) {
  const defaults = defaultCompanyVoucherFieldSettings(companyId, voucherMode, actor);
  const definitions = new Map([...CORE_FIELD_DEFINITIONS, ...CUSTOM_FIELD_DEFINITIONS, ...additionalDefinitions].map(field => [field.fieldId, field]));
  const supplied = new Map((Array.isArray(settings) ? settings : []).filter(row => row.voucherMode === voucherMode).map(row => [text(row.fieldId), row]));
  const result = defaults.map(fallback => {
    const source = supplied.get(fallback.fieldId) || {};
    const definition = definitions.get(fallback.fieldId);
    return {
      ...fallback,
      ...clone(source),
      schemaVersion: FIELD_SETTING_SCHEMA,
      companyId: text(companyId),
      voucherMode,
      fieldId: fallback.fieldId,
      enabled: definition.systemRequired ? true : source.enabled !== false,
      required: definition.systemRequired ? true : source.required === true,
      userLabel: text(source.userLabel) || definition.displayLabel
    };
  });
  (Array.isArray(settings) ? settings : []).forEach(source => {
    const definition = definitions.get(text(source.fieldId));
    if (!definition || result.some(row => row.fieldId === definition.fieldId)) return;
    result.push({
      schemaVersion: FIELD_SETTING_SCHEMA,
      companyId: text(companyId),
      voucherMode,
      fieldId: definition.fieldId,
      enabled: source.enabled === true,
      required: false,
      uiZone: source.uiZone === 'HEADER_FORM' ? 'HEADER_FORM' : 'LINE_GRID',
      uiOrder: Number(source.uiOrder || 999),
      width: Number(source.width || 120),
      userLabel: text(source.userLabel) || definition.displayLabel,
      settingRevision: Number(source.settingRevision || 1),
      updatedBy: text(source.updatedBy || actor),
      updatedAt: text(source.updatedAt) || new Date().toISOString()
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
      displayLabel: text(enabled.get(definition.fieldId)?.userLabel) || definition.displayLabel,
      setting: clone(enabled.get(definition.fieldId))
    }))
    .sort((left, right) => Number(left.setting.uiOrder || 0) - Number(right.setting.uiOrder || 0));
}

export function coreFieldByProjection(voucherMode, projectionFieldId) {
  return CORE_FIELD_DEFINITIONS.find(field => field.voucherModes.includes(voucherMode) && field.projectionFieldId === projectionFieldId) || null;
}
