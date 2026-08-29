import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const relativeLuminance = (hex) => {
  const channels = hex.match(/../g).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
};

const contrastRatio = (foreground, background) => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
};

const pages = [
  ['MerchOps.html', 'merchops', 'nexus/common/', '가격·시세 - NEXUS'],
  ['DataOps.html', 'dataops', 'nexus/common/', '재고·정산 - NEXUS'],
  ['SmartParser.html', 'smart-parser', 'nexus/common/', '문서분석 - NEXUS'],
  ['export_center.html', 'export-center', 'nexus/common/', '출력검증 - NEXUS'],
  ['settings.html', 'settings', 'nexus/common/', '환경설정 - NEXUS'],
  ['Master.html', 'master-lookup', 'nexus/common/', '기준정보 - NEXUS'],
  ['Item_manager.html', 'item-manager', 'nexus/common/', '상품등록 - NEXUS'],
  ['history_viewer.html', 'history-viewer', 'nexus/common/', '변경이력 - NEXUS'],
  ['orderops/list.html', 'orderops', '../nexus/common/', '주문·출고 - NEXUS'],
  ['orderq/index.html', 'orderq-vnext', '../nexus/common/', '주문현황 - NEXUS'],
  ['orderq/input.html', 'orderq-vnext', '../nexus/common/', '주문서 입력 - NEXUS'],
  ['orderq/operations.html', 'orderq-vnext', '../nexus/common/', '출고운영 - NEXUS'],
  ['orderq/parser.html', 'orderq-vnext', '../nexus/common/', '주문분석 - NEXUS'],
  ['orderq/collector.html', 'orderq-vnext', '../nexus/common/', '기초자료 수집 - NEXUS'],
  ['orderq/cloud.html', 'orderq-vnext', '../nexus/common/', '클라우드 동기화 - NEXUS'],
  ['smartinput/index.html', 'smart-input', '../nexus/common/', '스마트입력 - NEXUS'],
];

for (const [file, appId, base, title] of pages) {
  const html = await readFile(file, 'utf8');
  const init = `${base}nexus-ui-theme-init.js?v=1.1.0`;
  const uiCss = `${base}nexus-ui.css?v=1.3.0`;
  const appCss = `${base}nexus-ui-app-themes.css?v=1.2.0`;
  const runtime = `${base}nexus-ui.js?v=1.2.0`;

  assert.match(html, new RegExp(`<script src="${init.replace(/[.?]/g, '\\$&')}" data-nexus-app-id="${appId}"></script>`), `${file}: early theme/app id is required`);
  assert.ok(html.includes(`<link rel="stylesheet" href="${uiCss}"`), `${file}: common UI CSS is required`);
  assert.ok(html.includes(`<link rel="stylesheet" href="${appCss}"`), `${file}: app theme CSS is required`);
  assert.ok(html.includes(`<script defer src="${runtime}"></script>`), `${file}: deferred common UI is required`);
  assert.ok(html.includes(`<title>${title}</title>`), `${file}: browser title must use the Korean NEXUS convention`);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/nexus\/assets\/nexus-favicon\.svg"\s*\/?>/, `${file}: NEXUS favicon is required`);
  assert.ok(html.indexOf(init) < html.indexOf('<body'), `${file}: theme must initialize before body`);
}

const initSource = await readFile('nexus/common/nexus-ui-theme-init.js', 'utf8');
const uiSource = await readFile('nexus/common/nexus-ui.js', 'utf8');
const uiCss = await readFile('nexus/common/nexus-ui.css', 'utf8');
const appThemeCss = await readFile('nexus/common/nexus-ui-app-themes.css', 'utf8');
const combinedRuntime = `${initSource}\n${uiSource}`;

for (const forbidden of [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /indexedDB/,
  /google\.script/,
  /gateway/i,
  /authorization/i,
  /app[-_ ]ready/i,
  /runtime[-_ ]ready/i,
]) {
  assert.doesNotMatch(combinedRuntime, forbidden, `common UI must not include ${forbidden}`);
}

