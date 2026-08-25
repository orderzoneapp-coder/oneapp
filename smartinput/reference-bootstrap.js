export const CUSTOMER_REFERENCE_BOOTSTRAP_TIMEOUT_MS = 65000;
export const CUSTOMER_REFERENCE_READ_TIMEOUT_MS = 5000;

function rows(value) {
  return Array.isArray(value) ? value : [];
}

export async function loadCustomerReferenceRows({
  ensureReady,
  listRows,
  withTimeout,
  onLoading = null
}) {
  if (typeof ensureReady !== 'function' || typeof listRows !== 'function' || typeof withTimeout !== 'function') {
    throw new TypeError('CUSTOMER_REFERENCE_LOADER_INVALID');
  }

  const readiness = await withTimeout(
    ensureReady({ onLoading }),
    CUSTOMER_REFERENCE_BOOTSTRAP_TIMEOUT_MS,
    '거래처 마스터 동기화 시간이 초과되었습니다. 네트워크를 확인한 뒤 다시 시도하세요.'
  );
  if (readiness?.source === 'CLOUD_REQUIRED' && readiness?.sync?.pullError) {
    throw readiness.sync.pullError;
  }
  const readyRows = rows(readiness?.customers);
  if (readyRows.length) return readyRows;

  const listedRows = rows(await withTimeout(
    listRows(),
    CUSTOMER_REFERENCE_READ_TIMEOUT_MS,
    '거래처 기준정보를 불러오지 못했습니다.'
  ));
  if (listedRows.length) return listedRows;

  const syncError = readiness?.sync?.pullError || readiness?.sync?.pushError;
  if (syncError) throw syncError;
  throw new Error('사용 가능한 거래처 기준정보가 없습니다. Cloud 거래처 마스터를 확인하세요.');
}
