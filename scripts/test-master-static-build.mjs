import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const html = read('Master.html');
const source = read('master/master-app.jsx');
const generated = read('master/master-app.js');
const css = read('master/master.css');
const packageJson = JSON.parse(read('package.json'));

assert.match(html, /<link rel="stylesheet" href="\.\/master\/master\.css\?v=1\.0\.0">/);
assert.match(html, /<script src="\.\/master\/master-app\.js\?v=1\.0\.0"><\/script>/);
assert.doesNotMatch(html, /cdn\.tailwindcss\.com|@babel\/standalone|text\/babel|window\.Babel/);
assert.ok(html.indexOf('master/master.css') < html.indexOf('master/master-app.js'), 'generated styles must load before the app');

assert.match(source, /root\.render\(<ErrorBoundary><App \/><\/ErrorBoundary>\)/);
assert.doesNotMatch(generated, /<ErrorBoundary>|<App \/>/, 'committed runtime must not contain JSX');
assert.match(generated, /React\.createElement\(ErrorBoundary/);
assert.match(generated, /ONEAPP_MASTER_ADD_UPDATE\.commitApprovedChanges/);

for (const selector of [
  '.bg-indigo-50',
  '.bg-rose-50',
  '.text-rose-700',
  '.disabled\\:opacity-40',
  '.hover\\:bg-indigo-50',
  '.sm\\:w-auto'
]) {
  assert.ok(css.includes(selector), `generated Master CSS must include ${selector}`);
}
assert.match(css, /tailwindcss v3\.4\.17/);

assert.equal(packageJson.packageManager, 'pnpm@11.19.0');
assert.equal(packageJson.devDependencies['@babel/core'], '7.24.7');
assert.equal(packageJson.devDependencies['@babel/cli'], '7.24.7');
assert.equal(packageJson.devDependencies['@babel/preset-react'], '7.24.7');
assert.equal(packageJson.devDependencies.tailwindcss, '3.4.17');
assert.ok(packageJson.scripts['check:master-build'].includes('git diff --exit-code'));

console.log('Master static Babel and Tailwind build contracts passed.');
