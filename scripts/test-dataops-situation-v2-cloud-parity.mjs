import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, makeAuthority, snapshotEnvelope } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const publish = envelope => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_publish', { ...credentials, ...envelope });
const clone = value => structuredClone(value);
const base = snapshotEnvelope(authority.context);
const mutations = [];
for (const field of ['cursor', 'ledgerSequence']) mutations.push(value => { value.producerEvidence.authorityHead[field] += 1; });
for (const field of ['masterDigest', 'changeDigest', 'movementDigest']) mutations.push(value => { value.producerEvidence.authorityHead[field] = '0'.repeat(64); });
mutations.push(value => { value.snapshot.rows[0].productMasterRevision = 99; });
mutations.push(value => { value.snapshot.rows[0].baseUnitRuleVersion = 'STALE'; });
mutations.push(value => { value.snapshot.rows[0].includedOrderQLedgerSequence = 6; });
mutations.push(value => { value.producerEvidence.rows[0].sourceEvidence = value.producerEvidence.rows[0].sourceEvidence.slice(0, 1); });
mutations.push(value => { value.producerEvidence.rows[0].sourceEvidence[0].effectKey = 'WRONG'; });
mutations.push(value => { value.producerEvidence.rows[0].sourceEvidence[0].movementRevision = 99; });
mutations.push(value => { value.producerEvidence.rows[0].sourceEvidence[0].sourceEvidenceId = '0'.repeat(64); });
for (const mutate of mutations) {
  const value = clone(base); mutate(value);
  assert.throws(() => publish(value));
  assert.equal(authority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false, 'invalid authority input has mutation0');
}

const head = authority.context.dataOpsSituationAuthorityHead(authority.ss, new Set(['P2']), new Set(['W2']));
const noMovementKey = snapshotEnvelope(authority.context, { authorityHead: { cursor: head.cursor, ledgerSequence: head.ledgerSequence,
  masterDigest: head.masterDigest, changeDigest: head.changeDigest, movementDigest: head.movementDigest },
row: { productId: 'P2', productMasterRevision: 4, warehouseId: 'W2', warehouseMasterRevision: 5,
  includedOrderQLedgerSequence: 7, sourceEvidence: [] } });
assert.throws(() => publish(noMovementKey), /DATAOPS_V2_CUTOFF_REQUIRED/, 'global max cannot be copied to independent key');
assert.equal(authority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false);

for (const [name, matcher, forcedBytes, expected] of [
  ['row', value => value.startsWith('{') && value.includes('"rowId"') && !value.includes('"manifest"'), 65537, /DATAOPS_V2_ROW_LIMIT/],
  ['page', value => value.startsWith('['), 524289, /DATAOPS_V2_PAGE_LIMIT/],
  ['snapshot', value => value.startsWith('{') && value.includes('"manifest"'), 16777217, /DATAOPS_V2_SNAPSHOT_LIMIT/]
]) {
  const limited = makeAuthority({ entities: baseEntities() });
  const limitedCredentials = configureAuthority(limited);
  const originalBytes = limited.context.dataOpsSituationUtf8Bytes;
  limited.context.dataOpsSituationUtf8Bytes = value => matcher(String(value)) ? forcedBytes : originalBytes(value);
  assert.throws(() => limited.context.dataOpsSituationHandleAction(limited.ss, 'situation_dataops_publish', {
    ...limitedCredentials, ...snapshotEnvelope(limited.context)
  }), expected, `${name} byte limit is enforced by production validator`);
  assert.equal(limited.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false);
}
console.log('DataOps Situation V2 cloud parity tests passed');
