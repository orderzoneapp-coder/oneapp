import { INDEPENDENT_ESTIMATE_SCHEMA, LAST_ESTIMATE_EXCEL_RESULT_SCHEMA, estimateTechnicalKey,
  estimateValuesEqual, hashEstimatePlan, validateIndependentEstimate, applyIndependentEstimatePatches,
  createLastEstimateExcelResult, projectIndependentEstimateDraft } from './independent-estimate.js?v=0.2.0';

// Local autosave journal and save coordination.
export const AUTOSAVE_JOURNAL_SCHEMA = 'ONEAPP_SMART_INPUT_AUTOSAVE_JOURNAL_V2';
export const SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA = 'ONEAPP_SMARTINPUT_SAVED_WORK_DOCUMENT_V1';

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));
const pathKey = path => path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const pathParts = path => String(path || '').split('/').filter(Boolean)
  .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));

export function createAutosaveDocumentKey({ companyId = '', mode = '', documentId = '' } = {}) {
  if (!companyId || !mode || !documentId) throw new Error('SMARTINPUT_AUTOSAVE_DOCUMENT_KEY_INCOMPLETE');
  return [companyId, mode, documentId].map(value => encodeURIComponent(String(value))).join(':');
}

export function createAutosavePatch(before, after) {
  const operations = [];
  const visit = (left, right, path = []) => {
    if (Object.is(left, right)) return;
    const leftObject = left && typeof left === 'object';
    const rightObject = right && typeof right === 'object';
    if (Array.isArray(left) && Array.isArray(right)) {
      const stableShape = left.length === right.length && left.every((item, index) => {
        const leftId = item && typeof item === 'object' ? item.rowId : null;
        const rightId = right[index] && typeof right[index] === 'object' ? right[index].rowId : null;
        return leftId || rightId ? leftId === rightId : true;
      });
      if (stableShape) {
        right.forEach((value, index) => visit(left[index], value, [...path, index]));
        return;
      }
      operations.push({ op: 'set', path: pathKey(path), value: clone(right) });
      return;
    }
    if (!leftObject || !rightObject || Array.isArray(left) || Array.isArray(right)) {
      operations.push({ op: 'set', path: pathKey(path), value: clone(right) });
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    keys.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(right, key)) operations.push({ op: 'delete', path: pathKey([...path, key]) });
      else visit(left[key], right[key], [...path, key]);
    });
  };
  visit(before, after);
  return operations;
}

export function applyAutosavePatch(snapshot, operations = []) {
  let result = clone(snapshot);
  operations.forEach(operation => {
    const parts = pathParts(operation.path);
    if (!parts.length) {
      result = operation.op === 'delete' ? null : clone(operation.value);
      return;
    }
    let target = result;
    parts.slice(0, -1).forEach(part => {
      if (!target[part] || typeof target[part] !== 'object') target[part] = {};
      target = target[part];
    });
    const leaf = parts.at(-1);
    if (operation.op === 'delete') delete target[leaf];
    else target[leaf] = clone(operation.value);
  });
  return result;
}

function recordsByKey(records = []) {
  return new Map(records.filter(record => record?.key).map(record => [record.key, record]));
}

export function recoverAutosaveDocuments(records = []) {
  const byKey = recordsByKey(records);
  const recovered = new Map();
  records.filter(record => record?.recordType === 'head').forEach(head => {
    const base = byKey.get(head.baseKey);
    if (!base || base.recordType !== 'base' || base.docKey !== head.docKey) return;
    let snapshot = clone(base.snapshot);
    let version = Number(base.version || 0);
    for (const patchKey of head.patchKeys || []) {
      const patch = byKey.get(patchKey);
      if (!patch || patch.recordType !== 'patch' || patch.docKey !== head.docKey || Number(patch.fromVersion) !== version) return;
      snapshot = applyAutosavePatch(snapshot, patch.operations);
      version = Number(patch.toVersion);
    }
    if (version !== Number(head.durableVersion)) return;
    const previous = recovered.get(head.docKey);
    if (!previous || Number(previous.durableVersion) < version) {
      recovered.set(head.docKey, { snapshot, durableVersion: version, head: clone(head) });
    }
  });
  return recovered;
}

export function createDraftSaveCoordinator({ commit, cleanup = async () => {}, now = () => new Date().toISOString(), compactAfter = 40 } = {}) {
  if (typeof commit !== 'function') throw new Error('SMARTINPUT_AUTOSAVE_COMMIT_REQUIRED');
  const documents = new Map();

  const stateFor = docKey => {
    if (!documents.has(docKey)) documents.set(docKey, {
      nextVersion: 0,
      durableVersion: 0,
      durableSnapshot: null,
      head: null,
      pending: null,
      inFlight: null,
      waiters: []
    });
    return documents.get(docKey);
  };

  const settle = state => {
    state.waiters = state.waiters.filter(waiter => {
      if (waiter.version > state.durableVersion) return true;
      waiter.resolve({ durableVersion: state.durableVersion });
      return false;
    });
  };

  const pump = async (docKey, state) => {
    if (state.inFlight || !state.pending) return state.inFlight;
    const pending = state.pending;
    state.pending = null;
    const write = (async () => {
      const timestamp = now();
      const createBase = !state.head || (state.head.patchKeys || []).length >= compactAfter;
      const base = createBase ? {
        key: `base:${docKey}:${pending.version}`,
        schemaVersion: AUTOSAVE_JOURNAL_SCHEMA,
        recordType: 'base', docKey, companyId: pending.companyId,
        version: pending.version, snapshot: pending.snapshot, updatedAt: timestamp
      } : null;
      const patch = createBase ? null : {
        key: `patch:${docKey}:${pending.version}`,
        schemaVersion: AUTOSAVE_JOURNAL_SCHEMA,
        recordType: 'patch', docKey, companyId: pending.companyId,
        fromVersion: state.durableVersion, toVersion: pending.version,
        operations: createAutosavePatch(state.durableSnapshot, pending.snapshot), updatedAt: timestamp
      };
      const head = {
        key: `head:${docKey}`,
        schemaVersion: AUTOSAVE_JOURNAL_SCHEMA,
        recordType: 'head', docKey, companyId: pending.companyId,
        durableVersion: pending.version,
        baseKey: base?.key || state.head.baseKey,
        patchKeys: base ? [] : [...(state.head.patchKeys || []), patch.key],
        updatedAt: timestamp
      };
      await commit({ base, patch, head, workspace: pending.workspace, expectedDurableVersion: state.durableVersion });
      const obsoleteKeys = base && state.head ? [state.head.baseKey, ...(state.head.patchKeys || [])] : [];
      state.durableVersion = pending.version;
      state.durableSnapshot = pending.snapshot;
      state.head = head;
      settle(state);
      if (obsoleteKeys.length) void Promise.resolve(cleanup(obsoleteKeys)).catch(() => undefined);
      return { docKey, durableVersion: pending.version, updatedAt: timestamp };
    })();
    state.inFlight = write;
    let committed = false;
    try {
      const result = await write;
      committed = true;
      return result;
    } catch (error) {
      if (!state.pending || state.pending.version < pending.version) state.pending = pending;
      state.waiters.filter(waiter => waiter.version <= pending.version).forEach(waiter => waiter.reject(error));
      state.waiters = state.waiters.filter(waiter => waiter.version > pending.version);
      throw error;
    } finally {
      state.inFlight = null;
      if (committed && state.pending) void pump(docKey, state).catch(() => undefined);
    }
  };

  return Object.freeze({
    hydrate(records = []) {
      const recovered = recoverAutosaveDocuments(records);
      recovered.forEach((value, docKey) => {
        const state = stateFor(docKey);
        state.nextVersion = value.durableVersion;
        state.durableVersion = value.durableVersion;
        state.durableSnapshot = value.snapshot;
        state.head = value.head;
      });
      return recovered;
    },
    queue({
      companyId,
      mode,
      documentId,
      snapshot,
      workspace = null,
      snapshotOwned = false,
      workspaceOwned = false
    }) {
      const docKey = createAutosaveDocumentKey({ companyId, mode, documentId });
      const state = stateFor(docKey);
      const version = ++state.nextVersion;
      state.pending = {
        companyId,
        version,
        snapshot: snapshotOwned ? snapshot : clone(snapshot),
        workspace: workspace ? (workspaceOwned ? workspace : clone(workspace)) : null
      };
      const promise = new Promise((resolve, reject) => state.waiters.push({ version, resolve, reject }));
      void pump(docKey, state).catch(() => undefined);
      return { docKey, version, promise };
    },
    async flushDocument(docKey) {
      const state = stateFor(docKey);
      // Capture the leave boundary; edits queued later keep their own save tickets.
      const targetVersion = state.nextVersion;
      if (state.inFlight) await state.inFlight.catch(() => undefined);
      while (state.durableVersion < targetVersion) {
        // Completing one write can synchronously start its successor and clear pending.
        if (state.inFlight) await state.inFlight;
        else if (state.pending) await pump(docKey, state);
        else throw new Error('SMARTINPUT_AUTOSAVE_FLUSH_INCOMPLETE');
      }
      return { docKey, durableVersion: state.durableVersion };
    },
    async flushWorkspace() {
      return Promise.all([...documents.keys()].map(docKey => this.flushDocument(docKey)));
    },
    recoveredSnapshot(docKey) {
      const state = stateFor(docKey);
      return state.durableSnapshot ? clone(state.durableSnapshot) : null;
    },
    status(docKey) {
      const state = stateFor(docKey);
      return { nextVersion: state.nextVersion, durableVersion: state.durableVersion, pending: Boolean(state.pending), inFlight: Boolean(state.inFlight) };
    }
  });
}

// Estimate summary projection and bounded immutable read cache.
/* Stage 4 read-only primitives. No DB, app state, selection, or owner writes.
   The stage 3 datastore/UI must supply and adopt authoritative read results. */
