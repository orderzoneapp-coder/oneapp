export const SMARTINPUT_DB_NAME = 'oneapp-smartinput';
export const SMARTINPUT_DB_VERSION = 5;
const DB_NAME = SMARTINPUT_DB_NAME;
const DB_VERSION = SMARTINPUT_DB_VERSION;
const FALLBACK_KEY = 'oneapp.smartinput.relationships.v1';
const INPUT_TEMPLATES_KEY = 'inputTemplates';

export const DATA_STORES = Object.freeze({
  SETTINGS: 'settings',
  LINK_GROUPS: 'customerLinkGroups',
  TEMPORARY_CUSTOMERS: 'temporaryCustomers',
  ALIAS_MAPPINGS: 'customerAliasMappings',
  ESTIMATES: 'estimates',
  SOURCE_IMAGES: 'sourceImages',
  AUTOSAVE: 'autosave',
  FIELD_DEFINITIONS_V2: 'fieldDefinitionsV2',
  COMPANY_VOUCHER_FIELDS_V1: 'companyVoucherFieldsV1',
  REFERENCE_GENERATIONS_V1: 'referenceGenerationsV1',
  REFERENCE_ENTITIES_V1: 'referenceEntitiesV1',
  INPUT_TEMPLATES_V2: 'inputTemplatesV2',
  MAPPING_SESSIONS_V2: 'mappingSessionsV2',
  DRAFT_VOUCHERS_V2: 'draftVouchersV2'
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('스마트입력 저장소 요청에 실패했습니다.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('스마트입력 저장이 취소되었습니다.'));
    transaction.onerror = () => reject(transaction.error || new Error('스마트입력 저장에 실패했습니다.'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DATA_STORES.SETTINGS)) db.createObjectStore(DATA_STORES.SETTINGS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(DATA_STORES.LINK_GROUPS)) {
        const store = db.createObjectStore(DATA_STORES.LINK_GROUPS, { keyPath: 'linkGroupId' });
        store.createIndex('byTaxCustomerId', 'taxCustomerId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.TEMPORARY_CUSTOMERS)) {
        const store = db.createObjectStore(DATA_STORES.TEMPORARY_CUSTOMERS, { keyPath: 'customerId' });
        store.createIndex('byLinkGroupId', 'linkGroupId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.ALIAS_MAPPINGS)) {
        const store = db.createObjectStore(DATA_STORES.ALIAS_MAPPINGS, { keyPath: 'aliasMappingId' });
        store.createIndex('byNormalizedName', 'normalizedName', { unique: false });
        store.createIndex('byContextKey', 'contextKey', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.ESTIMATES)) {
        const store = db.createObjectStore(DATA_STORES.ESTIMATES, { keyPath: 'estimateId' });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        store.createIndex('byCustomerName', 'customerName', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.SOURCE_IMAGES)) {
        const store = db.createObjectStore(DATA_STORES.SOURCE_IMAGES, { keyPath: 'documentId' });
        store.createIndex('byMode', 'mode', { unique: false });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.AUTOSAVE)) {
        db.createObjectStore(DATA_STORES.AUTOSAVE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.FIELD_DEFINITIONS_V2)) {
        const store = db.createObjectStore(DATA_STORES.FIELD_DEFINITIONS_V2, { keyPath: ['generationId', 'fieldId'] });
        store.createIndex('byGeneration', 'generationId', { unique: false });
        store.createIndex('byGenerationMode', ['generationId', 'voucherMode'], { unique: false, multiEntry: false });
        store.createIndex('byStatus', ['generationId', 'status'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1)) {
        const store = db.createObjectStore(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1, { keyPath: ['companyId', 'voucherMode', 'fieldId'] });
        store.createIndex('byCompanyMode', ['companyId', 'voucherMode'], { unique: false });
        store.createIndex('byEnabled', ['companyId', 'voucherMode', 'enabled'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.REFERENCE_GENERATIONS_V1)) {
        const store = db.createObjectStore(DATA_STORES.REFERENCE_GENERATIONS_V1, { keyPath: 'generationId' });
        store.createIndex('byCompanyStatus', ['companyId', 'status'], { unique: false });
        store.createIndex('byActivatedAt', 'activatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.REFERENCE_ENTITIES_V1)) {
        const store = db.createObjectStore(DATA_STORES.REFERENCE_ENTITIES_V1, { keyPath: ['generationId', 'domain', 'entityId'] });
        store.createIndex('byGenerationDomain', ['generationId', 'domain'], { unique: false });
        store.createIndex('byCompanyDomainCode', ['companyId', 'domain', 'code'], { unique: false });
        store.createIndex('bySearchText', ['generationId', 'domain', 'searchText'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.INPUT_TEMPLATES_V2)) {
        const store = db.createObjectStore(DATA_STORES.INPUT_TEMPLATES_V2, { keyPath: 'templateId' });
        store.createIndex('byCompanyModeSignature', ['companyId', 'voucherMode', 'signature'], { unique: true });
        store.createIndex('byCompanyModeStatus', ['companyId', 'voucherMode', 'status'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.MAPPING_SESSIONS_V2)) {
        const store = db.createObjectStore(DATA_STORES.MAPPING_SESSIONS_V2, { keyPath: 'sessionId' });
        store.createIndex('byCompanyModeUpdatedAt', ['companyId', 'voucherMode', 'updatedAt'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.DRAFT_VOUCHERS_V2)) {
        const store = db.createObjectStore(DATA_STORES.DRAFT_VOUCHERS_V2, { keyPath: 'draftId' });
        store.createIndex('byCompanyModeStatus', ['companyId', 'voucherMode', 'status'], { unique: false });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        store.createIndex('byIdempotencyKey', 'idempotencyKey', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('스마트입력 저장소를 열지 못했습니다.'));
  });
}

function readFallback() {
  try {
    const value = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function writeFallback(value) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(value));
}

function canonicalRecord(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRecord).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalRecord(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertEstimatePreimages(currentRecords, expectedPreimages = []) {
  for (const expected of expectedPreimages) {
    if (!expected?.estimateId) throw new Error('SMARTINPUT_ESTIMATE_BUNDLE_PREIMAGE_INVALID');
    const current = currentRecords[expected.estimateId] || null;
    if (canonicalRecord(current) !== canonicalRecord(expected)) {
      throw new Error('SMARTINPUT_ESTIMATE_BUNDLE_STALE');
    }
  }
}

async function getAll(storeName) {
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[storeName] || {});
  const transaction = db.transaction(storeName, 'readonly');
  const rows = await requestResult(transaction.objectStore(storeName).getAll());
  db.close();
  return rows;
}

async function get(storeName, key) {
  const db = await openDatabase();
  if (!db) return readFallback()[storeName]?.[key] || null;
  const transaction = db.transaction(storeName, 'readonly');
  const record = await requestResult(transaction.objectStore(storeName).get(key));
  db.close();
  return record || null;
}

async function put(storeName, record, keyField) {
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[storeName] ||= {};
    value[storeName][record[keyField]] = record;
    writeFallback(value);
    return record;
  }
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(record);
  await transactionDone(transaction);
  db.close();
  return record;
}

async function remove(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    if (value[storeName]) delete value[storeName][key];
    writeFallback(value);
    return;
  }
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
  db.close();
}

export function normalizeAliasName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,:;·_()[\]{}<>]/g, '');
}

export function createRecordId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function loadSmartInputData() {
  const [settingsRows, linkGroups, temporaryCustomers, aliasMappings, estimates, sourceImages] = await Promise.all([
    getAll(DATA_STORES.SETTINGS),
    getAll(DATA_STORES.LINK_GROUPS),
    getAll(DATA_STORES.TEMPORARY_CUSTOMERS),
    getAll(DATA_STORES.ALIAS_MAPPINGS),
    getAll(DATA_STORES.ESTIMATES),
    getAll(DATA_STORES.SOURCE_IMAGES)
  ]);
  return {
    settings: settingsRows.find(row => row.key === 'app')?.value || null,
    inputTemplates: Array.isArray(settingsRows.find(row => row.key === INPUT_TEMPLATES_KEY)?.value)
      ? settingsRows.find(row => row.key === INPUT_TEMPLATES_KEY).value
      : [],
    referenceCache: {
      product: settingsRows.find(row => row.key === 'reference:product')?.value || null,
      customer: settingsRows.find(row => row.key === 'reference:customer')?.value || null
    },
    linkGroups,
    temporaryCustomers,
    aliasMappings,
    estimates: estimates.sort((left, right) => {
      const leftOrder = Number(left.sortOrder);
      const rightOrder = Number(right.sortOrder);
      if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (Number.isFinite(leftOrder) !== Number.isFinite(rightOrder)) return Number.isFinite(leftOrder) ? -1 : 1;
      return String(left.createdAt || left.updatedAt || '').localeCompare(String(right.createdAt || right.updatedAt || ''));
    }),
    sourceImages
  };
}

export function saveSettings(value) {
  return put(DATA_STORES.SETTINGS, { key: 'app', value, updatedAt: new Date().toISOString() }, 'key');
}

export async function loadSettingValue(key) {
  return (await get(DATA_STORES.SETTINGS, String(key || '').trim()))?.value ?? null;
}

export function saveSettingValue(key, value) {
  const normalized = String(key || '').trim();
  if (!normalized) return Promise.reject(new Error('SMARTINPUT_SETTING_KEY_REQUIRED'));
  return put(DATA_STORES.SETTINGS, { key: normalized, value, updatedAt: new Date().toISOString() }, 'key');
}

function fallbackCompositeKey(parts = []) {
  return parts.map(value => String(value ?? '')).join('\u001f');
}

export async function replaceFieldCatalogGeneration(catalog = {}) {
  const generationId = String(catalog.generationId || '').trim();
  const definitions = Array.isArray(catalog.definitions) ? catalog.definitions : [];
  if (!generationId || !definitions.length) throw new Error('SMARTINPUT_FIELD_CATALOG_INVALID');
  const rows = definitions.map(definition => ({
    ...JSON.parse(JSON.stringify(definition)),
    generationId,
    voucherMode: String(definition.voucherModes?.[0] || '')
  }));
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.FIELD_DEFINITIONS_V2] ||= {};
    Object.keys(value[DATA_STORES.FIELD_DEFINITIONS_V2])
      .filter(key => key.startsWith(`${generationId}\u001f`))
      .forEach(key => { delete value[DATA_STORES.FIELD_DEFINITIONS_V2][key]; });
    rows.forEach(row => { value[DATA_STORES.FIELD_DEFINITIONS_V2][fallbackCompositeKey([generationId, row.fieldId])] = row; });
    writeFallback(value);
    return rows;
  }
  const tx = db.transaction(DATA_STORES.FIELD_DEFINITIONS_V2, 'readwrite');
  const store = tx.objectStore(DATA_STORES.FIELD_DEFINITIONS_V2);
  const keys = await requestResult(store.index('byGeneration').getAllKeys(generationId));
  keys.forEach(key => store.delete(key));
  rows.forEach(row => store.put(row));
  await transactionDone(tx);
  db.close();
  return rows;
}

export async function loadFieldDefinitions(generationId) {
  const normalized = String(generationId || '').trim();
  if (!normalized) return [];
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[DATA_STORES.FIELD_DEFINITIONS_V2] || {})
    .filter(row => row.generationId === normalized);
  const tx = db.transaction(DATA_STORES.FIELD_DEFINITIONS_V2, 'readonly');
  const rows = await requestResult(tx.objectStore(DATA_STORES.FIELD_DEFINITIONS_V2).index('byGeneration').getAll(normalized));
  db.close();
  return rows;
}

