import {
  ACTOR_STATE,
  CUSTOMER_QUALITY,
  CUSTOMER_STATUS,
  clean,
  newId,
  normalizeCustomer,
  normalizeHeader,
  normalizeText,
  resolveCanonicalCustomerId,
} from './core.js';
import { STORE, getAll, getByKey, openDb, requestResult, transactionDone } from './db.js';

const SESSION_KEY = 'oneapp.nexus.home.session.v1';

export function currentActor() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    const user = cached?.session?.user;
    const expiresAt = Date.parse(cached?.session?.expiresAt || '');
    if (!user || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('SESSION_UNAVAILABLE');
    return {
      actorId: clean(user.userId || user.loginId) || null,
      actorName: clean(user.displayName || user.loginId),
      masterUserId: clean(user.masterUserId || user.ownerUserId || user.userId) || null,
      delegationId: clean(user.delegationId) || null,
      delegatedBy: clean(user.delegatedBy) || null,
      actorState: navigator.onLine === false ? ACTOR_STATE.LAST_VERIFIED_OFFLINE : ACTOR_STATE.VERIFIED,
    };
  } catch {
    return { actorId: null, actorName: '확인되지 않은 로컬 작업자', masterUserId: null, delegationId: null, delegatedBy: null, actorState: ACTOR_STATE.UNVERIFIED_LOCAL };
  }
}

function sourceLinkKey(sourceSystem, sourceCustomerCode) {
  return `${clean(sourceSystem).toUpperCase()}::${normalizeText(sourceCustomerCode)}`;
}

function aliasRow(customerId, alias, source, timestamp) {
  const normalized = normalizeText(alias);
  return {
    mappingId: newId('CA'), customerId, alias: clean(alias), rawText: clean(alias),
    normalizedAlias: normalized, normalizedText: normalized, source, sourceType: source,
    sourceId: '', confirmed: true, useCount: 1, lastUsedAt: timestamp,
    active: true, createdAt: timestamp, updatedAt: timestamp,
  };
}

function actorFields(actor) {
  return {
    actorId: actor?.actorId || null,
    actorName: clean(actor?.actorName),
    actorState: actor?.actorState || ACTOR_STATE.UNVERIFIED_LOCAL,
    masterUserId: actor?.masterUserId || null,
    delegationId: actor?.delegationId || null,
    delegatedBy: actor?.delegatedBy || null,
  };
}

export async function listCustomerData() {
  const [customers, aliases, sourceLinks] = await Promise.all([
    getAll(STORE.CUSTOMERS), getAll(STORE.ALIASES), getAll(STORE.SOURCE_LINKS),
  ]);
  return { customers, aliases, sourceLinks };
}

export async function customerDetails(customerId) {
  const [customers, aliases, sourceLinks] = await Promise.all([
    getAll(STORE.CUSTOMERS), getAll(STORE.ALIASES), getAll(STORE.SOURCE_LINKS),
  ]);
  const canonicalCustomerId = resolveCanonicalCustomerId(customerId, customers);
  const customer = customers.find((row) => row.customerId === canonicalCustomerId);
  const memberIds = new Set(customers.filter((row) => resolveCanonicalCustomerId(row.customerId, customers) === canonicalCustomerId)
    .map((row) => row.customerId));
  return {
    customer,
    aliases: aliases.filter((row) => row.customerId === canonicalCustomerId && row.active !== false),
    sourceLinks: sourceLinks.filter((row) => memberIds.has(row.customerId) && row.active !== false)
      .map((row) => ({ ...row, canonicalCustomerId, sourceOwnerCustomerId: row.customerId })),
  };
}

