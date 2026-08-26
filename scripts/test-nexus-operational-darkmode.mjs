#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const operationalCss = read('nexus/common/nexus-operational-theme.css');
const tokenCss = read('nexus/common/oneapp-design-tokens.css');

const maintainedPages = [
  ['orders.html', 'orderq'],
  ['orderops_list.html', 'orderq'],
  ['orderops/list.html', 'orderq'],
  ['DataOps.html', 'dataops'],
  ['MerchOps.html', 'merchops'],
];

for (const [file, app] of maintainedPages) {
  const source = read(file);
  assert.match(source, new RegExp(`<html[^>]+data-nexus-app="${app}"`), `${file} must opt into its maintained application scope`);
  assert.match(source, /\/nexus\/common\/nexus-theme-init\.js/);
  assert.match(source, /\/nexus\/common\/oneapp-design-tokens\.css/);
  assert.match(source, /\/nexus\/common\/nexus-operational-theme\.css\?v=1\.0\.\d+/);
  assert.ok(source.indexOf('nexus-theme-init.js') < source.indexOf('<style'), `${file} must resolve the saved theme before first-paint styles`);
  const tailwindIndex = source.indexOf('cdn.tailwindcss.com');
  if (tailwindIndex >= 0) {
    assert.ok(source.indexOf('nexus-theme-init.js') < tailwindIndex, `${file} must resolve the saved theme before Tailwind`);
  }
  assert.ok(source.indexOf('nexus-operational-theme.css') < source.indexOf('</head>'), `${file} must load operational theme CSS in the document head`);
}

const digest = (source) => crypto.createHash('sha256').update(source).digest('hex');
assert.equal(digest(read('orders.html')), digest(read('orderops_list.html')), 'the public ORDER Q document and root mirror must remain byte-identical');

for (const app of ['orderq', 'dataops', 'merchops']) {
  assert.match(operationalCss, new RegExp(`data-nexus-theme="dark"\\]\\[data-nexus-app="${app}"`), `${app} needs an explicit dark-only consumer scope`);
}

for (const contract of [
  /--white:\s*var\(--nexus-panel-bg\)/,
  /background-color:\s*var\(--nexus-page-bg\)/,
  /\[class~="bg-white"\]/,
  /:is\(input, select, textarea\)/,
  /#initial-loader/,
  /tr\.shortage-candidate-row td/,
  /\[class~="!bg-indigo-100\/70"\]/,
  /@media print/,
  /color-scheme:\s*light/,
]) {
  assert.match(operationalCss, contract);
}

assert.doesNotMatch(operationalCss, /prefers-color-scheme|data-nexus-theme="system"|matchMedia/,
  'the corrective consumer must remain a two-mode Light/Dark implementation');
assert.doesNotMatch(operationalCss, /filter\s*:\s*invert|backdrop-filter|mix-blend-mode/,
  'visual inversion and page overlays are forbidden');
assert.doesNotMatch(operationalCss, /(^|})\s*(?:body|\.bg-white|\[class~="bg-white"\])\s*\{/m,
  'compatibility selectors must never escape application and dark-theme scope');

const importantDeclarations = [...operationalCss.matchAll(/!important/g)].length;
assert.ok(importantDeclarations <= 16, `scoped legacy compatibility must keep !important use narrow (found ${importantDeclarations})`);

const cssVariables = (selector) => {
  const start = tokenCss.indexOf(selector);
  assert.ok(start >= 0, `missing ${selector}`);
  const open = tokenCss.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < tokenCss.length; index += 1) {
    if (tokenCss[index] === '{') depth += 1;
    if (tokenCss[index] === '}') depth -= 1;
    if (depth === 0) {
      return Object.fromEntries([...tokenCss.slice(open + 1, index).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]));
    }
  }
  throw new Error(`unterminated ${selector}`);
};
const luminance = (hex) => {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (first, second) => {
  const [bright, dark] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (bright + 0.05) / (dark + 0.05);
};
const darkTokens = cssVariables('html[data-nexus-theme="dark"]');

const maintainedScope = operationalCss.match(/html\[data-nexus-theme="dark"\]\[data-nexus-app="orderq"\],[\s\S]*?\{([\s\S]*?)\n\}/);
assert.ok(maintainedScope, 'Maintained apps need a shared low-chroma dark palette');
for (const token of [
  '--nexus-info', '--nexus-info-bg', '--nexus-accent', '--nexus-accent-bg',
  '--nexus-cyan', '--nexus-cyan-bg', '--nexus-orange', '--nexus-orange-bg'
]) {
  assert.match(maintainedScope[1], new RegExp(`${token}:\\s*#[0-9a-f]{6}`, 'i'), `Maintained palette must define ${token}`);
}
const contrastEvidence = [
  ['nexus-text', 'nexus-page-bg'],
  ['nexus-text', 'nexus-panel-bg'],
  ['nexus-text-muted', 'nexus-panel-bg'],
].map(([foreground, background]) => {
  const ratio = contrast(darkTokens[foreground], darkTokens[background]);
  assert.ok(ratio >= 4.5, `${foreground}/${background} contrast ${ratio.toFixed(2)} must meet WCAG AA`);
  return `${foreground}/${background}=${ratio.toFixed(2)}:1`;
});

const browserFixture = read('scripts/test-nexus-operational-darkmode-browser.html');
assert.match(browserFixture, /getComputedStyle/);
assert.match(browserFixture, /Light → Dark → Light/);
assert.match(browserFixture, /dynamic-modal/);
assert.match(browserFixture, /NEXUS_DARKMODE_FIXTURE_RESULT/);
assert.doesNotMatch(browserFixture, /fetch\(|XMLHttpRequest|\.submit\(/,
  'the browser fixture must remain fully read-only and make no network writes');

const smartInputSource = read('smartinput/index.html');
assert.doesNotMatch(smartInputSource, /nexus-operational-theme\.css/,
  'SmartInput owns its mobile layout and must not consume the corrective application stylesheet');

console.log(`NEXUS operational dark-mode contracts passed. ${contrastEvidence.join(', ')}; scoped !important=${importantDeclarations}.`);
