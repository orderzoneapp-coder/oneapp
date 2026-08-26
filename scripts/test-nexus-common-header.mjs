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
const tokenSource = read('nexus/common/oneapp-design-tokens.css');
const headerDocumentation = read('nexus/common/README.md');
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
assert.equal(globalActions[0].logo.light, '/nexus/assets/brand/apps/smart-input/logo-light.png');
assert.equal(globalActions[0].logo.dark, '/nexus/assets/brand/apps/smart-input/logo-dark.png');
assert.ok(fs.existsSync(path.join(root, 'nexus/assets/brand/apps/smart-input/logo-light.png')));
assert.ok(fs.existsSync(path.join(root, 'nexus/assets/brand/apps/smart-input/logo-dark.png')));

const tabButtonAssets = {
  foundation: ['foundation-active.png', 'foundation-inactive.png'],
  pricing: ['pricing-active.png', 'pricing-inactive.png'],
  'smart-input': ['smart-input-active.png', 'smart-input-inactive.png'],
  shipping: ['shipping-active.png', 'shipping-inactive.png'],
  inventory: ['inventory-active.png', 'inventory-inactive.png'],
};
for (const [tabId, files] of Object.entries(tabButtonAssets)) {
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(root, 'nexus/assets/navigation-tabs', file));
    assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', `${tabId} ${file} must be a PNG`);
    assert.equal(buffer.readUInt32BE(16), 1600, `${tabId} ${file} width must remain 1600px`);
    assert.equal(buffer.readUInt32BE(20), 400, `${tabId} ${file} height must remain 400px`);
  }
}

