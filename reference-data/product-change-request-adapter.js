import {
  REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
  cloneJson,
  deepFreeze,
  referenceChangeRequestPayloadHash,
  rejectedChangeRequestResult,
  validateReferenceChangeRequest,
} from './change-request-contract.js';

export const PRODUCT_CHANGE_REQUEST_ADAPTER_VERSION = 'ONEAPP_PRODUCT_CHANGE_REQUEST_ADAPTER_V1';
export const PRODUCT_CHANGE_REQUEST_INBOX_KEY = 'oneappProductReferenceChangeRequests_v1';
export const PRODUCT_CHANGE_REQUEST_INBOX_SCHEMA = 'ONEAPP_REFERENCE_CHANGE_REQUEST_INBOX_V1';

const DB_NAME = 'MerchOpsDB';
const DB_VERSION = 2;
const KV_STORE = 'store';
const PRODUCT_STORE = 'master_products';

const clean = (value) => String(value ?? '').trim();

function requestResult(request, code) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Object.assign(new Error(code), { cause: request.error }));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(Object.assign(new Error('PRODUCT_CHANGE_REQUEST_WRITE_FAILED'), { cause: transaction.error }));
    transaction.onabort = () => reject(Object.assign(new Error('PRODUCT_CHANGE_REQUEST_WRITE_ABORTED'), { cause: transaction.error }));
  });
}

function openProductOwnerDb({ createIfMissing = false } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!globalThis.indexedDB) throw new Error('INDEXEDDB_NOT_AVAILABLE');
      if (!createIfMissing && typeof globalThis.indexedDB.databases === 'function') {
        const databases = await globalThis.indexedDB.databases();
        if (!databases.some((entry) => entry?.name === DB_NAME)) return resolve(null);
      }
      const request = createIfMissing ? globalThis.indexedDB.open(DB_NAME, DB_VERSION) : globalThis.indexedDB.open(DB_NAME);
      request.onupgradeneeded = () => {
        if (!createIfMissing) {
          request.transaction?.abort();
          reject(new Error('PRODUCT_DB_UNEXPECTED_CREATION_BLOCKED'));
          return;
        }
        const db = request.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
        if (!db.objectStoreNames.contains(PRODUCT_STORE)) db.createObjectStore(PRODUCT_STORE, { keyPath: '코드' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('PRODUCT_DB_OPEN_FAILED'));
      request.onblocked = () => reject(new Error('PRODUCT_DB_OPEN_BLOCKED'));
    } catch (error) {
      reject(error);
    }
  });
}

function emptyInbox() {
  return { schemaVersion: PRODUCT_CHANGE_REQUEST_INBOX_SCHEMA, revision: 0, requests: [] };
}

function normalizedInbox(value) {
  if (!value || typeof value !== 'object') return emptyInbox();
  if (value.schemaVersion !== PRODUCT_CHANGE_REQUEST_INBOX_SCHEMA || !Array.isArray(value.requests)) {
    throw new Error('PRODUCT_CHANGE_REQUEST_INBOX_INVALID');
  }
  return { schemaVersion: value.schemaVersion, revision: Number(value.revision || 0), requests: value.requests };
}

function storedResult(entry, status = entry.status) {
  return deepFreeze({
    schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
    accepted: status === 'PENDING' || status === 'DUPLICATE',
    status,
    requestId: entry.request.requestId,
    idempotencyKey: entry.request.idempotencyKey,
    payloadHash: entry.payloadHash,
    receivedAt: entry.receivedAt,
    storedStatus: entry.status,
  });
}

const REVIEWABLE_STATUSES = new Set(['PENDING', 'IN_REVIEW']);
const FINAL_STATUSES = new Set(['APPLIED', 'LINKED', 'REJECTED']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function productChangeRequestSemanticKey(entryOrRequest) {
  const request = entryOrRequest?.request || entryOrRequest || {};
  if (request.operation !== 'CREATE') return `REQUEST:${clean(request.requestId)}`;
  const proposed = {};
  (Array.isArray(request.changes) ? request.changes : []).forEach((change) => {
    const field = clean(change?.field);
    if (field) proposed[field] = change?.proposedValue;
  });
  const entityId = clean(request.entityId || proposed.품목코드 || proposed.코드);
  return `CREATE:${entityId}:${stableJson(proposed)}`;
}

export function collapseProductChangeRequestDuplicates(rows = []) {
  const groups = new Map();
  rows.forEach((entry) => {
    const key = productChangeRequestSemanticKey(entry);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { primary: entry, entries: [entry] });
      return;
    }
    group.entries.push(entry);
    if (group.primary.status !== 'IN_REVIEW' && entry.status === 'IN_REVIEW') group.primary = entry;
  });
  return [...groups.values()].map(({ primary, entries }) => ({
    ...cloneJson(primary),
    repeatedRequestCount: entries.length,
    duplicateRequestIds: entries
      .map((entry) => clean(entry.request?.requestId))
      .filter((requestId) => requestId && requestId !== clean(primary.request?.requestId)),
  }));
}