export async function loadCompanyVoucherFieldSettings(companyId, voucherMode) {
  const company = String(companyId || '').trim();
  const mode = String(voucherMode || '').trim();
  if (!company || !mode) return [];
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1] || {})
    .filter(row => row.companyId === company && row.voucherMode === mode);
  const tx = db.transaction(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1, 'readonly');
  const rows = await requestResult(tx.objectStore(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1).index('byCompanyMode').getAll([company, mode]));
  db.close();
  return rows;
}

export async function saveCompanyVoucherFieldSettings(settings = []) {
  const rows = Array.isArray(settings) ? settings.map(row => JSON.parse(JSON.stringify(row))) : [];
  if (!rows.length) return [];
  const companyId = String(rows[0].companyId || '').trim();
  const voucherMode = String(rows[0].voucherMode || '').trim();
  if (!companyId || !voucherMode || rows.some(row => row.companyId !== companyId || row.voucherMode !== voucherMode)) {
    throw new Error('SMARTINPUT_FIELD_SETTING_PARTITION_INVALID');
  }
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1] ||= {};
    Object.keys(value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1]).filter(key => key.startsWith(`${companyId}\u001f${voucherMode}\u001f`))
      .forEach(key => { delete value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1][key]; });
    rows.forEach(row => { value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1][fallbackCompositeKey([companyId, voucherMode, row.fieldId])] = row; });
    writeFallback(value);
    return rows;
  }
  const tx = db.transaction(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1, 'readwrite');
  const store = tx.objectStore(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1);
  const keys = await requestResult(store.index('byCompanyMode').getAllKeys([companyId, voucherMode]));
  keys.forEach(key => store.delete(key));
  rows.forEach(row => store.put(row));
  await transactionDone(tx);
  db.close();
  return rows;
}

