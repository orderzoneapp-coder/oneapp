#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStructuredSheet } from '../smartinput/structured-sheet-parser.js';
import {
  buildMinimumUploadMatrix,
  buildOrderGroupPayload,
  captureOrderHeaderSubmission,
  captureOrderRowSubmission,
  decorateStructuredRows,
  executeOrderGroupSavePlan,
  filterVoucherRows,
  groupVoucherRows,
  normalizeStage1Row,
  orderHeaderChangedSinceSubmission,
  partitionOrderGroups,
  requiresOrderGroupSavePath,
  retainUnsavedOrderRows,
  structuredFieldsForMode,
  summarizeVoucherGroups
} from '../smartinput/multivoucher-stage1.js';

const contractSource = fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

const matrix = [
  ['구매처명', '구매일자', '입고창고코드', '구매전표번호', '품목코드', '품목명', '수량', '단위', '입고가', '메모'],
  ['남경', '2026-08-24', '01', 'P-1', '105032110', '취나물', '0', 'BOX', '15000', '영수증'],
  ['남경', '2026-08-24', '01', 'P-1', '105038110', '비름', '-2', 'BOX', '27000', ''],
  [],
  ['남경', '2026-08-24', '01', 'P-2', '105040110', '방풍', '3', 'EA', '1000', '']
];

