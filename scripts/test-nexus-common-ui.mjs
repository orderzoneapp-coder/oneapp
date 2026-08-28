#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const tokens = read('nexus/common/oneapp-design-tokens.css');
const commonCss = read('nexus/common/nexus-app-ui.css');
const registrySource = read('nexus/common/nexus-ui-contract.js');
const documentation = read('nexus/common/NEXUS_APP_UI_CONTRACT.md');
const master = `${read('Master.html')}\n${read('nexus/master/master-app.jsx')}`;
const itemHtml = read('Item_manager.html');
const itemJs = read('Item_manager.js');
const itemCss = read('Item_manager.css');
const customerHtml = read('partner_db.html');
const customerUi = read('orderq/customer-master-ui.js');
const manifest = JSON.parse(read('app-manifest.json'));

for (const [name, value] of [
  ['--nexus-content-max-width', '1440px'],
  ['--nexus-content-gutter', '24px'],
  ['--nexus-app-header-height', '56px'],
  ['--nexus-target-tab-height', '42px'],
  ['--nexus-work-tools-height', '50px'],
  ['--nexus-table-header-height', '40px'],
  ['--nexus-table-row-height', '48px']
]) {
  assert.match(tokens, new RegExp(`${name}: ${value}`), `${name} fixed value must be registered`);
}

for (const source of [tokens, commonCss, master, customerHtml, customerUi]) {
  assert.doesNotMatch(source, /data-nexus-density|nexus-density-change|ONEAPP_NEXUS_DENSITY|oneapp:nexus-density-applied/);
}

for (const hook of ['nexus-app-work-header', 'nexus-app-header-content', 'nexus-target-tabs', 'nexus-work-tools', 'nexus-data-table', 'nexus-app-content']) {
  assert.ok(commonCss.includes(`.${hook}`), `${hook} fixed-layout hook must exist`);
}
assert.match(commonCss, /\.nexus-app-content[\s\S]*max-width, 1440px/);

const context = { window: {} };
vm.runInNewContext(registrySource, context);
const contract = context.window.NEXUS_APP_UI;
assert.equal(contract.version, 'NEXUS_APP_UI_V2');
assert.equal(contract.layout.contentMaxWidth, '1440px');
assert.equal(contract.layout.fixed, true);
assert.equal(contract.getApplication('master-lookup').strategy, 'fixed-layout');
assert.equal(contract.getApplication('master-lookup').status, 'pilot');
assert.equal(contract.getApplication('item-manager').strategy, 'fixed-layout');
assert.equal(contract.getApplication('item-manager').status, 'pilot');
for (const appId of ['merchops', 'dataops', 'orderq', 'smart-parser']) {
  assert.equal(contract.getApplication(appId).strategy, 'registered-exception');
  assert.ok(contract.getApplication(appId).exceptions.length, `${appId} exception must be registered`);
  const exception = contract.getApplication(appId).exceptions[0];
  for (const field of ['id', 'reason', 'excludedItems', 'alternativeUi', 'regressionChecks', 'revisitWhen']) {
    assert.ok(exception[field]?.length, `${appId} exception ${field} must be registered`);
  }
}

for (const source of [master, itemHtml]) {
  assert.match(source, /nexus-app-ui\.css/);
  assert.match(source, /nexus-ui-contract\.js/);
}
assert.match(master, /data-nexus-ui-app="master-lookup"/);
assert.match(itemHtml, /data-nexus-ui-app="item-manager"/);
assert.match(master, /nexus-app-work-header__bar nexus-app-header-content/);
assert.match(master, />기초등록<\/strong>/);
assert.doesNotMatch(master, /MASTER ·/);
assert.match(master, /\[\['list', '조회'\], \['edit', '등록·수정'\], \['mapping', '매핑·관리'\]\]/);
assert.match(master, />\+ 상품 등록<\/button>/);
assert.match(master, /ONEAPP_NEXUS_THEME/);
assert.match(customerHtml, /ONEAPP_NEXUS_THEME/);
assert.match(itemHtml, /oneapp-app-header-content/);
assert.match(itemHtml, />등록·수정<\/a>/);
assert.equal((itemHtml.match(/oneapp-button-primary/g) || []).length, 1, 'Item Manager must expose one highlighted action outside modal overlays');

assert.doesNotMatch(itemJs, /renderMobileEditor|mobileRowId/, 'Item Manager must not create mobile cards');
assert.match(itemCss, /\.table-scroll[\s\S]*overflow:\s*auto/);
assert.match(itemCss, /@media \(max-width: 760px\)[\s\S]*\.table-scroll[\s\S]*display:\s*block/);
assert.doesNotMatch(itemHtml, /mobile-editor/);

const uiContract = manifest.sharedDataContracts.find(entry => entry.id === 'nexus-app-ui');
assert.ok(uiContract, 'nexus-app-ui manifest contract must exist');
assert.equal(uiContract.schemaVersion, 'NEXUS_APP_UI_V2');
assert.equal(uiContract.resources.contentMaxWidthToken, '--nexus-content-max-width');
assert.equal(uiContract.applicationStatus['master-lookup'], 'pilot');
assert.equal(uiContract.applicationStatus['item-manager'], 'pilot');
assert.deepEqual(uiContract.consumers, ['Master.html', 'Item_manager.html', 'partner_db.html']);
for (const appId of ['master-lookup', 'item-manager']) {
  assert.ok(manifest.applications.find(entry => entry.id === appId).sharedContracts.includes('nexus-app-ui'));
  assert.equal(manifest.applications.find(entry => entry.id === appId).status, 'pilot');
}
assert.match(documentation, /하나의 고정 레이아웃/);
assert.match(documentation, /등록되지 않은 예외는 허용하지 않는다/);
assert.match(documentation, /F7\/F8\/F9/);

console.log('NEXUS common fixed application UI contract tests passed.');
