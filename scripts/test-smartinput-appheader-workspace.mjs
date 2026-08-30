#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('smartinput/index.html', 'utf8');
const css = await readFile('smartinput/smartinput.css', 'utf8');

assert.match(html, /<header class="app-bar">/, '0a SmartInput app bar must be restored');
assert.match(html, /<div class="workspace workspace--single">/, 'all vouchers must use one full-width workspace');
assert.match(html, /class="header-customer-group"[\s\S]*id="customerInput"/, 'customer entry must be raised into the app header');
assert.match(html, /class="parser-card"[^>]*id="sourceInputPanel"/, 'source intake must remain inside the one-column work flow');
assert.match(html, /id="sourcePanelToggleButton"/, 'source intake must be collapsible');
assert.match(html, /class="workbench"/, 'the work table must remain');
assert.doesNotMatch(html, /class="related-panel"/, 'the old fixed right rail must be removed');
assert.match(html, /id="estimateLibraryView"[\s\S]*id="catalogPickerList"[\s\S]*id="linkedEstimateList"/, 'estimate and linked-estimate lists must replace the full work area');
assert.match(html, /id="inputRows"/, 'the restored editable grid body must remain');
assert.equal((html.match(/data-mode="(?:order|purchase|sale|estimate)"/g) || []).length, 4,
  'all four voucher modes must remain');
assert.doesNotMatch(html, /<kbd|Alt\+[1234]/i, 'Alt+1~4 affordances must stay excluded');

assert.match(css, /\.workspace\.workspace--single[\s\S]*display:\s*block;/,
  'desktop must use one full-width content column');
assert.match(css, /\.workspace--single \.document-fields\s*\{[\s\S]*border-bottom:\s*1px solid var\(--border\)/,
  'search and edit controls must be integrated with the grid card');
assert.match(css, /\.estimate-library-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3/,
  'the estimate library must use the full work area on desktop');
assert.match(css, /\.header-fields\.is-estimate[\s\S]*transactionType[\s\S]*display:\s*none !important/,
  'estimate mode must hide warehouse and transaction fields');

console.log('SmartInput single-workspace app-header contracts PASS');
