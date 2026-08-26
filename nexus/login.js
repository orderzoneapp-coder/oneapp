(() => {
  const auth = window.ONEAPP_AUTH;
  const form = document.getElementById('authForm');
  const title = document.getElementById('authTitle');
  const description = document.getElementById('authDescription');
  const message = document.getElementById('authMessage');
  const submit = document.getElementById('authSubmit');
  const tabs = [...document.querySelectorAll('[data-auth-mode]')];
  let mode = 'login';
  const errorMessages = {
    NEXUS_AUTH_ENDPOINT_NOT_CONFIGURED: '인증 서버 배포가 아직 연결되지 않았습니다.',
    NEXUS_AUTH_NOT_INITIALIZED: '인증 서버 초기화가 필요합니다.',
    NEXUS_AUTH_LOGIN_DENIED: '아이디 또는 비밀번호가 올바르지 않습니다.',
    NEXUS_AUTH_RATE_LIMITED: '로그인 시도가 많습니다. 잠시 후 다시 시도하세요.',
    NEXUS_AUTH_ACTIVATION_DENIED: '아이디 또는 초대 코드가 올바르지 않습니다.',
    NEXUS_AUTH_INVITE_EXPIRED: '초대 코드가 만료되었습니다. 마스터에게 재발급을 요청하세요.',
    NEXUS_AUTH_BOOTSTRAP_DENIED: '최초 마스터 등록 코드가 올바르지 않습니다.',
    NEXUS_AUTH_BOOTSTRAP_EXPIRED: '최초 마스터 등록 코드가 만료되었습니다.',
    NEXUS_AUTH_LOGIN_ID_EXISTS: '이미 사용 중인 아이디입니다.'
  };
  const setMessage = (value, success = false) => {
    message.textContent = value || '';
    message.classList.toggle('is-success', success);
  };
  const safeReturnUrl = () => {
    const value = new URLSearchParams(location.search).get('return') || '';
    return value.startsWith('/') && !value.startsWith('//') ? value : '';
  };
  const enter = session => {
    const returnUrl = safeReturnUrl();
    if (returnUrl) return location.replace(returnUrl);
    location.replace(session.user.role === 'OWNER_MASTER' ? (window.NEXUS_AUTH_CONFIG.adminUrl || '/nexus/admin/') : (window.NEXUS_AUTH_CONFIG.homeUrl || '/nexus/home/'));
  };
  const switchMode = next => {
    mode = next;
    tabs.forEach(tab => tab.classList.toggle('is-active', tab.dataset.authMode === mode));
    document.querySelector('[data-field="displayName"]').hidden = mode !== 'bootstrap';
    document.querySelector('[data-field="inviteCode"]').hidden = mode !== 'activate';
    document.querySelector('[data-field="bootstrapCode"]').hidden = mode !== 'bootstrap';
    document.getElementById('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    title.textContent = mode === 'login' ? '로그인' : mode === 'activate' ? '초대 사용자 활성화' : '최초 마스터 등록';
    description.textContent = mode === 'login' ? '발급받은 아이디와 비밀번호를 입력하세요.' : mode === 'activate' ? '마스터가 발급한 초대 코드로 비밀번호를 설정합니다.' : '1회용 등록 코드로 유일한 마스터 계정을 만듭니다.';
    submit.textContent = mode === 'login' ? 'NEXUS 입장' : mode === 'activate' ? '계정 활성화' : '마스터 등록';
    setMessage('');
  };
  tabs.forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.authMode)));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    setMessage('보안 검증 중입니다…', true);
    try {
      const common = { loginId: document.getElementById('loginId').value, password: document.getElementById('password').value };
      let session;
      if (mode === 'login') session = await auth.login(common.loginId, common.password);
      else if (mode === 'activate') session = await auth.activate({ ...common, inviteCode: document.getElementById('inviteCode').value });
      else session = await auth.bootstrap({ ...common, displayName: document.getElementById('displayName').value, bootstrapCode: document.getElementById('bootstrapCode').value });
      setMessage('인증되었습니다. 업무 화면을 준비합니다.', true);
      enter(session);
    } catch (error) {
      setMessage(errorMessages[error.message] || error.message || '인증에 실패했습니다.');
    } finally { submit.disabled = false; }
  });
  (async () => {
    const existing = await auth.ready;
    if (existing?.user) return enter(existing);
    try {
      const status = await auth.status();
      const bootstrapTab = document.querySelector('[data-auth-mode="bootstrap"]');
      bootstrapTab.hidden = !status.requiresBootstrap;
      if (status.requiresBootstrap) switchMode('bootstrap');
    } catch (error) {
      setMessage(errorMessages[error.message] || '인증 서버 상태를 확인하지 못했습니다.');
      submit.disabled = true;
    }
  })();
})();
