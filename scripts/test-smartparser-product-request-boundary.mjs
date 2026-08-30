#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createProductChangeRequestsFromAnalysis, createSmartParserAnalysisResult } from '../smartparser/analysis-result-contract.js';
import { submitProductChangeRequest } from '../reference-data/product-change-request-adapter.js';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function createFakeIndexedDb({ available = true } = {}) {
  const values = new Map();
  const transactions = [];
  const database = {
    objectStoreNames: { contains: (name) => name === 'store' || name === 'master_products' },
    transaction(storeName, mode) {
      transactions.push({ storeName, mode });
      let completed = false;
      let aborted = false;
      const transaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore(name) {
          assert.equal(name, 'store', 'request adapter may write only the owner inbox store');
          return {
            get(key) {
              const request = { result: undefined, onsuccess: null, onerror: null };
              setTimeout(() => {
                request.result = clone(values.get(key));
                request.onsuccess?.();
                setTimeout(() => {
                  if (!completed && !aborted) {
                    completed = true;
                    transaction.oncomplete?.();
                  }
                }, 0);
              }, 0);
              return request;
            },
            put(value, key) {
              values.set(key, clone(value));
              setTimeout(() => {
                if (!completed && !aborted) {
                  completed = true;
                  transaction.oncomplete?.();
                }
              }, 0);
            },
          };
        },
        abort() {
          aborted = true;
          setTimeout(() => transaction.onabort?.(), 0);
        },
      };
      return transaction;
    },
    close() {},
  };
  return {
    values,
    transactions,
    indexedDB: {
      async databases() { return available ? [{ name: 'MerchOpsDB', version: 2 }] : []; },
      open() {
        const request = { result: database, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      },
    },
  };
}

const baseResult = createSmartParserAnalysisResult({
  analysisId: 'AN-REQUEST',
  idempotencyKey: 'SP-IDEM',
  createdAt: '2026-08-30T01:00:00.000Z',
  sourceMetadata: { catalog: 'CAT', documentDisplayName: 'CAT', catalogWarehouse: '01' },
  baseProductSnapshot: {
    schemaVersion: 'ONEAPP_PRODUCT_SNAPSHOT_V1',
    snapshotId: 'PRODUCT-rev-1-abcdef012345',
    revision: 'rev-1',
    status: 'READY',
  },
  rows: [
    {
      rowId: 'update-row',
      parsedFields: { 입고가: { value: 1200, originalKind: 'VALUE' } },
      match: { status: '🟢 일치', productCode: 'P-1', normalizedProductCode: 'P1', isNewProduct: false, candidates: [] },
      proposedChanges: [{ field: '입고가', beforeValue: 1000, proposedValue: 1200, reason: '검토 단가' }],
      decision: { selected: true, excluded: false, blocked: false },
    },
    {
      rowId: 'create-row',
      parsedFields: { 품목명: { value: '신규', originalKind: 'VALUE' } },
      match: { status: '🟢 신규등록 예정', productCode: 'N-1', normalizedProductCode: 'N1', isNewProduct: true, candidates: [] },
      proposedChanges: [{ field: '품목명', beforeValue: '', proposedValue: '신규', reason: '검토 신규' }],
      decision: { selected: true, excluded: false, blocked: false },
    },
  ],
});

const requests = createProductChangeRequestsFromAnalysis(baseResult, {
  requestedAt: '2026-08-30T02:00:00.000Z',
  actor: { actorState: 'UNVERIFIED_LOCAL' },
});
assert.deepEqual(requests.map((request) => request.operation), ['UPDATE', 'CREATE']);

const rawWriteKeys = new Map([
  ['merchMaster_v870', 'MASTER-BEFORE'],
  ['merchMaster_revision_v870', 'REV-BEFORE'],
  ['merchHistory_v870', 'HISTORY-BEFORE'],
  ['merchStoppedProducts_v2', 'STOP-BEFORE'],
  ['pendingShopStatus', 'PENDING-BEFORE'],
  ['merchMaster_sync_trigger', 'SYNC-BEFORE'],
]);
const rawBefore = clone(Object.fromEntries(rawWriteKeys));
globalThis.localStorage = {
  getItem: (key) => rawWriteKeys.get(String(key)) ?? null,
  setItem: (key, value) => rawWriteKeys.set(String(key), String(value)),
  removeItem: (key) => rawWriteKeys.delete(String(key)),
};

const fake = createFakeIndexedDb();
globalThis.indexedDB = fake.indexedDB;
const first = await submitProductChangeRequest(requests[0]);
assert.equal(first.status, 'PENDING');
assert.equal(first.accepted, true);
const duplicate = await submitProductChangeRequest(requests[0]);
assert.equal(duplicate.status, 'DUPLICATE');
assert.equal(duplicate.accepted, true);

const conflictRequest = clone(requests[0]);
conflictRequest.changes[0].proposedValue = 1300;
const conflict = await submitProductChangeRequest(conflictRequest);
assert.equal(conflict.status, 'CONFLICT');
assert.equal(conflict.accepted, false);

const second = await submitProductChangeRequest(requests[1]);
assert.equal(second.status, 'PENDING');
assert.equal(second.accepted, true);
const invalid = await submitProductChangeRequest({ ...requests[1], requestId: '', idempotencyKey: '' });
assert.equal(invalid.status, 'REJECTED');
assert.equal(invalid.accepted, false);
assert.deepEqual([first, invalid].map((entry) => entry.accepted), [true, false], 'batch callers can preserve per-row partial results');

assert.ok(fake.transactions.every((entry) => entry.storeName === 'store' && entry.mode === 'readwrite'));
assert.deepEqual(Object.fromEntries(rawWriteKeys), rawBefore, 'PENDING request receipt must not touch master/history/stop/local notification keys');

const unavailable = createFakeIndexedDb({ available: false });
globalThis.indexedDB = unavailable.indexedDB;
const notAvailable = await submitProductChangeRequest(requests[1]);
assert.equal(notAvailable.status, 'NOT_AVAILABLE');
assert.equal(notAvailable.accepted, false);

console.log('PASS test-smartparser-product-request-boundary');
