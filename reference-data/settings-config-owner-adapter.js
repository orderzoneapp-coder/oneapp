import { cloneJson, deepFreeze, stableStringify } from './change-request-contract.js';

export const SETTINGS_CONFIG_BUNDLE_SCHEMA_VERSION = 'ONEAPP_SETTINGS_CONFIG_BUNDLE_V1';
export const SETTINGS_CONFIG_OWNER_ADAPTER_VERSION = 'ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1';

export const SETTINGS_OWNER_KEYS = Object.freeze([
  'merchVisMaster_v870',
  'merchVisUpload_v870',
  'merchMappings_v870',
  'merchMasterLinks_v870',
  'merchMarginRules_v878',
  'merchUploadColumnMeta_v870',
  'merchTableShortcuts_v870',
  'merchTableViewPresets_v1',
  'merchActiveTableTarget_v1',
  'merchActiveTableViewId_v1',
  'oneapp_cloud_sync_url_v1',
  'merchCloudUrl_v870',
]);

export const SMARTPARSER_OPAQUE_RECOVERY_KEYS = Object.freeze([
  'parserDict_v870',
  'parserCatalogWarehouseMap_v1',
]);

export const SETTINGS_EXCLUDED_LIVE_KEYS = Object.freeze([
  'merchMaster_v870',
  'merchMaster_revision_v870',
  'merchHistory_v870',
  'pendingShopStatus',
  'pendingShopStatus_v1',
  'pending_shop_status',
  'merchStoppedProducts_v2',
  'merchProductStatusRecords_v1',
]);

const OWNER_KEY_SET = new Set(SETTINGS_OWNER_KEYS);
const OPAQUE_KEY_SET = new Set(SMARTPARSER_OPAQUE_RECOVERY_KEYS);
const EXCLUDED_KEY_SET = new Set(SETTINGS_EXCLUDED_LIVE_KEYS);
const JSON_OBJECT_KEYS = new Set([
  'merchVisMaster_v870', 'merchVisUpload_v870', 'merchMappings_v870', 'merchMasterLinks_v870',
  'merchUploadColumnMeta_v870', 'merchTableViewPresets_v1',
  'parserDict_v870', 'parserCatalogWarehouseMap_v1',
]);
const JSON_ARRAY_KEYS = new Set(['merchMarginRules_v878', 'merchTableShortcuts_v870']);
const TABLE_TARGETS = new Set(['estimate', 'purchase', 'sales', 'inventory', 'catalog', 'info']);
const APP_CONFIG_MAP = Object.freeze({
  mappings: 'merchMappings_v870',
  masterLinks: 'merchMasterLinks_v870',
  visibleUploadCols: 'merchVisUpload_v870',
  visibleMasterCols: 'merchVisMaster_v870',
  uploadColumnMeta: 'merchUploadColumnMeta_v870',
  tableShortcuts: 'merchTableShortcuts_v870',
  tableViewPresets: 'merchTableViewPresets_v1',
  activeTableTarget: 'merchActiveTableTarget_v1',
  activeTableViewId: 'merchActiveTableViewId_v1',
});

function adapterError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rawValueForKey(key, value, structured = false) {
  if (value === undefined || value === null) return null;
  if (JSON_OBJECT_KEYS.has(key) || JSON_ARRAY_KEYS.has(key)) {
    return structured || typeof value !== 'string' ? JSON.stringify(value) : value;
  }
  return String(value);
}

function validateRawValue(key, raw) {
  if (typeof raw !== 'string') throw adapterError('SETTINGS_VALUE_STRING_REQUIRED', { key });
  if (JSON_OBJECT_KEYS.has(key) || JSON_ARRAY_KEYS.has(key)) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (cause) { throw adapterError('SETTINGS_VALUE_JSON_INVALID', { key, cause }); }
    if (JSON_OBJECT_KEYS.has(key) && !isPlainObject(parsed)) {
      throw adapterError('SETTINGS_VALUE_OBJECT_REQUIRED', { key });
    }
    if (JSON_ARRAY_KEYS.has(key) && !Array.isArray(parsed)) {
      throw adapterError('SETTINGS_VALUE_ARRAY_REQUIRED', { key });
    }
  }
  if (key === 'merchActiveTableTarget_v1' && raw && !TABLE_TARGETS.has(raw)) {
    throw adapterError('SETTINGS_TABLE_TARGET_INVALID', { key });
  }
  return raw;
}

function assignPlanValue(values, key, value, structured = false) {
  const raw = rawValueForKey(key, value, structured);
  if (raw === null) return;
  validateRawValue(key, raw);
  if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== raw) {
    let same = false;
    if (JSON_OBJECT_KEYS.has(key) || JSON_ARRAY_KEYS.has(key)) {
      try { same = stableStringify(JSON.parse(values[key])) === stableStringify(JSON.parse(raw)); }
      catch (error) { same = false; }
    }
    if (!same) throw adapterError('SETTINGS_DUPLICATE_VALUE_CONFLICT', { key });
  }
  values[key] = raw;
}

