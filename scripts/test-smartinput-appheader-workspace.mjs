#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('smartinput/index.html', 'utf8');
const css = await readFile('smartinput/smartinput.css', 'utf8');

assert.match(html, /<header class="app-bar">/, '0a SmartInput app bar must be restored');
assert.match(html, /<div class="workspace">/, 'the restored workspace must remain');
assert.match(html, /class="parser-card"/, 'the full-height parser surface must remain');
assert.match(html, /id="photoResizer"/, 'the parser/work-table resizer must remain');
assert.match(html, /class="workbench"/, 'the restored work table must remain');
assert.match(html, /class="related-panel"/, 'the right-side connected-app guide must remain');
assert.match(html, /id="inputRows"/, 'the restored editable grid body must remain');
assert.equal((html.match(/data-mode="(?:order|purchase|sale|estimate)"/g) || []).length, 4,
  'all four voucher modes must remain');
assert.doesNotMatch(html, /<kbd|Alt\+[1234]/i, 'Alt+1~4 affordances must stay excluded');

assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*minmax\(330px,[^}]*8px minmax\(0, 1fr\) 230px;/s,
  'desktop must preserve parser, resizer, work table, and right panel columns');
assert.match(css, /\.photo-resizer\s*\{[^}]*cursor:\s*col-resize;/s,
  'the parser width control must remain interactive');
assert.match(css, /@media \(min-width:\s*1481px\)[\s\S]*?\.workspace\s*\{[^}]*height:\s*100%;[^}]*align-items:\s*stretch;/,
  'desktop workspace must consume the available app height');
assert.match(css, /\.parser-card, \.workspace\.has-photo-source \.parser-card\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/s,
  'the parser primary surface must use the remaining height');

console.log('SmartInput restored app-bar and workspace contracts PASS');
