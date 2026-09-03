import assert from 'node:assert/strict';
import {
  applyLinkedEstimateSourceEditPlan,
  createLinkedEstimateSourceEditPlan,
  inspectLinkedEstimateSourceEdits,
  inspectLinkedEstimateSourceWorkingCopyConflicts,
  numericInputState,
  restoreLinkedEstimateWorkingRowEdits
} from '../smartinput/linked-estimate-source-edit.js';

const sourceRow = (rowId, quantity, unitPrice, overrides = {}) => ({
  rowId,
  productId: 'PRODUCT-0007',
  masterProductId: 'MASTER-0007',
  itemCode: '0007',
  itemName: '사과',
  specification: '10kg',
  quantity,
  rawQuantity: quantity,
  unit: 'BOX',
  unitPrice,
  sourceUnitPrice: String(unitPrice ?? ''),
  memo: '',
  matchStatus: 'MATCHED',
  reviewStatus: 'CONFIRMED',
  productIdentityStatus: 'MASTER_LINKED',
  matchSource: 'REFERENCE',
  referenceResolution: 'ACTIVE',
  editedFields: {},
  fieldValues: {
    'voucher.estimate.line.quantity': {
      fieldId: 'voucher.estimate.line.quantity',
      sourceDisplayValue: String(quantity ?? ''),
      currentDisplayValue: String(quantity ?? ''),
      parsedValue: quantity,
      edited: false,
      evidence: { sourceMatrixCell: `A:${rowId}`, signature: 'SIG-ORIGINAL' }
    }
  },
  ...overrides
});

const sourceRecord = (estimateId, name, rows, updatedAt = '2026-09-03T10:00:00.000+09:00') => ({
  estimateId,
  catalogName: name,
  estimateKind: 'INDIVIDUAL',
  rowCount: rows.length,
  amount: rows.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.unitPrice || 0), 0),
  createdAt: '2026-09-01T10:00:00.000+09:00',
  updatedAt,
  draft: { rows }
});

const left = sourceRecord('EST-A', '원본 A', [sourceRow('ROW-A', 1, 1000)]);
const right = sourceRecord('EST-B', '원본 B', [sourceRow('ROW-B', 3, 1200)]);
const linkedRow = sourceRow('LINKED-ROW', 9, 1500, {
  sourceUnitPrice: '1,500',
  editedFields: { quantity: true, unitPrice: true },
  linkedSourceEstimateId: 'EST-A',
  linkedSourceEstimateName: '2개 견적서',
  linkedSourceRowId: 'ROW-A',
  linkedSourceEstimateIds: ['EST-A', 'EST-B'],
  linkedSourceRefs: [
    { estimateId: 'EST-A', estimateName: '원본 A', rowId: 'ROW-A' },
    { estimateId: 'EST-B', estimateName: '원본 B', rowId: 'ROW-B' }
  ]
});
const linkedRecord = {
  estimateId: 'LINKED-1',
  catalogName: '연동 견적',
  estimateKind: 'LINKED_GROUP',
  linkedEstimateSources: [
    { estimateId: 'EST-A', catalogName: '원본 A' },
    { estimateId: 'EST-B', catalogName: '원본 B' }
  ],
  draft: { rows: [linkedRow] }
};

const evidence = inspectLinkedEstimateSourceEdits({
  linkedRecord,
  currentDraft: linkedRecord.draft,
  sourceRecords: [left, right]
});
assert.equal(evidence.issues.length, 0);
assert.equal(evidence.rows.length, 1);
assert.equal(evidence.rows[0].sources.length, 2);
assert.equal(evidence.rows[0].sources[0].before.quantity, 1);
assert.equal(evidence.rows[0].sources[1].before.amount, 3600);
assert.equal(evidence.rows[0].after.amount, 13500);

assert.throws(() => createLinkedEstimateSourceEditPlan({
  evidence,
  selections: {},
  actor: 'TESTER',
  occurredAt: '2026-09-03T20:00:00+09:00'
}), /LINKED_ESTIMATE_SOURCE_SELECTION_REQUIRED/, '다중 원본은 첫 원본을 임의 선택하지 않고 작업자 선택 없이 fail-closed해야 한다.');

