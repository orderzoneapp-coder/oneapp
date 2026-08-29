(() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec';
  const STORAGE_KEY = 'oneapp.nexus.home.session.v1';
  const REQUEST_TIMEOUT_MS = 20000;
  const APPS = Object.freeze([
    Object.freeze({ label: '기준정보', detail: '상품 기준정보 조회', path: '/Master.html' }),
    Object.freeze({ label: '가격·시세', detail: '가격·상품 운영', path: '/MerchOps.html' }),
    Object.freeze({ label: '스마트입력', detail: '전표 작성 작업', path: '/smartinput/' }),
    Object.freeze({ label: '주문·출고', detail: '주문 및 출고 관리', path: '/orderops/list.html' }),
    Object.freeze({ label: '재고·정산', detail: '재고와 정산 분석', path: '/DataOps.html' }),
    Object.freeze({ label: '문서분석', detail: '외부 문서 분석', path: '/SmartParser.html' }),
    Object.freeze({ label: '출력검증', detail: '업무 자료 출력', path: '/export_center.html' }),
    Object.freeze({ label: '환경설정', detail: '앱 공통 설정', path: '/settings.html' }),
    Object.freeze({ label: '상품등록', detail: '상품 등록 및 수정', path: '/Item_manager.html' }),
    Object.freeze({ label: '변경이력', detail: '변경 내역 확인', path: '/history_viewer.html' }),
    Object.freeze({ label: '주문현황', detail: '확정 주문 현황', path: '/orderq/' }),
  ]);
  const SESSION_ERRORS = new Set([
    'NEXUS_AUTH_SESSION_REQUIRED',
    'NEXUS_AUTH_SESSION_EXPIRED',
    'NEXUS_AUTH_SESSION_REVOKED',
  ]);
  const ERROR_MESSAGES = Object.freeze({
    NEXUS_AUTH_LOGIN_DENIED: '아이디 또는 비밀번호가 올바르지 않습니다.',
    NEXUS_AUTH_RATE_LIMITED: '로그인 시도가 많습니다. 잠시 후 다시 시도하세요.',
    NEXUS_AUTH_NOT_INITIALIZED: '로그인 서버가 아직 준비되지 않았습니다.',
    NEXUS_AUTH_ENDPOINT_NOT_CONFIGURED: '로그인 서버 연결 정보가 없습니다.',
    NEXUS_AUTH_NETWORK: '로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
    NEXUS_AUTH_TIMEOUT: '로그인 서버 응답이 지연되고 있습니다. 다시 시도하세요.',
    NEXUS_AUTH_RESPONSE_INVALID: '로그인 서버 응답을 확인할 수 없습니다.',
  });

  const loginPanel = document.getElementById('loginPanel');
  const homePanel = document.getElementById('homePanel');
  const homeActions = document.getElementById('homeActions');
  const loginForm = document.getElementById('loginForm');
  const loginButton = document.getElementById('loginButton');
  const logoutButton = document.getElementById('logoutButton');
  const loginMessage = document.getElementById('loginMessage');
  const sessionNotice = document.getElementById('sessionNotice');
  const userDisplayName = document.getElementById('userDisplayName');
  const userAccountType = document.getElementById('userAccountType');
  const appGrid = document.getElementById('appGrid');

  const cleanText = (value) => String(value ?? '').trim();

  const bytesToBase64Url = (bytes) => {
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  const base64UrlToBytes = (value) => {
    const normalized = cleanText(value).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

  const messageFor = (error) => ERROR_MESSAGES[cleanText(error?.message)]
    || '로그인 처리 중 문제가 발생했습니다. 다시 시도하세요.';

  const setLoginMessage = (message, progress = false) => {
    loginMessage.textContent = message;
    loginMessage.classList.toggle('is-progress', progress);
  };

  const clearCachedSession = () => {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
  };

  const saveCachedSession = (token, session) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, session }));
    } catch {}
  };

  const readCachedSession = () => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      const expiresAt = Date.parse(cached?.session?.expiresAt || '');
      if (!cleanText(cached?.token) || !cached?.session?.user || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        clearCachedSession();
        return null;
      }
      return cached;
    } catch {
      clearCachedSession();
      return null;
    }
  };

  const callAuth = async (action, body = {}) => {
    if (!AUTH_ENDPOINT) throw new Error('NEXUS_AUTH_ENDPOINT_NOT_CONFIGURED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...body }),
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NEXUS_AUTH_HTTP_${response.status}`);
      const result = await response.json();
      if (!result || result.status !== 'success') {
        throw new Error(cleanText(result?.message) || 'NEXUS_AUTH_RESPONSE_INVALID');
      }
      return result.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('NEXUS_AUTH_TIMEOUT');
      if (/^NEXUS_AUTH_/.test(cleanText(error?.message))) throw error;
      throw new Error('NEXUS_AUTH_NETWORK');
    } finally {
      clearTimeout(timeout);
    }
  };

  const deriveVerifier = async (password, salt, iterations) => {
    if (!crypto?.subtle) throw new Error('NEXUS_AUTH_CRYPTO_UNAVAILABLE');
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64UrlToBytes(salt),
      iterations,
    }, material, 256);
    return bytesToBase64Url(new Uint8Array(bits));
  };

  const sessionFromResponse = (result) => {
    if (result?.session?.user) return result.session;
    if (result?.user) return result;
    return null;
  };

  const accountTypeLabel = (role) => role === 'OWNER_MASTER' ? 'MASTER' : '위임 사용자';

  const showLogin = (message = '') => {
    homePanel.hidden = true;
    homeActions.hidden = true;
    loginPanel.hidden = false;
    userDisplayName.textContent = '';
    userAccountType.textContent = '';
    sessionNotice.textContent = '';
    setLoginMessage(message);
  };

  const showHome = (session) => {
    const user = session?.user;
    if (!user) return showLogin();
    userDisplayName.textContent = cleanText(user.displayName) || cleanText(user.loginId) || '사용자';
    userAccountType.textContent = accountTypeLabel(cleanText(user.role));
    loginPanel.hidden = true;
    homePanel.hidden = false;
    homeActions.hidden = false;
  };

  const renderApps = () => {
    const fragment = document.createDocumentFragment();
    APPS.forEach((app) => {
      const link = document.createElement('a');
      const name = document.createElement('strong');
      const detail = document.createElement('span');
      link.className = 'nexus-app-card';
      link.href = app.path;
      name.textContent = app.label;
      detail.textContent = app.detail;
      link.append(name, detail);
      fragment.appendChild(link);
    });
    appGrid.replaceChildren(fragment);
  };

  const refreshSession = async (cached) => {
    try {
      const result = await callAuth('nexus_auth_session', { sessionToken: cached.token });
      const session = sessionFromResponse(result);
      if (!session) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
      saveCachedSession(cached.token, session);
      showHome(session);
      sessionNotice.textContent = '';
    } catch (error) {
      if (SESSION_ERRORS.has(cleanText(error?.message))) {
        clearCachedSession();
        showLogin('로그인 시간이 만료되었습니다. 다시 로그인하세요.');
        return;
      }
      sessionNotice.textContent = '서버 확인이 지연되어 마지막 로그인 정보로 표시 중입니다.';
    }
  };

  const login = async (loginId, password) => {
    const normalizedLoginId = cleanText(loginId).toLowerCase();
    const challenge = await callAuth('nexus_auth_challenge', { loginId: normalizedLoginId });
    const iterations = Number(challenge?.passwordKdf?.iterations || 310000);
    const verifier = await deriveVerifier(password, challenge?.salt, iterations);
    const result = await callAuth('nexus_auth_login', {
      loginId: normalizedLoginId,
      passwordVerifier: verifier,
      device: navigator.userAgent,
    });
    const session = sessionFromResponse(result);
    const token = cleanText(result?.sessionToken);
    if (!token || !session) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
    saveCachedSession(token, session);
    return session;
  };

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const loginId = document.getElementById('loginId').value;
    const password = document.getElementById('password').value;
    loginButton.disabled = true;
    setLoginMessage('로그인 정보를 확인하고 있습니다.', true);
    try {
      const session = await login(loginId, password);
      loginForm.reset();
      setLoginMessage('');
      showHome(session);
    } catch (error) {
      setLoginMessage(messageFor(error));
    } finally {
      loginButton.disabled = false;
    }
  });

  logoutButton.addEventListener('click', () => {
    const cached = readCachedSession();
    clearCachedSession();
    showLogin('로그아웃되었습니다.');
    document.getElementById('loginId').focus();
    if (cached?.token) {
      callAuth('nexus_auth_logout', { sessionToken: cached.token }).catch(() => {});
    }
  });

  renderApps();
  const cached = readCachedSession();
  if (cached) {
    showHome(cached.session);
    setTimeout(() => refreshSession(cached), 0);
  } else {
    showLogin();
  }
})();
