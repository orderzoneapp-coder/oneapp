#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const host = require('../nexus/workspace.js');
const workspaceHref = 'https://example.test/nexus/workspace.html';
const siteRoot = 'https://example.test/';

assert.equal(host.VERSION, '1.0.0');
assert.equal(host.SCHEMA_VERSION, 'nexus-workspace-message/v1');
assert.deepEqual(host.APPS.map(({ id, label, path }) => ({ id, label, path })), [
  { id: 'master-lookup', label: '상품관리', path: 'Master.html' },
  { id: 'customer-master', label: '거래처관리', path: 'customer-master/index.html' },
  { id: 'smart-input', label: '스마트입력', path: 'smartinput/index.html' },
  { id: 'smart-parser', label: '스마트파서', path: 'SmartParser.html' },
  { id: 'merchops', label: 'MerchOps', path: 'MerchOps.html' },
  { id: 'orderops', label: '출고관리', path: 'orderops/list.html' },
  { id: 'dataops', label: 'DataOps', path: 'DataOps.html' },
]);

const empty = host.parseHostRequest('', workspaceHref);
assert.equal(empty.ok, true, 'an empty host route must use the product-management entry');
assert.equal(empty.route, 'Master.html');

const order = host.parseHostRequest('?app=orderops&route=orderops%2Flist.html%3ForderId%3DORDER-1%26focus%3Dnote', workspaceHref);
assert.equal(order.ok, true);
assert.equal(order.url, 'https://example.test/orderops/list.html?orderId=ORDER-1&focus=note');
assert.equal(order.route, 'orderops/list.html?orderId=ORDER-1&focus=note');

for (const [appId, route, code] of [
  ['unknown', 'Master.html', 'UNKNOWN_APP'],
  ['master-lookup', 'https://attacker.test/Master.html', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'javascript:alert(1)', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'data:text/html,hello', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'customer-master/index.html', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'nexus/../customer-master/index.html', 'ROUTE_NOT_ALLOWED'],
]) {
  const result = appId === 'unknown'
    ? host.parseHostRequest(`?app=${appId}&route=${encodeURIComponent(route)}`, workspaceHref)
    : host.validateRoute(appId, route, siteRoot, 'https://example.test');
  assert.equal(result.ok, false, `${appId}/${route} must be rejected`);
  assert.equal(result.code, code);
}

const workspaceUrl = new URL(host.workspaceUrlFor(order, workspaceHref));
assert.equal(workspaceUrl.pathname, '/nexus/workspace.html');
assert.equal(workspaceUrl.searchParams.get('app'), 'orderops');
assert.equal(workspaceUrl.searchParams.get('route'), 'orderops/list.html?orderId=ORDER-1&focus=note');

const projectPages = host.parseHostRequest('?app=dataops&route=DataOps.html%3Fview%3Dstock', 'https://example.test/oneapp/nexus/workspace.html');
assert.equal(projectPages.ok, true, 'a project-site base path must remain inside its site root');
assert.equal(projectPages.url, 'https://example.test/oneapp/DataOps.html?view=stock');
assert.equal(projectPages.route, 'DataOps.html?view=stock', 'the parent route must stay relative to the project-site root');

const source = {};
const validEvent = {
  origin: 'https://example.test',
  source,
  data: {
    schemaVersion: host.SCHEMA_VERSION,
    type: host.MESSAGE_TYPES.APP_READY,
    transitionId: 'transition-1',
    appId: 'master-lookup',
  },
};
const messageOptions = { origin: 'https://example.test', source, transitionId: 'transition-1' };
assert.equal(host.validateMessageEvent(validEvent, messageOptions), true);
assert.equal(host.validateMessageEvent({ ...validEvent, origin: 'https://attacker.test' }, messageOptions), false, 'foreign origin must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, source: {} }, messageOptions), false, 'foreign window must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, data: { ...validEvent.data, transitionId: 'stale' } }, messageOptions), false, 'stale transitions must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, data: { ...validEvent.data, type: 'UNKNOWN' } }, messageOptions), false, 'unknown message types must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, data: { ...validEvent.data, appId: 'unknown' } }, messageOptions), false, 'unknown message app IDs must be ignored');

const [html, css, js, commonUi, architecture] = await Promise.all([
  readFile('nexus/workspace.html', 'utf8'),
  readFile('nexus/workspace.css', 'utf8'),
  readFile('nexus/workspace.js', 'utf8'),
  readFile('nexus/common/nexus-ui.js', 'utf8'),
  readFile('APP_ARCHITECTURE.md', 'utf8'),
]);

assert.match(html, /id="nexusWorkspaceFrame"/);
assert.match(html, /common\/nexus-ui-theme-init\.js\?v=1\.1\.0/);
assert.match(html, /common\/nexus-ui\.js\?v=1\.6\.1/);
assert.equal((html.match(/<iframe\b/g) || []).length, 1, 'the host must own exactly one iframe');
assert.match(html, /독립 앱으로 열기/);
assert.match(html, /다시 시도/);
assert.match(css, /height:\s*calc\(100dvh - var\(--nexus-ui-header-height/);
assert.match(js, /event\.origin !== options\.origin/);
assert.match(js, /event\.source !== options\.source/);
assert.match(js, /data\.transitionId !== options\.transitionId/);
assert.match(js, /history\.replaceState/);
assert.match(js, /history\.pushState/);
assert.match(js, /NEXUS_WORKSPACE_BEFORE_LEAVE_V1/);
assert.match(js, /NEXUS_WORKSPACE_PRINT_V1/);
assert.doesNotMatch(js, /\bfetch\s*\(|indexedDB|localStorage\.setItem|sessionStorage\.setItem|google\.script/, 'the host must not read or write business/runtime data');
assert.match(commonUi, /id:\s*'master-lookup'[\s\S]*id:\s*'customer-master'[\s\S]*id:\s*'smart-input'[\s\S]*id:\s*'smart-parser'[\s\S]*id:\s*'merchops'[\s\S]*id:\s*'orderops'[\s\S]*id:\s*'dataops'/);
assert.match(architecture, /글로벌 탭은 상품관리·거래처관리·스마트입력·스마트파서·MerchOps·출고관리·DataOps로 고정/);

console.log('PASS NEXUS workspace host contracts: one iframe, canonical routes, same-origin messaging, parent history, safe fallback.');