const selectedRight = createLinkedEstimateSourceEditPlan({
  evidence,
  selections: { 'LINKED-ROW': 'EST-B:ROW-B' },
  actor: 'TESTER',
  occurredAt: '2026-09-03T20:00:00+09:00',
  planId: 'PLAN-MULTI'
});
const appliedRight = applyLinkedEstimateSourceEditPlan({
  plan: selectedRight,
  linkedRecord,
  sourceRecords: [left, right]
});
const updatedLeft = appliedRight.upserts.find(record => record.estimateId === 'EST-A');
const updatedRight = appliedRight.upserts.find(record => record.estimateId === 'EST-B');
assert.equal(updatedLeft, undefined, '선택하지 않은 원본은 upsert 대상이 아니어야 한다.');
assert.equal(updatedRight.draft.rows[0].quantity, 9);
assert.equal(updatedRight.draft.rows[0].unitPrice, 1500);
assert.equal(appliedRight.linkedRecord.draft.rows[0].quantity, 1, 'B만 바꾼 뒤 연동행 대표값은 첫 원본 A의 현재값으로 즉시 다시 물질화해야 한다.');
assert.ok(appliedRight.linkedRecord.draft.rows[0].linkedFieldConflicts.includes('quantity'), 'A=1/B=9 차이는 저장 직후에도 값 다름으로 표시해야 한다.');
assert.equal(appliedRight.linkedRecord.draft.rows[0].linkedPriceConflict, true, 'A/B 단가 차이도 저장 직후 다시 계산해야 한다.');
assert.equal(updatedRight.draft.rows[0].rawQuantity, 3, '원본 수량 evidence는 수정하지 않는다.');
assert.deepEqual(
  updatedRight.draft.rows[0].fieldValues['voucher.estimate.line.quantity'].evidence,
  right.draft.rows[0].fieldValues['voucher.estimate.line.quantity'].evidence,
  '원본 source evidence/signature는 보존해야 한다.'
);
assert.equal(right.draft.rows[0].quantity, 3, '순수 적용 함수는 입력 레코드를 변경하지 않아야 한다.');

const refreshedMaterializedRows = structuredClone(appliedRight.linkedRecord.draft.rows);
refreshedMaterializedRows[0].fieldValues['voucher.estimate.line.quantity'].evidence.signature = 'SIG-REFRESHED';
const restoredLinkedWorkingRows = restoreLinkedEstimateWorkingRowEdits({
  materializedRows: refreshedMaterializedRows,
  workingRows: [{ ...linkedRow, quantity: 9, editedFields: { quantity: true }, linkedSyncFields: ['quantity'] }]
});
assert.equal(restoredLinkedWorkingRows[0].quantity, 9, '차단 뒤 연동견적 재열기는 같은 linked refs의 sourced-row 편집값을 작업 화면에 복원해야 한다.');
assert.equal(restoredLinkedWorkingRows[0].editedFields.quantity, true);
assert.deepEqual(restoredLinkedWorkingRows[0].linkedSyncFields, ['quantity']);
assert.equal(restoredLinkedWorkingRows[0].fieldValues['voucher.estimate.line.quantity'].currentDisplayValue, '9');
assert.equal(restoredLinkedWorkingRows[0].fieldValues['voucher.estimate.line.quantity'].evidence.signature, 'SIG-REFRESHED', '작업값 복원은 새로 물질화한 원본 evidence/signature를 덮어쓰면 안 된다.');
assert.equal(appliedRight.linkedRecord.draft.rows[0].quantity, 1, 'working-row 복원은 저장된 연동 Snapshot을 변경하지 않아야 한다.');

