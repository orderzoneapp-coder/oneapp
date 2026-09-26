import assert from 'node:assert/strict';
import {
  ESTIMATE_BULK_TARGET_MATCH_SCHEMA,
  ESTIMATE_BULK_TARGET_MATCH_TYPE,
  classifyEstimateBulkRows,
  collectEstimateBulkReadPreimages,
  createEstimatePerCustomerPlan,
  createEstimateBulkReplacementRecord,
  createEstimateBulkConnectedComponents,
  enrichEstimateBulkCustomerIdentities,
  inspectEstimateBulkWorkingCopyConflicts,
  reconcileEstimateBulkRows,
  resolveEstimateBulkTargets,
  splitEstimateBulkInputMapping
} from '../smartinput/estimate-bulk-update.js';
import { estimateIncomingFieldEnvelope } from '../smartinput/independent-estimate.js';
import { rebuildLinkedEstimateRecord, rebaseLinkedEstimateWorkingDraft } from '../smartinput/linked-estimate-source-edit.js';
import { buildEstimateF8Data, buildEstimateF8RowsFromDraft } from '../smartinput/report.js';
import { ESTIMATE_REPORT_HEADERS } from '../smartinput/input.js';

const distribution = [72, 51, 32, 25, 22, 20, 18, 18, 12, 7];
const headers = ['거래처명', '품목코드', '품목명', '수량', '출고가', '적요'];
const sourceMatrix = [['견적서 현황'], headers];
const sourceCellMatrix = [[{ address: 'A1', rowIndex: 0, columnIndex: 0, displayValue: '견적서 현황' }], headers.map((value, index) => ({
  address: `${String.fromCharCode(65 + index)}2`, rowIndex: 1, columnIndex: index, displayValue: value
}))];
const workingRows = [];
const rows = [];
let sourceIndex = 2;
distribution.forEach((count, customerIndex) => {
  for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
    const customerName = `거래처 ${customerIndex + 1}`;
    const itemCode = itemIndex === 0 ? 'SHARED-CODE' : `C${customerIndex + 1}-${itemIndex + 1}`;
    const quantity = customerIndex === 0 && itemIndex === 0 ? 0 : (customerIndex === 1 && itemIndex === 0 ? -2 : 1);
    const unitPrice = customerIndex === 2 && itemIndex === 0 ? 0 : 1000 + customerIndex;
    const values = [customerName, itemCode, `품목 ${customerIndex + 1}-${itemIndex + 1}`, String(quantity), String(unitPrice), itemIndex === 1 ? '' : '메모'];
    const cells = values.map((displayValue, columnIndex) => ({
      address: `${String.fromCharCode(65 + columnIndex)}${sourceIndex + 1}`,
      rowIndex: sourceIndex,
      columnIndex,
      displayValue,
      rawValue: displayValue,
      blank: displayValue === ''
    }));
    sourceMatrix.push(values);
    sourceCellMatrix.push(cells);
    workingRows.push({ rowId: `source-${sourceIndex}`, sourceRowIndex: sourceIndex, cells: [...values], sourceCells: cells, manual: false });
    rows.push({
      rowId: `source-${sourceIndex}`,
      sourceRowNo: sourceIndex + 1,
      rowCustomerName: customerName,
      itemCode,
      itemName: `품목 ${customerIndex + 1}-${itemIndex + 1}`,
      quantity,
      unitPrice,
      memo: values[5],
      fieldValues: {
        'voucher.estimate.line.itemCode': {
          currentDisplayValue: itemCode,
          evidence: { ...cells[1], signature: 'ROW-EVIDENCE' }
        }
      }
    });
    sourceIndex += 1;
  }
});
sourceMatrix.push(['2026-09-04 14:30:00']);
sourceCellMatrix.push([{ address: `A${sourceIndex + 1}`, rowIndex: sourceIndex, columnIndex: 0, displayValue: '2026-09-04 14:30:00' }]);
workingRows.push({
  rowId: `source-${sourceIndex}`,
  sourceRowIndex: sourceIndex,
  cells: ['2026-09-04 14:30:00', '', '', '', '', ''],
  sourceCells: sourceCellMatrix[sourceIndex],
  manual: false
});
rows.push({ rowId: `source-${sourceIndex}`, sourceRowNo: sourceIndex + 1, rowVoucherDate: '2026-09-04 14:30:00' });

const session = {
  schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
  sessionId: 'SESSION-ORIGINAL',
  companyId: 'COMPANY',
  voucherMode: 'estimate',
  sourceMatrix,
  sourceCellMatrix,
  headerRowIndex: 1,
  headers,
  headerSignature: 'HEADER-SIGNATURE',
  signature: 'TEMPLATE-SIGNATURE',
  templateId: 'TEMPLATE-1',
  templateName: '견적서 현황',
  status: 'TEMPLATE_APPLIED',
  mappings: headers.map((sourceHeader, columnIndex) => ({ columnIndex, sourceHeader, state: 'MAPPED', targetFieldId: `FIELD-${columnIndex}`, reviewed: true })),
  editJournal: { '2:5': '수정 메모' },
  manualRows: [],
  deletedSourceRows: [],
  workingRows
};

