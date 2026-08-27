import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const code = readFileSync(new URL('../code.gs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

assert.equal(hash(extract(code, 'const DATAOPS_SNAPSHOT_FORMAT', 'const SHIPPING_PLAN_FORMAT')), 'ea2746ac6d22e5722d7bc27357595b21fde1fa60661c44d7f91b065a427a2ea7');
assert.equal(hash(extract(code, 'function validateDataOpsSnapshotEnvelope', '// [POST] 클라이언트 데이터 수신')), 'adf5bc277fc825af0ea95fac266ff728e970c71a08c388932258214bfdaa258e');
const legacyStart = code.lastIndexOf('    if (', code.indexOf('dataops_snapshot_commit'));
const legacyEnd = code.lastIndexOf('    if (', code.indexOf('initSync'));
assert.equal(hash(code.slice(legacyStart, legacyEnd)), '08df683b923b7c524bfef473e9fc1f869c4f0d2920df34e0dac1a33b68cd92da');
assert.equal(hash(extract(html, 'const DATAOPS_MERCH_STOCK_SYNC_MODULE', 'const STORAGE_MODULE')), '23c9df7c4727894a7e97d48b0f999705fad64a3f75d4b9318be9570c3c03e284');
assert.match(code, /dataops_\(snapshot|v1_security|situation|close\)[\s\S]{0,500}oneappNexusLegacyUsageAudit\(payload, 'DATAOPS'/);
assert.match(code, /if \(action === 'dataops_snapshot_commit'\) \{\s*return withScriptLock/);
assert.match(code, /if \(action === 'dataops_snapshot_get'\) \{\s*return withScriptLock/);
console.log('DataOps Situation V2 legacy V1 exact tests passed');
