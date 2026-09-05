#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  beginProductChangeRequestReview,
  collapseProductChangeRequestDuplicates,
  completeProductChangeRequest,
  getProductChangeRequest,
  listProductChangeRequests,
  prepareProductChangeRequestApply,
  submitProductChangeRequest,
} from '../reference-data/product-change-request-adapter.js';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const values = new Map();
const database = {
  objectStoreNames: { contains: (name) => ['store', 'master_products'].includes(name) },
  transaction(storeName, mode) {
    assert.equal(storeName, 'store');
    let finished = false;
    const transaction = {
      oncomplete: null, onerror: null, onabort: null, error: null,
      objectStore(name) {
        assert.equal(name, 'store');
        return {
          get(key) {
            const request = { result: undefined, onsuccess: null, onerror: null };
            setTimeout(() => {
              request.result = clone(values.get(key));
              request.onsuccess?.();
              setTimeout(() => { if (!finished) { finished = true; transaction.oncomplete?.(); } }, 0);
            }, 0);
            return request;
          },
          put(value, key) {
            values.set(key, clone(value));
            setTimeout(() => { if (!finished) { finished = true; transaction.oncomplete?.(); } }, 0);
          },
        };
      },
      abort() { finished = true; setTimeout(() => transaction.onabort?.(), 0); },
    };
    return transaction;
  },
  close() {},
};

globalThis.indexedDB = {
  async databases() { return [{ name: 'MerchOpsDB', version: 2 }]; },
  open() {
    const request = { result: database, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  },
};

const request = {
  schemaVersion: 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1',
  requestId: 'SKU-REQUEST-TEST-1',
  idempotencyKey: 'SKU-REQUEST-TEST-1',
  domain: 'PRODUCT',
  ownerAppId: 'master-lookup',
  entityId: 'SKU-TEST-001',
  operation: 'CREATE',
  changes: [
    { field: '품목코드', beforeValue: '', proposedValue: 'SKU-TEST-001' },
    { field: '품목명', beforeValue: '', proposedValue: 'SKU 후보 테스트' },
    { field: '규격', beforeValue: '', proposedValue: '1kg' },
    { field: '단위', beforeValue: '', proposedValue: 'BOX' },
  ],
  reason: 'SKU 관리 상품 등록 요청',
  source: { appId: 'item-manager', workflow: 'SKU_MANAGEMENT', original: { name: 'SKU 후보 테스트' } },
  actor: { actorId: null, actorName: '작업자', actorState: 'UNVERIFIED_LOCAL' },
  requestedAt: '2026-09-05T12:00:00.000Z',
};

assert.equal((await submitProductChangeRequest(request)).status, 'PENDING');
assert.equal((await beginProductChangeRequestReview({ requestId: request.requestId })).status, 'IN_REVIEW');
assert.equal((await getProductChangeRequest(request.requestId)).entry.status, 'IN_REVIEW');
const repeatedRequest = {
  ...request,
  requestId: 'SKU-REQUEST-TEST-2',
  idempotencyKey: 'SKU-REQUEST-TEST-2',
  requestedAt: '2026-09-05T12:01:00.000Z',
};
const groupedExistingRequests = collapseProductChangeRequestDuplicates([
  { status: 'PENDING', receivedAt: request.requestedAt, request },
  { status: 'IN_REVIEW', receivedAt: repeatedRequest.requestedAt, request: repeatedRequest },
]);
assert.equal(groupedExistingRequests.length, 1);
assert.equal(groupedExistingRequests[0].status, 'IN_REVIEW');
assert.equal(groupedExistingRequests[0].repeatedRequestCount, 2);
assert.deepEqual(groupedExistingRequests[0].duplicateRequestIds, [request.requestId]);
const repeatedResult = await submitProductChangeRequest(repeatedRequest);
assert.equal(repeatedResult.status, 'DUPLICATE');
assert.equal(repeatedResult.requestId, request.requestId);
assert.equal((await listProductChangeRequests({ status: ['PENDING', 'IN_REVIEW'] })).requests.length, 1);
const collapsed = await listProductChangeRequests({ status: ['PENDING', 'IN_REVIEW'], collapseDuplicates: true });
assert.equal(collapsed.requests.length, 1);
assert.equal(collapsed.requests[0].repeatedRequestCount, 1);
const prepared = await prepareProductChangeRequestApply({ requestId: request.requestId, productCode: 'SKU-TEST-001', targetProduct: { 코드: 'SKU-TEST-001', 품목명: 'SKU 후보 테스트' } });
assert.equal(prepared.status, 'IN_REVIEW');
assert.equal(prepared.entry.review.applyTarget.targetProduct.품목명, 'SKU 후보 테스트');
assert.equal((await completeProductChangeRequest({ requestId: request.requestId, resolution: 'APPLIED', productCode: 'SKU-TEST-001', result: { revision: 2 } })).status, 'APPLIED');
assert.equal((await getProductChangeRequest(request.requestId)).entry.result.revision, 2);
assert.equal((await listProductChangeRequests({ status: ['PENDING', 'IN_REVIEW'] })).requests.length, 0);
assert.equal((await completeProductChangeRequest({ requestId: request.requestId, resolution: 'REJECTED', reason: 'late reject' })).status, 'CONFLICT');

const master = readFileSync(new URL('../Master.html', import.meta.url), 'utf8');
const sku = readFileSync(new URL('../Item_manager.html', import.meta.url), 'utf8');
const commonUi = readFileSync(new URL('../nexus/common/nexus-ui.js', import.meta.url), 'utf8');
assert.match(master, />SKU 관리</);
assert.match(master, /정보수정 Excel/);
assert.match(master, /ProductRequestReviewModal/);
assert.match(master, /확인 및 등록/);
assert.match(master, /기존 상품 연결/);
assert.match(master, />반려</);
assert.match(master, /상품 등록·수정 요청 목록/);
assert.match(master, /handleRegisterAllCreateRequests/);
assert.match(master, /collapseDuplicates: true/);
assert.match(master, /동일 요청 통합 처리/);
assert.match(master, /동일 요청 \{entry\.repeatedRequestCount\}회/);
assert.match(master, />전체 등록</);
assert.match(master, />수정</);
assert.match(master, /top: 'var\(--nexus-ui-header-height, 64px\)'/);
assert.match(master, /PRODUCT_EDITOR_FIELD_LAYOUT_KEY/);
assert.match(master, /loadProductEditorFieldKeys/);
assert.match(master, /moveField\(field\.key, -1\)/);
assert.match(master, />\+ 기본항목 추가</);
assert.match(master, /추가한 항목과 표시 순서는 상품 저장 후 다음 수정창에도 유지됩니다/);
assert.doesNotMatch(master, /Inbox 새로고침/);
assert.match(sku, /SKU_MANAGEMENT_MASTER_WRITE_BLOCKED/);
assert.match(sku, /SKU 후보 생성 및 상품 등록 요청/);
assert.match(sku, />\s*← 상품관리/);
assert.match(sku, /bg-indigo-600 text-white text-\[12px\] font-black shadow-md/);
assert.doesNotMatch(sku, /id: 'theme', label: '행사테마'/);
assert.doesNotMatch(commonUi, /label: '상품등록'/);
assert.match(commonUi, /'item-manager': 'master-lookup'/);

console.log('PASS product management and SKU request workflow');
