import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = [
  'Master.html', 'customer-master/index.html', 'SmartParser.html', 'MerchOps.html',
  'smartinput/index.html', 'orderops/list.html', 'DataOps.html',
];
for (const relative of pages) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.match(html, /nexus-table-ux\.css\?v=1\.1\.0/, `${relative} must load common table presentation`);
  assert.match(html, /nexus-table-ux\.js\?v=1\.1\.0/, `${relative} must load common table interaction`);
}

const css = fs.readFileSync(path.join(root, 'nexus/common/nexus-table-ux.css'), 'utf8');
for (const token of ['#f5f6f7', '#ffffff', '#e5e7eb', '#1f2937', '#4b5563', '#d1d5db', '#e0f2f1', '#0f766e']) {
  assert.ok(css.toLowerCase().includes(token), `common table palette missing ${token}`);
}
assert.match(css, /thead th\s*\{[\s\S]*position:\s*sticky;/);
assert.match(css, /@media print\s*\{[\s\S]*background:\s*#ffffff\s*!important;/);
assert.match(css, /tr\[aria-selected="true"\][\s\S]*background:\s*#ffffff\s*!important;/,
  'print output must suppress selected-row paint');

const js = fs.readFileSync(path.join(root, 'nexus/common/nexus-table-ux.js'), 'utf8');
for (const contract of [
  'nexus:table-widths:', 'separator', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
  "['ArrowLeft', 'ArrowRight', 'Home', 'End']", 'navigator.clipboard?.writeText',
  'nexus-table-column-tool', '표 검색·열 필터·정렬', '현재 표 검색', '현재 열 값 찾기',
  'data-sort="asc"', 'data-sort="desc"', 'data-reset-all', 'state.filters',
  'localeCompare', 'Date.parse', 'nexus-table-filtered-out', 'nexus-table-no-results',
  "['ArrowDown', 'ArrowUp', 'Enter', 'Escape']", 'hasReactOwner', 'dataset.nexusCommonTools',
  'new MutationObserver(refresh)',
]) assert.ok(js.includes(contract), `common table behavior missing ${contract}`);
assert.match(js, /resizeExcludedApps = new Set\(\['smart-input', 'orderops', 'merchops', 'dataops'\]\)/,
  'common resizing must not compete with app-owned table resize contracts');
assert.match(js, /table\.matches\('\.column-width-managed'\)/,
  'common column tools must not compete with OrderOps native filter and sort menus');

const smartInputHtml = fs.readFileSync(path.join(root, 'smartinput/index.html'), 'utf8');
assert.doesNotMatch(smartInputHtml, /nexus-workbench-layout-v2/,
  'SmartInput restored three-area layout must remain outside the common panel controller');

console.log('NEXUS common table UX contracts passed.');
