import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The operational fallback is intentionally frozen. Modern Excel workbench
// tests exercise orderops_list.html; these tests exercise the restored route.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = '13c83a23a330f3319ae67005f7ff0d67dfae4d54';
const pinned = 'orderops/stable/20260917';
const historical = (file) => execFileSync('git', ['show', `${baseline}:${file}`], {
  cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
});
const expectedHtml = historical('orderops/list.html')
  .replace('../orderFulfillmentEngine.js?v=20260917-work-preservation', 'stable/20260917/orderFulfillmentEngine.js')
  .replace('../orderFulfillmentWorkbook.js?v=20260916-baseline-calculation', 'stable/20260917/orderFulfillmentWorkbook.js');
assert.equal(readFileSync(join(root, 'orderops/list.html'), 'utf8').replaceAll('\r\n', '\n'), expectedHtml.replaceAll('\r\n', '\n'),
  'The operational fallback must remain the approved baseline; ORDER Q development must not update it implicitly');
for (const name of ['orderFulfillmentEngine.js', 'orderFulfillmentWorkbook.js']) {
  assert.equal(readFileSync(join(root, pinned, name), 'utf8').replaceAll('\r\n', '\n'), historical(name).replaceAll('\r\n', '\n'),
    `${name}: the fallback must load its matching frozen module`);
}

// Reuse the baseline's behavioral tests against the actual restored source,
// without temporarily replacing files in the checkout or touching user data.
const temp = mkdtempSync(join(tmpdir(), 'orderops-stable-check-'));
const put = (name, data) => {
  const target = join(temp, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
};
try {
  put('orderops/list.html', readFileSync(join(root, 'orderops/list.html')));
  for (const name of ['orderFulfillmentEngine.js', 'orderFulfillmentWorkbook.js']) put(name, readFileSync(join(root, pinned, name)));
  put('customer-master/vendor/xlsx.full.min.js', readFileSync(join(root, 'customer-master/vendor/xlsx.full.min.js')));
  for (const name of ['test-orderops-baseline-calculation.mjs', 'test-orderops-work-preservation.mjs']) {
    put(`scripts/${name}`, historical(`scripts/${name}`).replace('["orderops/list.html", "orderops_list.html"]', '["orderops/list.html"]'));
    execFileSync(process.execPath, [join(temp, 'scripts', name)], { cwd: temp, stdio: 'inherit', timeout: 60000 });
  }
  console.log('PASS frozen OrderOps source, pinned modules, calculation, source-read failure preservation and recovery/export contracts');
} finally {
  assert.equal(dirname(temp), resolve(tmpdir()));
  rmSync(temp, { recursive: true, force: true });
}
