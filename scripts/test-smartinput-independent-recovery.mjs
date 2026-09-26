#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('smartinput/index.html');
const appSource = read('smartinput/smartinput.js').replace(/\r\n/g, '\n');
const adapterSource = read('smartinput/legacy-integration-adapter.js');
const inputSource = read('smartinput/input.js');
const optionalLoaderSource = read('smartinput/optional-operation-loader.js');
const extractorSource = read('orderq/smartparser/order-text-extractor.js');
const storeSource = read('smartinput/smartinput-data-store.js');
const linkedSourceEditSource = read('smartinput/linked-estimate-source-edit.js');
const voucherActivitySource = read('orderq/voucher-activity-read-adapter.js');
const voucherQueryHtml = read('orderq/voucher-query.html');
const manifest = JSON.parse(read('app-manifest.json'));

assert.match(html, /nexus-ui-theme-init\.js\?v=\d+\.\d+\.\d+/);
assert.match(html, /nexus-ui\.css\?v=\d+\.\d+\.\d+/);
assert.match(html, /nexus-ui-app-themes\.css\?v=\d+\.\d+\.\d+/);
assert.match(html, /smartinput\.css\?v=\d+\.\d+\.\d+/);
assert.match(html, /smartinput-contract\.js\?v=\d+\.\d+\.\d+/);
assert.match(html, /smartinput\.js\?v=\d+\.\d+\.\d+/);
assert.match(html, /data-nexus-app-id="smart-input"/);
assert.match(html, /nexus-ui\.js\?v=\d+\.\d+\.\d+/);
assert.doesNotMatch(html, /nexus-theme-init\.js|apps-config\.js|nexus-top\.js|customer-master\.css|<nexus-top/i);
assert.doesNotMatch(html, /<kbd|Alt\+[1234]|cdn\.jsdelivr\.net/i);
assert.doesNotMatch(appSource, /\.altKey|Alt\+[1234]/i);
assert.doesNotMatch(html, /id="(?:draftListButton|saveDraftButton|catalogSaveButton)"/);
assert.doesNotMatch(html, /id="uploadTemplateButton"|>업로드 양식<\/button>/);
assert.doesNotMatch(appSource, /downloadMinimumUploadTemplate|uploadTemplateButton/);
assert.doesNotMatch(appSource, /DRAFT_LIST_STORAGE_KEY|openDraftListDialog|saveModeDraftSnapshot/);
assert.match(html, /id="restoreAutosaveButton"[^>]*>자동저장 복구<\/button>/);
assert.match(html, /<footer class="voucher-footer-actions"[\s\S]*id="completeButton"[^>]*>저장<\/button>/);
assert.match(html, /<footer class="voucher-footer-actions"[\s\S]*id="saveEstimateAsButton"[^>]*>새 견적서 저장<\/button>[\s\S]*id="estimateNoticeButton"[^>]*>카톡 공유<\/button>[\s\S]*id="estimateExcelButton"[^>]*>보고서<\/button>/);
assert.doesNotMatch(html, /id="linkedEstimateList"/);
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
assert.match(appSource, /estimateWorkspace.edit/, 'general save must use target-only CAS');
assert.match(appSource, /collision && !window.confirm/, 'name collisions need explicit overwrite confirmation');
assert.match(appSource, /touchstart', beginEstimateTouchDrag/, 'estimate card handles must support touch reordering as well as desktop drag');
assert.match(appSource, /data-select-estimate-card[\s\S]*data-estimate-drag-handle/, 'estimate cards must separate body selection from handle-only reordering');
assert.doesNotMatch(appSource + html, /data-estimate-select|estimate-card__check/, 'estimate cards must not use checkboxes');
assert.match(html, /id="selectedEstimateDeleteButton"[\s\S]*id="estimateRenameButton"[^>]*>정보 변경</, 'the estimate library must expose only selected deletion and information actions');
assert.match(html, /id="saveEstimateAsButton"[^>]*>새 견적서 저장</, 'a loaded estimate must use Save As instead of in-place rename');
assert.match(appSource, /function openSelectedEstimateInformationDialog[\s\S]*commitIndependentEstimateEdit/, 'information changes use target-only CAS');
assert.match(appSource, /function updatedEstimateInformationBundle[\s\S]*customerId:[\s\S]*customerCode:[\s\S]*customerName:[\s\S]*next\[target\] = value; next\.draft\.header\[target\] = value/,
  'estimate information changes must persist the same customer identity on the record and draft header');
assert.doesNotMatch(appSource, /state\.draft\.modes\.estimate = nextCurrent;[\s\S]{0,600}clearCustomerAfterSave\(nextCurrent\.header\)/,
  'saving the selected estimate must not clear its rematched customer before a later in-place save');
assert.match(appSource, /mapping\.targetEstimateId[\s\S]*TARGET_CUSTOMER_CHANGED/,
  'changing an estimate customer must retire stale per-customer target mappings');
assert.doesNotMatch(html + appSource, /merchOpsEstimateButton|openEstimateCreateChoiceDialog/,
  'MerchOps and redundant estimate-kind choice controls must stay removed');
assert.match(appSource, /function handleEstimateCardSelection[\s\S]*selected\.delete[\s\S]*selected\.add[\s\S]*changeEstimateSelection/, 'card clicks toggle update targets');
assert.match(appSource, /function estimateCreation\(\) \{\s*return null;/, 'retired linked creation must be unreachable');
assert.match(html, /id="estimateMultiSelectButton"[^>]*>전체 선택<\/button>/, 'select all must be explicit');
assert.doesNotMatch(appSource, /toast\(`\$\{records\.length\}개 견적서 · 중복 제거/, 'estimate selection must not create a redundant coachmark over the action area');
assert.match(appSource, /data-estimate-name[^>]*placeholder="견적서명을 입력하세요"[^>]*autofocus/, 'estimate naming must be immediately ready for direct keyboard input');
assert.match(appSource, /dialog\.showModal\(\);[\s\S]*focusNameInput\(\);[\s\S]*setTimeout\(focusNameInput, 0\)/, 'estimate naming focus must be immediate and restored after native modal focus handling');
assert.doesNotMatch(appSource, /if \(current\.estimateKind !== 'LINKED_GROUP'\) current\.catalogRecordId = ''/, 'saving an individual estimate must retain its identity for subsequent in-place updates');
assert.match(appSource, /specifier: '\.\.\/orderq\/voucher-activity-read-adapter\.js/, 'explicit voucher lookup must use the owner-issued read-only adapter');
assert.doesNotMatch(appSource, /from\s+['"]\.\.\/orderq\//,
  'SmartInput core must not statically import the optional ORDER Q integration');
assert.match(voucherActivitySource, /ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER_V1/);
assert.match(voucherActivitySource, /ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT_V1/);
for (const status of ['READY', 'EMPTY', 'ERROR']) assert.match(voucherActivitySource, new RegExp(`['"]${status}['"]`));
assert.doesNotMatch(voucherActivitySource, /\breadwrite\b|(?:objectStore\s*\([^)]*\)|\b\w*[Ss]tore)\s*\.\s*(?:put|add|delete|clear)\s*\(/,
  'the owner-issued voucher activity adapter must stay read-only');
assert.doesNotMatch(voucherActivitySource, /openOrderQDb/, 'the activity reader must not create or upgrade the owner database');
assert.match(voucherActivitySource, /lineStore\.index\(config\.lineIndex\)\.getAll\(id\)/,
  'activity lines must be queried by the selected document ids instead of scanning the full line store');
assert.match(voucherActivitySource, /dateField: 'orderDate'[\s\S]*dateField: 'purchaseDate'[\s\S]*dateField: 'salesDate'/,
  'date-scoped activity must use each official voucher date field');
assert.match(voucherQueryHtml, /data-nexus-app-id="orderq-vnext"/);
assert.match(adapterSource, /import\(path\)/, 'external app modules must stay behind a dynamic boundary');
assert.match(appSource, /optional-operation-loader\.js\?v=0\.1\.0/, 'optional browser assets must use the retryable loader boundary');
assert.match(adapterSource, /optional-operation-loader\.js\?v=0\.1\.0/, 'optional local modules must use the same loader contract');
assert.match(optionalLoaderSource, /clearOwnFailedAttempt[\s\S]*assetCache\.get\(key\) === entry/, 'only the failed attempt may clear its loader cache entry');
assert.match(optionalLoaderSource, /RESULT_UNKNOWN[\s\S]*같은 명령 ID의 결과를 먼저 조회/, 'unknown writes must keep the original command identity and require result lookup');
assert.match(appSource, /async function reloadInputTemplates[\s\S]*withTimeout\([\s\S]*loadInputTemplates\(companyId, modeId\)[\s\S]*OPTIONAL_OPERATION_TIMEOUT_MS\.localModule/, 'manual template reload must leave LOADING through a bounded failure path');
assert.match(appSource, /smartDataToken\.inputGeneration === state\.optionalInputGeneration[\s\S]*loadedSourceImageRecords\.forEach[\s\S]*!state\.sourceImageRecords\.has\(documentId\)/, 'late boot hydration must merge without replacing a newer source image');
const changedGenerationSourceImageBranch = appSource.match(
  /if \(smartDataToken\.inputGeneration === state\.optionalInputGeneration\) \{[\s\S]*?\} else \{([\s\S]*?)\n    \}\n    if \(optionalOperationIsLatest\(referenceToken\)\)/
)?.[1] || '';
assert.match(changedGenerationSourceImageBranch, /loadedSourceImageRecords\.forEach/, 'late boot hydration must retain persisted image records for later mode restoration');
assert.match(changedGenerationSourceImageBranch, /clearedSourceImageDocumentIds\.has\(documentId\)[\s\S]*restoreSourceImageForMode/, 'late boot hydration must distinguish ordinary edits from an explicitly cleared source image');
assert.match(appSource, /function clearParserWorkspace[\s\S]*clearedSourceImageDocumentIds\.add\(clearedSourceImageDocumentId\)[\s\S]*setPendingSourceImageDelete\(clearedSourceImageDocumentId, true\)[\s\S]*queueSourceImageDelete\(clearedSourceImageDocumentId\)/, 'parser clear must durably tombstone and remove the persisted source image');
assert.match(appSource, /async function flushSmartInputBeforeWorkspaceLeave[\s\S]*state\.sourceImageWriteQueues\.size[\s\S]*Promise\.all\(pendingImages\)/, 'workspace leave must wait for pending source-image deletes and saves');
assert.match(appSource, /async function flushSmartInputBeforeWorkspaceLeave[\s\S]*document\.activeElement\?\.blur\?\.\(\)[\s\S]*if \(!state\.draftDirty\) return \{ result: 'READY' \}/, 'workspace leave must commit active input and skip duplicate SmartInput snapshots when unchanged');
assert.match(appSource, /function resumePendingSourceImageDeletes[\s\S]*queueSourceImageDelete\(documentId\)/, 'a reload must resume an unfinished source-image deletion');
assert.match(appSource, /mergeHydratedSnapshotPreservingLiveChanges[\s\S]*state\.settings = contract\.normalizeSettings\(mergeHydratedSnapshotPreservingLiveChanges\(/, 'late boot settings must merge without replacing live column and preference edits');
assert.match(appSource, /createHydrationWriteGate[\s\S]*persistCurrentSettingsAfterHydration[\s\S]*settingsWriteGate\.persist/, 'full settings writes must wait for the initial persisted snapshot');
assert.match(appSource, /async function retrySmartAuxiliaryData[\s\S]*settingsWriteGate\.beginRetry\(\)[\s\S]*loadSmartInputData\(\{[^}]*includeEstimates:\s*false[^}]*\}\)[\s\S]*settingsWriteGate\.settleReady\(\)/, 'a failed auxiliary-data hydration must be retryable in the same screen');
assert.doesNotMatch(appSource, /await saveSettings\(|\.then\(\(\) => saveSettings\(/, 'SmartInput must not write a full settings snapshot outside the hydration write gate');
assert.match(appSource, /async function rematchRowsForCustomer[\s\S]*rowsAtStart = JSON\.stringify\(current\.rows\)[\s\S]*JSON\.stringify\(current\.rows\) !== rowsAtStart[\s\S]*current\.rows = matched/, 'late customer rematch results must be rejected before replacing edited rows');
assert.match(appSource, /activeCustomerRematchAttemptId[\s\S]*completeButton[^\n]*disabled[\s\S]*async function completeOrder\(\)[\s\S]*state\.activeCustomerRematchAttemptId/, 'official save must remain blocked until customer rematching settles');
assert.match(appSource, /function scheduleMappingProjection[\s\S]*invalidateOptionalOperations\(\);[\s\S]*scheduleSave\(\{ invalidateOperations: false \}\)/, 'mapping edits must invalidate older operations at edit time rather than after the debounce');
assert.match(appSource, /function invalidateEstimateLibraryRead[\s\S]*ESTIMATE_LIBRARY_READ[\s\S]*commitIndependentEstimateEdit[\s\S]*invalidateEstimateLibraryRead\(\);[\s\S]*state\.estimates =/, 'a late estimate-library read must not replace a successfully committed in-memory library');
assert.match(appSource, /async function recoverEstimateF8Integrity[\s\S]*보고서 출력은 저장 자료를 변경하지 않습니다/, 'F8 must keep report output from rewriting stored estimates');
assert.doesNotMatch(appSource + html, /전환 확인|기존 자료 전환|estimateMigrationButton/, 'estimate conversion must stay an internal save compatibility path');
assert.match(appSource, /async function completeOrder\(\)[\s\S]*estimateErpSummary\?\.recognized === true[\s\S]*runAutomaticEstimateBulkUpdates[\s\S]*if \(estimateExcelFile\(\)\) return runSelectedEstimateUpdate\(\)/,
  'ERP 견적서현황은 선택 견적 Excel 업데이트보다 먼저 거래처별 bulk로 가야 한다');
assert.match(appSource, /function createCatalogOnlyDraft[\s\S]*const editedFields = row\.editedFields[\s\S]*editedFields/,
  'catalog-only 저장은 bulk가 표시한 editedFields를 비우면 안 된다');
assert.match(appSource, /erpSummary \? '견적서 업데이트'/, 'ERP 통합현황의 기본 저장 버튼은 견적서 업데이트여야 한다');
assert.match(appSource, /erpSummary\?\.recognized[\s\S]*ERP 견적서현황/, 'ERP 통합현황은 견적서 미리 선택 없이 작업 대상을 표시해야 한다');
const erpBulkFn = appSource.slice(appSource.indexOf('async function runAutomaticEstimateBulkUpdates'), appSource.indexOf('function openEstimateSaveDialog'));
assert.doesNotMatch(erpBulkFn, /applyMaster|deliverCurrentOfficial/,
  'ERP 통합현황 견적 갱신은 상품 Master나 공식 전표를 쓰지 않아야 한다');
assert.match(appSource, /activeFileInputAttemptId[\s\S]*async function handleFile[\s\S]*state\.activeFileInputAttemptId = operationToken\.attemptId[\s\S]*async function completeOrder\(\)[\s\S]*state\.activeFileInputAttemptId/, 'save must not overlap a pending file read even when another activity changes the visible activity label');
assert.match(appSource, /function openEstimateSaveDialog[\s\S]*state\.activeFileInputAttemptId/, 'Save As must not bypass the pending-file write boundary');
assert.match(appSource, /async function waitForSmartInputIdle[\s\S]*state\.activeFileInputAttemptId/, 'workspace leave must wait for a pending file read');
assert.match(appSource, /async function refreshAllReferencesFromToolbar[\s\S]*withTimeout\([\s\S]*refreshAllReferenceData[\s\S]*withTimeout\([\s\S]*loadVoucherFieldRegistry/, 'manual full reference refresh must have bounded reference and registry waits');
assert.match(appSource, /async function rematchRowsForCustomer[\s\S]*withTimeout\([\s\S]*rematchExtractedLinesForCustomer/, 'customer rematching must leave its save block through a bounded failure path');
assert.match(appSource, /async function ensureOfficialCapability[\s\S]*loadPurchaseStage3Capability[\s\S]*loadSaleStage4Capability[\s\S]*async function completeSaleOfficial[\s\S]*ensureOfficialCapability\('sale'\)[\s\S]*async function completePurchaseOfficial[\s\S]*ensureOfficialCapability\('purchase'\)/, 'official save must retry a transient capability failure in the same screen');
assert.match(appSource, /const discardStaleResult[\s\S]*invalidateShoppingOrderInspection\(\)/, 'a stale shopping inspection must return to local input instead of querying the ledger automatically');
for (const mutationContract of [
  /function applyMappingGridPaste[\s\S]*invalidateOptionalOperations\(\);[\s\S]*captureGridPasteUndo\(\)/,
  /function activatePendingReferences[\s\S]*window\.confirm[\s\S]*invalidateOptionalOperations\(\);[\s\S]*domains\.forEach/,
  /const finish = product => \{[\s\S]*if \(product\) \{\s*invalidateOptionalOperations\(\);/
]) {
  assert.match(appSource, mutationContract, 'user row mutations must invalidate an older customer rematch before it can replace current rows');
}
assert.match(read('smartinput/estimate-workspace.js'), /rebaseIndependentEstimateWork/, 'selected commits preserve per-estimate working edits');
assert.doesNotMatch(inputSource, /from ['"]\.\.\/orderq\//,
  'independent input must own the preserved pure parser without loading another app engine');
assert.doesNotMatch(adapterSource, /function captureTextIntake|function analyzeSingleOrderDocument|function extractOrderProductLines/,
  'input implementations must actually leave the optional integration adapter');
for (const dependency of ['source-parser', 'order-event-detector', 'order-line-parser']) {
  assert.match(extractorSource, new RegExp(`from ['"]\\./${dependency}\\.js\\?v=0\\.8\\.1['"]`));
}
assert.match(appSource, /cdn\.jsdelivr\.net\/npm\/xlsx-js-style/);
assert.match(appSource, /cdn\.jsdelivr\.net\/npm\/tesseract\.js/);
assert.match(appSource, /renderMode\(\);[\s\S]*?(?:void\s+)?hydrateReferences\(\)/, 'local shell must render before optional references');
assert.match(appSource, /void hydrateEstimateLibrary\(\);[\s\S]*void hydrateReferences\(\)/, 'the estimate library fast path must start independently from optional reference hydration');
assert.match(appSource, /loadSmartInputData\(\{\s*includeEstimates:\s*false,\s*includeSourceImages:\s*false\s*\}\)/, 'optional settings, references, and source images must not gate the estimate library');
assert.match(appSource, /세무거래처는 선택사항입니다/, 'customer relationship save must describe tax customer assignment as optional');
assert.doesNotMatch(appSource, /if \(!selectedTaxCustomerId\)\s*\{[\s\S]{0,160}세무거래처를 정확히 1곳 지정하세요/, 'customer relationship save must not require a tax customer');
assert.doesNotMatch(appSource, /65000|최초 연결은 최대 1분/);

for (const marker of ['parser-card', 'photoResizer', 'workbench', 'related-panel', 'tableScroll', 'estimateLibraryView', 'catalogPickerList']) {
  assert.match(html, new RegExp(marker), `${marker} must remain in the protected SmartInput workspace`);
}
assert.match(html, /id="workbenchHeading"[\s\S]*id="customerInput"/, 'customer entry must live above the work table');
assert.doesNotMatch(html.slice(html.indexOf('<header class="app-bar"'), html.indexOf('</header>', html.indexOf('<header class="app-bar"'))), /id="customerInput"/, 'customer entry must not remain in the app header');
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

const adapter = { ...await import('../smartinput/legacy-integration-adapter.js'), ...await import('../smartinput/input.js') };
const legacyExtractor = await import('../orderq/smartparser/order-text-extractor.js?v=0.8.1');
for (const sourceType of ['GENERAL_TEXT', 'KAKAO_TEXT']) {
  const fixture = { sourceType, sourceId: 'PARITY', rawText: '[테스트] [오후 1:00] 사과 좋은 거 2박스\n2번 감자 3개\n[테스트] [오후 1:01] 주문 취소\n[테스트] [오후 1:02] 단가 3000원' };
  assert.deepEqual(adapter.extractOrderProductLines(fixture), legacyExtractor.extractOrderProductLines(fixture),
    'the independent parser must preserve canonical rows and source keys');
}
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
