// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.


// ============================================================================
// linked-estimate-source-edit.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const linkedEstimateSourceEditSection = (() => {


const LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA = 'ONEAPP_LINKED_ESTIMATE_SOURCE_EVIDENCE_V1';
const LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA = 'ONEAPP_LINKED_ESTIMATE_SOURCE_EDIT_PLAN_V1';

const LINKED_ESTIMATE_SOURCE_EDIT_FIELDS = Object.freeze([
  'masterProductId', 'productId', 'itemCode', 'itemName', 'secondaryName', 'searchInfo',
  'specification', 'boxQuantity', 'quantity', 'unit', 'unitPrice', 'sourceUnitPrice',
  'outPrice', 'wholesaleA', 'wholesaleB', 'listingPrice', 'marketPrice', 'promoPrice',
  'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI', 'memo',
  'description', 'noticePrice', 'customValues', 'matchStatus', 'reviewStatus',
  'productIdentityStatus', 'matchSource', 'referenceResolution'
]);

const LINKED_ESTIMATE_FIELD_LABELS = Object.freeze({
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
const LINKED_ESTIMATE_CONFLICT_FIELDS = Object.freeze(['quantity', 'unit', 'unitPrice', 'memo', 'description', 'noticePrice']);

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

function normalizedProductKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}<>,.:;·_-]+/g, '');
}

