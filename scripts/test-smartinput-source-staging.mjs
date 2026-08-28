import assert from 'node:assert/strict';
import {
  SOURCE_STATUSES,
  STAGED_ROW_STATES,
  activateSource,
  activeSource,
  authorizeDeletedRowsForReapply,
  ensureSourceWorkspace,
  finalizeSourceIdentity,
  markWorkRowsDeleted,
  pendingRowsForSource,
  recordSourceApplications,
  registerProvisionalSource,
  removeSource,
  sourceIdFromBytes,
  sourceIdFromText,
  sourceSummary,
  stageSourceRows,
  typedSourceIdentityBytes,
  visibleSources
} from '../smartinput/source-staging-core.js';

function draft() {
  return ensureSourceWorkspace({ rows: [], batches: [] });
}

async function registerStable(current, text, input = {}) {
  const provisional = registerProvisionalSource(current, {
    kind: input.kind || 'TEXT',
    displayName: input.displayName || '원본',
    previewText: text,
    now: input.now || '2026-08-28T00:00:00.000Z',
    random: input.random ?? 0.1
  });
  const sourceId = await sourceIdFromText(text);
  return finalizeSourceIdentity(current, provisional.sourceId, sourceId, { previewText: text }).source;
}

const rawA = new TextEncoder().encode('사과\t2 BOX');
const rawB = new TextEncoder().encode('사과\t3 BOX');
const sourceIdA = await sourceIdFromBytes(rawA);
assert.match(sourceIdA, /^src:sha256:[0-9a-f]{64}$/);
assert.equal(await sourceIdFromBytes(rawA), sourceIdA, '동일 raw bytes는 동일 sourceId여야 한다');
assert.notEqual(await sourceIdFromBytes(rawB), sourceIdA, '원본 bytes가 다르면 sourceId가 달라야 한다');
assert.equal(
  await sourceIdFromBytes(typedSourceIdentityBytes('TSV', rawA)),
  await sourceIdFromBytes(typedSourceIdentityBytes('TSV', rawA)),
  '같은 Excel 붙여넣기 종류와 raw bytes는 동일 sourceId여야 한다'
);
assert.notEqual(
  await sourceIdFromBytes(typedSourceIdentityBytes('HTML_TABLE', rawA)),
  await sourceIdFromBytes(typedSourceIdentityBytes('TSV', rawA)),
  'Excel 붙여넣기는 HTML/TSV 입력 종류를 raw bytes와 함께 식별해야 한다'
);

const logicalValueDraft = draft();
const logicalValueSource = await registerStable(logicalValueDraft, '사과 2BOX', { displayName: '논리행.txt' });
const logicalValueInitial = await stageSourceRows(logicalValueDraft, logicalValueSource.sourceId, [
  { sourceLineNo: 1, sourceVoucherIndex: 1, itemName: '사과', quantity: 2, unit: 'BOX', rawText: '사과 2BOX' }
], { parserVersion: 'PARSER_LOGICAL_V1' });
recordSourceApplications(logicalValueDraft, logicalValueSource.sourceId, [
  { sourceRowKey: logicalValueInitial[0].sourceRowKey, workRowId: 'LOGICAL-WORK-1' }
]);
const logicalValueChanged = await stageSourceRows(logicalValueDraft, logicalValueSource.sourceId, [
  { sourceLineNo: 1, sourceVoucherIndex: 1, itemName: '사과', quantity: 3, unit: 'BOX', rawText: '사과 3BOX' }
], { parserVersion: 'PARSER_LOGICAL_V2' });
assert.equal(logicalValueChanged[0].state, STAGED_ROW_STATES.PENDING,
  '같은 위치라도 정규화 원본 값 digest가 달라지면 별도 논리행으로 식별해야 한다');

