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

function appendGroupIssue(group, issue, issues) {
  group.issues.push(issue);
  issues.push(issue);
}

function createCustomerGroup(identity, key) {
  return {
    groupId: key.groupId,
    groupType: 'CUSTOMER',
    identityKind: key.identityKind,
    customerId: identity.customerId,
    customerCode: identity.customerCode,
    customerName: identity.customerName,
    normalizedCustomerName: normalizeEstimateBulkCustomerName(identity.customerName),
    rows: [],
    itemRows: [],
    issues: []
  };
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
    if (!hasCustomer && hasItem) {
      const groupId = `UNASSIGNED:${text(row.rowId) || rowNo}`;
      const group = {
        groupId,
        groupType: 'UNASSIGNED',
        identityKind: 'UNASSIGNED',
        customerId: '',
        customerCode: '',
        customerName: '거래처 미확인',
        normalizedCustomerName: '',
        rows: [row],
        itemRows: [row],
        issues: []
      };
      appendGroupIssue(group, {
        code: 'ESTIMATE_BULK_ITEM_ONLY_ROW',
        groupId,
        rowId: text(row.rowId),
        rowNo,
        message: `${rowNo}행은 품목이 있지만 거래처가 없습니다.`
      }, issues);
      groupsById.set(groupId, group);
      return;
    }
    const identity = rowCustomerIdentity(row);
    const key = groupIdentity(identity);
    if (!key.groupId.replace(/^(?:ID|CODE|NAME):/, '')) {
      const issue = { code: 'ESTIMATE_BULK_CUSTOMER_IDENTITY_EMPTY', rowId: text(row.rowId), rowNo, message: `${rowNo}행의 거래처를 확인할 수 없습니다.` };
      issues.push(issue);
      return;
    }
    let group = groupsById.get(key.groupId);
    if (!group) {
      group = createCustomerGroup(identity, key);
      groupsById.set(key.groupId, group);
    }
    group.rows.push(row);
    if (hasCustomer && !hasItem) {
      appendGroupIssue(group, {
        code: 'ESTIMATE_BULK_CUSTOMER_ONLY_ROW',
        groupId: key.groupId,
        rowId: text(row.rowId),
        rowNo,
        message: `${rowNo}행은 거래처만 있고 품목 식별값이 없습니다.`
      }, issues);
      return;
    }
    group.itemRows.push(row);
    if (!group.customerId && identity.customerId) group.customerId = identity.customerId;
    if (!group.customerCode && identity.customerCode) group.customerCode = identity.customerCode;
    if (!group.customerName && identity.customerName) {
      group.customerName = identity.customerName;
      group.normalizedCustomerName = normalizeEstimateBulkCustomerName(identity.customerName);
    }
  });
  const groups = [...groupsById.values()].map(group => ({ ...group, itemCount: group.itemRows.length }));
  return {
    groups,
    ignoredRows,
    issues,
    totalItemRows: groups.reduce((sum, group) => sum + group.itemRows.length, 0)
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
        targetEstimateIds: [estimateId],
        estimateName: text(record.catalogName) || estimateId,
        message: `${text(record.catalogName) || estimateId}에 저장하지 않은 작업본이 있습니다.`
      }];
    }
    if (record.estimateKind === 'LINKED_GROUP'
      && (record.linkedEstimateSources || []).some(source => targetIds.has(text(source.estimateId)))) {
      const linkedTargetEstimateIds = (record.linkedEstimateSources || [])
        .map(source => text(source.estimateId))
        .filter(estimateId => targetIds.has(estimateId));
      return [{
        code: 'ESTIMATE_BULK_LINKED_WORKING_COPY_CONFLICT',
        estimateId,
        targetEstimateIds: linkedTargetEstimateIds,
        estimateName: text(record.catalogName) || estimateId,
        message: `${text(record.catalogName) || estimateId} 연동견적서에 저장하지 않은 작업본이 있습니다.`
      }];
    }
    return [];
  });
}

export const ESTIMATE_BULK_GROUP_STATUS = Object.freeze({
  READY: 'READY',
  PENDING: 'PENDING',
  UNCHANGED: 'UNCHANGED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  EXCLUDED: 'EXCLUDED'
});

