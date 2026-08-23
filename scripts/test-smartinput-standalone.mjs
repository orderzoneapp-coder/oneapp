#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeMasterProduct, searchProductCatalog } from '../orderq/product-master-search.js';
import { buildOrderSourceDocumentCanonicalProjection } from '../orderq/intake-identity.js';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const contractSource = read('smartinput/smartinput-contract.js');
const appSource = read('smartinput/smartinput.js');
const dataStoreSource = read('smartinput/smartinput-data-store.js');
const html = read('smartinput/index.html');
const css = read('smartinput/smartinput.css');
const readme = read('smartinput/README.md');
const architecture = read('APP_ARCHITECTURE.md');
const manifest = JSON.parse(read('app-manifest.json'));

const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

assert.equal(contract.APP_ID, 'smart-input');
assert.equal(contract.SCHEMA_VERSION, 'ONEAPP_SMART_INPUT_DRAFT_V1');
assert.equal(contract.DRAFT_STORAGE_KEY, 'oneapp.smartinput.draft.v1');
assert.equal(contract.DRAFT_LIST_STORAGE_KEY, 'oneapp.smartinput.drafts.v1');
assert.equal(contract.DELIVERY_HISTORY_KEY, 'oneapp.smartinput.delivery-history.v1');
assert.equal(contract.SETTINGS_STORAGE_KEY, 'oneapp.smartinput.settings.v1');
assert.deepEqual(Array.from(contract.INPUT_METHODS, item => item.id), ['direct', 'excel', 'text', 'paste', 'photo', 'voice']);
assert.deepEqual(Array.from(contract.STAGES), ['capture', 'extract', 'match', 'review', 'complete']);
assert.deepEqual(Array.from(contract.ROW_FIELDS), ['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'memo', 'description', 'noticePrice']);
const displayRow = contract.normalizeRow({ memo: '메모', description: '직원 적요', noticePrice: 1200 });
assert.equal(displayRow.memo, '메모');
assert.equal(displayRow.description, '직원 적요');
assert.equal(displayRow.noticePrice, 1200);
const commonOnlyProduct = normalizeMasterProduct(
  { 코드: 'COMMON-ONLY-1', 품목명: '공통 마스터 전용상품', 규격: 'EA' },
  'COMMON-ONLY-1',
  'COMMON_MASTER',
  'COMMON-ONLY-1'
);
const selectedCommonProduct = searchProductCatalog('공통 마스터 전용상품', [commonOnlyProduct], 5)[0];
const linkedCommonRow = contract.normalizeRow({
  productId: selectedCommonProduct.productId,
  masterProductId: selectedCommonProduct.masterProductId,
  itemCode: selectedCommonProduct.itemCode,
  itemName: selectedCommonProduct.itemName,
  quantity: 1
});
assert.equal(linkedCommonRow.masterProductId, 'COMMON-ONLY-1');
assert.equal(linkedCommonRow.productIdentityStatus, 'MASTER_LINKED');
assert.equal(buildOrderSourceDocumentCanonicalProjection({ order: {}, items: [linkedCommonRow] }).items[0].masterProductId, 'COMMON-ONLY-1',
  '공통 마스터 전용상품의 실제 ID가 검색·선택·ORDER Q 원문 계약까지 유지되어야 한다.');
const editableMatchedRow = contract.normalizeRow({
  ...linkedCommonRow,
  specification: '10kg', quantity: 2, unit: 'BOX', unitPrice: 15000, memo: '유지 메모'
});
const identityEditedRow = contract.markProductEdit(editableMatchedRow, 'itemName', '사용자 수정 상품명');
assert.equal(identityEditedRow.productId, '');
assert.equal(identityEditedRow.masterProductId, '');
assert.equal(identityEditedRow.matchStatus, 'SIMILAR');
assert.equal(identityEditedRow.productIdentityStatus, 'UNRESOLVED');
assert.equal(identityEditedRow.itemName, '사용자 수정 상품명');
assert.equal(identityEditedRow.specification, '10kg');
assert.equal(identityEditedRow.quantity, 2);
assert.equal(identityEditedRow.unit, 'BOX');
assert.equal(identityEditedRow.unitPrice, 15000);
assert.equal(identityEditedRow.memo, '유지 메모');
for (const [field, value] of [['itemCode', 'NEW-1'], ['itemName', '새 상품'], ['specification', '20kg'], ['quantity', 3], ['unit', 'EA'], ['unitPrice', 17000]]) {
  assert.equal(contract.markProductEdit(editableMatchedRow, field, value)[field], value, `${field} must remain editable for matched rows`);
}

const draft = contract.createDraft({ now: Date.parse('2026-08-23T01:00:00.000Z'), random: 0.1 });
assert.equal(draft.activeMode, 'order');
assert.equal(draft.modes.order.header.orderDate, '2026-08-23');
assert.equal(draft.modes.order.header.recordedAt, '2026-08-23T01:00:00.000Z');
assert.equal(draft.modes.order.header.submittedAt, '');
assert.ok(draft.modes.order.documentId);
const storedDraft = JSON.parse(JSON.stringify(draft));
storedDraft.modes.order.header.orderDate = '1999-01-01';
assert.equal(contract.normalizeDraft(storedDraft).modes.order.header.orderDate, '2026-08-23', 'stored editable order dates must be replaced by the recorded current-time date');
assert.notEqual(draft.modes.order, draft.modes.purchase);
draft.modes.order.sourceText = '주문 원문';
assert.equal(draft.modes.purchase.sourceText, '');

const rawText = '  행복상회\n계란  2판\n';
const firstBatch = contract.createBatch({ batchId: 'B1', sequence: 1, method: 'text', sourceType: 'GENERAL_TEXT', rawText, now: 1 });
assert.equal(firstBatch.rawText, rawText, 'source whitespace and line breaks must be preserved');
let rows = contract.applyParserResults([], firstBatch, [{
  sourceLineKey: 'L1', intakeLineId: 'IL1', rawText: '계란  2판', productId: 'P1', masterProductId: 'MASTER-A001', itemCode: 'A001', itemName: '계란', quantity: 2, unit: '판'
}]);
assert.equal(rows.length, 1);
assert.equal(rows[0].matchStatus, 'MATCHED');
assert.equal(rows[0].masterProductId, 'MASTER-A001');
const syntheticOnlyRow = contract.normalizeRow({ productId: 'PRD-A002', itemCode: 'A002', itemName: '가짜 연결' });
assert.equal(syntheticOnlyRow.matchStatus, 'UNRESOLVED', '합성 productId만으로 실제 마스터 연결 처리하면 안 된다.');
assert.equal(syntheticOnlyRow.productIdentityStatus, 'UNRESOLVED');
rows[0] = contract.markUserEdit(rows[0], 'itemName', '관리자 확정 계란');
rows = contract.applyParserResults(rows, firstBatch, [{
  sourceLineKey: 'L1', intakeLineId: 'IL1', rawText: '계란  2판', productId: 'P1', masterProductId: 'MASTER-A001', itemCode: 'A001', itemName: '파서 덮어쓰기', quantity: 3, unit: '판'
}]);
assert.equal(rows.length, 1, 're-analysis of the same source line must update, not append');
assert.equal(rows[0].itemName, '관리자 확정 계란', 'administrator edits must survive re-analysis');
assert.equal(rows[0].quantity, 3, 'parser-owned fields may refresh');

const secondBatch = contract.createBatch({ batchId: 'B2', sequence: 2, method: 'paste', sourceType: 'CLIPBOARD', rawText: '계란 1판', now: 2 });
rows = contract.applyParserResults(rows, secondBatch, [{
  sourceLineKey: 'L2', rawText: '계란 1판', productId: 'P1', masterProductId: 'MASTER-A001', itemCode: 'A001', itemName: '계란', quantity: 1, unit: '판'
}]);
assert.equal(rows.length, 2, 'later batches must append below existing rows');
assert.equal(rows.filter(row => row.duplicatePossible).length, 2, 'duplicate products must be marked, not summed');

const orderDraft = draft.modes.order;
orderDraft.header = {
  ...orderDraft.header,
  customerId: 'C1', customerName: '행복상회', orderDate: '2026-08-23', warehouseName: '본사'
};
orderDraft.rows = rows;
assert.deepEqual(Array.from(contract.validateOrderDraft(orderDraft)), []);
orderDraft.header.customerId = '';
assert.equal(contract.validateOrderDraft(orderDraft)[0].field, 'customer');

const cutoffSettings = contract.normalizeSettings({
  orderCutoffTime: '12:00',
  allowSameDayDelivery: true,
  defaultDeliveryWeekdays: [0],
  timezone: 'Asia/Seoul'
});
assert.equal(contract.validateDeliveryDate({
  orderDate: '2026-08-23', deliveryDate: '2026-08-23', settings: cutoffSettings,
  now: new Date('2026-08-23T01:00:00.000Z')
}).valid, true, 'same-day delivery must remain available before cutoff');
assert.equal(contract.validateDeliveryDate({
  orderDate: '2026-08-23', deliveryDate: '2026-08-23', settings: cutoffSettings,
  now: new Date('2026-08-23T04:00:00.000Z')
}).code, 'CUTOFF_PASSED', 'same-day delivery must be blocked after cutoff');

const scheduleSettings = contract.normalizeSettings({
  defaultDeliveryWeekdays: [1, 3],
  deliveryCustomerWeekdays: { C1: [2] },
  holidayDates: ['2026-08-24'],
  timezone: 'Asia/Seoul'
});
const scheduleNow = new Date('2026-08-23T01:00:00.000Z');
assert.equal(contract.nextDeliveryDate({ orderDate: '2026-08-23', settings: scheduleSettings, now: scheduleNow }).date, '2026-08-26');
assert.equal(contract.nextDeliveryDate({ orderDate: '2026-08-23', customerId: 'C1', settings: scheduleSettings, now: scheduleNow }).date, '2026-08-25');
assert.equal(contract.validateDeliveryDate({ orderDate: '2026-08-23', deliveryDate: '2026-08-22', settings: scheduleSettings, now: scheduleNow }).code, 'PAST_DATE');

for (const mode of ['order', 'purchase', 'sale']) assert.match(html, new RegExp(`data-mode="${mode}"`));
for (const method of ['direct', 'excel', 'text', 'paste', 'photo', 'voice']) assert.match(html, new RegExp(`data-method="${method}"`));
assert.match(html, /Alt\+1/);
assert.match(html, /Alt\+2/);
assert.match(html, /Alt\+3/);
assert.match(html, /href="\.\.\/orderq\/index\.html" target="_blank" rel="noopener"/);
assert.match(html, /href="\.\.\/orders\.html" target="_blank" rel="noopener"/);
assert.match(html, /<nexus-top app-id="smart-input">/);
assert.match(html, /nexus\/common\/apps-config\.js/);
assert.match(html, /nexus\/common\/nexus-top\.js/);
assert.match(html, /id="draftListButton"/);
assert.match(html, /id="saveState"[^>]*aria-live="polite"[^>]*><\/span>/);
assert.match(html, /id="settingsButton"/);
assert.match(html, /id="taxCustomerInput"/);
assert.doesNotMatch(html, /id="orderDateInput"/);
assert.doesNotMatch(html, /class="stage-rail"/);
assert.match(html, /id="activityTrail"[^>]*aria-live="polite"[^>]*hidden/);
assert.match(html, /id="activityItems" aria-label="누적 입력현황"/);
assert.doesNotMatch(html, /class="parser-card__header"/);
assert.doesNotMatch(html, /<th>원문<\/th>|class="col-source"/);
assert.doesNotMatch(html, /<th>차수<\/th>|<th>상태<\/th>/);
assert.match(html, /<th>품목코드<\/th><th>품목명<\/th><th>규격<\/th><th>수량<\/th><th>단위<\/th><th>단가<\/th><th>공급가액<\/th><th>메모<\/th><th>적요\(직원\)<\/th><th>공지단가<\/th>/);
assert.match(html, /class="col-unit"/);
assert.doesNotMatch(html, /작업 단계|\d+\s*\/\s*5|data-stage=/);
const parserColumnAt = html.indexOf('<section class="parser-card"');
const workbenchColumnAt = html.indexOf('<section class="workbench"');
const relatedColumnAt = html.indexOf('<aside class="related-panel"');
assert.ok(parserColumnAt >= 0 && parserColumnAt < workbenchColumnAt && workbenchColumnAt < relatedColumnAt,
  'desktop workspace must order the parser, workbench and related-app columns from left to right');

assert.match(css, /grid-template-columns: 320px minmax\(0, 1fr\) 220px/);
assert.match(css, /--app-max: 1600px/);
assert.match(css, /\.parser-card \{[^}]*position: sticky;[^}]*padding: 12px;[^}]*border: 1px solid var\(--border\)/);
assert.match(css, /\.source-editor textarea \{[^}]*height: clamp\(360px, calc\(100vh - 340px\), 660px\);[^}]*resize: vertical;[^}]*overflow: auto;/);
assert.match(css, /\.save-state \{[^}]*flex: 0 0 58px;[^}]*width: 58px;[^}]*white-space: nowrap;/);
assert.match(css, /@media \(max-width: 1180px\)/);
assert.match(css, /@media \(max-width: 980px\)/);
assert.match(css, /@media \(max-width: 820px\)/);
assert.match(css, /prefers-color-scheme: dark/);
assert.match(css, /prefers-reduced-motion: reduce/);

