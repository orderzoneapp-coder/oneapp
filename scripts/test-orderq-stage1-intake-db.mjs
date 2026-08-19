#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  ORDERQ_DB_VERSION,
  V8_STORE_DEFINITIONS,
  ORDER_SOURCE_DOCUMENT_CANONICAL_VERSION
} from '../orderq/orderq-v8-contracts.js';
import {
  buildAutomaticSourceDocumentKey,
  buildMergeSourceDocumentKey,
  buildOrderSourceDocumentCanonicalProjection,
  buildSourceLineKey,
  buildSourceOccurrenceKey,
  buildSplitSourceDocumentKey,
  canonicalStringify,
  computeOrderSourceDocumentCanonicalHash,
  computeRawFingerprint
} from '../orderq/intake-identity.js';
import { orderItemIdentitySnapshot } from '../orderq/order-document-model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

assert.equal(ORDERQ_DB_VERSION, 8);
assert.equal(V8_STORE_DEFINITIONS.length, 5);
const coreMatchStatus = ['MATCHED', 'MATCH_FAILED', 'EXCLUDED', 'CANCELLED'];

const raw = { text: '대파 3\n청경채 2', source: 'KAKAO' };
const rawFingerprint = await computeRawFingerprint(raw);
assert.equal(rawFingerprint.length, 64);
assert.equal(await computeRawFingerprint({ source: 'KAKAO', text: '대파 3\n청경채 2' }), rawFingerprint);

const nativeA = await buildSourceOccurrenceKey({
  sourceSystem: 'KAKAO', sourceContainerId: 'ROOM-1', sourceNativeId: 'MESSAGE-77', occurredAtEvidence: '2026-08-17T01:00:00+09:00'
});
const nativeB = await buildSourceOccurrenceKey({
  sourceSystem: 'KAKAO', sourceContainerId: 'ROOM-1', sourceNativeId: 'MESSAGE-77', occurredAtEvidence: '2026-08-16T16:00:00Z'
});
assert.equal(nativeA, nativeB, 'native occurrence identity must ignore display timestamp');

const fallbackA = await buildSourceOccurrenceKey({
  sourceSystem: 'SMS', sourceContainerId: 'THREAD-1', senderEvidence: '010-0000-0000',
  normalizedOccurredAt: '2026-08-17T09:00:00+09:00', occurrenceOrdinal: 2
});
const fallbackB = await buildSourceOccurrenceKey({
  sourceSystem: 'SMS', sourceContainerId: 'THREAD-1', senderEvidence: '010-0000-0000',
  normalizedOccurredAt: '2026-08-17T09:00:00+09:00', occurrenceOrdinal: '2'
});
assert.equal(fallbackA, fallbackB);
assert.notEqual(
  await buildSourceOccurrenceKey({ sourceSystem: 'PASTE', sourceContainerId: 'ADMIN', captureOccurrenceId: 'CAPTURE-A' }),
  await buildSourceOccurrenceKey({ sourceSystem: 'PASTE', sourceContainerId: 'ADMIN', captureOccurrenceId: 'CAPTURE-B' })
);

const documentKey = await buildAutomaticSourceDocumentKey({
  sourceOccurrenceKey: nativeA,
  documentType: 'ORDER',
  stableSegmentIdentity: { sourceMessageKeys: ['MESSAGE-77'], range: [0, 12], occurrenceOrdinal: 1 }
});
const lineKey = await buildSourceLineKey({ sourceDocumentKey: documentKey, externalLineId: 0 });
assert.equal(lineKey, await buildSourceLineKey({ sourceDocumentKey: documentKey, externalLineId: '0' }));
const splitA = await buildSplitSourceDocumentKey({ parentSourceDocumentKey: documentKey, immutableBoundary: { lineKeys: ['B', 'A'] } });
const splitB = await buildSplitSourceDocumentKey({ parentSourceDocumentKey: documentKey, immutableBoundary: { lineKeys: ['B', 'A'] } });
assert.equal(splitA, splitB);
assert.equal(await buildMergeSourceDocumentKey(['B', 'A']), await buildMergeSourceDocumentKey(['A', 'B']));

