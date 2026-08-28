export const ORDERQ_SYNC_SCHEMA = 'ONEAPP_ORDERQ_SYNC_V1';
export const CLOUD_URL_KEY = 'oneapp_cloud_sync_url_v1';
export const LEGACY_CLOUD_URL_KEY = 'merchCloudUrl_v870';
export const CLOUD_ACCESS_TOKEN_KEY = 'oneapp_orderq_access_token_v1';

export class OrderQCloudError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OrderQCloudError';
    Object.assign(this, details);
  }
}

export function getCloudUrl() {
  return String(localStorage.getItem(CLOUD_URL_KEY) || localStorage.getItem(LEGACY_CLOUD_URL_KEY) || '').trim();
}

export function setCloudUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    localStorage.removeItem(CLOUD_URL_KEY);
    return '';
  }
  if (!/^https:\/\//i.test(value)) throw new Error('클라우드 URL은 https:// 주소여야 합니다.');
  localStorage.setItem(CLOUD_URL_KEY, value);
  return value;
}

export function getCloudAccessToken() {
  return String(sessionStorage.getItem(CLOUD_ACCESS_TOKEN_KEY) || localStorage.getItem(CLOUD_ACCESS_TOKEN_KEY) || '').trim();
}

export function setCloudAccessToken(token, remember = true) {
  const value = String(token || '').trim();
  sessionStorage.removeItem(CLOUD_ACCESS_TOKEN_KEY);
  localStorage.removeItem(CLOUD_ACCESS_TOKEN_KEY);
  if (!value) return '';
  (remember ? localStorage : sessionStorage).setItem(CLOUD_ACCESS_TOKEN_KEY, value);
  return value;
}

async function post(action, body = {}) {
  const url = getCloudUrl();
  if (!url) throw new OrderQCloudError('클라우드 URL이 설정되지 않았습니다.', { code: 'CLOUD_URL_MISSING' });
  let response;
  const controller = new AbortController();
  // Apps Script may need extra time on the first call while purpose sheets are created.
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: getCloudAccessToken(), ...body }),
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new OrderQCloudError('클라우드 응답 시간이 초과되었습니다. 로컬 저장값은 유지되며 다시 동기화할 수 있습니다.', { code: 'CLOUD_TIMEOUT', cause: error });
    throw new OrderQCloudError('클라우드에 연결할 수 없습니다.', { code: 'CLOUD_NETWORK_ERROR', cause: error });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new OrderQCloudError(`클라우드 응답 오류 (${response.status})`, { code: 'CLOUD_HTTP_ERROR', status: response.status });
  let data;
  try { data = await response.json(); }
  catch (error) { throw new OrderQCloudError('클라우드 응답 형식이 올바르지 않습니다.', { code: 'CLOUD_RESPONSE_INVALID', cause: error }); }
  if (!data || data.status !== 'success') {
    throw new OrderQCloudError(data?.message || '클라우드 요청이 실패했습니다.', { code: 'CLOUD_ACTION_FAILED', response: data });
  }
  return data.data;
}

export function pushCloudChanges(deviceId, changes) {
  return post('orderq_sync_push', {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    deviceId,
    changes
  });
}

export function pullCloudChanges(afterSequence = 0, limit = 200) {
  return post('orderq_sync_pull', {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    afterSequence,
    limit
  });
}

export function getCloudOrderHead(orderId) {
  return post('orderq_order_head', {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    orderId
  });
}
