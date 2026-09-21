import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The root URL is the restored original, not the modern Excel preparation UI.
// Modern UI contracts are retained against its historical HTML and CURRENT
// modern modules in an isolated test checkout. This is not a production route.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalRef = '13c83a23a330f3319ae67005f7ff0d67dfae4d54';
const modernRef = '67251bbb68b8cb12c1e70a88ae8cd326aa0807eb';
const pinned = 'orderops/stable/20260917';
const historical = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], {
  cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
}).replaceAll('\r\n', '\n');
const text = (file) => readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n');
const modernTests = new Set([
  'test-shipping-management.mjs', 'test-orderops-filter-intent.mjs',
  'test-orderops-work-preservation.mjs', 'test-orderops-excel-preparation.mjs',
  'test-orderops-excel-preparation-browser.mjs', 'test-orderops-inventory-movement-ui.mjs',
  'test-orderops-inventory-movement-browser.mjs',
  'test-orderops-heading-contrast-browser.mjs', 'test-orderops-print-grid-browser.mjs',
]);
const modernMode = process.argv[2] === '--modern';
const requested = process.argv.slice(3);
assert.ok(modernMode || process.argv.length === 2, 'Use no arguments, or --modern followed by retained test filenames');
if (modernMode) {
  assert.ok(requested.length > 0, 'Specify the retained modern tests to execute');
  requested.forEach((name) => assert.ok(modernTests.has(name), `Not an approved modern UI test: ${name}`));
}
const temp = mkdtempSync(join(tmpdir(), 'oneapp-orderops-contract-'));
const put = (name, contents) => {
  mkdirSync(dirname(join(temp, name)), { recursive: true });
  writeFileSync(join(temp, name), contents);
};
let childEnv = process.env;
const run = (name) => execFileSync(process.execPath, [join(temp, 'scripts', name)], {
  cwd: temp, stdio: 'inherit', env: childEnv,
  // The retained visual suites already allow 240 seconds for PDF/browser work.
  timeout: ['test-orderops-heading-contrast-browser.mjs', 'test-orderops-print-grid-browser.mjs'].includes(name) ? 260000 : 120000,
});
try {
  if (modernMode) {
    cpSync(root, temp, { recursive: true, filter: (source) =>
      !['.git', 'node_modules', 'evidence', 'test-artifacts'].includes(basename(source)) });
    put('orderops_list.html', historical(modernRef, 'orderops_list.html'));
    // These allowlisted tests only read historical CSS with git show. Keep that
    // baseline available without copying credentials or changing the checkout.
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
    childEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: temp, GIT_OPTIONAL_LOCKS: '0' };
    console.log(`Retained modern UI regression: frozen HTML ${modernRef.slice(0, 8)} + current modern modules; NOT the restored production root`);
    requested.forEach(run);
  } else {
    let expected = historical(originalRef, 'orderops_list.html');
    for (const [from, to] of [
      ['orderFulfillmentEngine.js?v=20260917-work-preservation', `/${pinned}/orderFulfillmentEngine.js`],
      ['orderFulfillmentWorkbook.js?v=20260916-baseline-calculation', `/${pinned}/orderFulfillmentWorkbook.js`],
    ]) {
      assert.equal(expected.split(from).length, 2, `Unique original dependency: ${from}`);
      expected = expected.replace(from, to);
    }
    assert.equal(text('orderops_list.html'), expected,
      'Restore the original ROOT screen exactly; only its two module URLs are changed');
    assert.ok(!expected.includes('excel-preparation'), 'The original must not depend on the modern preparation gate');
    put('orderops_list.html', text('orderops_list.html'));
    for (const name of ['orderFulfillmentEngine.js', 'orderFulfillmentWorkbook.js']) {
      assert.equal(text(`${pinned}/${name}`), historical(originalRef, name), `Frozen original module: ${name}`);
      put(name, text(`${pinned}/${name}`));
    }
    put('customer-master/vendor/xlsx.full.min.js', readFileSync(join(root, 'customer-master/vendor/xlsx.full.min.js')));
    for (const name of ['test-orderops-baseline-calculation.mjs', 'test-orderops-work-preservation.mjs']) {
      const source = historical(originalRef, `scripts/${name}`);
      put(`scripts/${name}`, source.replace('["orderops/list.html", "orderops_list.html"]', '["orderops_list.html"]').replaceAll('"orderops/list.html"', '"orderops_list.html"'));
      run(name);
    }
    console.log('PASS restored /orderops_list.html exact source, pinned modules, baseline calculations, failure preservation, recovery and export contracts');
  }
} finally {
  assert.equal(dirname(temp), resolve(tmpdir()));
  assert.ok(basename(temp).startsWith('oneapp-orderops-contract-'));
  rmSync(temp, { recursive: true, force: true });
}
