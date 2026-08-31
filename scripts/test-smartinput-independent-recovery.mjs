#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('smartinput/index.html');
const appSource = read('smartinput/smartinput.js');
const adapterSource = read('smartinput/legacy-integration-adapter.js');
const extractorSource = read('orderq/smartparser/order-text-extractor.js');
const storeSource = read('smartinput/smartinput-data-store.js');
const voucherActivitySource = read('orderq/voucher-activity-read-adapter.js');
const voucherQueryHtml = read('orderq/voucher-query.html');
const manifest = JSON.parse(read('app-manifest.json'));

assert.match(html, /nexus-ui-theme-init\.js\?v=1\.1\.0/);
assert.match(html, /nexus-ui\.css\?v=1\.3\.0/);
assert.match(html, /nexus-ui-app-themes\.css\?v=1\.2\.0/);
assert.match(html, /data-nexus-app-id="smart-input"/);
assert.match(html, /nexus-ui\.js\?v=1\.4\.0/);
assert.doesNotMatch(html, /nexus-theme-init\.js|apps-config\.js|nexus-top\.js|customer-master\.css|<nexus-top/i);
assert.doesNotMatch(html, /<kbd|Alt\+[1234]|cdn\.jsdelivr\.net/i);
assert.doesNotMatch(appSource, /\.altKey|Alt\+[1234]/i);
assert.doesNotMatch(html, /id="(?:draftListButton|saveDraftButton|catalogSaveButton)"/);
assert.doesNotMatch(html, /id="uploadTemplateButton"|>업로드 양식<\/button>/);
assert.doesNotMatch(appSource, /downloadMinimumUploadTemplate|uploadTemplateButton/);
assert.doesNotMatch(appSource, /DRAFT_LIST_STORAGE_KEY|openDraftListDialog|saveModeDraftSnapshot/);
assert.match(html, /id="restoreAutosaveButton"[^>]*>자동저장 복구<\/button>/);
assert.match(html, /<footer class="voucher-footer-actions"[\s\S]*id="completeButton"[^>]*>저장<\/button>/);
assert.match(html, /<footer class="voucher-footer-actions"[\s\S]*id="estimateNoticeButton"[^>]*>카톡 공유<\/button>[\s\S]*id="estimateExcelButton"[^>]*>Excel 다운로드<\/button>/);
assert.match(html, /id="linkedEstimateList"/);
assert.match(html, /id="catalogPickerList"/);
assert.match(html, /id="voucherContextView"[\s\S]*id="voucherContextList"/, 'voucher modes must use the right rail for date-scoped activity');
assert.match(appSource, /estimateKind === 'LINKED_GROUP'/);
assert.doesNotMatch(appSource, /flushLinkedRowsToSources|flushLinkedIndividualToLibrary|queueLinkedRowsWriteThrough/,
  'autosave must never write through to linked estimate originals');
