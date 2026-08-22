#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { V9_STORE_DEFINITIONS } from '../orderq/orderq-v9-contracts.js';
import { ORDERQ_DB_VERSION, V10_STORE_DEFINITIONS } from '../orderq/orderq-v10-contracts.js';
import { customerDisplayStatus, isMissingCustomerValue, missingCustomerFields } from '../orderq/customer-completeness.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  db, service, sourceImport, picker, ui, html, css, intakeEngine, intakeWorkbench,
  directInput, manualInput, collectorRepository, collectorUi, collectorReview, collectorHtml, cloud, syncEngine, masterShell
] = await Promise.all([
  read('orderq/orderq-db.js'),
  read('orderq/customer-master.js'),
  read('orderq/customer-source-import.js'),
  read('orderq/customer-picker.js'),
  read('orderq/customer-master-ui.js'),
  read('partner_db.html'),
  read('orderq/customer-master.css'),
  read('orderq/intake-engine.js'),
  read('orderq/intake-workbench.js'),
  read('orderq/order-intake-engine.js'),
  read('orderq/input.html'),
  read('orderq/history-collector/history-repository.js'),
  read('orderq/collector-ui.js'),
  read('orderq/collector-smartparser-review.js'),
  read('orderq/collector.html'),
  read('orderq-cloud.gs'),
  read('orderq/orderq-sync-engine.js'),
  read('Master.html')
]);

new vm.Script(cloud, { filename: 'orderq-cloud.gs' });
new vm.Script(collectorReview.replace(/^import .*;$/gm, ''), { filename: 'collector-smartparser-review.js' });
assert.equal(ORDERQ_DB_VERSION, 10);
assert.deepEqual(V9_STORE_DEFINITIONS.map(store => store.name), ['customerEvents']);
assert.deepEqual(V10_STORE_DEFINITIONS.map(store => store.name), ['customerSourceLinks', 'customerSourceLinkEvents']);
assert.match(db, /oldVersion < 10/);
const sourceLinkStoreContract = V10_STORE_DEFINITIONS.find(store => store.name === 'customerSourceLinks');
assert.deepEqual(
  sourceLinkStoreContract.indexes.find(index => index.name === 'bySourceLinkKey'),
  { name: 'bySourceLinkKey', keyPath: 'sourceLinkKey', options: { unique: true } },
  'Source Link key must be unique in the v10 schema contract'
);
assert.match(db, /oldVersion < 9/);
assert.doesNotMatch(db, /const customerStore = tx\.objectStore/, 'v9 upgrade must use the provided upgrade transaction');
for (const index of ['byCanonicalCustomerId', 'byCustomerCode', 'byStatusQuality']) assert.match(db, new RegExp(index));

assert.match(service, /qualityStatus === CUSTOMER_QUALITY\.SUPERSEDED/);
assert.match(service, /const canonicalCustomerId = qualityStatus === CUSTOMER_QUALITY\.SUPERSEDED/);
assert.match(service, /export async function mergeCustomers/);
assert.match(service, /export async function unmergeCustomer/);
assert.match(service, /export async function getCustomerFamilyIds/);
assert.match(service, /export async function getUnifiedCustomerLedger/);
assert.match(service, /REVISION_CONFLICT/);
assert.match(service, /synchronizeCustomerMaster/);
assert.match(service, /CUSTOMER_IMPORT_STATUS\.CHANGED/);
assert.match(service, /fieldDecisions/);
assert.match(sourceImport, /canApplyCustomerSourceImport/);
assert.match(sourceImport, /export async function getLatestCustomerSourceImportWork/);
assert.match(sourceImport, /reusableBatch[\s\S]*fileHash/);
assert.match(sourceImport, /customer\.status === CUSTOMER_STATUS\.ACTIVE/);
assert.match(sourceImport, /record\.retryStatus/);

