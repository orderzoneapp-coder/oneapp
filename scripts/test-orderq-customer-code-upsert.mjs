import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const core = read('orderq/customer-code-upsert.js');
const ui = read('orderq/customer-code-upsert-ui.js');
const v11Source = read('orderq/orderq-v11-contracts.js');
const cloud = read('orderq-cloud.gs');
const page = read('partner_db.html');
const customer = read('orderq/customer-master.js');
const v11 = await import(pathToFileURL(path.join(root, 'orderq/orderq-v11-contracts.js')).href);
const upsert = await import(pathToFileURL(path.join(root, 'orderq/customer-code-upsert.js')).href);
const syncIdentity = await import(pathToFileURL(path.join(root, 'orderq/sync-identity.js')).href);

assert.equal(v11.ORDERQ_DB_VERSION, 11, 'T01 DB schema must be v11');
assert.equal(v11.V11_STORE.CUSTOMER_HEADER_MAPPINGS, 'customerHeaderMappings');
assert.equal(v11.V11_STORE.CUSTOMER_USER_FIELD_DEFINITIONS, 'customerUserFieldDefinitions');
assert.match(v11Source, /bySourceHeader[^\n]+\['sourceSystem', 'normalizedHeader'\]/, 'T01 mapping unique by source/header');

assert.match(customer, /userText\$\{String\(index \+ 1\)\.padStart\(2, '0'\)\}/, 'T02 text custom fields 01-10');
assert.match(customer, /userNumber\$\{String\(index \+ 1\)\.padStart\(2, '0'\)\}/, 'T02 number custom fields 01-10');
assert.match(core, /ensureCustomerUserFieldDefinitions/, 'T02 definitions are persisted');
assert.match(ui, /customer-field-manager-row/, 'T02 custom fields have management UI');
assert.match(page, /data-customer-user-fields/, 'T02 active fields are exposed in Customer editor');

