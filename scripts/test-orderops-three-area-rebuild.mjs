import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapOrderQSnapshotToParsedOrders } from '../orderops/orderq-order-source-adapter.js';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const engine = require(join(root, 'orderFulfillmentEngine.js'));
const coordinator = require(join(root, 'orderops/source-coordinator.js'));
const vouchers = require(join(root, 'orderops/voucher-workbench.js'));
const html = readFileSync(join(root, 'orderops/list.html'), 'utf8');
const css = readFileSync(join(root, 'orderops/workbench-v12.css'), 'utf8');
const activityAdapter = readFileSync(join(root, 'orderq/voucher-activity-read-adapter.js'), 'utf8');
const shipmentAdapter = readFileSync(join(root, 'orderq/shipment-order-read-adapter.js'), 'utf8');

const snapshot = (orderId, orderNo, manager, unit = 'EA', quantity = 1) => ({
  companyId: 'ONEAPP', orderId, orderNo, orderDate: '2026-09-13', orderRevision: 1,
  snapshotHash: (orderId === 'ORDER-A' ? 'a' : 'b').repeat(64), eligible: true,
  customerId: 'CUSTOMER-1', customerName: '같은 거래처', warehouseName: '1창고', assigneeName: manager,
  candidateLines: [{ orderItemId: `${orderId}-LINE`, sourceLineKey: 'SOURCE-LINE-1', itemCode: 'P-1', itemName: '상품', unit, shippableQuantity: quantity }],
});
const a = snapshot('ORDER-A', 'A-001', '담당 A', 'EA', 2);
const b = snapshot('ORDER-B', 'B-001', '담당 B', 'BOX', 3);
const combined = coordinator.combineOrderSources([
  { status: 'READY', snapshot: a, parsedOrders: mapOrderQSnapshotToParsedOrders(a) },
  { status: 'READY', snapshot: b, parsedOrders: mapOrderQSnapshotToParsedOrders(b) },
], { fileHash: 'c'.repeat(64) });
assert.equal(combined.status, 'READY');
assert.deepEqual(combined.parsed.rows.map(row => row.originalSourceRowNumber), [2, 2], 'owner row numbers remain evidence');
assert.deepEqual(combined.parsed.rows.map(row => row.sourceRowNumber), [2, 3], 'work rows are unique across documents');
assert.equal(new Set(combined.parsed.rows.map(row => row.workRowId)).size, 2);
assert.equal(combined.parsed.sourceRegistry.documents.length, 2);
assert.equal(combined.orderQSource, null, 'multi-document source does not impersonate one shipment command owner');
const single = coordinator.combineOrderSources([
  { status: 'READY', snapshot: a, parsedOrders: mapOrderQSnapshotToParsedOrders(a) },
], { fileHash: 'e'.repeat(64) });
assert.equal(single.orderQSource.snapshot.orderId, 'ORDER-A', 'single-document preparation keeps the existing shipment owner boundary');

const workspace = engine.createPreviewWorkspace(combined.parsed);
const list = vouchers.buildVouchers(workspace, { rowId: (row, source, index) => engine.getOrderWorkRowId(row, source, index) });
assert.equal(list.length, 2, 'same customer remains two vouchers');
assert.deepEqual(list.map(item => item.quantityGroups.map(group => [group.unit, group.total])), [[['EA', 2]], [['BOX', 3]]]);
const amountList = vouchers.buildVouchers({
  orders: [
    { orderId: 'amount-order', orderItemId: 'a', quantity: 2, sourceUnit: 'EA', unitPrice: 500, supplyAmount: 900 },
    { orderId: 'amount-order', orderItemId: 'b', quantity: 3, sourceUnit: 'EA', unitPrice: 700, supplyAmount: '' },
    { orderId: 'amount-order', orderItemId: 'c', quantity: '', sourceUnit: 'EA', unitPrice: 700, supplyAmount: '' },
    { orderId: 'amount-order', orderItemId: 'd', quantity: 1, sourceUnit: 'EA', unitPrice: 700, supplyAmount: 'not-a-number' },
  ],
}, { rowId: (row, source, index) => engine.getOrderWorkRowId(row, source, index) });
assert.equal(amountList[0].amountTotal, 900, 'source amount remains separate');
assert.equal(amountList[0].amountValueCount, 1, 'source amount count remains explicit');
assert.equal(amountList[0].calculatedAmountTotal, 2100, 'blank source amount exposes read-only calculation');
assert.equal(amountList[0].calculatedAmountValueCount, 1, 'calculated amount count remains explicit');
assert.equal(amountList[0].amountUnknownCount, 1, 'missing calculation inputs remain unknown');
assert.equal(amountList[0].amountInvalidCount, 1, 'invalid source amount remains invalid');
const excelParsed = engine.parseOrderWorkbook({
  fileName: 'renamed.xlsx',
  sheetName: '주문',
  fileHash: 'f'.repeat(64),
  displayMatrix: [
    ['일자-No.', '담당', '창고', '단위', '품목코드', '품목명', '규격', '수량', '적요', '적요1', '거래처', '그룹'],
    ['2026-09-13-001', '담당', '1창고', 'EA', 'P-1', '상품1', '', 1, '', '', '같은 거래처', 'G'],
    ['2026-09-13-001', '담당', '1창고', 'EA', 'P-2', '상품2', '', 2, '', '', '같은 거래처', 'G'],
    ['2026-09-14-001', '담당', '1창고', 'EA', 'P-3', '상품3', '', 3, '', '', '같은 거래처', 'G'],
  ],
});
assert.equal(excelParsed.errors.length, 0);
assert.equal(excelParsed.rows[0].voucherId, excelParsed.rows[1].voucherId, 'same Excel source boundary shares one fixed voucher id');
assert.notEqual(excelParsed.rows[0].voucherId, excelParsed.rows[2].voucherId, 'different Excel source boundary remains a separate voucher');
assert.equal(new Set(excelParsed.rows.map(row => row.workRowId)).size, 3, 'Excel rows receive stable source/sheet/line work ids');
const excelWorkspace = engine.createPreviewWorkspace(excelParsed);
const beforeExcelVoucherId = vouchers.buildVouchers(excelWorkspace)[0].voucherId;
excelWorkspace.orders[0].warehouse = '변경창고';
assert.equal(vouchers.buildVouchers(excelWorkspace)[0].voucherId, beforeExcelVoucherId, 'editing warehouse does not regenerate the fixed Excel voucher id');
const selected = new Set([list[0].voucherId]);
const patches = vouchers.buildPatches(list, selected, { manager: { mode: 'SET', value: '선택 담당' } }, {
  [list[0].rowIds[0]]: { manager: '담당 A' },
});
const applied = engine.applyOrderPatches(workspace, patches, { recordHistory: true, actor: 'three-area-test', occurredAt: '2026-09-13T00:00:00.000Z' });
assert.equal(applied.changedRowCount, 1);
assert.deepEqual(workspace.orders.map(row => row.manager), ['선택 담당', '담당 B'], 'unchecked voucher remains unchanged');
const historyCount = workspace.systemHistory.events.length;
const repeated = engine.applyOrderPatches(workspace, vouchers.buildPatches(list, selected, { manager: { mode: 'SET', value: '선택 담당' } }), { recordHistory: true, actor: 'three-area-test' });
assert.equal(repeated.changedFieldCount, 0, 'same-value repeat is idempotent');
assert.equal(workspace.systemHistory.events.length, historyCount, 'same-value repeat adds no history');
assert.throws(() => engine.applyOrderPatches(workspace, [{
  workRowId: list[0].rowIds[0], values: { warehouse: '2창고' }, expected: { warehouse: 'old-value' },
}], { recordHistory: true }), error => error.code === 'ORDER_PATCH_CONFLICT');
assert.equal(workspace.orders[0].warehouse, '1창고', 'conflict preserves current work');