export async function mapCustomerToCanonical(sourceCustomerId, targetCustomerId, options = {}) {
  const timestamp = new Date().toISOString();
  const actor = options.actor || currentActor();
  const operationId = clean(options.operationId) || newId('OP-MAP');
  const db = await openDb();
  const tx = db.transaction([STORE.CUSTOMERS, STORE.EVENTS, STORE.META], 'readwrite');
  const customers = tx.objectStore(STORE.CUSTOMERS);
  const events = tx.objectStore(STORE.EVENTS);
  const meta = tx.objectStore(STORE.META);
  const replay = await requestResult(events.index('byOperationId').get(operationId));
  if (replay) {
    const replayed = await requestResult(customers.get(replay.customerId));
    await transactionDone(tx);
    return { customer: replayed, replayed: true, operationId };
  }
  const allCustomers = await requestResult(customers.getAll());
  const source = allCustomers.find((row) => row.customerId === clean(sourceCustomerId));
  const targetCanonicalId = resolveCanonicalCustomerId(targetCustomerId, allCustomers);
  const target = allCustomers.find((row) => row.customerId === targetCanonicalId);
  if (!source || source.status === CUSTOMER_STATUS.DELETED) {
    tx.abort();
    throw new Error('연결할 분산 거래처를 찾을 수 없습니다.');
  }
  if (!target || target.status === CUSTOMER_STATUS.DELETED || target.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED) {
    tx.abort();
    throw new Error('대표 NEXUS 거래처를 찾을 수 없습니다.');
  }
  if (source.customerId === target.customerId || resolveCanonicalCustomerId(target.customerId, allCustomers) === source.customerId) {
    tx.abort();
    throw new Error('같은 거래처끼리 연결하거나 순환 연결할 수 없습니다.');
  }
  if (source.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED && resolveCanonicalCustomerId(source.customerId, allCustomers) === target.customerId) {
    tx.abort();
    throw new Error('이미 선택한 대표 거래처에 연결되어 있습니다.');
  }
  const revision = Number(source.revision || 0) + 1;
  const mapped = normalizeCustomer({
    ...source,
    qualityStatus: CUSTOMER_QUALITY.SUPERSEDED,
    canonicalCustomerId: target.customerId,
    preMappingQualityStatus: source.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED
      ? (source.preMappingQualityStatus || CUSTOMER_QUALITY.UNVERIFIED)
      : source.qualityStatus,
    revision,
    updatedAt: timestamp,
  }, source, timestamp);
  customers.put(mapped);
  const headRow = await requestResult(meta.get('headRevision'));
  const headRevision = Number(headRow?.value || 0) + 1;
  meta.put({ key: 'headRevision', value: headRevision, updatedAt: timestamp });
  events.put({
    eventId: newId('CE'), customerId: source.customerId, eventType: 'MAPPED_TO_CANONICAL', operationId,
    entityRevision: revision, baseRevision: Number(source.revision || 0), headRevision,
    occurredAt: timestamp, ...actorFields(actor),
    payload: { source: 'MANUAL_CUSTOMER_MAPPING', before: source, after: mapped, targetCustomerId: target.customerId },
  });
  await transactionDone(tx);
  return { customer: mapped, target, replayed: false, operationId, headRevision };
}

export async function releaseCustomerCanonicalMapping(sourceCustomerId, options = {}) {
  const timestamp = new Date().toISOString();
  const actor = options.actor || currentActor();
  const operationId = clean(options.operationId) || newId('OP-UNMAP');
  const db = await openDb();
  const tx = db.transaction([STORE.CUSTOMERS, STORE.EVENTS, STORE.META], 'readwrite');
  const customers = tx.objectStore(STORE.CUSTOMERS);
  const events = tx.objectStore(STORE.EVENTS);
  const meta = tx.objectStore(STORE.META);
  const source = await requestResult(customers.get(clean(sourceCustomerId)));
  if (!source || source.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED || !clean(source.canonicalCustomerId)) {
    tx.abort();
    throw new Error('해제할 수동 거래처 연결을 찾을 수 없습니다.');
  }
  const revision = Number(source.revision || 0) + 1;
  const released = normalizeCustomer({
    ...source,
    qualityStatus: Object.values(CUSTOMER_QUALITY).includes(source.preMappingQualityStatus)
      ? source.preMappingQualityStatus
      : CUSTOMER_QUALITY.UNVERIFIED,
    canonicalCustomerId: source.customerId,
    preMappingQualityStatus: '',
    revision,
    updatedAt: timestamp,
  }, source, timestamp);
  customers.put(released);
  const headRow = await requestResult(meta.get('headRevision'));
  const headRevision = Number(headRow?.value || 0) + 1;
  meta.put({ key: 'headRevision', value: headRevision, updatedAt: timestamp });
  events.put({
    eventId: newId('CE'), customerId: source.customerId, eventType: 'CANONICAL_MAPPING_RELEASED', operationId,
    entityRevision: revision, baseRevision: Number(source.revision || 0), headRevision,
    occurredAt: timestamp, ...actorFields(actor),
    payload: { source: 'MANUAL_CUSTOMER_MAPPING', before: source, after: released, previousTargetCustomerId: source.canonicalCustomerId },
  });
  await transactionDone(tx);
  return { customer: released, replayed: false, operationId, headRevision };
}

