#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'scripts/test-smartparser-analysis-result.mjs',
  'scripts/test-smartparser-product-request-boundary.mjs',
  'scripts/test-smartparser-stop-command-adapter.mjs',
  'scripts/test-smartparser-supplier-stop-20260804-01.mjs',
  'scripts/test-oneapp-parser-wh-20260802-01.mjs',
  'scripts/test-smartparser-owner-boundaries.mjs',
  'scripts/test-reference-data-contract.mjs',
];

for (const test of tests) {
  const result = spawnSync(process.execPath, [join(ROOT, test)], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`PASS test-smartparser-all (${tests.length} sequential tests)`);
