/**
 * NEXUS Foundation metadata V1.
 * This Apps Script module is deployed with code.gs in the ONEAPP upstream project.
 * It owns only field, mapping-set, header-mapping and migration metadata.
 */

const FOUNDATION_METADATA_SCHEMA_VERSION = 'FOUNDATION_METADATA_V1';
const FOUNDATION_METADATA_HEAD_SHEET = 'FoundationMetadataHead_NEXUS';
const FOUNDATION_METADATA_SNAPSHOT_SHEET = 'FoundationMetadataSnapshot_NEXUS';
const FOUNDATION_METADATA_CHUNK_SIZE = 45000;
const FOUNDATION_METADATA_MAX_AUDIT = 1000;
const FOUNDATION_METADATA_MAX_IDEMPOTENCY = 100;

function foundationMetadataText(value) {
  return String(value == null ? '' : value).trim();
}

function foundationMetadataClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function foundationMetadataCanonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(foundationMetadataCanonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + foundationMetadataCanonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function foundationMetadataHash(value) {
  const source = typeof value === 'string' ? value : foundationMetadataCanonical(value);
  if (typeof sha256Hex === 'function') return sha256Hex(source);
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8);
  return digest.map(value => (value < 0 ? value + 256 : value).toString(16).padStart(2, '0')).join('');
}

function foundationMetadataNormalizeHeader(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s_.\-\/()]+/gu, '');
}

function foundationMetadataRequirements(createRequired, batchIdentifier, completenessRequired) {
  return {
    createRequired: createRequired === true,
    batchIdentifier: batchIdentifier === true,
    completenessRequired: completenessRequired === true
  };
}

function foundationMetadataField(entityType, fieldId, displayName, storageKey, dataType, options) {
  const source = options || {};
  const requirements = source.requirements || foundationMetadataRequirements(false, false, false);
  return {
    entityType,
    fieldId,
    displayName,
    storageKey,
    writeMirrorKeys: (source.writeMirrorKeys || []).slice(),
    legacyAliases: (source.legacyAliases || []).slice(),
    dataType,
    enumValues: (source.enumValues || []).slice(),
    requirements,
    defaultValue: source.defaultValue === undefined ? null : source.defaultValue,
    protectedFromDisable: Object.values(requirements).some(Boolean),
    enabled: source.enabled !== false,
    sortOrder: Number(source.sortOrder || 0),
    systemField: source.systemField !== false,
    recordRevision: 1,
    updatedAt: source.updatedAt || ''
  };
}

function foundationMetadataProductFields() {
  const rows = [
    ['product.code', '상품코드', '코드', 'TEXT', { writeMirrorKeys: ['품목코드'], legacyAliases: ['코드', '품목코드', '상품코드', '상품번호'], requirements: foundationMetadataRequirements(true, true, false) }],
    ['product.name', '상품명', '품목명', 'TEXT', { legacyAliases: ['품목명', '상품명', '품명'], requirements: foundationMetadataRequirements(true, false, false) }],
    ['product.spec', '규격', '규격', 'TEXT', { legacyAliases: ['규격', '규격명'], requirements: foundationMetadataRequirements(true, false, false) }],
    ['product.unit', '단위', '단위', 'TEXT', { legacyAliases: ['단위'], requirements: foundationMetadataRequirements(true, false, false) }],
    ['product.group1.code', '상품그룹1 코드', '1코드', 'TEXT', { legacyAliases: ['1코드', '상품그룹1코드'] }],
    ['product.group1.name', '상품그룹1명', '1그룹명', 'TEXT', { legacyAliases: ['1그룹명', '상품그룹1명', '카테고리'] }],
    ['product.group2.code', '상품그룹2 코드', '2코드', 'TEXT', { legacyAliases: ['2코드', '상품그룹2코드'] }],
    ['product.group2.name', '상품그룹2명', '2그룹명', 'TEXT', { legacyAliases: ['2그룹명', '상품그룹2명'] }],
    ['product.group3.code', '상품그룹3 코드', '3코드', 'TEXT', { legacyAliases: ['3코드', '상품그룹3코드'] }],
    ['product.group3.name', '상품그룹3명', '3그룹명', 'TEXT', { legacyAliases: ['3그룹명', '상품그룹3명', '그룹'] }],
    ['product.brand', '브랜드', '브랜드', 'TEXT', { legacyAliases: ['브랜드'] }],
    ['product.safety_stock', '안전재고', '안전재고', 'NUMBER', { legacyAliases: ['안전재고'] }],
    ['product.base_price', '기준단가', '입고가', 'NUMBER', { legacyAliases: ['입고가', '기준단가'] }],
    ['product.outsourcing_cost', '외주비', '외주비', 'NUMBER', { legacyAliases: ['외주비'] }],
    ['product.labor_cost', '노무비', '노무비', 'NUMBER', { legacyAliases: ['노무비'] }],
    ['product.expense', '경비', '경비', 'NUMBER', { legacyAliases: ['경비'] }],
    ['product.tax_type', '부가세 구분', '비과세', 'ENUM', { legacyAliases: ['비과세', '부가세구분', '부가세여부'], enumValues: ['0', '1'] }],
    ['product.short_description', '간단 설명', '간단설명', 'TEXT', { legacyAliases: ['간단설명', '간단 설명'] }],
    ['product.search_keywords', '검색어', '검색어등록', 'TEXT', { legacyAliases: ['검색어등록', '검색어'] }],
    ['product.lead_time_days', '준비기간', '준비기간', 'INTEGER', { legacyAliases: ['준비기간'] }],
    ['product.closing_time', '마감시간', '마감시간', 'TIME', { legacyAliases: ['마감시간'] }],
    ['product.status', '사용 상태', '판매여부', 'ENUM', { legacyAliases: ['판매여부', '사용상태', '판매상태'], enumValues: ['1', '0'], defaultValue: '1' }]
  ];
  return rows.map((row, index) => foundationMetadataField('PRODUCT', row[0], row[1], row[2], row[3], Object.assign({ sortOrder: (index + 1) * 10 }, row[4])));
}

