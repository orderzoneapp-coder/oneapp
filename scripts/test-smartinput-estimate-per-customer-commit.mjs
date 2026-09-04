import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createEstimateBulkNewRecord,
  classifyEstimateBulkRows,
  createEstimateBulkProgress,
  createEstimatePerCustomerPlan,
  splitEstimateBulkInputMapping
} from '../smartinput/estimate-bulk-update.js';

const distribution = [72, 51, 32, 25, 22, 20, 18, 18, 12, 7];
const headers = ['거래처명', '품목코드', '품목명', '수량', '출고가', '적요'];
const sourceMatrix = [headers];
const sourceCellMatrix = [headers.map((displayValue, columnIndex) => ({
  address: `${String.fromCharCode(65 + columnIndex)}1`, rowIndex: 0, columnIndex, displayValue
}))];
const workingRows = [];
const rows = [];
let sourceIndex = 1;

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
    const rowId = `source-${sourceIndex}`;
    sourceMatrix.push(values);
    sourceCellMatrix.push(cells);
    workingRows.push({ rowId, sourceRowIndex: sourceIndex, cells: [...values], sourceCells: cells, manual: false });
    rows.push({
      rowId,
      sourceRowNo: sourceIndex + 1,
      rowCustomerName: customerName,
      masterProductId: `PRODUCT-${customerIndex + 1}-${itemIndex + 1}`,
      itemCode,
      itemName: `품목 ${customerIndex + 1}-${itemIndex + 1}`,
      quantity,
      unitPrice,
      memo: values[5],
      matchStatus: 'MATCHED',
      reviewStatus: 'CONFIRMED',
      productIdentityStatus: 'MASTER_LINKED'
    });
    sourceIndex += 1;
  }
});

const footer = { rowId: `source-${sourceIndex}`, sourceRowNo: sourceIndex + 1, rowVoucherDate: '2026-09-04 14:30:00' };
rows.push(footer);
sourceMatrix.push(['2026-09-04 14:30:00']);
sourceCellMatrix.push([{ address: `A${sourceIndex + 1}`, rowIndex: sourceIndex, columnIndex: 0, displayValue: footer.rowVoucherDate }]);
workingRows.push({ rowId: footer.rowId, sourceRowIndex: sourceIndex, cells: [footer.rowVoucherDate], sourceCells: sourceCellMatrix[sourceIndex], manual: false });

const session = {
  schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
  sessionId: 'SESSION-PER-CUSTOMER',
  fileFingerprint: 'FILE-277',
  voucherMode: 'estimate',
  sourceMatrix,
  sourceCellMatrix,
  headerRowIndex: 0,
  headers,
  headerSignature: 'HEADER-SIGNATURE',
  signature: 'TEMPLATE-SIGNATURE',
  status: 'TEMPLATE_APPLIED',
  mappings: headers.map((sourceHeader, columnIndex) => ({ columnIndex, sourceHeader, state: 'MAPPED', targetFieldId: `FIELD-${columnIndex}`, reviewed: true })),
  editJournal: {},
  manualRows: [],
  deletedSourceRows: [],
  workingRows
};

const troubledRows = structuredClone(rows);
troubledRows.find(row => row.rowCustomerName === '거래처 2').matchStatus = 'SIMILAR';
troubledRows.find(row => row.rowCustomerName === '거래처 3').reviewStatus = 'PENDING';
troubledRows.push({ rowId: 'customer-only-4', sourceRowNo: 999, rowCustomerName: '거래처 4' });
troubledRows.push({ rowId: 'item-only', sourceRowNo: 1000, masterProductId: 'ORPHAN-PRODUCT', itemCode: 'ORPHAN', itemName: '거래처 없는 품목', matchStatus: 'MATCHED', reviewStatus: 'CONFIRMED', productIdentityStatus: 'MASTER_LINKED' });

