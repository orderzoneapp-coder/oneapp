import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, makeAuthority, snapshotInput } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const publish = snapshot => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_publish', { ...credentials, snapshot });

for (const mutation of [
  snapshot => ({ ...snapshot, authorityHead: { ...snapshot.authorityHead, cursor: snapshot.authorityHead.cursor + 1 } }),
  snapshot => ({ ...snapshot, authorityHead: { ...snapshot.authorityHead, ledgerSequence: snapshot.authorityHead.ledgerSequence + 1 } }),
  snapshot => ({ ...snapshot, authorityHead: { ...snapshot.authorityHead, masterDigest: '0'.repeat(64) } }),
  snapshot => ({ ...snapshot, authorityHead: { ...snapshot.authorityHead, changeDigest: '0'.repeat(64) } }),
  snapshot => ({ ...snapshot, authorityHead: { ...snapshot.authorityHead, movementDigest: '0'.repeat(64) } }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, productMasterRevision: 99 })) }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, baseUnitRuleVersion: 'STALE' })) }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, includedOrderQLedgerSequence: 6 })) }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, sourceEvidence: row.sourceEvidence.slice(0, 1) })) }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, sourceEvidence: row.sourceEvidence.map(item => ({ ...item, effectKey: 'WRONG' })) })) }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, sourceEvidence: row.sourceEvidence.map(item => ({ ...item, movementRevision: 99 })) })) }),
  snapshot => ({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, sourceEvidence: row.sourceEvidence.map(item => ({ ...item, sourceEvidenceId: '0'.repeat(64) })) })) })
]) {
  const source = mutation(snapshotInput(authority.context));
  assert.throws(() => publish(source));
  assert.equal(authority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false, 'invalid authority input has mutation0');
}

const noMovementKey = snapshotInput(authority.context);
const head = authority.context.dataOpsSituationAuthorityHead(authority.ss, new Set(['P2']), new Set(['W2']));
noMovementKey.authorityHead = { cursor: head.cursor, ledgerSequence: head.ledgerSequence, masterDigest: head.masterDigest,
  changeDigest: head.changeDigest, movementDigest: head.movementDigest };
noMovementKey.rows = [{ ...noMovementKey.rows[0], productId: 'P2', productMasterRevision: 4, warehouseId: 'W2', warehouseMasterRevision: 5,
  includedOrderQLedgerSequence: 7, sourceEvidence: [] }];
assert.throws(() => publish(noMovementKey), /DATAOPS_V2_CUTOFF_REQUIRED/, 'global max cannot be copied to independent key');
assert.equal(authority.values.has('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), false);
console.log('DataOps Situation V2 cloud parity tests passed');
