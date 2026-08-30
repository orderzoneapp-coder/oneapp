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
assert.match(html, /id="estimateLibraryButton"[^>]*>견적서 목록 전체보기</, 'the full library must require an explicit action');
assert.match(html, /id="estimateEditorButton"[^>]*>편집기로 돌아가기</, 'the expanded library must expose an explicit preserved-editor return path');
assert.match(html, /id="inputRows"/, 'the restored editable grid body must remain');
assert.equal((html.match(/data-mode="(?:order|purchase|sale|estimate)"/g) || []).length, 4,
  'all four voucher modes must remain');
assert.doesNotMatch(html, /<kbd|Alt\+[1234]/i, 'Alt+1~4 affordances must stay excluded');

assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*minmax\(330px,[^}]*8px minmax\(0, 1fr\) 230px;/s,
  'desktop must preserve parser, resizer, work table, and right estimate-list columns');
assert.match(css, /\.grid-card > \.work-action-bar\s*\{[\s\S]*border-bottom:\s*1px solid var\(--border\)/,
  'search and edit controls must be integrated with the grid card');
assert.match(css, /\.workspace\.is-estimate-library-open[\s\S]*> \.estimate-library-view/,
  'the estimate library may replace the workspace only after explicit view activation');
assert.match(css, /@media \(min-width:\s*821px\) and \(max-width:\s*1480px\)[\s\S]*grid-template-columns:[^;]*8px minmax\(0, 1fr\)/,
  'intermediate desktop widths must preserve side-by-side parser and table columns');
assert.match(css, /\.header-fields\.is-estimate[\s\S]*transactionType[\s\S]*display:\s*none !important/,
  'estimate mode must hide warehouse and transaction fields');

console.log('SmartInput protected desktop workspace contracts PASS');
