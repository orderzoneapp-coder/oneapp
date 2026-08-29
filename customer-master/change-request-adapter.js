import {
  REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
  cloneJson,
  deepFreeze,
  referenceChangeRequestPayloadHash,
  rejectedChangeRequestResult,
  validateReferenceChangeRequest,
} from '../reference-data/change-request-contract.js';
import { STORE, openDb, requestResult, transactionDone } from './db.js';

export const CUSTOMER_CHANGE_REQUEST_ADAPTER_VERSION = 'ONEAPP_CUSTOMER_CHANGE_REQUEST_ADAPTER_V1';
export const CUSTOMER_CHANGE_REQUEST_INBOX_KEY = 'referenceChangeRequestsV1';
export const CUSTOMER_CHANGE_REQUEST_INBOX_SCHEMA = 'ONEAPP_REFERENCE_CHANGE_REQUEST_INBOX_V1';

const clean = (value) => String(value ?? '').trim();

function emptyInbox() {
  return { schemaVersion: CUSTOMER_CHANGE_REQUEST_INBOX_SCHEMA, revision: 0, requests: [] };
}

function normalizedInbox(row) {
  if (!row) return emptyInbox();
  const value = row.value;
  if (!value || value.schemaVersion !== CUSTOMER_CHANGE_REQUEST_INBOX_SCHEMA || !Array.isArray(value.requests)) {
    throw new Error('CUSTOMER_CHANGE_REQUEST_INBOX_INVALID');
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
    error: { code: clean(error?.message) || 'CUSTOMER_CHANGE_REQUEST_ERROR', retryable: status !== 'CONFLICT' },
  });
}

export async function submitCustomerChangeRequest(input) {
  const validation = validateReferenceChangeRequest(input, {
    expectedDomain: 'CUSTOMER',
    expectedOwnerAppId: 'customer-master',
  });
  if (!validation.valid) return rejectedChangeRequestResult(input, validation);

  let transaction;
  try {
    const request = cloneJson(input);
    const payloadHash = await referenceChangeRequestPayloadHash(request);
    const db = await openDb();
    if (!db.objectStoreNames.contains(STORE.META)) throw new Error('CUSTOMER_OWNER_META_STORE_NOT_AVAILABLE');
    transaction = db.transaction(STORE.META, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE.META);
    const inbox = normalizedInbox(await requestResult(store.get(CUSTOMER_CHANGE_REQUEST_INBOX_KEY)));
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
    const entry = { status: 'PENDING', payloadHash, receivedAt: new Date().toISOString(), request };
    const timestamp = new Date().toISOString();
    store.put({
      key: CUSTOMER_CHANGE_REQUEST_INBOX_KEY,
      value: {
        schemaVersion: CUSTOMER_CHANGE_REQUEST_INBOX_SCHEMA,
        revision: inbox.revision + 1,
        requests: [...inbox.requests, entry],
      },
      updatedAt: timestamp,
    });
    await done;
    return storedResult(entry);
  } catch (error) {
    const unavailable = /(?:NOT_AVAILABLE|OPEN_FAILED|UPGRADE_BLOCKED|META_STORE_NOT_AVAILABLE)/.test(clean(error?.message));
    return failureResult(unavailable ? 'NOT_AVAILABLE' : 'ERROR', error, input);
  }
}

export async function listCustomerChangeRequests({ status = '', limit = 200 } = {}) {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(STORE.META)) throw new Error('CUSTOMER_OWNER_META_STORE_NOT_AVAILABLE');
    const transaction = db.transaction(STORE.META, 'readonly');
    const done = transactionDone(transaction);
    const inbox = normalizedInbox(await requestResult(transaction.objectStore(STORE.META).get(CUSTOMER_CHANGE_REQUEST_INBOX_KEY)));
    await done;
    const rows = inbox.requests.filter((entry) => !status || entry.status === status)
      .slice().sort((left, right) => String(right.receivedAt).localeCompare(String(left.receivedAt)))
      .slice(0, Math.max(0, limit)).map(cloneJson);
    return deepFreeze({ status: rows.length ? 'READY' : 'EMPTY', revision: inbox.revision, requests: rows, error: null });
  } catch (error) {
    return deepFreeze({ status: 'ERROR', requests: [], error: { code: clean(error?.message) || 'CUSTOMER_CHANGE_REQUEST_LIST_FAILED', retryable: true } });
  }
}

export const customerMasterChangeRequestAdapter = deepFreeze({
  version: CUSTOMER_CHANGE_REQUEST_ADAPTER_VERSION,
  schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
  ownerAppId: 'customer-master',
  domain: 'CUSTOMER',
  submitChangeRequest: submitCustomerChangeRequest,
  listChangeRequests: listCustomerChangeRequests,
});

globalThis.ONEAPP_CUSTOMER_MASTER_CHANGE_REQUEST_ADAPTER = customerMasterChangeRequestAdapter;
