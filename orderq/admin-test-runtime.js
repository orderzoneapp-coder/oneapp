export const ADMIN_TEST_DB_PREFIX = 'oneapp-orderq-admin-test-';

export function isAdminTestRuntime(locationValue = globalThis.location) {
  const pathname = String(locationValue?.pathname || '').toLowerCase();
  return pathname.endsWith('/orderq/admin-test.html') || pathname.endsWith('/admin-test.html');
}

export function adminTestDatabaseName(locationValue = globalThis.location) {
  if (!isAdminTestRuntime(locationValue)) return '';
  const value = new URLSearchParams(String(locationValue?.search || '')).get('orderqTestDb') || '';
  return value.startsWith(ADMIN_TEST_DB_PREFIX) && /^[a-z0-9._-]{1,100}$/i.test(value) ? value : '';
}

export function runtimeStorageKey(operationalKey, adminTestKey, locationValue = globalThis.location) {
  return isAdminTestRuntime(locationValue) ? adminTestKey : operationalKey;
}
