(() => {
  'use strict';

  const VERSION = '2.1.3';
  const CONTRACT_VERSION = 'NEXUS_AUTH_V2';
  const COMPANY_FOOTER_VERSION = '1.1.0';
  const CONTEXT_REFRESH_LEAD_MS = 90 * 1000;
  const CONTEXT_REFRESH_RETRY_MS = 15 * 1000;
  const config = window.NEXUS_AUTH_CONFIG || {};
  const endpoint = String(config.endpoint || '').trim();
  const nativeFetch = window.fetch.bind(window);
  const SESSION_BUNDLE_KEY = 'oneapp.nexus.auth.bundle.v2';
  const LEGACY_SESSION_KEY = 'oneapp.nexus.auth.session.v1';
  const LOGIN_PATHS = new Set(['/nexus/', '/nexus/index.html']);
  const PUBLIC_PATH = LOGIN_PATHS.has(location.pathname);
  const authScriptSource = String(document.currentScript?.src || '/nexus/common/nexus-auth.js');
  const APP_PERMISSIONS = Object.freeze({
    master: 'foundation.read', 'item-manager': 'foundation.write', 'customer-manager': 'customer.read',
    merchops: 'merchops.read', 'smart-parser': 'merchops.read', dataops: 'dataops.read',
    orderq: 'orderq.read', orderops: ['orderq.read', 'shipping.read'], orderin: 'orderq.write', 'smart-input': 'smartinput.use',
    settings: 'foundation.read', history: 'foundation.read', 'export-center': 'foundation.read'
  });
  const GROUP_PERMISSIONS = Object.freeze({
    foundation: 'foundation.read', pricing: 'merchops.read', shipping: 'shipping.read', inventory: 'dataops.read'
  });
  let currentSession = null;
  let currentAppContext = null;
  let currentBundle = null;
  let sessionRefreshPromise = null;
  let contextRefreshTimer = 0;
  const appContextPromises = new Map();
  const authChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('oneapp.nexus.auth.v2') : null;

  function installCompanyFooter() {
    if (PUBLIC_PATH || window.ONEAPP_COMPANY_PUBLIC || typeof document.createElement !== 'function'
        || typeof document.getElementById !== 'function' || document.getElementById('nexusCompanyFooterAsset')) return;
    const script = document.createElement('script');
    script.id = 'nexusCompanyFooterAsset';
    script.src = authScriptSource.replace(/[^/]*(?:\?.*)?$/, `nexus-company-footer.js?v=${COMPANY_FOOTER_VERSION}`);
    script.async = true;
    (document.head || document.documentElement).appendChild(script);
  }
  installCompanyFooter();

  if (!PUBLIC_PATH) {
    document.documentElement.dataset.nexusLoaderDeferred = 'true';
    const style = document.createElement('style');
    style.dataset.nexusLoaderDeferral = 'true';
    style.textContent = 'html[data-nexus-loader-deferred="true"] #initial-loader{visibility:hidden!important;opacity:0!important}';
    document.documentElement.appendChild(style);
    window.setTimeout(() => { delete document.documentElement.dataset.nexusLoaderDeferred; }, 300);
  }

  const text = value => String(value ?? '').trim();
  const future = (value, margin = 0) => Number.isFinite(Date.parse(value || '')) && Date.parse(value) > Date.now() + margin;
  const signedContext = value => /\.[a-f0-9]{64}$/.test(text(value));
  const bytesToBase64Url = bytes => {
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  const base64UrlToBytes = value => {
    const normalized = text(value).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  };

  function readStoredBundle() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(SESSION_BUNDLE_KEY) || 'null');
      if (parsed && typeof parsed === 'object' && text(parsed.sessionToken)) return parsed;
      const legacyToken = text(sessionStorage.getItem(LEGACY_SESSION_KEY));
      return legacyToken ? { version: 1, sessionToken: legacyToken, appContexts: {} } : null;
    } catch {
      return null;
    }
  }

  function storeBundle(bundle) {
    try {
      if (bundle && text(bundle.sessionToken)) {
        sessionStorage.setItem(SESSION_BUNDLE_KEY, JSON.stringify(bundle));
        sessionStorage.removeItem(LEGACY_SESSION_KEY);
      } else {
        sessionStorage.removeItem(SESSION_BUNDLE_KEY);
        sessionStorage.removeItem(LEGACY_SESSION_KEY);
      }
    } catch {}
    currentBundle = bundle || null;
  }

  const sessionToken = () => text((currentBundle || readStoredBundle())?.sessionToken);

  async function call(action, body = {}, options = {}) {
    if (!endpoint) throw new Error('NEXUS_AUTH_ENDPOINT_NOT_CONFIGURED');
    if (config.contractVersion !== CONTRACT_VERSION) throw new Error('NEXUS_AUTH_MIXED_CACHE_DENIED');
    const response = await nativeFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...body }), redirect: 'follow', cache: 'no-store', signal: options.signal
    });
    if (!response.ok) throw new Error(`NEXUS_AUTH_HTTP_${response.status}`);
    const result = await response.json();
    if (!result || result.status !== 'success') throw new Error(text(result?.message) || 'NEXUS_AUTH_REQUEST_FAILED');
    return result.data;
  }

  function validateGatewayPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('NEXUS_GATEWAY_PAYLOAD_INVALID');
    const reserved = new Set(['action', 'operationId', 'sessionToken', 'targetUrl', 'upstreamUrl', 'token', 'actorId', 'userId', 'loginId', 'appId', 'requestId', 'credential']);
    const forbidden = Object.keys(payload).find(key => reserved.has(key));
    if (forbidden) throw new Error('NEXUS_GATEWAY_RESERVED_FIELD_DENIED');
    return payload;
  }

  function clearAuth({ broadcast = false } = {}) {
    if (contextRefreshTimer) window.clearTimeout(contextRefreshTimer);
    contextRefreshTimer = 0;
    storeBundle(null);
    currentSession = null;
    currentAppContext = null;
    if (broadcast) authChannel?.postMessage({ type: 'logout' });
  }

  function redirectToLogin() {
    const returnUrl = `${location.pathname}${location.search}${location.hash}`;
    location.replace(`${config.loginUrl || '/nexus/'}?return=${encodeURIComponent(returnUrl)}`);
  }

  function handleSessionFailure(error) {
    const code = text(error?.message || error);
    if (/NEXUS_AUTH_(SESSION|APP_CONTEXT)_(REQUIRED|EXPIRED|REVOKED|DENIED)/.test(code)) {
      clearAuth({ broadcast: true });
      if (!PUBLIC_PATH) redirectToLogin();
    }
    return error;
  }

  function inferAppId() {
    const pathname = String(location.pathname || '').toLowerCase();
    if (pathname.includes('/partner_db')) return 'customer-manager';
    if (pathname.includes('/orderops/') || pathname.endsWith('/orders.html') || pathname.endsWith('/orderops_list.html')) return 'orderops';
    if (pathname.includes('/orderq/')) return pathname.endsWith('/parser.html') ? 'orderin' : 'orderq';
    if (pathname.includes('/smartinput/')) return 'smart-input';
    if (pathname.endsWith('/dataops.html')) return 'dataops';
    if (pathname.endsWith('/merchops.html')) return 'merchops';
    if (pathname.endsWith('/smartparser.html')) return 'smart-parser';
    if (pathname.endsWith('/item_manager.html')) return 'item-manager';
    if (pathname.endsWith('/settings.html')) return 'settings';
    if (pathname.endsWith('/history_viewer.html')) return 'history';
    if (pathname.endsWith('/export_center.html')) return 'export-center';
    if (pathname.endsWith('/master.html')) return 'master';
    return '';
  }

  function declaredAppId() {
    return text(document.documentElement.dataset.nexusAppId || document.querySelector('nexus-top')?.getAttribute('app-id') || inferAppId()).toLowerCase();
  }

  function permissions() { return Array.isArray(currentSession?.user?.permissions) ? currentSession.user.permissions : []; }
  function hasPermission(permission) {
    if (currentSession?.user?.role === 'OWNER_MASTER' || permissions().includes(permission)) return true;
    const impliedWrite = String(permission || '').replace(/\.read$/, '.write');
    return impliedWrite !== permission && permissions().includes(impliedWrite);
  }
  function canUseApp(appId) {
    const required = APP_PERMISSIONS[appId] || 'foundation.read';
    return (Array.isArray(required) ? required : [required]).every(hasPermission);
  }
  function canUseGroup(groupId) { return hasPermission(GROUP_PERMISSIONS[groupId] || 'foundation.read'); }

  function applyAuthResult(result, tokenOverride = '') {
    if (!result?.session?.user) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
    const token = text(result.sessionToken || tokenOverride || sessionToken());
    if (!token) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
    currentSession = result.session;
    currentBundle = {
      version: 2, sessionToken: token, session: result.session,
      sessionContextToken: text(result.sessionContextToken), contextExpiresAt: text(result.contextExpiresAt),
      appContexts: result.appContexts && typeof result.appContexts === 'object' ? result.appContexts : {}
    };
    const appId = declaredAppId();
    currentAppContext = appId ? currentBundle.appContexts[appId] || null : null;
    storeBundle(currentBundle);
    scheduleSessionRefresh();
    window.dispatchEvent(new CustomEvent('nexus-auth-ready', { detail: currentSession }));
    authChannel?.postMessage({ type: 'refresh', contextExpiresAt: currentBundle.contextExpiresAt });
    return currentSession;
  }

  function hydrateCachedSession() {
    const bundle = readStoredBundle();
    if (!bundle?.session?.user || !signedContext(bundle.sessionContextToken) || !future(bundle.contextExpiresAt)
      || !future(bundle.session.expiresAt)) return false;
    const appId = declaredAppId();
    const appContext = appId ? bundle.appContexts?.[appId] : null;
    if (appId && (!appContext || appContext.appId !== appId || !signedContext(appContext.appContextToken) || !future(appContext.expiresAt))) return false;
    currentBundle = bundle;
    currentSession = bundle.session;
    currentAppContext = appContext || null;
    scheduleSessionRefresh();
    window.dispatchEvent(new CustomEvent('nexus-auth-ready', { detail: currentSession }));
    return true;
  }

  async function ensureAppContext(appId = declaredAppId()) {
    const normalized = text(appId).toLowerCase();
    if (!normalized) return null;
    if (currentAppContext?.appId === normalized && signedContext(currentAppContext.appContextToken) && future(currentAppContext.expiresAt, 15000)) return currentAppContext;
    const cached = currentBundle?.appContexts?.[normalized];
    if (cached?.appId === normalized && signedContext(cached.appContextToken) && future(cached.expiresAt, 15000)) {
      currentAppContext = cached;
      return cached;
    }
    if (appContextPromises.has(normalized)) return appContextPromises.get(normalized);
    const pending = call('nexus_auth_app_context', { sessionToken: sessionToken(), appId: normalized })
      .then(context => {
        if (context?.appId !== normalized || !signedContext(context.appContextToken)) throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED');
        currentAppContext = context;
        currentBundle = currentBundle || readStoredBundle() || { sessionToken: sessionToken(), appContexts: {} };
        currentBundle.appContexts = { ...(currentBundle.appContexts || {}), [normalized]: context };
        storeBundle(currentBundle);
        return context;
      })
      .catch(error => { throw handleSessionFailure(error); })
      .finally(() => appContextPromises.delete(normalized));
    appContextPromises.set(normalized, pending);
    return pending;
  }

  async function gateway(operationId, payload = {}, options = {}) {
    const operation = text(operationId);
    if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(operation)) throw new Error('NEXUS_GATEWAY_OPERATION_INVALID');
    validateGatewayPayload(payload);
    await ready;
    if (!currentSession || !sessionToken()) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    const context = await ensureAppContext();
    try {
      const response = await nativeFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'nexus_gateway', sessionToken: sessionToken(),
          appContextToken: context?.appContextToken || '', operationId: operation, payload }),
        redirect: 'follow', cache: 'no-store', signal: options.signal
      });
      if (!response.ok) throw new Error(`NEXUS_GATEWAY_HTTP_${response.status}`);
      let result;
      try { result = await response.json(); } catch { throw new Error('NEXUS_GATEWAY_RESPONSE_INVALID'); }
      if (!result || result.status !== 'success' || result.contractVersion !== CONTRACT_VERSION || result.operationId !== operation) {
        throw new Error(text(result?.message) || 'NEXUS_GATEWAY_REQUEST_FAILED');
      }
      return result.data;
    } catch (error) {
      throw handleSessionFailure(error);
    }
  }

  function validatePassword(password) {
    const value = String(password || '');
    if (value.length < 10 || value.length > 128 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
      throw new Error('비밀번호는 영문과 숫자를 포함해 10자 이상 입력하세요.');
    }
    return value;
  }

  async function deriveVerifier(password, salt, iterations = 310000) {
    const value = validatePassword(password);
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(salt), iterations }, material, 256);
    return bytesToBase64Url(new Uint8Array(bits));
  }

  function randomSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  }

  async function login(loginId, password, device = navigator.userAgent) {
    const challenge = await call('nexus_auth_challenge', { loginId: text(loginId).toLowerCase() });
    const verifier = await deriveVerifier(password, challenge.salt, Number(challenge.passwordKdf?.iterations || 310000));
    return applyAuthResult(await call('nexus_auth_login', { loginId: text(loginId).toLowerCase(), passwordVerifier: verifier, device }));
  }

  async function bootstrap({ loginId, displayName, password, bootstrapCode, device = navigator.userAgent }) {
    const passwordSalt = randomSalt();
    const passwordVerifier = await deriveVerifier(password, passwordSalt);
    return applyAuthResult(await call('nexus_auth_bootstrap', {
      loginId: text(loginId).toLowerCase(), displayName: text(displayName), passwordSalt,
      passwordVerifier, bootstrapCode: text(bootstrapCode), device
    }));
  }

  async function activate({ loginId, password, inviteCode, device = navigator.userAgent }) {
    const passwordSalt = randomSalt();
    const passwordVerifier = await deriveVerifier(password, passwordSalt);
    return applyAuthResult(await call('nexus_auth_activate', {
      loginId: text(loginId).toLowerCase(), passwordSalt, passwordVerifier, inviteCode: text(inviteCode), device
    }));
  }

  function readSession() {
    if (sessionRefreshPromise) return sessionRefreshPromise;
    const token = sessionToken();
    if (!token) return Promise.reject(new Error('NEXUS_AUTH_SESSION_REQUIRED'));
    sessionRefreshPromise = call('nexus_auth_session', { sessionToken: token })
      .then(result => applyAuthResult(result, token))
      .catch(error => { throw handleSessionFailure(error); })
      .finally(() => { sessionRefreshPromise = null; });
    return sessionRefreshPromise;
  }

  function scheduleSessionRefresh() {
    if (contextRefreshTimer) window.clearTimeout(contextRefreshTimer);
    contextRefreshTimer = 0;
    if (PUBLIC_PATH || !currentSession || !sessionToken()) return;
    const contextExpiresAt = Date.parse(currentBundle?.contextExpiresAt || '');
    if (!Number.isFinite(contextExpiresAt)) return;
    const delay = Math.max(1000, contextExpiresAt - Date.now() - CONTEXT_REFRESH_LEAD_MS);
    contextRefreshTimer = window.setTimeout(() => {
      contextRefreshTimer = 0;
      refreshIfNeeded({ minValidityMs: CONTEXT_REFRESH_LEAD_MS }).catch(() => {
        if (!sessionToken()) return;
        contextRefreshTimer = window.setTimeout(() => {
          contextRefreshTimer = 0;
          scheduleSessionRefresh();
        }, CONTEXT_REFRESH_RETRY_MS);
      });
    }, delay);
  }

  function refreshIfNeeded({ minValidityMs = CONTEXT_REFRESH_LEAD_MS } = {}) {
    if (PUBLIC_PATH || !sessionToken()) return Promise.resolve(currentSession);
    const margin = Math.max(15000, Number(minValidityMs) || CONTEXT_REFRESH_LEAD_MS);
    if (future(currentBundle?.contextExpiresAt, margin)) {
      scheduleSessionRefresh();
      return Promise.resolve(currentSession);
    }
    return readSession();
  }

  async function logout() {
    const token = sessionToken();
    clearAuth({ broadcast: true });
    if (token) { try { await call('nexus_auth_logout', { sessionToken: token }); } catch {} }
    location.assign(config.loginUrl || '/nexus/');
  }

  function releaseGate() { document.documentElement.dataset.nexusAuthReady = 'true'; }

  function enforcePageAccess() {
    const appId = declaredAppId();
    if (appId && !canUseApp(appId)) {
      location.replace(config.homeUrl || '/nexus/home/');
      return false;
    }
    if (location.pathname.startsWith('/nexus/admin/') && currentSession?.user?.role !== 'OWNER_MASTER') {
      location.replace(config.homeUrl || '/nexus/home/');
      return false;
    }
    return true;
  }

  async function initialize() {
    if (!endpoint) return null;
    if (!sessionToken()) {
      if (!PUBLIC_PATH) redirectToLogin();
      return null;
    }
    try {
      if (!hydrateCachedSession()) await readSession();
      if (!PUBLIC_PATH) {
        if (!enforcePageAccess()) return currentSession;
        await ensureAppContext();
        releaseGate();
      }
      return currentSession;
    } catch (error) {
      handleSessionFailure(error);
      return null;
    }
  }

  authChannel?.addEventListener('message', event => {
    if (event.data?.type === 'logout') clearAuth();
    if (event.data?.type === 'refresh') {
      refreshIfNeeded({ minValidityMs: CONTEXT_REFRESH_LEAD_MS }).catch(() => {});
    }
  });

  const refreshOnActive = () => {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    refreshIfNeeded({ minValidityMs: CONTEXT_REFRESH_LEAD_MS }).catch(() => {});
  };
  window.addEventListener('pageshow', refreshOnActive);
  document.addEventListener('visibilitychange', refreshOnActive);

  const ready = initialize();
  const adminCall = (action, body = {}) => ready.then(() => call(action, { sessionToken: sessionToken(), ...body }));

  window.ONEAPP_AUTH = Object.freeze({
    version: VERSION, ready, status: () => call('nexus_auth_status'), login, bootstrap, activate,
    readSession, refreshIfNeeded, logout, hasPermission, canUseApp, canUseGroup, gateway,
    get session() { return currentSession; },
    get appId() { return currentAppContext?.appId || ''; },
    admin: Object.freeze({
      users: () => adminCall('nexus_admin_users'), invite: payload => adminCall('nexus_admin_invite', payload),
      permissions: payload => adminCall('nexus_admin_permissions', payload),
      deleteUser: userId => adminCall('nexus_admin_delete_user', { userId }),
      recoverUser: userId => adminCall('nexus_admin_recover_user', { userId }),
      serviceStatus: () => adminCall('nexus_admin_service_status'), audit: (limit = 100) => adminCall('nexus_admin_audit', { limit })
    })
  });
})();
