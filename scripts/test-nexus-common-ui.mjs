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
const master = read('Master.html');
const itemHtml = read('Item_manager.html');
const itemJs = read('Item_manager.js');
const itemCss = read('Item_manager.css');
const customerHtml = read('partner_db.html');
const customerUi = read('orderq/customer-master-ui.js');
const manifest = JSON.parse(read('app-manifest.json'));

for (const [name, standard, compact] of [
  ['--nexus-app-header-height', '56px', '42px'],
  ['--nexus-target-tab-height', '42px', '36px'],
  ['--nexus-work-tools-height', '50px', '42px'],
  ['--nexus-table-header-height', '40px', '34px'],
  ['--nexus-table-row-height', '48px', '36px'],
  ['--nexus-content-gutter', '24px', '12px']
]) {
  assert.match(tokens, new RegExp(`${name}: ${standard}`), `${name} standard value must be registered`);
  assert.match(tokens, new RegExp(`data-nexus-density="compact"[\\s\\S]*${name}: ${compact}`), `${name} compact value must be registered`);
}

for (const hook of ['nexus-app-work-header', 'nexus-target-tabs', 'nexus-work-tools', 'nexus-data-table']) {
  assert.ok(commonCss.includes(`.${hook}`), `${hook} declarative hook must exist`);
}
assert.match(commonCss, /\.nexus-app-shell[\s\S]*max-width:\s*none/, 'common app layout must remove the content maximum width');

const context = { window: {} };
vm.runInNewContext(registrySource, context);
const contract = context.window.NEXUS_APP_UI;
assert.equal(contract.version, 'NEXUS_APP_UI_V1');
assert.deepEqual(Array.from(contract.stateKeys), [
  'activeTab', 'searchState', 'filterState', 'sortState', 'selectedRowId',
  'activeCellId', 'scrollPosition', 'draftChanges', 'openedPanelId'
]);
assert.equal(contract.getApplication('master-lookup').strategy, 'declarative-css');
assert.equal(contract.getApplication('item-manager').strategy, 'declarative-css');
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
assert.doesNotMatch(master, /aria-label="관리 방식"|목록·조회/);
assert.doesNotMatch(itemHtml, /oneapp-subtabs|목록·조회/);
assert.match(master, />일괄 관리<\/button>/);
assert.match(master, />\+ 상품 등록<\/button>/);
assert.equal((itemHtml.match(/oneapp-button-primary/g) || []).length, 1, 'Item Manager must expose one highlighted action outside modal overlays');

assert.doesNotMatch(itemJs, /nexus-density-change|renderMobileEditor|mobileRowId/, 'Item Manager density must remain CSS-only and must not create mobile cards');
assert.match(itemCss, /\.table-scroll[\s\S]*overflow:\s*auto/);
assert.match(itemCss, /@media \(max-width: 760px\)[\s\S]*\.table-scroll[\s\S]*display:\s*block/);
assert.doesNotMatch(itemHtml, /mobile-editor/);

const densityEffect = master.slice(master.indexOf("const sendDensity"), master.indexOf("const discardAddUpdateAnalysis"));
assert.match(densityEffect, /ONEAPP_NEXUS_DENSITY/);
assert.doesNotMatch(densityEffect, /loadMasterLocal|fetch\(|location\.(?:reload|replace)|setMasterRoute|setGlobalSearch/);
assert.match(customerHtml, /ONEAPP_NEXUS_DENSITY[\s\S]*dataset\.nexusDensity/);
assert.match(customerUi, /anchorIndex[\s\S]*focusedCustomerId[\s\S]*renderWindow/);
assert.doesNotMatch(customerUi.slice(customerUi.indexOf("oneapp:nexus-density-applied")), /listCustomers|searchCustomers|synchronizeCustomerMaster/);

const uiContract = manifest.sharedDataContracts.find(entry => entry.id === 'nexus-app-ui');
assert.ok(uiContract, 'nexus-app-ui manifest contract must exist');
assert.equal(uiContract.schemaVersion, 'NEXUS_APP_UI_V1');
assert.deepEqual(uiContract.consumers, ['Master.html', 'Item_manager.html', 'partner_db.html']);
for (const appId of ['master-lookup', 'item-manager']) {
  assert.ok(manifest.applications.find(entry => entry.id === appId).sharedContracts.includes('nexus-app-ui'));
}
assert.match(documentation, /등록되지 않은 예외는 허용하지 않는다/);
assert.match(documentation, /F7\/F8\/F9/);

console.log('NEXUS common application UI contract tests passed.');
