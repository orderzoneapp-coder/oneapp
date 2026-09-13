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
export const estimateValuesEqual = (a, b) => a === undefined || b === undefined ? a === b : serialize(a) === serialize(b);
const equal = estimateValuesEqual;
export const serializeEstimateValue = serialize;
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
  if (!nonempty(identity.customerId) && !nonempty(identity.customerCode) && identity.customerlessConfirmed !== true) fail('ESTIMATE_CUSTOMER_REQUIRED');
  // An exact code may match an unresolved owner ID; explicit ID contradictions are rejected by the planner.
  return JSON.stringify([DIRECT_ROW_KEY_VERSION, companyId, identity.productCode.trim() ? '' : identity.productId, identity.productCode.trim(), identity.customerCode ? '' : identity.customerId, identity.customerCode, identity.unit, identity.pack, identity.specification, identity.priceConditionKey]);
}

export function createEstimateSourceIndex({ companyId, rows = [] } = {}) {
  if (!nonempty(companyId) || !Array.isArray(rows)) fail('ESTIMATE_SOURCE_CONTEXT_REQUIRED');
  const entries = {};
  const issues = [];
  rows.forEach((row, index) => {
    try {
      if (!nonempty(row.sourceRef)) fail('ESTIMATE_SOURCE_REFERENCE_REQUIRED');
      const key = estimateDirectRowKey(companyId, row.identity);
      (entries[key] ||= []).push(clone({ sourceRef: row.sourceRef, identity: row.identity, values: row.values || {} }));
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


export const LAST_ESTIMATE_EXCEL_RESULT_SCHEMA = 'SMARTINPUT_ESTIMATE_LAST_EXCEL_RESULT_V1';
export const ESTIMATE_TECHNICAL_KEY_PREFIX = 'smartinput:estimate:v1:';
export const estimateTechnicalKey = (kind, ...ids) => {
  if (!nonempty(kind) || ids.some(id => !nonempty(id))) fail('ESTIMATE_TECHNICAL_KEY_INVALID');
  return ESTIMATE_TECHNICAL_KEY_PREFIX + [kind, ...ids].map(encodeURIComponent).join(':');
};
export const estimateOwnedRowKey = (companyId, estimateId, ownedRowId) => {
  if (![companyId, estimateId, ownedRowId].every(nonempty)) fail('ESTIMATE_ROW_SCOPE_REQUIRED');
  return JSON.stringify([companyId, estimateId, ownedRowId]);
};
export const isEstimateProductRow = row => Boolean(row && [row.itemCode, row.itemName, row.productId, row.masterProductId]
  .some(value => value !== null && value !== undefined && String(value).trim() !== ''));

const identityFields = new Set(['itemCode', 'productId', 'masterProductId', 'rowCustomerId', 'rowCustomerCode',
  'customerId', 'customerCode', 'unit', 'pack', 'specification', 'priceConditionKey', 'rowId', 'ownedRowId']);
export function estimateUpdateFieldDefinitions(definitions = []) {
  const defaults = [...numericFields].map(id => ({ id, valueType: 'NUMBER' }))
    .concat([...textFields].map(id => ({ id, valueType: 'TEXT' })));
  const result = new Map(defaults.map(field => [field.id, field]));
  for (const field of definitions) {
    if (!field || !nonempty(field.id) || !['TEXT', 'NUMBER'].includes(field.valueType)) fail('ESTIMATE_FIELD_DEFINITION_INVALID');
    if (field.custom === true) {
      if (!nonempty(field.storageKey)) fail('ESTIMATE_CUSTOM_FIELD_KEY_REQUIRED');
      result.set(`custom:${field.storageKey}`, { ...clone(field), id: `custom:${field.storageKey}` });
    } else if (!identityFields.has(field.id) && !['__proto__', 'constructor', 'prototype'].includes(field.id)
      && (numericFields.has(field.id) || textFields.has(field.id))) result.set(field.id, clone(field));
  }
  return result;
}
export const estimateFieldValue = (row, field) => field.startsWith('custom:')
  ? row?.customValues?.[field.slice(7)] : row?.[field];
export function setEstimateFieldValue(row, field, value, definition = {}, sourceValues = []) {
  if (field.startsWith('custom:')) row.customValues = { ...(row.customValues || {}), [field.slice(7)]: clone(value) };
  else row[field] = clone(value);
  row.editedFields = { ...(row.editedFields || {}), [field.startsWith('custom:') ? field.slice(7) : field]: true };
  const targetFieldId = definition.targetFieldId;
  if (targetFieldId) {
    row.fieldValues = { ...(row.fieldValues || {}), [targetFieldId]: {
      ...(row.fieldValues?.[targetFieldId] || {}), fieldId: targetFieldId,
      currentDisplayValue: value === null ? '' : String(value), parsedValue: value, edited: true,
      evidence: { ...(row.fieldValues?.[targetFieldId]?.evidence || {}), estimateUpdateSources: clone(sourceValues) }
    } };
  }
  // Existing F8 prioritizes explicit edits over immutable source cells.
  return row;
}
function patchValue(field, envelope, allowClear, definitions) {
  if (!envelope || ['ABSENT', 'BLANK'].includes(envelope.kind)) return { skip: true };
  const definition = definitions.get(field);
  if (!definition) fail('ESTIMATE_FIELD_NOT_ALLOWED');
  if (envelope.reviewed !== true) fail('ESTIMATE_FIELD_NOT_REVIEWED');
  if (envelope.kind === 'CLEAR') {
    if (!allowClear) fail('ESTIMATE_CLEAR_NOT_AUTHORIZED');
    return { value: definition.valueType === 'NUMBER' ? null : '', kind: 'CLEAR' };
  }
  if (envelope.kind !== 'VALUE') fail('ESTIMATE_VALUE_KIND_INVALID');
  const value = envelope.parsedValue;
  if (definition.valueType === 'NUMBER' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== 'string') fail('ESTIMATE_VALUE_TYPE_INVALID');
  return { value, kind: 'VALUE' };
}

/** Work is separate from the approved persisted patch; no implicit save of unrelated edits. */
export function reconcileEstimateField({ before, working, incoming, beforePresent = true, workingPresent = true }) {
  if (!workingPresent && beforePresent) return { status: 'REVIEW_REQUIRED', code: 'ESTIMATE_WORKING_ROW_DELETED' };
  if (equal(working, before)) return { status: 'APPLY', savedValue: incoming, workValue: incoming };
  if (equal(incoming, before) || equal(incoming, working)) return { status: 'APPLY', savedValue: incoming, workValue: working };
  return { status: 'REVIEW_REQUIRED', code: 'ESTIMATE_WORKING_FIELD_CONFLICT', before: clone(before), working: clone(working), incoming: clone(incoming) };
}

function mappingEligible(mapping, scope, rows) {
  return mapping.keyVersion === DIRECT_ROW_KEY_VERSION && mapping.templateId === scope.templateId
    && equal(mapping.templateRevision, scope.templateRevision) && mapping.templateSignature === scope.templateSignature
    && mapping.mappingRevision !== undefined && nonempty(mapping.confirmedBy) && nonempty(mapping.confirmedAt)
    && Array.isArray(mapping.ownedRowIds) && mapping.ownedRowIds.length
    && mapping.ownedRowIds.every(id => rows.some(row => row.ownedRowId === id));
}
function sourceAppliesToTarget(identity, targetRows) {
  // A customer's unrelated Excel lines do not become cross-products with every selected estimate.
  return targetRows.some(row => row.matchIdentity &&
    (identity.customerCode ? row.matchIdentity.customerCode === identity.customerCode : row.matchIdentity.customerId === identity.customerId));
}

export async function createSelectedEstimateUpdatePlan({ operationId, companyId, actor, selectedEstimateIds = [], estimates = [], sourceIndex,
  templateId, templateRevision, templateSignature, fileGeneration, fileFingerprint, sourceDocumentId, sourceRevision,
  allowedFieldIds = [], explicitClears = [], fieldDefinitions = [], confirmedMappings = [], reviewedMappings = [], workingDrafts = {}, workingRevisions = {},
  mappingRevision, occurredAt = new Date().toISOString(), masterIntent = { enabled: false, selectedFields: [] } } = {}) {
  if (!nonempty(operationId) || !nonempty(companyId) || !nonempty(actor?.actorId)) fail('ESTIMATE_OPERATION_CONTEXT_REQUIRED');
  const selected = [...new Set(selectedEstimateIds)];
  if (selected.some(id => !nonempty(id))) fail('ESTIMATE_SELECTION_ID_INVALID');
  if (!selected.length) return freeze({ status: 'EMPTY', operationId, companyId, selectedEstimateIds: [], targets: [] });
  if (sourceIndex?.companyId !== companyId || sourceIndex.keyVersion !== DIRECT_ROW_KEY_VERSION) fail('ESTIMATE_SOURCE_SCOPE_MISMATCH');
  if (!nonempty(templateId) || !nonempty(templateSignature) || templateRevision === undefined || !nonempty(fileFingerprint)
    || fileGeneration === undefined || !nonempty(sourceDocumentId) || sourceRevision === undefined) fail('ESTIMATE_PLAN_EVIDENCE_REQUIRED');
  if (mappingRevision === undefined) fail('ESTIMATE_MAPPING_REVISION_REQUIRED');
  const definitions = estimateUpdateFieldDefinitions(fieldDefinitions);
  const fields = [...new Set(allowedFieldIds)];
  if (fields.some(field => !definitions.has(field))) fail('ESTIMATE_FIELD_NOT_ALLOWED');
  const byId = new Map();
  estimates.forEach(record => { if (byId.has(record.estimateId)) fail('ESTIMATE_RECORD_ID_COLLISION'); byId.set(record.estimateId, record); });
  const targets = selected.map(estimateId => {
    const record = byId.get(estimateId);
    const issues = clone(sourceIndex.issues || []);
    const rowPatches = [], workRebases = [], processedFields = [], mappingPatches = [], sourceRowOutcomes = [];
    const target = { estimateId, status: 'REVIEW_REQUIRED', rowPatches, mappingPatches, issues, workRebases, processedFields,
      sourceRowOutcomes, capturedWorkingRevision: workingRevisions[estimateId] ?? null };
    if (!record) { issues.push({ code: 'ESTIMATE_NOT_LOADED' }); return target; }
    if (record.companyId !== companyId) { issues.push({ code: 'ESTIMATE_COMPANY_MISMATCH' }); return target; }
    if (record.schemaVersion !== INDEPENDENT_ESTIMATE_SCHEMA || !Array.isArray(record.ownedRows)) { issues.push({ code: 'ESTIMATE_MIGRATION_REQUIRED' }); return target; }
    try { validateIndependentEstimate(record); } catch (error) { issues.push({ code: error.code }); return target; }
    if (workingDrafts[estimateId] && !own(workingRevisions, estimateId)) { issues.push({ code: 'ESTIMATE_WORKING_REVISION_REQUIRED' }); return target; }
    target.expectedRevision = record.dataRevision;
    target.expectedPreimage = clone(record);
    const validRows = record.ownedRows.filter(isEstimateProductRow);
    target.targetRowsAtRun = validRows.map(row => ({ rowKey: estimateOwnedRowKey(companyId, estimateId, row.ownedRowId),
      ownedRowId: row.ownedRowId, itemCode: row.itemCode || '', itemName: row.itemName || '' }));
    const grouped = new Map();
    validRows.forEach(row => {
      try { const key = estimateDirectRowKey(companyId, row.matchIdentity); (grouped.get(key) || (grouped.set(key, []), grouped.get(key))).push(row); }
      catch (error) { issues.push({ code: error.code || error.message, ownedRowId: row.ownedRowId }); }
    });
    for (const [sourceKey, inputs] of Object.entries(sourceIndex.entries)) {
      const rows = grouped.get(sourceKey) || [];
      const identityTuple = JSON.parse(sourceKey);
      const inputIdentity = { customerId: identityTuple[4], customerCode: identityTuple[5] };
      if (!rows.length && !sourceAppliesToTarget(inputIdentity, validRows)) continue;
      const outcomes = inputs.map(input => ({ sourceRowKey: input.sourceRef, estimateId, targetRowKeys: [], status: 'EXCLUDED', reasons: [] }));
      sourceRowOutcomes.push(...outcomes);
      if (!rows.length) { outcomes.forEach(outcome => outcome.reasons.push('TARGET_ROW_MISSING')); continue; }
      const conflictingIdentity = inputs.some(input => rows.some(row =>
        (input.identity?.productId && row.matchIdentity?.productId && input.identity.productId !== row.matchIdentity.productId)
        || (input.identity?.customerId && row.matchIdentity?.customerId && input.identity.customerId !== row.matchIdentity.customerId)));
      if (conflictingIdentity) {
        issues.push({ code: 'ESTIMATE_OWNER_IDENTITY_CONFLICT', sourceKey, candidateRowIds: rows.map(row => row.ownedRowId) });
        outcomes.forEach(outcome => outcome.reasons.push('ESTIMATE_OWNER_IDENTITY_CONFLICT'));
        continue;
      }
      const reviewedIds = new Set(reviewedMappings.map(mapping => mapping.aliasMappingId));
      const matches = [...confirmedMappings.filter(mapping => !reviewedIds.has(mapping.aliasMappingId)), ...reviewedMappings].filter(mapping => mapping.mappingType === DIRECT_ROW_MAPPING_TYPE && mapping.companyId === companyId
        && mapping.targetEstimateId === estimateId && mapping.sourceKey === sourceKey);
      const usable = matches.filter(mapping => mappingEligible(mapping, { templateId, templateRevision, templateSignature }, rows));
      let mappingIssue = '';
      if (matches.length !== usable.length) mappingIssue = 'ESTIMATE_MAPPING_STALE';
      const scopes = new Set(usable.map(mapping => JSON.stringify([...new Set(mapping.ownedRowIds)].sort())));
      if (scopes.size > 1) mappingIssue = 'ESTIMATE_MAPPING_CONFLICT';
      if (rows.length > 1 && !usable.length) mappingIssue ||= 'ESTIMATE_MULTIPLE_ROWS_REQUIRE_MAPPING';
      if (mappingIssue) {
        issues.push({ code: mappingIssue, sourceKey, candidateRowIds: rows.map(row => row.ownedRowId) });
        outcomes.forEach(outcome => { outcome.reasons.push(mappingIssue); outcome.targetRowKeys = rows.map(row => estimateOwnedRowKey(companyId, estimateId, row.ownedRowId)); });
        continue;
      }
      const matchingRows = usable.length ? rows.filter(row => usable[0].ownedRowIds.includes(row.ownedRowId)) : rows;
      outcomes.forEach(outcome => { outcome.targetRowKeys = matchingRows.map(row => estimateOwnedRowKey(companyId, estimateId, row.ownedRowId)); });
      let accepted = false;
      for (const field of fields) {
        const values = [];
        let invalid = false;
        inputs.forEach(input => {
          try { const result = patchValue(field, input.values[field], explicitClears.includes(field), definitions);
            if (!result.skip) values.push({ ...result, sourceRef: input.sourceRef, envelope: input.values[field] }); }
          catch (error) { invalid = true; issues.push({ code: error.code || error.message, field, sourceRef: input.sourceRef }); }
        });
        if (invalid || !values.length) {
          if (invalid) outcomes.forEach(outcome => outcome.reasons.push('ESTIMATE_FIELD_VALIDATION_REQUIRED'));
          continue;
        }
        if (values.some(value => !equal(value.value, values[0].value) || value.kind !== values[0].kind)) {
          issues.push({ code: 'ESTIMATE_FILE_FIELD_CONFLICT', field, sourceKey });
          outcomes.forEach(outcome => outcome.reasons.push('ESTIMATE_FILE_FIELD_CONFLICT')); continue;
        }
        for (const row of matchingRows) {
          const rawBefore = estimateFieldValue(row, field);
          const before = rawBefore === undefined ? null : rawBefore;
          const incoming = values[0].value;
          const working = workingDrafts[estimateId];
          if (working) {
            const workRow = (working.ownedRows || []).find(item => item.ownedRowId === row.ownedRowId);
            const workValue = estimateFieldValue(workRow, field) ?? null;
            const rebased = reconcileEstimateField({ before, working: workValue, incoming, workingPresent: Boolean(workRow) });
            if (rebased.status === 'REVIEW_REQUIRED') {
              issues.push({ ...rebased, field, ownedRowId: row.ownedRowId });
              outcomes.forEach(outcome => outcome.reasons.push(rebased.code)); continue;
            }
            if (!equal(workValue, rebased.workValue)) workRebases.push({ ownedRowId: row.ownedRowId, field, beforeValue: workValue, afterValue: rebased.workValue });
          }
          accepted = true;
          const patch = { ownedRowId: row.ownedRowId, field, beforePresent: rawBefore !== undefined, beforeValue: before,
            afterValue: incoming, valueKind: values[0].kind, sourceRefs: values.map(value => value.sourceRef),
            sourceValues: values.map(value => clone(value.envelope)), definition: clone(definitions.get(field)) };
          processedFields.push({ ...patch, status: equal(before, incoming) ? 'UNCHANGED' : 'APPLIED' });
          if (!equal(before, incoming)) rowPatches.push(patch);
        }
      }
      for (const outcome of outcomes) {
        const relevant = processedFields.filter(field => field.sourceRefs.includes(outcome.sourceRowKey)
          && outcome.targetRowKeys.includes(estimateOwnedRowKey(companyId, estimateId, field.ownedRowId)));
        outcome.reasons = [...new Set(outcome.reasons)];
        outcome.status = outcome.reasons.length ? relevant.length ? 'PARTIAL_REVIEW' : 'EXCLUDED'
          : relevant.length ? relevant.some(field => field.status === 'APPLIED') ? 'APPLIED' : 'UNCHANGED' : 'EXCLUDED';
        if (!relevant.length && !outcome.reasons.length) outcome.reasons.push('NO_CONFIRMED_FIELDS');
      }
      if (accepted && usable.length) {
        for (const reviewed of reviewedMappings.filter(mapping => usable.some(item => item.aliasMappingId === mapping.aliasMappingId))) {
          if (reviewed.confirmedBy !== actor.actorId || !nonempty(reviewed.confirmedAt)) fail('ESTIMATE_MAPPING_REVIEW_ACTOR_INVALID');
          const before = confirmedMappings.find(mapping => mapping.aliasMappingId === reviewed.aliasMappingId) || null;
          if (!equal(before, reviewed)) mappingPatches.push({ before: clone(before), after: clone(reviewed) });
        }
      }
      if (accepted && !usable.length) {
        // Exact, unique, reviewed row mapping. Existing identical evidence is never rewritten.
        const aliasMappingId = estimateTechnicalKey('rowMapping', companyId, templateId, estimateId, rows[0].ownedRowId, sourceKey);
        mappingPatches.push({ before: null, after: { aliasMappingId, mappingType: DIRECT_ROW_MAPPING_TYPE, companyId,
          keyVersion: DIRECT_ROW_KEY_VERSION, templateId, templateRevision, templateSignature, targetEstimateId: estimateId,
          sourceKey, ownedRowIds: matchingRows.map(row => row.ownedRowId), mappingRevision,
          confirmedBy: actor.actorId, confirmedAt: occurredAt, decisionBasis: 'EXACT_UNIQUE_REVIEWED_FIELDS' } });
      }
    }
    target.status = issues.length ? processedFields.length ? 'PARTIAL_REVIEW' : 'REVIEW_REQUIRED'
      : rowPatches.length ? 'PLANNED' : 'UNCHANGED';
    return target;
  });
  const payload = { schemaVersion: 'ONEAPP_SMARTINPUT_SELECTED_ESTIMATE_UPDATE_V1', operationId, companyId, actor: clone(actor),
    selectedEstimateIds: selected, fileGeneration, fileFingerprint, sourceDocumentId, sourceRevision, templateId, templateRevision,
    templateSignature, mappingRevision, keyVersion: DIRECT_ROW_KEY_VERSION, allowedFieldIds: fields, explicitClears: [...explicitClears],
    fieldDefinitions: clone(fieldDefinitions), sourceIndex: clone(sourceIndex), targets, occurredAt, masterIntent: clone(masterIntent) };
  return freeze({ ...payload, payloadHash: await hashEstimatePlan(payload) });
}

/** A round's exclusions are T minus all normally confirmed fields, including UNCHANGED. */
export function createLastEstimateExcelResult({ plan, target, estimateRevision, committedAt }) {
  if (!target.expectedPreimage || !plan.selectedEstimateIds.includes(target.estimateId)) fail('ESTIMATE_RESULT_SCOPE_INVALID');
  const processed = new Set((target.processedFields || []).map(field => field.ownedRowId));
  const issuesByRow = new Map();
  (target.issues || []).forEach(issue => {
    const ids = issue.ownedRowId ? [issue.ownedRowId] : issue.candidateRowIds || [];
    ids.forEach(id => { const values = issuesByRow.get(id) || []; values.push(issue.code); issuesByRow.set(id, values); });
  });
  const targetRowsAtRun = clone(target.targetRowsAtRun || []);
  const processedTargetRowKeys = targetRowsAtRun.filter(row => processed.has(row.ownedRowId) && !issuesByRow.has(row.ownedRowId)).map(row => row.rowKey);
  const completed = new Set(processedTargetRowKeys);
  return freeze({ schemaVersion: LAST_ESTIMATE_EXCEL_RESULT_SCHEMA, companyId: plan.companyId, estimateId: target.estimateId,
    operationId: plan.operationId, payloadHash: plan.payloadHash, committedAt, fileFingerprint: plan.fileFingerprint,
    fileGeneration: plan.fileGeneration, sourceDocumentId: plan.sourceDocumentId, sourceRevision: plan.sourceRevision,
    estimateRevisionAtCommit: estimateRevision, targetRowsAtRun, processedTargetRowKeys,
    excludedTargetRows: targetRowsAtRun.filter(row => !completed.has(row.rowKey)).map(row => ({ ...row,
      reasons: issuesByRow.get(row.ownedRowId) || ['SOURCE_ROW_MISSING'] })), sourceRowOutcomes: clone(target.sourceRowOutcomes || []) });
}

export function applyIndependentEstimatePatches(record, patches, { updatedAt = new Date().toISOString() } = {}) {
  validateIndependentEstimate(record);
  const next = clone(record);
  const rows = new Map(next.ownedRows.map(row => [row.ownedRowId, row]));
  const seen = new Set();
  for (const patch of patches) {
    const key = JSON.stringify([patch.ownedRowId, patch.field]);
    if (seen.has(key)) fail('ESTIMATE_PATCH_DUPLICATE'); seen.add(key);
    const row = rows.get(patch.ownedRowId);
    if (!row) fail('ESTIMATE_PATCH_ROW_MISSING');
    const previous = estimateFieldValue(row, patch.field);
    if ((previous !== undefined) !== patch.beforePresent || !equal(previous ?? null, patch.beforeValue)) fail('ESTIMATE_PATCH_STALE');
    const definitions = estimateUpdateFieldDefinitions(patch.definition?.custom ? [patch.definition] : []);
    if (!definitions.has(patch.field)) fail('ESTIMATE_FIELD_NOT_ALLOWED');
    patchValue(patch.field, { kind: patch.valueKind, reviewed: true, parsedValue: patch.afterValue }, true, definitions);
    setEstimateFieldValue(row, patch.field, patch.afterValue, patch.definition, patch.sourceValues);
  }
  if (patches.length) { next.dataRevision += 1; next.updatedAt = updatedAt; }
  next.draft = projectIndependentEstimateDraft(next);
  next.rowCount = next.ownedRows.filter(isEstimateProductRow).length;
  next.amount = next.ownedRows.reduce((sum, row) => sum + (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0), 0);
  return next;
}

export function projectIndependentEstimateDraft(record) {
  const byId = new Map(record.ownedRows.map(row => [row.ownedRowId, row]));
  const oldRows = new Map((record.draft?.rows || []).map(row => [row.rowId, row]));
  const rows = record.displayGroups.filter(group => group.visible !== false).map(group => {
    const members = group.ownedRowIds.map(id => byId.get(id));
    if (members.some(row => !row)) fail('ESTIMATE_DISPLAY_GROUP_EVIDENCE_MISSING');
    const old = oldRows.get(group.rowId) || members[0];
    if (members.length === 1) return { ...clone(members[0]), rowId: group.rowId };
    const result = clone(old);
    // A displayed representative is not authority over the individual members.
    for (const field of [...numericFields, ...textFields]) {
      if (members.every(row => equal(row[field], members[0][field]))) {
        if (own(members[0], field)) result[field] = clone(members[0][field]);
      }
    }
    return result;
  });
  return { ...clone(record.draft), schemaVersion: INDEPENDENT_ESTIMATE_SCHEMA, estimateKind: 'INDIVIDUAL',
    catalogRecordId: record.estimateId, companyId: record.companyId, dataRevision: record.dataRevision,
    linkedEstimateSources: [], ownedRows: clone(record.ownedRows), displayGroups: clone(record.displayGroups), rows };
}

/** Compose a read-only table. View IDs never replace the stored row IDs. */
export function buildSelectedEstimateTable(records, workingDrafts = new Map()) {
  const rows = [];
  records.forEach(record => {
    validateIndependentEstimate(record);
    const draft = workingDrafts instanceof Map ? workingDrafts.get(record.estimateId) : workingDrafts[record.estimateId];
    (draft?.ownedRows || record.ownedRows).forEach(row => {
      const pointer = { companyId: record.companyId, estimateId: record.estimateId, ownedRowId: row.ownedRowId,
        sourceRevision: record.dataRevision, originalRowId: row.rowId };
      rows.push({ ...clone(row), rowId: `VIEW:${estimateOwnedRowKey(record.companyId, record.estimateId, row.ownedRowId)}`,
        estimateOwner: pointer, estimateOwnerName: record.catalogName || record.estimateId });
    });
  });
  return rows;
}

/** Latest-result join has no DB writes, no accumulation, and no product-code deduplication. */
export function indexEstimateExclusions({ rows, results = [], dataKind, file = null }) {
  const byRow = new Map();
  const sourceRowsByKey = new Map(rows.map(row => [row.stage3SourceRef || row.rowId, row]));
  for (const result of results) {
    if (!result || result.schemaVersion !== LAST_ESTIMATE_EXCEL_RESULT_SCHEMA) continue;
    if (dataKind === 'EXCEL') {
      if (!file || result.companyId !== file.companyId || result.fileFingerprint !== file.fileFingerprint
        || result.fileGeneration !== file.fileGeneration || result.sourceDocumentId !== file.sourceDocumentId) continue;
      for (const outcome of result.sourceRowOutcomes || []) {
        if (['APPLIED', 'UNCHANGED'].includes(outcome.status)) continue;
        const found = sourceRowsByKey.get(outcome.sourceRowKey);
        if (!found) continue;
        const existing = byRow.get(found.rowId) || [];
        if (!existing.some(item => item.estimateId === result.estimateId)) existing.push({ estimateId: result.estimateId, reasons: clone(outcome.reasons) });
        byRow.set(found.rowId, existing);
      }
    } else {
      const excluded = new Map(result.excludedTargetRows.map(row => [row.rowKey, row]));
      for (const row of rows) {
        const pointer = row.estimateOwner;
        const estimateId = pointer?.estimateId || row.stage3EstimateId;
        const ownedRowIds = pointer ? [pointer.ownedRowId] : row.stage3OwnedRowIds || [row.ownedRowId];
        if (estimateId !== result.estimateId) continue;
        for (const ownedRowId of ownedRowIds) {
          const key = estimateOwnedRowKey(result.companyId, estimateId, ownedRowId);
          const evidence = excluded.get(key); if (!evidence) continue;
          const existing = byRow.get(row.rowId) || [];
          if (!existing.some(item => item.rowKey === key)) existing.push({ estimateId, rowKey: key, reasons: clone(evidence.reasons) });
          byRow.set(row.rowId, existing);
        }
      }
    }
  }
  return { byRow, count: [...byRow.values()].reduce((sum, values) => sum + values.length, 0) };
}

/** Exact identities are built from already resolved owner/template values, never fuzzy names. */
export function estimateIdentityFromRow(row, header = {}, { customerlessConfirmed = false } = {}) {
  const value = key => String(row?.[key] ?? '').trim();
  return { productId: value('masterProductId') || value('productId'), productCode: value('itemCode'),
    customerId: value('rowCustomerId') || String(header.customerId || '').trim(),
    customerCode: value('rowCustomerCode') || String(header.customerCode || '').trim(),
    unit: value('unit'), pack: value('pack'), specification: value('specification'),
    priceConditionKey: value('priceConditionKey') || JSON.stringify([value('rowWarehouseCode') || String(header.warehouseCode || ''), value('priceCondition')]),
    customerlessConfirmed: customerlessConfirmed === true };
}
const workTechnicalFields = new Set(['rowId', 'ownedRowId', 'estimateOwner', 'estimateOwnerName', 'stage3EstimateId', 'stage3OwnedRowIds']);
function changedRowFields(base, work) {
  return [...new Set([...Object.keys(base || {}), ...Object.keys(work || {})])]
    .filter(field => !workTechnicalFields.has(field) && !equal(base?.[field], work?.[field]));
}

/** Read display edits against their baseline. Ambiguous representative edits remain explicit issues. */
export function applyIndependentDraftWork({ record, baselineDraft = record.draft, workingDraft }) {
  validateIndependentEstimate(record);
  const owned = new Map((workingDraft.ownedRows || record.ownedRows).map(row => [row.ownedRowId, clone(row)]));
  const groups = clone(workingDraft.displayGroups || record.displayGroups);
  const baseRows = new Map((baselineDraft.rows || []).map(row => [row.rowId, row]));
  const visibleRows = new Map((workingDraft.rows || []).filter(row => isEstimateProductRow(row) || baseRows.has(row.rowId)).map(row => [row.rowId, row]));
  const issues = [];
  const keptGroups = [];
  for (const group of groups) {
    if (group.visible === false) { keptGroups.push(group); continue; }
    const work = visibleRows.get(group.rowId), base = baseRows.get(group.rowId);
    if (!work) {
      const scope = workingDraft.independentEditScopes?.[group.rowId]?.__delete;
      if (group.ownedRowIds.length > 1 && !Array.isArray(scope)) {
        issues.push({ code: 'ESTIMATE_EDIT_SCOPE_REQUIRED', rowId: group.rowId, field: '__delete', ownedRowIds: group.ownedRowIds });
        keptGroups.push(group); continue;
      }
      const selected = scope || group.ownedRowIds;
      selected.forEach(id => { if (!group.ownedRowIds.includes(id)) fail('ESTIMATE_EDIT_SCOPE_INVALID'); owned.delete(id); });
      const remaining = group.ownedRowIds.filter(id => owned.has(id));
      if (remaining.length) keptGroups.push({ ...group, ownedRowIds: remaining });
      continue;
    }
    const fields = changedRowFields(base, work);
    for (const field of fields) {
      const selected = group.ownedRowIds.length === 1 ? group.ownedRowIds : workingDraft.independentEditScopes?.[group.rowId]?.[field];
      if (!Array.isArray(selected) || !selected.length) {
        issues.push({ code: 'ESTIMATE_EDIT_SCOPE_REQUIRED', rowId: group.rowId, field, ownedRowIds: group.ownedRowIds }); continue;
      }
      for (const id of selected) {
        if (!group.ownedRowIds.includes(id) || !owned.has(id)) fail('ESTIMATE_EDIT_SCOPE_INVALID');
        const target = owned.get(id);
        if (own(work, field)) target[field] = clone(work[field]); else delete target[field];
      }
    }
    keptGroups.push(group); visibleRows.delete(group.rowId);
  }
  // Only genuinely added product rows are owned. Default empty editor rows are not data.
  for (const row of visibleRows.values()) {
    const ownedRowId = row.ownedRowId || row.rowId;
    if (!nonempty(ownedRowId) || owned.has(ownedRowId)) fail('ESTIMATE_OWNED_ROW_ID_COLLISION');
    owned.set(ownedRowId, { ...clone(row), ownedRowId });
    keptGroups.push({ rowId: row.rowId, ownedRowIds: [ownedRowId], visible: true });
  }
  const order = new Map((workingDraft.rows || []).map((row, index) => [row.rowId, index]));
  keptGroups.sort((a, b) => (order.get(a.rowId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.rowId) ?? Number.MAX_SAFE_INTEGER));
  const next = { ...clone(record), ownedRows: [...owned.values()], displayGroups: keptGroups,
    draft: { ...clone(workingDraft), rows: clone(workingDraft.rows), ownedRows: [...owned.values()], displayGroups: keptGroups } };
  for (const row of next.ownedRows) row.matchIdentity = estimateIdentityFromRow(row, next.draft.header,
    { customerlessConfirmed: row.matchIdentity?.customerlessConfirmed === true });
  next.draft.ownedRows = clone(next.ownedRows);
  validateIndependentEstimate(next);
  return { record: next, draft: next.draft, issues };
}

/** Rebase work over one committed estimate, recursively preserving unrelated cell evidence. */
export function rebaseIndependentEstimateWork({ baseline, working, committed }) {
  const conflicts = [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const merge = (base, local, saved, path, rowId) => {
    if (equal(local, base)) return clone(saved);
    if (equal(saved, base) || equal(local, saved)) return clone(local);
    if (object(base) && object(local) && object(saved)) {
      const result = {};
      for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(saved)])) {
        const value = merge(base[key], local[key], saved[key], path ? `${path}.${key}` : key, rowId);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    conflicts.push({ code: 'ESTIMATE_WORKING_FIELD_CONFLICT', ownedRowId: rowId, field: path,
      before: clone(base ?? null), working: clone(local ?? null), committed: clone(saved ?? null) });
    return clone(local);
  };
  const old = new Map((baseline.ownedRows || []).map(row => [row.ownedRowId, row]));
  const saved = new Map(committed.ownedRows.map(row => [row.ownedRowId, row]));
  const localRows = working.ownedRows || working.draft?.ownedRows || [];
  const localIds = new Set(localRows.map(row => row.ownedRowId));
  const rows = localRows.flatMap(row => {
    const base = old.get(row.ownedRowId), incoming = saved.get(row.ownedRowId);
    if (!base) {
      if (incoming && !equal(incoming, row)) conflicts.push({ code: 'ESTIMATE_ADDED_ROW_CONFLICT', ownedRowId: row.ownedRowId, working: clone(row), committed: clone(incoming) });
      return [clone(row)];
    }
    if (!incoming) {
      if (equal(base, row)) return [];
      conflicts.push({ code: 'ESTIMATE_COMMITTED_ROW_DELETED', ownedRowId: row.ownedRowId, before: clone(base), working: clone(row) });
      return [clone(row)];
    }
    return [merge(base, row, incoming, '', row.ownedRowId)];
  });
  for (const [id, base] of old) if (!localIds.has(id) && saved.has(id) && !equal(base, saved.get(id))) {
    conflicts.push({ code: 'ESTIMATE_LOCAL_DELETE_CONFLICT', ownedRowId: id, before: clone(base), working: null, committed: clone(saved.get(id)) });
  }
  const rowIds = new Set(rows.map(row => row.ownedRowId));
  committed.ownedRows.filter(row => !old.has(row.ownedRowId) && !rowIds.has(row.ownedRowId)).forEach(row => rows.push(clone(row)));
  const ids = new Set(rows.map(row => row.ownedRowId));
  const displayGroups = (working.displayGroups || working.draft?.displayGroups || committed.displayGroups)
    .map(group => ({ ...clone(group), ownedRowIds: group.ownedRowIds.filter(id => ids.has(id)) })).filter(group => group.ownedRowIds.length);
  const represented = new Set(displayGroups.flatMap(group => group.ownedRowIds));
  rows.filter(row => !represented.has(row.ownedRowId)).forEach(row => displayGroups.push({ rowId: row.rowId, ownedRowIds: [row.ownedRowId], visible: true }));
  const workDraft = working.draft || working;
  const next = { ...clone(committed), ownedRows: rows, displayGroups, draft: clone(workDraft) };
  next.draft = projectIndependentEstimateDraft(next);
  next.draft.header = merge(baseline.draft?.header || {}, workDraft.header || {}, committed.draft.header || {}, 'header', '');
  if (conflicts.length) next.draft.stage3RebaseIssues = clone(conflicts);
  return { record: next, draft: next.draft, conflicts, issues: conflicts };
}