export async function saveReferenceGenerationState(generation) {
  if (!generation?.generationId || !generation?.companyId) throw new Error('SMARTINPUT_REFERENCE_GENERATION_INVALID');
  return put(DATA_STORES.REFERENCE_GENERATIONS_V1, generation, 'generationId');
}

export async function activateReferenceGeneration({ generation, entities = [] } = {}) {
  if (!generation?.generationId || !generation?.companyId) throw new Error('SMARTINPUT_REFERENCE_GENERATION_INVALID');
  const pointerKey = `referenceActive:${generation.companyId}`;
  const activeGeneration = { ...JSON.parse(JSON.stringify(generation)), status: 'ACTIVE', activatedAt: new Date().toISOString() };
  const rows = entities.map(row => ({ ...JSON.parse(JSON.stringify(row)), generationId: activeGeneration.generationId, companyId: activeGeneration.companyId }));
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.REFERENCE_GENERATIONS_V1] ||= {};
    value[DATA_STORES.REFERENCE_ENTITIES_V1] ||= {};
    const previousId = value[DATA_STORES.SETTINGS]?.[pointerKey]?.value?.generationId;
    if (previousId && value[DATA_STORES.REFERENCE_GENERATIONS_V1][previousId]) {
      value[DATA_STORES.REFERENCE_GENERATIONS_V1][previousId].status = 'SUPERSEDED';
    }
    value[DATA_STORES.REFERENCE_GENERATIONS_V1][activeGeneration.generationId] = activeGeneration;
    rows.forEach(row => { value[DATA_STORES.REFERENCE_ENTITIES_V1][fallbackCompositeKey([row.generationId, row.domain, row.entityId])] = row; });
    value[DATA_STORES.SETTINGS] ||= {};
    value[DATA_STORES.SETTINGS][pointerKey] = { key: pointerKey, value: { generationId: activeGeneration.generationId }, updatedAt: activeGeneration.activatedAt };
    writeFallback(value);
    return activeGeneration;
  }
  const tx = db.transaction([
    DATA_STORES.REFERENCE_GENERATIONS_V1,
    DATA_STORES.REFERENCE_ENTITIES_V1,
    DATA_STORES.SETTINGS
  ], 'readwrite');
  const generationStore = tx.objectStore(DATA_STORES.REFERENCE_GENERATIONS_V1);
  const entityStore = tx.objectStore(DATA_STORES.REFERENCE_ENTITIES_V1);
  const settingsStore = tx.objectStore(DATA_STORES.SETTINGS);
  const pointer = await requestResult(settingsStore.get(pointerKey));
  if (pointer?.value?.generationId) {
    const previous = await requestResult(generationStore.get(pointer.value.generationId));
    if (previous) generationStore.put({ ...previous, status: 'SUPERSEDED', supersededAt: activeGeneration.activatedAt });
  }
  generationStore.put(activeGeneration);
  rows.forEach(row => entityStore.put(row));
  settingsStore.put({ key: pointerKey, value: { generationId: activeGeneration.generationId }, updatedAt: activeGeneration.activatedAt });
  await transactionDone(tx);
  db.close();
  return activeGeneration;
}

