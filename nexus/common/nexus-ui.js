(() => {
  'use strict';

  const VERSION = '1.4.0';
  const VISIBILITY_STORAGE_KEY = 'oneapp.nexus.ui.visibility.v1';
  const VISIBILITY_SCHEMA = 'NEXUS_UI_VISIBILITY_V1';
  const root = document.documentElement;
  const controller = window.ONEAPP_NEXUS_UI_THEME;
  const scriptUrl = new URL(document.currentScript?.src || '/nexus/common/nexus-ui.js', location.href);
  const siteRoot = new URL('../../', scriptUrl);
  const asset = (path) => new URL(path, siteRoot).href;
  const APPS = Object.freeze([
    Object.freeze({ id: 'master-lookup', label: '상품관리', path: 'Master.html' }),
    Object.freeze({ id: 'customer-master', label: '거래처관리', path: 'customer-master/index.html' }),
    Object.freeze({ id: 'merchops', label: '가격·시세', path: 'MerchOps.html' }),
    Object.freeze({ id: 'smart-input', label: '스마트입력', path: 'smartinput/index.html' }),
    Object.freeze({ id: 'orderops', label: '주문·출고', path: 'orderops/list.html' }),
    Object.freeze({ id: 'dataops', label: '재고·정산', path: 'DataOps.html' }),
    Object.freeze({ id: 'smart-parser', label: '문서분석', path: 'SmartParser.html' }),
    Object.freeze({ id: 'export-center', label: '출력검증', path: 'export_center.html' }),
    Object.freeze({ id: 'settings', label: '환경설정', path: 'settings.html' }),
    Object.freeze({ id: 'item-manager', label: '상품등록', path: 'Item_manager.html' }),
    Object.freeze({ id: 'history-viewer', label: '변경이력', path: 'history_viewer.html' }),
    Object.freeze({ id: 'orderq-vnext', label: '주문현황', path: 'orderq/index.html' }),
  ]);

  const visibleApps = () => {
    try {
      const projection = JSON.parse(window.sessionStorage.getItem(VISIBILITY_STORAGE_KEY) || 'null');
      if (!projection || projection.schemaVersion !== VISIBILITY_SCHEMA || projection.configured !== true) return APPS;
      if (!Array.isArray(projection.visibleAppIds)) return APPS;
      const ids = projection.visibleAppIds;
      const valid = ids.every((id, index) => typeof id === 'string'
        && APPS.some((app) => app.id === id)
        && ids.indexOf(id) === index);
      return valid ? APPS.filter((app) => ids.includes(app.id)) : APPS;
    } catch {
      return APPS;
    }
  };

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const updateThemeControl = (header, theme) => {
    const toggle = header.querySelector('[data-nexus-ui-theme-toggle]');
    if (!toggle) return;
    const dark = theme === 'dark';
    toggle.setAttribute('aria-checked', String(dark));
    toggle.setAttribute('aria-label', dark ? '일반모드로 전환' : '다크모드로 전환');
    toggle.title = dark ? '일반모드로 전환' : '다크모드로 전환';
  };

  const revealCurrentApp = (header) => {
    const nav = header.querySelector('.nexus-ui-nav');
    const currentLink = nav?.querySelector('[aria-current="page"]');
    if (!nav || !currentLink) return;
    const reveal = () => {
      const navRect = nav.getBoundingClientRect();
      const currentRect = currentLink.getBoundingClientRect();
      const currentCenter = nav.scrollLeft + (currentRect.left - navRect.left) + (currentRect.width / 2);
      const centered = currentCenter - (nav.clientWidth / 2);
      nav.scrollLeft = Math.max(0, Math.min(centered, nav.scrollWidth - nav.clientWidth));
    };
    requestAnimationFrame(reveal);
    window.addEventListener('resize', reveal, { passive: true });
  };

  const buildHeader = () => {
    const currentAppId = String(root.dataset.nexusUiApp || '').trim();
    const currentApp = APPS.find((app) => app.id === currentAppId);
    const header = element('header', 'nexus-ui-header');
    header.id = 'nexusUiHeader';
    header.dataset.nexusUiVersion = VERSION;
    header.setAttribute('aria-label', 'NEXUS 공통헤더');

    const brand = element('div', 'nexus-ui-brand');
    const logoFrame = element('a', 'nexus-ui-brand__logo');
    logoFrame.href = asset('nexus/');
    logoFrame.setAttribute('aria-label', 'NEXUS 홈');
    logoFrame.title = 'NEXUS 홈';
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
    const navTrack = element('div', 'nexus-ui-nav__track');
    visibleApps().forEach((app) => {
      const link = element('a', 'nexus-ui-nav__link', app.label);
      link.href = asset(app.path);
      link.dataset.nexusUiAppTarget = app.id;
      if (app.id === currentAppId) {
        link.classList.add('is-current');
        link.setAttribute('aria-current', 'page');
      }
      navTrack.appendChild(link);
    });
    nav.appendChild(navTrack);

    const themeGroup = element('div', 'nexus-ui-theme');
    themeGroup.setAttribute('role', 'group');
    themeGroup.setAttribute('aria-label', '화면 모드');
    const lightIcon = element('span', 'nexus-ui-theme__icon', '☼');
    lightIcon.setAttribute('aria-hidden', 'true');
    const toggle = element('button', 'nexus-ui-theme__switch');
    toggle.type = 'button';
    toggle.dataset.nexusUiThemeToggle = '';
    toggle.setAttribute('role', 'switch');
    const darkIcon = element('span', 'nexus-ui-theme__icon', '☾');
    darkIcon.setAttribute('aria-hidden', 'true');
    toggle.addEventListener('click', () => {
      const nextTheme = root.dataset.nexusUiTheme === 'dark' ? 'light' : 'dark';
      const applied = controller?.apply
        ? controller.apply(nextTheme, { persist: true, emit: true, source: 'header' })
        : nextTheme;
      if (!controller?.apply) {
        root.dataset.nexusUiTheme = applied;
        root.dataset.nexusTheme = applied;
        root.style.colorScheme = applied;
      }
      updateThemeControl(header, applied);
    });
    themeGroup.append(lightIcon, toggle, darkIcon);

    header.append(brand, nav, themeGroup);
    updateThemeControl(header, root.dataset.nexusUiTheme === 'dark' ? 'dark' : 'light');
    return header;
  };

  const mount = () => {
    if (!document.body || document.getElementById('nexusUiHeader')) return;
    const bodyStyle = getComputedStyle(document.body);
    document.body.style.setProperty('--nexus-ui-original-padding-top', bodyStyle.paddingTop || '0px');
    document.body.classList.add('nexus-ui-mounted');
    const header = buildHeader();
    document.body.prepend(header);
    revealCurrentApp(header);
    window.addEventListener('nexus-ui:theme-change', (event) => {
      updateThemeControl(header, event.detail?.theme === 'dark' ? 'dark' : 'light');
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