export const ESTIMATE_SUMMARY_SCHEMA = 'SMARTINPUT_ESTIMATE_SUMMARY_V1';
export const ESTIMATE_SUMMARY_PREFIX = 'smartinput:estimateSummary:v1:';
export const READ_STATE = Object.freeze(Object.fromEntries(
  ['NOT_LOADED', 'LOADING', 'READY', 'NOT_FOUND', 'ERROR', 'STALE'].map(key => [key, key])
));
const identifier = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value; // Do not coerce codes, drop leading zeroes, or normalize IDs.
};
const revision = value => {
  if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError('A string, finite number, or null revision is required');
  }
  return value;
};
const text = value => String(value ?? '').trim();
const metadataScalar = value => {
  if (value == null) return null;
  if (['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError('Summary metadata must be scalar, not a body object');
};

export function estimateSummaryKey(companyId, estimateId) {
  if (companyId !== null) identifier(companyId, 'companyId');
  return `${ESTIMATE_SUMMARY_PREFIX}${encodeURIComponent(JSON.stringify(companyId))}:${encodeURIComponent(identifier(estimateId, 'estimateId'))}`;
}

/** Derived list metadata only; missing company/revision stays unknown. */
export function projectEstimateSummary(record) {
  identifier(record?.estimateId, 'estimateId');
  const companyId = record.companyId == null || record.companyId === '' ? null : record.companyId;
  if (companyId !== null) identifier(companyId, 'companyId');
  const customerName = text(record.customerName || record.draft?.header?.customerName);
  return Object.freeze({
    summarySchemaVersion: ESTIMATE_SUMMARY_SCHEMA,
    companyId,
    estimateId: record.estimateId,
    title: text(record.catalogName) || customerName || '견적서명 미지정',
    customerId: text(record.customerId || record.draft?.header?.customerId),
    customerCode: text(record.customerCode || record.draft?.header?.customerCode),
    customerName,
    createdAt: metadataScalar(record.createdAt),
    updatedAt: metadataScalar(record.updatedAt),
    sortOrder: metadataScalar(record.sortOrder),
    sourceRevision: revision(record.dataRevision ?? null),
    status: typeof record.status === 'string' ? record.status : null
  });
}

function normalizeRequest(input) {
  if (!['body', 'image'].includes(input?.kind)) throw new TypeError('Unknown read kind');
  return Object.freeze({ kind: input.kind, companyId: identifier(input.companyId, 'companyId'),
    id: identifier(input.id, 'id'), revision: revision(input.revision ?? null) });
}
export function estimateReadKey(input) {
  const r = normalizeRequest(input);
  return JSON.stringify([r.kind, r.companyId, r.id, [typeof r.revision, Object.is(r.revision, -0) ? '-0' : r.revision]]);
}

function freezeValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  // Blob is immutable. JSON bodies and image metadata have no mutable buffers.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new TypeError('Use Blob for binary images');
  Object.values(value).forEach(child => freezeValue(child, seen));
  return Object.freeze(value);
}
function payloadBytes(value, seen = new WeakSet()) {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  return Object.entries(value).reduce((total, [key, item]) => total + key.length * 2 + payloadBytes(item, seen), 0);
}
const result = (status, fields = {}) => Object.freeze({ status, ...fields });

/**
 * read(request, {signal}) must return {status:'READY', value, revision},
 * {status:'NOT_FOUND'}, or {status:'ERROR', error}. A null response is an error,
 * not absence. Callers retain dirty working copies outside this disposable cache.
 * Timeout abort is advisory: a permit is held until the physical reader settles.
 */
export function createEstimateReadCache({ read, maxConcurrent = 4, maxEntries = 32,
  maxBytes = 64 * 1024 * 1024, timeoutMs = 30000, isProtected = () => false } = {}) {
  if (typeof read !== 'function' || typeof isProtected !== 'function') throw new TypeError('Read callbacks required');
  if (![maxConcurrent, maxEntries].every(Number.isInteger) || maxConcurrent < 1 || maxEntries < 0 ||
      !Number.isFinite(maxBytes) || maxBytes < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Invalid cache limits');
  }
  const entries = new Map(), queue = [];
  let active = 0, clock = 0, bytes = 0, disposed = false;
  const current = entry => !disposed && entries.get(entry.key) === entry && !entry.done;
  const snapshot = entry => entry ? result(entry.status, entry.outcome || {}) : result(READ_STATE.NOT_LOADED);
  function finish(entry, status, fields = {}) {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    entry.status = status;
    entry.outcome = fields;
    entry.resolve(snapshot(entry));
  }
  function remove(entry) {
    if (entries.get(entry.key) !== entry) return;
    bytes -= entry.bytes;
    entries.delete(entry.key);
  }
  function prune() {
    // LRU covers clean cached data and negative/error metadata, not in-flight reads.
    const candidates = [...entries.values()].filter(e => e.done && !isProtected(e.request))
      .sort((a, b) => a.used - b.used);
    while ((entries.size > maxEntries || bytes > maxBytes) && candidates.length) remove(candidates.shift());
  }
  function pump() {
    while (!disposed && active < maxConcurrent && queue.length) {
      const entry = queue.shift();
      if (!current(entry)) continue;
      active++;
      Promise.resolve().then(() => current(entry) ? read(entry.request, { signal: entry.controller.signal }) : null)
        .then(response => {
          if (!current(entry)) return;
          if (response?.status === READ_STATE.NOT_FOUND) return finish(entry, READ_STATE.NOT_FOUND);
          if (response?.status === READ_STATE.ERROR) throw response.error || new Error('Read failed');
          if (response?.status !== READ_STATE.READY || response.value == null) throw new Error('Invalid read response');
          const actual = revision(response.revision ?? null);
          if (entry.request.revision !== null && !Object.is(actual, entry.request.revision)) {
            return finish(entry, READ_STATE.STALE, { reason: 'REVISION_MISMATCH' });
          }
          const value = freezeValue(structuredClone(response.value));
          entry.bytes = payloadBytes(value);
          bytes += entry.bytes;
          finish(entry, READ_STATE.READY, { value, revision: actual });
        }).catch(error => {
          if (current(entry)) finish(entry, READ_STATE.ERROR, { error });
        }).finally(() => { active--; prune(); pump(); });
    }
  }
  function load(input) {
    if (disposed) return Promise.resolve(result(READ_STATE.STALE, { reason: 'DISPOSED' }));
    const request = normalizeRequest(input), key = estimateReadKey(request), prior = entries.get(key);
    if (prior && [READ_STATE.READY, READ_STATE.NOT_FOUND, READ_STATE.LOADING].includes(prior.status)) {
      prior.used = ++clock;
      return prior.promise;
    }
    if (prior) remove(prior);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const entry = { request, key, promise, resolve, status: READ_STATE.LOADING, bytes: 0, used: ++clock,
      controller: new AbortController(), done: false };
    entries.set(key, entry);
    entry.timer = setTimeout(() => {
      if (!current(entry)) return;
      const error = Object.assign(new Error('Read timed out; absence is not established'), { code: 'READ_TIMEOUT' });
      finish(entry, READ_STATE.ERROR, { error });
      entry.controller.abort();
      prune(); pump();
    }, timeoutMs);
    queue.push(entry);
    pump();
    return promise;
  }
  function invalidate(predicate = () => true) {
    for (const entry of entries.values()) {
      if (!predicate(entry.request)) continue;
      remove(entry);
      finish(entry, READ_STATE.STALE, { reason: 'INVALIDATED' });
      entry.controller.abort();
    }
    // Drop queued references as well, without cancelling unrelated reads.
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].done) queue.splice(i, 1);
  }
  async function prepareSelectedEstimateBodies({ companyId, selectedIds, revisions = new Map(), isCurrent = () => true }) {
    identifier(companyId, 'companyId');
    const ids = Object.freeze([...new Set([...selectedIds].map(id => identifier(id, 'estimateId')))]);
    // Snapshot revision lookup too; an in-flight caller must not change this plan.
    const requests = ids.map(id => normalizeRequest({ kind: 'body', companyId, id, revision: revisions.get(id) ?? null }));
    const outcomes = await Promise.all(requests.map(request => isCurrent() ? load(request)
      : Promise.resolve(result(READ_STATE.STALE, { reason: 'CALLER_CHANGED' }))));
    const valid = isCurrent();
    return Object.freeze({ selectedIds: ids, results: Object.freeze(ids.map((estimateId, index) =>
      Object.freeze({ estimateId, ...(valid ? outcomes[index] : result(READ_STATE.STALE, { reason: 'CALLER_CHANGED' })) }))) });
  }
  return Object.freeze({
    load, invalidate, prune, prepareSelectedEstimateBodies,
    peek: input => snapshot(entries.get(estimateReadKey(input))),
    stats: () => Object.freeze({ entries: entries.size, activeReads: active, queuedReads: queue.filter(e => !e.done).length,
      estimatedPayloadBytes: bytes, protectedEntries: [...entries.values()].filter(e => isProtected(e.request)).length }),
    dispose: () => { if (disposed) return; invalidate(); disposed = true; queue.length = 0; }
  });
}

export const SMARTINPUT_DB_NAME = 'oneapp-smartinput';
export const SMARTINPUT_DB_VERSION = 5;
const DB_NAME = SMARTINPUT_DB_NAME;
const DB_VERSION = SMARTINPUT_DB_VERSION;
const FALLBACK_KEY = 'oneapp.smartinput.relationships.v1';
const INPUT_TEMPLATES_KEY = 'inputTemplates';