const current = draft();
const sourceA = await registerStable(current, '사과 2BOX', { displayName: '주문.txt' });
const workTableBefore = JSON.stringify(current.rows);
let writerCalls = 0;
const staged = await stageSourceRows(current, sourceA.sourceId, [
  { sourceLineNo: 1, sourceVoucherIndex: 1, itemCode: 'A-1', itemName: '사과', quantity: 2, unit: 'BOX', rawText: '사과 2BOX' },
  { sourceLineNo: 2, sourceVoucherIndex: 1, itemCode: 'B-1', itemName: '배', quantity: 1, unit: 'EA', rawText: '배 1EA' }
], {
  parserVersion: 'PARSER_V1',
  analysisMeta: { batchSeed: { method: 'text' } }
});
assert.equal(JSON.stringify(current.rows), workTableBefore, '분석 완료는 작업테이블을 변경하면 안 된다');
assert.equal(writerCalls, 0, '명시적 추가 전 writer 호출은 0건이어야 한다');
assert.equal(sourceA.status, SOURCE_STATUSES.STAGED);
assert.deepEqual(staged.map(row => row.state), [STAGED_ROW_STATES.PENDING, STAGED_ROW_STATES.PENDING]);

const firstPlan = pendingRowsForSource(current, sourceA.sourceId, [staged[0].sourceRowKey]);
assert.equal(firstPlan.length, 1);
writerCalls += 1;
current.rows.push({ rowId: 'WORK-1', sourceRowKey: firstPlan[0].sourceRowKey, itemName: '사과' });
recordSourceApplications(current, sourceA.sourceId, [{ sourceRowKey: firstPlan[0].sourceRowKey, workRowId: 'WORK-1' }], '2026-08-28T00:01:00.000Z');
assert.equal(sourceA.status, SOURCE_STATUSES.PARTIALLY_APPLIED);
assert.equal(sourceSummary(current, sourceA.sourceId).pending, 1);

const secondPlan = pendingRowsForSource(current, sourceA.sourceId);
current.rows.push({ rowId: 'WORK-2', sourceRowKey: secondPlan[0].sourceRowKey, itemName: '배' });
recordSourceApplications(current, sourceA.sourceId, [{ sourceRowKey: secondPlan[0].sourceRowKey, workRowId: 'WORK-2' }], '2026-08-28T00:02:00.000Z');
assert.equal(sourceA.status, SOURCE_STATUSES.APPLIED);

const reanalysis = await stageSourceRows(current, sourceA.sourceId, [
  { sourceLineNo: 1, sourceVoucherIndex: 1, itemCode: 'A-1-REPARSED', itemName: '사과(재분석)', quantity: 2, unit: 'BOX', rawText: '사과 2BOX' },
  { sourceLineNo: 2, sourceVoucherIndex: 1, itemCode: 'B-1', itemName: '배', quantity: 1, unit: 'EA', rawText: '배 1EA' }
], { parserVersion: 'PARSER_V2' });
assert.equal(sourceA.analysisRevision, 2, '재분석은 revision만 증가해야 한다');
assert.deepEqual(reanalysis.map(row => row.state), [STAGED_ROW_STATES.ALREADY_APPLIED, STAGED_ROW_STATES.ALREADY_APPLIED]);
assert.equal(pendingRowsForSource(current, sourceA.sourceId).length, 0, 'parserVersion 변경도 같은 논리행을 자동 재추가하면 안 된다');
assert.equal(current.rows.length, 2);

markWorkRowsDeleted(current, ['WORK-1'], '2026-08-28T00:03:00.000Z');
current.rows = current.rows.filter(row => row.rowId !== 'WORK-1');
assert.equal(activeSource(current).sourceId, sourceA.sourceId, '작업행 삭제는 원본을 삭제하면 안 된다');
assert.equal(pendingRowsForSource(current, sourceA.sourceId).length, 0, '삭제 행은 자동 복원 대상이 아니어야 한다');
assert.equal(authorizeDeletedRowsForReapply(current, sourceA.sourceId, '2026-08-28T00:04:00.000Z'), 1);
const reapply = pendingRowsForSource(current, sourceA.sourceId);
assert.equal(reapply.length, 1, '명시적 다시 추가 이후에만 삭제 행이 pending이 되어야 한다');
assert.equal(sourceA.status, SOURCE_STATUSES.PARTIALLY_APPLIED, '기존 적용 행과 다시 추가 예정 행이 함께 있으면 일부 추가 상태여야 한다');
const authorizedReanalysis = await stageSourceRows(current, sourceA.sourceId, [
  { sourceLineNo: 1, sourceVoucherIndex: 1, itemCode: 'A-1-V3', itemName: '사과(재재분석)', quantity: 2, unit: 'BOX', rawText: '사과 2BOX' },
  { sourceLineNo: 2, sourceVoucherIndex: 1, itemCode: 'B-1-V3', itemName: '배(재재분석)', quantity: 1, unit: 'EA', rawText: '배 1EA' }
], { parserVersion: 'PARSER_V3' });
assert.deepEqual(authorizedReanalysis.map(row => row.state), [STAGED_ROW_STATES.PENDING, STAGED_ROW_STATES.ALREADY_APPLIED],
  '명시적 재반영 권한은 재분석과 분리되지만 재분석으로 취소되면 안 된다');