const classified = classifyEstimateBulkRows(rows);
assert.equal(classified.groups.length, 10);
assert.equal(classified.totalItemRows, 277);
assert.equal(classified.ignoredRows.length, 1, '거래처와 품목 식별값이 없는 날짜/시간 푸터는 무시해야 한다.');
assert.equal(classified.issues.length, 0);
assert.equal(classified.groups.reduce((sum, group) => sum + group.rows.length, 0), 277);
assert.equal(classified.groups.filter(group => group.rows.some(row => row.itemCode === 'SHARED-CODE')).length, 10, '서로 다른 거래처의 동일 품목코드는 모두 보존해야 한다.');
assert.equal(classified.groups[0].rows[0].quantity, 0, '숫자 0은 품목행 값으로 보존해야 한다.');
assert.equal(classified.groups[1].rows[0].quantity, -2, '음수도 품목행 값으로 보존해야 한다.');
assert.equal(classified.groups[0].rows[1].memo, '', '내부 빈 셀은 보존해야 한다.');

const partial = classifyEstimateBulkRows([
  { rowId: 'customer-only', rowCustomerName: '거래처' },
  { rowId: 'item-only', itemCode: 'ONLY-ITEM' }
]);
assert.deepEqual(partial.issues.map(issue => issue.code), ['ESTIMATE_BULK_CUSTOMER_ONLY_ROW', 'ESTIMATE_BULK_ITEM_ONLY_ROW']);

