#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('smartinput/index.html', 'utf8');
const css = await readFile('smartinput/smartinput.css', 'utf8');

assert.match(html, /<header class="si-app-header" data-nexus-app-header="smart-input">/,
  'SmartInput must expose the canonical app-header marker');
assert.doesNotMatch(html, /si-hero|NEXUS · LOCAL FIRST/,
  'the oversized introductory hero must not return');
assert.match(html, /<div class="si-app-header__identity">[\s\S]*?<h1>스마트입력<\/h1>[\s\S]*?<p>원본 확인·전표 작업<\/p>/,
  'the app header must keep app identity and a one-line purpose');
assert.match(html, /<header class="si-app-header"[\s\S]*?<nav class="si-mode-tabs"/,
  'the four voucher modes must remain inside the one-row app header');
assert.equal((html.match(/data-mode="(?:order|purchase|sale|estimate)"/g) || []).length, 4,
  'all four existing voucher modes must remain');
assert.doesNotMatch(html, /<kbd|Alt\+[1234]/i, 'Alt+1~4 affordances must stay excluded');

for (const id of [
  'saveState',
  'draftListButton',
  'draftCount',
  'saveDraftButton',
  'completeButton',
  'deliveryKind',
  'deliveryTitle',
  'deliveryDescription',
  'deliveryMessage',
  'customerInput',
  'voucherDateInput',
  'warehouseInput',
  'workTableBody',
]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must remain exactly once`);
}

assert.match(css, /\.si-app-header\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*56px;[\s\S]*?min-height:\s*56px;[\s\S]*?max-height:\s*56px;/,
  'the app header must be a full-width fixed 56px row');
assert.match(css, /\.si-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*calc\(100vh - var\(--nexus-ui-header-height, 64px\)\)/,
  'the app shell must use the remaining viewport height');
assert.match(css, /\.si-workspace\s*\{[\s\S]*?grid-template-columns:\s*320px minmax\(0, 1fr\);[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;/,
  'the source must stay constrained while the work table receives remaining width and height');
assert.match(css, /\.si-table-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*max-height:\s*none;/,
  'the table scroller must consume the remaining card height');
assert.doesNotMatch(css, /\.si-shell\s*\{[^}]*max-width|\.si-shell\s*\{[^}]*width:\s*min\(/s,
  'the SmartInput shell must not reintroduce a centered max-width cap');

console.log('SmartInput app-header and workspace contracts PASS');
