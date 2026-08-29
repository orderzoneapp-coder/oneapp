const AUTH_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec';
const AUTH_CONTRACT = 'NEXUS_AUTH_V2';
const REQUEST_TIMEOUT_MS = 20000;
const SESSION_KEY = 'oneapp.nexus.home.session.v1';
const contextCache = new Map();

const text = (value) => String(value ?? '').trim();

const post = async (body, signal) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(AUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NEXUS_GATEWAY_HTTP_${response.status}`);
    const result = await response.json();
    if (!result || result.status !== 'success') {
      throw new Error(text(result?.message) || 'NEXUS_GATEWAY_RESPONSE_INVALID');
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('NEXUS_GATEWAY_TIMEOUT');
    if (/^(NEXUS|COMPANY)_/.test(text(error?.message))) throw error;
    throw new Error('NEXUS_GATEWAY_NETWORK');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
};

export const readSessionBundle = () => {
  try {
    const bundle = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    const expiresAt = Date.parse(bundle?.session?.expiresAt || '');
    return text(bundle?.token) && bundle?.session?.user && Number.isFinite(expiresAt) && expiresAt > Date.now()
      ? bundle
      : null;
  } catch {
    return null;
  }
};

export const isCompanyAdministrator = (session) => session?.user?.role === 'OWNER_MASTER'
  && Array.isArray(session?.user?.permissions)
  && session.user.permissions.includes('admin.company');

export const refreshSession = async (sessionToken, signal) => {
  const result = await post({ action: 'nexus_auth_session', sessionToken: text(sessionToken) }, signal);
  const session = result.data?.session?.user ? result.data.session : result.data?.user ? result.data : null;
  if (!session) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
  return session;
};

const appContext = async (sessionToken, appId, signal) => {
  const token = text(sessionToken);
  const normalizedAppId = text(appId).toLowerCase();
  if (!token) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(normalizedAppId)) throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED');

  const cached = contextCache.get(normalizedAppId);
  if (cached?.sessionToken === token && Date.parse(cached.expiresAt || '') > Date.now() + 15000) return cached;

  const result = await post({ action: 'nexus_auth_app_context', sessionToken: token, appId: normalizedAppId }, signal);
  const context = result.data;
  if (context?.appId !== normalizedAppId || !text(context?.appContextToken)) {
    throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED');
  }
  const stored = { ...context, sessionToken: token };
  contextCache.set(normalizedAppId, stored);
  return stored;
};

export const callCompanyGateway = async ({ appId, operationId, payload = {}, sessionToken, signal }) => {
  const operation = text(operationId);
  if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(operation)) throw new Error('NEXUS_GATEWAY_OPERATION_INVALID');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('NEXUS_GATEWAY_PAYLOAD_INVALID');
  const reserved = ['action', 'operationId', 'sessionToken', 'appContextToken', 'targetUrl', 'credential'];
  if (Object.keys(payload).some((key) => reserved.includes(key))) throw new Error('NEXUS_GATEWAY_RESERVED_FIELD_DENIED');

  const context = await appContext(sessionToken, appId, signal);
  const result = await post({
    action: 'nexus_gateway',
    sessionToken: text(sessionToken),
    appContextToken: context.appContextToken,
    operationId: operation,
    payload,
  }, signal);
  if (result.contractVersion !== AUTH_CONTRACT || result.operationId !== operation) {
    throw new Error('NEXUS_GATEWAY_RESPONSE_INVALID');
  }
  return result.data;
};

export const companyTransportContract = Object.freeze({
  endpoint: AUTH_ENDPOINT,
  contractVersion: AUTH_CONTRACT,
  sessionKey: SESSION_KEY,
});