for (const required of [
  'captureTextIntake',
  'extractOrderProductLines',
  'analyzeSingleOrderDocument',
  'rematchExtractedLinesForCustomer',
  'createOrder',
  'syncAfterLocalMutation',
  'loadProductCatalog',
  'createLiveCustomer',
  'loadSmartInputData',
  'saveLinkGroup',
  'saveAliasMapping',
  'orderCutoffTime',
  'deliveryCustomerWeekdays',
  'window.Tesseract',
  'SpeechRecognition',
  'captureOccurrenceId',
  'looksLikeKakaoText',
  'appendDeliveryHistory'
]) assert.match(appSource, new RegExp(required));
assert.match(appSource, /extractOrderProductLines\(\{ sourceType: batch\.sourceType, sourceId: 'SMART_INPUT', rawText \}\)/,
  'SmartInput fallback must use the same behavioral order-line extractor as SmartParser');
assert.doesNotMatch(appSource, /split\('\\n'\)\.map\(\(raw, index\)/,
  'SmartInput fallback must not turn every non-empty source line into a product row');
assert.match(appSource, /customerInput'\)\.focus\(\)/);
assert.match(appSource, /SMART_INPUT:\$\{current\.batches\[0\]/);
assert.match(appSource, /editedFields/);
assert.match(appSource, /다음 가능일은 \$\{nextAvailable\.date\}입니다/);
assert.match(appSource, /mappingSource: 'PARSER_CONFIRMED', learnAlias: false/);
assert.match(appSource, /row\.masterProductId = String\(product\.masterProductId/);
assert.match(appSource, /masterProductId: masterLinked \? row\.masterProductId : null/);
assert.match(appSource, /commonMasterProducts\(\)/);
assert.match(appSource, /description: row\.description/);
assert.match(appSource, /noticePrice: row\.noticePrice/);
assert.match(appSource, /일치 \$\{summary\.matched\} · 확인 \$\{summary\.similar\} · 미인식 \$\{summary\.unresolved\}/);
assert.match(appSource, /function renderActivityTrail\(\)/);
assert.match(appSource, /contract\.markProductEdit\(modeDraft\(\)\.rows\[index\], field, input\.value\)/);
assert.match(appSource, /function tryMatchRow\(row, changedField = ''\)/);
const parserEnrichmentSource = appSource.slice(appSource.indexOf('function enrichRowFromUnifiedCatalog'), appSource.indexOf('function rematchQuery'));
assert.doesNotMatch(parserEnrichmentSource, /candidates\.length === 1[\s\S]*applyProduct/,
  'parser fuzzy candidates must stay in confirmation state even when only one candidate exists');
assert.match(parserEnrichmentSource, /row\.matchStatus = 'SIMILAR'/);
assert.match(appSource, /if \(changedField === 'itemName'\) return row\.itemName \|\| row\.itemCode/);
assert.match(appSource, /applyProduct\(row, exact, \{ preserveIdentityField: changedField \}\)/);
assert.match(appSource, /if \(openCandidates\) openProductDialog\(row, \{ query \}\)/);
assert.match(appSource, /applyProduct\(row, product, \{ forceIdentityFields: true \}\)/);
assert.match(appSource, /event\.key !== 'Enter'[\s\S]*tryMatchRow\(row, input\.dataset\.field\)/);
assert.match(appSource, /data-field="specification"/);
assert.match(appSource, /data-field="unit"/);
assert.doesNotMatch(appSource, /data-match-row|item-match-action|>Fn<|rowStatusLabel/);
assert.match(appSource, /function hasMeaningfulDraftContent\(draft\)/);
assert.match(appSource, /rows\.filter\(hasMeaningfulDraftContent\)/);
assert.match(appSource, /state\.draftDirty = true;[\s\S]*setSaveState\('저장 중…', 'saving'\)/);
assert.match(appSource, /updateMethod\(modeDraft\(\)\.activeMethod, \{ persist: false \}\)/);
assert.match(appSource, /window\.addEventListener\('pagehide', \(\) => \{\s*if \(state\.draftDirty\) saveDraftNow\(\);\s*\}\)/);
assert.doesNotMatch(appSource, /window\.addEventListener\('pagehide', saveDraftNow\)/);
assert.match(appSource, /직접입력/);
assert.match(appSource, /텍스트/);
assert.match(appSource, /current\.header\.orderDate = contract\.businessDate\(current\.header\.recordedAt/);
assert.doesNotMatch(appSource, /orderDateInput/);
assert.doesNotMatch(appSource, /function updateStage|progressText|stageIndex/);
assert.doesNotMatch(appSource, /data-order-customer/);
assert.match(dataStoreSource, /oneapp-smartinput/);
assert.match(dataStoreSource, /customerLinkGroups/);
assert.match(dataStoreSource, /temporaryCustomers/);
assert.match(dataStoreSource, /customerAliasMappings/);

const app = manifest.applications.find(item => item.id === 'smart-input');
assert.ok(app, 'smart-input must be registered in the manifest');
assert.equal(app.path, 'smartinput/index.html');
assert.equal(app.status, 'pilot');
assert.ok(app.sharedContracts.includes('nexus-header'), 'SmartInput must display the existing NEXUS header');
assert.ok(app.sharedContracts.includes('orderq-vnext-sync'));
assert.ok(app.sharedContracts.includes('product-master'));
const orderLedger = manifest.sharedDataContracts.find(item => item.id === 'orderq-vnext-sync');
assert.ok(orderLedger.consumers.includes('smartinput/index.html'));
const nexusHeader = manifest.sharedDataContracts.find(item => item.id === 'nexus-header');
assert.ok(nexusHeader.consumers.includes('smartinput/index.html'));

assert.match(readme, /\/smartinput\//);
assert.match(readme, /orders\.html.*별도 전달 어댑터/);
assert.match(architecture, /### 6\.7 Standalone SmartInput intake/);
assert.match(architecture, /does not claim direct `orders\.html` delivery/);
assert.match(architecture, /Customer linking is relational, never canonical merging/);
assert.match(architecture, /same-day cutoff/);

console.log('SmartInput standalone contract PASS');
