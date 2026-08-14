import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  classifyMatrix,
  mapMatrixRows,
  expandInventoryWarehouseRows,
  COLLECTOR_SOURCE
} from '../orderq/history-collector/collector-schema.js';
import { analyzeHistoricalText, matrixContextDate } from '../orderq/history-collector/collector-importer.js';
import { addBusinessDays, buildFulfillmentLinks, LINK_STATUS } from '../orderq/history-collector/fulfillment-matcher.js';
import { buildParserEvidence } from '../orderq/history-collector/parser-evidence.js';
import { MAPPING_STATUS, deactivateEvidenceMapping, reconcileEvidenceMappings } from '../orderq/history-collector/mapping-lifecycle.js';

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

const wideInventoryMatrix = [
  ['회사명 : 원앱 / 2026/08/13'],
  ['사용', '품목코드', '단위', '품목명', '규격', '수량', '1창고', '2전송', '3서울', '4전송', '기본', '전송', '창고'],
  ['Yes', '101020114', 'EA', '대파_단', 'EA', 373, 163, -200, 510, -100, '1', 2000, 1600],
  ['Yes', '101010111', 'BOX', '햇무우', 'BOX', 8, 8, '', '', '', '1', 13000, 16000]
];
const wideInventoryClass = classifyMatrix(wideInventoryMatrix, '재고현황', '창고별재고.xlsx');
const wideInventoryRows = expandInventoryWarehouseRows(
  mapMatrixRows(wideInventoryMatrix, wideInventoryClass).rows,
  wideInventoryClass
);
assert.deepEqual(
  wideInventoryRows.warehouseColumns.map(column => [column.warehouseCode, column.warehouseName]),
  [['01', '1창고'], ['02', '2전송'], ['03', '3서울'], ['04', '4전송']],
  '번호가 붙은 동적 열만 창고로 판별하고 가격 열 기본·전송·창고는 제외해야 한다.'
);
assert.deepEqual(
  wideInventoryRows.rows.filter(row => row.sourceRowNo === 3).map(row => row.normalizedRecord.inventoryQuantity),
  [163, -200, 510, -100],
  '품목코드 한 행의 총재고를 창고별 부호 있는 잔량으로 분리해야 한다.'
);
assert.equal(wideInventoryRows.rows.find(row => row.sourceRowNo === 3).normalizedRecord.inventoryTotal, 373);
assert.equal(wideInventoryRows.rows.find(row => row.sourceRowNo === 4 && row.normalizedRecord.warehouseCode === '02').normalizedRecord.warehouseSourceBlank, true,
  '빈 창고 수량은 산술상 0이지만 원본 공란 여부를 별도로 보존해야 한다.');
assert.equal(wideInventoryRows.discrepancies.length, 0, '총재고는 창고별 잔량 합계와 일치해야 한다.');
assert.equal(
  matrixContextDate([['회사명 : 원앱 / 주문 / 2025/08/13 ~ 2026/08/13']], '미출고현황.xlsx'),
  '2026-08-13',
  'range titles must use the latest date rather than the range start or a partial year match',
);

assert.equal(addBusinessDays('2026-08-14', 1, []), '2026-08-17', 'Friday order should match Monday sale');
assert.equal(addBusinessDays('2026-08-14', 1, ['2026-08-17']), '2026-08-18', 'holiday must be skipped');

const historicalText = await analyzeHistoricalText({
  rawText: '2026년 8월 12일 수요일\n[진주8번] [오전 5:30] 8번 200단',
  sourceId: 'kakao-export',
  defaultDate: '2026-08-12'
});
assert.equal(historicalText.rows.length, 1, 'context-only product expressions must remain collectible');
assert.equal(historicalText.rows[0].rawRecord.line, '8번 200단');
assert.equal(historicalText.rows[0].normalizedRecord.rawExpression, '8번 200단', 'parser rawText is the immutable source expression');

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