const PROGRESS_SCHEMA_VERSION = 'ONEAPP_SMARTINPUT_ESTIMATE_BULK_PROGRESS_V1';
const PRODUCT_REVIEW_BLOCKING_MATCH_STATUSES = new Set(['SIMILAR', 'UNRESOLVED', 'MATCH_FAILED']);
const VOLATILE_MAPPING_KEYS = new Set(['sessionId', 'createdAt', 'updatedAt', 'appliedAt', 'analyzedAt', 'lastTouchedAt']);

function stableValue(value, omittedKeys = new Set()) {
  if (Array.isArray(value)) return value.map(item => stableValue(item, omittedKeys));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => (
    omittedKeys.has(key) || value[key] === undefined ? [] : [[key, stableValue(value[key], omittedKeys)]]
  )));
}

function stableJson(value, omittedKeys) {
  return JSON.stringify(stableValue(value, omittedKeys));
}

function stableFingerprint(prefix, value) {
  const source = stableJson(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function createFileFingerprint(session = {}) {
  const existing = text(session.fileFingerprint);
  if (existing) return `FILE-${existing}`;
  return stableFingerprint('FILE', {
    signature: session.signature,
    headerSignature: session.headerSignature,
    headers: session.headers,
    mappings: session.mappings,
    sourceMatrix: session.sourceMatrix,
    sourceCellMatrix: session.sourceCellMatrix
  });
}

function groupReviewIssues(group = {}) {
  const issues = clone(group.issues || []);
  (group.itemRows || []).forEach((row, index) => {
    const rowNo = Number(row.sourceRowNo || row.sourceLineNo || index + 1);
    const matchStatus = text(row.matchStatus).toUpperCase();
    const reviewStatus = text(row.reviewStatus).toUpperCase();
    const identityStatus = text(row.productIdentityStatus).toUpperCase();
    if (!rowHasItem(row)) {
      issues.push({ code: 'ESTIMATE_BULK_ITEM_IDENTITY_REQUIRED', groupId: group.groupId, rowId: text(row.rowId), rowNo, message: `${rowNo}행의 품목코드 또는 품명을 확인하세요.` });
      return;
    }
    if (PRODUCT_REVIEW_BLOCKING_MATCH_STATUSES.has(matchStatus)) {
      issues.push({ code: 'ESTIMATE_BULK_PRODUCT_REVIEW_REQUIRED', groupId: group.groupId, rowId: text(row.rowId), rowNo, message: `${rowNo}행의 상품 일치를 확인하세요.` });
      return;
    }
    if ((reviewStatus && reviewStatus !== 'CONFIRMED') || (identityStatus && identityStatus !== 'MASTER_LINKED')) {
      issues.push({ code: 'ESTIMATE_BULK_PRODUCT_REVIEW_REQUIRED', groupId: group.groupId, rowId: text(row.rowId), rowNo, message: `${rowNo}행의 상품 검수를 완료하세요.` });
    }
  });
  return issues;
}

function normalizeDecision(selection, previousEntry, group, individualRecords) {
  if (selection !== undefined) {
    if (typeof selection === 'string') return selection ? { action: 'UPDATE', targetEstimateId: text(selection), catalogName: '' } : { action: 'NONE', targetEstimateId: '', catalogName: '' };
    const action = text(selection?.action).toUpperCase() || 'NONE';
    return { action, targetEstimateId: text(selection?.targetEstimateId), catalogName: action === 'CREATE' ? text(selection?.catalogName) : '' };
  }
  if (previousEntry?.action && previousEntry.groupFingerprint) {
    return {
      action: text(previousEntry.action).toUpperCase(),
      targetEstimateId: text(previousEntry.targetEstimateId),
      catalogName: text(previousEntry.catalogName)
    };
  }
  if (group.groupType === 'UNASSIGNED') return { action: 'NONE', targetEstimateId: '', catalogName: '' };
  const auto = autoTargetCandidates(group, individualRecords);
  if (auto.candidates.length === 1) return { action: 'UPDATE', targetEstimateId: text(auto.candidates[0].estimateId), catalogName: '' };
  return { action: 'NONE', targetEstimateId: '', catalogName: '', auto };
}

function decisionFingerprint(decision) {
  return stableFingerprint('DECISION', {
    action: text(decision.action).toUpperCase(),
    targetEstimateId: text(decision.targetEstimateId),
    catalogName: text(decision.catalogName)
  });
}

function groupFingerprint(group, split) {
  return stableFingerprint('GROUP', {
    groupId: group.groupId,
    identityKind: group.identityKind,
    customerId: group.customerId,
    customerCode: group.customerCode,
    customerName: group.customerName,
    rows: group.rows,
    split: split ? {
      rows: split.rows,
      inputMapping: stableValue(split.session, VOLATILE_MAPPING_KEYS)
    } : null
  });
}

function comparableDraft(draft = {}) {
  return {
    rows: stableValue(draft.rows || []),
    inputMapping: stableValue(draft.inputMapping || {}, VOLATILE_MAPPING_KEYS)
  };
}

export function createEstimateBulkNewRecord({
  estimateId,
  catalogName,
  group,
  replacementDraft,
  summary = {},
  timestamp,
  sortOrder
} = {}) {
  const normalizedEstimateId = text(estimateId);
  const normalizedName = text(catalogName);
  const occurredAt = text(timestamp);
  if (!normalizedEstimateId || !normalizedName || !occurredAt) throw new Error('ESTIMATE_BULK_NEW_RECORD_IDENTITY_REQUIRED');
  if (!group || group.groupType === 'UNASSIGNED') throw new Error('ESTIMATE_BULK_NEW_RECORD_CUSTOMER_REQUIRED');
  if (!replacementDraft || !Array.isArray(replacementDraft.rows)) throw new Error('ESTIMATE_BULK_REPLACEMENT_DRAFT_INVALID');
  const draft = {
    ...clone(replacementDraft),
    catalogRecordId: normalizedEstimateId,
    estimateKind: 'INDIVIDUAL',
    linkedEstimateSources: [],
    catalogPreviousPrices: {},
    updatedAt: occurredAt,
    delivery: {
      status: 'SAVED',
      targetId: 'smart-input-estimates',
      targetRecordId: normalizedEstimateId,
      deliveredAt: occurredAt
    }
  };
  return {
    estimateId: normalizedEstimateId,
    catalogName: normalizedName,
    estimateKind: 'INDIVIDUAL',
    linkedEstimateSources: [],
    customerId: text(group.customerId),
    customerCode: text(group.customerCode),
    customerName: text(group.customerName),
    rowCount: Number(summary.total ?? draft.rows.length),
    amount: Number(summary.amount || 0),
    previousPrices: {},
    sortOrder: Number(sortOrder || 1),
    createdAt: occurredAt,
    updatedAt: occurredAt,
    draft
  };
}

export function estimateBulkDraftsEquivalent(existingDraft, replacementDraft) {
  return stableJson(comparableDraft(existingDraft)) === stableJson(comparableDraft(replacementDraft));
}

function issueForDecision(decision, group, recordsById, individualRecords) {
  const label = group.customerName || group.customerCode || group.customerId || '거래처 미확인';
  if (decision.action === 'EXCLUDE') return [];
  if (decision.action === 'CREATE') {
    return decision.catalogName ? [] : [{ code: 'ESTIMATE_BULK_CREATE_NAME_REQUIRED', groupId: group.groupId, message: `${label}의 새 견적서 이름을 입력하세요.` }];
  }
  if (decision.action !== 'UPDATE') {
    const auto = decision.auto || autoTargetCandidates(group, individualRecords);
    if (auto.candidates.length > 1) return [{ code: 'ESTIMATE_BULK_TARGET_AMBIGUOUS', groupId: group.groupId, candidateEstimateIds: auto.candidates.map(record => text(record.estimateId)), message: `${label}에 정확히 일치하는 견적서가 여러 개입니다.` }];
    return [{ code: 'ESTIMATE_BULK_TARGET_UNRESOLVED', groupId: group.groupId, message: `${label}의 기존 견적서를 선택하거나 새 견적서를 명시적으로 등록하세요.` }];
  }
  const target = recordsById.get(decision.targetEstimateId);
  if (!target) return [{ code: 'ESTIMATE_BULK_TARGET_MISSING', groupId: group.groupId, targetEstimateId: decision.targetEstimateId, message: `${label}의 선택 대상이 없습니다.` }];
  if (target.estimateKind === 'LINKED_GROUP') return [{ code: 'ESTIMATE_BULK_LINKED_TARGET_FORBIDDEN', groupId: group.groupId, targetEstimateId: decision.targetEstimateId, message: '연동견적서는 업데이트 대상으로 선택할 수 없습니다.' }];
  return [];
}

function planSummary(entries) {
  const summary = { total: entries.length, ready: 0, pending: 0, unchanged: 0, completed: 0, failed: 0, excluded: 0 };
  entries.forEach(entry => {
    const key = text(entry.status).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, key)) summary[key] += 1;
  });
  return summary;
}

