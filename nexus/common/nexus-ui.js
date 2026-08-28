(() => {
  'use strict';

  const VERSION = '1.0.0';
  const root = document.documentElement;
  const controller = window.ONEAPP_NEXUS_UI_THEME;
  const scriptUrl = new URL(document.currentScript?.src || '/nexus/common/nexus-ui.js', location.href);
  const siteRoot = new URL('../../', scriptUrl);
  const asset = (path) => new URL(path, siteRoot).href;
  const APPS = Object.freeze([
    Object.freeze({ id: 'merchops', label: 'MerchOps', path: 'MerchOps.html' }),
    Object.freeze({ id: 'dataops', label: 'DataOps', path: 'DataOps.html' }),
    Object.freeze({ id: 'smart-parser', label: 'Smart Parser', path: 'SmartParser.html' }),
    Object.freeze({ id: 'export-center', label: 'Export', path: 'export_center.html' }),
    Object.freeze({ id: 'settings', label: '설정', path: 'settings.html' }),
    Object.freeze({ id: 'master-lookup', label: 'Master', path: 'Master.html' }),
    Object.freeze({ id: 'item-manager', label: '상품관리', path: 'Item_manager.html' }),
    Object.freeze({ id: 'history-viewer', label: '이력', path: 'history_viewer.html' }),
    Object.freeze({ id: 'orderops', label: 'ORDER Q', path: 'orderops/list.html' }),
    Object.freeze({ id: 'orderq-vnext', label: 'ORDER Q vNext', path: 'orderq/index.html' }),
  ]);

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const updateThemeButtons = (header, theme) => {
    header.querySelectorAll('[data-nexus-ui-theme-value]').forEach((button) => {
      const active = button.dataset.nexusUiThemeValue === theme;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    });
  };

  const buildHeader = () => {
    const currentAppId = String(root.dataset.nexusUiApp || '').trim();
    const currentApp = APPS.find((app) => app.id === currentAppId);
    const header = element('header', 'nexus-ui-header');
    header.id = 'nexusUiHeader';
    header.dataset.nexusUiVersion = VERSION;
    header.setAttribute('aria-label', 'NEXUS 공통헤더');

    const brand = element('div', 'nexus-ui-brand');
    const logoFrame = element('span', 'nexus-ui-brand__logo');
    const lightLogo = element('img', 'nexus-ui-logo nexus-ui-logo--light');
    lightLogo.src = asset('nexus/assets/brand/oneapp-nexus-light.svg');
    lightLogo.alt = 'ONEAPP NEXUS';
    const darkLogo = element('img', 'nexus-ui-logo nexus-ui-logo--dark');
    darkLogo.src = asset('nexus/assets/brand/oneapp-nexus-dark.svg');
    darkLogo.alt = '';
    darkLogo.setAttribute('aria-hidden', 'true');
    logoFrame.append(lightLogo, darkLogo);
    const current = element('span', 'nexus-ui-brand__current', currentApp?.label || 'ONEAPP');
    current.title = currentApp?.label || '현재 앱';
    brand.append(logoFrame, current);

    const nav = element('nav', 'nexus-ui-nav');
    nav.setAttribute('aria-label', '앱 이동');
    APPS.forEach((app) => {
      const link = element('a', 'nexus-ui-nav__link', app.label);
      link.href = asset(app.path);
      link.dataset.nexusUiAppTarget = app.id;
      if (app.id === currentAppId) {
        link.classList.add('is-current');
        link.setAttribute('aria-current', 'page');
      }
      nav.appendChild(link);
    });

    const themeGroup = element('div', 'nexus-ui-theme');
    themeGroup.setAttribute('role', 'group');
    themeGroup.setAttribute('aria-label', '화면 모드');
    [['light', '일반모드'], ['dark', '다크모드']].forEach(([theme, label]) => {
      const button = element('button', 'nexus-ui-theme__button', label);
      button.type = 'button';
      button.dataset.nexusUiThemeValue = theme;
      button.addEventListener('click', () => {
        const applied = controller?.apply
          ? controller.apply(theme, { persist: true, emit: true, source: 'header' })
          : theme;
        if (!controller?.apply) {
          root.dataset.nexusUiTheme = applied;
          root.dataset.nexusTheme = applied;
          root.style.colorScheme = applied;
        }
        updateThemeButtons(header, applied);
      });
      themeGroup.appendChild(button);
    });

    header.append(brand, nav, themeGroup);
    updateThemeButtons(header, root.dataset.nexusUiTheme === 'dark' ? 'dark' : 'light');
    return header;
  };

  const mount = () => {
    if (!document.body || document.getElementById('nexusUiHeader')) return;
    const bodyStyle = getComputedStyle(document.body);
    document.body.style.setProperty('--nexus-ui-original-padding-top', bodyStyle.paddingTop || '0px');
    document.body.classList.add('nexus-ui-mounted');
    const header = buildHeader();
    document.body.prepend(header);
    window.addEventListener('nexus-ui:theme-change', (event) => {
      updateThemeButtons(header, event.detail?.theme === 'dark' ? 'dark' : 'light');
    });
    const startedAt = Number(root.dataset.nexusUiInitStartedAt || 0);
    const readyMs = startedAt > 0 && typeof performance !== 'undefined'
      ? Math.max(0, performance.now() - startedAt)
      : 0;
    root.dataset.nexusUiReady = 'true';
    root.dataset.nexusUiReadyMs = readyMs.toFixed(2);
    window.dispatchEvent(new CustomEvent('nexus-ui:ready', {
      detail: Object.freeze({ appId: root.dataset.nexusUiApp || '', readyMs }),
    }));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
