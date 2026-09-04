#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStructuredSheet } from '../smartinput/structured-sheet-parser.js';
import {
  buildMinimumUploadMatrix,
  buildOrderGroupPayload,
  decorateStructuredRows,
  filterVoucherRows,
  groupVoucherRows,
  normalizeStage1Row,
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
    rowCustomerId: 'CUSTOMER-A-OLD', rowCustomerCode: 'C-01', rowCustomerName: '거래처A',
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
    rowCustomerId: 'CUSTOMER-A-NEW', rowCustomerCode: 'C-01', rowCustomerName: '거래처A',
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

for (const [fieldName, changedValue] of [
  ['rowCustomerCode', 'C-99'],
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