assert.match(componentSource, /hiddenGroups: 'oneapp\.nexus\.v1\.hiddenGroups'/);
assert.match(componentSource, /hiddenGlobalActions: 'oneapp\.nexus\.v1\.hiddenGlobalActions'/);
assert.match(componentSource, /hiddenApps: 'oneapp\.nexus\.v1\.hiddenApps'/);
assert.match(componentSource, /favoriteApps: 'oneapp\.nexus\.v1\.favoriteApps'/);
assert.match(componentSource, /normal: 0, progress: 1, warning: 2, error: 3/);
assert.match(componentSource, /event\.key === 'Escape'/);
assert.match(componentSource, /trapFocus\(event\)/);
assert.match(componentSource, /nexus:before-navigate/);
assert.match(componentSource, /oneapp\.nexus\.v1\.navigation/);
assert.match(componentSource, /cover\.id = NAVIGATION_COVER_ID/);
assert.match(componentSource, /NEXUS WORKSPACE/);
assert.match(componentSource, /업무 화면을 준비하고 있습니다/);
assert.match(componentSource, /window\.addEventListener\('load', \(\) => clearNavigationCover\(\)/);
assert.match(componentSource, /const VERSION = '1\.6\.0'/);
assert.match(componentSource, /const TAB_BUTTONS = Object\.freeze/);
assert.match(componentSource, /preloadTabButtonImages\(\)/, 'all active and inactive tab images must be preloaded');
assert.match(componentSource, /data-active-src=.*data-inactive-src=/, 'each tab image must expose both visual states');
assert.match(componentSource, /this\.navigationPending = true;\s*this\.setPendingNavigationSelection\(link, appId, groupId\);/,
  'an allowed tab touch must switch its image before navigation starts');
assert.match(componentSource, /image\.src = selected \? image\.dataset\.activeSrc : image\.dataset\.inactiveSrc/);
assert.match(componentSource, /this\.onPageShow = \(\) => this\.restoreCurrentNavigationSelection\(\)/,
  'back-forward restoration must return selection to the current app ID');
assert.match(componentSource, /navigationMode = \(requestedMode\)/,
  'the loading cover must resolve the current light or dark mode before rendering');
assert.match(componentSource, /const marker = \{ label, mode, startedAt: Date\.now\(\), url: link\.href \}/,
  'same-tab navigation must carry the selected mode to the destination cover');
assert.match(componentSource, /\[data-mode="dark"\]/,
  'the loading cover must provide a dedicated dark-mode visual');
assert.match(componentSource, /background:rgba\(255,255,255,\.88\)/,
  'the default loading cover card must remain light in normal mode');
assert.match(componentSource, /window\.setTimeout\(\(\) => \{[\s\S]*window\.location\.assign\(link\.href\);[\s\S]*\}, 80\)/,
  'same-tab navigation must paint the loading cover before changing documents');
assert.doesNotMatch(componentSource, /nexus-navigation-cover__mark[^`]*<img/,
  'the navigation cover must not depend on another image request');
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
assert.match(componentSource, /const themeController = ensureThemeController\(\)/);
assert.match(componentSource, /themeController\.apply\(colorMode, \{ emit: true, source: 'header' \}\)/);
assert.match(componentSource, /dataset\.nexusTheme \|\| document\.documentElement\.dataset\.nexusColorMode/,
  'data-nexus-theme must be the authoritative navigation-cover mode');
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
assert.match(navigationCssSource, /\.nav-tab-button/);
assert.match(navigationCssSource, /\.segments\.two/);
assert.match(themeSource, /var VALID_MODES = \["light", "dark"\]/);
assert.match(themeSource, /return mode === "dark" \? "dark" : "light"/);
assert.match(themeSource, /global\.localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(mode\)\)/);
assert.doesNotMatch(themeSource, /prefers-color-scheme|"system"/);
assert.match(themeSource, /root\.dataset\.nexusTheme = next/);
assert.match(themeSource, /new global\.CustomEvent\("nexus-theme-change", \{ detail: detail \}\)/);
assert.match(themeSource, /var detail = \{ theme: next, colorMode: next \}/,
  'the existing event payload fields must remain backward compatible');
assert.doesNotMatch(themeSource, /reload|location\./,
  'theme application must not reload or navigate the application');
assert.doesNotMatch(tokenSource, /prefers-color-scheme|data-nexus-theme="system"/);
assert.doesNotMatch(tokenSource, /!important|\.bg-white|\.text-slate|\.border-slate/,
  'semantic tokens must not become a global Tailwind palette override');
for (const token of ['nexus-price-up', 'nexus-price-down', 'nexus-negative-margin', 'nexus-stock-shortage', 'nexus-order-conflict', 'nexus-reconciliation-diff']) {
  assert.match(tokenSource, new RegExp(`--${token}:`), `${token} must remain separate from common status semantics`);
}
assert.match(headerDocumentation, /data-nexus-theme.*유일한 테마 입력/);
assert.match(headerDocumentation, /화면 reload, 업무 데이터 재조회/);
assert.match(headerDocumentation, /Excel·ERP·인쇄·카카오 이미지 컨테이너/);
assert.match(nexusHome, /data-nexus-color-mode="light"/);
assert.doesNotMatch(nexusHome, /data-nexus-color-mode="system"|prefers-color-scheme/);
assert.ok(nexusHome.indexOf('nexus-theme-init.js') < nexusHome.indexOf('<style>'),
  'the synchronous theme initializer must run before first-paint styles');

const createThemeHarness = (initialStorage = {}) => {
  const values = new Map(Object.entries(initialStorage));
  const events = [];
  const root = { dataset: {}, style: {} };
  const applicationState = {
    search: 'fresh produce',
    filters: ['open', 'today'],
    selection: 'order-1042',
    editing: { field: 'quantity', value: '12' },
    scrollTop: 428,
    sync: 'saving',
  };
  class HarnessCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const themeWindow = {
    document: { documentElement: root, applicationState },
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    CustomEvent: HarnessCustomEvent,
    dispatchEvent: (event) => { events.push(event); return true; },
  };
  vm.runInNewContext(themeSource, { window: themeWindow });
  return { applicationState, controller: themeWindow.ONEAPP_NEXUS_THEME_INIT, events, root, values };
};

const darkHarness = createThemeHarness({ 'oneapp.nexus.v1.colorMode': JSON.stringify('dark') });
assert.equal(darkHarness.root.dataset.nexusTheme, 'dark');
assert.equal(darkHarness.root.dataset.nexusColorMode, 'dark');
assert.equal(darkHarness.root.style.colorScheme, 'dark');
assert.equal(darkHarness.events.length, 0, 'bootstrap applies before consumers without emitting a late event');
assert.deepEqual(Array.from(darkHarness.controller.validModes), ['light', 'dark']);
const preservedState = JSON.stringify(darkHarness.applicationState);
darkHarness.controller.apply('light', { emit: true, source: 'contract-test' });
assert.equal(JSON.stringify(darkHarness.applicationState), preservedState,
  'theme changes must not mutate search, filters, selection, editing, scroll, or sync state');
assert.equal(darkHarness.events.length, 1);
assert.equal(darkHarness.events[0].type, 'nexus-theme-change');
assert.equal(darkHarness.events[0].detail.theme, 'light');
assert.equal(darkHarness.events[0].detail.colorMode, 'light');
assert.equal(darkHarness.events[0].detail.source, 'contract-test');

const invalidHarness = createThemeHarness({ 'oneapp.nexus.v1.colorMode': JSON.stringify('system') });
assert.equal(invalidHarness.root.dataset.nexusTheme, 'light');
assert.equal(invalidHarness.values.get('oneapp.nexus.v1.colorMode'), JSON.stringify('light'));

const legacyHarness = createThemeHarness({ 'oneapp.nexus.theme': JSON.stringify('dark') });
assert.equal(legacyHarness.root.dataset.nexusTheme, 'dark');
assert.equal(legacyHarness.values.get('oneapp.nexus.v1.colorMode'), JSON.stringify('dark'));

const cssVariables = (selector) => {
  const start = tokenSource.indexOf(selector);
  assert.ok(start >= 0, `missing CSS selector ${selector}`);
  const open = tokenSource.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < tokenSource.length; index += 1) {
    if (tokenSource[index] === '{') depth += 1;
    if (tokenSource[index] === '}') depth -= 1;
    if (depth === 0) {
      const block = tokenSource.slice(open + 1, index);
      return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
    }
  }
  throw new Error(`unterminated CSS selector ${selector}`);
};
const relativeLuminance = (hex) => {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrastRatio = (foreground, background) => {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
const lightTokens = cssVariables(':root');
const darkTokens = cssVariables('html[data-nexus-theme="dark"]');
const contrastPairs = [
  ['nexus-success', 'nexus-success-bg'],
  ['nexus-warning', 'nexus-warning-bg'],
  ['nexus-danger', 'nexus-danger-bg'],
];
const contrastSummary = [];
for (const [mode, tokens] of [['light', lightTokens], ['dark', darkTokens]]) {
  for (const [foregroundToken, backgroundToken] of contrastPairs) {
    const ratio = contrastRatio(tokens[foregroundToken], tokens[backgroundToken]);
    assert.ok(ratio >= 4.5, `${mode} ${foregroundToken}/${backgroundToken} contrast ${ratio.toFixed(2)} must be at least 4.5`);
    contrastSummary.push(`${mode}:${foregroundToken.replace('nexus-', '')}=${ratio.toFixed(2)}:1`);
  }
}
for (const directory of ['foundation', 'pricing', 'smart-input', 'shipping', 'inventory']) {
  assert.ok(fs.existsSync(path.join(root, `nexus/assets/brand/apps/${directory}/.gitkeep`)), `${directory} logo slot must exist`);
}
assert.match(logoDocumentation, /logo-light\.png/);
assert.match(logoDocumentation, /logo-dark\.png/);
assert.match(logoDocumentation, /파일 로드에 실패하면 공통헤더는 탭 명칭을 표시한다/);

const manifestContract = manifest.sharedDataContracts.find((contract) => contract.id === 'nexus-header');
assert.ok(manifestContract, 'the shared NEXUS header contract must be registered');
assert.equal(manifestContract.owner, 'nexus');
assert.equal(manifestContract.schemaVersion, 'NEXUS_HEADER_V3');
assert.equal(manifestContract.resources.globalActionVisibilityPreference, 'oneapp.nexus.v1.hiddenGlobalActions');
assert.equal(manifestContract.resources.navigationLoadingSession, 'oneapp.nexus.v1.navigation');
for (const file of manifestContract.consumers) {
  const source = read(file);
  assert.match(source, /apps-config\.js\?v=1\.4\.0/, `${file} must load the current NEXUS configuration`);
  assert.match(source, /nexus-top\.js\?v=1\.6\.0/, `${file} must load the current NEXUS component`);
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
  assert.match(source, /nexus-top\.js\?v=1\.6\.0/);
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

await import('./test-nexus-operational-darkmode.mjs');

console.log(`NEXUS common header v3 navigation and theme contract tests passed. ${contrastSummary.join(', ')}`);