export async function saveCustomer(input, options = {}) {
  const timestamp = new Date().toISOString();
  const actor = options.actor || currentActor();
  const operationId = clean(options.operationId) || newId('OP');
  const db = await openDb();
  const storeNames = [STORE.CUSTOMERS, STORE.ALIASES, STORE.EVENTS, STORE.SOURCE_LINKS, STORE.SOURCE_LINK_EVENTS, STORE.META];
  const tx = db.transaction(storeNames, 'readwrite');
  const customers = tx.objectStore(STORE.CUSTOMERS);
  const aliases = tx.objectStore(STORE.ALIASES);
  const events = tx.objectStore(STORE.EVENTS);
  const sourceLinks = tx.objectStore(STORE.SOURCE_LINKS);
  const sourceLinkEvents = tx.objectStore(STORE.SOURCE_LINK_EVENTS);
  const meta = tx.objectStore(STORE.META);
  const replay = await requestResult(events.index('byOperationId').get(operationId));
  if (replay) {
    const result = await requestResult(customers.get(replay.customerId));
    await transactionDone(tx);
    return { customer: result, replayed: true, operationId };
  }
  const customerId = clean(input.customerId) || newId('CU');
  const previous = await requestResult(customers.get(customerId));
  const expectedRevision = options.expectedRevision;
  if (previous && expectedRevision !== undefined && Number(previous.revision || 0) !== Number(expectedRevision)) {
    tx.abort();
    const error = new Error('거래처가 다른 작업에서 변경되었습니다. 목록을 새로 불러온 뒤 다시 저장해 주세요.');
    error.code = 'REVISION_CONFLICT';
    throw error;
  }
  if (!options.allowIncompleteName && !clean(input.customerName ?? previous?.customerName)) {
    tx.abort();
    throw new Error('거래처명은 필수입니다.');
  }
  const revision = Number(previous?.revision || 0) + 1;
  const { aliases: _aliases, sourceLinks: _sourceLinks, ...customerInput } = input;
  const candidate = normalizeCustomer({
    ...customerInput,
    customerId,
    revision,
    qualityStatus: input.qualityStatus || previous?.qualityStatus || CUSTOMER_QUALITY.UNVERIFIED,
    status: input.status || previous?.status || CUSTOMER_STATUS.ACTIVE,
    updatedAt: timestamp,
  }, previous, timestamp);
  if (candidate.normalizedCustomerCode) {
    const collisions = await requestResult(customers.index('byNormalizedCustomerCode').getAll(candidate.normalizedCustomerCode));
    if (collisions.some((row) => row.customerId !== customerId && row.status !== CUSTOMER_STATUS.DELETED)) {
      tx.abort();
      const error = new Error('같은 거래처코드가 이미 존재합니다.');
      error.code = 'CUSTOMER_CODE_DUPLICATE';
      throw error;
    }
  }
  customers.put(candidate);

  const existingAliases = await requestResult(aliases.index('byCustomerId').getAll(customerId));
  const aliasValues = [...new Set([
    ...(previous && previous.customerName !== candidate.customerName ? [previous.customerName] : []),
    ...(Array.isArray(input.aliases) ? input.aliases : []),
  ].map(clean).filter(Boolean))];
  const normalizedExistingAliases = new Set(existingAliases.filter((row) => row.active !== false).map((row) => row.normalizedText));
  aliasValues.filter((value) => !normalizedExistingAliases.has(normalizeText(value)))
    .forEach((value) => aliases.put(aliasRow(customerId, value, previous?.customerName === value ? 'PREVIOUS_NAME' : 'MANUAL', timestamp)));

  if (Array.isArray(input.sourceLinks)) {
    for (const incoming of input.sourceLinks) {
      const sourceSystem = clean(incoming.sourceSystem).toUpperCase();
      const sourceCustomerCode = clean(incoming.sourceCustomerCode);
      if (!sourceSystem || !sourceCustomerCode) continue;
      const key = sourceLinkKey(sourceSystem, sourceCustomerCode);
      const existing = await requestResult(sourceLinks.index('bySourceLinkKey').get(key));
      if (existing && existing.customerId !== customerId && existing.active !== false) {
        tx.abort();
        const error = new Error(`${sourceSystem} 외부코드 ${sourceCustomerCode}는 다른 거래처에 연결되어 있습니다.`);
        error.code = 'SOURCE_LINK_CONFLICT';
        throw error;
      }
      const link = {
        ...(existing || {}),
        linkId: existing?.linkId || newId('CSL'),
        sourceLinkKey: key,
        customerId,
        sourceSystem,
        sourceCustomerCode,
        sourceCustomerName: clean(incoming.sourceCustomerName),
        sourceNickname: clean(incoming.sourceNickname),
        sourceSearchText: clean(incoming.sourceSearchText),
        linkStatus: 'ACTIVE', active: true,
        revision: Number(existing?.revision || 0) + 1,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      sourceLinks.put(link);
      sourceLinkEvents.put({
        eventId: newId('CSLE'), linkId: link.linkId, eventType: existing ? 'UPDATED' : 'CREATED',
        beforeCustomerId: existing?.customerId || '', afterCustomerId: customerId,
        operationId, occurredAt: timestamp, ...actorFields(actor),
      });
    }
  }

  const headRow = await requestResult(meta.get('headRevision'));
  const headRevision = Number(headRow?.value || 0) + 1;
  meta.put({ key: 'headRevision', value: headRevision, updatedAt: timestamp });
  const eventType = previous ? 'UPDATED' : 'CREATED';
  events.put({
    eventId: newId('CE'), customerId, eventType, operationId,
    entityRevision: revision, baseRevision: Number(previous?.revision || 0), headRevision,
    occurredAt: timestamp, ...actorFields(actor),
    payload: { source: clean(options.source || 'CUSTOMER_MASTER'), before: previous || null, after: candidate },
  });
  await transactionDone(tx);
  return { customer: candidate, replayed: false, operationId, headRevision };
}

export async function updateCustomerStatus(customerId, status, expectedRevision) {
  const details = await customerDetails(customerId);
  if (!details.customer) throw new Error('거래처를 찾을 수 없습니다.');
  return saveCustomer({ ...details.customer, status, aliases: [], sourceLinks: [] }, {
    expectedRevision, source: 'STATUS_CHANGE', operationId: newId('OP-STATUS'),
  });
}

export async function listEvents(limit = 300) {
  const rows = await getAll(STORE.EVENTS);
  return rows.sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt))).slice(0, limit);
}

