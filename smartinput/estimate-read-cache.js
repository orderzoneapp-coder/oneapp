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