const orderFixtureA = {
  order: {
    orderId: 'ORD-A', orderNo: '20260817-001', orderDate: '2026-08-17', customerId: 'CUS-1', customerName: '표시명 A',
    warehouseId: 'WH-1', warehouseName: '1창고', transactionType: 'SALE', deliveryExpectedDate: '', orderMessage: '',
    sourceType: 'ORDER_IN', sourceId: 'ROOM-1', orderStatus: 'ORDER', adminStatus: 'UNCHECKED',
    revision: 1, createdAt: '2026-08-17T00:00:00Z', intakeSessionId: 'LOCAL-A'
  },
  items: [{
    orderItemId: 'ITEM-A', sourceLineKey: lineKey, productId: null, itemCode: '', itemName: '관리자 임시상품',
    rawQuantity: 2, rawUnit: '개', finalQuantity: 2, finalUnit: '개', price: 0, supplyAmount: 0, vatAmount: null,
    matchStatus: 'MATCH_FAILED', reviewStatus: 'CONFIRMED', productIdentityStatus: 'TEMPORARY_CONFIRMED', createdAt: 'A'
  }]
};
const orderFixtureB = {
  order: { ...orderFixtureA.order, orderId: 'ORD-B', orderNo: '20260817-999', revision: 9, createdAt: 'B', intakeSessionId: 'LOCAL-B' },
  items: [{ ...orderFixtureA.items[0], orderItemId: 'ITEM-B', createdAt: 'B' }]
};
const clientProjection = buildOrderSourceDocumentCanonicalProjection(orderFixtureA);
assert.equal(clientProjection.version, ORDER_SOURCE_DOCUMENT_CANONICAL_VERSION);
assert.equal(canonicalStringify(clientProjection), canonicalStringify(buildOrderSourceDocumentCanonicalProjection(orderFixtureB)));
const clientHash = await computeOrderSourceDocumentCanonicalHash(orderFixtureA);
assert.equal(clientHash, await computeOrderSourceDocumentCanonicalHash(orderFixtureB));
assert.notEqual(clientHash, await computeOrderSourceDocumentCanonicalHash({
  order: orderFixtureB.order,
  items: [{ ...orderFixtureB.items[0], finalQuantity: 3 }]
}));

const identity = orderItemIdentitySnapshot({
  reviewStatus: 'CONFIRMED', productIdentityStatus: 'TEMPORARY_CONFIRMED', productId: null, itemCode: '', itemName: '관리자 임시상품'
}, false);
assert.deepEqual(identity, {
  intakeLineId: '', sourceLineKey: '', reviewStatus: 'CONFIRMED', productIdentityStatus: 'TEMPORARY_CONFIRMED'
});
assert.deepEqual(orderItemIdentitySnapshot({
  reviewStatus: 'PENDING', productIdentityStatus: 'MASTER_LINKED', productId: 'P-1', itemCode: '100', itemName: '대파'
}, true), {
  intakeLineId: '', sourceLineKey: '', reviewStatus: 'PENDING', productIdentityStatus: 'MASTER_LINKED'
});
assert.throws(() => orderItemIdentitySnapshot({
  reviewStatus: 'CONFIRMED', productIdentityStatus: 'MASTER_LINKED', productId: null, itemCode: '', itemName: '대파'
}, false), /ORDERQ_INTAKE_MASTER_IDENTITY_REQUIRED/);
assert.throws(() => orderItemIdentitySnapshot({
  reviewStatus: 'CONFIRMED', productIdentityStatus: 'MASTER_LINKED', productId: 'CODE:100', itemCode: '100', itemName: '대파'
}, false), /ORDERQ_INTAKE_MASTER_IDENTITY_REQUIRED/);
assert.throws(() => orderItemIdentitySnapshot({
  reviewStatus: 'CONFIRMED', productIdentityStatus: 'TEMPORARY_CONFIRMED', productId: null, itemCode: '100', itemName: '임시상품'
}, false), /ORDERQ_INTAKE_TEMPORARY_MASTER_IDENTITY_FORBIDDEN/);
assert.throws(() => orderItemIdentitySnapshot({
  reviewStatus: 'CONFIRMED', productIdentityStatus: 'UNRESOLVED', productId: null, itemCode: '', itemName: '대파'
}, false), /ORDERQ_INTAKE_CONFIRMED_UNRESOLVED_FORBIDDEN/);

