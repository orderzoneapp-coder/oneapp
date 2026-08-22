#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const configSource = read('nexus/common/apps-config.js');
const componentSource = read('nexus/common/nexus-top.js');
const cssSource = read('nexus/common/nexus-top.css');
const manifest = JSON.parse(read('app-manifest.json'));
const context = { window: {} };
vm.runInNewContext(configSource, context);

const groups = Array.from(context.window.NEXUS_GROUPS, (group) => ({ ...group }));
const apps = Array.from(context.window.NEXUS_APPS, (app) => ({ ...app }));
const globalActions = Array.from(context.window.NEXUS_GLOBAL_ACTIONS, (action) => ({ ...action }));
assert.deepEqual(groups.map((group) => group.name), ['출고관리', '재고관리', '시세관리', '기초등록']);
assert.deepEqual(apps.filter((app) => app.groupId === 'shipping').map((app) => app.name), ['스마트입력', 'ORDER Q', 'OrderOps', 'ORDER IN']);
assert.deepEqual(apps.filter((app) => app.groupId === 'inventory').map((app) => app.name), ['DataOps']);
assert.deepEqual(apps.filter((app) => app.groupId === 'pricing').map((app) => app.name), ['MerchOps', 'Smart Parser']);
assert.deepEqual(apps.filter((app) => app.groupId === 'foundation').map((app) => app.name), ['Master', 'Item Manager', '거래처 관리']);
assert.deepEqual(globalActions, [{ id: 'smart-input', appId: 'smart-input', name: '스마트입력', url: 'https://oneapp.orderz.co.kr/smartinput/' }]);

assert.match(componentSource, /hiddenGroups: 'oneapp\.nexus\.v1\.hiddenGroups'/);
assert.match(componentSource, /hiddenApps: 'oneapp\.nexus\.v1\.hiddenApps'/);
assert.match(componentSource, /favoriteApps: 'oneapp\.nexus\.v1\.favoriteApps'/);
assert.match(componentSource, /normal: 0, progress: 1, warning: 2, error: 3/);
assert.match(componentSource, /event\.key === 'Escape'/);
assert.match(componentSource, /trapFocus\(event\)/);
assert.match(componentSource, /nexus:before-navigate/);
assert.match(componentSource, /이 기기에만 적용됨/);
assert.match(componentSource, /마지막 확인/);
assert.match(componentSource, /group\.id === this\.currentGroupId/);
assert.match(componentSource, /NEXUS 메뉴를 불러오지 못했습니다/);
assert.match(componentSource, /renderGlobalEntries\(\)/);
assert.match(componentSource, /class="global-entry\$\{active \? ' is-current' : ''\}"/);
assert.match(cssSource, /--nexus-top-height, 44px/);
assert.match(cssSource, /\.top \{\s*width: 100%/);
assert.match(cssSource, /\.global-entries/);
assert.match(cssSource, /data-nexus-density="compact"/);
assert.match(cssSource, /@media \(max-width: 680px\)/);
const manifestContract = manifest.sharedDataContracts.find((contract) => contract.id === 'nexus-header');
assert.ok(manifestContract, 'the shared NEXUS header contract must be registered');
assert.equal(manifestContract.owner, 'nexus');
assert.equal(manifestContract.schemaVersion, 'NEXUS_HEADER_V2');
for (const file of manifestContract.consumers) {
  const source = read(file);
  assert.match(source, /apps-config\.js\?v=1\.2\.0/, `${file} must load the current NEXUS configuration`);
  assert.match(source, /nexus-top\.js\?v=1\.2\.0/, `${file} must load the current NEXUS component`);
}

const entries = [
  ['Master.html', 'master'],
  ['Item_manager.html', 'item-manager'],
  ['MerchOps.html', 'merchops'],
  ['SmartParser.html', 'smart-parser'],
  ['DataOps.html', 'dataops'],
  ['orders.html', 'orderq'],
  ['orderops/input.html', 'orderops'],
  ['orderq/input.html', 'orderin'],
  ['smartinput/index.html', 'smart-input'],
];
for (const [file, appId] of entries) {
  const source = read(file);
  assert.match(source, new RegExp(`<nexus-top app-id="${appId}">[\\s\\S]*?<\\/nexus-top>`), `${file} must declare its canonical NEXUS app ID`);
  assert.match(source, /apps-config\.js\?v=1\.2\.0/);
  assert.match(source, /nexus-top\.js\?v=1\.2\.0/);
  assert.match(source, /NEXUS 메뉴를 불러오지 못했습니다/);
}

for (const [file, appId] of [
  ['Master.html', 'master'],
  ['Item_manager.js', 'item-manager'],
  ['MerchOps.html', 'merchops'],
  ['SmartParser.html', 'smart-parser'],
  ['DataOps.html', 'dataops'],
  ['orders.html', 'orderq'],
]) {
  assert.match(read(file), new RegExp(`appId: ['"]${appId}['"]`), `${file} must report its own status to NEXUS`);
}

console.log('NEXUS common header v2 contract tests passed.');
