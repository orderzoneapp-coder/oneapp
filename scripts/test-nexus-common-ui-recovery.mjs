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
  ['Master.html', 'master-lookup', 'nexus/common/', '상품관리 - NEXUS'],
  ['customer-master/index.html', 'customer-master', '../nexus/common/', '거래처관리 - NEXUS'],
  ['Item_manager.html', 'item-manager', 'nexus/common/', '상품등록 - NEXUS'],
  ['history_viewer.html', 'history-viewer', 'nexus/common/', '변경이력 - NEXUS'],
  ['orderops/list.html', 'orderops', '../nexus/common/', '주문·출고 - NEXUS'],
  ['orderq/index.html', 'orderq-vnext', '../nexus/common/', '주문현황 - NEXUS'],
  ['orderq/input.html', 'orderq-vnext', '../nexus/common/', '주문서 입력 - NEXUS'],
  ['orderq/operations.html', 'orderq-vnext', '../nexus/common/', '출고운영 - NEXUS'],
  ['orderq/parser.html', 'orderq-vnext', '../nexus/common/', '주문분석 - NEXUS'],
  ['orderq/collector.html', 'orderq-vnext', '../nexus/common/', '기초자료 수집 - NEXUS'],
  ['orderq/cloud.html', 'orderq-vnext', '../nexus/common/', '클라우드 동기화 - NEXUS'],
  ['orderq/voucher-query.html', 'orderq-vnext', '../nexus/common/', '전표 조회 - NEXUS'],
  ['smartinput/index.html', 'smart-input', '../nexus/common/', '스마트입력 - NEXUS'],
];

for (const [file, appId, base, title] of pages) {
  const html = await readFile(file, 'utf8');
  const init = `${base}nexus-ui-theme-init.js?v=1.1.0`;
  const uiCss = `${base}nexus-ui.css?v=1.3.4`;
  const appCss = `${base}nexus-ui-app-themes.css?v=1.3.4`;
  const runtime = `${base}nexus-ui.js?v=1.4.1`;

  assert.match(html, new RegExp(`<script src="${init.replace(/[.?]/g, '\\$&')}" data-nexus-app-id="${appId}"></script>`), `${file}: early theme/app id is required`);
  assert.ok(html.includes(`<link rel="stylesheet" href="${uiCss}"`), `${file}: common UI CSS is required`);
  assert.ok(html.includes(`<link rel="stylesheet" href="${appCss}"`), `${file}: app theme CSS is required`);
  assert.ok(html.includes(`<script defer src="${runtime}"></script>`), `${file}: deferred common UI is required`);
  assert.ok(html.includes(`<title>${title}</title>`), `${file}: browser title must use the Korean NEXUS convention`);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/nexus\/assets\/nexus-favicon\.svg"\s*\/?>/, `${file}: NEXUS favicon is required`);
  assert.ok(html.indexOf(init) < html.indexOf('<body'), `${file}: theme must initialize before body`);
}

