import {
  INDEPENDENT_ESTIMATE_SCHEMA, createEstimateSourceIndex, createSelectedEstimateUpdatePlan,
  estimateIdentityFromRow, estimateUpdateFieldDefinitions, estimateFieldValue, estimateValuesEqual,
  buildSelectedEstimateTable, indexEstimateExclusions, applyIndependentDraftWork,
  projectIndependentEstimateDraft, rebaseIndependentEstimateWork
} from './independent-estimate.js';
import { createEstimateMasterIntent, executeEstimateMasterIntent, resumeEstimateMasterPublication,
  ESTIMATE_MASTER_FIELDS } from './estimate-master-apply.js';

const copy = value => structuredClone(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const id = () => crypto.randomUUID();
const committed = receipt => receipt?.committed === true;

/** UI coordinator. Receipts, not optimistic screen state, decide whether a write completed. */
export function createEstimateWorkspace({ store, readContext, readMasterContext = readContext, prepareMaster = async () => {}, reviewMappings = async () => [], readProducts, owner, onChange = () => {} }) {
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
