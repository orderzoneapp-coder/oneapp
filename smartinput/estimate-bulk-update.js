import { linkedEstimateWorkingDraftsEquivalent } from './linked-estimate-source-edit.js?v=0.1.0';

const text = value => String(value ?? '').trim();
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function normalizeEstimateBulkCustomerName(value) {
  return text(value).normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

function rowCustomerIdentity(row = {}) {
  return {
    customerId: text(row.rowCustomerId),
    customerCode: text(row.rowCustomerCode),
    customerName: text(row.rowCustomerName)
  };
}

function rowHasCustomer(row = {}) {
  const identity = rowCustomerIdentity(row);
  return Boolean(identity.customerId || identity.customerCode || identity.customerName);
}

function rowHasItem(row = {}) {
  return Boolean(text(row.masterProductId) || text(row.productId) || text(row.itemCode) || text(row.itemName));
}

function groupIdentity(identity) {
  if (identity.customerId) return { groupId: `ID:${identity.customerId}`, identityKind: 'CUSTOMER_ID' };
  if (identity.customerCode) return { groupId: `CODE:${identity.customerCode}`, identityKind: 'CUSTOMER_CODE' };
  return { groupId: `NAME:${normalizeEstimateBulkCustomerName(identity.customerName)}`, identityKind: 'CUSTOMER_NAME' };
}

export function classifyEstimateBulkRows(rows = []) {
  const groupsById = new Map();
  const ignoredRows = [];
  const issues = [];
  (Array.isArray(rows) ? rows : []).forEach((sourceRow, index) => {
    const row = clone(sourceRow || {});
    const hasCustomer = rowHasCustomer(row);
    const hasItem = rowHasItem(row);
    const rowNo = Number(row.sourceRowNo || row.sourceLineNo || index + 1);
    if (!hasCustomer && !hasItem) {
      ignoredRows.push(row);
      return;
    }
    if (hasCustomer && !hasItem) {
      issues.push({
        code: 'ESTIMATE_BULK_CUSTOMER_ONLY_ROW',
        rowId: text(row.rowId),
        rowNo,
        message: `${rowNo}행은 거래처만 있고 품목 식별값이 없습니다.`
      });
      return;
    }
    if (!hasCustomer && hasItem) {
      issues.push({
        code: 'ESTIMATE_BULK_ITEM_ONLY_ROW',
        rowId: text(row.rowId),
        rowNo,
        message: `${rowNo}행은 품목이 있지만 거래처가 없습니다.`
      });
      return;
    }
    const identity = rowCustomerIdentity(row);
    const key = groupIdentity(identity);
    if (!key.groupId.replace(/^(?:ID|CODE|NAME):/, '')) {
      issues.push({ code: 'ESTIMATE_BULK_CUSTOMER_IDENTITY_EMPTY', rowId: text(row.rowId), rowNo, message: `${rowNo}행의 거래처를 확인할 수 없습니다.` });
      return;
    }
    let group = groupsById.get(key.groupId);
    if (!group) {
      group = {
        groupId: key.groupId,
        identityKind: key.identityKind,
        customerId: identity.customerId,
        customerCode: identity.customerCode,
        customerName: identity.customerName,
        normalizedCustomerName: normalizeEstimateBulkCustomerName(identity.customerName),
        rows: []
      };
      groupsById.set(key.groupId, group);
    }
    group.rows.push(row);
    if (!group.customerId && identity.customerId) group.customerId = identity.customerId;
    if (!group.customerCode && identity.customerCode) group.customerCode = identity.customerCode;
    if (!group.customerName && identity.customerName) {
      group.customerName = identity.customerName;
      group.normalizedCustomerName = normalizeEstimateBulkCustomerName(identity.customerName);
    }
  });
  const groups = [...groupsById.values()].map(group => ({ ...group, itemCount: group.rows.length }));
  return {
    groups,
    ignoredRows,
    issues,
    totalItemRows: groups.reduce((sum, group) => sum + group.rows.length, 0)
  };
}

function estimateIdentity(record = {}) {
  const header = record?.draft?.header || {};
  return {
    customerId: text(record.customerId || header.customerId),
    customerCode: text(record.customerCode || header.customerCode),
    customerName: text(record.customerName || header.customerName)
  };
}

function autoTargetCandidates(group, records) {
  const stages = [
    ['CUSTOMER_ID', group.customerId, record => estimateIdentity(record).customerId],
    ['CUSTOMER_CODE', group.customerCode, record => estimateIdentity(record).customerCode],
    ['CUSTOMER_NAME', group.normalizedCustomerName, record => normalizeEstimateBulkCustomerName(estimateIdentity(record).customerName)]
  ];
  for (const [method, sourceValue, valueForRecord] of stages) {
    if (!sourceValue) continue;
    const candidates = records.filter(record => valueForRecord(record) === sourceValue);
    if (candidates.length) return { method, candidates };
  }
  return { method: '', candidates: [] };
}

export function resolveEstimateBulkTargets({ groups = [], estimates = [], selections = {} } = {}) {
  const allRecords = (Array.isArray(estimates) ? estimates : []).filter(record => record?.estimateId);
  const individualRecords = allRecords.filter(record => record.estimateKind !== 'LINKED_GROUP');
  const recordsById = new Map(allRecords.map(record => [text(record.estimateId), record]));
  const issues = [];
  const assignments = (Array.isArray(groups) ? groups : []).map(group => {
    const hasManualSelection = Object.prototype.hasOwnProperty.call(selections || {}, group.groupId);
    const auto = autoTargetCandidates(group, individualRecords);
    let targetEstimateId = '';
    let matchMethod = auto.method;
    if (hasManualSelection) {
      targetEstimateId = text(selections[group.groupId]);
      matchMethod = 'MANUAL';
      if (!targetEstimateId) {
        issues.push({
          code: 'ESTIMATE_BULK_TARGET_UNRESOLVED',
          groupId: group.groupId,
          message: `${group.customerName || group.customerCode || group.customerId}의 기존 견적서를 선택하세요.`
        });
      }
      const selected = recordsById.get(targetEstimateId);
      if (targetEstimateId && !selected) {
        issues.push({ code: 'ESTIMATE_BULK_TARGET_MISSING', groupId: group.groupId, targetEstimateId, message: `${group.customerName || group.customerCode || group.customerId}의 선택 대상이 없습니다.` });
        targetEstimateId = '';
      } else if (selected?.estimateKind === 'LINKED_GROUP') {
        issues.push({ code: 'ESTIMATE_BULK_LINKED_TARGET_FORBIDDEN', groupId: group.groupId, targetEstimateId, message: '연동견적서는 일괄 업데이트 대상으로 선택할 수 없습니다.' });
        targetEstimateId = '';
      }
    } else if (auto.candidates.length === 1) {
      targetEstimateId = text(auto.candidates[0].estimateId);
    } else if (auto.candidates.length > 1) {
      issues.push({
        code: 'ESTIMATE_BULK_TARGET_AMBIGUOUS',
        groupId: group.groupId,
        candidateEstimateIds: auto.candidates.map(record => text(record.estimateId)),
        message: `${group.customerName || group.customerCode || group.customerId}에 정확히 일치하는 견적서가 여러 개입니다.`
      });
    } else {
      issues.push({
        code: 'ESTIMATE_BULK_TARGET_UNRESOLVED',
        groupId: group.groupId,
        message: `${group.customerName || group.customerCode || group.customerId}에 정확히 일치하는 기존 견적서가 없습니다.`
      });
    }
    return {
      group,
      groupId: group.groupId,
      targetEstimateId,
      target: targetEstimateId ? recordsById.get(targetEstimateId) || null : null,
      matchMethod,
      candidateEstimateIds: auto.candidates.map(record => text(record.estimateId))
    };
  });
  const assignmentsByTarget = new Map();
  assignments.filter(assignment => assignment.targetEstimateId).forEach(assignment => {
    assignmentsByTarget.set(assignment.targetEstimateId, [...(assignmentsByTarget.get(assignment.targetEstimateId) || []), assignment]);
  });
  assignmentsByTarget.forEach((duplicates, targetEstimateId) => {
    if (duplicates.length < 2) return;
    issues.push({
      code: 'ESTIMATE_BULK_TARGET_DUPLICATED',
      targetEstimateId,
      groupIds: duplicates.map(assignment => assignment.groupId),
      message: '같은 기존 견적서를 두 원본 거래처에 중복 연결할 수 없습니다.'
    });
  });
  return {
    assignments,
    issues,
    connectedCount: assignments.filter(assignment => assignment.targetEstimateId).length,
    unresolvedCount: assignments.filter(assignment => !assignment.targetEstimateId).length,
    untouchedCount: Math.max(0, individualRecords.length - new Set(assignments.map(assignment => assignment.targetEstimateId).filter(Boolean)).size)
  };
}

function requireMappingSession(session) {
  if (session?.schemaVersion !== 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2'
    || !Array.isArray(session.sourceMatrix)
    || !Array.isArray(session.sourceCellMatrix)
    || !Array.isArray(session.workingRows)
    || !Array.isArray(session.headers)) {
    throw new Error('ESTIMATE_BULK_MAPPING_EVIDENCE_UNAVAILABLE');
  }
}

export function splitEstimateBulkInputMapping({ session, rows = [] } = {}) {
  requireMappingSession(session);
  const selectedRows = (Array.isArray(rows) ? rows : []).map(row => clone(row));
  const workingById = new Map(session.workingRows.map(row => [text(row.rowId), row]));
  const headerIndex = Number(session.headerRowIndex || 0);
  const header = session.sourceMatrix[headerIndex];
  if (!Array.isArray(header)) throw new Error('ESTIMATE_BULK_MAPPING_HEADER_MISSING');
  const nextSourceMatrix = [clone(header)];
  const nextSourceCellMatrix = [clone(session.sourceCellMatrix[headerIndex] || [])];
  const nextEditJournal = {};
  const sourceWorkingRows = [];
  const manualWorkingRows = [];
  const nextManualRows = [];
  const rowIdMap = new Map();
  let nextSourceIndex = 1;
  selectedRows.forEach(row => {
    const oldRowId = text(row.rowId);
    const working = workingById.get(oldRowId);
    if (!working) throw new Error(`ESTIMATE_BULK_MAPPING_ROW_MISSING:${oldRowId}`);
    if (working.manual) {
      const manual = (session.manualRows || []).find(candidate => text(candidate.rowId) === oldRowId);
      if (!manual) throw new Error(`ESTIMATE_BULK_MAPPING_MANUAL_ROW_MISSING:${oldRowId}`);
      const nextManual = clone(manual);
      nextManualRows.push(nextManual);
      manualWorkingRows.push({ ...clone(working), rowId: oldRowId, sourceRowIndex: null, manual: true });
      rowIdMap.set(oldRowId, oldRowId);
      return;
    }
    const originalIndex = Number(working.sourceRowIndex);
    if (!Number.isInteger(originalIndex)
      || !Array.isArray(session.sourceMatrix[originalIndex])
      || !Array.isArray(session.sourceCellMatrix[originalIndex])) {
      throw new Error(`ESTIMATE_BULK_MAPPING_SOURCE_EVIDENCE_MISSING:${oldRowId}`);
    }
    const nextRowId = `source-${nextSourceIndex}`;
    nextSourceMatrix.push(clone(session.sourceMatrix[originalIndex]));
    nextSourceCellMatrix.push(clone(session.sourceCellMatrix[originalIndex]));
    (session.headers || []).forEach((unused, columnIndex) => {
      const oldKey = `${originalIndex}:${columnIndex}`;
      if (Object.prototype.hasOwnProperty.call(session.editJournal || {}, oldKey)) {
        nextEditJournal[`${nextSourceIndex}:${columnIndex}`] = session.editJournal[oldKey];
      }
    });
    sourceWorkingRows.push({
      ...clone(working),
      rowId: nextRowId,
      sourceRowIndex: nextSourceIndex,
      cells: clone(working.cells || []),
      sourceCells: clone(working.sourceCells || []),
      manual: false
    });
    rowIdMap.set(oldRowId, nextRowId);
    nextSourceIndex += 1;
  });
  const mappedRows = selectedRows.map(row => ({ ...row, rowId: rowIdMap.get(text(row.rowId)) }));
  if (mappedRows.some(row => !row.rowId)) throw new Error('ESTIMATE_BULK_MAPPING_ROW_REMAP_FAILED');
  const nextSession = {
    ...clone(session),
    sourceMatrix: nextSourceMatrix,
    sourceCellMatrix: nextSourceCellMatrix,
    headerRowIndex: 0,
    headers: clone(session.headers),
    mappings: clone(session.mappings || []),
    editJournal: nextEditJournal,
    manualRows: nextManualRows,
    deletedSourceRows: [],
    workingRows: [...sourceWorkingRows, ...manualWorkingRows]
  };
  return { session: nextSession, rows: mappedRows, rowIdMap: Object.fromEntries(rowIdMap) };
}

export function createEstimateBulkReplacementRecord({
  target,
  replacementDraft,
  previousPrices = {},
  baselinePrices = {},
  summary = {},
  timestamp
} = {}) {
  if (!target?.estimateId || target.estimateKind === 'LINKED_GROUP') throw new Error('ESTIMATE_BULK_TARGET_INVALID');
  if (!replacementDraft || !Array.isArray(replacementDraft.rows)) throw new Error('ESTIMATE_BULK_REPLACEMENT_DRAFT_INVALID');
  const occurredAt = text(timestamp);
  if (!occurredAt) throw new Error('ESTIMATE_BULK_TIMESTAMP_REQUIRED');
  const targetCopy = clone(target);
  const draft = {
    ...clone(replacementDraft),
    catalogRecordId: text(target.estimateId),
    estimateKind: target.estimateKind || 'INDIVIDUAL',
    linkedEstimateSources: clone(target.draft?.linkedEstimateSources || []),
    header: clone(target.draft?.header || replacementDraft.header || {}),
    catalogPreviousPrices: clone(previousPrices),
    catalogBaselinePrices: clone(baselinePrices),
    updatedAt: occurredAt,
    delivery: {
      status: 'SAVED',
      targetId: 'smart-input-estimates',
      targetRecordId: text(target.estimateId),
      deliveredAt: occurredAt
    }
  };
  return {
    ...targetCopy,
    rowCount: Number(summary.total ?? draft.rows.length),
    amount: Number(summary.amount || 0),
    previousPrices: clone(previousPrices),
    updatedAt: occurredAt,
    draft
  };
}

export function inspectEstimateBulkWorkingCopyConflicts({ targetEstimateIds = [], estimates = [], workingCopies = [] } = {}) {
  const targetIds = new Set((targetEstimateIds || []).map(text).filter(Boolean));
  const recordsById = new Map((estimates || []).filter(record => record?.estimateId).map(record => [text(record.estimateId), record]));
  return (workingCopies || []).flatMap(copy => {
    const estimateId = text(copy?.estimateId);
    const record = recordsById.get(estimateId);
    if (!record?.draft || !copy?.draft || linkedEstimateWorkingDraftsEquivalent(record.draft, copy.draft)) return [];
    if (targetIds.has(estimateId)) {
      return [{
        code: 'ESTIMATE_BULK_TARGET_WORKING_COPY_CONFLICT',
        estimateId,
        estimateName: text(record.catalogName) || estimateId,
        message: `${text(record.catalogName) || estimateId}에 저장하지 않은 작업본이 있습니다.`
      }];
    }
    if (record.estimateKind === 'LINKED_GROUP'
      && (record.linkedEstimateSources || []).some(source => targetIds.has(text(source.estimateId)))) {
      return [{
        code: 'ESTIMATE_BULK_LINKED_WORKING_COPY_CONFLICT',
        estimateId,
        estimateName: text(record.catalogName) || estimateId,
        message: `${text(record.catalogName) || estimateId} 연동견적서에 저장하지 않은 작업본이 있습니다.`
      }];
    }
    return [];
  });
}
