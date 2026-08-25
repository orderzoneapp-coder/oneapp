import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baseEntities, configureAuthority, makeAuthority, snapshotInput, snapshotEnvelope, loadBrowserModule } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
configureAuthority(authority);
const frozenSchema = readFileSync(new URL('./fixtures/dataops-situation-read-v2.schema.json', import.meta.url));
assert.equal(createHash('sha256').update(frozenSchema).digest('hex'), 'def40f33fe69c0c6e3c5e0eb9a7b5fbb5b3279052ccade2597e63df28ad3c556');
const source = snapshotInput(authority.context);
const envelope = snapshotEnvelope(authority.context);
const built = authority.context.dataOpsSituationBuildSnapshot(authority.ss, { ...envelope, _serverScope: source.scope });
assert.equal(built.rows[0].signedBaseQuantity, -5);
assert.equal(built.rows[0].includedOrderQLedgerSequence, 7);
assert.match(built.rows[0].sourceRowDigest, /^[a-f0-9]{64}$/);
assert.deepEqual(Object.keys(built).sort(), ['manifest', 'rows']);

const browser = loadBrowserModule();
assert.deepEqual(JSON.parse(JSON.stringify(browser.DATAOPS_SITUATION_V2_MODULE.EXPECTED_DEPLOYMENT)), { deploymentId: '', deploymentVersion: '', gitCommit: '' });
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability({}).ready, false);
const browserBuilt = await browser.DATAOPS_SITUATION_V2_MODULE.buildSnapshot(source);
assert.equal(browserBuilt.snapshot.rows[0].sourceRowDigest, built.rows[0].sourceRowDigest, 'browser and Apps Script canonical row digest parity');
assert.deepEqual(JSON.parse(JSON.stringify(browserBuilt.snapshot)), JSON.parse(JSON.stringify(envelope.snapshot)));
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.canonical({ value: -0, name: '남경\r\n' }).value, 0);
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.canonical({ name: '남경\r\n' }).name, '남경\n');

const signs = await browser.DATAOPS_SITUATION_V2_MODULE.buildSnapshot({ ...source, snapshotId: 'SIGNS', rows: [
  { ...source.rows[0], rowId: 'NEG', signedBaseQuantity: -5, status: 'ACTIVE' },
  { ...source.rows[0], rowId: 'ZERO', signedBaseQuantity: 0, status: 'ACTIVE' },
  { ...source.rows[0], rowId: 'POS', signedBaseQuantity: 5, status: 'TOMBSTONED' }
] });
assert.equal(signs.snapshot.manifest.activeRowCount, 2);
assert.equal(signs.snapshot.manifest.tombstoneCount, 1);
assert.equal(signs.snapshot.manifest.rowCount, 3);
assert.match(signs.snapshot.manifest.pageManifestDigest, /^[a-f0-9]{64}$/);
assert.match(signs.snapshot.manifest.sourceDigest, /^[a-f0-9]{64}$/);
assert.throws(() => browser.DATAOPS_SITUATION_V2_MODULE.validateSnapshotSchema({ ...signs.snapshot, authorityHead: {} }), /DATAOPS_V2_SCHEMA_INVALID/);

const operational = browser.DATAOPS_SITUATION_V2_MODULE.buildOperationalSource({ operationalRows: [source.rows[0]],
  officialState: { authorityHead: source.authorityHead, movements: source.rows[0].sourceEvidence.map(item => ({ ...item,
    productId: 'P1', warehouseId: 'W1', baseUnit: 'EA' })) }, basisDate: source.basisDate, snapshotId: source.snapshotId,
  snapshotRevision: source.snapshotRevision, publishedAt: source.publishedAt, producer: source.producer, scope: source.scope });
assert.equal(operational.rows[0].sourceEvidence.length, 2, 'operational state adapter joins official movement evidence');
const productHtml = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8');
assert.match(productHtml, /DATAOPS_SITUATION_V2_OPERATOR_MODULE/);
assert.match(productHtml, /publishCurrent\(\{ productData, targetDateStr \}\)/);
assert.match(productHtml, /"상황자료 발행"/);
assert.match(productHtml, /disabled: isProcessing \|\| !window\.DATAOPS_SITUATION_V2_OPERATOR_MODULE\.releaseEnabled\(\)/);
assert.match(productHtml, /disabled: isProcessing \|\| !window\.DATAOPS_SITUATION_V2_OPERATOR_MODULE\.canPublish\(\{ productData, targetDateStr \}\)/);
assert.match(productHtml, /configured: \(\) => Boolean\(connection\)/);
assert.match(productHtml, /operationalSourceReady: context => api\(\)\.operationalSourceReady\(context\)/);
assert.doesNotMatch(productHtml, /saveWorkState[\s\S]{0,150}publishSituationV2/, 'V2 publish is never automatic or a V1 fallback');
console.log('DataOps Situation V2 producer tests passed');
