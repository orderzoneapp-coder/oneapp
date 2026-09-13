#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createIndependentEstimateCandidate, createSelectedEstimateUpdatePlan, createEstimateSourceIndex,
  estimateDirectRowKey, hashEstimatePlan, validateIndependentEstimate, INDEPENDENT_ESTIMATE_SCHEMA, DIRECT_ROW_MAPPING_TYPE, DIRECT_ROW_KEY_VERSION }
  from '../smartinput/independent-estimate.js';
import { createEstimateMasterIntent, executeEstimateMasterIntent, resumeEstimateMasterPublication }
  from '../smartinput/estimate-master-apply.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const copy = value => structuredClone(value);
const identity = code => ({ productId: '', productCode: code, customerId: 'CUST-01', customerCode: '0001', unit: 'box', pack: '', specification: 'spec', priceConditionKey: '' });
const row = (id, code, value = 10) => ({ rowId: id, ownedRowId: id, itemCode: code, purchasePriceB: value,
  wholesaleA: 20, memo: 'manual memo', matchIdentity: identity(code) });
const estimate = (id = 'EST-A', rows = [row('R1', '0007')]) => ({ estimateId: id, companyId: 'C1', dataRevision: 1,
  schemaVersion: INDEPENDENT_ESTIMATE_SCHEMA, estimateKind: 'INDIVIDUAL',
  catalogName: id, createdAt: '2026-08-01', updatedAt: '2026-09-01',
  ownedRows: copy(rows), displayGroups: rows.map(row => ({ rowId: row.rowId, ownedRowIds: [row.ownedRowId], visible: true })),
  draft: { documentId: `DOC-${id}`, catalogRecordId: id, rows: copy(rows) } });
const value = number => ({ kind: 'VALUE', reviewed: true, rawValue: String(number), parsedValue: number, cellType: 'n', displayValue: String(number) });
const inputRow = (code = '0007', values = { purchasePriceB: value(0) }, sourceRef = 'Sheet1!N2') => ({ identity: identity(code), sourceRef, values });
const basePlan = (extra = {}) => ({ operationId: 'OP-1', companyId: 'C1', actor: { actorId: 'A1' },
  selectedEstimateIds: ['EST-A'], estimates: [estimate()], sourceIndex: createEstimateSourceIndex({ companyId: 'C1', rows: [inputRow()] }),
  templateId: 'T1', templateRevision: 1, templateSignature: 'SIG1', mappingRevision: 1, fileGeneration: 3,
  fileFingerprint: 'FILE1', sourceDocumentId: 'UPLOAD1', sourceRevision: 1, allowedFieldIds: ['purchasePriceB'], ...extra });
const migrationArgs = record => ({ record, companyId: 'C1', migrationId: 'M1', snapshotId: 'SNAP1', snapshotHash: 'FIXED-HASH',
  sourcePlan: { ok: true, entries: [{ kind: 'DIRECT', recordId: record.estimateId, draft: copy(record.draft) }] }, reportRows: copy(record.draft.rows) });
const legacy = () => ({ estimateId: 'LEGACY-1', companyId: 'C1', estimateKind: 'INDIVIDUAL', updatedAt: 'OLD', createdAt: 'FIRST', sortOrder: 9,
  previousPrices: { 'CODE:0007': 0 }, draft: { documentId: 'OLD-DOC', catalogRecordId: 'LEGACY-1', rows: [{ rowId: 'R1', itemCode: '0007', quantity: 0, memo: '수기', customValues: { text: '001' } }] } });

test('independent candidate preserves IDs, zero, text, metadata and input without authorizing a write', () => {
  const record = legacy(); const before = copy(record);
  const result = createIndependentEstimateCandidate(migrationArgs(record));
  assert.equal(result.status, 'CANDIDATE_READY'); assert.equal(result.requiresOutputVerification, true);
  assert.equal(result.candidate.estimateId, record.estimateId);
  assert.equal(result.candidate.draft.documentId, 'OLD-DOC');
  assert.equal(result.candidate.ownedRows[0].ownedRowId, 'R1');
  assert.equal(result.candidate.ownedRows[0].quantity, 0);
  assert.equal(result.candidate.ownedRows[0].customValues.text, '001');
  assert.equal(result.candidate.updatedAt, 'OLD'); assert.equal(result.candidate.createdAt, 'FIRST');
  assert.deepEqual(record, before); assert.equal(Object.isFrozen(result.candidate.ownedRows), true);
  assert.deepEqual(createIndependentEstimateCandidate(migrationArgs(record)), result);
});

