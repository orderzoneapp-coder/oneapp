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
const linkedSourceEditSource = read('smartinput/linked-estimate-source-edit.js');
const voucherActivitySource = read('orderq/voucher-activity-read-adapter.js');
const voucherQueryHtml = read('orderq/voucher-query.html');
const manifest = JSON.parse(read('app-manifest.json'));

assert.match(html, /nexus-ui-theme-init\.js\?v=1\.1\.0/);
assert.match(html, /nexus-ui\.css\?v=1\.3\.5/);
assert.match(html, /nexus-ui-app-themes\.css\?v=1\.3\.11/);
assert.match(html, /smartinput\.css\?v=0\.9\.18/);
assert.match(html, /smartinput-contract\.js\?v=0\.6\.5/);
assert.match(html, /smartinput\.js\?v=0\.11\.51/);
assert.match(html, /data-nexus-app-id="smart-input"/);
assert.match(html, /nexus-ui\.js\?v=1\.6\.1/);
assert.doesNotMatch(html, /nexus-theme-init\.js|apps-config\.js|nexus-top\.js|customer-master\.css|<nexus-top/i);
assert.doesNotMatch(html, /<kbd|Alt\+[1234]|cdn\.jsdelivr\.net/i);
assert.doesNotMatch(appSource, /\.altKey|Alt\+[1234]/i);
assert.doesNotMatch(html, /id="(?:draftListButton|saveDraftButton|catalogSaveButton)"/);
assert.doesNotMatch(html, /id="uploadTemplateButton"|>업로드 양식<\/button>/);
assert.doesNotMatch(appSource, /downloadMinimumUploadTemplate|uploadTemplateButton/);
assert.doesNotMatch(appSource, /DRAFT_LIST_STORAGE_KEY|openDraftListDialog|saveModeDraftSnapshot/);
assert.match(html, /id="restoreAutosaveButton"[^>]*>자동저장 복구<\/button>/);
assert.match(html, /<footer class="voucher-footer-actions"[\s\S]*id="completeButton"[^>]*>저장<\/button>/);
assert.match(html, /<footer class="voucher-footer-actions"[\s\S]*id="estimateCreateButton"[^>]*>연동견적서 생성<\/button>[\s\S]*id="saveEstimateAsButton"[^>]*>새 견적서 저장<\/button>[\s\S]*id="estimateNoticeButton"[^>]*>카톡 공유<\/button>[\s\S]*id="estimateExcelButton"[^>]*>보고서<\/button>/);
assert.match(html, /id="linkedEstimateList"/);
assert.match(html, /id="catalogPickerList"/);
assert.match(html, /id="voucherContextView"[\s\S]*id="voucherContextList"/, 'voucher modes must use the right rail for date-scoped activity');
assert.match(html, /<th class="sequence-column sequence-select-column"[^>]*>[\s\S]*class="sequence-checkbox sequence-checkbox--all"[\s\S]*id="selectAllRows"[\s\S]*<span>No\.<\/span>/, 'select-all must render No. inside the checkbox control');
assert.doesNotMatch(html, /class="col-select"|class="select-column"/, 'the standalone selection column must stay removed');
assert.doesNotMatch(html, /data-column="productSearch"|class="col-product-search"|>상품 검색<\/th>/,
  'the worktable must not restore a standalone product-search column');
assert.match(html, /class="product-code-search-heading" data-column="itemCode"[^>]*>코드<\/th>/,
  'itemCode must be the visible product-search entry heading');
assert.match(appSource, /data-column="itemCode" class="product-code-search-cell product-search-cell"[\s\S]*data-field="itemCode"[\s\S]*placeholder="코드·품명·검색어"/,
  'itemCode cells must expose code, name, and keyword product search');
assert.doesNotMatch(appSource, /data-column="productSearch"|\|productSearch|field: 'productSearch'/,
  'grid focus and navigation must no longer target the removed productSearch field');
