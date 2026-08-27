import { normalizeEstimateOrder } from './estimate-order.js?v=0.1.0';
import {
  planEstimateCreate,
  planEstimateDelete,
  planEstimateRename,
  planEstimateReorder,
  planEstimateUpdate
} from './estimate-save-contract.js?v=0.1.1';
import {
  TEMPLATE_SESSION_MODES,
  TEMPLATE_STRUCTURE_COMMANDS,
  assertTemplateStructureCommand,
  createTemplateRecord,
  normalizeInputTemplate,
  normalizeTemplateName,
  planTemplateStructureUpdate
} from './input-template-core.js?v=1.0.0';

export const SMARTINPUT_DB_NAME = 'oneapp-smartinput';
export const SMARTINPUT_DB_VERSION = 4;
export const SMARTINPUT_FALLBACK_KEY = 'oneapp.smartinput.relationships.v1';

export const DATA_STORES = Object.freeze({
  SETTINGS: 'settings',
  LINK_GROUPS: 'customerLinkGroups',
  TEMPORARY_CUSTOMERS: 'temporaryCustomers',
  ALIAS_MAPPINGS: 'customerAliasMappings',
  ESTIMATES: 'estimates',
  SOURCE_IMAGES: 'sourceImages',
  INPUT_TEMPLATES: 'inputTemplates'
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

export function openSmartInputDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SMARTINPUT_DB_NAME, SMARTINPUT_DB_VERSION);
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
      if (!db.objectStoreNames.contains(DATA_STORES.INPUT_TEMPLATES)) {
        const store = db.createObjectStore(DATA_STORES.INPUT_TEMPLATES, { keyPath: 'templateId' });
        store.createIndex('byMode', 'mode', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        store.createIndex('byNormalizedName', 'normalizedName', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('스마트입력 저장소를 열지 못했습니다.'));
  });
}