const selectedWorkingCopy = structuredClone(right.draft);
selectedWorkingCopy.documentId = 'WORKING-DOCUMENT';
selectedWorkingCopy.updatedAt = '2026-09-03T20:00:10+09:00';
selectedWorkingCopy.rows[0].memo = '저장하지 않은 원본 B 메모';
selectedWorkingCopy.rows[0].editedFields = { memo: true };
const selectedWorkingCopyConflicts = inspectLinkedEstimateSourceWorkingCopyConflicts({
  plan: selectedRight,
  sourceRecords: [left, right],
  workingCopies: [{ estimateId: 'EST-B', draft: selectedWorkingCopy }]
});
assert.deepEqual(selectedWorkingCopyConflicts.map(conflict => conflict.estimateId), ['EST-B'], '선택 원본의 persisted draft와 다른 working copy는 저장 전에 차단해야 한다.');
assert.equal(right.draft.rows[0].memo, '', 'working-copy 검사는 persisted 원본을 변경하지 않아야 한다.');

const metadataSourceRecord = structuredClone(right);
metadataSourceRecord.draft.header = { deliveryPolicySnapshot: { validationCode: 'AVAILABLE', evaluatedAt: '2026-09-03T20:00:00+09:00' } };
const metadataOnlyWorkingCopy = structuredClone(metadataSourceRecord.draft);
metadataOnlyWorkingCopy.documentId = 'REOPENED-DOCUMENT';
metadataOnlyWorkingCopy.updatedAt = '2026-09-03T20:00:20+09:00';
metadataOnlyWorkingCopy.header = { deliveryPolicySnapshot: { validationCode: 'AVAILABLE', evaluatedAt: '2026-09-03T20:00:20+09:00' } };
metadataOnlyWorkingCopy.rows[0].editedFields = { memo: true };
assert.deepEqual(inspectLinkedEstimateSourceWorkingCopyConflicts({
  plan: selectedRight,
  sourceRecords: [left, metadataSourceRecord],
  workingCopies: [{ estimateId: 'EST-B', draft: metadataOnlyWorkingCopy }]
}), [], '다시 연 문서 ID·시각·편집표시만 다른 동일 작업본은 데이터 유실 위험으로 오인하면 안 된다.');

const unselectedWorkingCopy = structuredClone(left.draft);
unselectedWorkingCopy.rows[0].memo = '선택하지 않은 원본 A 작업본';
assert.deepEqual(inspectLinkedEstimateSourceWorkingCopyConflicts({
  plan: selectedRight,
  sourceRecords: [left, right],
  workingCopies: [{ estimateId: 'EST-A', draft: unselectedWorkingCopy }]
}), [], '미선택 원본의 working copy는 선택 원본 저장을 차단하거나 폐기하면 안 된다.');

const identityEdit = {
  ...linkedRecord,
  estimateId: 'LINKED-IDENTITY',
  draft: { rows: [{
    ...linkedRow,
    rowId: 'LINKED-IDENTITY-ROW',
    itemCode: 'NEW-CODE',
    productId: '',
    masterProductId: '',
    matchStatus: 'SIMILAR',
    reviewStatus: 'PENDING',
    productIdentityStatus: 'UNRESOLVED',
    editedFields: { itemCode: true }
  }] }
};
const identityEvidence = inspectLinkedEstimateSourceEdits({ linkedRecord: identityEdit, currentDraft: identityEdit.draft, sourceRecords: [left, right] });
assert.ok(identityEvidence.rows[0].changedFields.includes('productId'));
assert.ok(identityEvidence.rows[0].changedFields.includes('masterProductId'));
assert.ok(identityEvidence.rows[0].changedFields.includes('productIdentityStatus'));
const identityPlan = createLinkedEstimateSourceEditPlan({ evidence: identityEvidence, selections: { 'LINKED-IDENTITY-ROW': 'EST-A:ROW-A' }, actor: 'TESTER', occurredAt: '2026-09-03T20:00:30+09:00', planId: 'PLAN-IDENTITY' });
const identityApplied = applyLinkedEstimateSourceEditPlan({ plan: identityPlan, linkedRecord: identityEdit, sourceRecords: [left, right] });
const identitySourceRow = identityApplied.upserts.find(record => record.estimateId === 'EST-A').draft.rows[0];
assert.equal(identitySourceRow.itemCode, 'NEW-CODE');
assert.equal(identitySourceRow.productId, '', '수기 품목 식별값 변경은 선택 원본의 기존 productId를 남기지 않아야 한다.');
assert.equal(identitySourceRow.masterProductId, '');
assert.equal(identitySourceRow.productIdentityStatus, 'UNRESOLVED');

