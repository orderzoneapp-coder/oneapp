import { removeLinkedEstimateSources } from './linked-estimate-source-edit.js';

export const ESTIMATE_F8_RECOVERY_SCHEMA = 'ONEAPP_SMARTINPUT_ESTIMATE_F8_RECOVERY_V1';

const text = value => String(value ?? '').trim();

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function unique(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function sameIds(left = [], right = []) {
  const a = unique(left).sort();
  const b = unique(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  const source = canonical(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `F8I-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function meaningful(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(meaningful);
  if (typeof value === 'object') return Object.values(value).some(meaningful);
  return Boolean(value);
}

function meaningfulRow(row = {}) {
  return ['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'memo', 'description', 'noticePrice']
    .some(field => meaningful(row[field])) || Object.values(row.customValues || {}).some(meaningful);
}

function normalizedRowRefs(row = {}) {
  if (Array.isArray(row.linkedSourceRefs) && row.linkedSourceRefs.length) {
    return row.linkedSourceRefs.map(ref => ({ estimateId: text(ref?.estimateId), rowId: text(ref?.rowId) }));
  }
  return row.linkedSourceEstimateId && row.linkedSourceRowId
    ? [{ estimateId: text(row.linkedSourceEstimateId), rowId: text(row.linkedSourceRowId) }]
    : [];
}

function rowLabel(row = {}) {
  return text(row.itemName) || text(row.itemCode) || text(row.rowId) || '품목';
}

function normalizedProductKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}<>,.:;·_-]+/g, '');
}

function linkedProductKey(row = {}) {
  const code = normalizedProductKey(row.itemCode);
  if (code) return `CODE:${code}`;
  return `NAME:${normalizedProductKey(row.itemName)}|${normalizedProductKey(row.specification)}|${normalizedProductKey(row.unit)}`;
}

function invalidResult(record, message, errorCode = 'ESTIMATE_F8_SOURCE_INVALID') {
  return {
    status: 'INVALID',
    targetEstimateId: text(record?.estimateId),
    targetEstimateName: text(record?.catalogName),
    missingSourceIds: [],
    missingRowRefs: [],
    availableSourceIds: [],
    removedRows: [],
    keptRows: [],
    manualRows: [],
    sourceReferenceCounts: [],
    impactFingerprint: '',
    errorCode,
    message
  };
}

function validateLinkedSnapshot(record, sourceIds) {
  const draft = record?.draft;
  if (!draft || !Array.isArray(draft.rows)) return '저장된 연동견적서 Snapshot을 확인할 수 없습니다.';
  const draftSourceIds = unique((draft.linkedEstimateSources || []).map(source => source?.estimateId));
  if (!draftSourceIds.length || !sameIds(sourceIds, draftSourceIds)) {
    return '연동견적서의 저장 정보와 Snapshot 원본 구성이 일치하지 않습니다.';
  }
  const seenRefs = new Set();
  for (let rowIndex = 0; rowIndex < draft.rows.length; rowIndex += 1) {
    const row = draft.rows[rowIndex];
    const explicitRefs = Array.isArray(row?.linkedSourceRefs) && row.linkedSourceRefs.length > 0;
    const refs = normalizedRowRefs(row);
    const listedIds = unique(row?.linkedSourceEstimateIds || []);
    const legacyId = text(row?.linkedSourceEstimateId);
    const legacyRowId = text(row?.linkedSourceRowId);
    if (explicitRefs && refs.some(ref => !ref.estimateId || !ref.rowId)) return `${rowIndex + 1}행 원본 참조에 견적서 ID 또는 행 ID가 없습니다.`;
    if (Boolean(legacyId) !== Boolean(legacyRowId)) return `${rowIndex + 1}행 단일 원본 참조가 완전하지 않습니다.`;
    const signatures = refs.map(ref => `${ref.estimateId}:${ref.rowId}`);
    if (new Set(signatures).size !== signatures.length) return `${rowIndex + 1}행에 같은 원본 참조가 중복되어 있습니다.`;
    if (listedIds.length && refs.length && !sameIds(listedIds, refs.map(ref => ref.estimateId))) {
      return `${rowIndex + 1}행 원본 목록과 행 참조가 일치하지 않습니다.`;
    }
    if (refs.some(ref => !sourceIds.includes(ref.estimateId))) return `${rowIndex + 1}행에 등록되지 않은 원본 참조가 있습니다.`;
    for (const signature of new Set(signatures)) {
      if (seenRefs.has(signature)) return `원본 행 ${signature}이(가) 여러 작업행에 중복 연결되어 있습니다.`;
      seenRefs.add(signature);
    }
  }
  return '';
}

function sourceReferenceCounts(record, sourceIds) {
  return sourceIds.map(estimateId => {
    const refs = (record?.draft?.rows || []).flatMap(normalizedRowRefs)
      .filter(ref => ref.estimateId === estimateId);
    const sourceMeta = (record?.linkedEstimateSources || []).find(source => text(source?.estimateId) === estimateId) || {};
    return {
      estimateId,
      estimateName: text(sourceMeta.catalogName),
      customerName: text(sourceMeta.customerName),
      referencedRowCount: new Set(refs.map(ref => ref.rowId)).size
    };
  });
}

export function inspectEstimateF8Integrity({ record = null, allRecords = [] } = {}) {
  if (record?.estimateKind !== 'LINKED_GROUP') {
    return invalidResult(record, '연동견적서만 F8 연결 복구를 실행할 수 있습니다.');
  }
  const sourceIds = unique((record.linkedEstimateSources || []).map(source => source?.estimateId));
  if (!sourceIds.length) return invalidResult(record, '연동견적서의 원본 견적서 구성을 확인할 수 없습니다.');
  const recordsById = new Map((allRecords || []).map(item => [text(item?.estimateId), item]));
  const availableRecords = sourceIds.map(estimateId => recordsById.get(estimateId)).filter(Boolean);
  const missingSourceIds = sourceIds.filter(estimateId => !recordsById.has(estimateId));

  const snapshotError = validateLinkedSnapshot(record, sourceIds);
  if (snapshotError) return invalidResult(record, snapshotError);

  for (const source of availableRecords) {
    if (source.estimateKind === 'LINKED_GROUP' || source?.draft?.estimateKind === 'LINKED_GROUP') {
      return invalidResult(record, `원본 ${source.estimateId}이(가) 개별 견적서가 아닙니다.`);
    }
    const seenRowIds = new Set();
    for (const row of source?.draft?.rows || []) {
      const rowId = text(row?.rowId);
      if (!rowId || seenRowIds.has(rowId)) return invalidResult(record, `원본 ${source.estimateId}의 행 식별자가 유일하지 않습니다.`);
      seenRowIds.add(rowId);
    }
  }

  const rowIdsBySource = new Map(availableRecords.map(source => [
    text(source.estimateId),
    new Set((source?.draft?.rows || []).map(row => text(row?.rowId)).filter(Boolean))
  ]));
  const missingRowRefs = [];
  const removedRows = [];
  const keptSnapshotRows = [];
  const manualRows = [];
  for (const row of record?.draft?.rows || []) {
    const refs = normalizedRowRefs(row);
    if (!refs.length) {
      if (meaningfulRow(row)) manualRows.push(clone(row));
      continue;
    }
    const missingRefs = refs.filter(ref => !rowIdsBySource.get(ref.estimateId)?.has(ref.rowId));
    missingRowRefs.push(...missingRefs.map(ref => ({ ...ref, targetRowId: text(row.rowId), itemLabel: rowLabel(row) })));
    const availableRefs = refs.filter(ref => rowIdsBySource.get(ref.estimateId)?.has(ref.rowId));
    if (missingRefs.length && !availableRefs.length) removedRows.push(clone(row));
    else keptSnapshotRows.push(clone(row));
  }
  const keptByProduct = new Map();
  availableRecords.forEach(source => (source?.draft?.rows || []).filter(meaningfulRow).forEach(row => {
    const key = linkedProductKey(row);
    if (!keptByProduct.has(key)) keptByProduct.set(key, clone(row));
  }));
  const keptRows = [...keptByProduct.values(), ...manualRows.map(clone)];
  const status = missingSourceIds.length === sourceIds.length
    ? 'ALL_MISSING'
    : (missingSourceIds.length || missingRowRefs.length ? 'PARTIAL_MISSING' : 'READY');
  const errorCode = status === 'ALL_MISSING'
    ? 'ESTIMATE_F8_SOURCE_ALL_MISSING'
    : (status === 'PARTIAL_MISSING' ? 'ESTIMATE_F8_SOURCE_PARTIAL_MISSING' : '');
  const impactFingerprint = fingerprint({
    targetEstimateId: text(record.estimateId),
    sourceIds,
    missingSourceIds,
    missingRowRefs,
    removedRows,
    keptSnapshotRows,
    manualRows,
    availableSources: availableRecords.map(source => ({
      estimateId: text(source.estimateId),
      estimateKind: text(source.estimateKind),
      draftKind: text(source?.draft?.estimateKind),
      rows: source?.draft?.rows || []
    }))
  });
  return {
    status,
    targetEstimateId: text(record.estimateId),
    targetEstimateName: text(record.catalogName),
    missingSourceIds,
    missingRowRefs,
    availableSourceIds: availableRecords.map(source => text(source.estimateId)),
    removedRows,
    keptRows,
    manualRows,
    sourceReferenceCounts: sourceReferenceCounts(record, sourceIds),
    snapshotRowCount: (record?.draft?.rows || []).filter(meaningfulRow).length,
    snapshotAmount: Number(record.amount || 0),
    snapshotUpdatedAt: text(record.updatedAt || record.createdAt),
    impactFingerprint,
    errorCode,
    message: status === 'READY'
      ? '연동 원본 무결성이 정상입니다.'
      : (status === 'ALL_MISSING'
        ? `연결된 원본 ${missingSourceIds.length}개를 모두 확인할 수 없습니다.`
        : `원본 ${missingSourceIds.length}개와 행 참조 ${missingRowRefs.length}건을 정리해야 합니다.`)
  };
}

function recoveryAudit({ diagnosis, action, operationId, actorId, occurredAt, afterSourceIds = [] }) {
  return {
    schemaVersion: ESTIMATE_F8_RECOVERY_SCHEMA,
    operationId: text(operationId),
    action,
    reasonCode: action === 'CREATE_INDEPENDENT_COPY' ? 'F8_INDEPENDENT_RECOVERY' : 'F8_INTEGRITY_CLEANUP',
    targetEstimateId: text(diagnosis?.targetEstimateId),
    missingSourceIds: clone(diagnosis?.missingSourceIds || []),
    missingRowRefs: clone(diagnosis?.missingRowRefs || []),
    sourceEstimateIdsAfter: clone(afterSourceIds),
    impactFingerprint: text(diagnosis?.impactFingerprint),
    actorId: text(actorId),
    occurredAt: text(occurredAt)
  };
}

function appendAudit(record, audit) {
  record.estimateAutomationHistory = [...(record.estimateAutomationHistory || []), clone(audit)];
  record.estimateLinkHistory = [...(record.estimateLinkHistory || []), clone(audit)];
  record.draft ||= { rows: [] };
  record.draft.estimateAutomationHistory = [...(record.draft.estimateAutomationHistory || []), clone(audit)];
  record.draft.estimateLinkHistory = [...(record.draft.estimateLinkHistory || []), clone(audit)];
  return record;
}

export function applyEstimateF8PartialRecovery({
  linkedRecord,
  allRecords = [],
  diagnosis,
  operationId,
  actorId,
  occurredAt
} = {}) {
  if (diagnosis?.status !== 'PARTIAL_MISSING' || text(linkedRecord?.estimateId) !== text(diagnosis?.targetEstimateId)) {
    throw new Error('ESTIMATE_F8_PARTIAL_RECOVERY_PLAN_INVALID');
  }
  const sourceRecords = (allRecords || []).filter(record => record?.estimateKind !== 'LINKED_GROUP');
  const target = removeLinkedEstimateSources({
    linkedRecord,
    sourceRecords,
    removedEstimateIds: diagnosis.missingSourceIds,
    occurredAt
  });
  const audit = recoveryAudit({
    diagnosis,
    action: 'REMOVE_MISSING_LINKS_AND_REBUILD',
    operationId,
    actorId,
    occurredAt,
    afterSourceIds: (target.linkedEstimateSources || []).map(source => text(source?.estimateId))
  });
  return appendAudit(target, audit);
}

function standaloneRow(row = {}) {
  const target = clone(row);
  [
    'linkedSourceEstimateId', 'linkedSourceEstimateName', 'linkedSourceRowId', 'linkedSourceEstimateIds',
    'linkedSourceRefs', 'linkedFieldConflicts', 'linkedConflictResolvedFields', 'linkedPriceConflict',
    'linkedSyncFields', 'linkedEstimateSourceEditHistory'
  ].forEach(key => { delete target[key]; });
  target.inputOwnership = 'USER';
  target.editedFields = {};
  return target;
}

function numeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[,\s₩원]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function createEstimateF8IndependentCopy({
  linkedRecord,
  diagnosis,
  estimateId,
  catalogName,
  sortOrder,
  operationId,
  actorId,
  occurredAt
} = {}) {
  if (diagnosis?.status !== 'ALL_MISSING' || text(linkedRecord?.estimateId) !== text(diagnosis?.targetEstimateId)) {
    throw new Error('ESTIMATE_F8_INDEPENDENT_RECOVERY_PLAN_INVALID');
  }
  if (!text(estimateId) || !text(catalogName) || !text(occurredAt)) throw new Error('ESTIMATE_F8_INDEPENDENT_RECOVERY_IDENTITY_REQUIRED');
  const timestamp = text(occurredAt);
  const draft = clone(linkedRecord.draft || {});
  draft.catalogRecordId = text(estimateId);
  draft.estimateKind = 'INDIVIDUAL';
  draft.linkedEstimateSources = [];
  draft.rows = (draft.rows || []).filter(meaningfulRow).map(standaloneRow);
  draft.updatedAt = timestamp;
  draft.delivery = {
    status: 'SAVED',
    targetId: 'smart-input-estimates',
    targetRecordId: text(estimateId),
    deliveredAt: timestamp
  };
  const recoveryOrigin = {
    type: 'LINKED_SNAPSHOT_WITHOUT_SOURCES',
    sourceLinkedEstimateId: text(linkedRecord.estimateId),
    missingSourceIds: clone(diagnosis.missingSourceIds || []),
    confirmedBy: text(actorId),
    confirmedAt: timestamp,
    operationId: text(operationId)
  };
  draft.recoveryOrigin = clone(recoveryOrigin);
  const amount = draft.rows.reduce((sum, row) => {
    const quantity = numeric(row.quantity);
    const unitPrice = numeric(row.unitPrice);
    return sum + (quantity === null || unitPrice === null ? 0 : quantity * unitPrice);
  }, 0);
  const record = {
    estimateId: text(estimateId),
    catalogName: text(catalogName),
    estimateKind: 'INDIVIDUAL',
    linkedEstimateSources: [],
    customerId: text(draft?.header?.customerId),
    customerCode: text(draft?.header?.customerCode),
    customerName: text(draft?.header?.customerName),
    rowCount: draft.rows.length,
    amount,
    previousPrices: clone(linkedRecord.previousPrices || {}),
    sortOrder: Number(sortOrder || 1),
    createdAt: timestamp,
    updatedAt: timestamp,
    recoveryOrigin,
    draft
  };
  const audit = recoveryAudit({ diagnosis, action: 'CREATE_INDEPENDENT_COPY', operationId, actorId, occurredAt: timestamp });
  audit.sourceLinkedEstimateId = text(linkedRecord.estimateId);
  return appendAudit(record, audit);
}