function readFallback() {
  try {
    const value = JSON.parse(localStorage.getItem(SMARTINPUT_FALLBACK_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function writeFallback(value) {
  localStorage.setItem(SMARTINPUT_FALLBACK_KEY, JSON.stringify(value));
}

async function getAll(storeName) {
  const db = await openSmartInputDatabase();
  if (!db) return Object.values(readFallback()[storeName] || {});
  const transaction = db.transaction(storeName, 'readonly');
  const rows = await requestResult(transaction.objectStore(storeName).getAll());
  db.close();
  return rows;
}

async function put(storeName, record, keyField) {
  const db = await openSmartInputDatabase();
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
  const db = await openSmartInputDatabase();
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

function createTemplateId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `tpl:${uuid}`;
  return `tpl:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export async function loadSmartInputData() {
  const [settingsRows, linkGroups, temporaryCustomers, aliasMappings, estimates, sourceImages, inputTemplates] = await Promise.all([
    getAll(DATA_STORES.SETTINGS),
    getAll(DATA_STORES.LINK_GROUPS),
    getAll(DATA_STORES.TEMPORARY_CUSTOMERS),
    getAll(DATA_STORES.ALIAS_MAPPINGS),
    getAll(DATA_STORES.ESTIMATES),
    getAll(DATA_STORES.SOURCE_IMAGES),
    getAll(DATA_STORES.INPUT_TEMPLATES)
  ]);
  return {
    settings: settingsRows.find(row => row.key === 'app')?.value || null,
    linkGroups,
    temporaryCustomers,
    aliasMappings,
    estimates: normalizeEstimateOrder(estimates),
    sourceImages,
    inputTemplates: inputTemplates.map(normalizeInputTemplate)
  };
}

export function saveSettings(value) {
  return put(DATA_STORES.SETTINGS, { key: 'app', value, updatedAt: new Date().toISOString() }, 'key');
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

function estimateRecordMap(records = []) {
  return Object.fromEntries(records.map(record => [record.estimateId, record]));
}

async function mutateEstimatesAtomically(planner) {
  const db = await openSmartInputDatabase();
  if (!db) {
    const value = readFallback();
    const records = Object.values(value[DATA_STORES.ESTIMATES] || {});
    const result = planner(records);
    value[DATA_STORES.ESTIMATES] = estimateRecordMap(result.records);
    writeFallback(value);
    return result;
  }

  const transaction = db.transaction(DATA_STORES.ESTIMATES, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(DATA_STORES.ESTIMATES);
  try {
    const records = await requestResult(store.getAll());
    const result = planner(records);
    const recordsToWrite = Array.isArray(result.recordsToWrite)
      ? result.recordsToWrite
      : (result.record ? [result.record] : []);
    recordsToWrite.forEach(record => store.put(record));
    (result.deleteIds || []).forEach(estimateId => store.delete(estimateId));
    await done;
    db.close();
    return result;
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await done.catch(() => {});
    db.close();
    throw error;
  }
}

export function createEstimateAtomically(estimate, saveAttemptId) {
  return mutateEstimatesAtomically(records => planEstimateCreate(records, estimate, { saveAttemptId }));
}

export function updateEstimateAtomically(estimateId, expectedRevision, estimate, saveAttemptId) {
  return mutateEstimatesAtomically(records => planEstimateUpdate(records, estimateId, expectedRevision, estimate, { saveAttemptId }));
}

export function renameEstimateAtomically(estimateId, expectedRevision, catalogName, saveAttemptId, updatedAt) {
  return mutateEstimatesAtomically(records => planEstimateRename(records, estimateId, expectedRevision, catalogName, {
    saveAttemptId,
    updatedAt
  }));
}

export function reorderEstimatesAtomically(orderedEstimateIds) {
  return mutateEstimatesAtomically(records => planEstimateReorder(records, orderedEstimateIds));
}

export function deleteEstimateAtomically(estimateId) {
  return mutateEstimatesAtomically(records => planEstimateDelete(normalizeEstimateOrder(records), estimateId));
}

export function deleteEstimate(estimateId) {
  return remove(DATA_STORES.ESTIMATES, estimateId);
}

export function saveSourceImage(sourceImage) {
  return put(DATA_STORES.SOURCE_IMAGES, sourceImage, 'documentId');
}

export function deleteSourceImage(documentId) {
  return remove(DATA_STORES.SOURCE_IMAGES, documentId);
}

function templateRecordMap(records = []) {
  return Object.fromEntries(records.map(record => [record.templateId, record]));
}

async function mutateInputTemplatesAtomically(planner) {
  const db = await openSmartInputDatabase();
  if (!db) {
    const value = readFallback();
    const records = Object.values(value[DATA_STORES.INPUT_TEMPLATES] || {}).map(normalizeInputTemplate);
    const result = planner(records);
    if (!(result.recordsToWrite || []).length && !(result.deleteIds || []).length) return result;
    value[DATA_STORES.INPUT_TEMPLATES] = templateRecordMap(result.records);
    writeFallback(value);
    return result;
  }
  const transaction = db.transaction(DATA_STORES.INPUT_TEMPLATES, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(DATA_STORES.INPUT_TEMPLATES);
  try {
    const records = (await requestResult(store.getAll())).map(normalizeInputTemplate);
    const result = planner(records);
    (result.recordsToWrite || (result.record ? [result.record] : [])).forEach(record => store.put(record));
    (result.deleteIds || []).forEach(templateId => store.delete(templateId));
    await done;
    db.close();
    return result;
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await done.catch(() => {});
    db.close();
    throw error;
  }
}

function duplicateTemplateName(records, record, ignoredTemplateId = '') {
  return records.some(item => item.templateId !== ignoredTemplateId
    && item.mode === record.mode
    && item.status === 'ACTIVE'
    && item.normalizedName === record.normalizedName);
}

function templateStoreError(code, message, detail = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

export async function listInputTemplates(mode, { includeArchived = false, systemTemplates = [] } = {}) {
  const rows = (await getAll(DATA_STORES.INPUT_TEMPLATES)).map(normalizeInputTemplate)
    .filter(record => !mode || record.mode === mode)
    .filter(record => includeArchived || record.status === 'ACTIVE')
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.name.localeCompare(right.name, 'ko'));
  return [...(systemTemplates || []).map(normalizeInputTemplate).filter(record => !mode || record.mode === mode), ...rows];
}

export async function getInputTemplate(templateId) {
  const rows = await getAll(DATA_STORES.INPUT_TEMPLATES);
  const record = rows.find(item => item.templateId === templateId);
  return record ? normalizeInputTemplate(record) : null;
}

export function createInputTemplate(input, { sessionMode } = {}) {
  assertTemplateStructureCommand(sessionMode, TEMPLATE_STRUCTURE_COMMANDS.CREATE);
  const record = createTemplateRecord(input, {
    templateId: input?.templateId || createTemplateId(),
    sessionMode,
    now: input?.updatedAt || new Date().toISOString()
  });
  return mutateInputTemplatesAtomically(records => {
    if (duplicateTemplateName(records, record)) {
      throw templateStoreError('TEMPLATE_NAME_DUPLICATE', '같은 전표에 동일한 양식명이 있습니다.');
    }
    return { record, records: [...records, record], recordsToWrite: [record] };
  });
}

export function updateInputTemplateStructure(templateId, expectedRevision, nextStructure, { sessionMode } = {}) {
  assertTemplateStructureCommand(sessionMode, TEMPLATE_STRUCTURE_COMMANDS.UPDATE);
  return mutateInputTemplatesAtomically(records => {
    const current = records.find(record => record.templateId === templateId);
    if (!current) throw templateStoreError('TEMPLATE_NOT_FOUND', '양식을 찾지 못했습니다.');
    const result = planTemplateStructureUpdate(current, nextStructure, { expectedRevision, sessionMode });
    if (!result.changed) return { ...result, records, recordsToWrite: [] };
    const nextRecords = records.map(record => record.templateId === templateId ? result.record : record);
    return { ...result, records: nextRecords, recordsToWrite: [result.record] };
  });
}

export function archiveInputTemplate(templateId, expectedRevision, { sessionMode } = {}) {
  assertTemplateStructureCommand(sessionMode, TEMPLATE_STRUCTURE_COMMANDS.ARCHIVE);
  return mutateInputTemplatesAtomically(records => {
    const current = records.find(record => record.templateId === templateId);
    if (!current) throw templateStoreError('TEMPLATE_NOT_FOUND', '양식을 찾지 못했습니다.');
    if (current.system) throw templateStoreError('TEMPLATE_STRUCTURE_LOCKED', '시스템 양식은 보관할 수 없습니다.');
    if (Number(expectedRevision) !== current.revision) {
      throw templateStoreError('TEMPLATE_REVISION_CONFLICT', '양식 revision이 변경되었습니다.');
    }
    const record = normalizeInputTemplate({ ...current, status: 'ARCHIVED', updatedAt: new Date().toISOString() });
    return {
      record,
      records: records.map(item => item.templateId === templateId ? record : item),
      recordsToWrite: [record]
    };
  });
}

export function assertExistingTemplateStructureLocked(command = TEMPLATE_STRUCTURE_COMMANDS.UPDATE) {
  return assertTemplateStructureCommand(TEMPLATE_SESSION_MODES.FILL, command);
}

export { normalizeTemplateName };
