import {
  STORE,
  getAll,
  newId,
  normalizeText,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.14.0';
import {
  CUSTOMER_FIELDS,
  CUSTOMER_IMPORT_STATUS,
  CUSTOMER_QUALITY,
  CUSTOMER_STATUS,
  normalizeCustomer,
  resolveCanonicalCustomer
} from './customer-master.js?v=0.15.0';

export const CUSTOMER_SOURCE_SYSTEM = Object.freeze({ ERP: 'ERP', SHOP: 'SHOP' });
export const CUSTOMER_SOURCE_LINK_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  INACTIVE: 'INACTIVE'
});
export const CUSTOMER_SOURCE_MATCH_METHOD = Object.freeze({
  EXISTING_LINK: 'EXISTING_LINK',
  CUSTOMER_CODE_EXACT: 'CUSTOMER_CODE_EXACT',
  EXISTING_IMPORT_HISTORY: 'EXISTING_IMPORT_HISTORY',
  BUSINESS_NUMBER_EXACT: 'BUSINESS_NUMBER_EXACT',
  NAME_EXACT: 'NAME_EXACT',
  ALIAS_EXACT: 'ALIAS_EXACT',
  PHONE_EXACT: 'PHONE_EXACT',
  ADMIN_SELECTED: 'ADMIN_SELECTED',
  ADMIN_NEW: 'ADMIN_NEW'
});

export const CUSTOMER_SOURCE_MAPPING_PROFILE = 'ERP_CUSTOMER';
export const CUSTOMER_SOURCE_MAPPING_VERSION = 'ERP_CUSTOMER_17COL_V1';
export const CUSTOMER_SOURCE_LINK_EVENT = Object.freeze({
  CREATED: 'LINK_CREATED',
  CHANGED: 'LINK_CHANGED',
  DEACTIVATED: 'LINK_DEACTIVATED',
  REACTIVATED: 'LINK_REACTIVATED'
});

const SOURCE_IMPORT_TYPE = 'CUSTOMER_SOURCE_IMPORT';
const ERP_HEADERS = Object.freeze({
  sourceCustomerCode: ['거래처코드', '코드', '사업자번호 (거래처코드)', '사업자번호(거래처코드)'],
  customerName: ['거래처명', '이름(거래처명)'],
  nickname: ['닉네임(검색)', '닉네임', '검색창내용'],
  representativeName: ['대표자명', '대표자'],
  businessNumber: ['사업자번호'],
  businessType: ['업태'],
  businessItem: ['종목'],
  phone: ['전화', '전화번호'],
  fax: ['Fax', 'FAX', '팩스'],
  mobile: ['핸드폰번호', '휴대폰번호', '핸드폰', '휴대폰'],
  email: ['Email', '이메일', 'E-mail'],
  postalCode: ['주소1 우편번호', '우편번호'],
  address: ['주소1', '기본주소', '주소'],
  addressDetail: ['상세주소'],
  contactName: ['담당자명', '담당자'],
  contactPhone: ['관리자연락처', '담당자연락처'],
  group1Code: ['거래처그룹1코드'],
  group1Name: ['그룹1', '거래처그룹1', '그룹'],
  group2Code: ['거래처그룹2코드'],
  group2Name: ['거래처그룹2명'],
  priceGroup: ['단가그룹'],
  paymentDay: ['결제일'],
  bankAccountText: ['계좌'],
  searchText: ['검색창내용'],
  memo: ['적요']
});

export const ERP_CUSTOMER_17COL_CONTRACT = Object.freeze([
  ['담당자명', 'contactName'],
  ['거래처그룹1코드', 'group1Code'],
  ['그룹1', 'group1Name'],
  ['거래처그룹2코드', 'group2Code'],
  ['거래처그룹2명', 'group2Name'],
  ['거래처코드', 'customerCode'],
  ['거래처명', 'customerName'],
  ['적요', 'memo'],
  ['결제일', 'paymentDay'],
  ['계좌', 'bankAccountText'],
  ['단가그룹', 'priceGroup'],
  ['핸드폰번호', 'mobile'],
  ['대표자명', 'representativeName'],
  ['주소1', 'address'],
  ['전화', 'phone'],
  ['검색창내용', 'searchText'],
  ['Email', 'email']
]);

function mappingProfileFor(sourceSystem) {
  return sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP ? CUSTOMER_SOURCE_MAPPING_PROFILE : 'SHOP_CUSTOMER';
}

function mappingVersionFor(sourceSystem) {
  return sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP ? CUSTOMER_SOURCE_MAPPING_VERSION : 'SHOP_CUSTOMER_V1';
}

const SHOP_HEADERS = Object.freeze({
  sourceCustomerCode: ['아이디'],
  customerName: ['이름(거래처명)', '거래처명'],
  nickname: ['닉네임'],
  representativeName: ['대표자명', '대표자'],
  businessNumber: ['사업자번호'],
  businessType: ['업태'],
  businessItem: ['종목'],
  phone: ['전화번호', '전화'],
  mobile: ['휴대폰번호', '핸드폰번호', '휴대폰', '핸드폰'],
  email: ['이메일', 'Email', 'E-mail'],
  postalCode: ['우편번호'],
  address: ['기본주소', '주소'],
  addressDetail: ['상세주소'],
  addressReference: ['참고주소'],
  lotAddress: ['지번주소'],
  homepage: ['홈페이지'],
  memberLevel: ['회원레벨'],
  nicknameChangedAt: ['닉네임변경일자'],
  recommender: ['추천인'],
  points: ['포인트'],
  lastLoginAt: ['로그인일시'],
  joinedAt: ['가입일시'],
  withdrawnAt: ['탈퇴일자']
});

function clean(value) {
  return String(value ?? '').trim();
}

function firstValue(row, headers) {
  for (const header of headers || []) {
    if (Object.prototype.hasOwnProperty.call(row || {}, header) && clean(row[header])) return clean(row[header]);
  }
  return '';
}

function sourceHeaders(sourceSystem) {
  if (sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP) return ERP_HEADERS;
  if (sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP) return SHOP_HEADERS;
  throw new Error(`지원하지 않는 거래처 출처입니다: ${sourceSystem}`);
}

function digits(value) {
  return clean(value).replace(/\D/g, '');
}