const identityGroups = classifyEstimateBulkRows([
  { rowId: 'id', rowCustomerId: 'CUS-ID', rowCustomerCode: 'C-1', rowCustomerName: '정확 상호', itemCode: 'A' },
  { rowId: 'code', rowCustomerCode: 'C-2', rowCustomerName: '코드 상호', itemCode: 'B' },
  { rowId: 'name', rowCustomerName: '  이름   상호  ', itemCode: 'C' },
  { rowId: 'fuzzy', rowCustomerName: '비슷 상호', itemCode: 'D' }
]).groups;
const estimates = [
  { estimateId: 'EST-ID', estimateKind: 'INDIVIDUAL', customerId: 'CUS-ID', customerCode: 'WRONG', customerName: '다른 이름', catalogName: 'ID 대상', draft: { header: {}, rows: [] } },
  { estimateId: 'EST-CODE', estimateKind: 'INDIVIDUAL', customerCode: 'C-2', customerName: '다른 코드 상호', catalogName: 'CODE 대상', draft: { header: {}, rows: [] } },
  { estimateId: 'EST-NAME', estimateKind: 'INDIVIDUAL', customerName: '이름 상호', catalogName: 'NAME 대상', draft: { header: {}, rows: [] } },
  { estimateId: 'EST-FUZZY', estimateKind: 'INDIVIDUAL', customerName: '비슷 상호 지점', catalogName: '유사 대상', draft: { header: {}, rows: [] } },
  { estimateId: 'EST-LINKED', estimateKind: 'LINKED_GROUP', customerName: '비슷 상호', catalogName: '연동 대상', draft: { header: {}, rows: [] } }
];
const autoResolved = resolveEstimateBulkTargets({ groups: identityGroups, estimates });
assert.equal(autoResolved.assignments[0].targetEstimateId, 'EST-ID');
assert.equal(autoResolved.assignments[0].matchMethod, 'CUSTOMER_ID');
assert.equal(autoResolved.assignments[1].targetEstimateId, 'EST-CODE');
assert.equal(autoResolved.assignments[1].matchMethod, 'CUSTOMER_CODE');
assert.equal(autoResolved.assignments[2].targetEstimateId, '', '이름만 같은 최초 후보는 관리자 확인 없이 자동 선택하면 안 된다.');
assert.ok(autoResolved.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_UNRESOLVED'));
const idCodeConflict = resolveEstimateBulkTargets({
  groups: [{ ...identityGroups[0], customerCode: 'C-2' }],
  estimates
});
assert.equal(idCodeConflict.assignments[0].targetEstimateId, '', '거래처 ID와 코드가 다른 견적서를 가리키면 ID 우선 자동선택을 하면 안 된다.');
assert.equal(idCodeConflict.issues[0].code, 'ESTIMATE_BULK_TARGET_ID_CODE_CONFLICT');
assert.deepEqual(idCodeConflict.issues[0].candidateEstimateIds.sort(), ['EST-CODE', 'EST-ID']);
assert.equal(autoResolved.assignments[3].targetEstimateId, '', 'fuzzy 이름과 연동그룹은 자동 대상이 되면 안 된다.');
assert.ok(autoResolved.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_UNRESOLVED'));
const rememberedMapping = {
  aliasMappingId: 'SIEMATCH-FUZZY',
  schemaVersion: ESTIMATE_BULK_TARGET_MATCH_SCHEMA,
  mappingType: ESTIMATE_BULK_TARGET_MATCH_TYPE,
  companyId: 'COMPANY',
  contextKey: `${ESTIMATE_BULK_TARGET_MATCH_TYPE}:COMPANY`,
  matchKey: identityGroups[3].groupId,
  sourceCustomerId: '',
  sourceCustomerCode: '',
  sourceCustomerName: '비슷 상호',
  normalizedName: '비슷 상호',
  targetEstimateId: 'EST-FUZZY',
  status: 'CONFIRMED',
  sourceIdentityType: 'NORMALIZED_NAME',
  confirmedBy: 'ADMIN',
  confirmedAt: '2026-09-01T00:00:00.000Z'
};
const rememberedResolved = resolveEstimateBulkTargets({
  groups: [identityGroups[3]], estimates, matchMappings: [rememberedMapping], companyId: 'COMPANY'
});
assert.equal(rememberedResolved.assignments[0].targetEstimateId, 'EST-FUZZY');
assert.equal(rememberedResolved.assignments[0].matchMethod, 'MATCH_DICTIONARY_NAME');
assert.equal(resolveEstimateBulkTargets({
  groups: [identityGroups[3]], estimates, matchMappings: [{ ...rememberedMapping, targetEstimateId: 'MISSING' }], companyId: 'COMPANY'
}).assignments[0].targetEstimateId, '', '삭제된 매칭사전 대상은 자동 적용하면 안 된다.');
assert.equal(resolveEstimateBulkTargets({
  groups: [identityGroups[3]], estimates, matchMappings: [{ ...rememberedMapping, targetEstimateId: 'EST-LINKED' }], companyId: 'COMPANY'
}).assignments[0].targetEstimateId, '', '연동견적서는 매칭사전 대상이어도 자동 적용하면 안 된다.');
const conflictingRemembered = resolveEstimateBulkTargets({
  groups: [identityGroups[3]], estimates,
  matchMappings: [rememberedMapping, { ...rememberedMapping, aliasMappingId: 'SIEMATCH-CONFLICT', targetEstimateId: 'EST-NAME' }],
  companyId: 'COMPANY'
});
assert.equal(conflictingRemembered.assignments[0].targetEstimateId, '', '같은 원본 거래처에 서로 다른 매칭사전 대상이 있으면 fail closed 해야 한다.');
assert.ok(conflictingRemembered.issues.some(issue => issue.code === 'ESTIMATE_BULK_MATCH_DICTIONARY_AMBIGUOUS'));
const ambiguous = resolveEstimateBulkTargets({
  groups: [identityGroups[2]],
  estimates: [...estimates, { ...estimates[2], estimateId: 'EST-NAME-2', catalogName: '같은 이름의 두 번째 대상' }]
});
assert.equal(ambiguous.assignments[0].targetEstimateId, '', '정확한 이름이 복수여도 첫 후보를 자동선택하면 안 된다.');
assert.ok(ambiguous.issues.some(issue => issue.code === 'ESTIMATE_BULK_NAME_CONFIRMATION_REQUIRED'));
const explicitlyCleared = resolveEstimateBulkTargets({
  groups: [identityGroups[0]], estimates, selections: { [identityGroups[0].groupId]: '' }
});
assert.equal(explicitlyCleared.assignments[0].targetEstimateId, '', '작업자가 자동 연결을 지우면 다시 숨은 자동선택을 하면 안 된다.');
assert.ok(explicitlyCleared.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_UNRESOLVED'));

const manualResolved = resolveEstimateBulkTargets({
  groups: identityGroups,
  estimates,
  selections: { [identityGroups[2].groupId]: 'EST-NAME', [identityGroups[3].groupId]: 'EST-NAME' }
});
assert.equal(manualResolved.assignments[3].targetEstimateId, 'EST-NAME');
assert.equal(manualResolved.assignments[3].matchMethod, 'MANUAL');
assert.ok(manualResolved.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_DUPLICATED'), '같은 대상을 두 그룹이 선택하면 차단해야 한다.');
assert.ok(resolveEstimateBulkTargets({
  groups: [identityGroups[3]], estimates, selections: { [identityGroups[3].groupId]: 'EST-LINKED' }
}).issues.some(issue => issue.code === 'ESTIMATE_BULK_LINKED_TARGET_FORBIDDEN'));

const firstGroup = classified.groups[0];
const split = splitEstimateBulkInputMapping({ session, rows: firstGroup.rows });
assert.equal(split.session.headerRowIndex, 0);
assert.equal(split.session.sourceMatrix.length, firstGroup.rows.length + 1);
assert.deepEqual(split.session.sourceMatrix[0], headers);
assert.equal(split.session.signature, session.signature);
assert.equal(split.session.headerSignature, session.headerSignature);
assert.equal(split.session.mappings[0].targetFieldId, session.mappings[0].targetFieldId);
assert.equal(split.rows.length, firstGroup.rows.length);
assert.equal(split.rows[0].rowId, 'source-1');
assert.equal(split.rows[0].sourceRowNo, firstGroup.rows[0].sourceRowNo, '표시 원본 행번호는 원래 값으로 보존해야 한다.');
assert.equal(split.rows[0].fieldValues['voucher.estimate.line.itemCode'].evidence.address, 'B3', '원본 셀 주소 evidence를 보존해야 한다.');
assert.equal(split.session.sourceCellMatrix[1][0].address, 'A3');
assert.ok(!JSON.stringify(split.session.sourceMatrix).includes('거래처 2'), '분할 draft에 다른 거래처 원본 데이터가 있으면 안 된다.');
assert.equal(split.session.editJournal['1:5'], '수정 메모', '편집 journal은 압축된 원본 행 위치로 안전하게 이동해야 한다.');

const threeRowSplit = splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 3) });
const reconciled = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: threeRowSplit,
  targetRows: [
    { rowId: 'KEEP-CODE-2', itemCode: 'C1-2', itemName: '이전 이름' },
    { rowId: 'KEEP-SHARED', itemCode: 'SHARED-CODE', itemName: '이전 공유 품목' }
  ]
});
assert.deepEqual(reconciled.split.rows.map(row => row.rowId).slice(0, 2), ['KEEP-SHARED', 'KEEP-CODE-2'],
  '행 순서가 바뀌어도 품목코드 1:1 일치 행 ID는 반드시 유지해야 한다.');
