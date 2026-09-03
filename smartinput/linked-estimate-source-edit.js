export const LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA = 'ONEAPP_LINKED_ESTIMATE_SOURCE_EVIDENCE_V1';
export const LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA = 'ONEAPP_LINKED_ESTIMATE_SOURCE_EDIT_PLAN_V1';

export const LINKED_ESTIMATE_SOURCE_EDIT_FIELDS = Object.freeze([
  'masterProductId', 'productId', 'itemCode', 'itemName', 'secondaryName', 'searchInfo',
  'specification', 'boxQuantity', 'quantity', 'unit', 'unitPrice', 'sourceUnitPrice',
  'outPrice', 'wholesaleA', 'wholesaleB', 'listingPrice', 'marketPrice', 'promoPrice',
  'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI', 'memo',
  'description', 'noticePrice', 'customValues', 'matchStatus', 'reviewStatus',
  'productIdentityStatus', 'matchSource', 'referenceResolution'
]);

export const LINKED_ESTIMATE_FIELD_LABELS = Object.freeze({
  masterProductId: '마스터 ID',
  productId: '상품 ID',
  itemCode: '품목코드',
  itemName: '품목명',
  secondaryName: '보조품명',
  searchInfo: '검색정보',
  specification: '규격',
  boxQuantity: '박스수량',
  quantity: '수량',
  unit: '단위',
  unitPrice: '단가',
  sourceUnitPrice: '단가 표시값',
  outPrice: '출고가',
  wholesaleA: '도매가 A',
  wholesaleB: '도매가 B',
  listingPrice: '표시가',
  marketPrice: '시장가',
  promoPrice: '행사가',
  purchasePriceB: '구매가 B',
  priceD: '단가 D',
  lastPurchasePrice: '최종구매가',
  priceH: '단가 H',
  priceI: '단가 I',
  memo: '메모',
  description: '적요',
  noticePrice: '공지단가',
  customValues: '사용자지정',
  matchStatus: '매칭상태',
  reviewStatus: '검수상태',
  productIdentityStatus: '상품 식별상태',
  matchSource: '매칭근거',
  referenceResolution: '기준정보 판정'
});

const text = value => String(value ?? '').trim();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

export function numericInputState(value) {
  if (value === '' || value === null || value === undefined) return 'BLANK';
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[,\s₩원]/g, ''));
  if (!Number.isFinite(parsed)) return 'INVALID';
  if (Object.is(parsed, -0) || parsed === 0) return 'ZERO';
  return parsed < 0 ? 'NEGATIVE' : 'POSITIVE';
}

function numberValue(value) {
  if (numericInputState(value) === 'BLANK' || numericInputState(value) === 'INVALID') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[,\s₩원]/g, ''));
  return Object.is(parsed, -0) ? 0 : parsed;
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

function sourceEvidence(row = {}) {
  return clone({
    sourceType: row.sourceType || '',
    sourceBatchId: row.sourceBatchId || row.batchId || '',
    sourceDocumentKey: row.sourceDocumentKey || '',
    sourceRowKey: row.sourceRowKey || '',
    sourceRowNo: row.sourceRowNo || row.sourceLineNo || 0,
    sourceLineKey: row.sourceLineKey || '',
    sourceFingerprint: row.sourceFingerprint || '',
    originSystem: row.originSystem || '',
    originTransactionId: row.originTransactionId || '',
    fieldValues: row.fieldValues || {}
  });
}

function lineSnapshot(row = {}) {
  const quantityState = numericInputState(row.quantity);
  const unitPriceState = numericInputState(row.unitPrice);
  const quantity = numberValue(row.quantity);
  const unitPrice = numberValue(row.unitPrice);
  const amount = quantity !== null && unitPrice !== null ? quantity * unitPrice : null;
  return clone({
    rowId: text(row.rowId),
    itemCode: text(row.itemCode),
    itemName: text(row.itemName),
    specification: text(row.specification),
    unit: text(row.unit),
    quantity,
    quantityDisplay: own(row.fieldValues, 'voucher.estimate.line.quantity')
      ? String(row.fieldValues['voucher.estimate.line.quantity']?.currentDisplayValue ?? row.quantity ?? '')
      : String(row.quantity ?? ''),
    quantityState,
    unitPrice,
    unitPriceDisplay: own(row.fieldValues, 'voucher.estimate.line.unitPrice')
      ? String(row.fieldValues['voucher.estimate.line.unitPrice']?.currentDisplayValue ?? row.sourceUnitPrice ?? row.unitPrice ?? '')
      : String(row.sourceUnitPrice ?? row.unitPrice ?? ''),
    unitPriceState,
    amount,
    amountState: numericInputState(amount),
    memo: text(row.memo),
    description: text(row.description),
    values: Object.fromEntries(LINKED_ESTIMATE_SOURCE_EDIT_FIELDS.map(field => [field, clone(row[field])])),
    sourceEvidence: sourceEvidence(row)
  });
}