export async function listHeaderMappings() { return getAll(STORE.HEADER_MAPPINGS); }
export async function listUserFields() { return getAll(STORE.USER_FIELDS); }

export async function saveHeaderMapping({ sourceSystem = 'ERP', header, targetFieldKey, targetType = 'TEXT' }) {
  const normalizedHeader = normalizeHeader(header);
  if (!normalizedHeader || !clean(targetFieldKey)) throw new Error('원본 헤더와 연결할 저장 항목이 필요합니다.');
  const system = clean(sourceSystem).toUpperCase();
  const mappingId = `${system}::${normalizedHeader}`;
  const db = await openDb();
  const tx = db.transaction(STORE.HEADER_MAPPINGS, 'readwrite');
  const store = tx.objectStore(STORE.HEADER_MAPPINGS);
  const previous = await requestResult(store.get(mappingId));
  const timestamp = new Date().toISOString();
  const mapping = {
    ...(previous || {}), mappingId, sourceSystem: system, normalizedHeader, originalHeader: clean(header),
    targetFieldKey: clean(targetFieldKey), targetType, enabled: true,
    revision: Number(previous?.revision || 0) + 1,
    createdAt: previous?.createdAt || timestamp, updatedAt: timestamp,
  };
  store.put(mapping);
  await transactionDone(tx);
  return mapping;
}