const residualInput = {
  orderGroups: [{ historicalOrderGroupId: 'RG1', orderDate: '2026-08-12', customerName: '진주8번', normalizedCustomerName: '진주8번', status: 'ACTIVE' }],
  orderLines: [{ historicalOrderLineId: 'RO1', historicalOrderGroupId: 'RG1', customerName: '진주8번', orderDate: '2026-08-12', productName: '', rawExpression: '8번 200단', quantity: 200, rawUnit: '단' }],
  salesDocuments: [{ salesDocumentId: 'RD1', salesDate: '2026-08-13', customerName: '진주8번' }],
  salesLines: [{ salesLineId: 'RS1', salesDocumentId: 'RD1', productCode: 'P-DAEPA', productName: '대파', quantity: 200, unit: '단' }],
  settings: { cutoffHour: 12, cutoffMinute: 0, holidays: [] }
};
const residualCandidate = buildFulfillmentLinks(residualInput);
const proposedLink = residualCandidate.links.find(row => row.historicalOrderLineId === 'RO1' && row.salesLineId === 'RS1');
assert.equal(proposedLink.status, LINK_STATUS.PROBABLE);
assert.equal(proposedLink.requiresReview, true, 'unknown expressions must be proposed, never auto-confirmed');
assert.equal(residualCandidate.balances[0].remainingQuantity, 200, 'unconfirmed residual candidates must not reduce unfulfilled quantity');
assert.equal(buildParserEvidence({ links: residualCandidate.links, orderLines: residualInput.orderLines, salesLines: residualInput.salesLines }).length, 0, 'review candidates must not train parser evidence');

const residualConfirmed = buildFulfillmentLinks({ ...residualInput, manualLinks: [{ ...proposedLink, manualAction: 'CONFIRM', requestedQuantity: 200 }] });
assert.equal(residualConfirmed.balances[0].netShippedQuantity, 200);
assert.equal(residualConfirmed.balances[0].remainingQuantity, 0, 'administrator confirmation must consume the residual candidate');

const codeConflict = buildFulfillmentLinks({
  orderGroups: [{ historicalOrderGroupId: 'CG1', orderDate: '2026-08-12', customerName: '담솥', normalizedCustomerName: '담솥', status: 'ACTIVE' }],
  orderLines: [{ historicalOrderLineId: 'CO1', historicalOrderGroupId: 'CG1', customerName: '담솥', orderDate: '2026-08-12', productCode: 'ORDER-CODE', productName: '대파', quantity: 2, rawUnit: '단' }],
  salesDocuments: [{ salesDocumentId: 'CD1', salesDate: '2026-08-13', customerName: '담솥' }],
  salesLines: [{ salesLineId: 'CS1', salesDocumentId: 'CD1', productCode: 'SALES-CODE', productName: '대파', quantity: 2, unit: '단' }],
  settings: { cutoffHour: 12, cutoffMinute: 0, holidays: [] }
});
assert.equal(codeConflict.links.some(row => row.historicalOrderLineId === 'CO1' && row.salesLineId === 'CS1'), false, '서로 다른 상품코드는 같은 품명이어도 자동·잔여 연결하면 안 된다.');
assert.equal(codeConflict.balances[0].remainingQuantity, 2, '상품코드 충돌은 미출고 잔량을 차감하면 안 된다.');

const netResult = buildFulfillmentLinks({
  orderGroups: [{ historicalOrderGroupId: 'NG1', orderDate: '2026-08-12', customerName: '담솥', normalizedCustomerName: '담솥', status: 'ACTIVE' }],
  orderLines: [{ historicalOrderLineId: 'NO1', historicalOrderGroupId: 'NG1', customerName: '담솥', productCode: 'P1', productName: '대파', quantity: 10 }],
  salesDocuments: [
    { salesDocumentId: 'ND1', salesDate: '2026-08-13', customerName: '담솥' },
    { salesDocumentId: 'ND2', salesDate: '2026-08-14', customerName: '담솥' }
  ],
  salesLines: [
    { salesLineId: 'NS1', salesDocumentId: 'ND1', productCode: 'P1', productName: '대파', quantity: 10 },
    { salesLineId: 'NS2', salesDocumentId: 'ND2', productCode: 'P1', productName: '대파', quantity: -2 }
  ],
  settings: { cutoffHour: 12, cutoffMinute: 0, holidays: [] }
});
assert.deepEqual(
  [netResult.balances[0].grossShippedQuantity, netResult.balances[0].reversalQuantity, netResult.balances[0].netShippedQuantity, netResult.balances[0].remainingQuantity],
  [10, 2, 8, 2],
  'gross sale 10 and reversal 2 must persist as net shipment 8 and unfulfilled 2'
);

