import {
  STORE,
  getAll,
  newId,
  normalizeText,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.21.0';
import {
  CUSTOMER_QUALITY,
  CUSTOMER_STATUS,
  normalizeCustomer
} from './customer-master.js?v=0.20.0';
import { createSyncIdentity } from './sync-identity.js?v=0.1.0';
import {
  notifyCustomerFoundationMutation,
  prepareCustomerFoundationEvent,
  prepareCustomerFoundationSnapshotMutation
} from './customer-foundation-backup.js?v=0.1.0';

export const CUSTOMER_UPSERT_SOURCE_TYPE = 'CUSTOMER_CODE_UPSERT';
export const CUSTOMER_UPSERT_MAPPING_VERSION = 'CUSTOMER_CODE_UPSERT_V1';

export const CUSTOMER_UPSERT_RESULT = Object.freeze({
  PENDING: 'PENDING',
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  UNCHANGED: 'UNCHANGED',
  FAILED: 'FAILED',
  EMPTY_ROW_EXCLUDED: 'EMPTY_ROW_EXCLUDED',
  SYSTEM_ROW_EXCLUDED: 'SYSTEM_ROW_EXCLUDED'
});

export const CUSTOMER_UPSERT_REASON = Object.freeze({
  FILE_READ_FAILED: 'FILE_READ_FAILED',
  FILE_ENCRYPTED: 'FILE_ENCRYPTED',
  UNSUPPORTED_FILE_FORMAT: 'UNSUPPORTED_FILE_FORMAT',
  FILE_TYPE_SUSPECTED: 'FILE_TYPE_SUSPECTED',
  CUSTOMER_CODE_COLUMN_NOT_FOUND: 'CUSTOMER_CODE_COLUMN_NOT_FOUND',
  NO_DATA_ROWS: 'NO_DATA_ROWS',
  EMPTY_ROW_EXCLUDED: 'EMPTY_ROW_EXCLUDED',
  SYSTEM_ROW_EXCLUDED: 'SYSTEM_ROW_EXCLUDED',
  CUSTOMER_CODE_MISSING: 'CUSTOMER_CODE_MISSING',
  DUPLICATE_CODE_IN_IMPORT: 'DUPLICATE_CODE_IN_IMPORT',
  DUPLICATE_CUSTOMER_CODE_IN_DB: 'DUPLICATE_CUSTOMER_CODE_IN_DB',
  SOURCE_LINK_CONFLICT: 'SOURCE_LINK_CONFLICT',
  UNMATCHED_COLUMN_EXCLUDED: 'UNMATCHED_COLUMN_EXCLUDED',
  NUMBER_FIELD_PARSE_FAILED: 'NUMBER_FIELD_PARSE_FAILED',
  INDEXEDDB_OPEN_FAILED: 'INDEXEDDB_OPEN_FAILED',
  INDEXEDDB_ROW_TRANSACTION_FAILED: 'INDEXEDDB_ROW_TRANSACTION_FAILED',
  CLOUD_SYNC_PENDING: 'CLOUD_SYNC_PENDING',
  CLOUD_SYNCED: 'CLOUD_SYNCED'
});

const STANDARD_HEADERS = Object.freeze({
  customerCode: ['거래처코드', '코드', '사업자번호 (거래처코드)', '사업자번호(거래처코드)'],
  customerName: ['거래처명', '이름(거래처명)'],
  contactName: ['담당자명', '담당자'],
  group1Code: ['거래처그룹1코드'],
  group1Name: ['그룹1', '거래처그룹1', '그룹'],
  group2Code: ['거래처그룹2코드'],
  group2Name: ['거래처그룹2명'],
  memo: ['적요', '메모', '비고'],
  paymentDay: ['결제일'],
  bankAccountText: ['계좌'],
  priceGroup: ['단가그룹', '가격그룹'],
  mobile: ['핸드폰번호', '휴대폰번호', '핸드폰', '휴대폰'],
  representativeName: ['대표자명', '대표자'],
  address: ['주소1', '기본주소', '주소'],
  phone: ['전화', '전화번호'],
  searchText: ['검색창내용', '검색어'],
  email: ['Email', '이메일', 'E-mail'],
  businessNumber: ['사업자번호'],
  businessType: ['업태'],
  businessItem: ['종목'],
  fax: ['Fax', 'FAX', '팩스'],
  postalCode: ['우편번호', '주소1 우편번호'],
  addressDetail: ['상세주소'],
  contactPhone: ['담당자연락처', '관리자연락처']
});

const SALES_SIGNATURES = ['품목코드', '품목명', '규격명', '수량', '단가', '공급가액'];

function clean(value) {
  return String(value ?? '').trim();
}

export function normalizeCustomerHeader(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko').replace(/[\s_.\-/()]+/g, '');
}

function sourceLinkKey(sourceSystem, code) {
  return `${clean(sourceSystem).toUpperCase()}::${normalizeText(code)}`;
}

function queueItem(entityType, entityId, payload, timestamp = nowIso(), customerImportId = '') {
  const revision = Math.max(1, Number(payload?.revision || 1));
  const identity = createSyncIdentity({ entityType, entityId, operation: 'UPSERT', revision, payload }, newId);
  return {
    queueId: newId('SQ'),
    entityType,
    entityId,
    operation: 'UPSERT',
    revision,
    baseRevision: Math.max(0, revision - 1),
    ...identity,
    payload,
    customerImportId: clean(customerImportId),
    status: 'BPLUS_REPLACED',
    localOnly: true,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function aliasRow(customerId, alias, source, sourceId, timestamp) {
  const normalized = normalizeText(alias);
  return {
    mappingId: newId('CA'),
    customerId,
    alias: clean(alias),
    rawText: clean(alias),
    normalizedAlias: normalized,
    normalizedText: normalized,
    source,
    sourceType: source,
    sourceId,
    confirmed: true,
    useCount: 1,
    lastUsedAt: timestamp,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function eventRow(customerId, eventType, payload, timestamp) {
  return {
    eventId: newId('CE'),
    customerId,
    eventType,
    actorId: 'administrator',
    occurredAt: timestamp,
    payload
  };
}

function sourceLinkEvent(link, eventType, beforeCustomerId, afterCustomerId, reason, timestamp) {
  return {
    eventId: newId('CSLE'),
    linkId: link.linkId,
    eventType,
    beforeCustomerId: clean(beforeCustomerId),
    afterCustomerId: clean(afterCustomerId),
    reason,
    actorId: 'administrator',
    occurredAt: timestamp
  };
}

function defaultDefinitions() {
  return [
    ...Array.from({ length: 10 }, (_, index) => ({
      fieldKey: `userText${String(index + 1).padStart(2, '0')}`,
      fieldType: 'TEXT',
      displayName: '',
      headerAliases: [],
      enabled: false,
      displayOrder: index + 1
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      fieldKey: `userNumber${String(index + 1).padStart(2, '0')}`,
      fieldType: 'NUMBER',
      displayName: '',
      headerAliases: [],
      enabled: false,
      displayOrder: index + 1
    }))
  ];
}

export async function ensureCustomerUserFieldDefinitions() {
  const existing = await getAll(STORE.CUSTOMER_USER_FIELD_DEFINITIONS);
  const byKey = new Set(existing.map(row => row.fieldKey));
  const missing = defaultDefinitions().filter(row => !byKey.has(row.fieldKey));
  if (!missing.length) return existing;
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.CUSTOMER_USER_FIELD_DEFINITIONS, STORE.META], 'readwrite');
  missing.forEach(row => tx.objectStore(STORE.CUSTOMER_USER_FIELD_DEFINITIONS).put({
    ...row,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  await prepareCustomerFoundationSnapshotMutation(tx, 'CUSTOMER_USER_FIELD_DEFINITION_SEEDED');
  await transactionDone(tx);
  notifyCustomerFoundationMutation();
  return [...existing, ...missing];
}

export async function listCustomerUserFieldDefinitions() {
  return (await ensureCustomerUserFieldDefinitions())
    .sort((a, b) => a.fieldType.localeCompare(b.fieldType) || Number(a.displayOrder) - Number(b.displayOrder));
}

export async function saveCustomerUserFieldDefinition(fieldKey, patch = {}) {
  await ensureCustomerUserFieldDefinitions();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.CUSTOMER_USER_FIELD_DEFINITIONS, STORE.SYNC_QUEUE, STORE.META], 'readwrite');
  const store = tx.objectStore(STORE.CUSTOMER_USER_FIELD_DEFINITIONS);
  const previous = await requestToPromise(store.get(fieldKey));
  if (!previous) throw new Error('사용자 정의 필드 슬롯을 찾을 수 없습니다.');
  const timestamp = nowIso();
  const definition = {
    ...previous,
    displayName: clean(patch.displayName ?? previous.displayName),
    headerAliases: [...new Set((patch.headerAliases ?? previous.headerAliases ?? []).map(clean).filter(Boolean))],
    enabled: patch.enabled === undefined ? previous.enabled === true : patch.enabled === true,
    displayOrder: Number(patch.displayOrder ?? previous.displayOrder),
    revision: Number(previous.revision || 1) + 1,
    updatedAt: timestamp
  };
  store.put(definition);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_USER_FIELD_DEFINITION', definition.fieldKey, definition, timestamp));
  await prepareCustomerFoundationSnapshotMutation(tx, 'CUSTOMER_USER_FIELD_DEFINITION_CHANGED');
  await transactionDone(tx);
  notifyCustomerFoundationMutation();
  return definition;
}

export async function listCustomerHeaderMappings() {
  return getAll(STORE.CUSTOMER_HEADER_MAPPINGS);
}

export async function saveCustomerHeaderMapping({ sourceSystem = 'ERP', header, targetFieldKey, targetType = 'TEXT' }) {
  const normalizedHeader = normalizeCustomerHeader(header);
  if (!normalizedHeader || !targetFieldKey) throw new Error('헤더와 대상 항목이 필요합니다.');
  const mappingId = `${clean(sourceSystem).toUpperCase()}::${normalizedHeader}`;
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.CUSTOMER_HEADER_MAPPINGS, STORE.SYNC_QUEUE, STORE.META], 'readwrite');
  const store = tx.objectStore(STORE.CUSTOMER_HEADER_MAPPINGS);
  const previous = await requestToPromise(store.get(mappingId));
  const timestamp = nowIso();
  const mapping = {
    ...(previous || {}),
    mappingId,
    sourceSystem: clean(sourceSystem).toUpperCase(),
    normalizedHeader,
    originalHeader: clean(header),
    targetFieldKey,
    targetType,
    aliases: [...new Set([...(previous?.aliases || []), clean(header)].filter(Boolean))],
    enabled: true,
    mappingVersion: CUSTOMER_UPSERT_MAPPING_VERSION,
    revision: Number(previous?.revision || 0) + 1,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp
  };
  store.put(mapping);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_HEADER_MAPPING', mapping.mappingId, mapping, timestamp));
  await prepareCustomerFoundationSnapshotMutation(tx, 'CUSTOMER_HEADER_MAPPING_CHANGED');
  await transactionDone(tx);
  notifyCustomerFoundationMutation();
  return mapping;
}

function standardLookup() {
  const lookup = new Map();
  Object.entries(STANDARD_HEADERS).forEach(([fieldKey, aliases]) => {
    aliases.forEach(alias => lookup.set(normalizeCustomerHeader(alias), { fieldKey, fieldType: 'TEXT', source: 'STANDARD' }));
  });
  return lookup;
}

export async function buildCustomerHeaderMapping(headers = [], sourceSystem = 'ERP') {
  const system = clean(sourceSystem).toUpperCase();
  const [saved, definitions] = await Promise.all([
    listCustomerHeaderMappings(),
    listCustomerUserFieldDefinitions()
  ]);
  const lookup = standardLookup();
  saved.filter(row => row.enabled !== false && row.sourceSystem === system).forEach(row => {
    lookup.set(row.normalizedHeader, {
      fieldKey: row.targetFieldKey,
      fieldType: row.targetType || 'TEXT',
      source: 'SAVED'
    });
  });
  definitions.filter(row => row.enabled && clean(row.displayName)).forEach(row => {
    [row.displayName, ...(row.headerAliases || [])].forEach(alias => lookup.set(normalizeCustomerHeader(alias), {
      fieldKey: row.fieldKey,
      fieldType: row.fieldType,
      source: 'USER'
    }));
  });

  const usedTargets = new Set();
  const matched = [];
  const unmatched = [];
  headers.forEach((header, index) => {
    const label = clean(header) || `열 ${index + 1}`;
    const normalizedHeader = normalizeCustomerHeader(header);
    const target = lookup.get(normalizedHeader);
    if (!target || usedTargets.has(target.fieldKey)) {
      unmatched.push({ index, header: label, normalizedHeader, reasonCode: CUSTOMER_UPSERT_REASON.UNMATCHED_COLUMN_EXCLUDED });
      return;
    }
    usedTargets.add(target.fieldKey);
    matched.push({ index, header: clean(header), normalizedHeader, targetFieldKey: target.fieldKey, targetType: target.fieldType, source: target.source });
  });
  return {
    sourceSystem: system,
    mappingVersion: CUSTOMER_UPSERT_MAPPING_VERSION,
    matched,
    unmatched,
    hasCustomerCode: matched.some(row => row.targetFieldKey === 'customerCode')
  };
}

export function detectCustomerFileType(headers = []) {
  const normalized = new Set(headers.map(normalizeCustomerHeader));
  const evidence = SALES_SIGNATURES.filter(header => normalized.has(normalizeCustomerHeader(header)));
  return {
    suspected: evidence.length >= 3,
    suspectedType: evidence.length >= 3 ? 'SALES' : 'CUSTOMER',
    evidence
  };
}

function mappedRow(rawRow, mapping) {
  const values = {};
  const fieldExclusions = [];
  mapping.matched.forEach(entry => {
    const rawValue = rawRow?.[entry.header];
    if (rawValue === undefined || rawValue === null || clean(rawValue) === '') return;
    if (entry.targetType === 'NUMBER') {
      const parsed = Number(String(rawValue).replace(/,/g, '').trim());
      if (!Number.isFinite(parsed)) {
        fieldExclusions.push({
          fieldKey: entry.targetFieldKey,
          header: entry.header,
          rawValue,
          reasonCode: CUSTOMER_UPSERT_REASON.NUMBER_FIELD_PARSE_FAILED,
          reasonMessage: `${entry.header} 값을 숫자로 변환할 수 없어 이 항목만 제외했습니다.`
        });
        return;
      }
      values[entry.targetFieldKey] = parsed;
      return;
    }
    values[entry.targetFieldKey] = String(rawValue);
  });
  return { values, fieldExclusions };
}

function isEmptyRawRow(rawRow) {
  return Object.values(rawRow || {}).every(value => clean(value) === '');
}

export function isCustomerSystemRow(rawRow) {
  const values = Object.values(rawRow || {}).map(clean).filter(Boolean);
  if (!values.length) return false;
  const joined = values.join(' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /^(합계|총계|소계|페이지|page\s*\d+|출력일시|조회기간)(\s|:|：|$)/i.test(joined)
    || /^[-=_]{3,}$/.test(joined);
}

function resultCounts(records) {
  return records.reduce((counts, record) => {
    counts[record.resultType] = (counts[record.resultType] || 0) + 1;
    counts.fieldExcluded += (record.fieldExclusions || []).length;
    return counts;
  }, { CREATED: 0, UPDATED: 0, UNCHANGED: 0, FAILED: 0, EMPTY_ROW_EXCLUDED: 0, SYSTEM_ROW_EXCLUDED: 0, fieldExcluded: 0 });
}

function maskedEvidence(rawRow) {
  return Object.fromEntries(Object.entries(rawRow || {}).map(([key, value]) => {
    const text = clean(value);
    return [key, text ? `${text.slice(0, 2)}***(${text.length})` : ''];
  }));
}

async function persistJob(job) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.IMPORT_BATCHES, 'readwrite');
  tx.objectStore(STORE.IMPORT_BATCHES).put(job);
  await transactionDone(tx);
}

async function recordsForJob(importId) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readonly');
  const rows = await requestToPromise(tx.objectStore(STORE.SOURCE_RECORDS).index('byBatchId').getAll(importId));
  await transactionDone(tx);
  return rows.sort((a, b) => Number(a.excelRowNumber) - Number(b.excelRowNumber));
}