export const DATA_STORES = Object.freeze({
  SETTINGS: 'settings',
  LINK_GROUPS: 'customerLinkGroups',
  TEMPORARY_CUSTOMERS: 'temporaryCustomers',
  ALIAS_MAPPINGS: 'customerAliasMappings',
  ESTIMATES: 'estimates',
  SOURCE_IMAGES: 'sourceImages',
  AUTOSAVE: 'autosave',
  FIELD_DEFINITIONS_V2: 'fieldDefinitionsV2',
  COMPANY_VOUCHER_FIELDS_V1: 'companyVoucherFieldsV1',
  REFERENCE_GENERATIONS_V1: 'referenceGenerationsV1',
  REFERENCE_ENTITIES_V1: 'referenceEntitiesV1',
  INPUT_TEMPLATES_V2: 'inputTemplatesV2',
  MAPPING_SESSIONS_V2: 'mappingSessionsV2',
  DRAFT_VOUCHERS_V2: 'draftVouchersV2'
});

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('스마트입력 저장소 요청에 실패했습니다.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('스마트입력 저장이 취소되었습니다.'));
    transaction.onerror = () => reject(transaction.error || new Error('스마트입력 저장에 실패했습니다.'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DATA_STORES.SETTINGS)) db.createObjectStore(DATA_STORES.SETTINGS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(DATA_STORES.LINK_GROUPS)) {
        const store = db.createObjectStore(DATA_STORES.LINK_GROUPS, { keyPath: 'linkGroupId' });
        store.createIndex('byTaxCustomerId', 'taxCustomerId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.TEMPORARY_CUSTOMERS)) {
        const store = db.createObjectStore(DATA_STORES.TEMPORARY_CUSTOMERS, { keyPath: 'customerId' });
        store.createIndex('byLinkGroupId', 'linkGroupId', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.ALIAS_MAPPINGS)) {
        const store = db.createObjectStore(DATA_STORES.ALIAS_MAPPINGS, { keyPath: 'aliasMappingId' });
        store.createIndex('byNormalizedName', 'normalizedName', { unique: false });
        store.createIndex('byContextKey', 'contextKey', { unique: false });
        store.createIndex('byStatus', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.ESTIMATES)) {
        const store = db.createObjectStore(DATA_STORES.ESTIMATES, { keyPath: 'estimateId' });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        store.createIndex('byCustomerName', 'customerName', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.SOURCE_IMAGES)) {
        const store = db.createObjectStore(DATA_STORES.SOURCE_IMAGES, { keyPath: 'documentId' });
        store.createIndex('byMode', 'mode', { unique: false });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.AUTOSAVE)) {
        db.createObjectStore(DATA_STORES.AUTOSAVE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.FIELD_DEFINITIONS_V2)) {
        const store = db.createObjectStore(DATA_STORES.FIELD_DEFINITIONS_V2, { keyPath: ['generationId', 'fieldId'] });
        store.createIndex('byGeneration', 'generationId', { unique: false });
        store.createIndex('byGenerationMode', ['generationId', 'voucherMode'], { unique: false, multiEntry: false });
        store.createIndex('byStatus', ['generationId', 'status'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1)) {
        const store = db.createObjectStore(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1, { keyPath: ['companyId', 'voucherMode', 'fieldId'] });
        store.createIndex('byCompanyMode', ['companyId', 'voucherMode'], { unique: false });
        store.createIndex('byEnabled', ['companyId', 'voucherMode', 'enabled'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.REFERENCE_GENERATIONS_V1)) {
        const store = db.createObjectStore(DATA_STORES.REFERENCE_GENERATIONS_V1, { keyPath: 'generationId' });
        store.createIndex('byCompanyStatus', ['companyId', 'status'], { unique: false });
        store.createIndex('byActivatedAt', 'activatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.REFERENCE_ENTITIES_V1)) {
        const store = db.createObjectStore(DATA_STORES.REFERENCE_ENTITIES_V1, { keyPath: ['generationId', 'domain', 'entityId'] });
        store.createIndex('byGenerationDomain', ['generationId', 'domain'], { unique: false });
        store.createIndex('byCompanyDomainCode', ['companyId', 'domain', 'code'], { unique: false });
        store.createIndex('bySearchText', ['generationId', 'domain', 'searchText'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.INPUT_TEMPLATES_V2)) {
        const store = db.createObjectStore(DATA_STORES.INPUT_TEMPLATES_V2, { keyPath: 'templateId' });
        store.createIndex('byCompanyModeSignature', ['companyId', 'voucherMode', 'signature'], { unique: true });
        store.createIndex('byCompanyModeStatus', ['companyId', 'voucherMode', 'status'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.MAPPING_SESSIONS_V2)) {
        const store = db.createObjectStore(DATA_STORES.MAPPING_SESSIONS_V2, { keyPath: 'sessionId' });
        store.createIndex('byCompanyModeUpdatedAt', ['companyId', 'voucherMode', 'updatedAt'], { unique: false });
      }
      if (!db.objectStoreNames.contains(DATA_STORES.DRAFT_VOUCHERS_V2)) {
        const store = db.createObjectStore(DATA_STORES.DRAFT_VOUCHERS_V2, { keyPath: 'draftId' });
        store.createIndex('byCompanyModeStatus', ['companyId', 'voucherMode', 'status'], { unique: false });
        store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        store.createIndex('byIdempotencyKey', 'idempotencyKey', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      const error = new Error('다른 화면이 스마트입력 저장소 갱신을 막고 있습니다. 열려 있는 스마트입력 화면을 닫고 다시 시도하세요.');
      error.code = 'SMARTINPUT_DB_UPGRADE_BLOCKED';
      reject(error);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error || new Error('스마트입력 저장소를 열지 못했습니다.'));
    };
  });
}

function readFallback() {
  try {
    const value = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function writeFallback(value) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(value));
}

function canonicalRecord(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRecord).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalRecord(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertEstimatePreimages(currentRecords, expectedPreimages = []) {
  for (const expected of expectedPreimages) {
    if (!expected?.estimateId) throw new Error('SMARTINPUT_ESTIMATE_BUNDLE_PREIMAGE_INVALID');
    const current = currentRecords[expected.estimateId] || null;
    if (canonicalRecord(current) !== canonicalRecord(expected)) {
      throw new Error('SMARTINPUT_ESTIMATE_BUNDLE_STALE');
    }
  }
}

async function getAll(storeName) {
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[storeName] || {});
  const transaction = db.transaction(storeName, 'readonly');
  const rows = await requestResult(transaction.objectStore(storeName).getAll());
  db.close();
  return rows;
}

function assertAliasPreimages(currentRecords, expectedPreimages = []) {
  for (const expected of expectedPreimages) {
    if (!expected?.aliasMappingId) throw new Error('SMARTINPUT_ESTIMATE_LINK_ALIAS_PREIMAGE_INVALID');
    const current = currentRecords[expected.aliasMappingId] || null;
    if (canonicalRecord(current) !== canonicalRecord(expected)) {
      throw new Error('SMARTINPUT_ESTIMATE_LINK_BUNDLE_STALE');
    }
  }
}

function assertExpectedMissing(currentRecords, expectedMissingIds = [], code) {
  for (const id of expectedMissingIds) {
    if (!id) throw new Error('SMARTINPUT_ESTIMATE_LINK_EXPECTED_MISSING_INVALID');
    if (currentRecords[id]) throw new Error(code);
  }
}

async function getAllStores(storeNames = []) {
  const names = [...new Set(storeNames.filter(Boolean))];
  if (!names.length) return {};
  const db = await openDatabase();
  if (!db) {
    const fallback = readFallback();
    return Object.fromEntries(names.map(storeName => [storeName, Object.values(fallback[storeName] || {})]));
  }
  const transaction = db.transaction(names, 'readonly');
  const completed = transactionDone(transaction);
  try {
    const rows = await Promise.all(names.map(storeName => requestResult(transaction.objectStore(storeName).getAll())));
    await completed;
    return Object.fromEntries(names.map((storeName, index) => [storeName, rows[index]]));
  } catch (error) {
    await completed.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

async function get(storeName, key) {
  const db = await openDatabase();
  if (!db) return readFallback()[storeName]?.[key] || null;
  const transaction = db.transaction(storeName, 'readonly');
  const record = await requestResult(transaction.objectStore(storeName).get(key));
  db.close();
  return record || null;
}

async function put(storeName, record, keyField) {
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[storeName] ||= {};
    value[storeName][record[keyField]] = record;
    writeFallback(value);
    return record;
  }
  const transaction = db.transaction(storeName === DATA_STORES.ESTIMATES ? [storeName, DATA_STORES.SETTINGS] : storeName, 'readwrite');
  if (storeName === DATA_STORES.ESTIMATES) updateEstimateProjection(transaction, record, record.estimateId);
  if (storeName === DATA_STORES.SOURCE_IMAGES) transaction.addEventListener('complete', () => invalidateCachedRead(record.documentId), { once: true });
  transaction.objectStore(storeName).put(record);
  await transactionDone(transaction);
  db.close();
  return record;
}

async function remove(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    if (value[storeName]) delete value[storeName][key];
    writeFallback(value);
    return;
  }
  const transaction = db.transaction(storeName === DATA_STORES.ESTIMATES ? [storeName, DATA_STORES.SETTINGS] : storeName, 'readwrite');
  if (storeName === DATA_STORES.ESTIMATES) updateEstimateProjection(transaction, null, key);
  if (storeName === DATA_STORES.SOURCE_IMAGES) transaction.addEventListener('complete', () => invalidateCachedRead(key), { once: true });
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
  db.close();
}

function savedWorkDocumentError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function savedWorkSourceImageSnapshot(sourceImage, { companyId, voucherMode, documentId, updatedAt }) {
  if (sourceImage == null) return null;
  const dataUrl = String(sourceImage.dataUrl || '');
  const sourceImageId = String(sourceImage.sourceImageId || '').trim();
  if (!sourceImage || typeof sourceImage !== 'object' || Array.isArray(sourceImage)
    || !sourceImageId || !/^data:image\/[^,]+;base64,/i.test(dataUrl)) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_SOURCE_IMAGE_INVALID');
  }
  if (!globalThis.crypto?.subtle) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_SOURCE_IMAGE_HASH_UNAVAILABLE', '원본 사진의 무결성을 확인할 수 없어 자료를 저장하지 않았습니다.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
  const sourceImageFingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  // The original capture already keeps the base64 in dataUrl. Do not store it twice.
  return {
    documentId, companyId, mode: voucherMode, sourceImageId,
    sourceImageFingerprint,
    fileName: String(sourceImage.fileName || ''),
    mimeType: String(sourceImage.mimeType || ''),
    byteLength: Number(sourceImage.byteLength || 0),
    contentHash: String(sourceImage.contentHash || ''),
    dataUrl,
    notice: String(sourceImage.notice || ''),
    updatedAt
  };
}

function assertSavedWorkDocumentRequest({ companyId, voucherMode, documentId, expectedRevision, operationId, payload } = {}) {
  if (!String(companyId || '').trim() || !['purchase', 'sale', 'order'].includes(String(voucherMode || '').trim())) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_SCOPE_INVALID');
  }
  if (!String(documentId || '').trim() || !String(operationId || '').trim()
    || !Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_IDENTITY_INVALID');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || String(payload.mode || '') !== String(voucherMode)) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_PAYLOAD_INVALID');
  }
}

function nextSavedWorkDocument({ current, companyId, voucherMode, documentId, expectedRevision, operationId, title, actorId, payload, summary, updatedAt, sourceImage }) {
  const expected = Number(expectedRevision);
  const operationFingerprint = canonicalRecord({ companyId, voucherMode, documentId, expectedRevision: expected, payload,
    sourceImageId: sourceImage?.sourceImageId || '', sourceImageFingerprint: sourceImage?.sourceImageFingerprint || '' });
  if (current?.companyId && current.companyId !== companyId) throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_ID_COLLISION');
  if (current && (current.voucherMode !== voucherMode || current.schemaVersion !== SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA)) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_ID_COLLISION');
  }
  if (current?.lastOperationId === operationId) {
    if (current.lastOperationFingerprint !== operationFingerprint) {
      throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_OPERATION_CONFLICT', '같은 저장 요청 ID에 서로 다른 입력 내용이 연결되어 저장하지 않았습니다.');
    }
    return { record: current, idempotent: true };
  }
  const currentRevision = Number(current?.revision || 0);
  if (currentRevision !== expected || (!current && expected !== 0)) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_REVISION_CONFLICT', '이 자료가 다른 화면에서 먼저 변경되었습니다. 최신 자료를 다시 연 뒤 수정하세요.');
  }
  const timestamp = String(updatedAt || new Date().toISOString());
  return {
    idempotent: false,
    record: {
      draftId: documentId,
      schemaVersion: SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA,
      companyId,
      voucherMode,
      documentId,
      status: 'SAVED',
      revision: currentRevision + 1,
      title: String(title || '').trim(),
      actorId: String(actorId || '').trim(),
      summary: summary && typeof summary === 'object' ? clone(summary) : {},
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
      lastOperationId: operationId,
      idempotencyKey: operationId,
      lastOperationFingerprint: operationFingerprint,
      sourceImageId: sourceImage?.sourceImageId || '',
      sourceImageFingerprint: sourceImage?.sourceImageFingerprint || '',
      payload: clone(payload)
    }
  };
}

/** Saves a SmartInput-owned work document without touching an official voucher owner. */
export async function commitSmartInputWorkDocument(request = {}) {
  const normalized = {
    ...request,
    companyId: String(request.companyId || '').trim(),
    voucherMode: String(request.voucherMode || '').trim(),
    documentId: String(request.documentId || '').trim(),
    operationId: String(request.operationId || '').trim(),
    expectedRevision: Number(request.expectedRevision || 0),
    updatedAt: String(request.updatedAt || new Date().toISOString())
  };
  assertSavedWorkDocumentRequest(normalized);
  normalized.sourceImage = await savedWorkSourceImageSnapshot(request.sourceImage, normalized);
  if (normalized.payload.activeMethod === 'photo' && !normalized.sourceImage) {
    throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_SOURCE_IMAGE_MISSING', '원본 사진을 확인할 수 없어 자료를 저장하지 않았습니다.');
  }
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.DRAFT_VOUCHERS_V2] ||= {};
    value[DATA_STORES.SOURCE_IMAGES] ||= {};
    const current = value[DATA_STORES.DRAFT_VOUCHERS_V2][normalized.documentId] || null;
    const currentImage = value[DATA_STORES.SOURCE_IMAGES][normalized.documentId] || null;
    if (currentImage && (!current || currentImage.companyId !== normalized.companyId
      || currentImage.mode !== normalized.voucherMode)) throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_ID_COLLISION');
    const result = nextSavedWorkDocument({ ...normalized, current });
    if (result.idempotent) {
      if (result.record.sourceImageFingerprint && (!currentImage
        || currentImage.sourceImageFingerprint !== result.record.sourceImageFingerprint
        || currentImage.dataUrl !== normalized.sourceImage?.dataUrl)) {
        throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_SOURCE_IMAGE_MISSING');
      }
      return { ...result, record: clone(result.record) };
    }
    value[DATA_STORES.DRAFT_VOUCHERS_V2][normalized.documentId] = result.record;
    if (normalized.sourceImage) value[DATA_STORES.SOURCE_IMAGES][normalized.documentId] = normalized.sourceImage;
    else delete value[DATA_STORES.SOURCE_IMAGES][normalized.documentId];
    writeFallback(value);
    invalidateCachedRead(normalized.documentId);
    return { ...result, record: clone(result.record) };
  }
  const transaction = db.transaction([DATA_STORES.DRAFT_VOUCHERS_V2, DATA_STORES.SOURCE_IMAGES], 'readwrite');
  const store = transaction.objectStore(DATA_STORES.DRAFT_VOUCHERS_V2);
  const imageStore = transaction.objectStore(DATA_STORES.SOURCE_IMAGES);
  const completed = transactionDone(transaction);
  try {
    const [current, currentImage] = await Promise.all([
      requestResult(store.get(normalized.documentId)),
      requestResult(imageStore.get(normalized.documentId))
    ]);
    if (currentImage && (!current || currentImage.companyId !== normalized.companyId
      || currentImage.mode !== normalized.voucherMode)) throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_ID_COLLISION');
    const result = nextSavedWorkDocument({ ...normalized, current: current || null });
    if (result.idempotent) {
      if (result.record.sourceImageFingerprint && (!currentImage
        || currentImage.sourceImageFingerprint !== result.record.sourceImageFingerprint
        || currentImage.dataUrl !== normalized.sourceImage?.dataUrl)) {
        throw savedWorkDocumentError('SMARTINPUT_WORK_DOCUMENT_SOURCE_IMAGE_MISSING');
      }
    } else {
      if (normalized.sourceImage) imageStore.put(normalized.sourceImage);
      else if (currentImage) imageStore.delete(normalized.documentId);
      store.put(result.record);
      transaction.addEventListener('complete', () => invalidateCachedRead(normalized.documentId), { once: true });
    }
    await completed;
    return { ...result, record: clone(result.record) };
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await completed.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export async function listSmartInputWorkDocuments({ companyId = '', voucherMode = '', limit = 200 } = {}) {
  const company = String(companyId || '').trim();
  const mode = String(voucherMode || '').trim();
  if (!company || !['purchase', 'sale', 'order'].includes(mode)) return [];
  const maximum = Math.min(500, Math.max(1, Number(limit) || 200));
  const db = await openDatabase();
  let records;
  if (!db) {
    records = Object.values(readFallback()[DATA_STORES.DRAFT_VOUCHERS_V2] || {});
  } else {
    const transaction = db.transaction(DATA_STORES.DRAFT_VOUCHERS_V2, 'readonly');
    const completed = transactionDone(transaction);
    try {
      const store = transaction.objectStore(DATA_STORES.DRAFT_VOUCHERS_V2);
      const keyRange = globalThis.IDBKeyRange?.only?.([company, mode, 'SAVED']);
      records = keyRange ? await requestResult(store.index('byCompanyModeStatus').getAll(keyRange)) : await requestResult(store.getAll());
      await completed;
    } catch (error) {
      await completed.catch(() => {});
      throw error;
    } finally {
      db.close();
    }
  }
  return records
    .filter(record => record?.schemaVersion === SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA
      && record.companyId === company && record.voucherMode === mode && record.status === 'SAVED')
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, maximum)
    .map(({ payload, ...summary }) => clone(summary));
}

