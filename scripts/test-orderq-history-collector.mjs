import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyMatrix, mapMatrixRows, COLLECTOR_SOURCE } from '../orderq/history-collector/collector-schema.js';
import { matrixContextDate } from '../orderq/history-collector/collector-importer.js';
import { addBusinessDays, buildFulfillmentLinks, LINK_STATUS } from '../orderq/history-collector/fulfillment-matcher.js';
import { buildParserEvidence } from '../orderq/history-collector/parser-evidence.js';

const salesMatrix = [
  ['회사명 : 원앱 / 2026/08/13'],
  ['일자', '창고코드', '거래처명', 'no.', '품목코드', '품명', '수량', '단가', '공급가', '적요'],
  ['2026/08/13', '02', '담솥', '50', '101020114', '대파_단 [EA]', 2, 2500, 5000, '']
];
const salesClass = classifyMatrix(salesMatrix, '판매현황내역', '0813판매.xlsx');
assert.equal(salesClass.sourceType, COLLECTOR_SOURCE.SALES);
assert.equal(mapMatrixRows(salesMatrix, salesClass).rows[0].normalizedRecord.productCode, '101020114');

const purchaseMatrix = [
  ['회사명 : 원앱'],
  ['일자', '거래처명', '창고코드', '코드', '품명', '규격', '수량', '단가', '합계', '적요', '구매처'],
  ['2026/08/13', '거창', '01', '101012122', '배추우거지', 'BOX', 2, 3000, 6000, '', '']
];
assert.equal(classifyMatrix(purchaseMatrix, '구매현황내역').sourceType, COLLECTOR_SOURCE.PURCHASE);

const inventoryMatrix = [
  ['회사명 : 원앱 / 1창고 / 2026/08/13 / 전체재고'],
  ['단위', '창고', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '적요'],
  ['EA', '01', '101020114', '대파_단', 'EA', 8, '2026-08-13', '거창', 1600, '']
];
assert.equal(classifyMatrix(inventoryMatrix, '전체재고').sourceType, COLLECTOR_SOURCE.INVENTORY);
assert.equal(
  matrixContextDate([['회사명 : 원앱 / 주문 / 2025/08/13 ~ 2026/08/13']], '미출고현황.xlsx'),
  '2026-08-13',
  'range titles must use the latest date rather than the range start or a partial year match',
);

assert.equal(addBusinessDays('2026-08-14', 1, []), '2026-08-17', 'Friday order should match Monday sale');
assert.equal(addBusinessDays('2026-08-14', 1, ['2026-08-17']), '2026-08-18', 'holiday must be skipped');