assert.match(core, /DUPLICATE_CODE_IN_IMPORT/, 'T03 same-import duplicate reason exists');
assert.match(core, /duplicates\.length > 1/, 'T03 all duplicate-code rows fail');
assert.match(core, /byCustomerCode[^\n]+getAll\(normalizedCode\)/, 'T04 later upload updates by customerCode');
assert.doesNotMatch(core, /if \([^\n]*fileHash[^\n]*(return|throw)/, 'T05 fileHash must not block re-upload');

assert.match(core, /if \(!customerCode\)/, 'T06 customerCode is required');
assert.doesNotMatch(core, /if \(!customerName\)/, 'T06 customerName must not block Excel upsert');
assert.match(core, /if \(value === 0 \|\| clean\(value\) !== ''\) patch\[field\] = value/, 'T07 blanks preserve existing values');
assert.match(core, /unmatchedValues/, 'T08 unmatched values retain evidence');
assert.match(core, /NUMBER_FIELD_PARSE_FAILED/, 'T09 number errors exclude only the field');
assert.match(core, /beforeValues/, 'T10 before values are stored');
assert.match(core, /afterValues/, 'T10 after values are stored');

assert.match(core, /db\.transaction\(stores, 'readwrite'\)/, 'T11 each row is atomic');
assert.match(core, /processed % 200 === 0/, 'T12 200-row checkpoint exists');
assert.match(core, /resumeCustomerCodeUpsert/, 'T12 interrupted work can resume');
assert.match(ui, /중단된 저장 작업을 이어서 처리합니다/, 'T12 UI exposes recovery');

assert.match(ui, /detectCustomerFileType/, 'T13 wrong file detection is wired');
assert.match(ui, /판정 근거 헤더/, 'T13 warning shows evidence');
assert.match(ui, /confirm\(/, 'T13 administrator can proceed');

assert.match(ui, /신규/, 'T14 created is visible');
assert.match(ui, /변경 없음/, 'T14 unchanged is visible');
assert.match(ui, /전체 처리 실패/, 'T14 whole failure is explicit');
assert.match(ui, /Excel 원본 ·/, 'T14 row failure shows the original Excel row');
assert.match(ui, /\(빈 값\)/, 'T14 blank Excel cells remain visibly distinguishable');
assert.match(ui, /Object\.entries\(record\.rawRow/, 'T14 raw evidence retains every original header and cell');
assert.doesNotMatch(ui, /실패 원문과 근거/, 'T14 primary failure evidence must not expose internal diagnostic JSON');
assert.match(ui, /필드 제외/, 'T14 field exclusion has a view');
assert.match(ui, /미매핑 열/, 'T14 unmatched columns have a view');
assert.match(page, /applyImportButton" hidden/, 'T14 separate Master apply action is removed');

assert.match(core, /CLOUD_SYNC_PENDING/, 'T15 local completion can remain Cloud pending');
assert.match(core, /CLOUD_SYNCED/, 'T15 Cloud completion is separate');
assert.match(core, /customerImportId/, 'T15 every upload queue row retains its owning import ID');
assert.match(core, /acked\.length === owned\.length/, 'T15 completion requires every owned queue row ACK');
assert.match(ui, /scheduleCloudRetry/, 'T15 pending Cloud work has automatic retry');
assert.match(ui, /addEventListener\('online'/, 'T15 retry resumes immediately when connectivity returns');
assert.match(page, /customer-code-upsert-ui\.js\?v=0\.19\.0/, 'Foundation adapter has an explicit browser cache version');
assert.match(ui, /prepareCustomerLegacyUpsert/, 'Foundation mapping must feed the unchanged customer code upsert core through an adapter');
assert.match(ui, /state\.mappingPreview\.legacyMappings/, 'only Foundation-generated compatibility mappings are persisted into the unchanged core adapter');
assert.match(ui, /로컬 저장/, 'T15 UI separates local state');
assert.match(ui, /Cloud 동기화/, 'T15 UI separates Cloud state');
assert.match(cloud, /ORDERQ_SHEET_SCHEMA_VERSION = '8'/, 'T15 Cloud schema advances');
assert.match(cloud, /CUSTOMER_HEADER_MAPPING/, 'T15 header mappings sync');
assert.match(cloud, /CUSTOMER_USER_FIELD_DEFINITION/, 'T15 field definitions sync');

assert.match(core, /sourceLinkKey\(sourceSystem, customerCode\)/, 'ERP/SHOP links are namespaced');
assert.match(ui, /saveCustomerHeaderMapping/, 'unmatched headers can be mapped');
assert.match(ui, /runStoredRows\(\{ resetFilter: false \}\)/, 'new mappings reprocess stored raw rows');

const pendingQueue = upsert.summarizeCustomerUpsertQueue([
  { customerImportId: 'JOB-1', status: 'ACKED' },
  { customerImportId: 'JOB-1', status: 'PENDING', lastError: 'WAIT' },
  { customerImportId: 'JOB-2', status: 'ACKED' }
], 'JOB-1');
assert.equal(pendingQueue.cloudStatus, 'CLOUD_SYNC_PENDING', 'T15 another job ACK must not hide this job pending row');
assert.deepEqual({ total: pendingQueue.total, acked: pendingQueue.acked, pending: pendingQueue.pending }, { total: 2, acked: 1, pending: 1 });
const syncedQueue = upsert.summarizeCustomerUpsertQueue([
  { customerImportId: 'JOB-1', status: 'ACKED' },
  { payload: { importId: 'JOB-1' }, status: 'ACKED' }
], 'JOB-1');
assert.equal(syncedQueue.cloudStatus, 'CLOUD_SYNCED', 'T15 all owned queue rows ACK the job');
assert.equal(upsert.customerUpsertRetryDelay(0), 15000);
assert.equal(upsert.customerUpsertRetryDelay(20), 300000, 'T15 retry backs off with a five-minute cap');
const revisionRetry = upsert.customerUpsertSourceLinkConflictPatch({
  customerImportId: 'JOB-1', status: 'CONFLICT', entityType: 'CUSTOMER_SOURCE_LINK', serverRevision: 4,
  payload: { customerId: 'CU-1', revision: 2 }, remotePayload: { customerId: 'CU-1' }
}, 'JOB-1', '2026-08-22T00:00:00.000Z');
assert.deepEqual({ status: revisionRetry.status, baseRevision: revisionRetry.baseRevision, revision: revisionRetry.revision, payloadRevision: revisionRetry.payload.revision },
  { status: 'PENDING', baseRevision: 4, revision: 5, payloadRevision: 5 }, 'revision-only Source Link conflict retries from the Cloud revision');
assert.equal(upsert.customerUpsertSourceLinkConflictPatch({
  customerImportId: 'JOB-1', status: 'CONFLICT', entityType: 'CUSTOMER_SOURCE_LINK', serverRevision: 4,
  payload: { customerId: 'CU-1' }, remotePayload: { customerId: 'CU-2' }
}, 'JOB-1'), null, 'different-customer Source Link conflict remains explicit instead of being overwritten');

assert.match(ui, /renderPreview\(\)/, 'T16 file selection renders a read-only preview');
assert.match(ui, /업로드 실행/, 'T16 persistence requires an explicit execution action');
assert.match(ui, /selectWorkbookSheet/, 'T17 multiple candidate sheets require selection');
assert.equal(upsert.normalizeCustomerHeader(' 사업자_번호-(거래처 코드) '), '사업자번호거래처코드', 'T18 headers use exact deterministic normalization');
assert.equal(upsert.isCustomerSystemRow({ A: '합계', B: '10' }), true, 'T19 deterministic total rows are excluded');
assert.doesNotMatch(core, /queueItem\('SOURCE_RECORD'/, 'T20 raw source rows never enter Cloud queue');
assert.doesNotMatch(core, /sourceSnapshot: \{ \.\.\.record\.rawRow \}/, 'T20 source links retain identifiers, not full source rows');

let sequence = 0;
const makeId = prefix => `${prefix}-${++sequence}`;
const firstIdentity = syncIdentity.createSyncIdentity({ entityType: 'CUSTOMER', entityId: 'CU-1', revision: 1, payload: { b: 2, a: 1 } }, makeId);
const rebasedIdentity = syncIdentity.createSyncIdentity({ entityType: 'CUSTOMER', entityId: 'CU-1', revision: 2, payload: { a: 1, b: 3 } }, makeId, firstIdentity);
assert.equal(rebasedIdentity.operationId, firstIdentity.operationId, 'T21 rebase preserves logical operationId');
assert.equal(rebasedIdentity.parentMutationId, firstIdentity.mutationId, 'T21 rebase links a new mutation to its parent');
assert.notEqual(rebasedIdentity.mutationId, firstIdentity.mutationId, 'T21 rebase creates a new mutationId');
assert.match(cloud, /ORDERQ_MUTATION_CHECKSUM_MISMATCH/, 'T22 Cloud rejects mutationId reuse with a different checksum');
assert.match(cloud, /requestId/, 'T23 Cloud records request identity separately');
assert.match(customer, /retireCustomer/, 'T24 customer deletion is an explicit lifecycle operation');
assert.match(customer, /status: CUSTOMER_STATUS\.DELETED/, 'T24 deletion preserves the customer identity as a tombstone');
assert.doesNotMatch(customer, /CUSTOMERS\)\.delete\(customerId\)/, 'T24 customer deletion never physically removes the stable ID');
assert.match(customer, /linkStatus: 'DELETED'/, 'T24 aliases and source links cannot keep resolving a deleted customer');

console.log('PASS orderq customerCode upsert architecture T01-T24');
