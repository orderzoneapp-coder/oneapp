import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA,
  commitSmartInputWorkDocument,
  listSmartInputWorkDocuments,
  loadSmartInputWorkDocument
} from '../smartinput/smartinput-data-store.js';

const appSource = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../smartinput/index.html', import.meta.url), 'utf8');
const completionStart = appSource.indexOf('async function completeOrder()');
const completionEnd = appSource.indexOf('\nfunction localWorkDocumentTitle', completionStart);
assert.ok(completionStart >= 0 && completionEnd > completionStart, 'the main completion route must remain testable');
const completionSource = appSource.slice(completionStart, completionEnd);
assert.match(completionSource, /\['purchase', 'sale', 'order'\]\.includes\(state\.draft\.activeMode\)\) return saveCurrentWorkDocument\(\)/,
  'purchase, sale, and order completion must save locally first');
assert.ok(completionSource.indexOf('return saveCurrentWorkDocument()') < completionSource.indexOf('return completeShoppingOrderImport()'),
  'shopping-mall import must be saved as SmartInput work before its explicit delivery route');
assert.doesNotMatch(completionSource, /completePurchaseOfficial\(|completeSaleOfficial\(/,
  'the normal save button must not call official purchase/sale finalize');
assert.match(appSource, /async function deliverCurrentOfficialVoucher\(\)[\s\S]*saveCurrentWorkDocument\(\{ quiet: true \}\)[\s\S]*completePurchaseOfficial\(\)[\s\S]*completeSaleOfficial\(\)/,
  'official finalize must stay behind its separate explicit action');
assert.match(appSource, /async function deliverCurrentOfficialVoucher\(\)[\s\S]*inputMappingSession\(\) && !inputMappingTemplateReady\(\)[\s\S]*saveCurrentWorkDocument\(\{ quiet: true \}\)/,
  'official delivery handler must fail closed when its mapping is incomplete');
assert.match(appSource, /async function deliverCurrentOfficialVoucher\(\)[\s\S]*saveCurrentWorkDocument\(\{ quiet: true \}\)[\s\S]*completeShoppingOrderImport\(\)[\s\S]*completeOrderLegacy\(\)/,
  'order transfer must be a separate explicit operation after the local work snapshot is saved');
assert.match(htmlSource, /id="completeButton"[^>]*>[\s\S]*?id="officialDeliveryButton"[^>]*>공식 전표로 전달/,
  'the UI must provide a separate official delivery action');
assert.match(htmlSource, /id="voucherSavedDocumentsTab"[^>]*>내 자료/,
  'purchase/sale must expose the SmartInput-owned saved document list');
const storeSource = readFileSync(new URL('../smartinput/smartinput-data-store.js', import.meta.url), 'utf8');
assert.match(storeSource, /SMARTINPUT_DB_VERSION = 5/, 'saved work must reuse the current DB version');
assert.match(storeSource, /DRAFT_VOUCHERS_V2: 'draftVouchersV2'[\s\S]*createObjectStore\(DATA_STORES\.DRAFT_VOUCHERS_V2, \{ keyPath: 'draftId' \}\)/,
  'saved work must reuse the already-declared v5 Store without a schema upgrade');

const storage = new Map();
let failNextWrite = false;
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('INJECTED_SMARTINPUT_WORK_DOCUMENT_WRITE_FAILURE');
    }
    storage.set(key, String(value));
  }
};

const payloadV1 = {
  documentId: 'SESSION-PURCHASE-1',
  mode: 'purchase',
  header: { customerName: '거래처 A', voucherDate: '2026-09-26' },
  inputMapping: { headers: ['품명', '숨은 원본'], sourceMatrix: [['사과', '원문 값']], workingRows: [{ rowId: 'ROW-1', cells: ['사과', '원문 값'] }] },
  rows: [{ rowId: 'ROW-1', quantity: '0', unitPrice: '', memo: '사용자 수정값' }]
};

const first = await commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 0,
  operationId: 'OP-1', title: '구매 자료 A', actorId: 'ACTOR-A',
  summary: { rowCount: 1, totalAmount: 0 }, payload: payloadV1, updatedAt: '2026-09-26T01:00:00.000Z'
});
assert.equal(first.record.schemaVersion, SMARTINPUT_SAVED_WORK_DOCUMENT_SCHEMA);
assert.equal(first.record.revision, 1);
assert.equal(first.record.documentId, 'SIWORK-1');
assert.deepEqual(first.record.payload, payloadV1, '저장자료는 세션 ID와 분리된 자체 문서 ID를 쓰고 원본·작업셀·0·공란을 보존해야 한다.');

const retry = await commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 0,
  operationId: 'OP-1', title: '구매 자료 A', actorId: 'ACTOR-A',
  summary: { rowCount: 1, totalAmount: 0 }, payload: payloadV1, updatedAt: '2026-09-27T01:00:00.000Z'
});
assert.equal(retry.idempotent, true, '같은 작업 식별자의 재시도는 최초 저장 receipt를 돌려줘야 한다.');
assert.equal(retry.record.revision, 1);
assert.deepEqual(retry.record.payload, payloadV1, 'idempotent retry는 다른 payload로 저장자료를 덮지 않아야 한다.');
assert.equal(retry.record.idempotencyKey, 'OP-1', '재시도 식별자는 기존 인덱스 계약으로 저장해야 한다.');
await assert.rejects(() => commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 0,
  operationId: 'OP-1', title: '구매 자료 A', actorId: 'ACTOR-A', summary: { rowCount: 0 },
  payload: { ...payloadV1, rows: [] }, updatedAt: '2026-09-27T01:00:00.000Z'
}), error => error.code === 'SMARTINPUT_WORK_DOCUMENT_OPERATION_CONFLICT',
'같은 저장 요청 ID에 다른 내용이 들어오면 이전 성공 receipt를 잘못 재사용하면 안 된다.');

