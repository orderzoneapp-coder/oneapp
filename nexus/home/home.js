(() => {
  const apps = [
    { id:'master', permission:'foundation.read', eyebrow:'FOUNDATION', name:'기준정보', description:'상품·거래처 기준정보를 조회하고 관리합니다.', url:'/Master.html' },
    { id:'merchops', permission:'merchops.read', eyebrow:'MERCH OPS', name:'가격·시세', description:'가격 정책과 프로모션 자료를 검토합니다.', url:'/MerchOps.html' },
    { id:'smart-input', permission:'smartinput.use', eyebrow:'SMART INPUT', name:'스마트입력', description:'주문·구매·판매 문서를 통합 입력합니다.', url:'/smartinput/' },
    { id:'orderq', permission:'orderq.read', eyebrow:'ORDER Q', name:'주문·출고', description:'주문 분석과 출고 업무를 실행합니다.', url:'/orders.html' },
    { id:'dataops', permission:'dataops.read', eyebrow:'DATA OPS', name:'재고·정산', description:'재고 검증, 갱신, 상황자료와 일마감을 처리합니다.', url:'/DataOps.html' },
    { id:'smart-parser', permission:'merchops.read', eyebrow:'SMART PARSER', name:'문서 파서', description:'비정형 문서를 업무 데이터로 정리합니다.', url:'/SmartParser.html' }
  ];
  const serviceLabels = { upstream:'업무 서버', dataOpsRead:'DataOps 읽기', dataOpsWrite:'DataOps 쓰기', dataOpsPublish:'V2 발행', orderQ:'ORDER Q', shipping:'발주계획' };
  const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const companyCard = document.getElementById('companyCard');
  const formatBusinessNumber = value => {
    const digits = String(value || '').replace(/\D/g,'');
    return /^\d{10}$/.test(digits) ? `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}` : '미등록';
  };
  function renderCompany(state, session, data) {
    companyCard.dataset.state = state;
    if (state === 'READY') {
      const profile = data.profile;
      companyCard.innerHTML = `<div><small>COMPANY · READY</small><h2>${escapeHtml(profile.companyName || '회사명 미등록')}</h2><p>사업자등록번호 ${escapeHtml(formatBusinessNumber(profile.businessNumber))} · 대표자 ${escapeHtml(profile.representativeName || '미등록')}</p></div><a href="/nexus/company.html?mode=view">회사정보 보기 →</a>`;
      return;
    }
    if (state === 'EMPTY') {
      const admin = session.user.role === 'OWNER_MASTER';
      companyCard.innerHTML = `<div><small>COMPANY · EMPTY</small><h2>등록된 회사정보가 없습니다.</h2><p>${admin ? '회사 기본정보를 등록해 NEXUS 홈에 표시하세요.' : '관리자에게 회사정보 등록을 요청하세요.'}</p></div>${admin ? '<a href="/nexus/company.html?mode=edit">회사정보 등록 →</a>' : '<a href="/nexus/company.html?mode=view">조회 화면 열기 →</a>'}`;
      return;
    }
    companyCard.innerHTML = `<div><small>COMPANY · ERROR</small><h2>회사정보를 불러오지 못했습니다.</h2><p>${escapeHtml(data?.message || '잠시 후 다시 시도하세요.')}</p></div><button type="button" data-company-retry>다시 시도</button>`;
  }
  async function loadCompany(session) {
    companyCard.dataset.state = 'LOADING';
    try {
      const data = await window.ONEAPP_AUTH.gateway('company.profile_read', {});
      renderCompany(data?.status === 'READY' && data.profile ? 'READY' : 'EMPTY', session, data);
    } catch (error) { renderCompany('ERROR', session, error); }
  }
  window.ONEAPP_AUTH.ready.then(async session => {
    if (!session) return;
    const user = session.user;
    document.getElementById('welcomeTitle').textContent = `${user.displayName}님, 바로 시작하세요.`;
    document.getElementById('welcomeDescription').textContent = user.role === 'OWNER_MASTER' ? '마스터 권한으로 관리화면과 모든 업무 기능을 사용할 수 있습니다.' : '마스터가 부여한 권한에 맞춰 업무 기능이 열립니다.';
    document.getElementById('adminLink').hidden = user.role !== 'OWNER_MASTER';
    document.getElementById('connectionStrip').innerHTML = Object.entries(serviceLabels).map(([key,label]) => `<span><b>${label}</b> <i class="${session.serviceConnections?.[key] ? 'ready' : 'missing'}">${session.serviceConnections?.[key] ? '연결됨' : '미연결'}</i></span>`).join('');
    const allowed = apps.filter(app => window.ONEAPP_AUTH.hasPermission(app.permission));
    document.getElementById('appGrid').innerHTML = allowed.length ? allowed.map(app => `<a class="portal-card" href="${app.url}"><small>${app.eyebrow}</small><h2>${app.name}</h2><p>${app.description}</p><span>업무 화면 열기 →</span></a>`).join('') : '<div class="empty-state">현재 사용할 수 있는 업무 권한이 없습니다. 마스터에게 권한을 요청하세요.</div>';
    await loadCompany(session);
  });
  companyCard.addEventListener('click', event => { if (event.target.closest('[data-company-retry]') && window.ONEAPP_AUTH.session) loadCompany(window.ONEAPP_AUTH.session); });
  document.getElementById('logoutButton').addEventListener('click', () => window.ONEAPP_AUTH.logout());
})();
