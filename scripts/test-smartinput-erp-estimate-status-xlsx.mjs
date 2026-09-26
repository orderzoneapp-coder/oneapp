#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseEstimateWorkbookCandidate, inspectEstimateWorkbookCandidate } from '../smartinput/input.js';
import { readWorksheetSource } from '../smartinput/xlsx-source-reader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'scripts/fixtures/smartinput-erp-estimate-status.xlsx');
assert.equal(existsSync(fixture), true, '합성 견적서현황.xlsx fixture가 있어야 한다.');

const require = createRequire(import.meta.url);
const XLSX = require(path.join(root, 'customer-master', 'vendor', 'xlsx.full.min.js'));
const workbook = XLSX.read(readFileSync(fixture), { type: 'buffer', cellDates: false, cellText: true, cellNF: true });
assert.ok(workbook.SheetNames.includes('견적서현황내역'), '합성 fixture는 견적서현황내역 시트를 포함해야 한다.');

const candidates = workbook.SheetNames.map(sheetName => {
  const source = readWorksheetSource(XLSX, workbook.Sheets[sheetName]);
  const candidate = {
    sheetName,
    matrix: source.displayMatrix,
    sourceCellMatrix: source.sourceCellMatrix,
    detection: { rowIndex: 1, rowNumber: 2, score: 24000 }
  };
  candidate.estimateErpSummary = inspectEstimateWorkbookCandidate(candidate, 'estimate');
  return candidate;
});
const chosen = candidates.reduce(
  (current, candidate) => chooseEstimateWorkbookCandidate(current, candidate, 'estimate'),
  null
);

assert.equal(chosen?.sheetName, '견적서현황내역');
assert.equal(chosen.estimateErpSummary.recognized, true);
assert.equal(chosen.estimateErpSummary.preferred, true);
assert.equal(chosen.estimateErpSummary.customerCount, 10, '합성 XLSX 거래처는 10곳이어야 한다.');
assert.equal(chosen.estimateErpSummary.itemCount, 275, '합성 XLSX 품목은 275개여야 한다.');
assert.equal(chosen.estimateErpSummary.sourceColumnCount, 24);
assert.ok(chosen.estimateErpSummary.sourceRowCount >= 277);
assert.match(String(chosen.matrix?.[0]?.[0] || ''), /합성|synthetic|운영자료 아님/i,
  'fixture는 운영 원본이 아닌 합성 자료여야 한다.');

const appSource = readFileSync(path.join(root, 'smartinput/smartinput.js'), 'utf8');
assert.match(
  appSource,
  /readWorksheetSource[\s\S]*inspectEstimateWorkbookCandidate[\s\S]*chooseEstimateWorkbookCandidate/,
  '브라우저 handleFile도 같은 xlsx-source-reader 경로로 시트를 선택해야 한다.'
);

console.log('SmartInput synthetic ERP 견적서현황.xlsx parser path recognized 10 customers / 275 items.');