function normalizedBusinessNumber(value) {
  const valueDigits = digits(value);
  return valueDigits.length === 10 ? valueDigits : '';
}

function normalizedPhone(value) {
  return digits(value);
}

function looseName(value) {
  return normalizeText(value).replace(/주식회사|유한회사|㈜|\(주\)|\s|[()\-_.\/]/g, '');
}

function bigrams(value) {
  const text = looseName(value);
  if (!text) return [];
  if (text.length === 1) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
}

function nameSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  a.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  let overlap = 0;
  b.forEach(value => {
    const count = counts.get(value) || 0;
    if (!count) return;
    overlap += 1;
    counts.set(value, count - 1);
  });
  return (2 * overlap) / (a.length + b.length);
}

function canonicalMap(customers) {
  return new Map((customers || []).map(customer => [customer.customerId, customer]));
}

function canonicalCustomer(customer, byId) {
  return resolveCanonicalCustomer(customer, byId) || customer || null;
}

function uniqueCanonicalCustomers(customers, byId) {
  const result = new Map();
  (customers || []).forEach(customer => {
    const canonical = canonicalCustomer(customer, byId);
    if (canonical) result.set(canonical.customerId, canonical);
  });
  return [...result.values()];
}

export function makeCustomerSourceLinkKey(sourceSystem, sourceCustomerCode) {
  const system = clean(sourceSystem).toUpperCase();
  const rawCode = clean(sourceCustomerCode);
  if (!system || !rawCode) return '';
  return `${system}::${rawCode}`;
}

