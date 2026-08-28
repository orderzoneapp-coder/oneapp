import { ORDERQ_DB_VERSION as V16 } from './orderq-v16-contracts.js?v=0.1.0';

export const ORDERQ_DB_VERSION = 17;
export const ORDERQ_PREVIOUS_DB_VERSION = V16;

const index = (name, keyPath, unique = false) => Object.freeze({ name, keyPath, options: Object.freeze({ unique }) });
const store = (name, keyPath, indexes) => Object.freeze({ name, keyPath, indexes: Object.freeze(indexes) });

export const V17_STORE = Object.freeze({
  FOUNDATION_BACKUP_OUTBOX: 'foundationBackupOutbox',
  FOUNDATION_RECOVERY_SNAPSHOTS: 'foundationRecoverySnapshots',
  FOUNDATION_RECOVERY_AUDIT: 'foundationRecoveryAudit',
  FOUNDATION_LEGACY_QUARANTINE: 'foundationLegacyQuarantine'
});

export const V17_STORE_DEFINITIONS = Object.freeze([
  store(V17_STORE.FOUNDATION_BACKUP_OUTBOX, 'backupId', [
    index('byDomainStatusCreatedAt', ['domainType', 'status', 'createdAt']),
    index('byEntityRevision', ['entityType', 'entityId', 'entityRevision']),
    index('byLocalRevision', ['domainType', 'localRevision'])
  ]),
  store(V17_STORE.FOUNDATION_RECOVERY_SNAPSHOTS, 'snapshotId', [
    index('byDomainCreatedAt', ['domainType', 'createdAt']),
    index('byRestoreId', 'restoreId')
  ]),
  store(V17_STORE.FOUNDATION_RECOVERY_AUDIT, 'auditId', [
    index('byDomainCreatedAt', ['domainType', 'createdAt']),
    index('byRestoreId', 'restoreId')
  ]),
  store(V17_STORE.FOUNDATION_LEGACY_QUARANTINE, 'quarantineId', [
    index('byEntityStatus', ['entityType', 'status']),
    index('byOriginalQueueId', 'originalQueueId', true),
    index('byQuarantinedAt', 'quarantinedAt')
  ])
]);

export const V17_META_DEFAULTS = Object.freeze({
  foundationCustomerState: Object.freeze({
    schemaVersion: 'FOUNDATION_BACKUP_V1',
    domainType: 'CUSTOMER',
    localRevision: 0,
    baseServerRevision: 0,
    primaryEpoch: 0,
    status: 'RESTORE_REQUIRED',
    lastSnapshotLocalRevision: 0,
    lastSnapshotAt: ''
  }),
  foundationLegacyQuarantineCompleted: false,
  foundationBackupFlags: Object.freeze({
    BPLUS_BACKUP_ENABLED: true,
    BPLUS_AUTO_PULL_DISABLED: true,
    BPLUS_PRIMARY_GUARD_MODE: 'ENFORCE',
    BPLUS_CUSTOMER_RECOVERY_COMPLETED: false,
    BPLUS_SHADOW_COMPARE_ENABLED: false
  })
});