export function buildSettingsRestorePlan(input, options = {}) {
  const source = String(options.source || 'json').toLowerCase();
  const allowCloudPreservedFields = source === 'cloud' || options.allowCloudPreservedFields === true;
  const payload = isPlainObject(input?.data) ? input.data : input;
  if (!isPlainObject(payload)) throw adapterError('SETTINGS_BUNDLE_OBJECT_REQUIRED');
  const values = {};
  const ignoredKeys = [];
  const settingsKeys = payload.settingsKeys ?? payload.appConfig?.settingsKeys ?? {};
  if (!isPlainObject(settingsKeys)) throw adapterError('SETTINGS_KEYS_OBJECT_REQUIRED');

  Object.entries(settingsKeys).forEach(([key, value]) => {
    if (OWNER_KEY_SET.has(key) || OPAQUE_KEY_SET.has(key)) assignPlanValue(values, key, value, false);
    else if (allowCloudPreservedFields || EXCLUDED_KEY_SET.has(key)) ignoredKeys.push(key);
    else throw adapterError('SETTINGS_KEY_NOT_OWNED', { key });
  });

  if (payload.dict !== undefined && payload.dict !== null) assignPlanValue(values, 'parserDict_v870', payload.dict, true);
  if (payload.rules !== undefined && payload.rules !== null) assignPlanValue(values, 'merchMarginRules_v878', payload.rules, true);
  if (payload.parserCatalogWarehouseMap !== undefined && payload.parserCatalogWarehouseMap !== null) {
    assignPlanValue(values, 'parserCatalogWarehouseMap_v1', payload.parserCatalogWarehouseMap, true);
  }

  if (payload.appConfig !== undefined && !isPlainObject(payload.appConfig)) {
    throw adapterError('SETTINGS_APP_CONFIG_OBJECT_REQUIRED');
  }
  Object.entries(APP_CONFIG_MAP).forEach(([field, key]) => {
    if (payload.appConfig && Object.prototype.hasOwnProperty.call(payload.appConfig, field)) {
      assignPlanValue(values, key, payload.appConfig[field], true);
    }
  });

  SETTINGS_EXCLUDED_LIVE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) ignoredKeys.push(key);
  });
  if (Object.prototype.hasOwnProperty.call(payload, 'pendingShopStatus')) ignoredKeys.push('pendingShopStatus');
  if (Object.prototype.hasOwnProperty.call(payload, 'master')) ignoredKeys.push('master');
  if (Object.prototype.hasOwnProperty.call(payload, 'history')) ignoredKeys.push('history');

  return deepFreeze({
    schemaVersion: SETTINGS_CONFIG_BUNDLE_SCHEMA_VERSION,
    adapterVersion: SETTINGS_CONFIG_OWNER_ADAPTER_VERSION,
    source: source.toUpperCase(),
    values: cloneJson(values),
    appliedKeys: Object.keys(values),
    ownerKeys: Object.keys(values).filter((key) => OWNER_KEY_SET.has(key)),
    opaqueRecoveryKeys: Object.keys(values).filter((key) => OPAQUE_KEY_SET.has(key)),
    ignoredKeys: [...new Set(ignoredKeys)].sort(),
  });
}

function restorePreimage(storage, preimage, keys) {
  keys.forEach((key) => {
    const raw = preimage[key];
    if (raw === null) storage.removeItem(key);
    else storage.setItem(key, raw);
  });
  keys.forEach((key) => {
    if (storage.getItem(key) !== preimage[key]) throw adapterError('SETTINGS_ROLLBACK_VERIFY_FAILED', { key });
  });
}

export function restoreSettingsBundle(input, options = {}) {
  const storage = options.storage || globalThis.localStorage;
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function'
    || typeof storage.removeItem !== 'function') {
    throw adapterError('SETTINGS_STORAGE_NOT_AVAILABLE');
  }
  const plan = buildSettingsRestorePlan(input, options);
  const keys = plan.appliedKeys;
  const preimage = Object.fromEntries(keys.map((key) => [key, storage.getItem(key)]));
  try {
    keys.forEach((key) => storage.setItem(key, plan.values[key]));
    keys.forEach((key) => {
      if (storage.getItem(key) !== plan.values[key]) throw adapterError('SETTINGS_POST_WRITE_VERIFY_FAILED', { key });
    });
  } catch (cause) {
    try { restorePreimage(storage, preimage, keys); }
    catch (rollbackError) {
      throw adapterError('SETTINGS_RESTORE_ROLLBACK_FAILED', { cause, rollbackError });
    }
    throw adapterError('SETTINGS_RESTORE_ROLLED_BACK', { cause });
  }
  return deepFreeze({ ...plan, preimageCaptured: true, verified: true });
}

