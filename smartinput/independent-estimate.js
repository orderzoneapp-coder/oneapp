/** Pure Stage 3 plans. Importing this module never opens a database or migrates data. */
export const INDEPENDENT_ESTIMATE_SCHEMA = 'ONEAPP_SMARTINPUT_INDEPENDENT_ESTIMATE_V1';
export const DIRECT_ROW_MAPPING_TYPE = 'ESTIMATE_DIRECT_ROW_V1';
export const DIRECT_ROW_KEY_VERSION = 'ESTIMATE_DIRECT_ROW_KEY_V1';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => structuredClone(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const numericFields = new Set(['quantity', 'unitPrice', 'purchasePriceB', 'wholesaleA', 'wholesaleB', 'promoPrice', 'noticePrice', 'outPrice', 'listingPrice', 'marketPrice', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI']);
const textFields = new Set(['memo', 'memo2', 'description']);

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function serialize(value, ancestors = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
    || (typeof value === 'number' && !Number.isFinite(value))) fail('ESTIMATE_NON_JSON_VALUE');
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (ancestors.has(value)) fail('ESTIMATE_CYCLIC_VALUE');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail('ESTIMATE_NON_JSON_VALUE');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from({ length: value.length }, (_, index) => {
      if (!own(value, index)) fail('ESTIMATE_NON_JSON_VALUE');
      return serialize(value[index], ancestors);
    }).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serialize(value[key], ancestors)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}
const equal = (a, b) => a === undefined || b === undefined ? a === b : serialize(a) === serialize(b);
export async function hashEstimatePlan(value) {
  if (!globalThis.crypto?.subtle) fail('ESTIMATE_HASH_UNAVAILABLE');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialize(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Identity must already be resolved against the owner/template. Missing conditions are not guessed. */
export function estimateDirectRowKey(companyId, identity = {}) {
  if (!nonempty(companyId)) fail('ESTIMATE_COMPANY_REQUIRED');
  const fields = ['productId', 'productCode', 'customerId', 'customerCode', 'unit', 'pack', 'specification', 'priceConditionKey'];
  if (fields.some(field => !own(identity, field) || typeof identity[field] !== 'string')) fail('ESTIMATE_ROW_IDENTITY_INCOMPLETE');
  if (!nonempty(identity.productId) && !nonempty(identity.productCode)) fail('ESTIMATE_PRODUCT_REQUIRED');
  if (!nonempty(identity.customerId) && !nonempty(identity.customerCode)) fail('ESTIMATE_CUSTOMER_REQUIRED');
  // Keep both owner ID and exact code: contradictory identities must not silently match.
  return JSON.stringify([DIRECT_ROW_KEY_VERSION, companyId, identity.productId, identity.productCode.trim(), identity.customerId, identity.customerCode, identity.unit, identity.pack, identity.specification, identity.priceConditionKey]);
}

export function createEstimateSourceIndex({ companyId, rows = [] } = {}) {
  if (!nonempty(companyId) || !Array.isArray(rows)) fail('ESTIMATE_SOURCE_CONTEXT_REQUIRED');
  const entries = {};
  const issues = [];
  rows.forEach((row, index) => {
    try {
      if (!nonempty(row.sourceRef)) fail('ESTIMATE_SOURCE_REFERENCE_REQUIRED');
      const key = estimateDirectRowKey(companyId, row.identity);
      (entries[key] ||= []).push(clone({ sourceRef: row.sourceRef, values: row.values || {} }));
    } catch (error) { issues.push({ code: error.code || error.message, sourceIndex: index }); }
  });
  return freeze({ companyId, keyVersion: DIRECT_ROW_KEY_VERSION, entries, issues });
}

/**
 * Assemble, but do NOT authorize/commit, an independently owned candidate.
 * reportRows must come from the legacy F8 source plan using persisted sources only.
 * The caller still must verify before/after F8 with the SAME product and Settings snapshots.
 */
export function createIndependentEstimateCandidate({ record, companyId, sourcePlan, reportRows, migrationId, snapshotId, snapshotHash } = {}) {
  if (!record?.estimateId || !record?.draft || !nonempty(migrationId) || !nonempty(snapshotId) || !nonempty(snapshotHash)) fail('ESTIMATE_MIGRATION_EVIDENCE_REQUIRED');
  if (!nonempty(companyId) || record.companyId !== companyId) return { status: 'REVIEW_REQUIRED', issues: [{ code: 'ESTIMATE_COMPANY_UNCONFIRMED', estimateId: record.estimateId }] };
  if (record.schemaVersion === INDEPENDENT_ESTIMATE_SCHEMA) {
    validateIndependentEstimate(record);
    return freeze({ status: 'ALREADY_INDEPENDENT', estimateId: record.estimateId });
  }
  if (record.schemaVersion) fail('ESTIMATE_UNKNOWN_SCHEMA');
  if (!sourcePlan?.ok || !Array.isArray(reportRows)) return { status: 'REVIEW_REQUIRED', issues: [{ code: 'ESTIMATE_COMPLETE_F8_EVIDENCE_REQUIRED', estimateId: record.estimateId }] };
  if (sourcePlan.entries?.length !== 1 || sourcePlan.entries[0].recordId !== record.estimateId) fail('ESTIMATE_PLAN_TARGET_MISMATCH');
  const entry = sourcePlan.entries[0];
  if (!equal(entry.kind === 'DERIVED' ? entry.workingDraft : entry.draft, record.draft)) fail('ESTIMATE_UNSAVED_MIGRATION_EVIDENCE');
  const linked = record.estimateKind === 'LINKED_GROUP';
  if ((linked && entry.kind !== 'DERIVED') || (!linked && entry.kind !== 'DIRECT')) fail('ESTIMATE_PLAN_KIND_MISMATCH');
  const visibleRows = record.draft.rows || [];
  const ids = new Set();
  const ownedRows = reportRows.map(row => {
    if (!nonempty(row.rowId)) fail('ESTIMATE_ROW_ID_REQUIRED');
    const sourceEstimateId = linked ? row.linkedSourceEstimateId : record.estimateId;
    const sourceRowId = linked ? row.linkedSourceRowId : row.rowId;
    const manual = linked && !sourceEstimateId && !sourceRowId;
    if (linked && !manual && (!nonempty(sourceEstimateId) || !nonempty(sourceRowId))) fail('ESTIMATE_SOURCE_ID_INCOMPLETE');
    const ownedRowId = linked && !manual
      ? `OWNED:${JSON.stringify([record.estimateId, sourceEstimateId, sourceRowId])}`
      : row.rowId;
    if (ids.has(ownedRowId)) fail('ESTIMATE_OWNED_ROW_ID_COLLISION');
    ids.add(ownedRowId);
    return { ...clone(row), ownedRowId, independentSource: manual ? { manual: true } : { estimateId: sourceEstimateId, rowId: sourceRowId } };
  });
  if (!linked && (visibleRows.length !== ownedRows.length || visibleRows.some((row, index) => row.rowId !== ownedRows[index]?.rowId))) fail('ESTIMATE_DIRECT_ROW_EVIDENCE_MISMATCH');
  const ownedBySource = new Map();
  const ownedByRowId = new Map();
  ownedRows.forEach(row => {
    const sourceKey = JSON.stringify([row.independentSource.estimateId || '', row.independentSource.rowId || '']);
    (ownedBySource.get(sourceKey) || (ownedBySource.set(sourceKey, []), ownedBySource.get(sourceKey))).push(row);
    (ownedByRowId.get(row.rowId) || (ownedByRowId.set(row.rowId, []), ownedByRowId.get(row.rowId))).push(row);
  });
  const assigned = new Set();
  const visibleIds = new Set();
  const displayGroups = visibleRows.map(row => {
    if (!nonempty(row.rowId) || visibleIds.has(row.rowId)) fail('ESTIMATE_DISPLAY_ROW_ID_COLLISION');
    visibleIds.add(row.rowId);
    const refs = row.linkedSourceRefs?.length ? row.linkedSourceRefs
      : row.linkedSourceEstimateId && row.linkedSourceRowId ? [{ estimateId: row.linkedSourceEstimateId, rowId: row.linkedSourceRowId }] : [];
    const matching = refs.length ? refs.flatMap(ref => {
      const members = ownedBySource.get(JSON.stringify([ref.estimateId, ref.rowId]));
      if (!members?.length) fail('ESTIMATE_DISPLAY_GROUP_EVIDENCE_MISSING');
      return members;
    }) : (ownedByRowId.get(row.rowId) || []).filter(owned => !linked || owned.independentSource.manual);
    if (!matching.length) fail('ESTIMATE_DISPLAY_GROUP_EVIDENCE_MISSING');
    matching.forEach(owned => { if (assigned.has(owned.ownedRowId)) fail('ESTIMATE_DISPLAY_GROUP_OVERLAP'); assigned.add(owned.ownedRowId); });
    return { rowId: row.rowId, ownedRowIds: matching.map(owned => owned.ownedRowId), visible: true };
  });
  // Legacy F8 can contain source transactions not currently represented by a visible row.
  ownedRows.filter(row => !assigned.has(row.ownedRowId)).forEach(row => {
    displayGroups.push({ rowId: `HIDDEN:${row.ownedRowId}`, ownedRowIds: [row.ownedRowId], visible: false });
  });
  const candidate = clone(record);
  candidate.schemaVersion = INDEPENDENT_ESTIMATE_SCHEMA;
  candidate.estimateKind = 'INDIVIDUAL';
  if (own(record, 'dataRevision') && (!Number.isSafeInteger(record.dataRevision) || record.dataRevision < 0)) fail('ESTIMATE_REVISION_INVALID');
  candidate.dataRevision = record.dataRevision ?? 0;
  candidate.ownedRows = ownedRows;
  candidate.displayGroups = displayGroups;
  candidate.provenance = { ...(candidate.provenance || {}), legacyKind: record.estimateKind || 'INDIVIDUAL', linkedEstimateSources: clone(record.linkedEstimateSources || []), migration: { migrationId, snapshotId, snapshotHash } };
  candidate.linkedEstimateSources = [];
  candidate.draft = { ...candidate.draft, schemaVersion: INDEPENDENT_ESTIMATE_SCHEMA, estimateKind: 'INDIVIDUAL', linkedEstimateSources: [], ownedRows: clone(ownedRows), displayGroups: clone(displayGroups) };
  validateIndependentEstimate(candidate);
  // No original/unsaved data is mutated; legacy references remain evidence until integration.
  return freeze({ status: 'CANDIDATE_READY', candidate, expectedPreimage: clone(record), requiresOutputVerification: true });
}

/** Shape validation is not authorization, backup verification, or permission to migrate. */
export function validateIndependentEstimate(record) {
  if (record?.schemaVersion !== INDEPENDENT_ESTIMATE_SCHEMA || record.estimateKind !== 'INDIVIDUAL'
    || !nonempty(record.estimateId) || !nonempty(record.companyId)
    || !Number.isSafeInteger(record.dataRevision) || record.dataRevision < 0
    || !Array.isArray(record.ownedRows) || !Array.isArray(record.displayGroups)) fail('ESTIMATE_INDEPENDENT_SHAPE_INVALID');
  const ids = new Set();
  record.ownedRows.forEach(row => {
    if (!nonempty(row?.ownedRowId) || ids.has(row.ownedRowId)) fail('ESTIMATE_OWNED_ROW_ID_COLLISION');
    ids.add(row.ownedRowId);
  });
  const groupIds = new Set();
  const grouped = new Set();
  record.displayGroups.forEach(group => {
    if (!nonempty(group?.rowId) || groupIds.has(group.rowId) || !Array.isArray(group.ownedRowIds) || !group.ownedRowIds.length) fail('ESTIMATE_DISPLAY_GROUP_INVALID');
    groupIds.add(group.rowId);
    group.ownedRowIds.forEach(id => {
      if (!ids.has(id) || grouped.has(id)) fail('ESTIMATE_DISPLAY_GROUP_COVERAGE_INVALID');
      grouped.add(id);
    });
  });
  if (grouped.size !== ids.size) fail('ESTIMATE_DISPLAY_GROUP_COVERAGE_INVALID');
  return true;
}

function patchValue(field, envelope, allowClear) {
  if (!envelope || ['ABSENT', 'BLANK'].includes(envelope.kind)) return { skip: true };
  if (!numericFields.has(field) && !textFields.has(field)) fail('ESTIMATE_FIELD_NOT_ALLOWED');
  if (envelope.reviewed !== true) fail('ESTIMATE_FIELD_NOT_REVIEWED');
  if (envelope.kind === 'CLEAR') {
    if (!allowClear) fail('ESTIMATE_CLEAR_NOT_AUTHORIZED');
    return { value: numericFields.has(field) ? null : '', kind: 'CLEAR' };
  }
  if (envelope.kind !== 'VALUE') fail('ESTIMATE_VALUE_KIND_INVALID');
  const value = envelope.parsedValue;
  if (numericFields.has(field) ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== 'string') fail('ESTIMATE_VALUE_TYPE_INVALID');
  return { value, kind: 'VALUE' };
}

/** Field-wise three-way rebase. The returned work value is never an implicit database write. */
export function reconcileEstimateField({ before, working, incoming, beforePresent = true, workingPresent = true }) {
  if (!workingPresent && beforePresent) return { status: 'REVIEW_REQUIRED', code: 'ESTIMATE_WORKING_ROW_DELETED' };
  if (equal(working, before)) return { status: 'APPLY', savedValue: incoming, workValue: incoming };
  if (equal(incoming, before) || equal(incoming, working)) return { status: 'APPLY', savedValue: incoming, workValue: working };
  return { status: 'REVIEW_REQUIRED', code: 'ESTIMATE_WORKING_FIELD_CONFLICT', before: clone(before), working: clone(working), incoming: clone(incoming) };
}

/** No database writes. Unknown/ambiguous identities stay review-only, never first-candidate wins. */
export async function createSelectedEstimateUpdatePlan({ operationId, companyId, actor, selectedEstimateIds = [], estimates = [], sourceIndex, templateId, templateRevision, templateSignature, fileGeneration, fileFingerprint, sourceDocumentId, sourceRevision, allowedFieldIds = [], explicitClears = [], confirmedMappings = [], workingDrafts = {}, workingRevisions = {}, mappingRevision, masterIntent = { enabled: false, selectedFields: [] } } = {}) {
  if (!nonempty(operationId) || !nonempty(companyId) || !nonempty(actor?.actorId)) fail('ESTIMATE_OPERATION_CONTEXT_REQUIRED');
  const selected = [...new Set(selectedEstimateIds)];
  if (selected.some(id => !nonempty(id))) fail('ESTIMATE_SELECTION_ID_INVALID');
  if (!selected.length) return freeze({ status: 'EMPTY', operationId, companyId, selectedEstimateIds: [], targets: [] });
  if (sourceIndex?.companyId !== companyId || sourceIndex.keyVersion !== DIRECT_ROW_KEY_VERSION) fail('ESTIMATE_SOURCE_SCOPE_MISMATCH');
  if (!nonempty(templateId) || !nonempty(templateSignature) || templateRevision === undefined || !nonempty(fileFingerprint) || fileGeneration === undefined || !nonempty(sourceDocumentId) || sourceRevision === undefined) fail('ESTIMATE_PLAN_EVIDENCE_REQUIRED');
  if (mappingRevision === undefined) fail('ESTIMATE_MAPPING_REVISION_REQUIRED');
  const fields = [...new Set(allowedFieldIds)];
  if (fields.some(field => !numericFields.has(field) && !textFields.has(field))) fail('ESTIMATE_FIELD_NOT_ALLOWED');
  const byId = new Map();
  estimates.forEach(record => { if (byId.has(record.estimateId)) fail('ESTIMATE_RECORD_ID_COLLISION'); byId.set(record.estimateId, record); });
  const targets = selected.map(estimateId => {
    const record = byId.get(estimateId);
    const issues = clone(sourceIndex.issues || []);
    const rowPatches = [];
    const workRebases = [];
    const target = { estimateId, status: 'REVIEW_REQUIRED', rowPatches, mappingPatches: [], issues, workRebases, capturedWorkingRevision: workingRevisions[estimateId] ?? null };
    if (!record) { issues.push({ code: 'ESTIMATE_NOT_LOADED' }); return target; }
    if (record.companyId !== companyId) { issues.push({ code: 'ESTIMATE_COMPANY_MISMATCH' }); return target; }
    if (record.schemaVersion !== INDEPENDENT_ESTIMATE_SCHEMA || !Array.isArray(record.ownedRows)) { issues.push({ code: 'ESTIMATE_MIGRATION_REQUIRED' }); return target; }
    try { validateIndependentEstimate(record); } catch (error) { issues.push({ code: error.code }); return target; }
    if (workingDrafts[estimateId] && !own(workingRevisions, estimateId)) { issues.push({ code: 'ESTIMATE_WORKING_REVISION_REQUIRED' }); return target; }
    target.expectedRevision = record.dataRevision;
    target.expectedPreimage = clone(record);
    const grouped = new Map();
    const rowIds = new Set();
    record.ownedRows.forEach(row => {
      if (!nonempty(row.ownedRowId) || rowIds.has(row.ownedRowId)) fail('ESTIMATE_OWNED_ROW_ID_COLLISION');
      rowIds.add(row.ownedRowId);
      try { const key = estimateDirectRowKey(companyId, row.matchIdentity); (grouped.get(key) || (grouped.set(key, []), grouped.get(key))).push(row); }
      catch (error) { issues.push({ code: error.code || error.message, ownedRowId: row.ownedRowId }); }
    });
    grouped.forEach((rows, sourceKey) => {
      const inputs = sourceIndex.entries[sourceKey];
      if (!inputs?.length) return; // No new rows; omitted target rows remain untouched.
      const matches = confirmedMappings.filter(mapping => mapping.mappingType === DIRECT_ROW_MAPPING_TYPE && mapping.companyId === companyId && mapping.targetEstimateId === estimateId && mapping.sourceKey === sourceKey);
      const usable = matches.filter(mapping => mapping.keyVersion === DIRECT_ROW_KEY_VERSION && mapping.templateId === templateId && equal(mapping.templateRevision, templateRevision) && mapping.templateSignature === templateSignature && mapping.mappingRevision !== undefined && nonempty(mapping.confirmedBy) && nonempty(mapping.confirmedAt) && Array.isArray(mapping.ownedRowIds) && mapping.ownedRowIds.length);
      if (matches.length !== usable.length || usable.some(mapping => mapping.ownedRowIds.some(id => !rows.some(row => row.ownedRowId === id)))) { issues.push({ code: 'ESTIMATE_MAPPING_STALE', sourceKey }); return; }
      const scopes = new Set(usable.map(mapping => JSON.stringify([...new Set(mapping.ownedRowIds)].sort())));
      if (scopes.size > 1) { issues.push({ code: 'ESTIMATE_MAPPING_CONFLICT', sourceKey }); return; }
      if (rows.length > 1 && !usable.length) { issues.push({ code: 'ESTIMATE_MULTIPLE_ROWS_REQUIRE_MAPPING', sourceKey }); return; }
      const matchingRows = usable.length ? rows.filter(row => usable[0].ownedRowIds.includes(row.ownedRowId)) : rows;
      fields.forEach(field => {
        const values = [];
        let invalid = false;
        inputs.forEach(input => {
          try { const result = patchValue(field, input.values[field], explicitClears.includes(field)); if (!result.skip) values.push({ ...result, sourceRef: input.sourceRef, envelope: input.values[field] }); }
          catch (error) { invalid = true; issues.push({ code: error.code || error.message, field, sourceRef: input.sourceRef }); }
        });
        if (invalid || !values.length) return;
        if (values.some(value => !equal(value.value, values[0].value) || value.kind !== values[0].kind)) { issues.push({ code: 'ESTIMATE_FILE_FIELD_CONFLICT', field, sourceKey }); return; }
        matchingRows.forEach(row => {
          const before = own(row, field) ? row[field] : null;
          const incoming = values[0].value;
          const working = workingDrafts[estimateId];
          if (working) {
            const workRow = (working.ownedRows || []).find(item => item.ownedRowId === row.ownedRowId);
            const workValue = workRow && own(workRow, field) ? workRow[field] : null;
            const rebased = reconcileEstimateField({ before, working: workValue, incoming, beforePresent: true, workingPresent: Boolean(workRow) });
            if (rebased.status === 'REVIEW_REQUIRED') { issues.push({ ...rebased, field, ownedRowId: row.ownedRowId }); return; }
            if (!equal(workValue, rebased.workValue)) workRebases.push({ ownedRowId: row.ownedRowId, field, beforeValue: workValue, afterValue: rebased.workValue });
          }
          if (!equal(before, incoming)) rowPatches.push({ ownedRowId: row.ownedRowId, field, beforePresent: own(row, field), beforeValue: before, afterValue: incoming, valueKind: values[0].kind, sourceRefs: values.map(value => value.sourceRef), sourceValues: values.map(value => clone(value.envelope)) });
        });
      });
    });
    target.status = issues.length ? rowPatches.length ? 'PARTIAL_REVIEW' : 'REVIEW_REQUIRED' : rowPatches.length ? 'PLANNED' : 'UNCHANGED';
    return target;
  });
  const payload = { schemaVersion: 'ONEAPP_SMARTINPUT_SELECTED_ESTIMATE_UPDATE_V1', operationId, companyId, actor: clone(actor), selectedEstimateIds: selected, fileGeneration, fileFingerprint, sourceDocumentId, sourceRevision, templateId, templateRevision, templateSignature, mappingRevision, keyVersion: DIRECT_ROW_KEY_VERSION, allowedFieldIds: fields, explicitClears: [...explicitClears], sourceIndex: clone(sourceIndex), targets, masterIntent: clone(masterIntent) };
  return freeze({ ...payload, payloadHash: await hashEstimatePlan(payload) });
}
