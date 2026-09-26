import { INDEPENDENT_ESTIMATE_SCHEMA, createIndependentEstimateCandidate, estimateIdentityFromRow,
  estimateValuesEqual, hashEstimatePlan } from './independent-estimate.js';
import { buildEstimateF8DraftPlan } from './linked-estimate-source-edit.js?v=0.17.0';
import { buildEstimateF8RowsFromPlan, buildEstimateF8Data } from './report.js?v=0.17.0';

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

/**
 * Save one selected legacy estimate through the current structure. The caller supplies the records it
 * already loaded for this estimate and its sources; nothing else is read, converted or written, and a
 * rejected candidate leaves the stored estimate untouched.
 */
export async function saveLegacyEstimateCompatibly({ store, companyId, actor, estimateId, operationId, records = [], outputOptions }) {
  if (!companyId || !estimateId || !operationId) fail('ESTIMATE_COMPAT_SAVE_SCOPE_INVALID');
  const live = await store.loadEstimateForUpdate({ companyId, estimateId });
  if (live.status === 'READY') return { estimateId, status: 'ALREADY_INDEPENDENT', record: live.record };
  // An estimate without a recorded company is never adopted on the operator's behalf.
  if (live.status === 'CONTEXT_REQUIRED' || live.status === 'COMPANY_MISMATCH') return { estimateId, status: 'COMPANY_REVIEW_REQUIRED' };
  if (live.status !== 'MIGRATION_REQUIRED' || !live.record) return { estimateId, status: live.status };
  const before = live.record;
  if (before.companyId !== companyId) return { estimateId, status: 'COMPANY_REVIEW_REQUIRED' };
  const all = [before, ...records.filter(record => record.estimateId !== estimateId)];
  const plan = buildEstimateF8DraftPlan({ selectedRecords: [before], individualRecords: all.filter(record => record.estimateKind !== 'LINKED_GROUP'), allRecords: all });
  if (!plan.ok) return { estimateId, status: 'SOURCE_REVIEW_REQUIRED', message: plan.error };
  const rows = buildEstimateF8RowsFromPlan(plan);
  // The evidence is this estimate's own preimage, not a backup snapshot of the whole library.
  const preimageHash = await hashEstimatePlan(before);
  const conversion = createIndependentEstimateCandidate({ record: clone(before), companyId, sourcePlan: plan, reportRows: rows,
    migrationId: operationId, snapshotId: operationId, snapshotHash: preimageHash });
  if (conversion.status !== 'CANDIDATE_READY') return { estimateId, ...conversion };
  const candidate = clone(conversion.candidate);
  for (const row of candidate.ownedRows) row.matchIdentity = estimateIdentityFromRow(row, candidate.draft.header);
  candidate.draft.ownedRows = clone(candidate.ownedRows);
  candidate.provenance = { ...candidate.provenance, compatibilitySave: { operationId, preimageHash } };
  const oldOutput = outputs(buildEstimateF8Data(rows, outputOptions));
  const newOutput = outputs(buildEstimateF8Data(candidate.ownedRows, outputOptions));
  if (!estimateValuesEqual(oldOutput, newOutput)) return { estimateId, status: 'OUTPUT_REVIEW_REQUIRED', code: 'ESTIMATE_MIGRATION_OUTPUT_CHANGED' };
  const receipt = await store.commitLegacyEstimateCompatibilitySave({ companyId, actor, operationId, estimateId,
    expectedPreimage: before, candidate, verifiedOutputHash: await hashEstimatePlan(newOutput) });
  return { ...receipt, record: candidate };
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
