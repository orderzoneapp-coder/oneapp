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
  '적요', '적요(직원)', '거래처', '거래처코드', '지역', '그룹',
];
const ordersMatrix = [
  ['테스트 주문현황'],
  orderHeaders,
  ['2026-09-11-1', '담당A', '본창고', 'EA', 'P-1', '상품1', 'EA', 2, '', 1000, '일반 지시', '직원 메모 A', '동일상호', 'C-001', '남부', '배송-1'],
  ['2026-09-11-1', '담당B', '본창고', 'EA', 'P-2', '상품2', 'EA', 3, '', 2000, '일반 지시 2', '직원 메모 B', '동일상호', 'C-001', '남부', '배송-1'],
  ['2026-09-11-2', '담당C', '본창고', 'EA', 'P-3', '상품3', 'EA', 1, '', 3000, '별도 지시', '다른 고객 메모', '동일상호', 'C-002', '북부', '배송-2'],
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

const html = fs.readFileSync(path.join(root, 'orderops', 'list.html'), 'utf8');
for (const contract of [
  'data-nexus-workspace="orderops"',
  'id="deliverySummaryBody"',
  'id="inventoryInspector"',
  'id="inventoryInspectorReopen"',
  'id="orderOpsManagerOptions"',
  'function deliverySummaryRows()',
  'function confirmedQuantityForProduct(productCode)',
  '적요(직원)',
  '현재 재고−주문수량의 화면 계산값',
]) assert.ok(html.includes(contract), `출고관리 추가 레이아웃 계약 누락: ${contract}`);
assert.doesNotMatch(html, /employeeNote\s*=\s*String\(row\?\.noteOriginal|employeeNote\s*=\s*String\(row\?\.note\s/, 
  '왼쪽 배송 메모는 일반 적요를 적요(직원) 대신 사용하면 안 된다');

console.log('OrderOps dispatch workbench tests passed.');