function foundationMetadataCustomerFields() {
  const rows = [
    ['customer.code', '거래처코드', 'customerCode', 'TEXT', { writeMirrorKeys: ['erpCustomerCode'], legacyAliases: ['거래처코드', '코드', '사업자번호 (거래처코드)', '사업자번호(거래처코드)'], requirements: foundationMetadataRequirements(false, true, false) }],
    ['customer.name', '거래처명', 'customerName', 'TEXT', { legacyAliases: ['거래처명', '이름(거래처명)'], requirements: foundationMetadataRequirements(true, false, true) }],
    ['customer.representative_name', '대표자명', 'representativeName', 'TEXT', { legacyAliases: ['대표자명', '대표자'] }],
    ['customer.business_number', '사업자등록번호', 'businessNumber', 'TEXT', { legacyAliases: ['사업자등록번호', '사업자번호'] }],
    ['customer.business_type', '업태', 'businessType', 'TEXT', { legacyAliases: ['업태'] }],
    ['customer.business_item', '종목', 'businessItem', 'TEXT', { legacyAliases: ['종목'] }],
    ['customer.phone', '전화번호', 'phone', 'TEXT', { legacyAliases: ['전화', '전화번호'] }],
    ['customer.mobile', '휴대폰 번호', 'mobile', 'TEXT', { legacyAliases: ['핸드폰번호', '휴대폰번호', '핸드폰', '휴대폰'], requirements: foundationMetadataRequirements(false, false, true) }],
    ['customer.fax', '팩스', 'fax', 'TEXT', { legacyAliases: ['Fax', 'FAX', '팩스'] }],
    ['customer.email', '이메일', 'email', 'TEXT', { legacyAliases: ['Email', '이메일', 'E-mail'] }],
    ['customer.postal_code', '우편번호', 'postalCode', 'TEXT', { legacyAliases: ['우편번호', '주소1 우편번호'] }],
    ['customer.address', '기본주소', 'address', 'TEXT', { legacyAliases: ['주소1', '기본주소', '주소'], requirements: foundationMetadataRequirements(false, false, true) }],
    ['customer.address_detail', '상세주소', 'addressDetail', 'TEXT', { legacyAliases: ['상세주소'] }],
    ['customer.contact_name', '담당자명', 'contactName', 'TEXT', { legacyAliases: ['담당자명', '담당자'] }],
    ['customer.contact_phone', '담당자 연락처', 'contactPhone', 'TEXT', { legacyAliases: ['담당자연락처', '관리자연락처'] }],
    ['customer.group1.code', '거래처그룹1 코드', 'group1Code', 'TEXT', { legacyAliases: ['거래처그룹1코드'] }],
    ['customer.group1.name', '거래처그룹1명', 'group1Name', 'TEXT', { legacyAliases: ['그룹1', '거래처그룹1', '그룹'] }],
    ['customer.group2.code', '거래처그룹2 코드', 'group2Code', 'TEXT', { legacyAliases: ['거래처그룹2코드'] }],
    ['customer.group2.name', '거래처그룹2명', 'group2Name', 'TEXT', { legacyAliases: ['거래처그룹2명'] }],
    ['customer.price_group.code', '단가그룹코드', 'priceGroupCode', 'TEXT', { legacyAliases: ['단가그룹코드', '가격그룹코드'] }],
    ['customer.price_group.name', '단가그룹명', 'priceGroup', 'TEXT', { legacyAliases: ['단가그룹', '가격그룹'] }],
    ['customer.payment_day', '결제일', 'paymentDay', 'INTEGER', { legacyAliases: ['결제일'] }],
    ['customer.credit_limit_amount', '여신한도금액', 'creditLimitAmount', 'NUMBER', { legacyAliases: ['여신한도금액', '신용한도', '여신한도'] }],
    ['customer.credit_period_days', '여신기간(일)', 'creditPeriodDays', 'INTEGER', { legacyAliases: ['여신기간(일)', '여신기간', '신용기간'] }],
    ['customer.bank_account', '계좌', 'bankAccountText', 'TEXT', { legacyAliases: ['계좌'] }],
    ['customer.transfer_info', '이체정보', 'transferInfo', 'TEXT', { legacyAliases: ['이체정보'] }],
    ['customer.memo', '적요', 'memo', 'TEXT', { legacyAliases: ['적요', '메모', '비고'] }],
    ['customer.search_keywords', '검색어', 'searchText', 'TEXT', { legacyAliases: ['검색창내용', '검색어'] }],
    ['customer.status', '사용 상태', 'status', 'ENUM', { legacyAliases: ['사용상태', '상태'], enumValues: ['ACTIVE', 'INACTIVE', 'DELETED'], defaultValue: 'ACTIVE' }]
  ];
  return rows.map((row, index) => foundationMetadataField('CUSTOMER', row[0], row[1], row[2], row[3], Object.assign({ sortOrder: (index + 1) * 10 }, row[4])));
}

