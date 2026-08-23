import assert from 'node:assert/strict';
import {
  analyzeOcrDocument,
  selectBestOcrAnalysis,
  verifiedRowsToParserLines
} from '../smartinput/ocr-document-parser.js';

const statement = `열무 165 3,800 627,000
열무 180 2,800 504,000
실파 12 3,400 40,800
부추 65 1,800 117,000
얼갈이 85 2,400 204,000
시금치 35 5,400 189,000
깐쪽파 2 16,000 32,000
미나리 45 8,000 360,000
돌산갓 30 2,400 72,000
영양부추 2 5,400 10,800
합계 621 2,156,600`;

const verified = analyzeOcrDocument({ text: statement, confidence: 91, variant: 'contrast' });
assert.equal(verified.status, 'VERIFIED');
assert.equal(verified.validRows.length, 10);
assert.equal(verified.invalidRows.length, 0);
assert.deepEqual(verified.calculatedTotal, { quantity: 621, amount: 2156600 });
assert.deepEqual(verified.detectedTotal && {
  quantity: verified.detectedTotal.quantity,
  amount: verified.detectedTotal.amount
}, { quantity: 621, amount: 2156600 });
assert.equal(verified.totalValid, true);

const parserLines = verifiedRowsToParserLines(verified, 'OCR-BATCH');
assert.equal(parserLines.length, 10);
assert.deepEqual(parserLines[0], {
  rawText: '열무 165 3,800 627,000',
  productText: '열무',
  itemName: '열무',
  quantity: 165,
  unit: '',
  unitPrice: 3800,
  sourceLineNo: 1,
  sourceLineKey: 'OCR-BATCH:OCR:1',
  matchStatus: 'UNRESOLVED',
  ocrAmount: 627000,
  ocrVerified: true
});

const brokenAmount = analyzeOcrDocument({
  text: statement.replace('열무 165 3,800 627,000', '열무 165 3,800 627,900'),
  confidence: 91
});
assert.equal(brokenAmount.status, 'REVIEW_REQUIRED');
assert.equal(brokenAmount.invalidRows.length, 1);
assert.ok(brokenAmount.warnings.includes('AMOUNT_MISMATCH'));
assert.deepEqual(verifiedRowsToParserLines(brokenAmount), [], 'unverified OCR must never create order rows');

const missingTotal = analyzeOcrDocument({ text: statement.split('\n').slice(0, -1).join('\n'), confidence: 91 });
assert.equal(missingTotal.status, 'REVIEW_REQUIRED');
assert.ok(missingTotal.warnings.includes('TOTAL_NOT_FOUND'));

const lowConfidence = analyzeOcrDocument({ text: statement, confidence: 30 });
assert.equal(lowConfidence.status, 'REVIEW_REQUIRED');
assert.ok(lowConfidence.warnings.includes('LOW_CONFIDENCE'));

const tsv = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t92\t열무',
  '5\t1\t1\t1\t1\t2\t120\t10\t30\t20\t93\t165',
  '5\t1\t1\t1\t1\t3\t210\t10\t50\t20\t94\t3,800',
  '5\t1\t1\t1\t1\t4\t320\t10\t70\t20\t95\t627,000',
  '5\t1\t1\t1\t2\t1\t10\t40\t40\t20\t92\t합계',
  '5\t1\t1\t1\t2\t2\t120\t40\t30\t20\t93\t165',
  '5\t1\t1\t1\t2\t3\t320\t40\t70\t20\t95\t627,000'
].join('\n');
const coordinateResult = analyzeOcrDocument({ text: '깨진 순서', tsv, confidence: 93 });
assert.equal(coordinateResult.status, 'VERIFIED', 'TSV coordinates must restore words into table rows before validation');
assert.equal(coordinateResult.validRows[0].itemName, '열무');
assert.equal(coordinateResult.coordinateLines.length, 2);

assert.equal(selectBestOcrAnalysis([brokenAmount, verified]).status, 'VERIFIED');

console.log('SmartInput OCR validation PASS');
