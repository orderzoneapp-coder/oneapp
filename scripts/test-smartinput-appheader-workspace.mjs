#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('smartinput/index.html', 'utf8');
const css = await readFile('smartinput/smartinput.css', 'utf8');
const app = await readFile('smartinput/smartinput.js', 'utf8');

assert.match(html, /<header class="app-bar">/, 'SmartInput app bar must remain');
assert.match(html, /<div class="workspace" id="smartInputWorkspace">/, 'the desktop workspace must remain');
assert.match(html, /class="header-customer-group"[\s\S]*id="customerInput"/, 'customer entry must remain in the app header');
assert.match(html, /class="parser-card"[^>]*id="sourceInputPanel"/, 'the independent source parser must remain');
assert.match(html, /class="workbench"/, 'the work table must remain');
assert.doesNotMatch(html, /id="sourcePanelToggleButton"/, 'the source parser must not be hidden behind a toggle');

assert.match(html, /id="estimateListButton"[^>]*aria-haspopup="dialog"[^>]*>견적서 목록<\/button>/,
  'saved estimates must open only from the explicit estimate-list action');
assert.match(html, /id="relatedPanelToggle"[^>]*aria-haspopup="dialog"[^>]*>관련 전표 불러오기<\/button>/,
  'related vouchers must open only from the explicit import action');
assert.match(html, /id="relatedDialogBackdrop"[^>]*hidden[\s\S]*id="estimateLibraryView"[^>]*role="dialog"[^>]*aria-modal="true"/,
  'the two on-demand views must share one modal surface');
assert.match(html, /id="voucherContextView"[\s\S]*id="voucherContextList"[\s\S]*id="catalogPickerList"/,
  'related-voucher and estimate-list content must remain available inside the shared dialog');
assert.match(html, /id="selectedEstimateDeleteButton"[^>]*>선택 삭제<\/button>[\s\S]*id="estimateRenameButton"[^>]*>이름 변경<\/button>/,
  'the simple estimate list may expose deletion and rename');
assert.doesNotMatch(html, /VOUCHER ACTIVITY|id="relatedPanelResizer"|id="relatedCollapseButton"/,
  'the permanent activity rail and width-management chrome must be removed');
assert.doesNotMatch(html, /id="estimateLibraryLinkedButton"|id="estimateMultiSelectButton"|id="linkedEstimateList"|id="estimateCreateButton"/,
  'linked-estimate and multi-select management must not be exposed');

assert.match(html, /id="gridSearchInput"[\s\S]*id="gridRowCount"[\s\S]*id="deleteSelectedRows"[\s\S]*id="estimateListButton"[\s\S]*id="relatedPanelToggle"[\s\S]*id="resetDraftButton"/,
  'search, editing, list, import, and reset actions must share the grid toolbar');
assert.match(html, /id="completeButton"[^>]*>저장<\/button>[\s\S]*id="saveEstimateAsButton"[^>]*>새 견적서 저장<\/button>[\s\S]*id="estimateNoticeButton"[^>]*>카톡 공유<\/button>[\s\S]*id="estimateExcelButton"[^>]*>EXCEL<\/button>/,
  'the table footer must retain save and approved output actions');
assert.equal((html.match(/data-mode="(?:order|purchase|sale|estimate)"/g) || []).length, 4,
  'all four voucher modes must remain');

assert.match(css, /v0\.8\.5 input-first workspace[\s\S]*\.workspace,[\s\S]*grid-template-columns:[^;]*8px minmax\(0, 1fr\)/,
  'the default workspace must reserve columns only for parser, resizer, and work table');
assert.match(css, /\.related-dialog-backdrop\s*\{[\s\S]*position:\s*fixed[\s\S]*\.related-panel\.is-open/,
  'the shared modal must use a blocking backdrop and an explicit open state');
assert.match(css, /\.related-panel\s*\{[\s\S]*width:\s*min\(720px,[\s\S]*opacity:\s*0[\s\S]*pointer-events:\s*none/,
  'the shared modal must not consume workspace width while closed');
assert.match(css, /@media \(max-width:\s*820px\)[\s\S]*width:\s*calc\(100vw - 16px\)/,
  'the shared modal must fit a mobile viewport');
assert.match(app, /relatedDialogMode:\s*'related-voucher'/);
assert.match(app, /setRelatedPanelOpen\(!sameDialog, \{ mode: 'estimate-list'/);
assert.match(app, /setRelatedPanelOpen\(!sameDialog, \{ mode: 'related-voucher'/);
assert.match(app, /if \(event\.key === 'Escape' && state\.relatedDialogOpen/,
  'Escape must close the on-demand modal');

console.log('SmartInput input-first workspace contracts PASS');
