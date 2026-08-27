import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const code = readFileSync(new URL('../code.gs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

assert.equal(hash(extract(code, 'const DATAOPS_SNAPSHOT_FORMAT', 'const SHIPPING_PLAN_FORMAT')), '3e96f8e74a26a573759d1a1ed61b65ec9f26ccf7008407e9b082c029f16e0e59');
assert.equal(hash(extract(code, 'function validateDataOpsSnapshotEnvelope', '// [POST] 클라이언트 데이터 수신')), '92c4d7d9587502aed6aa37cdcda1dedc6b45dbd08883a1ea0b3d07b5adaf4a58');
const legacyStart = code.lastIndexOf('    if (', code.indexOf('dataops_snapshot_commit'));
const legacyEnd = code.lastIndexOf('    if (', code.indexOf('initSync'));
assert.equal(hash(code.slice(legacyStart, legacyEnd)), 'bb96e3cbf5dccc5184aaaf39dd5f42efae623c8429630b6b7a09ee023e25c382');
assert.equal(hash(extract(html, 'const DATAOPS_MERCH_STOCK_SYNC_MODULE', 'const STORAGE_MODULE')), 'adc579c10126193fa1fd7237af061e2605700f6affc528978a4b46b7ca288353');
assert.match(code, /if \(action === 'dataops_snapshot_commit'\) \{\s*return withScriptLock/);
assert.match(code, /if \(action === 'dataops_snapshot_get'\) \{\s*return withScriptLock/);
console.log('DataOps Situation V2 legacy V1 exact tests passed');