const classified = classifyEstimateBulkRows(troubledRows);
assert.equal(classified.groups.length, 11, 'item-only 행은 정상 그룹을 막지 않는 거래처 미확인 보류 그룹이어야 한다.');
assert.equal(classified.totalItemRows, 278);
assert.equal(classified.ignoredRows.length, 1, '거래처·품목이 모두 없는 푸터는 무시해야 한다.');
assert.equal(classified.groups.filter(group => group.rows.some(row => row.itemCode === 'SHARED-CODE')).length, 10);
assert.equal(classified.groups.find(group => group.customerName === '거래처 1').rows[0].quantity, 0);
assert.equal(classified.groups.find(group => group.customerName === '거래처 2').rows[0].quantity, -2);
assert.equal(classified.groups.find(group => group.customerName === '거래처 1').rows[1].memo, '');
assert.ok(classified.groups.find(group => group.customerName === '거래처 4').issues.some(issue => issue.code === 'ESTIMATE_BULK_CUSTOMER_ONLY_ROW'));
assert.ok(classified.groups.find(group => group.groupType === 'UNASSIGNED').issues.some(issue => issue.code === 'ESTIMATE_BULK_ITEM_ONLY_ROW'));

const estimates = distribution.map((unused, index) => ({
  estimateId: `EST-${index + 1}`,
  estimateKind: 'INDIVIDUAL',
  customerName: `거래처 ${index + 1}`,
  catalogName: `기존 견적 ${index + 1}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  draft: { header: { customerName: `거래처 ${index + 1}` }, rows: [{ rowId: 'OLD', itemCode: 'OLD' }] }
}));
estimates.push({ ...structuredClone(estimates[4]), estimateId: 'EST-5-DUP', catalogName: '중복 정확 일치' });

const group8 = classified.groups.find(group => group.customerName === '거래처 8');
const group8Split = splitEstimateBulkInputMapping({ session, rows: group8.itemRows });
estimates[7].draft = { ...estimates[7].draft, rows: group8Split.rows, inputMapping: group8Split.session };

const dirtyGroup6 = structuredClone(estimates[5].draft);
dirtyGroup6.rows[0].memo = '미저장 편집';
const missingEvidenceSession = structuredClone(session);
const group7RowId = classified.groups.find(group => group.customerName === '거래처 7').itemRows[0].rowId;
missingEvidenceSession.workingRows = missingEvidenceSession.workingRows.filter(row => row.rowId !== group7RowId);

const selections = {
  [classified.groups.find(group => group.customerName === '거래처 9').groupId]: { action: 'EXCLUDE' },
  [classified.groups.find(group => group.customerName === '거래처 10').groupId]: { action: 'CREATE', catalogName: '신규 견적 10' }
};
const plan = createEstimatePerCustomerPlan({
  classification: classified,
  estimates,
  selections,
  session: missingEvidenceSession,
  workingCopies: [{ estimateId: 'EST-6', draft: dirtyGroup6 }]
});

const entry = customerName => plan.entries.find(candidate => candidate.group.customerName === customerName);
assert.equal(entry('거래처 1').status, 'READY');
assert.equal(entry('거래처 2').status, 'PENDING');
assert.equal(entry('거래처 3').status, 'PENDING');
assert.equal(entry('거래처 4').status, 'PENDING', '거래처-only 한 행은 그 거래처의 모든 품목 저장을 보류해야 한다.');
assert.equal(entry('거래처 5').status, 'PENDING', 'exact 대상 ambiguity는 해당 거래처만 보류해야 한다.');
assert.equal(entry('거래처 6').status, 'PENDING', '미저장 working copy는 해당 거래처만 보류해야 한다.');
assert.equal(entry('거래처 7').status, 'PENDING', 'source evidence 누락은 해당 거래처만 보류해야 한다.');
assert.equal(entry('거래처 8').status, 'UNCHANGED', '동일 내용은 updatedAt write 없이 변경 없음이어야 한다.');
assert.equal(entry('거래처 9').status, 'EXCLUDED');
assert.equal(entry('거래처 10').status, 'READY', '명시적 이름이 있는 신규 견적은 저장 가능해야 한다.');
assert.equal(plan.entries.find(candidate => candidate.group.groupType === 'UNASSIGNED').status, 'PENDING');
assert.equal(plan.summary.ready, 2);
assert.equal(plan.summary.unchanged, 1);
assert.equal(plan.summary.excluded, 1);
assert.equal(entry('거래처 2').candidate, null, '한 문제행이 있는 그룹은 그 그룹 품목 일부도 저장 후보가 되면 안 된다.');

const completedProgress = createEstimateBulkProgress({
  plan,
  statusOverrides: { [entry('거래처 1').groupId]: { status: 'COMPLETED', targetEstimateId: 'EST-1' } }
});
const resumed = createEstimatePerCustomerPlan({
  classification: classified,
  estimates,
  selections,
  session: missingEvidenceSession,
  workingCopies: [{ estimateId: 'EST-6', draft: dirtyGroup6 }],
  progress: completedProgress
});
assert.equal(resumed.entries.find(candidate => candidate.group.customerName === '거래처 1').status, 'COMPLETED', '새로고침 후 완료 전표를 재저장하면 안 된다.');

const changedRows = structuredClone(troubledRows);
changedRows.find(row => row.rowCustomerName === '거래처 1').quantity = 12;
const changedPlan = createEstimatePerCustomerPlan({
  classification: classifyEstimateBulkRows(changedRows),
  estimates,
  selections,
  session: missingEvidenceSession,
  workingCopies: [{ estimateId: 'EST-6', draft: dirtyGroup6 }],
  progress: completedProgress
});
assert.equal(changedPlan.entries.find(candidate => candidate.group.customerName === '거래처 1').status, 'READY', '행 내용 변경은 그 그룹 완료 상태만 무효화해야 한다.');
assert.equal(changedPlan.entries.find(candidate => candidate.group.customerName === '거래처 8').status, 'UNCHANGED');

const createEntry = entry('거래처 10');
const created = createEstimateBulkNewRecord({
  estimateId: 'EST-NEW-10',
  catalogName: '신규 견적 10',
  group: createEntry.group,
  replacementDraft: { header: { customerName: '거래처 10' }, rows: createEntry.candidate.split.rows, inputMapping: createEntry.candidate.split.session },
  summary: { total: createEntry.group.itemCount, amount: 7000 },
  timestamp: '2026-09-04T06:00:00.000Z',
  sortOrder: 11
});
assert.equal(created.estimateId, 'EST-NEW-10');
assert.equal(created.catalogName, '신규 견적 10');
assert.equal(created.customerName, '거래처 10');
assert.equal(created.rowCount, 7);
assert.equal(created.sortOrder, 11);
assert.equal(created.draft.inputMapping.sourceMatrix.length, 8);
assert.equal(JSON.stringify(created.draft.inputMapping.sourceMatrix).includes('거래처 9'), false);
assert.equal(created.draft.delivery.status, 'SAVED');

const appSource = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const sequentialBoundary = appSource.slice(appSource.indexOf('async function applyEstimatePerCustomerUpdates'), appSource.indexOf('function showEstimateBulkUpdateDialog'));
assert.match(sequentialBoundary, /for \(const entry of plan\.entries\)/, '정상 전표는 거래처별로 순차 처리해야 한다.');
assert.match(sequentialBoundary, /commitEstimateBundle\(\{ upserts: \[record\], expectedPreimages \}\)/, '한 commit에는 한 거래처 record와 그 preimage만 들어가야 한다.');
assert.match(sequentialBoundary, /catch \(error\)[\s\S]*results\.push\(\{ groupId: entry\.groupId, status: 'FAILED'/, '한 거래처 실패를 기록하고 다음 거래처 처리를 계속해야 한다.');
assert.doesNotMatch(sequentialBoundary, /모든 대상 견적서|하나의 트랜잭션/, '폐기된 전체 묶음 성공·실패 표현이 남으면 안 된다.');

console.log('SmartInput per-customer estimate planning, hold, unchanged, and resumable progress contracts passed.');