export function captureSettingsBundle(storage = globalThis.localStorage, options = {}) {
  if (!storage || typeof storage.getItem !== 'function') throw adapterError('SETTINGS_STORAGE_NOT_AVAILABLE');
  const settingsKeys = {};
  [...SETTINGS_OWNER_KEYS, ...SMARTPARSER_OPAQUE_RECOVERY_KEYS].forEach((key) => {
    const raw = storage.getItem(key);
    if (raw !== null) {
      validateRawValue(key, raw);
      settingsKeys[key] = raw;
    }
  });
  return deepFreeze({
    schemaVersion: SETTINGS_CONFIG_BUNDLE_SCHEMA_VERSION,
    updatedAt: options.now || new Date().toISOString(),
    settingsKeys,
  });
}

export function mergeSettingsCloudRoundTrip(existingInput, ownedInput) {
  const existing = isPlainObject(existingInput?.data) ? existingInput.data : existingInput;
  const owned = isPlainObject(ownedInput?.data) ? ownedInput.data : ownedInput;
  if (!isPlainObject(existing)) throw adapterError('SETTINGS_CLOUD_PREIMAGE_REQUIRED');
  if (!isPlainObject(owned)) throw adapterError('SETTINGS_CLOUD_OWNED_DATA_REQUIRED');
  if (Object.prototype.hasOwnProperty.call(existing, 'settingsKeys') && !isPlainObject(existing.settingsKeys)) {
    throw adapterError('SETTINGS_CLOUD_EXISTING_KEYS_INVALID');
  }
  if (Object.prototype.hasOwnProperty.call(existing, 'appConfig') && !isPlainObject(existing.appConfig)) {
    throw adapterError('SETTINGS_CLOUD_EXISTING_APP_CONFIG_INVALID');
  }
  if (Object.prototype.hasOwnProperty.call(owned, 'settingsKeys') && !isPlainObject(owned.settingsKeys)) {
    throw adapterError('SETTINGS_CLOUD_OWNED_KEYS_INVALID');
  }
  if (Object.prototype.hasOwnProperty.call(owned, 'appConfig') && !isPlainObject(owned.appConfig)) {
    throw adapterError('SETTINGS_CLOUD_OWNED_APP_CONFIG_INVALID');
  }
  const existingSettingsKeys = isPlainObject(existing.settingsKeys) ? existing.settingsKeys : {};
  const ownedSettingsKeys = isPlainObject(owned.settingsKeys) ? owned.settingsKeys : {};
  const existingAppConfig = isPlainObject(existing.appConfig) ? existing.appConfig : {};
  const ownedAppConfig = isPlainObject(owned.appConfig) ? owned.appConfig : {};
  const merged = {
    ...cloneJson(existing),
    ...cloneJson(owned),
    appConfig: { ...cloneJson(existingAppConfig), ...cloneJson(ownedAppConfig) },
    settingsKeys: { ...cloneJson(existingSettingsKeys), ...cloneJson(ownedSettingsKeys) },
  };

  Object.entries(existingSettingsKeys).forEach(([key, value]) => {
    if (!OWNER_KEY_SET.has(key) && !OPAQUE_KEY_SET.has(key)
      && stableStringify(merged.settingsKeys[key]) !== stableStringify(value)) {
      throw adapterError('SETTINGS_CLOUD_EXTERNAL_FIELD_CHANGED', { key });
    }
  });
  Object.entries(existingAppConfig).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(APP_CONFIG_MAP, key)
      && stableStringify(merged.appConfig[key]) !== stableStringify(value)) {
      throw adapterError('SETTINGS_CLOUD_EXTERNAL_FIELD_CHANGED', { key: `appConfig.${key}` });
    }
  });
  if (Object.prototype.hasOwnProperty.call(existing, 'pendingShopStatus')) {
    merged.pendingShopStatus = cloneJson(existing.pendingShopStatus);
  }
  return deepFreeze(merged);
}

export const settingsConfigOwnerAdapter = deepFreeze({
  version: SETTINGS_CONFIG_OWNER_ADAPTER_VERSION,
  schemaVersion: SETTINGS_CONFIG_BUNDLE_SCHEMA_VERSION,
  ownerAppId: 'settings',
  ownerKeys: SETTINGS_OWNER_KEYS,
  opaqueRecoveryKeys: SMARTPARSER_OPAQUE_RECOVERY_KEYS,
  excludedLiveKeys: SETTINGS_EXCLUDED_LIVE_KEYS,
  buildRestorePlan: buildSettingsRestorePlan,
  restore: restoreSettingsBundle,
  capture: captureSettingsBundle,
  mergeCloudRoundTrip: mergeSettingsCloudRoundTrip,
});

globalThis.ONEAPP_SETTINGS_CONFIG_OWNER_ADAPTER_V1 = settingsConfigOwnerAdapter;
