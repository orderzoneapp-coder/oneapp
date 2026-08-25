#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createReferenceDiagnostics,
  REFERENCE_PHASE,
  runReferencePhase
} from '../smartinput/reference-diagnostics.js';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const emitted = [];
let clock = 100;
const diagnostics = createReferenceDiagnostics({ logger: event => emitted.push(event), now: () => clock });

const common = diagnostics.start(REFERENCE_PHASE.COMMON_PRODUCT, 'MERCHOPS_DB_OR_SNAPSHOT');
clock = 112.4;
common.end(4352);
assert.deepEqual(emitted, [
  { phase: 'COMMON_PRODUCT', state: 'START', source: 'MERCHOPS_DB_OR_SNAPSHOT', elapsedMs: 0, count: 0 },
  { phase: 'COMMON_PRODUCT', state: 'END', source: 'MERCHOPS_DB_OR_SNAPSHOT', elapsedMs: 12, count: 4352 }
]);

clock = 200;
await assert.rejects(runReferencePhase(
  diagnostics,
  REFERENCE_PHASE.SHIPPING,
  'ORDERQ_DB',
  async () => { clock = 5201; throw new Error('창고 기준자료 로딩 시간 초과 https://secret.invalid/?token=secret'); }
), /시간 초과/);
assert.equal(emitted.at(-1).state, 'TIMEOUT');

await runReferencePhase(
  diagnostics,
  REFERENCE_PHASE.SETTINGS,
  'SMARTINPUT_DB',
  async () => ({ settings: {} }),
  value => Number(Boolean(value))
);
assert.equal(emitted.at(-1).count, 1);

clock = 6000;
diagnostics.start(REFERENCE_PHASE.ORDERQ_PRODUCT, 'ORDERQ_DB');
clock = 13001;
assert.equal(diagnostics.timeoutActive([REFERENCE_PHASE.COMMON_PRODUCT, REFERENCE_PHASE.ORDERQ_PRODUCT]), REFERENCE_PHASE.ORDERQ_PRODUCT);
assert.equal(emitted.at(-1).state, 'TIMEOUT');

for (const event of emitted) {
  assert.deepEqual(Object.keys(event), ['phase', 'state', 'source', 'elapsedMs', 'count']);
  assert.equal(JSON.stringify(event).includes('secret'), false);
  assert.equal(JSON.stringify(event).includes('http'), false);
  assert.equal(JSON.stringify(event).includes('token'), false);
}

const appSource = read('smartinput/smartinput.js');
const productSource = read('orderq/product-master-search.js');
const customerSource = read('smartinput/reference-bootstrap.js');
assert.match(appSource, /reference-diagnostics\.js\?v=0\.1\.0/);
assert.match(appSource, /async function loadProductReferences\(\)[\s\S]*loadProductCatalog\(\{ diagnostics: referenceDiagnostics, referencePhase: REFERENCE_PHASE \}\)[\s\S]*timeoutActive/);
assert.match(appSource, /runReferencePhase\(referenceDiagnostics, REFERENCE_PHASE\.SHIPPING, 'ORDERQ_DB'/);
assert.match(appSource, /runReferencePhase\(referenceDiagnostics, REFERENCE_PHASE\.SETTINGS, 'SMARTINPUT_DB'/);
assert.match(productSource, /COMMON_PRODUCT[\s\S]*MERCHOPS_DB_OR_SNAPSHOT/);
assert.match(productSource, /ORDERQ_PRODUCT[\s\S]*ORDERQ_DB/);
assert.match(customerSource, /CUSTOMER_MASTER/);
assert.match(customerSource, /ORDERQ_CLOUD_CUSTOMER_MASTER/);
assert.match(customerSource, /ORDERQ_LOCAL_CACHE/);
assert.doesNotMatch(read('smartinput/reference-diagnostics.js'), /localStorage|sessionStorage|getCloudUrl|accessToken|customerName|itemName/);

console.log(`SmartInput reference diagnostics tests passed (${emitted.length} events)`);
