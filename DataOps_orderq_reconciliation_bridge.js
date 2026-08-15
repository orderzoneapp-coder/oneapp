(function mountOrderQReconciliationBridge() {
  'use strict';

  const button = document.createElement('button');
  button.id = 'orderq-reconciliation-open';
  button.type = 'button';
  button.textContent = 'ORDER Q 출고대사';
  button.title = '확정 출고의 차이를 확인하고 정정 DRAFT를 만듭니다.';
  button.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:180',
    'border:1px solid #0f766e', 'border-radius:10px', 'padding:10px 14px',
    'background:#0f766e', 'color:#fff', 'font:800 12px/1.2 sans-serif',
    'box-shadow:0 8px 24px rgba(15,23,42,.25)', 'cursor:pointer'
  ].join(';');

  const panel = document.createElement('section');
  panel.id = 'orderq-reconciliation-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'ORDER Q 출고 대사');
  panel.style.cssText = [
    'position:fixed', 'inset:24px', 'z-index:190', 'border:1px solid #334155',
    'border-radius:14px', 'background:#fff', 'box-shadow:0 20px 60px rgba(15,23,42,.35)',
    'overflow:hidden'
  ].join(';');
  panel.innerHTML = [
    '<button id="orderq-reconciliation-close" type="button" aria-label="출고 대사 닫기"',
    ' style="position:absolute;right:12px;top:10px;z-index:2;border:0;border-radius:8px;',
    'padding:7px 11px;background:#0f172a;color:#fff;font-weight:800;cursor:pointer">닫기</button>',
    '<iframe id="orderq-reconciliation-frame" title="ORDER Q 출고 대사"',
    ' style="width:100%;height:100%;border:0" src="./orderq/reconciliation.html"></iframe>'
  ].join('');

  document.body.append(button, panel);
  const close = panel.querySelector('#orderq-reconciliation-close');
  button.addEventListener('click', () => {
    panel.hidden = false;
    close.focus();
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    button.focus();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) close.click();
  });
})();