test('linked candidate retains both customer transactions, visible representative and manual row', () => {
  const record = { ...legacy(), estimateKind: 'LINKED_GROUP', linkedEstimateSources: [{ estimateId: 'S1' }, { estimateId: 'S2' }],
    draft: { documentId: 'OLD-DOC', catalogRecordId: 'LEGACY-1', estimateKind: 'LINKED_GROUP', rows: [
      { rowId: 'DISPLAY', itemCode: '0007', linkedSourceRefs: [{ estimateId: 'S1', rowId: 'same-row' }, { estimateId: 'S2', rowId: 'same-row' }] },
      { rowId: 'MANUAL', itemCode: 'X', memo: '수기' }] } };
  const reportRows = [
    { rowId: 'same-row', itemCode: '0007', rowCustomerCode: 'C1', unitPrice: 1, linkedSourceEstimateId: 'S1', linkedSourceRowId: 'same-row' },
    { rowId: 'same-row', itemCode: '0007', rowCustomerCode: 'C2', unitPrice: 2, linkedSourceEstimateId: 'S2', linkedSourceRowId: 'same-row' },
    { rowId: 'MANUAL', itemCode: 'X', memo: '수기' }];
  const result = createIndependentEstimateCandidate({ ...migrationArgs(record), sourcePlan: { ok: true, entries: [{ kind: 'DERIVED', recordId: record.estimateId, workingDraft: copy(record.draft) }] }, reportRows });
  assert.equal(result.candidate.ownedRows.length, 3);
  assert.equal(new Set(result.candidate.ownedRows.map(row => row.ownedRowId)).size, 3);
  assert.equal(result.candidate.displayGroups[0].rowId, 'DISPLAY');
  assert.equal(result.candidate.displayGroups[0].ownedRowIds.length, 2);
  assert.deepEqual(result.candidate.ownedRows.map(row => row.unitPrice ?? row.memo), [1, 2, '수기']);
  assert.equal(validateIndependentEstimate(result.candidate), true);
});

test('unknown company, incomplete F8 and unsaved evidence cannot silently migrate', () => {
  const record = legacy(); delete record.companyId;
  assert.equal(createIndependentEstimateCandidate(migrationArgs(record)).status, 'REVIEW_REQUIRED');
  record.companyId = 'C1';
  assert.equal(createIndependentEstimateCandidate({ ...migrationArgs(record), sourcePlan: { ok: false } }).status, 'REVIEW_REQUIRED');
  const input = migrationArgs(record); input.sourcePlan.entries[0].draft.rows[0].quantity = 42;
  assert.throws(() => createIndependentEstimateCandidate(input), /ESTIMATE_UNSAVED_MIGRATION_EVIDENCE/);
  assert.throws(() => createIndependentEstimateCandidate({ ...migrationArgs(record), reportRows: [record.draft.rows[0], record.draft.rows[0]] }), /COLLISION/);
});

test('damaged independent marker is not mistaken for a completed conversion', () => {
  const record = { ...legacy(), schemaVersion: INDEPENDENT_ESTIMATE_SCHEMA };
  assert.throws(() => createIndependentEstimateCandidate(migrationArgs(record)), /SHAPE_INVALID/);
});

test('empty selection has no target or source lookup; exact codes never collapse', async () => {
  const plan = await createSelectedEstimateUpdatePlan({ operationId: 'OP', companyId: 'C1', actor: { actorId: 'A1' } });
  assert.deepEqual(plan.targets, []); assert.equal(plan.status, 'EMPTY');
  assert.notEqual(estimateDirectRowKey('C1', identity('0007')), estimateDirectRowKey('C1', identity('7')));
  assert.notEqual(estimateDirectRowKey('C1', identity('a')), estimateDirectRowKey('C1', identity('A')));
  assert.notEqual(estimateDirectRowKey('C1', identity('Ａ')), estimateDirectRowKey('C1', identity('A')));
  assert.notEqual(estimateDirectRowKey('C1', identity('A B')), estimateDirectRowKey('C1', identity('AB')));
});