const singleLinked = {
  ...linkedRecord,
  estimateId: 'LINKED-SINGLE',
  linkedEstimateSources: [{ estimateId: 'EST-A', catalogName: '원본 A' }],
  draft: {
    rows: [{
      ...linkedRow,
      rowId: 'LINKED-SINGLE-ROW',
      quantity: 0,
      editedFields: { quantity: true },
      linkedSourceEstimateName: '원본 A',
      linkedSourceEstimateIds: ['EST-A'],
      linkedSourceRefs: [{ estimateId: 'EST-A', estimateName: '원본 A', rowId: 'ROW-A' }]
    }]
  }
};
const singleEvidence = inspectLinkedEstimateSourceEdits({ linkedRecord: singleLinked, currentDraft: singleLinked.draft, sourceRecords: [left] });
const singlePlan = createLinkedEstimateSourceEditPlan({
  evidence: singleEvidence,
  selections: {},
  actor: 'TESTER',
  occurredAt: '2026-09-03T20:01:00+09:00',
  planId: 'PLAN-SINGLE'
});
assert.equal(singlePlan.operations[0].target.estimateId, 'EST-A');
assert.equal(singlePlan.operations[0].after.quantityState, 'ZERO');

const newRow = sourceRow('NEW-LINKED-ROW', null, -500, {
  itemCode: '',
  itemName: '신규 품목',
  sourceUnitPrice: '-500',
  editedFields: { itemName: true, quantity: true, unitPrice: true },
  linkedSourceEstimateId: '',
  linkedSourceEstimateName: '',
  linkedSourceRowId: '',
  linkedSourceEstimateIds: [],
  linkedSourceRefs: []
});
const withNewRow = {
  ...linkedRecord,
  estimateId: 'LINKED-NEW',
  draft: { rows: [newRow] }
};
const newEvidence = inspectLinkedEstimateSourceEdits({ linkedRecord: withNewRow, currentDraft: withNewRow.draft, sourceRecords: [left, right] });
assert.equal(newEvidence.rows[0].operation, 'ADD');
assert.equal(newEvidence.rows[0].after.quantityState, 'BLANK');
assert.equal(newEvidence.rows[0].after.unitPriceState, 'NEGATIVE');
assert.throws(() => createLinkedEstimateSourceEditPlan({
  evidence: newEvidence,
  selections: {},
  actor: 'TESTER',
  occurredAt: '2026-09-03T20:02:00+09:00'
}), /LINKED_ESTIMATE_NEW_ROW_SOURCE_REQUIRED/);
const newPlan = createLinkedEstimateSourceEditPlan({
  evidence: newEvidence,
  selections: { 'NEW-LINKED-ROW': 'EST-A' },
  actor: 'TESTER',
  occurredAt: '2026-09-03T20:02:00+09:00',
  planId: 'PLAN-ADD'
});
const added = applyLinkedEstimateSourceEditPlan({ plan: newPlan, linkedRecord: withNewRow, sourceRecords: [left, right] });
assert.equal(added.upserts.find(record => record.estimateId === 'EST-A').draft.rows.length, 2);
assert.equal(added.upserts.find(record => record.estimateId === 'EST-B'), undefined);
assert.equal(added.linkedRecord.draft.rows[0].linkedSourceRefs[0].estimateId, 'EST-A');

assert.equal(numericInputState(''), 'BLANK');
assert.equal(numericInputState(null), 'BLANK');
assert.equal(numericInputState(0), 'ZERO');
assert.equal(numericInputState('0'), 'ZERO');
assert.equal(numericInputState(-1), 'NEGATIVE');
assert.equal(numericInputState(1), 'POSITIVE');
assert.equal(numericInputState('not-a-number'), 'INVALID');

const invalidNew = {
  ...withNewRow,
  draft: { rows: [{ ...newRow, itemCode: '', itemName: '' }] }
};
const invalidEvidence = inspectLinkedEstimateSourceEdits({ linkedRecord: invalidNew, currentDraft: invalidNew.draft, sourceRecords: [left, right] });
assert.ok(invalidEvidence.issues.some(issue => issue.code === 'LINKED_ESTIMATE_ITEM_IDENTITY_REQUIRED'));

