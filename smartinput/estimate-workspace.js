// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.
import * as independentEstimateDependency0 from "./independent-estimate.js";

// ============================================================================
// estimate-master-apply.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const estimateMasterApplySection = (() => {
const { hashEstimatePlan } = independentEstimateDependency0;

const SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA = 'SMARTINPUT_ESTIMATE_MASTER_APPLY_V1';
const SMARTINPUT_MASTER_INTENT_SCHEMA = 'ONEAPP_SMARTINPUT_ESTIMATE_MASTER_INTENT_V1';
const ESTIMATE_MASTER_FIELDS = Object.freeze({
  purchasePriceB: '입고B', wholesaleA: '도매A', wholesaleB: '도매B', promoPrice: '행사가'
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => structuredClone(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const jsonEqual = (a, b) => Object.is(a, b);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function contextPresent({ companyId, actor }) {
  return nonempty(companyId) && nonempty(actor?.actorId) && nonempty(actor?.actorState);
}
const codeOf = value => typeof value === 'string' ? value.trim() : '';

/**
 * Builds an intent, not an authorization. The owner must independently validate the real
 * session, company ownership, product identity, source receipts and transaction preimages.
 * confirmedFields are read from durable estimate outcomes by the integrating controller;
 * a screen value or an optimistic UI success flag is not an eligible input source.
 */
async function createEstimateMasterIntent({ enabled = false, commandId, operationId, companyId, actor,
  reason, baseSnapshotId, baseContentHash, expectedRevision, products = [], confirmedFields = [], selectedFields = [],
  selectedEstimateIds = [], executionMode = 'AFTER_SELECTED_ESTIMATE_UPDATE' } = {}) {
  if (!enabled) return freeze({ status: 'DISABLED', command: null, issues: [] });
  const selected = [...new Set(selectedEstimateIds)];
  if (!selected.length) return freeze({ status: 'NO_CANDIDATES', command: null, issues: [] });
  if (selected.some(id => !nonempty(id)) || !['AFTER_SELECTED_ESTIMATE_UPDATE', 'SELECTED_ESTIMATES_ONLY'].includes(executionMode)) fail('MASTER_SELECTION_INVALID');
  if (!contextPresent({ companyId, actor })) return freeze({ status: 'CONTEXT_REQUIRED', command: null, issues: [] });
  if (!nonempty(commandId) || !nonempty(operationId) || !nonempty(reason)
    || !nonempty(baseSnapshotId) || !nonempty(baseContentHash) || expectedRevision === undefined) fail('MASTER_COMMAND_EVIDENCE_REQUIRED');
  const fields = new Set(selectedFields);
  if ([...fields].some(field => !own(ESTIMATE_MASTER_FIELDS, field))) fail('MASTER_FIELD_NOT_ALLOWED');
  const productByCode = new Map();
  products.forEach(product => {
    const primary = codeOf(product?.['코드']);
    const secondary = codeOf(product?.['품목코드']);
    const code = primary || secondary;
    if (!code || (primary && secondary && primary !== secondary) || productByCode.has(code)) fail('MASTER_PRODUCT_IDENTITY_INVALID');
    productByCode.set(code, product);
  });
  const issues = [];
  const grouped = new Map();
  confirmedFields.forEach(source => {
    if (!selected.includes(source.estimateId)) fail('MASTER_SOURCE_OUTSIDE_SELECTION');
    if (!fields.has(source.field)) return;
    if (!['SAVED', 'UNCHANGED'].includes(source.estimateStatus) || source.conflict === true) {
      issues.push({ code: 'MASTER_SOURCE_NOT_CONFIRMED', estimateId: source.estimateId || '', field: source.field });
      return;
    }
    if (source.companyId !== companyId || !nonempty(source.estimateId) || !nonempty(source.ownedRowId)
      || !nonempty(source.operationId) || !Number.isSafeInteger(source.estimateRevision) || source.estimateRevision < 0
      || !Array.isArray(source.sourceRefs) || !source.sourceRefs.length || source.sourceRefs.some(ref => !nonempty(ref))) {
      issues.push({ code: 'MASTER_SOURCE_EVIDENCE_REQUIRED', estimateId: source.estimateId || '', field: source.field });
      return;
    }
    if (['ABSENT', 'BLANK'].includes(source.valueKind)) return;
    const code = codeOf(source.code);
    const product = productByCode.get(code);
    if (!product || (source.productId && product.productId !== source.productId)) {
      issues.push({ code: 'MASTER_PRODUCT_UNRESOLVED', productCode: code, field: source.field });
      return;
    }
    if (source.valueKind === 'CLEAR' ? source.explicitClear !== true
      : source.valueKind !== 'VALUE' || typeof source.value !== 'number' || !Number.isFinite(source.value)) {
      issues.push({ code: 'MASTER_VALUE_NOT_AUTHORIZED', productCode: code, field: source.field });
      return;
    }
    // Numeric blanks are represented explicitly. This module never turns a blank into zero.
    const afterValue = source.valueKind === 'CLEAR' ? null : source.value;
    const field = ESTIMATE_MASTER_FIELDS[source.field];
    const key = JSON.stringify([code, field]);
    (grouped.get(key) || (grouped.set(key, []), grouped.get(key))).push({ source, product, code, field, afterValue });
  });
  const patches = [];
  const sources = new Map();
  grouped.forEach(group => {
    const first = group[0];
    if (group.some(item => !jsonEqual(item.afterValue, first.afterValue) || item.source.valueKind !== first.source.valueKind)) {
      issues.push({ code: 'MASTER_FIELD_VALUE_CONFLICT', productCode: first.code, field: first.field,
        estimateIds: [...new Set(group.map(item => item.source.estimateId))] });
      return;
    }
    const beforeValue = own(first.product, first.field) ? first.product[first.field] : null;
    if (beforeValue !== null && typeof beforeValue !== 'number' && typeof beforeValue !== 'string') {
      issues.push({ code: 'MASTER_PREIMAGE_TYPE_UNSUPPORTED', productCode: first.code, field: first.field });
      return;
    }
    patches.push({ code: first.code, field: first.field, beforeValue,
      beforePresent: own(first.product, first.field), afterValue: first.afterValue, valueKind: first.source.valueKind,
      sourceRefs: group.map(({ source }) => ({ estimateId: source.estimateId, ownedRowId: source.ownedRowId,
        fieldId: source.field, revision: source.estimateRevision, operationId: source.operationId,
        updatePayloadHash: source.updatePayloadHash || '', valueKind: source.valueKind, explicitClear: source.explicitClear === true,
        inputRefs: [...source.sourceRefs] })) });
    group.forEach(({ source }) => {
      const key = JSON.stringify([source.estimateId, source.estimateRevision, source.operationId]);
      if (!sources.has(key)) sources.set(key, { estimateId: source.estimateId, revision: source.estimateRevision,
        operationId: source.operationId, rowIds: [], fieldIds: [] });
      const entry = sources.get(key);
      if (!entry.rowIds.includes(source.ownedRowId)) entry.rowIds.push(source.ownedRowId);
      if (!entry.fieldIds.includes(source.field)) entry.fieldIds.push(source.field);
    });
  });
  if (!patches.length) return freeze({ status: issues.length ? 'REVIEW_REQUIRED' : 'NO_CANDIDATES', command: null, issues });
  const payload = { schemaVersion: SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA, sourceAppId: 'smart-input', ownerAppId: 'master-lookup',
    commandId, operationId, companyId, actor: clone(actor), reason, baseSnapshotId, baseContentHash,
    expectedRevision, executionMode, selectedEstimateIds: selected, sourceEstimates: [...sources.values()], patches };
  const command = { ...payload, payloadHash: await hashEstimatePlan(payload) };
  // Keep equal values in the command: only the owner can durably decide UNCHANGED.
  return freeze({ schemaVersion: SMARTINPUT_MASTER_INTENT_SCHEMA, status: issues.length ? 'PARTIAL_REVIEW' : 'READY',
    command, issues });
}

function validateIntent(intent) {
  const command = intent?.command;
  if (intent?.schemaVersion !== SMARTINPUT_MASTER_INTENT_SCHEMA || !command
    || command.schemaVersion !== SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA
    || command.sourceAppId !== 'smart-input' || command.ownerAppId !== 'master-lookup'
    || !contextPresent(command) || !nonempty(command.commandId) || !nonempty(command.payloadHash)) fail('MASTER_INTENT_INVALID');
  return command;
}
function queryArguments(command) {
  return { companyId: command.companyId, commandId: command.commandId, payloadHash: command.payloadHash, actor: clone(command.actor) };
}
function resultMatches(result, command) {
  return result?.companyId === command.companyId && result.commandId === command.commandId && result.payloadHash === command.payloadHash;
}
function unknown(command, code) {
  return { status: 'RESULT_UNKNOWN', companyId: command.companyId, commandId: command.commandId, payloadHash: command.payloadHash, code };
}

/**
 * A dependency-injected dispatch boundary. Production supplies the existing v5 datastore and owner adapter.
 * persistIntent must resolve only after its transaction completes; it must CAS the full
 * immutable command under the same key and reject changed payloads for a reused commandId.
 * The owner independently enforces the same receipt rule in its own database transaction.
 */
async function executeEstimateMasterIntent({ intent, persistIntent, owner, resume = false } = {}) {
  if (!intent?.command && ['DISABLED', 'CONTEXT_REQUIRED', 'NO_CANDIDATES', 'REVIEW_REQUIRED'].includes(intent?.status)) return clone(intent);
  const command = clone(validateIntent(intent));
  const { payloadHash, ...payload } = command;
  if (await hashEstimatePlan(payload) !== payloadHash) fail('MASTER_PAYLOAD_HASH_MISMATCH');
  if (typeof persistIntent !== 'function' || typeof owner?.commitReviewedSmartInputEstimate !== 'function'
    || typeof owner?.getSmartInputEstimateCommandResult !== 'function') fail('MASTER_CAPABILITY_UNAVAILABLE');
  let recoveredIntent = false;
  try {
    const persisted = await persistIntent(freeze(clone(intent)));
    if (!persisted?.durable || !resultMatches(persisted, command)) fail('MASTER_INTENT_NOT_DURABLE');
    recoveredIntent = persisted.existing === true;
  } catch (error) {
    return { status: 'NOT_DISPATCHED', commandId: command.commandId, code: error.code || error.message };
  }
  if (resume || recoveredIntent) {
    let result;
    try { result = await owner.getSmartInputEstimateCommandResult(queryArguments(command)); }
    catch (error) { return unknown(command, error.code || 'MASTER_RESULT_LOOKUP_FAILED'); }
    if (!resultMatches(result, command)) return unknown(command, 'MASTER_RESULT_IDENTITY_MISMATCH');
    if (['APPLIED', 'UNCHANGED', 'CONFLICT'].includes(result.status)) return clone(result);
    if (result.status !== 'CONFIRMED_NOT_APPLIED') return unknown(command, 'MASTER_PRIOR_RESULT_UNRESOLVED');
  }
  try {
    const result = await owner.commitReviewedSmartInputEstimate(freeze(command));
    if (!resultMatches(result, command)) return unknown(command, 'MASTER_RESULT_IDENTITY_MISMATCH');
    if (['APPLIED', 'UNCHANGED', 'FAILED', 'CONFLICT', 'CONTEXT_REQUIRED', 'RESULT_UNKNOWN'].includes(result.status)) return clone(result);
    return unknown(command, 'MASTER_RESULT_UNRECOGNIZED');
  } catch (error) {
    // A thrown transport/read/post-commit error does not establish that no write happened.
    return unknown(command, error.code || 'MASTER_RESULT_UNRESOLVED');
  }
}

/** Resume history/notification publication only. Never call a product commit here. */
async function resumeEstimateMasterPublication({ intent, owner } = {}) {
  const command = validateIntent(intent);
  if (typeof owner?.resumeSmartInputEstimateCommandPublication !== 'function') fail('MASTER_PUBLICATION_CAPABILITY_UNAVAILABLE');
  const result = await owner.resumeSmartInputEstimateCommandPublication({ companyId: command.companyId, commandId: command.commandId, actor: clone(command.actor) });
  if (!resultMatches(result, command)) return unknown(command, 'MASTER_RESULT_IDENTITY_MISMATCH');
  return clone(result);
}

return { SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA, SMARTINPUT_MASTER_INTENT_SCHEMA, ESTIMATE_MASTER_FIELDS, createEstimateMasterIntent, executeEstimateMasterIntent, resumeEstimateMasterPublication };
})();

// ============================================================================
// estimate-workspace.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const estimateWorkspaceSection = (() => {
const { INDEPENDENT_ESTIMATE_SCHEMA, createEstimateSourceIndex, createSelectedEstimateUpdatePlan, estimateIdentityFromRow, estimateUpdateFieldDefinitions, estimateFieldValue, estimateValuesEqual, buildSelectedEstimateTable, indexEstimateExclusions, applyIndependentDraftWork, projectIndependentEstimateDraft, rebaseIndependentEstimateWork } = independentEstimateDependency0;
const { createEstimateMasterIntent, executeEstimateMasterIntent, resumeEstimateMasterPublication, ESTIMATE_MASTER_FIELDS } = estimateMasterApplySection;

const copy = value => structuredClone(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const id = () => crypto.randomUUID();
const committed = receipt => receipt?.committed === true;

/** UI coordinator. Receipts, not optimistic screen state, decide whether a write completed. */
function createEstimateWorkspace({ store, readContext, readMasterContext = readContext, prepareMaster = async () => {}, reviewMappings = async () => [], readProducts, owner, onChange = () => {} }) {
  let companyId = '', selectedIds = [], generation = 0;
  const records = new Map(), work = new Map(), baselines = new Map(), results = new Map();
  let operation = null, masterIntent = null, busy = false;
  const context = () => {
    const value = readContext();
    if (value?.status !== 'READY' || !value.companyId || !value.actor?.actorId) fail(value?.code || 'ESTIMATE_CONTEXT_REQUIRED');
    if (companyId && value.companyId !== companyId) fail('ESTIMATE_COMPANY_CHANGED');
    return value;
  };
  const change = () => onChange(api.snapshot());
  const inFlight = async callback => {
    if (busy) fail('ESTIMATE_OPERATION_IN_PROGRESS');
    busy = true; change();
    try { return await callback(); } finally { busy = false; change(); }
  };
  const readRecord = async estimateId => {
    if (store.loadEstimateBody) {
      const cached = await store.loadEstimateBody({ companyId, estimateId });
      if (cached.status !== 'READY') return { status: cached.status === 'NOT_FOUND' ? 'CONFIRMED_MISSING' : cached.status, estimateId };
      const record = copy(cached.value);
      if (!record.companyId) return { status: 'CONTEXT_REQUIRED', estimateId, record };
      if (record.schemaVersion !== INDEPENDENT_ESTIMATE_SCHEMA) return { status: 'MIGRATION_REQUIRED', estimateId, record };
      return { status: 'READY', companyId, estimateId, record };
    }
    const result = await store.loadEstimateForUpdate({ companyId, estimateId });
    if (result.status !== 'READY') return result;
    return result;
  };
  const requireResolvedWrites = async () => {
    const pending = await store.loadPendingEstimateOperations({ companyId });
    if (pending.some(entry => entry.kind !== 'master')) fail('ESTIMATE_PENDING_OPERATION_REQUIRES_RETRY');
  };
  async function dispatchUpdate(plan, resume) {
    const active = context();
    if (plan.companyId !== active.companyId || plan.actor.actorId !== active.actor.actorId) fail('ESTIMATE_OPERATION_ACTOR_CHANGED');
    const persisted = await store.persistSelectedEstimateUpdatePlan(plan);
    if (!persisted.durable) { operation = null; return { status: persisted.status, receipts: [] }; }
    const receipts = [];
    const refreshIssues = [];
    for (const target of plan.targets) {
      let receipt;
      try {
        if (resume || persisted.existing) {
          receipt = await store.getEstimateUpdateResult({ companyId, operationId: plan.operationId,
            estimateId: target.estimateId, payloadHash: plan.payloadHash });
        }
        if (!receipt || receipt.status === 'CONFIRMED_NOT_APPLIED') {
          receipt = await store.commitSelectedEstimateUpdate({ plan, target });
        }
      } catch (error) {
        // A failed response is not permission to mint another operation ID.
        try {
          receipt = await store.getEstimateUpdateResult({ companyId, operationId: plan.operationId,
            estimateId: target.estimateId, payloadHash: plan.payloadHash });
          if (receipt.status === 'CONFIRMED_NOT_APPLIED') receipt = { ...receipt,
            status: /CONFLICT/.test(error.code || '') ? 'CONFLICT' : 'FAILED', code: error.code || error.message };
        } catch (lookupError) {
          receipt = { status: 'RESULT_UNKNOWN', estimateId: target.estimateId, code: lookupError.code || lookupError.message };
        }
      }
      receipts.push(receipt);
      if (!committed(receipt)) continue;
      try {
      const loaded = await readRecord(target.estimateId);
      if (loaded.status !== 'READY') continue;
      const previous = records.get(target.estimateId) || target.expectedPreimage;
      if (work.has(target.estimateId)) {
        const rebased = rebaseIndependentEstimateWork({ baseline: previous, working: work.get(target.estimateId), committed: loaded.record });
        work.set(target.estimateId, rebased.draft || rebased.record?.draft || rebased);
      }
      records.set(target.estimateId, loaded.record);
      baselines.set(target.estimateId, copy(loaded.record.draft));
      // Query latest: replaying an old receipt must not roll the displayed round backwards.
      const latest = await store.loadLastEstimateExcelResult({ companyId, estimateId: target.estimateId });
      results.set(target.estimateId, latest.result);
      } catch (error) { refreshIssues.push({ estimateId: target.estimateId, code: error.code || error.message }); }
    }
    const unresolved = receipts.some(item => ['RESULT_UNKNOWN', 'FAILED', 'CONFIRMED_NOT_APPLIED'].includes(item.status));
    if (!unresolved) {
      await store.completePendingEstimateOperation({ companyId, kind: 'update', id: plan.operationId });
      operation = null;
    }
    return { status: unresolved ? 'RETRY_REQUIRED' : 'COMPLETED', plan, receipts, refreshIssues };
  }
  const api = {
    snapshot: () => ({ companyId, selectedIds: [...selectedIds], busy, operation: copy(operation), masterIntent: copy(masterIntent) }),
    setCompany(value) {
      if (companyId === value) return;
      companyId = value; generation += 1; selectedIds = []; records.clear(); results.clear(); work.clear(); baselines.clear();
      operation = null; masterIntent = null; change();
    },
    select(ids) { selectedIds = [...new Set(ids.filter(Boolean))]; generation += 1; change(); },
    selected: () => [...selectedIds],
    getRecord: estimateId => records.get(estimateId),
    getWork: estimateId => work.get(estimateId),
    remember(estimateId, draft) {
      const record = records.get(estimateId);
      if (!record) return;
      const baseline = baselines.get(estimateId) || record.draft;
      if (estimateValuesEqual(baseline, draft)) work.delete(estimateId);
      else work.set(estimateId, copy(draft));
    },
    adopt(record) {
      records.set(record.estimateId, copy(record));
      if (!baselines.has(record.estimateId)) baselines.set(record.estimateId, copy(record.draft));
    },
    journal() {
      return { companyId, selectedIds: [...selectedIds], work: [...work], baselines: [...baselines],
        operation: copy(operation), masterIntent: copy(masterIntent) };
    },
    restore(saved) {
      if (!saved || saved.companyId !== companyId) return;
      selectedIds = [...new Set(saved.selectedIds || [])];
      for (const [key, value] of saved.work || []) work.set(key, copy(value));
      for (const [key, value] of saved.baselines || []) baselines.set(key, copy(value));
      operation = copy(saved.operation || null); masterIntent = copy(saved.masterIntent || null); change();
    },
    async loadSelection() {
      const ticket = generation, scope = companyId, ids = [...selectedIds];
      const loaded = [];
      // Bound reads; stage 4 supplies a shared cache at the store boundary.
      for (let start = 0; start < ids.length; start += 4) {
        loaded.push(...await Promise.all(ids.slice(start, start + 4).map(async estimateId => {
          try {
            const [value, latest] = await Promise.all([readRecord(estimateId), store.loadLastEstimateExcelResult({ companyId: scope, estimateId })]);
            return { ...value, latest: latest.result };
          } catch (error) { return { status: 'ERROR', estimateId, code: error.code || error.message }; }
        })));
      }
      if (ticket !== generation || scope !== companyId) return { status: 'STALE', rows: [] };
      for (const item of loaded) if (item.status === 'READY') {
        api.adopt(item.record); results.set(item.estimateId, item.latest);
      }
      const issues = loaded.filter(item => item.status !== 'READY');
      return { status: issues.length ? 'REVIEW_REQUIRED' : 'READY', issues,
        rows: buildSelectedEstimateTable(ids.flatMap(key => records.has(key) ? [records.get(key)] : []), work) };
    },
    exclusions(rows, dataKind, file) {
      return indexEstimateExclusions({ rows, dataKind, file, results: selectedIds.map(key => results.get(key)).filter(Boolean) });
    },
    async updateExcel({ draft, file, allowedFieldIds, fieldDefinitions = [], explicitClears = [], masterFields = [] }) {
      if (!selectedIds.length) return { status: 'EMPTY', receipts: [] };
      return inFlight(async () => {
        if (operation) fail('ESTIMATE_PENDING_OPERATION_REQUIRES_RETRY');
        await requireResolvedWrites();
        const active = context(), ids = [...selectedIds];
        const loaded = await api.loadSelection();
        if (loaded.status === 'STALE') fail('ESTIMATE_SELECTION_CHANGED');
        estimateUpdateFieldDefinitions(fieldDefinitions);
        const sourceIndex = createEstimateSourceIndex({ companyId, rows: draft.rows.map(row => ({
          sourceRef: row.stage3SourceRef || row.rowId,
          identity: estimateIdentityFromRow(row, draft.header, { customerlessConfirmed: row.matchIdentity?.customerlessConfirmed === true }),
          values: Object.fromEntries(allowedFieldIds.map(field => {
            const value = estimateFieldValue(row, field);
            return [field, { kind: value === undefined ? 'ABSENT' : value === null || value === '' ? 'BLANK' : 'VALUE',
              reviewed: true, parsedValue: value ?? null, rawValue: value ?? null }];
          }))
        })) });
        const workingDrafts = {}, workingRevisions = {};
        for (const key of ids) if (work.has(key) && records.has(key)) {
          const applied = applyIndependentDraftWork({ record: records.get(key), baselineDraft: baselines.get(key), workingDraft: work.get(key) });
          if (applied.issues.length) fail('ESTIMATE_WORKING_SCOPE_REQUIRED');
          workingDrafts[key] = applied.draft; workingRevisions[key] = records.get(key).dataRevision;
        }
        const mappings = await store.loadEstimateDirectMappings();
        const argumentsForPlan = { ...file, operationId: id(), companyId, actor: active.actor,
          selectedEstimateIds: ids, estimates: ids.flatMap(key => records.has(key) ? [records.get(key)] : []), sourceIndex,
          allowedFieldIds, explicitClears, fieldDefinitions, confirmedMappings: mappings, mappingRevision: 1,
          workingDrafts, workingRevisions, masterIntent: { enabled: masterFields.length > 0, selectedFields: masterFields } };
        let plan = await createSelectedEstimateUpdatePlan(argumentsForPlan);
        const reviewedMappings = await reviewMappings(plan, mappings);
        if (reviewedMappings.length) plan = await createSelectedEstimateUpdatePlan({ ...argumentsForPlan, reviewedMappings });
        operation = plan;
        change();
        return dispatchUpdate(operation, false);
      });
    },
    retryUpdate(plan = operation) { if (!plan) return Promise.resolve({ status: 'NO_PENDING_OPERATION' }); return inFlight(() => dispatchUpdate(plan, true)); },
    async edit({ estimateId, draft, name, action = 'SAVE', expectedRecord = null }) {
      return inFlight(async () => {
        await requireResolvedWrites();
        const active = context();
        const record = expectedRecord || records.get(estimateId);
        if (!record || record.schemaVersion !== INDEPENDENT_ESTIMATE_SCHEMA) fail('ESTIMATE_MIGRATION_REQUIRED');
        let candidate = null;
        if (action !== 'DELETE') {
          const applied = applyIndependentDraftWork({ record, baselineDraft: baselines.get(estimateId) || record.draft, workingDraft: draft || record.draft });
          if (applied.issues.length) { const error = new Error('ESTIMATE_EDIT_SCOPE_REQUIRED'); error.issues = applied.issues; throw error; }
          candidate = applied.record;
          if (name) candidate.catalogName = name;
          if (!estimateValuesEqual(candidate, record)) { candidate.dataRevision = record.dataRevision + 1; candidate.updatedAt = new Date().toISOString(); }
          candidate.draft = projectIndependentEstimateDraft(candidate);
        }
        const intent = { companyId, actor: active.actor, operationId: id(), estimateId, expectedPreimage: record, candidate, action };
        const receipt = await store.commitIndependentEstimateEdit(intent);
        await store.completePendingEstimateOperation({ companyId, kind: 'edit', id: intent.operationId });
        if (action === 'DELETE') { records.delete(estimateId); work.delete(estimateId); baselines.delete(estimateId); }
        else {
          const result = await readRecord(estimateId);
          if (result.status === 'READY') { records.set(estimateId, result.record); baselines.set(estimateId, copy(result.record.draft)); work.delete(estimateId); }
        }
        return receipt;
      });
    },
    async applyMaster({ fields = Object.keys(ESTIMATE_MASTER_FIELDS), update = null } = {}) {
      if (!selectedIds.length) return { status: 'NO_CANDIDATES' };
      return inFlight(async () => {
        if (masterIntent) fail('MASTER_PENDING_OPERATION_REQUIRES_RETRY');
        await prepareMaster();
        const active = readMasterContext();
        if (active?.status !== 'READY' || active.companyId !== companyId) return { status: 'CONTEXT_REQUIRED', code: active?.code || 'MASTER_COMPANY_CONTEXT_REQUIRED' };
        const ids = update ? [...update.plan.selectedEstimateIds] : [...selectedIds];
        const snapshot = await readProducts();
        const confirmedFields = [];
        for (const estimateId of ids) {
          const result = await readRecord(estimateId);
          if (result.status !== 'READY') continue;
          const record = result.record;
          const receipt = update?.receipts.find(item => item.estimateId === estimateId && committed(item));
          if (update && !receipt) continue;
          for (const row of record.ownedRows) for (const field of fields) {
            const processed = receipt?.processedFields.find(item => item.ownedRowId === row.ownedRowId && item.field === field);
            if (update && !processed) continue;
            const value = estimateFieldValue(row, field);
            confirmedFields.push({ companyId, estimateId, ownedRowId: row.ownedRowId, field, code: row.itemCode,
              productId: row.masterProductId || row.productId || '', estimateRevision: record.dataRevision,
              operationId: update?.plan.operationId || 'SELECTED_ESTIMATE', updatePayloadHash: update?.plan.payloadHash || '',
              estimateStatus: processed?.status === 'UNCHANGED' ? 'UNCHANGED' : 'SAVED',
              sourceRefs: processed?.sourceRefs || [row.ownedRowId], valueKind: processed?.valueKind || (value == null || value === '' ? 'BLANK' : 'VALUE'),
              explicitClear: processed?.valueKind === 'CLEAR', value: value ?? null });
          }
        }
        masterIntent = await createEstimateMasterIntent({ enabled: true, commandId: id(), operationId: update?.plan.operationId || id(),
          companyId, actor: active.actor, reason: '선택 견적서 상품관리 업데이트', baseSnapshotId: snapshot.snapshotId,
          baseContentHash: snapshot.contentHash, expectedRevision: snapshot.revision ?? snapshot.snapshotVersion, products: snapshot.data.products,
          confirmedFields, selectedFields: fields, selectedEstimateIds: ids,
          executionMode: update ? 'AFTER_SELECTED_ESTIMATE_UPDATE' : 'SELECTED_ESTIMATES_ONLY' });
        change();
        const result = await executeEstimateMasterIntent({ intent: masterIntent, persistIntent: store.persistEstimateMasterIntent, owner });
        if (['APPLIED', 'UNCHANGED'].includes(result.status) && result.publicationState === 'PUBLISHED') {
          await store.completePendingEstimateOperation({ companyId, kind: 'master', id: masterIntent.command.commandId }); masterIntent = null;
        }
        if (!masterIntent?.command) masterIntent = null;
        return result;
      });
    },
    async retryMaster({ publicationOnly = false } = {}) {
      if (!masterIntent) return { status: 'NO_PENDING_OPERATION' };
      return inFlight(async () => {
        await prepareMaster();
        const active = readMasterContext();
        if (active?.status !== 'READY' || active.companyId !== companyId) return { status: 'CONTEXT_REQUIRED' };
        let result = publicationOnly ? await resumeEstimateMasterPublication({ intent: masterIntent, owner })
          : await executeEstimateMasterIntent({ intent: masterIntent, persistIntent: store.persistEstimateMasterIntent, owner, resume: true });
        if (['APPLIED', 'UNCHANGED'].includes(result.status) && result.publicationState !== 'PUBLISHED') {
          result = await resumeEstimateMasterPublication({ intent: masterIntent, owner });
        }
        if (result.publicationState === 'PUBLISHED' || result.status === 'CONFLICT') {
          await store.completePendingEstimateOperation({ companyId, kind: 'master', id: masterIntent.command.commandId }); masterIntent = null;
        }
        return result;
      });
    },
    async resumePending(kind = 'estimate') {
      const entries = await store.loadPendingEstimateOperations({ companyId });
      const outcomes = [];
      for (const entry of entries) {
        if (kind === 'master' ? entry.kind !== 'master' : entry.kind === 'master') continue;
        if (entry.kind === 'update') outcomes.push(await api.retryUpdate(entry.value));
        else if (entry.kind === 'master') { masterIntent = copy(entry.value); outcomes.push(await api.retryMaster()); }
        else outcomes.push(await inFlight(async () => {
          const active = context(), intent = entry.value;
          if (intent.companyId !== active.companyId || intent.actor.actorId !== active.actor.actorId) fail('ESTIMATE_OPERATION_ACTOR_CHANGED');
          let receipt = await store.getIndependentEstimateEditResult(intent);
          if (receipt.status === 'CONFIRMED_NOT_APPLIED') {
            try { receipt = await store.commitIndependentEstimateEdit(intent); }
            catch (error) {
              if (error.code !== 'ESTIMATE_PREIMAGE_CONFLICT') throw error;
              receipt = { status: 'CONFLICT', estimateId: intent.estimateId, operationId: intent.operationId };
            }
          }
          if (['SAVED', 'UNCHANGED', 'DELETED', 'CONFLICT'].includes(receipt.status)) await store.completePendingEstimateOperation({ companyId, kind: 'edit', id: entry.id });
          return receipt;
        }));
      }
      return { status: outcomes.length ? 'RETRIED' : 'NO_PENDING_OPERATION', outcomes };
    },
    pending: () => store.loadPendingEstimateOperations({ companyId })
  };
  return api;
}

return { createEstimateWorkspace };
})();

// Public API (same functions and constants; no additional command layer).
export const SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA = estimateMasterApplySection.SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA;
export const SMARTINPUT_MASTER_INTENT_SCHEMA = estimateMasterApplySection.SMARTINPUT_MASTER_INTENT_SCHEMA;
export const ESTIMATE_MASTER_FIELDS = estimateMasterApplySection.ESTIMATE_MASTER_FIELDS;
export const createEstimateMasterIntent = estimateMasterApplySection.createEstimateMasterIntent;
export const executeEstimateMasterIntent = estimateMasterApplySection.executeEstimateMasterIntent;
export const resumeEstimateMasterPublication = estimateMasterApplySection.resumeEstimateMasterPublication;
export const createEstimateWorkspace = estimateWorkspaceSection.createEstimateWorkspace;