assert.match(reconciled.split.rows[2].rowId, /^SIROW-BULK-/, '기존에 없는 식별 확정 품목은 확인 없이 새 행 ID로 자동 추가해야 한다.');
assert.equal(reconciled.retainedRowCount, 2);
assert.equal(reconciled.addedRowCount, 1);
assert.equal(reconciled.issues.length, 0);
assert.deepEqual(reconciled.split.session.workingRows.map(row => row.rowId), reconciled.split.rows.map(row => row.rowId),
  '작업행과 저장행의 rowId가 함께 갱신되어야 한다.');

const ambiguousRows = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 1) }),
  targetRows: [
    { rowId: 'DUP-1', itemCode: 'SHARED-CODE', itemName: '중복 1' },
    { rowId: 'DUP-2', itemCode: 'SHARED-CODE', itemName: '중복 2' }
  ]
});
assert.equal(ambiguousRows.issues[0].code, 'ESTIMATE_BULK_ROW_MATCH_AMBIGUOUS');
const ambiguousUseExisting = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 1) }),
  targetRows: [
    { rowId: 'DUP-1', itemCode: 'SHARED-CODE', itemName: '중복 1' },
    { rowId: 'DUP-2', itemCode: 'SHARED-CODE', itemName: '중복 2' }
  ],
  resolutions: { 'source-1': { action: 'USE_EXISTING', targetRowId: 'DUP-2' } }
});
assert.equal(ambiguousUseExisting.issues.length, 0);
assert.equal(ambiguousUseExisting.split.rows[0].rowId, 'DUP-2', '관리자가 선택한 기존 행 ID를 유지해야 한다.');
const ambiguousAddNew = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 1) }),
  targetRows: [
    { rowId: 'DUP-1', itemCode: 'SHARED-CODE', itemName: '중복 1' },
    { rowId: 'DUP-2', itemCode: 'SHARED-CODE', itemName: '중복 2' }
  ],
  resolutions: { 'source-1': { action: 'ADD_NEW' } }
});
assert.equal(ambiguousAddNew.issues.length, 0);
assert.equal(ambiguousAddNew.split.rows.some(row => row.rowId.startsWith('SIROW-BULK-')), true, '신규 행 결정은 새 ID를 생성해야 한다.');
assert.deepEqual(ambiguousAddNew.split.rows.filter(row => row.rowId.startsWith('DUP-')).map(row => row.rowId), ['DUP-1', 'DUP-2'], '신규 추가 시 기존 모호 후보는 보존해야 한다.');
const ambiguousExclude = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 1) }),
  targetRows: [
    { rowId: 'DUP-1', itemCode: 'SHARED-CODE', itemName: '중복 1' },
    { rowId: 'DUP-2', itemCode: 'SHARED-CODE', itemName: '중복 2' }
  ],
  resolutions: { 'source-1': { action: 'EXCLUDE' } }
});
assert.equal(ambiguousExclude.issues.length, 0);
assert.deepEqual(ambiguousExclude.split.rows.map(row => row.rowId), ['DUP-1', 'DUP-2'], '이번 품목 제외는 입력행만 제외하고 기존 후보를 보존해야 한다.');
assert.equal(ambiguousExclude.split.session.sourceMatrix.length, 1, '제외한 입력행은 저장 증적에서도 제거해야 한다.');

const components = createEstimateBulkConnectedComponents({
  entries: [
    { groupId: 'G-A', targetEstimateId: 'EST-A' },
    { groupId: 'G-B', targetEstimateId: 'EST-B' },
    { groupId: 'G-C', targetEstimateId: 'EST-C' }
  ],
  estimates: [{
    estimateId: 'LINK-A-B',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-B' }]
  }]
});
assert.deepEqual(components.map(component => component.map(entry => entry.groupId).sort()).sort((a, b) => a[0].localeCompare(b[0])), [['G-A', 'G-B'], ['G-C']],
  '같은 연동견적서가 참조하는 업데이트 대상은 하나의 저장 연결 묶음이어야 한다.');