function queueItem(entityType, entityId, payload, timestamp = nowIso()) {
  const revision = Math.max(1, Number(payload?.revision || 1));
  return {
    queueId: newId('SQ'),
    entityType,
    entityId,
    action: 'UPSERT',
    operation: 'UPSERT',
    revision,
    baseRevision: Math.max(0, revision - 1),
    payload,
    status: 'PENDING',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function customerEvent(customerId, eventType, payload, actorId, timestamp) {
  return {
    eventId: newId('CE'),
    customerId,
    eventType,
    actorId,
    occurredAt: timestamp,
    payload
  };
}

function aliasRow(customerId, alias, source, sourceId, timestamp) {
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
    sourceId: clean(sourceId),
    confirmed: true,
    useCount: 1,
    lastUsedAt: timestamp,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function linkEvent(link, eventType, beforeCustomerId, afterCustomerId, reason, actorId, timestamp) {
  return {
    eventId: newId('CSLE'),
    linkId: link.linkId,
    eventType,
    beforeCustomerId: clean(beforeCustomerId),
    afterCustomerId: clean(afterCustomerId),
    reason: clean(reason),
    actorId,
    occurredAt: timestamp
  };
}

export function mapCustomerSourceRow(row = {}, sourceSystem) {
  const headers = sourceHeaders(sourceSystem);
  const read = field => firstValue(row, headers[field]);
  const sourceCustomerCode = read('sourceCustomerCode');
  let businessNumber = read('businessNumber');
  if (!businessNumber && sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP) {
    const ambiguousCode = read('sourceCustomerCode');
    if (normalizedBusinessNumber(ambiguousCode)) businessNumber = ambiguousCode;
  }
  const baseAddress = read('address');
  const addressDetail = read('addressDetail');
  const addressReference = read('addressReference');
  const sourceAddress = [baseAddress, addressDetail, addressReference].filter(Boolean).join(' ').trim();
  const incoming = {
    customerCode: sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP ? sourceCustomerCode : '',
    customerName: read('customerName'),
    representativeName: read('representativeName'),
    businessNumber,
    businessType: read('businessType'),
    businessItem: read('businessItem'),
    phone: read('phone'),
    fax: read('fax'),
    mobile: read('mobile'),
    email: read('email'),
    postalCode: read('postalCode'),
    address: baseAddress,
    addressDetail,
    contactName: read('contactName'),
    contactPhone: read('contactPhone'),
    group1Code: read('group1Code'),
    group1Name: read('group1Name'),
    group2Code: read('group2Code'),
    group2Name: read('group2Name'),
    priceGroup: read('priceGroup'),
    paymentDay: read('paymentDay'),
    bankAccountText: read('bankAccountText'),
    memo: read('memo'),
    searchText: read('searchText')
  };
  incoming.groupName = incoming.group1Name;
  return {
    sourceSystem,
    sourceCustomerCode,
    normalizedSourceCustomerCode: normalizeText(sourceCustomerCode),
    sourceLinkKey: makeCustomerSourceLinkKey(sourceSystem, sourceCustomerCode),
    sourceCustomerName: incoming.customerName,
    sourceNickname: read('nickname'),
    sourceBusinessNumber: businessNumber,
    sourceRepresentativeName: incoming.representativeName,
    sourcePhone: incoming.phone,
    sourceMobile: incoming.mobile,
    sourceAddress,
    sourceEmail: incoming.email,
    sourceSearchText: read('searchText'),
    incoming,
    sourceSnapshot: { ...row }
  };
}

function changedFields(existing, incoming) {
  return CUSTOMER_FIELDS.filter(field => field !== 'groupName' && clean(incoming[field]) && clean(incoming[field]) !== clean(existing?.[field]));
}

function candidateMapEntry(map, customer, reason, score) {
  if (!customer) return;
  const current = map.get(customer.customerId) || { customerId: customer.customerId, reasons: [], score: 0 };
  if (!current.reasons.includes(reason)) current.reasons.push(reason);
  current.score = Math.max(current.score, score);
  map.set(customer.customerId, current);
}

function recommendationCandidates(source, customers, aliases, byId) {
  const candidates = new Map();
  const names = [source.sourceCustomerName, source.sourceNickname, source.sourceSearchText].map(clean).filter(Boolean);
  const normalizedNames = names.map(normalizeText);
  const sourcePhones = new Set([normalizedPhone(source.sourcePhone), normalizedPhone(source.sourceMobile)].filter(Boolean));

  customers.forEach(original => {
    const customer = canonicalCustomer(original, byId);
    if (!customer || customer.status !== CUSTOMER_STATUS.ACTIVE || customer.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) return;
    const normalizedCustomerName = normalizeText(customer.customerName);
    if (normalizedNames.includes(normalizedCustomerName)) candidateMapEntry(candidates, customer, CUSTOMER_SOURCE_MATCH_METHOD.NAME_EXACT, 950);
    const customerPhones = [normalizedPhone(customer.phone), normalizedPhone(customer.mobile), normalizedPhone(customer.contactPhone)].filter(Boolean);
    if (customerPhones.some(phone => sourcePhones.has(phone))) candidateMapEntry(candidates, customer, CUSTOMER_SOURCE_MATCH_METHOD.PHONE_EXACT, 800);
    const similarity = Math.max(0, ...names.map(name => nameSimilarity(name, customer.customerName)));
    if (similarity >= 0.72) candidateMapEntry(candidates, customer, 'NAME_SIMILAR', Math.round(similarity * 700));
  });

  aliases.forEach(alias => {
    if (alias.active === false) return;
    const normalizedAlias = alias.normalizedAlias || alias.normalizedText || normalizeText(alias.alias || alias.rawText);
    if (!normalizedAlias || !normalizedNames.includes(normalizedAlias)) return;
    const customer = canonicalCustomer(byId.get(alias.customerId), byId);
    if (customer?.status === CUSTOMER_STATUS.ACTIVE) candidateMapEntry(candidates, customer, CUSTOMER_SOURCE_MATCH_METHOD.ALIAS_EXACT, 925);
  });

  return [...candidates.values()].sort((a, b) => b.score - a.score || a.customerId.localeCompare(b.customerId));
}

function uniqueBusinessMatch(source, customers, byId) {
  const businessNumber = normalizedBusinessNumber(source.sourceBusinessNumber);
  if (!businessNumber) return null;
  const matches = uniqueCanonicalCustomers(customers.filter(customer => normalizedBusinessNumber(customer.businessNumber) === businessNumber), byId)
    .filter(customer => customer.status === CUSTOMER_STATUS.ACTIVE && customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED);
  return matches.length === 1 ? matches[0] : null;
}

async function findSourceLinkByKey(sourceLinkKey) {
  if (!sourceLinkKey) return null;
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.CUSTOMER_SOURCE_LINKS, 'readonly');
  const result = await requestToPromise(tx.objectStore(STORE.CUSTOMER_SOURCE_LINKS).index('bySourceLinkKey').get(sourceLinkKey));
  await transactionDone(tx);
  return result || null;
}

export async function listCustomerSourceLinks({ sourceSystem = '', customerId = '', includeInactive = true } = {}) {
  const rows = await getAll(STORE.CUSTOMER_SOURCE_LINKS);
  return rows.filter(row => (!sourceSystem || row.sourceSystem === sourceSystem)
    && (!customerId || row.customerId === customerId)
    && (includeInactive || row.active !== false));
}

export async function resolveCustomerSourceLink(sourceSystem, sourceCustomerCode) {
  const link = await findSourceLinkByKey(makeCustomerSourceLinkKey(sourceSystem, sourceCustomerCode));
  if (!link) return { status: 'NOT_FOUND', link: null, customer: null, canonicalCustomer: null };
  const customers = await getAll(STORE.CUSTOMERS);
  const byId = canonicalMap(customers);
  const customer = byId.get(link.customerId) || null;
  const canonical = canonicalCustomer(customer, byId);
  return {
    status: link.active === false || link.linkStatus === CUSTOMER_SOURCE_LINK_STATUS.INACTIVE ? 'INACTIVE' : 'MATCHED',
    link,
    customer,
    canonicalCustomer: canonical
  };
}

function sourceRowNumber(index, sourceSystem) {
  return index + 2;
}

function uniqueCustomerCodeMatch(source, customers, byId) {
  const sourceCode = normalizeText(source.sourceCustomerCode);
  if (!sourceCode) return null;
  const matches = uniqueCanonicalCustomers(
    customers.filter(customer => normalizeText(customer.customerCode || customer.erpCustomerCode) === sourceCode),
    byId
  ).filter(customer => customer.status === CUSTOMER_STATUS.ACTIVE && customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED);
  return matches.length === 1 ? matches[0] : null;
}

function importHistoryMatch(source, historyByKey, byId) {
  const history = historyByKey.get(source.sourceLinkKey);
  const customer = canonicalCustomer(byId.get(history?.appliedCustomerId), byId);
  return customer?.status === CUSTOMER_STATUS.ACTIVE && customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED
    ? customer
    : null;
}

function defaultFieldDecisions(existing, incoming, differences) {
  return Object.fromEntries(differences
    .filter(field => !clean(existing?.[field]) && clean(incoming?.[field]))
    .map(field => [field, 'USE_FILE']));
}

async function persistCustomerSourceImportChunk(batch, records = []) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS], 'readwrite');
  tx.objectStore(STORE.IMPORT_BATCHES).put(batch);
  const recordStore = tx.objectStore(STORE.SOURCE_RECORDS);
  records.forEach(record => recordStore.put(record));
  await transactionDone(tx);
}

function sortedCustomerSourceImportRecords(records = []) {
  return [...records].sort((a, b) => Number(a.rowNo || 0) - Number(b.rowNo || 0));
}

function canResumeCustomerSourceImport(batch, records, rowCount) {
  const processedCount = Number(batch?.processedCount || 0);
  return batch?.status === 'PREPARING'
    && Number(batch.rowCount || 0) === rowCount
    && processedCount >= 0
    && processedCount <= rowCount
    && records.length === processedCount
    && records.every((record, index) => Number(record.rowNo || 0) === sourceRowNumber(index, batch.sourceSystem));
}

