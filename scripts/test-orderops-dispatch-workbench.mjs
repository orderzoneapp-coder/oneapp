import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { globalThis: {}, console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'orderFulfillmentEngine.js'), 'utf8'), context);
const engine = context.ShippingManagementEngine;

const orderHeaders = [
  '일자-No.', '담당', '창고', '단위', '품목코드', '품목명', '규격', '수량', '재고', '단가',
  '공급가액', '적요', '적요(직원)', '거래처', '거래처코드', '지역', '그룹',
];
const ordersMatrix = [
  ['테스트 주문현황'],
  orderHeaders,
  ['2026-09-11-1', '담당A', '본창고', 'EA', 'P-1', '상품1', 'EA', 2, '', 1000, 2000, '일반 지시', '직원 메모 A', '동일상호', 'C-001', '남부', '배송-1'],
  ['2026-09-11-1', '담당B', '본창고', 'BOX', 'P-2', '상품2', 'BOX', 3, '', 2000, 6000, '일반 지시 2', '직원 메모 B', '동일상호', 'C-001', '남부', '배송-1'],
  ['2026-09-11-2', '담당C', '본창고', 'EA', 'P-3', '상품3', 'EA', 1, '', 3000, 3000, '별도 지시', '다른 고객 메모', '동일상호', 'C-002', '북부', '배송-2'],
];
const parsedOrders = engine.parseOrderWorkbook({
  fileName: '주문현황.xlsx', sheetName: '미판매현황', rawMatrix: ordersMatrix, displayMatrix: ordersMatrix,
});
assert.equal(parsedOrders.errors.length, 0);
assert.equal(
  JSON.stringify(parsedOrders.rows.map((row) => [row.customerCode, row.region, row.note1, row.customerKey])),
  JSON.stringify(
  [
    ['C-001', '남부', '직원 메모 A', 'CUSTOMER:C-001'],
    ['C-001', '남부', '직원 메모 B', 'CUSTOMER:C-001'],
    ['C-002', '북부', '다른 고객 메모', 'CUSTOMER:C-002'],
  ]),
  '지역과 적요(직원)은 별도 원본 필드로 보존하고 거래처 코드를 작업 키로 사용해야 한다',
);

const inventoryHeaders = ['사용', '품목코드', '단위', '품목명', '규격', '수량', '1창고', '3서울', '4전송'];
const inventoryMatrix = [
  ['테스트 창고재고'], inventoryHeaders,
  ['Yes', 'P-1', 'EA', '상품1', 'EA', 10, 10, 0, 0],
  ['Yes', 'P-2', 'EA', '상품2', 'EA', 10, 10, 0, 0],
  ['Yes', 'P-3', 'EA', '상품3', 'EA', 10, 10, 0, 0],
];
const parsedInventory = engine.parseInventoryWorkbook({
  fileName: '창고재고.xlsx', sheetName: '재고현황', rawMatrix: inventoryMatrix, displayMatrix: inventoryMatrix,
});
assert.equal(parsedInventory.errors.length, 0);
const workspace = engine.analyze(parsedOrders, parsedInventory, { createdAt: '2026-09-11T00:00:00.000Z' });
const deliveryRows = engine.getDeliverySummaryRows(workspace);
assert.equal(deliveryRows.length, 2, '같은 주문번호의 여러 품목은 주문서 한 행으로 요약해야 한다');
assert.equal(deliveryRows[0].itemCount, 2);
assert.equal(deliveryRows[0].additionalItemCount, 1);
assert.equal(deliveryRows[0].managerMixed, true);
assert.deepEqual(JSON.parse(JSON.stringify(deliveryRows[0].quantityGroups)), [
  { unit: 'EA', total: 2, valueCount: 1, blankCount: 0, invalidCount: 0 },
  { unit: 'BOX', total: 3, valueCount: 1, blankCount: 0, invalidCount: 0 },
], '서로 다른 단위의 주문수량을 임의로 합산하면 안 된다');
assert.equal(deliveryRows[0].amountTotal, 8000);
assert.equal(deliveryRows[0].employeeNote, '직원 메모 A / 직원 메모 B');
assert.doesNotMatch(deliveryRows[0].employeeNote, /일반 지시/, '일반 적요를 직원 적요에 합치면 안 된다');
const editedSourceRow = workspace.orders[0].sourceRowNumber;
engine.setOrderValue(workspace, editedSourceRow, 'deliveryNotice', '직원 메모 A 수정', {
  actor: '테스트 관리자', recordHistory: true,
});
assert.deepEqual(
  [workspace.orders[0].note, workspace.orders[0].noteOriginal, workspace.orders[0].note1, workspace.orders[0].note1Original],
  ['일반 지시', '일반 지시', '직원 메모 A 수정', '직원 메모 A 수정'],
  '중앙 전달사항 편집은 직원 적요만 바꾸고 일반 적요 원본을 보존해야 한다',
);
assert.equal(engine.getDeliverySummaryRows(workspace)[0].employeeNote, '직원 메모 A 수정 / 직원 메모 B');
const recoveredWorkspace = JSON.parse(JSON.stringify(workspace));
assert.deepEqual(
  [recoveredWorkspace.orders[0].noteOriginal, recoveredWorkspace.orders[0].note1Original],
  ['일반 지시', '직원 메모 A 수정'],
  '임시저장 payload 왕복에서도 일반 적요와 직원 적요를 분리 보존해야 한다',
);

