import { linkedEstimateWorkingDraftsEquivalent } from './linked-estimate-source-edit.js?v=0.1.2';

const text = value => String(value ?? '').trim();
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const ESTIMATE_BULK_TARGET_MATCH_TYPE = 'ESTIMATE_BULK_TARGET';
export const ESTIMATE_BULK_TARGET_MATCH_SCHEMA = 'ONEAPP_SMARTINPUT_ESTIMATE_BULK_TARGET_MATCH_V1';

export function estimateBulkTargetMatchContextKey(companyId = '') {
  const company = text(companyId);
  return company ? `${ESTIMATE_BULK_TARGET_MATCH_TYPE}:${company}` : '';
}

function normalizeEstimateBulkMatchName(value) {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/\s+/g, ' ')
    .replace(/[.,:;·_()[\]{}<>]/g, '');
}

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
    ['CUSTOMER_CODE', group.customerCode, record => estimateIdentity(record).customerCode]
  ];
  for (const [method, sourceValue, valueForRecord] of stages) {
    if (!sourceValue) continue;
    const candidates = records.filter(record => valueForRecord(record) === sourceValue);
    if (candidates.length) return { method, candidates };
  }
  return { method: '', candidates: [] };
}

function normalizedNameTargetCandidates(group, records) {
  const sourceValue = normalizeEstimateBulkMatchName(group.customerName);
  if (!sourceValue) return [];
  return records.filter(record => normalizeEstimateBulkMatchName(estimateIdentity(record).customerName) === sourceValue);
}

function rememberedTargetCandidates(group, records, matchMappings, companyId) {
  const contextKey = estimateBulkTargetMatchContextKey(companyId);
  if (!contextKey) return { method: '', candidates: [], ambiguous: false, missingTargetIds: [] };
  const recordsById = new Map(records.map(record => [text(record.estimateId), record]));
  const scoped = (Array.isArray(matchMappings) ? matchMappings : [])
    .filter(mapping => mapping?.mappingType === ESTIMATE_BULK_TARGET_MATCH_TYPE)
    .filter(mapping => mapping.status === 'CONFIRMED' && mapping.contextKey === contextKey);
  const confirmedNameMapping = mapping => {
    const identityType = text(mapping.sourceIdentityType).toUpperCase();
    if (identityType && identityType !== 'NORMALIZED_NAME') return false;
    return Boolean(text(mapping.confirmedBy) && text(mapping.confirmedAt));
  };
  const stages = [
    ['MATCH_DICTIONARY_CUSTOMER_ID', group.customerId, mapping => text(mapping.sourceCustomerId), () => true],
    ['MATCH_DICTIONARY_CUSTOMER_CODE', group.customerCode, mapping => text(mapping.sourceCustomerCode), () => true],
    ['MATCH_DICTIONARY_NAME', group.customerId || group.customerCode ? '' : normalizeEstimateBulkMatchName(group.customerName), mapping => normalizeEstimateBulkMatchName(mapping.normalizedName || mapping.sourceCustomerName || mapping.rawOrdererName), confirmedNameMapping]
  ];
  for (const [method, sourceValue, valueForMapping, eligible] of stages) {
    if (!sourceValue) continue;
    const targetIds = [...new Set(scoped.filter(mapping => eligible(mapping) && valueForMapping(mapping) === sourceValue)
      .map(mapping => text(mapping.targetEstimateId)).filter(Boolean))];
    if (!targetIds.length) continue;
    const missingTargetIds = targetIds.filter(targetId => !recordsById.has(targetId));
    return {
      method,
      candidates: targetIds.map(targetId => recordsById.get(targetId)).filter(Boolean),
      ambiguous: targetIds.length > 1,
      missingTargetIds
    };
  }
  return { method: '', candidates: [], ambiguous: false, missingTargetIds: [] };
}

