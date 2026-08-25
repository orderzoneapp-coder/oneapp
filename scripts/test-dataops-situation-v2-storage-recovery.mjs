import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, makeAuthority, snapshotEnvelope } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const publish = envelope => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_publish', { ...credentials, ...envelope });
const first = publish(snapshotEnvelope(authority.context, { snapshotId: 'SNAP-1', snapshotRevision: 1 }));
const firstPointer = JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'));
assert.equal(firstPointer.slot, 'A');
assert.equal(publish(snapshotEnvelope(authority.context, { snapshotId: 'SNAP-1', snapshotRevision: 1 })).manifest.snapshotRevision, first.manifest.snapshotRevision, 'response loss retry reuses revision');
assert.throws(() => publish(snapshotEnvelope(authority.context, { snapshotId: 'SNAP-1', snapshotRevision: 2, row: { signedBaseQuantity: -6 } })), /DATAOPS_V2_PUBLISH_CONFLICT/);
assert.equal(JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotRevision, firstPointer.snapshotRevision);

const session = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
const second = publish(snapshotEnvelope(authority.context, { snapshotId: 'SNAP-2', snapshotRevision: 2, row: { signedBaseQuantity: 0 } }));
assert.notEqual(second.manifest.snapshotRevision, first.manifest.snapshotRevision);
assert.equal(JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).slot, 'B');
assert.throws(() => publish(snapshotEnvelope(authority.context, { snapshotId: 'SNAP-3', snapshotRevision: 3, row: { signedBaseQuantity: 5 } })), /DATAOPS_V2_SLOT_PINNED/);
assert.equal(JSON.parse(authority.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotId, 'SNAP-2');
assert.equal(session.slot, 'A');

const recovery = makeAuthority({ entities: baseEntities() });
const recoveryCredentials = configureAuthority(recovery);
const recoveryPublish = envelope => recovery.context.dataOpsSituationHandleAction(recovery.ss, 'situation_dataops_publish', { ...recoveryCredentials, ...envelope });
recoveryPublish(snapshotEnvelope(recovery.context, { snapshotId: 'RECOVERY-1', snapshotRevision: 1 }));
const stablePointer = recovery.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER');
const originalAudit = recovery.context.dataOpsSituationAudit;
recovery.context.dataOpsSituationAudit = () => { throw new Error('AUDIT_FAILURE_INJECTED'); };
assert.throws(() => recoveryPublish(snapshotEnvelope(recovery.context, { snapshotId: 'RECOVERY-2', snapshotRevision: 2 })), /AUDIT_FAILURE_INJECTED/);
assert.equal(recovery.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), stablePointer, 'audit failure leaves current pointer unchanged');
recovery.context.dataOpsSituationAudit = originalAudit;

const rollback = makeAuthority({ entities: baseEntities() });
const rollbackCredentials = configureAuthority(rollback);
const rollbackPublish = envelope => rollback.context.dataOpsSituationHandleAction(rollback.ss, 'situation_dataops_publish', { ...rollbackCredentials, ...envelope });
rollbackPublish(snapshotEnvelope(rollback.context, { snapshotId: 'ROLLBACK-1', snapshotRevision: 1 }));
rollbackPublish(snapshotEnvelope(rollback.context, { snapshotId: 'ROLLBACK-2', snapshotRevision: 2, row: { signedBaseQuantity: 0 } }));
const rollbackAuth = rollback.context.dataOpsSituationRequireAuth(rollbackCredentials, 'DATAOPS_SITUATION_PUBLISH', rollback.properties);
assert.throws(() => rollback.context.dataOpsSituationRollbackInternal(rollback.ss,
  { expectedCurrentRevision: 1, reason: 'wrong revision' }, rollbackAuth, rollback.properties), /DATAOPS_V2_ROLLBACK_PRECONDITION_FAILED/);
const rolledBack = rollback.context.dataOpsSituationRollbackInternal(rollback.ss,
  { expectedCurrentRevision: 2, reason: 'operator verified rollback' }, rollbackAuth, rollback.properties);
assert.equal(rolledBack.snapshotId, 'ROLLBACK-1');
assert.equal(JSON.parse(rollback.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER')).snapshotId, 'ROLLBACK-1');
assert.equal(rollback.context.dataOpsSituationCurrentSnapshot(rollback.ss, rollback.properties).snapshot.manifest.snapshotId, 'ROLLBACK-1');

for (const failedSheet of ['DataOpsSituationV2_Temp', 'DataOpsSituationV2_B']) {
  const fault = makeAuthority({ entities: baseEntities() });
  const faultCredentials = configureAuthority(fault);
  fault.context.dataOpsSituationHandleAction(fault.ss, 'situation_dataops_publish', { ...faultCredentials,
    ...snapshotEnvelope(fault.context, { snapshotId: 'FAULT-1', snapshotRevision: 1 }) });
  const pointerBefore = fault.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER');
  const originalRead = fault.context.dataOpsSituationReadSlot;
  fault.context.dataOpsSituationReadSlot = (ss, sheetName) => {
    if (sheetName === failedSheet) throw new Error('READBACK_FAILURE_INJECTED');
    return originalRead(ss, sheetName);
  };
  assert.throws(() => fault.context.dataOpsSituationHandleAction(fault.ss, 'situation_dataops_publish', { ...faultCredentials,
    ...snapshotEnvelope(fault.context, { snapshotId: 'FAULT-2', snapshotRevision: 2 }) }), /READBACK_FAILURE_INJECTED/);
  assert.equal(fault.values.get('ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'), pointerBefore, `${failedSheet} failure leaves pointer unchanged`);
}
console.log('DataOps Situation V2 storage and recovery tests passed');