const partialUnassigned = engine.getDeliverySummaryRows({ orders: [
  { sourceRowNumber: 10, orderNumber: 'ORD-MIXED', warehouse: '본창고', customer: '부분상사', customerCode: 'C-MIXED', manager: '담당A', region: '남부', productCode: 'A', productName: '상품A', sourceUnit: 'EA', quantity: 0, supplyAmount: 0 },
  { sourceRowNumber: 11, orderNumber: 'ORD-MIXED', warehouse: '본창고', customer: '부분상사', customerCode: 'C-MIXED', manager: '', region: '', productCode: 'B', productName: '상품B', sourceUnit: 'EA', quantity: '', supplyAmount: null },
] })[0];
assert.equal(partialUnassigned.managerMixed, true);
assert.equal(partialUnassigned.managerUnassigned, true);
assert.equal(partialUnassigned.managerLabel, '혼합(담당A, 미지정)');
assert.equal(partialUnassigned.regionLabel, '혼합(남부, 미지정)');
assert.equal(partialUnassigned.quantityGroups[0].total, 0, '명시적 수량 0을 공란과 구분해야 한다');
assert.equal(partialUnassigned.quantityGroups[0].blankCount, 1);
assert.equal(partialUnassigned.amountTotal, 0, '명시적 금액 0을 공란과 구분해야 한다');
assert.equal(partialUnassigned.amountBlankCount, 1);

assert.notEqual(
  engine.customerWorkKey({ customer: '코드없음', orderNumber: 'ORD-1', warehouse: '본창고', customerKey: 'DELIVERY:legacy' }),
  engine.customerWorkKey({ customer: '코드없음', orderNumber: 'ORD-1', warehouse: '서울창고', customerKey: 'DELIVERY:legacy' }),
  '거래처 코드가 없는 주문은 같은 주문번호라도 창고가 다르면 별도 배송 단위여야 한다',
);
const result = engine.setCustomerManager(workspace, 'CUSTOMER:C-001', '담당Z', {
  actor: '테스트 관리자', recordHistory: true,
});
assert.equal(result.affectedRowCount, 2, '담당자 변경 단위는 상품행이 아니라 안정된 거래처 키여야 한다');
assert.equal(JSON.stringify(workspace.orders.map((row) => row.manager)), JSON.stringify(['담당Z', '담당Z', '담당C']));
assert.equal(JSON.stringify(workspace.allocations.map((row) => row.manager)), JSON.stringify(['담당Z', '담당Z', '담당C']));
assert.equal(workspace.orders[2].customer, workspace.orders[0].customer, '테스트 전제상 상호명은 같아야 한다');
assert.notEqual(workspace.orders[2].customerKey, workspace.orders[0].customerKey,
  '같은 상호명의 다른 거래처 코드는 합쳐지면 안 된다');
assert.equal(workspace.systemHistory.events.filter((event) => event.field === 'manager').length, 2,
  '변경된 상품행마다 기존 시스템 변경이력 경계에 기록해야 한다');
const noOp = engine.setCustomerManager(workspace, 'CUSTOMER:C-001', '담당Z', {
  actor: '테스트 관리자', recordHistory: true,
});
assert.equal(noOp.changedRowCount, 0);
assert.equal(workspace.systemHistory.events.filter((event) => event.field === 'manager').length, 2,
  '같은 담당자 재선택은 중복 변경이력을 만들면 안 된다');

const html = fs.readFileSync(path.join(root, 'orderops', 'list.html'), 'utf8');
const layoutController = fs.readFileSync(path.join(root, 'nexus', 'common', 'nexus-workbench-layout-v2.js'), 'utf8');
for (const contract of [
  'data-nexus-workspace="orderops"',
  'id="deliverySummaryBody"',
  'id="inventoryInspector"',
  'id="inventoryInspectorReopen"',
  'id="orderOpsManagerOptions"',
  'id="deliveryManagerFilter"',
  'id="deliveryRegionFilter"',
  'function deliverySummaryRows()',
  'function confirmedQuantityForProduct(productCode)',
  '적요(직원)',
  'outerWorkspace.append(leftPane, resultsPanel, rightPane)',
  'workspaceMode === engine.PREVIEW_WORKSPACE_MODE',
  '"거래처", "상품", "주문수량", "직원 적요"',
  'hasInventory ? ["재고", "잔량"]',
  '보조 내용은 별도 승인 전입니다.',
  'function formatEmployeeDeliveryNotice(row)',
  'orderops-side-table orderops-delivery-table',
  '@container (max-width: 419px)',
  '<th>주문번호</th><th>창고</th><th>담당자</th><th>지역</th><th>거래처</th><th>품목</th><th>수량</th><th>금액</th><th>적요(직원)</th>',
]) assert.ok(html.includes(contract), `출고관리 추가 레이아웃 계약 누락: ${contract}`);
assert.doesNotMatch(html, /employeeNote\s*=\s*String\(row\?\.noteOriginal|employeeNote\s*=\s*String\(row\?\.note\s/,
  '왼쪽 배송 메모는 일반 적요를 적요(직원) 대신 사용하면 안 된다');
assert.match(layoutController, /function isPaneRequestedOpen\(element\)/,
  '우측 패널 열림 상태는 닫힘 CSS의 계산 결과와 분리해야 한다');
assert.doesNotMatch(layoutController, /rightOpen\s*=\s*isVisible\(rightPane\)/,
  'CSS로 숨겨진 계산 스타일을 우측 패널 재열림 판정에 다시 사용하면 안 된다');

console.log('OrderOps dispatch workbench tests passed.');