assert.match(appSource, /saveEstimateBundle\(bundle\)/, 'explicit Save must atomically persist the linked estimate bundle');
assert.match(appSource, /linkedFieldConflicts[\s\S]*linked-value-conflict/, 'different linked source values must be identified before same-value propagation');
assert.match(appSource, /nameCollision[\s\S]*기존 저장분을 덮어쓸까요/, 'exact estimate-name collisions must require overwrite confirmation');
assert.match(appSource, /touchstart', beginEstimateTouchDrag/, 'estimate card handles must support touch reordering as well as desktop drag');
assert.match(appSource, /data-select-estimate-card[\s\S]*data-estimate-drag-handle/, 'estimate cards must separate body selection from handle-only reordering');
assert.doesNotMatch(appSource + html, /data-estimate-select|estimate-card__check/, 'estimate cards must not use checkboxes');
assert.match(html, /id="selectedEstimateDeleteButton"[\s\S]*id="estimateCreateButton"[^>]*>연동견적서 생성</, 'the estimate library must expose only selected deletion and linked creation actions');
assert.match(html, /id="saveEstimateAsButton"[^>]*>새 양식 저장</, 'a loaded estimate must use Save As instead of in-place rename');
assert.doesNotMatch(html + appSource, /estimateRenameButton|merchOpsEstimateButton|openSelectedEstimateRenameDialog|openEstimateCreateChoiceDialog/,
  'rename, MerchOps, and redundant estimate-kind choice controls must stay removed');
assert.match(appSource, /state\.noticeEstimateIds = \[record\.estimateId\];[\s\S]*loadCatalogRecord\(record, \{ preserveSelection: true \}\)/,
  'normal card selection must immediately switch to exactly one stored estimate');
assert.match(appSource, /function estimateCreation\([\s\S]*COMPOSITION_PREVIEW/, 'multi-selection must be isolated in an explicit creation workflow');
assert.doesNotMatch(appSource, /toast\(`\$\{records\.length\}개 견적서 · 중복 제거/, 'estimate selection must not create a redundant coachmark over the action area');
assert.match(appSource, /data-estimate-name[^>]*placeholder="견적서명을 입력하세요"[^>]*autofocus/, 'estimate naming must be immediately ready for direct keyboard input');
assert.match(appSource, /dialog\.showModal\(\);[\s\S]*focusNameInput\(\);[\s\S]*setTimeout\(focusNameInput, 0\)/, 'estimate naming focus must be immediate and restored after native modal focus handling');
assert.doesNotMatch(appSource, /if \(current\.estimateKind !== 'LINKED_GROUP'\) current\.catalogRecordId = ''/, 'saving an individual estimate must retain its identity for subsequent in-place updates');
assert.match(appSource, /from '\.\.\/orderq\/voucher-activity-read-adapter\.js/, 'SmartInput may consume the owner-issued read-only voucher activity adapter');
assert.doesNotMatch(appSource, /from\s+['"]\.\.\/orderq\/(?!voucher-activity-read-adapter)/,
  'SmartInput core must not statically import ORDER Q writer modules');
assert.match(voucherActivitySource, /ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER_V1/);
assert.match(voucherActivitySource, /ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT_V1/);
for (const status of ['READY', 'EMPTY', 'ERROR']) assert.match(voucherActivitySource, new RegExp(`['"]${status}['"]`));
assert.doesNotMatch(voucherActivitySource, /\b(?:readwrite|put|add|delete|clear)\b/,
  'the owner-issued voucher activity adapter must stay read-only');
assert.doesNotMatch(voucherActivitySource, /openOrderQDb/, 'the activity reader must not create or upgrade the owner database');
assert.match(voucherActivitySource, /lineStore\.index\(config\.lineIndex\)\.getAll\(id\)/,
  'activity lines must be queried by the selected document ids instead of scanning the full line store');
assert.match(voucherActivitySource, /dateField: 'orderDate'[\s\S]*dateField: 'purchaseDate'[\s\S]*dateField: 'salesDate'/,
  'date-scoped activity must use each official voucher date field');
assert.match(voucherQueryHtml, /data-nexus-app-id="orderq-vnext"/);
assert.match(adapterSource, /import\(path\)/, 'external app modules must stay behind a dynamic boundary');
assert.match(adapterSource, /from ['"]\.\.\/orderq\/smartparser\/order-text-extractor\.js\?v=0\.8\.1['"]/,
  'the adapter must use the exact 0a order text extractor');
assert.doesNotMatch(adapterSource, /function splitSourceMessages|function parseOrderLine|function looksLikeOrder/,
  'the adapter must not replace the legacy parser chain with a reduced parser');
for (const dependency of ['source-parser', 'order-event-detector', 'order-line-parser']) {
  assert.match(extractorSource, new RegExp(`from ['"]\\./${dependency}\\.js\\?v=0\\.8\\.1['"]`));
}
assert.match(appSource, /cdn\.jsdelivr\.net\/npm\/xlsx-js-style/);
assert.match(appSource, /cdn\.jsdelivr\.net\/npm\/tesseract\.js/);
assert.match(appSource, /renderMode\(\);[\s\S]*?hydrateReferences\(\);/, 'local shell must render before optional references');
assert.doesNotMatch(appSource, /65000|최초 연결은 최대 1분/);

for (const marker of ['parser-card', 'photoResizer', 'workbench', 'related-panel', 'tableScroll', 'estimateLibraryView', 'catalogPickerList', 'linkedEstimateList']) {
  assert.match(html, new RegExp(marker), `${marker} must remain in the protected SmartInput workspace`);
}
assert.match(html, /class="header-customer-group"[\s\S]*id="customerInput"/, 'customer entry must live in the app header');
assert.doesNotMatch(html, /workspace workspace--single|id="sourcePanelToggleButton"/, 'the desktop parser must not be collapsed into the grid work flow');
assert.doesNotMatch(html, /estimateEditorButton|estimateLibraryButton|견적서 목록 전체보기/, 'the right list must coexist with the editor without a replacement view');
assert.doesNotMatch(html + appSource, /추가 예정|양식 생성 모드|source-staging|input-template-core|workflow-core/i);
for (const removed of ['input-template-core.js', 'source-staging.js', 'workflow-core.js', 'integration-adapter.js']) {
  assert.equal(fs.existsSync(path.join(root, 'smartinput', removed)), false, `${removed} must stay removed`);
}

assert.match(storeSource, /const DB_NAME = 'oneapp-smartinput'/);
assert.match(storeSource, /const DB_VERSION = 4/);
for (const store of ['settings', 'customerLinkGroups', 'temporaryCustomers', 'customerAliasMappings', 'estimates', 'sourceImages', 'autosave']) {
  assert.match(storeSource, new RegExp(`['"]${store}['"]`));
}
assert.match(storeSource, /saveLatestAutosave[\s\S]*key: 'current'/);
assert.match(storeSource, /loadLatestAutosave[\s\S]*get\(DATA_STORES\.AUTOSAVE, 'current'\)/);
assert.doesNotMatch(storeSource, /deleteDatabase|\.clear\s*\(/, 'rollback must not erase user data');

const contractSource = read('smartinput/smartinput-contract.js');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;
assert.equal(contract.DRAFT_STORAGE_KEY, 'oneapp.smartinput.draft.v1');
assert.equal(contract.DRAFT_LIST_STORAGE_KEY, 'oneapp.smartinput.drafts.v1');
assert.equal(contract.SETTINGS_STORAGE_KEY, 'oneapp.smartinput.settings.v1');
assert.deepEqual(Object.keys(contract.MODES), ['order', 'purchase', 'sale', 'estimate']);
assert.deepEqual(Array.from(contract.INPUT_METHODS, item => item.id), ['direct', 'excel', 'text', 'paste', 'photo', 'voice']);
const normalizedSettings = contract.normalizeSettings({ futureSetting: { keep: true } });
assert.deepEqual(normalizedSettings.futureSetting, { keep: true }, 'unknown settings must survive normalization');
const draft = contract.createDraft();
draft.futureRoot = 'keep-root';
draft.modes.order.futureMode = 'keep-mode';
draft.modes.order.header.futureHeader = 'keep-header';
draft.modes.order.rows = [{ itemName: '테스트', quantity: 1, futureRow: 'keep-row' }];
const normalizedDraft = contract.normalizeDraft(draft);
assert.equal(normalizedDraft.futureRoot, 'keep-root');
assert.equal(normalizedDraft.modes.order.futureMode, 'keep-mode');
assert.equal(normalizedDraft.modes.order.header.futureHeader, 'keep-header');
assert.equal(normalizedDraft.modes.order.rows[0].futureRow, 'keep-row');
const linkedDraft = contract.normalizeModeDraft('estimate', {
  estimateKind: 'LINKED_GROUP',
  linkedEstimateSources: [{ estimateId: 'E-1', catalogName: '개별 견적', updatedAt: '2026-08-30T00:00:00.000Z' }],
  rows: [{ rowId: 'LINKED:E-1:R-1', linkedSourceEstimateId: 'E-1', linkedSourceEstimateName: '개별 견적', linkedSourceRowId: 'R-1', itemName: '연동상품', quantity: 1 }]
});
assert.equal(linkedDraft.estimateKind, 'LINKED_GROUP');
assert.equal(linkedDraft.linkedEstimateSources[0].estimateId, 'E-1');
assert.equal(linkedDraft.rows[0].linkedSourceRowId, 'R-1');

const adapter = await import('../smartinput/legacy-integration-adapter.js');
const legacyExtractor = await import('../orderq/smartparser/order-text-extractor.js?v=0.8.1');
assert.equal(adapter.extractOrderProductLines, legacyExtractor.extractOrderProductLines,
  'the compatibility adapter must re-export the canonical 0a extractor');
const captured = await adapter.captureTextIntake({ sourceType: 'GENERAL_TEXT', sourceId: 'TEST', rawText: '테스트 거래처\n사과 2박스\n배 3개' });
assert.match(captured.session.intakeSessionId, /^SI-LOCAL-/);
assert.equal(captured.session.localOnly, true, 'pure text parsing must not write the removed raw intake store');
const analyzed = await adapter.analyzeSingleOrderDocument({ session: captured.session, sourcePart: captured.sourcePart, rawText: '테스트 거래처\n사과 2박스\n배 3개' });
assert.equal(analyzed.lines.length, 2);
assert.deepEqual(analyzed.lines.map(row => row.quantity), [2, 3]);
assert.deepEqual(analyzed.lines.map(row => row.itemName), ['사과', '배']);
assert.equal(analyzed.document.localOnly, true);
const fallback = adapter.extractOrderProductLines({ sourceType: 'KAKAO_TEXT', sourceId: 'TEST', rawText: '[테스트] [오후 1:00] 사과 2박스\n배 3개' });
assert.equal(fallback.length, 2);
assert.equal(fallback[0].senderRaw, '테스트');
const parserChainFixture = [
  '[테스트] [오후 1:00] 사과 좋은 거 2박스',
  '2번 감자 3개',
  '[테스트] [오후 1:01] 주문 취소',
  '[테스트] [오후 1:02] 단가 3000원'
].join('\n');
const parserChainRows = adapter.extractOrderProductLines({ sourceType: 'KAKAO_TEXT', sourceId: 'CHAIN', rawText: parserChainFixture });
assert.equal(parserChainRows.length, 2, 'cancel and information messages must not become product rows');
assert.deepEqual(parserChainRows.map(row => row.eventType), ['ORDER', 'ORDER']);
assert.equal(parserChainRows[0].productText, '사과');
assert.equal(parserChainRows[0].attributeText, '좋은 거');
assert.equal(parserChainRows[1].contextReference, '2번');
assert.match(parserChainRows[0].sourceMessageKey, /^SMK-/);
assert.equal(parserChainRows[0].sourceMessageKey, parserChainRows[1].sourceMessageKey);
assert.equal((await adapter.loadPurchaseStage3Capability()).ready, false, 'missing official purchase contract must be scoped unavailable');
assert.equal((await adapter.loadSaleStage4Capability()).ready, false, 'missing official sale contract must be scoped unavailable');
await assert.rejects(adapter.createLiveCustomer({}), error => error.code === 'CUSTOMER_CREATE_UNAVAILABLE');

const smartInput = manifest.applications.find(app => app.id === 'smart-input');
assert.equal(smartInput.path, 'smartinput/index.html');
assert.equal(smartInput.status, 'pilot');
assert.equal(smartInput.owner, 'voucher-input');
const localWork = manifest.sharedDataContracts.find(contract => contract.id === 'smartinput-local-work');
assert.equal(localWork.databaseVersion, 4);
assert.ok(localWork.resources.indexedDbStores.includes('autosave'));
const voucherActivity = manifest.sharedDataContracts.find(contract => contract.id === 'voucher-activity-snapshot');
assert.equal(voucherActivity.owner, 'orderq-vnext');
assert.ok(voucherActivity.consumers.includes('smart-input'));
assert.match(voucherActivity.writerPolicy, /read-only/i);
assert.equal(voucherActivity.resources.queryEntry, 'orderq/voucher-query.html');

console.log('SmartInput 0a rollback and independent compatibility contracts PASS');