export async function loadSmartInputWorkDocument({ companyId = '', documentId = '' } = {}) {
  const company = String(companyId || '').trim();
  const id = String(documentId || '').trim();
  if (!company || !id) return { status: 'MISSING', record: null };
  const db = await openDatabase();
  let record, sourceImage;
  if (!db) {
    const fallback = readFallback();
    record = fallback[DATA_STORES.DRAFT_VOUCHERS_V2]?.[id] || null;
    sourceImage = fallback[DATA_STORES.SOURCE_IMAGES]?.[id] || null;
  } else {
    const transaction = db.transaction([DATA_STORES.DRAFT_VOUCHERS_V2, DATA_STORES.SOURCE_IMAGES], 'readonly');
    const completed = transactionDone(transaction);
    try {
      [record, sourceImage] = await Promise.all([
        requestResult(transaction.objectStore(DATA_STORES.DRAFT_VOUCHERS_V2).get(id)),
        requestResult(transaction.objectStore(DATA_STORES.SOURCE_IMAGES).get(id))
      ]);
      await completed;
    } catch (error) {
      await completed.catch(() => {});
      throw error;
    } finally {
      db.close();
    }
  }
  if (!record || record.schemaVersion !== SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA || record.status !== 'SAVED') {
    return { status: 'MISSING', record: null };
  }
  if (record.companyId !== company) return { status: 'COMPANY_MISMATCH', record: null };
  if (!record.payload || record.payload.mode !== record.voucherMode) {
    return { status: 'INVALID', record: null };
  }
  if (record.payload.activeMethod === 'photo' && !record.sourceImageFingerprint) {
    return { status: 'INVALID', record: null };
  }
  if (record.sourceImageFingerprint) {
    if (!sourceImage || sourceImage.companyId !== company || sourceImage.mode !== record.voucherMode
      || sourceImage.sourceImageId !== record.sourceImageId
      || sourceImage.sourceImageFingerprint !== record.sourceImageFingerprint) {
      return { status: 'INVALID', record: null };
    }
    const verified = await savedWorkSourceImageSnapshot(sourceImage, {
      companyId: company, voucherMode: record.voucherMode, documentId: id, updatedAt: sourceImage.updatedAt
    });
    if (verified.sourceImageFingerprint !== record.sourceImageFingerprint) return { status: 'INVALID', record: null };
  } else if (sourceImage) {
    return { status: 'INVALID', record: null };
  }
  return { status: 'READY', record: clone(record), sourceImage: sourceImage ? clone(sourceImage) : null };
}

export function normalizeAliasName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,:;·_()[\]{}<>]/g, '');
}

export function createRecordId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function sortedEstimates(estimates = []) {
  return estimates.sort((left, right) => {
    const leftOrder = Number(left.sortOrder);
    const rightOrder = Number(right.sortOrder);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (Number.isFinite(leftOrder) !== Number.isFinite(rightOrder)) return Number.isFinite(leftOrder) ? -1 : 1;
    return String(left.createdAt || left.updatedAt || '').localeCompare(String(right.createdAt || right.updatedAt || ''));
  });
}

export async function loadEstimateLibrary() {
  return sortedEstimates(await getAll(DATA_STORES.ESTIMATES));
}

export async function loadSmartInputData({ includeEstimates = true, includeSourceImages = true } = {}) {
  const storeNames = [
    DATA_STORES.LINK_GROUPS,
    DATA_STORES.TEMPORARY_CUSTOMERS,
    DATA_STORES.ALIAS_MAPPINGS,
    ...(includeEstimates ? [DATA_STORES.ESTIMATES] : []),
    ...(includeSourceImages ? [DATA_STORES.SOURCE_IMAGES] : [])
  ];
  const [rowsByStore, settingsRows] = await Promise.all([
    getAllStores(storeNames),
    Promise.all(['app', INPUT_TEMPLATES_KEY, 'reference:product', 'reference:customer'].map(key => get(DATA_STORES.SETTINGS, key)))
      .then(rows => rows.filter(Boolean))
  ]);
  const linkGroups = rowsByStore[DATA_STORES.LINK_GROUPS] || [];
  const temporaryCustomers = rowsByStore[DATA_STORES.TEMPORARY_CUSTOMERS] || [];
  const aliasMappings = rowsByStore[DATA_STORES.ALIAS_MAPPINGS] || [];
  const estimates = rowsByStore[DATA_STORES.ESTIMATES] || [];
  const sourceImages = rowsByStore[DATA_STORES.SOURCE_IMAGES] || [];
  return {
    settings: settingsRows.find(row => row.key === 'app')?.value || null,
    inputTemplates: Array.isArray(settingsRows.find(row => row.key === INPUT_TEMPLATES_KEY)?.value)
      ? settingsRows.find(row => row.key === INPUT_TEMPLATES_KEY).value
      : [],
    referenceCache: {
      product: settingsRows.find(row => row.key === 'reference:product')?.value || null,
      customer: settingsRows.find(row => row.key === 'reference:customer')?.value || null
    },
    linkGroups,
    temporaryCustomers,
    aliasMappings,
    estimates: sortedEstimates(estimates),
    sourceImages
  };
}

export function saveSettings(value) {
  return put(DATA_STORES.SETTINGS, { key: 'app', value, updatedAt: new Date().toISOString() }, 'key');
}

export async function loadSettingValue(key) {
  return (await get(DATA_STORES.SETTINGS, String(key || '').trim()))?.value ?? null;
}

export function saveSettingValue(key, value) {
  const normalized = String(key || '').trim();
  if (!normalized) return Promise.reject(new Error('SMARTINPUT_SETTING_KEY_REQUIRED'));
  return put(DATA_STORES.SETTINGS, { key: normalized, value, updatedAt: new Date().toISOString() }, 'key');
}

function fallbackCompositeKey(parts = []) {
  return parts.map(value => String(value ?? '')).join('\u001f');
}

export async function replaceFieldCatalogGeneration(catalog = {}) {
  const generationId = String(catalog.generationId || '').trim();
  const definitions = Array.isArray(catalog.definitions) ? catalog.definitions : [];
  if (!generationId || !definitions.length) throw new Error('SMARTINPUT_FIELD_CATALOG_INVALID');
  const rows = definitions.map(definition => ({
    ...JSON.parse(JSON.stringify(definition)),
    generationId,
    voucherMode: String(definition.voucherModes?.[0] || '')
  }));
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.FIELD_DEFINITIONS_V2] ||= {};
    Object.keys(value[DATA_STORES.FIELD_DEFINITIONS_V2])
      .filter(key => key.startsWith(`${generationId}\u001f`))
      .forEach(key => { delete value[DATA_STORES.FIELD_DEFINITIONS_V2][key]; });
    rows.forEach(row => { value[DATA_STORES.FIELD_DEFINITIONS_V2][fallbackCompositeKey([generationId, row.fieldId])] = row; });
    writeFallback(value);
    return rows;
  }
  const tx = db.transaction(DATA_STORES.FIELD_DEFINITIONS_V2, 'readwrite');
  const store = tx.objectStore(DATA_STORES.FIELD_DEFINITIONS_V2);
  const keys = await requestResult(store.index('byGeneration').getAllKeys(generationId));
  keys.forEach(key => store.delete(key));
  rows.forEach(row => store.put(row));
  await transactionDone(tx);
  db.close();
  return rows;
}

export async function loadFieldDefinitions(generationId) {
  const normalized = String(generationId || '').trim();
  if (!normalized) return [];
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[DATA_STORES.FIELD_DEFINITIONS_V2] || {})
    .filter(row => row.generationId === normalized);
  const tx = db.transaction(DATA_STORES.FIELD_DEFINITIONS_V2, 'readonly');
  const rows = await requestResult(tx.objectStore(DATA_STORES.FIELD_DEFINITIONS_V2).index('byGeneration').getAll(normalized));
  db.close();
  return rows;
}

export async function loadCompanyVoucherFieldSettings(companyId, voucherMode) {
  const company = String(companyId || '').trim();
  const mode = String(voucherMode || '').trim();
  if (!company || !mode) return [];
  const db = await openDatabase();
  if (!db) return Object.values(readFallback()[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1] || {})
    .filter(row => row.companyId === company && row.voucherMode === mode);
  const tx = db.transaction(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1, 'readonly');
  const rows = await requestResult(tx.objectStore(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1).index('byCompanyMode').getAll([company, mode]));
  db.close();
  return rows;
}

export async function saveCompanyVoucherFieldSettings(settings = []) {
  const rows = Array.isArray(settings) ? settings.map(row => JSON.parse(JSON.stringify(row))) : [];
  if (!rows.length) return [];
  const companyId = String(rows[0].companyId || '').trim();
  const voucherMode = String(rows[0].voucherMode || '').trim();
  if (!companyId || !voucherMode || rows.some(row => row.companyId !== companyId || row.voucherMode !== voucherMode)) {
    throw new Error('SMARTINPUT_FIELD_SETTING_PARTITION_INVALID');
  }
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1] ||= {};
    Object.keys(value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1]).filter(key => key.startsWith(`${companyId}\u001f${voucherMode}\u001f`))
      .forEach(key => { delete value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1][key]; });
    rows.forEach(row => { value[DATA_STORES.COMPANY_VOUCHER_FIELDS_V1][fallbackCompositeKey([companyId, voucherMode, row.fieldId])] = row; });
    writeFallback(value);
    return rows;
  }
  const tx = db.transaction(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1, 'readwrite');
  const store = tx.objectStore(DATA_STORES.COMPANY_VOUCHER_FIELDS_V1);
  const keys = await requestResult(store.index('byCompanyMode').getAllKeys([companyId, voucherMode]));
  keys.forEach(key => store.delete(key));
  rows.forEach(row => store.put(row));
  await transactionDone(tx);
  db.close();
  return rows;
}