test('only selected estimates receive planned patches and all original records remain unchanged', async () => {
  const records = [estimate(), estimate('EST-B')]; const before = copy(records);
  const plan = await createSelectedEstimateUpdatePlan(basePlan({ estimates: records }));
  assert.deepEqual(plan.targets.map(target => target.estimateId), ['EST-A']);
  assert.equal(plan.targets[0].rowPatches[0].afterValue, 0);
  assert.deepEqual(records, before); assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.payloadHash.length, 64);
  assert.throws(() => plan.targets.push({ estimateId: 'EST-B' }), TypeError);
});

test('omitted rows, new rows and unselected exact-code variants are not added or removed', async () => {
  const record = estimate('EST-A', [row('R1', '0007'), row('R2', 'OTHER'), row('R3', '7')]);
  const sourceIndex = createEstimateSourceIndex({ companyId: 'C1', rows: [inputRow('0007'), inputRow('NEW')] });
  const plan = await createSelectedEstimateUpdatePlan(basePlan({ estimates: [record], sourceIndex }));
  assert.deepEqual(plan.targets[0].rowPatches.map(patch => patch.ownedRowId), ['R1']);
  assert.equal(record.ownedRows.length, 3);
});

test('blank preserves; zero applies; explicit clear is separate and unauthorized clear is reviewed', async () => {
  for (const [envelope, clears, count, kind] of [[{ kind: 'BLANK' }, [], 0], [value(0), [], 1, 'VALUE'],
    [{ kind: 'CLEAR', reviewed: true }, [], 0], [{ kind: 'CLEAR', reviewed: true }, ['purchasePriceB'], 1, 'CLEAR']]) {
    const plan = await createSelectedEstimateUpdatePlan(basePlan({ explicitClears: clears, sourceIndex: createEstimateSourceIndex({ companyId: 'C1', rows: [inputRow('0007', { purchasePriceB: envelope })] }) }));
    assert.equal(plan.targets[0].rowPatches.length, count);
    if (count) assert.equal(plan.targets[0].rowPatches[0].valueKind, kind);
  }
});

test('conflicting duplicate file fields isolate only the affected field', async () => {
  const sourceIndex = createEstimateSourceIndex({ companyId: 'C1', rows: [inputRow('0007', { purchasePriceB: value(1), wholesaleA: value(25) }), inputRow('0007', { purchasePriceB: value(2), wholesaleA: value(25) }, 'Sheet1!N3')] });
  const plan = await createSelectedEstimateUpdatePlan(basePlan({ sourceIndex, allowedFieldIds: ['purchasePriceB', 'wholesaleA'] }));
  assert.equal(plan.targets[0].status, 'PARTIAL_REVIEW');
  assert.deepEqual(plan.targets[0].rowPatches.map(patch => patch.field), ['wholesaleA']);
  assert.equal(plan.targets[0].rowPatches[0].sourceRefs.length, 2);
});

test('multiple target rows require a scoped confirmed mapping; stale mapping never falls through', async () => {
  const record = estimate('EST-A', [row('R1', '0007'), row('R2', '0007')]);
  let plan = await createSelectedEstimateUpdatePlan(basePlan({ estimates: [record] }));
  assert.equal(plan.targets[0].rowPatches.length, 0);
  const mapping = { mappingType: DIRECT_ROW_MAPPING_TYPE, companyId: 'C1', targetEstimateId: 'EST-A', sourceKey: estimateDirectRowKey('C1', identity('0007')),
    keyVersion: DIRECT_ROW_KEY_VERSION, templateId: 'T1', templateRevision: 1, templateSignature: 'SIG1', mappingRevision: 1, confirmedBy: 'A1', confirmedAt: '2026-09-13', ownedRowIds: ['R1', 'R2'] };
  plan = await createSelectedEstimateUpdatePlan(basePlan({ estimates: [record], confirmedMappings: [mapping] }));
  assert.equal(plan.targets[0].rowPatches.length, 2); assert.equal(plan.targets[0].mappingPatches.length, 0);
  plan = await createSelectedEstimateUpdatePlan(basePlan({ estimates: [record], confirmedMappings: [{ ...mapping, templateRevision: 0 }] }));
  assert.equal(plan.targets[0].rowPatches.length, 0); assert.equal(plan.targets[0].issues[0].code, 'ESTIMATE_MAPPING_STALE');
});

