#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const sha256 = relativePath => crypto.createHash('sha256').update(read(relativePath).replace(/\r\n/g, '\n')).digest('hex');

const html = read('Master.html');
const source = read('nexus/master/master-app.jsx');
const compiled = read('nexus/master/master-app.js');
const component = read('nexus/common/nexus-top.js');
const compiledCss = read('nexus/master/master-app.css');

assert.ok(Buffer.byteLength(html) < 20_000, 'Master document shell must stay below 20 KB');
assert.ok(Buffer.byteLength(compiled) < 100_000, 'precompiled Master application must stay below 100 KB');
assert.ok(Buffer.byteLength(compiledCss) < 50_000, 'compiled Master Tailwind CSS must stay below 50 KB');

assert.doesNotMatch(html, /cdn\.tailwindcss\.com|@babel\/standalone|babel\.min\.js|text\/babel/i);
assert.doesNotMatch(html, /xlsx\.full\.min\.js|masterAddUpdate\.js/i, 'Excel-only dependencies must not block initial render');
assert.match(html, /master-app\.css\?v=20260828\.1/);
assert.match(html, /react-18\.2\.0\.production\.min\.js/);
assert.match(html, /react-dom-18\.2\.0\.production\.min\.js/);
assert.match(html, /master-app\.js\?v=20260828\.1/);
assert.match(html, /data-nexus-app-id="master" data-nexus-ready-strategy="app"/);

const authIndex = html.indexOf('/nexus/common/nexus-auth.js');
const backupIndex = html.indexOf('/nexus/foundation/foundation-backup.js');
const reactIndex = html.indexOf('/nexus/vendor/react-18.2.0.production.min.js');
const coreIndex = html.indexOf('/coreEngine.js');
const appIndex = html.indexOf('/nexus/master/master-app.js');
assert.ok(authIndex >= 0 && authIndex < reactIndex && reactIndex < coreIndex && coreIndex < appIndex,
  'authentication must initialize before deferred Master runtime dependencies');
assert.ok(authIndex < backupIndex && backupIndex < appIndex,
  'foundation backup must be deferred before the Master app runtime');
assert.match(html, /<script defer src="\/nexus\/foundation\/foundation-backup\.js\?v=1\.0\.0"><\/script>/);

assert.match(source, /MASTER_EXCEL_DEPENDENCIES/);
assert.match(source, /xlsx\/0\.18\.5\/xlsx\.full\.min\.js/);
assert.match(source, /masterExcelRuntimePromise = null/);
assert.match(source, /파일을 다시 선택하면 재시도합니다/);
assert.match(source, /window\.ONEAPP_AUTH\?\.ready/);
assert.match(source, /window\.dispatchEvent\(new CustomEvent\('nexus:app-ready'/);
assert.match(component, /dataset\.nexusReadyStrategy === 'app'/);
assert.match(component, /completeNavigation\('app-ready'\)/);
assert.match(component, /completeNavigation\('safety-timeout'\), 12000/);

const sourceHash = sha256('nexus/master/master-app.jsx');
assert.match(compiled, new RegExp(`/\\* master-app\\.jsx sha256: ${sourceHash} \\*/`),
  'compiled Master asset must identify the exact JSX source revision');
assert.match(compiled, /React\.createElement/);
assert.doesNotMatch(compiled, /<ErrorBoundary>|<App\s*\/>/, 'compiled Master asset must not retain JSX');

assert.equal(sha256('nexus/vendor/react-18.2.0.production.min.js'), '4b4969fa4ef3594324da2c6d78ce8766fbbc2fd121fff395aedf997db0a99a06');
assert.equal(sha256('nexus/vendor/react-dom-18.2.0.production.min.js'), '21758ed084cd0e37e735722ee4f3957ea960628a29dfa6c3ce1a1d47a2d6e4f7');

console.log('Master static boot, lazy Excel runtime, pinned React assets, and app-ready transition contracts passed.');