function foundationMetadataCustomFields() {
  const result = [];
  for (let index = 1; index <= 10; index += 1) {
    const suffix = String(index).padStart(2, '0');
    result.push(foundationMetadataField('CUSTOMER', `customer.custom.text${suffix}`, '', `userText${suffix}`, 'TEXT', {
      enabled: false, systemField: false, sortOrder: 300 + index * 10
    }));
  }
  for (let index = 1; index <= 10; index += 1) {
    const suffix = String(index).padStart(2, '0');
    result.push(foundationMetadataField('CUSTOMER', `customer.custom.number${suffix}`, '', `userNumber${suffix}`, 'NUMBER', {
      enabled: false, systemField: false, sortOrder: 400 + index * 10
    }));
  }
  return result;
}

function foundationMetadataValidateAliases(fields) {
  ['PRODUCT', 'CUSTOMER'].forEach(entityType => {
    const lookup = {};
    fields.filter(field => field.entityType === entityType).forEach(field => {
      [field.displayName].concat(field.legacyAliases || []).filter(Boolean).forEach(alias => {
        const normalized = foundationMetadataNormalizeHeader(alias);
        if (!normalized) return;
        if (lookup[normalized] && lookup[normalized] !== field.fieldId) throw new Error('MAPPING_ALIAS_AMBIGUOUS');
        lookup[normalized] = field.fieldId;
      });
    });
  });
  return true;
}

function foundationMetadataCreateSeed(companyId, now) {
  const timestamp = foundationMetadataText(now) || new Date().toISOString();
  const fields = foundationMetadataProductFields().concat(foundationMetadataCustomerFields(), foundationMetadataCustomFields());
  fields.forEach(field => { field.updatedAt = timestamp; });
  foundationMetadataValidateAliases(fields);
  return {
    schemaVersion: FOUNDATION_METADATA_SCHEMA_VERSION,
    companyId: foundationMetadataText(companyId),
    metadataRevision: 1,
    fields,
    mappingSets: [],
    mappings: [],
    migrationState: { customerLegacy: { status: 'NOT_STARTED' } },
    audit: [],
    idempotency: [],
    updatedAt: timestamp
  };
}

function foundationMetadataMergeMissingSystemFields(snapshot, now) {
  const timestamp = foundationMetadataText(now) || new Date().toISOString();
  const codeSeed = foundationMetadataCreateSeed(snapshot.companyId, timestamp);
  const existing = new Set((snapshot.fields || []).map(field => `${field.entityType}:${field.fieldId}`));
  const missing = codeSeed.fields.filter(field => field.systemField && !existing.has(`${field.entityType}:${field.fieldId}`));
  if (!missing.length) return { snapshot, changed: false, addedFieldIds: [] };
  const merged = foundationMetadataClone(snapshot);
  merged.fields = (merged.fields || []).concat(missing);
  foundationMetadataValidateState(merged);
  merged.metadataRevision = Number(snapshot.metadataRevision || 0) + 1;
  merged.updatedAt = timestamp;
  return { snapshot: merged, changed: true, addedFieldIds: missing.map(field => field.fieldId) };
}

function foundationMetadataRequireEntity(value) {
  const entityType = foundationMetadataText(value).toUpperCase();
  if (!['PRODUCT', 'CUSTOMER'].includes(entityType)) throw new Error('FOUNDATION_METADATA_ENTITY_INVALID');
  return entityType;
}