async function seedRows(job, rawRows, headerRowNumber) {
  for (let start = 0; start < rawRows.length; start += 200) {
    const timestamp = nowIso();
    const db = await openOrderQDb();
    const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE.SOURCE_RECORDS);
    rawRows.slice(start, start + 200).forEach((rawRow, offset) => {
      const excelRowNumber = headerRowNumber + start + offset + 1;
      store.put({
        sourceRecordId: `${job.importId}:ROW:${excelRowNumber}`,
        importBatchId: job.importId,
        importId: job.importId,
        sourceType: CUSTOMER_UPSERT_SOURCE_TYPE,
        sourceSystem: job.sourceSystem,
        excelRowNumber,
        rowNo: excelRowNumber,
        rawRow,
        resultType: CUSTOMER_UPSERT_RESULT.PENDING,
        reasonCode: '',
        reasonMessage: '',
        createdAt: timestamp,
        updatedAt: timestamp
      });
    });
    await transactionDone(tx);
  }
}

async function saveRowFailure(record, reasonCode, reasonMessage, detail = {}) {
  const timestamp = nowIso();
  const updated = {
    ...record,
    ...detail,
    resultType: CUSTOMER_UPSERT_RESULT.FAILED,
    reasonCode,
    reasonMessage,
    rawEvidenceMasked: maskedEvidence(record.rawRow),
    rawRow: undefined,
    updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  tx.objectStore(STORE.SOURCE_RECORDS).put(updated);
  await transactionDone(tx);
  return updated;
}

async function saveEmptyRow(record) {
  const timestamp = nowIso();
  const updated = {
    ...record,
    resultType: CUSTOMER_UPSERT_RESULT.EMPTY_ROW_EXCLUDED,
    reasonCode: CUSTOMER_UPSERT_REASON.EMPTY_ROW_EXCLUDED,
    reasonMessage: '원본 행의 모든 셀이 비어 있어 등록 대상에서 제외했습니다.',
    updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  tx.objectStore(STORE.SOURCE_RECORDS).put(updated);
  await transactionDone(tx);
  return updated;
}

async function saveSystemRow(record) {
  const timestamp = nowIso();
  const updated = {
    ...record,
    rawEvidenceMasked: maskedEvidence(record.rawRow),
    rawRow: undefined,
    resultType: CUSTOMER_UPSERT_RESULT.SYSTEM_ROW_EXCLUDED,
    reasonCode: CUSTOMER_UPSERT_REASON.SYSTEM_ROW_EXCLUDED,
    reasonMessage: '합계·페이지·출력정보 등 시스템 행으로 판정하여 제외했습니다.',
    updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  tx.objectStore(STORE.SOURCE_RECORDS).put(updated);
  await transactionDone(tx);
  return updated;
}

async function canonicalCustomerInTx(store, customer) {
  let current = customer;
  const visited = new Set();
  while (current?.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) {
    if (visited.has(current.customerId)) throw new Error('거래처 대표 연결에 순환 참조가 있습니다.');
    visited.add(current.customerId);
    current = await requestToPromise(store.get(current.canonicalCustomerId || current.supersededByCustomerId));
  }
  return current || null;
}

async function addAlias(tx, customerId, value, sourceId, timestamp, sourceSystem = 'ERP', importId = '') {
  const alias = clean(value);
  const normalized = normalizeText(alias);
  if (!normalized) return;
  const store = tx.objectStore(STORE.CUSTOMER_ALIASES);
  const existing = await requestToPromise(store.index('byCustomerText').get([customerId, normalized]));
  if (existing) return;
  const row = aliasRow(customerId, alias, `${clean(sourceSystem).toUpperCase()}_IMPORT`, sourceId, timestamp);
  store.put(row);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_ALIAS', row.mappingId, row, timestamp, importId));
}

async function applyUpsertRow(record, mapping, duplicateRowsByCode) {
  if (isEmptyRawRow(record.rawRow)) return saveEmptyRow(record);
  if (isCustomerSystemRow(record.rawRow)) return saveSystemRow(record);
  const { values, fieldExclusions } = mappedRow(record.rawRow, mapping);
  const customerCode = clean(values.customerCode);
  const normalizedCode = normalizeText(customerCode);
  if (!customerCode) {
    return saveRowFailure(record, CUSTOMER_UPSERT_REASON.CUSTOMER_CODE_MISSING, '해당 행의 거래처코드 값이 비어 있어 등록·수정할 수 없습니다.', { matchedValues: values, fieldExclusions });
  }
  const duplicates = duplicateRowsByCode.get(normalizedCode) || [];
  if (duplicates.length > 1) {
    return saveRowFailure(
      record,
      CUSTOMER_UPSERT_REASON.DUPLICATE_CODE_IN_IMPORT,
      `같은 업로드의 ${duplicates.join(', ')}행에 거래처코드 ${customerCode}가 중복되어 해당 코드의 모든 행을 등록하지 않았습니다.`,
      { customerCode, normalizedCustomerCode: normalizedCode, matchedValues: values, duplicateExcelRows: duplicates, fieldExclusions }
    );
  }

  const timestamp = nowIso();
  const db = await openOrderQDb();
  const stores = [
    STORE.CUSTOMERS, STORE.CUSTOMER_ALIASES, STORE.CUSTOMER_EVENTS,
    STORE.CUSTOMER_SOURCE_LINKS, STORE.CUSTOMER_SOURCE_LINK_EVENTS,
    STORE.SOURCE_RECORDS, STORE.SYNC_QUEUE, STORE.FOUNDATION_BACKUP_OUTBOX, STORE.META
  ];
  const tx = db.transaction(stores, 'readwrite');
  try {
    const customerStore = tx.objectStore(STORE.CUSTOMERS);
    const linkStore = tx.objectStore(STORE.CUSTOMER_SOURCE_LINKS);
    const matches = await requestToPromise(customerStore.index('byCustomerCode').getAll(normalizedCode));
    const canonicalMatches = [];
    for (const match of matches) {
      const canonical = await canonicalCustomerInTx(customerStore, match);
      if (canonical && !canonicalMatches.some(row => row.customerId === canonical.customerId)) canonicalMatches.push(canonical);
    }
    if (canonicalMatches.length > 1) {
      tx.abort();
      return saveRowFailure(record, CUSTOMER_UPSERT_REASON.DUPLICATE_CUSTOMER_CODE_IN_DB, `거래처코드 ${customerCode}가 기존 Customer ${canonicalMatches.map(row => row.customerId).join(', ')}에 중복되어 있습니다.`, {
        customerCode, normalizedCustomerCode: normalizedCode, matchedValues: values, conflictingCustomerIds: canonicalMatches.map(row => row.customerId), fieldExclusions
      });
    }

    const sourceSystem = clean(record.sourceSystem || 'ERP').toUpperCase();
    const key = sourceLinkKey(sourceSystem, customerCode);
    const existingLink = await requestToPromise(linkStore.index('bySourceLinkKey').get(key));
    let customer = canonicalMatches[0] || null;
    if (existingLink) {
      const linked = await canonicalCustomerInTx(customerStore, await requestToPromise(customerStore.get(existingLink.customerId)));
      if (customer && linked && customer.customerId !== linked.customerId) {
        tx.abort();
        return saveRowFailure(record, CUSTOMER_UPSERT_REASON.SOURCE_LINK_CONFLICT, `${key} Source Link가 거래처코드 기준 Customer와 다른 Customer를 가리킵니다.`, {
          customerCode, normalizedCustomerCode: normalizedCode, matchedValues: values,
          sourceLinkKey: key, linkedCustomerId: linked.customerId, codeCustomerId: customer.customerId, fieldExclusions
        });
      }
      if (!customer && linked && normalizeText(linked.customerCode || linked.erpCustomerCode) === normalizedCode) customer = linked;
      else if (!customer && linked) {
        tx.abort();
        return saveRowFailure(record, CUSTOMER_UPSERT_REASON.SOURCE_LINK_CONFLICT, `${key} Source Link가 다른 거래처코드의 Customer ${linked.customerId}를 가리킵니다.`, {
          customerCode, normalizedCustomerCode: normalizedCode, matchedValues: values,
          sourceLinkKey: key, linkedCustomerId: linked.customerId, fieldExclusions
        });
      }
    }

    const previous = customer ? { ...customer } : null;
    const patch = { customerCode };
    Object.entries(values).forEach(([field, value]) => {
      if (field === 'customerCode') return;
      if (value === 0 || clean(value) !== '') patch[field] = value;
    });
    if (!customer) {
      customer = normalizeCustomer({
        ...patch,
        customerId: newId('CU'),
        status: CUSTOMER_STATUS.ACTIVE,
        qualityStatus: CUSTOMER_QUALITY.UNVERIFIED,
        source: `${sourceSystem}_CODE_UPSERT`,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    } else {
      customer = normalizeCustomer({
        ...patch,
        customerId: customer.customerId,
        revision: Number(customer.revision || 1) + 1,
        updatedAt: timestamp
      }, customer);
    }

    const changedFields = previous
      ? Object.keys(patch).filter(field => String(previous[field] ?? '') !== String(customer[field] ?? ''))
      : Object.keys(patch);
    const resultType = !previous
      ? CUSTOMER_UPSERT_RESULT.CREATED
      : changedFields.length
        ? CUSTOMER_UPSERT_RESULT.UPDATED
        : CUSTOMER_UPSERT_RESULT.UNCHANGED;

    if (resultType !== CUSTOMER_UPSERT_RESULT.UNCHANGED) {
      customerStore.put(customer);
      const event = eventRow(customer.customerId, resultType, {
        importId: record.importId,
        excelRowNumber: record.excelRowNumber,
        customerCode,
        before: previous,
        after: customer,
        changedFields
      }, timestamp);
      const foundationEvent = await prepareCustomerFoundationEvent(tx, event);
      tx.objectStore(STORE.CUSTOMER_EVENTS).put(foundationEvent);
      tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER', customer.customerId, customer, timestamp, record.importId));
      if (previous?.customerName && previous.customerName !== customer.customerName) await addAlias(tx, customer.customerId, previous.customerName, key, timestamp, sourceSystem, record.importId);
    }
    await addAlias(tx, customer.customerId, customer.customerName, key, timestamp, sourceSystem, record.importId);
    for (const alias of clean(customer.searchText).split(/[\s,;/|]+/).filter(Boolean)) await addAlias(tx, customer.customerId, alias, key, timestamp, sourceSystem, record.importId);

    const link = {
      ...(existingLink || {}),
      linkId: existingLink?.linkId || newId('CSL'),
      customerId: customer.customerId,
      sourceSystem,
      externalCode: customerCode,
      sourceCustomerCode: customerCode,
      normalizedSourceCustomerCode: normalizedCode,
      sourceLinkKey: key,
      sourceCustomerName: clean(values.customerName),
      sourceSnapshot: { importId: record.importId, excelRowNumber: record.excelRowNumber, mappingVersion: CUSTOMER_UPSERT_MAPPING_VERSION },
      matchMethod: 'CUSTOMER_CODE_EXACT',
      linkStatus: 'CONFIRMED',
      revision: Number(existingLink?.revision || 0) + 1,
      confirmedBy: existingLink?.confirmedBy || 'administrator',
      confirmedAt: existingLink?.confirmedAt || timestamp,
      createdAt: existingLink?.createdAt || timestamp,
      updatedAt: timestamp,
      active: true
    };
    linkStore.put(link);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_SOURCE_LINK', link.linkId, link, timestamp, record.importId));
    if (!existingLink || existingLink.customerId !== link.customerId) {
      const linkEvent = sourceLinkEvent(link, existingLink ? 'LINK_CHANGED' : 'LINK_CREATED', existingLink?.customerId || '', link.customerId, 'CUSTOMER_CODE_UPSERT', timestamp);
      tx.objectStore(STORE.CUSTOMER_SOURCE_LINK_EVENTS).put(linkEvent);
      tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_SOURCE_LINK_EVENT', linkEvent.eventId, linkEvent, timestamp, record.importId));
    }
    await prepareCustomerFoundationSnapshotMutation(tx, 'CUSTOMER_RELATED_DATA_CHANGED');

    const updatedRecord = {
      ...record,
      customerCode,
      normalizedCustomerCode: normalizedCode,
      matchedValues: values,
      unmatchedValues: Object.fromEntries(mapping.unmatched.map(row => [row.header, record.rawRow?.[row.header] ?? ''])),
      resultType,
      reasonCode: resultType,
      reasonMessage: resultType === CUSTOMER_UPSERT_RESULT.CREATED
        ? '거래처코드가 기존 Master에 없어 신규 등록했습니다.'
        : resultType === CUSTOMER_UPSERT_RESULT.UPDATED
          ? '거래처코드가 일치하는 기존 Customer에 비어 있지 않은 파일값을 반영했습니다.'
          : '거래처코드가 일치하며 변경할 값이 없어 기존 정보를 유지했습니다.',
      customerId: customer.customerId,
      sourceLinkId: link.linkId,
      changedFields,
      beforeValues: previous ? Object.fromEntries(changedFields.map(field => [field, previous[field] ?? ''])) : {},
      afterValues: Object.fromEntries(changedFields.map(field => [field, customer[field] ?? ''])),
      fieldExclusions,
      rawEvidenceMasked: maskedEvidence(record.rawRow),
      rawRow: undefined,
      updatedAt: timestamp
    };
    tx.objectStore(STORE.SOURCE_RECORDS).put(updatedRecord);
    await transactionDone(tx);
    notifyCustomerFoundationMutation();
    return updatedRecord;
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    if ([CUSTOMER_UPSERT_REASON.DUPLICATE_CUSTOMER_CODE_IN_DB, CUSTOMER_UPSERT_REASON.SOURCE_LINK_CONFLICT].includes(error?.code)) throw error;
    return saveRowFailure(record, CUSTOMER_UPSERT_REASON.INDEXEDDB_ROW_TRANSACTION_FAILED, `Excel ${record.excelRowNumber}행 저장 transaction이 실패했습니다: ${error?.message || error}`, {
      customerCode, normalizedCustomerCode: normalizedCode, matchedValues: values, fieldExclusions,
      storageError: String(error?.message || error)
    });
  }
}

async function processJob(job, records, mapping, onProgress) {
  const codeRows = new Map();
  records.forEach(record => {
    if (isEmptyRawRow(record.rawRow)) return;
    const codeEntry = mapping.matched.find(row => row.targetFieldKey === 'customerCode');
    const code = normalizeText(codeEntry ? record.rawRow?.[codeEntry.header] : '');
    if (!code) return;
    if (!codeRows.has(code)) codeRows.set(code, []);
    codeRows.get(code).push(record.excelRowNumber);
  });
  const results = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const result = record.resultType === CUSTOMER_UPSERT_RESULT.PENDING
      ? await applyUpsertRow(record, mapping, codeRows)
      : record;
    results.push(result);
    const processed = index + 1;
    if (processed % 200 === 0 || processed === records.length) {
      const checkpoint = {
        ...job,
        status: processed === records.length ? 'COMPLETED' : 'PROCESSING',
        processedCount: processed,
        lastCompletedRow: result.excelRowNumber,
        resultCounts: resultCounts(results),
        completedAt: processed === records.length ? nowIso() : '',
        updatedAt: nowIso()
      };
      await persistJob(checkpoint);
      job = checkpoint;
      onProgress?.({ processed, total: records.length, counts: checkpoint.resultCounts });
      if (processed < records.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.IMPORT_BATCHES, STORE.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE.IMPORT_BATCHES).put(job);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('IMPORT_BATCH', job.importId, job, timestamp, job.importId));
  await transactionDone(tx);
  return { job, records: results };
}

export async function runCustomerCodeUpsert({
  rawRows,
  headers,
  headerRowNumber = 1,
  fileName = '',
  fileHash = '',
  sourceSystem = 'ERP',
  onProgress = null
}) {
  const mapping = await buildCustomerHeaderMapping(headers, sourceSystem);
  if (!mapping.hasCustomerCode) {
    const error = new Error('거래처코드 열을 찾을 수 없어 등록·수정 0건으로 종료했습니다.');
    error.code = CUSTOMER_UPSERT_REASON.CUSTOMER_CODE_COLUMN_NOT_FOUND;
    error.detectedHeaders = headers;
    throw error;
  }
  if (!rawRows.length) {
    const error = new Error('등록할 데이터 행이 없습니다.');
    error.code = CUSTOMER_UPSERT_REASON.NO_DATA_ROWS;
    throw error;
  }
  try {
    await openOrderQDb();
  } catch (error) {
    const wrapped = new Error(`IndexedDB를 시작할 수 없습니다: ${error?.message || error}`);
    wrapped.code = CUSTOMER_UPSERT_REASON.INDEXEDDB_OPEN_FAILED;
    throw wrapped;
  }
  const timestamp = nowIso();
  const importId = newId('CIJ');
  const job = {
    importBatchId: importId,
    importId,
    sourceType: CUSTOMER_UPSERT_SOURCE_TYPE,
    sourceSystem: clean(sourceSystem).toUpperCase(),
    fileName,
    fileHash,
    mappingVersion: CUSTOMER_UPSERT_MAPPING_VERSION,
    detectedHeaders: [...headers],
    matchedHeaders: mapping.matched.map(row => ({ header: row.header, targetFieldKey: row.targetFieldKey, targetType: row.targetType })),
    unmatchedHeaders: mapping.unmatched,
    headerRowNumber,
    rowCount: rawRows.length,
    processedCount: 0,
    lastCompletedRow: headerRowNumber,
    status: 'PROCESSING',
    cloudStatus: CUSTOMER_UPSERT_REASON.CLOUD_SYNC_PENDING,
    resultCounts: resultCounts([]),
    startedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await persistJob(job);
  await seedRows(job, rawRows, headerRowNumber);
  return processJob(job, await recordsForJob(importId), mapping, onProgress);
}

export async function getLatestCustomerUpsertWork() {
  const jobs = (await getAll(STORE.IMPORT_BATCHES))
    .filter(row => row.sourceType === CUSTOMER_UPSERT_SOURCE_TYPE)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  if (!jobs.length) return null;
  return { job: jobs[0], records: await recordsForJob(jobs[0].importId || jobs[0].importBatchId) };
}

export async function resumeCustomerCodeUpsert(importId, onProgress = null) {
  const jobs = await getAll(STORE.IMPORT_BATCHES);
  const job = jobs.find(row => (row.importId || row.importBatchId) === importId);
  if (!job) throw new Error('재개할 거래처 업로드 작업을 찾을 수 없습니다.');
  const mapping = await buildCustomerHeaderMapping(job.detectedHeaders || [], job.sourceSystem);
  return processJob(job, await recordsForJob(importId), mapping, onProgress);
}

export function customerUpsertRetryDelay(retryCount = 0) {
  return Math.min(300000, 15000 * (2 ** Math.max(0, Number(retryCount || 0))));
}

function queueBelongsToCustomerImport(row, importId) {
  const id = clean(importId);
  if (!id || row?.localOnly === true) return false;
  return clean(row.customerImportId) === id
    || clean(row.payload?.importId) === id
    || clean(row.payload?.importBatchId) === id;
}

export function summarizeCustomerUpsertQueue(rows = [], importId = '') {
  const owned = rows.filter(row => queueBelongsToCustomerImport(row, importId));
  const acked = owned.filter(row => row.status === 'ACKED');
  const conflicts = owned.filter(row => row.status === 'CONFLICT');
  const pending = owned.filter(row => row.status !== 'ACKED' && row.status !== 'CONFLICT');
  const errors = owned.filter(row => clean(row.lastError));
  return {
    cloudStatus: owned.length > 0 && acked.length === owned.length
      ? CUSTOMER_UPSERT_REASON.CLOUD_SYNCED
      : CUSTOMER_UPSERT_REASON.CLOUD_SYNC_PENDING,
    total: owned.length,
    acked: acked.length,
    pending: pending.length,
    conflicts: conflicts.length,
    errors: errors.length,
    lastError: errors.map(row => clean(row.lastError)).filter(Boolean).join('\n')
  };
}

export function customerUpsertSourceLinkConflictPatch(row, importId, timestamp = nowIso()) {
  if (!queueBelongsToCustomerImport(row, importId)
    || row.status !== 'CONFLICT'
    || row.entityType !== 'CUSTOMER_SOURCE_LINK'
    || (row.remotePayload?.customerId && clean(row.remotePayload.customerId) !== clean(row.payload?.customerId))) return null;
  const serverRevision = Math.max(0, Number(row.serverRevision || 0));
  const payload = { ...row.payload, revision: serverRevision + 1, updatedAt: timestamp };
  const identity = createSyncIdentity({
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation || 'UPSERT',
    revision: serverRevision + 1,
    payload
  }, newId, { ...row, operationId: row.operationId || row.queueId, mutationId: row.mutationId || row.queueId });
  return {
    ...row,
    queueId: newId('SQ'),
    ...identity,
    revision: serverRevision + 1,
    baseRevision: serverRevision,
    payload,
    status: 'PENDING',
    lastError: `Cloud Source Link revision ${serverRevision}을 기준으로 관리자 업로드값을 자동 재시도합니다.`,
    updatedAt: timestamp
  };
}

async function requeueRevisionOnlySourceLinkConflicts(importId, rows) {
  const timestamp = nowIso();
  const patches = rows.map(row => customerUpsertSourceLinkConflictPatch(row, importId, timestamp)).filter(Boolean);
  if (!patches.length) return rows;
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SYNC_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE.SYNC_QUEUE);
  patches.forEach(row => {
    const previous = rows.find(candidate => candidate.mutationId === row.parentMutationId || candidate.queueId === row.parentMutationId);
    if (previous) store.put({ ...previous, status: 'SUPERSEDED_REBASE', supersededByMutationId: row.mutationId, updatedAt: timestamp });
    store.put(row);
  });
  await transactionDone(tx);
  return getAll(STORE.SYNC_QUEUE);
}

export async function markCustomerUpsertCloudStatus(importId, syncResult) {
  const jobs = await getAll(STORE.IMPORT_BATCHES);
  const job = jobs.find(row => (row.importId || row.importBatchId) === importId);
  if (!job) return null;
  const queueRows = await requeueRevisionOnlySourceLinkConflicts(importId, await getAll(STORE.SYNC_QUEUE));
  const queue = summarizeCustomerUpsertQueue(queueRows, importId);
  const retryCount = queue.cloudStatus === CUSTOMER_UPSERT_REASON.CLOUD_SYNCED
    ? 0
    : Number(job.cloudRetryCount || 0) + 1;
  const lastError = queue.lastError
    || clean(syncResult?.error?.message || syncResult?.error || syncResult?.message)
    || (syncResult?.online === false ? 'Cloud URL 또는 네트워크 연결을 확인할 수 없어 자동 재시도합니다.' : 'Cloud ACK를 기다리는 중입니다.');
  const nextRetryAt = queue.cloudStatus === CUSTOMER_UPSERT_REASON.CLOUD_SYNCED
    ? ''
    : new Date(Date.now() + customerUpsertRetryDelay(retryCount - 1)).toISOString();
  const updated = {
    ...job,
    cloudStatus: queue.cloudStatus,
    cloudQueueTotalCount: queue.total,
    cloudAppliedCount: queue.acked,
    cloudPendingCount: queue.pending,
    cloudErrorCount: queue.errors,
    cloudConflictCount: queue.conflicts,
    cloudRetryCount: retryCount,
    cloudNextRetryAt: nextRetryAt,
    cloudLastError: queue.cloudStatus === CUSTOMER_UPSERT_REASON.CLOUD_SYNCED ? '' : lastError,
    cloudMessage: queue.cloudStatus === CUSTOMER_UPSERT_REASON.CLOUD_SYNCED
      ? `이 업로드가 생성한 Cloud 큐 ${queue.acked}건이 모두 ACKED로 확인되었습니다.`
      : `${lastError}\n자동 재시도 예정: ${nextRetryAt}`,
    updatedAt: nowIso()
  };
  await persistJob(updated);
  return updated;
}