export async function saveReferenceGenerationState(generation) {
  if (!generation?.generationId || !generation?.companyId) throw new Error('SMARTINPUT_REFERENCE_GENERATION_INVALID');
  return put(DATA_STORES.REFERENCE_GENERATIONS_V1, generation, 'generationId');
}

export async function activateReferenceGeneration({ generation, entities = [] } = {}) {
  if (!generation?.generationId || !generation?.companyId) throw new Error('SMARTINPUT_REFERENCE_GENERATION_INVALID');
  const pointerKey = `referenceActive:${generation.companyId}`;
  const activeGeneration = { ...JSON.parse(JSON.stringify(generation)), status: 'ACTIVE', activatedAt: new Date().toISOString() };
  const rows = entities.map(row => ({ ...JSON.parse(JSON.stringify(row)), generationId: activeGeneration.generationId, companyId: activeGeneration.companyId }));
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.REFERENCE_GENERATIONS_V1] ||= {};
    value[DATA_STORES.REFERENCE_ENTITIES_V1] ||= {};
    const previousId = value[DATA_STORES.SETTINGS]?.[pointerKey]?.value?.generationId;
    if (previousId && value[DATA_STORES.REFERENCE_GENERATIONS_V1][previousId]) {
      value[DATA_STORES.REFERENCE_GENERATIONS_V1][previousId].status = 'SUPERSEDED';
    }
    value[DATA_STORES.REFERENCE_GENERATIONS_V1][activeGeneration.generationId] = activeGeneration;
    rows.forEach(row => { value[DATA_STORES.REFERENCE_ENTITIES_V1][fallbackCompositeKey([row.generationId, row.domain, row.entityId])] = row; });
    value[DATA_STORES.SETTINGS] ||= {};
    value[DATA_STORES.SETTINGS][pointerKey] = { key: pointerKey, value: { generationId: activeGeneration.generationId }, updatedAt: activeGeneration.activatedAt };
    writeFallback(value);
    return activeGeneration;
  }
  const tx = db.transaction([
    DATA_STORES.REFERENCE_GENERATIONS_V1,
    DATA_STORES.REFERENCE_ENTITIES_V1,
    DATA_STORES.SETTINGS
  ], 'readwrite');
  const generationStore = tx.objectStore(DATA_STORES.REFERENCE_GENERATIONS_V1);
  const entityStore = tx.objectStore(DATA_STORES.REFERENCE_ENTITIES_V1);
  const settingsStore = tx.objectStore(DATA_STORES.SETTINGS);
  const pointer = await requestResult(settingsStore.get(pointerKey));
  if (pointer?.value?.generationId) {
    const previous = await requestResult(generationStore.get(pointer.value.generationId));
    if (previous) generationStore.put({ ...previous, status: 'SUPERSEDED', supersededAt: activeGeneration.activatedAt });
  }
  generationStore.put(activeGeneration);
  rows.forEach(row => entityStore.put(row));
  settingsStore.put({ key: pointerKey, value: { generationId: activeGeneration.generationId }, updatedAt: activeGeneration.activatedAt });
  await transactionDone(tx);
  db.close();
  return activeGeneration;
}

export async function loadActiveReferenceGeneration(companyId) {
  const company = String(companyId || '').trim();
  if (!company) return null;
  const pointer = await loadSettingValue(`referenceActive:${company}`);
  if (!pointer?.generationId) return null;
  const generation = await get(DATA_STORES.REFERENCE_GENERATIONS_V1, pointer.generationId);
  if (!generation) return null;
  const db = await openDatabase();
  let entities;
  if (!db) {
    entities = Object.values(readFallback()[DATA_STORES.REFERENCE_ENTITIES_V1] || {})
      .filter(row => row.generationId === pointer.generationId);
  } else {
    const tx = db.transaction(DATA_STORES.REFERENCE_ENTITIES_V1, 'readonly');
    const store = tx.objectStore(DATA_STORES.REFERENCE_ENTITIES_V1);
    entities = (await requestResult(store.getAll())).filter(row => row.generationId === pointer.generationId);
    db.close();
  }
  return { generation, entities };
}

