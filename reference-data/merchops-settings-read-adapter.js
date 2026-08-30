import { cloneJson, deepFreeze } from './change-request-contract.js';

export const MERCHOPS_SETTINGS_READ_ADAPTER_VERSION = 'ONEAPP_MERCHOPS_SETTINGS_READ_ADAPTER_V1';
export const MERCHOPS_SETTINGS_SNAPSHOT_SCHEMA_VERSION = 'ONEAPP_MERCHOPS_SETTINGS_SNAPSHOT_V1';

const SETTINGS_KEYS = Object.freeze({
  cloudUrl: 'oneapp_cloud_sync_url_v1',
  legacyCloudUrl: 'merchCloudUrl_v870',
  marginRules: 'merchMarginRules_v878',
  mappings: 'merchMappings_v870',
  masterLinks: 'merchMasterLinks_v870',
  tableViewPresets: 'merchTableViewPresets_v1',
  activeTableTarget: 'merchActiveTableTarget_v1',
  activeTableViewId: 'merchActiveTableViewId_v1',
});

function parseJson(storage, key, fallback) {
  const raw = storage.getItem(key);
  if (raw === null || raw === '') return cloneJson(fallback);
  try {
    return JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`SETTINGS_VALUE_INVALID:${key}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

export function readMerchOpsSettingsSnapshot(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function') throw new Error('SETTINGS_STORAGE_NOT_AVAILABLE');
  const primaryCloudUrl = String(storage.getItem(SETTINGS_KEYS.cloudUrl) || '').trim();
  const legacyCloudUrl = String(storage.getItem(SETTINGS_KEYS.legacyCloudUrl) || '').trim();
  return deepFreeze({
    schemaVersion: MERCHOPS_SETTINGS_SNAPSHOT_SCHEMA_VERSION,
    adapterVersion: MERCHOPS_SETTINGS_READ_ADAPTER_VERSION,
    ownerAppId: 'settings',
    status: 'READY',
    values: {
      cloudUrl: primaryCloudUrl || legacyCloudUrl,
      cloudUrlSource: primaryCloudUrl ? SETTINGS_KEYS.cloudUrl : (legacyCloudUrl ? SETTINGS_KEYS.legacyCloudUrl : ''),
      marginRules: parseJson(storage, SETTINGS_KEYS.marginRules, []),
      mappings: parseJson(storage, SETTINGS_KEYS.mappings, {}),
      masterLinks: parseJson(storage, SETTINGS_KEYS.masterLinks, {}),
      tableViewPresets: parseJson(storage, SETTINGS_KEYS.tableViewPresets, {}),
      activeTableTarget: String(storage.getItem(SETTINGS_KEYS.activeTableTarget) || ''),
      activeTableViewId: String(storage.getItem(SETTINGS_KEYS.activeTableViewId) || ''),
    },
  });
}

export function getMerchOpsSettingsSnapshotResult(storage = globalThis.localStorage) {
  try {
    return deepFreeze({ status: 'READY', snapshot: readMerchOpsSettingsSnapshot(storage), error: null });
  } catch (error) {
    return deepFreeze({
      status: 'ERROR',
      snapshot: null,
      error: { code: String(error?.message || 'SETTINGS_READ_FAILED'), retryable: true },
    });
  }
}

export const merchOpsSettingsReadAdapter = deepFreeze({
  version: MERCHOPS_SETTINGS_READ_ADAPTER_VERSION,
  schemaVersion: MERCHOPS_SETTINGS_SNAPSHOT_SCHEMA_VERSION,
  ownerAppId: 'settings',
  getSnapshot: readMerchOpsSettingsSnapshot,
  getSnapshotResult: getMerchOpsSettingsSnapshotResult,
});

globalThis.ONEAPP_MERCHOPS_SETTINGS_READ_ADAPTER_V1 = merchOpsSettingsReadAdapter;