const readPreimages = collectEstimateBulkReadPreimages({
  estimates: [
    { estimateId: 'EST-A', revision: 1 },
    { estimateId: 'EST-B', revision: 2 },
    { estimateId: 'LINK-A-B', estimateKind: 'LINKED_GROUP', revision: 3 },
    { estimateId: 'UNRELATED', revision: 4 }
  ],
  changedEstimateIds: ['EST-A', 'LINK-A-B'],
  linkedRecords: [{ estimateId: 'LINK-A-B', linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-B' }] }]
});
assert.deepEqual(readPreimages.map(record => record.estimateId), ['EST-A', 'EST-B', 'LINK-A-B'],
  '연동견적서 재구성에 읽은 변경 없는 EST-B도 같은 트랜잭션 preimage 검증에 포함해야 한다.');

const rebuiltLinked = rebuildLinkedEstimateRecord({
  linkedRecord: {
    estimateId: 'LINK-A-B',
    catalogName: '연동 A+B',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-B' }],
    draft: {
      rows: [
        { rowId: 'LINKED:EST-A:OLD-A', itemCode: 'A', itemName: '저장 당시 대표값', quantity: 99, linkedSourceRefs: [{ estimateId: 'EST-A', rowId: 'OLD-A' }] },
        { rowId: 'MANUAL-KEEP', itemCode: 'MANUAL', itemName: '수기 행', quantity: 3, inputOwnership: 'USER', linkedSourceRefs: [] }
      ]
    }
  },
  sourceRecords: [
    { estimateId: 'EST-A', estimateKind: 'INDIVIDUAL', catalogName: '원본 A', updatedAt: '2026-09-10T01:00:00.000Z', draft: { rows: [{ rowId: 'KEEP-A', itemCode: 'A', itemName: '최신 A', quantity: 1 }] } },
    { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL', catalogName: '원본 B', updatedAt: '2026-09-10T01:00:00.000Z', draft: { rows: [{ rowId: 'KEEP-B', itemCode: 'B', itemName: '최신 B', quantity: 2 }] } }
  ],
  occurredAt: '2026-09-10T01:01:00.000Z',
  operationId: 'OP-1'
});
assert.deepEqual(rebuiltLinked.draft.rows.map(row => [row.rowId, row.quantity]), [
  ['LINKED:EST-A:KEEP-A', 1],
  ['LINKED:EST-B:KEEP-B', 2],
  ['MANUAL-KEEP', 3]
], '연동견적서는 최신 원본 대표값으로 재구성하고 수기 행만 보존해야 한다.');
assert.equal(rebuiltLinked.estimateLinkHistory.at(-1).operationId, 'OP-1');

const baselineLinkedDraft = {
  rows: [{ rowId: 'LINKED:EST-A:KEEP-A', itemCode: 'A', itemName: '최신 A', quantity: 1, memo: '', linkedSourceRefs: [{ estimateId: 'EST-A', rowId: 'KEEP-A' }] }]
};
const workingLinkedDraft = structuredClone(baselineLinkedDraft);
workingLinkedDraft.rows[0].quantity = 9;
workingLinkedDraft.rows[0].editedFields = { quantity: true };
const sourceMemoUpdate = structuredClone(rebuiltLinked);
sourceMemoUpdate.draft.rows = [{ ...structuredClone(baselineLinkedDraft.rows[0]), memo: '원본 메모 변경' }];
const nonOverlapRebase = rebaseLinkedEstimateWorkingDraft({
  baselineDraft: baselineLinkedDraft,
  workingDraft: workingLinkedDraft,
  rebuiltRecord: sourceMemoUpdate
});
assert.equal(nonOverlapRebase.conflicts.length, 0);
assert.equal(nonOverlapRebase.draft.rows[0].quantity, 9, '원본과 겹치지 않는 미저장 연동 편집은 자동 재배치해야 한다.');
assert.equal(nonOverlapRebase.draft.rows[0].memo, '원본 메모 변경');
const sourceQuantityUpdate = structuredClone(sourceMemoUpdate);
sourceQuantityUpdate.draft.rows[0].quantity = 2;
assert.equal(rebaseLinkedEstimateWorkingDraft({
  baselineDraft: baselineLinkedDraft,
  workingDraft: workingLinkedDraft,
  rebuiltRecord: sourceQuantityUpdate
}).conflicts[0].code, 'LINKED_ESTIMATE_WORKING_REBASE_CONFLICT',
'원본과 미저장 작업본이 같은 필드를 다르게 바꾸면 해당 연결만 확인해야 한다.');

const rememberedPlanTarget = {
  estimateId: 'EST-REMEMBERED-PLAN', estimateKind: 'INDIVIDUAL', customerName: '현재 이름과 다름',
  catalogName: '수동 매칭했던 견적서', draft: { header: { customerName: '현재 이름과 다름' }, rows: [] }
};
const rememberedPlan = createEstimatePerCustomerPlan({
  classification: { groups: [firstGroup] },
  estimates: [rememberedPlanTarget],
  session,
  matchMappings: [{
    ...rememberedMapping,
    aliasMappingId: 'SIEMATCH-PLAN',
    matchKey: firstGroup.groupId,
    sourceCustomerName: firstGroup.customerName,
    normalizedName: firstGroup.normalizedCustomerName,
    targetEstimateId: rememberedPlanTarget.estimateId
  }],
  companyId: 'COMPANY'
});
assert.equal(rememberedPlan.entries[0].targetEstimateId, rememberedPlanTarget.estimateId);
assert.match(rememberedPlan.entries[0].matchMethod, /^MATCH_DICTIONARY_/);
assert.equal(rememberedPlan.entries[0].status, 'READY');

const target = {
  estimateId: 'TARGET-1',
  catalogName: '제목 보존',
  estimateKind: 'INDIVIDUAL',
  customerId: 'MASTER-CUSTOMER',
  customerCode: 'MASTER-CODE',
  customerName: '마스터 거래처',
  linkedExternalId: 'LINK-KEEP',
  sortOrder: 7,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  draft: {
    header: { customerId: 'MASTER-CUSTOMER', customerCode: 'MASTER-CODE', customerName: '마스터 거래처', customValues: { preserve: 'yes' } },
    rows: [{ rowId: 'OLD', itemCode: 'OLD', quantity: 1, unitPrice: 50 }]
  }
};
const replacement = createEstimateBulkReplacementRecord({
  target,
  replacementDraft: { header: { customerName: '업로드 거래처' }, rows: split.rows, inputMapping: split.session },
  previousPrices: { OLD: 50 },
  baselinePrices: { 'SHARED-CODE': 1000 },
  summary: { total: split.rows.length, amount: 72000 },
  timestamp: '2026-09-04T05:00:00.000Z'
});
assert.equal(replacement.estimateId, target.estimateId);
assert.equal(replacement.catalogName, target.catalogName);
assert.equal(replacement.createdAt, target.createdAt);
assert.equal(replacement.sortOrder, target.sortOrder);
assert.equal(replacement.linkedExternalId, 'LINK-KEEP');
assert.deepEqual(replacement.draft.header, target.draft.header, '대상 견적서의 거래처 master header는 보존해야 한다.');
assert.deepEqual(replacement.previousPrices, { OLD: 50 });
assert.deepEqual(replacement.draft.catalogBaselinePrices, { 'SHARED-CODE': 1000 });
assert.equal(target.draft.rows[0].itemCode, 'OLD', '순수 record 생성은 입력 target을 변경하면 안 된다.');

const dirtyTarget = structuredClone(target.draft);
dirtyTarget.rows[0].quantity = 99;
const linked = {
  estimateId: 'LINKED-1',
  catalogName: '연동 견적',
  estimateKind: 'LINKED_GROUP',
  linkedEstimateSources: [{ estimateId: 'TARGET-1' }],
  draft: { rows: [{ rowId: 'L1', memo: '' }] }
};
const dirtyLinked = structuredClone(linked.draft);
dirtyLinked.rows[0].memo = '저장하지 않은 연동 편집';
const conflicts = inspectEstimateBulkWorkingCopyConflicts({
  targetEstimateIds: ['TARGET-1'],
  estimates: [target, linked],
  workingCopies: [
    { estimateId: 'TARGET-1', draft: dirtyTarget },
    { estimateId: 'LINKED-1', draft: dirtyLinked }
  ]
});
assert.deepEqual(conflicts.map(conflict => conflict.code).sort(), [
  'ESTIMATE_BULK_LINKED_WORKING_COPY_CONFLICT',
  'ESTIMATE_BULK_TARGET_WORKING_COPY_CONFLICT'
]);

const activeLinkedPlan = createEstimatePerCustomerPlan({
  classification: { groups: [firstGroup] },
  estimates: [target, linked],
  selections: { [firstGroup.groupId]: { action: 'UPDATE', targetEstimateId: target.estimateId } },
  session,
  workingCopies: [{ estimateId: linked.estimateId, draft: dirtyLinked }],
  activeEstimateId: linked.estimateId
});
assert.equal(activeLinkedPlan.entries[0].status, 'READY',
  '현재 ERP 갱신 입력으로 사용 중인 연동견적서 작업본이 자기 원본 업데이트를 순환 차단하면 안 된다.');

const otherLinked = { ...linked, estimateId: 'LINKED-OTHER', catalogName: '다른 연동 견적' };
const otherDirtyLinked = structuredClone(otherLinked.draft);
otherDirtyLinked.rows[0].memo = '다른 연동견적서의 저장하지 않은 편집';
const protectedPlan = createEstimatePerCustomerPlan({
  classification: { groups: [firstGroup] },
  estimates: [target, linked, otherLinked],
  selections: { [firstGroup.groupId]: { action: 'UPDATE', targetEstimateId: target.estimateId } },
  session,
  workingCopies: [
    { estimateId: linked.estimateId, draft: dirtyLinked },
    { estimateId: otherLinked.estimateId, draft: otherDirtyLinked }
  ],
  activeEstimateId: linked.estimateId
});
assert.equal(protectedPlan.entries[0].status, 'PENDING',
  '현재 작업본이 아닌 다른 연동견적서의 미저장 편집은 계속 보호해야 한다.');
assert.equal(protectedPlan.entries[0].firstIssue.code, 'ESTIMATE_BULK_LINKED_WORKING_COPY_CONFLICT');

assert.equal(estimateIncomingFieldEnvelope({ purchasePriceB: '' }, 'purchasePriceB').kind, 'BLANK');
assert.equal(estimateIncomingFieldEnvelope({ purchasePriceB: '   ' }, 'purchasePriceB').kind, 'BLANK',
  '공백만 있는 문자열도 공란으로 보고 기존값을 덮어쓰면 안 된다.');
assert.equal(estimateIncomingFieldEnvelope({ purchasePriceB: 0 }, 'purchasePriceB').kind, 'VALUE');
assert.equal(estimateIncomingFieldEnvelope({ purchasePriceB: 0 }, 'purchasePriceB').parsedValue, 0);
assert.equal(estimateIncomingFieldEnvelope({ promoPrice: '26800' }, 'promoPrice').parsedValue, 26800);
assert.equal(estimateIncomingFieldEnvelope({}, 'purchasePriceB').kind, 'ABSENT');

const uniqueEnriched = enrichEstimateBulkCustomerIdentities(
  [{ groupId: 'NAME:농협', customerName: '농협', customerId: '', customerCode: '', identityKind: 'CUSTOMER_NAME', issues: [] }],
  [{ customerId: 'CUS-NH', customerCode: 'NH', customerName: '농협' }, { customerId: 'CUS-CC', customerCode: 'CC', customerName: '창창' }]
);
assert.equal(uniqueEnriched[0].customerId, 'CUS-NH');
assert.equal(uniqueEnriched[0].customerCode, 'NH');
const ambiguousEnriched = enrichEstimateBulkCustomerIdentities(
  [{ groupId: 'NAME:가락', customerName: '가락', customerId: '', customerCode: '', identityKind: 'CUSTOMER_NAME', issues: [] }],
  [{ customerId: 'CUS-1', customerCode: 'A', customerName: '가락' }, { customerId: 'CUS-2', customerCode: 'B', customerName: '가락' }]
);
assert.equal(ambiguousEnriched[0].customerId, '');
assert.equal(ambiguousEnriched[0].issues[0].code, 'ESTIMATE_BULK_CUSTOMER_NAME_AMBIGUOUS');

const patchSplit = splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 2) });
patchSplit.rows[0].purchasePriceB = '';
patchSplit.rows[0].wholesaleA = 0;
patchSplit.rows[0].promoPrice = '26800';
patchSplit.rows[1].purchasePriceB = 90;
const patched = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: patchSplit,
  targetRows: [
    { rowId: 'KEEP-SHARED', itemCode: 'SHARED-CODE', itemName: '이전 공유 품목', purchasePriceB: 500, wholesaleA: 12, promoPrice: 1 },
    { rowId: 'KEEP-CODE-2', itemCode: 'C1-2', itemName: '이전 이름', purchasePriceB: 80 },
    { rowId: 'KEEP-MANUAL', itemCode: 'MANUAL-KEEP', itemName: 'ERP에 없는 기존 품목', purchasePriceB: 77 }
  ]
});
assert.deepEqual(patched.removedRowIds, []);
assert.equal(patched.preservedRowCount, 1);
assert.equal(patched.split.rows.some(row => row.rowId === 'KEEP-MANUAL' && row.purchasePriceB === 77), true,
  'ERP에 없는 기존 품목은 삭제하지 않고 값을 유지해야 한다.');
