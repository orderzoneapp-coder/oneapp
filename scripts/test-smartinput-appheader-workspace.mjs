#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('smartinput/index.html', 'utf8');
const css = await readFile('smartinput/smartinput.css', 'utf8');

assert.match(html, /<header class="app-bar">/, '0a SmartInput app bar must be restored');
assert.match(html, /<div class="workspace" id="smartInputWorkspace">/, 'the protected desktop workspace must remain');
assert.match(html, /class="header-customer-group"[\s\S]*id="customerInput"/, 'customer entry must be raised into the app header');
assert.match(html, /class="parser-card"[^>]*id="sourceInputPanel"/, 'the independent source parser must remain');
assert.doesNotMatch(html, /id="sourcePanelToggleButton"/, 'the source parser must not be hidden by a work-table toggle');
assert.match(html, /class="workbench"/, 'the work table must remain');
assert.match(html, /class="related-panel estimate-library-view"[^>]*id="estimateLibraryView"/, 'the right estimate library must remain a workspace sibling');
assert.match(html, /id="estimateLibraryView"[\s\S]*id="catalogPickerList"[\s\S]*id="linkedEstimateList"/, 'individual and linked estimate lists must remain available');
assert.match(html, /id="voucherContextView"[\s\S]*id="voucherContextList"[\s\S]*id="voucherReadyState"/, 'non-estimate voucher modes must expose a date-scoped right-side activity panel');
assert.match(html, /id="voucherContextList"[\s\S]*id="estimateLibraryHeading"/, 'the dynamic voucher context and estimate library must share the protected right workspace without replacing either contract');
assert.doesNotMatch(html, /estimateLibraryButton|estimateEditorButton|견적서 목록 전체보기|편집기로 돌아가기/, 'the redundant full-library replacement path must be removed');
assert.match(html, /id="estimateLibraryIndividualButton"[^>]*>견적서 목록<\/button>[\s\S]*id="estimateLibraryLinkedButton"[^>]*>연동견적서<\/button>[\s\S]*id="estimateMultiSelectButton"[^>]*>[\s\S]*\+/, 'individual and linked estimate lists must use separate buttons beside one icon-only multi-select action');
assert.match(html, /id="estimateSelectionSummary"[\s\S]*id="selectedEstimateDeleteButton"[^>]*>선택 삭제<\/button>[\s\S]*id="estimateRenameButton"[^>]*>이름 변경<\/button>/, 'the estimate library footer must expose only deletion and rename');
assert.doesNotMatch(html, /merchOpsEstimateButton|estimateCreationCancelButton|estimateCreationSaveButton/, 'redundant estimate rail actions must stay removed');
assert.doesNotMatch(html, /newEstimateButton|viewSelectedEstimatesButton|linkedEstimateGroupButton/, 'redundant estimate creation and preview controls must stay removed');
assert.match(html, /id="gridSearchInput"[\s\S]*id="gridRowCount"[\s\S]*id="deleteSelectedRows"[\s\S]*id="resetDraftButton"/, 'search, review counts, and row actions must share one toolbar row');
assert.doesNotMatch(html, /class="grid-toolbar"|class="grid-review-tools"/, 'the former second status row must be removed');
assert.match(html, /id="inputRows"/, 'the restored editable grid body must remain');
assert.equal((html.match(/data-mode="(?:order|purchase|sale|estimate)"/g) || []).length, 4,
  'all four voucher modes must remain');
assert.doesNotMatch(html, /<kbd|Alt\+[1234]/i, 'Alt+1~4 affordances must stay excluded');

assert.match(css, /\.workspace\.related-panel-open[\s\S]*grid-template-columns:[^;]*8px minmax\(0, 1fr\) var\(--related-pane-width\)/,
  'desktop must preserve parser, resizer, work table, and adjustable right-panel columns');