const filtered = vouchers.filterVouchers(list, { query: 'B-001', fromDate: '2026-09-13', toDate: '2026-09-13' });
assert.equal(filtered.length, 1);
assert.equal(vouchers.summarizeSelection(list, selected).voucherCount, 1);

const activity = coordinator.activitySnapshotToParsed({
  status: 'READY', fromDate: '2026-09-12', toDate: '2026-09-13', rows: [{
    id: 'PURCHASE-1', companyId: 'ONEAPP', voucherNo: 'P-001', date: '2026-09-13', customerName: '구매처', items: [{ lineId: 'PL-1', code: 'P-1', name: '상품', quantity: 4, unit: 'EA' }],
  }],
}, 'purchases', { fileHash: 'd'.repeat(64) });
assert.equal(activity.parsed.rows[0].partner, '구매처');
assert.equal(activity.parsed.sourceRegistry.documents.length, 1);

const recovery = engine.buildLocalRecoveryPayload(workspace, {
  activePreview: 'allocations', selectedVoucherIds: [...selected],
  voucherFilters: { fromDate: '2026-09-13', query: 'A-001' },
  voucherDraft: { manager: '대기 담당', baseByRowId: { [list[0].rowIds[0]]: { manager: '선택 담당' } } },
});
assert.deepEqual(recovery.ui.selectedVoucherIds, [...selected]);
assert.equal(recovery.ui.voucherDraft.manager, '대기 담당');

for (const contract of [
  'source-coordinator.js?v=20260913-three-area',
  'voucher-workbench.js?v=20260913-three-area',
  'data-orderops-api-source="orders"',
  'data-orderops-api-source="purchases"',
  'data-orderops-api-source="sales"',
  'data-orderops-api-source="inventory"',
  'id="orderOpsCurrentViewTitle"',
  'id="deliveryVoucherCheckAll"',
  'id="deliveryWarehouseAssignmentApply"',
  'id="deliveryVoucherApply"',
  '값 지우기',
  'multiple="" size="5"',
  'prepareSelectedOrderQSources',
  'readVoucherActivityRange',
  'id="orderOpsApiStatus"',
  'setApiSourceStatus("LOADING"',
  'const result = await listInventorySnapshots()',
  'workbench.runReplacement(',
  'const candidate = JSON.parse(JSON.stringify(base))',
]) assert.ok(html.includes(contract), `missing three-area UI contract: ${contract}`);
assert.ok(!html.includes('normalizeOrderOpsWorkspaceDom'), 'runtime DOM rearrangement path must be removed');
for (const contract of ['Math.min(62', 'Math.min(4', "status: partial ? 'PARTIAL'", 'failureDates']) {
  assert.ok(activityAdapter.includes(contract), `missing bounded voucher activity contract: ${contract}`);
}
for (const contract of ["PARTIAL: 'PARTIAL'", 'validDate(fromDate)', 'failedCount', 'scope: { fromDate']) {
  assert.ok(shipmentAdapter.includes(contract), `missing bounded shipment list contract: ${contract}`);
}
for (const contract of ['.orderops-api-actions', '.orderops-current-view-title', '#deliveryVoucherApply']) {
  assert.ok(css.includes(contract), `missing three-area CSS contract: ${contract}`);
}

console.log('PASS OrderOps three-area source preparation, stable multi-document identity, selected-voucher patch, conflict, idempotency, units, recovery, and UI contracts.');