export function createEstimatePerCustomerPlan({ classification, estimates = [], selections = {}, session, workingCopies = [], progress } = {}) {
  const groups = Array.isArray(classification?.groups) ? classification.groups : [];
  const allRecords = (Array.isArray(estimates) ? estimates : []).filter(record => record?.estimateId);
  const individualRecords = allRecords.filter(record => record.estimateKind !== 'LINKED_GROUP');
  const recordsById = new Map(allRecords.map(record => [text(record.estimateId), record]));
  const fileFingerprint = createFileFingerprint(session || {});
  const previousGroups = progress?.schemaVersion === PROGRESS_SCHEMA_VERSION && progress.fileFingerprint === fileFingerprint
    ? progress.groups || {}
    : {};
  const drafts = groups.map(group => {
    let split = null;
    let splitIssue = null;
    if (group.groupType !== 'UNASSIGNED' && group.itemRows?.length) {
      try {
        split = splitEstimateBulkInputMapping({ session, rows: group.itemRows });
      } catch (error) {
        splitIssue = { code: 'ESTIMATE_BULK_SOURCE_EVIDENCE_UNSAFE', groupId: group.groupId, message: `원본 증적을 거래처별로 안전하게 분할할 수 없습니다. (${text(error?.message)})` };
      }
    }
    const fingerprint = groupFingerprint(group, split);
    const previousEntry = previousGroups[group.groupId]?.groupFingerprint === fingerprint ? previousGroups[group.groupId] : null;
    const selection = Object.prototype.hasOwnProperty.call(selections || {}, group.groupId) ? selections[group.groupId] : undefined;
    const decision = normalizeDecision(selection, previousEntry, group, individualRecords);
    const issues = [...groupReviewIssues(group), ...issueForDecision(decision, group, recordsById, individualRecords)];
    if (splitIssue) issues.push(splitIssue);
    return { group, groupId: group.groupId, split, groupFingerprint: fingerprint, previousEntry, decision, issues };
  });

  const targetGroups = new Map();
  drafts.filter(entry => entry.decision.action === 'UPDATE' && entry.decision.targetEstimateId).forEach(entry => {
    targetGroups.set(entry.decision.targetEstimateId, [...(targetGroups.get(entry.decision.targetEstimateId) || []), entry]);
  });
  targetGroups.forEach((duplicates, targetEstimateId) => {
    if (duplicates.length < 2) return;
    duplicates.forEach(entry => entry.issues.push({
      code: 'ESTIMATE_BULK_TARGET_DUPLICATED',
      groupId: entry.groupId,
      targetEstimateId,
      groupIds: duplicates.map(candidate => candidate.groupId),
      message: '같은 기존 견적서를 두 원본 거래처에 중복 연결할 수 없습니다.'
    }));
  });

  const targetIds = [...targetGroups.keys()];
  const workingConflicts = inspectEstimateBulkWorkingCopyConflicts({ targetEstimateIds: targetIds, estimates: allRecords, workingCopies });
  drafts.forEach(entry => {
    if (entry.decision.action !== 'UPDATE') return;
    workingConflicts.filter(conflict => (conflict.targetEstimateIds || []).includes(entry.decision.targetEstimateId))
      .forEach(conflict => entry.issues.push({ ...conflict, groupId: entry.groupId }));
  });

  const entries = drafts.map(entry => {
    const target = entry.decision.action === 'UPDATE' ? recordsById.get(entry.decision.targetEstimateId) || null : null;
    const fingerprint = decisionFingerprint(entry.decision);
    const previousStatus = entry.previousEntry?.decisionFingerprint === fingerprint ? text(entry.previousEntry.status).toUpperCase() : '';
    let status = ESTIMATE_BULK_GROUP_STATUS.READY;
    if (entry.decision.action === 'EXCLUDE') status = ESTIMATE_BULK_GROUP_STATUS.EXCLUDED;
    else if (entry.issues.length) status = ESTIMATE_BULK_GROUP_STATUS.PENDING;
    else if ([ESTIMATE_BULK_GROUP_STATUS.COMPLETED, ESTIMATE_BULK_GROUP_STATUS.UNCHANGED].includes(previousStatus)) status = previousStatus;
    else if (target && estimateBulkDraftsEquivalent(target.draft, { rows: entry.split?.rows || [], inputMapping: entry.split?.session || {} })) status = ESTIMATE_BULK_GROUP_STATUS.UNCHANGED;
    else if (previousStatus === ESTIMATE_BULK_GROUP_STATUS.FAILED) status = ESTIMATE_BULK_GROUP_STATUS.FAILED;
    const candidate = entry.issues.length || entry.decision.action === 'EXCLUDE' ? null : {
      action: entry.decision.action,
      targetEstimateId: entry.decision.targetEstimateId,
      target,
      catalogName: entry.decision.catalogName,
      split: entry.split
    };
    const previousFailure = previousStatus === ESTIMATE_BULK_GROUP_STATUS.FAILED && entry.previousEntry?.errorMessage
      ? { code: entry.previousEntry.errorCode || 'ESTIMATE_BULK_GROUP_COMMIT_FAILED', groupId: entry.groupId, message: entry.previousEntry.errorMessage }
      : null;
    return {
      ...entry,
      action: entry.decision.action,
      targetEstimateId: entry.decision.targetEstimateId,
      target,
      catalogName: entry.decision.catalogName,
      decisionFingerprint: fingerprint,
      firstIssue: entry.issues[0] || previousFailure,
      errorCode: previousFailure?.code || '',
      errorMessage: previousFailure?.message || '',
      status,
      candidate
    };
  });
  return { schemaVersion: PROGRESS_SCHEMA_VERSION, fileFingerprint, entries, summary: planSummary(entries) };
}

