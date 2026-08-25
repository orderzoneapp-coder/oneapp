import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, makeAuthority, snapshotInput } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const publish = snapshot => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_publish', { ...credentials, snapshot });
const first = publish(snapshotInput(authority.context, { snapshotId: 'SNAP-1' }));
const firstPointer = JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'));
assert.equal(firstPointer.slot, 'A');
assert.equal(publish(snapshotInput(authority.context, { snapshotId: 'SNAP-1' })).snapshotRevision, first.snapshotRevision, 'response loss retry reuses revision');
assert.throws(() => publish(snapshotInput(authority.context, { snapshotId: 'SNAP-1', row: { signedBaseQuantity: -6 } })), /DATAOPS_V2_PUBLISH_CONFLICT/);
assert.equal(JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotRevision, firstPointer.snapshotRevision);

const session = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
const second = publish(snapshotInput(authority.context, { snapshotId: 'SNAP-2', row: { signedBaseQuantity: 0 } }));
assert.notEqual(second.snapshotRevision, first.snapshotRevision);
assert.equal(JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).slot, 'B');
assert.throws(() => publish(snapshotInput(authority.context, { snapshotId: 'SNAP-3', row: { signedBaseQuantity: 5 } })), /DATAOPS_V2_SLOT_PINNED/);
assert.equal(JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotId, 'SNAP-2');
assert.equal(session.slot, 'A');

const recovery = makeAuthority({ entities: baseEntities() });
const recoveryCredentials = configureAuthority(recovery);
const recoveryPublish = snapshot => recovery.context.dataOpsSituationHandleAction(recovery.ss, 'situation_dataops_publish', { ...recoveryCredentials, snapshot });
recoveryPublish(snapshotInput(recovery.context, { snapshotId: 'RECOVERY-1' }));
const stablePointer = recovery.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER');
const originalAudit = recovery.context.dataOpsSituationAudit;
recovery.context.dataOpsSituationAudit = () => { throw new Error('AUDIT_FAILURE_INJECTED'); };
assert.throws(() => recoveryPublish(snapshotInput(recovery.context, { snapshotId: 'RECOVERY-2' })), /AUDIT_FAILURE_INJECTED/);
assert.equal(recovery.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), stablePointer, 'audit failure leaves current pointer unchanged');
recovery.context.dataOpsSituationAudit = originalAudit;
console.log('DataOps Situation V2 storage and recovery tests passed');
