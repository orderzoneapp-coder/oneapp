(() => {
  const apps = [
    { id:'master', permission:'foundation.read', eyebrow:'FOUNDATION', name:'기준정보', description:'상품·거래처 기준정보를 조회하고 관리합니다.', url:'/Master.html' },
    { id:'item-manager', permission:'foundation.write', eyebrow:'ITEM MASTER', name:'상품 등록', description:'상품을 등록하고 수정합니다.', url:'/Item_manager.html' },
    { id:'merchops', permission:'merchops.read', eyebrow:'MERCH OPS', name:'가격·시세', description:'가격 정책과 프로모션 자료를 검토합니다.', url:'/MerchOps.html' },
    { id:'orderq', permission:'orderq.read', eyebrow:'ORDER Q vNext', name:'주문현황', description:'주문 분석과 출고 이력을 확인합니다.', url:'/orderq/index.html' },
    { id:'orderops', permission:'shipping.read', eyebrow:'ORDER OPS', name:'출고관리', description:'출고 운영과 발주계획을 관리합니다.', url:'/orderops/list.html' },
    { id:'dataops', permission:'dataops.read', eyebrow:'DATA OPS', name:'재고·정산', description:'재고 검증, 갱신, 상황자료와 일마감을 처리합니다.', url:'/DataOps.html' },
    { id:'smart-parser', permission:'merchops.read', eyebrow:'SMART PARSER', name:'문서 파서', description:'비정형 문서를 업무 데이터로 정리합니다.', url:'/SmartParser.html' }
  ];
  const serviceLabels = { upstream:'업무 서버', dataOpsRead:'DataOps 읽기', dataOpsWrite:'DataOps 쓰기', dataOpsPublish:'V2 발행', orderQ:'ORDER Q', shipping:'발주계획' };
  const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const companyCard = document.getElementById('companyCard');
  function renderCompany(snapshot) {
    if (!snapshot) return;
    companyCard.dataset.state = 'READY';
    const address = snapshot.businessAddress ? `<span>${escapeHtml(snapshot.businessAddress)}</span>` : '';
    companyCard.innerHTML = `<div><small>COMPANY · PUBLIC</small><h2>${escapeHtml(snapshot.companyName)}</h2><p>사업자등록번호 ${escapeHtml(snapshot.businessNumber)} · 대표자 ${escapeHtml(snapshot.representativeName)}</p>${address}</div><span class="company-home-state">PUBLIC</span>`;
  }
  const connectCompanySnapshot = () => {
    if (window.ONEAPP_COMPANY_PUBLIC?.snapshot) renderCompany(window.ONEAPP_COMPANY_PUBLIC.snapshot);
  };
  connectCompanySnapshot();
  window.addEventListener('nexus-company-public-ready', event => renderCompany(event.detail?.snapshot));
  window.addEventListener('nexus-company-public-change', event => renderCompany(event.detail?.snapshot));
  window.ONEAPP_AUTH.ready.then(async session => {
    if (!session) return;
    const user = session.user;
    document.getElementById('welcomeTitle').textContent = `${user.displayName}님, 바로 시작하세요.`;
    document.getElementById('welcomeDescription').textContent = user.role === 'OWNER_MASTER' ? '마스터 권한으로 관리화면과 모든 업무 기능을 사용할 수 있습니다.' : '마스터가 부여한 권한에 맞춰 업무 기능이 열립니다.';
    document.getElementById('adminLink').hidden = user.role !== 'OWNER_MASTER';
    document.getElementById('connectionStrip').innerHTML = Object.entries(serviceLabels).map(([key,label]) => `<span><b>${label}</b> <i class="${session.serviceConnections?.[key] ? 'ready' : 'missing'}">${session.serviceConnections?.[key] ? '연결됨' : '미연결'}</i></span>`).join('');
    const allowed = apps.filter(app => window.ONEAPP_AUTH.hasPermission(app.permission));
    document.getElementById('appGrid').innerHTML = allowed.length ? allowed.map(app => `<a class="portal-card" href="${app.url}"><small>${app.eyebrow}</small><h2>${app.name}</h2><p>${app.description}</p><span>업무 화면 열기 →</span></a>`).join('') : '<div class="empty-state">현재 사용할 수 있는 업무 권한이 없습니다. 마스터에게 권한을 요청하세요.</div>';
    connectCompanySnapshot();
  });
  document.getElementById('logoutButton').addEventListener('click', () => window.ONEAPP_AUTH.logout());
})();
