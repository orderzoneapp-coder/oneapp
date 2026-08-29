import { callCompanyGateway, isCompanyAdministrator } from './company-transport.js?v=1.0.0';

(() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec';
  const STORAGE_KEY = 'oneapp.nexus.home.session.v1';
  const VISIBILITY_STORAGE_KEY = 'oneapp.nexus.ui.visibility.v1';
  const VISIBILITY_SCHEMA = 'NEXUS_UI_VISIBILITY_V1';
  const COMPANY_SNAPSHOT_KEY = 'oneapp.nexus.company.snapshot.v1';
  const REQUEST_TIMEOUT_MS = 20000;
  const APPS = Object.freeze([
    Object.freeze({ id: 'master-lookup', label: '상품관리', detail: '상품 기준정보 조회·관리', path: '/Master.html' }),
    Object.freeze({ id: 'customer-master', label: '거래처관리', detail: '거래처 기준정보 조회·관리', path: '/customer-master/' }),
    Object.freeze({ id: 'merchops', label: '가격·시세', detail: '가격·상품 운영', path: '/MerchOps.html' }),
    Object.freeze({ id: 'smart-input', label: '스마트입력', detail: '전표 작성 작업', path: '/smartinput/' }),
    Object.freeze({ id: 'orderops', label: '주문·출고', detail: '주문 및 출고 관리', path: '/orderops/list.html' }),
    Object.freeze({ id: 'dataops', label: '재고·정산', detail: '재고와 정산 분석', path: '/DataOps.html' }),
    Object.freeze({ id: 'smart-parser', label: '문서분석', detail: '외부 문서 분석', path: '/SmartParser.html' }),
    Object.freeze({ id: 'export-center', label: '출력검증', detail: '업무 자료 출력', path: '/export_center.html' }),
    Object.freeze({ id: 'settings', label: '환경설정', detail: '앱 공통 설정', path: '/settings.html' }),
    Object.freeze({ id: 'item-manager', label: '상품등록', detail: '상품 등록 및 수정', path: '/Item_manager.html' }),
    Object.freeze({ id: 'history-viewer', label: '변경이력', detail: '변경 내역 확인', path: '/history_viewer.html' }),
    Object.freeze({ id: 'orderq-vnext', label: '주문현황', detail: '확정 주문 현황', path: '/orderq/' }),
  ]);
  const SESSION_ERRORS = new Set([
    'NEXUS_AUTH_SESSION_REQUIRED',
    'NEXUS_AUTH_SESSION_EXPIRED',
    'NEXUS_AUTH_SESSION_REVOKED',
  ]);
  const ERROR_MESSAGES = Object.freeze({
    NEXUS_AUTH_LOGIN_DENIED: '아이디 또는 비밀번호가 올바르지 않습니다.',
    NEXUS_AUTH_ACTIVATION_DENIED: '아이디 또는 활성화 코드를 확인하세요.',
    NEXUS_AUTH_INVITE_EXPIRED: '활성화 코드가 만료되었습니다. 관리자에게 재발급을 요청하세요.',
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
  const activationForm = document.getElementById('activationForm');
  const loginButton = document.getElementById('loginButton');
  const activationButton = document.getElementById('activationButton');
  const activationMessage = document.getElementById('activationMessage');
  const showActivationButton = document.getElementById('showActivationButton');
  const showLoginButton = document.getElementById('showLoginButton');
  const logoutButton = document.getElementById('logoutButton');
  const loginMessage = document.getElementById('loginMessage');
  const sessionNotice = document.getElementById('sessionNotice');
  const userDisplayName = document.getElementById('userDisplayName');
  const userAccountType = document.getElementById('userAccountType');
  const adminLink = document.getElementById('adminLink');
  const appGrid = document.getElementById('appGrid');
  const companyStatus = document.getElementById('companyStatus');
  const companyName = document.getElementById('companyName');
  const companySummary = document.getElementById('companySummary');
  const companyAddress = document.getElementById('companyAddress');
  const companyNotice = document.getElementById('companyNotice');
  const companyEditLink = document.getElementById('companyEditLink');

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
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(VISIBILITY_STORAGE_KEY);
    } catch {}
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

  const visibilityFromSession = (session) => {
    const user = session?.user;
    if (user?.visibleAppsConfigured !== true || !Array.isArray(user.visibleAppIds)) {
      return Object.freeze({ schemaVersion: VISIBILITY_SCHEMA, configured: false, visibleAppIds: APPS.map((app) => app.id) });
    }
    const ids = user.visibleAppIds;
    const valid = ids.every((id, index) => typeof id === 'string'
      && APPS.some((app) => app.id === id)
      && ids.indexOf(id) === index);
    if (!valid) return Object.freeze({ schemaVersion: VISIBILITY_SCHEMA, configured: false, visibleAppIds: APPS.map((app) => app.id) });
    return Object.freeze({ schemaVersion: VISIBILITY_SCHEMA, configured: true, visibleAppIds: APPS.filter((app) => ids.includes(app.id)).map((app) => app.id) });
  };

  const setActivationMessage = (message, progress = false) => {
    activationMessage.textContent = message;
    activationMessage.classList.toggle('is-progress', progress);
  };

  const showActivation = (enabled) => {
    loginForm.hidden = enabled;
    activationForm.hidden = !enabled;
    setLoginMessage('');
    setActivationMessage('');
    document.getElementById(enabled ? 'activationLoginId' : 'loginId').focus();
  };

  const projectVisibility = (session) => {
    const projection = visibilityFromSession(session);
    try { sessionStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(projection)); } catch {}
    return projection;
  };

  const formatBusinessNumber = (value) => {
    const digits = cleanText(value).replace(/\D/g, '');
    return /^\d{10}$/.test(digits)
      ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
      : cleanText(value);
  };

  const publicCompanyProjection = (profile) => {
    if (!profile || typeof profile !== 'object') return null;
    const revision = Number(profile.revision);
    if (!cleanText(profile.companyName) || !Number.isInteger(revision) || revision < 0) return null;
    return Object.freeze({
      companyName: cleanText(profile.companyName),
      businessNumber: cleanText(profile.businessNumber),
      representativeName: cleanText(profile.representativeName),
      companyPhone: cleanText(profile.companyPhone),
      businessAddress: [cleanText(profile.address1), cleanText(profile.address2)].filter(Boolean).join(' '),
      homepage: cleanText(profile.homepage),
      revision,
    });
  };

  const validCompanySnapshot = (value) => publicCompanyProjection({
    ...value,
    address1: value?.businessAddress,
    address2: '',
  });

  const readCompanySnapshot = () => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(COMPANY_SNAPSHOT_KEY) || 'null');
      const snapshot = validCompanySnapshot(cached?.snapshot);
      return snapshot ? { snapshot, cachedAt: cleanText(cached.cachedAt) } : null;
    } catch {
      return null;
    }
  };

  const saveCompanySnapshot = (snapshot) => {
    const projected = validCompanySnapshot(snapshot);
    if (!projected) return;
    try {
      sessionStorage.setItem(COMPANY_SNAPSHOT_KEY, JSON.stringify({ snapshot: projected, cachedAt: new Date().toISOString() }));
    } catch {}
  };

  const renderCompanySnapshot = (snapshot) => {
    companyName.textContent = cleanText(snapshot.companyName) || '회사정보';
    companySummary.textContent = [
      formatBusinessNumber(snapshot.businessNumber),
      cleanText(snapshot.representativeName) ? `대표 ${cleanText(snapshot.representativeName)}` : '',
    ].filter(Boolean).join(' · ');
    companyAddress.textContent = cleanText(snapshot.businessAddress);
  };

  const setCompanyState = (status, message, snapshot = null) => {
    companyStatus.textContent = status;
    companyStatus.dataset.status = status;
    companyNotice.textContent = message;
    const projected = validCompanySnapshot(snapshot);
    if (projected) renderCompanySnapshot(projected);
    else if (status === 'ERROR') {
      companyName.textContent = '회사정보를 불러오지 못했습니다';
      companySummary.textContent = '서버 오류를 미등록 또는 0건으로 처리하지 않았습니다.';
      companyAddress.textContent = '';
    }
  };

  const showCachedCompany = () => {
    const cached = readCompanySnapshot();
    if (cached) {
      setCompanyState('STALE', '마지막 정상 Snapshot을 표시하고 서버 revision을 확인 중입니다.', cached.snapshot);
      return cached;
    }
    companyName.textContent = '서버 확인 중';
    companySummary.textContent = '회사정보와 revision을 확인하고 있습니다.';
    companyAddress.textContent = '';
    setCompanyState('STALE', '정상 Snapshot을 확인 중입니다.');
    return null;
  };

  const refreshCompany = async (sessionToken) => {
    const cached = readCompanySnapshot();
    try {
      const result = await callCompanyGateway({
        appId: 'nexus-home',
        operationId: 'company.profile_read',
        sessionToken,
        payload: {},
      });
      const snapshot = publicCompanyProjection(result?.profile);
      if (!snapshot) throw new Error('COMPANY_PROFILE_NOT_READY');
      const cachedRevision = Number(cached?.snapshot?.revision || 0);
      if (cached && snapshot.revision < cachedRevision) {
        setCompanyState('STALE', '서버 revision이 마지막 정상 Snapshot보다 낮아 기존 값을 보존했습니다.', cached.snapshot);
        return;
      }
      if (cached && snapshot.revision === cachedRevision) {
        setCompanyState('READY', `서버 revision ${snapshot.revision}과 일치합니다.`, cached.snapshot);
        return;
      }
      saveCompanySnapshot(snapshot);
      setCompanyState('READY', `서버 revision ${snapshot.revision}을 확인했습니다.`, snapshot);
    } catch {
      if (cached) {
        setCompanyState('STALE', '서버 확인이 지연되어 마지막 정상 Snapshot을 유지합니다.', cached.snapshot);
      } else {
        setCompanyState('ERROR', '회사정보 서버에 연결하지 못했습니다.');
      }
    }
  };

  const showLogin = (message = '') => {
    homePanel.hidden = true;
    homeActions.hidden = true;
    loginPanel.hidden = false;
    userDisplayName.textContent = '';
    userAccountType.textContent = '';
    sessionNotice.textContent = '';
    companyEditLink.hidden = true;
    adminLink.hidden = true;
    setLoginMessage(message);
  };

  const showHome = (session) => {
    const user = session?.user;
    if (!user) return showLogin();
    userDisplayName.textContent = cleanText(user.displayName) || cleanText(user.loginId) || '사용자';
    userAccountType.textContent = accountTypeLabel(cleanText(user.role));
    adminLink.hidden = cleanText(user.role) !== 'OWNER_MASTER';
    companyEditLink.hidden = !isCompanyAdministrator(session);
    const visibility = projectVisibility(session);
    renderApps(visibility.visibleAppIds);
    showCachedCompany();
    loginPanel.hidden = true;
    homePanel.hidden = false;
    homeActions.hidden = false;
  };

  const renderApps = (visibleAppIds = APPS.map((app) => app.id)) => {
    const visible = new Set(visibleAppIds);
    const fragment = document.createDocumentFragment();
    APPS.filter((app) => visible.has(app.id)).forEach((app) => {
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
    return { token, session };
  };

  const activate = async (loginId, activationCode, password) => {
    const passwordSalt = new Uint8Array(16);
    crypto.getRandomValues(passwordSalt);
    const passwordVerifier = await deriveVerifier(password, bytesToBase64Url(passwordSalt), 310000);
    const result = await callAuth('nexus_auth_activate', {
      loginId: cleanText(loginId).toLowerCase(),
      inviteCode: cleanText(activationCode),
      passwordSalt: bytesToBase64Url(passwordSalt),
      passwordVerifier,
      device: navigator.userAgent,
    });
    const session = sessionFromResponse(result);
    const token = cleanText(result?.sessionToken);
    if (!token || !session) throw new Error('NEXUS_AUTH_RESPONSE_INVALID');
    saveCachedSession(token, session);
    return { token, session };
  };

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const loginId = document.getElementById('loginId').value;
    const password = document.getElementById('password').value;
    loginButton.disabled = true;
    setLoginMessage('로그인 정보를 확인하고 있습니다.', true);
    try {
      const authenticated = await login(loginId, password);
      loginForm.reset();
      setLoginMessage('');
      showHome(authenticated.session);
      setTimeout(() => refreshCompany(authenticated.token), 0);
    } catch (error) {
      setLoginMessage(messageFor(error));
    } finally {
      loginButton.disabled = false;
    }
  });

  showActivationButton.addEventListener('click', () => showActivation(true));
  showLoginButton.addEventListener('click', () => showActivation(false));

  activationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const loginId = document.getElementById('activationLoginId').value;
    const activationCode = document.getElementById('activationCode').value;
    const password = document.getElementById('activationPassword').value;
    const passwordConfirm = document.getElementById('activationPasswordConfirm').value;
    if (password !== passwordConfirm) {
      setActivationMessage('새 비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    activationButton.disabled = true;
    setActivationMessage('계정을 활성화하고 있습니다.', true);
    try {
      const authenticated = await activate(loginId, activationCode, password);
      activationForm.reset();
      showActivation(false);
      showHome(authenticated.session);
      setTimeout(() => refreshCompany(authenticated.token), 0);
    } catch (error) {
      setActivationMessage(messageFor(error));
    } finally {
      activationButton.disabled = false;
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
    setTimeout(() => {
      refreshSession(cached);
      refreshCompany(cached.token);
    }, 0);
  } else {
    showLogin();
  }
})();