function foundationMetadataFindField(snapshot, entityType, fieldId) {
  return snapshot.fields.find(field => field.entityType === entityType && field.fieldId === fieldId) || null;
}

function foundationMetadataAudit(actor, revision, requestId, change, before, after, now, targetId) {
  const request = actor && actor.nexusRequest || {};
  return {
    auditId: 'FA-' + Utilities.getUuid(),
    metadataRevision: revision,
    requestId,
    changeId: foundationMetadataText(change.changeId),
    operation: foundationMetadataText(change.op),
    entityType: foundationMetadataText(change.entityType || after && after.entityType || before && before.entityType),
    targetId: foundationMetadataText(targetId),
    before: before == null ? null : foundationMetadataClone(before),
    after: after == null ? null : foundationMetadataClone(after),
    subjectUserId: foundationMetadataText(request.subjectUserId),
    loginId: foundationMetadataText(request.subjectLoginId),
    credentialId: foundationMetadataText(actor && actor.credentialId),
    timestamp: now
  };
}

function foundationMetadataValidateState(snapshot) {
  const fieldKeys = new Set();
  snapshot.fields.forEach(field => {
    const key = `${field.entityType}:${field.fieldId}`;
    if (fieldKeys.has(key)) throw new Error('FIELD_ID_DUPLICATE');
    fieldKeys.add(key);
  });
  foundationMetadataValidateAliases(snapshot.fields);
  const setIds = new Set(snapshot.mappingSets.map(set => set.mappingSetId));
  const defaultKeys = new Set();
  snapshot.mappingSets.filter(set => set.enabled && set.isDefault).forEach(set => {
    const key = `${set.entityType}:${set.sourceSystem}`;
    if (defaultKeys.has(key)) throw new Error('MAPPING_SET_DEFAULT_CONFLICT');
    defaultKeys.add(key);
  });
  const mappingKeys = new Set();
  snapshot.mappings.forEach(mapping => {
    if (!setIds.has(mapping.mappingSetId)) throw new Error('MAPPING_SET_NOT_FOUND');
    const set = snapshot.mappingSets.find(row => row.mappingSetId === mapping.mappingSetId);
    if (!set || set.entityType !== mapping.entityType) throw new Error('MAPPING_SET_NOT_FOUND');
    const key = `${mapping.mappingSetId}:${mapping.normalizedHeader}`;
    if (mappingKeys.has(key)) throw new Error('MAPPING_HEADER_DUPLICATE');
    mappingKeys.add(key);
    if (mapping.action === 'MAP') {
      const field = foundationMetadataFindField(snapshot, mapping.entityType, mapping.targetFieldId);
      if (!field) throw new Error('FIELD_ID_NOT_FOUND');
      if (!field.enabled && mapping.enabled) throw new Error('MAPPING_FIELD_DISABLED');
    }
  });
  return true;
}

