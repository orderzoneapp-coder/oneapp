import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const code = readFileSync(new URL('../code.gs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

assert.equal(hash(extract(code, 'const DATAOPS_SNAPSHOT_FORMAT', 'const SHIPPING_PLAN_FORMAT')), 'ea2746ac6d22e5722d7bc27357595b21fde1fa60661c44d7f91b065a427a2ea7');
assert.equal(hash(extract(code, 'function validateDataOpsSnapshotEnvelope', '// [POST] 클라이언트 데이터 수신')), '0cb33a61d104100a8046fe609a98c7772cde644fd6be6b158dcffbd6f1170004');
const legacyStart = code.lastIndexOf('    if (', code.indexOf('dataops_snapshot_commit'));
const legacyEnd = code.lastIndexOf('    if (', code.indexOf('initSync'));
assert.equal(hash(code.slice(legacyStart, legacyEnd)), 'bb96e3cbf5dccc5184aaaf39dd5f42efae623c8429630b6b7a09ee023e25c382');
assert.equal(hash(extract(html, 'const DATAOPS_MERCH_STOCK_SYNC_MODULE', 'const STORAGE_MODULE')), '8dfc6e2a8cf1bca0de58ba7c884d4736e0ffabc7b0c60cd13473095c7c2d3cba');
assert.match(code, /dataops_\(snapshot|v1_security|situation|close\)[\s\S]{0,500}oneappNexusLegacyUsageAudit\(payload, 'DATAOPS'/);
assert.match(code, /if \(action === 'dataops_snapshot_commit'\) \{\s*return withScriptLock/);
assert.match(code, /if \(action === 'dataops_snapshot_get'\) \{\s*return withScriptLock/);
console.log('DataOps Situation V2 legacy V1 exact tests passed');
