const FLOW = Object.freeze([
  { key:'capture', label:'주문 받기', href:'./parser.html' },
  { key:'review', label:'주문 확인', href:'./index.html' },
  { key:'prepare', label:'출고 준비', href:'./operations.html' },
  { key:'actual', label:'실제 수량', href:'./dispatch.html' },
  { key:'confirm', label:'출고 확정', href:'./dispatch.html' },
  { key:'erp', label:'ERP 자료', href:'./erp.html' }
]);

const PAGE = Object.freeze({
  'parser.html': { active:['capture'], title:'주문 내용을 확인하세요', help:'카카오 대화나 일반 주문 문장을 붙여넣고 주문으로 정리합니다.', next:'review', nextText:'분석한 주문 확인' },
  'input.html': { active:['capture'], title:'주문을 저장하세요', help:'관리자가 직접 받은 주문을 입력하고 저장합니다.', next:'review', nextText:'저장한 주문 확인' },
  'index.html': { active:['review'], title:'처리할 주문을 확인하세요', help:'주문 내용과 수량을 확인한 뒤 출고 준비로 넘깁니다.', next:'prepare', nextText:'출고 준비로 이동' },
  'operations.html': { active:['prepare'], title:'미출고 주문을 찾으세요', help:'주문별 남은 수량과 재고를 확인하고 출고할 대상을 선택합니다.', next:'actual', nextText:'출고 작업대로 이동' },
  'dispatch.html': { active:['prepare','actual','confirm'], title:'출고를 준비하고 확정하세요', help:'출고상품·창고를 정하고 실제 수량을 저장한 뒤 관리자가 확정합니다.', next:'erp', nextText:'ERP 자료 확인' },
  'purchase.html': { active:[], title:'부족상품 구매를 기록하세요', help:'출고와 별도로 구매 내용을 확인하고 입고를 확정합니다.', next:'erp', nextText:'ERP 자료 확인' },
  'erp.html': { active:['erp'], title:'ERP 입력자료를 만드세요', help:'확정된 판매·구매 사실만 파일로 만들고 ERP 반영 결과를 대사합니다.', next:'review', nextText:'주문현황으로 돌아가기' },
  'reconciliation.html': { active:[], title:'출고 차이를 확인하세요', help:'확정 원본은 보존하고 기존 확정 취소와 수정 출고안으로 차이를 바로잡습니다.', next:'actual', nextText:'출고 작업대로 이동' }
});

function pageName() {
  const value = location.pathname.split('/').filter(Boolean).at(-1) || 'index.html';
  return value === 'orderq' ? 'index.html' : value;
}

function technicalLabel(href, text) {
  if (href.includes('cloud')) return '중앙 연결 설정';
  if (href.includes('collector')) return '기초자료 가져오기';
  if (href.includes('transition')) return '전환·복구 설정';
  return text;
}

function makeFlow(config) {
  const section = document.createElement('section');
  section.className = 'business-flow';
  section.setAttribute('aria-label', '업무 진행 순서');
  section.innerHTML = `
    <div class="business-flow-copy">
      <span>지금 할 일</span>
      <strong>${config.title}</strong>
      <small>${config.help}</small>
    </div>
    <ol class="business-flow-steps">
      ${FLOW.map((step, index) => `<li class="${config.active.includes(step.key) ? 'active' : ''}"><a href="${step.href}"><b>${index + 1}</b><span>${step.label}</span></a></li>`).join('')}
    </ol>
    <div class="business-flow-actions">
      <a class="business-next" href="${FLOW.find(step => step.key === config.next)?.href || './index.html'}">${config.nextText}<span aria-hidden="true">→</span></a>
      <details class="admin-tools">
        <summary>관리자 설정</summary>
        <div class="admin-tools-menu"></div>
      </details>
    </div>`;
  return section;
}

function moveTechnicalActions(section) {
  const menu = section.querySelector('.admin-tools-menu');
  const technical = [...document.querySelectorAll('.top-actions a')].filter(link => /(?:cloud|collector|transition)\.html/.test(link.getAttribute('href') || ''));
  technical.forEach(link => {
    link.textContent = technicalLabel(link.getAttribute('href') || '', link.textContent);
    link.className = 'admin-tool-link';
    menu.append(link);
  });
  const syncButton = document.getElementById('syncBtn');
  if (syncButton) {
    syncButton.className = 'admin-tool-link';
    syncButton.textContent = '지금 동기화';
    menu.append(syncButton);
  }
  if (!menu.children.length) {
    menu.innerHTML = '<a class="admin-tool-link" href="./cloud.html">중앙 연결 설정</a><a class="admin-tool-link" href="./transition.html">전환·복구 설정</a>';
  }
}

const config = PAGE[pageName()];
const header = document.querySelector('.shell > .topbar');
if (config && header) {
  const section = makeFlow(config);
  header.insertAdjacentElement('afterend', section);
  moveTechnicalActions(section);
}
