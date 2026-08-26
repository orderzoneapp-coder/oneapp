(() => {
  'use strict';

  const VERSION = '2.0.0';
  const CONTRACT_VERSION = 'NEXUS_AUTH_V2';
  const config = window.NEXUS_AUTH_CONFIG || {};
  const endpoint = String(config.endpoint || '').trim();
  const nativeFetch = window.fetch.bind(window);
  const SESSION_KEY = 'oneapp.nexus.auth.session.v1';
  const LOGIN_PATHS = new Set(['/nexus/', '/nexus/index.html']);
  const PUBLIC_PATH = LOGIN_PATHS.has(location.pathname);
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

  if (!PUBLIC_PATH) {
    document.documentElement.dataset.nexusAuthPending = 'true';
    const style = document.createElement('style');
    style.dataset.nexusAuthGuard = 'true';
    style.textContent = `html[data-nexus-auth-pending="true"] body{visibility:hidden!important}#nexusAuthGate{visibility:visible!important;position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;background:#07111e;color:#eaf2ff;font:700 13px Inter,Pretendard,"Noto Sans KR",sans-serif}#nexusAuthGate span{display:block;margin-top:10px;color:#8fa2b9;font-weight:500}`;
    document.documentElement.appendChild(style);
  }

  const text = value => String(value ?? '').trim();
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
  const sessionToken = () => {
    try { return text(sessionStorage.getItem(SESSION_KEY)); }
    catch { return ''; }
  };
  const saveSessionToken = value => {
    try {
      if (value) sessionStorage.setItem(SESSION_KEY, value);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {}
  };

  async function call(action, body = {}, options = {}) {
    if (!endpoint) throw new Error('NEXUS_AUTH_ENDPOINT_NOT_CONFIGURED');
    if (config.contractVersion !== CONTRACT_VERSION) throw new Error('NEXUS_AUTH_MIXED_CACHE_DENIED');
    const response = await nativeFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...body }),
      redirect: 'follow',
      cache: 'no-store',
      signal: options.signal
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

  async function gateway(operationId, payload = {}, options = {}) {
    const operation = text(operationId);
    if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(operation)) throw new Error('NEXUS_GATEWAY_OPERATION_INVALID');
    validateGatewayPayload(payload);
    await ready;
    const token = sessionToken();
    if (!currentSession || !token) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    const response = await nativeFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'nexus_gateway', sessionToken: token,
        appContextToken: currentAppContext?.appContextToken || '', operationId: operation, payload
      }),
      redirect: 'follow',
      cache: 'no-store',
      signal: options.signal
    });
    if (!response.ok) throw new Error(`NEXUS_GATEWAY_HTTP_${response.status}`);
    let result;
    try { result = await response.json(); }
    catch { throw new Error('NEXUS_GATEWAY_RESPONSE_INVALID'); }
    if (!result || result.status !== 'success' || result.contractVersion !== CONTRACT_VERSION || result.operationId !== operation) {
      throw new Error(text(result?.message) || 'NEXUS_GATEWAY_REQUEST_FAILED');
    }
    return result.data;
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

  function applyAuthResult(result) {
    if (!result?.sessionToken || !result?.session?.user) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
    saveSessionToken(result.sessionToken);
    currentSession = result.session;
    currentAppContext = null;
    window.dispatchEvent(new CustomEvent('nexus-auth-ready', { detail: currentSession }));
    return currentSession;
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

  async function readSession() {
    const token = sessionToken();
    if (!token) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    currentSession = await call('nexus_auth_session', { sessionToken: token });
    currentAppContext = null;
    window.dispatchEvent(new CustomEvent('nexus-auth-ready', { detail: currentSession }));
    return currentSession;
  }

  async function logout() {
    const token = sessionToken();
    saveSessionToken('');
    currentSession = null;
    currentAppContext = null;
    if (token) {
      try { await call('nexus_auth_logout', { sessionToken: token }); } catch {}
    }
    location.assign(config.loginUrl || '/nexus/');
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
  function gateMessage(message) {
    let gate = document.getElementById('nexusAuthGate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'nexusAuthGate';
      document.documentElement.appendChild(gate);
    }
    gate.innerHTML = `<div>NEXUS 보안 세션 확인 중<span>${String(message || '로그인 상태를 확인합니다.')}</span></div>`;
  }

  function releaseGate() {
    delete document.documentElement.dataset.nexusAuthPending;
    document.documentElement.dataset.nexusAuthReady = 'true';
    document.getElementById('nexusAuthGate')?.remove();
  }

  function redirectToLogin() {
    const returnUrl = `${location.pathname}${location.search}${location.hash}`;
    location.replace(`${config.loginUrl || '/nexus/'}?return=${encodeURIComponent(returnUrl)}`);
  }

  async function initialize() {
    if (!endpoint) {
      if (!PUBLIC_PATH) gateMessage('인증 서버 배포 주소가 아직 설정되지 않았습니다.');
      return null;
    }
    try {
      if (!sessionToken()) {
        if (!PUBLIC_PATH) redirectToLogin();
        return null;
      }
      const session = await readSession();
      if (!PUBLIC_PATH) {
        const declaredApp = declaredAppId();
        if (declaredApp && !canUseApp(declaredApp)) {
          location.replace(config.homeUrl || '/nexus/home/');
          return session;
        }
        if (declaredApp) {
          currentAppContext = await call('nexus_auth_app_context', {
            sessionToken: sessionToken(), appId: declaredApp
          });
          if (currentAppContext?.appId !== declaredApp || !currentAppContext?.appContextToken) throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED');
        }
        if (location.pathname.startsWith('/nexus/admin/') && session.user.role !== 'OWNER_MASTER') {
          location.replace(config.homeUrl || '/nexus/home/');
          return session;
        }
        releaseGate();
      }
      return session;
    } catch (error) {
      saveSessionToken('');
      currentSession = null;
      if (!PUBLIC_PATH) redirectToLogin();
      return null;
    }
  }

  if (!PUBLIC_PATH) gateMessage();
  const ready = initialize();
  const adminCall = (action, body = {}) => ready.then(() => call(action, { sessionToken: sessionToken(), ...body }));

  window.ONEAPP_AUTH = Object.freeze({
    version: VERSION, ready, status: () => call('nexus_auth_status'), login, bootstrap, activate,
    readSession, logout, hasPermission, canUseApp, canUseGroup, gateway,
    get session() { return currentSession; },
    get appId() { return currentAppContext?.appId || ''; },
    admin: Object.freeze({
      users: () => adminCall('nexus_admin_users'),
      invite: payload => adminCall('nexus_admin_invite', payload),
      permissions: payload => adminCall('nexus_admin_permissions', payload),
      deleteUser: userId => adminCall('nexus_admin_delete_user', { userId }),
      recoverUser: userId => adminCall('nexus_admin_recover_user', { userId }),
      serviceStatus: () => adminCall('nexus_admin_service_status'),
      audit: (limit = 100) => adminCall('nexus_admin_audit', { limit })
    })
  });
})();