export function resolveEstimateBulkTargets({ groups = [], estimates = [], selections = {}, matchMappings = [], companyId = '' } = {}) {
  const allRecords = (Array.isArray(estimates) ? estimates : []).filter(record => record?.estimateId);
  const individualRecords = allRecords.filter(record => record.estimateKind !== 'LINKED_GROUP');
  const recordsById = new Map(allRecords.map(record => [text(record.estimateId), record]));
  const issues = [];
  const assignments = (Array.isArray(groups) ? groups : []).map(group => {
    const hasManualSelection = Object.prototype.hasOwnProperty.call(selections || {}, group.groupId);
    const remembered = rememberedTargetCandidates(group, individualRecords, matchMappings, companyId);
    const auto = autoTargetCandidates(group, individualRecords);
    const nameCandidates = normalizedNameTargetCandidates(group, individualRecords);
    let targetEstimateId = '';
    let matchMethod = remembered.method || auto.method;
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
    } else if (remembered.candidates.length === 1 && !remembered.ambiguous && !remembered.missingTargetIds.length) {
      targetEstimateId = text(remembered.candidates[0].estimateId);
    } else if (remembered.missingTargetIds.length) {
      issues.push({
        code: 'ESTIMATE_BULK_MATCH_TARGET_MISSING',
        groupId: group.groupId,
        targetEstimateIds: remembered.missingTargetIds,
        message: `${group.customerName || group.customerCode || group.customerId}의 기존 매핑 대상 견적서가 삭제되었습니다.`
      });
    } else if (remembered.ambiguous) {
      issues.push({
        code: 'ESTIMATE_BULK_MATCH_DICTIONARY_AMBIGUOUS',
        groupId: group.groupId,
        candidateEstimateIds: remembered.candidates.map(record => text(record.estimateId)),
        message: `${group.customerName || group.customerCode || group.customerId}의 매칭사전에 서로 다른 대상이 있습니다.`
      });
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
        code: nameCandidates.length ? 'ESTIMATE_BULK_NAME_CONFIRMATION_REQUIRED' : 'ESTIMATE_BULK_TARGET_UNRESOLVED',
        groupId: group.groupId,
        candidateEstimateIds: nameCandidates.map(record => text(record.estimateId)),
        message: nameCandidates.length
          ? `${group.customerName || group.customerCode || group.customerId}와 이름이 같은 견적서를 확인하세요.`
          : `${group.customerName || group.customerCode || group.customerId}에 정확히 일치하는 기존 견적서가 없습니다.`
      });
    }
    return {
      group,
      groupId: group.groupId,
      targetEstimateId,
      target: targetEstimateId ? recordsById.get(targetEstimateId) || null : null,
      matchMethod,
      candidateEstimateIds: [...new Set([...auto.candidates, ...nameCandidates].map(record => text(record.estimateId)))]
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
  if (session.estimateErpSummary?.recognized) {
    nextSession.estimateErpSummary = {
      ...clone(session.estimateErpSummary),
      customerCount: 1,
      itemCount: selectedRows.length,
      sourceRowCount: nextSourceMatrix.length,
      sourceColumnCount: Math.max(nextSession.headers.length, ...nextSourceMatrix.map(row => row.length), 0)
    };
  }
  return { session: nextSession, rows: mappedRows, rowIdMap: Object.fromEntries(rowIdMap) };
}

function normalizeItemIdentity(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ');
}

function itemIdentityKey(row, kind) {
  if (kind === 'MASTER_PRODUCT') {
    const value = normalizeItemIdentity(row?.masterProductId || row?.productId);
    return value ? `MASTER:${value}` : '';
  }
  if (kind === 'ITEM_CODE') {
    const value = normalizeItemIdentity(row?.itemCode);
    return value ? `CODE:${value}` : '';
  }
  const name = normalizeItemIdentity(row?.itemName);
  if (!name) return '';
  return `NAME:${name}|${normalizeItemIdentity(row?.specification)}|${normalizeItemIdentity(row?.unit)}`;
}

function higherItemIdentitiesCompatible(incoming, existing, kind) {
  if (kind === 'MASTER_PRODUCT') return true;
  const incomingMaster = itemIdentityKey(incoming, 'MASTER_PRODUCT');
  const existingMaster = itemIdentityKey(existing, 'MASTER_PRODUCT');
  if (incomingMaster && existingMaster && incomingMaster !== existingMaster) return false;
  if (kind === 'ITEM_CODE') return true;
  const incomingCode = itemIdentityKey(incoming, 'ITEM_CODE');
  const existingCode = itemIdentityKey(existing, 'ITEM_CODE');
  return !(incomingCode && existingCode && incomingCode !== existingCode);
}

function remapSplitRowIds(split, nextIdsByOldId) {
  const next = clone(split);
  next.rows = next.rows.map(row => ({ ...row, rowId: nextIdsByOldId.get(text(row.rowId)) || text(row.rowId) }));
  next.session.workingRows = (next.session.workingRows || []).map(row => ({
    ...row,
    rowId: nextIdsByOldId.get(text(row.rowId)) || text(row.rowId)
  }));
  next.session.manualRows = (next.session.manualRows || []).map(row => ({
    ...row,
    rowId: nextIdsByOldId.get(text(row.rowId)) || text(row.rowId)
  }));
  next.rowIdMap = Object.fromEntries([
    ...Object.entries(next.rowIdMap || {}).map(([sourceId, splitId]) => [sourceId, nextIdsByOldId.get(text(splitId)) || text(splitId)])
  ]);
  return next;
}