const cloudContext = vm.createContext({
  console,
  Utilities: {
    computeDigest: (_algorithm, value) => [...crypto.createHash('sha256').update(String(value)).digest()],
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  }
});
vm.runInContext(`${read('code.gs')}\n${read('orderq-cloud.gs')}`, cloudContext, { filename: 'orderq-stage1-cloud.gs' });
const cloudHash = cloudContext.orderQComputeOrderSourceDocumentCanonicalHash(JSON.parse(JSON.stringify(orderFixtureA)));
assert.equal(cloudHash, clientHash, 'Client and Cloud canonical V1 hashes must match');

const dbSource = read('orderq/orderq-db.js');
const v8Source = read('orderq/orderq-v8-contracts.js');
const repositorySource = read('orderq/intake-repository.js');
const backupSource = read('orderq/orderq-v7-repository.js');
const intakeSource = read('orderq/order-intake-engine.js');
const documentModelSource = read('orderq/order-document-model.js');
const cloudSource = read('orderq-cloud.gs');
for (const store of V8_STORE_DEFINITIONS) assert.match(v8Source, new RegExp(store.name));
assert.match(dbSource, /oldVersion < 8/);
assert.match(dbSource, /deleteIndex\('bySourceMessageKey'\)/);
assert.match(dbSource, /createIndex\('bySourceMessageKey',[\s\S]*unique:\s*false/);
assert.match(dbSource, /bySourceDocumentKey/);
assert.match(dbSource, /LEGACY:\$\{sourceMessageKey\}/);
assert.match(repositorySource, /ORDERQ_INTAKE_OCCURRENCE_CONTENT_CONFLICT/);
assert.match(repositorySource, /ORDERQ_INTAKE_REVIEW_INCOMPLETE/);
assert.match(repositorySource, /ORDERQ_INTAKE_STAGE_INVALID/);
assert.match(repositorySource, /normalizeIntakeReviewStatus/);
assert.match(repositorySource, /validateOrderItemIdentityState/);
assert.match(repositorySource, /injectFailureAt === 'LINES_WRITTEN'/);
assert.match(documentModelSource, /ORDERQ_INTAKE_MASTER_IDENTITY_REQUIRED/);
assert.match(documentModelSource, /ORDERQ_INTAKE_CONFIRMED_UNRESOLVED_FORBIDDEN/);
assert.match(backupSource, /validation\.schemaVersion < DB_VERSION/);
assert.match(intakeSource, /ORDERQ_INTAKE_DOCUMENT_IDEMPOTENCY_CONFLICT/);
for (const status of coreMatchStatus) assert.match(intakeSource, new RegExp(`${status}: ['"]${status}['"]`));
assert.doesNotMatch(intakeSource, /TEMPORARY_CONFIRMED:\s*['"]TEMPORARY_CONFIRMED['"]/);
assert.match(cloudSource, /orderQFindOrderBundleBySourceDocumentKey/);
assert.match(cloudSource, /ORDERQ_SOURCE_DOCUMENT_CANONICAL_VERSION/);

console.log('ORDER IN Stage 1 Intake DB / identity contracts: PASS');
console.log(JSON.stringify({
  schemaVersion: ORDERQ_DB_VERSION,
  stores: V8_STORE_DEFINITIONS.map(store => store.name),
  rawFingerprint,
  nativeOccurrenceKey: nativeA,
  fallbackOccurrenceKey: fallbackA,
  sourceDocumentKey: documentKey,
  sourceLineKey: lineKey,
  canonicalVersion: ORDER_SOURCE_DOCUMENT_CANONICAL_VERSION,
  clientHash,
  cloudHash,
  coreMatchStatus,
  identityInvariants: 'PASS',
  documentStateValidation: 'STATIC_CONTRACT_PRESENT'
}, null, 2));