for (const [file, appId] of [
  ['Master.html', 'master-lookup'],
  ['MerchOps.html', 'merchops'],
  ['DataOps.html', 'dataops'],
]) {
  const html = await readFile(file, 'utf8');
  assert.match(html, /nexus-app-header[^"`]*[\s\S]*?w-full|w-full[^"`]*[\s\S]*?nexus-app-header/, `${file}: the app header must use the full available width`);
  assert.match(html, new RegExp(`data-nexus-app-header["']?\\s*[:=]\\s*["']${appId}["']`), `${file}: the canonical app-header marker is required`);
  assert.match(html, /min-h-\[56px\]/, `${file}: the Master-based 56px app-header density is required`);
}

const merchOpsPage = await readFile('MerchOps.html', 'utf8');
assert.match(merchOpsPage, /data-nexus-app-header["']?\s*:\s*["']merchops["'][\s\S]*?max-w-\[1500px\]\s+mx-auto/, 'MerchOps: focused sections may remain width-constrained below the full-width app header');
assert.doesNotMatch(merchOpsPage, /data-nexus-app-header["']?\s*:\s*["']merchops["'][^\n]*max-w-\[1500px\]/, 'MerchOps: the app header itself must not inherit the worktable max width');

const initSource = await readFile('nexus/common/nexus-ui-theme-init.js', 'utf8');
const uiSource = await readFile('nexus/common/nexus-ui.js', 'utf8');
const uiCss = await readFile('nexus/common/nexus-ui.css', 'utf8');
const appThemeCss = await readFile('nexus/common/nexus-ui-app-themes.css', 'utf8');
const smartInputCss = await readFile('smartinput/smartinput.css', 'utf8');
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
assert.match(uiSource, /element\('button', 'nexus-ui-theme__icon', '☼'\)/, 'the light icon must be an interactive button');
assert.match(uiSource, /element\('button', 'nexus-ui-theme__icon', '☾'\)/, 'the dark icon must be an interactive button');
assert.match(uiSource, /dataset\.nexusUiThemeSet = 'light'/, 'the light icon must directly apply light mode');
assert.match(uiSource, /dataset\.nexusUiThemeSet = 'dark'/, 'the dark icon must directly apply dark mode');
assert.match(uiSource, /setAttribute\('aria-pressed'/, 'theme icon buttons must expose their selected state');
assert.match(uiSource, /lightIcon\.addEventListener\('click'/, 'the light icon must respond to click and touch activation');
assert.match(uiSource, /darkIcon\.addEventListener\('click'/, 'the dark icon must respond to click and touch activation');
assert.doesNotMatch(uiSource, /['"]system['"]/, 'system theme is forbidden');
assert.match(uiSource, /aria-current/, 'the current app must be exposed accessibly');
assert.match(uiSource, /revealCurrentApp/, 'the current app must be actively revealed in an overflowing global header');
assert.match(uiSource, /nav\.scrollLeft\s*=\s*Math\.max/, 'the overflowing global header must center or edge-align the current app');
assert.match(uiSource, /element\('a', 'nexus-ui-brand__logo'\)/, 'the NEXUS logo must be an actual link');
assert.match(uiSource, /logoFrame\.href = asset\('nexus\/'\)/, 'the NEXUS logo must link to the NEXUS home');
assert.match(uiSource, /logoFrame\.setAttribute\('aria-label', 'NEXUS 홈'\)/, 'the NEXUS home link must have an accessible name');
assert.match(uiSource, /oneapp\.nexus\.ui\.visibility\.v1/, 'common UI must read only the dedicated visibility projection');
assert.match(uiSource, /NEXUS_UI_VISIBILITY_V1/, 'common UI visibility projection must be schema-versioned');
assert.match(uiSource, /sessionStorage\.getItem/, 'common UI must synchronously read the same-tab visibility projection');
assert.doesNotMatch(uiSource, /sessionStorage\.setItem/, 'common UI must never write the visibility projection');
assert.doesNotMatch(uiSource, /displayName|loginId|userId|sessionToken|contextToken|nexus[-_ ]auth/i, 'work-app common UI must not expose or load user-session information');
for (const label of ['가격·시세', '재고·정산', '문서분석', '출력검증', '환경설정', '상품관리', '거래처관리', '상품등록', '변경이력', '주문·출고', '주문현황', '스마트입력']) {
  assert.match(uiSource, new RegExp(`label: '${label}'`), `common header requires the Korean label ${label}`);
}
assert.match(
  uiSource,
  /id:\s*'master-lookup'[\s\S]*?id:\s*'customer-master'[\s\S]*?id:\s*'merchops'[\s\S]*?id:\s*'smart-input'[\s\S]*?id:\s*'orderops'[\s\S]*?id:\s*'dataops'/,
  'rollback-era primary apps must lead the global header so SmartInput remains directly visible',
);
assert.doesNotMatch(uiSource, /label:\s*'(?:MerchOps|DataOps|Smart Parser|Export|Master|ORDER Q|ORDER Q vNext|SmartInput)'/, 'common header tab labels must not fall back to English product names');
assert.match(uiCss, /overflow-x:\s*auto/, 'mobile/compact navigation must remain horizontally usable');
assert.match(uiCss, /min-height:\s*44px/, 'interactive navigation must retain a touch-sized target');
assert.match(uiCss, /\.nexus-ui-theme__icon\s*\{[^}]*width:\s*44px[^}]*height:\s*44px[^}]*touch-action:\s*manipulation/s, 'theme icons must expose a 44px touch target');
assert.match(uiCss, /--nexus-ui-header-height:\s*64px/, 'desktop header must be 64px');
assert.match(uiCss, /--nexus-ui-header-height:\s*104px/, 'mobile header must be 104px');
assert.match(uiCss, /\.nexus-ui-header\s*\{[^}]*width:\s*100%/s, 'the global header must span the full viewport width');
assert.match(uiCss, /grid-template-columns:\s*270px\s+minmax\(0,\s*1fr\)\s+270px/, 'desktop header must keep equal fixed side rails around the centered tabs');
assert.match(uiCss, /\.nexus-ui-brand__current\s*\{[^}]*flex:\s*0\s+0\s+110px[^}]*width:\s*110px[^}]*max-width:\s*110px/s, 'current app/version slot must not move with text length');
assert.match(uiCss, /--nexus-ui-page-bg:\s*#15181d/, 'dark body must be rgb(21, 24, 29)');
assert.match(uiCss, /:root\s*\{[^}]*--nexus-ui-page-bg:\s*#f3efe6/s, 'light body must use the approved ivory page tone');
assert.match(uiCss, /:root\s*\{[^}]*--nexus-ui-panel-bg:\s*#faf7f0/s, 'light panels must use a warm paper surface');
assert.match(uiCss, /:root\s*\{[^}]*--nexus-ui-input-bg:\s*#fffdf8/s, 'light inputs must use a paper-white surface');
assert.match(uiCss, /--nexus-ui-table-header-bg:\s*#292f37/, 'dark table header must use the muted hierarchy');
assert.match(uiCss, /--nexus-ui-table-row-bg:\s*#1d2228/, 'dark table rows must use the muted hierarchy');
assert.match(uiCss, /--nexus-ui-table-row-hover-bg:\s*#282e36/, 'dark table hover must remain neutral');
assert.match(uiCss, /--nexus-ui-selection-bg:\s*#303842/, 'selected tools must use a neutral surface');
assert.match(uiCss, /--nexus-ui-muted:\s*#9aa2ac/, 'dark muted text must remain readable on selected surfaces');
assert.match(uiCss, /--nexus-ui-info:\s*#b3c4d4/, 'dark information state must be low chroma');
assert.match(uiCss, /--nexus-ui-success:\s*#b3c8ba/, 'dark success state must be low chroma');
assert.match(uiCss, /--nexus-ui-warning:\s*#c4b8a8/, 'dark warning state must be low chroma');
assert.match(uiCss, /--nexus-ui-danger:\s*#c7b1b4/, 'dark danger state must be low chroma');
assert.equal((uiCss.match(/--nexus-ui-header-bg:\s*#0b1021/g) || []).length, 2, 'the header must stay dark in both screen modes');
assert.equal((uiCss.match(/--nexus-ui-tab-group-bg:\s*transparent/g) || []).length, 2, 'the old transparent tab rail must stay fixed in both screen modes');
assert.equal((uiCss.match(/--nexus-ui-tab-active-bg:\s*transparent/g) || []).length, 2, 'the old active tab must not use a large filled background');
assert.match(uiCss, /\.nexus-ui-nav__track\s*\{[^}]*height:\s*44px[^}]*gap:\s*4px/s, 'tab group geometry is required');
assert.match(uiCss, /\.nexus-ui-nav__track\s*\{[^}]*margin-inline:\s*auto/s, 'desktop tab group must remain centered independently of label length');
assert.match(uiCss, /\.nexus-ui-nav__link\s*\{[^}]*width:\s*96px[^}]*min-width:\s*96px[^}]*height:\s*38px[^}]*font-size:\s*13px[^}]*font-weight:\s*600/s, 'desktop tabs must be fixed at 38x96px and 13px/600');
assert.match(uiCss, /@media \(max-width:\s*760px\)[\s\S]*?\.nexus-ui-nav__link\s*\{[^}]*min-width:\s*96px[^}]*height:\s*44px/s, 'mobile tabs must be 44x96px');
assert.match(uiCss, /\.nexus-ui-nav__link\.is-current::after\s*\{[^}]*height:\s*2px[^}]*background:\s*var\(--nexus-ui-teal\)/s, 'selected tabs must restore the old mint underline');
assert.match(uiCss, /\.nexus-ui-logo--light\s*\{[^}]*display:\s*none/s, 'the light-background logo must stay hidden on the fixed dark header');
assert.match(uiCss, /\.nexus-ui-logo--dark\s*\{[^}]*display:\s*block/s, 'the dark-header logo must stay visible in both screen modes');
assert.match(appThemeCss, /data-nexus-ui-theme="light"/, 'body light-mode scope is required');
assert.match(appThemeCss, /data-nexus-ui-theme="light"\]\[data-nexus-ui-app\] body\s*\{[^}]*background-color:\s*var\(--nexus-ui-page-bg\)/s, 'all work-app light bodies must consume the ivory page token');
assert.match(appThemeCss, /data-nexus-ui-theme="light"\]\[data-nexus-ui-app\] body th/, 'light table headers must consume the warm hierarchy');
assert.match(appThemeCss, /data-nexus-ui-app="smart-input"[^}]*--app-bg:\s*var\(--nexus-ui-page-bg\)/s, 'SmartInput must bridge its local light palette to the ivory theme');
assert.match(appThemeCss, /data-nexus-ui-app="orderq-vnext"[^}]*--bg:\s*var\(--nexus-ui-page-bg\)/s, 'ORDER Q vNext must bridge its local light palette to the ivory theme');
assert.match(appThemeCss, /data-nexus-ui-app="customer-master"[^}]*--cm-panel:\s*var\(--nexus-ui-panel-bg\)/s, 'Customer Master must bridge its local light palette to the ivory theme');
assert.match(appThemeCss, /data-nexus-ui-app="orderops"[^}]*--white:\s*var\(--nexus-ui-panel-bg\)/s, 'OrderOps must bridge its local light palette to the ivory theme');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"/, 'body dark-mode scope is required');
assert.match(appThemeCss, /\.bg-slate-50\\\/50/, 'dark empty-table backgrounds must be mapped');
assert.match(appThemeCss, /\.bg-indigo-50\\\/50/, 'transparent information surfaces must be mapped');
assert.match(appThemeCss, /\.disabled\\:bg-slate-200:disabled/, 'disabled Tailwind surfaces must be mapped');
assert.match(appThemeCss, /data-nexus-ui-app="orderops"[^}]*[\s\S]*?td\.box-unit-cell/, 'ORDER Q BOX rows must override forced light-mode ink');
assert.match(appThemeCss, /\.header-link:not\(\.header-save-button\)[\s\S]*?background-color:\s*var\(--nexus-ui-panel-bg\)/, 'ORDER Q header tools must retain dark surfaces');
assert.match(appThemeCss, /\.execution-button\.analysis-run:disabled[\s\S]*?color:\s*var\(--nexus-ui-text\)/, 'disabled ORDER Q execution text must remain readable');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"\]\[data-nexus-ui-app\] body :is\(input, select, textarea\)/, 'dark inputs must outrank utility backgrounds');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"\]\[data-nexus-ui-app\] body th/, 'dark table headers must retain a separate hierarchy');
assert.match(appThemeCss, /\.bg-blue-600[\s\S]*?background-color:\s*var\(--nexus-ui-selection-bg\)/, 'solid blue tools must be neutralized');
assert.match(appThemeCss, /\.bg-emerald-600[\s\S]*?background-color:\s*var\(--nexus-ui-success-bg\)/, 'success tools must use a quiet semantic surface');
assert.match(appThemeCss, /data-nexus-ui-app="history-viewer"/, 'history worktable hard-coded surfaces must be covered');
assert.match(appThemeCss, /data-nexus-ui-app="orderops"/, 'ORDER Q local palette must be bridged');
assert.match(appThemeCss, /data-nexus-ui-app="orderq-vnext"/, 'ORDER Q vNext local palette must be bridged');
assert.match(appThemeCss, /--panel:\s*var\(--nexus-ui-panel-bg\)/, 'ORDER Q vNext panels must consume the common dark palette');
assert.match(appThemeCss, /\.parser-summary[\s\S]*?\.source-cards[\s\S]*?background-color:\s*var\(--nexus-ui-panel-subtle\)/, 'ORDER Q vNext custom work surfaces must be dark-aware');
assert.match(appThemeCss, /\.operations-alerts span:not\(\.warn\):not\(\.danger\)[\s\S]*?background-color:\s*var\(--nexus-ui-panel-bg\)/, 'ORDER Q alerts must not retain white chips');
assert.match(appThemeCss, /\.drop-zone \.drop-action[\s\S]*?color:\s*#fff/, 'ORDER Q upload action must use contrast-safe ink');
assert.match(appThemeCss, /@media print[\s\S]*?--nexus-ui-page-bg:\s*#ffffff/, 'direct print must restore a bright background');
assert.match(smartInputCss, /--accent-fill:\s*#16746d/, 'SmartInput solid accent controls need a contrast-safe fill');
assert.match(smartInputCss, /--text-faint:\s*#7b8fa4/, 'SmartInput faint dark text needs readable contrast');

for (const [label, foreground, background] of [
  ['fixed dark tab', '939db5', '0b1021'],
  ['fixed dark active tab', 'ffffff', '0b1021'],
  ['light body text', '292b2f', 'f3efe6'],
  ['light muted text', '66675f', 'f3efe6'],
  ['dark body text', 'd6d9de', '15181d'],
  ['dark muted text', '9aa2ac', '15181d'],
  ['dark muted selected text', '9aa2ac', '303842'],
  ['dark info state', 'b3c4d4', '2a323a'],
  ['dark success state', 'b3c8ba', '2b342f'],
  ['dark warning state', 'c4b8a8', '342f2a'],
  ['dark danger state', 'c7b1b4', '352d2f'],
  ['dark accent state', 'bbbdd0', '302f39'],
  ['dark cyan state', 'b2c6c8', '293435'],
  ['SmartInput solid accent', 'ffffff', '16746d'],
  ['SmartInput faint text', '7b8fa4', '152334'],
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