test('three-way conflict preserves unsaved fields; unrelated memo is never promoted to storage', async () => {
  const working = { ownedRows: [row('R1', '0007', 30)] };
  let plan = await createSelectedEstimateUpdatePlan(basePlan({ workingDrafts: { 'EST-A': working }, workingRevisions: { 'EST-A': 7 } }));
  assert.equal(plan.targets[0].status, 'REVIEW_REQUIRED'); assert.equal(plan.targets[0].rowPatches.length, 0);
  working.ownedRows[0].purchasePriceB = 10; working.ownedRows[0].memo = '새 미저장 메모';
  plan = await createSelectedEstimateUpdatePlan(basePlan({ workingDrafts: { 'EST-A': working }, workingRevisions: { 'EST-A': 8 } }));
  assert.equal(plan.targets[0].rowPatches.length, 1); assert.equal(plan.targets[0].rowPatches[0].field, 'purchasePriceB');
  assert.equal(plan.targets[0].capturedWorkingRevision, 8); assert.equal(working.ownedRows[0].memo, '새 미저장 메모');
  plan = await createSelectedEstimateUpdatePlan(basePlan({ workingDrafts: { 'EST-A': { ownedRows: [] } }, workingRevisions: { 'EST-A': 9 } }));
  assert.equal(plan.targets[0].rowPatches.length, 0); assert.equal(plan.targets[0].issues[0].code, 'ESTIMATE_WORKING_ROW_DELETED');
});

test('unknown load state and invalid source identity remain explicit review states', async () => {
  const plan = await createSelectedEstimateUpdatePlan(basePlan({ estimates: [] }));
  assert.equal(plan.targets[0].status, 'REVIEW_REQUIRED'); assert.equal(plan.targets[0].issues[0].code, 'ESTIMATE_NOT_LOADED');
  const sourceIndex = createEstimateSourceIndex({ companyId: 'C1', rows: [{ identity: {}, sourceRef: 'S!A1' }] });
  const invalid = await createSelectedEstimateUpdatePlan(basePlan({ sourceIndex }));
  assert.equal(invalid.targets[0].status, 'REVIEW_REQUIRED');
});

const masterSource = (extra = {}) => ({ companyId: 'C1', estimateId: 'EST-A', ownedRowId: 'R1', estimateRevision: 2,
  operationId: 'OP-1', estimateStatus: 'SAVED', code: '0007', field: 'purchasePriceB', valueKind: 'VALUE', value: 0, sourceRefs: ['Sheet1!N2'], ...extra });
const masterArgs = (extra = {}) => ({ enabled: true, commandId: 'CMD-1', operationId: 'OP-1', companyId: 'C1', actor: { actorId: 'A1', actorState: 'OWNER_MASTER' },
  reason: '명시 선택 견적 가격 적용', baseSnapshotId: 'MASTER-SNAP', baseContentHash: 'MASTER-HASH', expectedRevision: 5,
  selectedEstimateIds: ['EST-A'], selectedFields: ['purchasePriceB'], products: [{ 코드: '0007', 입고B: 10 }], confirmedFields: [masterSource()], ...extra });
const resultFor = (command, status, extra = {}) => ({ status, commandId: command.commandId, companyId: command.companyId, payloadHash: command.payloadHash, ...extra });
const persisted = command => ({ ...resultFor(command, 'PREPARED'), durable: true });

test('master OFF never validates context, hashes, persists or invokes owner', async () => {
  const intent = await createEstimateMasterIntent();
  const result = await executeEstimateMasterIntent({ intent, persistIntent: () => assert.fail('no persistence'), owner: new Proxy({}, { get: () => assert.fail('no owner') }) });
  assert.equal(result.status, 'DISABLED');
});

test('master context is never invented; four-field allowlist excludes general price and registration', async () => {
  assert.equal((await createEstimateMasterIntent(masterArgs({ actor: null }))).status, 'CONTEXT_REQUIRED');
  await assert.rejects(createEstimateMasterIntent(masterArgs({ selectedFields: ['unitPrice'] })), /MASTER_FIELD_NOT_ALLOWED/);
  const intent = await createEstimateMasterIntent(masterArgs());
  assert.equal(intent.command.patches[0].field, '입고B'); assert.equal(intent.command.patches[0].afterValue, 0);
  assert.equal(intent.command.expectedRevision, 5); assert.equal(intent.command.sourceAppId, 'smart-input');
});