export async function saveUserField(fieldKey, patch = {}) {
  const db = await openDb();
  const tx = db.transaction(STORE.USER_FIELDS, 'readwrite');
  const store = tx.objectStore(STORE.USER_FIELDS);
  const previous = await requestResult(store.get(fieldKey));
  if (!previous) throw new Error('사용자 필드 슬롯을 찾을 수 없습니다.');
  const timestamp = new Date().toISOString();
  const row = {
    ...previous,
    displayName: clean(patch.displayName),
    headerAliases: [...new Set(String(patch.headerAliases || '').split(/[,\n]/).map(clean).filter(Boolean))],
    enabled: patch.enabled === true,
    revision: Number(previous.revision || 0) + 1,
    updatedAt: timestamp,
  };
  store.put(row);
  await transactionDone(tx);
  return row;
}

export async function prepareImportBatch({ fileName, fileHash, sourceSystem, mapping, records }) {
  const batches = await getAll(STORE.IMPORT_BATCHES);
  const reusable = batches.filter((row) => row.fileHash === fileHash && ['PREPARED', 'PARTIAL', 'APPLYING'].includes(row.status))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  if (reusable) {
    const sourceRecords = (await getAll(STORE.SOURCE_RECORDS)).filter((row) => row.importBatchId === reusable.importBatchId);
    return { batch: reusable, records: sourceRecords, resumed: true };
  }
  const timestamp = new Date().toISOString();
  const importBatchId = newId('CIB');
  const batch = {
    importBatchId, sourceType: 'SOURCE_CODE_LINK_UPSERT', sourceSystem: clean(sourceSystem).toUpperCase(),
    fileName: clean(fileName), fileHash, mapping, rowCount: records.length, status: 'PREPARED',
    createdAt: timestamp, updatedAt: timestamp,
  };
  const sourceRecords = records.map((record) => ({
    ...record, sourceRecordId: newId('CISR'), importBatchId, sourceType: 'SOURCE_CODE_LINK_UPSERT',
    appliedCustomerId: '', errorMessage: '', createdAt: timestamp, updatedAt: timestamp,
  }));
  const db = await openDb();
  const tx = db.transaction([STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS], 'readwrite');
  tx.objectStore(STORE.IMPORT_BATCHES).put(batch);
  sourceRecords.forEach((record) => tx.objectStore(STORE.SOURCE_RECORDS).put(record));
  await transactionDone(tx);
  return { batch, records: sourceRecords, resumed: false };
}

async function patchImportRecord(sourceRecordId, patch) {
  const db = await openDb();
  const tx = db.transaction(STORE.SOURCE_RECORDS, 'readwrite');
  const store = tx.objectStore(STORE.SOURCE_RECORDS);
  const previous = await requestResult(store.get(sourceRecordId));
  store.put({ ...previous, ...patch, updatedAt: new Date().toISOString() });
  await transactionDone(tx);
}

export async function resolveImportRecord(sourceRecordId, { mode, customerId = '' } = {}) {
  const record = await getByKey(STORE.SOURCE_RECORDS, sourceRecordId);
  if (!record || record.resultType !== 'LINK_REVIEW') throw new Error('연결 확인 대상 행을 찾을 수 없습니다.');
  const reviewValues = record.reviewValues || record.values || {};
  if (mode === 'CREATE') {
    const patch = {
      resultType: 'READY_CREATE', reasonCode: '', matchMethod: 'MANUAL_NEW',
      existingCustomerId: '', expectedRevision: 0, candidateCustomerIds: [], values: reviewValues,
    };
    await patchImportRecord(sourceRecordId, patch);
    return { ...record, ...patch };
  }
  if (mode !== 'LINK' || !clean(customerId)) throw new Error('연결할 NEXUS 거래처를 선택해 주세요.');
  const customer = await getByKey(STORE.CUSTOMERS, customerId);
  if (!customer || customer.status === CUSTOMER_STATUS.DELETED) throw new Error('선택한 NEXUS 거래처를 찾을 수 없습니다.');
  const values = Object.fromEntries(Object.entries(reviewValues).filter(([field]) => !clean(customer[field])));
  const patch = {
    resultType: 'READY_LINK', reasonCode: '', matchMethod: 'MANUAL_LINK',
    existingCustomerId: customer.customerId, expectedRevision: Number(customer.revision || 0),
    candidateCustomerIds: [], values,
  };
  await patchImportRecord(sourceRecordId, patch);
  return { ...record, ...patch };
}