export async function loadInputTemplates(companyId = '', voucherMode = '') {
  const company = String(companyId || '');
  const mode = String(voucherMode || '').toLowerCase();
  const records = await getAll(DATA_STORES.INPUT_TEMPLATES_V2);
  return records
    .filter(record => record?.schemaVersion === 'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V2')
    .filter(record => !company || record.companyId === company)
    .filter(record => !mode || record.voucherMode === mode)
    .filter(record => record.status !== 'DELETED')
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export async function saveInputTemplates(value = [], { companyId = '', voucherMode = '' } = {}) {
  const templates = Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
  const company = String(companyId || templates[0]?.companyId || '');
  const mode = String(voucherMode || templates[0]?.voucherMode || '').toLowerCase();
  if (!company || !mode) throw new Error('INPUT_TEMPLATE_SCOPE_REQUIRED');
  const normalized = templates.map(template => ({
    ...template,
    companyId: company,
    voucherMode: mode,
    status: template.status || 'ACTIVE'
  }));
  const db = await openDatabase();
  if (!db) {
    const fallback = readFallback();
    fallback[DATA_STORES.INPUT_TEMPLATES_V2] ||= {};
    Object.entries(fallback[DATA_STORES.INPUT_TEMPLATES_V2]).forEach(([key, record]) => {
      if (record.companyId === company && record.voucherMode === mode) delete fallback[DATA_STORES.INPUT_TEMPLATES_V2][key];
    });
    normalized.forEach(record => { fallback[DATA_STORES.INPUT_TEMPLATES_V2][record.templateId] = record; });
    writeFallback(fallback);
    return normalized;
  }
  const transaction = db.transaction(DATA_STORES.INPUT_TEMPLATES_V2, 'readwrite');
  const store = transaction.objectStore(DATA_STORES.INPUT_TEMPLATES_V2);
  const existing = await requestResult(store.index('byCompanyModeStatus').getAll([company, mode, 'ACTIVE']));
  const nextIds = new Set(normalized.map(record => record.templateId));
  existing.filter(record => !nextIds.has(record.templateId)).forEach(record => store.delete(record.templateId));
  normalized.forEach(record => store.put(record));
  await transactionDone(transaction);
  db.close();
  return normalized;
}

export function saveMappingSessionV2(session) {
  if (!session?.sessionId || !session?.companyId || !session?.voucherMode) {
    return Promise.reject(new Error('MAPPING_SESSION_SCOPE_REQUIRED'));
  }
  return put(DATA_STORES.MAPPING_SESSIONS_V2, JSON.parse(JSON.stringify(session)), 'sessionId');
}

export function saveReferenceCache(domain, value) {
  if (!['product', 'customer'].includes(domain)) return Promise.reject(new Error('REFERENCE_DOMAIN_INVALID'));
  return put(DATA_STORES.SETTINGS, {
    key: `reference:${domain}`,
    value,
    updatedAt: new Date().toISOString()
  }, 'key');
}

export function saveLinkGroup(group) {
  return put(DATA_STORES.LINK_GROUPS, group, 'linkGroupId');
}

export function deleteLinkGroup(linkGroupId) {
  return remove(DATA_STORES.LINK_GROUPS, linkGroupId);
}

export function saveTemporaryCustomer(customer) {
  return put(DATA_STORES.TEMPORARY_CUSTOMERS, customer, 'customerId');
}

export function saveAliasMapping(mapping) {
  return put(DATA_STORES.ALIAS_MAPPINGS, mapping, 'aliasMappingId');
}

export function deleteAliasMapping(aliasMappingId) {
  return remove(DATA_STORES.ALIAS_MAPPINGS, aliasMappingId);
}

export function saveEstimate(estimate) {
  return put(DATA_STORES.ESTIMATES, estimate, 'estimateId');
}

export async function commitEstimateBundle({ upserts = [], deletes = [], expectedPreimages = [] } = {}) {
  const records = upserts.filter(record => record?.estimateId);
  const ids = [...new Set(deletes.filter(Boolean))];
  if (!records.length && !ids.length) return { upserts: [], deletes: [] };
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.ESTIMATES] ||= {};
    assertEstimatePreimages(value[DATA_STORES.ESTIMATES], expectedPreimages);
    records.forEach(record => { value[DATA_STORES.ESTIMATES][record.estimateId] = record; });
    ids.forEach(estimateId => { delete value[DATA_STORES.ESTIMATES][estimateId]; });
    writeFallback(value);
    return { upserts: records, deletes: ids };
  }
  const transaction = db.transaction([DATA_STORES.ESTIMATES, DATA_STORES.SETTINGS], 'readwrite');
  const store = transaction.objectStore(DATA_STORES.ESTIMATES);
  const completed = transactionDone(transaction);
  try {
    const currentRecords = {};
    const current = await Promise.all(expectedPreimages.map(expected => requestResult(store.get(expected.estimateId))));
    expectedPreimages.forEach((expected, index) => { currentRecords[expected.estimateId] = current[index] || null; });
    assertEstimatePreimages(currentRecords, expectedPreimages);
    records.forEach(record => { updateEstimateProjection(transaction, record, record.estimateId); store.put(record); });
    ids.forEach(estimateId => { updateEstimateProjection(transaction, null, estimateId); store.delete(estimateId); });
    await completed;
    return { upserts: records, deletes: ids };
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await completed.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export async function commitEstimateLinkBundle({
  estimateUpserts = [],
  estimateDeletes = [],
  aliasUpserts = [],
  aliasDeletes = [],
  expectedEstimatePreimages = [],
  expectedAliasPreimages = [],
  expectedMissingIds = {}
} = {}) {
  const estimates = estimateUpserts.filter(record => record?.estimateId);
  const deletedEstimateIds = [...new Set(estimateDeletes.filter(Boolean))];
  const aliases = aliasUpserts.filter(record => record?.aliasMappingId);
  const deletedAliasIds = [...new Set(aliasDeletes.filter(Boolean))];
  const missingEstimateIds = [...new Set((expectedMissingIds.estimates || []).filter(Boolean))];
  const missingAliasIds = [...new Set((expectedMissingIds.aliasMappings || []).filter(Boolean))];
  if (!estimates.length && !deletedEstimateIds.length && !aliases.length && !deletedAliasIds.length) {
    return { estimateUpserts: [], estimateDeletes: [], aliasUpserts: [], aliasDeletes: [] };
  }
  const db = await openDatabase();
  if (!db) {
    const value = readFallback();
    value[DATA_STORES.ESTIMATES] ||= {};
    value[DATA_STORES.ALIAS_MAPPINGS] ||= {};
    assertEstimatePreimages(value[DATA_STORES.ESTIMATES], expectedEstimatePreimages);
    assertAliasPreimages(value[DATA_STORES.ALIAS_MAPPINGS], expectedAliasPreimages);
    assertExpectedMissing(value[DATA_STORES.ESTIMATES], missingEstimateIds, 'SMARTINPUT_ESTIMATE_LINK_EXPECTED_MISSING');
    assertExpectedMissing(value[DATA_STORES.ALIAS_MAPPINGS], missingAliasIds, 'SMARTINPUT_ESTIMATE_LINK_EXPECTED_MISSING');
    estimates.forEach(record => { value[DATA_STORES.ESTIMATES][record.estimateId] = record; });
    deletedEstimateIds.forEach(estimateId => { delete value[DATA_STORES.ESTIMATES][estimateId]; });
    aliases.forEach(record => { value[DATA_STORES.ALIAS_MAPPINGS][record.aliasMappingId] = record; });
    deletedAliasIds.forEach(aliasMappingId => { delete value[DATA_STORES.ALIAS_MAPPINGS][aliasMappingId]; });
    writeFallback(value);
    return {
      estimateUpserts: estimates,
      estimateDeletes: deletedEstimateIds,
      aliasUpserts: aliases,
      aliasDeletes: deletedAliasIds
    };
  }
  const transaction = db.transaction([DATA_STORES.ESTIMATES, DATA_STORES.ALIAS_MAPPINGS, DATA_STORES.SETTINGS], 'readwrite');
  const estimateStore = transaction.objectStore(DATA_STORES.ESTIMATES);
  const aliasStore = transaction.objectStore(DATA_STORES.ALIAS_MAPPINGS);
  const completed = transactionDone(transaction);
  try {
    const estimatePreimageRequests = expectedEstimatePreimages.map(expected => requestResult(estimateStore.get(expected.estimateId)));
    const aliasPreimageRequests = expectedAliasPreimages.map(expected => requestResult(aliasStore.get(expected.aliasMappingId)));
    const missingEstimateRequests = missingEstimateIds.map(estimateId => requestResult(estimateStore.get(estimateId)));
    const missingAliasRequests = missingAliasIds.map(aliasMappingId => requestResult(aliasStore.get(aliasMappingId)));
    const [currentEstimates, currentAliases, currentMissingEstimates, currentMissingAliases] = await Promise.all([
      Promise.all(estimatePreimageRequests),
      Promise.all(aliasPreimageRequests),
      Promise.all(missingEstimateRequests),
      Promise.all(missingAliasRequests)
    ]);
    assertEstimatePreimages(Object.fromEntries(expectedEstimatePreimages.map((expected, index) => [expected.estimateId, currentEstimates[index] || null])), expectedEstimatePreimages);
    assertAliasPreimages(Object.fromEntries(expectedAliasPreimages.map((expected, index) => [expected.aliasMappingId, currentAliases[index] || null])), expectedAliasPreimages);
    assertExpectedMissing(Object.fromEntries(missingEstimateIds.map((estimateId, index) => [estimateId, currentMissingEstimates[index] || null])), missingEstimateIds, 'SMARTINPUT_ESTIMATE_LINK_EXPECTED_MISSING');
    assertExpectedMissing(Object.fromEntries(missingAliasIds.map((aliasMappingId, index) => [aliasMappingId, currentMissingAliases[index] || null])), missingAliasIds, 'SMARTINPUT_ESTIMATE_LINK_EXPECTED_MISSING');
    estimates.forEach(record => { updateEstimateProjection(transaction, record, record.estimateId); estimateStore.put(record); });
    deletedEstimateIds.forEach(estimateId => { updateEstimateProjection(transaction, null, estimateId); estimateStore.delete(estimateId); });
    aliases.forEach(record => aliasStore.put(record));
    deletedAliasIds.forEach(aliasMappingId => aliasStore.delete(aliasMappingId));
    await completed;
    return {
      estimateUpserts: estimates,
      estimateDeletes: deletedEstimateIds,
      aliasUpserts: aliases,
      aliasDeletes: deletedAliasIds
    };
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await completed.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export async function saveEstimateBundle(estimates = []) {
  const records = estimates.filter(record => record?.estimateId);
  await commitEstimateBundle({ upserts: records });
  return records;
}

export function deleteEstimate(estimateId) {
  return remove(DATA_STORES.ESTIMATES, estimateId);
}

export async function deleteEstimateBundle(estimateIds = []) {
  const ids = [...new Set(estimateIds.filter(Boolean))];
  await commitEstimateBundle({ deletes: ids });
  return ids;
}

export function saveSourceImage(sourceImage) {
  return put(DATA_STORES.SOURCE_IMAGES, sourceImage, 'documentId');
}

export function deleteSourceImage(documentId) {
  return remove(DATA_STORES.SOURCE_IMAGES, documentId);
}

export function saveLatestAutosave(draft) {
  const updatedAt = new Date().toISOString();
  return put(DATA_STORES.AUTOSAVE, {
    key: 'current',
    schemaVersion: 'ONEAPP_SMART_INPUT_AUTOSAVE_V1',
    updatedAt,
    draft: JSON.parse(JSON.stringify(draft))
  }, 'key');
}

export function loadLatestAutosave() {
  return get(DATA_STORES.AUTOSAVE, 'current');
}

export async function loadAutosaveJournalRecords(companyId = '') {
  const records = await getAll(DATA_STORES.AUTOSAVE);
  return records.filter(record => record?.schemaVersion === 'ONEAPP_SMART_INPUT_AUTOSAVE_JOURNAL_V2'
    && (!companyId || record.companyId === companyId));
}

export async function commitAutosaveJournal({
  base = null,
  patch = null,
  head,
  workspace = null,
  expectedDurableVersion = 0
} = {}) {
  if (!head?.key || head.recordType !== 'head') throw new Error('SMARTINPUT_AUTOSAVE_HEAD_REQUIRED');
  const db = await openDatabase();
  if (!db) throw new Error('SMARTINPUT_AUTOSAVE_JOURNAL_UNAVAILABLE');
  const transaction = db.transaction(DATA_STORES.AUTOSAVE, 'readwrite');
  const completed = transactionDone(transaction);
  try {
    const store = transaction.objectStore(DATA_STORES.AUTOSAVE);
    const currentHead = await requestResult(store.get(head.key));
    if (Number(currentHead?.durableVersion || 0) !== Number(expectedDurableVersion || 0)) {
      transaction.abort();
      throw new Error('SMARTINPUT_AUTOSAVE_JOURNAL_STALE');
    }
    if (base) store.put(base);
    if (patch) store.put(patch);
    if (workspace) store.put(workspace);
    store.put(head);
    await completed;
    return head;
  } catch (error) {
    await completed.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export async function deleteAutosaveJournalRecords(keys = []) {
  const recordKeys = [...new Set(keys.filter(key => key && key !== 'current'))];
  if (!recordKeys.length) return;
  const db = await openDatabase();
  if (!db) throw new Error('SMARTINPUT_AUTOSAVE_JOURNAL_UNAVAILABLE');
  const transaction = db.transaction(DATA_STORES.AUTOSAVE, 'readwrite');
  recordKeys.forEach(key => transaction.objectStore(DATA_STORES.AUTOSAVE).delete(key));
  await transactionDone(transaction);
  db.close();
}


// Stage 3 uses v5's existing stores. These writes never fall back to localStorage.
const stage3Clone = value => structuredClone(value);
const stage3Error = code => Object.assign(new Error(code), { code });
const stage3Required = value => typeof value === 'string' && value.trim().length > 0;
function stage3Context(companyId, actor) {
  if (!stage3Required(companyId) || !stage3Required(actor?.actorId)) throw stage3Error('ESTIMATE_OPERATION_CONTEXT_REQUIRED');
}
function stage3RecordCompany(record, companyId) {
  if (!record) throw stage3Error('ESTIMATE_CONFIRMED_MISSING');
  if (record.companyId !== companyId) throw stage3Error('ESTIMATE_COMPANY_MISMATCH');
}
async function stage3Transaction(names, mode, run) {
  // Compatible recovery keeps the current v5 reader, owned rows and autosave journal.
  if (mode === 'readwrite' && new URLSearchParams(globalThis.location?.search || '').get('estimateRecovery') === 'readonly') throw stage3Error('ESTIMATE_RECOVERY_READ_ONLY');
  const db = await openDatabase();
  if (!db) throw stage3Error('ESTIMATE_INDEXEDDB_REQUIRED');
  return new Promise((resolve, reject) => {
    let transaction, result, operationError;
    try { transaction = db.transaction([...new Set(names)], mode); }
    catch (error) { db.close(); reject(error); return; }
    const abort = error => { operationError = error; try { transaction.abort(); } catch (_) { db.close(); reject(error); } };
    const requests = (entries, ready) => {
      if (!entries.length) { try { ready([]); } catch (error) { abort(error); } return; }
      const values = new Array(entries.length); let remaining = entries.length;
      entries.forEach(([store, key, all], index) => {
        let request;
        try { const objectStore = transaction.objectStore(store); request = all ? objectStore.getAll() : objectStore.get(key); }
        catch (error) { abort(error); return; }
        request.onerror = () => abort(request.error || stage3Error('ESTIMATE_READ_FAILED'));
        request.onsuccess = () => {
          values[index] = request.result ?? null;
          if (--remaining === 0) { try { ready(values); } catch (error) { abort(error); } }
        };
      });
    };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onabort = () => { db.close(); reject(operationError || transaction.error || stage3Error('ESTIMATE_TRANSACTION_ABORTED')); };
    transaction.onerror = () => { operationError ||= transaction.error; };
    try { run({ transaction, requests, finish: value => { result = value; }, abort }); } catch (error) { abort(error); }
  });
}
function stage3Setting(transaction, key, value, updatedAt) {
  transaction.objectStore(DATA_STORES.SETTINGS).put({ key, value: stage3Clone(value), updatedAt });
}

export async function loadEstimateForUpdate({ companyId, estimateId }) {
  if (!stage3Required(companyId) || !stage3Required(estimateId)) throw stage3Error('ESTIMATE_SCOPE_REQUIRED');
  return stage3Transaction([DATA_STORES.ESTIMATES], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.ESTIMATES, estimateId]], ([record]) => {
      if (!record) return finish({ status: 'CONFIRMED_MISSING', companyId, estimateId });
      if (!record.companyId) return finish({ status: 'CONTEXT_REQUIRED', companyId, estimateId });
      if (record.companyId !== companyId) return finish({ status: 'COMPANY_MISMATCH', companyId, estimateId });
      if (record.schemaVersion !== INDEPENDENT_ESTIMATE_SCHEMA) return finish({ status: 'MIGRATION_REQUIRED', companyId, estimateId, record });
      validateIndependentEstimate(record);
      finish({ status: 'READY', companyId, estimateId, record });
    });
  });
}
export async function loadLastEstimateExcelResult({ companyId, estimateId }) {
  const key = estimateTechnicalKey('latestExcelResult', companyId, estimateId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key]], ([stored]) => {
      if (!stored) return finish({ status: 'NO_RECORD', companyId, estimateId, result: null });
      const result = stored.value;
      if (result?.schemaVersion !== LAST_ESTIMATE_EXCEL_RESULT_SCHEMA || result.companyId !== companyId || result.estimateId !== estimateId) throw stage3Error('ESTIMATE_LAST_RESULT_INVALID');
      finish({ status: 'READY', companyId, estimateId, result });
    });
  });
}

async function verifyStage3Hash(value) {
  const { payloadHash, ...payload } = value;
  if (!stage3Required(payloadHash) || await hashEstimatePlan(payload) !== payloadHash) throw stage3Error('ESTIMATE_PAYLOAD_HASH_MISMATCH');
}
export async function persistSelectedEstimateUpdatePlan(plan) {
  if (!plan?.selectedEstimateIds?.length || plan.status === 'EMPTY') return { status: 'EMPTY', durable: false };
  stage3Context(plan.companyId, plan.actor);
  await verifyStage3Hash(plan);
  if (plan.schemaVersion !== 'ONEAPP_SMARTINPUT_SELECTED_ESTIMATE_UPDATE_V1') throw stage3Error('ESTIMATE_PLAN_SCHEMA_INVALID');
  if (!Object.values(plan.sourceIndex?.entries || {}).some(rows => rows.length)) return { status: 'EMPTY_SOURCE', durable: false };
  const key = estimateTechnicalKey('operation', plan.companyId, plan.operationId);
  const pendingKey = estimateTechnicalKey('pending', plan.companyId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key], [DATA_STORES.SETTINGS, pendingKey]], ([previous, pending]) => {
      if (previous && !estimateValuesEqual(previous.value, plan)) throw stage3Error('ESTIMATE_OPERATION_PAYLOAD_CONFLICT');
      if (!previous) stage3Setting(transaction, key, plan, plan.occurredAt);
      registerStage3Pending(transaction, pendingKey, pending?.value, 'update', plan.operationId, plan.occurredAt);
      finish({ durable: true, existing: Boolean(previous), operationId: plan.operationId, companyId: plan.companyId, payloadHash: plan.payloadHash });
    });
  });
}