test('master excludes unsuccessful estimates and conflicting field values, not unrelated safe fields', async () => {
  const intent = await createEstimateMasterIntent(masterArgs({ selectedEstimateIds: ['EST-A', 'EST-B', 'FAILED'], selectedFields: ['purchasePriceB', 'wholesaleA'], confirmedFields: [masterSource(), masterSource({ estimateId: 'EST-B', value: 9 }), masterSource({ estimateId: 'FAILED', estimateStatus: 'FAILED', field: 'wholesaleA', value: 100 }), masterSource({ field: 'wholesaleA', value: 25 })] }));
  assert.equal(intent.status, 'PARTIAL_REVIEW'); assert.deepEqual(intent.command.patches.map(patch => patch.field), ['도매A']);
  assert.equal(intent.command.sourceEstimates.some(source => source.estimateId === 'FAILED'), false);
});

test('master intent write failure and missing durable acknowledgement prevent owner writes', async () => {
  const intent = await createEstimateMasterIntent(masterArgs()); let writes = 0;
  const owner = { commitReviewedSmartInputEstimate: async () => { writes++; }, getSmartInputEstimateCommandResult: async () => {} };
  let result = await executeEstimateMasterIntent({ intent, owner, persistIntent: async () => { throw new Error('QUOTA'); } });
  assert.equal(result.status, 'NOT_DISPATCHED');
  result = await executeEstimateMasterIntent({ intent, owner, persistIntent: async () => ({ durable: false }) });
  assert.equal(result.status, 'NOT_DISPATCHED'); assert.equal(writes, 0);
});

test('entire immutable master command becomes durable before dispatch', async () => {
  const intent = await createEstimateMasterIntent(masterArgs()); const calls = [];
  const result = await executeEstimateMasterIntent({ intent, persistIntent: async stored => {
    assert.deepEqual(stored.command, intent.command); assert.equal(Object.isFrozen(stored.command), true); calls.push('persist'); return persisted(stored.command);
  }, owner: { getSmartInputEstimateCommandResult: async () => assert.fail('initial dispatch'), commitReviewedSmartInputEstimate: async command => { calls.push('owner'); return resultFor(command, 'APPLIED', { publicationPending: true }); } } });
  assert.deepEqual(calls, ['persist', 'owner']); assert.equal(result.status, 'APPLIED'); assert.equal(result.publicationPending, true);
});

test('unknown master result reuses the same command and queries a durable receipt before any retry', async () => {
  const intent = await createEstimateMasterIntent(masterArgs()); let writes = 0; let queries = 0;
  const owner = { commitReviewedSmartInputEstimate: async () => { writes++; throw new Error('CONNECTION_LOST_AFTER_COMMIT'); },
    getSmartInputEstimateCommandResult: async args => { queries++; assert.equal(args.commandId, 'CMD-1'); return resultFor(intent.command, 'APPLIED'); } };
  let result = await executeEstimateMasterIntent({ intent, owner, persistIntent: async () => persisted(intent.command) });
  assert.equal(result.status, 'RESULT_UNKNOWN');
  result = await executeEstimateMasterIntent({ intent, owner, resume: true, persistIntent: async () => persisted(intent.command) });
  assert.equal(result.status, 'APPLIED'); assert.equal(writes, 1); assert.equal(queries, 1);
});

test('lookup error or pending command never means confirmed non-application', async () => {
  const intent = await createEstimateMasterIntent(masterArgs()); let writes = 0;
  const owner = { commitReviewedSmartInputEstimate: async () => { writes++; }, getSmartInputEstimateCommandResult: async () => { throw new Error('READ_FAILED'); } };
  let result = await executeEstimateMasterIntent({ intent, owner, resume: true, persistIntent: async () => persisted(intent.command) });
  assert.equal(result.status, 'RESULT_UNKNOWN');
  owner.getSmartInputEstimateCommandResult = async () => resultFor(intent.command, 'PENDING');
  result = await executeEstimateMasterIntent({ intent, owner, resume: true, persistIntent: async () => persisted(intent.command) });
  assert.equal(result.status, 'RESULT_UNKNOWN'); assert.equal(writes, 0);
});