const orderGroups = [
  { historicalOrderGroupId: 'G1', orderDate: '2026-08-12', customerName: '담솥', normalizedCustomerName: '담솥', status: 'ACTIVE' },
  { historicalOrderGroupId: 'G2', orderDate: '2026-08-13', orderTime: '05:30', customerName: '한옥', normalizedCustomerName: '한옥', status: 'ACTIVE' },
  { historicalOrderGroupId: 'G3', orderDate: '2026-08-13', customerName: '시간없음', normalizedCustomerName: '시간없음', status: 'ACTIVE' }
];
const orderLines = [
  { historicalOrderLineId: 'O1', historicalOrderGroupId: 'G1', customerName: '담솥', orderDate: '2026-08-12', productCode: 'P1', productName: '대파', rawExpression: '대파', quantity: 10 },
  { historicalOrderLineId: 'O2', historicalOrderGroupId: 'G2', customerName: '한옥', orderDate: '2026-08-13', productCode: 'P2', productName: '무순', rawExpression: '무순', quantity: 2 },
  { historicalOrderLineId: 'O3', historicalOrderGroupId: 'G3', customerName: '시간없음', orderDate: '2026-08-13', productCode: 'P3', productName: '새싹', rawExpression: '새싹', quantity: 1 }
];
const salesDocuments = [
  { salesDocumentId: 'D1', salesDate: '2026-08-13', customerName: '담솥' },
  { salesDocumentId: 'D2', salesDate: '2026-08-13', customerName: '한옥' },
  { salesDocumentId: 'D3', salesDate: '2026-08-13', customerName: '시간없음' },
  { salesDocumentId: 'D4', salesDate: '2026-08-13', customerName: '반품' }
];
const salesLines = [
  { salesLineId: 'S1', salesDocumentId: 'D1', productCode: 'P1', productName: '대파', quantity: 6 },
  { salesLineId: 'S2', salesDocumentId: 'D1', productCode: 'P1', productName: '대파', quantity: 4 },
  { salesLineId: 'S3', salesDocumentId: 'D2', productCode: 'P2', productName: '무순', quantity: 2 },
  { salesLineId: 'S4', salesDocumentId: 'D3', productCode: 'P3', productName: '새싹', quantity: 1 },
  { salesLineId: 'S5', salesDocumentId: 'D4', productCode: 'P4', productName: '샐러리', quantity: -1 }
];
const matched = buildFulfillmentLinks({ orderGroups, orderLines, salesDocuments, salesLines, settings: { cutoffHour: 12, cutoffMinute: 0, holidays: [] } });
assert.equal(matched.unmatchedOrders.length, 0);
assert.equal(matched.links.filter(row => row.historicalOrderLineId === 'O1').reduce((sum, row) => sum + row.allocatedQuantity, 0), 10, 'partial sales must sum to order quantity');
assert.ok(matched.links.find(row => row.salesLineId === 'S3' && row.status === LINK_STATUS.STRONG), 'same-day dawn order should be strong');
assert.ok(matched.links.find(row => row.salesLineId === 'S4' && row.status === LINK_STATUS.PROBABLE), 'same-day date-only order must not become strong');
assert.ok(matched.links.find(row => row.salesLineId === 'S5' && row.status === LINK_STATUS.EXCLUDED), 'negative sale must be preserved as excluded reversal');

const evidenceLinks = [1, 2, 3].map(index => ({
  fulfillmentLinkId: `F${index}`, historicalOrderLineId: `EO${index}`, salesLineId: `ES${index}`,
  status: LINK_STATUS.STRONG, orderDate: `2026-08-${10 + index}`, customerName: '담솥', productCode: 'P1'
}));
const evidenceOrders = [1, 2, 3].map(index => ({ historicalOrderLineId: `EO${index}`, customerName: '담솥', rawExpression: '대파 두단', orderDate: `2026-08-${10 + index}` }));
const evidenceSales = [1, 2, 3].map(index => ({ salesLineId: `ES${index}`, productCode: 'P1', productName: '대파' }));
const evidence = buildParserEvidence({ links: evidenceLinks, orderLines: evidenceOrders, salesLines: evidenceSales });
assert.equal(evidence[0].status, 'READY_FOR_ADMIN_CONFIRMATION');

for (const path of [
  'orderq/collector.html', 'orderq/collector-ui.js', 'orderq/history-collector/history-repository.js',
  'orderq/HISTORY_COLLECTOR_SPEC.md', 'orderq-cloud.gs', 'code.gs'
]) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.ok(source.length > 100, `${path} should exist`);
}

const cloudAdapter = await readFile(new URL('../orderq/orderq-cloud-adapter.js', import.meta.url), 'utf8');
assert.match(cloudAdapter, /oneapp_orderq_access_token_v1/);
assert.match(cloudAdapter, /token:\s*getCloudAccessToken\(\)/);
const cloudServer = await readFile(new URL('../orderq-cloud.gs', import.meta.url), 'utf8');
assert.match(cloudServer, /ORDER_TXN_LOG/);
assert.match(cloudServer, /orderQRecoverPendingTransactions/);
const entry = await readFile(new URL('../orderq/index.html', import.meta.url), 'utf8');
assert.match(entry, /collector\.html/);
assert.match(entry, /vNext 0\.4/);

console.log('PASS: ORDER Q history collector, flexible cutoff, fulfillment and evidence contracts');