const listed = await listSmartInputWorkDocuments({ companyId: 'COMPANY-A', voucherMode: 'purchase' });
assert.equal(listed.length, 1);
assert.equal(Object.hasOwn(listed[0], 'payload'), false, '목록은 본문 전체를 읽지 않고 요약만 반환해야 한다.');
assert.deepEqual(listed[0].summary, { rowCount: 1, totalAmount: 0 });
assert.deepEqual(await listSmartInputWorkDocuments({ companyId: 'COMPANY-B', voucherMode: 'purchase' }), [], '목록은 회사 범위로 격리되어야 한다.');

const opened = await loadSmartInputWorkDocument({ companyId: 'COMPANY-A', documentId: 'SIWORK-1' });
assert.equal(opened.status, 'READY');
assert.deepEqual(opened.record.payload, payloadV1);
assert.equal((await loadSmartInputWorkDocument({ companyId: 'COMPANY-B', documentId: 'SIWORK-1' })).status, 'COMPANY_MISMATCH');

const payloadV2 = structuredClone(payloadV1);
payloadV2.rows[0].quantity = '5';
const second = await commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 1,
  operationId: 'OP-2', title: '구매 자료 A', actorId: 'ACTOR-A',
  summary: { rowCount: 1, totalAmount: 500 }, payload: payloadV2, updatedAt: '2026-09-26T02:00:00.000Z'
});
assert.equal(second.record.revision, 2, '수정은 동일 문서 ID에서 revision을 증가시켜야 한다.');
assert.equal((await loadSmartInputWorkDocument({ companyId: 'COMPANY-A', documentId: 'SIWORK-1' })).record.payload.rows[0].quantity, '5');
const payloadOther = { ...payloadV1, documentId: 'SESSION-PURCHASE-2', rows: [{ rowId: 'ROW-2', quantity: '1', unitPrice: '30' }] };
await commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-2', expectedRevision: 0,
  operationId: 'OP-PURCHASE-2', title: '구매 자료 C', actorId: 'ACTOR-A',
  summary: { rowCount: 1, totalAmount: 30 }, payload: payloadOther, updatedAt: '2026-09-26T03:00:00.000Z'
});
const multiplePurchases = await listSmartInputWorkDocuments({ companyId: 'COMPANY-A', voucherMode: 'purchase' });
assert.equal(multiplePurchases.length, 2, '서로 다른 자체 자료는 같은 업무 목록에서 각각 조회되어야 한다.');
assert.deepEqual(new Set(multiplePurchases.map(record => record.documentId)), new Set(['SIWORK-1', 'SIWORK-2']));

await assert.rejects(() => commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 1,
  operationId: 'OP-STALE', title: 'stale', actorId: 'ACTOR-A', summary: {}, payload: payloadV1
}), error => error.code === 'SMARTINPUT_WORK_DOCUMENT_REVISION_CONFLICT');
assert.equal((await loadSmartInputWorkDocument({ companyId: 'COMPANY-A', documentId: 'SIWORK-1' })).record.revision, 2,
  'preimage 충돌은 저장된 본문을 바꾸지 않아야 한다.');

failNextWrite = true;
await assert.rejects(() => commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 2,
  operationId: 'OP-3', title: '구매 자료 A', actorId: 'ACTOR-A', summary: {}, payload: payloadV1
}), /INJECTED_SMARTINPUT_WORK_DOCUMENT_WRITE_FAILURE/);
assert.equal((await loadSmartInputWorkDocument({ companyId: 'COMPANY-A', documentId: 'SIWORK-1' })).record.revision, 2,
  '저장 실패에서 이전 문서와 revision을 유지해야 한다.');

const salePayload = { documentId: 'SESSION-SALE-1', mode: 'sale', header: { customerName: '거래처 B' }, rows: [{ rowId: 'SALE-1', quantity: '2', unitPrice: '0' }] };
const saleSaved = await commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'sale', documentId: 'SIWORK-SALE-1', expectedRevision: 0,
  operationId: 'OP-SALE-1', title: '판매 자료 B', actorId: 'ACTOR-A', summary: { rowCount: 1, totalAmount: 0 }, payload: salePayload
});
assert.equal(saleSaved.record.revision, 1);
assert.equal((await listSmartInputWorkDocuments({ companyId: 'COMPANY-A', voucherMode: 'sale' })).length, 1,
  '판매 own documents must have a separate list from purchase');
assert.equal((await listSmartInputWorkDocuments({ companyId: 'COMPANY-A', voucherMode: 'purchase' })).length, 2,
  'saving sale must not change the purchase list');

await assert.rejects(() => commitSmartInputWorkDocument({
  companyId: 'COMPANY-B', voucherMode: 'purchase', documentId: 'SIWORK-1', expectedRevision: 0,
  operationId: 'OP-WRONG-COMPANY', title: 'collision', actorId: 'ACTOR-B', summary: {}, payload: payloadV1
}), error => error.code === 'SMARTINPUT_WORK_DOCUMENT_ID_COLLISION');
await assert.rejects(() => commitSmartInputWorkDocument({
  companyId: 'COMPANY-A', voucherMode: 'purchase', documentId: 'INVALID', expectedRevision: 0,
  operationId: 'OP-INVALID', title: 'invalid', actorId: 'ACTOR-A', summary: {}, payload: { ...payloadV1, mode: 'sale' }
}), /SMARTINPUT_WORK_DOCUMENT_PAYLOAD_INVALID/);

console.log('SmartInput saved work document idempotency, company scope, same-ID revision, summary isolation, and failure preservation passed.');