export async function prepareCustomerSourceImport(rows, {
  sourceSystem,
  fileName = '',
  fileHash = '',
  onProgress = null,
  chunkSize = 200
} = {}) {
  const system = clean(sourceSystem).toUpperCase();
  sourceHeaders(system);
  const progressChunkSize = Math.max(1, Number(chunkSize) || 200);
  const expectedMappingProfile = mappingProfileFor(system);
  const expectedMappingVersion = mappingVersionFor(system);
  const mappedSources = rows.map(row => mapCustomerSourceRow(row, system));
  const mappingFieldCounts = system === CUSTOMER_SOURCE_SYSTEM.ERP
    ? Object.fromEntries(ERP_CUSTOMER_17COL_CONTRACT.map(([, field]) => [
        field,
        mappedSources.reduce((count, source) => count + (clean(source.incoming[field]) ? 1 : 0), 0)
      ]))
    : {};
  let batch = null;
  let records = [];
  let startIndex = 0;
  let isNewBatch = true;

  if (fileHash) {
    const batches = await getAll(STORE.IMPORT_BATCHES);
    const reusableBatch = batches
      .filter(candidate => candidate.sourceType === SOURCE_IMPORT_TYPE
        && candidate.sourceSystem === system
        && candidate.fileHash === fileHash
        && candidate.mappingProfile === expectedMappingProfile
        && candidate.mappingVersion === expectedMappingVersion
        && ['PREPARING', 'PREPARED', 'PARTIAL'].includes(candidate.status))
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
    if (reusableBatch) {
      const reusableRecords = sortedCustomerSourceImportRecords(await getCustomerSourceImportRecords(reusableBatch.importBatchId));
      const hasStaleLinkConflict = reusableRecords.some(record => String(record.errorMessage || '').includes('CUSTOMER_SOURCE_LINK_REVISION_CONFLICT'));
      const hasLegacyUnconfirmedNew = reusableRecords.some(record => record.status === CUSTOMER_IMPORT_STATUS.NEW && !record.newDraftConfirmed && !record.validationError);
      const completedRecordSet = ['PREPARED', 'PARTIAL'].includes(reusableBatch.status)
        && Number(reusableBatch.rowCount || 0) === rows.length
        && reusableRecords.length === rows.length;
      if (completedRecordSet && !hasStaleLinkConflict && !hasLegacyUnconfirmedNew) {
        const completedBatch = { ...reusableBatch, processedCount: reusableRecords.length, updatedAt: reusableBatch.updatedAt || nowIso() };
        if (Number(reusableBatch.processedCount || 0) !== reusableRecords.length) await persistCustomerSourceImportChunk(completedBatch);
        return { batch: completedBatch, records: reusableRecords, resumed: true };
      }
      if (canResumeCustomerSourceImport(reusableBatch, reusableRecords, rows.length)) {
        batch = { ...reusableBatch, lastError: '' };
        records = reusableRecords;
        startIndex = Number(batch.processedCount || 0);
        isNewBatch = false;
      } else {
        await persistCustomerSourceImportChunk({
          ...reusableBatch,
          status: 'FAILED',
          lastError: 'CUSTOMER_SOURCE_IMPORT_RESUME_INVALID',
          updatedAt: nowIso()
        });
      }
    }
  }

  if (!batch) {
    const timestamp = nowIso();
    batch = {
      importBatchId: newId('CIB'),
      sourceType: SOURCE_IMPORT_TYPE,
      sourceSystem: system,
      mappingProfile: expectedMappingProfile,
      mappingVersion: expectedMappingVersion,
      mappedHeaderCount: system === CUSTOMER_SOURCE_SYSTEM.ERP ? ERP_CUSTOMER_17COL_CONTRACT.length : 0,
      mappingFieldCounts,
      fileName,
      fileHash,
      rowCount: rows.length,
      processedCount: 0,
      status: 'PREPARING',
      lastError: '',
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  try {
    if (isNewBatch) await persistCustomerSourceImportChunk(batch);
    onProgress?.({ phase: 'PERSISTED', processed: startIndex, total: rows.length, resumed: !isNewBatch });

    const [customers, aliases, links, priorSourceRecords] = await Promise.all([
      getAll(STORE.CUSTOMERS),
      getAll(STORE.CUSTOMER_ALIASES),
      getAll(STORE.CUSTOMER_SOURCE_LINKS),
      getAll(STORE.SOURCE_RECORDS)
    ]);
    const byId = canonicalMap(customers);
    const linksByKey = new Map(links.map(link => [link.sourceLinkKey, link]));
    const historyByKey = new Map();
    priorSourceRecords
      .filter(record => record.sourceType === SOURCE_IMPORT_TYPE
        && record.sourceSystem === system
        && record.sourceLinkKey
        && record.appliedCustomerId)
      .sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)))
      .forEach(record => historyByKey.set(record.sourceLinkKey, record));
    const sourceLinkKeyCounts = mappedSources.reduce((map, source) => {
      if (source.sourceLinkKey) map.set(source.sourceLinkKey, (map.get(source.sourceLinkKey) || 0) + 1);
      return map;
    }, new Map());
    const pendingChunk = [];

    for (let index = startIndex; index < rows.length; index += 1) {
      const source = mappedSources[index];
      const existingLink = linksByKey.get(source.sourceLinkKey) || null;
      let status = CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED;
      let selectedCustomerId = '';
      let matchMethod = '';
      let differences = [];
      let validationError = '';
      let candidates = [];
      let matchedCustomer = null;

      if (!source.sourceCustomerCode) validationError = system === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원 아이디가 없습니다.' : 'ERP 거래처코드가 없습니다.';
      else if (!source.sourceCustomerName) validationError = '거래처명이 없습니다.';
      else if ((sourceLinkKeyCounts.get(source.sourceLinkKey) || 0) > 1) validationError = '같은 출처 거래처코드가 파일에 중복되어 있습니다. 중복 행은 하나만 남기고 나머지는 제외해 주세요.';
      else if (existingLink && existingLink.active !== false && existingLink.linkStatus === CUSTOMER_SOURCE_LINK_STATUS.CONFIRMED) {
        const original = byId.get(existingLink.customerId);
        const canonical = canonicalCustomer(original, byId);
        if (canonical && canonical.status === CUSTOMER_STATUS.ACTIVE) {
          matchedCustomer = canonical;
          selectedCustomerId = canonical.customerId;
          matchMethod = CUSTOMER_SOURCE_MATCH_METHOD.EXISTING_LINK;
          differences = changedFields(canonical, source.incoming);
          status = differences.length ? CUSTOMER_IMPORT_STATUS.CHANGED : CUSTOMER_IMPORT_STATUS.SAME;
        } else validationError = '기존 연결 거래처가 거래중단 또는 삭제 상태입니다.';
      } else if (!existingLink) {
        const codeMatch = uniqueCustomerCodeMatch(source, customers, byId);
        const historyMatch = codeMatch ? null : importHistoryMatch(source, historyByKey, byId);
        const businessMatch = codeMatch || historyMatch ? null : uniqueBusinessMatch(source, customers, byId);
        matchedCustomer = codeMatch || historyMatch || businessMatch;
        if (matchedCustomer) {
          selectedCustomerId = matchedCustomer.customerId;
          matchMethod = codeMatch
            ? CUSTOMER_SOURCE_MATCH_METHOD.CUSTOMER_CODE_EXACT
            : historyMatch
              ? CUSTOMER_SOURCE_MATCH_METHOD.EXISTING_IMPORT_HISTORY
              : CUSTOMER_SOURCE_MATCH_METHOD.BUSINESS_NUMBER_EXACT;
          differences = changedFields(matchedCustomer, source.incoming);
          status = differences.length ? CUSTOMER_IMPORT_STATUS.CHANGED : CUSTOMER_IMPORT_STATUS.SAME;
        }
      }

      if (!selectedCustomerId && !validationError) {
        candidates = recommendationCandidates(source, customers, aliases, byId);
        status = candidates.length ? CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED : CUSTOMER_IMPORT_STATUS.NEW;
      }

      const recordTimestamp = nowIso();
      const record = {
        sourceRecordId: newId('CISR'),
        importBatchId: batch.importBatchId,
        sourceType: SOURCE_IMPORT_TYPE,
        sourceSystem: system,
        rowNo: sourceRowNumber(index, system),
        raw: { ...rows[index] },
        sourceSnapshot: source.sourceSnapshot,
        sourceCustomerCode: source.sourceCustomerCode,
        normalizedSourceCustomerCode: source.normalizedSourceCustomerCode,
        sourceLinkKey: source.sourceLinkKey,
        sourceCustomerName: source.sourceCustomerName,
        sourceNickname: source.sourceNickname,
        sourceSearchText: source.sourceSearchText,
        sourceBusinessNumber: source.sourceBusinessNumber,
        sourceRepresentativeName: source.sourceRepresentativeName,
        sourcePhone: source.sourcePhone,
        sourceMobile: source.sourceMobile,
        sourceAddress: source.sourceAddress,
        sourceEmail: source.sourceEmail,
        incoming: source.incoming,
        status,
        selectedCustomerId,
        existingSourceLinkId: existingLink?.linkId || '',
        sourceLinkCustomerId: existingLink?.customerId || '',
        sourceLinkRevision: Number(existingLink?.revision || 0),
        matchMethod,
        mappingProfile: expectedMappingProfile,
        mappingVersion: expectedMappingVersion,
        candidateCustomerIds: candidates.map(candidate => candidate.customerId),
        candidateEvidence: candidates,
        changedFields: differences,
        fieldDecisions: status === CUSTOMER_IMPORT_STATUS.CHANGED
          ? defaultFieldDecisions(matchedCustomer, source.incoming, differences)
          : {},
        newDraftConfirmed: status === CUSTOMER_IMPORT_STATUS.NEW,
        validationError,
        errorMessage: '',
        createdAt: recordTimestamp,
        updatedAt: recordTimestamp
      };
      records.push(record);
      pendingChunk.push(record);

      const processed = index + 1;
      if (pendingChunk.length >= progressChunkSize || processed === rows.length) {
        const persistedBatch = {
          ...batch,
          status: processed === rows.length ? 'PREPARED' : 'PREPARING',
          processedCount: processed,
          lastError: '',
          updatedAt: nowIso()
        };
        await persistCustomerSourceImportChunk(persistedBatch, pendingChunk);
        batch = persistedBatch;
        pendingChunk.length = 0;
        onProgress?.({ phase: 'PERSISTED', processed, total: rows.length, resumed: !isNewBatch });
        if (processed < rows.length) await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (!rows.length) {
      batch = { ...batch, status: 'PREPARED', processedCount: 0, updatedAt: nowIso() };
      await persistCustomerSourceImportChunk(batch);
    }
    return { batch, records: sortedCustomerSourceImportRecords(records), resumed: !isNewBatch };
  } catch (error) {
    const processedCount = Number(batch?.processedCount || 0);
    const actualMessage = String(error?.message || error || '알 수 없는 IndexedDB 오류');
    try {
      await persistCustomerSourceImportChunk({ ...batch, status: 'PREPARING', lastError: actualMessage, updatedAt: nowIso() });
    } catch (batchError) {
      console.error('Customer source import failure state could not be saved', batchError);
    }
    const wrapped = new Error(actualMessage);
    wrapped.code = error?.code || 'CUSTOMER_SOURCE_IMPORT_PREPARE_FAILED';
    wrapped.processedCount = processedCount;
    wrapped.totalCount = rows.length;
    throw wrapped;
  }
}

export async function setCustomerSourceImportDecision(sourceRecordId, decision = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  const store = tx.objectStore(STORE.SOURCE_RECORDS);
  const record = await requestToPromise(store.get(sourceRecordId));
  if (!record || record.sourceType !== SOURCE_IMPORT_TYPE) throw new Error('거래처 Source 가져오기 행을 찾을 수 없습니다.');
  const updated = { ...record, ...decision, updatedAt: nowIso() };
  store.put(updated);
  await transactionDone(tx);
  return updated;
}

export async function getCustomerSourceImportRecords(importBatchId) {
  const records = await getAll(STORE.SOURCE_RECORDS);
  return records.filter(record => record.importBatchId === importBatchId && record.sourceType === SOURCE_IMPORT_TYPE);
}

export async function getLatestCustomerSourceImportWork() {
  const batches = await getAll(STORE.IMPORT_BATCHES);
  const batch = batches
    .filter(candidate => candidate.sourceType === SOURCE_IMPORT_TYPE
      && candidate.mappingVersion === mappingVersionFor(candidate.sourceSystem)
      && ['PREPARING', 'PREPARED', 'PARTIAL'].includes(candidate.status))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
  if (!batch) return null;
  return { batch, records: await getCustomerSourceImportRecords(batch.importBatchId) };
}

function effectiveStatus(record) {
  return record.status === CUSTOMER_IMPORT_STATUS.FAILED ? record.retryStatus : record.status;
}

export function canApplyCustomerSourceImport(records) {
  const activeKeys = records.filter(record => ![CUSTOMER_IMPORT_STATUS.EXCLUDED, CUSTOMER_IMPORT_STATUS.APPLIED].includes(effectiveStatus(record))).map(record => record.sourceLinkKey).filter(Boolean);
  if (new Set(activeKeys).size !== activeKeys.length) return false;
  return records.every(record => {
    const status = effectiveStatus(record);
    if ([CUSTOMER_IMPORT_STATUS.SAME, CUSTOMER_IMPORT_STATUS.EXCLUDED, CUSTOMER_IMPORT_STATUS.APPLIED].includes(status)) return true;
    if (status === CUSTOMER_IMPORT_STATUS.NEW) return record.newDraftConfirmed === true && Boolean(record.sourceLinkKey) && Boolean(record.incoming?.customerName);
    if (status === CUSTOMER_IMPORT_STATUS.CHANGED) {
      const decisions = record.fieldDecisions || {};
      return Boolean(record.selectedCustomerId) && (record.changedFields || []).every(field => ['USE_FILE', 'KEEP_EXISTING'].includes(decisions[field]));
    }
    return false;
  });
}

async function canonicalInTransaction(customerStore, customerId) {
  let current = await requestToPromise(customerStore.get(customerId));
  const visited = new Set();
  while (current?.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) {
    if (visited.has(current.customerId)) throw new Error('거래처 대표 연결에 순환 참조가 있습니다.');
    visited.add(current.customerId);
    current = await requestToPromise(customerStore.get(current.canonicalCustomerId || current.supersededByCustomerId));
  }
  return current || null;
}

async function addAliasIfNeeded(tx, customerId, value, source, sourceId, timestamp) {
  const alias = clean(value);
  const normalized = normalizeText(alias);
  if (!normalized) return null;
  const aliasStore = tx.objectStore(STORE.CUSTOMER_ALIASES);
  const existing = await requestToPromise(aliasStore.index('byCustomerText').get([customerId, normalized]));
  if (existing) return existing;
  const created = aliasRow(customerId, alias, source, sourceId, timestamp);
  aliasStore.put(created);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_ALIAS', created.mappingId, created, timestamp));
  return created;
}

function buildSourceLink(record, customerId, existing, timestamp) {
  return {
    ...(existing || {}),
    linkId: existing?.linkId || record.existingSourceLinkId || newId('CSL'),
    customerId,
    sourceSystem: record.sourceSystem,
    sourceCustomerCode: record.sourceCustomerCode,
    normalizedSourceCustomerCode: record.normalizedSourceCustomerCode,
    sourceLinkKey: record.sourceLinkKey,
    sourceCustomerName: record.sourceCustomerName,
    sourceNickname: record.sourceNickname,
    sourceSearchText: record.sourceSearchText,
    sourceBusinessNumber: record.sourceBusinessNumber,
    sourceRepresentativeName: record.sourceRepresentativeName,
    sourcePhone: record.sourcePhone,
    sourceMobile: record.sourceMobile,
    sourceAddress: record.sourceAddress,
    sourceEmail: record.sourceEmail,
    sourceSnapshot: { ...(record.sourceSnapshot || record.raw || {}) },
    matchMethod: record.matchMethod || existing?.matchMethod || CUSTOMER_SOURCE_MATCH_METHOD.ADMIN_SELECTED,
    linkStatus: CUSTOMER_SOURCE_LINK_STATUS.CONFIRMED,
    revision: Number(existing?.revision || 0) + 1,
    confirmedBy: existing?.confirmedBy || '',
    confirmedAt: existing?.confirmedAt || '',
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    active: true
  };
}

async function applyOneRecord(record, actorId) {
  const operationStatus = effectiveStatus(record);
  if (operationStatus === CUSTOMER_IMPORT_STATUS.EXCLUDED || operationStatus === CUSTOMER_IMPORT_STATUS.APPLIED) {
    return { sourceRecordId: record.sourceRecordId, status: record.status, customerId: record.appliedCustomerId || '', linkId: record.appliedSourceLinkId || '' };
  }
  if (operationStatus === CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED) throw new Error('확인필요 거래처는 먼저 연결·신규등록·제외 중 하나를 선택해 주세요.');
  if (operationStatus === CUSTOMER_IMPORT_STATUS.NEW && record.newDraftConfirmed !== true) throw new Error('신규 거래처 등록을 먼저 확정해 주세요.');

  const timestamp = nowIso();
  const db = await openOrderQDb();
  const stores = [
    STORE.CUSTOMERS,
    STORE.CUSTOMER_ALIASES,
    STORE.CUSTOMER_EVENTS,
    STORE.CUSTOMER_SOURCE_LINKS,
    STORE.CUSTOMER_SOURCE_LINK_EVENTS,
    STORE.SOURCE_RECORDS,
    STORE.SYNC_QUEUE
  ];
  const tx = db.transaction(stores, 'readwrite');
  const customerStore = tx.objectStore(STORE.CUSTOMERS);
  const linkStore = tx.objectStore(STORE.CUSTOMER_SOURCE_LINKS);
  const recordStore = tx.objectStore(STORE.SOURCE_RECORDS);
  const persistedRecord = await requestToPromise(recordStore.get(record.sourceRecordId));
  if (persistedRecord?.status === CUSTOMER_IMPORT_STATUS.APPLIED) {
    await transactionDone(tx);
    return {
      sourceRecordId: record.sourceRecordId,
      status: CUSTOMER_IMPORT_STATUS.APPLIED,
      customerId: persistedRecord.appliedCustomerId || '',
      linkId: persistedRecord.appliedSourceLinkId || ''
    };
  }

  const existingLink = record.sourceLinkKey
    ? await requestToPromise(linkStore.index('bySourceLinkKey').get(record.sourceLinkKey))
    : null;
  const expectedSourceLinkRevision = Number(record.sourceLinkRevision || 0);
  const actualSourceLinkRevision = Number(existingLink?.revision || 0);
  if (actualSourceLinkRevision !== expectedSourceLinkRevision) {
    tx.abort();
    const error = new Error('CUSTOMER_SOURCE_LINK_REVISION_CONFLICT');
    error.code = 'CUSTOMER_SOURCE_LINK_REVISION_CONFLICT';
    error.expectedRevision = expectedSourceLinkRevision;
    error.actualRevision = actualSourceLinkRevision;
    throw error;
  }
  let customer = null;
  let customerWasChanged = false;

  if (operationStatus === CUSTOMER_IMPORT_STATUS.NEW) {
    customer = normalizeCustomer({
      ...record.incoming,
      customerId: newId('CU'),
      customerCode: record.sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP ? record.sourceCustomerCode : '',
      status: CUSTOMER_STATUS.ACTIVE,
      qualityStatus: (record.candidateCustomerIds || []).length ? CUSTOMER_QUALITY.DUPLICATE_CANDIDATE : CUSTOMER_QUALITY.UNVERIFIED,
      source: `${record.sourceSystem}_IMPORT`,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    customerStore.put(customer);
    tx.objectStore(STORE.CUSTOMER_EVENTS).put(customerEvent(customer.customerId, 'CREATED', { source: `${record.sourceSystem}_IMPORT`, customer }, actorId, timestamp));
    tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER', customer.customerId, customer, timestamp));
    customerWasChanged = true;
  } else {
    if (!record.selectedCustomerId) {
      tx.abort();
      throw new Error('연결할 대표 거래처를 선택해 주세요.');
    }
    customer = await canonicalInTransaction(customerStore, record.selectedCustomerId);
    if (!customer || customer.status !== CUSTOMER_STATUS.ACTIVE) {
      tx.abort();
      throw new Error('연결할 사용중 거래처를 찾을 수 없습니다.');
    }
    if (operationStatus === CUSTOMER_IMPORT_STATUS.CHANGED) {
      const before = { ...customer };
      const patch = { ...customer };
      Object.entries(record.fieldDecisions || {}).forEach(([field, choice]) => {
        if (choice === 'USE_FILE' && clean(record.incoming?.[field])) patch[field] = record.incoming[field];
      });
      const next = normalizeCustomer({ ...patch, customerId: customer.customerId, revision: Number(customer.revision || 1) + 1, updatedAt: timestamp }, customer);
      if (JSON.stringify(CUSTOMER_FIELDS.map(field => before[field] || '')) !== JSON.stringify(CUSTOMER_FIELDS.map(field => next[field] || ''))) {
        customerStore.put(next);
        tx.objectStore(STORE.CUSTOMER_EVENTS).put(customerEvent(customer.customerId, 'UPDATED', { source: `${record.sourceSystem}_IMPORT`, before, after: next }, actorId, timestamp));
        tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER', next.customerId, next, timestamp));
        if (before.customerName !== next.customerName) await addAliasIfNeeded(tx, next.customerId, before.customerName, 'PREVIOUS_NAME', record.sourceLinkKey, timestamp);
        customer = next;
        customerWasChanged = true;
      }
    }
  }

  const currentLinkCanonical = existingLink ? await canonicalInTransaction(customerStore, existingLink.customerId) : null;
  let linkTargetCustomerId = existingLink?.customerId || customer.customerId;
  let eventType = '';
  let beforeCustomerId = existingLink?.customerId || '';
  if (!existingLink) {
    eventType = CUSTOMER_SOURCE_LINK_EVENT.CREATED;
    linkTargetCustomerId = customer.customerId;
  } else if (existingLink.active === false || existingLink.linkStatus === CUSTOMER_SOURCE_LINK_STATUS.INACTIVE) {
    eventType = CUSTOMER_SOURCE_LINK_EVENT.REACTIVATED;
    if (record.matchMethod === CUSTOMER_SOURCE_MATCH_METHOD.ADMIN_SELECTED && currentLinkCanonical?.customerId !== customer.customerId) linkTargetCustomerId = customer.customerId;
  } else if (record.matchMethod === CUSTOMER_SOURCE_MATCH_METHOD.ADMIN_SELECTED && currentLinkCanonical?.customerId !== customer.customerId) {
    eventType = CUSTOMER_SOURCE_LINK_EVENT.CHANGED;
    linkTargetCustomerId = customer.customerId;
  }

  const link = buildSourceLink(record, linkTargetCustomerId, existingLink, timestamp);
  if (!link.confirmedBy) link.confirmedBy = actorId;
  if (!link.confirmedAt) link.confirmedAt = timestamp;
  linkStore.put(link);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_SOURCE_LINK', link.linkId, link, timestamp));

  if (eventType) {
    const event = linkEvent(link, eventType, beforeCustomerId, linkTargetCustomerId, record.matchMethod || 'IMPORT_APPLY', actorId, timestamp);
    tx.objectStore(STORE.CUSTOMER_SOURCE_LINK_EVENTS).put(event);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_SOURCE_LINK_EVENT', event.eventId, event, timestamp));
  }

  await addAliasIfNeeded(tx, customer.customerId, record.sourceCustomerName, `${record.sourceSystem}_SOURCE_NAME`, record.sourceLinkKey, timestamp);
  await addAliasIfNeeded(tx, customer.customerId, record.sourceNickname, `${record.sourceSystem}_SOURCE_NICKNAME`, record.sourceLinkKey, timestamp);
  const searchAliases = [...new Set([
    record.sourceSearchText,
    ...clean(record.sourceSearchText).split(/[\s,;/|]+/)
  ].map(clean).filter(Boolean))];
  for (const value of searchAliases) {
    await addAliasIfNeeded(tx, customer.customerId, value, `${record.sourceSystem}_SOURCE_SEARCH`, record.sourceLinkKey, timestamp);
  }

  const appliedRecord = {
    ...(persistedRecord || record),
    status: CUSTOMER_IMPORT_STATUS.APPLIED,
    retryStatus: '',
    appliedCustomerId: customer.customerId,
    appliedSourceLinkId: link.linkId,
    errorMessage: '',
    masterChanged: customerWasChanged,
    updatedAt: timestamp
  };
  recordStore.put(appliedRecord);
  await transactionDone(tx);
  return { sourceRecordId: record.sourceRecordId, status: CUSTOMER_IMPORT_STATUS.APPLIED, customerId: customer.customerId, linkId: link.linkId };
}

async function markRecordFailed(record, operationStatus, error) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  const store = tx.objectStore(STORE.SOURCE_RECORDS);
  const current = await requestToPromise(store.get(record.sourceRecordId));
  if (current?.status !== CUSTOMER_IMPORT_STATUS.APPLIED) {
    store.put({
      ...(current || record),
      status: CUSTOMER_IMPORT_STATUS.FAILED,
      retryStatus: operationStatus,
      errorMessage: error.message || String(error),
      updatedAt: nowIso()
    });
  }
  await transactionDone(tx);
}

export async function applyCustomerSourceImport(importBatchId, { actorId = 'administrator' } = {}) {
  const records = await getCustomerSourceImportRecords(importBatchId);
  if (!canApplyCustomerSourceImport(records)) throw new Error('확인필요 행, 신규등록, 필드 변경 선택을 모두 완료해 주세요.');
  const results = [];
  for (const record of records) {
    const operationStatus = effectiveStatus(record);
    if (operationStatus === CUSTOMER_IMPORT_STATUS.EXCLUDED || operationStatus === CUSTOMER_IMPORT_STATUS.APPLIED) {
      results.push({ sourceRecordId: record.sourceRecordId, status: record.status });
      continue;
    }
    try {
      results.push(await applyOneRecord(record, actorId));
    } catch (error) {
      await markRecordFailed(record, operationStatus, error);
      results.push({ sourceRecordId: record.sourceRecordId, status: CUSTOMER_IMPORT_STATUS.FAILED, retryStatus: operationStatus, error: error.message || String(error) });
    }
  }

  const failed = results.some(result => result.status === CUSTOMER_IMPORT_STATUS.FAILED);
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.IMPORT_BATCHES, 'readwrite');
  const store = tx.objectStore(STORE.IMPORT_BATCHES);
  const batch = await requestToPromise(store.get(importBatchId));
  if (batch) store.put({ ...batch, status: failed ? 'PARTIAL' : 'APPLIED', updatedAt: nowIso() });
  await transactionDone(tx);
  return results;
}

async function mutateSourceLink(sourceSystem, sourceCustomerCode, mutate, { actorId = 'administrator', reason = '', expectedRevision = null } = {}) {
  const key = makeCustomerSourceLinkKey(sourceSystem, sourceCustomerCode);
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.CUSTOMERS, STORE.CUSTOMER_SOURCE_LINKS, STORE.CUSTOMER_SOURCE_LINK_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  const linkStore = tx.objectStore(STORE.CUSTOMER_SOURCE_LINKS);
  const link = await requestToPromise(linkStore.index('bySourceLinkKey').get(key));
  if (!link) {
    tx.abort();
    throw new Error('Source Link를 찾을 수 없습니다.');
  }
  if (expectedRevision === null || expectedRevision === undefined || expectedRevision === '') {
    tx.abort();
    throw new Error('CUSTOMER_SOURCE_LINK_EXPECTED_REVISION_REQUIRED');
  }
  if (Number(link.revision || 0) !== Number(expectedRevision)) {
    tx.abort();
    const error = new Error('CUSTOMER_SOURCE_LINK_REVISION_CONFLICT');
    error.code = 'CUSTOMER_SOURCE_LINK_REVISION_CONFLICT';
    error.expectedRevision = Number(expectedRevision);
    error.actualRevision = Number(link.revision || 0);
    throw error;
  }
  const timestamp = nowIso();
  const changed = await mutate({ ...link }, tx, timestamp);
  linkStore.put(changed.link);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_SOURCE_LINK', changed.link.linkId, changed.link, timestamp));
  if (changed.eventType) {
    const event = linkEvent(changed.link, changed.eventType, changed.beforeCustomerId, changed.afterCustomerId, reason, actorId, timestamp);
    tx.objectStore(STORE.CUSTOMER_SOURCE_LINK_EVENTS).put(event);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueItem('CUSTOMER_SOURCE_LINK_EVENT', event.eventId, event, timestamp));
  }
  await transactionDone(tx);
  return changed.link;
}

