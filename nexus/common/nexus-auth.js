(() => {
  'use strict';

  const VERSION = '1.0.0';
  const config = window.NEXUS_AUTH_CONFIG || {};
  const endpoint = String(config.endpoint || '').trim();
  const nativeFetch = window.fetch.bind(window);
  const SESSION_KEY = 'oneapp.nexus.auth.session.v1';
  const LOGIN_PATHS = new Set(['/nexus/', '/nexus/index.html']);
  const PUBLIC_PATH = LOGIN_PATHS.has(location.pathname);
  const APP_PERMISSIONS = Object.freeze({
    master: 'foundation.read', 'item-manager': 'foundation.write', 'customer-manager': 'foundation.write',
    merchops: 'merchops.read', 'smart-parser': 'merchops.read', dataops: 'dataops.read',
    orderq: 'orderq.read', orderops: 'orderq.read', orderin: 'orderq.write', 'smart-input': 'smartinput.use'
  });
  const GROUP_PERMISSIONS = Object.freeze({
    foundation: 'foundation.read', pricing: 'merchops.read', shipping: 'orderq.read', inventory: 'dataops.read'
  });
  let currentSession = null;

  if (!PUBLIC_PATH) {
    document.documentElement.dataset.nexusAuthPending = 'true';
    const style = document.createElement('style');
    style.dataset.nexusAuthGuard = 'true';
    style.textContent = `html[data-nexus-auth-pending="true"] body{visibility:hidden!important}#nexusAuthGate{visibility:visible!important;position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;background:#07111e;color:#eaf2ff;font:700 13px Inter,Pretendard,"Noto Sans KR",sans-serif}#nexusAuthGate span{display:block;margin-top:10px;color:#8fa2b9;font-weight:500}`;
    document.documentElement.appendChild(style);
  }

  const text = value => String(value ?? '').trim();
  const normalizeEndpoint = value => text(value).replace(/\/+$/, '');
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
    window.dispatchEvent(new CustomEvent('nexus-auth-ready', { detail: currentSession }));
    return currentSession;
  }

  async function logout() {
    const token = sessionToken();
    saveSessionToken('');
    currentSession = null;
    if (token) {
      try { await call('nexus_auth_logout', { sessionToken: token }); } catch {}
    }
    location.assign(config.loginUrl || '/nexus/');
  }

  function permissions() { return Array.isArray(currentSession?.user?.permissions) ? currentSession.user.permissions : []; }
  function hasPermission(permission) {
    return currentSession?.user?.role === 'OWNER_MASTER' || permissions().includes(permission);
  }
  function canUseApp(appId) { return hasPermission(APP_PERMISSIONS[appId] || 'foundation.read'); }
  function canUseGroup(groupId) { return hasPermission(GROUP_PERMISSIONS[groupId] || 'foundation.read'); }
  function businessCredential(purpose = 'GENERAL') {
    const user = currentSession?.user;
    if (!user) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    return {
      token: `NEXUS_GATEWAY_${text(purpose).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`, actorId: user.loginId, deviceId: 'NEXUS_BROWSER',
      device: 'NEXUS_BROWSER', environment: 'PRODUCTION', scope: { companyId: 'ONEAPP' }
    };
  }

  function shouldProxy(input) {
    const url = text(typeof input === 'string' || input instanceof URL ? input : input?.url);
    if (!/^https:\/\/script\.google\.com\/macros\/s\//i.test(url)) return false;
    return normalizeEndpoint(url) !== normalizeEndpoint(endpoint);
  }

  async function proxyFetch(input, init = {}) {
    if (!shouldProxy(input)) return nativeFetch(input, init);
    await ready;
    if (!currentSession) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    const url = new URL(text(typeof input === 'string' || input instanceof URL ? input : input.url));
    const method = text(init.method || input?.method || 'GET').toUpperCase();
    let body = {};
    if (method === 'POST') {
      let rawBody = init.body;
      if (rawBody === undefined && input instanceof Request) rawBody = await input.clone().text();
      try { body = JSON.parse(String(rawBody || '{}')); }
      catch { throw new Error('NEXUS_PROXY_PAYLOAD_INVALID'); }
    }
    const action = text(body.action || url.searchParams.get('action') || (method === 'GET' ? 'full' : ''));
    return nativeFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'nexus_proxy', sessionToken: sessionToken(), request: { method, action, body } }),
      redirect: 'follow', cache: 'no-store', signal: init.signal
    });
  }

  window.fetch = proxyFetch;

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
        const declaredApp = document.querySelector('nexus-top')?.getAttribute('app-id');
        if (declaredApp && !canUseApp(declaredApp)) {
          location.replace(config.homeUrl || '/nexus/home/');
          return session;
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
    readSession, logout, hasPermission, canUseApp, canUseGroup, businessCredential,
    get session() { return currentSession; },
    admin: Object.freeze({
      users: () => adminCall('nexus_admin_users'),
      invite: payload => adminCall('nexus_admin_invite', payload),
      permissions: payload => adminCall('nexus_admin_permissions', payload),
      deleteUser: userId => adminCall('nexus_admin_delete_user', { userId }),
      recoverUser: userId => adminCall('nexus_admin_recover_user', { userId }),
      serviceStatus: () => adminCall('nexus_admin_service_status'),
      configureServices: services => adminCall('nexus_admin_configure_services', { services }),
      audit: (limit = 100) => adminCall('nexus_admin_audit', { limit })
    })
  });
})();