assert.match(initSource, /oneapp\.nexus\.ui\.theme\.v1/, 'dedicated UI preference key is required');
assert.equal((initSource.match(/localStorage\.setItem/g) || []).length, 1, 'only the theme preference may be written');
assert.match(uiSource, /dataset\.nexusUiTheme === 'dark' \? 'light' : 'dark'/, 'the header switch must only toggle light/dark');
assert.match(uiSource, /setAttribute\('role', 'switch'\)/, 'the theme toggle must expose switch semantics');
assert.match(uiSource, /setAttribute\('aria-checked'/, 'the theme toggle must expose its current state');
assert.doesNotMatch(uiSource, /['"]system['"]/, 'system theme is forbidden');
assert.match(uiSource, /aria-current/, 'the current app must be exposed accessibly');
for (const label of ['가격·시세', '재고·정산', '문서분석', '출력검증', '환경설정', '기준정보', '상품등록', '변경이력', '주문·출고', '주문현황', '스마트입력']) {
  assert.match(uiSource, new RegExp(`label: '${label}'`), `common header requires the Korean label ${label}`);
}
assert.match(
  uiSource,
  /id:\s*'master-lookup'[\s\S]*?id:\s*'merchops'[\s\S]*?id:\s*'smart-input'[\s\S]*?id:\s*'orderops'[\s\S]*?id:\s*'dataops'/,
  'rollback-era primary apps must lead the global header so SmartInput remains directly visible',
);
assert.doesNotMatch(uiSource, /label:\s*'(?:MerchOps|DataOps|Smart Parser|Export|Master|ORDER Q|ORDER Q vNext|SmartInput)'/, 'common header tab labels must not fall back to English product names');
assert.match(uiCss, /overflow-x:\s*auto/, 'mobile/compact navigation must remain horizontally usable');
assert.match(uiCss, /min-height:\s*44px/, 'interactive navigation must retain a touch-sized target');
assert.match(uiCss, /--nexus-ui-header-height:\s*64px/, 'desktop header must be 64px');
assert.match(uiCss, /--nexus-ui-header-height:\s*104px/, 'mobile header must be 104px');
assert.match(uiCss, /grid-template-columns:\s*270px\s+minmax\(0,\s*1fr\)\s+270px/, 'desktop header must keep equal fixed side rails around the centered tabs');
assert.match(uiCss, /\.nexus-ui-brand__current\s*\{[^}]*flex:\s*0\s+0\s+110px[^}]*width:\s*110px[^}]*max-width:\s*110px/s, 'current app/version slot must not move with text length');
assert.match(uiCss, /--nexus-ui-page-bg:\s*#15181d/, 'dark body must be rgb(21, 24, 29)');
assert.match(uiCss, /--nexus-ui-table-header-bg:\s*#292f37/, 'dark table header must use the muted hierarchy');
assert.match(uiCss, /--nexus-ui-table-row-bg:\s*#1d2228/, 'dark table rows must use the muted hierarchy');
assert.match(uiCss, /--nexus-ui-table-row-hover-bg:\s*#282e36/, 'dark table hover must remain neutral');
assert.match(uiCss, /--nexus-ui-selection-bg:\s*#303842/, 'selected tools must use a neutral surface');
assert.match(uiCss, /--nexus-ui-info:\s*#b3c4d4/, 'dark information state must be low chroma');
assert.match(uiCss, /--nexus-ui-success:\s*#b3c8ba/, 'dark success state must be low chroma');
assert.match(uiCss, /--nexus-ui-warning:\s*#c4b8a8/, 'dark warning state must be low chroma');
assert.match(uiCss, /--nexus-ui-danger:\s*#c7b1b4/, 'dark danger state must be low chroma');
assert.match(uiCss, /--nexus-ui-header-bg:\s*#101722/, 'dark header palette must be preserved');
assert.match(uiCss, /--nexus-ui-tab-group-bg:\s*#1a2330/, 'dark tab group palette must be preserved');
assert.match(uiCss, /--nexus-ui-tab-active-bg:\s*#354153/, 'dark selected tab palette must be preserved');
assert.match(uiCss, /\.nexus-ui-nav__track\s*\{[^}]*height:\s*44px[^}]*gap:\s*4px/s, 'tab group geometry is required');
assert.match(uiCss, /\.nexus-ui-nav__track\s*\{[^}]*margin-inline:\s*auto/s, 'desktop tab group must remain centered independently of label length');
assert.match(uiCss, /\.nexus-ui-nav__link\s*\{[^}]*width:\s*96px[^}]*min-width:\s*96px[^}]*height:\s*38px[^}]*font-size:\s*13px[^}]*font-weight:\s*600/s, 'desktop tabs must be fixed at 38x96px and 13px/600');
assert.match(uiCss, /@media \(max-width:\s*760px\)[\s\S]*?\.nexus-ui-nav__link\s*\{[^}]*min-width:\s*96px[^}]*height:\s*44px/s, 'mobile tabs must be 44x96px');
assert.doesNotMatch(uiCss, /\.nexus-ui-nav__link::after/, 'selected tabs must not use an underline');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"/, 'body dark-mode scope is required');
assert.match(appThemeCss, /\.bg-slate-50\\\/50/, 'dark empty-table backgrounds must be mapped');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"\]\[data-nexus-ui-app\] body :is\(input, select, textarea\)/, 'dark inputs must outrank utility backgrounds');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"\]\[data-nexus-ui-app\] body th/, 'dark table headers must retain a separate hierarchy');
assert.match(appThemeCss, /\.bg-blue-600[\s\S]*?background-color:\s*var\(--nexus-ui-selection-bg\)/, 'solid blue tools must be neutralized');
assert.match(appThemeCss, /\.bg-emerald-600[\s\S]*?background-color:\s*var\(--nexus-ui-success-bg\)/, 'success tools must use a quiet semantic surface');
assert.match(appThemeCss, /data-nexus-ui-app="history-viewer"/, 'history worktable hard-coded surfaces must be covered');
assert.match(appThemeCss, /data-nexus-ui-app="orderops"/, 'ORDER Q local palette must be bridged');
assert.match(appThemeCss, /data-nexus-ui-app="orderq-vnext"/, 'ORDER Q vNext local palette must be bridged');
assert.match(appThemeCss, /@media print[\s\S]*?--nexus-ui-page-bg:\s*#ffffff/, 'direct print must restore a bright background');

for (const [label, foreground, background] of [
  ['dark tab', '8f9aaa', '1a2330'],
  ['dark active tab', 'f4f7fb', '354153'],
  ['light tab', '667085', 'f1f4f7'],
  ['light active tab', '24364d', 'dfe7f0'],
  ['dark body text', 'd6d9de', '15181d'],
  ['dark muted text', '9299a3', '15181d'],
  ['dark info state', 'b3c4d4', '2a323a'],
  ['dark success state', 'b3c8ba', '2b342f'],
  ['dark warning state', 'c4b8a8', '342f2a'],
  ['dark danger state', 'c7b1b4', '352d2f'],
  ['dark accent state', 'bbbdd0', '302f39'],
  ['dark cyan state', 'b2c6c8', '293435'],
]) {
  assert.ok(contrastRatio(foreground, background) >= 4.5, `${label}: WCAG contrast must be at least 4.5:1`);
}

for (const logo of [
  'nexus/assets/brand/oneapp-nexus-light.svg',
  'nexus/assets/brand/oneapp-nexus-dark.svg',
  'nexus/assets/nexus-favicon.svg',
]) {
  const svg = await readFile(logo, 'utf8');
  assert.match(svg, /<svg\b/, `${logo}: valid SVG root is required`);
  assert.doesNotMatch(svg, /<rect[^>]+(?:fill=['"]#(?:fff|ffffff)['"]|fill=['"]white['"])/i, `${logo}: opaque white background is forbidden`);
}

console.log(`NEXUS common UI recovery contracts passed (${pages.length} pages).`);
