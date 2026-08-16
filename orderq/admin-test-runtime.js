export const ADMIN_TEST_DB_PREFIX = 'oneapp-orderq-admin-test-';
export const ADMIN_TEST_BUILD_ID = '782d908816ca4445f2b17d45437e360ddc494537';

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

export function validateAdminTestBuildId(value) {
  const buildId = String(value ?? '').trim();
  if (buildId !== ADMIN_TEST_BUILD_ID) throw new Error('승인된 TEST 빌드와 다릅니다. 최신 TEST 시작 링크를 사용하세요.');
  return buildId;
}