function numericInputState(value) {
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

function inspectLinkedEstimateSourceEdits({ linkedRecord, baselineLinkedRecord = null, currentDraft, sourceRecords = [] } = {}) {
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
  const currentSourceSignatures = new Set((currentDraft?.rows || [])
    .filter(meaningfulRow)
    .map(linkedRefSignature)
    .filter(Boolean));
  const baselineRows = baselineLinkedRecord?.estimateId === linkedRecord?.estimateId
    ? (baselineLinkedRecord.draft?.rows || [])
    : (linkedRecord?.draft?.rows || []);
  baselineRows.filter(meaningfulRow).forEach((row, index) => {
    const signature = linkedRefSignature(row);
    if (!signature || currentSourceSignatures.has(signature)) return;
    const rowId = text(row.rowId) || `LINKED-DELETED-ROW-${index + 1}`;
    const sources = normalizedSourceRefs(row).flatMap(ref => {
      const record = recordsById.get(ref.estimateId);
      if (!record) {
        issues.push({ code: 'LINKED_ESTIMATE_SOURCE_RECORD_MISSING', rowId, estimateId: ref.estimateId, message: `원본 견적서 ${ref.estimateId}을 찾을 수 없습니다.` });
        return [];
      }
      const sourceRow = (record.draft?.rows || []).find(candidate => candidate.rowId === ref.rowId);
      if (!sourceRow) {
        issues.push({ code: 'LINKED_ESTIMATE_SOURCE_ROW_MISSING', rowId, estimateId: ref.estimateId, sourceRowId: ref.rowId, message: `${recordTitle(record)}의 원본 행 ${ref.rowId}을 찾을 수 없습니다.` });
        return [];
      }
      return [sourceCandidate(record, sourceRow, ref)];
    });
    if (!sources.length) return;
    rows.push({
      rowId,
      rowNo: index + 1,
      operation: 'DELETE',
      changedFields: [],
      before: lineSnapshot(row),
      after: null,
      workingRow: null,
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
  if (row.operation === 'DELETE') return null;
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

function createLinkedEstimateSourceEditPlan({ evidence, selections = {}, actor, occurredAt, planId } = {}) {
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
    if (row.operation === 'DELETE') {
      return {
        operation: row.operation,
        workingRowId: row.rowId,
        workingRowNo: row.rowNo,
        changedFields: [],
        before: clone(row.before),
        after: null,
        workingRow: null,
        target: clone(row.sources[0]),
        targets: row.sources.map(clone)
      };
    }
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

function comparableWorkingDraft(input) {
  const draft = clone(input || null);
  if (!draft) return null;
  delete draft.documentId;
  delete draft.updatedAt;
  delete draft.delivery;
  if (draft.header) {
    delete draft.header.customerMappingSource;
    if (draft.header.deliveryPolicySnapshot) delete draft.header.deliveryPolicySnapshot.evaluatedAt;
  }
  (draft.rows || []).forEach(row => {
    delete row.editedFields;
    delete row.candidateProducts;
    delete row.linkedSyncFields;
    delete row.linkedConflictResolvedFields;
  });
  return draft;
}

function linkedEstimateWorkingDraftsEquivalent(left, right) {
  return same(comparableWorkingDraft(left), comparableWorkingDraft(right));
}

function inspectLinkedEstimateSourceWorkingCopyConflicts({ plan, sourceRecords = [], workingCopies = [] } = {}) {
  if (plan?.schemaVersion !== LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA) throw new Error('LINKED_ESTIMATE_SOURCE_EDIT_PLAN_INVALID');
  const selectedIds = new Set(plan.operations.flatMap(operation => (
    operation.operation === 'DELETE' ? (operation.targets || []) : [operation.target]
  )).map(target => text(target?.estimateId)).filter(Boolean));
  const recordsById = new Map(sourceRecords.filter(record => record?.estimateId).map(record => [record.estimateId, record]));
  const workingById = new Map(workingCopies.filter(copy => copy?.estimateId && copy?.draft).map(copy => [copy.estimateId, copy.draft]));
  return [...selectedIds].flatMap(estimateId => {
    const record = recordsById.get(estimateId);
    const workingDraft = workingById.get(estimateId);
    if (!record?.draft || !workingDraft || linkedEstimateWorkingDraftsEquivalent(record.draft, workingDraft)) return [];
    return [{
      code: 'LINKED_ESTIMATE_SOURCE_WORKING_COPY_CONFLICT',
      estimateId,
      estimateName: recordTitle(record),
      message: `${recordTitle(record)}에 저장하지 않은 작업본이 있습니다.`
    }];
  });
}

function linkedRefSignature(row = {}) {
  return normalizedSourceRefs(row).map(ref => `${ref.estimateId}:${ref.rowId}`).sort().join('|');
}

function restoreLinkedEstimateWorkingRowEdits({ materializedRows = [], workingRows = [] } = {}) {
  const workingByRefs = new Map(workingRows.map(row => [linkedRefSignature(row), row]).filter(([signature]) => signature));
  return materializedRows.map(row => {
    const working = workingByRefs.get(linkedRefSignature(row));
    if (!working) return clone(row);
    const fields = [...new Set([
      ...Object.entries(working.editedFields || {}).filter(([, edited]) => edited).map(([field]) => field),
      ...(working.linkedSyncFields || [])
    ])].filter(field => LINKED_ESTIMATE_SOURCE_EDIT_FIELDS.includes(field));
    if (!fields.length) return clone(row);
    const restored = clone(row);
    fields.forEach(field => { restored[field] = clone(working[field]); });
    if (fields.includes('unitPrice')) restored.sourceUnitPrice = String(working.sourceUnitPrice ?? working.unitPrice ?? '');
    restored.fieldValues = clone(restored.fieldValues || {});
    fields.forEach(field => updateTrackedField(restored, field, working));
    restored.editedFields = clone(working.editedFields || {});
    restored.linkedSyncFields = [...new Set(working.linkedSyncFields || [])];
    restored.linkedFieldConflicts = [...new Set(working.linkedFieldConflicts || [])];
    restored.linkedConflictResolvedFields = [...new Set(working.linkedConflictResolvedFields || [])];
    restored.linkedPriceConflict = Boolean(working.linkedPriceConflict);
    return restored;
  });
}

function rebaseLinkedEstimateWorkingDraft({ baselineDraft, workingDraft, rebuiltRecord } = {}) {
  if (!baselineDraft || !workingDraft || rebuiltRecord?.estimateKind !== 'LINKED_GROUP' || !rebuiltRecord.draft) {
    throw new Error('LINKED_ESTIMATE_WORKING_REBASE_INPUT_REQUIRED');
  }
  const baselineByRefs = new Map((baselineDraft.rows || []).map(row => [linkedRefSignature(row), row]).filter(([signature]) => signature));
  const rebuiltByRefs = new Map((rebuiltRecord.draft.rows || []).map(row => [linkedRefSignature(row), row]).filter(([signature]) => signature));
  const conflicts = [];
  (workingDraft.rows || []).forEach(workingRow => {
    const signature = linkedRefSignature(workingRow);
    if (!signature) return;
    const baselineRow = baselineByRefs.get(signature);
    const rebuiltRow = rebuiltByRefs.get(signature);
    if (!baselineRow || !rebuiltRow) return;
    const editedFields = [...new Set([
      ...Object.entries(workingRow.editedFields || {}).filter(([, edited]) => edited).map(([field]) => field),
      ...(workingRow.linkedSyncFields || [])
    ])].filter(field => LINKED_ESTIMATE_SOURCE_EDIT_FIELDS.includes(field));
    editedFields.forEach(field => {
      const workingChanged = !same(workingRow[field], baselineRow[field]);
      const sourceChanged = !same(rebuiltRow[field], baselineRow[field]);
      const converged = same(workingRow[field], rebuiltRow[field]);
      if (workingChanged && sourceChanged && !converged) {
        conflicts.push({
          code: 'LINKED_ESTIMATE_WORKING_REBASE_CONFLICT',
          rowId: text(workingRow.rowId),
          field,
          sourceRefs: normalizedSourceRefs(workingRow),
          baselineValue: clone(baselineRow[field]),
          workingValue: clone(workingRow[field]),
          sourceValue: clone(rebuiltRow[field]),
          message: `${workingRow.itemName || workingRow.itemCode || '품목'}의 ${LINKED_ESTIMATE_FIELD_LABELS[field] || field} 값이 원본과 작업본에서 모두 변경되었습니다.`
        });
      }
    });
  });
  if (conflicts.length) return { draft: null, conflicts };
  const draft = clone(rebuiltRecord.draft);
  draft.rows = restoreLinkedEstimateWorkingRowEdits({
    materializedRows: draft.rows || [],
    workingRows: workingDraft.rows || []
  });
  const manualById = new Map((workingDraft.rows || [])
    .filter(row => !linkedRefSignature(row) && meaningfulRow(row))
    .map(row => [text(row.rowId), clone(row)]));
  draft.rows = draft.rows.map(row => manualById.get(text(row.rowId)) || row);
  const presentIds = new Set(draft.rows.map(row => text(row.rowId)));
  manualById.forEach((row, rowId) => { if (!presentIds.has(rowId)) draft.rows.push(row); });
  return { draft, conflicts: [] };
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

function linkedProductKey(row = {}) {
  const code = normalizedProductKey(row.itemCode);
  if (code) return `CODE:${code}`;
  return `NAME:${normalizedProductKey(row.itemName)}|${normalizedProductKey(row.specification)}|${normalizedProductKey(row.unit)}`;
}

function materializeLinkedRows(target, recordsById) {
  const uniqueRows = new Map();
  (target.linkedEstimateSources || []).forEach(sourceMeta => {
    const source = recordsById.get(sourceMeta.estimateId);
    (source?.draft?.rows || []).forEach(sourceRow => {
      const key = linkedProductKey(sourceRow);
      const ref = { estimateId: source.estimateId, estimateName: recordTitle(source), rowId: sourceRow.rowId };
      const existing = uniqueRows.get(key);
      if (existing) {
        const conflicts = LINKED_ESTIMATE_CONFLICT_FIELDS.filter(field => String(existing[field] ?? '') !== String(sourceRow[field] ?? ''));
        existing.linkedFieldConflicts = [...new Set([...(existing.linkedFieldConflicts || []), ...conflicts])];
        existing.linkedPriceConflict = existing.linkedFieldConflicts.includes('unitPrice');
        existing.linkedSourceRefs.push(ref);
        existing.linkedSourceEstimateIds.push(source.estimateId);
        existing.linkedSourceEstimateName = `${existing.linkedSourceRefs.length}개 견적서`;
        return;
      }
      uniqueRows.set(key, {
        ...clone(sourceRow),
        rowId: `LINKED:${source.estimateId}:${sourceRow.rowId}`,
        linkedSourceEstimateId: source.estimateId,
        linkedSourceEstimateName: recordTitle(source),
        linkedSourceRowId: sourceRow.rowId,
        linkedSourceEstimateIds: [source.estimateId],
        linkedSourceRefs: [ref],
        inputOwnership: 'SOURCE',
        editedFields: {},
        linkedSyncFields: [],
        linkedFieldConflicts: [],
        linkedConflictResolvedFields: [],
        linkedPriceConflict: false
      });
    });
  });
  const manualRows = (target.draft?.rows || []).filter(row => !normalizedSourceRefs(row).length && meaningfulRow(row)).map(row => clearLinkedEditMarkers(clone(row)));
  return [...uniqueRows.values(), ...manualRows];
}

function removeLinkedEstimateSources({ linkedRecord, sourceRecords = [], removedEstimateIds = [], occurredAt } = {}) {
  if (linkedRecord?.estimateKind !== 'LINKED_GROUP') throw new Error('LINKED_ESTIMATE_RECORD_REQUIRED');
  const removedIds = new Set(removedEstimateIds.map(text).filter(Boolean));
  const target = clone(linkedRecord);
  target.linkedEstimateSources = (target.linkedEstimateSources || []).filter(source => !removedIds.has(text(source.estimateId)));
  target.draft ||= { rows: [] };
  target.draft.linkedEstimateSources = target.linkedEstimateSources.map(clone);
  const recordsById = new Map(sourceRecords
    .filter(record => record?.estimateId && record.estimateKind !== 'LINKED_GROUP' && !removedIds.has(text(record.estimateId)))
    .map(record => [record.estimateId, record]));
  target.draft.rows = materializeLinkedRows(target, recordsById);
  const timestamp = text(occurredAt) || new Date().toISOString();
  target.updatedAt = timestamp;
  target.draft.updatedAt = timestamp;
  updateSummary(target);
  return target;
}

function rebuildLinkedEstimateRecord({ linkedRecord, sourceRecords = [], occurredAt, operationId = '' } = {}) {
  if (linkedRecord?.estimateKind !== 'LINKED_GROUP') throw new Error('LINKED_ESTIMATE_RECORD_REQUIRED');
  const timestamp = text(occurredAt) || new Date().toISOString();
  const recordsById = new Map((sourceRecords || [])
    .filter(record => record?.estimateId && record.estimateKind !== 'LINKED_GROUP')
    .map(record => [text(record.estimateId), record]));
  const missingSourceIds = (linkedRecord.linkedEstimateSources || [])
    .map(source => text(source.estimateId))
    .filter(estimateId => estimateId && !recordsById.has(estimateId));
  if (missingSourceIds.length) {
    const error = new Error(`연동견적서 원본 ${missingSourceIds.length}개를 찾을 수 없습니다.`);
    error.code = 'LINKED_ESTIMATE_SOURCE_MISSING';
    error.missingSourceIds = missingSourceIds;
    throw error;
  }
  const target = clone(linkedRecord);
  target.linkedEstimateSources = (target.linkedEstimateSources || []).map(source => {
    const record = recordsById.get(text(source.estimateId));
    return {
      ...source,
      catalogName: recordTitle(record),
      updatedAt: text(record.updatedAt)
    };
  });
  target.draft ||= { rows: [] };
  target.draft.linkedEstimateSources = target.linkedEstimateSources.map(clone);
  target.draft.rows = materializeLinkedRows(target, recordsById);
  target.updatedAt = timestamp;
  target.draft.updatedAt = timestamp;
  const audit = {
    schemaVersion: 'ONEAPP_SMARTINPUT_ESTIMATE_LINK_SYNC_V1',
    operationId: text(operationId),
    action: 'AUTO_REBUILD_FROM_SOURCES',
    sourceEstimateIds: target.linkedEstimateSources.map(source => text(source.estimateId)),
    occurredAt: timestamp
  };
  target.estimateLinkHistory = [...(target.estimateLinkHistory || []), audit];
  target.draft.estimateLinkHistory = [...(target.draft.estimateLinkHistory || []), clone(audit)];
  updateSummary(target);
  return target;
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

function applyLinkedEstimateSourceEditPlan({ plan, linkedRecord, sourceRecords = [] } = {}) {
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
    if (operation.operation === 'DELETE') {
      for (const deletionTarget of operation.targets || [operation.target]) {
        const source = recordsById.get(deletionTarget?.estimateId);
        if (!source?.draft?.rows) throw new Error('LINKED_ESTIMATE_SOURCE_STALE');
        const sourceIndex = source.draft.rows.findIndex(row => row.rowId === deletionTarget.sourceRowId);
        if (sourceIndex < 0 || !same(source.draft.rows[sourceIndex], deletionTarget.expectedRow)) {
          throw new Error('LINKED_ESTIMATE_SOURCE_STALE');
        }
        source.draft.rows.splice(sourceIndex, 1);
        source.updatedAt = plan.occurredAt;
        source.draft.updatedAt = plan.occurredAt;
        updateSummary(source);
        changedIds.add(source.estimateId);
      }
      continue;
    }
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

  const deletedSourceIds = new Set([...changedIds].filter(estimateId => (
    !(recordsById.get(estimateId)?.draft?.rows || []).some(meaningfulRow)
  )));
  if (deletedSourceIds.size) {
    target.linkedEstimateSources = (target.linkedEstimateSources || []).filter(source => !deletedSourceIds.has(text(source.estimateId)));
    if (target.draft) target.draft.linkedEstimateSources = target.linkedEstimateSources.map(clone);
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
      targetEstimateId: operation.target?.estimateId || '',
      targetEstimateIds: (operation.operation === 'DELETE' ? (operation.targets || []) : [operation.target]).map(item => item?.estimateId).filter(Boolean),
      targetEstimateName: operation.target?.estimateName || '',
      targetSourceRowId: operation.operation === 'ADD' ? operation.workingRowId : (operation.target?.sourceRowId || ''),
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
  target.draft.rows = materializeLinkedRows(target, recordsById);
  updateSummary(target);
  return {
    linkedRecord: target,
    changedSourceIds: [...changedIds],
    deletedSourceIds: [...deletedSourceIds],
    upserts: [target, ...[...changedIds].filter(estimateId => !deletedSourceIds.has(estimateId)).map(estimateId => recordsById.get(estimateId))],
    deletes: [...deletedSourceIds],
    audit
  };
}

return { LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA, LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA, LINKED_ESTIMATE_SOURCE_EDIT_FIELDS, LINKED_ESTIMATE_FIELD_LABELS, numericInputState, inspectLinkedEstimateSourceEdits, createLinkedEstimateSourceEditPlan, linkedEstimateWorkingDraftsEquivalent, inspectLinkedEstimateSourceWorkingCopyConflicts, restoreLinkedEstimateWorkingRowEdits, rebaseLinkedEstimateWorkingDraft, removeLinkedEstimateSources, rebuildLinkedEstimateRecord, applyLinkedEstimateSourceEditPlan };
})();

// ============================================================================
// estimate-f8-source-plan.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const estimateF8SourcePlanSection = (() => {


const text = value => String(value ?? '').trim();
const unique = values => [...new Set((values || []).map(text).filter(Boolean))];

function sameIds(left = [], right = []) {
  const a = unique(left).sort();
  const b = unique(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function workingDraftFor(workingDrafts, estimateId) {
  if (!estimateId) return null;
  if (workingDrafts instanceof Map) return workingDrafts.get(estimateId) || null;
  if (Array.isArray(workingDrafts)) {
    return workingDrafts.find(entry => text(entry?.estimateId) === estimateId)?.draft || null;
  }
  return workingDrafts && typeof workingDrafts === 'object'
    ? (workingDrafts[estimateId] || null)
    : null;
}

function draftForRecord(record, currentDraft, workingDrafts) {
  const estimateId = text(record?.estimateId);
  if (estimateId && text(currentDraft?.catalogRecordId) === estimateId) {
    return { draft: currentDraft, error: '' };
  }
  const workingDraft = workingDraftFor(workingDrafts, estimateId);
  if (workingDraft && text(workingDraft.catalogRecordId) !== estimateId) {
    return { draft: null, error: `견적서 ${estimateId}의 작업본 식별자가 일치하지 않습니다.` };
  }
  const storedDraft = record?.draft || null;
  if (!workingDraft && storedDraft && text(storedDraft.catalogRecordId) && text(storedDraft.catalogRecordId) !== estimateId) {
    return { draft: null, error: `견적서 ${estimateId}의 저장 식별자가 일치하지 않습니다.` };
  }
  return { draft: workingDraft || storedDraft, error: '' };
}

function metadataSourceIds(value = null) {
  return unique((value?.linkedEstimateSources || []).map(source => source?.estimateId));
}

function rowSourceIds(draft = null) {
  const ids = [];
  (draft?.rows || []).forEach(row => {
    (row?.linkedSourceEstimateIds || []).forEach(id => ids.push(id));
    (row?.linkedSourceRefs || []).forEach(source => ids.push(source?.estimateId));
    ids.push(row?.linkedSourceEstimateId);
  });
  return unique(ids);
}

function normalizedRowRefs(row = null) {
  if (Array.isArray(row?.linkedSourceRefs) && row.linkedSourceRefs.length) {
    return row.linkedSourceRefs.map(ref => ({ estimateId: text(ref?.estimateId), rowId: text(ref?.rowId) }));
  }
  return row?.linkedSourceEstimateId && row?.linkedSourceRowId
    ? [{ estimateId: text(row.linkedSourceEstimateId), rowId: text(row.linkedSourceRowId) }]
    : [];
}

function invalidLinkedRefStructure(draft = null) {
  for (let rowIndex = 0; rowIndex < (draft?.rows || []).length; rowIndex += 1) {
    const row = draft.rows[rowIndex];
    const explicitRefs = Array.isArray(row?.linkedSourceRefs) && row.linkedSourceRefs.length > 0;
    const refs = normalizedRowRefs(row);
    const legacyEstimateId = text(row?.linkedSourceEstimateId);
    const legacyRowId = text(row?.linkedSourceRowId);
    const listedEstimateIds = unique(row?.linkedSourceEstimateIds);
    if (explicitRefs && refs.some(ref => !ref.estimateId || !ref.rowId)) {
      return `${rowIndex + 1}행의 원본 참조에 견적서 ID 또는 행 ID가 없습니다.`;
    }
    if (Boolean(legacyEstimateId) !== Boolean(legacyRowId)) {
      return `${rowIndex + 1}행의 단일 원본 참조가 완전하지 않습니다.`;
    }
    if (!explicitRefs && listedEstimateIds.length && !refs.length) {
      return `${rowIndex + 1}행에 원본 견적서만 있고 원본 행 참조가 없습니다.`;
    }
    const signatures = refs.map(ref => `${ref.estimateId}:${ref.rowId}`);
    if (new Set(signatures).size !== signatures.length) {
      return `${rowIndex + 1}행에 같은 원본 행 참조가 중복되어 있습니다.`;
    }
    if (explicitRefs && listedEstimateIds.length && !sameIds(listedEstimateIds, refs.map(ref => ref.estimateId))) {
      return `${rowIndex + 1}행의 원본 견적서 목록과 원본 행 참조가 일치하지 않습니다.`;
    }
    if (explicitRefs && legacyEstimateId && !signatures.includes(`${legacyEstimateId}:${legacyRowId}`)) {
      return `${rowIndex + 1}행의 단일 원본 참조와 원본 행 목록이 일치하지 않습니다.`;
    }
    if (!explicitRefs && refs.length && listedEstimateIds.length && !sameIds(listedEstimateIds, refs.map(ref => ref.estimateId))) {
      return `${rowIndex + 1}행의 원본 견적서 목록과 단일 원본 참조가 일치하지 않습니다.`;
    }
  }
  return '';
}

function linkedRowRefs(draft = null) {
  return (draft?.rows || []).flatMap(normalizedRowRefs).filter(ref => ref.estimateId && ref.rowId);
}

function duplicateLinkedRowRef(draft = null) {
  const rowCountByRef = new Map();
  for (const row of draft?.rows || []) {
    const refs = normalizedRowRefs(row);
    const uniqueRowRefs = new Set(refs
      .map(ref => `${text(ref?.estimateId)}:${text(ref?.rowId)}`)
      .filter(signature => signature !== ':'));
    for (const signature of uniqueRowRefs) {
      const count = (rowCountByRef.get(signature) || 0) + 1;
      if (count > 1) return signature;
      rowCountByRef.set(signature, count);
    }
  }
  return '';
}

function ambiguousEditedMultiRef(draft = null) {
  for (const row of draft?.rows || []) {
    const refs = normalizedRowRefs(row);
    const signatures = unique(refs.map(ref => `${text(ref?.estimateId)}:${text(ref?.rowId)}`));
    const edited = Object.values(row?.editedFields || {}).some(Boolean)
      || (Array.isArray(row?.linkedSyncFields) && row.linkedSyncFields.length > 0);
    if (signatures.length > 1 && edited) return signatures.join(', ');
  }
  return '';
}

function missingLinkedRowRef(workingDraft, sourceIds, sourceDrafts) {
  const rowIdsByEstimate = new Map(sourceIds.map((estimateId, index) => [
    estimateId,
    new Set((sourceDrafts[index]?.rows || []).map(row => text(row?.rowId)).filter(Boolean))
  ]));
  return linkedRowRefs(workingDraft).find(ref => !rowIdsByEstimate.get(ref.estimateId)?.has(ref.rowId)) || null;
}

function invalidSourceRowIdentity(sourceIds, sourceDrafts) {
  for (let sourceIndex = 0; sourceIndex < sourceDrafts.length; sourceIndex += 1) {
    const estimateId = sourceIds[sourceIndex];
    const seen = new Set();
    for (const row of sourceDrafts[sourceIndex]?.rows || []) {
      const rowId = text(row?.rowId);
      if (!rowId) return `${estimateId}:행ID없음`;
      if (seen.has(rowId)) return `${estimateId}:${rowId}`;
      seen.add(rowId);
    }
  }
  return '';
}

function resolveSourceDrafts(sourceIds, individualsById, currentDraft, workingDrafts) {
  const drafts = [];
  for (const estimateId of sourceIds) {
    const sourceRecord = individualsById.get(estimateId);
    const resolved = sourceRecord ? draftForRecord(sourceRecord, currentDraft, workingDrafts) : { draft: null, error: '' };
    if (resolved.error) return { ok: false, error: resolved.error, drafts: [] };
    if (!resolved.draft) return { ok: false, error: `연결된 원본 견적서 ${estimateId}을(를) 확인할 수 없습니다.`, drafts: [] };
    const recordKind = text(sourceRecord?.estimateKind);
    const draftKind = text(resolved.draft?.estimateKind);
    if (recordKind && draftKind && recordKind !== draftKind) {
      return { ok: false, error: `연결된 원본 견적서 ${estimateId}의 유형이 저장 정보와 작업표에서 일치하지 않습니다.`, drafts: [] };
    }
    if ([recordKind, draftKind].some(kind => ['LINKED_GROUP', 'COMPOSITION_PREVIEW'].includes(kind))) {
      return { ok: false, error: `연결된 원본 견적서 ${estimateId}이(가) 개별 견적서가 아닙니다.`, drafts: [] };
    }
    drafts.push(resolved.draft);
  }
  return { ok: true, error: '', drafts };
}

function fail(error, selectionCount = 1) {
  return { ok: false, error, entries: [], validationDrafts: [], selectionCount };
}

function derivedEntry({ workingDraft, sourceIds, sourceDrafts, record = null }) {
  return {
    kind: 'DERIVED',
    recordId: text(record?.estimateId || workingDraft?.catalogRecordId),
    workingDraft,
    sourceIds: [...sourceIds],
    sourceDrafts: [...sourceDrafts]
  };
}

/**
 * F8 출력용 작업표와 중복 검사용 원본을 분리한다.
 *
 * DIRECT는 개별 견적 작업표를 그대로 출력한다.
 * DERIVED는 최신 개별 원본으로 행을 다시 만든 뒤 workingDraft의 명시적 편집만 덮어쓴다.
 */
function buildEstimateF8DraftPlan({
  creation = null,
  selectedRecords = [],
  currentDraft = null,
  individualRecords = [],
  allRecords = [],
  workingDrafts = new Map()
} = {}) {
  const individualsById = new Map((individualRecords || []).map(record => [text(record?.estimateId), record]));
  const recordsById = new Map((allRecords || []).map(record => [text(record?.estimateId), record]));
  (selectedRecords || []).forEach(record => recordsById.set(text(record?.estimateId), record));
  (individualRecords || []).forEach(record => recordsById.set(text(record?.estimateId), record));

  const selectedSourceIds = unique(creation?.selectedIds);
  const entries = [];
  let selectionCount = 1;

  if (creation && !selectedSourceIds.length) return fail('조합할 원본 견적서를 선택하세요.', 0);
  if (selectedSourceIds.length) {
    selectionCount = selectedSourceIds.length;
    if (!currentDraft || currentDraft.estimateKind !== 'COMPOSITION_PREVIEW') {
      return fail('현재 조합 미리보기 상태가 일치하지 않습니다.', selectionCount);
    }
    const previewSourceIds = metadataSourceIds(currentDraft);
    if (!sameIds(previewSourceIds, selectedSourceIds)) {
      return fail('조합 미리보기의 원본 견적서 구성이 현재 선택과 일치하지 않습니다.', selectionCount);
    }
    const invalidRefs = invalidLinkedRefStructure(currentDraft);
    if (invalidRefs) return fail(`조합 미리보기의 원본 연결이 올바르지 않습니다. ${invalidRefs}`, selectionCount);
    const unknownRowIds = rowSourceIds(currentDraft).filter(id => !selectedSourceIds.includes(id));
    if (unknownRowIds.length) return fail(`조합 미리보기에 알 수 없는 원본 견적서 ${unknownRowIds[0]}이(가) 포함되어 있습니다.`, selectionCount);
    const duplicateRef = duplicateLinkedRowRef(currentDraft);
    if (duplicateRef) return fail(`조합 미리보기에서 원본 행 ${duplicateRef}이(가) 여러 작업행에 중복 연결되어 있습니다.`, selectionCount);
    const ambiguousRefs = ambiguousEditedMultiRef(currentDraft);
    if (ambiguousRefs) return fail(`조합 미리보기의 편집값이 여러 원본 행(${ambiguousRefs})에 연결되어 있어 적용 대상을 결정할 수 없습니다.`, selectionCount);
    const sources = resolveSourceDrafts(selectedSourceIds, individualsById, currentDraft, workingDrafts);
    if (!sources.ok) return fail(sources.error, selectionCount);
    const invalidIdentity = invalidSourceRowIdentity(selectedSourceIds, sources.drafts);
    if (invalidIdentity) return fail(`조합 원본 행 식별자가 유일하지 않습니다(${invalidIdentity}).`, selectionCount);
    const missingRef = missingLinkedRowRef(currentDraft, selectedSourceIds, sources.drafts);
    if (missingRef) return fail(`조합 미리보기의 원본 행 ${missingRef.estimateId}:${missingRef.rowId}을(를) 확인할 수 없습니다.`, selectionCount);
    entries.push(derivedEntry({ workingDraft: currentDraft, sourceIds: selectedSourceIds, sourceDrafts: sources.drafts }));
  } else {
    const targets = Array.isArray(selectedRecords) && selectedRecords.length
      ? selectedRecords.map(record => ({ record, useCurrent: text(currentDraft?.catalogRecordId) === text(record?.estimateId) }))
      : (currentDraft ? [{ record: recordsById.get(text(currentDraft.catalogRecordId)) || null, useCurrent: true }] : []);
    selectionCount = Array.isArray(selectedRecords) && selectedRecords.length ? selectedRecords.length : 1;
    if (!targets.length) return fail('출력할 견적서 작업표를 확인할 수 없습니다.', selectionCount);

    for (const target of targets) {
      const resolved = target.record
        ? draftForRecord(target.record, target.useCurrent ? currentDraft : null, workingDrafts)
        : { draft: currentDraft, error: '' };
      if (resolved.error) return fail(resolved.error, selectionCount);
      if (!resolved.draft) return fail('출력할 견적서 작업표를 확인할 수 없습니다.', selectionCount);
      if (resolved.draft.estimateKind === 'COMPOSITION_PREVIEW') return fail('조합 미리보기 선택 상태를 다시 확인하세요.', selectionCount);

      const recordKind = text(target.record?.estimateKind);
      const draftKind = text(resolved.draft.estimateKind);
      if (recordKind && draftKind && recordKind !== draftKind) {
        return fail('견적서의 저장 유형과 작업표 유형이 일치하지 않습니다.', selectionCount);
      }

      if (resolved.draft.schemaVersion === 'ONEAPP_SMARTINPUT_INDEPENDENT_ESTIMATE_V1') {
        if (!Array.isArray(resolved.draft.ownedRows)) return fail('독립 견적서의 전체 거래행을 확인할 수 없습니다.', selectionCount);
        entries.push({ kind: 'DIRECT', recordId: text(target.record?.estimateId || resolved.draft.catalogRecordId),
          draft: { ...resolved.draft, inputMapping: null, rows: resolved.draft.ownedRows } });
        continue;
      }
      const linked = recordKind === 'LINKED_GROUP' || draftKind === 'LINKED_GROUP';
      if (!linked) {
        entries.push({ kind: 'DIRECT', recordId: text(target.record?.estimateId || resolved.draft.catalogRecordId), draft: resolved.draft });
        continue;
      }

      const recordSourceIds = metadataSourceIds(target.record);
      const draftSourceIds = metadataSourceIds(resolved.draft);
      if (!recordSourceIds.length || !draftSourceIds.length) return fail('연동견적서의 원본 견적서 구성을 확인할 수 없습니다.', selectionCount);
      if (!sameIds(recordSourceIds, draftSourceIds)) return fail('연동견적서의 저장 정보와 작업표 원본 구성이 일치하지 않습니다.', selectionCount);
      const invalidRefs = invalidLinkedRefStructure(resolved.draft);
      if (invalidRefs) return fail(`연동견적서의 원본 연결이 올바르지 않습니다. ${invalidRefs}`, selectionCount);
      const unknownRowIds = rowSourceIds(resolved.draft).filter(id => !recordSourceIds.includes(id));
      if (unknownRowIds.length) return fail(`연동견적서에 알 수 없는 원본 견적서 ${unknownRowIds[0]}이(가) 포함되어 있습니다.`, selectionCount);
      const duplicateRef = duplicateLinkedRowRef(resolved.draft);
      if (duplicateRef) return fail(`연동견적서에서 원본 행 ${duplicateRef}이(가) 여러 작업행에 중복 연결되어 있습니다.`, selectionCount);
      const ambiguousRefs = ambiguousEditedMultiRef(resolved.draft);
      if (ambiguousRefs) return fail(`연동견적서의 편집값이 여러 원본 행(${ambiguousRefs})에 연결되어 있어 적용 대상을 결정할 수 없습니다.`, selectionCount);
      const sources = resolveSourceDrafts(recordSourceIds, individualsById, currentDraft, workingDrafts);
      if (!sources.ok) return fail(sources.error, selectionCount);
      const invalidIdentity = invalidSourceRowIdentity(recordSourceIds, sources.drafts);
      if (invalidIdentity) return fail(`연동견적서 원본 행 식별자가 유일하지 않습니다(${invalidIdentity}).`, selectionCount);
      const missingRef = missingLinkedRowRef(resolved.draft, recordSourceIds, sources.drafts);
      if (missingRef) return fail(`연동견적서의 원본 행 ${missingRef.estimateId}:${missingRef.rowId}을(를) 확인할 수 없습니다.`, selectionCount);
      entries.push(derivedEntry({
        record: target.record,
        workingDraft: resolved.draft,
        sourceIds: recordSourceIds,
        sourceDrafts: sources.drafts
      }));
    }
  }

  return {
    ok: true,
    error: '',
    entries,
    validationDrafts: entries.flatMap(entry => entry.kind === 'DERIVED' ? entry.sourceDrafts : [entry.draft]),
    selectionCount
  };
}

return { buildEstimateF8DraftPlan };
})();

// ============================================================================
// estimate-f8-recovery.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const estimateF8RecoverySection = (() => {
const { removeLinkedEstimateSources } = linkedEstimateSourceEditSection;

const ESTIMATE_F8_RECOVERY_SCHEMA = 'ONEAPP_SMARTINPUT_ESTIMATE_F8_RECOVERY_V1';

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

function inspectEstimateF8Integrity({ record = null, allRecords = [] } = {}) {
  if (record?.estimateKind !== 'LINKED_GROUP') {
    return invalidResult(record, '연동견적서만 F8 연결 복구를 실행할 수 있습니다.');
  }
  const sourceIds = unique((record.linkedEstimateSources || []).map(source => source?.estimateId));
  if (!sourceIds.length) return invalidResult(record, '연동견적서의 원본 견적서 구성을 확인할 수 없습니다.');
  const recordsById = new Map((allRecords || []).map(item => [text(item?.estimateId), item]));
  const availableRecords = sourceIds.map(estimateId => recordsById.get(estimateId))
    .filter(record => record?.draft && Array.isArray(record.draft.rows));
  const availableIds = new Set(availableRecords.map(record => text(record.estimateId)));
  const missingSourceIds = sourceIds.filter(estimateId => !availableIds.has(estimateId));

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

function applyEstimateF8PartialRecovery({
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

function createEstimateF8IndependentCopy({
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
    impactFingerprint: text(diagnosis.impactFingerprint),
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

return { ESTIMATE_F8_RECOVERY_SCHEMA, inspectEstimateF8Integrity, applyEstimateF8PartialRecovery, createEstimateF8IndependentCopy };
})();

// Public API (same functions and constants; no additional command layer).
export const LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA = linkedEstimateSourceEditSection.LINKED_ESTIMATE_SOURCE_EVIDENCE_SCHEMA;
export const LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA = linkedEstimateSourceEditSection.LINKED_ESTIMATE_SOURCE_EDIT_PLAN_SCHEMA;
export const LINKED_ESTIMATE_SOURCE_EDIT_FIELDS = linkedEstimateSourceEditSection.LINKED_ESTIMATE_SOURCE_EDIT_FIELDS;
export const LINKED_ESTIMATE_FIELD_LABELS = linkedEstimateSourceEditSection.LINKED_ESTIMATE_FIELD_LABELS;
export const numericInputState = linkedEstimateSourceEditSection.numericInputState;
export const inspectLinkedEstimateSourceEdits = linkedEstimateSourceEditSection.inspectLinkedEstimateSourceEdits;
export const createLinkedEstimateSourceEditPlan = linkedEstimateSourceEditSection.createLinkedEstimateSourceEditPlan;
export const linkedEstimateWorkingDraftsEquivalent = linkedEstimateSourceEditSection.linkedEstimateWorkingDraftsEquivalent;
export const inspectLinkedEstimateSourceWorkingCopyConflicts = linkedEstimateSourceEditSection.inspectLinkedEstimateSourceWorkingCopyConflicts;
export const restoreLinkedEstimateWorkingRowEdits = linkedEstimateSourceEditSection.restoreLinkedEstimateWorkingRowEdits;
export const rebaseLinkedEstimateWorkingDraft = linkedEstimateSourceEditSection.rebaseLinkedEstimateWorkingDraft;
export const removeLinkedEstimateSources = linkedEstimateSourceEditSection.removeLinkedEstimateSources;
export const rebuildLinkedEstimateRecord = linkedEstimateSourceEditSection.rebuildLinkedEstimateRecord;
export const applyLinkedEstimateSourceEditPlan = linkedEstimateSourceEditSection.applyLinkedEstimateSourceEditPlan;
export const buildEstimateF8DraftPlan = estimateF8SourcePlanSection.buildEstimateF8DraftPlan;
export const ESTIMATE_F8_RECOVERY_SCHEMA = estimateF8RecoverySection.ESTIMATE_F8_RECOVERY_SCHEMA;
export const inspectEstimateF8Integrity = estimateF8RecoverySection.inspectEstimateF8Integrity;
export const applyEstimateF8PartialRecovery = estimateF8RecoverySection.applyEstimateF8PartialRecovery;
export const createEstimateF8IndependentCopy = estimateF8RecoverySection.createEstimateF8IndependentCopy;