assert.match(css, /\.grid-card > \.work-action-bar\s*\{[\s\S]*border-bottom:\s*1px solid var\(--border\)/,
  'search and edit controls must be integrated with the grid card');
assert.doesNotMatch(css, /is-estimate-library-open/, 'the estimate library must never replace the parser and table workspace');
assert.match(css, /\.voucher-context-item\s*\{[\s\S]*grid-template-columns:/,
  'the dynamic voucher inspection items must retain a compact actionable layout');
assert.match(css, /@media \(min-width:\s*821px\) and \(max-width:\s*1480px\)[\s\S]*grid-template-columns:[^;]*8px minmax\(0, 1fr\)/,
  'intermediate desktop widths must preserve side-by-side parser and table columns');
assert.match(css, /\.header-field\.is-layout-placeholder\s*\{[^}]*visibility:\s*hidden/,
  'estimate mode must preserve the transaction field slot without exposing an irrelevant control');
assert.match(css, /\.grid-card > \.work-action-bar \.document-fields__right\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s,
  'all voucher modes must keep search, counts, and editing controls on one stable toolbar row');
assert.match(css, /\.estimate-card__drag-handle\s*\{[^}]*touch-action:\s*none/s,
  'card ordering must be isolated to a dedicated drag handle');
assert.match(css, /\.related-panel \.estimate-library-actions\s*\{[^}]*max-height:\s*44px[^}]*grid-template-columns:\s*repeat\(2,/s,
  'the right-panel footer must stay at or below 44px with two horizontal actions');
assert.match(html, /id="completeButton"[^>]*>저장<\/button>[\s\S]*id="estimateCreateButton"[^>]*>연동견적서 생성<\/button>[\s\S]*id="saveEstimateAsButton"[^>]*>새 견적서 저장<\/button>[\s\S]*id="estimateNoticeButton"[^>]*>카톡 공유<\/button>[\s\S]*id="estimateExcelButton"[^>]*>EXCEL<\/button>/,
  'the table footer must keep Save left and approved estimate/output actions right in order');
assert.match(css, /\.product-picker-dialog[\s\S]*\.product-picker-results[\s\S]*\.product-picker-result\.is-selected[^}]*var\(--focus\)/,
  'the product candidate dialog must use the shared modal surface and a non-green keyboard selection marker');
assert.doesNotMatch(html + css, /reference-overview__coachmark/, 'reference status must not use a coachmark surface');
assert.match(css, /\.toast\s*\{[^}]*bottom:\s*74px/s, 'desktop notifications must clear the lower action bar');
assert.match(css, /@media \(max-width:\s*820px\)[\s\S]*\.toast\s*\{[^}]*bottom:\s*72px/s, 'mobile notifications must clear the lower action bar');
assert.match(html, /id="relatedPanelToggle"[\s\S]*id="relatedPanelResizer"[\s\S]*id="relatedPanelCloseButton"/,
  'the right activity panel must expose slide toggle, resize handle, and close control');
assert.match(html, /id="relatedPanelCloseButton"[^>]*aria-label="우측 패널 닫기"[^>]*>[\s\S]*×/,
  'the right-panel close control must use a centered edge X with an accessible name');
assert.doesNotMatch(html, /id="relatedPanelCloseButton"[^>]*>[\s\S]*<strong>닫기<\/strong>/,
  'the former top visible close label must be removed');
assert.match(css, /\.related-panel-resizer span\s*\{[^}]*height:\s*52px[^}]*background:\s*var\(--border-strong\)/s,
  'the right-panel resize handle must remain visible like the parser resize handle');
assert.match(css, /\.related-panel-chrome\s*\{[^}]*top:\s*50%[^}]*opacity:\s*0/s,
  'the panel X must default to a hidden vertical-center edge control');
assert.match(css, /\.related-panel:has\(\.related-panel-resizer:hover\) \.related-panel-close[\s\S]*\.related-panel:has\(\.related-panel-close:hover\) \.related-panel-resizer span/,
  'hovering either the resize handle or X must highlight the paired control');
assert.match(css, /@media \(max-width:\s*820px\)[\s\S]*\.related-panel-resizer\s*\{\s*display:\s*none/,
  'mobile must keep slide open-close without desktop width resizing');
assert.match(css, /@media \(hover:\s*none\)[\s\S]*\.related-panel-chrome\s*\{[^}]*opacity:\s*1/s,
  'touch devices must keep the close X available without hover');
assert.match(css, /@media \(min-width:\s*821px\) and \(max-width:\s*1480px\)[\s\S]*inset:\s*var\(--related-panel-top,[^;]+[\s\S]*\.related-collapse\s*\{\s*display:\s*none/s,
  'intermediate desktop drawers must begin below the app header without a duplicate lower close control');
assert.match(await readFile('smartinput/smartinput.js', 'utf8'), /ResizeObserver[\s\S]*appBarResizeObserver\.observe\(document\.querySelector\('\.app-bar'\)\)[\s\S]*appBarResizeObserver\.observe\(globalHeader\)/,
  'the right drawer must follow responsive global and app-header height changes');

console.log('SmartInput protected desktop workspace contracts PASS');