export async function loadActiveReferenceGeneration(companyId) {
  const company = String(companyId || '').trim();
  if (!company) return null;
  const pointer = await loadSettingValue(`referenceActive:${company}`);
  if (!pointer?.generationId) return null;
  const generation = await get(DATA_STORES.REFERENCE_GENERATIONS_V1, pointer.generationId);
  if (!generation) return null;
  const db = await openDatabase();
  let entities;
  if (!db) {
    entities = Object.values(readFallback()[DATA_STORES.REFERENCE_ENTITIES_V1] || {})
      .filter(row => row.generationId === pointer.generationId);
  } else {
    const tx = db.transaction(DATA_STORES.REFERENCE_ENTITIES_V1, 'readonly');
    const store = tx.objectStore(DATA_STORES.REFERENCE_ENTITIES_V1);
    entities = (await requestResult(store.getAll())).filter(row => row.generationId === pointer.generationId);
    db.close();
  }
  return { generation, entities };
}

export async function loadInputTemplates(companyId = '', voucherMode = '') {
  const company = String(companyId || '');
  const mode = String(voucherMode || '').toLowerCase();
  const records = await getAll(DATA_STORES.INPUT_TEMPLATES_V2);
  return records
    .filter(record => record?.schemaVersion === 'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V2')
    .filter(record => !company || record.companyId === company)
    .filter(record => !mode || record.voucherMode === mode)
    .filter(record => record.status !== 'DELETED')
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export async function saveInputTemplates(value = [], { companyId = '', voucherMode = '' } = {}) {
  const templates = Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
  const company = String(companyId || templates[0]?.companyId || '');
  const mode = String(voucherMode || templates[0]?.voucherMode || '').toLowerCase();
  if (!company || !mode) throw new Error('INPUT_TEMPLATE_SCOPE_REQUIRED');
  const normalized = templates.map(template => ({
    ...template,
    companyId: company,
    voucherMode: mode,
    status: template.status || 'ACTIVE'
  }));
  const db = await openDatabase();
  if (!db) {
    const fallback = readFallback();
    fallback[DATA_STORES.INPUT_TEMPLATES_V2] ||= {};
    Object.entries(fallback[DATA_STORES.INPUT_TEMPLATES_V2]).forEach(([key, record]) => {
      if (record.companyId === company && record.voucherMode === mode) delete fallback[DATA_STORES.INPUT_TEMPLATES_V2][key];
    });
    normalized.forEach(record => { fallback[DATA_STORES.INPUT_TEMPLATES_V2][record.templateId] = record; });
    writeFallback(fallback);
    return normalized;
  }
  const transaction = db.transaction(DATA_STORES.INPUT_TEMPLATES_V2, 'readwrite');
  const store = transaction.objectStore(DATA_STORES.INPUT_TEMPLATES_V2);
  const existing = await requestResult(store.index('byCompanyModeStatus').getAll([company, mode, 'ACTIVE']));
  const nextIds = new Set(normalized.map(record => record.templateId));
  existing.filter(record => !nextIds.has(record.templateId)).forEach(record => store.delete(record.templateId));
  normalized.forEach(record => store.put(record));
  await transactionDone(transaction);
  db.close();
  return normalized;
}

export function saveMappingSessionV2(session) {
  if (!session?.sessionId || !session?.companyId || !session?.voucherMode) {
    return Promise.reject(new Error('MAPPING_SESSION_SCOPE_REQUIRED'));
  }
  return put(DATA_STORES.MAPPING_SESSIONS_V2, JSON.parse(JSON.stringify(session)), 'sessionId');
}

export function saveReferenceCache(domain, value) {
  if (!['product', 'customer'].includes(domain)) return Promise.reject(new Error('REFERENCE_DOMAIN_INVALID'));
  return put(DATA_STORES.SETTINGS, {
    key: `reference:${domain}`,
    value,
    updatedAt: new Date().toISOString()
  }, 'key');
}

export function saveLinkGroup(group) {
  return put(DATA_STORES.LINK_GROUPS, group, 'linkGroupId');
}

export function deleteLinkGroup(linkGroupId) {
  return remove(DATA_STORES.LINK_GROUPS, linkGroupId);
}

export function saveTemporaryCustomer(customer) {
  return put(DATA_STORES.TEMPORARY_CUSTOMERS, customer, 'customerId');
}

export function saveAliasMapping(mapping) {
  return put(DATA_STORES.ALIAS_MAPPINGS, mapping, 'aliasMappingId');
}

export function deleteAliasMapping(aliasMappingId) {
  return remove(DATA_STORES.ALIAS_MAPPINGS, aliasMappingId);
}

export function saveEstimate(estimate) {
  return put(DATA_STORES.ESTIMATES, estimate, 'estimateId');
}

export async function commitEstimateBundle({ upserts = [], deletes = [], expectedPreimages = [] } = {}) {
  const records = upserts.filter(record => record?.estimateId);
  const ids = [...new Set(deletes.filter(Boolean))];
  if (!records.length && !ids.length) return { upserts: [], deletes: [] };
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.ESTIMATES] ||= {};
    assertEstimatePreimages(value[DATA_STORES.ESTIMATES], expectedPreimages);
    records.forEach(record => { value[DATA_STORES.ESTIMATES][record.estimateId] = record; });
    ids.forEach(estimateId => { delete value[DATA_STORES.ESTIMATES][estimateId]; });
    writeFallback(value);
    return { upserts: records, deletes: ids };
  }
  const transaction = db.transaction(DATA_STORES.ESTIMATES, 'readwrite');
  const store = transaction.objectStore(DATA_STORES.ESTIMATES);
  const completed = transactionDone(transaction);
  try {
    const currentRecords = {};
    const current = await Promise.all(expectedPreimages.map(expected => requestResult(store.get(expected.estimateId))));
    expectedPreimages.forEach((expected, index) => { currentRecords[expected.estimateId] = current[index] || null; });
    assertEstimatePreimages(currentRecords, expectedPreimages);
    records.forEach(record => store.put(record));
    ids.forEach(estimateId => store.delete(estimateId));
    await completed;
    return { upserts: records, deletes: ids };
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await completed.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export async function saveEstimateBundle(estimates = []) {
  const records = estimates.filter(record => record?.estimateId);
  await commitEstimateBundle({ upserts: records });
  return records;
}

export function deleteEstimate(estimateId) {
  return remove(DATA_STORES.ESTIMATES, estimateId);
}

export async function deleteEstimateBundle(estimateIds = []) {
  const ids = [...new Set(estimateIds.filter(Boolean))];
  await commitEstimateBundle({ deletes: ids });
  return ids;
}

export function saveSourceImage(sourceImage) {
  return put(DATA_STORES.SOURCE_IMAGES, sourceImage, 'documentId');
}

export function deleteSourceImage(documentId) {
  return remove(DATA_STORES.SOURCE_IMAGES, documentId);
}

export function saveLatestAutosave(draft) {
  const updatedAt = new Date().toISOString();
  return put(DATA_STORES.AUTOSAVE, {
    key: 'current',
    schemaVersion: 'ONEAPP_SMART_INPUT_AUTOSAVE_V1',
    updatedAt,
    draft: JSON.parse(JSON.stringify(draft))
  }, 'key');
}

export function loadLatestAutosave() {
  return get(DATA_STORES.AUTOSAVE, 'current');
}
