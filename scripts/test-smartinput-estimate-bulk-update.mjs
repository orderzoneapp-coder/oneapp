import assert from 'node:assert/strict';
import {
  classifyEstimateBulkRows,
  createEstimateBulkReplacementRecord,
  inspectEstimateBulkWorkingCopyConflicts,
  resolveEstimateBulkTargets,
  splitEstimateBulkInputMapping
} from '../smartinput/estimate-bulk-update.js';

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
assert.equal(autoResolved.assignments[2].targetEstimateId, 'EST-NAME');
assert.equal(autoResolved.assignments[2].matchMethod, 'CUSTOMER_NAME');
assert.equal(autoResolved.assignments[3].targetEstimateId, '', 'fuzzy 이름과 연동그룹은 자동 대상이 되면 안 된다.');
assert.ok(autoResolved.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_UNRESOLVED'));
const ambiguous = resolveEstimateBulkTargets({
  groups: [identityGroups[2]],
  estimates: [...estimates, { ...estimates[2], estimateId: 'EST-NAME-2', catalogName: '같은 이름의 두 번째 대상' }]
});
assert.equal(ambiguous.assignments[0].targetEstimateId, '', '정확한 이름이 복수여도 첫 후보를 자동선택하면 안 된다.');
assert.ok(ambiguous.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_AMBIGUOUS'));
const explicitlyCleared = resolveEstimateBulkTargets({
  groups: [identityGroups[0]], estimates, selections: { [identityGroups[0].groupId]: '' }
});
assert.equal(explicitlyCleared.assignments[0].targetEstimateId, '', '작업자가 자동 연결을 지우면 다시 숨은 자동선택을 하면 안 된다.');
assert.ok(explicitlyCleared.issues.some(issue => issue.code === 'ESTIMATE_BULK_TARGET_UNRESOLVED'));

const manualResolved = resolveEstimateBulkTargets({
  groups: identityGroups,
  estimates,
  selections: { [identityGroups[3].groupId]: 'EST-NAME' }
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

console.log('SmartInput estimate bulk grouping, exact target matching, evidence split, record replacement, and working-copy guards passed.');
