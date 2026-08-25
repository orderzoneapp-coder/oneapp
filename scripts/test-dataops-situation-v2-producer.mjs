import assert from 'node:assert/strict';
import { baseEntities, makeAuthority, snapshotInput, loadBrowserModule } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const source = snapshotInput(authority.context);
const built = authority.context.dataOpsSituationBuildSnapshot(authority.ss, { snapshot: source });
assert.equal(built.rows[0].signedBaseQuantity, -5);
assert.equal(built.rows[0].includedOrderQLedgerSequence, 7);
assert.deepEqual([...built.rows[0].sourceEvidence].map(row => row.movementId), ['M1', 'M2']);
assert.match(built.rows[0].rowDigest, /^[a-f0-9]{64}$/);

const browser = loadBrowserModule();
assert.deepEqual(JSON.parse(JSON.stringify(browser.DATAOPS_SITUATION_V2_MODULE.EXPECTED_DEPLOYMENT)), { deploymentId: '', deploymentVersion: '', gitCommit: '' });
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.evaluateCapability({}).ready, false);
const browserBuilt = await browser.DATAOPS_SITUATION_V2_MODULE.buildSnapshot(source);
assert.equal(browserBuilt.rows[0].rowDigest, built.rows[0].rowDigest, 'browser and Apps Script canonical row digest parity');
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.canonical({ value: -0, name: '남경\r\n' }).value, 0);
assert.equal(browser.DATAOPS_SITUATION_V2_MODULE.canonical({ name: '남경\r\n' }).name, '남경\n');
console.log('DataOps Situation V2 producer tests passed');