assert.doesNotMatch(appSource, /\bisLinkedRow\s*\(/,
  'product selection and linked-row edits must use the existing canonical linked-source helper');
assert.match(appSource, /rowHasLinkedSource\(liveRow\)[\s\S]*rowHasLinkedSource\(liveRow\)/,
  'product candidate selection must preserve linked-row sync and save behavior');
assert.match(appSource, /class="sequence-checkbox"[\s\S]*data-select-row=[\s\S]*class="row-sequence-number">\$\{sequence\}/, 'each row number must render inside its checkbox control');
assert.match(read('smartinput/smartinput.css'), /\.sequence-checkbox > span \{ width: 29px; height: 29px;/, 'numbered row-selection controls must remain touch sized');
assert.match(read('smartinput/smartinput.css'), /#voucherInputTable tbody tr\.is-grid-active[\s\S]*outline: 2px solid var\(--focus\)/, 'the active SmartInput row must keep a visible border');
assert.match(appSource, /tr\.classList\.toggle\('is-row-selected',[\s\S]*tr\.classList\.toggle\('is-grid-active'/, 'selection and active-row borders must be synchronized after rerenders');
assert.match(appSource, /estimateKind === 'LINKED_GROUP'/);
assert.doesNotMatch(appSource, /flushLinkedRowsToSources|flushLinkedIndividualToLibrary|queueLinkedRowsWriteThrough/,
  'autosave must never write through to linked estimate originals');
assert.match(appSource, /commitEstimateBundle\(\{ upserts: bundle, deletes: deletedEstimateIds, expectedPreimages \}\)/, 'explicit Save must atomically persist linked updates and empty-source deletions with optimistic pre-images');
assert.match(appSource, /linkedFieldConflicts[\s\S]*linked-value-conflict/, 'different linked source values must be identified before explicit source selection');
assert.match(appSource, /showLinkedEstimateSourceEditDialog\(evidence\)/, 'linked edits must pass through the operator source-selection dialog');
assert.match(linkedSourceEditSource, /LINKED_ESTIMATE_SOURCE_SELECTION_REQUIRED/, 'multiple linked sources must fail closed without an explicit selection');
assert.match(linkedSourceEditSource, /LINKED_ESTIMATE_NEW_ROW_SOURCE_REQUIRED/, 'new linked rows must fail closed without an explicit target estimate');
assert.match(linkedSourceEditSource, /operation === 'DELETE'[\s\S]*targets: row\.sources\.map/, 'linked row deletion must retain every source row as an explicit deletion target');
assert.match(linkedSourceEditSource, /deletedSourceIds[\s\S]*deletes: \[\.\.\.deletedSourceIds\]/, 'source estimates with zero remaining products must join the atomic delete bundle');
assert.match(appSource, /nameCollision[\s\S]*기존 저장분을 덮어쓸까요/, 'exact estimate-name collisions must require overwrite confirmation');
assert.match(appSource, /touchstart', beginEstimateTouchDrag/, 'estimate card handles must support touch reordering as well as desktop drag');
assert.match(appSource, /data-select-estimate-card[\s\S]*data-estimate-drag-handle/, 'estimate cards must separate body selection from handle-only reordering');
assert.doesNotMatch(appSource + html, /data-estimate-select|estimate-card__check/, 'estimate cards must not use checkboxes');
assert.match(html, /id="selectedEstimateDeleteButton"[\s\S]*id="estimateRenameButton"[^>]*>정보 변경</, 'the estimate library must expose only selected deletion and information actions');
assert.match(html, /id="saveEstimateAsButton"[^>]*>새 견적서 저장</, 'a loaded estimate must use Save As instead of in-place rename');
assert.match(appSource, /function openSelectedEstimateInformationDialog\([\s\S]*data-estimate-customer-match[\s\S]*commitEstimateBundle\(\{ upserts: bundle \}\)/,
  'single-record information changes must support customer rematching while preserving linked display metadata');
assert.match(appSource, /target\.customerId[\s\S]*target\.customerCode[\s\S]*target\.customerName[\s\S]*target\.draft\.header = estimateHeaderWithCustomer/,
  'estimate information changes must persist the same customer identity on the record and draft header');
assert.doesNotMatch(appSource, /state\.draft\.modes\.estimate = nextCurrent;[\s\S]{0,600}clearCustomerAfterSave\(nextCurrent\.header\)/,
  'saving the selected estimate must not clear its rematched customer before a later in-place save');
assert.match(appSource, /mapping\.targetEstimateId[\s\S]*TARGET_CUSTOMER_CHANGED/,
  'changing an estimate customer must retire stale per-customer target mappings');
assert.doesNotMatch(html + appSource, /merchOpsEstimateButton|openEstimateCreateChoiceDialog/,
  'MerchOps and redundant estimate-kind choice controls must stay removed');
assert.match(appSource, /state\.noticeEstimateIds = \[record\.estimateId\];[\s\S]*loadCatalogRecord\(record, \{ preserveSelection: true \}\)/,
  'normal card selection must immediately switch to exactly one stored estimate');
assert.match(appSource, /function estimateCreation\([\s\S]*COMPOSITION_PREVIEW/, 'multi-selection must be isolated in an explicit creation workflow');
assert.match(html, /id="estimateMultiSelectButton"[^>]*aria-label="견적서 다중 선택"[^>]*>[\s\S]*\+/, 'the explicit multi-select entry must be icon-only and accessible');
assert.match(appSource, /const additive = event\.ctrlKey \|\| event\.metaKey;[\s\S]*beginEstimateMultiSelect\(\{ deferPreview: true \}\)/,
  'Ctrl or Command click must enter the same additive multi-selection workflow');
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
assert.match(appSource, /renderMode\(\);[\s\S]*?(?:void\s+)?hydrateReferences\(\)/, 'local shell must render before optional references');
assert.match(appSource, /void hydrateEstimateLibrary\(\);[\s\S]*void hydrateReferences\(\)/, 'the estimate library fast path must start independently from optional reference hydration');
assert.match(appSource, /loadSmartInputData\(\{ includeEstimates: false \}\)/, 'optional settings and reference hydration must not gate the estimate library');
assert.match(appSource, /세무거래처는 선택사항입니다/, 'customer relationship save must describe tax customer assignment as optional');
assert.doesNotMatch(appSource, /if \(!selectedTaxCustomerId\)\s*\{[\s\S]{0,160}세무거래처를 정확히 1곳 지정하세요/, 'customer relationship save must not require a tax customer');
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

assert.match(storeSource, /SMARTINPUT_DB_NAME = 'oneapp-smartinput'/);
assert.match(storeSource, /SMARTINPUT_DB_VERSION = 5/);
for (const store of ['settings', 'customerLinkGroups', 'temporaryCustomers', 'customerAliasMappings', 'estimates', 'sourceImages', 'autosave']) {
  assert.match(storeSource, new RegExp(`['"]${store}['"]`));
}
assert.match(storeSource, /saveLatestAutosave[\s\S]*key: 'current'/);
assert.match(storeSource, /loadLatestAutosave[\s\S]*get\(DATA_STORES\.AUTOSAVE, 'current'\)/);
assert.match(storeSource, /export async function loadEstimateLibrary\(\)/, 'the estimate list must have an isolated local-data fast path');
assert.match(storeSource, /request\.onblocked[\s\S]*SMARTINPUT_DB_UPGRADE_BLOCKED/, 'blocked IndexedDB upgrades must fail with an actionable reason instead of hanging');
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
const legacySearchLayout = contract.normalizeSettings({
  columnWidths: { productSearch: 244, itemCode: 176 },
  columnWidthsByMode: { order: { productSearch: 232, itemCode: 188 } },
  inputOrderByMode: { order: { productSearch: 1, itemCode: 2 } }
});
assert.equal('productSearch' in legacySearchLayout.columnWidths, false, 'legacy productSearch width must not restore the removed column');
assert.equal('productSearch' in legacySearchLayout.columnWidthsByMode.order, false, 'per-mode productSearch width must be discarded');
assert.equal('productSearch' in legacySearchLayout.inputOrderByMode.order, false, 'productSearch must leave the grid input order');
assert.equal(legacySearchLayout.columnWidths.itemCode, 176, 'existing itemCode width must survive layout normalization');
assert.equal(legacySearchLayout.inputOrderByMode.order.itemCode, 2, 'existing itemCode input order must survive layout normalization');
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
assert.equal((await adapter.loadPurchaseStage3Capability()).ready, true, 'local official purchase contract must be available');
assert.equal((await adapter.loadSaleStage4Capability()).ready, true, 'local official sale contract must be available');
await assert.rejects(adapter.createLiveCustomer({}), error => error.code === 'CUSTOMER_CREATE_UNAVAILABLE');

const smartInput = manifest.applications.find(app => app.id === 'smart-input');
assert.equal(smartInput.path, 'smartinput/index.html');
assert.equal(smartInput.status, 'pilot');
assert.equal(smartInput.owner, 'voucher-input');
const localWork = manifest.sharedDataContracts.find(contract => contract.id === 'smartinput-local-work');
assert.equal(localWork.databaseVersion, 5);
assert.ok(localWork.resources.indexedDbStores.includes('autosave'));
assert.ok(localWork.resources.indexedDbStores.includes('fieldDefinitionsV2'));
const voucherActivity = manifest.sharedDataContracts.find(contract => contract.id === 'voucher-activity-snapshot');
assert.equal(voucherActivity.owner, 'orderq-vnext');
assert.ok(voucherActivity.consumers.includes('smart-input'));
assert.match(voucherActivity.writerPolicy, /read-only/i);
assert.equal(voucherActivity.resources.queryEntry, 'orderq/voucher-query.html');

console.log('SmartInput 0a rollback and independent compatibility contracts PASS');