function foundationMetadataApplyChanges(current, payload, actor, now) {
  if (!payload || payload.schemaVersion !== FOUNDATION_METADATA_SCHEMA_VERSION) throw new Error('FOUNDATION_METADATA_SCHEMA_INVALID');
  const requestId = foundationMetadataText(payload.requestId);
  if (!/^REQ-[0-9a-f-]{36}$/i.test(requestId)) throw new Error('FOUNDATION_METADATA_REQUEST_ID_INVALID');
  if (!Array.isArray(payload.changes) || !payload.changes.length) throw new Error('FOUNDATION_METADATA_CHANGES_REQUIRED');
  const digest = foundationMetadataHash({ schemaVersion: payload.schemaVersion, expectedRevision: Number(payload.expectedRevision), changes: payload.changes });
  const replay = (current.idempotency || []).find(row => row.requestId === requestId);
  if (replay) {
    if (replay.digest !== digest) throw new Error('METADATA_REQUEST_REPLAY_MISMATCH');
    return { snapshot: current, response: Object.assign({}, replay.response, { replayed: true }), changed: false };
  }
  if (Number(payload.expectedRevision) !== Number(current.metadataRevision)) {
    const error = new Error('METADATA_VERSION_CONFLICT');
    error.latestRevision = Number(current.metadataRevision);
    throw error;
  }
  const changeIds = new Set();
  payload.changes.forEach(change => {
    const changeId = foundationMetadataText(change && change.changeId);
    if (!changeId || changeIds.has(changeId)) throw new Error('FOUNDATION_METADATA_CHANGE_ID_INVALID');
    changeIds.add(changeId);
  });
  const snapshot = foundationMetadataClone(current);
  const timestamp = foundationMetadataText(now) || new Date().toISOString();
  const nextRevision = Number(current.metadataRevision) + 1;
  const audits = [];

  payload.changes.forEach(change => {
    const op = foundationMetadataText(change.op).toUpperCase();
    if (op === 'PATCH_FIELD') {
      const entityType = foundationMetadataRequireEntity(change.entityType);
      const field = foundationMetadataFindField(snapshot, entityType, foundationMetadataText(change.fieldId));
      if (!field) throw new Error('FIELD_ID_NOT_FOUND');
      const patch = change.patch && typeof change.patch === 'object' && !Array.isArray(change.patch) ? change.patch : {};
      const allowed = field.systemField ? ['displayName', 'enabled', 'sortOrder'] : ['displayName', 'enabled', 'sortOrder', 'legacyAliases', 'headerAliases'];
      if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('FIELD_ID_IMMUTABLE');
      if (patch.enabled === false && field.protectedFromDisable) throw new Error('REQUIRED_FIELD_DISABLE_DENIED');
      const before = foundationMetadataClone(field);
      if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) field.displayName = foundationMetadataText(patch.displayName);
      if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) field.enabled = patch.enabled === true;
      if (Object.prototype.hasOwnProperty.call(patch, 'sortOrder')) {
        const sortOrder = Number(patch.sortOrder);
        if (!Number.isFinite(sortOrder)) throw new Error('FOUNDATION_METADATA_SORT_ORDER_INVALID');
        field.sortOrder = sortOrder;
      }
      if (!field.systemField && (Object.prototype.hasOwnProperty.call(patch, 'legacyAliases') || Object.prototype.hasOwnProperty.call(patch, 'headerAliases'))) {
        const aliases = patch.legacyAliases || patch.headerAliases || [];
        if (!Array.isArray(aliases)) throw new Error('FOUNDATION_METADATA_ALIASES_INVALID');
        field.legacyAliases = Array.from(new Set(aliases.map(foundationMetadataText).filter(Boolean)));
      }
      field.recordRevision = Number(field.recordRevision || 0) + 1;
      field.updatedAt = timestamp;
      audits.push(foundationMetadataAudit(actor, nextRevision, requestId, change, before, field, timestamp, field.fieldId));
      return;
    }

    if (op === 'UPSERT_MAPPING_SET') {
      const record = change.record && typeof change.record === 'object' ? change.record : {};
      const mappingSetId = foundationMetadataText(change.mappingSetId || record.mappingSetId);
      const existing = mappingSetId ? snapshot.mappingSets.find(row => row.mappingSetId === mappingSetId) : null;
      const entityType = foundationMetadataRequireEntity(record.entityType || existing && existing.entityType);
      if (existing && existing.entityType !== entityType) throw new Error('MAPPING_SET_NOT_FOUND');
      const before = existing ? foundationMetadataClone(existing) : null;
      const next = existing || { mappingSetId: 'MS-' + Utilities.getUuid(), recordRevision: 0 };
      next.entityType = entityType;
      next.name = foundationMetadataText(record.name == null ? next.name : record.name);
      next.description = foundationMetadataText(record.description == null ? next.description : record.description);
      next.sourceSystem = foundationMetadataText(record.sourceSystem == null ? next.sourceSystem : record.sourceSystem).toUpperCase();
      next.enabled = record.enabled === undefined ? next.enabled !== false : record.enabled === true;
      next.isDefault = record.isDefault === undefined ? next.isDefault === true : record.isDefault === true;
      if (!next.name || !next.sourceSystem) throw new Error('MAPPING_SET_INVALID');
      next.recordRevision = Number(next.recordRevision || 0) + 1;
      next.updatedAt = timestamp;
      if (!existing) snapshot.mappingSets.push(next);
      audits.push(foundationMetadataAudit(actor, nextRevision, requestId, change, before, next, timestamp, next.mappingSetId));
      return;
    }

    if (op === 'DELETE_MAPPING_SET') {
      const mappingSetId = foundationMetadataText(change.mappingSetId);
      const index = snapshot.mappingSets.findIndex(row => row.mappingSetId === mappingSetId);
      if (index < 0) throw new Error('MAPPING_SET_NOT_FOUND');
      const before = foundationMetadataClone(snapshot.mappingSets[index]);
      const removedMappings = snapshot.mappings.filter(row => row.mappingSetId === mappingSetId);
      snapshot.mappingSets.splice(index, 1);
      snapshot.mappings = snapshot.mappings.filter(row => row.mappingSetId !== mappingSetId);
      audits.push(foundationMetadataAudit(actor, nextRevision, requestId, change, { mappingSet: before, mappings: removedMappings }, null, timestamp, mappingSetId));
      return;
    }

    if (op === 'UPSERT_MAPPING') {
      const record = change.record && typeof change.record === 'object' ? change.record : {};
      const mappingId = foundationMetadataText(change.mappingId || record.mappingId);
      const existing = mappingId ? snapshot.mappings.find(row => row.mappingId === mappingId) : null;
      const set = snapshot.mappingSets.find(row => row.mappingSetId === foundationMetadataText(record.mappingSetId || existing && existing.mappingSetId));
      if (!set) throw new Error('MAPPING_SET_NOT_FOUND');
      const entityType = foundationMetadataRequireEntity(record.entityType || existing && existing.entityType || set.entityType);
      if (entityType !== set.entityType || existing && existing.entityType !== entityType) throw new Error('MAPPING_SET_NOT_FOUND');
      const before = existing ? foundationMetadataClone(existing) : null;
      const next = existing || { mappingId: 'HM-' + Utilities.getUuid(), recordRevision: 0 };
      next.mappingSetId = set.mappingSetId;
      next.entityType = entityType;
      next.originalHeader = record.originalHeader === undefined ? foundationMetadataText(next.originalHeader) : String(record.originalHeader == null ? '' : record.originalHeader);
      next.normalizedHeader = foundationMetadataNormalizeHeader(next.originalHeader);
      if (!next.normalizedHeader) throw new Error('MAPPING_HEADER_INVALID');
      next.action = foundationMetadataText(record.action || next.action || 'MAP').toUpperCase();
      if (!['MAP', 'IGNORE'].includes(next.action)) throw new Error('MAPPING_ACTION_INVALID');
      next.targetFieldId = next.action === 'MAP' ? foundationMetadataText(record.targetFieldId == null ? next.targetFieldId : record.targetFieldId) : null;
      if (next.action === 'MAP' && !next.targetFieldId) throw new Error('FIELD_ID_NOT_FOUND');
      next.enabled = record.enabled === undefined ? next.enabled !== false : record.enabled === true;
      const sortOrder = Number(record.sortOrder == null ? next.sortOrder || 0 : record.sortOrder);
      if (!Number.isFinite(sortOrder)) throw new Error('FOUNDATION_METADATA_SORT_ORDER_INVALID');
      next.sortOrder = sortOrder;
      next.recordRevision = Number(next.recordRevision || 0) + 1;
      next.updatedAt = timestamp;
      if (!existing) snapshot.mappings.push(next);
      audits.push(foundationMetadataAudit(actor, nextRevision, requestId, change, before, next, timestamp, next.mappingId));
      return;
    }

    if (op === 'DELETE_MAPPING') {
      const mappingId = foundationMetadataText(change.mappingId);
      const index = snapshot.mappings.findIndex(row => row.mappingId === mappingId);
      if (index < 0) throw new Error('MAPPING_NOT_FOUND');
      const before = foundationMetadataClone(snapshot.mappings[index]);
      snapshot.mappings.splice(index, 1);
      audits.push(foundationMetadataAudit(actor, nextRevision, requestId, change, before, null, timestamp, mappingId));
      return;
    }

    if (op === 'MIGRATE_CUSTOMER_LEGACY') {
      const state = snapshot.migrationState && snapshot.migrationState.customerLegacy || { status: 'NOT_STARTED' };
      if (state.status === 'COMPLETED') throw new Error('CUSTOMER_LEGACY_MIGRATION_ALREADY_COMPLETED');
      const record = change.record && typeof change.record === 'object' ? change.record : {};
      const groups = Array.isArray(record.groups) ? record.groups : [];
      const before = foundationMetadataClone(state);
      groups.forEach(group => {
        const sourceSystem = foundationMetadataText(group.sourceSystem).toUpperCase();
        if (!sourceSystem) throw new Error('MAPPING_SET_INVALID');
        const mappingSet = {
          mappingSetId: 'MS-' + Utilities.getUuid(), entityType: 'CUSTOMER',
          name: foundationMetadataText(group.name) || `CUSTOMER-${sourceSystem}-LEGACY`,
          description: '기존 거래처 IndexedDB 관리자 승인 이관', sourceSystem,
          enabled: true, isDefault: false, recordRevision: 1, updatedAt: timestamp
        };
        snapshot.mappingSets.push(mappingSet);
        (Array.isArray(group.mappings) ? group.mappings : []).forEach((mapping, index) => {
          const originalHeader = String(mapping.originalHeader == null ? '' : mapping.originalHeader);
          const normalizedHeader = foundationMetadataNormalizeHeader(originalHeader);
          const targetFieldId = foundationMetadataText(mapping.targetFieldId);
          if (!normalizedHeader || !foundationMetadataFindField(snapshot, 'CUSTOMER', targetFieldId)) throw new Error('MAPPING_MIGRATION_RECORD_INVALID');
          snapshot.mappings.push({
            mappingId: 'HM-' + Utilities.getUuid(), mappingSetId: mappingSet.mappingSetId,
            entityType: 'CUSTOMER', originalHeader, normalizedHeader, action: 'MAP', targetFieldId,
            enabled: mapping.enabled !== false, sortOrder: Number(mapping.sortOrder || (index + 1) * 10),
            recordRevision: 1, updatedAt: timestamp
          });
        });
      });
      snapshot.migrationState.customerLegacy = {
        status: 'COMPLETED', fingerprint: foundationMetadataText(record.fingerprint),
        sourceCount: Number(record.sourceCount || 0), successCount: Number(record.successCount || 0),
        unmigratedCount: Number(record.unmigratedCount || 0),
        subjectUserId: foundationMetadataText(actor && actor.nexusRequest && actor.nexusRequest.subjectUserId),
        completedAt: timestamp
      };
      audits.push(foundationMetadataAudit(actor, nextRevision, requestId, change, before, snapshot.migrationState.customerLegacy, timestamp, 'customerLegacy'));
      return;
    }

    throw new Error('FOUNDATION_METADATA_OPERATION_DENIED');
  });

  foundationMetadataValidateState(snapshot);
  snapshot.metadataRevision = nextRevision;
  snapshot.updatedAt = timestamp;
  snapshot.audit = (snapshot.audit || []).concat(audits).slice(-FOUNDATION_METADATA_MAX_AUDIT);
  const response = {
    metadataRevision: nextRevision,
    requestId,
    replayed: false,
    appliedChangeIds: payload.changes.map(change => foundationMetadataText(change.changeId)),
    updatedAt: timestamp
  };
  snapshot.idempotency = (snapshot.idempotency || []).concat([{ requestId, digest, response }]).slice(-FOUNDATION_METADATA_MAX_IDEMPOTENCY);
  return { snapshot, response, changed: true };
}