const staleRight = structuredClone(right);
staleRight.draft.rows[0].quantity = 99;
assert.throws(() => applyLinkedEstimateSourceEditPlan({
  plan: selectedRight,
  linkedRecord,
  sourceRecords: [left, staleRight]
}), /LINKED_ESTIMATE_SOURCE_STALE/, '선택 후 원본이 달라지면 전체 적용 전 fail-closed해야 한다.');

const bulkLeft = sourceRecord('EST-BULK-A', '일괄 원본 A', [sourceRow('ROW-BULK-A1', 1, 1000), sourceRow('ROW-BULK-A2', 2, 2000)]);
const bulkRight = sourceRecord('EST-BULK-B', '일괄 원본 B', [sourceRow('ROW-BULK-B1', 3, 1100), sourceRow('ROW-BULK-B2', 4, 2200)]);
const bulkRows = [
  { ...sourceRow('LINKED-BULK-1', 10, 1500), editedFields: { quantity: true, unitPrice: true }, linkedSourceRefs: [{ estimateId: 'EST-BULK-A', estimateName: '일괄 원본 A', rowId: 'ROW-BULK-A1' }, { estimateId: 'EST-BULK-B', estimateName: '일괄 원본 B', rowId: 'ROW-BULK-B1' }] },
  { ...sourceRow('LINKED-BULK-2', 20, 2500), editedFields: { quantity: true, unitPrice: true }, linkedSourceRefs: [{ estimateId: 'EST-BULK-A', estimateName: '일괄 원본 A', rowId: 'ROW-BULK-A2' }, { estimateId: 'EST-BULK-B', estimateName: '일괄 원본 B', rowId: 'ROW-BULK-B2' }] }
];
const bulkLinked = {
  ...linkedRecord,
  estimateId: 'LINKED-BULK',
  linkedEstimateSources: [{ estimateId: 'EST-BULK-A', catalogName: '일괄 원본 A' }, { estimateId: 'EST-BULK-B', catalogName: '일괄 원본 B' }],
  draft: { rows: bulkRows }
};
const bulkEvidence = inspectLinkedEstimateSourceEdits({ linkedRecord: bulkLinked, currentDraft: bulkLinked.draft, sourceRecords: [bulkLeft, bulkRight] });
const bulkPlan = createLinkedEstimateSourceEditPlan({ evidence: bulkEvidence, selections: { 'LINKED-BULK-1': 'EST-BULK-A:ROW-BULK-A1', 'LINKED-BULK-2': 'EST-BULK-B:ROW-BULK-B2' }, actor: 'TESTER', occurredAt: '2026-09-03T20:03:00+09:00', planId: 'PLAN-BULK' });
const bulkApplied = applyLinkedEstimateSourceEditPlan({ plan: bulkPlan, linkedRecord: bulkLinked, sourceRecords: [bulkLeft, bulkRight] });
assert.deepEqual(new Set(bulkApplied.changedSourceIds), new Set(['EST-BULK-A', 'EST-BULK-B']));
assert.equal(bulkApplied.upserts.length, 3, '일괄 수정은 연동견적과 선택한 두 원본을 하나의 저장 묶음으로 만든다.');
assert.equal(bulkApplied.upserts.find(record => record.estimateId === 'EST-BULK-A').draft.rows[0].quantity, 10);
assert.equal(bulkApplied.upserts.find(record => record.estimateId === 'EST-BULK-A').draft.rows[1].quantity, 2, '선택하지 않은 A의 다른 행은 불변이어야 한다.');
assert.equal(bulkApplied.upserts.find(record => record.estimateId === 'EST-BULK-B').draft.rows[0].quantity, 3, '선택하지 않은 B의 다른 행은 불변이어야 한다.');
assert.equal(bulkApplied.upserts.find(record => record.estimateId === 'EST-BULK-B').draft.rows[1].quantity, 20);

console.log('SmartInput linked-estimate source evidence, explicit selection, diff, validation, and immutable planning passed.');
