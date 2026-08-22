import {
  STORE,
  getAll,
  getByKey,
  newId,
  normalizeText,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.16.0';
import { getCloudUrl } from './orderq-cloud-adapter.js?v=0.11.0';
import { pullRemote, pushPending } from './orderq-sync-engine.js?v=0.18.0';
import { createCustomerMasterSyncCoordinator } from './customer-master-sync.js?v=0.1.0';
import { createSyncIdentity } from './sync-identity.js?v=0.1.0';

export const CUSTOMER_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE', DELETED: 'DELETED' });
export const CUSTOMER_QUALITY = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  DUPLICATE_CANDIDATE: 'DUPLICATE_CANDIDATE',
  SUPERSEDED: 'SUPERSEDED'
});

export const CUSTOMER_IMPORT_STATUS = Object.freeze({
  SAME: 'SAME',
  CHANGED: 'CHANGED',
  NEW: 'NEW',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  EXCLUDED: 'EXCLUDED'
});

export const CUSTOMER_FIELDS = Object.freeze([
  'customerCode', 'customerName', 'representativeName', 'businessNumber', 'businessType',
  'businessItem', 'phone', 'fax', 'mobile', 'email', 'postalCode', 'address',
  'addressDetail', 'contactName', 'contactPhone',
  'group1Code', 'group1Name', 'group2Code', 'group2Name', 'priceGroup',
  'paymentDay', 'bankAccountText', 'memo', 'searchText', 'groupName',
  ...Array.from({ length: 10 }, (_, index) => `userText${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, index) => `userNumber${String(index + 1).padStart(2, '0')}`)
]);

const EXCEL_FIELD_MAP = Object.freeze({
  '담당자명': 'contactName',
  '거래처그룹1코드': 'group1Code',
  '그룹1': 'group1Name',
  '거래처그룹2코드': 'group2Code',
  '거래처그룹2명': 'group2Name',
  '거래처코드': 'customerCode',
  '거래처명': 'customerName',
  '적요': 'memo',
  '결제일': 'paymentDay',
  '계좌': 'bankAccountText',
  '단가그룹': 'priceGroup',
  '핸드폰번호': 'mobile',
  '대표자명': 'representativeName',
  '주소1': 'address',
  '검색창내용': 'searchText',
  'Email': 'email',
  '대표자': 'representativeName',
  '사업자번호': 'businessNumber',
  '업태': 'businessType',
  '종목': 'businessItem',
  '전화': 'phone',
  '팩스': 'fax',
  '핸드폰': 'mobile',
  '이메일': 'email',
  '우편번호': 'postalCode',
  '주소': 'address',
  '상세주소': 'addressDetail',
  '담당자': 'contactName',
  '담당자연락처': 'contactPhone',
  '그룹': 'group1Name'
});

function clean(value) {
  return String(value ?? '').trim();
}

function looseName(value) {
  return normalizeText(value)
    .replace(/주식회사|유한회사|㈜|\(주\)|\s|[()\-_.]/g, '');
}

function customerCodeOf(customer) {
  return clean(customer?.customerCode || customer?.erpCustomerCode);
}

function queueItem(entityType, entityId, payload, timestamp = nowIso()) {
  const revision = Math.max(1, Number(payload?.revision || 1));
  const identity = createSyncIdentity({ entityType, entityId, operation: 'UPSERT', revision, payload }, newId);
  return {
    queueId: newId('SQ'),
    entityType,
    entityId,
    action: 'UPSERT',
    operation: 'UPSERT',
    revision,
    baseRevision: Math.max(0, revision - 1),
    ...identity,
    payload,
    status: 'PENDING',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function customerEvent(customerId, eventType, payload, actorId = 'administrator', timestamp = nowIso()) {
  return {
    eventId: newId('CE'),
    customerId,
    eventType,
    actorId,
    occurredAt: timestamp,
    payload
  };
}

function aliasRow(customerId, alias, source = 'CUSTOMER_NAME', timestamp = nowIso()) {
  const normalizedAlias = normalizeText(alias);
  return {
    mappingId: newId('CA'),
    customerId,
    alias: clean(alias),
    rawText: clean(alias),
    normalizedAlias,
    normalizedText: normalizedAlias,
    source,
    sourceType: source,
    sourceId: '',
    confirmed: true,
    useCount: 1,
    lastUsedAt: timestamp,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function normalizeCustomer(input = {}, previous = null) {
  const timestamp = nowIso();
  const customerId = clean(input.customerId || previous?.customerId || newId('CU'));
  const qualityStatus = clean(input.qualityStatus || previous?.qualityStatus || CUSTOMER_QUALITY.UNVERIFIED);
  const customerCode = clean(input.customerCode || input.erpCustomerCode || previous?.customerCode || previous?.erpCustomerCode);
  const customerName = clean(input.customerName || previous?.customerName);
  const status = clean(input.status || previous?.status || CUSTOMER_STATUS.ACTIVE);
  const canonicalCustomerId = qualityStatus === CUSTOMER_QUALITY.SUPERSEDED
    ? clean(input.canonicalCustomerId || input.supersededByCustomerId || previous?.canonicalCustomerId || previous?.supersededByCustomerId)
    : customerId;
  const normalized = {
    ...(previous || {}),
    ...input,
    customerId,
    customerCode,
    erpCustomerCode: customerCode,
    customerName,
    normalizedName: normalizeText(customerName),
    looseNormalizedName: looseName(customerName),
    normalizedCustomerCode: normalizeText(customerCode),
    status,
    qualityStatus,
    canonicalCustomerId,
    revision: Math.max(1, Number(input.revision || previous?.revision || 1)),
    createdAt: previous?.createdAt || input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp
  };
  CUSTOMER_FIELDS.forEach(field => {
    if (field === 'customerCode' || field === 'customerName') return;
    if (/^userNumber\d{2}$/.test(field)) {
      const value = input[field] ?? previous?.[field];
      normalized[field] = value === '' || value == null ? '' : Number(value);
      return;
    }
    normalized[field] = clean(input[field] ?? previous?.[field]);
  });
  normalized.group1Name = clean(input.group1Name ?? input.groupName ?? previous?.group1Name ?? previous?.groupName);
  normalized.groupName = normalized.group1Name;
  if (qualityStatus === CUSTOMER_QUALITY.SUPERSEDED && (!canonicalCustomerId || canonicalCustomerId === customerId)) {
    throw new Error('SUPERSEDED 거래처는 자신과 다른 대표 거래처가 필요합니다.');
  }
  return normalized;
}

function canonicalMap(customers) {
  return new Map(customers.map(customer => [customer.customerId, customer]));
}

export function resolveCanonicalCustomer(customer, customers) {
  if (!customer) return null;
  const byId = customers instanceof Map ? customers : canonicalMap(customers || []);
  let current = customer;
  const visited = new Set();
  while (current?.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) {
    if (visited.has(current.customerId)) throw new Error('거래처 대표 연결에 순환 참조가 있습니다.');
    visited.add(current.customerId);
    current = byId.get(current.canonicalCustomerId || current.supersededByCustomerId);
  }
  return current || null;
}

export async function listCustomers({ includeInactive = true, includeSuperseded = false } = {}) {
  const rows = (await getAll(STORE.CUSTOMERS)).map(row => normalizeCustomer(row, row));
  return rows
    .filter(row => includeInactive || row.status === CUSTOMER_STATUS.ACTIVE)
    .filter(row => includeSuperseded || row.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED)
    .sort((a, b) => a.customerName.localeCompare(b.customerName, 'ko'));
}

function scoreCustomer(customer, aliases, normalizedQuery, looseQuery, sourceLinks = []) {
  const code = customer.normalizedCustomerCode || normalizeText(customerCodeOf(customer));
  const name = customer.normalizedName || normalizeText(customer.customerName);
  const loose = customer.looseNormalizedName || looseName(customer.customerName);
  const aliasExact = aliases.some(alias => alias.customerId === customer.customerId && (alias.normalizedAlias || alias.normalizedText) === normalizedQuery && alias.active !== false);
  const sourceValues = sourceLinks.flatMap(link => [
    link.sourceCustomerCode,
    link.sourceCustomerName,
    link.sourceNickname,
    link.sourceSearchText
  ]).map(normalizeText).filter(Boolean);
  const fieldValues = CUSTOMER_FIELDS
    .filter(field => !['customerCode', 'customerName', 'groupName'].includes(field))
    .map(field => normalizeText(customer[field]))
    .filter(Boolean);
  if (code && code === normalizedQuery) return { score: 1000, matchMethod: 'CODE_EXACT' };
  if (sourceValues.includes(normalizedQuery)) return { score: 975, matchMethod: 'SOURCE_EXACT' };
  if (name === normalizedQuery) return { score: 950, matchMethod: 'NAME_EXACT' };
  if (aliasExact) return { score: 925, matchMethod: 'ALIAS_EXACT' };
  if (fieldValues.includes(normalizedQuery)) return { score: 900, matchMethod: 'FIELD_EXACT' };
  if (loose && loose === looseQuery) return { score: 875, matchMethod: 'LOOSE_EXACT' };
  if (name.includes(normalizedQuery) || normalizedQuery.includes(name)) return { score: 700, matchMethod: 'NAME_PARTIAL' };
  const aliasPartial = aliases.some(alias => {
    const normalizedAlias = alias.normalizedAlias || alias.normalizedText || '';
    return alias.customerId === customer.customerId
      && alias.active !== false
      && normalizedAlias
      && (normalizedAlias.includes(normalizedQuery) || normalizedQuery.includes(normalizedAlias));
  });
  if (aliasPartial) return { score: 650, matchMethod: 'ALIAS_PARTIAL' };
  if (sourceValues.some(value => value.includes(normalizedQuery) || normalizedQuery.includes(value))) return { score: 625, matchMethod: 'SOURCE_PARTIAL' };
  if (fieldValues.some(value => value.includes(normalizedQuery) || normalizedQuery.includes(value))) return { score: 600, matchMethod: 'FIELD_PARTIAL' };
  return { score: 0, matchMethod: '' };
}

export async function searchCustomers(query, { limit = 20, includeInactive = true } = {}) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];
  const [customers, aliases, sourceLinks] = await Promise.all([
    getAll(STORE.CUSTOMERS),
    getAll(STORE.CUSTOMER_ALIASES),
    getAll(STORE.CUSTOMER_SOURCE_LINKS)
  ]);
  const byId = canonicalMap(customers);
  const ranked = customers
    .map(customer => ({
      customer,
      ...scoreCustomer(
        customer,
        aliases,
        normalizedQuery,
        looseName(query),
        sourceLinks.filter(link => link.customerId === customer.customerId)
      )
    }))
    .filter(item => item.score > 0)
    .map(item => {
      const canonical = resolveCanonicalCustomer(item.customer, byId);
      return {
        ...item,
        originalCustomer: item.customer,
        customer: canonical || item.customer,
        redirected: Boolean(canonical && canonical.customerId !== item.customer.customerId)
      };
    })
    .filter(item => includeInactive || item.customer.status === CUSTOMER_STATUS.ACTIVE);
  const deduped = new Map();
  ranked.forEach(item => {
    const current = deduped.get(item.customer.customerId);
    if (!current || item.score > current.score) deduped.set(item.customer.customerId, item);
  });
  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.customer.customerName.localeCompare(b.customer.customerName, 'ko'))
    .slice(0, limit);
}

export async function resolveCustomerInput({ customerId = '', customerCode = '', customerName = '', senderRaw = '' } = {}) {
  const customers = await getAll(STORE.CUSTOMERS);
  const byId = canonicalMap(customers);
  if (customerId) {
    const original = byId.get(customerId);
    const customer = resolveCanonicalCustomer(original, byId);
    if (!customer) return { status: 'NOT_FOUND', customer: null, candidates: [] };
    if (customer.status !== CUSTOMER_STATUS.ACTIVE) return { status: 'INACTIVE', customer, candidates: [{ customer, score: 1000 }] };
    return { status: 'MATCHED', customer, candidates: [{ customer, score: 1000 }], matchMethod: original?.customerId === customer.customerId ? 'ID' : 'CANONICAL_REDIRECT' };
  }
  const query = clean(customerCode || customerName || senderRaw);
  const candidates = await searchCustomers(query, { includeInactive: true });
  const exact = candidates.filter(item => item.score >= 875);
  if (exact.length === 1) {
    const candidate = exact[0];
    const customer = candidate.customer;
    if (customer.status !== CUSTOMER_STATUS.ACTIVE) return { status: 'INACTIVE', customer, candidates };
    if (customer.qualityStatus === CUSTOMER_QUALITY.DUPLICATE_CANDIDATE) return { status: 'AMBIGUOUS', customer: null, candidates };
    if ([CUSTOMER_QUALITY.VERIFIED, CUSTOMER_QUALITY.UNVERIFIED].includes(customer.qualityStatus)) {
      return { status: 'MATCHED', customer, candidates, matchMethod: candidate.redirected ? 'CANONICAL_REDIRECT' : candidate.matchMethod };
    }
  }
  return { status: candidates.length ? 'AMBIGUOUS' : 'NOT_FOUND', customer: null, candidates };
}

async function writeCustomerMutation({ customer, aliases = [], event, expectedRevision = null }) {
  const db = await openOrderQDb();
  const stores = [STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.CUSTOMER_EVENTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(stores, 'readwrite');
  const customerStore = tx.objectStore(STORE.CUSTOMERS);
  const existing = await requestToPromise(customerStore.get(customer.customerId));
  if (expectedRevision !== null && Number(existing?.revision || 0) !== Number(expectedRevision)) {
    tx.abort();
    throw new Error('REVISION_CONFLICT');
  }
  customerStore.put(customer);
  aliases.forEach(alias => {
    tx.objectStore(STORE.CUSTOMER_ALIASES).put(alias);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_ALIAS', alias.mappingId, alias, event.occurredAt));
  });
  tx.objectStore(STORE.CUSTOMER_EVENTS).put(event);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER', customer.customerId, customer, event.occurredAt));
  await transactionDone(tx);
  return customer;
}

export async function createLiveCustomer(input, { source = 'LIVE_CREATE', actorId = 'administrator', allowDuplicate = false } = {}) {
  const customerName = clean(input?.customerName);
  if (!customerName) throw new Error('거래처명은 필수입니다.');
  const resolution = await resolveCustomerInput({ customerCode: input.customerCode, customerName });
  if (!allowDuplicate && resolution.status !== 'NOT_FOUND') {
    const error = new Error('CUSTOMER_DUPLICATE_CANDIDATE');
    error.code = 'CUSTOMER_DUPLICATE_CANDIDATE';
    error.candidates = resolution.candidates;
    throw error;
  }
  const timestamp = nowIso();
  const customer = normalizeCustomer({
    ...input,
    customerId: input.customerId || newId('CU'),
    status: CUSTOMER_STATUS.ACTIVE,
    qualityStatus: resolution.candidates.length ? CUSTOMER_QUALITY.DUPLICATE_CANDIDATE : (input.qualityStatus || CUSTOMER_QUALITY.UNVERIFIED),
    source,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const event = customerEvent(customer.customerId, 'CREATED', { source, customer }, actorId, timestamp);
  const aliasValues = [...new Set([
    customer.customerName,
    customer.searchText,
    ...clean(customer.searchText).split(/[\s,;/|]+/)
  ].map(clean).filter(Boolean))];
  return writeCustomerMutation({
    customer,
    aliases: aliasValues.map(value => aliasRow(customer.customerId, value, source, timestamp)),
    event
  });
}

export async function updateCustomer(customerId, patch, { expectedRevision, actorId = 'administrator', source = 'MASTER_EDIT' } = {}) {
  const previous = await getByKey(STORE.CUSTOMERS, customerId);
  if (!previous) throw new Error('거래처를 찾을 수 없습니다.');
  if (previous.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) throw new Error('대표 거래처에서 수정해 주세요.');
  const revision = Number(previous.revision || 1) + 1;
  const customer = normalizeCustomer({ ...patch, customerId, revision, updatedAt: nowIso() }, previous);
  const aliases = previous.customerName !== customer.customerName
    ? [aliasRow(customerId, previous.customerName, 'PREVIOUS_NAME')]
    : [];
  const event = customerEvent(customerId, 'UPDATED', { source, before: previous, after: customer }, actorId);
  return writeCustomerMutation({ customer, aliases, event, expectedRevision: expectedRevision ?? previous.revision ?? 1 });
}

export async function retireCustomer(customerId, { expectedRevision, actorId = 'administrator', reason = '' } = {}) {
  const [previous, orders] = await Promise.all([
    getByKey(STORE.CUSTOMERS, customerId),
    getAll(STORE.ORDERS)
  ]);
  if (!previous) throw new Error('거래처를 찾을 수 없습니다.');
  if (previous.status === CUSTOMER_STATUS.DELETED) return { customer: previous, affectedOrderCount: 0, alreadyDeleted: true };
  if (expectedRevision !== undefined && Number(previous.revision || 0) !== Number(expectedRevision)) {
    throw new Error('거래처가 다른 화면에서 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
  }
  const timestamp = nowIso();
  const customer = normalizeCustomer({
    customerId,
    status: CUSTOMER_STATUS.DELETED,
    revision: Number(previous.revision || 1) + 1,
    deletedAt: timestamp,
    deletedBy: actorId,
    deleteReason: clean(reason),
    updatedAt: timestamp
  }, previous);
  const db = await openOrderQDb();
  const stores = [STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.CUSTOMER_SOURCE_LINKS, STORE.CUSTOMER_EVENTS, STORE.SYNC_QUEUE];
  const tx = db.transaction(stores, 'readwrite');
  const aliasStore = tx.objectStore(STORE.CUSTOMER_ALIASES);
  const sourceLinkStore = tx.objectStore(STORE.CUSTOMER_SOURCE_LINKS);
  const queueStore = tx.objectStore(STORE.SYNC_QUEUE);
  const [aliases, sourceLinks] = await Promise.all([
    requestToPromise(aliasStore.getAll()),
    requestToPromise(sourceLinkStore.getAll())
  ]);
  tx.objectStore(STORE.CUSTOMERS).put(customer);
  aliases.filter(row => row.customerId === customerId && row.active !== false).forEach(row => {
    const updated = { ...row, active: false, revision: Number(row.revision || 1) + 1, updatedAt: timestamp };
    aliasStore.put(updated);
    queueStore.put(queueItem('CUSTOMER_ALIAS', updated.mappingId, updated, timestamp));
  });
  sourceLinks.filter(row => row.customerId === customerId && row.active !== false).forEach(row => {
    const updated = { ...row, active: false, linkStatus: 'DELETED', revision: Number(row.revision || 1) + 1, updatedAt: timestamp };
    sourceLinkStore.put(updated);
    queueStore.put(queueItem('CUSTOMER_SOURCE_LINK', updated.linkId, updated, timestamp));
  });
  const event = customerEvent(customerId, 'DELETED', {
    reason: clean(reason),
    affectedOrderCount: orders.filter(order => order.customerId === customerId).length,
    before: previous,
    after: customer
  }, actorId, timestamp);
  tx.objectStore(STORE.CUSTOMER_EVENTS).put(event);
  queueStore.put(queueItem('CUSTOMER', customerId, customer, timestamp));
  await transactionDone(tx);
  return { customer, event, affectedOrderCount: event.payload.affectedOrderCount, alreadyDeleted: false };
}

export async function mergeCustomers(canonicalCustomerId, supersededCustomerIds, { actorId = 'administrator', reason = '' } = {}) {
  const ids = [...new Set((supersededCustomerIds || []).filter(id => id && id !== canonicalCustomerId))];
  if (!ids.length) throw new Error('통합할 거래처가 없습니다.');
  const all = await getAll(STORE.CUSTOMERS);
  const byId = canonicalMap(all);
  const canonical = resolveCanonicalCustomer(byId.get(canonicalCustomerId), byId);
  if (!canonical || canonical.status !== CUSTOMER_STATUS.ACTIVE || canonical.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) {
    throw new Error('대표 거래처는 ACTIVE 비통합 거래처여야 합니다.');
  }
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.CUSTOMERS, STORE.CUSTOMER_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  for (const id of ids) {
    const source = byId.get(id);
    if (!source) throw new Error(`통합 대상 거래처를 찾을 수 없습니다: ${id}`);
    const updated = normalizeCustomer({
      ...source,
      qualityStatus: CUSTOMER_QUALITY.SUPERSEDED,
      canonicalCustomerId: canonical.customerId,
      supersededByCustomerId: canonical.customerId,
      supersededAt: timestamp,
      revision: Number(source.revision || 1) + 1,
      updatedAt: timestamp
    }, source);
    const event = customerEvent(id, 'MERGED', { canonicalCustomerId: canonical.customerId, reason, before: source, after: updated }, actorId, timestamp);
    tx.objectStore(STORE.CUSTOMERS).put(updated);
    tx.objectStore(STORE.CUSTOMER_EVENTS).put(event);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER', id, updated, timestamp));
  }
  await transactionDone(tx);
  return { canonicalCustomer: canonical, supersededCustomerIds: ids };
}

export async function unmergeCustomer(customerId, { actorId = 'administrator', qualityStatus = CUSTOMER_QUALITY.UNVERIFIED } = {}) {
  const previous = await getByKey(STORE.CUSTOMERS, customerId);
  if (!previous || previous.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED) throw new Error('통합된 거래처가 아닙니다.');
  const customer = normalizeCustomer({
    ...previous,
    qualityStatus,
    canonicalCustomerId: customerId,
    supersededByCustomerId: '',
    supersededAt: '',
    revision: Number(previous.revision || 1) + 1,
    updatedAt: nowIso()
  }, previous);
  const event = customerEvent(customerId, 'UNMERGED', { before: previous, after: customer }, actorId);
  return writeCustomerMutation({ customer, event, expectedRevision: previous.revision || 1 });
}

export async function getCustomerFamilyIds(customerId) {
  const customers = await getAll(STORE.CUSTOMERS);
  const byId = canonicalMap(customers);
  const canonical = resolveCanonicalCustomer(byId.get(customerId), byId);
  if (!canonical) return [];
  return customers
    .filter(customer => resolveCanonicalCustomer(customer, byId)?.customerId === canonical.customerId)
    .map(customer => customer.customerId);
}

export async function getUnifiedCustomerLedger(customerId) {
  const familyIds = new Set(await getCustomerFamilyIds(customerId));
  const [salesDocuments, ledgerDocuments, historicalOrders] = await Promise.all([
    getAll(STORE.SALES_DOCUMENTS),
    getAll(STORE.LEDGER_DOCUMENTS),
    getAll(STORE.HISTORICAL_ORDER_GROUPS)
  ]);
  return {
    customerIds: [...familyIds],
    salesDocuments: salesDocuments.filter(row => familyIds.has(row.customerId)),
    ledgerDocuments: ledgerDocuments.filter(row => familyIds.has(row.customerId)),
    historicalOrders: historicalOrders.filter(row => familyIds.has(row.customerId))
  };
}

export async function ensureCustomerMasterReady({ onLoading = null } = {}) {
  const local = await getAll(STORE.CUSTOMERS);
  if (!local.length) {
    onLoading?.('거래처 정보를 불러오는 중...');
    await synchronizeCustomerMaster();
    return { source: 'CLOUD_REQUIRED', customers: await listCustomers() };
  }
  const syncPromise = synchronizeCustomerMaster();
  return { source: 'LOCAL_CACHE', customers: local.map(row => normalizeCustomer(row, row)), syncPromise };
}

const CUSTOMER_SYNC_ENTITY_TYPES = new Set([
  'CUSTOMER', 'CUSTOMER_ALIAS', 'CUSTOMER_SOURCE_LINK', 'CUSTOMER_SOURCE_LINK_EVENT',
  'CUSTOMER_HEADER_MAPPING', 'CUSTOMER_USER_FIELD_DEFINITION'
]);
const customerSyncCoordinator = createCustomerMasterSyncCoordinator({
  isConfigured: () => Boolean(getCloudUrl()),
  push: () => pushPending(),
  pull: () => pullRemote()
});

export async function getCustomerCloudSyncState() {
  const queue = await getAll(STORE.SYNC_QUEUE);
  const customerQueue = queue.filter(item => CUSTOMER_SYNC_ENTITY_TYPES.has(item.entityType) && item.localOnly !== true);
  return {
    configured: Boolean(getCloudUrl()),
    pending: customerQueue.filter(item => item.status === 'PENDING' && !item.lastError).length,
    retry: customerQueue.filter(item => item.status === 'RETRY' || (item.status === 'PENDING' && item.lastError)).length,
    conflicts: customerQueue.filter(item => item.status === 'CONFLICT').length
  };
}

export function synchronizeCustomerMaster({ onStatus = null } = {}) {
  return customerSyncCoordinator.synchronize({ onStatus });
}

export function mapCustomerExcelRow(row = {}) {
  return Object.entries(EXCEL_FIELD_MAP).reduce((mapped, [header, field]) => {
    mapped[field] = clean(row[header]);
    return mapped;
  }, {});
}

function changedFields(existing, incoming) {
  return CUSTOMER_FIELDS.filter(field => clean(incoming[field]) && clean(incoming[field]) !== clean(existing[field]));
}

export async function prepareCustomerImport(rows, { fileName = '', fileHash = '' } = {}) {
  if (fileHash) {
    const batches = await getAll(STORE.IMPORT_BATCHES);
    const reusableBatch = batches
      .filter(batch => batch.sourceType === 'CUSTOMER_EXCEL' && batch.fileHash === fileHash && ['PREPARED', 'PARTIAL'].includes(batch.status))
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
    if (reusableBatch) return { batch: reusableBatch, records: await getCustomerImportRecords(reusableBatch.importBatchId), resumed: true };
  }
  const [customers, aliases] = await Promise.all([getAll(STORE.CUSTOMERS), getAll(STORE.CUSTOMER_ALIASES)]);
  const timestamp = nowIso();
  const importBatchId = newId('CIB');
  const records = [];
  for (let index = 0; index < rows.length; index += 1) {
    const incoming = mapCustomerExcelRow(rows[index]);
    const code = normalizeText(incoming.customerCode);
    const name = normalizeText(incoming.customerName);
    const codeMatches = code ? customers.filter(customer => normalizeText(customerCodeOf(customer)) === code) : [];
    const nameMatches = name ? customers.filter(customer => normalizeText(customer.customerName) === name) : [];
    const aliasMatches = name ? aliases.filter(alias => alias.active !== false && (alias.normalizedAlias || alias.normalizedText) === name)
      .map(alias => customers.find(customer => customer.customerId === alias.customerId)).filter(Boolean) : [];
    const rawMatches = [...new Map([...codeMatches, ...nameMatches, ...aliasMatches].map(customer => [customer.customerId, customer])).values()];
    const matches = [...new Map(rawMatches.map(customer => {
      const canonical = customer.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED
        ? customers.find(candidate => candidate.customerId === customer.canonicalCustomerId) || customer
        : customer;
      return [canonical.customerId, canonical];
    })).values()];
    const selectableMatches = matches.filter(customer => customer.status === CUSTOMER_STATUS.ACTIVE && customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED);
    let status = CUSTOMER_IMPORT_STATUS.NEW;
    let selectedCustomerId = '';
    let differences = [];
    if (!incoming.customerName) status = CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED;
    else if (matches.length > 1 || (matches.length && selectableMatches.length !== 1)) status = CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED;
    else if (selectableMatches.length === 1) {
      selectedCustomerId = selectableMatches[0].customerId;
      differences = changedFields(selectableMatches[0], incoming);
      status = differences.length ? CUSTOMER_IMPORT_STATUS.CHANGED : CUSTOMER_IMPORT_STATUS.SAME;
    }
    records.push({
      sourceRecordId: newId('CISR'),
      importBatchId,
      sourceType: 'CUSTOMER_EXCEL',
      rowNo: index + 2,
      raw: rows[index],
      incoming,
      status,
      selectedCustomerId,
      candidateCustomerIds: matches.map(customer => customer.customerId),
      changedFields: differences,
      fieldDecisions: status === CUSTOMER_IMPORT_STATUS.CHANGED ? null : {},
      errorMessage: '',
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }
  const batch = {
    importBatchId,
    sourceType: 'CUSTOMER_EXCEL',
    fileName,
    fileHash,
    rowCount: records.length,
    status: 'PREPARED',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS], 'readwrite');
  tx.objectStore(STORE.IMPORT_BATCHES).put(batch);
  records.forEach(record => tx.objectStore(STORE.SOURCE_RECORDS).put(record));
  await transactionDone(tx);
  return { batch, records };
}

export async function setCustomerImportDecision(sourceRecordId, decision = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  const store = tx.objectStore(STORE.SOURCE_RECORDS);
  const record = await requestToPromise(store.get(sourceRecordId));
  if (!record) throw new Error('가져오기 행을 찾을 수 없습니다.');
  const updated = { ...record, ...decision, updatedAt: nowIso() };
  store.put(updated);
  await transactionDone(tx);
  return updated;
}

export async function getCustomerImportRecords(importBatchId) {
  const records = await getAll(STORE.SOURCE_RECORDS);
  return records.filter(record => record.importBatchId === importBatchId);
}

export async function getLatestCustomerImportWork() {
  const batches = await getAll(STORE.IMPORT_BATCHES);
  const batch = batches
    .filter(candidate => candidate.sourceType === 'CUSTOMER_EXCEL' && ['PREPARED', 'PARTIAL'].includes(candidate.status))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
  if (!batch) return null;
  return { batch, records: await getCustomerImportRecords(batch.importBatchId) };
}

export function canApplyCustomerImport(records) {
  return records.every(record => {
    const status = record.status === CUSTOMER_IMPORT_STATUS.FAILED ? record.retryStatus : record.status;
    if ([CUSTOMER_IMPORT_STATUS.SAME, CUSTOMER_IMPORT_STATUS.NEW, CUSTOMER_IMPORT_STATUS.EXCLUDED, CUSTOMER_IMPORT_STATUS.APPLIED].includes(status)) return true;
    if (status === CUSTOMER_IMPORT_STATUS.CHANGED) {
      const decisions = record.fieldDecisions || {};
      return Boolean(record.selectedCustomerId) && (record.changedFields || []).every(field => ['USE_FILE', 'KEEP_EXISTING'].includes(decisions[field]));
    }
    return false;
  });
}

export async function applyCustomerImport(importBatchId, { actorId = 'administrator' } = {}) {
  const records = await getCustomerImportRecords(importBatchId);
  if (!canApplyCustomerImport(records)) throw new Error('확인필요 행과 필드 변경 선택을 모두 완료해 주세요.');
  const results = [];
  for (const record of records) {
    const operationStatus = record.status === CUSTOMER_IMPORT_STATUS.FAILED ? record.retryStatus : record.status;
    if ([CUSTOMER_IMPORT_STATUS.SAME, CUSTOMER_IMPORT_STATUS.EXCLUDED, CUSTOMER_IMPORT_STATUS.APPLIED].includes(operationStatus)) {
      results.push({ sourceRecordId: record.sourceRecordId, status: record.status });
      continue;
    }
    try {
      let customer;
      if (operationStatus === CUSTOMER_IMPORT_STATUS.NEW) {
        customer = await createLiveCustomer(record.incoming, { source: 'IMPORT_APPLY', actorId, allowDuplicate: false });
      } else {
        const previous = await getByKey(STORE.CUSTOMERS, record.selectedCustomerId);
        const patch = { ...previous };
        Object.entries(record.fieldDecisions || {}).forEach(([field, choice]) => {
          if (choice === 'USE_FILE') patch[field] = record.incoming[field];
        });
        customer = await updateCustomer(previous.customerId, patch, { expectedRevision: previous.revision, actorId, source: 'IMPORT_APPLY' });
      }
      await setCustomerImportDecision(record.sourceRecordId, { status: CUSTOMER_IMPORT_STATUS.APPLIED, retryStatus: '', appliedCustomerId: customer.customerId, errorMessage: '' });
      results.push({ sourceRecordId: record.sourceRecordId, status: CUSTOMER_IMPORT_STATUS.APPLIED, customerId: customer.customerId });
    } catch (error) {
      await setCustomerImportDecision(record.sourceRecordId, { status: CUSTOMER_IMPORT_STATUS.FAILED, retryStatus: operationStatus, errorMessage: error.message });
      results.push({ sourceRecordId: record.sourceRecordId, status: CUSTOMER_IMPORT_STATUS.FAILED, retryStatus: operationStatus, error: error.message });
    }
  }
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.IMPORT_BATCHES, 'readwrite');
  const store = tx.objectStore(STORE.IMPORT_BATCHES);
  const batch = await requestToPromise(store.get(importBatchId));
  store.put({ ...batch, status: results.some(result => result.status === CUSTOMER_IMPORT_STATUS.FAILED) ? 'PARTIAL' : 'APPLIED', updatedAt: nowIso() });
  await transactionDone(tx);
  return results;
}