const shared = patched.split.rows.find(row => row.rowId === 'KEEP-SHARED');
assert.equal(shared.purchasePriceB, 500, '공란 입고B는 기존값을 덮어쓰지 않아야 한다.');
assert.equal(shared.wholesaleA, 0, '숫자 0은 유효값으로 적용해야 한다.');
assert.equal(shared.promoPrice, 26800, '문자열 숫자는 숫자로 적용해야 한다.');
assert.equal(patched.split.rows.find(row => row.rowId === 'KEEP-CODE-2').purchasePriceB, 90);
assert.equal(shared.editedFields?.purchasePriceB, true, '공란 보존 입고B는 F8에서 mapping 원본보다 저장값을 써야 한다.');
assert.equal(shared.editedFields?.wholesaleA, true);
assert.equal(shared.editedFields?.promoPrice, true);
assert.equal(patched.split.rows.find(row => row.rowId === 'KEEP-MANUAL')?.editedFields?.purchasePriceB, true,
  'ERP에 없는 기존 품목도 F8에서 저장값을 유지해야 한다.');
const catalogLikeDraft = {
  header: {},
  rows: patched.split.rows.map(row => ({
    ...row,
    editedFields: row.editedFields && typeof row.editedFields === 'object' ? { ...row.editedFields } : {}
  })),
  inputMapping: patched.split.session
};
const patchedF8 = buildEstimateF8Data(buildEstimateF8RowsFromDraft(catalogLikeDraft));
const f8ByCode = Object.fromEntries(patchedF8.estimateUploadData.slice(1).map(row => [row[8], row]));
assert.equal(f8ByCode['SHARED-CODE']?.[13], 500, 'F8: ERP 공란 입고B는 기존 500을 유지해야 한다.');
assert.equal(f8ByCode['SHARED-CODE']?.[14], 0, 'F8: ERP VALUE 0은 그대로 출력해야 한다.');
assert.equal(f8ByCode['MANUAL-KEEP']?.[13], 77, 'F8: ERP에 없는 기존 품목의 입고B를 유지해야 한다.');
assert.equal(f8ByCode['C1-2']?.[13], 90, 'F8: ERP VALUE로 갱신된 입고B를 출력해야 한다.');
const shopByCode = Object.fromEntries(patchedF8.shopData.slice(1).map(row => [row[0], row]));
assert.equal(shopByCode['SHARED-CODE']?.[3], 26800, 'F8 쇼핑몰: ERP VALUE 행사가는 판매가로 출력해야 한다.');
const wipedF8 = buildEstimateF8Data(buildEstimateF8RowsFromDraft({
  ...catalogLikeDraft,
  rows: catalogLikeDraft.rows.map(row => ({ ...row, editedFields: {} }))
}));
assert.equal(wipedF8.estimateUploadData.slice(1).find(row => row[8] === 'SHARED-CODE')?.[13], '',
  'editedFields가 사라지면 mapping 원본 우선으로 공란이 다시 살아난다.');

