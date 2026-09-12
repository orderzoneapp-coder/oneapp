#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createIndependentEstimateCandidate, hashEstimatePlan } from '../smartinput/independent-estimate.js';
import { buildEstimateF8DraftPlan } from '../smartinput/estimate-f8-source-plan.js';
import { buildEstimateF8Data, buildEstimateF8RowsFromPlan } from '../smartinput/estimate-output.js';

// This validates candidate construction against the existing real F8 algorithms.
// It does NOT pretend the candidate is already wired to production load/save/F8 paths.
const row = (rowId, code, inboundPrice, customerCode) => ({ rowId, itemCode: code, itemName: `상품 ${code}`, specification: '1박스',
  unit: 'box', quantity: 0, inboundPrice, unitPrice: 2000, purchasePriceB: 0, wholesaleA: 0,
  wholesaleB: 2500, promoPrice: 0, rowCustomerCode: customerCode, rowCustomerName: `거래처 ${customerCode}`, memo: '수기', editedFields: {} });
const source = (id, rows) => ({ estimateId: id, companyId: 'C1', estimateKind: 'INDIVIDUAL', createdAt: '2026-09-01', updatedAt: '2026-09-11', sortOrder: 1,
  draft: { documentId: `DOC-${id}`, catalogRecordId: id, estimateKind: 'INDIVIDUAL', header: { customerCode: id, customerName: id }, rows } });
const config = { productCatalog: [{ 코드: '0007', 창고: '01', 단위: 'box' }],
  marginRules: [{ id: 'test', whCode: '*', unit: '*', rate: 20, type: 'divide' }], estimateMappings: {},
  duplicateResolutions: new Map([['0007', { rowIndex: 1, inboundPrice: 1200 }]]) };

let passed = 0;
async function verify(record, individuals) {
  const all = [...individuals, ...(individuals.includes(record) ? [] : [record])];
  const plan = buildEstimateF8DraftPlan({ selectedRecords: [record], allRecords: all, individualRecords: individuals });
  assert.equal(plan.ok, true, plan.error);
  const reportRows = buildEstimateF8RowsFromPlan(plan);
  const before = buildEstimateF8Data(reportRows, config);
  assert.equal(before.errors.length, 0, JSON.stringify(before.errors));
  const snapshotHash = await hashEstimatePlan({ record, individuals });
  const conversion = createIndependentEstimateCandidate({ record, companyId: 'C1', sourcePlan: plan, reportRows,
    migrationId: 'FIXTURE-MIGRATION', snapshotId: 'FIXTURE-SNAPSHOT', snapshotHash });
  assert.equal(conversion.status, 'CANDIDATE_READY');
  const after = buildEstimateF8Data(conversion.candidate.ownedRows, config);
  for (const key of ['shopData', 'erpData', 'estimateUploadData', 'confirmData']) {
    assert.ok(Array.isArray(before[key]), `${key} is a real output array`);
    assert.deepEqual(after[key], before[key], `${key}: values, types, order and all customer rows must be preserved`);
  }
  assert.equal(conversion.candidate.estimateId, record.estimateId);
  assert.deepEqual(conversion.candidate.draft.rows, record.draft.rows);
  assert.equal(conversion.candidate.updatedAt, record.updatedAt);
  return { conversion, before, reportRows };
}

const single = source('EST-A', [row('SAME-ROW-ID', '0007', 1000, '0001')]);
await verify(single, [single]); passed++;
console.log('PASS: real F8 arrays for an ordinary estimate candidate preserve zero and string codes');

const second = source('EST-B', [row('SAME-ROW-ID', '0007', 1200, '0002')]);
const refs = [{ estimateId: single.estimateId, rowId: 'SAME-ROW-ID' }, { estimateId: second.estimateId, rowId: 'SAME-ROW-ID' }];
const linked = { ...source('EST-LINKED', []), estimateKind: 'LINKED_GROUP',
  linkedEstimateSources: [{ estimateId: single.estimateId }, { estimateId: second.estimateId }] };
linked.draft.estimateKind = 'LINKED_GROUP';
linked.draft.linkedEstimateSources = structuredClone(linked.linkedEstimateSources);
linked.draft.rows = [{ ...row('DISPLAY-UNCHANGED', '0007', 9999, ''), linkedSourceEstimateId: single.estimateId,
  linkedSourceRowId: 'SAME-ROW-ID', linkedSourceEstimateIds: [single.estimateId, second.estimateId], linkedSourceRefs: refs },
  row('MANUAL-UNCHANGED', 'MANUAL', 1000, '0099')];
const combined = await verify(linked, [single, second]); passed++;
assert.equal(combined.conversion.candidate.ownedRows.length, 3);
assert.equal(combined.before.estimateUploadData.length, 4, 'header + both customer rows + manual row');
assert.equal(combined.before.shopData.length, 3, 'header + one selected duplicate representative + manual row');
assert.equal(combined.conversion.candidate.displayGroups[0].ownedRowIds.length, 2);
console.log('PASS: real F8 keeps one duplicate representative and every customer/manual transaction');

// Remove the sources from this isolated fixture AFTER candidate construction.
// Direct report-data generation from ownedRows must need no source lookup.
single.draft.rows.length = 0; second.draft.rows.length = 0;
const withoutSources = buildEstimateF8Data(combined.conversion.candidate.ownedRows, config);
assert.deepEqual(withoutSources.estimateUploadData, combined.before.estimateUploadData);
assert.deepEqual(withoutSources.shopData, combined.before.shopData); passed++;
console.log('PASS: candidate report data stays fixed after source changes/removal');
console.log(`Stage 3 candidate/real-F8 baseline comparisons passed (${passed}/${passed}); runtime integration remains separate.`);
