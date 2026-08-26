function text(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digestText(value) {
  let first = 2166136261;
  let second = 2246822507;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function candidateIdentity(candidate = {}) {
  return {
    normalizedNameKey: normalizeEstimateNameKey(candidate.catalogName),
    contentDigest: estimateContentDigest(candidate.draft)
  };
}

function duplicateName(records, normalizedNameKey, excludedId = '') {
  return records.find(record => record.estimateId !== excludedId
    && normalizeEstimateNameKey(record.catalogName) === normalizedNameKey);
}

export function normalizeEstimateName(value) {
  return text(value);
}

export function normalizeEstimateNameKey(value) {
  return text(value).toLocaleLowerCase('ko-KR');
}

export function estimateRevision(record = {}) {
  const revision = Number(record.revision);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function estimateContentDigest(draft = {}) {
  const content = clone(draft || {});
  delete content.documentId;
  delete content.catalogRecordId;
  delete content.updatedAt;
  delete content.delivery;
  return digestText(canonical(content));
}

export function planEstimateCreate(records = [], candidate = {}, { saveAttemptId = '' } = {}) {
  const source = Array.isArray(records) ? records : [];
  const estimateId = text(candidate.estimateId);
  const attemptId = text(saveAttemptId);
  const { normalizedNameKey, contentDigest } = candidateIdentity(candidate);
  if (!estimateId) throw contractError('ESTIMATE_ID_REQUIRED', '새 견적서 식별자가 필요합니다.');
  if (!normalizedNameKey) throw contractError('ESTIMATE_NAME_REQUIRED', '견적서명을 입력하세요.');
  if (!attemptId) throw contractError('ESTIMATE_ATTEMPT_REQUIRED', '저장을 다시 시작해 주세요.');

  const existing = source.find(record => record.estimateId === estimateId);
  if (existing) {
    const recovered = existing.lastSaveAttemptId === attemptId
      && normalizeEstimateNameKey(existing.catalogName) === normalizedNameKey
      && String(existing.contentDigest || estimateContentDigest(existing.draft)) === contentDigest;
    if (recovered) return { records: clone(source), record: clone(existing), recovered: true };
    throw contractError('ESTIMATE_ID_CONFLICT', '같은 저장 요청과 다른 견적서가 이미 존재합니다.');
  }
  if (duplicateName(source, normalizedNameKey)) {
    throw contractError('ESTIMATE_NAME_CONFLICT', '같은 이름의 견적서가 이미 있습니다.');
  }

  const record = clone({
    ...candidate,
    estimateId,
    catalogName: normalizeEstimateName(candidate.catalogName),
    normalizedNameKey,
    contentDigest,
    revision: 1,
    lastSaveAttemptId: attemptId
  });
  return { records: [...clone(source), record], record, recovered: false };
}

export function planEstimateUpdate(records = [], estimateIdValue = '', expectedRevisionValue = 0, candidate = {}, { saveAttemptId = '' } = {}) {
  const source = Array.isArray(records) ? records : [];
  const estimateId = text(estimateIdValue);
  const attemptId = text(saveAttemptId);
  const existing = source.find(record => record.estimateId === estimateId);
  if (!existing) throw contractError('ESTIMATE_NOT_FOUND', '저장된 견적서를 찾지 못했습니다.');
  const { normalizedNameKey, contentDigest } = candidateIdentity(candidate);
  if (!normalizedNameKey) throw contractError('ESTIMATE_NAME_REQUIRED', '견적서명을 입력하세요.');
  if (!attemptId) throw contractError('ESTIMATE_ATTEMPT_REQUIRED', '저장을 다시 시작해 주세요.');

  const recovered = existing.lastSaveAttemptId === attemptId
    && normalizeEstimateNameKey(existing.catalogName) === normalizedNameKey
    && String(existing.contentDigest || estimateContentDigest(existing.draft)) === contentDigest;
  if (recovered) return { records: clone(source), record: clone(existing), recovered: true };

  const expectedRevision = Number(expectedRevisionValue);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || estimateRevision(existing) !== expectedRevision) {
    throw contractError('ESTIMATE_REVISION_CONFLICT', '다른 화면에서 이 견적서가 먼저 변경되었습니다.');
  }
  if (duplicateName(source, normalizedNameKey, estimateId)) {
    throw contractError('ESTIMATE_NAME_CONFLICT', '같은 이름의 견적서가 이미 있습니다.');
  }

  const record = clone({
    ...existing,
    ...candidate,
    estimateId,
    catalogName: normalizeEstimateName(candidate.catalogName),
    normalizedNameKey,
    contentDigest,
    revision: expectedRevision + 1,
    lastSaveAttemptId: attemptId,
    createdAt: existing.createdAt || candidate.createdAt,
    sortOrder: existing.sortOrder
  });
  return {
    records: clone(source).map(item => item.estimateId === estimateId ? record : item),
    record,
    recovered: false
  };
}