test('recovered intent queries even without a resume flag, including terminal UNCHANGED receipt', async () => {
  const intent = await createEstimateMasterIntent(masterArgs()); let queries = 0;
  const result = await executeEstimateMasterIntent({ intent, persistIntent: async () => ({ ...persisted(intent.command), existing: true }), owner: {
    commitReviewedSmartInputEstimate: async () => assert.fail('never reapply after later product change'),
    getSmartInputEstimateCommandResult: async () => { queries++; return resultFor(intent.command, 'UNCHANGED'); } } });
  assert.equal(result.status, 'UNCHANGED'); assert.equal(queries, 1);
});

test('confirmed non-application retries the identical payload, changed hash is refused before persistence', async () => {
  const intent = await createEstimateMasterIntent(masterArgs()); let writes = 0;
  const owner = { commitReviewedSmartInputEstimate: async command => { writes++; assert.deepEqual(command, intent.command); return resultFor(command, 'APPLIED'); },
    getSmartInputEstimateCommandResult: async () => resultFor(intent.command, 'CONFIRMED_NOT_APPLIED') };
  assert.equal((await executeEstimateMasterIntent({ intent, owner, resume: true, persistIntent: async () => persisted(intent.command) })).status, 'APPLIED');
  const changed = copy(intent); changed.command.patches[0].afterValue = 999;
  await assert.rejects(executeEstimateMasterIntent({ intent: changed, owner, persistIntent: () => assert.fail('do not persist') }), /MASTER_PAYLOAD_HASH_MISMATCH/);
  assert.equal(writes, 1);
});

test('publication retry invokes only publication, never master commit or estimate storage', async () => {
  const intent = await createEstimateMasterIntent(masterArgs());
  const result = await resumeEstimateMasterPublication({ intent, owner: { commitReviewedSmartInputEstimate: () => assert.fail('no product write'),
    resumeSmartInputEstimateCommandPublication: async args => { assert.equal(args.commandId, 'CMD-1'); return resultFor(intent.command, 'APPLIED', { publicationPending: false }); } } });
  assert.equal(result.status, 'APPLIED'); assert.equal(result.publicationPending, false);
});

test('hashes preserve JSON distinctions and reject dates, sparse arrays and cycles instead of colliding', async () => {
  assert.notEqual(await hashEstimatePlan({ value: 0 }), await hashEstimatePlan({ value: '0' }));
  assert.equal(await hashEstimatePlan({ a: 1, b: 2 }), await hashEstimatePlan({ b: 2, a: 1 }));
  await assert.rejects(hashEstimatePlan({ value: new Date() }), /ESTIMATE_NON_JSON_VALUE/);
  await assert.rejects(hashEstimatePlan(new Array(1)), /ESTIMATE_NON_JSON_VALUE/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(hashEstimatePlan(cyclic), /ESTIMATE_CYCLIC_VALUE/);
});

test('master review preserves the issue code separately from the exact product code', async () => {
  const conflict = await createEstimateMasterIntent(masterArgs({ selectedEstimateIds: ['EST-A', 'EST-B'],
    confirmedFields: [masterSource(), masterSource({ estimateId: 'EST-B', value: 25 })] }));
  assert.equal(conflict.command, null);
  assert.equal(conflict.issues[0].code, 'MASTER_FIELD_VALUE_CONFLICT');
  assert.equal(conflict.issues[0].productCode, '0007');
  const missing = await createEstimateMasterIntent(masterArgs({ products: [] }));
  assert.equal(missing.issues[0].code, 'MASTER_PRODUCT_UNRESOLVED');
  assert.equal(missing.issues[0].productCode, '0007');
});
test('master zero selection does not inspect context or source and rejects a selected-outside source', async () => {
  const empty = await createEstimateMasterIntent(masterArgs({ selectedEstimateIds: [], actor: null }));
  assert.equal(empty.status, 'NO_CANDIDATES'); assert.equal(empty.command, null);
  await assert.rejects(createEstimateMasterIntent(masterArgs({ confirmedFields: [masterSource({ estimateId: 'EST-B' })] })), /MASTER_SOURCE_OUTSIDE_SELECTION/);
});

let failures = 0;
for (const [name, run] of tests) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.error(`FAIL: ${name}\n${error.stack}`); }
}
assert.equal(failures, 0, `${failures} Stage 3 planning regression(s)`);
console.log(`Stage 3 pure planning and injected dispatch tests passed (${tests.length}/${tests.length}).`);