export async function relinkCustomerSource(sourceSystem, sourceCustomerCode, customerId, options = {}) {
  return mutateSourceLink(sourceSystem, sourceCustomerCode, async (link, tx, timestamp) => {
    const target = await canonicalInTransaction(tx.objectStore(STORE.CUSTOMERS), customerId);
    if (!target || target.status !== CUSTOMER_STATUS.ACTIVE) throw new Error('연결할 사용중 대표 거래처를 찾을 수 없습니다.');
    return {
      link: { ...link, customerId: target.customerId, matchMethod: CUSTOMER_SOURCE_MATCH_METHOD.ADMIN_SELECTED, linkStatus: CUSTOMER_SOURCE_LINK_STATUS.CONFIRMED, active: true, revision: Number(link.revision || 0) + 1, updatedAt: timestamp },
      eventType: CUSTOMER_SOURCE_LINK_EVENT.CHANGED,
      beforeCustomerId: link.customerId,
      afterCustomerId: target.customerId
    };
  }, options);
}

export async function deactivateCustomerSourceLink(sourceSystem, sourceCustomerCode, options = {}) {
  return mutateSourceLink(sourceSystem, sourceCustomerCode, async (link, tx, timestamp) => ({
    link: { ...link, linkStatus: CUSTOMER_SOURCE_LINK_STATUS.INACTIVE, active: false, revision: Number(link.revision || 0) + 1, updatedAt: timestamp },
    eventType: CUSTOMER_SOURCE_LINK_EVENT.DEACTIVATED,
    beforeCustomerId: link.customerId,
    afterCustomerId: link.customerId
  }), options);
}

export async function reactivateCustomerSourceLink(sourceSystem, sourceCustomerCode, options = {}) {
  return mutateSourceLink(sourceSystem, sourceCustomerCode, async (link, tx, timestamp) => ({
    link: { ...link, linkStatus: CUSTOMER_SOURCE_LINK_STATUS.CONFIRMED, active: true, revision: Number(link.revision || 0) + 1, updatedAt: timestamp },
    eventType: CUSTOMER_SOURCE_LINK_EVENT.REACTIVATED,
    beforeCustomerId: link.customerId,
    afterCustomerId: link.customerId
  }), options);
}
