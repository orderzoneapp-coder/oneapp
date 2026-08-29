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
  customerCode: '거래처코드', customerName: '거래처명', representativeName: '대표자',
  businessNumber: '사업자번호', businessType: '업태', businessItem: '종목', phone: '전화',
  fax: '팩스', mobile: '휴대폰', email: '이메일', postalCode: '우편번호', address: '주소',
  addressDetail: '상세주소', contactName: '담당자', contactPhone: '담당자 연락처',
  group1Code: '그룹1 코드', group1Name: '그룹1', group2Code: '그룹2 코드',
  group2Name: '그룹2', priceGroupCode: '단가그룹 코드', priceGroup: '단가그룹',
  paymentDay: '결제일', creditLimitAmount: '여신한도', creditPeriodDays: '여신기간',
  bankAccountText: '계좌', transferInfo: '이체정보', memo: '적요', searchText: '검색어',
});

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
  customerCode: ['거래처코드', '거래처 코드', '코드', '사업자번호(거래처코드)', '사업자번호 (거래처코드)'],
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
});

export const clean = (value) => String(value ?? '').trim();

export function normalizeText(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
}

export function normalizeHeader(value) {
  return normalizeText(value).replace(/[\s_.\-/()]+/g, '');
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
  const customerCode = clean(input.customerCode ?? input.erpCustomerCode ?? previous?.customerCode ?? previous?.erpCustomerCode);
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
  if (code && code === normalizedQuery) return { score: 1000, matchMethod: 'CODE_EXACT' };
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

export function searchCustomerRows(customers, aliases, sourceLinks, query, limit = 200) {
  if (!clean(query)) return customers.slice().sort((a, b) => clean(a.customerName).localeCompare(clean(b.customerName), 'ko')).slice(0, limit);
  return customers.map((customer) => ({ customer, match: scoreCustomer(customer, aliases, sourceLinks, query) }))
    .filter((row) => row.match)
    .sort((left, right) => right.match.score - left.match.score || clean(left.customer.customerName).localeCompare(clean(right.customer.customerName), 'ko'))
    .slice(0, limit).map((row) => row.customer);
}

export function defaultHeaderMapping(headers = [], storedMappings = [], userFieldDefinitions = [], sourceSystem = 'ERP') {
  const lookup = new Map();
  Object.entries(STANDARD_HEADERS).forEach(([fieldKey, aliases]) => aliases.forEach((alias) => {
    lookup.set(normalizeHeader(alias), { fieldKey, fieldType: NUMBER_FIELDS.has(fieldKey) ? 'NUMBER' : 'TEXT', source: 'STANDARD' });
  }));
  storedMappings.filter((row) => row.enabled !== false && clean(row.sourceSystem).toUpperCase() === clean(sourceSystem).toUpperCase())
    .forEach((row) => lookup.set(row.normalizedHeader, { fieldKey: row.targetFieldKey, fieldType: row.targetType || 'TEXT', source: 'SAVED' }));
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
  const fieldExclusions = [];
  const unmatchedValues = {};
  mapping.forEach((entry) => {
    const rawValue = rawRow?.[entry.header];
    if (!entry.targetFieldKey) {
      if (clean(rawValue)) unmatchedValues[entry.header] = rawValue;
      return;
    }
    if (rawValue === undefined || rawValue === null || clean(rawValue) === '') return;
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
  return { values, fieldExclusions, unmatchedValues };
}

export function analyzeImportRows(rows = [], mapping = [], existingCustomers = []) {
  const codeCounts = new Map();
  const prepared = rows.map((rawRow, index) => {
    if (Object.values(rawRow || {}).every((value) => clean(value) === '')) return { rowNo: index + 2, rawRow, resultType: 'EMPTY_ROW_EXCLUDED' };
    if (isCustomerSystemRow(rawRow)) return { rowNo: index + 2, rawRow, resultType: 'SYSTEM_ROW_EXCLUDED' };
    const mapped = mappedImportRow(rawRow, mapping);
    const normalizedCode = normalizeText(mapped.values.customerCode);
    if (normalizedCode) codeCounts.set(normalizedCode, (codeCounts.get(normalizedCode) || 0) + 1);
    return { rowNo: index + 2, rawRow, ...mapped, normalizedCode, resultType: 'PENDING' };
  });
  const byCode = new Map();
  existingCustomers.forEach((customer) => {
    const code = customer.normalizedCustomerCode || normalizeText(customer.customerCode);
    if (!code) return;
    byCode.set(code, [...(byCode.get(code) || []), customer]);
  });
  return prepared.map((record) => {
    if (record.resultType !== 'PENDING') return record;
    if (!record.normalizedCode) return { ...record, resultType: 'FAILED', reasonCode: 'CUSTOMER_CODE_MISSING' };
    if ((codeCounts.get(record.normalizedCode) || 0) > 1) return { ...record, resultType: 'FAILED', reasonCode: 'DUPLICATE_CODE_IN_IMPORT' };
    const matches = byCode.get(record.normalizedCode) || [];
    if (matches.length > 1) return { ...record, resultType: 'FAILED', reasonCode: 'DUPLICATE_CUSTOMER_CODE_IN_DB' };
    const existing = matches[0] || null;
    const changedFields = existing ? Object.keys(record.values).filter((field) => {
      const incoming = record.values[field];
      if (incoming !== 0 && clean(incoming) === '') return false;
      return String(existing[field] ?? '') !== String(incoming ?? '');
    }) : Object.keys(record.values);
    return {
      ...record,
      existingCustomerId: existing?.customerId || '',
      expectedRevision: existing?.revision || 0,
      changedFields,
      resultType: existing ? (changedFields.length ? 'READY_UPDATE' : 'UNCHANGED') : 'READY_CREATE',
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
  const headers = (rows.shift() || []).map((value, index) => clean(value) || `열 ${index + 1}`);
  return { headers, rows: rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))) };
}