const lifecycleMapping = { mappingId: 'PM1', evidenceType: 'ADMIN_CONFIRMED', evidenceId: 'PE1', itemCode: 'P1', status: MAPPING_STATUS.ACTIVE };
assert.equal(reconcileEvidenceMappings({ mappings: [lifecycleMapping], evidence: [] })[0].status, MAPPING_STATUS.REVIEW_REQUIRED);
assert.equal(reconcileEvidenceMappings({ mappings: [lifecycleMapping], evidence: [{ parserEvidenceId: 'PE1', productCode: 'P1', status: 'ADMIN_CONFIRMED', active: true }] }).length, 0);
assert.equal(deactivateEvidenceMapping(lifecycleMapping, '2026-08-14T00:00:00.000Z', 'pm').status, MAPPING_STATUS.INACTIVE);

const evidenceLinks = [1, 2, 3].map(index => ({
  fulfillmentLinkId: `F${index}`, historicalOrderLineId: `EO${index}`, salesLineId: `ES${index}`,
  status: LINK_STATUS.STRONG, allocatedQuantity: 1, orderDate: `2026-08-${10 + index}`, customerName: '담솥', productCode: 'P1'
}));
const evidenceOrders = [1, 2, 3].map(index => ({ historicalOrderLineId: `EO${index}`, customerName: '담솥', rawExpression: '대파 두단', orderDate: `2026-08-${10 + index}` }));
const evidenceSales = [1, 2, 3].map(index => ({ salesLineId: `ES${index}`, productCode: 'P1', productName: '대파' }));
const evidence = buildParserEvidence({ links: evidenceLinks, orderLines: evidenceOrders, salesLines: evidenceSales });
assert.equal(evidence[0].status, 'READY_FOR_ADMIN_CONFIRMATION');
assert.equal(buildParserEvidence({
  links: [{ ...evidenceLinks[0], fulfillmentLinkId: 'REV-1', allocatedQuantity: -1, method: 'NEGATIVE_SALES_REVERSAL' }],
  orderLines: evidenceOrders,
  salesLines: evidenceSales
}).length, 0, '반품·취소 역분개는 파서사전 근거로 학습하면 안 된다.');

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
assert.match(cloudAdapter, /controller\.abort\(\), 60000/, 'first Apps Script sync must tolerate cold-start sheet creation');
const cloudServer = await readFile(new URL('../orderq-cloud.gs', import.meta.url), 'utf8');
assert.match(cloudServer, /ORDER_TXN_LOG/);
assert.match(cloudServer, /orderQRecoverPendingTransactions/);
assert.match(cloudServer, /FULFILLMENT_BALANCE/);
const candidateGenerator = await readFile(new URL('../orderq/smartparser/candidate-generator.js', import.meta.url), 'utf8');
assert.match(candidateGenerator, /mappingIsActive/);
assert.match(candidateGenerator, /mapping\.status \|\| 'ACTIVE'/, 'SmartParser must ignore inactive mappings while preserving legacy active mappings');
const collectorUi = await readFile(new URL('../orderq/collector-ui.js', import.meta.url), 'utf8');
assert.match(collectorUi, /confirmFulfillmentLink/);
assert.match(collectorUi, /replaceFulfillmentLink/);
assert.match(collectorUi, /unlinkFulfillmentLink/);
assert.match(collectorUi, /cancelParserEvidenceConfirmation/);
const entry = await readFile(new URL('../orderq/index.html', import.meta.url), 'utf8');
assert.match(entry, /collector\.html/);
assert.match(entry, /vNext 0\.5\.1/);

console.log('PASS: ORDER Q history collector, flexible cutoff, fulfillment and evidence contracts');