function foundationMetadataEnsureSheetHeader(sheet, headers) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function foundationMetadataSnapshotRows(snapshotId, snapshot, now) {
  const canonical = foundationMetadataCanonical(snapshot);
  const hash = foundationMetadataHash(canonical);
  const chunks = splitTextBySize(canonical, FOUNDATION_METADATA_CHUNK_SIZE);
  return {
    canonical,
    hash,
    chunks,
    rows: chunks.map((chunk, index) => [snapshot.companyId, snapshotId, index + 1, chunks.length, hash, chunk, now])
  };
}

function foundationMetadataReadPhysicalSnapshot(snapshotSheet, companyId, head) {
  if (!snapshotSheet || snapshotSheet.getLastRow() < 2) throw new Error('FOUNDATION_METADATA_CORRUPT');
  const rows = snapshotSheet.getRange(2, 1, snapshotSheet.getLastRow() - 1, 7).getValues()
    .filter(row => String(row[0]) === companyId && String(row[1]) === head.snapshotId)
    .sort((left, right) => Number(left[2]) - Number(right[2]));
  if (rows.length !== Number(head.chunkCount) || rows.some(row => Number(row[3]) !== rows.length || String(row[4]) !== head.hash)) {
    throw new Error('FOUNDATION_METADATA_CORRUPT');
  }
  const canonical = rows.map(row => String(row[5] || '')).join('');
  if (foundationMetadataHash(canonical) !== head.hash) throw new Error('FOUNDATION_METADATA_CORRUPT');
  const snapshot = JSON.parse(canonical);
  if (snapshot.companyId !== companyId || Number(snapshot.metadataRevision) !== Number(head.metadataRevision)) throw new Error('FOUNDATION_METADATA_CORRUPT');
  return snapshot;
}