export function createEstimateBulkProgress({ plan, statusOverrides = {} } = {}) {
  const entries = Array.isArray(plan?.entries) ? plan.entries : [];
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    fileFingerprint: text(plan?.fileFingerprint),
    groups: Object.fromEntries(entries.map(entry => {
      const override = statusOverrides[entry.groupId] || {};
      const status = text(override.status || entry.status).toUpperCase();
      const targetEstimateId = text(override.targetEstimateId ?? entry.targetEstimateId);
      const action = text(override.action || (status === ESTIMATE_BULK_GROUP_STATUS.COMPLETED && targetEstimateId ? 'UPDATE' : entry.action)).toUpperCase();
    const catalogName = action === 'CREATE' ? text(override.catalogName ?? entry.catalogName) : '';
      const decision = { action, targetEstimateId, catalogName };
      return [entry.groupId, {
        groupFingerprint: entry.groupFingerprint,
        decisionFingerprint: decisionFingerprint(decision),
        action,
        targetEstimateId,
        catalogName,
        status,
        itemCount: Number(entry.group?.itemCount || 0),
        firstIssue: clone(override.firstIssue === undefined ? entry.firstIssue : override.firstIssue),
        errorCode: text(override.errorCode ?? entry.errorCode),
        errorMessage: text(override.errorMessage ?? entry.errorMessage),
        updatedAt: text(override.updatedAt)
      }];
    }))
  };
}
