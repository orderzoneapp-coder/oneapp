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
export function buildEstimateF8DraftPlan({
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
