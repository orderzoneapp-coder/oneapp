export const CUSTOMER_REFERENCE_BOOTSTRAP_TIMEOUT_MS = 65000;
export const CUSTOMER_REFERENCE_READ_TIMEOUT_MS = 5000;

function rows(value) {
  return Array.isArray(value) ? value : [];
}

export async function loadCustomerReferenceRows({
  ensureReady,
  listRows,
  withTimeout,
  onLoading = null,
  diagnostics = null,
  referencePhase = 'CUSTOMER'
}) {
  if (typeof ensureReady !== 'function' || typeof listRows !== 'function' || typeof withTimeout !== 'function') {
    throw new TypeError('CUSTOMER_REFERENCE_LOADER_INVALID');
  }

  const span = diagnostics?.start?.(referencePhase, 'CUSTOMER_MASTER');
  let readiness;
  try {
    readiness = await withTimeout(
      ensureReady({ onLoading }),
      CUSTOMER_REFERENCE_BOOTSTRAP_TIMEOUT_MS,
      '거래처 마스터 동기화 시간이 초과되었습니다. 네트워크를 확인한 뒤 다시 시도하세요.'
    );
  } catch (error) {
    span?.fail(error);
    throw error;
  }
  const source = readiness?.source === 'LOCAL_CACHE' ? 'ORDERQ_LOCAL_CACHE' : 'ORDERQ_CLOUD_CUSTOMER_MASTER';
  if (readiness?.source === 'CLOUD_REQUIRED' && readiness?.sync?.pullError) {
    span?.fail(readiness.sync.pullError, source);
    throw readiness.sync.pullError;
  }
  const readyRows = rows(readiness?.customers);
  if (readyRows.length) {
    span?.end(readyRows.length, source);
    return readyRows;
  }

  let listedRows;
  try {
    listedRows = rows(await withTimeout(
      listRows(),
      CUSTOMER_REFERENCE_READ_TIMEOUT_MS,
      '거래처 기준정보를 불러오지 못했습니다.'
    ));
  } catch (error) {
    span?.fail(error, source);
    throw error;
  }
  if (listedRows.length) {
    span?.end(listedRows.length, source);
    return listedRows;
  }

  const syncError = readiness?.sync?.pullError || readiness?.sync?.pushError;
  if (syncError) {
    span?.fail(syncError, source);
    throw syncError;
  }
  const error = new Error('사용 가능한 거래처 기준정보가 없습니다. Cloud 거래처 마스터를 확인하세요.');
  span?.fail(error, source);
  throw error;
}