function foundationMetadataLoadCurrent(ss, companyId) {
  const headSheet = ss.getSheetByName(FOUNDATION_METADATA_HEAD_SHEET);
  const snapshotSheet = ss.getSheetByName(FOUNDATION_METADATA_SNAPSHOT_SHEET);
  if (!headSheet || headSheet.getLastRow() < 2) return { snapshot: null, head: null, recoveredFromCorruption: false };
  const heads = headSheet.getRange(2, 1, headSheet.getLastRow() - 1, 7).getValues()
    .filter(row => String(row[0]) === companyId)
    .map(row => ({ companyId: String(row[0]), snapshotId: String(row[1]), metadataRevision: Number(row[2]), hash: String(row[3]), updatedAt: String(row[4]), previousSnapshotId: String(row[5]), chunkCount: Number(row[6]) }))
    .reverse();
  if (!heads.length) return { snapshot: null, head: null, recoveredFromCorruption: false };
  let corrupt = false;
  for (const head of heads) {
    try {
      return { snapshot: foundationMetadataReadPhysicalSnapshot(snapshotSheet, companyId, head), head, recoveredFromCorruption: corrupt };
    } catch (_) {
      corrupt = true;
    }
  }
  throw new Error('FOUNDATION_METADATA_CORRUPT');
}