const parsed = parseStructuredSheet(matrix, {
  fieldDefinitions: structuredFieldsForMode('purchase', contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.equal(parsed.structured, true);
assert.equal(parsed.rows.length, 3);
assert.equal(parsed.rows[0].rowCustomerName, '남경');
assert.equal(parsed.rows[0].rowVoucherDate, '2026-08-24');
assert.equal(parsed.rows[0].rowWarehouseCode, '01');
assert.equal(parsed.rows[0].rowVoucherNo, 'P-1');
assert.equal(parsed.rows[0].unitPrice, 15000);
assert.equal(parsed.rows[0].quantity, 0, '숫자 0은 공란과 구분해야 한다.');
assert.equal(parsed.rows[1].quantity, -2, '음수 수량의 부호를 보존해야 한다.');
assert.equal(parsed.rows[2].sourceVoucherIndex, 2, '빈 행 경계 후의 전표는 별도 순번을 가져야 한다.');

const subtotalParsed = parseStructuredSheet([
  ['품목코드', '품목명', '수량'],
  ['A', '상품A', '1'],
  ['', '합계', '1'],
  ['B', '상품B', '2'],
  ['C', '합계상품', '3']
], {
  fieldDefinitions: structuredFieldsForMode('order', contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.deepEqual(subtotalParsed.rows.map(row => row.itemCode), ['A', 'B', 'C']);
assert.deepEqual(subtotalParsed.rows.map(row => row.sourceVoucherIndex), [1, 2, 2]);

const roleParsed = parseStructuredSheet([
  ['배송처ID', '배송처코드', '배송처명', '세무거래처ID', '세무거래처코드', '세무거래처명', '품목코드', '품목명', '수량'],
  ['D1', 'D-01', '배송사', 'B1', 'B-01', '세무사', 'A', '상품A', '1']
], {
  fieldDefinitions: structuredFieldsForMode('order', contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.equal(roleParsed.rows[0].deliveryCustomerId, 'D1');
assert.equal(roleParsed.rows[0].deliveryCustomerCode, 'D-01');
assert.equal(roleParsed.rows[0].deliveryCustomerName, '배송사');
assert.equal(roleParsed.rows[0].billingCustomerId, 'B1');
assert.equal(roleParsed.rows[0].billingCustomerCode, 'B-01');
assert.equal(roleParsed.rows[0].billingCustomerName, '세무사');

const orderBusinessFields = structuredFieldsForMode('order', contract.PRODUCT_FIELD_DEFINITIONS);
assert.equal(orderBusinessFields.some(field => field.id === 'rowTransactionType'), true,
  '주문 거래유형은 상단 업무키로 매핑할 수 있어야 한다.');
assert.equal(orderBusinessFields.some(field => field.id === 'sourceVoucherIndex'), false,
  '주문 입력 양식에 내부 원본 순번을 선택 대상으로 노출하지 않아야 한다.');
assert.equal(orderBusinessFields.some(field => field.id === 'manualSplitKey'), false,
  '주문 전표는 수동 순번·분리키가 아니라 ERP 업무키로만 구분해야 한다.');
for (const mode of ['purchase', 'sale', 'estimate']) {
  const nonOrderFields = structuredFieldsForMode(mode, contract.PRODUCT_FIELD_DEFINITIONS);
  for (const fieldId of ['sourceDocumentKey', 'sourceVoucherIndex', 'manualSplitKey']) {
    assert.equal(nonOrderFields.some(field => field.id === fieldId), true,
      `${mode} 매핑은 기존 원본문서 분리 필드 ${fieldId}를 계속 제공해야 한다.`);
  }
  const nonOrderGroups = groupVoucherRows(mode, ['DOC-A', 'DOC-B'].map((sourceDocumentKey, index) => ({
    rowId: `${mode}-${index + 1}`,
    sourceBatchId: `NON-ORDER-${mode}`,
    sourceDocumentKey,
    rowCustomerCode: 'C-01',
    rowCustomerName: '거래처A',
    rowVoucherDate: '2026-09-05',
    rowDeliveryDate: '2026-09-06',
    rowWarehouseCode: '88',
    rowVoucherNo: `${mode.toUpperCase()}-1`,
    itemCode: `ITEM-${index + 1}`,
    itemName: `상품${index + 1}`,
    quantity: 1,
    unit: 'EA'
  })));
  assert.equal(nonOrderGroups.length, 2,
    `${mode} 전표는 같은 업무값이어도 서로 다른 원본문서키를 계속 별도 전표로 유지해야 한다.`);
  assert.deepEqual(
    nonOrderGroups.map(group => decodeURIComponent(group.voucherGroupKey.split('|')[2])),
    ['DOCUMENT:DOC-A', 'DOCUMENT:DOC-B']
  );
}
const orderBusinessParsed = parseStructuredSheet([
  ['거래처코드', '일자-No.', '거래유형', '창고코드', '품목코드', '품목명', '수량'],
  ['C-01', '2026/09/05-7', '기타', '88', 'A', '상품A', '1']
], {
  fieldDefinitions: orderBusinessFields,
  numberParser: contract.numberOrNull
});
assert.equal(orderBusinessParsed.rows[0].rowTransactionType, '기타');

const purchaseRoleParsed = parseStructuredSheet([
  ['공급처ID', '공급처코드', '공급처명', '품목코드', '품목명', '수량'],
  ['P1', 'P-01', '공급사', 'A', '상품A', '1']
], {
  fieldDefinitions: structuredFieldsForMode('purchase', contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.deepEqual(
  [purchaseRoleParsed.rows[0].supplierCustomerId, purchaseRoleParsed.rows[0].supplierCustomerCode, purchaseRoleParsed.rows[0].supplierCustomerName],
  ['P1', 'P-01', '공급사']
);

const saleRoleParsed = parseStructuredSheet([
  ['판매업무처ID', '판매업무처코드', '판매업무처명', '배송처ID', '배송처코드', '배송처명', '세무거래처ID', '세무거래처코드', '세무거래처명', '품목코드', '품목명', '수량'],
  ['S1', 'S-01', '판매사', 'D1', 'D-01', '배송사', 'B1', 'B-01', '세무사', 'A', '상품A', '1']
], {
  fieldDefinitions: structuredFieldsForMode('sale', contract.PRODUCT_FIELD_DEFINITIONS),
  numberParser: contract.numberOrNull
});
assert.deepEqual(
  [saleRoleParsed.rows[0].salesCustomerId, saleRoleParsed.rows[0].deliveryCustomerId, saleRoleParsed.rows[0].billingCustomerId],
  ['S1', 'D1', 'B1']
);

const rows = decorateStructuredRows(parsed.rows, {
  sourceBatchId: 'BATCH-1',
  sourceSheetName: '구매',
  sourceFingerprint: 'HASH-1'
});
assert.equal(rows[0].rawQuantity, 0);
assert.equal(rows[0].baseQuantity, 0);
assert.equal(rows[1].rawQuantity, -2);
assert.equal(rows[1].baseQuantity, -2);
assert.equal(rows[1].unitConversionSource, 'SAME_UNIT');
assert.equal(rows[2].sourceDocumentKey, '구매:2');

const groups = groupVoucherRows('purchase', rows, {});
assert.equal(groups.length, 2, '원본 전표 순번과 외부전표번호가 다르면 분리해야 한다.');
assert.equal(groups[0].supplierCustomerName, '남경');
assert.equal(groups[0].rows.length, 2);
assert.equal(groups[0].validationStatus, 'READY');
assert.match(groups[0].idempotencyKey, /HASH-1/);
assert.match(groups[0].idempotencyKey, /BATCH-1/);
assert.match(groups[0].idempotencyKey, /PURCHASE/);

const sameOrderRole = groupVoucherRows('order', [{
  sourceBatchId: 'ROLE-ORDER-SAME', sourceDocumentKey: 'DOC', rowCustomerId: 'C1', rowCustomerCode: 'C-1', rowCustomerName: '공통사',
  itemCode: 'A', itemName: '상품A', quantity: 1, unit: 'EA'
}])[0];
assert.equal(sameOrderRole.deliveryCustomerId, 'C1');
assert.equal(sameOrderRole.billingCustomerId, 'C1');
const distinctOrderRole = groupVoucherRows('order', [{
  sourceBatchId: 'ROLE-ORDER-DIFF', sourceDocumentKey: 'DOC',
  deliveryCustomerId: 'D1', deliveryCustomerCode: 'D-1', deliveryCustomerName: '배송사',
  billingCustomerId: 'B1', billingCustomerCode: 'B-1', billingCustomerName: '세무사',
  itemCode: 'A', itemName: '상품A', quantity: 1, unit: 'EA'
}])[0];
assert.equal(distinctOrderRole.deliveryCustomerId, 'D1');
assert.equal(distinctOrderRole.billingCustomerId, 'B1');

const erpOrderRows = [
  {
    rowId: 'ERP-1', sourceBatchId: 'BATCH-UPLOAD', sourceDocumentKey: 'DOC-A', sourceVoucherIndex: 1, manualSplitKey: 'A',
    rowCustomerId: 'CUSTOMER-A', rowCustomerCode: 'C-01', rowCustomerName: '거래처A',
    rowVoucherNo: '2026/09/05-7', rowTransactionType: '기타', rowWarehouseCode: '88',
    rowVoucherDate: '2026-09-05', rowDeliveryDate: '2026-09-05', itemCode: 'A', itemName: '상품A', quantity: 1, unit: 'EA'
  },
  {
    rowId: 'ERP-OTHER', sourceBatchId: 'BATCH-UPLOAD', sourceDocumentKey: 'DOC-X', sourceVoucherIndex: 99, manualSplitKey: 'X',
    rowCustomerCode: 'C-02', rowCustomerName: '거래처B', rowVoucherNo: '2026/09/05-8', rowTransactionType: '기타', rowWarehouseCode: '88',
    rowVoucherDate: '2026-09-05', rowDeliveryDate: '2026-09-05', itemCode: 'B', itemName: '상품B', quantity: 1, unit: 'EA'
  },
  {
    rowId: 'ERP-2', sourceBatchId: 'BATCH-UPLOAD', sourceDocumentKey: 'DOC-B', sourceVoucherIndex: 2, manualSplitKey: 'B',
    rowCustomerId: 'CUSTOMER-A', rowCustomerCode: 'C-01', rowCustomerName: '거래처A',
    rowVoucherNo: '2026/09/05-7', rowTransactionType: '기타', rowWarehouseCode: '88',
    rowVoucherDate: '2026-09-05', rowDeliveryDate: '2026-09-05', itemCode: 'C', itemName: '상품C', quantity: 2, unit: 'EA'
  }
];
const erpOrderGroups = groupVoucherRows('order', erpOrderRows);
assert.equal(erpOrderGroups.length, 2, '한 업로드의 주문은 원본 순번·연속 배치가 달라도 같은 네 업무키를 한 전표로 묶어야 한다.');
assert.deepEqual(erpOrderGroups[0].rows.map(row => row.rowId), ['ERP-1', 'ERP-2'],
  '비연속 주문행도 거래처코드·주문참조번호·거래유형·창고코드가 같으면 원본 순서대로 합쳐야 한다.');
assert.doesNotMatch(erpOrderGroups[0].voucherGroupKey, /DOC|INDEX|MANUAL/,
  '주문 그룹키에 문서키·순번·수동분리키를 포함하지 않아야 한다.');
assert.deepEqual(erpOrderGroups[0].voucherGroupKey.split('|').slice(2).map(decodeURIComponent), [
  '2026/09/05-7', '88', 'C-01', '기타'
], '주문 업무키는 주문번호 → 창고 → 거래처 → 거래유형 우선순위를 명시적으로 유지해야 한다.');
assert.equal(groupVoucherRows('order', [
  erpOrderRows[0],
  { ...erpOrderRows[2], rowId: 'ERP-NEXT-UPLOAD', sourceBatchId: 'BATCH-NEXT' }
]).length, 2, '서로 다른 업로드 작업은 같은 업무키여도 자동으로 교차 병합하지 않아야 한다.');
const uploadSerialIgnoredGroups = groupVoucherRows('order', [
  { ...erpOrderRows[0], rowId: 'ERP-UPLOAD-SER-1', UPLOAD_SER_NO: '1' },
  { ...erpOrderRows[2], rowId: 'ERP-UPLOAD-SER-999', UPLOAD_SER_NO: '999' }
]);
assert.equal(uploadSerialIgnoredGroups.length, 1,
  'UPLOAD_SER_NO가 달라도 주문번호·창고·거래처·거래유형이 같으면 한 주문 전표로 묶어야 한다.');
assert.deepEqual(uploadSerialIgnoredGroups[0].rows.map(row => row.rowId), [
  'ERP-UPLOAD-SER-1',
  'ERP-UPLOAD-SER-999'
], 'UPLOAD_SER_NO는 행 순서와 관계없이 주문 그룹키에서 제외해야 한다.');

for (const [fieldName, changedValue] of [
  ['rowCustomerCode', 'C-99'],
  ['deliveryCustomerCode', 'C-99'],
  ['rowVoucherNo', '2026/09/05-99'],
  ['rowTransactionType', '일반'],
  ['rowWarehouseCode', '77']
]) {
  const split = groupVoucherRows('order', [erpOrderRows[0], { ...erpOrderRows[2], rowId: `DIFF-${fieldName}`, [fieldName]: changedValue }]);
  assert.equal(split.length, 2, `${fieldName}가 다르면 주문 전표를 분리해야 한다.`);
}

const conflictingOrderDates = groupVoucherRows('order', [
  erpOrderRows[0],
  { ...erpOrderRows[2], rowId: 'ERP-DATE-CONFLICT', rowVoucherDate: '2026-09-06' }
]);
assert.equal(conflictingOrderDates.length, 1, '주문일은 전표 분리키가 아니어야 한다.');
assert.equal(conflictingOrderDates[0].validationStatus, 'REVIEW_REQUIRED',
  '같은 업무키 안의 상단 날짜 충돌은 첫 값을 임의 채택하지 않고 전표 전체 확인으로 차단해야 한다.');
assert.match(conflictingOrderDates[0].validationErrors.join('\n'), /주문일자 값이 같은 주문서 안에서 다름/);

const headerRoleBase = {
  rowId: 'HEADER-ROLE-1',
  sourceBatchId: 'HEADER-CONFLICT',
  sourceDocumentKey: 'HEADER-DOC-1',
  rowVoucherNo: 'HEADER-ORDER-1',
  rowTransactionType: '일반',
  rowWarehouseId: 'WAREHOUSE-88',
  rowWarehouseCode: '88',
  rowVoucherDate: '2026-09-05',
  rowDeliveryDate: '2026-09-06',
  deliveryCustomerId: 'DELIVERY-1',
  deliveryCustomerCode: 'D-01',
  deliveryCustomerName: '배송사',
  billingCustomerId: 'BILLING-1',
  billingCustomerCode: 'B-01',
  billingCustomerName: '세무사',
  itemCode: 'A',
  itemName: '상품A',
  quantity: 1,
  unit: 'EA'
};
for (const [fieldName, changedValue, label] of [
  ['rowVoucherDate', '2026-09-07', '주문일자'],
  ['rowDeliveryDate', '2026-09-08', '배송일자'],
  ['rowWarehouseId', 'WAREHOUSE-OTHER', '출하창고 ID'],
  ['deliveryCustomerId', 'DELIVERY-OTHER', '배송처 ID'],
  ['deliveryCustomerName', '다른배송사', '배송처명'],
  ['billingCustomerId', 'BILLING-OTHER', '세무거래처 ID'],
  ['billingCustomerCode', 'B-OTHER', '세무거래처코드'],
  ['billingCustomerName', '다른세무사', '세무거래처명']
]) {
  const conflictGroups = groupVoucherRows('order', [
    headerRoleBase,
    {
      ...headerRoleBase,
      rowId: `HEADER-ROLE-${fieldName}`,
      sourceDocumentKey: `HEADER-DOC-${fieldName}`,
      itemCode: `B-${fieldName}`,
      [fieldName]: changedValue
    }
  ]);
  assert.equal(conflictGroups.length, 1,
    `${label}은 주문번호·창고·거래처·거래유형 업무키가 같을 때 별도 전표를 만들지 않아야 한다.`);
  assert.equal(conflictGroups[0].validationStatus, 'REVIEW_REQUIRED',
    `같은 업무키 안의 ${label} 충돌은 첫 행 값을 임의 채택하지 않고 전표 전체를 차단해야 한다.`);
  assert.deepEqual(conflictGroups[0].validationErrors, [`2행 ${label} 값이 같은 주문서 안에서 다름`]);
}

const fullyMatchedHeaderConflict = groupVoucherRows('order', [
  { ...headerRoleBase, matchStatus: 'MATCHED' },
  { ...headerRoleBase, rowId: 'HEADER-MATCHED-CONFLICT', itemCode: 'B', matchStatus: 'MATCHED', billingCustomerName: '다른세무사' }
]);
const fullyMatchedConflictSummary = summarizeVoucherGroups(fullyMatchedHeaderConflict);
assert.equal(fullyMatchedConflictSummary.reviewRequiredVoucherCount, 1);
assert.equal(fullyMatchedConflictSummary.reviewRequired, 2,
  '모든 상품이 MATCHED여도 상단 정보가 충돌한 전표의 전체 행을 확인 필요로 요약해야 한다.');
assert.match(fullyMatchedConflictSummary.label, /확인 필요 전표 1건 · 확인 필요 2행/,
  '화면 요약은 상단 충돌 전표를 확인 필요 0행으로 표시하지 않아야 한다.');

const mixedOrderGroups = groupVoucherRows('order', [
  erpOrderRows[0],
  headerRoleBase,
  { ...headerRoleBase, rowId: 'HEADER-ROLE-CONFLICT', sourceDocumentKey: 'HEADER-DOC-2', itemCode: 'B', billingCustomerName: '다른세무사' }
]);
const mixedOrderPlan = partitionOrderGroups(mixedOrderGroups);
assert.equal(mixedOrderPlan.readyGroups.length, 1,
  '유효 전표와 확인 필요 전표가 섞여 있어도 유효 전표는 저장 대상으로 분리해야 한다.');
assert.equal(mixedOrderPlan.reviewRequiredGroups.length, 1,
  '상단 정보가 충돌한 전표는 쓰기 대상과 분리해 확인 대상으로 유지해야 한다.');
assert.deepEqual(mixedOrderPlan.readyGroups[0].rowIds, ['ERP-1']);
assert.deepEqual(mixedOrderPlan.reviewRequiredGroups[0].rowIds, ['HEADER-ROLE-1', 'HEADER-ROLE-CONFLICT']);
assert.equal(requiresOrderGroupSavePath(mixedOrderGroups, [headerRoleBase]), true,
  '배송·세무 역할 필드만 있는 주문도 충돌 검증을 우회하는 단일 전표 저장 경로로 보내지 않아야 한다.');
const directOrderGroups = groupVoucherRows('order', [{
  itemCode: 'DIRECT-A', itemName: '직접입력 상품', quantity: 1, unit: 'EA'
}], {
  customerId: 'DIRECT-CUSTOMER', customerName: '직접입력 거래처',
  orderDate: '2026-09-05', deliveryDate: '2026-09-06', warehouseId: 'DIRECT-WAREHOUSE'
});
assert.equal(requiresOrderGroupSavePath(directOrderGroups, directOrderGroups[0].rows), false,
  '행별 상단 업무값이 없는 기존 단일 직접입력 주문은 기존 저장 경로를 유지해야 한다.');
const invalidDirectGroups = groupVoucherRows('order', [{
  itemCode: 'DIRECT-INVALID', itemName: '수량 공란', quantity: null, unit: 'EA'
}], {
  customerId: 'DIRECT-CUSTOMER', customerName: '직접입력 거래처',
  orderDate: '2026-09-05', deliveryDate: '2026-09-06', warehouseId: 'DIRECT-WAREHOUSE'
});
assert.equal(requiresOrderGroupSavePath(invalidDirectGroups, invalidDirectGroups[0].rows), false,
  '기존 단일 직접입력의 검증 오류는 기존 필드 포커스·오류 문구 경로에서 처리해야 한다.');
const savedGroupKeys = [];
const mixedSaveResults = await executeOrderGroupSavePlan(mixedOrderPlan, async group => {
  savedGroupKeys.push(group.voucherGroupKey);
  return { targetRecordId: `SAVED-${savedGroupKeys.length}` };
});
assert.deepEqual(savedGroupKeys, [mixedOrderPlan.readyGroups[0].voucherGroupKey],
  '주문 원장 쓰기 callback은 READY 전표에만 실행되어야 한다.');
assert.equal(mixedSaveResults.filter(result => result.ok).length, 1);
assert.equal(mixedSaveResults.filter(result => result.blocked).length, 1,
  '확인 필요 전표는 원장 쓰기 없이 차단 결과로 남겨야 한다.');
const mixedRows = [
  erpOrderRows[0],
  headerRoleBase,
  { ...headerRoleBase, rowId: 'HEADER-ROLE-CONFLICT', billingCustomerName: '다른세무사' }
];
const mixedSubmission = captureOrderRowSubmission(mixedRows);
assert.deepEqual(
  retainUnsavedOrderRows(mixedRows, mixedSubmission, mixedOrderPlan.readyGroups).map(row => row.rowId),
  ['HEADER-ROLE-1', 'HEADER-ROLE-CONFLICT'],
  '부분 저장 뒤에는 REVIEW_REQUIRED 전표의 입력행만 작업표에 유지해야 한다.'
);
const editedReadyRow = { ...erpOrderRows[0], quantity: 3 };
const newReadyRow = { ...erpOrderRows[0], rowId: 'ERP-NEW-DURING-SAVE', itemCode: 'NEW' };
assert.deepEqual(
  retainUnsavedOrderRows(
    [editedReadyRow, headerRoleBase, mixedRows[2], newReadyRow],
    mixedSubmission,
    mixedOrderPlan.readyGroups
  ).map(row => row.rowId),
  ['ERP-1', 'HEADER-ROLE-1', 'HEADER-ROLE-CONFLICT', 'ERP-NEW-DURING-SAVE'],
  '저장 대기 중 수정하거나 추가한 행은 기존 전표 저장 완료 후에도 삭제하지 않아야 한다.'
);
const legacySubmittedRow = { ...erpOrderRows[0], rowId: '', sourceLineKey: 'LEGACY-LINE-1' };
const legacyNewRow = { ...erpOrderRows[0], rowId: '', sourceLineKey: 'LEGACY-LINE-2', itemCode: 'LEGACY-NEW' };
assert.deepEqual(
  retainUnsavedOrderRows(
    [legacySubmittedRow, legacyNewRow],
    captureOrderRowSubmission([legacySubmittedRow]),
    groupVoucherRows('order', [legacySubmittedRow])
  ).map(row => row.sourceLineKey),
  ['LEGACY-LINE-2'],
  'rowId가 없는 기존 행은 sourceLineKey로 제출분만 제거하고 저장 중 새 행을 보존해야 한다.'
);
const headerSubmission = captureOrderHeaderSubmission({
  customerId: 'CUSTOMER-A', orderDate: '2026-09-05', submittedAt: ''
});
assert.equal(orderHeaderChangedSinceSubmission({
  customerId: 'CUSTOMER-A', orderDate: '2026-09-05', submittedAt: '2026-09-05T01:00:00.000Z'
}, headerSubmission), false,
  '저장 완료 시스템 시각은 사용자의 상단 정보 변경으로 판정하지 않아야 한다.');
assert.equal(orderHeaderChangedSinceSubmission({
  customerId: 'CUSTOMER-B', orderDate: '2026-09-05', submittedAt: '2026-09-05T01:00:00.000Z'
}, headerSubmission), true,
  '저장 대기 중 거래처·일자 등 상단 정보를 바꾸면 새 입력 상태로 보존해야 한다.');
const smartInputSource = fs.readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
assert.match(smartInputSource, /const groupedInput = requiresOrderGroupSavePath\(groups, current\.rows\)/,
  '실제 주문 저장 진입점은 행별 상단·역할 값을 포함한 그룹 경로 판정을 사용해야 한다.');
assert.match(smartInputSource, /executeOrderGroupSavePlan\(groupPlan, async group => \{[\s\S]*?createOrder\(payload\)/,
  '실제 ORDER Q 쓰기는 READY 그룹만 순회하는 저장 계획을 통과해야 한다.');
assert.match(smartInputSource, /const remainingRows = retainUnsavedOrderRows\([\s\S]*?const headerChanged = orderHeaderChangedSinceSubmission\([\s\S]*?if \(failed\.length \|\| remainingRows\.length \|\| headerChanged\)/,
  '부분 실패 또는 저장 대기 중 행·상단 변경이 있으면 현재 입력 상태를 유지한 뒤에만 draft 초기화를 판정해야 한다.');

const purchaseRole = groupVoucherRows('purchase', [{
  sourceBatchId: 'ROLE-PURCHASE', sourceDocumentKey: 'DOC',
  supplierCustomerId: 'P1', supplierCustomerCode: 'P-1', supplierCustomerName: '공급사',
  itemCode: 'A', itemName: '상품A', quantity: 1, unit: 'EA'
}])[0];
assert.equal(purchaseRole.supplierCustomerId, 'P1');

const sameSaleRole = groupVoucherRows('sale', [{
  sourceBatchId: 'ROLE-SALE-SAME', sourceDocumentKey: 'DOC', rowCustomerId: 'C1', rowCustomerCode: 'C-1', rowCustomerName: '공통사',
  itemCode: 'A', itemName: '상품A', quantity: 1, unit: 'EA'
}])[0];
assert.deepEqual(
  [sameSaleRole.salesCustomerId, sameSaleRole.deliveryCustomerId, sameSaleRole.billingCustomerId],
  ['C1', 'C1', 'C1']
);
const distinctSaleRows = [{
  sourceBatchId: 'ROLE-SALE-DIFF', sourceDocumentKey: 'DOC',
  salesCustomerId: 'S1', salesCustomerCode: 'S-1', salesCustomerName: '판매사',
  deliveryCustomerId: 'D1', deliveryCustomerCode: 'D-1', deliveryCustomerName: '배송사',
  billingCustomerId: 'B1', billingCustomerCode: 'B-1', billingCustomerName: '세무사',
  itemCode: 'A', itemName: '상품A', quantity: 1, unit: 'EA'
}];
const distinctSaleRole = groupVoucherRows('sale', distinctSaleRows)[0];
assert.deepEqual(
  [distinctSaleRole.salesCustomerId, distinctSaleRole.deliveryCustomerId, distinctSaleRole.billingCustomerId],
  ['S1', 'D1', 'B1'],
  '판매처를 배송처로 무조건 복제하지 않아야 한다.'
);
const changedBillingSaleRole = groupVoucherRows('sale', [{
  ...distinctSaleRows[0], billingCustomerId: 'B2', billingCustomerCode: 'B-2', billingCustomerName: '다른세무사'
}])[0];
assert.notEqual(distinctSaleRole.voucherGroupKey, changedBillingSaleRole.voucherGroupKey, '역할별 거래처는 그룹키에 독립 반영해야 한다.');

const draftWithRoles = contract.createDraft();
draftWithRoles.modes.sale.rows = distinctSaleRows;
draftWithRoles.modes.sale.voucherGroups = [{ ...distinctSaleRole, rows: undefined }];
const restoredWithRoles = contract.normalizeDraft(JSON.parse(JSON.stringify(draftWithRoles)));
assert.equal(restoredWithRoles.modes.sale.rows[0].salesCustomerId, 'S1');
assert.equal(restoredWithRoles.modes.sale.rows[0].deliveryCustomerId, 'D1');
assert.equal(restoredWithRoles.modes.sale.rows[0].billingCustomerId, 'B1');
assert.equal(restoredWithRoles.modes.sale.voucherGroups[0].salesCustomerId, 'S1');
assert.equal(restoredWithRoles.modes.sale.voucherGroups[0].deliveryCustomerId, 'D1');
assert.equal(restoredWithRoles.modes.sale.voucherGroups[0].billingCustomerId, 'B1');

const manualGroups = groupVoucherRows('purchase', [
  { ...rows[0], manualSplitKey: 'A', rowVoucherNo: '' },
  { ...rows[0], rowId: 'ROW-2', manualSplitKey: 'B', rowVoucherNo: '' }
]);
assert.equal(manualGroups.length, 2, '수동 분리키는 같은 일자·거래처도 별도 전표로 분리해야 한다.');

const unresolvedUnit = normalizeStage1Row({ quantity: 1, unit: 'BOX', baseUnit: 'EA' });
assert.equal(unresolvedUnit.baseQuantity, null);
assert.equal(unresolvedUnit.unitConversionStatus, 'REVIEW_REQUIRED');
const converted = normalizeStage1Row({ quantity: -2, unit: 'BOX', baseUnit: 'EA', unitConversionFactor: 10 });
assert.equal(converted.baseQuantity, -20);

const summary = summarizeVoucherGroups(groups);
assert.deepEqual(
  { customerCount: summary.customerCount, voucherCount: summary.voucherCount, rowCount: summary.rowCount },
  { customerCount: 1, voucherCount: 2, rowCount: 3 }
);
assert.equal(filterVoucherRows(rows, '남경 비름').length, 1);
assert.equal(filterVoucherRows(rows, '105040110').length, 1);
assert.equal(filterVoucherRows(rows, 'P-1').length, 2);
assert.equal(filterVoucherRows(rows, '').length, 3);

assert.deepEqual(buildMinimumUploadMatrix('order')[0], [
  '거래처명', '배송일자', '품목코드', '품목명', '규격', '수량', '단위', '단가', '메모'
]);
assert.deepEqual(buildMinimumUploadMatrix('purchase')[0], [
  '구매처명', '구매일자', '품목코드', '품목명', '규격', '수량', '단위', '입고가', '메모'
]);
assert.deepEqual(buildMinimumUploadMatrix('sale')[0], [
  '판매처명', '판매일자', '품목코드', '품목명', '규격', '수량', '단위', '판매가', '메모'
]);

const orderRows = decorateStructuredRows([
  { rowCustomerName: '남경', rowVoucherDate: '2026-08-24', rowDeliveryDate: '2026-08-25', rowWarehouseCode: '02', itemCode: 'A', itemName: '상품A', quantity: -1, unit: 'EA', unitPrice: 2000, sourceVoucherIndex: 1 }
], { sourceBatchId: 'B', sourceDocumentKey: 'DOC', sourceFingerprint: 'ORDER-HASH' });
const orderGroup = groupVoucherRows('order', orderRows)[0];
const payload = buildOrderGroupPayload(orderGroup, { orderDate: '2026-08-24' });
assert.equal(payload.sourceDocumentKey, orderGroup.idempotencyKey);
assert.equal(payload.items[0].rawQuantity, -1);
assert.equal(payload.items[0].finalQuantity, -1);
assert.equal(payload.items[0].supplyAmount, -2000);
const erpPayload = buildOrderGroupPayload(erpOrderGroups[0], {});
assert.equal(erpPayload.externalOrderNo, '2026/09/05-7');
assert.equal(erpPayload.transactionType, '기타');
assert.equal(erpPayload.warehouseCode, '88');

console.log('SmartInput multi-voucher stage 1 PASS');