function validateWorkingRow(row, issues) {
  if (!text(row.itemCode) && !text(row.itemName)) {
    issues.push({ code: 'LINKED_ESTIMATE_ITEM_IDENTITY_REQUIRED', rowId: text(row.rowId), message: '품목코드와 품목명 중 하나는 필수입니다.' });
  }
  for (const field of ['quantity', 'unitPrice']) {
    if (numericInputState(row[field]) === 'INVALID') {
      issues.push({ code: `LINKED_ESTIMATE_${field === 'quantity' ? 'QUANTITY' : 'UNIT_PRICE'}_INVALID`, rowId: text(row.rowId), field, message: `${LINKED_ESTIMATE_FIELD_LABELS[field]}을 숫자, 0, 음수 또는 공란으로 입력하세요.` });
    }
  }
}

function normalizedSourceRefs(row = {}) {
  const refs = Array.isArray(row.linkedSourceRefs) && row.linkedSourceRefs.length
    ? row.linkedSourceRefs
    : (row.linkedSourceEstimateId && row.linkedSourceRowId
      ? [{ estimateId: row.linkedSourceEstimateId, estimateName: row.linkedSourceEstimateName, rowId: row.linkedSourceRowId }]
      : []);
  const seen = new Set();
  return refs.map(ref => ({
    estimateId: text(ref.estimateId),
    estimateName: text(ref.estimateName),
    rowId: text(ref.rowId)
  })).filter(ref => {
    const key = `${ref.estimateId}:${ref.rowId}`;
    if (!ref.estimateId || !ref.rowId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function changedFields(row, sources) {
  const requested = new Set([
    ...Object.entries(row.editedFields || {}).filter(([, edited]) => edited).map(([field]) => field),
    ...(Array.isArray(row.linkedSyncFields) ? row.linkedSyncFields : [])
  ]);
  if (requested.has('itemCode') || requested.has('itemName')) {
    ['masterProductId', 'productId', 'matchStatus', 'reviewStatus', 'productIdentityStatus', 'matchSource', 'referenceResolution']
      .forEach(field => requested.add(field));
  }
  return [...requested]
    .filter(field => LINKED_ESTIMATE_SOURCE_EDIT_FIELDS.includes(field))
    .filter(field => sources.some(source => !same(source.sourceRow[field], row[field])));
}

function recordTitle(record = {}) {
  return text(record.catalogName) || text(record.customerName) || text(record.estimateId) || '견적서명 미지정';
}

function sourceCandidate(record, sourceRow = null, ref = null) {
  const sourceRows = record?.draft?.rows || [];
  const rowIndex = sourceRow ? sourceRows.findIndex(row => row.rowId === sourceRow.rowId) : -1;
  return {
    key: sourceRow ? `${record.estimateId}:${sourceRow.rowId}` : record.estimateId,
    estimateId: record.estimateId,
    estimateName: ref?.estimateName || recordTitle(record),
    estimateUpdatedAt: record.updatedAt || '',
    sourceRowId: sourceRow?.rowId || '',
    sourceRowNo: rowIndex >= 0 ? rowIndex + 1 : null,
    before: sourceRow ? lineSnapshot(sourceRow) : null,
    expectedRow: sourceRow ? clone(sourceRow) : null
  };
}

export function inspectLinkedEstimateSourceEdits({ linkedRecord, currentDraft, sourceRecords = [] } = {}) {
  const issues = [];
  if (linkedRecord?.estimateKind !== 'LINKED_GROUP') {
    issues.push({ code: 'LINKED_ESTIMATE_RECORD_REQUIRED', message: '연동견적서만 원본별 수정할 수 있습니다.' });
  }
  const recordsById = new Map(sourceRecords
    .filter(record => record?.estimateId && record.estimateKind !== 'LINKED_GROUP')
    .map(record => [record.estimateId, record]));
  const linkedSourceIds = [...new Set((linkedRecord?.linkedEstimateSources || []).map(source => text(source.estimateId)).filter(Boolean))];
  const availableNewRowSources = linkedSourceIds.map(estimateId => recordsById.get(estimateId)).filter(Boolean);
  linkedSourceIds.filter(estimateId => !recordsById.has(estimateId)).forEach(estimateId => {
    issues.push({ code: 'LINKED_ESTIMATE_SOURCE_RECORD_MISSING', estimateId, message: `연결된 원본 견적서 ${estimateId}을 찾을 수 없습니다.` });
  });
  const rows = [];
  (currentDraft?.rows || []).filter(meaningfulRow).forEach((row, index) => {
    const rowId = text(row.rowId) || `LINKED-WORK-ROW-${index + 1}`;
    const refs = normalizedSourceRefs(row);
    if (!refs.length) {
      validateWorkingRow(row, issues);
      const sources = availableNewRowSources.map(record => sourceCandidate(record));
      if (!sources.length) issues.push({ code: 'LINKED_ESTIMATE_NEW_ROW_SOURCE_UNAVAILABLE', rowId, message: '신규 행을 추가할 원본 견적서가 없습니다.' });
      rows.push({
        rowId,
        rowNo: index + 1,
        operation: 'ADD',
        changedFields: LINKED_ESTIMATE_SOURCE_EDIT_FIELDS.filter(field => meaningful(row[field])),
        after: lineSnapshot(row),
        workingRow: clone(row),
        sources
      });
      return;
    }
    const sources = [];
    refs.forEach(ref => {
      const record = recordsById.get(ref.estimateId);
      if (!record) {
        issues.push({ code: 'LINKED_ESTIMATE_SOURCE_RECORD_MISSING', rowId, estimateId: ref.estimateId, message: `원본 견적서 ${ref.estimateId}을 찾을 수 없습니다.` });
        return;
      }
      const sourceRow = (record.draft?.rows || []).find(candidate => candidate.rowId === ref.rowId);
      if (!sourceRow) {
        issues.push({ code: 'LINKED_ESTIMATE_SOURCE_ROW_MISSING', rowId, estimateId: ref.estimateId, sourceRowId: ref.rowId, message: `${recordTitle(record)}의 원본 행 ${ref.rowId}을 찾을 수 없습니다.` });
        return;
      }
      sources.push({
        ...sourceCandidate(record, sourceRow, ref),
        differencesFromWorking: LINKED_ESTIMATE_SOURCE_EDIT_FIELDS.filter(field => !same(sourceRow[field], row[field]))
      });
    });
    const fields = changedFields(row, sources.map(source => ({ ...source, sourceRow: source.expectedRow })));
    if (!fields.length) return;
    validateWorkingRow(row, issues);
    rows.push({
      rowId,
      rowNo: index + 1,
      operation: 'UPDATE',
      changedFields: fields,
      after: lineSnapshot(row),
      workingRow: clone(row),
      sources
    });
  });
  return {
    schemaVersion: LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA,
    linkedEstimateId: text(linkedRecord?.estimateId),
    linkedEstimateName: recordTitle(linkedRecord),
    rows,
    issues
  };
}

function requiredSelection(row, selections) {
  if (row.operation === 'UPDATE' && row.sources.length === 1) return row.sources[0];
  const selectedKey = text(selections?.[row.rowId]);
  const selected = row.sources.find(source => source.key === selectedKey);
  if (selected) return selected;
  const code = row.operation === 'ADD'
    ? 'LINKED_ESTIMATE_NEW_ROW_SOURCE_REQUIRED'
    : 'LINKED_ESTIMATE_SOURCE_SELECTION_REQUIRED';
  const error = new Error(code);
  error.rowId = row.rowId;
  throw error;
}

export function createLinkedEstimateSourceEditPlan({ evidence, selections = {}, actor, occurredAt, planId } = {}) {
  if (evidence?.schemaVersion !== LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA) throw new Error('LINKED_ESTIMATE_SOURCE_EVIDENCE_INVALID');
  if (evidence.issues?.length) {
    const error = new Error(evidence.issues[0].code || 'LINKED_ESTIMATE_SOURCE_EVIDENCE_INVALID');
    error.issues = clone(evidence.issues);
    throw error;
  }
  if (!text(actor)) throw new Error('LINKED_ESTIMATE_SOURCE_ACTOR_REQUIRED');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text(occurredAt))) {
    throw new Error('LINKED_ESTIMATE_SOURCE_OCCURRED_AT_INVALID');
  }
  const operations = evidence.rows.map(row => {
    const selected = requiredSelection(row, selections);
    return {
      operation: row.operation,
      workingRowId: row.rowId,
      workingRowNo: row.rowNo,
      changedFields: [...row.changedFields],
      before: clone(selected.before),
      after: clone(row.after),
      workingRow: clone(row.workingRow),
      target: clone(selected)
    };
  });
  return {
    schemaVersion: LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA,
    planId: text(planId) || `LINKED-SOURCE-EDIT:${evidence.linkedEstimateId}:${occurredAt}`,
    linkedEstimateId: evidence.linkedEstimateId,
    linkedEstimateName: evidence.linkedEstimateName,
    actor: text(actor),
    occurredAt: text(occurredAt),
    operations
  };
}

function updateTrackedField(row, field, workingRow) {
  const suffixByField = {
    itemCode: '.line.productCode', itemName: '.line.productName', specification: '.line.specification',
    quantity: '.line.quantity', unit: '.line.unit', unitPrice: '.line.unitPrice', memo: '.line.memo'
  };
  const suffix = suffixByField[field];
  if (!suffix || !row.fieldValues || typeof row.fieldValues !== 'object') return;
  const entry = Object.entries(row.fieldValues).find(([fieldId]) => fieldId.endsWith(suffix));
  if (!entry) return;
  const [fieldId, tracked] = entry;
  const displayValue = field === 'unitPrice'
    ? String(workingRow.sourceUnitPrice ?? workingRow.unitPrice ?? '')
    : String(workingRow[field] ?? '');
  row.fieldValues = {
    ...row.fieldValues,
    [fieldId]: {
      ...tracked,
      currentDisplayValue: displayValue,
      parsedValue: clone(workingRow[field]),
      edited: true,
      evidence: clone(tracked?.evidence)
    }
  };
}

function lineAuditSnapshot(row) {
  const snapshot = lineSnapshot(row);
  delete snapshot.values;
  return snapshot;
}

function updateSummary(record) {
  const rows = record.draft?.rows || [];
  record.rowCount = rows.length;
  record.amount = rows.reduce((sum, row) => {
    const quantity = numberValue(row.quantity);
    const unitPrice = numberValue(row.unitPrice);
    return sum + (quantity === null || unitPrice === null ? 0 : quantity * unitPrice);
  }, 0);
}

function clearLinkedEditMarkers(row) {
  row.editedFields = {};
  row.linkedSyncFields = [];
  row.linkedFieldConflicts = [];
  row.linkedConflictResolvedFields = [];
  row.linkedPriceConflict = false;
  return row;
}

function sanitizeNewSourceRow(row, target, plan) {
  const next = clone(row);
  next.rowId = text(next.rowId) || `SIROW-LINKED-${plan.planId}`;
  next.inputOwnership = 'USER';
  next.linkedSourceEstimateId = '';
  next.linkedSourceEstimateName = '';
  next.linkedSourceRowId = '';
  next.linkedSourceEstimateIds = [];
  next.linkedSourceRefs = [];
  clearLinkedEditMarkers(next);
  next.linkedEstimateSourceEditHistory = [
    ...(next.linkedEstimateSourceEditHistory || []),
    {
      schemaVersion: LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA,
      planId: plan.planId,
      action: 'ADD_FROM_LINKED_ESTIMATE',
      linkedEstimateId: plan.linkedEstimateId,
      targetEstimateId: target.estimateId,
      targetSourceRowId: next.rowId,
      actor: plan.actor,
      occurredAt: plan.occurredAt,
      before: null,
      after: lineAuditSnapshot(next)
    }
  ];
  return next;
}

export function applyLinkedEstimateSourceEditPlan({ plan, linkedRecord, sourceRecords = [] } = {}) {
  if (plan?.schemaVersion !== LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA) throw new Error('LINKED_ESTIMATE_SOURCE_EDIT_PLAN_INVALID');
  if (text(linkedRecord?.estimateId) !== plan.linkedEstimateId || linkedRecord?.estimateKind !== 'LINKED_GROUP') {
    throw new Error('LINKED_ESTIMATE_SOURCE_TARGET_MISMATCH');
  }
  const recordsById = new Map(sourceRecords
    .filter(record => record?.estimateId && record.estimateKind !== 'LINKED_GROUP')
    .map(record => [record.estimateId, clone(record)]));
  const changedIds = new Set();
  const target = clone(linkedRecord);
  const targetRows = new Map((target.draft?.rows || []).map(row => [row.rowId, row]));

  for (const operation of plan.operations) {
    const source = recordsById.get(operation.target.estimateId);
    if (!source?.draft?.rows) throw new Error('LINKED_ESTIMATE_SOURCE_STALE');
    if (operation.operation === 'UPDATE') {
      const sourceIndex = source.draft.rows.findIndex(row => row.rowId === operation.target.sourceRowId);
      if (sourceIndex < 0 || !same(source.draft.rows[sourceIndex], operation.target.expectedRow)) {
        throw new Error('LINKED_ESTIMATE_SOURCE_STALE');
      }
      const original = source.draft.rows[sourceIndex];
      const next = clone(original);
      operation.changedFields.forEach(field => {
        next[field] = clone(operation.workingRow[field]);
        updateTrackedField(next, field, operation.workingRow);
      });
      if (operation.changedFields.includes('unitPrice')) next.sourceUnitPrice = String(operation.workingRow.sourceUnitPrice ?? operation.workingRow.unitPrice ?? '');
      next.linkedEstimateSourceEditHistory = [
        ...(next.linkedEstimateSourceEditHistory || []),
        {
          schemaVersion: LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA,
          planId: plan.planId,
          action: 'UPDATE_FROM_LINKED_ESTIMATE',
          linkedEstimateId: plan.linkedEstimateId,
          targetEstimateId: source.estimateId,
          targetSourceRowId: next.rowId,
          changedFields: [...operation.changedFields],
          actor: plan.actor,
          occurredAt: plan.occurredAt,
          before: lineAuditSnapshot(original),
          after: lineAuditSnapshot(next)
        }
      ];
      source.draft.rows[sourceIndex] = next;
    } else if (operation.operation === 'ADD') {
      if (!text(operation.workingRow.itemCode) && !text(operation.workingRow.itemName)) throw new Error('LINKED_ESTIMATE_ITEM_IDENTITY_REQUIRED');
      if (source.draft.rows.some(row => row.rowId === operation.workingRowId)) throw new Error('LINKED_ESTIMATE_NEW_ROW_ID_CONFLICT');
      source.draft.rows.push(sanitizeNewSourceRow(operation.workingRow, operation.target, plan));
      const linkedRow = targetRows.get(operation.workingRowId);
      if (linkedRow) {
        linkedRow.inputOwnership = 'SOURCE';
        linkedRow.linkedSourceEstimateId = source.estimateId;
        linkedRow.linkedSourceEstimateName = operation.target.estimateName;
        linkedRow.linkedSourceRowId = operation.workingRowId;
        linkedRow.linkedSourceEstimateIds = [source.estimateId];
        linkedRow.linkedSourceRefs = [{ estimateId: source.estimateId, estimateName: operation.target.estimateName, rowId: operation.workingRowId }];
      }
    } else {
      throw new Error('LINKED_ESTIMATE_SOURCE_OPERATION_INVALID');
    }
    source.updatedAt = plan.occurredAt;
    if (source.draft) source.draft.updatedAt = plan.occurredAt;
    updateSummary(source);
    changedIds.add(source.estimateId);
    const linkedRow = targetRows.get(operation.workingRowId);
    if (linkedRow) clearLinkedEditMarkers(linkedRow);
  }

  const audit = {
    schemaVersion: LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA,
    planId: plan.planId,
    actor: plan.actor,
    occurredAt: plan.occurredAt,
    linkedEstimateId: plan.linkedEstimateId,
    operations: plan.operations.map(operation => ({
      action: operation.operation,
      workingRowId: operation.workingRowId,
      targetEstimateId: operation.target.estimateId,
      targetEstimateName: operation.target.estimateName,
      targetSourceRowId: operation.operation === 'ADD' ? operation.workingRowId : operation.target.sourceRowId,
      changedFields: [...operation.changedFields],
      before: clone(operation.before),
      after: clone(operation.after)
    }))
  };
  target.linkedSourceEditHistory = [...(target.linkedSourceEditHistory || []), audit];
  if (target.draft) {
    target.draft.linkedSourceEditHistory = [...(target.draft.linkedSourceEditHistory || []), clone(audit)];
    target.draft.updatedAt = plan.occurredAt;
  }
  target.updatedAt = plan.occurredAt;
  target.linkedEstimateSources = (target.linkedEstimateSources || []).map(source => (
    changedIds.has(source.estimateId) ? { ...source, updatedAt: plan.occurredAt } : source
  ));
  updateSummary(target);
  return {
    linkedRecord: target,
    changedSourceIds: [...changedIds],
    upserts: [target, ...[...changedIds].map(estimateId => recordsById.get(estimateId))],
    audit
  };
}