function publicEntry(entry) {
  return deepFreeze(cloneJson(entry));
}

async function mutateInbox(requestId, updater) {
  const cleanRequestId = clean(requestId);
  if (!cleanRequestId) return failureResult('REJECTED', new Error('REQUEST_ID_REQUIRED'), { requestId });
  let db;
  try {
    db = await openProductOwnerDb({ createIfMissing: false });
    if (!db) return failureResult('NOT_AVAILABLE', new Error('PRODUCT_OWNER_REPOSITORY_NOT_AVAILABLE'), { requestId });
    if (!db.objectStoreNames.contains(KV_STORE)) throw new Error('PRODUCT_OWNER_STORE_NOT_AVAILABLE');
    const transaction = db.transaction(KV_STORE, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(KV_STORE);
    const inbox = normalizedInbox(await requestResult(store.get(PRODUCT_CHANGE_REQUEST_INBOX_KEY), 'PRODUCT_CHANGE_REQUEST_INBOX_READ_FAILED'));
    const index = inbox.requests.findIndex((entry) => entry.request?.requestId === cleanRequestId);
    if (index < 0) {
      transaction.abort();
      try { await done; } catch {}
      return failureResult('NOT_AVAILABLE', new Error('PRODUCT_CHANGE_REQUEST_NOT_FOUND'), { requestId });
    }
    const current = cloneJson(inbox.requests[index]);
    const next = updater(current);
    if (!next || next.error) {
      transaction.abort();
      try { await done; } catch {}
      return failureResult(next?.status || 'CONFLICT', new Error(next?.error || 'PRODUCT_CHANGE_REQUEST_UPDATE_REJECTED'), { requestId });
    }
    const requests = inbox.requests.slice();
    requests[index] = next;
    store.put({ ...inbox, revision: inbox.revision + 1, requests }, PRODUCT_CHANGE_REQUEST_INBOX_KEY);
    await done;
    try {
      globalThis.dispatchEvent?.(new CustomEvent('oneapp:product-change-request-change', {
        detail: { requestId: cleanRequestId, status: next.status, revision: inbox.revision + 1 },
      }));
    } catch {}
    return deepFreeze({ status: next.status, revision: inbox.revision + 1, entry: publicEntry(next), error: null });
  } catch (error) {
    const unavailable = /(?:NOT_AVAILABLE|OPEN_FAILED|OPEN_BLOCKED|STORE_NOT_AVAILABLE)/.test(clean(error?.message));
    return failureResult(unavailable ? 'NOT_AVAILABLE' : 'ERROR', error, { requestId });
  } finally {
    db?.close();
  }
}

function failureResult(status, error, input = {}) {
  return deepFreeze({
    schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
    accepted: false,
    status,
    requestId: clean(input.requestId),
    idempotencyKey: clean(input.idempotencyKey),
    error: { code: clean(error?.message) || 'PRODUCT_CHANGE_REQUEST_ERROR', retryable: status !== 'CONFLICT' },
  });
}

export async function submitProductChangeRequest(input) {
  const validation = validateReferenceChangeRequest(input, {
    expectedDomain: 'PRODUCT',
    expectedOwnerAppId: 'master-lookup',
  });
  if (!validation.valid) return rejectedChangeRequestResult(input, validation);

  let db;
  try {
    const request = cloneJson(input);
    const payloadHash = await referenceChangeRequestPayloadHash(request);
    db = await openProductOwnerDb({ createIfMissing: false });
    if (!db) return failureResult('NOT_AVAILABLE', new Error('PRODUCT_OWNER_REPOSITORY_NOT_AVAILABLE'), input);
    if (!db.objectStoreNames.contains(KV_STORE)) throw new Error('PRODUCT_OWNER_STORE_NOT_AVAILABLE');
    const transaction = db.transaction(KV_STORE, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(KV_STORE);
    const inbox = normalizedInbox(await requestResult(store.get(PRODUCT_CHANGE_REQUEST_INBOX_KEY), 'PRODUCT_CHANGE_REQUEST_INBOX_READ_FAILED'));
    const duplicate = inbox.requests.find((entry) => entry.request?.idempotencyKey === request.idempotencyKey);
    if (duplicate) {
      if (duplicate.payloadHash === payloadHash) {
        await done;
        return storedResult(duplicate, 'DUPLICATE');
      }
      transaction.abort();
      try { await done; } catch {}
      return failureResult('CONFLICT', new Error('IDEMPOTENCY_KEY_CONFLICT'), request);
    }
    const requestIdConflict = inbox.requests.find((entry) => entry.request?.requestId === request.requestId);
    if (requestIdConflict) {
      transaction.abort();
      try { await done; } catch {}
      return failureResult('CONFLICT', new Error('REQUEST_ID_CONFLICT'), request);
    }
    const semanticDuplicate = inbox.requests.find((entry) => REVIEWABLE_STATUSES.has(entry.status)
      && productChangeRequestSemanticKey(entry) === productChangeRequestSemanticKey(request));
    if (semanticDuplicate) {
      await done;
      return storedResult(semanticDuplicate, 'DUPLICATE');
    }
    const entry = {
      status: 'PENDING',
      payloadHash,
      receivedAt: new Date().toISOString(),
      request,
    };
    store.put({
      schemaVersion: PRODUCT_CHANGE_REQUEST_INBOX_SCHEMA,
      revision: inbox.revision + 1,
      requests: [...inbox.requests, entry],
    }, PRODUCT_CHANGE_REQUEST_INBOX_KEY);
    await done;
    try {
      globalThis.dispatchEvent?.(new CustomEvent('oneapp:product-change-request-change', {
        detail: { requestId: request.requestId, status: entry.status, revision: inbox.revision + 1 },
      }));
    } catch {}
    return storedResult(entry);
  } catch (error) {
    const unavailable = /(?:NOT_AVAILABLE|OPEN_FAILED|OPEN_BLOCKED|STORE_NOT_AVAILABLE)/.test(clean(error?.message));
    return failureResult(unavailable ? 'NOT_AVAILABLE' : 'ERROR', error, input);
  } finally {
    db?.close();
  }
}

export async function listProductChangeRequests({ status = '', limit = 200, collapseDuplicates = false } = {}) {
  let db;
  try {
    db = await openProductOwnerDb({ createIfMissing: false });
    if (!db) return deepFreeze({ status: 'NOT_AVAILABLE', requests: [], error: { code: 'PRODUCT_OWNER_REPOSITORY_NOT_AVAILABLE', retryable: true } });
    if (!db.objectStoreNames.contains(KV_STORE)) throw new Error('PRODUCT_OWNER_STORE_NOT_AVAILABLE');
    const transaction = db.transaction(KV_STORE, 'readonly');
    const done = transactionDone(transaction);
    const value = await requestResult(transaction.objectStore(KV_STORE).get(PRODUCT_CHANGE_REQUEST_INBOX_KEY), 'PRODUCT_CHANGE_REQUEST_INBOX_READ_FAILED');
    await done;
    const inbox = normalizedInbox(value);
    const statuses = Array.isArray(status) ? status.map(clean).filter(Boolean) : [clean(status)].filter(Boolean);
    const sorted = inbox.requests.filter((entry) => statuses.length === 0 || statuses.includes(entry.status))
      .slice().sort((left, right) => String(right.receivedAt).localeCompare(String(left.receivedAt)))
      .map(cloneJson);
    const rows = (collapseDuplicates ? collapseProductChangeRequestDuplicates(sorted) : sorted)
      .slice(0, Math.max(0, limit));
    return deepFreeze({ status: rows.length ? 'READY' : 'EMPTY', revision: inbox.revision, requests: rows, error: null });
  } catch (error) {
    return deepFreeze({ status: 'ERROR', requests: [], error: { code: clean(error?.message) || 'PRODUCT_CHANGE_REQUEST_LIST_FAILED', retryable: true } });
  } finally {
    db?.close();
  }
}

export async function getProductChangeRequest(requestId) {
  const result = await listProductChangeRequests({ limit: 100000 });
  if (result.status === 'ERROR' || result.status === 'NOT_AVAILABLE') return result;
  const entry = result.requests.find((row) => row.request?.requestId === clean(requestId));
  return entry
    ? deepFreeze({ status: 'READY', revision: result.revision, entry: publicEntry(entry), error: null })
    : deepFreeze({ status: 'NOT_AVAILABLE', revision: result.revision, entry: null, error: { code: 'PRODUCT_CHANGE_REQUEST_NOT_FOUND', retryable: false } });
}

export async function beginProductChangeRequestReview({ requestId, actor = null } = {}) {
  return mutateInbox(requestId, (entry) => {
    if (FINAL_STATUSES.has(entry.status)) return { status: 'CONFLICT', error: 'PRODUCT_CHANGE_REQUEST_ALREADY_COMPLETED' };
    if (!REVIEWABLE_STATUSES.has(entry.status)) return { status: 'CONFLICT', error: 'PRODUCT_CHANGE_REQUEST_STATUS_CONFLICT' };
    return {
      ...entry,
      status: 'IN_REVIEW',
      review: {
        ...(entry.review || {}),
        startedAt: entry.review?.startedAt || new Date().toISOString(),
        actor: actor ? cloneJson(actor) : (entry.review?.actor || null),
      },
    };
  });
}

export async function prepareProductChangeRequestApply({ requestId, productCode = '', targetProduct = null, actor = null } = {}) {
  if (!clean(productCode) || !targetProduct || typeof targetProduct !== 'object' || Array.isArray(targetProduct)) {
    return failureResult('REJECTED', new Error('PRODUCT_CHANGE_REQUEST_APPLY_TARGET_INVALID'), { requestId });
  }
  return mutateInbox(requestId, (entry) => {
    if (FINAL_STATUSES.has(entry.status)) return { status: 'CONFLICT', error: 'PRODUCT_CHANGE_REQUEST_ALREADY_COMPLETED' };
    if (!REVIEWABLE_STATUSES.has(entry.status)) return { status: 'CONFLICT', error: 'PRODUCT_CHANGE_REQUEST_STATUS_CONFLICT' };
    return {
      ...entry,
      status: 'IN_REVIEW',
      review: {
        ...(entry.review || {}),
        startedAt: entry.review?.startedAt || new Date().toISOString(),
        actor: actor ? cloneJson(actor) : (entry.review?.actor || null),
        applyTarget: {
          productCode: clean(productCode),
          targetProduct: cloneJson(targetProduct),
          preparedAt: new Date().toISOString(),
        },
      },
    };
  });
}

export async function completeProductChangeRequest({ requestId, resolution, productCode = '', reason = '', actor = null, result = null } = {}) {
  const finalStatus = clean(resolution).toUpperCase();
  if (!FINAL_STATUSES.has(finalStatus)) {
    return failureResult('REJECTED', new Error('PRODUCT_CHANGE_REQUEST_RESOLUTION_INVALID'), { requestId });
  }
  if ((finalStatus === 'APPLIED' || finalStatus === 'LINKED') && !clean(productCode)) {
    return failureResult('REJECTED', new Error('PRODUCT_CODE_REQUIRED'), { requestId });
  }
  return mutateInbox(requestId, (entry) => {
    if (entry.status === finalStatus && clean(entry.result?.productCode) === clean(productCode)) return entry;
    if (FINAL_STATUSES.has(entry.status)) return { status: 'CONFLICT', error: 'PRODUCT_CHANGE_REQUEST_ALREADY_COMPLETED' };
    if (!REVIEWABLE_STATUSES.has(entry.status)) return { status: 'CONFLICT', error: 'PRODUCT_CHANGE_REQUEST_STATUS_CONFLICT' };
    return {
      ...entry,
      status: finalStatus,
      completedAt: new Date().toISOString(),
      review: {
        ...(entry.review || {}),
        actor: actor ? cloneJson(actor) : (entry.review?.actor || null),
        reason: clean(reason),
      },
      result: {
        ...(result && typeof result === 'object' ? cloneJson(result) : {}),
        productCode: clean(productCode),
      },
    };
  });
}

export const productMasterChangeRequestAdapter = deepFreeze({
  version: PRODUCT_CHANGE_REQUEST_ADAPTER_VERSION,
  schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
  ownerAppId: 'master-lookup',
  domain: 'PRODUCT',
  submitChangeRequest: submitProductChangeRequest,
  listChangeRequests: listProductChangeRequests,
  getChangeRequest: getProductChangeRequest,
  beginReview: beginProductChangeRequestReview,
  prepareApply: prepareProductChangeRequestApply,
  completeChangeRequest: completeProductChangeRequest,
});

globalThis.ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER = productMasterChangeRequestAdapter;