assert.match(picker, /등록 후 계속/);
assert.match(picker, /그래도 새로 등록/);
assert.match(picker, /customer\.status !== CUSTOMER_STATUS\.ACTIVE/);
assert.match(ui, /ROW_HEIGHT/);
assert.match(ui, /state\.filtered\.slice\(start, end\)/);
assert.match(ui, /canApplyCustomerSourceImport\(state\.importRecords\)/);
assert.match(ui, /allowQuickCreate: false/, 'Excel review must not create a live customer before Master apply');
assert.match(ui, /data-field-decision/, 'Changed rows must expose field-level file or existing value decisions');
assert.match(ui, /getLatestCustomerSourceImportWork/, 'Pending Excel work must resume after reload');
assert.match(ui, /importStatusFilter: 'ISSUES'/, 'Workbench must default to unresolved customer rows');
assert.match(html, /erpCustomerExcelFile/);
assert.match(html, /거래처 DB/);
assert.match(html, /customer-master-ui\.js\?v=0\.21\.0/, 'Customer Master entry module must invalidate the deployed cache');
assert.match(ui, /async function initializeCustomerMaster\(\) \{\s+const pending = await getLatestCustomerSourceImportWork\(\)/, 'Saved Excel work must render before Cloud Master synchronization');
assert.match(ui, /await reload\(\);[\s\S]*ensureCustomerMasterReady/, 'Local Customer Master must render before Cloud synchronization');
assert.match(ui, /fallbackFileHash/, 'Excel import must continue with a deterministic file hash when Web Crypto stalls');
assert.match(ui, /chunkSize: 50/, 'Excel import must persist visible progress in small chunks');
assert.match(html, /customer-master\.css\?v=0\.19\.0/, 'Customer Master Workbench styles must invalidate the deployed cache');
assert.match(html, /Master\.html\?view=customers&mode=\$\{initialCustomerMasterMode\}&release=customer-completeness-021/, 'Standalone route must invalidate the cached Master shell');
assert.match(masterShell, /partner_db\.html\?embedded=1&mode=\$\{customerFrameInitialMode\}&release=customer-completeness-021/, 'Master shell must invalidate the cached customer iframe');
assert.match(ui, /customer-master\.js\?v=0\.18\.0/, 'Customer Master Workbench service must invalidate the deployed cache');
assert.doesNotMatch(html, /문제 거래처만 보기/);
assert.match(ui, /data-import-status/, 'Import counts must act as status filters');
assert.match(sourceImport, /newDraftConfirmed: status === CUSTOMER_IMPORT_STATUS\.NEW/, 'Unmatched source rows must be prepared for bulk draft creation');
assert.match(sourceImport, /hasLegacyUnconfirmedNew/, 'Legacy imports must be reanalyzed under the bulk draft contract');
assert.match(css, /data-phase="ANALYZING"/, 'Analysis phase must hide result-only controls');
assert.match(html, /id="importGate"/);
assert.equal((html.match(/data-close-customer-editor/g) || []).length, 2, 'Customer Editor must expose close and cancel controls');
assert.match(ui, /querySelectorAll\('\[data-close-customer-editor\]'\)[\s\S]*elements\.editor\.close\(\)/, 'Customer Editor close controls must bypass form submission');
assert.doesNotMatch(ui, /cm-drop'\)\.addEventListener\('click'/, 'Excel drop label must not open the file picker twice');
assert.match(ui, /openErpImportButton[\s\S]*openFilePicker\(elements\.erpFile\)/, 'ERP upload must open the file picker directly');
assert.match(ui, /openShopImportButton[\s\S]*openFilePicker\(elements\.shopFile\)/, 'SHOP upload must open the file picker directly');
assert.match(ui, /input\.value = ''/, 'Excel input must reset so the same file can be selected again');
assert.match(ui, /findHeaderRow[\s\S]*아이디와 이름\(거래처명\) 열을 찾을 수 없습니다/, 'Source import must validate ERP and SHOP headers');
assert.match(service, /orderq-db\.js\?v=0\.16\.0/, 'Customer Master must load the v11 DB module URL');
assert.match(css, /\.cm-viewport/);
assert.match(html, /data-customer-summary-filter="ACTIVE_ALL"/);
assert.match(html, /data-customer-summary-filter="COMPLETE"[\s\S]*정보 완료/);
assert.match(html, /id="customerGroup1Filter"[\s\S]*id="customerGroup2Filter"[\s\S]*id="customerManagerFilter"/);
assert.match(html, /<span>그룹1<\/span><span>그룹2<\/span>/, 'Customer list must expose both group levels');
assert.match(ui, /customer\.group2Name \|\| '-'/, 'Customer rows must render group2');
assert.match(ui, /group1 === 'ALL'[\s\S]*group2 === 'ALL'/, 'Group1 and Group2 filters must combine with AND');
assert.match(html, /id="customerIssueGrid"/);
assert.match(ui, /state\.summaryFilter === 'INCOMPLETE'/, 'Information supplement card must switch to the Excel editor');
assert.match(ui, /const ISSUE_FIELDS = Object\.freeze\(\['customerName', 'address', 'mobile'\]\)/, 'Only business name, address and mobile are directly editable');
assert.match(ui, /ArrowDown[\s\S]*ArrowUp[\s\S]*ArrowLeft[\s\S]*ArrowRight/, 'Excel editor must support keyboard cell navigation');
assert.match(ui, /clipboardData[\s\S]*split\('\\t'\)/, 'Excel editor must support multi-cell paste');
assert.match(ui, /await syncAndReload\(\)/, 'Issue edits must synchronize with Cloud after saving');
assert.equal(isMissingCustomerValue(''), true);
assert.equal(isMissingCustomerValue('   '), true);
assert.equal(isMissingCustomerValue('-'), true);
assert.equal(isMissingCustomerValue('없음'), true);
assert.equal(isMissingCustomerValue('010-0000-0000'), false, 'Mobile requires presence only');
assert.deepEqual(missingCustomerFields({ customerName: '상호', address: '-', mobile: '' }).map(([field]) => field), ['address', 'mobile']);
assert.equal(customerDisplayStatus({ status: 'ACTIVE', qualityStatus: 'VERIFIED', customerName: '상호', address: '주소', mobile: '010' }), 'COMPLETE');
assert.equal(customerDisplayStatus({ status: 'ACTIVE', qualityStatus: 'VERIFIED', customerName: '상호', address: '', mobile: '010' }), 'INCOMPLETE');
assert.equal(customerDisplayStatus({ status: 'ACTIVE', qualityStatus: 'DUPLICATE_CANDIDATE', customerName: '', address: '', mobile: '' }), 'DUPLICATE_CANDIDATE');
for (const customer of [
  { status: 'INACTIVE', qualityStatus: 'VERIFIED' },
  { status: 'DELETED', qualityStatus: 'VERIFIED' },
  { status: 'ACTIVE', qualityStatus: 'SUPERSEDED' }
]) assert.equal(customerDisplayStatus(customer), 'EXCLUDED');
assert.match(ui, /state\.issueErrors\.set\(customerId/, 'Failed issue rows must retain row-level errors');
assert.match(css, /html\.cm-embedded body\.customer-master-page[^{]*\{[^}]*overflow: hidden/, 'Embedded list must remove page scrolling');
assert.match(css, /\.cm-issue-grid thead th \{ position: sticky/, 'Issue grid headers must remain fixed');

assert.doesNotMatch(intakeEngine, /if \(!customer\) throw new Error\('ORDERQ_INTAKE_CUSTOMER_REQUIRED'\)/);
assert.match(intakeEngine, /rematchExtractedLinesForCustomer/);
assert.match(intakeWorkbench, /source: 'ORDER_IN_QUICK_CREATE'/);
assert.match(intakeWorkbench, /customerOverride: customer \?/);

assert.doesNotMatch(directInput, /customerStore\.add\(customer\)/);
assert.match(directInput, /미등록 거래처입니다/);
assert.match(directInput, /customerSnapshot: customerSnapshot\(customer\)/, 'Orders must preserve the selected Customer Master snapshot');
assert.match(manualInput, /customer:selected/, 'Direct input must retain the customerId returned by the shared Customer Picker');
assert.match(manualInput, /loadedCustomerId = customer\.customerId/, 'Direct input must save the selected canonical customerId');
assert.doesNotMatch(collectorRepository, /customer = candidate;\s*customerStore?\.put/);
assert.match(collectorRepository, /미등록 거래처입니다/);
assert.match(collectorUi, /resolvePreparedCustomers/);
assert.match(collectorUi, /openCustomerPicker/);
assert.match(collectorHtml, /collector-smartparser-review\.js\?v=0\.12\.2/);

assert.doesNotMatch(cloud, /source: 'ORDER_SYNC'/);
assert.match(cloud, /ORDERQ_CUSTOMER_NOT_FOUND/);
assert.match(cloud, /ORDERQ_CUSTOMER_SUPERSEDED/);

console.log('ORDER Q Customer Master contracts: PASS');
console.log(JSON.stringify({
  schemaVersion: ORDERQ_DB_VERSION,
  customerEventStore: V9_STORE_DEFINITIONS[0].name,
  canonicalCustomer: 'PASS',
  mergeUnmerge: 'PASS',
  pickerQuickCreate: 'PASS',
  cloudAutoCreateBlocked: 'PASS',
  virtualizedImportWorkbench: 'PASS'
}, null, 2));

assert.match(html, /id="shopCustomerExcelFile"/);
assert.match(sourceImport, /sourceLinkKey = sourceSystem + "::" + sourceCustomerCode|return `\$\{system\}::\$\{rawCode\}`/);
assert.match(sourceImport, /BUSINESS_NUMBER_EXACT/);
assert.match(sourceImport, /NAME_SIMILAR/);
assert.match(sourceImport, /same|같은 출처 거래처코드/);
assert.match(sourceImport, /CUSTOMER_SOURCE_LINK_EVENT/);
assert.match(cloud, /orderQCustomerMasterReset/);
assert.match(cloud, /ORDERQ_CUSTOMER_RESET_CONFIRMATION_REQUIRED/);
assert.match(cloud, /ORDERQ_CUSTOMER_RESET_PRESERVED_COUNT_CHANGED/);
assert.match(cloud, /CUSTOMER_SOURCE_LINK_EVENT: orderQSheetDataCount/);
assert.match(cloud, /ORDERQ_CUSTOMER_RESET_GENERATION_MISMATCH/);
assert.match(syncEngine, /applyCustomerResetState/);
assert.match(syncEngine, /STORE\.CUSTOMERS\)\.clear\(\)/);
assert.match(syncEngine, /STORE\.CUSTOMER_ALIASES\)\.clear\(\)/);
assert.match(syncEngine, /STORE\.CUSTOMER_SOURCE_LINKS\)\.clear\(\)/);
assert.doesNotMatch(syncEngine, /STORE\.CUSTOMER_EVENTS\)\.clear\(\)/);
assert.doesNotMatch(syncEngine, /STORE\.CUSTOMER_SOURCE_LINK_EVENTS\)\.clear\(\)/);
assert.match(sourceImport, /sourceSnapshot/);
assert.doesNotMatch(sourceImport, /pullRemote/, 'Excel analysis must not wait for Cloud sync');
assert.match(sourceImport, /status: 'PREPARING'/, 'Import batch must be persisted before source analysis');
assert.match(sourceImport, /persistCustomerSourceImportChunk/, 'Source records must be persisted in chunks');
assert.match(sourceImport, /processedCount: processed/, 'Each committed chunk must advance the persisted row count');
assert.match(sourceImport, /await persistCustomerSourceImportChunk\(persistedBatch, pendingChunk\)[\s\S]*onProgress\?\.\(\{ phase: 'PERSISTED'/, 'Progress must update only after the chunk transaction commits');
assert.match(sourceImport, /\['PREPARING', 'PREPARED', 'PARTIAL'\]/, 'Interrupted imports must be resumable');
assert.match(sourceImport, /setTimeout\(resolve, 0\)/, 'Excel analysis must yield between row chunks');
assert.match(ui, /Excel 읽기 완료/);
assert.match(ui, /분석·저장 중/);
assert.match(ui, /IndexedDB 오류/);
assert.match(ui, /data-retry-import/);
assert.match(sourceImport, /sourceLinkRevision: Number\(existingLink\?\.revision \|\| 0\)/, 'Import analysis must retain the Source Link revision it reviewed');
assert.match(sourceImport, /actualSourceLinkRevision !== expectedSourceLinkRevision/, 'Import apply must reject a stale Source Link decision');
assert.match(sourceImport, /expectedRevision = null[\s\S]*CUSTOMER_SOURCE_LINK_EXPECTED_REVISION_REQUIRED/, 'Source Link mutations must require expectedRevision');
assert.match(sourceImport, /CUSTOMER_SOURCE_LINK_REVISION_CONFLICT/, 'Source Link mutations must report revision conflicts');
assert.match(ui, /customer-source-import\.js\?v=0\.15\.0/, 'Chunked Source Import must invalidate the module cache');
assert.match(sourceImport, /ERP_CUSTOMER_17COL_V1/, 'ERP imports must be versioned against the verified 17-column source contract');
for (const header of ['담당자명', '거래처그룹1코드', '그룹1', '거래처그룹2코드', '거래처그룹2명', '거래처코드', '거래처명', '적요', '결제일', '계좌', '단가그룹', '핸드폰번호', '대표자명', '주소1', '전화', '검색창내용', 'Email']) {
  assert.match(sourceImport, new RegExp(header), `ERP 17-column mapping must include ${header}`);
}
assert.match(sourceImport, /CUSTOMER_CODE_EXACT/, 'ERP recovery must preserve customerId by exact customer code');
assert.match(sourceImport, /EXISTING_IMPORT_HISTORY/, 'ERP recovery must reuse prior applied import history');
assert.match(sourceImport, /mappingVersion === expectedMappingVersion/, 'Legacy import caches must not bypass the current mapping contract');
assert.match(service, /STORE\.CUSTOMER_SOURCE_LINKS/, 'Customer search must include ERP and SHOP external identifiers');
assert.match(html, /name="group2Name"/);
assert.match(html, /name="bankAccountText"/);
assert.match(html, /data-customer-source-links/);
