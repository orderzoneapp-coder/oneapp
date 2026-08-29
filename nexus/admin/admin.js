(() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec';
  const SESSION_KEY = 'oneapp.nexus.home.session.v1';
  const VISIBILITY_KEY = 'oneapp.nexus.ui.visibility.v1';
  const REQUEST_TIMEOUT_MS = 20000;
  const APPS = Object.freeze([
    Object.freeze({ id: 'master-lookup', label: '상품관리' }),
    Object.freeze({ id: 'customer-master', label: '거래처관리' }),
    Object.freeze({ id: 'merchops', label: '가격·시세' }),
    Object.freeze({ id: 'smart-input', label: '스마트입력' }),
    Object.freeze({ id: 'orderops', label: '주문·출고' }),
    Object.freeze({ id: 'dataops', label: '재고·정산' }),
    Object.freeze({ id: 'smart-parser', label: '문서분석' }),
    Object.freeze({ id: 'export-center', label: '출력검증' }),
    Object.freeze({ id: 'settings', label: '환경설정' }),
    Object.freeze({ id: 'item-manager', label: '상품등록' }),
    Object.freeze({ id: 'history-viewer', label: '변경이력' }),
    Object.freeze({ id: 'orderq-vnext', label: '주문현황' }),
  ]);
  const MESSAGE = Object.freeze({
    NEXUS_AUTH_ADMIN_DENIED: '최상위 관리자 Session이 필요합니다.',
    NEXUS_AUTH_SESSION_REQUIRED: '로그인 후 다시 시도하세요.',
    NEXUS_AUTH_SESSION_EXPIRED: '로그인 시간이 만료되었습니다.',
    NEXUS_AUTH_SESSION_REVOKED: '회수된 Session입니다. 다시 로그인하세요.',
    NEXUS_AUTH_LOGIN_ID_EXISTS: '이미 사용 중인 로그인 아이디입니다.',
    NEXUS_AUTH_VERSION_CONFLICT: '다른 변경이 먼저 저장되었습니다. 목록을 새로고침했습니다.',
    NEXUS_AUTH_ACTIVATION_REQUIRED: '활성화 전 사용자는 코드 재발급으로 진행하세요.',
    NEXUS_AUTH_VISIBLE_APPS_INVALID: '앱 노출 설정을 확인하세요.',
    NEXUS_AUTH_NETWORK: '로그인 서버에 연결하지 못했습니다.',
    NEXUS_AUTH_TIMEOUT: '로그인 서버 응답이 지연되고 있습니다.',
  });

  const adminPanel = document.getElementById('adminPanel');
  const accessDenied = document.getElementById('accessDenied');
  const adminMessage = document.getElementById('adminMessage');
  const createUserForm = document.getElementById('createUserForm');
  const createAppPicker = document.getElementById('createAppPicker');
  const userList = document.getElementById('userList');
  const auditList = document.getElementById('auditList');
  const activationResult = document.getElementById('activationResult');
  const activationCodeOutput = document.getElementById('activationCodeOutput');
  let cached = null;

  const cleanText = (value) => String(value ?? '').trim();
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const messageFor = (error) => MESSAGE[cleanText(error?.message)] || '요청을 처리하지 못했습니다. 다시 시도하세요.';
  const setMessage = (message, progress = false) => {
    adminMessage.textContent = message;
    adminMessage.classList.toggle('is-progress', progress);
  };

  const clearSession = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(VISIBILITY_KEY);
    } catch {}
    cached = null;
  };

  const readSession = () => {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (!cleanText(value?.token) || !value?.session?.user) return null;
      return value;
    } catch {
      return null;
    }
  };

  const callAuth = async (action, body = {}) => {
    if (!cached?.token) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, sessionToken: cached.token, ...body }),
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NEXUS_AUTH_HTTP_${response.status}`);
      const result = await response.json();
      if (!result || result.status !== 'success') throw new Error(cleanText(result?.message) || 'NEXUS_AUTH_RESPONSE_INVALID');
      return result.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('NEXUS_AUTH_TIMEOUT');
      if (/^NEXUS_AUTH_/.test(cleanText(error?.message))) throw error;
      throw new Error('NEXUS_AUTH_NETWORK');
    } finally {
      clearTimeout(timeout);
    }
  };

  const makeAppPicker = (container, selectedIds, disabled = false) => {
    const selected = new Set(selectedIds);
    const fragment = document.createDocumentFragment();
    APPS.forEach((app) => {
      const label = element('label', 'nexus-app-choice');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = app.id;
      checkbox.checked = selected.has(app.id);
      checkbox.disabled = disabled;
      label.append(checkbox, element('span', '', app.label));
      fragment.appendChild(label);
    });
    container.replaceChildren(fragment);
  };

  const selectedApps = (container) => Array.from(container.querySelectorAll('input[type="checkbox"]:checked'), (input) => input.value);

  const actionButton = (label, className = 'nexus-quiet-button') => {
    const button = element('button', className, label);
    button.type = 'button';
    return button;
  };

  const runMutation = async (button, action, user) => {
    button.disabled = true;
    setMessage('변경사항을 저장하고 있습니다.', true);
    try {
      const result = await callAuth(action, { userId: user.userId, expectedVersion: user.version });
      if (result?.activationCode) showActivationCode(result.activationCode);
      await refreshAll();
      setMessage('변경사항을 저장했습니다.');
    } catch (error) {
      setMessage(messageFor(error));
      if (cleanText(error?.message) === 'NEXUS_AUTH_VERSION_CONFLICT') await refreshAll();
    } finally {
      button.disabled = false;
    }
  };

  const renderUser = (user) => {
    const article = element('article', 'nexus-user-card');
    const heading = element('div', 'nexus-user-card__heading');
    const identity = element('div');
    identity.append(element('strong', '', user.displayName), element('span', '', user.loginId));
    const status = element('span', 'nexus-user-status', user.status === 'ACTIVE' ? '사용 중' : '사용 중지');
    status.dataset.status = user.status;
    heading.append(identity, status);
    article.appendChild(heading);

    if (user.accountType === 'OWNER_MASTER') {
      article.appendChild(element('p', 'nexus-user-card__note', '최상위 관리자 계정은 이 화면에서 변경하거나 중지할 수 없습니다.'));
      return article;
    }

    const form = element('form', 'nexus-user-edit');
    const nameLabel = element('label', '', '표시 이름');
    const nameInput = document.createElement('input');
    nameInput.name = 'displayName';
    nameInput.value = cleanText(user.displayName);
    nameInput.maxLength = 60;
    nameInput.required = true;
    nameLabel.appendChild(nameInput);
    const fieldset = element('fieldset', 'nexus-app-picker');
    fieldset.appendChild(element('legend', '', '표시할 앱'));
    const picker = element('div', 'nexus-app-picker__grid');
    makeAppPicker(picker, user.visibleAppIds || []);
    fieldset.appendChild(picker);
    const controls = element('div', 'nexus-user-controls');
    const save = actionButton('이름·노출 저장', 'nexus-primary-button nexus-user-save');
    save.type = 'submit';
    controls.appendChild(save);
    if (user.status === 'ACTIVE') {
      const suspend = actionButton('사용 중지');
      suspend.addEventListener('click', () => runMutation(suspend, 'nexus_admin_user_suspend', user));
      controls.appendChild(suspend);
    } else if (user.activationPending) {
      const reissue = actionButton('활성화 코드 재발급');
      reissue.addEventListener('click', () => runMutation(reissue, 'nexus_admin_activation_reissue', user));
      controls.appendChild(reissue);
    } else {
      const restore = actionButton('사용 복구');
      restore.addEventListener('click', () => runMutation(restore, 'nexus_admin_user_restore', user));
      controls.appendChild(restore);
    }
    form.append(nameLabel, fieldset, controls);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      setMessage('사용자 정보를 저장하고 있습니다.', true);
      try {
        await callAuth('nexus_admin_user_update', {
          userId: user.userId,
          expectedVersion: user.version,
          displayName: nameInput.value,
          visibleAppIds: selectedApps(picker),
        });
        await refreshAll();
        setMessage('사용자 정보를 저장했습니다.');
      } catch (error) {
        setMessage(messageFor(error));
        if (cleanText(error?.message) === 'NEXUS_AUTH_VERSION_CONFLICT') await refreshAll();
      } finally {
        save.disabled = false;
      }
    });
    article.appendChild(form);
    return article;
  };

  const renderUsers = (users) => {
    const fragment = document.createDocumentFragment();
    users.forEach((user) => fragment.appendChild(renderUser(user)));
    userList.replaceChildren(fragment);
  };

  const renderAudit = (rows) => {
    const fragment = document.createDocumentFragment();
    rows.forEach((row) => {
      const item = element('li', 'nexus-audit-item');
      const heading = element('div', 'nexus-audit-item__heading');
      heading.append(element('strong', '', cleanText(row.action)), element('time', '', cleanText(row.at)));
      const context = [cleanText(row.actorUserId), cleanText(row.targetUserId)].filter(Boolean).join(' → ');
      item.append(heading, element('p', '', context || 'SYSTEM'));
      fragment.appendChild(item);
    });
    auditList.replaceChildren(fragment);
  };

  const refreshAll = async () => {
    const [users, audit] = await Promise.all([
      callAuth('nexus_admin_users'),
      callAuth('nexus_admin_audit', { limit: 50 }),
    ]);
    renderUsers(Array.isArray(users) ? users : []);
    renderAudit(Array.isArray(audit) ? audit : []);
  };

  const showActivationCode = (value) => {
    activationCodeOutput.textContent = cleanText(value);
    activationResult.hidden = false;
    activationResult.focus?.();
  };

  createUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = createUserForm.querySelector('button[type="submit"]');
    const fields = new FormData(createUserForm);
    submit.disabled = true;
    activationResult.hidden = true;
    activationCodeOutput.textContent = '';
    setMessage('사용자를 추가하고 있습니다.', true);
    try {
      const result = await callAuth('nexus_admin_user_create', {
        loginId: cleanText(fields.get('loginId')).toLowerCase(),
        displayName: cleanText(fields.get('displayName')),
        visibleAppIds: selectedApps(createAppPicker),
      });
      showActivationCode(result.activationCode);
      createUserForm.reset();
      makeAppPicker(createAppPicker, APPS.map((app) => app.id));
      await refreshAll();
      setMessage('사용자를 추가했습니다. 활성화 코드는 한 번만 전달하세요.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('refreshButton').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    setMessage('최신 정보를 확인하고 있습니다.', true);
    try {
      await refreshAll();
      setMessage('최신 정보를 확인했습니다.');
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  document.getElementById('logoutButton').addEventListener('click', () => {
    const token = cached?.token;
    clearSession();
    if (token) {
      cached = { token };
      callAuth('nexus_auth_logout').finally(() => {
        clearSession();
        location.href = '/nexus/';
      });
    } else {
      location.href = '/nexus/';
    }
  });

  const initialize = async () => {
    makeAppPicker(createAppPicker, APPS.map((app) => app.id));
    cached = readSession();
    if (!cached || cleanText(cached.session.user.role) !== 'OWNER_MASTER') {
      accessDenied.hidden = false;
      return;
    }
    try {
      const refreshed = await callAuth('nexus_auth_session');
      const session = refreshed?.session?.user ? refreshed.session : refreshed?.user ? refreshed : null;
      if (!session || cleanText(session.user.role) !== 'OWNER_MASTER') throw new Error('NEXUS_AUTH_ADMIN_DENIED');
      cached.session = session;
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(cached)); } catch {}
      adminPanel.hidden = false;
      await refreshAll();
    } catch (error) {
      setMessage(messageFor(error));
      accessDenied.hidden = false;
    }
  };

  initialize();
})();
