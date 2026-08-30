import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'test-merchops-column-resize-performance.mjs',
  'test-merchops-common-excel-routing.mjs',
  'test-merchops-direct-info.mjs',
  'test-merchops-f8-xlsx-e2e.mjs',
  'test-merchops-master-reference-isolation.mjs',
  'test-merchops-master-theme-filter-layout.mjs',
  'test-merchops-promo-catalog-compare-xlsx-e2e.mjs',
  'test-merchops-promo-catalog-compare.mjs',
  'test-merchops-sale-pipeline.mjs',
  'test-merchops-shared-storage.mjs',
  'test-merchops-spot-price.mjs',
  'test-merchops-storage-atomicity.mjs',
  'test-merchops-owner-boundaries.mjs',
  'test-smartparser-supplier-stop-20260804-01.mjs',
  'test-reference-data-contract.mjs',
  'test-master-add-update.mjs',
];

const failures = [];
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', test)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status === 0) {
    process.stdout.write(`PASS ${test}\n`);
    continue;
  }
  failures.push(test);
  process.stderr.write(`FAIL ${test}\n${result.stdout || ''}${result.stderr || ''}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`MerchOps suite failed: ${failures.join(', ')}\n`);
  process.exit(1);
}

console.log(`MerchOps complete suite passed (${tests.length} scripts).`);