const reapplyAfterAnalysis = pendingRowsForSource(current, sourceA.sourceId);
current.rows.push({ rowId: 'WORK-1B', sourceRowKey: reapplyAfterAnalysis[0].sourceRowKey, itemName: '사과' });
recordSourceApplications(current, sourceA.sourceId, [{ sourceRowKey: reapplyAfterAnalysis[0].sourceRowKey, workRowId: 'WORK-1B' }], '2026-08-28T00:05:00.000Z');
assert.equal(current.rows.length, 2);

const sourceB = await registerStable(current, '감 4EA', { displayName: '두번째.txt', random: 0.2 });
assert.equal(activeSource(current).sourceId, sourceB.sourceId, '새 원본은 확인창만 새 원본으로 전환해야 한다');
assert.equal(current.rows.length, 2, '새 원본 등록은 기존 작업행을 변경하면 안 된다');
activateSource(current, sourceA.sourceId);
const rowsBeforeRemoval = JSON.stringify(current.rows);
const ledgerBeforeRemoval = JSON.stringify(current.sourceApplicationLedger);
const removal = removeSource(current, sourceA.sourceId, { now: '2026-08-28T00:06:00.000Z' });
assert.equal(removal.nextSourceId, sourceB.sourceId);
assert.equal(JSON.stringify(current.rows), rowsBeforeRemoval, '원본 제거는 작업행을 건드리면 안 된다');
assert.equal(JSON.stringify(current.sourceApplicationLedger), ledgerBeforeRemoval, '원본 제거 후에도 ledger를 유지해야 한다');
assert.equal(visibleSources(current).length, 1);

const duplicateProvisional = registerProvisionalSource(current, { kind: 'TEXT', displayName: '이름만 다름', previewText: '감 4EA', random: 0.3 });
const duplicate = finalizeSourceIdentity(current, duplicateProvisional.sourceId, sourceB.sourceId);
assert.equal(duplicate.duplicate, true);
assert.equal(visibleSources(current).length, 1, '같은 raw bytes 원본은 복제 항목을 만들면 안 된다');

const restored = ensureSourceWorkspace(JSON.parse(JSON.stringify(current)));
assert.equal(restored.activeSourceId, sourceB.sourceId);
assert.equal(restored.sourceApplicationLedger.length, current.sourceApplicationLedger.length);
assert.equal(restored.stagedSourceRows.length, current.stagedSourceRows.length);

for (const mode of ['order', 'purchase', 'sale', 'estimate']) {
  for (const kind of ['EXCEL_FILE', 'EXCEL_PASTE']) {
    const modeDraft = draft();
    const source = await registerStable(modeDraft, `${mode}:${kind}`, { kind, displayName: `${mode}-${kind}` });
    const before = JSON.stringify(modeDraft.rows);
    const rows = await stageSourceRows(modeDraft, source.sourceId, [{ sourceLineNo: 1, itemCode: `${mode}-1`, itemName: mode, quantity: 0, unitPrice: 0 }], { parserVersion: 'MATRIX_V1' });
    assert.equal(JSON.stringify(modeDraft.rows), before, `${mode}/${kind} 분석은 작업테이블을 변경하면 안 된다`);
    assert.equal(rows[0].state, STAGED_ROW_STATES.PENDING);
  }
}

console.log('SmartInput source staging/ledger tests: PASS');
