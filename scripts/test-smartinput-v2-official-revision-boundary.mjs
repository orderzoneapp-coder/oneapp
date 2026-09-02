#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_NAME, DB_VERSION, STORE } from '../orderq/orderq-db.js';
import { OFFICIAL_VOUCHER_REVISION_FEATURE_GATES } from '../orderq/official-command-gateway.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = path => readFileSync(join(root, path), 'utf8');
const productionFiles = directory => readdirSync(join(root, directory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? productionFiles(join(directory, entry.name))
    : /\.(?:html|js|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : []);

assert.equal(DB_NAME, 'oneapp-orderq-pre-m1-v6');
assert.equal(DB_VERSION, 7);
assert.equal(Object.values(STORE).includes('officialVoucherRevisionCommands'), false);
assert.deepEqual(OFFICIAL_VOUCHER_REVISION_FEATURE_GATES, {
  CORRECT_PURCHASE: false,
  CANCEL_PURCHASE: false,
  CORRECT_SALE: false,
  CANCEL_SALE: false
});

for (const file of [...productionFiles('smartinput'), ...productionFiles('orderops')]) {
  assert.doesNotMatch(source(file), /from\s+['"][^'"]*official-voucher-repository\.js/,
    `${file} must not import the raw official repository`);
}

const cloudSync = `${source('orderq/official-voucher-sync.js')}\n${source('orderq/orderq-sync-engine.js')}`;
assert.doesNotMatch(cloudSync, /['"]OFFICIAL_VOUCHER_REVISION_COMMAND['"]/,
  'revision queue entity must remain outside the Cloud allowlist');
assert.match(source('orderq/official-voucher-repository.js'),
  /entityType:\s*'OFFICIAL_VOUCHER_REVISION_COMMAND'[\s\S]*status:\s*'WAITING_SERVER_CONTRACT'/);

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-07A', status: 'PASS', db: `${DB_NAME}@${DB_VERSION}`,
  gates: OFFICIAL_VOUCHER_REVISION_FEATURE_GATES,
  rawRepositoryConsumerImports: 0, cloudAllowlistedRevisionEntities: 0
}, null, 2));
