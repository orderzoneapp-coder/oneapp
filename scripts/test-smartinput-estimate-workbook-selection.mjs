#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  ERP_ESTIMATE_HEADERS,
  ESTIMATE_REPORT_HEADERS,
  chooseEstimateWorkbookCandidate,
  inspectEstimateWorkbookCandidate,
  isEstimateWorkbookItemRow
} from '../smartinput/input.js';

const distribution = [72, 51, 32, 25, 22, 20, 18, 18, 12, 7];
const rows = [];
distribution.forEach((count, customerIndex) => {
  for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
    rows.push([
      customerIndex < 3 ? '2026/09/02' : '2026/09/05',
      customerIndex === 0 ? '01' : '02',
      `거래처 ${customerIndex + 1}`,
      `품목 ${customerIndex + 1}-${itemIndex + 1}`,
      itemIndex % 2 ? 'EA' : 'BOX',
      `${String(customerIndex + 1).padStart(2, '0')}${String(itemIndex + 1).padStart(7, '0')}`,
      itemIndex === 0 ? '0' : '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
    ]);
  }
});

const fullMatrix = [
  ['회사명 : 원앱 / 1창고 외 1건 / 2026/09/06 (일) 오전 3:38:49 / 2026/09/01 ~ 2026/09/06'],
  [...ERP_ESTIMATE_HEADERS],
  ...rows,
  ['2026/09/06 (일) 오전 3:38:50']
];
const subsetMatrix = [fullMatrix[0], [...ERP_ESTIMATE_HEADERS], ...rows.slice(72)];
const makeCandidate = (sheetName, matrix, score = 23000) => ({
  sheetName,
  matrix,
  detection: { rowIndex: 1, rowNumber: 2, score }
});

const subset = makeCandidate('Sheet1', subsetMatrix);
subset.estimateErpSummary = inspectEstimateWorkbookCandidate(subset, 'estimate');
const full = makeCandidate('견적서현황내역', fullMatrix);
full.estimateErpSummary = inspectEstimateWorkbookCandidate(full, 'estimate');

assert.equal(subset.estimateErpSummary.recognized, true);
assert.equal(subset.estimateErpSummary.itemCount, 205);
assert.equal(subset.estimateErpSummary.customerCount, 9);
assert.equal(full.estimateErpSummary.preferred, true);
assert.equal(full.estimateErpSummary.itemCount, 277);
assert.equal(full.estimateErpSummary.customerCount, 10);
assert.equal(full.estimateErpSummary.sourceRowCount, 280);
assert.equal(full.estimateErpSummary.sourceColumnCount, 23);
assert.equal(isEstimateWorkbookItemRow(fullMatrix.at(-1)), false,
  '생성시각만 있는 마지막 시스템 푸터는 견적 상품행이 아니다.');
assert.equal(isEstimateWorkbookItemRow(fullMatrix[2]), true,
  'A~F 필수값이 모두 있는 실제 품목행은 유지해야 한다.');
assert.equal(chooseEstimateWorkbookCandidate(subset, full, 'estimate')?.sheetName, '견적서현황내역',
  '동일 점수이면 전체 ERP 견적서현황내역 시트를 선택해야 한다.');

assert.equal(chooseEstimateWorkbookCandidate(subset, full, 'order')?.sheetName, 'Sheet1',
  '견적서 이외 모드는 기존 첫 동점 시트 계약을 유지해야 한다.');
const genericFull = makeCandidate('통합자료', fullMatrix);
assert.equal(chooseEstimateWorkbookCandidate(subset, genericFull, 'estimate')?.sheetName, 'Sheet1',
  '정확한 시트명이 아니면 기존 첫 동점 시트 계약을 유지해야 한다.');
const malformedNamed = makeCandidate('견적서현황내역', [fullMatrix[0], ['일자', '창고', '거래처명'], ...rows]);
malformedNamed.estimateErpSummary = inspectEstimateWorkbookCandidate(malformedNamed, 'estimate');
assert.equal(malformedNamed.estimateErpSummary.recognized, false);
assert.equal(chooseEstimateWorkbookCandidate(subset, malformedNamed, 'estimate')?.sheetName, 'Sheet1',
  '정확한 23열 ERP 형식이 아니면 시트명만으로 우선하면 안 된다.');
const extraColumnNamed = makeCandidate('견적서현황내역', [
  fullMatrix[0],
  [...ERP_ESTIMATE_HEADERS, '추가열'],
  ...rows.map(row => [...row, '추가값'])
]);
extraColumnNamed.estimateErpSummary = inspectEstimateWorkbookCandidate(extraColumnNamed, 'estimate');
assert.equal(extraColumnNamed.estimateErpSummary.recognized, false,
  '24번째 이후에 비공란 헤더가 있으면 정확한 ERP 23열 양식으로 승인하면 안 된다.');
assert.equal(chooseEstimateWorkbookCandidate(subset, extraColumnNamed, 'estimate')?.sheetName, 'Sheet1',
  '추가 비공란 열이 있는 동명 시트를 정식 전체 시트로 우선하면 안 된다.');
const strongerGeneric = makeCandidate('일반자료', [['품목코드', '품목명'], ['A', '상품']], 24000);
assert.equal(chooseEstimateWorkbookCandidate(subset, strongerGeneric, 'estimate')?.sheetName, '일반자료',
  'ERP 우선 시트가 없으면 기존 최고 헤더 점수 계약을 유지해야 한다.');

const specDistribution = [71, 51, 30, 25, 22, 20, 19, 18, 12, 7];
const specNames = ['농협', '창창', '가락(고창)', '가락(경복농산)', '초원', '가락(청산유통)', '가락(호진농산)', '남경', '마니', '랑희'];
const specRows = [];
specDistribution.forEach((count, customerIndex) => {
  for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
    specRows.push(ESTIMATE_REPORT_HEADERS.map(header => {
      if (header === '거래처명') return specNames[customerIndex];
      if (header === '품목명') return `${specNames[customerIndex]}-${itemIndex + 1}`;
      if (header === '품목코드') return `C${customerIndex + 1}-${itemIndex + 1}`;
      if (header === '입고가') return itemIndex === 0 ? 0 : 1000;
      if (header === '입고B') return '';
      if (header === '도매B') return 0;
      if (header === '행사가') return itemIndex === 1 ? '26800' : '';
      return header === '일자' ? '2026/09/26' : '';
    }));
  }
});
const specCandidate = {
  sheetName: '견적서현황내역',
  matrix: [['회사명 / 출력일시'], [...ESTIMATE_REPORT_HEADERS], ...specRows, ['2026/09/26 (토) 오후 10:00:00']],
  detection: { rowIndex: 1, rowNumber: 2, score: 24000 }
};
const specSummary = inspectEstimateWorkbookCandidate(specCandidate, 'estimate');
assert.equal(specSummary.recognized, true);
assert.equal(specSummary.preferred, true);
assert.equal(specSummary.customerCount, 10);
assert.equal(specSummary.itemCount, 275);
assert.equal(isEstimateWorkbookItemRow(specCandidate.matrix.at(-1), ESTIMATE_REPORT_HEADERS), false,
  '출력시각 정보행은 품목에서 제외해야 한다.');

console.log('SmartInput ERP estimate workbook selection tests passed.');
