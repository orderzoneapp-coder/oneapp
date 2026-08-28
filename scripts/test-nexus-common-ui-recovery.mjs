import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  ['MerchOps.html', 'merchops', 'nexus/common/'],
  ['DataOps.html', 'dataops', 'nexus/common/'],
  ['SmartParser.html', 'smart-parser', 'nexus/common/'],
  ['export_center.html', 'export-center', 'nexus/common/'],
  ['settings.html', 'settings', 'nexus/common/'],
  ['Master.html', 'master-lookup', 'nexus/common/'],
  ['Item_manager.html', 'item-manager', 'nexus/common/'],
  ['history_viewer.html', 'history-viewer', 'nexus/common/'],
  ['orderops/list.html', 'orderops', '../nexus/common/'],
  ['orderq/index.html', 'orderq-vnext', '../nexus/common/'],
  ['orderq/input.html', 'orderq-vnext', '../nexus/common/'],
  ['orderq/operations.html', 'orderq-vnext', '../nexus/common/'],
  ['orderq/parser.html', 'orderq-vnext', '../nexus/common/'],
  ['orderq/collector.html', 'orderq-vnext', '../nexus/common/'],
  ['orderq/cloud.html', 'orderq-vnext', '../nexus/common/'],
];

for (const [file, appId, base] of pages) {
  const html = await readFile(file, 'utf8');
  const init = `${base}nexus-ui-theme-init.js?v=1.0.0`;
  const uiCss = `${base}nexus-ui.css?v=1.0.0`;
  const appCss = `${base}nexus-ui-app-themes.css?v=1.0.0`;
  const runtime = `${base}nexus-ui.js?v=1.0.0`;

  assert.match(html, new RegExp(`<script src="${init.replace(/[.?]/g, '\\$&')}" data-nexus-app-id="${appId}"></script>`), `${file}: early theme/app id is required`);
  assert.ok(html.includes(`<link rel="stylesheet" href="${uiCss}"`), `${file}: common UI CSS is required`);
  assert.ok(html.includes(`<link rel="stylesheet" href="${appCss}"`), `${file}: app theme CSS is required`);
  assert.ok(html.includes(`<script defer src="${runtime}"></script>`), `${file}: deferred common UI is required`);
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
assert.match(uiSource, /\['light', '일반모드'\], \['dark', '다크모드'\]/, 'only light/dark controls are allowed');
assert.doesNotMatch(uiSource, /['"]system['"]/, 'system theme is forbidden');
assert.match(uiSource, /aria-current/, 'the current app must be exposed accessibly');
assert.match(uiCss, /overflow-x:\s*auto/, 'mobile/compact navigation must remain horizontally usable');
assert.match(uiCss, /min-height:\s*44px/, 'interactive navigation must retain a touch-sized target');
assert.match(appThemeCss, /data-nexus-ui-theme="dark"/, 'body dark-mode scope is required');

for (const logo of [
  'nexus/assets/brand/oneapp-nexus-light.svg',
  'nexus/assets/brand/oneapp-nexus-dark.svg',
]) {
  const svg = await readFile(logo, 'utf8');
  assert.match(svg, /<svg\b/, `${logo}: valid SVG root is required`);
  assert.doesNotMatch(svg, /<rect[^>]+(?:fill=['"]#(?:fff|ffffff)['"]|fill=['"]white['"])/i, `${logo}: opaque white background is forbidden`);
}

console.log(`NEXUS common UI recovery contracts passed (${pages.length} pages).`);
