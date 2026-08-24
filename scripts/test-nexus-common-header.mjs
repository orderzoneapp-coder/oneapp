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
const navigationCssSource = read('nexus/common/nexus-top-navigation.css');
const themeSource = read('nexus/common/nexus-theme-init.js');
const nexusHome = read('nexus/index.html');
const logoDocumentation = read('nexus/assets/brand/apps/README.md');
const manifest = JSON.parse(read('app-manifest.json'));
const context = { window: {} };
vm.runInNewContext(configSource, context);

const groups = Array.from(context.window.NEXUS_GROUPS, (group) => ({ ...group, logo: { ...group.logo } }));
const apps = Array.from(context.window.NEXUS_APPS, (app) => ({ ...app }));
const globalActions = Array.from(context.window.NEXUS_GLOBAL_ACTIONS, (action) => ({ ...action, logo: { ...action.logo } }));
assert.deepEqual(groups.map((group) => group.id), ['foundation', 'pricing', 'shipping', 'inventory']);
assert.deepEqual(groups.map((group) => group.name), ['기준정보', '가격·시세', '주문·출고', '재고·정산']);
assert.deepEqual(groups.map((group) => group.section), ['management', 'management', 'operations', 'operations']);
assert.deepEqual(groups.map((group) => group.logo.directory), [
  '/nexus/assets/brand/apps/foundation/',
  '/nexus/assets/brand/apps/pricing/',
  '/nexus/assets/brand/apps/shipping/',
  '/nexus/assets/brand/apps/inventory/',
]);
assert.ok(groups.every((group) => group.logo.light === null && group.logo.dark === null));
assert.deepEqual(apps.filter((app) => app.groupId === 'shipping').map((app) => app.name), ['스마트입력', 'ORDER Q', 'OrderOps', 'ORDER IN']);
assert.deepEqual(apps.filter((app) => app.groupId === 'inventory').map((app) => app.name), ['DataOps']);
assert.deepEqual(apps.filter((app) => app.groupId === 'pricing').map((app) => app.name), ['MerchOps', 'Smart Parser']);
assert.deepEqual(apps.filter((app) => app.groupId === 'foundation').map((app) => app.name), ['기초등록', '상품 등록', '거래처 관리']);
assert.ok(apps.filter((app) => app.groupId === 'foundation').every((app) => app.lifecycle === 'operational'));
assert.equal(globalActions.length, 1);
assert.deepEqual(
  { id: globalActions[0].id, appId: globalActions[0].appId, name: globalActions[0].name, section: globalActions[0].section, url: globalActions[0].url },
  { id: 'smart-input', appId: 'smart-input', name: '스마트입력', section: 'operations', url: 'https://oneapp.orderz.co.kr/smartinput/' },
);
assert.equal(globalActions[0].logo.directory, '/nexus/assets/brand/apps/smart-input/');
assert.equal(globalActions[0].logo.light, null);
assert.equal(globalActions[0].logo.dark, null);

assert.match(componentSource, /hiddenGroups: 'oneapp\.nexus\.v1\.hiddenGroups'/);
assert.match(componentSource, /hiddenGlobalActions: 'oneapp\.nexus\.v1\.hiddenGlobalActions'/);
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
assert.match(componentSource, /this\.currentGlobalAction \? '' :/, 'a global SmartInput entry must not activate the Shipping group at the same time');
assert.match(componentSource, /data-global-visible=/);
assert.match(componentSource, /기준·관리와 운영 흐름의 노출·순서를 관리합니다/);
assert.match(componentSource, /action\.appId === this\.currentAppId/);
assert.match(componentSource, /workflow-divider/);
assert.match(componentSource, /management-entries[\s\S]*workflow-divider[\s\S]*global-entries[\s\S]*operation-entries/);
assert.match(componentSource, /nexus-top-navigation\.css/);
assert.match(componentSource, /const colorOptions = \[\['light', '일반'\], \['dark', '다크'\]\]/);
assert.match(componentSource, /requestedColorMode === 'dark' \? 'dark' : 'light'/);
assert.doesNotMatch(componentSource, /\['system', '시스템'\]|prefers-color-scheme|onSystemThemeChange|colorSchemeMedia/);
assert.doesNotMatch(componentSource, /화면 밀도|data-density|nexus-density-change|nexusDensity|STORAGE\.density|preferences\.density/);
assert.match(cssSource, /--nexus-top-height, 44px/);
assert.match(cssSource, /\.top \{\s*width: 100%/);
assert.match(cssSource, /\.global-entries/);
assert.doesNotMatch(cssSource, /data-nexus-density/);
assert.match(cssSource, /@media \(max-width: 680px\)/);
assert.match(navigationCssSource, /\.workflow-divider/);
assert.match(navigationCssSource, /grid-template-columns: auto minmax\(0, 1fr\) auto/);
assert.match(navigationCssSource, /\.nav-brand\.has-logo:not\(\.logo-missing\) \.nav-text/);
assert.match(navigationCssSource, /\.segments\.two/);
assert.match(themeSource, /var VALID_MODES = \["light", "dark"\]/);
assert.match(themeSource, /return mode === "dark" \? "dark" : "light"/);
assert.match(themeSource, /global\.localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(mode\)\)/);
assert.doesNotMatch(themeSource, /prefers-color-scheme|"system"/);
assert.match(nexusHome, /data-nexus-color-mode="light"/);
assert.doesNotMatch(nexusHome, /data-nexus-color-mode="system"|prefers-color-scheme/);
for (const directory of ['foundation', 'pricing', 'smart-input', 'shipping', 'inventory']) {
  assert.ok(fs.existsSync(path.join(root, `nexus/assets/brand/apps/${directory}/.gitkeep`)), `${directory} logo slot must exist`);
}
assert.match(logoDocumentation, /logo-light\.svg/);
assert.match(logoDocumentation, /logo-dark\.svg/);
assert.match(logoDocumentation, /파일 로드에 실패하면 공통헤더는 탭 명칭을 표시한다/);

const manifestContract = manifest.sharedDataContracts.find((contract) => contract.id === 'nexus-header');
assert.ok(manifestContract, 'the shared NEXUS header contract must be registered');
assert.equal(manifestContract.owner, 'nexus');
assert.equal(manifestContract.schemaVersion, 'NEXUS_HEADER_V3');
assert.equal(manifestContract.resources.globalActionVisibilityPreference, 'oneapp.nexus.v1.hiddenGlobalActions');
for (const file of manifestContract.consumers) {
  const source = read(file);
  assert.match(source, /apps-config\.js\?v=1\.4\.0/, `${file} must load the current NEXUS configuration`);
  assert.match(source, /nexus-top\.js\?v=1\.4\.0/, `${file} must load the current NEXUS component`);
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
  assert.match(source, /apps-config\.js\?v=1\.4\.0/);
  assert.match(source, /nexus-top\.js\?v=1\.4\.0/);
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

console.log('NEXUS common header v3 navigation and theme contract tests passed.');