export function reconcileEstimateBulkRows({ targetRows = [], split, groupId = '' } = {}) {
  if (!split?.session || !Array.isArray(split?.rows)) throw new Error('ESTIMATE_BULK_RECONCILE_SPLIT_REQUIRED');
  const incoming = split.rows.map(row => clone(row));
  const existing = (Array.isArray(targetRows) ? targetRows : []).map(row => clone(row));
  const matchedIncoming = new Map();
  const matchedExisting = new Set();
  const blockedIncoming = new Set();
  const issues = [];
  const matchMethods = new Map();

  for (const kind of ['MASTER_PRODUCT', 'ITEM_CODE', 'NAME_SPEC_UNIT']) {
    const incomingBuckets = new Map();
    const existingBuckets = new Map();
    incoming.forEach((row, index) => {
      if (matchedIncoming.has(index) || blockedIncoming.has(index)) return;
      const key = itemIdentityKey(row, kind);
      if (key) incomingBuckets.set(key, [...(incomingBuckets.get(key) || []), index]);
    });
    existing.forEach((row, index) => {
      if (matchedExisting.has(index)) return;
      const key = itemIdentityKey(row, kind);
      if (key) existingBuckets.set(key, [...(existingBuckets.get(key) || []), index]);
    });
    incomingBuckets.forEach((incomingIndexes, key) => {
      const existingIndexes = existingBuckets.get(key) || [];
      if (!existingIndexes.length) return;
      const candidateMap = new Map(incomingIndexes.map(incomingIndex => [incomingIndex,
        existingIndexes.filter(existingIndex => higherItemIdentitiesCompatible(incoming[incomingIndex], existing[existingIndex], kind))
      ]));
      const candidateUseCount = new Map();
      candidateMap.forEach(candidates => candidates.forEach(existingIndex =>
        candidateUseCount.set(existingIndex, Number(candidateUseCount.get(existingIndex) || 0) + 1)));
      incomingIndexes.forEach(incomingIndex => {
        const candidates = candidateMap.get(incomingIndex) || [];
        if (!candidates.length) return;
        if (candidates.length === 1 && candidateUseCount.get(candidates[0]) === 1) {
          matchedIncoming.set(incomingIndex, candidates[0]);
          matchedExisting.add(candidates[0]);
          matchMethods.set(incomingIndex, kind);
          return;
        }
        blockedIncoming.add(incomingIndex);
        issues.push({
          code: 'ESTIMATE_BULK_ROW_MATCH_AMBIGUOUS',
          groupId: text(groupId),
          matchMethod: kind,
          sourceRowIds: [text(incoming[incomingIndex].rowId)],
          candidateRowIds: candidates.map(index => text(existing[index].rowId)),
          message: `${incoming[incomingIndex]?.itemName || incoming[incomingIndex]?.itemCode || '품목'}의 기존 행이 여러 개이거나 1:1로 연결되지 않습니다.`
        });
      });
    });
  }

  incoming.forEach((row, index) => {
    if (matchedIncoming.has(index) || blockedIncoming.has(index)) return;
    const identified = ['MASTER_PRODUCT', 'ITEM_CODE', 'NAME_SPEC_UNIT'].some(kind => itemIdentityKey(row, kind));
    if (identified) return;
    blockedIncoming.add(index);
    issues.push({
      code: 'ESTIMATE_BULK_ITEM_IDENTITY_REQUIRED',
      groupId: text(groupId),
      rowId: text(row.rowId),
      message: '신규 품목을 자동 추가하려면 상품 ID, 품목코드 또는 품명·규격·단위 식별값이 필요합니다.'
    });
  });

  const oldIds = new Set(existing.map(row => text(row.rowId)).filter(Boolean));
  const usedIds = new Set();
  const nextIdsByOldId = new Map();
  incoming.forEach((row, index) => {
    const splitRowId = text(row.rowId);
    const existingIndex = matchedIncoming.get(index);
    if (existingIndex !== undefined) {
      const retainedId = text(existing[existingIndex].rowId);
      if (!retainedId || usedIds.has(retainedId)) {
        blockedIncoming.add(index);
        issues.push({
          code: 'ESTIMATE_BULK_ROW_ID_COLLISION',
          groupId: text(groupId),
          rowId: splitRowId,
          message: `${row.itemName || row.itemCode || '품목'}의 기존 행 ID를 안전하게 유지할 수 없습니다.`
        });
        return;
      }
      usedIds.add(retainedId);
      nextIdsByOldId.set(splitRowId, retainedId);
      return;
    }
    if (blockedIncoming.has(index)) return;
    const seed = stableFingerprint('SIROW-BULK', {
      groupId: text(groupId),
      sourceRowId: splitRowId,
      productId: text(row.masterProductId || row.productId),
      itemCode: text(row.itemCode),
      itemName: text(row.itemName),
      specification: text(row.specification),
      unit: text(row.unit)
    });
    let nextId = seed;
    let suffix = 2;
    while (oldIds.has(nextId) || usedIds.has(nextId)) {
      nextId = `${seed}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(nextId);
    nextIdsByOldId.set(splitRowId, nextId);
  });

  const reconciled = remapSplitRowIds(split, nextIdsByOldId);
  return {
    split: reconciled,
    issues,
    retainedRowCount: matchedIncoming.size,
    addedRowCount: incoming.length - matchedIncoming.size - blockedIncoming.size,
    removedRowIds: existing.filter((unused, index) => !matchedExisting.has(index)).map(row => text(row.rowId)).filter(Boolean),
    rowMatches: incoming.flatMap((row, index) => matchedIncoming.has(index) ? [{
      sourceRowId: text(row.rowId),
      targetRowId: text(existing[matchedIncoming.get(index)].rowId),
      matchMethod: matchMethods.get(index)
    }] : [])
  };
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

export function createEstimateBulkConnectedComponents({ entries = [], estimates = [] } = {}) {
  const candidates = (entries || []).filter(entry => entry?.groupId);
  const parent = new Map(candidates.map(entry => [entry.groupId, entry.groupId]));
  const find = value => {
    let root = value;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = value;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const entryByTarget = new Map(candidates
    .filter(entry => text(entry.targetEstimateId))
    .map(entry => [text(entry.targetEstimateId), entry]));
  (estimates || []).filter(record => record?.estimateKind === 'LINKED_GROUP').forEach(linked => {
    const connected = (linked.linkedEstimateSources || [])
      .map(source => entryByTarget.get(text(source.estimateId)))
      .filter(Boolean);
    connected.slice(1).forEach(entry => union(connected[0].groupId, entry.groupId));
  });
  const groups = new Map();
  candidates.forEach(entry => {
    const root = find(entry.groupId);
    groups.set(root, [...(groups.get(root) || []), entry]);
  });
  return [...groups.values()];
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

function normalizeDecision(selection, previousEntry, group, individualRecords, matchMappings, companyId) {
  if (selection !== undefined) {
    if (typeof selection === 'string') return selection ? { action: 'UPDATE', targetEstimateId: text(selection), catalogName: '', matchMethod: 'MANUAL' } : { action: 'NONE', targetEstimateId: '', catalogName: '', matchMethod: 'MANUAL' };
    const action = text(selection?.action).toUpperCase() || 'NONE';
    return {
      action,
      targetEstimateId: text(selection?.targetEstimateId),
      catalogName: action === 'CREATE' ? text(selection?.catalogName) : '',
      matchMethod: text(selection?.matchMethod) || 'MANUAL'
    };
  }
  if (previousEntry?.action && previousEntry.groupFingerprint) {
    return {
      action: text(previousEntry.action).toUpperCase(),
      targetEstimateId: text(previousEntry.targetEstimateId),
      catalogName: text(previousEntry.catalogName),
      matchMethod: text(previousEntry.matchMethod) || 'PROGRESS'
    };
  }
  if (group.groupType === 'UNASSIGNED') return { action: 'NONE', targetEstimateId: '', catalogName: '', matchMethod: '' };
  const remembered = rememberedTargetCandidates(group, individualRecords, matchMappings, companyId);
  if (remembered.candidates.length === 1 && !remembered.ambiguous && !remembered.missingTargetIds.length) {
    return { action: 'UPDATE', targetEstimateId: text(remembered.candidates[0].estimateId), catalogName: '', matchMethod: remembered.method };
  }
  const auto = autoTargetCandidates(group, individualRecords);
  if (!remembered.ambiguous && !remembered.missingTargetIds.length && auto.candidates.length === 1) {
    return { action: 'UPDATE', targetEstimateId: text(auto.candidates[0].estimateId), catalogName: '', matchMethod: auto.method };
  }
  return {
    action: 'NONE',
    targetEstimateId: '',
    catalogName: '',
    matchMethod: remembered.method,
    auto,
    remembered,
    nameCandidates: normalizedNameTargetCandidates(group, individualRecords)
  };
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
    if (decision.remembered?.missingTargetIds?.length) return [{
      code: 'ESTIMATE_BULK_MATCH_TARGET_MISSING',
      groupId: group.groupId,
      targetEstimateIds: decision.remembered.missingTargetIds,
      message: `${label}의 기존 매핑 대상 견적서가 삭제되었습니다.`
    }];
    if (decision.remembered?.ambiguous) return [{
      code: 'ESTIMATE_BULK_MATCH_DICTIONARY_AMBIGUOUS',
      groupId: group.groupId,
      candidateEstimateIds: decision.remembered.candidates.map(record => text(record.estimateId)),
      message: `${label}의 매칭사전에 서로 다른 대상이 있습니다.`
    }];
    const auto = decision.auto || autoTargetCandidates(group, individualRecords);
    if (auto.candidates.length > 1) return [{ code: 'ESTIMATE_BULK_TARGET_AMBIGUOUS', groupId: group.groupId, candidateEstimateIds: auto.candidates.map(record => text(record.estimateId)), message: `${label}에 정확히 일치하는 견적서가 여러 개입니다.` }];
    if (decision.nameCandidates?.length) return [{
      code: 'ESTIMATE_BULK_NAME_CONFIRMATION_REQUIRED',
      groupId: group.groupId,
      candidateEstimateIds: decision.nameCandidates.map(record => text(record.estimateId)),
      message: `${label}와 이름이 같은 견적서를 확인하세요. 한 번 확인하면 다음 업데이트부터 자동 연결됩니다.`
    }];
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

export function createEstimatePerCustomerPlan({ classification, estimates = [], selections = {}, session, workingCopies = [], activeEstimateId = '', progress, matchMappings = [], companyId = '' } = {}) {
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
    const decision = normalizeDecision(selection, previousEntry, group, individualRecords, matchMappings, companyId);
    const target = decision.action === 'UPDATE' ? recordsById.get(decision.targetEstimateId) || null : null;
    let rowReconciliation = null;
    if (target && split) {
      rowReconciliation = reconcileEstimateBulkRows({
        targetRows: target.draft?.rows || [],
        split,
        groupId: group.groupId
      });
      split = rowReconciliation.split;
    }
    const issues = [
      ...groupReviewIssues(group),
      ...issueForDecision(decision, group, recordsById, individualRecords),
      ...(rowReconciliation?.issues || [])
    ];
    if (splitIssue) issues.push(splitIssue);
    return { group, groupId: group.groupId, split, rowReconciliation, groupFingerprint: fingerprint, previousEntry, decision, issues };
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
  const normalizedActiveEstimateId = text(activeEstimateId);
  const protectedWorkingCopies = (workingCopies || []).filter(copy => text(copy?.estimateId) !== normalizedActiveEstimateId);
  const workingConflicts = inspectEstimateBulkWorkingCopyConflicts({ targetEstimateIds: targetIds, estimates: allRecords, workingCopies: protectedWorkingCopies });
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
      matchMethod: entry.decision.matchMethod,
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
      matchMethod: entry.decision.matchMethod,
      decisionFingerprint: fingerprint,
      firstIssue: entry.issues[0] || previousFailure,
      errorCode: previousFailure?.code || '',
      errorMessage: previousFailure?.message || '',
      status,
      candidate
    };
  });
  createEstimateBulkConnectedComponents({ entries, estimates: allRecords }).forEach((component, componentIndex) => {
    const componentId = `COMPONENT-${componentIndex + 1}`;
    component.forEach(entry => { entry.connectedComponentId = componentId; });
    if (component.length < 2) return;
    const blocker = component.find(entry => [ESTIMATE_BULK_GROUP_STATUS.PENDING, ESTIMATE_BULK_GROUP_STATUS.FAILED].includes(entry.status));
    if (!blocker) return;
    component.forEach(entry => {
      if (![ESTIMATE_BULK_GROUP_STATUS.READY, ESTIMATE_BULK_GROUP_STATUS.FAILED].includes(entry.status) || entry.groupId === blocker.groupId) return;
      const issue = {
        code: 'ESTIMATE_BULK_CONNECTED_COMPONENT_PENDING',
        groupId: entry.groupId,
        blockingGroupId: blocker.groupId,
        message: `${blocker.group?.customerName || '연결된 견적서'} 확인이 끝나면 이 연결 묶음도 함께 처리됩니다.`
      };
      entry.issues.push(issue);
      entry.firstIssue = issue;
      entry.status = ESTIMATE_BULK_GROUP_STATUS.PENDING;
      entry.candidate = null;
    });
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
        matchMethod: text(override.matchMethod ?? entry.matchMethod),
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