const erpHeaders = [...ESTIMATE_REPORT_HEADERS];
const erpHeaderIndex = erpHeaders.indexOf('입고B');
const erpPromoIndex = erpHeaders.indexOf('행사가');
const erpCodeIndex = erpHeaders.indexOf('품목코드');
const erpNameIndex = erpHeaders.indexOf('품목명');
const erpCustomerIndex = erpHeaders.indexOf('거래처명');
const erpMatrix = [
  ['회사명 / 출력일시'],
  erpHeaders,
  erpHeaders.map((header, columnIndex) => {
    if (columnIndex === erpCustomerIndex) return '거래처 1';
    if (columnIndex === erpNameIndex) return '이전 공유 품목';
    if (columnIndex === erpCodeIndex) return 'SHARED-CODE';
    if (columnIndex === erpHeaderIndex) return '';
    if (columnIndex === erpPromoIndex) return '26800';
    return header === '일자' ? '2026/09/26' : '';
  }),
  erpHeaders.map((header, columnIndex) => {
    if (columnIndex === erpCustomerIndex) return '거래처 1';
    if (columnIndex === erpNameIndex) return '이전 이름';
    if (columnIndex === erpCodeIndex) return 'C1-2';
    if (columnIndex === erpHeaderIndex) return '90';
    return header === '일자' ? '2026/09/26' : '';
  })
];
const erpWorking = [
  { rowId: 'erp-blank', sourceRowIndex: 2, cells: [...erpMatrix[2]], manual: false },
  { rowId: 'erp-value', sourceRowIndex: 3, cells: [...erpMatrix[3]], manual: false }
];
const erpSession = {
  schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
  sessionId: 'ERP-F8-SESSION',
  companyId: 'COMPANY',
  voucherMode: 'estimate',
  fileName: '견적서현황.xlsx',
  sheetName: '견적서현황내역',
  headerRowIndex: 1,
  headers: erpHeaders,
  sourceMatrix: erpMatrix,
  sourceCellMatrix: erpMatrix.map(row => row.map(displayValue => ({ displayValue }))),
  mappings: erpHeaders.map((sourceHeader, columnIndex) => ({
    columnIndex, sourceHeader, state: 'MAPPED', targetFieldId: sourceHeader
  })),
  workingRows: erpWorking,
  manualRows: [],
  editJournal: {},
  estimateErpSummary: { recognized: true, preferred: true, sheetName: '견적서현황내역', itemCount: 2, customerCount: 1 }
};
const erpSplit = splitEstimateBulkInputMapping({
  session: erpSession,
  rows: [
    { rowId: 'erp-blank', itemCode: 'SHARED-CODE', itemName: '이전 공유 품목', purchasePriceB: '', promoPrice: '26800' },
    { rowId: 'erp-value', itemCode: 'C1-2', itemName: '이전 이름', purchasePriceB: '90' }
  ]
});
const erpPatched = reconcileEstimateBulkRows({
  groupId: 'NAME:거래처 1',
  split: erpSplit,
  targetRows: [
    { rowId: 'KEEP-SHARED', itemCode: 'SHARED-CODE', itemName: '이전 공유 품목', purchasePriceB: 500, promoPrice: 1 },
    { rowId: 'KEEP-CODE-2', itemCode: 'C1-2', itemName: '이전 이름', purchasePriceB: 80 },
    { rowId: 'KEEP-MANUAL', itemCode: 'MANUAL-KEEP', itemName: 'ERP에 없는 기존 품목', purchasePriceB: 77 }
  ]
});
const erpCatalogDraft = {
  header: {},
  rows: erpPatched.split.rows.map(row => ({
    ...row,
    editedFields: row.editedFields && typeof row.editedFields === 'object' ? { ...row.editedFields } : {}
  })),
  inputMapping: erpPatched.split.session
};
const erpF8 = buildEstimateF8Data(buildEstimateF8RowsFromDraft(erpCatalogDraft));
const erpUpload = Object.fromEntries(erpF8.estimateUploadData.slice(1).map(row => [row[8], row]));
assert.equal(erpUpload['SHARED-CODE']?.[13], 500, '새 ERP mapping의 공란 입고B는 기존 500을 F8에 유지해야 한다.');
assert.equal(erpUpload['C1-2']?.[13], 90, '새 ERP mapping의 VALUE 입고B는 F8에 90으로 나와야 한다.');
assert.equal(erpUpload['MANUAL-KEEP']?.[13], 77, 'ERP mapping에 없는 기존 품목도 F8 입고B를 유지해야 한다.');
const replay = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 3) }),
  targetRows: patched.split.rows
});
assert.equal(replay.addedRowCount, 1);
assert.equal(replay.split.rows.filter(row => row.rowId === replay.split.rows[2].rowId).length, 1);
const replayAgain = reconcileEstimateBulkRows({
  groupId: firstGroup.groupId,
  split: splitEstimateBulkInputMapping({ session, rows: firstGroup.rows.slice(0, 3) }),
  targetRows: replay.split.rows
});
assert.equal(replayAgain.addedRowCount, 0, '같은 ERP 품목을 다시 적용해도 신규 행이 중복되면 안 된다.');
assert.equal(replayAgain.split.rows.find(row => row.itemCode === 'C1-3').rowId, replay.split.rows.find(row => row.itemCode === 'C1-3').rowId);

const masterLinkedPlan = createEstimatePerCustomerPlan({
  classification: { groups: [{ ...firstGroup, customerId: '', customerCode: '', identityKind: 'CUSTOMER_NAME' }] },
  estimates: [{ estimateId: 'EST-NH', estimateKind: 'INDIVIDUAL', customerId: 'CUS-NH', customerName: '다른 표시명', catalogName: '농협 견적', draft: { header: {}, rows: [] } }],
  session,
  companyId: 'COMPANY',
  customers: [{ customerId: 'CUS-NH', customerCode: 'NH', customerName: firstGroup.customerName }]
});
assert.equal(masterLinkedPlan.entries[0].targetEstimateId, 'EST-NH');
assert.equal(masterLinkedPlan.entries[0].status, 'READY');

console.log('SmartInput estimate bulk grouping, exact target matching, evidence split, record replacement, and working-copy guards passed.');
