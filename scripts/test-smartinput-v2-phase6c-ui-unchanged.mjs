#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_SHA = '9c47d3c412235be593f11389353555d5a3d5b532';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const normalizedText = value => String(value).replace(/\r\n/g, '\n').trimEnd();
const productUiDiff = git('diff', '--name-only', BASE_SHA, '--', 'smartinput', 'orderops')
  .split(/\r?\n/).filter(Boolean);
assert.deepEqual(productUiDiff, [], 'Phase 6C must have zero SmartInput and OrderOps product UI diff');

const orderqDb = readFileSync(resolve(root, 'orderq/orderq-db.js'), 'utf8');
assert.equal(normalizedText(orderqDb), normalizedText(git('show', `${BASE_SHA}:orderq/orderq-db.js`)),
  'ORDER Q DB schema/version must remain byte-identical');
const adapter = readFileSync(resolve(root, 'orderq/official-command-adapter.js'), 'utf8');
assert.equal(adapter.includes('official-voucher-repository'), false,
  'the public command Adapter must not import the raw Repository');
assert.match(adapter, /commitInventoryRematchCommand: command => gateway\.executeInventoryRematch\(command\)/);
const sync = readFileSync(resolve(root, 'orderq/official-voucher-sync.js'), 'utf8');
assert.match(sync, /OfficialCommandGateway\.applyRemoteInventoryResolutionPayload/,
  'legacy remote resolution replay must cross the owner Gateway');
const repository = readFileSync(resolve(root, 'orderq/official-voucher-repository.js'), 'utf8');
assert.match(repository, /throw new Error\('ORDERQ_REMATCH_OWNER_GATEWAY_REQUIRED'\)/,
  'the former raw local rematch writer must fail closed');
assert.match(repository, /db\.transaction\(stores, 'readwrite'\)/,
  'the owner writer must use one declared DB v7 transaction');
assert.equal(repository.includes("status: 'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE'"), false,
  'the 6C writer must not silently omit checkpoint-conflicted inventory');

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-06C', status: 'PASS', base: BASE_SHA,
  productUiDiff, orderqDbSchemaDiff: 0, adapterToGateway: true,
  rawRepositoryRematchWrite: false, remoteReplayToGateway: true
}, null, 2));