export async function getEstimateUpdateResult({ companyId, operationId, estimateId, payloadHash }) {
  const key = estimateTechnicalKey('receipt', companyId, operationId, estimateId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key]], ([stored]) => {
      if (stored && stored.value.payloadHash !== payloadHash) throw stage3Error('ESTIMATE_OPERATION_PAYLOAD_CONFLICT');
      finish(stored?.value || { status: 'CONFIRMED_NOT_APPLIED', companyId, operationId, estimateId, payloadHash });
    });
  });
}
export async function commitSelectedEstimateUpdate({ plan, target }) {
  if (!plan?.selectedEstimateIds?.length) return { status: 'EMPTY' };
  stage3Context(plan.companyId, plan.actor);
  if (!plan.selectedEstimateIds.includes(target?.estimateId) || !plan.targets.some(item => estimateValuesEqual(item, target))) throw stage3Error('ESTIMATE_TARGET_NOT_SELECTED');
  if (!target.expectedPreimage || !['PLANNED', 'UNCHANGED', 'PARTIAL_REVIEW'].includes(target.status)) return { status: 'REVIEW_REQUIRED', estimateId: target.estimateId, issues: stage3Clone(target.issues) };
  if (!Object.values(plan.sourceIndex.entries || {}).some(rows => rows.length)) return { status: 'EMPTY_SOURCE' };
  // Computation and hash verification happen before the IDB transaction.
  await verifyStage3Hash(plan);
  for (const patch of target.rowPatches || []) {
    if (!plan.allowedFieldIds.includes(patch.field) || (patch.valueKind === 'CLEAR' && !plan.explicitClears.includes(patch.field))) throw stage3Error('ESTIMATE_PATCH_SCOPE_INVALID');
  }
  const timestamp = new Date().toISOString();
  const changed = target.rowPatches.length > 0;
  const candidate = changed ? applyIndependentEstimatePatches(target.expectedPreimage, target.rowPatches, { updatedAt: timestamp }) : target.expectedPreimage;
  const lastResult = createLastEstimateExcelResult({ plan, target, estimateRevision: candidate.dataRevision, committedAt: timestamp });
  const receipt = { schemaVersion: 'SMARTINPUT_ESTIMATE_UPDATE_RECEIPT_V1', companyId: plan.companyId, operationId: plan.operationId,
    estimateId: target.estimateId, payloadHash: plan.payloadHash, status: target.status === 'PARTIAL_REVIEW' ? 'PARTIAL_REVIEW' : changed ? 'SAVED' : 'UNCHANGED',
    committed: true, committedAt: timestamp, dataRevision: candidate.dataRevision, issues: stage3Clone(target.issues),
    processedFields: stage3Clone(target.processedFields), lastExcelResult: lastResult };
  const operationKey = estimateTechnicalKey('operation', plan.companyId, plan.operationId);
  const receiptKey = estimateTechnicalKey('receipt', plan.companyId, plan.operationId, target.estimateId);
  const latestKey = estimateTechnicalKey('latestExcelResult', plan.companyId, target.estimateId);
  const aliases = target.mappingPatches || [];
  return stage3Transaction([DATA_STORES.ESTIMATES, DATA_STORES.ALIAS_MAPPINGS, DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, receiptKey], [DATA_STORES.SETTINGS, operationKey], [DATA_STORES.ESTIMATES, target.estimateId],
      ...aliases.map(patch => [DATA_STORES.ALIAS_MAPPINGS, patch.after.aliasMappingId])], ([previousReceipt, persisted, current, ...currentAliases]) => {
      if (!persisted || !estimateValuesEqual(persisted.value, plan)) throw stage3Error('ESTIMATE_OPERATION_NOT_DURABLE');
      if (previousReceipt) {
        if (previousReceipt.value.payloadHash !== plan.payloadHash) throw stage3Error('ESTIMATE_OPERATION_PAYLOAD_CONFLICT');
        // Never roll the latest-result pointer back when replaying an older receipt.
        return finish(previousReceipt.value);
      }
      stage3RecordCompany(current, plan.companyId);
      if (current.dataRevision !== target.expectedRevision || !estimateValuesEqual(current, target.expectedPreimage)) throw stage3Error('ESTIMATE_PREIMAGE_CONFLICT');
      aliases.forEach((patch, index) => {
        if (patch.after.companyId !== plan.companyId || patch.after.targetEstimateId !== target.estimateId
          || patch.after.mappingType !== 'ESTIMATE_DIRECT_ROW_V1') throw stage3Error('ESTIMATE_MAPPING_SCOPE_INVALID');
        if (!estimateValuesEqual(currentAliases[index], patch.before)) throw stage3Error('ESTIMATE_MAPPING_PREIMAGE_CONFLICT');
      });
      if (changed) {
        candidate.history = [...(current.history || []), { operationId: plan.operationId, actor: plan.actor, occurredAt: timestamp,
          patches: stage3Clone(target.rowPatches) }];
        updateEstimateProjection(transaction, candidate, candidate.estimateId);
        transaction.objectStore(DATA_STORES.ESTIMATES).put(candidate);
      }
      aliases.forEach((patch, index) => { if (!estimateValuesEqual(currentAliases[index], patch.after)) transaction.objectStore(DATA_STORES.ALIAS_MAPPINGS).put(patch.after); });
      stage3Setting(transaction, receiptKey, receipt, timestamp);
      stage3Setting(transaction, latestKey, lastResult, timestamp);
      finish(receipt);
    });
  });
}

/** Durable dispatch intent in the same v5 technical namespace. No owner database is opened here. */
export async function persistEstimateMasterIntent(intent) {
  const command = intent?.command;
  if (!command?.selectedEstimateIds?.length) throw stage3Error('MASTER_SELECTION_REQUIRED');
  stage3Context(command.companyId, command.actor); await verifyStage3Hash(command);
  const key = estimateTechnicalKey('masterIntent', command.companyId, command.commandId);
  const pendingKey = estimateTechnicalKey('pending', command.companyId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key], [DATA_STORES.SETTINGS, pendingKey]], ([previous, pending]) => {
      if (previous && !estimateValuesEqual(previous.value.command, command)) throw stage3Error('MASTER_INTENT_PAYLOAD_CONFLICT');
      if (!previous) stage3Setting(transaction, key, intent, new Date().toISOString());
      registerStage3Pending(transaction, pendingKey, pending?.value, 'master', command.commandId, new Date().toISOString());
      finish({ durable: true, existing: Boolean(previous), companyId: command.companyId, commandId: command.commandId, payloadHash: command.payloadHash });
    });
  });
}
export async function loadEstimateMasterIntent({ companyId, commandId }) {
  return stage3Transaction([DATA_STORES.SETTINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, estimateTechnicalKey('masterIntent', companyId, commandId)]], ([value]) => finish(value?.value || null));
  });
}

/** Explicit general edit/rename/delete: target-only CAS, never linked-source or latest-Excel-result writes. */
export async function commitIndependentEstimateEdit({ companyId, actor, operationId, estimateId, expectedPreimage = null, candidate = null, action = 'SAVE' }) {
  stage3Context(companyId, actor);
  if (!stage3Required(operationId) || !stage3Required(estimateId) || !['SAVE', 'DELETE', 'METADATA'].includes(action)) throw stage3Error('ESTIMATE_EDIT_INVALID');
  if (candidate) {
    validateIndependentEstimate(candidate);
    if (candidate.companyId !== companyId || candidate.estimateId !== estimateId) throw stage3Error('ESTIMATE_EDIT_SCOPE_INVALID');
  }
  if (expectedPreimage) stage3RecordCompany(expectedPreimage, companyId);
  if (action !== 'DELETE' && !candidate) throw stage3Error('ESTIMATE_EDIT_CANDIDATE_REQUIRED');
  const payloadHash = await hashEstimatePlan({ companyId, actor, operationId, estimateId, expectedPreimage, candidate, action });
  const intent = { companyId, actor, operationId, estimateId, expectedPreimage, candidate, action };
  const intentKey = estimateTechnicalKey('editIntent', companyId, operationId);
  const pendingKey = estimateTechnicalKey('pending', companyId);
  await stage3Transaction([DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, intentKey], [DATA_STORES.SETTINGS, pendingKey]], ([prior, pending]) => {
      if (prior && !estimateValuesEqual(prior.value, intent)) throw stage3Error('ESTIMATE_OPERATION_PAYLOAD_CONFLICT');
      if (!prior) stage3Setting(transaction, intentKey, intent, new Date().toISOString());
      registerStage3Pending(transaction, pendingKey, pending?.value, 'edit', operationId, new Date().toISOString());
      finish(true);
    });
  });
  const key = estimateTechnicalKey('editReceipt', companyId, operationId, estimateId);
  return stage3Transaction([DATA_STORES.ESTIMATES, DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key], [DATA_STORES.ESTIMATES, estimateId]], ([prior, current]) => {
      if (prior) {
        if (prior.value.payloadHash !== payloadHash) throw stage3Error('ESTIMATE_OPERATION_PAYLOAD_CONFLICT');
        return finish(prior.value);
      }
      if (!estimateValuesEqual(current, expectedPreimage)) throw stage3Error('ESTIMATE_PREIMAGE_CONFLICT');
      if (current) stage3RecordCompany(current, companyId);
      if (action === 'DELETE') { updateEstimateProjection(transaction, null, estimateId); transaction.objectStore(DATA_STORES.ESTIMATES).delete(estimateId); }
      else if (!estimateValuesEqual(candidate, current)) {
        if (current && candidate.dataRevision !== current.dataRevision + 1) throw stage3Error('ESTIMATE_EDIT_REVISION_INVALID');
        updateEstimateProjection(transaction, candidate, estimateId);
        transaction.objectStore(DATA_STORES.ESTIMATES).put({ ...candidate, history: [...(current?.history || []), { operationId, actor, action, occurredAt: candidate.updatedAt || new Date().toISOString() }] });
      }
      const result = { status: action === 'DELETE' ? 'DELETED' : estimateValuesEqual(candidate, current) ? 'UNCHANGED' : 'SAVED',
        companyId, estimateId, operationId, payloadHash, dataRevision: candidate?.dataRevision ?? null, committedAt: new Date().toISOString() };
      stage3Setting(transaction, key, result, result.committedAt); finish(result);
    });
  });
}

/** Read an explicit edit receipt without reissuing the write. */
export async function getIndependentEstimateEditResult(intent) {
  stage3Context(intent.companyId, intent.actor);
  const normalized = { companyId: intent.companyId, actor: intent.actor, operationId: intent.operationId,
    estimateId: intent.estimateId, expectedPreimage: intent.expectedPreimage ?? null, candidate: intent.candidate ?? null,
    action: intent.action || 'SAVE' };
  const payloadHash = await hashEstimatePlan(normalized);
  const key = estimateTechnicalKey('editReceipt', intent.companyId, intent.operationId, intent.estimateId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key]], ([stored]) => {
      if (stored && stored.value.payloadHash !== payloadHash) throw stage3Error('ESTIMATE_OPERATION_PAYLOAD_CONFLICT');
      finish(stored?.value || { status: 'CONFIRMED_NOT_APPLIED', ...normalized, payloadHash });
    });
  });
}
export async function loadEstimateDirectMappings() {
  return stage3Transaction([DATA_STORES.ALIAS_MAPPINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.ALIAS_MAPPINGS, null, true]], ([records]) => finish(records));
  });
}

