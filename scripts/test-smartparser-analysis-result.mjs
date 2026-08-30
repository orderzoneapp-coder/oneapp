#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION,
  createProductChangeRequestsFromAnalysis,
  createSmartParserAnalysisResult,
  smartParserAnalysisPayloadHash,
  validateSmartParserAnalysisResult,
} from '../smartparser/analysis-result-contract.js';

const baseSnapshot = {
  schemaVersion: 'ONEAPP_PRODUCT_SNAPSHOT_V1',
  snapshotId: 'PRODUCT-rev-17-abcdef012345',
  revision: 'rev-17',
  status: 'READY',
};

const row = {
  rowId: 'row-existing',
  parsedFields: {
    품목명: { value: '검토 상품', originalKind: 'VALUE' },
    규격: { value: '', originalKind: 'BLANK' },
    입고가: { value: 0, originalKind: 'ZERO' },
    미제공: { value: undefined, originalKind: 'MISSING' },
  },
  match: { status: '🟢 일치', productCode: ' P-001 ', normalizedProductCode: 'P001', isNewProduct: false, candidates: [] },
  pricePreview: { 입고가: 0, 기존입고가: 1000 },
  ruleEvidence: { ruleId: 'exact-01-box', matchType: 'exact' },
  issues: { ZERO_PRICE: true, SOLD_OUT: true },
  stopRecommendation: true,
  proposedChanges: [{ field: '카탈로그', beforeValue: '기존', proposedValue: '기존, 신규', reason: '검토 카탈로그 연결' }],
  decision: { selected: true, excluded: false, blocked: false },
};

const create = (identity, rows = [row]) => createSmartParserAnalysisResult({
  analysisId: identity.analysisId,
  idempotencyKey: identity.idempotencyKey,
  createdAt: identity.createdAt,
  sourceMetadata: { catalog: '신규', documentDisplayName: '신규', catalogWarehouse: '01', updateTextData: true },
  baseProductSnapshot: baseSnapshot,
  rows,
});

const first = create({ analysisId: 'AN-1', idempotencyKey: 'IDEM-1', createdAt: '2026-08-30T01:02:03.000Z' });
const second = create({ analysisId: 'AN-2', idempotencyKey: 'IDEM-2', createdAt: '2026-08-30T02:03:04.000Z' });

assert.equal(first.schemaVersion, SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION);
assert.equal(first.validation.valid, true);
assert.equal(first.rows[0].parsedFields.규격.originalKind, 'BLANK');
assert.equal(first.rows[0].parsedFields.입고가.originalKind, 'ZERO');
assert.equal(first.rows[0].parsedFields.미제공.originalKind, 'MISSING');
assert.equal(first.rows[0].issues.ZERO_PRICE, true);
assert.equal(first.rows[0].stopRecommendation, true);
assert.equal(first.rows[0].proposedChanges.some((change) => change.field === '판매여부'), false, 'analysis recommendation must not create an automatic stop proposal');
assert.deepEqual(first.rows, second.rows, 'identity fields must not affect business rows');
assert.deepEqual(first.summary, second.summary, 'identity fields must not affect summary');
assert.equal(await smartParserAnalysisPayloadHash(first), await smartParserAnalysisPayloadHash(second), 'payload hash must ignore envelope identity');
assert.ok(Object.isFrozen(first) && Object.isFrozen(first.rows) && Object.isFrozen(first.rows[0]) && Object.isFrozen(first.rows[0].parsedFields));
assert.throws(() => { first.rows[0].match.productCode = 'MUTATED'; }, TypeError);

const request = createProductChangeRequestsFromAnalysis(first, {
  requestedAt: '2026-08-30T03:00:00.000Z',
  actor: { actorState: 'UNVERIFIED_LOCAL' },
})[0];
assert.equal(request.operation, 'UPDATE');
assert.equal(request.baseSnapshotId, baseSnapshot.snapshotId);
assert.equal(request.baseRevision, baseSnapshot.revision);
assert.deepEqual(request.changes, first.rows[0].proposedChanges);
assert.equal(request.source.analysisId, first.analysisId);

const newProduct = create({ analysisId: 'AN-NEW', idempotencyKey: 'IDEM-NEW', createdAt: '2026-08-30T04:00:00.000Z' }, [{
  ...row,
  rowId: 'row-new',
  match: { ...row.match, productCode: 'N-001', normalizedProductCode: 'N001', isNewProduct: true },
  proposedChanges: [
    { field: '코드', beforeValue: '', proposedValue: 'N-001', reason: '검토 신규 코드' },
    { field: '품목명', beforeValue: '', proposedValue: '신규 상품', reason: '검토 신규 품명' },
  ],
}]);
assert.equal(createProductChangeRequestsFromAnalysis(newProduct)[0].operation, 'CREATE');

const duplicated = create({ analysisId: 'AN-DUP', idempotencyKey: 'IDEM-DUP', createdAt: '2026-08-30T05:00:00.000Z' }, [
  row,
  { ...row, rowId: 'row-duplicate', match: { ...row.match, productCode: 'P 001', normalizedProductCode: 'P001' } },
]);
assert.equal(duplicated.validation.valid, false);
assert.ok(duplicated.validation.errors.some((error) => error.code === 'DUPLICATE_SELECTED_PRODUCT_CODE'));
assert.throws(() => createProductChangeRequestsFromAnalysis(duplicated), /NOT_SUBMITTABLE/);

const externallyExtended = JSON.parse(JSON.stringify(first));
externallyExtended.rows[0].unexpectedSecret = 'blocked';
assert.ok(validateSmartParserAnalysisResult(externallyExtended).errors.some((error) => error.code === 'UNKNOWN_FIELD'));

const errorSnapshot = createSmartParserAnalysisResult({
  analysisId: 'AN-ERROR',
  idempotencyKey: 'IDEM-ERROR',
  createdAt: '2026-08-30T06:00:00.000Z',
  baseProductSnapshot: { ...baseSnapshot, status: 'ERROR' },
  rows: [row],
});
assert.equal(errorSnapshot.validation.valid, false);
assert.ok(errorSnapshot.validation.errors.some((error) => error.code === 'BASE_SNAPSHOT_NOT_SUBMITTABLE'));

console.log('PASS test-smartparser-analysis-result');