function foundationMetadataPersist(ss, snapshot, previousHead, now) {
  const headSheet = getOrCreateSheet(ss, FOUNDATION_METADATA_HEAD_SHEET);
  const snapshotSheet = getOrCreateSheet(ss, FOUNDATION_METADATA_SNAPSHOT_SHEET);
  foundationMetadataEnsureSheetHeader(headSheet, ['companyId', 'snapshotId', 'metadataRevision', 'hash', 'updatedAt', 'previousSnapshotId', 'chunkCount']);
  foundationMetadataEnsureSheetHeader(snapshotSheet, ['companyId', 'snapshotId', 'chunkIndex', 'chunkCount', 'hash', 'canonicalJsonChunk', 'createdAt']);
  const snapshotId = 'FMS-' + Utilities.getUuid();
  const built = foundationMetadataSnapshotRows(snapshotId, snapshot, now);
  const startRow = snapshotSheet.getLastRow() + 1;
  snapshotSheet.getRange(startRow, 1, built.rows.length, 7).setValues(built.rows);
  const verified = foundationMetadataReadPhysicalSnapshot(snapshotSheet, snapshot.companyId, {
    snapshotId, metadataRevision: snapshot.metadataRevision, hash: built.hash, chunkCount: built.chunks.length
  });
  if (foundationMetadataCanonical(verified) !== built.canonical) throw new Error('FOUNDATION_METADATA_SNAPSHOT_VERIFY_FAILED');
  headSheet.appendRow([
    snapshot.companyId, snapshotId, snapshot.metadataRevision, built.hash, now,
    previousHead && previousHead.snapshotId || '', built.chunks.length
  ]);
  return { snapshotId, metadataRevision: snapshot.metadataRevision, hash: built.hash, updatedAt: now };
}

function foundationMetadataPublicSnapshot(snapshot, payload, recoveredFromCorruption) {
  const entityType = foundationMetadataText(payload && payload.entityType).toUpperCase();
  const includeDisabled = !payload || payload.includeDisabled !== false;
  const fields = snapshot.fields.filter(field => (!entityType || field.entityType === entityType) && (includeDisabled || field.enabled));
  const mappingSets = snapshot.mappingSets.filter(set => (!entityType || set.entityType === entityType) && (includeDisabled || set.enabled));
  const setIds = new Set(mappingSets.map(set => set.mappingSetId));
  const mappings = snapshot.mappings.filter(mapping => setIds.has(mapping.mappingSetId) && (includeDisabled || mapping.enabled));
  return {
    schemaVersion: snapshot.schemaVersion,
    companyId: snapshot.companyId,
    metadataRevision: snapshot.metadataRevision,
    fields: foundationMetadataClone(fields),
    mappingSets: foundationMetadataClone(mappingSets),
    mappings: foundationMetadataClone(mappings),
    migrationState: foundationMetadataClone(snapshot.migrationState || {}),
    updatedAt: snapshot.updatedAt,
    recoveredFromCorruption: recoveredFromCorruption === true
  };
}

function foundationMetadataRead(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_METADATA_SCHEMA_VERSION) throw new Error('FOUNDATION_METADATA_SCHEMA_INVALID');
  const companyId = foundationMetadataText(auth && auth.allowedScope && auth.allowedScope.companyId);
  if (!companyId) throw new Error('ONEAPP_NEXUS_GATEWAY_SCOPE_DENIED');
  let current = foundationMetadataLoadCurrent(ss, companyId);
  const now = new Date().toISOString();
  if (!current.snapshot) {
    const seed = foundationMetadataCreateSeed(companyId, now);
    foundationMetadataPersist(ss, seed, null, now);
    current = foundationMetadataLoadCurrent(ss, companyId);
  } else if (!current.recoveredFromCorruption) {
    const merged = foundationMetadataMergeMissingSystemFields(current.snapshot, now);
    if (merged.changed) {
      foundationMetadataPersist(ss, merged.snapshot, current.head, now);
      current = foundationMetadataLoadCurrent(ss, companyId);
    }
  }
  return foundationMetadataPublicSnapshot(current.snapshot, payload, current.recoveredFromCorruption);
}

function foundationMetadataWrite(ss, payload, auth) {
  const companyId = foundationMetadataText(auth && auth.allowedScope && auth.allowedScope.companyId);
  if (!companyId) throw new Error('ONEAPP_NEXUS_GATEWAY_SCOPE_DENIED');
  const current = foundationMetadataLoadCurrent(ss, companyId);
  if (!current.snapshot) throw new Error('FOUNDATION_METADATA_LOAD_FAILED');
  if (current.recoveredFromCorruption) throw new Error('FOUNDATION_METADATA_CORRUPT');
  const now = new Date().toISOString();
  const actor = Object.assign({}, auth || {}, { nexusRequest: payload.nexusRequest || {} });
  const applied = foundationMetadataApplyChanges(current.snapshot, payload, actor, now);
  if (!applied.changed) return applied.response;
  foundationMetadataPersist(ss, applied.snapshot, current.head, now);
  return applied.response;
}