/** One consistent read for preservation. It is not run from an Excel-update handler. */
export async function captureEstimateMigrationEvidence() {
  const stores = [DATA_STORES.ESTIMATES, DATA_STORES.ALIAS_MAPPINGS, DATA_STORES.AUTOSAVE, DATA_STORES.SOURCE_IMAGES];
  return stage3Transaction(stores, 'readonly', ({ requests, finish }) => {
    requests(stores.map(store => [store, null, true]), values => finish(Object.fromEntries(stores.map((store, index) => [store, values[index]]))));
  });
}
export async function preserveEstimateMigrationEvidence({ companyId, actor, migrationId, snapshot, manifest, safety }) {
  stage3Context(companyId, actor);
  if (!stage3Required(migrationId) || !snapshot || !manifest?.snapshotHash || !safety?.oldTabsConfirmedClosed
    || !safety?.backupExported || !stage3Required(safety?.previousLoadId) || !stage3Required(safety?.currentLoadId)
    || safety.previousLoadId === safety.currentLoadId) throw stage3Error('ESTIMATE_MIGRATION_SAFETY_REQUIRED');
  if (await hashEstimatePlan(snapshot) !== manifest.snapshotHash) throw stage3Error('ESTIMATE_MIGRATION_HASH_MISMATCH');
  const key = estimateTechnicalKey('migration', companyId, migrationId);
  const stores = [DATA_STORES.ESTIMATES, DATA_STORES.ALIAS_MAPPINGS, DATA_STORES.AUTOSAVE, DATA_STORES.SETTINGS];
  return stage3Transaction(stores, 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key], ...stores.filter(store => store !== DATA_STORES.SETTINGS).map(store => [store, null, true])], ([prior, estimates, aliases, autosave]) => {
      if (prior) {
        if (prior.value.manifest.snapshotHash !== manifest.snapshotHash) throw stage3Error('ESTIMATE_MIGRATION_PAYLOAD_CONFLICT');
        return finish(prior.value);
      }
      if (!estimateValuesEqual(estimates, snapshot[DATA_STORES.ESTIMATES]) || !estimateValuesEqual(aliases, snapshot[DATA_STORES.ALIAS_MAPPINGS])
        || snapshot[DATA_STORES.AUTOSAVE].filter(record => record.recordType === 'base' || record.recordType === 'patch').some(record => { const found = autosave.find(current => current.key === record.key); return found && !estimateValuesEqual(found, record); })) throw stage3Error('ESTIMATE_MIGRATION_SOURCE_CHANGED');
      const result = { companyId, actor, migrationId, manifest, safety, snapshot, status: 'PRESERVED', preservedAt: new Date().toISOString() };
      stage3Setting(transaction, key, result, result.preservedAt); finish(result);
    });
  });
}
export async function loadEstimateMigration({ companyId, migrationId }) {
  return stage3Transaction([DATA_STORES.SETTINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, estimateTechnicalKey('migration', companyId, migrationId)]], ([stored]) => finish(stored?.value || null));
  });
}
export async function commitIndependentEstimateMigration({ companyId, actor, migrationId, expectedPreimage, candidate, companyEvidence = null, verifiedOutputHash }) {
  stage3Context(companyId, actor); validateIndependentEstimate(candidate);
  if (candidate.companyId !== companyId || candidate.estimateId !== expectedPreimage?.estimateId || !stage3Required(verifiedOutputHash)) throw stage3Error('ESTIMATE_MIGRATION_SCOPE_INVALID');
  if (candidate.createdAt !== expectedPreimage.createdAt || candidate.updatedAt !== expectedPreimage.updatedAt
    || candidate.sortOrder !== expectedPreimage.sortOrder) throw stage3Error('ESTIMATE_MIGRATION_BUSINESS_METADATA_CHANGED');
  const estimateId = candidate.estimateId;
  const migrationKey = estimateTechnicalKey('migration', companyId, migrationId);
  const receiptKey = estimateTechnicalKey('migrationReceipt', companyId, migrationId, estimateId);
  const payloadHash = await hashEstimatePlan({ companyId, migrationId, expectedPreimage, candidate, verifiedOutputHash, companyEvidence });
  return stage3Transaction([DATA_STORES.ESTIMATES, DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, migrationKey], [DATA_STORES.SETTINGS, receiptKey], [DATA_STORES.ESTIMATES, estimateId]], ([preserved, prior, current]) => {
      if (!preserved?.value?.snapshot || preserved.value.companyId !== companyId) throw stage3Error('ESTIMATE_MIGRATION_NOT_PRESERVED');
      if (prior) { if (prior.value.payloadHash !== payloadHash) throw stage3Error('ESTIMATE_MIGRATION_PAYLOAD_CONFLICT'); return finish(prior.value); }
      const fixed = preserved.value.snapshot[DATA_STORES.ESTIMATES].find(record => record.estimateId === estimateId);
      if (!estimateValuesEqual(fixed, expectedPreimage) || !estimateValuesEqual(current, expectedPreimage)) throw stage3Error('ESTIMATE_PREIMAGE_CONFLICT');
      if (current.companyId && current.companyId !== companyId) throw stage3Error('ESTIMATE_COMPANY_MISMATCH');
      if (!current.companyId && (companyEvidence?.companyId !== companyId || companyEvidence?.actorId !== actor.actorId
        || !companyEvidence?.estimateIds?.includes(estimateId) || !stage3Required(companyEvidence.confirmedAt))) throw stage3Error('ESTIMATE_COMPANY_UNCONFIRMED');
      const receipt = { status: 'COMMITTED', companyId, migrationId, estimateId, payloadHash, verifiedOutputHash,
        companyEvidence, committedAt: new Date().toISOString() };
      updateEstimateProjection(transaction, candidate, candidate.estimateId);
        transaction.objectStore(DATA_STORES.ESTIMATES).put(candidate);
      stage3Setting(transaction, receiptKey, receipt, receipt.committedAt); finish(receipt);
    });
  });
}

// Bounded unresolved-work pointers; normal reads never scan historical receipts.
function registerStage3Pending(transaction, key, previous, kind, id, timestamp) {
  const entries = Array.isArray(previous) ? previous : [];
  if (!entries.some(entry => entry.kind === kind && entry.id === id)) stage3Setting(transaction, key, [...entries, { kind, id }], timestamp);
}
export async function loadPendingEstimateOperations({ companyId }) {
  const key = estimateTechnicalKey('pending', companyId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readonly', ({ requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key]], ([pointer]) => {
      const entries = Array.isArray(pointer?.value) ? pointer.value : [];
      const names = { update: 'operation', master: 'masterIntent', edit: 'editIntent' };
      if (entries.some(entry => !names[entry.kind])) throw stage3Error('ESTIMATE_PENDING_POINTER_INVALID');
      requests(entries.map(entry => [DATA_STORES.SETTINGS, estimateTechnicalKey(names[entry.kind], companyId, entry.id)]), values => {
        if (values.some(value => !value)) throw stage3Error('ESTIMATE_PENDING_PAYLOAD_MISSING');
        finish(entries.map((entry, index) => ({ ...entry, value: values[index].value })));
      });
    });
  });
}
export async function completePendingEstimateOperation({ companyId, kind, id }) {
  const key = estimateTechnicalKey('pending', companyId);
  return stage3Transaction([DATA_STORES.SETTINGS], 'readwrite', ({ transaction, requests, finish }) => {
    requests([[DATA_STORES.SETTINGS, key]], ([pointer]) => {
      const before = Array.isArray(pointer?.value) ? pointer.value : [];
      const after = before.filter(entry => entry.kind !== kind || entry.id !== id);
      if (after.length !== before.length) stage3Setting(transaction, key, after, new Date().toISOString());
      finish(true);
    });
  });
}


const summaryMarker = 'smartinput:estimateSummaryReady:v1';
const readMetrics = { summaryReads: 0, projectionBodyReads: 0, bodyReads: 0, imageReads: 0 };
const estimateReadCache = createEstimateReadCache({ read: async request => {
  readMetrics[request.kind === 'body' ? 'bodyReads' : 'imageReads']++;
  const value = await get(request.kind === 'body' ? DATA_STORES.ESTIMATES : DATA_STORES.SOURCE_IMAGES, request.id);
  if (!value) return { status: 'NOT_FOUND' };
  if (value.companyId && value.companyId !== request.companyId) return { status: 'ERROR', error: new Error('ESTIMATE_COMPANY_MISMATCH') };
  return { status: 'READY', value, revision: value.dataRevision ?? null };
} });
const readChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('smartinput-read-invalidation-v1') : null;
readChannel?.unref?.();
readChannel?.addEventListener('message', event => {
  if (event.data?.id) estimateReadCache.invalidate(request => request.id === event.data.id);
});
function invalidateCachedRead(id) {
  estimateReadCache.invalidate(request => request.id === id); readChannel?.postMessage({ id });
}
function estimateProjection(record) {
  return { ...projectEstimateSummary(record), catalogName: record.catalogName || '', schemaVersion: record.schemaVersion || null,
    estimateKind: record.estimateKind || 'INDIVIDUAL', dataRevision: record.dataRevision ?? null,
    rowCount: record.rowCount ?? record.draft?.rows?.length ?? 0, amount: record.amount ?? 0,
    linkedEstimateSources: (record.linkedEstimateSources || []).map(source => ({ estimateId: source.estimateId })) };
}
function updateEstimateProjection(transaction, record, estimateId) {
  const old = transaction.objectStore(DATA_STORES.ESTIMATES).get(estimateId);
  old.addEventListener('success', () => {
    const settings = transaction.objectStore(DATA_STORES.SETTINGS);
    if (old.result) settings.delete(estimateSummaryKey(old.result.companyId || null, estimateId));
    if (record) settings.put({ key: estimateSummaryKey(record.companyId || null, estimateId), value: estimateProjection(record) });
  });
  transaction.addEventListener('complete', () => invalidateCachedRead(estimateId), { once: true });
}
export async function loadEstimateSummaries(companyId) {
  readMetrics.summaryReads++;
  const db = await openDatabase();
  if (!db) return sortedEstimates(Object.values(readFallback()[DATA_STORES.ESTIMATES] || {}).filter(record => !record.companyId || record.companyId === companyId).map(estimateProjection));
  const tx = db.transaction([DATA_STORES.ESTIMATES, DATA_STORES.SETTINGS], 'readwrite');
  const completed = transactionDone(tx), settings = tx.objectStore(DATA_STORES.SETTINGS);
  let summaries = [];
  try {
    await new Promise((resolve, reject) => {
      const marker = settings.get(summaryMarker);
      marker.onerror = () => reject(marker.error);
      marker.onsuccess = () => {
        if (marker.result) {
          const query = settings.getAll(IDBKeyRange.bound(ESTIMATE_SUMMARY_PREFIX, ESTIMATE_SUMMARY_PREFIX + '\uffff'));
          query.onerror = () => reject(query.error);
          query.onsuccess = () => { summaries = query.result.map(row => row.value); resolve(); };
        } else {
          // One body at a time; only disposable metadata is written, never business records.
          settings.delete(IDBKeyRange.bound(ESTIMATE_SUMMARY_PREFIX, ESTIMATE_SUMMARY_PREFIX + '\uffff'));
          const cursor = tx.objectStore(DATA_STORES.ESTIMATES).openCursor();
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            if (!cursor.result) { settings.put({ key: summaryMarker, value: true }); resolve(); return; }
            readMetrics.projectionBodyReads++;
            const projection = estimateProjection(cursor.result.value); summaries.push(projection);
            settings.put({ key: estimateSummaryKey(projection.companyId, projection.estimateId), value: projection });
            cursor.result.continue();
          };
        }
      };
    });
    await completed;
    return sortedEstimates(summaries.filter(record => !record.companyId || record.companyId === companyId));
  } catch (error) { await completed.catch(() => {}); throw error; }
  finally { db.close(); }
}
export async function loadEstimateBody({ companyId, estimateId, revision = null, force = false }) {
  if (force) estimateReadCache.invalidate(request => request.kind === 'body' && request.id === estimateId);
  return estimateReadCache.load({ kind: 'body', companyId, id: estimateId, revision });
}
export async function loadSourceImageForDocument({ companyId, documentId }) {
  return estimateReadCache.load({ kind: 'image', companyId, id: documentId, revision: null });
}
export function smartInputReadStats() { return { ...readMetrics, ...estimateReadCache.stats() }; }
