import { INDEPENDENT_ESTIMATE_SCHEMA, createIndependentEstimateCandidate, estimateIdentityFromRow,
  estimateValuesEqual, hashEstimatePlan } from './independent-estimate.js';
import { buildEstimateF8DraftPlan } from './estimate-f8-source-plan.js?v=0.1.1';
import { buildEstimateF8RowsFromPlan, buildEstimateF8Data } from './estimate-output.js?v=0.2.6';

const clone = value => structuredClone(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const outputs = result => Object.fromEntries(['shopData', 'erpData', 'estimateUploadData', 'confirmData', 'errors'].map(key => [key, result[key]]));

/** The fixed backup is captured once; sequential conversion never reads a converted source as legacy evidence. */
export async function prepareEstimateMigration({ store, companyId, actor, loadId, outputOptions }) {
  const snapshot = await store.captureEstimateMigrationEvidence();
  const snapshotHash = await hashEstimatePlan(snapshot);
  return { schemaVersion: 'SMARTINPUT_ESTIMATE_MIGRATION_BACKUP_V1', companyId, actor,
    migrationId: crypto.randomUUID(), previousLoadId: loadId, snapshot,
    manifest: { snapshotHash, snapshotId: crypto.randomUUID(), createdAt: new Date().toISOString() },
    outputOptions: clone(outputOptions) };
}

export async function convertPreservedEstimates({ store, backup, companyId, actor, currentLoadId,
  oldTabsConfirmedClosed, backupExported, selectedEstimateIds, confirmedCompanyEstimateIds = [], customerlessConfirmedIds = [] }) {
  if (backup?.schemaVersion !== 'SMARTINPUT_ESTIMATE_MIGRATION_BACKUP_V1' || backup.companyId !== companyId) fail('ESTIMATE_BACKUP_SCOPE_INVALID');
  await store.preserveEstimateMigrationEvidence({ companyId, actor, migrationId: backup.migrationId,
    snapshot: backup.snapshot, manifest: backup.manifest,
    safety: { oldTabsConfirmedClosed, backupExported, previousLoadId: backup.previousLoadId, currentLoadId } });
  const all = backup.snapshot.estimates;
  if (!Array.isArray(all)) fail('ESTIMATE_BACKUP_ESTIMATES_MISSING');
  const individuals = all.filter(record => record.estimateKind !== 'LINKED_GROUP');
  const results = [];
  for (const estimateId of [...new Set(selectedEstimateIds)]) {
    const before = all.find(record => record.estimateId === estimateId);
    if (!before) { results.push({ estimateId, status: 'MISSING' }); continue; }
    if (before.schemaVersion === INDEPENDENT_ESTIMATE_SCHEMA) { results.push({ estimateId, status: 'ALREADY_INDEPENDENT' }); continue; }
    const live = await store.loadEstimateForUpdate({ companyId, estimateId });
    if (live.status === 'READY') { results.push({ estimateId, status: 'ALREADY_INDEPENDENT' }); continue; }
    if (before.companyId && before.companyId !== companyId || !before.companyId && !confirmedCompanyEstimateIds.includes(estimateId)) {
      results.push({ estimateId, status: 'COMPANY_REVIEW_REQUIRED' }); continue;
    }
    try {
      const plan = buildEstimateF8DraftPlan({ selectedRecords: [before], individualRecords: individuals, allRecords: all });
      if (!plan.ok) { results.push({ estimateId, status: 'SOURCE_REVIEW_REQUIRED', message: plan.error }); continue; }
      const rows = buildEstimateF8RowsFromPlan(plan);
      const scoped = { ...clone(before), companyId };
      const conversion = createIndependentEstimateCandidate({ record: scoped, companyId, sourcePlan: plan, reportRows: rows,
        migrationId: backup.migrationId, snapshotId: backup.manifest.snapshotId, snapshotHash: backup.manifest.snapshotHash });
      if (conversion.status !== 'CANDIDATE_READY') { results.push({ estimateId, ...conversion }); continue; }
      const candidate = clone(conversion.candidate);
      for (const row of candidate.ownedRows) {
        row.matchIdentity = estimateIdentityFromRow(row, candidate.draft.header,
          { customerlessConfirmed: customerlessConfirmedIds.includes(estimateId) });
      }
      candidate.draft.ownedRows = clone(candidate.ownedRows);
      const oldOutput = outputs(buildEstimateF8Data(rows, backup.outputOptions));
      const newOutput = outputs(buildEstimateF8Data(candidate.ownedRows, backup.outputOptions));
      if (!estimateValuesEqual(oldOutput, newOutput)) fail('ESTIMATE_MIGRATION_OUTPUT_CHANGED');
      const verifiedOutputHash = await hashEstimatePlan(newOutput);
      const receipt = await store.commitIndependentEstimateMigration({ companyId, actor, migrationId: backup.migrationId,
        expectedPreimage: before, candidate, verifiedOutputHash,
        companyEvidence: before.companyId ? null : { companyId, actorId: actor.actorId,
          estimateIds: confirmedCompanyEstimateIds, confirmedAt: backup.manifest.createdAt } });
      results.push(receipt);
    } catch (error) { results.push({ estimateId, status: 'FAILED', code: error.code || error.message }); }
  }
  return results;
}
