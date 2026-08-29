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
    return storedResult(entry);
  } catch (error) {
    const unavailable = /(?:NOT_AVAILABLE|OPEN_FAILED|OPEN_BLOCKED|STORE_NOT_AVAILABLE)/.test(clean(error?.message));
    return failureResult(unavailable ? 'NOT_AVAILABLE' : 'ERROR', error, input);
  } finally {
    db?.close();
  }
}

export async function listProductChangeRequests({ status = '', limit = 200 } = {}) {
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
    const rows = inbox.requests.filter((entry) => !status || entry.status === status)
      .slice().sort((left, right) => String(right.receivedAt).localeCompare(String(left.receivedAt)))
      .slice(0, Math.max(0, limit)).map(cloneJson);
    return deepFreeze({ status: rows.length ? 'READY' : 'EMPTY', revision: inbox.revision, requests: rows, error: null });
  } catch (error) {
    return deepFreeze({ status: 'ERROR', requests: [], error: { code: clean(error?.message) || 'PRODUCT_CHANGE_REQUEST_LIST_FAILED', retryable: true } });
  } finally {
    db?.close();
  }
}

export const productMasterChangeRequestAdapter = deepFreeze({
  version: PRODUCT_CHANGE_REQUEST_ADAPTER_VERSION,
  schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
  ownerAppId: 'master-lookup',
  domain: 'PRODUCT',
  submitChangeRequest: submitProductChangeRequest,
  listChangeRequests: listProductChangeRequests,
});

globalThis.ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER = productMasterChangeRequestAdapter;