async function patchImportBatch(importBatchId, patch) {
  const db = await openDb();
  const tx = db.transaction(STORE.IMPORT_BATCHES, 'readwrite');
  const store = tx.objectStore(STORE.IMPORT_BATCHES);
  const previous = await requestResult(store.get(importBatchId));
  store.put({ ...previous, ...patch, updatedAt: new Date().toISOString() });
  await transactionDone(tx);
}

export async function applyImportBatch(importBatchId, onProgress = () => {}) {
  const allRecords = await getAll(STORE.SOURCE_RECORDS);
  const records = allRecords.filter((row) => row.importBatchId === importBatchId).sort((left, right) => left.rowNo - right.rowNo);
  await patchImportBatch(importBatchId, { status: 'APPLYING' });
  let processed = 0;
  for (const record of records) {
    if (['CREATED', 'UPDATED', 'LINKED', 'UNCHANGED', 'EMPTY_ROW_EXCLUDED', 'SYSTEM_ROW_EXCLUDED'].includes(record.resultType)) {
      processed += 1; onProgress(processed, records.length, record); continue;
    }
    const plannedResultType = record.resultType === 'FAILED' ? record.retryResultType : record.resultType;
    if (!['READY_CREATE', 'READY_UPDATE', 'READY_LINK'].includes(plannedResultType)) {
      processed += 1; onProgress(processed, records.length, record); continue;
    }
    try {
      const result = await saveCustomer({
        ...(record.values || {}),
        customerId: record.existingCustomerId || undefined,
        qualityStatus: CUSTOMER_QUALITY.UNVERIFIED,
        aliases: [record.sourceValues?.sourceNickname, record.sourceValues?.sourceCustomerName]
          .map(clean).filter((value, index, values) => value && values.indexOf(value) === index && normalizeText(value) !== normalizeText(record.values?.customerName)),
        sourceLinks: [{
          sourceSystem: record.sourceSystem,
          sourceCustomerCode: record.sourceValues?.sourceCustomerCode,
          sourceCustomerName: record.sourceValues?.sourceCustomerName,
          sourceNickname: record.sourceValues?.sourceNickname,
          sourceSearchText: record.sourceValues?.sourceSearchText,
        }],
      }, {
        expectedRevision: record.existingCustomerId ? record.expectedRevision : undefined,
        operationId: `IMPORT-${importBatchId}-${record.sourceRecordId}`,
        source: 'SOURCE_CODE_LINK_UPSERT',
        allowIncompleteName: true,
      });
      const resultType = plannedResultType === 'READY_CREATE' ? 'CREATED' : plannedResultType === 'READY_LINK' ? 'LINKED' : 'UPDATED';
      await patchImportRecord(record.sourceRecordId, { resultType, retryResultType: '', appliedCustomerId: result.customer.customerId, errorMessage: '' });
    } catch (error) {
      await patchImportRecord(record.sourceRecordId, { resultType: 'FAILED', retryResultType: plannedResultType, errorMessage: String(error?.message || error) });
    }
    processed += 1;
    onProgress(processed, records.length, record);
  }
  const completed = (await getAll(STORE.SOURCE_RECORDS)).filter((row) => row.importBatchId === importBatchId);
  const failed = completed.filter((row) => row.resultType === 'FAILED').length;
  const pendingReviewCount = completed.filter((row) => row.resultType === 'LINK_REVIEW').length;
  await patchImportBatch(importBatchId, {
    status: failed || pendingReviewCount ? 'PARTIAL' : 'APPLIED',
    processedCount: completed.length, failedCount: failed, pendingReviewCount,
  });
  return completed;
}

export async function latestIncompleteImport() {
  const batches = await getAll(STORE.IMPORT_BATCHES);
  const batch = batches.filter((row) => ['PREPARED', 'PARTIAL', 'APPLYING'].includes(row.status))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  if (!batch) return null;
  return { batch, records: (await getAll(STORE.SOURCE_RECORDS)).filter((row) => row.importBatchId === batch.importBatchId) };
}
