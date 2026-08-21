(() => {
  const apps = [
    { name: '출고관리', service: 'ORDER Q', url: 'https://oneapp.orderz.co.kr/orderops_list.html' },
    { name: '재고관리', service: 'DataOps', url: 'https://oneapp.orderz.co.kr/DataOps' },
    { name: '시세관리', service: 'MerchOps', url: 'https://oneapp.orderz.co.kr/MerchOps' },
    { name: '스마트파서', service: 'SmartParser', url: 'https://oneapp.orderz.co.kr/SmartParser.html' },
    { name: '기초등록', service: 'Master', url: 'https://oneapp.orderz.co.kr/Master.html' }
  ];

  const navTrack = document.querySelector('.app-nav-track');
  const appGrid = document.querySelector('.app-grid');
  const backdrop = document.querySelector('.backdrop');
  let activeIndex = 0;
  let openPanelName = null;
  let panelTrigger = null;

  apps.forEach((app, index) => {
    const tab = document.createElement('a');
    tab.className = 'app-tab';
    tab.role = 'tab';
    tab.href = app.url;
    tab.textContent = app.name;
    tab.dataset.index = index;
    tab.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
    tab.tabIndex = index === activeIndex ? 0 : -1;
    navTrack.append(tab);

    const card = document.createElement('a');
    card.className = `app-card${index === activeIndex ? ' is-active' : ''}`;
    card.href = app.url;
    card.dataset.index = index;
    card.innerHTML = `<strong>${app.name}</strong><small>${app.service}</small>`;
    appGrid.append(card);
  });

  function selectApp(index, focus = false) {
    activeIndex = (index + apps.length) % apps.length;
    const tabs = [...document.querySelectorAll('.app-tab')];
    const cards = [...document.querySelectorAll('.app-card')];
    tabs.forEach((tab, i) => {
      const selected = i === activeIndex;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    cards.forEach((card, i) => card.classList.toggle('is-active', i === activeIndex));
    tabs[activeIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    if (focus) tabs[activeIndex].focus();
  }

  function closePanel({ restoreFocus = true } = {}) {
    if (!openPanelName) return;
    document.querySelector(`[data-panel-content="${openPanelName}"]`).hidden = true;
    document.querySelector(`[data-panel="${openPanelName}"]`).setAttribute('aria-expanded', 'false');
    backdrop.hidden = true;
    openPanelName = null;
    if (restoreFocus && panelTrigger) panelTrigger.focus();
    panelTrigger = null;
  }

  function openPanel(name, trigger) {
    if (openPanelName === name) return closePanel();
    closePanel({ restoreFocus: false });
    openPanelName = name;
    panelTrigger = trigger;
    const panel = document.querySelector(`[data-panel-content="${name}"]`);
    panel.hidden = false;
    backdrop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => panel.querySelector('button, input')?.focus());
  }

  navTrack.addEventListener('click', (event) => {
    const tab = event.target.closest('.app-tab');
    if (tab) selectApp(Number(tab.dataset.index));
  });

  navTrack.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
      window.location.assign(event.target.href);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return selectApp(0, true);
    if (event.key === 'End') return selectApp(apps.length - 1, true);
    selectApp(activeIndex + (event.key === 'ArrowRight' ? 1 : -1), true);
  });

  appGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.app-card');
    if (!card) return;
    selectApp(Number(card.dataset.index));
    closePanel();
  });

  document.querySelectorAll('[data-panel]').forEach((button) => {
    button.addEventListener('click', () => openPanel(button.dataset.panel, button));
  });
  document.querySelectorAll('[data-close-panel]').forEach((button) => button.addEventListener('click', () => closePanel()));
  backdrop.addEventListener('click', () => closePanel());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });

  document.querySelector('input[aria-label="간결한 헤더"]').addEventListener('change', (event) => {
    document.body.classList.toggle('compact', event.target.checked);
  });
  document.querySelector('input[aria-label="모션 줄이기"]').addEventListener('change', (event) => {
    document.documentElement.style.scrollBehavior = event.target.checked ? 'auto' : '';
  });

  requestAnimationFrame(() => selectApp(activeIndex));
})();
