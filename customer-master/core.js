export const APP_ID = 'customer-master';
export const DB_NAME = 'oneapp-customermaster-v1';
export const DB_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 'ONEAPP_CUSTOMER_SNAPSHOT_V1';

export const CUSTOMER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DELETED: 'DELETED',
});

export const CUSTOMER_QUALITY = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  DUPLICATE_CANDIDATE: 'DUPLICATE_CANDIDATE',
  SUPERSEDED: 'SUPERSEDED',
});

export const ACTOR_STATE = Object.freeze({
  VERIFIED: 'VERIFIED',
  LAST_VERIFIED_OFFLINE: 'LAST_VERIFIED_OFFLINE',
  UNVERIFIED_LOCAL: 'UNVERIFIED_LOCAL',
});

export const CUSTOMER_FIELDS = Object.freeze([
  'customerCode', 'customerName', 'representativeName', 'businessNumber', 'businessType',
  'businessItem', 'phone', 'fax', 'mobile', 'email', 'postalCode', 'address',
  'addressDetail', 'contactName', 'contactPhone', 'group1Code', 'group1Name',
  'group2Code', 'group2Name', 'priceGroupCode', 'priceGroup', 'paymentDay',
  'creditLimitAmount', 'creditPeriodDays', 'bankAccountText', 'transferInfo', 'memo',
  'searchText',
  ...Array.from({ length: 10 }, (_, index) => `userText${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, index) => `userNumber${String(index + 1).padStart(2, '0')}`),
]);

export const FIELD_LABELS = Object.freeze({
  customerCode: '기존 거래처코드', customerName: '거래처명', representativeName: '대표자',
  businessNumber: '사업자번호', businessType: '업태', businessItem: '종목', phone: '전화',
  fax: '팩스', mobile: '휴대폰', email: '이메일', postalCode: '우편번호', address: '주소',
  addressDetail: '상세주소', contactName: '담당자', contactPhone: '담당자 연락처',
  group1Code: '그룹1 코드', group1Name: '그룹1', group2Code: '그룹2 코드',
  group2Name: '그룹2', priceGroupCode: '단가그룹 코드', priceGroup: '단가그룹',
  paymentDay: '결제일', creditLimitAmount: '여신한도', creditPeriodDays: '여신기간',
  bankAccountText: '계좌', transferInfo: '이체정보', memo: '적요', searchText: '검색어', status: '사용 상태',
});

export const IMPORT_FIELD_LABELS = Object.freeze({
  sourceCustomerCode: '원본 거래처코드',
  sourceNickname: '원본 별칭',
  sourceSearchText: '원본 검색어',
});

export const IMPORT_ONLY_FIELDS = Object.freeze(Object.keys(IMPORT_FIELD_LABELS));

export const NUMBER_FIELDS = new Set([
  'creditLimitAmount', 'creditPeriodDays',
  ...Array.from({ length: 10 }, (_, index) => `userNumber${String(index + 1).padStart(2, '0')}`),
]);

export const COMPLETENESS_FIELDS = Object.freeze([
  ['customerName', '상호'],
  ['address', '주소'],
  ['mobile', '휴대폰 번호'],
]);

const STANDARD_HEADERS = Object.freeze({
  customerName: ['거래처명', '상호', '이름(거래처명)'],
  representativeName: ['대표자', '대표자명'],
  businessNumber: ['사업자번호', '사업자 등록번호'],
  businessType: ['업태'], businessItem: ['종목'], phone: ['전화', '전화번호'],
  fax: ['팩스', 'FAX', 'Fax'], mobile: ['휴대폰', '휴대폰번호', '핸드폰', '핸드폰번호'],
  email: ['이메일', 'Email', 'E-mail'], postalCode: ['우편번호', '주소1 우편번호'],
  address: ['주소', '주소1', '기본주소'], addressDetail: ['상세주소', '주소2'],
  contactName: ['담당자', '담당자명'], contactPhone: ['담당자연락처', '담당자 연락처', '관리자연락처'],
  group1Code: ['거래처그룹1코드', '그룹1코드'], group1Name: ['그룹', '그룹1', '거래처그룹1'],
  group2Code: ['거래처그룹2코드', '그룹2코드'], group2Name: ['그룹2', '거래처그룹2명'],
  priceGroupCode: ['단가그룹코드', '가격그룹코드'], priceGroup: ['단가그룹', '가격그룹'],
  paymentDay: ['결제일'], creditLimitAmount: ['여신한도', '여신한도금액'],
  creditPeriodDays: ['여신기간', '여신기간(일)'], bankAccountText: ['계좌'],
  transferInfo: ['이체정보'], memo: ['적요', '메모', '비고'], searchText: ['검색창내용', '검색어'],
  status: ['사용구분', '사용여부', '거래상태'],
});

const SOURCE_HEADERS = Object.freeze({
  ERP: Object.freeze({
    sourceCustomerCode: ['거래처코드', '거래처 코드', '코드', '사업자번호(거래처코드)', '사업자번호 (거래처코드)'],
    sourceSearchText: ['검색창내용'],
  }),
  SHOP: Object.freeze({
    sourceCustomerCode: ['아이디', '회원아이디', '회원 ID', '회원ID', '회원번호', '고객아이디'],
    sourceNickname: ['닉네임', '별명'],
  }),
  OTHER: Object.freeze({
    sourceCustomerCode: ['거래처코드', '거래처 코드', '아이디', '회원아이디', '회원번호', '코드'],
    sourceNickname: ['닉네임', '별명'],
  }),
});

export const clean = (value) => String(value ?? '').trim();

export function normalizeText(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
}

export function normalizeHeader(value) {
  return normalizeText(value).replace(/[\s_.\-/()]+/g, '');
}

export function detectImportSourceSystem(headers = []) {
  const normalized = new Set(headers.map(normalizeHeader).filter(Boolean));
  const score = (signals) => signals.reduce((total, [header, weight]) => total + (normalized.has(normalizeHeader(header)) ? weight : 0), 0);
  const erpScore = score([
    ['거래처코드', 5], ['거래처그룹1코드', 2], ['거래처그룹2코드', 2], ['단가그룹', 1], ['사용구분', 1],
  ]);
  const shopScore = score([
    ['아이디', 5], ['회원아이디', 5], ['회원레벨', 2], ['가입일시', 2], ['로그인일시', 1], ['닉네임변경일자', 1],
  ]);
  if (erpScore >= 5 && erpScore > shopScore) return 'ERP';
  if (shopScore >= 5 && shopScore > erpScore) return 'SHOP';
  return '';
}

export function looseCustomerName(value) {
  return normalizeText(value).replace(/주식회사|유한회사|㈜|\(주\)|\s|[()\-_.]/g, '');
}

export function newId(prefix = 'ID') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function normalizeCustomer(input = {}, previous = null, timestamp = new Date().toISOString()) {
  const customerId = clean(input.customerId || previous?.customerId || newId('CU'));
  const customerCode = clean(input.customerCode) || clean(input.erpCustomerCode)
    || clean(previous?.customerCode) || clean(previous?.erpCustomerCode) || customerId;
  const customerName = clean(input.customerName ?? previous?.customerName);
  const status = clean(input.status || previous?.status || CUSTOMER_STATUS.ACTIVE);
  const qualityStatus = clean(input.qualityStatus || previous?.qualityStatus || CUSTOMER_QUALITY.UNVERIFIED);
  const normalized = {
    ...(previous || {}),
    ...input,
    customerId,
    customerCode,
    erpCustomerCode: customerCode,
    customerName,
    normalizedCustomerCode: normalizeText(customerCode),
    normalizedName: normalizeText(customerName),
    looseNormalizedName: looseCustomerName(customerName),
    status,
    qualityStatus,
    canonicalCustomerId: qualityStatus === CUSTOMER_QUALITY.SUPERSEDED
      ? clean(input.canonicalCustomerId || previous?.canonicalCustomerId)
      : customerId,
    revision: Math.max(1, Number(input.revision || previous?.revision || 1)),
    createdAt: previous?.createdAt || input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp,
  };
  CUSTOMER_FIELDS.forEach((field) => {
    if (['customerCode', 'customerName'].includes(field)) return;
    const value = input[field] ?? previous?.[field];
    if (NUMBER_FIELDS.has(field)) {
      const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
      normalized[field] = value === '' || value == null ? '' : (Number.isFinite(parsed) ? parsed : clean(value));
    } else if (field === 'paymentDay') {
      const parsed = Number(value);
      normalized[field] = value === '' || value == null ? '' : (Number.isInteger(parsed) && parsed >= 1 && parsed <= 31 ? parsed : clean(value));
    } else {
      normalized[field] = clean(value);
    }
  });
  if (!Object.values(CUSTOMER_STATUS).includes(normalized.status)) throw new Error('CUSTOMER_STATUS_INVALID');
  if (!Object.values(CUSTOMER_QUALITY).includes(normalized.qualityStatus)) throw new Error('CUSTOMER_QUALITY_INVALID');
  return normalized;
}

export function missingCustomerFields(customer = {}) {
  return COMPLETENESS_FIELDS.filter(([field]) => {
    const value = clean(customer[field]);
    return !value || value === '-' || value === '없음';
  });
}

export function customerDisplayStatus(customer = {}) {
  if (customer.status !== CUSTOMER_STATUS.ACTIVE || customer.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) return 'EXCLUDED';
  if (customer.qualityStatus === CUSTOMER_QUALITY.DUPLICATE_CANDIDATE) return 'DUPLICATE_CANDIDATE';
  return missingCustomerFields(customer).length ? 'INCOMPLETE' : 'COMPLETE';
}

export function scoreCustomer(customer, aliases = [], sourceLinks = [], query = '') {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;
  const looseQuery = looseCustomerName(query);
  const nexusCode = normalizeText(customer.customerId);
  const code = customer.normalizedCustomerCode || normalizeText(customer.customerCode);
  const name = customer.normalizedName || normalizeText(customer.customerName);
  const looseName = customer.looseNormalizedName || looseCustomerName(customer.customerName);
  const aliasValues = aliases.filter((row) => row.customerId === customer.customerId && row.active !== false)
    .map((row) => row.normalizedAlias || row.normalizedText || normalizeText(row.alias));
  const sourceValues = sourceLinks.filter((row) => row.customerId === customer.customerId && row.active !== false)
    .flatMap((row) => [row.sourceCustomerCode, row.sourceCustomerName, row.sourceNickname, row.sourceSearchText])
    .map(normalizeText).filter(Boolean);
  const fieldValues = CUSTOMER_FIELDS.filter((field) => !['customerCode', 'customerName'].includes(field))
    .map((field) => normalizeText(customer[field])).filter(Boolean);
  if (nexusCode && nexusCode === normalizedQuery) return { score: 1000, matchMethod: 'NEXUS_CODE_EXACT' };
  if (code && code === normalizedQuery) return { score: 990, matchMethod: 'LEGACY_CODE_EXACT' };
  if (sourceValues.includes(normalizedQuery)) return { score: 975, matchMethod: 'SOURCE_EXACT' };
  if (name && name === normalizedQuery) return { score: 950, matchMethod: 'NAME_EXACT' };
  if (aliasValues.includes(normalizedQuery)) return { score: 925, matchMethod: 'ALIAS_EXACT' };
  if (fieldValues.includes(normalizedQuery)) return { score: 900, matchMethod: 'FIELD_EXACT' };
  if (looseName && looseName === looseQuery) return { score: 875, matchMethod: 'LOOSE_EXACT' };
  if (name && (name.includes(normalizedQuery) || normalizedQuery.includes(name))) return { score: 700, matchMethod: 'NAME_PARTIAL' };
  if (aliasValues.some((value) => value.includes(normalizedQuery) || normalizedQuery.includes(value))) return { score: 650, matchMethod: 'ALIAS_PARTIAL' };
  if (sourceValues.some((value) => value.includes(normalizedQuery) || normalizedQuery.includes(value))) return { score: 625, matchMethod: 'SOURCE_PARTIAL' };
  if (fieldValues.some((value) => value.includes(normalizedQuery) || normalizedQuery.includes(value))) return { score: 600, matchMethod: 'FIELD_PARTIAL' };
  return null;
}

export function resolveCanonicalCustomerId(customerId, customers = []) {
  const byId = customers instanceof Map ? customers : new Map(customers.map((customer) => [customer.customerId, customer]));
  let currentId = clean(customerId);
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const customer = byId.get(currentId);
    if (!customer || customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED) return currentId;
    const nextId = clean(customer.canonicalCustomerId);
    if (!nextId || nextId === currentId) return currentId;
    currentId = nextId;
  }
  return clean(customerId);
}

export function searchCustomerRows(customers, aliases, sourceLinks, query, limit = 200) {
  const byId = new Map(customers.map((customer) => [customer.customerId, customer]));
  if (!clean(query)) return customers.filter((customer) => customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED)
    .slice().sort((a, b) => clean(a.customerName).localeCompare(clean(b.customerName), 'ko')).slice(0, limit);
  const rankedByCanonicalId = new Map();
  customers.forEach((customer) => {
    const match = scoreCustomer(customer, aliases, sourceLinks, query);
    if (!match) return;
    const canonicalId = resolveCanonicalCustomerId(customer.customerId, byId);
    const canonical = byId.get(canonicalId) || customer;
    const previous = rankedByCanonicalId.get(canonical.customerId);
    if (!previous || match.score > previous.match.score) rankedByCanonicalId.set(canonical.customerId, { customer: canonical, match });
  });
  return [...rankedByCanonicalId.values()]
    .sort((left, right) => right.match.score - left.match.score || clean(left.customer.customerName).localeCompare(clean(right.customer.customerName), 'ko'))
    .slice(0, limit).map((row) => row.customer);
}

export function defaultHeaderMapping(headers = [], storedMappings = [], userFieldDefinitions = [], sourceSystem = 'ERP') {
  const lookup = new Map();
  Object.entries(STANDARD_HEADERS).forEach(([fieldKey, aliases]) => aliases.forEach((alias) => {
    lookup.set(normalizeHeader(alias), { fieldKey, fieldType: NUMBER_FIELDS.has(fieldKey) ? 'NUMBER' : 'TEXT', source: 'STANDARD' });
  }));
  const system = clean(sourceSystem).toUpperCase() || 'OTHER';
  Object.entries(SOURCE_HEADERS[system] || SOURCE_HEADERS.OTHER).forEach(([fieldKey, aliases]) => aliases.forEach((alias) => {
    lookup.set(normalizeHeader(alias), { fieldKey, fieldType: 'TEXT', source: 'SOURCE' });
  }));
  storedMappings.filter((row) => row.enabled !== false && clean(row.sourceSystem).toUpperCase() === clean(sourceSystem).toUpperCase())
    .forEach((row) => lookup.set(row.normalizedHeader, {
      fieldKey: row.targetFieldKey === 'customerCode' ? 'sourceCustomerCode' : row.targetFieldKey,
      fieldType: row.targetType || 'TEXT', source: 'SAVED',
    }));
  userFieldDefinitions.filter((row) => row.enabled && clean(row.displayName)).forEach((row) => {
    [row.displayName, ...(row.headerAliases || [])].forEach((alias) => lookup.set(normalizeHeader(alias), {
      fieldKey: row.fieldKey, fieldType: row.fieldType, source: 'USER',
    }));
  });
  const used = new Set();
  return headers.map((header, index) => {
    const target = lookup.get(normalizeHeader(header));
    if (!target || used.has(target.fieldKey)) return { index, header, targetFieldKey: '', fieldType: 'TEXT', source: 'UNMATCHED' };
    used.add(target.fieldKey);
    return { index, header, targetFieldKey: target.fieldKey, fieldType: target.fieldType, source: target.source };
  });
}

export function isCustomerSystemRow(rawRow = {}) {
  const values = Object.values(rawRow).map(clean).filter(Boolean);
  if (!values.length) return false;
  const joined = values.join(' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /^(합계|총계|소계|페이지|page\s*\d+|출력일시|조회기간)(\s|:|：|$)/i.test(joined) || /^[-=_]{3,}$/.test(joined);
}

export function mappedImportRow(rawRow, mapping) {
  const values = {};
  const sourceValues = {};
  const fieldExclusions = [];
  const unmatchedValues = {};
  mapping.forEach((entry) => {
    const rawValue = rawRow?.[entry.header];
    if (!entry.targetFieldKey) {
      if (clean(rawValue)) unmatchedValues[entry.header] = rawValue;
      return;
    }
    if (rawValue === undefined || rawValue === null || clean(rawValue) === '') return;
    if (IMPORT_ONLY_FIELDS.includes(entry.targetFieldKey)) {
      sourceValues[entry.targetFieldKey] = rawValue === 0 ? 0 : String(rawValue);
      return;
    }
    if (entry.targetFieldKey === 'status') {
      const normalized = normalizeText(rawValue);
      if (/^(yes|y|1|사용|사용중|정상|active)$/.test(normalized)) values.status = CUSTOMER_STATUS.ACTIVE;
      else if (/^(no|n|0|미사용|중단|거래중단|inactive)$/.test(normalized)) values.status = CUSTOMER_STATUS.INACTIVE;
      else fieldExclusions.push({ fieldKey: 'status', header: entry.header, rawValue, reasonCode: 'STATUS_FIELD_PARSE_FAILED' });
      return;
    }
    if (entry.fieldType === 'NUMBER' || NUMBER_FIELDS.has(entry.targetFieldKey)) {
      const parsed = Number(String(rawValue).replace(/,/g, '').trim());
      if (!Number.isFinite(parsed)) {
        fieldExclusions.push({ fieldKey: entry.targetFieldKey, header: entry.header, rawValue, reasonCode: 'NUMBER_FIELD_PARSE_FAILED' });
        return;
      }
      values[entry.targetFieldKey] = parsed;
      return;
    }
    values[entry.targetFieldKey] = rawValue === 0 ? 0 : String(rawValue);
  });
  return { values, sourceValues, fieldExclusions, unmatchedValues };
}

function uniqueIndex(rows, valueForRow) {
  const index = new Map();
  rows.forEach((row) => {
    const value = valueForRow(row);
    if (!value) return;
    index.set(value, [...(index.get(value) || []), row]);
  });
  return index;
}

function shopLinkIndexes(existingCustomers) {
  return {
    business: uniqueIndex(existingCustomers, (row) => clean(row.businessNumber).replace(/\D/g, '')),
    mobile: uniqueIndex(existingCustomers, (row) => clean(row.mobile).replace(/\D/g, '')),
    email: uniqueIndex(existingCustomers, (row) => normalizeText(row.email)),
    name: uniqueIndex(existingCustomers, (row) => looseCustomerName(row.customerName)),
  };
}

function shopLinkCandidate(values, indexes) {
  const businessNumber = clean(values.businessNumber).replace(/\D/g, '');
  const mobile = clean(values.mobile).replace(/\D/g, '');
  const email = normalizeText(values.email);
  const name = looseCustomerName(values.customerName);
  const unique = (index, key) => key && index.get(key)?.length === 1 ? index.get(key)[0] : null;
  const businessMatch = businessNumber.length >= 10 ? unique(indexes.business, businessNumber) : null;
  if (businessMatch) return { customer: businessMatch, matchMethod: 'BUSINESS_NUMBER_EXACT', review: false };
  const mobileMatch = mobile.length >= 9 ? unique(indexes.mobile, mobile) : null;
  if (mobileMatch && name && looseCustomerName(mobileMatch.customerName) === name) return { customer: mobileMatch, matchMethod: 'NAME_MOBILE_EXACT', review: false };
  const emailMatch = email ? unique(indexes.email, email) : null;
  if (emailMatch && name && looseCustomerName(emailMatch.customerName) === name) return { customer: emailMatch, matchMethod: 'NAME_EMAIL_EXACT', review: false };
  const nameMatches = name ? (indexes.name.get(name) || []) : [];
  if (nameMatches.length) return { customer: nameMatches[0], candidateCustomerIds: nameMatches.map((row) => row.customerId), matchMethod: 'NAME_REVIEW', review: true };
  return null;
}

export function analyzeImportRows(rows = [], mapping = [], existingCustomers = [], options = {}) {
  const sourceSystem = clean(options.sourceSystem || 'ERP').toUpperCase();
  const rowNumbers = Array.isArray(options.rowNumbers) ? options.rowNumbers : [];
  const sourceLinks = Array.isArray(options.sourceLinks) ? options.sourceLinks : [];
  const codeCounts = new Map();
  const prepared = rows.map((rawRow, index) => {
    const rowNo = Number(rowNumbers[index] || index + 2);
    if (Object.values(rawRow || {}).every((value) => clean(value) === '')) return { rowNo, rawRow, resultType: 'EMPTY_ROW_EXCLUDED' };
    if (isCustomerSystemRow(rawRow)) return { rowNo, rawRow, resultType: 'SYSTEM_ROW_EXCLUDED' };
    const mapped = mappedImportRow(rawRow, mapping);
    mapped.sourceValues.sourceCustomerName = clean(mapped.values.customerName);
    const normalizedCode = normalizeText(mapped.sourceValues.sourceCustomerCode);
    if (normalizedCode) codeCounts.set(normalizedCode, (codeCounts.get(normalizedCode) || 0) + 1);
    return { rowNo, rawRow, ...mapped, sourceSystem, normalizedCode, resultType: 'PENDING' };
  });
  const byCode = new Map();
  existingCustomers.forEach((customer) => {
    const code = customer.normalizedCustomerCode || normalizeText(customer.customerCode);
    if (!code) return;
    byCode.set(code, [...(byCode.get(code) || []), customer]);
  });
  const customerById = new Map(existingCustomers.map((customer) => [customer.customerId, customer]));
  const shopIndexes = sourceSystem === 'SHOP' ? shopLinkIndexes(existingCustomers) : null;
  const sourceLinkByCode = new Map(sourceLinks.filter((row) => row.active !== false && clean(row.sourceSystem).toUpperCase() === sourceSystem)
    .map((row) => [normalizeText(row.sourceCustomerCode), row]));
  return prepared.map((record) => {
    if (record.resultType !== 'PENDING') return record;
    if (!record.normalizedCode) return { ...record, resultType: 'FAILED', reasonCode: 'SOURCE_CODE_MISSING' };
    if ((codeCounts.get(record.normalizedCode) || 0) > 1) return { ...record, resultType: 'FAILED', reasonCode: 'DUPLICATE_SOURCE_CODE_IN_IMPORT' };
    const linked = sourceLinkByCode.get(record.normalizedCode);
    let existing = linked ? customerById.get(linked.customerId) : null;
    let matchMethod = linked ? 'SOURCE_LINK_EXACT' : '';
    let linking = false;
    if (linked && !existing) return { ...record, resultType: 'FAILED', reasonCode: 'SOURCE_LINK_CUSTOMER_MISSING' };
    if (!existing && sourceSystem === 'ERP') {
      const legacyMatches = byCode.get(record.normalizedCode) || [];
      if (legacyMatches.length > 1) return { ...record, resultType: 'FAILED', reasonCode: 'DUPLICATE_LEGACY_CODE_IN_DB' };
      existing = legacyMatches[0] || null;
      if (existing) { matchMethod = 'LEGACY_ERP_CODE_EXACT'; linking = true; }
    }
    if (!existing && sourceSystem === 'SHOP') {
      const candidate = shopLinkCandidate(record.values, shopIndexes);
      if (candidate?.review) return {
        ...record, resultType: 'LINK_REVIEW', reasonCode: 'NAME_ONLY_MATCH_REQUIRES_REVIEW',
        candidateCustomerIds: candidate.candidateCustomerIds, matchMethod: candidate.matchMethod,
        reviewValues: { ...record.values },
      };
      if (candidate?.customer) { existing = candidate.customer; matchMethod = candidate.matchMethod; linking = true; }
    }
    const effectiveValues = existing && sourceSystem === 'SHOP'
      ? Object.fromEntries(Object.entries(record.values).filter(([field]) => !clean(existing[field])))
      : record.values;
    const changedFields = existing ? Object.keys(effectiveValues).filter((field) => {
      const incoming = effectiveValues[field];
      if (incoming !== 0 && clean(incoming) === '') return false;
      return String(existing[field] ?? '') !== String(incoming ?? '');
    }) : Object.keys(effectiveValues);
    const sourceMetadataChanged = linked && [
      ['sourceCustomerName', record.sourceValues.sourceCustomerName],
      ['sourceNickname', record.sourceValues.sourceNickname],
      ['sourceSearchText', record.sourceValues.sourceSearchText],
    ].some(([field, incoming]) => clean(incoming) && clean(linked[field]) !== clean(incoming));
    return {
      ...record,
      values: effectiveValues,
      existingCustomerId: existing?.customerId || '',
      expectedRevision: existing?.revision || 0,
      changedFields,
      matchMethod,
      resultType: existing ? (linking ? 'READY_LINK' : (changedFields.length || sourceMetadataChanged ? 'READY_UPDATE' : 'UNCHANGED')) : 'READY_CREATE',
    };
  });
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableStringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function tabularRows(matrix = []) {
  const indexedRows = matrix.map((values, index) => ({ rowNumber: index + 1, values: Array.from(values || []) }))
    .filter((row) => row.values.some((value) => clean(value) !== ''));
  if (!indexedRows.length) return { headerRowNumber: 1, headers: [], rows: [], rowNumbers: [] };
  const knownHeaders = new Set([
    ...Object.values(STANDARD_HEADERS).flat(),
    ...Object.values(SOURCE_HEADERS).flatMap((fields) => Object.values(fields).flat()),
  ].map(normalizeHeader));
  const candidates = indexedRows.slice(0, 30).map((row) => {
    const recognized = new Set(row.values.map(normalizeHeader).filter((value) => knownHeaders.has(value)));
    const nonempty = row.values.filter((value) => clean(value) !== '').length;
    return { ...row, recognized: recognized.size, score: (recognized.size * 100) + nonempty };
  });
  const best = candidates.slice().sort((left, right) => right.score - left.score || left.rowNumber - right.rowNumber)[0];
  const headerRow = best.recognized >= 2 ? best : indexedRows[0];
  const seen = new Map();
  const headers = headerRow.values.map((value, index) => {
    const base = clean(value) || `열 ${index + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const dataRows = indexedRows.filter((row) => row.rowNumber > headerRow.rowNumber);
  return {
    headerRowNumber: headerRow.rowNumber,
    headers,
    rowNumbers: dataRows.map((row) => row.rowNumber),
    rows: dataRows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row.values[index] ?? '']))),
  };
}

export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) { row.push(cell); cell = ''; }
    else if (character === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += character;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return tabularRows(rows);
}
